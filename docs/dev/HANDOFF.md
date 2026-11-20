# Orchestrator handoff

_Updated 2026-11-20. Rewrite in place; see "Handoff doc" in `CLAUDE.md`. Durable facts go to
`docs/dev/STATUS.md`._

## Rules in force right now

- This repository was split from the self-hosted project on 2026-11-19. `main` is the live
  branch: every green push publishes the image the site pulls, so merging is deploying.
- **The site is live (first deploy 2026-11-19, image `sha-8eb3f1e`).** The baseline migration
  `drizzle/0000_baseline.sql` is applied to the live database and frozen: schema changes add
  `0001_…` and later.
- **Real users since 2026-11-20.** The maintainer has shared the site with a few makers, so
  the live database holds data that must survive every update. Schema changes are additive
  and backward-compatible (add columns and tables, with defaults; backfill in the migration;
  drop or rename only in a later migration after the code stops using the old shape). No
  migration that deletes or rewrites user rows without the maintainer's yes. Every pull
  request that adds a migration says so in its description, and before it merges the
  maintainer takes a `pg_dump` and the migration is rehearsed on a restored copy (deploy
  routine in `docs/dev/dev-environments.md`). Startup and seeding never overwrite
  user-owned rows. Stricter input checks never make existing stored values fail to load.
- Pull request and issue text: no internal process notes. Run `npx prettier --write` on edited
  docs before committing.

## State

- `main` at the evening batch (40b281b and later): #4, #7, #8, #9, #10, #11 merged
  2026-11-20, all green on `public-ci`, no migrations. The live server still runs the image
  from #6 (fourth deploy) until the maintainer pulls `:latest`.
- With that update the maintainer removes `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
  (Discord sign-in hidden: only its callback trips Chrome Safe Browsing) and adds
  `ANALYTICS_PROVIDER=cloudflare` + `CF_ANALYTICS_TOKEN`; optionally the Turnstile keys.
- No pull requests open. No agents running.
- Sibling repository: the resource-limit back-port is open there (`fix/resource-limits`);
  its developer lands it. Carry-overs listed in STATUS Open items.
- Google Safe Browsing review of the domain requested; don't share widely until it clears.

## Next step

1. After the maintainer updates: add the fifth deploy to `docs/dev/CHANGELOG.md`; check the
   log for boot warnings (analytics token, half-set Turnstile keys); if Turnstile keys were
   set, confirm a demo starts with the widget.
2. With the maintainer: nightly backup (`pg_dump` through a `postgres:17` container, kept
   off the server), repository settings.
3. STATUS open items, smallest first (picker edge fade, the timing test, `printers.host`).

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer".
