import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { filamentStats, timeStats } from '#lib/domain/accounting.ts';
import { isCustomPlate } from '#lib/domain/custom.ts';
import { ApiError } from '../access';
import { uploadsDir } from '../config';
import { applyLibraryPiece, saveToLibrary } from '../custom-library';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { buildCustomPieces, builds, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { makeProjectThreeMf } from '../threemf/fixtures';
import { parseThreeMfBytes } from '../threemf';
import { addRun, deleteBuild, moveBuild, promoteDraft, setPartStatus, skipParts } from './actions';
import { createBuild } from './create';
import { addCustomPiece, removeCustomPiece, renameCustomPiece } from './custom-pieces';
import { removeBuildPlateFiles } from './custom-plates';
import { createUpload } from './plates';
import { loadBuildView } from './view';

let db: Db;
let templateId: string;

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const [u, role] of [
		['owner', 'owner'],
		['viewer', 'viewer'],
		['outsider', '']
	]) {
		await db
			.insert(user)
			.values({ id: u, name: `User ${u}`, email: `${u}@example.test`, createdAt: new Date() });
		if (role)
			await db
				.insert(member)
				.values({ id: `m-${u}`, organizationId: 'org1', userId: u, role, createdAt: new Date() });
	}
});

const mk = (kind?: 'draft', extra: { setup?: boolean } = {}) =>
	createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'B', kind, ...extra },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const status = async (fn: () => unknown) => {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiError) return e.status;
		throw e;
	}
	return 0;
};
const grams = async (id: string) => filamentStats(await view(id)).reduce((a, f) => a + f.total, 0);
const map = { '1': 'primary', '2': 'soft' };

async function upload(id: string) {
	const bytes = makeProjectThreeMf({
		sliced: true,
		filamentTypes: ['PETG', 'TPU'],
		plates: [
			{
				name: 'HANDLE BAR',
				prediction: 7200,
				weight: 70,
				filaments: { 1: 30, 2: 40 },
				objects: [{ name: 'Beta handle bar' }]
			},
			{
				name: 'HANDLE GRIP',
				prediction: 3600,
				weight: 12.5,
				filaments: { 1: 12.5 },
				objects: [{ name: 'Beta handle grip' }]
			}
		]
	});
	const parsed = await parseThreeMfBytes(bytes);
	return await createUpload(
		db,
		id,
		'owner',
		{ name: 'beta.3mf', size: bytes.length },
		parsed,
		await view(id)
	);
}
const addPiece = async (id: string, body: Record<string, unknown> = {}) =>
	addCustomPiece(db, id, 'owner', (await upload(id)).uploadId, {
		name: 'Beta',
		filamentMap: map,
		...body
	});

describe('Studio draft: Not printing', () => {
	it('leaves skipped parts out of the estimate and brings them back', async () => {
		const id = await mk('draft');
		const v = await view(id);
		const g0 = await grams(id);
		const s0 = timeStats(v).totalSec;
		await skipParts(db, id, 'owner', { slugs: ['handle-left'], skip: true });
		expect((await view(id)).skipped.map((s) => s.slug)).toEqual(['handle-left']);
		expect(await grams(id)).toBeLessThan(g0);
		expect(timeStats(await view(id)).totalSec).toBeLessThan(s0);
		await skipParts(db, id, 'owner', { slugs: ['handle-left'], skip: false });
		expect((await view(id)).skipped).toEqual([]);
		expect(await grams(id)).toBeCloseTo(g0, 5);
		expect(
			await status(
				async () => await skipParts(db, id, 'viewer', { slugs: ['handle-left'], skip: true })
			)
		).toBe(403);
		expect(
			await status(
				async () => await skipParts(db, id, 'outsider', { slugs: ['handle-left'], skip: true })
			)
		).toBe(404);
	});
});

describe('Studio draft: custom parts', () => {
	it('adds, renames and removes a piece; it enters the estimate and is To print', async () => {
		const id = await mk('draft');
		const r = await addPiece(id, { replaces: ['handle-left'] });
		const v = await view(id);
		expect(v.customPieces).toHaveLength(1);
		expect(v.skipped.map((s) => s.slug)).toEqual(['handle-left']);
		expect(v.plates.filter(isCustomPlate)).toHaveLength(2);
		for (const slug of v.customPieces[0].parts) expect(v.state[slug].status).toBe('To print');
		// the custom plates' grams count
		const withPiece = await grams(id);
		const timeWith = timeStats(await view(id)).totalSec;
		await skipParts(db, id, 'owner', { slugs: v.customPieces[0].parts, skip: true });
		expect(await grams(id)).toBeLessThan(withPiece);
		expect(timeStats(await view(id)).totalSec).toBeLessThan(timeWith);
		await skipParts(db, id, 'owner', { slugs: v.customPieces[0].parts, skip: false });

		await renameCustomPiece(db, id, 'owner', r.pieceId, { name: 'Gamma' });
		expect((await view(id)).customPieces[0].name).toBe('Gamma');
		expect(
			await status(async () => await renameCustomPiece(db, id, 'viewer', r.pieceId, { name: 'x' }))
		).toBe(403);

		await removeCustomPiece(db, id, 'owner', r.pieceId, { restore: true });
		const after = await view(id);
		expect(after.customPieces).toEqual([]);
		expect(after.skipped).toEqual([]);
		expect(after.plates.filter(isCustomPlate)).toEqual([]);
	});

	it('refuses a viewer and a non-member, and the caps still apply', async () => {
		const id = await mk('draft');
		const up = await upload(id);
		const body = { name: 'Beta', filamentMap: map };
		expect(await status(async () => addCustomPiece(db, id, 'viewer', up.uploadId, body))).toBe(403);
		expect(await status(async () => addCustomPiece(db, id, 'outsider', up.uploadId, body))).toBe(
			404
		);
		expect((await view(id)).customPieces).toEqual([]);
	});

	it('still refuses a run, a status and printing on a custom part of a draft', async () => {
		const id = await mk('draft');
		await addPiece(id);
		const slug = (await view(id)).customPieces[0].parts[0];
		expect(
			await status(
				async () =>
					await addRun(db, id, 'owner', {
						date: '2026-03-01',
						result: 'Success',
						partSlug: slug,
						grams: 5
					})
			)
		).toBe(400);
		expect(
			await status(async () => await setPartStatus(db, id, 'owner', slug, { status: 'Printed' }))
		).toBe(400);
		expect((await view(id)).runs).toEqual([]);
	});

	it('deleting a draft removes its custom thumbnails', async () => {
		const id = await mk('draft');
		await addPiece(id);
		const dir = join(uploadsDir(), 'plates', id);
		expect(existsSync(dir)).toBe(true);
		await deleteBuild(db, id, 'owner');
		removeBuildPlateFiles(id);
		expect(existsSync(dir)).toBe(false);
	});
});

