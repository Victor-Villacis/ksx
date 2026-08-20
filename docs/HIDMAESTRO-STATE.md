# HIDMaestro — living state

**This file wins.** Where any other document, code comment, INF comment or
commit message disagrees with this one, that other text is stale and should be
corrected or annotated, not believed. `docs/HIDMAESTRO.md` remains the *plan*;
this is the *state*.

It exists because the HIDMaestro work produced a run of confident, wrong
statements. Every one had the same shape: a claim asserted from a single source
without tracing to the authoritative one. The register at the bottom names them
so they are not resurrected.

## How to read a claim here

Every factual line carries one tag. **Never restate an `UNVERIFIED` line as
fact, and never let a `SOURCE` line settle a question about runtime behaviour
that a `MEASURED` line could answer instead.**

| Tag | Means |
|---|---|
| `[MEASURED yyyy-mm-dd]` | Observed on a real machine. The command that produced it is given. |
| `[SOURCE path:line]` | Derived by reading pinned source. True of the code; may still not be true of the running system. |
| `[UNVERIFIED src]` | Somebody asserted it. Not checked. Treat as a lead, never as a fact. |

Two rules that would have prevented most of the mistakes below:

1. **Decompose summaries.** A tool that reports "missing, duplicated, or does
   not match" is reporting three conditions. Report which one.
2. **A shared number is not a shared identity.** Two quantities being equal is
   a coincidence until a source says one *is* the other.

---

## Persona state — 2026-08-20

| Persona | Encoder | Device lane | Spawns? |
|---|---|---|---|
| DualSense | yes, frozen conformance | plain HID, `root\VID_054C&PID_0CE6` | **Never observed.** `[MEASURED 2026-08-20]` |
| Xbox Series X\|S | yes, descriptor-derived | **companion-only SWD**, needs `hmswd.exe` | no |
| Switch Pro | yes — 48-byte `0x30` body, semantic buttons | plain HID | no |
| Xbox 360 / PlayStation | n/a — ViGEmBus | ViGEmBus | **yes, working** `[MEASURED 2026-08-20]` |

`PadBackend::supports` in `crates/ksx-core/src/persona.rs` is `false` for Switch
Pro and Xbox Series and must stay false until a device is observed.

### DualSense has never spawned

`[MEASURED 2026-08-20]` Zero devnodes with `HIDMAESTRO` in the instance id have
ever existed on this machine — present or ghost.
`Get-PnpDevice | Where-Object { $_.InstanceId -match 'HIDMAESTRO' }` → empty.

`[SOURCE docs/HIDMAESTRO.md "Delivery state" table]` Physical release
acceptance is **Pending**. (Cited by section, not line — a banner I added to
that file already shifted its line numbers, which is the exact fragility the
repo's docs test guards against for section numbers.)
`[SOURCE ci.yml artifact observation]` The build-twice job records
`candidateLoaded: false` — it compiles and byte-inspects, it never loads.

"Implemented" and "live" in the older docs mean *code complete and CI-proven*.
They have never meant *a device appeared*.

---

## Machine state — 2026-08-20

All `[MEASURED 2026-08-20]`.

- `hidmaestro.inf_amd64_ffdd15d5558ca3d9` **is staged** (published `oem200.inf`).
  `hidmaestro.inf` SHA-256 `187D5B06…` **matches** the ksx pin.
- `HIDMaestro.dll` SHA-256 `287CE56C…` vs the old pin `D68EF6C3…` — **RESOLVED
  2026-08-20 at byte level.** The pin was the UNSIGNED embedded payload (found
  byte-exact inside the verified release `Core.dll`); `InstallDriver()` signs
  the DLL with a test certificate it GENERATES AT INSTALL TIME (cert NotBefore
  = install second minus a day; signing appends ~1.4 KB), so **no fixed pin on
  the installed bytes can ever match**. The install itself is byte-exact
  v1.6.1: the SDK's `InstalledManifestSha256` (`2f5c0313…`) equals the value
  recomputed from the verified release payload, and both INFs install
  verbatim. The archive itself was downloaded and verified against the
  installer's pins (118,879,222 B, SHA-256 `00145C23…`; `Core.dll` =
  `ADADD9E2…`, the HIDMAESTRO.md pin).
