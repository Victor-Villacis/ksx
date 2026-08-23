# Panel programming — living state

**This file records state, not aspiration.**
[`ENHANCEMENTS.md`](ENHANCEMENTS.md) E10 is the product plan. Where that plan,
an older research note, a comment or a conversation disagrees with this file's
evidence register, correct or annotate the stale claim before relying on it.

**Current status — 2026-08-22 21:22 EDT: READ-ONLY DISCOVERY COMMITTED AND
FULL LOCAL GATE GREEN; CLEAN-RUNNER CI PENDING.** The CLI and
Control Surface Builder can identify and passively inspect a selected encoder.
No chart-read, backup, restore or programming capability is implemented. The
v1 boundary sends no input/feature/output report and changes no driver binding
or persistent board state.

## How to read a claim

Every implementation-relevant factual claim carries one of these tags. A
source observation cannot stand in for a cabinet measurement.

| Tag | Meaning |
|---|---|
| `[MEASURED yyyy-mm-dd hh:mm EDT]` | Observed in this worktree or on named hardware; the reproducing command is recorded. |
| `[SOURCE path:line or pinned URL]` | Derived from a specific source. It describes that source, not necessarily the target cabinet. |
| `[UNVERIFIED scope]` | A hypothesis, vendor-general statement or open question that still needs the named proof. |

Rules:

1. Never restate an `UNVERIFIED` claim as a working capability.
2. Never use an open-source writer to assert Windows API semantics or target
   firmware behavior it did not exercise.
3. “Status,” “chart read” and “write” are three separate capabilities. Success
   at one does not imply the next.
4. Hardware persistence requires supervised evidence even when no elevation or
   driver rebind appears necessary.

## Product boundary

`[SOURCE docs/ENHANCEMENTS.md E10]` Keyboard mode is the default I-PAC source
substrate. The encoder chart is persistent source configuration; ksx owns
dynamic transforms and virtual-controller output.

`[SOURCE docs/ENHANCEMENTS.md E10]` I-PAC XInput mode is an optional hardware
bypass and diagnostic case, not the default and not a v1 source routed back
through ksx.

`[SOURCE docs/SURFACES.md]` Delivery order is backend contract, thin CLI, then
the human-facing Studio surface.

## Capability state

| Capability | State | Evidence / gate |
|---|---|---|
| Identify a panel USB parent and enumerate interfaces | **implemented — read-only v1** | `[MEASURED 2026-08-22 21:13 EDT]` `.\target\debug\ksx.exe panel status --device 'USB\VID_D209&PID_0430\4' --json` exited 0 and grouped three USB interfaces plus six joined HID collections under one physical board. |
| Stable `ksx panel status --json` output | **implemented — read-only v1** | `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-backend panel::tests::` passed 7/7 and `cargo test -p ksx-app panel_status_parses_selector_json_and_has_no_consent_flag` passed 1/1. |
| Report mode or firmware | **topology only; exact values unsupported** | `[MEASURED 2026-08-22 21:13 EDT]` The live command above returned `keyboard-compatible`, explicitly said exact vendor mode was not queried, and reported raw `bcdDevice 0x0056` without calling it firmware. |
| Explain I-PAC XInput recovery | **planned diagnostic** | `[SOURCE Ultimarc I-PAC4 page]` Must be scoped to a recognized model/firmware. |
| Read the complete encoder chart | **not implemented / protocol unverified** | `[UNVERIFIED target firmware]` Vendor tooling documents reads, but no target read transaction is pinned here. |
| Back up or round-trip a chart | **blocked on complete read** | `[SOURCE docs/ENHANCEMENTS.md E10]` Partial key-only data is not a backup. |
| Restore or program a chart | **blocked on readback and recovery** | `[SOURCE docs/ENHANCEMENTS.md E10]` Persistent writes require dry-run, explicit `--yes` and supervised evidence. |
| Studio selected-encoder inspection | **implemented — read-only v1** | `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-studio --test http panel_status_` passed all 4 focused endpoint tests. `[SOURCE studio-ui/src/NocturneIsland.ts]` The card exposes Refresh/Retry and a collapsed evidence disclosure, with no programming control. |
| Studio chart/program editor | **not started** | `[SOURCE docs/ENHANCEMENTS.md E10]` It remains blocked on a verified complete read/backup contract. |
| Non-Ultimarc encoder families | **generic metadata only** | `[SOURCE crates/ksx-backend/src/panel.rs]` Unknown boards remain visible as unsupported; family-specific protocols are not inferred. |

