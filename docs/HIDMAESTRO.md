# HIDMaestro M8 execution plan

Status: **the installed product path for one plain-USB DualSense is implemented
and has passed clean-runner build, byte-inspection, packaging, and installer
acceptance; supervised hardware/API/force-kill acceptance remains. Switch Pro
and Xbox Series are still gated.**

The implementation uses a fixed NativeAOT elevated sibling, authenticated
one-use IPC, one exact controller slot, creator-owned shared memory, a five-second
host lease, exact-owned PnP teardown, and an explicit installer-only driver
bootstrap pinned to the upstream v1.6.1 release. The ordinary daemon remains
non-elevated and has no package, certificate, driver-path, or raw-handle API.

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

The production integration uses the official [HIDMaestro v1.6.1 release](https://github.com/hifihedgehog/HIDMaestro/releases/tag/v1.6.1):

| Item | Pinned value |
|---|---|
| Git tag commit | `2a0dac0857901a63d365a36dcf99cf50114ca954` |
| Release asset | `HIDMaestro-v1.6.1.zip` |
| Release ZIP SHA-256 | `00145c23d9838be6089389ce58b3fd2b6766fa9bc0f1f3c60a3c885361b53c34` |
| `HIDMaestro.Core.dll` SHA-256 | `adadd9e2604b7b6b047f386ebdd03879feef48009c6290281e4c665e2190f6d5` |
| Managed target | .NET 10, Windows x64 |

The repository and shipped KSX installer do not carry the upstream release
binaries. The self-contained installer bootstrap contains only the fixed URL,
byte lengths, and SHA-256 pins. When the user explicitly selects the setup task,
it downloads the exact official archive, proves the archive and all three
required managed assemblies, invokes the one pinned install API from a protected
temporary directory, unloads it, and removes the downloaded bytes. This avoids
redistributing the upstream SDK and its embedded WDK tools; an internet
connection is therefore required for that optional setup task.
[Microsoft explicitly documents SignTool as non-redistributable](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/installing-a-catalog-file-by-using-signtool),
so this boundary is a shipping constraint, not just an installer-size choice.

The runtime host is built separately from the exact pinned source commit and
the reduced, reviewed KSX candidate. It embeds only the pinned profile catalog
and one fixed runtime contract. It does not expose HIDMaestro's package install,
certificate, arbitrary profile, raw report, or global cleanup surfaces.

## Live privilege boundary

Driver provisioning and controller creation require administrator authority;
the rest of KSX does not. The shipped topology is:

```text
ordinary KSX daemon  ->  authenticated one-use pipe  ->  NativeAOT host
       UI/config             fixed bounded messages          elevated
       game launch           full controller snapshots       one device
```

The ordinary process creates the first-instance pipe before launch, retains the
exact elevated child process, and correlates the kernel-reported pipe client to
that process. The host independently verifies that its server is the
non-elevated installed `ksx.exe` in the same interactive session. Both installed
executables must pass the Program Files location and DACL proof before launch.

The wire protocol contains only Hello, one allowlisted DualSense Create, full
bounded state Submit, Destroy, Shutdown, and bounded feedback/fault frames. It
contains no executable, package, certificate, descriptor, profile-path,
registry, or raw-handle parameter. A second controller is refused in setup,
configuration, slot mutation, `ksx pads`, the Rust backend, and the host.

The host proves the exact preinstalled v1.6.1 INF and UMDF DLL bytes, creates
only its session-owned root and child identities, owns the fixed shared-memory
objects, and removes only those captured identities. It never calls the
upstream global sweep during Play. It republishes the last full input state at
16 ms, while the client renews a five-second lease once per second. A broken
pipe, dead daemon, expired lease, output-thread error, or normal stop
neutralizes and tears down the exact controller while the host is alive. If the
elevated host itself is forcibly terminated, the driver watchdog neutralizes
input; the next protected host start removes only the prior KSX-owned captured
root/key residue before creating a new controller. The force-kill timing and
residue result still need the supervised hardware gate below.

The installer is the only provisioning authority. Its checked setup task runs a
single-purpose self-contained bootstrap which downloads and verifies the pinned
upstream archive at install time, calls `InstallDriver()` under the installer's
existing elevation, then deletes the temporary SDK. The ordinary daemon and
runtime host have no network or package-install authority. The host and
bootstrap are omitted from portable packages. Current release signing and the
supervised clean Windows/hardware matrix remain release acceptance work, not
missing product code.

## Delivery state

| Product slice | State |
|---|---|
| One USB DualSense persona | **Implemented.** Exact VID/PID/descriptor, full state mapping, output feedback, idle republish and client lease are live. |
| Privileged host | **Implemented.** Fixed installed NativeAOT executable, UAC launch, authenticated one-use pipe, exact process/session checks and bounded protocol. |
| Device ownership | **Implemented.** One preinstalled-package proof, one exact root, captured child identities, neutralize-before-remove and no Play-time global sweep. |
| Capacity and configuration | **Implemented.** The one-controller ceiling is enforced by setup, validation, game profiles, slot mutation, pad testing, routing and host dispatch. |
| Installer/package | **Implemented.** Checked, internet-disclosed HIDMaestro setup task; runtime hash-pinned official download; protected installed host; cleanup; notices/licenses; and intentional portable omission. |
| Other rich personas | **Gated.** Switch Pro and Xbox Series remain known configuration vocabulary but cannot be selected as working outputs. |
| Automated software acceptance | **Passed.** [Main Actions run 31898250940](https://github.com/Victor-Villacis/ksx/actions/runs/31898250940) passed contracts, the isolated A/B build and 1,465-check byte-only artifact inspection, the full test/feature matrix, portable packaging, installer safety checks, and repeated install verification. |
| Physical release acceptance | **Pending.** Clean Windows 10/11, DirectInput/SDL/Steam/browser/WGI, coexistence, force-kill and residue checks require a supervised controller machine. |

The earlier S1.x sections below are retained as the provenance trail that led
to this implementation. Their source-only verdicts describe those historical
checkpoints, not the capability of the current product tree.

### S1 measured result

[Actions run 31845219892](https://github.com/Victor-Villacis/ksx/actions/runs/31845219892)
built `tools/hidmaestro-probe` with pinned .NET 10.0.400 and ran its static
reader against the hash-pinned release DLL. It confirmed:

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

### S1.5b/S1.5c/S1.5d runtime-candidate checkpoint

S1.5b's first checkpoint pinned the exact upstream v1.6.1 source baseline and
the pure native-bootstrap policy without building or loading upstream code.
S1.5c completes the source-design freeze for one plain USB DualSense
(`dualsense`, `054C:0CE6`) at controller index 0.

The green S1.5c gate records four completed source-only facts:

- `sourcePublicApiContractFrozen`: an exact nine-type, 100-entry public target;
- `sourceCompilationDispositionFrozen`: all 51 upstream Core units classified
  exactly once as 1 retained, 13 replacement-required and 37 excluded;
- `profileSourceManifestFrozen`: all 231 profile-tree files classified into 228
  intended embedded resources and 3 exclusions, with 130 deployable descriptors
  and no duplicate profile IDs; and
- `rawFeedbackContractFrozen`: the raw `HidOutput(0)` / report `0x02` /
  47-byte-data boundary and conservative effective-motor policy frozen in one
  dependency-free Rust reducer and 16 golden vectors.

The green [S1.5d Actions gate](https://github.com/Victor-Villacis/ksx/actions/runs/31863647868)
validates the complete inert managed-source candidate named by those
contracts: 10 candidate C# units, one explicit project, and one staging
ignore. The project lists exactly 11 compile inputs and 228 profile resources,
disables default item discovery, and references only a fixed, deliberately
absent `.pinned-upstream-v1.6.1` staging directory. Its source verifier freezes
the 12-file tree and 453 static relationships without invoking MSBuild or
loading the candidate.

The same checkpoint adds a source-derived DualSense input contract over 12
pinned upstream blobs, six descriptor groups, nine scenarios, and 37 complete
64-byte reports. The candidate encoder uses report ID `0x01` at byte zero, and
the legacy shared-state seam passes exactly bytes 1 through 63. Those are
source relations only; the candidate has not executed the vectors.

These are source contracts, not artifact evidence. The aggregate contract
therefore still keeps all six runtime/distribution gates false:

- `artifactPublicApiAllowlistFrozen`;
- `artifactCompileAllowlistFrozen`;
- `profileSourceCatalogBound`;
- `rawFeedbackDecoderFrozen`;
- `driverRuntimeAbiBound`; and
- `distributionReady`.

Closing those gates still requires an Actions-built runtime-only assembly whose
metadata, compile closure and 228 resources match the source contracts, managed
input and feedback artifact checks passing the 37 and 16 frozen vectors,
binding the source layout to the exact signed installed driver binary/catalog,
the production native-bootstrap/managed-host graph, signer/catalog/revocation
proof and clean-VM lifecycle evidence.

S1.5d leaves every artifact, driver, distribution and hardware gate false. The
next slice is S1.5e in GitHub Actions: populate only the fixed staged inputs in
an immutable runner directory, build without executing the candidate, then use
non-executing PE/metadata inspection to prove the nine-type/100-entry public
surface, exact compile/resource closure, absence of an entry point or module
initializer, and bounded MemberRef/P/Invoke authority.

The source contract also requires transactional exact-device ownership: capture
the parent identity immediately after registration, retain exact-owned recovery
state and a serialized retry action across later failures, and remove only
those exact identities after state teardown succeeds.

The separate `tools/hidmaestro-bootstrap-policy` harness freezes the future
elevation topology without containing a binary target, dependency, unsafe code
or process authority. A fixed native bootstrap—not the managed host directly—
must connect to the authenticated pipe, create the fixed managed child
suspended with a fresh allowlisted environment and one inherited handle,
atomically contain it in a kill-on-close job, verify the sealed image/session/
elevation graph, and only then resume it. The managed entry must immediately
clear and verify the pipe's inherit flag before threads, SDK work or logging.
Its working directory, runtimeconfig/deps graph and native module origins are
also fixed protected inputs rather than inherited search state.

[Actions run 31852136380](https://github.com/Victor-Villacis/ksx/actions/runs/31852136380)
passed the hash-pinned source audit, strict bootstrap-policy formatting,
Clippy/tests, static SDK inventory, SDK-free fake-host transport, full workspace
and feature matrices, the existing WinUSB provider smoke,
portable/installer builds, hostile-junction refusal and install-twice gate.
That evidence validates the
contracts only; it does not claim that the production bootstrap, sanitized
runtime assembly, signed driver package or S2 hardware lifecycle exists.

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

S1.6a itself still has no named-pipe server or client, process launch,
elevation, SDK load, controller lifecycle or enabled persona. S1.6b consumes
that policy through a separately gated Windows transport; it does not turn the
pure policy module into OS authority.

### S1.6b authenticated-transport result

The source now precreates one first-instance, single-client, remote-rejecting
byte pipe with an explicit launcher-logon-SID, Administrators and SYSTEM DACL.
It launches only the fixed SDK-free fake apphost beside the Rust test binary,
retains that exact process object, authenticates the connected client before
`Hello`, and transfers the 16-byte-header/512-byte-payload `KSXH` frames with
finite deadlines. One reader owns the pipe, demultiplexes correlated replies
from request-id-zero feedback, bounds feedback at 64 drop-oldest snapshots, and
closes and joins on every ambiguous or terminal path.

The fake connects with explicit anonymous SQOS so the ordinary server cannot
impersonate it. It covers all three allowlisted profile identities and the
full create/submit/feedback/destroy/shutdown conversation, but creates only
in-memory fake state. It contains no SDK reference or lifecycle API and cannot
enable a persona. [Actions run
31849073410](https://github.com/Victor-Villacis/ksx/actions/runs/31849073410)
built the fixed apphost, deleted every SDK input and environment path, passed
its pure contracts, placed it beside the Rust test executable, and passed the
authenticated cross-language test. The same run also passed the workspace,
feature-matrix, native-provider, portable-package, installer, hostile-junction
and install-twice gates.

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

The redistribution concern is closed on KSX's side: the shipped bootstrap does
not contain SignTool, Inf2Cat, the upstream SDK, or another WDK payload. The
explicit setup task retrieves the pinned official upstream release directly,
executes only after exact verification, and deletes the temporary files. Any
remaining upstream security report should still use a private contact for exact
paths, reproduction details, and impact.

Compatibility, teardown, latency, multi-controller and XInput-slot questions
come after the probe produces reproducible logs. That gives upstream a concrete
failure or measurement to review instead of another hypothetical design.

## Go/no-go rule

DualSense is enabled because its S4 implementation and installer boundary now
exist. Do not enable Switch Pro or Xbox Series until their independent runtime,
feedback and hardware gates pass. Do not call the DualSense hardware gate
complete until the clean-machine S2/S5 matrix is recorded against the exact
installer artifact.
