# HIDMaestro M8 execution plan

Status: **read-only catalog spike complete; live use blocked on hardening; no
HIDMaestro persona is enabled**.

HIDMaestro is KSX's chosen rich-profile Windows output backend. ViGEmBus
remains the shipped Xbox 360 / DS4 compatibility lane, and VIIPER remains the
later virtual-USB/network/Linux lane. This document is the execution contract
for turning the HIDMaestro decision into a measured implementation.

## What the upstream clarification changed

HIDMaestro's author supplied the exact object names and directed KSX to the two
MIT-licensed authoritative sources:

- [`driver/driver.h`](https://github.com/hifihedgehog/HIDMaestro/blob/v1.6.1/driver/driver.h)
  defines the packed driver structures and bounds.
- [`SharedMemoryIO.cs`](https://github.com/hifihedgehog/HIDMaestro/blob/v1.6.1/sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs)
  defines the writer-side object creation, security and seqlock behavior.

That closes the former *unknown facts* blocker. It also proves that the current
KSX 80-byte experimental latch is not a nearly-finished production client. The
v1.6.1 SDK uses a 362-byte input section, a 64-entry output ring, PID state,
multiple named events, registry configuration and SDK-owned device creation.
Current source also has a companion-input event for the XUSB path. The existing
Rust transport remains disabled; adding constants to it would not make it safe
or compatible.

The supported `HMContext` / `HMController` API is therefore the first
integration boundary. A native Rust transport is a later optimization decision,
not the starting assumption.

## Reproducible upstream pin

The spike uses the official [HIDMaestro v1.6.1 release](https://github.com/hifihedgehog/HIDMaestro/releases/tag/v1.6.1):

| Item | Pinned value |
|---|---|
| Git tag commit | `2a0dac0857901a63d365a36dcf99cf50114ca954` |
| Release asset | `HIDMaestro-v1.6.1.zip` |
| Release ZIP SHA-256 | `00145c23d9838be6089389ce58b3fd2b6766fa9bc0f1f3c60a3c885361b53c34` |
| `HIDMaestro.Core.dll` SHA-256 | `adadd9e2604b7b6b047f386ebdd03879feef48009c6290281e4c665e2190f6d5` |
| Managed target | .NET 10, Windows x64 |

The repository does not carry the release binary. The probe accepts an external
path, checks the exact digest, and keeps downloaded/build output outside version
control. Pinning is evidence for this spike, not a declaration that HIDMaestro's
internal shared-memory layout is a stable third-party ABI.

### Live-use blocker in the pinned SDK

The v1.6.1 release is suitable for the **read-only catalog probe only**. It is
not approved for KSX distribution or elevated execution as-is:

- `HIDMaestro.Core.dll` embeds `signtool.exe`, `Inf2Cat.exe` and dependencies.
  [Microsoft's Windows driver documentation](https://learn.microsoft.com/windows-hardware/drivers/install/installing-a-catalog-file-by-using-signtool)
  states that SignTool is not redistributable, so the release asset's MIT
  license does not by itself grant KSX the right to redistribute that Microsoft
  toolchain.
- `DriverBuilder.EnsureExtracted()` reuses a predictable `%TEMP%` directory
  after checking the expected files by name and length, then launches signing
  tools from it during the elevated install path.
- `SwdDeviceFactory.EnsureHelperExtracted()` similarly reuses
  `%TEMP%\HIDMaestro\hmswd.exe` when its length matches before device
  creation/removal.
- The install path creates a long-lived self-signed machine trust certificate
  with a persisted exportable private key. The audited release does not provide
  a matching ownership ledger and uninstall cleanup contract suitable for KSX.
- Controller indices, registry names and cleanup are machine-global. A normal
  runtime must not sweep devices belonging to another HIDMaestro consumer, and
  the current shared objects have no negotiated layout version or KSX ownership
  token.
- The audited `SubmitRawReport` bounds and its destination buffer disagree for
  reports above 64 bytes. KSX will stay on the typed `SubmitState` path until
  upstream resolves that mismatch and a test pins the result.

That reusable, user-writable staging boundary must be treated as a potential
local elevation path until upstream confirms an unobserved protection or a
hardened build is available. KSX will disclose the exact finding privately,
not publish exploit detail in a casual commit reply. The likely product fix is
a fork/build mode that removes customer-side WDK tools, installs prebuilt
properly licensed/signed packages through KSX's narrow elevated installer, and
runs any required helper only from an ACL-protected installed location with
strong identity verification. Runtime and provisioning must also be separated:
the Play-time host never receives an install, global-sweep, driver-path or
certificate-management operation over IPC.

## Privilege boundary

`InstallDriver()` and `CreateController()` require administrator rights. That
does not mean all of KSX should run elevated. Today the daemon reads
user-writable game configuration, launches configured programs and exposes local
control surfaces under a same-user trust model. Elevating that whole process
would turn those ordinary operations into privileged ones.

The intended production shape is:

```text
ordinary KSX daemon  ->  narrow authenticated IPC  ->  HIDMaestro host
       UI/config             fixed operations             elevated
       game launch           bounded state only            SDK owner
```

The host may ultimately be an installed service or a long-lived per-user
elevated process. The spike must first establish whether the supported SDK is
intended to run in Session 0. Until then, neither topology is claimed as final.

The IPC boundary, when built, must reject arbitrary executable paths, driver
paths, descriptors, profile files and commands. It accepts only versioned
operations, allowlisted catalog profile IDs, bounded controller state and exact
controller handles created by that host. Cleanup is ownership-scoped; KSX must
not call HIDMaestro's system-wide `RemoveAllVirtualControllers()` during a
normal session because another consumer may own controllers too.

The host must implement `VirtualPadBackend` through a dedicated client; it must
not be squeezed behind the experimental `HmDriverApi`. That trait returns a
process-local test latch, and the current output adapter encodes KSX's
non-compatible 80-byte frame into it. The real host owns `HMContext`,
`HMController` and all SDK objects. It also caches the last full `PadState` and
owns any required idle keepalive pump: KSX's engine emits state changes, so a
cadence check called only from `VirtualPadBackend::update()` cannot fire while
the input is held and unchanged.

Two routing changes prepare S4 without enabling a driver:

- **Done:** capability is gated per persona. A future DualSense proof can no
  longer expose Switch Pro and Xbox Series by flipping one backend-wide bit.
- ViGEm and HIDMaestro must both be factory-backed and lazy. Today ordinary
  startup connects ViGEm before the router is used, so a future
  HIDMaestro-only configuration would still fail when ViGEm is absent.

## Current sprint

| Slice | Deliverable | Definition of done |
|---|---|---|
| S0 — truth reset | Correct credits, source facts and routing decision | **Done.** Existing transport says it is incompatible; personas remain gated; ViGEm behavior is unchanged |
| S1 — SDK catalog probe | Pinned, source-only .NET probe using `HIDMaestro.Core.dll` | **Done.** Default run is read-only, emits one machine-readable result, loads the embedded catalog and proves the exact DualSense, Switch Pro and Xbox Series candidates without installing or creating anything |
| S1.25 — exact capability gate | Replace the backend-wide product switch with one gate per rich persona | **Done.** Existing behavior is unchanged; all three still refuse, but proving one can no longer enable the other two |
| S1.5 — distribution and elevation hardening | Resolve the embedded WDK-tool license and reusable `%TEMP%` helper boundary | Private upstream disclosure completed; no non-redistributable Microsoft tool ships; helper/package identity and ACLs fail closed; a clean-runner security test proves an unprivileged pre-seed cannot influence elevated execution |
| S2 — one-controller conformance | Supervised plain DualSense run through the hardened supported SDK boundary | Explicit consent and UAC; one controller only; deterministic neutral/button/axis sequence is visible in Windows; bounded feedback metadata is captured; dispose removes the device; force-close recovery is separately measured |
| S3 — privilege architecture | Per-user host and Session 0 service comparison | Author confirms supported topology or a disposable-machine experiment answers it; threat model is written; standard-user client can use only fixed operations; host owns the full-state keepalive and exact controllers; crash/restart cleanup is ownership-safe |
| S4 — gated KSX adapter | Production `VirtualPadBackend` implementation behind a default-off gate | `PadState` translation, lifecycle and feedback have contract tests; no accidental persona substitution; missing/mismatched SDK refuses safely; ViGEm tests remain unchanged |
| S5 — packaging and QA | Reproducible installer/repair/uninstall plus API matrix | Clean Windows 10/11 x64 install; signed/pinned payload and notices; DirectInput, XInput where applicable, SDL, Steam, WGI/GameInput and browser checks; 4 ViGEm + 1 HIDMaestro coexistence; no unexpected devices/certificates/files after uninstall |
| S6 — native Rust decision | Evidence-based SDK-host versus native-client decision | Only pursue a native client if it has a demonstrated product benefit and upstream confirms an ABI/pinning policy; require SDK golden-vector parity and the same hardware matrix |

S1 is code-complete only when it can be reproduced without administrator
rights. S2 is blocked by S1.5 and is intentionally not automated on a developer
workstation: it changes trust, driver and device state and needs an explicit
supervised hardware gate.

### S1 measured result

`tools/hidmaestro-probe` was built with a temporary, non-system .NET 10 SDK and
run against the hash-pinned release DLL. It reported:

- 228 embedded catalog resources, of which 130 are deployable;
- catalog SHA-256
  `8f407e6e1c3c241e16cf6bef387216ad4d1f5de055a2c4cc041ca16ce7954a6a`;
- all 22 public read-API shape checks present; and
- exact contract matches for `dualsense`, `switch-pro` and
  `xbox-series-xs-bt`.

Its pure parser/contract tests also passed. The executable contains no path that
constructs `HMContext` or calls install, create-controller, USB/IP-install or
global cleanup APIs; a source scanner enforces that boundary before every
build. This result proves catalog/API compatibility only.

## Questions for HIDMaestro upstream

The first reply should thank the author, state that the incompatible latch will
remain disabled, and ask only the two architecture questions the source does not
answer:

1. Are the named mappings/events/registry structures a supported and versioned
   downstream ABI, or should external products host `HIDMaestro.Core` and treat
   those details as internal? If native clients are supported, what release or
   compatibility pinning rule is expected?
2. Is `HMContext` / `HMController` intended and tested to run in a long-lived
   Windows service in Session 0, with an unelevated UI using its own narrow
   authenticated IPC channel?

The public reply should also ask for a private security contact. KSX found a
potential elevated helper-staging issue and a SignTool redistribution concern,
but should send the exact paths and reproduction privately before discussing
them in a public issue or commit thread.

Compatibility, teardown, latency, multi-controller and XInput-slot questions
come after the probe produces reproducible logs. That gives upstream a concrete
failure or measurement to review instead of another hypothetical design.

## Go/no-go rule

Do not flip `PadBackend::is_implemented()` and do not offer DualSense, Switch
Pro or Xbox Series in customer configuration until S4 and S5 pass. A successful
catalog read proves the dependency can be hosted; it does not prove that a
controller can be created, driven, observed, recovered or safely packaged.
