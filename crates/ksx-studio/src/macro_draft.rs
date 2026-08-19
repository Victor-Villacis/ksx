//! Editing a macro draft — the verbs behind every control in the /nocturne
//! step editor, applied to a whole `[macros.<name>]` table in memory.
//!
//! **Where the draft lives.** Nowhere on the server. The browser holds the
//! table it is editing and posts it back with ONE act; this module answers
//! with the new table and the sentence to say about it. That keeps the write
//! model the daemon already has — `save_macro` takes one whole table — and
//! means a reload, a poll or a second tab can never find a half-edited macro
//! sitting in the studio's memory.
//!
//! **Why the verbs are here and not in the browser.** The subtle ones are
//! about the diagonal lens: ticking `→` on a step already holding `↓` does not
//! add a control, it *changes the shape of the row*, and the report that says
//! so has to know exactly what [`fold`] would paint. That answer already lives
//! in [`crate::render_map`]; asking it from a second implementation in another
//! language is how the two drift.

use ksx_api::{MacroStepView, MacroView, MapperSlot};

/// What one act did. `Ok(None)` is the common case — it worked and the cell
/// you clicked is its own report; `Ok(Some(said))` worked and has something to
/// teach; `Err(why)` means NOTHING CHANGED, and why.
///
/// The three are separate on purpose. Folding a refusal into "applied,
/// nothing to say" let a rejected duration sit in its box while the footer
/// claimed unsaved changes and Save wrote the old number — the screen and the
/// draft disagreeing, which is the one thing this editor cannot do.
pub type ActOutcome = Result<Option<String>, String>;

use crate::render_map::{
    driven_mechanisms, fold, frames_ms, hold_text, parse_diag_token, pointing, points_same_way,
    Diag, Held, Mechanism,
};

/// A fresh step: 50 ms, holding nothing. Fifty is the fighting-game default a
/// motion is written in, and a step holding nothing is a legal neutral gap.
fn new_step() -> MacroStepView {
    MacroStepView {
        hold: Vec::new(),
        ms: Some(50),
        frames: None,
        allow_short: false,
    }
}

/// Is this step authored in frames? Exactly one of the two fields is set in a
/// valid file; a step carrying both or neither is a fault the editor names
/// rather than resolves, and counts as milliseconds here.
fn in_frames(step: &MacroStepView) -> bool {
    step.frames.is_some() && step.ms.is_none()
}

/// The four cardinal directions of a mechanism, in `[down, left, right, up]`
/// order — the vocabulary the motion table is written in.
fn direction(mechanism: Mechanism, name: &str) -> &'static str {
    match name {
        "down" => mechanism.function(true, false),
        "up" => mechanism.function(true, true),
        "left" => mechanism.function(false, false),
        _ => mechanism.function(false, true),
    }
}

/// The eight motions, as the directions each of their steps holds. A step
/// holding two is a diagonal — ONE step, and the row spells the pair it
/// stores beside its name.
const GATE: [&[&str]; 8] = [
    &["right"],
    &["down", "right"],
    &["down"],
    &["down", "left"],
    &["left"],
    &["up", "left"],
    &["up"],
    &["up", "right"],
];

const GATE_MIRRORED: [&[&str]; 8] = [
    &["left"],
    &["down", "left"],
    &["down"],
    &["down", "right"],
    &["right"],
    &["up", "right"],
    &["up"],
    &["up", "left"],
];

