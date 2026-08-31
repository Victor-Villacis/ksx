//! Shared controller-zone and macro-domain presentation rules.
//!
//! The standalone `/map` page was retired at the redesign hard cutover, but
//! the product snapshot and macro editor still need one authoritative set of
//! persona labels, hit-zone geometry, duration rules and diagonal folding.
//!
//! # The zone model
//!
//! The controller art (Gamepad-Asset-Pack, MIT — see `studio-ui/art/README.md`)
//! is an `<img>` filling the bottom `ART_SHARE` of a fixed-aspect "stage";
//! the top band holds the LB/RB/LT/RT chips (the icon art does not draw
//! shoulders), stacked trigger-over-bumper and visually anchored to the body
//! silhouette below. Every mappable control is a HIT ZONE: an absolutely
//! positioned
//! `<button data-fn=…>` from the [`ZONE_XBOX`]/[`ZONE_DS4`] tables.
//!
//! v7 — **every zone wears its own IDENTITY** (requirement: "I can see G is mapped
//! to A but I can't see the A xbox button"). The vendored art is a line
//! drawing with no letters on it, so the zone renders the control's name
//! itself: a persona-aware glyph in the canonical colors (A green, B red,
//! X blue, Y amber; ✕ blue, ○ red, △ green, □ pink), LB/RB/LT/RT and
//! view/menu/guide as text chips, arrows for the dpad and the stick wedges.
//!
//! v16 — direction glyphs are UNIFIED ON ARROWS (`↑ ↓ ← →`, not `▲ ▼ ◀ ▶`)
//! everywhere, art included. The macro grid gives every direction group its
//! own eight-position ring (`↑ ↖ ← ↙ ↓ ↘ → ↗`), so ALL FOUR diagonals are
//! columns you can point at — a 360 walks every one of them — and `◤◥◣◢` are
//! corner *blocks*, not directions: a diagonal that did not look like the same
//! family as its two parents would defeat the whole lens (see `fold`, below).
//! The bound key rides UNDER the identity as the small mono `ztag` — identity
//! always, key tag whenever the stage is wide enough for it (a container query
//! drops the tag on a phone; the legend still carries every key). An unbound
//! control therefore still reads as a controller, which is the whole point.
//!
//! The readable truth is the bindings LEGEND below the stage: one row per
//! function (same identity glyph + group prefix + key tag), carrying the same
//! `data-fn` so a row click is exactly the zone click, and hover
//! cross-highlights via the client's shared hot signal. One `createList`
//! renders all 25 zones, another the 25 legend rows; geometry is data, not
//! markup.
//!
//! # Shared keys are information, never a conflict
//!
//! One key driving several controls is native to the engine (`preset.rs`: "one
//! key → many functions"; docs/INPUT-TRANSFORMS.md §1a) and is exactly what
//! v7's multi-select flow writes. Both readers say so instead of complaining:
//! a control whose key is also bound elsewhere in the same preset gets
//! `z-shared`/`l-shared` (a cool-toned key tag), and its legend row carries a
//! compact "also A · B" badge naming the co-bound controls.
//!
//! Zone coordinates are STAGE percentages, authored from the art's real
//! geometry (`studio-ui/art/extents.mjs` — the PadForge lesson: derive layout
//! from art with a script, never trace by eye) plus hand placement for the
//! shoulders and the small center buttons — which `build.mjs` now also draws
//! into the recolored art at the same coordinates. A Rust-owned generated
//! handoff carries the tables through `studio-ui/tokens/zones.json` into
//! `studio-ui/src/zones.gen.ts` for the client re-derivation per poll (the
//! established applyStatus pattern); `zone_tables_cover_every_mappable_
//! function` pins the art against the domain vocabulary.

// `art_for` is deliberately NOT imported any more. `zones_for` used to ask it
// which art a persona drew and infer the zone table from the answer, which made
// the geometry a consequence of an unrelated substring match: add a persona
// that draws the Xbox body and it silently inherited the Xbox pad's two analog
// sticks and two triggers. Both now come from the same
// `PAD_PRESENTATIONS` row.
use crate::snapshot::{MacroStepView, MacroView, MapperSlot};

// The art `<img>` occupies the bottom 86% of the stage (`.padart` in
// studio.css); the top band holds the shoulder chips. Zone Y values below
// are authored as `14 + artY·0.86`.

/// One hit zone: canonical function, on-art identity label, identity palette,
/// stage-percent box, css variant.
///
/// Only `fn_name` and `label` are read by Rust. The geometry and styling
/// fields exist for the Rust -> Node handoff: `generated_zone_tokens_json`
/// serialises them into `studio-ui/tokens/zones.json`, which the TypeScript
/// side consumes to place the same zones on the canvas. That generator is
/// `#[cfg(test)]` because `tools/studio-env/build-assets.ps1` runs it as an
/// `--ignored` test, so a non-test build genuinely has no reader and
/// `dead_code` fires on fields the asset build cannot do without. Deleting
/// them is a silent break of zones.json, not a cleanup - hence the allow.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct Zone {
    pub fn_name: &'static str,
    /// What this control is CALLED on this persona — the identity drawn on the
    /// art ("A", "✕", "LB", "▲", "menu").
    pub label: &'static str,
    /// Identity palette class suffix (`id-<idk>` in studio.css): the Xbox face
    /// colors `xa`/`xb`/`xx`/`xy`, the Sony glyphs `pc`/`po`/`pt`/`psq`,
    /// `dir` (dpad + stick arrows), `hub` (L3/R3), `txt` (view/menu/guide,
    /// share/options/PS), `sh` (shoulders).
    pub idk: &'static str,
    /// Center, stage percent.
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
    /// CSS variant class: round | chip | trigger | bumper.
    pub kind: &'static str,
}

/// `rect` is the stage-percent box as `[cx, cy, w, h]` — one argument so the
/// tables below read as columns, and so geometry stays a unit.
const fn zone(
    fn_name: &'static str,
    label: &'static str,
    idk: &'static str,
    rect: [f32; 4],
    kind: &'static str,
) -> Zone {
    Zone {
        fn_name,
        label,
        idk,
        cx: rect[0],
        cy: rect[1],
        w: rect[2],
        h: rect[3],
        kind,
    }
}

/// Xbox-series-style pad (art: `pad-xbox.svg`, viewBox 112.46×76.66; anchors
/// from extents.mjs: face Y(75.2,19.9) B(82.0,29.8) A(75.3,39.9) X(68.7,29.9),
/// Lstick(24.0,29.9), Rstick(62.5,51.6), dpad(36.4,53.4) — art Y mapped to
/// stage as 14 + y·0.86).
///
/// Rects are pairwise DISJOINT (pinned by `zone_rects_are_pairwise_disjoint`,
/// which checks every table in `PAD_PRESENTATIONS`, not just this one): face
/// buttons sized to the drawn circles, and the four stick-direction wedges RING
/// the stick with the L3/R3 click zone as the 8×10 center hub — adjacent, never
/// covering it. **Adjacent is legal and intended**; the test allows a shared
/// edge and refuses a shared area.
pub(crate) const ZONE_XBOX: &[Zone] = &[
    // Shoulders (not drawn in the icon art): slim chips stacked trigger-over-
    // bumper like the real pad, anchored just above the body's top plateau
    // (stage x ≈ 32..68) — .z-bumper drops a connector line onto the body.
    zone("lt", "LT", "sh", [31.0, 4.6, 10.0, 5.2], "trigger"),
    zone("lb", "LB", "sh", [34.0, 10.9, 11.0, 5.2], "bumper"),
    zone("rb", "RB", "sh", [66.0, 10.9, 11.0, 5.2], "bumper"),
    zone("rt", "RT", "sh", [69.0, 4.6, 10.0, 5.2], "trigger"),
    // Face cluster (diamond — boxes trimmed to the drawn Ø7.3×9.1 circles so
    // the diagonal neighbours stay disjoint). Canonical Xbox colors.
    zone("Y", "Y", "xy", [75.2, 31.1, 7.2, 8.4], "round"),
    zone("B", "B", "xb", [82.0, 39.6, 7.2, 8.4], "round"),
    zone("A", "A", "xa", [75.3, 48.3, 7.2, 8.4], "round"),
    zone("X", "X", "xx", [68.7, 39.7, 7.2, 8.4], "round"),
    // Center cluster: guide up top, view/menu inboard below it.
    zone("guide", "guide", "txt", [50.0, 27.0, 9.0, 11.0], "round"),
    zone("back", "view", "txt", [44.0, 39.0, 6.5, 8.0], "chip"),
    zone("start", "menu", "txt", [56.0, 39.0, 6.5, 8.0], "chip"),
    // Left stick: L3 hub + four ring wedges hugging it.
    zone("lthumb", "L3", "hub", [24.0, 39.7, 8.0, 10.0], "round"),
    zone("ly.max", "↑", "dir", [24.0, 31.7, 7.0, 6.0], "chip"),
    zone("ly.min", "↓", "dir", [24.0, 47.7, 7.0, 6.0], "chip"),
    zone("lx.min", "←", "dir", [17.25, 39.7, 5.5, 7.0], "chip"),
    zone("lx.max", "→", "dir", [30.75, 39.7, 5.5, 7.0], "chip"),
    // Dpad cross.
    zone("dpad.up", "↑", "dir", [36.4, 50.6, 7.0, 9.0], "chip"),
    zone("dpad.down", "↓", "dir", [36.4, 69.2, 7.0, 9.0], "chip"),
    zone("dpad.left", "←", "dir", [29.2, 59.9, 7.0, 9.0], "chip"),
    zone("dpad.right", "→", "dir", [43.6, 59.9, 7.0, 9.0], "chip"),
    // Right stick: R3 hub + ring wedges.
    zone("rthumb", "R3", "hub", [62.5, 58.4, 8.0, 10.0], "round"),
    zone("ry.max", "↑", "dir", [62.5, 50.4, 7.0, 6.0], "chip"),
    zone("ry.min", "↓", "dir", [62.5, 66.4, 7.0, 6.0], "chip"),
    zone("rx.min", "←", "dir", [55.75, 58.4, 5.5, 7.0], "chip"),
    zone("rx.max", "→", "dir", [69.25, 58.4, 5.5, 7.0], "chip"),
];

