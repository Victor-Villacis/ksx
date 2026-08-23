# Enhancement Roadmap

Product "think outside the box" asks, evaluated against the current product
contracts and dated research that remains under `docs/research/`. Rule: protect
the shipped contract before expanding it — each item below is deliberately
designed-for now (trait boundaries, config schema) so none requires a rewrite
later.

## E1 — A capability-routed output stack

**Decision 2026-08-14: HIDMaestro, ViGEmBus and VIIPER are complementary.**

This is not a winner-take-all driver migration. KSX chooses an output path from
the requested device identity and transport:

| Role | Backend | Product use | Status |
|---|---|---|---|
| Compatibility foundation and fallback | **ViGEmBus** | Proven Xbox 360 and DS4 output, including genuine `xusb22.sys` XInput slots | shipped |
| Rich local Windows controller identities | **HIDMaestro** | Production plain-USB DualSense now; independently gated catalog expansion later | DualSense implemented, hardware acceptance pending |
| Software-defined virtual USB and network transport | **VIIPER** | Virtual controllers, keyboards and mice; remote input; Windows/Linux bridge | roadmap prototype, not shipped |

“Fallback” never means silently turning a requested DualSense into an Xbox 360
pad. Persona substitution changes what the game sees and therefore requires an
explicit compatibility choice. Routing is capability-based: local rich profile
→ HIDMaestro; requested X360/DS4 compatibility → ViGEmBus; virtual USB or a
network/cross-platform endpoint → VIIPER.

- ViGEmBus only emulates X360 and DS4 (DS4 exists in our vendored client behind
  `unstable_ds4`). It will never gain Xbox One/Series — the project is frozen.
- **HIDMaestro** (MIT, active, user-mode) ships a large byte-exact catalog incl.
  Xbox Series, DualSense (adaptive triggers), DS4v2, Switch Pro. Our
  `VirtualPadBackend` trait exists precisely so a `hidmaestro.rs` backend can add
  these personas without touching the engine.
- **VIIPER** is a different lane, not a competing profile catalog. It creates
  software-defined USB devices through USB/IP, runs on Windows and Linux, and can
  be driven locally or over its network API. It is the planned route when KSX needs
  a real virtual keyboard/mouse, remote controllers, or a cross-platform virtual-USB
  endpoint.
- X360 remains the broadest compatibility persona. That is why ViGEmBus remains a
  supported fallback even after HIDMaestro works; retirement of its upstream project
  is a maintenance risk, not a reason to remove a working signed driver.

### E1 status 2026-08-15 — first production adapter implemented

M8 now ships a bounded first controller path:

- `crates/ksx-hidmaestro` carries the authenticated, bounded `KSXH` transport.
  It resolves one fixed protected sibling, binds the UAC process identity, and
  keeps raw driver/shared-memory authority out of the ordinary daemon.
- `ksx-output::HidMaestroBackend` creates one exact DualSense, submits full
  state, renews its lease, drains bounded feedback and tears the host down.
- `ksx-core`: `Persona::{DualSense, SwitchPro, XboxSeries}` + `PadBackend`, with
  `Persona::backend()` as the single statement of the routing rule.
- **Each persona is offered only when its exact implementation lands.**
  `PadBackend::supports(persona)` records that per-persona build capability, and
  `Persona::can_plug()` is what the config validator (`Issue::PersonaNotImplemented`),
  `RoutedBackend`, `ksx pads` and `ksx doctor` all read. The gate is a build fact and
  **never a driver probe** — installing HIDMaestro cannot expose an unimplemented
  persona. A persona is enabled only in the same change that lands and verifies that
  exact implementation, without accidentally enabling its siblings.
- `ksx doctor` reports whether the Driver Store prerequisite for DualSense is
  present and separately names the unfinished Switch Pro/Xbox Series profiles.
- The installed product includes a checked, explicit HIDMaestro driver task.
  Driver installation/repair is isolated from Play-time authority.

**The former source-fact blocker is closed.** HIDMaestro's author supplied the exact
mapping/event/config names and pointed KSX to the authoritative MIT sources:
`driver/driver.h` for the packed shared structures and bounds, and
`sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs` for the creator/writer protocol.
The supported `HMContext` / `HMController` SDK surface is also available.

That does **not** make the removed Rust adapter salvageable. It modeled a small
private latch, while the real protocol includes creator-owned mappings and events,
native HID/GIP/extended input payloads, an output ring, PID/feedback state and
controller configuration. M8 now starts from the supported SDK boundary, but only
through a runtime-only candidate, authenticated host transport and a pinned installer.
It must still measure create/update/feedback/teardown across the Windows input APIs
on clean hardware before broad release. The
previously cited WGI double-input issue was fixed upstream; KSX will test the current
release instead of preserving that stale rationale.

