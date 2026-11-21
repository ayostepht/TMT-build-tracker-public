/**
 * Confirmed plate replacement converts print logs attached to plates into part logs. A piece run
 * ("Print some pieces…") stays a run of the same pieces; a subset run ("Print some parts…") becomes runs of
 * exactly its parts; the row keeps its id, creation time and planned time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { member, organization, printRuns, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, deleteRun } from './actions';
import { createBuild } from './create';
import { setPlateLayout } from './plates';
import { loadBuildView } from './view';

let db: Db;
let templateId: string;
const orgId = 'org1';
const H = 'harness';

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db.insert(member).values({
		id: 'm1',
		organizationId: orgId,
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
});
afterEach(async () => dropTestDb(db));

const mk = async () =>
	await createBuild(db, { organizationId: orgId, templateId, designId: null, name: 'B' }, 'owner');
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const rows = async (id: string) =>
	await db.select().from(printRuns).where(eq(printRuns.buildId, id));
const ticks = async (id: string) =>
	Object.entries((await view(id)).state[H].comps)
		.filter(([, v]) => v)
		.map(([k]) => Number(k))
		.sort((a, b) => a - b);
const convert = async (id: string) =>
	await setPlateLayout(db, id, 'owner', { key: 'h2d', convertRuns: true });

describe('converting plate logs on a confirmed plate replacement', () => {
	it('keeps a piece run a run of the same pieces, with its row and ticks', async () => {
		const id = await mk();
		const plate = (await view(id)).plates.find((p) => p.parts.includes(H))!.number;
		const { runId } = await addRun(db, id, 'owner', {
			plateNumber: plate,
			partSlug: H,
			comps: [0, 1, 2],
			date: '2026-03-01',
			result: 'Success',
			grams: 80,
			hours: 2
		});
		const [before] = await rows(id);
		expect((await view(id)).state[H].status).toBe('To print');
		const ticksBefore = await ticks(id);
		expect(ticksBefore).toEqual([0, 1, 2]);

		expect((await convert(id)).convertedRuns).toBe(1);

		const after = await rows(id);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			id: runId,
			plateNumber: null,
			partSlug: H,
			partSlugs: null,
			comps: [0, 1, 2],
			grams: 80,
			hours: 2,
			estSeconds: before.estSeconds
		});
		expect(after[0].createdAt.getTime()).toBe(before.createdAt.getTime());
		const v = await view(id);
		expect(v.runs[0]).toMatchObject({ partSlug: H, comps: [0, 1, 2] });
		expect(v.state[H].status).toBe('To print');
		expect(await ticks(id)).toEqual(ticksBefore);

		// an unrelated run deleted afterwards recomputes nothing wrong: the part is not Printed
		const other = await addRun(db, id, 'owner', {
			partSlug: 'wing-left',
			date: '2026-03-02',
			result: 'Success'
		});
		await deleteRun(db, id, 'owner', other.runId);
		const v2 = await view(id);
		expect(v2.state[H].status).toBe('To print');
		expect(await ticks(id)).toEqual(ticksBefore);
		// deleting the piece run itself un-ticks, still not Printed
		await deleteRun(db, id, 'owner', runId);
		expect((await view(id)).state[H].status).toBe('To print');
	});

	it('turns a subset run into runs of exactly its parts', async () => {
		const id = await mk();
		const plate = (await view(id)).plates.find((p) => p.parts.length >= 3)!;
		const pick = plate.parts.slice(0, 2);
		await addRun(db, id, 'owner', {
			plateNumber: plate.number,
			partSlugs: pick,
			date: '2026-03-01',
			result: 'Success',
			grams: 10,
			hours: 4
		});
		const [orig] = await rows(id);
		expect((await convert(id)).convertedRuns).toBe(1);
		const after = await rows(id);
		expect(after.map((r) => r.partSlug).sort()).toEqual([...pick].sort());
		for (const r of after) {
			expect(r).toMatchObject({
				plateNumber: null,
				partSlugs: null,
				comps: null,
				grams: 5,
				hours: 2,
				result: 'Success'
			});
			expect(r.createdAt.getTime()).toBe(orig.createdAt.getTime());
		}
		expect(after.some((r) => r.id === orig.id)).toBe(true);
	});

	it('splits a whole-plate run over its parts as before', async () => {
		const id = await mk();
		const plate = (await view(id)).plates.find((p) => p.parts.length === 2)!;
		await addRun(db, id, 'owner', {
			plateNumber: plate.number,
			date: '2026-03-01',
			result: 'Success',
			grams: 100,
			hours: 7
		});
		await convert(id);
		const after = await rows(id);
		expect(after.map((r) => r.partSlug).sort()).toEqual([...plate.parts].sort());
		expect(after.map((r) => [r.grams, r.hours])).toEqual([
			[50, 3.5],
			[50, 3.5]
		]);
	});
});
