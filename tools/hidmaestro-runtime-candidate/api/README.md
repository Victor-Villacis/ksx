# HIDMaestro S1.5c runtime API/source contract

This directory closes two design ambiguities for the one-DualSense,
raw-feedback managed-host experiment without building or loading HIDMaestro:

1. `public-api.contract.json` is the exact public target surface. It contains
   nine HIDMaestro types and 100 logical declared entries, including every enum
   literal and every HIDMaestro type reached through a signature. Any public
   type or member outside that allowlist is a future artifact-gate failure.
2. `source-compilation.contract.json` classifies all 51 `.cs`/`.csproj` units
   in the pinned `sdk/HIDMaestro.Core` tree exactly once. Only
   `HMOutputPacket.cs` (which also declares `HMOutputSource`) may be retained
   byte-for-byte. Thirteen upstream units require narrowed replacements and 37
   are excluded.

S1.5d now supplies every planned replacement and required new source unit in a
separately hash-frozen inert candidate. Its project names exactly 11 compile
inputs and 228 resources, and the S1.5d/API source verifiers build and load
nothing. The exact S1.5e observation infrastructure is now source-frozen. Its
GitHub Actions build is authorized but the observation is not established; its
artifact-built and metadata-match facts remain false. Source-verifier, local and product build authorization remain
false, as do every load and execution authorization. Source/project closure is
not evidence of compiled metadata or behavior, and all six artifact, driver
and distribution gates remain false.

## Exact public closure

The candidate surface is:

- `HMContext`: constructor, default-profile load, exact lookup, create, dispose;
- `HMController`: profile getter, raw `OutputReceived` event,
  `SubmitState(in HMGamepadState)`, dispose;
- `HMProfile`: `Id`, `Name`, `VendorId`, `ProductId` getters;
- `HMGamepadState`: mutable `Axes`, `Buttons`, and `Hat` fields;
- complete upstream `HMAxis`, `HMButton`, and `HMHat` numeric declarations;
- unchanged `HMOutputPacket` fields/constructor and `HMOutputSource` values.

The closure deliberately excludes the upstream gamepad-state helper, extended
touch/IMU/battery state, profile layout graph, decoded output, PID, builders,
USB audio/IP, VR, extraction, install, repair, and global-cleanup surfaces.
Those omissions require source replacements; they cannot be achieved by
copying the upstream public DTO files unchanged.

The enum values are operational, not cosmetic. The pinned API defines
`HMButton.Back = 1 << 6`, `Start = 1 << 7`, `LeftStick = 1 << 8`, and so on;
there are no trigger-button bits. It defines `HMHat.None = 0`, `North = 1`,
through `NorthWest = 8`. The verifier derives every enum value from the pinned
C# declarations with a deliberately limited expression parser and then checks
the KSX Rust source for exact declaration anchors carrying those values. That
consumer check is textual rather than a semantic Rust parse; the verifier never
compiles or executes the upstream SDK.

## Source disposition

The single unchanged compilation input is safe to name precisely because its
entire CRLF checkout byte sequence is pinned. The replacement groups cover:

- the explicit no-glob project;
- the four narrowed public owner/DTO units;
- a full 228-profile immutable catalog, while the S2 create guard accepts only
  the exact DualSense profile;
- exact-instance PnP creation/removal with transactional rollback;
- a fixed 64-byte DualSense USB input encoder;
- one-controller owned shared-memory handles and bounded raw output; and
- the new raw DualSense feedback adapter.

The last adapter has no direct upstream source unit, so it appears under
`requiredNewUnits`. Its source and every replacement byte are now frozen by the
S1.5d candidate verifier. A later checkpoint must build in isolated Actions,
prove dependency closure, and switch the compile gate only after static
metadata inspection of the resulting assembly.

## Static verification

Use a Windows checkout of exact commit
`2a0dac0857901a63d365a36dcf99cf50114ca954` made with
`core.autocrlf=true`:

```powershell
./tools/hidmaestro-runtime-candidate/api/test-api-contract.ps1 `
  -SourceRoot C:\path\to\HIDMaestro-v1.6.1
```

The verifier performs only text, Git-tree, and SHA-256 reads. It checks:

- canonical hashes of the aggregate candidate, profile manifest, and two API
  machine-readable contracts;
- exact S1.5c artifact identity and full 228/130 resource-policy agreement
  across the aggregate, API/source-disposition, and profile contracts;
- the pinned commit and CRLF bytes of all 51 upstream units plus the profile,
  license, and version-provenance files;
- exhaustive, duplicate-free retained/replacement/excluded classification;
- all 9 types, all 100 entries, source declaration anchors, and transitive
  HIDMaestro type closure;
- enum names/order/numeric values parsed from the pinned source; and
- the corresponding KSX Rust axis/button/hat constants, including absence of
  invented trigger bits.

`contract.lock.json` freezes the four contract hashes and the exact 352-check
verifier topology, so adding or removing an assurance requires an explicit
lock update.

A pass proves only those static facts. Replacement sources now exist under the
separate S1.5d gate, but this verifier still does not prove compilation, API
metadata of a built artifact, input encoding, raw feedback, device ownership,
shared-memory behavior, driver ABI, signing, installation, cleanup, latency,
or operation against hardware.
