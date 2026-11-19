## What this changes and why

<!-- A few lines. -->

## How I checked it

<!-- Tick what you ran. For UI changes add screenshots at phone and desktop width. -->

- [ ] `npm run check`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] The relevant end-to-end specs: <!-- names -->

## Checklist

- [ ] There is a linked issue (for anything beyond a small fix)
- [ ] No MakeGood files (`*.3mf`, `*.glb`, `*.step`, kit packs) are in the commit
- [ ] No personal data, addresses, links, keys or access codes in code, tests or screenshots
- [ ] A schema change comes with its generated migration (a migration that is already deployed is never edited)
- [ ] Printers stay read-only and link-only: nothing new is sent to a printer, and nothing connects to an address a user typed
- [ ] User-visible changes are noted under Unreleased in `CHANGELOG.md`
- [ ] Says whether the change also applies to the self-hosted edition (ayostepht/TMT-Build-Tracker)
