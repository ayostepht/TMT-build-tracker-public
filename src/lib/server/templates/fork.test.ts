import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { createBuild } from '../builds/create';
import { loadBuildView } from '../builds/view';
import type { Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	member,
	organization,
	templateParts,
	templatePlateLayouts,
	templatePlates,
	templatePrintGeometry,
	templates,
	user
} from '../db/schema';
import { assertTemplateAdmin } from '../models/guard';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { QuotaError } from '../quota';
import {
	canManageTemplate,
	canViewTemplate,
	countKitCopies,
	chooseBuildTemplate,
	defaultTemplate,
	forkTemplate,
	listTemplatesFor
} from './fork';

let db: Db;
let baseId: string;

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	baseId = (await defaultTemplate(db)).id;
	for (const [id, name] of [
		['admin', 'Admin'],
		['owner', 'Owner'],
		['editor', 'Editor'],
		['viewer', 'Viewer'],
		['other', 'Other']
	])
		await db.insert(user).values({
			id,
			name,
			email: `${id}@example.test`,
			createdAt: new Date(id === 'admin' ? 1 : 2)
		});
	for (const org of ['org1', 'org2'])
		await db.insert(organization).values({ id: org, name: org, slug: org, createdAt: new Date() });
	for (const [u, org, role] of [
		['owner', 'org1', 'owner'],
		['editor', 'org1', 'editor'],
		['viewer', 'org1', 'viewer'],
		['other', 'org2', 'owner']
	])
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: org, userId: u, role, createdAt: new Date() });
});
afterEach(() => dropTestDb(db));

describe('forkTemplate', () => {
	it('copies the static data into a workspace-owned template', async () => {
		const id = await forkTemplate(db, 'org1', baseId, 'My chair');
		const [fork] = await db.select().from(templates).where(eq(templates.id, id));
		expect(fork.ownerOrgId).toBe('org1');
		expect(fork.baseTemplateId).toBe(baseId);
		expect(fork.slug).not.toBe((await defaultTemplate(db)).slug);
		const count = async (
			t: typeof templateParts | typeof templatePlates | typeof templatePlateLayouts
		) => (await db.select().from(t).where(eq(t.templateId, id))).length;
		const baseCount = async (
			t: typeof templateParts | typeof templatePlates | typeof templatePlateLayouts
		) => (await db.select().from(t).where(eq(t.templateId, baseId))).length;
		expect(await count(templateParts)).toBe(await baseCount(templateParts));
		expect(await count(templatePlates)).toBe(await baseCount(templatePlates));
		expect(await count(templatePlateLayouts)).toBe(await baseCount(templatePlateLayouts));
		// Seed footprints come along, imported meshes do not.
		const geo = await db
			.select()
			.from(templatePrintGeometry)
			.where(eq(templatePrintGeometry.templateId, id));
		expect(geo.length).toBeGreaterThan(0);
		expect(geo.every((g) => g.sourceNote === 'seed')).toBe(true);
	});

	it('forks the original kit when asked to fork a fork', async () => {
		const a = await forkTemplate(db, 'org1', baseId, 'A');
		const b = await forkTemplate(db, 'org1', a, 'B');
		const [row] = await db.select().from(templates).where(eq(templates.id, b));
		expect(row.baseTemplateId).toBe(baseId);
	});

	it('lists global templates plus the workspace own, hides other workspaces', async () => {
		const mine = await forkTemplate(db, 'org1', baseId, 'Mine');
		const theirs = await forkTemplate(db, 'org2', baseId, 'Theirs');
		const ids = async (org: string) => (await listTemplatesFor(db, org)).map((t) => t.id);
		expect(await ids('org1')).toContain(mine);
		expect(await ids('org1')).not.toContain(theirs);
		expect(await ids('org1')).toContain(baseId);
		expect((await defaultTemplate(db)).id).toBe(baseId);
	});
});

describe('who may add kit files', () => {
	it('global kits: site admins only; own copies: owners and editors of that workspace', async () => {
		const fork = await forkTemplate(db, 'org1', baseId, 'Mine');
		const u = (id: string) => ({ id, email: `${id}@example.test` });
		expect(await canManageTemplate(db, u('admin'), baseId)).toBe(true);
		for (const id of ['owner', 'editor', 'viewer', 'other'])
			expect(await canManageTemplate(db, u(id), baseId)).toBe(false);
		expect(await canManageTemplate(db, u('owner'), fork)).toBe(true);
		expect(await canManageTemplate(db, u('editor'), fork)).toBe(true);
		for (const id of ['viewer', 'other']) {
			expect(await canManageTemplate(db, u(id), fork)).toBe(false);
			await expect(assertTemplateAdmin(db, u(id), fork)).rejects.toThrow(ApiError);
		}
		await expect(assertTemplateAdmin(db, u('editor'), fork)).resolves.toBeUndefined();
		await expect(assertTemplateAdmin(db, u('editor'), baseId)).rejects.toThrow(ApiError);
		expect(await canManageTemplate(db, u('owner'), 'missing')).toBe(false);
	});
});

