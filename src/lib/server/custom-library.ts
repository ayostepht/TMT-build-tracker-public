/**
 * The workspace's saved custom parts (issue 113, part 2).
 *
 * A maker can save a custom piece of a build to the workspace ("Save for new builds"). The library keeps
 * per-plate summaries only (name, time, grams per filament role, part role, prints): never the 3MF, and
 * in this prototype no thumbnails. A saved part can then be added to any build of the same workspace in
 * one step (`applyLibraryPiece`) or to every new build by default (`isDefault`, applied by `createBuild`
 * through `applyLibraryPieceTx`), so time and filament are estimated from the start.
 *
 * Access: every row belongs to one organization. Reads are for members, writes for editors and owners;
 * an id from another workspace is a 404, never trusted.
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { MAX_CUSTOM_PIECES, MAX_CUSTOM_PLATES } from '#lib/domain/custom.ts';
import { isObj, type Obj } from '#lib/domain/guards.ts';
import type { BuildView } from '#lib/domain/types.ts';
import { ApiError, buildAccess, requireEditor, requireMember } from './access';
import {
	MAX_RUNS,
	cleanGrams,
	cleanPieceName,
	cleanSeconds,
	customPlateLabel,
	insertCustomPieceTx,
	ownPlateName,
	scaleGrams,
	type NewPiecePlate
} from './builds/custom-pieces';
import { livePrintingSlugs, mutateBuild } from './builds/actions';
import { loadBuildView } from './builds/view';
import { advisoryLock, first, type Db, type DbOrTx } from './db';
import {
	buildCustomPieces,
	buildPlates,
	templateFilamentRoles,
	templateParts,
	user,
	workspaceCustomPieces,
	type LibraryPlate
} from './db/schema';
import { emitBuildEvent } from './events';
import { defaultTemplate, listTemplatesFor } from './templates/fork';
import type { ThreeMfSummary } from '#lib/domain/threemf.ts';

/** Most saved custom parts one workspace can hold. */
export const MAX_LIBRARY_PIECES = 50;

export type LibraryRow = typeof workspaceCustomPieces.$inferSelect;