HIDMaestro controller creation is privileged. The production shape is a narrow
installed host/broker with an allowlisted controller-state protocol; the ordinary KSX
daemon, Studio and launched games remain at normal user integrity. Elevating the whole
current daemon would elevate user-editable game launches and local control surfaces,
which is not an acceptable accidental side effect.

The pinned SDK spike, sprint slices and their exact exit criteria live in
[`HIDMAESTRO.md`](HIDMAESTRO.md). That file is the implementation checklist;
this section remains the product decision and capability-routing record.

### E1.1 — VIIPER virtual USB and network lane

VIIPER is scheduled **after the HIDMaestro production spike**, but the architecture is
parallel rather than subordinate:

1. Run VIIPER as a separately installed/server component first; do not embed its
   GPL-3.0 core into KSX without an explicit licensing review. Prefer its documented
   process/network boundary and a narrowly scoped client.
2. Prove a virtual keyboard and one virtual controller locally on Linux and across a
   Windows/Linux pair. Include output feedback, disconnect/reconnect, authentication,
   latency and loss behavior; a localhost demo is not network-product evidence.
3. Generalize `VirtualPadBackend` only when the spike proves the need: gamepads keep
   `PadState`, while keyboard/mouse output use typed device-specific states rather than
   pretending every USB device is a pad.
4. Keep installation honest. Linux uses its USB/IP support; Windows requires a
   validated USB/IP client/driver path. No roadmap line enables a persona until the
   exact packaged path passes clean-machine and uninstall gates.

VirtualHere remains a possible **external raw-USB passthrough integration**. It moves
an existing physical USB device; VIIPER creates a new software-defined one. VirtualHere
is proprietary and may be user-installed or covered by a future OEM agreement, but it
is not a required KSX backend.

## E2 — Lean into Steam Input?

**Verdict: integrate WITH it, never build ON it.**

- Steam Input cannot do our core job: Windows merges all keyboards, so Steam can't
  tell P1's I-PAC keys from P2's — per-device capture below the OS is exactly why ksx
  exists. And Steam-only mapping abandons MAME/RetroArch/emulators.
- But our virtual X360 pads are *first-class* Steam Input citizens (indistinguishable
  from real hardware — the reason XOutput picked this stack). So Steam sees 4 real
  pads and its per-game configs stack on top for free.
- Planned integration (M5 ksx-games): launch `steam://rungameid/<id>` targets,
  Big Picture-friendly autostart ordering (pads plugged before Steam starts
  enumerating), per-profile pad count.

## E3 — Emulate keyboards too (key→key remapping / synthetic keys)

**Verdict: two useful levels, deliberately separate.**

- The engine already owns per-device capture; adding a binding variant that emits a
  *different* keystroke (via `interception_send` on the Interception backend, or
  `SendInput` on WinUSB-captured devices — injected keys come from a clean source)
  turns ksx into a per-device key remapper as a side effect (kanata territory, but
  per-keyboard).
- Use cases: I-PAC admin buttons → frontend hotkeys; one panel button → Alt+F4;
  "create keys first, then controllers" flows.
- Config shape is already compatible: `bindings` values just gain a `key:X` form.
- Local key injection remains the cheap path for frontend/admin hotkeys. A full
  *virtual keyboard device* is a different capability: software that enumerates as
  hardware, including on another machine. That belongs to the VIIPER lane above and
  must not be represented as equivalent to `SendInput`/Interception injection.

## E4 — More than 4 controllers — **MEASURED 2026-08-04: cheap after all**

**Superseded by experiment.** This section used to say the only route past four
players was HIDMaestro or vJoy. That was wrong, and `research/m6.5-ds4-findings.md`
has the measurement:

> Six ViGEm **DS4** targets plugged and enumerated while four X360 pads already
> held every XInput slot — and the XInput count did not move. DS4 targets are
> plain HID devices; they neither consume nor compete for XInput's four slots.

So **>4 players is a ViGEmBus feature**: one driver, already installed, no second
stack, no protocol client to write. The cabinet shape is slots **1–4 as X360**
(genuine `xusb22.sys` XInput, maximum compatibility) and **slots 5+ as DS4**
(HID/DirectInput — MAME, RetroArch, SDL and Steam Input all read those). An
XInput-only game still sees four; that is Windows, not ksx.

The 4-slot cap itself is unchanged and unfixable: no virtual bus can create
XInput slot 5. What changed is that we no longer need XInput for players 5+.

