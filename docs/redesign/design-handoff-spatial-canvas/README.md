# Handoff: Spatial Workflow Canvas

## Overview

An infinite-canvas editor for agent / API workflows. Nodes are steps in an agent
pipeline (webhook → auth → retrieval → prompt → model → tools → guardrail → output);
the user pans, zooms, selects, resizes, focuses, and reads run data spatially.

The defining product rule, which every decision below serves:

> Zoom out to understand the system, fit a section to understand the flow, focus an
> item to edit it — and always return to exactly where you were.

## About the design files

The files in this bundle are **design references authored in HTML** — working
prototypes that show intended look and behaviour. They are **not production code to
copy**. The task is to recreate them in the target codebase's existing environment
(React, Vue, Svelte, SwiftUI, native — whatever is already there) using its
established patterns, state management, and component library. If no environment
exists yet, pick the appropriate framework and implement there.

For React specifically, `@xyflow/react` (React Flow) already provides the camera
transform, `fitView`, controls, minimap, node resizer, selection, and a configurable
navigation model. If you use it, the custom work is: semantic-zoom rules, the camera
history stack, focus mode, straighten-path, lenses, payload edges, and the replay
scrubber. Nothing in this document assumes React Flow.

`Spatial Canvas.dc.html` is a single-file prototype: an imperative camera written
directly to a CSS transform, with React only for the DOM. Do **not** mirror that
architecture blindly — mirror the *behaviour* and the *numbers*.

## Fidelity

**High fidelity.** Colours, type, spacing, radii, shadows and all interaction
numbers are final and exact. Recreate pixel-for-pixel using the codebase's own
primitives. Every value below is literal — no "approximately".

---

# 1. Architecture

Three concepts that must not be collapsed into one:

| Concept | What it is |
|---|---|
| **World** | Effectively unbounded coordinate space. Nodes are stored in world coordinates. |
| **Camera** | `{ x, y, zoom }`. The only thing that moves when the user navigates. |
| **Viewport** | Whatever the browser currently shows. Changes when the window or panels change. |

**The canvas is never resized.** The window resizes, the camera moves, an item
resizes. Collapsing these produces the classic bugs: dragging the window edge moves
nodes, opening a panel refits the graph, panning enters the undo stack.

Keep three state stores separate:

1. **Document state** — nodes, groups, edges, sizes, positions. Undoable.
2. **Camera state** — `x`, `y`, `zoom`, per navigation context. Has its own
   back/forward history. **Never** enters content undo.
3. **Transient interaction state** — active gesture, marquee rect, hover target,
   live resize dimensions. Never persisted.

## Coordinate math

```
world → screen:   sx = wx * zoom + cam.x
screen → world:   wx = (sx - cam.x) / zoom

zoom anchored on a point (px, py) in canvas-local screen coords:
  z' = clamp(zoom * factor, 0.08, 3)
  k  = z' / zoom
  cam.x' = px - (px - cam.x) * k
  cam.y' = py - (py - cam.y) * k
```

The world layer is one element with `transform-origin: 0 0` and
`transform: translate3d(cam.x px, cam.y px, 0) scale(zoom)`.

**Zoom limits:** 0.08 – 3.0 (8% – 300%).

## The safe viewport

Every camera command computes against the **safe viewport**, not the canvas
rectangle: the canvas minus any chrome overlaying it. In this design that is the
328px inspector when open.

```
safe.w  = canvasRect.width - (inspectorOpen ? 328 : 0)
safe.h  = canvasRect.height
safe.cx = safe.w / 2
safe.cy = safe.h / 2
```

Overlays positioned relative to the viewport (banners, the replay bar) must lay out
inside the safe area — `right: 344px` when the inspector is open, `right: 16px` when
closed. Do **not** use a percentage `max-width`: it is computed against the full
canvas and slides under the panel.

## Constant-screen-size elements

The world scales; interface affordances do not. Set a CSS custom property on the
world element every time the camera changes:

```js
world.style.setProperty('--iz', String(1 / zoom));   // inverse zoom
```

Then, for anything that must hold a fixed screen size while living in world space:

- resize handles: `transform: translate(-50%,-50%) scale(var(--iz,1))`
- selection ring: `box-shadow: 0 0 0 calc(2px * var(--iz,1)) var(--color-accent)`
- group labels: `transform: scale(var(--iz,1)); transform-origin: 0 0`
- lens magnitude bar: `height: calc(4px * var(--iz,1))`
- edges: `vector-effect="non-scaling-stroke"` on the SVG path

---

# 2. Navigation

**Design-tool model** (Figma / Miro), not map model. Left-drag on empty space
marquee-selects; panning has its own gestures. The map model (empty-space drag pans)
is easier in the first five minutes and worse from the second hour, once users select
groups and organise sections. A visible hand tool covers anyone who doesn't know
space-drag.

