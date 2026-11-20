// Vitest globalSetup: build one migrated, empty template database per run; every test file
// then clones it (`CREATE DATABASE … TEMPLATE …`, tens of ms) via `createTestDb()` in testing.ts.
// Teardown drops the template and every clone, even those a crashed test file left behind.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { openDb, runMigrations, closeDb } from './index';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://tmt:tmt@localhost:5432/tmt_test';

declare module 'vitest' {
	export interface ProvidedContext {
		tmtTestDb: { adminUrl: string; template: string; prefix: string };
	}
}

type Admin = ReturnType<typeof postgres>;

/**
 * Transient while another backend is connected: `42501` when `WITH (FORCE)` may not terminate it
 * (an autovacuum worker or another role's session; `tmt` is not a superuser), `55006` when a
 * database (or a CREATE … TEMPLATE source) is in use. Both clear within moments.
 */
function isBusy(e: unknown): boolean {
	const code = (e as { code?: string }).code;
	return code === '42501' || code === '55006';
}

async function retryBusy(what: () => Promise<unknown>, attempts = 8): Promise<void> {
	for (let i = 1; ; i++) {
		try {
			await what();
			return;
		} catch (e) {
			if (!isBusy(e) || i >= attempts) throw e;
			await new Promise((r) => setTimeout(r, 50 * 2 ** Math.min(i, 5)));
		}
	}
}

/** `CREATE DATABASE`, retried while the template is briefly in use (autovacuum). */
export async function createDatabase(admin: Admin, name: string, template?: string): Promise<void> {
	await retryBusy(() =>
		admin.unsafe(`create database "${name}"${template ? ` template "${template}"` : ''}`)
	);
}

/** `DROP DATABASE … WITH (FORCE)`, retried while a backend it may not terminate is connected. */
export async function dropDatabase(admin: Admin, name: string): Promise<void> {
	await retryBusy(() => admin.unsafe(`drop database if exists "${name}" with (force)`));
}

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

export default async function setup(project: TestProject) {
	// One temp root per run: workers inherit TMPDIR, so every `mkdtemp(tmpdir())` in a test file
	// (and test-setup.ts's data directory) lands inside it and is removed in teardown, even for a
	// file whose afterAll never ran (all tests skipped, worker killed). Skipped when the caller
	// already points TMT_TEST_KEEP_TMP at something: then nothing is redirected or removed.
	let dataRoot: string | undefined;
	if (!process.env.TMT_TEST_KEEP_TMP) {
		dataRoot = mkdtempSync(join(tmpdir(), 'tmt-test-run-'));
		process.env.TMPDIR = dataRoot;
	}
	const removeDataRoot = () => {
		if (!dataRoot) return;
		try {
			rmSync(dataRoot, { recursive: true, force: true });
		} catch {
			// never fail a run over cleanup
		}
	};
	const adminUrl = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
	const run = randomBytes(4).toString('hex');
	const prefix = `tmt_t_${run}_`;
	const template = `tmt_tpl_${run}`;

	const admin = postgres(adminUrl, {
		max: 1,
		prepare: false,
		onnotice: () => {},
		connect_timeout: 5
	});
	try {
		await admin.unsafe(`create database ${template}`);
	} catch (e) {
		await admin.end({ timeout: 1 }).catch(() => {});
		removeDataRoot();
		throw new Error(
			`Cannot reach the test Postgres at ${new URL(adminUrl).host} (${(e as Error).message}).\n` +
				`Start it with scripts/dev-postgres.sh, or set TEST_DATABASE_URL to a Postgres the role can CREATE DATABASE on.`,
			{ cause: e }
		);
	}

	const db = openDb(withDatabase(adminUrl, template), { max: 1 });
	try {
		await runMigrations(db);
	} finally {
		await closeDb(db);
	}

	project.provide('tmtTestDb', { adminUrl, template, prefix });

	return async () => {
		const rows = await admin<{ datname: string }[]>`
			select datname from pg_database
			where datname = ${template} or datname like ${prefix.replace(/_/g, '\\_') + '%'}`;
		for (const { datname } of rows) {
			// A database left behind is harmless (scripts/dev-postgres.sh clean): never fail the run.
			await dropDatabase(admin, datname).catch((e: Error) =>
				console.warn(`[test db] could not drop ${datname}: ${e.message}`)
			);
		}
		await admin.end({ timeout: 5 });
		removeDataRoot();
	};
}
