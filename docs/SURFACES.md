# Surfaces: what each one is for

ksx has three faces — the CLI, the egui cabinet app, and Studio in a browser —
and one backend. This file records which face owns what, in what order they get
built, and the alternatives that were considered and rejected. It exists so that
"which surface does this go on?" is answered once instead of re-argued per
feature.

Written 2026-08-07, after `ksx device pick` shipped as a verb with no web face
and the question came up for the fourth time. Audited and corrected the same
week — the matrix had four cells describing capabilities that do not exist, and
§1's supporting anecdote was false in both halves. Every correction below names
the code it was checked against.

> This file is **cited from source**, like every other design doc here. That is
> not decoration: at its first audit `SURFACES.md` had zero references anywhere
> in the repository — `.rs`, `.md`, `.toml`, `.ts` — while `INPUT-TRANSFORMS.md`
> had 106 and `CONTROL-SURFACE.md` 29. A design document nothing points at is a
> memo, and a memo cannot be violated because nobody is looking at it when they
> write the code. `crates/ksx-app/tests/docs.rs` now fails if a governing doc
> loses its last citation.

## §1 The backend owns state; every surface is a view

Already the architecture, stated here so it stops being implicit. From
`crates/ksx-backend/src/device_edit.rs`:

> One writer, like every other write. A typed spec in, a pure plan out, a
> timestamped backup taken before the write, and the store's atomic save doing
> the I/O.

And from `ksx studio --help`:

> every button is one backend verb, no GUI-only code paths.

**No surface may hold logic another surface would need.** A capability becomes a
typed spec and a pure plan in the backend; surfaces call it and render the
result. `ksx-api` is the wire contract between them.

### Where this is currently broken, on purpose and by accident

Stated here because an unqualified rule that the code visibly does not follow
teaches people to ignore the rule rather than to fix the code.

- **The mapper's timing arithmetic exists three times.** `ksx_core` owns it;
  `ksx-studio/src/render_map.rs` mirrors `MIN_STEP_MS`, `TURBO_MAX_HZ`, the
  frame maths, `MacroStep::effective_ms`, the turbo on/off split, the turbo gap
  and two SOCD/diagonal helpers, each with a comment saying it is a mirror; and
  `studio-ui/src/MapIsland.ts` mirrors the same values a third time so the
  no-JS page and the interactive island agree. The Rust copy is pinned to
  `ksx_core` by a test. **The TypeScript copy is pinned to nothing**, which
  makes it the one that will drift, and it will drift silently because a wrong
  step preview looks like a wrong step preview and nothing else.
- **The mappable-function vocabulary lives in the surface.** `ZONE_XBOX` and
  `ZONE_DS4` in `render_map.rs` hold the 25 canonical pad functions, and the
  test that checks them re-types the same 25 strings, so adding a function to
  `ksx-core` fails nothing. The bindable-*key* vocabulary next to it does this
  right — it is pinned against `ksx_core::key::Key::ALL` through a test-only
  dev-dependency — and the fix is the same shape: a canonical `ALL` on the
  function type, then compare against it. There is no such list to compare
  against yet, which is why this is still written down instead of tested.
- **The egui takes a few decisions of its own.** `Screen::ButtonCheck`'s action
  clears a local log, `Screen::Status`'s prints a nag, and `Ask::Refresh` is a
  re-read: three actions that are not backend verbs, in a file whose own comment
  says there is no such variant. All three are state-free, so the harm is nil
  and the claim is what is wrong, not the code.

The cost of breaking this rule is concrete in the present tree.
`MachineSource::devices()` is implemented in `ksx-backend/src/sources.rs`, but
the cabinet navigation contains only ButtonCheck, Status, Session, Profiles,
and Presets. The backend read is compiled behind
`#[cfg(all(windows, feature = "cabinet"))]` even though that surface has no
devices screen and no caller for the read.

So the failure mode is symmetric, and the rule needs both halves: a surface must
not own a capability the backend lacks, **and a backend verb with no face is not
finished either** — it is untested against a real caller, and its shape is a
guess.

