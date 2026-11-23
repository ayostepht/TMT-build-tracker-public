import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { filamentStats, timeStats } from '#lib/domain/accounting.ts';
import { partBySlug } from '#lib/domain/custom.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { createPrinter } from '../printers/store';
import {
	activity,
	buildCustomPieces,
	buildParts,
	buildPlates,
	builds,
	member,
	organization,
	printerJobs,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { updateBuildDesign } from '../designs/mutate';
import { addRun, setPartStatus, skipParts, skipPartsTx } from './actions';
import { createBuild } from './create';
import { buildRows } from './list';
import { loadBuildView, startedBuildIds as startedIds } from './view';

let db: Db;
let id: string;
let templateId: string;

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db.insert(user).values({ id: 'viewer', name: 'Vic', email: 'v@example.test' });
	for (const [mid, uid, role] of [
		['m1', 'owner', 'owner'],
		['m2', 'viewer', 'viewer']
	])
		await db
			.insert(member)
			.values({ id: mid, organizationId: 'org1', userId: uid, role, createdAt: new Date() });
	id = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'A' },
		'owner'
	);
});

const view = async () => (await loadBuildView(db, id, 'owner'))!;
const skip = (slugs: string[], on = true, who = 'owner') =>
	skipParts(db, id, who, { slugs, skip: on });
const status = async (e: () => Promise<unknown>) => {
	try {
		await e();
	} catch (x) {
		return x instanceof ApiError ? x.status : -1;
	}
	return 0;
};

const activityRows = (kind: string) => db.select().from(activity).where(eq(activity.kind, kind));

