import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db } from './db';
import { createTestDb, dropTestDb } from './db/testing';
import { organization } from './db/schema';
import { getExpected, getOrgSettings, setExpected, setOrgSettings } from './org-settings';

let db: Db;
afterEach(() => dropTestDb(db));
beforeEach(async () => {
	db = await createTestDb();
	await db.insert(organization).values({ id: 'org1', name: 'T', slug: 't', createdAt: new Date() });
});

describe('org settings', () => {
	it('auto-log is off until it is turned on', async () => {
		expect((await getOrgSettings(db, 'org1')).autoLogPrints).toBe(false);
		await setOrgSettings(db, 'org1', { autoLogPrints: true });
		expect((await getOrgSettings(db, 'org1')).autoLogPrints).toBe(true);
	});
	it('keeps the expected plate per printer and clears it', async () => {
		expect(await getExpected(db, 'org1', 'p1')).toBeNull();
		await setExpected(db, 'org1', 'p1', { buildId: 'b', plate: 2, at: 1 });
		expect(await getExpected(db, 'org1', 'p1')).toMatchObject({ buildId: 'b', plate: 2 });
		await setExpected(db, 'org1', 'p1', null);
		expect(await getExpected(db, 'org1', 'p1')).toBeNull();
	});
});

describe('concurrent writes', () => {
	it('two writers of different keys do not lose each other (serialised per workspace)', async () => {
		await Promise.all([
			setOrgSettings(db, 'org1', { autoLogPrints: true }),
			setExpected(db, 'org1', 'p1', { buildId: 'b', plate: 1, at: 1 }),
			setExpected(db, 'org1', 'p2', { buildId: 'b', plate: 2, at: 2 })
		]);
		expect((await getOrgSettings(db, 'org1')).autoLogPrints).toBe(true);
		expect(await getExpected(db, 'org1', 'p1')).toMatchObject({ plate: 1 });
		expect(await getExpected(db, 'org1', 'p2')).toMatchObject({ plate: 2 });
	});
});
