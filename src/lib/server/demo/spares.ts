import { and, asc, desc, eq, gt, like, inArray, lt, notLike, or, sql } from 'drizzle-orm';
import { demoConfig } from '../config';
import { advisoryLock, type Db, type DbOrTx } from '../db';
import { builds, user } from '../db/schema';
import { ensurePersonalWorkspace, findPersonalWorkspace } from '../teams';
import { deleteDemoUser } from './cleanup';
import { seedDemoBuild } from './seed';

/**
 * Spare demos: demo users made ahead of time, so "Start the demo" only has to claim one instead of
 * seeding a whole sample workspace (hundreds of database round trips) while the visitor waits.
 *
 * A spare is a normal demo user row (`isDemo`) marked by its address, no schema change:
 * - `spare-building-<uuid>@demo.invalid`: reserved, still being seeded; never handed out.
 * - `spare-ready-<uuid>@demo.invalid`: seeded and waiting.
 * Claiming renames the address to `demo-<uuid>@demo.invalid` and sets `created_at` to now, which
 * starts the demo lifetime (cleanup measures it from `created_at`) and makes it count toward the
 * live cap. Nobody can sign in as a spare: demo users have no sign-in account and the only
 * session ever created for one is made by the claim.
 */
export const SPARE_BUILDING_PREFIX = 'spare-building-';
export const SPARE_READY_PREFIX = 'spare-ready-';
const SPARE_SUFFIX = '@demo.invalid';

/** SQL condition: this user row is a spare (building or ready). */
export const isSpare = like(user.email, 'spare-%' + SPARE_SUFFIX);
/** SQL condition: a demo user a visitor holds (not a spare). */
export const isClaimedDemo = and(
	eq(user.isDemo, true),
	notLike(user.email, 'spare-%' + SPARE_SUFFIX)
);

/**
 * A spare older than this is recycled (deleted and made again). The sample build has relative times
 * ("printing for 2 hours", runs 4 to 9 days ago); recreating is far simpler and safer than rewriting
 * timestamps across runs and activity rows, and costs one background seed per spare every few hours.
 */
export const SPARE_MAX_AGE_MS = 4 * 3_600_000;
/**
 * A spare is claimable only while younger than the age limit minus this margin, so the claimable and
 * recyclable ranges never overlap even when a claim's clock was read a little before it got the lock.
 */
export const SPARE_CLAIM_MARGIN_MS = 5 * 60_000;
export const SPARE_EXPIRED_PREFIX = 'spare-expired-';
/** A reservation that never became ready (a crash mid-seed) is dropped after this long. */
export const SPARE_BUILDING_MAX_MS = 5 * 60_000;
/** How often the pool checks itself. */
export const SPARE_CHECK_INTERVAL_MS = 5 * 60_000;

type ClaimedUser = typeof user.$inferSelect;

/**
 * Claim one ready, fresh spare for a visitor inside the caller's transaction (which holds the
 * demo-start lock): `FOR UPDATE SKIP LOCKED` hands each spare to exactly one claimer even across
 * instances. Returns the user row, or undefined when none is ready.
 */
export async function claimSpare(tx: DbOrTx, now = new Date()): Promise<ClaimedUser | undefined> {
	const [pick] = await tx
		.select({ id: user.id })
		.from(user)
		.where(
			and(
				eq(user.isDemo, true),
				like(user.email, SPARE_READY_PREFIX + '%' + SPARE_SUFFIX),
				gt(user.createdAt, new Date(now.getTime() - SPARE_MAX_AGE_MS + SPARE_CLAIM_MARGIN_MS))
			)
		)
		.orderBy(desc(user.createdAt))
		.limit(1)
		.for('update', { skipLocked: true });
	if (!pick) return undefined;
	const [row] = await tx
		.update(user)
		.set({
			email: sql`'demo-' || gen_random_uuid() || ${SPARE_SUFFIX}`,
			createdAt: now,
			updatedAt: now
		})
		.where(eq(user.id, pick.id))
		.returning();
	return row;
}

/** The workspace and sample build of a claimed spare (two small queries). */
export async function spareWorkspaceAndBuild(
	db: Db,
	userId: string
): Promise<{ workspaceId: string; buildId: string }> {
	const ws = await findPersonalWorkspace(db, userId);
	if (!ws) throw new Error('spare demo has no personal workspace');
	const [b] = await db
		.select({ id: builds.id })
		.from(builds)
		.where(eq(builds.organizationId, ws.id))
		.orderBy(asc(builds.createdAt))
		.limit(1);
	if (!b) throw new Error('spare demo has no sample build');
	return { workspaceId: ws.id, buildId: b.id };
}

