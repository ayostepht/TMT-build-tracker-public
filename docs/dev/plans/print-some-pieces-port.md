# Port brief: "Print some pieces of a part"

Port of a feature from the self-hosted sibling,
[ayostepht/TMT-Build-Tracker#93](https://github.com/ayostepht/TMT-Build-Tracker/pull/93). Branch
`port/print-some-pieces` carries the shared code (domain logic, components, client API, help page,
e2e specs). The database and server side are **not** on the branch: they differ by design here
(Postgres, async, `DbOrTx`) and are listed below as the to-do. Until they are done the branch must
not be merged, see "State of the branch".

## What the feature does

A part made of several pieces (for example Harness and Straps: nine pieces, alone on plate 18 of the
tuned layout) gets a "Print some pieces…" button, on the part row, or on the plate heading when the
part is the only one left to print there. It is the piece-level twin of "Print some parts…".

- Pick the pieces on this print (every piece not ticked yet starts ticked), then mark them as
  printing, or log them as a print without marking them first.
- Now printing shows the part with "3 of 9 pieces", their names and their share of the grams and
  time. Pieces have no weights of their own: the share is by piece count and marked approximate.
- Success ticks exactly those pieces. When the last piece is ticked the part is Printed; until then
  it goes back to To print with its "3/9 pieces" count. Failed ticks nothing and flags the part for
  reprint. Partial does not exist for a piece print.
- Undo, editing or deleting such a log, ticking pieces by hand and "Take off printer" keep the ticks
  and the status in step. Grams and time still to print count only the pieces left.
- With a printer, "Where is it printing?" names the pieces, and the printer's job is linked to those
  pieces only.
- Not offered on plates that print more than once or one part per run, nor while another print of
  the part is on the printer.

State lives in three new nullable columns (JSON arrays of piece indexes into `PartDef.components`):

| Column                       | Meaning                                                     | Null means                        |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------- |
| `build_parts.printing_comps` | pieces of the part on the printer now                       | whole-part print, or not printing |
| `print_runs.comps`           | pieces a run covered (only with `part_slug`)                | whole part or plate run           |
| `printer_jobs.comps`         | pieces of the job's single part (`part_slugs` has one slug) | whole part(s)                     |

A pending expectation (`ExpectedPlate`, in the `organization_settings.settings` blob) carries the
same optional `comps`.

## What the branch contains

**Applied unchanged from the sibling's diff** (the hosted-only differences in these files are
intact; checked by comparing each file with the sibling before and after):

- `src/lib/domain/`: `actions.ts` (`MAX_PIECES`, `isPieceRun`, `printingPieces`, `piecesLeft`,
  `canPrintPieces`, `pieceListError`, `setPieceTicks`, `startPrinting(..., comps)`, the piece branch
  of `applyRun`), `activity.ts` (sentences), `logrun.ts`, `now.ts`, `pace.ts`, `printer-match.ts`,
  `recompute.ts` (piece ticks replayed from the run history), `stats.ts`, `types.ts`
  (`PartState.printingComps`, `PrintRun.comps`, both optional) and the new `pieces.test.ts`.
- `src/lib/printers/status.ts`: optional `comps` on `PrinterJobView` and `PrinterExpectedView`.
- `src/lib/components/`: new `PartPiecesAction.svelte`; `PartPickSheet.svelte` (now generic,
  `unit: 'piece'`), `PartRow.svelte`, `PlateControl.svelte`, `NowCard.svelte`, `LogRunSheet.svelte`,
  `PlateHistory.svelte`, `StartOnPrinter.svelte`, `ExpectedConfirm.svelte`,
  `ConfirmPrintLog.svelte`, `build-context.svelte.ts`.
- `src/routes/(app)/help/+page.svelte`.
- `e2e/print-some-pieces.spec.ts` (new) and `e2e/status-helpers.ts` (`confirmOnPrinter`).

**Applied by hand** (worth a look):

- `src/lib/domain/accounting.ts`: every hunk applied at shifted lines (this edition has no Spoolman
  block). Same code as the sibling: `pieceShare`, `printingFractions`, `leftShare`,
  `subsetShare(..., fractions)`.
- `src/lib/client/api.ts`: same, shifted context. `printing()` start, `jobAction` link and
  `expectOnPrinter` take optional `comps`.
- `CHANGELOG.md`: one entry under Unreleased in this file's style. The sibling's "Upgrading: back up
  `/data`" note is about its SQLite migration and was left out.
