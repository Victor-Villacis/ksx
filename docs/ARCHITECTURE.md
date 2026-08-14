# ksx Architecture

This is the current architecture contract. Dated measurements and experiments
remain under `docs/research/`; product decisions belong here.

## Pipeline

```
[capture thread]  TIME_CRITICAL. interception_receive / nusb interrupt read.
                  Only: resolve device → emergency escapes (evaluated HERE, before
                  the pass/suppress decision, acting on this thread's own
                  passthrough latch — nothing downstream can starve them) →
                  pass/suppress (arc-swap snapshot) → bounded crossbeam channel
                  (1024; drop+count, never block).
       ↓
[engine thread]   ksx-core: per-device key state → precompiled Key→(slot,Binding)
                  index → PadState mutation (all-keys-up, opposite-axis snap,
                  one-kbd→many-slots fan-out) → diff → deltas, try_send with
                  per-slot coalescing (a newer PadState supersedes an older one;
                  the engine never blocks on the output thread).
       ↓
[output thread]   vigem update() per changed pad; LED/rumble via notification.
                  Reports failures upward; the supervisor drives teardown order.

[main thread]     CLI/supervision/hot-reload; later tray + UI. May die freely:
                  the input path never notices.
```

The diagram is the **currently shipped path**, not a permanent single-driver
restriction. Output routing is capability-based: ViGEmBus remains the X360/DS4
compatibility foundation; M8 is building HIDMaestro support for rich local
Windows profiles; a later VIIPER lane provides software-defined virtual USB,
network endpoints and Linux reach. Backends do not silently substitute one
controller identity for another. The engine continues to produce normalized
state while each backend owns its native report and feedback protocol.

Rules that keep us honest (each maps to a captured failure mode):

1. **No tokio / no allocation / no locks in the capture thread.** Input cannot
   depend on a UI thread or another fallible consumer continuing to respond.
2. **Crash-only held-input cleanup.** Process death must release every held or
   injected key without depending on a UI. Interception blocking returns to the
   OS in <1 s; a WinUSB-prepared interface remains structurally outside the
   keyboard stack until the installed release transaction restores it. The
   watchdog switches that live backend to passthrough injection while KSX is
   still running; it cannot undo a driver binding after process death.
3. **Identity = device instance path** (`HID\VID_D209...\8&TEST_DEVICE&0&0000`), never
   transient capture-slot indices, which drift on every replug.
4. **Slot number ≠ XInput user index.** User index comes from ViGEm's notification
   callback, not polling or guessing.
5. **p99 capture→submit latency < 1 ms**, measured by `ksx doctor --latency`
   (hdrhistogram); the histogram is a permanent debug feature, not a one-off.

## Milestones

The status column describes source implementation, not release acceptance. For
the standalone 0.2.0 candidate, physical **Gates 1–4 are NOT RUN**; only results
recorded in [`GATES.md`](GATES.md) against the exact candidate artifact count.

