import { and, asc, count, desc, eq, gt, ne, or, lte } from 'drizzle-orm';
import type { TeamRole } from '#lib/domain/types.ts';
import { normalizeRole } from './access';
import { advisoryLock, first, type Db, type DbOrTx } from './db';
import { builds, invitation, member, organization } from './db/schema';
import { assertUnder, QuotaError, quotaLimit } from './quota';

export interface TeamSummary {
	id: string;
	name: string;
	slug: string;
	role: TeamRole;
	/** Personal workspace ("My builds"): one owner, no invitations. */
	personal: boolean;
}

/** Organization metadata is stored as a JSON string (or already parsed by an adapter). */
export function parseMetadata(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
	if (typeof raw !== 'string' || !raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function isPersonalMetadata(raw: unknown): boolean {
	return parseMetadata(raw).personal === true;
}

export async function isPersonalOrg(db: DbOrTx, orgId: string): Promise<boolean> {
	const row = await first(
		db
			.select({ metadata: organization.metadata })
			.from(organization)
			.where(eq(organization.id, orgId))
	);
	return !!row && isPersonalMetadata(row.metadata);
}

export async function buildCount(db: DbOrTx, orgId: string): Promise<number> {
	return (await first(
		db.select({ n: count() }).from(builds).where(eq(builds.organizationId, orgId))
	))!.n;
}

type Row = TeamSummary & { owner: string | null };

async function teamRows(db: DbOrTx, userId: string): Promise<Row[]> {
	return (
		await db
			.select({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				role: member.role,
				metadata: organization.metadata
			})
			.from(member)
			.innerJoin(organization, eq(organization.id, member.organizationId))
			.where(eq(member.userId, userId))
			.orderBy(asc(organization.name), asc(organization.id))
	).map(({ metadata, ...t }) => {
		const meta = parseMetadata(metadata);
		return {
			...t,
			role: normalizeRole(t.role),
			personal: meta.personal === true,
			owner: typeof meta.userId === 'string' ? meta.userId : null
		};
	});
}

function toSummary(r: Row): TeamSummary {
	return { id: r.id, name: r.name, slug: r.slug, role: r.role, personal: r.personal };
}

export async function listTeams(db: DbOrTx, userId: string): Promise<TeamSummary[]> {
	return (await teamRows(db, userId)).map(toSummary);
}

/** The user's own personal workspace, if they have one. */
export async function findPersonalWorkspace(
	db: DbOrTx,
	userId: string
): Promise<TeamSummary | null> {
	const row = (await teamRows(db, userId)).find((t) => t.personal && t.owner === userId);
	return row ? toSummary(row) : null;
}

async function uniqueSlug(db: DbOrTx, base: string): Promise<string> {
	let slug = base;
	while (
		await first(
			db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug))
		)
	)
		slug = `${base.slice(0, 35)}-${crypto.randomUUID().slice(0, 4)}`;
	return slug;
}

/** A taken-slug failure: our own check, Better Auth's check, or the unique index (23505). */
export function isSlugConflict(e: unknown): boolean {
	for (let err = e, i = 0; err && typeof err === 'object' && i < 5; i++) {
		const o = err as { code?: unknown; message?: unknown; cause?: unknown; body?: unknown };
		if (o.code === '23505') return true;
		const body = (o.body ?? {}) as { code?: unknown };
		if (body.code === 'ORGANIZATION_SLUG_ALREADY_TAKEN') return true;
		if (typeof o.message === 'string' && /slug.*(taken|exists)|organization_slug_/i.test(o.message))
			return true;
		err = o.cause;
	}
	return false;
}

/**
 * Create a team under a free slug. Better Auth creates the organization (check, then insert, on
 * its own connection), so the slug cannot be reserved by a lock held here. Instead pick a free
 * slug, call `create(slug)` and, when it loses a race for the same slug (two people creating
 * "Sunrise" at once), retry with the next random suffix. Returns the slug that was used.
 */
