//! **What ksx knows about one terminal, and how it came to know it.**
//!
//! Pure composition over injected facts — the shape `panel::view` already
//! takes, and the reason this can be tested in CI without a cabinet. It opens
//! no device, takes no lease, and sends nothing.
//!
//! # Two sources answering two different questions
//!
//! A CHART READ is instantaneous truth about the bytes a board STORES. An
//! OBSERVATION is historical truth about the signal it EMITTED. They can
//! disagree, and when they do the disagreement is the answer — because neither
//! is a superset of the other:
//!
//! - A chart cannot see a macro. `docs/ENHANCEMENTS.md` E10 measured it: onboard
//!   macros are vendor bytes preserved verbatim and never parsed, so a macro'd
//!   terminal is byte-identical to an unassigned one. If the chart simply won,
//!   such a terminal would report "unassigned" forever and the product's central
//!   question — *which of my buttons collide?* — would be answered wrong with
//!   full confidence.
//! - An observation cannot name a terminal. Only a chart can say which screw
//!   emits a given key, and only when exactly one does.
//!
//! # Freshness, precisely
//!
//! A chart value is fresh for a terminal only inside the response that produced
//! it. Nothing in ksx watches a board between requests and WinIPAC can rewrite
//! one at any moment, so a chart value re-served later is a stale answer wearing
//! a fresh one's clothes. That is why [`ksx_api::PanelChartEvidence::Read`]
//! carries its `image_sha256`: an observation stamped with a different hash was
//! taken against a board that has since changed, and says so rather than
//! silently agreeing.
//!
//! # `Matched` has three preconditions, all required
//!
//! The observation's `against_image_sha256` equals this read's; its attribution
//! is [`ksx_api::PanelObservationAttribution::ChartUnique`]; its vouching is
//! `Vouched`. Miss any one and the chart is still the answer, with the
//! observation shown BELOW it as supporting evidence carrying its own timestamp.
//! Never merged into one string. This is `controlSurfaceSignalTruth`'s standing
//! rule given teeth: *"Never infer a fresh match merely because those two
//! retained strings happen to be equal."*

use ksx_api::{
    PanelChartEvidence, PanelDeclaredEvidence, PanelKeyValue, PanelObservationAttribution,
    PanelObservationVouching, PanelObservedEvidence, PanelShiftSummary, PanelTerminalAnswer,
    PanelTerminalTruth,
};

/// Everything one terminal's answer is composed from.
///
/// A borrowed view rather than owned fields, so the composer can run over a
/// chart read without cloning 56 rows.
pub struct TerminalFacts<'a> {
    pub terminal_id: &'a str,
    pub terminal_label: &'a str,
    pub player: u8,
    pub chart: &'a PanelChartEvidence,
    pub observed: Option<&'a PanelObservedEvidence>,
    pub declared: Option<&'a PanelDeclaredEvidence>,
    /// Whether the key learner can be reached at all. False when the daemon is
    /// not answering: an offer to press a control that cannot be heard is the
    /// bug `BoardRow.pickable` exists to prevent.
    pub learner_reachable: bool,
}

/// Whether a `PanelKeyValue` names a key ksx can actually receive.
fn observable(value: &PanelKeyValue) -> Option<&str> {
    value
        .key
        .as_deref()
        .filter(|key| !key.is_empty() && value.supported)
}

/// True when this observation was taken against exactly this image, was
/// attributed by a chart that held its key on ONE terminal, and nothing has
/// happened since to withdraw that.
fn corroborates(observed: &PanelObservedEvidence, image_sha256: &str) -> bool {
    observed.against_image_sha256.as_deref() == Some(image_sha256)
        && observed.attribution == PanelObservationAttribution::ChartUnique
        && observed.vouching == PanelObservationVouching::Vouched
}

/// The answer when a chart read is in hand for this terminal.
fn with_chart(
    normal: &PanelKeyValue,
    image_sha256: &str,
    observed: Option<&PanelObservedEvidence>,
) -> PanelTerminalAnswer {
    let keys = observed.map(|o| o.keys.clone()).unwrap_or_default();
    let fresh = observed.is_some_and(|o| o.against_image_sha256.as_deref() == Some(image_sha256));

    match observable(normal) {
        // The chart holds a key ksx can receive.
        Some(stored) => {
            if let Some(o) = observed {
                if corroborates(o, image_sha256) && o.keys.len() == 1 && o.keys[0] == stored {
                    return PanelTerminalAnswer::Matched {
                        key: stored.to_owned(),
                    };
                }
                // A press taken against THIS image that produced something else
                // is a real contradiction. One taken against an older image is
                // not: the board changed, which the vouching field already says.
                // `!= [stored]` rather than "does not contain stored": a press
                // that produced this key AND OTHERS is the shape an onboard
                // macro takes on an ASSIGNED terminal, and testing for
                // containment let the chart win and dropped the extra keys from
                // the answer entirely. That is exactly what E10 proves a chart
                // cannot see, so it is the last thing that may be discarded.
                let exactly_stored = o.keys.len() == 1 && o.keys[0] == stored;
                if fresh && !o.keys.is_empty() && !exactly_stored {
                    return PanelTerminalAnswer::Mismatch {
                        stored: normal.clone(),
                        observed: keys,
                    };
                }
            }
            PanelTerminalAnswer::Stored {
                key: stored.to_owned(),
            }
        }
        None if normal.supported => {
            // Raw zero: the byte is Unassigned. NOT "does nothing" — a macro'd
            // terminal looks exactly like this, which is why a press here is
            // worth more than any re-read.
            if fresh && observed.is_some_and(|o| !o.keys.is_empty()) {
                return PanelTerminalAnswer::Unaccounted { observed: keys };
            }
            PanelTerminalAnswer::StoredUnassigned
        }
        // A byte ksx cannot classify: vendor action, macro trigger, or a HID
        // usage outside its capture vocabulary.
        None => {
            if fresh && observed.is_some_and(|o| !o.keys.is_empty()) {
                // The press did not contradict the chart — it COMPLETED it.
                return PanelTerminalAnswer::Resolved {
                    stored: normal.clone(),
                    observed: keys,
                };
            }
            PanelTerminalAnswer::StoredUnclassified {
                code: normal.code,
                label: normal.label.clone(),
            }
        }
    }
}

