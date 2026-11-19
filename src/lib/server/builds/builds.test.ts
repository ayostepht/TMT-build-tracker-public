import { beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { ApiError, buildAccess } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildFilaments,
	buildParts,
	buildPlates,
	colorDesigns,
	member,
	organization,
	templates,
	user
} from '../db/schema';
import { onBuildEvents } from './test-helpers';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import {
	addRun,
	deleteBuild,
	deleteRun,
	printingAction,
	setPartStatus,
	undoRun,
	updateBuild,
	updateFilament,
	updateRun
} from './actions';
import { createBuild } from './create';
import { loadBuildView } from './view';

let db: Db;
let templateId: string;
let orgId: string;

async function addUser(id: string) {
	await db.insert(user).values({ id, name: `User ${id}`, email: `${id}@example.test` });
}
async function addMember(userId: string, role: string) {
	await db
		.insert(member)
		.values({ id: `m-${userId}`, organizationId: orgId, userId, role, createdAt: new Date() });
}

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	orgId = 'org1';
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const u of ['owner', 'editor', 'viewer', 'outsider']) await addUser(u);
	await addMember('owner', 'owner');
	await addMember('editor', 'editor');
	await addMember('viewer', 'viewer');
});

const mk = async (designId: string | null = null) =>
	await createBuild(db, { organizationId: orgId, templateId, designId, name: 'Build A' }, 'owner');

describe('createBuild', () => {
	it('copies parts, plates and filaments from the template', async () => {
		const tpl = templateSeeds[0];
		const id = await mk();
		const n = async (t: typeof buildParts | typeof buildPlates | typeof buildFilaments) =>
			(await first(db.select({ n: count() }).from(t).where(eq(t.buildId, id))))!.n;
		expect(await n(buildParts)).toBe(tpl.parts.length);
		expect(await n(buildPlates)).toBe(tpl.plates.length);
		expect(await n(buildFilaments)).toBe(tpl.filamentRoles.length);
		expect(tpl.parts.length).toBe(41);
		expect(tpl.plates.length).toBe(24);
		expect(tpl.filamentRoles.length).toBe(4);
	});

	it('applies design overrides and part roles', async () => {
		const d = (await first(db.select().from(colorDesigns)))!;
		const id = await mk(d.id);
		const view = (await loadBuildView(db, id, 'owner'))!;
		for (const r of d.roles) {
			const f = view.filaments.find((x) => x.key === r.key)!;
			expect([f.name, f.material, f.hex]).toEqual([r.name, r.material, r.hex]);
			expect(f.spools).toBe(f.recommendedSpools);
		}
		for (const [slug, role] of Object.entries(d.partRoles)) {
			expect(view.parts.find((p) => p.slug === slug)!.role).toBe(role);
		}
	});

	it('rejects viewers and non-members', async () => {
		const input = { organizationId: orgId, templateId, designId: null, name: 'x' };
		await expect(createBuild(db, input, 'viewer')).rejects.toThrow(ApiError);
		await expect(createBuild(db, input, 'outsider')).rejects.toThrow(ApiError);
	});
});

describe('loadBuildView', () => {
	it('is null for non-members, canEdit false for viewers', async () => {
		const id = await mk();
		expect(await loadBuildView(db, id, 'outsider')).toBeNull();
		expect(await buildAccess(db, id, 'outsider')).toBeNull();
		const v = (await loadBuildView(db, id, 'viewer'))!;
		expect(v.role).toBe('viewer');
		expect(v.canEdit).toBe(false);
		expect((await loadBuildView(db, id, 'editor'))!.canEdit).toBe(true);
		expect(Object.keys(v.state)).toHaveLength(33);
		expect(v.members).toHaveLength(3);
	});
});