/// DualShock 4 pad (art: `pad-ds4.svg`, viewBox 112.69×72.53; anchors:
/// △(81.2,17.7) ○(88.4,28.8) ✕(81.3,39.7) □(74.0,28.7), sticks (33.8,49.8)
/// and (66.1,49.8), dpad arrows around (18.5,29.3), touchpad x 32.9..67.0 —
/// Sony labels, XInput functions). Same disjoint-rect rules as [`ZONE_XBOX`]:
/// stick wedges ring the L3/R3 hub, dpad arrow boxes sit on the drawn arrows
/// pushed slightly outward so the diagonal pairs never intersect.
pub(crate) const ZONE_DS4: &[Zone] = &[
    // Shoulders: same trigger-over-bumper stack as ZONE_XBOX, anchored on the
    // DS4 body's raised humps (stage x ≈ 19 / 81, where L1/R1 really sit).
    zone("lt", "L2", "sh", [17.0, 4.6, 9.5, 5.2], "trigger"),
    zone("lb", "L1", "sh", [19.5, 10.9, 10.5, 5.2], "bumper"),
    zone("rb", "R1", "sh", [80.5, 10.9, 10.5, 5.2], "bumper"),
    zone("rt", "R2", "sh", [83.0, 4.6, 9.5, 5.2], "trigger"),
    // Face cluster (✕○△□ mapped onto A/B/Y/X), trimmed to the Ø6.9×9.2
    // drawn circles. Sony glyph colors.
    zone("Y", "△", "pt", [81.2, 29.2, 7.0, 9.0], "round"),
    zone("B", "○", "po", [88.4, 38.8, 7.0, 9.0], "round"),
    zone("A", "✕", "pc", [81.3, 48.1, 7.0, 9.0], "round"),
    zone("X", "□", "psq", [74.0, 38.7, 7.0, 9.0], "round"),
    // Share / PS / Options.
    zone("back", "share", "txt", [30.0, 25.5, 7.0, 9.0], "chip"),
    zone("start", "options", "txt", [70.0, 25.5, 7.0, 9.0], "chip"),
    zone("guide", "PS", "txt", [50.0, 63.0, 8.0, 10.0], "round"),
    // Left stick: L3 hub + ring wedges.
    zone("lthumb", "L3", "hub", [33.8, 56.8, 8.0, 10.0], "round"),
    zone("ly.max", "↑", "dir", [33.8, 48.8, 7.0, 6.0], "chip"),
    zone("ly.min", "↓", "dir", [33.8, 64.8, 7.0, 6.0], "chip"),
    zone("lx.min", "←", "dir", [27.05, 56.8, 5.5, 7.0], "chip"),
    zone("lx.max", "→", "dir", [40.55, 56.8, 5.5, 7.0], "chip"),
    // Dpad arrows.
    zone("dpad.up", "↑", "dir", [18.5, 31.5, 5.4, 7.2], "chip"),
    zone("dpad.down", "↓", "dir", [18.5, 46.6, 5.4, 7.2], "chip"),
    zone("dpad.left", "←", "dir", [12.9, 39.2, 5.4, 7.2], "chip"),
    zone("dpad.right", "→", "dir", [23.9, 39.2, 5.4, 7.2], "chip"),
    // Right stick: R3 hub + ring wedges.
    zone("rthumb", "R3", "hub", [66.1, 56.8, 8.0, 10.0], "round"),
    zone("ry.max", "↑", "dir", [66.1, 48.8, 7.0, 6.0], "chip"),
    zone("ry.min", "↓", "dir", [66.1, 64.8, 7.0, 6.0], "chip"),
    zone("rx.min", "←", "dir", [59.35, 56.8, 5.5, 7.0], "chip"),
    zone("rx.max", "→", "dir", [72.85, 56.8, 5.5, 7.0], "chip"),
];

// ── THE DIGITAL RETRO PADS ────────────────────────────────────────────────
//
// [`ZONE_SNES`] and [`ZONE_GENESIS`] are TWELVE zones where the modern tables
// are twenty-five, and that is the whole point of them.
//
// **What is missing, and why.** No `lt`/`rt`, no `lthumb`/`rthumb`, no `guide`,
// and none of the eight stick directions. The reasoning is written out once, on
// `ABSENT_ON_A_DIGITAL_RETRO_PAD` in `snapshot.rs`; the short version is that
// each pinned retro descriptor carries exactly ONE axis pair and on both
// physical pads that pair IS the D-pad — so a key bound to `lt` or `rx.max` on
// one of these seats drives nothing at all.
//
// That matters because `zones_for` is what every authoring surface asks "which
// controls does this seat have": the binding pane's rows and free chips, the
// canvas control list, the macro grid's columns, and the readable names on the
// keyboard. A SNES pad offering a right-stick column in the macro editor is not
// a cosmetic wart — it is an editor inviting somebody to author a move that
// cannot play, and then showing it back to them as if it had.
//
// **Geometry is the Xbox art's**, because the Xbox body is the stand-in both
// retro personas draw (`PAD_PRESENTATIONS` — there is no SNES or Genesis art in
// this tree and none is invented). The rects are copied from [`ZONE_XBOX`]
// unchanged so the zones land on the drawn controls of the body actually on
// screen, and `zone_rects_are_pairwise_disjoint` covers them like any other
// table. `retro_tables_share_one_geometry` pins the two against each other, so
// the shared shape stays ONE claim about retro hardware rather than two copies
// free to drift.
//
// **Why two tables and not one plus a `legend` override.** The override list
// exists for a persona that shares another's shape and renames one or two
// controls (DualSense's Create, Switch Pro's ZL/ZR). Here almost every row's
// word differs, and the two vocabularies are certain to different degrees — so
// they are stated separately, each with its own evidence.
//
// The `idk` palette is `txt` on the faces rather than the Xbox
// `xa`/`xb`/`xx`/`xy`: painting a SNES "B" in the Xbox A green would import one
// console's color language onto another's pad.

/// The SNES pad — the words that are printed on it.
///
/// Safe to state because `ksx_core::Persona::Snes`'s own doc carries the
/// mapping this build measured: the identity is the iBuffalo Classic
/// (0583:2060) with "positional faces (ksx A = bottom = SNES B)". Anchoring the
/// diamond on that gives bottom→B, right→A, left→Y, top→X, which is the SNES
/// pad as printed; L/R/Select/Start are what is written on the shell.
pub(crate) const ZONE_SNES: &[Zone] = &[
    // L and R are DIGITAL on this pad, so they are `lb`/`rb` and there is no
    // trigger chip stacked above them.
    zone("lb", "L", "sh", [34.0, 10.9, 11.0, 5.2], "bumper"),
    zone("rb", "R", "sh", [66.0, 10.9, 11.0, 5.2], "bumper"),
    zone("Y", "X", "txt", [75.2, 31.1, 7.2, 8.4], "round"),
    zone("B", "A", "txt", [82.0, 39.6, 7.2, 8.4], "round"),
    zone("A", "B", "txt", [75.3, 48.3, 7.2, 8.4], "round"),
    zone("X", "Y", "txt", [68.7, 39.7, 7.2, 8.4], "round"),
    // No guide zone above these two: the pad has no home button.
    zone("back", "Select", "txt", [44.0, 39.0, 6.5, 8.0], "chip"),
    zone("start", "Start", "txt", [56.0, 39.0, 6.5, 8.0], "chip"),
    // The D-pad cross — the ONLY directional input this pad has, which is
    // exactly why the stick wedges are absent rather than duplicated onto it.
    zone("dpad.up", "↑", "dir", [36.4, 50.6, 7.0, 9.0], "chip"),
    zone("dpad.down", "↓", "dir", [36.4, 69.2, 7.0, 9.0], "chip"),
    zone("dpad.left", "←", "dir", [29.2, 59.9, 7.0, 9.0], "chip"),
    zone("dpad.right", "→", "dir", [43.6, 59.9, 7.0, 9.0], "chip"),
];

/// The Genesis pad — the SHAPE, in ksx's own words.
///
/// ⚠️ **The letters are deliberately not SEGA's, and that is a decision rather
/// than an oversight.** `docs/HIDMAESTRO-STATE.md` records the 2026-08-20 retro
/// leg spawning this device and says in the same row: "Button-label tables
/// remain PROVISIONAL until the joy.cpl press-check." On top of that, this ONE
/// wire identity (DaemonBite 2341:8036) serves Genesis, Mega Drive AND Saturn
/// — three different face layouts: a three-button row, a 2×3 six-button grid,
/// and Saturn's six-plus-shoulders. There is no single set of printed letters
/// this build can stand behind, so it prints none and keeps ksx's own function
/// vocabulary, which claims nothing about anybody's shell.
///
/// What it DOES claim, and can: the shape. Nine buttons and one signed axis
/// pair means no analog stick, no analog trigger, no stick click and no home
/// button — so none is offered. Give this table Sega letters in the same commit
/// as the press-check, not before.
pub(crate) const ZONE_GENESIS: &[Zone] = &[
    // "L"/"R" name a POSITION, not a console's branding — the shoulder pair
    // this descriptor's nine buttons include.
    zone("lb", "L", "sh", [34.0, 10.9, 11.0, 5.2], "bumper"),
    zone("rb", "R", "sh", [66.0, 10.9, 11.0, 5.2], "bumper"),
    zone("Y", "Y", "txt", [75.2, 31.1, 7.2, 8.4], "round"),
    zone("B", "B", "txt", [82.0, 39.6, 7.2, 8.4], "round"),
    zone("A", "A", "txt", [75.3, 48.3, 7.2, 8.4], "round"),
    zone("X", "X", "txt", [68.7, 39.7, 7.2, 8.4], "round"),
    // ksx's own names for these two, not "Select"/"Mode": a 3-button Genesis
    // pad has neither, a 6-button has Mode, a Saturn pad has neither.
    zone("back", "Back", "txt", [44.0, 39.0, 6.5, 8.0], "chip"),
    zone("start", "Start", "txt", [56.0, 39.0, 6.5, 8.0], "chip"),
    zone("dpad.up", "↑", "dir", [36.4, 50.6, 7.0, 9.0], "chip"),
    zone("dpad.down", "↓", "dir", [36.4, 69.2, 7.0, 9.0], "chip"),
    zone("dpad.left", "←", "dir", [29.2, 59.9, 7.0, 9.0], "chip"),
    zone("dpad.right", "→", "dir", [43.6, 59.9, 7.0, 9.0], "chip"),
];

/// The zone table a persona draws with — the controls THIS pad has.
///
/// Returns a SLICE, not a fixed-size array: the control vocabulary grows in
/// M11-M19 (`docs/UNIVERSAL-IO.md`), and a `[Zone; 25]` return type made every
/// caller a place the count had to be repeated. It is also no longer one count:
/// the retro personas have twelve zones where the modern ones have
/// twenty-five, and that difference is the point.
///
/// Nothing here derives from `ksx_core::preset::mappable_functions()` and
/// nothing should — a `Zone` carries persona ART (label, geometry, kind), which
/// this crate owns and ksx-core has no business knowing. The two are tied
/// together by `zone_tables_cover_every_mappable_function` instead, which is a
/// test, not a dependency: ksx-studio links ksx-core only as a dev-dependency
/// and that boundary is deliberate (`docs/M9-DECISION.md` §6).
///
/// The persona → table decision itself is NOT made here. It lives with the art,
/// the family and the legend in the one `PAD_PRESENTATIONS` record
/// (`snapshot.rs`), because deciding those four things in four places is how
/// one page came to draw the same controller as a DualShock in the pad grid and
/// an Xbox pad in the mapper.
pub(crate) fn zones_for(persona: &str) -> &'static [Zone] {
    crate::snapshot::pad_presentation(persona).zones
}

/// Every key bound to `function`, in file order. The inert "None" placeholder
/// was already filtered by the provider, so an empty list IS unbound.
///
/// v10: this — not a joined string — is the unit the mapper works in. MANY
/// KEYS → ONE CONTROL is native to the engine and to the TOML
/// (docs/INPUT-TRANSFORMS.md §1a: `A = ["S", "Enter"]`, press either), and
/// A multi-bind preset uses it; the page had been folding the list
/// into one tag and the writer had been replacing it.
pub(crate) fn keys_of(slot: &MapperSlot, function: &str) -> Vec<String> {
    slot.bindings.get(function).cloned().unwrap_or_default()
}

/// The separator between a control's keys, on both readers. A MIDDOT, never
/// `+`: `S+Enter` reads as the chord it is not (a chord is `--when`, §1b) —
/// these keys are alternatives, either one presses the control.
const KEY_SEP: &str = " · ";