/// The answer when no chart read is in hand — the normal state of every
/// unprofiled board, and of a profiled one nobody has read yet.
fn without_chart(
    observed: Option<&PanelObservedEvidence>,
    declared: Option<&PanelDeclaredEvidence>,
    never_vouchable: bool,
) -> PanelTerminalAnswer {
    // `Vouched` means "a chart read in THIS response proves the board still
    // holds the image this observation was taken against". Every caller reaches
    // this function precisely BECAUSE no such read exists, so a stored
    // `Vouched` here is a claim about a response that did not happen. Honouring
    // it let an observation ride a REFUSED read to the front of the answer as
    // current truth.
    if let Some(o) = observed.filter(|o| !o.keys.is_empty()) {
        if o.keys.len() > 1 {
            return PanelTerminalAnswer::ObservedMultiple {
                keys: o.keys.clone(),
            };
        }
        let key = o.keys[0].clone();
        // On a board with no reader, "unvouched" is permanent and saying so
        // every time would be nagging about a button that does not exist.
        if never_vouchable || matches!(o.vouching, PanelObservationVouching::NeverVouchable) {
            // On a board with no reader, "unvouched" is permanent, and saying so
            // every time is nagging about a button that does not exist.
            return PanelTerminalAnswer::Observed { key };
        }
        // A MEASURED change says what changed. Everything else says only that
        // nothing has confirmed this — never that the board moved. Collapsing
        // the two made ksx announce a rewrite it never observed on every
        // terminal of every board nobody had re-read, which is every board.
        return match &o.vouching {
            PanelObservationVouching::ChartRewritten { was, now } => {
                PanelTerminalAnswer::ObservedStale {
                    key,
                    was: was.clone(),
                    now: now.clone(),
                }
            }
            _ => PanelTerminalAnswer::ObservedUnvouched { key },
        };
    }
    // An empty key is included on purpose: "I know this one is unassigned" is
    // a real claim the store accepts, and filtering it here dropped the one
    // thing the user locked in from the very surface built to show it.
    if let Some(d) = declared {
        return PanelTerminalAnswer::Declared { key: d.key.clone() };
    }
    PanelTerminalAnswer::Unknown
}

/// **Compose one terminal's truth.**
///
/// The precedence rule, in one place:
///
/// > A chart read taken in THIS response is the answer. An observation is the
/// > answer whenever no such read exists. A declaration is the answer only when
/// > there is neither. **When a fresh chart and a live observation disagree,
/// > neither is the answer — the disagreement is.**
///
/// The loser of a precedence contest is never merged and never deleted: it stays
/// in its own field, with its own timestamp and its own verb.
pub fn compose(facts: &TerminalFacts<'_>) -> PanelTerminalTruth {
    let answer = match facts.chart {
        PanelChartEvidence::Read {
            normal,
            image_sha256,
            ..
        } => {
            let chart_answer = with_chart(normal, image_sha256, facts.observed);
            // A declaration only ever loses to a chart — and loudly, with both
            // values on screen. Silently correcting it would destroy work the
            // user did deliberately, and they may be right about the CABINET
            // even when the firmware disagrees: the wire from that button may
            // not reach the screw the silkscreen names.
            // Keyed off what the CHART holds, not off which answer the chart
            // produced. Matching `Stored` alone meant a press that AGREED with
            // the firmware made ksx stop reporting that the user's own
            // declaration contradicted it — corroboration hid the conflict.
            match (facts.declared, observable(normal)) {
                // A chart that cannot NAME the byte does not contradict a
                // declaration — it is completed by one, the way a press
                // completes it into `Resolved`. Measured on a real I-PAC 4X:
                // 2coin holds vendor byte 0xE0, a declaration was filed, and the
                // answer showed no sign of it because the contradiction arm
                // below needs a key to disagree WITH.
                (Some(d), None) if !d.key.is_empty() => PanelTerminalAnswer::DeclaredCompletes {
                    stored: normal.clone(),
                    declared: d.key.clone(),
                },
                // An EMPTY declaration — "I know this one is unassigned" — is a
                // real claim the store accepts on purpose, and it composes like
                // any other: the zero byte agrees with it, anything else
                // disagrees loudly. Guarding every declared arm with
                // `!d.key.is_empty()` was how the claim got stored, confirmed
                // ("Declaration filed … unassigned.") and then never shown.
                (Some(d), None) if normal.supported && normal.key.is_none() => {
                    debug_assert!(d.key.is_empty());
                    PanelTerminalAnswer::DeclaredUnassigned {
                        stored: normal.clone(),
                    }
                }
                // …and a byte the chart cannot name is still a byte: the board
                // stores SOMETHING where the person said nothing is wired.
                (Some(d), None) if d.key.is_empty() => PanelTerminalAnswer::DeclaredContradicted {
                    declared: d.key.clone(),
                    stored: normal.clone(),
                },
                // Covers the empty declaration against a named key for free:
                // "" never equals an observable key.
                (Some(d), Some(key)) if d.key != key => PanelTerminalAnswer::DeclaredContradicted {
                    declared: d.key.clone(),
                    stored: normal.clone(),
                },
                _ => chart_answer,
            }
        }
        PanelChartEvidence::Refused { .. } => {
            match without_chart(facts.observed, facts.declared, false) {
                PanelTerminalAnswer::Unknown => PanelTerminalAnswer::ChartRefused,
                answer => answer,
            }
        }
        // No reader exists for this model, so nothing can ever vouch and a retry
        // is an offer that always refuses.
        PanelChartEvidence::Unprofiled { .. } => {
            match without_chart(facts.observed, facts.declared, true) {
                PanelTerminalAnswer::Unknown => PanelTerminalAnswer::ChartImpossible,
                answer => answer,
            }
        }
        // Separate arm, because the two differ in what may be SAID. One names a
        // known model with no measured protocol; the other has no model to name,
        // and folding them together made an unidentified board report that ksx
        // can "never" read what its model stores.
        PanelChartEvidence::Unrecognised => {
            match without_chart(facts.observed, facts.declared, true) {
                PanelTerminalAnswer::Unknown => PanelTerminalAnswer::ChartUnknownBoard,
                answer => answer,
            }
        }
        PanelChartEvidence::NotAttempted => without_chart(facts.observed, facts.declared, false),
    };

    PanelTerminalTruth {
        terminal_id: facts.terminal_id.to_owned(),
        terminal_label: facts.terminal_label.to_owned(),
        player: facts.player,
        chart: facts.chart.clone(),
        observed: facts.observed.cloned(),
        declared: facts.declared.cloned(),
        detail: detail_for(&answer),
        invite_press: facts.learner_reachable && press_would_help(&answer),
        answer,
    }
}

/// **The one spelling of "the firmware stores a usage no learner can hear."**
///
/// `panel_programming::facade::key_value` writes this into a label and
/// [`press_would_help`] reads it back out to decide whether pressing the
/// control could ever resolve the byte. That is a contract between two modules
/// carried in a display string, so it is ONE constant rather than two literals
/// and a test asserting they still match: renaming the label without moving the
/// press offer would otherwise invite a person to press a control that produces
/// nothing at all to hear.
pub(crate) const UNOBSERVABLE_ACTION: &str = "Unobservable HID action";