/** What the API and the UI see of a saved part (no creator, no file data). */
export interface LibraryPieceView {
	id: string;
	name: string;
	fileName: string | null;
	sliced: boolean;
	templateId: string | null;
	replaces: string[];
	plates: {
		/** Position in the saved part (0-based): what `updateLibraryPiece` `plates[].index` means. */
		index: number;
		name: string;
		estSeconds: number | null;
		grams: number | null;
		role: string;
		runs: number;
	}[];
	isDefault: boolean;
	/** All prints of all plates, seconds (plates without a time count 0). */
	totalSeconds: number;
	/** All prints of all plates, grams (plates without grams count 0). */
	totalGrams: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const toView = (r: LibraryRow): LibraryPieceView => {
	const plates = r.plates ?? [];
	return {
		id: r.id,
		name: r.name,
		fileName: r.fileName,
		sliced: r.sliced,
		templateId: r.templateId,
		replaces: r.replaces ?? [],
		plates: plates.map((p, i) => ({
			index: i,
			name: p.name,
			estSeconds: p.estSeconds,
			grams: p.grams,
			role: p.role,
			runs: p.runs
		})),
		isDefault: r.isDefault,
		totalSeconds: plates.reduce((n, p) => n + (p.estSeconds ?? 0) * p.runs, 0),
		totalGrams: round2(plates.reduce((n, p) => n + (p.grams ?? 0) * p.runs, 0))
	};
};

/** The workspace's saved parts, oldest first (members only; 404 to anyone else). */
export async function listLibrary(
	db: DbOrTx,
	orgId: string,
	userId: string
): Promise<LibraryPieceView[]> {
	await requireMember(db, orgId, userId);
	return (await listLibraryRows(db, orgId)).map(toView);
}

/** The rows of a workspace's library, oldest first. No access check: callers have one. */
export async function listLibraryRows(db: DbOrTx, orgId: string): Promise<LibraryRow[]> {
	return await db
		.select()
		.from(workspaceCustomPieces)
		.where(eq(workspaceCustomPieces.organizationId, orgId))
		.orderBy(
			asc(workspaceCustomPieces.createdAt),
			asc(workspaceCustomPieces.name),
			asc(workspaceCustomPieces.id)
		);
}

/**
 * A row of this workspace by id. `share` takes a row lock (`for share`) that lasts to the end of the
 * caller's transaction: a concurrent delete of the row waits for it, so a build never ends up linked to a
 * saved part that was deleted a moment before.
 */
async function rowOf(
	db: DbOrTx,
	orgId: string,
	libId: unknown,
	share = false
): Promise<LibraryRow> {
	if (typeof libId !== 'string') throw new ApiError(404, 'Not found');
	const q = db.select().from(workspaceCustomPieces).where(eq(workspaceCustomPieces.id, libId));
	const row = await first(share ? q.for('share') : q);
	// a row of another workspace is as good as missing
	if (!row || row.organizationId !== orgId) throw new ApiError(404, 'Not found');
	return row;
}

/** Tell the build's open pages (after the commit, never inside a transaction). */
async function announce(db: DbOrTx, buildId: string, userId: string, kind: string): Promise<void> {
	const u = await first(db.select({ name: user.name }).from(user).where(eq(user.id, userId)));
	emitBuildEvent(buildId, {
		type: 'changed',
		kind,
		by: u?.name ?? null,
		at: new Date().toISOString()
	});
}

/**
 * The per-plate summaries of a build's custom piece as the library keeps them: the typed time wins over
 * the file's, grams are the plate's (typed or file) with the per-color split, role is the part's color.
 */
async function piecePlates(
	tx: DbOrTx,
	view: BuildView,
	piece: typeof buildCustomPieces.$inferSelect
): Promise<LibraryPlate[]> {
	const buildId = view.build.id;
	const rows = await tx
		.select()
		.from(buildPlates)
		.where(and(eq(buildPlates.buildId, buildId), eq(buildPlates.source, `custom:${piece.id}`)))
		.orderBy(asc(buildPlates.number));
	return rows.map((r) => {
		const slug = r.parts[0];
		const part = piece.parts.find((p) => p.slug === slug);
		const role = view.parts.find((p) => p.slug === slug)?.role ?? part?.role ?? '';
		return {
			name: ownPlateName(r.name, piece.name) ?? r.name,
			estSeconds: r.manualEstSeconds ?? r.estSeconds ?? null,
			grams: r.slicerGrams ?? null,
			filamentGrams: { ...(r.filamentGrams ?? {}) },
			role,
			runs: r.runs,
			thumb: false
		};
	});
}

/**
 * Save a custom piece of a build to its workspace's library and link the piece to the row. The typed time
 * of a plate wins over the file's. Saving a piece that is already linked to a library row changes nothing
 * and returns that row. Editors and owners; drafts refuse it. At most `MAX_LIBRARY_PIECES` per workspace.
 */
export async function saveToLibrary(
	db: Db,
	userId: string,
	buildId: string,
	pieceId: string,
	opts: { isDefault?: boolean } = {}
): Promise<LibraryPieceView> {
	const access = await buildAccess(db, buildId, userId);
	if (!access) throw new ApiError(404, 'Not found');
	if (!access.canEdit) throw new ApiError(403, 'Your role cannot edit');
	if (access.kind === 'draft')
		throw new ApiError(400, 'Drafts have no build tracking. Make it a build first.');
	if (opts.isDefault !== undefined && typeof opts.isDefault !== 'boolean')
		throw new ApiError(400, 'isDefault must be true or false');
	const row = await db.transaction(async (tx) => {
		// The count below and the insert (and the "already saved?" check) must not interleave with another save
		// in this workspace: one lock per workspace library.
		await advisoryLock(tx, `custom-library:${access.organizationId}`);
		const view = await loadBuildView(tx, buildId, userId);
		if (!view) throw new ApiError(404, 'Not found');
		const piece = await first(
			tx
				.select()
				.from(buildCustomPieces)
				.where(and(eq(buildCustomPieces.id, pieceId), eq(buildCustomPieces.buildId, buildId)))
		);
		if (!piece) throw new ApiError(404, 'Custom piece not found');
		if (piece.libraryId) {
			const linked = await first(
				tx
					.select()
					.from(workspaceCustomPieces)
					.where(
						and(
							eq(workspaceCustomPieces.id, piece.libraryId),
							eq(workspaceCustomPieces.organizationId, access.organizationId)
						)
					)
			);
			if (linked) return linked;
		}
		const have =
			(
				await first(
					tx
						.select({ n: count() })
						.from(workspaceCustomPieces)
						.where(eq(workspaceCustomPieces.organizationId, access.organizationId))
				)
			)?.n ?? 0;
		if (have >= MAX_LIBRARY_PIECES)
			throw new ApiError(
				400,
				`A workspace can keep at most ${MAX_LIBRARY_PIECES} saved custom parts. Delete one first.`
			);
		const plates = await piecePlates(tx, view, piece);
		if (!plates.length) throw new ApiError(400, 'This custom piece has no plates to save');
		const [saved] = await tx
			.insert(workspaceCustomPieces)
			.values({
				organizationId: access.organizationId,
				name: piece.name,
				fileName: piece.fileName,
				sliced: piece.sliced,
				templateId: view.build.templateId ?? null,
				replaces: [...(piece.replaces ?? [])],
				plates,
				isDefault: opts.isDefault === true,
				createdBy: userId
			})
			.returning();
		await tx
			.update(buildCustomPieces)
			.set({ libraryId: saved.id })
			.where(eq(buildCustomPieces.id, pieceId));
		return saved;
	});
	await announce(db, buildId, userId, 'custom.library');
	return toView(row);
}

/**
 * The saved plates with the typed `plates: [{ index, estSeconds?, grams? }]` applied (`index` is the 0-based
 * position; `null` clears a value). A new grams value rescales the plate's per-color grams, or puts them on
 * the plate's color when there are none.
 */
function editedPlates(current: LibraryPlate[], v: unknown): LibraryPlate[] {
	if (!Array.isArray(v) || !v.length || v.length > MAX_CUSTOM_PLATES)
		throw new ApiError(400, 'plates must be a list of plates to change');
	const next = current.map((p) => ({ ...p, filamentGrams: { ...(p.filamentGrams ?? {}) } }));
	const seen = new Set<number>();
	for (const e of v) {
		if (!isObj(e)) throw new ApiError(400, 'Each plate change must be an object');
		const ch = e as Obj;
		const i = ch.index;
		if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= next.length)
			throw new ApiError(400, 'index must be the position of a plate of the saved part');
		if (seen.has(i)) throw new ApiError(400, 'A plate can be listed only once');
		seen.add(i);
		const p = next[i];
		if (ch.estSeconds !== undefined)
			p.estSeconds = ch.estSeconds === null ? null : cleanSeconds(ch.estSeconds, 'estSeconds');
		if (ch.grams !== undefined) {
			if (ch.grams === null) {
				p.grams = null;
				p.filamentGrams = {};
			} else {
				const g = cleanGrams(ch.grams);
				p.grams = g;
				p.filamentGrams = Object.keys(p.filamentGrams).length
					? scaleGrams(p.filamentGrams, g)
					: p.role
						? { [p.role]: g }
						: {};
			}
		}
	}
	return next;
}

