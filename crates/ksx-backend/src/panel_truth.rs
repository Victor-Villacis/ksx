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
    PanelObservationVouching, PanelObservedEvidence, PanelTerminalAnswer, PanelTerminalTruth,
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
                if fresh && !o.keys.is_empty() && !o.keys.iter().any(|k| k == stored) {
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
    if let Some(o) = observed.filter(|o| !o.keys.is_empty()) {
        if o.keys.len() > 1 {
            return PanelTerminalAnswer::ObservedMultiple {
                keys: o.keys.clone(),
            };
        }
        let key = o.keys[0].clone();
        // On a board with no reader, "unvouched" is permanent and saying so
        // every time would be nagging about a button that does not exist.
        let vouched = never_vouchable
            || matches!(
                o.vouching,
                PanelObservationVouching::Vouched | PanelObservationVouching::NeverVouchable
            );
        return if vouched {
            PanelTerminalAnswer::Observed { key }
        } else {
            PanelTerminalAnswer::ObservedUnvouched { key }
        };
    }
    if let Some(d) = declared.filter(|d| !d.key.is_empty()) {
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
            match (facts.declared, &chart_answer) {
                (Some(d), PanelTerminalAnswer::Stored { key })
                    if !d.key.is_empty() && &d.key != key =>
                {
                    PanelTerminalAnswer::DeclaredContradicted {
                        declared: d.key.clone(),
                        stored: normal.clone(),
                    }
                }
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
        PanelChartEvidence::Unprofiled { .. } | PanelChartEvidence::Unrecognised => {
            match without_chart(facts.observed, facts.declared, true) {
                PanelTerminalAnswer::Unknown => PanelTerminalAnswer::ChartImpossible,
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
        PanelTerminalAnswer::StoredUnclassified { label, .. } => !label.contains("Unobservable"),
        PanelTerminalAnswer::StoredUnassigned
        | PanelTerminalAnswer::ChartImpossible
        | PanelTerminalAnswer::ChartRefused
        | PanelTerminalAnswer::Unknown
        | PanelTerminalAnswer::Declared { .. } => true,
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
        PanelTerminalAnswer::StoredUnclassified { code, label } => {
            format!(
                "{label} (0x{code:02X}). ksx keeps this byte exactly as it found it and cannot say \
                 what it does; pressing the control is the only way to find out."
            )
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
                "Pressing this control sent {key}, but the board has changed since — so that may \
                 no longer be true."
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
        PanelTerminalAnswer::Declared { key } => {
            format!("You told ksx this control sends {key}.")
        }
        PanelTerminalAnswer::DeclaredContradicted { declared, stored } => format!(
            "You told ksx this control sends {declared}; the board says it stores {}. Both are \
             kept — you may be right about the wiring even when the firmware disagrees.",
            stored.key.clone().unwrap_or_else(|| stored.label.clone())
        ),
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
}
