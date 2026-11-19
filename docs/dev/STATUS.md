# Project status

_Last updated: 2026-11-19 (repository split from the self-hosted project; first deploy pending)._

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
- **Migrations:** one baseline, `drizzle/0000_baseline.sql`, applied to the live database on
  2026-11-19. **Frozen from now on:** schema changes add `0001_…` and later; never edit or
  regenerate the baseline.

## Waiting on the maintainer

- Choose an analytics provider (or leave it off) and set up the database backup schedule.
- Repository settings for the new repo: branch protection on `main` (required `public-ci`
  checks, no force push), private vulnerability reporting, the `ghcr.io` package visibility,
  Dependabot.
- Review the screenshots and the demo on the live site.
- Choices: an "Allow sharing again" admin button for designs hidden from the gallery (the
  API exists); Cloudflare Turnstile on `/demo` against slot-filling from many addresses;
  whether the service worker drops cached kit models on sign-out (shared devices).
- Sibling repository: the upload and export resource limits also apply to the self-hosted
  0.9.x line; back-port them there and cut a patch release (timing and tag are yours).

## Open items

- Supabase performance advisor (informational, fine at launch scale): duplicate unique index on
  `organization.slug` (`organization_slug_uidx` and `organization_slug_unique`, drop one in a
  new migration); about 20 foreign keys to `user` without a covering index (add when user
  deletion or those joins get slow).
- Team slugs (`teams.ts` `uniqueSlug`) have the same check-then-insert race the design slugs
  had; give it the same advisory lock.

- `preview:demo` (`scripts/preview-demo.mjs`, `scripts/preview/seed.mjs`) still signs up
  with email/password and runs with self-hosted settings; sign-up no longer exists, so the
  local preview needs porting (seed through the test sign-in or the demo) [app-shell].
- `startup.ts` header comment still says helpers are "synchronous until the async port
  lands"; they are async now [kit-and-startup].
- README screenshots predate the new visual language, and the Integrations screenshot shows
  LAN options; the screenshot script was removed with the mock LAN printer [release-pwa].
- No e2e seam for link printers: the live-mock printer specs were removed; logic is covered
  by unit tests only [printers, e2e-playwright].
- `printers.host` only holds the placeholders `octoeverywhere` / `manual` now, and the
  `printers.kind` comment in `app.schema.ts` still lists `bambu-lan`; decide before the
  decide whether to drop or rename the column (a new migration now that the baseline is frozen) [kit-and-startup, printers].
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