describe('chooseBuildTemplate', () => {
	const mk = () =>
		createBuild(
			db,
			{ organizationId: 'org1', templateId: baseId, designId: null, name: 'Chair', setup: true },
			'owner'
		);

	it('switches a build to its own copy and back, keeping parts and progress', async () => {
		const id = await mk();
		const before = (await loadBuildView(db, id, 'owner'))!;
		expect(before.build.setupStep).toBe(1);
		expect(before.build.templateOwned).toBe(false);

		const { templateId } = await chooseBuildTemplate(db, id, 'owner', true);
		expect(templateId).not.toBe(baseId);
		const own = (await loadBuildView(db, id, 'owner'))!;
		expect(own.build.templateOwned).toBe(true);
		expect(own.parts.map((p) => p.slug)).toEqual(before.parts.map((p) => p.slug));
		expect(own.plates.length).toBe(before.plates.length);

		// A second call reuses the copy.
		expect((await chooseBuildTemplate(db, id, 'owner', true)).templateId).toBe(templateId);
		expect((await chooseBuildTemplate(db, id, 'owner', false)).templateId).toBe(baseId);
		expect((await chooseBuildTemplate(db, id, 'owner', true)).templateId).toBe(templateId);
		expect((await listTemplatesFor(db, 'org1')).filter((t) => t.ownerOrgId).length).toBe(1);
	});

	it('needs an editor', async () => {
		const id = await mk();
		await expect(chooseBuildTemplate(db, id, 'viewer', true)).rejects.toThrow(ApiError);
		await expect(chooseBuildTemplate(db, id, 'other', true)).rejects.toThrow(ApiError);
	});
});

describe('kit copies limit', () => {
	afterEach(() => vi.unstubAllEnvs());
	const u = (id: string) => ({ id, email: `${id}@example.test` });

	it('refuses past the limit with 409 + code, per workspace', async () => {
		vi.stubEnv('QUOTA_KIT_COPIES_PER_WORKSPACE', '2');
		await forkTemplate(db, 'org1', baseId, 'A', 'owner');
		await forkTemplate(db, 'org1', baseId, 'B', 'owner');
		const err = await forkTemplate(db, 'org1', baseId, 'C', 'owner').catch((e) => e);
		expect(err).toBeInstanceOf(QuotaError);
		expect(err).toMatchObject({ status: 409, code: 'quota' });
		expect(await countKitCopies(db, 'org1')).toBe(2);
		await expect(forkTemplate(db, 'org2', baseId, 'Z', 'other')).resolves.toBeTypeOf('string');
	});

	it('one slot left: of two parallel requests exactly one succeeds', async () => {
		vi.stubEnv('QUOTA_KIT_COPIES_PER_WORKSPACE', '1');
		const results = await Promise.all(
			[1, 2].map((i) => forkTemplate(db, 'org1', baseId, `K${i}`, 'owner').catch((e) => e))
		);
		expect(results.filter((r) => typeof r === 'string')).toHaveLength(1);
		expect(await countKitCopies(db, 'org1')).toBe(1);
	});

	it('no limit set: unlimited; site admin exempt', async () => {
		for (let i = 0; i < 5; i++) await forkTemplate(db, 'org1', baseId, `N${i}`, 'owner');
		vi.stubEnv('QUOTA_KIT_COPIES_PER_WORKSPACE', '1');
		await expect(forkTemplate(db, 'org1', baseId, 'admin one', 'admin')).resolves.toBeTypeOf(
			'string'
		);
		await expect(forkTemplate(db, 'org1', baseId, 'nope', 'owner')).rejects.toThrow(QuotaError);
	});

	it('at the limit, switching to "own" reuses an unused copy; unused copies count', async () => {
		vi.stubEnv('QUOTA_KIT_COPIES_PER_WORKSPACE', '1');
		const mk = (name: string) =>
			createBuild(
				db,
				{ organizationId: 'org1', templateId: baseId, designId: null, name, setup: true },
				'owner'
			);
		const a = await mk('First');
		const own = (await chooseBuildTemplate(db, a, 'owner', true)).templateId;
		await chooseBuildTemplate(db, a, 'owner', false); // the copy is now unused but still counts
		expect(await countKitCopies(db, 'org1')).toBe(1);
		const b = await mk('Second');
		expect((await chooseBuildTemplate(db, b, 'owner', true)).templateId).toBe(own);
		// Now in use by b: a third build cannot get a copy.
		const c = await mk('Third');
		await expect(chooseBuildTemplate(db, c, 'owner', true)).rejects.toThrow(QuotaError);
		expect(await countKitCopies(db, 'org1')).toBe(1);
	});

	it('canViewTemplate: built-in for all, a copy for its members and admins only', async () => {
		const fork = await forkTemplate(db, 'org1', baseId, 'Mine');
		for (const id of ['owner', 'viewer', 'other'])
			expect(await canViewTemplate(db, u(id), baseId)).toBe(true);
		for (const id of ['owner', 'editor', 'viewer', 'admin'])
			expect(await canViewTemplate(db, u(id), fork)).toBe(true);
		expect(await canViewTemplate(db, u('other'), fork)).toBe(false);
		expect(await canViewTemplate(db, u('other'), 'missing')).toBe(false);
	});
});
