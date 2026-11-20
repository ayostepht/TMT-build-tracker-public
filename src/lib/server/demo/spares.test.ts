import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import { createAuth, type Auth } from '../auth';
import { enableTestSignIn } from '../auth-test-helpers';
import type { Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { builds, session, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { cleanupExpiredDemos, liveDemoCount } from './cleanup';
import { DemoBusyError, DemoRateError, resetDemoLimits, startDemo } from './index';
import {
	claimSpare,
	fillSpares,
	requestSpareTopUp,
	spareCount,
	SPARE_CLAIM_MARGIN_MS,
	takeStaleSpares,
	SPARE_MAX_AGE_MS,
	startSparePool,
	stopSparePool
} from './spares';

let db: Db;
let auth: Auth;

beforeEach(async () => {
	vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'tmt-spares-')));
	vi.stubEnv('ADMIN_EMAILS', 'admin@example.test');
	vi.stubEnv('DEMO_STARTS_PER_MINUTE', '1000');
	for (const k of ['TMT_MODE', 'PUBLIC_URL']) vi.stubEnv(k, '');
	enableTestSignIn();
	resetDemoLimits();
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	auth = createAuth(db);
});
afterEach(async () => {
	await stopSparePool();
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

const jar = () => ({ set: () => {} });
const spareRows = (prefix: string) =>
	db
		.select()
		.from(user)
		.where(and(eq(user.isDemo, true), like(user.email, `${prefix}%`)));

describe('spare demos', () => {
	it('fills the pool with ready spares, each with a workspace and sample build, and is idempotent', async () => {
		expect(await fillSpares(db, { target: 2 })).toBe(2);
		expect(await spareRows('spare-ready-')).toHaveLength(2);
		expect(await spareRows('spare-building-')).toHaveLength(0);
		expect(await db.select().from(builds)).toHaveLength(2);
		expect(await fillSpares(db, { target: 2 })).toBe(0);
		expect(await spareCount(db)).toBe(2);
	});

	it('unclaimed spares are not live demos: no cap, no cleanup, no sessions', async () => {
		await fillSpares(db, { target: 2 });
		expect(await liveDemoCount(db)).toBe(0);
		vi.stubEnv('DEMO_MAX_LIVE', '1');
		// cleanup leaves fresh spares alone (it only retires spares past their age)
		expect(await cleanupExpiredDemos(db, new Date(Date.now() + 3_600_000))).toBe(0);
		expect(await spareCount(db)).toBe(2);
		expect(await db.select().from(session)).toHaveLength(0);
	});

	it('starting a demo claims a spare: same user and build, 24 h from the claim, counted as live', async () => {
		await fillSpares(db, { target: 1 });
		const [spare] = await spareRows('spare-ready-');
		const [b] = await db.select().from(builds);
		await db.update(user).set({ createdAt: new Date(Date.now() - 3_600_000) }); // an hour old
		const before = Date.now();
		const buildId = await startDemo(auth, '203.0.113.1', jar());
		expect(buildId).toBe(b.id);
		const [u] = await db.select().from(user).where(eq(user.id, spare.id));
		expect(u.email).toMatch(/^demo-.+@demo\.invalid$/);
		expect(u.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(await liveDemoCount(db)).toBe(1);
		const [s] = await db.select().from(session).where(eq(session.userId, spare.id));
		expect(s.expiresAt.getTime()).toBeGreaterThan(before + 23 * 3_600_000);
		// a claimed demo expires like any other
		expect(await cleanupExpiredDemos(db, new Date(Date.now() + 25 * 3_600_000))).toBe(1);
	});

	it('the cap counts claimed demos only, and a claim past the cap is refused', async () => {
		await fillSpares(db, { target: 3 });
		vi.stubEnv('DEMO_MAX_LIVE', '2');
		await startDemo(auth, '203.0.113.1', jar());
		await startDemo(auth, '203.0.113.2', jar());
		await expect(startDemo(auth, '203.0.113.3', jar())).rejects.toBeInstanceOf(DemoBusyError);
		expect(await spareCount(db)).toBe(1);
		expect(await liveDemoCount(db)).toBe(2);
	});

	it('the per-address limit is not used up by spares, and applies before any claim', async () => {
		await fillSpares(db, { target: 3 });
		vi.stubEnv('DEMO_PER_IP_PER_HOUR', '1');
		await startDemo(auth, '203.0.113.1', jar());
		await expect(startDemo(auth, '203.0.113.1', jar())).rejects.toBeInstanceOf(DemoRateError);
		expect(await spareCount(db)).toBe(2);
	});

	it('two parallel claims get different spares; with one spare the second falls back to a new demo', async () => {
		await fillSpares(db, { target: 2 });
		const ids = await Promise.all(
			[1, 2].map(async () => db.transaction(async (tx) => (await claimSpare(tx))?.id))
		);
		expect(ids[0]).toBeTruthy();
		expect(ids[1]).toBeTruthy();
		expect(ids[0]).not.toBe(ids[1]);

		const one = await createTestDb();
		try {
			await seedTemplates(one, templateSeeds);
			await fillSpares(one, { target: 1 });
			const a = createAuth(one);
			const results = await Promise.all([
				startDemo(a, '203.0.113.1', jar()),
				startDemo(a, '203.0.113.2', jar())
			]);
			expect(results[0]).not.toBe(results[1]);
			expect(await liveDemoCount(one)).toBe(2);
			expect(await spareCount(one)).toBe(0);
			expect(await one.select().from(builds)).toHaveLength(2);
		} finally {
			await dropTestDb(one);
		}
	}, 60_000);

	it('with no spare ready, a start builds the demo on the spot, as before', async () => {
		const buildId = await startDemo(auth, '203.0.113.1', jar());
		expect(buildId).toBeTruthy();
		expect(await liveDemoCount(db)).toBe(1);
	});

	it('a spare still being seeded is never handed out', async () => {
		await fillSpares(db, {
			target: 1,
			seed: async () => {
				// mid-seed: the reservation exists but is not claimable
				expect(await db.transaction(async (tx) => claimSpare(tx))).toBeUndefined();
				await startDemo(auth, '203.0.113.1', jar()); // falls back instead
			}
		});
		expect(await liveDemoCount(db)).toBe(1);
	});

	it('DEMO_SPARES=0 keeps today behavior: no pool, no claim', async () => {
		vi.stubEnv('DEMO_SPARES', '0');
		await fillSpares(db, { target: 1 });
		const [spare] = await spareRows('spare-ready-');
		startSparePool(db);
		await stopSparePool();
		expect(await spareCount(db)).toBe(1);
		await startDemo(auth, '203.0.113.1', jar());
		// the ready spare was not touched; a new demo was built
		expect((await db.select().from(user).where(eq(user.id, spare.id)))[0].email).toMatch(
			/^spare-ready-/
		);
		expect(await liveDemoCount(db)).toBe(1);
	});

	it('recycles stale spares and abandoned reservations', async () => {
		await fillSpares(db, { target: 2 });
		const [old] = await spareRows('spare-ready-');
		await db
			.update(user)
			.set({ createdAt: new Date(Date.now() - SPARE_MAX_AGE_MS - 60_000) })
			.where(eq(user.id, old.id));
		// a stale spare is not handed out even before it is recycled
		const claimed = await db.transaction(async (tx) => claimSpare(tx));
		expect(claimed?.id).not.toBe(old.id);
		// an abandoned reservation
		await db.insert(user).values({
			id: 'orphan',
			name: 'Demo maker',
			email: 'spare-building-x@demo.invalid',
			isDemo: true,
			createdAt: new Date(Date.now() - 3_600_000)
		});
		expect(await fillSpares(db, { target: 2 })).toBeGreaterThanOrEqual(1);
		expect(await db.select().from(user).where(eq(user.id, old.id))).toHaveLength(0);
		expect(await db.select().from(user).where(eq(user.id, 'orphan'))).toHaveLength(0);
		expect(await spareRows('spare-ready-')).toHaveLength(2);
	});

	it('a spare being claimed or already claimed survives the recycler', async () => {
		await fillSpares(db, { target: 2 });
		const [a, b] = await spareRows('spare-ready-');
		const old = new Date(Date.now() - SPARE_MAX_AGE_MS - 60_000);
		await db.update(user).set({ createdAt: old }).where(eq(user.id, a.id));
		// a claimed demo is no longer a spare: the recycler never sees it
		await db.update(user).set({ email: 'demo-x@demo.invalid' }).where(eq(user.id, a.id));
		expect(await takeStaleSpares(db)).toEqual([]);
		// a stale spare locked by a claim in progress is skipped, and survives
		await db.update(user).set({ email: a.email }).where(eq(user.id, a.id));
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		let locked!: () => void;
		const isLocked = new Promise<void>((r) => (locked = r));
		const claimer = db.transaction(async (tx) => {
			await tx.execute(sql`select id from "user" where id = ${a.id} for update`);
			locked();
			await held;
			await tx.update(user).set({ email: 'demo-y@demo.invalid' }).where(eq(user.id, a.id));
		});
		await isLocked;
		expect(await takeStaleSpares(db)).toEqual([]);
		release();
		await claimer;
		expect((await db.select().from(user).where(eq(user.id, a.id)))[0].email).toBe(
			'demo-y@demo.invalid'
		);
		expect(await db.select().from(user).where(eq(user.id, b.id))).toHaveLength(1);
	});

	it('claimable and recyclable ages do not overlap', async () => {
		await fillSpares(db, { target: 1 });
		const [a] = await spareRows('spare-ready-');
		const nearly = new Date(Date.now() - SPARE_MAX_AGE_MS + SPARE_CLAIM_MARGIN_MS - 30_000);
		await db.update(user).set({ createdAt: nearly }).where(eq(user.id, a.id));
		expect(await db.transaction(async (tx) => claimSpare(tx))).toBeUndefined();
		expect(await takeStaleSpares(db)).toEqual([]);
	});

	it('cleanup removes spares past their age even with DEMO_SPARES=0', async () => {
		await fillSpares(db, { target: 2 });
		const [a] = await spareRows('spare-ready-');
		await db
			.update(user)
			.set({ createdAt: new Date(Date.now() - SPARE_MAX_AGE_MS - 60_000) })
			.where(eq(user.id, a.id));
		vi.stubEnv('DEMO_SPARES', '0');
		await cleanupExpiredDemos(db);
		expect(await db.select().from(user).where(eq(user.id, a.id))).toHaveLength(0);
		expect(await spareCount(db)).toBe(1);
	});

	it('a fill trims surplus spares when the target was lowered', async () => {
		await fillSpares(db, { target: 3 });
		expect(await spareCount(db)).toBe(3);
		await fillSpares(db, { target: 1 });
		expect(await spareCount(db)).toBe(1);
		expect(await spareRows('spare-ready-')).toHaveLength(1);
	});

	it('two fills at once do not make more than the target (advisory lock)', async () => {
		await Promise.all([fillSpares(db, { target: 2 }), fillSpares(db, { target: 2 })]);
		expect(await spareCount(db)).toBe(2);
	});

	it('a failed seed leaves no spare behind', async () => {
		const n = await fillSpares(db, {
			target: 1,
			seed: async () => {
				throw new Error('boom');
			}
		});
		expect(n).toBe(0);
		expect(await db.select().from(user)).toHaveLength(0);
	});

	it('the pool fills in the background, tops up after a claim, and stops on close', async () => {
		vi.stubEnv('DEMO_SPARES', '1');
		let seeds = 0;
		const real = (await import('./seed')).seedDemoBuild;
		startSparePool(db, {
			seed: async (d, id) => {
				seeds++;
				return real(d, id);
			}
		});
		await vi.waitFor(async () => expect(await spareRows('spare-ready-')).toHaveLength(1), {
			timeout: 30_000
		});
		await startDemo(auth, '203.0.113.1', jar());
		requestSpareTopUp(); // the claim already asked; a second ask must not double up
		await vi.waitFor(async () => expect(await spareRows('spare-ready-')).toHaveLength(1), {
			timeout: 30_000
		});
		expect(seeds).toBe(2);
		await stopSparePool();
		requestSpareTopUp();
		await startDemo(auth, '203.0.113.2', jar()); // claims the spare; nothing refills
		await new Promise((r) => setTimeout(r, 300));
		expect(await spareCount(db)).toBe(0);
		expect(seeds).toBe(2);
	}, 90_000);

	it('stopping ends a fill in progress after the current spare', async () => {
		vi.stubEnv('DEMO_SPARES', '3');
		let started!: () => void;
		const seeding = new Promise<void>((r) => (started = r));
		startSparePool(db, {
			seed: async () => {
				started();
				await new Promise((r) => setTimeout(r, 100));
			}
		});
		await seeding;
		await stopSparePool();
		// the spare in progress and the two not started are all gone: nothing is left half-made
		expect(await spareRows('spare-building-')).toHaveLength(0);
		expect(await spareCount(db)).toBe(0);
	}, 30_000);
});
