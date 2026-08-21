# Vendored: the forma-genui-runtime canvas engine

Upstream: `getforma-dev/forma-genui-runtime` (private, internal getforma-dev
source — Victor's own; `UNLICENSED`, never published).
Source revision: **`c91d34c`** ("feat: extract Forma generative UI runtime"),
vendored 2026-08-21 per option 1 of the upstream `README.md`'s "Using this
from KSX" section ("Vendor the reviewed `src/canvas`, optional `src/forma`,
and `styles/canvas.css` files into KSX and record the source commit" —
`docs/KSX_HANDOFF.md` endorses the same route).

What was taken (byte-identical to upstream except the four marked
divergences in `widget-canvas.ts` — see below):

- `canvas/` — the whole engine: `widget-canvas.ts` (camera, world
  coordinates, drag, focus/fit, spatial keyboard navigation, capacity),
  `canvas-surface.ts`, `canvas-item.ts`, `widget-chrome.ts`,
  `widget-chrome-placement.ts`, `keyboard-shortcuts.ts`,
  `runtime-adapter.ts`, `canvas-capacity.ts`, `index.ts`
- `contracts.ts`, `persistence/session-store.ts` — the types beside it
- `../genui-canvas.css` — upstream `styles/canvas.css`, also byte-identical;
  the Nocturne skin lives in `studio.css` §9 ("THE CANVAS"), which
  concatenates AFTER this sheet on purpose so its overrides win by order

Deliberately left behind: `src/forma/` (the Forma artifact host —
`/nocturne`'s widgets are plain DOM content and need no `@getforma/core`
linkage), the Rust crate (catalog/plan/semantic routing — a planner concern
this integration does not have), and every test/build file.

Local divergences from upstream — every one carries a `// ksx:` comment in
`widget-canvas.ts` and should be offered back upstream at the next sync
(all four came out of the 2026-08-21 adversarial review of the /nocturne
integration; none is ksx-specific policy, all are engine correctness):

1. **Preferred-width ceiling 720 → 1600** (`#normalizedPlacement`): the old
   clamp silently discarded any `data-canvas-preferred-width` above 720px —
   ksx's keyboard declares 980px and was cropped into its own scrollbar.
   The resizable-restore ceiling (840) was raised to 1600 to match.
2. **Height source for adapter-less items** (ResizeObserver callback):
   items mounted as plain `content` register no runtime host, so upstream's
   adapter-owned height source never fired and the recorded height stayed
   the mount-time guess forever — mis-framing `fitAll` and "parking"
   (inert + `content-visibility: hidden`) widgets that were actually on
   screen. When no runtime host exists for the item, its own border box is
   now the height source.
3. **Per-item listener lifetime** (`#itemAborts`): item-scoped listeners
   (item focus/keydown/pointerdown, drag-handle pointerdown/keydown) were
   registered on the canvas-lifetime abort signal, stranding closures over
   detached DOM on every `removeItem`/remount cycle — ksx rebuilds pad
   widgets on each roster print, so this compounded. Each item now gets its
   own `AbortController`, aborted in `removeItem`/`clearItems`;
   `AbortSignal.any` keeps `dispose()` authoritative. (`AbortSignal.any` is
   baseline since Chrome 116 / Safari 17.4 — fine for Studio's targets.)

4. **`placeItem(item, x, y)`** — a public door onto the placement
   `#moveItem` already performs for drags and keyboard nudges. Without it a
   host cannot lay its own widgets out; ksx's "Tidy up" (board on top,
   controllers in seat order beneath) is written against it. Upstream has
   no auto-arrange of any kind — verified against
   `getforma-dev/forma-generative-ui` @ `1dd1823`, which has no tidy,
   pack, align or reflow anywhere — so this is an addition rather than a
   correction, and the most obviously upstreamable of the four.

Re-syncing against a newer upstream commit means re-applying (or better,
upstreaming) the `// ksx:` blocks — grep for `ksx:` after copying. As of
`93c3871` (2026-08-21) upstream's `src/canvas` and `styles/` are unchanged
since `c91d34c`, so the vendored copy is current apart from these four.
Everything else ksx needs differently is done outside these files: skin and
no-JS rules in `studio.css`, wiring in `NocturneIsland.ts`
(`initNocturneCanvas` adopts a server-rendered skeleton instead of calling
`createCanvasSurface`, and feeds the navigator DETACHED nodes to keep the
minimap out of the DOM), persistence in the island's `ksx-nocturne-canvas`
localStorage store.
