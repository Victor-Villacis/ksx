# HIDMaestro v1.6.1 DualSense USB input contract

This directory freezes the source-derived `HMController.SubmitState` input report for the pinned HIDMaestro `dualsense` USB profile. The source-only verdict is **GO**: every byte and bit used by the bounded `Axes` + `Buttons` + `Hat` state surface is settled. Runtime, artifact, driver, device, and distribution verdicts remain **NO-GO**.

The most important distinction is that `profiles/sony/dualsense.json` contains an `extendedReport` block, but the USB profile has neither `armOn` nor `alwaysArmed`. Pinned `HMController` therefore never selects `VendorBlobCodec.EncodeInput` for `SubmitState`; it selects the descriptor-driven `HidReportBuilder.BuildReportInto` path. Consequently:

- byte 7 is zero, not a rolling sequence counter;
- normalized stick center `0.5f` becomes `0x7F` through truncation, not `0x80` through extended-codec rounding;
- vendor/touch/IMU/status bytes remain zero on this bounded path;
- every call clears and rebuilds the complete report, with no prior-frame latch.

## Exact wire coordinates

The canonical candidate encoder produces a 64-byte full wire report:

| Wire byte | Meaning |
| --- | --- |
| 0 | Report ID `0x01` |
| 1 | `HMAxis.X` / left stick X, unsigned `0..255` |
| 2 | `HMAxis.Y` / left stick Y, unsigned `0..255` |
| 3 | `HMAxis.Z` / right stick X, unsigned `0..255` |
| 4 | `HMAxis.Rz` / right stick Y, unsigned `0..255` |
| 5 | `HMAxis.Rx` / left trigger, unsigned `0..255` |
| 6 | `HMAxis.Ry` / right trigger, unsigned `0..255` |
| 7 | Descriptor vendor field `FF00:0020`; zero on the active generic path |
| 8 bits 0–3 | Hat: `None=8`, directions `North..NorthWest=0..7` |
| 8 bits 4–7 | `X`, `A/Cross`, `B/Circle`, `Y/Triangle` |
| 9 bits 0–7 | LB, RB, derived digital LT, derived digital RT, Back, Start, left thumb, right thumb |
| 10 bits 0–2 | Guide, Touchpad, Misc1/mic mute |
| 10 bits 3–7, 11, 12–63 | Zero on this bounded generic path |

Finite axis input is first stored as `System.Single`, clamped to `[0,1]`, then encoded as `truncate((double)value * 255)`. Missing keys encode as `0.0` because all six descriptor axes are unsigned. A positive trigger engages its digital bit even when its analog value is too small to survive truncation.

## Full wire versus shared-memory payload

The upstream builder's report is 64 bytes including report ID. Upstream `HMController` strips byte 0 and publishes exactly 63 bytes to the legacy shared `Data` field. The driver zero-fills 64 bytes, prepends `FirstInputReportId = 1`, and copies those 63 bytes at offset 1.

An endpoint that accepts the candidate's 64-byte full-wire report must therefore strip byte 0 before publishing legacy shared input. Publishing all 64 bytes would shift the report and lose the final byte when the driver caps the payload to 63.

## Files

- `source-lock.json` pins the v1.6.1 commit and every authoritative or path-closing Git blob.
- `contract.json` is the machine-readable byte, bit, scaling, default, and coordinate contract.
- `golden-vectors.json` covers all axes, all hat positions, every carried button and alias, every deliberately dropped button, trigger derivation, clamping/truncation, and reused-buffer clearing.
- `verify-source-contract.ps1` is dependency-free Windows PowerShell 5.1-compatible static verification. It invokes only local Git object-reading commands with `--no-replace-objects`; it never executes upstream code or starts a build/helper/device process, loads a driver, provisions a device, elevates, creates a temporary file, or accesses the network. Git is resolved from the caller's `PATH`, and caller/system/repository Git configuration is explicitly inherited but never mutated.

## Actions-only acceptance

Clone or fetch HIDMaestro so commit `2a0dac0857901a63d365a36dcf99cf50114ca954` exists locally, then run on a Windows runner:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File tools/hidmaestro-input-contract/verify-source-contract.ps1 `
  -HidMaestroRoot $env:HIDMAESTRO_SOURCE_ROOT
```

Acceptance is limited to the verifier's single compact JSON result with `ok=true`, `sourceVerdict="GO"`, and `runtimeVerdict="NO-GO"`. It must not be reported as a compiled artifact, runtime ABI binding, loaded-driver result, real-device result, or distribution readiness.
