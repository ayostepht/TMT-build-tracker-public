import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogPrinter } from '#lib/printers/catalog.ts';
import { printerFromCatalog } from '#lib/printers/printer.ts';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import { member, organization, printerJobs, templates, user } from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, setPartStatus } from './actions';
import { createBuild } from './create';
import { createPrinter } from '../printers/store';
import { arrangeForPrinter, buildLayouts, setPlateLayout } from './plates';
import { BuildStartedError } from './started-guard';
import { loadBuildView } from './view';

// Issue #56: re-arranging or switching layout renumbers plates. Live job: refused. Started: confirm.

let db: Db;
let templateId: string;
const orgId = 'org1';
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
const layoutKey = async (id: string) => (await buildLayouts(db, id, 'owner')).layouts[0].key;
const liveJob = async (id: string) => {
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
		plateNumber: 2,
		partSlugs: (await view(id)).plates[1]?.parts ?? [],
		status: 'printing',
		startedAt: new Date()
	});
};
const refusal = async (fn: () => unknown): Promise<BuildStartedError> => {
	try {
		await fn();
	} catch (e) {
		expect(e).toBeInstanceOf(BuildStartedError);
		return e as BuildStartedError;
	}
	throw new Error('expected a refusal');
};

afterEach(async () => dropTestDb(db));

describe('plate replacement on a started build', () => {
	it('works without a prompt on an unstarted build', async () => {
		const id = await mk();
		expect((await view(id)).started.started).toBe(false);
		expect((await arrangeForPrinter(db, id, 'owner')).plates).toBeGreaterThan(0);
		expect(
			(await setPlateLayout(db, id, 'owner', { key: await layoutKey(id) })).plates
		).toBeGreaterThan(0);
	});

	it('refuses a live job, even with confirm, and changes nothing', async () => {
		const id = await mk();
		await liveJob(id);
		const before = await plates(id);
		const e1 = await refusal(
			async () => await arrangeForPrinter(db, id, 'owner', { confirm: true, convertRuns: true })
		);
		expect(e1.status).toBe(409);
		expect(e1.code).toBe('build-started');
		expect(e1.message).toMatch(/Plate 2 is printing on Shop.*wait until the print finishes/);
		expect(e1.extra.started.liveJobs).toBe(1);
		await refusal(
			async () => await setPlateLayout(db, id, 'owner', { key: await layoutKey(id), confirm: true })
		);
		expect(await plates(id)).toBe(before);
	});

	it('needs confirm when a part is Printing by hand, and names it', async () => {
		const id = await mk();
		await setPartStatus(db, id, 'owner', 'handle-left', { status: 'Printing' });
		const before = await plates(id);
		const e = await refusal(async () => await arrangeForPrinter(db, id, 'owner'));
		expect(e.message).toMatch(/renumbers/);
		expect(e.message).toMatch(/marked Printing by hand/);
		expect(e.extra.started.liveJobs).toBe(0);
		await refusal(async () => await setPlateLayout(db, id, 'owner', { key: await layoutKey(id) }));
		expect(await plates(id)).toBe(before);
		expect((await arrangeForPrinter(db, id, 'owner', { confirm: true })).plates).toBeGreaterThan(0);
		// statuses stay as they were
		expect((await view(id)).state['handle-left'].status).toBe('Printing');
		expect(
			(await setPlateLayout(db, id, 'owner', { key: await layoutKey(id), confirm: true })).plates
		).toBeGreaterThan(0);
	});

	it('a logged part run needs confirm too, and confirm converts plate logs', async () => {
		const id = await mk();
		await addRun(db, id, 'owner', {
			date: '2026-03-01',
			result: 'Success',
			plateNumber: 1,
			grams: 10
		});
		const e = await refusal(async () => await arrangeForPrinter(db, id, 'owner'));
		expect(e.message).toMatch(/print log/);
		const r = await arrangeForPrinter(db, id, 'owner', { confirm: true });
		expect(r.convertedRuns).toBe(1);
		expect((await view(id)).runs.every((x) => x.plateNumber === null)).toBe(true);
	});
});
