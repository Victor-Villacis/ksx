# Handoff

For whoever takes this over. It says what ksx is, how it is built, what is
finished, what is not, and — most usefully — **which beliefs about this codebase
turned out to be false**, because several of them cost a day each to discover.

Updated 2026-08-10 for the standalone **KSX 0.2.0** release candidate. Software
gates and a packaged build are evidence about the tree, not a release or a
physical cabinet acceptance result; the supervised checks in `docs/GATES.md`
remain open until someone records them on the target hardware.

---

## §1 What ksx is

ksx splits one keyboard into as many as sixteen virtual game controllers on
Windows 11. Press `A` on an arcade panel and player 1's gamepad sees a button;
press `R` and player 2's does. That is the whole product, and everything below
serves it.

KSX is its own Rust product and repository. Prior work that informed early
domain research is acknowledged in `README.md`; copied third-party material is
catalogued in `NOTICE`. Neither is a runtime, migration, or release dependency.
Current setup starts in Studio and writes KSX's own configuration.

Two properties are contractual, and breaking either is a regression no matter
what else improves:

- **Fan-out.** One physical keyboard drives many slots with disjoint key sets.
  This is not a special case; it is the point.
- **The escape hatch.** LeftCtrl five times toggles keyboard capture off or on
  while KSX is running; turning it off gives every active backend's input back
  without ending Play. It lives in the capture thread, so no UI or browser can
  starve it. Interception returns to Windows on process death. A WinUSB-prepared
  keyboard is structurally outside the keyboard stack and needs the installed
  Release transaction if KSX is not running; that is why preparation requires a
  separately tested spare keyboard. Stop or Ctrl+Alt+Del ends Play.

---

## §2 The shape of the code

The dependency direction is the architecture, and it is worth learning before
touching anything:

```
ksx-core ────────► (nothing)      domain: keys, engine, personas, DeviceSelector
ksx-config ──────► core           TOML: config, games, presets, validation
ksx-api ─────────► core, config   THE WIRE CONTRACT between backend and surfaces
ksx-platform ────► core           Windows: USB enumeration, WinUSB claim/release
ksx-capture ─────► core, platform capture backends behind one trait
ksx-output ──────► core, hidmaestro  ViGEm pads, persona routing
ksx-backend ─────► all of the above  every verb's logic, the daemon, the supervisor
ksx-app ─────────► backend + surfaces  ONE FILE: clap definitions and a match
ksx-launcher ────► Windows only        GUI-subsystem customer hand-off to `ksx.exe open`
ksx-winusb-helper ► platform           installed-only GUI/UAC prepare, release, cleanup-owned
ksx-studio ──────► api, core, config   the browser UI
ksx-cabinet ─────► api                 the 10-foot egui panel
```

**`ksx-studio` and `ksx-cabinet` do not depend on the backend.** They reach it
only through `ksx-api` traits. That is what makes `docs/SURFACES.md` §1 — *the
backend owns state, every surface is a view* — a checkable property rather than
a slogan, and it is the single most important line in the graph.

`ksx-app` was 50,665 lines until 2026-08-09. It is now 3,798: clap derives and
one dispatch `match`. If you are looking for logic, it is in `ksx-backend`.
`ksx-launcher` is not a fourth surface; it is the console-free Windows hand-off
used by the installer and shortcuts. `ksx-winusb-helper` is not a surface
either: it is the fixed requireAdministrator transaction boundary invoked only
by installed `MachineSource` calls. `cargo metadata` reports 16 current
workspace packages; the replaceable C `libwdi.dll` provider is corresponding
source, not another Rust package.

### The three surfaces, and why there are three

`docs/SURFACES.md` is the authority; the short version:

- **CLI** — the development surface and the intended first driver for backend
  capabilities. It is the cheapest backend surface to test and the broadest
  one CI drives headlessly; CI also drives Studio through its pinned Playwright
  browser checks. Two current parity debts are named rather than hidden:
  staged setup and profile CRUD have typed backend contracts and Studio faces,
  while `ksx stage` and `ksx games new|update|delete` remain planned
  (`docs/SURFACES.md` §3c and §10). The product does not require either CLI face
  (`docs/FIRST-RUN.md`).
- **Studio** (browser) — the workbench. Authoring: mapping, devices, profiles,
  the first-run flow. Better than immediate-mode GUI at a 25-binding preset.
- **egui cabinet panel** — the appliance. At a cabinet there is no mouse and no
  keyboard; the arcade panel *is* the input, and no browser UI can be driven by
  an arcade stick. That is why this surface cannot be deleted.

