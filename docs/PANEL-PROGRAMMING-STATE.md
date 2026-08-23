# Panel programming — living state

**This file records state, not aspiration.**
[`ENHANCEMENTS.md`](ENHANCEMENTS.md) E10 is the product decision. Where that
plan, an older research note, a comment or a conversation disagrees with this
file's evidence register, correct or annotate the stale claim before relying
on it.

**Current status — 2026-08-23 03:03 EDT: END-TO-END PROGRAMMING
IMPLEMENTED AND INTEGRATION-VERIFIED; FIRST HARDWARE WRITE GATED.** The
worktree now contains the explicit Windows HID transport, complete-chart
read/backup, semantic plan, persistent program, full readback verification,
restore, CLI and Control Surface Builder flow for a supported I-PAC 4. The
transaction ordering and failure paths are covered with fake transports and
repositories, and the complete Rust, HTTP and browser integration suites pass.
No live chart query or output report was sent while building or testing this
slice. The only cabinet evidence remains the access-zero passive survey from
2026-08-22.

Do not describe the writer as hardware-proven until a user deliberately runs
the supervised reversible procedure in [First real-hardware gate](#first-real-hardware-gate).

## How to read a claim

Every implementation-relevant factual claim carries one of these tags. A
source observation cannot stand in for a cabinet measurement.

| Tag | Meaning |
|---|---|
| `[MEASURED yyyy-mm-dd hh:mm EDT]` | Observed in this worktree or on named hardware; the reproducing command is recorded. |
| `[SOURCE path:line or pinned URL]` | Derived from a specific source. It describes that source, not necessarily the target cabinet. |
| `[UNVERIFIED scope]` | A hypothesis, source-complete implementation or open question that still needs the named proof. |

Rules:

1. Never restate an `UNVERIFIED` claim as a working hardware capability.
2. “Status,” “chart read,” “backup,” “write,” “readback verify” and “physical
   signal verify” are separate capabilities. Success at one does not imply the
   next.
3. An open-source implementation can establish protocol facts. It cannot
   establish Windows behavior or the connected cabinet's firmware behavior.
4. Persistent hardware mutation requires a supervised, user-initiated action.

## Product boundary and user story

`[SOURCE docs/ENHANCEMENTS.md E10]` Keyboard mode is the preferred I-PAC
source substrate. The persistent board chart answers “what key does this
terminal emit?” KSX still owns the dynamic path:

```text
physical terminal → persistent I-PAC key → KSX transform/macro → virtual pad → game
```

The completed UX is intended to let a cabinet owner select the exact encoder,
read and back up its complete raw chart, choose either a deterministic
four-player chart or explicit terminal assignments, inspect the semantic and
byte diff, confirm one hash-bound transaction, read back every byte, then use
Teach to prove what the physical wiring actually emits. Restore is the same
reviewed and verified transaction in reverse.

I-PAC XInput mode remains an optional hardware bypass and diagnostic case. It
is not the default, and v1 does not route those XInput pads back through KSX.

## Capability state

| Capability | State at 2026-08-23 | Evidence / remaining gate |
|---|---|---|
| Identify a panel USB parent and enumerate interfaces | **implemented; live passive evidence** | `[MEASURED 2026-08-22 21:13 EDT]` `ksx panel status --device 'USB\VID_D209&PID_0430\4' --json` grouped three USB interfaces and six HID collections under one physical I-PAC 4X without report access. |
| Stable status copy / JSON | **implemented** | `[MEASURED 2026-08-22 21:17 EDT]` focused backend, CLI and Studio discovery tests passed. |
| Exact five-byte Windows HID transport | **implemented; synthetic only** | `[SOURCE crates/ksx-platform/src/hid_report.rs]` Exact path, rechecked VID/PID and caps, fixed `[u8; 5]` reports, bounded overlapped read and cancellation. `[UNVERIFIED target cabinet]` A live configuration handle and output report still require the supervised gate. |
| Complete chart read and decode | **implemented; synthetic only** | `[SOURCE crates/ksx-backend/src/panel_programming.rs]` Profile `ipac4-pac256-v1` requires exactly 64 report-03 frames/256 bytes and refuses any 65th frame through a full 750-ms boundary. `[UNVERIFIED target firmware]` The connected board has not returned this image. |
| Immutable lossless backup and list | **implemented; synthetic only** | `[SOURCE crates/ksx-backend/src/panel_programming.rs]` `ksx.panel-backup.v1` stores the complete raw image, SHA-256, identity and transport facts; every load revalidates them. |
| Semantic terminal edit / canonical chart | **implemented; synthetic only** | `[SOURCE crates/ksx-backend/src/panel_programming.rs]` Fifty-six I-PAC 4 terminals, normal/alternate/shift planes, supported HID usages and a deterministic collision-free four-player allocator. |
| Program / full readback verify | **implemented; hardware-unverified** | `[SOURCE crates/ksx-backend/src/panel_programming.rs; crates/ksx-backend/src/panel_programming/facade.rs]` Re-read → stale check → verified immutable backup → durable pre-packet journal → full write → complete reread → byte equality. An unresolved journal blocks replacement transactions. The first live write remains gated. |
| Restore / full readback verify | **implemented; hardware-unverified** | `[SOURCE crates/ksx-backend/src/panel_programming.rs]` Validates the selected backup, backs up current state, writes the target and verifies the full image. |
| Typed machine API and CLI | **implemented; integration-verified** | `[SOURCE crates/ksx-api/src/machine.rs; crates/ksx-app/src/main.rs]` Typed chart/backups/plan/apply/restore contracts, human/JSON parity and plan-first consent. Full API, app and backend suites plus warnings-denied clippy pass. |
| Studio editor | **implemented; synthetic HTTP/UI verified** | `[SOURCE crates/ksx-studio/src/server/mod.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/panelProgramming.ts; studio-ui/src/NocturneIsland.ts]` Selected-encoder authority, backup-first setup, reversible first-use qualification, review/confirm/verify/recovery flow and post-write Teach handoff. Full Studio HTTP and canvas browser suites pass. |
| Non-Ultimarc encoder families | **generic metadata only** | Unknown boards remain visible and refuse family-specific chart verbs. One universal writer is explicitly not inferred. |

## Exact implementation contract

### Explicit Windows report transport

`[SOURCE crates/ksx-platform/src/hid_report.rs]` The mutating transport is
separate from passive `hid.rs`. It:

- accepts one exact device path and never enumerates or guesses a replacement;
- opens read/write with overlapped I/O and exclusive sharing, then re-reads
  VID/PID and HID caps from that live handle so WinIPAC or another client cannot
  interleave reports;
- refuses unless both input and output report lengths are exactly five bytes;
- sends only a complete `[u8; 5]` through `HidD_SetOutputReport`. Because that
  Windows call is synchronous and has no cancellation API, each report runs in
  a hidden one-shot copy of the KSX executable. The parent duplicates the exact
  already-admitted exclusive HID handle plus a synchronization-only handle to
  the exact parent process into that retained child, sends one fixed 29-byte
  private-stdin request, waits at most two seconds, and terminates/reaps only
  that helper on timeout. A child watchdog waits the retained parent-process
  object—never a PID—and also terminates the helper if its parent disappears.
  The durable transaction journal remains unresolved so a timeout can never
  masquerade as “nothing changed”;
- receives only an exact five-byte overlapped `ReadFile` result within a
  caller-supplied deadline; and
- calls `CancelIoEx` on timeout. If Windows cannot prove the cancelled read
  drained within the bounded cleanup interval, it closes/poisons that device
  session and quarantines the pending allocation instead of risking a later
  kernel write into freed memory.

The passive status module still uses desired-access-zero metadata handles and
contains no report primitive.

### Chart framing and semantic ownership

`[SOURCE crates/ksx-backend/src/panel_programming.rs;
crates/ksx-backend/src/panel_programming/facade.rs]` The only writable v1
profile is `ipac4-pac256-v1`: VID/PID `D209:0430`, raw identity discriminator
`bcdDevice 0x0056`, MI_02, one unique error-free five-byte IN/OUT collection,
report ID `0x03`, and query `[03 59 DD 0F 00]`. A read must return exactly 64
frames carrying four payload bytes each, then no 65th frame for the complete
750-ms boundary. The resulting 256-byte image must begin `50 DD 0F`. Wrong
identity/topology, report IDs, frame lengths, timeouts, headers, or any 65th
frame refuse. Two independent close/reopen reads must also produce the same
SHA-256 before the image can authorize a plan or backup.

The raw image is authoritative. Semantic edits clone it and replace only the
addressed normal, alternate or shift byte for one of the 56 modeled terminals.
Opaque bytes and unedited layers survive byte-for-byte. Unknown terminals,
unsupported key usages and duplicate same-plane edits refuse.

The Recommended layout assigns 56 distinct normal-plane keys KSX can observe,
clears all 56 alternate assignments and disables all 56 shift roles. This
makes KSX the visible owner of macros and transformations while preserving
opaque macro/vendor bytes outside those three planes. Its normal keys use
letters, digits, selected punctuation and F1–F10; they deliberately avoid
Escape, Enter, Backspace, Tab, Space, navigation keys, modifiers and the two
HID usages that collapse to the same KSX key.

### Backup and transaction invariants

`[SOURCE crates/ksx-backend/src/panel_programming.rs]` A backup contains the
full raw image rather than only decoded terminal rows. The JSON schema records
image length/data/hash, creation reason, protocol profile, driver/schema,
VID/PID, `bcdDevice`, serial, board fingerprint, report ID, exact five-byte
framing and transport facts. The fingerprint includes the physical USB bus and
port chain; the low-entropy Ultimarc serial is recorded but cannot cause two
encoders to share backups. Moving an encoder intentionally changes its
fingerprint and requires a future supervised adoption flow. Board directory
and backup IDs are sanitized. Writes use a synced temporary file and
collision-safe immutable naming; Windows
finalization uses no-replace `MoveFileExW(MOVEFILE_WRITE_THROUGH)`. Loading
always rechecks the complete contract, 256-byte length, hex encoding, SHA-256
and board identity; corrupt or incompatible backups refuse visibly.

Production backup, qualification and transaction state is rooted under the
installed, per-Windows-account KSX configuration directory's
`panel-backups` folder. A portable/custom profile root cannot relocate or hide
this hardware-recovery authority. Test seams may inject a temporary root, but
production callers converge on the installed location.

Before packet zero, apply persists a hash-bound transaction journal containing
the exact board/profile, operation, base/desired images, safety backup and any
first-use qualification intent. A crash, timeout or unverifiable outcome leaves
that journal unresolved. New programming refuses until a fresh complete reread
reconciles it or the exact named restore completes; completion receipts are
immutable. A machine-wide cross-process lease is shared by maintenance and
every Play startup transition so neither can cross the other's packet-zero
boundary, including from a second Windows logon session.

Play/start also scans that fixed recovery root while holding the same lease.
Any pending transaction, unreadable/corrupt marker, inaccessible directory or
wrong-kind/reparse object at the backup, driver, board or marker level blocks
Play. KSX never follows a symlink or junction while deciding that persistent
hardware is settled; only a truly absent recovery root is clean.

Program apply has one immutable order:

1. Reread the complete current chart.
2. Compare it with the reviewed base SHA-256; refuse stale state.
3. Recompute the semantic plan from that fresh image.
4. If it is a no-op, return without a hardware write or backup.
5. Save the complete current image and reopen/verify that backup before packet
   zero.
6. Write the complete desired image.
7. Query and reread the complete image.
8. Compare every byte and return either `verified` or a failure carrying the
   backup ID and exact transaction phase/packet context.

Restore verifies the selected board-specific backup first, stale-checks the
current chart, saves and reopens another backup of the current state before
packet zero, writes the saved target, then performs the same complete reread
and equality check. Thus restore is itself reversible.

### CLI contract

`[SOURCE crates/ksx-app/src/main.rs]` The command family is:

```text
ksx panel status [--device QUERY] [--json]
ksx panel chart [--device QUERY] [--backup] [--json]
ksx panel backups [--device QUERY] [--json]
ksx panel program [--device QUERY] --base-sha256 HASH \
  (--canonical-four-player | semantic terminal edits) [--json]
ksx panel restore BACKUP_ID [--device QUERY] --current-sha256 HASH [--json]
```

Program edits are `--set TERMINAL=KEY`, `--set-shifted TERMINAL=KEY`,
`--use-as-shift TERMINAL` and `--not-shift TERMINAL`; an empty right side
clears a key assignment. Canonical and custom modes cannot be mixed. Program
and restore are non-mutating plans by default: planning issues the chart query
and read but writes no chart data or EEPROM. Apply requires `--yes`,
`--supervised`, `--expected-desired-sha256 HASH`,
`--expected-board-fingerprint FINGERPRINT` and
`--expected-protocol-profile ipac4-pac256-v1`, all copied from the displayed
plan and coupled to `--yes`. Every hash parser requires exactly 64 hexadecimal
characters. All verbs have typed JSON parity.

### Studio flow

`[SOURCE crates/ksx-studio/src/server/mod.rs;
crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/panelProgramming.ts;
studio-ui/src/NocturneIsland.ts]` Studio exposes status, chart, backups,
program-plan/apply and restore-plan/apply routes. The daemon-held staged encoder
is authoritative; a browser-supplied selector is only a stale-screen guard.
Target, board fingerprint, protocol profile and base/desired hashes bind every
plan. A selected encoder, profile or chart change invalidates confirmation.
The same global lease guards Play startup and the complete maintenance
transaction. A stopped session exposes capability `supervised`; a running one
is `write-locked`, never generically “ready.”

The user-facing sequence is:

1. In Control Surface Builder, open **Read & back up…**. A missing/currently
   stale chart triggers an explicit complete read with an immutable backup.
2. For an unqualified hardware/profile pair, Studio permits only one supported
   normal-key change on a noncritical SW action terminal whose shift role is
   explicitly disabled. It disallows directions, Start/Coin, clears, alternate
   or opaque shift states. The review says plainly that one desired byte differs
   while the protocol retransmits the complete 256-byte chart.
3. After verified validation write, Studio pins **Restore validation backup**.
   Only an exact byte-verified restore unlocks full programming. A partial or
   ambiguous validation still pins that restore but returns to the unqualified
   state instead of manufacturing trust.
4. Choose **Recommended KSX layout**, **Customize terminals**, or **Keep current
   + Teach**. Custom assignment detects incomplete links, unsupported keys,
   accidental terminal reuse, inconsistent mirrors and shared keys without
   deliberate fan-in.
5. Choose **Review hardware changes**. The modal shows terminal changes, an
   expandable byte diff, preserved-byte count, blockers, base/desired hashes
   and the backend's confirmation sentence.
6. Check both acknowledgements: the exact reviewed change, and that the user is
   physically at the cabinet with WinIPAC closed plus a separate keyboard or
   recovery path. Only then can **Program and verify** unlock. Restore follows
   the same flow through **Review restore…** and **Restore and verify**.
7. Studio displays `writing`, then `verifying`, and accepts only a backend
   `verified` outcome. An ambiguous/interrupted result becomes
   `recovery-required` and blocks further programming until reread/restore.
8. After byte verification, expected terminal keys are reconciled into the
   control-surface model, prior signal verification is invalidated, and the
   user is sent to **Teach inputs**. This deliberately separates “EEPROM bytes
   matched” from “the wired control emitted the expected Windows signal.”

The editor opens as a focused canvas task. Its camera framing reserves the
visible minimap/navigation strip, so the first action and recovery controls
remain reachable at native viewport sizes instead of landing beneath canvas
chrome. Detached success or recovery results remain bound to the encoder that
produced them and expose only **Close** after selection changes.

Only `assignment_mode` and `show_unchanged` may persist in browser storage.
Selectors, fingerprints, chart hashes, plans, backup IDs, raw bytes and
hardware outcomes remain backend-owned or short-lived.

## Clean-room protocol-fact provenance

`[SOURCE https://www.ultimarc.com/control-interfaces/i-pacs/i-pac4-board/ as
read 2026-08-23]` Ultimarc's official I-PAC 4 page establishes the product
behavior being supported: 56 inputs, persistent programmable key assignments,
shifted assignments, generic Windows USB operation and model/firmware-scoped
keyboard/gamepad modes. It does not publish the complete packet schema.

The following GPLv2 project was inspected at one immutable commit strictly as
a protocol-fact reference:

- [`common.h`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/common.h): HID class request
  facts `0x21` / `9`;
- [`ipacseries.h`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipacseries.h): older generic
  value `0x0203`, five-byte, 260-byte-buffer and generation/interface facts;
- [`ipac.c`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/src/libs/ipac.c): an older generic
  I-PAC-series writer only—it provides no chart-read path and does not establish
  the measured D209:0430 release-0056 MI_02 topology; and
- [`LICENSE`](https://github.com/katie-snow/Ultimarc-linux/blob/20b8c56a3e6f94034b8529eddd777306f5b6152b/LICENSE): GNU GPL version 2.

The pinned QtPyUltimarc commit
`6f1f5a285201143e6260f0a1451ca469a54ee768` is the direct PAC256 evidence:

- [`ipac4.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/ipac4.py)
  identifies the I-PAC4 family, interface 2 and the `03 59 DD 0F` query/read;
- [`_structures.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_structures.py)
  defines the PAC structure as exactly 256 bytes; and
- [`_device.py`](https://github.com/katie-snow/QtPyUltimarc/blob/6f1f5a285201143e6260f0a1451ca469a54ee768/ultimarc/devices/_device.py)
  records four payload bytes per five-byte report for both read and write loops.

**Clean-room boundary:** protocol facts were written into this evidence record;
KSX's Rust and TypeScript were independently authored against those facts,
Ultimarc's official behavior, Windows HID APIs and KSX's own typed seams. No
source code was copied; neither research project is a dependency, linked,
vendored or distributed with KSX.

`NOTICE` is intentionally unchanged. Its repository policy catalogs material
copied, vendored, embedded or bundled into KSX; this implementation took no
such material. The pinned links above retain the research attribution and
license context without suggesting that the GPL implementation ships here.

## Synthetic QA boundary

`[SOURCE crates/ksx-platform/src/hid_report.rs tests]` Pure policy tests cover
path rejection, exact VID/PID and report-size admission, exact report length
and bounded timeout conversion. The final platform HID-report suite passed
14/14, with platform clippy clean.

`[SOURCE crates/ksx-backend/src/panel_programming.rs tests]` Fake report and
backup implementations cover the exact 64-frame/256-byte read, full 750-ms
boundary, malformed/short frames and every 65th-frame refusal. They also cover
semantic byte preservation, canonical reset/uniqueness, rejection of 260-byte
backup/write attempts, immutable backup collision/corruption/identity/path
checks, backup before packet zero, no-op/stale refusal, write phase/packet
errors, recovery-required mismatch, complete verification and restore.

`[SOURCE crates/ksx-app/src/main.rs tests]` Parser tests cover the read/backup
verbs, plan-first behavior, canonical/custom conflicts, semantic edit merge and
clear behavior, strict hashes, and the coupled hash/fingerprint/profile/
`--supervised`/`--yes` consent.

`[SOURCE crates/ksx-studio/tests/http.rs; studio-ui/src/panelProgramming.ts]`
Scripted-machine HTTP tests exercise the route contract, stale target refusal
and active-Play mutation stop; pure frontend tests cover capability, authority,
plan invalidation, conflicts and the storage allowlist.

These are synthetic guarantees only. No test in this slice opened the live
configuration collection, sent `[03 59 DD 0F 00]`, called
`HidD_SetOutputReport` on the cabinet, changed EEPROM, or asserted that the
cabinet read back a chart.

`[MEASURED 2026-08-23 03:03 EDT]` Final serialized backend validation passed
682 tests with 0 failures and 1 ignored hardware-only case; API passed 106/106;
Studio HTTP passed 137/137; the app batches passed 65, 3, 22, 2, 7, 2 and 1
tests; and the complete canvas browser suite passed 45/45. The recovery-focused
backend gate passed 7/7 and daemon integration passed 2/2. Warnings-denied
clippy passed for backend/all targets and the previously exercised app,
Studio, platform and API targets. Formatting and `git diff --check` passed.
The Studio asset graph built twice to 48 byte-identical files with build hash
`66830ebfbbea084bdf78f75fb03b654059eb2a9b092e38bb906639229ec6bf04`.

## First real-hardware gate

`[UNVERIFIED target cabinet]` Real-hardware write verification still requires
one supervised read/backup, no-op plan, reversible first write and verified
restore. It is never an automatic test or startup action.

1. Stop Play. Keep a spare ordinary keyboard, WinIPAC or the documented
   hardware recovery path, and physical access to unplug the panel available.
2. Run passive status and verify the exact physical board and unique five-byte
   configuration collection. Then run an explicit chart read with backup and
   verify the returned length, hash, decoded terminals, backup identity and
   that the backup reloads.
3. Review a no-op plan first. It still sends the chart-query report to read and
   revalidate current state, but emits no chart-data programming frame and
   creates no write-time backup. It therefore does **not** prove the writer.
4. For the first actual write, change one noncritical SW action terminal with
   shift explicitly disabled to one reversible supported normal key. Require
   the plan to show exactly one semantic/desired-byte diff and also acknowledge
   that the hardware protocol retransmits all 64 reports / 256 chart bytes;
   record the base/desired hashes and safety-backup ID before confirming.
5. Confirm under supervision. Require a full byte-for-byte verified reread,
   then use Teach or a Windows input observer to verify the physical switch
   emits the desired key.
6. Review and apply **Restore validation backup** for that exact pre-program
   safety backup. Require the complete hash to match and physically verify the
   prior key again. Only this verified round trip unlocks full-chart layouts.
7. Only after reversible success should a full canonical chart be considered.
   A power cycle can then measure persistence separately.

Any open, report, timeout, partial write, reread mismatch or physical-signal
mismatch stops the procedure. Retain the named backup and logs; do not retry a
different chart until the exact failure is understood.

## Cabinet evidence and remaining unknowns

`[MEASURED 2026-08-22 21:13 EDT]` The selected board reported as Ultimarc
I-PAC 4X, VID/PID `d209:0430`, serial `4`, raw `bcdDevice 0x0056`, MI_00,
MI_01 and MI_02, and six joined HID collections. MI_00 described 33-byte input
/ 2-byte output reports; MI_02 included one five-byte input/output collection
and one 97-byte input/output collection. These are descriptor facts only.

The following remain unverified on that board:

- exact firmware revision and vendor mode;
- which observed five-byte collection accepts the chart query while MI_00 is
  WinUSB-claimed;
- whether the exact 256-byte response is the complete installed EEPROM image,
  including every shift/macro/opaque byte;
- whether `HidD_SetOutputReport` succeeds without elevation;
- firmware buffering, atomicity, interruption, re-enumeration and persistence
  behavior; and
- simultaneous-key rollover and hardware mode-switch behavior.

## Corrections — do not resurrect

`[SOURCE crates/ksx-core/src/device.rs; crates/ksx-core/src/engine.rs]`
**Retracted:** “105 distinct keys means keyboard mode cannot reach 16 slots.”
Keys are device-qualified and reusable across encoders.

`[SOURCE crates/ksx-core/src/templates.rs]` **Retracted:** “The
`arcade-6button` template spends 12 keys per player.” It maps four directions,
eight buttons, Start and Coin: 14 unique keys per player.

`[SOURCE docs/ENHANCEMENTS.md E10]` **Retracted as policy:** “I-PAC XInput is
permanently out.” It is an optional bypass/diagnostic case; routing it back
through KSX is outside this feature.

`[UNVERIFIED runtime]` **Retracted as fact:** “A guest mode switch makes every
slot `XinputBusFull` while the session remains healthy.” That needs a
supervised mode-switch measurement.

`[SOURCE Ultimarc I-PAC4 page]` **False:** “Firmware 1.57 adds NKRO.” The
referenced note describes an instant mode-switch button, not an NKRO addition.

## Work log

| Time (ET) | Branch / baseline | Work | Evidence |
|---|---|---|---|
| 2026-08-22 20:24 EDT | `codex/control-surface-builder` / `6e519a1426ea` | Corrected E10 decision drafted; living-state register and doc-routing link added. No implementation or hardware action. | Documentation-only change; v1 software tests remained outstanding. |
| 2026-08-22 20:27 EDT | same uncommitted worktree | Focused documentation validation only. | `[MEASURED 2026-08-22 20:27 EDT]` `git diff --check` exited 0; `cargo test -p ksx-app --test docs` passed 3/3. |
| 2026-08-22 21:09 EDT | same uncommitted worktree | Typed backend/CLI, GET-only Studio endpoint and selected-encoder card assembled locally. | `[SOURCE crates/ksx-backend/src/panel.rs; crates/ksx-platform/src/hid.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/NocturneIsland.ts]` No report transaction. |
| 2026-08-22 21:13 EDT | same uncommitted worktree | Re-ran access-zero status against the selected physical I-PAC. | `[MEASURED 2026-08-22 21:13 EDT]` Status returned raw `0x0056`, three interfaces, six HID collections, keyboard-compatible topology, one unverified five-byte candidate and `chart_attempted=false`. |
| 2026-08-22 21:17 EDT | same uncommitted worktree | Re-ran focused discovery safety and contract tests. | `[MEASURED 2026-08-22 21:17 EDT]` Backend status 7/7, platform passive HID 4/4, CLI parser 1/1 and Studio status HTTP 4/4 passed. |
| 2026-08-22 21:21 EDT | same uncommitted worktree | Ran the read-only discovery acceptance matrix. | `[MEASURED 2026-08-22 21:21 EDT]` Formatting, workspace clippy, feature combinations and workspace tests passed locally; this was not chart/program evidence. |
| 2026-08-22 21:22 EDT | `codex/control-surface-builder` / `50a3239fe7f6` | Committed the read-only discovery candidate and governing docs. | `[MEASURED 2026-08-22 21:22 EDT]` No shipped-binary or chart-read claim. |
| 2026-08-23 00:17 EDT | shared implementation worktree / `5492454` baseline | Added source-complete explicit report transport, chart/backup/program/restore domain, typed API/CLI and supervised Studio workflow. | `[SOURCE implementation files named above]` QA is synthetic only; no live report or EEPROM action. Integrated validation and supervised hardware gate remain. |
| 2026-08-23 00:26 EDT | same shared worktree | Updated E10 and this living state for the implementation candidate; no code, asset or hardware action. | `[MEASURED 2026-08-23 00:26 EDT]` `git diff --check` and the trailing-whitespace scan were clean; `cargo test -p ksx-app --test docs` passed 3/3. |
| 2026-08-23 03:03 EDT | `codex/ipac-programmer` / `5492454` baseline | Closed final review findings: machine-pinned recovery authority, fail-closed Play gate, reparse-safe traversal, detached-result binding and inset-aware canvas framing. | `[MEASURED 2026-08-23 03:03 EDT]` Final Rust, HTTP and browser suites are green; deterministic asset rebuild passed twice; independent final review reported no remaining P0/P1/P2 findings. No live HID report was sent. |

## Current pickup

The software implementation and local integration validation are complete on
`codex/ipac-programmer`. A post-merge clean runner remains ordinary release
evidence, not an implementation gap and never hardware evidence.

The next hardware pickup is the supervised procedure above. Start with passive
identity and explicit read/backup, review a no-op plan, then make only one
reversible noncritical terminal change. Until its program, complete readback,
physical signal check and restore all succeed, the writer remains
**implemented and synthetic-verified, hardware-unverified**.
