# HIDMaestro S1.5d/S1.5e source freezes; observation not established

This directory contains the smallest complete managed-source candidate for the
supervised S2 experiment. S1.5d freezes source and literal project XML only:
its verifier does not build or load the candidate. The exact S1.5e observation
infrastructure is also source-frozen, and its GitHub Actions build is authorized,
but no observation has yet been established and no artifact has been built under that scope.
Local and product builds remain unauthorized; loading, hosting, packaging and
executing any observation output are also unauthorized.

The candidate is deliberately narrower than the eventual product backend: one
plain USB DualSense profile (`dualsense`, `054C:0CE6`), one live controller at
index 0, on a disposable Windows machine where the exact signed HIDMaestro HID
driver package was installed beforehand and no other HIDMaestro consumer or
device exists. That remains the only persona this candidate can CREATE.

Two more personas are now source-frozen but deliberately not live. Switch Pro
and Xbox Series each have an input encoder, a source-derived input contract and
golden vectors, and S1.5d verifies each encoder against its own contract rather
than holding one persona's grammar over all three. Encoding a report and
creating the device that carries it are separate problems, and only the first
is solved here. Switch Pro is structurally plain HID and is the next lifecycle
candidate. Xbox Series is created as a single software-device companion bound
by Windows' own inbox `xinputhid` driver — not as a plain-HID node, and not as
an XUSB companion — so the device lifecycle refuses it by name rather than
attempting a creation that cannot work. Composite
profiles still need the USB/IP lane. The ksx build gate keeps both personas off
until a built artifact drives a real pad.

`source.lock.json` pins the exact upstream v1.6.1 commit and the original
decision inputs. The `api/` and `profiles/` directories now add an exhaustive
nine-type public target, a classification of all 51 upstream Core source units,
and a canonical manifest for all 231 profile-tree files. The separate
`../hidmaestro-feedback-contract/` directory freezes the raw plain-USB
DualSense feedback envelope and 16 golden vectors. Their verifiers read and
hash source only; they do not build or load upstream code.

The separate `../hidmaestro-input-contract/` directory freezes the active
legacy USB input path from 12 pinned upstream blobs: six descriptor groups,
nine scenarios, and 37 complete 64-byte reports. The report ID is byte zero;
the future legacy shared-memory endpoint receives exactly bytes 1 through 63.
That source-derived contract does not prove compiled candidate behavior.

`../hidmaestro-input-contract-xbox-series/` and
`../hidmaestro-input-contract-switch-pro/` freeze the same shape for the two
added personas. Xbox Series is 17 bytes with no report ID at all — nothing is
stripped and the endpoint receives the whole report — across 13 scenarios and
45 frames. Switch Pro encodes report `0x3F`, the only one of that descriptor's
six input reports described field by field, across 11 scenarios and 43 frames;
its `0x21`/`0x30` and `0x31`-`0x33` family are vendor blobs this candidate
never synthesizes. Both were derived by walking the pinned descriptors, and
both record that the host state mapper populates `HMAxis` with one fixed
physical assignment shaped by DualSense, so a descriptor that spells its axes
differently must be read by physical meaning rather than by letter.

The original source hashes deliberately describe a Windows checkout made with
`core.autocrlf=true`; CI sets that conversion explicitly so runner-global Git
configuration cannot change the audited bytes. A pass means only that the
reviewed source contracts and inert candidate bytes are present.
`candidate-contract.json` distinguishes those completed source freezes from
the narrowly authorized, source-frozen but not-yet-established Actions observation and the
still-false artifact, driver, distribution, and hardware gates. No current
pass proves an artifact build or authorizes loading or execution.

## Smallest implementable slice

Keep the assembly identity `HIDMaestro.Core`, the frozen 1.6.1-derived version
contract and its .NET 10 Windows x64 target so the host boundary does not fork
unnecessarily. The source catalog is now fully pinned: 231 JSON files, exactly
three source-data exclusions, 228 intended embedded profiles, 130 deployable
descriptors, and zero duplicate IDs. That source manifest deliberately does
not claim byte-for-byte equivalence to the official release DLL's CLR resources;
`profileSourceCatalogBound` remains false until a built candidate proves the
resource names and bytes. The future candidate resource contract includes all
228 manifest-selected profile sources; only `CreateController` remains limited
to the exact `dualsense` identity for the first conformance experiment.

`api/public-api.contract.json` freezes the exact nine-type, 100-entry public
surface needed by the real host:

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
surface is not required. The pure feedback contract now proves that
`HMOutputPacket.ReportId` is separate from its exact 47-byte `Data`, freezes the
validity and motor coordinates, and reduces partial commands into complete
effective snapshots. KSX's Rust model mirrors that reducer. The managed adapter
source now exists in the inert candidate, so `rawFeedbackContractFrozen` is
true. The source verifiers do not compile or execute it, and the source-frozen
S1.5e observation will not execute the 16 vectors, so `rawFeedbackDecoderFrozen`
remains false. A later cross-language artifact test must apply all 16 golden
vectors before that gate can change.

The managed input encoder source likewise emits a complete 64-byte report and
the source seam strips the report ID before the planned 63-byte legacy data
submission. A later artifact test must reproduce all 37 frozen input frames
and prove that exact boundary; source anchors alone are not behavior proof.

The exact source target likewise does not prove a built assembly. The source-frozen,
not-yet-established S1.5e observation must show that every reachable public member equals the
frozen contract, but observation evidence is not yet established or adopted
and `artifactPublicApiAllowlistFrozen` remains false.