---

## §3 What is done

**Current software baseline:** a Windows installer that puts an icon on the
desktop, offers the bundled ViGEmBus driver from an explicit checkbox, and hands
off to the app; `ksx open` starts the daemon and opens a chrome-less window. The
first-run flow lists devices by human names, stages a controller before anything
is written or plugged, prepares one exact supported USB keyboard through a
three-consent UAC flow when clean-machine capture requires it, asks
split-or-freeze in the user's own words, and can Play without saving. Studio
includes a separately confirmed Release action, saved games, setup, controls and
button check; the backend also supports recorded-session replay, a unified
USB+Bluetooth device list, and multiple controller personas.

**KSX 0.2.0 candidate:** every customer shortcut and the
post-install hand-off target `ksx-launcher.exe`, which starts the sibling
console-subsystem `ksx.exe open` with `CREATE_NO_WINDOW`. `ksx open` starts and
waits for a plain daemon, then opens Studio directly at `/start` in ksx's own
Chromium app profile. An empty default configuration now starts an **idle
control host** rather than exiting: no session, capture, claim or pad exists,
but the pipe/tray remain available so first-run staging is possible.

The installer also carries `ksx-winusb-helper.exe`, its fixed sibling
`libwdi.dll`, the provider's complete corresponding source, and a protected
machine-wide journal. The portable ZIP omits all three installed-only
components together. Prepare/release never accepts a browser backend or helper
path: the server fresh-revalidates exact selector and instance, the helper
journals and compensates, and the API accepts only fresh exact `prepared` or
`released` state before the staged backend changes. Uninstall stops the session
and proves the fixed autostart task absent, then runs `cleanup-owned` before
deleting any recovery component, and aborts if ownership or absence cannot be
proved. Both happen in `usUninstall` — after the user has confirmed the removal,
before Inno deletes its first file — so answering No to the confirmation costs
nothing.

`/start` now opens the full existing Forma mapper against an in-memory staged
controller (`target=stage`) for chords, turbo and macros. Refused edits leave
the stage unchanged; accepted edits touch no disk. Save and Play remain
separate, including Play-before-Save. Studio's saved-game screen now creates,
updates, deletes and switches profiles; creation inherits the working base
device assignments, updates preserve them unless explicitly refreshed, and
deletion keeps controller layouts. Pasted executable paths normalize one
matching quote pair. Guide copy names both default keys, the Windows Game Bar
controller prerequisite and a direct Settings link; ksx does not silently
change the per-user Windows setting.

**Studio theming (TK0–TK3, 2026-08-20):** the whole palette lives in ONE
source, `studio-ui/tokens/` (DTCG-flavored JSON compiled by
`tokens/build-tokens.mjs` inside `node build.mjs` into the hashed sheet, the
generated `theme_tokens.rs` and the pad-art sheet — the four hand-mirrored
palette copies are gone). Themes are user-selectable at runtime: `/setup`
carries the picker, the choice persists as `Settings.theme` in config.toml,
every page stamps `data-theme` on `<html>` (only roster ids; anything else
renders as System = follow the OS), and the contrast gate enumerates every
shipped theme with per-theme exemption pins. Three ship: dark (default),
light, matrix — matrix cost one JSON file plus two pin rows, which is the
system working as designed. Adding a theme touches no component CSS, no TS
and no hand-written Rust. Design record with the open decisions (Nocturne
prototype palette as a fourth theme vs. deletion at M5, theme fonts):
`docs/research/token-system-design.md`.

**Milestones:** M0–M3, M6.5, M7, M9, M10a are done. M4, M5, M6 are
code-complete and **cabinet-gate pending** (§4). M8 now has the production
adapter (`ksx-output::HidMaestroBackend` through the router), the
authenticated KSXH transport, a three-persona runtime candidate and the
installer bootstrap; the incompatible latch adapter was removed. What remains
is the SUPERVISED HARDWARE LIFECYCLE — no HIDMaestro device has ever been
observed to exist; see `docs/HIDMAESTRO-STATE.md` for the measured state. M8.1 adds VIIPER later as a
complementary virtual-USB/network/Linux lane while ViGEmBus remains the shipped
X360/DS4 fallback. See `docs/HIDMAESTRO.md` and `docs/ENHANCEMENTS.md` E1.

---

## §4 What is not done — in priority order

### 1. GATE 3 — three milestones need one supervised evening