| M | Status | Scope | Acceptance target |
|---|---|---|---|
| M0 | ✅ done | Workspace scaffold | `cargo test` green; `ksx --version` |
| M1 | ✅ done | ksx-core + ksx-config | TOML configuration round-trips; engine proptests green |
| M2 | ✅ done | ViGEm output | 4 pads in joy.cpl, LED order right, kill → pads vanish |
| M3 | ✅ done | Interception capture | attribution + blocking verified; taskkill recovery <1 s ×5; LCtrl×5 in fullscreen |
| M4 | 🔨 code done, cabinet gate pending | End-to-end input pipeline (`ksx run`) | 4-player real-game session via `ksx run`; p99 < 1 ms — **GATE 3 phase 1: NOT RUN** |
| M5 | 🔨 code done, cabinet gate pending | Game launching, autostart, tray daemon, install-drivers, frontend integration | cold boot → daemon → frontend → game → clean exit — **GATE 1 and GATE 3 phase 2: NOT RUN** |
| M6 | 🔨 code done, cabinet gate pending | Installed WinUSB preparation/release: exact-device UAC helper/provider, journaled rollback/uninstall, capture backend and keystroke re-injection | prepare/release round trip, then the same session with Interception uninstalled and a 14-day soak — **GATE 2 and GATE 3 phase 3: NOT RUN** |
| M6.5 | ✅ done | DS4 spike: a second ViGEm target type | measured in `research/m6.5-ds4-findings.md` — six DS4 targets enumerated alongside four X360 with the XInput count unmoved, which is how players 5+ exist |
| M7 | ✅ done | UI: controller editing without a text editor | met by Studio's mapper (`/map`), full staged first-run reuse, and live button check (`/check`), not by the egui surface the original entry assumed. Remaining work is polish and physical acceptance, not a missing editor |
| M8 | 🔨 catalog/host contracts, structural package gate and SDK-free authenticated transport source done; production host and adapter absent | HIDMaestro rich-profile Windows backend: DualSense, Switch Pro, Xbox Series and catalog expansion | The incompatible latch adapter was removed. A non-executing pinned SDK catalog probe, bounded host contract, structural unsigned-candidate audit and one-use rendezvous now exist. The test-gated Windows path precreates the real secured pipe, retains and authenticates one fixed inherited-token SDK-free fake, and exercises bounded cross-language framing; Actions evidence is pending. No production managed host is elevated or reachable. A sanitized runtime-only SDK, native elevation bootstrap, signed packages and disposable-machine lifecycle evidence remain. Personas stay gated until that complete path passes — see `docs/HIDMAESTRO.md` |
| M8.1 | planned | VIIPER complementary virtual-USB/network/Linux lane | Separate-process prototype creates a virtual keyboard and controller locally and across Windows/Linux; licensing, USB/IP installation, authentication, feedback, reconnect and clean uninstall are acceptance work. It does not replace HIDMaestro or ViGEmBus |
| M9 | ✅ done, **re-decided** | "ksx is a real Windows application" | Was an egui config UI; cancelled 2026-08-06 because Studio had already shipped the mapper E7 wanted a native UI for (`docs/M9-DECISION.md`). Delivered instead: an owned icon, an installer, a tray "Open ksx", and `ksx open` — daemon up, wait for the port, then a chrome-less window |
| M10a | ✅ done | `ksx-api`: the typed, transport-free contract every surface consumes | `crates/ksx-api`. Studio and the cabinet depend on it and **not** on the backend crate, which is what makes `SURFACES.md` §1 checkable |
| M10b | 🔨 continuing | Studio as the UI | eight pages: `/`, `/start`, `/map`, `/check`, `/pads`, `/devices`, `/profiles`, `/setup`; the customer rail is Setup → Controls → Test, with Saved Games reached from Setup |

### What "cabinet gate pending" means, and where it is written down

M4, M5 and M6 are **code-complete and physically unproven for standalone
0.2.0**. Gates 1 and 2 establish the prerequisites; Gate 3 collects the p99
measurement, frontend wrap, Interception removal and 14-day soak. Gate 4 then
proves the packaged fresh-customer journey. Until those ledgers are filled,
treating prior development observations as release evidence would be the exact
failure `docs/FIRST-RUN.md` §6 is about.

### M4 supervisor (`crates/ksx-backend/src/run/`)

`ksx run` is the pipeline above, wired up. Two orderings are contractual and
asserted in CI (`src/run/pipeline_tests.rs`, mock backends, no drivers):

- **startup** — plug pads and resolve their XInput user indices → start capture
  in passthrough → enable blocking for exactly the keyboards bound to slots.
  A bus failure therefore always happens while every keyboard is still normal.
- **teardown** — uncapture, *then* unplug. A drop guard sends `SetPassthrough`
  even on unwind, so a supervisor panic still frees the keyboards; a dead engine
  or output thread is treated as fatal for the same reason.

Slot layout comes from `[[slot]]`, or from a `games.toml` profile with
`--game <Title>` (M5 adds the launching). `--dry-run` resolves and prints the
plan without touching a driver. Hotplug: the capture thread republishes the
device set from its idle path; a bound device that disappears releases its keys
(`Engine::release_device`), invalidates its slots with `InvalidationReason`, and
the session keeps running. Config hot-reload is **not**
in M4.

### M5 (`crates/ksx-games`, `crates/ksx-backend/src/{daemon,autostart,install}.rs`)

Everything M5 adds hangs off the M4 pipeline without changing it. The pipeline's
two contractual orderings are unchanged and still asserted the same way.

**Game launching** is a `SessionHook` on the supervisor with a no-op default
(`NoHook`), called at one specific point in startup: after `PadsPlugged`,
`CaptureStarted` and `BlockingEnabled`. That ordering is contractual and asserted
in CI against the trace *as it stood when the game was spawned*, not against a
note written afterwards — a game started before the pads exist enumerates zero
controllers and caches that answer for the session.