| Input | Action |
|---|---|
| Two-finger trackpad drag | Pan |
| Pinch | Zoom, anchored on the fingers |
| Wheel | Pan vertically |
| Shift + wheel | Pan horizontally |
| Ctrl/Cmd + wheel | Zoom, anchored on the pointer |
| Space + left drag | Pan |
| Middle drag | Pan |
| Right drag | Pan (suppress the context menu) |
| Left drag on empty space | Marquee select |
| Click node | Select |
| Shift/Cmd + click node | Add to selection |
| Drag node header | Move (snaps to 4px; Alt = 1px) |
| Double-click node | Focus — or enter a subflow if the node is one |
| Double-click empty space | Fit workflow |
| Hover node | Spotlight its whole path |
| Hover edge | Payload popover |

**Wheel implementation note:** React's `onWheel` is registered passively at the
root, so `preventDefault()` is ignored. Attach the wheel listener imperatively:
`el.addEventListener('wheel', handler, { passive: false })`.

**Trackpad pinch** arrives as a `wheel` event with `ctrlKey: true`. The same branch
handles pinch and Ctrl+wheel. Zoom factor used: `Math.pow(0.9985, deltaY * 1.6)`.

## Keyboard

| Key | Action |
|---|---|
| `+` / `−` | Zoom in / out (×1.25 per press, centred on the safe viewport) |
| `0` | 100%, keeping the current centre point |
| `1` | Fit workflow |
| `2` | Fit selection |
| `C` | Centre selection (pan only, zoom untouched) |
| `F` / `Enter` | Focus selected node |
| `L` | Straighten the path through the selection |
| `O` | Cycle lens |
| `D` | Toggle data-flow edges |
| `R` | Toggle execution replay |
| `M` | Toggle minimap |
| `V` / `H` | Select tool / hand tool |
| `?` | Shortcut sheet |
| Arrows | Move selection 12px (Shift: 1px) |
| `Cmd/Ctrl + K` or `F` | Search and fly to node |
| `Cmd/Ctrl + Z` | Undo **content only** — never camera |
| `Esc` | See escape ladder below |

**Single-key shortcuts fire only when the canvas has focus and the user is not
typing.** Guard: bail if `event.target` is `INPUT`, `TEXTAREA`, or
`isContentEditable`. Cmd/Ctrl combinations are checked *before* that guard so
Cmd+K works from inside a field.

**Escape ladder** — in this exact order:

1. Shortcut sheet open → close it
2. Command palette open → close it
3. Resize gesture in progress → cancel the resize, restoring the pre-gesture size
4. Straighten mode active → restore positions and the previous camera
5. Focus mode active → exit focus and restore the previous camera
6. Inside a subflow → return to the parent workflow
7. Camera history non-empty → back view
8. Otherwise → clear the selection

---

# 3. Camera commands

Four distinct commands, separate in the menu, on the keyboard, and in code. All
animate over **260ms** with `easeOutCubic` (`1 - (1-k)³`), except focus at **300ms**
and follow-execution at **340ms**.

### Fit workflow — `1`
Bounding box of all visible nodes **and groups** in the current context. Padding
**68px** on every side. Zoom capped at **1.1** — a two-node workflow must not fill
the screen. Excludes hidden nodes and collapsed-group contents. Runs on first open
of a workflow and **never again on its own**.

### Fit selection — `2`
Same, over the selected nodes only. Padding **90px**, cap **1.3**.

### Centre selection — `C`
Pans so the selection's bounding-box centre is at the safe-viewport centre. **Does
not change zoom.**

### Zoom 100% — `0`
Sets zoom to exactly 1 while keeping the world point currently at the safe-viewport
centre at that centre. Never jumps to the origin.

### Focus item — `F` / double-click
More than zooming in:

1. Push the current camera onto the history stack (label: `before Focus <name>`).
2. Select the node and open the inspector.
3. Animate the node's centre to the safe-viewport centre at
   `zoom = clamp(min((safe.w-200)/node.w, (safe.h-160)/node.h), 0.9, 1.2)`.
4. Keep immediate upstream/downstream neighbours at full opacity.
5. Drop every unrelated node to **opacity 0.22**, unrelated edges to **0.15**.
6. Escape restores the exact previous camera.

### Full screen
Hides application chrome. **Does not touch the camera.** It is a fifth thing, not a
variant of fit.

## Camera history

A stack of `{ x, y, zoom, label, context }`, max 24 entries. Pushed **before**:
fit workflow, fit selection, 100%, centre selection, focus, a search result, a zoom
menu pick, entering a subflow, straighten. A "Back view" button appears in the top
bar whenever the stack is non-empty and shows the label on hover. Content undo and
camera history are separate stacks and never interact.

## Panel and window behaviour

