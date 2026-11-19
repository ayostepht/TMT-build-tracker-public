import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	databasePoolMax,
	databaseStatementTimeoutMs,
	databaseWarnings,
	demoConfig
} from '../config';
import { closeDb, openDb } from './index';

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
			expect(o.idle_timeout).toBe(30);
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
