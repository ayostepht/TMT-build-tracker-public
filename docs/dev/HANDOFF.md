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

- `main`: live. #1 (docs for the hosted edition) and #2 (repository links, accurate comments,
  working `preview:demo`) merged 2026-11-19; each publishes a new `:latest`.
- #3 merged 2026-11-19 (`22f2b01`): migration `0001` (drops the duplicate `organization.slug`
  index) and team creation retries on a slug conflict. Deployed and applied 2026-11-19.
- Sibling repository: the resource-limit back-port is open there as a pull request into `edge`
  (`fix/resource-limits`); the self-hosted project's developer reviews and lands it.
- Google Safe Browsing flagged the new domain (false positive, likely because it is new and its
  main buttons are third-party sign-in); the maintainer requested a review in Search Console
  and filed a false-positive report. Don't share the site widely until it clears.

## Next step

1. STATUS open items: `printers.host` placeholder (needs a printers-side change before a
   migration can drop it), Turnstile on `/demo`, the gallery "Allow sharing again" button,
   `maxlength` on build text fields.
2. With the maintainer: analytics provider, backup schedule (script given in the session:
   nightly `pg_dump` through a `postgres:17` container), repository settings.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer" (analytics choice, backups, repository settings,
  gallery and demo choices, the sibling back-port).