**Shipped 2026-08-04.** The submit bug (`ERROR_NO_MORE_ITEMS`) was a driver
startup window, not a marshalling error — `Ds4Pdo.cpp` drops reports until the
HID stack starts polling, 1–3 ms after `WAIT_DEVICE_READY`; `wait_ready` now
primes through it and `update` retries transients (fix in the vendored client,
worth offering upstream). The persona plumbing is live end to end: `Persona` in
ksx-core (`persona = "playstation"` in TOML, `ds4`/`ps4` accepted as aliases),
`MAX_SLOTS` raised past 4 with a validation rule that refuses a fifth `xbox360`
slot by name, the `PadState`→DS4 mapper with a documented D-pad SOCD collapse,
and `ksx pads --persona playstation` verified on the cabinet: six pads plugged,
driven, and unplugged with zero XInput slots consumed.

**Raised again to 16 (2026-08-07).** The 8 was a guess about panel sizes, not a
measurement, and it was the only thing standing in the way: nothing slot-keyed
truncates above it, and the one hard limit is the `u8` the engine indexes slots
with (255). Four I-PAC4 boards is a 16-player cabinet. The work was not the
constant — it was the three clap `1..=8` ranges and the two `ksx-api` refusal
strings that did **not** track it, so `ksx setup --slot 9` failed at the parser
before reading a file. All five now format from `MAX_SLOTS`, with tests that
compare against the constant rather than a literal. `MAX_XINPUT_SLOTS` is
untouched at 4 — that one is Windows.

## E5 — AI-drivable CLI (accepted into CURRENT scope, not deferred)

This one is not an enhancement — it's now a design rule for every milestone:

- Every `ksx` command: stable exit codes + `--json` structured output
  (`devices`, `doctor`, `pads`, `map`, and later verbs).
- Config is plain TOML files — an AI assistant (or any script) can write a preset,
  validate it (`ksx doctor --config --json` reports structured issues), and hot-reload
  without any UI.
- Planned: non-interactive mapping verbs (`ksx map --slot 1 --function A --key G`,
  `ksx slot assign 1 --device "P1 I-PAC"`), `ksx devices --json` with instance paths
  so an assistant can wire a whole cabinet from a chat session.
- Future idea (post-M5): a tiny MCP server wrapping the CLI so Claude can configure
  ksx conversationally on the cab. The CLI-first design makes this a thin shim.

## E7 — Forma: native-first, web as supplement (decided 2026-08-04)

[Forma](https://github.com/orgs/getforma-dev/repositories) is our own stack (Rust SSR
server + FMIR binary IR + FormaJS signals/islands). **We dogfood it deliberately**:
ksx becomes the flagship app that proves Forma in production. Its low star count is not
a reason to avoid it — shipping something impressive on it is how it gets adopted.

**The constraint that governs everything else: ksx is a native Windows app first.**
Tray, drivers, virtual bus, native config UI. Forma *enhances*; it never costs
performance and it is never required for the product to work.

### Verified before deciding (fetched from the repos)
- **`forma-server` 0.1.4 is a library, not a server** — no listener, no `main`, **no
  tokio dependency**. `render_page(&PageConfig) -> PageOutput` is a *synchronous pure
  function*. Our daemon keeps its own runtime and listener. MIT, crates.io, MSRV 1.70.
- **`rust-embed`-only asset serving** — one `.exe` shipping its own UI is Forma's
  default path, not a workaround. No Node at runtime (Node ≥18 at build time only).
- **⚠️ No server push anywhere in the Rust half** — no SSE, no WebSocket. The live
  monitor is ours to build in plain axum 0.8 (kmd proves the pattern but shares no code).
- **⚠️ Hardcoded CSP** (`connect-src 'self'`, no extension API) — collides with LAN
  access and cross-origin WS.
- **⚠️ FMIR version skew**: `@getforma/core` 1.5.0 (Jul) vs Rust crates 0.1.4 (Mar).
  `check_ir_compatibility()` exists because drift was anticipated — verify current
  compiler output still parses **before** building anything.
- **⚠️ Windows untested upstream** (forma CI is `ubuntu-latest` only).

### Three surfaces, one engine
1. **Native primary (non-negotiable)** — CLI + tray daemon (M5) + ~~native config UI
   (M9)~~ **native app identity + launcher (M9, revised 2026-08-06 — see Sequencing
   below and `docs/M9-DECISION.md`)**. Zero HTTP, zero web deps in the default build.
   The cabinet works perfectly with no browser in existence — **as a CLI + tray**;
   the graphical mapper is Studio's, and needs a web engine present.
2. **`ksx-api` (M10a)** — one typed surface for Studio *and* the MCP server (E5). The
   native UI does **not** go through it: in-process calls straight to the supervisor, so
   the primary path pays no serialization tax.
3. **ksx Studio (M10b, Forma)** — optional companion UI: embedded axum + `forma-server`
   SSR + our own SSE/WS. Configure the cabinet *from your phone while standing at it* —
   the case where a browser is genuinely the right client, since a cab has no keyboard.

