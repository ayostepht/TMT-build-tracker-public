import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import type { Db } from './index.ts';
import { createTestDb, dropTestDb } from './testing.ts';
import { lockDownSupabaseRoles } from './supabase-lockdown.ts';

// Uses role names of its own so it never touches a real `anon` / `authenticated`. Creating a role
// needs CREATEROLE: without it the role tests are skipped (the no-op test still runs).
const suffix = randomBytes(3).toString('hex');
const roles = [`t_anon_${suffix}`, `t_auth_${suffix}`];
let canCreateRoles = false;
let admin: ReturnType<typeof postgres>;
let db: Db;

beforeAll(async () => {
	admin = postgres(inject('tmtTestDb').adminUrl, { max: 1, prepare: false, onnotice: () => {} });
	try {
		for (const r of roles) await admin.unsafe(`CREATE ROLE ${r} LOGIN PASSWORD 'x'`);
		canCreateRoles = true;
	} catch {
		canCreateRoles = false;
	}
	db = await createTestDb();
});
afterAll(async () => {
	await dropTestDb(db);
	if (canCreateRoles) for (const r of roles) await admin.unsafe(`DROP ROLE IF EXISTS ${r}`);
	await admin.end();
});

describe('Supabase role lockdown', () => {
	it('is a no-op when the roles do not exist', async () => {
		await lockDownSupabaseRoles(db, ['no_such_role_a', 'no_such_role_b']);
		const rows = await db.$client`select relrowsecurity from pg_class where relname = 'user'`;
		expect(rows[0]?.relrowsecurity).toBe(false);
	});

	it('rejects a role name that is not a plain identifier', async () => {
		await expect(lockDownSupabaseRoles(db, ["x'; drop"])).rejects.toThrow(/invalid role name/);
	});

	it('removes access for the API roles, keeps the app role working, and is idempotent', async (ctx) => {
		if (!canCreateRoles) return ctx.skip();
		const dbName = (await db.$client`select current_database() as d`)[0]!.d as string;
		await admin.unsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO ${roles.join(', ')}`);
		// What Supabase does by default: the API roles can read everything in public.
		await db.$client.unsafe(`GRANT USAGE ON SCHEMA public TO ${roles.join(', ')}`);
		await db.$client.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${roles.join(', ')}`);

		const asRole = (r: string) => {
			const u = new URL(inject('tmtTestDb').adminUrl);
			u.username = r;
			u.password = 'x';
			u.pathname = `/${dbName}`;
			return postgres(u.toString(), { max: 1, prepare: false, onnotice: () => {} });
		};
		const before = asRole(roles[0]!);
		await expect(before`select count(*) from "user"`).resolves.toBeTruthy();
		await before.end();

		await lockDownSupabaseRoles(db, roles);
		await lockDownSupabaseRoles(db, roles);

		for (const r of roles)
			for (const table of ['user', 'session', 'account']) {
				const c = asRole(r);
				await expect(c.unsafe(`select * from "${table}"`)).rejects.toMatchObject({
					code: '42501'
				});
				await c.end();
			}
		// The app's own role (the table owner) still reads and writes.
		await db.$client`select count(*) from "user"`;
		const rls = await db.$client`
			select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`;
		expect(rls[0]!.n).toBe(0);
		// Schema-wide, so tables added by later migrations are covered too.
		for (const table of ['build_custom_pieces', 'workspace_custom_pieces']) {
			const c = asRole(roles[0]!);
			await expect(c.unsafe(`select * from "${table}"`)).rejects.toMatchObject({ code: '42501' });
			await c.end();
			const t = await db.$client`select relrowsecurity from pg_class where relname = ${table}`;
			expect(t[0]?.relrowsecurity).toBe(true);
		}
	});
});
