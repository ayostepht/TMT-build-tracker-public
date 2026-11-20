/**
 * The shared design gallery: color designs a maker chose to list for every signed-in user.
 *
 * - Sharing sets `color_designs.shared_at` / `shared_by`; unsharing clears them. Only the author
 *   shares or unshares; a site admin can hide any design (moderation).
 * - Everything public about a shared design is the name, colors, preview, kit name and the
 *   sharer's display name. Never an email, never the team (teams can be private).
 * - A copy ("Use this design") is a normal private design of the viewer. It keeps only
 *   `copied_from_design_id`; later edits, unsharing or deleting the original don't touch it.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { colorFamily, type FamilyId } from '#lib/domain/swatch-picker.ts';
import { ApiError, requireNotDemoId, requireSiteAdmin, type SiteAdminCandidate } from '../access';
import { advisoryLock, first, one, type DbOrTx } from '../db';
import { colorDesigns, designShareEvents, templates, user } from '../db/schema';
import { assertUnder, countSavedDesigns } from '../quota';
import { type DesignRow } from './access';
import { findDesign, uniqueSlug } from './designs';
import { hasSnapshot } from './files';
import type { DesignRole } from './mutate';

export const GALLERY_PAGE_SIZE = 24;
export const GALLERY_MAX_PAGE_SIZE = 48;
/** Share actions one person may do in 24 hours (sharing the same design again counts again). */
export const SHARES_PER_DAY = 20;
/** Share events older than this are pruned when someone shares (the daily limit needs 24 hours). */
const SHARE_EVENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_EVENT_PRUNE_BATCH = 200;
const FAMILY_IDS = new Set<string>([
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
	'brown'
]);

export interface GalleryItem {
	id: string;
	slug: string;
	name: string;
	templateId: string;
	templateName: string;
	/** Part slug to slot key, so the card can draw the design on the chair when it has no saved picture. */
	partRoles: Record<string, string>;
	/** Display name of the person who shared it (never an email). */
	sharerName: string;
	sharedAt: string;
	roles: DesignRole[];
	hasSnapshot: boolean;
	/** Other makers who saved a copy. */
	copies: number;
	mine: boolean;
}

export interface GalleryPage {
	items: GalleryItem[];
	total: number;
	page: number;
	pageSize: number;
	pages: number;
}

/**
 * The name shown next to a shared design: the display name, or for an email-shaped name the part
 * before the "@" (first word). Never contains an "@".
 */
export function publicSharerName(name: string | null | undefined): string {
	const n = (name ?? '').trim();
	if (!n) return 'A maker';
	if (n.includes('@')) {
		const word = n
			.split('@')[0]
			.split(/[\s._+-]+/)[0]
			.trim();
		return word ? word.slice(0, 40) : 'A maker';
	}
	return n.slice(0, 60);
}