### "Enhance, never compromise" — enforced, not promised
- **Compile-time optional**: `--features studio` for the web surface,
  `--features cabinet` for the 10-foot one. **The default build links NEITHER**
  — no axum, no forma, no HTTP, and no egui, eframe or winit — and the two are
  independent of each other (a cabinet with no browser builds one and not the
  other). Provable, all three ways:

  ```
  cargo tree -p ksx-app -e normal                    | grep -ciE "axum|tokio|forma|eframe|egui|winit"   # 0
  cargo tree -p ksx-app -e normal --features cabinet | grep -ciE "axum|tokio|forma"                     # 0
  cargo tree -p ksx-app -e normal --features studio  | grep -ciE "eframe|egui|winit"                    # 0
  ```
- **Never touches pipeline threads.** Studio subscribes to a lossy fan-out sink; a slow
  browser can never backpressure the engine (same rule as the M4 delta coalescing).
- **Display-rate coalescing** (~60 Hz) for the monitor. Full fidelity lives in
  `--record`, not the socket.
- **Own runtime, normal priority**, isolated from the TIME_CRITICAL capture thread.
- **Localhost by default**; LAN bind is explicit opt-in with a CSPRNG pairing token
  (`ring`, not UUIDv4). Do **not** copy the scaffold's dashboard template — it binds
  `0.0.0.0` with no auth; the minimal template computes a CSP then discards it.

### What ksx gives back (the dogfood loop)
A systems daemon stresses Forma where no web app would, and each gap becomes a feature
request with a real consumer: **server push (SSE/WS)**, **CSP extensibility**,
**embedding ergonomics** (proof it drops into a non-web Rust binary), **Windows build
validation** (first real Windows consumer), and **FMIR version alignment**.

**The demo that sells both**: open a phone at the cab → four virtual pads rendered live
→ mash the arcade panel → buttons light up instantly with real latency numbers → remap
a button from the phone and it works. One demo, two products.

### Sequencing — REVISED 2026-08-06 (see `docs/M9-DECISION.md`)

As planned: M6 WinUSB → M6.5 DS4 spike → M7 GA → M8 HIDMaestro. **Nothing
web-related preceded M6** — the driver deadline outranked the showcase, and it
held.

What changed after that: **M9 is no longer an egui/eframe config UI.** When this
section was written (2026-08-04) ksx Studio was a status page a few hours old,
so the native UI was the only plan for a mapper and making it non-negotiable cost
nothing. Studio then shipped ~23k lines and 139 tests of finished mapper — art,
identities, multi-bind, first-class diagonals, the 37-column macro piano roll,
toasts+undo, a documented design system — and rebuilding that in egui would buy
one thing E7 asked for (in-process, no serialization tax) that **the pipe already
delivers**: `tray.rs` deliberately rejected in-process for UI, CONTROL-SURFACE
grants the pipe exactly the tray's reach, and the "tax" is one JSON line per
human click, nowhere near the capture thread's p99 budget. The full reasoning,
the per-option engineer-day costs, the honest losses and the reversal triggers
are in **`docs/M9-DECISION.md`**.

Revised: **M9 = "ksx is a real Windows application"** — an owned icon (the tray
still uses `IDI_APPLICATION` today), a Start Menu entry, a tray "Open ksx" item,
and an `ksx open` launcher that starts the daemon, waits for the port, and *then*
opens a chrome-less application window (`--app=` + a ksx-owned `--user-data-dir`,
launched via App Paths). ~700–1,000 lines. → **M10a `ksx-api`** — the typed,
transport-free, in-process API both Studio and any future native shell consume;
it is 80% written already as `ksx-studio`'s `StatusSource`/`ControlSource` and
wants extracting into its own crate with an `InProcess` implementation beside the
`PipeClient` one. It is the one item worth building under every option and it
should land before Mapper Build B. → **M10b Studio** continues as the UI.

Held in reserve, priced, not cancelled: a native WebView2 shell (`webview2-com`
directly — not wry, not Tauri) that hosts the same UI with zero HTTP via
`WebResourceRequested`. 12–16 days on top of `ksx-api`, to be spent only when one
of M9-DECISION §7's triggers fires.

**Scope of "zero web deps", stated honestly.** The rule is unchanged for the
*default build*: no axum, no forma, no tokio, `--features studio`, provable with
`cargo tree`. What is no longer promised is a GUI on a machine with **no web
engine at all** (LTSC/IoT with Edge stripped, a hardened image). There, ksx still
works completely — the CLI is a complete surface by CONTROL-SURFACE's standing
rule, and the tray is native Win32 — but there is no graphical mapper. That is a
real, bounded loss and M9-DECISION §5 does not argue it away.