## Source register

### What the current ksx code proves

`[SOURCE crates/ksx-core/src/device.rs:72]` `KeyEvent` contains both a
`DeviceId` and a `Key`.

`[SOURCE crates/ksx-core/src/engine.rs:1939-1940]` Held-key state is per device; the
same key on device A is distinct from that key on device B.

`[SOURCE crates/ksx-core/src/slot.rs:20]` The 16-slot ceiling explicitly
budgets four I-PAC4 boards driving four players each. A global pool of unique
keyboard usages is not the slot-count mechanism.

`[SOURCE crates/ksx-capture/src/hid/usage.rs:22,109-110,239,357]` The WinUSB
HID usage translator has 106 mapped usages and 105 distinct set-1 results;
usages without a set-1 equivalent, including F13–F24, intentionally emit no
event.

`[SOURCE crates/ksx-capture/src/winusb/enumerate.rs:212]` The current keyboard
capture candidate test accepts HID-class interfaces. This describes the
keyboard capture lane, not every USB device a future panel inventory could
discover.

`[SOURCE crates/ksx-capture/src/winusb/mod.rs:3,63]` The current I-PAC WinUSB
capture path is scoped to the keyboard interface represented as MI_00 in its
device path examples. It does not implement a configuration-interface client.

`[SOURCE crates/ksx-platform/src/hid.rs]` The passive collection survey opens
metadata handles with desired access zero and imports no input, output, feature
or generic transfer primitive. A source-policy test pins that boundary.

`[SOURCE crates/ksx-backend/src/panel.rs]` The backend groups interfaces by
physical USB parent, resolves exact and stable selectors without choosing an
ambiguous twin, preserves partial/failed reads as unavailable, and composes the
copy every surface renders.

`[SOURCE crates/ksx-studio/src/server/nocturne.rs;
studio-ui/src/NocturneIsland.ts]` Studio reads the daemon-held staged selector
on demand. The ordinary two-second canvas poll does not perform HID inspection,
and the browser has no panel-status write route.

### What pinned external sources prove

`[SOURCE https://www.ultimarc.com/control-interfaces/i-pacs/i-pac4-board/ as
read 2026-08-22]` Ultimarc documents persistent I-PAC4 keyboard programming,
vendor-tool configuration reads/writes, quad gamepad modes on applicable
firmware, mode-switch controls and restrictions while I-PAC4/Mini-PAC4 is in
quad XInput mode. These statements are model/firmware scoped.

`[SOURCE https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/common.h]`
The pinned implementation defines USB request type `0x21` and request `9`.

`[SOURCE https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipacseries.h]`
The pinned implementation defines value `0x0203`, five-byte messages, a
260-byte configuration image and generation-specific configuration-interface
constants.

`[SOURCE https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipac.c]`
The pinned implementation constructs and sends a complete configuration image
for supported I-PAC-series models. It is write-path evidence only.

### Cabinet evidence and remaining unknowns

`[MEASURED 2026-08-22 21:13 EDT]` The live command recorded in the work log
enumerated the connected board as Ultimarc
I-PAC 4X, VID/PID `d209:0430`, serial `4`, raw `bcdDevice 0x0056`, with MI_00,
MI_01 and MI_02 plus six joined HID collections. MI_00 exposed 33-byte input /
2-byte output reports; one MI_02 collection exposed 5-byte input/output reports
and another exposed 97-byte input/output reports. These are descriptor facts,
not protocol or firmware claims.

`[UNVERIFIED target cabinet]` Exact firmware revision and exact vendor mode.
The observed boot-keyboard interface proves keyboard-compatible input is
present; it does not prove the vendor's current mode enum.

`[UNVERIFIED target cabinet]` Whether the relevant configuration collection is
MI_02, MI_03 or another interface for the installed board generation.

`[UNVERIFIED Windows API + target firmware]` Whether the configuration
collection can be opened without elevation while MI_00 is WinUSB-claimed, and
whether a valid `HidD_SetOutputReport` succeeds. Reading HID caps while sending
nothing cannot settle the second question.

`[UNVERIFIED target firmware]` Complete chart read protocol and whether it
round-trips shift assignments, EEPROM macros and every unknown byte.

