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
| DualSense | yes, frozen conformance | plain HID via the SDK lane (consolidation) | **YES — SPAWNED 2026-08-20**, two at once: `pads --count 2` exit 0, ctrl 0+1, creates 705/1444 ms, teardowns ~260 ms |
| Xbox Series X\|S | yes, descriptor-derived | **companion-only SWD via the SDK lane** (the SDK performs its own companion flow; XUSB INF staged as oem207) | **YES — MEASURED WORKING 2026-08-20**, four at once: XInput slots 0→4 claimed, creates ~150 ms, teardowns ~160 ms, exit 0 — gate stays |
| Switch Pro | yes — 48-byte `0x30` body, semantic buttons | plain HID (SDK lane) | **YES — SPAWNED 2026-08-20.** Real devnode + HID child in 751 ms; clean ~12 s teardown. See the session results below. |
| Xbox 360 / PlayStation | n/a — ViGEmBus | ViGEmBus | **yes, working** `[MEASURED 2026-08-20]` |

`PadBackend::supports` in `crates/ksx-core/src/persona.rs`: every persona is
`true` as of the 2026-08-20 session — Switch Pro measured working; Xbox Series
flipped for measurement through the SDK lane (the decision rule stands: a lane
that fails to produce a working device reverts its flip).

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
- `HKLM\SYSTEM\CurrentControlSet\Services\HIDMaestro` does **not** exist —
  and `[MEASURED 2026-08-20]` it STAYED absent while a HIDMaestro pad was
  live and bound (no `Services\*maestro*` key at any point; UMDF loads
  under the reflector without registering an own-name service). The earlier
  "materialises on first devnode" expectation is retracted below; the key
  is useless as a spawned-before marker.
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
machine: `[OK] installed — production DualSense package is staged`.
**The first time any ksx build has recognised a legitimate install.**
(The `[INFO]` service-key line the doctor printed that day promised the key
"appears on first controller creation" — measured false on 2026-08-20, text
corrected to name absence as the normal state.)

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

## Hardware session runbook — 2026-08-20

Written down BEFORE the session so it survives a terminal crash: Windows
Terminal on this machine is 1.24.11911.0, the version that fail-fasts on
gamepad INPUT (`[MEASURED]`; device arrival has historically been safe —
ViGEm pads have existed here without killing it), and the assistant session is
hosted inside it.

**Phase A — input-silent (safe under WT 1.24):**
1. Build `a0b9a60` (Switch Pro gate enabled for this session; Xbox stays
   gated). Download CI artifact `ksx-windows-installer` from the green run.
2. Victor runs `setup.exe` (elevated; the HIDMaestro driver task may stay
   unchecked — the package is already staged and manifest-exact).
3. `& "C:\Program Files\ksx\ksx.exe" doctor` → expect
   `[OK] installed — production DualSense package is staged`.
4. Start a PnP poller (tight loop capturing `Get-PnpDevice` arrivals matching
   HIDMAESTRO/057E/054C to a file), THEN
   `pads --count 1 --persona dualsense --json` (plug → report → unplug; no
   test pattern, no input). UAC: accept `ksx-hidmaestro-host.exe`.
5. Same with `--persona switchpro`. UAC: accept `ksx-hidmaestro-sdk-host.exe`.
6. Durable evidence regardless of the short window: the poller capture,
   `%windir%\INF\setupapi.dev.log` (selected driver + rank per devnode), the
   `HKLM\SYSTEM\CurrentControlSet\Services\HIDMaestro` key materialising on
   the first-ever devnode, and each command's JSON receipt.

**Phase B — input semantics (ONLY after Windows Terminal ≥ 1.26):**
Victor updates Windows Terminal (an app update, not a Windows feature update —
the Interception freeze concerns OS feature updates only), then, in any
terminal: `pads --count 1 --persona switchpro --hold-secs 60` (the animated
test pattern), watching joy.cpl: faces positional, Back lights Minus, Start
lights Plus, stick clicks are clicks, Guide lights Home, triggers light ZL/ZR.
That adjudicates the layout-indexed button divergence recorded in the Switch
contract. Then the same for DualSense.