- Opening or resizing the inspector **preserves zoom**.
- The camera pans by **exactly the overlap needed** to keep the selected node clear
  of the panel — often zero. Implementation: if the node's right edge exceeds
  `safe.w - 20`, pan left by the difference; if its left edge is below 20, pan right.
  Animate over 200ms. Never refit.
- Window resize: preserve zoom and the point being worked on.
- Restore the user's last viewport when a workflow is reopened; fit workflow only on
  the very first visit.

## Animation robustness (a bug we hit — do not repeat it)

The camera tween originally lived entirely in `requestAnimationFrame`. In a hidden or
backgrounded view frames are throttled to zero, so **every camera command silently
became a no-op** — fit, focus, keep-selection-visible, all of them.

Required shape:

1. A generation counter. Each `animateTo` increments it; `tick` returns early if its
   captured generation is stale.
2. A landing `setTimeout(duration + 70ms)` that sets the camera to the **exact**
   target regardless of whether frames arrived. This also removes easing residue.
3. Any manual camera input (pan start, wheel) bumps the generation and clears the
   timeout, so a tween can never fight the user.

---

# 4. Semantic zoom

Zooming out is not shrinking — it changes how much information a node carries. The
node's **outer dimensions never change across a threshold**, so nothing jumps.

| Level | Zoom | Shows | Hides |
|---|---|---|---|
| **Overview** | < 50% | 30px type icon, 20px node name, 12px status dot, group boundaries | Type label, summary, ports, buttons, edge labels |
| **Structure** | 50 – 90% | 24px icon chip, 13px name, 10px type label, one-line config summary, 7px port dots, 7px status dot | Port names, per-node controls, validation |
| **Editing** | > 90% | Everything above plus port **names**, run + focus icon buttons in the header, validation pill | — |
| **Focus** | not a zoom level | Full editor in the inspector: prompt/code, schema, test data, last result, logs | — |

**Hysteresis: ±0.03.** The active threshold depends on the current level, so a node
sitting exactly on a boundary does not flicker:

```js
lodFor(z) {
  const h = 0.03, lo = 0.5, hi = 0.9;
  const loT = current === 'overview' ? lo + h : lo - h;
  const hiT = current === 'editing'  ? hi - h : hi + h;
  if (z < loT) return 'overview';
  if (z < hiT) return 'structure';
  return 'editing';
}
```

The validation pill is positioned **absolutely below the card** so it cannot change
the node's box.

---

# 5. Nodes

## Sizing policy

Not everything gets a resize handle. Free resize everywhere produces irregular
layouts, badly routed edges, and a graph that cannot be scanned.

**Structured nodes** — width presets only, height follows content:

`trigger`, `auth`, `guardrail`, `router/branch`, `tool`, `transform`, `database`,
`embedding`, `model`, `subflow`

Presets: **Compact 170px · Standard 220px · Expanded 300px**. Height 76px
(88px for subflow nodes, which carry a footer row).

**Rich-content nodes** — free drag resize:

`prompt`, `preview`, `note`, groups

Min **180 × 90**, max **720 × 620**.

## Resize interaction

- Handles appear **only when selected**, never permanently.
- 8 handles: 4 corners at 11×11px, 4 edges at 9×9px, radius 3px/2px, background
  `--color-accent`, `box-shadow: 0 0 0 1px var(--color-bg)`.
- Handles hold a **constant screen size** (see `--iz` above).
- Cursors: `nwse-resize`, `nesw-resize`, `ns-resize`, `ew-resize`.
- Live dimensions badge while dragging: bottom-right, outside the card, constant
  screen size, `W × H` rounded, accent-800 background.
- The header is the drag region. Text fields, code areas, dropdowns and buttons are
  **not** — mark them `data-nodrag` and bail on `event.target.closest('[data-nodrag]')`.
- Escape cancels the active resize and restores the pre-gesture size.
- One whole resize gesture is **one** undo entry (push the snapshot on pointerdown,
  not per frame).
- Edges reroute live; connector positions survive.

## Groups

- Rect with `1px solid var(--color-neutral-800)` (accent when selected), radius 14px,
  fill `color-mix(in srgb, var(--color-neutral-900) 45%, transparent)`.
- The rect itself is `pointer-events: none`; only the **label** is interactive
  (drag to move the group, `cursor: grab`).
- Label: absolute at `left: 10px; top: -10px`, 10.5px uppercase, 0.05em tracking,
  `--color-bg` background, constant screen size.
- Bottom-right handle resizes the **boundary only** — children keep their own size
  and position. Scaling children produces a slide-deck effect, not an editor.
- Min group size 240 × 180.

## Ports

- 7px dots, `--color-neutral-600`, `box-shadow: 0 0 0 2px var(--color-bg)`, centred
  on the card's left/right edge.
