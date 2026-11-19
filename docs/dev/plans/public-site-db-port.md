# Public site: SQLite to Postgres porting guide (wave 2)

Wave 1 (`kit-and-startup`) replaced better-sqlite3 with Postgres. This is what changed in the
foundation and how to port the rest of the app. Everything is async now: every query is
`await`ed. The foundation, its tests and `startup.ts` are done; the app code outside
`src/lib/server/{db,seed,kitpack,models}` still calls the old sync API and fails to type-check
until ported.

## The foundation

`src/lib/server/db/index.ts` exports:

```ts
type Db = PostgresJsDatabase<Schema> & { $client: Sql }; // drizzle + postgres-js pool
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]; // inside db.transaction(async (tx) => …)
type DbOrTx = Db | Tx; // use for helpers that may run inside a transaction
openDb(url: string, opts?: { max?: number }): Db;
getDb(): Db; // lazy singleton from DATABASE_URL
closeDb(db?: Db): Promise<void>; // shutdown and tests
runMigrations(db: Db, folder?: string): Promise<void>; // advisory-locked, idempotent
first<T>(rows: PromiseLike<T[]>): Promise<T | undefined>; // replaces .get()
one<T>(rows: PromiseLike<T[]>, what?: string): Promise<T>; // like first, throws when empty
advisoryLock(tx: DbOrTx, name: string): Promise<void>; // transaction-scoped named lock
MIGRATIONS_FOLDER: string;
```

Config (`config.ts`): `databaseUrl()` (`DATABASE_URL`; dev default
`postgres://tmt:tmt@localhost:5432/tmt_dev`), `databasePoolMax()` (`DATABASE_POOL_MAX`, default 10),
`dataDir()` is now `DATA_DIR` (default `/data` in production, `./data` in dev). It used to be the
folder of the SQLite file; `uploadsDir()` and the kit pack paths follow it.