- `HKLM\SYSTEM\CurrentControlSet\Services\HIDMaestro` does **not** exist. Expected:
  the UMDF service materialises only when a `root\HIDMaestro` devnode is created.
- `hidmaestro_xusb.inf_amd64_*` is **also** staged (`oem207.inf`, `HMXInput.dll`).
- `xinputhid` is genuine **Microsoft inbox** — own-name INF, MS-signed,
  service running. **No XInput INF needs shipping.**
- ViGEmBus 1.21.442.0 running, zero child pads.

The old probe (`installed` = exactly-one dir ∧ both hashes ∧ service key) had
two structural defects, both fixed 2026-08-20: the DLL-byte pin could never
match (per-install signing, above), and requiring the service key deadlocked
the first spawn — the UMDF service materialises only when the FIRST
`root\HIDMaestro` devnode binds the INF, so the host refused to create the
device that would create the key. The probe (ksx-platform), doctor, the host's
`ProvePreinstalledDualSensePackage` and `runtime-contract.json` now prove:
exactly-one package ∧ INF hash (deterministic ✓) ∧ DLL present ∧
`InstalledManifestSha256 == 2f5c0313…`; the service key is reported,
never required. A THIRD defect surfaced while proving the fix on the live
machine: the Driver Store keeps a `<package>.ini` sidecar FILE beside every
package directory, the prefix filter counted it, and "exactly one package" saw
two — so even correct hashes could never pass. Both probes (Rust and the C#
host) now count directories only.

`[MEASURED 2026-08-20]` After the fix, the rebuilt `ksx doctor` on this
machine: `[OK] installed — production DualSense package is staged` +
`[INFO] service not yet registered — it appears on first controller creation`.
**The first time any ksx build has recognised a legitimate install.**

---

## Protocol facts

### Switch Pro is a 48-byte report-`0x30` body, not `0x3F`

`[SOURCE driver.c:831-851]` The driver's Switch lane reads `Data[2..10]` (nine
bytes: three button bytes + two 12-bit packed sticks) and, only when
`SwitchImuEnabled && DataSize >= 48`, `Data[12..47]`.
`[SOURCE driver.c:1281]` The descriptor-driven builder early-returns for Switch
devices, so no submission of ours is ever emitted as a `0x3F` report.
`[SOURCE HMController.cs:406,535-541]` Upstream's `SubmitState` early-returns
into `SwitchProPacker.BuildBody` for `057E:2009`.

**An 11-byte slice is silently misparsed, not rejected** — the guard is
`DataSize >= 11` and 11 passes. Traced against our own `neutral_explicit`
vector, a centred no-button frame decodes as *A + Minus + Plus + both stick
clicks + Home + Capture + all four D-pad directions + L, sticks past the rail.*

Body layout `[SOURCE SwitchProPacker.cs]`: `[0]` counter, `[1]` battery,
`[2..4]` buttons, `[5..7]` left stick, `[8..10]` right stick, `[11]` vibrator,
`[12..47]` IMU. The driver overlays `[0]`, `[1]`, `[11]` itself — leave them
zero. Sticks are 12-bit packed, **Y inverted**; a neutral stick packs to
`00 08 80`, which is byte-identical to the driver's own neutral prefill and is
therefore a free self-check.

The handshake is entirely the driver's `[SOURCE driver.c SwitchHandle*]`; the
SDK has no handshake duty.

**What a Switch Pro spawn still needs, in order** — the encoder and contracts
are done; three host-side seams are still DualSense-hardcoded:

1. `[SOURCE tools/hidmaestro-host/WindowsDeviceManager.cs:22,26,173]` device
   registration pins `root\VID_054C&PID_0CE6`, the DualSense descriptor bytes
   and DualSense registry identity — must become profile-driven.
