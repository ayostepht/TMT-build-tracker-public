import { and, isNotNull, ne, or } from 'drizzle-orm';
import type { Db } from './db';
import { account, session } from './db/auth.schema';

/**
 * One-off, idempotent cleanup of auth data the app no longer stores: session IP addresses
 * (new sessions get '' from the `session.create.before` hook in auth.ts) and single sign-on
 * provider tokens, id tokens included (an account hook nulls them on every write). `scope`,
 * `password` and all other columns are never touched.
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
		// Rows holding any token.
		const accounts = await tx
			.update(account)
			.set({
				accessToken: null,
				refreshToken: null,
				accessTokenExpiresAt: null,
				refreshTokenExpiresAt: null,
				idToken: null
			})
			.where(
				or(
					isNotNull(account.accessToken),
					isNotNull(account.refreshToken),
					isNotNull(account.accessTokenExpiresAt),
					isNotNull(account.refreshTokenExpiresAt),
					isNotNull(account.idToken)
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
