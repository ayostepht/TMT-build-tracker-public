import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { isSiteAdmin, siteAdminSource } from './access';
import { deleteAccount } from './account';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import { siteAdmin, user } from './db/schema';
import { grantSiteAdmin, listSiteAdmins, revokeSiteAdmin, searchUsers } from './site-admins';

let db: Db;
beforeEach(async () => {
	for (const k of ['TMT_MODE', 'PUBLIC_URL', 'ADMIN_EMAILS', 'SIGNUP']) vi.stubEnv(k, '');
	db = await createTestDb();
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

let t = 1000;
async function mk(id: string, verified = true) {
	await db.insert(user).values({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: verified,
		createdAt: new Date(t++)
	});
	return { id, email: `${id}@example.test`, emailVerified: verified };
}

describe('site admin rule', () => {
	it('first account is admin until any row exists; the granter keeps access', async () => {
		const a = await mk('a');
		const b = await mk('b');
		expect(await siteAdminSource(db, a)).toBe('first');
		expect(await isSiteAdmin(db, b)).toBe(false);
		await grantSiteAdmin(db, a, 'b');
		expect(await siteAdminSource(db, a)).toBe('granted');
		expect(await siteAdminSource(db, b)).toBe('granted');
		// a third, later account is not an admin and the first-user rule no longer applies
		const c = await mk('c');
		expect(await isSiteAdmin(db, c)).toBe(false);
	});

	it('ADMIN_EMAILS is additive and not revocable', async () => {
		await mk('a');
		const b = await mk('b');
		vi.stubEnv('ADMIN_EMAILS', 'b@example.test');
		expect(await siteAdminSource(db, b)).toBe('config');
		await grantSiteAdmin(db, b, 'b'); // already admin: no-op
		await expect(revokeSiteAdmin(db, b, 'b')).rejects.toThrow('server configuration');
	});

	it('an env admin revoking the last granted row really removes admin (no first-account fallback)', async () => {
		await mk('a');
		await mk('b');
		await mk('boss');
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		const boss = { id: 'boss', email: 'boss@example.test' };
		// env admin has an account: the earliest account is an ordinary user
		expect(await isSiteAdmin(db, { id: 'a', email: 'a@example.test' })).toBe(false);
		await grantSiteAdmin(db, boss, 'b');
		await revokeSiteAdmin(db, boss, 'b');
		expect(await db.select().from(siteAdmin)).toEqual([]);
		for (const id of ['a', 'b'])
			expect(await isSiteAdmin(db, { id, email: `${id}@example.test` })).toBe(false);
	});

	it('ADMIN_EMAILS naming an address with no account keeps the first account admin', async () => {
		const a = await mk('a');
		await mk('b');
		vi.stubEnv('ADMIN_EMAILS', 'later@example.test');
		expect(await siteAdminSource(db, a)).toBe('first');
		await mk('later');
		expect(await isSiteAdmin(db, a)).toBe(false);
	});

	it('earliest account deleting itself while an env admin exists promotes nobody', async () => {
		const a = await mk('a');
		await mk('b');
		await mk('boss');
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		await deleteAccount(db, a.id);
		expect(await isSiteAdmin(db, { id: 'b', email: 'b@example.test' })).toBe(false);
		expect(
			(await listSiteAdmins(db, { id: 'boss', email: 'boss@example.test' })).map((r) => r.id)
		).toEqual(['boss']);
	});

	it('non-admins cannot grant, revoke, list or search', async () => {
		await mk('a');
		const b = await mk('b');
		await mk('c');
		await expect(grantSiteAdmin(db, b, 'c')).rejects.toThrow(/Only site admins/);
		await expect(revokeSiteAdmin(db, b, 'a')).rejects.toThrow(/Only site admins/);
		await expect(listSiteAdmins(db, b)).rejects.toThrow(/Only site admins/);
		await expect(searchUsers(db, b, '')).rejects.toThrow(/Only site admins/);
		await expect(searchUsers(db, b, '')).rejects.toMatchObject({ status: 403 });
	});

	it('cannot revoke the last admin; can revoke one of two', async () => {
		const a = await mk('a');
		await mk('b');
		await grantSiteAdmin(db, a, 'b');
		await revokeSiteAdmin(db, { id: 'b', email: 'b@example.test' }, 'a');
		expect((await db.select().from(siteAdmin)).map((r) => r.userId)).toEqual(['b']);
		await expect(revokeSiteAdmin(db, { id: 'b', email: 'b@example.test' }, 'b')).rejects.toThrow(
			'at least one site admin'
		);
	});

	it('public mode: unverified email is never admin and cannot be granted', async () => {
		vi.stubEnv('TMT_MODE', 'public');
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		const boss = await mk('boss');
		await mk('lurker', false);
		expect(await siteAdminSource(db, boss)).toBe('config');
		await expect(grantSiteAdmin(db, boss, 'lurker')).rejects.toThrow(/verified/);
		// a stored grant does not count without a verified email
		await db.insert(siteAdmin).values({ userId: 'lurker' });
		expect(
			await isSiteAdmin(db, { id: 'lurker', email: 'lurker@example.test', emailVerified: false })
		).toBe(false);
		// no first-user in public mode
		expect(await isSiteAdmin(db, await mk('plain'))).toBe(false);
	});

	it('hand-over then deleting the old admin leaves exactly the new admin', async () => {
		const a = await mk('a');
		await mk('b');
		await expect(deleteAccount(db, 'a')).rejects.toMatchObject({ code: 'last_admin' });
		await grantSiteAdmin(db, a, 'b');
		await deleteAccount(db, 'a');
		const rows = await db.select().from(user);
		expect(rows.map((r) => r.id)).toEqual(['b']);
		expect((await db.select().from(siteAdmin)).map((r) => r.userId)).toEqual(['b']);
		expect(await isSiteAdmin(db, { id: 'b', email: 'b@example.test' })).toBe(true);
		expect(
			await first(db.select().from(siteAdmin).where(eq(siteAdmin.userId, 'a')))
		).toBeUndefined();
	});

	it('search finds by name or email, skips the actor and marks admins', async () => {
		const a = await mk('alice');
		await mk('bob');
		await grantSiteAdmin(db, a, 'bob');
		const r = await searchUsers(db, a, 'BO');
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ id: 'bob', isAdmin: true });
		expect(await searchUsers(db, a, '')).toHaveLength(1);
	});
});
