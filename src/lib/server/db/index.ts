import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import {
	databasePoolMax,
	databaseStatementTimeoutMs,
	databaseUrl,
	databaseWarnings,
	MIN_POOL_MAX
} from '../config';
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

/**
 * Seconds an unused connection stays open (`DATABASE_IDLE_TIMEOUT_S`, default 600, 0 = never close).
 * A new connection to a remote database costs several round trips (TCP, TLS, login), a few hundred
 * milliseconds that the next request would wait for, so idle ones are kept for a while. The TCP
 * keep-alive (60 s, postgres-js's default) and `max_lifetime` still weed out dead ones.
 */
export function databaseIdleTimeoutSeconds(): number {
	const raw = (process.env.DATABASE_IDLE_TIMEOUT_S ?? '').trim();
	return /^\d+$/.test(raw) ? Math.min(Number(raw), 86_400) : 600;
}

/** Connections `warmPool` opens (`DATABASE_WARM_CONNECTIONS`, default 3, 0 = off), never more than the pool holds. */
export function databaseWarmConnections(): number {
	const raw = (process.env.DATABASE_WARM_CONNECTIONS ?? '').trim();
	return /^\d+$/.test(raw) ? Math.min(Number(raw), 20) : 3;
}

/**
 * `DATABASE_PREPARE=on`: reuse server-side prepared statements. Off by default. Drizzle sends every
 * query with `prepare: false`, and postgres-js then asks the server for the parameter types first,
 * so a query with a text parameter costs two round trips; a prepared statement costs one after its
 * first use on a connection. Needs a direct connection or Supabase's session pooler (port 5432),
 * not a transaction pooler (port 6543), which cannot hold prepared statements.
 */
export function databasePrepare(): boolean {
	return /^(on|1|true|yes)$/i.test((process.env.DATABASE_PREPARE ?? '').trim());
}

export interface OpenDbOptions {
	/** Connections in the pool (default `DATABASE_POOL_MAX` or 10; at least 2). */
	max?: number;
	/** Server-side statement timeout in ms (default `DATABASE_STATEMENT_TIMEOUT_MS`, 30 s; 0 = none). */
	statementTimeoutMs?: number;
}

type Prepareable = {
	unsafe: (...args: never[]) => unknown;
	begin?: (...args: never[]) => unknown;
	savepoint?: (...args: never[]) => unknown;
};

/**
 * Make every `unsafe` call (drizzle's only way in) a prepared statement, on the pool and on the
 * handle of each transaction and savepoint opened from it. Drizzle passes `prepare: false` for
 * the queries it does not name, and a statement left unprepared costs an extra round trip.
 */
function preparing(c: Prepareable): void {
	const unsafe = c.unsafe.bind(c) as (...a: unknown[]) => unknown;
	c.unsafe = ((query: string, args?: unknown[], options?: Record<string, unknown>) =>
		unsafe(query, args, { ...options, prepare: true })) as never;
	for (const name of ['begin', 'savepoint'] as const) {
		const open = c[name]?.bind(c) as ((...a: unknown[]) => unknown) | undefined;
		if (!open) continue;
		// `begin([options,] fn)` and `savepoint([name,] fn)`: the callback is always last.
		c[name] = ((...args: unknown[]) => {
			const fn = args.pop() as (tx: Prepareable) => unknown;
			return open(...args, (tx: Prepareable) => {
				preparing(tx);
				return fn(tx);
			});
		}) as never;
	}
}

/**
 * Open a connection pool and wrap it in drizzle. `prepare` is off unless `DATABASE_PREPARE=on`, which
 * keeps it compatible with Supabase's transaction pooler (pgbouncer): that cannot hold named prepared statements.
 * `sslmode=require` in the URL turns TLS on (postgres-js reads it).
 */
export function openDb(url: string, opts: OpenDbOptions = {}): Db {
	const timeout = opts.statementTimeoutMs ?? databaseStatementTimeoutMs(url);
	const client = postgres(url, {
		max: Math.max(MIN_POOL_MAX, opts.max ?? databasePoolMax()),
		prepare: databasePrepare(),
		onnotice: () => {},
		connect_timeout: 15,
		// Idle connections are kept for `DATABASE_IDLE_TIMEOUT_S` (10 min) so a request after a quiet
		// moment does not pay for a new TLS connection; every connection is recycled within the hour
		// and the keep-alive probes detect a dropped one, so a dead connection does not stay.
		idle_timeout: databaseIdleTimeoutSeconds(),
		max_lifetime: 60 * 60,
		...(timeout > 0 ? { connection: { statement_timeout: timeout } } : {})
	});
	if (databasePrepare()) preparing(client);
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
		// A long migration (index build, backfill) is not cut off by the app's statement timeout.
		await tx`set local statement_timeout = 0`;
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
		for (const w of databaseWarnings(url)) console.warn(`[tmt] ${w}`);
		instance = openDb(url);
	}
	return instance;
}

/**
 * Open a few connections now (in parallel, so each is really a separate one) and touch them again
 * every `everyMs` so they never reach the idle timeout. The first requests after a start, or after a
 * quiet hour, then find warm connections instead of each paying the handshake with the database.
 * Failures are ignored: a cold connection is only slower. The timer does not keep the process alive.
 * Returns a function that stops it.
 */
export function warmPool(
	db: Db = getDb(),
	connections: number = databaseWarmConnections(),
	everyMs = 4 * 60_000
): () => void {
	const n = Math.min(connections, db.$client.options.max ?? connections);
	if (n <= 0) return () => {};
	stopWarming(); // one warm-up timer per process
	warmed = db;
	const touch = () =>
		Promise.all(
			// pg_sleep keeps each statement busy long enough that the pool opens a connection for each.
			Array.from({ length: n }, () => db.execute(sql`select pg_sleep(0.05)`))
		).catch(() => {});
	void touch();
	const timer = setInterval(() => void touch(), everyMs);
	timer.unref();
	const stop = () => {
		clearInterval(timer);
		if (stopWarming === stop) stopWarming = () => {};
	};
	stopWarming = stop;
	return stop;
}

/** Stops the warm-up timer of this process (set by `warmPool`). */
let stopWarming: () => void = () => {};
let warmed: Db | null = null;

/** Close a pool (default: the singleton). For shutdown and tests. */
export async function closeDb(db?: Db): Promise<void> {
	const target = db ?? instance;
	// The warm-up touches one pool: stop it when that pool closes, so its timer and queries end too.
	if (!target || target === warmed) stopWarming();
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
