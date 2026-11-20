// Vitest setupFile (runs in every test file's worker): keep uploads/kit files out of ./data.
import { afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), 'tmt-test-data-'));

// Close every test database pool the file opened and did not drop (many files never call
// `dropTestDb`), so a finished file holds no server connections while others still run.
afterAll(async () => {
	const open = (globalThis as Record<symbol, unknown>)[Symbol.for('tmt.testDbs')] as
		Set<{ $client: { end: (o: { timeout: number }) => Promise<void> } }> | undefined;
	if (!open) return;
	const dbs = [...open];
	open.clear();
	await Promise.all(dbs.map((db) => db.$client.end({ timeout: 2 }).catch(() => {})));
});
