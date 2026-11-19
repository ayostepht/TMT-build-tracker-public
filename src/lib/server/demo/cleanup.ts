import { and, eq, lt, sql } from 'drizzle-orm';
import { deleteAccount } from '../account';
import { demoConfig } from '../config';
import type { Db } from '../db';
import { user } from '../db/schema';

/** Delete one demo sandbox user with everything of theirs (builds, files, sessions). Refuses real users. */
export async function deleteDemoUser(db: Db, userId: string): Promise<void> {
	await deleteAccount(db, userId, { demo: true });
}

/** Most users removed per run, so one pass stays short; the next interval takes the rest. */
const BATCH = 200;

/** Arbitrary constant: instances take turns, the one that gets the lock cleans. */
const CLEANUP_LOCK = 7_346_201_077;

/**
 * Delete demo users older than the demo lifetime (`DEMO_TTL_HOURS`, default 24). Idempotent and
 * safe with several app instances: a session-level try-lock on one connection lets only one run at a
 * time, the others return 0. Each user is deleted on its own, so one failure does not stop the rest.
 */
export async function cleanupExpiredDemos(
	db: Db,
	now = new Date(),
	ttlMs = demoConfig().ttlMs
): Promise<number> {
	const cutoff = new Date(now.getTime() - ttlMs);
	return db.$client.begin(async (tx) => {
		const [{ got }] = await tx<
			{ got: boolean }[]
		>`select pg_try_advisory_xact_lock(${CLEANUP_LOCK}) as got`;
		if (!got) return 0;
		const rows = await db
			.select({ id: user.id })
			.from(user)
			.where(and(eq(user.isDemo, true), lt(user.createdAt, cutoff)))
			.orderBy(user.createdAt)
			.limit(BATCH);
		let n = 0;
		for (const r of rows) {
			try {
				await deleteDemoUser(db, r.id);
				n++;
			} catch (e) {
				// Already gone (a concurrent sign-out) is fine; anything else is logged without detail.
				if ((e as { status?: number }).status !== 404)
					console.error('[tmt] demo cleanup failed', e);
			}
		}
		return n;
	}) as Promise<number>;
}

/** Live demo users. */
export async function liveDemoCount(db: Db): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(user)
		.where(eq(user.isDemo, true));
	return row?.n ?? 0;
}

const TIMER = Symbol.for('tmt.demo-cleanup');
export const CLEANUP_INTERVAL_MS = 15 * 60_000;

/** Run the cleanup now (in the background) and every 15 minutes. Registered once per process. */
export function startDemoCleanup(db: Db, intervalMs = CLEANUP_INTERVAL_MS): void {
	const g = globalThis as { [k: symbol]: unknown };
	if (g[TIMER]) return;
	const run = () =>
		cleanupExpiredDemos(db)
			.then((n) => n && console.log(`[tmt] removed ${n} expired demo(s)`))
			.catch((e) => console.error('[tmt] demo cleanup error', e));
	void run();
	const t = setInterval(() => void run(), intervalMs);
	t.unref();
	g[TIMER] = t;
}
