import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	buildParts,
	member,
	organization,
	printerJobs,
	printers,
	printRuns,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun, deleteRun, printingAction, undoRun } from './actions';
import { createBuild } from './create';
import { createPrinter } from '../printers/store';

let db: Db;
let buildId: string;
let printerId: string;
const T0 = new Date(Date.now() - 46 * 60_000);

const part = async () =>
	(await first(db.select().from(buildParts).where(eq(buildParts.partSlug, 'handle-left'))))!;

async function liveJob(status = 'printing') {
	await db.insert(printerJobs).values({
		printerId,
		buildId,
		plateNumber: 1,
		partSlugs: ['handle-left'],
		status,
		startedAt: T0
	});
}

beforeEach(async () => {
	db = await createTestDb();
	await seedTemplates(db, templateSeeds);
	await db.insert(user).values({ id: 'owner', name: 'Olive', email: 'o@example.test' });
	await db
		.insert(organization)
		.values({ id: 'org1', name: 'Chapter', slug: 'chapter', createdAt: new Date() });
	await db.insert(member).values({
		id: 'm1',
		organizationId: 'org1',
		userId: 'owner',
		role: 'owner',
		createdAt: new Date()
	});
	const templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	buildId = await createBuild(
		db,
		{ organizationId: 'org1', templateId, designId: null, name: 'Columbus' },
		'owner'
	);
	printerId = (await createPrinter(db, 'org1', 'owner', {
		name: 'Shop Centauri',
		kind: 'elegoo-sdcp',
		secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
		catalogId: 'elegoo-centauri-carbon'
	})).id;
	await db
		.update(printers)
		.set({ lastStatus: { state: 'printing', elapsedSec: 2760, remainingSec: 4440 } })
		.where(eq(printers.id, printerId));
});

const failed = { plateNumber: 1, result: 'Failed', date: '2026-11-12', grams: 10 };

describe('logging an older attempt while the plate prints again', () => {
	it('start from a live job takes its start and estimate; no live job takes now', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		const t = part().startedAt!.getTime();
		expect(Math.abs(t - Date.now())).toBeLessThan(5000);
		expect(part().runEstSeconds).toBeNull();
		await printingAction(db, buildId, 'owner', { action: 'stop', slugs: ['handle-left'] });

		await liveJob();
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		expect(part().startedAt!.getTime()).toBe(T0.getTime());
		expect(part().runEstSeconds).toBe(7200);
	});

	it.each([
		['negative elapsed', { elapsedSec: -5e9, remainingSec: 5e9 + 3600 }],
		['negative remaining', { elapsedSec: 3600, remainingSec: -10 }],
		['NaN', { elapsedSec: NaN, remainingSec: 100 }],
		['strings', { elapsedSec: '100', remainingSec: '100' }],
		['over 30 days', { elapsedSec: 2_000_000, remainingSec: 1_000_000 }]
	])('start ignores an absurd printer estimate (%s) but keeps the start', async (_n, status) => {
		await db
			.update(printers)
			.set({ lastStatus: { state: 'printing', ...status } as never })
			.where(eq(printers.id, printerId));
		await liveJob();
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		expect(part().startedAt!.getTime()).toBe(T0.getTime());
		expect(part().runEstSeconds).toBeNull();
	});

	it('a Failed run keeps the plate Printing with its start; delete and undo too', async () => {
		await liveJob();
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		const before = part();
		const { runId } = await addRun(db, buildId, 'owner', failed);
		expect(await db.select().from(printRuns)).toHaveLength(1);
		expect(part()).toMatchObject({
			status: 'Printing',
			startedAt: before.startedAt,
			runEstSeconds: 7200
		});
		await deleteRun(db, buildId, 'owner', runId);
		expect(part()).toMatchObject({ status: 'Printing', startedAt: before.startedAt });

		const { runId: id2 } = await addRun(db, buildId, 'owner', failed);
		await undoRun(db, buildId, 'owner', id2, {
			parts: [{ slug: 'handle-left', status: 'To print', comps: {} }]
		});
		expect(part()).toMatchObject({ status: 'Printing', startedAt: before.startedAt });
	});

	it('without a live job the Failed run flags Reprint as before', async () => {
		await printingAction(db, buildId, 'owner', { action: 'start', slugs: ['handle-left'] });
		await addRun(db, buildId, 'owner', failed);
		expect(part()).toMatchObject({ status: 'Reprint', startedAt: null });
	});
});
