import { ApiError } from '../access';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import type { PrinterStatus } from '#lib/printers/status.ts';
import { first, type Db } from '../db';
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
import { addRun, deleteRun, printingAction, updatePlate } from '../builds/actions';
import { sanePrintSeconds } from '#lib/domain/format.ts';
import { filamentStats } from '#lib/domain/accounting.ts';
import { loadBuildView } from '../builds/view';
import { nowPrinting } from '#lib/domain/now.ts';
import { onBuildEvents } from '../builds/test-helpers';
import { getExpected, setExpected, setOrgSettings } from '../org-settings';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { subscribePrinterEvents } from './bus';
import {
	buildJobs,
	confirmJob,
	confirmJobRuns,
	dismissJob,
	expectOnPrinterJob,
	linkJob,
	pendingExpected,
	processStatus,
	teamJobs
} from './jobs';
import { Supervisor } from './supervisor';
import { createPrinter } from './store';
import type { ConnectFn, StatusCallback } from './types';

let db: Db;
let buildId: string;
let printerId: string;
const T0 = new Date('2026-11-03T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const printing = (
	file: string,
	progress: number,
	elapsedSec: number,
	extra: Partial<PrinterStatus> = {}
): PrinterStatus => ({
	state: 'printing',
	progress,
	fileName: file,
	elapsedSec,
	remainingSec: 3000,
	layer: 10,
	totalLayers: 100,
	...extra
});
const jobs = async () => await db.select().from(printerJobs);
const partStatus = async (slug: string) =>
	(await first(db.select().from(buildParts).where(eq(buildParts.partSlug, slug))))!.status;

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(member).values({
		id: 'm1',
		organizationId: 'org1',
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
	const templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	buildId = await createBuild(
		db,
		{
			organizationId: 'org1',
			templateId,
			designId: null,
			name: 'Columbus'
		},
		'owner'
	);
	// Plan the build for this printer without re-arranging the template's plates.
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

describe('job lifecycle', () => {
	it('links by file name, resumes, finishes and waits for confirmation', async () => {
		const ev = onBuildEvents(buildId);
		const file = 'Plate 1 - Handle Left.gcode';
		await processStatus(db, printerId, printing(file, 5, 300), at(5));
		let [j] = await jobs();
		expect(await jobs()).toHaveLength(1);
		expect(j).toMatchObject({ buildId, plateNumber: 1, status: 'printing' });
		expect(j.partSlugs).toEqual(['handle-left']);
		expect(j.startedAt!.getTime()).toBe(at(0).getTime());
		expect(await partStatus('handle-left')).toBe('Printing');
		expect(ev.some((e) => e.kind === 'printer.job.start')).toBe(true);

		// More statuses, and a "restart" (same status again) keep one job.
		await processStatus(db, printerId, printing(file, 40, 1500), at(25));
		await processStatus(db, printerId, printing(file, 40, 1500), at(25));
		expect(await jobs()).toHaveLength(1);
		expect((await jobs())[0].progress).toBe(40);
		expect(await buildJobs(db, buildId, 'org1')).toHaveLength(1);

		await processStatus(
			db,
			printerId,
			{ state: 'done', progress: 100, fileName: file, elapsedSec: 3600 },
			at(60)
		);
		[j] = await jobs();
		expect(j.status).toBe('done');
		expect(j.runId).toBeNull();
		expect(await db.select().from(printRuns)).toHaveLength(0);
		const pending = await buildJobs(db, buildId, 'org1');
		expect(pending[0].pendingConfirm).toBe(true);
		expect(
			await first(db.select().from(activity).where(eq(activity.kind, 'printer.job.done')))
		).toBeTruthy();

		// Same "done" status again must not create or change anything.
		await processStatus(db, printerId, { state: 'done', progress: 100, fileName: file }, at(61));
		expect(await jobs()).toHaveLength(1);

		const runId = await confirmJob(db, j.id, 'org1', 'owner', { result: 'Success', grams: 33 });
		const run = (await first(db.select().from(printRuns)))!;
		expect(run).toMatchObject({
			id: runId,
			plateNumber: 1,
			result: 'Success',
			grams: 33,
			printer: 'Shop Centauri'
		});
		expect(run.hours).toBe(1);
		expect(await partStatus('handle-left')).toBe('Printed');
		expect(await buildJobs(db, buildId, 'org1')).toHaveLength(0);
		await expect(confirmJob(db, j.id, 'org1', 'owner', {})).rejects.toThrow(/already logged/);
	});

	it('logs automatically when the team setting is on', async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true });
		await updatePlate(db, buildId, 'owner', 1, { slicerGrams: 41 });
		const file = 'TMT-Columbus-Elegoo-plain-plate1.3mf';
		await processStatus(db, printerId, printing(file, 10, 600), at(10));
		await processStatus(
			db,
			printerId,
			{ state: 'done', progress: 100, fileName: file, elapsedSec: 5400 },
			at(90)
		);
		const run = (await first(db.select().from(printRuns)))!;
		expect(run).toMatchObject({
			plateNumber: 1,
			result: 'Success',
			grams: 41,
			userId: null,
			printer: 'Shop Centauri'
		});
		expect(run.hours).toBe(1.5);
		expect((await jobs())[0].runId).toBe(run.id);
		expect(await partStatus('handle-left')).toBe('Printed');
		const act = (await first(
			db.select().from(activity).where(eq(activity.kind, 'printer.job.done'))
		))!;
		expect(act.userId).toBeNull();
		expect(act.payload).toMatchObject({ auto: true, grams: 41, by: 'Shop Centauri' });
		expect(await buildJobs(db, buildId, 'org1')).toHaveLength(0);
	});

	it('never auto-logs a failed or stopped print: it asks', async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true });
		const file = 'Plate 2 - Handle Right.gcode';
		await processStatus(db, printerId, printing(file, 20, 600), at(10));
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 22, fileName: file },
			at(20)
		);
		expect((await jobs())[0].status).toBe('cancelled');
		expect(await db.select().from(printRuns)).toHaveLength(0);
		const [pending] = await buildJobs(db, buildId, 'org1');
		expect(pending.pendingConfirm).toBe(true);
		await dismissJob(db, pending.id, 'org1');
		expect(await buildJobs(db, buildId, 'org1')).toHaveLength(0);
		expect(await db.select().from(printRuns)).toHaveLength(0);
	});

	it('leaves unlinked jobs for a manual link, which also starts the parts', async () => {
		await processStatus(db, printerId, printing('benchy.gcode', 5, 300), at(5));
		const [j] = await jobs();
		expect(j.buildId).toBeNull();
		expect((await buildJobs(db, buildId, 'org1')).map((x) => x.id)).toEqual([j.id]); // offered for linking
		await db.update(printers).set({ lastStatus: printing('benchy.gcode', 5, 300) as never });
		await linkJob(db, j.id, 'org1', 'owner', buildId, 2);
		expect((await jobs())[0]).toMatchObject({ buildId, plateNumber: 2 });
		expect(await partStatus('handle-right')).toBe('Printing');
		const view = (await loadBuildView(db, buildId, 'owner'))!;
		expect(view.state['handle-right'].startedAt).toBe(at(0).toISOString());
		expect(view.state['handle-right'].runEstSeconds).toBe(3300);
		expect(
			await first(db.select().from(activity).where(eq(activity.kind, 'printer.job.link')))
		).toBeTruthy();
	});

	it('never guesses: one plate marked Printing does not attach a job with an unrelated file name', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['wing-left'] });
		await processStatus(db, printerId, printing('mystery.gcode', 3, 100), at(3));
		expect((await jobs())[0].buildId).toBeNull();
		expect(await partStatus('wing-left')).toBe('Printing');
	});

	it('does not guess when two plates are marked Printing', async () => {
		await printingAction(db, buildId, 'owner', {
			action: 'start',
			slugs: ['wing-left', 'wing-right']
		});
		await processStatus(db, printerId, printing('mystery.gcode', 3, 100), at(3));
		expect((await jobs())[0].buildId).toBeNull();
	});

	it('a different file ends the previous job; elapsed time starting over is a new run', async () => {
		await processStatus(db, printerId, printing('a.gcode', 50, 3000), at(50));
		await processStatus(db, printerId, printing('b.gcode', 1, 60), at(52));
		expect((await jobs()).map((j) => j.status).sort()).toEqual(['cancelled', 'printing']);
		await processStatus(db, printerId, printing('b.gcode', 60, 3600), at(112)); // same file, still going: same job
		expect(await jobs()).toHaveLength(2);
		await processStatus(db, printerId, printing('b.gcode', 1, 30), at(200)); // elapsed started over: new run
		expect(await jobs()).toHaveLength(3);
	});

	it('goes idle after a run: counts as done when it was nearly finished', async () => {
		await processStatus(db, printerId, printing('Plate 1 - Handle Left.gcode', 99, 3000), at(50));
		await processStatus(db, printerId, { state: 'idle', progress: null }, at(55));
		expect((await jobs())[0].status).toBe('done');
	});

	it('offline does not end a job', async () => {
		await processStatus(db, printerId, printing('a.gcode', 30, 1000), at(20));
		await processStatus(db, printerId, { state: 'offline', progress: null }, at(21));
		expect((await jobs())[0].status).toBe('printing');
	});
});