**Decision rule:** a lane whose device appears and reads correctly keeps its
gate; a lane that fails reverts its flip and the failure is recorded here with
the exact error.

---

## Hardware session results — 2026-08-20 (Phase A, build `3cceb6a` installed)

All `[MEASURED 2026-08-20]`, live on Victor's machine, elevated hosts launched
by the installed `ksx.exe` (elevation auto-granted; no UAC prompt appeared on
any launch).

**Switch Pro — SPAWNED. The first HIDMaestro controller ksx has ever created.**
`pads --count 1 --persona switchpro --json` → SDK-lane host launched 141 ms
after the command, hello + both contract pins passed, and the SDK's own diag
(`HIDMAESTRO_DIAG=1`, planted in the USER environment — a process env var does
NOT cross the elevation boundary) recorded:

```
SETUP  ENTER ctrl=0 profile=switch-pro vid=0x057E pid=0x2009
    driver install check (deployed=False) in 0ms
    CreateDeviceNode -> ROOT\HIDClass\0002 in 700ms
    WaitForHidChild(ROOT\HIDClass\0002) -> True in 0ms
SETUP  EXIT  total=751ms
TEARDOWN ENTER ctrl=0 instanceId=ROOT\HIDClass\0002
    pre-captured HID children: 1  (HID\HIDCLASS\1&1731F3EA&0&0000)
    parent RemoveDevice(ROOT\HIDClass\0002) returned True after 11978ms
TEARDOWN EXIT  total=11985ms
```

A real devnode bound the staged package and enumerated a real HID child in
751 ms; teardown completed cleanly, machine left clean. The CLI still exited 1:
`DESTROY_TIMEOUT` was 5 s against a measured ~12 s `DIF_REMOVE` cascade
(upstream budgets 120 s for the same wait), so the client abandoned a healthy
teardown. Fixed the same day: `DESTROY_TIMEOUT`/`SHUTDOWN_TIMEOUT` → 30 s.

**DualSense — did NOT spawn; root-caused to a missing call, fix in flight.**
Three attempts, each a deterministic 15.2 s transport timeout = the client's
`CREATE_TIMEOUT` racing the host's own 15 s child-wait to a photo finish.
Decomposed with a process watcher + `setupapi.dev.log`: the candidate host
launches instantly, hello succeeds (the error is only reachable POST-handshake),
`RegisterRootDevice` creates the root devnode — and then **nothing installs a
driver on it**. `DIF_REGISTERDEVICE` only creates the node; upstream v1.6.1
follows it with `UpdateDriverForPlugAndPlayDevicesW(hwId, infPath)`
(`DeviceNodeCreator.cs`, whose own comment warns a failure there means
"downstream waits will time out"), and the candidate port dropped that call.
Zero PnP sections appeared in `setupapi.dev.log` across all three attempts —
Windows was never asked to bind. Fixed the same day in
`WindowsDeviceManager.cs` (bind the pinned Driver Store INF after registration,
fail-closed re-hash of the package; host child-wait 15 s → 12 s so the host
answers a definite Fault INSIDE the client's deadline).

**DualSense rerun on the fixed build (`fae5ece` installed) found defect #2.**
The bind now WORKS — `setupapi.dev.log` records the INF matching (via the
second hardware id `root\hidmaestro`), mshidumdf + WUDFRd configured, and
`ROOT\HIDCLASS\0003` STARTED — and the diff poller caught its healthy child
`HID\HIDCLASS\1&29EBA48F&0&0000 [OK]`. The host then refused its own working
pad: `ProveExactParentBound`/`ReadExactChildInstanceIds` required child
INSTANCE ids to start `HID\VID_054C&PID_0CE6`, but a live-pad registry catch
proved the child's instance path spells `HID\HIDCLASS\…` while the identity
lives in its `HardwareID` multi-sz:

```
HID\HIDCLASS\1&10A8B2D&0&0000
  HW = HID\VID_057E&PID_2009 ; HID\HIDMaestro ; HID\VID_057E&UP:0001_U:0005 ;
       HID_DEVICE_SYSTEM_GAME ; HID_DEVICE_UP:0001_U:0005 ; HID_DEVICE
```

Both checks now match the child's `HardwareID` list (prefix
`HID\VID_054C&PID_0CE6`, fail-closed on a missing key). Observed side effect
of the refused-pad fault path: the lifecycle's teardown removed only the
captured parent, orphaning the healthy child devnode for ~2 minutes until the
next run's teardown swept it — acceptable (the prove step no longer faults on
legitimate children, and deleting unowned children would be worse), recorded
so the orphan is recognised if ever seen again.

