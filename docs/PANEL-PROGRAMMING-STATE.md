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
physical control → I-PAC terminal → persistent Windows key → KSX transform/macro → virtual pad → game
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
| Friendly firmware and observed-input facts | **implemented; profile-scoped** | `[SOURCE crates/ksx-backend/src/panel.rs; crates/ksx-api/src/machine.rs]` Exact D209:0430 release `0x0056` is served as firmware `1.56` only through the registered measured profile, with the shared 56-terminal protocol capacity. Other releases remain raw and unidentified. Keyboard compatibility is visibly labeled as observed HID evidence; `mode_read_supported=false` and the copy explicitly say the exact vendor mode was not queried. KSX does not claim the WinIPAC `Multi-Mode` marketing label from passive USB metadata. |
| Exact five-byte Windows HID transport | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:17 UTC / 12:17 EDT]` MI_02/COL01 exposed usage `0001:0000`, exact five-byte IN/OUT reports and accepted the query plus later output reports on the named cabinet. `[SOURCE crates/ksx-platform/src/hid_report.rs]` Exact path, rechecked VID/PID/caps, fixed `[u8; 5]` reports and bounded overlapped cancellation remain the admission contract. |
| Complete chart read and decode | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:25:55 UTC / 12:25:55 EDT]` Two stable reads returned 256 bytes beginning `50 DD 56`, SHA-256 `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`, from firmware/release 1.56. |
| Immutable lossless backup and list | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:25:55 UTC / 12:25:55 EDT]` `20260823-162555-1fb3dffbe64a.ksxpanel.json` reloaded as a complete board-bound `ksx.panel-backup.v1`; every live mutation also created and verified its own safety image before packet zero. |
| Semantic terminal edit / Recommended / Clear | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:33:54 and 16:44:00 UTC / 12:33:54 and 12:44:00 EDT]` Clear changed 53 assignment bytes and preserved 203; Recommended then changed 56 terminal bytes and preserved 200, with complete matching readbacks. |
| Portable saved layouts | **implemented; focused integration-verified** | `[SOURCE crates/ksx-backend/src/panel_profiles.rs; crates/ksx-api/src/machine.rs]` Complete 56-terminal semantic profiles support list/create/load/update/delete, stable terminal signatures, canonical validation, atomic replacement, content revisions and one path-scoped cross-process lease. They intentionally contain no board-bound raw or opaque bytes. |
| Program / full readback verify | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:26:22, 16:33:54 and 16:44:00 UTC]` Qualification, Clear and Recommended each completed re-read → stale check → backup → journal → full write → complete reread → 256-byte equality. |
| Restore / full readback verify | **implemented; live hardware-proven** | `[MEASURED 2026-08-23 16:26:48 UTC / 12:26:48 EDT]` Restore rewrote the qualification backup and reread the exact original hash `1FB3DFFBE64A85EC348873C80A5481B5CE75D6513BA634D9885697A2541901BB`. |
| Typed machine API and CLI | **implemented; integration-verified** | `[SOURCE crates/ksx-api/src/machine.rs; crates/ksx-app/src/main.rs]` Typed chart/backups/plan/apply/restore plus saved-layout contracts, hardware-command human/JSON parity and plan-first consent. `[MEASURED 2026-08-23 17:05 UTC / 13:05 EDT]` Focused Rust and HTTP suites, warnings-denied all-target clippy, the complete Studio-feature app suite and the complete canvas suite were green. |
| Studio editor | **implemented; real-board UI and automated flows verified** | `[SOURCE crates/ksx-studio/src/server/mod.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/panelProgramming.ts; studio-ui/src/NocturneIsland.ts]` Selected-encoder authority, complete 4-by-14 terminal editor, Current/Recommended/Clear/saved-layout starts, normal and advanced shifted/Shift editing, deliberate shared keys, profile CRUD, dirty state, exact review/apply/recovery and post-write Teach handoff. `[MEASURED 2026-08-23 17:04 UTC / 13:04 EDT]` Real Studio read the connected board's final chart, rendered 56/56 and Qualified, and saved the complete current semantic chart as portable layout `KSX Recommended — I-PAC 4` without another EEPROM write. |
| Reload- and cross-window-safe signal authority | **implemented; automated recovery-, crash-window- and two-document-verified** | `[SOURCE crates/ksx-api/src/machine.rs; crates/ksx-backend/src/panel.rs; crates/ksx-backend/src/panel_programming/facade.rs; crates/ksx-studio/src/server/nocturne.rs; studio-ui/src/NocturneIsland.ts]` Passive status joins the exact physical bus/port fingerprint to the machine recovery journal while holding the programming/Play lease. Busy leases, malformed or substituted recovery paths, missing wire fields and unresolved transactions all fail closed. Studio holds deterministically ordered Web Locks for both the exact Windows device and stable board fingerprint, then publishes a `pending` generation in one atomic per-device sidecar before any apply POST. It retires active Teach/assign work, invalidates every affected stored surface and refuses USB if the safe main document cannot be persisted. The apply token is registered by the server before any asynchronous target check. A recovery read carrying that same token either permanently cancels an unseen/queued apply or waits for a running apply, then reads the complete chart; only the exact token/selector/board response may settle the browser journal. The lock-held writer rechecks the ledger and its per-device write is a CAS, so it cannot overwrite another tab's crash-surviving intent. Other same-origin documents consume both `pending` and fresh `settled` generations through `storage`; synchronous action barriers cover the event-delivery gap, and stale whole-document saves are rebased so they cannot restore a retired key. |
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
5. Start from **Use current outputs**, **KSX four-player**, a compatible saved
   layout, or **Use panel design** when an optional physical panel actually has
   terminal links. The backend serves an exact semantic 56-terminal preview of
   the deterministic four-player layout against the current image, so the
   recommendation is visible before review or write. **Disable all hardware
   outputs** lives under Advanced hardware actions rather than beside the safe
   starts. The complete 4-by-14 terminal grid exposes all 56 Windows-key
   outputs; its Advanced section exposes shifted assignment and explicit
   Shift-role editing without pretending opaque shift bytes are ordinary
   booleans. Shared output keys require deliberate acknowledgement.
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
9. The blocking apply call is presented truthfully as **programming and
   verifying**; Studio accepts only a backend `verified` outcome. An
   ambiguous/interrupted result becomes
   `recovery-required` and blocks further programming until reread/restore.
10. After byte verification, expected terminal keys are reconciled into the
   optional control-surface model and prior signal verification is invalidated.
   A panel-independent **Test one control** action listens once, identifies the
   observed host signal (for keyboard mode, a concrete `Keyboard · Key`)
   and every matching current-chart terminal, and performs no
   binding write. The
   next action opens contextual KSX routing; a modeled physical panel enters
   its Route stage, while a cabinet with no panel drawing goes directly to the
   key's Mapping Inspector. This deliberately separates “EEPROM bytes matched”
   from “the wired control emitted the expected Windows signal” and from “that
   signal is routed to a virtual controller.”

The focused setup names and exposes the causal journey as:

```text
physical arcade control → I-PAC terminal → host signal (`Keyboard · Key` in keyboard mode) → KSX macro/transform → virtual controller → game
```

While an I-PAC is selected, the ordinary QWERTY source art becomes an
**I-PAC Signals** source. Its player-grouped `terminal → key` chips remain a
recoverable fallback. When an open chart-linked physical panel covers every
relevant key-and-player route, that shelf folds and every drawn control carries
a compact terminal chip plus Windows-keycap token; mapping cords begin on that
keycap. Partial player coverage keeps the shelf open, and closing the Builder
immediately reopens it so a route cannot be stranded on an invisible source.
When that shelf is the only visible origin it is a non-collapsible section;
only the redundant physical-panel fallback may fold. Closed fallback geometry
is excluded from endpoint selection. On a multi-channel joystick, the complete
terminal/stem/keycap row selects and inspects that exact direction, and an
unassigned row cannot borrow a sibling direction's hover or route highlight.
This is only a representation change: the I-PAC still speaks HID keyboard
signals, and the same staged bindings remain the runtime authority. “Host
signal” is the protocol-neutral UI term; a keyboard key remains the concrete
signal subtype for this qualified profile. The capture
choices are correspondingly worded as
**Dedicated arcade panel**, **Share unused outputs with Windows**, and
**Observe and pass through**; ordinary keyboards retain their original copy.

An all-Unassigned chart also offers **Design physical panel first**. It leaves
the backend-owned chart and recovery point intact, sends no report, and opens
the blank/arcade/leverless/four-player templates. That supports the first-time
cabinet order without making it mandatory: design physical controls, link them
to terminals, assign keyboard host-signal outputs, review/program/read back, Teach the
wiring, then route through KSX. Physical design is available before keys, but
an unqualified writer keeps full key authoring locked until the reversible
one-terminal qualification write and exact restore both verify. Existing
configured boards can still generate their physical panel directly from the
current chart.

Keyboard sources and keyboard-mode encoders also share **Test simultaneous
inputs**. The bounded observer is scoped to the exact selected source and
shows held, seen, peak, event and dropped-event counts without writing a chart
or a KSX binding. “Peak” means distinct host signals held together—not
physical terminals—because two terminals that emit the same key are
indistinguishable after the encoder. Firmware rollover is not inferred from
ordinary host events: until a transport exposes saturation evidence, Studio
says rollover visibility is unavailable and leaves the physical saturation
acceptance gate open.

Configured firmware and observed wiring remain separate authorities on the
panel itself. Before Teach, the key from the last complete board read can carry
a dim provisional KSX path but never a `data-key` observation. An unwritten
edit renders `current → planned`; its cord remains on `current` until a fresh
post-edit Teach result establishes what Windows actually received, and
`planned` cannot become a live source until program plus readback verifies it.
A matching Teach promotes the same origin without moving the path to another
widget. A mismatch renders `configured ≠ observed`, marks the channel red,
retains the unwritten plan as a separate draft fact and resolves that physical
control's route from the observed Windows key. Every successful write
invalidates prior Teach authority, even when retained text happens to match, so
the fresh readback returns to configured/provisional until Teach runs again.

That invalidation is a pre-write invariant rather than a response-time UI
cleanup. Immediately before either program or restore apply, Studio clears the
verification state of every browser-kept link for the reviewed board, removes
unlinked Teach observations from that exact Windows device and proves the
replacement document reached browser storage. If persistence fails, consent is
cleared and no apply request is sent. This closes the crash window in which the
backend could finish byte verification and settle its durable transaction
journal while the tab disappeared before receiving the response. On reload, a
retained `matched` or `mismatch` label is only a historical Windows observation
until a fresh complete chart re-establishes the firmware side of that
comparison.

The selector-scoped drawing survives device re-enumeration, but Teach authority
does not. A learner-reported Raw Input HID child is first resolved to its
canonical selector; that selector is the primary source proof, while an exact
raw MI_00 device match is only the narrow fallback when canonical resolution is
unavailable. An unresolved or wrong-selector child fails closed. An accepted
observation is persisted against the selected canonical MI_00 instance, so a
byte-identical replacement instance leaves the old hit visible only as history
until Teach runs again. Mapping-generated, unlinked projections remain
separately identified by their staged selector and do not impersonate a Teach
result.

Programmable-encoder routing has a two-sided commit fence.
`[SOURCE crates/ksx-studio/src/server/nocturne.rs;
crates/ksx-api/src/stage.rs; crates/ksx-backend/src/daemon/pipe.rs;
crates/ksx-backend/src/panel_programming/facade.rs;
studio-ui/src/NocturneIsland.ts]` The source pin contains the staged selector,
exact canonical MI_00 instance, board fingerprint and complete chart SHA-256.
Before a bind can stage, the backend resolves one unique boot-keyboard MI_00,
reads the complete chart twice, retains the final exclusive MI_02 session and
holds the machine programming lease through `stage_bind`. This is a read-only
hardware proof: it sends the chart-query reports required to read the encoder
but never sends a chart-programming report or changes EEPROM.

The target pin is an opaque per-slot revision containing the daemon draft
incarnation, mutation generation and content revision. Studio rejects a stale
revision before the slower source proof; the daemon checks it again while
holding the staged-state lock. A source change, target mutation, or even a
byte-identical remove/recreate invalidates the gesture. Conflict confirmation
retains both original pins, while a successful chained bind waits for a newly
served target revision. Key-first assignment keeps its encoder source pin when
the controller endpoint is chosen, Control Surface routing carries the same
target pin, and a process-local Studio fence orders ordinary mapping against
programming and recovery in both directions.

Once Studio publishes the exact-device `pending` generation, it never restores
the pre-write observation snapshot. A refusal before the POST—for example, the
main browser document cannot persist—is provably local while both Web Locks are
held, so Studio may publish `settled` and retain that initiating tab's reviewed
chart and draft; Teach evidence still remains retired. A backend
`mutation_disposition: not-started` is different: it proves only that this
request did not cross packet zero, not that another process holding the
machine-global lease left the board unchanged. Studio therefore publishes the
completion generation but keeps the chart authority locked until a fresh
complete read. Detached, ambiguous, interrupted and completion-publication
failures remain pending and fail-closed. Another tab always retires its old
chart and draft on either generation and performs its own current-chart read.

That recovery read is token-fenced, not merely fresh-looking. The Studio
server registers an apply/restore epoch before its first asynchronous target
check. A recovery chart carrying the same epoch and reviewed board identity
atomically cancels an unseen or queued mutation, or waits until an admitted
mutation has finished, before it reads the hardware. The browser accepts
settlement only when the response echoes the exact epoch, selector and board
fingerprint with `hardware_fence: settled`; an ordinary chart response can
never clear a pending browser epoch. The writer repeats its ledger barrier
inside both Web Locks and uses a per-device compare-and-set, so a second tab
cannot replace the first tab's crash-surviving pending record after waiting for
the locks.

The passive source layer has its own fail-closed startup gate. For a selected
encoder, Studio requests status even when Control Surface Builder is closed and
no physical-panel document exists. Only an explicit `false` recovery result for
the same selector and instance restores chartless mapping-derived signals;
missing fields, a transiently missing device identity, request failure, a busy
machine lease, an unreadable journal or an unresolved transaction keep those
origins unavailable. The backend takes the same nonblocking lease used by
Play/start and hardware maintenance, validates every recovery-tree level as an
ordinary non-reparse object, then reads the exact board marker. It therefore
cannot publish “settled” from the pre-journal interval of an active writer or
from a redirected recovery store.

After a complete authoritative read proves one physical board settled, Studio
removes every obsolete selector-plus-instance alias which pointed at that same
board fingerprint. Aliases for other boards remain locked independently; a
Windows re-enumeration therefore cannot strand a settled board behind its old
instance name or transfer authority to a replacement board.

One physical board terminal is one shared hardware channel. Multiple drawn
panel views may reference that channel, but they cannot carry divergent
expected keys or shared-key consent: changing either in the terminal editor or
one linked view synchronizes every peer. The browser also heals older saved
drafts that violated this invariant before they can produce a hardware plan.

Normal outputs are always reachable. Shifted assignments become mapping
sources only when the chart has a known enabled Shift terminal. They remain
visible but dormant when Shift is known disabled, and visible with unknown
reachability when an opaque vendor byte prevents a truthful decision. Neither
state is counted as a routeable signal. A legacy Keyboard Arranger draft for
an I-PAC is preserved in browser storage but suppressed while that encoder is
selected, so fake QWERTY keys cannot compete with terminal-owned signal nodes.

The editor opens as a focused canvas task. A previously saved overview camera
cannot shrink the 56-terminal form into a miniature: hardware setup raises the
transient view to at least 68%, aligns an oversized form at the beginning of
the signal journey and restores the exact entry camera when focus ends. Route
cords and floating macro cards are presentation-hidden only while this
persistent-hardware workspace is open. Its passive navigator and corner reopen
control are hidden too, so neither can cover a lower-right terminal. The user's
path mode, graph state and navigator preference are not changed. Keyboard focus
reveals lower or upper terminal controls inside the canvas without moving a
pointer target during its click; capture-phase pointer cleanup prevents a
cancelled gesture from disabling later focus reveals.
Detached success or recovery results remain bound to the encoder that produced
them and expose only **Close** after selection changes.

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
| 2026-08-23 16:51 EDT | `codex/ipac-signal-journey` / `edf8fdf` baseline | Completed the encoder-as-hardware UX audit: causal five-stage journey, terminal-owned I-PAC Signals, availability-gated route truth, exact-board draft recovery, shared-terminal invariants, passive wiring test, readable focused setup, keyboard-revealed terminal controls and unobstructed writer actions. Retained the original traceable lasso route projection. | `[MEASURED]` API 107/107, backend panel programming 48/48, Studio render 8/8 and HTTP 139/139 passed. The final complete canvas suite passed 51/51 after the focus-coordinate, capture-lifecycle and navigator-obstruction corrections; its focused blank-board, 56-terminal and writer-qualification gate passed 3/3. Assets rebuilt byte-identically twice at `01092be57893`. Final live browser QA showed 68%, steps I-PAC → Windows keys → KSX → Controller → Game, I-PAC Signals instead of fake QWERTY, no covering graph, macro or navigator layer and no page alert. Independent final review reported no remaining P0–P2 findings. No HID/EEPROM write occurred in this UX slice. |
| 2026-08-23 20:14 EDT | `codex/ipac-signal-journey` / `6f4bcfa` baseline | Added backend-owned friendly I-PAC facts and a compact five-cell Hardware Setup strip: board, firmware, observed input, chart outputs and KSX routes. Firmware `1.56` exists only on the exact registered release-0056 profile; raw USB identity remains visible, vendor mode remains explicitly unqueried, and the WinIPAC `Multi-Mode` label is not inferred. Shared writer constants own release and 56-terminal capacity. | `[MEASURED]` API 108/108, Studio HTTP 139/139 and the complete canvas suite 51/51 passed before final review; after both P2 review fixes, backend panel status passed 8/8, focused HTTP passed 1/1 and focused blank/56-terminal browser flows passed 2/2. Two final Studio builds were byte-identical at build hash `c5e58b8a8a81`. No HID report or EEPROM write occurred. |
| 2026-08-23 22:48 EDT | `codex/panel-encoder-ecosystem` / `6a6de8a` baseline | Completed the six-stage panel flow: design-first blank encoders, chart-generated physical panels, terminal and Windows-key tokens on every channel, truthful current/planned/Teach states, observed-key route authority, and a slot-safe recoverable signal shelf whenever panel endpoints are hidden or incomplete. | `[MEASURED]` Canvas 55/55, SSR/visual 102/102, Studio HTTP 139/139 and docs 3/3 passed. Consecutive Studio builds were byte-identical at build hash `5a41f6c456d5`; independent P0–P2 re-review found no remaining issue. No HID report or EEPROM write occurred in this UX slice. |
| 2026-08-24 00:54 EDT | `codex/panel-encoder-ecosystem` / `e0bb205` baseline plus reviewed worktree | Closed the first signal-authority and recovery races: fresh Teach evidence outranks an unwritten plan, apply invalidation must persist before USB, transaction and Teach ownership are exact selector plus Windows instance, and settled reads clear obsolete aliases for only that physical board. A backend `not-started` response retires the request's browser epoch but deliberately keeps its target behind a fresh-read gate; it does not restore pre-write Teach evidence. Passive recovery checks share the programming/Play lease and reject unsafe recovery paths; transient probes retry finitely while durable recovery never polls. The served Input source shell now adopts one client-owned I-PAC signal shelf without duplicating keyboard geometry. | `[MEASURED]` Backend panel programming 54/54, API 108/108, Studio HTTP 139/139 and the complete browser suite 181/181 passed before the final ownership audit; the affected canvas suite then passed 58/58 and SSR/visual passed 102/102 after those review fixes. This row predates the later server-token fence recorded below. Backend and Studio all-target clippy passed with warnings denied; docs 3/3 and formatting passed. No HID/EEPROM report was sent during review. |
| 2026-08-24 06:25 EDT | `codex/panel-encoder-ecosystem` / `e0bb205` baseline plus final reviewed worktree | Completed the mapping commit boundary: canonical learner resolution, exact source selector/MI_00/board/chart proof, retained exclusive MI_02 session plus programming lease, opaque per-slot incarnation/mutation/content revision, a second daemon lock-held target check, conflict and chained-action pin retention, key-first and Control Surface target fencing, and process-local ordering between binds and programming/recovery. Browser regression mocks now model successful writes with a new served revision; programmable-source tests establish chart authority, fixture device selection is isolated and hydration waits for distinct final SVG geometry. | `[MEASURED 2026-08-24 06:25 EDT]` API 110/110, focused panel programming 56/56, focused daemon pipe 75/75 and backend 707 passed / 1 ignored were green; the final touched-package run also passed API, backend and Studio tests. The complete browser matrix passed 189/189, docs passed 3/3, formatting and warnings-denied touched-package clippy passed, and two consecutive Studio builds were byte-identical across 48 assets at build hash `60bbe320730cb7e31d594813c279512f25890f11ace9b3ee36fb871809cf1e94`. Independent frontend, backend and documentation reviews found no remaining P0–P2 issue. No live HID chart query, programming report or EEPROM write was sent during this review. |
| 2026-08-24 09:25 EDT | `codex/panel-encoder-ecosystem` / `d9de536` baseline plus audited worktree | Completed the shared keyboard/keyboard-mode-encoder signal diagnostic and its Studio/CLI surfaces: exact-device bounded observation, held/seen/peak/event/drop evidence, exact-generation cancel/recovery across lost responses and tabs, and one causal `physical control → terminal → host signal → KSX → controller → game` presentation. The original independently traceable lasso routes remain; semantic route rows supplement them. Review then closed cross-process Play/programming exclusion, late-Play acceptance, slow-resolver accumulation, unresolved-release rebaseline, modal Escape ownership and edge-clipped processor controls. | `[MEASURED 2026-08-24 09:25 EDT]` API 112/112, Raw Input 5/5, backend 730 passed / 1 ignored, Studio HTTP 150/150 and the complete app package 105/105 passed. Browser canvas passed 71/71 and the other 15 browser suites passed 123/123. Formatting, diff checks and warnings-denied all-target clippy for every touched crate passed. Consecutive Studio builds were byte-identical across 48 assets at build hash `757c3f7eb24a1111a74641def1d8259140edd773723c29fdc50216fe23b30bb8`; independent P0–P2 review found no remaining actionable issue. No HID query, programming report or EEPROM write was sent in this audit slice; representative physical signals, power-cycle persistence, rollover/saturation, deliberate mode switching and interrupted physical-write behavior remain measured-hardware gates. |
| 2026-08-24 17:20 EDT | `codex/panel-encoder-ecosystem` / reviewed worktree | Added exact configuration-interface contention UX. Only Windows sharing violation 32 becomes stable refusal `panel-interface-busy`; unrelated open failures remain generic. Chart, program-plan and restore-plan envelopes preserve the backend remedy, Studio explains that keyboard input can continue, and Read/Review/Restore retry in place without exposing a write from an unread or unplanned state. The real-environment WinIPAC process notice remains advisory and never closes another application. | `[MEASURED 2026-08-24 17:20 EDT]` API 113/113, backend 733/733, Studio library 291 passed / 1 ignored, Studio HTTP 153/153, docs 5/5 and the complete 198-test browser matrix passed; the strengthened program/restore contention flow then passed its focused browser rerun. Formatting and warnings-denied touched-package clippy passed. Two consecutive asset builds were byte-identical across 52 generated files at graph `046eb278003e` and build hash `e007ae37ff9c`. Independent runtime, frontend/docs and release-pipeline reviews found no remaining P0–P2 production defect after the wording and negative-gate corrections. One read-only live chart query was performed earlier while WinIPAC was open; no persistent chart write or EEPROM mutation occurred. |

## Current pickup

The end-to-end writer, Clear/Recommended plans, full terminal editor, portable
saved-layout model and six-stage signal journey are integrated on
`codex/panel-encoder-ecosystem`. The canvas now supports design-first blank
boards and chart-generated panels, renders each physical channel as
`control → terminal → Windows key`, distinguishes current/draft/Teach truth,
and keeps slot-safe fallback sources available whenever the panel cannot own a
visible route. The exact connected I-PAC is already qualified; its last
verified on-board image was the fully readback-verified Recommended chart at
`43CAD3F30B900416531D3A65A3799405F3094E34BE0E37E467079D163C8C1D87`.
The next agent must not rerun qualification or restore the original chart as
if the hardware gate were still pending. This UX audit issued no hardware
report and did not alter that chart.

**Configure device** now presents the exact registered firmware as `1.56` beside
the board, observed keyboard-compatible input, complete terminal/key coverage
and dynamic KSX route count. The firmware label is a backend-owned profile
fact, not a browser conversion of `bcdDevice`; exact vendor mode and the
WinIPAC `Multi-Mode` family label remain deliberately unclaimed.

The remaining cabinet QA is narrower: press representative controls while
Teach or an input observer is running; then power-cycle/re-enumerate the board,
reread the chart and confirm the same hash plus representative physical
signals. NKRO/saturation and deliberate mode-switch behavior are separate
measurements. The final browser/fixture rerun and independent P0–P2 code review
are complete; neither is allowed to stand in for those remaining physical
measurements. The implementation contract to preserve is one causal pipeline:
physical control → I-PAC terminal → host signal (`Keyboard · Key` here) → KSX transform/macro → virtual
controller → game. A control-surface drawing is optional metadata, never a
substitute for the board chart or the Windows signal.
