# Orchestrator handoff

_Updated 2026-11-22. Rewrite in place; see "Handoff doc" in `CLAUDE.md`. Durable facts go to
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
- **Who merges where** (maintainer, 2026-11-21): each developer merges only in their own
  repository and opens pull requests in the other. This session merges here; in the
  self-hosted sibling it opens pull requests and that project's developer merges them. Pull
  requests the sibling's developer opens here are finished and merged from here.
- Pull request and issue text: no internal process notes. Run `npx prettier --write` on edited
  docs before committing.

## State

- Live: the code of `main` 28aa7aa (seventh deploy, confirmed 2026-11-22, #27 to #37,
  migration `0002_piece_prints` applied). Rollback image `sha-828df84`. Not yet asked: what
  the maintainer saw of the new plate and piece features.
- **#38 and #39 merged (916fcb8), published as `sha-916fcb8`, not yet confirmed as
  deployed.** #38 is the color picker fix reported from the live site on a phone; #39 its two
  review follow-ups (a `finally` around the save, the touch flag cleared on any key press).
  No migration. When the maintainer has pulled it: ask whether a tap on a swatch now always
  recolors and saves on the iPhone (the lost tap was not reproduced in Chromium; if it still
  happens, look for 429 responses on the filament update and the error line next to the
  picker), then log the eighth deploy.
- Sibling: the same fix with both follow-ups is its #98 into `edge` (branch
  `claude/elegant-fermi-ea7mci`; agent checks and `verifier` passed; its developer merges).
- No pull requests open here, and none open in the sibling from this project (its #92, #94
  and #96 are merged). Worktrees and screenshots are session-local.
- Sibling repository: the arranger is merged there (its #92 and #94) and it has the piece
  prints (#93); its resource-limit back-port branch `fix/resource-limits` is still open.
  Not yet offered there: the keep-alive default and e2e read retry (#32), the test temp
  cleanup (#35), and the review notes in this repository's #33.
- Google Safe Browsing review of the domain requested; don't share widely until it clears.

## Next step

1. Wait for the maintainer's word on #38 and #39 (above), then log the deploy.
2. Offer the sibling's developer, as pull requests into its `edge` (its developer merges):
   the keep-alive default and e2e read retry (#32) and the test temp cleanup (#35).
3. Small follow-ups in STATUS, each its own pull request: `printer-match.ts` uses the
   two-print grams for one rims print; a logged run's `partSlugs` are validated against the
   build, not the plate; a job's stored piece list is not trimmed by a hand tick; the H2D
   tires footprint in the kit data; `docs/architecture.md` sections for everything since
   #12 (none were written: arranger, plan cache, piece prints, pool lifecycle, demo spares,
   team exit, keep-alive).
4. With the maintainer: does "same filament" for a join mean the same role or the same
   colour and material; `DATABASE_PREPARE=on` as a try-and-see and the Supabase pool size;
   Fly.io or not; reprint priority in "Next up"; the `member` unique index (a migration);
   off-site backups and a restore test; repository settings.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer".
