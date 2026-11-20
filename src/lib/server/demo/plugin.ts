import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { demoConfig } from '../config';
import { sql } from 'drizzle-orm';
import { advisoryLock, type Db } from '../db';
import { user as userTable } from '../db/schema';
import { ensurePersonalWorkspace } from '../teams';
import { deleteDemoUser } from './cleanup';
import { seedDemoBuild } from './seed';
import { claimSpare, isClaimedDemo, requestSpareTopUp, spareWorkspaceAndBuild } from './spares';

/** Too many live demos: the page shows "the demo is busy". */
export class DemoBusyError extends Error {
	constructor() {
		super('The demo is busy right now.');
	}
}

/**
 * Why a Better Auth plugin and not a plain user insert: the session and its cookie must be made
 * by Better Auth itself (signed cookie, same session table, same hooks). The endpoint is
 * server-only (`createAuthEndpoint.serverOnly`): it has no path, is never routed over HTTP and
 * can only be reached through `auth.api.startDemo(...)` from our own `/demo` form action. The
 * anonymous plugin was not used because its sign-in endpoint is public, so the per-IP and live caps
 * could not be enforced in front of it, and it has its own account-linking behaviour we do not want.
 *
 * With `DEMO_SPARES` above 0 it first claims a ready-made spare demo (see `spares.ts`: a few queries
 * instead of the whole seed) and falls back to building one on the spot when none is ready.
 *
 * Returns `{ buildId }`. The user has `isDemo` set (only server code can), an unverifiable
 * `@demo.invalid` address, no sign-in account, a personal workspace and one seeded sample build, and a session
 * that ends after `DEMO_TTL_HOURS`.
 */
export function demoPlugin(db: Db) {
	return {
		id: 'tmt-demo',
		endpoints: {
			startDemo: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
				const cfg = demoConfig();
				const adapter = ctx.context.internalAdapter;
				// Reserve a slot: count and insert under one lock so parallel starts (and other
				// instances) cannot pass the cap together. The locked body uses the transaction's own
				// connection only: a second pool connection inside it would let concurrent starts hold
				// every connection while waiting for one more. The user row is inserted here directly
				// (the server-made demo user skips the account hooks anyway); the workspace, sample build
				// and session are made after the lock is released.
				const now = new Date();
				const { created, spare } = await db.transaction(async (tx) => {
					await advisoryLock(tx, 'demo-start');
					// Unclaimed spares do not count toward the cap.
					const [{ n }] = await tx
						.select({ n: sql<number>`count(*)::int` })
						.from(userTable)
						.where(isClaimedDemo);
					if (n >= cfg.maxLive) throw new DemoBusyError();
					if (cfg.spares > 0) {
						const claimed = await claimSpare(tx, now);
						if (claimed) return { created: claimed, spare: true };
					}
					const [row] = await tx
						.insert(userTable)
						.values({
							id: crypto.randomUUID().replaceAll('-', ''),
							name: 'Demo maker',
							email: `demo-${crypto.randomUUID()}@demo.invalid`,
							emailVerified: false,
							isDemo: true,
							createdAt: now,
							updatedAt: now
						})
						.returning();
					return { created: row, spare: false };
				});
				try {
					let workspace: { id: string };
					let buildId: string;
					if (spare) {
						const found = await spareWorkspaceAndBuild(db, created.id);
						workspace = { id: found.workspaceId };
						buildId = found.buildId;
					} else {
						workspace = await ensurePersonalWorkspace(db, {
							id: created.id,
							name: created.name
						});
						buildId = await seedDemoBuild(db, created.id);
					}
					// The active workspace is passed in: the session hook would otherwise look the (just
					// made) personal workspace up again, which is several more round trips to the database.
					const session = await adapter.createSession(created.id, true, {
						expiresAt: new Date(Date.now() + cfg.ttlMs),
						activeOrganizationId: workspace.id
					});
					// dontRememberMe: a browser-session cookie, and the session is never extended.
					await setSessionCookie(ctx, { session, user: created }, true);
					// A spare was used up: make the next one in the background, off this request.
					if (spare) requestSpareTopUp();
					return ctx.json({ buildId });
				} catch (e) {
					await deleteDemoUser(db, created.id).catch(() => {});
					throw e;
				}
			})
		}
	};
}