describe('manual log paths next to a linked printer', () => {
	it('manual run for the same plate still works', async () => {
		await expect(
			addRun(db, buildId, 'owner', {
				plateNumber: 1,
				date: '2026-11-03',
				result: 'Success',
				grams: 10
			})
		).resolves.not.toThrow();
	});
});

describe('supervisor', () => {
	it('mirrors adapter statuses into the database, throttles writes and feeds the lifecycle', async () => {
		const cbs: StatusCallback[] = [];
		let closed = 0;
		const fake: ConnectFn = () => ({
			status$: (cb) => {
				cbs.push(cb);
				return () => {};
			},
			close: () => void closed++
		});
		const events: string[] = [];
		subscribePrinterEvents('org1', (e) => events.push(e.type));
		const sup = new Supervisor(
			db,
			{ 'elegoo-sdcp': fake, moonraker: fake, octoprint: fake, manual: fake },
			60_000
		);
		await sup.start();
		expect(sup.size).toBe(1);
		const emit = async (s: PrinterStatus) => {
			cbs[0](s);
			await sup.idle(); // statuses are handled asynchronously, one at a time
		};

		await emit({ state: 'idle', progress: null });
		let row = (await first(db.select().from(printers)))!;
		expect((row.lastStatus as { state: string }).state).toBe('idle');
		expect(row.lastSeenAt).toBeTruthy();

		await emit(printing('Plate 1 - Handle Left.gcode', 1, 60));
		await emit(printing('Plate 1 - Handle Left.gcode', 2, 120)); // throttled: same state/file, < 60 s
		row = (await first(db.select().from(printers)))!;
		expect((row.lastStatus as { progress: number }).progress).toBe(1);
		expect(await jobs()).toHaveLength(1);
		expect(events.filter((e) => e === 'status')).toHaveLength(3);
		expect(events).toContain('job');

		// Offline is stored but does not move last_seen_at.
		const seen = row.lastSeenAt!.getTime();
		await emit({ state: 'offline', progress: null });
		row = (await first(db.select().from(printers)))!;
		expect((row.lastStatus as { state: string }).state).toBe('offline');
		expect(row.lastSeenAt!.getTime()).toBe(seen);

		await sup.refresh(printerId);
		expect(closed).toBe(1);
		await db.update(printers).set({ enabled: false }).where(eq(printers.id, printerId));
		await sup.refresh(printerId);
		expect(sup.size).toBe(0);
		sup.stop();
	});
});

