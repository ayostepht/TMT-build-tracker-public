import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { createAuth, type Auth } from '../auth';
import { enableTestSignIn, signInTestUser } from '../auth-test-helpers';
import { requireNotDemoId } from '../access';
import { siteBlock } from '../account';
import { createBuild } from '../builds/create';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	account,
	activity,
	buildAssembly,
	buildParts,
	builds,
	colorDesigns,
	member,
	organization,
	printRuns,
	session,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { findPersonalWorkspace } from '../teams';
import { cleanupExpiredDemos, deleteDemoUser, liveDemoCount } from './cleanup';
import { DemoBusyError, DemoRateError, resetDemoLimits, startDemo } from './index';
import { demoLimitKey, MAX_TRACKED_ADDRESSES, takeDemoStart, trackedAddressCount } from './limits';

let db: Db;
let auth: Auth;

beforeEach(async () => {
	vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'tmt-demo-')));
	vi.stubEnv('ADMIN_EMAILS', 'admin@example.test');
	for (const k of ['TMT_MODE', 'PUBLIC_URL']) vi.stubEnv(k, '');
	enableTestSignIn();
	resetDemoLimits();
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	auth = createAuth(db);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await dropTestDb(db);
});

/** A cookie jar that records what the demo start set, like SvelteKit's `event.cookies`. */
function jar() {
	const set: Record<string, { value: string; opts: Record<string, unknown> }> = {};
	return {
		set,
		cookies: {
			set(name: string, value: string, opts: Record<string, unknown>) {
				set[name] = { value, opts };
			}
		}
	};
}

async function start(ip = '203.0.113.1') {
	const j = jar();
	const buildId = await startDemo(auth, ip, j.cookies);
	const cookie = Object.entries(j.set)
		.map(([n, c]) => `${n}=${encodeURIComponent(c.value)}`)
		.join('; ');
	return { buildId, jar: j, cookie };
}

describe('starting a demo', () => {
	it('makes a demo user with a personal workspace, a sample build with progress, and a 24 h session', async () => {
		const { buildId, jar: j } = await start();
		const [u] = await db.select().from(user);
		expect(u).toMatchObject({ isDemo: true, emailVerified: false, name: 'Demo maker' });
		expect(u.email).toMatch(/^demo-.+@demo\.invalid$/);
		// no sign-in provider account, so nothing to log in to later
		expect(await db.select().from(account)).toHaveLength(0);
		const ws = (await findPersonalWorkspace(db, u.id))!;
		const b = (await db.select().from(builds))[0];
		expect(b).toMatchObject({
			id: buildId,
			organizationId: ws.id,
			kind: 'build',
			name: 'Sample chair'
		});
		// realistic progress
		const statuses = (
			await db.select().from(buildParts).where(eq(buildParts.buildId, buildId))
		).map((p) => p.status);
		for (const s of ['Printed', 'Printing', 'Reprint', 'To print'])
			expect(statuses, s).toContain(s);
		expect((await db.select().from(printRuns)).length).toBeGreaterThanOrEqual(4);
		expect((await db.select().from(printRuns)).some((r) => r.result === 'Failed')).toBe(true);
		expect(
			(await db.select().from(buildAssembly).where(eq(buildAssembly.buildId, buildId))).filter(
				(a) => a.done
			)
		).toHaveLength(2);
		expect((await db.select().from(activity)).length).toBeGreaterThan(8);
		const [design] = await db
			.select()
			.from(colorDesigns)
			.where(eq(colorDesigns.authorUserId, u.id));
		expect(design.name).toBe('Sample colors');
		// session: one, ends within the demo lifetime, cookie set
		const [s] = await db.select().from(session);
		expect(s.userId).toBe(u.id);
		const ms = s.expiresAt.getTime() - Date.now();
		expect(ms).toBeGreaterThan(23.5 * 3600_000);
		expect(ms).toBeLessThanOrEqual(24 * 3600_000);
		expect(Object.keys(j.set).some((n) => n.includes('session_token'))).toBe(true);
		expect(s.ipAddress ?? '').toBe('');
	});

	it('the cookie signs in as the demo user, who is flagged and never an admin', async () => {
		const { cookie } = await start();
		const got = await auth.api.getSession({ headers: new Headers({ cookie }) });
		expect(got?.user).toMatchObject({ isDemo: true });
		const { isSiteAdmin } = await import('../access');
		expect(await isSiteAdmin(db, got!.user)).toBe(false);
	});

	it('refuses past the live cap with a busy error and creates nothing', async () => {
		vi.stubEnv('DEMO_MAX_LIVE', '1');
		await start('203.0.113.1');
		await expect(start('203.0.113.2')).rejects.toBeInstanceOf(DemoBusyError);
		expect(await liveDemoCount(db)).toBe(1);
	});

	it('limits starts per IP per hour, not across IPs', async () => {
		vi.stubEnv('DEMO_PER_IP_PER_HOUR', '2');
		await start('203.0.113.1');
		await start('203.0.113.1');
		const err = await start('203.0.113.1').catch((e) => e);
		expect(err).toBeInstanceOf(DemoRateError);
		expect(err.retryAfter).toBeGreaterThan(0);
		await expect(start('203.0.113.9')).resolves.toBeTruthy();
	});

	it('a failed seed leaves no user behind', async () => {
		await db.delete(templates);
		await expect(start()).rejects.toThrow();
		expect(await db.select().from(user)).toHaveLength(0);
		expect(await db.select().from(organization)).toHaveLength(0);
	});

	it('demo users do not count as accounts for the account caps or the site-admin checks', async () => {
		vi.stubEnv('QUOTA_ACCOUNTS_TOTAL', '1');
		await start();
		const real = await signInTestUser(auth, 'Real', 'real@example.test');
		expect(real.id).toBeTruthy();
		// the only real account is "only_account", whatever demos exist
		const u = (await db.select().from(user).where(eq(user.email, 'real@example.test')))[0];
		expect((await siteBlock(db, u.id))?.code).toBe('only_account');
	});
});

