# Vendored controller art

The pad drawings ksx Studio renders (status-page tiles, the `/map` mapper
stage) come from **[Gamepad-Asset-Pack](https://github.com/AL2009man/Gamepad-Asset-Pack)
by AL2009man — MIT license** (verified upstream 2026-08-05; see
`docs/research/padforge-code-audit.md` §0). Per the license's credit request,
both Studio pages carry the visible footer line:

> controller art: Gamepad-Asset-Pack (MIT) by AL2009man

## Files

| file | upstream source (Connection Icon Pack → Controller Type → SVG) | served as |
|---|---|---|
| `src-xboxseries.svg` | `VSCView Xbox Wireless Controller.svg` (Xbox One/Series shape) | `/_assets/pad-xbox.svg` |
| `src-ds4.svg` | `VSCView DualShock 4 Controller.svg` | `/_assets/pad-ds4.svg` |
| `src-dualsense.svg` | **NOT Gamepad-Asset-Pack** — see below | `/_assets/pad-ps5.svg` |

## ⚠️ `src-dualsense.svg` — provenance to confirm before any public release

Supplied by the project owner on 2026-08-21 from
`Downloads\Icons\PS5 Controller\PS5.svg`, alongside a sibling file named
"PS5 Controller (Community).svg" — a name that reads like a Figma Community
file, whose licences vary (CC BY 4.0 is common, but it is per-file). **This
repository has no record of its author or licence**, and neither file carries
metadata naming one. It is committed because it is the art the owner chose;
it must not ship publicly until that line is filled in here and in `NOTICE`.

Unlike the two above it does NOT go through `cleanSvg`: those are flat
schematics whose solid shapes get reclassed onto a palette sheet, while this
is a rendered photoreal pad (gradients, masks, blur filters) that reclassing
would destroy. `build.mjs` makes exactly two deterministic edits — removes the
full-canvas backdrop rect and rewrites the header to the pad's own cropped
`viewBox` — so the emitted bytes stay a pure function of this source, which is
what the assets byte-diff gate depends on.

⚠️`/nocturne`'s hook overlay declares that same crop (`PS5_VIEWBOX` in
`NocturneIsland.ts`, `DUALSENSE_VIEWBOX` in `build.mjs`). They are one number
in two files: change one and every hook slides off its button.

`build.mjs` copies each source into `crates/ksx-studio/assets/` at build
time, stripped of Inkscape/Sodipodi editor metadata (geometry untouched) and
recolored for the Studio: the solid-black/white source shapes are reclassed to
`.pad-body`/`.pad-detail`/`.pad-inset` and an injected `<style>` palette sheet
maps them to the app's colors — its four token values templated from
`studio-ui/tokens/` (bespoke art colors stay literal), with a
`prefers-color-scheme:light` override so one asset serves both themes. The
**emitted** SVGs, not build.mjs, are what `crates/ksx-studio/tests/contrast.rs`
pins. The committed sources here stay byte-identical to upstream for
provenance.

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