- Vertical position for port *i* of *n*: `node.h * (i+1) / (n+1)`.
- Names appear at editing level only: 9.5px, `--color-neutral-600`, 10px outside the
  card.

## Edges

Cubic bezier, SVG, `overflow: visible`, `vector-effect="non-scaling-stroke"`:

```
sx = source.x + source.w,  sy = source.y + source.h/2
tx = target.x,             ty = target.y + target.h/2
dx = max(46, (tx - sx) * 0.45)
d  = M sx,sy C sx+dx,sy tx-dx,ty tx,ty
```

Backward edges (the tool→model loop) route right instead, with control points at
`sx + 130` / `tx + 130`, and are dashed `5 5`.

Default stroke 1.6px, `--color-neutral-600`. Labels at editing level: 11px centred
chip with `--color-bg` background over the midpoint, 9.5px text.

**Hit testing:** a second transparent path per edge at `stroke-width: 16`,
`pointer-events: stroke`. Set `pointer-events: none` on it whenever the visible edge
is dimmed below 0.3 — otherwise dimmed edges intercept hovers.

---

# 6. The four features that make it worth using

## 6.1 Lenses — `O`

One canvas, switchable overlays. Selector is a pill top-left; cycling is one key.

| Lens | Value | Format |
|---|---|---|
| Status | — | status dot only |
| Latency | p95 ms | `1.84s` above 1000ms, else `640ms` |
| Cost | cents per run | `4.6¢`, `—` when zero |
| Error rate | % of runs | `8.4%` |
| Last edited | days | `21d ago` |

Per node, when a lens is active:

- The value renders in the header (10.5px tabular, `--color-neutral-900` chip,
  `--color-accent-200` text) — and at 16px beside the name at overview level.
- A magnitude bar sits on the card's bottom edge: width `value / max * 100%`, height
  `calc(4px * var(--iz,1))` (constant screen size).
- Magnitude reads as **accent intensity, not a rainbow**:
  `color-mix(in srgb, var(--color-accent) ${12 + k*78}%, transparent)`.
  Error rate above `k > 0.55` switches to
  `color-mix(in srgb, var(--st-err) ${35 + k*55}%, transparent)`.
- `max` is the maximum across the **current context**, recomputed per lens.
- The minimap re-tints with the same function, so the hot spot is findable while
  zoomed out. This is what makes the minimap worth looking at.
- Legend bottom-right: 186px card, five 6px swatches at k = 0.1/0.35/0.6/0.85/1, lens
  name in `--color-accent-300`, min and max labels.

## 6.2 Straighten path — `L`

The graph is two-dimensional; the thing being debugged is a line.

1. Compute the chain through the selected node: walk **first** parent upstream and
   **first** child downstream, skipping backward edges, with a visited set.
2. Save every chain node's original `{x, y}`.
3. Lay the chain out horizontally from the first node's position, gap **88px**,
   all vertically centred on the selected node's centre line.
4. Animate positions over **320ms** easeOutCubic.
5. Hide group boxes entirely.
6. **Off-path nodes must leave paint *and* hit-testing** — `visibility: hidden;
   pointer-events: none`. Dimming alone is a bug: the lane is laid out across where
   those nodes still sit, they come later in DOM order, and they steal clicks.
7. Camera: `zoom = clamp((safe.w - 140) / laneWidth, 0.45, 0.95)`. If the lane does
   not fit at 0.45, centre on the **selected node**, not the lane centre. A 3,000px
   lane squeezed into 600px is useless — hold a readable zoom and let the user pan.
8. Banner inside the safe area: "Path straightened", the chain names ellipsized, and
   a Restore button. Escape or Restore tweens every node back to its saved position
   and pops the camera history.

Positions are **restored**, not approximated. Users must trust this.

## 6.3 Payload edges — `D`

After a run, the graph becomes a debugger.

- Stroke width `min(9, 1.2 + sqrt(tokens) / 7.5)` — 24 tokens ≈ 1.8px,
  2,930 tokens ≈ 8.4px. Non-scaling-stroke, so the weighting reads at any zoom.
- Stroke colour switches to `--color-accent-600`.
- Token counts render as edge labels at all zoom levels while flow is on.
- Hovering any edge opens a popover at the edge midpoint (290px, constant screen
  size, `--shadow-lg`): `from → to`, the token count as a 13px heading, and the
  actual payload sample in 10.5px monospace.

## 6.4 Execution replay — `R` / Run

Time as an axis.

- The trace is a list of `{ id, start, end, ms }` built from real per-node durations
  with an 18ms gap between steps. The sample run totals 2.90s, of which the model
  call is 1.84s.
- Scrubber, bottom, inside the safe area (`left: 244px` to clear the minimap,
  `right: 344px` when the inspector is open): play/pause, `0.00s of 2.90s`, the
  active node and its duration, close.
