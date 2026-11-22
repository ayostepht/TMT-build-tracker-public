# Changelog

Internal deploy history of the live hosted site, append-only, newest first. Public release
notes live in the root `CHANGELOG.md`, not here. Nobody needs to read this to work; current
behaviour is in `docs/architecture.md`, current state in `docs/dev/STATUS.md`. Add one entry
per deploy (2-4 lines: date, image `sha-<short>` and commit, what changed, migration yes/no,
anything to watch). Never put private values here (the domain, server details, Supabase
project).

The deploy history of the self-hosted edition (test copy deploys r1 to r59, before this
repository was split off on 2026-11-19) is in the sibling repository,
[ayostepht/TMT-Build-Tracker](https://github.com/ayostepht/TMT-Build-Tracker)
(`docs/dev/CHANGELOG.md` on its `edge` branch).

## 2026-11

- **Seventh deploy, confirmed 2026-11-22.** Image `latest` with the code of `main` 28aa7aa
  (#27 to #37: leave and delete teams, the kit layout first in the arranger, print some parts
  of a plate and some pieces of a part, keep-alive above the proxy's, logged pieces ticked and
  locked, converted plate logs keep their pieces). Migration: `0002_piece_prints` applied on
  start (additive). Found the same day on a phone: a tapped swatch in the color picker does
  not always recolor or save (fix in progress).
- **2026-11-20, sixth deploy.** Image `sha-828df84` (`main` 828df84: #12 to #26; strict
  Turnstile checks, way back to the home page, signed-out guards, hero wheel fix and link
  previews, first-time journey fixes, faster navigation and build loading, clean shutdown,
  tracking loop on a phone, touch targets, demo start from a ready-made spare). No migration.
  Maintainer: "so much faster now". Watch: demo start in the first minutes after a restart
  (slow path until a spare is ready); `DATABASE_PREPARE=on` not yet tried.
- **2026-11-20, fifth deploy.** Image `sha-2568f4e` (`main` 2568f4e: #4 dependency updates with
  the adapter-node `ORIGIN` fix, #7, #8, #9, #10, #11). No migration. Discord sign-in removed
  from the container env; Cloudflare Web Analytics and Turnstile keys added. First real
  Turnstile run: keys were swapped at first (the secret was served as the site key), secret
  rotated, then the check passed and a demo started. Found: client-side navigation to `/demo`
  kept the previous page's CSP, so the widget did not load (fixed in #13).
- **2026-11-19, fourth deploy.** Image from `main` f55391d (#6: the 3MF export follows the
  chosen MakeGood plate layout when its bed matches the printer; the fresh-arrangement note
  only when it can't). No migration. Maintainer checked an X1 / P1 / A1 export: looks right.
- **2026-11-19, third deploy.** Image from `main` 25a4000 (#5: color picker scrolls as one
  container; hover no longer shifts the swatch list). No migration. Maintainer confirmed the
  picker scrolls smoothly in a short window.
- **2026-11-19, second deploy.** Image from `main` aeab2bc (includes #1 docs, #2 repository
  links and working preview, #3 team slug retry). Migration: `0001_drop_duplicate_org_slug_index`
  applied on start; Supabase advisor confirms the duplicate index is gone. Nothing to watch.
- **2026-11-19, first deploy.** Image `sha-8eb3f1e` (`main` 8eb3f1e) on the maintainer's
  server behind a Cloudflare Tunnel, Supabase Postgres. Empty database: baseline migration,
  Supabase lockdown, seed and kit pack ran on first start; Google sign-in verified. Migration:
  baseline applied (frozen from now on). Watch: the first users' sign-ups and demo use.
