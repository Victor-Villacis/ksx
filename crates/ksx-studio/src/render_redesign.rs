//! `/redesign` — the transplant rebuild's blank workbench.
//!
//! The whole viewport is the pan/zoom canvas plus the minimap and the camera
//! verbs, and deliberately nothing else: pieces of the shipped product arrive
//! here one at a time, copied from the living pages, and are re-homed as
//! encapsulated widgets. The seam starts with exactly two scalars — the
//! machine-provenance chip — so the lane can never be mistaken for the
//! cabinet; every field the transplants need joins this seam the way every
//! ksx page composes: server-worded, island-copied.

use forma_ir::parser::IrModule;
use forma_ir::slot::{SlotData, SlotValue};
use forma_server::{render_page, PageConfig, PageOutput, RenderMode};

use crate::render::{body_prefix_no_refresh, with_icon_links, EmbeddedPage, PERSONALITY_CSS};
use crate::render_workbench::{device_row, mode_row, named_slot_ids, other_row};
use crate::snapshot::{
    compose_board_panel_for_source, selected_source_view, theme_rows, NocturneChoiceRow,
    RedesignCaptureState, RedesignControllers, RedesignDeviceRows, RedesignJourney,
    RedesignOperationalState, RedesignPayload, RedesignPersonaRow, SetupSnapshot, StartCaptureView,
};

/// The island table this page compiles to: exactly one island — the whole
/// screen. Its name is the `activateIslands` registry key in
/// `studio-ui/src/redesign.ts`.
#[cfg(test)]
const ISLAND_COMPONENT: &str = "RedesignIsland";

/// Bare-named slots this page renders and the seam deliberately never fills.
/// EMPTY, and that is the claim.
#[cfg(test)]
const CLIENT_ONLY_SLOTS: [&str; 0] = [];

/// Anonymous (`attr:`/`text:`) slots this page compiles to. EMPTY — every
/// attribute value and every text child is either a named signal binding or
/// static markup.
#[cfg(test)]
const ANONYMOUS_SLOTS: [&str; 0] = [];

const STAGING_UNAVAILABLE: &str = "Staging unavailable — the ksx background helper is not \
    answering. Staging status can't be confirmed; close and reopen ksx to check.";

/// Every already-collected truth needed to compose the redesign payload.
///
/// Keeping this seam named matters: setup, scan, staging and session are
/// separate authorities, while the final four fields are only view state.
/// A positional argument list made those boundaries easy to swap and grew a
/// new parameter every time the workbench gained a block.
pub(crate) struct PayloadInput<'a> {
    pub(crate) environment: &'a ksx_api::RuntimeEnvironmentView,
    pub(crate) setup: Option<ksx_api::SetupView>,
    pub(crate) setup_error: &'a str,
    pub(crate) scan: Result<ksx_api::DeviceScanView, String>,
    pub(crate) staged: &'a ksx_api::StagedSetupView,
    pub(crate) session: &'a crate::control::SessionView,
    pub(crate) outputs: &'a ksx_api::ControllerOutputsView,
    pub(crate) selected_slot: Option<u8>,
    pub(crate) selected_source: Option<&'a str>,
    pub(crate) undo_label: Option<&'a str>,
    pub(crate) macro_selected: Option<&'a str>,
    pub(crate) q: Option<&'a str>,
}

/// Resolve a source-qualified learn target only when the inventory proves a
/// one-to-one selector → board → Windows keyboard instance relationship.
/// Identical-board ambiguity removes the action; taking the first match could
/// arm capture against a different physical keyboard than the selected row.
fn exact_learn_identity(
    staged: &ksx_api::StagedSetupView,
    scan: &ksx_api::DeviceScanView,
    device: &ksx_api::StagedDeviceView,
) -> Option<StartCaptureView> {
    if !staged.reachable {
        return None;
    }
    let mut matches = scan.boards.iter().filter(|board| {
        board
            .selector
            .as_deref()
            .is_some_and(|selector| selector == device.selector)
    });
    let board = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let instance_id = board.keyboard.as_ref()?;
    if scan
        .boards
        .iter()
        .flat_map(|candidate| candidate.interfaces.iter())
        .filter(|row| row.instance_id.eq_ignore_ascii_case(instance_id))
        .count()
        != 1
    {
        return None;
    }
    let mut view = StartCaptureView::default();
    view.expected_selector.clone_from(&device.selector);
    view.instance_id.clone_from(instance_id);
    Some(view)
}

/// Compose the payload from the environment the source reports — the same
/// wording rule the nocturne derived block uses, copied so the two chips can
/// never disagree about what a fixture looks like. `setup` is the same
/// `machine_cache.setup_state` read `page_theme` stamps the page from, so the
/// menu's marked row and the `<html data-theme>` stamp derive from one truth.
pub(crate) fn payload(input: PayloadInput<'_>) -> RedesignPayload {
    let PayloadInput {
        environment,
        setup,
        setup_error,
        scan,
        staged,
        session,
        outputs,
        selected_slot,
        selected_source,
        undo_label,
        macro_selected,
        q,
    } = input;
    // Borrowed BEFORE the payload construction consumes its owner: the
    // scan boards, for the keyboard title's transport word.
    let scan_boards: &[ksx_api::BoardRow] = match &scan {
        Ok(scan) => scan.boards.as_slice(),
        Err(_) => &[],
    };
    let mut devices = match &scan {
        Ok(scan) if !staged.devices.is_empty() => {
            RedesignDeviceRows::of_devices(Some(scan), "", &staged.devices)
        }
        Ok(scan) => RedesignDeviceRows::of(
            Some(scan),
            "",
            staged
                .device
                .as_ref()
                .map(|device| device.selector.as_str()),
        ),
        Err(unavailable) if !staged.devices.is_empty() => {
            RedesignDeviceRows::of_devices(None, unavailable, &staged.devices)
        }
        Err(unavailable) => RedesignDeviceRows::of(
            None,
            unavailable,
            staged
                .device
                .as_ref()
                .map(|device| device.selector.as_str()),
        ),
    };
    // Is the staged input an arcade encoder? The nocturne rule: the staged
    // selector sits in the picker's ENCODER tier. It reword's the capture
    // rows (wired buttons, not typing) and lets the board resolution offer
    // the panel fallbacks.
    let exact_source_requested = selected_source.is_some_and(|source| !source.trim().is_empty());
    let selected_device = selected_source
        .map(str::trim)
        .filter(|selector| !selector.is_empty())
        .and_then(|selector| {
            staged
                .devices
                .iter()
                .find(|device| device.selector.eq_ignore_ascii_case(selector))
        })
        .or_else(|| {
            (!exact_source_requested)
                .then_some(staged.device.as_ref())
                .flatten()
        });
    let encoder_staged = selected_device.is_some_and(|device| {
        devices
            .encoders
            .iter()
            .any(|row| row.selector.eq_ignore_ascii_case(&device.selector))
    });
    let (capture_rows, capture_note) =
        crate::snapshot::compose_capture_rows(staged, encoder_staged);
    let (scan_read, scan_error) = match &scan {
        Ok(scan) => (Some(scan), ""),
        Err(error) => (None, error.as_str()),
    };
    let capture = RedesignCaptureState::of(staged, scan_read, scan_error);
    for row in devices
        .keyboards
        .iter_mut()
        .chain(devices.encoders.iter_mut())
        .chain(devices.experimental.iter_mut())
    {
        row.capture_cls = "rd-dev-capturechip none".to_owned();
        let capture_badge =
            crate::snapshot::staged_device_capture_mode(staged, scan_read, &row.selector).and_then(
                |mode| match mode {
                    "prepare" => Some(("Preparation required", "attention")),
                    "release" => Some(("Prepared", "ready")),
                    "ready" | "prepare-optional" => Some(("Ready", "ready")),
                    "held" | "blocked" => Some(("Needs attention", "attention")),
                    _ => None,
                },
            );
        if let Some((label, state)) = capture_badge {
            row.capture_badge = label.to_owned();
            row.capture_state = state.to_owned();
            row.capture_cls = "rd-dev-capturechip".to_owned();
        }
    }
    let operations = RedesignOperationalState::of(
        staged,
        setup.as_ref(),
        setup_error,
        session,
        outputs,
        &capture,
    );
    let journey = RedesignJourney::of(staged, session, &capture, &operations.play);
    // The staged input's verified identity, off the SAME capture composition
    // nocturne pins its learn flow to (selector + Windows instance path).
    // Refused scan → empty pair → the mapper refuses to arm, like 4460.
    let learn_cap = match (&scan, selected_device) {
        (Ok(scan_view), Some(device)) => {
            let exact = exact_learn_identity(staged, scan_view, device);
            match exact {
                Some(view) => view,
                None if exact_source_requested => StartCaptureView::default(),
                None => StartCaptureView::from_parts(staged, scan_view, true),
            }
        }
        _ => StartCaptureView::from_parts(staged, &ksx_api::DeviceScanView::default(), false),
    };
    devices.staging_reachable = staged.reachable;
    devices.staging_line = if staged.reachable {
        String::new()
    } else {
        STAGING_UNAVAILABLE.to_owned()
    };
    if !staged.reachable {
        devices.scan_line = if devices.scan_line.trim().is_empty() {
            STAGING_UNAVAILABLE.to_owned()
        } else {
            format!("{} · {STAGING_UNAVAILABLE}", devices.scan_line)
        };
    }
    let controllers = RedesignControllers::of_source(
        staged,
        selected_slot,
        selected_source,
        undo_label,
        macro_selected,
        q,
    );
    let resolved_source = controllers.source.clone();
    RedesignPayload {
        environment_id: environment.id.clone(),
        environment_generation: environment.generation.clone(),
        environment_fixture: environment.fixture,
        environment_label: environment.label.clone(),
        environment_cls: if environment.fixture {
            "n-environment fixture"
        } else if environment.id == "live-machine" {
            "n-environment live"
        } else {
            "n-environment unknown"
        }
        .to_owned(),
        studio_version: env!("CARGO_PKG_VERSION").to_owned(),
        source: resolved_source,
        // The picker's truth. `Err` carries the refusal's sentence (with its
        // remedy — the `/devices` composition), so a refused read renders as
        // one line over an empty picker, never as an empty machine.
        devices,
        // The ONE shared `theme_rows` composer, re-dressed as choice rows, so
        // the compact and expanded menus cannot mark different rows for the
        // same config.
        theme_rows: theme_rows(&SetupSnapshot {
            available: setup.is_some(),
            source: String::new(),
            view: setup.unwrap_or_default(),
        })
        .into_iter()
        .map(|row| NocturneChoiceRow {
            // `theme_rows` already made this decision; it spelled it
            // only in the class, which is why it could not be spoken.
            chosen: row.chosen_cls.split_whitespace().any(|c| c == "on"),
            name: row.value,
            title: row.title,
            detail: row.detail,
            cls: row.chosen_cls,
        })
        .collect(),
        // The staged controllers and the persona picker, off the SAME staged
        // view the device marking reads — one truth per render.
        controllers,
        // The keyboard widget, off the ONE shared board composer. The board
        // picture is ALWAYS the standard keyboard on this page (Victor,
        // 2026-08-29): a keyboard looks like a keyboard, and a saved panel
        // choice in config.toml must not morph it here. Alternate pictures
        // stay a 4460 affair until an "advanced" home earns its place.
        board: {
            let selected = selected_slot
                .and_then(|number| staged.slots.iter().find(|slot| slot.number == number))
                .or_else(|| staged.slots.first());
            let source =
                selected.and_then(|slot| selected_source_view(staged, slot, selected_source));
            let resolved = crate::board::Board::resolve("", &[], &[], false);
            let transport_selector = source
                .as_ref()
                .map(|source| source.selector.as_str())
                .or_else(|| {
                    staged
                        .device
                        .as_ref()
                        .map(|device| device.selector.as_str())
                });
            let transport = transport_selector.and_then(|source_selector| {
                scan_boards
                    .iter()
                    .find(|b| {
                        b.selector
                            .as_deref()
                            .is_some_and(|selector| selector.eq_ignore_ascii_case(source_selector))
                    })
                    .map(|b| b.transport_label.as_str())
            });
            compose_board_panel_for_source(
                staged,
                selected,
                source.as_ref(),
                &resolved,
                "",
                &[],
                &[],
                encoder_staged,
                transport,
                "",
                "",
            )
        },
        capture_rows,
        capture_note,
        learn_selector: learn_cap.expected_selector,
        learn_instance: learn_cap.instance_id,
        operations,
        capture,
        journey,
    }
}

