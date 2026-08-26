# Standalone release gates — supervised runbooks

Four release gates require a person at a real Windows machine. The first three
exercise hardware and long-running operation; the fourth proves that the
artifact CI built is a product a new customer can install and use. These are the
scripts for those sessions: exact actions, what each one should show, and what
to do the moment one of them does not. A session walking an operator through a
gate should follow it top to bottom and never improvise past a failed step.

> **Current-candidate QA reset:** Gates 1–4 start **NOT RUN** for every new
> `ksx-candidate-manifest.json`. Evidence from a prior run does not count. Fill
> the ledgers while testing the exact tag-run installer; a different manifest,
> Release run id/attempt, or artifact hash is a different candidate and resets
> the affected gate.

- **GATE 1 — "M5 rest"**: autostart at boot, the tray daemon, and the frontend
  wrapper. Software-only; Interception semantics; every failure is recoverable
  with a keypress or a taskkill.
- **GATE 2 — "M6 installed WinUSB preparation"**: the first time installed
  Studio changes what a device *is* to Windows. Read the preconditions twice.
  The whole gate is a round trip — prepare, verify, release — and the machine
  ends it exactly as it started.
- **GATE 3 — "closing the books"**: one real four-player latency run, the
  frontend wrapper, deliberate Interception removal, and the fourteen-day soak.
- **GATE 4 — "fresh customer"**: the exact CI installer, a clean Windows user,
  and the complete launcher-to-Game-Bar journey with no terminal or TOML.

## Shared rules (cabinet gates 1–3)

- **conhost, not Windows Terminal.** Windows Terminal 1.24/1.25 fail-fasts when
  virtual pads send input — even as a background window — taking every tab with
  it, ksx included (`RECOVERY.md`, "Known environment hazard"). `Win+R` →
  `conhost.exe`, run ksx there. The tray daemon
  and the frontend wrapper are immune (no Terminal attachment); every
  *interactive* ksx command in these gates is not.
- **Logs land in `%APPDATA%\ksx\logs\ksx.<YYYY-MM-DD>.log`** — every command,
  panics included, 14 days kept. When a step's output scrolled away or a window
  vanished, the log is the record. Check it at the end of each gate for
  `WARN`/`ERROR` lines you didn't see live.
- **"Clean" after any session means all of:**
  1. exit code 0 (`$LASTEXITCODE` / `echo %errorlevel%`);
  2. no `ksx.exe` in `tasklist | findstr /i ksx`;
  3. **no ghost pads** — `joy.cpl` lists zero controllers, Device Manager shows
     no children under "Nefarius ViGEm Bus Device";
  4. `ksx doctor` exits 0 (warnings allowed; the standing
     `interception-borrowed-time` warning is expected until M6 completes).
  Ghost pads → `RECOVERY.md` §3.
- Close other controller-emulation tools before the gate; competing virtual pads
  can consume the four XInput slots and invalidate the result.
- Exit codes are the contract: `0` done, `1` error, `2` refused / nothing
  changed, `3` acted and failed (see `INTEGRATION.md`). A `2` always means the
  machine is untouched.

---

# GATE 1 — "M5 rest": autostart + tray daemon + frontend wrapper

Proves the three M5 deliverables on hardware: the tray daemon, start-at-logon,
and the frontend wrapper — ending in a real emulator with 4 live pads and a
clean exit.

**STATUS for current candidate: NOT RUN.**

## Preconditions

- Interception installed and healthy: `ksx doctor` exits 0.
- `ksx run --dry-run` exits 0 (the config resolves; nothing is touched).
- Record two test profiles in the run log: `<FOUR_PLAYER_PROFILE>` for the
  four-player phases and `<AUTOSTART_PROFILE>` for the cold-boot phase. Both
  must already resolve through `%APPDATA%\ksx\games.toml`; substitute their
  actual titles anywhere those placeholders appear below.
