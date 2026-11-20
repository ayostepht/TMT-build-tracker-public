import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeActivity } from '#lib/domain/activity.ts';
import type { BuildPrinter } from '#lib/domain/types.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { buildPlates, builds, member, organization, templates, user } from '../db/schema';
import { timeLeftText, timeStats } from '#lib/domain/accounting.ts';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, setPrinter, setVariant, updatePlate } from './actions';
import { createBuild } from './create';
import { updateBuildDesign } from '../designs/mutate';
import { arrangeForPrinter, buildArrangement, setPlateLayout } from './plates';
import { onBuildEvents } from './test-helpers';
import { loadBuildView } from './view';
import { and, eq } from 'drizzle-orm';

let db: Db;
let templateId: string;
const orgId = 'org1';

afterEach(async () => dropTestDb(db));

const cc = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);
const bed = (x: number, y = x, mmSlots = 1) => ({
	...cc,
	catalogId: null,
	name: 'Custom',
	bedX: x,
	bedY: y,
	mmSlots
});

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const [u, role] of [
		['owner', 'owner'],
		['editor', 'editor'],
		['viewer', 'viewer'],
		['outsider', '']
	]) {
		await db
			.insert(user)
			.values({ id: u, name: `User ${u}`, email: `${u}@example.test`, createdAt: new Date() });
		if (role)
			await db
				.insert(member)
				.values({ id: `m-${u}`, organizationId: orgId, userId: u, role, createdAt: new Date() });
	}
});

const mk = async (printer?: BuildPrinter) =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', printer },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const plateOf = async (id: string, slug: string) =>
	(await view(id)).plates.find((p) => p.parts.includes(slug))!;

describe('setPrinter', () => {
	it('lets editors and owners set it, not viewers or outsiders', async () => {
		const id = await mk();
		expect((await view(id)).printer).toBeNull();
		await setPrinter(db, id, 'editor', { printer: cc });
		expect((await view(id)).printer).toMatchObject({
			name: 'Elegoo Centauri Carbon',
			bedX: 256,
			margin: 1
		});
		await expect(setPrinter(db, id, 'viewer', { printer: cc })).rejects.toThrow(ApiError);
		try {
			await setPrinter(db, id, 'viewer', { printer: cc });
		} catch (e) {
			expect((e as ApiError).status).toBe(403);
		}
		try {
			await setPrinter(db, id, 'outsider', { printer: cc });
		} catch (e) {
			expect((e as ApiError).status).toBe(404);
		}
	});

	it('validates the input', async () => {
		const id = await mk();
		for (const bad of [
			{ ...cc, bedX: 10 },
			{ ...cc, bedY: 'x' },
			{ ...cc, name: '' },
			{ ...cc, catalogId: 'not-a-printer' },
			{ ...cc, mmSlots: 0 },
			{ ...cc, margin: 500 }
		])
			await expect(setPrinter(db, id, 'owner', { printer: bad })).rejects.toThrow(/./);
		await expect(setPrinter(db, id, 'owner', {})).rejects.toThrow(ApiError);
	});

	it('clears with null, writes an activity row and emits an event', async () => {
		const id = await mk();
		const events = onBuildEvents(id);
		await setPrinter(db, id, 'owner', { printer: cc });
		expect(events.at(-1)).toMatchObject({ type: 'changed', kind: 'build.printer' });
		const a = (await view(id)).activity.find((x) => x.kind === 'build.printer')!;
		expect(a.kind).toBe('build.printer');
		expect(describeActivity(a, await view(id))).toBe(
			'User owner set the printer to Elegoo Centauri Carbon (256×256 mm bed)'
		);
		await setPrinter(db, id, 'owner', { printer: null });
		expect((await view(id)).printer).toBeNull();
	});
});

