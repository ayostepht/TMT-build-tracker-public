import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import { organization, user } from '../db/schema';
import { createPrinter, listPrinters, printerCounts } from './store';

describe('printerCounts', () => {
	it('counts per workspace in one query, zero for none, equal to listPrinters', async () => {
		const db = await createTestDb();
		await db.insert(user).values({ id: 'u1', name: 'U', email: 'u@example.test' });
		for (const id of ['a', 'b', 'c'])
			await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
		await createPrinter(db, 'a', 'u1', { name: 'One', kind: 'manual' });
		await createPrinter(db, 'a', 'u1', { name: 'Two', kind: 'manual' });
		await createPrinter(db, 'b', 'u1', { name: 'Three', kind: 'manual' });
		const ids = ['a', 'b', 'c', 'unknown'];
		const counts = await printerCounts(db, ids);
		expect(counts).toEqual({ a: 2, b: 1, c: 0, unknown: 0 });
		for (const id of ids) expect(counts[id]).toBe((await listPrinters(db, id)).length);
		expect(await printerCounts(db, [])).toEqual({});
		// only the asked-for workspaces are counted
		expect(await printerCounts(db, ['b'])).toEqual({ b: 1 });
	});
});