`[UNVERIFIED target firmware]` Atomicity, buffering, checksum, rollback,
post-write verification and re-enumeration behavior. Sequential host transfers
do not prove partially persisted board state.

`[UNVERIFIED target cabinet]` Simultaneous-key behavior. A report descriptor
describes report capacity; physical multi-switch tests must still establish
rollover and `ErrorRollOver` behavior.

`[UNVERIFIED target cabinet]` What current ksx session/status surfaces report
when a panel hotkey changes USB mode during a running session.

## Safety invariants

`[SOURCE docs/PLAYBOOK.md]` A driver binding is supervised and never an
incidental side effect. Panel status does not claim or release any interface.

`[SOURCE docs/ENHANCEMENTS.md E10]` V1 discovery sends no feature/output report
and accepts no `--yes` switch.

`[SOURCE docs/ENHANCEMENTS.md E10]` A future write is forbidden unless ksx can
read, losslessly represent and back up the complete existing configuration.

`[SOURCE docs/ENHANCEMENTS.md E10]` A future write is a pure plan/diff by
default, requires explicit `--yes`, verifies readback and returns a specific
recovery state on failure.

`[SOURCE docs/ENHANCEMENTS.md E10]` Shift assignments, macros and unknown bytes
are preserved. “Rewrite known keys and zero the rest” is never an acceptable
implementation.

## V1 acceptance contract

The read-only discovery slice is complete only when all of these are true:

1. `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-backend
   panel::tests::` passed 7/7: synthetic composite fixtures group by physical
   identity, exact board IDs round-trip as selectors, ambiguous twins refuse,
   and unavailable/partial reads retain explicit states.
2. `[MEASURED 2026-08-22 21:17 EDT]` The same 7/7 backend run covered human and
   typed output for observed, unsupported, partial and unavailable states; the
   21:13 live JSON run parsed successfully and retained the unverified states.
3. `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-app
   panel_status_parses_selector_json_and_has_no_consent_flag` passed 1/1,
   proving `--json` is accepted and `--yes` is rejected by the CLI parser.
4. `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-platform hid::`
   passed 4/4, including access-zero and no-report source-policy tests;
   `cargo test -p ksx-studio --test http panel_status_` passed 4/4, including
   GET-only routing and no mutation-provider calls.
5. `[MEASURED 2026-08-22 21:21 EDT]` `cargo fmt --all -- --check`,
   `cargo clippy --workspace --exclude vigem-client --all-targets -- -D
   warnings`, the four no-feature/`studio`/`cabinet`/`studio,cabinet` clippy
   combinations for both `ksx-app` and `ksx-backend`, and `cargo test
   --workspace --exclude vigem-client` all exited 0. `[UNVERIFIED clean
   runner]` CI must still pass against the exact post-commit SHA; a local gate
   does not substitute for shipped-build evidence.
6. `[MEASURED 2026-08-22 21:13 EDT]` `.\target\debug\ksx.exe panel status
   --device 'USB\VID_D209&PID_0430\4' --json` exited 0 and returned the
   connected board's identity/caps, `chart_attempted=false`, exact vendor mode
   unqueried and a `candidate-unverified` collection. The panel-status call
   graph contains no report, rebind or persistent-write primitive.

Items 1–6 establish the local read-only discovery candidate. Clean-runner CI
remains the release gate. The live run accepts passive metadata discovery on
this cabinet only. None of these items proves chart access, report access or
firmware behavior.

## Corrections — do not resurrect

`[SOURCE crates/ksx-core/src/device.rs:72; crates/ksx-core/src/engine.rs:1939-1940]`
**Retracted:** “105 distinct keys means keyboard mode cannot reach 16 slots.”
Keys are device-qualified and reusable across encoders.

`[SOURCE crates/ksx-core/src/templates.rs:206-288]` **Retracted:** “The
`arcade-6button` template spends 12 keys per player.” The named template maps
four directions, eight buttons, start and coin: 14 unique keys per player.

`[SOURCE docs/ENHANCEMENTS.md E10]` **Retracted as policy:** “I-PAC XInput is
permanently out.” It is an optional bypass/diagnostic case; routing it back
through ksx is merely outside the current plan.

`[UNVERIFIED runtime]` **Retracted as fact:** “A guest mode switch makes every
slot `XinputBusFull` while the session remains healthy.” The behavior needs a
supervised mode-switch measurement.

