/**
 * "Print some pieces…" on a printer: an expectation and a job link that carry `comps` (pieces of the
 * job's single part), the finished job's log of exactly those pieces, and the validation of every
 * request field. Harness and Straps (9 pieces) sits alone on plate 18. The printer is a share-link
 * one; nothing here dials out (status is fed to `processStatus` by hand).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { advisoryLock, first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildParts,
	buildPlates,
	builds,
	member,
	organization,
	printRuns,
	printerJobs,
	printers,
	templates,
	user
} from '../db/schema';
import { createBuild } from '../builds/create';
import { printingAction, setPartStatus, updatePart } from '../builds/actions';
import { loadBuildView } from '../builds/view';
import { getExpected, setExpected, setOrgSettings } from '../org-settings';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { plateRunGrams } from '#lib/domain/printer-match.ts';
import {
	checkPieces,
	confirmJobRuns,
	dismissJob,
	expectOnPrinterJob,
	fittingComps,
	linkJob,
	pendingExpected,
	processStatus,
	toJobView,
	unlinkJob
} from './jobs';
import { createPrinter } from './store';

const H = 'harness';
let db: Db;
let buildId: string;
let printerId: string;
const T0 = new Date('2026-11-03T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const printing = (progress: number, elapsedSec: number): PrinterStatus => ({
	state: 'printing',
	progress,
	fileName: 'whatever.gcode',
	elapsedSec,
	remainingSec: 3000,
	layer: 10,
	totalLayers: 100
});
const jobs = async () => await db.select().from(printerJobs);
const view = async () => (await loadBuildView(db, buildId, 'owner'))!;
const runs = async () => await db.select().from(printRuns).where(eq(printRuns.buildId, buildId));
const ticked = async () =>
	Object.entries((await view()).state[H].comps)
		.filter(([, v]) => v)
		.map(([k]) => Number(k))
		.sort((a, b) => a - b);
const code = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		return (e as ApiError).status;
	}
	return 0;
};
/** The job is running and the printer's last status is stored (what a manual link reads). */
const startJob = async (progress = 5, elapsed = 300) => {
	await processStatus(db, printerId, printing(progress, elapsed), at(5));
	await db.update(printers).set({ lastStatus: printing(progress, elapsed) as never });
	return (await jobs())[0].id;
};
const finish = async (state: 'done' | 'failed', progress: number) =>
	await processStatus(
		db,
		printerId,
		{ state, progress, fileName: 'whatever.gcode', layer: 50 },
		at(65)
	);

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db.insert(user).values({ id: 'viewer', name: 'Vic', email: 'v@example.test' });
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const [id, role] of [
		['owner', 'owner'],
		['viewer', 'viewer']
	])
		await db
			.insert(member)
			.values({ id: `m-${id}`, organizationId: 'org1', userId: id, role, createdAt: new Date() });
	const templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	buildId = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'Columbus' },
		'owner'
	);
	await db
		.update(builds)
		.set({ printer: printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 1) })
		.where(eq(builds.id, buildId));
	printerId = (
		await createPrinter(db, 'org1', 'owner', {
			name: 'Shop Centauri',
			kind: 'elegoo-sdcp',
			secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
			catalogId: 'elegoo-centauri-carbon'
		})
	).id;
});

const link = async (jobId: string, comps?: unknown, slugs: unknown = [H]) =>
	await linkJob(db, jobId, 'org1', 'owner', buildId, 18, slugs, comps);

describe('expectation with pieces', () => {
	it('is stored, bound to the running job, reported with comps and links with them', async () => {
		const jobId = await startJob();
		// The client marks the pieces first (start with comps), then sends the expectation.
		await printingAction(db, buildId, 'owner', {
			action: 'start',
			slugs: [H],
			comps: [0, 1, 4],
			printer: 'Shop Centauri'
		});
		await expectOnPrinterJob(db, printerId, {
			buildId,
			plate: 18,
			partSlugs: [H],
			comps: [0, 1, 4]
		});
		expect(await getExpected(db, 'org1', printerId)).toMatchObject({ comps: [0, 1, 4], jobId });
		const [exp] = await pendingExpected(db, 'org1', buildId);
		expect(exp).toMatchObject({ plateNumber: 18, partSlugs: [H], comps: [0, 1, 4], jobId });
		await link(exp.jobId, exp.comps ?? undefined, exp.partSlugs);
		expect((await jobs())[0]).toMatchObject({
			buildId,
			plateNumber: 18,
			partSlugs: [H],
			comps: [0, 1, 4]
		});
		expect((await view()).state[H]).toMatchObject({ status: 'Printing', printingComps: [0, 1, 4] });
		expect(await getExpected(db, 'org1', printerId)).toBeNull();
		expect(toJobView((await jobs())[0], 'Shop Centauri').comps).toEqual([0, 1, 4]);
	});
	it('a whole-part expectation has no comps', async () => {
		await startJob();
		await expectOnPrinterJob(db, printerId, { buildId, plate: 18, partSlugs: [H] });
		expect((await pendingExpected(db, 'org1', buildId))[0].comps).toBeNull();
	});
});

