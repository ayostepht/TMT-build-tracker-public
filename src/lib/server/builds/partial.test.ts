import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildPlates,
	member,
	organization,
	printRuns,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, deleteRun, MAX_RUN_GRAMS, printingAction, undoRun, updatePart } from './actions';
import { createBuild } from './create';
import { loadBuildView } from './view';
import { snapshotParts } from '../../domain/logrun';
import { describeActivity } from '../../domain/activity';
import { filamentStats } from '../../domain/accounting';

let db: Db;
let templateId: string;
const orgId = 'org1';

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

const mk = async () =>
	await createBuild(db, { organizationId: orgId, templateId, designId: null, name: 'B' }, 'owner');
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const acts = async (id: string, kind?: string) =>
	(await db.select().from(activity).where(eq(activity.buildId, id))).filter(
		(a) => !kind || a.kind === kind
	);
const runRows = async (id: string) =>
	await db.select().from(printRuns).where(eq(printRuns.buildId, id));

/** A single-run plate of three or more parts, with typed weights 100 / 50 / rest. */
async function setup() {
	const id = await mk();
	const v = await view(id);
	const plate = v.plates.find((p) => !p.perPartRuns && p.runs === 1 && p.parts.length >= 3)!;
	const [a, b, c] = plate.parts;
	await updatePart(db, id, 'owner', a, { manualGrams: 100 });
	await updatePart(db, id, 'owner', b, { manualGrams: 50 });
	for (const s of plate.parts.slice(2))
		await updatePart(db, id, 'owner', s, { manualGrams: 50 / (plate.parts.length - 2) });
	return { id, plate, a, b, c, all: plate.parts };
}
const body = (n: number, split: unknown, over: object = {}) => ({
	plateNumber: n,
	date: '2026-01-02',
	result: 'Partial',
	hours: 6,
	note: '',
	split,
	...over
});

