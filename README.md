# TMT Build Tracker

A web app for makers 3D-printing the MakeGood 3D TMT (toddler mobility trainer) chair. Teams plan, print, assemble and hand off builds together: parts and print plates, filament colors, print logs, a 3D color designer and a shared design gallery, 3MF export for your slicer, and optional read-only printer status. Makers sign in with Google, GitHub or Discord; a demo lets anyone try it without an account.

> **Status:** Pre-release, in public testing (see the [changelog](CHANGELOG.md) for the current version). Data formats are stable, but details may change before the first stable release. The Klipper and OctoPrint printer connections have not been run against real printers yet. See [Feedback and beta testing](#feedback-and-beta-testing) for how to help.

## Hosted version

The tracker's job is to plan and follow a build across a team: the parts, the print plates, what is printed and what is assembled, and the hand-off to the family. Alongside that it has a color design studio and a shared design gallery, so everything is under one roof.

This branch is the public, hosted flavor: one Node container plus a Postgres database (Supabase), Cloudflare in front, sign-in with Google, GitHub or Discord. Everything needed to run it is in the [hosting guide](docs/guides/hosting.md): creating the database and the sign-in apps, deploying to Fly.io, Railway or your own server through a Cloudflare Tunnel, backups and a security checklist. Expect roughly 5 USD a month for a small Fly.io or Railway machine (or nothing on a server you already run); the Supabase and Cloudflare free tiers are enough for a small site. Settings are listed in [`.env.example`](.env.example). Known gaps are listed in the guide, for example that the client address used for rate limits can be forged if the app is reachable without going through Cloudflare.

## Screenshots

![The color designer: a 3D toddler chair in navy and sky blue next to a list of color slots, each with its filament, part count and the weight it needs against your stock](docs/images/screenshot-color-designer.png)

Pick the filament for each color slot (primary, accent and so on) and see the chair in those colors. Each slot shows how much filament it needs and whether your stock covers it.

![The plate arranger: a top view of one print plate for a 256 by 256 mm bed with two numbered parts laid out flat, and the share of the bed used](docs/images/screenshot-plate-arranger.png)

The app lays the parts out flat on the plates for your printer's bed and shows how much of the bed is used. You can export a plate as a 3MF for your slicer.

![The Integrations page with Add a printer open: a short list of printer types on your network, through OctoEverywhere, or not connected, with an Experimental label on some, above the printer already added](docs/images/screenshot-integrations.png)

Optional: add a printer on the Integrations page (Elegoo, Klipper with Moonraker or OctoPrint through an OctoEverywhere shared link; OctoEverywhere is a separate remote-access service, not part of OctoPrint) to see its status, progress and temperatures next to each plate, or add one that is not connected to log prints by hand. The app only reads from printers; it never starts, stops, pauses or moves them.

<p align="center">
  <img src="docs/images/screenshot-where-printing.png" alt="A phone screen with the Where is it printing? dialog open over the plate list, offering the connected printer and Not on a connected printer, with a Mark as printing button" width="300">
</p>

When you start a plate, mark it Printing and say where it is printing. You start the print at the printer itself.

<p align="center">
  <img src="docs/images/screenshot-phone-print.png" alt="A phone screen showing the plate that is printing, with its filament, the printer's progress at 42 percent, layer 168 of 400 and the time left" width="300">
</p>

On your phone at the printer: the plate that is printing, how far along it is and when it should finish. When the plate is done, tap its status badge and choose Printed to mark its parts as printed, or flag a failure so they are queued for a reprint.

## MakeGood files and credit

The MakeGood 3D TMT 3D model and print files are by MakeGood, released as Creative Commons Public Domain (CC0); bundled as a kit pack. Find the design on [MakerWorld](https://makerworld.com/en/models/2066081-3d-toddler-mobility-trainer). One part is not MakeGood's: the experimental one-piece push handle is by jeepxj, under CC BY-NC (attribution, non-commercial), from [MakerWorld](https://makerworld.com/en/models/3409242-3d-toddler-mobility-trainer-one-piece-push-handle). The maker guide is not included: get it from MakeGood.

The git repository itself contains only data about the kit (part names, settings, plate groupings). The converted 3D model and print geometry ship separately as a versioned **kit pack** (a GitHub release asset, about 30 MB), which the Docker image downloads at build time and installs into the `/data` volume on first start, so the standard kit works with nothing to upload. See [docs/kit-pack.md](docs/kit-pack.md) for the format, the environment variables (`KITPACK_DIR`, `KITPACK_URL`, `KITPACK_DOWNLOAD=off`) and how a maintainer builds a pack. Files you import yourself in the kit admin always win over the pack.

## Run your own copy

The site is one Docker container, a Postgres database and a volume for uploads. The [hosting guide](docs/guides/hosting.md) walks through it from nothing: a Supabase database, the Google, GitHub or Discord sign-in apps, a session secret, Cloudflare, and running the container on Fly.io, Railway or your own server behind a Cloudflare Tunnel. Every setting is in [`.env.example`](.env.example) and the [environment reference](docs/guides/environment.md).

In production the server refuses to start until the essentials are in place: `DATABASE_URL`, a strong `BETTER_AUTH_SECRET`, an https `PUBLIC_URL`, at least one sign-in provider, `ADMIN_EMAILS` (the verified email of your own sign-in account, which makes you the site admin) and a trusted proxy (`TRUST_CLOUDFLARE=1` or `ADDRESS_HEADER`). Tables are created and the MakeGood kit is installed automatically at the first start. The health check is `GET /api/health` (`{"ok":true,"version":"<version>"}` when the database answers, status 503 otherwise).

**Images.** `docker pull ghcr.io/ayostepht/tmt-build-tracker:latest` needs no login. Tags: `latest` is the newest release; `X.Y.Z` and `X.Y` are specific releases (git tag `vX.Y.Z`); `edge` is the `edge` branch, where pull requests land first, for people who want to test unreleased changes and accept that it can break (back up the database first); `sha-<short commit>` is one exact build. You can also build from source with `docker build -t tmt-build-tracker .` (see [CONTRIBUTING.md](CONTRIBUTING.md)). If a pull fails with `unauthorized` or `denied`, an old `docker login ghcr.io` is the usual cause: run `docker logout ghcr.io` and pull again.

To try the app on your own computer without any of this, follow the development setup in [CONTRIBUTING.md](CONTRIBUTING.md).

## Guides

| Guide                                                             | What is in it                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Hosting](docs/guides/hosting.md)                                 | Supabase, sign-in apps, Fly.io, Railway or your own server with a Cloudflare Tunnel, limits, demo, backups, security checklist             |
| [Printers](docs/guides/printers.md)                               | Integrations page, Elegoo, Klipper (Moonraker) and OctoPrint through OctoEverywhere links, not-connected printers, what the app never does |
| [Environment reference](docs/guides/environment.md)               | Every variable, defaults, limits                                                                                                           |
| [Troubleshooting](docs/guides/troubleshooting.md)                 | Symptom, cause and fix                                                                                                                     |
| [Install on your phone](docs/guides/phone-install.md)             | Home screen, offline behaviour                                                                                                             |
| [Site admin: model and print geometry](docs/guides/site-admin.md) | Replacing the bundled 3D model, importing print geometry from the command line                                                             |
| [Export for your slicer](docs/guides/slicer-export.md)            | The 3MF export for Elegoo Slicer, OrcaSlicer, Bambu Studio and others                                                                      |
| [Changelog](CHANGELOG.md)                                         | What changed in each release                                                                                                               |

## Feedback and beta testing

This is a pre-release: your data and its formats are stable, but details may still change before the first stable release. The most useful feedback right now:

- Following the hosting guide on your own accounts, and telling us where the guide let you down.
- Klipper (Moonraker) and OctoPrint connections through OctoEverywhere, which are marked Experimental in the app because they have not been run against real printers yet.
- Using the app on phones other than an iPhone.

To report, use one of the issue forms on [GitHub](https://github.com/ayostepht/TMT-Build-Tracker/issues/new/choose): a [printer connection report](https://github.com/ayostepht/TMT-Build-Tracker/issues/new?template=printer-report.yml) (also welcome when everything worked), a bug report, install or docs feedback, or a feature request. Never paste an OctoEverywhere link, API key, access code or serial number. Security problems go through [SECURITY.md](SECURITY.md), not an issue.

## Development

Contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) (setup with Node 22, commands, conventions) and the code map [docs/architecture.md](https://github.com/ayostepht/TMT-Build-Tracker/blob/edge/docs/architecture.md) (on the `edge` branch). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).

### Filament data

Filament data from [SpoolmanDB](https://github.com/Donkie/SpoolmanDB), MIT licensed (see [THIRD_PARTY.md](THIRD_PARTY.md)). Refresh it with `npm run filaments:update` and commit the regenerated `src/lib/server/filaments/catalog.json`.
