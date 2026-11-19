import { eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { colorDesigns, member } from '../db/schema';

export type DesignRow = typeof colorDesigns.$inferSelect;

/**
 * Who may see a design: it is public, or the viewer wrote it, or the viewer is
 * in a workspace (chapter) together with its author. Personal workspaces have a
 * single member, so they never widen access. Seeded designs have no author and
 * are public.
 */
export async function canSeeDesign(db: DbOrTx, d: DesignRow, userId: string): Promise<boolean> {
	if (d.isPublic || d.authorUserId === userId) return true;
	if (!d.authorUserId) return false;
	return (await coworkerIds(db, userId)).has(d.authorUserId);
}

/** `canSeeDesign` with the viewer's co-members already loaded (for filtering lists). */
export function canSeeDesignWith(d: DesignRow, userId: string, coworkers: Set<string>): boolean {
	if (d.isPublic || d.authorUserId === userId) return true;
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