`docs/GATES.md` has the runbook. M4 needs its p99 measured during a real
4-player session; M5 needs GATE 1's Phase C (the frontend wrap); M6 needs a
session with **Interception uninstalled**, then a 14-day soak with zero recovery
actions. Nothing else can close these — they are measurements and a removal, not
code.

### 2. The first-run software flow is complete; physical Moments 4 and 7 are not

`docs/FIRST-RUN.md` §1 numbers seven moments and §7 is the acceptance test: *a
person who has never seen ksx gets from the exact downloaded installer to a
controller moving in a game, with no terminal, no file editing, and nobody
telling them what to do next.* The missing staged mapper and wrong landing page
described by the old handoff are closed: `/map?target=stage` routes bindings and
macros into `StageEdit::SetBindings`, and `ksx open` lands on `/start`.

**Moment 4's built-in prepare and Moment 7 remain unverified on physical Windows
hardware.** Software tests
prove the Guide bits, P1 Left Windows/P2 Numpad `*` bindings and Settings
remedy, exact transaction/refusal/rollback logic, installed-only packaging and
uninstall gates. They do not prove UAC and the machine-local certificate worked
on a clean physical machine, a clean install produced a real pad, the app opened
with no console flash under the original user, or Windows displayed Game Bar.
`docs/GATES.md`'s release-product gate is the authority.

**Four defects found by installing it, 2026-08-10 — all fixed, all invisible to
CI, and the pattern is worth more than the list.** Each was guarded by a green
check that could only ever be green:

| defect | why CI could not see it |
|---|---|
| `PrepareToInstall` ran `initialize-store` from `{tmp}`, which the helper refuses because the invoking user owns it — **every install died at exit code 3** | the hostile-junction smoke asserts setup exits nonzero and copies no files, which was true for every input while the install died at step one |
| `STORE_DIRECTORY_SDDL` granted `GRGX`; Windows maps generic rights and splits the ACE, so the byte-for-byte `verify_exact_dacl` could never match — even on a directory the helper had just created | that smoke also asserts `C:\ProgramData\KSX` does not exist first, so a successful `initialize-store` had never executed anywhere |
| the provider was handed `\\?\` verbatim paths; it accepts drive-letter paths only | the provider smoke hand-builds a plain `C:\Program Files\...` path |
| `device_id`/`hardware_id` were populated; with `external_inf` the provider refuses any identity field | the smoke builds its device struct in PowerShell, which zero-initializes exactly those fields |

Every one has a regression test that asserts *the other side's* rule and fails
against the shipped version. The lesson is the second column: a smoke that
exercises only the shape that works proves nothing about the shape the product
sends.

**Six more found by using it, 2026-08-11 — the day preparation first worked.**
Getting past the install revealed the next layer, and it is the same pattern one
step further in: code that had never executed, because the thing before it had
never succeeded.

| defect | why nothing caught it |
|---|---|
| the mapper went deaf on a prepared board: `learn-key` observed Raw Input, which a claimed interface has structurally left | no test ever learned a key from a claimed device; `rawinput.rs` and `CONTROL-SURFACE.md` both already SAID this would happen, filed as a follow-up |
| release ended on `Releasing`, so a rebind that committed was reported as a failure | `rollback_installed` passed a `RecoveryRequired` through assuming it was persisted — true for `set_recovery`, false for the two callers that construct it directly, and no test drove that pair |
| "Split this keyboard" was bit-for-bit "Freeze" on a claimed board: the `Take` was read for its device list and dropped | no coverage of `bound-keys` on a claimed board; the end-to-end split test drives the mock/Interception path |
| preparing twice reported "Windows could not prepare this keyboard" | one refusal code covered every wrong binding, including the two that mean "already done" |
| Setup restarted ksx into its own install, racing `initialize-store` | Inno's default; only reproducible on a machine that already had ksx running, which CI never is |
| every refusal named "Driver recovery in KSX", a surface that does not exist | `cleanup-owned` has no caller outside the uninstaller, and nothing checks that advice names something real |

One reported symptom was **not** a defect and is worth recording as such: no
`config.toml` after a session of exploring. Play-without-Save writes nothing, on
purpose (`FIRST-RUN.md` §2, pinned by `stage.rs playing_leaves_the_config_untouched`).
It looked wrong for a real reason, though — `StagedSetupView::ready` is false
while any slot binds nothing, so with the mapper deaf, **Save was never
clickable all session**. Defect 4 was a consequence of defect 1 wearing a
correct-behaviour disguise. When a "not a bug" is reported, check what made the
user look.

The recurring lesson, now three sessions deep: **a check that has only ever run
against the passing shape proves nothing.** Every green check that hid one of
these was structurally incapable of failing — asserting a nonzero exit that was
nonzero for every input, or building its own inputs in a language whose defaults
happened to be correct. The counter-measure is a control case: prove the check
fails when it should, in the check itself.

### 3. Diagnosing an elevated helper refusal

The helper is launched through `ShellExecuteEx` for the UAC prompt, which
**cannot redirect stdout**, so the JSON naming the refusal is discarded by
Windows. The backend now logs the operation, instance and exit code with its
meaning (`crates/ksx-backend/src/winusb.rs`), which is enough to tell a refusal
from an internal fault — but not enough to name it.

To read the actual message, run the same verb from an elevated prompt with
output redirected:

```powershell
Start-Process 'C:\Program Files\ksx\ksx-winusb-helper.exe' -Wait -PassThru `
  -ArgumentList @('prepare-exact', '<instance-id>',
                  '--confirm-spare-keyboard','--confirm-rebind','--confirm-machine-certificate') `
  -RedirectStandardOutput out.json -RedirectStandardError err.txt
