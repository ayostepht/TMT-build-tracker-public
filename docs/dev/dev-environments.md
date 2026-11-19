# Development environments

Work happens on more than one machine. This file holds everything about them that is safe
to commit. Private values (the real domain, server address, Supabase project, tokens, exact
host paths) live in each machine's untracked `CLAUDE.local.md`, whose shape is
`CLAUDE.local.example.md`. Cloud sessions have no `CLAUDE.local.md` and never deploy.

## Machines

| Machine                         | Used for                                    | Tooling                                                                          |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| Cloud sessions (claude.ai/code) | Most agent work, pull requests              | Fresh Linux container: Node 22, Postgres 16 package, Docker (daemon not started) |
| Maintainer's Mac                | Local sessions, local preview, phone checks | Node 22 first on PATH, Postgres 16, `flock` from Homebrew                        |
| Maintainer's Unraid server      | **The live site** (not a dev machine)       | Docker; pulls the published image; Cloudflare Tunnel                             |

All push to the same GitHub repository. **At session start:** `git fetch`; if you are on a
branch, or `main` differs from `origin/main`, say so before working. **At session end:**
everything committed and pushed (with the maintainer's OK) so the next session picks up from
`docs/dev/HANDOFF.md`.

Commit identity: the GitHub noreply address (from `CLAUDE.local.md` on the Mac), never a
personal email: the repository is public. Claude Code project memory is per machine and does
not travel; anything durable belongs in this repository's docs.

## New machine

1. Node 22 (CI and the image use 22; Node 25 fails `npm run build`; with nvm:
   `nvm install 22 && nvm use 22`), git, Postgres 16, Docker if the machine builds images.
2. Clone; `npm ci` (`.npmrc` sets `legacy-peer-deps=true`);
   `npx playwright install chromium`. npm 11+ blocks install scripts by default: `npm install-scripts approve esbuild`,
   and don't commit a `package-lock.json` rewritten by a different npm.
3. Postgres (below), then `cp .env.example .env` and set
   `DATABASE_URL=postgres://tmt:tmt@localhost:5432/tmt_dev`.
4. E2E lock: Linux has `flock`; macOS: `brew install flock`.
5. Mac only: `cp CLAUDE.local.example.md CLAUDE.local.md` and fill it from the maintainer's
   canonical copy (kept outside git). Never guess the values.
6. Have the `verifier` agent run the gate once.

## Local Postgres

`scripts/dev-postgres.sh` (Debian/Ubuntu layout, `postgresql-16`; run as root or a user that
can `sudo -u postgres`) starts the cluster and creates the role `tmt` (password `tmt`,
`CREATEDB`) and the databases `tmt_dev` and `tmt_test`. It is idempotent: run it at the start
of every cloud session. `scripts/dev-postgres.sh clean` drops `tmt_t_*` / `tmt_tpl_*`
databases a killed test run left behind (only while no test run is in progress).

On the Mac or anywhere else, any Postgres 16 works, for example
`docker run -d --name tmt-postgres -p 5432:5432 -e POSTGRES_USER=tmt -e POSTGRES_PASSWORD=tmt -e POSTGRES_DB=tmt_dev postgres:16`
and `docker exec tmt-postgres createdb -U tmt tmt_test`.

| Database                     | Used by                                   | Variable (default)                                           |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `tmt_dev`                    | `npm run dev`                             | `DATABASE_URL` (`postgres://tmt:tmt@localhost:5432/tmt_dev`) |
| `tmt_test` + per-file clones | Vitest (`createTestDb()`)                 | `TEST_DATABASE_URL` (`…/tmt_test`)                           |
| `tmt_e2e`                    | Playwright, dropped and recreated per run | `E2E_DATABASE_URL` (`…/tmt_e2e`; must end in `_e2e`)         |
| `tmt_preview_test`           | `npm run preview:demo` (see below)        | derived from `DATABASE_URL`                                  |

## Environment for development

`npm run dev` runs without a real `BETTER_AUTH_SECRET`, sign-in provider, `ADMIN_EMAILS` or
trusted proxy: boot validation only applies with `NODE_ENV=production`. To sign in locally,
use the demo (`/demo`) or create a Google, GitHub or Discord OAuth app with the callback
`http://localhost:5173/api/auth/callback/<provider>` and put its pair in `.env`; add its
verified email to `ADMIN_EMAILS` for the kit admin. Useful variables in `.env`:
`DATABASE_URL`, `DATA_DIR` (default `./data` in dev), the provider pairs, `ADMIN_EMAILS`.
Everything else is in `.env.example` and `docs/guides/environment.md`. Never put real
production values in a dev `.env`.

## Running tests

- Unit: `npm test` or `npx vitest run <files>`. Needs Postgres; without it the run stops with
  a message pointing at `scripts/dev-postgres.sh`.
- E2E: from the repo root, always `--reporter=line` (the html reporter hangs on failure).
  Playwright builds the app, resets `tmt_e2e` (`e2e/reset-db.mjs`) and starts it with
  `NODE_ENV=test` and the test-only sign-in on port 4173 (`E2E_PORT` to change it).
- **One e2e run (or production build) at a time per machine**, under one machine-wide lock:
  `flock /tmp/tmt-e2e.lock npx playwright test e2e/<spec>.spec.ts --reporter=line`
  (on the Mac `/opt/homebrew/bin/flock`). The same lock covers every worktree. Two runs at once
  also need different `E2E_PORT` and `E2E_DATABASE_URL` values; without `flock`, the
  orchestrator must not run two e2e-running agents at once.
- Full suite only when asked; CI runs it on every pull request.

## Real-file tests (optional, skip when unset)

| Variable                                          | Used by                                                               | Points at                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `KITPACK_DIR`                                     | `arrange.real`, `arrange-margins.real`, `sliced.real`, `install.real` | a folder with the kit pack(s) from `kitpacks/index.json` |
| `TMT_SLICED_3MF`                                  | `sliced.real`, `gcode-stats.real`                                     | the maintainer's sliced 24-plate project                 |
| `TMT_XPA_3MF`                                     | `print-geometry/groups.real`                                          | the X/P/A profile 3MF                                    |
| `TMT_PACK_DIR`, `TMT_GROUPS_DB`, `TMT_GROUPS_OUT` | `builds/groups.real`                                                  | kit pack dir, scratch DB, output                         |
| `TMT_MG_DB`, `TMT_MG_DEBUG`                       | `arrange-margins.real`                                                | scratch DB                                               |

Read each test's header for the rest (`TMT_H_*`, `TMT_BUCKET_*`, `TMT_REAL_DB`). MakeGood
files, the sliced project and kit packs are never in git; paths are in `CLAUDE.local.md`.

## Worktrees (parallel agents)

When more than one agent will edit code at the same time, give each task its own worktree:
one task = one branch = one worktree = one pull request into `main`.

- Create it beside the repo: `git worktree add ../tmt-public-wt-<task> -b <branch> origin/main`.
- Dependencies: install once per worktree with `npm ci` before its agent starts (one install
  at a time across the machine). A symlinked `node_modules` works for vitest, eslint and a dev
  server but **not** for `npm run check` (the `$app/tsconfig` path resolves into the other
  checkout and gives false `./$types` errors); per-package symlinks or `npm ci` are fine.
- Unit tests in several worktrees share the local Postgres safely (each file gets its own
  database). E2E and builds take the `/tmp/tmt-e2e.lock` lock above.
- Remove the worktree after its pull request is merged or closed:
  `git worktree remove ../tmt-public-wt-<task>` (removing one with unmerged work needs the
  maintainer's OK).

## Local preview

`npm run preview:demo` (`scripts/preview-demo.mjs`) builds the working tree into
`data/preview/build`, serves it on port 5200 against its own `tmt_preview_test` database and
seeds invented sample data (an owner and an editor in a demo team, two builds, a draft, a saved
design, a manual printer). It runs with `NODE_ENV=test` and `E2E_AUTH=1`, so it signs in through
the guarded test sign-in (the database name must end in `_test`; the guard in `auth-e2e.ts` is
unchanged). There is no password: open `http://localhost:5201/` (port + 1) to be signed in as
the owner, or `http://localhost:5201/?as=editor` as the editor. That helper listens on
127.0.0.1 only, because it signs in whoever reaches it; to try a phone, use an SSH tunnel to
port 5201. `--fresh` drops and recreates the preview database.

## Docker in a cloud session

The container has Docker, buildx and compose, but the daemon is not running: start `dockerd`
in the background (log to the scratchpad) and wait for `docker info`. Build containers cannot
reach the session's HTTPS proxy and don't trust its CA, so build the Dockerfile on a local
helper base image:

1. Kit pack: download the file listed in `kitpacks/index.json` from its release on the
   sibling repository (`https://github.com/ayostepht/TMT-Build-Tracker/releases/download/kitpack-<slug>-<version>/<file>`)
   into `kitpacks/` and check its sha256 and size against the index.
2. Helper base (scratch dir, never committed or pushed): `FROM node:22-bookworm-slim`; copy
   `/root/.ccr/ca-bundle.crt` in as `/usr/local/share/ca-certificates/ccr.crt` and
   `/etc/ssl/certs/ca-certificates.crt`; switch apt sources to `https://deb.debian.org`;
   `/etc/apt/apt.conf.d/99proxy` with `Acquire::https::Proxy` set to `$HTTPS_PROXY` (its port
   changes per session) and `Acquire::https::CaInfo`; `ENV` for `HTTPS_PROXY`,
   `NODE_EXTRA_CA_CERTS`, `npm_config_cafile`, `SSL_CERT_FILE`. Rebuild it in every new
   session. Build it with `docker build --network host -t tmt-cloud-base:node22 <dir>`.
3. `docker buildx build --network host --build-context node:22-bookworm-slim=docker-image://tmt-cloud-base:node22 --load -t tmt-build-tracker-public:cloudcheck .`
4. Empty-start check: a fresh data dir owned by `1000:1000` and an empty database on the local
   Postgres, `docker run -d --rm --name tmt-cloudcheck --network host -v <dir>:/data -e NODE_ENV=development -e DATABASE_URL=postgres://tmt:tmt@localhost:5432/<empty db> -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) tmt-build-tracker-public:cloudcheck`
   (development mode skips the production boot checks), poll `/api/health`, read the log
   (migrations, seeded templates, kit pack installed a few seconds later), stop, start again on
   the same database and directory.

That image carries the proxy settings: local checks only, never pushed. Containers are named
`tmt-*` and started with `--rm`.

## Deploy (live site)

Only the orchestrator with the maintainer, only from a machine whose `CLAUDE.local.md` has
the deploy specifics (container names, appdata path, how to reach the server). Setup from
scratch is in `docs/guides/hosting.md` (Path C, "On Unraid").

**Setup on the server:** the app container from
`ghcr.io/ayostepht/tmt-build-tracker-public:latest` on a custom Docker network with no port
mapping, `/data` on an appdata folder owned by `1000:1000`, and a `cloudflare/cloudflared`
container on the same network running the tunnel. Data lives in Supabase (database) and
`/data` (uploads, converted models, the installed kit pack). Secrets (`DATABASE_URL`,
`BETTER_AUTH_SECRET`, provider secrets, `TUNNEL_TOKEN`) exist only in the containers'
settings on the server and the maintainer's password manager: never in git, chat, briefs or
reports.

**Routine for each deploy:**

1. The pull request is merged and the `public-ci` run on `main` is green, including
   `publish`. Note the `sha-<short>` it pushed.
2. **Back up** first when the deploy carries a migration (and at least weekly anyway):
   `pg_dump "$DATABASE_URL" --format=custom --no-owner --file=tmt-<date>.dump` (pg_dump 16+,
   run where the URL is available, never pasted into a session), and a tar of the `/data`
   folder. Store both off the server.
3. **Migrations after the first deploy:** rehearse on a copy first: restore the dump into a
   scratch Postgres, start the new image against it with an empty scratch `/data`, wait for
   `/api/health`, read the log, compare row counts. Problems → stop.
4. **Update:** pull the image and recreate the container (Unraid Docker tab, Check for
   Updates, apply), or `docker pull` the `sha-<short>` tag and recreate with the same settings.
5. **Check:** `https://<site>/api/health` answers `{"ok":true,"version":…}`; the container log
   shows migrations and startup without errors; sign in, open a build, check the demo starts.
6. **Rollback:** recreate the container from the previous `sha-<short>`. If a migration ran,
   restore the dump into Supabase first (the maintainer does this in the Supabase dashboard or
   with `pg_restore`).
7. Add the deploy to `docs/dev/CHANGELOG.md` (date, `sha-<short>`, what changed, migration
   yes/no) and tell the maintainer what to look at on their phone.

The very first deploy also checks the Supabase lockdown (`anon` and `authenticated` have no
access to the app's tables) and records the date in STATUS, which freezes
`drizzle/0000_baseline.sql`.
