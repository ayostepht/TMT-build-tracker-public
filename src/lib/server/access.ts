import { and, eq } from 'drizzle-orm';
import type { BuildKind, TeamRole } from '#lib/domain/types.ts';
import { first, type DbOrTx } from './db';
import { adminEmails } from './config';
import { builds, member, siteAdmin, user } from './db/schema';

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export function normalizeRole(role: string | null | undefined): TeamRole {
	const first = (role ?? '').split(',')[0].trim();
	return first === 'owner' || first === 'editor' ? first : 'viewer';
}

export function canEditRole(role: TeamRole): boolean {
	return role === 'owner' || role === 'editor';
}

/** Role of the user in the organization, or null when not a member. */
export async function getMemberRole(
	db: DbOrTx,
	orgId: string,
	userId: string
): Promise<TeamRole | null> {
	const row = await first(
		db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
	);
	return row ? normalizeRole(row.role) : null;
}

/** 404 when not a member (does not leak the organization's existence). */
export async function requireMember(db: DbOrTx, orgId: string, userId: string): Promise<TeamRole> {
	const role = await getMemberRole(db, orgId, userId);
	if (!role) throw new ApiError(404, 'Not found');
	return role;
}

export async function requireEditor(db: DbOrTx, orgId: string, userId: string): Promise<TeamRole> {
	const role = await requireMember(db, orgId, userId);
	if (!canEditRole(role)) throw new ApiError(403, 'Your role cannot edit');
	return role;
}

export async function requireOwner(db: DbOrTx, orgId: string, userId: string): Promise<TeamRole> {
	const role = await requireMember(db, orgId, userId);
	if (role !== 'owner') throw new ApiError(403, 'Only chapter owners can do this');
	return role;
}

/** Access to a build via its organization. Null when the build does not exist or the user is not a member. */
export async function buildAccess(
	db: DbOrTx,
	buildId: string,
	userId: string
): Promise<{
	organizationId: string;
	role: TeamRole;
	canEdit: boolean;
	kind: BuildKind;
} | null> {
	const b = await first(
		db
			.select({ organizationId: builds.organizationId, kind: builds.kind })
			.from(builds)
			.where(eq(builds.id, buildId))
	);
	if (!b) return null;
	const role = await getMemberRole(db, b.organizationId, userId);
	if (!role) return null;
	return {
		organizationId: b.organizationId,
		role,
		canEdit: canEditRole(role),
		kind: b.kind === 'draft' ? 'draft' : 'build'
	};
}

export interface SiteAdminCandidate {
	id: string;
	email?: string | null;
	/** Required `true`; pass the session user (it carries it). */
	emailVerified?: boolean | null;
}

/**
 * Site admins manage install-wide things (template kits, 3D models, who else is an admin).
 * A user is a site admin through exactly one of these sources, checked in this order, and only with
 * a provider-verified email (`emailVerified`), so an unverified address can never inherit the role:
 * 1. `config`: the email is in `ADMIN_EMAILS` (comma-separated, case-insensitive). The environment
 *    is authoritative and additive: it can never be revoked in the app and never needs a row.
 * 2. `granted`: the user has a `site_admin` row (granted by another site admin).
 * There is no "first user" admin, and demo users (never verified) cannot be admins.
 */
export type SiteAdminSource = 'config' | 'granted';

export async function siteAdminSource(
	db: DbOrTx,
	u: SiteAdminCandidate
): Promise<SiteAdminSource | null> {
	if (u.emailVerified !== true) return null;
	const email = (u.email ?? '').trim().toLowerCase();
	if (email && adminEmails().includes(email)) return 'config';
	if (
		await first(
			db.select({ id: siteAdmin.userId }).from(siteAdmin).where(eq(siteAdmin.userId, u.id))
		)
	)
		return 'granted';
	return null;
}

export async function isSiteAdmin(db: DbOrTx, u: SiteAdminCandidate): Promise<boolean> {
	return (await siteAdminSource(db, u)) !== null;
}

/** Guard for site-admin endpoints and pages (caller must already be signed in): 404 for everyone else (does not reveal the admin area). */
export async function requireSiteAdmin(db: DbOrTx, u: SiteAdminCandidate): Promise<void> {
	if (!(await isSiteAdmin(db, u))) throw new ApiError(404, 'Not found');
}

// ---- demo sandbox users (see `server/demo`)

/** Anything with a user id; `isDemo` is on the session user (a Better Auth additional field). */
export interface DemoCandidate {
	id: string;
	isDemo?: boolean | null;
}

export const DEMO_REFUSAL = 'This is not available in the demo. Sign in to use your own account.';

/** True for a demo sandbox user. Read from the session user (loaded from the database on every request). */
export function isDemoUser(u: DemoCandidate | null | undefined): boolean {
	return !!u && u.isDemo === true;
}

/**
 * Refuse (403) when the user is a demo sandbox user: no uploads, printers, teams or invitations,
 * gallery sharing or account export. Call it at the top of every server endpoint or action for
 * such a thing, before reading a request body, so the refusal is server-side whatever the UI shows.
 */
export function requireNotDemo(u: DemoCandidate | null | undefined): void {
	if (isDemoUser(u)) throw new ApiError(403, DEMO_REFUSAL);
}

/** Same check for code that only has a user id (loads the flag from the database). */
export async function requireNotDemoId(db: DbOrTx, userId: string): Promise<void> {
	const row = await first(db.select({ isDemo: user.isDemo }).from(user).where(eq(user.id, userId)));
	if (row?.isDemo) throw new ApiError(403, DEMO_REFUSAL);
}
