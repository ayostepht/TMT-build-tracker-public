import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BuildKind, TeamRole } from '#lib/domain/types.ts';
import { first, type DbOrTx } from './db';
import { adminEmails, isPublicMode } from './config';
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
	/** Required `true` in public mode; pass the session user (it carries it). */
	emailVerified?: boolean | null;
}

/**
 * Site admins manage install-wide things (template kits, 3D models, who else is an admin).
 * A user is a site admin through exactly one of these sources, checked in this order:
 * 1. `config`: the email is in `ADMIN_EMAILS` (comma-separated, case-insensitive). The environment
 *    is authoritative and additive: it can never be revoked in the app and never needs a row.
 * 2. `granted`: the user has a `site_admin` row (granted by another site admin).
 * 3. `first` (self-hosted only): the earliest-created account, only while BOTH hold: no
 *    `site_admin` row exists AND no existing account's email is in `ADMIN_EMAILS`. The first grant
 *    ends this rule, and so does an `ADMIN_EMAILS` admin having an account (revoking the last
 *    granted row, or the earliest account being deleted, never promotes anyone by accident).
 *    `ADMIN_EMAILS` naming an address with no account yet does not end it: the first account stays
 *    admin until that person signs up. So that granting never removes the original admin's own
 *    access, `grantSiteAdmin` writes a row for the granter too when they were admin by this rule.
 * Public mode (SSO-only): every source also needs a provider-verified email (`emailVerified`),
 * and there is no `first` source, no "first user".
 * Self-hosted emails are unverified: whoever registers a listed address gets the role.
 */
export type SiteAdminSource = 'config' | 'granted' | 'first';

export async function siteAdminSource(
	db: DbOrTx,
	u: SiteAdminCandidate
): Promise<SiteAdminSource | null> {
	const publicMode = isPublicMode();
	if (publicMode && u.emailVerified !== true) return null;
	const email = (u.email ?? '').trim().toLowerCase();
	if (email && adminEmails().includes(email)) return 'config';
	if (
		await first(
			db.select({ id: siteAdmin.userId }).from(siteAdmin).where(eq(siteAdmin.userId, u.id))
		)
	)
		return 'granted';
	if (publicMode) return null;
	if (await first(db.select({ id: siteAdmin.userId }).from(siteAdmin).limit(1))) return null;
	const envEmails = adminEmails();
	// One indexed lookup (Better Auth stores emails lower-case).
	if (
		envEmails.length &&
		(await first(
			db.select({ id: user.id }).from(user).where(inArray(user.email, envEmails)).limit(1)
		))
	)
		return null;
	// The rule is computed on read, never stored, so two simultaneous sign-ups cannot both become
	// admin: the earliest `created_at` wins, ties broken by id (stable, arbitrary).
	const firstUser = await first(
		db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt), asc(user.id)).limit(1)
	);
	return firstUser?.id === u.id ? 'first' : null;
}

export async function isSiteAdmin(db: DbOrTx, u: SiteAdminCandidate): Promise<boolean> {
	return (await siteAdminSource(db, u)) !== null;
}

/** Guard for site-admin endpoints and pages (caller must already be signed in): 404 for everyone else (does not reveal the admin area). */
export async function requireSiteAdmin(db: DbOrTx, u: SiteAdminCandidate): Promise<void> {
	if (!(await isSiteAdmin(db, u))) throw new ApiError(404, 'Not found');
}
