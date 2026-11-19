import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { first, type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import { templateModels, templatePartPlacements, templates } from './db/schema';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { hasNonStepSource, kitStatus } from './kit-status';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const HANDLE = 'push-handle-one-piece';

describe('hasNonStepSource', () => {
	it('is true only for a named non-STEP source', () => {
		expect(hasNonStepSource('TMT_SinglePIecehandle.stl')).toBe(true);
		expect(hasNonStepSource('3DTMT XX PUSH HANDLE PIN REV B.STEP')).toBe(false);
		expect(hasNonStepSource('part.stp')).toBe(false);
		expect(hasNonStepSource('')).toBe(false);
	});
});

describe('kitStatus missing parts', () => {
	const dbs: Db[] = [];
	afterAll(async () => {
		for (const d of dbs) await dropTestDb(d);
	});
	async function setup(slugs: string[], placed: string[]) {
		const db = await createTestDb();
		dbs.push(db);
		await seedTemplates(db, templateSeeds);
		const tid = (await first(
			db.select().from(templates).where(eq(templates.slug, templateSeeds[0].slug))
		))!.id;
		await db.insert(templateModels).values({
			templateId: tid,
			glbPath: 'x.glb',
			version: 'v1',
			slugs,
			sourceNote: 'STEP import'
		});
		await db
			.update(templatePartPlacements)
			.set({ placed: false })
			.where(eq(templatePartPlacements.templateId, tid));
		for (const slug of placed) {
			await db
				.insert(templatePartPlacements)
				.values({ templateId: tid, slug, matrix: I, instances: [], placed: true })
				.onConflictDoUpdate({
					target: [templatePartPlacements.templateId, templatePartPlacements.slug],
					set: { placed: true }
				});
		}
		return { db, tid };
	}

	it('does not ask for a STEP for the one-piece handle (STL source)', async () => {
		const { db, tid } = await setup(['push-grip'], [HANDLE]);
		const s = await kitStatus(db, tid);
		expect(s.model?.missing).not.toContain('Push Handle (one piece)');
	});

	it('still reports a placed STEP part with no node', async () => {
		const { db, tid } = await setup(['push-grip'], ['tires']);
		const s = await kitStatus(db, tid);
		expect(s.model?.missing).toContain('Tires');
	});
});
