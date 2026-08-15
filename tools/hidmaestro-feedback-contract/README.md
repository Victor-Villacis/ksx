# HIDMaestro S1.5c DualSense raw-feedback contract

This directory freezes the source facts and conservative reduction policy for
the first plain-USB DualSense feedback adapter. It is an inert, dependency-free
test crate. It does not load HIDMaestro, open a driver or shared section, create
a controller, elevate, touch hardware, or authorize product enablement.

## Result of the source audit

For pinned HIDMaestro v1.6.1 commit
`2a0dac0857901a63d365a36dcf99cf50114ca954`, the only accepted envelope is:

| Coordinate | Exact value |
| --- | --- |
| `HMOutputPacket.Source` | `HidOutput` (`0`) |
| `HMOutputPacket.ReportId` | `0x02` |
| `HMOutputPacket.Data.Length` | `47` |
| `Data[0]` | `validFlag0` |
| `Data[1]` | `validFlag1` |
| `Data[2]` | right/small motor |
| `Data[3]` | left/large motor |
| `Data[38]` | `validFlag2` |

The 48-byte HID write is report ID plus 47 payload bytes. HIDMaestro's driver
removes the first byte before publishing the output-ring slot. The managed
reader passes that slot through `OutputReceived` as separate `ReportId` and
`Data` values. It prepends the report ID again only for the generic profile
codec behind `OutputDecoded`.

That makes ID-included indexing incorrect at the raw event boundary. In
particular, reading raw `Data[1]` as `validFlag0` or raw `Data[3]` as the right
motor is an off-by-one defect. `golden-vectors.tsv` includes a counterexample
that would expose that mistake.

The pinned profile names the common output fields but does not assign meanings
to the bits inside the validity bytes. The numeric meanings are cross-checked
against Sony's open Linux `hid-playstation` implementation:

- `validFlag0 & 0x01`: compatible-vibration motor bytes;
- `validFlag0 & 0x02`: select classic rumble instead of audio haptics; and
- `validFlag2 & 0x04`: newer compatible-vibration-v2 motor bytes.

Linux emits the selector together with exactly one motor-validity variant and
writes both motor bytes atomically, including a pair of zero bytes for stop.
SDL provides two additional producer vectors: a selector-only start packet and
an exactly all-zero effect payload when restoring audio haptics after rumble.
Those references are commit- and hash-pinned in `source.lock.json`; no external
source is copied, linked, or executed here.

## Reduction policy

The decoder emits a complete effective two-motor snapshot for every
structurally accepted packet. This matters because the host's outbound queue is
bounded/latest-wins: a lightbar-only packet must carry forward the effective
motor values, not manufacture zeroes that stop rumble and not omit state that a
later consumer could misinterpret.

- A source-proven legacy or v2 flag combination replaces both motors. Two
  valid zeroes are an explicit stop.
- An exactly all-zero 47-byte SDL restore payload also stops both motors.
- A lightbar/audio/trigger-only packet preserves the prior motors.
- Selector-only, motor-validity-without-selector, and legacy-plus-v2 packets
  preserve the prior motors and receive distinct dispositions. They are not
  silently promoted into invented hardware semantics.
- Wrong source, report ID, or exact length is rejected before reading fields.
- Zero magnitudes are data and are never filtered.

This policy is deliberately stricter than merely testing
`validFlag0 & 0x03 != 0`: that expression accepts two different partial states
as though both were a complete rumble update.

`HMController` reuses one 256-byte managed buffer while draining the output
ring. `HMOutputPacket.Data` therefore remains valid for synchronous callback
handling but must not be retained across callbacks. The pure reducer borrows it
only for the call and stores copied scalar values.

## What the harness proves

`src/lib.rs` compiles the product's canonical dependency-free reducer directly
from `crates/ksx-hidmaestro/src/dualsense_feedback.rs`; it does not carry a
second implementation that can drift. Together with the 16 rows in
`golden-vectors.tsv`, the harness proves without an SDK reference:

- separate report-ID/data coordinates and the exact 47-byte payload boundary;
- exact source, report ID, flags, and motor offsets;
- legacy and v2 nonzero updates;
- valid-zero and SDL all-zero stop paths;
- lightbar-only preservation;
- every partial/conflicting validity case in the policy;
- structural rejection; and
- owned, complete snapshots even after the callback buffer is overwritten.

The crate is outside the workspace and has automatic binary, example,
integration-test, benchmark, and build-script target discovery disabled. The
intended CI commands are:

```text
cargo fmt --manifest-path tools/hidmaestro-feedback-contract/Cargo.toml -- --check
cargo clippy --manifest-path tools/hidmaestro-feedback-contract/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path tools/hidmaestro-feedback-contract/Cargo.toml --locked
```

`test-source-contract.ps1` separately validates the pinned Git blobs, external
reference hashes, and the source statements from which the constants were
derived. It performs static reads only.

## Still unproved

This is not a benchmark and no latency, jitter, throughput, or CPU claim is
made. It does not prove installed signed-driver/source equivalence, SDK/runtime
containment, Windows game compatibility, packet behavior on physical
DualSense firmware, or safe forwarding to a physical pad. It does not decode
adaptive triggers, lightbar, audio, feature reports, Bluetooth framing, or CRC.

HIDMaestro's output ring can overwrite old entries when the reader is more than
64 writes behind. Full post-decode snapshots make later queue loss safe; they
cannot reconstruct an update already lost before `OutputReceived`. The future
host must feed every callback to this reducer and monitor `SeqNo` for gaps.
Hardware/capture conformance remains a separate disposable-machine gate.
