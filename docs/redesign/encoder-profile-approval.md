# Encoder canvas approval gate

Status: **candidate — awaiting human visual review**

Candidate branch: `codex/redesign/encoder-visual-lab`

Contract date: 2026-08-28

This gate answers one question: is the encoder canvas truthful and usable enough
that higher-fidelity board artwork can replace its schematic body without
changing the information architecture?

It does not admit new hardware protocols. Visual-profile admission is a
separate, per-device decision below.

## How to approve this candidate

1. Build the candidate and run `node --test --test-concurrency=1
   studio-ui/pwtest/redesign-devices.test.mjs` plus `cargo test --locked -p
   ksx-studio`. Automated checks establish the request, identity, lifecycle,
   accessibility, and layout invariants; they do not replace visual judgment.
2. Open the isolated candidate preview with the I-PAC4 attached and complete
   every human review scenario below. A failed or unclear scenario is a failed
   gate, not an exception to wave through.
3. Enter the reviewed commit, reviewer, date, physical board, result, and any
   exceptions in the approval record. Mark the global checklist only from what
   was actually verified.
4. Admit configuration read per profile separately. The global layout can be
   approved while every unverified release remains topology/reference-only.

Approval means the fact model, actions, terminal slots, evidence separation,
and failure behavior are stable. It does not approve photoreal styling; it
allows that styling to begin without changing those contract surfaces.

## The contract to approve

The surface keeps three facts visibly separate:

1. **Terminal identity** comes from an admitted visual profile. Its stable join
   key is `terminal_id`; its printed name is `terminal_label`.
2. **Configured emission** appears only after an explicit read against one exact
   connected-device selector. It describes what the encoder has stored, not
   what is physically wired.
3. **Observed host signal** appears only after an explicit, bounded observation
   of one exact connected device. It is never assigned to a terminal and never
   used to infer capacity or wiring.

The diagram, facts, provenance, and detailed roster must tell the same story.
Catalog and manual selections are reference drawings only and never authorize a
hardware request. Unknown devices remain unknown until the user supplies labels
or KSX admits an exact profile.

## Global information-architecture gate

Approve the information architecture only when all of these are true:

- [ ] Opening the lab and changing profiles starts no chart read, observation,
  firmware write, backup, restore, bind, or mapping request. Cancelling an exact
  observation generation already owned by this lab is the sole cleanup exception.
- [ ] A chart read requires a visible explicit action, posts exactly
  `{ "selector": <raw exact selector> }` to `/api/panel/chart`, and displays a
  complete atomic roster or nothing.
- [ ] The returned terminal IDs match the selected profile's complete unique ID
  set. A missing, duplicate, extra, invalid-hash, stale, or mismatched response
  is withheld rather than partly painted.
- [ ] A zero byte retains the truthful ambiguity "nothing stored—or a macro";
  unsupported bytes and board-level Shift state remain explicit.
- [ ] Observation requires a visible explicit action, posts the raw exact
  selector and a 30-second bound, and retains exact generation ownership for
  polling and cancellation. Local requests are time-bounded.
- [ ] A foreign/replaced generation is never cancelled. A lost poll or cancel
  retains a retryable exact Stop action. Selection change, device disappearance,
  lab removal, and page hide release an owned generation best-effort.
- [ ] Chart read and observation are mutually locked. Signals never become
  terminal rows and never change the profile topology.
- [ ] Device/profile changes clear stale configuration, observation, candidate
  confirmation, and manually declared evidence when identity facts change.
- [ ] Keyboard focus survives polling. Capture and Done form a two-stop Tab
  loop; ordinary Enter and captured encoder keys cannot activate canvas
  shortcuts or Done. Ctrl/Cmd+Enter deliberately activates Done; Esc releases
  capture focus without stopping or surrendering an owned generation; and the
  UI warns that Windows/system shortcuts cannot be contained.
