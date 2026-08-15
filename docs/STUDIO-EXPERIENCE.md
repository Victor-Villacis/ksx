# KSX Studio experience specification

This document is the product-level contract for KSX Studio: what the experience
is for, how its screens fit together, how Mapping behaves, and how the current
source must be validated before it is described as release-proven.

> **Status snapshot — 2026-08-15.** The live worktree contains the experience
> described below in TypeScript, CSS, Rust rendering seams, tests, and CI
> configuration. In this document, **implemented / source-ready** means that
> the behavior is represented in those current source files. It does not mean
> the current worktree has compiled on a clean runner, that generated assets
> have been independently observed to match the sources, or that a person has
> completed the clean-machine Windows journey. Those are separate gates.

The existing product contracts remain authoritative for safety and backend
behavior: [FIRST-RUN.md](FIRST-RUN.md), [SURFACES.md](SURFACES.md),
[MAPPER-UX.md](MAPPER-UX.md), [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md), and
[GATES.md](GATES.md). This file concentrates their product experience into one
reviewable screen and interaction specification.

## 1. Product audit

### Outcome

The current Studio is a coherent local product workbench, not a collection of
diagnostic pages. Its strongest decision is a stable four-stage journey with
advanced surfaces demoted behind one Tools control. Its second strongest
decision is staging: a person can choose hardware, controllers, mappings, and
capture behavior without silently writing configuration or plugging a pad.

The experience is source-ready, but it is not yet proven by the current
compiled CI observation. The words “implemented,” “green,” and “shipped” must
not be treated as synonyms.

### What is working in the current source

- **One navigable product story.** Keyboard → Controller → Mapping → Play is
  visible on every Studio route. On guided Setup, its server-owned markers
  show done, next, blocked, ready, or active with an accessible explanation;
  it remains navigation rather than a locked wizard.
- **Clear authority boundaries.** Browsing, selecting, and staged mapping are
  non-persistent. Save crosses the disk boundary. Play starts the staged value.
  Keyboard preparation is an explicit, separately consented machine action.
- **Truthful failure states.** An unread device, pad, preset, or daemon read is
  not rendered as an empty result. The page says the read failed, what remains
  unchanged, and how to recover.
- **A serious Mapping surface.** Controller art, binding inspector, physical
  key inventory, multi-key bindings, multi-select, turbo, macros, recovery,
  staged edits, saved edits, and live input echo share one screen.
- **Safety is visible before action.** Split/freeze, the LeftCtrl escape hatch,
  output-driver readiness, keyboard preparation, and Save-versus-Play are
  stated before the action they qualify.
- **Progressive enhancement is real.** The first paint is server-rendered.
  Ordinary forms preserve core reads and writes without JavaScript; hydration
  adds polling, direct learning, live echo, dialogs, selection, and toasts.
- **The visual system is systemic.** Type, spacing, color roles, state roles,
  focus, motion, touch geometry, light/dark themes, and responsive behavior are
  tokenized rather than restyled per screen.

### Remaining product and validation risks

| Priority | Finding | Required response |
| --- | --- | --- |
| P0 | The embedded Forma assets have been regenerated locally from the live TypeScript/CSS, but that result and the current source/CI workflow have not yet been independently observed on a clean runner. | Reproduce the assets through the authorized clean-runner build, compile and test, verify the manifest/source seam, inspect the complete screenshot artifact, and record the run. |
| P0 | Gate 4’s fresh standard-user Windows journey and real-controller/game proof remain unrun. | Keep release language narrower than “customer proven” until the exact CI-built installer completes Gate 4. |
| P1 | The browser screenshot job is structural and artifact-producing, intentionally not an exact pixel-baseline gate. It publishes a SHA-256/dimensions manifest, but default-route screenshots do not cover every meaningful state below. | Keep the structural gate and manifest, add deterministic state fixtures, and require human visual review. |
| P2 | The live SSE envelope has no origin or generation token. Current Mapping code compensates by clearing ledgers at every observable boundary and requiring a fresh map/session handshake. | Preserve the fail-closed handshake now; add explicit frame provenance before calling live echo cryptographically or protocol-level bound to a setup. |
| P2 | Passive press-to-select remains polish rather than a current claim. Today the primary edit grammar is select a control, then press a key. | Do not claim that an arbitrary physical press selects its existing control until that interaction is implemented and tested. |
| P3 | Mobile is responsive, not a separate mobile product, and Studio remains loopback-only. | Optimize phone use for diagnostics first. LAN access waits for pairing-token design and guard changes. |

## 2. Experience principles

