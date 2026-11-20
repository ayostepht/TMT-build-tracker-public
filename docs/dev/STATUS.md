# Project status

_Last updated: 2026-11-20._

This file holds **current facts only** for the hosted edition: what works, what's open,
what's decided. Deploy history goes in `docs/dev/CHANGELOG.md`; how things work goes in
`docs/architecture.md`; how the hosted edition was built is in
`docs/dev/plans/public-site.md`. Rewrite entries in place; delete what is done. Keep it
short. History before the split (self-hosted 0.9.x, SQLite, the Unraid test copy) lives in
the sibling repository [ayostepht/TMT-Build-Tracker](https://github.com/ayostepht/TMT-Build-Tracker)
(`docs/dev/` on its `edge` branch).

## Where we are

- **Code:** the hosted edition is complete on `main` (8eb3f1e): Postgres, SSO-only sign-in
  (Google, GitHub, Discord), demo sandbox, shared design gallery, printers through
  OctoEverywhere links only, cookieless analytics, `TRUST_CLOUDFLARE` client address, quota
  defaults, account deletion, public home. Last gate on the combined tree before the split:
  check, lint, 1901 unit tests, build, production start from an empty database twice, full
  e2e green. Two security reviews (2026-11-19): nothing high open.
- **CI:** `.github/workflows/public-ci.yml` (test, e2e, image; `publish` on push to `main`
  pushes `ghcr.io/ayostepht/tmt-build-tracker-public:latest` and `sha-<short>`). First run on
  this repository green (2026-11-19, `8eb3f1e`), image published.
- **Live since 2026-11-19:** the maintainer's server runs `sha-8eb3f1e` (`:latest`) behind a
  Cloudflare Tunnel against Supabase. First start clean (migrations, lockdown, seed, kit
  pack); sign-in with Google verified; home page and demo checked. Supabase check after the
  first start: 37 app tables, RLS on everywhere with no policies (the intended lockdown);
  security advisor shows only that informational notice.
- **Real users since 2026-11-20:** the site was shared with a first few makers. Updates
  must keep their data: additive, backward-compatible migrations only, a backup and a
  rehearsal before any migration reaches `main` (rules in `docs/dev/HANDOFF.md`).
- **Live (sixth deploy, 2026-11-20):** `sha-828df84`, everything through #26. No
  migrations since `0001`. The maintainer confirmed the speed-up on the live site.
- **Merged, not yet deployed:** #27 leave and delete teams (member removal, role changes and
  account deletion share the `team:<id>` lock), #28 the kit layout comes first in the
  arranger. No migrations.
