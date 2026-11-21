# Orchestrator handoff

_Updated 2026-11-21. Rewrite in place; see "Handoff doc" in `CLAUDE.md`. Durable facts go to
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

- `sha-828df84` is live (sixth deploy, #12 to #26).
- Merged since and waiting for the maintainer to pull: #27 to #35 (list in STATUS). **#33
  adds migration `0002_piece_prints`**, the first since the site has users: additive, runs
  at container start. The maintainer takes a database backup right before pulling. After
  they confirm the update: log the seventh deploy in `docs/dev/CHANGELOG.md` and ask what
  they saw (24 plates equal to the kit, rims on one plate reading "per print", "Print some
  parts…", "Print some pieces…" on Harness and Straps, Members page leave and delete, their
  existing build unchanged).
- No pull requests open here. Worktrees and screenshots are session-local.
- Sibling repository: the arranger is merged there (its #92 and #94) and it has the piece
  prints (#93); its resource-limit back-port branch `fix/resource-limits` is still open.
  Not yet offered there: the keep-alive default and e2e read retry (#32), the test temp
  cleanup (#35), and the review notes in this repository's #33.
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
