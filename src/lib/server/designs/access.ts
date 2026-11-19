import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { colorDesigns, member } from '../db/schema';

export type DesignRow = typeof colorDesigns.$inferSelect;

/**
 * Who may see a design: it is shared to the gallery (any signed-in user), or the viewer wrote it,
 * or the viewer is in a workspace (team) together with its author. Personal workspaces have a
 * single member, so they never widen access. Seeded example designs have no author and are open
 * to every signed-in user. The old `isPublic` column is no longer read: sharing has one meaning,
 * the gallery.
 */
export async function canSeeDesign(db: DbOrTx, d: DesignRow, userId: string): Promise<boolean> {
	if (!d.authorUserId || d.sharedAt !== null || d.authorUserId === userId) return true;
	return (await coworkerIds(db, userId)).has(d.authorUserId);
}

/**
 * `canSeeDesign` with the viewer's co-members already loaded (for filtering the Designs list).
 * Gallery-shared designs are deliberately not listed here: the gallery lists them.
 */
export function canSeeDesignWith(d: DesignRow, userId: string, coworkers: Set<string>): boolean {
	if (!d.authorUserId || d.authorUserId === userId) return true;
	return coworkers.has(d.authorUserId);
}

/** Users who share at least one workspace with `userId` (not including themselves). */
export async function coworkerIds(db: DbOrTx, userId: string): Promise<Set<string>> {
	const mine = (
		await db.select({ org: member.organizationId }).from(member).where(eq(member.userId, userId))
	).map((r) => r.org);
	const out = new Set<string>();
	if (!mine.length) return out;
	const mineSet = new Set(mine);
	for (const r of await db
		.select({ org: member.organizationId, u: member.userId })
		.from(member)
		.where(inArray(member.organizationId, [...mineSet]))) {
		if (mineSet.has(r.org) && r.u !== userId) out.add(r.u);
	}
	return out;
}
