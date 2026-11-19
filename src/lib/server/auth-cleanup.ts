import { and, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db';
import { account, session } from './db/auth.schema';

/**
 * One-off, idempotent cleanup of auth data the app no longer stores: session IP addresses
 * (new sessions get '' from the `session.create.before` hook in auth.ts) and single sign-on
 * provider tokens (an account hook nulls them on every write). The OIDC id token is kept
 * (used at sign-out); `scope`, `password` and all other columns are never touched.
 * Runs in one transaction; later starts match no rows. Returns counts only.
 */
export async function cleanupAuthData(db: Db): Promise<{ sessions: number; accounts: number }> {
	return db.transaction(async (tx) => {
		const sessions = await tx
			.update(session)
			.set({ ipAddress: '' })
			.where(and(isNotNull(session.ipAddress), ne(session.ipAddress, '')))
			.returning({ id: session.id });
		const sessionCount = sessions.length;
		// Rows holding any token, or an id token on a non-OIDC provider.
		const accounts = await tx
			.update(account)
			.set({
				accessToken: null,
				refreshToken: null,
				accessTokenExpiresAt: null,
				refreshTokenExpiresAt: null,
				idToken: sql`CASE WHEN ${account.providerId} = 'oidc' THEN ${account.idToken} ELSE NULL END`
			})
			.where(
				or(
					isNotNull(account.accessToken),
					isNotNull(account.refreshToken),
					isNotNull(account.accessTokenExpiresAt),
					isNotNull(account.refreshTokenExpiresAt),
					and(isNotNull(account.idToken), ne(account.providerId, 'oidc'))
				)
			)
			.returning({ id: account.id });
		return { sessions: sessionCount, accounts: accounts.length };
	});
}

/** Startup step: runs the cleanup and logs one counts-only line when something changed. */
export async function cleanupAuthDataAtStartup(db: Db): Promise<void> {
	try {
		const { sessions, accounts } = await cleanupAuthData(db);
		if (sessions || accounts)
			console.log(
				`[tmt] auth cleanup: cleared IP address on ${sessions} session(s), stored sign-in tokens on ${accounts} account(s)`
			);
	} catch (e) {
		console.error('[tmt] auth cleanup failed', e);
	}
}