/// "G", "S · Enter", or "—" for unbound — every key, for the tooltip/aria
/// text and the legend's own reading.
pub(crate) fn key_tag(slot: &MapperSlot, function: &str) -> String {
    let keys = keys_of(slot, function);
    if keys.is_empty() {
        "—".to_owned()
    } else {
        keys.join(KEY_SEP)
    }
}

/// Mirrors MapIsland.ts `sharedLabels`: for every zone (table order), the
/// LABELS of the other controls in this preset bound to the same key.
///
/// This is the whole of FEATURE 3's data model. A key bound twice is not a
/// conflict here — the engine applies both (docs/INPUT-TRANSFORMS.md §1a) — so
/// the page's job is to name what a key drives, not to complain about it.
/// Unbound controls (`—`) never "share" anything.
/// v10: two controls share when their key SETS INTERSECT — one key in common
/// is one key that drives both, whether or not either control has others. (It
/// used to compare the joined tags, which quietly stopped noticing the moment
/// a control held more than one key.)
pub(crate) fn shared_labels(slot: &MapperSlot) -> Vec<Vec<String>> {
    let zones = zones_for(&slot.persona);
    let keys: Vec<Vec<String>> = zones.iter().map(|z| keys_of(slot, z.fn_name)).collect();
    keys.iter()
        .enumerate()
        .map(|(i, mine)| {
            if mine.is_empty() {
                return Vec::new();
            }
            zones
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i && keys[*j].iter().any(|k| mine.iter().any(|m| m == k)))
                .map(|(_, z)| legend_label_for_persona(&slot.persona, z))
                .collect()
        })
        .collect()
}

/// Mirrors MapIsland.ts `legendGroup`: the stick/dpad glyph groups need a
/// prefix to stay unambiguous in a flat list ("LS ▲" vs "D-pad ▲"); every
/// other control is named by its identity alone (A vs ✕).
fn legend_group(z: &Zone) -> &'static str {
    if z.fn_name.starts_with("lx.") || z.fn_name.starts_with("ly.") {
        "LS "
    } else if z.fn_name.starts_with("rx.") || z.fn_name.starts_with("ry.") {
        "RS "
    } else if z.fn_name.starts_with("dpad.") {
        "D-pad "
    } else {
        ""
    }
}

/// Group + identity using the words printed on the requested controller.
///
/// Switch Pro intentionally reuses the Xbox hit geometry and DualSense reuses
/// the DS4 geometry, but those shared shapes do not make their shoulder and
/// system-button legends interchangeable. The small vocabulary delta lives in
/// the persona's `legend` list instead of cloning two 25-row geometry tables
/// and letting them drift.
///
/// This used to substring-match `"switchpro"`, `"ds5"` and `"ps5"` against the
/// persona and print Xbox words for anything else — which is why a SNES seat
/// was labelled with an Xbox pad's vocabulary. The override list now comes from
/// the same `PAD_PRESENTATIONS` row that chose the zone table it is overriding,
/// so a table and its words can no longer be picked by two different rules.
pub(crate) fn legend_label_for_persona(persona: &str, z: &Zone) -> String {
    let label = crate::snapshot::pad_presentation(persona)
        .legend
        .iter()
        .find(|(function, _)| *function == z.fn_name)
        .map_or(z.label, |(_, label)| *label);
    format!("{}{}", legend_group(z), label)
}

// ── v11/v12: THE MACRO EDITOR — the piano roll, and it SAVES ───────────────
// docs/INPUT-TRANSFORMS.md §6.2, adopted from TAStudio: "rows = steps,
// columns = the slot's controls, cells = held or not". That beats a form with
// an "add step" button because a timed sequence is a SHAPE — you have to see
// ↓, ↘, → as three rows with the diagonal overlapping to know you wrote a
// quarter-circle rather than three unrelated presses.
//
// v11 shipped this READ-ONLY, when §1c's "authoring the sequence itself stays
// TOML-only" was still true and the only output was a block to paste. It is
// not true any more: the daemon grew `map-macro`, which takes ONE WHOLE
// `[macros.<name>]` table ([`crate::control::ControlSource::save_macro`],
// `POST /api/macro/save`, `ksx macro`). So v12 wires the card to it — New,
// Save, Rename and Delete are real writes through that one verb — and the
// TOML block is demoted to a collapsed "copy for sharing" detail.
//
// The SAVE MODEL is explicit-Save, not save-per-edit (the rationale is in
// MapIsland.ts, where the buttons live: a macro write takes a backup and
// hot-swaps the sequence into the running session, so autosaving every painted
// cell would publish half-authored sequences and litter backups). Everything
// that WRITES is JavaScript-only, so the SSR paint below renders the same card
// in its read state — plus the honest note that says which of the two it is.
//
// Every derivation below is mirrored in MapIsland.ts (server derives the SSR
// paint, the client re-derives per edit and per poll), the established rule
// for this page.

/// The shortest step a 60 Hz poller can be relied on to see, in ms.
///
/// A MIRROR of `ksx_core::MIN_STEP_MS` (§0.2: ~16.7 ms per sample, so ~33 ms
/// is two of them). This crate depends on no other ksx crate at runtime, so
/// the number is repeated here and pinned against the real one by
/// `the_sampling_floor_matches_ksx_core`.
pub(crate) const MIN_STEP_MS: u32 = 33;

/// The same floor counted the way a FRAME author counts it: two 60 Hz samples.
/// `frames_ms(2)` is exactly [`MIN_STEP_MS`], which is the point — a warning
/// about a `frames = 1` step that answers in milliseconds is asking its reader
/// to do the conversion that got them there. Pinned in
/// `the_sampling_floor_and_frame_maths_match_ksx_core`.
pub(crate) const MIN_STEP_FRAMES: u32 = 2;

/// 60 Hz frames → ms, rounded to nearest ONCE — `ksx_core::StepDuration::ms`.
/// Rounded once so three frames is 50 ms and not 3 × 17 = 51.
pub(crate) fn frames_ms(frames: u32) -> u32 {
    // Saturating on BOTH terms: the studio now hands this unsaved
    // browser drafts on every act, so a frame count near u32::MAX must
    // clamp rather than panic the request.
    frames.saturating_mul(1000).saturating_add(30) / 60
}

/// The duration a step ASKS for, in ms. `None` when the file says both units
/// or neither — which is a fault, not a number to guess (`MacroStepFile::
/// duration`), and is reported as one.
pub(crate) fn requested_ms(step: &MacroStepView) -> Option<u32> {
    match (step.ms, step.frames) {
        (Some(ms), None) => Some(ms),
        (None, Some(frames)) => Some(frames_ms(frames)),
        _ => None,
    }
}

/// What the engine would actually hold this step for: below the floor is
/// RAISED unless the author opted out (`MacroStep::effective_ms`).
pub(crate) fn effective_ms(step: &MacroStepView) -> u32 {
    match requested_ms(step) {
        Some(ms) if step.allow_short || ms >= MIN_STEP_MS => ms,
        Some(_) => MIN_STEP_MS,
        None => 0,
    }
}

/// "50 ms" / "3 fr · 50 ms" / "—" — the row's own duration, in the unit it was
/// authored in (a sequence written in frames must still read in frames).
pub(crate) fn duration_text(step: &MacroStepView) -> String {
    match (step.ms, step.frames) {
        (Some(ms), None) => format!("{ms} ms"),
        (None, Some(frames)) => format!("{frames} fr · {} ms", frames_ms(frames)),
        _ => "—".to_owned(),
    }
}

/// Is this step below the sampling floor at all? (Both spellings, one rule.)
pub(crate) fn step_is_short(step: &MacroStepView) -> bool {
    requested_ms(step).is_some_and(|ms| ms < MIN_STEP_MS)
}

/// The number in the row's own duration box, in the unit the FILE spells this
/// step in. Mirrors MapIsland.ts's `macroRowsFor` / `unitOfStep`, with the one
/// difference the client alone can have: the client also remembers a unit the
/// AUTHOR picked for a step whose value has not been retyped yet, and an SSR
/// paint has no author to remember.
pub(crate) fn dur_value(step: &MacroStepView) -> String {
    match (step.ms, step.frames) {
        (_, Some(frames)) if step.ms.is_none() => frames.to_string(),
        (Some(ms), _) => ms.to_string(),
        // Both or neither — the row's amber flag already says so; the box
        // shows the default a new step would take rather than a blank that
        // would write nothing.
        _ => "50".to_owned(),
    }
}

/// `ms` / `fr` — the unit TOGGLE's label. A two-state button, not a `<select>`:
/// a select inside a list item cannot be given its value by an attribute
/// binding (map.ts would have to write every one of them by hand after every
/// poll), and a button's label is its own readout.
pub(crate) fn unit_tag(step: &MacroStepView) -> String {
    if step.frames.is_some() && step.ms.is_none() {
        "fr".to_owned()
    } else {
        "ms".to_owned()
    }
}

pub(crate) fn unit_title(step: &MacroStepView, i: usize) -> String {
    if unit_tag(step) == "fr" {
        format!(
            "step {} is authored in FRAMES — click to switch it to ms (the length is converted, \
             never reinterpreted)",
            i + 1
        )
    } else {
        format!(
            "step {} is authored in MILLISECONDS — click to switch it to frames (the length is \
             converted, never reinterpreted; ksx counts frames at 60 Hz)",
            i + 1
        )
    }
}

/// The INLINE amber flag — short enough to always fit on the row beside the
/// duration, because a truncated warning is a warning nobody reads. The rule
/// it is short for is stated once, in full, in the card's own note; the whole
/// sentence rides the row's `title` ([`step_warning_long`]).
pub(crate) fn step_warning(step: &MacroStepView) -> String {
    match (step.ms, step.frames) {
        (Some(_), Some(_)) => "two units".to_owned(),
        (None, None) => "no duration".to_owned(),
        _ => {
            if !step_is_short(step) {
                return String::new();
            }
            // IN THE AUTHOR'S OWN UNIT. A `frames = 1` step used to be told
            // "16 ms — raised to 33 ms", which is a true sentence about a
            // number the author never typed: it hands them the conversion
            // instead of the answer.
            if let Some(f) = step.frames {
                return if step.allow_short {
                    format!("{f} fr — may be missed")
                } else {
                    format!("{f} fr — raised to {MIN_STEP_FRAMES} fr")
                };
            }
            let ms = step.ms.unwrap_or(0);
            if step.allow_short {
                format!("{ms} ms — may be missed")
            } else {
                format!("{ms} ms — raised to {MIN_STEP_MS} ms")
            }
        }
    }
}

