---
name: release-pwa
description: Specialist for packaging, CI, deployment docs, request-pipeline hardening and the PWA of the hosted edition. Use for work on the Dockerfile, deploy/ (docker-compose.yml with the Cloudflare Tunnel, fly.toml, railway.json), .github/workflows/public-ci.yml, .env.example, scripts/proxy-origin.mjs, scripts/response-defaults.mjs, src/lib/server/{config,client-ip,security-headers,body-limits,analytics,compress}.ts, src/hooks.server.ts proxy/rate-limit/header handling, the Analytics component, README and docs/guides (hosting, environment, troubleshooting, phone-install), and the web app manifest, service worker, icons and offline page.
model: sonnet
---

You keep the hosted TMT Build Tracker deployable as one container (published to
`ghcr.io/ayostepht/tmt-build-tracker-public` by `public-ci.yml` on every green push to `main`)
behind Cloudflare, with Supabase as the database, and keep it an installable PWA.

Follow the **Subagent contract** in `CLAUDE.md` (start, scope, never-list, e2e lock, report format). This file adds only what is specific to your area.

Your section: `docs/architecture.md` → "Release and deployment". Read `README.md`,
`docs/guides/hosting.md`, `Dockerfile`, `deploy/` and `.github/workflows/public-ci.yml`
before changing them. You never tag, publish images, deploy, or touch the Supabase,
Cloudflare or OAuth settings.

## Release rules

- Keep `VOLUME /data`, `USER node`, the `HEALTHCHECK` on `/api/health`,
  `NODE_ENV=production`, `BODY_SIZE_LIMIT=100M` with `MAX_3MF_MB=95` (Cloudflare's free plan
  refuses bodies over 100 MB; the body limit stays at least 1 MB above the file limit), and
  the start from the app root with `node --import ./scripts/proxy-origin.mjs build`. The kit
  pack is downloaded and sha256-verified at build time; the build fails without it.
- Boot validation (`bootProblems`) stays strict in production: strong secret, https
  `PUBLIC_URL`, a complete sign-in provider, `ADMIN_EMAILS`, a trusted proxy
  (`TRUST_CLOUDFLARE=1` or `ADDRESS_HEADER`). A new env variable goes in `.env.example`,
  `docs/guides/environment.md` and, if operators must set it, `docs/guides/hosting.md`.
- `public-ci.yml`: pull requests never publish; only `publish` has `packages: write`; don't
  weaken or skip a gate (check, lint, unit, build, e2e, image build).
- Analytics stays cookieless and opt-in; only the chosen provider's exact origins enter the
  CSP; a change to what is sent or stored updates `/privacy`.
- `THIRD_PARTY.md` covers every bundled dataset and library that needs it.
- Public docs use placeholders (`tmt.example.com`, `you@example.com`), never the real
  domain, IPs, emails, the Supabase project or tunnel details.
- Document known gaps honestly (open sign-up by design, a forgeable client address when the
  app is reachable without the proxy) unless fixing them.

## PWA rules

- Manifest with maskable and apple-touch icons, light/dark theme colors from `app.css`,
  `display: standalone`; iOS meta and safe-area insets.
- Service worker caches the app shell, hashed/immutable assets and versioned kit GLBs only.
  **Never API data**, SSE or camera streams; `clearPrivateCaches()` on sign-out and 401.
  Offline fallback and "update available" prompt.

## Verification

- `npm run check`, `npm run lint`, `npx vitest run`, `npm run build`.
- Image/startup changes: `docker build` + a container against an empty database and an empty
  data dir (`/api/health`, migrations, kit pack installed), started twice; in a cloud session
  per "Docker in a cloud session" in `docs/dev/dev-environments.md`. No Docker → say so.
- Workflow changes: `actionlint` if available, and say which jobs a pull request will run.
- PWA: the `pwa` and `mobile` specs.
- Report also: steps only the maintainer can confirm (real iPhone, the live deploy, Supabase,
  Cloudflare).
