# Slice 2 — the gesture model (engine map, recon'd 2026-08-27)

The design's interaction spec (`canvas-ui-patterns/Canvas Notes.dc.html`)
mapped onto our engine (`studio-ui/src/genui/canvas/widget-canvas.ts`, ours
to modify; divergences marked `// ksx:`). Line numbers @ `24a6a9b`.

## 1. Marquee-select on empty left-drag

- The decisive predicate is `#bindCameraInteractions`' pointerdown at
  widget-canvas.ts:2118-2170 (`shouldPan` at :2121). Split into
  `#beginPanGesture` / `#beginMarqueeGesture`; pan moves to
  `button 1 | button 2 | space | hand-tool`; REUSE `#cameraGesturePointerId`
  (:447) so every mutual-exclusion guard and teardown path keeps working.
- Keep tap-clears-selection (:2159-2160) and the 5px dead zone (:2141).
- Hit test on finish: `#navigationCandidates()` (:1490, world-space rects
  already) + plain AABB overlap.
- Selection is strictly SINGULAR today (`#activeId` :445, `#selectItem`
  :873). Add `#selectedIds: Set<string>` beside it; `#activeId` stays the
  primary so selbar/inert/admission keep a defined answer. Don't raise z per
  marquee member (`#canRaiseSelection` :417).
- Marquee rectangle: create on pointerdown, REMOVE on pointerup — a node
  that survives to a settled page fails SSR parity (rule 3e).
- Wheel (:2172-2179) becomes: ctrl/meta → zoom-at-point; shift → pan X;
  else → pan by deltaX/deltaY (today EVERY wheel zooms). Keep the
  over-widget escape (:2175).
- Right-drag pan needs a viewport `contextmenu` preventDefault when moved
  (none exists today).

## 2. Hand tool

`#toolMode: "select" | "hand"` beside `#spacePressed` (:452), public
`setToolMode/toolMode` near :892, gate at :2121. Use a distinct
`is-hand-tool` class, NOT a persistent `is-pan-ready` (classes are not
parity-exempt; served default must be select with no class).
`#cancelLostInputState` (:2187) must NOT reset the tool. Chrome: a served
`.rd-tools` rail wired through the lane's `[data-nx]` dispatcher.

## 3. Camera commands (keys 1 / 2 / F / 0)

- `fitAll` :1180-1207 — padding is 60 WORLD units (:1193); the spec's 68px
  is SCREEN px → subtract padding from viewport dims instead (the mock does
  `(w - pad*2)/box.w`). Cap: change the literal `1` at :1199 to `1.1`.
- `fitSelection` doesn't exist: extract :1191-1206 into
  `#fitWorldRect(rect, {padding, cap})`; selection variant = union of
  selected rects, fallback fitAll.
- `resetZoom` :1218 already matches the spec (100% at viewport center).
- Focus mode already saves/restores the entry camera (:975, :1163).
- Bind keys in the LANE's window keydown (the engine's viewport keydown
  :2050 only fires with viewport focus), guarded by
  `eventOriginatesInTextEntry` (keyboard-shortcuts.ts:119); register in
  KEYBOARD_SHORTCUTS (keyboard-shortcuts.ts:8).

## 4. Camera history

Pure addition — nothing exists (only the focus session's depth-1 save).
`#cameraHistory` ring (cap ~24) pushed at the head of every camera verb;
public `backView()`. Push `#camera`, never `getCamera()` (focus-masked
:1224).

## 5. Widget-tier hooks (semantic zoom)

The lane's tier readout + ±3% hysteresis already ship (RedesignIsland
`syncZoomTier`). To reach WIDGETS: inside `#renderCamera`'s once-per-zoom
branch (:2335) set `--canvas-zoom` and `dataset.canvasZoomTier` on the
viewport — MUST be named `data-canvas-*` to ride parity rule 3d — and add
`onZoomChange(zoom, tier)` to the options so the lane stops deriving
through `onChange` + `getCamera()` (wrong during focus). Move the
hysteresis constants into the engine so label and attribute cannot disagree.

## Invariants (verbatim from the recon)

- Parity rule 3d exempts ONLY `style`, `data-input-kind`, and
  `data-(canvas|widget|attention|runtime|virtualization)-*` on
  `data-client-canvas` nodes. Classes are never exempt.
- Camera gestures use NO pointer capture (window listeners + cancel hatch);
  widget drags do. A marquee is a camera-family gesture.
- Keep any marquee class OUT of the `cameraMoving` set (:2484) — admission
  freezing keys on it, and mappingFlow reads the pan classes.
- The suites' widget-less "engine alive" mark is `stage.style.transform` —
  don't move the first `#renderCameraNow()` (:567).
- The camera must stay uncaged (`// ksx:` divergence :190-212).