fn motion(name: &str) -> Option<(&'static str, Vec<&'static [&'static str]>)> {
    let steps: Vec<&'static [&'static str]> = match name {
        "qcf" => vec![&["down"], &["down", "right"], &["right"]],
        "qcb" => vec![&["down"], &["down", "left"], &["left"]],
        "hcf" => vec![
            &["left"],
            &["down", "left"],
            &["down"],
            &["down", "right"],
            &["right"],
        ],
        "hcb" => vec![
            &["right"],
            &["down", "right"],
            &["down"],
            &["down", "left"],
            &["left"],
        ],
        "dpf" => vec![&["right"], &["down"], &["down", "right"]],
        "dpb" => vec![&["left"], &["down"], &["down", "left"]],
        "spdf" => GATE.to_vec(),
        "spdb" => GATE_MIRRORED.to_vec(),
        _ => return None,
    };
    let label = match name {
        "qcf" => "quarter-circle forward (↓ ↘ →)",
        "qcb" => "quarter-circle back (↓ ↙ ←)",
        "hcf" => "half-circle forward (← ↙ ↓ ↘ →)",
        "hcb" => "half-circle back (→ ↘ ↓ ↙ ←)",
        "dpf" => "dragon punch forward (→ ↓ ↘)",
        "dpb" => "dragon punch back (← ↓ ↙)",
        "spdf" => "360 forward (→ ↘ ↓ ↙ ← ↖ ↑ ↗)",
        _ => "360 back (← ↙ ↓ ↘ → ↗ ↑ ↖)",
    };
    Some((label, steps))
}

/// Which mechanism the motion buttons write: the first one THIS SLOT's own
/// direction keys actually drive, falling back to the d-pad.
fn motion_mechanism(slot: Option<&MapperSlot>) -> Mechanism {
    driven_mechanisms(slot)
        .first()
        .copied()
        .unwrap_or(Mechanism::Dpad)
}

/// Which diagonal, if any, each mechanism folds into for this hold — the
/// question `shape_change` asks before and after a click.
fn shape_of(hold: &[String]) -> Vec<(Mechanism, Diag, Vec<String>)> {
    let mut out: Vec<(Mechanism, Diag, Vec<String>)> = Vec::new();
    for held in fold(hold) {
        let Held::Diagonal {
            diag,
            mechanisms,
            members,
            ..
        } = held
        else {
            continue;
        };
        let names: Vec<String> = members.iter().map(|m| hold[*m].clone()).collect();
        for mechanism in mechanisms {
            // A coalesced diagonal lists every mechanism's members together,
            // so narrow the names back to the ones this mechanism owns.
            let mine: Vec<String> = names
                .iter()
                .filter(|n| pointing(n).is_some_and(|p| p.mechanism == mechanism))
                .cloned()
                .collect();
            out.push((mechanism, diag, mine));
        }
    }
    out
}

/// Did this click change the SHAPE of the row — did two cardinals just become
/// a diagonal, or did one just come apart?
///
/// This is the report the cell itself cannot make. Ticking `→` on a step
/// already holding `↓` moves the filled mark twelve columns away, rewrites the
/// row's words and grows a ledger — all from a click on a cell that ends up
/// showing a subordinate tick. `None` for the overwhelmingly common case: a
/// button, or a cardinal that neither completes nor breaks a pair.
fn shape_change(index: usize, before: &[String], after: &[String]) -> Option<String> {
    let was = shape_of(before);
    let now = shape_of(after);
    for (mechanism, diag, names) in &now {
        if !was.iter().any(|(m, d, _)| m == mechanism && d == diag) {
            return Some(format!(
                "Step {}: {} and {} are {}{} — one step, and the file still spells both.",
                index + 1,
                names.first().cloned().unwrap_or_default(),
                names.get(1).cloned().unwrap_or_default(),
                mechanism.group(),
                diag.glyph(),
            ));
        }
    }
    for (mechanism, diag, _) in &was {
        if !now.iter().any(|(m, d, _)| m == mechanism && d == diag) {
            let left: Vec<String> = after
                .iter()
                .filter(|f| pointing(f).is_some_and(|p| p.mechanism == *mechanism))
                .cloned()
                .collect();
            return Some(format!(
                "Step {}: {}{} came apart — {} is what is left.",
                index + 1,
                mechanism.group(),
                diag.glyph(),
                if left.is_empty() {
                    "nothing".to_owned()
                } else {
                    left.join(" + ")
                },
            ));
        }
    }
    None
}