### Using kmd today
`npx @getforma/kmd` in this repo browses `docs/` as a local dashboard. Ships a
prebuilt Windows x64 binary; no product coupling.
kmd is MIT-licensed (Copyright (c) 2026 Victor Villacis) — nothing blocks anyone
else adopting it.

## E6 — Reuse of existing open source (standing policy)

Already practiced: every load-bearing piece that can be reused is reused:
`vigem-client` (vendored), `kanata-interception` (kanata's shipping fork), `nusb`,
`windows-rs`; HIDMaestro's MIT internals are plan B; PadForge/kanata/AutoHotInterception
are the reference implementations we crib patterns from. New wheels are invented only
where the survey proved none exist (per-device capture + fan-out engine).

## E8 — Cabinet lighting from pad feedback (2026-08-04)

**The idea.** Games and emulators (RetroArch, any XInput-era title) send rumble
and LED-slot feedback to Xbox 360 pads. Our virtual X360 pads **already receive
it**: the XUSB notification callback delivers
`Feedback { large_motor, small_motor, led_number }` per pad into a lossy
64-deep queue (`FEEDBACK_QUEUE_CAP`, `try_send`, per-pad `dropped_feedback`
counter for `ksx doctor`), drained non-blocking by
`VirtualPadBackend::poll_feedback` — see `ksx-output/src/{backend,vigem}.rs`.
Today that data is discarded: nothing consumes the queue. The enhancement is to
bridge it to cabinet hardware. Ultimarc **PacLED64** and **I-PAC Ultimate I/O**
are USB LED controllers with documented protocols; a feedback consumer maps pad
feedback onto their outputs.

**Mapping ideas.**
- Rumble burst → that player's button-cluster flash.
- `led_number` → lighted start button per player (the LED slot *is* the player
  assignment the bus announces).
- Idle → attract pattern across the panel.

**Honest constraints.**
1. **The PlayStation persona can NEVER feed this.** ViGEmBus has no DS4
   feedback/notification IOCTL — `Persona::has_feedback` is `false` for
   PlayStation, and `ksx-core/src/persona.rs` states it plainly: no lightbar or
   rumble will ever arrive on one of those pads. This is Xbox slots (1–4) only;
   players 5+ light nothing from game feedback.
2. **MAME drives cabinet LEDs itself** through its outputs system, straight to
   the same Ultimarc boards. The bridge must **yield to MAME** (off for MAME
   profiles) — it exists for XInput-era games, which only know how to rumble a
   pad and have no other way to reach a cabinet.
3. **Hardware required**: LED-wired buttons plus a controller board. **OPEN
   QUESTION whether the target cabinet has them** — answer this before writing
   any code; it blocks everything.
4. **Feedback is the ONLY upstream channel ViGEm exposes.** There is no other
   game→ksx data path to mine — this is not the first of a series of
   integrations, it is the whole catalogue.

**Verdict: real, and cheap on the ksx side** — a feedback consumer thread
draining `poll_feedback` and speaking the Ultimarc protocol, touching no
pipeline thread (the same "lossy consumer off to the side" shape as E7's
monitor). **Post-M7 priority, blocked on the hardware question.**

### E8 update 2026-08-05 — hardware CONFIRMED, LEDBlinky in the picture, generalized to a feedback bus

The target use case includes **LED-wired buttons** and **LEDBlinky** (Arzoo's
arcade LED software — the de-facto standard: per-game button lighting from its
own controls database, attract modes, native LaunchBox integration) is planned
for it. That changes the design from "ksx drives a PacLED64 directly" to a
**coexistence model**:

- **LEDBlinky owns the static layer** — which buttons are lit/active for the
  current game, attract mode between games. It already knows per-game control
  panels; re-implementing that database would be madness.
- **ksx owns the dynamic layer LEDBlinky cannot see** — real-time rumble and
  player-slot feedback arriving at the virtual pads mid-game. LEDBlinky has no
  concept of rumble; ksx is the only process holding that stream.
- Integration options to spike, in order of politeness: (1) drive spare LED
  channels ksx reserves for itself; (2) momentary overrides through whatever
  interface LEDBlinky/the LED controller exposes (LEDBlinky has a documented
  command-line/API surface; the LedWiz/PacLED64 protocols are open); (3) full
  direct-drive only when LEDBlinky is not running.

**Generalized (product requirement: "send it to whatever else"): the feedback consumer is a
BUS, not a lamp driver.** One consumer thread drains `poll_feedback` and fans
out to pluggable sinks behind a small trait:

- cabinet LEDs (PacLED64 / Ultimate I/O / via LEDBlinky, above);
- **OpenRGB** — its open SDK server supports many RGB ecosystems; rumble →
  case/room RGB flash can be evaluated after confirming the target hardware;
- **ksx Studio** — the live feed already carries it. `LiveFrame::feedback`
  is on the wire and reaches the browser through `/api/live`; what is missing
  is only the RENDER (rumble pulses on the on-screen controller — the PadForge
  live-echo pattern, outbound direction). No new transport is needed;
- whatever else earns a sink (OBS overlay, marquee light, audio cue). Sinks
  are lossy consumers of a lossy stream by contract — a slow sink can never
  backpressure the engine (same rule as everything else near the pipeline).

Status: **unblocked**, still post-M7 in sequence. The Studio live socket it
was to be designed alongside SHIPPED on 2026-08-08 (`ksx-backend/src/daemon/
live_pipe.rs` + `ksx-studio/src/live.rs`), so the sink trait now has a
concrete second consumer to be shaped against rather than a hypothetical one —
and `PadFeedback` is already a field of every frame both of them read.

## E9 — WinUSB residue reporting and narrow certificate cleanup (shipped)

WinUSB preparation has three independent lifetimes, so cleanup cannot be
inferred from configuration alone:

**Three lifetimes, and only one of them is the configuration.**

| what | where | who removes it |
|---|---|---|
| the driver binding | the Windows device tree (`winusb.sys` on that interface) | a release, or `pnputil` by hand |
| the transaction receipt | `%ProgramData%\KSX\WinUSB\{journal,transactions}` | a release, a rollback, or the uninstaller |
| the signing certificate and one-time key residue | the machine Root + TrustedPublisher stores and KSX's fixed key-container namespace | release/rollback/uninstall, or the narrow certificate sweep when no installed package depends on it |

The config root is `%APPDATA%\ksx` and appears in none of those rows. So
**"which boards are prepared" cannot be answered from configuration at all** —
`ksx device pick` writing a `[[device]]` entry and a board being held are
independent facts, a board can be held with no entry naming it, and moving
`config.toml` aside for a clean-machine QA run releases exactly nothing. That
is why the held-keyboard list reads `BoardRow::claimed` off the live scan and
why it belongs on `/start` rather than on the config page.

**Shipped contract.** `/devices` and `ksx winusb sweep-certificates` report
receipt and certificate residue without elevation. The consented sweep invokes
only the installed elevated helper. It joins installed KSX packages to the
certificate subject Windows reports, refuses the whole operation if any
package or cross-store identity is ambiguous, deletes each exact orphan by
subject + thumbprint + DER, clears only KSX's stranded one-time signing-key
namespace, and re-reads the stores before reporting success. A certificate
still signing an installed package is always retained. No driver package,
binding, configuration, or receipt is changed by this verb.

---

## E10 — ksx reads and programs the panel encoder (implementation candidate; hardware gate remains)

**Recorded 2026-08-22 20:24 EDT; implementation candidate updated 2026-08-23
01:54 EDT.** The current evidence, corrections and work log live in
[`PANEL-PROGRAMMING-STATE.md`](PANEL-PROGRAMMING-STATE.md). This entry is the
product decision; that file is the implementation state.

**The user story.**

> *I wired a new player-3 button to SW9. In Control Surface Builder I select
> the exact encoder, read and back up its complete chart, then either keep its
> current keys, ask KSX for a safe four-player layout, or assign SW9 myself. I
> review the terminal and byte diff before anything changes. After I confirm,
> KSX backs up the fresh state, programs the board, reads every byte back and
> tells me whether it verified. I then Teach the real button so the app proves
> what Windows receives. If I change my mind, I can review and restore the
> exact pre-program safety backup with the same verification. KSX still owns profiles, macros,
> turbo, chords, SOCD and whichever controller persona the game needs.*

**The decision.** Keyboard mode is the default I-PAC source substrate. Its
persistent pin-to-key chart provides a stable, per-device input vocabulary;
ksx remains the dynamic layer that transforms those inputs and emits virtual
controllers. Programming the chart complements ksx. It does not replace the
engine or move per-game behavior into EEPROM.

### Mode boundary

I-PAC XInput mode is an **optional hardware bypass**, not the default source
path and not part of the first implementation. On applicable I-PAC4 firmware,
the board can expose four gamepads, consuming the four system-wide XInput
positions ksx otherwise uses for Xbox 360 personas. Ultimarc also documents
important restrictions on reconfiguration while an I-PAC4/Mini-PAC4 is in its
quad XInput mode. Those are model- and firmware-scoped facts, not a universal
statement about every Ultimarc board.

The current keyboard-capture enumerator accepts HID-class interfaces only, so
an XUSB presentation is not a keyboard-capture candidate. A future `ksx panel`
inventory may still identify the physical USB parent and explain how to return
it to keyboard mode. That diagnostic is different from routing the resulting
XInput pads back through ksx, which remains out of scope. The exact
mid-session behavior after a hardware mode switch is **unverified**; do not
promise `XinputBusFull`, a clean unplug or automatic recovery until the cabinet
measures it.

### The key vocabulary is per device

`KeyEvent` carries both `DeviceId` and `Key`, and the engine tracks held keys
per device. The same key on two encoders is therefore two distinct sources.
There is no global requirement for 16 players to occupy 16 disjoint keyboard
alphabets; `MAX_SLOTS = 16` explicitly budgets four four-player I-PAC boards.

There is still a real compatibility boundary to report. The WinUSB HID usage
translator currently maps 106 usages onto 105 distinct set-1 keys, and usages
without a set-1 equivalent — including F13–F24 — intentionally produce no
event. Chart key choice matters because every programmed usage must be
representable on the selected capture backend, and because passthrough or
direct MAME use sees the stored keys without ksx's transforms.

### Implemented surface and end-to-end UX

The implementation candidate retains passive `ksx panel status`, then adds one
explicit, supervised command family:

- `chart [--backup]` performs the complete on-demand report read and can save
  the exact raw image;
- `backups` lists verified, board-specific restore points;
- `program` accepts either the deterministic four-player allocator or semantic
  terminal/normal/shift edits; and
- `restore` targets one verified backup.

The Recommended allocator assigns all 56 normal keys and clears all 56
alternate assignments and shift roles so KSX owns dynamic behavior; opaque
macro/vendor bytes outside those planes remain byte-preserved.

Program and restore are non-mutating plans by default: planning issues the
chart query/read but writes no chart data or EEPROM. Apply requires the desired
SHA-256, exact board fingerprint, `ipac4-pac256-v1` profile, `--supervised` and
`--yes` from that review. Each apply rereads the chart, rejects a stale base
hash, saves and reopens a complete immutable backup before packet zero, writes
the complete image, then rereads and compares every byte. Human output and
typed JSON share the same backend contract.

The Control Surface Builder presents the same model as a short task:

1. **Read & back up** the selected encoder.
2. On an unqualified hardware/profile pair, make one reversible normal-key
   change on a noncritical SW terminal. Exactly one desired byte differs, but
   KSX explicitly warns that the device protocol retransmits all 64 reports /
   the complete 256-byte chart.
3. Program and fully reread that validation chart, then restore and verify the
   exact safety backup. Only that round trip unlocks **Recommended KSX layout**,
   unrestricted **Customize terminals**, and other verified backups. An
   interrupted or partial validation instead requires the same exact restore
   and returns to the unqualified state.
4. Review the semantic changes, expandable byte diff, preserved-byte count,
   blockers and base/desired hashes.
5. Confirm both the exact reviewed change and physical recovery readiness
   (present at the cabinet, WinIPAC closed, separate keyboard/recovery path),
   then choose **Program and verify** or **Restore and verify**.
6. On a verified readback, continue to **Teach inputs** to prove the physical
   wiring and Windows signal; byte verification never impersonates that test.

The staged encoder held by the daemon is authoritative. Browser selectors are
stale-screen guards, plans are bound to selector + board fingerprint + protocol
profile + hashes, and changing any of them invalidates confirmation. Physical
USB bus/port topology, rather than Ultimarc's low-entropy serial, anchors the
fingerprint; moving an encoder therefore requires a future supervised
backup-adoption flow rather than silently sharing restore points. A global
cross-process lease is shared by Play startup and the complete maintenance
transaction, closing the packet-zero race. A durable pre-packet journal blocks
replacement transactions until reread reconciliation or the named restore
resolves it. Interrupted or unverifiable transactions enter a named
`recovery-required` state with the backup retained. Raw images never enter the
browser, URL or control-surface document; only UI preferences may persist in
browser storage.

The recovery store is machine authority, not portable-profile state:
production always uses the installed per-account KSX configuration
directory's `panel-backups` root. Play/start takes the same global lease and
fails closed when that root contains an unresolved or unreadable journal,
cannot be traversed, or contains a symlink/junction/wrong-kind substitute at a
recovery level. Only an actually absent root is clean.

### Protocol evidence and the safety boundary

Ultimarc's [official I-PAC 4 product page](https://www.ultimarc.com/control-interfaces/i-pacs/i-pac4-board/)
establishes the product behavior: 56 inputs, persistent programmable keys,
shifted assignments, generic Windows USB operation and model/firmware-scoped
keyboard/gamepad modes.

The GPLv2 `Ultimarc-linux` implementation was inspected at immutable commit
`20b8c56a3e6f94034b8529eddd777306f5b6152b` only for protocol facts:

- [`common.h`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/common.h)
  records HID class request `0x21/9`;
- [`ipacseries.h`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipacseries.h)
  records older generic value `0x0203`, five-byte messages, a 260-byte buffer
  and generation-specific configuration interfaces; and
- [`ipac.c`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipac.c)
  records an older generic writer; it has no chart-read path and does not prove
  the measured D209:0430 release-0056 MI_02 topology.

The pinned QtPyUltimarc commit
`6f1f5a285201143e6260f0a1451ca469a54ee768` supplies the direct I-PAC4 PAC256
evidence: [`ipac4.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/ipac4.py)
identifies interface 2 and the query/read path,
[`_structures.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_structures.py)
defines exactly 256 bytes, and
[`_device.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_device.py)
records four payload bytes per five-byte report for read/write loops.

KSX's implementation was independently authored from those facts, official
product behavior, Windows HID APIs and KSX's typed domain seams. No source code
was copied; neither research project is a dependency, linked, vendored or
shipped material. `NOTICE` therefore
does not gain an entry under its copied/vendored/embedded/bundled-material
policy. The pinned links and
[`PANEL-PROGRAMMING-STATE.md`](PANEL-PROGRAMMING-STATE.md) retain the research
attribution and GPLv2 license context.

Persistent encoder configuration is a fourth lifetime alongside the driver
binding, transaction receipt and signing residue in E9. The implementation now
enforces the planned safeguards: exact D209:0430/raw-bcd0056/MI_02 path and
five-byte admission including vendor collection usage `FF00:0001`, two
independent matching PAC256 reads, complete raw-image authority, opaque-byte
preservation, immutable verified backup before packet zero,
profile/fingerprint/hash-bound consent, stale reread, a durable transaction
journal, a two-second killable helper-process boundary around each otherwise
uncancellable Windows output call, full write, complete reread equality and
explicit recovery state with phase/packet context. Restore first backs up the
current chart and is itself verified. First-use qualification proves a
reversible one-terminal write and exact restore before general programming is
exposed.

Those are synthetic software guarantees, not target-firmware proof. The live
cabinet has received no chart query or output report from this work. The first
hardware program remains a supervised, user-initiated gate: verify exact
identity and read/backup, review a no-op plan, then change one noncritical
terminal, require full readback plus physical Teach verification, and restore
the exact pre-program safety backup. A no-op still issues the chart query/read
but emits no chart-data write packet, so it cannot by itself prove the
programming path.
Sequential-packet atomicity,
re-enumeration and persistence remain unverified firmware behavior.

### One command family, capability-specific hardware drivers

`ksx panel` should route through a small driver per hardware family/model, not
pretend one universal encoder protocol exists. Each driver declares only what
it can prove: `can_identify`, `can_report_mode`, `can_read_chart`,
`can_write_chart` and whether a write is persistent. An unknown or
non-programmable device remains useful in status output and refuses unsupported
verbs.

Mini-PAC belongs to the Ultimarc protocol family subject to model-layout
differences. PacDrive is an LED/output controller and remains E8 work. Xin-Mo
and “Zero Delay” boards may have no writable configuration surface at all.
Arduino, Adafruit and RP2040 are platforms rather than one protocol; they are
easy only when ksx owns the exact firmware and can define its contract.

### Feature order

1. **Status/discovery — implemented and passively measured 2026-08-22:** stable
   human/JSON output and the selected-encoder Studio card.
2. **Chart/backup/program/restore domain — implementation candidate
   2026-08-23:** complete raw-image model, semantic edit layer, immutable
   backup store and transaction/recovery rules, exercised with synthetic I/O.
3. **Windows transport and typed surfaces — integration-verified candidate
   2026-08-23:** exact five-byte HID transport, MachineSource contract, CLI and
   Studio review/confirm/verify flow. Final local Rust, HTTP and browser gates
   pass, including 682 backend tests (1 ignored hardware-only), 137 Studio HTTP
   tests and 45 canvas browser tests; deterministic assets match across two
   builds. A clean runner remains normal post-merge release evidence.
4. **Supervised cabinet proof — required before hardware-ready:** explicit
   read/backup, one reversible terminal write, complete reread, physical signal
   check, verified restore, then a separate persistence measurement.
5. **Additional encoder drivers — future:** each family declares its real
   capabilities behind the same command/model; unsupported hardware continues
   to refuse rather than guess.

**Verdict: the product and software design are implemented; hardware readiness
remains gated.** Keep keyboard mode as the power path, keep persistent board
configuration separate from KSX's dynamic transforms, and do not promote
synthetic transaction coverage into a real-I-PAC write claim. The living state
document owns the exact test evidence and supervised first-program procedure.
