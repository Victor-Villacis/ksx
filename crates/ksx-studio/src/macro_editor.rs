//! The Nocturne macro editor's served data — the piano roll, its policies and
//! its motion writer, composed once in Rust for the /nocturne dialog.
//!
//! **Why this is not a second implementation.** Everything subtle here is
//! borrowed from [`crate::render_map`]: the 37-column ring
//! ([`macro_columns`](crate::render_map::macro_columns)), the diagonal lens
//! ([`step_cell_states`](crate::render_map::step_cell_states)), the sampling
//! floor and every duration word. This module only *dresses* those answers in
//! the Nocturne class vocabulary. When `/map` goes at M5 the derivations move
//! with the surviving module and nothing about the macro model changes.
//!
//! **What is new here, and why.** `/map` draws all 37 columns and leaves you
//! to find the lit ones. The band header now carries a COUNT of the holds
//! living under it, so a six-step macro tells you where its content is before
//! you scan a single column — the same "show the shape, then say how many"
//! rule the board's crowded keys follow.

use serde::{Deserialize, Serialize};

use ksx_api::{MacroView, MapperSlot};

use crate::render_map::{
    column_name, dur_value, duration_text, hold_cls, hold_expand, hold_expand_cls, hold_text,
    macro_columns, macro_motion_line, macro_policy_line, macro_toml, macro_total_ms,
    macro_trigger_line, row_title, step_cell_states, step_is_short, step_warning,
    step_warning_long, unit_tag, unit_title, zones_for, CellState,
};

/// One column of the roll: the glyph in its header, and what it means.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacCol {
    pub id: String,
    pub cls: String,
    pub title: String,
}

/// One band above the glyph row — the group's NAME, and how many holds this
/// macro puts under it. A header that only carried `↑ ↖ ← ↙ ↓ ↘ → ↗` three
/// times over would be three identical runs told apart by a tooltip.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacGroup {
    pub label: String,
    pub count: String,
    pub cls: String,
    pub count_cls: String,
}

/// One step: its number, what it holds in words, its time, and its verbs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacRow {
    pub n: String,
    pub cls: String,
    /// What the row holds, as ONE sentence — reading the roll must never mean
    /// decoding which of 37 columns are lit.
    pub hold: String,
    pub hold_cls: String,
    /// …and the two names the FILE carries for each folded diagonal. The lens
    /// is honest only when the storage is visible without opening the TOML.
    pub exp: String,
    pub exp_cls: String,
    pub dur: String,
    pub dur_val: String,
    pub dur_row: String,
    pub dur_cls: String,
    pub dur_title: String,
    pub unit: String,
    pub unit_act: String,
    pub unit_title: String,
    pub warn: String,
    pub warn_cls: String,
    pub warn_title: String,
    /// Is this step under the sampling floor? `warn` is ALSO non-empty
    /// for a step that names two units or none, and those are faults,
    /// not short steps — so the consent gate needs its own answer.
    pub short: bool,
    pub up_cls: String,
    pub dn_cls: String,
    pub up_act: String,
    pub dn_act: String,
    pub ia_act: String,
    pub ib_act: String,
    pub del_act: String,
    pub del_title: String,
}

/// One cell of the matrix: step × column, flat in row-major order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacCell {
    pub cls: String,
    pub cell: String,
    pub mark: String,
    pub title: String,
    /// `"true"` / `"false"` — held or not, for a reader who cannot see the
    /// fill. A mark alone tells a screen reader nothing.
    pub on: String,
    /// ONE cell of the whole matrix is in the tab order (`"0"`), the rest are
    /// `"-1"` and reached with the arrow keys. Thirty-seven columns times N
    /// steps is not a tab sequence anyone can use, and with scripting off it
    /// was 111 stops that could not do anything at all.
    pub tab: String,
}

/// One policy option, as a pill that says what choosing it does.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacPol {
    /// `<policy>|<value>` — what the click writes.
    pub act: String,
    pub label: String,
    pub title: String,
    pub cls: String,
    /// The group's own heading, carried on the FIRST option of each group so
    /// one flat list can draw four labelled groups (a list body has no inner
    /// list seam).
    pub head: String,
    pub head_cls: String,
    /// The consequence sentence, likewise carried once per group.
    pub note: String,
    pub note_cls: String,
}

