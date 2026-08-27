//! **The verb that makes a read, a press and a typed-in claim one answer.**
//!
//! `panel_truth` composes; `panel_observations` stores; this module is the only
//! thing that does IO on their behalf, and it exists so neither of them has to.
//! That split is not decoration: it is why the precedence rules and the store's
//! revision handling are both testable in CI without a cabinet, and why a
//! reviewer can read the rule that decides `Matched` without reading a HID
//! transaction.
//!
//! # Why every answer starts with a read
//!
//! Stored evidence is filed under a board fingerprint and a terminal signature,
//! and a chart read is what establishes both. Skipping the read would leave
//! nothing to look the stored rows up BY — and on a board with no measured
//! protocol, no terminal vocabulary to hang them on either. So a read is
//! attempted first, always.
//!
//! A read that refuses is not a failure of this verb. It composes to a view
//! with zero terminal rows and the refusal in `notes`, which is the honest
//! answer: ksx does not know this board's terminals, and says so instead of
//! rendering 56 rows it invented.

use ksx_api::{PanelChartEvidence, PanelChartSpec, PanelTruthSpec, PanelTruthView, Refusal};

use crate::panel_observations::{self, PanelBoardScope};
use crate::panel_truth::{self, TerminalFacts};

/// Compose everything ksx knows about one board's terminals.
///
/// The refusal path returns `Ok`, not `Err`: "the configuration interface is
/// busy" is a state of the answer, not an absence of one, and a caller that got
/// `Err` here would have nothing to render but a dead end.
pub fn truth(spec: &PanelTruthSpec, learner_reachable: bool) -> Result<PanelTruthView, Refusal> {
    let read = crate::panel_programming::chart(&PanelChartSpec {
        device: spec.device.clone(),
        // Never true here. A backup read reconciles the transaction journal and
        // can advance this board's write-qualification state, and composing an
        // answer must not move write-safety state.
        backup: false,
    });

    let chart = match read {
        Ok(chart) => chart,
        Err(refusal) => {
            return Ok(PanelTruthView {
                notes: vec![refusal.message.clone(), refusal.remedy.clone().unwrap_or_default()]
                    .into_iter()
                    .filter(|line| !line.is_empty())
                    .collect(),
                ..PanelTruthView::default()
            });
        }
    };

    let scope = PanelBoardScope {
        board_fingerprint: chart.board_fingerprint.clone(),
        terminal_signature: crate::panel_programming::ipac4_terminal_signature(),
    };

    // A store that cannot be read is not a reason to withhold the chart. The
    // rows simply carry no observation, which composes to the chart's own
    // answer — the same answer a board nobody has taught yet produces.
    let stored = panel_observations::observations(&scope).ok();

    let mut terminals = Vec::with_capacity(chart.terminals.len());
    for row in &chart.terminals {
        let saved = stored.as_ref().and_then(|view| {
            view.terminals
                .iter()
                .find(|candidate| candidate.terminal_id == row.terminal_id)
        });
        let evidence = PanelChartEvidence::Read {
            normal: row.normal.clone(),
            shifted: row.shifted.clone(),
            image_sha256: chart.image_sha256.clone(),
            read_at: chart.generated_at.clone(),
        };
        terminals.push(panel_truth::compose(&TerminalFacts {
            terminal_id: &row.terminal_id,
            terminal_label: &row.terminal_label,
            player: row.player,
            chart: &evidence,
            observed: saved.and_then(|row| row.observed.as_ref()),
            declared: saved.and_then(|row| row.declared.as_ref()),
            learner_reachable,
        }));
    }

    Ok(PanelTruthView {
        board_name: chart.board_name.clone(),
        board_fingerprint: chart.board_fingerprint.clone(),
        image_sha256: Some(chart.image_sha256.clone()),
        read_at: Some(chart.generated_at.clone()),
        shift: panel_truth::compose_shift(&chart.terminals),
        terminals,
        notes: chart.notes.clone(),
    })
}

/// How many terminals in a composed view still have no answer at all.
///
/// Serving the count rather than letting each surface derive it keeps one
/// definition of "unknown": a terminal ksx cannot name is not the same as one
/// nobody has taught, and only the composed answer knows which is which.
pub fn unknown_count(view: &PanelTruthView) -> usize {
    view.terminals
        .iter()
        .filter(|terminal| {
            matches!(
                terminal.answer,
                ksx_api::PanelTerminalAnswer::Unknown
                    | ksx_api::PanelTerminalAnswer::StoredUnassigned
                    | ksx_api::PanelTerminalAnswer::StoredUnclassified { .. }
            )
        })
        .count()
}

/// `ksx panel truth` — read the board, then say what ksx knows and how.
///
/// Exit codes match the rest of the panel group: 0 composed, 2 refused. A
/// refusal here is the same shape a refusal from `chart` is, because it IS one:
/// this verb cannot begin without a read.
pub fn run_truth(device: Option<String>, json: bool) -> anyhow::Result<()> {
    let spec = PanelTruthSpec { device };
    let view = match truth(&spec, true) {
        Ok(view) => view,
        Err(refusal) => {
            eprintln!("{}", refusal.message);
            if let Some(remedy) = &refusal.remedy {
                eprintln!("{remedy}");
            }
            std::process::exit(2);
        }
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&view)?);
        return Ok(());
    }

    if view.terminals.is_empty() {
        // Zero rows is an answer, not an empty report: ksx does not know this
        // board's terminals, and inventing 56 named rows for a board with no
        // measured protocol would be fabricated hardware.
        println!("ksx has no terminal-by-terminal answer for this board.");
        for note in &view.notes {
            println!("  {note}");
        }
        return Ok(());
    }

    println!("{}", view.board_name);
    if let Some(image) = &view.image_sha256 {
        println!("  read proof  {}", &image[..image.len().min(16)]);
    }
    println!("  shift       {}", shift_line(&view.shift));
    println!(
        "  unresolved  {} of {} terminals",
        unknown_count(&view),
        view.terminals.len()
    );
    println!();
    for terminal in &view.terminals {
        println!(
            "  {:<8} {:<12} {}",
            terminal.terminal_id, terminal.terminal_label, terminal.detail
        );
    }
    for note in &view.notes {
        println!("\n{note}");
    }
    Ok(())
}

/// The board-level shift sentence, said once — never per terminal.
fn shift_line(shift: &ksx_api::PanelShiftSummary) -> String {
    match shift {
        ksx_api::PanelShiftSummary::Unreadable => {
            "not readable on this board".to_owned()
        }
        ksx_api::PanelShiftSummary::Enabled {
            terminal_label,
            reachable,
            ..
        } => format!("{terminal_label} is the Shift key ({reachable} shifted values reachable)"),
        ksx_api::PanelShiftSummary::NoneEnabled { stranded, opaque } => format!(
            "no terminal says it is the Shift key, so {stranded} shifted value(s) are unreachable \
             ({opaque} shift byte(s) could not be classified, so one of those could still be it)"
        ),
        ksx_api::PanelShiftSummary::Ambiguous { terminal_ids } => format!(
            "more than one terminal claims to be the Shift key ({}); ksx cannot say which the \
             board honours",
            terminal_ids.join(", ")
        ),
    }
}