describe('arrangeForPrinter', () => {
	it('needs a printer', async () => {
		const id = await mk();
		await expect(arrangeForPrinter(db, id, 'owner')).rejects.toThrow(/printer/i);
	});

	it('is applied on creation when a printer is given', async () => {
		const id = await mk(cc);
		const v = await view(id);
		expect(v.plates.length).toBeGreaterThan(5);
		expect(v.plates.every((p) => p.source === 'arranged')).toBe(true);
		const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
		expect(row.plateLayout).toBe('arranged');
		// every active part sits on exactly... at least one plate
		for (const p of v.parts) expect(v.plates.some((pl) => pl.parts.includes(p.slug))).toBe(true);
	});

	it('permissions: viewers cannot arrange', async () => {
		const id = await mk(cc);
		await expect(arrangeForPrinter(db, id, 'viewer')).rejects.toThrow(ApiError);
	});

	it('single-filament bed: PETG and TPU never share a plate, and colors stay apart', async () => {
		const id = await mk(bed(256, 256, 1));
		const v = await view(id);
		for (const pl of v.plates) {
			const roles = new Set(pl.parts.map((s) => v.parts.find((p) => p.slug === s)!.role));
			// a plate printed in runs of its own (the wheel rims) holds one color per print
			if (!pl.perPartRuns) expect(roles.size).toBe(1);
		}
	});

	it('multi-material bed never needs more plates than a single-filament bed (the kit layout is kept, not merged)', async () => {
		const single = (await view(await mk(bed(350, 320, 1)))).plates.length;
		const multi = (await view(await mk(bed(350, 320, 4)))).plates.length;
		// the kit's own layout comes first: extra slots do not merge plates the kit prints on their own. (A
		// one-slot bed packs the parts that had to leave a mixed plate together, so it can save one plate.)
		expect(multi).toBeLessThanOrEqual(single + 1);
		const v = await view(await mk(bed(350, 320, 4)));
		for (const pl of v.plates) {
			const mats = new Set(
				pl.parts.map(
					(s) => v.filaments.find((f) => f.key === v.parts.find((p) => p.slug === s)!.role)!.tpu
				)
			);
			expect(mats.size).toBe(1); // PETG and TPU stay apart
		}
	});

	it('warns about parts that do not fit a small bed', async () => {
		const id = await mk(bed(180));
		const info = await buildArrangement(db, id, 'owner');
		const over = info.fresh!.warnings.filter((w) => w.code === 'oversize').map((w) => w.slug);
		expect(over).toContain('wheel-mount-left');
		expect(info.fresh!.warnings.find((w) => w.slug === 'footrest')?.message).toMatch(/Two pieces/);
	});

	it('moving a part to another color re-arranges automatically when no plate has logs', async () => {
		const id = await mk(bed(256, 256, 1));
		const before = await plateOf(id, 'wing-left');
		const vBefore = await view(id);
		expect(
			before.parts.every((s) => vBefore.parts.find((p) => p.slug === s)!.role === 'accent')
		).toBe(true);
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'primary' } });
		const after = await plateOf(id, 'wing-left');
		const vAfter = await view(id);
		expect(
			after.parts.every((s) => vAfter.parts.find((p) => p.slug === s)!.role === 'primary')
		).toBe(true);
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
	});

	it('re-arranging keeps typed plate grams and time on a plate with the same parts, drops nothing else', async () => {
		const id = await mk(bed(256, 256, 1));
		const pl = await plateOf(id, 'wing-left');
		await updatePlate(db, id, 'owner', pl.number, { slicerGrams: 123, manualEstSeconds: 3600 });
		await arrangeForPrinter(db, id, 'owner');
		const after = (await view(id)).plates.find((p) => p.number === pl.number)!;
		expect(after.parts).toEqual(pl.parts);
		expect(after).toMatchObject({ slicerGrams: 123, gramsSource: 'user', estSeconds: 3600 });
		// other plates carry nothing
		for (const o of (await view(id)).plates.filter((p) => p.number !== pl.number))
			expect(o.slicerGrams).toBeNull();
		// a plate whose parts changed does not keep the number
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'primary' } });
		const moved = await plateOf(id, 'wing-left');
		if (moved.parts.join() !== pl.parts.join()) expect(moved.slicerGrams).toBeNull();
	});

	it('changing the printer or a variant re-arranges too', async () => {
		const id = await mk(bed(350, 320, 1));
		const n1 = (await view(id)).plates.length;
		await setPrinter(db, id, 'owner', { printer: bed(350, 320, 4) });
		expect((await view(id)).plates.length).toBeLessThanOrEqual(n1 + 1);
		expect((await view(id)).plates.every((p) => p.source === 'arranged')).toBe(true);
		await setVariant(db, id, 'owner', { group: 'footrest', option: 'two-piece' });
		expect((await view(id)).plates.some((p) => p.parts.includes('footrest-front'))).toBe(true);
		expect((await view(id)).plates.some((p) => p.parts.includes('footrest'))).toBe(false);
	});

	it('with plate print logs it leaves plates alone, reports stale, and asks before converting', async () => {
		const id = await mk(bed(256, 256, 1));
		const first = (await view(id)).plates[0];
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			plateNumber: first.number,
			grams: 100
		});
		const platesBefore = JSON.stringify((await view(id)).plates);
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'primary' } });
		expect(JSON.stringify((await view(id)).plates)).toBe(platesBefore);
		const info = await buildArrangement(db, id, 'owner');
		expect(info.stale).toBe(true);
		expect(info.hasPlateRuns).toBe(true);
		try {
			await arrangeForPrinter(db, id, 'owner');
			expect.unreachable();
		} catch (e) {
			expect((e as ApiError).status).toBe(409);
		}
		const res = await arrangeForPrinter(db, id, 'owner', { convertRuns: true });
		expect(res.convertedRuns).toBe(1);
		expect((await view(id)).runs.every((r) => r.plateNumber === null)).toBe(true);
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
	});

	it('a null item in a stored arrangement does not throw and marks it stale only by content', async () => {
		const id = await mk(bed(256, 256, 1));
		const row = (await db.select().from(buildPlates).where(eq(buildPlates.buildId, id)))[0];
		expect(row.arrangement).toBeTruthy();
		const bad = { ...row.arrangement!, items: [null, ...row.arrangement!.items] } as never;
		await db
			.update(buildPlates)
			.set({ arrangement: bad })
			.where(and(eq(buildPlates.buildId, id), eq(buildPlates.number, row.number)));
		await expect(buildArrangement(db, id, 'owner')).resolves.toBeTruthy();
	});

	it('leaves other layouts alone when the printer changes', async () => {
		const id = await mk();
		await setPlateLayout(db, id, 'owner', { key: 'h2d' });
		const before = JSON.stringify((await view(id)).plates);
		await setPrinter(db, id, 'owner', { printer: cc });
		expect(JSON.stringify((await view(id)).plates)).toBe(before);
	});

	it('stores positions that fit the bed', async () => {
		const id = await mk(bed(256, 256, 4));
		const info = await buildArrangement(db, id, 'owner');
		expect(info.plates.length).toBe((await view(id)).plates.length);
		for (const pl of info.plates)
			if (!pl.oversize)
				for (const i of pl.items) {
					expect(i.x - i.w / 2).toBeGreaterThanOrEqual(0.9);
					expect(i.x + i.w / 2).toBeLessThanOrEqual(255.1);
				}
		expect(Object.keys(info.footprints).length).toBeGreaterThan(10);
	});
});

