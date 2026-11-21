# Changelog

All notable changes to the hosted edition of TMT Build Tracker are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to follow [Semantic Versioning](https://semver.org/) once 1.0.0 is out.

The hosted site updates from `main`: database migrations run automatically when the new image starts. Operators: back up the database and `/data` before updating (see [Backups](docs/guides/hosting.md#backups)).

## [Unreleased] - hosted edition

The hosted edition starts from the self-hosted 0.9.2 release and turns it into a public website that makers sign up for instead of running their own container. Everything for building, tracking and designing a chair works as in 0.9.2; what follows is what differs.

### Added

- The server keeps idle connections open for 120 seconds (`KEEP_ALIVE_TIMEOUT`, `HEADERS_TIMEOUT`; Node's default is 5), longer than the Cloudflare Tunnel's 90 seconds, so a proxy no longer hits an occasional 502 from reusing a connection as the app closes it.

- Public home page: what the tracker is and who it is for, with the real MakeGood chair model you can turn, MakeGood credit, sign-in and a link to the demo.
- Demo: try the app without an account. Each visitor gets a private, throwaway workspace with a sample build, deleted after 24 hours (or at once when you sign out). Uploads, printers, teams, invitations, sharing and export are off in a demo.
- Shared design gallery: share a color design with every signed-in maker, browse what others shared, and copy a design into your own team with "Use this design". The gallery shows the design on the chair and the sharer's name, never an email or a team. Site admins can hide a design.
- Sign in with Google, GitHub or Discord.
- Delete your account yourself from the Account page, after typing your email to confirm.
- Per-account limits so one account cannot use up the site (by default 10 teams per person, 50 active builds per team, 1 GB of uploads per team, 95 MB per 3MF file), all configurable.
- Optional cookieless analytics (Plausible, Umami or Cloudflare Web Analytics): page views only, with ids removed, and nothing at all for browsers that send Do Not Track or Global Privacy Control.
- Site admins can let a hidden design be shared again, from a list of hidden designs on the gallery page or from the design itself. The author sees a short notice while a design is hidden.
- Optional Cloudflare Turnstile check before a demo starts (`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`), against bots filling the demo slots. Off unless both keys are set. The server checks the answer's action and hostname (`PUBLIC_URL`'s host, plus `TURNSTILE_HOSTNAMES`), and the demo page says so with a Reload button when the check can't load.
- A way back to the home page: the home page opens for signed-in visitors too, the app has a "Home page" link in the footer and account menu, the demo banner has "Leave the demo", and signing out lands on the home page. The installed app still opens on your builds.
- Link previews: sharing the site's address in Facebook, Messages, Discord or Slack shows a card with the chair, the name and a one-line description.
- Invitations: a "Share" button on phones, a way out when an invite is opened with the wrong account (sign out and use another; the invited address is shown masked), and a link to the team from an invite that was already used.
- Leave a team, or delete one, from its Members page. The only owner chooses who takes over before leaving; deleting asks for the team's name and lists what goes. Removing a member hands their builds and printers in that team to an owner.
- "Send feedback" in the footers opens a new issue on GitHub.
- Hosting guide and deploy files for Fly.io, Railway and your own server behind a Cloudflare Tunnel, with a Supabase database.
- Print some parts of a plate: if you split a plate in your slicer, use "Print some parts…" on the plate to mark (or log) only the parts that are on this print. They start as one print with one Undo and the rest stays To print. Now printing shows "3 of 4 parts" with their share of the grams and time, and with a printer connected "Where is it printing?" names the parts so the printer's job follows only them.
- Print some pieces of a part: a part made of several pieces (for example Harness and Straps, nine pieces on its own plate) has a "Print some pieces…" button, on the part row and on its plate when it is the only part left to print. Pick the pieces that are on this print and mark them as printing, or log them as a print. Now printing shows "3 of 9 pieces" with their names and their share of the grams and time (by piece count, marked approximate). A successful print ticks exactly those pieces, and the part becomes Printed when the last piece is ticked; a failed print ticks nothing and flags the part for reprint. Undo, editing or deleting such a log, ticking pieces by hand and "Take off printer" keep the ticks and the status in step. Not offered on plates that print more than once or one part per run, nor while another print of the part is on the printer.

### Changed

- Data is stored in Postgres (Supabase in production) instead of SQLite. A 0.9.x database cannot be moved over automatically.
- Printers connect only through OctoEverywhere shared links (Elegoo, Klipper with Moonraker, OctoPrint), or are added as "not connected" to log prints by hand. The server never connects to your home network.
- Chapters are called teams everywhere.
- A new look: warm paper and ink colors with one brick accent, in light and dark.
- Plates follow the kit's layout first (or your uploaded file's): a plate stays as the kit has it while its parts share a filament, a part that is alone on its plate stays alone, only parts whose filament no longer matches move, and brims count toward a part's space (for plates that are laid out new: the parts that move, a part that joins a plate and the plates added at the end; a kit plate that stays is placed as the kit authors it). A part that moves joins a kit plate of the same filament that already holds several parts when it fits without crowding it (at most 60% of the bed, the parts already there stay put); otherwise it gets a new plate at the end. A plate the kit prints several times with the same shape (the wheel rims) stays one plate and says how many times to print it, in which colors. Plates keep the kit's numbers. Builds you already have keep their plates until they are re-arranged. An arranged build that has not started printing is re-arranged by itself, as before, when its colors, variant or printer change, and now gets the kit's layout and numbers; a plate that keeps the same parts keeps the time and grams you typed for it, also when its number changes. A build that has started printing keeps its plates until you choose Re-arrange.
- Faster pages: the app runs far fewer database queries one after another (opening a build, the builds list, the team page and creating a build), keeps a few database connections warm, and shuts down within a second when asked. New optional settings `DATABASE_IDLE_TIMEOUT_S`, `DATABASE_WARM_CONNECTIONS` and `DATABASE_PREPARE` (see the environment guide).
- Tracking on a phone: one notification at a time with a larger Undo that stays 12 seconds; the whole assembly checklist row is tappable, and marking a step done while its parts are not printed asks first; the activity list shows a print's grams and note; "Now printing" and "Next up" come before the builds list on a team page.
- Larger tap targets on phones for pills, tabs, footer links and the setup wizard's options.
- "Finish setup" really finishes: the "Continue setup" banner no longer lingers.
- The demo's Start button is on the first screen on a phone, and starting a demo takes about a second: the server keeps a couple of ready-made demos waiting (`DEMO_SPARES`, default 2; 0 turns it off).
- Errors about teams say "team", not "organization".
- Text fields stop at the length the server accepts, so a long note is never refused on save.
- The color picker's controls take less room on desktop, so more colors show without scrolling.
- Sign-in wording names only the providers the site has switched on.
- The signed-in start page moved to `/workspace`; `/` is the public home page.
- Kit admin and print-geometry import are for site admins only.
- The client address used for rate limits comes from Cloudflare (`TRUST_CLOUDFLARE=1`) or from a header your own proxy sets; the server refuses to start in production without one.

### Fixed

- Replacing or re-arranging the plates of a build that has started no longer turns a "some pieces" print log into a log of the whole part: the log keeps its pieces, its place in the history and its link to the printer's job.
- The wheel rims plate (printed four times) now reads per print everywhere on the Files tab: grams and time of one print, then the totals, and its counter counts prints ("0/4 printed"). The TPU tires plate shows the grams of one print, not of both.
- The chair on the home page drew every alternative part at once, which showed as jagged patches of two colors on the wheels.
- Deleting the photo on screen in the photo viewer could leave keyboard focus nowhere after closing it.

### Removed

- Email and password sign-in, password reset and generic OIDC sign-in.
- Printers on your local network (Elegoo, Klipper, OctoPrint and Bambu Lab LAN connections), printer discovery, custom camera addresses and the command that switched an Elegoo camera on: the app now sends no printer command that changes anything.
- Spoolman.
- The Unraid template and the self-hosted install guides. To run the tracker on your own server, use the [self-hosted edition](https://github.com/ayostepht/TMT-Build-Tracker).

## Self-hosted history

The releases below are from the self-hosted project, [ayostepht/TMT-Build-Tracker](https://github.com/ayostepht/TMT-Build-Tracker), which this repository was split from. They describe the self-hosted edition (SQLite, Docker/Unraid, LAN printers, Spoolman) and are kept here for reference; their upgrade notes and links apply to that edition.

## [0.9.2] - 2026-11-16

**Upgrading:** back up your `/data` folder first. This release adds two database migrations (0001 and 0002, both additive: new columns for entered weights and spool adds). They run automatically when the container starts and cannot be undone, so to go back to 0.9.1 you restore the backup. See [Backup and upgrade](https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/backup-and-upgrade.md).

### Added

- Stats: a Stats tab on every build (printing time and filament used, progress with a projected finish, failures per plate, filament by colour against your stock, plate time against the estimate, hours per day) and a Stats page for the workspace (hours per week, printers, most-used filaments, plates that fail most, a table of builds, over the last 3, 6, 12 or 24 months). Every chart has a sentence that says what it shows and a "Show data" table.
- An optional one-piece push handle for printers with a bed of about 340 x 320 mm (Bambu H2S, H2D): choose "One piece, H2 series" under the push handle option. It is an experimental community design by jeepxj (CC BY-NC, endorsed by MakeGood) that replaces the push handle top, bottom, brace and pin and keeps the soft grip. It ships in kit pack 1.0.2, which installs by itself on the next start; builds you already have do not change.
- Lock part color: a part can keep its filament when you choose a palette. Turn on "Lock part color" in the part card; locked parts show a lock in the part list and the card. A locked part stays on its exact color: if the palette changes its slot, the part moves to a slot that holds its old filament (added for you when needed).
- Remove a color that parts still use: Remove is now on every color you added. A dialog lists the affected parts and asks which of the design's other filaments replaces it; confirming reassigns them and removes the color in one step, in builds and in Studio drafts. The color's spools on hand and Spoolman link are dropped with it, and the activity log says what changed.

- Enter a part's weight yourself: a part without a weight (the rear caster mounts, for example) now shows "Add weight" in the part list; the grams you type count in the plate, the log sheet and the filament totals and are marked "your entry". Weights now read the same everywhere: your entry, then the weight from your slice, then MakeGood's estimate (marked "~").
- Plate weights next to the time: every plate header (Print tab, Files tab, the printing and next-up cards) shows its grams beside its hours, marked "~" for an estimate, "from file" for a sliced 3MF, or "your entry" for grams you typed. A plate with parts that have no weight shows the known total as "≥ 417 g · 1 part without weight"; tap the flag to add the missing weights on the spot. The grams you type for a plate now survive re-arranging, and the field on the Files tab says "overrides file 150 g" when it replaces the file's number.

- Applying a design to a build that has started printing now asks first. A dialog says what has started ("Plate 4 is printing; 22 of 64 parts printed; 18 prints logged") and offers "Colors only" (recommended: slot colors change; plates, print files, progress, logs, spools and locked parts stay) or "Colors and print files" (also moves parts to the design's slots; plates will need re-arranging). The colors-only choice lists slots it leaves alone (another material, or locked parts) and slots that change filament but keep their spools or Spoolman link. It is on the Design tab, on a design's page ("Copy into my build") and when applying a palette. After applying you get an Undo for a while.

- Add spools as you go: each color keeps its starting spools (kg) and you can add another spool any time with a dated history (who added it, how many kg, an optional note, removable). The stock is the starting spools plus every add, and Spare is that stock minus what is used and what is still to print.
- Partial prints with per-part results: when a plate with several parts does not fully succeed, choose Partial and tick the parts that printed OK. Those are marked printed and count as kept; the rest are flagged for reprint and count as lost. Grams (Kept and Lost) and hours are split between them by the parts' weights, and one Undo removes both logs. A failed print's grams are filled in from the printer's progress, or from "How far did it get?" when no printer reported it.

### Changed

- Filament and time now tell used from lost: "used" is split into what ended up in printed parts and what failed prints took (older Partial logs count as lost), and logged hours the same way. The totals are unchanged for existing builds. After a Partial, only the parts still to print count toward what is left.
- The build header shows four Stats cards (parts printed, printing time, filament used, projected finish) on every build tab, each linking to the Stats tab. On phones they sit four across under the build name, with a short "of ~382 h" estimate line under Time and Filament. The build details line (what is printing, parts to reprint, the deliver-by date) appears only when there is something to show, and still opens from the arrow beside the name on phones. The Design tab keeps its room for the chair: no cards there on phones.
- Recent activity has its own Activity tab (after Finish, before Settings). The Overview now shows only the last change with an "All activity" link, so it stays lighter. Studio drafts have no Activity tab.
- Choosing a palette now resets every part-level color change: unlocked parts go back to their kit colors, as the Apply bar says ("Resets N part changes · M locked kept"). Applying a palette is one saved change in the activity log, and Undo restores the colors and the parts together.
- Filament picker: a new Type filter replaces the "All types" checkbox. It defaults to the standard types, shown as "95A" for TPU and "PETG", and lists each other type present with its count (TPU hardness such as 85A or 98A, foaming, silk, matte, carbon-filled, ...), plus "All types".

### Fixed

- Stats: the dates along the bottom of a chart no longer run into each other.
- Stats: the "Show data" tables, and the table of builds on the workspace Stats page, scroll sideways inside their own card on phones instead of widening the page.
- Stats: the failures chart now counts failed prints of single parts too (they appear under their plate, or under "Not on a plate"), so its rows add up to the failed prints.
- Stats: hours are rounded the same way everywhere (whole hours from 100 h logged), so the Stats tab and the build header show the same numbers.
- Applying a design (or a palette that resets part colors) to a build that was already printing no longer happens without a warning, and no longer rebuilds its plates. "Colors and print files" is refused while a plate is printing or a printer job is running, and now keeps parts whose color is locked. The confirmations on the Design tab and on a design's page no longer claim plates are kept when they are re-arranged.
- Filament used: a print that was marked done with a failed attempt logged and the successful one logged without grams counted only the failed grams; it now uses the estimate for the kept print too. Parts with no weight at all are listed as missing instead of counting as 0 g.
- Lock part color: it locks only the part you tapped, even with "Both sides" on (it used to lock the matching parts too, such as a wheel rim on a different color). A slot added for a locked part now reads "Accent PETG · added" instead of repeating the kit slot's name.
- Filament picker: the number next to each Type now matches the swatches the picker lists for it (same-looking colors count once, as they are listed once), and a short list no longer repeats itself under "Closest to the current color" or hides its neutrals.
- Design: on phones the MakeGood and handle credit sits in its own band under the 3D view instead of running over the chair.
- Files: choosing one of MakeGood's plate layouts right after arranging plates for your own bed could be ignored (no "Replace plates?" question, the list snapped back). The choice now always applies.
- Now printing: moving from one build to another inside the app (for example from the builds menu) could leave the card without its live printer panel (printer name, progress, layer, temperatures, camera, "Not this plate") until you left and reopened the build. The panel now follows the build you are on.

## [0.9.1] - 2026-11-13

A patch release of the 0.9 pre-release: fixes from the first days of public testing. No database changes; update as usual (take a backup first).

### Added

- When a plate still has an earlier print that was never logged (for example a failed one), linking a new print to it says so, with a button that opens that print's log.

### Fixed

- Logging a failed or partial print no longer takes a plate off "Now printing" when the plate is already printing again on a connected printer. Deleting, editing or undoing an older print log keeps it printing too.
- A plate's start time and time left come from the printer when it is printing on a connected printer, also when you choose Printing after the print started or link a new print over an earlier one that was never logged.
- The "Where is it printing?" sheet no longer scrolls sideways on a phone when the printer shows a long file name.
- Choosing one of MakeGood's built-in plate layouts (for example Bambu X1 / P1 / A1) now counts as choosing the bed: the setup wizard continues without a printer, the plate layout card names the bed the profile is for, and its export works. Arranging plates for your own bed still needs your printer.

## [0.9.0] - 2026-11-12

The first public version: a pre-release for public testing; 1.0.0 will follow. Data formats are stable, but details may still change before 1.0.0.

### Added

**Builds and chapters**

- Plan a MakeGood 3D TMT chair as a **build**: every part, the print plates, filament colors and progress in one place. A guided setup walks through the kit, options, colors, printer and export, and you can reopen it later.
- Build in a personal workspace ("My builds") or with a **chapter**: members with owner, editor and viewer roles, invitation links you copy and send yourself (the app sends no email), and live updates so everyone sees changes as they happen.
- Pick the chair's variants (seat, rear caster, footrest, rim) and accessories; an activity feed records who changed what, and logging a print, starting a plate and part status changes can be undone.
- **Studio** drafts: try colors and options, lay out plates and export without creating a build, then turn a draft into a build.
- A **Help** page (getting started, printing day, glossary, FAQ), an **About** page, and **Privacy** and **Terms** pages. The build guide from MakeGood is linked, not included.

**Color designer**

- A 3D view of the chair that you can orbit, with a swatch picker per color role (primary, accent, soft, tires).
- A bundled filament catalog (from SpoolmanDB, MIT) with PETG, PCTG and TPU colors, a few extra vendor colors, and your own custom filaments.
- Palettes and a palette generator, color locks, and per-part color choices.
- Save a color design and share it; the designs gallery lets anyone apply a design to a build or draft.

**Plates and slicer export**

- Automatic **plate arranging** for your printer's bed, with keep-out zones (for example a filament cutter) and a printer catalog with about 70 models and bed presets. Parts only ever rotate flat about the vertical axis: the app never tilts a part or changes which face is down. A part that does not fit flat is reported as oversize, with advice.
- **3MF export** for Elegoo Slicer and OrcaSlicer, Bambu Studio, or a plain 3MF for other slicers, with each part's filament and MakeGood's per-part settings. Open the file in your slicer and check the plates before you print. So far it has been opened in Elegoo Slicer only.
- Upload your own sliced 3MF to read plate print times and filament use, or enter times by hand. The app shows expected hours and compares your pace with them.

**Print tracking**

- Start a plate in one tap and log the finish in two from the landing page ("Now printing" and "Next up"); the Print tab holds the full plate list, per-plate history and a log sheet for runs, failures and reprints, each with grams of filament used.
- Edit or delete a log entry, and undo recent changes. Filament use is counted per color role.
- Totals for time and filament per build.

**Printers (read-only)**

- Show a printer's live status (state, progress, temperatures, file, filament) next to your builds, link a running print job to a plate, and view the printer's camera. Elegoo (SDCP, for example the Centauri Carbon), Klipper (Moonraker), OctoPrint and Bambu Lab in LAN mode are supported. The Elegoo connection is the one in regular use on a real printer (Centauri Carbon); Klipper, OctoPrint and Bambu Lab LAN are newer and the project has not yet run them against real printers, so please report problems in the [issue tracker](https://github.com/ayostepht/TMT-Build-Tracker/issues).
- Printers are added, edited and removed on the workspace's **Integrations** page (**Add a printer**), with short setup steps for each kind. A chapter's Printers tab shows their status.
- Elegoo, Klipper (Moonraker) and OctoPrint printers can connect through an OctoEverywhere shared link instead of a local address (for Elegoo this also spares the printer's few direct connections). Elegoo, on your network or through a link, is the one in regular use; Klipper and OctoPrint through a link are expected to work from OctoEverywhere's documentation but have not been confirmed against real printers.
- A **Not connected** printer: a name only, for logging prints by hand. The app never contacts it.
- A plate is started and logged from its status badge: **Where is it printing?** picks the printer (or none), and **Printed** logs the result.
- The app never moves, heats, pauses, stops or starts a printer and never sends it a file. The one command it sends is Elegoo's "camera on". See [Printers](https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/printers.md).
- Optional Spoolman link to show spool weight remaining and deduct filament. The Spoolman link is new and not yet proven against a real Spoolman install.

**Assembly and handoff**

- An assembly checklist, build photos, handoff details for the recipient, and a printable summary of the finished build.

**Installable phone app**

- Add it to your home screen on iPhone, Android or desktop. It opens full screen with its own icon, supports light and dark mode and phone safe areas, and shows an offline page and an "update available" message on https addresses. Builds, plates and progress are never stored or edited offline. See [Install on your phone](https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/phone-install.md).
- Pages are designed for a phone at the printer: large tap targets, form fields that do not make iOS zoom, and fresh data when you return to the app.

**Self-hosting and sign-in**

- One Docker container with one data folder; start it with an empty folder and it sets itself up. Images for x86-64 and arm64. Guides for Docker, Docker Compose and Unraid (with a template file), plus backups and upgrades.
- The MakeGood kit (3D model and print geometry, CC0, by MakeGood) installs automatically on first start. Site admins can import their own print geometry or replace the model.
- Sign in with email and password, or single sign-on through any OpenID Connect provider (Authentik is documented step by step). Choose who can sign up: anyone, invited people only, or nobody new.
- A hosted "public" mode with Google and GitHub sign-in only and built-in usage limits. Printers there connect through OctoEverywhere links or are not connected; local printer addresses, printer discovery and Spoolman are not available, and link printers are limited per workspace and per site (`QUOTA_LINK_PRINTERS_PER_WORKSPACE`, `QUOTA_LINK_PRINTERS_TOTAL`, `QUOTA_MANUAL_PRINTERS_PER_WORKSPACE`).
- Reverse-proxy support with a fixed public address (`PUBLIC_URL`), or none for plain LAN use; guides for Nginx Proxy Manager, Caddy and Traefik.
- Account page: export your data, delete your account, and (for site admins) hand over the role. Command-line password reset links for forgotten passwords.

### Security

- OctoEverywhere link connections are pinned: the server dials the exact address it validated, with the certificate checked for the link name. Every printer WebSocket refuses messages over 1 MiB, binary messages and compressed frames, and never follows redirects; a connection that breaks these rules is closed and retried slowly.
- Security headers and a content security policy, request size caps, sign-in rate limits, and permission checks on the server for every change.
- Printer and Spoolman addresses must be on private networks (the one exception is an OctoEverywhere shared link); redirects are never followed. Printer access codes, API keys and shared links are stored encrypted and never sent back to the browser or written to logs.
- Streaming uploads with zip-bomb protection, and per-user write rate limits and storage quotas in public mode.

### Known limits

- Sign-up is open by default on a self-hosted install, and the app sends no email, so email addresses are unverified. Keep it on your LAN or set `SIGNUP=invite` or `SIGNUP=closed` (see [Environment reference](https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/environment.md)).
- Live printer status over a full multi-day print is not yet proven: for a long print, check the printer itself.
- Behind a reverse proxy the sign-in rate limit relies on a client-address header; a client that can reach the container port directly could fake its address. See [Reverse proxy](https://github.com/ayostepht/TMT-Build-Tracker/blob/main/docs/guides/reverse-proxy.md#client-address-and-rate-limits).

## Before 1.0

There are no earlier public versions, so there is nothing to migrate from.
