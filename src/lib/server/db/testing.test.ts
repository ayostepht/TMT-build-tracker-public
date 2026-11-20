// The harness keeps the server's connection count low: small pools, a short idle timeout, and
// every pool a test file forgot to close is ended by test-setup.ts after the file.
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, dropTestDb } from './testing';

describe('test database harness', () => {
	it('uses a small pool and a short idle timeout', async () => {
		const db = await createTestDb();
		try {
			expect(db.$client.options.max).toBeLessThanOrEqual(3);
			expect(db.$client.options.idle_timeout).toBeLessThanOrEqual(5);
		} finally {
			await dropTestDb(db);
		}
	});

	it('tracks databases a test never drops (closed by test-setup after the file)', async () => {
		const db = await createTestDb();
		const open = (globalThis as Record<symbol, unknown>)[Symbol.for('tmt.testDbs')] as Set<unknown>;
		expect(open.has(db)).toBe(true);
		await dropTestDb(db);
		expect(open.has(db)).toBe(false);
		// Left open on purpose: afterAll below must not be needed for correctness, test-setup closes it.
		const leaked = await createTestDb();
		expect(open.has(leaked)).toBe(true);
	});

	afterAll(() => {
		// nothing: the leaked pool above is closed by the setup file's afterAll
	});
});
