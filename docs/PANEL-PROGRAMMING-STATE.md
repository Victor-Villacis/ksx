# Panel programming — living state

**This file records state, not aspiration.**
[`ENHANCEMENTS.md`](ENHANCEMENTS.md) E10 is the product decision. Where that
plan, an older research note, a comment or a conversation disagrees with this
file's evidence register, correct or annotate the stale claim before relying
on it.

**Current status — 2026-08-23 16:44:33 UTC / 12:44:33 EDT: THE I-PAC 4
PROGRAMMER IS HARDWARE-PROVEN AT THE EEPROM BYTE LEVEL; THE COMPLETE EDITOR,
CLEAR/REBUILD FLOW AND PORTABLE PROFILE UX ARE IMPLEMENTED.** The connected
I-PAC 4X accepted a one-byte qualification write, a verified restore, a
semantic clear and a complete Recommended KSX layout. Every operation reread
all 256 bytes and matched its reviewed desired SHA-256. The board's current
verified image is
`43CAD3F30B900416531D3A65A3799405F3094E34BE0E37E467079D163C8C1D87`.

The worktree contains the explicit Windows HID transport, complete-chart read,
automatic raw recovery journal, semantic plan, persistent program, full
readback verification, restore, CLI, full 4-by-14 Studio terminal editor and
portable saved-layout CRUD. Studio classifies the exact I-PAC family as a
panel encoder instead of an ordinary keyboard and can configure a new blank
board before a key event or control surface exists.

The hardware proof has a deliberate boundary: it proves accepted EEPROM
reports and byte-identical chart readback. No one has yet pressed a wired
cabinet switch to prove its Windows key emission, and the programmed chart has
not yet been checked after an unplug/replug or power cycle. Do not merge those
remaining physical-signal and persistence checks into the completed byte-level
writer claim.

## How to read a claim

Every implementation-relevant factual claim carries one of these tags. A
source observation cannot stand in for a cabinet measurement.

| Tag | Meaning |
|---|---|
| `[MEASURED yyyy-mm-dd hh:mm ZONE]` | Observed in this worktree or on named hardware; the reproducing artifact or command is recorded. UTC is paired with EDT for device artifacts whose IDs use UTC. |
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

The completed UX lets a cabinet owner select the exact encoder, load the
on-device chart, start from Current, Recommended, Clear or a saved layout, edit
all 56 terminals, inspect the semantic and byte diff, confirm one hash-bound
transaction and read back every byte. Teach remains the distinct next step
that proves what the physical wiring actually emits. Restore is the same
reviewed and verified transaction in reverse. Automatic raw backups are the
low-level rollback journal, not a requirement that the user preserve or keep
using the old WinIPAC configuration.

I-PAC XInput mode remains an optional hardware bypass and diagnostic case. It
is not the default, and v1 does not route those XInput pads back through KSX.

## Capability state