1. **The screen shows backend truth; it does not invent machine state.**
2. **A refused read is an unavailable state, never an empty state.**
3. **Choosing a device is not preparing it.**
4. **Mapping a staged setup is not saving it.**
5. **Saving is not playing, and playing need not save.**
6. **Every machine-changing action names its consequence before consent.**
7. **Every success report is followed by a fresh read of the resulting state.**
8. **Raw device paths and provider errors belong in Support or Technical
   details, not in the main customer sentence.**
9. **The escape hatch is product copy, not optional help text.**
10. **A control that cannot act must either explain why or be paired with the
    explanation; silence is not a disabled state.**

## 3. Information architecture

### Primary rail

| Stage | Destination | Purpose | Persistence boundary |
| --- | --- | --- | --- |
| 1 · Keyboard | /start#keyboard | Discover, identify, and choose the physical keyboard or panel. | Selection changes the in-memory stage only. |
| 2 · Controller | /start#controller | Add a persona and starting layout for each player. | Controller choices remain staged. No pad is plugged. |
| 3 · Mapping | /map, or /map?target=stage&slot=N | Author controls, keys, turbo, and macros for one player at a time. | Saved target writes the preset; staged target changes only the daemon-held draft. |
| 4 · Play | / and the /start ready check | Save for later, start the current staged setup, or operate a saved session. | Save writes without starting. Play starts without implicitly saving. |

The numbered rail is always visible. Experts may jump directly to any stage;
the interface does not trap them in a next/back wizard. Guided Setup composes
its progress state on the server from the staged device, controller, mapping,
capture, output-backend, and session facts. A compact badge shows **done**,
**next**, **waiting**, **blocked**, **ready**, or **active**; the same link
carries the full explanation for assistive technology. Page cards retain the
detailed recovery action rather than duplicating business logic in the rail.

### Tools

| Label | Route | Job |
| --- | --- | --- |
| Test inputs | /check | Read-only live controller and key feedback. |
| Game library | /profiles | Create, switch, update, rebase, and delete saved launch profiles. |
| Hardware | /devices | Read, pick, remove, and recover device identities. |
| Virtual controllers | /pads | Inspect ViGEm pads, spawn bounded test pads, and prune stale pads with explicit confirmation. |
| Import & recovery | /setup | Maintain the saved configuration, prove a press, export, dry-run import, and perform advanced recovery. |

Tools are one deliberate action away, but they do not compete with the
four-stage journey in the top rail.

### Two setup surfaces with different contracts

- **/start is a staged proposal.** It does not seed its draft from the saved
  configuration, and it does not write until Save.
- **/setup is saved-configuration maintenance.** Each accepted action is a
  complete backend act; there is no half-committed multi-page wizard.

Making the pages visually related is useful. Making their persistence rules
look interchangeable is a defect.

### Shared shell

Every route uses the same shell:

- ksx Studio brand;
- numbered workflow rail;
- Tools disclosure;
- live state pill using word, dot, and color;
- page hero stating the outcome;
- main content ordered from actionable truth to quiet system detail;
- footer with refresh/source facts rather than primary instructions.

## 4. The four-stage journey

### Stage 1 — Keyboard

Goal: “Choose the physical thing I am turning into controls.”

The screen scans on arrival, lists ordinary keyboards first, and keeps unusual
HID-capable devices behind **Other devices (optional)**. Rows use a human name
as the primary identity. Transport, capabilities, and caveats are secondary;
raw paths are inside Technical details.

The current source implements **Identify by pressing a key** through the
daemon-owned learner rather than a competing local keyboard observer. The
handler binds the result to the exact learner generation, passes the observed
interface identity to MachineSource for resolution against the current board
inventory, then makes the same reversible staged choice as an ordinary row.
The visible wait is bounded to 10 seconds. It changes no driver, writes no file,
and starts no controller. That end-to-end source path still requires clean CI
and physical proof with a real held WinUSB panel.

Any keyboard already held by KSX appears above the journey regardless of the
current selection, with a separately confirmed way to return it to Windows.
This is the road home after a restart or abandoned setup.

Completion: one exact keyboard is selected in the stage. Selection itself
changes no Windows driver.

### Stage 2 — Controller

Goal: “Choose what the game should see.”

The person selects a supported controller persona and a starting layout, then
adds it as a player. Existing staged controllers show player, persona, XInput
impact, preset, binding count, Map controls, change, and remove actions.

Capacity and capability are derived from the build and staged set. The UI must
not pretend all personas consume the same backend or that the fifth Xbox-style
pad is equivalent to an additional non-XInput persona.

Completion: every desired staged player has a supported persona and starting
layout. No virtual controller exists yet.

### Stage 3 — Mapping

Goal: “Make the controller match this panel.”