2. `[SOURCE tools/hidmaestro-host/SharedMemoryEndpoint.cs:76]` the endpoint
   hard-rejects any submission that is not exactly 63 bytes — must take the
   wire shape's data length (Switch Pro submits 48).
3. `[SOURCE tools/hidmaestro-host/RuntimeHostSession.cs]` the create arm admits
   only DualSense, deliberately, until 1 and 2 are real.

Then the driver package install (the opt-in setup task) and the supervised
hardware lifecycle.

### Xbox Series is companion-only

`[SOURCE DeviceOrchestrator.cs:1489-1497]` `driverMode: xinputhid` sets
`UsesUpperFilter`, and that branch creates **only** the SWD companion — there is
no main HID device and no XUSB companion. `[SOURCE ControllerProfile.cs:223]`
`UsesXinputhid` is literally `DriverMode == "xinputhid"`, and **every** Xbox
profile in the catalog sets it `[MEASURED 2026-08-20]`.

`hmswd.exe` **ships pre-built inside the SDK's embedded payload** — extracted
and hashed 2026-08-20 from the verified release `Core.dll`: 155,648 B, SHA-256
`C94D654A…` (`[MEASURED 2026-08-20]`; it is one of the five resources the
installed-payload manifest covers, and it is NOT in the DriverStore package on
this machine, so upstream's `SwdDeviceFactory` extracts it at device-creation
time). Source is `driver/hmswd/hmswd.c`, needed because direct P/Invoke to
`SwDeviceCreate` returns `0x8007007E` on .NET 10
`[SOURCE SwdDeviceFactory.cs:12-22]`. Nothing to compile.

---

## Why the driver package cannot be bundled

`[SOURCE docs/HIDMAESTRO.md "Reproducible upstream pin"]` HIDMaestro is MIT and
redistributable, but
its release archive embeds WDK tooling, and **Microsoft documents SignTool as
non-redistributable**. So ksx ships a bootstrap containing no SignTool, Inf2Cat,
SDK or WDK payload; the opt-in setup task downloads the pinned archive
(`HIDMaestro-v1.6.1.zip`, `118,879,222` bytes, SHA-256 `00145C23…`), verifies it,
calls `HMContext.InstallDriver()`, and deletes the bytes. That one task needs
internet.

---

## Open questions — and exactly what settles each

Nothing here may be written into a contract as a fact until it is measured.

| Question | What settles it |
|---|---|
| Does a `root\HIDMaestro` devnode actually enumerate and bind? | Elevated: run the ksx HIDMaestro setup task, then `ksx pads --persona dualsense --hold-secs 20`, then `Get-PnpDevice \| ? InstanceId -match 'HIDMAESTRO'`. |
| Does the SWD companion's HID child come out as `HID\VID_045E&PID_0B13&IG_00` (the string inbox `xinputhid` binds)? | Elevated, disposable box: `hmswd.exe create …`, then read `%windir%\INF\setupapi.dev.log` for the selected-driver / Driver Rank lines. |
| Does `SwDeviceCreate` need elevation, or only the registry staging? | Run the same `hmswd.exe create` twice, standard then elevated, and diff the HRESULTs in `%TEMP%\HIDMaestro\hmswd_self.log`. |
| Do Switch Pro button indices follow layout roles or HMButton bit values on a real client? | Create the pad, run SDL `testcontroller`, press minus/plus/home and read reported indices. |

---

## Retracted claims — do not resurrect