**Switch Pro re-verified on the fixed build: `exit=0`, end to end clean**
(create ≈ 1.4 s, teardown ≈ 12 s inside the new 30 s budget).

**Instrument lessons (the session's own tooling was wrong twice):**
- The PnP poller filtered instance ids on `HIDMAESTRO|057E|2009|054C|0CE6` and
  MISSED the real device entirely — the SDK names its devnodes
  `ROOT\HIDClass\NNNN` / `HID\HIDCLASS\…`. Poll for `ROOT\HIDCLASS` too, or
  filter on nothing and diff.
- `Get-Process` sightings truncated by `Select-Object -First` hid the host's
  later lifetime; the diag file, not process sampling, settled the timeline.

---

## The multi-controller consolidation — 2026-08-20 (Victor's call)

After the session measured the SDK lane working first-try on both its personas
(Xbox Series: 205 ms create, XInput slot 0→1, 152 ms teardown, exit 0 — gate
stays) while the candidate lane needed three live root-causes, Victor ordered
the consolidation: every HIDMaestro persona rides the SDK-lane host, which
carries up to EIGHT live controllers at once (the SDK allocates controller
indices with no bound of its own — its `CreateController` comment says so;
XInput seats four, so Xbox-family pads cap there). What changed:

- `SdkHostSession` went multi-controller: ids 1..8, per-controller lease and
  sequence, the 16 ms republish iterates every live pad, and DualSense is
  served through the same generic per-profile mapper (semantic buttons — the
  SDK maps them through the profile's own `buttonMap`, the PadForge-proven
  path).
- `runtime-contract-sdk.json`: `controllerLimit` 1 → 8, `xinputSeatLimit: 4`,
  DualSense added to `supportedProfiles` (`dualsense`, USB 054C:0CE6),
  `unsupportedProfiles` emptied. Canonical sha re-pinned in its four places
  (`B744C0F3…`).
- `ksx-output` became single-lane: the candidate lane's client wiring is
  deleted (git history keeps it; the audited candidate host still ships as
  the conformance reference). **Capacity is enforced in the Rust adapter,
  BEFORE the host is asked** — any host Fault poisons the whole one-use
  session by design (fail-closed), so a 9th create must be refused locally,
  never allowed to tear down eight live pads. The host's own Capacity faults
  stay as defense-in-depth.
- `Persona::instance_limit`: DualSense's `Some(1)` is gone (the "· one per
  session" studio label with it); ~8 one-DualSense pins across
  core/api/config/backend/studio became multi-pad acceptance pins.
- The candidate's `RecoverOwnedResidue` carried the instance-vs-hardware-id
  bug in a FOURTH home (recovery required the retained parent's INSTANCE id
  to start `root\\VID_…`; the measured instance is `ROOT\\HIDCLASS\\NNNN`) —
  fixed by hardware-id proof, and the deadlocking residue it refused
  (`ROOT\\HIDCLASS\\0005` + `Controller0`) was swept manually.

Measurement pending on the next installed build: multi-DualSense
(`pads --count 2 --persona dualsense`), multi-Switch, and the mixed roster.

Next after that (Victor 2026-08-20): retro personas through the same lane —
N64 (`n64-nso`), SNES (`snes-nso`), Genesis (`genesis-nso`) — chosen from the
227-profile catalog sweep for emulator auto-config payoff; the host projects
the modern pad state onto each retro layout (C-buttons = right stick, Z = LT),
so ksx's binding vocabulary is unchanged.

---

## Retro personas — measured scope call, 2026-08-20

Victor asked for every low-hanging mainstream-console pad. Measured against the
pinned catalog and SDK source — the answer reversed the earlier assumption:

`[MEASURED]` Every retro profile in the catalog (`snes-nso` 057E:2017,
`n64-nso` 057E:2019, `genesis-nso` 057E:201E, `daemonbite-genesis` 2341:8036,
minis, adapters) is a BARE DESCRIPTOR: `layout.kind: "unspecified"`, no
`buttonMap`, no `axisMap`, no sticks/triggers metadata.
`[SOURCE SwitchProPacker.cs:30]` The Switch protocol lane keys STRICTLY on
`vid == 0x057E && pid == 0x2009` — NSO pads do not ride it.
`[SOURCE HidReportBuilder.cs:955]` With no ButtonMap the descriptor lane falls
back to IDENTITY — semantic bit `b` writes descriptor button `b`, so ksx's A
would land on Nintendo's B on every Switch-family descriptor. Nothing retro
spawns CORRECTLY for free.

**Verdict table:**

| Tier | Personas | Why |
|---|---|---|
| Real today (shipped, measured) | DualSense, Switch Pro, Xbox Series — multi-pad | the mainstream modern three; Switch Pro is already a first-class emulator identity |
| Next increment (each ≈ hours + one shared hardware leg) | **N64, SNES, Genesis** via the NSO profiles | descriptor lane is self-describing: derive each pad's button/axis bit table from its own pinned descriptor, drive it with a per-profile mask (the `SwitchLayoutMask` pattern), golden-vector it, verify once on hardware. N64 first (C-buttons ← right stick is the emulator convention) |
| Defer behind its own measurement | GameCube (`gamecube-adapter`) — Dolphin prefers the vendor protocol over HID; Saturn via `daemonbite-genesis` (4-byte report, trivial descriptor, weaker auto-config identity) | |
| Don't do | Dreamcast (zero profiles; DC emulators take any pad — the modern personas serve them fully), Wii/Wiimote (absent; motion is a different product), NES as its own persona (SNES/generic covers it — roster noise), Joy-Cons/mini-console pads/8BitDo identities (niche), custom catalog profiles (breaks the 228-resource pin) | |

**The increment that followed the scope call (same day):** the NSO trio
pivoted identities after two more source measurements — the NSO catalog
profiles are synthesized Joy-Con-family placeholders whose SDL-HIDAPI
handshake the driver only answers for PID 2009 (a virtual NSO pad would look
dead in SDL apps), and the Mega Drive Mini profile's Usage(0) hat is
invisible to the report builder (dead D-pad). The identities that ARE clean:

- **`Persona::Snes`** → `ibuffalo-snes` (0583:2060) — the canonical emulator
  SNES pad, 3-byte report (X/Y + 8 buttons), positional faces (ksx A =
  bottom = SNES B).
- **`Persona::Genesis`** → `daemonbite-genesis` (2341:8036) — 9 buttons +
  signed X/Y from the adapter firmware's own descriptor; the same wire
  identity serves Saturn per its notes (aliases: megadrive/md/sega/saturn).

Both are WIRED end to end (Persona + ProfileId 4/5 both sides, SDK-host
create arms, descriptor-ordered masks in the mapper, contract
`supportedProfiles` grown, sha re-pinned `EDE64B5F…`) and GATED
(`supports() => false`) until their supervised hardware leg observes real
devices — the same rule as every persona before them. The bare-descriptor
reality (no `buttonMap` — the iBuffalo profile does carry a layout block,
which corroborates its table but is not the routing mechanism) means the
builder's identity fallback is exactly what the
descriptor-ordered masks target; the bit→physical-label tables are marked
PROVISIONAL in the mapper and adjudicated in joy.cpl during the leg. N64
stays deferred: no clean identity exists in the catalog (its NSO profile has
the placeholder+HIDAPI problem), so N64 emulation rides Switch Pro/X360
personas until upstream lands a direct capture.

**Retraction:** the consolidation notes said retro personas would be cheap
because "the host projects the modern pad state onto each retro layout, so
ksx's binding vocabulary is unchanged." The ksx-side half was right; the
host-side half assumed layout metadata the profiles turned out not to carry.
The projection tables must be derived per pad from the descriptors — real
work, done with the contracts machinery, gated by the same
observed-device-before-offered rule as everything else.

---

## Open questions — and exactly what settles each

Nothing here may be written into a contract as a fact until it is measured.

| Question | What settles it |
|---|---|
| ~~Does a `root\HIDMaestro` devnode actually enumerate and bind?~~ **ANSWERED 2026-08-20**: yes — the SDK lane bound `ROOT\HIDClass\0002` and enumerated `HID\HIDCLASS\…` in 751 ms (session results above). The DualSense-lane rerun after the `UpdateDriver` fix is what remains. | — |
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
| 2026-08-20 | "The `Services\\HIDMaestro` key materialises when the first devnode binds" (doctor/advice text, poller design, runbook step 6) | A pad was live and bound with NO maestro-named service key ever appearing | Stated a plausible UMDF mechanism as fact without ever having seen a bind |

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

**The decision** *(superseded same day by the consolidation below — DualSense
rides the SDK lane too)*: DualSense stays on the finished, audited candidate — the
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
   (canonical sha `EDE64B5F…` since the retro-persona increment; `B744C0F3…`
   was the multi-controller revision, `3FC74E0A…` the single-controller one),
   pinned fetch + publish gates.
2. ✅ superseded — the single-file bundle carries the SDK, so the installer
   ships one more sealed sibling instead of staging assemblies; `ksx.iss` and
   the workflow package + PE-validate it.
3. ✅ superseded by the consolidation — the backend is single-lane now
   (`connect_production_sdk` only, controller ids 1..8); the dual-lane
   wiring this item described lives in git history.
4. ✅ CI builds the host on every branch push; the 113 MB archive is cached by
   content hash and verified on every path.
5. ✅ DONE — the 2026-08-20 session measured all three personas working
   (multi-pad: 2×DualSense, 4×Xbox Series; Switch Pro exit 0 single, the
   ×2 run exposed the lease-starvation race, fixed same day).
   `PadBackend::supports` is true for every persona.

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
| 2026-08-20 | `3cceb6a` | Switch Pro gate flipped for the hardware session; roster/test churn |
| 2026-08-20 | `fae5ece` | Hardware session Phase A: Switch Pro SPAWNED (751 ms create, 12 s teardown); DualSense root-caused → `UpdateDriverForPlugAndPlayDevicesW` bind added, host child-wait 15→12 s; `DESTROY_TIMEOUT`/`SHUTDOWN_TIMEOUT` 5/10→30 s; service-key claim retracted in doctor/advice text |
| 2026-08-20 | `48c6089` | DualSense defect #2 from the fixed-build rerun: exactness checks matched child INSTANCE paths (`HID\HIDCLASS\…` measured) instead of `HardwareID` entries → both checks now read the registry multi-sz; Switch Pro re-verified exit 0 |
| 2026-08-20 | `46ea36b` | Xbox Series gate flipped for the SDK-lane measurement (~12 test reworks: with every persona pluggable, refusal pins became acceptance/dormancy pins); host faults now carry the real exception; child-identity wait tolerates the Enum-mirror race |
| 2026-08-20 | `aec3c4a`+`d711b0a` | **Xbox Series MEASURED WORKING** (205 ms create, XInput slot 0→1, 152 ms teardown, exit 0) — gate stays; multi-controller consolidation: SDK host carries 8, DualSense joins the SDK lane, candidate lane wiring retired, contract re-pinned `B744C0F3…`; recovery-path identity bug (4th home) fixed |
| 2026-08-20 | (this) | Multi-pad measured: 2×DualSense + 4×Xbox exit 0; Switch ×2 exposed the lease-starvation race → host re-stamps every lease on any inbound frame AND on its own expiry-teardown time; lease expiry now destroys only its own pad (per-controller contract); CREATE_TIMEOUT 15→30 s (create #2 measured 7.7 s); 34-agent adversarial review → 10 confirmed findings fixed: static `MAX_HIDMAESTRO_PADS = 8` pool ceiling at validate/stage/write/plan/roster layers (a clean-validating 9-pad config no longer dies at plug #9), surrogate-safe fault truncation (both hosts), ~14 refusal-named tests renamed honestly or made real again against the pool, six stale doc-comment sites + this doc's own stale sections corrected |
| 2026-08-20 | (this) | Retro-persona scope measured: catalog profiles are bare descriptors, Switch packer keys strictly on PID 2009, no-ButtonMap fallback is identity → NSO trio (N64/SNES/Genesis) deferred to a descriptor-table increment; Dreamcast/Wii/NES ruled out; 'cheap per persona' claim retracted |
| 2026-08-20 | (this) | SNES (iBuffalo 0583:2060) + Genesis/Saturn (DaemonBite 2341:8036) personas wired end to end, GATED pending their hardware leg; NSO identities rejected (SDL-HIDAPI handshake dead + placeholder descriptors), MD Mini rejected (Usage(0) hat invisible to the builder); contract sha → `EDE64B5F…`; nearest_pluggable refusal-loop bug caught by the invariant test and fixed |
| 2026-08-20 | (this) | 29-agent retro review → 21 confirmed, all fixed: Genesis stick alias was digitally dead over the −1..1 range (builder truncation — review-executed math) → thresholded; the profile set turned out pinned in EIGHT C# places (identity map, TryProfile, IsProfile, invalid-vector, protocol table, self-test list, PersonaContract+ci count, fake tests) — three found by CI, five by the review; gate coverage re-armed at every layer (router/api/slots/plan/games/set_persona/error-display/studio exact-pair); protocol description's stale pre-session deadlines corrected to the measured 30 s; Sega compound aliases; slug cross-check drift guard |
| 2026-08-20 | (this) | RETRO LEG FLIP (Victor supervising): `supports()` true for Snes+Genesis — the gate churn cycles back to all-plug dormancy (~15 pins), studio roster grows to 7; spawn measurement follows this build. N64 stays deferred: no clean catalog identity exists (NSO placeholder + HIDAPI handshake), and N64 GAMES are already served — every N64 core auto-maps the standard pads we ship |
| 2026-08-20 | `ef8bc31` verified live | **SNES + GENESIS SPAWNED** (first ever): ibuffalo-snes devnode+child in 839 ms / daemonbite-genesis in 713 ms, teardowns ~270 ms, both exit 0 — gates stay; SEVEN personas live. Button-label tables remain PROVISIONAL until the joy.cpl press-check. ⚠️ install note: the setup's HIDMaestro driver task hung indefinitely this run (package already staged; task killed, install completed clean) — investigate the task's idempotence before the next release |
| 2026-08-20 | `1f109dd` verified live | The lease-fix build measured: Switch Pro x2 exit 0 (34 s wall - slow second create + two 12 s teardowns, all inside budgets, no lease kill), DualSense x2 exit 0 (4.7 s), Xbox Series x4 exit 0 (4.5 s), zero residue. Every persona multi-pad PROVEN on the shipped build |

Contract topology as of the last entry: candidate tree **15 files**, compile
items **14**, S1.5d **612 checks**, S1.5e staged inputs **244**.