/// One motion the writer can append: the shape a player already knows, and
/// its name beside it. Never a bare glyph — a mark nothing labels is a mark
/// you have to guess at.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacMotion {
    pub act: String,
    pub shape: String,
    pub label: String,
    pub title: String,
}

/// Everything the /nocturne macro dialog paints.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroEditor {
    /// Is a macro open? Drives the dialog's own class, never a `createShow` —
    /// the roll is SSR markup so a reader with no scripting can still read a
    /// sequence they cannot edit.
    pub open: bool,
    pub back_cls: String,
    pub name: String,
    pub slot: String,
    /// The worksheet the table is written into — `save_macro`'s own
    /// identity for it.
    pub preset: String,
    /// The table ITSELF, so the browser has something to edit and post
    /// back. Payload data only — it mints no slot, exactly like the pad
    /// grid's rows.
    pub table: Option<MacroView>,
    /// "6 steps · 320 ms" — the shape of the sequence before its detail.
    pub head: String,
    pub trigger: String,
    pub note: String,
    pub grid_cls: String,
    pub close_href: String,
    /// Until the roll can be EDITED here, the Controls editor stays one
    /// click away: a migration must never take a capability with it.
    pub map_href: String,
    pub cols: Vec<NocturneMacCol>,
    pub groups: Vec<NocturneMacGroup>,
    pub rows: Vec<NocturneMacRow>,
    pub cells: Vec<NocturneMacCell>,
    pub pols: Vec<NocturneMacPol>,
    pub motions: Vec<NocturneMacMotion>,
    pub motion_line: String,
    pub policy_line: String,
    pub ring: String,
    pub rule: String,
    pub toml: String,
    pub turbo_cls: String,
    pub turbo_val: String,
    /// What the rate box is asking for. A table spells its auto-fire
    /// EITHER as cycles a second or as the neutral gap between runs,
    /// and the daemon deliberately does not convert one into the other
    /// — so the caption follows the number rather than assuming.
    pub turbo_label: String,
    pub turbo_max: String,
}

/// The eight motions the writer appends, each as a shape AND a name.
const MOTIONS: [(&str, &str, &str, &str); 8] = [
    (
        "qcf",
        "↓ ↘ →",
        "¼ forward",
        "Quarter-circle forward — three steps, the middle one the diagonal",
    ),
    (
        "qcb",
        "↓ ↙ ←",
        "¼ back",
        "Quarter-circle back — three steps, the middle one the diagonal",
    ),
    (
        "hcf",
        "← ↙ ↓ ↘ →",
        "½ forward",
        "Half-circle forward — five steps across the bottom of the ring",
    ),
    (
        "hcb",
        "→ ↘ ↓ ↙ ←",
        "½ back",
        "Half-circle back — five steps across the bottom of the ring",
    ),
    (
        "dpf",
        "→ ↓ ↘",
        "dragon forward",
        "Dragon-punch forward — the tap, the down, and the diagonal",
    ),
    (
        "dpb",
        "← ↓ ↙",
        "dragon back",
        "Dragon-punch back — the tap, the down, and the diagonal",
    ),
    (
        "spdf",
        "→ ↘ ↓ ↙ ← ↖ ↑ ↗",
        "360 forward",
        "A full turn forward — all eight positions of the ring",
    ),
    (
        "spdb",
        "← ↙ ↓ ↘ → ↗ ↑ ↖",
        "360 back",
        "A full turn back — all eight positions of the ring",
    ),
];

/// One policy: its wire key, its heading, the sentence under it, and every
/// value it can take with the words that go on the pill.
struct Policy {
    key: &'static str,
    head: &'static str,
    note: &'static str,
    options: &'static [(&'static str, &'static str)],
}