The start screen offers a layout and links each player to the complete mapper.
For the staged target, bindings, multiple keys, turbo, and macros remain in
the daemon-held draft. A refusal leaves the draft unchanged.

After mapping, the required split/freeze question is asked in customer terms:

- **Split:** mapped keys become controller input; unused keys can still type or
  serve another player.
- **Freeze:** while Play is active, other keys on that keyboard are ignored.

The exact escape-hatch and scope sentences remain visible with this choice.

Completion: the intended controls are mapped and split/freeze is answered.

### Prerequisites before Stage 4

Output readiness is derived from the personas actually staged. A known missing
or unread required output disables Play but never Save. The remedy names the
installer; Studio does not silently install a driver from this surface.

Keyboard capture preparation is separate from device selection and appears as
a Play prerequisite after output readiness. Preparing requires:

1. confirmation that a different keyboard was connected and tested;
2. confirmation that the selected keyboard will stop normal typing until
   Release, including the identical-device warning; and
3. consent to the machine-local signing certificate.

Only the fixed server/provider path chooses the backend and interprets the
elevated result. A stale, ambiguous, unsupported, shared-hardware-ID, or last
usable keyboard is refused without changing the stage.

### Stage 4 — Play

Goal: “Use this exact setup now, keep it for later, or both.”

The ready check presents two equally explicit decisions:

- **Save this setup** writes it for later and starts nothing.
- **Start playing** uses the exact current stage and saves nothing.

If another session is active, replacing it is stated before Play. Guide/Home
links to the relevant Windows Game Bar setting rather than changing it.
Starting over discards only the stage.

The / route is the everyday operator surface for saved setups: it shows the
gameplay state at cabinet distance, Start or Stop/Reload, active duration,
capture/output facts, the emergency release, virtual-pad inventory, launch
profiles, and quiet system evidence.

## 5. Screen mental wireframes

These diagrams describe hierarchy and reading order, not pixel dimensions.

### Guided setup

~~~text
┌ ksx Studio ─ [1 Keyboard] [2 Controller] [3 Mapping] [4 Play] ─ Tools ─ state ┐
│ Guided setup                                                                │
│ Turn your keyboard into a controller                                        │
│ [Nothing changes when you browse] [Hardware changes ask first] [Exact setup] │
├ Recovery: keyboards KSX is holding, when any exist                           ┤
├ Step 1 · Hardware                                                            ┤
│ Identify by pressing a key · device rows · Other devices · Rescan            │
├ Step 2 · Virtual controller                                                  ┤
│ staged players · Map controls · change/remove · add persona/layout            │
├ Step 3 · Mapping                                                             ┤
│ choose layout · inspect layout expectations · open complete mapper            │
├ Required choice: Should this keyboard keep typing?                            ┤
│ Split / Freeze · escape hatch · session-only scope                            │
├ Output readiness warning, only when true                                     ┤
├ Keyboard capture Prepare / Release / blocked card, exactly one state          ┤
├ Step 4 · Ready check                                                         ┤
│ [Save this setup]                         [Start playing]                      │
│ Game Bar remedy · Start over                                                  │
└ Secondary disclosures: autostart and advanced paths                           ┘
~~~

### Mapping on a wide screen

~~~text
┌ shell: workflow rail · Tools · session state ┐
│ Step 3 · Mapping Studio                      │
│ Select a control. Press a key. Keep moving.  │
├ conditional banners: no daemon / Play active / paused / target mismatch       ┤
├ sticky player rail + current persona/preset identity                          ┤
├ one-line learn hint + disclosure                                               ┤
├ Physical keyboard key shelf                                                    ┤
├───────────────────────────────────────┬───────────────────────────────────────┤
│ Controller map                      │ Binding inspector                       │
│ persona art + interactive zones     │ one row/control + key chips + sharing  │
│ live held/press feedback            │ add/remove/clear/turbo accelerators     │
├───────────────────────────────────────┴───────────────────────────────────────┤
├ Macros disclosure, closed on arrival                                          ┤
├ Preset/file identity, slot usage, restore and destructive actions              ┤
└ toast/Undo stack; binding dialog docks as a right-side sheet                   ┘
~~~

### Mapping on a narrow screen

~~~text
┌ wrapped shell + horizontally scrollable workflow rail ┐
├ player rail, horizontally scrollable                  ┤
├ physical key shelf                                    ┤
├ controller map                                        ┤
├ binding inspector                                     ┤
├ macros disclosure                                     ┤
├ preset/file actions                                   ┤
└ centered binding sheet + viewport-bounded toasts/selection bar ┘
~~~

Controller precedes inspector in DOM order, so the narrow layout and assistive
technology retain the same reading sequence as the desktop composition.

