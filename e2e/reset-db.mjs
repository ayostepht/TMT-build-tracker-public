// Test-only: drops and recreates the e2e database (DATABASE_URL) before the Playwright web server
// starts; the app migrates and seeds it on startup. Run by the webServer command in
// playwright.config.ts. Refuses any database whose name does not end in `_e2e`.
import postgres from 'postgres';

const target = new URL(process.env.DATABASE_URL || '');
const name = decodeURIComponent(target.pathname.slice(1));
if (!/^[a-z0-9_]+_e2e$/.test(name)) {
	console.error(`[e2e] refusing to reset "${name}": the e2e database name must end in _e2e`);
	process.exit(1);
}
const admin = new URL(target);
admin.pathname = '/postgres';
const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
try {
	await sql.unsafe(`drop database if exists "${name}" with (force)`);
	await sql.unsafe(`create database "${name}"`);
} catch (e) {
	const err = /** @type {{ code?: string, message?: string }} */ (e);
	console.error(
		`[e2e] cannot reset ${name} (${err.code ?? err.message}). Start Postgres with scripts/dev-postgres.sh or set E2E_DATABASE_URL.`
	);
	process.exitCode = 1;
} finally {
	await sql.end();
}
