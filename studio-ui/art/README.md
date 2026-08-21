# Vendored controller art

The pad drawings ksx Studio renders (status-page tiles, the `/map` mapper
stage) come from **[Gamepad-Asset-Pack](https://github.com/AL2009man/Gamepad-Asset-Pack)
by AL2009man — MIT license** (verified upstream 2026-08-05; see
`docs/research/padforge-code-audit.md` §0). Per the license's credit request,
both Studio pages carry the visible footer line:

> controller art: Gamepad-Asset-Pack (MIT) by AL2009man

## Files

| file | source | served as |
|---|---|---|
| `src-xboxseries.svg` | `VSCView Xbox Wireless Controller.svg` (Xbox One/Series shape) | `/_assets/pad-xbox.svg` |
| `src-ds4.svg` | `VSCView DualShock 4 Controller.svg` | `/_assets/pad-ds4.svg` |
| `src-dualshock-tools-ds4.svg` | **NOT Gamepad-Asset-Pack** — dualshock-tools semantic DS4 (MIT); see below | inline `/nocturne` derivative only |
| `src-dualsense.svg` | **NOT Gamepad-Asset-Pack** — see below | `/_assets/pad-ps5.svg` |

## `src-dualshock-tools-ds4.svg` — Nocturne semantic DS4

The active Nocturne DualShock 4 source is
[`assets/dualshock-controller.svg`](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/53e4ba84c7784ffb1aa6c4df79b01384dfd843ec/assets/dualshock-controller.svg)
from `dualshock-tools/dualshock-tools.github.io`, pinned at revision
`53e4ba84c7784ffb1aa6c4df79b01384dfd843ec`. The vendored file is
byte-identical to that revision (SHA-256
`4A3DF18DA942FB581A513546686CD1FEC136A6318F98DF66DB7CF2FB4BD576C0`).
It is MIT-licensed, Copyright (c) 2024 `the_al`; the full terms ship as
`THIRD-PARTY-LICENSES/dualshock-tools-MIT.txt`.

The upstream `0 0 640 518` drawing is semantic runtime geometry: its groups
name the shell, buttons, touchpad, sticks, speaker, shoulders and triggers.
`ds4FreeGeometry.ts` expresses those elements as compiler-visible `h()`
nodes so SSR, no-JS output, hydration and cloned widgets all receive the same
inline SVG. Upstream IDs become `data-ds4-part` attributes because the master
is cloned; the root wrapper, comments, malformed stray comment close and
inactive `TriggerPercentages` text are omitted.

`/nocturne` repaints the source through the shared `nxg-*` carbon gradients,
then adds app-owned grip shade, touch texture, lightbar and PlayStation face
marks. The visible source geometry, 25 transparent mapper hooks, dressing and
key callouts share the `-28 -18 696 550` viewBox. The original paid artwork
remains only in the owner's Downloads folder; no geometry from it is included
in the repository or generated Studio bundle. This source is Nocturne-only,
so it is intentionally not added to `build.mjs`'s standalone `ART` list.

## ⚠️ `src-dualsense.svg` — provenance to confirm before any public release

Supplied by the project owner on 2026-08-21 from
`Downloads\Icons\PS5 Controller\PS5.svg`, alongside a sibling file named
"PS5 Controller (Community).svg" — a name that reads like a Figma Community
file, whose licences vary (CC BY 4.0 is common, but it is per-file). **This
repository has no record of its author or licence**, and neither file carries
metadata naming one. It is committed because it is the art the owner chose;
it must not ship publicly until that line is filled in here and in `NOTICE`.

The source has two deliberately different derivatives. `build.mjs` preserves
the rendered product artwork and makes exactly two deterministic edits — it
removes the full-canvas backdrop rect and rewrites the header to the pad's own
cropped `viewBox`. That keeps the emitted asset a pure function of this source,
which is what the assets byte-diff gate depends on.

`/nocturne` instead uses selected silhouette and control paths inline in
`NocturneIsland.ts`. It omits the export's Figma filters, masks, generated paint
IDs and `foreignObject` stick effects, then paints the geometry through the
page-wide `nxg-*` carbon gradients. The visible body, transparent hook group
and dressing all live in one SVG with that same `70 216 940 640` crop, so there
is no independently-sized overlay box that can drift off the controls. If the
source crop changes, update `DUALSENSE_VIEWBOX` in `build.mjs` and the inline
SVG together.

`build.mjs` copies each source it serves into `crates/ksx-studio/assets/` at build
time, stripped of Inkscape/Sodipodi editor metadata (geometry untouched) and
recolored for the Studio: the solid-black/white source shapes are reclassed to
`.pad-body`/`.pad-detail`/`.pad-inset` and an injected `<style>` palette sheet
maps them to the app's colors — its four token values templated from
`studio-ui/tokens/` (bespoke art colors stay literal), with a
`prefers-color-scheme:light` override so one asset serves both themes. The
**emitted** SVGs, not build.mjs, are what `crates/ksx-studio/tests/contrast.rs`
pins. The two Gamepad-Asset-Pack sources stay byte-identical to upstream for
provenance; the separately documented owner-supplied files do not inherit that
MIT licence.

Why these two: the upstream repo's full-schematic packs cover DualShock/
DualSense/Switch/Arcade but (as of 2026-08-05) ship **no Xbox full
schematic** — the Xbox art exists only in the Controller Type icon set. The
two icons above share one visual language (single-tone body, black control
detail), so the mapper pairs them instead of mixing a 230 KB DS4 schematic
with an 8 KB Xbox glyph.

## Trademark note

The drawings recreate Microsoft/Sony trade dress (the pack's stated nature).
ksx is a local tool in the same use class as the pack's other consumers —
keep the attribution, don't ship the art into a distributed game.

## Hit zones

Per-control elements in these SVGs are NOT addressable (generic
`path2288`-style ids, one layer — inspected 2026-08-05), so the mapper draws
its own overlay of positioned hit-zone buttons instead. The zone tables live
in `../src/MapIsland.ts` and `crates/ksx-studio/src/render_map.rs`
(mirrored; the Rust side is test-pinned). They were **authored from the
art's real geometry**, extracted with:

```
node extents.mjs src-xboxseries.svg
node extents.mjs src-ds4.svg
```

(the PadForge lesson — derive layout data from the art with a script, never
trace by eye), plus hand placement for controls the icon art does not draw
(shoulders/triggers on both pads; start/back/guide on the Xbox one). Re-run
the extractor after swapping art, then re-author the tables and let
`zone_tables_cover_every_mappable_function` + the render tests catch drift.