| Date | I claimed | Truth | Why I got it wrong |
|---|---|---|---|
| 2026-08-19 | "Xbox needs `hmswd.exe`, which doesn't exist in this repo" | It exists in the pinned upstream at `driver/hmswd/hmswd.c` | Believed the candidate README's roadmap prose; had deleted the pinned upstream from the workspace and reasoned as if absent |
| 2026-08-20 | Switch Pro's `362` vs 12-byte report is "not answerable from source" | Answerable | Lazy; did not read the driver |
| 2026-08-20 | "`362` is upstream's shared input SECTION size" | `362` **is a report length** — `0x31`/`0x32`/`0x33` carry 361 + 1. The section is also 362 because it was sized to the largest catalog report | Inferred identity from a numeric coincidence |
| 2026-08-20 | "The HIDMaestro driver package is not installed" | It **is** staged; the `.dll` hash and service key are what fail | Reported a tool's three-condition summary line instead of decomposing it |
| 2026-08-20 | Switch Pro speaks report `0x3F` | It speaks the 48-byte `0x30` body | Trusted the profile's `notes` about what the *encoder* does; the code takes a different lane |
| 2026-08-20 | Our layout-derived button map is a "divergence" from upstream | `SwitchProPacker` cites the same layout indices | Reasoned from `HidReportBuilder`, a path the Switch lane never reaches |

### Known-wrong text in sources we do not own

- `[SOURCE driver/hidmaestro.inf:~60]` (pinned upstream) lists "Xbox Series BT"
  among *non-companion* profiles. It is stale — that profile is
  `driverMode: xinputhid`, hence companion-only. Do not use that comment.

---

## Architecture decision — 2026-08-20: the hybrid

Victor's call, made with the tradeoff measured and on the table.

**Why the rewrite kept hurting:** the SDK and the driver are a MATCHED PAIR
speaking a private shared-memory dialect, and ksx kept upstream's driver while
rewriting the SDK half. Every persona meant re-deriving their internal protocol
(the `0x3F`-vs-`0x30` reversal was this tax), and upstream's 2,675-line
orchestrator carries years of hardware scars — the sticky-SwDevice-tuple
workaround, the `&`→`_` enumerator PnP edge case, slot-1-skip, per-instance
UpperFilters — that a rewrite must re-earn one hardware session at a time.
PadForge, by contrast, consumes the pre-built `HIDMaestro.Core.dll`
(`[MEASURED 2026-08-20]` its csproj: "pre-built release DLL, NOT a
ProjectReference"), runs `requireAdministrator` for the whole app, and its
entire lifecycle is `CreateController` + `SubmitState`.

**The decision:** DualSense stays on the finished, audited candidate — the
"cannot" property (install/cert/sweep authority physically absent) is already
paid for there. Switch Pro and Xbox Series ride the hash-pinned official
`Core.dll` (`ADADD9E2…`, byte-verified against the release) inside the
elevated host boundary — daemon still unelevated, the authenticated pipe still
the only surface, the host simply never calls the install/certificate APIs.
DsHidMini was considered and is the wrong tool: it drives REAL DualShock 3
hardware; its contribution is the UMDF technique HIDMaestro reuses, and
ViGEmBus (same author) is already the working X360/DS4 lane.

**Design inputs measured from PadForge before writing code:**
- Axes: resolve per-profile through the SDK's layout view (`_profile.Sticks`/
  `Triggers`), never hardcode the DualSense-shaped assignment.
- Buttons: PadForge feeds semantic `HMButton` flags unconditionally, which for
  Switch inherits the raw-mask skew (Back→ZL, stick-click→Minus). Our SDK lane
  converts to layout indices for Switch instead — correct on-wire beats
  bug-compatible. Final adjudication on hardware.