That was the surface-parity guard on the task list (#26), and it now exists:
`crates/ksx-app/tests/parity.rs` walks the clap command tree, reads Studio's
routes out of `Router::new()` and the cabinet's screens and `Ask` variants out
of its source, and asks of every cell in §3 whether the tree agrees. A verb no
row names and no exemption covers fails it. So does a cell claiming a face that
is not there — and so does the opposite, which is what it found on the day it
was written: two cells still saying `planned` about pages that had shipped.
What it cannot check is a capability nobody wrote a row for, which is the
remaining reason to keep §3 current by hand.

### §1a Rendered COPY is logic too, and one page proves it

A Studio island seeds its signals from the server's paint and then rewrites the
same signals from a 2 s poll. It is very easy to let the island compose its own
sentences from the polled data, and every one of them is then a second
implementation of a backend rule in another language.

*The anecdote is from 2026-08, on a page that no longer exists; it is kept
because the failure is the reason the rule is written down at all.* The Profiles
page shipped that way and review found the drift immediately: the slot-count
input's ceiling was `createSignal("16")` in `ProfilesIsland.ts`, its setter was
never called, and no payload field could reach it. `MAX_SLOTS` has already been
raised once (task #17). The next raise would have had the server render
`max="32"` and hydration write `16` straight back over it — a *legal* input
silently refused, for the same reason `main.rs`'s `slot_arg` module exists. The
summary lines, the pill mapping and the row text were duplicated the same way;
they had not drifted yet.

The shape that fixes it: **one serialized derived block**, and the page to copy
today is `/nocturne`. `NocturneDerived` (`crates/ksx-studio/src/snapshot.rs`)
holds every displayed string, every count, every numeric ceiling and every
`show:` boolean, computed once from the provider data; `render_nocturne.rs`
injects it into the FMIR slots and `applyNocturne` assigns it to signals.
Neither composes anything — `render_nocturne.rs`'s own header states the rule
as "every scalar value is a `NocturneDerived` field except the flash". A new
page copies this, not the two-halves version. (The original of this pattern was
`ProfilesDerived` / `render_profiles.rs` / `applyProfiles`; that page was
deleted on 2026-08-25 and only the type name survives.)

### §1b A refused READ is not an empty result

"I could not read this" and "there is nothing here" are different sentences, and
a user acts on them differently: one says *go fix your config*, the other says
*go make your first profile*. A surface that renders the second when the first
is true has reported success over a read that did not happen — which is the
failure mode this project keeps hitting (the session that read as healthy while
the arcade panel was dead, because a WinUSB board had fallen back to
Interception).

The rule: **an `Err` from a provider gets a typed field on the payload, never a
`Default::default()` view.** Substituting a default is what turns a refusal into
a count of zero, and a count of zero into a confident wrong sentence. The shape
survives the cutover: `NocturneDerived` carries `stage_error`, `scan_error` and
`presets_error` as three separate strings, one per read, because the page has to
be able to say *which* provider refused. Note the second-order bug the old
Profiles page had, which is what the rule was written against: a defaulted
`PresetsView` set `noPresetsYet`, whose copy points at a template form fed by
*the same read that just failed* — a closed loop with a wrong sentence on it.

A page that gets this right needs a test that fails when the two are conflated;
asserting the failure state renders is not enough, because that passes while the
absence sentence renders too.

## §2 Build order

1. **Backend verb** — typed spec, pure plan, tested against synthetic fixtures.
2. **CLI** — the cheapest backend surface to test; CI also drives Studio
   headlessly for Playwright browser validation.
3. **The surface the task is actually performed on** (§3, §4).

There is no "egui first or web first" question. That framing assumes a surface
owns a capability, which §1 forbids. The real question is only ever *which
surface does a human perform this task on*, and that is answered by the matrix.

## §3 The capability matrix

> **This table is a test.** `crates/ksx-app/tests/parity.rs` parses it and
> checks every cell against the tree — the clap command tree, Studio's routes,
> the cabinet's screens and `Ask` variants. Editing a row means editing that
> test's anchors too, and a word the guard has not been taught (the vocabulary
> is below) fails it rather than passing unread. Adding a ROW with no anchors
> also fails: an unbound row is checked by nothing, which is the state the whole
> table was in before the guard existed.

| Capability | CLI | egui (cabinet) | Studio (browser) |
|---|---|---|---|
| First run: stage a setup, save or play | partial (`ksx stage` view/adopt/reorder/socd/apply; save and play stay surface acts) | — | **primary** |
| Author presets / key mappings | owns | — | **primary** |
| Edit configuration | owns | slot→preset only | **primary** |
| Rename / delete a controller layout | owns | — | **primary** (`/nocturne`) |
| Create / update / delete profiles | planned | view | **primary** |
| Device pick / remove | owns | planned | **primary** |
| Measure simultaneous keyboard / encoder host signals | owns (`ksx input-test start`, `poll`, `cancel`) | — | **primary** (keyboard workbench / Control Surface Builder) |
| WinUSB claim / release | owns (advanced) | planned | **primary** (installed `/nocturne`; explicit UAC) |
| "Press a button, see it light" | input only (`ksx monitor`) | **primary** | view (§8) |
| Is it working: pads, drivers | owns | **primary** | view |
| Spawn test pads / prune the bus | owns | — | **primary** |
| Start / stop / switch profile | owns | **primary** | convenience |
| Record / replay a session | owns | planned (§3b) | planned (§3b) |
| Start ksx at sign-in | owns (all options) | planned | **primary** (`/nocturne`, one tick box) |
| Split or freeze, after saving | — | — | **primary** (`/nocturne`) |
| Studio theme | — | never (the 10-foot surface is dark-only by design) | **primary** (`/nocturne`) |
| What opposite directions do (SOCD) | owns (`slot assign --socd`) | — | **primary** (`/nocturne`) |
| What ksx left behind (receipts and signing certificates) | owns (`winusb repair`, `winusb sweep-certificates`) | — | **primary** certificate cleanup (`/devices`); receipt view |

"owns" = the verb lives here. "primary" = where a human does it. "view" =
renders backend state, takes no decisions. **"planned" = nothing is there** —
and it is spelled out because the previous version of this table used "view" for
two cells that render nothing at all, which reads as a shipped capability and
cost an audit to catch.

Four cells were corrected, each against the code:

- **Edit configuration — egui.** Was "—". The egui *does* write config: the Presets
  screen builds an `Ask::Assign`, which becomes a `SlotAssignRequest` that
  rewrites a `[[slot]]`'s preset. It also decides **which file** the write lands
  in (`config.toml` or a `games.toml` profile) in `assign_destination`, whose
  own doc comment records the data-loss bug the previous version of that
  decision caused. That is a targeting decision taken in a surface; it is the
  strongest live counter-example to §1 in the tree, and it stays until the
  destination rule moves behind the verb.
- **Edit configuration — Studio.** *Superseded 2026-08-08; see below.* Was
  "**primary**". At the audit no Studio route wrote `config.toml` or
  `games.toml`; the only config-adjacent route re-read. Every mapper write (the
  `/map/*` routes, as they were then) went to a preset file. `AppState` held no
  `MachineSource`, and `ControlSource`
  had exactly one config-writing verb (`slot-assign`) which Studio never called.
  It was the right destination, so it stayed in the table — as a plan.
- **Device pick / remove, WinUSB claim / release — egui.** Both were "view".
  The cabinet has no device mutation screen, so both remain planned there.
  The old audit also concluded that Studio could never own WinUSB because it
  could not elevate safely. That premise is now superseded: installed
  `/nocturne` calls typed `MachineSource::winusb_prepare`/`winusb_release`,
  which elevate a
  fixed GUI helper and return only after exact re-survey. The browser never
  supplies a helper path or backend.
- **"Press a button, see it light" — CLI and Studio.** The CLI cell was "—",
  but `ksx monitor` streams `<alias> <Key> down|up` per keystroke: that is the
  input half, and what it lacks is the second column the egui has (what the
  panel sent *and* what the pad published — screens.rs explains that the pair is
  the diagnostic). The Studio cell claimed "useful on phone (§6)": there is no
  live-input channel in Studio at any screen size — no feed on `AppState`, no
  frame type, nothing — and the cross-reference pointed at the wrong section
  (mobile is §8; §6 is launching).

Two more were corrected on 2026-08-08, and this time by the guard rather than
by a person reading the table — both in the direction that is cheaper to make
and harder to notice, a face that SHIPPED while the cell still said `planned`:

- **Edit configuration — Studio.** Was "planned primary". A config-writing
  Studio face has since shipped and the plan is the surface. *Re-pointed
  2026-08-25 at the routes that carry it now:* `/nocturne/save` writes the whole
  staged configuration to disk in one act, and `/nocturne/import` replaces the
  config root from a pasted document. **primary**, which is where the bullet
  above already said it belonged.

  Recorded rather than quietly re-pointed, because something was **lost** in the
  move: the face this bullet used to name was `/setup/slot`, a form posting
  `ControlSource::assign_slot` — the same verb `ksx slot assign` performs. That
  route is gone and `assign_slot` now has **no Studio caller at all**. The
  capability did not disappear (a slot's preset, persona and SOCD are all edited
  on `/nocturne`, and Save commits them together), but the one place where a
  browser button and a CLI verb were literally the same backend call did. §1's
  rule cuts both ways here: the cell is still honest, and the verb is now a
  backend verb with one fewer face than it had.
- **Profile management — Studio.** Saved games are created, updated and deleted
  through typed `MachineSource` verbs and switched through the existing control
  verb. *Re-pointed 2026-08-25:* those four faces were `/profiles*` and are now
  `/nocturne/game`, `/nocturne/game/update`, `/nocturne/game/delete` and
  `/nocturne/adopt` — the Configuration menu on the product page. The CLI CRUD
  half is explicitly planned rather than hidden inside a broader "owns" claim;
  the cabinet list remains a view and its operating switch belongs to the
  start/stop row below.
- **Device pick / remove — Studio.** Was "planned (#22)"; #22 shipped
  `/devices`, `/devices/pick` and `/devices/remove`. The egui half stays planned
  and drops the issue number, because #22 was never about the cabinet — its five
  screens are still ButtonCheck, Status, Session, Profiles, Presets. This is the
  one bullet the 2026-08-25 cutover left untouched: `/devices` is a tool page and
  survived it whole.

**A note on the six parentheticals above the corrections, and why they were
wrong for a fortnight.** `classify` in `tests/parity.rs` reads only the FIRST
word of a cell, because that is the word that says whether a face exists. It
follows that a route name in a cell's parenthetical is checked by nothing at
all — and on 2026-08-25 six of them still named `/start`, `/setup` or
`/profiles`, pages that had been deleted, inside a matrix whose test suite was
entirely green. The anchor table in `parity.rs` had been migrated correctly; the
prose beside it had not. If that is ever to be guarded, the cheap version is the
same shape as the `(§N)` guard the file already applies: pull every `` `/…` ``
token out of a Shipped cell and require `studio_routes()` to contain it.

The simultaneous-signal diagnostic gets its own row rather than being folded
into "Press a button, see it light." The latter compares a running pipeline's
input and virtual-pad output. This diagnostic runs only while Play is stopped,
measures the host signals an exact keyboard or keyboard-mode encoder exposes,
and deliberately has no output-pad half. Studio owns the human interaction;
`ksx input-test start|poll|cancel` is the thin, scriptable second caller over
the same generation-stamped pipe verbs. There is no cabinet face: opening a
timed diagnostic and tracing its evidence is close-range setup work, not a
10-foot operating action.

### §3c The first-run row, and the build order it ran backwards

Row 1 is new on 2026-08-08, and it is the first row in this table whose **CLI
cell is honestly `planned`**. `docs/FIRST-RUN.md` is a spec for a product
someone who is not us can use, and its §1 premise is that no step may require a
shell — so the surface came first and `ksx stage` is owed. That is §2's build
order run 1 → 3 with 2 skipped, the same way `/nocturne/game` (then
`/profiles/new`) did it, and it is recorded here rather than quietly for the
reason that entry gives: the backend half then has no second caller checking its
shape.

What exists: `ksx_core::StagedSetup` (the value, with no path to a file), the
four `stage*` pipe verbs, and Studio's `/nocturne` performing all of them. What
does not: any way to stage a setup from a terminal. The four verbs are on the
control pipe, so the CLI half is a driver over `ControlSource`, not new logic.

**Moment 6 is implemented without a second mapper, and after 2026-08-25 it is
not even a second page.** A staged controller can start from a served layout,
and the mapper that gives it bindings is the same button/chord/turbo/macro
authoring UI, reading the slot's optional full `PresetFile` snapshot. The URL
used to be `/map?target=stage&slot=N`, and `target` existed to say WHICH of two
subjects the mapper was pointed at — the saved preset on disk, or the draft in
the daemon. There is now one subject, so there is one parameter:
`/nocturne?slot=N` selects the controller and the page is always the stage.
`NocturneQuery` accepts `flash`, `slot`, `q`, `fresh` and `macro`, and nothing
else; `target` survives only as a form field on the macro-save verbs, where it
still distinguishes which draft a step list belongs to. `staged_bind_edit` and `staged_macro_edit` prepare pure
edits, validate cross-stage conflicts and apply one `StageEdit::SetBindings`
only after acceptance. Refusal leaves the stage unchanged; force has the same
explicit conflict meaning as the saved mapper. No staged GET/edit touches disk,
takes a backup or claims a config reload. Save and Play remain separate.

The daemon's empty-default startup is part of this row too: it stays alive as
an idle staging/control host with no session, capture, claim or pads. Explicit
empty game profiles and other plan failures still refuse. The terminal driver
`ksx stage` remains planned; it must call this same control contract rather
than growing a second staging implementation.

**This row is also why the guard's bookkeeping changed.** It used to require
every CLI anchor to exist in the clap tree, whatever its cell said — which is
right for a cell claiming `owns` and wrong for one saying `planned`, where a
name that does not resolve is exactly the claim being made. The egui and Studio
columns have always worked that way (`Screen::Mapper` and `/buttons` name
nothing, which is what makes their `—` honest); the CLI column now does too, and
`every_cell_claiming_a_shipped_face_has_one` is what holds the shipped
direction.

### §3a Why installed WinUSB preparation has a narrow Studio face

WinUSB is still the most dangerous action in the matrix: it takes a keyboard
out of the Windows keyboard stack. The old conclusion was therefore “never in
Studio.” That solved the browser problem by leaving a clean-install customer
with a terminal-only dead end. The shipped design changes the privilege
boundary, not the safety bar.

Studio owns only the consent and exact stale-action guard. `/nocturne` shows the
selected human-named keyboard, states the ordinary-typing consequence, and
requires three independent confirmations: a different tested keyboard, consent
to rebind this selected keyboard, and consent to a machine-local signing
certificate. The forms carry the served selector and instance only. They carry
no backend, command, DLL, path, certificate name, or provider result.

The server then re-reads the stage and machine inventory. It requires one exact
selector match, one exact case-insensitive interface instance, WinUSB
eligibility, and the correct current binding. Unsupported, ambiguous,
shared-hardware-ID, stale and last-keyboard targets refuse before elevation.
Because a Windows package matches a hardware ID, the user is told to release
before connecting another identical keyboard. If one is connected later,
Studio refuses to guess between twins: unplug it, then Release removes the
shared package so the twin returns to HidUsb when reconnected.

**Prepare goes through the stage; Release does not, and that asymmetry is the
point.** Corrected 2026-08-11 after QA: both directions used to resolve their
target from `StagedSetup`, which is per-visit daemon memory that knows nothing
about drivers. Preparing SHOULD be gated on it — it takes a keyboard off the
keyboard stack and the only reason to do that is the setup being staged right
now. Releasing is the undo, and the same gate made the undo unreachable in the
three states that matter: a fresh install stages nothing, choosing another
keyboard points the control elsewhere, and choosing the held keyboard itself
still showed Prepare, because `StageEdit::ChooseDevice` always stages
`interception` and the card keyed Release off that value rather than off the
machine. A held board does not type, so the state with no exit was exactly the
state where the customer's keyboard is dead — `FIRST-RUN.md` §6's "the only way
out of a mistake is never a shell command", reached by a page obeying a rule
about the stage.

So the product page carries a second, stage-independent control: **every board
the live scan reports as claimed, each with its own consented Release**, above
the keyboard choice rather than after it. The question it answers — *which
keyboards cannot type right now* — is a fact about the device tree, and §1 puts
that read where the fact is. It is not on `/devices`, which is the CONFIG page:
its two verbs write and delete `[[device]]` entries, and a held board need not
have one at all (the binding is Windows's and the receipt is under ProgramData).
`/devices` still states the binding and shows the elevated command; the product
page is where the no-terminal way back lives, because that is where a stuck
first-run customer is standing.

> 🔴 **REGRESSED 2026-08-25, and this is the same bug the paragraph above was
> written to close.** The stage-independent list is not on `/nocturne`. The
> backend read still exists — `snapshot.rs::held_boards`, `StartRows::prepared`,
> `StartDerived::prepared_heading` / `prepared_line` — but nothing fills or
> renders any of them: `StartRows` has no consumer outside its own definition,
> and the only `/nocturne/capture/release` form on the page is inside the
> SELECTED keyboard's card. `StartCaptureView::from_parts` returns `None` mode
> when nothing is staged, so on a fresh install with a held board there is no
> Release control at all. Worse, `StartCaptureMode::Held`'s own doc comment
> still ends *"the way out is the held-keyboard list above it"* — pointing at a
> list that is no longer drawn — and the copy for that mode tells the user to
> "release it from the held-keyboards list on the Start screen", naming a page
> that 404s. Every one of the three states the 2026-08-11 correction enumerated
> is unreachable again: a fresh install stages nothing, choosing another
> keyboard points the control elsewhere, and the held board itself lands in a
> mode whose only instruction is to go somewhere that does not exist.
>
> `RECOVERY.md` §2's "there is now a way back that is not a command" depends on
> this, and `FIRST-RUN.md` §6 lists "the only way out of a mistake is a shell
> command" as a thing that must never happen. Restoring the banner on
> `/nocturne` is a Studio change and is not optional. Selecting a keyboard remains looking rather than a
commitment (§5): release is never a side effect of a choice.

The identity guards are unchanged for both directions — one board for this
selector, one interface for this instance, WinUSB-eligible, and, for Release,
actually claimed. What Release drops is a *stage* comparison, not a machine
one. Its blast radius is a caller already past `guard.rs` putting a
ksx-held keyboard back on the keyboard stack, which is the safe direction and
which the provider still refuses unless ksx owns the receipt.

The card for the state where the two disagree — machine says held, stage says
`interception` — reads as blocked rather than ready, and says which two facts
disagree. It must not read as ready: a session started on a stage that names
Interception, over an interface that is off the keyboard stack, is the dead
panel this project keeps rediscovering.

Only an installed Program Files copy may elevate its fixed GUI-subsystem
`ksx-winusb-helper.exe`; that helper may load only its fixed installed sibling
`libwdi.dll`. Both canonicalize from Windows Known Folders and repeat live
owner/DACL/reparse checks. Portable and user-writable copies refuse. The helper
journals, performs the package transaction, compensates failures or records
recovery-required, and re-surveys. Studio accepts only the typed boundary's
canonical `prepared`/`released` state plus the exact instance, then performs a
guarded stage backend transition. Helper stdout, a zero exit code, or a browser
field can never produce success.

The existing loopback Host and mutating-Origin guard still wraps both POSTs.
This does not make driver mutation safe on a LAN; pairing/token work remains a
prerequisite before Studio binds beyond loopback.

Pad testing keeps its different contract. A test-pad action cannot lock out the
keyboard, so it needs state bounds and clear consequences rather than UAC
device ownership. `/pads` is specifically the ViGEmBus diagnostic: its spawn
picker contains only implemented personas whose canonical backend is `vigem`.
DualSense is deliberately absent there because its HIDMaestro endpoint and
one-instance capacity are proved through the product page's own set-up-and-play
path, not through a page whose inventory and prune verb both describe the ViGEm
child bus. `/nocturne` still cannot install ViGEmBus or HIDMaestro: those
belong to the installer's explicit controller-driver checkboxes. It may only
report the output backends required by the currently staged supported personas.
A surface may own one narrowly designed elevated transaction without becoming
a generic driver console.

### §3b Record / replay, and why both other cells say `planned`

`ksx monitor --record` writes a session; `ksx play` plays one back into the
real pipeline. Together they are one capability, and today the CLI owns all of
it.

Both other cells are `planned` rather than `never`, and the distinction is the
one §3 draws: nothing is there *yet*, and there is no reason in principle for
that. An attract-mode loop is a **cabinet** feature — it belongs on the egui,
started from the panel with no keyboard in reach, which is precisely what §4
says that surface is for. Recording a session and picking one to replay is a
list and a button, which is what §5 says Studio is good at. Neither is written,
so neither is claimed.

What is genuinely CLI-shaped, and would stay here even after both faces exist,
is the *argument surface*: `--as`, `--speed`, `--game`. Those are the flags of
someone debugging a mapping against a recording, which is a keyboard-and-shell
activity by nature. A cabinet needs one button that says "play the demo" and a
browser needs a list of recordings — neither needs the flags.

## §4 The egui is an appliance panel, not a worse browser

The egui's five screens (`ksx-cabinet/src/nav.rs`) are ButtonCheck, Status,
Session, Profiles, Presets — and ButtonCheck is described in the source as "the
spine". That is correct and it generalises:

**At an arcade cabinet there is no mouse and no keyboard. The panel is the
input.** A browser UI cannot be driven by an arcade stick; the egui already
responds to panel presses. This is a structural advantage no web surface can
take, and it is why "just use Studio for everything" is not on the table.

The egui's job is therefore everything a person does **standing at the machine,
with only the panel to touch**: confirm it works, start and stop, switch
profile. Anything requiring text entry belongs elsewhere.

## §5 Studio is the workbench

Studio binds `127.0.0.1` and refuses anything else — `ksx-studio/src/error.rs`
returns `NonLoopbackBind` rather than serving a LAN address. Since 2026-08-25 it
has **one product page and three tool pages**: `/nocturne` is the product — the
whole set-up-and-play workflow — and `/check` (the button check), `/pads` (the
ViGEm bus and its two verbs) and `/devices` (the picker) are the tools. The shell
says the same thing: every page carries one **Set up & play** link pointing at
`/nocturne`, plus a **Tools** menu listing exactly those four destinations.

### The two-page split was reversed, and that is worth more than a rename

This section used to argue at length that `/start` and `/setup` were two pages
because they were two *contracts*: `/setup` was the disk-backed maintenance
checklist where a write is a complete backend act, `/start` drove
`ksx_core::StagedSetup` and wrote nothing until Save. The paragraph ended:
*"Rebuilding `/setup` around a staged value was the alternative and it was
rejected: one screen holding both rules is a screen where a user cannot tell
which controls commit."*

**The rejected alternative is what shipped.** `/nocturne` is one screen holding
both rules, and the argument against it was not wrong — it was a bill, and the
page now has to pay it. Recording that honestly matters more than quietly
re-pointing the sentence, because the confusion the split existed to prevent did
not go away with the split; it moved from *"which page am I on?"* to *"which
control on this page commits?"*, where nothing structural answers it and only
copy and layout can.

What `/nocturne` does instead of a page boundary:

- **The draft is still `StagedSetup`, still daemon-held, still with no path to a
  file** (`FIRST-RUN.md` §2). Nothing about the staging contract changed. Every
  device choice, controller add, binding edit and SOCD rule lands in memory.
- **Save is still the only disk boundary, and it is a named button in the top
  bar** — `Save`, beside `▷ Play` and `⏹ Stop`, with a saved/unsaved line
  rendered next to it so the answer to "is this committed?" is on screen rather
  than inferred from which page you navigated to.
- **The genuinely disk-backed acts are behind the Configuration menu**, not
  loose among the staging controls: `Load the saved configuration into this
  draft` (`/nocturne/adopt`), `Discard this draft` under a `Start over…`
  disclosure, the saved-game rows, `Export the configuration (download)` and
  `Import a configuration…`. Grouping them is the layout doing the work the
  URL used to do.
- **Play still starts the draft without saving it**, which is the whole reason
  the staging contract exists: a person exploring has not decided anything yet
  and must not be punished for it.

Two things from `/setup` did not survive the move and are not hiding somewhere:
its board step **linked to `/devices`**, and it printed the **config root in
small print for a bug report to quote**. Neither is on `/nocturne` (`grep href:`
over `NocturneIsland.ts` finds no `/devices` link and no root path). The Tools
menu reaches `/devices` from every page, so the first is a demotion rather than a
loss; the second is simply gone, and a person filing a bug now has no on-screen
way to say which config root they were using.

### The rest of the page, and the pages beside it

The mapper is a **region of `/nocturne`**, not a destination: the right pane is
the Mapping inspector, and `/nocturne?slot=N` selects which controller it is
pointed at. Every staged controller is therefore reachable in the full
button/chord/turbo/macro authoring UI without leaving the page — §3c's "no second
mapper" claim is now literally true rather than merely architecturally true.

Saved games keep the customer-facing create/update/delete/switch behaviour
whole: new games inherit matching saved base devices and controller behaviour;
updates preserve game-specific devices by default (or explicitly refresh
keyboard/mouse selectors); the selected layout applies to every resulting
player; delete removes exactly one game and keeps layouts. Update/delete use
backups and stale-write guards in the backend.

`/check` is the one page that performs no verb at all, and the one fed by a
channel that is not the control pipe: `GET /api/live` is Server-Sent Events
over the daemon's own outbound-only feed pipe, which is what lets a press on
the panel light a control in a browser at display rate. It is still a VIEW —
it writes nothing, and it decides nothing, because its whole control roster is
`MapperSlot::bindings`' key set arriving from the backend (§1).

Four pages, dozens of routes — about forty inside the guard layer alone. The
rest are the `/api/*` reads, the mutating form endpoints, the service worker,
the asset handler and three icons. The distinction is not pedantry — it is the
whole reason the CSRF guard is one layer over the router rather than a check per
handler, because "the mapper alone grew eight form endpoints in three
milestones" and the failure mode being prevented is forgetting one. Collapsing
five pages into one did not reduce that count; it moved the endpoints under one
prefix, which makes forgetting one easier to spot and no less fatal.

For the **whole config root**, `/nocturne` has exactly two verbs: Export
downloads it as one JSON document (`GET /nocturne/export.json`), and Import
pastes one back (`POST /nocturne/import`, a dry run unless the write box is
ticked — `ksx config import`'s consent shape, unchanged). Neither takes a path:
`MachineSource::config_export|config_import` are in-memory on purpose, because a
person who asked a page for their configuration should not be handed a directory
to go and find.

> ⚠ **Import's body ceiling is currently wrong in the copy.** The refusal on
> `/nocturne/import` still names 8 MB, which was the `DefaultBodyLimit` the old
> `/setup/import` route carried; that layer did not survive the cutover, so axum's
> 2 MB default applies and a whole-cabinet export between the two sizes fails with
> a bare 413 under a message quoting the wrong number. That is a Studio defect,
> not a documentation one, and it is written here because this is the paragraph
> that promises whole-cabinet import.

The mapper is good enough to stop treating as supplemental tooling. Authoring a
25-binding preset is a pointer-and-keyboard task and the browser is simply
better at it than immediate-mode GUI. **Studio is promoted to a core surface for
authoring** — co-equal with the egui, not above it. (`render_map.rs` is still
1,782 lines and still the mapper's server half; what the cutover deleted was the
`/map` *page*, not the mapper.)

It is deliberately *not* promoted to primary for operating. If Studio were the
only way to start a session, a cabinet in attract mode would need a web server,
a free port and a browser running before anyone could play. That is a worse
appliance than the one that exists now.

## §6 Product launch and cabinet-to-Studio navigation

Windows customer launch is `ksx-launcher.exe` → sibling `ksx.exe open` → an
idle or configured daemon → Studio `/nocturne`. The launcher is a GUI-subsystem
handoff used by the installer and customer shortcuts, not another surface.
The empty-config daemon owns the control pipe/tray while doing no emulation
work, which is what makes first-run staging reachable.

> ⚠ **This sentence is the spec; the product does not obey it yet.**
> `ksx-backend/src/studio_launch.rs` still builds `http://127.0.0.1:4460/start`,
> and the router has no fallback and no redirect, so the installer shortcut, the
> Start-menu entry, the desktop icon and the tray's "Open ksx" all open a
> chrome-less window on a 404 with no address bar to correct it in. A test in the
> same file pins the wrong value, which is why nothing went red. Fixing this is a
> Studio/backend change, not a documentation one, and it has to land before
> `RECOVERY.md`'s "there is now a way back that is not a command" is reachable
> and before `FIRST-RUN.md` §7's Gate 4 can be run at all.

The cabinet app has an "Open Studio" action. That direction is correct: the
process already running at the machine can open the workbench.

**The reverse was rejected.** A browser cannot launch a native app without a
registered custom protocol (`ksx://`), which means writing registry entries at
install time and a security prompt on every click — real friction and a real
install-time footprint, bought for a convenience the egui already provides in
the direction that works.

## §7 LAN access needs a pairing token, and the guard needs to learn about it

`ksx studio --help` already records the intent:

> Localhost only — there is no LAN option; that arrives with the pairing token.

**A LAN bind is not the same class of problem as a Node dev server on a laptop.**
That comparison is tempting and wrong. A dev server serves files nobody attacks;
Studio can **start and stop input capture, stream per-key activity, create test
pads, rewrite config, and request an installed exact-device WinUSB
prepare/release transaction**. The fixed elevated helper keeps that request
from becoming arbitrary privileged execution, but the capability makes a LAN
token more—not less—necessary. A home network is not a trust boundary: a guest
phone, a smart TV or a compromised IoT device is on the same WiFi.

So LAN access is: bind beyond loopback, require a token, reject anything
unauthenticated. Two consequences worth writing down before the work starts:

- **Discovery is a QR code in the egui.** Nobody types
  `http://192.168.1.47:4460/?t=xK9m…` on a phone. A copyable URL is the laptop
  fallback, not the primary path.
- **`ksx-studio/src/guard.rs` will reject it — twice, and the second one is the
  easy miss.** There are two independent checks and a LAN bind has to clear
  both:

  1. `is_loopback_host` on the `Host` header, the DNS-rebinding defence. A LAN
     address fails it, and the request never reaches a handler (421).
  2. `is_own_origin` on the `Origin` header of every mutating request. A form
     posted from `http://192.168.1.47:4460` fails it too, because the origin
     check ends in *and the host is a loopback name*.

  Fix only the first and you ship a Studio that **renders on the phone and
  refuses every button** — a 403 on every form, which reads as a broken app, not
  as a security feature. Both checks now consult the bound address, so each
  passes for the address ksx is actually serving on; that half is inert while
  the bind stays loopback-only, and it is pinned by two tests in `guard.rs` so
  the LAN change-set cannot land with the trap still in it. What is still
  missing is the token, which is the part that makes the bind *safe* rather than
  merely *working*.

  Writing those tests turned up the same shape of bug already shipped: the two
  checks disagreed about `[::1]`. `Host` accepted it, `Origin` did not — an
  already-split IPv6 name was being re-split on its own colons, so `::1` became
  `::` — and a dual-stack machine that landed on the IPv6 loopback got a Studio
  that rendered and 403'd every form. Exactly the failure this bullet predicts,
  arriving early and by a different route.

## §8 Mobile: responsive-only, aimed at diagnostics

No dedicated touch layout yet, and no deferring mobile either — because there is
one phone use case that beats every other surface:

**You are behind the cabinet with the panel open, pressing buttons, and the
phone in your hand shows which key fired.** That is ButtonCheck on a phone, and
it is better than walking round to the monitor for every wire.

Two corrections to how that reads — the first of which was itself wrong, and
is kept because *how* it was wrong is this repo's most instructive audit
failure to date:

**The viewport tag was never missing.** An earlier revision of this section
said "responsive-only currently means not responsive at all: there is no
`<meta name="viewport">` anywhere in `studio-ui/` or `ksx-studio/assets`", a
task was filed to add the one line, and the line was added — producing a
DUPLICATE, because `forma-server`'s own template (`template.rs`, 0.1.4 and
0.2.0 alike) has emitted the tag on every page this crate ever rendered.
Three separate greps reached the same false conclusion the same way: they
searched the page's *source*, and the head of these pages is assembled by a
dependency, so the truth was only ever in the *output*. The claim is now
pinned where the truth lives — `render.rs::assert_complete_head` reads the
rendered HTML and asserts the tag is present, in `<head>`, exactly once —
and the lesson generalises: **an audit of a claim about output must read the
output.** Breakpoints and media queries therefore already fire on phones;
what they fire *against* is layouts nobody has tuned, which is the actual
work (task #24).

**The missing Studio live channel was real at the audit and is now closed.** At
that point there was no feed on `AppState`, no frame type and no handler, so the
phone argument rested on an egui-only capability. Today `/check` gets its
control roster from the ordinary snapshot and lights it from `GET /api/live`,
an SSE bridge over the daemon's outbound feed pipe (§5). The matrix therefore
calls Studio a `view`, not `planned`: it renders live backend state and performs
no decision or write.

What remains is the responsive pass itself: tune `/check` first for the behind-
the-cabinet phone use case, then `/nocturne`, whose top bar and Configuration
menu now carry the status reading that used to be its own page. The ordering
argument survives the cutover but changes scale: mapping asks you to press the
key it is capturing, which a phone cannot do for a desk keyboard, so it is still
the least valuable thing on the smallest screen — except that it is no longer a
separate page that can simply be tuned last. It is the centre and right pane of
the page that must work on a phone, which means the responsive pass on
`/nocturne` is a question of what COLLAPSES rather than what is deferred.

## §9 User flows worth writing down

Five journeys carry nearly all the product's surface area:

1. **First-time setup and later repair** — two related journeys, and since
   2026-08-25 they are two journeys on **one page**. `ksx open` lands on
   `/nocturne` and so does everyone else; there is no second page to choose, and
   therefore no history-based fork to get wrong. `/devices` remains
   read/pick/remove only. The journey has the one deliberate exception it always
   had: a separate top-level, three-consent installed WinUSB preparation/release
   card for the exact selected keyboard. Picking a keyboard row itself still
   changes only the in-memory stage.

   **`/nocturne` is the download-to-gaming path** (`docs/FIRST-RUN.md`
   moments 4–7): pick a keyboard from a list nobody had to ask for, pick what it
   should become, map buttons/chords/turbo/macros in the same mapper, answer
   split-or-freeze, then save or play. It reads the live device/pad state and
   available controller layouts, but it does not seed the proposal from
   `config.toml` and writes no file until Save. The person walking it has not
   decided anything yet and must not be punished for exploring. Play can happen
   without Save. Its whole draft is one `ksx_core::StagedSetup` in the idle
   daemon/control host. The final Guide instruction is conditional on Windows'
   controller-to-Game-Bar setting; `FIRST-RUN.md` §7 requires it to offer
   `ms-settings:gaming-gamebar` as the direct remedy, and **that link has never
   shipped on any page** — a spec debt, not a casualty of the cutover.

   **The repair journey is the same page entered from a different place.**
   Someone who already has a configuration opens the Configuration menu and
   loads it into the draft (`/nocturne/adopt`), or loads one saved game's
   controllers, and then edits exactly as a first-run visitor does. Because
   there is no multi-step pending wizard transaction, an abandoned run leaves
   the last complete config valid — that property came from the staging
   contract, not from the page count, so it survived the merge intact.

   What did NOT survive is the checklist itself. `ksx-backend::onboard`'s pure
   `plan_steps` still decides the ordered steps and `SetupView` still carries
   them, but `SetupRows::of` — the one composer that turned them into rows — is
   now reachable only from its own unit tests. The backend read outlived its
   face, which is precisely the half of §1 this file exists to keep visible:
   *a backend verb with no face is not finished either.* `/nocturne` still
   consumes the rest of `SetupView` (whether a config exists, the theme rows,
   the persona roster); it does not draw the numbered rail.
2. **Change a mapping** — running cabinet, one binding is wrong.
3. **"It doesn't work"** — the diagnostic path, which must terminate in a cause
   and not a shrug.
4. **Start a session** — the everyday path, and the one that must never need a
   keyboard.
5. **Manage saved games** — create, repair, rename or delete a game and switch
   to it entirely in Studio, from the **Saved games** section of `/nocturne`'s
   Configuration menu. Program paths are edited in the per-game disclosure; no
   TOML or CLI is part of the customer flow. One capability is currently
   missing a face rather than missing: `UpdateProfile::rebase_devices` — "point
   this game's slots at the devices I have since saved" — has a handler and a
   form field and no checkbox, so it cannot be asked for.

Each should name the surface it happens on. Where a flow crosses surfaces, that
crossing is a design smell worth a second look.

## §10 What this settles for open work

- **Slot persona menu** — **settled and built, 2026-08-08 (task #8).** The
  decision stands as it was written: authoring, so Studio primary, egui view.

  The wire type changed, which is what this entry was waiting for.
  `SlotAssignRequest` now carries `persona` as an **optional string**, and both
  halves of that are load-bearing. *Optional*, because `Persona::default()` is
  `xbox360`: a defaulted field would have read every pre-2026-08-08 request as
  "make this slot an Xbox 360 pad" and silently un-PlayStation-ed slots 5–8 the
  first time somebody re-pointed a preset. *A string*, because ksx-core carries
  no serde and the alias table lives in one `FromStr` — a surface must never
  hold a copy of it to fill this field. The serde test that pinned the old
  field set still pins the new one; it was renamed and re-argued, not deleted.

  What each surface got, and why:

  - **Backend** (`ksx-backend/src/slots.rs`) applies it, and refuses two things in
    words: a persona this build cannot plug (`Persona::can_plug`, which reads
    `PadBackend::supports(persona)` and never a driver probe) and a fifth XInput
    slot — counted **after** the write would land, over the whole destination
    file, so the refusal is about the config that would exist rather than about
    the one field being touched.
  - **CLI** — `ksx slot assign --slot N --persona P`, lenient parsing through
    the same `FromStr`. Preset and persona are independently optional: either,
    both, or the preset alone.
  - **Studio** — the picker is the radio-card grid on `/nocturne`'s "Create a
    virtual controller" form, which POSTs `/nocturne/controller`; SOCD is its
    sibling verb `/nocturne/controller/socd`.

    *The argument this bullet used to make is now moot by construction, and
    that is worth a sentence rather than a silent deletion.* It read: the picker
    sits on `/setup`'s "Wire a slot" form and **not `/profiles`, which has no
    slot rows**, because a second slot editor on a second page would be two
    front doors onto one verb. Both pages are gone and there is exactly one page
    left, so there is exactly one front door — the drift §1 forbids is no longer
    available to commit here. What replaced the pair is not a third door but the
    absence of a door: `ControlSource::assign_slot` has no Studio caller at all
    now, and a slot's persona is set when the controller is created and changed
    on the controller itself.

    The roster is still served, never composed in TypeScript. It is
    `snapshot.rs::StartRows::personas` — this build's pluggable personas in
    `Persona::ALL` order, each carrying its display label, its immutable backend
    and any per-session ceiling — plus stage-specific availability: after one
    DualSense, or after all four XInput places are occupied, the impossible
    persona is removed from Add/Change while the other live personas remain.
    The full roster is never erased, because a menu that silently drops three of
    eight choices teaches a user the product has five.
  - **egui** — renders the persona in the Presets screen's slot rows. No
    picker: §4's rule is that anything needing text entry or a menu of five
    belongs elsewhere, and re-personaing is a between-sessions authoring act,
    not something done standing at the cabinet mid-evening.
- **Device pick UI** — Studio, following the existing CLI verb (§3). Also the
  egui: §3 row 3 no longer claims a view exists there. `/devices` is still the
  only picker, and the product page still does not grow a second one — but the
  in-page LINK to it that `/setup`'s first step carried did not survive the
  cutover. The Tools menu is what reaches `/devices` now, which is a weaker
  pointer for someone who does not know the tool exists (§5).
- **`ksx games new|update|delete` — the CLI half of saved-game CRUD, owed.**
  `/nocturne`'s Configuration menu calls typed `MachineSource` verbs over pure
  plan/apply pairs in `ksx-backend::profile_edit` (`/nocturne/game`,
  `/nocturne/game/update`, `/nocturne/game/delete`); the CLI row is now honestly
  `planned` instead of hiding that absence inside configuration verbs. A future
  CLI is a thin driver over these same planners, not new profile logic.
- **Cabinet slot list scrolling — DONE, and not the way this entry said.** It
  read "still broken above four slots ... what is missing is any
  scroll-to-focus call" long after `crates/ksx-cabinet/src/list.rs` shipped,
  and it sent a reader (2026-08-12: me) off to rebuild something that was
  already there. Worse, the remedy it named was the wrong one: a scroll-to-focus
  is still a scroll bar underneath, and §4 says this surface has no mouse, no
  wheel and no Page keys. The list PAGES instead — `per_page` and `window`, two
  pure functions, no scroll offset and no animation — and anchors to a page
  rather than following the cursor, so what moves when the joystick moves is
  the cursor and not the world under it. Pinned by
  `every_slot_is_drawn_inside_the_panel_when_the_cursor_is_on_it`, which puts
  the cursor on each of the sixteen slots in turn and requires the row to be
  inside the panel.
- **LAN + token + QR** — one coherent change-set, not three (§7), and the guard
  has two checks in it, not one.
- **Viewport meta tag** — one line, and the precondition for anything in §8.
