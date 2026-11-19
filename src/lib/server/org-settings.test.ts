import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations, type Db } from './db';
import { organization } from './db/schema';
import { getExpected, getOrgSettings, setExpected, setOrgSettings } from './org-settings';

let db: Db;
beforeEach(() => {
	db = openDb(':memory:');
	runMigrations(db);
	db.insert(organization).values({ id: 'org1', name: 'T', slug: 't', createdAt: new Date() }).run();
});

describe('org settings', () => {
	it('auto-log is off until it is turned on', () => {
		expect(getOrgSettings(db, 'org1').autoLogPrints).toBe(false);
		setOrgSettings(db, 'org1', { autoLogPrints: true });
		expect(getOrgSettings(db, 'org1').autoLogPrints).toBe(true);
	});
	it('keeps the expected plate per printer and clears it', () => {
		expect(getExpected(db, 'org1', 'p1')).toBeNull();
		setExpected(db, 'org1', 'p1', { buildId: 'b', plate: 2, at: 1 });
		expect(getExpected(db, 'org1', 'p1')).toMatchObject({ buildId: 'b', plate: 2 });
		setExpected(db, 'org1', 'p1', null);
		expect(getExpected(db, 'org1', 'p1')).toBeNull();
	});
});