/// The four policies, each option carrying what choosing it does.
const POLICIES: [Policy; 4] = [
    Policy {
        key: "on_release",
        head: "When the trigger is released",
        note: "Finishing lets the run reach its last step — tap the button and the quarter-circle \
         comes out whole. Stopping ends it at once and releases every held control.",
        options: &[
            ("finish", "Finish the sequence"),
            ("abort", "Stop immediately"),
        ],
    },
    Policy {
        key: "retrigger",
        head: "When pressed again",
        note: "Keeping the current run is the safer choice for a panel switch that may bounce; \
         restarting begins the sequence again from step 1.",
        options: &[
            ("ignore", "Keep the current run"),
            ("restart", "Restart from the beginning"),
        ],
    },
    Policy {
        key: "interrupt",
        head: "When another control is pressed",
        note: "Either other controls leave the sequence alone, or any input stops it, or only an \
         opposite direction or another macro trigger does.",
        options: &[
            ("none", "Keep running"),
            ("any-input", "Stop on any input"),
            ("opposing", "Stop on opposite input"),
        ],
    },
    Policy {
        key: "repeat",
        head: "After the sequence ends",
        note: "Run once for a normal move, repeat immediately for a continuous motion, or repeat \
         with a short neutral gap so the game sees separate auto-fire presses.",
        options: &[
            ("once", "Run once per press"),
            ("while-held", "Repeat immediately while held"),
            ("turbo", "Repeat with an auto-fire gap"),
        ],
    },
];

/// Which band a column's title belongs to, spelled the way the binding pane
/// spells its own six groups — one vocabulary for the whole product.
fn band_label(band: &str) -> &'static str {
    match band {
        "FACE" => "Face buttons",
        "SHOULDERS" => "Shoulders & triggers",
        "D-PAD" => "D-pad",
        "LEFT STICK" => "Left stick",
        "RIGHT STICK" => "Right stick",
        _ => "System",
    }
}

impl NocturneMacroEditor {
    /// Nothing open: the dialog's markup still exists, wearing its closed
    /// class, so opening it is a class flip rather than a build.
    pub fn closed() -> Self {
        Self {
            back_cls: "nd-back none".to_owned(),
            grid_cls: "n-macroll empty".to_owned(),
            close_href: "/nocturne".to_owned(),
            map_href: String::new(),
            turbo_cls: "n-macrate none".to_owned(),
            ..Default::default()
        }
    }