### Play

~~~text
┌ shell: [1] [2] [3] [4 Play] · Tools · running/idle/no daemon ┐
│ Your controllers, ready when you are · Test controller       │
├ Gameplay session hero                                        ┤
│ large present-tense state · Start OR Stop + Reload            │
│ duration · keyboard capture · outputs · emergency release     │
├ ViGEm virtual pads                                            ┤
├ Profiles / launch game                                       ┤
└ System: ViGEmBus · HIDMaestro · Interception · autostart · daemon · config ┘
~~~

## 6. Mapping interaction specification

### Context and targeting

- The slot rail always names the player, persona, keyboard, and preset being
  edited.
- Switching a slot clears multi-selection and macro draft state.
- Saved binding-only edits can hot-swap into a running session without
  unplugging its pads. Structural changes use the daemon-owned path that
  reconnects controllers when required; the UI must not describe both classes
  as equally interruption-free.
- Staged mapping uses target=stage and changes only the in-memory staged setup.
- Query cleanup may remove a transient flash parameter only; it must preserve
  target, slot, macro, and every other navigation parameter.

### Primary bind flow

1. Select a controller zone or its matching Binding inspector row.
2. The same control highlights in both representations.
3. If Play owns the learner, use **Pause & edit**; the page must retain a
   visible **Resume Play** road home.
4. A labeled modal receives focus after its branch is present.
5. Press the physical key. During capture, ordinary browser keys are
   intentionally owned by the mapper; Escape or clicking outside cancels.
6. The backend accepts or refuses the write. The UI reports the result and
   refreshes from backend truth.
7. Focus returns to the control that opened the interaction.

Fixing one binding should remain a three-action task: choose control, press key,
observe result.

### Bound controls, multiple keys, and sharing

- Once the learner is listening, an already-bound control offers **Replace
  binding**, **Add another key**, **Clear binding**, and turbo controls before
  the captured key press.
- Multiple keys for one control are alternatives, not a chord. Each key chip
  has its own removal action; Clear removes the whole control binding.
- A same-preset duplicate is a valid multi-bind. It writes without a conflict
  dialog and is then shown as “also …” on every affected row.
- A cross-player duplicate is informational and requires an explicit choice.
  **Use here too** states the real fan-out operation and explicitly leaves the
  other player unchanged.
- Multi-select uses Ctrl/Shift on desktop or **Select multiple** for touch.
  **Map all to one key** applies the captured key to every selected control and
  reports verified results from the resulting state.

### Physical keyboard shelf

The shelf is a projection of the selected slot’s authoritative bindings, not a
second mapping model.

- One keycap appears per bound physical key.
- Selecting a keycap traces every controller control it drives.
- The summary announces the exact number of physical keys.
- Live key feedback is accepted only for the selected slot’s exact keyboard
  alias or device identity. The explicit (any) selector is the shared-board
  mode and may accept either.

### Live echo

Mapping and Test consume the same read-only /api/live SSE feed.

The mapper paints held and hit states only when:

1. a fresh /api/map response identifies the session currently playing;
2. that session origin matches the page target: saved setup versus staged
   draft;
3. the accepted session fingerprint still matches; and
4. the stream has not crossed a reconnect, stop, unavailable, in-flight
   generation invalidation, or changed-fingerprint boundary.

Those observable session boundaries clear the held-state ledgers and flash
timers. Older poll responses are ignored, and no frame cache is replayed into a
newly selected player or setup. A newest poll with the same fingerprint
intentionally preserves the current live state.

The durable announced states are:

- Live input is inactive.
- Play is using a different setup.
- Live input is active for Player N.

Connection retry chatter is visual and aria-hidden. A separate deduplicated
polite live region announces only durable semantic changes.

The current envelope does not carry an origin token. The handshake above is a
fail-closed safety boundary, not a claim of cryptographic frame provenance.

### Dialog and keyboard behavior

- The binding/conflict surface is role=dialog, aria-modal=true, and has an
  accessible name and description.
- Initial focus occurs after the client branch materializes.
- Escape cancels and restores focus.
- The post-capture conflict dialog traps Tab within its actions.
- The active capture phase deliberately does not use normal browser Tab
  traversal because the panel/daemon owns the captured press.
- On wide screens the dialog is a right-side contextual sheet; on narrow
  screens it is a centered sheet.

### Feedback and recovery

- A successful single-control edit may offer Undo only when the previous value
  can be restored honestly.
- Batch edits report accepted and refused controls; they do not call a
  best-effort multi-write rollback “Undo.”
- Whole-preset destructive and restore actions create a backup first, then
  expose the newest verified backup as the road home.
