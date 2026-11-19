import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { describeActivity } from '#lib/domain/activity.ts';
import { filamentStats } from '#lib/domain/accounting.ts';
import type { BuildPrinter } from '#lib/domain/types.ts';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { activity, buildPartProfiles, member, organization, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { updateBuildDesign } from '../designs/mutate';
import { parseThreeMfBytes } from '../threemf';
import { makeProjectThreeMf } from '../threemf/fixtures';
import { addRun } from './actions';
import { createBuild } from './create';
import {
	applyUpload,
	arrangeForPrinter,
	buildArrangement,
	createUpload,
	forgetPrintTemplate
} from './plates';
import { loadBuildView } from './view';

let db: Db;
let templateId: string;
const orgId = 'org1';

afterEach(async () => dropTestDb(db));

const cc = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);
const bed = (mmSlots = 1): BuildPrinter => ({
	...cc,
	catalogId: null,
	name: 'Custom',
	bedX: 256,
	bedY: 256,
	mmSlots
});

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	await db
		.insert(organization)
		.values({ id: orgId, name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db
		.insert(user)
		.values({ id: 'owner', name: 'Owen', email: 'owner@example.test', createdAt: new Date() });
	await db.insert(member).values({
		id: 'm1',
		organizationId: orgId,
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
});

const mk = async (printer?: BuildPrinter, plateLayout?: string) =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', printer, plateLayout },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;

/** Plate 1: two handles; plate 2: the left wing printed alone. Filament 1 is the wing's role. */
async function upload(id: string) {
	const bytes = makeProjectThreeMf({
		sliced: true,
		filamentTypes: ['PETG'],
		plates: [
			{
				name: 'HANDLES',
				prediction: 40000,
				weight: 400,
				filaments: { 1: 400 },
				objects: [
					{ name: '3DTMT A1 HANDLE LEFT REV A.STEP' },
					{ name: '3DTMT A2 HANDLE RIGHT REV A.STEP' }
				]
			},
			{
				name: 'WING',
				prediction: 50000,
				weight: 360,
				filaments: { 1: 360 },
				objects: [{ name: '3DTMT C1 WING LEFT REV B.step' }]
			}
		]
	});
	const parsed = await parseThreeMfBytes(bytes);
	return await createUpload(
		db,
		id,
		'owner',
		{ name: 'mine.3mf', size: bytes.length },
		parsed,
		await view(id)
	);
}

async function learn(id: string, mode: 'plates' | 'template', extra: Record<string, unknown> = {}) {
	const up = await upload(id);
	const role = (await view(id)).parts.find((p) => p.slug === 'wing-left')!.role;
	const res = await applyUpload(db, id, 'owner', up.uploadId, {
		mapping: up.suggestions.mapping,
		filamentMap: { '1': role },
		mode,
		...extra
	});
	return { up, res, role };
}

describe('print template: learning', () => {
	it('"Use as print template" keeps the plates and stores per-part data', async () => {
		const id = await mk(undefined, 'xpa');
		const shape = async () =>
			JSON.stringify((await view(id)).plates.map((p) => [p.number, p.name, p.parts, p.source]));
		const before = await shape();
		const { res } = await learn(id, 'template');
		expect(res).toMatchObject({ mode: 'template', plates: 0, learned: 3, arranged: false });
		expect(await shape()).toBe(before);
		const v = await view(id);
		expect(Object.keys(v.partProfiles!).sort()).toEqual([
			'handle-left',
			'handle-right',
			'wing-left'
		]);
		// plate 2 holds only the wing: all 50000 s; plate 1 splits 40000 s between two equal-share handles
		expect(v.partProfiles!['wing-left'].secondsPerCopy).toBe(50000);
		expect(v.partProfiles!['handle-left'].secondsPerCopy).toBe(20000);
		expect(v.printTemplate).toMatchObject({
			fileName: 'mine.3mf',
			plates: 2,
			method: 'volume-split',
			parts: 3
		});
		const a = (await db.select().from(activity).where(eq(activity.buildId, id))).at(-1)!;
		expect(
			describeActivity(
				{ id: 'x', userId: 'owner', userName: 'Owen', kind: a.kind, payload: a.payload, at: '' },
				v
			)
		).toBe('Owen used mine.3mf as the print template (3 parts learned, shared by volume)');
	});

	it('"Use these plates" stores the profiles too', async () => {
		const id = await mk(undefined, 'xpa');
		const { res } = await learn(id, 'plates');
		expect(res).toMatchObject({ mode: 'plates', plates: 2, learned: 3 });
		const v = await view(id);
		expect(v.plates.map((p) => p.source)).toEqual([
			expect.stringMatching(/^upload:/),
			expect.stringMatching(/^upload:/)
		]);
		expect(v.partProfiles!['wing-left'].secondsPerCopy).toBe(50000);
		expect(v.printTemplate?.parts).toBe(3);
	});

	it('refuses to learn from a file that is not sliced', async () => {
		const id = await mk();
		const bytes = makeProjectThreeMf({
			plates: [{ name: 'A', objects: [{ name: '3DTMT A1 HANDLE LEFT REV A.STEP' }] }]
		});
		const up = await createUpload(
			db,
			id,
			'owner',
			{ name: 'x.3mf', size: 1 },
			await parseThreeMfBytes(bytes),
			await view(id)
		);
		await expect(
			applyUpload(db, id, 'owner', up.uploadId, {
				mapping: up.suggestions.mapping,
				filamentMap: {},
				mode: 'template'
			})
		).rejects.toThrow(/nothing to learn/);
		expect(await db.select().from(buildPartProfiles)).toHaveLength(0);
	});

	it('"Remove" forgets the data and leaves the plates', async () => {
		const id = await mk(undefined, 'xpa');
		await learn(id, 'template');
		expect(await forgetPrintTemplate(db, id, 'owner')).toBe(3);
		expect((await view(id)).printTemplate).toBeNull();
		expect((await view(id)).plates).toHaveLength(24);
	});

	it('uses the measured seconds and extrusion when the plate has them', async () => {
		const id = await mk(undefined, 'xpa');
		const up = await upload(id);
		const plate1 = up.summary.plates.find((p) => p.index === 1)!;
		// make the stored summary carry exact data (as the upload route attaches it)
		plate1.exact = [
			{ name: plate1.objects[0].name, seconds: 900, mm: { '1': 1000 } },
			{ name: plate1.objects[1].name, seconds: 300, mm: { '1': 3000 } }
		];
		await db
			.update((await import('../db/schema')).buildUploads)
			.set({ summary: up.summary as never });
		const role = (await view(id)).parts.find((p) => p.slug === 'wing-left')!.role;
		await applyUpload(db, id, 'owner', up.uploadId, {
			mapping: up.suggestions.mapping,
			filamentMap: { '1': role },
			mode: 'template'
		});
		const p = (await view(id)).partProfiles!;
		expect(p['handle-left'].method).toBe('exact');
		expect(p['handle-left'].secondsPerCopy).toBe(30000); // 40000 * 900 / 1200
		expect(p['handle-right'].secondsPerCopy).toBe(10000);
		expect(p['wing-left'].method).toBe('volume-split'); // plate 2 has no measurements
	});
});

describe('print template: using it', () => {
	it('arranged plates take their times and grams from the template, labelled "from your slice"', async () => {
		const id = await mk(bed());
		const estimated = (await view(id)).plates.find((p) => p.parts.includes('wing-left'))!;
		expect(estimated.estSource).toBe('estimate');
		await learn(id, 'template');
		const v = await view(id);
		expect(v.plates[0].source).toBe('arranged');
		const wingPlate = v.plates.find((p) => p.parts.includes('wing-left'))!;
		expect(wingPlate.estSource).toBe('learned');
		const only = wingPlate.parts.length === 1;
		if (only) expect(wingPlate.estSeconds).toBe(50000);
		expect(wingPlate.filamentGrams).toBeTruthy();
		// the same arrangement, no re-arranging happened
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
		// accounting reads the learned grams of those plates
		const total = filamentStats(v).reduce((a, f) => a + f.total, 0);
		expect(total).toBeGreaterThan(0);
	});

	it('a recolor on arranged plates re-arranges with the learned times', async () => {
		const id = await mk(bed());
		const { role } = await learn(id, 'template');
		const other = role === 'primary' ? 'accent' : 'primary';
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': other } });
		const v = await view(id);
		const wing = v.plates.find((p) => p.parts.includes('wing-left'))!;
		expect(wing.estSource).toBe('learned');
		const pr = v.partProfiles!['wing-left'];
		expect(pr.remapped).toBe(true);
		expect(pr.secondsPerCopy).toBe(50000);
		expect(Object.keys(pr.gramsByRole)).toEqual([other]);
		expect(v.printTemplate?.remapped).toBe(1);
	});

	it('with print logs on the plates a recolor shows the prompt, and re-arranging keeps the learned times', async () => {
		const id = await mk(bed());
		const { role } = await learn(id, 'template');
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			plateNumber: (await view(id)).plates[0].number,
			grams: 10
		});
		const other = role === 'primary' ? 'accent' : 'primary';
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': other } });
		const info = await buildArrangement(db, id, 'owner');
		expect(info.stale).toBe(true);
		expect(info.template).toMatchObject({ fileName: 'mine.3mf' });
		await arrangeForPrinter(db, id, 'owner', { convertRuns: true });
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
		const wing = (await view(id)).plates.find((p) => p.parts.includes('wing-left'))!;
		expect(wing.estSource).toBe('learned');
	});

	it("the file's own plates mixed with a recolor are reported as no longer matching", async () => {
		const id = await mk(bed(), 'xpa');
		const { role } = await learn(id, 'plates');
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
		const other = role === 'primary' ? 'accent' : 'primary';
		await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': other } });
		// the wing is alone on its plate: its colors changed, so the plate no longer matches the slice
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(true);
		await arrangeForPrinter(db, id, 'owner');
		const v = await view(id);
		expect(v.plates.every((p) => p.source === 'arranged')).toBe(true);
		expect(v.plates.find((p) => p.parts.includes('wing-left'))!.estSource).toBe('learned');
	});
});
