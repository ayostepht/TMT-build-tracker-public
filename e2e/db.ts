// Test-only: direct access to the e2e Postgres database (the one the Playwright web server runs on).
// playwright.config.ts resets it before the server starts (e2e/reset-db.mjs).
import postgres from 'postgres';

/** The e2e database: `E2E_DATABASE_URL`, else `tmt_e2e` on the local dev Postgres. */
export const E2E_DATABASE_URL =
	process.env.E2E_DATABASE_URL || 'postgres://tmt:tmt@localhost:5432/tmt_e2e';

export type E2eSql = postgres.Sql;

/** Runs `fn` with a one-connection client on the e2e database and closes it afterwards. */
export async function withE2eDb<T>(fn: (sql: E2eSql) => Promise<T>): Promise<T> {
	const sql = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

/** A row read back from the database, ready for `sql(row)`: jsonb values wrapped as json. */
export function insertable(sql: E2eSql, row: Record<string, unknown>) {
	return Object.fromEntries(
		Object.entries(row).map(([k, v]) => [
			k,
			v !== null && typeof v === 'object' && !(v instanceof Date)
				? sql.json(v as postgres.JSONValue)
				: v
		])
	) as Record<string, postgres.ParameterOrJSON<never>>;
}