- Toasts are polite live-region messages, remain long enough to use their
  action, and never block page clicks when the stack is empty.
- Provider paths, hardware IDs, and parser text are diagnostic input, not
  customer copy.

### No-JavaScript contract

The server-rendered Binding inspector remains readable. Each row supplies real
forms for Bind, Add, Remove key, Clear, turbo, and cross-player force consent.
Slot navigation remains a real link. The enhanced press-to-learn flow is better,
but its absence must not turn the page into dead chrome.

## 7. Visual system

| Dimension | Contract |
| --- | --- |
| Typography | System sans for interface text and a system mono stack for identities, keys, paths, durations, and rates. Body is 14 px; card titles 17 px; page headlines up to 28 px; only the gameplay state reaches 38 px. |
| Spacing | A 4 px base and 8 px shared layout rhythm, expressed through spacing tokens, with deliberate sub-token micro-geometry for dense labels, badges, and control internals. |
| Controls | Default height 36 px, small inline tier 28 px, primary tier 44 px. Coarse pointers raise the ladders to 40/36/44 px, with larger phone-specific row actions where necessary. |
| Shape | Radius ladder from 4 to 16 px. Controls never look rounder than their containing card. Full rounding is reserved for pills, progress tracks, compact floating bars, and circular badges. |
| Iconography | Functional controller/persona SVGs and controller-zone glyphs carry hardware meaning. Actions remain text-labeled; restrained symbols such as ×, arrows, and + act only as familiar accelerators, never as the sole accessible name. There is no separate decorative icon library. |
| Dark theme | Deep violet ground, raised violet-family surfaces, cream text, teal accent. |
| Light theme | Warm paper ground, white/cream surfaces, dark violet text, darker teal accent. |
| Meaning | Teal means primary/live; green means verified/healthy; amber means attention; red means destructive/failure; cool violet means identity. Color never carries status alone. |
| Focus | One 2 px focus-visible ring with 2 px offset on links, buttons, fields, summaries, and explicit tabindex targets. It is never removed without a replacement. |
| Elevation | Borders do most surface separation. Restrained shadows also lift cards and primary actions; stronger shadows distinguish floating menus, dialogs, and toasts. |
| Motion | 90 ms local state change, 150 ms appearance, 240 ms overlay maximum. Transitions primarily use opacity, transform, and color, with bounded box-shadow and progress-width feedback. Reduced-motion collapses durations globally. |
| Density | Tabular numerals, hairline separators, text left/numbers right, no zebra striping in interactive lists. |

Both themes target at least 4.5:1 for meaningful text. The only recorded
exceptions are decorative hardware-colored controller glyphs whose accessible
names are supplied independently.

## 8. State matrix

| Surface | Condition | Presentation | Allowed action |
| --- | --- | --- | --- |
| Any server-rendered surface | Initial navigation or background refresh | Initial navigation waits for a complete server-rendered truth snapshot rather than showing an invented client skeleton. On a failed poll, retained last-successful inventory may remain visible, while current availability and readiness change to unknown or unavailable. | Wait or continue reading retained facts. Writes stay disabled until a successful refresh supplies fresh server state. |
| Global shell | Daemon reachable, idle | neutral ready/idle pill | Navigate and perform applicable writes. |
| Global shell | Session active | teal playing/running pill | Navigate; Play actions become Stop/Reload or explicit replacement. |
| Global shell | Daemon unavailable | danger/attention pill plus top alarm | Reads that succeeded remain visible; mutation is disabled or refused with recovery copy. |
| Any inventory | Read succeeded, zero rows | authored empty state | Offer the next useful action. |
| Any inventory | Read failed | alarm; never an empty claim | Retry/reopen and disclose support details. |
| Start | No selected keyboard | Step 1 remains incomplete | Identify, choose, rescan, inspect optional devices. |
| Start | Keyboard selected | chosen row and staged identity | Change selection; add a controller. No driver change. |
| Start | Selected keyboard disconnected, absent, or no longer resolves to one exact interface | The staged choice remains visible, but capture becomes blocked and never reads ready. | Reconnect or choose a supported USB keyboard, then Rescan. Save and Play remain unavailable until the exact selection is verifiable. |
| Start | Output known blocked | persona-specific alarm before preparation | Save remains available when stage-valid; Play is unavailable; show installer remedy. |
| Start | Output could not be checked | unknown/attention, not green | Do not claim readiness; allow only actions that do not depend on the output. |
| Start | Capture preparation required | three-consent prerequisite card | Prepare only after every required checkbox and fresh server guards. |
| Start | Exact keyboard prepared | ready/release card | Play when otherwise ready; separately confirm Release. |
| Start | Capture state unreadable or stale | blocked alarm | Do not prepare, release, save, or play from an unverifiable state. |
| Start | Complete staged setup | Save and Play choices both visible | Save, Play, both in either order, Start over. |
| Map | No controller | authored empty card | Return to setup and add one. |
| Map | Daemon/learner unavailable | read-only banner; layout still readable | Use no-JS picker if supported or reopen KSX; no silent click. |
| Map | Play active | warning with Pause & edit | Pause, then learn; do not pretend the learner can hear while Play owns capture. |
| Map | Paused for editing | persistent paused banner | Edit and Resume Play. |
| Map | Staged target | explicit unsaved-setup banner | Edit draft; Back to setup; no preset-file claim. |
| Map | Live inactive | visual status and one durable announcement | Start Play to activate echo. |
| Map | Different setup playing | mismatch status; no paint | Navigate to or start the matching setup. |
| Map | Stream connected, origin checking | transient visual status only | Wait for fresh map/session handshake. |
| Map | Matching live session | controller, inspector, and selected-slot key shelf illuminate | Observe; mapping writes remain independent actions. |
| Map | Learn listening | countdown dialog | Press a panel key, Escape, or click outside. |
| Map | Existing binding | bound dialog | Replace, add, clear, change turbo, cancel. |
| Map | Cross-player duplicate | conflict dialog naming the other use | Explicitly use here too or cancel; never remove the other binding. |
| Map | Write accepted | fresh state plus success toast | Undo only when exact recovery is available. |
| Map | Write refused | error toast naming what did not change | Retry after remedy; no optimistic local mutation. |
| Play | Idle and startable | large idle state plus profile selector | Start playing. |
| Play | Running | duration/capture/output/emergency facts | Stop playing or Reload config. |
| Tools | Destructive action armed | consequence-specific confirmation | Confirm exact action or cancel; no generic “Are you sure?” detached from scope. |

