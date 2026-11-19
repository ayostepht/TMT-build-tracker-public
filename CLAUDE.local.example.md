# CLAUDE.local.md (template)

Copy to `CLAUDE.local.md` (gitignored) and fill in for this machine. Only private values
and machine facts go here; rules and workflow live in `CLAUDE.md` and
`docs/dev/dev-environments.md`. The maintainer keeps the canonical copy outside git: ask for
it instead of guessing. Cloud sessions have no `CLAUDE.local.md`.

## This machine

- Machine: <Mac | ...>
- Repo path: <...>
- Commit identity: <GITHUB_USER> <<NOREPLY_EMAIL>>
- Postgres: <how it runs here, port>. E2E lock: <flock path>. Docker: yes/no.
- Deploys from here: yes/no.

## Live site (never in git)

- Public address: <https://...>
- Server: <how to reach the Unraid server>, app container `<name>`, tunnel container `<name>`,
  Docker network `<name>`, appdata path for `/data`: <path>
- Image in use: `ghcr.io/ayostepht/tmt-build-tracker-public:<tag>`; previous for rollback: <sha tag>
- Supabase: project <ref>, region <region>; where the `DATABASE_URL` is kept (never the value)
- Backups: where database dumps and `/data` archives go, and the schedule

## Secrets (locations only, never values)

- `BETTER_AUTH_SECRET`, OAuth client secrets (Google, GitHub, Discord), `TUNNEL_TOKEN`,
  `DATABASE_URL`: <password manager entry names>
- GitHub token, Cloudflare and Supabase accounts: <where>

## Real-file tests

- `KITPACK_DIR=<dir>`, `TMT_SLICED_3MF=<file>`, `TMT_XPA_3MF=<file>`, MakeGood files: <path>

## Other

- Scratch awaiting the maintainer's OK to delete: <paths>
