# Orchestrator handoff

_Updated 2026-11-19. Rewrite in place; see "Handoff doc" in `CLAUDE.md`. Durable facts go to
`docs/dev/STATUS.md`._

## Rules in force right now

- This repository was split from the self-hosted project on 2026-11-19. `main` is the live
  branch: every green push publishes the image the site pulls, so merging is deploying.
- **The site is live (first deploy 2026-11-19, image `sha-8eb3f1e`).** The baseline migration
  `drizzle/0000_baseline.sql` is applied to the live database and frozen: schema changes add
  `0001_…` and later.
- Pull request and issue text: no internal process notes. Run `npx prettier --write` on edited
  docs before committing.

## State

- `main` 8eb3f1e: live. `public-ci` green, image published, running on the maintainer's server
  behind a Cloudflare Tunnel against Supabase; Google sign-in, home page and demo verified;
  Supabase lockdown verified on the real project.
- Pull request #1 `docs/hosted-repo`: rewrites the repository docs, agent files and package
  metadata for the hosted edition (this file included), plus the first-deploy record.
- Pull request #2 `fix/repo-links`: site links point at this repository, accurate comments,
  `preview:demo` works again on the guarded test sign-in.
- Both wait for the maintainer's review; merging either republishes the image.

## Next step

1. After #1 merges: one line in `docs/dev/dev-environments.md` for the new preview sign-in
   (port + 1 helper on 127.0.0.1, database `tmt_preview_test`), from #2.
2. STATUS open items: duplicate `organization.slug` index (new migration), team slug race
   (advisory lock like design slugs), `printers.host` placeholder column (decide; any change
   is a new migration now).
3. With the maintainer: analytics provider, backup schedule, repository settings.

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer" (analytics choice, backups, repository settings,
  gallery and demo choices, the sibling back-port).
