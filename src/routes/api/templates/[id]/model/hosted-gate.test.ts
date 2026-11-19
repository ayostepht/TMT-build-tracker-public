import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/index.ts';
import { createTestDb, dropTestDb } from '#lib/server/db/testing.ts';
import { assertModelConversionAllowed } from '#lib/server/models/guard.ts';
import { templateSeeds } from '#lib/server/seed/index.ts';
import { seedTemplates } from '#lib/server/seed/run.ts';
import { defaultTemplate } from '#lib/server/templates/fork.ts';
import { POST } from './+server.ts';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('#lib/server/db/index.ts', async (orig) => ({
	...(await orig<object>()),
	getDb: () => h.db
}));
// The caller is an editor of the workspace that owns the template copy.
vi.mock('#lib/server/templates/fork.ts', async (orig) => ({
	...(await orig<object>()),
	canManageTemplate: async () => true
}));

let db: Db;
let tid: string;
const editor = { id: 'ed', email: 'ed@x.test', emailVerified: true };

beforeEach(async () => {
	vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'tmt-gate-')));
	vi.stubEnv('ADMIN_EMAILS', 'adm@x.test');
	db = await createTestDb();
	h.db = db;
	await seedTemplates(db, templateSeeds);
	tid = (await defaultTemplate(db)).id;
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

describe('3D model conversion on the hosted site', () => {
	it('is refused for a workspace editor who is not a site admin', async () => {
		await expect(assertModelConversionAllowed(db, editor)).rejects.toMatchObject({
			status: 403,
			message: 'Only site admins can convert 3D models on the hosted site.'
		});
		await expect(
			assertModelConversionAllowed(db, { ...editor, email: 'adm@x.test' })
		).resolves.toBeUndefined();
	});

	it('the upload route answers 403 before reading the body', async () => {
		const res = await POST({
			request: new Request('http://x.test/u', { method: 'POST', body: 'PK\x03\x04x' }),
			locals: { user: editor },
			params: { id: tid },
			url: new URL('http://x.test/u?name=a.zip')
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(403);
		expect((await res.json()).error).toMatch(/Only site admins/);
	});
});