/** Rename a saved part, switch "in new builds by default" or correct its plates' time and grams (editors and owners). */
export async function updateLibraryPiece(
	db: Db,
	userId: string,
	orgId: string,
	libId: string,
	body: unknown
): Promise<LibraryPieceView> {
	await requireEditor(db, orgId, userId);
	await rowOf(db, orgId, libId);
	if (!isObj(body)) throw new ApiError(400, 'Invalid body');
	const b = body as Obj;
	return await db.transaction(async (tx) => {
		// the plates edit is read-modify-write: one writer at a time per saved part
		await advisoryLock(tx, `custom-library-row:${libId}`);
		const row = await rowOf(tx, orgId, libId);
		const set: Partial<typeof workspaceCustomPieces.$inferInsert> = {};
		if (b.name !== undefined) set.name = cleanPieceName(b.name);
		if (b.isDefault !== undefined) {
			if (typeof b.isDefault !== 'boolean')
				throw new ApiError(400, 'isDefault must be true or false');
			set.isDefault = b.isDefault;
		}
		if (b.plates !== undefined) set.plates = editedPlates(row.plates ?? [], b.plates);
		if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update');
		await tx.update(workspaceCustomPieces).set(set).where(eq(workspaceCustomPieces.id, libId));
		return toView(await rowOf(tx, orgId, libId));
	});
}