/// Toggle one cell: `step` × a column token (a function name, or
/// `diag:<mech>:<diag>`).
fn toggle_cell(
    draft: &mut MacroView,
    index: usize,
    token: &str,
    slot: Option<&MapperSlot>,
) -> ActOutcome {
    let Some(step) = draft.steps.get_mut(index) else {
        return Err(format!("There is no step {}.", index.saturating_add(1)));
    };
    let before = step.hold.clone();
    let Some((mechanism, diag)) = parse_diag_token(token) else {
        // A plain control: matched by WHERE IT POINTS when it is a direction,
        // so a hand-written `ly.-16384` unticks from its own `↓` cell.
        let at = match pointing(token) {
            Some(want) => step.hold.iter().position(|f| points_same_way(f, want)),
            None => step.hold.iter().position(|f| f.eq_ignore_ascii_case(token)),
        };
        match at {
            Some(at) => {
                step.hold.remove(at);
            }
            None => step.hold.push(token.to_owned()),
        }
        let after = step.hold.clone();
        return Ok(shape_change(index, &before, &after));
    };

    // IS THIS CELL LIT? Asked of `fold` — the SAME answer that painted it —
    // never of "does the hold contain both halves". Those two disagree on
    // exactly one shape, and it is a shape real files carry: `down + right +
    // up` contains both halves of ↘ but contradicts itself, so the cell paints
    // OFF. Under "contains both", one click on that off cell would wipe all
    // three holds and report a clear of something the cell said it did not
    // hold.
    let (up, right) = diag.halves();
    let pair = [
        mechanism.function(true, up).to_owned(),
        mechanism.function(false, right).to_owned(),
    ];
    let lit = fold(&step.hold).iter().any(|held| match held {
        Held::Diagonal {
            diag: d,
            mechanisms,
            ..
        } => *d == diag && mechanisms.contains(&mechanism),
        Held::Plain { .. } => false,
    });
    // Everything this mechanism holds right now, however the file spells it.
    let mine: Vec<String> = before
        .iter()
        .filter(|f| pointing(f).is_some_and(|p| p.mechanism == mechanism))
        .cloned()
        .collect();
    step.hold
        .retain(|f| !pointing(f).is_some_and(|p| p.mechanism == mechanism));
    if !lit {
        step.hold.extend(pair.iter().cloned());
    }
    let _ = slot;
    Ok(Some(if lit {
        format!(
            "Step {}: cleared {}{} — removed {}.",
            index + 1,
            mechanism.group(),
            diag.glyph(),
            mine.join(" + ")
        )
    } else {
        // Named from the hold as WRITTEN: unticking a hand-written
        // `ly.-16384 + lx.max` must not claim it removed `ly.min`.
        let displaced: Vec<String> = mine
            .iter()
            .filter(|f| !pair.iter().any(|p| p.eq_ignore_ascii_case(f)))
            .cloned()
            .collect();
        let mut said = format!(
            "Step {}: {}{} ({}, numpad {}) — ksx wrote {}, because that is what a diagonal is \
             in the file.",
            index + 1,
            mechanism.group(),
            diag.glyph(),
            diag.words(),
            diag.numpad(),
            pair.join(" + "),
        );
        if !displaced.is_empty() {
            said.push_str(&format!(
                " Replaced {} on {}.",
                displaced.join(" + "),
                mechanism.describe()
            ));
        }
        said
    }))
}

/// Switch one row between `ms` and `frames`, CONVERTING rather than
/// reinterpreting: 50 ms picked as frames is 3 frames, not 50 of them. The
/// unit buys readability and nothing else, so changing it must never change
/// how long the step runs.
fn set_unit(draft: &mut MacroView, index: usize) -> ActOutcome {
    let Some(step) = draft.steps.get_mut(index) else {
        return Err(format!("There is no step {}.", index.saturating_add(1)));
    };
    if in_frames(step) {
        step.ms = Some(frames_ms(step.frames.unwrap_or(1)));
        step.frames = None;
    } else {
        let ms = step.ms.unwrap_or(50);
        // ⚠️ IN u64, NARROWED AT THE END. `ms * 60 + 500` in u32 overflows
        // at 71,582,780 ms — a duration a file can already carry — which
        // panicked the blocking task in debug and, in release, silently
        // WRAPPED: the unit toggle would change how long the step runs, the
        // one thing its promise is that it never does. The widest possible
        // ms yields 257,698,038, so the narrowing cannot fail.
        let frames = (u64::from(ms) * 60 + 500) / 1000;
        step.frames = Some(u32::try_from(frames).unwrap_or(u32::MAX).max(1));
        step.ms = None;
    }
    Ok(None)
}