- The manifest-bound current-candidate installer is installed. Run every
  command from that installed copy; `ksx autostart --status` must not report
  `different-exe`. A `target\` build is valid development evidence, but never
  fills this release-candidate ledger.
- One supported frontend is ready for Phase C. The example uses RetroBat or
  LaunchBox plus this repository's `examples\ksx-wrap.ps1`; substitute the
  selected frontend, emulator, ROM and clone paths and record them in the log.
- Nothing here needs elevation. If a UAC prompt appears, something is wrong —
  stop.

## Phase A — tray daemon

```powershell
ksx daemon --game "<FOUR_PLAYER_PROFILE>"
```

**Expect:** startup notice naming the log file path, then the console window
closes itself and a tray icon appears. That vanishing console is by design
(`ksx daemon --help`), not a crash — the log keeps recording.

1. Hover the tray icon → tooltip shows the idle state / last session verdict.
2. Tray → **Start emulation** → `joy.cpl` shows 4 Xbox 360 pads; panel drives
   them; the assigned panel keys stop typing; other keyboards keep typing.
3. Tray → **Stop emulation** → pads unplug from `joy.cpl`; panel types again.
4. Tray → **Quit** → icon disappears; run the shared "clean" checklist.

**ABORT Phase A if:** no tray icon within ~5 s (read the log tail); pads don't
appear on Start; panel keeps typing while emulating; anything left after Quit.
Recovery: `taskkill /f /im ksx.exe` — crash-only design returns the keyboards
within a second — then `ksx doctor`.

## Phase B — autostart at boot

`ksx autostart` registers **`ksx daemon --game <TITLE>`** as the logon task:
the tray icon comes up at every logon and captures nothing until a session is
started from the tray (or a wrapper). That default is deliberate — a
registered `ksx run` would grab the keyboards at every logon, desktop use
included. The kiosk shape (logon straight into the game) still exists as
`--mode run`; it is not part of this gate.

```powershell
ksx autostart --enable --game "<AUTOSTART_PROFILE>" --dry-run
```

**Expect:** the full plan — `task name: ksx\autostart`, `mode: daemon (tray
icon at logon; sessions start on demand)`, `runs: "…\ksx.exe" daemon --game
<AUTOSTART_PROFILE>`, `elevation: none (LeastPrivilege, per-user task)`, the exact
`schtasks /Create` line, the full XML, and `dry run: nothing was registered.`
Read the XML: `LogonTrigger` with `PT10S` delay, `RunLevel LeastPrivilege`,
`MultipleInstancesPolicy IgnoreNew`.

```powershell
ksx autostart --enable --game "<AUTOSTART_PROFILE>"
ksx autostart --status
```

**Expect:** `registered. Verify with `ksx autostart --status`…`, then a status
block: `autostart: registered as 'ksx\autostart'`, `mode: daemon`,
`game: <AUTOSTART_PROFILE>`, `enabled: yes`, exit 0. Exit 2 with a `STALE`
warning means the
task points at a different or missing exe — fix before booting.

**Cold boot:** full shutdown (not restart), power on, log in, wait ~15 s.

**Expect after logon:**
- the **tray icon appears** (the task waits out its 10 s delay first) — hover
  it: idle state, nothing running;
- `tasklist | findstr /i ksx` shows `ksx.exe`;
- nothing is captured yet: the panel still types, `joy.cpl` lists no pads;
- today's log shows the daemon start with no `ERROR`.

Then prove boot-to-playable: tray → **Start emulation** → the recorded
autostart profile launches, pads present in `joy.cpl`, panel drives them. End the
session cleanly: quit the game (emulation stops when the followed
process exits) — or `Ctrl+Alt+Del` to stop emulation. Tray → **Quit**, then
the clean checklist.

**ABORT Phase B if:** no tray icon after logon (check Task Scheduler history
for `ksx\autostart` and the log — a missing log entry means the task never
fired; a log entry ending in exit 2 means validation drifted between enable and
boot); pads appear at logon without anyone touching the tray (the task was
registered `--mode run` — not this runbook's registration); or a second logon
starts a second daemon (must be impossible: `IgnoreNew`).

## Phase C — frontend wrapper into a real emulator

Pattern B from `INTEGRATION.md`: the frontend stays in charge, the wrapper
brackets the emulator with ksx and stops it in a `finally`.

RetroBat — register the wrapped system in the custom `es_systems_*.cfg`:

```xml
<command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\src\ksx\examples\ksx-wrap.ps1" -Emulator "C:\Path\To\emulator.exe" -Game "&lt;FOUR_PLAYER_PROFILE&gt;" -- %ROM%</command>
```

LaunchBox alternative — Tools → Manage → Emulators → edit the MAME entry:
Application Path `powershell.exe`, parameters as above without `%ROM%`
(LaunchBox appends the ROM path).

> Keep every path in that command on a fixed drive letter. Frontend system
> definitions commonly hardcode ROM roots; a drive-letter change can silently
> remove systems and look like a reset.

1. Launch a 4-player game from the frontend UI (panel/pad navigation).
2. **Expect:** brief wrapper window (or none), pads live *before* the emulator
   takes the screen — the wrapper waits for pads first, because an emulator
   that starts early caches "zero controllers".
3. All 4 players work from the panel.
4. Quit the game from its own menu. **Expect:** back at the frontend, pads
   gone, panel navigates the frontend again. Clean checklist.

**ABORT Phase C if:** the emulator sees no pads (start-order bug — the wrapper
launched the emulator before pads settled); the panel types into the frontend
*while* the game runs; or pads persist after quitting (the wrapper's `finally`
didn't run — kill ksx, check the wrapper invocation).

## Phase D — autostart removal

```powershell
ksx autostart --disable
ksx autostart --status
```

**Expect:** `autostart removed (scheduled task 'ksx\autostart' deleted)`, then
`autostart: NOT registered…`. Run `--disable` a second time: `autostart was not
registered; nothing to remove`, exit 0 (idempotent by contract). One more cold
boot: nothing starts, `tasklist` has no ksx.

## GATE 1 PASS criteria

All of: Phase A tray lifecycle clean; Phase B cold boot to the tray icon, a
live session started from it, log evidence and a clean stop; Phase C
frontend → emulator → 4 pads → clean exit with no ghost pads; Phase D removal
verified by a boot. `ksx doctor`
exits 0 at the end, and the day's log has no unexplained `ERROR`.

## GATE 1 rollback

Everything in this gate is additive and reversible with no driver involvement:
`ksx autostart --disable` removes the task; revert the `es_systems_*.cfg` /
LaunchBox emulator edit to unwrap; `taskkill /f /im ksx.exe` ends anything
stuck (keyboards return within a second — Interception crash-only guarantee).
`LeftCtrl ×5` un-captures at any moment; `Ctrl+Alt+Del` always works.

## GATE 1 RUN LOG — current candidate

**STATUS: NOT RUN.** Fill every field during the supervised run:

- Release tag/version / source commit:
- Release run id / attempt / candidate-manifest SHA-256:
- Installer filename / SHA-256:
- Machine / operator / started-at UTC / ended-at UTC:
- `<FOUR_PLAYER_PROFILE>` / `<AUTOSTART_PROFILE>`:
- Selected frontend / emulator / wrapper / ROM paths:
- Phase A tray lifecycle / clean checklist:
- Phase B dry-run / registration / cold-boot / playable result:
- Phase C frontend launch / four-player input / return-to-frontend result:
- Phase D disable / idempotence / cold-boot result:
- Log review / unexplained warnings or errors:
- **Verdict: NOT RUN**

---

# GATE 2 — installed WinUSB preparation: the first hardware-touching gate

This is the big one. Installed Studio's **Prepare selected keyboard** takes the
I-PAC's exact keyboard interface out of the keyboard stack after three explicit
confirmations and UAC. From that moment until Release, **the panel types only
while ksx is running** — and the escape semantics are weaker than everything
M3–M5 taught you:

> **Under Interception, killing ksx frees the keyboard within a second. Under
> WinUSB it does not.** `LeftCtrl ×5` still works — passthrough on a claimed
> board *is* re-injection, evaluated in the capture thread — but only while ksx
> is alive. Kill ksx and the claimed panel is simply dark until the daemon
> restarts or installed **Release selected keyboard** succeeds. Injected keys
> never reach the lock screen, a UAC prompt or `Ctrl+Alt+Del`. This is the M6 trade, stated in
> `MIGRATION-WINUSB.md`; the mitigations are the spare keyboard and autostart.

The gate is a supervised round trip: prepare → capture → play → typethrough →
release. It deliberately does **not** end with the cabinet migrated; living on
WinUSB is a separate decision taken after this passes (see PASS). No WDK,
self-signing command, Zadig, device-path paste, CLI mutation or TOML edit is part
of the supported round trip.

**STATUS for current candidate: NOT RUN.**

## Preconditions — every one, no exceptions

- **A spare USB keyboard is plugged into a different port and TESTED: open
  Notepad and type on it, now.** It must be a board that can type *this
  minute* — Prepare refuses the last usable keyboard, but a
  prepared/disabled/battery-dead board does not count and cannot operate UAC.
- **Only one device of the selected hardware model is connected.** Preparation
  refuses identical present siblings because the Windows package matches their
  shared hardware ID. Do not connect an identical keyboard until after Release.
- **`RECOVERY.md` §2 is open on a second screen or phone** — not on this
  machine, whose input you are about to experiment on.
- **The exact CI installer is installed in Program Files.** Confirm
  `ksx-winusb-helper.exe`, `libwdi.dll`, corresponding source, and the protected
  `%ProgramData%\KSX\WinUSB` tree are present. Do not substitute a portable,
  developer, moved or user-writable build; refusal is the expected result there.
- **The observer may use a separate `conhost.exe` for read-only evidence.** The
  user-facing prepare/release actions themselves stay in Studio. Windows
  Terminal ≤1.25 remains excluded once virtual pads send input.
- **Interception is NOT uninstalled.** It is the fallback for the whole gate;
  it comes out only after the two-week soak, when `ksx run --dry-run` says
  `winusb` with no Interception context at all.
- **The current-candidate GATE 1 ledger records PASS** — autostart must be proven
  on this release candidate before anyone lives with a claim.
- **A restore point exists** (one click; it is a gate precaution, not the
  normal rollback path).
- Baseline snapshot saved:

  ```powershell
  ksx winusb status --json > "%APPDATA%\ksx\winusb-before.json"
  ```

**The abort path, valid at every step below:** stop and use installed **Release
selected keyboard** with the tested spare. If KSX itself will not run, use
`RECOVERY.md` §2's receipt-guided `pnputil` or Device Manager emergency path.
Do not delete `%ProgramData%\KSX\WinUSB`; the receipt is what identifies the
exact OEM package/certificate. Never push through a step whose expected output
did not appear.

## Step 1 — observe the read-only survey, then select in Studio

```powershell
ksx winusb status
```

**Expect:** the I-PAC MI_00 row —

```
USB\VID_D209&PID_0430&MI_00\7&TEST_DEVICE&0&0000
  driver     : HidUsb
  verdict    : CLAIMABLE — ksx could claim this
  note       : Ultimarc (VID D209) — the arcade encoder family