`[SOURCE Ultimarc I-PAC4 page as read 2026-08-22]` **False:** “Firmware 1.57
adds NKRO.” The referenced firmware note describes an instant mode-switch
button, not an NKRO addition.

## Work log

| Time (ET) | Branch / baseline | Work | Evidence |
|---|---|---|---|
| 2026-08-22 20:24 EDT | `codex/control-surface-builder` / `6e519a1426ea` | Corrected E10 decision drafted; living-state register and doc-routing link added. No implementation or hardware action. | Documentation-only change; v1 software tests remain outstanding. |
| 2026-08-22 20:27 EDT | same uncommitted worktree | Focused documentation validation only. | `[MEASURED 2026-08-22 20:27 EDT]` `git diff --check` exit 0; `cargo test -p ksx-app --test docs` exit 0, 3 passed. These results do not claim v1 implementation or acceptance. |
| 2026-08-22 21:09 EDT | same uncommitted worktree | Typed backend/CLI, GET-only Studio endpoint and selected-encoder card assembled locally. | `[SOURCE crates/ksx-backend/src/panel.rs; crates/ksx-platform/src/hid.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/NocturneIsland.ts]` Focused reproducible validation is recorded in the 21:17 row; no “no remaining issues” claim is made. |
| 2026-08-22 21:13 EDT | same uncommitted worktree | Re-ran the access-zero status verb against the selected physical I-PAC; no report transaction. | `[MEASURED 2026-08-22 21:13 EDT]` `.\target\debug\ksx.exe panel status --device 'USB\VID_D209&PID_0430\4' --json` exited 0: raw `0x0056`, three interfaces, six HID collections, keyboard-compatible topology with exact mode unqueried, one unverified 5-byte candidate and `chart_attempted=false`. |
| 2026-08-22 21:17 EDT | same uncommitted worktree | Re-ran the focused discovery safety and contract tests. | `[MEASURED 2026-08-22 21:17 EDT]` `cargo test -p ksx-backend panel::tests::` 7/7; `cargo test -p ksx-platform hid::` 4/4; `cargo test -p ksx-app panel_status_parses_selector_json_and_has_no_consent_flag` 1/1; `cargo test -p ksx-studio --test http panel_status_` 4/4. All exited 0. Full gate and clean-runner CI remain pending. |
| 2026-08-22 21:19 EDT | same uncommitted worktree | Corrected roadmap/state overclaims, deferred capability wording and evidence references. | `[MEASURED 2026-08-22 21:19 EDT]` `git diff --check` exit 0; `rg -n "[ \\t]+$" docs/ENHANCEMENTS.md docs/PANEL-PROGRAMMING-STATE.md` returned no match; `cargo test -p ksx-app --test docs` passed 3/3. |
| 2026-08-22 21:21 EDT | same uncommitted worktree | Classified the two canvas-local inspector-tab slots exposed by the full seam gate, then ran the repository-wide acceptance matrix. | `[MEASURED 2026-08-22 21:21 EDT]` Focused seam test passed; `cargo fmt --all -- --check`, workspace clippy, both crates' four feature combinations and `cargo test --workspace --exclude vigem-client` all exited 0. One pre-existing timing test first missed its own channel-backlog precondition; its exact rerun and the complete workspace rerun both passed. |
| 2026-08-22 21:22 EDT | `codex/control-surface-builder` / `50a3239fe7f6` | Committed the read-only discovery candidate, Studio inspection card, generated assets, tests and governing docs. | `[MEASURED 2026-08-22 21:22 EDT]` `git rev-parse HEAD` returned `50a3239fe7f6f6946ed20390a95e34fa490b38c8`; clean-runner CI remains pending and no shipped-binary claim is made. |

## Current pickup

`[MEASURED 2026-08-22 20:24 EDT]` `git branch --show-current` returned
`codex/control-surface-builder`; `git rev-parse --short=12 HEAD` returned the
baseline `6e519a1426ea`.

`[MEASURED 2026-08-22 21:22 EDT]` Final read-only discovery implementation
candidate SHA: `50a3239fe7f6f6946ed20390a95e34fa490b38c8`.

`[SOURCE this file, V1 acceptance contract]` Next protocol pickup is evidence
for a complete, non-mutating chart read and lossless backup representation.
Do not add an output report or writer in that slice. The separate operational
pickup is clean-runner CI for the exact committed v1 candidate.