- **Speed (2026-11-20):** pages were slow because of sequential database round trips (the app
  and the database are a network hop apart). Measured through a latency proxy at 40 ms per
  round trip, before → after #18/#19: build page 2.3 s → 0.6 s, builds list 3.0 → 1.1 s, team
  page with 12 builds 17 → 2.9 s, create a build 7.5 → 1.2 s, mark a plate printed 3.3 → 2.5 s.
  Demo start: about 57 s → 0.8 s with a spare ready (#24).
  `DATABASE_PREPARE=on` (opt-in, untested against Supabase) removes a second round trip per
  parameterised query (about 2× on warm requests). Moving the container next to the database
  would cut the remaining wait by about 95%.
- **Migrations:** one baseline, `drizzle/0000_baseline.sql`, applied to the live database on
  2026-11-19. **Frozen from now on:** schema changes add new migrations; never edit or
  regenerate the baseline. `0001_drop_duplicate_org_slug_index` merged and applied 2026-11-19 (#3). Team creation now retries on a slug conflict.

## Waiting on the maintainer

- Backups: nightly User Script on the maintainer's server since 2026-11-20 (`pg_dump` 17 of
  the `public` and `drizzle` schemas plus a tarball of `/data`, 14 days kept, on an array
  share apart from appdata). Still to do: an off-site copy and a first restore test.
- Repository settings for the new repo: branch protection on `main` (required `public-ci`
  checks, no force push), private vulnerability reporting, the `ghcr.io` package visibility,
  Dependabot.
- Review the screenshots and the demo on the live site.
- Choice: whether the service worker drops cached kit models on sign-out (shared devices).
- After the next deploy (#12, #13): start a demo once (strict action and hostname checks run
  for the first time against the real widget) and leave a demo once.
- Sibling repository: the upload and export resource limits also apply to the self-hosted
  0.9.x line; back-port them there and cut a patch release (timing and tag are yours).

## Open items

- Sibling repository (self-hosted): carry over by hand when convenient (not security fixes):
  the color picker scroll fix (#5) and compact desktop controls (#9) in `SwatchPicker.svelte`
  with `e2e/picker-scroll.spec.ts`; the export following the chosen layout (#6,
  `threemf-export/index.ts`, `builds/arrange-plan.ts`); the shared text limits (#8,
  `domain/limits.ts` and the `maxlength` attributes); and, when the sibling takes
  adapter-node 6.0.2, the `ORIGIN` handling in `scripts/proxy-origin.mjs` (#4).
- Color picker: the desktop brand-chip row scrolls sideways with no visual hint at its edge;
  a fade would help [design-studio-ui].
- Every link to `/demo` needs `data-sveltekit-reload` (the Turnstile CSP is sent only with the
  `/demo` document); `e2e/way-home.spec.ts` asserts it.
- Demo spares (#24): `DEMO_SPARES` ready-made demos are kept by a background pool
  (`server/demo/spares.ts`), marked by `spare-building-` / `spare-ready-` / `spare-expired-`
  `@demo.invalid` addresses on `isDemo` users (no schema change), claimed under the
  `demo-start` lock, recycled after 4 h. For a minute or two after a deploy the slower
  synchronous path still runs. The e2e server runs with one spare.
- Tests: pools in tests are 3 connections with a 2 s idle timeout and leaked pools are closed
  (#25); a full unit run peaks at about 25 connections (was 96 of CI's 100). CI Postgres
  allows 300. Several full suites at once on one machine still time out creating databases.
- Production connections: one pool, `DATABASE_POOL_MAX` default 10 (3 kept warm). Confirm the
  Supabase pooler's pool size in the dashboard; if it is under 10, set `DATABASE_POOL_MAX=6`.
  Document the guidance in `docs/guides/environment.md` and `hosting.md` [release-pwa].
- Arranger (#28): the source layout (uploaded plates, else the kit layout for the bed) is
  kept; `domain/arrange-source.ts`. Standard palette on a 256 mm bed gives 25 plates (kit 24
  plus a split of the rims), where the old default path gave 21. Stored arrangements carry
  `v: 2`; older ones are still checked against the previous planner and are never rewritten.
  Questions with the maintainer: may moved parts join an existing multi-part plate; store
  the author's positions in the kit pack; names of moved plates; a "reset to the kit layout"
  preview for existing arranged builds. `print-template.spec.ts:53` saw a connection reset
  once in 16 local repeats on the branch (none on main, CI green): watch it.
- Part-level printing (start and log a chosen subset of a plate) is being built in the
  sibling repository; port it here when it lands. What exists today: a single part can be set
  to Printing from its own row, and "Printed" on the plate then logs only the parts that are
  Printing (grams proposed are the whole plate's).
- Teams follow-ups: Better Auth's `/organization/delete` is still enabled and takes no team
  lock (disable it and route deletion through `deleteTeam`); a team joined while the account
  is being deleted isn't locked.
- `member` has no unique index on (organization, user); Better Auth prevents duplicates in
  the app. An additive unique index would need a check for existing duplicates first and the
  maintainer's sign-off (schema).
- Mutations load the full build view inside their transaction, where queries can't overlap
  (about 35 sequential queries per status change). Options: named prepared statements, or a
  lighter view for mutations [build-state, kit-and-startup].
- "Next up" shows the lowest-numbered unprinted plate per build; a reprint plate with a
  higher number waits behind it. Whether reprints should jump ahead is the maintainer's call.
- The closed phone team switcher (a native select) still truncates long team names.

- Supabase performance advisor (informational, fine at launch scale): about 20 foreign keys to `user` without a covering index (add when user
  deletion or those joins get slow).
- README screenshots predate the new visual language, and the Integrations screenshot shows
  LAN options; the screenshot script was removed with the mock LAN printer [release-pwa].
- No e2e seam for link printers: the live-mock printer specs were removed; logic is covered
  by unit tests only [printers, e2e-playwright].
- `printers.host` only holds the placeholders `octoeverywhere` / `manual` now, and the
  `printers.kind` comment in `app.schema.ts` still lists `bambu-lan`; decide whether to drop or rename the column (a new migration now that the
  baseline is frozen) [kit-and-startup, printers].
- Team quotas (members, pending invites, teams per user) run inside Better Auth hooks outside
  our transactions: best-effort under concurrency. Acceptable for launch [app-shell].
- `pendingInvitationCount` loads every pending invitation per page (fine at launch scale).
- Audit unordered selects on composite-key tables for SQLite index-order assumptions.
- 390 px site header: "Try the demo" wraps to two lines [design-studio-ui].
- Privacy page: re-check the printer sentences (OctoEverywhere links only) and that Discord
  is named as a sign-in provider [app-shell].
- Agents in worktrees: a whole-folder `node_modules` symlink breaks `svelte-check`; use
  `npm ci` or per-package symlinks.

## Decisions (do not revisit without the maintainer)

- **Hosting:** one long-running Node container (not serverless: big uploads, SSE, a STEP
  worker), single instance. Live site: the maintainer's Unraid server pulling `:latest`,
  reached only through a Cloudflare Tunnel (`TRUST_CLOUDFLARE=1`). Fly.io and Railway are
  documented alternatives.
- **Database:** Postgres everywhere (Supabase in production, session pooler, `sslmode=require`;
  local Postgres 16 for dev and tests). Uploads on the `/data` volume; S3-style storage is
  not built.
- **Sign-in:** SSO only (Google, GitHub, Discord), verified-email linking only, no trusted
  providers, no passwords, no email sending. Invitations are copyable links.
- **Removed for good:** LAN printers, discovery, custom camera URLs, the SDCP camera-on
  command, Spoolman, the Unraid template, password reset, generic OIDC.
- **Printers:** OctoEverywhere shared links only (Elegoo, Klipper, OctoPrint), read-only,
  strict outbound guard; "not connected" printers for manual logging.
- **Limits:** 10 teams per user, 50 active builds per team, 95 MB per 3MF, 1 GB uploads per
  team; all env-configurable. Kit admin and print-geometry import: site admins only.
- **Demo:** anonymous throwaway workspace, server-created `isDemo` user, 24 h, per-IP,
  global and live caps, no uploads, printers, teams, invitations, sharing or export.
- **Gallery:** sharing a design = listing it in the site-wide gallery (no per-design public
  flag); built-in kits only; copies keep provenance; public author name only, never email or
  team; site admins can hide.
- **Analytics and cookies:** cookieless provider by env var (Plausible, Umami, Cloudflare),
  off when unset; the only cookies are the session and the demo session, so a notice, not a
  consent banner.
- **Product:** name stays TMT Build Tracker; groups are "teams"; the tracker leads, the
  design studio and gallery are a bonus; warm workshop visual language, real chair imagery.
- **Self-service account deletion** with typed confirmation; it removes the personal
  workspace and teams the user solely owns.
- **Repository:** hosted edition in its own repository (split 2026-11-19), `main` deployed
  directly, topic branches and pull requests; shared fixes cherry-picked with the sibling.
- Never re-orient parts in 3D; printers are read-only; MakeGood files are CC0 and never in
  git (see `CLAUDE.md` Ground rules).