describe('linking a job with pieces', () => {
	it('marks the part Printing with just those pieces, the job start and estimate on the part', async () => {
		const jobId = await startJob();
		await link(jobId, [2, 0]);
		expect((await jobs())[0].comps).toEqual([0, 2]);
		const st = (await view()).state[H];
		expect(st).toMatchObject({ status: 'Printing', printingComps: [0, 2] });
		expect(st.startedAt).toBeTruthy();
		expect(st.runEstSeconds).toBeGreaterThan(0);
		// the printer's time is that of some pieces: it never becomes the plate's own time
		const plate = (await first(
			db
				.select()
				.from(buildPlates)
				.where(and(eq(buildPlates.buildId, buildId), eq(buildPlates.number, 18)))
		))!;
		expect(plate.manualEstSeconds).toBeNull();
	});
	it('a piece print marked first and then linked by hand keeps its pieces', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: [H], comps: [1, 3] });
		await link(await startJob(), undefined);
		expect((await jobs())[0].comps).toEqual([1, 3]);
		expect((await view()).state[H].printingComps).toEqual([1, 3]);
	});
	it('re-linking with other pieces changes the list on the part too', async () => {
		const jobId = await startJob();
		await link(jobId, [0, 1]);
		await link(jobId, [2, 3, 4]);
		expect((await jobs())[0].comps).toEqual([2, 3, 4]);
		expect((await view()).state[H].printingComps).toEqual([2, 3, 4]);
	});
	it('every piece still to print is a whole-part link', async () => {
		await updatePart(db, buildId, 'owner', H, { comps: { '0': true } });
		await link(await startJob(), [1, 2, 3, 4, 5, 6, 7, 8]);
		expect((await jobs())[0].comps).toBeNull();
		expect((await view()).state[H].printingComps ?? null).toBeNull();
	});
	it('a whole-part job is unchanged: no comps anywhere', async () => {
		await link(await startJob());
		expect((await jobs())[0]).toMatchObject({ buildId, partSlugs: [H], comps: null });
		expect((await view()).state[H]).toMatchObject({ status: 'Printing' });
		expect((await view()).state[H].printingComps ?? null).toBeNull();
	});
	it('unlinking clears the job pieces (the part stays on the printer with its list)', async () => {
		const jobId = await startJob();
		await link(jobId, [0, 1]);
		await unlinkJob(db, jobId, 'org1');
		expect((await jobs())[0]).toMatchObject({ buildId: null, partSlugs: null, comps: null });
		expect((await view()).state[H]).toMatchObject({ status: 'Printing', printingComps: [0, 1] });
	});
});