Exit detection is a pure state machine (`ksx-games::tracker`) with the clock and
the process list injected, so the launcher rule (10 s by default, per-profile
`launcher_grace_ms`) and the 60-second hand-off grace are exercised in
microseconds by fakes:

```text
                 launched (handle held)
                          |
     alive ---------------+--------------- exited
       |                                     |
   [Running] <-------------------------  lifetime > 3s ? --yes--> [Exited] -> stop, exit 0
                                             |no  (it was a launcher)
                                             v
                                  process_name configured ? --no--> [Unresolvable]
                                             |yes                     warn once,
                                             v                        keep running
                                   [LauncherHandoff]  --60s--------------^
                                             | found it
                                             v
                                       [Tracking pid]  --3 misses--> [Exited]
```

A `steam://` target starts at `LauncherHandoff` directly (the shell returns
immediately; there was never a handle). Three consecutive misses, not one, end a
tracked session — `snapshot()` returns an empty vector on failure, and one failed
enumeration must never read as "the player quit". **ksx never kills the game**:
there is no kill primitive in `ksx-platform::process` and a source-level test
keeps it that way.

**Exit-code mapping.** A `--game` profile's missing exe is caught with the config,
before a pad is plugged → 2. A launch that fails at launch time is necessarily
after the pads are up → 3. The game exiting → 0. The 2/3 line is still exactly
"was a keyboard filter ever armed".

**The daemon** splits into a control loop (pure, CI-tested with a fake session
factory) and a Win32 tray thread that can only enqueue a `DaemonCommand`. The
tray owns no channel to the capture, engine or output threads and calls into none
of those crates — structurally, not by convention. `--headless` exposes the
identical command set on stdin, and the tray falls back to it if the icon cannot
be created. "Reload config" is a clean stop and a clean start from disk, never a
hot-patch of a live pipeline.

**Autostart** validates before it registers — same resolution `ksx run` performs,
plus the profile's exe — because the failure it prevents (a cold boot to an
instant exit 2, on a console nobody sees) has no other detection path.
`--status` reports a stale registration and exits 2 on one.

**install-drivers** is one elevated boundary: it restricts elevated search to
non-user-writable directories and seals the verified ViGEm installer handle
across execution. M6 adds a separate, narrower boundary: installed Studio may
elevate only the fixed GUI-subsystem `ksx-winusb-helper.exe`, and that helper may
load only its fixed installed `libwdi.dll`. No generic command, backend, path or
provider selection crosses either boundary. Both are documented in
`docs/DRIVERS.md`.

**Frontend integration**: `docs/INTEGRATION.md` + `examples/ksx-wrap.ps1`, whose
contract is that ksx is stopped on every exit path — and whose safety net is that
killing ksx is always safe, because blocking is released on process death with no
cleanup.

### M6 (`crates/ksx-platform/src/{winusb,winusb_transaction,wdi,inject}.rs`, `crates/ksx-winusb-helper`, `crates/ksx-backend/src/winusb.rs`, `crates/ksx-backend/src/daemon/typethrough.rs`)

M6 replaces the capture *mechanism* without touching the pipeline above it. The
`CaptureBackend` contract is unchanged; a WinUSB backend satisfies it the same
way the Interception one does. What M6 changes is what a captured device **is**.

**The claim.** One USB interface (`USB\VID_D209&PID_0430&MI_00\…` on this
cabinet) is rebound from `HidUsb → hidclass → kbdhid → kbdclass` to Microsoft's
in-box `winusb.sys`. Two properties become structural rather than enforced:

- **Blocking.** The interface is not in the keyboard stack, so nothing else on
  the machine can see a keystroke from it. There is no filter to install, no
  hook to lose a race with, and — the point of the milestone — no third-party
  kernel driver whose 2012 certificate is about to stop being trusted.
- **Identity.** One `nusb` device per board, keyed on the instance path. This
  retires the 10-slot ceiling and makes two identical boards distinguishable by
  port in configuration. It does **not** make T4 simultaneously prepareable:
  Windows driver packages still bind by shared hardware ID, so the transaction
  refuses twins that are present together (`USE-CASES.md` T4).