## 9. Microcopy

### Voice

- Lead with the user’s object: keyboard, controller, key, player, game.
- Use present-tense machine truth: “Play is active,” not “something may be
  running.”
- State consequence before remedy.
- Say what remained unchanged after every refusal.
- Prefer verbs over subsystem names: **Give this keyboard back to Windows**,
  not “uninstall interface package.”
- Put paths, selectors, daemon commands, and provider detail behind a support
  disclosure unless they are the only advanced recovery route.

### Anchor copy

| Context | Copy |
| --- | --- |
| Setup hero | **Turn your keyboard into a controller** |
| Stage 1 | **Choose the keyboard you want to use** |
| Identity helper | **Not sure which keyboard is which?** / **Identify by pressing a key** |
| Stage 2 | **Create the controller your game should see** |
| Stage 3 | **Choose a layout, then make it yours** |
| Blocking choice | **Should this keyboard keep typing?** |
| Mapping hero | **Select a control. Press a key. Keep moving.** |
| Mapping unavailable | **Mapping needs the background helper** |
| Play-owned learner | **Pause & edit** / **Resume Play** |
| Stage 4 | **Save this setup** / **Start playing** |
| Play hero | **Your controllers, ready when you are** |
| Destructive session action | **Stop playing** |
| Recovery | **Give this keyboard back to Windows** |

### Error formula

Every customer-facing error should answer four questions, in order:

1. What could not be read or done?
2. What does that prevent?
3. What was not changed?
4. What is the next safe action?

Example shape: “Keyboard capture could not be checked. KSX is not responding,
so this keyboard’s capture state is unknown. Nothing was changed. Reopen the
app before preparing, releasing, saving, or playing.”

### Safety copy

The split/freeze escape and scope sentences are backend-owned contract text.
Surfaces render them; they do not paraphrase them. The essential facts are:

- LeftCtrl five times toggles keyboard capture off or on in both modes.
- Turning capture off returns every keyboard without ending Play.
- Stop or Ctrl+Alt+Del ends Play.
- Freeze applies only to the selected keyboard and current session.

### Cross-player sharing copy

For a cross-player duplicate, the action is **Use here too**, with copy that
says the other player’s controls are not changed. It never calls a fan-out a
replacement or implies that the existing binding will be removed.

## 10. Accessibility

### Implemented / source-ready

- Semantic header, nav, main, section, heading, form, list, disclosure, status,
  alert, note, group, and dialog structures.
- Server-rendered content before hydration and real no-JavaScript forms for
  core mapping operations.
- A single visible focus ring across interactive vocabulary.
- Controller zones expose persona-aware aria-label text independent of the art.
- State pills use a word and dot in addition to color.
- Mapping dialog is named, described, modal, focusable, Escape-cancellable,
  focus-restoring, and conflict-focus-trapped.