describe('per-part runs (wheel rims: one color per print)', () => {
	const FILE = 'Plate 13 - Wheel Rim.gcode';
	const jobPartSlugs = async () => (await jobs())[0].partSlugs;
	const startUnlinked = async () => {
		await processStatus(db, printerId, printing('benchy.gcode', 5, 300), at(5));
		await db.update(printers).set({ lastStatus: printing('benchy.gcode', 5, 300) as never });
		return (await jobs())[0].id;
	};

	it('auto-link picks one part, not the whole plate', async () => {
		await processStatus(db, printerId, printing(FILE, 5, 300), at(5));
		expect((await jobs())[0]).toMatchObject({ buildId, plateNumber: 13 });
		expect(await jobPartSlugs()).toEqual(['rims-1-4']);
		expect(await partStatus('rims-1-4')).toBe('Printing');
		expect(await partStatus('rims-2-3')).toBe('To print');
	});

	it('auto-link uses the part that is already Printing', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['rims-2-3'] });
		await processStatus(db, printerId, printing(FILE, 5, 300), at(5));
		expect(await jobPartSlugs()).toEqual(['rims-2-3']);
		expect(await partStatus('rims-1-4')).toBe('To print');
	});

	it('links with chosen partSlugs and rejects bad ones', async () => {
		const id = await startUnlinked();
		for (const bad of [[], ['handle-left'], ['rims-1-4', 'nope'], 'rims-1-4', [3]])
			await expect(linkJob(db, id, 'org1', 'owner', buildId, 13, bad)).rejects.toThrow(/partSlugs/);
		expect((await jobs())[0].buildId).toBeNull();
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-2-3']);
		expect(await jobPartSlugs()).toEqual(['rims-2-3']);
		expect(await partStatus('rims-2-3')).toBe('Printing');
		expect(await partStatus('rims-1-4')).toBe('To print');
	});

	it('changing the parts moves Printing to the new part', async () => {
		const id = await startUnlinked();
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-2-3']);
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-1-4']);
		expect(await jobPartSlugs()).toEqual(['rims-1-4']);
		expect(await partStatus('rims-1-4')).toBe('Printing');
		expect(await partStatus('rims-2-3')).toBe('To print');
		expect(
			await db.select().from(activity).where(eq(activity.kind, 'printer.job.link'))
		).toHaveLength(2);
	});

	it('an expectation with partSlugs becomes a suggestion for that part; confirming links it', async () => {
		await setExpected(db, 'org1', printerId, {
			buildId,
			plate: 13,
			partSlugs: ['rims-2-3'],
			at: Date.now()
		});
		await processStatus(db, printerId, printing('whatever.gcode', 5, 300), at(5));
		expect((await jobs())[0].buildId).toBeNull();
		const [exp] = await pendingExpected(db, 'org1', buildId);
		expect(exp).toMatchObject({
			printerId,
			plateNumber: 13,
			partSlugs: ['rims-2-3'],
			jobId: (await jobs())[0].id
		});
		await db.update(printers).set({ lastStatus: printing('whatever.gcode', 5, 300) as never });
		await linkJob(
			db,
			(await jobs())[0].id,
			'org1',
			'owner',
			buildId,
			exp.plateNumber,
			exp.partSlugs ?? undefined
		);
		expect((await jobs())[0]).toMatchObject({ buildId, plateNumber: 13 });
		expect(await jobPartSlugs()).toEqual(['rims-2-3']);
		expect(await getExpected(db, 'org1', printerId)).toBeNull();
		expect(await pendingExpected(db, 'org1', buildId)).toEqual([]);
	});

	it('wheel regression: after a wheel run the next unrelated job is not auto-linked (auto-log on and off)', async () => {
		for (const auto of [true, false]) {
			await db.delete(printerJobs);
			await setOrgSettings(db, 'org1', { autoLogPrints: auto });
			await processStatus(db, printerId, printing(FILE, 5, 300), at(5));
			expect((await jobs())[0]).toMatchObject({ plateNumber: 13 });
			await processStatus(
				db,
				printerId,
				{ state: 'done', progress: 100, fileName: FILE, elapsedSec: 7200 },
				at(130)
			);
			// One of two runs for that part: Printing is still set on it (the old fallback keyed on this).
			await processStatus(
				db,
				printerId,
				printing('ECC_0.4_tmt_4691_Overture PETG HF_0.2_11h1m.gcode', 2, 100),
				at(200)
			);
			const next = (await jobs()).find((j) => j.fileName.startsWith('ECC_'))!;
			expect(next.buildId, `auto-log ${auto}`).toBeNull();
			expect(next.plateNumber).toBeNull();
			await processStatus(db, printerId, { state: 'idle', progress: null }, at(210));
		}
	});
	it("finish logs a run only for the chosen part, with that part's grams", async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true });
		await updatePlate(db, buildId, 'owner', 13, {
			slicerByPart: { 'rims-1-4': 140, 'rims-2-3': 148 }
		});
		const id = await startUnlinked();
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-2-3']);
		await processStatus(
			db,
			printerId,
			{ state: 'done', progress: 100, fileName: 'benchy.gcode', elapsedSec: 7200 },
			at(130)
		);
		const runs = await db.select().from(printRuns);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			plateNumber: 13,
			partSlug: 'rims-2-3',
			partSlugs: null,
			grams: 148,
			result: 'Success'
		});
		// One of two runs for that part: still Printing; the other part untouched.
		expect(await partStatus('rims-2-3')).toBe('Printing');
		expect(await partStatus('rims-1-4')).toBe('To print');
	});

	it('dismissing a stopped print puts its parts back from Printing', async () => {
		await printingAction(db, buildId, 'owner', {
			action: 'start',
			slugs: ['rims-1-4', 'rims-2-3']
		});
		await processStatus(db, printerId, printing(FILE, 5, 300), at(5));
		// Both were Printing already; the job covers whatever it linked.
		const covered = (await jobPartSlugs())!;
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 9, fileName: FILE },
			at(20)
		);
		expect((await jobs())[0].status).toBe('cancelled');
		// Not released before the prompt is dismissed (the user may still log it).
		for (const s of covered) expect(await partStatus(s)).toBe('Printing');
		await dismissJob(db, (await jobs())[0].id, 'org1', 'owner');
		expect((await jobs())[0].runId).toBe('dismissed');
		for (const s of covered) expect(await partStatus(s)).toBe('To print');
		expect(
			await db.select().from(activity).where(eq(activity.kind, 'printer.job.release'))
		).toHaveLength(1);
	});

	it('dismissing keeps parts that another active job still covers', async () => {
		const id = await startUnlinked();
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-1-4']);
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 9, fileName: 'benchy.gcode' },
			at(20)
		);
		const first = (await jobs())[0];
		// A second job takes the same part.
		await processStatus(db, printerId, printing('b.gcode', 5, 300), at(30));
		const second = (await jobs()).find((j) => j.id !== first.id)!;
		await linkJob(db, second.id, 'org1', 'owner', buildId, 13, ['rims-1-4']);
		await dismissJob(db, first.id, 'org1', 'owner');
		expect(await partStatus('rims-1-4')).toBe('Printing');
	});

	it('a part whose runs are all done, set back to Printing for a job cancelled at 0%, returns to Printed', async () => {
		for (const d of ['2026-11-01', '2026-11-02'])
			await addRun(db, buildId, 'owner', {
				plateNumber: 13,
				partSlug: 'rims-1-4',
				date: d,
				result: 'Success',
				grams: 100
			});
		expect(await partStatus('rims-1-4')).toBe('Printed');
		await processStatus(db, printerId, printing('benchy.gcode', 0, 20, { layer: 1 }), at(5));
		await db
			.update(printers)
			.set({ lastStatus: printing('benchy.gcode', 0, 20, { layer: 1 }) as never });
		const id = (await jobs())[0].id;
		await linkJob(db, id, 'org1', 'owner', buildId, 13, ['rims-1-4']);
		expect(await partStatus('rims-1-4')).toBe('Printing');
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 0, fileName: 'benchy.gcode', layer: 1 },
			at(8)
		);
		expect((await jobs())[0].runId).toBe('dismissed');
		expect(await partStatus('rims-1-4')).toBe('Printed');
	});

	it('confirm logs only the chosen part too', async () => {
		await updatePlate(db, buildId, 'owner', 13, {
			slicerByPart: { 'rims-1-4': 140, 'rims-2-3': 148 }
		});
		await processStatus(db, printerId, printing(FILE, 5, 300), at(5));
		await processStatus(db, printerId, { state: 'done', progress: 100, fileName: FILE }, at(60));
		await confirmJob(db, (await jobs())[0].id, 'org1', 'owner', {});
		const [run] = await db.select().from(printRuns);
		expect(run).toMatchObject({ partSlug: 'rims-1-4', grams: 140 });
	});
});

