import { backfillBuildParts } from './builds/backfill';
import { repairTwinPlates } from './builds/twin-repair';
import { failStaleModelJobs, kickQueue } from './models/jobs';
import { getDb, runMigrations, type Db } from './db';
import { lockDownSupabaseRoles } from './db/supabase-lockdown';
import { templateSeeds } from './seed';
import { seedTemplates } from './seed/run';
import { startSupervisor } from './printers/supervisor';
import { sweepImportsDir } from './imports-sweep';
import { installKitPacks } from './kitpack/install';
import { cleanupAuthDataAtStartup } from './auth-cleanup';
import { startDemoCleanup } from './demo/cleanup';

// The database helpers below (backfill, twin repair, auth cleanup, stale-job sweep, imports sweep,
// printer supervisor) are async (Postgres); `run` awaits them in order (the imports sweep runs in the background).

let started: Promise<void> | null = null;

/**
 * Run migrations, reconcile template seeds, then backfill build rows. Idempotent and safe to
 * call repeatedly or concurrently (callers share one run). Two containers starting together are
 * serialised by advisory locks in `runMigrations` and `seedTemplates`. Rejects when the database
 * is unreachable or a migration fails; the caller should exit then.
 */
export function startup(): Promise<void> {
	return (started ??= run().catch((e) => {
		started = null;
		throw e;
	}));
}

/**
 * The database part of startup: migrate, then reconcile the template seeds. Idempotent; an empty
 * database ends up migrated and seeded, a second call changes nothing.
 */
export async function initDatabase(
	db: Db,
	seeds = templateSeeds
): Promise<{ inserted: string[]; updated: string[] }> {
	await runMigrations(db);
	// Supabase only (no-op elsewhere): keep its REST API roles away from the app's tables.
	await lockDownSupabaseRoles(db);
	const result = await seedTemplates(db, seeds);
	if (result.inserted.length) console.log(`[tmt] seeded templates: ${result.inserted.join(', ')}`);
	if (result.updated.length) console.log(`[tmt] updated templates: ${result.updated.join(', ')}`);
	return result;
}

async function run(): Promise<void> {
	const db = getDb();
	await initDatabase(db);
	await cleanupAuthDataAtStartup(db);
	const added = await backfillBuildParts(db);
	if (added) console.log(`[tmt] added ${added} part rows to existing builds`);
	try {
		const fixed = await repairTwinPlates(db);
		if (fixed.length)
			console.log(`[tmt] repaired ${fixed.length} uploaded plate(s) with twin parts`);
	} catch (e) {
		console.error('[tmt] twin plate repair failed', e);
	}
	const stale = await failStaleModelJobs(db);
	if (stale) console.log(`[tmt] marked ${stale} interrupted 3D model job(s) as failed`);
	Promise.resolve(sweepImportsDir(db))
		.then((n) => n && console.log(`[tmt] removed ${n} stale upload leftover(s) from imports`))
		.catch(() => {});
	kickQueue(db);
	// Demo sandboxes older than 24 h: now, then every 15 minutes (advisory-locked, one instance at a time).
	startDemoCleanup(db);
	// MakeGood's kit (CC0, one community part under CC BY-NC) from the baked-in or downloaded kit pack; in the background, never blocks start.
	installKitPacks(db).catch((e) => console.error('[tmt] kit pack install error', e));
	if (process.env.TMT_PRINTERS !== 'off') await startSupervisor(db);
}