- Keepalive: 16 ms, NOT longer — the GIP companion's stale watchdog counts
  READS and tears down at >500 unchanged-SeqNo reads (PadForge's own audit).
- NativeAOT cannot load managed assemblies, so the SDK lane is a SECOND host
  executable (ordinary .NET, self-contained), same pipe protocol and
  authentication; the candidate host and its S1.5e observation stay
  byte-stable.
- `Core.dll` + its two managed companions reach disk via the existing
  installer bootstrap (which already downloads and pin-verifies exactly those
  three), retained into an ACL-protected install location instead of deleted.

**Implementation state (2026-08-20):**
1. ✅ `tools/hidmaestro-sdk-host/` — host exe, session, per-persona state
   mapper (layout-indexed buttons for Switch), `runtime-contract-sdk.json`
   (canonical sha `3FC74E0A…`), pinned fetch + publish gates.
2. ✅ superseded — the single-file bundle carries the SDK, so the installer
   ships one more sealed sibling instead of staging assemblies; `ksx.iss` and
   the workflow package + PE-validate it.
3. ✅ Rust: `protected_hidmaestro_sdk_host` sealed sibling,
   `connect_production_sdk` with the same ordering/authentication, dual-lane
   backend with lazy per-lane connect and lane-scoped controller matching
   (both hosts number their controller `1`).
4. ✅ CI builds the host on every branch push; the 113 MB archive is cached by
   content hash and verified on every path.
5. ⏳ hardware: one elevated session on Victor's machine — DualSense via the
   candidate host AND Switch Pro via the SDK host — settles both lanes.
   `PadBackend::supports` stays false until then.

---

## Known-stale, not yet fixed

The 2026-08-20 sweep found 54 contradicted claims. All are now fixed:
the mechanical ones (counts, "live", the XUSB mechanism error) first, and the
structural ones with the `0x30` rewrite — the Switch Pro encoder, both of its
contract files, the aggregate requirement and the s1_5d lock's lane pins moved
together in one change, so the gate that briefly enforced the wrong lane now
enforces the right one (612 checks). The s1_5e README's 241/12 literals were
corrected in lockstep with the verifier anchor that pins them, and HANDOFF.md
no longer denies the production adapter that exists.

Nothing known-stale is currently outstanding. New contradictions go here, each
with why it cannot be fixed immediately.

---

## Commit log — this branch's HIDMaestro work

| Date | Commit | What |
|---|---|---|
| 2026-08-19 | `6ca18cc` | A HIDMaestro pad remembers which persona it is |
| 2026-08-20 | `446a62a` | Generalize the candidate from one persona to three |
| 2026-08-20 | `8d967d9` | Teach the CI gates the candidate holds three personas |
| 2026-08-20 | `cab2519` | Aggregate-contract assertions → three-persona counts |
| 2026-08-20 | `2ee907f` | Stop the per-encoder loop clobbering DualSense report counts |
| 2026-08-20 | `11b03cc` | Actions proof accepts fourteen compile items |
| 2026-08-20 | `52c91a1` | S1.5e candidate facts the artifact inspector reads |
| 2026-08-20 | `ce54e01` | Host stops offering personas it cannot register (⚠ also introduced the wrong `362` note, retracted above) |
| 2026-08-20 | `1176c76` | Close an assurance hole; stop claiming layout is the button source |
| 2026-08-20 | `3968ff8` | Living state doc; first 362 retraction |
| 2026-08-20 | `1e0e63b` | Plan doc points at the state doc |
| 2026-08-20 | `06cc5cb` | Sweep corrections; XUSB→inbox-xinputhid; "live"→staged |
| 2026-08-20 | `02a27c0` | Switch Pro rewritten to the 48-byte `0x30` body; second 362 retraction executed; trigger axis-read verifier gap closed; s1_5e README 244/15 |
| 2026-08-20 | `ebbadfa` | The three host seams named with sources |
| 2026-08-20 | `a44ac95`+`c3fd174` | Install proof redesigned: the impossible DLL-byte pin and the service-key deadlock replaced by INF hash + the SDK's own payload manifest (byte-verified against the downloaded release); runtime-contract re-pinned in its four places |
| 2026-08-20 | `b23e557` | The hybrid decision recorded with PadForge's measured design inputs |
| 2026-08-20 | `4762ee1` | The SDK-lane host: session, per-persona mapper, pinned fetch + publish, CI build |
| 2026-08-20 | `5f00e9e` | Rust lane routing: sealed SDK sibling, connect_production_sdk, dual-lane backend |
| 2026-08-20 | `94089ac` | SDK-lane host packaged: iss Source, required-binary + PE gates |

Contract topology as of the last entry: candidate tree **15 files**, compile
items **14**, S1.5d **612 checks**, S1.5e staged inputs **244**.