/** Number of spares (ready and still building). */
export async function spareCount(db: Db): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(user)
		.where(and(eq(user.isDemo, true), isSpare));
	return row?.n ?? 0;
}

export interface SpareFillOptions {
	/** Wanted number of spares; defaults to `DEMO_SPARES`. */
	target?: number;
	now?: Date;
	/** Checked between steps; true ends the fill early. */
	stopped?: () => boolean;
	/** Reservations this fill still holds (not yet ready); the pool deletes them if it is stopped mid-seed. */
	held?: Set<string>;
	/** Seeds one demo user's workspace and sample build (injectable in tests). */
	seed?: (db: Db, userId: string) => Promise<unknown>;
}

/**
 * One maintenance pass: drop stale and orphaned spares, then reserve as many rows as are missing
 * (under an advisory lock, so containers starting together do not both fill) and seed them.
 * Returns the number of spares made ready. The lock covers only the short bookkeeping, never the
 * seeding, so it holds no connection while the slow work runs.
 */
export async function fillSpares(db: Db, opts: SpareFillOptions = {}): Promise<number> {
	const target = opts.target ?? demoConfig().spares;
	const now = opts.now ?? new Date();
	const stopped = opts.stopped ?? (() => false);
	const seed = opts.seed ?? seedDemoBuild;

	// Recycle: ready spares past their age, and reservations that never finished.
	for (const id of await takeStaleSpares(db, now)) {
		if (stopped()) return 0;
		await deleteSpareRow(db, id);
	}

	// Reserve the missing rows; the lock makes count-then-insert atomic across instances.
	const reservation = await db.transaction(async (tx) => {
		await advisoryLock(tx, 'demo-spares');
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(user)
			.where(and(eq(user.isDemo, true), isSpare));
		if (n > target) {
			// More spares than wanted (DEMO_SPARES was lowered): retire the oldest ready ones.
			const extra = await tx
				.select({ id: user.id })
				.from(user)
				.where(and(eq(user.isDemo, true), like(user.email, SPARE_READY_PREFIX + '%')))
				.orderBy(asc(user.createdAt))
				.limit(n - target)
				.for('update', { skipLocked: true });
			for (const r of extra) await markExpired(tx, r.id);
			return { trim: extra.map((r) => r.id), rows: [] as { id: string }[] };
		}
		const missing = Math.max(0, target - n);
		if (!missing) return { trim: [] as string[], rows: [] as { id: string }[] };
		const rows = await tx
			.insert(user)
			.values(
				Array.from({ length: missing }, () => ({
					id: crypto.randomUUID().replaceAll('-', ''),
					name: 'Demo maker',
					email: `${SPARE_BUILDING_PREFIX}${crypto.randomUUID()}${SPARE_SUFFIX}`,
					emailVerified: false,
					isDemo: true,
					createdAt: now,
					updatedAt: now
				}))
			)
			.returning({ id: user.id });
		return { trim: [] as string[], rows };
	});
	for (const id of reservation.trim) await deleteSpareRow(db, id);
	const reserved = reservation.rows;

	const held = opts.held;
	for (const r of reserved) held?.add(r.id);
	let ready = 0;
	for (const [i, r] of reserved.entries()) {
		if (stopped()) {
			// Release the reservations not started, so the next container fills them at once.
			await db
				.delete(user)
				.where(
					inArray(
						user.id,
						reserved.slice(i).map((x) => x.id)
					)
				)
				.catch(() => {});
			break;
		}
		try {
			const u = await db.select({ name: user.name }).from(user).where(eq(user.id, r.id));
			await ensurePersonalWorkspace(db, { id: r.id, name: u[0]?.name ?? 'Demo maker' });
			await seed(db, r.id);
			// Ready only now. A claim that raced the delete of a stale reservation finds no row: fine.
			await db
				.update(user)
				.set({ email: `${SPARE_READY_PREFIX}${crypto.randomUUID()}${SPARE_SUFFIX}` })
				.where(and(eq(user.id, r.id), like(user.email, SPARE_BUILDING_PREFIX + '%')));
			ready++;
		} catch (e) {
			if (!stopped()) console.error('[tmt] demo spare failed', errorLabel(e));
			await deleteDemoUser(db, r.id).catch(() => {});
		} finally {
			held?.delete(r.id);
		}
	}
	return ready;
}

