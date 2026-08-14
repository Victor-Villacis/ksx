# HIDMaestro M8 execution plan

Status: **non-executing catalog source gate implemented with Actions evidence
pending; host-contract, unsigned-package audit and pure rendezvous policy
checkpoints complete; live use blocked on authenticated transport, provenance
and hardware evidence; no HIDMaestro persona is enabled**.

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

That closes the former *unknown facts* blocker. It also proved that KSX's former
80-byte experimental latch was not a nearly-finished production client. The
v1.6.1 SDK uses a 362-byte input section, a 64-entry output ring, PID state,
multiple named events, registry configuration and SDK-owned device creation.
Current source also has a companion-input event for the XUSB path. The obsolete
output adapter that published the private latch was removed; adding constants
to it would not have made it safe or compatible.

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

The repository does not carry the release binary. Actions downloads the release
to its disposable runner, proves the archive and DLL digests, and copies the DLL
only as inert input to the probe. The build has no CLR reference to
`HIDMaestro.Core`; CI also rejects that name in the probe's runtime dependency
graph. Pinning is evidence for this spike, not a declaration that HIDMaestro's
internal shared-memory layout is a stable third-party ABI.

### Live-use blocker in the pinned SDK

The v1.6.1 release is now used only as the exact hash-pinned input to a
**non-executing static catalog measurement**. The probe opens the DLL once with
write/delete sharing denied, hashes that handle before parsing, then uses
`PEReader` / `MetadataReader` on the same file object. It does not ask the CLR
to load or initialize the target, so target module initializers and lifecycle
code cannot run through this inventory path. The administrator Actions runner
is configured to assert the exact version attributes, 22 CLR API signatures,
228 catalog resources, 130 deployable profiles, catalog hash and three KSX
personas, then delete every SDK copy before executing the SDK-free protocol
tests. A green run closes the catalog-reader execution gap; it does **not**
approve the release for KSX distribution, developer-workstation execution as
code, or elevated use:

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

The first executable topology remains one host per Play session. The ordinary
daemon will create a one-use local named pipe *before* launching that host and
retain the elevated child process object. After the pipe accepts a client, KSX
must bind the pipe-reported client PID to that exact retained process object,
not merely reopen and trust a process with the same numeric PID. The child must
still be alive, have the expected canonical image and run in the daemon's same
nonzero interactive session. KSX deliberately does **not** require user-SID or
logon-SID equality between the two processes: over-the-shoulder UAC may launch
the host under a different administrator account.

That future pipe has a fixed security contract: first-instance creation,
exactly one server instance, remote-client rejection, and a DACL limited to the
launcher's logon SID plus Administrators and SYSTEM. The elevated client must
request only `Identification` or `Anonymous` impersonation (with the Windows
security-QoS flag set), so the ordinary server cannot impersonate the elevated
client. The random rendezvous token correlates the launch, pipe name and fixed
arguments; it is **not authentication** and never substitutes for the kernel
process-object proof.

Directly elevating a managed .NET host is currently a **no-go**. Startup hooks,
additional dependency paths and CLR profiler configuration can affect managed
execution before the host's own entry point, so a protected executable path is
not sufficient proof of a clean elevated runtime. The next executable fake host
is therefore SDK-free and unelevated. A production host will likely require an
ACL-protected native bootstrap that neutralizes those injection surfaces before
initializing a sanitized CoreCLR, or equivalent clean-runner evidence strong
enough to prove the same property.

The IPC boundary, when built, must reject arbitrary executable paths, driver
paths, descriptors, profile files and commands. It accepts only versioned
operations, allowlisted catalog profile IDs, bounded controller state and exact
controller handles created by that host. Cleanup is ownership-scoped; KSX must
not call HIDMaestro's system-wide `RemoveAllVirtualControllers()` during a
normal session because another consumer may own controllers too.

The host must implement `VirtualPadBackend` through a dedicated client; it must
not revive the removed `HmDriverApi` experiment. That trait returned a
process-local test latch and the old output adapter encoded KSX's incompatible
80-byte frame into it. The real host owns `HMContext`, `HMController` and all
SDK objects. It also caches the last full `PadState` and
owns any required idle keepalive pump: KSX's engine emits state changes, so a
cadence check called only from `VirtualPadBackend::update()` cannot fire while
the input is held and unchanged. The ordinary client still renews a slower
lease with an unchanged full-state submission every second. If no valid state
arrives for five seconds, the host neutralizes and destroys that controller
even when a wedged client keeps the pipe open.

