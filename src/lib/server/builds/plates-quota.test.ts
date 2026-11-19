import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb } from '../db/testing';
import { buildPlates, buildUploads, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { makeProjectThreeMf } from '../threemf/fixtures';
import { parseThreeMfBytes } from '../threemf';
import {
	acquireExpensiveReadSlot,
	openExpensiveReads,
	releaseWhenDone,
	acquireUploadSlot,
	assertUploadRoom,
	openUploadSlots,
	QuotaError,
	workspaceUploadBytes
} from '../quota';
import { createBuild } from './create';
import { applyUpload, createUpload, uploadDir } from './plates';
import { loadBuildView } from './view';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('#lib/server/db/index.ts', async (orig) => ({
	...(await orig<object>()),
	getDb: () => h.db
}));

let db: Db;
let dir: string;
let templateId: string;
const orgId = 'org1';
const MB = 1048576;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'tmt-plates-quota-'));
	vi.stubEnv('DATA_DIR', dir);
	vi.stubEnv('TMT_MODE', 'public');
	vi.stubEnv('PUBLIC_URL', 'https://example.test');
	vi.stubEnv('QUOTA_UPLOAD_MB_PER_WORKSPACE', '1');
	db = await createTestDb();
	h.db = db;
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	for (const u of ['owner', 'boss']) {
		await db
			.insert(user)
			.values({ id: u, name: u, email: `${u}@example.test`, emailVerified: u === 'boss' });
		await db.insert(member).values({
			id: `m-${u}`,
			organizationId: orgId,
			userId: u,
			role: 'owner',
			createdAt: new Date()
		});
	}
});
afterEach(async () => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

const mk = async () =>
	await createBuild(db, { organizationId: orgId, templateId, designId: null, name: 'B' }, 'owner');

async function parsedWithThumb(bytes: number) {
	const zip = makeProjectThreeMf({
		sliced: true,
		filamentTypes: ['PETG'],
		plates: [
			{
				name: 'Plate 1',
				prediction: 3600,
				weight: 10,
				filaments: { 1: 10 },
				objects: [{ name: '3DTMT H SEAT CENTER REV A.STEP' }]
			}
		]
	});
	const parsed = await parseThreeMfBytes(zip);
	parsed.plates[0].thumbnail = new Uint8Array(bytes);
	return { parsed, size: zip.length };
}
const up = async (id: string, thumbBytes: number, userId = 'owner') => {
	const { parsed, size } = await parsedWithThumb(thumbBytes);
	return await createUpload(
		db,
		id,
		userId,
		{ name: 'a.3mf', size },
		parsed,
		(await loadBuildView(db, id, userId))!
	);
};
const files = () => {
	const d = join(dir, 'uploads', '3mf');
	return existsSync(d) ? readdirSync(d) : [];
};

describe('kept 3MF bytes count against the workspace', () => {
	it('counts pending upload thumbnails and applied plate thumbnails, from disk', async () => {
		const id = await mk();
		const r = await up(id, 300_000);
		expect(await workspaceUploadBytes(db, orgId)).toBe(300_000);
		await applyUpload(db, id, 'owner', r.uploadId, {
			mapping: r.suggestions.mapping,
			filamentMap: r.suggestions.filamentMap,
			mode: 'plates',
			convertRuns: true
		});
		const kept = await db.select().from(buildPlates).where(eq(buildPlates.buildId, id));
		expect(kept.some((p) => p.thumbnailPath)).toBe(true);
		expect(await workspaceUploadBytes(db, orgId)).toBe(300_000);
		expect(files().filter((f) => f === r.uploadId)).toEqual([]); // pending dir removed
	});

	it('refuses an upload that pushes the workspace over and writes no file', async () => {
		const id = await mk();
		await expect(up(id, 2 * MB)).rejects.toMatchObject({ status: 409, code: 'quota' });
		expect(files()).toEqual([]);
		expect(await db.select().from(buildUploads)).toHaveLength(0);
	});

	it('replacing a pending upload counts only the difference', async () => {
		const id = await mk();
		const firstUp = await up(id, 700_000);
		const second = await up(id, 900_000); // 900k total after replace, not 1.6 MB
		expect(await workspaceUploadBytes(db, orgId)).toBe(900_000);
		expect(existsSync(uploadDir(firstUp.uploadId))).toBe(false);
		await expect(up(id, 1_100_000)).rejects.toBeInstanceOf(QuotaError);
		// the refused replacement keeps the previous pending upload intact
		expect(existsSync(uploadDir(second.uploadId))).toBe(true);
		expect(await workspaceUploadBytes(db, orgId)).toBe(900_000);
	});

	it('is "already over" when the kept bytes exceed the limit', async () => {
		const id = await mk();
		mkdirSync(join(dir, 'uploads', 'plates', id), { recursive: true });
		writeFileSync(join(dir, 'uploads', 'plates', id, '1.png'), new Uint8Array(MB + 10));
		await db
			.insert(buildPlates)
			.values({ buildId: id, number: 99, name: 'P', thumbnailPath: `plates/${id}/1.png` });
		await expect(assertUploadRoom(db, orgId, 0, { userId: 'owner' })).rejects.toThrow(QuotaError);
		await expect(up(id, 10)).rejects.toBeInstanceOf(QuotaError);
	});

	it('null limit measures nothing; site admins are exempt', async () => {
		const id = await mk();
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		await expect(up(id, 2 * MB, 'owner')).rejects.toBeInstanceOf(QuotaError);
		await expect(up(id, 2 * MB, 'boss')).resolves.toBeTruthy();
		vi.stubEnv('QUOTA_UPLOAD_MB_PER_WORKSPACE', 'off');
		await expect(up(id, 5 * MB)).resolves.toBeTruthy();
	});
});

describe('upload slots', () => {
	const u = { id: 'owner', email: 'owner@example.test', emailVerified: false };

	it('refuses past the cap with 429 + code, releases exactly once', async () => {
		const a = await acquireUploadSlot(db, u);
		const b = await acquireUploadSlot(db, u);
		expect(openUploadSlots('owner')).toBe(2);
		try {
			await acquireUploadSlot(db, u);
			throw new Error('expected refusal');
		} catch (e) {
			expect((e as QuotaError).status).toBe(429);
			expect((e as QuotaError).code).toBe('quota');
		}
		a();
		a();
		expect(openUploadSlots('owner')).toBe(1);
		b();
		expect(openUploadSlots('owner')).toBe(0);
	});

	it('null limit never refuses; admins are exempt', async () => {
		vi.stubEnv('QUOTA_CONCURRENT_UPLOADS_PER_USER', 'off');
		const rel = await Promise.all([1, 2, 3, 4].map(() => acquireUploadSlot(db, u)));
		rel.forEach((r) => r());
		vi.stubEnv('QUOTA_CONCURRENT_UPLOADS_PER_USER', '1');
		vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
		const boss = { id: 'boss', email: 'boss@example.test', emailVerified: true };
		const r = [await acquireUploadSlot(db, boss), await acquireUploadSlot(db, boss)];
		r.forEach((x) => x());
		expect(openUploadSlots('boss')).toBe(0);
	});
});

describe('expensive read slots', () => {
	const u = { id: 'reader', email: 'reader@example.test', emailVerified: false };

	it('caps concurrent reads and releases exactly once', async () => {
		const a = await acquireExpensiveReadSlot(db, u, 0);
		const b = await acquireExpensiveReadSlot(db, u, 0);
		expect(openExpensiveReads('reader')).toBe(2);
		await expect(acquireExpensiveReadSlot(db, u, 0)).rejects.toMatchObject({
			status: 429,
			code: 'quota'
		});
		a();
		a();
		expect(openExpensiveReads('reader')).toBe(1);
		b();
		expect(openExpensiveReads('reader')).toBe(0);
	});

	it('limits the rate per user, and admins are exempt', async () => {
		const v = { id: 'burst', email: 'burst@example.test', emailVerified: false };
		for (let i = 0; i < 30; i++) (await acquireExpensiveReadSlot(db, v, 5_000_000))();
		await expect(acquireExpensiveReadSlot(db, v, 5_000_000)).rejects.toMatchObject({ status: 429 });
		expect(openExpensiveReads('burst')).toBe(0);
		vi.stubEnv('ADMIN_EMAILS', 'boss2@example.test');
		const boss = { id: 'boss2', email: 'boss2@example.test', emailVerified: true };
		for (let i = 0; i < 35; i++) (await acquireExpensiveReadSlot(db, boss, 5_000_000))();
	});

	it('a stream frees its slot when it ends or is cancelled', async () => {
		const mk = () =>
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1]));
					c.close();
				}
			});
		const w = { id: 'streamer', email: 'streamer@example.test', emailVerified: false };
		const r1 = await acquireExpensiveReadSlot(db, w, 9_000_000);
		const s1 = releaseWhenDone(mk(), r1);
		const rd = s1.getReader();
		while (!(await rd.read()).done);
		expect(openExpensiveReads('streamer')).toBe(0);
		const r2 = await acquireExpensiveReadSlot(db, w, 9_000_000);
		await releaseWhenDone(mk(), r2).cancel();
		expect(openExpensiveReads('streamer')).toBe(0);
	});
});

