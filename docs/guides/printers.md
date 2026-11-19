# Printers

Printers are optional. Adding one shows its live status (state, progress, temperatures, file name, filament when the printer reports it) next to your builds, can link a print job to a plate, and can show the camera. You add, edit and remove printers on your workspace's **Integrations** page: choose **Add a printer**, pick how the printer is reached, and follow the short steps shown there. A team's **Printers** tab shows the status of the printers that are already set up.

## How the site reaches a printer

The site runs on the internet, so it cannot see your home network: a printer address like `192.168.0.50` means nothing to it. Two kinds of printer work:

- **Through an OctoEverywhere shared link.** OctoEverywhere carries the connection from your printer to the internet, and the site connects to the link. Elegoo (SDCP), Klipper (Moonraker) and OctoPrint printers can be added this way.
- **Not connected.** A name only, for logging prints by hand. The site never contacts it.

OctoEverywhere and OctoPrint are different things with similar names. OctoEverywhere is a separate remote-access service, not part of OctoPrint. It works with several kinds of printers (OctoPrint, Klipper and Elegoo among them) through a plugin or companion that runs on the printer side. A "shared connection" is a link OctoEverywhere gives you that reaches that printer's own web interface from anywhere. How to create one is described in OctoEverywhere's own documentation.

Bambu Lab printers in LAN mode need a direct connection on your own network, so they cannot be connected. Add them as **not connected**.

## What works how well

- **In regular use on a real printer:** Elegoo through an OctoEverywhere link (Centauri Carbon).
- **Not yet run against real printers by the project:** Klipper and OctoPrint through an OctoEverywhere link. That the link carries everything they need (Moonraker's WebSocket, OctoPrint's status requests and the camera) is expected from OctoEverywhere's documentation but has not been checked.

If you try one of these, please report what worked and what did not in the [issue tracker](https://github.com/ayostepht/TMT-Build-Tracker/issues).

## The app is read-only towards your printers

The app reads status. It never moves, heats, pauses, stops or starts anything, and it never sends a file to a printer. The only messages it sends, per printer type:

| Printer type        | What the app sends                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Elegoo (SDCP)       | Status refresh (Cmd 0) and attributes refresh (Cmd 1), both with empty data, and one command, Cmd 386 `{"Enable":1}`: camera on. |
| Klipper (Moonraker) | A `printer.objects.subscribe` request and `server.info`: both only read.                                                         |
| OctoPrint           | HTTP `GET` requests (`/api/job`, `/api/printer`) with your API key.                                                              |
| Not connected       | Nothing. The app never contacts it.                                                                                              |

The camera-on command is sent only to an Elegoo printer. These rules are enforced in code (`src/lib/server/printers/adapters/`); the Elegoo adapter refuses to build any other command.

Starting a plate in the app (the plate's status badge, then **Where is it printing?**) only tells the app which printer to follow and starts the clock. You start the print at the printer itself.

## The shared link

- The link must look like `https://shared-<token>.octoeverywhere.com` (https, no port, path or query). Anything else is refused.
- The link is a secret: anyone holding it can reach the printer through OctoEverywhere. It is stored encrypted, never returned to the browser or written to logs, and never shown again; the form offers **Remove link**.
- The server connects only to the address it checked (the name must resolve to public addresses only), never follows redirects, and drops the connection if the printer side sends a message over 1 MiB or too much data per second. An OctoEverywhere link is the only outside address the app connects to for printers.

## Elegoo (SDCP)

Centauri Carbon and other printers that speak SDCP.

### Through an OctoEverywhere shared link

On the **Integrations** page choose **Add a printer**, then **OctoEverywhere link**, pick Elegoo and paste the **shared link**. No address, port or camera address is needed. Status uses the link's WebSocket (`wss://shared-<token>.octoeverywhere.com/websocket`) and the camera is the stream at `/video` on the same host; the app sends the one camera-on command (Cmd 386) before reading it.

The printer allows only a few simultaneous connections (about five on the Centauri Carbon; observed, not from Elegoo's documentation). The link uses OctoEverywhere's existing connection, not one of the printer's own.

## Klipper (Moonraker)

Not yet run against a real printer by the project.

### Klipper (Moonraker) through an OctoEverywhere shared link

You need Klipper with OctoEverywhere's companion installed and linked to your OctoEverywhere account, and a shared connection created there. Choose **Add a printer**, then **OctoEverywhere link**, pick Klipper and paste the **shared link**. Status uses the link's Moonraker WebSocket and the camera comes from the webcam list Moonraker reports. Leave the API key empty unless Moonraker requires one.

## OctoPrint

Not yet run against a real printer by the project.

### OctoPrint through an OctoEverywhere shared link

You need OctoPrint with the OctoEverywhere plugin installed and linked to an OctoEverywhere account, and a shared connection created there. The link only carries the connection: the app still talks to OctoPrint's own API through it, which is why OctoPrint's **API key** is still needed. Paste the **shared link**, then create an application key in OctoPrint's settings and paste that too. Status is polled through the link; the camera address is taken from OctoPrint's settings.

## A printer that is not connected

Choose **Not connected** under **Add a printer** when the printer has no OctoEverywhere link, or you simply want to log prints by hand. Give it a name and, if you like, its model. The app never contacts it: there is no address, key or camera and no live status. You still pick it when you start a plate (**Where is it printing?**) and when you log a print.

## Logging finished prints automatically

The **Integrations** page also has a switch (team owners) to log finished prints automatically when a connected printer reports a job that was linked to a plate. It is off by default and not needed to use the app.

## Limits

Every link is a long-lived connection from the server to OctoEverywhere, so each workspace may have a limited number of link printers (3 by default), and the whole site too. Not-connected printers are limited to 10 per workspace. If you hit a limit the message says so. The site's operator can change the numbers (`QUOTA_LINK_PRINTERS_PER_WORKSPACE`, `QUOTA_LINK_PRINTERS_TOTAL`, `QUOTA_MANUAL_PRINTERS_PER_WORKSPACE`).

The demo cannot add printers.

## Problems

- **A link printer shows offline:** check in OctoEverywhere that the printer is online and the shared connection still exists. If you deleted and recreated it, edit the printer and paste the new link.
- **"The OctoEverywhere shared link is missing":** edit the printer and enter the link again.
- **No camera:** Elegoo's camera needs the printer to accept the camera-on command; Klipper and OctoPrint take the camera address from their own webcam settings.