/**
 * Overwrite a saved part from a build's custom piece as it is now (name, file name, per-plate time, grams,
 * color and prints), so a correction made in one build is what new builds get. Editors and owners of the
 * workspace; the build and its piece must belong to the workspace and the piece must be linked to this row.
 * Builds that already have the part are not changed.
 */
export async function refreshLibraryPiece(
	db: Db,
	userId: string,
	orgId: string,
	libId: string,
	buildId: string,
	pieceId: string
): Promise<LibraryPieceView> {
	await requireEditor(db, orgId, userId);
	await rowOf(db, orgId, libId);
	const access = await buildAccess(db, buildId, userId);
	if (!access || access.organizationId !== orgId) throw new ApiError(404, 'Not found');
	if (!access.canEdit) throw new ApiError(403, 'Your role cannot edit');
	if (access.kind === 'draft')
		throw new ApiError(400, 'Drafts have no build tracking. Make it a build first.');
	if (typeof pieceId !== 'string') throw new ApiError(404, 'Custom piece not found');
	const row = await db.transaction(async (tx) => {
		await advisoryLock(tx, `custom-library-row:${libId}`);
		const view = await loadBuildView(tx, buildId, userId);
		if (!view) throw new ApiError(404, 'Not found');
		const piece = await first(
			tx
				.select()
				.from(buildCustomPieces)
				.where(and(eq(buildCustomPieces.id, pieceId), eq(buildCustomPieces.buildId, buildId)))
		);
		if (!piece) throw new ApiError(404, 'Custom piece not found');
		if (piece.libraryId !== libId)
			throw new ApiError(400, 'This custom part is not linked to that saved part');
		const plates = await piecePlates(tx, view, piece);
		if (!plates.length) throw new ApiError(400, 'This custom piece has no plates to save');
		// still there? (the row was read before the transaction; a delete may have come in between)
		await rowOf(tx, orgId, libId);
		const [updated] = await tx
			.update(workspaceCustomPieces)
			.set({ name: piece.name, fileName: piece.fileName, sliced: piece.sliced, plates })
			.where(eq(workspaceCustomPieces.id, libId))
			.returning();
		return updated;
	});
	await announce(db, buildId, userId, 'custom.library');
	return toView(row);
}

/** Delete a saved part. Builds keep the pieces they already have; their "Saved" mark goes (editors and owners). */
export async function deleteLibraryPiece(
	db: Db,
	userId: string,
	orgId: string,
	libId: string
): Promise<void> {
	await requireEditor(db, orgId, userId);
	await rowOf(db, orgId, libId);
	const touched = await db.transaction(async (tx) => {
		await advisoryLock(tx, `custom-library-row:${libId}`);
		// The row goes first: when a build is adding this saved part right now (it holds a share lock on the row),
		// the delete waits for that build to commit, and the unlink below then sees its new piece too.
		const gone = await tx
			.delete(workspaceCustomPieces)
			.where(
				and(eq(workspaceCustomPieces.id, libId), eq(workspaceCustomPieces.organizationId, orgId))
			)
			.returning({ id: workspaceCustomPieces.id });
		if (!gone.length) return [];
		const linked = await tx
			.update(buildCustomPieces)
			.set({ libraryId: null })
			.where(eq(buildCustomPieces.libraryId, libId))
			.returning({ buildId: buildCustomPieces.buildId });
		return [...new Set(linked.map((l) => l.buildId))];
	});
	for (const id of touched) await announce(db, id, userId, 'custom.library');
}

export interface ApplyLibraryResult {
	pieceId: string;
	/** Numbers of the piece's plates (before any automatic re-arrange). */
	plates: number[];
	/** Kit parts that were marked "Not printing". */
	skipped: string[];
	/** Their names, for messages and the activity row. */
	skippedNames: string[];
}

