import { statSync } from 'node:fs';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { effectivePartRoles } from '#lib/domain/design.ts';
import { ApiError } from '../access';
import { diskHasRoom } from '../config';
import { loadBuildView, startedBuildIds } from '../builds/view';
import { advisoryLock, first, one, type DbOrTx } from '../db';
import {
	builds,
	colorDesigns,
	templateFilamentRoles,
	templateParts,
	templates,
	user
} from '../db/schema';
import {
	assertUnder,
	assertUploadRoom,
	countSavedDesigns,
	quotaLimit,
	snapshotWorkspace
} from '../quota';
import { listTeams } from '../teams';
import { canSeeDesign, canSeeDesignWith, coworkerIds, type DesignRow } from './access';
import {
	hasSnapshot,
	isPng,
	MAX_SNAPSHOT_BYTES,
	removeSnapshot,
	snapshotPath,
	writeSnapshot
} from './files';
import type { DesignRole } from './mutate';
import { isObj } from '#lib/domain/guards.ts';

export interface DesignSummary {
	id: string;
	slug: string;
	name: string;
	templateId: string;
	templateName: string;
	authorUserId: string | null;
	authorName: string | null;
	/** Listed in the shared gallery. */
	shared: boolean;
	/** The gallery design this was copied from, when it was. */
	copiedFromId: string | null;
	mine: boolean;
	createdAt: string;
	roles: DesignRole[];
	/** Parts per slot key (all template parts). */
	partCounts: Record<string, number>;
	hasSnapshot: boolean;
}

export interface DesignDetail extends DesignSummary {
	partRoles: Record<string, string>;
	/** Every template part with the slot this design gives it. */
	parts: { slug: string; name: string; section: string; role: string }[];
}

function bad(msg: string): never {
	throw new ApiError(400, msg);
}

function designName(v: unknown): string {
	if (typeof v !== 'string' || !v.trim() || v.length > 100) bad('name must be 1 to 100 characters');
	return v.trim();
}

function slugBase(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'design'
	);
}

export async function uniqueSlug(db: DbOrTx, name: string): Promise<string> {
	const base = slugBase(name);
	let slug = base;
	while (
		await first(
			db.select({ id: colorDesigns.id }).from(colorDesigns).where(eq(colorDesigns.slug, slug))
		)
	)
		slug = `${base}-${crypto.randomUUID().slice(0, 4)}`;
	return slug;
}

/** Design by id or slug (both are unique and URL-safe), only when the user may see it. */
export async function findDesign(db: DbOrTx, key: string, userId: string): Promise<DesignRow> {
	const d =
		(await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, key)))) ??
		(await first(db.select().from(colorDesigns).where(eq(colorDesigns.slug, key))));
	if (!d || !(await canSeeDesign(db, d, userId))) throw new ApiError(404, 'Not found');
	return d;
}

function requireAuthor(d: DesignRow, userId: string): void {
	if (d.authorUserId !== userId) throw new ApiError(403, 'Only the author can do this');
}

async function summarize(db: DbOrTx, rows: DesignRow[], userId: string): Promise<DesignSummary[]> {
	if (!rows.length) return [];
	const tplIds = [...new Set(rows.map((r) => r.templateId))];
	const tplNames = new Map(
		(
			await db
				.select({ id: templates.id, name: templates.name })
				.from(templates)
				.where(inArray(templates.id, tplIds))
		).map((t) => [t.id, t.name])
	);
	const defaults = new Map<string, Map<string, string>>();
	for (const id of tplIds)
		defaults.set(
			id,
			new Map(
				(
					await db
						.select({ slug: templateParts.slug, role: templateParts.defaultRole })
						.from(templateParts)
						.where(eq(templateParts.templateId, id))
				).map((p) => [p.slug, p.role])
			)
		);
	const authorIds = [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))];
	const authors = new Map(
		authorIds.length
			? (
					await db
						.select({ id: user.id, name: user.name })
						.from(user)
						.where(inArray(user.id, authorIds))
				).map((u) => [u.id, u.name])
			: []
	);
	return Promise.all(
		rows.map(async (d) => {
			const counts: Record<string, number> = {};
			for (const [slug, def] of defaults.get(d.templateId) ?? []) {
				const r = d.partRoles[slug] ?? def;
				counts[r] = (counts[r] ?? 0) + 1;
			}
			return {
				id: d.id,
				slug: d.slug,
				name: d.name,
				templateId: d.templateId,
				templateName: tplNames.get(d.templateId) ?? '',
				authorUserId: d.authorUserId,
				authorName: d.authorUserId ? (authors.get(d.authorUserId) ?? null) : null,
				shared: d.sharedAt !== null,
				copiedFromId: d.copiedFromDesignId,
				mine: d.authorUserId === userId,
				createdAt: d.createdAt.toISOString(),
				roles: d.roles,
				partCounts: counts,
				hasSnapshot: await hasSnapshot(d.id)
			};
		})
	);
}

/** Designs the user may see (their own, their co-members', and the seeded examples), newest first. */
export async function listDesigns(
	db: DbOrTx,
	userId: string,
	opts: { templateId?: string } = {}
): Promise<DesignSummary[]> {
	const all = await db
		.select()
		.from(colorDesigns)
		.orderBy(desc(colorDesigns.createdAt), asc(colorDesigns.name));
	const coworkers = await coworkerIds(db, userId);
	const rows = all.filter(
		(d) =>
			(!opts.templateId || d.templateId === opts.templateId) &&
			canSeeDesignWith(d, userId, coworkers)
	);
	return summarize(db, rows, userId);
}

