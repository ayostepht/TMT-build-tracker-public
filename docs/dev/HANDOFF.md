# Orchestrator handoff

_Updated 2026-11-19. Rewrite in place; see "Handoff doc" in `CLAUDE.md`. Durable facts go to
`docs/dev/STATUS.md`._

## Rules in force right now

- This repository was split from the self-hosted project on 2026-11-19. `main` is the live
  branch: every green push publishes the image the site pulls, so merging is deploying.
- The baseline migration `drizzle/0000_baseline.sql` may still be regenerated: the first
  deploy has not happened. After it, only new migrations.
- Pull request and issue text: no internal process notes. Run `npx prettier --write` on edited
  docs before committing.

## State

- `main` 8eb3f1e: CI moved to `public-ci.yml` on `main`, self-hosted docker and promote
  workflows removed.
- `docs/hosted-repo`: rewrites the repository docs, agent files and package metadata for the
  hosted edition (this file included). Not yet committed or pushed.
- Deploy: Supabase project, the three OAuth apps and the Cloudflare Tunnel exist; waiting for
  the first `public-ci` run on this repository to publish
  `ghcr.io/ayostepht/tmt-build-tracker-public:latest`.

## Next step

1. Land `docs/hosted-repo` through a pull request into `main` (docs and metadata only).
2. Confirm the `public-ci` run on `main` is green and the image is published (check the
   package is pullable by the server).
3. With the maintainer: first deploy on Unraid per `docs/dev/dev-environments.md` ("Deploy"),
   then the checks in `docs/guides/hosting.md` §8. Record the date in STATUS and add the
   first entry to `docs/dev/CHANGELOG.md`.
4. Then the STATUS open items, starting with porting `preview:demo` and any schema clean-up
   that should land before the baseline freezes (`printers.host`).

## Questions waiting for the maintainer

- See STATUS "Waiting on the maintainer" (Supabase lockdown check, analytics choice, backups,
  repository settings, gallery and demo choices, the sibling back-port).