/// The served lists this page renders: the topbar theme menu's rows and the
/// device picker's four tiers. The names are the compiler's stable list-slot
/// convention and are asserted against the embedded IR below.
const LIST_SLOT_THEME_ROWS: &str = "list:rdThemeRows:array";
const LIST_SLOT_COMPACT_THEME_ROWS: &str = "list:rdCompactThemeRows:array";
const LIST_SLOT_DEV_KB: &str = "list:rdDevKb:array";
const LIST_SLOT_DEV_ENC: &str = "list:rdDevEnc:array";
const LIST_SLOT_DEV_EXP: &str = "list:rdDevExp:array";
const LIST_SLOT_DEV_OTHER: &str = "list:rdDevOther:array";
// The keyboard widget's served lists: the six plate rows, the off-board
// tray, the legend and the board-picker roster (the nocturne plate's own
// slot shapes).
const LIST_SLOT_KB_ROW1: &str = "list:rdKbRow1:array";
const LIST_SLOT_KB_ROW2: &str = "list:rdKbRow2:array";
const LIST_SLOT_KB_ROW3: &str = "list:rdKbRow3:array";
const LIST_SLOT_KB_ROW4: &str = "list:rdKbRow4:array";
const LIST_SLOT_KB_ROW5: &str = "list:rdKbRow5:array";
const LIST_SLOT_KB_ROW6: &str = "list:rdKbRow6:array";
const LIST_SLOT_KB_TRAY: &str = "list:rdKbTray:array";
const LIST_SLOT_KB_LEGEND: &str = "list:rdKbLegend:array";
const LIST_SLOT_CAPTURE_ROWS: &str = "list:rdCaptureRows:array";
const LIST_SLOT_JOURNEY_ROWS: &str = "list:rdJourneyRows:array";
const LIST_SLOT_CAPTURE_HELD: &str = "list:rdCaptureHeld:array";

