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

- **2026-11-19, second deploy.** Image from `main` aeab2bc (includes #1 docs, #2 repository
  links and working preview, #3 team slug retry). Migration: `0001_drop_duplicate_org_slug_index`
  applied on start; Supabase advisor confirms the duplicate index is gone. Nothing to watch.
- **2026-11-19, first deploy.** Image `sha-8eb3f1e` (`main` 8eb3f1e) on the maintainer's
  server behind a Cloudflare Tunnel, Supabase Postgres. Empty database: baseline migration,
  Supabase lockdown, seed and kit pack ran on first start; Google sign-in verified. Migration:
  baseline applied (frozen from now on). Watch: the first users' sign-ups and demo use.