describe('suggestions from "Start on printer" and take-off', () => {
	const slicerFile = 'ECC_0.4_tmt_4691_Overture PETG HF_0.2_11h1m.gcode';
	const expectPlate = async (plate: number, partSlugs?: string[], jobId?: string) =>
		await setExpected(db, 'org1', printerId, {
			buildId,
			plate,
			...(partSlugs ? { partSlugs } : {}),
			...(jobId ? { jobId } : {}),
			at: Date.now()
		});
	const withStatus = async (file: string) =>
		await db.update(printers).set({ lastStatus: printing(file, 5, 300) as never });

	it('an expectation does not attach at job creation and is reported pending', async () => {
		await expectPlate(2);
		await processStatus(db, printerId, printing(slicerFile, 1, 30), at(1));
		expect((await jobs())[0].buildId).toBeNull();
		expect(await partStatus('handle-right')).toBe('To print');
		expect(await pendingExpected(db, 'org1', buildId)).toMatchObject([
			{ printerId, buildId, plateNumber: 2, jobId: (await jobs())[0].id }
		]);
		expect(await pendingExpected(db, 'org1', 'other-build')).toEqual([]);
	});

	it('sent while the print already runs: the suggestion is bound to that unlinked job', async () => {
		await processStatus(db, printerId, printing(slicerFile, 1, 30), at(1));
		const { expectOnPrinterJob } = await import('./jobs');
		await expectOnPrinterJob(db, printerId, { buildId, plate: 2 });
		expect((await pendingExpected(db, 'org1', buildId))[0].jobId).toBe((await jobs())[0].id);
	});

	it('choosing another plate clears the suggestion', async () => {
		await expectPlate(2);
		await processStatus(db, printerId, printing(slicerFile, 1, 30), at(1));
		await withStatus(slicerFile);
		await linkJob(db, (await jobs())[0].id, 'org1', 'owner', buildId, 1);
		expect((await jobs())[0]).toMatchObject({ plateNumber: 1 });
		expect(await getExpected(db, 'org1', printerId)).toBeNull();
	});

	it('the job event a client reloads on already carries the bound suggestion', async () => {
		const seen: { pending: number; jobId: string | null }[] = [];
		await expectOnPrinterJob(db, printerId, { buildId, plate: 2 });
		const reads: Promise<void>[] = [];
		const off = subscribePrinterEvents('org1', (e) => {
			if (e.type !== 'job') return;
			reads.push(
				pendingExpected(db, 'org1', buildId).then((p) => {
					seen.push({ pending: p.length, jobId: p[0]?.jobId ?? null });
				})
			);
		});
		await processStatus(db, printerId, printing('mystery.gcode', 5, 300), at(5));
		off();
		await Promise.all(reads);
		expect(seen.length).toBeGreaterThan(0);
		const firstJobId = (await jobs())[0].id;
		expect(seen.every((x) => x.pending === 1 && x.jobId === firstJobId)).toBe(true);
	});
	it('a suggestion never applies to a second job', async () => {
		await expectPlate(2);
		await processStatus(db, printerId, printing(slicerFile, 1, 30), at(1));
		await processStatus(db, printerId, { state: 'idle', progress: null }, at(40)); // ended unlinked
		expect(await pendingExpected(db, 'org1', buildId)).toEqual([]);
		await processStatus(db, printerId, printing('next.gcode', 1, 30), at(60));
		expect((await jobs()).every((j) => j.buildId === null)).toBe(true);
		expect(await pendingExpected(db, 'org1', buildId)).toEqual([]);
	});

	it('a stale suggestion (over 12 h) is ignored and dropped', async () => {
		await setExpected(db, 'org1', printerId, { buildId, plate: 2, at: Date.now() - 13 * 3600_000 });
		await processStatus(db, printerId, printing(slicerFile, 1, 30), at(1));
		expect(await pendingExpected(db, 'org1', buildId)).toEqual([]);
		expect(await getExpected(db, 'org1', printerId)).toBeNull();
	});

	it('a file name that names the plate still links by itself', async () => {
		await processStatus(db, printerId, printing('Plate 2 - Handle Right.gcode', 5, 300), at(5));
		expect((await jobs())[0]).toMatchObject({ buildId, plateNumber: 2 });
	});

	it('taking a plate off the printer unlinks its live job, logs no run, leaves other plates alone', async () => {
		await processStatus(db, printerId, printing('Plate 2 - Handle Right.gcode', 5, 300), at(5));
		expect(await partStatus('handle-right')).toBe('Printing');
		// stopping a different plate does not touch the job
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		await printingAction(db, buildId, 'owner', { action: 'stop', slugs: ['handle-left'] });
		expect((await jobs())[0]).toMatchObject({ buildId, plateNumber: 2 });
		const ev = onBuildEvents(buildId);
		await printingAction(db, buildId, 'owner', { action: 'stop', slugs: ['handle-right'] });
		expect((await jobs())[0]).toMatchObject({ buildId: null, plateNumber: null, partSlugs: null });
		expect((await jobs())[0].status).toBe('printing');
		expect(await partStatus('handle-right')).toBe('To print');
		expect(await db.select().from(printRuns)).toHaveLength(0);
		expect(ev.length).toBeGreaterThan(0);
		// the Overview offers it again
		expect((await buildJobs(db, buildId, 'org1')).map((j) => j.id)).toEqual([(await jobs())[0].id]);
	});
});