/// **Would pressing this control tell the user something a re-read cannot?**
///
/// The distinction that matters is `StoredUnclassified` versus an unobservable
/// HID action. A press resolves the first — it is the ONLY thing that can — and
/// can never resolve the second, because ksx's capture vocabulary does not
/// contain that usage. Both arrive as `supported: false`, so this reads the
/// label the decoder already authored rather than guessing.
fn press_would_help(answer: &PanelTerminalAnswer) -> bool {
    match answer {
        // A byte ksx cannot name, and an unassigned one, are byte-identical to a
        // macro. Only a press separates them.
        PanelTerminalAnswer::StoredUnclassified { label, .. } => {
            !label.contains(UNOBSERVABLE_ACTION)
        }
        PanelTerminalAnswer::DeclaredCompletes { .. }
        | PanelTerminalAnswer::StoredUnassigned
        | PanelTerminalAnswer::ChartImpossible
        | PanelTerminalAnswer::ChartUnknownBoard
        | PanelTerminalAnswer::ChartRefused
        | PanelTerminalAnswer::Unknown => true,
        // A declared UNASSIGNED terminal (empty key, or the agreeing
        // `DeclaredUnassigned` answer) turns the invitation off: the person
        // said no control is wired here, so "press the control" would be an
        // offer to press a control they just told ksx does not exist.
        PanelTerminalAnswer::Declared { key } => !key.is_empty(),
        // Already answered by a press, or already contradicted — pressing again
        // changes nothing about what is on screen.
        _ => false,
    }
}

/// The one sentence a surface copies verbatim.
///
/// Composed here so two surfaces cannot word one fact two ways, and so a page
/// never has to translate a variant combination into prose itself.
fn detail_for(answer: &PanelTerminalAnswer) -> String {
    match answer {
        PanelTerminalAnswer::Unknown => {
            "Nothing has told ksx what this terminal emits yet.".to_owned()
        }
        PanelTerminalAnswer::ChartRefused => {
            "The board would not answer, so ksx cannot say what this terminal stores. Nothing on \
             the board was changed."
                .to_owned()
        }
        PanelTerminalAnswer::ChartUnknownBoard => {
            "ksx does not recognise this board, so it cannot say what this terminal stores or \
             whether it could ever be read. Press the control and ksx will record what Windows \
             hears."
                .to_owned()
        }
        PanelTerminalAnswer::ChartImpossible => {
            "ksx has no measured profile for this board model, so it can never read what this \
             terminal stores. Press the control and ksx will record what Windows hears."
                .to_owned()
        }
        PanelTerminalAnswer::Stored { key } => {
            format!("The board stores {key} here.")
        }
        PanelTerminalAnswer::StoredUnassigned => {
            "The board stores nothing here — and an onboard macro would look exactly the same. \
             Press the control to find out which."
                .to_owned()
        }
        PanelTerminalAnswer::StoredUnclassified { label, .. } => {
            // `label` already ends in the raw byte, so the code is NOT repeated
            // here. And the closing clause is conditional: `press_would_help`
            // excludes an unobservable usage from `invite_press` because nothing
            // arrives for a learner to hear, and this sentence is copied
            // verbatim by surfaces — so an unconditional "press it" re-issued,
            // two lines away in this same file, the offer that flag suppressed.
            let remedy = if label.contains(UNOBSERVABLE_ACTION) {
                "and no press can reveal it either: this is a usage Windows does not deliver to \
                 ksx. Tell ksx what it is if you know."
            } else {
                "and pressing the control is the only way to find out."
            };
            format!("{label}. ksx keeps this byte exactly as it found it, {remedy}")
        }
        PanelTerminalAnswer::Observed { key } => {
            format!("Pressing this control sent {key}.")
        }
        PanelTerminalAnswer::ObservedMultiple { keys } => {
            format!(
                "One press sent {}. Several keys from one control is what an onboard macro looks \
                 like.",
                keys.join(" then ")
            )
        }
        PanelTerminalAnswer::ObservedUnvouched { key } => {
            format!(
                "Pressing this control sent {key}. ksx has not read the board since, so it cannot \
                 confirm that is still what the firmware holds."
            )
        }
        PanelTerminalAnswer::ObservedStale { key, was, now } => {
            // Says WHAT changed. The hashes are carried precisely so this
            // sentence does not have to assert a rewrite in the abstract.
            format!(
                "Pressing this control sent {key}, but the board has been rewritten since: it held \
                 {} when that was recorded and holds {} now.",
                &was[..was.len().min(12)],
                &now[..now.len().min(12)]
            )
        }
        PanelTerminalAnswer::Matched { key } => {
            format!("The board stores {key} here, and pressing the control sent exactly that.")
        }
        PanelTerminalAnswer::Mismatch { stored, observed } => format!(
            "The board stores {} here, but pressing the control sent {}. Something rewrote the \
             board, or that wire does not go where the label says.",
            stored.key.clone().unwrap_or_else(|| stored.label.clone()),
            observed.join(" then ")
        ),
        PanelTerminalAnswer::Resolved { stored, observed } => format!(
            "{} — and pressing the control revealed it sends {}.",
            stored.label,
            observed.join(" then ")
        ),
        PanelTerminalAnswer::Unaccounted { observed } => format!(
            "The board stores nothing here, yet pressing the control sent {}. Nothing in the chart \
             accounts for that, which is what an onboard macro looks like.",
            observed.join(" then ")
        ),
        PanelTerminalAnswer::Declared { key } if key.is_empty() => {
            "You told ksx nothing is wired to this terminal.".to_owned()
        }
        PanelTerminalAnswer::Declared { key } => {
            format!("You told ksx this control sends {key}.")
        }
        PanelTerminalAnswer::DeclaredCompletes { stored, declared } => format!(
            "{}. ksx cannot name that byte; you told ksx this control sends {declared}. Pressing \
             it would turn that into something ksx measured itself.",
            stored.label
        ),
        PanelTerminalAnswer::DeclaredContradicted { declared, stored } if declared.is_empty() => {
            format!(
                "You told ksx nothing is wired here; the board says it stores {}. Both are kept — \
                 you may be right about the wiring even when the firmware disagrees.",
                stored.key.clone().unwrap_or_else(|| stored.label.clone())
            )
        }
        PanelTerminalAnswer::DeclaredContradicted { declared, stored } => format!(
            "You told ksx this control sends {declared}; the board says it stores {}. Both are \
             kept — you may be right about the wiring even when the firmware disagrees.",
            stored.key.clone().unwrap_or_else(|| stored.label.clone())
        ),
        PanelTerminalAnswer::DeclaredUnassigned { .. } => {
            "You declared this terminal unassigned, and the board stores nothing here either. An \
             onboard macro would still look the same — ksx keeps your declaration and stops \
             asking."
                .to_owned()
        }
    }
}

// ── STAGE 5: WHICH SCREW DID THAT PRESS COME FROM? ─────────────────────────

/// **What a press can honestly be filed under, and how strong that is.**
///
/// The learner reports `(device, keys)` and nothing else, because that is all
/// Windows told it. Naming a terminal is a separate judgement made HERE, from
/// a chart, as a pure function — deliberately not a `terminal` field on the
/// learn wire protocol, which would be a field the learner fills with a guess.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PressAttribution {
    /// The terminal this press may be filed under, if exactly one can be named.
    pub terminal_id: Option<String>,
    pub attribution: PanelObservationAttribution,
    /// Every terminal the chart says could have produced these keys. Kept even
    /// when one of them wins, so a surface can show the user what was ruled out
    /// rather than presenting a lone answer it cannot justify.
    pub candidates: Vec<String>,
    /// The chart lists none of these keys on any terminal.
    ///
    /// The board emitted something its own stored bytes do not account for: an
    /// onboard macro, or a chart that went stale between the read and the press.
    /// `docs/ENHANCEMENTS.md` E10's blind spot, arriving as evidence.
    pub unaccounted: bool,
    /// A surface asked for one terminal and the chart names a different one as
    /// the only source of what arrived.
    ///
    /// Not an error and not resolved here: either the wrong control was pressed,
    /// or the wire from that button reaches a screw the silkscreen does not
    /// claim. Both are worth showing and neither is worth guessing between.
    pub prompted_mismatch: bool,
}

