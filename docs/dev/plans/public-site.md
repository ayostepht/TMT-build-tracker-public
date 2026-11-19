# Public hosted site: plan and progress

Track: branch `claude/elegant-fermi-ea7mci` (started 2026-11-19). Separate from the self-hosted
0.9.x line on `edge`/`main`, which this work never touches. This file is the handoff for this
track: rewrite the "Progress" section in place as work lands.

## Goal

A public, hosted TMT Build Tracker that makers sign up for, instead of running their own
container. Three parts:

1. **Public home** (`/`): what the tracker is, who it is for, MakeGood credit, sign-in, try
   the demo.
2. **Demo sandbox** (`/demo`): each visitor gets a private, throwaway workspace seeded with a
   sample build. They can click through everything. Uploads are off, it is rate-limited,
   and it is deleted after 24 h. No account needed.
3. **The tracker** (signed-in): the existing app, minus everything that needs a local
   network.

## Decisions (2026-11-19)

| Topic             | Decision                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosting           | One long-running Node container (portable): Fly.io / Railway / Render, or the maintainer's own server behind a Cloudflare Tunnel (free, no open ports). Not serverless: the app streams large uploads, keeps SSE connections open and runs a background STEP → GLB worker.                                                                 |
| Database          | Postgres (Supabase managed Postgres in production; any Postgres 16 works; local Postgres for dev/test). Drizzle `pg-core`, fresh migration baseline in `drizzle/` for this track. The self-hosted SQLite migrations and release fixtures don't apply here.                                                                                 |
| Edge              | Cloudflare in front (DNS, TLS, CDN, WAF). Client IP from `CF-Connecting-IP` only when `TRUST_CLOUDFLARE=1`. Cloudflare's free plan caps request bodies at 100 MB, so the public 3MF limit defaults to 95 MB.                                                                                                                               |
| Sign-in           | SSO only via Better Auth social providers: Google, GitHub, Discord (each enabled when its client id/secret are set). No email/password, so no password resets and no email service. Invitations stay copyable links.                                                                                                                       |
| Removed           | Direct LAN printer connections (private addresses, Bambu LAN, LAN Elegoo, LAN probing), Spoolman, Unraid template, the password-reset CLI. A public server must not dial a maker's LAN (SSRF risk).                                                                                                                                        |
| Printers (kept)   | Automatic tracking through **OctoEverywhere shared links** (Elegoo, Klipper/Moonraker, OctoPrint): live status, camera, job-to-plate linking, with the existing strict outbound checks (public-address validation, pinned connections, message budgets). This is the public-mode printer policy that already exists, made the only policy. |
| Uploads           | 3MF and photo uploads stay, with public-mode caps. Files go to a storage adapter: local volume by default, S3-compatible (Supabase Storage, Cloudflare R2) when `S3_*` is set. Kit pack models stay baked into the image.                                                                                                                  |
| Live updates      | In-process SSE (single instance is enough for the expected 10-20 users). Scaling out later: Postgres LISTEN/NOTIFY fan-out.                                                                                                                                                                                                                |
| Analytics/cookies | Cookieless analytics (Plausible, Umami or Cloudflare Web Analytics, picked by env var, off when unset). The only cookie is the sign-in session (plus the demo session cookie), so there is a short cookie notice in the footer and privacy page, not a consent banner.                                                                     |
| Visual language   | Warm and workshop-like rather than generic SaaS: paper and ink neutrals, one warm accent, the existing Barlow Condensed / IBM Plex type, real chair imagery (the 3D model, plate diagrams), no gradient blobs, no emoji feature grids, no "trusted by" logos, plain sentences in the maker's voice. Light and dark. Mobile-first.          |

### More decisions (2026-11-19, before the overnight run)

- Name stays **TMT Build Tracker**. Groups are called **teams** everywhere (not "chapters").
- Kit admin (shared templates/kits) is limited to site admins (`SITE_ADMIN_EMAILS`).
- Self-service account deletion: an Account page button deletes the user, their personal workspace and any team they solely own, after a typed confirmation.
- Per-account limits, all env-configurable: 10 teams per user, 50 active builds per team, 95 MB per 3MF, 1 GB uploads per team.
- **Shared design gallery**: a team can share a color design to a site-wide gallery that any signed-in user can browse and copy into their own team (copies keep provenance). Built in wave 3 (`design-studio-ui` + server access checks), schema columns in the wave 1 baseline.

### Positioning and home visuals (2026-11-19, late)

- **Positioning:** the tracker is the product: planning the parts, tracking every part and plate from printed to assembled across a team, and the hand-off. Many TMT design tools already exist; the design studio and gallery are a bonus so everything lives under one roof. Public pages lead with tracking and organizing; colors/gallery come later and smaller.
- **Home visuals:** the hand-drawn SVG chairs are placeholders and get replaced. The hero shows the real MakeGood chair model, loaded lazily and turnable, with a still image as fallback. The colors section uses renders from the app's own viewer, credited to MakeGood (CC0). Plate and part visuals use the app's real components.

## Waves

Each wave's agents own disjoint files. Parallel agents in wave 1 get their own worktrees.
Wave 2 shares the branch checkout with strict file ownership. One integration pass and the
verifier close each wave.

