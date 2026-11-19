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
		expect(n(rows)).toBe(1);
	});
});