describe('what a demo may do', () => {
	it('is held to two builds, with a sentence that points at signing in', async () => {
		const { cookie } = await start();
		const [u] = await db.select().from(user);
		const ws = (await findPersonalWorkspace(db, u.id))!;
		const tpl = (await first(db.select({ id: templates.id }).from(templates)))!.id;
		const mk = (name: string) =>
			createBuild(db, { organizationId: ws.id, templateId: tpl, designId: null, name }, u.id);
		await mk('Second'); // the sample is the first
		await expect(mk('Third')).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/demo holds up to 2.*Sign in/)
		});
		expect((await db.select({ n: count() }).from(builds))[0].n).toBe(2);
		void cookie;
	});

	it('cannot create teams, invite, or link a provider (server side)', async () => {
		const { cookie } = await start();
		const headers = new Headers({ cookie });
		await expect(
			auth.api.createOrganization({ body: { name: 'Mine', slug: 'mine' }, headers })
		).rejects.toMatchObject({ status: 'FORBIDDEN' });
		expect(await db.select().from(organization)).toHaveLength(1); // only the personal workspace
		const ctx = await auth.$context;
		const [u] = await db.select().from(user);
		await expect(
			ctx.internalAdapter.createAccount({ userId: u.id, providerId: 'google', accountId: 'g1' })
		).rejects.toMatchObject({ status: 'FORBIDDEN' });
		await expect(requireNotDemoId(db, u.id)).rejects.toMatchObject({ status: 403 });
	});

	it('real users pass requireNotDemoId', async () => {
		const real = await signInTestUser(auth, 'Real', 'real@example.test');
		await expect(requireNotDemoId(db, real.id)).resolves.toBeUndefined();
	});
});

describe('ending a demo', () => {
	it('signing out deletes the user, its workspace, builds and sessions at once', async () => {
		const { cookie } = await start();
		const res = await auth.handler(
			new Request('http://localhost:3000/api/auth/sign-out', {
				method: 'POST',
				headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' },
				body: '{}'
			})
		);
		expect(res.status).toBe(200);
		expect(await db.select().from(user)).toHaveLength(0);
		expect(await db.select().from(builds)).toHaveLength(0);
		expect(await db.select().from(organization)).toHaveLength(0);
		expect(await db.select().from(session)).toHaveLength(0);
		expect(
			await db.select().from(colorDesigns).where(eq(colorDesigns.name, 'Sample colors'))
		).toHaveLength(0);
	});

	it('signing out of a real account deletes nothing', async () => {
		const real = await signInTestUser(auth, 'Real', 'real@example.test');
		const res = await auth.handler(
			new Request('http://localhost:3000/api/auth/sign-out', {
				method: 'POST',
				headers: {
					cookie: real.headers.get('cookie')!,
					origin: 'http://localhost:3000',
					'content-type': 'application/json'
				},
				body: '{}'
			})
		);
		expect(res.status).toBe(200);
		expect(await db.select().from(user)).toHaveLength(1);
	});

	it('deleteDemoUser refuses a real user', async () => {
		const real = await signInTestUser(auth, 'Real', 'real@example.test');
		await expect(deleteDemoUser(db, real.id)).rejects.toMatchObject({ status: 403 });
		expect(await db.select().from(user)).toHaveLength(1);
	});

	it('cleanup removes demos older than 24 h and nothing else, and is idempotent', async () => {
		await start('203.0.113.1');
		await start('203.0.113.2');
		const real = await signInTestUser(auth, 'Real', 'real@example.test');
		const old = (await db.select().from(user).where(eq(user.isDemo, true)))[0];
		await db
			.update(user)
			.set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
			.where(eq(user.id, old.id));
		expect(await cleanupExpiredDemos(db)).toBe(1);
		expect(await liveDemoCount(db)).toBe(1);
		expect(await db.select().from(user).where(eq(user.id, real.id))).toHaveLength(1);
		expect(await db.select().from(builds)).toHaveLength(1);
		expect(await db.select().from(member).where(eq(member.userId, old.id))).toHaveLength(0);
		expect(await cleanupExpiredDemos(db)).toBe(0);
		// a demo that is just past the lifetime goes at the cutoff
		const later = new Date(Date.now() + 24 * 3600_000 + 1000);
		expect(await cleanupExpiredDemos(db, later)).toBe(1);
		expect(await liveDemoCount(db)).toBe(0);
		expect(await db.select().from(user)).toHaveLength(1);
	});

	it('two overlapping cleanups delete each demo once (advisory lock)', async () => {
		for (let i = 0; i < 3; i++) await start(`203.0.113.${i + 1}`);
		const later = new Date(Date.now() + 25 * 3600_000);
		const [a, b] = await Promise.all([
			cleanupExpiredDemos(db, later),
			cleanupExpiredDemos(db, later)
		]);
		expect(a + b).toBe(3);
		expect(await liveDemoCount(db)).toBe(0);
	});
});