**The installed lifecycle.** `ksx winusb status` remains a read-only advanced
survey. The customer mutation path is Studio `/start` → typed
`MachineSource::winusb_prepare`/`winusb_release` → fixed installed elevated
helper. The browser supplies only the exact selector/instance it was served and
the named confirmations; it never supplies a backend, executable, DLL or raw
command. The unelevated side canonicalizes the current executable and fixed
helper sibling under the Windows Program Files Known Folder. The helper repeats
that rule for `libwdi.dll`; both repeat live strong owner/DACL/reparse checks.
Portable, development and user-writable copies refuse.

`ksx-winusb-helper` is the 16th current Cargo workspace package after the legacy
import crate was removed. It is a Windows GUI-subsystem, requireAdministrator
binary with three fixed installed modes: prepare-exact, release-exact and
cleanup-owned. The replaceable C provider is not a workspace crate. It has a
three-function ABI and can prepare a signed package but cannot enumerate or
install a device; Rust owns the exact target and `pnputil` transaction.

**The refusal.** Preparation refuses a stale selector, unsupported or ambiguous
interface, shared hardware ID, unsafe package scope, or the last separately
connected keyboard that can type now. This is not a warning. A prepared
interface is invisible to Windows, and re-injection cannot reach the secure
desktop — so taking a machine's only keyboard would leave the user unable to
answer UAC, log in, or use the release UI. Three server-validated confirmations
precede elevation: a different tested keyboard, the selected keyboard's typing
consequence, and the machine-local signing certificate.

What it counts is **keyboards that can deliver a keystroke right now, by
physical board**, and every word of that is load-bearing, because a count of
rows in the keyboard class can be talked into saying "you have a spare" about a
keyboard that cannot type:

| not counted | why |
|---|---|
| bound to `winusb.sys` (ksx's claim or anyone's) | it has left the keyboard stack; the HID child lingers in the tree until Windows re-enumerates |
| present but not connected (`CM_PROB_DEVICE_NOT_CONNECTED`) | a paired Bluetooth keyboard in a drawer is present all day and types nothing |
| disabled, driverless, not started | same |
| a second keyboard-class node of the **same board** | one composite board (an I-PAC's `MI_00`/`MI_02`, any gaming keyboard's consumer-control collection) is one keyboard, and claiming it takes the whole board |

Board identity is the `ParentIdPrefix` chain up to the composite device
(`winusb::board_of`) — the same structural identity the backend uses, so two
*identical* I-PACs on different ports are still two keyboards (T4) while two
collections of one board are one. `ksx winusb status` prints the same number
under "keyboards that can type right now" and lists what it did not count and
why; a refusal a user cannot reconstruct from the status screen is a refusal
they will work around.

Driver-package scope is hardware-ID-wide even though selection is
instance-exact. Preparation refuses an identical present sibling, and the UI
tells the user to release before connecting another identical keyboard. If an
identical device is connected later, Studio requires it to be unplugged before
Release so the selected instance remains unambiguous; package removal returns
the twin to HidUsb when it is reconnected. Receipt cleanup remains package-wide.

**The journal and commit point.** The elevated transaction resolves the live
target again, writes a protected receipt before package generation and before
package installation, and never treats helper exit success as authoritative.
Standard-user code receives only a read-only receipt view; it cannot mutate the
ProgramData transaction state.
The prepare-only provider exact-compares KSX's opened INF template, emits a
one-member SHA-256 catalog, creates a unique non-exportable key, signs while the
certificate is untrusted, then deletes and proves the private key absent before
the public certificate may enter Local Machine Root and TrustedPublisher. Rust
rechecks exact DER/thumbprint/subject and no-private-key postconditions.

After `pnputil`, the backend re-surveys the exact interface and receipt. Only a
fresh WinUSB binding plus Active ownership becomes API state `prepared`; the
inverse requires HidUsb plus Released ownership and becomes `released`.
Post-journal errors compensate or durably become `recovery-required`; reboot is
one such recovery state, not success. Only those canonical API states and an
expected-selector `StageEdit::SetDeviceBackend` may move the in-memory stage.