/// The same flag, in full — never a silent acceptance and never a silent
/// rewrite (§1c "the sampling rule, enforced": both outcomes are advisories,
/// and neither is ever quiet). Empty = nothing to say.
pub(crate) fn step_warning_long(step: &MacroStepView) -> String {
    match (step.ms, step.frames) {
        (Some(_), Some(_)) => {
            "uses both milliseconds and frames — choose exactly one timing method".to_owned()
        }
        (None, None) => {
            "no duration — give it ms or frames (a step with none is refused)".to_owned()
        }
        _ => {
            if !step_is_short(step) {
                return String::new();
            }
            if let Some(f) = step.frames {
                let plural = if f == 1 { "" } else { "s" };
                let each = format!(
                    "{f} frame{plural} is shorter than the reliable {MIN_STEP_FRAMES}-frame \
                     minimum ({MIN_STEP_MS} ms — the game needs enough time to notice it)"
                );
                return if step.allow_short {
                    format!(
                        "{each} — Allow short is on, so it runs as written and the game may \
                         never see it"
                    )
                } else {
                    format!(
                        "{each} — the game may never see it, so ksx raises this step to \
                         {MIN_STEP_FRAMES} frames ({MIN_STEP_MS} ms)"
                    )
                };
            }
            let ms = step.ms.unwrap_or(0);
            if step.allow_short {
                format!(
                    "{ms} ms is shorter than the reliable {MIN_STEP_MS} ms minimum — Allow short \
                     is on, so it runs as written and the game may never see it"
                )
            } else {
                format!(
                    "{ms} ms is shorter than the reliable {MIN_STEP_MS} ms minimum — the game may \
                     never see it, so ksx raises this step to {MIN_STEP_MS} ms"
                )
            }
        }
    }
}

/// The sampling rule, stated ONCE, where the amber rows can point at it (§0.2).
/// The per-row flag is short so it always fits; this is what it means.
pub(crate) const MACRO_RULE_LINE: &str =
    "Amber steps are shorter than the reliable minimum — 33 ms, or 2 frames if you are counting \
     frames. A 1-frame step may be invisible to the game. ksx raises a short step to 33 ms so it lands; a step \
     marked Allow short runs exactly as written and can be missed entirely. Neither is ever \
     silent, and Save asks before it writes either one.";

/// THE RING, stated once, under the grid: what the eight columns of a direction
/// group are, what each is called, and — for the four that are picks rather than
/// stored names — exactly what ksx writes when you tick one.
///
/// The numpad digits live HERE and in the tooltips, never in the glyph row: a
/// second line of digits under only 24 of 37 columns makes the header ragged,
/// and the digit is a lookup key (for somebody who read "3" on Dustloop or typed
/// digits into MAME's `joystick_map`), not a label.
pub(crate) const MACRO_RING_LINE: &str =
    "Each direction group runs ↑ ↖ ← ↙ ↓ ↘ → ↗ (numpad 8 7 4 1 2 3 6 9), so a motion is a \
     SHAPE: a quarter-circle forward is a staircase, a half-circle a straight line, a dragon \
     punch a hook. The four diagonals are picks, not new bindings — ticking ↘ (down-right, \
     numpad 3; a move list spells it d/f, which is only down-FORWARD while you face right) \
     combines down and right in one step. THERE ARE THREE OF THESE GROUPS — D-PAD, \
     LEFT STICK and RIGHT STICK — and the grid scrolls sideways to reach them, so the one you \
     want may be off the edge; the band above the arrows names whichever you are looking at. \
     Use the same group as this controller layout so the game reads the motion. Each row spells \
     the direction pair beside its name.";

// ── v12: the frame arithmetic, on screen ───────────────────────────────────
// The UX requirement asks directly: "a 60fps frame is only like sixteenth
// milliseconds? maybe we can show that math." So the duration editor prints
// the conversion live, with the sampling floor in the SAME units — which is
// what makes an amber row explain itself instead of citing a rule.
//
// The target rate is DISPLAY-ONLY. Authoring against a game's real rate is
// useful (59.94, 57, 55 are all common on a cabinet), but there is nowhere to
// put one: the preset file's step is hold / ms / frames / allow_short, the
// `map-macro` body ([`crate::control::MacroWrite`]) carries exactly those, and
// `ksx_core::StepDuration::Frames` counts frames at 60 Hz full stop. A field
// the daemon would drop is the silent no-op this page bans — so the selector
// converts for the author and SAYS that `frames = N` still runs at 60 Hz.
// The rate lives client-side; SSR paints the 60 Hz line.

/// Percent-encode a macro name for the tab's href. Names come from a file and
/// are otherwise unconstrained, so this is not optional.
pub(crate) fn urlencode_value(text: &str) -> String {
    let mut out = String::new();
    let mut utf8 = [0u8; 4];
    for c in text.chars() {
        for byte in c.encode_utf8(&mut utf8).bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(byte as char);
                }
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
    }
    out
}

/// How one PRESENTED control is named on this pad.
///
/// A coalesced diagonal (the hat+stick double-binding every in-box template
/// writes) joins its mechanisms with **"and"**, never with `+`. `+` is this
/// row's separator for ANOTHER CONTROL — "D-pad ↘ + A" is two things held at
/// once — so `"D-pad + LS ↘"` read as a control called "D-pad" and a control
/// called "LS ↘", which is two lies in four words: the D-pad is pointing ↘ too,
/// and there is only one control here. It also collided with [`hold_cls`]'s
/// `· together` tail, which that row does not get (it folds to ONE presented
/// control) — so the row holding the MOST bindings looked like the row holding
/// two. "D-pad and LS ↘" is one control, said on two mechanisms, and "and" is
/// the joiner [`macro_motion_line`] already uses for exactly this list.
fn held_label(persona: &str, zones: &[Zone], hold: &[String], held: &Held) -> String {
    match held {
        Held::Diagonal {
            diag, mechanisms, ..
        } => format!(
            "{}{}",
            mechanisms
                .iter()
                .map(|m| m.group().trim_end())
                .collect::<Vec<_>>()
                .join(" and "),
            format_args!(" {}", diag.glyph()),
        ),
        Held::Plain { member } => {
            let f = &hold[*member];
            zones
                .iter()
                .find(|z| z.fn_name.eq_ignore_ascii_case(f))
                .map_or_else(|| f.clone(), |z| legend_label_for_persona(persona, z))
        }
    }
}

/// What one step holds, named the way this pad names it: "D-pad ↘ + A".
///
/// The row readout is where the model is TAUGHT. A diagonal reads as one
/// control — because that is what the player picked and what the player means —
/// and [`hold_expand`] says, beside it, exactly which two names the file
/// carries. Nothing is hidden and nothing has to be decoded from lit cells
/// twelve columns apart.
pub(crate) fn hold_text(slot: Option<&MapperSlot>, hold: &[String]) -> String {
    hold_text_for_persona(slot.map_or("xbox360", |s| s.persona.as_str()), hold)
}

/// What one macro step holds, using an explicit persona even when the mapper
/// projection itself is unavailable. Macro tables can still be readable when
/// one malformed direct binding prevents `MapperSlot` conversion; falling back
/// to Xbox labels in that case would repaint PlayStation/Switch authoring as a
/// different controller.
pub(crate) fn hold_text_for_persona(persona: &str, hold: &[String]) -> String {
    if hold.is_empty() {
        return "(nothing — neutral gap)".to_owned();
    }
    let zones = zones_for(persona);
    fold(hold)
        .iter()
        .map(|h| held_label(persona, zones, hold, h))
        .collect::<Vec<_>>()
        .join(" + ")
}

