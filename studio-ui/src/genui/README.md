# Vendored: the forma-genui-runtime canvas engine

Upstream: `getforma-dev/forma-genui-runtime` (private, internal getforma-dev
source — Victor's own; `UNLICENSED`, never published).
Source revision: **`c91d34c`** ("feat: extract Forma generative UI runtime"),
vendored 2026-08-21 per the upstream's own `docs/KSX_HANDOFF.md` option 1
("Vendor the reviewed `src/canvas`, optional `src/forma`, and
`styles/canvas.css` files into KSX and record the source commit").

What was taken, byte-identical to upstream:

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

Local divergences from upstream: **none.** The engine files must stay
byte-identical — re-syncing against a newer upstream commit is a plain copy
plus updating the revision above. Anything ksx needs differently is done
outside these files: skin and no-JS rules in `studio.css`, wiring in
`NocturneIsland.ts` (`initNocturneCanvas` adopts a server-rendered skeleton
instead of calling `createCanvasSurface`, and feeds the navigator DETACHED
nodes to keep the minimap out of the DOM), persistence in the island's
`ksx-nocturne-canvas` localStorage store.
