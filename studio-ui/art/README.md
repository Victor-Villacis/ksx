# Vendored controller art

The standalone pad drawings ksx Studio renders in status-page tiles and the
`/map` mapper come from
**[Gamepad-Asset-Pack](https://github.com/AL2009man/Gamepad-Asset-Pack) by
AL2009man — MIT license** (verified upstream 2026-08-05; see
`docs/research/padforge-code-audit.md` §0). Nocturne's interactive controller
widgets use separate inline hybrid drawings documented below. Per the MIT
pack's credit request, the pages that use its art carry the visible footer:

> controller art: Gamepad-Asset-Pack (MIT) by AL2009man

## Files

| file | source | served as |
|---|---|---|
| `src-xboxseries.svg` | `VSCView Xbox Wireless Controller.svg` (Xbox One/Series shape) | `/_assets/pad-xbox.svg` |
| `src-ds4.svg` | `VSCView DualShock 4 Controller.svg` | `/_assets/pad-ds4.svg` |
| `src-dualshock-tools-ds4.svg` + four external `DualShock4_*_small.svg` files | **NOT Gamepad-Asset-Pack** — hybrid dualshock-tools MIT and Funky Designs UK CC0 sources; see below | generated inline `/nocturne` derivative only |
| external `PS5_controller_small.svg` | Funky Designs UK CC0; see the trio record below | `dualSensePremiumGeometry.ts` + inline `/nocturne` master |
| external `Switch_Pro_Controller_detail_small.svg` | Funky Designs UK CC0; see the trio record below | `switchProPremiumGeometry.ts` + inline `/nocturne` master |
| external `SeriesX_Controller_*_small.svg` files | Funky Designs UK CC0; see the trio record below | `xboxSeriesPremiumGeometry.ts` + `xboxSeriesPremiumArt.ts` inline `/nocturne` master |

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
`C:\Users\Victor\Downloads\KSX Paid and Free Assets\CC0_Public_Domain_Dedication_Funky_Designs.pdf`
(SHA-256
`5E45318030E7A8F38580F76BD8DCF46C0C3E4E4D6380551C7FD1839F10C55B31`).
It names Forma.js as licensee and expressly includes artwork depicting the PS4
Controller DualShock, PS5 DualSense, Xbox Series X Controller and Switch Pro
Controller. CC0 is a public-domain dedication with a public-license fallback,
so the named artwork may be copied, modified and distributed, including
commercially, without asking permission.
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

## Nocturne premium trio — Funky Designs UK CC0

The same reviewed dedication used by the DualShock 4 names three additional
works: artwork depicting the **PS5 DualSense, Xbox Series X Controller and
Switch Pro Controller**. Its exact evidence and legal limits are recorded
above and in `NOTICE`: the copyright dedication permits commercial reuse and
modification, but it does not grant hardware trademarks, patents or trade
dress. The source archives remain in the owner's Downloads folder. Only the
deterministically generated inline derivatives are compiled into Studio.

### DualSense

The canonical source is
`C:\Users\Victor\Downloads\KSX Paid and Free Assets\DualSence PS5\PS5_controller.zip`
(SHA-256
`2EE5D51F310E73B2464C1D1A6B3856F4DEBD9E1495358962ACADBFDFA57C5160`).
Its selected `PS5_controller_small.svg` entry has SHA-256
`1A295010C4318D1EE64A735E2F285F75E47A4D64F8727AA1C0708A06BADF10BA`
and viewBox `0 0 3801 2521`.

`scripts/compile-funky-dualsense.mjs` requires that exact hash, viewBox and
89-shape structure, then emits `src/dualSensePremiumGeometry.ts`. The source
coordinates enter the `70 216 940 640` Nocturne master through
`matrix(0.2421052632 0 0 0.2421052632 80 234)`. The generated module contains
the licensed body, semantic paint roles, explicit offset vector depth and the
25-control hook vocabulary; `src/dualSensePremiumArt.ts` supplies the complete
body/hook/callout master and app-authored L1/R1 bumper plates.

The single licensed drawing supplies geometry, not a set of color exports.
White, Midnight Black, Cosmic Red, Nova Pink, Starlight Blue and Galactic
Purple are six app-authored material palettes informed by real product color
families. Switching a finish changes paint variables only; geometry and hooks
do not move.

Rebuild the checked-in module from the extracted entry with:

```powershell
node studio-ui/scripts/compile-funky-dualsense.mjs `
  <PS5_controller_small.svg>
```

### Switch Pro

The canonical source is
`C:\Users\Victor\Downloads\KSX Paid and Free Assets\Switch Pro\Switch_Pro_Controller_detail.zip`
(SHA-256
`9B11A0B150911E8BD62506436DC4DFC90D5AA66A9FBF10BB50821AF3F333607F`).
Its selected `Switch_Pro_Controller_detail_small.svg` entry has SHA-256
`FFF8851462BBDD746BE392437F8A14167AAA20D62A65ACFAAEDC411EDB153B52`
and source viewBox `0 0 960 960`.

`scripts/compile-funky-switch-pro.mjs` validates that source's 76 shapes and
emits `src/switchProPremiumGeometry.ts`. Geometry stays in its identity
coordinate system and the inline master crops it to `10 145 940 670`.
`src/switchProPremiumArt.ts` keeps the detailed body, depth, 25 hooks and
callouts in that one SVG. Its mapper semantics are deliberate: Capture is
`back`, Plus is `start`, and Home is `guide`; the app-owned front L/R bumper
plates keep L/R distinct from the paid drawing's rear ZL/ZR silhouettes.

The right and left grip textures are two closed compound paths whose individual
`d` attributes exceed FMIR's u16 string-table slot. The compiler losslessly
splits only those two paths at already-closed subpath boundaries, converting
each chunk's leading relative move to the equivalent absolute move. Pixels,
winding, paint and source order are unchanged. Chunk groups retain source
indices 7 and 9, and the generated module still exposes all 76 unique source
indices.

Carbon Black, Ink Pair, Crimson Red and Frost White are app-authored palettes
over the one licensed detailed geometry. Rebuild with:

```powershell
node studio-ui/scripts/compile-funky-switch-pro.mjs `
  <Switch_Pro_Controller_detail_small.svg>
```

### Xbox Series X|S

The supplied outer bundle is
`C:\Users\Victor\Downloads\KSX Paid and Free Assets\Xbox Series X\SeriesX_Controllers.zip`
(SHA-256
`E64FB9D1C70855B1ACBD86F5B6887C9E852CF4404402D219E9F72F8360BE3611`).
It contains five nested source archives:

| finish | nested archive SHA-256 | selected `_small.svg` SHA-256 |
|---|---|---|
| Carbon Black | `98145FBE73FA989CD132CFB08D3BE891AF3352130C057B98E87A2AB203352231` | `15229EA57B7059D3EDDABA5C223E080799E322172688F928759D133D3F36F0A1` |
| Robot White | `044E3C020D5A4EB54B233FB12623EF18AE153219D368C475EAB599F04EDCF468` | `20CF3E05F273CA70D2B081FE49BD7A0EB5B44EBAAFFC3D73D7AFCD41258DC487` |
| Shock Blue | `92AE0525D9BA9B951DC881DD9DE18D2B6E0B1D889083351FB742FAB0B3F029E0` | `0241274A159DE2B8B10E0E816AF95FAB366C077A7A749D113F910BA5428EDC0E` |
| Pulse Red | `0A441F2AB0015FEAD153A93C25572EF1057A506F72499E7F62E00B63ADF82AC9` | `226B5CDE638C72AE4FC3745E530D84A55AEEF0FAA836D97D4BCAD72618CD247A` |
| Electric Volt | `7AF60C843100E01EF3045E5EBA198FC95D108C9DFE4B22A56C4DA76B97B75F58` | `39A9BD501B696E886CEAFEDFC968F94ED7DE69E42813C7D6C5F70B318AA4C82A` |

All five entries use viewBox `0 0 3800 2647`.
`scripts/compile-funky-xbox-series.mjs` validates their hashes, named groups
and cross-finish shape roles. Carbon Black supplies the canonical 80-shape
geometry; the other four entries contribute source-authored paint values.
The generated `src/xboxSeriesPremiumGeometry.ts` omits export palette dots
and alternate colored-stick construction, then adds app-owned bumper and
guide detail, explicit vector depth, and 25 whole-control hooks.
`src/xboxSeriesPremiumArt.ts` assembles those layers and matching callouts into
the complete inline master. The visible Share button remains dressing because
the mapper's existing `back` function belongs to View; Menu is `start` and the
app-owned center button is `guide`.

Rebuild with the five extracted entries in this fixed order:

```powershell
node studio-ui/scripts/compile-funky-xbox-series.mjs `
  <SeriesX_Controller_Black_small.svg> `
  <SeriesX_Controller_White_small.svg> `
  <SeriesX_Controller_Blue_small.svg> `
  <SeriesX_Controller_Red_small.svg> `
  <SeriesX_Controller_Green_small.svg>
```

### Shared inline and research contract

Each compiler fails closed on source hash/shape/viewBox drift, strips source
IDs and editor metadata, assigns explicit semantic classes, and emits no
raster or external resource. Body, app-authored offset-shadow geometry,
transparent whole-control hooks and labels are sibling groups inside the same
SVG coordinate system. No Nocturne clone contains an `img`, filter, mask,
private `defs`, `foreignObject` or product-photo pixel. Document-wide `nxg-*`
paint servers and per-family CSS variables provide the material finish without
duplicating IDs into every widget.

The final deterministic importer and generated-module bytes are pinned here so
source-to-runtime provenance includes the SSR-safe wrappers as well as source
geometry:

| file | SHA-256 |
|---|---|
| `scripts/compile-funky-dualsense.mjs` | `8565AEFBDFE3B42777476EDF7600D2B8C84EF31AF7A8B0211BC7737686795107` |
| `src/dualSensePremiumGeometry.ts` | `B869750BD153681A8A27BF6CD2879CAC0742780789A3E08F189058B836D47846` |
| `src/dualSensePremiumArt.ts` | `2EF59983923F6D8D24E49110C198F7DE573486377CE0D26960C0C148A25B02D2` |
| `scripts/compile-funky-switch-pro.mjs` | `90B83DB08F9D70F763A5F92A20D852AF95737D558B752546C6E7DE41F39D4EAC` |
| `src/switchProPremiumGeometry.ts` | `4020678345B91E7BDCC5F767E12FDEB8DAE8F88EA5804B9E065B1026B0B09FE8` |
| `src/switchProPremiumArt.ts` | `815BCB2BF3F42F9870BF3FA4A9D2EF5641F566B815E50C3FC61D230ED37E8CA0` |
| `scripts/compile-funky-xbox-series.mjs` | `9C361446B936FFF074457ED43350E67B6FD6D5CCD1D888783D592E8252D59E5D` |
| `src/xboxSeriesPremiumGeometry.ts` | `A066EDB3B724F578644F563F7F577509766D5237A7983123306375AAA1E6CAA7` |
| `src/xboxSeriesPremiumArt.ts` | `C0DB070027091C2FBF1D7BCF43FB51ECD17FE77F180C087A3F6D894314C1C765` |

The moved `KSX-Free-Vector-Assets` pack was research-only for this trio. The
MIT PlayStation semantic/alternate drawings, Zacksly CC BY 3.0 Switch Pro,
public-domain Xbox Series control parts and Xelu CC0 atlas helped audit
identity, proportions and mapper vocabulary; **no geometry from those files
is copied into the generated trio**. Their licenses therefore do not replace
or augment the Funky Designs source chain. If any such geometry is incorporated
later, its exact file, hash, attribution and license must be added here first.

### Retired legacy DualSense bytes

The former `studio-ui/art/src-dualsense.svg` came from the older owner-supplied
`Downloads\Icons\PS5 Controller\PS5.svg`. Neither it nor the sibling Figma
Community-named file carried author or license metadata, and those bytes were
**not covered by the Funky Designs CC0 dedication**. The source, its generated
`crates/ksx-studio/assets/pad-ps5.svg`, and the corresponding `build.mjs`
generator have all been removed. They are no longer built, embedded or shipped;
the licensed premium inline DualSense documented above is the only Nocturne
DualSense source chain.

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
premium Nocturne modules have their own hash-pinned Funky Designs CC0 source
chain and are intentionally outside `build.mjs`'s standalone `ART` list. The
unlicensed legacy DualSense input and output described above are absent from
the source tree and build pipeline.

Why these two: the upstream repo's full-schematic packs cover DualShock/
DualSense/Switch/Arcade but (as of 2026-08-05) ship **no Xbox full
schematic** — the Xbox art exists only in the Controller Type icon set. The
two icons above share one visual language (single-tone body, black control
detail), so the mapper pairs them instead of mixing a 230 KB DS4 schematic
with an 8 KB Xbox glyph.

## Trademark note

The drawings recreate Microsoft, Nintendo and Sony hardware trade dress.
Their MIT and CC0 copyright permissions do not grant trademark, patent or
trade-dress rights; keep the attribution and non-affiliation record, and never
imply endorsement.

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
