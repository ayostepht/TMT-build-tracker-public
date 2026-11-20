import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations, type Db } from './index';
import { createEmptyTestDb, dropTestDb } from './testing';

const made: Db[] = [];
afterAll(async () => {
	for (const d of made) await dropTestDb(d);
});

const n = (rows: unknown) => (rows as { n: number }[])[0].n;

describe('runMigrations', () => {
	it('migrates an empty database and is idempotent', async () => {
		const db = await createEmptyTestDb();
		made.push(db);
		await runMigrations(db);
		await runMigrations(db);
		const rows = await db.execute(
			sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`
		);
		expect(n(rows)).toBeGreaterThan(20);
	});

	it('two containers starting at once do not race (advisory lock)', async () => {
		const db = await createEmptyTestDb({ max: 6 });
		made.push(db);
		await Promise.all([runMigrations(db), runMigrations(db), runMigrations(db)]);
		const rows = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
		expect(n(rows)).toBe(2);
	});
});

describe('0001 drop duplicate organization slug index', () => {
	it('leaves only the unique constraint index, on fresh and baseline-only databases', async () => {
		const idx = async (db: Db) =>
			(
				(await db.execute(
					sql`select indexname from pg_indexes where tablename = 'organization' and indexdef ilike '%(slug)%' order by 1`
				)) as unknown as { indexname: string }[]
			).map((r) => r.indexname);

		const fresh = await createEmptyTestDb();
		made.push(fresh);
		await runMigrations(fresh);
		expect(await idx(fresh)).toEqual(['organization_slug_unique']);

		// A live database: baseline applied, 0001 not yet (journal rows up to 0000 only).
		const old = await createEmptyTestDb();
		made.push(old);
		await runMigrations(old);
		await old.execute(sql`create unique index "organization_slug_uidx" on "organization" ("slug")`);
		await old.execute(
			sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`
		);
		expect(await idx(old)).toEqual(['organization_slug_uidx', 'organization_slug_unique']);
		await runMigrations(old);
		expect(await idx(old)).toEqual(['organization_slug_unique']);
	});
});