function likeEscape(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function sharerNames(db: DbOrTx, rows: DesignRow[]): Promise<Map<string, string>> {
	const ids = [
		...new Set(rows.map((r) => r.sharedBy ?? r.authorUserId).filter((x): x is string => !!x))
	];
	if (!ids.length) return new Map();
	return new Map(
		(await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map(
			(u) => [u.id, publicSharerName(u.name)]
		)
	);
}

/** Makers other than the sharer who saved a copy of each design. */
export async function copyCounts(
	db: DbOrTx,
	rows: Pick<DesignRow, 'id' | 'sharedBy' | 'authorUserId'>[]
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (!rows.length) return out;
	const owner = new Map(rows.map((r) => [r.id, r.sharedBy ?? r.authorUserId]));
	const found = await db
		.select({
			from: colorDesigns.copiedFromDesignId,
			by: colorDesigns.authorUserId
		})
		.from(colorDesigns)
		.where(
			and(
				inArray(
					colorDesigns.copiedFromDesignId,
					rows.map((r) => r.id)
				),
				isNotNull(colorDesigns.authorUserId)
			)
		);
	const seen = new Map<string, Set<string>>();
	for (const f of found) {
		if (!f.from || !f.by || f.by === owner.get(f.from)) continue;
		const set = seen.get(f.from) ?? new Set<string>();
		set.add(f.by);
		seen.set(f.from, set);
	}
	for (const [id, set] of seen) out.set(id, set.size);
	return out;
}

async function toItems(db: DbOrTx, rows: DesignRow[], userId: string): Promise<GalleryItem[]> {
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
	const names = await sharerNames(db, rows);
	const copies = await copyCounts(db, rows);
	return Promise.all(
		rows.map(async (d) => ({
			id: d.id,
			slug: d.slug,
			name: d.name,
			templateId: d.templateId,
			templateName: tplNames.get(d.templateId) ?? '',
			partRoles: d.partRoles,
			sharerName: names.get(d.sharedBy ?? d.authorUserId ?? '') ?? 'A maker',
			sharedAt: (d.sharedAt ?? d.createdAt).toISOString(),
			roles: d.roles,
			hasSnapshot: await hasSnapshot(d.id),
			copies: copies.get(d.id) ?? 0,
			mine: d.authorUserId === userId
		}))
	);
}

/** Shared designs, newest first-shared first (sharing again doesn't move a design up). `q` matches the name; `family` keeps designs with a color in that family. */
export async function listGallery(
	db: DbOrTx,
	userId: string,
	opts: { q?: string; family?: string; page?: number; pageSize?: number } = {}
): Promise<GalleryPage> {
	const pageSize = Math.min(
		GALLERY_MAX_PAGE_SIZE,
		Math.max(1, Math.floor(opts.pageSize ?? GALLERY_PAGE_SIZE) || GALLERY_PAGE_SIZE)
	);
	const q = (opts.q ?? '').trim().slice(0, 100);
	const family = opts.family && FAMILY_IDS.has(opts.family) ? (opts.family as FamilyId) : null;
	const where = and(
		isNotNull(colorDesigns.sharedAt),
		// Only designs on the built-in kit are listed, whatever was shared before the share-time check.
		inArray(
			colorDesigns.templateId,
			db.select({ id: templates.id }).from(templates).where(isNull(templates.ownerOrgId))
		),
		q ? sql`${colorDesigns.name} ilike ${'%' + likeEscape(q) + '%'} escape '\\'` : undefined
	);
	const order = [
		desc(colorDesigns.firstSharedAt),
		desc(colorDesigns.sharedAt),
		asc(colorDesigns.id)
	] as const;
	let rows: DesignRow[];
	let total: number;
	let page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
	if (family) {
		// The family comes from the hex values, so it is filtered here, then paged.
		const all = (
			await db
				.select()
				.from(colorDesigns)
				.where(where)
				.orderBy(...order)
		).filter((d) => d.roles.some((r) => colorFamily(r.hex) === family));
		total = all.length;
		rows = all.slice((page - 1) * pageSize, page * pageSize);
	} else {
		total = (await one(db.select({ n: count() }).from(colorDesigns).where(where))).n;
		const pages = Math.max(1, Math.ceil(total / pageSize));
		page = Math.min(page, pages);
		rows = await db
			.select()
			.from(colorDesigns)
			.where(where)
			.orderBy(...order)
			.limit(pageSize)
			.offset((page - 1) * pageSize);
	}
	return {
		items: await toItems(db, rows, userId),
		total,
		page,
		pageSize,
		pages: Math.max(1, Math.ceil(total / pageSize))
	};
}

/** A shared design by id or slug. 404 when it is not (or no longer) in the gallery or sits on a team's kit copy, whoever asks. */
export async function findSharedDesign(db: DbOrTx, key: string): Promise<DesignRow> {
	const d =
		(await first(
			db
				.select()
				.from(colorDesigns)
				.where(and(eq(colorDesigns.id, key), isNotNull(colorDesigns.sharedAt)))
		)) ??
		(await first(
			db
				.select()
				.from(colorDesigns)
				.where(and(eq(colorDesigns.slug, key), isNotNull(colorDesigns.sharedAt)))
		));
	if (!d) throw new ApiError(404, 'Not found');
	// Only designs on a built-in kit are in the gallery; a team's kit copy is never reachable here.
	const tpl = await first(
		db.select({ owner: templates.ownerOrgId }).from(templates).where(eq(templates.id, d.templateId))
	);
	if (!tpl || tpl.owner) throw new ApiError(404, 'Not found');
	return d;
}

export async function getGalleryItem(
	db: DbOrTx,
	key: string,
	userId: string
): Promise<GalleryItem> {
	const [item] = await toItems(db, [await findSharedDesign(db, key)], userId);
	return item;
}

/**
 * Share a design you wrote. Idempotent. At most `SHARES_PER_DAY` shares per person per 24 hours.
 * Demo accounts may browse and copy from the gallery but never share (403), checked on the user row.
 */
export async function shareDesign(db: DbOrTx, key: string, userId: string): Promise<void> {
	await requireNotDemoId(db, userId);
	const d = await findDesign(db, key, userId);
	if (d.authorUserId !== userId) throw new ApiError(403, 'Only the author can share a design');
	if (d.sharedAt) return;
	if (d.hiddenFromGalleryAt)
		throw new ApiError(403, 'A site admin removed this design from the gallery.');
	const tpl = await first(
		db.select({ owner: templates.ownerOrgId }).from(templates).where(eq(templates.id, d.templateId))
	);
	if (tpl?.owner)
		throw new ApiError(
			400,
			"Designs on your team's own kit copy can't be shared to the gallery. Save it on the standard MakeGood kit first."
		);
	await db.transaction(async (tx) => {
		await advisoryLock(tx, `gallery:share:${userId}`);
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const recent = (
			await one(
				tx
					.select({ n: count() })
					.from(designShareEvents)
					.where(and(eq(designShareEvents.userId, userId), gte(designShareEvents.createdAt, since)))
			)
		).n;
		if (recent >= SHARES_PER_DAY)
			throw new ApiError(429, `You can share ${SHARES_PER_DAY} designs a day. Try again tomorrow.`);
		const now = new Date();
		await tx.insert(designShareEvents).values({ userId, designId: d.id, createdAt: now });
		// Events only matter for the daily limit: drop old ones (a bounded batch per share).
		await tx.delete(designShareEvents).where(
			inArray(
				designShareEvents.id,
				tx
					.select({ id: designShareEvents.id })
					.from(designShareEvents)
					.where(lt(designShareEvents.createdAt, new Date(now.getTime() - SHARE_EVENT_KEEP_MS)))
					.limit(SHARE_EVENT_PRUNE_BATCH)
			)
		);
		await tx
			.update(colorDesigns)
			.set({
				sharedAt: d.firstSharedAt ?? now,
				firstSharedAt: d.firstSharedAt ?? now,
				sharedBy: userId
			})
			.where(eq(colorDesigns.id, d.id));
	});
}

/** Stop sharing: the author, or a site admin hiding it (moderation, logged). Copies stay. */
export async function unshareDesign(
	db: DbOrTx,
	key: string,
	actor: SiteAdminCandidate
): Promise<{ hiddenByAdmin: boolean }> {
	const d = await findDesign(db, key, actor.id);
	if (!d.sharedAt) return { hiddenByAdmin: false };
	if (d.authorUserId === actor.id) {
		await db
			.update(colorDesigns)
			.set({ sharedAt: null, sharedBy: null })
			.where(eq(colorDesigns.id, d.id));
		return { hiddenByAdmin: false };
	}
	await requireSiteAdmin(db, actor);
	await db
		.update(colorDesigns)
		.set({ sharedAt: null, sharedBy: null, hiddenFromGalleryAt: new Date(), hiddenBy: actor.id })
		.where(eq(colorDesigns.id, d.id));
	console.warn(`[gallery] design ${d.id} hidden from the gallery by site admin ${actor.id}`);
	return { hiddenByAdmin: true };
}

/** A site admin lifts a gallery hide, so the author may share the design again (it stays unshared). */
export async function liftGalleryHide(
	db: DbOrTx,
	designId: string,
	actor: SiteAdminCandidate
): Promise<void> {
	await requireSiteAdmin(db, actor);
	const d = await first(db.select().from(colorDesigns).where(eq(colorDesigns.id, designId)));
	if (!d) throw new ApiError(404, 'Not found');
	await db
		.update(colorDesigns)
		.set({ hiddenFromGalleryAt: null, hiddenBy: null })
		.where(eq(colorDesigns.id, d.id));
	console.warn(`[gallery] gallery hide on design ${d.id} lifted by site admin ${actor.id}`);
}

/** Who hid a design and when. Site admins only (404 otherwise), so no caller can leak it. */
export async function hiddenInfo(
	db: DbOrTx,
	actor: SiteAdminCandidate,
	d: Pick<DesignRow, 'hiddenFromGalleryAt' | 'hiddenBy'>
): Promise<{ at: string; byName: string | null } | null> {
	await requireSiteAdmin(db, actor);
	if (!d.hiddenFromGalleryAt) return null;
	const by = d.hiddenBy
		? await first(db.select({ name: user.name }).from(user).where(eq(user.id, d.hiddenBy)))
		: null;
	return { at: d.hiddenFromGalleryAt.toISOString(), byName: by ? publicSharerName(by.name) : null };
}

export const HIDDEN_LIST_LIMIT = 200;

export interface HiddenDesign {
	id: string;
	name: string;
	templateName: string;
	/** Public name of the author (never an email). */
	authorName: string;
	hiddenAt: string;
	/** Public name of the site admin who hid it, when known. */
	hiddenByName: string | null;
}

/** Designs a site admin hid from the gallery and nobody lifted yet, newest first. Site admins only (404 otherwise). */
export async function listHiddenDesigns(
	db: DbOrTx,
	actor: SiteAdminCandidate
): Promise<{ designs: HiddenDesign[]; truncated: boolean }> {
	await requireSiteAdmin(db, actor);
	// One extra row tells whether the list was cut off.
	const fetched = await db
		.select()
		.from(colorDesigns)
		.where(isNotNull(colorDesigns.hiddenFromGalleryAt))
		.orderBy(desc(colorDesigns.hiddenFromGalleryAt), asc(colorDesigns.id))
		.limit(HIDDEN_LIST_LIMIT + 1);
	const truncated = fetched.length > HIDDEN_LIST_LIMIT;
	const rows = fetched.slice(0, HIDDEN_LIST_LIMIT);
	if (!rows.length) return { designs: [], truncated: false };
	const ids = [
		...new Set(rows.flatMap((r) => [r.authorUserId, r.hiddenBy]).filter((x): x is string => !!x))
	];
	const names = new Map(
		(await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map(
			(u) => [u.id, publicSharerName(u.name)]
		)
	);
	const tpls = new Map(
		(
			await db
				.select({ id: templates.id, name: templates.name })
				.from(templates)
				.where(inArray(templates.id, [...new Set(rows.map((r) => r.templateId))]))
		).map((t) => [t.id, t.name])
	);
	const designs = rows.map((r) => ({
		id: r.id,
		name: r.name,
		templateName: tpls.get(r.templateId) ?? '',
		authorName: (r.authorUserId && names.get(r.authorUserId)) || 'A maker',
		hiddenAt: r.hiddenFromGalleryAt!.toISOString(),
		hiddenByName: (r.hiddenBy && names.get(r.hiddenBy)) || null
	}));
	return { designs, truncated };
}

/**
 * "Use this design": save a private copy of a shared design as the viewer's own. Counts against
 * the same saved-designs quota as saving from a build.
 */
export async function copyGalleryDesign(
	db: DbOrTx,
	key: string,
	userId: string
): Promise<{ id: string; slug: string }> {
	const d = await findSharedDesign(db, key);
	return db.transaction(async (tx) => {
		await advisoryLock(tx, `quota:designs:${userId}`);
		await assertUnder(tx, 'savedDesignsPerUser', () => countSavedDesigns(tx, userId), { userId });
		return one(
			tx
				.insert(colorDesigns)
				.values({
					templateId: d.templateId,
					slug: await uniqueSlug(tx, d.name),
					name: d.name,
					authorUserId: userId,
					roles: d.roles,
					partRoles: d.partRoles,
					isPublic: false,
					copiedFromDesignId: d.id
				})
				.returning({ id: colorDesigns.id, slug: colorDesigns.slug })
		);
	});
}

/** "Copied from X by Y" for a design, only while the original is still in the gallery. */
export async function copiedFromCredit(
	db: DbOrTx,
	d: Pick<DesignRow, 'copiedFromDesignId'>
): Promise<{ name: string; slug: string; sharerName: string } | null> {
	if (!d.copiedFromDesignId) return null;
	const o = await first(
		db
			.select()
			.from(colorDesigns)
			.where(and(eq(colorDesigns.id, d.copiedFromDesignId), isNotNull(colorDesigns.sharedAt)))
	);
	if (!o) return null;
	const names = await sharerNames(db, [o]);
	return {
		name: o.name,
		slug: o.slug,
		sharerName: names.get(o.sharedBy ?? o.authorUserId ?? '') ?? 'A maker'
	};
}