/// THE LEDGER LINE: every diagonal in this step, spelled as the pair the file
/// actually stores — `↘ = dpad.down + dpad.right`.
///
/// This is what keeps the lens honest. The presentation says "one control"; the
/// storage says "two holds"; this line says both at once, on the row itself, so
/// nobody has to open the TOML to find out what a pick wrote. Empty when the
/// step holds no diagonal.
pub(crate) fn hold_expand(hold: &[String]) -> String {
    fold(hold)
        .iter()
        .filter_map(|h| match h {
            Held::Diagonal { diag, members, .. } => Some(format!(
                "{} = {}",
                diag.glyph(),
                members
                    .iter()
                    .map(|&i| hold[i].as_str())
                    .collect::<Vec<_>>()
                    .join(" + ")
            )),
            Held::Plain { .. } => None,
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Row hover copy with an explicit persona, for editors that can still read a
/// macro after direct mapper conversion has failed.
pub(crate) fn row_title_for_persona(persona: &str, step: &MacroStepView, i: usize) -> String {
    let base = format!(
        "step {} holds {} for {} (the engine runs it for {} ms)",
        i + 1,
        hold_text_for_persona(persona, &step.hold),
        duration_text(step),
        effective_ms(step)
    );
    let expand = hold_expand(&step.hold);
    if expand.is_empty() {
        base
    } else {
        format!("{base} — {expand}")
    }
}

pub(crate) fn hold_expand_cls(hold: &[String]) -> &'static str {
    if hold_expand(hold).is_empty() {
        "macexp off"
    } else {
        "macexp"
    }
}

/// The hold readout's own class, over PRESENTED controls rather than stored
/// ones: a diagonal is one control, so `↓ + →` no longer reads as two.
/// The accent is for a row that really does hold several things at once.
pub(crate) fn hold_cls(hold: &[String]) -> &'static str {
    match fold(hold).len() {
        0 => "machold none",
        1 => "machold",
        _ => "machold both",
    }
}

/// Every column's state for ONE step, in column order, with the "written, but
/// not at full deflection" flag beside it.
///
/// THE DIAGONAL LENS LIVES HERE, once. The redesign editor draws its grid from
/// this answer, because the rule that folds `ly.min + lx.max`
/// into a single `↘` — and still ticks the two cardinals underneath it — is the
/// one piece of this editor that must never have two versions to disagree.
pub(crate) fn step_cell_states(
    step: &MacroStepView,
    columns: &[MacroColumn],
) -> Vec<(CellState, bool)> {
    let view = fold(&step.hold);
    // Which diagonal (if any) each held entry was folded into, and which
    // (mechanism, diagonal) pairs are lit.
    let mut member_of: Vec<Option<Diag>> = vec![None; step.hold.len()];
    let mut lit: Vec<(Mechanism, Diag, bool)> = Vec::new();
    for held in &view {
        if let Held::Diagonal {
            diag,
            mechanisms,
            members,
            exact,
        } = held
        {
            for &m in members {
                member_of[m] = Some(*diag);
            }
            for &mechanism in mechanisms {
                lit.push((mechanism, *diag, *exact));
            }
        }
    }
    columns
        .iter()
        .map(|column| {
            let state = match parse_diag_token(&column.token) {
                Some((mechanism, diag)) => lit
                    .iter()
                    .find(|(m, d, _)| *m == mechanism && *d == diag)
                    .map_or(CellState::Off, |_| CellState::On),
                // A direction column matches by WHERE IT POINTS, not by
                // spelling: `ly.-16384` is the down half of this pad's left
                // stick however the file spells it.
                None => match pointing(&column.token) {
                    Some(want) => step
                        .hold
                        .iter()
                        .position(|f| points_same_way(f, want))
                        .map_or(CellState::Off, |at| match member_of[at] {
                            Some(diag) => CellState::Part(diag),
                            None => CellState::On,
                        }),
                    None => {
                        if step
                            .hold
                            .iter()
                            .any(|f| f.eq_ignore_ascii_case(&column.token))
                        {
                            CellState::On
                        } else {
                            CellState::Off
                        }
                    }
                },
            };
            let approx = matches!(state, CellState::On)
                && lit
                    .iter()
                    .any(|(m, d, exact)| !exact && diag_token(*m, *d) == column.token);
            (state, approx)
        })
        .collect()
}

/// What one column says about one step.
pub(crate) enum CellState {
    /// Not held.
    Off,
    /// Held, and this column is the whole of it.
    On,
    /// Held as HALF of a folded diagonal. The diagonal's own cell carries the
    /// filled mark; this one carries a subordinate tick, because pretending the
    /// cardinal is not in the file would be the lens lying about the storage.
    Part(Diag),
}

/// Does `function` point the same way as `want`, whatever it is spelled?
///
/// `exact` is deliberately NOT compared: `ly.-16384` is the down half of the
/// left stick just as `ly.min` is, and a grid that only lit the canonical
/// spelling would leave a hand-written step looking unheld. Mirrored in
/// MapIsland.ts `pointsSameWay`.
pub(crate) fn points_same_way(function: &str, want: Pointing) -> bool {
    pointing(function).is_some_and(|p| {
        p.mechanism == want.mechanism && p.vertical == want.vertical && p.positive == want.positive
    })
}

/// `diag:<mech>:<diag>` back into its two halves, or `None` for a function name.
pub(crate) fn parse_diag_token(token: &str) -> Option<(Mechanism, Diag)> {
    let rest = token.strip_prefix("diag:")?;
    let (mech, diag) = rest.split_once(':')?;
    let mechanism = Mechanism::ALL.into_iter().find(|m| m.token() == mech)?;
    let diag = Diag::ALL.into_iter().find(|d| d.token() == diag)?;
    Some((mechanism, diag))
}

/// What a column is called in a sentence — "D-pad ↘ (down-right)", "LS ↓",
/// "✕ (A)".
pub(crate) fn column_name(persona: &str, zones: &[Zone], column: &MacroColumn) -> String {
    match parse_diag_token(&column.token) {
        Some((mechanism, diag)) => {
            format!("{}{} ({})", mechanism.group(), diag.glyph(), diag.words())
        }
        None => match Mechanism::of(&column.token) {
            Some(mechanism) => format!("{}{} ({})", mechanism.group(), column.glyph, column.token),
            None => zones
                .iter()
                .find(|z| z.fn_name.eq_ignore_ascii_case(&column.token))
                .map_or_else(
                    || column.token.clone(),
                    |z| format!("{} ({})", legend_label_for_persona(persona, z), z.fn_name),
                ),
        },
    }
}

/// TOML string escaping — macro names and key names come from a file.
fn toml_str(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The macro as TOML — v12's "advanced / copy for sharing" detail, and the
/// hand-editing path for a page with no JavaScript. Not the save any more:
/// that is the card's own Save button, through the `map-macro` verb.
///
/// Emitted exactly as `ksx_config::MacroFile` spells it — defaults omitted (a
/// macro-free-looking file stays macro-free-looking), the duration in the unit
/// it was authored in, and the trigger row underneath so the macro arrives with
/// the key that starts it. When there is no trigger yet the row is COMMENTED
/// OUT rather than filled with a placeholder, because a pasted
/// `macro.x = "<KEY>"` would not load.
pub(crate) fn macro_toml(mac: &MacroView) -> String {
    let mut out = format!("[macros.{}]\n", mac.name);
    if mac.on_release != "finish" {
        out.push_str(&format!("on_release = {}\n", toml_str(&mac.on_release)));
    }
    if mac.retrigger != "ignore" {
        out.push_str(&format!("retrigger = {}\n", toml_str(&mac.retrigger)));
    }
    if mac.interrupt != "none" {
        out.push_str(&format!("interrupt = {}\n", toml_str(&mac.interrupt)));
    }
    if !mac.repeat.is_empty() && mac.repeat != "once" {
        out.push_str(&format!("repeat = {}\n", toml_str(&mac.repeat)));
    }
    // Two spellings of one number, so exactly ONE is emitted — a block giving
    // both is refused by the loader, and pasting one back must never be how a
    // reader finds that out.
    if let Some(hz) = mac.turbo_hz {
        out.push_str(&format!("turbo_hz = {hz}\n"));
    } else if let Some(ms) = mac.gap_ms {
        out.push_str(&format!("gap_ms = {ms}\n"));
    }
    out.push_str("steps = [\n");
    for step in &mac.steps {
        let hold = step
            .hold
            .iter()
            .map(|f| toml_str(f))
            .collect::<Vec<_>>()
            .join(", ");
        let duration = match (step.ms, step.frames) {
            (Some(ms), None) => format!("ms = {ms}"),
            (None, Some(frames)) => format!("frames = {frames}"),
            (Some(ms), Some(frames)) => format!("ms = {ms}, frames = {frames}"),
            (None, None) => "ms = ".to_owned(),
        };
        out.push_str(&format!("  {{ hold = [{hold}], {duration}"));
        if step.allow_short {
            out.push_str(", allow_short = true");
        }
        out.push_str(" },\n");
    }
    out.push_str("]\n\n[bindings]\n");
    match mac.triggers.as_slice() {
        [] => out.push_str(&format!(
            "# macro.{} = \"<KEY>\"   # no trigger yet — bind one above, or with the line below\n",
            mac.name
        )),
        [one] => out.push_str(&format!("macro.{} = {}\n", mac.name, toml_str(one))),
        many => out.push_str(&format!(
            "macro.{} = [{}]\n",
            mac.name,
            many.iter()
                .map(|k| toml_str(k))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
    out
}

/// Which keys start this macro, in words.
pub(crate) fn macro_trigger_line(mac: Option<&MacroView>) -> String {
    let Some(mac) = mac else {
        return String::new();
    };
    match mac.triggers.as_slice() {
        [] => "no trigger key yet — nothing starts this macro".to_owned(),
        [one] => format!("started by {one}"),
        many => format!(
            "started by {} — any one of them ({} keys)",
            many.join(KEY_SEP),
            many.len()
        ),
    }
}

// ── FIX 1c: COMMON MOTIONS — which mechanism they write, and why ───────────
// The quarter-circle is where both traps bite at once: its middle step is the
// diagonal (one row, two controls), and a pad has THREE ways to say "right".
// ksx publishes exactly what a step names, so a motion written in dpad holds
// on a preset whose player keys drive the left stick is published faithfully
// and read by nobody — `Issue::MacroHoldsOtherMechanism` in
// ksx-config/src/validate.rs, an advisory that only arrives AFTER a save.
// Generating from the slot's OWN bound direction keys means it never fires.
//
// The buttons themselves are client-only (they edit a draft), but this
// sentence is SSR'd like everything else on the card: a no-JS reader is told
// which mechanism their preset drives, which is the fact, not the affordance.

/// Which control a preset's direction keys drive. Mirror of
/// `ksx_core::socd::DirMechanism` (= `ksx_config::validate::Mechanism`, which
/// is now a re-export of it). Pinned by `the_diagonal_lens_matches_ksx_core`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mechanism {
    Dpad,
    LeftStick,
    RightStick,
}

impl Mechanism {
    /// Canonical order — the order a coalesced diagonal lists its mechanisms in
    /// and the order the grid draws its direction groups in.
    pub(crate) const ALL: [Mechanism; 3] =
        [Mechanism::Dpad, Mechanism::LeftStick, Mechanism::RightStick];

    pub(crate) fn of(function: &str) -> Option<Self> {
        let f = function.to_ascii_lowercase();
        if f.starts_with("dpad.") {
            Some(Mechanism::Dpad)
        } else if f.starts_with("lx.") || f.starts_with("ly.") {
            Some(Mechanism::LeftStick)
        } else if f.starts_with("rx.") || f.starts_with("ry.") {
            Some(Mechanism::RightStick)
        } else {
            None
        }
    }

    pub(crate) const fn describe(self) -> &'static str {
        match self {
            Mechanism::Dpad => "the dpad",
            Mechanism::LeftStick => "the left stick (lx/ly)",
            Mechanism::RightStick => "the right stick (rx/ry)",
        }
    }

    /// The prefix a flat list needs to keep three identical arrow runs apart —
    /// the same one [`legend_group`] writes.
    pub(crate) const fn group(self) -> &'static str {
        match self {
            Mechanism::Dpad => "D-pad ",
            Mechanism::LeftStick => "LS ",
            Mechanism::RightStick => "RS ",
        }
    }

    /// The grid's group-band label.
    const fn band(self) -> &'static str {
        match self {
            Mechanism::Dpad => "D-PAD",
            Mechanism::LeftStick => "LEFT STICK",
            Mechanism::RightStick => "RIGHT STICK",
        }
    }

    /// The half of a diagonal cell token that names the mechanism.
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Mechanism::Dpad => "dpad",
            Mechanism::LeftStick => "ls",
            Mechanism::RightStick => "rs",
        }
    }

    /// The canonical function name for one polarity of one axis of this
    /// mechanism — what picking a direction WRITES.
    pub(crate) const fn function(self, vertical: bool, positive: bool) -> &'static str {
        match (self, vertical, positive) {
            (Mechanism::Dpad, true, true) => "dpad.up",
            (Mechanism::Dpad, true, false) => "dpad.down",
            (Mechanism::Dpad, false, false) => "dpad.left",
            (Mechanism::Dpad, false, true) => "dpad.right",
            (Mechanism::LeftStick, true, true) => "ly.max",
            (Mechanism::LeftStick, true, false) => "ly.min",
            (Mechanism::LeftStick, false, false) => "lx.min",
            (Mechanism::LeftStick, false, true) => "lx.max",
            (Mechanism::RightStick, true, true) => "ry.max",
            (Mechanism::RightStick, true, false) => "ry.min",
            (Mechanism::RightStick, false, false) => "rx.min",
            (Mechanism::RightStick, false, true) => "rx.max",
        }
    }
}

// ── DIAGONALS AS PRESENTATION ─────────────────────────────────────────────
// Requirement: "if down and right together equals diagonal, the user does not care —
// we can present the diagonal in the piano and the user can select it, and
// behind the scenes we do down and right, so it's seamless."
//
// He is right, and it is the root cause of the evening he lost. A diagonal IS
// two simultaneous holds — that is ksx's implementation detail, not the user's
// concept. Players think in ↘ / down-forward / numpad 3, never in "two axis
// bindings held together", and no mapper in the field lets them pick one
// (Steam Input: four cardinal binding slots; reWASD's own answer: build a
// Shortcut out of two zones; MAME: four cardinals; GP2040-CE: cardinal pairs).
//
// NOTHING STORED CHANGES. A step still holds a set of ordinary bindings, so
// files stay hand-editable, the engine is untouched, and old presets keep
// working. This is the lens: `fold` reads a hold and says how to PRESENT it;
// what a pick writes is the pair, spelled exactly as `ksx map` would.
//
// MIRROR of `ksx_core::diagonal` + `ksx_core::socd::pointing`, over FUNCTION
// NAMES rather than `Binding` (ksx-studio links no ksx crate at runtime — the
// established pattern, same as the zone tables). `the_diagonal_lens_matches_
// ksx_core` pins the two against each other through the TEST-ONLY dev-deps.

/// The four diagonals — ↖ ↗ ↙ ↘, numpad 7 9 1 3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Diag {
    UpLeft,
    UpRight,
    DownLeft,
    DownRight,
}

impl Diag {
    pub(crate) const ALL: [Diag; 4] =
        [Diag::UpLeft, Diag::UpRight, Diag::DownLeft, Diag::DownRight];

