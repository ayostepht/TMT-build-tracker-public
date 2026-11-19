# Hosting the public site

This guide takes you from nothing to a running site at `https://tmt.example.com` (use your own
domain everywhere you see that name). You need no earlier experience with Supabase or
Cloudflare.

**What you are setting up**

- **One Node container** (this repository's `Dockerfile`). It serves the pages, streams uploads and keeps live updates open, so it must stay running: it is not a serverless app.
- **Supabase Postgres** for all data (accounts, teams, builds, designs).
- **A volume at `/data`** for uploaded files (photos, 3MF files, converted models). The kit pack with the MakeGood model is inside the image.
- **Cloudflare** in front: DNS, HTTPS, caching of static files and a basic firewall.
- **Sign-in with Google, GitHub or Discord.** There are no passwords and no email sending.

**Rough cost:** Fly.io or Railway about 5 USD a month for one small machine and a volume; or nothing extra on a server you already run. Supabase free tier and Cloudflare free plan are enough for a small site (see the pause caveat in step 1).

Steps 1 to 5 are the same for every hosting choice. Then pick one of the three paths in step 6.

## 1. Create the database (Supabase)

1. Sign up at supabase.com and choose **New project**.
2. Name it, pick a **region close to where the container will run** (a long distance between app and database makes every page slower), and set a strong **database password**. Save it in your password manager: you cannot read it again, only reset it.
3. Wait until the project says it is ready, then open **Connect** (top bar) or **Project Settings > Database**.
4. Copy the **Session pooler** connection string (port **5432**). It looks like `postgresql://postgres.<project>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`. The session pooler is the right choice for a server that stays running. Do not use the "transaction" pooler on port 6543 for this app, and prefer the pooler over the "direct connection" because the direct one needs IPv6 on many hosts.
5. Replace `[YOUR-PASSWORD]` with the real password (if it has special characters such as `@` or `/`, URL-encode them) and add `?sslmode=require` at the end:

   ```
   postgresql://postgres.<project>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
   ```

   This is your `DATABASE_URL`. Treat it as a secret.

6. The app creates its tables itself the first time it starts (migrations and seeding are safe to repeat and are locked, so two starts at once do not collide). You do not run SQL by hand.

**Backups.** The free tier has no point-in-time restore. Paid projects get daily backups, and point-in-time recovery is an add-on (Project Settings > Add-ons). Whatever your plan, also take your own dump, see [Backups](#backups).

**Free projects pause.** Supabase pauses free projects after about a week without activity, and the site then shows errors until you press **Restore project** in the dashboard. A site with real visitors keeps itself awake. To be safe, either move to the paid plan, or set up a free uptime monitor (for example UptimeRobot) that requests `https://tmt.example.com/api/health` every few minutes: that request touches the database.

## 2. Create the sign-in apps

Each provider gives you a **client ID** and a **client secret**. Create at least one. The **callback URL** you register must match your site address exactly, with `https` and no trailing slash:

| Provider | Callback URL                                        |
| -------- | --------------------------------------------------- |
| Google   | `https://tmt.example.com/api/auth/callback/google`  |
| GitHub   | `https://tmt.example.com/api/auth/callback/github`  |
| Discord  | `https://tmt.example.com/api/auth/callback/discord` |

Do this after you know your final domain. You can add `http://localhost:5173/api/auth/callback/<provider>` as a second callback for local testing.

**Google**

1. Open console.cloud.google.com and create a project (or pick one).
2. **APIs & Services > OAuth consent screen** (newer consoles call it **Google Auth Platform**): choose **External**, fill in app name and your support email. Under **Scopes** the basic ones are enough: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Publish the app to **In production** so anyone can sign in (in "Testing" only listed test users can).
3. **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**. Under **Authorized redirect URIs** add the Google callback from the table. Create.
4. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**GitHub**

1. github.com > your avatar > **Settings > Developer settings > OAuth Apps > New OAuth App** (for an organization: the organization's Settings > Developer settings).
2. Application name: your site name. Homepage URL: `https://tmt.example.com`. **Authorization callback URL**: the GitHub callback from the table. Register.
3. Copy the **Client ID**, then **Generate a new client secret** and copy it right away (shown once). They go into `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The app asks for the `read:user` and `user:email` scopes so it can read your verified email.

**Discord**

1. discord.com/developers/applications > **New Application**.
2. **OAuth2** page: under **Redirects** add the Discord callback from the table and save. Copy the **Client ID** and **Reset Secret** to reveal the client secret.
3. They go into `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. The scopes are `identify` and `email`.

## 3. Make the secrets and settings

Generate the session secret on any computer with OpenSSL (or any password generator that makes 64 hex characters):

```bash
openssl rand -hex 32
```

That is `BETTER_AUTH_SECRET`. Keep a copy in a password manager. If it changes, everyone is signed out. Printer secrets are derived from it too, so every saved OctoEverywhere printer link becomes unreadable and makers must re-add their printer links after a rotation (other data is not lost).

The settings you need, all described in [`.env.example`](../../.env.example):

| Setting                                | Value                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                         | The Supabase string from step 1                                             |
| `BETTER_AUTH_SECRET`                   | The 64-character secret                                                     |
| `PUBLIC_URL`                           | `https://tmt.example.com` (https, no trailing slash)                        |
| `ADMIN_EMAILS`                         | Your email, or several separated by commas. These people become site admins |
| Provider pairs                         | The client ID and secret of each sign-in app                                |
| `TRUST_CLOUDFLARE` or `ADDRESS_HEADER` | See step 6 and the [Security checklist](#security-checklist)                |
| `ANALYTICS_PROVIDER` and its settings  | Optional, see step 7                                                        |

The image already sets `NODE_ENV=production`, `DATA_DIR=/data`, `MAX_3MF_MB=95` and `BODY_SIZE_LIMIT=100M` (Cloudflare's free plan refuses request bodies over 100 MB, hence 95 MB for a 3MF file).

**What the server checks at start.** In production the container refuses to start, and lists every problem in its log, unless all of these hold:

- `BETTER_AUTH_SECRET` is set, at least 32 characters and not a placeholder.
- `PUBLIC_URL` is an `https://` address that is just the origin: no path, query, trailing slash, user name or password, and a real host name (not `localhost`, not an IP address).
- At least one sign-in provider is configured with **both** its client ID and secret. A provider with only one of the two is an error, not skipped.
- `ADMIN_EMAILS` lists at least one address. It must be the **verified** email of the admin's Google, GitHub or Discord account: only an email the provider says is verified ever becomes a site admin.
- A trusted proxy is named: `ADDRESS_HEADER` (a header your proxy sets and overwrites, with `XFF_DEPTH` when it is `X-Forwarded-For` behind more than one proxy) or `TRUST_CLOUDFLARE=1`.
- The old generic OIDC variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) are not set. Only Google, GitHub and Discord are supported.

**Limits.** Every account has limits so one account cannot use up the site. Each has a variable that takes a whole number (0 forbids the thing) or `off`; a malformed value stops the server at start.

| Variable                               | Default | What it limits                                                  |
| -------------------------------------- | ------- | --------------------------------------------------------------- |
| `QUOTA_CHAPTERS_PER_USER`              | 10      | Teams one person may create                                     |
| `QUOTA_MEMBERSHIPS_PER_USER`           | 10      | Teams one person may belong to                                  |
| `QUOTA_BUILDS_PER_WORKSPACE`           | 50      | Builds in one team (or personal workspace), drafts not counted  |
| `QUOTA_DRAFTS_PER_USER`                | 20      | Draft builds one person owns                                    |
| `QUOTA_UPLOAD_MB_PER_WORKSPACE`        | 1024    | MB of uploaded files (photos, 3MF files, snapshots) in one team |
| `QUOTA_UPLOAD_MB_PER_USER`             | 4096    | MB of uploads across all the teams one person owns              |
| `QUOTA_MEMBERS_PER_CHAPTER`            | 25      | Members of one team                                             |
| `QUOTA_PENDING_INVITES_PER_CHAPTER`    | 25      | Open invitations of one team                                    |
| `QUOTA_PHOTOS_PER_BUILD`               | 100     | Photos on one build                                             |
| `QUOTA_KIT_COPIES_PER_WORKSPACE`       | 2       | Kit copies in one team                                          |
| `QUOTA_CUSTOM_FILAMENTS_PER_WORKSPACE` | 50      | Custom filaments in one team                                    |
| `QUOTA_SAVED_DESIGNS_PER_USER`         | 50      | Saved color designs one person owns (gallery copies count)      |
| `QUOTA_STEP_CONVERSIONS_PER_USER`      | 1       | STEP model conversions running at once                          |
| `QUOTA_SSE_CONNECTIONS_PER_USER`       | 12      | Open live-update connections                                    |
| `QUOTA_CONCURRENT_UPLOADS_PER_USER`    | 2       | Uploads in flight at once                                       |
| `QUOTA_ACCOUNTS_TOTAL`                 | 500     | Accounts on the whole site                                      |
| `QUOTA_SIGNUPS_PER_DAY`                | 50      | New accounts per 24 hours                                       |
| `MAX_3MF_MB`                           | 95      | Largest 3MF file in MB (keep `BODY_SIZE_LIMIT` 1 MB above it)   |

**Demo.** The `/demo` page gives visitors a throwaway workspace with a sample build, without an account. A demo cannot upload files, add printers, create or join teams, invite people, share designs to the gallery or export data; it can browse the gallery and copy designs into the demo. Signing out deletes it at once, and it is deleted automatically after its lifetime.

| Variable               | Default | Meaning                                                   |
| ---------------------- | ------- | --------------------------------------------------------- |
| `DEMO_MAX_LIVE`        | 500     | Demos that may exist at once; `0` turns the demo off      |
| `DEMO_PER_IP_PER_HOUR` | 5       | New demos per visitor address per hour                    |
| `DEMO_TTL_HOURS`       | 24      | Hours until a demo and everything in it is deleted (1-72) |
| `DEMO_BUILDS`          | 2       | Builds one demo may hold (1-10)                           |

Put them only in your host's secret store (Fly secrets, Railway variables, a `.env` file with permissions `600` that is never committed). Never in the Dockerfile, a compose file you commit or a chat.

## 4. Your domain and Cloudflare

1. Add your domain to Cloudflare (dash.cloudflare.com > **Add a domain**, Free plan) and change the name servers at your registrar to the two Cloudflare gives you. Wait until Cloudflare shows the domain as **Active**.
2. **SSL/TLS > Overview**: set the mode to **Full (strict)**. Leave it never on "Flexible" (that sends traffic to your server unencrypted and can cause redirect loops).
3. **SSL/TLS > Edge Certificates**: turn on **Always Use HTTPS**.
4. DNS records are created in step 6, depending on where the container runs.

## 5. Cloudflare rules (once the site is up)

**Caching.** Cloudflare caches only static file types by default and never HTML, which is what you want. Add these two rules under **Caching > Cache Rules** anyway so the behavior is explicit:

- **Bypass cache** when the URI path starts with `/api/` (live updates, uploads and JSON must never be cached) and also when the request has a cookie (`http.cookie` contains `session`), so a signed-in page is never served to someone else.
- **Eligible for cache, Edge TTL: respect origin** when the URI path starts with `/_app/immutable/` (hashed build files that never change; the app already sends long cache headers for them).

Do not use "Cache Everything" on the whole site.

**Firewall basics (Security > WAF).**

- Turn on the **Cloudflare Managed Ruleset** if your plan offers it, and **Bot Fight Mode** (Security > Bots).
- Add a **rate limiting rule** (free plan allows one): path starts with `/api/auth/`, more than 20 requests per 10 seconds per IP, action **Block** for 10 seconds. The app has its own limits too.
- Optional: a custom rule to **Managed Challenge** requests from countries you never expect.

**Large uploads.** The free plan caps a request body at 100 MB. That is why a 3MF is limited to 95 MB. A paid plan allows more, then raise `MAX_3MF_MB` and `BODY_SIZE_LIMIT` together (the body limit must be at least 1 MB above the file limit).

## 6. Run the container

### Path A: Fly.io

Install the CLI (fly.io/docs/flyctl/install) and sign in with `fly auth login`. Fly asks for a card. Then, from the repository root:

```bash
# Pick your own unique app name and a region near your Supabase project.
fly launch --no-deploy --copy-config --config deploy/fly.toml --name tmt-yourname --region ams
fly volumes create tmt_data --size 3 --region ams --config deploy/fly.toml
fly secrets set --config deploy/fly.toml \
  DATABASE_URL='postgresql://...sslmode=require' \
  BETTER_AUTH_SECRET='<64 hex characters>' \
  ADMIN_EMAILS='you@example.com' \
  GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...'
fly deploy --config deploy/fly.toml
```

Edit `deploy/fly.toml` first: set `PUBLIC_URL` to your address. It keeps exactly one machine running (`auto_stop_machines = 'off'`), mounts the volume at `/data`, and checks `/api/health`. Do not scale to more than one machine: uploads live on its volume and live updates are held in memory.

Point your domain at it: `fly certs add tmt.example.com --config deploy/fly.toml`, then in Cloudflare DNS add the records `fly certs` tells you to. Both modes work:

- **Grey cloud (DNS only):** simplest. The app reads the real client address from `Fly-Client-IP` (already set in `fly.toml`), which cannot be forged. You do not get Cloudflare's cache and firewall.
- **Orange cloud (proxied):** Fly then sees Cloudflare's addresses, so replace `ADDRESS_HEADER` in `fly.toml` with `TRUST_CLOUDFLARE = '1'`. The risk: `tmt-yourname.fly.dev` stays reachable and anyone who finds it can send their own `CF-Connecting-IP`. Impact is limited to getting around per-IP rate limits, not account access; the mitigation is to leave it grey, or use Path C.

Update later with `git pull` and `fly deploy --config deploy/fly.toml`. Logs: `fly logs`. Fly volumes have daily snapshots (kept 5 days by default); see [Backups](#backups).

### Path B: Railway

1. railway.com > **New Project > Deploy from GitHub repo** and pick your fork of this repository (the Dockerfile and `deploy/railway.json` are detected; set the config path to `deploy/railway.json` under the service **Settings > Config-as-code**).
2. **Variables** tab: add the settings from step 3 (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `PUBLIC_URL`, `ADMIN_EMAILS`, provider keys). Railway's variables are its secret store.
3. **Settings > Volumes > New Volume**, mount path `/data`.
4. **Settings > Networking > Generate domain**, or add your custom domain and create the CNAME record Railway shows in Cloudflare DNS. Keep replicas at 1.
5. Client address: Railway's proxy puts the real client in `X-Forwarded-For`, so set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` (the right depth is the number of proxies in front; with Cloudflare proxied in front of Railway use `XFF_DEPTH=2`). If you proxy through Cloudflare and want its header instead, use `TRUST_CLOUDFLARE=1`, with the same caveat as Fly: the Railway-generated domain stays reachable directly, so anyone can forge the header there.
6. The health check `/api/health` comes from `railway.json`. Updates deploy on every push to the branch you connected. Railway volumes can be backed up from the volume's **Backups** tab on paid plans.

### Path C: your own server with a Cloudflare Tunnel (recommended for security)

A tunnel makes your server connect **out** to Cloudflare, so you open no port on your router and the container is reachable only through Cloudflare. That is exactly the condition `TRUST_CLOUDFLARE=1` needs, so this is the safest path. Works on any machine with Docker.

1. Cloudflare dashboard > **Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared**. Name it, and copy the **token** shown in the install command (the long string after `--token`).
2. In the same wizard under **Public hostname** add: subdomain `tmt`, your domain, service type **HTTP**, URL `app:3000` when you use the compose file below (use `localhost:3000` if you run the container with a published port and `cloudflared` on the host). Cloudflare creates the proxied DNS record itself.
3. On the server:

   ```bash
   git clone https://github.com/ayostepht/TMT-Build-Tracker.git
   cd TMT-Build-Tracker
   cp .env.example deploy/.env
   nano deploy/.env        # uncomment and fill in the settings from step 3, plus TUNNEL_TOKEN and TRUST_CLOUDFLARE=1
   chmod 600 deploy/.env
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs -f app
   ```

   The compose file has no published port: only the tunnel can reach the app. Data is in the `tmt-data` volume. If you prefer not to build locally, use a published image where the compose file has the `image:` line.

4. Open `https://tmt.example.com`. Update with `git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`.

Without Compose: create two containers by hand on the same Docker network, the app image with a volume or folder at `/data` (writable by uid `1000`) and `cloudflare/cloudflared` with `tunnel --no-autoupdate run` and the `TUNNEL_TOKEN` variable.

**Your own reverse proxy instead of the tunnel.** Publish the app's port only to the proxy (for example `127.0.0.1:3000:3000` in the compose file), terminate https at the proxy, and set `ADDRESS_HEADER=X-Forwarded-For` (with `XFF_DEPTH` set to the number of proxies in front). The proxy must overwrite `X-Forwarded-For`, pass `Host` and `X-Forwarded-Proto`, accept request bodies up to `BODY_SIZE_LIMIT` (Nginx: `client_max_body_size 100m;`), and not buffer the live-update stream (Nginx: `proxy_buffering off;` and `proxy_read_timeout 1h;`, at least for `/api/builds/*/events`; the app sends a keepalive every 25 seconds). Without that, changes from other people appear only after a reload.

Want to keep the database local instead of Supabase? Uncomment the `db` block in the compose file and use the `DATABASE_URL` described there.

## 7. Analytics (optional)

Analytics is off by default. Choose one with `ANALYTICS_PROVIDER`:

- `plausible`: set `PLAUSIBLE_DOMAIN=tmt.example.com` (the site you added in Plausible). For self-hosted Plausible also set `PLAUSIBLE_SCRIPT_URL` (it must serve the "manual" script).
- `umami`: set `UMAMI_WEBSITE_ID` and `UMAMI_SCRIPT_URL`.
- `cloudflare`: set `CF_ANALYTICS_TOKEN` (Cloudflare dashboard > Analytics & Logs > Web Analytics > add site > the token in the snippet). Because Cloudflare's beacon cannot hide ids, the app only runs it on pages without ids in the address.

All three are cookieless. Only the chosen provider's script is loaded and only its exact web address is added to the site's content security policy. Only page views are sent: no query strings, ids after `/builds/`, `/teams/`, `/designs/` and `/gallery/` become `:id`, and `/api/*` and invitation links are never reported. Visitors whose browsers send Do Not Track or Global Privacy Control are not tracked at all. The only cookies on the site are the sign-in session and the demo session, which is why the privacy page has a short notice and no consent banner.

## 8. First sign-in and checks

1. Open `https://tmt.example.com/api/health`: it should answer `ok`.
2. Open the site and sign in with a provider using an email in `ADMIN_EMAILS`. That account is the site admin: check that the admin pages appear. Do this yourself before announcing the site.
3. Make a team and a build from the MakeGood kit to confirm the model loads (the kit pack is in the image).
4. In your browser's developer tools check the response headers of the home page contain `content-security-policy` and `strict-transport-security`.

## Backups

- **Database:** Supabase paid plans keep daily backups. For your own copy, with `pg_dump` 16 or newer installed:

  ```bash
  pg_dump "$DATABASE_URL" --format=custom --no-owner --file="tmt-$(date +%F).dump"
  ```

  Restore into an empty database with `pg_restore --no-owner --dbname "$TARGET_URL" tmt-2026-01-01.dump`. Run it from cron or a scheduled workflow and store the file somewhere else (not on the same server).

- **Uploaded files** (`/data`): on Fly, `fly ssh console -C "tar czf - -C /data ." > data-$(date +%F).tgz`, or rely on volume snapshots (`fly volumes snapshots list`). With Docker Compose: `docker run --rm -v tmt-build-tracker_tmt-data:/data -v "$PWD":/out alpine tar czf /out/data-$(date +%F).tgz -C /data .` (the volume name starts with the compose project name, check with `docker volume ls`).
- Keep `BETTER_AUTH_SECRET` and the OAuth secrets in your password manager. A restored database with a different secret works but signs everyone out.

## Security checklist

- [ ] All secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, client secrets, `TUNNEL_TOKEN`) live only in the host's secret store, not in git, images or chat.
- [ ] `TRUST_CLOUDFLARE=1` only when the container cannot be reached except through Cloudflare (Tunnel, or a firewall allowing only [Cloudflare's published address ranges](https://www.cloudflare.com/ips/)). Otherwise anybody can invent their own client address with a `CF-Connecting-IP` header. The effect is limited to evading per-address rate limits (sign-in attempts, demo and write limits); it does not give anyone access to accounts or data. Without Cloudflare, use `ADDRESS_HEADER` for a header your own proxy overwrites.
- [ ] Cloudflare SSL mode is **Full (strict)** and Always Use HTTPS is on.
- [ ] The Supabase database password is strong and only in `DATABASE_URL`. Do not put the Supabase "service role" or "anon" keys anywhere: the app does not use them.
- [ ] `DATABASE_URL` for Supabase ends in `?sslmode=require`. The app logs a warning at boot when it does not.
- [ ] Supabase's automatic REST access is off for the app's tables: the app turns it off itself at startup (it revokes the `anon` and `authenticated` roles' access to them). Converting STEP models into the 3D view is limited to the site admin on the hosted site.
- [ ] The container runs as a normal user (it does) and only one replica runs.
- [ ] `ADMIN_EMAILS` lists only people you trust, and you signed in as the admin first.
- [ ] Rotate secrets when someone leaves or a secret may have leaked: reset the Supabase database password (then update `DATABASE_URL`), generate a new client secret at the provider, and change `BETTER_AUTH_SECRET` (signs everyone out and breaks saved printer links: makers re-add them).
- [ ] Turn on Supabase's and Cloudflare's account two-factor sign-in.
- [ ] You have restored a backup once, so you know it works.

**Known gaps.** The client address used for rate limits is only as trustworthy as the path to the app (see above). Anyone who can reach a sign-in provider can create an account, so the site is open to sign-up by design; per-account limits (teams, builds, upload size) keep one account from using everything.

## Troubleshooting

- **The container exits at start:** read its log. The app lists configuration problems (see "What the server checks at start" in step 3) and refuses to start rather than run unsafely.
- **"Cannot connect to database":** check the Session pooler string, `sslmode=require`, the password encoding, and that the Supabase project is not paused.
- **Sign-in returns to an error page:** the callback URL registered at the provider must match `PUBLIC_URL` character for character.
- **Every sign-in attempt returns 400:** `TRUST_CLOUDFLARE=1` is set but requests arrive without `CF-Connecting-IP` (not through Cloudflare), or `ADDRESS_HEADER` names a header your proxy does not send.
- **A big 3MF upload fails with 413 or a Cloudflare error:** the file is over the 95 MB limit.
