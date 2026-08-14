# HIDMaestro SDK conformance probe

This source-only tool answers one bounded question: does the official,
hash-pinned HIDMaestro v1.6.1 SDK contain the catalog and read API shape KSX is
planning against?

The default command is read-only. It hashes `HIDMaestro.Core.dll` before
loading it, inventories every embedded profile JSON, checks the public catalog
surface, and pins the `dualsense`, `switch-pro`, and `xbox-series-xs-bt`
properties KSX depends on. It writes exactly one JSON document to stdout.

The same executable also carries a pure, nonprivileged simulation of the
future KSX-to-host data boundary. `protocol` describes the exact
`ksx.hidmaestro.host.v1` (`KSXH`) little-endian envelope from
`crates/ksx-hidmaestro/src/host.rs`: a 16-byte header, one of twelve bounded
typed payloads, and a 528-byte maximum frame. C# pins all twelve Rust golden
frames byte-for-byte, plus the standalone Submit boundary vector.
`simulate-protocol` runs a deterministic transcript: initial/changed complete
state crosses the wire, while the privileged host republishes its cached state
to the SDK every 16 ms with no wire request. The ordinary client sends an
unchanged complete-state lease heartbeat once per second; five seconds without
Submit neutralizes, destroys, and tombstones only that controller while the
conversation remains usable. The model also enforces a lifetime budget of 16
controller identities per conversation and converts partial SDK callbacks into
full effective motor/LED snapshots before one copied, conversation-global,
64-entry feedback queue may drop oldest. This is frozen for in-memory
conformance tests, not approved as
production IPC: authentication, ACLs, ownership, callback synchronization and
the OS transport remain deliberately unspecified.

## Safety boundary

This probe deliberately has no install, create-device, cleanup, or live-input
command. It never constructs `HMContext`; v1.6.1 performs background payload
work from that constructor. Its elevated helper-staging boundary is under
coordinated security review, so a live conformance run is deferred until that
boundary is fixed upstream or KSX uses a reviewed hardened SDK.

`test-safety.ps1` scans every C# source before compilation and rejects SDK
driver lifecycle calls or context construction. The check is intentionally
also wired into the project build.

## Structural distribution-candidate audit

`distribution-candidate <directory>` statically audits a proposed sanitized
package tree. It reads bytes with `PEReader`, hashes every fixed file, parses the
two INFs and inspects signatures without loading an assembly, starting a
payload, elevating, installing, signing or changing trust. It emits exactly one
JSON document, labels its assurance `structural-only-quiescent-tree`, and exits
nonzero when any check fails.

The candidate root must contain `ksx-hidmaestro-distribution.json` plus exactly
the ten fixed paths named by `DistributionPolicy.ExpectedFiles`. The manifest
pins every file by role, path and SHA-256, the v1.6.1 tag/commit, and one
manifest-pinned `DriverVer`. Reparse points, unexpected files, embedded WDK,
driver/helper/USB-IP/VR managed-resource names, known provisioning symbols and
a profile-catalog mismatch all fail closed.

This command is currently an **unsigned structural gate**, not a release
attestation or a semantic code-safety review. A candidate with
`candidateState: "unsigned-build"` can prove only the declared tree, byte
hashes, managed-resource catalog and allow/denylisted metadata names. Renamed or
arbitrary executable behavior is outside this audit and the candidate must not
be executed merely because `ok` is true. `candidateState:
"distribution-ready"` is intentionally rejected even
when every inspected file has a trusted signature: KSX has not yet pinned its
release signer identity or implemented catalog-member verification for each
INF/DLL. Online revocation, clean-VM installation and signed installer evidence
also remain release gates. The official v1.6.1 package is expected to fail the
structural audit; the command specifies the runtime-only sanitized package KSX
needs rather than approving the upstream release unchanged.

The caller must provide a quiescent build tree. This slice does not hold stable
handles to the entire tree or atomically bind signature, hash and parser reads,
so another process swapping files during inspection is outside its assurance.
S1.5b must audit an immutable snapshot or stable file identities before the
result can participate in release authorization.

## Pinned upstream input

- Repository: <https://github.com/hifihedgehog/HIDMaestro>
- Tag: `v1.6.1`
- Tag commit: `2a0dac0857901a63d365a36dcf99cf50114ca954`
- Release asset: `HIDMaestro-v1.6.1.zip`
- Release ZIP SHA-256: `00145C23D9838BE6089389CE58B3FD2B6766FA9BC0F1F3C60A3C885361B53C34`
- `HIDMaestro.Core.dll` SHA-256: `ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5`

The binary and release archive are external inputs and must never be copied
into this directory or committed. The full machine-readable pin is
`sdk.lock.json`.

## Build and run

The release SDK supports Windows 10/11 x64 and targets .NET 10. Supply a .NET
10 SDK and the DLL extracted from the official release:

```powershell
$dotnet = 'C:\path\to\dotnet.exe'
$sdk = 'C:\path\to\extracted\HIDMaestro.Core.dll'
./build.ps1 -DotNet $dotnet -SdkDll $sdk

& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll'
& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll' protocol
& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll' simulate-protocol
& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll' distribution-candidate 'C:\path\to\candidate'
& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll' self-test
```

The build fails before compilation when the external DLL hash differs from
the v1.6.1 pin. `bin/`, `obj/`, archives, executables, and DLLs are ignored
locally as a second guard against vendoring upstream binaries.
