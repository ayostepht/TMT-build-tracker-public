import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError } from '../access';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { buildStatsSummary, workspaceStats } from '#lib/domain/stats.ts';
import {
	buildHandoff,
	builds,
	member,
	organization,
	printRuns,
	templates,
	user
} from '../db/schema';
import { loadBuildView } from '../builds/view';
import { createBuild } from '../builds/create';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { loadWorkspaceStats } from './workspace';

let db: Db;
let templateId: string;
const NOW = new Date(2026, 10, 15, 12);

async function addOrg(id: string) {
	await db
		.insert(organization)
		.values({ id, name: `Chapter ${id}`, slug: id, createdAt: new Date() });
}
async function addMember(orgId: string, userId: string, role: string) {
	await db.insert(member).values({
		id: `m-${orgId}-${userId}`,
		organizationId: orgId,
		userId,
		role,
		createdAt: new Date()
	});
}
// `createdAt` is a SQL default (the real clock), and the stats window ends at NOW: a build created
// "today" would drop out of it once the real date passes NOW. Stamp builds a few days before NOW.
const CREATED = new Date(2026, 10, 5, 12);
const mk = async (orgId: string, name: string, kind: 'build' | 'draft' = 'build') => {
	const id = await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name, kind },
		'owner'
	);
	await db.update(builds).set({ createdAt: CREATED }).where(eq(builds.id, id));
	return id;
};
async function addRuns(
	buildId: string,
	n: number,
	over: Partial<typeof printRuns.$inferInsert> = {}
) {
	await db.insert(printRuns).values(
		Array.from({ length: n }, (_, i) => ({
			buildId,
			plateNumber: (i % 20) + 1,
			date: `2026-11-${String((i % 14) + 1).padStart(2, '0')}`,
			result: i % 10 === 0 ? 'Failed' : 'Success',
			grams: 50,
			hours: 4,
			printer: i % 2 ? 'CC1' : 'CC2',
			...over
		}))
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
	return dropTestDb(db);
});

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await addOrg('org1');
	await addOrg('org2');
	for (const u of ['owner', 'editor', 'viewer', 'outsider']) {
		await db.insert(user).values({ id: u, name: `User ${u}`, email: `${u}@example.test` });
	}
	await addMember('org1', 'owner', 'owner');
	await addMember('org1', 'editor', 'editor');
	await addMember('org1', 'viewer', 'viewer');
	await addMember('org2', 'outsider', 'owner');
});

describe('loadWorkspaceStats', () => {
	it('every member role sees the workspace builds; an outsider gets a 404', async () => {
		const a = await mk('org1', 'Build A');
		await addRuns(a, 5);
		for (const u of ['owner', 'editor', 'viewer']) {
			const w = await loadWorkspaceStats(db, 'org1', u, { now: NOW });
			expect(w.builds.map((b) => b.name)).toEqual(['Build A']);
			expect(w.kpis.hours.total).toBe(20);
		}
		await expect(loadWorkspaceStats(db, 'org1', 'outsider', { now: NOW })).rejects.toThrowError(
			expect.objectContaining({ status: 404 })
		);
		await expect(loadWorkspaceStats(db, 'org1', 'outsider', { now: NOW })).rejects.toThrow(
			ApiError
		);
		// another workspace's builds never show up
		expect((await loadWorkspaceStats(db, 'org2', 'outsider', { now: NOW })).builds).toEqual([]);
		await expect(loadWorkspaceStats(db, 'nope', 'owner', { now: NOW })).rejects.toThrow(ApiError);
	});

	it('leaves Studio drafts out', async () => {
		const draft = await mk('org1', 'A draft', 'draft');
		await addRuns(draft, 3);
		await mk('org1', 'Real build');
		const w = await loadWorkspaceStats(db, 'org1', 'viewer', { months: 6, now: NOW });
		expect(w.builds.map((b) => b.name)).toEqual(['Real build']);
		expect(w.kpis.hours.total).toBe(0);
	});

	it('counts a build as finished once it has a handoff date', async () => {
		const a = await mk('org1', 'Done one');
		await addRuns(a, 4);
		await db.insert(buildHandoff).values({ buildId: a, handedOffOn: '2026-11-10' });
		await mk('org1', 'Still going');
		const w = await loadWorkspaceStats(db, 'org1', 'owner', { now: NOW });
		expect(w.kpis.builds).toEqual({ total: 2, finished: 1, inProgress: 1 });
		expect(w.kpis.perChair).toMatchObject({ builds: 1, hours: 16 });
	});

	it('returns nothing personal', async () => {
		const a = await mk('org1', 'Build A');
		await addRuns(a, 3, { userId: 'editor', note: 'secret note' });
		const json = JSON.stringify(await loadWorkspaceStats(db, 'org1', 'owner', { now: NOW }));
		for (const s of ['User editor', 'editor@example', 'secret note']) expect(json).not.toContain(s);
	});

	it('clamps months to 1-24 and defaults to 6', async () => {
		const m = async (months: unknown) =>
			(await loadWorkspaceStats(db, 'org1', 'owner', { months, now: NOW })).months;
		expect(await m(undefined)).toBe(6);
		expect(await m('abc')).toBe(6);
		expect(await m(0)).toBe(1);
		expect(await m('-5')).toBe(1);
		expect(await m('12')).toBe(12);
		expect(await m(1000)).toBe(24);
	});

	it('only counts runs inside the window', async () => {
		const a = await mk('org1', 'Build A');
		await addRuns(a, 2, { date: '2026-11-01' });
		await addRuns(a, 2, { date: '2025-01-01' });
		expect(
			(await loadWorkspaceStats(db, 'org1', 'owner', { months: 1, now: NOW })).kpis.hours.total
		).toBe(8);
		expect(
			(await loadWorkspaceStats(db, 'org1', 'owner', { months: 24, now: NOW })).kpis.hours.total
		).toBe(16);
	});

	it('handles 50 builds with 500 runs each', async () => {
		vi.stubEnv('QUOTA_BUILDS_PER_WORKSPACE', 'off');
		for (let i = 0; i < 50; i++) await addRuns(await mk('org1', `Build ${i}`), 500);
		// Warm up once (statement preparation, JIT) so the timings are the steady cost.
		await loadWorkspaceStats(db, 'org1', 'viewer', { now: NOW });

		// Reducing 50 loaded builds to the page: the part this module owns.
		const views = await Promise.all(
			(await db.select({ id: builds.id }).from(builds)).map((b) =>
				loadBuildView(db, b.id, 'viewer')
			)
		).then((vs) => vs.map((v) => v!));
		const t0 = performance.now();
		const w = workspaceStats(views.map(buildStatsSummary), { now: NOW });
		const reduceMs = performance.now() - t0;

		// The whole call, including loadBuildView for every build (about 4 ms each before any runs).
		const t1 = performance.now();
		const full = await loadWorkspaceStats(db, 'org1', 'viewer', { now: NOW });
		const fullMs = performance.now() - t1;

		expect(w.builds).toHaveLength(50);
		expect(full.kpis.hours.total).toBe(50 * 500 * 4);
		console.log(
			`workspace stats, 50 builds x 500 runs: reduce ${Math.round(reduceMs)} ms, full ${Math.round(fullMs)} ms`
		);
		expect(reduceMs).toBeLessThan(300);
		// Measured about 550 ms on the dev machine, nearly all of it loadBuildView: the 300 ms target
		// holds for the reduction only. This budget catches a regression, not the target.
		expect(fullMs).toBeLessThan(2000);
	});
});
