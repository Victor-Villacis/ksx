# Deferred Studio surfaces after the hard cutover

This is the canonical scope ledger for capabilities deliberately left out of
Studio when `/redesign` became the only product workbench. It is not a release
blocker list and it is not permission to restore `/nocturne`: that route has no
page, API, or write surface after the cutover. A request for the old page may be
redirected to `/redesign` only as retired-bookmark compatibility.

This list is exhaustive for intentional cutover deferrals. Adding an item
requires an explicit product decision; a failing release gate or an unrelated
surface gap does not become deferred merely by being written here.

The underlying KSX data formats, backend planners, `ksx-api` contracts, backup
rules, and CLI verbs remain authoritative where they already exist. What is
deferred is a coherent Studio face for them. Rebuilding one of these areas must
call those contracts; it must not recover code from the deleted legacy island
or introduce a browser-only store.

## Settings / Library

- **Saved games.** Browse with explicit read-error states; load/switch only into
  an empty draft and never start Play as a side effect; create, update, delete,
  and repair the program path, arguments, player count, controller layout and
  stale revision. Device rebase must be an explicit choice rather than silently
  replacing a game's saved selectors.
- **Controller layout library.** Browse, create from a template, rename while
  repointing consumers, and delete only after references and consequences are
  shown and confirmed. Mapping a controller already in the workbench remains
  part of `/redesign`; managing the reusable files as a library belongs here.
- **Whole-root import and export.** Download or paste the typed `config`,
  `games`, `presets`, or `all` document without accepting arbitrary browser
  filesystem paths. Import needs validation and a readable report, preview/dry
  run by default, explicit apply/force consent, stale-write protection, and a
  timestamped backup before replacement. The retired browser implementation's
  8 MB request limit is retained only as migration evidence for sizing and
  refusal copy; no `/nocturne/import` endpoint survives the cutover.
- **Autostart.** Show authoritative per-user task state — registered, stale,
  read-only, or failed to read — and provide deliberate enable/update/disable
  actions, including game selection and the existing preflight/refusal
  behavior. The full CLI remains the operational fallback.

## Advanced setup

- **Control Surface Builder and custom boards.** Draw and edit a physical panel,
  define controls, connect them to observed host signals, and persist the
  resulting board model in a backend-owned portable format.
- **Board presentation selection.** Choose how a known or custom board is
  represented without changing its hardware identity, terminal truth, or
  mappings.
- **Keyboard Arranger.** Arrange the physical keyboard view used during setup;
  this is presentation metadata, not another binding model.
- **Simultaneous host-signal test UI.** Drive the existing bounded
  `input-test start/poll/cancel` contract to measure chords or encoder signals
  while Play is stopped. The API/CLI contract remains; the dedicated Studio UI
  is deferred.

## Cutover boundary

The shipped Studio surface is exactly four live pages:

- `/redesign` — device selection, exact-device preparation/release and recovery,
  controller staging, mapping, Save/Apply/Play/Stop, Adopt/Discard, and live
  feedback;
- `/check` — input/output feedback;
- `/pads` — virtual-controller diagnostics;
- `/devices` — hardware inventory and recovery.

Settings/Library and Advanced setup do not have a Studio entry point after the
hard cutover. Their preserved backend/data/CLI contracts may be exercised by
tests and non-Studio callers, but documentation must not describe a retired
browser form as available.
