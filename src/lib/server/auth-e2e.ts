import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { e2eAuthEnabled } from './config';

/**
 * TEST-ONLY sign-in for the Playwright suite (`POST /api/auth/test/sign-in`, body `{ name, email }`):
 * finds or creates a user with a verified email and signs it in, through Better Auth's own hooks
 * (personal workspace, session rules), so specs need no real identity provider.
 *
 * It cannot exist in production, by three independent conditions that `e2eAuthEnabled()` checks
 * (`E2E_AUTH=1`, `NODE_ENV=test`, database name ending in `_e2e` or `_test`):
 * 1. `auth.ts` adds this plugin only when `e2eAuthEnabled()` is true, which throws (so the server
 *    does not start, see `bootProblems`) when `E2E_AUTH` is set but the other two do not hold;
 * 2. the handler checks again on every call and answers 404 when it is false;
 * 3. the production image sets `NODE_ENV=production`.
 */
export function e2eSignInPlugin() {
	return {
		id: 'tmt-e2e-sign-in',
		endpoints: {
			e2eSignIn: createAuthEndpoint('/test/sign-in', { method: 'POST' }, async (ctx) => {
				if (!e2eAuthEnabled()) throw new APIError('NOT_FOUND');
				const body = (ctx.body ?? {}) as { name?: unknown; email?: unknown };
				const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
				const name = typeof body.name === 'string' ? body.name.trim() : '';
				if (!email.includes('@') || !name)
					throw new APIError('BAD_REQUEST', { message: 'name and email are required' });
				const adapter = ctx.context.internalAdapter;
				let user = (await adapter.findUserByEmail(email))?.user;
				if (!user) {
					user = await adapter.createUser({ name, email, emailVerified: true }, { method: 'e2e' });
					await adapter.createAccount({ userId: user.id, providerId: 'e2e', accountId: email });
				}
				const session = await adapter.createSession(user.id);
				await setSessionCookie(ctx, { session, user });
				return ctx.json({ ok: true });
			})
		}
	};
}