1. **Foundations** (parallel)
   - `kit-and-startup`: Postgres schema (`pg-core`), driver, fresh migration baseline,
     async `getDb`/transactions, startup/seed/kit pack on Postgres, local Postgres
     dev/test helper.
   - `printers`: remove printers, camera, Spoolman and LAN features from code, routes, UI,
     unit tests and e2e specs.
   - `design-studio-ui`: visual language in `app.css`, public home at `/` (the signed-in
     root moves to `/workspace`), restyled terms/privacy/login, site header and footer.
2. **Async port** (parallel, shared checkout): every DB call becomes `await`, by area:
   `build-state`, `plates-3mf`, `design-studio-ui` (designs, studio, filaments), `app-shell`
   (auth, teams, access, account, routes). Then an integration pass until
   `check`/`lint`/`test`/`build` are green.
3. **Public features** (parallel)
   - `app-shell`: SSO-only sign-in (Google/GitHub/Discord), account deletion, demo sandbox
     (anonymous ephemeral workspace, seeded sample build, cleanup job).
   - `release-pwa`: Dockerfile, CI on Postgres, storage adapter (local/S3), analytics + CSP,
     Cloudflare client IP, deploy guide (Fly.io, Railway, self-host + Cloudflare Tunnel,
     Supabase), `.env.example`.
   - `design-studio-ui`: carry the visual language through the signed-in app.
4. **Gate**: `e2e-playwright` on Postgres, `verifier`, `security-reviewer`, fixes, docs.

## Progress

- 2026-11-19: plan written.
- Wave 1 merged (`cdc6a9a`):
  - Postgres foundation: pg-core schema, postgres-js driver, fresh baseline, async startup/seed/kit pack, template-database test harness, `scripts/dev-postgres.sh`, porting guide `docs/dev/plans/public-site-db-port.md`. Spoolman schema dropped; shared-gallery columns added on `color_designs`.
  - Printers through OctoEverywhere links only; LAN connections, discovery, custom camera URLs, the SDCP camera-on command and all Spoolman removed. Live-mock printer e2e specs were removed (logic stays covered by unit tests); a safe e2e seam is a follow-up.
  - Public home at `/` (`(site)` group), warm paper/ink visual language with a brick accent (AA-checked by `design-tokens.test.ts`), signed-in root at `/workspace`.
- Wave 2 merged (`83a330c`): every DB call is async Postgres (six area agents + one integration pass). Check, lint (typed `no-floating-promises`/`no-misused-promises` on server code), 1824 unit tests and build green; e2e runs on a Postgres `tmt_e2e` database reset by the webServer command (smoke specs green). Check-then-insert paths use advisory locks (per-build mutation lock, quota locks per scope, personal workspace, site admins, printer caps, org settings). Password reset (CLI and page) removed. Template filament roles now `ORDER BY key` (SQLite returned index order).
- Wave 3a merged: deploy (Dockerfile on Postgres, `deploy/` for Fly.io, Railway and Docker + Cloudflare Tunnel, `TRUST_CLOUDFLARE` client IP, cookieless analytics with an exact-origin CSP extension, `public-ci.yml`, `docs/guides/hosting.md`); shared design gallery (`/gallery`); SSO-only sign-in (Google, GitHub, Discord; verified-email linking only, no trusted providers) and the demo sandbox (`/demo`, server-created `isDemo` users, 24 h, per-IP/global/live caps, cleanup job, server-side `requireNotDemo` guards). Integration pass: quota defaults (10 teams per user, 50 builds per team, 1 GB uploads per team, 95 MB 3MF), self-host guides replaced by the hosting guide, full e2e green.
- Wave 3b merged: tracking-first home with the real MakeGood chair (lazy three.js, still images first, CC0 credit), "team" wording everywhere, gallery cards render the design on the chair, the per-design public flag retired (sharing = the gallery).
- Security review (2026-11-20): auth, access, linking, test sign-in seam, SSRF guard, CSP and secrets sound. Fixes on this branch: gallery (no sharing from a team's own kit copy, public author names only, sticky admin hide, share-event cap, scoped design list). Further hardening is held back until it can be coordinated with the self-hosted line (maintainer decision pending).

### Waiting on the maintainer

- Coordinated release of the held hardening (see the private note in the session).
- Real accounts: Supabase project, Google/GitHub/Discord OAuth apps, Cloudflare, Fly.io/Railway or self-host + Tunnel, analytics provider (all steps in `docs/guides/hosting.md`).
- Review the screenshots and the demo.
- Small UI choice: an "Allow sharing again" admin button for designs hidden from the gallery (API exists).

### Follow-ups noted

- Team quotas (`membersPerChapter`, `pendingInvitesPerChapter`, teams per user) run inside Better Auth hooks outside our transactions, so they are best-effort under concurrency. Acceptable for launch; atomic version would wrap Better Auth's inserts.
- Audit other unordered selects on composite-key tables for SQLite-index-order assumptions.
- Docs outside `docs/guides/` still describe the removed password-reset CLI (`docs/password-reset.md`, `docs/architecture.md`, STATUS).
- `README` screenshot script (`scripts/preview/readme-shots.mjs`) was removed with the mock LAN printer; rewrite against the new UI.

- 390 px site header: "Try the demo" wraps to two lines.
- Privacy page: update printer/Spoolman sentences (OctoEverywhere links only) and name Discord as a sign-in provider.
- `manifest.webmanifest` `start_url` is `/` (redirects signed-in users to `/workspace`; fine).
- Agents in worktrees: a whole-folder `node_modules` symlink breaks `svelte-check`; use per-package symlinks.