    /// ARROW is the glyph. Screens speak arrows in this genre — SF6's input
    /// history, every Capcom move list, every arcade instruction card.
    pub(crate) const fn glyph(self) -> &'static str {
        match self {
            Diag::UpLeft => "↖",
            Diag::UpRight => "↗",
            Diag::DownLeft => "↙",
            Diag::DownRight => "↘",
        }
    }

    /// The numpad digit — a LOOKUP TOKEN for the tooltip and the rule line,
    /// never the label. It is how the input is written in text (Dustloop,
    /// SuperCombo) and it is already in a cab owner's `mame.ini`
    /// (`-joystick_map` uses the numpad mapping).
    pub(crate) const fn numpad(self) -> u8 {
        match self {
            Diag::UpLeft => 7,
            Diag::UpRight => 9,
            Diag::DownLeft => 1,
            Diag::DownRight => 3,
        }
    }

    /// The name, in words. COMPASS, not forward/back — ksx offers the mirrored
    /// spelling of every motion because player 2 is not an edge case, and
    /// "down-forward" is only true for a character facing right.
    pub(crate) const fn words(self) -> &'static str {
        match self {
            Diag::UpLeft => "up-left",
            Diag::UpRight => "up-right",
            Diag::DownLeft => "down-left",
            Diag::DownRight => "down-right",
        }
    }

    /// How a move list writes it (Tekken's official command lists spell `d/f`).
    /// Offered BESIDE the compass name, never instead of it.
    const fn move_list(self) -> &'static str {
        match self {
            Diag::UpLeft => "u/b",
            Diag::UpRight => "u/f",
            Diag::DownLeft => "d/b",
            Diag::DownRight => "d/f",
        }
    }

    /// `(up, right)`.
    pub(crate) const fn halves(self) -> (bool, bool) {
        match self {
            Diag::UpLeft => (true, false),
            Diag::UpRight => (true, true),
            Diag::DownLeft => (false, false),
            Diag::DownRight => (false, true),
        }
    }

    const fn from_halves(up: bool, right: bool) -> Diag {
        match (up, right) {
            (true, false) => Diag::UpLeft,
            (true, true) => Diag::UpRight,
            (false, false) => Diag::DownLeft,
            (false, true) => Diag::DownRight,
        }
    }

    pub(crate) const fn token(self) -> &'static str {
        match self {
            Diag::UpLeft => "ul",
            Diag::UpRight => "ur",
            Diag::DownLeft => "dl",
            Diag::DownRight => "dr",
        }
    }
}

/// The glyph for one cardinal polarity. ARROWS, the same family the diagonals
/// wear — a diagonal that does not look like the same family as its two parents
/// defeats the whole lens, and `◤◥◣◢` are corner *blocks*, not directions.
const fn cardinal_glyph(vertical: bool, positive: bool) -> &'static str {
    match (vertical, positive) {
        (true, true) => "↑",
        (true, false) => "↓",
        (false, false) => "←",
        (false, true) => "→",
    }
}

const fn cardinal_words(vertical: bool, positive: bool) -> &'static str {
    match (vertical, positive) {
        (true, true) => "up",
        (true, false) => "down",
        (false, false) => "left",
        (false, true) => "right",
    }
}

const fn cardinal_numpad(vertical: bool, positive: bool) -> u8 {
    match (vertical, positive) {
        (true, true) => 8,
        (true, false) => 2,
        (false, false) => 4,
        (false, true) => 6,
    }
}

/// Mirror of `ksx_core::socd::Pointing`, over a FUNCTION NAME.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Pointing {
    pub(crate) mechanism: Mechanism,
    pub(crate) vertical: bool,
    /// Right for a horizontal control, UP for a vertical one.
    pub(crate) positive: bool,
    /// Is this the canonical extreme (`min`/`max`), or a hand-written partial
    /// deflection like `ly.-16384`?
    pub(crate) exact: bool,
}

/// Where this function name points, or `None` when it points nowhere.
///
/// A CENTRED AXIS IS NEVER A DIRECTION (`lx.0`) — the same rule
/// `ksx_core::socd::pointing` and `ksx_config::validate` state, which is why it
/// is never half of a diagonal either.
pub(crate) fn pointing(function: &str) -> Option<Pointing> {
    let lower = function.to_ascii_lowercase();
    let (base, rest) = lower.split_once('.')?;
    match base {
        "dpad" => {
            let (vertical, positive) = match rest {
                "up" => (true, true),
                "down" => (true, false),
                "left" => (false, false),
                "right" => (false, true),
                _ => return None,
            };
            Some(Pointing {
                mechanism: Mechanism::Dpad,
                vertical,
                positive,
                exact: true,
            })
        }
        "lx" | "ly" | "rx" | "ry" => {
            // `min`/`max`/`<i16>` — the same grammar `ksx_config::parse_function`
            // takes, including its `i16::MIN` fold.
            let value: i32 = match rest {
                "min" => -32767,
                "max" => 32767,
                custom => {
                    let raw: i32 = custom.parse::<i16>().ok()?.into();
                    if raw == -32768 {
                        -32767
                    } else {
                        raw
                    }
                }
            };
            if value == 0 {
                return None;
            }
            let (mechanism, vertical) = match base {
                "lx" => (Mechanism::LeftStick, false),
                "ly" => (Mechanism::LeftStick, true),
                "rx" => (Mechanism::RightStick, false),
                _ => (Mechanism::RightStick, true),
            };
            Some(Pointing {
                mechanism,
                vertical,
                positive: value > 0,
                exact: value == -32767 || value == 32767,
            })
        }
        _ => None,
    }
}

/// One PRESENTED control. Mirror of `ksx_core::diagonal::Held`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Held {
    /// `members` are INDICES into the original hold — the round trip is "put
    /// those strings back", so a hand-written `ly.-16384 + lx.max` displays as
    /// the diagonal and is stored byte for byte as it was written.
    Diagonal {
        diag: Diag,
        mechanisms: Vec<Mechanism>,
        members: Vec<usize>,
        exact: bool,
    },
    Plain {
        member: usize,
    },
}

/// How to PRESENT this hold.
///
/// **Per mechanism bucket, "contains both" — never exact-set-equality on the
/// whole step.** `down + forward + A` is the single most common macro step in
/// existence (the attack that ends a motion) and it folds: `A` is a passenger.
/// `down + forward + up` never folds — which diagonal would it be, and what the
/// pad publishes depends on the slot's `socd` policy, resolved at plan time,
/// which this page cannot see.
pub(crate) fn fold(hold: &[String]) -> Vec<Held> {
    let parsed: Vec<Option<Pointing>> = hold.iter().map(|f| pointing(f)).collect();
    let mut folded: Vec<(Diag, Mechanism, Vec<usize>, bool)> = Vec::new();
    let mut consumed = vec![false; hold.len()];

    for mechanism in Mechanism::ALL {
        let members: Vec<usize> = parsed
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.filter(|p| p.mechanism == mechanism).map(|_| i))
            .collect();
        if members.is_empty() {
            continue;
        }
        // POLARITIES are counted, not bindings: a hold naming `dpad.down`
        // twice is still one V−.
        let mut vertical: Option<bool> = None;
        let mut horizontal: Option<bool> = None;
        let mut split = false;
        let mut exact = true;
        for &i in &members {
            let p = parsed[i].expect("filtered above");
            exact &= p.exact;
            let slot = if p.vertical {
                &mut vertical
            } else {
                &mut horizontal
            };
            match slot {
                Some(seen) if *seen != p.positive => split = true,
                Some(_) => {}
                None => *slot = Some(p.positive),
            }
        }
        let (Some(up), Some(right)) = (vertical, horizontal) else {
            continue;
        };
        if split {
            continue;
        }
        for &i in &members {
            consumed[i] = true;
        }
        folded.push((Diag::from_halves(up, right), mechanism, members, exact));
    }

    // Coalesce: buckets that folded to the SAME diagonal are ONE presented
    // control. That is the hat+stick double-binding every in-box template
    // writes — one key on `dpad.down` AND `ly.min`.
    let mut out: Vec<Held> = Vec::new();
    for diag in Diag::ALL {
        let hits: Vec<&(Diag, Mechanism, Vec<usize>, bool)> =
            folded.iter().filter(|(d, ..)| *d == diag).collect();
        if hits.is_empty() {
            continue;
        }
        let mut members: Vec<usize> = hits.iter().flat_map(|(_, _, m, _)| m.clone()).collect();
        members.sort_unstable();
        out.push(Held::Diagonal {
            diag,
            mechanisms: hits.iter().map(|(_, m, _, _)| *m).collect(),
            members,
            exact: hits.iter().all(|(_, _, _, e)| *e),
        });
    }
    for (i, taken) in consumed.iter().enumerate() {
        if !taken {
            out.push(Held::Plain { member: i });
        }
    }
    out
}

/// The cell token for a diagonal column. Contains a `:`, which no function name
/// ever does, so a diagonal pick can never be mistaken for one — the client
/// EXPANDS it to the pair before anything is stored.
pub(crate) fn diag_token(mechanism: Mechanism, diag: Diag) -> String {
    format!("diag:{}:{}", mechanism.token(), diag.token())
}

/// One position on the direction ring.
#[derive(Clone, Copy)]
enum RingPos {
    Cardinal { vertical: bool, positive: bool },
    Diagonal(Diag),
}

/// **↑ ↖ ← ↙ ↓ ↘ → ↗** — numpad 8 7 4 1 2 3 6 9: walk the gate from up,
/// counter-clockwise, around the bottom, back to up.
///
/// Why this order and not numpad-ascending or compass-clockwise: MOTIONS BECOME
/// SHAPES. A piano roll is read as a picture, and this is the only ordering
/// where the picture *is* the motion — a quarter-circle forward is a staircase
/// sweeping right, a half-circle is a straight 45° line, a dragon punch is
/// visibly a hook. Cardinals land on the even indices so each diagonal sits
/// literally between its two parents and the block still reads as a compass.
const RING: [RingPos; 8] = [
    RingPos::Cardinal {
        vertical: true,
        positive: true,
    },
    RingPos::Diagonal(Diag::UpLeft),
    RingPos::Cardinal {
        vertical: false,
        positive: false,
    },
    RingPos::Diagonal(Diag::DownLeft),
    RingPos::Cardinal {
        vertical: true,
        positive: false,
    },
    RingPos::Diagonal(Diag::DownRight),
    RingPos::Cardinal {
        vertical: false,
        positive: true,
    },
    RingPos::Diagonal(Diag::UpRight),
];

/// One grid column: what it is called, what a click on it means, and which
/// band it sits under.
pub(crate) struct MacroColumn {
    /// The cell token — a function name, or `diag:<mech>:<diag>`.
    pub(crate) token: String,
    pub(crate) glyph: String,
    /// `maccolid`, plus `card` / `diag` for the two direction kinds.
    pub(crate) idcls: &'static str,
    pub(crate) title: String,
    pub(crate) band: &'static str,
}

/// Which band a control sits under. The band is not decoration — it fixes a
/// PRE-EXISTING defect: the header used to carry three identical `▲ ▼ ◀ ▶`
/// runs disambiguated only by a tooltip.
fn band_of(fn_name: &str) -> &'static str {
    match fn_name {
        "lt" | "lb" | "rb" | "rt" => "SHOULDERS",
        "A" | "B" | "X" | "Y" => "FACE",
        "guide" | "back" | "start" => "SYSTEM",
        "lthumb" => Mechanism::LeftStick.band(),
        "rthumb" => Mechanism::RightStick.band(),
        other => Mechanism::of(other).map_or("SYSTEM", Mechanism::band),
    }
}

