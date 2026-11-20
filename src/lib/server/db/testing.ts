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
import { createDatabase, dropDatabase } from './test-global-setup';

const names = new WeakMap<Db, string>();

/** Pool size per test database: small, so parallel test files cannot exhaust the server's connections. */
const DEFAULT_TEST_POOL_MAX = 3;
/** Seconds an idle test connection lives: a pool nobody closed gives its connections back quickly. */
const TEST_IDLE_TIMEOUT_S = 2;

// Every open test database, so test-setup.ts can close the ones a test file never dropped. Kept on
// globalThis (not imported) so the setup file stays free of the DB code.
const open: Set<Db> = ((globalThis as Record<symbol, unknown>)[Symbol.for('tmt.testDbs')] ??=
	new Set<Db>()) as Set<Db>;

function track(url: string, max: number | undefined, name: string): Db {
	const db = openDb(url, {
		max: max ?? DEFAULT_TEST_POOL_MAX,
		idleTimeoutSeconds: TEST_IDLE_TIMEOUT_S
	});
	names.set(db, name);
	open.add(db);
	return db;
}
let admin: ReturnType<typeof postgres> | undefined;

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

/** A fresh database (schema applied, no rows, no seeds). `max` = pool size (default 3). */
export async function createTestDb(opts: { max?: number } = {}): Promise<Db> {
	const ctx = inject('tmtTestDb');
	if (!ctx)
		throw new Error('Test database template missing: run through vitest (see vitest.config.ts).');
	admin ??= postgres(ctx.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
	const name = `${ctx.prefix}${randomBytes(4).toString('hex')}`;
	await createDatabase(admin, name, ctx.template);
	return track(withDatabase(ctx.adminUrl, name), opts.max, name);
}

/** A fresh database with NO schema (migration and cold-start tests). */
export async function createEmptyTestDb(opts: { max?: number } = {}): Promise<Db> {
	const ctx = inject('tmtTestDb');
	if (!ctx)
		throw new Error('Test database template missing: run through vitest (see vitest.config.ts).');
	admin ??= postgres(ctx.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
	const name = `${ctx.prefix}${randomBytes(4).toString('hex')}`;
	await createDatabase(admin, name);
	return track(withDatabase(ctx.adminUrl, name), opts.max, name);
}

/** Close the pool and drop the database made by `createTestDb` / `createEmptyTestDb`. */
export async function dropTestDb(db: Db): Promise<void> {
	const name = names.get(db);
	open.delete(db);
	await closeDb(db);
	// Best effort: the run's teardown drops whatever is left (a busy database is retried there too).
	if (name && admin) await dropDatabase(admin, name).catch(() => {});
	names.delete(db);
}
