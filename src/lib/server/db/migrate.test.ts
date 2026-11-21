import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { runMigrations, type Db } from './index';
import { createEmptyTestDb, dropTestDb } from './testing';

const made: Db[] = [];
afterAll(async () => {
	for (const d of made) await dropTestDb(d);
});

const n = (rows: unknown) => (rows as { n: number }[])[0].n;

const dropPieceColumns = async (db: Db) => {
	await db.execute(sql`alter table "build_parts" drop column "printing_comps"`);
	await db.execute(sql`alter table "print_runs" drop column "comps"`);
	await db.execute(sql`alter table "printer_jobs" drop column "comps"`);
};

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
		expect(n(rows)).toBe(3);
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
		// Back to the baseline-only state: forget 0001 and 0002 and undo 0002's columns.
		await dropPieceColumns(old);
		await old.execute(
			sql`delete from drizzle.__drizzle_migrations where id > (select min(id) from drizzle.__drizzle_migrations)`
		);
		expect(await idx(old)).toEqual(['organization_slug_uidx', 'organization_slug_unique']);
		await runMigrations(old);
		expect(await idx(old)).toEqual(['organization_slug_unique']);
	});
});

describe('0002 piece prints', () => {
	it('adds three nullable jsonb columns to a database at 0001 without touching its rows', async () => {
		const db = await createEmptyTestDb();
		made.push(db);
		await runMigrations(db);
		// The live state: 0000 and 0001 applied, 0002 not.
		await dropPieceColumns(db);
		await db.execute(
			sql`delete from drizzle.__drizzle_migrations where id > (select min(id) + 1 from drizzle.__drizzle_migrations)`
		);
		await db.execute(
			sql`insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com')`
		);
		await db.execute(
			sql`insert into organization (id, name, slug, created_at) values ('o1', 'Team', 'team', now())`
		);
		await db.execute(
			sql`insert into templates (id, slug, name, version) values ('t1', 'tmt', 'TMT', '1')`
		);
		await db.execute(
			sql`insert into builds (id, organization_id, template_id, name, created_by) values ('b1', 'o1', 't1', 'B', 'u1')`
		);
		await db.execute(sql`insert into build_parts (build_id, part_slug) values ('b1', 'seat')`);
		await db.execute(
			sql`insert into print_runs (id, build_id, date, result) values ('r1', 'b1', '2026-01-01', 'ok')`
		);
		await db.execute(
			sql`insert into printers (id, organization_id, name, kind, host) values ('p1', 'o1', 'P', 'manual', 'h')`
		);
		await db.execute(sql`insert into printer_jobs (id, printer_id) values ('j1', 'p1')`);

		await runMigrations(db);
		const cols = (await db.execute(
			sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
				where (table_name, column_name) in (('build_parts','printing_comps'),('print_runs','comps'),('printer_jobs','comps'))
				order by 1`
		)) as unknown as Record<string, string | null>[];
		expect(cols.map((c) => [c.table_name, c.data_type, c.is_nullable, c.column_default])).toEqual([
			['build_parts', 'jsonb', 'YES', null],
			['print_runs', 'jsonb', 'YES', null],
			['printer_jobs', 'jsonb', 'YES', null]
		]);
		const nulls = await db.execute(
			sql`select (select count(*)::int from build_parts where printing_comps is null)
				+ (select count(*)::int from print_runs where comps is null)
				+ (select count(*)::int from printer_jobs where comps is null) as n`
		);
		expect(n(nulls)).toBe(3);
		await runMigrations(db); // second run is a no-op
	});
});
