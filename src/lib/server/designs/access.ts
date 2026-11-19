import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { colorDesigns, member } from '../db/schema';

export type DesignRow = typeof colorDesigns.$inferSelect;

/**
 * A seeded example: the seed marks it with `isPublic` and it has no author. No request path sets
 * `isPublic`, so an authorless design without the marker (its author's account went away) is
 * visible to nobody but through the gallery.
 */
export function isSeededExample(d: Pick<DesignRow, 'isPublic' | 'authorUserId'>): boolean {
	return d.isPublic && !d.authorUserId;
}

/**
 * Who may see a design: it is shared to the gallery (any signed-in user), or the viewer wrote it,
 * or the viewer is in a workspace (team) together with its author. Personal workspaces have a
 * single member, so they never widen access. Seeded example designs (`isSeededExample`) are open
 * to every signed-in user.
 */
export async function canSeeDesign(db: DbOrTx, d: DesignRow, userId: string): Promise<boolean> {
	if (isSeededExample(d) || d.sharedAt !== null || d.authorUserId === userId) return true;
	if (!d.authorUserId) return false;
	return (await coworkerIds(db, userId)).has(d.authorUserId);
}

/**
 * `canSeeDesign` with the viewer's co-members already loaded (for filtering the Designs list).
 * Gallery-shared designs are deliberately not listed here: the gallery lists them.
 */
export function canSeeDesignWith(d: DesignRow, userId: string, coworkers: Set<string>): boolean {
	if (isSeededExample(d) || d.authorUserId === userId) return true;
	return !!d.authorUserId && coworkers.has(d.authorUserId);
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