describe('POST plates/upload route', () => {
	const call = async (
		body: BodyInit | ReadableStream,
		user = { id: 'owner', email: 'owner@example.test', emailVerified: false },
		id = ''
	) => {
		const { POST } = await import('../../../routes/api/builds/[id]/plates/upload/+server');
		const request = new Request('http://x/u?name=a.3mf', {
			method: 'POST',
			body: body as BodyInit,
			headers: { 'content-type': 'application/octet-stream' },
			// @ts-expect-error node fetch option
			duplex: 'half'
		});
		return POST({
			params: { id },
			request,
			url: new URL(request.url),
			locals: { user }
		} as never);
	};

	it('answers 507 before any file is created when the disk is nearly full', async () => {
		const id = await mk();
		vi.stubEnv('MIN_FREE_DISK_MB', String(1024 ** 4)); // more than any disk has free
		const res = await call(new Uint8Array([1, 2, 3]), undefined, id);
		expect(res.status).toBe(507);
		expect(files()).toEqual([]);
		expect(openUploadSlots('owner')).toBe(0);
	});

	it('answers 409 quota before streaming when the workspace is already over', async () => {
		const id = await mk();
		mkdirSync(join(dir, 'uploads', 'plates', id), { recursive: true });
		writeFileSync(join(dir, 'uploads', 'plates', id, '1.png'), new Uint8Array(MB + 10));
		await db
			.insert(buildPlates)
			.values({ buildId: id, number: 99, name: 'P', thumbnailPath: `plates/${id}/1.png` });
		const res = await call(new Uint8Array([1, 2, 3]), undefined, id);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe('quota');
		expect(files()).toEqual([]);
		expect(openUploadSlots('owner')).toBe(0);
	});

	it('releases the slot when the client aborts mid-stream, and answers 429 when full', async () => {
		const id = await mk();
		const aborted = new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(1000));
			},
			pull() {
				throw new Error('connection reset');
			}
		});
		const res = await call(aborted, undefined, id);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(openUploadSlots('owner')).toBe(0);
		expect(files()).toEqual([]);

		const held = [
			await acquireUploadSlot(db, { id: 'owner' }),
			await acquireUploadSlot(db, { id: 'owner' })
		];
		const full = await call(new Uint8Array([1]), undefined, id);
		expect(full.status).toBe(429);
		expect((await full.json()).code).toBe('quota');
		held.forEach((r) => r());
		expect(openUploadSlots('owner')).toBe(0);
	});
});
