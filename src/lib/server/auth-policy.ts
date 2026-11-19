import { and, count, eq, gt } from 'drizzle-orm';
import { first, type DbOrTx } from './db';
import { invitation, user } from './db/schema';
import { isSiteAdmin } from './access';
import { quotas, type SignupMode } from './config';

/**
 * Who may get an account and who may use invitations, as pure functions of the database
 * and the configuration. `auth.ts` calls these from Better Auth hooks (the enforcement);
 * the login/signup/invite pages call them to describe the same rules (UI only).
 */

export interface PolicyConfig {
	/** `TMT_MODE=public`: SSO-only, provider-verified emails. */
	publicMode: boolean;
	/** `SIGNUP` (self-hosted only; public mode has no password sign-up). */
	signup: SignupMode;
}

export type NewUserDecision = { ok: true } | { ok: false; code: string; message: string };

export async function userCount(db: DbOrTx): Promise<number> {
	return (await first(db.select({ n: count() }).from(user)))?.n ?? 0;
}

/** A pending, unexpired invitation addressed to this email (case-insensitive). */
export async function hasPendingInvitation(
	db: DbOrTx,
	email: string,
	now = new Date()
): Promise<boolean> {
	const wanted = email.trim().toLowerCase();
	if (!wanted) return false;
	return (
		await db
			.select({ email: invitation.email })
			.from(invitation)
			.where(and(eq(invitation.status, 'pending'), gt(invitation.expiresAt, now)))
	).some((i) => i.email.toLowerCase() === wanted);
}

/**
 * Sign-up rule shown to visitors: `open`, `invite` (an invitation link is needed) or
 * `closed`. The very first account on an empty database is always allowed (bootstrap).
 */
export async function effectiveSignup(db: DbOrTx, cfg: PolicyConfig): Promise<SignupMode> {
	if (cfg.publicMode) return 'open';
	if (cfg.signup !== 'open' && (await userCount(db)) === 0) return 'open';
	return cfg.signup;
}

export const ACCOUNTS_PAUSED_CODE = 'signups_paused';
export const ACCOUNTS_PAUSED_MESSAGE = 'This server is not taking new accounts right now.';

/** Accounts created in the last 24 hours. */
export async function recentSignupCount(db: DbOrTx, now = new Date()): Promise<number> {
	return (
		(
			await first(
				db
					.select({ n: count() })
					.from(user)
					.where(gt(user.createdAt, new Date(now.getTime() - 24 * 3600 * 1000)))
			)
		)?.n ?? 0
	);
}

/**
 * True when `QUOTA_ACCOUNTS_TOTAL` or `QUOTA_SIGNUPS_PER_DAY` is reached (both unlimited in
 * self-host unless set). Ignores who is asking: site admins are exempted in `decideNewUser`.
 */
export async function accountsPaused(db: DbOrTx, now = new Date()): Promise<boolean> {
	const q = quotas();
	if (q.accountsTotal !== null && (await userCount(db)) >= q.accountsTotal) return true;
	if (q.signupsPerDay !== null && (await recentSignupCount(db, now)) >= q.signupsPerDay)
		return true;
	return false;
}

/** Decision for `databaseHooks.user.create.before`: covers email sign-up and SSO first login. */
export async function decideNewUser(
	db: DbOrTx,
	candidate: { email?: string | null; emailVerified?: boolean | null },
	cfg: PolicyConfig,
	now = new Date()
): Promise<NewUserDecision> {
	const base = await decideByPolicy(db, candidate, cfg, now);
	if (!base.ok) return base;
	// Account caps apply to everyone but site admins (an ADMIN_EMAILS address; verified in public mode).
	if ((await accountsPaused(db, now)) && !(await isSiteAdmin(db, { id: '', ...candidate })))
		return { ok: false, code: ACCOUNTS_PAUSED_CODE, message: ACCOUNTS_PAUSED_MESSAGE };
	return base;
}

async function decideByPolicy(
	db: DbOrTx,
	candidate: { email?: string | null; emailVerified?: boolean | null },
	cfg: PolicyConfig,
	now: Date
): Promise<NewUserDecision> {
	if (cfg.publicMode) {
		if (candidate.emailVerified !== true)
			return {
				ok: false,
				code: 'email_not_verified',
				message: 'The sign-in provider did not confirm a verified email address.'
			};
		return { ok: true };
	}
	if (cfg.signup === 'open' || (await userCount(db)) === 0) return { ok: true };
	if (cfg.signup === 'closed')
		return {
			ok: false,
			code: 'signup_closed',
			message: 'Sign-up is closed on this server.'
		};
	if (await hasPendingInvitation(db, candidate.email ?? '', now)) return { ok: true };
	return {
		ok: false,
		code: 'invitation_required',
		message: 'Sign-up needs an invitation to this email address.'
	};
}

/** Public mode: invitations are listed and accepted only for provider-verified emails. */
export function mayUseInvitations(
	cfg: PolicyConfig,
	u: { emailVerified?: boolean | null }
): boolean {
	return !cfg.publicMode || u.emailVerified === true;
}

/** Fixed, human messages for the `?error=` codes Better Auth and our hooks send back to /login. */
export function loginErrorMessage(code: string | null | undefined): string | null {
	if (!code) return null;
	const c = code.toLowerCase();
	switch (c) {
		case 'email_not_found':
		case 'email_not_verified':
			return 'Your account has no verified email address we can use. If you signed in with GitHub, add an email address in GitHub (Settings, Emails), verify it, and try again. Google accounts always have one.';
		case 'account_not_linked':
			return 'An account with this email address already exists but is not linked to that sign-in. Sign in the way you created it (email and password), then ask an admin if you need the accounts joined.';
		case 'signup_closed':
		case 'signup_disabled':
			return 'Sign-up is closed on this server. Ask the admin for an account.';
		case 'invitation_required':
			return 'This server only creates accounts for invited people. Open the invitation link you were sent, then sign in with the invited email address.';
		case ACCOUNTS_PAUSED_CODE:
			return ACCOUNTS_PAUSED_MESSAGE + ' You can still sign in if you already have an account.';
		case 'access_denied':
			return 'Sign-in was cancelled.';
		default:
			return 'Sign-in did not complete. Please try again.';
	}
}