/// **Attribute one press, using the chart as the only thing that can name a
/// terminal.**
///
/// `keys` is every canonical key the press produced, in arrival order —
/// `input-test`'s multi-key `seen` set rather than `LearnView`'s single
/// `Option<String>`. Truncating a burst to its first key would file a
/// clean-looking answer and destroy the only evidence of an onboard macro this
/// product can ever obtain.
///
/// `prompted` is the terminal a surface asked the user to press. It is the
/// weakest thing in the room: nothing proves the person pressed the screw the
/// prompt named, which is why it can never produce more than
/// [`PanelObservationAttribution::Prompted`] on its own.
///
/// Only the NORMAL plane is matched. A shifted value is only reachable while
/// the shift terminal is held, and no observation records whether it was — so
/// matching the shifted plane would attribute a press to a terminal on the
/// strength of a condition ksx never measured.
pub fn attribute_press(
    keys: &[String],
    chart: Option<&[ksx_api::PanelTerminalRow]>,
    prompted: Option<&str>,
) -> PressAttribution {
    let prompted_id = prompted.filter(|id| !id.is_empty()).map(str::to_owned);

    // No chart means no terminal vocabulary at all. On an unprofiled board ksx
    // does not know the terminals EXIST, so the caller binds this observation
    // to a control the user drew instead, and the surface says "control".
    let Some(rows) = chart else {
        return PressAttribution {
            terminal_id: prompted_id,
            attribution: PanelObservationAttribution::Prompted,
            ..PressAttribution::default()
        };
    };

    let candidates: Vec<String> = rows
        .iter()
        .filter(|row| {
            observable(&row.normal).is_some_and(|key| keys.iter().any(|seen| seen == key))
        })
        .map(|row| row.terminal_id.clone())
        .collect();

    if candidates.is_empty() {
        return PressAttribution {
            terminal_id: prompted_id,
            attribution: PanelObservationAttribution::Prompted,
            candidates,
            unaccounted: true,
            prompted_mismatch: false,
        };
    }

    // A burst. No single stored byte accounts for several keys, so no terminal
    // in this chart can be the whole story even when one of them matches part
    // of it — the rest came from somewhere the chart cannot see.
    if keys.len() > 1 {
        // `unaccounted` is per-KEY, not all-or-nothing. A burst where one key is
        // held and another is held by nothing is the commonest shape of an
        // onboard macro; reporting it as fully accounted for silenced the one
        // field whose whole purpose is flagging exactly that.
        let stray = keys.iter().any(|seen| {
            !rows
                .iter()
                .any(|row| observable(&row.normal) == Some(seen.as_str()))
        });
        return PressAttribution {
            terminal_id: prompted_id,
            attribution: PanelObservationAttribution::Prompted,
            candidates,
            unaccounted: stray,
            prompted_mismatch: false,
        };
    }

    if candidates.len() > 1 {
        // `input-test`'s own stated limit: two terminals emitting the same key
        // are indistinguishable. The observation is real; the terminal it gets
        // filed under is a guess, and `SharedSignal` is that guess admitting it.
        let terminal_id = prompted_id
            .as_ref()
            .filter(|id| candidates.contains(id))
            .cloned();
        return PressAttribution {
            terminal_id,
            attribution: PanelObservationAttribution::SharedSignal,
            candidates,
            unaccounted: false,
            prompted_mismatch: false,
        };
    }

    let only = candidates[0].clone();
    let prompted_mismatch = prompted_id.is_some_and(|id| id != only);
    PressAttribution {
        terminal_id: Some(only),
        attribution: PanelObservationAttribution::ChartUnique,
        candidates,
        unaccounted: false,
        prompted_mismatch,
    }
}

// ── STAGE 7: SHIFT, SAID ONCE ──────────────────────────────────────────────

