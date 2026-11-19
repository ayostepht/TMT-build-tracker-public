// Vitest globalSetup: build one migrated, empty template database per run; every test file
// then clones it (`CREATE DATABASE … TEMPLATE …`, tens of ms) via `createTestDb()` in testing.ts.
// Teardown drops the template and every clone, even those a crashed test file left behind.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { openDb, runMigrations, closeDb } from './index';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://tmt:tmt@localhost:5432/tmt_test';

declare module 'vitest' {
	export interface ProvidedContext {
		tmtTestDb: { adminUrl: string; template: string; prefix: string };
	}
}

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

export default async function setup(project: TestProject) {
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
			await admin.unsafe(`drop database if exists "${datname}" with (force)`);
		}
		await admin.end({ timeout: 5 });
	};
}