Release removes affected WinUSB devnodes, deletes only the receipt's exact OEM
package, proves package absence, rescans/proves the selected HidUsb restoration,
then removes the exact certificate and artifacts. Uninstall invokes
the hidden fixed `uninstall-quiesce` first. That command proves its own
executable is a strong-ACL Program Files install, removes only the fixed
`ksx\autostart` task and freshly proves it absent, then sends typed pipe
`quit`. Quit success is a three-phase rendezvous: control loop/tray/session and
panel claim down → response flushed and both pipe instances closed → client
proves the pipe name absent. Only then may the elevated uninstaller run
`cleanup-owned`. It audits every receipt state, disconnected claims, terminal
records and orphan KSX certificate/key namespaces; ambiguity aborts uninstall
and preserves the journal/helper. All scheduler and shutdown waits are bounded;
timeout is failure, never permission to continue cleanup.

#### The design question: what types the frontend's menus?

Once claimed, the panel is not a keyboard. LaunchBox and RetroBat navigate with
keystrokes, so **the panel goes dead the moment emulation stops** — and it was
never alive if ksx is not running. That is a real regression against the
Interception backend, where an unblocked keyboard is just a keyboard.

The answer is symmetric to the claim: ksx owns the device, so ksx puts the
keystrokes back.

```text
         emulation stopped                          emulation running
         ─────────────────                          ─────────────────
 panel → capture → Typethrough → SendInput   panel → capture → engine → pads
                   (types)                          (Typethrough muted)
```

`ksx_platform::inject` is the mechanism: `Key → (set-1 scancode, E0 flag) →
KEYBDINPUT` with `KEYEVENTF_SCANCODE` and `wVk = 0`, so injection is
layout-independent — `ksx_core::Key` *is* a scancode vocabulary, and a scancode
round trip through it is the identity function. (`Key::Pause` is the one
exception: `E1 1D 45` has no single-`KEYBDINPUT` form, so it goes as `VK_PAUSE`.)

`Typethrough` is the policy, and it exists for one bug: **a key held across the
transition into emulation.** The physical release is then consumed by the engine
and never re-injected, so Windows believes the key is held forever. Entering
emulation therefore releases everything `Typethrough` is holding, and so does
its `Drop` — a daemon torn down mid-hold cannot latch a key onto the desktop.
Conversely a release for a key it never injected is *dropped*, not forwarded:
synthesising a lone release can cancel a real keyboard's identical key.

**Ownership inversion.** With Interception the capture backend is created and
destroyed per session (`supervise()` owns it), and that is right there: between
sessions every keyboard is an ordinary keyboard whether ksx runs or not. It
cannot hold here — releasing a WinUSB claim between sessions would not make the
panel a keyboard again, it would only stop anything reading it. So the **daemon**
owns the claim for its whole lifetime, and the session borrows it:

```text
 ┌─ daemon::panel::Panel (process lifetime) ──────────────────────────┐
 │  WinUsbBackend (claimed, NullInjector) ── events ──▶ typethrough   │
 │      ▲ ctl: Shutdown, once, at quit                    thread      │
 └──────┼─────────────────────────────────────────────────┼──────────┘
        │                                   attach/detach │ mode
   ┌────┴───────────────────────────────────────────────┐ │
   │ PanelSession — a CaptureBackend `supervise()` runs  │◀┘
   │ and shuts down per session. Claims nothing.         │
   └────────────────────────────────────────────────────┘
```

`crate::capture::claim_panel` makes the claim once, in `daemon::run`, before the
control loop exists; `crate::capture::build_session` gives each session a
`PanelSession` view of it (composed with a per-session `InterceptionBackend` when
the plan still needs one — those devices keep their per-session lifetime, because
between sessions the OS owns them). Switching modes is one acknowledged message
to one thread: no rebind, no re-claim, no device I/O, so start/stop/reload cycles
cost nothing and an idle daemon is a working keyboard.

Three consequences worth stating outright:

- **One injector.** The panel's backend is built with `inject::NullInjector`, so
  the *only* thing that types for a claimed board is the panel's `Typethrough`.
  Two injectors would mean two independent records of what Windows believes is
  held down, and every mode switch a chance to strand a key.
- **The `Handles` outlive the session, so a session reads them as deltas.**
  Health flags and escape counters are write-only latches, which was invisible
  while the backend holding them died with the session. Now one watchdog trip
  would end *every* later session on its first loop iteration, and one escape
  gesture would disarm every later session's muting. `supervise()` therefore
  takes a baseline of both at startup (`ksx_capture::HealthView`, and
  `seen_escapes` seeded from the live counters) and treats only its own
  increments as its own — the shape `seen_escapes` was always written for, now
  applied consistently. `ksx run` is unaffected: it builds its backend per run,
  so every baseline is zero. The one value that stays cumulative is
  `reboot_required`: Interception slot exhaustion is a fact about the machine
  until it restarts, not about a session, and the tray must keep saying so
  (`CaptureHealth::since`).