/// **Is there a shift key on this board, and does the shifted column mean
/// anything?**
///
/// A property of the BOARD, composed once. Rendering each terminal's raw
/// `shift_state` on 56 rows teaches a reader that shift is a per-terminal
/// setting, and it is not: until exactly one terminal's byte says enabled, every
/// shifted value on the board is unreachable in practice.
///
/// `Opaque` is never counted as "not shift". `PanelTerminalRow`'s own doc says
/// `is_shift == false` alone does not mean disabled, so an opaque byte leaves
/// open that THIS is the shift terminal — which is why the count travels in
/// [`PanelShiftSummary::NoneEnabled`] instead of being silently discarded.
pub fn compose_shift(rows: &[ksx_api::PanelTerminalRow]) -> PanelShiftSummary {
    let enabled: Vec<&ksx_api::PanelTerminalRow> = rows
        .iter()
        .filter(|row| row.shift_state == ksx_api::PanelShiftState::Enabled)
        .collect();

    // Terminals carrying a shifted value the shift key would unlock.
    let shifted = rows
        .iter()
        .filter(|row| observable(&row.shifted).is_some())
        .count();

    match enabled.as_slice() {
        [] if rows.is_empty() => PanelShiftSummary::Unreadable,
        [] => PanelShiftSummary::NoneEnabled {
            stranded: shifted,
            opaque: rows
                .iter()
                .filter(|row| row.shift_state == ksx_api::PanelShiftState::Opaque)
                .count(),
        },
        [only] => PanelShiftSummary::Enabled {
            terminal_id: only.terminal_id.clone(),
            terminal_label: only.terminal_label.clone(),
            reachable: shifted,
        },
        many => PanelShiftSummary::Ambiguous {
            terminal_ids: many.iter().map(|row| row.terminal_id.clone()).collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_value(key: &str) -> PanelKeyValue {
        PanelKeyValue {
            code: 0x04,
            key: Some(key.to_owned()),
            label: key.to_owned(),
            supported: true,
        }
    }

    fn unassigned() -> PanelKeyValue {
        PanelKeyValue {
            code: 0,
            key: None,
            label: "Unassigned".to_owned(),
            supported: true,
        }
    }

    fn vendor(code: u16) -> PanelKeyValue {
        PanelKeyValue {
            code,
            key: None,
            label: format!("Preserved vendor action 0x{code:02X}"),
            supported: false,
        }
    }

    fn unobservable(code: u16) -> PanelKeyValue {
        PanelKeyValue {
            code,
            key: None,
            label: format!("Unobservable HID action 0x{code:02X}"),
            supported: false,
        }
    }

    fn read(normal: PanelKeyValue) -> PanelChartEvidence {
        PanelChartEvidence::Read {
            normal,
            shifted: unassigned(),
            image_sha256: "SHA-A".to_owned(),
            read_at: "2026-08-27T00:00:00Z".to_owned(),
        }
    }

    fn press(keys: &[&str], sha: Option<&str>) -> PanelObservedEvidence {
        PanelObservedEvidence {
            keys: keys.iter().map(|k| (*k).to_owned()).collect(),
            observed_at: "2026-08-27T00:00:00Z".to_owned(),
            device: "USB\\VID_D209&PID_0430\\4".to_owned(),
            against_image_sha256: sha.map(str::to_owned),
            attribution: PanelObservationAttribution::ChartUnique,
            vouching: PanelObservationVouching::Vouched,
        }
    }

    fn facts<'a>(
        chart: &'a PanelChartEvidence,
        observed: Option<&'a PanelObservedEvidence>,
    ) -> TerminalFacts<'a> {
        TerminalFacts {
            terminal_id: "1sw4",
            terminal_label: "Player 1 · Button 4",
            player: 1,
            chart,
            observed,
            declared: None,
            learner_reachable: true,
        }
    }

    /// The chart is the answer when nothing corroborates it.
    #[test]
    fn a_stored_key_is_the_answer_on_its_own() {
        let chart = read(key_value("A"));
        let truth = compose(&facts(&chart, None));
        assert_eq!(
            truth.answer,
            PanelTerminalAnswer::Stored {
                key: "A".to_owned()
            }
        );
        assert!(!truth.invite_press, "a known key needs no press");
    }

    /// **`Matched` needs all three preconditions.** Any one missing and the
    /// chart is still the answer, with the press kept beside it.
    #[test]
    fn matched_needs_the_same_image_a_unique_attribution_and_a_vouch() {
        let chart = read(key_value("A"));

        let truth = compose(&facts(&chart, Some(&press(&["A"], Some("SHA-A")))));
        assert_eq!(
            truth.answer,
            PanelTerminalAnswer::Matched {
                key: "A".to_owned()
            }
        );

        // Same key, but taken against a DIFFERENT image. Two retained strings
        // being equal must never produce a fresh match.
        let stale = press(&["A"], Some("SHA-OLD"));
        assert_eq!(
            compose(&facts(&chart, Some(&stale))).answer,
            PanelTerminalAnswer::Stored {
                key: "A".to_owned()
            }
        );

        // Same image, but the chart held that key on more than one terminal.
        let mut shared = press(&["A"], Some("SHA-A"));
        shared.attribution = PanelObservationAttribution::SharedSignal;
        assert_eq!(
            compose(&facts(&chart, Some(&shared))).answer,
            PanelTerminalAnswer::Stored {
                key: "A".to_owned()
            }
        );

        // Same image and attribution, but nothing stands behind it.
        let mut unproven = press(&["A"], Some("SHA-A"));
        unproven.vouching = PanelObservationVouching::Unproven;
        assert_eq!(
            compose(&facts(&chart, Some(&unproven))).answer,
            PanelTerminalAnswer::Stored {
                key: "A".to_owned()
            }
        );
    }

    /// A fresh press that contradicts a fresh chart is neither source's answer.
    #[test]
    fn a_fresh_disagreement_is_the_answer() {
        let chart = read(key_value("A"));
        let truth = compose(&facts(&chart, Some(&press(&["B"], Some("SHA-A")))));
        assert!(
            matches!(truth.answer, PanelTerminalAnswer::Mismatch { .. }),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.detail.contains("does not go where the label says"),
            "the sentence must name the two ways this happens: {}",
            truth.detail
        );
    }

    /// **E10's blind spot, made visible.** The byte is zero and the control
    /// emitted keys anyway — nothing in the chart accounts for them.
    #[test]
    fn a_silent_byte_that_emits_is_unaccounted_for() {
        let chart = read(unassigned());
        let truth = compose(&facts(&chart, Some(&press(&["A", "B"], Some("SHA-A")))));
        assert_eq!(
            truth.answer,
            PanelTerminalAnswer::Unaccounted {
                observed: vec!["A".to_owned(), "B".to_owned()]
            }
        );
        assert!(truth.detail.contains("onboard macro"));
    }

    /// An unassigned byte is never called "does nothing", and always invites a
    /// press — because a macro'd terminal is byte-identical to it.
    #[test]
    fn an_unassigned_byte_never_claims_the_terminal_is_silent() {
        let chart = read(unassigned());
        let truth = compose(&facts(&chart, None));
        assert_eq!(truth.answer, PanelTerminalAnswer::StoredUnassigned);
        assert!(truth.invite_press);
        assert!(
            truth
                .detail
                .contains("an onboard macro would look exactly the same"),
            "{}",
            truth.detail
        );
    }

    /// A press COMPLETES an unclassifiable byte rather than contradicting it —
    /// the one combination where pressing adds what reading never could.
    #[test]
    fn a_press_resolves_a_byte_ksx_cannot_name() {
        let chart = read(vendor(0xE0));
        let truth = compose(&facts(&chart, Some(&press(&["A"], Some("SHA-A")))));
        assert!(
            matches!(truth.answer, PanelTerminalAnswer::Resolved { .. }),
            "got {:?}",
            truth.answer
        );
    }

    /// **A press cannot resolve an unobservable usage, so it is not offered.**
    /// Both arrive as `supported: false`; only the decoder's own label separates
    /// them, and offering a press that can never succeed is the failure
    /// `BoardRow.pickable` exists to prevent.
    #[test]
    fn an_unobservable_usage_is_never_offered_a_press() {
        let vendor_chart = read(vendor(0xE0));
        assert!(compose(&facts(&vendor_chart, None)).invite_press);

        let unobservable_chart = read(unobservable(0x9A));
        assert!(!compose(&facts(&unobservable_chart, None)).invite_press);
    }

    /// A refused read is not an absence, and it is retryable. An unprofiled
    /// board is a different sentence and is NOT.
    #[test]
    fn a_failed_read_and_an_impossible_one_are_different_sentences() {
        let refused = PanelChartEvidence::Refused {
            code: "panel-interface-busy".to_owned(),
            message: "Another app is using this interface.".to_owned(),
            remedy: Some("close WinIPAC".to_owned()),
        };
        let truth = compose(&facts(&refused, None));
        assert_eq!(truth.answer, PanelTerminalAnswer::ChartRefused);
        assert!(truth.detail.contains("would not answer"));

        let unprofiled = PanelChartEvidence::Unprofiled {
            family_id: "ultimarc-ipac2".to_owned(),
            family_label: "Ultimarc I-PAC 2".to_owned(),
        };
        let truth = compose(&facts(&unprofiled, None));
        assert_eq!(truth.answer, PanelTerminalAnswer::ChartImpossible);
        assert!(
            truth.detail.contains("can never read"),
            "an unreadable model must not be offered a retry: {}",
            truth.detail
        );
    }

    /// On a board with no reader an observation is the answer outright — there
    /// is no "read it again" to nag about.
    #[test]
    fn an_unprofiled_board_trusts_the_press_it_has() {
        let chart = PanelChartEvidence::Unprofiled {
            family_id: "ultimarc-minipac".to_owned(),
            family_label: "Ultimarc Mini-PAC".to_owned(),
        };
        let mut observed = press(&["J"], None);
        observed.attribution = PanelObservationAttribution::Prompted;
        observed.vouching = PanelObservationVouching::Unproven;
        assert_eq!(
            compose(&facts(&chart, Some(&observed))).answer,
            PanelTerminalAnswer::Observed {
                key: "J".to_owned()
            }
        );
    }

    /// One press, several keys: the only sighting of an onboard macro this
    /// product can produce.
    #[test]
    fn several_keys_from_one_press_are_reported_as_several() {
        let chart = PanelChartEvidence::NotAttempted;
        let truth = compose(&facts(&chart, Some(&press(&["A", "B", "C"], None))));
        assert!(
            matches!(truth.answer, PanelTerminalAnswer::ObservedMultiple { .. }),
            "got {:?}",
            truth.answer
        );
        assert!(truth.detail.contains("onboard macro"));
    }

    /// A declaration loses to a chart LOUDLY: both values stay on screen.
    #[test]
    fn a_declaration_is_contradicted_never_corrected() {
        let chart = read(key_value("A"));
        let declared = PanelDeclaredEvidence {
            key: "Z".to_owned(),
            declared_at: "2026-08-20T00:00:00Z".to_owned(),
            against_image_sha256: None,
            note: "I wired this myself".to_owned(),
        };
        let mut f = facts(&chart, None);
        f.declared = Some(&declared);
        let truth = compose(&f);

        assert!(
            matches!(
                truth.answer,
                PanelTerminalAnswer::DeclaredContradicted { .. }
            ),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.declared.is_some(),
            "the losing source must survive being outranked"
        );
        assert!(truth.detail.contains("Both are kept"), "{}", truth.detail);
    }

    fn declared_unassigned() -> PanelDeclaredEvidence {
        PanelDeclaredEvidence {
            key: String::new(),
            declared_at: "2026-08-20T00:00:00Z".to_owned(),
            against_image_sha256: None,
            note: "screw not wired".to_owned(),
        }
    }

    /// **"I know this one is unassigned" is a claim, not a blank.**
    ///
    /// The store accepts an empty declared key on purpose and confirms it
    /// ("Declaration filed … unassigned.") — and then every composition arm
    /// guarded declarations with `!d.key.is_empty()`, so the claim influenced
    /// no answer, no sentence, and no count. These four pin each honest
    /// outcome: agreement with a zero byte, contradiction by a named key,
    /// contradiction by a byte the chart cannot name, and survival on a board
    /// with no chart at all.
    #[test]
    fn an_unassigned_declaration_agreeing_with_a_zero_byte_is_shown_and_stops_the_asking() {
        let chart = read(unassigned());
        let declared = declared_unassigned();
        let mut f = facts(&chart, None);
        f.declared = Some(&declared);
        let truth = compose(&f);

        assert!(
            matches!(truth.answer, PanelTerminalAnswer::DeclaredUnassigned { .. }),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.detail.contains("declared this terminal unassigned"),
            "{}",
            truth.detail
        );
        // The person said no control is wired here: inviting a press would be
        // an offer to press a control they just said does not exist.
        assert!(!truth.invite_press, "{}", truth.detail);
    }

    #[test]
    fn an_unassigned_declaration_is_contradicted_by_a_stored_key() {
        let chart = read(key_value("A"));
        let declared = declared_unassigned();
        let mut f = facts(&chart, None);
        f.declared = Some(&declared);
        let truth = compose(&f);

        assert!(
            matches!(
                truth.answer,
                PanelTerminalAnswer::DeclaredContradicted { .. }
            ),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.detail.contains("nothing is wired"),
            "{}",
            truth.detail
        );
        assert!(truth.detail.contains("Both are kept"), "{}", truth.detail);
    }

    #[test]
    fn an_unassigned_declaration_is_contradicted_by_a_byte_the_chart_cannot_name() {
        let chart = read(vendor(0xE0));
        let declared = declared_unassigned();
        let mut f = facts(&chart, None);
        f.declared = Some(&declared);
        let truth = compose(&f);

        // A byte the chart cannot NAME is still a byte: the board stores
        // something where the person said nothing is wired. Completion is for
        // declarations that say what the byte MEANS, not that it is absent.
        assert!(
            matches!(
                truth.answer,
                PanelTerminalAnswer::DeclaredContradicted { .. }
            ),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.detail.contains("nothing is wired"),
            "{}",
            truth.detail
        );
    }

    #[test]
    fn an_unassigned_declaration_survives_having_no_chart() {
        let chart = PanelChartEvidence::NotAttempted;
        let declared = declared_unassigned();
        let mut f = facts(&chart, None);
        f.declared = Some(&declared);
        let truth = compose(&f);

        assert!(
            matches!(truth.answer, PanelTerminalAnswer::Declared { ref key } if key.is_empty()),
            "got {:?}",
            truth.answer
        );
        assert!(
            truth.detail.contains("nothing is wired"),
            "{}",
            truth.detail
        );
        assert!(!truth.invite_press, "{}", truth.detail);
    }

    /// **No press is offered when nothing can hear it.**
    #[test]
    fn an_unreachable_learner_is_never_offered_a_press() {
        let chart = read(unassigned());
        let mut f = facts(&chart, None);
        f.learner_reachable = false;
        assert!(!compose(&f).invite_press);
    }

    /// Every answer carries a sentence. A surface copies `detail` verbatim, so
    /// an empty one is a blank row.
    #[test]
    fn every_answer_says_something() {
        let charts = [
            PanelChartEvidence::NotAttempted,
            PanelChartEvidence::Unrecognised,
            read(key_value("A")),
            read(unassigned()),
            read(vendor(0xE0)),
        ];
        for chart in &charts {
            for observed in [None, Some(press(&["A"], Some("SHA-A")))] {
                let truth = compose(&facts(chart, observed.as_ref()));
                assert!(
                    !truth.detail.trim().is_empty(),
                    "{:?} produced no sentence",
                    truth.answer
                );
            }
        }
    }

    // ── STAGE 5: ATTRIBUTION ───────────────────────────────────────────────

    fn row(id: &str, normal: PanelKeyValue) -> ksx_api::PanelTerminalRow {
        ksx_api::PanelTerminalRow {
            terminal_id: id.to_owned(),
            terminal_label: id.to_uppercase(),
            player: 1,
            kind: "button".to_owned(),
            normal,
            shifted: unassigned(),
            shift_state: ksx_api::PanelShiftState::Disabled,
            is_shift: false,
            press_resolves: false,
        }
    }

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// A chart holding a key on exactly ONE terminal is the only thing in this
    /// product that can name a screw, and the only route to `Matched`.
    #[test]
    fn one_terminal_holding_the_key_is_the_only_way_to_name_a_screw() {
        let chart = [row("1sw1", key_value("A")), row("1sw2", key_value("B"))];
        let attributed = attribute_press(&keys(&["B"]), Some(&chart), None);

        assert_eq!(attributed.terminal_id.as_deref(), Some("1sw2"));
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::ChartUnique
        );
        assert!(!attributed.unaccounted);
        assert!(!attributed.prompted_mismatch);
    }

    /// `input-test`'s own stated limit, enforced rather than described: two
    /// terminals emitting one key are indistinguishable, so nothing may pick.
    #[test]
    fn two_terminals_sharing_a_key_attribute_to_neither() {
        let chart = [
            row("2sw1", key_value("S")),
            row("2sw2", key_value("S")),
            row("2sw3", key_value("D")),
        ];
        let attributed = attribute_press(&keys(&["S"]), Some(&chart), None);

        assert_eq!(attributed.terminal_id, None, "it picked one anyway");
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::SharedSignal
        );
        assert_eq!(attributed.candidates, ["2sw1", "2sw2"]);
        assert!(!attributed.unaccounted);
    }

    /// A prompt narrows a shared signal to the terminal it named, and the
    /// attribution STAYS `SharedSignal` — a prompt is not evidence about which
    /// screw was pressed, so this must never become the one attribution that
    /// can reach `Matched`.
    #[test]
    fn a_prompt_narrows_a_shared_signal_without_strengthening_it() {
        let chart = [row("2sw1", key_value("S")), row("2sw2", key_value("S"))];
        let attributed = attribute_press(&keys(&["S"]), Some(&chart), Some("2sw2"));

        assert_eq!(attributed.terminal_id.as_deref(), Some("2sw2"));
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::SharedSignal
        );
    }

    /// A prompt that names a terminal the chart does not list among the sources
    /// of that key files nothing under it.
    #[test]
    fn a_prompt_outside_the_candidates_does_not_win() {
        let chart = [row("2sw1", key_value("S")), row("2sw2", key_value("S"))];
        let attributed = attribute_press(&keys(&["S"]), Some(&chart), Some("4coin"));

        assert_eq!(attributed.terminal_id, None);
    }

    /// The board emitted a key its own stored bytes do not account for. E10's
    /// blind spot arriving as evidence — a macro, or a chart gone stale.
    #[test]
    fn a_key_no_terminal_holds_is_unaccounted_for() {
        let chart = [row("1sw1", key_value("A"))];
        let attributed = attribute_press(&keys(&["Z"]), Some(&chart), Some("1sw1"));

        assert!(attributed.unaccounted);
        assert!(attributed.candidates.is_empty());
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::Prompted,
            "an unaccounted key was filed as chart-backed evidence",
        );
    }

    /// One press, several keys. A stored byte is one key, so no terminal in
    /// this chart is the whole story even when one of them matches part of it.
    #[test]
    fn a_burst_is_never_attributed_to_one_terminal_by_the_chart() {
        let chart = [row("1sw1", key_value("A")), row("1sw2", key_value("B"))];
        let attributed = attribute_press(&keys(&["A", "B"]), Some(&chart), Some("1sw1"));

        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::Prompted,
            "a macro burst wore the provenance of a single stored byte",
        );
        assert_eq!(attributed.candidates, ["1sw1", "1sw2"]);
        assert!(!attributed.unaccounted, "the chart does hold these keys");
    }

    /// Both plausible readings are shown; neither is guessed between.
    #[test]
    fn a_prompt_the_chart_contradicts_is_reported_not_resolved() {
        let chart = [row("1sw1", key_value("A")), row("1sw2", key_value("B"))];
        let attributed = attribute_press(&keys(&["A"]), Some(&chart), Some("1sw2"));

        assert_eq!(attributed.terminal_id.as_deref(), Some("1sw1"));
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::ChartUnique
        );
        assert!(attributed.prompted_mismatch);
    }

    /// Bytes ksx cannot name are never candidates. They hold no key to match,
    /// and treating them as a match would attribute a press to a terminal on
    /// the strength of a value ksx explicitly cannot interpret.
    #[test]
    fn unnameable_bytes_are_never_candidates() {
        let chart = [
            row("1sw5", vendor(0xE9)),
            row("1sw6", unobservable(0x66)),
            row("3sw8", unassigned()),
            row("1sw1", key_value("A")),
        ];
        let attributed = attribute_press(&keys(&["A"]), Some(&chart), None);

        assert_eq!(attributed.candidates, ["1sw1"]);
    }

    /// The shifted plane is not matched, and the reason is that no observation
    /// records whether the shift terminal was held when the key arrived.
    #[test]
    fn the_shifted_plane_cannot_attribute_a_press() {
        let mut shifted_only = row("1sw8", unassigned());
        shifted_only.shifted = key_value("Q");
        let chart = [shifted_only];
        let attributed = attribute_press(&keys(&["Q"]), Some(&chart), None);

        assert!(attributed.unaccounted);
        assert!(attributed.candidates.is_empty());
    }

    /// On an unprofiled board ksx does not know the terminals EXIST, so there
    /// is nothing to attribute to and it says so instead of inventing a roster.
    #[test]
    fn with_no_chart_there_is_no_terminal_vocabulary_to_attribute_to() {
        let attributed = attribute_press(&keys(&["A"]), None, Some("control-7"));

        assert_eq!(attributed.terminal_id.as_deref(), Some("control-7"));
        assert_eq!(
            attributed.attribution,
            PanelObservationAttribution::Prompted
        );
        assert!(attributed.candidates.is_empty());
        assert!(
            !attributed.unaccounted,
            "a board with no chart cannot contradict one",
        );
    }

    // ── REGRESSIONS FOUND BY ADVERSARIAL REVIEW ────────────────────────────

    /// **A press that sends the stored key AND MORE is not agreement.**
    ///
    /// This is what an onboard macro looks like on an ASSIGNED terminal, and it
    /// is the one shape `docs/ENHANCEMENTS.md` E10 proves a chart can never see.
    /// The containment test let the chart win and dropped the extra key from the
    /// answer, the sentence and the press offer alike — destroying the only
    /// evidence of the macro ksx will ever hold.
    #[test]
    fn a_burst_containing_the_stored_key_is_still_a_disagreement() {
        let observed = press(&["A", "B"], Some("SHA-A"));
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &read(key_value("A")),
            observed: Some(&observed),
            declared: None,
            learner_reachable: true,
        });

        match &truth.answer {
            PanelTerminalAnswer::Mismatch { observed, .. } => {
                assert_eq!(observed, &["A".to_owned(), "B".to_owned()]);
            }
            other => panic!("the extra key vanished into {other:?}"),
        }
        assert!(truth.detail.contains('B'), "{}", truth.detail);
    }

    /// **"Nothing has confirmed this" is not "the board changed."**
    ///
    /// `Unproven` is the state every stored observation is in until a read
    /// vouches for it, so announcing a rewrite here announced one on every
    /// terminal of every board nobody had re-read — which is every board.
    #[test]
    fn an_unconfirmed_press_does_not_announce_a_rewrite_that_never_happened() {
        let mut observed = press(&["A"], Some("SHA-A"));
        observed.vouching = PanelObservationVouching::Unproven;
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &PanelChartEvidence::NotAttempted,
            observed: Some(&observed),
            declared: None,
            learner_reachable: true,
        });

        assert_eq!(
            truth.answer,
            PanelTerminalAnswer::ObservedUnvouched {
                key: "A".to_owned()
            }
        );
        assert!(
            !truth.detail.contains("has changed"),
            "it claimed a change it never measured: {}",
            truth.detail
        );
    }

    /// A measured rewrite says WHAT changed, using both hashes it carries.
    #[test]
    fn a_measured_rewrite_names_both_images() {
        let mut observed = press(&["A"], Some("SHA-A"));
        observed.vouching = PanelObservationVouching::ChartRewritten {
            was: "AAAAAAAAAAAAAAAA".to_owned(),
            now: "BBBBBBBBBBBBBBBB".to_owned(),
        };
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &PanelChartEvidence::NotAttempted,
            observed: Some(&observed),
            declared: None,
            learner_reachable: true,
        });

        assert!(matches!(
            truth.answer,
            PanelTerminalAnswer::ObservedStale { .. }
        ));
        assert!(truth.detail.contains("AAAAAAAAAAAA"), "{}", truth.detail);
        assert!(truth.detail.contains("BBBBBBBBBBBB"), "{}", truth.detail);
    }

    /// **A read that FAILED cannot vouch for anything.**
    ///
    /// `Vouched` means a read in THIS response proved the board still holds the
    /// image. A refused read is the opposite of that, so a stored `Vouched` must
    /// not ride it to the front of the answer as current truth.
    #[test]
    fn a_refused_read_cannot_vouch_for_a_stored_observation() {
        let observed = press(&["A"], Some("SHA-A"));
        assert_eq!(observed.vouching, PanelObservationVouching::Vouched);
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &PanelChartEvidence::Refused {
                code: "panel-interface-busy".to_owned(),
                message: "another program has the board".to_owned(),
                remedy: None,
            },
            observed: Some(&observed),
            declared: None,
            learner_reachable: true,
        });

        assert_eq!(
            truth.answer,
            PanelTerminalAnswer::ObservedUnvouched {
                key: "A".to_owned()
            },
            "a failed read vouched for an observation",
        );
    }

    /// **Corroboration must not hide a contradiction.**
    ///
    /// Adding a press that AGREES with the firmware made ksx stop reporting that
    /// the user's own declaration disagreed with it.
    #[test]
    fn a_press_that_agrees_with_the_chart_does_not_bury_the_declaration() {
        let observed = press(&["A"], Some("SHA-A"));
        let declared = PanelDeclaredEvidence {
            key: "Z".to_owned(),
            declared_at: "2026-08-27T00:00:00Z".to_owned(),
            against_image_sha256: None,
            note: "I wired this myself".to_owned(),
        };
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &read(key_value("A")),
            observed: Some(&observed),
            declared: Some(&declared),
            learner_reachable: true,
        });

        assert!(
            matches!(
                truth.answer,
                PanelTerminalAnswer::DeclaredContradicted { .. }
            ),
            "the contradiction vanished into {:?}",
            truth.answer
        );
        // And the press that caused it to vanish is still on the record.
        assert!(truth.observed.is_some());
    }

    /// ksx must not say what an unidentified board's model can "never" do.
    #[test]
    fn an_unrecognised_board_is_not_told_what_its_model_can_never_do() {
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw1",
            terminal_label: "P1 SW1",
            player: 1,
            chart: &PanelChartEvidence::Unrecognised,
            observed: None,
            declared: None,
            learner_reachable: true,
        });

        assert_eq!(truth.answer, PanelTerminalAnswer::ChartUnknownBoard);
        assert!(
            !truth.detail.contains("never"),
            "it made a claim about a model it has not identified: {}",
            truth.detail
        );
        assert!(truth.invite_press, "the only way to learn this one");
    }

    /// A byte no learner can hear must not be answered with "press it".
    #[test]
    fn an_unobservable_byte_is_never_answered_with_press_it() {
        let truth = compose(&TerminalFacts {
            terminal_id: "1sw6",
            terminal_label: "P1 SW6",
            player: 1,
            chart: &read(unobservable(0x66)),
            observed: None,
            declared: None,
            learner_reachable: true,
        });

        assert!(!truth.invite_press);
        assert!(
            !truth.detail.contains("only way to find out"),
            "the sentence re-issued the offer the flag suppressed: {}",
            truth.detail
        );
        // `label` already ends in the byte; printing it again read as "0x66 (0x66)".
        assert_eq!(truth.detail.matches("0x66").count(), 1, "{}", truth.detail);
    }

    /// A burst where ONE key is held and another is held by nothing is the
    /// commonest shape of a macro, and the field that exists to flag it said
    /// nothing.
    #[test]
    fn a_partly_unaccounted_burst_is_flagged() {
        let chart = [row("1sw1", key_value("A"))];
        let attributed = attribute_press(&keys(&["A", "Z"]), Some(&chart), None);

        assert!(
            attributed.unaccounted,
            "the board emitted Z and nothing in the chart holds it",
        );
        assert_eq!(attributed.candidates, ["1sw1"]);
    }

    /// **A chart that cannot name a byte does not contradict a declaration.**
    ///
    /// Found by running the verb on a real I-PAC 4X: `2coin` holds vendor byte
    /// 0xE0, a declaration was filed and stored, and the composed answer showed
    /// no sign of it — the contradiction arm needs a key to disagree WITH, so a
    /// declaration against an unnameable byte fell through to the chart's own
    /// "I cannot say". The person typed it in and saw nothing.
    #[test]
    fn a_declaration_completes_a_byte_the_chart_cannot_name() {
        let declared = PanelDeclaredEvidence {
            key: "F11".to_owned(),
            declared_at: "2026-08-27T00:00:00Z".to_owned(),
            against_image_sha256: None,
            note: String::new(),
        };
        let truth = compose(&TerminalFacts {
            terminal_id: "2coin",
            terminal_label: "Player 2 · Coin",
            player: 2,
            chart: &read(vendor(0xE0)),
            observed: None,
            declared: Some(&declared),
            learner_reachable: true,
        });

        match &truth.answer {
            PanelTerminalAnswer::DeclaredCompletes { declared, stored } => {
                assert_eq!(declared, "F11");
                // The byte is still there. A declaration never replaces what the
                // firmware holds; it says what the person knows about it.
                assert_eq!(stored.code, 0xE0);
            }
            other => panic!("the declaration was dropped from the answer: {other:?}"),
        }
        assert!(truth.detail.contains("F11"), "{}", truth.detail);
        assert!(
            truth.invite_press,
            "a press would turn a claim into a measurement",
        );

        // An unassigned byte is the same case: zero is indistinguishable from a
        // macro, so a declaration there is additive too, not contradicted.
        let silent = compose(&TerminalFacts {
            chart: &read(unassigned()),
            ..TerminalFacts {
                terminal_id: "3sw8",
                terminal_label: "Player 3 · Button 8",
                player: 3,
                chart: &read(unassigned()),
                observed: None,
                declared: Some(&declared),
                learner_reachable: true,
            }
        });
        assert!(matches!(
            silent.answer,
            PanelTerminalAnswer::DeclaredCompletes { .. }
        ));
    }
}