/**
 * Put a saved part into a build, inside the caller's transaction (no access check on the user, no activity
 * row, no event: `applyLibraryPiece` and `createBuild` add those). Plates are numbered after the highest
 * plate. Roles the build lacks fall back to its first filament role (grams of unknown roles fold into it).
 * Replaced kit parts are marked "Not printing" only when the build's kit is the one the part was saved
 * from, and only those that are active kit parts and not printing; the rest are left alone.
 *
 * Returns null when the build already holds a piece from this saved part (nothing changes). Throws a 404
 * for a saved part of another workspace, a 400 for a draft, for a build without filament colors and when
 * the build's custom piece or plate limits are reached.
 */
export async function applyLibraryPieceTx(
	tx: DbOrTx,
	view: BuildView,
	lib: LibraryRow,
	userId: string
): Promise<ApplyLibraryResult | null> {
	if (lib.organizationId !== view.build.organizationId) throw new ApiError(404, 'Not found');
	if (view.build.kind === 'draft')
		throw new ApiError(400, 'Drafts have no build tracking. Make it a build first.');
	if (view.customPieces.some((c) => c.libraryId === lib.id)) return null;
	const libPlates = lib.plates ?? [];
	if (!libPlates.length) throw new ApiError(400, 'This saved part has no plates');
	if (view.customPieces.length >= MAX_CUSTOM_PIECES)
		throw new ApiError(400, `A build can have at most ${MAX_CUSTOM_PIECES} custom pieces`);
	const have = view.customPieces.reduce((n, c) => n + c.plates.length, 0);
	if (have + libPlates.length > MAX_CUSTOM_PLATES)
		throw new ApiError(
			400,
			`A build can have at most ${MAX_CUSTOM_PLATES} custom plates (${have} now, ${libPlates.length} more asked for)`
		);
	const roleKeys = new Set(view.filaments.map((f) => f.key));
	const first = view.filaments[0]?.key;
	if (!first) throw new ApiError(400, 'This build has no filament colours yet');
	const mapRole = (r: string) => (roleKeys.has(r) ? r : first);

	// kit parts it replaces: same kit, active kit parts, not printing; anything else stays as it is
	let replaces: string[] = [];
	if (lib.templateId && lib.templateId === view.build.templateId && (lib.replaces ?? []).length) {
		const live = await livePrintingSlugs(tx, view.build.id);
		const kit = new Map(view.parts.filter((p) => !p.custom).map((p) => [p.slug, p]));
		replaces = [...new Set(lib.replaces)].filter(
			(s) => kit.has(s) && view.state[s]?.status !== 'Printing' && !live.has(s)
		);
	}

	const multi = libPlates.length > 1;
	const plates: NewPiecePlate[] = libPlates.map((p, i) => {
		const fg: Record<string, number> = {};
		for (const [role, g] of Object.entries(p.filamentGrams ?? {})) {
			if (!(g > 0)) continue;
			const key = mapRole(role);
			fg[key] = round2((fg[key] ?? 0) + g);
		}
		return {
			label: customPlateLabel(lib.name, p.name, multi, i + 1),
			role: mapRole(p.role),
			// a sliced file's numbers are the file's; for a part saved without one they were typed
			estSeconds: lib.sliced ? p.estSeconds : null,
			manualEstSeconds: lib.sliced ? null : p.estSeconds,
			slicerGrams: p.grams,
			slicerGramsSource: p.grams ? (lib.sliced ? 'file' : 'user') : null,
			filamentGrams: fg,
			runs: p.runs,
			thumbSource: null
		};
	});
	const made = await insertCustomPieceTx(
		tx,
		view,
		{
			name: lib.name,
			fileName: lib.fileName,
			sliced: lib.sliced,
			replaces,
			libraryId: lib.id,
			plates
		},
		userId,
		[]
	);
	return made;
}

/**
 * Add a saved part to a build (editors and owners; drafts refuse it). The saved part must belong to the
 * build's workspace. Answers null when the build already has a piece from it.
 */
