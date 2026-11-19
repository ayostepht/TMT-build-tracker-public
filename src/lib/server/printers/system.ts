import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { member } from '../db/schema';

/** Any member of the team (owners first): used to load build views for server-initiated changes. */
export async function getMemberActor(db: DbOrTx, orgId: string): Promise<string | null> {
	const rows = await db
		.select({ userId: member.userId, role: member.role })
		.from(member)
		.where(eq(member.organizationId, orgId))
		.orderBy(asc(member.createdAt));
	return (rows.find((r) => r.role.includes('owner')) ?? rows[0])?.userId ?? null;
}