- `e2e/print-some-parts-printer.spec.ts`: **not changed.** The sibling only swapped `confirmWhere`
  for `confirmOnPrinter` in tests that drive a mock printer; the spec here has no such tests.
- `e2e/print-some-pieces-printer.spec.ts`: the sibling's spec drives a mock LAN printer, which this
  edition cannot connect. It was rewritten on the pattern of `print-some-parts-printer.spec.ts`: a
  "Not connected" printer, the Where dialog naming the pieces, the direct start, nothing queued. The
  sibling's three job tests (job linked to the pieces and logged; stopped job not logged) are covered
  by `jobs.pieces.test.ts` once ported. This rewrite has not been run. `confirmOnPrinter` is
  therefore unused here; keep it or drop it.

## To do: database and server

### 1. Migration and schema

`src/lib/server/db/app.schema.ts`, three columns, then `npm run db:generate` for a new
`0002_…` migration (the baseline and `0001` are applied to the live database and frozen):

```ts
// buildParts
printingComps: jsonb('printing_comps').$type<number[]>(),
// printRuns
comps: jsonb('comps').$type<number[]>(),
// printerJobs
comps: jsonb('comps').$type<number[]>(),
```

All three nullable with no default, so the migration is three `ADD COLUMN … jsonb` statements,
additive, nothing rewritten, and the previous image keeps working against the migrated database
(rollback stays "run the previous `sha-` image"). Do not copy the sibling's
`drizzle/0004_piece_prints.sql`: it is SQLite. The sibling's `baseline-upgrade.test.ts` change has
no counterpart here; check `migrate.test.ts` for a column or migration count that needs the new
entry.

### 2. `src/lib/server/builds/view.ts`

- `loadBuildView`: part state gets `printingComps: s.printingComps?.length ? s.printingComps : null`
  (and `printingComps: null` in the default state of a part without a row); each run gets
  `comps: r.comps?.length ? r.comps : null`.
- `applyPatches`: `if ('printingComps' in p) set.printingComps = p.printingComps?.length ? p.printingComps : null;`.
  The domain functions on the branch already emit this key (`startPrinting`, `stopPrinting`,
  `setStatus`, `applyRun`, `setPieceTicks`, `recomputeParts`); until it is written, piece state is
  dropped silently.

### 3. `src/lib/server/builds/actions.ts`

New imports from `domain/actions.ts`: `MAX_PIECES`, `pieceListError`, `piecesLeft`,
`printingPieces`, `setPieceTicks`.

- **`pieceList(v, view, slug, mode: 'start' | 'log', field = 'comps')`** (new, exported): must be an
  array, at most `MAX_PIECES` long (checked before anything walks it), then `pieceListError`; returns
  the list sorted. 400 otherwise.
- **`assertPiecePlate(view, slug, plateNumber | null)`** (new, exported): with a plate number the
  part must be on that plate; the plate (given, or the one holding the part) must not be
  `perPartRuns` or have `runs > 1`.
- **`printingAction`, `start`**: optional `comps`. Needs exactly one slug; refuse a part that is
  already Printing or Printed; `assertPiecePlate(view, slug, null)`; `pieceList(..., 'start')`; a
  list equal to `piecesLeft(view, slug)` in length becomes `null` (whole-part start). Pass it as the
  fifth argument of `startPrinting`; add `comps` to the `printing.start` payload when set.
- **`printingAction`, `stop`**: the job rows it frees also get `comps: null`.
- **`updatePart`**: the callback takes `now`; refuse a `comps` object with more than `MAX_PIECES`
  entries; merge `setPieceTicks(view, slug, comps, now)[0]` into the patch, so a hand tick takes the
  piece off a print under way and ends the print when none are left. Suggested on top of the
  sibling: keep only keys that are indexes of the part's own pieces, as `undoRun` does.
