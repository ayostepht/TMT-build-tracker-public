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

- `main` 48b585e is green and published as `sha-48b585e` / `:latest`: #14 to #22 (see STATUS
  "Where we are"). The maintainer updates the server by hand; nothing new is live until they
  pull.
- Open pull request: #23 phone touch targets (`ux/touch-targets`). Its unit job failed on
  "too many clients" in Postgres, not on its own change; re-run or re-push after the
  connection fix lands.
- Branches with work in progress, each in its own worktree in the cloud session:
  `fix/test-db-connections` (test pools close promptly, CI Postgres limit raised; lands
  first), `perf/demo-spares` (committed; full verification running; then two low fixes from
  the security review: re-check a spare before recycling it, and clean up spares when the
  pool is off or shrinks), `fix/stats-budget-test`.
- The journey audit and its screenshots were session-local; the findings are folded into the
  merged pull requests and STATUS open items.
- Sibling repository: resource-limit back-port open there (`fix/resource-limits`); carry-overs
  in STATUS.
- Google Safe Browsing review of the domain requested; don't share widely until it clears.

## Next step

1. Land `fix/test-db-connections`, then #23, then `perf/demo-spares`.
2. Tell the maintainer what to pull and what to check: home page wheel, a link preview, the
   speed of the team page and a build, a demo start, toasts and the assembly checklist on a
   phone; and offer `DATABASE_PREPARE=on` as a try-and-see.
3. With the maintainer: Fly.io or not (where is the server relative to US East?), reprint
   priority in "Next up", the `member` unique index, off-site backups, repository settings.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer".
