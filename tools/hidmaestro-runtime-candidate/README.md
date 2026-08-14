# HIDMaestro S1.5b runtime candidate contract

This directory freezes the smallest source-backed runtime slice that can
legitimately unblock the supervised S2 experiment. It is a **static design and
input contract**, not a built SDK, executable host, driver package, or approval
to run HIDMaestro on a developer workstation.

The candidate is deliberately narrower than the eventual product backend: one
plain USB DualSense profile (`dualsense`, `054C:0CE6`), one live controller at
index 0, on a disposable Windows machine where the exact signed HIDMaestro HID
driver package was installed beforehand and no other HIDMaestro consumer or
device exists. Switch Pro is also structurally plain HID, but it is not needed
to answer S2's first lifecycle question. Xbox Series needs an SWD companion;
composite profiles need the USB/IP lane. Adding either now would enlarge the
ownership and provisioning problem before the first proof exists.

`source.lock.json` pins the exact upstream v1.6.1 commit and every source unit
used to derive this decision. Its hashes deliberately describe a Windows
checkout made with `core.autocrlf=true`; CI sets that conversion explicitly so
runner-global Git configuration cannot change the audited bytes.
`test-source-contract.ps1` verifies those bytes and the relevant source facts
without building or loading any assembly. A pass means only that the reviewed
baseline is present; it intentionally does not mean the upstream project is
safe to execute. `candidate-contract.json` is an inert design input for the
fork. Its `gateState` values deliberately keep artifact construction and
distribution blocked until the exhaustive API, compile-source, profile-source
and package-graph contracts named there are frozen.

## Smallest implementable slice

Keep the assembly identity `HIDMaestro.Core`, the frozen 1.6.1-derived version
contract and its .NET 10 Windows x64 target so the host boundary does not fork
unnecessarily. The desired candidate keeps the entire pinned profile catalog
as inert JSON resources so the existing 228-resource / 130-deployable /
catalog-hash evidence remains reproducible. The current source lock does not
yet bind all 228 source JSON files to that digest, so
`profileSourceCatalogBound` remains false and no artifact may be built from
this design checkpoint. Runtime creation is limited to the exact `dualsense`
identity for the first conformance experiment.

The public surface needed by the real host is only:

- `HMContext()` with no background work;
- `LoadDefaultProfiles()` and `GetProfile(string)`;
- `CreateController(HMProfile)` with the exact profile and one-controller
  guard;
- `HMController.SubmitState(in HMGamepadState)`, bounded output feedback, and
  `Dispose()`; and
- the read-only profile identity properties required to re-check the catalog
  contract immediately before create.

The intended feedback boundary is raw `HMController.OutputReceived` data
through `HMOutputPacket`/`HMOutputSource`; the broader decoded-output event
surface is not required for this checkpoint. That adapter is not frozen yet:
`HMOutputPacket.ReportId` is separate from `HMOutputPacket.Data`, and `Data`
does not contain the report-ID byte. A future source-frozen adapter must prove
its exact valid-flag, motor and optional-field coordinates with cross-language
golden vectors before `rawFeedbackDecoderFrozen` can become true.
`candidate-contract.json.requiredHostApiMinimum` records the necessary floor,
not an exhaustive public API allowlist. A future artifact gate must freeze every
reachable public type and member before `artifactPublicApiAllowlistFrozen` can
become true.

The future build must use an explicit compile allowlist and embed only
`HIDMaestro.Profiles.*.json`. That exact list is not frozen yet, so
`artifactCompileAllowlistFrozen` remains false. The project must not import the
upstream default source or resource globs. In particular, the runtime assembly
must not contain
`DriverBuilder`, `EmbeddedManifest`, `PnputilHelper`, `SwdDeviceFactory`, the
USB/IP subtree, `VrDriverBuilder`, WDK tools, drivers, INFs, catalogs, helpers,
USB/IP installers, VR payloads, or third-party executables.

Four source units must be forked rather than copied unchanged:

1. `HMContext` becomes a side-effect-free object owner. Install, driver probe,
   arbitrary-directory profile loading, global cleanup, USB/IP, bulk parallel
   cleanup and name-finalization methods are absent.
2. A small `RuntimePlainHidLifecycle` replaces the large all-persona
   `DeviceOrchestrator` for this slice. It assumes the signed package is already
   present, creates only the one plain-HID parent, and captures its exact
   identity immediately after registration. A partial-owned transaction record
   survives every later failure until exact-identity rollback succeeds or a
   recovery-required error is reported. It has no fallback to driver deployment
   or repair.
3. `HMController` retains that immutable owned-device record. Dispose
   neutralizes the controller and closes process-owned mappings/pumps before it
   removes only those exact device IDs.
4. The project file has no pre-build resource packer, download target or
   implicit compile/resource items.

The current `DeviceNodeCreator` cannot simply be copied: it calls
`UpdateDriverForPlugAndPlayDevicesW` with an INF path, which is a runtime
driver-update capability. The conformance lifecycle must instead create the
devnode against a package already staged in the Driver Store and let PnP bind
from that store. Whether the v1.6.1 device/INF pair binds reliably without the
explicit update call is a disposable-machine measurement, not a fact proven by
source. Failure is fail-closed and leaves the persona disabled.

## Why the official v1.6.1 assembly cannot be trimmed after build

The hazards are coupled into executable code, not only embedded resources:

- `HMContext()` starts tasks that extract embedded payloads, inspect/install
  state, parse the profile database and prewarm a Windows service.
- `SetupController` runs a once-per-process machine-wide ghost cleanup and can
  call `DriverBuilder.FullDeploy()` on demand.
