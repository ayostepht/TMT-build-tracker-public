import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import type { BuildPrinter } from '#lib/domain/types.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	buildPlates,
	member,
	organization,
	templatePlateLayouts,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, setPrinter, setVariant, updatePlate } from './actions';
import { createBuild } from './create';
import { updateBuildDesign } from '../designs/mutate';
import {
	clearPlanCache,
	layoutHintFor,
	loadFootprints,
	loadKitSource,
	manualTimes,
	PLANNER_VERSION,
	planArrangement,
	planCacheStats,
	planForBuild,
	signature,
	writePlan,
	type Plan
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

// What every build made before planner versions existed is in: plates stored by the plain arranger, with no
// planner version on them. They are compared with that arranger (`planArrangement(..., 'legacy')`), never with
// the current planner, so reading them never flags them stale and never rewrites them.

/** Store a plan as the build's plates the way the build had them before planner versions existed: no `v`. */
async function storeWithoutVersion(id: string, plan: Plan) {
	await writePlan(db, id, plan);
	for (const r of await rows(id))
		await db
			.update(buildPlates)
			.set({
				arrangement: Object.fromEntries(
					Object.entries(r.arrangement!).filter(([k]) => k !== 'v')
				) as never
			})
			.where(and(eq(buildPlates.buildId, id), eq(buildPlates.number, r.number)));
}
const snapshot = async (id: string) => JSON.stringify(await rows(id));

describe('arrangements stored without a planner version (every build made before planner versions)', () => {
	it(
		"are the legacy planner's own output: not stale, not rewritten, stale after a color change",
		{ timeout: 60_000 },
		async () => {
			const id = await mk(cc);
			const fp = await loadFootprints(db, templateId);
			const legacy = planArrangement(await view(id), fp, null, undefined, 'legacy')!;
			await storeWithoutVersion(id, legacy);
			expect((await rows(id)).every((r) => (r.arrangement as { v?: number }).v === undefined)).toBe(
				true
			);
			// the current planner plans something else for this build (so "not stale" is the legacy comparison)
			const kitPlan = (await planForBuild(db, await view(id), fp, null))!;
			expect(signature(kitPlan.result.plates)).not.toBe(signature(legacy.result.plates));
			const before = await snapshot(id);
			const info = await buildArrangement(db, id, 'owner');
			expect(info.stale).toBe(false);
			expect(info.plates.length).toBe(legacy.result.plates.length);
			expect(info.fresh!.plates).toBe(kitPlan.result.plates.length);
			expect(await snapshot(id)).toBe(before); // reading never rewrites
			// a started build keeps its plates when a part is recolored; the legacy planner now plans it differently
			await addRun(db, id, 'owner', {
				date: '2026-03-01',
				result: 'Success',
				partSlug: 'handle-left',
				grams: 5
			});
			await updateBuildDesign(db, id, 'owner', { partRoles: { 'seat-back-top': 'accent' } });
			expect(await snapshot(id)).toBe(before);
			const changed = await view(id);
			expect(
				signature(planArrangement(changed, fp, null, undefined, 'legacy')!.result.plates)
			).not.toBe(signature(legacy.result.plates));
			expect((await buildArrangement(db, id, 'owner')).stale).toBe(true);
			expect(await snapshot(id)).toBe(before);
		}
	);
});

describe('an automatic re-arrange of a version-less build keeps typed grams and times', () => {
	it(
		'a plate whose parts stay together keeps them, even though the kit numbers it differently',
		{ timeout: 60_000 },
		async () => {
			const id = await mk(cc);
			const fp = await loadFootprints(db, templateId);
			const legacy = planArrangement(await view(id), fp, null, undefined, 'legacy')!;
			await storeWithoutVersion(id, legacy);
			const kitPlan = (await planForBuild(db, await view(id), fp, null))!;
			const same = (a: { parts: string[] }, b: { parts: string[] }) =>
				[...a.parts].sort().join() === [...b.parts].sort().join();
			// a plate with the same parts in both plans, under another number, printed as often, not recolored below
			const pair = legacy.result.plates
				.map((l) => ({
					l,
					k: kitPlan.result.plates.find(
						(k) => same(k, l) && k.number !== l.number && k.runs === l.runs && !k.perPartRuns
					)
				}))
				.find((x) => x.k && !x.l.parts.includes('seat-back-top'))!;
			expect(pair, 'a plate that has the same parts under another number').toBeTruthy();
			await updatePlate(db, id, 'owner', pair.l.number, {
				slicerGrams: 77,
				manualEstSeconds: 5400
			});
			// a recolor of a part on another plate: the unstarted build is re-arranged to the kit's layout
			await updateBuildDesign(db, id, 'owner', { partRoles: { 'seat-back-top': 'accent' } });
			const now = await rows(id);
			expect(now.every((r) => (r.arrangement as { v?: number }).v === PLANNER_VERSION)).toBe(true);
			const moved = now.find((r) => same(r, pair.l))!;
			expect(moved.number).toBe(pair.k!.number);
			expect(moved.manualEstSeconds).toBe(5400);
			expect(moved.manualEstSource).toBe('user');
			expect(moved.slicerGrams).toBe(77);
			expect(moved.slicerGramsSource).toBe('user');
			const v = (await view(id)).plates.find((p) => p.number === moved.number)!;
			expect(v.estSource).toBe('manual');
			expect(v.gramsSource).toBe('user');
		}
	);
});

describe('typed values follow a renumbered plate only when it is the same plate', () => {
	it('same parts, same runs, same kind: carried once; another run count or kind, or a second claim: not', async () => {
		const id = await mk(cc);
		const pl = (await view(id)).plates.find((p) => p.parts.length >= 1 && !p.perPartRuns)!;
		await updatePlate(db, id, 'owner', pl.number, { slicerGrams: 41, manualEstSeconds: 600 });
		const carry = await manualTimes(db, id, [{ number: pl.number, parts: pl.parts }]);
		const shape = { runs: pl.runs, perPartRuns: false };
		// the same number and parts always win, shape or not
		expect(carry(pl.number, pl.parts).manualEstSeconds).toBe(600);
		const renumbered = await manualTimes(db, id, [
			{ number: pl.number + 100, parts: pl.parts },
			{ number: pl.number + 101, parts: pl.parts }
		]);
		expect(renumbered(pl.number + 100, pl.parts, shape)).toMatchObject({
			manualEstSeconds: 600,
			typedGrams: { slicerGrams: 41, slicerGramsSource: 'user' }
		});
		// used once: a second plate with the same parts does not get a copy
		expect(renumbered(pl.number + 101, pl.parts, shape).manualEstSeconds).toBeNull();
		const other = await manualTimes(db, id, [{ number: pl.number + 100, parts: pl.parts }]);
		expect(
			other(pl.number + 100, pl.parts, { ...shape, runs: pl.runs + 1 }).manualEstSeconds
		).toBeNull();
		expect(
			other(pl.number + 100, pl.parts, { ...shape, perPartRuns: true }).manualEstSeconds
		).toBeNull();
		expect(other(pl.number + 100, [...pl.parts, 'extra'], shape).manualEstSeconds).toBeNull();
		expect(other(pl.number + 100, pl.parts).manualEstSeconds).toBeNull(); // no shape given: exact only
	});

	it('a typed value goes to one new plate only, and the exact number + parts match wins in either order', async () => {
		const id = await mk(cc);
		const pl = (await view(id)).plates.find((p) => p.parts.length >= 1 && !p.perPartRuns)!;
		await updatePlate(db, id, 'owner', pl.number, { slicerGrams: 41, manualEstSeconds: 600 });
		const shape = { runs: pl.runs, perPartRuns: false };
		const exact = { number: pl.number, parts: pl.parts };
		const renumbered = { number: pl.number + 100, parts: pl.parts };
		for (const order of [
			[exact, renumbered],
			[renumbered, exact]
		]) {
			const carry = await manualTimes(db, id, [exact, renumbered]);
			const got = new Map(order.map((o) => [o.number, carry(o.number, o.parts, shape)]));
			expect(got.get(exact.number)!.manualEstSeconds).toBe(600);
			expect(got.get(exact.number)!.typedGrams?.slicerGrams).toBe(41);
			expect(got.get(renumbered.number)!.manualEstSeconds).toBeNull();
			expect(got.get(renumbered.number)!.typedGrams).toBeUndefined();
		}
	});
});

// A small in-process cache of fresh plans (arrange-plan.ts): a plan is only ever returned for the exact
// input it was made from. Tests start from an empty cache (the counters are module state).
describe('the fresh-plan cache', () => {
	beforeEach(() => clearPlanCache());
	const fresh = async (id: string) => {
		const v = await view(id);
		return (await planForBuild(
			db,
			v,
			await loadFootprints(db, templateId),
			await layoutHintFor(db, templateId)
		))!;
	};
	/** The same plan without the cache (explicit options are never cached). */
	const direct = async (id: string) => {
		const v = await view(id);
		return (await planArrangement(
			v,
			await loadFootprints(db, templateId),
			await layoutHintFor(db, templateId),
			{},
			await loadKitSource(db, v)
		))!;
	};
	const started = (id: string) =>
		addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			partSlug: 'handle-left',
			grams: 5
		});

	it('two identical reads plan once', { timeout: 60_000 }, async () => {
		const id = await mk(cc);
		clearPlanCache();
		const a = await buildArrangement(db, id, 'owner');
		expect(planCacheStats).toEqual({ hits: 0, misses: 1 });
		const b = await buildArrangement(db, id, 'owner');
		expect(planCacheStats).toEqual({ hits: 1, misses: 1 });
		expect(b).toEqual(a);
		expect(signature((await fresh(id)).result.plates)).toBe(
			signature((await direct(id)).result.plates)
		);
	});

	it(
		'a version-less build plans twice on the first read (legacy and current) and never again',
		{ timeout: 60_000 },
		async () => {
			const id = await mk(cc);
			await storeWithoutVersion(
				id,
				planArrangement(
					await view(id),
					await loadFootprints(db, templateId),
					null,
					undefined,
					'legacy'
				)!
			);
			clearPlanCache();
			await buildArrangement(db, id, 'owner');
			expect(planCacheStats.misses).toBe(2);
			await buildArrangement(db, id, 'owner');
			await buildArrangement(db, id, 'owner');
			expect(planCacheStats.misses).toBe(2);
			expect(planCacheStats.hits).toBe(4);
		}
	);

	it(
		'a change of colour, variant, printer, bed option or kit layout misses, and gets its own plan',
		{ timeout: 120_000 },
		async () => {
			const id = await mk(cc);
			await started(id); // a started build keeps its plates: no automatic re-arrange in between
			clearPlanCache();
			const step = async (label: string, change: () => Promise<unknown>) => {
				await change();
				const before = planCacheStats.misses;
				const plan = await fresh(id);
				expect(planCacheStats.misses, `${label} misses`).toBe(before + 1);
				expect(await fresh(id)).toEqual(plan); // and the next read hits
				expect(planCacheStats.misses, `${label} then hits`).toBe(before + 1);
				expect(signature(plan.result.plates), `${label} is what a fresh computation gives`).toBe(
					signature((await direct(id)).result.plates)
				);
				return plan;
			};
			await step('first', async () => {});
			await step('colour', () =>
				updateBuildDesign(db, id, 'owner', { partRoles: { 'seat-back-top': 'accent' } })
			);
			await step('variant', () =>
				setVariant(db, id, 'owner', { group: 'seat', option: 'bucket-seat' })
			);
			await step('printer', () =>
				setPrinter(db, id, 'owner', { printer: { ...cc, bedX: 300, bedY: 300, keepOut: [] } })
			);
			await step('bed margin', () =>
				setPrinter(db, id, 'owner', {
					printer: { ...cc, bedX: 300, bedY: 300, keepOut: [], margin: 9 }
				})
			);
			await step('keep-out', () =>
				setPrinter(db, id, 'owner', {
					printer: {
						...cc,
						bedX: 300,
						bedY: 300,
						margin: 9,
						keepOut: [{ x: 0, y: 0, w: 60, d: 60 }]
					}
				})
			);
			// the kit's own layout: another name on a plate is another plan
			const layout = (await loadKitSource(db, await view(id)))!;
			expect(layout.layout).toBeTruthy();
			const row = (await first(
				db
					.select()
					.from(templatePlateLayouts)
					.where(
						and(
							eq(templatePlateLayouts.templateId, templateId),
							eq(templatePlateLayouts.key, layout.layout!)
						)
					)
			))!;
			const plan = await step('kit layout', () =>
				db
					.update(templatePlateLayouts)
					.set({
						plates: row.plates.map((p, i) => (i === 0 ? { ...p, name: 'Renamed plate' } : p))
					})
					.where(
						and(
							eq(templatePlateLayouts.templateId, templateId),
							eq(templatePlateLayouts.key, row.key)
						)
					)
			);
			expect(plan.result.plates.some((p) => p.name === 'Renamed plate')).toBe(true);
			expect(planCacheStats.misses).toBe(7);
		}
	);

	it(
		'hands out copies: a caller that edits its plan changes nothing for the next read',
		{ timeout: 60_000 },
		async () => {
			const id = await mk(cc);
			clearPlanCache();
			const a = await fresh(id);
			const n = a.result.plates.length;
			a.result.plates.length = 0;
			expect((await fresh(id)).result.plates).toHaveLength(n);
			expect(planCacheStats.hits).toBe(1);
		}
	);

	it('is bounded', async () => {
		const id = await mk(cc);
		clearPlanCache();
		const v0 = await view(id);
		// a small build keeps the 60 plans cheap
		const v = { ...v0, parts: v0.parts.slice(0, 3) };
		const fp = await loadFootprints(db, templateId);
		const kit = (await loadKitSource(db, v0))!;
		const at = (i: number) =>
			planArrangement(
				{ ...v, printer: { ...v.printer!, margin: 1 + i / 100 } },
				fp,
				null,
				undefined,
				kit
			);
		for (let i = 0; i < 60; i++) at(i);
		expect(planCacheStats.misses).toBe(60);
		// the oldest were dropped (they plan again), the newest are still there
		at(59);
		expect(planCacheStats.hits).toBe(1);
		at(0);
		expect(planCacheStats.misses).toBe(61);
	});
});
