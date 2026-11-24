/**
 * The hosted edition runs requests in parallel against Postgres: every count-then-insert of custom parts
 * (build caps, workspace library cap) and every plate number (max + 1) must hold under concurrent requests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MAX_CUSTOM_PIECES, isCustomPlate } from '#lib/domain/custom.ts';
import { ApiError } from './access';
import { advisoryLock, first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import {
	buildCustomPieces,
	builds,
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
import { moveBuild } from './builds/actions';
import { recolorCustomPiece, removeCustomPiece, renameCustomPiece } from './builds/custom-pieces';
import {
	MAX_LIBRARY_PIECES,
	applyLibraryPiece,
	createLibraryPiece,
	deleteLibraryPiece,
	refreshLibraryPiece,
	saveToLibrary,
	updateLibraryPiece
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

describe('saved parts against builds that change at the same time', () => {
	it('a new build never links a default part that was deleted meanwhile', async () => {
		const [r] = await db
			.insert(workspaceCustomPieces)
			.values({
				organizationId: 'org1',
				name: 'Default',
				sliced: false,
				templateId,
				isDefault: true,
				plates: [plate(1)]
			})
			.returning();
		// the delete is open (not committed) while the build is created: the build lists the row, then the
		// delete commits; the build must notice and skip it
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
		const deleting = db.transaction(async (tx) => {
			await tx.delete(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id));
			await gate;
		});
		await sleep(150);
		const creating = createBuild(
			db,
			{ organizationId: 'org1', templateId, designId: null, name: 'N', setup: true },
			'owner'
		);
		await sleep(500);
		release();
		const [, buildId] = await Promise.all([deleting, creating]);
		expect(
			await db.select().from(buildCustomPieces).where(eq(buildCustomPieces.libraryId, r.id))
		).toEqual([]);
		expect((await loadBuildView(db, buildId, 'owner'))!.customPieces).toEqual([]);
	});

	it('save, refresh, rename, remove and delete of one piece in parallel never deadlock or leave a dangling link', async () => {
		for (let i = 0; i < 4; i++) {
			const id = await mk();
			const [r] = await libRows(1, i);
			const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
			const lib = (await first(
				db.select().from(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id))
			))!;
			expect(lib).toBeTruthy();
			const res = await Promise.all([
				outcome(refreshLibraryPiece(db, 'owner', 'org1', r.id, id, out.pieceId)),
				outcome(renameCustomPiece(db, id, 'owner', out.pieceId, { name: `Renamed ${i}` })),
				outcome(removeCustomPiece(db, id, 'owner', out.pieceId)),
				outcome(saveToLibrary(db, 'owner', id, out.pieceId)),
				outcome(deleteLibraryPiece(db, 'owner', 'org1', r.id))
			]);
			expect(res).not.toContain('error');
			// no build piece points at a saved part that is gone
			const ids = new Set((await db.select().from(workspaceCustomPieces)).map((x) => x.id));
			for (const p of await db.select().from(buildCustomPieces))
				if (p.libraryId) expect(ids.has(p.libraryId)).toBe(true);
		}
	});

	it('save and refresh wait for a change of the same build in progress, and see its result', async () => {
		const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
		for (const how of ['save', 'refresh'] as const) {
			const id = await mk();
			const [r] = await libRows(1, 0, 1);
			const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
			if (how === 'save') {
				await db.update(buildCustomPieces).set({ libraryId: null });
				await db.delete(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id));
			}
			const before = (await db.select().from(workspaceCustomPieces)).length;
			// a removal of the piece holds the build lock and has not committed yet
			let release!: () => void;
			const gate = new Promise<void>((res) => (release = res));
			const removing = db.transaction(async (tx) => {
				await advisoryLock(tx, `build:${id}`);
				await tx.delete(buildCustomPieces).where(eq(buildCustomPieces.id, out.pieceId));
				await gate;
			});
			await sleep(150);
			const racing =
				how === 'save'
					? outcome(saveToLibrary(db, 'owner', id, out.pieceId))
					: outcome(refreshLibraryPiece(db, 'owner', 'org1', r.id, id, out.pieceId));
			await sleep(400);
			release();
			const [, res] = await Promise.all([removing, racing]);
			expect(res).toBe(404);
			expect((await db.select().from(workspaceCustomPieces)).length).toBe(before);
		}
	});

	it('a save that comes after the piece was removed finds nothing and saves nothing', async () => {
		const id = await mk();
		const [r] = await libRows(1);
		const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
		await db.update(buildCustomPieces).set({ libraryId: null });
		await db.delete(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id));
		const [rm, sv] = await Promise.all([
			outcome(removeCustomPiece(db, id, 'owner', out.pieceId)),
			outcome(saveToLibrary(db, 'owner', id, out.pieceId))
		]);
		expect(rm).toBe('ok');
		const rows = await db.select().from(workspaceCustomPieces);
		// either the save ran first (one saved part) or it found no piece (404, nothing saved)
		expect(sv === 'ok' ? rows.length : sv === 404 ? rows.length : -1).toBe(sv === 'ok' ? 1 : 0);
	});
});

describe('custom parts round 2: read-modify-write paths', () => {
	it('two recolors of different parts of one piece in parallel both land', async () => {
		const id = await mk();
		const [r] = await libRows(1, 0, 2);
		const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
		const piece = (await loadBuildView(db, id, 'owner'))!.customPieces[0];
		expect(piece.parts).toHaveLength(2);
		const res = await Promise.all([
			outcome(
				recolorCustomPiece(db, id, 'owner', out.pieceId, {
					roles: { [piece.parts[0]]: { primary: 'accent' } }
				})
			),
			outcome(
				recolorCustomPiece(db, id, 'owner', out.pieceId, {
					roles: { [piece.parts[1]]: { primary: 'tire' } }
				})
			)
		]);
		expect(res).toEqual(['ok', 'ok']);
		const after = (await loadBuildView(db, id, 'owner'))!;
		const roleOf = (slug: string) => after.parts.find((x) => x.slug === slug)!.role;
		expect([roleOf(piece.parts[0]), roleOf(piece.parts[1])]).toEqual(['accent', 'tire']);
		const grams = (await db.select().from(buildPlates).where(eq(buildPlates.buildId, id)))
			.filter((p) => isCustomPlate({ source: p.source }))
			.sort((a, b) => a.number - b.number)
			.map((p) => p.filamentGrams);
		expect(grams).toEqual([{ accent: 5 }, { tire: 5 }]);
	});

	it('a recolor racing a rename or a removal never loses either change or errors', async () => {
		for (let i = 0; i < 3; i++) {
			const id = await mk();
			const [r] = await libRows(1, i, 1);
			const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
			const slug = (await loadBuildView(db, id, 'owner'))!.customPieces[0].parts[0];
			const res = await Promise.all([
				outcome(
					recolorCustomPiece(db, id, 'owner', out.pieceId, {
						roles: { [slug]: { primary: 'accent' } }
					})
				),
				outcome(renameCustomPiece(db, id, 'owner', out.pieceId, { name: `New ${i}` }))
			]);
			expect(res).toEqual(['ok', 'ok']);
			const piece = (await loadBuildView(db, id, 'owner'))!.customPieces[0];
			expect(piece.name).toBe(`New ${i}`);
			expect(piece.colors[0].roles).toEqual([{ role: 'accent', grams: 5 }]);
		}
	});

	it('plate edits of one saved part in parallel both land (one writer at a time)', async () => {
		const [r] = await libRows(1, 0, 2);
		const res = await Promise.all([
			outcome(updateLibraryPiece(db, 'owner', 'org1', r.id, { plates: [{ index: 0, runs: 3 }] })),
			outcome(
				updateLibraryPiece(db, 'owner', 'org1', r.id, { plates: [{ index: 1, name: 'Second' }] })
			),
			outcome(updateLibraryPiece(db, 'owner', 'org1', r.id, { replaces: [] }))
		]);
		expect(res).toEqual(['ok', 'ok', 'ok']);
		const row = (await first(
			db.select().from(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, r.id))
		))!;
		expect(row.plates[0].runs).toBe(3);
		expect(row.plates[1].name).toBe('Second');
	});

	it('an add with a replaces override waits for a saved-part edit in progress and sees its result', async () => {
		const id = await mk();
		const kit = (await loadBuildView(db, id, 'owner'))!.parts.filter((p) => !p.custom);
		const [r] = await libRows(1, 0, 1);
		const res = await Promise.all([
			outcome(updateLibraryPiece(db, 'owner', 'org1', r.id, { plates: [{ index: 0, runs: 4 }] })),
			outcome(applyLibraryPiece(db, id, 'owner', r.id, { replaces: [kit[0].slug] }))
		]);
		expect(res).toEqual(['ok', 'ok']);
		const v = (await loadBuildView(db, id, 'owner'))!;
		expect(v.skipped.map((s) => s.slug)).toEqual([kit[0].slug]);
		expect(v.customPieces[0].replaces).toEqual([kit[0].slug]);
	});
});

describe('moving a build while one of its custom parts is saved', () => {
	const personalAndTeam = async () => {
		await db
			.update(organization)
			.set({ metadata: JSON.stringify({ personal: true }) })
			.where(eq(organization.id, 'org1'));
		await db
			.insert(organization)
			.values({ id: 'org2', name: 'Team', slug: 'org2', createdAt: new Date() });
		await db.insert(member).values({
			id: 'm-owner-2',
			organizationId: 'org2',
			userId: 'owner',
			role: 'owner',
			createdAt: new Date()
		});
	};

	it('a save that waited for a move saves into the workspace the build is in now', async () => {
		await personalAndTeam();
		const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
		const id = await mk();
		const [r] = await libRows(1, 0, 1);
		const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
		await db.update(buildCustomPieces).set({ libraryId: null });
		// a move holds the build lock and has changed the workspace, but has not committed
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const moving = db.transaction(async (tx) => {
			await advisoryLock(tx, `build:${id}`);
			await tx.update(builds).set({ organizationId: 'org2' }).where(eq(builds.id, id));
			await gate;
		});
		await sleep(150);
		const saving = outcome(saveToLibrary(db, 'owner', id, out.pieceId));
		await sleep(400);
		release();
		const [, res] = await Promise.all([moving, saving]);
		expect(res).toBe('ok');
		const [piece] = await db
			.select()
			.from(buildCustomPieces)
			.where(eq(buildCustomPieces.id, out.pieceId));
		const saved = (await first(
			db.select().from(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, piece.libraryId!))
		))!;
		expect(saved.organizationId).toBe('org2');
	});

	it('save and move in parallel never leave a piece linked to another workspace than its build', async () => {
		await personalAndTeam();
		for (let i = 0; i < 3; i++) {
			const id = await mk();
			const [r] = await libRows(1, i, 1);
			const out = (await applyLibraryPiece(db, id, 'owner', r.id))!;
			await db
				.update(buildCustomPieces)
				.set({ libraryId: null })
				.where(eq(buildCustomPieces.id, out.pieceId));
			const res = await Promise.all([
				outcome(saveToLibrary(db, 'owner', id, out.pieceId)),
				outcome(moveBuild(db, id, 'owner', { organizationId: 'org2' }))
			]);
			expect(res).not.toContain('error');
			const [b] = await db.select().from(builds).where(eq(builds.id, id));
			const [piece] = await db
				.select()
				.from(buildCustomPieces)
				.where(eq(buildCustomPieces.id, out.pieceId));
			if (piece.libraryId) {
				const lib = (await first(
					db
						.select()
						.from(workspaceCustomPieces)
						.where(eq(workspaceCustomPieces.id, piece.libraryId))
				))!;
				expect(lib.organizationId).toBe(b.organizationId);
			}
		}
	});
});
