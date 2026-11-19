import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { first, type Db } from '../db';
import { createTestDb, dropTestDb } from '../db/testing';
import {
	buildParts,
	member,
	organization,
	printerJobs,
	printers,
	templates,
	user
} from '../db/schema';
import { templateSeeds } from '../seed';
import { seedTemplates } from '../seed/run';
import { addRun } from './actions';
import { createBuild } from './create';
import { createPrinter } from '../printers/store';
import { loadBuildView, startedBuildIds } from './view';

let db: Db;
let templateId: string;
let printerId: string;

const make = async (name: string) =>
	await createBuild(db, { organizationId: 'org1', templateId, designId: null, name }, 'owner');
const setStatus = async (buildId: string, status: string) =>
	await db
		.update(buildParts)
		.set({ status })
		.where(and(eq(buildParts.buildId, buildId), eq(buildParts.partSlug, 'handle-left')));

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
	templateId = (await first(db.select({ id: templates.id }).from(templates)))!.id;
	printerId = (await createPrinter(db, 'org1', 'owner', {
		name: 'Shop Centauri',
		kind: 'elegoo-sdcp',
		secrets: { shareLink: 'https://shared-aaaaaaaa1111.octoeverywhere.com' },
		catalogId: 'elegoo-centauri-carbon'
	})).id;
	await db
		.update(printers)
		.set({ lastStatus: { state: 'printing' } })
		.where(eq(printers.id, printerId));
});

describe('startedBuildIds', () => {
	it('agrees with buildStarted(loadBuildView) for each kind of start', async () => {
		const none = await make('None');
		const run = await make('Run');
		const reprint = await make('Reprint');
		const printing = await make('Printing');
		const live = await make('Live');
		const paused = await make('Paused');
		await addRun(db, run, 'owner', {
			plateNumber: 1,
			result: 'Failed',
			date: '2026-11-12',
			grams: 10
		});
		await setStatus(reprint, 'Reprint');
		await setStatus(printing, 'Printing');
		for (const [buildId, status] of [
			[live, 'printing'],
			[paused, 'paused']
		] as const)
			await db.insert(printerJobs).values({
				printerId,
				buildId,
				plateNumber: 1,
				partSlugs: ['handle-left'],
				status,
				startedAt: new Date()
			});
		const all = [none, run, reprint, printing, live, paused];
		const got = await startedBuildIds(db, all);
		for (const id of all)
			expect(got.has(id), id).toBe((await loadBuildView(db, id, 'owner'))!.started.started);
		expect(got.has(none)).toBe(false);
		expect([...got].sort()).toEqual([run, reprint, printing, live, paused].sort());
	});
	it('ignores finished jobs and handles an empty list', async () => {
		const b = await make('Done');
		await db.insert(printerJobs).values({
			printerId,
			buildId: b,
			plateNumber: 1,
			partSlugs: [],
			status: 'finished',
			startedAt: new Date()
		});
		expect((await startedBuildIds(db, [b])).size).toBe(0);
		expect((await startedBuildIds(db, [])).size).toBe(0);
	});
});
