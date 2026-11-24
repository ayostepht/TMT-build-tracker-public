/**
 * The hosted edition runs requests in parallel against Postgres: every count-then-insert of custom parts
 * (build caps, workspace library cap) and every plate number (max + 1) must hold under concurrent requests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MAX_CUSTOM_PIECES, isCustomPlate } from '#lib/domain/custom.ts';
import { ApiError } from './access';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import {
	buildCustomPieces,
	buildPlates,
	member,
	organization,
	templates,
	user,
	workspaceCustomPieces,
	type LibraryPlate
} from './db/schema';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { createBuild } from './builds/create';
import { loadBuildView } from './builds/view';
import { removeCustomPiece } from './builds/custom-pieces';
import {
	MAX_LIBRARY_PIECES,
	applyLibraryPiece,
	createLibraryPiece,
	deleteLibraryPiece,
	saveToLibrary
} from './custom-library';

let db: Db;
let templateId: string;

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'org1', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' });
	await db.insert(member).values({
		id: 'm-owner',
		organizationId: 'org1',
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
});
afterEach(() => dropTestDb(db));

const mk = () =>
	createBuild(db, { organizationId: 'org1', templateId, designId: null, name: 'B' }, 'owner');
const plate = (n: number): LibraryPlate => ({
	name: `P${n}`,
	estSeconds: 600,
	grams: 5,
	filamentGrams: { primary: 5 },
	role: 'primary',
	runs: 1,
	thumb: false
});
async function libRows(n: number, from = 0, nPlates = 2) {
	if (!n) return [];
	return await db
		.insert(workspaceCustomPieces)
		.values(
			Array.from({ length: n }, (_, i) => ({
				organizationId: 'org1',
				name: `Row ${from + i}`,
				sliced: false,
				templateId,
				plates: Array.from({ length: nPlates }, (_, k) => plate(i + k))
			}))
		)
		.returning();
}
const outcome = async (p: Promise<unknown>) => {
	try {
		await p;
		return 'ok';
	} catch (e) {
		return e instanceof ApiError ? e.status : 'error';
	}
};

describe('parallel requests on one build', () => {
	it('several saved parts added at once get distinct plate numbers after the kit plates', async () => {
		const id = await mk();
		const rows = await libRows(4);
		const kitTop = Math.max(
			...(await loadBuildView(db, id, 'owner'))!.plates.map((p) => p.number),
			0
		);
		const res = await Promise.all(
			rows.map((r) => outcome(applyLibraryPiece(db, id, 'owner', r.id)))
		);
		expect(res).toEqual(['ok', 'ok', 'ok', 'ok']);
		const nums = (await db.select().from(buildPlates).where(eq(buildPlates.buildId, id)))
			.filter((p) => isCustomPlate({ source: p.source }))
			.map((p) => p.number)
			.sort((a, b) => a - b);
		expect(nums).toEqual(Array.from({ length: 8 }, (_, i) => kitTop + 1 + i));
	});

	it('the piece cap holds when two adds race for the last place', async () => {
		const id = await mk();
		const rows = await libRows(MAX_CUSTOM_PIECES + 1, 0, 1);
		for (let i = 0; i < MAX_CUSTOM_PIECES - 1; i++)
			await applyLibraryPiece(db, id, 'owner', rows[i].id);
		const res = await Promise.all([
			outcome(applyLibraryPiece(db, id, 'owner', rows[MAX_CUSTOM_PIECES - 1].id)),
			outcome(applyLibraryPiece(db, id, 'owner', rows[MAX_CUSTOM_PIECES].id))
		]);
		expect(res.slice().sort()).toEqual([400, 'ok']);
		const n = (await db.select().from(buildCustomPieces).where(eq(buildCustomPieces.buildId, id)))
			.length;
		expect(n).toBe(MAX_CUSTOM_PIECES);
	});

	it('the same saved part added twice at once is added once', async () => {
		const id = await mk();
		const [r] = await libRows(1);
		const res = await Promise.all([
			applyLibraryPiece(db, id, 'owner', r.id),
			applyLibraryPiece(db, id, 'owner', r.id)
		]);
		expect(res.filter((x) => x === null)).toHaveLength(1);
		expect((await loadBuildView(db, id, 'owner'))!.customPieces).toHaveLength(1);
	});
});

describe('parallel requests on one workspace library', () => {
	it('creating parts by hand never passes the cap', async () => {
		await libRows(MAX_LIBRARY_PIECES - 1);
		const res = await Promise.all(
			[1, 2, 3].map((i) =>
				outcome(
					createLibraryPiece(db, 'owner', 'org1', {
						name: `New ${i}`,
						plates: [{ role: 'primary' }]
					})
				)
			)
		);
		expect(res.filter((r) => r === 'ok')).toHaveLength(1);
		expect(res.filter((r) => r === 400)).toHaveLength(2);
		expect(
			(
				await db
					.select()
					.from(workspaceCustomPieces)
					.where(eq(workspaceCustomPieces.organizationId, 'org1'))
			).length
		).toBe(MAX_LIBRARY_PIECES);
	});

	it('saving two build pieces at once never passes the cap, and saving one piece twice saves it once', async () => {
		const [a, b] = [await mk(), await mk()];
		const [lr] = await libRows(1);
		await applyLibraryPiece(db, a, 'owner', lr.id);
		await applyLibraryPiece(db, b, 'owner', lr.id);
		// two pieces of builds that are not linked to the saved part (the link is cut), cap one short
		await db.update(buildCustomPieces).set({ libraryId: null });
		await db.delete(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, lr.id));
		await libRows(MAX_LIBRARY_PIECES - 1);
		const pa = (await loadBuildView(db, a, 'owner'))!.customPieces[0].id;
		const pb = (await loadBuildView(db, b, 'owner'))!.customPieces[0].id;
		const res = await Promise.all([
			outcome(saveToLibrary(db, 'owner', a, pa)),
			outcome(saveToLibrary(db, 'owner', b, pb))
		]);
		expect(res.slice().sort()).toEqual([400, 'ok']);
		// the same piece twice: one row
		await db.delete(workspaceCustomPieces).where(eq(workspaceCustomPieces.name, 'Row 0'));
		await db.update(buildCustomPieces).set({ libraryId: null }).where(eq(buildCustomPieces.id, pa));
		const before = (await db.select().from(workspaceCustomPieces)).length;
		const [s1, s2] = await Promise.all([
			saveToLibrary(db, 'owner', a, pa),
			saveToLibrary(db, 'owner', a, pa)
		]);
		expect(s1.id).toBe(s2.id);
		expect((await db.select().from(workspaceCustomPieces)).length).toBe(before + 1);
	});

	it('deleting a saved part while a build adds it leaves no piece pointing at a deleted row', async () => {
		for (let i = 0; i < 5; i++) {
			const id = await mk();
			const [r] = await libRows(1, i);
			await Promise.all([
				outcome(applyLibraryPiece(db, id, 'owner', r.id)),
				outcome(deleteLibraryPiece(db, 'owner', 'org1', r.id))
			]);
			const left = await first(
				db.select().from(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id))
			);
			expect(left).toBeUndefined();
			const linked = await db
				.select()
				.from(buildCustomPieces)
				.where(and(eq(buildCustomPieces.buildId, id), eq(buildCustomPieces.libraryId, r.id)));
			expect(linked).toEqual([]);
		}
	});
});

describe('removing a piece', () => {
	it('is refused with 409 once a print log exists, and the piece stays', async () => {
		const id = await mk();
		const [r] = await libRows(1);
		const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
		const piece = (await loadBuildView(db, id, 'owner'))!.customPieces[0];
		expect(piece.id).toBe(out.pieceId);
		// a piece with a print log cannot be removed
		const { addRun } = await import('./builds/actions');
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			partSlug: piece.parts[0],
			grams: 5
		});
		await expect(removeCustomPiece(db, id, 'owner', piece.id)).rejects.toMatchObject({
			status: 409
		});
		expect((await loadBuildView(db, id, 'owner'))!.customPieces).toHaveLength(1);
	});
});