describe('demo starts under a small connection pool', () => {
	it('more parallel starts than pool connections all finish, and the live cap holds', async () => {
		const small = await createTestDb({ max: 3 });
		try {
			await seedTemplates(small, templateSeeds);
			const smallAuth = createAuth(small);
			vi.stubEnv('DEMO_MAX_LIVE', '5');
			vi.stubEnv('DEMO_STARTS_PER_MINUTE', '100');
			const t0 = Date.now();
			const results = await Promise.race([
				Promise.allSettled(
					Array.from({ length: 8 }, (_, i) =>
						startDemo(smallAuth, `203.0.113.${i + 1}`, jar().cookies)
					)
				),
				new Promise<never>((_, rej) =>
					setTimeout(() => rej(new Error('demo starts hung: pool deadlock')), 30_000)
				)
			]);
			const ok = results.filter((r) => r.status === 'fulfilled').length;
			const busy = results.filter(
				(r) => r.status === 'rejected' && r.reason instanceof DemoBusyError
			).length;
			console.log(`concurrency: 8 starts, pool 3, ok=${ok} busy=${busy} in ${Date.now() - t0} ms`);
			expect(ok).toBe(5);
			expect(busy).toBe(3);
			expect(await liveDemoCount(small)).toBe(5);
		} finally {
			await dropTestDb(small);
		}
	}, 60_000);

	it('cleanup finishes with a two-connection pool while starts run', async () => {
		const small = await createTestDb({ max: 2 });
		try {
			await seedTemplates(small, templateSeeds);
			const smallAuth = createAuth(small);
			vi.stubEnv('DEMO_STARTS_PER_MINUTE', '100');
			for (let i = 0; i < 2; i++) await startDemo(smallAuth, `203.0.113.${i + 1}`, jar().cookies);
			const later = new Date(Date.now() + 25 * 3600_000);
			const [n] = await Promise.all([
				cleanupExpiredDemos(small, later),
				startDemo(smallAuth, '203.0.113.9', jar().cookies)
			]);
			expect(n).toBe(2);
		} finally {
			await dropTestDb(small);
		}
	}, 60_000);
});

describe('demo start limits', () => {
	it('one IPv6 /64 and its IPv4-mapped form share a bucket', () => {
		expect(demoLimitKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
		expect(demoLimitKey('::ffff:cb00:7105')).toBe('203.0.113.5');
		expect(demoLimitKey('2001:db8:1:2:aaaa::1')).toBe(
			demoLimitKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee')
		);
		expect(demoLimitKey('2001:db8:1:3::1')).not.toBe(demoLimitKey('2001:db8:1:2::1'));
		expect(takeDemoStart('2001:db8:1:2::1', 1)).toBe(0);
		expect(takeDemoStart('2001:db8:1:2:ffff::9', 1)).toBeGreaterThan(0);
		expect(takeDemoStart('203.0.113.5', 1)).toBe(0);
		expect(takeDemoStart('::ffff:203.0.113.5', 1)).toBeGreaterThan(0);
	});

	it('the number of tracked addresses is capped', () => {
		for (let i = 0; i < MAX_TRACKED_ADDRESSES + 50; i++)
			takeDemoStart(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 5);
		expect(trackedAddressCount()).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
	});

	it('a global per-minute limit holds across addresses and lifts after a minute', () => {
		const now = Date.now();
		for (let i = 0; i < 3; i++) expect(takeDemoStart(`198.51.100.${i}`, 5, now, 3)).toBe(0);
		expect(takeDemoStart('198.51.100.99', 5, now, 3)).toBeGreaterThan(0);
		expect(takeDemoStart('198.51.100.99', 5, now + 61_000, 3)).toBe(0);
	});
});