Driver notes: `prepare: false` (works through Supabase's transaction pooler); put
`?sslmode=require` in the Supabase URL. Migrations run in one transaction behind
`pg_advisory_xact_lock`, so two containers starting together are safe. `seedTemplates` locks the
same way. `startup()` is now async and returns a promise: `hooks.server.ts` must
`await startup()` (or hold the first request until it resolves).

Schema: same table, column and property names as before, same TS types (timestamps are `Date`,
booleans are `boolean`, json columns are `jsonb` with the same `$type`). Differences:

- `print_runs.created_at` is now `NOT NULL DEFAULT now()` (type `Date`, no longer `Date | null`).
- jsonb returns object keys in its own order (short keys first, then alphabetical): never compare
  json with `JSON.stringify(a) === JSON.stringify(b)`; sort keys first (see `canon()` in
  `seed/run.ts`).
- New indexes `builds_template_idx`, `color_designs_template_idx`, `color_designs_shared_at_idx`.
- **Shared design gallery columns** (columns only, no feature yet) on `color_designs`:
  `sharedAt` (`timestamptz`, null = not shared), `sharedBy` (user id, set null on user delete),
  `copiedFromDesignId` (self reference, set null on delete), index on `sharedAt`. The older
  `isPublic` flag is unchanged.
- Dropped (Spoolman only): table `spoolman_cache`; columns `build_filaments.spoolman_spool_id`,
  `spoolman_filament_id`, `spoolman_linked_at`; `organization_settings.spoolman_url`,
  `spoolman_auto_deduct` (the `settings` jsonb blob stays, with auto-log prints and the per-printer
  expected-plate entries); type field `SpoolAdd.spoolmanSpoolId`.
- Kept for now (printers stay, reached through OctoEverywhere shared links): `printers`,
  `printer_jobs`, `organization_settings`. LAN-only columns (`printers.camera_url`,
  `camera_enabled`, `host`, `port`) are still there; the printers agent reports which are unused and
  a follow-up migration drops them.
- Quotas stay config (env vars); the existing quota code needs no new column.

## Test harness

`vite.config.ts` registers a vitest `globalSetup` (`db/test-global-setup.ts`) that builds one
migrated template database per run, and a `setupFile` that points `DATA_DIR` at a temp dir.

```ts
import { createTestDb, createEmptyTestDb, dropTestDb } from '#lib/server/db/testing.ts'; // or relative
let db: Db;
beforeAll(async () => (db = await createTestDb())); // clone of the migrated template, ~30 ms, no rows
afterAll(() => dropTestDb(db)); // optional; teardown drops leftovers anyway
```

`createTestDb()` returns an isolated migrated empty database (call it in `beforeEach` for a fresh
one per test; seed with `await seedTemplates(db, templateSeeds)` when you need kits).
`createEmptyTestDb()` has no schema (migration and cold-start tests). `TEST_DATABASE_URL` overrides
`postgres://tmt:tmt@localhost:5432/tmt_test`. Without Postgres the run stops with a message pointing
at `scripts/dev-postgres.sh`. `scripts/dev-postgres.sh clean` drops databases a killed run left
behind. Every test file, even a pure unit test, pays the one-off template build (about a second).

Tests that set `process.env.DATABASE_URL = join(dir, 'tmt.db')` to get a data dir now set
`process.env.DATA_DIR = dir` and get their database from `createTestDb()`.

## Mechanical patterns

| SQLite (old)                                                     | Postgres (new)                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `db.select()….all()`                                             | `await db.select()…`                                                            |
| `db.select()….get()`                                             | `await first(db.select()…)` (`one(...)` when it must exist, replaces `.get()!`) |
| `db.insert(t).values(v).run()`                                   | `await db.insert(t).values(v)`                                                  |
| `db.update(t).set(v).where(w).run()`                             | `await db.update(t).set(v).where(w)`                                            |
| `db.delete(t).where(w).run().changes`                            | `(await db.delete(t).where(w).returning({ id: t.id })).length`                  |
| `….returning().get()`                                            | `const [row] = await db.insert(t).values(v).returning()`                        |
| `….returning().all()`                                            | `await db.insert(t).values(v).returning()`                                      |
| `db.select({ n: count() }).from(t).get()!.n`                     | `(await first(db.select({ n: count() }).from(t)))!.n` (`n` is a number)         |
| `db.transaction((tx) => { … })`                                  | `await db.transaction(async (tx) => { … })`, awaiting every statement           |
| `db.run(sql\`…\`)`, `db.all(sql\`…\`)`, `db.get(sql\`…\`)`       | `await db.execute(sql\`…\`)`, which returns the rows array (`rows[0]`)          |
| `.onConflictDoUpdate({ target, set })`, `.onConflictDoNothing()` | identical, works as before (awaited)                                            |
| `.values()` on a select (positional rows)                        | not available; select named columns                                             |

Async consequences to watch:

- `forEach`/`map` with `await` inside does not wait. Use `for (const x of xs)` (sequential) or
  `await Promise.all(xs.map(...))` (only outside a transaction; a transaction is one connection and
  runs statements one after another).
- A sync SQLite transaction made "count then insert" atomic. In Postgres two requests can both pass
  the count. Inside the transaction call `await advisoryLock(tx, 'quota:builds:' + orgId)` first
  (quotas, "one active job per kit", "first user becomes admin", invitation limits). `createJob` in
  `models/jobs.ts` and `seedTemplates` are examples.
- Helpers that took `db: Db` and are called inside transactions should take `DbOrTx`. Do not cast
  `tx as unknown as Db`.
- Pool size: a transaction holds a connection; never open a transaction and then wait on a second
  query through `db` (not `tx`) that needs another connection under a small pool.
- SSE emit after commit, not inside the transaction callback.
- Unique violations: error code `23505` (`(e as { code?: string }).code`), message text differs from
  SQLite's `UNIQUE constraint failed`.
- Serial ordering: SQLite's implicit `rowid` is gone. `ORDER BY created_at, rowid` becomes
  `ORDER BY created_at, id` (ids are random UUIDs, so the tie-break is arbitrary but stable); add a
  real sequence column if insertion order matters.

## Raw SQL differences

- `like` is case-sensitive in Postgres: use `ilike(col, pattern)` (drizzle exports `ilike`) where
  SQLite's case-insensitive match was relied on; escape `%`, `_`, `\` in user terms as before
  (`escape '\'` works).
- `lower(x) like ...` still works, `instr(a, b)` becomes `strpos(a, b)`.
- `json_extract(col, '$.a.b')` becomes `col #>> '{a,b}'` (text) or `col -> 'a' -> 'b'` (jsonb);
  `json_each` becomes `jsonb_array_elements`. jsonb containment: `col @> '{"k":1}'::jsonb`.
- `strftime('%Y-%m-%d', x/1000, 'unixepoch')` becomes `to_char(x, 'YYYY-MM-DD')` on a timestamptz
  (`date_trunc('day', x)` for grouping); `unixepoch()` becomes `extract(epoch from x)`;
  `datetime('now')` / `unixepoch('subsecond')*1000` becomes `now()`.
- Timestamps are `timestamptz` mapped to `Date`. Never store epoch milliseconds in these columns,
  never compare them to `Date.now()` numbers: write `new Date(ms)` or `sql\`${new Date(ms)}\``. Date
strings like `'2026-11-19'`stay`text` columns (`delivery_date`, `printed_on`, `handed_off_on`,
print run `date`).
- Booleans are real booleans: `= 1` / `= 0` becomes `= true` / `= false` (or use `eq(col, true)`).
- `CASE WHEN … THEN … ELSE NULL END`, `max()`, `lower()`, `coalesce()` are unchanged.
- Aggregates: `count()` is `bigint` in SQL, drizzle's `count()` maps it to a number; hand-written
  `count(*)` returns a string, cast `count(*)::int`.
- Column identifiers in raw SQL are quoted names (`"user"`, `"created_at"`); `user` is a reserved
  word, always quote it.
- `INSERT OR IGNORE` / `OR REPLACE` become `onConflictDoNothing()` / `onConflictDoUpdate`.
- Json default expressions: `sql\`'{}'::jsonb\``.
- Case-insensitive uniqueness (emails) is not enforced by the database in either engine; keep the
  existing `lower()` comparisons.

## Files outside the foundation that need porting

Importing removed helpers (`openDb` kept but now async-world, `sqliteOf`, `baseline-upgrade`):

- `src/hooks.server.ts`: `startup()` now returns a promise; await it.
- `src/lib/server/print-geometry/import-cli.ts`: uses `openDb`/`runMigrations` synchronously
  (`initDb`); re-exported from `kitpack/cli.ts`.
- `src/lib/server/reset-password-cli.ts`: SQLite file CLI, to be deleted (the public site has no
  passwords).
- `scripts/build-kit-pack.mjs`, `scripts/import-print-geometry.mjs`: maintainer tools driving the
  CLI bundle with a scratch database; need a scratch Postgres (`DATABASE_URL`) and `await`.
- `scripts/preview/seed.mjs`, `scripts/dev-register-model.mjs`, `scripts/preview-demo.mjs`: use
  better-sqlite3 or a `tmt.db` file directly.
- `vite.cli.config.ts` (externals `better-sqlite3`), `Dockerfile` (native build tools comment),
  `src/lib/server/teams.ts` comment: remove better-sqlite3 references.
- Test files in other areas that call `openDb(':memory:')` / `runMigrations(db)`: replace with
  `createTestDb()` (about 60 files; `grep -rln "openDb(':memory:')" src`).

Raw SQL, `.prepare(`, `rowid` and other SQLite-isms (grep `sql\``, `rowid`, `db.run(`):

- `builds/list.ts`: `sql\`${buildFilaments}.rowid\``ordering,`max(${activity.at})`ordering,`desc`on created_at (use`sort`or`role_key`/insertion index instead of rowid).
- `builds/backfill.ts`: `db.run(sql\`insert …\`)`returns`{ changes }`; becomes `db.execute`and a`returning`/count of inserted rows.
- `account.ts`: `sql\`rowid\``tie-breaks (three places),`lower(email) = ?`,
`instr(lower(identifier), ?)`(use`strpos`), `like(...)`(maybe`ilike`), delete cascades.
- `access.ts`: `orderBy(asc(user.createdAt), sql\`rowid\`)`for "first user is site admin"; make it
lock-safe (two signups at once) with`advisoryLock`.
- `teams.ts`: `sql\`${invitation.expiresAt} <= ${Date.now()}\``compares a timestamptz to epoch
milliseconds: pass a`Date`; `rowid desc`tie-break;`.run().changes`row counts; the sync`createTeam` transaction (comment says "Synchronous (better-sqlite3)").
- `quota.ts`: `assertUnder`'s counter contract (`() => number`) must become async and run under an
  advisory lock; `sql\`delete from activity where build_id = ? and rowid in (…)\`` needs a new
"oldest N" formulation (`ctid`or`id in (select id … order by at limit n)`).
- `auth-cleanup.ts`: `CASE WHEN provider_id = 'oidc' …` update (still valid), uses `db.transaction`.
- `password-reset.ts`: `lower(email) = ?`, `like` on identifiers (file goes away with password
  reset).
- `site-admins.ts`: `lower(name) like ? escape '\'` search (fine, consider `ilike`),
  `onConflictDoNothing`.
- `auth.ts`: adapter `provider` is already `'pg'`; the `databaseHooks`/`create user` hooks that use
  `db.transaction` become async, and "first user = site admin" needs the advisory lock.
- `print-geometry/store.ts`, `spoolman/cache.ts`: `onConflictDoUpdate` (works; spoolman goes away).
- `routes/api/health/+server.ts`: runs a SQLite probe; use `await db.execute(sql\`select 1\`)`.
- Transactions to convert to `async`: `builds/actions.ts` (`mutateBuild`), `builds/create.ts`,
  `builds/photos.ts`, `designs/designs.ts`, `filaments/custom.ts`, `account.ts`, `templates/fork.ts`,
  `printers/store.ts`, `guide.ts`, `site-admins.ts`, `teams.ts`, `quota.ts`, `auth-cleanup.ts`,
  `auth.ts`.
- About 80 other files use `.get()/.all()/.run()`; `npx svelte-check` lists them (the compiler
  error "Property 'get' does not exist on type 'Omit<PgSelectBase…'" is the signal).

Foundation tests left skipped until their out-of-area dependencies are async (search
`TODO(wave 2)`): `models/jobs.test.ts` "conversion slots per user" (needs async `quota.ts`) and
"model admin permissions" (needs async `templates/fork.ts` `canManageTemplate` and `access.ts`).
`models/guard.ts` and `models/jobs.ts` already `await` those calls and cast to `never`; remove the
casts when the callees are typed async.
