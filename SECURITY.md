# Security policy

## Supported versions

This repository is the hosted edition. Only `main` (the `latest` image, which the public site runs) receives security fixes. Before reporting, check that the problem is still present on `main`.

The self-hosted edition, [ayostepht/TMT-Build-Tracker](https://github.com/ayostepht/TMT-Build-Tracker), shares much of its code with this one. If a problem is in shared code (uploads and their limits, 3MF and STEP handling, exports, access checks), say so in your report: the fix is coordinated between the two repositories and nothing is published until both are fixed. Problems that only affect the self-hosted edition are reported in that repository.

## Reporting a vulnerability

Please report privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** (GitHub's private vulnerability reporting). Do not open a public issue or pull request for a security problem.

Include what you found, the steps to reproduce it, the commit or image tag, and how you run the app (Fly.io, Railway or your own Docker host; Cloudflare Tunnel, Cloudflare proxy or your own reverse proxy; `TRUST_CLOUDFLARE` or `ADDRESS_HEADER`). Never include real secrets, access codes or other people's data in a report.

This is a volunteer project: expect an acknowledgement within a few days and a fix or a decision as soon as the maintainer can manage. Please give a reasonable time to fix a problem before you publish it.

## What is in scope

- Sign-in (Google, GitHub, Discord), sessions, accounts, teams, invitations, the demo sandbox and the roles owner, editor and viewer: getting access you should not have, acting as someone else, changing another team's data, or doing from a demo what a demo is refused.
- The HTTP API and uploads: missing permission checks, path traversal, unsafe file handling, request smuggling or limits that can be bypassed to exhaust the server.
- Printer and camera connections: reaching addresses the app should refuse (the only outbound destination for printers is an OctoEverywhere shared-link host that resolves to public addresses), leaking printer access codes, API keys or shared links, or making the app send any printer command (it only reads status and sends no write command at all).
- The shared design gallery and analytics: leaking an email, a team or private design data, or sending analytics more than the documented page views.
- The Docker image and its startup: secrets or personal data in the image, unsafe defaults, the Supabase lockdown not applying.

## Out of scope and known gaps

These are documented limits, not new findings:

- **Open sign-up.** Anyone with a Google, GitHub or Discord account can create an account; that is the purpose of the site. Per-account limits and a site-wide account cap (`QUOTA_*`, see [docs/guides/environment.md](docs/guides/environment.md#limits)) bound what one account can use.
- **The client address is only as trustworthy as the path to the app.** Rate limits use `CF-Connecting-IP` (`TRUST_CLOUDFLARE=1`) or the header named by `ADDRESS_HEADER`. If the app can be reached without going through that proxy, a client can choose its own address and evade per-address limits (not gain access). See the security checklist in [docs/guides/hosting.md](docs/guides/hosting.md#security-checklist).
- **Printer and link peers can still cost some resources.** OctoEverywhere link connections validate the link name (every answer must be a public address) and then dial that exact address (the connection is pinned, with the certificate checked for the link name), and a printer or link peer cannot make the server read a message larger than 1 MiB: bigger messages, binary messages and compressed frames close the connection, and the printer then shows an error and is retried slowly. A hostile link can still cost a few MiB of memory and some CPU per connection, bounded by per-connection message and byte budgets and a reconnect backoff of at least 10 s.
- **The same OctoEverywhere link can be added in more than one workspace** on a hosted site. The number of link printers is bounded by the site-wide cap (`QUOTA_LINK_PRINTERS_TOTAL`).
- **Rate limits are kept in memory per process.** They reset when the server restarts, and are not shared between several instances.
- Problems that need access to the host, the database, the data folder or the `BETTER_AUTH_SECRET`, an outdated or modified install, or a browser or proxy you configured without the documented headers.
- Denial of service by an authenticated user within the configured limits (see [docs/guides/environment.md](docs/guides/environment.md#limits)).
- Reports from automated scanners without a demonstrated impact.

## Hardening checklist for operators

Follow the security checklist in [docs/guides/hosting.md](docs/guides/hosting.md#security-checklist): secrets only in the host's secret store, a strong `BETTER_AUTH_SECRET`, `TRUST_CLOUDFLARE=1` only when the app is reachable through Cloudflare alone (otherwise `ADDRESS_HEADER` for a header your own proxy overwrites), only trusted people in `ADMIN_EMAILS`, regular database and `/data` backups, and the latest image.
