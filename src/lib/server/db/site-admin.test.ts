import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations, type Db } from './index';
import { createTestDb, dropTestDb } from './testing';
import { siteAdmin, user } from './schema';

let db: Db;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(() => dropTestDb(db));

async function addUser(id: string) {
	await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: false });
}

describe('site_admin table', () => {
	it('exists after migrate, defaults granted_at, cascades on user delete, nulls granted_by', async () => {
		await runMigrations(db); // idempotent on an already migrated database
		await addUser('a');
		await addUser('b');
		await db.insert(siteAdmin).values({ userId: 'a' });
		await db.insert(siteAdmin).values({ userId: 'b', grantedBy: 'a' });
		const rows = await db.select().from(siteAdmin);
		expect(rows).toHaveLength(2);
		expect(rows[0].grantedAt).toBeInstanceOf(Date);

		await db.delete(user).where(eq(user.id, 'a'));
		const left = await db.select().from(siteAdmin);
		expect(left).toHaveLength(1);
		expect(left[0].userId).toBe('b');
		expect(left[0].grantedBy).toBeNull();

		await db.delete(user).where(eq(user.id, 'b'));
		expect(await db.select().from(siteAdmin)).toHaveLength(0);
	});
});
