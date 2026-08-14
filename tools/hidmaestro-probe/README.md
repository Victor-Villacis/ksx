# HIDMaestro SDK conformance probe

This source-only tool answers one bounded question: does the official,
hash-pinned HIDMaestro v1.6.1 SDK contain the catalog and read API shape KSX is
planning against?

The default command is read-only. It hashes `HIDMaestro.Core.dll` before
loading it, inventories every embedded profile JSON, checks the public catalog
surface, and pins the `dualsense`, `switch-pro`, and `xbox-series-xs-bt`
properties KSX depends on. It writes exactly one JSON document to stdout.

## Safety boundary

This probe deliberately has no install, create-device, cleanup, or live-input
command. It never constructs `HMContext`; v1.6.1 does background payload
extraction from that constructor. More importantly, its elevated lifecycle path
may reuse same-length-validated helper executables in a shared `%TEMP%`
location. A live conformance run is deferred until that trust boundary is fixed
upstream or KSX uses a reviewed patched SDK.

`test-safety.ps1` scans every C# source before compilation and rejects SDK
driver lifecycle calls or context construction. The check is intentionally
also wired into the project build.

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
& $dotnet './bin/Release/net10.0-windows10.0.26100.0/win-x64/ksx-hidmaestro-probe.dll' self-test
```

The build fails before compilation when the external DLL hash differs from
the v1.6.1 pin. `bin/`, `obj/`, archives, executables, and DLLs are ignored
locally as a second guard against vendoring upstream binaries.