/// Apply ONE act to the draft, and answer with what to say about it.
///
/// An act that names a step that is not there, or a word this editor does not
/// know, changes nothing — the browser can no more write a junk policy through
/// this door than a hand-authored POST can.
pub fn apply(draft: &mut MacroView, act: &str, slot: Option<&MapperSlot>) -> ActOutcome {
    let mut parts = act.splitn(3, '|');
    let verb = parts.next().unwrap_or_default();
    let one = parts.next().unwrap_or_default();
    let two = parts.next().unwrap_or_default();
    let index: usize = one.parse().unwrap_or(usize::MAX);
    let n = draft.steps.len();
    match verb {
        "cell" => toggle_cell(draft, index, two, slot),
        "unit" => set_unit(draft, index),
        "dur" => {
            // A number typed into a row's box is authored in whatever unit
            // that row is showing. A fraction is ROUNDED rather than
            // refused — the field is a number input and 2.5 is a thing a
            // person types — but a zero-length step is not a shorter step,
            // it is a step the loader refuses.
            let value = match two.parse::<f64>() {
                Ok(v) if v.is_finite() && v >= 0.5 => (v.round() as u64).min(u64::from(u32::MAX)) as u32,
                _ => {
                    return Err(format!(
                        "“{two}” is not a length. A step is at least 1, in whichever unit its row shows."
                    ))
                }
            };
            let Some(step) = draft.steps.get_mut(index) else {
                return Err(format!("There is no step {}.", index.saturating_add(1)));
            };
            if in_frames(step) {
                step.frames = Some(value);
                step.ms = None;
            } else {
                step.ms = Some(value);
                step.frames = None;
            }
            Ok(None)
        }
        "short" => {
            let Some(step) = draft.steps.get_mut(index) else {
                return Err(format!("There is no step {}.", index.saturating_add(1)));
            };
            // The consent is only meaningful about a step the floor would
            // actually raise. Saying "the game may miss it" over an 80 ms
            // step is a sentence that is simply untrue.
            if !crate::render_map::step_is_short(step) {
                return Err(format!(
                    "Step {} is already long enough for the 60 Hz floor — there is nothing to allow.",
                    index + 1
                ));
            }
            step.allow_short = !step.allow_short;
            Ok(Some(if step.allow_short {
                format!(
                    "Step {} runs exactly as written, and the game may miss it entirely.",
                    index + 1
                )
            } else {
                format!(
                    "Step {} is raised to the 33 ms floor again, so it lands.",
                    index + 1
                )
            }))
        }
        "add" => {
            draft.steps.push(new_step());
            Ok(Some(format!("Step {} added, holding nothing yet.", n + 1)))
        }
        "insa" => {
            if index > n {
                return Err("There is no such step to insert above.".to_owned());
            }
            draft.steps.insert(index, new_step());
            Ok(Some(format!("Step {} added above.", index + 1)))
        }
        "insb" => {
            if index >= n {
                return Err("There is no such step to insert below.".to_owned());
            }
            draft.steps.insert(index + 1, new_step());
            Ok(Some(format!("Step {} added below.", index + 2)))
        }
        "del" => {
            if index >= n {
                return Err("There is no such step to delete.".to_owned());
            }
            // THE EMPTY-EDITOR DEAD END IS UNREACHABLE. `save_macro` refuses a
            // zero-step table, so deleting the LAST remaining step empties it
            // instead of removing it: the author lands on a step holding
            // nothing — a legal neutral gap — never on a blank grid whose
            // every add affordance lived on a row that no longer exists.
            if n == 1 {
                draft.steps[0].hold.clear();
                return Ok(Some("That was the last step, so it was cleared rather than removed — a macro needs at least one.".to_owned()));
            }
            draft.steps.remove(index);
            Ok(Some(format!("Step {} deleted.", index + 1)))
        }
        "up" => {
            if index == 0 || index >= n {
                return Err("That step is already at the top.".to_owned());
            }
            draft.steps.swap(index - 1, index);
            Ok(None)
        }
        "down" => {
            // ⚠️ RANGE FIRST. `index + 1 >= n` evaluated the arithmetic
            // before the test, and a malformed index parses to usize::MAX —
            // so `down|x` overflowed and panicked the blocking task. Every
            // sibling arm tested the range first; this one did not.
            if index >= n || index + 1 >= n {
                return Err("That step is already at the bottom.".to_owned());
            }
            draft.steps.swap(index, index + 1);
            Ok(None)
        }
        "motion" => {
            let Some((label, steps)) = motion(one) else {
                return Err(format!("“{one}” is not a motion this editor knows."));
            };
            let mechanism = motion_mechanism(slot);
            let first = draft.steps.len();
            for dirs in &steps {
                let mut step = new_step();
                step.hold = dirs
                    .iter()
                    .map(|d| direction(mechanism, d).to_owned())
                    .collect();
                draft.steps.push(step);
            }
            let shape: Vec<String> = steps
                .iter()
                .map(|dirs| {
                    let hold: Vec<String> = dirs
                        .iter()
                        .map(|d| direction(mechanism, d).to_owned())
                        .collect();
                    hold_text(slot, &hold)
                })
                .collect();
            let diagonals: Vec<usize> = steps
                .iter()
                .enumerate()
                .filter(|(_, dirs)| dirs.len() > 1)
                .map(|(at, _)| first + at + 1)
                .collect();
            let which = if diagonals.len() == 1 {
                format!("Step {} is the diagonal", diagonals[0])
            } else {
                format!(
                    "Steps {} are the diagonals",
                    diagonals
                        .iter()
                        .map(|n| n.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            Ok(Some(format!(
                "Added {} steps for the {label}, at 50 ms each, on {}: {}. {which} — ONE step \
                 each, and each one spells the pair it stores beside its name. Add the attack \
                 button as a final step, then Save.",
                steps.len(),
                mechanism.describe(),
                shape.join(" · "),
            )))
        }
        // Unknown words are refused here, not written into a table that would
        // then fail to load.
        "pol" => {
            match (one, two) {
                ("on_release", "finish" | "abort") => draft.on_release = two.to_owned(),
                ("retrigger", "ignore" | "restart") => draft.retrigger = two.to_owned(),
                ("interrupt", "none" | "any-input" | "opposing") => {
                    draft.interrupt = two.to_owned()
                }
                ("repeat", "once" | "while-held" | "turbo") => {
                    draft.repeat = two.to_owned();
                    // Turbo without a number is a table the loader refuses.
                    if two == "turbo" && draft.turbo_hz.is_none() && draft.gap_ms.is_none() {
                        draft.turbo_hz = Some(10);
                    }
                }
                _ => return Err(format!("“{two}” is not a setting this editor knows.")),
            }
            Ok(None)
        }
        "rate" => {
            // ⚠️ THE UNIT IS THE AUTHOR'S. A table may spell its auto-fire as
            // a rate in hertz OR as the neutral gap between runs, and the two
            // are two spellings of one number that the daemon deliberately
            // does not convert behind the author's back. Writing turbo_hz
            // unconditionally turned a `gap_ms = 40` macro into 41 Hz — the
            // same digits meaning something else entirely.
            let gap = draft.turbo_hz.is_none() && draft.gap_ms.is_some();
            let ceiling = if gap { 5_000 } else { 60 };
            let value: u32 = match one.parse() {
                Ok(v) if v > 0 && v <= ceiling => v,
                _ => {
                    return Err(if gap {
                        format!("A gap is between 1 and {ceiling} ms.")
                    } else {
                        format!("An auto-fire rate is between 1 and {ceiling} a second.")
                    })
                }
            };
            if gap {
                draft.gap_ms = Some(value);
            } else {
                draft.turbo_hz = Some(value);
                draft.gap_ms = None;
            }
            Ok(None)
        }
        _ => Err(format!("“{verb}” is not something this editor does.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(steps: Vec<MacroStepView>) -> MacroView {
        MacroView {
            name: "combo".into(),
            steps,
            on_release: "finish".into(),
            retrigger: "ignore".into(),
            interrupt: "none".into(),
            repeat: "once".into(),
            turbo_hz: None,
            gap_ms: None,
            triggers: Vec::new(),
            disabled: false,
        }
    }

    fn step(hold: &[&str]) -> MacroStepView {
        MacroStepView {
            hold: hold.iter().map(|h| (*h).to_owned()).collect(),
            ms: Some(50),
            frames: None,
            allow_short: false,
        }
    }

    /// The act worked; give me what it said (panics if it was refused).
    fn said(draft: &mut MacroView, act: &str) -> String {
        match apply(draft, act, None) {
            Ok(Some(said)) => said,
            Ok(None) => String::new(),
            Err(why) => panic!("{act} was refused: {why}"),
        }
    }

    /// The act was REFUSED; give me why (panics if it went through).
    fn refused(draft: &mut MacroView, act: &str) -> String {
        match apply(draft, act, None) {
            Err(why) => why,
            other => panic!("{act} was not refused: {other:?}"),
        }
    }

    /// Picking a diagonal writes the PAIR, because that is what a diagonal is
    /// in the file — and says so.
    #[test]
    fn a_diagonal_pick_writes_both_halves() {
        let mut d = draft(vec![step(&[])]);
        let out = said(&mut d, "cell|0|diag:dpad:dr");
        assert_eq!(d.steps[0].hold, vec!["dpad.down", "dpad.right"]);
        assert!(out.contains("dpad.down + dpad.right"), "{out}");
        assert!(out.contains("numpad 3"), "{out}");
    }

    /// …and clicking it again clears the whole diagonal, naming what it took.
    #[test]
    fn clicking_a_lit_diagonal_clears_it() {
        let mut d = draft(vec![step(&["dpad.down", "dpad.right"])]);
        let out = said(&mut d, "cell|0|diag:dpad:dr");
        assert!(d.steps[0].hold.is_empty(), "{:?}", d.steps[0].hold);
        assert!(out.contains("cleared"), "{out}");
    }

    /// THE CONTRADICTORY STEP: `down + right + up` contains both halves of
    /// ↘ but does not fold, so the cell paints OFF — and a click on it must
    /// TICK the diagonal on, never take the clear branch.
    #[test]
    fn an_unlit_diagonal_on_a_contradictory_step_turns_on() {
        let mut d = draft(vec![step(&["dpad.down", "dpad.right", "dpad.up"])]);
        said(&mut d, "cell|0|diag:dpad:dr");
        assert_eq!(d.steps[0].hold, vec!["dpad.down", "dpad.right"]);
    }

    /// A hand-written spelling unticks from its own cell, and the report is
    /// named from the hold AS WRITTEN.
    #[test]
    fn a_hand_written_direction_answers_its_own_column() {
        let mut d = draft(vec![step(&["ly.-16384", "lx.max"])]);
        let out = said(&mut d, "cell|0|diag:ls:dr");
        assert!(
            out.contains("ly.-16384"),
            "names what the file holds: {out}"
        );
        assert!(d.steps[0].hold.is_empty());
    }

    /// Ticking the second cardinal FOLDS the row into a diagonal — the click
    /// whose effect is not the cell you hit, so it is the one that speaks.
    #[test]
    fn completing_a_pair_reports_the_fold() {
        let mut d = draft(vec![step(&["dpad.down"])]);
        let out = said(&mut d, "cell|0|dpad.right");
        assert!(out.contains('↘'), "{out}");
        assert_eq!(d.steps[0].hold, vec!["dpad.down", "dpad.right"]);
    }

    /// A plain button toggle says nothing: the cell is the whole report.
    #[test]
    fn a_button_toggle_is_its_own_report() {
        let mut d = draft(vec![step(&[])]);
        assert_eq!(said(&mut d, "cell|0|A"), "");
        assert_eq!(d.steps[0].hold, vec!["A"]);
        assert_eq!(said(&mut d, "cell|0|A"), "");
        assert!(d.steps[0].hold.is_empty());
    }

    /// The last ✕ clears the step instead of deleting it — a zero-step table
    /// is a refusal, so the editor must not be able to reach one.
    #[test]
    fn the_last_step_clears_rather_than_vanishes() {
        let mut d = draft(vec![step(&["A"])]);
        let out = said(&mut d, "del|0");
        assert_eq!(d.steps.len(), 1);
        assert!(d.steps[0].hold.is_empty());
        assert!(out.contains("cleared"), "{out}");
        // With two steps it really deletes.
        let mut d = draft(vec![step(&["A"]), step(&["B"])]);
        said(&mut d, "del|0");
        assert_eq!(d.steps.len(), 1);
        assert_eq!(d.steps[0].hold, vec!["B"]);
    }

    /// The unit CONVERTS rather than reinterprets.
    #[test]
    fn the_unit_toggle_keeps_the_length() {
        let mut d = draft(vec![step(&[])]);
        said(&mut d, "unit|0");
        assert_eq!(d.steps[0].frames, Some(3), "50 ms is 3 frames, not 50");
        assert_eq!(d.steps[0].ms, None);
        said(&mut d, "unit|0");
        assert_eq!(d.steps[0].ms, Some(50));
        assert_eq!(d.steps[0].frames, None);
    }

    /// …and it does that for EVERY length a file can carry. The u32 form
    /// `ms * 60 + 500` overflowed at 71,582,780 ms: a panic in debug, and in
    /// release a silent wrap that changed how long the step runs — the one
    /// thing the unit toggle promises it never does.
    #[test]
    fn the_unit_toggle_survives_a_length_no_one_should_type() {
        for (ms, want) in [(71_582_780_u32, 4_294_967_u32), (99_999_999, 6_000_000)] {
            let mut d = draft(vec![MacroStepView {
                hold: Vec::new(),
                ms: Some(ms),
                frames: None,
                allow_short: false,
            }]);
            said(&mut d, "unit|0");
            assert_eq!(d.steps[0].frames, Some(want), "{ms} ms");
        }
    }

    /// A typed number is authored in whatever unit its row is showing, a
    /// fraction is rounded rather than thrown away, and anything that is not
    /// a length is REFUSED in words instead of silently ignored.
    #[test]
    fn a_typed_duration_stays_in_its_row_s_unit() {
        let mut d = draft(vec![step(&[])]);
        said(&mut d, "unit|0");
        said(&mut d, "dur|0|2");
        assert_eq!(d.steps[0].frames, Some(2));
        assert_eq!(d.steps[0].ms, None);
        said(&mut d, "dur|0|2.6");
        assert_eq!(d.steps[0].frames, Some(3), "a fraction rounds");
        for junk in ["dur|0|0", "dur|0|", "dur|0|abc", "dur|0|-4"] {
            let why = refused(&mut d, junk);
            assert!(why.contains("length"), "{junk}: {why}");
            assert_eq!(d.steps[0].frames, Some(3), "{junk} changed the draft");
        }
    }

    /// A motion appends its shape, and every diagonal in it is ONE step.
    #[test]
    fn a_quarter_circle_is_three_steps_one_of_them_a_diagonal() {
        let mut d = draft(vec![step(&["A"])]);
        let out = said(&mut d, "motion|qcf");
        assert_eq!(d.steps.len(), 4);
        assert_eq!(d.steps[1].hold, vec!["dpad.down"]);
        assert_eq!(d.steps[2].hold, vec!["dpad.down", "dpad.right"]);
        assert_eq!(d.steps[3].hold, vec!["dpad.right"]);
        assert!(out.contains("Step 3 is the diagonal"), "{out}");
    }

    /// A 360 walks all eight positions, four of them diagonals.
    #[test]
    fn a_360_walks_the_whole_ring() {
        let mut d = draft(vec![]);
        said(&mut d, "motion|spdf");
        assert_eq!(d.steps.len(), 8);
        assert_eq!(d.steps.iter().filter(|s| s.hold.len() == 2).count(), 4);
    }

    /// Unknown words are refused rather than written into a table that would
    /// then fail to load — and the refusal SAYS SO.
    #[test]
    fn a_junk_policy_changes_nothing() {
        let mut d = draft(vec![step(&[])]);
        assert!(!refused(&mut d, "pol|on_release|explode").is_empty());
        assert_eq!(d.on_release, "finish");
        said(&mut d, "pol|on_release|abort");
        assert_eq!(d.on_release, "abort");
        // Turbo without a rate is a table the loader refuses, so one arrives.
        said(&mut d, "pol|repeat|turbo");
        assert_eq!(d.repeat, "turbo");
        assert_eq!(d.turbo_hz, Some(10));
        said(&mut d, "rate|20");
        assert_eq!(d.turbo_hz, Some(20));
        assert!(!refused(&mut d, "rate|900").is_empty());
        assert_eq!(d.turbo_hz, Some(20), "an impossible rate is refused");
    }

    /// THE UNIT IS THE AUTHOR'S. A table that spells its auto-fire as the
    /// neutral GAP between runs keeps saying it in milliseconds; writing
    /// turbo_hz over it would turn "40 ms of neutral" into "41 a second".
    #[test]
    fn a_rate_is_written_in_the_unit_the_table_already_uses() {
        let mut d = draft(vec![step(&[])]);
        d.repeat = "turbo".into();
        d.gap_ms = Some(40);
        said(&mut d, "rate|41");
        assert_eq!(d.gap_ms, Some(41), "the gap stays a gap");
        assert_eq!(d.turbo_hz, None, "and no rate appears beside it");
        // A hertz-authored table keeps hertz, and its tighter ceiling.
        let mut d = draft(vec![step(&[])]);
        d.repeat = "turbo".into();
        d.turbo_hz = Some(10);
        said(&mut d, "rate|30");
        assert_eq!(d.turbo_hz, Some(30));
        assert_eq!(d.gap_ms, None);
    }

    /// Moving a step keeps everything it holds — and a step at the end says
    /// so instead of pretending.
    #[test]
    fn steps_move_whole() {
        let mut d = draft(vec![step(&["A"]), step(&["B"]), step(&["X"])]);
        said(&mut d, "down|0");
        assert_eq!(d.steps[0].hold, vec!["B"]);
        assert_eq!(d.steps[1].hold, vec!["A"]);
        assert!(refused(&mut d, "up|0").contains("top"));
        assert_eq!(d.steps[0].hold, vec!["B"], "still at that end");
        said(&mut d, "insb|2");
        assert_eq!(d.steps.len(), 4);
        assert!(d.steps[3].hold.is_empty());
    }

    /// A MALFORMED ACT IS ANSWERED, NOT SUFFERED. Every index parses through
    /// `usize::MAX`, and `down` was the one arm that did its arithmetic
    /// before its range test — so `down|x` overflowed and panicked the
    /// request. Nothing here may panic, and nothing may change the draft.
    #[test]
    fn a_malformed_act_refuses_instead_of_panicking() {
        let acts = [
            "down|x",
            "down|-1",
            "down",
            "up|x",
            "insa|-1",
            "insb|x",
            "del|-1",
            "short|-1",
            "cell|-1|A",
            "unit|x",
            "dur|x|5",
            "motion|nonsense",
            "rate|x",
            "wat",
            "",
        ];
        for act in acts {
            let mut d = draft(vec![step(&["A"]), step(&["B"])]);
            let before = d.clone();
            match apply(&mut d, act, None) {
                Err(_) => {}
                Ok(said) => panic!("{act:?} should have been refused, said {said:?}"),
            }
            assert_eq!(d, before, "{act:?} changed the draft");
        }
    }

    /// Allow-short is a per-step consent, and it says what it just consented
    /// to in both directions — but ONLY about a step the floor would really
    /// raise. "The game may miss it" over an 80 ms step is simply untrue.
    #[test]
    fn allow_short_speaks_both_ways_and_only_about_short_steps() {
        let mut d = draft(vec![MacroStepView {
            hold: Vec::new(),
            ms: None,
            frames: Some(1),
            allow_short: false,
        }]);
        let on = said(&mut d, "short|0");
        assert!(d.steps[0].allow_short);
        assert!(on.contains("may miss it"), "{on}");
        let off = said(&mut d, "short|0");
        assert!(!d.steps[0].allow_short);
        assert!(off.contains("33 ms"), "{off}");

        // A step above the floor has nothing to consent to.
        let mut long = draft(vec![step(&[])]);
        let why = refused(&mut long, "short|0");
        assert!(why.contains("long enough"), "{why}");
        assert!(!long.steps[0].allow_short);
    }
}
