import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { inactiveSlugs } from '#lib/domain/variants.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { buildParts, builds, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { createBuild } from './create';
import { buildRows, recentBuilds } from './list';

let db: Db;
let templateId: string;

afterEach(() => dropTestDb(db));

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	for (const id of ['org1', 'org2']) {
		await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
		await db.insert(member).values({
			id: 'm-' + id,
			organizationId: id,
			userId: 'owner',
			role: 'owner',
			createdAt: new Date()
		});
	}
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
});

/** The original per-build algorithm: one parts query for each build. */
async function perBuild(orgIds: string[], kind: 'build' | 'draft' = 'build') {
	const groups = new Map(
		(await db.select({ id: templates.id, g: templates.variantGroups }).from(templates)).map((t) => [
			t.id,
			t.g
		])
	);
	const list = await db
		.select()
		.from(builds)
		.where(and(inArray(builds.organizationId, orgIds), eq(builds.kind, kind)))
		.orderBy(desc(builds.createdAt), desc(builds.id));
	const out = [];
	for (const b of list) {
		const off = inactiveSlugs(groups.get(b.templateId) ?? [], b.variantChoices);
		const rows = (
			await db
				.select({ slug: buildParts.partSlug, status: buildParts.status })
				.from(buildParts)
				.where(eq(buildParts.buildId, b.id))
		).filter((r) => !off.has(r.slug));
		const printed = rows.filter((r) => r.status === 'Printed').length;
		out.push({
			id: b.id,
			organizationId: b.organizationId,
			name: b.name,
			phase: b.phase,
			deliveryDate: b.deliveryDate,
			setupStep: b.setupStep,
			created: b.createdAt.getTime(),
			total: rows.length,
			printed,
			progress: rows.length ? Math.round((printed / rows.length) * 100) : 0
		});
	}
	return out;
}

describe('buildRows (one parts query for all builds)', () => {
	it('matches the per-build computation across builds, variants, drafts and teams', async () => {
		const tpl = (await first(db.select().from(templates).where(eq(templates.id, templateId))))!;
		const group = tpl.variantGroups![0];
		const mk = (organizationId: string, name: string, extra: object = {}) =>
			createBuild(db, { organizationId, templateId, designId: null, name, ...extra }, 'owner');
		const a = await mk('org1', 'Default');
		const b = await mk('org1', 'Other option', {
			variantChoices: { [group.key]: group.options.find((o) => o.key !== group.defaultOption)!.key }
		});
		const c = await mk('org2', 'Second team');
		const gone = await mk('org1', 'Lost rows');
		await mk('org1', 'Draft', { kind: 'draft' });
		await mk('org2', 'Empty');
		// Progress in several builds; one build has lost its part rows altogether.
		for (const [id, n] of [
			[a, 5],
			[b, 12],
			[c, 41]
		] as const) {
			const rows = await db
				.select({ slug: buildParts.partSlug })
				.from(buildParts)
				.where(eq(buildParts.buildId, id));
			for (const r of rows.slice(0, n))
				await db
					.update(buildParts)
					.set({ status: 'Printed' })
					.where(and(eq(buildParts.buildId, id), eq(buildParts.partSlug, r.slug)));
		}
		await db.delete(buildParts).where(eq(buildParts.buildId, gone));

		for (const orgs of [['org1'], ['org2'], ['org1', 'org2']]) {
			const got = await buildRows(db, orgs);
			expect(got).toEqual(await perBuild(orgs));
		}
		expect((await buildRows(db, ['org1', 'org2'], 'draft')).length).toBe(1);
		expect(await buildRows(db, ['org1', 'org2'], 'draft')).toEqual(
			await perBuild(['org1', 'org2'], 'draft')
		);
		const all = await buildRows(db, ['org1', 'org2']);
		expect(all.find((r) => r.id === gone)).toMatchObject({ total: 0, progress: 0 });
		expect(all.find((r) => r.id === c)).toMatchObject({ progress: 100 });
		expect(await buildRows(db, [])).toEqual([]);
		// A caller holding the rows gets the same recent list without loading them again.
		expect(await recentBuilds(db, ['org1', 'org2'], 6, all)).toEqual(
			await recentBuilds(db, ['org1', 'org2'], 6)
		);
	});
});
