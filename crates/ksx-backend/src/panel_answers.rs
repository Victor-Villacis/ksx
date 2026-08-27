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
/// A refused read is a refusal, `Err` — the same shape `declare` and `forget`
/// give the identical selector or busy interface, and the shape both this
/// module's own doc and the CLI help promise ("2 = refused"). This first
/// shipped returning `Ok` with the refusal folded into `notes` on the theory
/// that a refusal is "a state of the answer" — but the view it composed had
/// empty board identity and zero terminals, so a typo'd `--device` exited 0
/// as a successful compose while `declare` exited 2 for the same typo, and
/// the documented exit 2 was dead code. The "compose stored evidence without
/// a read" idea it gestured at cannot work today anyway: the observation
/// store is keyed by the fingerprint only a read can produce.
pub fn truth(spec: &PanelTruthSpec, learner_reachable: bool) -> Result<PanelTruthView, Refusal> {
    let chart = crate::panel_programming::chart(&PanelChartSpec {
        device: spec.device.clone(),
        // Never true here. A backup read reconciles the transaction journal and
        // can advance this board's write-qualification state, and composing an
        // answer must not move write-safety state.
        backup: false,
    })?;

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
            "  {:<8}  {:<22}  {}",
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
        ksx_api::PanelShiftSummary::Unreadable => "not readable on this board".to_owned(),
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

/// **Read the board, and return the scope its stored facts are filed under.**
///
/// Every mutation starts here for the reason every answer does: a document is
/// keyed by board fingerprint AND terminal signature, and only a read
/// establishes either. It also proves the terminal exists before anything is
/// written under its name — a typo would otherwise create a durable row for a
/// screw that is not on this board.
fn scope_for(device: Option<String>, terminal_id: &str) -> Result<ScopeRead, Refusal> {
    let chart = crate::panel_programming::chart(&PanelChartSpec {
        device,
        backup: false,
    })?;
    if !chart
        .terminals
        .iter()
        .any(|row| row.terminal_id == terminal_id)
    {
        return Err(Refusal::with_remedy(
            ksx_api::codes::BAD_REQUEST,
            format!("this board has no terminal called '{terminal_id}'"),
            "run `ksx panel chart` to see this board's terminals",
        ));
    }
    Ok(ScopeRead {
        scope: PanelBoardScope {
            board_fingerprint: chart.board_fingerprint.clone(),
            terminal_signature: crate::panel_programming::ipac4_terminal_signature(),
        },
        image_sha256: chart.image_sha256,
    })
}

struct ScopeRead {
    scope: PanelBoardScope,
    image_sha256: String,
}

/// `ksx panel declare` — type in what a terminal sends, and lock it in.
///
/// **The claim ksx did not obtain itself**, and it is kept as exactly that: it
/// never outranks a chart read or a press, it is never promoted to `Matched` by
/// agreeing with one, and a later read that disagrees produces a contradiction
/// with BOTH values shown rather than a silent correction. The user may know the
/// wire from that button reaches a different screw than the silkscreen claims,
/// which is a fact about the cabinet rather than the firmware.
pub fn run_declare(
    device: Option<String>,
    terminal: String,
    key: String,
    note: String,
    json: bool,
) -> anyhow::Result<()> {
    let read = match scope_for(device, &terminal) {
        Ok(read) => read,
        Err(refusal) => return refuse(refusal),
    };

    // The store requires the exact revision the caller last saw, so a
    // declaration can never silently replace one written since. A board with
    // nothing stored yet has no revision, and that is not a stale write.
    let held = panel_observations::observations(&read.scope)
        .map(|view| view.revision)
        .unwrap_or_default();

    let outcome = panel_observations::declare(&panel_observations::PanelDeclareSpec {
        scope: read.scope,
        terminal_id: terminal,
        expected_revision: (!held.is_empty()).then_some(held),
        key,
        against_image_sha256: Some(read.image_sha256),
        note,
    });
    report(outcome, json)
}

/// `ksx panel forget` — drop what the caller names, and nothing else.
///
/// The undo for `declare`, and the only way a press is ever removed. Deleting
/// evidence is always the user's explicit instruction: nothing in ksx prunes
/// these rows on its own.
pub fn run_forget(
    device: Option<String>,
    terminal: String,
    observed: bool,
    declared: bool,
    json: bool,
) -> anyhow::Result<()> {
    let read = match scope_for(device, &terminal) {
        Ok(read) => read,
        Err(refusal) => return refuse(refusal),
    };
    let held = match panel_observations::observations(&read.scope) {
        Ok(view) => view.revision,
        Err(refusal) => return refuse(refusal),
    };

    let outcome = panel_observations::forget(&panel_observations::PanelForgetSpec {
        scope: read.scope,
        terminal_id: terminal,
        expected_revision: held,
        // Neither flag means both: "forget this terminal" is the whole row.
        forget_observed: observed || !declared,
        forget_declared: declared || !observed,
    });
    report(outcome, json)
}

fn report(
    outcome: Result<panel_observations::PanelObservationMutationView, Refusal>,
    json: bool,
) -> anyhow::Result<()> {
    match outcome {
        Ok(view) => {
            if json {
                println!("{}", serde_json::to_string_pretty(&view)?);
            } else {
                println!("{}", view.summary);
                println!("  revision {}", view.revision);
            }
            Ok(())
        }
        Err(refusal) => refuse(refusal),
    }
}

fn refuse(refusal: Refusal) -> anyhow::Result<()> {
    eprintln!("{}", refusal.message);
    if let Some(remedy) = &refusal.remedy {
        eprintln!("{remedy}");
    }
    std::process::exit(2);
}
