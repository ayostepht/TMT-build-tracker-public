import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { type Db } from '../db';
import { createTestDb } from '../db/testing';
import { templateModelJobs, templateModels, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { assertTemplateAdmin } from './guard';
import { QuotaError } from '../quota';
import {
	countActiveConversions,
	createJob,
	failStaleModelJobs,
	getJob,
	runQueue,
	setConverter
} from './jobs';
import type { ConvertResult } from './convert';

let db: Db;
let tid: string;
let dir: string;

const result: ConvertResult = {
	version: 'abc123',
	size: 1234,
	slugs: ['seat-center'],
	triangles: 10,
	ms: 5,
	report: [{ file: 'a.step', slug: 'seat-center', status: 'ok' }]
};
const zip = (name: string) => {
	const p = join(dir, name);
	writeFileSync(p, 'PK');
	return p;
};

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	tid = (await db.select().from(templates))[0]!.id;
	dir = mkdtempSync(join(tmpdir(), 'tmt-jobs-'));
});
afterEach(async () => {
	setConverter(null);
	vi.unstubAllEnvs();
});

describe('model jobs', () => {
	it('goes queued -> running -> done, records the model and deletes the zip', async () => {
		const seen: string[] = [];
		const input = zip('a.zip');
		const job = await createJob(db, {
			templateId: tid,
			inputPath: input,
			userId: null,
			fileName: 'steps.zip'
		});
		expect(job.status).toBe('queued');
		setConverter(async (_p, t, onProgress) => {
			seen.push((await getJob(db, tid, job.id))!.status);
			expect(t.parts.length).toBeGreaterThan(10);
			onProgress(50, 'half way');
			// Progress writes are fire-and-forget: wait for this one instead of racing it.
			await vi.waitFor(async () => expect((await getJob(db, tid, job.id))!.progress).toBe(50));
			return result;
		});
		await runQueue(db);
		expect(seen).toEqual(['running']);
		const done = (await getJob(db, tid, job.id))!;
		expect(done.status).toBe('done');
		expect(done.progress).toBe(100);
		expect(done.finishedAt).toBeInstanceOf(Date);
		expect(done.report).toHaveLength(1);
		const model = (
			await db.select().from(templateModels).where(eq(templateModels.templateId, tid))
		)[0]!;
		expect(model.version).toBe('abc123');
		expect(model.sourceNote).toContain('steps.zip');
		expect(existsSync(input)).toBe(false);
	});

	it('a progress write that lands after the job finished does not overwrite it', async () => {
		const job = await createJob(db, {
			templateId: tid,
			inputPath: zip('late.zip'),
			userId: null,
			fileName: 'late.zip'
		});
		let report: ((pct: number, message: string) => void) | null = null;
		setConverter(async (_p, _t, onProgress) => {
			report = onProgress;
			return result;
		});
		await runQueue(db);
		report!(70, 'late');
		// The write is fire-and-forget; give it time to land (or be filtered out).
		await new Promise((r) => setTimeout(r, 300));
		const j = (await getJob(db, tid, job.id))!;
		expect(j.status).toBe('done');
		expect(j.progress).toBe(100);
		expect(j.message).toContain('late.zip');
	});

	it('marks the job failed with the error message', async () => {
		const job = await createJob(db, {
			templateId: tid,
			inputPath: zip('b.zip'),
			userId: null,
			fileName: 'x.zip'
		});
		setConverter(async () => {
			throw new Error('out of memory');
		});
		await runQueue(db);
		const j = (await getJob(db, tid, job.id))!;
		expect(j.status).toBe('failed');
		expect(j.message).toBe('out of memory');
		expect(await db.select().from(templateModels)).toHaveLength(0);
	});

	it('refuses a second job for the same kit while one is active', async () => {
		await createJob(db, {
			templateId: tid,
			inputPath: zip('c.zip'),
			userId: null,
			fileName: 'x.zip'
		});
		await expect(
			createJob(db, {
				templateId: tid,
				inputPath: zip('d.zip'),
				userId: null,
				fileName: 'y.zip'
			})
		).rejects.toMatchObject({ status: 409 });
	});

	it('runs jobs one at a time, oldest first', async () => {
		const other = (
			await db.insert(templates).values({ slug: 'other', name: 'Other', version: '1' }).returning()
		)[0];
		const a = await createJob(db, {
			templateId: tid,
			inputPath: zip('e.zip'),
			userId: null,
			fileName: 'a.zip'
		});
		await new Promise((r) => setTimeout(r, 3));
		const b = await createJob(db, {
			templateId: other.id,
			inputPath: zip('f.zip'),
			userId: null,
			fileName: 'b.zip'
		});
		let running = 0;
		let maxRunning = 0;
		const order: string[] = [];
		setConverter(async (_p, t) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			order.push(t.id);
			await new Promise((r) => setTimeout(r, 5));
			running--;
			return result;
		});
		await Promise.all([runQueue(db), runQueue(db)]);
		expect(maxRunning).toBe(1);
		expect(order).toEqual([tid, other.id]);
		expect((await getJob(db, other.id, b.id))!.status).toBe('done');
		expect((await getJob(db, tid, a.id))!.status).toBe('done');
	});

	it('fails stale running jobs on startup but leaves queued ones', async () => {
		const running = await createJob(db, {
			templateId: tid,
			inputPath: zip('g.zip'),
			userId: null,
			fileName: 'x.zip'
		});
		await db
			.update(templateModelJobs)
			.set({ status: 'running' })
			.where(eq(templateModelJobs.id, running.id));
		expect(await failStaleModelJobs(db)).toBe(1);
		const j = (await getJob(db, tid, running.id))!;
		expect(j.status).toBe('failed');
		expect(j.message).toMatch(/restart/);
		const queued = await createJob(db, {
			templateId: tid,
			inputPath: zip('h.zip'),
			userId: null,
			fileName: 'x.zip'
		});
		expect(await failStaleModelJobs(db)).toBe(0);
		expect((await getJob(db, tid, queued.id))!.status).toBe('queued');
	});
});

