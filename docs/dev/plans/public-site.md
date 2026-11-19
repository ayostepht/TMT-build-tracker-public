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

| Topic             | Decision                                                                                                                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting           | One long-running Node container (portable): Fly.io / Railway / Render, or the maintainer's own server behind a Cloudflare Tunnel (free, no open ports). Not serverless: the app streams large uploads, keeps SSE connections open and runs a background STEP → GLB worker.                                                        |
| Database          | Postgres (Supabase managed Postgres in production; any Postgres 16 works; local Postgres for dev/test). Drizzle `pg-core`, fresh migration baseline in `drizzle/` for this track. The self-hosted SQLite migrations and release fixtures don't apply here.                                                                        |
| Edge              | Cloudflare in front (DNS, TLS, CDN, WAF). Client IP from `CF-Connecting-IP` only when `TRUST_CLOUDFLARE=1`. Cloudflare's free plan caps request bodies at 100 MB, so the public 3MF limit defaults to 95 MB.                                                                                                                      |
| Sign-in           | SSO only via Better Auth social providers: Google, GitHub, Discord (each enabled when its client id/secret are set). No email/password, so no password resets and no email service. Invitations stay copyable links.                                                                                                              |
| Removed           | Printer connections (Elegoo/Moonraker/OctoPrint/Bambu), camera proxy, Spoolman, LAN probing, Unraid template, the password-reset CLI. A browser on a public site can't reach a maker's LAN, and server-side LAN calls would be an SSRF risk.                                                                                      |
| Uploads           | 3MF and photo uploads stay, with public-mode caps. Files go to a storage adapter: local volume by default, S3-compatible (Supabase Storage, Cloudflare R2) when `S3_*` is set. Kit pack models stay baked into the image.                                                                                                         |
| Live updates      | In-process SSE (single instance is enough for the expected 10-20 users). Scaling out later: Postgres LISTEN/NOTIFY fan-out.                                                                                                                                                                                                       |
| Analytics/cookies | Cookieless analytics (Plausible, Umami or Cloudflare Web Analytics, picked by env var, off when unset). The only cookie is the sign-in session (plus the demo session cookie), so there is a short cookie notice in the footer and privacy page, not a consent banner.                                                            |
| Visual language   | Warm and workshop-like rather than generic SaaS: paper and ink neutrals, one warm accent, the existing Barlow Condensed / IBM Plex type, real chair imagery (the 3D model, plate diagrams), no gradient blobs, no emoji feature grids, no "trusted by" logos, plain sentences in the maker's voice. Light and dark. Mobile-first. |

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

- 2026-11-19: plan written; wave 1 dispatched.
