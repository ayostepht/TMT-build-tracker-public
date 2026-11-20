// Vitest setupFile (runs in every test file's worker): keep uploads/kit files out of ./data.
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only a directory created here is removed here; a DATA_DIR passed in from outside is left alone.
let ownDataDir: string | undefined;
if (!process.env.DATA_DIR) {
	// tmpdir() is the run's root (test-global-setup.ts) when set up by it, removed at the end.
	ownDataDir = mkdtempSync(join(tmpdir(), 'tmt-test-data-'));
	process.env.DATA_DIR = ownDataDir;
}

function removeOwnDataDir() {
	if (!ownDataDir) return;
	try {
		rmSync(ownDataDir, { recursive: true, force: true });
	} catch {
		// never fail a run over cleanup
	}
}
// Second line of defence for a worker that exits before its afterAll runs.
process.once('exit', removeOwnDataDir);

// Close every test database pool the file opened and did not drop (many files never call
// `dropTestDb`), so a finished file holds no server connections while others still run. Then
// remove the file's data directory, also when closing a pool failed.
afterAll(async () => {
	try {
		const open = (globalThis as Record<symbol, unknown>)[Symbol.for('tmt.testDbs')] as
			Set<{ $client: { end: (o: { timeout: number }) => Promise<void> } }> | undefined;
		if (!open) return;
		const dbs = [...open];
		open.clear();
		await Promise.all(dbs.map((db) => db.$client.end({ timeout: 2 }).catch(() => {})));
	} finally {
		removeOwnDataDir();
	}
});