describe('finishing a piece job', () => {
	const arrange = async (comps = [0, 1, 2]) => {
		const jobId = await startJob();
		await link(jobId, comps);
		return jobId;
	};
	it('Confirm print log logs a run of exactly those pieces and ticks only them', async () => {
		const jobId = await arrange();
		await finish('done', 100);
		const r = await confirmJobRuns(db, jobId, 'org1', 'owner', { result: 'Success' });
		expect(await runs()).toHaveLength(1);
		expect((await runs())[0]).toMatchObject({
			partSlug: H,
			partSlugs: null,
			comps: [0, 1, 2],
			plateNumber: 18,
			result: 'Success'
		});
		expect(r.runIds).toHaveLength(1);
		expect(await ticked()).toEqual([0, 1, 2]);
		expect((await view()).state[H]).toMatchObject({ status: 'To print', printingComps: null });
	});
	it('the last pieces make the part Printed', async () => {
		const jobId = await arrange();
		await updatePart(db, buildId, 'owner', H, {
			comps: Object.fromEntries([3, 4, 5, 6, 7, 8].map((i) => [String(i), true]))
		});
		await finish('done', 100);
		await confirmJobRuns(db, jobId, 'org1', 'owner', {});
		expect(await ticked()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect((await view()).state[H].status).toBe('Printed');
	});
	it('logs automatically with the team setting, still only those pieces', async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true } as never);
		await arrange([5, 6]);
		await finish('done', 100);
		expect(await runs()).toHaveLength(1);
		expect((await runs())[0]).toMatchObject({ comps: [5, 6], partSlug: H, partSlugs: null });
		expect(await ticked()).toEqual([5, 6]);
	});
	it("the grams are the pieces' share, not the whole part", async () => {
		const whole = plateRunGrams(await view(), 18, [H]);
		await arrange([0, 1, 2]);
		const share = plateRunGrams(await view(), 18, [H]);
		expect(whole).toBeGreaterThan(0);
		expect(share).toBeCloseTo(whole! / 3, 5);
	});
	it('a failed job logs Failed with the pieces: nothing is ticked', async () => {
		const jobId = await arrange();
		await finish('failed', 40);
		await confirmJobRuns(db, jobId, 'org1', 'owner', {});
		expect((await runs())[0]).toMatchObject({ result: 'Failed', comps: [0, 1, 2] });
		expect(await ticked()).toEqual([]);
		expect((await view()).state[H].printingComps ?? null).toBeNull();
	});
	it('a cancelled job ticks nothing; "Don\'t log" returns the part with no list', async () => {
		const jobId = await arrange();
		await processStatus(
			db,
			printerId,
			{ state: 'idle', progress: null, fileName: '', layer: 50 },
			at(40)
		);
		expect((await jobs())[0].status).toBe('cancelled');
		await dismissJob(db, jobId, 'org1', 'owner');
		expect(await runs()).toHaveLength(0);
		expect(await ticked()).toEqual([]);
		expect((await view()).state[H]).toMatchObject({ status: 'To print', printingComps: null });
	});
	it('a job cancelled at 0% logs nothing and releases the part', async () => {
		const early = (state: PrinterStatus['state']): PrinterStatus => ({
			state,
			progress: 0,
			fileName: state === 'idle' ? '' : 'whatever.gcode',
			elapsedSec: 30,
			layer: 1
		});
		await processStatus(db, printerId, early('printing'), at(5));
		await link((await jobs())[0].id, [0, 1, 2]);
		await processStatus(db, printerId, early('idle'), at(6));
		expect(await runs()).toHaveLength(0);
		expect((await view()).state[H]).toMatchObject({ status: 'To print', printingComps: null });
	});
	it('Partial (or a split) for a piece job is refused', async () => {
		const jobId = await arrange();
		await finish('done', 100);
		expect(
			await code(() => confirmJobRuns(db, jobId, 'org1', 'owner', { result: 'Partial' }))
		).toBe(400);
		expect(
			await code(() =>
				confirmJobRuns(db, jobId, 'org1', 'owner', {
					result: 'Success',
					split: { keptSlugs: [H], keptGrams: 1, lostGrams: 1 }
				})
			)
		).toBe(400);
		expect(await runs()).toHaveLength(0);
	});
});