```

— and `keyboards that can type right now:` **at least 2** (panel + tested
spare). MI_01, MI_02 and the trackball show as `no keys` / not candidates —
they are never touched.

The synthetic path above is observer evidence, never a value the user types or
pastes. A real instance may be serial-derived or topology-derived. Record what
the survey prints, then identify the same human-named row in `/nocturne` and choose
it there.

**ABORT if:** count is 1 (Prepare would refuse anyway — fix the spare first);
verdict is not `CLAIMABLE`; the Studio row is not exact and selectable; or two
identical hardware-model rows are present. Do not disambiguate by typing a path;
disconnect the twin and rescan.

## Step 2 — read and prove the three confirmations

With the exact row selected, a clean machine must show the capture card in its
prepare branch — summary *"Prepare for play — Windows stops this keyboard's
ordinary typing until it is released here."*, button **Prepare selected
keyboard**. A machine that retains a healthy shared Interception installation
must stay Play-ready but still offer the built-in path as an option, with the
summary reading *"Typing normally — the shared driver is ready; preparing the
built-in path is optional."*

(These are quotations from `snapshot.rs`'s `cap_line` match, checked 2026-08-25.
Earlier revisions of this file quoted **Prepare this keyboard for play** and
**Use KSX's built-in Windows USB mode**, neither of which is a string the
product has ever rendered — an operator following the old wording would have
looked for buttons that were not there and had no way to tell a renamed control
from a missing one.)

First submit with each checkbox omitted in turn. **Expect:** a safe refusal,
no UAC prompt, unchanged stage, unchanged device binding and no new receipt.
Then tick all three, reading them aloud:

1. the different keyboard is connected and tested;
2. the selected keyboard stops ordinary typing until Release, and must be
   released before connecting an identical keyboard; and
3. KSX may add a machine-local certificate used only for this generated device
   package.

**ABORT if:** the action is hidden for an exact claimable USB keyboard; the
clean-machine page allows Save/Play before preparation; the shared-driver page
makes the optional action a blocker; a missing confirmation opens UAC; or the
browser asks for a path, backend, WDK, signing command or Zadig.

## Step 3 — prepare through UAC

Choose **Prepare selected keyboard** (or **Use built-in USB mode**) and approve
Windows UAC with the test administrator. Screen-record the handoff.

**Expect:** one ordinary UAC prompt and no command/console window. After it
closes, Studio reports the exact keyboard prepared and offers **Release selected
keyboard**. The selected panel stops ordinary typing immediately; the tested
spare still types and can operate UAC. The stage did not save a file or plug a
pad.

Observer evidence: one protected receipt exists; the generated package matches
only the selected keyboard interface's hardware ID (not its composite parent or
other interface); the public certificate is present in
Local Machine Root and TrustedPublisher with matching DER/thumbprint/subject;
no private-key property or `KSX-libwdi-*` key container remains. Record, do not
alter, these values.

**ABORT if:** the helper or provider came from outside Program Files; a console
appeared; the spare stopped typing; the selected device did not stop; a sibling
interface/trackball changed; any private key remains; Studio reports success
without a fresh WinUSB binding and Active receipt; or the result is
`recovery-required`. Use the abort path and preserve the journal.

## Step 4 — confirm the rebind

```powershell
ksx winusb status
```

**Expect:** same row, now `driver : WinUSB`, `verdict : CLAIMED — ksx can open
this; Windows sees no keyboard`. Trackball still moves the pointer (MI_01
untouched — `RECOVERY.md` §2f).

## Step 5 — prove the guarded staged transition

Return to `/nocturne` without saving. **Expect:** the same human-named device is
selected, the capture card is the verified Release branch, and Save/Play
readiness now treats capture as ready. The observer may export the in-memory
API payload and confirm `staged.device.backend == "winusb"`; the browser form
never contained a backend field.

Change the staged device in a second window while a deliberately delayed UAC
prompt is open, then cancel/complete only on a disposable repetition if the gate
operator has arranged this safely. **Expect:** the exact transaction is never
retargeted and the stale stage does not change; Studio gives owned recovery
copy. This race may be satisfied by the software test record if reproducing it
on the physical candidate would add risk.

**ABORT if:** preparation saved `config.toml`, changed a different staged
selector, accepted a noncanonical helper state, or made readiness green without
the fresh exact WinUSB survey.

## Step 6 — verify capture

Still without saving, add four controllers from the known in-box four-player
layout, answer split-or-freeze, and choose **▷ Play**. Press a handful of
panel keys in Game Controllers.

**Expect:** the configured virtual controls move and every press releases. Stop
from Studio. No config/preset/backup file was created; idle typethrough returns.

**ABORT if:** the prepared panel cannot drive the pads, an unrelated keyboard
drives them, any control sticks, input types behind the running session contrary
to the selected policy, or Stop does not remove every pad.

## Step 7 — real session + typethrough (the M6 user-choice requirement)

The installed daemon opens the already prepared interface once at startup and
holds it for its whole life — that is what makes typethrough exist. Then, in
order:

1. **Typethrough, emulation stopped:** open Notepad, press panel keys.
   **Expect: they type.** This is the requirement — a claimed panel must still
   drive frontend menus between games. If this fails, the cabinet loses menu
   control: release and abort.
2. **Start emulation** from Studio: `joy.cpl` shows the staged pads, panel drives
   them, **nothing** types into Notepad behind the game.
3. **Stuck-key check:** hold a panel direction, start emulation, release the
   key, stop emulation. The desktop must not be scrolling (nothing left
   half-pressed — the crash-only key-release guarantee).
4. Play the 4-player game; all four live; quit the game; emulation stops;
   typethrough returns immediately (daemon holds the claim between sessions).
5. **The kill test — internalise the trade:** with the daemon running, the
   observer uses Task Manager or the spare keyboard's conhost to terminate it.
   Pads vanish;
   **the panel goes completely dark. Expected.** The spare keyboard still
   types. Restart KSX from the customer shortcut — the panel returns. This is
   the weaker escape semantics, experienced once on purpose rather than
   discovered at midnight.

Quit the daemon (tray → Quit), then reopen KSX from the installed shortcut
before Step 8 so the Release card is available.

**ABORT if:** typethrough never works, keys leak into Notepad *during*
emulation, or the stuck-key check scrolls the desktop. All three are release-
worthy findings, not things to live with.

## Step 8 — release

On `/nocturne`, tick the distinct Release confirmation and choose **Release
selected keyboard**. Approve UAC.

**Expect:** one UAC prompt, no console, then owned copy saying the keyboard was
released. The helper removes the receipt's affected WinUSB devnodes, deletes
only its exact OEM package, proves package absence, rescans and proves the
selected interface is HidUsb, then removes the exact certificate and artifacts.
The stage changes back only after API state exactly `released` for that same
interface.

Package scope is recorded explicitly: this gate connects no twin. If an
identical keyboard is connected accidentally after Step 3, unplug it before
Release; Studio must refuse rather than guess while the staged selector is
ambiguous. After Release, reconnecting the twin must show it back on HidUsb.

**ABORT if:** release targets a browser-supplied package/path, reports success
with WinUSB or certificate/key material still active, changes a stale/different
stage, or returns recovery-required. Keep the journal/helper and use
`RECOVERY.md` §2.

## Step 9 — verify the panel is a plain keyboard again

1. `tasklist | findstr /i ksx` → nothing. ksx fully closed.
2. Open Notepad, type on the **panel**. **Expect: it types**, with no ksx
   process anywhere — the keyboard stack owns it again.
3. `ksx winusb status` → the row is back to `driver : HidUsb`,
   `verdict : CLAIMABLE`, and the `HID\…` keyboard child is listed again.
4. The recorded OEM package is absent; the exact public certificate is absent
   from both machine stores; no matching key container remains; the receipt is
   terminal rather than active/recovery-required. No config/preset/backup file
   changed during the entire round trip.
5. If the device did not come back, preserve the journal and follow
   `RECOVERY.md` §2. Do not call a reboot or replug a PASS without proving the
   final state afterward.

## GATE 2 PASS criteria

The full round trip with **zero recovery actions**: exact claimable row → all
three confirmations enforced → one console-free UAC prepare → verified
WinUSB/Active receipt/public-only certificate → guarded stage transition →
four-player session → typethrough into Notepad while idle → kill test behaved
exactly as documented → one console-free Release → HidUsb/package/certificate/
key absence proof → panel types with KSX fully closed → no config write →
`ksx doctor` exits 0 and the day's log is clean.

**After PASS:** migrating for real — Prepare again in installed Studio, Save
the verified `winusb` stage, arm autostart and live with it — is a separate
deliberate act, one hardware model at a time, per `MIGRATION-WINUSB.md`.
Interception comes out only after the two-week soak.

## GATE 2 rollback ladder

In order of how much still works:

1. KSX runs and the tested spare types: installed **Release selected keyboard**.
2. KSX will not start: the receipt-guided pnputil sequence — including exact
   OEM package deletion — in `RECOVERY.md` §2c.
3. Mouse only: Device Manager route, check "attempt to remove the driver",
   `RECOVERY.md` §2d.
4. Panel was somehow the only keyboard (the refusal exists to prevent this):
   plug in any keyboard, or §2d, or Safe Mode + on-screen keyboard (§2e).
5. Everything on fire: the pre-gate restore point.

Do not delete the receipt, certificate or helper by hand before the owned
cleanup has identified them. A prepared panel “not typing” usually means the
daemon is not running; start installed KSX before assuming the binding is
broken (`RECOVERY.md` §2, first table).

## GATE 2 RUN LOG — current candidate

**STATUS: NOT RUN.** Fill every field during the supervised round trip:

- Release tag/version / source commit:
- Release run id / attempt / candidate-manifest SHA-256:
- Installer filename / SHA-256:
- Machine / operator / started-at UTC / ended-at UTC:
- GATE 1 ledger reference and verdict:
- Tested spare keyboard / recovery copy location / restore point:
- Baseline snapshot path and SHA-256:
- Survey result / selected MI_00 instance path / identical-model check:
- Three missing-consent refusals / UAC / console-flash result:
- Helper/provider Program Files trust / receipt / package / public-only certificate evidence:
- Prepare canonical state / exact re-survey / staged-backend result:
- Four-player profile / typethrough / stuck-key / kill-test results:
- Release / package-wide scope / HidUsb / package+certificate+key cleanup / plain-keyboard result:
- No-config-write comparison:
- Final `ksx doctor` / log review / recovery actions, if any:
- **Verdict: NOT RUN**

---

# GATE 3 — closing the books: M4 p99, M5 Phase C, M6 soak

One supervised hardware session, three milestone exits. Everything below is
what the code cannot do for itself — measurements and removals only a person
at the test system can perform. Nothing here changes source; the only writes
are one driver uninstall, the installed Prepare/Save transaction, and entries
in the blank run log below.

**STATUS for current candidate: NOT RUN.** No earlier machine state or partial
run carries into this gate. Begin only after the current-candidate GATE 1 and
GATE 2 ledgers both record PASS for the same release candidate. GATE 2 ends
with the test interface released, so deliberately Prepare it again in installed
Studio, Save that verified `winusb` stage, and record the state before Phase 1.
Keep Interception installed until Phase 3 removes it.

## Preconditions

- The exact current CI-built release candidate is installed (`ksx doctor`
  shows the recorded version and the artifact matches the GATE 1/2 ledgers).
- The current-candidate GATE 1 and GATE 2 ledgers record PASS for that release
  candidate.
- A second, never-claimed spare keyboard is plugged in and typing.
- `%APPDATA%\ksx\config.toml` backed up beside itself with today's date.
- The selected I-PAC interface has been deliberately prepared again after GATE 2,
  `ksx winusb status` reports it CLAIMED, and the daemon's typethrough has been
  rechecked. Record the path and baseline state below.
- Nothing else is scheduled for the test system during this session: Phase 3
  ends with a driver uninstall and a reboot.

## Phase 1 — M4 exit: the p99 number, written down

1. `ksx doctor --latency` once, idle, to confirm the histogram plumbing.
2. Start the real four-player profile recorded in GATE 1 (directly or through
   the selected frontend, whichever the supervised run is exercising).
3. Play something genuinely busy for ten minutes — four players mashing, not
   one person pressing one button.
4. `ksx doctor --latency` again. Record p50/p99/max in the run log below.

**PASS**: p99 < 1 ms (ARCHITECTURE rule 5). A miss is not a tuning session
during this run — record the number and open a follow-up issue.

## Phase 2 — M5 exit: Phase C, the frontend wrapper

GATE 1's Phase C verbatim: the daemon wraps a real emulator run —
frontend up, game launched from it, pads live inside the emulator, clean exit
back to the frontend, nothing captured afterward. Use the frontend and paths
recorded in the standalone GATE 1 ledger. Ten minutes.

**PASS**: GATE 1's Phase C criteria met; log it below and GATE 1 is fully
closed.

## Phase 3 — M6 exit begins: Interception comes out, the soak clock starts

M6's exit line is explicit: *same session with Interception **uninstalled***,
then a two-week soak. After the preconditions have established and recorded a
live prepared binding plus working typethrough, proceed in this order:

1. `ksx session stop` (leave the daemon up), then one last
   `ksx devices --json > %APPDATA%\ksx\gate3-before.json` for the record.
2. Uninstall Interception with its own installer, elevated:
   `install-interception.exe /uninstall` (the same tool that installed it;
   re-download from oblitum/Interception releases if it is not on disk), then
   verify the filter is really gone — `keyboard.sys`'s Interception entries
   absent from `pnputil /enum-drivers`, and the `keyboard` service no longer
   listing Interception's filter. **Reboot.** (`RECOVERY.md` §1 covers this
   driver *dying on its own*; this is the deliberate version.)
3. After the reboot: the panel must still be captured (WinUSB claim survives
   reboots by design — it is a driver binding, not a session), the tested spare
   keyboard must still type, and `ksx doctor` must exit 0 with the Interception
   rows now reporting absent-and-unneeded.
4. Run the same 4-player session as Phase 1. This is the actual M6 sentence.
5. Exercise Gate 2 steps 8–9 once, deliberately in installed Studio: Release,
   watch the panel become a plain keyboard, then repeat the three-consent
   Prepare flow and confirm capture again. Release/Prepare is the recovery
   muscle; it gets one rep while the spare keyboard is plugged in, not its
   first rep during a failure.
6. Write the soak start date below. **Soak = fourteen days of normal target-
   installation use with zero recovery actions.** Any Code-39, any dead panel,
   any manual pnputil: the soak restarts and the incident goes in the log.

**PASS (session half)**: steps 1–5 clean. **PASS (M6 itself)**: the soak
completing 14 days later — put the end date in the calendar now.

## GATE 3 rollback

Phases 1–2 change nothing; stop anytime. Phase 3's ladder is GATE 2's ladder
above, unchanged — plus one addition: if anything smells wrong *after* the
Interception uninstall, do NOT reinstall Interception as a reflex. The 2012
cross-signed driver is the thing this whole milestone removes; reinstalling it
under pressure at midnight re-adds a boot-critical EOL filter to fix what is
almost always "the daemon is not running" (`RECOVERY.md` §2, first table).

## GATE 3 RUN LOG — current candidate

**STATUS: NOT RUN.** Fill every field during the supervised run and soak:

- Release tag/version / source commit:
- Release run id / attempt / candidate-manifest SHA-256:
- Installer filename / SHA-256:
- Machine / operator / started-at UTC / ended-at UTC:
- GATE 1 and GATE 2 ledger references / verdicts:
- Tested spare keyboard / configuration backup path and SHA-256:
- Re-prepared interface path / status / typethrough baseline:
- Phase 1 profile / duration / p50 / p99 / max / verdict:
- Phase 2 frontend / emulator / four-player input / cleanup result:
- Interception uninstall evidence / reboot result / `ksx doctor` result:
- WinUSB session / release / plain-keyboard / re-prepare results:
- Soak start / expected end / actual end:
- Recovery incidents or soak restarts:
- **Verdict: NOT RUN**

---

# GATE 4 — fresh customer: exact installer to a working controller

This is the product gate, not another source-code gate. It starts with the
`setup.exe` produced by CI and a Windows user who has never run ksx. The person
walking the journey does not open a terminal, edit TOML, paste a device path or
receive whispered instructions. The observer may collect hashes, process-owner
evidence and before/after file state, but none of that may become a step the
customer has to perform.

**STATUS for current candidate: NOT RUN.** Nothing below is a claim that this
gate passed.

## What software tests prove — and what they do not

The repository tests prove the contracts in isolation: CI builds `ksx.exe` and
the GUI-subsystem launcher and WinUSB helper before ISCC packages them;
installer tests pin installed-only helper/provider/source, protected recovery
tree, fail-closed uninstall cleanup, portable omission, shortcuts and the driver
task; launcher/helper tests pin `CREATE_NO_WINDOW`, the x64 GUI subsystem,
`requireAdministrator`, fixed Program Files siblings and no caller paths; daemon tests
admit an empty implicit setup as an idle control host; API and HTTP tests cover
three server-validated consents, exact revalidation, canonical
`prepared`/`released`, guarded backend transitions, staged bindings, macros,
Play-before-Save and profile create/update/delete/switch;
template and Studio tests pin the two default Guide keys and the direct Game Bar
Settings link.

Those tests cannot prove that UAC returned to the original user, no console
flashed, the machine-local certificate/package worked on this Windows machine,
the selected and spare keyboards behaved correctly, uninstall cleaned the real
stores/driver package, the bundled controller driver installed, Windows exposed
a real virtual pad, a game consumed it, or Game Bar opened. This gate proves
those claims. The provider's disposable clean-runner smoke is also **NOT RUN**
until Actions records it; even a passing smoke is necessary evidence, never a
substitute for this physical run.

## Preconditions — preserve the customer conditions

- Use the **exact CI-built installer** intended for release, not a local Inno
  build and not loose binaries. Before running it, record below its file name,
  product version, source commit and published SHA-256; independently hash the
  downloaded file and require an exact match.
- Use a supported, fully updated Windows 10/11 physical machine or a disposable
  clean Windows image that can expose ViGEmBus controllers to the host gaming
  stack. ViGEmBus and Interception must both be absent before the run. If either
  is already installed, this is not the clean built-in-capture test; restore a
  clean snapshot or use a different safe machine.
- Create a fresh **standard** local Windows user. `%APPDATA%\ksx` and
  `%LOCALAPPDATA%\ksx` must not exist for that user. Have a different
  administrator account available for the installer UAC prompt; using the same
  account does not test `runasoriginaluser`.
- Plug in two known, visibly distinguishable, supported USB keyboards with
  **different hardware models** and call them **Keyboard A** and **Keyboard B**
  in the run log. Test each in Notepad before opening KSX. Keyboard B must have
  a numpad: Phase 4 uses the pair to prove an explicit profile-device refresh
  changed slot device values, and Phase 5 uses B's Numpad `*` Guide binding.
  Have a known game that reads XInput and Windows' Game Controllers panel
  available. Xbox Game Bar must be installed and allowed by policy for this
  user; its controller setting starts disabled so the on-screen prerequisite
  and remedy are exercised.
- Screen-record from before the installer Finish button through the first
  `/nocturne` paint if possible. A two-second console flash is a failure that a
  screenshot taken afterward cannot capture.
- The observer records the pre-run controller list, process list and ksx file
  state. These are observations, not instructions shown to the test user.

**ABORT before install if:** the installer hash/version/commit do not agree with
the release candidate; the Windows user is not fresh; ViGEmBus or Interception
is already present; the two keyboards share a hardware model or either cannot
type now; or the UAC test would require using the customer's own standard-user
credentials as the administrator.

## Phase 1 — install the artifact, including the driver

1. While signed in as the fresh standard user, double-click the downloaded
   installer. Supply the separate administrator's credentials at UAC.
2. Confirm **Install the ViGEmBus controller driver** is visible and ticked by
   default. Leave it ticked. Confirm the desktop-icon task is selected.
3. Complete setup without launching a shell. The installer may continue if its
   driver child fails by design, but **this gate may not**: inspect the wizard's
   result and `{app}\install-drivers.log`, and require a successful ViGEmBus
   install. Record the installed driver version.
4. Confirm Apps & Features shows the expected ksx product version and the
   install directory contains the release-candidate `ksx.exe`,
   `ksx-launcher.exe`, `ksx-winusb-helper.exe`, `libwdi.dll`, sealed driver
   bundle, complete `THIRD-PARTY-SOURCE\libwdi`, and licence material. Confirm
   `%ProgramData%\KSX\WinUSB\{journal,transactions}` exists with only SYSTEM and
   Administrators mutation rights.
5. Confirm there is exactly one **ksx** entry in the Start menu and the default
   desktop icon. Both shortcuts must target `ksx-launcher.exe` with no arguments;
   there must be no customer entries for daemon, Studio, cabinet, doctor or a
   setup wizard.

**PASS Phase 1:** the exact artifact is installed, the bundled ViGEmBus step is
successful and recorded, the installed-only helper/provider/source/recovery
tree is complete and protected, and every visible customer shortcut has the
single launcher target. No keyboard was prepared during install. A successful
app install with a failed/declined driver is a useful supported state, but it
does not pass this release gate.

## Phase 2 — Finish hands back to the right user and boots idle

1. Leave **Launch ksx** ticked on Finish and click Finish. Watch the whole
   handoff. **No console window may appear, even briefly.**
2. The customer gets one chrome-less ksx app window at `/nocturne`, not a
   terminal and not a normal browser tab. It has no address bar and does not ask
   the user to choose a URL. *(Since the 2026-08-25 cutover there is no second
   page it could land on by mistake — there is one product page. What it CAN
   land on is nothing at all: `ksx open` still requests the deleted `/start`, so
   until `studio_launch.rs` is corrected this step fails on a 404 in a window
   with no way to type a different address. **Do not run Gate 4 until that is
   fixed** — every phase below starts from this window.)*
3. In Task Manager's **User name** and **Command line** columns, confirm both
   surviving `ksx.exe` children — `daemon` and `studio --port 4460` — belong to
   the fresh standard user, not the administrator whose credentials satisfied
   UAC. Confirm the browser profile was created below that user's
   `%LOCALAPPDATA%\ksx`, not the administrator's profile.
4. With no `[[slot]]` configured, `/nocturne` must report the daemon reachable and
   idle. The process stays alive as the staging control host, while no keyboard
   is captured and no virtual controller exists. The keyboard still types and
   Game Controllers shows zero ksx pads.
5. Open the tray menu. **Open ksx** remains available; **Open cabinet UI** and
   **Start emulation** are visibly disabled because there is no saved setup for
   either to operate. Neither disabled item may create a window, capture a key
   or plug a pad.
6. Close the app window, use the desktop shortcut once and the single Start-menu
   entry once. Each opens `/nocturne` without a console flash; neither creates a
   second customer-facing product entry or asks for elevation.

**PASS Phase 2:** the elevated installer has handed off to the original
standard user, every launch is console-free, and an empty configuration is a
healthy idle first-run state rather than a daemon startup refusal.

## Phase 3 — author in memory, Play before Save, then prove Save parity

1. On `/nocturne`, choose Keyboard A by its human-readable name. Because
   Interception is absent, Save/Play must remain blocked by the capture card,
   whose summary reads *"Prepare for play — Windows stops this keyboard's
   ordinary typing until it is released here."* and whose button is **Prepare
   selected keyboard**. Verify omitted confirmations refuse without UAC. Tick
   the tested-Keyboard-B, typing-consequence/identical-model, and machine-local
   certificate confirmations, then approve UAC with the separate administrator.
   No console may flash. Keyboard A stops ordinary typing; B still types.
2. Require the page to show the verified Release branch and capture readiness.
   Observer evidence must show the exact active receipt, exact OEM package,
   matching public-only certificate in both machine stores, no private key or
   KSX key container, and ProgramData receipts read-only (never writable) to the
   standard user. Add two Xbox 360
   controllers using the in-box two-player keyboard layout. Do not click Save.
3. Open each staged controller's mapper. Change one ordinary binding and create
   a small, visibly testable macro plus its trigger. Return to the top of
   `/nocturne` and
   answer **split or freeze**. Change one choice and change it back once: looking
   and reconsidering must remain free.
4. The observer compares `config.toml`, the preset directory and backups with
   the pre-run state. Staging bindings and macros must have written none of
   them. A refusal, if deliberately exercised with a duplicate key, must leave
   the staged view unchanged.
5. Click **▷ Play** without ever clicking Save. Two controllers must appear.
   In Game Controllers and the known game, verify the changed binding and macro
   exactly match what the staged mapper showed. Confirm no config, preset or
   backup was created by Play.
6. Stop the session from Studio (**⏹ Stop**). Click **Save** once, close ksx, and
   launch it again from the customer shortcut. Start the saved setup and verify
   the same devices, personas, binding, macro and split/freeze choice. Saving is
   now allowed to create the config/preset files; restarting must not translate
   them into different behavior.

**PASS Phase 3:** exact installed preparation and its public-only certificate
worked with one UAC/no console and the spare intact; staged editing and Play
were memory-only; the staged mapper was the behavior that ran; and the first
explicit Save survives a complete stop/relaunch with identical output.

## Phase 4 — saved-game create, switch, edit, refresh and delete in Studio

> **Step 4 cannot currently be performed and this phase cannot pass.** The
> explicit device-refresh choice has no control on `/nocturne`. The backend
> capability is intact — `UpdateProfile::rebase_devices` still exists and
> `nocturne_form_game_update` still reads a `rebase_devices` form field — but
> the edit form renders Name, Program to launch, Arguments, Players and
> Controller layout and nothing else, so the field always arrives at its
> default and the refresh can never be asked for. Restore the checkbox (and its
> label) in Studio before scheduling this phase; do not "pass" it by skipping
> the step, because step 4 is the only one of the five that proves the refresh
> semantics rather than the preservation ones.

1. Open the Configuration menu (the **▣** chip in the top bar), find **Saved
   games**, and use **Add a saved game…** to create one for the known game:
   fill Name, Program to launch, Players = 2 and Controller layout, then **Save
   this game**. Do not open TOML or a terminal. Immediately load it (click its
   row) and start it: a Studio-created saved game must be runnable because its
   slots inherited the working base device selectors.
2. Edit that saved game's title, program link or arguments, player count and
   controller layout through **Edit &lt;title&gt;…** → **Save changes**. Reopen the
   editor and start it again; the existing Keyboard A selectors must have been
   preserved.
3. Stop the session. Return to `/nocturne`, confirm **Release selected keyboard**,
   approve UAC and prove Keyboard A is HidUsb/typing with its package and exact
   certificate/key artifacts absent. Then use the Configuration menu's **Start
   over…** → **Discard this draft**, select Keyboard
   B, and repeat all three Prepare confirmations with A now serving as the
   tested spare. Approve UAC; B stops ordinary typing and A remains usable.
   Stage the same two controllers, layout and split/freeze answer. Repeat the
   deliberately changed binding and macro from Phase 3 before Save so this
   device-only test does not replace the behavior already proved. Click
   **Save**. The observer now uses the Configuration menu's **Export the
   configuration (download)** link and keeps the JSON as `before-rebase`; this is
   technical evidence, not a document the customer has to read or edit. Require
   the base slots to name Keyboard B while the target profile still names
   Keyboard A.
4. Reopen the saved-game editor, change no ordinary field, tick the explicit
   device-refresh box, and save. The observer exports again as `after-rebase`
   and compares the two documents. In exactly the target profile, each slot's
   `keyboard`/`mouse` selectors must now match the corresponding Keyboard B base
   slot. Its `persona`, `socd`, `macros` and controller-layout (`preset`) values
   must be byte-for-byte unchanged, as must every unrelated profile. A success
   flash or unchanged visible row is not evidence for this step; the exported
   before/after values are. **Blocked — see the note above: that box is not
   rendered today.**
5. Delete the renamed saved game with **Edit &lt;title&gt;…** → **Yes, remove it** →
   **Remove this saved game**. Exactly that game disappears; unrelated games and
   the selected controller layout remain. Refresh the page and restart ksx once
   to prove the result was not only browser state.

**PASS Phase 4:** create → switch/play → edit → explicit device refresh → delete
is complete in Studio, with no config-file editing or CLI remedy. The two
exports prove creation/preservation/refresh semantics rather than asking the
normal saved-game row to expose device-selector jargon.

## Phase 5 — real pad output and the Game Bar prerequisite

1. Return to `/nocturne` and use the on-page control that opens
   `ms-settings:gaming-gamebar` directly. Confirm ksx did not silently change
   the preference, then enable **Allow your controller to open Game Bar** for
   this user. **Blocked:** no such control exists on any page — a grep for
   `gamebar` / `ms-settings` across `crates/ksx-studio` and `studio-ui` finds
   nothing, and `StartDerived::guide_line` is a field with no writer.
   `FIRST-RUN.md` §7 requires the remedy; it has never shipped. Until it does,
   enable the setting by hand and record the step as UNPROVEN rather than PASS,
   because "the user reached this setting without being told what to do next by
   us" is the thing this step measures.
2. Play the saved two-controller setup on Keyboard B. Confirm both virtual
   controllers move in Game Controllers and the known XInput game, not only in
   ksx's own reading of its pads.
3. Press Player 1's default **Left Windows = Guide** key and observe Game Bar
   open from the virtual controller. Close it. Press Player 2's default
   **Numpad `*` = Guide** key and observe it open again. Seeing the mapping in
   Studio or a unit test is not this proof; Windows must display Game Bar twice.
4. Stop the session. Both pads disappear, there are no ghost controllers, and
   Keyboard B types through the idle daemon. It remains deliberately prepared
   for Phase 6; closing the daemon would make B dark, not an ordinary keyboard.

**PASS Phase 5:** Windows and a real game consume the virtual pads, both default
Guide keys reach Game Bar after the user enables its prerequisite, and Stop
returns the machine to an idle typethrough state with no ghost pads.

## Phase 6 — uninstall proves owned cleanup

1. **Cancel costs nothing.** With Keyboard B still prepared, start the
   uninstall and answer **No** at "are you sure you want to completely remove
   ksx?". Nothing may have changed: Keyboard B is still on WinUSB, its receipt
   is still there, the session is still running, ksx is still installed. A
   cancel that had already released the keyboard is the defect this ordering
   exists to prevent.
2. Leave Keyboard B prepared and Keyboard A connected/typing. Uninstall KSX
   through Apps & Features and approve UAC. No terminal or manual release is
   allowed.
3. The uninstaller must stop the running session and prove the fixed autostart
   task absent BEFORE any driver rollback — a release racing a live Play
   session is a failure even if the machine ends up clean.
4. The uninstaller must run installed `cleanup-owned` before deleting the
   helper/provider. It audits active, interrupted, recovery-required, terminal
   and disconnected receipts plus orphan KSX certificate/key namespaces. On any
   ambiguity it must stop uninstall and preserve the recovery components.
5. **Expect success in this clean case:** Keyboard B returns to HidUsb and types
   with no KSX process; the receipt's OEM package, exact certificates in both
   stores, key containers and transaction artifacts are absent; the protected
   KSX WinUSB tree is removed only after proof; the app, shortcuts and autostart
   entry are gone. Unrelated packages/certificates/devices are unchanged.

**PASS Phase 6:** cancelling changed nothing, and the accepted uninstall stopped
the session, released the active prepared keyboard, and proved KSX-owned
package/certificate/key/receipt cleanup before removing the way out. An
uninstall that merely removed Program Files, left B dependent on KSX, or acted
at all on a cancel is a failure.

## GATE 4 PASS criteria

Every phase above passes against one recorded installer SHA and version. There
is no partial pass for “source tests were green,” “the installer compiled,” “one
pad appeared,” or “the Game Bar mapping exists.” Any failure stays in the run
log with the last known clean state; fix it, produce a new CI artifact with a
new hash, and restart this gate from Phase 1.

## GATE 4 RUN LOG — current candidate

**STATUS: NOT RUN.** Fill every field during the supervised run:

- Release tag / source commit / Release run id + attempt:
- Candidate-manifest file / independently measured SHA-256:
- Installer file / product version / manifest-declared installer SHA-256:
- Independently measured SHA-256:
- Machine / operator / started-at UTC / ended-at UTC:
- Windows edition + build / test-user type / separate admin used:
- Keyboard A / Keyboard B human names and exported slot device values:
- Interception absent / USB-only clean path / identical-model precheck:
- ViGEmBus before / installed version / `{app}\install-drivers.log` result:
- Helper/provider/source/ProgramData ACL and read-only-receipt evidence:
- Start + desktop shortcut targets / extra customer shortcuts:
- Original-user process + browser-profile evidence / console-flash result:
- Empty-config idle `/nocturne` / capture state / initial pad count:
- Keyboard A three consents/UAC/no-console/receipt/package/public-only cert/private-key absence:
- Keyboard A Release cleanup / Keyboard B Prepare repeat:
- Staged binding + macro / before-Play disk comparison / Play result:
- Save + full restart parity:
- Profile create/switch/edit/rebase/delete + before/after export result:
- Real game + Player 1 Left Windows Guide + Player 2 Numpad `*` Guide:
- Stop/typethrough result:
- Active-binding uninstall / HidUsb / package+certificate+key+receipt absence / unrelated-state result:
- **Verdict: NOT RUN**