async function markExpired(tx: DbOrTx, id: string): Promise<void> {
	await tx
		.update(user)
		.set({ email: `${SPARE_EXPIRED_PREFIX}${crypto.randomUUID()}${SPARE_SUFFIX}` })
		.where(and(eq(user.id, id), eq(user.isDemo, true)));
}

/** Delete a retired spare row with everything of its; a row already gone is fine. */
async function deleteSpareRow(db: Db, id: string): Promise<void> {
	try {
		await deleteDemoUser(db, id);
	} catch (e) {
		if ((e as { status?: number }).status !== 404) throw e;
	}
}

/**
 * Retire spares past their age, reservations that never finished and anything already retired:
 * each is re-checked under `FOR UPDATE SKIP LOCKED` and renamed to a `spare-expired-` address in the
 * same short transaction, so a spare claimed in the meantime is skipped and a retired one can no
 * longer be claimed. Returns the ids to delete (the caller deletes them; works with any `DEMO_SPARES`).
 */
export async function takeStaleSpares(db: Db, now = new Date()): Promise<string[]> {
	return db.transaction(async (tx) => {
		const rows = await tx
			.select({ id: user.id })
			.from(user)
			.where(
				and(
					eq(user.isDemo, true),
					isSpare,
					or(
						like(user.email, SPARE_EXPIRED_PREFIX + '%'),
						and(
							like(user.email, SPARE_BUILDING_PREFIX + '%'),
							lt(user.createdAt, new Date(now.getTime() - SPARE_BUILDING_MAX_MS))
						),
						lt(user.createdAt, new Date(now.getTime() - SPARE_MAX_AGE_MS))
					)
				)
			)
			.for('update', { skipLocked: true });
		for (const r of rows) await markExpired(tx, r.id);
		return rows.map((r) => r.id);
	});
}

function errorLabel(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}

// ---- The background pool: one per process --------------------------------------------------

const POOL = Symbol.for('tmt.demo-spares');

interface Pool {
	db: Db;
	timer: ReturnType<typeof setInterval>;
	stopped: boolean;
	running: Promise<void> | null;
	again: boolean;
	held: Set<string>;
	seed?: SpareFillOptions['seed'];
}

const pool = (): Pool | undefined => (globalThis as { [k: symbol]: Pool | undefined })[POOL];

function run(p: Pool): void {
	if (p.stopped) return;
	if (p.running) {
		p.again = true;
		return;
	}
	p.running = (async () => {
		do {
			p.again = false;
			try {
				await fillSpares(p.db, { stopped: () => p.stopped, seed: p.seed, held: p.held });
			} catch (e) {
				if (!p.stopped) console.error('[tmt] demo spares error', errorLabel(e));
			}
		} while (p.again && !p.stopped);
	})().finally(() => {
		p.running = null;
	});
}

/**
 * Keep `DEMO_SPARES` spare demos ready, now (in the background, never awaited) and every few
 * minutes. Off when `DEMO_SPARES=0`. Once per process. The timer is unref'ed and `stopSparePool`
 * ends it, so it never holds the process open.
 */
export function startSparePool(
	db: Db,
	opts: { intervalMs?: number; seed?: SpareFillOptions['seed'] } = {}
): void {
	const g = globalThis as { [k: symbol]: Pool | undefined };
	if (g[POOL] || demoConfig().spares === 0) return;
	const p: Pool = {
		db,
		stopped: false,
		running: null,
		again: false,
		held: new Set(),
		seed: opts.seed,
		timer: setInterval(() => run(p), opts.intervalMs ?? SPARE_CHECK_INTERVAL_MS)
	};
	p.timer.unref();
	g[POOL] = p;
	run(p);
}

/** Ask the pool to top itself up (after a claim). A no-op when the pool is not running. */
export function requestSpareTopUp(): void {
	const p = pool();
	if (p) run(p);
}

/**
 * Stop the pool: no new fill starts, the running one ends at its next step, the timer is cleared.
 * Resolves once the running fill has ended (callers on shutdown should not wait for it; closing the
 * database ends any query in flight).
 */
export async function stopSparePool(): Promise<void> {
	const g = globalThis as { [k: symbol]: Pool | undefined };
	const p = g[POOL];
	if (!p) return;
	p.stopped = true;
	clearInterval(p.timer);
	delete g[POOL];
	// The spare being seeded cannot be interrupted: delete it now (best effort, at most two seconds)
	// so the next container does not count a dead reservation; its seed then fails and ends.
	const held = [...p.held];
	if (held.length) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled(held.map((id) => deleteDemoUser(p.db, id))),
			new Promise((r) => (timer = setTimeout(r, 2000)))
		]);
		clearTimeout(timer);
	}
	await p.running;
}