- `SwdDeviceFactory` can extract `hmswd.exe` from the assembly, execute it from
  `%TEMP%`, and write helper logs there.
- the composite backend installs USB/IP on first use and performs stale-device
  sweeps; and
- ordinary teardown retains only one primary instance ID, then rediscovers
  companions by global `ControllerIndex` scans and runs an orphan sweep.

Removing resource blobs from the release DLL leaves all of those paths in
metadata/IL and turns some into late runtime failures. S1.5b therefore needs a
source build with the unwanted units absent, not post-build surgery.

## Broader runtime after S2

The next increment can add Switch Pro after the same exact-owned lifecycle
passes for its plain-HID profile. Xbox Series must wait for a fixed, installed,
identity-verified `hmswd.exe` and a create result that retains every exact SWD,
HID and XUSB companion ID. The helper must be resolved from one ACL-protected
installed location, never an embedded resource, `%TEMP%`, `PATH`, the working
directory, an environment variable, or IPC input; its own temporary self-log
must also be removed.

Composite USB profiles remain a separate slice. They require a preinstalled,
licensed and signed USB/IP transport and ownership-scoped attach/detach. The
current on-demand installer and port-range sweeps do not belong in the Play
runtime.

No source-only fork can create safe coexistence with PadForge or another
unmodified HIDMaestro consumer. Controller indices, shared objects and registry
keys are machine-global and the protocol has no owner token or negotiated
allocator. A KSX mutex prevents two KSX hosts from racing; it cannot make other
products honor the lease. Product enablement therefore still needs an upstream
ownership/allocator answer or an explicit, measured refusal policy, and S2 must
run on an isolated disposable machine.

## GitHub Actions plan

Keep all expensive and mutating work off the development PC:

1. On an ephemeral Windows build job, fetch the upstream source at the exact
   commit and run `test-source-contract.ps1`. GitHub's hosted Windows token is
   not a security boundary, so the upstream project, targets and payloads are
   never executed. No release DLL is an input. Only after a reviewed explicit
   compile list and complete profile-source manifest are pinned may a later job
   copy those files into an immutable candidate staging tree and build the
   runtime-only assembly with pinned .NET 10.0.400.
2. Run the existing non-executing PE/metadata reader on the candidate. Require
   assembly version 1.6.1.0, the exact profile catalog, the small runtime API,
   no forbidden type/member names, and no resource outside the profile catalog.
   Extend the gate to inspect MemberRefs/P/Invoke targets so source units cannot
   hide driver-store, certificate-store, process-launch, download or global-
   sweep capability behind renamed methods.
3. Build HID and host artifacts in separate jobs. Generate catalogs from a
   quiescent immutable tree, then sign outside the runtime build. Never put WDK
   signing tools, a signing key or a certificate-install path in a shipped
   payload.
4. Verify each INF/DLL as a member of the expected signed catalog, pin the
   expected KSX/Windows signer identity, check online revocation, and bind every
   verification/hash/parser read to stable file identities. Only then assemble
   a candidate package.
5. Use a fresh disposable Windows VM for install/repair/uninstall and the
   supervised one-DualSense create/state/feedback/neutral/dispose/force-close
   sequence. Collect SetupAPI/PnP evidence and assert no devices, files,
   services, certificates or packages remain beyond the explicit installer
   contract. This is the first job allowed to execute the SDK or mutate device
   state.

The existing `distribution-candidate` command is a useful structural baseline,
but its fixed ten-file tree describes the eventual multi-persona package. The
first S2 package should use a versioned `dualsense-conformance` manifest flavor
containing only the runtime assembly, protected native/managed host payload,
the HID INF/DLL/catalog trio and the MIT notice. Its complete native bootstrap,
managed apphost, runtimeconfig, deps and self-contained runtime graph must be
sealed by stable file identity, hash and signer—not just by pathname. It should
not require or ship the XUSB package or `hmswd.exe` merely to satisfy a
future-shape manifest.

## External blockers

- KSX still needs a release-signing identity, protected signing service and a
  Windows Hardware Developer Program account. [Microsoft's current signing
  guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)
  requires an EV certificate for Hardware Dev Center submission and describes
  attestation signing as a testing path; a market release should plan the HLK /
  Windows Hardware Compatibility Program lane rather than assuming a locally
  signed catalog is sufficient. Catalog membership must also be verified, not
  inferred from a trusted catalog signature; Microsoft documents the exact
  `SignTool verify /c CatalogFile.cat DriverFile` form in its [catalog-member
  verification guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/verifying-the-signature-of-a-test-signed-catalog-file).
- The production native bootstrap/managed-host package does not exist yet, so
  its exact file graph and signer pins cannot be frozen in this SDK-only slice.
- Driver Store binding without the upstream explicit update call, exact
  teardown behavior, force-close recovery and residue are hardware/OS facts
  that require the disposable-machine gate.
- The source-level `driver.h`/`driver.c` layout and lifecycle facts are not yet
  bound to the exact signed installed HID driver binary/catalog. That ABI and
  provenance gate must pass before `driverRuntimeAbiBound` can become true.
- Cross-product controller-index ownership is not solvable by this fork alone.

## Static use

From a clean checkout of the exact upstream source, the only supported local
operation in this directory is the source-byte audit:

```powershell
./tools/hidmaestro-runtime-candidate/test-source-contract.ps1 `
  -SourceRoot C:\path\to\HIDMaestro-v1.6.1
```

It hashes and reads text only. It does not compile, load the SDK, launch a
helper, elevate, install, sign, create a controller or touch hardware.