Two routing changes prepare S4 without enabling a driver:

- **Done:** capability is gated per persona. A future DualSense proof can no
  longer expose Switch Pro and Xbox Series by flipping one backend-wide bit.
- **Routing seam done, adapter absent:** ViGEm and a future HIDMaestro backend
  can be independently factory-backed. Existing entry points retain their
  current eager ViGEm ordering until an exact-persona preflight proves output
  availability before keyboard capture is armed.

## Current sprint

| Slice | Deliverable | Definition of done |
|---|---|---|
| S0 — truth reset | Correct credits, source facts and routing decision | **Done.** Existing transport says it is incompatible; personas remain gated; ViGEm behavior is unchanged |
| S1 — SDK catalog probe | Hash-pinned, non-executing catalog measurement of `HIDMaestro.Core.dll` | **Source complete; Actions proof pending.** The gate hashes and statically parses the same open file object without a target AssemblyRef or CLR load, emits one machine-readable result, and requires 22 exact API signatures plus the DualSense, Switch Pro and Xbox Series catalog candidates. It deletes the SDK before running the pure protocol contracts |
| S1.25 — exact capability gate | Replace the backend-wide product switch with one gate per rich persona | **Done.** Existing behavior is unchanged; all three still refuse, but proving one can no longer enable the other two |
| S1.3 — host contract | Freeze a bounded, versioned Rust/.NET Play-only boundary without touching the SDK lifecycle | **Done.** Rust executes the host-side ordering, replay, timeout and teardown rules; C# mirrors all twelve wire frames plus cadence, lease, feedback and lifetime-budget simulations. There is still no real transport or SDK lifecycle call |
| S1.4 — unsafe adapter retirement | Remove the private-latch/global-lifecycle output path | **Done.** `ksx-output` has a zero-state build refusal; it cannot construct a client, transport, SDK object or controller, and installing HIDMaestro cannot change that fact |
| S1.5a — structural distribution gate | Statically audit an exact unsigned candidate without loading or executing it | **Done.** On a quiescent build tree, the probe checks a fixed manifest/tree, hashes, profile catalog, manifest-pinned INF metadata, allowed managed resources and known-symbol denylist. It deliberately cannot declare a package distribution-ready or prove arbitrary code safe |
| S1.5b — provenance and elevation hardening | Produce the runtime-only SDK and signed driver/host packages | Pending. Pin the KSX signer identity, verify every INF/DLL as a member of its signed catalog, isolate fixed installed helpers, add online revocation and clean-runner install/repair/uninstall proof, and coordinate the upstream security report |
| S1.6a — pure one-use rendezvous policy | Freeze launch correlation and peer-acceptance rules without acquiring OS authority | **Done.** A 32-byte token has one exact lowercase encoding, pipe names use one fixed prefix, host argv is exactly `serve-v1`, token and daemon PID, and peer policy requires non-forgeable authenticated process evidence. The module does not create a pipe, launch or elevate a process, load the SDK or touch a device |
| S1.6b — authenticated local transport and fake host | Exercise the V1 host contract over the real one-use pipe without the SDK | Pending. The ordinary daemon precreates the local-only pipe, launches and retains one exact child object, authenticates the accepted endpoint, and talks to an unelevated SDK-free fake host. Direct elevation of the managed host remains forbidden until its pre-entry runtime-injection surface is neutralized |
| S2 — one-controller conformance | Supervised plain DualSense run through the hardened supported SDK boundary | Explicit consent and UAC; one controller only; deterministic neutral/button/axis sequence is visible in Windows; bounded feedback metadata is captured; dispose removes the device; force-close recovery is separately measured |
| S3 — privilege architecture | Per-user host and Session 0 service comparison | Author confirms supported topology or a disposable-machine experiment answers it; threat model is written; standard-user client can use only fixed operations; host owns the full-state keepalive and exact controllers; crash/restart cleanup is ownership-safe |
| S4 — gated KSX adapter | Production `VirtualPadBackend` implementation behind a default-off gate | `PadState` translation, lifecycle and feedback have contract tests; no accidental persona substitution; missing/mismatched SDK refuses safely; ViGEm tests remain unchanged |
| S5 — packaging and QA | Reproducible installer/repair/uninstall plus API matrix | Clean Windows 10/11 x64 install; signed/pinned payload and notices; DirectInput, XInput where applicable, SDL, Steam, WGI/GameInput and browser checks; 4 ViGEm + 1 HIDMaestro coexistence; no unexpected devices/certificates/files after uninstall |
| S6 — native Rust decision | Evidence-based SDK-host versus native-client decision | Only pursue a native client if it has a demonstrated product benefit and upstream confirms an ABI/pinning policy; require SDK golden-vector parity and the same hardware matrix |

