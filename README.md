# KSX

KSX splits one or more keyboards — including arcade encoders like the Ultimarc
I-PAC that present as keyboards — into as many as **16 virtual game controllers**
on Windows 11. The first four can be Xbox 360-style controllers; supported
additional players use PlayStation-style controllers without pretending
Windows' four-controller XInput limit does not exist.

KSX is a standalone Rust product with its own configuration, engine, Windows
integration, Studio interface, installer, and release lifecycle. Prior work that
informed its initial domain investigation is acknowledged in the credits; KSX
does not vendor or distribute a predecessor application.

## Download

**[Releases](https://github.com/Victor-Villacis/ksx/releases)**
— one file, `ksx-<version>-setup.exe`. Double-click it, click through the
wizard, and ksx opens directly to the guided first-run screen with a
notification-area icon. The customer shortcut is console-free; Studio runs on
localhost in an Edge/Chrome app window, not Electron and not a normal
default-browser tab. Windows 11, 64-bit. Nothing else to install first.

Windows will say **"Windows protected your PC"**, because the installer is not
code-signed: click **More info**, then **Run anyway**. Every release body
carries the installer's SHA-256 and the commit it was built from, so you can
check the file rather than take that on faith.

Each release is built on a GitHub runner from a pushed `v*` tag and never on a
developer machine — [`docs/RELEASING.md`](docs/RELEASING.md). An advanced
portable ZIP is attached beside the installer, but it deliberately omits the
elevated WinUSB helper and prepare provider. It can use Interception or a device
that an installed KSX already prepared; it cannot perform the supported
prepare/release flow and is not the file to start with.

**Taking this over?** [`docs/HANDOFF.md`](docs/HANDOFF.md) is the orientation:
what ksx is, how the crates fit together, what is finished, what is not, and
the half-dozen beliefs about this codebase that turned out to be false.

**New here?** [`docs/QUICKSTART.md`](docs/QUICKSTART.md) is the actual customer
journey: install, choose a keyboard and controller, map it, choose split or
freeze, then Save, Play, or both. It requires no terminal or file editing.

## Why KSX

Keyboard-to-controller software on current Windows needs a capture path with an
explicit recovery model and a virtual-controller stack that games actually see:

| Layer | KSX choice | Why |
|---|---|---|
| Keyboard capture | [`kanata-interception`](https://crates.io/crates/kanata-interception) for broad keyboard support, plus a **WinUSB/`nusb` direct-claim backend** | Per-device routing, scoped blocking, explicit recovery, and a path that uses an in-box Windows driver. |
| Virtual controller output | **ViGEmBus 1.22.0** through a vendored pure-Rust [`vigem-client`](https://github.com/CasualX/vigem-client) | Real XInput slots through Microsoft's `xusb22.sys`, with PlayStation-style targets available beyond the four-controller XInput ceiling. |
| Rich controller output | **HIDMaestro v1.6.1** through KSX's fixed elevated host | One exact plain-USB DualSense, full-state keepalive and bounded rumble feedback without elevating the daemon. |

That table is shipped reality. The output roadmap deliberately keeps three
complementary lanes: ViGEmBus for proven X360/DS4 compatibility, HIDMaestro for
rich byte-exact Windows controller profiles, and VIIPER for virtual USB,
network endpoints and Linux reach. The first HIDMaestro persona—DualSense—is a
shipping installed-only feature; Switch Pro, Xbox Series and VIIPER remain
independently gated. KSX never silently changes a requested controller identity
because one backend is unavailable. See [`docs/ENHANCEMENTS.md`](docs/ENHANCEMENTS.md#e1--a-capability-routed-output-stack).

The checked HIDMaestro setup task clearly requires internet: setup downloads
the exact official v1.6.1 archive, verifies pinned hashes before executing it,
installs the package in an isolated worker, waits for that worker to exit, and
then removes the temporary SDK. Normal Play has no driver download or
package-install authority.

The driver analysis and dated prior-art survey live in [`docs/research/`](docs/research/).

## Core behavior

- **One keyboard → many pads**: a single I-PAC4 fans out to 4 controllers via disjoint
  key-subset presets. Per-device routing alone is not enough; this is first-class.
- Per-device capture with **OS-input blocking** scoped to assigned devices, active only
  while emulation runs — unassigned keyboards keep typing.
- Emergency escapes evaluated in the capture thread, before the blocking decision and
  upstream of every queue, so nothing can starve them: `LCtrl ×5` toggles keyboard
  capture, `RCtrl ×5` mouse capture, `Ctrl+Alt+Del` stops emulation.
- Crash-safe held-input cleanup: a drop guard + watchdog release every key KSX
  injected or held. Interception keyboards return to Windows on process death;
  a WinUSB-prepared keyboard remains structurally off the keyboard stack until
  the installed app releases it, so keep the separately tested spare keyboard.
- All-keys-up release rule, the analog resolver, state-diffed pad updates.

## Developer CLI and operator reference

The installed customer workflow does not require any command below. These are
development, diagnosis, recovery, and cabinet-integration surfaces for people
working on ksx itself. Customer setup lives in Studio as described above.

### `ksx run`

Plugs the virtual pads, captures the keyboards your slots are bound to, and
translates. Everything else on the machine keeps typing.

```sh
ksx run                      # slot layout from config.toml
ksx run --game "Example Game"   # layout + block flags from a games.toml profile,
                                  # and start the profile's program
ksx run --game "X" --no-launch    # apply the profile, launch nothing
ksx run --dry-run            # resolve and print the plan; touches no driver
ksx run --latency            # rolling capture→submit p50/p99/max every 5 s
ksx run --json               # one summary object on stdout (human text on stderr)
```

Startup order is deliberate: pads first (a missing ViGEmBus is found while every
keyboard is still normal), then capture in passthrough, then blocking — for the
bound keyboards only — and only **then** the game. A game started before the
pads exist enumerates zero controllers and never asks again.

#### Launching a game (`--game`)

When the profile has a `path`, `ksx run --game` starts it after the pads are up
and stops emulation when it exits (exit 0). Two deliberately separate hand-off
behaviours keep launchers from ending a session before the actual game starts:

- **A process that exits within 10 seconds was a launcher, not the game.**
  `steam.exe`, a `.bat`, a 32→64-bit trampoline: they hand off and return.
  Some launchers need several seconds to hand off, and stopping emulation too
  early leaves a player mid-launch with no pads. Tune it per profile with
  `launcher_grace_ms` (milliseconds):
  lower it if you want a short session noticed sooner, raise it for a launcher
  that is slower still.
- **After a hand-off, ksx hunts for the profile's `process_name` for 60 s** and
  then follows *that* process to its exit. This is a separate timer from the one
  above, so launcher hand-off and game lifetime remain separate decisions.

```toml
[[game]]
title = "Portal 2"
path  = "steam://rungameid/620"
process_name = "portal2.exe"   # required for URLs: the shell returns instantly
```

A `steam://` profile with no `process_name` gets a loud warning naming the exact
file and the line to add — and runs anyway. The pads work, the game works, and
the emergency escapes still end the session.

**ksx never kills a game it started.** Stopping emulation leaves the game
running; your keyboard simply starts typing into it again.

#### Emergency escapes

Printed as a banner before anything can block a keystroke, and evaluated on
**every** keyboard, captured or not — so they work from a keyboard the config
never mentions, with a fullscreen game holding focus:

| Hotkey | Effect |
|---|---|
| `LeftCtrl` ×5 | toggle keyboard capture off/on (beep confirms; high = on) |
| `RightCtrl` ×5 | reserved for mouse capture — logged only, M4 never touches `mouse.sys` |
| `Ctrl`+`Alt`+`Del` | stop emulation: unplug the pads, release the keyboards, exit 0 |

Press the same key 5 times with no other key in between. The gestures are
evaluated **inside the capture thread**, before the pass/suppress decision, so
they keep working when everything downstream (engine, output thread, a ViGEm
driver call) is wedged.

##### `Ctrl+C` does not work while your keyboards are captured

Interception suppresses captured strokes *below win32k*, so Windows never
generates a `CTRL_C_EVENT` and `ksx`'s console handler never runs. Use
`LeftCtrl ×5` or `Ctrl`+`Alt`+`Del` instead. `Ctrl+C` only works from a keyboard
`ksx` is **not** capturing, or before blocking is enabled.

`taskkill /f /im ksx.exe` also returns every keyboard — process death frees the
filters with no cleanup at all — but you need an input device you can still act
from. The mouse is never captured in M4, so a mouse-driven Task Manager is
always a way out.

#### Exit codes

| code | meaning |
|---|---|
| 0 | clean stop — the `Ctrl+Alt+Del` escape, **the `--game` game exiting**, `--dry-run`, or `Ctrl+C` where it can be delivered |
| 1 | unexpected error |
| 2 | refused to start: invalid config, unknown `--game`, **a `--game` profile whose exe does not exist**, a missing driver, two keyboards sharing one hardware id, or any pad-plug failure. Nothing was plugged and no filter was set |
| 3 | started, then a runtime failure tore it down (thread death, capture panic, stall watchdog, **a game that failed to launch**). Keyboards were released first |

The 2/3 line is exactly "was a keyboard filter ever armed". A 2 means the
machine is untouched.

### Other commands

```sh
ksx setup                         # first contact: press the panel, it writes the config
ksx preset list --templates       # ready-made layouts for standard panels
ksx preset new "P1" --from-template arcade-6button --player 1
ksx devices                       # keyboards as the driver sees them (read-only)
ksx monitor --for-secs 10         # live per-device key stream, never blocks
ksx monitor --record demo.jsonl   # ...and write it down as a session recording
ksx play demo.jsonl               # play that recording back into the real pipeline
ksx pads --count 4                # plug 4 test pads, LED order, kill-recovery
ksx doctor                        # driver health, CI-policy state, verdicts
ksx winusb status                 # WinUSB claim state per USB interface (read-only)
ksx winusb sweep-certificates     # report leftover KSX signing certificates (read-only)
```

#### `ksx setup` — the developer first-contact wizard

Identify the panel by **pressing** it ("hold a key on the panel for player 1"),
then one position-named prompt per control (`SOUTH`, not `A`) with auto-advance,
an inline `ALREADY TAKEN` when a key is reused, and a countdown that skips a
control you have no button for. It ends at a review screen with a completeness
audit — it warns when the panel can reach neither START nor BACK, the cabinet's
exit keys — and **writes nothing until you confirm**. Then it asks (never
assumes) whether to point a slot at the result, and offers the next player, so
P1→P4 is one continuous run. `--dry-run` walks the whole thing and writes
nothing; `--json` prints the outcome.

Stop emulation first: a captured panel's keys are suppressed below win32k and
the wizard cannot hear them.

#### `ksx play` — replay a recorded session

`ksx monitor --record demo.jsonl` writes a timeline: one JSON object per key
event, with the milliseconds it happened at. `ksx play demo.jsonl` makes that
file the session's input device. Same plan, same presets, same personas, same
pads, same teardown — the only thing that changed is where the key events came
from, which is what makes it worth having: an attract-mode loop for a cabinet,
and a full-stack regression test that needs no hardware.

```sh
ksx monitor --record demo.jsonl --for-secs 30   # mash buttons; it writes them down
ksx play demo.jsonl                             # watch it run
ksx play demo.jsonl --loop --speed 1.5          # attract mode, half again as fast
ksx play demo.jsonl --game "MAME" --as ipac     # in a game profile, onto a named board
```

**Live input is suppressed while it plays.** The boards the recording drives
are captured exactly as `ksx run` captures them, so their keystrokes do not
reach Windows, and their events are discarded rather than mixed into the
recorded timeline — otherwise you fight the recording inside the game, which
sees both. The emergency escapes still work: `LeftCtrl ×5` frees the keyboards,
`Ctrl+Alt+Del` stops the session.

**A recording names devices by the id they had when it was recorded**, which
after a replug — or on another machine — can name nothing. `--as` points a
recorded device at a configured one, by `[[device]]` alias or by selector, and
a recording where *nothing* drives a slot is refused before a pad is plugged,
naming what it holds, what this session drives, and the command to type. A
recorded device that drives no slot is played and ignored — exactly what an
unassigned keyboard does in a live session.

`--dry-run` resolves the recording against the plan and prints what would drive
what, touching no driver.

#### `ksx daemon` — stay resident with a tray icon

```sh
ksx daemon --game "Four-player Example"       # tray icon; emulation on demand
ksx daemon --headless             # same commands on stdin
ksx daemon --start                # begin a session immediately
```

Menu (and headless commands): **start**, **stop**, **reload** config, open
**config** folder, **quit**. The tooltip shows the current state and any capture
health problem from the last session (reboot required, watchdog tripped, dropped
events).

The tray runs on its own thread with its own message pump and has **no** path to
the capture, engine or output threads — it can only enqueue a command. A wedged
tray costs you a menu, never your keyboards; input processing never depends on
the tray UI continuing to respond.

Exit codes: 0 clean, 1 error, 2 the configuration does not resolve.

#### `ksx autostart` — cold boot to a live tray

```sh
ksx autostart --enable --game "Four-player Example"
ksx autostart --status
ksx autostart --disable
ksx autostart --enable --dry-run     # exact XML + schtasks line, registers nothing
```

A **per-user** logon task — `InteractiveToken`, `LeastPrivilege`, never elevated
— running `ksx daemon [--game <TITLE>]` 10 seconds after logon: the tray icon
comes up and **nothing is captured** until a session is started from the tray or
a wrapper. That default is deliberate — a registered `ksx run` would grab the
assigned keyboards at every logon, desktop use included. `--mode run` registers
exactly that instead, for kiosk cabinets where logon-straight-into-the-game is
the point. Idempotent.

`--enable` validates before it registers: the config must pass the same checks
`ksx run` applies, the profile must exist, and its executable must be on disk.
Otherwise it refuses with exit 2 — a typo caught here is one line of output, the
same typo registered is a cabinet that cold-boots to nothing on a console nobody
sees.

`--status` also reports a **stale** registration (ksx moved, the task did not)
and exits 2 when it finds one.

Exit codes: 0 done, 1 error, 2 refused / stale.

#### `ksx install-drivers` — the bundled ViGEmBus, verified

```sh
ksx install-drivers                 # report + verify; runs nothing
ksx install-drivers --dry-run
ksx install-drivers --yes           # execute (needs an elevated terminal)
ksx install-drivers --repair --yes  # run setup again over an existing install
```

**The setup wizard runs this for you**, from a checkbox ticked by default — it
is elevated already, which is the one thing this command needs and the one
thing ksx will never obtain for itself. The commands above are the same code
path, for a machine set up some other way or a driver that has since gone
missing. With ViGEmBus installed and healthy the plan is `already-installed`
and nothing runs.

Two independent pins must both hold before anything runs: the installer's
**SHA-256** and its **Authenticode signer**, both recorded in
[`docs/DRIVERS.md`](docs/DRIVERS.md). The file is opened **once** with writers
and deleters locked out, hashed and signature-checked through that handle, and
the handle stays open across execution — so the bytes that were checked are the
bytes that run. When elevated, ksx also refuses to search any directory a
standard user could write to.

A file that fails verification is refused, and ksx will not print a command line
for it either. This ViGEm installer verb never downloads or self-elevates. The
separate installed WinUSB flow below elevates only its fixed-purpose GUI helper
after explicit in-app consent.
Interception is reported but never installed (non-commercial licence).

The signer pin is not "the certificate is valid today" — code-signing
certificates outlive by design the binaries they sign. ksx does what Windows
does: an **expired** certificate is accepted only when a timestamp
countersignature, *verified* rather than assumed, places the signing time inside
the certificate's validity window. The bundled ViGEmBus 1.22.0 asset is exactly
that case (certificate expired 2025-02-16, signature timestamped 2023-11-02), and
`install-drivers` reports it as `expired-timestamp-verified` with the date shown.
An expired certificate with no timestamp that survives checking is still refused.
See [`docs/DRIVERS.md`](docs/DRIVERS.md) for the four checks and the state codes.

Exit codes: 0 nothing to do / installed, 1 error, 2 refused (verification
failed, installer missing, elevation needed), 3 the installer ran and failed.

#### Built-in Windows USB mode — escape the 2026 driver cliff

The supported customer path is in installed Studio. Pick one exact supported
USB keyboard on `/nocturne`, then choose **Prepare selected keyboard** on the
capture card beside it. Where a shared Interception installation is already
usable the same card offers the built-in path as an option rather than a
blocker. Before Windows elevation begins, the page requires three separate
confirmations:

1. a different keyboard is connected and was tested typing;
2. the selected keyboard will stop ordinary typing until Release; and
3. KSX may install a machine-local certificate used only to sign this
   computer's generated device package.

Windows shows UAC, but no command window. The unelevated app passes only the
freshly revalidated exact selector and instance to the fixed installed
`ksx-winusb-helper.exe`; that helper accepts only its fixed installed sibling
`libwdi.dll`. User-writable/development copies and the portable ZIP refuse this
path. Studio changes the staged backend to `winusb` only after the helper has
returned and KSX has independently re-enumerated that same interface as WinUSB
with an active receipt. Release performs the inverse verification before the
stage returns to `interception`.

The CLI below remains an advanced diagnostic and recovery surface, not the
customer preparation recipe. Its applying forms use the same installed helper,
durable receipt, UAC boundary, and final-state verification as Studio:

```sh
ksx winusb status                       # read-only: which interfaces, which driver, claimable?
ksx winusb status --json
ksx winusb claim "USB\VID_D209&PID_0430&MI_00\7&TEST_DEVICE&0&0000"        # DRY RUN
ksx winusb claim "USB\VID_D209&PID_0430&MI_00\7&TEST_DEVICE&0&0000" --yes  # installed helper + UAC
ksx winusb release "USB\VID_D209&PID_0430&MI_00\7&TEST_DEVICE&0&0000" --yes
ksx winusb sweep-certificates             # report only; no elevation or mutation
ksx winusb sweep-certificates --yes       # remove unused certificates and stranded KSX one-time signing keys
```

Rebinds the selected USB interface from the keyboard stack to Microsoft's
in-box `winusb.sys`, after which ksx reads its HID interrupt endpoint directly.
Blocking becomes structural: the interface is not in the keyboard stack, so
nothing else on the machine can see a keystroke from it. The Windows package
matches a hardware model rather than a physical port, so preparation refuses
when an identical keyboard is already connected and Release must happen before
another identical keyboard is attached ([`USE-CASES.md`](docs/USE-CASES.md)
T4). No third-party kernel driver, so nothing to expire in 2026.

**The trade, and you should decide about it before you run anything:** a claimed
panel is no longer a keyboard. It types only while `ksx daemon` is running — the
daemon holds the claim for its whole lifetime and re-injects the panel's
keystrokes with `SendInput` whenever emulation is stopped, including between two
games, so frontend menus keep working — and **if ksx is not running it does
nothing at all.** Injected keys also never reach the lock screen, a UAC prompt or
`Ctrl+Alt+Del`. Mitigations: `ksx autostart --enable`, one ordinary keyboard on
another port, and the one-command rollback. `claim` **refuses** to take the
machine's last keyboard (exit 2) — counting only keyboards that can type right
now, one per physical board, so a claimed, disabled or paired-but-disconnected
keyboard cannot be mistaken for your spare.

The installed transaction generates the one-interface INF and catalog inside a
protected machine-wide journal. Its provider creates a fresh non-exportable key,
signs the catalog, deletes and proves the private key absent, then installs only
the public certificate in Local Machine Root and TrustedPublisher. The helper
journals before every irreversible boundary, re-surveys afterward, compensates
failures when it can, and otherwise records `recovery-required` instead of
claiming success. It never enables test-signing, downloads a driver, or bundles
a third-party kernel driver: `winusb.sys` is part of Windows.

Release removes the receipt's exact OEM package, re-enumerates the selected
device back onto HidUsb, and removes the exact certificate and transaction
artifacts. Driver packages match hardware IDs, so Release must happen before
another identical keyboard is connected. If one is connected later, unplug it
first: Studio refuses to guess between identical live devices. Removing the
hardware-wide package also prevents that twin from using it when reconnected.
Uninstall runs the same ownership audit across active, interrupted,
disconnected, and terminal receipts; if it cannot prove cleanup, uninstall
stops and preserves the recovery components rather than deleting the way out.

An interrupted or older setup can leave KSX's public signing certificate in
Local Machine Root and TrustedPublisher after its transaction is over.
`ksx winusb sweep-certificates` reports those leftovers without elevation or
mutation; add `--yes` to use the fixed installed helper and UAC to remove them
and any stranded container in KSX's fixed one-time signing-key namespace.
This is not `release-all`: it removes no driver package and changes no keyboard.
KSX keeps every certificate whose reported signer still matches an installed
KSX package. If any installed package has no attributable signer, or one
subject names different certificate bytes, the whole
sweep refuses instead of making a partial guess. Each deletion is pinned to the
certificate's thumbprint and DER hash, then the stores are read again.

Migration walkthrough: [`docs/MIGRATION-WINUSB.md`](docs/MIGRATION-WINUSB.md).
Rollback: [`docs/RECOVERY.md`](docs/RECOVERY.md) §2 — including the Device
Manager route that needs only a mouse.

Exit codes: 0 reported/done, 1 unexpected error, 2 refused before mutation
(unknown or ambiguous device, unsafe certificate classification, or the only
keyboard), 3 elevated helper/apply failure, 4 recovery or post-mutation state
could not be verified.

#### Frontend integration

LaunchBox and RetroBat wiring, plus a wrapper that always stops ksx:
[`docs/INTEGRATION.md`](docs/INTEGRATION.md) and
[`examples/ksx-wrap.ps1`](examples/ksx-wrap.ps1).

## Status

The current tree is the **KSX 0.4.1 release line**. Studio is now **one product
page plus three tool pages**: `/nocturne` carries the whole guided Hardware ->
Controller -> Mapping -> Play workspace, and `/check` (test inputs), `/pads`
(virtual controllers) and `/devices` (hardware) sit beside it behind one Tools
menu. Live input feedback, controller-aware readiness, conflict-safe binding
and a responsive light/dark interface hold across all four. The same release retains saved games,
recovery, packaging, and one installed USB DualSense through the bounded
HIDMaestro backend. The supervised cabinet and controller checks in
[`docs/GATES.md`](docs/GATES.md) remain the authority for physical hardware
evidence. Current implementation state and known limits are in
[`docs/HANDOFF.md`](docs/HANDOFF.md); future ideas are tracked in
[`docs/ENHANCEMENTS.md`](docs/ENHANCEMENTS.md).

CI now exercises the clean-runner provider smoke, the exact HIDMaestro A/B
build and byte-only artifact inspection, the portable distribution, the
installer's safety and repeat-install paths, and Studio's browser matrix — five
path variants across three session states since the pages were consolidated. A pushed release tag repeats that whole pipeline before publishing.
Those results are software and distribution evidence; a local build is not,
and physical Gates 1–4 remain open until their ledgers name supervised hardware
results.

## Workspace

```
crates/ksx-core           pure mapping engine (CI-tested, proptest)
crates/ksx-config         TOML config + presets
crates/ksx-api            the typed control API every front end consumes (no HTTP, no async)
crates/ksx-capture        CaptureBackend: interception / winusb / rawinput-identify
crates/ksx-output         VirtualPadBackend: ViGEmBus + production DualSense HIDMaestro routing
crates/ksx-platform       driver health, install, autostart, WinUSB rebind, SendInput
crates/ksx-games          game launch + exit detection (launcher hand-off)
crates/ksx-app            the `ksx` binary: clap definitions and verb dispatch, nothing else
crates/ksx-backend        every verb's body — the daemon, the run supervisor, the writers
crates/ksx-launcher       GUI-subsystem customer hand-off; no console window
crates/ksx-winusb-helper  installed-only elevated exact-device transaction boundary
tools/hidmaestro-host     installed-only elevated one-DualSense runtime host
tools/hidmaestro-driver-installer explicit pinned driver install/repair boundary
crates/ksx-studio         ksx Studio, the optional localhost UI (feature `studio`)
crates/ksx-cabinet        the operate-only 10-foot egui surface
crates/vigem-client       vendored CasualX/vigem-client (MIT)
assets/brand/             the ksx mark: two master SVGs + every generated raster
tools/icongen/            regenerates them (own cargo workspace — see assets/brand/README.md)
packaging/                Inno Setup script
examples/                 frontend wrapper scripts
docs/                     architecture, integration, driver story, recovery, migration, research
```

`cargo metadata` currently reports 16 workspace packages. The helper is the
16th current member after the legacy-import crate was removed; the C libwdi
provider is corresponding source built by the release workflow, not a Rust
workspace package.

### The icon

One mark, two drawings: a detailed one for 48 px and up and a simplified one
for 32 px and down, because a 2.4-unit outline at 16 px is 0.6 px of grey mud.
The `.ico` carries both as size-specific entries, so Windows picks art drawn
*for* the surface it is painting — 16 px in the tray, 256 px in alt-tab.

```
cargo run --manifest-path tools/icongen/Cargo.toml --release
```

rebuilds every raster from the masters in one pass: the `ksx.exe` resource
(via `crates/ksx-app/build.rs`), the tray icon, Studio's favicon trio, the
egui cabinet window icon and the installer's icon. Full detail in
[`assets/brand/README.md`](assets/brand/README.md).

## License

Except for material identified in [`NOTICE`](NOTICE), all original KSX material
is MIT OR Apache-2.0. That scope includes the Rust and TypeScript source,
documentation, scripts, packaging, tests, tools, and original brand work.
Third-party driver and binary terms are catalogued in
[`docs/DRIVERS.md`](docs/DRIVERS.md).

Third-party material copied *into* this tree — the Lucide `gamepad-2` path in the
brand mark (ISC), the vendored controller art (MIT), `vigem-client` (MIT) — is
recorded in [`NOTICE`](NOTICE), with full texts in
[`THIRD-PARTY-LICENSES`](THIRD-PARTY-LICENSES/README.md). The installer and the
portable release both include that material.

## Credits

- **[djlastnight](https://github.com/djlastnight/KeyboardSplitterXbox)** — prior
  Gaming Keyboard Splitter work that informed KSX's early domain research
- **Francisco Lopes (oblitum)** — Interception
- **Nefarius Software Solutions / Benjamin Höglinger-Stelzer** — ViGEmBus
- **CasualX** — vigem-client
- **[Hifihedgehog](https://github.com/hifihedgehog)** —
  [HIDMaestro](https://github.com/hifihedgehog/HIDMaestro),
  [PadForge](https://github.com/hifihedgehog/PadForge), and direct protocol
  guidance for the live one-DualSense rich-profile backend
- **Alia5** — VIIPER and SISR, informing the planned virtual-USB/network lane
- **jtroo** — kanata-interception
- **Lucide contributors** — the `gamepad-2` silhouette in the ksx mark (ISC)
- **AL2009man** — Gamepad-Asset-Pack, the controller art in ksx Studio (MIT)
