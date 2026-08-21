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
| `src-dualshock-tools-ds4.svg` + four external `DualShock4_*_small.svg` files | **NOT Gamepad-Asset-Pack** — hybrid dualshock-tools MIT and Funky Designs UK CC0 sources; see below | generated inline `/nocturne` derivative only |
| `src-dualsense.svg` | **NOT Gamepad-Asset-Pack** — see below | `/_assets/pad-ps5.svg` |

## Nocturne DualShock 4 — dualshock-tools MIT + Funky Designs UK CC0

The semantic Nocturne DualShock 4 reference is
[`assets/dualshock-controller.svg`](https://github.com/dualshock-tools/dualshock-tools.github.io/blob/53e4ba84c7784ffb1aa6c4df79b01384dfd843ec/assets/dualshock-controller.svg)
from `dualshock-tools/dualshock-tools.github.io`, pinned at revision
`53e4ba84c7784ffb1aa6c4df79b01384dfd843ec`. The vendored file is
byte-identical to that revision (SHA-256
`4A3DF18DA942FB581A513546686CD1FEC136A6318F98DF66DB7CF2FB4BD576C0`).
It is MIT-licensed, Copyright (c) 2024 `the_al`; the full terms ship as
`THIRD-PARTY-LICENSES/dualshock-tools-MIT.txt`.

The canonical detailed geometry is the project owner's
`C:\Users\Victor\Downloads\DualShock 4\DualShock4_Jet_Black.zip`
(SHA-256 `28A22A03379A68451E339B30865C7BA7C7C29193723EC87E17FB52FACFA070C7`).
Its selected `DualShock4_Jet_Black_small.svg` entry has SHA-256
`97BD7A3ADE8B38B06B9769C5E843C51E467BEABFA4581BAB3830ABF60014F144`.
Three sibling sources contribute their authored finish palettes:

| finish | archive SHA-256 | selected `_small.svg` SHA-256 |
|---|---|---|
| Glacier White | `0748B6C76FA2C0EC7C7E69590383F1F8BA391E0831DB1F3B45D14E4432F80B32` | `BF14390606252C2106B18D8869151BF1686D925B6E306A32D635C7FEF26D5549` |
| Magma Red | `F6D59BE0A20CC7EF9698D43A0B0703D1EA76387B707260A90A31BF1047C40F83` | `CFF42BF349FAB306DC57021F21912E35190FEC78A3EF193C8B372099C8406E48` |
| Midnight Blue | `B9FE4FA6528FCC9AFA52F7590E5D141F8FC68983B12E1090ADC19D057061D2A0` | `0B23A9FE39047F059ADB528F180C971EDFDB5A59F7835EC6E71B23722B0751FF` |

Funky Designs UK dedicated its controller artwork under CC0 1.0 Universal
on 2026-08-21. The supplied evidence is
`C:\Users\Victor\Downloads\CC0_Public_Domain_Dedication_Funky_Designs.pdf`
(SHA-256
`5E45318030E7A8F38580F76BD8DCF46C0C3E4E4D6380551C7FD1839F10C55B31`).
It names Forma.js as licensee and expressly includes "Artwork depicting PS4
Controller DualShock" among the dedicated works. CC0 is a public-domain
dedication with a public-license fallback, so the named artwork may be copied,
modified and distributed, including commercially, without asking permission.
The exact supplied PDF ships as
`THIRD-PARTY-LICENSES/Funky-Designs-CC0-1.0-Dedication.pdf`; the canonical
Creative Commons legal code ships as `THIRD-PARTY-LICENSES/CC0-1.0.txt`.
CC0 does not waive third-party trademark, patent, trade-dress, publicity or
privacy rights and does not permit implying endorsement.

The upstream `0 0 640 518` MIT drawing remains the semantic reference: it
names the controller's shell, buttons, touchpad, sticks, speaker, shoulders
and triggers. `ds4FreeGeometry.ts` is its compiler-visible transcription. The
active hybrid keeps its two L2/R2 shapes and its established 640-unit mapper
vocabulary, but does not paint the schematic body beneath the detailed art.

`scripts/compile-funky-ds4.mjs` deterministically converts the four supplied
small SVGs into `src/ds4PremiumGeometry.ts`. Jet Black supplies the canonical
130-shape geometry. The importer strips every source ID and editor attribute,
omits nine invisible/export-only shapes (including the 40 KB touch-dot path),
matches sibling color elements by geometry signature, and emits 121 visible
inline `h()` shapes plus ten palette tones. The touch dots become one shared
`nxp-ds4-paid-touch` pattern. Rebuild that checked-in source with:

```powershell
node studio-ui/scripts/compile-funky-ds4.mjs `
  <Jet-Black-small.svg> <Glacier-White-small.svg> `
  <Magma-Red-small.svg> <Midnight-Blue-small.svg>
```

`/nocturne` renders the detailed art at the exact `640 / 3800` scale,
`matrix(0.1684210526 0 0 0.1684210526 0 105)`, inside the established
`-28 -18 696 550` viewBox. Twenty-three whole-control hook shapes repeat that
same transform; app-authored L2/R2 complete the mapper's 25 controls. Art,
hooks and callouts therefore share one SVG and cannot drift. The four skinny
header controls switch only ten paint variables (Jet Black, Glacier White,
Magma Red and Midnight Blue); they never replace or move geometry. The main
shell uses one document-wide Studio gradient per finish while the detailed
source shading, face marks, speaker, EXT/headset input details and ports stay
vector geometry. No `img`, filter, mask, private `defs` or dimming filter is
part of a clone.

The four ZIPs remain in the owner's Downloads folder; only the generated
inline derivative is compiled into Studio. This is Nocturne-only, so it is
intentionally not added to `build.mjs`'s standalone `ART` list.

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
pins. The two Gamepad-Asset-Pack sources and the dualshock-tools source stay
byte-identical to their respective upstream revisions for provenance. The
owner-supplied Funky Designs source has its own CC0 dedication and does not
inherit either MIT licence.

Why these two: the upstream repo's full-schematic packs cover DualShock/
DualSense/Switch/Arcade but (as of 2026-08-05) ship **no Xbox full
schematic** — the Xbox art exists only in the Controller Type icon set. The
two icons above share one visual language (single-tone body, black control
detail), so the mapper pairs them instead of mixing a 230 KB DS4 schematic
with an 8 KB Xbox glyph.

## Trademark note

The drawings recreate Microsoft/Sony hardware trade dress. Their MIT and CC0
copyright permissions do not grant trademark, patent or trade-dress rights;
keep the attribution and non-affiliation record, and never imply endorsement.

## Hit zones

Per-control elements in the standalone Gamepad-Asset-Pack status/map SVGs are
NOT addressable (generic
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