/// The grid's columns for one persona: every non-direction control as itself,
/// and every direction MECHANISM as its eight-position ring.
///
/// 25 zones → 37 columns. The twelve cardinal-only direction zones become three
/// rings of eight, so the four diagonals are things you can point at instead of
/// things you have to know how to build.
pub(crate) fn macro_columns(persona: &str) -> Vec<MacroColumn> {
    let mut out: Vec<MacroColumn> = Vec::new();
    let mut rung: Vec<Mechanism> = Vec::new();
    for z in zones_for(persona).iter() {
        let Some(mechanism) = Mechanism::of(z.fn_name) else {
            let label = legend_label_for_persona(persona, z);
            out.push(MacroColumn {
                token: z.fn_name.to_owned(),
                glyph: label.clone(),
                idcls: "maccolid",
                title: format!("{label} ({})", z.fn_name),
                band: band_of(z.fn_name),
            });
            continue;
        };
        // The mechanism's whole ring is emitted at its FIRST direction zone;
        // the other three zones of that mechanism are already in it.
        if rung.contains(&mechanism) {
            continue;
        }
        rung.push(mechanism);
        for pos in RING {
            out.push(match pos {
                RingPos::Cardinal { vertical, positive } => {
                    let function = mechanism.function(vertical, positive);
                    MacroColumn {
                        token: function.to_owned(),
                        glyph: cardinal_glyph(vertical, positive).to_owned(),
                        idcls: "maccolid card",
                        title: format!(
                            "{}{} · {} · numpad {} · holds {function}",
                            mechanism.group(),
                            cardinal_glyph(vertical, positive),
                            cardinal_words(vertical, positive),
                            cardinal_numpad(vertical, positive),
                        ),
                        band: mechanism.band(),
                    }
                }
                RingPos::Diagonal(diag) => MacroColumn {
                    token: diag_token(mechanism, diag),
                    glyph: diag.glyph().to_owned(),
                    idcls: "maccolid diag",
                    // `move_list` is FACING-RELATIVE and is labelled as such.
                    // ksx has no notion of facing — it publishes a direction,
                    // not a side of the screen — and it already ships the
                    // mirrored spelling of every motion because player 2 is
                    // not an edge case. Printing a bare "d/f" beside a compass
                    // name reads as a second name for the same fact; it is a
                    // second name for the fact HALF THE TIME, and is d/b for
                    // the player standing on the right.
                    title: format!(
                        "{}{} · {} · numpad {} · {} in a move list, facing right · one pick, and \
                         ksx writes {} + {}",
                        mechanism.group(),
                        diag.glyph(),
                        diag.words(),
                        diag.numpad(),
                        diag.move_list(),
                        mechanism.function(true, diag.halves().0),
                        mechanism.function(false, diag.halves().1),
                    ),
                    band: mechanism.band(),
                },
            });
        }
    }
    out
}