- **A device configured after startup is refused, not claimed.** Reload re-reads
  slots, presets and games freely, but a `[[device]]` that became
  `backend = "winusb"` while the daemon was running produces
  `winusb-panel-missing` and says to restart the daemon. Capture mode is a
  per-device choice a user makes, never something a reload performs for them.

`daemon::control_loop_with` drives the mode, and its ordering is contractual and
asserted in CI
(`daemon::tests::the_panel_stops_typing_before_a_session_starts_and_resumes_after_it_ends`):

- `set_emulating(true)` **before** the session is spawned — otherwise a player's
  first inputs are translated into pad state *and* typed onto the desktop behind
  the game;
- `set_emulating(false)` **after** the session is reaped — including when the
  game exited on its own, when a start failed, and on the way out of `quit`.

The mode change is acknowledged, not merely queued: a queued change races the
keystroke stream, and `select!` is free to take a keypress before it.

The end-to-end claim is asserted too, and it has to be: for most of M6 the
ordering test above passed against a *recording* panel while the daemon handed
the control loop a `NoPanel` and every session built its own claim — a claimed
panel was dead between sessions and nothing failed.
`daemon::panel_tests::one_claim_serves_two_sessions_and_the_panel_types_in_between`
drives the real control loop, the real `Panel`, the real `build_session` and the
real `supervise()` across two sessions on one claim, and asserts the panel types
between them. The claim itself is the only thing mocked, and it counts how many
times it was opened.

Emergency escapes keep their property through all of this. `LeftCtrl ×5` is
detected in the capture thread and latched in the shared `EscapeHandle`; the
typethrough reads that latch **live, per event**, so the gesture puts the panel
back to typing on the very next key with no control message and nothing a wedged
supervisor could starve.

The latch is one-way *within* a session — nothing the supervisor does may
re-capture keyboards behind an escape's back — and re-armed **once**, at session
start (`EscapeHandle::arm`). That boundary is the only place where re-arming is
the user's own instruction: they asked for emulation now, after whatever they did
before. Without it a gesture used to escape one game would still be freeing the
panel during the next one, and "freed" while emulation runs means the panel types
onto the desktop *and* drives the pads — double input on every press. The
counters are deliberately not reset, because a monotonic counter is what lets a
session take a baseline. Both halves are asserted end to end in
`daemon::panel_tests` (a session-1 gesture must not mute-break or print `[ESC]`
in session 2; a session-2 gesture must still free the panel immediately).

**The honest failure mode.** If ksx is not running, a WinUSB-claimed panel does
nothing. No keys, no menu, no way out from that panel. Injected keys also never
reach the lock screen, a UAC prompt or `Ctrl+Alt+Del`, and they carry
`LLKHF_INJECTED`, so anti-cheat that rejects synthetic input will reject them.
That is the price of escaping the 2026 driver cliff, and it is paid down by
exactly three things, none of which is a promise that ksx never crashes:

1. **Autostart** (M5) — `ksx autostart --enable` registers the daemon at logon,
   which is what makes "ksx is always running" a property of the machine rather
   than a habit.
2. **A separately tested second keyboard**, which preparation refuses to let
   you go without and which remains usable at UAC/the secure desktop.
3. **The installed Release action** — a separately confirmed receipt-owned
   transaction in Studio, plus the `pnputil`/Device-Manager recovery equivalents
   in `RECOVERY.md` §2 for a machine where the app cannot start.

**What signing costs.** `winusb.sys` is in-box and WHQL-signed, but the generated
INF still needs a catalog. The installed prepare-only provider creates that
catalog and its one-transaction machine-local certificate without a WDK,
network download, test-signing, bundled coinstaller or third-party kernel
driver. The certificate is public-only before trust and is owned by exact
receipt identity so Release/uninstall can remove and prove it absent.

#### The capture backend (`crates/ksx-capture/src/{winusb,hid,composite}.rs`)