- **`runOutcome`**:
  - `partSlug` becomes `let`.
  - Safety net: a Success or Failed run with a plate, no `partSlug`, no `partSlugs`, no `comps` and
    no `split`, on a plate with exactly one part that is Printing with a fitting piece list
    (`printingPieces` + `pieceListError(..., 'log')`), is rewritten to a run of that part with those
    pieces. A caller that knows nothing about pieces (a printer job finishing) can then never tick
    the whole part.
  - With `comps`: needs `partSlug`, no `partSlugs`, no `split`, result not Partial,
    `assertPiecePlate(view, partSlug, plateNumber)`, `pieceList(..., 'log')`.
  - System-run fallback: when `userId === null` an `ApiError` from that validation is swallowed and
    the run is logged as a plain run of the part (a printer's log must not fail because the kit
    changed under a stored list). Requests from people keep their 400.
  - `comps` goes into the `PrintRunInput`, the inserted `print_runs` row
    (`r.comps?.length ? r.comps : null`) and the `run.add` payload.
  - Keep `assertRunRoom(tx, buildId)` and everything else this edition added to the function.
- **`undoRun`** (the snapshot comes from the client): cap `comps` entries at `MAX_PIECES`; keep only
  keys matching `/^\d+$/` below the part's piece count; optional `printingComps` must be an array of
  distinct integers in range, at most `MAX_PIECES` (400 "Invalid printingComps"), stored sorted, and
  only when the snapshot's status is Printing (else null). Add `comps` to the payload of the removed
  run.