describe('Partial with per-part results', () => {
	it('refuses grams over the cap with 400, for a plain run and for a split', async () => {
		const { id, plate, a } = await setup();
		const status = (fn: () => unknown) => {
			try {
				fn();
			} catch (e) {
				return (e as ApiError).status;
			}
			return 0;
		};
		const over = MAX_RUN_GRAMS + 1;
		const plain = { plateNumber: plate.number, date: '2026-01-02', result: 'Success', grams: over };
		expect(await status(async () => await addRun(db, id, 'owner', plain))).toBe(400);
		await expect(addRun(db, id, 'owner', plain)).rejects.toThrow(/at most 100000 g/);
		for (const f of ['keptGrams', 'lostGrams']) {
			const split = { keptSlugs: [a], keptGrams: 1, lostGrams: 1, [f]: over };
			expect(
				await status(async () => await addRun(db, id, 'owner', body(plate.number, split)))
			).toBe(400);
		}
		expect(await db.select().from(printRuns).where(eq(printRuns.buildId, id))).toHaveLength(0);
		const ok = { ...plain, grams: MAX_RUN_GRAMS };
		expect(await status(async () => await addRun(db, id, 'owner', ok))).toBe(0);
	});

	it('makes a Success run for the ticked parts and a Failed run for the rest, in one activity row', async () => {
		const { id, plate, a, b, all } = await setup();
		await printingAction(db, id, 'owner', { action: 'start', slugs: all });
		await printingAction(db, id, 'owner', { action: 'setEstimate', slugs: all, seconds: 7200 });
		const before = acts(id).length;
		const { runId, runIds } = await addRun(
			db,
			id,
			'owner',
			body(plate.number, { keptSlugs: [a], keptGrams: 100, lostGrams: 30 })
		);
		expect(runIds).toHaveLength(2);
		expect(runId).toBe(runIds[0]);
		expect(acts(id).length).toBe(before + 1);
		const row = acts(id, 'run.add').at(-1)!;
		expect(row.payload).toMatchObject({
			split: true,
			result: 'Partial',
			runIds,
			kept: [a],
			keptGrams: 100,
			lostGrams: 30
		});
		const v = await view(id);
		const ok = v.runs.find((r) => r.id === runIds[0])!;
		const bad = v.runs.find((r) => r.id === runIds[1])!;
		expect([ok.result, ok.partSlugs, ok.grams]).toEqual(['Success', [a], 100]);
		expect([bad.result, bad.grams]).toEqual(['Failed', 30]);
		expect(bad.partSlugs).not.toContain(a);
		// 100 g of 200 g: half of the 6 h and half of the 2 h run time, the rest to the failed half.
		expect(ok.hours).toBe(3);
		expect(bad.hours).toBe(3);
		expect(ok.estSeconds).toBe(3600);
		expect(bad.estSeconds).toBe(3600);
		expect(v.state[a].status).toBe('Printed');
		expect(v.state[b].status).toBe('Reprint');
		expect(describeActivity(v.activity[0], v)).toContain('logged a partial print');
		// kept / lost accounting
		const fs = filamentStats(v).reduce((t, s) => ({ k: t.k + s.keptG, l: t.l + s.lostG }), {
			k: 0,
			l: 0
		});
		expect(fs).toEqual({ k: 100, l: 30 });
	});

	it('scales hours by the ticked parts weight share', async () => {
		const { id, plate, b } = await setup();
		const { runIds } = await addRun(
			db,
			id,
			'owner',
			body(plate.number, { keptSlugs: [b], keptGrams: null, lostGrams: null }, { hours: 4 })
		);
		const rows = await runRows(id);
		const ok = rows.find((r) => r.id === runIds[0])!;
		const lost = rows.find((r) => r.id === runIds[1])!;
		expect(ok.hours).toBe(1); // 50 of 200 g
		expect(lost.hours).toBe(3);
		expect(ok.grams).toBeNull();
	});

	it('undo deletes both runs and writes one run.undo row', async () => {
		const { id, plate, a, all } = await setup();
		const v0 = await view(id);
		const { runId, runIds } = await addRun(
			db,
			id,
			'owner',
			body(plate.number, { keptSlugs: [a], keptGrams: 1, lostGrams: 2 })
		);
		const undone = await undoRun(db, id, 'owner', runId, {
			parts: snapshotParts(v0, all),
			runIds
		});
		expect(undone.sort()).toEqual([...runIds].sort());
		expect(await runRows(id)).toHaveLength(0);
		const u = acts(id, 'run.undo');
		expect(u).toHaveLength(1);
		expect(u[0].payload).toMatchObject({ split: true, runIds: expect.any(Array) });
		const v = await view(id);
		for (const s of all) expect(v.state[s].status).toBe('To print');
	});

	it('undo skips a sibling that is already gone, and 404s when nothing is left', async () => {
		const { id, plate, a, all } = await setup();
		const v0 = await view(id);
		const { runId, runIds } = await addRun(
			db,
			id,
			'owner',
			body(plate.number, { keptSlugs: [a], keptGrams: 1, lostGrams: 2 })
		);
		await deleteRun(db, id, 'owner', runIds[1]);
		expect(
			await undoRun(db, id, 'owner', runId, { parts: snapshotParts(v0, all), runIds })
		).toEqual([runIds[0]]);
		(
			await expect(await undoRun(db, id, 'owner', runId, { parts: [], runIds }))
		).rejects.toThrowError(expect.objectContaining({ status: 404 }));
		(
			await expect(
				await undoRun(db, id, 'owner', runId, { parts: [], runIds: Array(11).fill('x') })
			)
		).rejects.toThrow(ApiError);
	});

	it('undo never touches runs of another build', async () => {
		const one = await setup();
		const other = await mk();
		const op = (await view(other)).plates.find((p) => p.number === one.plate.number)!;
		const mine = await addRun(db, other, 'owner', {
			plateNumber: op.number,
			date: '2026-01-02',
			result: 'Success'
		});
		const { runId, runIds } = await addRun(
			db,
			one.id,
			'owner',
			body(one.plate.number, { keptSlugs: [one.a], keptGrams: 1, lostGrams: 2 })
		);
		await undoRun(db, one.id, 'owner', runId, { parts: [], runIds: [...runIds, mine.runId] });
		expect(await runRows(other)).toHaveLength(1);
		expect(await runRows(one.id)).toHaveLength(0);
	});

	it('deleting one half recomputes only its parts', async () => {
		const { id, plate, a, b } = await setup();
		const { runIds } = await addRun(
			db,
			id,
			'owner',
			body(plate.number, { keptSlugs: [a], keptGrams: 1, lostGrams: 2 })
		);
		await deleteRun(db, id, 'owner', runIds[1]); // the Failed half
		let v = await view(id);
		expect(v.state[a].status).toBe('Printed');
		expect(v.state[b].status).toBe('To print');
		await deleteRun(db, id, 'owner', runIds[0]);
		v = await view(id);
		expect(v.state[a].status).toBe('To print');
	});

	it('refuses ticks that are empty, all, or not on the plate, and other results', async () => {
		const { id, plate, all } = await setup();
		const other = (await view(id)).plates.find((p) => p.number !== plate.number)!.parts[0];
		const tries: object[] = [
			body(plate.number, { keptSlugs: [] }),
			body(plate.number, { keptSlugs: all }),
			body(plate.number, { keptSlugs: [other] }),
			body(plate.number, { keptSlugs: ['constructor'] }),
			body(plate.number, { keptSlugs: ['__proto__'] }),
			body(plate.number, { keptSlugs: [all[0]] }, { result: 'Success' }),
			body(plate.number, 'nope'),
			body(plate.number, { keptSlugs: [all[0]], keptGrams: -1 }),
			{ ...body(plate.number, { keptSlugs: [all[0]] }), plateNumber: null, partSlug: all[0] }
		];
		for (const t of tries) {
			await expect(addRun(db, id, 'owner', t)).rejects.toThrowError(
				expect.objectContaining({ status: 400 })
			);
		}
		expect(await runRows(id)).toHaveLength(0);
	});

	it('refuses a split on a per-part or multi-run plate; a plain Partial is still accepted', async () => {
		const id = await mk();
		const v = await view(id);
		const perPart = v.plates.find((p) => p.perPartRuns && p.parts.length >= 2)!;
		const multi = v.plates.find((p) => !p.perPartRuns && p.parts.length >= 2)!;
		await db
			.update(buildPlates)
			.set({ runs: 2 })
			.where(and(eq(buildPlates.buildId, id), eq(buildPlates.number, multi.number)));
		for (const p of [perPart, multi]) {
			(
				await expect(await addRun(db, id, 'owner', body(p.number, { keptSlugs: [p.parts[0]] })))
			).rejects.toThrowError(expect.objectContaining({ status: 400 }));
		}
		const plain = await addRun(db, id, 'owner', {
			plateNumber: multi.number,
			date: '2026-01-02',
			result: 'Partial',
			grams: 20
		});
		expect(plain.runIds).toHaveLength(1);
		const row = (await runRows(id)).find((r) => r.id === plain.runId)!;
		expect(row.result).toBe('Partial');
		// older Partial rows count as lost
		const fs = filamentStats(await view(id)).reduce((t, s) => t + s.lostG, 0);
		expect(fs).toBe(20);
	});

	it('viewers cannot log, and a draft refuses it', async () => {
		const { id, plate, a } = await setup();
		(
			await expect(await addRun(db, id, 'viewer', body(plate.number, { keptSlugs: [a] })))
		).rejects.toThrowError(expect.objectContaining({ status: 403 }));
		const draft = await createBuild(
			db,
			{ organizationId: orgId, templateId, designId: null, name: 'D', kind: 'draft' },
			'owner'
		);
		(
			await expect(await addRun(db, draft, 'owner', body(plate.number, { keptSlugs: [a] })))
		).rejects.toThrowError(expect.objectContaining({ status: 400 }));
		expect(
			await db
				.select()
				.from(printRuns)
				.where(and(eq(printRuns.buildId, draft)))
		).toHaveLength(0);
	});
});
