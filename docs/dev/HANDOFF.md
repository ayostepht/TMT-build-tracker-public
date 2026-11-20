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

- `main` 828df84 is live (sixth deploy, `sha-828df84`, #12 to #26); the maintainer confirmed
  the site is much faster.
- Merged after the sixth deploy and waiting for the maintainer to pull: #27 (leave and
  delete teams) and #28 (kit layout first in the arranger).
- Sibling repository: the maintainer said the arranger change may be shared there; the plan is
  a pull request into its `edge` with the port (async to sync DB calls). Part-level printing
  is built there by its developer and ported here afterwards.
- No pull requests open here. The session's worktrees and the journey audit
  screenshots were session-local.
- Sibling repository: resource-limit back-port open there (`fix/resource-limits`); carry-overs
  in STATUS.
- Google Safe Browsing review of the domain requested; don't share widely until it clears.

## Next step

1. Ask what else they saw after the update: home page wheel, a link preview, a demo start,
   toasts and the assembly checklist on a phone.
2. Offer `DATABASE_PREPARE=on` as a try-and-see (about 2× on warm requests; remove it to
   undo), and the Supabase pool size check.
3. With the maintainer: Fly.io or not (where is the server relative to US East?), reprint
   priority in "Next up", the `member` unique index, off-site backups, repository settings.
4. Then: mutation speed (the view load inside the transaction), `docs/architecture.md`
   sections for tonight's changes (demo spares, pool lifecycle and shutdown, build view
   waves, toasts, `team-wording.ts`, `SocialMeta`), README screenshots.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer".