| Capability | State at 2026-08-23 | Evidence / remaining gate |
|---|---|---|
| Identify a panel USB parent and enumerate interfaces | **implemented; live passive evidence** | `[MEASURED 2026-08-22 21:13 EDT]` `ksx panel status --device 'USB\VID_D209&PID_0430\4' --json` grouped three USB interfaces and six HID collections under one physical I-PAC 4X without report access. |
| Stable status copy / JSON | **implemented** | `[MEASURED 2026-08-22 21:17 EDT]` focused backend, CLI and Studio discovery tests passed. |
| Exact five-byte Windows HID transport | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:17 UTC / 12:17 EDT]` MI_02/COL01 exposed usage `0001:0000`, exact five-byte IN/OUT reports and accepted the query plus later output reports on the named cabinet. `[SOURCE crates/ksx-platform/src/hid_report.rs]` Exact path, rechecked VID/PID/caps, fixed `[u8; 5]` reports and bounded overlapped cancellation remain the admission contract. |
| Complete chart read and decode | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:25:55 UTC / 12:25:55 EDT]` Two stable reads returned 256 bytes beginning `50 DD 56`, SHA-256 `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`, from firmware/release 1.56. |
| Immutable lossless backup and list | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:25:55 UTC / 12:25:55 EDT]` `20260823-162555-1fb3dffbe64a.ksxpanel.json` reloaded as a complete board-bound `ksx.panel-backup.v1`; every live mutation also created and verified its own safety image before packet zero. |
| Semantic terminal edit / Recommended / Clear | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:33:54 and 16:44:00 UTC / 12:33:54 and 12:44:00 EDT]` Clear changed 53 assignment bytes and preserved 203; Recommended then changed 56 terminal bytes and preserved 200, with complete matching readbacks. |
| Portable saved layouts | **implemented; focused integration-verified** | `[SOURCE crates/ksx-backend/src/panel_profiles.rs; crates/ksx-api/src/machine.rs]` Complete 56-terminal semantic profiles support list/create/load/update/delete, stable terminal signatures, canonical validation, atomic replacement, content revisions and one path-scoped cross-process lease. They intentionally contain no board-bound raw or opaque bytes. |
| Program / full readback verify | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:26:22, 16:33:54 and 16:44:00 UTC]` Qualification, Clear and Recommended each completed re-read → stale check → backup → journal → full write → complete reread → 256-byte equality. |
| Restore / full readback verify | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:26:48 UTC / 12:26:48 EDT]` Restore rewrote the qualification backup and reread the exact original hash `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`. |
| Typed machine API and CLI | **implemented; integration-verified** | `[SOURCE crates/ksx-api/src/machine.rs; crates/ksx-app/src/main.rs]` Typed chart/backups/plan/apply/restore plus saved-layout contracts, hardware-command human/JSON parity and plan-first consent. `[MEASURED 2026-08-23 17:05 UTC / 13:05 EDT]` Focused Rust and HTTP suites, warnings-denied all-target clippy, the complete Studio-feature app suite and the complete canvas suite were green. |
| Studio editor | **implemented; real-board UI and automated flows verified** | `[SOURCE crates/ksx-studio/src/server/mod.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/panelProgramming.ts; studio-ui/src/NocturneIsland.ts]` Selected-encoder authority, complete 4-by-14 terminal editor, Current/Recommended/Clear/saved-layout starts, normal and advanced shifted/Shift editing, deliberate shared keys, profile CRUD, dirty state, exact review/apply/recovery and post-write Teach handoff. `[MEASURED 2026-08-23 17:04 UTC / 13:04 EDT]` Real Studio read the connected board's final chart, rendered 56/56 and Qualified, and saved the complete current semantic chart as portable layout `KSX Recommended — I-PAC 4` without another EEPROM write. |
| Blank-board first-run entry | **implemented; writer path live-proven** | `[SOURCE crates/ksx-api/src/machine.rs; crates/ksx-backend/src/device_scan.rs; crates/ksx-studio/src/snapshot.rs; studio-ui/src/NocturneIsland.ts]` Exact registered hardware is served in an **Arcade encoders** lane. **Set up** opens chart programming without a Windows key event, selected component or panel template. `[MEASURED 2026-08-23 16:33:54 UTC]` The live board was successfully cleared to the resulting all-Unassigned semantic chart. |
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
`bcdDevice 0x0056`, MI_02, one unique error-free usage-`0001:0000` five-byte
IN/OUT collection, report ID `0x03`, and query `[03 59 DD 0F 00]`. A read must
return exactly 64 frames carrying four payload bytes each, then no 65th frame
for the complete 750-ms boundary. The resulting 256-byte readback image must
begin `50 DD 56` on the pinned release-0056 profile. Programming converts only
that readback release byte to the command header `50 DD 0F`; wrong
identity/topology, report IDs, frame lengths, timeouts, headers, or any 65th
frame refuse. Two independent close/reopen reads must also produce the same
SHA-256 before the image can authorize a plan or backup.

The raw image is authoritative. Semantic edits clone it and replace only the
addressed normal, alternate or explicit Shift byte for one of the 56 modeled
terminals. Opaque bytes and unedited layers survive byte-for-byte. Unknown
terminals, unsupported key usages and duplicate same-plane edits refuse.
Repeated keys also refuse unless every participating edited terminal carries
the deliberate `allow_shared_key` acknowledgement; this permits real fan-in
without silently manufacturing a collision.

