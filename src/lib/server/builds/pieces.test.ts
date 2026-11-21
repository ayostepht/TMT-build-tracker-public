/**
 * "Print some pieces…" on the server: starting a piece print (`printing` start with `comps`), logging
 * one (`runs` with `comps`), undo, edit and delete, hand ticks and Stop, plus the validation: every
 * request field is checked on the server, for editors only, never on drafts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildPlates,
	buildParts,
	member,
	organization,
	printerJobs,
	printRuns,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import {
	addRun,
	addRunSystem,
	deleteRun,
	printingAction,
	setPartStatus,
	undoRun,
	updatePart,
	updateRun
} from './actions';
import { createBuild } from './create';
import { createPrinter } from '../printers/store';
import { loadBuildView } from './view';
import { describeActivity } from '../../domain/activity';
import { snapshotParts } from '../../domain/logrun';
import { loggedPieces, piecesLeft } from '../../domain/actions';
import { filamentStats, timeStats } from '../../domain/accounting';
import { nowPrinting } from '../../domain/now';

let db: Db;
let templateId: string;
const orgId = 'org1';
const H = 'harness';

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const u of ['owner', 'editor', 'viewer']) {
		await db.insert(user).values({ id: u, name: `User ${u}`, email: `${u}@example.test` });
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: orgId, userId: u, role: u, createdAt: new Date() });
	}
});

const mk = async (kind: 'build' | 'draft' = 'build') =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', kind },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const acts = async (id: string, kind: string) =>
	(await db.select().from(activity).where(eq(activity.buildId, id))).filter((a) => a.kind === kind);
const status = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		return (e as ApiError).status;
	}
	return 0;
};
const ticked = async (id: string) =>
	Object.entries((await view(id)).state[H].comps)
		.filter(([, v]) => v)
		.map(([k]) => Number(k))
		.sort((a, b) => a - b);
const start = async (id: string, comps?: unknown, extra: object = {}) =>
	await printingAction(db, id, 'owner', {
		action: 'start',
		slugs: [H],
		...(comps ? { comps } : {}),
		...extra
	});
const logPieces = async (id: string, comps: unknown, result = 'Success', over: object = {}) =>
	await addRun(db, id, 'owner', {
		plateNumber: 18,
		partSlug: H,
		comps,
		date: '2026-01-02',
		result,
		hours: 1,
		grams: 80,
		note: '',
		...over
	});

describe('starting some pieces', () => {
	it('marks the part Printing with the picked pieces and writes the activity row', async () => {
		const id = await mk();
		await start(id, [4, 0, 2]);
		const v = await view(id);
		expect(v.state[H]).toMatchObject({ status: 'Printing', printingComps: [0, 2, 4] });
		const row = (await acts(id, 'printing.start')).at(-1)!;
		expect(row.payload).toMatchObject({ slugs: [H], comps: [0, 2, 4] });
		expect(describeActivity({ ...row, at: row.at.toISOString(), userName: 'Sam' }, v)).toBe(
			'Sam put 3 pieces of Harness and Straps on the printer'
		);
		const [card] = nowPrinting(v);
		expect(card.pieces[0].picked).toHaveLength(3);
		expect(card.subset).toBe(true);
	});
	it('a typed start time and estimate keep working', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await printingAction(db, id, 'owner', {
			action: 'setStart',
			slugs: [H],
			when: '2026-01-02T08:00:00.000Z'
		});
		await printingAction(db, id, 'owner', { action: 'setEstimate', slugs: [H], seconds: 9000 });
		expect((await view(id)).state[H]).toMatchObject({
			printingComps: [0, 1, 2],
			startedAt: '2026-01-02T08:00:00.000Z',
			runEstSeconds: 9000
		});
	});
	it('every piece still to print is the whole-part print: no piece list, no comps in the row', async () => {
		const id = await mk();
		await updatePart(db, id, 'owner', H, { comps: { '0': true } });
		await start(id, [1, 2, 3, 4, 5, 6, 7, 8]);
		expect((await view(id)).state[H]).toMatchObject({ status: 'Printing', printingComps: null });
		expect((await acts(id, 'printing.start')).at(-1)!.payload).not.toHaveProperty('comps');
	});
	it('refuses what is not a valid piece print, with 400', async () => {
		const id = await mk();
		const cases: [string, unknown, object?][] = [
			['not a list', 'abc'],
			['empty', []],
			['a duplicate', [1, 1]],
			['out of range', [9]],
			['negative', [-1]],
			['a fraction', [0.5]],
			['a string', ['1']],
			['an object', [{}]],
			['all of them', [0, 1, 2, 3, 4, 5, 6, 7, 8]],
			['too many', Array.from({ length: 300 }, (_, i) => i)]
		];
		for (const [name, comps] of cases) {
			expect(await status(async () => await start(id, comps)), name).toBe(400);
		}
		expect((await view(id)).state[H].status).toBe('To print');
		// two parts, or an unknown / prototype slug
		expect(
			await status(
				async () =>
					await printingAction(db, id, 'owner', {
						action: 'start',
						slugs: [H, 'connectors'],
						comps: [0]
					})
			)
		).toBe(400);
		expect(
			await status(
				async () =>
					await printingAction(db, id, 'owner', {
						action: 'start',
						slugs: ['constructor'],
						comps: [0]
					})
			)
		).toBe(400);
		// a part with no separate pieces
		const plain = (await view(id)).parts.find((p) => !p.components.length)!.slug;
		expect(
			await status(
				async () =>
					await printingAction(db, id, 'owner', { action: 'start', slugs: [plain], comps: [0] })
			)
		).toBe(400);
		// a ticked piece
		await updatePart(db, id, 'owner', H, { comps: { '2': true } });
		expect(await status(async () => await start(id, [1, 2]))).toBe(400);
		expect((await view(id)).state[H].printingComps ?? null).toBeNull();
	});
	it('refuses a part already on the printer or already printed', async () => {
		const id = await mk();
		await start(id, [0, 1]);
		expect(await status(async () => await start(id, [2, 3]))).toBe(400);
		expect((await view(id)).state[H].printingComps).toEqual([0, 1]);
		await setPartStatus(db, id, 'owner', H, { status: 'Printed' });
		expect(await status(async () => await start(id, [2, 3]))).toBe(400);
	});
	it('refuses a plate that prints more than once or one part per run', async () => {
		for (const set of [{ runs: 2 }, { perPartRuns: true }]) {
			const id = await mk();
			await db
				.update(buildPlates)
				.set(set)
				.where(and(eq(buildPlates.buildId, id), eq(buildPlates.number, 18)));
			expect(await status(async () => await start(id, [0, 1])), JSON.stringify(set)).toBe(400);
			expect(await status(async () => await logPieces(id, [0, 1])), JSON.stringify(set)).toBe(400);
			expect((await view(id)).state[H].status).toBe('To print');
			expect((await view(id)).runs).toHaveLength(0);
		}
	});
	it('viewers cannot, and a draft has no printing', async () => {
		const id = await mk();
		expect(
			await status(
				async () =>
					await printingAction(db, id, 'viewer', { action: 'start', slugs: [H], comps: [0, 1] })
			)
		).toBe(403);
		const draft = await mk('draft');
		expect(await status(async () => await start(draft, [0, 1]))).toBe(400);
		expect(await status(async () => await logPieces(draft, [0, 1]))).toBe(400);
		expect((await view(draft)).state[H].printingComps ?? null).toBeNull();
	});
	it('Take off printer clears the piece list', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await printingAction(db, id, 'owner', { action: 'stop', slugs: [H] });
		expect((await view(id)).state[H]).toMatchObject({ status: 'To print', printingComps: null });
	});
	it('Take off printer also unlinks a live job and drops its piece list', async () => {
		const id = await mk();
		const printerId = (
			await createPrinter(db, orgId, 'owner', {
				name: 'Shop Centauri',
				kind: 'elegoo-sdcp',
				secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
				catalogId: 'elegoo-centauri-carbon'
			})
		).id;
		await start(id, [0, 1, 2]);
		await db.insert(printerJobs).values({
			printerId,
			buildId: id,
			plateNumber: 18,
			partSlugs: [H],
			comps: [0, 1, 2],
			status: 'printing',
			startedAt: new Date()
		});
		await printingAction(db, id, 'owner', { action: 'stop', slugs: [H] });
		expect(await first(db.select().from(printerJobs))).toMatchObject({
			buildId: null,
			plateNumber: null,
			partSlugs: null,
			comps: null
		});
		expect((await view(id)).state[H]).toMatchObject({ status: 'To print', printingComps: null });
	});
	it('a status set by hand clears the piece list', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await setPartStatus(db, id, 'owner', H, { status: 'Reprint' });
		expect((await view(id)).state[H]).toMatchObject({ status: 'Reprint', printingComps: null });
	});
});

describe('logging a piece print', () => {
	it('Success ticks those pieces; the part goes back to To print and the log stores them', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		const { runId } = await logPieces(id, [2, 1, 0]);
		const v = await view(id);
		expect(v.state[H]).toMatchObject({ status: 'To print', printingComps: null, startedAt: null });
		expect(await ticked(id)).toEqual([0, 1, 2]);
		const r = v.runs.find((x) => x.id === runId)!;
		expect(r).toMatchObject({ partSlug: H, plateNumber: 18, comps: [0, 1, 2], result: 'Success' });
		expect(nowPrinting(v)).toEqual([]);
		const row = (await acts(id, 'run.add')).at(-1)!;
		expect(describeActivity({ ...row, at: row.at.toISOString(), userName: 'Sam' }, v)).toBe(
			'Sam logged a successful print of 3 pieces of Harness and Straps (plate 18) · 80 g'
		);
	});
	it('the run that ticks the last pieces prints the part', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2, 3]);
		await logPieces(id, [4, 5, 6, 7, 8], 'Success', { date: '2026-01-03' });
		expect((await view(id)).state[H]).toMatchObject({ status: 'Printed', printedOn: '2026-01-03' });
		expect(await ticked(id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
	it('Failed ticks nothing and flags Reprint', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await logPieces(id, [0, 1, 2], 'Failed', { grams: 30 });
		expect((await view(id)).state[H]).toMatchObject({ status: 'Reprint', printingComps: null });
		expect(await ticked(id)).toEqual([]);
		const f = filamentStats(await view(id)).find((x) => x.lostG > 0)!;
		expect(f.lostG).toBe(30);
	});
	it('works as a part log with no plate', async () => {
		const id = await mk();
		await addRun(db, id, 'owner', {
			partSlug: H,
			comps: [0, 1],
			date: '2026-01-02',
			result: 'Success'
		});
		expect(await ticked(id)).toEqual([0, 1]);
	});
	it('a piece run is not a plate run: the plate time and pace are untouched', async () => {
		const id = await mk();
		const before = timeStats(await view(id));
		await logPieces(id, [0, 1, 2]);
		const after = timeStats(await view(id));
		expect(after.totalSec).toBe(before.totalSec);
		// a third of the pieces are ticked: a third of the plate's time is done
		expect(after.leftSec).toBeCloseTo(
			before.leftSec - (await view(id)).plates.find((p) => p.number === 18)!.estSeconds! / 3,
			3
		);
		expect(after.paceRatio).toBeNull();
	});
	it('refuses what is not a valid piece log, with 400', async () => {
		const id = await mk();
		const bad: [string, object][] = [
			['no part', { partSlug: undefined, comps: [0] }],
			['two parts', { partSlugs: [H, 'connectors'] }],
			['a partial', { result: 'Partial' }],
			['a split', { result: 'Partial', split: { keptSlugs: [H], keptGrams: 1, lostGrams: 1 } }],
			['a part not on the plate', { plateNumber: 1 }],
			['an unknown piece', { comps: [99] }],
			['a prototype slug', { partSlug: 'constructor' }]
		];
		for (const [name, over] of bad) {
			expect(
				await status(
					async () =>
						await addRun(db, id, 'owner', {
							plateNumber: 18,
							partSlug: H,
							comps: [0, 1],
							date: '2026-01-02',
							result: 'Success',
							...over
						})
				),
				name
			).toBe(400);
		}
		expect(await db.select().from(printRuns).where(eq(printRuns.buildId, id))).toHaveLength(0);
		expect(
			await status(async () => await logPieces(id, [0, 1], 'Success', { partSlugs: null }))
		).toBe(0);
		expect(
			await status(
				async () =>
					await addRun(db, id, 'viewer', {
						plateNumber: 18,
						partSlug: H,
						comps: [0, 1],
						date: '2026-01-02',
						result: 'Success'
					})
			)
		).toBe(403);
	});
});

describe('a run that does not know about pieces (a printer job finishing)', () => {
	const whole = async (id: string, result: string) =>
		await addRun(db, id, 'owner', { plateNumber: 18, date: '2026-01-02', result, hours: 1 });
	it('Success of the whole plate with a piece print on it ticks only those pieces', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		const { runId } = await whole(id, 'Success');
		const v = await view(id);
		expect(v.runs.find((r) => r.id === runId)).toMatchObject({ partSlug: H, comps: [0, 1, 2] });
		expect(v.state[H]).toMatchObject({ status: 'To print', printingComps: null });
		expect(await ticked(id)).toEqual([0, 1, 2]);
	});
	it('Failed flags Reprint without ticking; Partial just ends the print', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await whole(id, 'Failed');
		expect((await view(id)).state[H].status).toBe('Reprint');
		expect(await ticked(id)).toEqual([]);
		const id2 = await mk();
		await start(id2, [0, 1, 2]);
		await whole(id2, 'Partial');
		expect((await view(id2)).state[H]).toMatchObject({ status: 'To print', printingComps: null });
		expect(await ticked(id2)).toEqual([]);
	});
	it('with no piece print on the part it is the ordinary whole-plate run', async () => {
		const id = await mk();
		await whole(id, 'Success');
		expect((await view(id)).state[H].status).toBe('Printed');
		expect(await ticked(id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe('undo, edit and delete', () => {
	it('undo with the snapshot from before puts the piece print back', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		const before = snapshotParts(await view(id), [H]);
		const { runId } = await logPieces(id, [0, 1, 2]);
		expect(await ticked(id)).toEqual([0, 1, 2]);
		await undoRun(db, id, 'owner', runId, { parts: before });
		const v = await view(id);
		expect(v.state[H]).toMatchObject({ status: 'Printing', printingComps: [0, 1, 2] });
		expect(await ticked(id)).toEqual([]);
		expect(v.runs).toHaveLength(0);
		const row = (await acts(id, 'run.undo')).at(-1)!;
		expect(describeActivity({ ...row, at: row.at.toISOString(), userName: 'Sam' }, v)).toBe(
			'Sam undid a successful print of 3 pieces of Harness and Straps (plate 18)'
		);
	});
	it('undo refuses a snapshot with a bad piece list', async () => {
		const id = await mk();
		const before = snapshotParts(await view(id), [H]);
		const { runId } = await logPieces(id, [0, 1, 2]);
		for (const printingComps of [[99], [0, 0], 'x', [1.5]]) {
			expect(
				await status(
					async () =>
						await undoRun(db, id, 'owner', runId, {
							parts: [{ ...before[0], status: 'Printing', printingComps }]
						})
				)
			).toBe(400);
		}
		expect((await view(id)).runs).toHaveLength(1);
	});
	it('deleting a Success log unticks its pieces and keeps the others', async () => {
		const id = await mk();
		await updatePart(db, id, 'owner', H, { comps: { '8': true } });
		const a = (await logPieces(id, [0, 1, 2])).runId;
		await logPieces(id, [3, 4]);
		await deleteRun(db, id, 'owner', a);
		expect(await ticked(id)).toEqual([3, 4, 8]);
		expect((await view(id)).state[H].status).toBe('To print');
		const row = (await acts(id, 'run.delete')).at(-1)!;
		expect(row.payload).toMatchObject({ comps: [0, 1, 2] });
	});
	it('deleting the run that completed the part sets it back to To print', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2, 3, 4]);
		const last = (await logPieces(id, [5, 6, 7, 8])).runId;
		expect((await view(id)).state[H].status).toBe('Printed');
		await deleteRun(db, id, 'owner', last);
		expect((await view(id)).state[H]).toMatchObject({ status: 'To print', printedOn: null });
		expect(await ticked(id)).toEqual([0, 1, 2, 3, 4]);
	});
	it('editing Success to Failed unticks the pieces and flags Reprint', async () => {
		const id = await mk();
		const a = (await logPieces(id, [0, 1, 2])).runId;
		await updateRun(db, id, 'owner', a, { result: 'Failed' });
		expect((await view(id)).state[H].status).toBe('Reprint');
		expect(await ticked(id)).toEqual([]);
		await updateRun(db, id, 'owner', a, { result: 'Success' });
		expect(await ticked(id)).toEqual([0, 1, 2]);
		expect((await view(id)).state[H].status).toBe('To print');
	});
	it('a piece log cannot be moved to another part', async () => {
		const id = await mk();
		const a = (await logPieces(id, [0, 1, 2])).runId;
		expect(
			await status(async () => await updateRun(db, id, 'owner', a, { partSlug: 'connectors' }))
		).toBe(400);
	});
	it('deleting an old log while another piece print is on the printer leaves that print', async () => {
		const id = await mk();
		const a = (await logPieces(id, [0, 1, 2])).runId;
		await start(id, [3, 4]);
		await deleteRun(db, id, 'owner', a);
		expect((await view(id)).state[H]).toMatchObject({ status: 'Printing', printingComps: [3, 4] });
	});
});

describe('hand ticks and the piece list', () => {
	it('ticking a piece that is on the printer takes it off the list', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		await updatePart(db, id, 'owner', H, { comps: { '1': true } });
		expect((await view(id)).state[H]).toMatchObject({ status: 'Printing', printingComps: [0, 2] });
	});
	it('ticking all of them ends the print: To print, or Printed with every piece ticked', async () => {
		const id = await mk();
		await start(id, [0, 1]);
		await updatePart(db, id, 'owner', H, { comps: { '0': true, '1': true } });
		expect((await view(id)).state[H]).toMatchObject({ status: 'To print', printingComps: null });
		const all = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), true]));
		const id2 = await mk();
		await start(id2, [0, 1]);
		await updatePart(db, id2, 'owner', H, { comps: all });
		expect((await view(id2)).state[H]).toMatchObject({ status: 'Printed', printingComps: null });
	});
	it('ticking with no piece print under way is only a tick, and unticking works', async () => {
		const id = await mk();
		await updatePart(db, id, 'owner', H, { comps: { '3': true } });
		await updatePart(db, id, 'owner', H, { comps: { '3': false } });
		expect(await ticked(id)).toEqual([]);
		expect((await view(id)).state[H].status).toBe('To print');
	});
	it('refuses a ticks object that is not booleans or is huge', async () => {
		const id = await mk();
		expect(
			await status(
				async () => await updatePart(db, id, 'owner', H, { comps: { '0': 'yes' } as never })
			)
		).toBe(400);
		const huge = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), true]));
		expect(await status(async () => await updatePart(db, id, 'owner', H, { comps: huge }))).toBe(
			400
		);
	});
});

describe('a stale piece list (the kit changed under a stored list)', () => {
	const setStale = async (id: string, list: number[]) =>
		await db
			.update(buildParts)
			.set({ status: 'Printing', printingComps: list })
			.where(and(eq(buildParts.buildId, id), eq(buildParts.partSlug, H)));
	it('the plate-level safety net falls back to the plain plate run', async () => {
		const id = await mk();
		await setStale(id, [0, 40]);
		// 40 is no piece of the part, so the valid rest is used...
		await addRun(db, id, 'owner', { plateNumber: 18, date: '2026-01-02', result: 'Success' });
		expect((await view(id)).runs[0].comps).toEqual([0]);
		const id2 = await mk();
		await setStale(id2, [40, 41]);
		// ...and with none valid it is the ordinary whole-plate run, not a 400.
		await addRun(db, id2, 'owner', { plateNumber: 18, date: '2026-01-02', result: 'Success' });
		const v = await view(id2);
		expect(v.runs[0].comps ?? null).toBeNull();
		expect(v.state[H].status).toBe('Printed');
	});
	it('a system log with comps that do not fit is a plain part run; a user request still gets 400', async () => {
		const id = await mk();
		const body = {
			plateNumber: 18,
			partSlug: H,
			comps: [40],
			date: '2026-01-02',
			result: 'Success'
		};
		expect(await status(async () => await addRun(db, id, 'owner', body))).toBe(400);
		expect((await view(id)).runs).toHaveLength(0);
		await addRunSystem(db, id, 'owner', 'Shop printer', body);
		const r = (await view(id)).runs[0];
		expect(r.partSlug).toBe(H);
		expect(r.comps ?? null).toBeNull();
		// a system log that breaks another rule (Partial with comps) is also plain, not an error
		await addRunSystem(db, id, 'owner', 'Shop printer', {
			...body,
			comps: [0, 1],
			result: 'Partial'
		});
		expect((await view(id)).runs).toHaveLength(2);
	});
});

describe('undo snapshot ticks', () => {
	it("keeps only the part's own piece indexes and caps the entries", async () => {
		const id = await mk();
		const before = snapshotParts(await view(id), [H]);
		const { runId } = await logPieces(id, [0, 1, 2]);
		const comps = { '1': true, '2': false, x: true, '-1': true, '9': true, '99': true, '01': true };
		await undoRun(db, id, 'owner', runId, { parts: [{ ...before[0], comps }] });
		expect((await view(id)).state[H].comps).toEqual({ '1': true, '2': false, '01': true });
		const id2 = await mk();
		const r2 = (await logPieces(id2, [0])).runId;
		const huge = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), true]));
		expect(
			await status(
				async () => await undoRun(db, id2, 'owner', r2, { parts: [{ ...before[0], comps: huge }] })
			)
		).toBe(400);
		expect((await view(id2)).runs).toHaveLength(1);
	});
});

describe('pieces a Success log covers are ticked and locked', () => {
	/** A stored part whose ticks lack the logged pieces (what the maintainer saw: a run, no ticks). */
	const wipeTicks = async (id: string) =>
		await db
			.update(buildParts)
			.set({ comps: {} })
			.where(and(eq(buildParts.buildId, id), eq(buildParts.partSlug, H)));
	const storedTicks = async (id: string) => {
		const row = await first(
			db
				.select({ comps: buildParts.comps })
				.from(buildParts)
				.where(and(eq(buildParts.buildId, id), eq(buildParts.partSlug, H)))
		);
		const c = row!.comps as Record<string, boolean>;
		return Object.keys(c)
			.filter((k) => c[k])
			.sort();
	};

	it('a Success piece run with no stored ticks still shows its pieces ticked, and they count', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2], 'Success', { printer: 'CC1', grams: 60.43, hours: 4 });
		await wipeTicks(id);
		expect(await ticked(id)).toEqual([0, 1, 2]);
		expect(loggedPieces(await view(id), H)).toEqual([0, 1, 2]);
		expect(piecesLeft(await view(id), H)).toEqual([3, 4, 5, 6, 7, 8]);
	});
	it('a Failed run covers nothing', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2], 'Failed');
		expect(loggedPieces(await view(id), H)).toEqual([]);
		expect(await ticked(id)).toEqual([]);
	});
	it('editing the log (grams, hours, printer, date, even all at once) keeps the ticks', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		const a = (await logPieces(id, [0, 1, 2])).runId;
		await updateRun(db, id, 'owner', a, { grams: 60.43, hours: 4, printer: 'CC1', note: 'x' });
		expect(await ticked(id)).toEqual([0, 1, 2]);
		await updateRun(db, id, 'owner', a, {
			date: '2026-01-05',
			result: 'Success',
			partSlug: H,
			grams: 61
		});
		expect(await ticked(id)).toEqual([0, 1, 2]);
	});
	it('a hand untick of a logged piece is refused with 400 and a sentence', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2]);
		let err: ApiError | null = null;
		try {
			await updatePart(db, id, 'owner', H, { comps: { '0': false, '1': true, '2': true } });
		} catch (e) {
			err = e as ApiError;
		}
		expect(err?.status).toBe(400);
		expect(err?.message).toBe(
			'Piece 1 is logged in the print log and cannot be unticked; delete or undo that log first'
		);
		expect(await ticked(id)).toEqual([0, 1, 2]);
	});
	it('other pieces stay free to tick and untick, and a map that leaves out logged pieces keeps them', async () => {
		const id = await mk();
		await logPieces(id, [0, 1, 2]);
		await updatePart(db, id, 'owner', H, { comps: { '0': true, '1': true, '2': true, '5': true } });
		expect(await ticked(id)).toEqual([0, 1, 2, 5]);
		await updatePart(db, id, 'owner', H, {
			comps: { '0': true, '1': true, '2': true, '5': false }
		});
		expect(await ticked(id)).toEqual([0, 1, 2]);
		await updatePart(db, id, 'owner', H, { comps: { '7': true } });
		expect(await ticked(id)).toEqual([0, 1, 2, 7]);
		expect(await storedTicks(id)).toEqual(['0', '1', '2', '7']);
	});
	it('deleting the log frees its pieces (and only those)', async () => {
		const id = await mk();
		const a = (await logPieces(id, [0, 1, 2])).runId;
		await updatePart(db, id, 'owner', H, { comps: { '0': true, '1': true, '2': true, '6': true } });
		await wipeTicks(id);
		await deleteRun(db, id, 'owner', a);
		expect(await ticked(id)).toEqual([]);
		expect(loggedPieces(await view(id), H)).toEqual([]);
		await updatePart(db, id, 'owner', H, { comps: { '0': false, '1': true } });
		expect(await ticked(id)).toEqual([1]);
	});
	it('undoing the log frees its pieces', async () => {
		const id = await mk();
		await start(id, [0, 1, 2]);
		const before = snapshotParts(await view(id), [H]);
		const { runId } = await logPieces(id, [0, 1, 2]);
		expect(
			await status(async () => await updatePart(db, id, 'owner', H, { comps: { '1': false } }))
		).toBe(400);
		await undoRun(db, id, 'owner', runId, { parts: before });
		expect(await ticked(id)).toEqual([]);
		expect(loggedPieces(await view(id), H)).toEqual([]);
		await updatePart(db, id, 'owner', H, { comps: { '1': true } });
		await updatePart(db, id, 'owner', H, { comps: { '1': false } });
		expect(await ticked(id)).toEqual([]);
	});
	it('editing the log from Success to Failed frees its pieces', async () => {
		const id = await mk();
		const a = (await logPieces(id, [3, 4])).runId;
		await updateRun(db, id, 'owner', a, { result: 'Failed' });
		await updatePart(db, id, 'owner', H, { comps: { '3': true } });
		await updatePart(db, id, 'owner', H, { comps: { '3': false } });
		expect(await ticked(id)).toEqual([]);
	});
	it('two Success logs lock the union; viewers still cannot tick at all', async () => {
		const id = await mk();
		await logPieces(id, [0, 1]);
		await logPieces(id, [1, 2], 'Success', { date: '2026-01-03' });
		expect(loggedPieces(await view(id), H)).toEqual([0, 1, 2]);
		expect(
			await status(async () => await updatePart(db, id, 'viewer', H, { comps: { '4': true } }))
		).toBe(403);
	});
});
