// Test helpers for code that needs a signed-in Better Auth session. Import from tests only.
import { vi } from 'vitest';
import type { Auth } from './auth';

/**
 * Turns the test sign-in seam on for this test (call BEFORE `createAuth`): `E2E_AUTH=1` with
 * `NODE_ENV=test` (vitest sets it) and a database name ending in `_test`. Undo with
 * `vi.unstubAllEnvs()`.
 */
export function enableTestSignIn(): void {
	vi.stubEnv('E2E_AUTH', '1');
	vi.stubEnv('NODE_ENV', 'test');
	vi.stubEnv('DATABASE_URL', 'postgres://x:x@localhost:5432/tmt_unit_test');
}

/** Signs a (verified-email) user in through the test seam; creates it on first use. Returns the id and a cookie header. */
export async function signInTestUser(
	auth: Auth,
	name: string,
	email: string
): Promise<{ id: string; headers: Headers }> {
	const res = await (
		auth.api as unknown as {
			e2eSignIn: (o: {
				body: { name: string; email: string };
				returnHeaders: true;
				headers?: Headers;
			}) => Promise<{ headers: Headers }>;
		}
	).e2eSignIn({ body: { name, email }, returnHeaders: true });
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(';')[0])
		.join('; ');
	const headers = new Headers({ cookie });
	const session = await auth.api.getSession({ headers });
	if (!session) throw new Error('test sign-in did not create a session');
	return { id: session.user.id, headers };
}