describe('Studio draft: saved parts', () => {
	it('saves a piece from a draft and applies it to another draft and to a build', async () => {
		const d1 = await mk('draft');
		const p = await addPiece(d1, { replaces: ['handle-left'] });
		const saved = await saveToLibrary(db, 'owner', d1, p.pieceId);
		expect((await view(d1)).customPieces[0].libraryId).toBe(saved.id);
		expect(await status(async () => await saveToLibrary(db, 'viewer', d1, p.pieceId))).toBe(403);

		const d2 = await mk('draft');
		const r = (await applyLibraryPiece(db, d2, 'owner', saved.id))!;
		expect(r.plates).toHaveLength(2);
		expect((await view(d2)).skipped.map((s) => s.slug)).toEqual(['handle-left']);
		expect((await view(d2)).customPieces[0].libraryId).toBe(saved.id);
		expect(await applyLibraryPiece(db, d2, 'owner', saved.id)).toBeNull();
		expect(await status(async () => await applyLibraryPiece(db, d2, 'viewer', saved.id))).toBe(403);

		const b = await mk();
		expect(await applyLibraryPiece(db, b, 'owner', saved.id)).not.toBeNull();
	});

	it('does not apply default saved parts to a draft made through the setup flow', async () => {
		const b = await mk();
		const p = await addPiece(b);
		await saveToLibrary(db, 'owner', b, p.pieceId, { isDefault: true });
		const draft = await mk('draft', { setup: true });
		expect((await view(draft)).customPieces).toEqual([]);
		const wizard = await mk(undefined, { setup: true });
		expect((await view(wizard)).customPieces).toHaveLength(1);
	});
});

describe('Studio draft: promotion', () => {
	it('keeps skipped parts, pieces, plates, thumbnails and library links; the custom plate can be logged', async () => {
		const id = await mk('draft');
		const p = await addPiece(id, { replaces: ['handle-left'] });
		const saved = await saveToLibrary(db, 'owner', id, p.pieceId);
		await skipParts(db, id, 'owner', { slugs: ['handle-right'], skip: true });
		const before = await view(id);
		const dir = join(uploadsDir(), 'plates', id);
		expect(existsSync(dir)).toBe(true);

		await promoteDraft(db, id, 'owner');
		const after = await view(id);
		expect(after.build.kind).toBe('build');
		expect(after.skipped.map((s) => s.slug).sort()).toEqual(['handle-left', 'handle-right']);
		expect(after.customPieces).toHaveLength(1);
		expect(after.customPieces[0].libraryId).toBe(saved.id);
		expect(after.plates.map((x) => x.number)).toEqual(before.plates.map((x) => x.number));
		expect(after.plates.filter(isCustomPlate)).toHaveLength(2);
		expect(existsSync(dir)).toBe(true);
		expect(await grams(id)).toBeCloseTo(
			filamentStats(before).reduce((a, f) => a + f.total, 0),
			5
		);

		const plate = after.plates.filter(isCustomPlate)[0];
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			plateNumber: plate.number,
			grams: 10
		});
		expect((await view(id)).runs).toHaveLength(1);
	});

	it('clears library links when a draft moves to another workspace', async () => {
		const id = await mk('draft');
		const p = await addPiece(id);
		await saveToLibrary(db, 'owner', id, p.pieceId);
		await db
			.update(organization)
			.set({ metadata: JSON.stringify({ personal: true }) })
			.where(eq(organization.id, 'org1'));
		await db
			.insert(organization)
			.values({ id: 'org2', name: 'Chapter 2', slug: 'c2', createdAt: new Date() });
		await db.insert(member).values({
			id: 'm-o2',
			organizationId: 'org2',
			userId: 'owner',
			role: 'owner',
			createdAt: new Date()
		});
		await moveBuild(db, id, 'owner', { organizationId: 'org2' });
		expect((await first(db.select().from(builds).where(eq(builds.id, id))))!.organizationId).toBe(
			'org2'
		);
		expect((await view(id)).customPieces).toHaveLength(1);
		expect(
			(await first(db.select().from(buildCustomPieces).where(eq(buildCustomPieces.buildId, id))))!
				.libraryId
		).toBeNull();
	});
});
