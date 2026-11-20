import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	databasePoolMax,
	databaseStatementTimeoutMs,
	databaseWarnings,
	demoConfig
} from '../config';
import {
	closeDb,
	databaseIdleTimeoutSeconds,
	databasePrepare,
	databaseWarmConnections,
	openDb,
	warmPool
} from './index';

afterEach(() => vi.unstubAllEnvs());

describe('database pool settings', () => {
	it('the pool is never smaller than 2, and the setting that was too small is reported', () => {
		vi.stubEnv('DATABASE_POOL_MAX', '1');
		expect(databasePoolMax()).toBe(2);
		expect(databaseWarnings('postgres://u:p@localhost/db').join(' ')).toMatch(/DATABASE_POOL_MAX/);
		vi.stubEnv('DATABASE_POOL_MAX', '0');
		expect(databasePoolMax()).toBe(2);
		vi.stubEnv('DATABASE_POOL_MAX', '7');
		expect(databasePoolMax()).toBe(7);
		expect(databaseWarnings('postgres://u:p@localhost/db')).toEqual([]);
	});

	it('openDb never makes a pool below 2 and sets the connection timeouts', async () => {
		const db = openDb('postgres://u:p@localhost:5432/x', { max: 1 });
		try {
			const o = db.$client.options;
			expect(o.max).toBe(2);
			expect(o.idle_timeout).toBe(600);
			expect(o.max_lifetime).toBe(3600);
			expect(o.connect_timeout).toBe(15);
			expect(o.connection.statement_timeout).toBe(30_000);
		} finally {
			await closeDb(db);
		}
	});

	it('the statement timeout is configurable, off with 0, and off by default behind a transaction pooler', () => {
		expect(databaseStatementTimeoutMs('postgres://u:p@db.example.test:5432/x')).toBe(30_000);
		expect(databaseStatementTimeoutMs('postgres://u:p@aws-0.pooler.example.test:6543/x')).toBe(0);
		vi.stubEnv('DATABASE_STATEMENT_TIMEOUT_MS', '5000');
		expect(databaseStatementTimeoutMs('postgres://u:p@aws-0.pooler.example.test:6543/x')).toBe(
			5000
		);
		vi.stubEnv('DATABASE_STATEMENT_TIMEOUT_MS', '0');
		expect(databaseStatementTimeoutMs('postgres://u:p@db.example.test/x')).toBe(0);
	});

	it('idle connections are kept 10 minutes by default; the setting is validated', () => {
		expect(databaseIdleTimeoutSeconds()).toBe(600);
		vi.stubEnv('DATABASE_IDLE_TIMEOUT_S', '45');
		expect(databaseIdleTimeoutSeconds()).toBe(45);
		vi.stubEnv('DATABASE_IDLE_TIMEOUT_S', '0');
		expect(databaseIdleTimeoutSeconds()).toBe(0);
		vi.stubEnv('DATABASE_IDLE_TIMEOUT_S', 'soon');
		expect(databaseIdleTimeoutSeconds()).toBe(600);
		vi.stubEnv('DATABASE_IDLE_TIMEOUT_S', '');
		expect(databaseWarmConnections()).toBe(3);
		vi.stubEnv('DATABASE_WARM_CONNECTIONS', '0');
		expect(databaseWarmConnections()).toBe(0);
		vi.stubEnv('DATABASE_WARM_CONNECTIONS', '99');
		expect(databaseWarmConnections()).toBe(20);
	});

	it('prepared statements are off unless DATABASE_PREPARE=on, and then work through drizzle', async () => {
		expect(databasePrepare()).toBe(false);
		vi.stubEnv('DATABASE_PREPARE', 'on');
		expect(databasePrepare()).toBe(true);
		const url = process.env.TEST_DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/postgres';
		const db = openDb(url, { max: 2 });
		try {
			expect(db.$client.options.prepare).toBe(true);
			// The same statement twice (the second runs the prepared one), with a text parameter.
			for (const word of ['one', 'two'])
				expect(await db.execute(sql`select ${word}::text as w`)).toEqual([{ w: word }]);
			expect(await db.execute(sql`select oid from pg_class where relname = ${'nope'}`)).toEqual([]);
		} finally {
			await closeDb(db);
		}
	});

	it('warmPool opens several real connections and stops cleanly', async () => {
		const url = process.env.TEST_DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/postgres';
		const db = openDb(url, { max: 4 });
		let stop = () => {};
		try {
			expect(db.$client.options.idle_timeout).toBe(600);
			stop = warmPool(db, 3, 60_000);
			await vi.waitFor(
				async () => {
					const [row] = await db.$client`
						select count(*)::int as n from pg_stat_activity
						where datname = current_database() and usename = current_user
						and backend_start > now() - interval '30 seconds'`;
					expect(row.n).toBeGreaterThanOrEqual(3);
				},
				{ timeout: 5000, interval: 100 }
			);
			// Off: nothing is started and the stop function is still safe to call.
			warmPool(db, 0)();
		} finally {
			stop();
			await closeDb(db);
		}
	});

	it('closeDb stops the warm-up timer, and closing twice is harmless', async () => {
		vi.useFakeTimers();
		const url = process.env.TEST_DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/postgres';
		const db = openDb(url, { max: 2 });
		try {
			warmPool(db, 1, 1000);
			expect(vi.getTimerCount()).toBe(1);
			await closeDb(db);
			expect(vi.getTimerCount()).toBe(0);
			await closeDb(db);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a stuck statement is cancelled by the server timeout', async () => {
		const url = process.env.TEST_DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/postgres';
		const db = openDb(url, { max: 2, statementTimeoutMs: 300 });
		try {
			await expect(db.$client`select pg_sleep(5)`).rejects.toThrow(/statement timeout/i);
		} finally {
			await closeDb(db);
		}
	});

	it('warns about a remote database without TLS, never echoing the URL', () => {
		const w = databaseWarnings('postgres://user:secretpw@db.example.test:5432/app');
		expect(w).toHaveLength(1);
		expect(w[0]).not.toContain('secretpw');
		expect(databaseWarnings('postgres://u:p@db.example.test/app?sslmode=require')).toEqual([]);
		expect(databaseWarnings('postgres://u:p@db.example.test/app?sslmode=verify-full')).toEqual([]);
		expect(databaseWarnings('postgres://u:p@db.example.test/app?sslmode=prefer')).toHaveLength(1);
		expect(databaseWarnings('postgres://u:p@localhost:5432/app')).toEqual([]);
		expect(databaseWarnings('postgres://u:p@127.0.0.1:5432/app')).toEqual([]);
	});

	it('DEMO_STARTS_PER_MINUTE defaults to 20 and is validated', () => {
		expect(demoConfig().startsPerMinute).toBe(20);
		vi.stubEnv('DEMO_STARTS_PER_MINUTE', '3');
		expect(demoConfig().startsPerMinute).toBe(3);
		vi.stubEnv('DEMO_STARTS_PER_MINUTE', 'lots');
		expect(() => demoConfig()).toThrow(/DEMO_STARTS_PER_MINUTE/);
	});
});