    /// The whole editor for one macro on one staged controller.
    pub fn compose(
        mac: &MacroView,
        slot: Option<&MapperSlot>,
        number: u8,
        q: Option<&str>,
    ) -> Self {
        let persona = slot.map_or("xbox360", |s| s.persona.as_str());
        let columns = macro_columns(persona);
        let zones = zones_for(persona);

        // ── The header row of glyphs, and the bands above them ──────────────
        let cols: Vec<NocturneMacCol> = columns
            .iter()
            .map(|column| NocturneMacCol {
                id: column.glyph.clone(),
                cls: if column.idcls.ends_with("diag") {
                    "n-maccol diag".to_owned()
                } else if column.idcls.ends_with("card") {
                    "n-maccol cardinal".to_owned()
                } else {
                    "n-maccol".to_owned()
                },
                title: column.title.clone(),
            })
            .collect();

        // How many holds live under each band. THE COUNT IS THE POINT: with
        // 37 columns, "where is this macro's content" must be answerable
        // without reading a single cell.
        let mut cells: Vec<NocturneMacCell> = Vec::with_capacity(mac.steps.len() * columns.len());
        let mut band_holds: Vec<(String, usize)> = Vec::new();
        for (i, step) in mac.steps.iter().enumerate() {
            for (column, (state, approx)) in columns.iter().zip(step_cell_states(step, &columns)) {
                let mut cls = String::from("n-maccell");
                match state {
                    CellState::On => cls.push_str(" on"),
                    CellState::Part(_) => cls.push_str(" part"),
                    CellState::Off => {}
                }
                if approx {
                    cls.push_str(" approx");
                }
                if column.idcls.ends_with("diag") {
                    cls.push_str(" isdiag");
                }
                if matches!(state, CellState::On) {
                    let at = band_holds.iter().position(|(b, _)| b == column.band);
                    match at {
                        Some(at) => band_holds[at].1 += 1,
                        None => band_holds.push((column.band.to_owned(), 1)),
                    }
                }
                let name = column_name(zones, column);
                let title = match &state {
                    CellState::On if approx => format!(
                        "step {} holds {name} — as written, not at full deflection ({})",
                        i + 1,
                        step.hold.join(" + ")
                    ),
                    CellState::On => format!("step {} holds {name}", i + 1),
                    CellState::Part(diag) => format!(
                        "step {} holds {name} as half of {} — the {} column beside it is the pick",
                        i + 1,
                        diag.glyph(),
                        diag.glyph()
                    ),
                    CellState::Off => format!("step {} does not hold {name}", i + 1),
                };
                let first = cells.is_empty();
                cells.push(NocturneMacCell {
                    cls,
                    cell: format!("{i}|{}", column.token),
                    on: matches!(state, CellState::On).to_string(),
                    tab: if first { "0" } else { "-1" }.to_owned(),
                    mark: match state {
                        CellState::On => "●".to_owned(),
                        CellState::Part(_) => "·".to_owned(),
                        CellState::Off => String::new(),
                    },
                    title,
                });
            }
        }

        // The band band: one span per run of columns sharing a band.
        let mut groups: Vec<NocturneMacGroup> = Vec::new();
        let mut run: Option<(&str, usize)> = None;
        let flush = |band: &str, span: usize, out: &mut Vec<NocturneMacGroup>| {
            let held = band_holds
                .iter()
                .find(|(b, _)| b == band)
                .map_or(0, |(_, n)| *n);
            out.push(NocturneMacGroup {
                label: band_label(band).to_owned(),
                count: if held == 0 {
                    String::new()
                } else {
                    held.to_string()
                },
                cls: format!("n-macgrp g{span}"),
                count_cls: if held == 0 {
                    "n-macgrp-n none".to_owned()
                } else {
                    "n-macgrp-n".to_owned()
                },
            });
        };
        for column in &columns {
            match run {
                Some((band, span)) if band == column.band => run = Some((band, span + 1)),
                Some((band, span)) => {
                    flush(band, span, &mut groups);
                    run = Some((column.band, 1));
                }
                None => run = Some((column.band, 1)),
            }
        }
        if let Some((band, span)) = run {
            flush(band, span, &mut groups);
        }

        // ── The step rows ───────────────────────────────────────────────────
        let last = mac.steps.len().saturating_sub(1);
        let only = mac.steps.len() == 1;
        let rows: Vec<NocturneMacRow> = mac
            .steps
            .iter()
            .enumerate()
            .map(|(i, step)| {
                let warn = step_warning(step);
                NocturneMacRow {
                    n: (i + 1).to_string(),
                    cls: if warn.is_empty() {
                        "n-macrow".to_owned()
                    } else {
                        "n-macrow short".to_owned()
                    },
                    hold: hold_text(slot, &step.hold),
                    hold_cls: format!(
                        "n-machold{}",
                        hold_cls(&step.hold).trim_start_matches("machold")
                    ),
                    exp: hold_expand(&step.hold),
                    exp_cls: if hold_expand_cls(&step.hold).ends_with("off") {
                        "n-macexp none".to_owned()
                    } else {
                        "n-macexp".to_owned()
                    },
                    dur: duration_text(step),
                    dur_val: dur_value(step),
                    dur_row: i.to_string(),
                    dur_cls: if step_is_short(step) {
                        "n-macdur short".to_owned()
                    } else {
                        "n-macdur".to_owned()
                    },
                    dur_title: row_title(slot, step, i),
                    unit: unit_tag(step),
                    unit_act: format!("unit|{i}"),
                    unit_title: unit_title(step, i),
                    warn_cls: if warn.is_empty() {
                        "n-macwarn none".to_owned()
                    } else {
                        "n-macwarn".to_owned()
                    },
                    warn_title: step_warning_long(step),
                    warn,
                    short: step_is_short(step),
                    up_cls: if i == 0 {
                        "n-macbtn off".to_owned()
                    } else {
                        "n-macbtn".to_owned()
                    },
                    dn_cls: if i == last {
                        "n-macbtn off".to_owned()
                    } else {
                        "n-macbtn".to_owned()
                    },
                    up_act: format!("up|{i}"),
                    dn_act: format!("down|{i}"),
                    ia_act: format!("insa|{i}"),
                    ib_act: format!("insb|{i}"),
                    del_act: format!("del|{i}"),
                    // On the LAST remaining step the ✕ empties the row instead
                    // of removing it — a macro with no steps is a table the
                    // daemon refuses — and the title says which of the two it
                    // is about to do, so it never reads as a delete that did
                    // not work.
                    del_title: if only {
                        "Clear this step — a macro needs at least one, so this empties the row \
                         instead of removing it, which is a legal neutral gap"
                            .to_owned()
                    } else {
                        "Delete this step".to_owned()
                    },
                }
            })
            .collect();

        // ── The policies, as pills that each say what they do ───────────────
        let mut pols: Vec<NocturneMacPol> = Vec::new();
        for Policy {
            key,
            head,
            note,
            options,
        } in POLICIES
        {
            let current = match key {
                "on_release" => mac.on_release.as_str(),
                "retrigger" => mac.retrigger.as_str(),
                "interrupt" => mac.interrupt.as_str(),
                _ => {
                    if mac.repeat.is_empty() {
                        "once"
                    } else {
                        mac.repeat.as_str()
                    }
                }
            };
            for (at, (value, label)) in options.iter().enumerate() {
                pols.push(NocturneMacPol {
                    act: format!("{key}|{value}"),
                    label: (*label).to_owned(),
                    title: format!("{head} — {label}"),
                    cls: if *value == current {
                        "n-bpill on".to_owned()
                    } else {
                        "n-bpill".to_owned()
                    },
                    head: head.to_owned(),
                    head_cls: if at == 0 {
                        "n-macpol-head".to_owned()
                    } else {
                        "n-macpol-head none".to_owned()
                    },
                    note: note.to_owned(),
                    note_cls: if at == 0 {
                        "n-macpol-note".to_owned()
                    } else {
                        "n-macpol-note none".to_owned()
                    },
                });
            }
        }

        let motions: Vec<NocturneMacMotion> = MOTIONS
            .iter()
            .map(|(act, shape, label, title)| NocturneMacMotion {
                act: (*act).to_owned(),
                shape: (*shape).to_owned(),
                label: (*label).to_owned(),
                title: (*title).to_owned(),
            })
            .collect();

        let steps = match mac.steps.len() {
            1 => "1 step".to_owned(),
            n => format!("{n} steps"),
        };
        let turbo_on = mac.repeat == "turbo";
        Self {
            open: true,
            back_cls: "nd-back".to_owned(),
            name: mac.name.clone(),
            slot: number.to_string(),
            preset: slot.map(|s| s.preset.clone()).unwrap_or_default(),
            table: Some(mac.clone()),
            head: format!("{steps} · {} ms", macro_total_ms(mac)),
            trigger: macro_trigger_line(Some(mac)),
            note: if mac.disabled {
                "Disabled — it keeps every step and never starts.".to_owned()
            } else {
                String::new()
            },
            grid_cls: if mac.steps.is_empty() {
                "n-macroll empty".to_owned()
            } else {
                "n-macroll".to_owned()
            },
            close_href: match q {
                Some(q) if !q.is_empty() => {
                    format!("/nocturne?slot={number}&q={}", crate::server::urlencode(q))
                }
                _ => format!("/nocturne?slot={number}"),
            },
            map_href: format!("/map?target=stage&slot={number}&macro={}", mac.name),
            cols,
            groups,
            rows,
            cells,
            pols,
            motions,
            motion_line: macro_motion_line(slot),
            policy_line: macro_policy_line(Some(mac)),
            ring: crate::render_map::MACRO_RING_LINE.to_owned(),
            rule: crate::render_map::MACRO_RULE_LINE.to_owned(),
            toml: macro_toml(mac),
            turbo_cls: if turbo_on {
                "n-macrate".to_owned()
            } else {
                "n-macrate none".to_owned()
            },
            turbo_val: match (mac.turbo_hz, mac.gap_ms) {
                (Some(hz), _) => hz.to_string(),
                (_, Some(gap)) => gap.to_string(),
                _ => String::new(),
            },
            turbo_label: if mac.turbo_hz.is_none() && mac.gap_ms.is_some() {
                "Neutral gap between runs, in milliseconds".to_owned()
            } else {
                "Auto-fire rate, in full cycles a second".to_owned()
            },
            turbo_max: if mac.turbo_hz.is_none() && mac.gap_ms.is_some() {
                "5000".to_owned()
            } else {
                "60".to_owned()
            },
        }
    }
}
