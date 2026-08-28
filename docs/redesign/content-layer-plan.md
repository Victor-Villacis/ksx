# The content layer: adopted, transformed, left behind

The design handoff (`design-handoff-spatial-canvas/README.md`) specs a
workflow editor. ksx is not that — but ksx HAS a graph: **physical key →
transforms (SOCD, turbo, shift, macro) → controller control → player slot**,
and it has run data: the live input feed. This file is the record of what
each content-layer feature becomes here, decided 2026-08-28. It governs the
transplant order; update it as pieces land.

## Adopted (mechanic fits as-is)

| Handoff feature | Status | ksx meaning |
|---|---|---|
| Inspector (328px overlay, safe viewport, pan-by-overlap, multi-select rules) | **SHIPPED (shell)** | The editing home. Today: selection identity, scale, numeric X/Y (the no-drag a11y contract), Focus/Fit/Center. Later: binding editor, persona picker, SOCD/turbo, terminal truth detail as widgets transplant in. |
| Off-screen proximity chips (edge carets, distance, click-flies, cap 4, inspector counts as off-screen) | **SHIPPED** | Lost-in-space with keyboard + 4 pads + panel is real. |
| Hover spotlight | **SHIPPED (v0)** | Hover dims unrelated widgets. Becomes the SIGNAL TRACE (light a key's whole route) when binding edges exist. |
| Escape ladder, camera history, palette, sheet, semantic tiers | SHIPPED (slice 2) | Verbatim. |

## Transformed (mechanic survives, meaning becomes ksx) — LATER

| Handoff feature | Becomes | Blocked on | Notes from the build |
|---|---|---|---|
| Lenses (latency/cost/errors) | **Collisions** lens (keys driving two things — the founding question), **Players** (color by slot; slot colors half-exist), **Activity** (press-frequency heat from the live feed), **Truth** lens on the panel (chart vs declared vs observed painted spatially) | keyboard + panel widget transplants; live-feed plumbing into the lane | Keep the handoff's magnitude rule: intensity of ONE hue, minimap re-tints with the same function. |
| Payload edges | **Binding edges**: mappingFlow's key→control lines, weight = events routed this session, hover popover = the binding's full story | mappingFlow transplant | Do NOT build a second edge layer — mappingFlow IS the edge layer; migrate it, then restyle to the handoff's bezier + non-scaling-stroke. |
| Replay scrubber | (1) **Input replay** — record a capture session, scrub what was pressed when (debugging double-fires with a timeline); (2) **Macro timing editor** — a macro is already a timed segment track | live-feed recording; macro editor transplant | The handoff's segment math (left=start/total, width=ms/total) maps 1:1 onto macro steps. |
| Subflows (own camera, breadcrumbs) | **Enter a macro** (Canvas / P1 · Hadouken), maybe the control-surface builder | macro editor transplant | Engine camera-per-context is a small addition; the history label convention is already in place. |
| Ports / edge creation | **Drag-to-bind**: drag from a keycap to a controller button to create the binding | keyboard + pad transplants | The direct-manipulation future of remapping; prototype only after the trace lens proves the geometry. |
| Follow execution | Possibly "follow live input" in input-test only | live feed | Low priority; never during Play. |

## Left behind (the thesis does not apply)

- **Dimension-resize / width presets** — our widgets are pictures of
  hardware with intrinsic aspect; they SCALE (manualScale), they don't
  reflow. Exception kept in the back pocket: **sticky notes** ("this button
  is flaky") would be genuinely useful cabinet documentation and would get
  free resize per the handoff's structured-vs-rich rule — deferred until a
  notes store exists (canvas prefs are geometry, not content).
- **Latency / cost / freshness lenses, token counts** — sub-millisecond
  pipeline, no per-run cost. Gone.
- **Straighten-path** — solves reading LONG chains; ours are three hops.
  The need is covered by the signal trace.

## The transplant order this implies

1. **Keyboard widget** (the sun everything orbits) — carries slot colors,
   which seeds the Players lens.
2. **mappingFlow → binding edges** + Collisions/Players lenses.
3. **Inspector content**: the binding editor moves in.
4. **Pads**, then the **panel** (Truth lens).
5. **Input replay**, then the **macro subflow**.
6. Drag-to-bind prototype; sticky notes when a content store exists.

## Findings worth remembering (from building the shell)

- Focus mode masks `getCamera()` to the entry camera — chips and anything
  screen-space must hide during focus or compute from the live camera.
- The minimap's markers carry `data-instance-id` — every "count the
  widgets" query must scope to `.forma-canvas-stage >`.
- Any behavior change to shared engine paths MUST be gated on
  `navigationModel` — /nocturne's suite pins the map model's numbers.
- The automatic first-open fit must never push camera history
  (`fitAll(false)`) — an auto-push un-hides Back view and breaks parity.
- Screen-space chrome recomputes on camera SETTLE (150ms debounce), never
  per frame — the handoff's own rule, and the engine's onChange cadence
  makes it natural.
