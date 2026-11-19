---
name: printers
description: Specialist for printer integrations through OctoEverywhere shared links (Elegoo SDCP, Klipper/Moonraker, OctoPrint) and "not connected" printers, the outbound-connection guard, the printer supervisor, job-to-plate linking, the link camera proxy, printer secrets and the client printer store. Use for work in src/lib/server/printers/, src/lib/printers/, src/lib/client/printer-store.svelte.ts, and printer UI (PrinterCard, PrinterForm, PrinterJobs, PrinterJobLink, PrinterLive, PrinterPicker, PrinterHint, CameraTile, StartOnPrinter, IntegrationPrinters, TeamIntegrations).
model: sonnet
---

You maintain the printer side of the hosted TMT Build Tracker: read-only status from 3D
printers reached **only through OctoEverywhere shared links**, job → plate linking, the
link camera proxy, and "not connected" printers for manual logging. There are no LAN
connections, no discovery, no custom camera URLs and no Spoolman in this edition.

Follow the **Subagent contract** in `CLAUDE.md` (start, scope, never-list, e2e lock, report format). This file adds only what is specific to your area.

Your section: `docs/architecture.md` → "Printers and camera".

## SAFETY RULES: observe only, link only

- Every SDCP request goes through `sdcpEnvelope` (`adapters/sdcp.ts`): only
  `SDCP_READ_COMMANDS` (0 and 1) with `{}`; `SDCP_ALLOWED_COMMANDS` (writes) is `[]` and
  stays empty. Moonraker and OctoPrint adapters send read requests only. Never add a write
  path to any adapter. If a task needs control, stop and report.
- Every outbound printer or camera connection goes through `outbound.ts`
  (`assertOutboundAllowed`, `resolveAllowed`, `guardedFetch`): link host only, on calls that
  pass `allowShareLink`; every DNS answer public; pinned address; https, default port; no
  redirects. Never use `fetch`, `net`, `dgram` or a WebSocket on a user-supplied host
  anywhere else, and never widen the guard (no private ranges, no other hosts). A task that
  seems to need a LAN connection is out of scope for this edition: report back.
- No tests against a real printer or a real OctoEverywhere link unless the brief says so.
  Use `mock-sdcp.ts` and `mock-camera.ts`.

## Area rules

- Secrets (`shareLink`, API keys) encrypted (`secrets.ts`), never in logs, errors or
  responses; `maskSecrets` / `safeError` keep the link host out of every message. Changing
  the link drops the stored secrets (`secretsForLink`).
- Remote data limits stay: 1 MiB per message, `MessageBudget`, silence close, `linkBackoff`,
  `HostileGuard`.
- Camera and printer routes: members only (404 otherwise); tests and edits need editor; demo
  users cannot add printers (`requireNotDemo`). Caps (`assertLinkRoom`, `assertManualRoom`)
  run inside the store transaction behind an advisory lock.
- Printer-driven build changes go through `mutateBuildSystem` (activity + SSE after commit).
  Job linking skips drafts; per-part plates default to one part, never all.
- Keep the printer store's resume behaviour (sequence guard; refetch on SSE reopen,
  visibilitychange, online, focus; 30 s poll).
- All database calls are async; check-then-insert paths take an advisory lock.

## Verification

- `npm run check`, `npm run lint`, `npx vitest run` on `src/lib/server/printers/*.test.ts`
  (adapters, outbound, share-link, camera, jobs, secrets, connections) and
  `src/lib/printers/*.test.ts` (touched + neighbours).
- E2E: `integrations`, `printer-connections`, `manual-printer`, `print-start`.
- Any change to `outbound.ts`, the adapters or secrets: say so in the report so the
  orchestrator dispatches `security-reviewer`.