describe('validation', () => {
	it.each([
		['out of range', [0, 9]],
		['negative', [-1, 0]],
		['not a whole number', [0.5, 1]],
		['not a number', ['0', 1]],
		['listed twice', [1, 1]],
		['empty', []],
		['not a list', 'all'],
		['every piece of the part', [0, 1, 2, 3, 4, 5, 6, 7, 8]]
	])('refuses pieces that are %s', async (_n, comps) => {
		const id = await startJob();
		expect(await code(() => link(id, comps))).toBe(400);
		expect(await code(async () => checkPieces(await view(), 18, [H], comps))).toBe(400);
		expect((await jobs())[0]).toMatchObject({ buildId: null, comps: null });
	});
	it('refuses a list that is too long before walking it', async () => {
		expect(
			await code(async () =>
				checkPieces(
					await view(),
					18,
					[H],
					Array.from({ length: 300 }, (_, i) => i)
				)
			)
		).toBe(400);
	});
	it('refuses a piece that is already ticked', async () => {
		await updatePart(db, buildId, 'owner', H, { comps: { '2': true } });
		expect(await code(async () => link(await startJob(), [1, 2]))).toBe(400);
	});
	it('refuses pieces without exactly one part', async () => {
		const id = await startJob();
		expect(await code(() => link(id, [0, 1], null))).toBe(400);
		expect(await code(() => link(id, [0, 1], [H, 'handle-left']))).toBe(400);
		expect(await code(async () => checkPieces(await view(), 18, [H, 'x'], [0]))).toBe(400);
	});
	it('refuses a part with no separate pieces', async () => {
		const v = await view();
		const other = v.parts.find((p) => p.components.length < 2)!;
		const plate = v.plates.find((p) => p.parts.includes(other.slug))!;
		expect(await code(() => checkPieces(v, plate.number, [other.slug], [0]))).toBe(400);
	});
	it('refuses a plate that prints more than once or one part per run', async () => {
		for (const set of [{ runs: 2 }, { perPartRuns: true }]) {
			await db
				.update(buildPlates)
				.set(set)
				.where(and(eq(buildPlates.buildId, buildId), eq(buildPlates.number, 18)));
			expect(
				await code(async () => checkPieces(await view(), 18, [H], [0, 1])),
				JSON.stringify(set)
			).toBe(400);
			await db
				.update(buildPlates)
				.set({ runs: 1, perPartRuns: false })
				.where(and(eq(buildPlates.buildId, buildId), eq(buildPlates.number, 18)));
		}
	});
	it('refuses a part that is already Printed', async () => {
		await setPartStatus(db, buildId, 'owner', H, { status: 'Printed' });
		expect(await code(async () => checkPieces(await view(), 18, [H], [0, 1]))).toBe(400);
	});
	it('stays out of a draft', async () => {
		const templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
		const draft = await createBuild(
			db,
			{ organizationId: 'org1', templateId, designId: null, name: 'D', kind: 'draft' },
			'owner'
		);
		expect(
			await code(async () => linkJob(db, await startJob(), 'org1', 'owner', draft, 18, [H], [0, 1]))
		).toBe(400);
		expect((await jobs())[0].comps).toBeNull();
	});
	it('a viewer cannot link pieces (the build lock refuses a role that cannot edit)', async () => {
		const id = await startJob();
		expect(await code(() => linkJob(db, id, 'org1', 'viewer', buildId, 18, [H], [0, 1]))).toBe(403);
		expect((await jobs())[0]).toMatchObject({ buildId: null, comps: null });
	});
	it("a list from another build's team is never validated: the build must belong to the team", async () => {
		await db
			.insert(organization)
			.values({ id: 'org2', name: 'Other', slug: 'other', createdAt: new Date() });
		const id = await startJob();
		expect(await code(() => linkJob(db, id, 'org2', 'owner', buildId, 18, [H], [0, 1]))).toBe(404);
	});
});