describe('model admin permissions', () => {
	it('lets only the site admin through and hides everything else as 404', async () => {
		vi.stubEnv('ADMIN_EMAILS', 'first@example.test');
		await db.insert(user).values({
			id: 'u1',
			name: 'First',
			email: 'first@example.test',
			emailVerified: true,
			createdAt: new Date(1000)
		});
		await db.insert(user).values({
			id: 'u2',
			name: 'Second',
			email: 'second@example.test',
			emailVerified: true,
			createdAt: new Date(2000)
		});
		await expect(
			assertTemplateAdmin(db, { id: 'u1', email: 'first@example.test', emailVerified: true }, tid)
		).resolves.toBeUndefined();
		await expect(
			assertTemplateAdmin(db, { id: 'u2', email: 'second@example.test', emailVerified: true }, tid)
		).rejects.toMatchObject({ status: 404 });
		await expect(assertTemplateAdmin(db, { id: 'u1' }, 'missing')).rejects.toBeInstanceOf(ApiError);
	});
});

describe('runQueue', () => {
	it('picks up a job queued after an earlier run found the queue empty', async () => {
		await runQueue(db);
		setConverter(async () => result);
		const job = await createJob(db, {
			templateId: tid,
			inputPath: zip('late.zip'),
			userId: null,
			fileName: 'x.zip'
		});
		await runQueue(db);
		expect((await getJob(db, tid, job.id))!.status).toBe('done');
	});
});

describe('conversion slots per user', () => {
	const mkTpl = async (slug: string) =>
		(await db.insert(templates).values({ slug, name: slug, version: '1' }).returning())[0].id;
	const job = (templateId: string, userId: string | null, name: string) =>
		createJob(db, { templateId, inputPath: zip(name), userId, fileName: name });

	beforeEach(async () => {
		for (const [i, id] of ['adm', 'u1', 'u2'].entries())
			await db.insert(user).values({
				id,
				name: id,
				email: `${id}@x.test`,
				emailVerified: true,
				createdAt: new Date(5 + i)
			});
		vi.stubEnv('ADMIN_EMAILS', 'adm@x.test');
	});

	it('limit 1: a second queued job is refused (409 + code), other users are not', async () => {
		vi.stubEnv('QUOTA_STEP_CONVERSIONS_PER_USER', '1');
		const t2 = await mkTpl('t2');
		await job(tid, 'u1', 'a.zip');
		let err: unknown;
		try {
			await job(t2, 'u1', 'b.zip');
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(QuotaError);
		expect(err).toMatchObject({ status: 409, code: 'quota' });
		await expect(job(t2, 'u2', 'c.zip')).resolves.toBeDefined();
	});

	it('unlimited when set to off', async () => {
		vi.stubEnv('QUOTA_STEP_CONVERSIONS_PER_USER', 'off');
		const ids = [tid, await mkTpl('t2'), await mkTpl('t3')];
		for (const [i, t] of ids.entries()) await job(t, 'u1', `${i}.zip`);
		expect(await countActiveConversions(db, 'u1')).toBe(3);
	});

	it('the slot frees after success and after failure', async () => {
		vi.stubEnv('QUOTA_STEP_CONVERSIONS_PER_USER', '1');
		const t2 = await mkTpl('t2');
		await job(tid, 'u1', 'a.zip');
		setConverter(async () => result);
		await runQueue(db);
		await job(t2, 'u1', 'b.zip'); // done freed it
		setConverter(async () => {
			throw new Error('boom');
		});
		await runQueue(db);
		await expect(job(tid, 'u1', 'c.zip')).resolves.toBeDefined(); // failed freed it
	});

	it('a stale running row blocks until startup fails it, then frees the slot', async () => {
		vi.stubEnv('QUOTA_STEP_CONVERSIONS_PER_USER', '1');
		const j = await job(tid, 'u1', 'a.zip');
		await db
			.update(templateModelJobs)
			.set({ status: 'running' })
			.where(eq(templateModelJobs.id, j.id));
		await expect(job(await mkTpl('t2'), 'u1', 'b.zip')).rejects.toBeInstanceOf(QuotaError);
		expect(await failStaleModelJobs(db)).toBe(1);
		await expect(job(await mkTpl('t3'), 'u1', 'c.zip')).resolves.toBeDefined();
	});

	it('site admin is exempt', async () => {
		vi.stubEnv('QUOTA_STEP_CONVERSIONS_PER_USER', '1');
		await job(tid, 'adm', 'a.zip'); // adm@x.test is in ADMIN_EMAILS
		await expect(job(await mkTpl('t2'), 'adm', 'b.zip')).resolves.toBeDefined();
	});
});