`WinUsbBackend` satisfies the same `CaptureBackend` contract as
`InterceptionBackend` — passthrough by default, escapes evaluated in the capture
thread upstream of every channel, bounded `try_send` with drop counting, health
and presence handles, no allocation or locks on the hot path. **One instance owns
one claimed interface**; several boards are several instances, composed by
`CompositeBackend`. That is what keeps the hot loop a single blocking read
instead of a hand-rolled multiplexer.

**`SetCaptured`/`SetPassthrough` keep their meaning and invert their mechanism.**
The question is still "is this device's input allowed to reach Windows", and
`decision::should_resend` still answers it — one predicate, both backends. What
changes is the verb:

| | `InterceptionBackend` | `WinUsbBackend` |
|---|---|---|
| default state of a device | typing into Windows | invisible to Windows |
| `SetCaptured([id])` | start suppressing `id` | stop **injecting** `id` |
| `SetPassthrough` | stop suppressing | start injecting everything |
| escape latch / stall watchdog | releases the filter | starts injecting |
| ksx crashes | keyboard works again in <1 s | keyboard stays dark |
| a bug leaks | a keystroke reaches Windows | a keystroke vanishes |

The last two rows are the ones to internalise. **Crash-only recovery no longer
covers the blocking**: killing ksx frees an Interception-captured keyboard, but
it does not un-bind a WinUSB interface. What crash-only still buys is that
nothing is left *half-pressed* — the backend tracks every key it injected and
releases them all on any exit path, panic unwind included. Restoring the board
to a keyboard is `ksx winusb release` (§RECOVERY.md 2).

Escapes work on a claimed board and do give the keyboard back, because
passthrough here *is* injection: `LeftCtrl ×5` flips the latch and the panel
types again through `SendInput`. The latch itself lives in the shared
`EscapeHandle`, so one gesture on any board frees every board in the session —
with two claimed I-PACs plus an Interception context, a per-thread `bool` would
have freed only the panel you happened to reach.

**Report parsing is the substance, and it is pulled at runtime.** The interface's
HID report descriptor is fetched once at claim time (`GET_DESCRIPTOR(Report)`)
and parsed into fields: 1-bit *variable* runs are usage bitmaps (the boot
report's modifier byte; the whole of an NKRO report), *array* items are usage
slots. Hardcoding the 8-byte boot report would work until an Ultimarc firmware
update re-laid it out and every key landed on the wrong pad. Rollover is the rule
worth knowing: a report whose array carries `ErrorRollOver` is treated as **no
information** — previous state held, nothing emitted — because the naive reading
("no usages, release everything") snaps every held input off for a frame on a
saturated encoder, mid-motion.

Usages reach `ksx_core::Key` through the *existing* `keymap::corrected_key`
table, via set-1 scancodes, rather than a second usage→key table. Presets and
the recorded replay corpus are both written against that one
vocabulary; a parallel table would be a second source of truth that disagrees
silently. `ksx_platform::inject::stroke_for` is its deliberate independent
inverse, and the two are pinned against each other in CI.

**Identity is the USB interface instance path**
(`USB\VID_D209&PID_0430&MI_00\7&TEST_DEVICE&0&0000`, synthetic example),
canonicalised uppercase — not a hardware id. Composite children are matched to
their physical parent through `usbccgp`'s `ParentIdPrefix`, which is what makes
two identical boards two different ids. Enumeration
(`ksx_capture::usb_candidates`, `ksx devices`) is strictly read-only: it opens
nothing and claims nothing, so it is safe mid-session. Only
`WinUsbBackend::claim` takes an interface, and it **refuses** any interface not
already bound to `winusb.sys`. The installed elevated transaction performs the
rebind first; session startup never does so as a side effect of Play or reload.

Backend choice is per device (`[[device]] backend = "winusb"`), resolved in the
pure planner (`RunPlan::winusb`, `needs_interception`) and built in one place
(`ksx-backend/src/capture.rs`) so `ksx run` and the daemon cannot drift. WinUSB
interfaces are claimed **before** the Interception context is created, so a claim
failure happens while every keyboard on the machine is still completely normal.
When no bound device needs Interception, no Interception context is created at
all — which is exactly the milestone's exit criterion, falling out of the plan
rather than being a special case.

## Interim operational caution (M0–M5)

While an installation still depends on Interception, Windows code-integrity
policy changes can block that cross-signed driver. Treat an audit→enforcement
transition as a migration risk, not as proof about any particular machine.
M6 removes the dependency. Recovery runbook: [`RECOVERY.md`](RECOVERY.md).
