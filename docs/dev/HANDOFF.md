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

- Live: fifth deploy (`sha-2568f4e`), with Discord sign-in off and Cloudflare Web Analytics and
  Turnstile on (real widget verified).
- `main` ahead of live: #12 (strict Turnstile checks) and #13 (way back to the home page).
  No migrations. The maintainer pulls `:latest` once its `public-ci` run publishes.
- In progress: `app-shell` follow-up for signed-out guards (see STATUS open items), branch
  `fix/signed-out-guards`.
- Sibling repository: resource-limit back-port open there (`fix/resource-limits`); carry-overs
  in STATUS.
- Google Safe Browsing review of the domain requested; don't share widely until it clears.

## Next step

1. Tell the maintainer when `:latest` for `main` after #13 is published; after they update,
   log the sixth deploy and have them start and leave a demo once.
2. Land the signed-out guards follow-up (verifier, pull request, merge).
3. With the maintainer: nightly backup, repository settings.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer".