The source-disposition contract classifies all 51 upstream `.cs`/`.csproj`
units exactly once: one may remain byte-for-byte unchanged, 13 require narrowed
replacement, and 37 are excluded. S1.5d now contains thirteen candidate C# files,
one explicit project, and a `.gitignore` for the deliberately absent fixed
upstream staging directory. The project names exactly 14 compile inputs and
228 literal resource inputs with default item discovery disabled. This is
source/project closure only: `artifactCompileAllowlistFrozen` remains false
before the isolated observation build, and an observation result will still require
an explicit later adoption decision before that gate can change.
In particular, a future runtime assembly must not contain
`DriverBuilder`, `EmbeddedManifest`, `PnputilHelper`, `SwdDeviceFactory`, the
USB/IP subtree, `VrDriverBuilder`, WDK tools, drivers, INFs, catalogs, helpers,
USB/IP installers, VR payloads, or third-party executables.

`api/source-compilation.contract.json` is the exhaustive authority for every
upstream disposition and planned candidate unit. The following five items are
only a non-authoritative summary of the safety-critical implementation themes:

1. `HMContext` becomes a side-effect-free object owner. Install, driver probe,
   arbitrary-directory profile loading, global cleanup, USB/IP, bulk parallel
   cleanup and name-finalization methods are absent.
2. A small `RuntimePlainHidLifecycle` replaces the large all-persona
   `DeviceOrchestrator` for this slice. It assumes the signed package is already
   present, creates only the one plain-HID parent, and captures its exact
   identity immediately after registration. Exact-owned recovery state and a
   serialized retry action survive later teardown failure until exact-identity
   rollback succeeds or a recovery-required error is reported. It has no
   fallback to driver deployment or repair.
3. `HMController` retains that immutable owned-device record. Dispose
   neutralizes the controller and closes process-owned mappings/pumps before it
   removes only those exact device IDs.
4. The project file has no pre-build resource packer, download target or
   implicit compile/resource items.
5. The managed `RawDualSenseFeedbackAdapter` source mirrors the frozen pure reducer:
   source 0, report ID `0x02`, exactly 47 data bytes, distinct legacy/v2
   validity combinations, owned complete snapshots, and all-zero/valid-zero
   stop behavior. It remains unbuilt and unexecuted.

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
metadata/IL and turns some into late runtime failures. S1.5c therefore needs a
source build with the unwanted units absent, not post-build surgery.

## Broader runtime after S2

The next increment can add Switch Pro after the same exact-owned lifecycle
passes for its plain-HID profile; its encoder and input contract are now in
place. Its `inputReportSize` of 362 is the length of its LARGEST declared
report (`0x31`/`0x32`/`0x33`, 361 data bytes plus an ID), not of the one this
candidate encodes; a shorter submission is ordinary because the shared section
carries an explicit `DataSize` field, as DualSense's 63 bytes already show. Xbox Series must wait for a fixed, installed,
identity-verified `hmswd.exe` — which upstream ships only as
`driver/hmswd/hmswd.c`, so we compile it ourselves. Its encoder and input
contract are in place, and `RuntimeInputWireShape` marks it as requiring that
helper so the refusal names the missing piece. No XInput INF needs shipping:
`xinputhid` is genuine Microsoft inbox. The helper must be resolved from one ACL-protected
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

[Actions run 31863647868](https://github.com/Victor-Villacis/ksx/actions/runs/31863647868)
passed the complete S1.5d source-only gate, including all 605 inert-candidate
checks. It did not build or load this candidate.

Keep all expensive and mutating work off the development PC:

1. On an ephemeral Windows build job, fetch the upstream source at the exact
   commit and run the baseline, API/source-disposition, profile-manifest,
   raw-input, raw-feedback, and inert-candidate source verifiers. GitHub's hosted Windows token is not a
   security boundary, so the upstream project, targets and payloads are never
   executed. No release DLL is an input to these checks. The separately
   authorized, source-frozen S1.5e observation will copy only the frozen
   allowlist into a fixed, quiescent staging tree, verify it before and after
   the build, and compile the runtime-only assembly with pinned .NET 10.0.400
   without loading or executing it.
2. Extend the existing non-executing PE/metadata reader for the candidate. Require
   assembly version 1.6.1.0, the exact profile catalog, the small runtime API,
   no forbidden type/member names, and no resource outside the profile catalog.
   Extend the gate to inspect MemberRefs/P/Invoke targets so source units cannot
   hide driver-store, certificate-store, process-launch, download or global-
   sweep capability behind renamed methods.
3. Build HID and host artifacts in separate jobs. Generate catalogs from a
   fixed quiescent tree whose identities are checked before and after use, then
   sign outside the runtime build. Never put WDK
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
  `SignTool verify /v /pa /c CatalogFileName.cat DriverFileName` form in its [catalog-member
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

From a clean checkout of the exact upstream source, the supported operations
in this checkpoint are static source-byte and project-XML audits:

```powershell
./tools/hidmaestro-runtime-candidate/test-source-contract.ps1 `
  -SourceRoot C:\path\to\HIDMaestro-v1.6.1
```

It hashes and reads text only. It does not compile, load the SDK, launch a
helper, elevate, install, sign, create a controller or touch hardware.

The candidate-tree verifier is likewise non-executing:

```powershell
./tools/hidmaestro-runtime-candidate/s1_5d/verify-source-candidate.ps1
```
