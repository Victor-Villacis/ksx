# Encoder canvas approval gate

Status: **candidate — automated representation simulation complete; awaiting human visual review**

Candidate branch: `codex/redesign/encoder-board-refinement`

Contract date: 2026-08-29

This gate answers one question: is the encoder canvas truthful and usable enough
that higher-fidelity board artwork can replace its schematic body without
changing the information architecture?

It does not admit new hardware protocols. Visual-profile admission is a
separate, per-device decision below.

Two surfaces share the renderer but have deliberately different lifecycle
contracts:

- The temporary **Encoder profile lab** (`◇ Encoders`) is a passive research
  harness. Opening it and changing connected/reference selections performs no
  hardware request. A chart read or signal observation begins only from its
  explicit controls. Catalog selections can never authorize a device request.
- The product workbench surface is created when the user chooses a connected
  encoder in **+ Devices**. The Add action persists that exact selector as
  workbench membership and, for an exact profile with an admitted chart reader,
  schedules one automatic read-only chart attempt. It does not write, map,
  claim, stage, or reconfigure the encoder. The visible **Refresh stored
  assignments** action is the deliberate reread after the user changes the
  board in WinIPAC or another vendor utility.

The lab proves profiles and edge states; the + Devices surface is the product
behavior being approved. A statement about one must not silently become a
requirement for the other.

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

Both surfaces keep three facts visibly separate:

1. **Terminal identity** comes from an admitted visual profile. Its stable join
   key is `terminal_id`; its printed name is `terminal_label`.
2. **Configured emission** appears only after a validated read against one exact
   connected-device selector. In the research lab that read is explicit. On the
   product workbench the first attempt is automatic only on the current Add
   gesture; persisted restore and authoritative reconnect wait for visible
   Read, and later attempts use Refresh/Retry. It describes what the encoder has
   stored, not what is physically wired.
3. **Observed host signal** appears only after an explicit, bounded observation
   of one exact connected device. It is never assigned to a terminal and never
   used to infer capacity or wiring.

The diagram, facts, provenance, and detailed roster must tell the same story.
Catalog and manual selections in the research lab are reference drawings only
and never authorize a hardware request. Unknown devices remain unknown until
the user supplies labels or KSX admits an exact profile.

## Product membership and read lifecycle

The + Devices Add action owns browser arrangement state, not daemon or hardware
state. The exact selector and canvas geometry are persisted; chart values and
observation sessions are not. On a page reload, a remembered encoder that is in
the authoritative served roster is remounted at its saved geometry with a
visible **Read stored assignments** action. A page lifecycle never authorizes a
hardware transaction.

An authoritative scan that no longer contains the encoder unmounts it but keeps
its remembered membership and geometry. If that exact selector returns, KSX
remounts it in the same place and waits for visible Read. Reconnection is served
truth, not renewed authorization for an exclusive configuration transaction. A
failed/non-authoritative scan is unknown—not proof of absence—so it neither
forgets nor falsely removes the product surface; hardware actions remain
blocked until connection truth is restored. Removing the encoder through
+ Devices removes membership while retaining its last geometry for a later
deliberate re-add.

Automatic means one admitted read attempt per deliberate + Devices Add—not per
mount, page load, BFCache restore, scan refresh, or reconnect. KSX does not poll
or monitor WinIPAC. After external configuration changes, the user presses
**Refresh stored assignments**. A failed automatic attempt becomes a truthful,
explicit Retry state; it never paints a partial or cached roster.

## Global information-architecture gate

Approve the information architecture only when all of these are true:

- [ ] Opening the research lab and changing its profiles starts no chart read,
  observation, firmware write, backup, restore, bind, or mapping request.
  Cancelling an exact observation generation already owned by this lab is the
  sole cleanup exception.
- [ ] Adding an admitted connected encoder through + Devices performs exactly
  one automatic read-only chart attempt. It starts no observation, firmware
  write, backup, restore, bind, mapping, staging, or daemon-selection request.
- [ ] Product membership and geometry survive reload. Authoritative absence
  unmounts without forgetting; reconnect remounts at the saved geometry and
  waits for visible Read. Reload, BFCache restore, scan refresh, and reconnect
  perform no chart transaction. A non-authoritative scan is represented as
  unknown and does not erase the remembered board.