describe('mutations', () => {
	it('rejects viewers (403) and non-members (404), allows editors', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		const status = (u: string) => () => setPartStatus(db, id, u, slug, { status: 'Printing' });
		await expect(status('viewer')()).rejects.toThrowError(expect.objectContaining({ status: 403 }));
		await expect(status('outsider')()).rejects.toThrowError(
			expect.objectContaining({ status: 404 })
		);
		await status('editor')();
		expect((await loadBuildView(db, id, 'owner'))!.state[slug].status).toBe('Printing');
		const acts = await db.select().from(activity).where(eq(activity.buildId, id));
		expect(acts.map((a) => a.kind)).toContain('part.status');
	});

	it('emits an event per mutation', async () => {
		const id = await mk();
		const events = onBuildEvents(id);
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		await setPartStatus(db, id, 'editor', slug, { status: 'Printed' });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'changed', kind: 'part.status', by: 'User editor' });
	});

	it('restores a printed date only when going back to Printed, validated, editor only', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		const st = async () => (await loadBuildView(db, id, 'owner'))!.state[slug];
		await setPartStatus(db, id, 'editor', slug, { status: 'Printed', printedOn: '2026-01-02' });
		expect((await st()).printedOn).toBe('2026-01-02');
		const bad = (body: object) => () => setPartStatus(db, id, 'editor', slug, body);
		await setPartStatus(db, id, 'editor', slug, { status: 'To print' });
		expect((await st()).printedOn).toBeNull();
		await expect(bad({ status: 'Printed', printedOn: '2999-01-01' })()).rejects.toThrowError(
			expect.objectContaining({ status: 400 })
		);
		await expect(bad({ status: 'Printed', printedOn: '0000-01-01' })()).rejects.toThrowError(
			expect.objectContaining({ status: 400 })
		);
		await expect(bad({ status: 'Printed', printedOn: '2019-12-31' })()).rejects.toThrowError(
			expect.objectContaining({ status: 400 })
		);
		await expect(bad({ status: 'Printed', printedOn: 'yesterday' })()).rejects.toThrowError(
			expect.objectContaining({ status: 400 })
		);
		await expect(bad({ status: 'Printing', printedOn: '2026-01-02' })()).rejects.toThrowError(
			expect.objectContaining({ status: 400 })
		);
		(
			await expect(
				await setPartStatus(db, id, 'viewer', slug, { status: 'Printed', printedOn: '2026-01-02' })
			)
		).rejects.toThrowError(expect.objectContaining({ status: 403 }));
		expect((await st()).status).toBe('To print');
	});

	it('validates input', async () => {
		const id = await mk();
		(
			await expect(await setPartStatus(db, id, 'owner', 'nope', { status: 'Printed' }))
		).rejects.toThrow(ApiError);
		await expect(setPartStatus(db, id, 'owner', 'x', { status: 'Bogus' })).rejects.toThrow(
			ApiError
		);
		await expect(updateBuild(db, id, 'owner', { phase: 'nope' })).rejects.toThrow(ApiError);
		await updateBuild(db, id, 'editor', { phase: 'printing', name: 'Renamed' });
		expect((await loadBuildView(db, id, 'owner'))!.build).toMatchObject({
			phase: 'printing',
			name: 'Renamed'
		});
	});

	it('build details record only fields that really changed', async () => {
		const id = await mk();
		const rows = async () =>
			(await db.select().from(activity).where(eq(activity.buildId, id))).filter(
				(a) => a.kind === 'build.update'
			);
		// empty to empty ('' vs null) is no change: no activity row, nothing cleared
		await updateBuild(db, id, 'owner', { recipient: '', hospital: '  ', deliveryDate: null });
		expect(await rows()).toHaveLength(0);
		// a real change records only that field
		await updateBuild(db, id, 'owner', { recipient: 'Sam', hospital: '', deliveryDate: null });
		expect(await rows()).toHaveLength(1);
		expect((await rows())[0].payload).toEqual({ recipient: 'Sam' });
		// same value again: nothing new
		await updateBuild(db, id, 'owner', { recipient: 'Sam', name: 'Build A' });
		expect(await rows()).toHaveLength(1);
		// really clearing it is recorded
		await updateBuild(db, id, 'owner', { recipient: '' });
		expect(await rows()).toHaveLength(2);
		expect((await rows())[1].payload).toEqual({ recipient: null });
	});

	it('filament spools accept fractions, round to 0.01 and reject bad values', async () => {
		const id = await mk();
		const spools = async () =>
			(await loadBuildView(db, id, 'owner'))!.filaments.find((f) => f.key === 'primary')!.spools;
		await updateFilament(db, id, 'editor', 'primary', { spools: 4.5 });
		expect(await spools()).toBe(4.5);
		await updateFilament(db, id, 'editor', 'primary', { spools: 2.346 });
		expect(await spools()).toBe(2.35);
		const act = await db.select().from(activity).where(eq(activity.kind, 'filament.spools'));
		expect(act).toHaveLength(2);
		for (const bad of [-1, 100, 'abc', null, NaN])
			(
				await expect(await updateFilament(db, id, 'editor', 'primary', { spools: bad }))
			).rejects.toThrow(ApiError);
		expect(await spools()).toBe(2.35);
		(
			await expect(await updateFilament(db, id, 'viewer', 'primary', { spools: 1 }))
		).rejects.toThrowError(expect.objectContaining({ status: 403 }));
	});

	it('printing start/stop round-trips', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		await printingAction(db, id, 'owner', { action: 'start', slugs: [slug] });
		expect((await loadBuildView(db, id, 'owner'))!.state[slug].status).toBe('Printing');
		await printingAction(db, id, 'owner', { action: 'setEstimate', slugs: [slug], seconds: 3600 });
		expect((await loadBuildView(db, id, 'owner'))!.state[slug].runEstSeconds).toBe(3600);
		await printingAction(db, id, 'owner', { action: 'stop', slugs: [slug] });
		expect((await loadBuildView(db, id, 'owner'))!.state[slug].status).toBe('To print');
	});

	it('records the printer on a start and on a run edit', async () => {
		const id = await mk();
		const v0 = (await loadBuildView(db, id, 'owner'))!;
		const slug = v0.parts[0].slug;
		await printingAction(db, id, 'owner', {
			action: 'start',
			slugs: [slug],
			printer: ' Garage printer '
		});
		const v1 = (await loadBuildView(db, id, 'owner'))!;
		const row = v1.activity.find((a) => a.kind === 'printing.start')!;
		expect(row.payload.printer).toBe('Garage printer');
		(
			await expect(
				await printingAction(db, id, 'owner', { action: 'start', slugs: [slug], printer: 5 })
			)
		).rejects.toThrow(ApiError);
		const { runId } = await addRun(db, id, 'owner', {
			plateNumber: null,
			partSlug: slug,
			date: '2026-01-02',
			result: 'Success',
			grams: 1,
			hours: 1,
			printer: 'Garage printer',
			note: ''
		});
		await updateRun(db, id, 'owner', runId, { printer: null });
		expect(
			(await loadBuildView(db, id, 'owner'))!.runs.find((r) => r.id === runId)!.printer
		).toBeNull();
	});

	it('marks plate parts Printed after the required successful runs', async () => {
		const id = await mk();
		const v0 = (await loadBuildView(db, id, 'owner'))!;
		const plate = v0.plates.find((p) => p.runs === 2 && !p.perPartRuns && p.parts.length)!;
		const log = async () =>
			await addRun(db, id, 'editor', {
				plateNumber: plate.number,
				partSlug: null,
				partSlugs: null,
				date: '2026-01-02',
				result: 'Success',
				grams: 100,
				hours: 2,
				printer: 'P1',
				note: ''
			});
		await log();
		let v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.state[plate.parts[0]].status).toBe('Printing');
		expect(v.runs).toHaveLength(1);
		expect(v.runs[0].userName).toBe('User editor');
		await log();
		v = (await loadBuildView(db, id, 'owner'))!;
		for (const s of plate.parts) expect(v.state[s].status).toBe('Printed');
		(
			await expect(
				await addRun(db, id, 'viewer', {
					plateNumber: plate.number,
					date: '2026-01-02',
					result: 'Success'
				})
			)
		).rejects.toThrowError(expect.objectContaining({ status: 403 }));
	});

	it('only owners can delete a build', async () => {
		const id = await mk();
		await expect(deleteBuild(db, id, 'editor')).rejects.toThrowError(
			expect.objectContaining({ status: 403 })
		);
		await deleteBuild(db, id, 'owner');
		expect(await loadBuildView(db, id, 'owner')).toBeNull();
	});
});

