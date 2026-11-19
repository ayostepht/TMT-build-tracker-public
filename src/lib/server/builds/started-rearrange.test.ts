import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { member, organization, printerJobs, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, setPartStatus, setPrinter } from './actions';
import { createBuild } from './create';
import { updateBuildDesign } from '../designs/mutate';
import { createPrinter } from '../printers/store';
import { buildArrangement } from './plates';
import { loadBuildView } from './view';

// Issue #56: once a build has started printing, design/part moves must not rewrite its plates.

let db: Db;
let templateId: string;
const orgId = 'org1';
afterEach(async () => dropTestDb(db));

const cc = printerFromCatalog(catalogPrinter('elegoo-centauri-carbon')!, 0);

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

const mk = async () =>
	await createBuild(
		db,
		{ organizationId: orgId, templateId, designId: null, name: 'B', printer: cc },
		'owner'
	);
const view = async (id: string) => (await loadBuildView(db, id, 'owner'))!;
const plates = async (id: string) => JSON.stringify((await view(id)).plates);
const move = async (id: string) =>
	await updateBuildDesign(db, id, 'owner', { partRoles: { 'wing-left': 'primary' } });

describe('design changes on a started build keep the plates', () => {
	it('an unstarted arranged build still re-arranges automatically', async () => {
		const id = await mk();
		expect((await view(id)).started.started).toBe(false);
		const before = await plates(id);
		await move(id);
		expect(await plates(id)).not.toBe(before);
		expect((await buildArrangement(db, id, 'owner')).stale).toBe(false);
	});

	const cases: [string, (id: string) => Promise<unknown>][] = [
		[
			'a part logged on its own',
			async (id) =>
				await addRun(db, id, 'owner', {
					date: '2026-03-01',
					result: 'Success',
					partSlug: 'handle-left',
					grams: 5
				})
		],
		[
			'a part that is Printing',
			async (id) => await setPartStatus(db, id, 'owner', 'handle-left', { status: 'Printing' })
		],
		[
			'a part that is Reprint',
			async (id) => await setPartStatus(db, id, 'owner', 'handle-left', { status: 'Reprint' })
		],
		[
			'a live printer job',
			async (id) => {
				const printerId = (
					await createPrinter(db, orgId, 'owner', {
						name: 'Shop',
						kind: 'elegoo-sdcp',
						secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
						catalogId: 'elegoo-centauri-carbon'
					})
				).id;
				await db.insert(printerJobs).values({
					printerId,
					buildId: id,
					plateNumber: 1,
					partSlugs: (await view(id)).plates[0].parts,
					status: 'printing',
					startedAt: new Date()
				});
			}
		]
	];
	for (const [name, start] of cases)
		it(`does not rewrite plates after ${name}, and the plates go stale`, async () => {
			const id = await mk();
			await start(id);
			expect((await view(id)).started.started).toBe(true);
			const before = await plates(id);
			await move(id);
			expect(await plates(id)).toBe(before);
			expect((await buildArrangement(db, id, 'owner')).stale).toBe(true);
		});

	it('a printer change on a started build keeps the plates too', async () => {
		const id = await mk();
		await setPartStatus(db, id, 'owner', 'handle-left', { status: 'Printing' });
		const before = await plates(id);
		await setPrinter(db, id, 'owner', {
			printer: { ...cc, bedX: 350, bedY: 320, catalogId: null, name: 'Big' }
		});
		expect(await plates(id)).toBe(before);
	});

	it('a live job reports its plate in started.printingPlates', async () => {
		const id = await mk();
		const printerId = (
			await createPrinter(db, orgId, 'owner', {
				name: 'Shop',
				kind: 'elegoo-sdcp',
				secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
				catalogId: 'elegoo-centauri-carbon'
			})
		).id;
		await db.insert(printerJobs).values({
			printerId,
			buildId: id,
			plateNumber: 3,
			partSlugs: [],
			status: 'paused',
			startedAt: new Date()
		});
		expect((await view(id)).started).toMatchObject({
			started: true,
			liveJobs: 1,
			printingPlates: [3]
		});
	});
});