```

`err.txt` carries libwdi's own trace, which is what identified two of the four
defects above. **If this is still necessary, the next improvement is the helper
writing its final JSON into the protected store** so the backend can read and
log it without a hand-run script.

### 4. LAN access + pairing token + QR (task #23)

Studio binds `127.0.0.1` and refuses otherwise. The intent is recorded in `ksx
studio --help`. **It needs its own security review, and the live feed changed
the threat model**: an unauthenticated stream of a user's keystrokes on the LAN
is a different problem than an unauthenticated config page. Note `guard.rs`
deliberately allows a request with no `Origin` header — correct on loopback,
insufficient on a LAN, because `curl` sends none either.

### 5. Smaller, tracked

Remaining mapper polish in `docs/MAPPER-UX.md`; the any-HID-as-input easter
egg; code signing (an unsigned installer throws
SmartScreen at every new user — Azure Trusted Signing is ~$10/month).

---

## §5 Things that are true and surprising

Each of these was believed otherwise, and each cost real time.

**A device path is not always port-derived.** Windows keys a devnode off the USB
**serial** when the device reports one, and off the socket only when it does
not. Measured on the cabinet: an I-PAC 4X's instance path survived a move from
root port 5 to port 7 **byte for byte**. `DEVICE-IDENTITY.md` §1 asserted the
opposite and three code sites cited it as authority. ksx cannot tell which kind
of path it holds once the board is absent — a serial lives in the descriptor of
a device that is not there — so **no message may assert that a board moved**.

**Two identical boards cannot be prepared independently through one package.**
An INF binds by hardware id, which twins share, so preparation refuses
`SharedHardwareId` while both are present. The consent says to release before
connecting another identical keyboard. If a twin is connected later, Studio
requires it to be unplugged before Release so it never guesses which staged
device was intended. Removing the receipt's OEM package is still package-wide,
so the twin returns to HidUsb on reconnect. The port rung tells twins apart in
config; package scope does not. Do not read “twins work” — read “twins are never
silently confused.”

**Bluetooth keyboards can be split but never WinUSB-claimed.** They enumerate
under `BTHENUM\`, not `USB\`; WinUSB binds a USB interface and there is none.
Interception sees them fine. Also: a paired-but-disconnected BT keyboard reads
as *present* all day, so it is listed but excluded from last-keyboard
arithmetic — otherwise someone reads "2 keyboards", claims their panel, and is
locked out by a keyboard in a drawer with dead batteries.

**A failed read is not an absence.** "I could not enumerate" and "you have no
devices" are different sentences and users act on them differently. This
project's signature bug is reporting success while the panel is dead — a session
once read healthy because a WinUSB board had silently fallen back to
Interception. `SURFACES.md` §1b.

**`ksx-app`'s test target loses `fn main` as a liveness root** (rustc 1.97), so
the whole runtime-only chain reads as dead code there and nowhere else. Hence
`#![cfg_attr(test, allow(dead_code))]`, with the bin target remaining the
authority.

---

## §6 How to work on it without losing a day

**Read `CLAUDE.md` first.** It is the map — crate layout, the shapes to copy,
every landmine. It exists because agents were re-reading the whole codebase to
orient, at enormous cost.

**Push your branch; let CI gate it.** `rust-toolchain.toml` pins 1.97.1 and CI
runs on every branch: fmt, workspace clippy, **all four feature combinations**,
the full suite, the pinned-Chromium Studio parity/visual-smoke job, plus the
installer compile. Do not run the four-way matrix locally.