- Track 22px tall. One segment per node, `left: start/total`, `width: ms/total` —
  so widths are real durations and the model call visibly owns the run. Segment
  colour: `--color-neutral-800` pending, `--st-run` active, `--color-accent-700`
  complete. Names render inside segments wider than 12% of the track.
- Playhead: 2px `--color-accent-200` with an accent glow.
- Clicking a segment seeks to its middle and selects that node. Dragging the track
  scrubs. Scrubbing pauses playback.
- Node state at time *t*: `pending` (opacity ≤ 0.5), `running` (accent glow ring +
  pulsing dot), `done` / `error`. Edges whose target is still pending drop to
  opacity 0.3; the edge into the running node animates its dash.

### Follow execution
- Explicit, labelled indicator: "Following execution · Stop".
- The camera moves **only when the active node has left the safe viewport** (24px
  inset), over 340ms.
- **Any manual pan or zoom stops following immediately.** Never fight the user for
  camera control. The user can resume.

## 6.5 Two smaller ones

**Hover spotlight.** Hovering a node computes everything reachable in either
direction and drops the rest to opacity 0.26, off-path edges to 0.1. Suppressed
while a gesture is active, in focus mode, and in straighten mode.

**Off-screen proximity chips.** Nodes that are off-screen but (a) connected to the
selection or (b) failing anywhere, post a chip at the viewport edge: a caret rotated
toward the node, its name, and its distance in world px. Click flies there. Capped
at 4. **The inspector counts as off-screen** — a node hidden behind the panel
announces itself. This solves the lost-in-space problem more cheaply than a minimap.

Chips are screen-space, so they must recompute when the camera changes. Recompute on
**camera settle** (150ms debounce), not per frame — arrows that jitter during a pan
are worse than arrows that appear when you stop.

---

# 7. Remaining chrome

## Top bar — 48px
`inset 0 -1px 0 var(--color-divider)`, `z-index: 40`. Left: 20px accent-outlined
brand mark + 14px product name. Then breadcrumbs (12.5px, current context in
`--color-text`, parents in `--color-neutral-500`, 11px caret separators). Right:
Back view (conditional), Search with a `⌘K` chip, shortcut-sheet icon button, Run.
All 28px tall.

## Tool cluster — top-left, 12px inset
Vertical 2-button segment (30×30): select tool `ph-cursor`, hand tool
`ph-hand-grabbing`. Active state `--color-accent-800` / `--color-accent-100`.
Beside it: the lens pill, then a 2-button segment for data-flow and replay.

## Zoom cluster — bottom-left, 12px inset
`[−] [ 23% ⌃ ] [+] | [ Fit ]` in one 30px-tall rounded surface with `--shadow-md`.
The percentage opens a menu upward: 25 / 50 / 75 / 100 / 150%, Fit workflow `1`,
Fit selection `2`, Centre selection `C`, Focus selected node `F`.

## Minimap — 216px wide, above the zoom cluster
Header row: context name, node count, collapse. Body 132px, `--color-neutral-900`.
Nodes as rects scaled to fit the context bounding box with 14px padding, min 3×2.5px.
Colour by type, or by lens when one is active; error nodes `--st-err`; running nodes
pulse. Viewport rectangle: 1px accent border, 10% accent fill, updated imperatively
on every camera change. Click to centre; drag to pan. Toggle with `M`. Collapsing
leaves a map icon button in the zoom cluster.

## Inspector — 328px, right, overlay
Slides in with `transform: translateX(100%) → 0`, 200ms
`cubic-bezier(0.2,0.7,0.2,1)`, `z-index: 35`. It **overlays** the canvas — it does
not reflow it (that would move node positions).

Header: 30px type chip, name at 15px, `TYPE · STATUS` at 10px uppercase, close.
Then Focus / Fit buttons, Straighten this path, and sections:

- **Size** — width presets for structured nodes, numeric W/H for rich nodes.
- **Position** — numeric X/Y.
- **Configuration** — key/value rows, hidden when the node has none.
- **Last run** — latency p95, cost, tokens in/out, error rate, last edited + owner.

**Multi-selection**: hide Size and Configuration entirely — do not render a section
header over empty space. Show `N nodes selected`, the bounding box as
`620 × 442 box`, and a **Selection origin** X/Y whose value is the bounding box's
top-left. Editing it moves every selected node by the delta as one undo step.

## Command palette — `⌘K` / `⌘F`
520px, 88px from the top, over a `--color-neutral-900 45%` scrim. One input searches
nodes **across all contexts** (name, type, summary, config values) and commands in
the same list. Rows: icon, name, hint, context name. Arrow keys move, Enter runs,
Escape closes. Selecting a node in another context switches context, then animates
the camera to it at `max(currentZoom, 0.9)` and pulses its outline
(`nodePulse 700ms ease-out 2`, a brightness pulse) for 1.5s.