The Recommended layout assigns 56 distinct normal-plane keys KSX can observe,
clears supported alternate assignments and disables explicit Shift-enabled
roles. The Clear layout clears supported normal/alternate assignments and
disables explicit Shift roles. Both are derived from the freshly read image:
an opaque shift byte is preserved rather than normalized into a meaning KSX
cannot prove. On the measured board those opaque shift states are `1start`,
`3sw8`, `4sw7` and `4sw8`. Its Recommended normal keys use letters, digits,
selected punctuation and F1–F10; they deliberately avoid Escape, Enter,
Backspace, Tab, Space, navigation keys, modifiers and the two HID usages that
collapse to the same KSX key.

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

`[SOURCE crates/ksx-backend/src/panel_profiles.rs;
crates/ksx-config/src/paths.rs]`
Named encoder layouts are intentionally separate from that raw recovery store.
They live under `panel-layouts`, carry exactly one canonical semantic row for
each of the 56 terminals, and are portable to another board admitted by the
same driver, protocol profile and terminal-signature hash. They preserve the
user-editable normal key, shifted key, explicit Shift role and deliberate
shared-key acknowledgement; they do not pretend to contain opaque EEPROM
bytes. Create, update and delete normalize the complete document, refuse
missing/unknown terminals and accidental shared keys, use atomic replacement,
and require an exact content revision for update/delete. One path-derived
global Windows mutex spans list, revision check, replace and delete, so a
second KSX process cannot make the compare-and-replace check stale.

`[SOURCE crates/ksx-studio/src/server/mod.rs;
crates/ksx-studio/src/server/nocturne.rs]` Studio exposes no-store typed routes
at `GET /api/panel/profiles`, `POST /api/panel/profiles/save` and
`POST /api/panel/profiles/delete`. Profile deletion removes only the local
saved layout and never writes the encoder. Applying a loaded profile still
uses the ordinary hash-bound plan, confirmation, write and full-readback path.

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
  (--canonical-four-player | --blank | semantic terminal edits) [--json]