export async function applyLibraryPiece(
	db: Db,
	buildId: string,
	userId: string,
	libId: string
): Promise<{ pieceId: string; plates: number[]; skipped: string[] } | null> {
	let result: ApplyLibraryResult | null = null;
	// `mutateBuild` holds the build's advisory lock, so the piece and plate caps are counted on a view nobody
	// else can change meanwhile; the saved part's row is share-locked until the commit (see `rowOf`).
	await mutateBuild(db, buildId, userId, async (tx, view) => {
		if (view.build.kind === 'draft')
			throw new ApiError(400, 'Drafts have no build tracking. Make it a build first.');
		const lib = await rowOf(tx, view.build.organizationId, libId, true);
		result = await applyLibraryPieceTx(tx, view, lib, userId);
		if (!result) return { kind: 'custom.add', payload: {}, skip: true };
		return {
			kind: 'custom.add',
			payload: {
				pieceId: result.pieceId,
				name: lib.name,
				fileName: lib.fileName,
				plates: [],
				sliced: lib.sliced,
				replaced: result.skippedNames,
				fromLibrary: true
			}
		};
	});
	if (!result) return null;
	const r = result as ApplyLibraryResult;
	// A re-arrange right after the add renumbers custom plates: read the final numbers.
	const final = (
		await db
			.select({ n: buildPlates.number })
			.from(buildPlates)
			.where(and(eq(buildPlates.buildId, buildId), eq(buildPlates.source, `custom:${r.pieceId}`)))
	)
		.map((x) => x.n)
		.sort((a, c) => a - c);
	return { pieceId: r.pieceId, plates: final.length ? final : r.plates, skipped: r.skipped };
}

/** Rows marked "in new builds by default" of a workspace, for `createBuild`. */
export async function defaultLibraryRows(db: DbOrTx, orgId: string): Promise<LibraryRow[]> {
	return await db
		.select()
		.from(workspaceCustomPieces)
		.where(
			and(
				eq(workspaceCustomPieces.organizationId, orgId),
				eq(workspaceCustomPieces.isDefault, true)
			)
		)
		.orderBy(
			asc(workspaceCustomPieces.createdAt),
			asc(workspaceCustomPieces.name),
			asc(workspaceCustomPieces.id)
		);
}

/** Rows of a workspace by id, oldest first (ids of other workspaces are left out). */
export async function libraryRowsByIds(
	db: DbOrTx,
	orgId: string,
	ids: string[]
): Promise<LibraryRow[]> {
	if (!ids.length) return [];
	return await db
		.select()
		.from(workspaceCustomPieces)
		.where(
			and(eq(workspaceCustomPieces.organizationId, orgId), inArray(workspaceCustomPieces.id, ids))
		)
		.orderBy(
			asc(workspaceCustomPieces.createdAt),
			asc(workspaceCustomPieces.name),
			asc(workspaceCustomPieces.id)
		);
}

// ---- creating a saved part by hand (no build, no file kept)

const MAX_REPLACES = 60;
const MAX_SLOTS = 32;
/* eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g;

/** A plate name: optional; control characters dropped, at most 80 characters. */
function cleanPlateName(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (typeof v !== 'string') throw new ApiError(400, 'A plate name must be text');
	return v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
}

/** What a form needs to build a saved part by hand: the kit it is for, its filament roles and part names. */
export interface LibraryTemplateOptions {
	templateId: string;
	name: string;
	roles: { key: string; name: string; material: string; hex: string }[];
	parts: { slug: string; name: string; section: string }[];
}

/** Roles and parts of the workspace's default kit (the oldest built-in template); members only. */
export async function libraryTemplateOptions(
	db: DbOrTx,
	orgId: string,
	userId: string
): Promise<LibraryTemplateOptions> {
	await requireMember(db, orgId, userId);
	const t = await defaultTemplate(db);
	return {
		templateId: t.id,
		name: t.name,
		roles: await db
			.select({
				key: templateFilamentRoles.key,
				name: templateFilamentRoles.name,
				material: templateFilamentRoles.material,
				hex: templateFilamentRoles.hex
			})
			.from(templateFilamentRoles)
			.where(eq(templateFilamentRoles.templateId, t.id))
			// Postgres has no implicit row order: the key order every other reader of the roles uses
			.orderBy(asc(templateFilamentRoles.key)),
		parts: await db
			.select({
				slug: templateParts.slug,
				name: templateParts.name,
				section: templateParts.section
			})
			.from(templateParts)
			.where(eq(templateParts.templateId, t.id))
			.orderBy(asc(templateParts.sort), asc(templateParts.slug))
	};
}