describe('Not printing (skip / restore)', () => {
	it('takes parts out of parts, state, plates and totals, and restore puts them back', async () => {
		const v0 = await view();
		const plate = v0.plates.find((p) => p.parts.includes('handle-left'))!;
		const grams0 = filamentStats(v0).reduce((a, f) => a + f.total, 0);
		const sec0 = timeStats(v0).totalSec;
		await skip(['handle-left']);
		const v = await view();
		expect(v.parts.some((p) => p.slug === 'handle-left')).toBe(false);
		expect(v.state['handle-left']).toBeUndefined();
		expect(v.allParts.some((p) => p.slug === 'handle-left')).toBe(true);
		expect(v.skipped).toEqual([
			expect.objectContaining({
				slug: 'handle-left',
				status: 'To print',
				plateNumber: plate.number,
				custom: false
			})
		]);
		// handle-left is alone on its plate: the plate disappears and the totals drop
		expect(v.plates.some((p) => p.number === plate.number)).toBe(false);
		expect(timeStats(v).totalSec).toBeLessThan(sec0);
		expect(filamentStats(v).reduce((a, f) => a + f.total, 0)).toBeLessThanOrEqual(grams0);
		expect(await activityRows('part.skip')).toHaveLength(1);
		await skip(['handle-left'], false);
		const back = await view();
		expect(back.parts.some((p) => p.slug === 'handle-left')).toBe(true);
		expect(back.plates.some((p) => p.number === plate.number)).toBe(true);
		expect(back.skipped).toEqual([]);
		expect(timeStats(back).totalSec).toBe(sec0);
	});

	it('restore keeps the stored status and does not recompute from runs', async () => {
		const pl = (await view()).plates.find((p) => p.parts.length > 1)!;
		const [a, b] = pl.parts;
		await addRun(db, id, 'owner', {
			plateNumber: pl.number,
			partSlug: null,
			partSlugs: null,
			date: '2026-11-01',
			result: 'Success',
			grams: 10,
			hours: 1,
			printer: null,
			note: ''
		});
		expect((await view()).state[a].status).toBe('Printed');
		await setPartStatus(db, id, 'owner', a, { status: 'Reprint' });
		await skip([a]);
		expect((await view()).skipped[0]).toMatchObject({ slug: a, status: 'Reprint' });
		expect((await view()).state[b].status).toBe('Printed');
		await skip([a], false);
		// the run history says Printed; the stored status (Reprint) simply comes back
		expect((await view()).state[a].status).toBe('Reprint');
	});

	it('skipped parts do not count as started, in the view or the batched readers', async () => {
		await skip(['handle-left']);
		expect((await view()).started.totalParts).toBe((await view()).parts.length);
		await db
			.update(buildParts)
			.set({ status: 'Printed' })
			.where(eq(buildParts.partSlug, 'handle-left'));
		expect((await view()).started.started).toBe(false);
		expect((await startedIds(db, [id])).has(id)).toBe(false);
		const row = (await buildRows(db, ['org1'])).find((r) => r.id === id)!;
		expect(row.printed).toBe(0);
		expect(row.total).toBe((await view()).parts.length);
		await skip(['handle-left'], false);
		expect((await startedIds(db, [id])).has(id)).toBe(true);
	});

	it('refuses a Printing part and a part on a live printer job (409)', async () => {
		await setPartStatus(db, id, 'owner', 'handle-left', { status: 'Printing' });
		expect(await status(() => skip(['handle-left']))).toBe(409);
		await setPartStatus(db, id, 'owner', 'handle-left', { status: 'To print' });
		const p = await createPrinter(db, 'org1', 'owner', {
			name: 'Shop Centauri',
			kind: 'elegoo-sdcp',
			secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
			catalogId: 'elegoo-centauri-carbon'
		});
		await db.insert(printerJobs).values({
			printerId: p.id,
			buildId: id,
			plateNumber: 1,
			partSlugs: ['handle-left'],
			status: 'printing',
			startedAt: new Date()
		});
		expect(await status(() => skip(['handle-left']))).toBe(409);
		expect((await view()).skipped).toEqual([]);
	});

	it('refuses drafts, viewers and unknown slugs', async () => {
		expect(await status(() => skip(['handle-left'], true, 'viewer'))).toBe(403);
		expect(await status(() => skip(['nope']))).toBe(400);
		expect(await status(() => skip([]))).toBe(400);
		expect(await status(() => skip(['handle-left'], false))).toBe(0); // nothing to restore: no-op
		expect(await activityRows('part.restore')).toHaveLength(0);
		await db.update(builds).set({ kind: 'draft' }).where(eq(builds.id, id));
		expect(await status(() => skip(['handle-left']))).toBe(400);
		expect((await view()).skipped).toEqual([]);
	});

	it('records the plate in the payload when a whole plate is skipped', async () => {
		const pl = (await view()).plates.find((p) => p.parts.length > 1)!;
		await skip(pl.parts);
		const row = (await first(activityRows('part.skip')))!;
		expect(row.payload).toMatchObject({ slugs: pl.parts, plate: { number: pl.number } });
	});

	it('skipPartsTx validates and writes without an activity row, inside another transaction', async () => {
		const v = await view();
		const r = await db.transaction(async (tx) =>
			skipPartsTx(tx, v, ['handle-left'], true, new Date())
		);
		expect(r.names).toHaveLength(1);
		expect((await view()).skipped).toHaveLength(1);
		expect(await activityRows('part.skip')).toHaveLength(0);
	});

	it('a demo user is an ordinary editor: Not printing and bring-back work', async () => {
		await db.update(user).set({ isDemo: true }).where(eq(user.id, 'owner'));
		await skip(['handle-left']);
		expect((await view()).skipped).toHaveLength(1);
		await skip(['handle-left'], false);
		expect((await view()).skipped).toEqual([]);
	});
});

async function addPiece(role = 'accent') {
	await db.insert(buildCustomPieces).values({
		id: 'pc1',
		buildId: id,
		name: 'Beta handle',
		fileName: 'beta.3mf',
		sliced: true,
		replaces: ['handle-left'],
		parts: [{ slug: 'custom-aa11', name: 'Beta handle', role }],
		createdAt: new Date()
	});
	await db.insert(buildParts).values({ buildId: id, partSlug: 'custom-aa11' });
	await db.insert(buildPlates).values({
		buildId: id,
		number: 90,
		name: 'Beta handle',
		estSeconds: 3600,
		runs: 1,
		parts: ['custom-aa11'],
		slicerGrams: 20,
		filamentGrams: { accent: 15, primary: 5 },
		source: 'custom:pc1'
	});
}

