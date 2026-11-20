import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import type { BuildPrinter } from '#lib/domain/types.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { buildPlates, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun } from './actions';
import { createBuild } from './create';
import { updateBuildDesign } from '../designs/mutate';
import {
	loadFootprints,
	loadKitSource,
	PLANNER_VERSION,
	planArrangement,
	writePlan
} from './arrange-plan';
import { arrangeForPrinter, buildArrangement } from './plates';
import { loadBuildView } from './view';

// Planner 3: a plate printed in runs of its own (the wheel rims) stays one plate, and a part that moved
// may join an existing multi-part plate. Arrangements stored by planner 2 keep being checked by planner 2.

let db: Db;
let templateId: string;
const orgId = 'org1';
afterEach(async () => dropTestDb(db));

const cc = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);
/** 300 x 256: the kit's 256 layout is the source, and one rim half (280 x 154) fits but two do not. */
const wide: BuildPrinter = {
	...cc,
	catalogId: null,
	name: 'Custom',
	bedX: 300,
	bedY: 256,
	keepOut: []
};

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db.insert(member).values({
		id: 'm1',
		organizationId: orgId,
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
});

const mk = async (printer = wide) =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', printer },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const rows = async (id: string) =>
	await db
		.select()
		.from(buildPlates)
		.where(eq(buildPlates.buildId, id))
		.orderBy(buildPlates.number);

describe('the wheel rims are one plate', () => {
	it('stays the kit plate: both parts, runs, one print on the bed, flagged per part', async () => {
		const id = await mk();
		const v = await view(id);
		// both rim halves are on the kit's plate 13, and nowhere else (the harness and tires of the seed's
		// box footprints may spill over a 300 x 256 bed: they are not the rims)
		expect(v.plates.filter((p) => p.parts.some((s) => s.startsWith('rims-')))).toHaveLength(1);
		const rim = v.plates.find((p) => p.parts.includes('rims-1-4'))!;
		expect(rim.parts).toEqual(['rims-1-4', 'rims-2-3']);
		expect(rim.runs).toBe(2);
		expect(rim.perPartRuns).toBe(true);
		const row = (await rows(id)).find((r) => r.number === rim.number)!;
		expect(row.perPartRuns).toBe(true);
		expect(row.arrangement).toMatchObject({ v: PLANNER_VERSION, perPartRuns: true, runs: 2 });
		// one print = one rim half on the bed (the same object in both colors)
		expect(row.arrangement!.items).toHaveLength(1);
		expect(row.arrangement!.items[0].slug).toBe('rims-1-4');
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
	});

	it('planner 2 (stored arrangements) split it onto an extra plate', async () => {
		const id = await mk();
		const v = await view(id);
		const fp = await loadFootprints(db, templateId);
		const plan = planArrangement(v, fp, null, undefined, (await loadKitSource(db, v))!, 2)!;
		expect(plan.result.plates.length).toBe(v.plates.length + 1);
	});
});

describe('arrangements stored by planner 2 are not flagged stale, and not rewritten', () => {
	it('a v2 arrangement is checked against planner 2; a color change still makes it stale', async () => {
		const id = await mk();
		const v = await view(id);
		const fp = await loadFootprints(db, templateId);
		const v2 = planArrangement(v, fp, null, undefined, (await loadKitSource(db, v))!, 2)!;
		await writePlan(db, id, v2, 2);
		const before = JSON.stringify((await rows(id)).map((r) => [r.number, r.parts, r.arrangement]));
		expect((await rows(id))[0].arrangement).toMatchObject({ v: 2 });
		// the current planner would plan one plate less, yet nothing is stale: the plates were made by planner 2
		const info = await buildArrangement(db, id, 'owner');
		expect(info.fresh!.plates).toBe(v2.result.plates.length - 1);
		expect(info.stale).toBe(false);
		// reading never rewrites
		expect(JSON.stringify((await rows(id)).map((r) => [r.number, r.parts, r.arrangement]))).toBe(
			before
		);
		// a started build keeps its plates when a part is recolored: planner 2 sees the change, so it is stale
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			partSlug: 'handle-left',
			grams: 5
		});
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'seat-back-top': 'accent' } });
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(true);
		expect(JSON.stringify((await rows(id)).map((r) => [r.number, r.parts, r.arrangement]))).toBe(
			before
		);
	});

	it('an explicit re-arrange writes planner 3', async () => {
		const id = await mk();
		const v = await view(id);
		const fp = await loadFootprints(db, templateId);
		await writePlan(
			db,
			id,
			planArrangement(v, fp, null, undefined, (await loadKitSource(db, v))!, 2)!,
			2
		);
		await arrangeForPrinter(db, id, 'owner');
		const now = await rows(id);
		expect(now.every((r) => (r.arrangement as { v?: number }).v === PLANNER_VERSION)).toBe(true);
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
	});
});

describe('a part that moved joins an existing multi-part plate', () => {
	it('an automatic re-arrange after a recolor: the part sits on a kit plate, no plate added', async () => {
		const id = await mk(cc);
		const kitCount = (await view(id)).plates.length;
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'push-pin': 'primary' } });
		const v = await view(id);
		expect(v.plates.length).toBe(kitCount);
		const plate = v.plates.find((p) => p.parts.includes('push-pin'))!;
		expect(plate.parts.length).toBeGreaterThanOrEqual(2);
		const pin = v.parts.find((p) => p.slug === 'push-pin')!;
		for (const s of plate.parts) expect(v.parts.find((p) => p.slug === s)!.role).toBe(pin.role);
		// the plate it left lost only the pin
		const left = v.plates.find((p) => p.parts.includes('push-bottom'))!;
		expect(left.parts).not.toContain('push-pin');
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
		// the stored plate holds the pin's item and the plate's own items did not move
		const stored = (await rows(id)).find((r) => r.number === plate.number)!;
		expect(stored.arrangement!.items.some((i) => i.slug === 'push-pin')).toBe(true);
		expect(stored.arrangement!.utilisation).toBeLessThanOrEqual(0.61);
	});

	it('single-part plates never get it: the plates that are alone in the kit are still alone', async () => {
		const id = await mk(cc);
		const kit = (await loadKitSource(db, await view(id)))!.plates!;
		const lone = kit.filter((p) => p.parts.length === 1).map((p) => p.parts[0]);
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'push-pin': 'primary' } });
		const v = await view(id);
		for (const s of lone.filter((x) => v.parts.some((p) => p.slug === x)))
			expect(v.plates.find((p) => p.parts.includes(s))!.parts).toEqual([s]);
	});
});
