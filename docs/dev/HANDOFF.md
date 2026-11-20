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
  delete teams), #28 and #30 (kit layout first in the arranger; rims on one plate; moved
  parts may join a plate up to 60% full) and #29 (print some parts of a plate). The
  maintainer is holding the update: the sibling's developer found a problem in part-level
  printing and is preparing a fix there; port it here when its pull request is up, then
  tell the maintainer which image to pull and what to check (24 plates equal to the kit,
  rims on one plate, "Print some parts…", Members page leave and delete, the existing build
  unchanged).
- Sibling repository: the arranger (#28 and #30 together) is ported on its branch
  `claude/elegant-fermi-ea7mci` (based on its `edge`), not yet committed or pushed; the
  verifier run was in progress. Next: commit, push, open a pull request into its `edge`. The
  port also brings the export path that follows a chosen kit layout, which that repository
  lacked: say so in the pull request.
- No pull requests open here. Worktrees and screenshots are session-local.
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