export async function createTeamWithSlug(
	db: DbOrTx,
	name: string,
	create: (slug: string) => Promise<unknown>
): Promise<string> {
	const base = slugify(name);
	let slug = await uniqueSlug(db, base);
	for (let attempt = 0; ; attempt++) {
		try {
			await create(slug);
			return slug;
		} catch (e) {
			if (attempt >= 6 || !isSlugConflict(e)) throw e;
			slug = `${base.slice(0, 35)}-${crypto.randomUUID().slice(0, 4)}`;
		}
	}
}

/**
 * Create the user's personal workspace: an organization flagged `personal` in its
 * metadata, with the user as its owner. Idempotent and race-safe: the existence check and the
 * insert run in one transaction behind an advisory lock per user (the sign-up hook and the
 * session hook can both call it at the same moment), and slug picking is serialised by a
 * second, global lock so two new accounts with the same name cannot choose the same slug.
 */
export async function ensurePersonalWorkspace(
	db: Db,
	u: { id: string; name: string }
): Promise<{ id: string; created: boolean }> {
	return db.transaction(async (tx) => {
		await advisoryLock(tx, 'personal-workspace:' + u.id);
		const existing = await findPersonalWorkspace(tx, u.id);
		if (existing) return { id: existing.id, created: false };
		await advisoryLock(tx, 'org-slug');
		const name = `${u.name.trim() || 'My'}'s builds`;
		const id = crypto.randomUUID();
		const now = new Date();
		await tx.insert(organization).values({
			id,
			name,
			slug: await uniqueSlug(tx, slugify(name)),
			createdAt: now,
			metadata: JSON.stringify({ personal: true, userId: u.id })
		});
		await tx.insert(member).values({
			id: crypto.randomUUID(),
			organizationId: id,
			userId: u.id,
			role: 'owner',
			createdAt: now
		});
		return { id, created: true };
	});
}

/** Number of pending, unexpired invitations addressed to this email. */
export async function pendingInvitationCount(db: DbOrTx, email: string): Promise<number> {
	return (
		await db
			.select({ email: invitation.email })
			.from(invitation)
			.where(and(eq(invitation.status, 'pending'), gt(invitation.expiresAt, new Date())))
	).filter((i) => i.email.toLowerCase() === email.toLowerCase()).length;
}

/** Only same-origin relative paths are allowed as post-login redirects. */
export function safeRedirect(v: string | null | undefined): string | null {
	// Same-origin relative path only: one leading slash, no backslash or control character (browsers
	// strip tabs and newlines, so "/\t/evil.example" would otherwise become "//evil.example").
	// eslint-disable-next-line no-control-regex
	return v && v.startsWith('/') && !v.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(v)
		? v
		: null;
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'team'
	);
}

// ---- chapter quotas (shared by our routes and the Better Auth organization plugin hooks)

/** Memberships of a user in real chapters (the personal workspace is not a chapter). */
async function chapterRows(db: DbOrTx, userId: string) {
	return (
		await db
			.select({ orgId: member.organizationId, role: member.role, metadata: organization.metadata })
			.from(member)
			.innerJoin(organization, eq(organization.id, member.organizationId))
			.where(eq(member.userId, userId))
	).filter((r) => !isPersonalMetadata(r.metadata));
}

/** Chapters the user created (owns). `chaptersPerUser`. */
export async function countChaptersOwned(db: DbOrTx, userId: string): Promise<number> {
	return (await chapterRows(db, userId)).filter((r) => normalizeRole(r.role) === 'owner').length;
}

/** Chapters the user belongs to, created or joined. `membershipsPerUser`. */
export async function countChapterMemberships(db: DbOrTx, userId: string): Promise<number> {
	return (await chapterRows(db, userId)).length;
}

export async function countChapterMembers(db: DbOrTx, orgId: string): Promise<number> {
	return (
		(await first(db.select({ n: count() }).from(member).where(eq(member.organizationId, orgId))))
			?.n ?? 0
	);
}

export async function countPendingInvites(db: DbOrTx, orgId: string): Promise<number> {
	return (
		(
			await first(
				db
					.select({ n: count() })
					.from(invitation)
					.where(
						and(
							eq(invitation.organizationId, orgId),
							eq(invitation.status, 'pending'),
							gt(invitation.expiresAt, new Date())
						)
					)
			)
		)?.n ?? 0
	);
}

/** How many used-up (cancelled, rejected, expired) invitations a chapter keeps. */
export const KEEP_OLD_INVITATIONS = 50;

