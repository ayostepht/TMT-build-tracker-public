import type { Db } from './index.ts';

/** Arbitrary constant, distinct from the migration lock; serialises containers starting together. */
const LOCKDOWN_LOCK_KEY = 7_346_201_002;

/** The roles Supabase's auto-generated REST API (PostgREST) connects as. */
export const SUPABASE_API_ROLES = ['anon', 'authenticated'] as const;

/**
 * Supabase exposes every table in schema `public` through its REST API to the `anon` and
 * `authenticated` roles. The app only talks to Postgres directly (as its own role, the table
 * owner), so those roles get nothing: this revokes their privileges on tables, sequences and
 * functions in `public`, revokes the default privileges for objects the app role creates later,
 * and turns row level security on for every app table (no policies, so the answer is "deny").
 * The owner role is not subject to RLS, so the app is unaffected.
 *
 * A startup step rather than a one-off migration, because it must also cover tables that later
 * migrations add (RLS is per table). It runs after `runMigrations` on every start, is idempotent,
 * and does nothing on plain Postgres (none of the roles exist) or for tables the current role does
 * not own.
 */
export async function lockDownSupabaseRoles(
	db: Db,
	roles: readonly string[] = SUPABASE_API_ROLES
): Promise<void> {
	for (const r of roles)
		if (!/^[a-z_][a-z0-9_]*$/.test(r)) throw new Error(`invalid role name: ${r}`);
	const list = roles.map((r) => `'${r}'`).join(', ');
	await db.$client.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(${LOCKDOWN_LOCK_KEY})`;
		await tx.unsafe(`
DO $do$
DECLARE
	found text[];
	r text;
	t record;
BEGIN
	SELECT array_agg(rolname::text) INTO found FROM pg_roles WHERE rolname = ANY (ARRAY[${list}]);
	IF found IS NULL THEN RETURN; END IF;
	FOREACH r IN ARRAY found LOOP
		EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
		EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
		EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
	END LOOP;
	FOR t IN
		SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
			AND pg_has_role(current_user, c.relowner, 'USAGE')
	LOOP
		EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
	END LOOP;
END
$do$`);
	});
}