## Shortcut sheet — `?`
Modal over the standard dialog backdrop, five grouped columns: Camera, Pointer,
Items, Reading the graph, Chrome. Opens with the line: *single-key shortcuts fire
only when the canvas has focus — never while you are typing.*

## Subflows
A subflow node is enterable by double-click or its Enter button. Entering:

1. Saves the current context's camera.
2. Pushes camera history (`before entering Retrieval`).
3. Switches the node set and shows a breadcrumb `Main workflow / Retrieval`.
4. Restores that subflow's remembered camera, or fits it on first entry.

Each context keeps its **own** camera. Escape returns to the parent.

## Marquee
Screen-space div, 1px accent border, 12% accent fill, updated imperatively during the
drag (never through React state). On release, convert to world coordinates and select
every node whose box **intersects** the rect. Shift/Cmd adds to the existing
selection.

---

# 8. Accessibility

WCAG 2.2 requires a single-pointer alternative to multipoint gestures (2.5.1), a
non-drag alternative to dragging (2.5.7), and 24×24 CSS px minimum targets (2.5.8).

- Zoom: visible `+` / `−` buttons and a percentage menu beside the pinch gesture.
- Move: arrow keys (12px, Shift 1px) **and** numeric X/Y in the inspector.
- Resize: width presets **and** numeric W/H in the inspector — no drag required.
- Fit / focus / centre: all reachable as buttons and as single keys.
- Every control is at least 24px; 30px is the standard here.
- `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }`
  on everything. Never the browser default.
- Multi-select X/Y fields must be real and functional, not placeholders.

---

# 9. State shape

```ts
type Ctx = 'main' | 'retrieval' | 'tools';

interface Node {
  ctx: Ctx;
  type: 'trigger'|'auth'|'guard'|'subflow'|'prompt'|'model'|'branch'
      | 'tool'|'transform'|'db'|'preview'|'note'|'embed';
  name: string;
  x: number; y: number; w: number; h: number;   // world coords
  free?: boolean;                               // free resize vs width presets
  sub?: Ctx;                                    // subflow target
  status?: 'ok' | 'error';
  err?: string;                                 // validation message
  sum?: string;                                 // one-line config summary
  cfg?: [string, string][];
  ports: { in: string[]; out: string[] };
}

interface Group { ctx: Ctx; name: string; x: number; y: number; w: number; h: number; }

// document (undoable)
nodes: Record<string, Node>;
groups: Record<string, Group>;

// camera (own history, never in content undo)
cam: { x: number; y: number; z: number };
cams: Partial<Record<Ctx, Camera>>;   // remembered per context
history: { x: number; y: number; z: number; label: string; ctx: Ctx }[];

// view
ctx: Ctx;
sel: string[];
selGroup: string | null;
focusId: string | null;
inspector: boolean;
lod: 'overview' | 'structure' | 'editing';
zPct: number;
lens: 'status'|'latency'|'cost'|'errors'|'freshness';
flow: boolean;
minimap: boolean;
tool: 'select' | 'hand';
straight: { chain: string[]; saved: Record<string, {x:number;y:number}> } | null;
replay: boolean; t: number; playing: boolean; following: boolean;

// transient
gesture: { kind:'pan'|'move'|'resize'|'marquee'|'gmove'|'gresize'; ... } | null;
hoverNode: string | null;
hoverEdge: string | null;   // `${from}>${to}`
```

**Performance:** write the camera transform imperatively to the world element on
every input event; only re-render when the rounded zoom percentage or the LOD level
changes. Re-rendering 20 nodes per wheel tick is affordable; re-rendering per frame
during a pan is not. Cull nodes outside the viewport and use a spatial index once the
graph is large; simplify rendering below 30% zoom.

---

# 10. Design tokens

Nocturne dark theme. `styles.css` is included in this bundle — read tokens from it
rather than retyping these.

## Colour

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#161826` | canvas ground, page |
| `--color-surface` | `#232532` | node cards, panels, popovers |
| `--color-text` | `#e9e9ed` | body text |
| `--color-accent` | `#9184d9` | selection, focus ring, active state |
| `--color-divider` | `color-mix(in srgb, #e9e9ed 16%, transparent)` | hairlines |

Neutral ramp: `100 #f3f5fe` · `200 #e4e7f5` · `300 #cfd3e5` · `400 #b2b6ca` ·
`500 #9397ab` · `600 #75798c` · `700 #595d6c` · `800 #3f424d` · `900 #292b31`

Accent ramp: `100 #f5f4ff` · `200 #e7e5fe` · `300 #d2cefd` · `400 #b5abfc` ·
`500 #968ae0` · `600 #796cbf` · `700 #5d5294` · `800 #423a6a` · `900 #2b2741`

