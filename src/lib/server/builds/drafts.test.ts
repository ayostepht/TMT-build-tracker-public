import { beforeEach, describe, expect, it, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError, buildAccess } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { activity, builds, member, organization, printerJobs, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import {
	addRun,
	deleteBuild,
	printingAction,
	promoteDraft,
	setPartStatus,
	setSetupStep,
	updateBuild,
	updateFilament
} from './actions';
import { setAssemblyItem } from './assembly';
import { createBuild } from './create';
import { updateHandoff } from './handoff';
import { buildRows, draftRows, recentBuilds } from './list';
import { updateBuildDesign } from '../designs/mutate';
import { loadBuildView } from './view';

let db: Db;
let templateId: string;
const orgId = 'org1';

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

const mkDraft = async (name = 'Draft 1') =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name, kind: 'draft' },
		'editor'
	);
const mkBuild = async (name = 'Build A') =>
	await createBuild(db, { organizationId: orgId, templateId, designId: null, name }, 'owner');
const rejected = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		expect(e).toBeInstanceOf(ApiError);
		expect((e as ApiError).status).toBe(400);
		return;
	}
	throw new Error('expected a 400');
};

describe('Studio drafts: lists and stats', () => {
	it('creates a draft with no setup step and kind draft', async () => {
		const id = await mkDraft();
		const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
		expect(row.kind).toBe('draft');
		expect(row.setupStep).toBeNull();
		expect((await buildAccess(db, id, 'owner'))?.kind).toBe('draft');
		expect((await loadBuildView(db, id, 'owner'))!.build.kind).toBe('draft');
	});

	it('keeps drafts out of build rows and the recent builds menu', async () => {
		const b = await mkBuild();
		const d = await mkDraft();
		expect((await buildRows(db, [orgId])).map((r) => r.id)).toEqual([b]);
		expect((await recentBuilds(db, [orgId])).map((r) => r.id)).toEqual([b]);
		expect((await draftRows(db, [orgId])).map((r) => r.id)).toEqual([d]);
		expect((await draftRows(db, [orgId]))[0].colors.length).toBeGreaterThan(0);
	});

	it('shows no builds when only drafts exist', async () => {
		await mkDraft();
		expect(await buildRows(db, [orgId])).toEqual([]);
		expect(await recentBuilds(db, [orgId])).toEqual([]);
	});
});

describe('Studio drafts: tracking mutations are refused', () => {
	it('rejects runs, status, printing, filament stock, assembly, handoff, phase and setup with a 400', async () => {
		const id = await mkDraft();
		const v = (await loadBuildView(db, id, 'editor'))!;
		const slug = v.parts[0].slug;
		const plate = v.plates[0];
		await rejected(async () => await setPartStatus(db, id, 'editor', slug, { status: 'Printed' }));
		await rejected(
			async () => await printingAction(db, id, 'editor', { action: 'start', slugs: [slug] })
		);
		await rejected(
			async () =>
				await addRun(db, id, 'editor', {
					plateNumber: plate.number,
					partSlug: null,
					partSlugs: null,
					date: '2026-01-02',
					result: 'Success',
					grams: 10,
					hours: 1,
					printer: 'P1',
					note: ''
				})
		);
		await rejected(
			async () => await updateFilament(db, id, 'editor', v.filaments[0].key, { spools: 3 })
		);
		await rejected(
			async () =>
				await setAssemblyItem(db, id, 'editor', v.assembly.steps[0]?.key ?? 'x', { done: true })
		);
		await rejected(async () => await updateHandoff(db, id, 'editor', { notes: 'hi' }));
		await rejected(async () => await updateBuild(db, id, 'editor', { phase: 'printing' }));
		await rejected(async () => await setSetupStep(db, id, 'editor', { step: 2 }));
		const after = (await loadBuildView(db, id, 'editor'))!;
		expect(after.runs).toHaveLength(0);
		expect(after.state[slug].status).toBe(v.state[slug].status);
		// Nothing leaked into the activity log besides the create row.
		expect(await db.select().from(activity).where(eq(activity.buildId, id))).toHaveLength(1);
	});

	it('still allows design, name and filament colour edits', async () => {
		const id = await mkDraft();
		const v = (await loadBuildView(db, id, 'editor'))!;
		await updateFilament(db, id, 'editor', v.filaments[0].key, { hex: '#112233' });
		await updateBuild(db, id, 'editor', { name: 'Renamed' });
		const part = v.parts.find((p) => p.slug === 'wing-left')!;
		await updateBuildDesign(db, id, 'editor', { partRoles: { [part.slug]: 'primary' } });
		const after = (await loadBuildView(db, id, 'editor'))!;
		expect(after.build.name).toBe('Renamed');
		expect(after.filaments[0].hex).toBe('#112233');
		expect(after.parts.find((p) => p.slug === part.slug)!.role).toBe('primary');
	});

	it('viewers still get a 403 and builds still accept tracking', async () => {
		const id = await mkDraft();
		await expect(updateBuild(db, id, 'viewer', { name: 'x' })).rejects.toThrow(/cannot edit/);
		const b = await mkBuild();
		const slug = (await loadBuildView(db, b, 'owner'))!.parts[0].slug;
		await setPartStatus(db, b, 'editor', slug, { status: 'Printed' });
		expect((await loadBuildView(db, b, 'owner'))!.state[slug].status).toBe('Printed');
	});

	it('does not link printer jobs to drafts', async () => {
		const id = await mkDraft();
		expect(await db.select().from(printerJobs)).toHaveLength(0);
		expect((await buildAccess(db, id, 'owner'))?.kind).toBe('draft');
	});
});

describe('Studio drafts: delete and promote', () => {
	it('lets an editor delete a draft but not a build, and removes its rows', async () => {
		const d = await mkDraft();
		await deleteBuild(db, d, 'editor');
		expect(await db.select().from(builds).where(eq(builds.id, d))).toHaveLength(0);
		const b = await mkBuild();
		await expect(deleteBuild(db, b, 'editor')).rejects.toThrow(/owners/);
	});

	it('promotes a draft: keeps design and plates, becomes a build, writes activity', async () => {
		const id = await mkDraft('Keeper');
		const v = (await loadBuildView(db, id, 'editor'))!;
		await updateFilament(db, id, 'editor', v.filaments[0].key, { hex: '#abcdef' });
		const plates = v.plates.length;
		await promoteDraft(db, id, 'editor');
		const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
		expect(row.kind).toBe('build');
		expect(row.setupStep).toBe(5);
		const after = (await loadBuildView(db, id, 'editor'))!;
		expect(after.filaments[0].hex).toBe('#abcdef');
		expect(after.plates).toHaveLength(plates);
		expect(after.activity.some((a) => a.kind === 'build.promote')).toBe(true);
		expect((await buildRows(db, [orgId])).map((r) => r.id)).toEqual([id]);
		expect(await draftRows(db, [orgId])).toEqual([]);
		// Now it tracks like any build.
		const slug = after.parts[0].slug;
		await setPartStatus(db, id, 'editor', slug, { status: 'Printed' });
	});

	it('refuses to promote a build, and viewers cannot promote', async () => {
		await rejected(async () => await promoteDraft(db, await mkBuild(), 'owner'));
		await expect(promoteDraft(db, await mkDraft(), 'viewer')).rejects.toThrow(/cannot edit/);
	});
});
