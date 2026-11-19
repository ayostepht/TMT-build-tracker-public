import { and, count, eq, gt } from 'drizzle-orm';
import { first, type DbOrTx } from './db';
import { user } from './db/schema';
import { isSiteAdmin } from './access';
import { quotas } from './config';

/**
 * Who may get an account and who may use invitations, as pure functions of the database
 * and the configuration. `auth.ts` calls these from Better Auth hooks (the enforcement);
 * the login and invite pages call them to describe the same rules (UI only).
 *
 * Sign-in is SSO only (Google, GitHub, Discord) and needs a provider-verified email. Demo
 * sandbox users are created by the server and never count towards the account caps.
 */

export type NewUserDecision = { ok: true } | { ok: false; code: string; message: string };

/** Real accounts (demo sandbox users are not counted). */
export async function userCount(db: DbOrTx): Promise<number> {
	return (await first(db.select({ n: count() }).from(user).where(eq(user.isDemo, false))))?.n ?? 0;
}

export const ACCOUNTS_PAUSED_CODE = 'signups_paused';
export const ACCOUNTS_PAUSED_MESSAGE = 'This server is not taking new accounts right now.';

/** Real accounts created in the last 24 hours. */
export async function recentSignupCount(db: DbOrTx, now = new Date()): Promise<number> {
	return (
		(
			await first(
				db
					.select({ n: count() })
					.from(user)
					.where(
						and(
							eq(user.isDemo, false),
							gt(user.createdAt, new Date(now.getTime() - 24 * 3600 * 1000))
						)
					)
			)
		)?.n ?? 0
	);
}

/**
 * True when `QUOTA_ACCOUNTS_TOTAL` or `QUOTA_SIGNUPS_PER_DAY` is reached. Ignores who is asking:
 * site admins are exempted in `decideNewUser`.
 */
export async function accountsPaused(db: DbOrTx, now = new Date()): Promise<boolean> {
	const q = quotas();
	if (q.accountsTotal !== null && (await userCount(db)) >= q.accountsTotal) return true;
	if (q.signupsPerDay !== null && (await recentSignupCount(db, now)) >= q.signupsPerDay)
		return true;
	return false;
}

/**
 * Decision for `databaseHooks.user.create.before`, which runs for every new user: a first SSO
 * login, or a demo user the server creates itself (`isDemo`, only ever set by server code).
 */
export async function decideNewUser(
	db: DbOrTx,
	candidate: { email?: string | null; emailVerified?: boolean | null; isDemo?: boolean | null },
	now = new Date()
): Promise<NewUserDecision> {
	// The demo has its own caps (per IP, live total); it needs no verified email and is not an account.
	if (candidate.isDemo === true) return { ok: true };
	if (candidate.emailVerified !== true)
		return {
			ok: false,
			code: 'email_not_verified',
			message: 'The sign-in provider did not confirm a verified email address.'
		};
	// Account caps apply to everyone but site admins (an ADMIN_EMAILS address).
	if ((await accountsPaused(db, now)) && !(await isSiteAdmin(db, { id: '', ...candidate })))
		return { ok: false, code: ACCOUNTS_PAUSED_CODE, message: ACCOUNTS_PAUSED_MESSAGE };
	return { ok: true };
}

/** Invitations are listed and accepted only for provider-verified emails, never from a demo. */
export function mayUseInvitations(u: {
	emailVerified?: boolean | null;
	isDemo?: boolean | null;
}): boolean {
	return u.emailVerified === true && u.isDemo !== true;
}

/** Fixed, human messages for the `?error=` codes Better Auth and our hooks send back to /login. */
export function loginErrorMessage(code: string | null | undefined): string | null {
	if (!code) return null;
	const c = code.toLowerCase();
	switch (c) {
		case 'email_not_found':
		case 'email_not_verified':
			return 'The provider did not give us a verified email address. If you used GitHub, add an email address in GitHub (Settings, Emails), verify it, and try again. Discord needs a verified email too. Google accounts always have one.';
		case 'account_not_linked':
		case 'unable_to_link_account':
			return 'An account with this email address already exists, and this provider did not confirm that the address is yours. Sign in with the provider you used before.';
		case 'signup_disabled':
			return 'New accounts cannot be created right now.';
		case ACCOUNTS_PAUSED_CODE:
			return ACCOUNTS_PAUSED_MESSAGE + ' You can still sign in if you already have an account.';
		case 'access_denied':
			return 'Sign-in was cancelled.';
		default:
			return 'Sign-in did not complete. Please try again.';
	}
}