- **`deleteRun`**, **`updateRun`**: `comps` in the activity payload; `updateRun` refuses to move a
  piece run to another part ("A print of some pieces belongs to its part; delete the log and log it
  again").
- **`runFromRow`**: `comps: r.comps?.length ? r.comps : null`.

### 4. `src/lib/server/printers/jobs.ts` and `src/lib/server/org-settings.ts`

- `org-settings.ts`: `ExpectedPlate.comps?: number[]`.
- **`checkPieces(view, plateNumber, slugs, raw)`** (new, exported): `undefined` when nothing was
  sent; otherwise exactly one slug, part not Printed, `assertPiecePlate`, `pieceList(..., 'start')`;
  a list equal to every piece still to print returns `undefined`.
- **`fittingComps(view, slugs, comps)`** (new, exported): the list when it still fits the single
  part (`pieceListError(..., 'log')` is null), else `null`. Every read of a stored list goes through
  it, so a stale list degrades to a whole-part job and never throws.
- **`Candidate.comps`**, and **`attach`**: the chosen pieces, or the list a single Printing part
  already carries (marked first, linked by hand later), through `fittingComps`; written to
  `printer_jobs.comps`; passed to `linkPatches`; `syncPlateTime` is skipped for a piece job (its time
  is that of some pieces, never the plate's).
- **`linkPatches(..., heldByOther, comps)`**: a part going to Printing gets `printingComps`; a part
  already Printing and held by this job gets its list replaced when it differs.
- **`expectOnPrinterJob`** stores `comps`; **`pendingExpected`** and **`toJobView`** report it.
- **`runBody`**: a job with fitting pieces logs `partSlug` + `comps` (never a subset or split).
- **`confirmJobRuns`**: Partial or a `split` for a piece job is refused (400 "Log Success or Failed
  for a print of some pieces").
- **`linkJob(..., partSlugs, comps)`**: `checkPieces`, except that a list identical to the pending
  expectation's that no longer fits links the part without pieces; a list the client typed is still
  validated strictly.
- **`unlinkJob`**: also clears `comps`.

### 5. Routes

- `src/routes/api/printers/[id]/expect/+server.ts`: `checkPieces(view, body.plateNumber, partSlugs, body.comps)`
  after `checkPartSlugs` and before the `manual` return (a "Not connected" printer validates too);
  pass `comps` to `expectOnPrinterJob`.
- `src/routes/api/printers/jobs/[id]/+server.ts`: pass `body.comps` to `linkJob`.
- No new route. `POST /api/builds/[id]/printing`, `/runs`, `PATCH …/parts/[slug]` and the undo route
  reach the changes through `actions.ts`.

### 6. Tests to port

Both files are new in the sibling; port them with `createTestDb()` and `await`:

- `src/lib/server/builds/pieces.test.ts` (about 560 lines): starting some pieces, logging a piece
  print, a run that does not know about pieces, undo / edit / delete, hand ticks, a stale piece list,
  undo snapshot ticks.
- `src/lib/server/printers/jobs.pieces.test.ts` (about 430 lines): expectation with pieces, linking,
  finishing (confirm, auto-log, grams share, failed, cancelled, cancelled at 0%), validation, a stored
  list that no longer fits. It drives the sibling's printer fixtures; use whatever `jobs.test.ts`
  uses here.

Existing tests that compare a whole part state or run with `toEqual` will see the new
`printingComps: null` / `comps: null` keys.

## Rules the server must enforce

- A piece list is an array of **distinct integers**, each an index of the part's `components`, at
  most `MAX_PIECES` (200) entries, and **fewer than all** of the part's pieces. The part has at least
  two pieces.
- For a **start** (the printing action, expect, link) every listed piece is still **unticked**, and
  the part is not already Printing (start) or Printed.
- A list equal to every piece still to print is a whole-part print: stored as null.
- **Exactly one part slug** goes with a piece list.
- The plate prints **once** and is not `perPartRuns`; with a plate number, the part is on that plate.
- A piece run is Success or Failed, never Partial, never with a `split`, and cannot be moved to
  another part.
- **Editors only** (`mutateBuild`, `requireEditor`); viewers get 403. **Drafts are refused** (the
  existing draft guards in `mutateBuild`, the expect route and `linkJob` cover it; the tests assert
  it).
- A **stored** list that no longer fits the part (the kit or template changed) degrades to a
  whole-part job or run. It never raises and never ticks pieces.

## Specific to this edition

Things the sibling does not have and the port must respect:

- **Validate against the locked view.** The sibling runs on SQLite's single writer, so a list
  validated in the route is still valid when it is written. Here the expect route and `linkJob`
  validate on a view loaded before the transaction, and `attach` computes its piece list from
  `c.view` before `mutateBuild` takes the `build:<id>` advisory lock. Two requests (a hand tick and a
  link, or two links) can interleave. Recompute the list with `fittingComps` on the view the
  `mutateBuild` callback receives, and write the job row and the patches from that.
- **Demo.** `requireNotDemo` stays first on both printer routes. Demo visitors can track their sample
  build, so the printing action and run logging with `comps` are open to them like any other build
  mutation; nothing new to refuse.
- **Tenancy.** `linkJob` keeps its "the build belongs to the job's team" check and the expect route
  its `access.organizationId !== p.organizationId` check before any piece validation. `checkPieces`
  must only ever see a view loaded for that build after those checks.
- **Quotas and rate.** Keep `assertRunRoom` in `runOutcome` and `pruneActivity` in `mutateBuild`. The
  feature adds no route, so the per-user write rate limit covers it as is. Payloads grow by at most
  `MAX_PIECES` integers.
- **jsonb.** Arrays keep their order, so the sibling's two `JSON.stringify(a) === JSON.stringify(b)`
  comparisons of piece lists (`linkPatches`, the stale-expectation check in `linkJob`) are safe, but
  an element-wise compare of sorted lists avoids a needless patch when the order differs.
- **Promise lint.** `pieceList`, `assertPiecePlate`, `checkPieces` and `fittingComps` are pure and
  stay synchronous; the `try`/`catch` of the system-run fallback wraps synchronous validation only.
- **Privacy page.** Piece indexes are build progress like the existing ticks: no new kind of stored
  data, no cookie, nothing for analytics. `/privacy` needs no change.
- **Schema change after the first deploy:** merging applies the migration to the live database.

## State of the branch

- Nothing was run on it (no install, type check, tests or build). The touched files were formatted
  with prettier.
- **Types:** every new field is optional (`PartState.printingComps`, `PrintRun.comps`,
  `PartPatch.printingComps`, `PrinterJobView.comps`, the client API parameters), so `npm run check`
  is expected to pass even before the server work; treat any error as a surprise worth reading.
- **Behaviour without the server work is wrong, not just missing:** the server ignores `comps`, so
  "Print some pieces…" starts the whole part and a Success prints the whole part. That is why the
  branch must not be merged before sections 1 to 5 are done.
- **Expected failures until then:** `e2e/print-some-pieces.spec.ts` and
  `e2e/print-some-pieces-printer.spec.ts` (every test that reads `printingComps`, a run's `comps`, or
  expects a 400 for a bad list). `src/lib/domain/pieces.test.ts` is pure domain and should pass.

## Known limits (same as the sibling)

- One piece print per part at a time.
- Shares are by piece count: a piece named "×5" counts as one piece.
- No Partial result for a piece print.
- Not on multi-run or one-part-per-run plates. No e2e covers drafts or multi-run plates (the test
  layout has no multi-piece part on one); the server tests do.
- The printer path has no e2e here (no live-printer seam): job linking and logging rest on
  `jobs.pieces.test.ts`.
