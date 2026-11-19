// Test helper: an isolated, migrated, empty Postgres database per call. Only import from tests.
//
//   const db = await createTestDb();          // clone of the migrated template, tens of ms
//   afterAll(() => dropTestDb(db));           // optional: the run's teardown drops leftovers
//
// The template is built once per vitest run by test-global-setup.ts (see vitest.config.ts).
// Needs the local Postgres: run scripts/dev-postgres.sh (TEST_DATABASE_URL overrides the URL).
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';
import { closeDb, openDb, type Db } from './index';

const names = new WeakMap<Db, string>();
let admin: ReturnType<typeof postgres> | undefined;

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

/** A fresh database (schema applied, no rows, no seeds). `max` = pool size (default 4). */
export async function createTestDb(opts: { max?: number } = {}): Promise<Db> {
	const ctx = inject('tmtTestDb');
	if (!ctx)
		throw new Error('Test database template missing: run through vitest (see vitest.config.ts).');
	admin ??= postgres(ctx.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
	const name = `${ctx.prefix}${randomBytes(4).toString('hex')}`;
	await admin.unsafe(`create database ${name} template ${ctx.template}`);
	const db = openDb(withDatabase(ctx.adminUrl, name), { max: opts.max ?? 4 });
	names.set(db, name);
	return db;
}

/** A fresh database with NO schema (migration and cold-start tests). */
export async function createEmptyTestDb(opts: { max?: number } = {}): Promise<Db> {
	const ctx = inject('tmtTestDb');
	if (!ctx)
		throw new Error('Test database template missing: run through vitest (see vitest.config.ts).');
	admin ??= postgres(ctx.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
	const name = `${ctx.prefix}${randomBytes(4).toString('hex')}`;
	await admin.unsafe(`create database ${name}`);
	const db = openDb(withDatabase(ctx.adminUrl, name), { max: opts.max ?? 4 });
	names.set(db, name);
	return db;
}

/** Close the pool and drop the database made by `createTestDb` / `createEmptyTestDb`. */
export async function dropTestDb(db: Db): Promise<void> {
	const name = names.get(db);
	await closeDb(db);
	if (name && admin) await admin.unsafe(`drop database if exists "${name}" with (force)`);
	names.delete(db);
}