describe('undoRun', () => {
	it('deletes the run and restores the snapshot, only for parts the run touches', async () => {
		const id = await mk();
		const view0 = (await loadBuildView(db, id, 'owner'))!;
		const slug = view0.parts[0].slug;
		const other = view0.parts.find((p) => p.slug !== slug)!.slug;
		await printingAction(db, id, 'owner', { action: 'start', slugs: [slug] });
		const before = (await loadBuildView(db, id, 'owner'))!.state[slug];
		const snap = {
			slug,
			status: before.status,
			startedAt: before.startedAt,
			printedOn: before.printedOn,
			runEstSeconds: before.runEstSeconds,
			comps: before.comps
		};
		const { runId } = await addRun(db, id, 'owner', {
			plateNumber: null,
			partSlug: slug,
			date: '2026-01-01',
			result: 'Success',
			grams: 10,
			hours: 1,
			note: ''
		});
		expect((await loadBuildView(db, id, 'owner'))!.state[slug].status).toBe('Printed');

		(
			await expect(await undoRun(db, id, 'owner', runId, { parts: [{ ...snap, slug: other }] }))
		).rejects.toThrow(ApiError);
		await expect(undoRun(db, id, 'viewer', runId, { parts: [snap] })).rejects.toThrow(
			ApiError
		);
		await undoRun(db, id, 'owner', runId, { parts: [snap] });
		const after = (await loadBuildView(db, id, 'owner'))!;
		expect(after.runs).toHaveLength(0);
		expect(after.state[slug].status).toBe('Printing');
		expect(after.state[slug].startedAt).toBe(before.startedAt);
		expect(after.activity[0].kind).toBe('run.undo');
	});
});

