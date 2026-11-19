import { count } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { first, runMigrations, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { templateParts, templatePlates, templates, colorDesigns } from '../db/schema';
import { templateSeeds } from './index';
import { seedTemplates } from './run';

let db: Db;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(() => dropTestDb(db));

describe('seedTemplates', () => {
	it('is idempotent', async () => {
		await runMigrations(db);

		const firstRun = await seedTemplates(db, templateSeeds);
		expect(firstRun.inserted).toEqual(templateSeeds.map((s) => s.slug));
		const n = async (
			t: typeof templates | typeof templateParts | typeof templatePlates | typeof colorDesigns
		) => (await first(db.select({ n: count() }).from(t)))!.n;
		const snapshot = async () => ({
			t: await n(templates),
			p: await n(templateParts),
			pl: await n(templatePlates),
			d: await n(colorDesigns)
		});
		const a = await snapshot();
		expect(a.t).toBe(templateSeeds.length);
		expect(a.p).toBe(templateSeeds.reduce((sum, s) => sum + s.parts.length, 0));

		const second = await seedTemplates(db, templateSeeds);
		expect(second.inserted).toEqual([]);
		expect(second.updated).toEqual([]);
		expect(await snapshot()).toEqual(a);
	});

	it('two concurrent runs on an empty database do not collide', async () => {
		const other = await createTestDb();
		try {
			const [x, y] = await Promise.all([
				seedTemplates(other, templateSeeds),
				seedTemplates(other, templateSeeds)
			]);
			expect(x.inserted.length + y.inserted.length).toBe(templateSeeds.length);
			expect((await first(other.select({ n: count() }).from(templates)))!.n).toBe(
				templateSeeds.length
			);
		} finally {
			await dropTestDb(other);
		}
	});
});
