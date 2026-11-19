/** Who the site admins are, and the server-checked mutations that change it (rule: top of `access.ts`). */
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { ApiError, isSiteAdmin, siteAdminSource, type SiteAdminSource } from './access';
import { advisoryLock, first, type Db, type DbOrTx } from './db';
import { siteAdmin, user } from './db/schema';

export interface AdminActor {
	id: string;
	email?: string | null;
	emailVerified?: boolean | null;
}

export interface SiteAdminRow {
	id: string;
	name: string;
	email: string;
	source: SiteAdminSource;
}

async function requireAdmin(db: DbOrTx, actor: AdminActor): Promise<void> {
	if (!(await isSiteAdmin(db, actor))) throw new ApiError(403, 'Only site admins can do this');
}

const allUsers = (db: DbOrTx) =>
	db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: user.emailVerified
		})
		.from(user)
		.where(eq(user.isDemo, false))
		.orderBy(asc(user.name), asc(user.email));

/** Current site admins with where their role comes from. */
export async function listSiteAdmins(db: DbOrTx, actor: AdminActor): Promise<SiteAdminRow[]> {
	await requireAdmin(db, actor);
	const out: SiteAdminRow[] = [];
	for (const u of await allUsers(db)) {
		const source = await siteAdminSource(db, u);
		if (source) out.push({ id: u.id, name: u.name, email: u.email, source });
	}
	return out;
}

export const USER_LIST_LIMIT = 50;

/** Accounts matching `q` (name or email), for the hand-over picker. Site admins only. */
export async function searchUsers(db: DbOrTx, actor: AdminActor, q: string) {
	await requireAdmin(db, actor);
	const term = q
		.trim()
		.toLowerCase()
		.replace(/[\\%_]/g, (c) => `\\${c}`);
	const rows = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			emailVerified: user.emailVerified
		})
		.from(user)
		.where(
			and(
				eq(user.isDemo, false),
				term ? or(ilike(user.name, `%${term}%`), ilike(user.email, `%${term}%`)) : undefined
			)
		)
		.orderBy(asc(user.name), asc(user.email))
		.limit(USER_LIST_LIMIT);
	const out = [];
	for (const r of rows.filter((r) => r.id !== actor.id))
		out.push({
			id: r.id,
			name: r.name,
			email: r.email,
			isAdmin: await isSiteAdmin(db, r),
			// Only provider-verified emails can become site admins.
			canGrant: r.emailVerified === true
		});
	return out;
}

/** Make `targetId` a site admin (a verified, non-demo account). */
export async function grantSiteAdmin(db: Db, actor: AdminActor, targetId: string): Promise<void> {
	await db.transaction(async (tx) => {
		// Serialise grants and revocations: the "first account" rule and the last-admin check both
		// read the whole admin set, so two concurrent changes could otherwise each see the old one.
		await advisoryLock(tx, 'site-admins');
		await requireAdmin(tx, actor);
		const target = await first(
			tx
				.select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
				.from(user)
				.where(eq(user.id, targetId))
		);
		if (!target) throw new ApiError(404, 'Account not found');
		if (target.emailVerified !== true)
			throw new ApiError(400, 'Only accounts with a verified email can become site admins');
		if (await isSiteAdmin(tx, target)) return;
		await tx
			.insert(siteAdmin)
			.values({ userId: target.id, grantedBy: actor.id })
			.onConflictDoNothing();
	});
}

/** Take a granted role away. Refuses the server-configured admins, the implicit first admin and the last admin. */
export async function revokeSiteAdmin(db: Db, actor: AdminActor, targetId: string): Promise<void> {
	await db.transaction(async (tx) => {
		await advisoryLock(tx, 'site-admins');
		await requireAdmin(tx, actor);
		const target = await first(
			tx
				.select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
				.from(user)
				.where(eq(user.id, targetId))
		);
		if (!target) throw new ApiError(404, 'Account not found');
		const source = await siteAdminSource(tx, target);
		if (source === 'config')
			throw new ApiError(400, 'This admin is set by the server configuration');
		if (source !== 'granted') throw new ApiError(400, 'This account is not a granted site admin');
		let hasOther = false;
		for (const u of await allUsers(tx)) {
			if (u.id !== targetId && (await isSiteAdmin(tx, u))) {
				hasOther = true;
				break;
			}
		}
		if (!hasOther) throw new ApiError(409, 'There must be at least one site admin');
		await tx.delete(siteAdmin).where(eq(siteAdmin.userId, targetId));
	});
}