- [ ] Screen reader announcements, canvas zoom tiers, narrow viewport, forced
  colors, and coarse-pointer targets remain usable.
- [ ] Source and browser contract tests pass, and one reviewer completes the
  visual scenarios below against the candidate commit.

## Per-profile admission

| Profile | Topology drawing | Configuration read | Current decision |
| --- | --- | --- | --- |
| Ultimarc I-PAC4, firmware 1.56, `D209:0430`, PAC256 v1 | 56-terminal measured roster | Hardware-proven | Candidate for full admission |
| Other I-PAC2/I-PAC4 releases, Mini-PAC, J-PAC, Ultimate I/O | Vendor-reference topology where registered | Not admitted without a verified fixture or hardware run | Topology/reference only |
| Brooks, Arduino/Raspberry Pi projects, Xin-Mo, Zero Delay, and other HID encoders | Family/profile only when evidence is unambiguous | Not admitted | Reference or unknown fallback |
| Unknown keyboard-compatible encoder | User-declared labels only | Never inferred from key presses | Unknown fallback |

A new profile needs an exact identity rule, authoritative terminal evidence, a
complete ordered roster fixture, contradiction tests, and—before enabling chart
read—a protocol fixture or a recorded hardware run for the exact admitted
release. Recognition alone must expose unsupported protocol capabilities.

## Human review scenarios

Use the redesign preview and review at Fit, 100%, overview zoom, 420-pixel narrow
viewport, Windows High Contrast/forced colors, keyboard-only navigation, and a
coarse-pointer/touch emulation.

1. Open **Encoders**. Confirm the default connected I-PAC4 drawing is clear and
   no hardware action has occurred.
2. Read its configured emissions. Confirm all 56 terminals remain legible,
   normal/shifted values are distinguishable, proof hash and freshness are
   visible, and the UI never claims physical wiring.
3. Observe emitted signals. Press multiple wired controls, duplicate-emission
   controls, arrows, numbers, and Enter. Confirm signals stay device-scoped,
   canvas shortcuts do not fire while Capture focus is active, and Done stops
   only the owned generation.
4. Switch to catalog profiles. Confirm read/observe actions are absent and their
   reference provenance is explicit.
5. Select an ambiguous family and an unknown encoder. Confirm no canonical board
   is drawn before variant confirmation and observed keys do not create terminal
   identities. Confirm the manual fallback uses hardware labels, not emitted
   key names.
6. Change or remove the selected device during each operation. Confirm stale
   evidence clears and no foreign observer is cancelled.

## Approval record

Do not mark this section approved from automated tests alone.

- Approved candidate commit: _pending_
- Reviewer: _pending_
- Review date: _pending_
- Physical encoder used: _pending_
- Result: **pending**
- Notes / exceptions: _pending_

Once the global gate and the first admitted profile are signed, photoreal or HD
PCB bodies may replace only the board-body layer. Slot geometry, terminal IDs,
labels, emission states, focus behavior, and provenance remain contract surfaces;
any change to those reopens this gate.

## Research and licensing record

QtPyUltimarc at commit
[`6f1f5a285201143e6260f0a1451ca469a54ee768`](https://github.com/katie-snow/QtPyUltimarc/tree/6f1f5a285201143e6260f0a1451ca469a54ee768)
corroborates readback work across I-PAC2, I-PAC4, Mini-PAC, J-PAC, and Ultimate
I/O. It is GPL-3.0-only. A noncommercial use does not remove GPL's distribution
conditions, so KSX uses that repository as research evidence and independently
implements and verifies protocol behavior; no QtPyUltimarc implementation,
tables, schema, comments, or tests are copied into this MIT/Apache codebase.

Its current tables also contain values that require independent checking, and it
does not provide the release gating, raw captures, or transport/readback tests
needed for KSX admission. Research corroboration is therefore not hardware
admission. The measured I-PAC4 fixture and backend contract remain the authority
for the one chart-read profile enabled here.