export async function getDesignDetail(
	db: DbOrTx,
	key: string,
	userId: string
): Promise<DesignDetail> {
	const d = await findDesign(db, key, userId);
	const [s] = await summarize(db, [d], userId);
	const parts = (
		await db
			.select()
			.from(templateParts)
			.where(eq(templateParts.templateId, d.templateId))
			.orderBy(asc(templateParts.sort))
	).map((p) => ({
		slug: p.slug,
		name: p.name,
		section: p.section,
		role: d.partRoles[p.slug] ?? p.defaultRole
	}));
	return { ...s, partRoles: d.partRoles, parts };
}

/** Save a build's current colors as a design. Editors and owners of the build. */
export async function createDesign(
	db: DbOrTx,
	userId: string,
	body: unknown
): Promise<{ id: string; slug: string }> {
	if (!isObj(body)) bad('Invalid body');
	if (typeof body.buildId !== 'string') bad('buildId is required');
	const name = designName(body.name);
	const view = await loadBuildView(db, body.buildId, userId);
	if (!view) throw new ApiError(404, 'Not found');
	if (!view.canEdit) throw new ApiError(403, 'Your role cannot edit');
	const roles: DesignRole[] = view.filaments.map((f) => ({
		key: f.key,
		name: f.name,
		material: f.material,
		hex: f.hex
	}));
	// Count and insert under a per-user lock so parallel requests cannot both pass the quota.
	return db.transaction(async (tx) => {
		await advisoryLock(tx, `quota:designs:${userId}`);
		await assertUnder(tx, 'savedDesignsPerUser', () => countSavedDesigns(tx, userId), { userId });
		return one(
			tx
				.insert(colorDesigns)
				.values({
					templateId: view.build.templateId,
					slug: await uniqueSlug(tx, name),
					name,
					authorUserId: userId,
					roles,
					partRoles: effectivePartRoles(view)
				})
				.returning({ id: colorDesigns.id, slug: colorDesigns.slug })
		);
	});
}

/** Rename. Author only. (Sharing to the gallery has its own functions in gallery.ts.) */
export async function updateDesignMeta(
	db: DbOrTx,
	key: string,
	userId: string,
	body: unknown
): Promise<void> {
	if (!isObj(body)) bad('Invalid body');
	const d = await findDesign(db, key, userId);
	requireAuthor(d, userId);
	const set: Partial<typeof colorDesigns.$inferInsert> = {};
	if (body.name !== undefined) set.name = designName(body.name);
	if (!Object.keys(set).length) bad('Nothing to update');
	await db.update(colorDesigns).set(set).where(eq(colorDesigns.id, d.id));
}

/** Delete a design. Author only. Builds keep their own snapshot of the colors. */
export async function deleteDesign(db: DbOrTx, key: string, userId: string): Promise<void> {
	const d = await findDesign(db, key, userId);
	requireAuthor(d, userId);
	await db.delete(colorDesigns).where(eq(colorDesigns.id, d.id));
	await removeSnapshot(d.id);
}

/** Template slot keys that exist in the kit itself (used by the UI to tell built-in slots from added colors). */
export async function templateRoleKeys(db: DbOrTx, templateId: string): Promise<string[]> {
	return (
		await db
			.select({ k: templateFilamentRoles.key })
			.from(templateFilamentRoles)
			.where(eq(templateFilamentRoles.templateId, templateId))
			.orderBy(asc(templateFilamentRoles.key))
	).map((r) => r.k);
}

/** Store the PNG preview of a design. Author only; PNG up to 2 MB. */
export async function saveSnapshot(
	db: DbOrTx,
	key: string,
	userId: string,
	bytes: Uint8Array
): Promise<void> {
	const d = await findDesign(db, key, userId);
	requireAuthor(d, userId);
	if (bytes.length > MAX_SNAPSHOT_BYTES) throw new ApiError(413, 'Image is larger than 2 MB');
	if (!isPng(bytes)) bad('The preview must be a PNG image');
	if (!diskHasRoom()) throw new ApiError(507, 'The server is almost out of disk space');
	// Charged to the author's personal workspace; replacing a preview only adds the difference.
	if (quotaLimit('uploadBytesPerWorkspace') !== null || quotaLimit('uploadBytesPerUser') !== null) {
		const org = await snapshotWorkspace(db, userId);
		if (org) {
			let old = 0;
			try {
				old = statSync(snapshotPath(d.id)).size;
			} catch {
				/* no preview yet */
			}
			await assertUploadRoom(db, org, Math.max(1, bytes.length - old), { userId });
		}
	}
	await writeSnapshot(d.id, bytes);
}

/** Workspaces and builds the user can edit for a template, for "Start a build" and "Copy into my build". */
export async function editableTargets(
	db: DbOrTx,
	userId: string,
	templateId: string
): Promise<{
	workspaces: { id: string; name: string }[];
	builds: { id: string; name: string; workspaceName: string; started: boolean }[];
}> {
	const teams = (await listTeams(db, userId))
		.filter((t) => t.role === 'owner' || t.role === 'editor')
		.map((t) => ({ id: t.id, name: t.personal ? 'My builds' : t.name }));
	const byId = new Map(teams.map((t) => [t.id, t.name]));
	if (!teams.length) return { workspaces: [], builds: [] };
	const rows = await db
		.select({ id: builds.id, name: builds.name, org: builds.organizationId })
		.from(builds)
		.where(and(eq(builds.templateId, templateId), inArray(builds.organizationId, [...byId.keys()])))
		.orderBy(asc(builds.name));
	const startedIds = await startedBuildIds(
		db,
		rows.map((r) => r.id)
	);
	return {
		workspaces: teams,
		builds: rows.map((r) => ({
			id: r.id,
			name: r.name,
			workspaceName: byId.get(r.org) ?? '',
			// Started builds ask before a design is applied (see StartedApplyDialog).
			started: startedIds.has(r.id)
		}))
	};
}
