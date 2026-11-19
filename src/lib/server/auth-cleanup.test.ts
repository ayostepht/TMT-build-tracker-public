import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import { account, session, user } from './db/auth.schema';
import { cleanupAuthData, cleanupAuthDataAtStartup } from './auth-cleanup';

let db: Db;
const now = new Date();
const later = new Date(now.getTime() + 3600_000);

async function addUser(id: string) {
	await db.insert(user).values({
		id,
		name: id,
		email: `${id}@example.invalid`,
		emailVerified: true,
		createdAt: now,
		updatedAt: now
	});
}
async function addSession(id: string, userId: string, ip: string | null) {
	await db
		.insert(session)
		.values({ id, token: `tok-${id}`, userId, ipAddress: ip, expiresAt: later, updatedAt: now });
}
async function addAccount(
	id: string,
	userId: string,
	providerId: string,
	extra: Partial<typeof account.$inferInsert> = {}
) {
	await db
		.insert(account)
		.values({ id, accountId: `acc-${id}`, userId, providerId, updatedAt: now, ...extra });
}

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await addUser('u1');
	await addSession('s1', 'u1', '203.0.113.7');
	await addSession('s2', 'u1', '');
	await addSession('s3', 'u1', null);
	await addAccount('a1', 'u1', 'credential', { password: 'fake-hash' });
	await addAccount('a2', 'u1', 'oidc', {
		accessToken: 'fake-token',
		refreshToken: 'fake-refresh',
		idToken: 'fake-id',
		accessTokenExpiresAt: later,
		refreshTokenExpiresAt: later,
		scope: 'openid,email'
	});
	await addAccount('a3', 'u1', 'github', { accessToken: 'fake-token', idToken: 'fake-id' });
	await addAccount('a4', 'u1', 'google', { idToken: 'fake-id' });
});

describe('cleanupAuthData', () => {
	it('clears IPs, tokens and id tokens, keeps password and scope', async () => {
		expect(await cleanupAuthData(db)).toEqual({ sessions: 1, accounts: 3 });
		const s = Object.fromEntries((await db.select().from(session)).map((r) => [r.id, r.ipAddress]));
		expect(s).toEqual({ s1: '', s2: '', s3: null });
		const a = Object.fromEntries((await db.select().from(account)).map((r) => [r.id, r]));
		expect(a.a1.password).toBe('fake-hash');
		expect(a.a2).toMatchObject({
			accessToken: null,
			refreshToken: null,
			accessTokenExpiresAt: null,
			refreshTokenExpiresAt: null,
			idToken: null,
			scope: 'openid,email',
			providerId: 'oidc',
			accountId: 'acc-a2'
		});
		expect(a.a3).toMatchObject({ accessToken: null, idToken: null });
		expect(a.a4.idToken).toBeNull();
	});

	it('is idempotent and logs nothing the second time', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await cleanupAuthDataAtStartup(db);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log.mock.calls[0][0]).not.toMatch(/203\.0\.113|fake/);
		expect(await cleanupAuthData(db)).toEqual({ sessions: 0, accounts: 0 });
		await cleanupAuthDataAtStartup(db);
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});

	it('works on empty tables and leaves other rows alone', async () => {
		await db.delete(user).where(eq(user.id, 'u1'));
		expect(await cleanupAuthData(db)).toEqual({ sessions: 0, accounts: 0 });
	});
});