- [ ] Every automatic, Refresh, Retry, or research-lab chart read posts exactly
  `{ "selector": <raw exact selector> }` to `/api/panel/chart`, and displays a
  complete atomic roster or nothing. Refresh is visible after a successful
  product read and is the only reread promised after external configuration.
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
| I-PAC2 | 32 physical screw terminals plus distinct optical and PACLink interfaces | Not admitted without a verified fixture or hardware run | Manufacturer-reference topology |
| Ultimate I/O | 48 physical harness channels; 96 LED outputs and six shared optical-capable inputs stay auxiliary | Not admitted | Manufacturer-reference topology |
| Mini-PAC 32 / Mini-PAC FOUR | 32 / 56 physical harness channels | Not admitted | Requires variant confirmation unless future backend facts narrow the family |
| J-PAC family | 27 always-present logical cabinet controls plus four variant-only controls and a board-level JAMMA edge | Not admitted | Family-safe logical reference |
| Brook UFB Fusion | 18 logical controls; physical connector count deliberately not asserted | Not admitted | Manual legacy reference only |
| GP2040-CE | 18 logical controls; remappable, board-specific GPIO deliberately not asserted | Not admitted | Manual firmware reference only |
| Legacy I-PAC and U-HID | No registered visual topology | Not admitted | Known-family generic fallback |
| Unknown keyboard-compatible encoder | User-declared labels only | Never inferred from key presses | Unknown fallback |

A new profile needs an exact identity rule, authoritative terminal evidence, a
complete ordered roster fixture, contradiction tests, and—before enabling chart
read—a protocol fixture or a recorded hardware run for the exact admitted
release. Recognition alone must not expose unsupported protocol capabilities.

## Automated representation simulation

`studio-ui/pwtest/redesign-devices.test.mjs` mounts every registered case through
the real product renderer: I-PAC4 (56), I-PAC2 (32), Ultimate I/O (48), both
Mini-PAC variants (32/56), J-PAC (31 visible, 27 always present), Brook (18),
GP2040-CE (18), and the unknown fallback (zero asserted terminals). The test is
an acceptance matrix rather than a generated echo of the registry, so a new or
changed profile fails until its expected capacity, evidence, grouping, identity
scope, connector grammar, and reachability are reviewed.

For every known drawing the browser simulation checks complete and unique row
IDs, group counts, physical-versus-logical identity, variant-only rows, one
roving keyboard entry, disjoint >=44px targets, target-centre ownership, board
bounds, processor clearance, connector-specific glyphs, interface-body/label
clearance, local SVG-definition resolution, and the absence of a
configuration-read action on unprofiled hardware. It also mounts two unresolved
Mini-PAC widgets together to prove that variant radio groups and focus cannot
cross between boards.

The visual grammar is evidence-sensitive:

- screw profiles draw screw heads;
- harness profiles draw keyed channel sockets and profile-specific abstract
  harness bodies, never screws or invented board-level pin counts;
- I-PAC2 keeps separate optical and PACLink bodies outside the 32 switch targets,
  and Ultimate I/O marks only the six documented switch/optical dual-role
  channels;
- J-PAC shows logical family routes plus a separate JAMMA-edge motif;
- Brook and GP2040-CE show logical controls, not invented PCB pins;
- unknown devices show only declared labels and observed host signals.

This follows the WAI-ARIA composite-widget practice of one tab-sequence entry
with managed directional focus and WCAG 2.2 target/contrast guidance. Passing
the simulation does not replace the human review scenarios below.

## Human review scenarios

Use the redesign preview and review at Fit, 100%, overview zoom, 420-pixel narrow
viewport, Windows High Contrast/forced colors, keyboard-only navigation, and a
coarse-pointer/touch emulation.

1. Open the temporary **◇ Encoders** research lab. Confirm the default connected
   I-PAC4 drawing is clear, profile/catalog changes perform no hardware action,
   and its chart read remains explicit.
2. Close the lab, open **+ Devices**, and Add the connected I-PAC4. Confirm the
   product surface—not the lab—appears and makes exactly one automatic read-only
   chart attempt. Confirm all 56 terminals remain legible, normal/shifted values
   are distinguishable, freshness is visible, and the UI never claims physical
   wiring or mapping.
3. Reload with the encoder remembered, then test authoritative unplug/reconnect.
   Confirm membership and geometry survive, absence is honest, reconnect returns
   the same widget to the same place, and neither remount makes a chart request.
   Confirm the visible Read action is available after connection truth returns.
   Repeat with a refused scan and confirm unknown is not treated as absence.
4. Change assignments in WinIPAC, return to KSX, and activate **Refresh stored
   assignments**. Confirm no background watcher claim is made, exactly one new
   request occurs, the complete roster changes atomically, and Retry is explicit
   if the read fails.
5. Observe emitted signals. Press multiple wired controls, duplicate-emission
   controls, arrows, numbers, and Enter. Confirm signals stay device-scoped,
   canvas shortcuts do not fire while Capture focus is active, and Done stops
   only the owned generation.
6. In the research lab, switch to catalog profiles. Confirm read/observe actions
   are absent and their reference provenance is explicit.
7. Select an ambiguous family and an unknown encoder. Confirm no canonical board
   is drawn before variant confirmation and observed keys do not create terminal
   identities. Confirm the manual fallback uses hardware labels, not emitted
   key names.
8. Change or remove the selected device during each operation. Confirm stale
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
