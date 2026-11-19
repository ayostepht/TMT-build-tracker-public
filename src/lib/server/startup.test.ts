import { describe, expect, it } from 'vitest';
import { count } from 'drizzle-orm';
import { first } from './db';
import { createEmptyTestDb, dropTestDb } from './db/testing';
import { templateParts, templates } from './db/schema';
import { templateSeeds } from './seed';
import { initDatabase } from './startup';

describe('cold start on an empty database', () => {
	it('migrates and seeds, and a second start changes nothing', async () => {
		const db = await createEmptyTestDb();
		try {
			const a = await initDatabase(db);
			expect(a.inserted).toEqual(templateSeeds.map((s) => s.slug));
			const snap = async () => ({
				t: (await first(db.select({ n: count() }).from(templates)))!.n,
				p: (await first(db.select({ n: count() }).from(templateParts)))!.n
			});
			const before = await snap();
			expect(before.t).toBe(templateSeeds.length);
			const b = await initDatabase(db);
			expect(b).toEqual({ inserted: [], updated: [] });
			expect(await snap()).toEqual(before);
		} finally {
			await dropTestDb(db);
		}
	});

	it('two starts at once seed once', async () => {
		const db = await createEmptyTestDb({ max: 6 });
		try {
			const [a, b] = await Promise.all([initDatabase(db), initDatabase(db)]);
			expect(a.inserted.length + b.inserted.length).toBe(templateSeeds.length);
		} finally {
			await dropTestDb(db);
		}
	});
});
