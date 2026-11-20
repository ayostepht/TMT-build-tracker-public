import { and, lt, sql } from 'drizzle-orm';
import { deleteAccount } from '../account';
import { demoConfig } from '../config';
import type { Db } from '../db';
import { user } from '../db/schema';
import { isClaimedDemo } from './spares';

/** Delete one demo sandbox user with everything of theirs (builds, files, sessions). Refuses real users. */
export async function deleteDemoUser(db: Db, userId: string): Promise<void> {
	await deleteAccount(db, userId, { demo: true });
}

/** Most users removed per run, so one pass stays short; the next interval takes the rest. */
const BATCH = 200;

/** Arbitrary constant: instances take turns, the one that gets the lock cleans. */
const CLEANUP_LOCK = 7_346_201_077;

let cleaning = false;

/**
 * Delete claimed demo users older than the demo lifetime (unclaimed spares are left to the spare pool) (`DEMO_TTL_HOURS`, default 24). Idempotent and
 * safe with several app instances: one run at a time per process, and a
 * try-lock on the listing across instances. Each user is deleted on its own, so one failure does not stop the rest.
 */
export async function cleanupExpiredDemos(
	db: Db,
	now = new Date(),
	ttlMs = demoConfig().ttlMs
): Promise<number> {
	// One run at a time in this process: a second call returns 0 while one is going.
	if (cleaning) return 0;
	cleaning = true;
	try {
		const cutoff = new Date(now.getTime() - ttlMs);
		// Other instances: a transaction-level try-lock around the short listing only, so no pool
		// connection is held while the deletes (which use the pool) run. If two instances still list the
		// same user, the second delete finds it gone (404) and is not counted.
		const rows = await db.transaction(async (tx) => {
			const res = (await tx.execute(
				sql`select pg_try_advisory_xact_lock(${CLEANUP_LOCK}) as got`
			)) as unknown as { got: boolean }[];
			if (!res[0]?.got) return [];
			return tx
				.select({ id: user.id })
				.from(user)
				.where(and(isClaimedDemo, lt(user.createdAt, cutoff)))
				.orderBy(user.createdAt)
				.limit(BATCH);
		});
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
	} finally {
		cleaning = false;
	}
}

/** Live demo users a visitor holds (unclaimed spares are not counted). */
export async function liveDemoCount(db: Db): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(user)
		.where(isClaimedDemo);
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