- Live retry chatter is aria-hidden; durable live availability uses a separate
  deduplicated polite status region.
- Physical key inventory uses buttons with aria-pressed state.
- Mapping’s player rail and preset-management switcher are labeled link
  navigation with aria-current on the selected controller.
- The global focus-visible ring reaches the macro duration editor; no local
  outline removal overrides it.
- Toasts are a polite, non-atomic live region.
- Reduced-motion and light/dark preference support.
- Coarse-pointer sizing and narrow-screen reading order.
- Contrast and touch-target tests read the actual stylesheet rather than a
  duplicate palette.

### Required observation

Source structure is not an assistive-technology result. Before release, verify
the compiled pages with:

- keyboard-only traversal on every route;
- Narrator and NVDA reading order for the rail, setup cards, Mapping shelf,
  controller zones, inspector, dialogs, toasts, and Play facts;
- focus return after cancel, accepted bind, conflict cancel, and conflict
  acceptance;
- no repeated live-region chatter during SSE reconnect and two-second polling;
- 200% zoom and Windows text scaling;
- Windows high-contrast/forced-colors behavior;
- touch and keyboard reachability at 390 px and cabinet distance at 1280 px.

## 11. Responsive behavior

### Wide desktop — at least 68 rem

- Mapping becomes a two-column workspace: controller at left, binding inspector
  at right.
- The binding dialog docks as a right-side sheet.
- On non-Mapping pages, Profiles and quiet System information may share a
  twelve-column layout where the narrative allows it.

### Medium — below 60 rem

- The player rail stops being sticky so it cannot consume the working height.
- Gameplay hero type steps down without losing state priority.

### Phone — below 40 rem

- The header wraps.
- The workflow rail becomes a horizontally scrollable full-width row.
- Page heroes and actions stack.
- Cards use tighter shared padding; Play decisions become one column.
- Player tabs scroll horizontally instead of clipping later players.
- Long paths wrap onto their own line.
- List actions move to a full-width second line.
- Toasts and the multi-select bar remain inset within the viewport.
- Controller remains before inspector in natural DOM order.

### Mapping-specific narrow behavior

- The binding sheet is centered rather than docked.
- The macro matrix may scroll horizontally; the human-readable hold result
  remains visible.
- At very small controller containers, secondary zone key tags may hide while
  the control’s accessible label and inspector truth remain.

### Coarse pointers

- The control-height token ladder grows globally rather than through a
  per-component exception list.
- Platform checkboxes grow to a usable physical target.
- Phone list actions reach a 44 px minimum where they are the row’s only action.

The primary phone use case is diagnostics behind a cabinet. Mapping remains
responsive, but Test inputs is the phone-first surface until LAN pairing and a
dedicated remote flow exist.

## 12. Implementation and proof status

| Area | Current status | What is still required |
| --- | --- | --- |
| Four-stage shell and Tools IA | Implemented / source-ready in the Studio islands and shared CSS, with locally regenerated embedded assets. | Clean-runner asset reproduction, manifest/source seam verification, build, and screenshot review. |
| Staged setup, persona selection, split/freeze, Save/Play separation | Implemented / source-ready across API, backend, renderer, server, and Start island. | Current Rust/browser suite on CI, then physical Gate 4. |
| Capture consent and recovery surface | Implemented / source-ready, with server-owned stale-action guards. | Exact installed helper transaction on a fresh Windows machine. |
| Identify by pressing a key | Implemented / source-ready through the daemon learner, exact-generation observation, MachineSource inventory resolution, and ordinary stage writer. | Clean compile/tests, then device-scoped proof with a real held WinUSB panel. |
| Mapping controller/inspector/key shelf | Implemented / source-ready and present in the locally regenerated embedded bundle. | Independently reproduce, compile, hydrate, interact, and visually inspect the current bundle on CI. |
| Saved/staged mapping writes, multi-key, turbo, macros, pause/resume, Undo | Implemented / source-ready. | Current seam, HTTP, parity, and browser tests on CI. |
| Direct Mapping live echo | Implemented / source-ready with fail-closed session handshake and key/device filtering. | CI browser observation; later protocol origin token if stronger provenance is required. |
| Accessibility and responsive rules | Implemented / source-ready; responsive structure has browser assertions. | Interactive accessibility and assistive-technology observation, plus forced-colors, zoom, touch, and visual review. |
| Browser screenshot job | Implemented / source-ready in the live workflow and Playwright source. | A successful workflow run and review of every uploaded image. |
| Customer-ready release claim | Not established by source. | Exact CI-built installer, recorded hash, clean standard-user Gate 4, real controller/game, and uninstall/recovery proof. |