/// One plate cell, every field spelled once (the nocturne row's shape).
fn kb_cell(row: &crate::snapshot::NocturneKeyCell) -> SlotValue {
    SlotValue::object(vec![
        ("cap".to_owned(), SlotValue::Text(row.cap.clone())),
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("short".to_owned(), SlotValue::Text(row.short.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("aria".to_owned(), SlotValue::Text(row.aria.clone())),
        ("disabled".to_owned(), SlotValue::Bool(row.disabled)),
        ("tab".to_owned(), SlotValue::Text(row.tab.clone())),
        (
            "aria_hidden".to_owned(),
            SlotValue::Text(row.aria_hidden.clone()),
        ),
        ("style".to_owned(), SlotValue::Text(row.style.clone())),
    ])
}

fn kb_legend_row(row: &crate::snapshot::NocturneLegendRow) -> SlotValue {
    SlotValue::object(vec![
        ("slot".to_owned(), SlotValue::Text(row.slot.clone())),
        ("badge".to_owned(), SlotValue::Text(row.badge.clone())),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn board_choice_row(row: &NocturneChoiceRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn journey_row(row: &crate::snapshot::RedesignJourneyStep) -> SlotValue {
    SlotValue::object(vec![
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("action".to_owned(), SlotValue::Text(row.action.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        ("badge".to_owned(), SlotValue::Text(row.badge.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        (
            "aria_current".to_owned(),
            SlotValue::Text(row.aria_current.clone()),
        ),
    ])
}

fn held_capture_row(row: &crate::snapshot::RedesignHeldCaptureRow) -> SlotValue {
    SlotValue::object(vec![
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        (
            "transport".to_owned(),
            SlotValue::Text(row.transport.clone()),
        ),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        (
            "summary".to_owned(),
            SlotValue::Text(format!("{} · {}", row.transport, row.detail)),
        ),
        ("selector".to_owned(), SlotValue::Text(row.selector.clone())),
        ("instance".to_owned(), SlotValue::Text(row.instance.clone())),
        ("can_release".to_owned(), SlotValue::Bool(row.can_release)),
        ("disabled".to_owned(), SlotValue::Bool(!row.can_release)),
        ("note".to_owned(), SlotValue::Text(row.note.clone())),
    ])
}

// The controller picker's persona rows. The staged CARDS are deliberately
// not a slot: they mount as client-created canvas widgets off the payload
// (parity rule 3e), exactly like the device bench.
const LIST_SLOT_CTRL_PERSONAS: &str = "list:rdCtrlPersonas:array";

/// The persona-row serializer — every field, spelled once.
fn ctrl_persona_row(row: &RedesignPersonaRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("api".to_owned(), SlotValue::Text(row.api.clone())),
        ("note".to_owned(), SlotValue::Text(row.note.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("usable".to_owned(), SlotValue::Text(row.usable.clone())),
    ])
}

/// Scalar slot values, keyed by the signal names in RedesignIsland.ts.
/// `flash` is the action outcome (the allowlisted `?flash=` copy) — the
/// nocturne derivation verbatim: strip the marker for display, key the
/// colour class off it. A poll is not an action and never carries one.
fn scalar_slots(payload: &RedesignPayload, flash: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "rdEnvCls": payload.environment_cls,
        "rdEnvFullText": if payload.environment_fixture {
            "DEMO DATA · NO HARDWARE".to_owned()
        } else if payload.environment_label.trim().is_empty() {
            "ENVIRONMENT UNKNOWN".to_owned()
        } else {
            payload.environment_label.clone()
        },
        "rdEnvCompactText": if payload.environment_fixture {
            "DEMO"
        } else if payload.environment_cls.split_whitespace().any(|token| token == "live") {
            "LIVE"
        } else {
            "UNKNOWN"
        },
        "rdEnvAccessibleText": if payload.environment_fixture {
            format!(
                "{}synthetic demo data; no physical devices are read or written.",
                if payload.environment_label.trim().is_empty() {
                    String::new()
                } else {
                    format!("{} — ", payload.environment_label.trim())
                }
            )
        } else if payload.environment_label.trim().is_empty() {
            "Environment unknown".to_owned()
        } else {
            payload.environment_label.clone()
        },
        "rdStudioVersion": payload.studio_version,
        "rdFlashLine": flash.map(|f| f.trim_start_matches("error: ")).unwrap_or(""),
        "rdFlashCls": match flash {
            None => "n-flash rd-flash none",
            Some(f) if f.starts_with("error") => "n-flash rd-flash err",
            Some(_) => "n-flash rd-flash ok",
        },
        // The device picker's chrome: fold headers, visibility, the scan line.
        "rdDevScanLine": payload.devices.scan_line,
        "rdDevKbHead": payload.devices.keyboards_head,
        "rdDevKbFoldCls": payload.devices.keyboards_fold_cls,
        "rdDevEncHead": payload.devices.encoders_head,
        "rdDevEncFoldCls": payload.devices.encoders_fold_cls,
        "rdDevExpHead": payload.devices.exp_head,
        "rdDevExpFoldCls": payload.devices.exp_fold_cls,
        "rdDevOtherHead": payload.devices.other_head,
        "rdDevOtherFoldCls": payload.devices.other_fold_cls,
        // The controller picker's chrome: the lede, the served ceilings, and
        // the two served values the add form posts (preset = a future FILE
        // NAME, layout = the default that makes a fresh slot playable).
        "rdCtrlAddNote": payload.controllers.add_note,
        "rdCtrlCountsLine": payload.controllers.counts_line,
        "rdCtrlAddPreset": payload.controllers.add_preset,
        "rdCtrlAddLayout": payload.controllers.add_layout,
        // The macro dialog is edited client-side after adoption, but an open
        // cold URL must be complete on first paint. The trusted HTML is built
        // from the same escaped projection as `controllers.mac`.
        "rdMacHolderCls": format!("rd-macdlg {}", payload.controllers.mac.back_cls),
        // The removal-undo chip: SSR chrome (a reload keeps the offer while
        // the server-held window lasts — the nocturne chip's contract).
        "rdUndoCls": payload.controllers.undo_cls,
        "rdUndoLabel": payload.controllers.undo_label,
        // The keyboard widget's chrome — every word the plate wears.
        "rdKbTitle": payload.board.kb_title,
        "rdKbCls": payload.board.kb_cls,
        "rdBoardCaseStyle": payload.board.board_case_style,
        "rdBoardOrigin": payload.board.board_origin,
        "rdKbTrayHead": payload.board.kb_tray_head,
        "rdKbTrayCls": payload.board.kb_tray_cls,
        "rdKbNote": payload.board.kb_note,
        "rdKbMoreCls": payload.board.kb_more_cls,
        "rdSoloLbl": payload.board.solo_label,
        "rdCaptureNote": payload.capture_note,
        // The operational shell. Availability booleans are explicit served
        // facts; labels and reasons are their no-mystery disabled state.
        "rdOpDraftLabel": payload.operations.draft_label,
        "rdOpDraftDetail": payload.operations.draft_detail,
        "rdDraftDirty": payload.operations.draft_dirty,
        "rdDraftRevision": payload.operations.draft_revision,
        "rdOpSavedLabel": payload.operations.saved_label,
        "rdOpSavedDetail": payload.operations.saved_detail,
        "rdOpSessionLine": payload.operations.session.line,
        "rdOpSessionCls": format!("rd-session-state {}", payload.operations.session_cls),
        "rdOpSessionBadge": if !payload.operations.session.reachable {
            "Status unavailable"
        } else if payload.operations.session.running {
            "Playing"
        } else {
            "Stopped"
        },
        "rdOpSessionBadgeState": if !payload.operations.session.reachable {
            "attention"
        } else if payload.operations.session.running {
            "playing"
        } else {
            "stopped"
        },
        "rdOpEscapeLine": payload.operations.escape_line,
        "rdSaveLabel": payload.operations.save.label,
        "rdSaveDisabled": !payload.operations.save.allowed,
        "rdSaveReason": payload.operations.save.reason,
        "rdPlayLabel": payload.operations.play.label,
        "rdPlayDisabled": !payload.operations.play.allowed,
        "rdPlayReason": payload.operations.play.reason,
        "rdPlayCls": if payload.operations.play.visible { "rd-runform rd-playform" } else { "rd-runform rd-playform none" },
        "rdReplacePlayCls": if payload.operations.session.running { "rd-panel-replace" } else { "rd-panel-replace none" },
        "rdApplyLabel": payload.operations.apply.label,
        "rdApplyDisabled": !payload.operations.apply.allowed,
        "rdApplyReason": payload.operations.apply.reason,
        "rdApplyCls": if payload.operations.apply.visible { "rd-runform rd-applyform" } else { "rd-runform rd-applyform none" },
        "rdStopLabel": payload.operations.stop.label,
        "rdStopDisabled": !payload.operations.stop.allowed,
        "rdStopReason": payload.operations.stop.reason,
        "rdStopCls": if payload.operations.stop.visible { "rd-runform rd-stopform" } else { "rd-runform rd-stopform none" },
        "rdAdoptLabel": payload.operations.adopt.label,
        "rdAdoptDisabled": !payload.operations.adopt.allowed,
        "rdAdoptReason": payload.operations.adopt.reason,
        "rdDiscardLabel": payload.operations.discard.label,
        "rdDiscardDisabled": !payload.operations.discard.allowed,
        "rdDiscardReason": payload.operations.discard.reason,
        "rdDiscardConfirmCls": if payload.operations.draft_dirty { "rd-danger-confirm" } else { "rd-danger-confirm none" },
        "rdJourneyCompact": payload.journey.compact,
        "rdJourneyLine": payload.journey.line,
        "rdCaptureMode": payload.capture.mode,
        "rdCaptureDeviceLabel": payload.capture.device_label,
        "rdCaptureStateLabel": payload.capture.state_label,
        "rdCaptureStateTone": payload.capture.state_tone,
        "rdCaptureAttentionCls": payload.capture.attention_cls,
        "rdCaptureAttentionTitle": payload.capture.attention_title,
        "rdCaptureAttentionLine": payload.capture.attention_line,
        "rdCaptureAttentionDetail": payload.capture.attention_detail,
        "rdCaptureAttentionReviewLabel": payload.capture.attention_review_label,
        "rdCaptureAttentionRetryCls": payload.capture.attention_retry_cls,
        "rdCaptureHeading": payload.capture.heading,
        "rdCaptureLine": payload.capture.line,
        "rdCaptureRecoveryLine": payload.capture.recovery_line,
        "rdCaptureSelector": payload.capture.selector,
        "rdCaptureInstance": payload.capture.instance,
        "rdCapturePrepareCls": if payload.capture.can_prepare { "rd-capture-prepare" } else { "rd-capture-prepare none" },
        "rdCaptureHeldCls": if payload.capture.held.is_empty() { "rd-held-recovery none" } else { "rd-held-recovery" },
    })
}

/// Populate every server-injected slot: the scalars, plus the theme-rows
/// lists. Theme deliberately has two responsive homes backed by distinct list
/// signals—the FMIR list renderer consumes one array per mount—so both receive
/// the same authoritative roster. Further lists and shows join as the
/// transplants arrive.
fn build_slots(module: &IrModule, payload: &RedesignPayload, flash: Option<&str>) -> SlotData {
    let scalars = scalar_slots(payload, flash).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    for name in [LIST_SLOT_THEME_ROWS, LIST_SLOT_COMPACT_THEME_ROWS] {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(
                id,
                SlotValue::array(payload.theme_rows.iter().map(mode_row).collect()),
            );
        }
    }
    let dev = &payload.devices;
    for (name, value) in [
        (
            LIST_SLOT_DEV_KB,
            SlotValue::array(dev.keyboards.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_DEV_ENC,
            SlotValue::array(dev.encoders.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_DEV_EXP,
            SlotValue::array(dev.experimental.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_DEV_OTHER,
            SlotValue::array(dev.other.iter().map(other_row).collect()),
        ),
    ] {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(id, value);
        }
    }
    if let Some(id) = named_slot_ids(module, LIST_SLOT_CTRL_PERSONAS)
        .into_iter()
        .next()
    {
        slots.set(
            id,
            SlotValue::array(
                payload
                    .controllers
                    .personas
                    .iter()
                    .map(ctrl_persona_row)
                    .collect(),
            ),
        );
    }
    let board = &payload.board;
    for (name, value) in [
        (
            LIST_SLOT_KB_ROW1,
            SlotValue::array(board.kb_row1.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_ROW2,
            SlotValue::array(board.kb_row2.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_ROW3,
            SlotValue::array(board.kb_row3.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_ROW4,
            SlotValue::array(board.kb_row4.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_ROW5,
            SlotValue::array(board.kb_row5.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_ROW6,
            SlotValue::array(board.kb_row6.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_TRAY,
            SlotValue::array(board.kb_tray.iter().map(kb_cell).collect()),
        ),
        (
            LIST_SLOT_KB_LEGEND,
            SlotValue::array(board.legend.iter().map(kb_legend_row).collect()),
        ),
        (
            LIST_SLOT_CAPTURE_ROWS,
            SlotValue::array(payload.capture_rows.iter().map(board_choice_row).collect()),
        ),
        (
            LIST_SLOT_JOURNEY_ROWS,
            SlotValue::array(payload.journey.rows.iter().map(journey_row).collect()),
        ),
        (
            LIST_SLOT_CAPTURE_HELD,
            SlotValue::array(payload.capture.held.iter().map(held_capture_row).collect()),
        ),
    ] {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(id, value);
        }
    }
    slots
}

/// Render /redesign for one payload: SSR slots for first paint, the same
/// data as island props for hydration.
pub(crate) fn render_redesign(
    page: &EmbeddedPage,
    payload: &RedesignPayload,
    flash: Option<&str>,
) -> PageOutput {
    let slots = build_slots(&page.module, payload, flash);
    // This page holds native disclosures, confirmation checkboxes and
    // selection/search context. A timer-driven document reload is destructive
    // here: it can erase an in-progress exact-device confirmation before the
    // user submits it. Scripted clients already have the bounded poller, and
    // native form submissions return an authoritative render, so the no-JS
    // workbench waits for the user's next navigation intent.
    let prefix = body_prefix_no_refresh(payload);
    let macro_ssr_html = crate::render_workbench::macro_dialog_ssr_html(&payload.controllers.mac);
    let rendered = render_page(&PageConfig {
        title: "ksx Studio — redesign",
        route_pattern: "/redesign",
        manifest: &page.manifest,
        config_script: None,
        config_json: None,
        body_class: None,
        personality_css: Some(PERSONALITY_CSS),
        body_prefix: Some(&prefix),
        render_mode: RenderMode::Phase2SsrReconcile,
        ir_module: Some(&page.module),
        slots: Some(&slots),
    });
    with_icon_links(with_macro_ssr(rendered, &macro_ssr_html))
}

/// Fill the macro dialog host that the Forma island deliberately leaves empty.
/// The fragment is produced by
/// `render_workbench::macro_dialog_ssr_html`, which escapes every domain value;
/// this splice exists solely because forma-server 0.2.0 has no trusted-HTML
/// SSR slot. Client hydration receives the same structured `controllers.mac`
/// projection, adopts this tree once, and uses safe DOM construction for later
/// draft repaints.
///
/// The qualified host is unique and the compiler emits it empty, so the first
/// closing `</div>` after it belongs to this element. A missing or duplicated
/// qualified host is a compiler/source contract break: log it and leave the
/// otherwise usable page intact, while render and hydration-parity tests fail.
fn with_macro_ssr(mut out: PageOutput, fragment: &str) -> PageOutput {
    // Empty custom attributes are serialized as a bare name by the FMIR
    // walker, while the hydrated DOM serializes them as name="". Key on the
    // attribute itself so the splice follows both legal HTML spellings.
    const MARKER: &str = "data-rd-mac-host";

    // A macro name may legally equal MARKER and therefore occur in the JSON
    // payload or visible text. Only count occurrences that are the attribute
    // of this exact static host tag; domain text must never participate in
    // locating a trusted-markup sink.
    let hosts: Vec<usize> = out
        .html
        .match_indices(MARKER)
        .filter_map(|(marker_at, _)| {
            let tag_start = out.html[..marker_at].rfind('<')?;
            let tag_end = marker_at + out.html[marker_at..].find('>')?;
            let tag = &out.html[tag_start..=tag_end];
            let before = out.html.as_bytes().get(marker_at.wrapping_sub(1)).copied();
            let after = out.html.as_bytes().get(marker_at + MARKER.len()).copied();
            let attribute_boundary = before.is_some_and(|byte| byte.is_ascii_whitespace())
                && after
                    .is_some_and(|byte| byte.is_ascii_whitespace() || byte == b'=' || byte == b'>');
            (attribute_boundary
                && tag.starts_with("<div")
                && tag.contains("class=\"nd nd-mac\"")
                && tag.contains("data-nx=\"dlg-noop\""))
            .then_some(marker_at)
        })
        .collect();
    let Some(&marker_at) = hosts.first() else {
        tracing::warn!("rendered redesign has no macro SSR host; dialog fragment not added");
        return out;
    };
    if hosts.len() != 1 {
        tracing::warn!("rendered redesign has multiple macro SSR hosts; dialog fragment not added");
        return out;
    }
    if fragment.is_empty() {
        return out;
    }

    let Some(open_end_rel) = out.html[marker_at..].find('>') else {
        tracing::warn!("rendered redesign macro SSR host has no opening-tag terminator");
        return out;
    };
    let content_start = marker_at + open_end_rel + 1;
    let Some(close_rel) = out.html[content_start..].find("</div>") else {
        tracing::warn!("rendered redesign macro SSR host has no closing tag");
        return out;
    };
    let close_at = content_start + close_rel;
    if close_at != content_start {
        tracing::warn!("rendered redesign macro SSR host was not empty; dialog fragment not added");
        return out;
    }

    out.html.insert_str(close_at, fragment);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::assert_complete_head;

    /// The island source, compiled IN so the cross-language guards below
    /// cannot silently stop reading anything: move or rename the file and
    /// this crate fails to build.
    const REDESIGN_ISLAND_TS: &str = include_str!("../../../studio-ui/src/RedesignIsland.ts");
    const REDESIGN_TS: &str = include_str!("../../../studio-ui/src/redesign.ts");

    /// A four-board scan exercising every tier — the macro_fixture roster,
    /// condensed: an encoder that ALSO declares as a keyboard, a plain
    /// keyboard, a pickable non-keyboard, and an unpickable device.
    fn fixture_scan() -> ksx_api::DeviceScanView {
        ksx_api::DeviceScanView {
            boards_summary: "2 keyboard-capable boards found; 1 more device has no keyboard \
                             interface."
                .into(),
            boards: vec![
                ksx_api::BoardRow {
                    name: "Ultimarc I-PAC 4".into(),
                    role: ksx_api::BoardRole::PanelEncoder,
                    transport_label: "USB".into(),
                    selector: Some("usb:d209:0430:00".into()),
                    alias_hint: "panel".into(),
                    pickable: true,
                    looks_like_a_keyboard: true,
                    chart_readable: true,
                    family_label: Some("Ultimarc I-PAC 4".into()),
                    family_id: Some("ultimarc-ipac4".into()),
                    protocol_profile: Some("ipac4-pac256-v1".into()),
                    profile_state: "profiled".into(),
                    terminal_count: Some(56),
                    ..Default::default()
                },
                ksx_api::BoardRow {
                    name: "Logitech G915 TKL".into(),
                    transport_label: "Bluetooth".into(),
                    selector: Some("usb:046d:c545:00".into()),
                    pickable: true,
                    looks_like_a_keyboard: true,
                    ..Default::default()
                },
                ksx_api::BoardRow {
                    name: "AURA LED Controller".into(),
                    transport_label: "USB".into(),
                    role: ksx_api::BoardRole::Other,
                    selector: Some("usb:0b05:1939:00".into()),
                    pickable: true,
                    looks_like_a_keyboard: false,
                    ..Default::default()
                },
                ksx_api::BoardRow {
                    name: "Composite pointing device".into(),
                    transport_label: "USB".into(),
                    backends: "No keyboard interface — cannot be split".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn fixture_payload() -> RedesignPayload {
        payload(PayloadInput {
            environment: &ksx_api::RuntimeEnvironmentView {
                fixture: true,
                id: "seeded-demo".into(),
                label: "Fixture · Seeded demo".into(),
                detail: "Synthetic data for the redesign lane.".into(),
                generation: "test".into(),
            },
            // A readable config with no stamp: System is the one marked row.
            setup: Some(ksx_api::SetupView::default()),
            setup_error: "",
            scan: Ok(fixture_scan()),
            // Nothing staged, authoritatively: every device row serves
            // aria_current "false" and the workbench mounts no cards — but
            // the picker still offers the roster over served ceilings.
            staged: &fixture_staged(Vec::new()),
            session: &crate::control::SessionView {
                reachable: true,
                line: "idle".into(),
                ..Default::default()
            },
            outputs: &ksx_api::ControllerOutputsView::from_required(Vec::new()),
            selected_slot: None,
            selected_source: None,
            undo_label: None,
            macro_selected: None,
            q: None,
        })
    }

    /// A staged view with real ceilings, the two-persona roster, and the
    /// given slots — the shape `StagedSetupView::of` serves, condensed.
    fn fixture_staged(slots: Vec<ksx_api::StagedSlotView>) -> ksx_api::StagedSetupView {
        let xinput_used = slots.iter().filter(|slot| slot.is_xinput).count();
        let full = slots.len() >= 16;
        ksx_api::StagedSetupView {
            reachable: true,
            empty: slots.is_empty(),
            next_slot: if full {
                None
            } else {
                Some(slots.len() as u8 + 1)
            },
            next_preset: if full {
                None
            } else {
                Some(format!("Player {}", slots.len() + 1))
            },
            default_layout: "keyboard-2p".into(),
            max_slots: 16,
            max_xinput_slots: 4,
            xinput_used,
            personas: vec![
                ksx_api::PersonaOption {
                    name: "xbox360".into(),
                    label: "Xbox 360 pad".into(),
                    backend_label: "ViGEm bus".into(),
                    is_xinput: true,
                    can_plug: true,
                    available: true,
                    ..Default::default()
                },
                ksx_api::PersonaOption {
                    name: "playstation".into(),
                    label: "PlayStation pad".into(),
                    backend_label: "ViGEm bus".into(),
                    is_xinput: false,
                    can_plug: true,
                    available: true,
                    ..Default::default()
                },
            ],
            slots,
            ..Default::default()
        }
    }

    fn selected_source_payload(
        staged: &ksx_api::StagedSetupView,
        scan: ksx_api::DeviceScanView,
        source: &str,
    ) -> RedesignPayload {
        payload(PayloadInput {
            environment: &ksx_api::RuntimeEnvironmentView::default(),
            setup: Some(ksx_api::SetupView::default()),
            setup_error: "",
            scan: Ok(scan),
            staged,
            session: &crate::control::SessionView {
                reachable: true,
                line: "idle".into(),
                ..Default::default()
            },
            outputs: &ksx_api::ControllerOutputsView::default(),
            selected_slot: None,
            selected_source: Some(source),
            undo_label: None,
            macro_selected: None,
            q: None,
        })
    }

    fn fixture_slot(
        number: u8,
        persona: &str,
        is_xinput: bool,
        preset: &str,
    ) -> ksx_api::StagedSlotView {
        ksx_api::StagedSlotView {
            number,
            persona: persona.into(),
            persona_label: format!("{persona} label"),
            is_xinput,
            preset: preset.into(),
            ..Default::default()
        }
    }

    /// `/redesign` is an interactive document even without scripting: native
    /// details hold setup state and exact-device forms hold required consent.
    /// A five-second document timer destroys both, so this page deliberately
    /// carries only the payload prefix and waits for an explicit navigation.
    #[test]
    fn the_native_workbench_never_reloads_itself() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;
        assert!(html.contains("<script id=\"__ksx-payload\""), "{html}");
        assert!(
            !html.contains("http-equiv=\"refresh\"") && !html.contains("url=/redesign"),
            "native workbench state must survive beyond the old five-second timer: {html}"
        );
    }

    /// The inspector payload rides the ONE shared controller-panel and pad
    /// composers: selection defaults to the first slot (the nocturne rule),
    /// an explicit slot wins, every pad row carries the server-decided
    /// family, an authoring-less slot serves its honest mapping refusal
    /// instead of an empty-but-valid callout table, and the undo chip's
    /// class pair folds exactly like nocturne's.
    #[test]
    fn the_inspector_panel_and_pads_ride_the_shared_composers() {
        let staged = fixture_staged(vec![
            fixture_slot(1, "xbox360", true, "Player 1"),
            fixture_slot(2, "playstation", false, "Player 2"),
        ]);
        let defaulted = RedesignControllers::of(&staged, None, None, None, None);
        assert_eq!(defaulted.panel.slot_val, "1", "no ?slot → the first slot");
        assert_eq!(defaulted.panel.pad_badge, "P1");
        assert_eq!(defaulted.panel.pad_badge_cls, "n-pbadge np1");
        let chosen = RedesignControllers::of(&staged, Some(2), None, None, None);
        assert_eq!(chosen.panel.slot_val, "2", "an explicit ?slot wins");
        assert!(
            chosen.panel.pad_sub.contains("\"Player 2\" preset"),
            "{}",
            chosen.panel.pad_sub
        );
        assert_eq!(chosen.pads.len(), 2);
        assert_eq!(chosen.pads[0].family, "xbox");
        assert_eq!(chosen.pads[1].family, "ps");
        for pad in &chosen.pads {
            assert!(
                !pad.mapping_available && !pad.mapping_reason.is_empty(),
                "a fixture slot serves no authoring table — the refusal must \
                 travel, never an empty-but-valid callout table: {pad:?}"
            );
        }
        let (quiet_cls, quiet_label) = (&chosen.undo_cls, &chosen.undo_label);
        assert_eq!(quiet_cls, "rd-undochip none");
        assert!(quiet_label.is_empty());
        let chip = RedesignControllers::of(&staged, Some(2), Some("P9 (X) removed"), None, None);
        assert_eq!(chip.undo_cls, "rd-undochip");
        assert_eq!(chip.undo_label, "P9 (X) removed");
    }

    /// The card and picker composition speaks only the daemon's truth: slot
    /// order precomposes the reorder strings (empty at the ends — the honest
    /// no-write), the api line prices XInput honestly, every ceiling in the
    /// counts line is SERVED, and an unreachable daemon disables the roster
    /// with the reason instead of hiding it.
    #[test]
    fn the_controller_cards_and_picker_speak_the_daemons_truth() {
        let staged = fixture_staged(vec![
            fixture_slot(1, "xbox360", true, "Player 1"),
            fixture_slot(2, "playstation", false, "Player 2"),
            fixture_slot(3, "xbox360", true, "Player 3"),
        ]);
        let view = RedesignControllers::of(&staged, None, None, None, None);
        assert_eq!(view.cards.len(), 3);
        assert_eq!(
            view.cards
                .iter()
                .map(|c| c.number.as_str())
                .collect::<Vec<_>>(),
            ["1", "2", "3"],
            "cards ride the daemon's slot order — numbers arrive with the slots"
        );
        assert!(view.cards[0].api_line.contains("XInput"));
        assert!(view.cards[1].api_line.contains("no XInput slot"));
        assert_eq!(
            view.counts_line, "3 of 16 slots staged · 2 of 4 Xbox (XInput)",
            "every number in the counts line is the daemon's"
        );
        assert_eq!(
            view.add_preset, "Player 4",
            "the next preset is served — it becomes a file name"
        );
        assert_eq!(view.add_layout, "keyboard-2p");
        assert!(
            view.add_note.contains("nothing is saved or started"),
            "{}",
            view.add_note
        );
        assert!(view.personas.iter().all(|p| p.usable == "true"));

        // The presentation rides the ONE total record (`pad_presentation`):
        // family and art are served together, the browser never re-decides,
        // and an unrecognised persona is the NAMED unknown — not a silent
        // silhouette.
        for (persona, family, art) in [
            ("xbox360", "xbox", "/_assets/pad-xbox.svg"),
            ("playstation", "ps", "/_assets/pad-ds4.svg"),
            ("dualsense", "ps5", "/_assets/pad-ds4.svg"),
            ("snes", "xbox", "/_assets/pad-xbox.svg"),
            (
                "a-persona-from-the-future",
                "unknown",
                "/_assets/pad-xbox.svg",
            ),
        ] {
            let one = RedesignControllers::of(
                &fixture_staged(vec![fixture_slot(1, persona, false, "P")]),
                None,
                None,
                None,
                None,
            );
            assert_eq!(one.cards[0].family, family, "{persona}");
            assert_eq!(one.cards[0].art, art, "{persona}");
        }

        // A full house says the nocturne sentence and offers no preset.
        let full = fixture_staged(
            (1..=16)
                .map(|n| fixture_slot(n, "playstation", false, "P"))
                .collect(),
        );
        let full_view = RedesignControllers::of(&full, None, None, None, None);
        assert_eq!(full_view.add_preset, "");
        assert!(
            full_view
                .add_note
                .contains("Every controller slot is staged"),
            "{}",
            full_view.add_note
        );

        // Unreachable: the roster stays listed, disabled, with the reason.
        let mut dead = fixture_staged(Vec::new());
        dead.reachable = false;
        dead.error = Some("the daemon pipe is closed".into());
        let dead_view = RedesignControllers::of(&dead, None, None, None, None);
        assert!(dead_view.cards.is_empty());
        assert!(dead_view.personas.iter().all(|p| p.usable == "false"));
        assert_eq!(dead_view.add_note, "the daemon pipe is closed");
    }

    /// The picker is SERVED: the topbar button, the modal shell, the lede,
    /// the counts, every persona row, and the add form's served values —
    /// hidden until opened, painted before any script runs.
    #[test]
    fn the_controller_picker_is_served() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;
        assert!(
            html.contains(r#"data-nx="rd-ctrls-open""#),
            "the topbar button is served"
        );
        assert!(
            html.contains("rd-ctrlmodal"),
            "the controller Add tray is served"
        );
        assert!(
            html.contains("0 of 16 slots staged · 0 of 4 Xbox (XInput)"),
            "the served counts line is painted"
        );
        for label in ["Xbox 360 pad", "PlayStation pad"] {
            assert!(html.contains(label), "missing persona row {label:?}");
        }
        assert!(
            html.contains(r#"data-rd-form="controller-add""#),
            "the add form declares its wiring type"
        );
        assert!(
            html.contains(r#"name="layout""#) && html.contains(r#"name="persona""#),
            "the add form posts persona and the served layout"
        );
    }

    /// Forma has no trusted-HTML SSR slot. An open macro nevertheless has to
    /// be a complete first paint: the post-render seam fills exactly one
    /// marked dialog host with the escaped projection the payload also owns.
    #[test]
    fn an_open_macro_is_complete_and_escaped_before_hydration() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let mut payload = fixture_payload();
        payload.controllers.mac = crate::macro_editor::NocturneMacroEditor {
            open: true,
            back_cls: "nd-back".into(),
            name: "Hadouken <unsafe> & ready".into(),
            trigger: "H & K".into(),
            note: "Three steps < one second".into(),
            grid_cls: "n-macgrid".into(),
            close_href: "/redesign?slot=1".into(),
            ..Default::default()
        };
        let html = render_redesign(&page, &payload, None).html;
        let payload_at = html.find("<script id=\"__ksx-payload\"").unwrap();
        let payload_end = payload_at + html[payload_at..].find("</script>").unwrap() + 9;
        let rendered_island = &html[payload_end..];
        assert_eq!(rendered_island.matches("data-rd-mac-host").count(), 1);
        assert_eq!(rendered_island.matches("data-rd-mac-ssr").count(), 1);
        let marker_at = rendered_island.find("data-rd-mac-host").unwrap();
        let holder_class_at = rendered_island[..marker_at].rfind("rd-macdlg").unwrap();
        let holder_start = rendered_island[..holder_class_at].rfind("<div").unwrap();
        let holder_end = holder_class_at + rendered_island[holder_class_at..].find('>').unwrap();
        let holder_tag = &rendered_island[holder_start..=holder_end];
        assert!(holder_tag.contains("rd-macdlg"), "{holder_tag}");
        assert!(!holder_tag.contains("none"), "{holder_tag}");
        assert!(rendered_island.contains("Hadouken &lt;unsafe&gt; &amp; ready"));
        assert!(rendered_island.contains("H &amp; K"));
        assert!(rendered_island.contains("Three steps &lt; one second"));
        assert!(rendered_island.contains("Save this macro"));
        assert!(!rendered_island.contains("Hadouken <unsafe>"));
    }

    #[test]
    fn a_macro_named_like_the_ssr_marker_cannot_shadow_the_real_host() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let mut payload = fixture_payload();
        payload.controllers.mac = crate::macro_editor::NocturneMacroEditor {
            open: true,
            back_cls: "nd-back".into(),
            name: "data-rd-mac-host".into(),
            trigger: "K".into(),
            note: "A legal macro name, not an HTML marker.".into(),
            grid_cls: "n-macgrid".into(),
            close_href: "/redesign?slot=1".into(),
            ..Default::default()
        };

        let html = render_redesign(&page, &payload, None).html;
        assert!(html.contains("data-rd-mac-ssr"), "{html}");
        assert!(html.contains(">data-rd-mac-host</div>"), "{html}");
        assert!(html.contains("Save this macro"), "{html}");
    }

    /// Keyboard geometry contains real controls and inert spacer cells in the
    /// same served list. The browser-owned canvas starts without a device, but
    /// its hidden reactive template still crosses both seams with truthful
    /// attributes so each exact keyboard can clone one independent surface.
    #[test]
    fn the_served_keyboard_distinguishes_keys_from_spacers_before_hydration() {
        let payload = fixture_payload();
        let cells: Vec<&crate::snapshot::NocturneKeyCell> = [
            &payload.board.kb_row1,
            &payload.board.kb_row2,
            &payload.board.kb_row3,
            &payload.board.kb_row4,
            &payload.board.kb_row5,
            &payload.board.kb_row6,
        ]
        .into_iter()
        .flat_map(|row| row.iter())
        .collect();
        let real = cells
            .iter()
            .copied()
            .find(|cell| cell.key == "A")
            .expect("the standard board's A key");
        assert!(!real.disabled);
        assert_eq!(real.tab, "0");
        assert_eq!(real.aria_hidden, "false");
        let spacer = cells
            .iter()
            .copied()
            .find(|cell| cell.key.is_empty() && cell.cls.split_whitespace().any(|c| c == "ghost"))
            .expect("the standard board's spacer geometry");
        assert!(spacer.disabled);
        assert_eq!(spacer.tab, "-1");
        assert_eq!(spacer.aria_hidden, "true");

        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &payload, None).html;
        assert!(html.contains("data-rd-keyboard-surface-template"), "{html}");
        assert!(
            html.contains("data-rd-keyboard-surface-template-body"),
            "{html}"
        );
        assert!(!html.contains(r#"data-instance-id="keyboard""#), "{html}");
        let button_tags: Vec<&str> = html
            .match_indices("<button")
            .filter_map(|(start, _)| {
                let tail = &html[start..];
                tail.find('>').map(|end| &tail[..=end])
            })
            .collect();
        let real_tag = button_tags
            .iter()
            .copied()
            .find(|tag| tag.contains(r#"class="n-key"#) && tag.contains(r#"data-key="A""#))
            .expect("SSR A key button");
        assert!(!real_tag.split_whitespace().any(|part| part == "disabled"));
        assert!(real_tag.contains(r#"tabindex="0""#), "{real_tag}");
        assert!(real_tag.contains(r#"aria-hidden="false""#), "{real_tag}");

        let spacer_tag = button_tags
            .iter()
            .copied()
            .find(|tag| {
                tag.contains(r#"class="n-key"#)
                    && tag.contains(" ghost")
                    && tag.contains(r#"data-key="""#)
            })
            .expect("SSR spacer button");
        assert!(
            spacer_tag.split_whitespace().any(|part| part == "disabled"),
            "{spacer_tag}"
        );
        assert!(spacer_tag.contains(r#"tabindex="-1""#), "{spacer_tag}");
        assert!(spacer_tag.contains(r#"aria-hidden="true""#), "{spacer_tag}");
    }

    /// The tier rules are the nocturne roster's, and this pins them here: an
    /// encoder that ALSO declares as a keyboard tiers as an ENCODER (role
    /// wins), a pickable non-keyboard is experimental, and a board with no
    /// keyboard interface is unavailable — wearing its transport and backends
    /// in the meta because nothing else will say them.
    #[test]
    fn the_workbench_tiers_sort_like_the_nocturne_roster() {
        let devices = RedesignDeviceRows::of(Some(&fixture_scan()), "", None);
        assert_eq!(
            devices.encoders.len(),
            1,
            "role wins over looks_like_a_keyboard"
        );
        assert_eq!(devices.encoders[0].name, "Ultimarc I-PAC 4");
        assert_eq!(devices.encoders[0].role, "panel-encoder");
        assert_eq!(
            devices.encoders[0].family_id.as_deref(),
            Some("ultimarc-ipac4")
        );
        assert_eq!(
            devices.encoders[0].protocol_profile.as_deref(),
            Some("ipac4-pac256-v1")
        );
        assert_eq!(devices.encoders[0].profile_state, "profiled");
        assert_eq!(devices.encoders[0].terminal_count, Some(56));
        assert_eq!(
            devices.encoders[0].connection_label,
            "USB D209:0430 · connection 00"
        );
        assert!(
            devices.encoders[0].meta.contains("chart not read yet"),
            "an unread chart must not be called ready: {}",
            devices.encoders[0].meta
        );
        assert!(devices.encoders[0].meta.contains("56 terminals"));
        assert_eq!(devices.keyboards.len(), 1);
        assert_eq!(devices.keyboards[0].name, "Logitech G915 TKL");
        assert!(devices.keyboards[0].meta.contains("Ready to use"));
        assert_eq!(devices.experimental.len(), 1);
        assert_eq!(devices.experimental[0].name, "AURA LED Controller");
        assert_eq!(devices.experimental[0].role, "other");
        assert_eq!(devices.other.len(), 1);
        assert_eq!(devices.other[0].name, "Composite pointing device");
        assert!(devices.scan_authoritative);
        // With authoritatively nothing staged, no row claims a daemon
        // selection or wears nocturne's canvas-replacement wording.
        for row in devices
            .encoders
            .iter()
            .chain(&devices.keyboards)
            .chain(&devices.experimental)
        {
            assert_eq!(row.aria_current, "false");
            assert_eq!(row.cls, "n-dev");
            assert!(row.title.contains("workbench"), "{}", row.title);
            assert!(!row.title.contains("replaces the current one"));
        }
        // A refused read is one sentence over an empty picker, never an
        // empty machine.
        let refused = RedesignDeviceRows::of(None, "the scan refused — run `ksx devices`", None);
        assert!(refused.keyboards.is_empty() && refused.other.is_empty());
        assert_eq!(refused.scan_line, "the scan refused — run `ksx devices`");
        assert!(!refused.scan_authoritative);
        assert!(refused.other_fold_cls.contains("none"));
        // The staged daemon fact rides aria_current — the selector compare
        // alone, trimmed, never empty-equals-empty (the guard's own rule).
        let staged = RedesignDeviceRows::of(Some(&fixture_scan()), "", Some("usb:046d:c545:00"));
        assert_eq!(staged.keyboards[0].aria_current, "true");
        assert_eq!(staged.encoders[0].aria_current, "false");
        let nobody = RedesignDeviceRows::of(Some(&fixture_scan()), "", Some("  "));
        assert!(
            nobody.keyboards.iter().all(|r| r.aria_current == "false"),
            "an empty staged selector marks nothing"
        );
    }

    /// A source-qualified learner is an authority boundary, not a display
    /// lookup. A unique selector is insufficient when the selected keyboard
    /// instance appears twice in the inventory, and a unique instance is
    /// insufficient when two board rows claim the selector. Both ambiguous
    /// inventories must remove the learn target instead of choosing first.
    #[test]
    fn selected_source_learn_identity_requires_unique_board_and_instance() {
        let selector = "usb:046d:c545:00";
        let instance = r"HID\VID_046D&PID_C545\ONE";
        let mut staged = fixture_staged(Vec::new());
        let device = ksx_api::StagedDeviceView {
            label: "Logitech G915 TKL".into(),
            alias: "g915".into(),
            selector: selector.into(),
            ..Default::default()
        };
        staged.empty = false;
        staged.device = Some(device.clone());
        staged.devices = vec![device];

        let mut unique = fixture_scan();
        let selected = unique
            .boards
            .iter_mut()
            .find(|board| board.selector.as_deref() == Some(selector))
            .expect("selected scan board");
        selected.keyboard = Some(instance.into());
        selected.interfaces = vec![ksx_api::UsbRow {
            instance_id: instance.into(),
            ..Default::default()
        }];
        let proven = selected_source_payload(&staged, unique.clone(), selector);
        assert_eq!(proven.learn_selector, selector);
        assert_eq!(proven.learn_instance, instance);

        let mut duplicate_selector = unique.clone();
        let mut second = duplicate_selector
            .boards
            .iter()
            .find(|board| board.selector.as_deref() == Some(selector))
            .unwrap()
            .clone();
        let other_instance = r"HID\VID_046D&PID_C545\TWO";
        second.keyboard = Some(other_instance.into());
        second.interfaces = vec![ksx_api::UsbRow {
            instance_id: other_instance.into(),
            ..Default::default()
        }];
        duplicate_selector.boards.push(second);
        let ambiguous_board = selected_source_payload(&staged, duplicate_selector, selector);
        assert_eq!(ambiguous_board.learn_selector, "");
        assert_eq!(ambiguous_board.learn_instance, "");
        assert!(ambiguous_board
            .devices
            .keyboards
            .iter()
            .filter(|row| row.selector == selector)
            .all(|row| row.instance_id.is_empty()));

        let mut duplicate_instance = unique;
        let other = duplicate_instance
            .boards
            .iter_mut()
            .find(|board| board.selector.as_deref() == Some("usb:0b05:1939:00"))
            .expect("other scan board");
        other.interfaces.push(ksx_api::UsbRow {
            instance_id: instance.into(),
            ..Default::default()
        });
        let ambiguous_instance = selected_source_payload(&staged, duplicate_instance, selector);
        assert_eq!(ambiguous_instance.learn_selector, "");
        assert_eq!(ambiguous_instance.learn_instance, "");
        assert!(ambiguous_instance
            .devices
            .keyboards
            .iter()
            .find(|row| row.selector == selector)
            .is_some_and(|row| row.instance_id.is_empty()));
    }

    /// The key projection stays generic and stable while the selected
    /// physical keyboard owns its canvas host. Device identity changes the
    /// mapping source, never the canonical keyboard artwork.
    #[test]
    fn the_mapping_keyboard_names_its_logitech_source_without_impersonating_it() {
        assert_eq!(fixture_payload().board.kb_title, "No input source selected");

        let mut staged = fixture_staged(Vec::new());
        staged.empty = false;
        staged.device = Some(ksx_api::StagedDeviceView {
            label: "Logitech G915 TKL".into(),
            alias: "g915".into(),
            selector: "usb:046d:c545:00".into(),
            ..ksx_api::StagedDeviceView::default()
        });
        let payload = payload(PayloadInput {
            environment: &ksx_api::RuntimeEnvironmentView {
                fixture: true,
                id: "seeded-demo".into(),
                label: "Fixture · Seeded demo".into(),
                detail: "Synthetic data for the redesign lane.".into(),
                generation: "test".into(),
            },
            setup: Some(ksx_api::SetupView::default()),
            setup_error: "",
            scan: Ok(fixture_scan()),
            staged: &staged,
            session: &crate::control::SessionView {
                reachable: true,
                line: "idle".into(),
                ..Default::default()
            },
            outputs: &ksx_api::ControllerOutputsView::default(),
            selected_slot: None,
            selected_source: None,
            undo_label: None,
            macro_selected: None,
            q: None,
        });

        assert_eq!(
            payload.board.kb_title,
            "Logitech G915 TKL · Bluetooth · Active input"
        );
        assert!(
            payload
                .board
                .board_rows
                .iter()
                .any(|row| row.chosen && row.name == "qwerty-104"),
            "the source model must not replace the canonical keyboard drawing"
        );
        assert!(
            !payload
                .board
                .board_rows
                .iter()
                .any(|row| row.name == "Logitech G915 TKL"),
            "a device label is source context, not a physical-artwork choice"
        );

        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &payload, None).html;
        assert!(html.contains("Logitech G915 TKL · Bluetooth · Active input"));
    }

    #[test]
    fn unreachable_staging_is_disabled_with_authored_copy_not_a_raw_diagnostic() {
        let raw = "named pipe \\.\\pipe\\ksx-control refused with os error 231";
        let staged = ksx_api::StagedSetupView::unreachable(raw);
        let payload = payload(PayloadInput {
            environment: &ksx_api::RuntimeEnvironmentView {
                fixture: true,
                id: "seeded-demo".into(),
                label: "Fixture · Seeded demo".into(),
                detail: "Synthetic data for the redesign lane.".into(),
                generation: "test".into(),
            },
            setup: Some(ksx_api::SetupView::default()),
            setup_error: "",
            scan: Ok(fixture_scan()),
            staged: &staged,
            session: &crate::control::SessionView::unreachable("test"),
            outputs: &ksx_api::ControllerOutputsView::default(),
            selected_slot: None,
            selected_source: None,
            undo_label: None,
            macro_selected: None,
            q: None,
        });
        assert!(!payload.devices.staging_reachable);
        assert_eq!(
            payload.board.kb_title,
            "Input source unavailable — reopen KSX"
        );
        assert!(payload.devices.staging_line.contains("background helper"));
        assert!(payload.devices.scan_line.contains("Staging unavailable"));
        assert!(!payload.devices.staging_line.contains(raw));
        assert!(!payload.devices.scan_line.contains(raw));
        assert!(
            payload
                .devices
                .keyboards
                .iter()
                .chain(&payload.devices.encoders)
                .all(|row| row.aria_current == "false"),
            "an unreachable staging provider never invents a current row"
        );
    }

    /// The picker is SERVED: the button, the modal (hidden until opened),
    /// all four fold heads and every row — so hydration reconciles what SSR
    /// painted instead of inventing chrome, and the rows carry the RAW
    /// selector (canonicalizing it is how twin boards collide).
    #[test]
    fn the_device_picker_is_served_with_every_tier() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;
        assert!(
            html.contains(r#"data-nx="rd-devs-open""#),
            "the topbar button is served"
        );
        assert!(
            html.contains("rd-devmodal"),
            "the device Add tray is served"
        );
        for head in [
            "Keyboards · 1",
            "Panel encoders · 1",
            "Not keyboards — experimental · 1",
            "Unavailable devices · 1",
        ] {
            assert!(html.contains(head), "missing fold head {head:?}");
        }
        for name in [
            "Ultimarc I-PAC 4",
            "Logitech G915 TKL",
            "AURA LED Controller",
            "Composite pointing device",
        ] {
            assert!(html.contains(name), "missing device row {name:?}");
        }
        assert!(
            html.contains(r#"data-selector="usb:d209:0430:00""#),
            "rows carry the RAW selector"
        );
        assert!(
            html.contains("USB D209:0430 · connection 00"),
            "same-name boards need their exact connection in the server-rendered picker"
        );
    }

    #[test]
    fn the_cutover_utilities_are_visible_and_keep_their_narrow_contracts() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let payload = fixture_payload();
        let html = render_redesign(&page, &payload, None).html;

        assert_eq!(payload.environment_id, "seeded-demo");
        assert_eq!(payload.environment_generation, "test");
        assert!(payload.environment_fixture);
        assert_eq!(payload.studio_version, env!("CARGO_PKG_VERSION"));
        assert!(
            html.contains("rd-buildmeta"),
            "support version is available from Setup"
        );
        assert!(
            html.contains(r#"href="ms-settings:gaming-gamebar""#),
            "the session recovery offers the safe Windows Game Bar settings door"
        );
        assert!(
            html.contains(r#"data-nx="rd-rescan""#),
            "the served device picker exposes Rescan"
        );
        assert!(
            html.contains(r#"data-nx="canvas-tidy""#),
            "the served camera cluster exposes Tidy"
        );
        assert!(
            html.contains(r#"id="n-macro-dialog""#),
            "macro processors' aria-controls target must exist in redesign"
        );

        // Inspector search and identity color are client-populated because
        // the Inspector body is the page's declared client subtree. Pin the
        // stable interaction names and storage ownership at the source seam.
        for contract in [
            "rd-binding-filter-input",
            "rd-controller-color",
            "ksx-redesign-controller-colors1",
            "ksx-redesign-state-provenance1",
            "ksx-nocturne-strips2",
            "fixtureOwnerIsStale",
        ] {
            assert!(
                REDESIGN_ISLAND_TS.contains(contract),
                "missing redesign client contract {contract:?}"
            );
        }
        assert!(
            REDESIGN_TS.contains(r#"params.set("fresh", "1")"#),
            "Rescan must request a fresh server read instead of repainting cached data"
        );
    }

    #[test]
    fn the_redesign_head_is_complete() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        assert_complete_head(
            "/redesign",
            &render_redesign(&page, &fixture_payload(), None).html,
        );
    }

    /// **Both responsive theme homes offer every theme, and every row is
    /// PAINTED.** The
    /// nocturne picker's own regression, applied here the day the rows were
    /// transplanted: between "the verb round-trips" and "the action string
    /// appears" once sat a picker whose unchosen rows a stale `pill-none`
    /// rule hid, so whatever theme you were on was the only one you could
    /// see (`snapshot.rs` `theme_rows` carries the full story). The class
    /// vocabulary asserted here is the surviving one — `n-radio`, never
    /// `pill` — and exactly one row may claim to be current.
    #[test]
    fn redesign_paints_every_theme_row_in_both_responsive_homes() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;

        fn disclosure<'a>(html: &'a str, class: &str) -> &'a str {
            let marker = format!(r#"class="{class}""#);
            let start = html
                .find(&marker)
                .unwrap_or_else(|| panic!("missing {class} theme disclosure"));
            let rest = &html[start..];
            let end = rest
                .find("</details>")
                .unwrap_or_else(|| panic!("{class} theme disclosure never closes"));
            &rest[..end]
        }

        fn theme_forms(fragment: &str) -> Vec<&str> {
            // Isolate each theme form's own bytes so an assertion about "a
            // theme row" cannot be satisfied by markup elsewhere.
            fragment
                .match_indices(r#"action="/redesign/theme""#)
                .map(|(start, _)| {
                    let rest = &fragment[start..];
                    let end = rest.find("</form>").expect("a theme form to close");
                    &rest[..end]
                })
                .collect()
        }

        // System + every theme in the generated roster. The desktop rail and
        // compact Setup panel are separate no-script homes; responsive CSS
        // exposes exactly one, but each must be independently complete.
        let expected = 1 + crate::theme_tokens::THEMES.len();
        for (home, class) in [
            ("desktop rail", "rd-themed"),
            ("compact Setup panel", "rd-themed-compact"),
        ] {
            let forms = theme_forms(disclosure(&html, class));
            assert_eq!(
                forms.len(),
                expected,
                "the {home} serves {} theme forms, not the {expected} the roster has",
                forms.len(),
            );
            for want in
                std::iter::once("system").chain(crate::theme_tokens::THEMES.iter().map(|t| t.id))
            {
                let hidden = format!(r#"name="theme" value="{want}""#);
                assert!(
                    forms.iter().any(|form| form.contains(&hidden)),
                    "the {home} has no theme form that posts {want:?}",
                );
            }
            for form in &forms {
                assert!(
                    !form.contains("pill"),
                    "a {home} theme row's submit button carries a `pill` class; that \
                     vocabulary hides rows (see snapshot.rs theme_rows): {form}",
                );
                assert!(
                    form.contains("n-radio"),
                    "a {home} theme row's submit button is not an `n-radio`; only \
                     `.n-modeform button.n-radio` is laid out at all: {form}",
                );
            }
            let marked = forms
                .iter()
                .filter(|form| form.contains("n-radio on"))
                .count();
            assert_eq!(
                marked, 1,
                "{marked} theme rows claim to be current in the {home}",
            );
        }
        // Every theme speaks its own sentence — Dark and Matrix share a
        // scheme, so a derived sentence once made two rows word-identical.
        for meta in crate::theme_tokens::THEMES {
            assert!(
                html.contains(meta.blurb),
                "SSR of the theme menu is missing {}'s own sentence {:?}",
                meta.label,
                meta.blurb,
            );
        }
    }

    /// The slot-table contract this seam depends on, both directions: every
    /// name the seam injects is one the island RENDERS, and every scalar the
    /// island renders is one the seam injects. Read
    /// [`crate::render::assert_island_slot_contract`] before touching this —
    /// "the slot exists" is not the check.
    #[test]
    fn embedded_ir_slot_layout_matches_the_seam() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let module = page.module();
        let names: Vec<&str> = module
            .slots
            .entries()
            .iter()
            .filter_map(|e| module.strings.get(e.name_str_idx).ok())
            .collect();

        let scalars = scalar_slots(&RedesignPayload::default(), None);
        for key in scalars.as_object().unwrap().keys() {
            assert!(
                names.contains(&key.as_str()),
                "scalar slot '{key}' missing from the embedded IR; slots: {names:?}"
            );
        }
        for list in [
            LIST_SLOT_THEME_ROWS,
            LIST_SLOT_DEV_KB,
            LIST_SLOT_DEV_ENC,
            LIST_SLOT_DEV_EXP,
            LIST_SLOT_DEV_OTHER,
            LIST_SLOT_CTRL_PERSONAS,
            LIST_SLOT_JOURNEY_ROWS,
            LIST_SLOT_CAPTURE_HELD,
        ] {
            assert!(
                names.contains(&list),
                "list slot '{list}' missing from the embedded IR; slots: {names:?}"
            );
        }
        let islands = module.islands.entries();
        assert_eq!(islands.len(), 1, "expected exactly one island");
        assert_eq!(
            module.strings.get(islands[0].name_str_idx).unwrap(),
            ISLAND_COMPONENT
        );
        assert!(
            !islands[0].slot_ids.is_empty(),
            "island slot_ids are empty — native data-forma-props will not be emitted"
        );

        let injected: Vec<&str> = scalars
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        crate::render::assert_island_slot_contract(
            module,
            &injected,
            &CLIENT_ONLY_SLOTS,
            &ANONYMOUS_SLOTS,
        );
    }

    /// The payload the page embeds is the payload `/api/redesign` serves —
    /// one struct, one serializer, so the poller cannot disagree with the
    /// paint.
    #[test]
    fn the_payload_block_matches_the_api_payload_shape() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;
        let start = html
            .find("<script id=\"__ksx-payload\"")
            .expect("the payload block");
        let body = html[start..]
            .split_once('>')
            .expect("an open tag")
            .1
            .split("</script>")
            .next()
            .expect("a close tag");
        let parsed: RedesignPayload =
            serde_json::from_str(body).expect("the embedded block IS a RedesignPayload");
        assert_eq!(
            serde_json::to_value(parsed).expect("parsed payload serializes"),
            serde_json::to_value(fixture_payload()).expect("fixture payload serializes"),
            "wire-visible payload fields round-trip exactly"
        );
    }

    /// The cross-language guards: the entry registers exactly this island,
    /// and the island declares exactly the signals the seam injects.
    #[test]
    fn the_entry_registers_the_island_the_seam_names() {
        assert!(
            REDESIGN_TS.contains("RedesignIsland: (el)"),
            "redesign.ts no longer registers RedesignIsland"
        );
        for signal in [
            "rdEnvCls",
            "rdEnvFullText",
            "rdEnvCompactText",
            "rdEnvAccessibleText",
            "rdFlashLine",
            "rdFlashCls",
            "rdDevScanLine",
            "rdDevKbHead",
            "rdDevKbFoldCls",
            "rdDevEncHead",
            "rdDevEncFoldCls",
            "rdDevExpHead",
            "rdDevExpFoldCls",
            "rdDevOtherHead",
            "rdDevOtherFoldCls",
            "rdCtrlAddNote",
            "rdCtrlCountsLine",
            "rdCtrlAddPreset",
            "rdCtrlAddLayout",
            "rdUndoCls",
            "rdUndoLabel",
            "rdKbTitle",
            "rdKbCls",
            "rdBoardCaseStyle",
            "rdBoardOrigin",
            "rdKbTrayHead",
            "rdKbTrayCls",
            "rdKbNote",
            "rdKbMoreCls",
            "rdSoloLbl",
            "rdCaptureNote",
        ] {
            assert!(
                REDESIGN_ISLAND_TS.contains(&format!("const [{signal}, ")),
                "RedesignIsland.ts no longer declares the '{signal}' signal the seam injects"
            );
        }
        for signal in [
            "rdThemeRows",
            "rdCompactThemeRows",
            "rdDevKb",
            "rdDevEnc",
            "rdDevExp",
            "rdDevOther",
            "rdCtrlPersonas",
            "rdKbRow1",
            "rdKbRow2",
            "rdKbRow3",
            "rdKbRow4",
            "rdKbRow5",
            "rdKbRow6",
            "rdKbTray",
            "rdKbLegend",
            "rdCaptureRows",
        ] {
            assert!(
                REDESIGN_ISLAND_TS.contains(&format!("const [{signal}, ")),
                "RedesignIsland.ts no longer declares the '{signal}' list signal the seam fills"
            );
        }
    }
}
