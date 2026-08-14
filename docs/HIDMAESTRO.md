# HIDMaestro M8 execution plan

Status: **read-only catalog and host-contract spikes complete; live use blocked
on hardening; no HIDMaestro persona is enabled**.

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
- The release contains an elevated helper-staging boundary that is under
  coordinated security review. KSX will not execute or redistribute that path;
  implementation details belong in a private upstream report until disclosure
  is coordinated.
- The default developer-signing path does not meet KSX's production signing,
  trust-ownership, or uninstall-cleanup requirements.
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
elevated process. Source inspection makes a **LocalSystem** Session 0 host
technically plausible: controller objects use the `Global\` namespace, their
shared-object SDDL grants SYSTEM, Administrators and LocalService access,
device creation is callback/event driven, and no interactive desktop or
message loop is required. That SDDL is not evidence that LocalService can own
the lifecycle; upstream source identifies authority failures for that account.
The service experiment is LocalSystem-only, and the topology is not upstream
documented or tested, so a disposable-machine matrix must still prove it before
KSX chooses that design.

KSX's current installer and executables are unsigned. A per-Play elevated host
would therefore show an `Unknown publisher` UAC prompt every session. That
prototype is acceptable on a disposable QA image, but production must either
code-sign the host or pay the additional engineering cost of a securely
installed on-demand service; a highest-privilege scheduled task is not an
acceptable prompt bypass.

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
the input is held and unchanged. The ordinary client still renews a slower
lease with an unchanged full-state submission every second. If no valid state
arrives for five seconds, the host neutralizes and destroys that controller
even when a wedged client keeps the pipe open.

Two routing changes prepare S4 without enabling a driver:

- **Done:** capability is gated per persona. A future DualSense proof can no
  longer expose Switch Pro and Xbox Series by flipping one backend-wide bit.
- **Seam done, production preflight pending:** ViGEm and HIDMaestro can both be
  factory-backed and either can start first. Existing entry points retain their
  current eager ViGEm ordering until an exact-persona preflight preserves the
  rule that output availability is known before keyboard capture is armed.

## Current sprint

| Slice | Deliverable | Definition of done |
|---|---|---|
| S0 — truth reset | Correct credits, source facts and routing decision | **Done.** Existing transport says it is incompatible; personas remain gated; ViGEm behavior is unchanged |
| S1 — SDK catalog probe | Pinned, source-only .NET probe using `HIDMaestro.Core.dll` | **Done.** Default run is read-only, emits one machine-readable result, loads the embedded catalog and proves the exact DualSense, Switch Pro and Xbox Series candidates without installing or creating anything |
| S1.25 — exact capability gate | Replace the backend-wide product switch with one gate per rich persona | **Done.** Existing behavior is unchanged; all three still refuse, but proving one can no longer enable the other two |
| S1.3 — host contract | Freeze a bounded, versioned Rust/.NET Play-only boundary without touching the SDK lifecycle | **Done.** Rust executes the host-side ordering, replay, timeout and teardown rules; C# mirrors all twelve wire frames plus cadence, lease, feedback and lifetime-budget simulations. There is still no real transport or SDK lifecycle call |
| S1.5 — distribution and elevation hardening | Resolve the embedded WDK-tool license and elevated helper-staging boundary | Upstream contact is open; exact security detail stays private until a reporting channel is available. No non-redistributable Microsoft tool may ship; helper/package identity and ACLs must fail closed; a clean-runner security test must prove elevated execution is isolated from untrusted state |
| S2 — one-controller conformance | Supervised plain DualSense run through the hardened supported SDK boundary | Explicit consent and UAC; one controller only; deterministic neutral/button/axis sequence is visible in Windows; bounded feedback metadata is captured; dispose removes the device; force-close recovery is separately measured |
| S3 — privilege architecture | Per-user host and Session 0 service comparison | Author confirms supported topology or a disposable-machine experiment answers it; threat model is written; standard-user client can use only fixed operations; host owns the full-state keepalive and exact controllers; crash/restart cleanup is ownership-safe |
| S4 — gated KSX adapter | Production `VirtualPadBackend` implementation behind a default-off gate | `PadState` translation, lifecycle and feedback have contract tests; no accidental persona substitution; missing/mismatched SDK refuses safely; ViGEm tests remain unchanged |
| S5 — packaging and QA | Reproducible installer/repair/uninstall plus API matrix | Clean Windows 10/11 x64 install; signed/pinned payload and notices; DirectInput, XInput where applicable, SDL, Steam, WGI/GameInput and browser checks; 4 ViGEm + 1 HIDMaestro coexistence; no unexpected devices/certificates/files after uninstall |
| S6 — native Rust decision | Evidence-based SDK-host versus native-client decision | Only pursue a native client if it has a demonstrated product benefit and upstream confirms an ABI/pinning policy; require SDK golden-vector parity and the same hardware matrix |

S1 has been reproduced without administrator rights. S2 is blocked by S1.5 and
is intentionally not automated on a developer workstation: it changes trust,
driver and device state and needs an explicit supervised hardware gate.

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

### S1.3 host-contract result

The Rust client and .NET simulator share the bounded `KSXH` V1 envelope. The
contract freezes all twelve Play-time message kinds with byte-for-byte golden
frames, not merely independent same-language round trips. It also fixes:

- a maximum of 16 total controller identities per conversation;
- exact pinned SDK hash, catalog hash, embedded-resource count, profile slug and
  VID/PID checks before state can be accepted;
- finite operation deadlines, including a 250 ms state-submit bound;
- immediate conversation poisoning and transport close after an ambiguous
  post-dispatch response, so host EOF cleanup neutralizes owned controllers;
- a host-local 16 ms SDK pump, one-second client lease refresh and five-second
  neutralize/destroy expiry; and
- full effective feedback snapshots in one conversation-global, 64-entry
  drop-oldest queue, so a later LED event cannot erase a previously observed
  zero-motor stop.

This remains an in-memory conformance boundary. It does not create a named
pipe, authenticate a Windows peer, construct `HMContext`, install a driver or
enable a persona. V1 also has no asynchronous lease-expired notification: the
client treats its controller list as presumed state, and a later operation on
an expired id fails closed and ends that conversation. A typed expiry event is
a future UX/recovery refinement, not permission to weaken the watchdog.

## Source-derived working answers

KSX does not need to wait for upstream to choose its working architecture:

- The raw mappings/events/registry contract is internal and unversioned.
  `SharedMemoryIO` and `DeviceOrchestrator` are internal SDK types, while the
  shared structures carry no magic, ABI version, declared size, feature bitmap
  or ownership token. KSX therefore treats `HMContext` / `HMController` as the
  supported boundary and will not ship a native raw-mapping client unless
  upstream later formalizes that ABI.
- Session 0 is a viable experiment, not a supported fact. A LocalSystem service
  has the right machine/global authority and the standard controller path has
  no visible interactive-session dependency. Open questions remain around the
  service account's HKCU, XInput visibility across sessions, crash recovery,
  logoff/logon and sleep/resume.
- One machine-wide owner is mandatory. Controller indices, object names and
  registry keys are global but allocation/teardown ownership is only
  process-local; a second context or process can reset or remove another
  consumer's same-index controller. KSX's host must own one context, one
  exclusive lease and one central index allocator, and normal Play must never
  call HIDMaestro's global cleanup operations. A KSX mutex can serialize KSX
  processes, but it cannot stop PadForge or another HIDMaestro consumer from
  choosing the same global index. Until upstream provides a cross-client owner
  token/allocator, production must detect existing HIDMaestro objects/devices
  and refuse coexistence explicitly; that detection still needs a
  disposable-machine race test and must not be described as perfect isolation.

These conclusions are source-backed defaults. The author's response can confirm
or correct the intended support policy, and disposable-machine evidence remains
the authority for runtime behavior.

## HIDMaestro upstream follow-up

Victor has thanked the author, confirmed that the incompatible latch remains
disabled, and asked the two architecture questions the source does not answer:

1. Are the named mappings/events/registry structures a supported and versioned
   downstream ABI, or should external products host `HIDMaestro.Core` and treat
   those details as internal? If native clients are supported, what release or
   compatibility pinning rule is expected?
2. Is `HMContext` / `HMController` intended and tested to run in a long-lived
   Windows service in Session 0, with an unelevated UI using its own narrow
   authenticated IPC channel?

The next public follow-up should ask only for a private security contact and
mention an elevated helper-staging boundary plus the SignTool redistribution
question at a high level. Exact paths, reproduction details, and impact belong
in a private report until disclosure is coordinated.

Compatibility, teardown, latency, multi-controller and XInput-slot questions
come after the probe produces reproducible logs. That gives upstream a concrete
failure or measurement to review instead of another hypothetical design.

## Go/no-go rule

Do not enable any rich persona's exact capability gate and do not offer
DualSense, Switch Pro or Xbox Series in customer configuration until S4 and S5
pass. A successful catalog read proves the dependency can be hosted; it does
not prove that a
controller can be created, driven, observed, recovered or safely packaged.