describe('cancelled or failed prints', () => {
	const FILE = 'Plate 1 - Handle Left.gcode';
	const filamentUsed = async () =>
		filamentStats((await loadBuildView(db, buildId, 'owner'))!).reduce((a, f) => a + f.used, 0);
	const stop = async (progress: number, extra: Partial<PrinterStatus> = {}, min = 20) =>
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress, fileName: FILE, ...extra },
			at(min)
		);

	it('cancelled at 0% logs nothing and puts the parts back (auto-log on and off)', async () => {
		for (const auto of [true, false]) {
			await db.delete(printerJobs);
			await db.delete(activity);
			await setOrgSettings(db, 'org1', { autoLogPrints: auto });
			await updatePlate(db, buildId, 'owner', 1, { slicerGrams: 41 });
			await processStatus(db, printerId, printing(FILE, 0, 20, { layer: 1 }), at(1));
			expect(await partStatus('handle-left'), `auto ${auto}`).toBe('Printing');
			await stop(0, { layer: 1 }, 3);
			expect((await jobs())[0]).toMatchObject({ status: 'cancelled', runId: 'dismissed' });
			expect(await db.select().from(printRuns)).toHaveLength(0);
			expect(await buildJobs(db, buildId, 'org1')).toHaveLength(0);
			expect(await partStatus('handle-left')).toBe('To print');
			expect(await filamentUsed()).toBe(0);
			const act = (await first(
				db.select().from(activity).where(eq(activity.kind, 'printer.job.unstarted'))
			))!;
			expect(act.payload).toMatchObject({
				plateNumber: 1,
				result: 'cancelled',
				by: 'Shop Centauri'
			});
		}
	});

	it('cancelled at 40% still asks: nothing logged until confirmed, parts stay Printing', async () => {
		await setOrgSettings(db, 'org1', { autoLogPrints: true });
		await updatePlate(db, buildId, 'owner', 1, { slicerGrams: 41 });
		await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(25));
		await stop(40, { layer: 40 });
		expect(await db.select().from(printRuns)).toHaveLength(0);
		expect(await partStatus('handle-left')).toBe('Printing');
		expect((await buildJobs(db, buildId, 'org1'))[0].pendingConfirm).toBe(true);
		expect(await filamentUsed()).toBe(0);
		expect(
			await db.select().from(activity).where(eq(activity.kind, 'printer.job.unstarted'))
		).toHaveLength(0);
	});

	it('confirming a stopped print defaults to Failed with grams scaled by progress', async () => {
		await updatePlate(db, buildId, 'owner', 1, { slicerGrams: 41 });
		await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(25));
		await stop(40, { layer: 40 });
		await confirmJob(db, (await jobs())[0].id, 'org1', 'owner', {});
		const run = (await first(db.select().from(printRuns)))!;
		expect(run).toMatchObject({ result: 'Failed', grams: 16 });
		expect(await partStatus('handle-left')).toBe('Reprint');
		expect(await filamentUsed()).toBe(16);
	});

	it('"Don\'t log" (dismiss) at 40% returns the parts to To print and counts nothing', async () => {
		await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(25));
		await stop(40, { layer: 40 });
		await dismissJob(db, (await jobs())[0].id, 'org1', 'owner');
		expect(await partStatus('handle-left')).toBe('To print');
		expect(await db.select().from(printRuns)).toHaveLength(0);
		expect(await filamentUsed()).toBe(0);
	});

	it('is conservative: layers past the first, or nothing known, still ask', async () => {
		await processStatus(db, printerId, printing(FILE, 0, 20, { layer: 6 }), at(1));
		await stop(0, { layer: 6 }, 3);
		expect((await buildJobs(db, buildId, 'org1'))[0].pendingConfirm).toBe(true);
		await dismissJob(db, (await jobs())[0].id, 'org1', 'owner');
		// no progress, no layer, no elapsed reported on a long job
		await processStatus(
			db,
			printerId,
			{ state: 'printing', progress: null, fileName: FILE },
			at(30)
		);
		await processStatus(
			db,
			printerId,
			{ state: 'failed', progress: null, fileName: FILE },
			at(30 + 120)
		);
		const last = (await jobs()).find((j) => j.status === 'failed')!;
		expect(last.runId).toBeNull();
	});

	it('a multi-run part between runs stays Printing when its next job is cancelled at 0%', async () => {
		const RIM = 'Plate 13 - Wheel Rim.gcode';
		await processStatus(db, printerId, printing(RIM, 5, 300, { layer: 5 }), at(5));
		await processStatus(
			db,
			printerId,
			{ state: 'done', progress: 100, fileName: RIM, elapsedSec: 7200 },
			at(130)
		);
		await confirmJob(db, (await jobs())[0].id, 'org1', 'owner', {});
		expect(await partStatus('rims-1-4')).toBe('Printing'); // run 1 of 2 done
		await processStatus(db, printerId, printing(RIM, 0, 10, { layer: 1 }), at(200));
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 0, fileName: RIM, layer: 1 },
			at(203)
		);
		expect(await partStatus('rims-1-4')).toBe('Printing');
		const st = (await loadBuildView(db, buildId, 'owner'))!.state['rims-1-4'];
		expect(st.startedAt).toBeNull();
		expect(await db.select().from(printRuns)).toHaveLength(1);
	});

	describe('terminal status that resets progress', () => {
		const terminal = async (extra: Partial<PrinterStatus>, min = 40) =>
			await processStatus(
				db,
				printerId,
				{ state: 'failed', cancelled: true, fileName: FILE, ...extra } as PrinterStatus,
				at(min)
			);
		const expectAsks = async (grams: number) => {
			expect(await db.select().from(printRuns)).toHaveLength(0);
			expect(await partStatus('handle-left')).toBe('Printing');
			expect((await buildJobs(db, buildId, 'org1'))[0].pendingConfirm).toBe(true);
			expect((await jobs())[0].runId).toBeNull();
			await confirmJob(db, (await jobs())[0].id, 'org1', 'owner', {});
			expect(await first(db.select().from(printRuns))).toMatchObject({ result: 'Failed', grams });
		};
		beforeEach(async () => await updatePlate(db, buildId, 'owner', 1, { slicerGrams: 50 }));

		it('40% then a final progress of 0 still asks, scaled from 40%', async () => {
			await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(25));
			await terminal({ progress: 0, layer: 1 });
			expect((await jobs())[0].progress).toBe(40);
			await expectAsks(20);
		});
		it('60% with layer info then a final progress of 0 and no layer still asks', async () => {
			await processStatus(db, printerId, printing(FILE, 60, 2500, { layer: 60 }), at(25));
			await terminal({ progress: 0 });
			await expectAsks(30);
		});
		it('a final status with no progress at all still asks', async () => {
			await processStatus(db, printerId, printing(FILE, 40, 1500), at(25));
			await terminal({ progress: null });
			await expectAsks(20);
			await processStatus(db, printerId, printing(FILE, 40, 1500), at(60));
			// (second job is a new run of the same file)
			await terminal({ progress: undefined } as Partial<PrinterStatus>, 70);
			expect(await jobs()).toHaveLength(2);
		});
		it('the SDCP shape (no layer on the final status) after real progress still asks', async () => {
			await processStatus(db, printerId, printing(FILE, 12, 600, { layer: 12 }), at(11));
			await processStatus(db, printerId, { state: 'failed', cancelled: true, progress: 0 }, at(20));
			// no fileName on the final status: the job is still the active one
			expect((await jobs())[0].status).toBe('cancelled');
			await expectAsks(6);
		});
		it('polls and a final status at 0 are genuinely not started', async () => {
			await processStatus(db, printerId, printing(FILE, 0, 20, { layer: 1 }), at(1));
			await processStatus(db, printerId, printing(FILE, 0, 40, { layer: 1 }), at(2));
			await terminal({ progress: 0, layer: 1 }, 3);
			expect(await db.select().from(printRuns)).toHaveLength(0);
			expect(await partStatus('handle-left')).toBe('To print');
			expect((await jobs())[0].runId).toBe('dismissed');
		});
		it('a mid-print poll that dips to 0 does not lower the stored progress', async () => {
			await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(25));
			await processStatus(db, printerId, printing(FILE, 0, 1560, { layer: 0 }), at(26));
			expect((await jobs())[0].progress).toBe(40);
			await processStatus(db, printerId, printing(FILE, 45, 1700, { layer: 45 }), at(28));
			expect((await jobs())[0].progress).toBe(45);
		});
	});

	it('a Reprint part is a Reprint again after a job cancelled at 0%, and after "Don\'t log" at 40%', async () => {
		await addRun(db, buildId, 'owner', {
			plateNumber: 1,
			date: '2026-11-03',
			result: 'Failed',
			grams: 5
		});
		expect(await partStatus('handle-left')).toBe('Reprint');
		await processStatus(db, printerId, printing(FILE, 0, 20, { layer: 1 }), at(1));
		expect(await partStatus('handle-left')).toBe('Printing');
		await stop(0, { layer: 1 }, 3);
		expect(await partStatus('handle-left')).toBe('Reprint');
		expect((await loadBuildView(db, buildId, 'owner'))!.state['handle-left'].startedAt).toBeNull();

		await processStatus(db, printerId, printing(FILE, 40, 1500, { layer: 40 }), at(30));
		expect(await partStatus('handle-left')).toBe('Printing');
		await stop(40, { layer: 40 }, 50);
		const j = (await jobs()).find((x) => x.runId === null)!;
		await dismissJob(db, j.id, 'org1', 'owner');
		expect(await partStatus('handle-left')).toBe('Reprint');
	});

	it('deleting a failed run of a multi-run plate restores statuses and filament', async () => {
		await updatePlate(db, buildId, 'owner', 13, {
			slicerByPart: { 'rims-1-4': 140, 'rims-2-3': 148 }
		});
		await addRun(db, buildId, 'owner', {
			plateNumber: 13,
			partSlug: 'rims-1-4',
			date: '2026-11-03',
			result: 'Success',
			grams: 140
		});
		const { runId: failed } = await addRun(db, buildId, 'owner', {
			plateNumber: 13,
			partSlug: 'rims-1-4',
			date: '2026-11-04',
			result: 'Failed',
			grams: 60
		});
		expect(await partStatus('rims-1-4')).toBe('Reprint');
		expect(await filamentUsed()).toBe(200);
		await deleteRun(db, buildId, 'owner', failed);
		expect(await db.select().from(printRuns)).toHaveLength(1);
		expect(await partStatus('rims-1-4')).toBe('To print'); // run 1 of 2 won; not Printing now
		expect(await filamentUsed()).toBe(140);
	});
});