describe('custom pieces in the view', () => {
	it('merges custom parts into parts (not allParts) with role, grams and time', async () => {
		await addPiece();
		const v = await view();
		const cp = v.parts.find((p) => p.slug === 'custom-aa11')!;
		expect(cp).toMatchObject({ section: 'Custom', role: 'accent', custom: { pieceId: 'pc1' } });
		expect(v.parts[v.parts.length - 1].slug).toBe('custom-aa11');
		expect(v.allParts.some((p) => p.slug === 'custom-aa11')).toBe(false);
		expect(partBySlug(v, 'custom-aa11')?.name).toBe('Beta handle');
		const pl = v.plates.find((p) => p.number === 90)!;
		expect(pl).toMatchObject({
			source: 'custom:pc1',
			estSeconds: 3600,
			estSource: 'slicer',
			runNote: null
		});
		expect(v.customPieces).toEqual([
			expect.objectContaining({
				id: 'pc1',
				parts: ['custom-aa11'],
				plates: [90],
				replaces: ['handle-left'],
				removable: true
			})
		]);
		// file role grams: all roles of the file, not only the part's role
		const stat = Object.fromEntries(filamentStats(v).map((f) => [f.role, f.total]));
		expect(stat.primary).toBeGreaterThanOrEqual(5);
	});

	it('is not removable once it has a run or is printing', async () => {
		await addPiece();
		await setPartStatus(db, id, 'owner', 'custom-aa11', { status: 'Printing' });
		expect((await view()).customPieces[0].removable).toBe(false);
		await setPartStatus(db, id, 'owner', 'custom-aa11', { status: 'To print' });
		expect((await view()).customPieces[0].removable).toBe(true);
		await addRun(db, id, 'owner', {
			plateNumber: 90,
			partSlug: null,
			partSlugs: null,
			date: '2026-11-01',
			result: 'Success',
			grams: 20,
			hours: 1,
			printer: null,
			note: ''
		});
		expect((await view()).customPieces[0].removable).toBe(false);
	});

	it('a custom part can be skipped and brought back', async () => {
		await addPiece();
		await skip(['custom-aa11']);
		const v = await view();
		expect(v.plates.some((p) => p.number === 90)).toBe(false);
		expect(v.skipped[0]).toMatchObject({ slug: 'custom-aa11', custom: true, plateNumber: 90 });
		expect(v.customPieces[0].parts).toEqual(['custom-aa11']);
		await skip(['custom-aa11'], false);
		expect((await view()).plates.some((p) => p.number === 90)).toBe(true);
	});

	it('removing a colour re-keys custom parts and needs replaceWith', async () => {
		await updateBuildDesign(db, id, 'owner', {
			addRole: { key: 'extra', name: 'Extra', material: 'PLA', hex: '#123456' }
		} as never);
		await addPiece('extra');
		expect(
			await status(() => updateBuildDesign(db, id, 'owner', { removeRole: 'extra' } as never))
		).toBe(409);
		await updateBuildDesign(db, id, 'owner', {
			removeRole: 'extra',
			replaceWith: 'accent'
		} as never);
		expect((await view()).parts.find((p) => p.slug === 'custom-aa11')!.role).toBe('accent');
		const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
		expect(JSON.stringify(row.design)).not.toContain('custom-aa11');
	});

	it('a design mutation never takes a custom slug into partRoles', async () => {
		await addPiece();
		for (const body of [
			{ partRoles: { 'custom-aa11': 'primary' } },
			{ lock: { slugs: ['custom-aa11'], locked: true } }
		])
			expect(await status(() => updateBuildDesign(db, id, 'owner', body as never))).toBe(400);
		// Some kit part can move to another slot: that write must work and carry no custom slug.
		const v = await view();
		let moved = false;
		for (const p of v.allParts)
			for (const f of v.filaments) {
				if (moved || f.key === p.role || p.locked) continue;
				try {
					await updateBuildDesign(db, id, 'owner', { partRoles: { [p.slug]: f.key } } as never);
					moved = true;
				} catch {
					/* material mismatch: try the next */
				}
			}
		expect(moved).toBe(true);
		const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
		expect(JSON.stringify(row.design)).not.toContain('custom-aa11');
		expect((await view()).parts.find((p) => p.slug === 'custom-aa11')!.role).toBe('accent');
	});
});