ksx panel restore BACKUP_ID [--device QUERY] --current-sha256 HASH [--json]
```

Program edits are `--set TERMINAL=KEY`, `--set-shifted TERMINAL=KEY`,
`--use-as-shift TERMINAL`, `--not-shift TERMINAL` and
`--allow-shared-key TERMINAL`; an empty right side clears a key assignment.
The shared-key acknowledgement is valid only for a terminal edited in the same
request, and every participant in one shared assignment must be acknowledged.
Canonical, blank and custom modes cannot be mixed. Program and restore are
non-mutating plans by default: planning issues the chart query and read but
writes no chart data or EEPROM. Apply requires `--yes`,
`--supervised`, `--expected-desired-sha256 HASH`,
`--expected-board-fingerprint FINGERPRINT` and
`--expected-protocol-profile ipac4-pac256-v1`, all copied from the displayed
plan and coupled to `--yes`. Every hash parser requires exactly 64 hexadecimal
characters. All verbs have typed JSON parity.

Portable saved-layout CRUD is currently a typed Machine/Studio capability, not
a public `ksx panel profile ...` CLI family. Do not document the backend's
internal profile helpers as shipped CLI verbs unless the command graph is
deliberately added and its Windows startup stack is re-proven.

`[SOURCE crates/ksx-app/build.rs; crates/ksx-app/tests/no_interception_dll.rs]`
The Windows MSVC `ksx.exe` reserves 4 MiB for its initial thread. The complete
nested Clap graph crossed the PE default 1 MiB reserve in an unoptimized
developer build after the Panel surface grew. The linker contract applies only
to this binary and keeps Studio/tray/Win32 lifetime work on the real main
thread. A regression parses the built PE optional header and asserts the
actual `SizeOfStackReserve`, rather than merely checking build-script text.

### Studio flow

`[SOURCE crates/ksx-studio/src/server/mod.rs;
crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/panelProgramming.ts;
studio-ui/src/NocturneIsland.ts]` Studio exposes status, chart, backups,
program-plan/apply, restore-plan/apply and portable-profile routes. The
daemon-held staged encoder is authoritative; a browser-supplied selector is
only a stale-screen guard. Target, board fingerprint, protocol profile and
base/desired hashes bind every hardware plan. A selected encoder, profile or
chart change invalidates confirmation. The same global lease guards Play
startup and the complete maintenance transaction. A stopped session exposes
capability `supervised`; a running one is `write-locked`, never generically
“ready.”

The user-facing sequence is:

1. Under **Input hardware → Arcade encoders**, choose **Set up** on the exact
   I-PAC. If another encoder was staged, the ordinary device-selection POST
   completes first; only the matching authoritative payload opens setup. The
   focused hardware task hides panel templates, Design/Teach/Route and drawn
   components because none is a prerequisite for EEPROM initialization.
2. Studio immediately performs the explicit complete chart read with an
   immutable recovery image. A completely Unassigned board is valid: the
   qualification terminal and temporary key are chosen directly from the
   backend-served chart, without waiting for a key event or creating a fake
   surface control. The older Control Surface Builder **Read & back up…** entry
   remains available for an already-modeled cabinet.
3. For an unqualified hardware/profile pair, Studio permits only one supported
   normal-key change on a noncritical SW action terminal whose shift role is
   explicitly disabled. It disallows directions, Start/Coin, clears, alternate
   or opaque shift states. If the chosen validation key is already assigned,
   Studio includes every existing owner and marks all participants as deliberate
   shared-key fan-in; the semantic plan still changes only the chosen terminal's
   one byte. The review says plainly that one desired byte differs while the
   protocol retransmits the complete 256-byte chart.
4. After verified validation write, Studio pins **Restore validation backup**.
   Only an exact byte-verified restore unlocks full programming. A partial or
   ambiguous validation still pins that restore but returns to the unqualified
   state instead of manufacturing trust.
5. Start from **Current hardware**, **Recommended KSX**, **Clear assignments**
   or **Import saved layout**. The complete 4-by-14 terminal grid exposes all
   56 normal assignments. An Advanced section exposes shifted assignment and
   explicit Shift-role editing without pretending opaque shift bytes are
   ordinary booleans. Shared output keys require deliberate acknowledgement.
6. The draft is independent of the on-device chart and shows whether it is
   dirty and not yet written. Save it as a new named layout, update the loaded
   layout with its exact revision, load it on another compatible encoder, or
   delete the local saved layout without touching hardware. Saved profiles must
   remain complete 56-terminal documents.
7. Choose **Review hardware changes**. The modal shows terminal changes, an
   expandable byte diff, preserved-byte count, blockers, base/desired hashes
   and the backend's confirmation sentence.
8. Check both acknowledgements: the exact reviewed change, and that the user is
   physically at the cabinet with WinIPAC closed plus a separate keyboard or
   recovery path. Only then can **Program and verify** unlock. Restore follows
   the same flow through **Review restore…** and **Restore and verify**.
9. Studio displays `writing`, then `verifying`, and accepts only a backend
   `verified` outcome. An ambiguous/interrupted result becomes
   `recovery-required` and blocks further programming until reread/restore.
10. After byte verification, expected terminal keys are reconciled into the
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
verbs, plan-first behavior, canonical/blank/custom conflicts, semantic edit
merge and clear behavior, deliberate shared-key admission, strict hashes, and
the coupled hash/fingerprint/profile/`--supervised`/`--yes` consent.

`[SOURCE crates/ksx-backend/src/panel_profiles.rs tests;
crates/ksx-studio/tests/http.rs; studio-ui/src/panelProgramming.ts]`
Profile tests cover complete-document validation, canonical normalization,
atomic create/update/delete, stale revisions, cross-process lease contention,
terminal signatures and accidental shared-key refusal. Scripted-machine HTTP
tests exercise the hardware and portable-profile route contracts, stale target
refusal and active-Play mutation stop; pure frontend tests cover capability,
authority, plan invalidation, conflicts and the storage allowlist.

These automated guarantees remain synthetic: no automated suite presses a
physical cabinet switch or power-cycles the board. They are supplemented by
the separately recorded, user-authorized live report/write/readback exercise
below; neither type of evidence is allowed to impersonate the other.

`[MEASURED 2026-08-23 16:17 UTC / 12:17 EDT]` A fresh passive survey of the connected
D209:0430 release-0056 I-PAC 4X corrected one synthetic assumption before any
report was sent: Windows exposes MI_02/COL01 as usage `0001:0000` with exact
five-byte input/output reports. It does not expose that collection as
`FF00:0001`. Writer admission now pins the measured `0001:0000` discriminator
in addition to the existing VID, PID, raw release, MI_02 and report-size gates.

`[MEASURED 2026-08-23 03:03 EDT]` Final serialized backend validation passed
682 tests with 0 failures and 1 ignored hardware-only case; API passed 106/106;
Studio HTTP passed 137/137; the app batches passed 65, 3, 22, 2, 7, 2 and 1
tests; and the complete canvas browser suite passed 45/45. The recovery-focused
backend gate passed 7/7 and daemon integration passed 2/2. Warnings-denied
clippy passed for backend/all targets and the previously exercised app,
Studio, platform and API targets. Formatting and `git diff --check` passed.
The Studio asset graph built twice to 48 byte-identical files with build hash
`66830ebfbbea084bdf78f75fb03b654059eb2a9b092e38bb906639229ec6bf04`.

`[MEASURED 2026-08-23 11:55 EDT]` The blank-board entry slice passed the
complete `ksx-studio` crate suite, API 107/107, docs 3/3 and the complete
Nocturne canvas browser suite 49/49. Two consecutive Studio builds produced
48 byte-identical asset files with build hash
`4eb2dbdafc9664296f31df867b42667042a1267ebe243144ccb4fe566eba09d1`.

`[MEASURED 2026-08-23 17:05 UTC / 13:05 EDT]` After the live-protocol,
opaque-byte, Clear, shared-key, portable-profile and final UI-state changes,
focused suites passed: platform HID reports 14/14, backend panel programming
47/47, backend panel profiles 7/7, API 107/107 and Studio HTTP 139/139. The
complete canvas suite passed 50/50. Warnings-denied all-target clippy passed for
platform, backend with Studio, app with Studio and Studio; the complete
Studio-feature app suite passed all 105 tests across its unit/integration
binaries. Two consecutive Studio builds produced the same 48 files with build
hash `0be0a22a173fec4dbc5a3cd2e098c06de26bededae87cab6369b61337b51cb2d`.
The built PE reserve regression, `ksx --version`, Studio help, Panel Program
help and an actual localhost Studio startup all passed.

## Completed real-hardware exercise

`[MEASURED 2026-08-23 16:17–16:44 UTC / 12:17–12:44 EDT]` The user explicitly
authorized destructive development writes to one physical board. KSX targeted
only this identity:

| Fact | Measured value |
|---|---|
| Product | Ultimarc I-PAC 4X |
| Windows physical ID | `USB\VID_D209&PID_0430\4` |
| Stable KSX selector | `usb:d209:0430:00` |
| VID / PID | `D209:0430` |
| Raw release / firmware | `bcdDevice 0x0056` / read header `50 DD 56` (1.56) |
| Serial | `4` |
| Board fingerprint | `IPAC4-9E923EB9374D25229C5AD742` |
| Configuration collection | MI_02/COL01, usage `0001:0000`, IN/OUT 5 bytes |
| Protocol | `ipac4-pac256-v1`, report ID `03`, 64 frames / 256 bytes |

The recorded exercise was:

1. `[MEASURED 2026-08-23 16:25:55 UTC / 12:25:55 EDT]` Two close/reopen
   chart reads were stable. The original image hash was
   `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`;
   raw backup `20260823-162555-1fb3dffbe64a.ksxpanel.json` reopened and
   validated against the board identity and transport.
2. `[MEASURED 2026-08-23 16:26:22 UTC / 12:26:22 EDT]` The reversible
   qualification changed terminal `1sw8` from key `C` to `A` at chart byte
   offset 59. `1coin` already used `A`, so the plan deliberately acknowledged
   both shared-key participants. Exactly one desired byte changed. The board
   accepted all reports and the full reread matched
   `0E85D946B2AEBB46010AC9808A8F50159E5D436492917B65C5F8BCF2E8393D55`.
   Safety backup: `20260823-162622-1fb3dffbe64a.ksxpanel.json`.
3. `[MEASURED 2026-08-23 16:26:48 UTC / 12:26:48 EDT]` Restore backed up the
   qualification image as `20260823-162648-0e85d946b2ae.ksxpanel.json`, wrote
   the original image and reread all 256 bytes at the exact original hash.
   The board/profile qualification receipt became `qualified` at
   `2026-08-23T16:26:53Z`.
4. `[MEASURED 2026-08-23 16:33:54 UTC / 12:33:54 EDT]` Clear started from the
   restored original image, cleared 53 assigned semantic terminals, changed 53
   bytes and preserved 203. The complete readback matched
   `0A15089697BB20FD4B39D06C6EC2AC5D1C2B8E03907A465480E988C39061F7F7`.
   Safety backup: `20260823-163354-1fb3dffbe64a.ksxpanel.json`.
5. `[MEASURED 2026-08-23 16:44:00 UTC / 12:44:00 EDT]` Recommended started
   from that cleared chart, assigned all 56 normal terminals, changed exactly
   56 bytes and preserved 200, including the four opaque shift states. The
   complete readback matched
   `43CAD3F30B900416531D3A65A3799405F3094E34BE0E37E467079D163C8C1D87`.
   Safety backup: `20260823-164400-0a15089697bb.ksxpanel.json`.
6. `[MEASURED 2026-08-23 16:44:33 UTC / 12:44:33 EDT]` A fresh independent
   chart read and manual backup returned the same Recommended hash with 56
   assigned terminals, zero unassigned terminals and the four opaque shift
   states preserved. Backup:
   `20260823-164433-43cad3f30b90.ksxpanel.json`.

This proves query, decode, persistent report submission, multiple full-image
writes, reverse restore and complete 256-byte reread equality on the named
firmware. It does not prove physical switch emission, power-cycle persistence,
failure atomicity or rollover. Automatic backups and transaction receipts were
retained as anti-brick evidence; the product flow does not require the user to
keep the original layout or use WinIPAC.

## Cabinet evidence and remaining unknowns

`[MEASURED 2026-08-22 21:13 EDT; extended 2026-08-23 16:17–16:44 UTC]` The
selected board is an Ultimarc I-PAC 4X, VID/PID `D209:0430`, serial `4`, raw
`bcdDevice 0x0056`, with MI_00, MI_01 and MI_02 joined under the exact physical
ID recorded above. MI_00 described 33-byte input / 2-byte output reports;
MI_02/COL01 described and then proved the five-byte `0001:0000` programming
collection. The live `50 DD 56` read header and successful write/readback cycle
close the earlier firmware, collection-selection and output-report questions.

The following remain unverified on that board:

- `[UNVERIFIED physical signal]` Pressing representative wired switches has
  not yet proved that Windows receives the Recommended keys. EEPROM equality
  does not substitute for this Teach/input-observer check.
- `[UNVERIFIED persistence]` The board has not been unplugged/replugged or
  power-cycled since the Recommended write, then reread and physically tested.
- `[UNVERIFIED failure behavior]` Successful transactions do not establish the
  firmware's packet buffering, atomicity or interrupted-write behavior. KSX's
  journal and recovery refusal remain necessary.
- `[UNVERIFIED opaque semantics]` Four nonzero opaque shift bytes were
  preserved exactly, but KSX does not claim to decode their vendor meaning or
  every unused macro/config byte.
- `[UNVERIFIED input topology]` Simultaneous-key rollover, saturation limits
  and hardware mode-switch behavior remain unmeasured.

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

| Time | Branch / baseline | Work | Evidence |
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
| 2026-08-23 11:55 EDT | `codex/ipac-first-run-config` / `aff5cc6` baseline | Added backend-owned panel-encoder roles, a separate Arcade encoders lane, exact-selector first-run entry, all-Unassigned standalone qualification, truthful fixture preview, focus/single-flight guards and blank-panel handoffs. | `[MEASURED 2026-08-23 11:55 EDT]` Complete Studio, API, docs and 49-test browser suites passed; assets rebuilt byte-identically twice; two focused reviews found no remaining P0/P1/P2 issues. No live HID report was sent. |
| 2026-08-23 16:17 UTC / 12:17 EDT | `codex/ipac-first-run-config` / shared worktree | Surveyed the live programming collection and corrected its admission discriminator from the research hypothesis to measured usage `0001:0000`. | `[MEASURED]` Exact D209:0430 release-0056 MI_02/COL01 reported five-byte input/output caps before mutation. |
| 2026-08-23 16:25:55 UTC / 12:25:55 EDT | same | Opened the configuration collection, issued the real chart query twice and persisted a manual raw image. | `[MEASURED]` Both 256-byte reads matched original SHA-256 `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`; backup reopened successfully. |
| 2026-08-23 16:26:22–16:26:53 UTC / 12:26:22–12:26:53 EDT | same | Performed the one-byte qualification write, full reread, reverse restore and full reread. | `[MEASURED]` Qualification hash `0E85D946B2AEBB46010AC9808A8F50159E5D436492917B65C5F8BCF2E8393D55`, restored hash `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`, receipt state `qualified`. |
| 2026-08-23 16:33:54 UTC / 12:33:54 EDT | same | Applied Clear to the live EEPROM from the restored chart. | `[MEASURED]` 53 changed / 203 preserved bytes; full readback hash `0A15089697BB20FD4B39D06C6EC2AC5D1C2B8E03907A465480E988C39061F7F7`. |
| 2026-08-23 16:44:00–16:44:33 UTC / 12:44:00–12:44:33 EDT | same | Applied Recommended from the cleared chart and performed a fresh independent chart read/backup. | `[MEASURED]` 56 changed / 200 preserved bytes; both readbacks matched final hash `43CAD3F30B900416531D3A65A3799405F3094E34BE0E37E467079D163C8C1D87`; 56 assigned / 0 unassigned, four opaque shift bytes preserved. |
| 2026-08-23 16:56 UTC / 12:56 EDT | `codex/ipac-first-run-config` / `aa240e1274b7` baseline plus shared worktree | Reconciled the living state with the full 56-terminal editor, Current/Recommended/Clear/saved-layout starts, portable profile CRUD and live hardware record. | `[SOURCE implementation files and immutable recovery artifacts named above]` Physical switch emission and power-cycle persistence remain explicitly open. |
| 2026-08-23 17:04–17:05 UTC / 13:04–13:05 EDT | same | Opened real Studio against the connected board, reread the final chart into the full editor, saved it as portable profile `KSX Recommended — I-PAC 4`, closed final UI/review findings and fixed the Windows PE main-thread reserve. | `[MEASURED]` Real UI showed 56/56, Qualified and one saved layout; no EEPROM write occurred. Full canvas 50/50, app-with-Studio 105 tests, focused Rust/HTTP suites, clippy, deterministic assets and independent P0–P2 review all passed. |

## Current pickup

The end-to-end writer, Clear/Recommended plans, full terminal editor and
portable saved-layout model are implemented on
`codex/ipac-first-run-config`. The exact connected I-PAC is already qualified
and currently carries the fully readback-verified Recommended chart at
`43CAD3F30B900416531D3A65A3799405F3094E34BE0E37E467079D163C8C1D87`.
The next agent must not rerun qualification or restore the original chart as
if the hardware gate were still pending.

The remaining cabinet QA is narrower: press representative controls while
Teach or an input observer is running; then power-cycle/re-enumerate the board,
reread the chart and confirm the same hash plus representative physical
signals. NKRO/saturation and deliberate mode-switch behavior are separate
measurements. The final browser/fixture rerun and independent P0–P2 code review
are complete; neither is allowed to stand in for those remaining physical
measurements.