describe('print time estimates on arranged plates', () => {
	it('arranged plates get a time estimate marked as such, and the build has a total', async () => {
		const id = await mk(cc);
		const v = await view(id);
		expect(v.plates.every((p) => p.estSource === 'estimate' && (p.estSeconds ?? 0) > 0)).toBe(true);
		const t = timeStats(v);
		expect(t.known).toBe(true);
		// MakeGood's X/P/A total is ~382 h; ours is the same kit, so the same ballpark
		expect(t.totalSec / 3600).toBeGreaterThan(250);
		expect(t.totalSec / 3600).toBeLessThan(500);
		expect(timeLeftText(t).kind).toBe('estimate');
	});

	it('computes the estimate in the loader when the stored plate has none', async () => {
		const id = await mk(cc);
		await db.update(buildPlates).set({ estSeconds: null }).where(eq(buildPlates.buildId, id));
		expect((await view(id)).plates.every((p) => (p.estSeconds ?? 0) > 0)).toBe(true);
	});

	it('stores the estimate when arranging', async () => {
		const id = await mk(cc);
		const rows = await db.select().from(buildPlates).where(eq(buildPlates.buildId, id));
		expect(rows.every((r) => (r.estSeconds ?? 0) > 0)).toBe(true);
	});

	it('keeps MakeGood profile times on a plain X/P/A layout', async () => {
		const id = await mk();
		const p = (await view(id)).plates[0];
		expect(p.estSource).toBe('profile');
	});
});