/**
 * Create a saved part without a build (editors and owners). Roles (`role`, `filamentGrams` keys) must be
 * filament roles of the kit and `replaces` part slugs of it; the kit is `templateId` (a built-in one or the
 * workspace's own copy: anything else is a 404) or the default built-in kit. Time and grams per print
 * (typed numbers: stored as typed). Without `filamentGrams` the grams count under `role`.
 */
export async function createLibraryPiece(
	db: Db,
	userId: string,
	orgId: string,
	input: unknown
): Promise<LibraryPieceView> {
	await requireEditor(db, orgId, userId);
	if (!isObj(input)) throw new ApiError(400, 'Invalid body');
	const b = input as Obj;
	const name = cleanPieceName(b.name);
	let fileName: string | null = null;
	if (b.fileName !== undefined && b.fileName !== null) {
		if (typeof b.fileName !== 'string') throw new ApiError(400, 'fileName must be text');
		fileName = b.fileName.replace(CONTROL, ' ').trim().slice(0, 255) || null;
	}
	for (const f of ['sliced', 'isDefault'] as const)
		if (b[f] !== undefined && typeof b[f] !== 'boolean')
			throw new ApiError(400, `${f} must be true or false`);

	// the kit: built-in or this workspace's own copy
	let templateId: string;
	if (b.templateId === undefined || b.templateId === null)
		templateId = (await defaultTemplate(db)).id;
	else {
		if (typeof b.templateId !== 'string') throw new ApiError(400, 'templateId must be text');
		if (!(await listTemplatesFor(db, orgId)).some((t) => t.id === b.templateId))
			throw new ApiError(404, 'Not found');
		templateId = b.templateId;
	}
	const roleKeys = new Set(
		(
			await db
				.select({ k: templateFilamentRoles.key })
				.from(templateFilamentRoles)
				.where(eq(templateFilamentRoles.templateId, templateId))
		).map((r) => r.k)
	);
	let replaces: string[] = [];
	if (b.replaces !== undefined) {
		if (!Array.isArray(b.replaces) || b.replaces.length > MAX_REPLACES)
			throw new ApiError(400, `replaces must be a list of at most ${MAX_REPLACES} parts`);
		const slugs = new Set(
			(
				await db
					.select({ s: templateParts.slug })
					.from(templateParts)
					.where(eq(templateParts.templateId, templateId))
			).map((r) => r.s)
		);
		for (const s of b.replaces)
			if (typeof s !== 'string' || !slugs.has(s))
				throw new ApiError(400, 'Unknown part in replaces');
		replaces = [...new Set(b.replaces as string[])];
	}

	if (!Array.isArray(b.plates) || !b.plates.length || b.plates.length > MAX_CUSTOM_PLATES)
		throw new ApiError(400, `A saved part needs 1 to ${MAX_CUSTOM_PLATES} plates`);
	const plates: LibraryPlate[] = b.plates.map((raw: unknown) => {
		if (!isObj(raw)) throw new ApiError(400, 'Each plate must be an object');
		const p = raw as Obj;
		if (typeof p.role !== 'string' || !roleKeys.has(p.role))
			throw new ApiError(400, 'role must be a filament color of the kit');
		const runs = p.runs ?? 1;
		if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS)
			throw new ApiError(400, `runs must be a whole number from 1 to ${MAX_RUNS}`);
		const estSeconds =
			p.estSeconds === undefined || p.estSeconds === null
				? null
				: cleanSeconds(p.estSeconds, 'estSeconds');
		let grams = p.grams === undefined || p.grams === null ? null : cleanGrams(p.grams, 'grams');
		let fg: Record<string, number> = {};
		if (p.filamentGrams !== undefined && p.filamentGrams !== null) {
			if (!isObj(p.filamentGrams)) throw new ApiError(400, 'filamentGrams must be an object');
			const entries = Object.entries(p.filamentGrams as Obj);
			if (entries.length > MAX_SLOTS)
				throw new ApiError(400, 'filamentGrams lists too many colors');
			for (const [k, v] of entries) {
				if (!roleKeys.has(k))
					throw new ApiError(400, 'filamentGrams must use filament colors of the kit');
				fg[k] = cleanGrams(v, 'filamentGrams');
			}
			const sum = round2(Object.values(fg).reduce((a, c) => a + c, 0));
			if (!Object.keys(fg).length) fg = {};
			else if (grams === null) grams = sum;
			else fg = scaleGrams(fg, grams);
		}
		return {
			name: cleanPlateName(p.name),
			estSeconds,
			grams,
			filamentGrams: fg,
			role: p.role,
			runs,
			thumb: false
		};
	});

	return toView(
		await db.transaction(async (tx) => {
			// count, then insert: one writer at a time per workspace library
			await advisoryLock(tx, `custom-library:${orgId}`);
			const have =
				(
					await first(
						tx
							.select({ n: count() })
							.from(workspaceCustomPieces)
							.where(eq(workspaceCustomPieces.organizationId, orgId))
					)
				)?.n ?? 0;
			if (have >= MAX_LIBRARY_PIECES)
				throw new ApiError(
					400,
					`A workspace can keep at most ${MAX_LIBRARY_PIECES} saved custom parts. Delete one first.`
				);
			const [row] = await tx
				.insert(workspaceCustomPieces)
				.values({
					organizationId: orgId,
					name,
					fileName,
					sliced: b.sliced === true,
					templateId,
					replaces,
					plates,
					isDefault: b.isDefault === true,
					createdBy: userId
				})
				.returning();
			return row;
		})
	);
}

