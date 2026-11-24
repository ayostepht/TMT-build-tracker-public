import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MAX_CUSTOM_PIECES, isCustomPlate } from '#lib/domain/custom.ts';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	activity,
	buildCustomPieces,
	buildParts,
	buildPlates,
	member,
	organization,
	templates,
	user,
	workspaceCustomPieces,
	type LibraryPlate
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';

const applyCalls = { n: 0 };
// A saved part named "Late failure" is applied for real and then fails: proves the per-piece savepoint.
vi.mock('../custom-library', async (orig) => {
	const real = await orig<typeof import('../custom-library')>();
	return {
		...real,
		applyLibraryPieceTx: (async (...args: Parameters<typeof real.applyLibraryPieceTx>) => {
			applyCalls.n++;
			const r = await real.applyLibraryPieceTx(...args);
			if (args[2].name === 'Late failure') throw new ApiError(400, 'late failure');
			return r;
		}) as typeof real.applyLibraryPieceTx
	};
});

const { createBuild } = await import('./create');
const { loadBuildView } = await import('./view');

let db: Db;
let templateId: string;
const kitSlug = 'handle-left';

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	for (const o of ['org1', 'org2'])
		await db
			.insert(organization)
			.values({ id: o, name: `Chapter ${o}`, slug: o, createdAt: new Date() });
	for (const [u, o] of [
		['owner', 'org1'],
		['other', 'org2']
	]) {
		await db
			.insert(user)
			.values({ id: u, name: `User ${u}`, email: `${u}@example.test`, emailVerified: false });
		await db
			.insert(member)
			.values({ id: `m-${u}`, organizationId: o, userId: u, role: 'owner', createdAt: new Date() });
	}
});
afterEach(async () => {
	await dropTestDb(db);
});

const plate = (name: string): LibraryPlate => ({
	name,
	estSeconds: 3600,
	grams: 20,
	filamentGrams: { primary: 20 },
	role: 'primary',
	runs: 1,
	thumb: false
});
const save = async (
	org: string,
	name: string,
	opts: { isDefault?: boolean; plates?: LibraryPlate[]; replaces?: string[] } = {}
) => {
	const [row] = await db
		.insert(workspaceCustomPieces)
		.values({
			organizationId: org,
			name,
			sliced: true,
			templateId,
			replaces: opts.replaces ?? [],
			plates: opts.plates ?? [plate('Main')],
			isDefault: opts.isDefault ?? true,
			createdBy: 'owner'
		})
		.returning();
	return row;
};
const mk = (extra: Record<string, unknown> = {}, org = 'org1', by = 'owner') =>
	createBuild(
		db,
		{ organizationId: org, templateId, designId: null, name: 'B', setup: true, ...extra },
		by
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const kinds = async (id: string) =>
	(await db.select({ kind: activity.kind }).from(activity).where(eq(activity.buildId, id))).map(
		(a) => a.kind
	);

describe('createBuild: saved custom parts marked "Include in new builds"', () => {
	it('adds them to a setup build with plates, replaced kit parts and activity rows', async () => {
		await save('org1', 'Beta handle', { replaces: [kitSlug] });
		const id = await mk();
		const v = await view(id);
		expect(v.customPieces.map((c) => c.name)).toEqual(['Beta handle']);
		expect(v.customPieces[0].libraryId).toBeTruthy();
		expect(v.plates.filter(isCustomPlate)).toHaveLength(1);
		expect(v.skipped.map((s) => s.slug)).toContain(kitSlug);
		const k = await kinds(id);
		expect(k.filter((x) => x === 'custom.add')).toHaveLength(1);
		expect(k).toContain('build.create');
	});

	it('does not add them to drafts or builds made without the setup flow', async () => {
		await save('org1', 'Beta handle');
		for (const extra of [{ kind: 'draft' as const }, { setup: false }, { setup: undefined }]) {
			const id = await mk(extra);
			expect((await view(id)).customPieces).toHaveLength(0);
			expect(await kinds(id)).not.toContain('custom.add');
		}
	});

	it('leaves out saved parts that are not marked and parts of other workspaces', async () => {
		await save('org1', 'Not default', { isDefault: false });
		await save('org2', 'Other chapter', { isDefault: true });
		const id = await mk();
		expect((await view(id)).customPieces).toHaveLength(0);
		const other = await mk({}, 'org2', 'other');
		expect((await loadBuildView(db, other, 'other'))!.customPieces.map((c) => c.name)).toEqual([
			'Other chapter'
		]);
	});

	it('skips a part that cannot be added without failing the build', async () => {
		await save('org1', 'Empty', { plates: [] });
		await save('org1', 'Good');
		const id = await mk();
		expect((await view(id)).customPieces.map((c) => c.name)).toEqual(['Good']);
	});

	it('leaves no partial rows when a part fails after it was written', async () => {
		await save('org1', 'Late failure', { replaces: [kitSlug] });
		await save('org1', 'Good');
		const id = await mk();
		const v = await view(id);
		expect(v.customPieces.map((c) => c.name)).toEqual(['Good']);
		expect(v.skipped.map((s) => s.slug)).not.toContain(kitSlug);
		const pieces = await db
			.select()
			.from(buildCustomPieces)
			.where(eq(buildCustomPieces.buildId, id));
		expect(pieces).toHaveLength(1);
		const orphanPlates = (
			await db.select().from(buildPlates).where(eq(buildPlates.buildId, id))
		).filter((p) => p.source?.startsWith('custom:') && p.source !== `custom:${pieces[0].id}`);
		expect(orphanPlates).toHaveLength(0);
		const customParts = (
			await db
				.select()
				.from(buildParts)
				.where(and(eq(buildParts.buildId, id)))
		).filter((p) => p.partSlug.startsWith('custom'));
		expect(customParts.length).toBe(v.parts.filter((p) => p.custom).length);
		expect((await kinds(id)).filter((x) => x === 'custom.add')).toHaveLength(1);
	});

	it('stops at the custom piece cap and still creates the build', async () => {
		for (let i = 0; i < MAX_CUSTOM_PIECES + 5; i++) await save('org1', `Part ${i}`);
		applyCalls.n = 0;
		const id = await mk();
		expect((await view(id)).customPieces).toHaveLength(MAX_CUSTOM_PIECES);
		expect(applyCalls.n).toBe(MAX_CUSTOM_PIECES);
		expect(await kinds(id)).toContain('build.create');
	});
});
