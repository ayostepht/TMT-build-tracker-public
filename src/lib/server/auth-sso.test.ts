import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptOAuthToken, handleOAuthUserInfo, setTokenUtil } from 'better-auth/oauth2';
import { eq } from 'drizzle-orm';
import { createAuth, PASSWORD_PATHS, type Auth } from './auth';
import { enableTestSignIn, signInTestUser } from './auth-test-helpers';
import { decideNewUser, loginErrorMessage, mayUseInvitations } from './auth-policy';
import { isDemoUser, isSiteAdmin, requireNotDemo } from './access';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import {
	account,
	invitation,
	member,
	organization,
	session as sessionTable,
	user
} from './db/schema';

let db: Db;

const SECRET = '3f9c1d7a5b2e48906c1fa7d2e5b8340d9a6c2f1e7b4d8035a9c6e1f2b7d4a850';

beforeEach(async () => {
	vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
	for (const k of ['TMT_MODE', 'PUBLIC_URL', 'ADMIN_EMAILS', 'OIDC_ISSUER']) vi.stubEnv(k, '');
	vi.stubEnv('GOOGLE_CLIENT_ID', 'g-id');
	vi.stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret');
	vi.stubEnv('GITHUB_CLIENT_ID', 'h-id');
	vi.stubEnv('GITHUB_CLIENT_SECRET', 'h-secret');
	vi.stubEnv('DISCORD_CLIENT_ID', 'd-id');
	vi.stubEnv('DISCORD_CLIENT_SECRET', 'd-secret');
	db = await createTestDb();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

async function addInvitation(opts: { id: string; email: string; inviterId: string }) {
	const orgId = 'org-1';
	if (!(await first(db.select().from(organization).where(eq(organization.id, orgId))))) {
		await db
			.insert(organization)
			.values({ id: orgId, name: 'Team', slug: orgId, createdAt: new Date() });
		await db.insert(member).values({
			id: `m-${orgId}`,
			organizationId: orgId,
			userId: opts.inviterId,
			role: 'owner',
			createdAt: new Date()
		});
	}
	await db.insert(invitation).values({
		id: opts.id,
		organizationId: orgId,
		email: opts.email,
		role: 'editor',
		status: 'pending',
		expiresAt: new Date(Date.now() + 86_400_000),
		inviterId: opts.inviterId
	});
}

async function oauthLogin(
	auth: Auth,
	providerId: string,
	profile: { id: string; email: string; emailVerified: boolean }
) {
	const ctx = await auth.$context;
	const c = {
		context: ctx,
		redirect: (u: string) => u,
		request: undefined,
		headers: new Headers()
	};
	return handleOAuthUserInfo(
		c as never,
		{
			userInfo: { name: 'Pat', ...profile },
			account: { providerId, accountId: profile.id },
			callbackURL: '/'
		} as never
	);
}

describe('isSiteAdmin', () => {
	const seed = async () => {
		const now = new Date();
		for (const [id, email, verified] of [
			['u1', 'first@example.com', false],
			['u2', 'boss@example.com', true],
			['u3', 'raw@example.com', false]
		] as const)
			await db
				.insert(user)
				.values({ id, name: id, email, emailVerified: verified, createdAt: now, updatedAt: now });
	};

	it('only a listed AND verified email; never the earliest user', async () => {
		await seed();
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.com,raw@example.com');
		expect(
			await isSiteAdmin(db, { id: 'u2', email: 'BOSS@example.com', emailVerified: true })
		).toBe(true);
		expect(
			await isSiteAdmin(db, { id: 'u3', email: 'raw@example.com', emailVerified: false })
		).toBe(false);
		expect(await isSiteAdmin(db, { id: 'u3', email: 'raw@example.com' })).toBe(false);
		expect(
			await isSiteAdmin(db, { id: 'u1', email: 'first@example.com', emailVerified: true })
		).toBe(false);
	});

	it('with no ADMIN_EMAILS: nobody', async () => {
		await seed();
		expect(
			await isSiteAdmin(db, { id: 'u1', email: 'first@example.com', emailVerified: true })
		).toBe(false);
	});
});

describe('new-user policy', () => {
	it('verified provider email only', async () => {
		expect((await decideNewUser(db, { email: 'a@example.com', emailVerified: true })).ok).toBe(
			true
		);
		expect(await decideNewUser(db, { email: 'a@example.com', emailVerified: false })).toMatchObject(
			{
				ok: false,
				code: 'email_not_verified'
			}
		);
		expect((await decideNewUser(db, { email: 'a@example.com' })).ok).toBe(false);
	});

	it('invitations: only a verified email, never a demo user', () => {
		expect(mayUseInvitations({ emailVerified: false })).toBe(false);
		expect(mayUseInvitations({ emailVerified: true })).toBe(true);
		expect(mayUseInvitations({ emailVerified: true, isDemo: true })).toBe(false);
	});

	it('login error codes map to fixed messages', () => {
		expect(loginErrorMessage(null)).toBeNull();
		expect(loginErrorMessage('email_not_found')).toMatch(/GitHub/);
		expect(loginErrorMessage('account_not_linked')).toMatch(/already exists/);
		expect(loginErrorMessage('<script>')).toBe('Sign-in did not complete. Please try again.');
	});
});

describe('SSO-only auth', () => {
	it('registers Google, GitHub and Discord, never email/password or generic OIDC', async () => {
		vi.stubEnv('OIDC_ISSUER', 'https://idp.example.com');
		vi.stubEnv('OIDC_CLIENT_ID', 'x');
		vi.stubEnv('OIDC_CLIENT_SECRET', 'y');
		const auth = createAuth(db);
		const ctx = await auth.$context;
		expect(ctx.socialProviders.map((p) => p.id).sort()).toEqual(['discord', 'github', 'google']);
		expect(ctx.options.emailAndPassword?.enabled).toBe(false);
		expect(ctx.options.plugins?.some((p) => p.id === 'generic-oauth')).toBe(false);
		expect(ctx.rateLimit.enabled).toBe(true);
		expect(ctx.rateLimit.storage).toBe('memory');
	});

	it('a provider is enabled only when both of its variables are set', async () => {
		vi.stubEnv('DISCORD_CLIENT_ID', '');
		vi.stubEnv('DISCORD_CLIENT_SECRET', '');
		const ctx = await createAuth(db).$context;
		expect(ctx.socialProviders.map((p) => p.id).sort()).toEqual(['github', 'google']);
	});

	it('every password route answers 4xx over HTTP', async () => {
		const auth = createAuth(db);
		const paths = [...PASSWORD_PATHS, '/reset-password/sometoken', '/verify-email?token=x'];
		for (const p of paths) {
			for (const method of ['POST', 'GET']) {
				const res = await auth.handler(
					new Request(`http://localhost:3000/api/auth${p}`, {
						method,
						headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
						body:
							method === 'POST'
								? JSON.stringify({
										email: 'a@example.com',
										password: 'correct-horse-battery',
										name: 'A'
									})
								: undefined
					})
				);
				expect(res.status, `${method} ${p}`).toBeGreaterThanOrEqual(400);
				expect(res.status, `${method} ${p}`).toBeLessThan(500);
			}
		}
		expect(await db.select().from(user)).toHaveLength(0);
	});

	it('the demo and test sign-in endpoints are not routable over HTTP', async () => {
		const auth = createAuth(db);
		for (const p of ['/demo/start', '/start-demo', '/test/sign-in', '/sign-in/anonymous']) {
			const res = await auth.handler(
				new Request(`http://localhost:3000/api/auth${p}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
					body: '{}'
				})
			);
			expect(res.status, p).toBe(404);
		}
		expect(await db.select().from(user)).toHaveLength(0);
	});

	it('refuses an unverified provider email on a first login, for every provider', async () => {
		const auth = createAuth(db);
		for (const p of ['google', 'github', 'discord'])
			await expect(
				oauthLogin(auth, p, { id: `${p}-1`, email: 'pat@example.com', emailVerified: false })
			).rejects.toMatchObject({ body: { code: 'email_not_verified' } });
		expect(await db.select().from(user)).toHaveLength(0);
	});

	it('Google, GitHub and Discord on the same verified email are one user', async () => {
		const auth = createAuth(db);
		const a = await oauthLogin(auth, 'google', {
			id: 'g-1',
			email: 'pat@example.com',
			emailVerified: true
		});
		const b = await oauthLogin(auth, 'github', {
			id: 'gh-1',
			email: 'pat@example.com',
			emailVerified: true
		});
		const c = await oauthLogin(auth, 'discord', {
			id: 'd-1',
			email: 'pat@example.com',
			emailVerified: true
		});
		for (const r of [a, b, c]) expect(r.error).toBeNull();
		expect(b.data?.user.id).toBe(a.data?.user.id);
		expect(c.data?.user.id).toBe(a.data?.user.id);
		expect(await db.select().from(user)).toHaveLength(1);
		expect((await db.select().from(account)).map((x) => x.providerId).sort()).toEqual([
			'discord',
			'github',
			'google'
		]);
	});

	it('a provider that does not confirm the email never attaches to an existing user (no trusted providers)', async () => {
		const auth = createAuth(db);
		const ctx = await auth.$context;
		expect(ctx.trustedProviders).toEqual([]);
		await oauthLogin(auth, 'google', { id: 'g-1', email: 'pat@example.com', emailVerified: true });
		for (const p of ['github', 'discord']) {
			const b = await oauthLogin(auth, p, {
				id: `${p}-1`,
				email: 'pat@example.com',
				emailVerified: false
			});
			expect(b.error, p).toBe('account not linked');
		}
		expect(await db.select().from(account)).toHaveLength(1);
		expect(await db.select().from(user)).toHaveLength(1);
	});

	it('invitation acceptance needs a verified email even when called directly', async () => {
		enableTestSignIn();
		const auth = createAuth(db);
		const pat = await signInTestUser(auth, 'Pat', 'pat@example.com');
		const inviter = await signInTestUser(auth, 'Inviter', 'inviter@example.com');
		await addInvitation({ id: 'inv-1', email: 'pat@example.com', inviterId: inviter.id });
		// The email stops being verified after the session was made (a stale session).
		await db.update(user).set({ emailVerified: false }).where(eq(user.id, pat.id));
		await expect(
			auth.api.acceptInvitation({ body: { invitationId: 'inv-1' }, headers: pat.headers })
		).rejects.toMatchObject({ status: 'FORBIDDEN' });
		expect(
			(await first(db.select().from(invitation).where(eq(invitation.id, 'inv-1'))))?.status
		).toBe('pending');
		await db.update(user).set({ emailVerified: true }).where(eq(user.id, pat.id));
		await auth.api.acceptInvitation({ body: { invitationId: 'inv-1' }, headers: pat.headers });
		expect(
			(await first(db.select().from(invitation).where(eq(invitation.id, 'inv-1'))))?.status
		).toBe('accepted');
	});
});

describe('session hook', () => {
	it('a session for an unverified user is refused even with an active workspace', async () => {
		const auth = createAuth(db);
		const ctx = await auth.$context;
		const now = new Date();
		await db.insert(user).values({
			id: 'u1',
			name: 'Pat',
			email: 'pat@example.com',
			emailVerified: false,
			createdAt: now,
			updatedAt: now
		});
		await expect(
			ctx.internalAdapter.createSession('u1', false, { activeOrganizationId: 'org-x' })
		).rejects.toMatchObject({ body: { code: 'email_not_verified' } });
		expect(await db.select().from(sessionTable)).toHaveLength(0);
	});

	it('sessions never store the IP address', async () => {
		enableTestSignIn();
		const auth = createAuth(db);
		await signInTestUser(auth, 'Pat', 'pat@example.com');
		const ctx = await auth.$context;
		const [u] = await db.select().from(user);
		await ctx.internalAdapter.createSession(u.id, false, { activeOrganizationId: 'org-x' });
		const rows = await db.select().from(sessionTable);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) expect(r.ipAddress ?? '').toBe('');
	});

	it('provider tokens and id tokens are not stored, for every provider', async () => {
		const auth = createAuth(db);
		const ctx = await auth.$context;
		const full = {
			accessToken: 'at',
			refreshToken: 'rt',
			idToken: 'idt',
			accessTokenExpiresAt: new Date(Date.now() + 3600_000),
			refreshTokenExpiresAt: new Date(Date.now() + 3600_000),
			scope: 'openid,email'
		};
		const login = async (providerId: string, id: string, email: string) => {
			const c = {
				context: ctx,
				redirect: (u: string) => u,
				request: undefined,
				headers: new Headers()
			};
			return handleOAuthUserInfo(
				c as never,
				{
					userInfo: { name: 'P', id, email, emailVerified: true },
					account: { providerId, accountId: id, ...full },
					callbackURL: '/'
				} as never
			);
		};
		for (const [p, email] of [
			['google', 'g@example.com'],
			['github', 'h@example.com'],
			['discord', 'o@example.com']
		]) {
			expect((await login(p, `${p}-1`, email)).error).toBeNull();
			// second sign-in takes the update path
			expect((await login(p, `${p}-1`, email)).error).toBeNull();
			const r = (await db.select().from(account).where(eq(account.providerId, p)))[0];
			for (const v of [
				r.accessToken,
				r.refreshToken,
				r.accessTokenExpiresAt,
				r.refreshTokenExpiresAt,
				r.scope,
				r.idToken
			])
				expect(v, p).toBeNull();
		}
	});

	it('encryption stays on as a backstop: helpers encrypt, decrypt, and pass plaintext through', async () => {
		const auth = createAuth(db);
		const ctx = await auth.$context;
		const enc = await setTokenUtil('plain-access-token', ctx as never);
		expect(enc).not.toContain('plain-access-token');
		expect(await decryptOAuthToken(enc!, ctx as never)).toBe('plain-access-token');
		expect(await decryptOAuthToken('ya29.legacy-plain', ctx as never)).toBe('ya29.legacy-plain');
	});
});

describe('test sign-in seam', () => {
	it('exists only with E2E_AUTH=1, NODE_ENV=test and a _e2e or _test database', async () => {
		const routes = async () =>
			(
				await createAuth(db).handler(
					new Request('http://localhost:3000/api/auth/test/sign-in', {
						method: 'POST',
						headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
						body: JSON.stringify({ name: 'T', email: 't@example.test' })
					})
				)
			).status;
		expect(await routes()).toBe(404);
		enableTestSignIn();
		expect(await routes()).toBe(200);
		// wrong environment or database: the server refuses to build auth at all
		vi.stubEnv('NODE_ENV', 'production');
		expect(() => createAuth(db)).toThrow(/NODE_ENV=test/);
		vi.stubEnv('NODE_ENV', 'test');
		vi.stubEnv('DATABASE_URL', 'postgres://u:p@h:5432/tmt_prod');
		expect(() => createAuth(db)).toThrow(/ends in _e2e or _test/);
	});
});

describe('demo users and the guards', () => {
	it('isDemoUser and requireNotDemo read the flag only', () => {
		expect(isDemoUser({ id: 'a', isDemo: true })).toBe(true);
		expect(isDemoUser({ id: 'a' })).toBe(false);
		expect(isDemoUser(null)).toBe(false);
		expect(() => requireNotDemo({ id: 'a', isDemo: true })).toThrow(/demo/);
		expect(() => requireNotDemo({ id: 'a', isDemo: false })).not.toThrow();
	});

	it('the isDemo field cannot be set from a provider profile', async () => {
		const auth = createAuth(db);
		const ctx = await auth.$context;
		const c = {
			context: ctx,
			redirect: (u: string) => u,
			request: undefined,
			headers: new Headers()
		};
		await handleOAuthUserInfo(
			c as never,
			{
				userInfo: {
					name: 'P',
					id: 'x1',
					email: 'x@example.com',
					emailVerified: true,
					isDemo: true
				},
				account: { providerId: 'google', accountId: 'x1' },
				callbackURL: '/'
			} as never
		);
		const [u] = await db.select().from(user);
		expect(u.isDemo).toBe(false);
	});
});