// ---- reading a file for that form (nothing is stored)

export interface InspectedFile {
	fileName: string;
	sliced: boolean;
	printer: string | null;
	warnings: string[];
	/** The file's filament slots (the keys of a plate's `filamentGrams`). */
	filaments: { slot: string; name?: string; material: string; color: string | null }[];
	plates: {
		index: number;
		name: string;
		estSeconds: number | null;
		grams: number | null;
		runsHint: number;
		filamentGrams: Record<string, number>;
		/** The slots this plate uses, with their grams. */
		filaments: {
			slot: string;
			name?: string;
			material: string;
			color: string | null;
			grams: number;
		}[];
	}[];
}

/** Text taken from a file, echoed to the browser: control characters dropped, capped. */
const echo = (v: unknown, max: number): string =>
	typeof v === 'string'
		? v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
		: '';

/** The part of a parsed 3MF the "add a saved part" form uses: numbers and slots, no thumbnails, no objects. */
export function inspectSummary(fileName: string, s: ThreeMfSummary): InspectedFile {
	const slot = (i: number) => s.filaments.find((f) => f.index === i);
	const info = (key: string) => {
		const f = slot(Number(key));
		const name = echo(f?.name, 80);
		return {
			slot: key,
			...(name ? { name } : {}),
			material: echo(f?.type, 40),
			color: typeof f?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(f.color) ? f.color : null
		};
	};
	return {
		fileName: echo(fileName, 255) || 'upload.3mf',
		sliced: s.sliced,
		printer: echo(s.printer, 80) || null,
		warnings: s.warnings.slice(0, 20).map((w) => echo(w, 300)),
		filaments: s.filaments.slice(0, MAX_SLOTS).map((f) => info(String(f.index))),
		plates: s.plates.slice(0, 200).map((p) => {
			const fg: Record<string, number> = {};
			if (s.sliced)
				for (const [k, g] of Object.entries(p.filamentGrams ?? {}).slice(0, MAX_SLOTS)) fg[k] = g;
			return {
				index: p.index,
				name: echo(p.name, 80),
				estSeconds: s.sliced ? p.estSeconds : null,
				grams: s.sliced ? p.grams : null,
				runsHint: p.runsHint,
				filamentGrams: fg,
				filaments: Object.entries(fg).map(([k, g]) => ({ ...info(k), grams: g }))
			};
		})
	};
}