## 13. CI screenshot and visual validation plan

### What the current source-ready job does

The Studio browser job is configured for the pinned Windows 2022 runner, Node
20.19.0, Playwright 1.62.1, and pinned Chromium. Its visual smoke source builds
the Studio fixture and captures all eight routes in three contexts:

| Context | Viewport | Theme/input |
| --- | --- | --- |
| dark-desktop | 1600 × 1200 | dark, fine pointer, reduced motion |
| light-mobile | 390 × 844 | light, mobile touch/coarse pointer, reduced motion |
| coarse-cabinet | 1280 × 800 | dark, touch/coarse pointer, reduced motion |

That is 24 route-level images: Start, Play, Mapping, Test, Virtual controllers,
Hardware, Game library, and Import & recovery in each context.

Before capture, the current test requires successful HTTP, active hydration,
no page or console error, the intended pointer/theme media state, no global
horizontal overflow, and no responsive root escaping the viewport. Screenshots
are attempted even after an assertion failure. Each successful image is decoded
far enough to require nonzero PNG dimensions and recorded with route, context,
viewport, theme, pointer mode, byte length, and SHA-256 in `manifest.json`.
Images and manifest are uploaded as the studio-browser-screenshots artifact for
30 days. `release-binary` depends on this job, so a route that fails hydration,
layout, current-asset parity, or screenshot completeness cannot produce the
installer/portable artifacts.

This is a strong structural smoke. It is intentionally **not** an exact
pixel-baseline gate because Windows system-font and rasterization changes would
create noisy diffs.

The browser job installs the pinned Forma authoring dependencies, regenerates
the embedded assets in its own checkout, and requires both a clean tracked diff
and no untracked asset before it builds the fixture. A stale committed bundle
therefore blocks the screenshots instead of quietly producing pictures of the
old interface.

### Required next CI observation

1. Observe the browser job’s in-checkout Forma regeneration/parity step passing
   on a clean runner. Stale committed assets are a failure, not an alternate
   implementation.
2. Run the Rust source/seam/HTTP/contrast/touch tests and all Playwright tests.
3. Require all 24 default screenshots to exist, decode, and have nonzero
   dimensions.
4. Verify the emitted machine-readable manifest records commit, workflow run,
   Node/Playwright/Chromium versions, viewport, theme, pointer mode, fixture
   state, filename, dimensions, byte length, and SHA-256 for all 24 images.
5. Upload screenshots and manifest even when the job fails.
6. Review every image for hierarchy, clipping, wrapping, empty space, focus
   obstruction, dialog bounds, and accidental technical copy.
7. Record the review verdict beside the workflow run. A green structural job
   without image review is not a visual approval.

### State-fixture expansion

The default fixture cannot represent the whole state matrix. Add deterministic
named fixtures and capture at least:

| Route | Required states |
| --- | --- |
| /start | clean empty stage; identified/chosen keyboard; output blocked; capture prepare; capture release; unreadable capture; complete ready stage; session replacement warning |
| /map | saved target; staged target; no controller; no daemon/read-only; Play active; paused; live inactive; different setup; matching live input; learn listening; existing binding; cross-player conflict; multi-select bar; macros open |
| / | idle/startable; running with active facts; no daemon; profile list empty; system prerequisite attention |
| /check | live inactive; live fan-out; read unavailable; zero-control roster |
| Tool routes | readable empty; populated; refused read; destructive confirmation where applicable |

Use dark desktop for every state fixture and light mobile for every layout- or
dialog-distinct state. Use coarse cabinet for gameplay, Test, Mapping, and
destructive confirmation states.

### Review strategy

- Keep structural assertions as the mandatory automated gate.
- Do not adopt zero-tolerance pixel diffs on Windows system fonts.
- If automated visual comparison is added, use a reviewed reference artifact,
  mask timestamps/carets, pin browser and scale, and apply a documented
  perceptual threshold. A diff image must be uploaded; a scalar percentage is
  not review evidence.
- Treat a missing screenshot, uncaptured state, browser error, overflow,
  unreadable contrast, clipped action, obscured focus ring, or dialog outside
  the viewport as a failure.
- Re-baselining requires a reviewer to name the intended visual change; “update
  snapshots” is not a sufficient explanation.

### Final acceptance boundary

CI screenshots prove that the compiled local web surface paints and behaves as
specified under deterministic fixtures. They do not prove UAC, driver binding,
physical keyboard recovery, real virtual-controller enumeration, Game Bar, a
game accepting input, installer shortcuts, or uninstall cleanup. Those remain
the exact-artifact physical acceptance in [GATES.md](GATES.md).