Status colours added for this canvas (low chroma, matched to the ramp's lightness):

| Token | Value |
|---|---|
| `--st-err` | `#d47a7a` |
| `--st-ok` | `#7fb096` |
| `--st-run` | `#b5abfc` (`--color-accent-400`) |

On this dark ground: 700–900 for tinted fills and borders, 500 as the base,
100–300 for text on those tints. Accent-to-ground is tuned to 3:1 — enough for icons,
large text and chrome, **not** for body copy. Use `--color-accent-300` for
paragraph-size accent text.

## Type
Inter throughout. Headings weight **500** — never bolder; hierarchy is size and
space. Body 400. Node names use the heading face at 13px (20px at overview level).
Interface labels 10–12.5px. Uppercase micro-labels: 10px, `0.06–0.08em` tracking.
Monospace (`ui-monospace, SFMono-Regular, Menlo`) for prompt bodies, payload
samples, and shortcut keys.

## Spacing — density 0.7×
`2.8 · 5.6 · 8.4 · 11.2 · 16.8 · 22.4` px.

## Radius
`--radius-sm 4px` · `--radius-md 8px` · `--radius-lg 14px`. Node cards use `md`.

## Elevation
```
--shadow-sm: 0 0 0 1px #3f424d;
--shadow-md: 0 0 0 1px #595d6c, 0 6px 18px rgba(0,0,0,0.55);
--shadow-lg: 0 0 0 1px #9397ab, 0 16px 40px rgba(0,0,0,0.65);
```
On a dark ground elevation is a hairline edge plus ambient darkness. Do not stack
heavy shadows.

## Grid
Dot grid on the canvas: `radial-gradient(var(--color-neutral-800) 1px, transparent 0)`,
`background-size: 26px * zoom`, `background-position: cam.x % step, cam.y % step` —
set imperatively so the grid tracks the camera exactly.

## Icons
Phosphor (regular). Used: `graph`, `cursor`, `hand-grabbing`, `circles-three`,
`flow-arrow`, `clock-counter-clockwise`, `magnifying-glass`, `keyboard`, `play`,
`pause`, `stop`, `caret-right`, `caret-up`, `caret-down`, `arrow-u-up-left`,
`arrow-right`, `arrows-out-line-horizontal`, `crosshair-simple`, `selection`,
`selection-all`, `selection-plus`, `corners-out`, `map-trifold`, `minus`, `plus`,
`x`, `warning-circle`, `dot-outline`, `arrow-square-in`, `arrow-square-out`,
and per node type: `lightning`, `key`, `shield-check`, `squares-four`,
`text-align-left`, `sparkle`, `git-branch`, `plug`, `function`, `database`,
`monitor-play`, `note`, `vector-three`.

---

# 11. Sample data

Recreate this graph — it exercises every feature (branch, loop, subflows, an invalid
node, rich nodes, three groups).

**Main workflow** — `id · name · type · x,y · w×h`

```
trig    Chat webhook       trigger    60,150   220×76   POST /v1/agent/message
auth    Verify API key     auth       60,280   220×76
rate    Rate limit         guard      60,410   220×76
retr    Retrieval          subflow   380,280   220×88   → retrieval context
note    Ops note           note      380,430   260×132  free resize
prompt  Prompt builder     prompt    700,120   300×230  free resize
model   Claude Sonnet 4.5  model    1080,150   220×76   status ok
router  Tool router        branch   1080,290   220×76
tools   Agent tools        subflow  1080,430   220×88   → tools context
guard   Output guardrail   guard    1420,150   220×76   status error:
                                                        "No refusal policy set"
fmt     Response format    transform 1420,290  220×76
prev    Response preview   preview  1420,420   300×200  free resize
log     Log to Postgres    db       1780,290   220×76
```

Groups: `Input & auth 20,100 300×410` · `Model & tools 660,70 660×490` ·
`Output 1380,100 660×560`

Edges: `trig→auth`, `auth→rate`, `rate→retr`, `retr→prompt`, `prompt→model`,
`model→router`, `router→tools` ("needs a tool"), `tools→model` ("tool_result",
backward/dashed), `router→guard` ("final answer"), `guard→fmt`, `fmt→prev`,
`fmt→log`

**Retrieval subflow:** `r_embed Embed query 80,210` → `r_search Vector search
420,210 240w` → `r_rank Rerank top-k 780,210` → `r_ctx Retrieved chunks 1100,170
300×190 free`

**Agent tools subflow:** `t_web Search API 100,130`, `t_cal Calendar API 100,260`,
`t_sql SQL query 100,390`, all → `t_merge Merge results 460,260`

**Metrics** — `[ms, cents, tokensIn, tokensOut, error%, daysSinceEdit, owner]`

```
trig  [12,0,0,0,0.1,3,Ada]        auth   [38,0,0,0,0.4,12,Ada]
rate  [8,0,0,0,0,12,Ada]          retr   [640,0.9,24,2140,1.2,2,Ravi]
prompt[22,0,2140,2930,0,1,Mira]   model  [1840,4.6,2930,512,2.1,1,Mira]
router[6,0,512,96,0.2,9,Mira]     tools  [910,0.3,96,340,5.8,6,Ravi]
guard [74,0.1,188,188,8.4,21,Ada] fmt    [11,0,188,210,0.1,4,Mira]
prev  [40,0,210,0,0,1,Mira]       log    [26,0,210,0,0.6,30,Ravi]
```

The guardrail is deliberately the worst node on three lenses at once — highest error
rate, oldest edit, and invalid config. It is what the lens feature is for.

Edge payloads (token count + sample) are listed in `PAYLOADS` in the prototype's
logic class; the notable ones are `retr→prompt` 2,140 and `prompt→model` 2,930.

---

# 12. Acceptance criteria

1. The world point under the cursor stays under the cursor while zooming, at every
   zoom level, on both trackpad pinch and Ctrl+wheel.
2. Resize handles measure the same number of screen pixels at 25% and at 200%.
3. Resizing a group changes only its boundary — no child moves or changes size.
4. A whole resize gesture is one Cmd+Z.
5. Cmd+Z never undoes a pan, zoom, fit or focus.
6. Focus, then Escape, returns the camera to **bit-identical** x, y and zoom.
7. Straighten, then Escape, returns every node to its exact prior position.
8. Opening the inspector never changes zoom, and pans by zero when the selected node
   is already clear of the panel.
9. Nothing flickers when the zoom sits exactly on 50% or 90%.
10. Node outer dimensions do not change when a LOD threshold is crossed.
11. Fit workflow never exceeds 110%.
12. A manual pan during follow-execution stops following, and does not resume by
    itself.
13. Every camera command still lands correctly when the tab is backgrounded.
14. In straighten mode, clicking a lane node selects that node — never a hidden one.
15. Single-key shortcuts do nothing while a text field has focus.
16. Zooming, moving, resizing, fitting and focusing are each reachable without any
    drag or multipoint gesture.

---

# 13. Rejected patterns

- Map-style navigation (empty-space drag pans) as the default.
- Free resize on every node type.
- Group resize scaling its children.
- Fit-to-screen on any automatic trigger — panel open, node added, window resize.
- Centre-anchored zoom.
- Scaling the interface chrome with the canvas.
- Camera moves in the content undo stack.
- One generic "zoom to fit" command instead of four distinct ones.
- Gesture-only affordances.
- Rainbow heatmaps for lens magnitude — intensity of one hue instead.

---

# 14. Screenshots

| File | State |
|---|---|
| `01-canvas-states.png` | Fit workflow, overview LOD, status lens |
| `02-canvas-states.png` | Structure LOD (~64%) — type labels, summaries, port dots |
| `03-canvas-states.png` | Editing LOD (100%) — port names, controls, validation pill, edge labels |
| `04-canvas-states.png` | Node selected, inspector open with size presets and last-run block |
| `05-canvas-states.png` | Focus mode — node centred, neighbours lit, everything else at 0.22 |
| `01-canvas-lenses.png` | Latency lens — per-node values, magnitude bars, legend, minimap tint |
| `02-canvas-lenses.png` | Payload edges — stroke weight by tokens, token labels |
| `03-canvas-lenses.png` | Execution replay — scrubber, segments, following-execution indicator |
| `04-canvas-lenses.png` | Straighten path — lane layout, groups hidden, restore banner |
| `05-canvas-lenses.png` | 100% zoom with a selection; off-screen proximity chips at the viewport edge |
| `01-canvas-chrome.png` | Command palette, cross-context search results |
| `02-canvas-chrome.png` | Shortcut sheet |
| `03-canvas-chrome.png` | Retrieval subflow with breadcrumbs and its own camera |
| `04-canvas-chrome.png` | Multi-selection inspector — selection origin, no empty sections |

Screenshots were taken in a 924 × 540 viewport, so zoom percentages read lower than
they will on a real screen. The LOD thresholds are absolute zoom values, not
viewport-relative.

# 15. Files

| File | What it is |
|---|---|
| `Spatial Canvas.dc.html` | The working prototype. Open in a browser; every behaviour above is live. |
| `Canvas Notes.dc.html` | Annotated companion — eleven decisions with diagrams and rationale. |
| `styles.css` | The Nocturne token sheet and component classes. Source of truth for every colour, radius, shadow and spacing value. |
| `screenshots/` | The states listed above. |

Both HTML files are self-contained apart from `styles.css` and the Phosphor icon
font from CDN. They are design references, not production code.
