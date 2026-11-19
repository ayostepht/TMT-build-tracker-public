import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '#lib/server/db/index.ts';
import { createTestDb, dropTestDb } from '#lib/server/db/testing.ts';
import { first } from '#lib/server/db/index.ts';
import { member, organization, templates, user } from '#lib/server/db/schema.ts';
import { templateSeeds } from '#lib/server/seed/index.ts';
import { seedTemplates } from '#lib/server/seed/run.ts';
import { defaultTemplate } from '#lib/server/templates/fork.ts';
import { templateModelPath } from '#lib/server/config.ts';
import { GET } from './+server.ts';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('#lib/server/db/index.ts', async (orig) => ({
	...(await orig<object>()),
	getDb: () => h.db
}));

let db: Db;
let builtIn: string;

function call(id: string, user: { id: string; email: string; emailVerified: boolean } | null) {
	return GET({
		params: { id },
		locals: { user },
		request: new Request('http://x.test/m.glb')
	} as unknown as Parameters<typeof GET>[0]);
}

function putModel(id: string) {
	const p = templateModelPath(id);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, 'glb-bytes');
}

beforeEach(async () => {
	vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'tmt-glb-')));
	db = await createTestDb();
	h.db = db;
	await seedTemplates(db, templateSeeds);
	builtIn = (await defaultTemplate(db)).id;
	await db.insert(organization).values({ id: 'o1', name: 'T1', slug: 't1', createdAt: new Date() });
	const base = (await first(db.select().from(templates).where(eq(templates.id, builtIn))))!;
	await db
		.insert(templates)
		.values({ ...base, id: 'tpl-owned', slug: 'owned-copy', ownerOrgId: 'o1' });
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

describe('model.glb caching', () => {
	it('the built-in kit may be cached publicly, for visitors and signed-in users', async () => {
		putModel(builtIn);
		const anon = await call(builtIn, null);
		expect(anon.status).toBe(200);
		expect(anon.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		const u = await call(builtIn, { id: 'x', email: 'x@x.test', emailVerified: true });
		expect(u.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
	});

	it("a workspace's kit copy stays private", async () => {
		await db.insert(user).values({
			id: 'u1',
			name: 'U',
			email: 'u1@x.test',
			createdAt: new Date()
		});
		await db.insert(member).values({
			id: 'm1',
			organizationId: 'o1',
			userId: 'u1',
			role: 'owner',
			createdAt: new Date()
		});
		putModel('tpl-owned');
		const res = await call('tpl-owned', { id: 'u1', email: 'u1@x.test', emailVerified: true });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
	});
});