> **Only a clean CI runner produces shippable binaries.** Local builds are useful
> diagnostics, but they include developer-host state and are not release
> evidence. Reproduce unexpected compiler failures on a clean runner; publish
> only the artifact tied to the release commit, pinned toolchain and lockfile.

The workflow now builds the prepare-only provider twice and compares hashes,
runs its disposable elevated `pnputil /add-driver` (without `/install`) smoke,
checks the helper's x64 GUI subsystem and requireAdministrator manifest, then
packages the installer. That workflow existing is not a PASS: the clean-runner
provider smoke and all physical Gates 1–4 are **NOT RUN** for the current 0.2.0
candidate until Actions/the gate ledgers record otherwise.

**The four feature combinations are not paranoia.** `studio` and `cabinet` are
independent opt-ins, the default build compiles neither, and five breakages have
reached main through that gap.

**Never hand-merge generated assets** (`crates/ksx-studio/assets/*`). Regenerate
with `cd studio-ui && node build.mjs`. They are `-text` in `.gitattributes`, so
a clean rebuild leaves `git status` clean — if it does not, something really
changed. A hand-resolved manifest yields a page whose HTML and JS disagree. No
Rust test sees that seam; the CI Playwright parity guard does.

**Doc section numbers are load-bearing.** ~30 code sites cite
`DEVICE-IDENTITY.md` by §number, and `crates/ksx-app/tests/docs.rs` fails the
build if a cited section stops existing.

**A test must fail against the broken version**, and say in a comment which one.
Two tests were found passing by coincidence in a single evening — both asserted
a literal where they meant "the default", and held only while those happened to
be the same string.

---

## §7 Releasing

`docs/RELEASING.md` is the runbook. Short version: a **CLI-pushed tag** is the
trigger — `git tag v0.2.0 && git push origin v0.2.0`. A tag pushed from inside
Actions does not fire workflows, so it must come from a person's machine. CI
builds on a clean runner, re-hashes the installer, refuses to publish if the
hash disagrees, and attaches it to a GitHub Release with the SHA-256 and source
commit in the notes.

`Cargo.toml` and `packaging/ksx.iss` both carry the version and the release
**fails** if they disagree — deliberately, rather than patching one, because
`AppVersion` is also `VersionInfoVersion` and the Apps & Features row.

A clean CI/ISCC run proves compilation, packaging and reproducible committed
Forma assets, and runs Studio's Playwright parity and visual-smoke checks. It
does **not** prove installation behavior or replace human visual review. Before
tagging, run the fresh-customer product gate and the still-open Gate 3 in
`docs/GATES.md`; record the exact setup.exe SHA in the gate log.

---

## §8 The map of the docs

| you want | read |
|---|---|
| where things are, what will bite you | `CLAUDE.md` (repo root) |
| the milestone table and the pipeline | `ARCHITECTURE.md` |
| which surface a capability belongs on | `SURFACES.md` |
| the customer's journey, as a spec | `FIRST-RUN.md` |
| how a device is identified, and why not by path | `DEVICE-IDENTITY.md` |
| what each control surface can do | `CONTROL-SURFACE.md` |
| keys, chords, turbo, SOCD, macros | `INPUT-TRANSFORMS.md` |
| supervised hardware runbooks | `GATES.md` |
| the panel is dead / a claim went wrong | `RECOVERY.md` |
| driver policy: pins, signatures, consent | `DRIVERS.md` |
| the mapper's UX contract and remaining polish | `MAPPER-UX.md` |
| Studio's visual language | `DESIGN-SYSTEM.md` |
| why there is no native config UI | `M9-DECISION.md` |
| the idea/enhancement ledger | `ENHANCEMENTS.md` |
| which topologies are proven vs untested | `USE-CASES.md` |
| cutting a release | `RELEASING.md` |

`docs/research/` holds dated investigations. **Do not "correct" them** — a
research file edited to agree with a later decision stops being evidence of
anything.

---

## §9 The one thing to keep

If everything else here is rewritten, keep this: **do not let a screen report
success it cannot verify.** Every serious defect in this project's history has
that shape — the session that read healthy while the panel was dead, the
refusal that asserted a port move it could not know about, the page that said
"no devices" when it meant "I could not look", the test that passed against a
coincidence. The tests, the doc citations, the parity guard and the staged-setup
type all exist to make that failure mode expensive.

A user standing at a cabinet with a dead panel and a green status screen has
been failed worse than one who got an error.