describe('the locked view', () => {
	it('fittingComps is pure: a sorted copy when it fits, null otherwise', async () => {
		const v = await view();
		expect(fittingComps(v, [H], [3, 1])).toEqual([1, 3]);
		expect(fittingComps(v, [H], [1, 40])).toBeNull();
		expect(fittingComps(v, [H, 'x'], [1])).toBeNull();
		expect(fittingComps(v, [H], null)).toBeNull();
		expect(
			fittingComps(
				v,
				[H],
				Array.from({ length: 500 }, (_, i) => i)
			)
		).toBeNull();
	});
	it('a piece ticked between validation and the lock refuses the link (409) and writes nothing', async () => {
		const jobId = await startJob();
		let release!: () => void;
		let locked!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const gotLock = new Promise<void>((r) => (locked = r));
		// Another request holds the build lock and ticks piece 2.
		const other = db.transaction(async (tx) => {
			await advisoryLock(tx, `build:${buildId}`);
			locked();
			await tx
				.update(buildParts)
				.set({ comps: { '2': true } })
				.where(and(eq(buildParts.buildId, buildId), eq(buildParts.partSlug, H)));
			await hold;
		});
		await gotLock;
		// Validated on the view loaded before the tick, then waits for the lock.
		const linking = code(() => link(jobId, [1, 2]));
		await new Promise((r) => setTimeout(r, 300));
		release();
		await other;
		expect(await linking).toBe(409);
		expect((await jobs())[0]).toMatchObject({ buildId: null, comps: null });
		expect((await view()).state[H].printingComps ?? null).toBeNull();
	});
	it('a refused link (409) leaves the pending expectation in place; a retry that fits links and clears it', async () => {
		const jobId = await startJob();
		await expectOnPrinterJob(db, printerId, {
			buildId,
			plate: 18,
			partSlugs: [H],
			comps: [1, 2]
		});
		expect(await getExpected(db, 'org1', printerId)).toMatchObject({ comps: [1, 2], jobId });
		let release!: () => void;
		let locked!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const gotLock = new Promise<void>((r) => (locked = r));
		const other = db.transaction(async (tx) => {
			await advisoryLock(tx, `build:${buildId}`);
			locked();
			await tx
				.update(buildParts)
				.set({ comps: { '2': true } })
				.where(and(eq(buildParts.buildId, buildId), eq(buildParts.partSlug, H)));
			await hold;
		});
		await gotLock;
		const linking = code(() => link(jobId, [1, 2]));
		await new Promise((r) => setTimeout(r, 300));
		release();
		await other;
		expect(await linking).toBe(409);
		expect(await getExpected(db, 'org1', printerId)).toMatchObject({ comps: [1, 2], jobId });
		// retry with a list that fits
		expect(await code(() => link(jobId, [1, 3]))).toBe(0);
		expect((await jobs())[0]).toMatchObject({ buildId, comps: [1, 3] });
		expect(await getExpected(db, 'org1', printerId)).toBeNull();
	});
	it('two links and a hand tick racing never leave a ticked piece on the printer', async () => {
		const jobId = await startJob();
		await Promise.all([
			code(() => link(jobId, [1, 2, 3])),
			code(() => link(jobId, [2, 4])),
			code(() => updatePart(db, buildId, 'owner', H, { comps: { '2': true } }))
		]);
		const st = (await view()).state[H];
		const have = st.printingComps ?? null;
		const job = (await jobs())[0];
		expect((have ?? []).filter((i) => st.comps[String(i)])).toEqual([]);
		expect(job.buildId && st.status === 'Printing' ? (job.comps ?? null) : have).toEqual(have);
	});
});

describe('a stored piece list that no longer fits the part', () => {
	// A kit update left the job's list pointing at pieces the part no longer has.
	const staleJob = async () => {
		const jobId = await startJob();
		await linkJob(db, jobId, 'org1', 'owner', buildId, 18, [H], [0, 1, 2]);
		await db
			.update(printerJobs)
			.set({ comps: [0, 40] })
			.where(eq(printerJobs.id, jobId));
		// (the part's own list is cleared so only the job's stale list is under test)
		await db
			.update(buildParts)
			.set({ printingComps: null })
			.where(and(eq(buildParts.buildId, buildId), eq(buildParts.partSlug, H)));
		return jobId;
	};
	const doneActivity = async () =>
		(await db.select().from(activity).where(eq(activity.buildId, buildId))).filter(
			(a) => a.kind === 'printer.job.done'
		);
	it('auto-log falls back to one plain run, without throwing, and writes the activity', async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true } as never);
		await staleJob();
		await expect(finish('done', 100)).resolves.not.toThrow();
		expect(await runs()).toHaveLength(1);
		expect((await runs())[0].comps).toBeNull();
		expect(await doneActivity()).toHaveLength(1);
	});
	it('confirm logs a plain run too', async () => {
		const jobId = await staleJob();
		await finish('done', 100);
		expect(await doneActivity()).toHaveLength(1);
		await confirmJobRuns(db, jobId, 'org1', 'owner', {});
		expect(await runs()).toHaveLength(1);
		expect((await runs())[0].comps).toBeNull();
	});
	it('a stale expectation links the part without pieces; a typed bad list is still refused', async () => {
		const jobId = await startJob();
		await setExpected(db, 'org1', printerId, {
			buildId,
			plate: 18,
			partSlugs: [H],
			comps: [0, 40],
			jobId,
			at: Date.now()
		});
		expect(await code(() => link(jobId, [0, 41]))).toBe(400);
		await link(jobId, [0, 40]);
		expect((await jobs())[0]).toMatchObject({ buildId, partSlugs: [H], comps: null });
	});
});