/// Every mechanism THIS SLOT's own bound direction keys drive. An inert `None`
/// row does not count: a placeholder is a function the preset lists, not a
/// direction the player can produce (same rule as `driven_mechanisms` there).
pub(crate) fn driven_mechanisms(slot: Option<&MapperSlot>) -> Vec<Mechanism> {
    let mut out: Vec<Mechanism> = Vec::new();
    let Some(slot) = slot else {
        return out;
    };
    for (function, keys) in &slot.bindings {
        if keys
            .iter()
            .all(|k| k.is_empty() || k.eq_ignore_ascii_case("None"))
        {
            continue;
        }
        if let Some(m) = Mechanism::of(function) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}

/// The sentence above the motion buttons: which mechanism they will write, and
/// why that is the one.
pub(crate) fn macro_motion_line(slot: Option<&MapperSlot>) -> String {
    let driven = driven_mechanisms(slot);
    let pick = driven.first().copied().unwrap_or(Mechanism::Dpad);
    let tail = "Each one appends its steps to the macro below — the MIDDLE step of a \
                quarter-circle is the diagonal, and a 360 is four of them. You can tick any of \
                them yourself in that group's ↖ ↗ ↙ ↘ columns.";
    match driven.len() {
        0 => format!(
            "These write {} — this controller layout has no direction keys of its own, so there is \
             nothing to match. If the game reads a stick, retick the rows. {tail}",
            pick.describe()
        ),
        1 => format!(
            "These write {} — the same mechanism this controller layout's direction keys drive, so \
             the game reads them. (A motion written on the other mechanism is published \
             faithfully and read by nobody: that is the trap.) {tail}",
            pick.describe()
        ),
        _ => format!(
            "These write {}. This controller layout's direction keys drive {}, so either would be \
             read — a pad has three ways to say \"right\" and a game reads whichever one it \
             was written for. {tail}",
            pick.describe(),
            driven
                .iter()
                .map(|m| m.describe())
                .collect::<Vec<_>>()
                .join(" and ")
        ),
    }
}

/// The three policies, as the file holds them right now — the READABLE half of
/// the three selects beside them (those are draft controls and are hidden
/// without JavaScript, this line never is).
pub(crate) fn macro_policy_line(mac: Option<&MacroView>) -> String {
    match mac {
        Some(mac) => {
            let release = if mac.on_release == "abort" {
                "stop when released"
            } else {
                "finish after release"
            };
            let retrigger = if mac.retrigger == "restart" {
                "restart if pressed again"
            } else {
                "ignore extra presses"
            };
            let interrupt = match mac.interrupt.as_str() {
                "any-input" => "other input stops it",
                "opposing" => "opposite input stops it",
                _ => "other input does not stop it",
            };
            let repeat = match mac.repeat.as_str() {
                "turbo" => "auto-repeat with a gap",
                "while-held" => "repeat immediately while held",
                _ => "once per press",
            };
            let rate = match (mac.turbo_hz, mac.gap_ms) {
                (Some(hz), _) => format!(" ({hz} Hz)"),
                (None, Some(ms)) => format!(" ({ms} ms gap)"),
                (None, None) => String::new(),
            };
            format!("{release} · {retrigger} · {interrupt} · {repeat}{rate}")
        }
        None => String::new(),
    }
}

/// The macro's whole run at the durations the engine will really use.
pub(crate) fn macro_total_ms(mac: &MacroView) -> u32 {
    mac.steps
        .iter()
        .map(effective_ms)
        .fold(0u32, u32::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Serialize;
    use std::path::PathBuf;

    /// The committed Rust-to-TypeScript handoff. Struct field order is output
    /// order under serde, so the pretty JSON is deterministic without relying
    /// on map-key ordering.
    #[derive(Serialize)]
    struct ZoneTokens<'a> {
        version: u8,
        functions: Vec<String>,
        xbox: Vec<ZoneToken<'a>>,
        ds4: Vec<ZoneToken<'a>>,
    }

    fn zone_token(zone: &Zone) -> ZoneToken<'_> {
        ZoneToken {
            function: zone.fn_name,
            label: zone.label,
            palette: zone.idk,
            rect: [zone.cx, zone.cy, zone.w, zone.h],
            kind: zone.kind,
        }
    }

    #[derive(Serialize)]
    struct ZoneToken<'a> {
        function: &'a str,
        label: &'a str,
        palette: &'a str,
        rect: [f32; 4],
        kind: &'a str,
    }

    /// The no-JS picker had a deliberate human order before generation. Known
    /// controls keep it by TYPE, not by their serialized spelling; anything a
    /// future roster adds falls through and is appended canonically without an
    /// array edit here.
    fn function_picker_rank(binding: ksx_core::Binding) -> u8 {
        use ksx_core::{Axis, Binding, DpadDirection, Trigger, XButton, AXIS_MAX, AXIS_MIN};

        match binding {
            Binding::Button(XButton::A) => 0,
            Binding::Button(XButton::B) => 1,
            Binding::Button(XButton::X) => 2,
            Binding::Button(XButton::Y) => 3,
            Binding::Button(XButton::LeftBumper) => 4,
            Binding::Button(XButton::RightBumper) => 5,
            Binding::Trigger(Trigger::Left) => 6,
            Binding::Trigger(Trigger::Right) => 7,
            Binding::Button(XButton::Back) => 8,
            Binding::Button(XButton::Start) => 9,
            Binding::Button(XButton::Guide) => 10,
            Binding::Button(XButton::LeftThumb) => 11,
            Binding::Button(XButton::RightThumb) => 12,
            Binding::Dpad(DpadDirection::Up) => 13,
            Binding::Dpad(DpadDirection::Down) => 14,
            Binding::Dpad(DpadDirection::Left) => 15,
            Binding::Dpad(DpadDirection::Right) => 16,
            Binding::Axis {
                axis: Axis::X,
                value: AXIS_MIN,
            } => 17,
            Binding::Axis {
                axis: Axis::X,
                value: AXIS_MAX,
            } => 18,
            Binding::Axis {
                axis: Axis::Y,
                value: AXIS_MIN,
            } => 19,
            Binding::Axis {
                axis: Axis::Y,
                value: AXIS_MAX,
            } => 20,
            Binding::Axis {
                axis: Axis::Rx,
                value: AXIS_MIN,
            } => 21,
            Binding::Axis {
                axis: Axis::Rx,
                value: AXIS_MAX,
            } => 22,
            Binding::Axis {
                axis: Axis::Ry,
                value: AXIS_MIN,
            } => 23,
            Binding::Axis {
                axis: Axis::Ry,
                value: AXIS_MAX,
            } => 24,
            _ => u8::MAX,
        }
    }

    // The Rust -> Node zone handoff. This is NOT ordinary test code:
    // tools/studio-env/build-assets.ps1 runs it as an --ignored test to
    // regenerate studio-ui/tokens/zones.json before Node consumes it, so
    // one locked command cannot bless a stale zones.json against newer
    // Rust tables. Deleting it silently breaks every asset build.

    fn zone_tokens_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../studio-ui/tokens/zones.json")
    }

    fn generated_zone_tokens_json() -> String {
        let mut functions: Vec<(ksx_core::Binding, String)> =
            ksx_core::preset::mappable_functions()
                .iter()
                .copied()
                .map(|binding| (binding, ksx_config::function_name(&binding)))
                .collect();
        functions.sort_by(|(left, left_name), (right, right_name)| {
            function_picker_rank(*left)
                .cmp(&function_picker_rank(*right))
                .then_with(|| left_name.cmp(right_name))
        });

        let tokens = ZoneTokens {
            version: 1,
            functions: functions.into_iter().map(|(_, name)| name).collect(),
            xbox: ZONE_XBOX.iter().map(zone_token).collect(),
            ds4: ZONE_DS4.iter().map(zone_token).collect(),
        };
        let mut json = serde_json::to_string_pretty(&tokens).expect("zone tokens serialize");
        json.push('\n');
        json
    }

    /// **The sampling floor really is `ksx_core::MIN_STEP_MS`.**
    ///
    /// ADDED 2026-08-26. Cited by name on `MIN_STEP_MS` above ("the number is
    /// repeated here and pinned against the real one by
    /// `the_sampling_floor_matches_ksx_core`") and absent from the tree. The
    /// mirror happens to be right today — both are 33 — which is exactly why
    /// nobody noticed the pin was missing.
    ///
    /// ksx-studio links no ksx crate at RUNTIME on purpose
    /// (`docs/M9-DECISION.md` §6), so the constant is duplicated rather than
    /// imported. That is a fine trade only while a test closes the loop
    /// through the dev-dependency; without one, a change to the engine's floor
    /// leaves this page quietly warning about the wrong number.
    #[test]
    fn the_sampling_floor_matches_ksx_core() {
        assert_eq!(
            MIN_STEP_MS,
            ksx_core::MIN_STEP_MS,
            "the mapper's sampling floor has drifted from the engine's"
        );
    }

    /// **...and the frame arithmetic agrees with it.**
    ///
    /// ADDED 2026-08-26, the second phantom citation on this pair
    /// (`the_sampling_floor_and_frame_maths_match_ksx_core`, cited on
    /// `MIN_STEP_FRAMES`, never defined). `frames_ms(MIN_STEP_FRAMES)` must be
    /// `MIN_STEP_MS` — a warning that says "at least 2 frames" and a warning
    /// that says "at least 33 ms" have to be the same warning, or one of them
    /// sends the reader to do a conversion that will not come out.
    #[test]
    fn the_sampling_floor_and_frame_maths_match_ksx_core() {
        assert_eq!(frames_ms(MIN_STEP_FRAMES), MIN_STEP_MS);
        assert_eq!(frames_ms(MIN_STEP_FRAMES), ksx_core::MIN_STEP_MS);
        // Rounded ONCE, which is the whole reason `frames_ms` exists: three
        // frames is 50 ms, not 3 x 17 = 51.
        assert_eq!(frames_ms(3), 50);
        // A frame count near the ceiling clamps rather than panicking a
        // request — the studio hands this unsaved browser drafts.
        assert_eq!(frames_ms(u32::MAX), frames_ms(u32::MAX));
    }

    /// **The diagonal lens is the engine's, spelled in function names.**
    ///
    /// ADDED 2026-08-26. `the_diagonal_lens_matches_ksx_core` is cited twice
    /// in this file — on `Mechanism` and on the `Diag` block — and existed
    /// nowhere. One citation is even split across a line break
    /// (`the_diagonal_lens_matches_\n// ksx_core`), which is how it survived
    /// earlier greps for the name.
    ///
    /// `Mechanism` mirrors `ksx_core::socd::DirMechanism` over FUNCTION NAMES
    /// rather than `Binding`, because this crate links ksx-core only as a
    /// dev-dependency. This is that dev-dependency doing its job.
    #[test]
    fn the_diagonal_lens_matches_ksx_core() {
        // Same variants, same canonical order — the order a coalesced
        // diagonal lists its mechanisms in, and the order the grid draws.
        assert_eq!(
            Mechanism::ALL.len(),
            ksx_core::socd::DirMechanism::ALL.len()
        );
        for (mine, theirs) in Mechanism::ALL
            .iter()
            .zip(ksx_core::socd::DirMechanism::ALL.iter())
        {
            assert_eq!(
                mine.describe(),
                theirs.describe(),
                "the mapper and the engine name this mechanism differently — \
                 the wording is contractual, it appears in \
                 `Issue::MacroHoldsOtherMechanism`"
            );
        }

        // ...and the name-based classifier agrees with the engine's
        // binding-based one on every mappable function. This is the half a
        // variant-only comparison would miss: `Mechanism::of` reads a string
        // prefix, and a renamed function silently classifies as `None`.
        for binding in ksx_core::preset::mappable_functions().iter().copied() {
            let name = ksx_config::function_name(&binding);
            let mine = Mechanism::of(&name).map(Mechanism::describe);
            let theirs = ksx_core::socd::DirMechanism::of(binding)
                .map(ksx_core::socd::DirMechanism::describe);
            assert_eq!(
                mine, theirs,
                "{name:?}: the mapper says {mine:?} and the engine says \
                 {theirs:?} — a direction key that classifies differently on \
                 the two sides drives the wrong control"
            );
        }
    }

    /// **Every persona's zone table accounts for every mappable function,
    /// exactly once, as either DRAWN or explicitly ABSENT.**
    ///
    /// ADDED 2026-08-26. This test is cited by name in two places — the
    /// `zones_for` doc above ("The two are tied together by
    /// `zone_tables_cover_every_mappable_function` instead, which is a test,
    /// not a dependency") and `studio-ui/art/README.md` — and it did not
    /// exist. A comment promising a guard that does not run is worse than no
    /// comment: the invariant read as covered for months while nothing checked
    /// it.
    ///
    /// `generated_zone_tokens_json_is_current` cannot stand in for it. That
    /// gate regenerates BOTH halves — `functions` and the two zone tables —
    /// from the SAME run and compares the result to the committed file, so
    /// adding a mappable function to ksx-core makes `functions` 26, leaves the
    /// zone tables at 25, and the gate goes green the moment somebody runs
    /// `build-assets.ps1`. The drift it catches is "the file is stale", never
    /// "the two vocabularies disagree".
    ///
    /// **Why `absent` exists rather than a plain "every table is total" rule.**
    /// SNES and Genesis are digital pads: no analog stick, no analog trigger,
    /// no stick click, no home button. Their tables are TWELVE zones, not
    /// twenty-five, and a rule demanding twenty-five would force the mapper to
    /// offer a right-stick column on a pad that has no right stick. So each
    /// persona names the functions its device does not have, and this test
    /// proves `drawn` and `absent` PARTITION the vocabulary. Adding a function
    /// to ksx-core then fails here — loudly, per persona — instead of appearing
    /// in the picker with no control behind it on some pads and no mention at
    /// all on others.
    ///
    /// The user-visible failures this forbids, in both directions: a control
    /// they can bind in TOML that no surface offers, and a control offered on a
    /// pad that cannot express it.
    #[test]
    fn zone_tables_cover_every_mappable_function() {
        use std::collections::BTreeSet;

        let mappable: BTreeSet<String> = ksx_core::preset::mappable_functions()
            .iter()
            .map(ksx_config::function_name)
            .collect();
        assert!(
            !mappable.is_empty(),
            "ksx_core::preset::mappable_functions() is empty — the oracle is gone"
        );

        // Every row of the ONE table, plus the named unknown outcome — which
        // has to satisfy the same rule, because it is the presentation a
        // newer daemon's persona actually gets.
        let rows = crate::snapshot::PAD_PRESENTATIONS
            .iter()
            .chain(std::iter::once(&crate::snapshot::UNKNOWN_PRESENTATION));

        for row in rows {
            let persona = if row.persona.is_empty() {
                "<unknown>"
            } else {
                row.persona
            };
            let drawn: BTreeSet<String> = row.zones.iter().map(|z| z.fn_name.to_owned()).collect();
            let absent: BTreeSet<String> = row.absent.iter().map(|f| (*f).to_owned()).collect();

            assert_eq!(
                drawn.len(),
                row.zones.len(),
                "the {persona} zone table draws the same function twice — two \
                 hit zones for one control means one of them is unreachable"
            );
            assert_eq!(
                absent.len(),
                row.absent.len(),
                "{persona} names the same absent function twice"
            );

            let both: Vec<&String> = drawn.intersection(&absent).collect();
            assert!(
                both.is_empty(),
                "{persona} both draws and disclaims {both:?} — the pad cannot \
                 have a control and not have it"
            );

            let mut accounted = drawn.clone();
            accounted.extend(absent.iter().cloned());

            let missing: Vec<&String> = mappable.difference(&accounted).collect();
            assert!(
                missing.is_empty(),
                "{persona} says nothing about {missing:?} — either draw a zone \
                 for it or add it to that persona's `absent` list with the \
                 reason. Silence here is how a bindable control ends up with \
                 no control on the pad and no explanation anywhere."
            );

            let extra: Vec<&String> = accounted.difference(&mappable).collect();
            assert!(
                extra.is_empty(),
                "{persona} names {extra:?}, which ksx-core does not list as \
                 mappable — the zone or the absent entry is either misspelled \
                 or bindable to nothing"
            );
        }
    }

    /// **No two hit zones on one pad overlap.**
    ///
    /// ADDED 2026-08-26, the second phantom citation on the zone tables: the
    /// [`ZONE_XBOX`] doc says "Rects are pairwise DISJOINT (pinned by …)" and
    /// named `zone_tables_cover_every_mappable_function`, which checked only
    /// function NAMES and never looked at a rectangle. Nothing in the tree had
    /// ever compared two rects.
    ///
    /// What an overlap costs: the zones are absolutely positioned buttons in
    /// table order, so an overlap means the later one wins the pointer and a
    /// click aimed at the covered control silently binds the covering one.
    /// That is unfindable by inspection — the art underneath still shows the
    /// button you aimed at.
    ///
    /// **A shared EDGE is legal and intended.** Both tables ring each stick's
    /// L3/R3 hub with four wedges that butt directly against it ("adjacent,
    /// never covering it"), so this refuses shared AREA, not contact. The
    /// tolerance is not cosmetic: the DS4 wedges are authored as `33.8 ± 4.0`
    /// against `27.05 ± 2.75`, whose edges meet at 29.8 in decimal and differ
    /// by 3.5e-15 in binary floating point. A strict `>` comparison reports
    /// those two pairs as overlapping by three femto-percent of the stage.
    #[test]
    fn zone_rects_are_pairwise_disjoint() {
        // One hundred-thousandth of a stage percent: far below any pixel on
        // any display, and eleven orders of magnitude above the f32/f64 dust
        // that exact adjacency produces.
        const TOUCHING: f32 = 1e-5;

        let rows = crate::snapshot::PAD_PRESENTATIONS
            .iter()
            .chain(std::iter::once(&crate::snapshot::UNKNOWN_PRESENTATION));

        for row in rows {
            let persona = if row.persona.is_empty() {
                "<unknown>"
            } else {
                row.persona
            };
            for (i, a) in row.zones.iter().enumerate() {
                for b in row.zones.iter().skip(i + 1) {
                    let overlap = |ac: f32, as_: f32, bc: f32, bs: f32| {
                        (ac + as_ / 2.0).min(bc + bs / 2.0) - (ac - as_ / 2.0).max(bc - bs / 2.0)
                    };
                    let x = overlap(a.cx, a.w, b.cx, b.w);
                    let y = overlap(a.cy, a.h, b.cy, b.h);
                    assert!(
                        x <= TOUCHING || y <= TOUCHING,
                        "{persona}: the {} and {} zones overlap by {x:.3}×{y:.3} \
                         stage percent. The later one in the table covers the \
                         earlier, so a click aimed at {} binds {} instead.",
                        a.fn_name,
                        b.fn_name,
                        a.fn_name,
                        b.fn_name
                    );
                }
            }
        }
    }

    /// The broken version hand-copied three TypeScript arrays. This gate makes
    /// any vocabulary, spelling or art-table change fail until the one
    /// committed handoff is explicitly regenerated.
    ///
    /// Lost when `/map` was deleted and restored here: `crates/ksx-app/tests/
    /// docs.rs` pins its remediation sentence, so the contract verifier is what
    /// noticed it was gone.
    #[test]
    fn generated_zone_tokens_json_is_current() {
        let path = zone_tokens_path();
        let actual = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "could not read generated zone tokens at {}: {error}; run tools/studio-env/build-assets.ps1",
                path.display()
            )
        });
        assert_eq!(
            actual,
            generated_zone_tokens_json(),
            "generated zone tokens are stale; run tools/studio-env/build-assets.ps1"
        );
    }

    /// Explicit source-tree writer for the committed language-boundary file.
    /// Ignored so an ordinary test run can only VERIFY generated source, never
    /// modify the checkout underneath a concurrent Studio build.
    #[test]
    #[ignore = "writes studio-ui/tokens/zones.json"]
    fn write_generated_zone_tokens_json() {
        let path = zone_tokens_path();
        std::fs::write(&path, generated_zone_tokens_json())
            .unwrap_or_else(|error| panic!("could not write {}: {error}", path.display()));
    }
}