describe('team job history keeps unlinked prints apart', () => {
	it('never sends unlinked finished jobs to a build, and returns them separately for the team', async () => {
		await processStatus(db, printerId, printing('Plate 1 - Handle Left.gcode', 5, 300), at(5));
		await processStatus(
			db,
			printerId,
			{ state: 'done', progress: 100, fileName: 'Plate 1 - Handle Left.gcode' },
			at(60)
		);
		await processStatus(db, printerId, printing('benchy.gcode', 5, 300), at(70));
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 3, fileName: 'benchy.gcode' },
			at(80)
		);
		await processStatus(db, printerId, printing('vase.gcode', 5, 300), at(90));
		const all = await jobs();
		const bench = all.find((j) => j.fileName === 'benchy.gcode')!;
		const vase = all.find((j) => j.fileName === 'vase.gcode')!;
		expect(bench.buildId).toBeNull();
		expect(bench.status).toBe('cancelled');
		// Build view: the linked job (waiting for its log) and the running unlinked one, never the finished unlinked one.
		const ids = (await buildJobs(db, buildId, 'org1')).map((j) => j.id);
		expect(ids).toContain(vase.id);
		expect(ids).not.toContain(bench.id);
		// Team view still returns it (the Printers page puts it behind a disclosure).
		expect((await teamJobs(db, 'org1')).map((j) => j.id)).toContain(bench.id);
		// Nothing of another team.
		expect(await teamJobs(db, 'other-org')).toHaveLength(0);
		// No activity rows mention the unlinked jobs.
		expect(JSON.stringify(await db.select().from(activity))).not.toContain('benchy');
	});

	it('a flood of unlinked jobs does not push linked ones out of the list', async () => {
		await processStatus(db, printerId, printing('Plate 1 - Handle Left.gcode', 5, 300), at(5));
		await processStatus(db, printerId, { state: 'idle', progress: 100 } as PrinterStatus, at(30));
		for (let i = 0; i < 20; i++) {
			await processStatus(db, printerId, printing(`junk${i}.gcode`, 5, 300), at(100 + i * 10));
			await processStatus(
				db,
				printerId,
				{ state: 'idle', progress: 0 } as PrinterStatus,
				at(105 + i * 10)
			);
		}
		const t = await teamJobs(db, 'org1');
		expect(t.some((j) => j.buildId === buildId)).toBe(true);
	});
});