/**
 * Durable bound for the invite/cancel loop: delete the chapter's old invitations that can no longer
 * be used (cancelled, rejected, or pending but expired) beyond the newest `keep`. Open invitations and
 * accepted ones are never touched (only pending ones are ever read by the app). Call when creating one.
 */
export async function pruneOldInvitations(
	db: DbOrTx,
	orgId: string,
	keep = KEEP_OLD_INVITATIONS
): Promise<number> {
	const stale = await db
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				eq(invitation.organizationId, orgId),
				ne(invitation.status, 'accepted'),
				or(ne(invitation.status, 'pending'), lte(invitation.expiresAt, new Date()))
			)
		)
		.orderBy(desc(invitation.createdAt), desc(invitation.id))
		.limit(100000)
		.offset(keep);
	let n = 0;
	for (const r of stale)
		n += (
			await db.delete(invitation).where(eq(invitation.id, r.id)).returning({ id: invitation.id })
		).length;
	return n;
}

type ChapterQuotaKey =
	'chaptersPerUser' | 'membershipsPerUser' | 'membersPerChapter' | 'pendingInvitesPerChapter';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Sentences shown to the user (the generic quota text does not name teams). */
const CHAPTER_SENTENCES: Record<ChapterQuotaKey, (limit: number) => string> = {
	chaptersPerUser: (l) =>
		l === 0
			? 'Teams cannot be created on this server. Ask the admin.'
			: `You already created ${plural(l, 'team')}, the limit on this server. Delete one or ask the admin.`,
	membershipsPerUser: (l) =>
		l === 0
			? 'Joining teams is not allowed on this server. Ask the admin.'
			: `You already belong to ${plural(l, 'team')}, the limit on this server. Leave one first or ask the admin.`,
	membersPerChapter: (l) =>
		`This team already has ${plural(l, 'member')}, the limit on this server. Remove someone or ask the admin.`,
	pendingInvitesPerChapter: (l) =>
		l === 0
			? 'Invitations are not allowed on this server. Ask the admin.'
			: `This team already has ${plural(l, 'open invitation')}, the limit on this server. Cancel one or ask the admin.`
};

async function chapterQuota(
	db: DbOrTx,
	key: ChapterQuotaKey,
	countFn: () => Promise<number>,
	userId: string,
	scope?: string
): Promise<void> {
	try {
		await assertUnder(db, key, countFn, { userId, scope });
	} catch (e) {
		if (e instanceof QuotaError) throw new QuotaError(CHAPTER_SENTENCES[key](quotaLimit(key) ?? 0));
		throw e;
	}
}

/**
 * Check-only: Better Auth's organization plugin inserts outside any transaction of ours, so these
 * are best-effort bounds under concurrency (two simultaneous creates can both pass the check).
 */
/** Throws `QuotaError` when the user may not create another chapter. */
export async function assertCanCreateChapter(db: DbOrTx, userId: string): Promise<void> {
	await chapterQuota(db, 'chaptersPerUser', () => countChaptersOwned(db, userId), userId);
	await chapterQuota(db, 'membershipsPerUser', () => countChapterMemberships(db, userId), userId);
}

/** Throws `QuotaError` when the user may not join the chapter (their own cap, then the chapter's). */
export async function assertCanJoinChapter(
	db: DbOrTx,
	userId: string,
	orgId: string
): Promise<void> {
	await chapterQuota(db, 'membershipsPerUser', () => countChapterMemberships(db, userId), userId);
	await assertCanAddMember(db, userId, orgId);
}

/** The chapter's own size cap (`membersPerChapter`). */
export async function assertCanAddMember(db: DbOrTx, userId: string, orgId: string): Promise<void> {
	await chapterQuota(db, 'membersPerChapter', () => countChapterMembers(db, orgId), userId, orgId);
}

/** Throws `QuotaError` when the chapter already has its limit of open invitations. */
export async function assertCanInvite(db: DbOrTx, userId: string, orgId: string): Promise<void> {
	await chapterQuota(
		db,
		'pendingInvitesPerChapter',
		() => countPendingInvites(db, orgId),
		userId,
		orgId
	);
}
