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
	for (const k of ['TMT_MODE', 'PUBLIC_URL']) vi.stubEnv(k, '');
	// The one site admin of these tests: a verified address in ADMIN_EMAILS.
	vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
	db = await createTestDb();
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

let t = 1000;
async function mk(id: string, verified = true, isDemo = false) {
	await db.insert(user).values({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: verified,
		isDemo,
		createdAt: new Date(t++)
	});
	return { id, email: `${id}@example.test`, emailVerified: verified };
}

describe('site admin rule', () => {
	it('nobody is admin by being first; ADMIN_EMAILS and grants only', async () => {
		const a = await mk('a');
		const boss = await mk('boss');
		expect(await isSiteAdmin(db, a)).toBe(false);
		expect(await siteAdminSource(db, boss)).toBe('config');
		await grantSiteAdmin(db, boss, 'a');
		expect(await siteAdminSource(db, a)).toBe('granted');
		// a third, later account is not an admin
		expect(await isSiteAdmin(db, await mk('c'))).toBe(false);
	});

	it('ADMIN_EMAILS is additive and not revocable', async () => {
		const boss = await mk('boss');
		expect(await siteAdminSource(db, boss)).toBe('config');
		await grantSiteAdmin(db, boss, 'boss'); // already admin: no-op
		await expect(revokeSiteAdmin(db, boss, 'boss')).rejects.toThrow('server configuration');
	});

	it('revoking the last granted row really removes admin', async () => {
		const boss = await mk('boss');
		await mk('b');
		await grantSiteAdmin(db, boss, 'b');
		await revokeSiteAdmin(db, boss, 'b');
		expect(await db.select().from(siteAdmin)).toEqual([]);
		expect(await isSiteAdmin(db, { id: 'b', email: 'b@example.test', emailVerified: true })).toBe(
			false
		);
	});

	it('an admin deleting their account while another admin exists promotes nobody', async () => {
		const boss = await mk('boss');
		const a = await mk('a');
		await grantSiteAdmin(db, boss, 'a');
		await mk('b');
		await deleteAccount(db, a.id);
		expect(await isSiteAdmin(db, { id: 'b', email: 'b@example.test', emailVerified: true })).toBe(
			false
		);
		expect((await listSiteAdmins(db, boss)).map((r) => r.id)).toEqual(['boss']);
	});

	it('non-admins cannot grant, revoke, list or search', async () => {
		await mk('boss');
		const b = await mk('b');
		await mk('c');
		await expect(grantSiteAdmin(db, b, 'c')).rejects.toThrow(/Only site admins/);
		await expect(revokeSiteAdmin(db, b, 'boss')).rejects.toThrow(/Only site admins/);
		await expect(listSiteAdmins(db, b)).rejects.toThrow(/Only site admins/);
		await expect(searchUsers(db, b, '')).rejects.toThrow(/Only site admins/);
		await expect(searchUsers(db, b, '')).rejects.toMatchObject({ status: 403 });
	});

	it('cannot revoke the last admin; can revoke one of two', async () => {
		const boss = await mk('boss');
		await mk('b');
		await grantSiteAdmin(db, boss, 'b');
		const b = { id: 'b', email: 'b@example.test', emailVerified: true };
		vi.stubEnv('ADMIN_EMAILS', 'nobody@example.test'); // boss is now only a granted admin
		await grantSiteAdmin(db, b, 'boss');
		await revokeSiteAdmin(db, b, 'boss');
		expect((await db.select().from(siteAdmin)).map((r) => r.userId)).toEqual(['b']);
		await expect(revokeSiteAdmin(db, b, 'b')).rejects.toThrow('at least one site admin');
	});

	it('an unverified email is never admin and cannot be granted', async () => {
		const boss = await mk('boss');
		await mk('lurker', false);
		expect(await siteAdminSource(db, boss)).toBe('config');
		await expect(grantSiteAdmin(db, boss, 'lurker')).rejects.toThrow(/verified/);
		// a stored grant does not count without a verified email
		await db.insert(siteAdmin).values({ userId: 'lurker' });
		expect(
			await isSiteAdmin(db, { id: 'lurker', email: 'lurker@example.test', emailVerified: false })
		).toBe(false);
	});

	it('hand-over then deleting the old admin leaves exactly the new admin', async () => {
		const boss = await mk('boss');
		await mk('b');
		vi.stubEnv('ADMIN_EMAILS', 'nobody@example.test');
		await db.insert(siteAdmin).values({ userId: 'boss' });
		await expect(deleteAccount(db, 'boss')).rejects.toMatchObject({ code: 'last_admin' });
		await grantSiteAdmin(db, boss, 'b');
		await deleteAccount(db, 'boss');
		const rows = await db.select().from(user);
		expect(rows.map((r) => r.id)).toEqual(['b']);
		expect((await db.select().from(siteAdmin)).map((r) => r.userId)).toEqual(['b']);
		expect(await isSiteAdmin(db, { id: 'b', email: 'b@example.test', emailVerified: true })).toBe(
			true
		);
		expect(
			await first(db.select().from(siteAdmin).where(eq(siteAdmin.userId, 'boss')))
		).toBeUndefined();
	});

	it('search finds by name or email, skips the actor and demo users, and marks admins', async () => {
		const boss = await mk('boss');
		await mk('bob');
		await mk('bobdemo', false, true);
		await grantSiteAdmin(db, boss, 'bob');
		const r = await searchUsers(db, boss, 'BO');
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ id: 'bob', isAdmin: true });
		expect(await searchUsers(db, boss, '')).toHaveLength(1);
	});
});
