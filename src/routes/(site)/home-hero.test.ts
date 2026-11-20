import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { first, type Db } from '#lib/server/db/index.ts';
import { createTestDb, dropTestDb } from '#lib/server/db/testing.ts';
import { templateModels, templates } from '#lib/server/db/schema.ts';
import { templateSeeds } from '#lib/server/seed/index.ts';
import { seedTemplates } from '#lib/server/seed/run.ts';

let db: Db;
vi.mock('#lib/server/db/index.ts', async (orig) => ({
	...(await orig<typeof import('#lib/server/db/index.ts')>()),
	getDb: () => db
}));

// The home page's hero must hide the parts of the variants the template does not choose by
// default, like the design pages do; both rim sizes and the cushion/bucket seat drawn together
// z-fight in the wheel face.
describe('home hero parts', () => {
	beforeEach(async () => {
		db = await createTestDb();
		await seedTemplates(db, templateSeeds);
		const t = (await first(db.select({ id: templates.id }).from(templates)))!;
		await db.insert(templateModels).values({
			templateId: t.id,
			glbPath: 'models/x.glb',
			version: 'v1',
			slugs: ['rims-1-4', 'rims-small-1-4']
		});
	});
	afterEach(() => dropTestDb(db));

	it('hides non-default variant parts, keeps default ones, and has no hardware model', async () => {
		const { load } = await import('./+page.server.ts');
		const out = (await load({
			locals: {},
			url: new URL('http://localhost/'),
			setHeaders: () => {}
		} as never)) as { hero: { hidden: string[]; model: { hardwareUrl: string | null } } | null };
		expect(out.hero).not.toBeNull();
		expect(out.hero!.hidden).toEqual(
			expect.arrayContaining(['rims-small-1-4', 'rims-small-2-3', 'bucket-seat'])
		);
		expect(out.hero!.hidden).not.toContain('rims-1-4');
		expect(out.hero!.hidden).not.toContain('cushion-top');
		expect(out.hero!.model.hardwareUrl).toBeNull();
	});
});
