import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	buildPartProfiles,
	buildPlates,
	buildUploads,
	builds,
	member,
	organization,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { createBuild } from './create';
import { remapRoleKey } from './role-keys';
import { loadBuildView } from './view';
import { updateBuildDesign } from '../designs/mutate';

let db: Db;
let id: string;
let other: string;

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	const templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' });
	await db.insert(member).values({
		id: 'm1',
		organizationId: 'org1',
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
	id = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'A' },
		'owner'
	);
	other = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'B' },
		'owner'
	);
});

const plateGrams = async (b: string, n: number) =>
	(await first(
		db
			.select()
			.from(buildPlates)
			.where(and(eq(buildPlates.buildId, b), eq(buildPlates.number, n)))
	))!.filamentGrams;

describe('remapRoleKey', () => {
	it('moves and sums grams in plates, part profiles and upload filament maps, only for its build', async () => {
		for (const b of [id, other]) {
			await db
				.insert(buildPlates)
				.values({ buildId: b, number: 90, name: 'P', filamentGrams: { x: 10, primary: 5 } });
			await db
				.insert(buildPlates)
				.values({ buildId: b, number: 91, name: 'Q', filamentGrams: { accent: 2 } });
			await db
				.insert(buildPartProfiles)
				.values({ buildId: b, partSlug: 'p1', source: 'manual', gramsByRole: { x: 4 } });
			await db.insert(buildUploads).values({
				id: `u-${b}`,
				buildId: b,
				fileName: 'a.3mf',
				summary: { filamentMap: { '0': 'x', '1': 'accent', '2': null }, keep: 1 }
			});
		}
		await db.transaction((tx) => remapRoleKey(tx, id, 'x', 'primary'));

		expect(plateGrams(id, 90)).toEqual({ primary: 15 });
		expect(plateGrams(id, 91)).toEqual({ accent: 2 });
		expect(
			(await first(db.select().from(buildPartProfiles).where(eq(buildPartProfiles.buildId, id))))!
				.gramsByRole
		).toEqual({ primary: 4 });
		expect(
			(await first(
				db
					.select()
					.from(buildUploads)
					.where(eq(buildUploads.id, `u-${id}`))
			))!.summary
		).toEqual({
			filamentMap: { '0': 'primary', '1': 'accent', '2': null },
			keep: 1
		});
		// the other build is untouched
		expect(plateGrams(other, 90)).toEqual({ x: 10, primary: 5 });
		expect(
			(await first(
				db
					.select()
					.from(buildUploads)
					.where(eq(buildUploads.id, `u-${other}`))
			))!.summary
		).toMatchObject({ filamentMap: { '0': 'x' } });
	});

	it('is a no-op for from === to and for builds with nothing keyed from', async () => {
		await db
			.insert(buildPlates)
			.values({ buildId: id, number: 90, name: 'P', filamentGrams: { primary: 5 } });
		db.transaction(async (tx) => {
			await remapRoleKey(tx, id, 'primary', 'primary');
			await remapRoleKey(tx, id, 'gone', 'primary');
		});
		expect(plateGrams(id, 90)).toEqual({ primary: 5 });
	});
});

describe('view contract: kit, defaultRole, locked', () => {
	it('flags kit slots, exposes defaultRole and reads lockedParts leniently', async () => {
		const v0 = (await loadBuildView(db, id, 'owner'))!;
		expect(v0.filaments.every((f) => f.kit)).toBe(true);
		expect(v0.allParts.every((p) => !p.locked && p.defaultRole)).toBe(true);
		const slug = v0.parts[0].slug;

		await updateBuildDesign(db, id, 'owner', {
			addRole: { name: 'Extra', material: 'PETG', hex: '#123456' }
		});
		expect((await loadBuildView(db, id, 'owner'))!.filaments.filter((f) => !f.kit)).toHaveLength(1);

		const setLocked = async (lockedParts: unknown) => {
			const row = (await first(db.select().from(builds).where(eq(builds.id, id))))!;
			await db
				.update(builds)
				.set({ design: { ...(row.design as object), lockedParts } as never })
				.where(eq(builds.id, id));
			return (await loadBuildView(db, id, 'owner'))!;
		};
		const v1 = await setLocked([slug, 'no-such-part', 5]);
		expect(v1.allParts.filter((p) => p.locked).map((p) => p.slug)).toEqual([slug]);
		expect((await setLocked('oops')).allParts.some((p) => p.locked)).toBe(false);
		expect((await setLocked(null)).allParts.some((p) => p.locked)).toBe(false);
	});
});
