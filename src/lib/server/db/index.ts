import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { databasePoolMax, databaseUrl } from '../config';
import * as schema from './schema';

export type Schema = typeof schema;

/** The drizzle database (postgres-js). All queries are async: `await` them. */
export type Db = PostgresJsDatabase<Schema> & { $client: Sql };

/** The handle inside `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What most data functions should accept: a plain Db or an open transaction. */
export type DbOrTx = Db | Tx;

export const MIGRATIONS_FOLDER = './drizzle';

/** Arbitrary constant; two starting containers serialise on this advisory lock. */
const MIGRATION_LOCK_KEY = 7_346_201_001;

export interface OpenDbOptions {
	/** Connections in the pool (default `DATABASE_POOL_MAX` or 10). */
	max?: number;
}

/**
 * Open a connection pool and wrap it in drizzle. `prepare: false` keeps it compatible with
 * Supabase's transaction pooler (pgbouncer), which cannot hold named prepared statements.
 * `sslmode=require` in the URL turns TLS on (postgres-js reads it).
 */
export function openDb(url: string, opts: OpenDbOptions = {}): Db {
	const client = postgres(url, {
		max: opts.max ?? databasePoolMax(),
		prepare: false,
		onnotice: () => {},
		connect_timeout: 15
	});
	return drizzle(client, { schema }) as Db;
}

/**
 * Apply pending migrations. Everything runs in one transaction behind a transaction-level
 * advisory lock, so two containers starting together cannot race (and the lock is safe through
 * a transaction pooler). Idempotent.
 */
export async function runMigrations(db: Db, folder: string = MIGRATIONS_FOLDER): Promise<void> {
	await db.$client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
		// A TransactionSql carries no `options`/`parameters`, which drizzle's postgres-js driver reads.
		const handle = tx as unknown as Sql;
		handle.options ??= db.$client.options;
		handle.parameters ??= db.$client.parameters;
		await migrate(drizzle(handle, { schema }), { migrationsFolder: folder });
	});
}

let instance: Db | undefined;

/** Lazily opened singleton so importing this module never connects (e.g. during build). */
export function getDb(): Db {
	if (!instance) {
		const url = databaseUrl();
		if (!url) throw new Error('DATABASE_URL is not set (a Postgres connection string).');
		instance = openDb(url);
	}
	return instance;
}

/** Close a pool (default: the singleton). For shutdown and tests. */
export async function closeDb(db?: Db): Promise<void> {
	const target = db ?? instance;
	if (!target) return;
	if (target === instance) instance = undefined;
	await target.$client.end({ timeout: 5 });
}

/**
 * Transaction-scoped advisory lock by name (released at commit/rollback). SQLite's synchronous
 * transactions made "count, then insert" atomic; in Postgres take this lock first, inside the
 * transaction, for any check-then-insert that must not race (quotas, one-active-job rules).
 */
export async function advisoryLock(tx: DbOrTx, name: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

/** First row of a query result, or undefined. Replaces SQLite's `.get()`. */
export async function first<T>(rows: PromiseLike<T[]>): Promise<T | undefined> {
	return (await rows)[0];
}

/** First row of a query result; throws when there is none. */
export async function one<T>(rows: PromiseLike<T[]>, what = 'row'): Promise<T> {
	const r = (await rows)[0];
	if (r === undefined) throw new Error(`Expected one ${what}, found none`);
	return r;
}