describe('editing and deleting past print logs', () => {
	const logPart = async (id: string, slug: string) =>
		(
			await addRun(db, id, 'editor', {
				plateNumber: null,
				partSlug: slug,
				date: '2026-01-02',
				result: 'Success',
				grams: 10,
				hours: 1,
				note: 'first'
			})
		).runId;
	const lastAct = async (id: string) =>
		(await db.select().from(activity).where(eq(activity.buildId, id))).at(-1)!;

	it('deleteRun recomputes the part and records it; viewers get 403', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		const runId = await logPart(id, slug);
		expect((await loadBuildView(db, id, 'owner'))!.state[slug]).toMatchObject({
			status: 'Printed'
		});
		await expect(deleteRun(db, id, 'viewer', runId)).rejects.toThrowError(
			expect.objectContaining({ status: 403 })
		);
		await deleteRun(db, id, 'editor', runId);
		const v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.runs).toHaveLength(0);
		expect(v.state[slug]).toMatchObject({ status: 'To print', printedOn: null });
		const a = await lastAct(id);
		expect(a.kind).toBe('run.delete');
		expect(a.payload).toMatchObject({
			recomputed: [{ slug, from: 'Printed', to: 'To print' }]
		});
	});

	it('deleteRun with recompute false leaves statuses alone', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		const runId = await logPart(id, slug);
		const events = onBuildEvents(id);
		await deleteRun(db, id, 'editor', runId, { recompute: false });
		const v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.runs).toHaveLength(0);
		expect(v.state[slug].status).toBe('Printed');
		expect(await lastAct(id).payload).toMatchObject({ recomputed: [] });
		expect(events.at(-1)).toMatchObject({ kind: 'run.delete' });
	});

	it('updateRun: Success to Failed gives Reprint; grams/note edits do not touch statuses', async () => {
		const id = await mk();
		const slug = (await loadBuildView(db, id, 'owner'))!.parts[0].slug;
		const runId = await logPart(id, slug);
		await expect(updateRun(db, id, 'viewer', runId, { note: 'x' })).rejects.toThrowError(
			expect.objectContaining({ status: 403 })
		);
		await expect(updateRun(db, id, 'editor', runId, { result: 'Bogus' })).rejects.toThrow(
			ApiError
		);
		await expect(updateRun(db, id, 'editor', 'nope', { note: 'x' })).rejects.toThrowError(
			expect.objectContaining({ status: 404 })
		);
		await updateRun(db, id, 'editor', runId, { grams: 55, note: 'edited' });
		let v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.runs[0]).toMatchObject({ grams: 55, note: 'edited' });
		expect(v.state[slug].status).toBe('Printed');
		expect(await lastAct(id)).toMatchObject({ kind: 'run.update' });

		await updateRun(db, id, 'editor', runId, { result: 'Failed' });
		v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.state[slug]).toMatchObject({ status: 'Reprint', printedOn: null });
		expect(await lastAct(id).payload).toMatchObject({
			result: 'Failed',
			recomputed: [{ slug, from: 'Printed', to: 'Reprint' }]
		});
	});
});