describe('linking a job over parts that are already Printing', () => {
	const FILE_A = 'Plate 1 - Handle Left.gcode';
	const FILE_B = 'slice_b_17h44m.gcode'; // another slice: no plate match, linked by hand
	const view = async () => (await loadBuildView(db, buildId, 'owner'))!;
	const plateEst = async () =>
		(await first(db.select().from(buildPlates).where(eq(buildPlates.number, 1))))!.manualEstSeconds;
	const link = async (jobId: string, st: PrinterStatus) => {
		await db.update(printers).set({ lastStatus: st as never });
		await linkJob(db, jobId, 'org1', 'owner', buildId, 1);
	};
	/** Job A (linked by file name, est 4500 s, started at(0)) ends cancelled at 39%, unlogged. */
	const cancelledA = async () => {
		await processStatus(db, printerId, printing(FILE_A, 20, 1500, { remainingSec: 3000 }), at(25));
		await processStatus(
			db,
			printerId,
			{ state: 'failed', cancelled: true, progress: 39, fileName: FILE_A, layer: 40 },
			at(35)
		);
		const a = (await jobs()).find((j) => j.fileName === FILE_A)!;
		expect(a.status).toBe('cancelled');
		expect(await partStatus('handle-left')).toBe('Printing');
		expect(await plateEst()).toBe(4500);
		return a;
	};
	/** Job B starts at(40) (elapsed 100 s), total 7100 s, unlinked until the user links it. */
	const startB = async () => {
		const st = printing(FILE_B, 1, 100, { remainingSec: 7000 });
		await processStatus(db, printerId, st, at(40));
		const b = (await jobs()).find((j) => j.fileName === FILE_B)!;
		expect(b.buildId).toBeNull();
		return { b, st };
	};

	it('takes the new job start and estimate over an ended, unlogged job', async () => {
		await cancelledA();
		const { b, st } = await startB();
		await link(b.id, st);
		const p = (await view()).state['handle-left'];
		expect(p.status).toBe('Printing');
		expect(p.startedAt).toBe(b.startedAt!.toISOString());
		expect(p.startedAt).not.toBe(at(0).toISOString());
		expect(p.runEstSeconds).toBe(7100);
		expect(await plateEst()).toBe(7100);
	});

	it('confirming the old job as Failed or Partial keeps the plate printing on the new job', async () => {
		for (const result of ['Failed', 'Partial'] as const) {
			await db.delete(printRuns);
			await db.delete(printerJobs);
			await db.update(buildParts).set({ status: 'To print', startedAt: null, runEstSeconds: null });
			const a = await cancelledA();
			const { b, st } = await startB();
			await link(b.id, st);
			const runId = await confirmJob(db, a.id, 'org1', 'owner', { result });
			expect((await jobs()).find((j) => j.id === a.id)!.runId).toBe(runId);
			expect(await first(db.select().from(printRuns))).toMatchObject({ id: runId, result });
			const p = (await view()).state['handle-left'];
			expect(p.status, result).toBe('Printing');
			expect(p.startedAt).toBe(b.startedAt!.toISOString());
			expect(p.runEstSeconds).toBe(7100);
			// the Overview's "Now printing" card (domain nowPrinting over the build view)
			const card = nowPrinting(await view()).find((c) => c.plate === 1);
			expect(card, result).toBeTruthy();
			expect(card!.startedAt).toBe(b.startedAt!.toISOString());
		}
	});

	it('a manual start at now, then a job that started earlier: the job start wins', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		expect((await view()).state['handle-left'].startedAt).toBeTruthy();
		const st = printing(FILE_B, 10, 900, { remainingSec: 6000 });
		await processStatus(db, printerId, st, new Date());
		const b = (await jobs()).find((j) => j.fileName === FILE_B)!;
		await link(b.id, st);
		const p = (await view()).state['handle-left'];
		expect(p.startedAt).toBe(b.startedAt!.toISOString());
		expect(p.runEstSeconds).toBe(6900);
		expect(await plateEst()).toBe(6900);
	});

	it('keeps the start and estimate when another running job already covers the parts', async () => {
		// job A running and linked by file name on printer 1
		await processStatus(db, printerId, printing(FILE_A, 20, 1500, { remainingSec: 3000 }), at(25));
		const before = (await view()).state['handle-left'];
		expect(before.startedAt).toBe(at(0).toISOString());
		// a second printer runs another file; the user links it to the same plate
		const p2 = (
			await createPrinter(db, 'org1', 'owner', {
				name: 'Second',
				kind: 'elegoo-sdcp',
				secrets: { shareLink: 'https://shared-bbbbbbbb2222.octoeverywhere.com' },
				catalogId: 'elegoo-centauri-carbon'
			})
		).id;
		const st = printing(FILE_B, 5, 200, { remainingSec: 9000 });
		await processStatus(db, p2, st, at(30));
		const b = (await jobs()).find((j) => j.fileName === FILE_B)!;
		await db
			.update(printers)
			.set({ lastStatus: st as never })
			.where(eq(printers.id, p2));
		await linkJob(db, b.id, 'org1', 'owner', buildId, 1);
		const after = (await view()).state['handle-left'];
		expect(after.startedAt).toBe(before.startedAt);
		expect(after.runEstSeconds).toBe(4500);
	});

	it('does not overwrite a plate time the user typed', async () => {
		await cancelledA();
		await db
			.update(buildPlates)
			.set({ manualEstSeconds: 6000, manualEstSource: 'user' })
			.where(eq(buildPlates.number, 1));
		const { b, st } = await startB();
		await link(b.id, st);
		expect(await plateEst()).toBe(6000);
		expect((await view()).state['handle-left'].runEstSeconds).toBe(7100);
	});
});