S1, S1.3, S1.5a and S1.6a do not request administrator authority or mutate the
system. The S1 reader runs on an administrator Actions runner only because that
is GitHub's hosted Windows topology; the target DLL remains inert bytes. S2 is
blocked by S1.5b and is intentionally not automated on a developer workstation:
it changes trust, driver and device state and needs an explicit supervised
hardware gate.

### S1 measured result

Actions is configured to build `tools/hidmaestro-probe` with pinned .NET
10.0.400 and run its static reader against the hash-pinned release DLL. A green
run must confirm the following frozen result before S1 is marked complete:

- 228 embedded catalog resources, of which 130 are deployable;
- catalog SHA-256
  `8f407e6e1c3c241e16cf6bef387216ad4d1f5de055a2c4cc041ca16ce7954a6a`;
- all 22 public read-API shape checks present; and
- exact contract matches for `dualsense`, `switch-pro` and
  `xbox-series-xs-bt`.

The reader checks the `AssemblyFileVersionAttribute` and informational version
directly from metadata; it does not reopen the path for native version APIs. It
decodes exact public type/member signatures and reads only bounded raw embedded
resource blobs, rejecting linked, duplicate, overlapping or inconsistent
resource records. A defense-in-depth source guard rejects the known loader,
activation, `ResourceManager` / `ResourceReader` and native-loader API patterns
in this threat model. Actions then removes the DLL, archive, extracted release
and environment paths before running the pure parser/protocol tests. This
proves compatibility of the exact pinned API/catalog bytes only; it does not
prove arbitrary SDK code safe, establish release provenance, or authorize a
controller lifecycle.

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

### S1.4/S1.5a safety result

An attempted direct output-adapter integration exposed four coupled lifecycle
requirements that a pipe alone would not solve: a slow serial Create can expire
an earlier controller's five-second lease; protocol poisoning can trigger host
EOF cleanup before the supervisor restores keyboard passthrough; a generic
transport does not promise that Drop produces immediate host EOF cleanup; and
an idle-service failure can race the interval between output readiness and
capture arming. The adapter was removed instead of shipping those races behind
a disabled flag. The next integration must solve and test them at the broker,
adapter and supervisor boundaries together.

The probe's `distribution-candidate` command now performs a static structural
audit of a caller-supplied, quiescent candidate directory. It does not load an assembly,
execute a payload, elevate, install, sign or mutate trust. A structural
`unsigned-build` can pass; `distribution-ready` is hard-blocked in source until
KSX pins its release signer identity and verifies INF/DLL membership in both
signed catalogs. Offline `WinVerifyTrust` plus caller-provided hashes is not
treated as provenance. Nor does metadata-name inspection prove that renamed or
arbitrary executable behavior is safe: `ok` means the declared structural
contract passed, never that the candidate may be executed. The official v1.6.1
release is expected to fail because it embeds known provisioning resources and
symbols and carries stale 1.4.7 INF metadata. This checkpoint is a
specification for a sanitized build, not an approval to redistribute that
release.

This slice does not atomically bind every hash, signature and parser read while
another process mutates the tree. Its machine-readable assurance is therefore
`structural-only-quiescent-tree`. S1.5b must use an immutable snapshot or stable
file identities before any audit result can authorize signing, packaging or
execution.

### S1.6a rendezvous-policy result

`ksx-hidmaestro::rendezvous` freezes the pure part of the first per-Play
boundary: a 256-bit token rendered as exactly 64 lowercase hexadecimal digits,
one pipe name derived from that token and a fixed V1 prefix, and a three-item
host argument vector containing only the fixed verb, token and nonzero daemon
PID. The token is redacted from debug output.

The peer verifier fails closed on PID, nonzero session, canonical image,
liveness and the expected privilege state. Its evidence fields cannot be
constructed by callers outside the crate. That makes matching strings and
booleans insufficient to forge a successful policy input, but it does not make
the pure module an authenticator: S1.6b must populate those fields only after
the named-pipe endpoint has been tied to the exact retained process object by
authoritative Windows queries.

There is still no named-pipe server or client, process launch in this crate,
elevation, SDK load, controller lifecycle or enabled persona. S1.6a is the
policy that the next transport must obey, not evidence that the transport has
already been built.

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
