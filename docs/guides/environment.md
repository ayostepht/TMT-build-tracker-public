# Environment reference

Every setting is an environment variable on the container (Fly secrets and `[env]`, Railway variables, or `deploy/.env` with Docker Compose). Empty optional variables behave as if unset. The image already sets `NODE_ENV=production`, `PORT=3000`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `KITPACK_DIR=/app/kitpacks`, `MAX_3MF_MB=95`, `BODY_SIZE_LIMIT=100M`, `KEEP_ALIVE_TIMEOUT=120` and `HEADERS_TIMEOUT=125`. The step-by-step setup is in [Hosting the public site](hosting.md); [`.env.example`](../../.env.example) lists the same variables with comments.

The server checks its configuration at start and refuses to start, listing every problem in the log, when something required is missing or malformed. Messages never contain a secret.

## Required in production

| Variable                               | Description                                                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | Postgres connection string, for example a Supabase session pooler string ending in `?sslmode=require`. Tables are created and updated at start.                                                                                                                        |
| `BETTER_AUTH_SECRET`                   | Signs sessions and encrypts stored printer links and keys. At least 32 characters, not a placeholder: `openssl rand -hex 32`. Changing it signs everyone out and means printer links must be entered again.                                                            |
| `PUBLIC_URL`                           | The address people use: `https://`, just the origin (no path, query or trailing slash), a real host name (not `localhost` or an IP address). Sign-in callbacks are built from it.                                                                                      |
| `ADMIN_EMAILS`                         | Comma-separated emails of site admins. Each must be the verified email of that person's Google, GitHub or Discord account: an unverified email never becomes a site admin.                                                                                             |
| Sign-in provider pairs                 | At least one of `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`. A provider with only one of its two values stops the server. Callback: `<PUBLIC_URL>/api/auth/callback/<provider>`. |
| `TRUST_CLOUDFLARE` or `ADDRESS_HEADER` | Where the client address comes from (used for rate limits). See below.                                                                                                                                                                                                 |

`OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are no longer supported: the server refuses to start while any of them is set. There are no passwords and no email sending.

## Client address and proxies

| Variable                         | Description                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRUST_CLOUDFLARE`               | `1` only when every request reaches the app through Cloudflare (a Cloudflare Tunnel, or a firewall that admits only Cloudflare's ranges). The client address is then `CF-Connecting-IP`, and a sign-in request without it is refused. If the app can also be reached directly, anyone can forge that header. |
| `ADDRESS_HEADER`, `XFF_DEPTH`    | The header your own proxy sets and overwrites (Fly: `Fly-Client-IP`; a generic proxy: `X-Forwarded-For`), and for `X-Forwarded-For` how many proxies to skip from the right (default 1). Ignored when `TRUST_CLOUDFLARE=1`. Set it only when all traffic reaches the app through that proxy.                 |
| `PROTOCOL_HEADER`, `HOST_HEADER` | adapter-node settings. `scripts/proxy-origin.mjs` sets them to `x-forwarded-proto` and `x-forwarded-host` and normalises those headers on every request. Leave them alone.                                                                                                                                   |
| `PORT`, `HOST`                   | Listen port and address. Default `3000` and `0.0.0.0` in the image.                                                                                                                                                                                                                                          |

## Storage and kit pack

| Variable                                         | Description                                                                                                                                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`                                       | Folder for uploaded files (photos, 3MF files, converted models, the installed kit pack). `/data` in the image: mount a volume there, writable by uid 1000.                                                                                          |
| `DATABASE_POOL_MAX`                              | Connections this server holds to Postgres (default 10, 1 to 100). Keep it low on a small Supabase plan.                                                                                                                                             |
| `DATABASE_IDLE_TIMEOUT_S`                        | Seconds an unused database connection stays open (default 600, 0 = never close). A new connection to a remote database costs several round trips, so idle ones are kept for a while.                                                                |
| `DATABASE_WARM_CONNECTIONS`                      | Connections opened at start and kept alive with a light query every 4 minutes (default 3, 0 = off, at most the pool size).                                                                                                                          |
| `DATABASE_PREPARE`                               | `on` reuses server-side prepared statements, which makes most queries one round trip instead of two. Off by default. Needs a direct connection or a session-mode pooler (Supabase port 5432); do not use it with a transaction pooler (port 6543).  |
| `KITPACK_DIR`, `KITPACK_URL`, `KITPACK_DOWNLOAD` | Kit pack location (default `/app/kitpacks` in the image), download URL pattern (`{slug}` `{version}` `{file}`) and `KITPACK_DOWNLOAD=off` to never download (the pack inside the image is used regardless). See [docs/kit-pack.md](../kit-pack.md). |
| `MIN_FREE_DISK_MB`                               | Free space to keep on the data volume; upload routes answer 507 below it. Whole number of MB or `off`. Default `2048`.                                                                                                                              |

## Upload and body limits

| Variable          | Description                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_3MF_MB`      | Largest 3MF in MB the Files tab and the kit drop zone accept. Default `95` (Cloudflare's free plan refuses request bodies over 100 MB). It is streamed to disk, parsed (only the small `Metadata/` entries are read) and deleted. |
| `BODY_SIZE_LIMIT` | Largest request body adapter-node accepts. The image sets `100M`. Must stay at least `MAX_3MF_MB` plus 1 MB; the server logs a warning at start if not. Raise both together if your proxy allows larger bodies.                   |

## Connection timeouts

| Variable             | Description                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEP_ALIVE_TIMEOUT` | Seconds the server keeps an idle keep-alive connection open. The image sets `120` (Node's default is 5). It must exceed the idle timeout of the proxy in front (`cloudflared` 90 s by default, Nginx upstream `keepalive_timeout` 60 s), otherwise the proxy now and then reuses a connection as the server closes it and the visitor sees a 502. |
| `HEADERS_TIMEOUT`    | Seconds the server waits for a request's headers. The image sets `125`. Keep it larger than `KEEP_ALIVE_TIMEOUT`. Whole non-negative numbers only; anything else stops the server at start.                                                                                                                                                       |

Idle connections are closed at once when the container is stopped, so the long timeout does not slow a restart.

On top of `BODY_SIZE_LIMIT` the app caps each route on its own: 1 MB for JSON and form posts, 9 MB for photos, 3 MB for guide pages, 2 MB for design snapshots, 200 MB for STEP zips and `MAX_3MF_MB` plus 1 MB for 3MF files, answered with 413 even for chunked bodies. Uploads are sent as the raw file body, so the server streams them to disk.

## Limits

Each limit takes a whole number (0 forbids the thing) or `off`; a malformed value stops the server at start. Over a limit the action is refused with a plain message. Defaults:

| Variable                               | Default | Limit                                                            |
| -------------------------------------- | ------- | ---------------------------------------------------------------- |
| `QUOTA_CHAPTERS_PER_USER`              | 10      | Teams one person may create                                      |
| `QUOTA_MEMBERSHIPS_PER_USER`           | 10      | Teams one person may belong to                                   |
| `QUOTA_BUILDS_PER_WORKSPACE`           | 50      | Builds in one team or personal workspace (drafts not counted)    |
| `QUOTA_DRAFTS_PER_USER`                | 20      | Draft builds one person owns                                     |
| `QUOTA_UPLOAD_MB_PER_WORKSPACE`        | 1024    | MB of uploaded files in one team or personal workspace           |
| `QUOTA_UPLOAD_MB_PER_USER`             | 4096    | MB of uploads across every workspace one person owns             |
| `QUOTA_MEMBERS_PER_CHAPTER`            | 25      | Members of one team                                              |
| `QUOTA_PENDING_INVITES_PER_CHAPTER`    | 25      | Open invitations of one team                                     |
| `QUOTA_PHOTOS_PER_BUILD`               | 100     | Photos on one build                                              |
| `QUOTA_KIT_COPIES_PER_WORKSPACE`       | 2       | Kit copies in one workspace                                      |
| `QUOTA_CUSTOM_FILAMENTS_PER_WORKSPACE` | 50      | Custom filaments in one workspace                                |
| `QUOTA_SAVED_DESIGNS_PER_USER`         | 50      | Saved color designs one person owns, gallery copies included     |
| `QUOTA_STEP_CONVERSIONS_PER_USER`      | 1       | STEP model conversions queued or running                         |
| `QUOTA_SSE_CONNECTIONS_PER_USER`       | 12      | Open live-update connections                                     |
| `QUOTA_CONCURRENT_UPLOADS_PER_USER`    | 2       | Uploads in flight at once                                        |
| `QUOTA_ACCOUNTS_TOTAL`                 | 500     | Accounts on the whole site                                       |
| `QUOTA_SIGNUPS_PER_DAY`                | 50      | New accounts per 24 hours                                        |
| `QUOTA_LINK_PRINTERS_PER_WORKSPACE`    | 3       | Printers connected through an OctoEverywhere link, per workspace |
| `QUOTA_LINK_PRINTERS_TOTAL`            | 200     | Link printers on the whole site                                  |
| `QUOTA_MANUAL_PRINTERS_PER_WORKSPACE`  | 10      | Not-connected printers per workspace                             |
| `WRITE_RATE_PER_MIN`                   | 120     | API writes per person per minute (refill; site admins exempt)    |
| `WRITE_RATE_BURST`                     | 60      | API writes allowed in a burst                                    |

## Demo

| Variable               | Default | Description                                                                                |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `DEMO_MAX_LIVE`        | 500     | Demos that may exist at once; `0` turns the demo off                                       |
| `DEMO_PER_IP_PER_HOUR` | 5       | New demos per visitor address per hour                                                     |
| `DEMO_TTL_HOURS`       | 24      | Hours until a demo and everything in it is deleted (1 to 72)                               |
| `DEMO_BUILDS`          | 2       | Builds one demo may hold (1 to 10)                                                         |
| `DEMO_SPARES`          | 2       | Ready-made demos kept in reserve so starting one is quick; `0` builds each demo on request |

Spare demos are made in the background after the server starts and replaced as visitors use them; they are recreated every few hours so the sample build's times stay fresh. They do not count toward `DEMO_MAX_LIVE` or the per-address limits until a visitor starts one, and the demo lifetime starts then.

## Analytics

Off unless `ANALYTICS_PROVIDER` is `plausible`, `umami` or `cloudflare`; see [Hosting, step 7](hosting.md#7-analytics-optional) for `PLAUSIBLE_DOMAIN`, `PLAUSIBLE_SCRIPT_URL`, `UMAMI_WEBSITE_ID`, `UMAMI_SCRIPT_URL` and `CF_ANALYTICS_TOKEN`.

## Printers and advanced

| Variable               | Description                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TMT_PRINTERS`         | `off` disables the background printer status connections (default on). See [Printers](printers.md).                                                                               |
| `TMT_ARRANGE_OPTIMIZE` | `off` makes the plate arranger use only its basic packer. A diagnostic switch for bug reports; leave unset.                                                                       |
| `TMT_GCODE_BUDGET_MS`  | Time budget in milliseconds for reading per-object statistics from the G-code of one uploaded 3MF (all its plates together). Default `240000` (4 minutes). Rarely needs changing. |
| `NODE_ENV`             | Set to `production` by the image. Only `development` or `test` relax the start-up checks; never set those on a real site.                                                         |