describe('attach run-time estimate', () => {
	it('is taken from sane elapsed + remaining only (see sanePrintSeconds)', async () => {
		expect(sanePrintSeconds(600, 1800)).toBe(2400);
		expect(sanePrintSeconds(NaN, 5)).toBeNull();
		expect(sanePrintSeconds(-1, 100)).toBeNull();
		expect(sanePrintSeconds(2_592_000, 1)).toBeNull();
	});
});

describe('Partial confirm with per-part results (issue 46)', () => {
	const multi = async () => {
		const v = (await loadBuildView(db, buildId, 'owner'))!;
		const plate = v.plates.find((p) => !p.perPartRuns && p.parts.length >= 2 && p.runs <= 1)!;
		return { plate, v };
	};
	const finishOn = async (plateNumber: number, state: 'failed' | 'done' = 'failed') => {
		const file = `Plate ${plateNumber} - Test.gcode`;
		await processStatus(db, printerId, printing(file, 40, 1500), at(5));
		const j = (await jobs())[0];
		await db
			.update(printerJobs)
			.set({ buildId, plateNumber, status: state, progress: 40, finishedAt: at(60) })
			.where(eq(printerJobs.id, j.id));
		return j.id;
	};

	it('a split confirm makes two runs, links the kept one, and logs one activity row', async () => {
		const { plate } = await multi();
		const id = await finishOn(plate.number);
		const kept = [plate.parts[0]];
		const { runId, runIds } = await confirmJobRuns(db, id, 'org1', 'owner', {
			result: 'Partial',
			split: { keptSlugs: kept, keptGrams: 20, lostGrams: 5 }
		});
		expect(runIds).toHaveLength(2);
		const runs = await db.select().from(printRuns);
		expect(runs).toHaveLength(2);
		const keptRun = runs.find((r) => r.id === runId)!;
		expect(keptRun).toMatchObject({ result: 'Success', grams: 20 });
		expect(runs.find((r) => r.id !== runId)).toMatchObject({ result: 'Failed', grams: 5 });
		expect((await jobs()).find((j) => j.id === id)!.runId).toBe(runId);
		expect(await db.select().from(activity).where(eq(activity.kind, 'run.add'))).toHaveLength(1);
	});

	it('rejects grams over the cap with 400, plain and split', async () => {
		const { plate } = await multi();
		const id = await finishOn(plate.number);
		const over = 100001;
		const status = async (body: Record<string, unknown>) => {
			try {
				await confirmJobRuns(db, id, 'org1', 'owner', body);
			} catch (e) {
				return (e as ApiError).status;
			}
			return 0;
		};
		expect(await status({ result: 'Success', grams: over })).toBe(400);
		const keptSlugs = [plate.parts[0]];
		expect(await status({ result: 'Partial', split: { keptSlugs, keptGrams: over } })).toBe(400);
		expect(await status({ result: 'Partial', split: { keptSlugs, lostGrams: over } })).toBe(400);
		await expect(
			confirmJobRuns(db, id, 'org1', 'owner', {
				result: 'Partial',
				split: { keptSlugs, lostGrams: over }
			})
		).rejects.toThrow(/at most 100000 g/);
		expect(await db.select().from(printRuns)).toHaveLength(0);
	});

	it('rejects a bad split without logging anything', async () => {
		const { plate } = await multi();
		const id = await finishOn(plate.number);
		const bad = async (body: Record<string, unknown>) =>
			await expect(confirmJobRuns(db, id, 'org1', 'owner', body)).rejects.toThrow();
		await bad({ result: 'Failed', split: { keptSlugs: [plate.parts[0]] } });
		await bad({ result: 'Partial', split: { keptSlugs: ['nope'] } });
		await bad({ result: 'Partial', split: { keptSlugs: ['__proto__'] } });
		await bad({ result: 'Partial', split: { keptSlugs: [] } });
		await bad({ result: 'Partial', split: { keptSlugs: plate.parts } });
		await bad({ result: 'Partial', split: { keptSlugs: [plate.parts[0]], keptGrams: -1 } });
		await bad({ result: 'Partial', split: 'x' });
		expect(await db.select().from(printRuns)).toHaveLength(0);
		expect((await jobs()).find((j) => j.id === id)!.runId).toBeNull();
	});
});
