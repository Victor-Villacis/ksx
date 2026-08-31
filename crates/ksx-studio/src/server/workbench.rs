//! Route-neutral application layer for the setup workbench.
//!
//! `/redesign` is a presentation. The staged setup, exact capture transaction,
//! learner, encoder read, mapping writes and lifecycle actions are product
//! capabilities and must not live inside the page module. Keeping them here
//! also let the legacy presentation disappear without deleting the product
//! operations.

use super::*;

// Customer copy for the setup presentation. Provider diagnostics remain in
// typed outcomes/logs and never become redirect query text.
pub(super) const N_THEME_OK: &str = "Studio theme updated.";
pub(super) const N_THEME_UNKNOWN: &str = "error: That is not a theme this build ships. Pick one \
     from the list in this menu; nothing was changed.";
pub(super) const N_DEVICE_OK: &str = "Keyboard selected. Nothing has been saved or started.";
pub(super) const N_DEVICE_ALREADY_OK: &str =
    "That keyboard is still the selected one. Nothing changed — any preparation it \
     already has was kept.";
pub(super) const N_IDENTIFY_OK: &str =
    "Keyboard identified and selected. Nothing has been captured, saved, or started.";
pub(super) const N_IDENTIFY_TIMEOUT: &str =
    "error: No keyboard answered in time. Nothing changed; try Identify again and press one key.";
pub(super) const N_IDENTIFY_ERROR: &str = "error: That key press could not be matched to one \
     selectable keyboard. Nothing changed; try again.";
pub(super) const N_FORM_UNREADABLE: &str = "error: That request could not be read. Reopen this \
     screen and try again; nothing was changed.";
pub(super) const N_EDIT_OK: &str = "Draft updated. Nothing has been saved or started.";
pub(super) const N_EDIT_ERROR: &str =
    "error: The change could not be made. Reopen ksx and try again; nothing was changed.";
pub(super) const N_MOVE_AT_END: &str =
    "That controller is already at that end of the order. Nothing changed.";
pub(super) const N_ADD_LAYOUT_ERROR: &str = "error: That starting layout has no key block for this player number, so the controller was not added. Try another layout or Empty; nothing was changed.";
pub(super) const N_UNKNOWN_FLASH_ERROR: &str =
    "error: That request could not be finished. Reopen ksx and try again.";
pub(super) const N_CLEAR_ALL_OK: &str = "Every key unbound on this controller — its macros \
     kept their steps. Nothing has been saved.";
pub(super) const N_UNDO_OK: &str =
    "Controller restored with its bindings. Nothing has been saved or started.";
pub(super) const N_UNDO_GONE: &str = "error: That removal can no longer be undone — the short \
     undo window has passed. Nothing was changed.";
pub(super) const N_UNDO_FULL: &str = "error: Every controller slot is staged again, so the \
     removed controller has nowhere to return. Nothing was changed.";
pub(super) const N_DUP_OK: &str =
    "Controller duplicated — same layout, same rules, next free slot. Nothing has been saved.";
pub(super) const N_DUP_FULL: &str =
    "error: Every controller slot is staged, so there is nothing free to duplicate into. \
     Remove one first.";
pub(super) const N_TURBO_OK: &str = "Auto-fire updated — the row shows the rate that will \
     actually be delivered. Nothing has been saved or started.";
pub(super) const N_TURBO_INPUT_ERROR: &str = "error: Type a number of presses a second into the \
     turbo box (0 turns auto-fire off). Nothing was changed.";
pub(super) const N_TURBO_UNBOUND_ERROR: &str = "error: That control has no keys, so there is \
     nothing to auto-fire. Bind a key first; nothing was changed.";
pub(super) const N_TOGGLE_OK: &str = "Press behaviour updated. Nothing has been saved or started.";
pub(super) const N_TOGGLE_OLD_DAEMON: &str = "error: This ksx daemon predates press-behaviour \
     rules, so Hold/Toggle cannot take. Update ksx; nothing was changed.";
pub(super) const N_TOGGLE_UNBOUND_ERROR: &str = "error: That control has no keys, so there is \
     nothing to hold. Bind a key first; nothing was changed.";
pub(super) const N_KEY_CLEAR_OK: &str = "That key is free again — everything it drove on this \
     controller is unbound (macro steps are kept). Nothing has been saved.";
pub(super) const N_KEY_CLEAR_NONE: &str =
    "error: That key was not driving anything on this controller. Nothing changed.";
pub(super) const N_BLOCKING_OK: &str =
    "Capture behaviour updated. Nothing has been saved or started.";
pub(super) const N_MACRO_OK: &str = "Macro updated. Nothing has been saved or started.";
pub(super) const N_MACRO_NEW: &str = "Macro created with one empty step — open it and write the sequence. Nothing has been saved or started.";
pub(super) const N_MACRO_NAME: &str =
    "error: a macro needs a name — the table is called after it, so it cannot be blank.";
pub(super) const N_MACRO_TAKEN: &str =
    "error: this layout already has a macro by that name. Open it to edit its steps, or pick \
     another name.";
pub(super) const N_MACRO_BADNAME: &str =
    "error: a macro name may use letters, digits, dot, dash and underscore only — it becomes a \
     table name and part of a link.";
pub(super) const N_MACRO_DELETED: &str = "Macro removed from this draft — its trigger keys are \
     unbound with it. Nothing saved was touched.";
pub(super) const N_SAVE_OK: &str = "Setup saved. Play was not started or changed.";
pub(super) const N_SAVE_ERROR: &str =
    "error: The setup could not be saved. Check the draft on this screen; nothing was written.";
pub(super) const N_SAVE_BLOCKING: &str = "error: This setup is not ready to save — the keyboard \
     question on this screen has not been answered yet. Nothing was written.";
pub(super) const N_SAVE_NO_BINDINGS: &str = "error: This setup is not ready to save — one \
     controller has no keys mapped to it. Give it a starting layout, or bind a control on this \
     screen; nothing was written.";
pub(super) const N_SAVE_NO_DEVICE: &str = "error: This setup is not ready to save — no keyboard \
     has been chosen yet. Pick one on this screen; nothing was written.";
pub(super) const N_SAVE_NO_SLOTS: &str = "error: This setup is not ready to save — no controller \
     has been added yet. Add one on this screen; nothing was written.";
pub(super) const N_SAVE_CAPTURE: &str = "error: This setup is not ready to save — the chosen \
     keyboard is not prepared the way this draft says it is. Use the keyboard card on this \
     screen to prepare or release it; nothing was written.";
pub(super) const N_PLAY_OK: &str =
    "Play is running from this draft. The saved setup was not changed.";
pub(super) const N_PLAY_ERROR: &str =
    "error: Play could not start. Check the draft on this screen; nothing was started.";
pub(super) const N_PLAY_BLOCKING: &str = "error: This setup is not ready to play — the keyboard \
     question on this screen has not been answered yet. Nothing was started.";
pub(super) const N_PLAY_NO_BINDINGS: &str = "error: This setup is not ready to play — one \
     controller has no keys mapped to it, so its pad would do nothing. Give it a starting \
     layout, or bind a control on this screen; nothing was started.";
pub(super) const N_PLAY_NO_DEVICE: &str = "error: This setup is not ready to play — no keyboard \
     has been chosen yet, so there is nothing for the controllers to listen to. Pick one on this \
     screen; nothing was started.";
pub(super) const N_PLAY_NO_SLOTS: &str = "error: This setup is not ready to play — no controller \
     has been added yet. Add one on this screen; nothing was started.";
pub(super) const N_PLAY_CAPTURE: &str = "error: This setup is not ready to play — the chosen \
     keyboard is not prepared the way this draft says it is. Use the keyboard card on this \
     screen to prepare or release it; nothing was started.";
pub(super) const N_PLAY_OUTPUT_BLOCKED: &str = "error: Play cannot start — a controller this \
     setup needs has no working output on this machine, so its pad would plug and stay dead. \
     The setup is still ready to save; install the missing controller support, then Play. \
     Nothing was started.";
pub(super) const N_PLAY_OUTPUT_UNKNOWN: &str = "error: Play cannot start — ksx could not check \
     the controller outputs this setup needs, and it will not plug a pad it cannot vouch for. \
     The setup is still ready to save; reopen ksx and try again. Nothing was started.";
pub(super) const N_STOP_OK: &str = "Play stopped. Virtual controllers were disconnected.";
pub(super) const N_STOP_ERROR: &str =
    "error: Play could not be stopped. Try again, or use L-Ctrl five times.";
pub(super) const N_APPLY_OK: &str = "Play updated in place. Virtual controllers stayed connected, \
     and the saved setup was not changed.";
pub(super) const N_APPLY_RESTART: &str = "error: The draft changed more than bindings, so the \
     running session cannot take it in place. Press Play to replace the session; nothing was \
     changed.";
pub(super) const N_APPLY_ERROR: &str = "error: The changes could not be applied. The running \
     session was not changed; reopen ksx and try again.";
pub(super) const N_ADOPT_OK: &str = "Saved setup loaded into this draft. Saved files and any \
     running Play session were not changed.";
pub(super) const N_ADOPT_BLOCKED: &str = "error: This draft already has content, and loading \
     never overwrites edits. Start over first, then load. Nothing was changed.";
pub(super) const N_DISCARD_OK: &str =
    "Draft discarded. Saved files and any running Play session were not changed.";
pub(super) const N_CAPTURE_PREPARED_OK: &str =
    "Keyboard prepared. Windows verified this exact keyboard and ksx is ready to use it.";
pub(super) const N_CAPTURE_RELEASED_OK: &str =
    "Keyboard released. It can type normally again; prepare it again before Play if needed.";
pub(super) const N_CAPTURE_PREPARE_CONSENT: &str =
    "error: Confirm all three keyboard safety checks before continuing. Nothing was changed.";
pub(super) const N_CAPTURE_RELEASE_CONSENT: &str =
    "error: Confirm that you want to release this keyboard. Nothing was changed.";
pub(super) const N_CAPTURE_TARGET_CHANGED: &str = "error: The selected keyboard changed or could \
     not be verified. Nothing was changed; Rescan and choose it again.";
pub(super) const N_CAPTURE_ALREADY_PREPARED: &str = "This keyboard is already prepared. Nothing \
     was changed — use Release if you want it to type normally again.";
pub(super) const N_CAPTURE_ALREADY_RELEASED: &str = "This keyboard is already a normal keyboard. \
     Nothing was changed — use Prepare if you want ksx to take it.";
pub(super) const N_CAPTURE_PREPARE_ERROR: &str = "error: Windows could not prepare this \
     keyboard. Nothing was changed; keep the spare keyboard connected and try again.";
pub(super) const N_CAPTURE_RELEASE_ERROR: &str = "error: Windows could not release this \
     keyboard. Nothing was changed; keep the spare keyboard connected and try again.";
pub(super) const N_CAPTURE_PREPARE_RECOVERY: &str = "error: Windows could not finish preparing \
     this keyboard and it may need recovery. Keep the spare keyboard connected, reopen ksx, and \
     use Release if it is offered. Nothing else was changed.";
pub(super) const N_CAPTURE_RELEASE_RECOVERY: &str = "error: Windows could not finish releasing \
     this keyboard and it may need recovery. Keep the spare keyboard connected and reopen ksx \
     before trying again. Nothing else was changed.";
pub(super) const N_CAPTURE_PREPARED_STAGE_CHANGED: &str = "error: Windows prepared the keyboard, \
     but the selection changed while permission was open. Choose the keyboard again to finish.";
pub(super) const N_CAPTURE_RELEASED_STAGE_CHANGED: &str = "error: Windows released the keyboard, \
     but the selection changed while permission was open. Choose the keyboard again before Play.";
pub(super) const N_READ_SCAN_ERROR: &str =
    "The device list could not be read. Reopen ksx and try again.";
pub(super) const N_READ_SETUP_ERROR: &str =
    "Configuration could not be read. Reopen ksx and try again.";
pub(super) const N_PANEL_CHART_ERROR: &str =
    "That board's chart could not be read. Nothing on the board was changed.";

pub(super) fn checked(value: Option<&str>) -> bool {
    value == Some("yes")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DeviceChoice {
    Unchanged,
    Chosen,
    Refused,
}

pub(super) fn choose_device_preserving_preparation(
    state: &AppState,
    selector: String,
    alias: String,
    label: String,
) -> DeviceChoice {
    if state.control.staged().device.is_some_and(|staged| {
        !staged.selector.trim().is_empty() && staged.selector.trim() == selector.trim()
    }) {
        return DeviceChoice::Unchanged;
    }
    if state
        .control
        .stage_edit(&ksx_api::StageEdit::ChooseDevice {
            selector,
            alias,
            label,
        })
        .ok
    {
        DeviceChoice::Chosen
    } else {
        DeviceChoice::Refused
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureMutation {
    Prepare,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureResult {
    Prepared,
    Released,
    ConsentMissing,
    TargetChanged,
    MutationFailed,
    AlreadyInState,
    RecoveryRequired,
    StageChanged,
}

#[derive(Deserialize)]
pub(super) struct CapturePrepareForm {
    #[serde(default)]
    pub(super) expected_selector: String,
    #[serde(default)]
    pub(super) instance_id: String,
    #[serde(default)]
    pub(super) confirm_spare_keyboard: Option<String>,
    #[serde(default)]
    pub(super) confirm_rebind: Option<String>,
    #[serde(default)]
    pub(super) confirm_machine_certificate: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct CaptureReleaseForm {
    #[serde(default)]
    pub(super) expected_selector: String,
    #[serde(default)]
    pub(super) instance_id: String,
    #[serde(default)]
    pub(super) confirm_release: Option<String>,
}

fn already_in_state(refusal: &ksx_api::Refusal) -> bool {
    matches!(
        refusal.code.as_str(),
        "winusb-already-prepared" | "winusb-already-released"
    )
}

fn capture_target(
    state: &AppState,
    action: CaptureMutation,
    expected_selector: &str,
    instance_id: &str,
) -> Result<(String, String), CaptureResult> {
    if action == CaptureMutation::Prepare {
        let staged = state.control.staged();
        let device = staged
            .device
            .as_ref()
            .filter(|device| staged.reachable && device.selector == expected_selector)
            .ok_or(CaptureResult::TargetChanged)?;
        if device.backend != "interception" && device.backend != "winusb" {
            return Err(CaptureResult::TargetChanged);
        }
    }
    if expected_selector.trim().is_empty() || instance_id.trim().is_empty() {
        return Err(CaptureResult::TargetChanged);
    }
    let scan = state
        .machine
        .device_scan()
        .map_err(|_| CaptureResult::TargetChanged)?;
    let mut matches = scan
        .boards
        .iter()
        .filter(|board| board.selector.as_deref() == Some(expected_selector));
    let board = matches.next().ok_or(CaptureResult::TargetChanged)?;
    if matches.next().is_some() || !board.winusb_eligible {
        return Err(CaptureResult::TargetChanged);
    }
    let current_instance = board
        .keyboard
        .as_ref()
        .filter(|current| current.eq_ignore_ascii_case(instance_id))
        .ok_or(CaptureResult::TargetChanged)?;
    if scan
        .boards
        .iter()
        .flat_map(|candidate| candidate.interfaces.iter())
        .filter(|row| row.instance_id.eq_ignore_ascii_case(current_instance))
        .count()
        != 1
    {
        return Err(CaptureResult::TargetChanged);
    }
    if action == CaptureMutation::Release && !board.claimed {
        return Err(CaptureResult::TargetChanged);
    }
    Ok((
        board.selector.clone().ok_or(CaptureResult::TargetChanged)?,
        current_instance.clone(),
    ))
}

pub(super) fn capture_flash(action: CaptureMutation, result: CaptureResult) -> &'static str {
    match (action, result) {
        (CaptureMutation::Prepare, CaptureResult::Prepared) => N_CAPTURE_PREPARED_OK,
        (CaptureMutation::Release, CaptureResult::Released) => N_CAPTURE_RELEASED_OK,
        (CaptureMutation::Prepare, CaptureResult::ConsentMissing) => N_CAPTURE_PREPARE_CONSENT,
        (CaptureMutation::Release, CaptureResult::ConsentMissing) => N_CAPTURE_RELEASE_CONSENT,
        (_, CaptureResult::TargetChanged) => N_CAPTURE_TARGET_CHANGED,
        (CaptureMutation::Prepare, CaptureResult::AlreadyInState) => N_CAPTURE_ALREADY_PREPARED,
        (CaptureMutation::Release, CaptureResult::AlreadyInState) => N_CAPTURE_ALREADY_RELEASED,
        (CaptureMutation::Prepare, CaptureResult::MutationFailed) => N_CAPTURE_PREPARE_ERROR,
        (CaptureMutation::Release, CaptureResult::MutationFailed) => N_CAPTURE_RELEASE_ERROR,
        (CaptureMutation::Prepare, CaptureResult::RecoveryRequired) => N_CAPTURE_PREPARE_RECOVERY,
        (CaptureMutation::Release, CaptureResult::RecoveryRequired) => N_CAPTURE_RELEASE_RECOVERY,
        (CaptureMutation::Prepare, CaptureResult::StageChanged) => N_CAPTURE_PREPARED_STAGE_CHANGED,
        (CaptureMutation::Release, CaptureResult::StageChanged) => N_CAPTURE_RELEASED_STAGE_CHANGED,
        _ => N_UNKNOWN_FLASH_ERROR,
    }
}

pub(super) async fn capture_prepare(
    state: Arc<AppState>,
    form: CapturePrepareForm,
) -> CaptureResult {
    if !checked(form.confirm_spare_keyboard.as_deref())
        || !checked(form.confirm_rebind.as_deref())
        || !checked(form.confirm_machine_certificate.as_deref())
    {
        return CaptureResult::ConsentMissing;
    }
    tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = capture_target(
            &state,
            CaptureMutation::Prepare,
            &form.expected_selector,
            &form.instance_id,
        )?;
        let mutation = state
            .machine
            .winusb_prepare(&ksx_api::WinusbPrepareSpec {
                expected_selector: expected_selector.clone(),
                instance_id: instance_id.clone(),
                confirm_spare_keyboard: true,
                confirm_rebind: true,
                confirm_machine_certificate: true,
            })
            .map_err(|refusal| {
                if already_in_state(&refusal) {
                    CaptureResult::AlreadyInState
                } else {
                    CaptureResult::MutationFailed
                }
            })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::RecoveryRequired);
        }
        if mutation.state != "prepared" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::MutationFailed);
        }
        if !state
            .control
            .stage_edit(&ksx_api::StageEdit::SetDeviceBackend {
                expected_selector,
                backend: "winusb".to_owned(),
            })
            .ok
        {
            return Err(CaptureResult::StageChanged);
        }
        Ok(CaptureResult::Prepared)
    })
    .await
    .unwrap_or(Err(CaptureResult::MutationFailed))
    .unwrap_or_else(|failure| failure)
}

pub(super) async fn capture_release(
    state: Arc<AppState>,
    form: CaptureReleaseForm,
) -> CaptureResult {
    if !checked(form.confirm_release.as_deref()) {
        return CaptureResult::ConsentMissing;
    }
    tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = capture_target(
            &state,
            CaptureMutation::Release,
            &form.expected_selector,
            &form.instance_id,
        )?;
        let mutation = state
            .machine
            .winusb_release(&ksx_api::WinusbReleaseSpec {
                expected_selector: expected_selector.clone(),
                instance_id: instance_id.clone(),
                confirm_release: true,
            })
            .map_err(|refusal| {
                if already_in_state(&refusal) {
                    CaptureResult::AlreadyInState
                } else {
                    CaptureResult::MutationFailed
                }
            })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::RecoveryRequired);
        }
        if mutation.state != "released" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::MutationFailed);
        }
        if state
            .control
            .staged()
            .device
            .as_ref()
            .is_some_and(|device| device.selector == expected_selector)
            && !state
                .control
                .stage_edit(&ksx_api::StageEdit::SetDeviceBackend {
                    expected_selector,
                    backend: "interception".to_owned(),
                })
                .ok
        {
            return Err(CaptureResult::StageChanged);
        }
        Ok(CaptureResult::Released)
    })
    .await
    .unwrap_or(Err(CaptureResult::MutationFailed))
    .unwrap_or_else(|failure| failure)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StageVerb {
    Save,
    Play,
}

fn stage_flash(outcome: Option<ksx_api::StageOutcome>, verb: StageVerb) -> &'static str {
    let Some(outcome) = outcome else {
        return match verb {
            StageVerb::Save => N_SAVE_ERROR,
            StageVerb::Play => N_PLAY_ERROR,
        };
    };
    if outcome.ok {
        return match verb {
            StageVerb::Save => N_SAVE_OK,
            StageVerb::Play => N_PLAY_OK,
        };
    }
    match (verb, outcome.code.as_deref().unwrap_or_default()) {
        (StageVerb::Save, "blocking-unanswered") => N_SAVE_BLOCKING,
        (StageVerb::Play, "blocking-unanswered") => N_PLAY_BLOCKING,
        (StageVerb::Save, "no-bindings") => N_SAVE_NO_BINDINGS,
        (StageVerb::Play, "no-bindings") => N_PLAY_NO_BINDINGS,
        (StageVerb::Save, "no-device") => N_SAVE_NO_DEVICE,
        (StageVerb::Play, "no-device") => N_PLAY_NO_DEVICE,
        (StageVerb::Save, "no-slots") => N_SAVE_NO_SLOTS,
        (StageVerb::Play, "no-slots") => N_PLAY_NO_SLOTS,
        (StageVerb::Save, _) => N_SAVE_ERROR,
        (StageVerb::Play, _) => N_PLAY_ERROR,
    }
}

pub(super) async fn stage_save(state: Arc<AppState>) -> &'static str {
    let outcome = tokio::task::spawn_blocking(move || state.control.stage_commit())
        .await
        .ok();
    stage_flash(outcome, StageVerb::Save)
}

/// Play's output gate and mutation. Exact-capture policy belongs to the
/// caller because `/redesign` deliberately fails closed on an unreadable
/// inventory while the retained legacy surface does not.
pub(super) async fn stage_play(state: Arc<AppState>) -> &'static str {
    let gate = {
        let inspect = Arc::clone(&state);
        tokio::task::spawn_blocking(move || {
            let outputs = inspect
                .machine
                .controller_outputs(&inspect.control.staged())
                .unwrap_or_default();
            if outputs.blocked {
                Some(N_PLAY_OUTPUT_BLOCKED)
            } else if outputs.unknown {
                Some(N_PLAY_OUTPUT_UNKNOWN)
            } else {
                None
            }
        })
        .await
        .unwrap_or(Some(N_PLAY_ERROR))
    };
    if let Some(refusal) = gate {
        return refusal;
    }
    let outcome = tokio::task::spawn_blocking(move || state.control.stage_play())
        .await
        .ok();
    stage_flash(outcome, StageVerb::Play)
}

pub(super) async fn stage_stop(state: Arc<AppState>) -> &'static str {
    if tokio::task::spawn_blocking(move || state.control.stop().is_ok())
        .await
        .unwrap_or(false)
    {
        N_STOP_OK
    } else {
        N_STOP_ERROR
    }
}

pub(super) async fn stage_apply_flash(state: Arc<AppState>) -> &'static str {
    tokio::task::spawn_blocking(move || {
        let outcome = state.control.stage_apply();
        if outcome.ok {
            N_APPLY_OK
        } else if outcome.code.as_deref() == Some("needs-restart") {
            N_APPLY_RESTART
        } else {
            N_APPLY_ERROR
        }
    })
    .await
    .unwrap_or(N_APPLY_ERROR)
}

pub(super) async fn stage_apply_json(state: Arc<AppState>) -> Response {
    let outcome = tokio::task::spawn_blocking(move || state.control.stage_apply())
        .await
        .ok();
    let json = match outcome {
        Some(outcome) if outcome.ok => serde_json::json!({
            "done": true,
            "flash": N_APPLY_OK,
        }),
        Some(outcome) if outcome.code.as_deref() == Some("needs-restart") => {
            serde_json::json!({
                "done": false,
                "code": "needs-restart",
                "message": outcome.error.unwrap_or_default(),
                "flash": N_APPLY_RESTART,
            })
        }
        _ => serde_json::json!({ "done": false, "flash": N_APPLY_ERROR }),
    };
    axum::Json(json).into_response()
}

#[derive(Deserialize)]
pub(super) struct AdoptForm {
    #[serde(default)]
    pub(super) profile: Option<String>,
}

pub(super) async fn stage_adopt(state: Arc<AppState>, profile: Option<String>) -> &'static str {
    let profile = profile
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    match tokio::task::spawn_blocking(move || state.control.stage_adopt(profile.as_deref()))
        .await
        .ok()
    {
        Some(outcome) if outcome.ok => N_ADOPT_OK,
        Some(outcome) if outcome.code.as_deref() == Some("stage-not-empty") => N_ADOPT_BLOCKED,
        _ => N_EDIT_ERROR,
    }
}

pub(super) async fn stage_discard(state: Arc<AppState>) -> &'static str {
    if tokio::task::spawn_blocking(move || {
        state.control.stage_edit(&ksx_api::StageEdit::Discard).ok
    })
    .await
    .unwrap_or(false)
    {
        N_DISCARD_OK
    } else {
        N_EDIT_ERROR
    }
}

pub(super) struct RemovedSlotUndo {
    pub(super) slot: ksx_api::StagedSlotView,
    pub(super) at: std::time::Instant,
}

const UNDO_WINDOW: std::time::Duration = std::time::Duration::from_secs(6);

pub(super) fn stash_removed_slot(
    staged: &ksx_api::StagedSetupView,
    number: u8,
) -> Option<RemovedSlotUndo> {
    staged
        .slots
        .iter()
        .find(|slot| slot.number == number && slot.authoring.is_some())
        .map(|slot| RemovedSlotUndo {
            slot: slot.clone(),
            at: std::time::Instant::now(),
        })
}

pub(super) fn undo_chip_label(held: &std::sync::Mutex<Option<RemovedSlotUndo>>) -> Option<String> {
    let mut held = held.lock().unwrap();
    if held
        .as_ref()
        .is_some_and(|stash| stash.at.elapsed() > UNDO_WINDOW)
    {
        *held = None;
    }
    held.as_ref().map(|stash| {
        format!(
            "P{} ({}) removed — its bindings are held for a moment",
            stash.slot.number, stash.slot.persona_label
        )
    })
}

pub(super) fn undo_removal_flash(
    state: &AppState,
    held: &std::sync::Mutex<Option<RemovedSlotUndo>>,
) -> &'static str {
    let Some(stash) = held.lock().unwrap().take() else {
        return N_UNDO_GONE;
    };
    if stash.at.elapsed() > UNDO_WINDOW {
        return N_UNDO_GONE;
    }
    let Some(authoring) = stash.slot.authoring else {
        return N_UNDO_GONE;
    };
    let staged = state.control.staged();
    let number = if staged
        .slots
        .iter()
        .any(|slot| slot.number == stash.slot.number)
    {
        match staged.next_slot {
            Some(next) => next,
            None => return N_UNDO_FULL,
        }
    } else {
        stash.slot.number
    };
    let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
        number: Some(number),
        persona: stash.slot.persona,
        preset: stash.slot.preset,
        layout: None,
    });
    if !added.ok {
        return N_EDIT_ERROR;
    }
    let bound = state.control.stage_edit(&ksx_api::StageEdit::SetBindings {
        number,
        preset: Box::new(authoring),
    });
    if !bound.ok {
        let _ = state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
        return N_EDIT_ERROR;
    }
    if !stash.slot.socd.is_empty() && stash.slot.socd != "off" {
        let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
            number,
            socd: stash.slot.socd,
        });
    }
    N_UNDO_OK
}

pub(super) fn clear_all_flash(state: &AppState, number: u8) -> &'static str {
    let staged = state.control.staged();
    let Some(slot) = staged.slots.iter().find(|slot| slot.number == number) else {
        return N_EDIT_ERROR;
    };
    let Some(mut authoring) = slot.authoring.clone() else {
        return N_EDIT_ERROR;
    };
    authoring.bindings.clear();
    if state
        .control
        .stage_edit(&ksx_api::StageEdit::SetBindings {
            number,
            preset: Box::new(authoring),
        })
        .ok
    {
        N_CLEAR_ALL_OK
    } else {
        N_EDIT_ERROR
    }
}

pub(super) fn duplicate_slot_flash(state: &AppState, number: u8) -> &'static str {
    let staged = state.control.staged();
    let Some(source) = staged.slots.iter().find(|slot| slot.number == number) else {
        return N_EDIT_ERROR;
    };
    let (Some(new_number), Some(new_preset)) = (staged.next_slot, staged.next_preset.clone())
    else {
        return N_DUP_FULL;
    };
    let Some(mut authoring) = source.authoring.clone() else {
        return N_EDIT_ERROR;
    };
    let socd = source.socd.clone();
    if !state
        .control
        .stage_edit(&ksx_api::StageEdit::AddSlot {
            number: Some(new_number),
            persona: source.persona.clone(),
            preset: new_preset.clone(),
            layout: None,
        })
        .ok
    {
        return N_EDIT_ERROR;
    }
    authoring.name = new_preset;
    if !state
        .control
        .stage_edit(&ksx_api::StageEdit::SetBindings {
            number: new_number,
            preset: Box::new(authoring),
        })
        .ok
    {
        let _ = state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot { number: new_number });
        return N_EDIT_ERROR;
    }
    if !socd.is_empty() && socd != "off" {
        let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
            number: new_number,
            socd,
        });
    }
    N_DUP_OK
}

fn current_keys(
    staged: &ksx_api::StagedSetupView,
    slot: &ksx_api::StagedSlotView,
    function: &str,
) -> Vec<String> {
    if let Some(name) = function.strip_prefix("macro.") {
        return ksx_api::staged_macro_snapshot(slot)
            .macros
            .into_iter()
            .find(|mac| mac.name.eq_ignore_ascii_case(name))
            .map(|mac| mac.triggers)
            .unwrap_or_default();
    }
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    ksx_api::staged_mapper_slot(slot, keyboard)
        .ok()
        .and_then(|mapper| {
            mapper.bindings.get(function).cloned().or_else(|| {
                mapper
                    .bindings
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(function))
                    .map(|(_, keys)| keys.clone())
            })
        })
        .unwrap_or_default()
}

pub(super) fn bind_clear_flash(state: &AppState, slot: u8, function: String) -> &'static str {
    let staged = state.control.staged();
    let Some(row) = staged
        .slots
        .iter()
        .find(|candidate| candidate.number == slot)
    else {
        return N_EDIT_ERROR;
    };
    if state
        .control
        .stage_bind(&ksx_api::StagedBindRequest {
            number: slot,
            expected_device: staged
                .device
                .as_ref()
                .map(|device| device.selector.clone())
                .unwrap_or_default(),
            expected_target_revision: row.target_revision.clone(),
            preset: row.preset.clone(),
            function,
            keys: vec!["none".to_owned()],
            force: false,
            turbo_hz: None,
            toggle: None,
        })
        .ok
    {
        N_EDIT_OK
    } else {
        N_EDIT_ERROR
    }
}

pub(super) fn key_clear_flash(state: &AppState, number: u8, key: String) -> &'static str {
    let staged = state.control.staged();
    let Some(slot) = staged
        .slots
        .iter()
        .find(|candidate| candidate.number == number)
    else {
        return N_EDIT_ERROR;
    };
    let key = key.trim().to_owned();
    if key.is_empty() {
        return N_EDIT_ERROR;
    }
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let Ok(mapper) = ksx_api::staged_mapper_slot(slot, keyboard) else {
        return N_EDIT_ERROR;
    };
    let without = |keys: &[String]| -> Vec<String> {
        keys.iter()
            .filter(|candidate| !candidate.eq_ignore_ascii_case(&key))
            .cloned()
            .collect()
    };
    let mut driven: Vec<(String, Vec<String>)> = mapper
        .bindings
        .iter()
        .filter(|(_, keys)| {
            keys.iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&key))
        })
        .map(|(function, keys)| (function.clone(), without(keys)))
        .collect();
    driven.extend(
        ksx_api::staged_macro_snapshot(slot)
            .macros
            .into_iter()
            .filter(|mac| {
                mac.triggers
                    .iter()
                    .any(|candidate| candidate.eq_ignore_ascii_case(&key))
            })
            .map(|mac| (format!("macro.{}", mac.name), without(&mac.triggers))),
    );
    if driven.is_empty() {
        return N_KEY_CLEAR_NONE;
    }
    for (function, rest) in driven {
        let keys = if rest.is_empty() {
            vec!["none".to_owned()]
        } else {
            rest
        };
        if !state
            .control
            .stage_bind(&ksx_api::StagedBindRequest {
                number: slot.number,
                expected_device: staged
                    .device
                    .as_ref()
                    .map(|device| device.selector.clone())
                    .unwrap_or_default(),
                expected_target_revision: String::new(),
                preset: slot.preset.clone(),
                function,
                keys,
                force: true,
                turbo_hz: None,
                toggle: None,
            })
            .ok
        {
            return N_EDIT_ERROR;
        }
    }
    N_KEY_CLEAR_OK
}

pub(super) fn bind_turbo_flash(
    state: &AppState,
    slot: u8,
    function: String,
    turbo_hz: Option<&str>,
) -> &'static str {
    let raw = turbo_hz.map(str::trim).unwrap_or("");
    let Ok(hz) = raw.parse::<u32>() else {
        return N_TURBO_INPUT_ERROR;
    };
    let staged = state.control.staged();
    let Some(row) = staged
        .slots
        .iter()
        .find(|candidate| candidate.number == slot)
    else {
        return N_EDIT_ERROR;
    };
    let current = current_keys(&staged, row, &function);
    if current.is_empty() {
        return N_TURBO_UNBOUND_ERROR;
    }
    if state
        .control
        .stage_bind(&ksx_api::StagedBindRequest {
            number: row.number,
            expected_device: staged
                .device
                .as_ref()
                .map(|device| device.selector.clone())
                .unwrap_or_default(),
            expected_target_revision: row.target_revision.clone(),
            preset: row.preset.clone(),
            function,
            keys: current,
            force: true,
            turbo_hz: Some(hz),
            toggle: None,
        })
        .ok
    {
        N_TURBO_OK
    } else {
        N_EDIT_ERROR
    }
}

pub(super) fn bind_toggle_flash(
    state: &AppState,
    slot: u8,
    function: String,
    mode: &str,
) -> &'static str {
    let latch = match mode {
        "toggle" => true,
        "hold" => false,
        _ => return N_EDIT_ERROR,
    };
    let staged = state.control.staged();
    let Some(row) = staged
        .slots
        .iter()
        .find(|candidate| candidate.number == slot)
    else {
        return N_EDIT_ERROR;
    };
    let current = current_keys(&staged, row, &function);
    if current.is_empty() {
        return N_TOGGLE_UNBOUND_ERROR;
    }
    let slot_number = row.number;
    let function_name = function.clone();
    if !state
        .control
        .stage_bind(&ksx_api::StagedBindRequest {
            number: row.number,
            expected_device: staged
                .device
                .as_ref()
                .map(|device| device.selector.clone())
                .unwrap_or_default(),
            expected_target_revision: row.target_revision.clone(),
            preset: row.preset.clone(),
            function,
            keys: current,
            force: true,
            turbo_hz: None,
            toggle: Some(latch),
        })
        .ok
    {
        return N_EDIT_ERROR;
    }
    let took = state
        .control
        .staged()
        .slots
        .iter()
        .find(|candidate| candidate.number == slot_number)
        .and_then(|candidate| ksx_api::staged_mapper_slot(candidate, "").ok())
        .map(|mapper| mapper.toggle.contains(&function_name))
        .unwrap_or(false);
    if took == latch {
        N_TOGGLE_OK
    } else {
        N_TOGGLE_OLD_DAEMON
    }
}

pub(super) async fn blocking_write_flash(state: &Arc<AppState>, blocking: String) -> &'static str {
    let state = Arc::clone(state);
    if tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::SetBlocking { blocking })
            .ok
    })
    .await
    .unwrap_or(false)
    {
        N_BLOCKING_OK
    } else {
        N_EDIT_ERROR
    }
}

pub(super) async fn macro_write_flash(
    state: Arc<AppState>,
    slot: u8,
    write: crate::control::MacroWrite,
    ok_flash: &'static str,
) -> &'static str {
    tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(found) = staged
            .slots
            .iter()
            .find(|candidate| candidate.number == slot)
        else {
            return N_EDIT_ERROR;
        };
        let write = crate::control::MacroWrite {
            preset: found.preset.clone(),
            ..write
        };
        if state
            .control
            .stage_macro(&ksx_api::StagedMacroRequest {
                number: slot,
                write,
            })
            .ok
        {
            ok_flash
        } else {
            N_EDIT_ERROR
        }
    })
    .await
    .unwrap_or(N_EDIT_ERROR)
}

pub(super) async fn macro_new_flash(
    state: Arc<AppState>,
    slot: u8,
    raw_name: &str,
) -> &'static str {
    let name = raw_name.trim().to_owned();
    if name.is_empty() {
        return N_MACRO_NAME;
    }
    if name.len() > 64
        || !name
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return N_MACRO_BADNAME;
    }
    let taken = {
        let inspect = Arc::clone(&state);
        let wanted = name.clone();
        tokio::task::spawn_blocking(move || {
            let staged = inspect.control.staged();
            let Some(found) = staged
                .slots
                .iter()
                .find(|candidate| candidate.number == slot)
            else {
                return false;
            };
            ksx_api::staged_macro_snapshot(found)
                .macros
                .iter()
                .any(|mac| mac.name.eq_ignore_ascii_case(&wanted))
        })
        .await
        .unwrap_or(false)
    };
    if taken {
        return N_MACRO_TAKEN;
    }
    macro_write_flash(
        state,
        slot,
        crate::control::MacroWrite {
            name,
            steps: vec![ksx_api::MacroStepView {
                hold: Vec::new(),
                ms: Some(50),
                frames: None,
                allow_short: false,
            }],
            ..crate::control::MacroWrite::default()
        },
        N_MACRO_NEW,
    )
    .await
}

#[derive(serde::Serialize)]
struct LearnApiView {
    #[serde(flatten)]
    learn: crate::control::LearnView,
    selector: Option<String>,
}

fn resolved_learn_view(
    machine: &dyn ksx_api::MachineSource,
    learn: crate::control::LearnView,
) -> LearnApiView {
    let selector = (learn.state == "hit")
        .then_some(learn.device.as_deref())
        .flatten()
        .filter(|device| !device.trim().is_empty())
        .and_then(|device| machine.device_identify(device).ok())
        .map(|identified| identified.selector)
        .filter(|selector| !selector.trim().is_empty());
    LearnApiView { learn, selector }
}

async fn learn_json(state: Arc<AppState>, start: bool) -> Response {
    let value = tokio::task::spawn_blocking(move || {
        let learn = if start {
            state.control.learn_start()
        } else {
            state.control.learn_poll()
        };
        resolved_learn_view(state.machine.as_ref(), learn)
    })
    .await;
    match value {
        Ok(value) => (
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            axum::Json(value),
        )
            .into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "the learner call panicked",
        )
            .into_response(),
    }
}

pub(super) async fn workbench_api_learn_poll(State(state): State<Arc<AppState>>) -> Response {
    learn_json(state, false).await
}

pub(super) async fn workbench_api_learn_start(State(state): State<Arc<AppState>>) -> Response {
    learn_json(state, true).await
}

#[derive(Deserialize)]
pub(super) struct LearnCancelBody {
    generation: u64,
}

pub(super) async fn workbench_api_learn_cancel(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<LearnCancelBody>,
) -> Response {
    control_json(state, move |control| {
        control.learn_cancel_generation(Some(body.generation))
    })
    .await
}

pub(super) async fn workbench_api_input_test_poll(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| control.input_test_poll()).await
}

pub(super) async fn workbench_api_input_test_start(
    State(state): State<Arc<AppState>>,
    axum::Json(spec): axum::Json<ksx_api::InputTestSpec>,
) -> Response {
    control_json(state, move |control| control.input_test_start(&spec)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InputTestCancelBody {
    generation: u64,
}

pub(super) async fn workbench_api_input_test_cancel(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<InputTestCancelBody>,
) -> Response {
    control_json(state, move |control| {
        control.input_test_cancel_generation(Some(body.generation))
    })
    .await
}

const PANEL_CHART_OBSERVER_BUSY: &str =
    "Button Test is still listening or releasing this device. The encoder was not read.";
const PANEL_CHART_OBSERVER_REMEDY: &str =
    "Stop Button Test, wait for it to close, then read the encoder again.";
const PANEL_CHART_SELECTOR: &str = "ksx could not match that board. It may have been unplugged, \
    or more than one board now matches.";
const PANEL_CHART_SELECTOR_REMEDY: &str = "Refresh the device list and pick the board again.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PanelChartBody {
    selector: String,
}

#[derive(Default, serde::Serialize)]
pub(super) struct PanelChartOutcome {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    board_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminals: Option<Vec<ksx_api::PanelTerminalRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shift: Option<ksx_api::PanelShiftSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remedy: Option<String>,
}

pub(super) async fn workbench_api_panel_chart(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<PanelChartBody>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        if let Err(refusal) = state.control.input_test_release_fence() {
            return if refusal.code == "observer-busy" {
                PanelChartOutcome {
                    error: Some(PANEL_CHART_OBSERVER_BUSY.to_owned()),
                    remedy: Some(PANEL_CHART_OBSERVER_REMEDY.to_owned()),
                    ..Default::default()
                }
            } else {
                PanelChartOutcome {
                    error: Some(N_PANEL_CHART_ERROR.to_owned()),
                    ..Default::default()
                }
            };
        }
        let spec = ksx_api::PanelChartSpec {
            device: Some(body.selector),
            backup: false,
        };
        match state.machine.panel_chart(&spec) {
            Ok(view) => PanelChartOutcome {
                ok: true,
                board_name: Some(view.board_name),
                image_sha256: Some(view.image_sha256),
                shift: Some(view.shift),
                terminals: Some(view.terminals),
                notes: Some(view.notes),
                ..Default::default()
            },
            Err(refusal) if refusal.code == ksx_api::codes::PANEL_INTERFACE_BUSY => {
                PanelChartOutcome {
                    error: Some(refusal.message),
                    remedy: refusal.remedy,
                    ..Default::default()
                }
            }
            Err(refusal) if refusal.code == ksx_api::codes::BAD_REQUEST => PanelChartOutcome {
                error: Some(PANEL_CHART_SELECTOR.to_owned()),
                remedy: Some(PANEL_CHART_SELECTOR_REMEDY.to_owned()),
                ..Default::default()
            },
            Err(_) => PanelChartOutcome {
                error: Some(N_PANEL_CHART_ERROR.to_owned()),
                ..Default::default()
            },
        }
    })
    .await
    .unwrap_or_else(|_| PanelChartOutcome {
        error: Some(N_PANEL_CHART_ERROR.to_owned()),
        ..Default::default()
    });
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(outcome),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct WorkbenchBindBody {
    slot: u8,
    #[serde(default)]
    expected_target_revision: String,
    function: String,
    key: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    force: bool,
}

fn consumer_map_detail(_raw: &str, fallback: &str) -> String {
    fallback.to_owned()
}

fn consumerize_bind(mut outcome: BindOutcome) -> BindOutcome {
    if !outcome.ok {
        outcome.error = Some(consumer_map_detail(
            outcome.error.as_deref().unwrap_or(""),
            "That control could not be changed. Nothing changed.",
        ));
    }
    outcome
}

pub(super) async fn workbench_api_bind(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<WorkbenchBindBody>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(slot) = staged
            .slots
            .iter()
            .find(|candidate| candidate.number == body.slot)
        else {
            return BindOutcome {
                ok: false,
                error: Some(format!(
                    "Player {} is no longer in this unsaved setup. Nothing changed.",
                    body.slot
                )),
                code: Some(ksx_api::codes::BAD_SLOT.to_owned()),
                ..BindOutcome::default()
            };
        };
        let expected_target_revision = body.expected_target_revision.trim().to_owned();
        if expected_target_revision.is_empty()
            || expected_target_revision != slot.target_revision
        {
            return BindOutcome {
                ok: false,
                error: Some(format!(
                    "Player {} changed since this mapping action was opened. Nothing changed. Refresh the canvas and try again.",
                    body.slot
                )),
                code: Some(ksx_api::codes::BAD_SLOT.to_owned()),
                ..BindOutcome::default()
            };
        }
        let key = body.key.trim();
        if key.is_empty() {
            return BindOutcome {
                ok: false,
                error: Some("No key was captured. Nothing changed.".to_owned()),
                code: Some(ksx_api::codes::BAD_REQUEST.to_owned()),
                ..BindOutcome::default()
            };
        }
        let expected_device = staged
            .device
            .as_ref()
            .map(|device| device.selector.clone())
            .unwrap_or_default();
        let (keys, force) = if body.mode.as_deref() == Some("add") {
            let mut current = current_keys(&staged, slot, &body.function);
            if current
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(key))
            {
                return BindOutcome {
                    ok: false,
                    error: Some(format!("That control already has {key} — nothing to add.")),
                    code: Some(ksx_api::codes::BAD_REQUEST.to_owned()),
                    ..BindOutcome::default()
                };
            }
            current.push(key.to_owned());
            (current, true)
        } else if body.mode.as_deref() == Some("remove") {
            let current = current_keys(&staged, slot, &body.function);
            if !current
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(key))
            {
                return BindOutcome {
                    ok: false,
                    error: Some(format!("That control is not driven by {key} — nothing to remove.")),
                    code: Some(ksx_api::codes::BAD_REQUEST.to_owned()),
                    ..BindOutcome::default()
                };
            }
            let rest: Vec<String> = current
                .into_iter()
                .filter(|candidate| !candidate.eq_ignore_ascii_case(key))
                .collect();
            (
                if rest.is_empty() {
                    vec!["none".to_owned()]
                } else {
                    rest
                },
                true,
            )
        } else {
            (vec![key.to_owned()], body.force)
        };
        consumerize_bind(state.control.stage_bind(&ksx_api::StagedBindRequest {
            number: slot.number,
            expected_device,
            expected_target_revision,
            preset: slot.preset.clone(),
            function: body.function,
            keys,
            force,
            turbo_hz: None,
            toggle: None,
        }))
    })
    .await
    .unwrap_or_else(|_| BindOutcome {
        ok: false,
        error: Some("That control could not be changed. Nothing changed.".to_owned()),
        code: Some(ksx_api::codes::REFUSED.to_owned()),
        ..BindOutcome::default()
    });
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(outcome),
    )
        .into_response()
}

fn consumerize_macro(mut outcome: crate::control::MacroOutcome) -> crate::control::MacroOutcome {
    if !outcome.ok {
        outcome.error = Some(consumer_map_detail(
            outcome.error.as_deref().unwrap_or(""),
            "The macro could not be changed. Nothing changed.",
        ));
    }
    outcome.problems = outcome
        .problems
        .into_iter()
        .map(|problem| consumer_map_detail(&problem, "One step or setting is not valid."))
        .collect();
    outcome.warnings = outcome
        .warnings
        .into_iter()
        .map(|warning| {
            consumer_map_detail(&warning, "One very short step may be missed by the game.")
        })
        .collect();
    outcome
}

fn macro_for_target(
    control: &dyn ControlSource,
    target: Option<&str>,
    slot: Option<u8>,
    write: &crate::control::MacroWrite,
) -> crate::control::MacroOutcome {
    if target != Some("stage") {
        return control.save_macro(write);
    }
    let Some(number) = slot else {
        return crate::control::MacroOutcome {
            ok: false,
            error: Some("a staged macro write needs an exact controller slot".to_owned()),
            code: Some(ksx_api::codes::BAD_SLOT.to_owned()),
            ..crate::control::MacroOutcome::default()
        };
    };
    control.stage_macro(&ksx_api::StagedMacroRequest {
        number,
        write: write.clone(),
    })
}

#[derive(Deserialize)]
pub(super) struct TargetedMacroWrite {
    #[serde(flatten)]
    write: crate::control::MacroWrite,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    slot: Option<u8>,
}

pub(super) async fn workbench_api_macro_save(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<TargetedMacroWrite>,
) -> Response {
    let write = crate::control::MacroWrite {
        reload: true,
        ..request.write
    };
    control_json(state, move |control| {
        consumerize_macro(macro_for_target(
            control,
            request.target.as_deref(),
            request.slot,
            &write,
        ))
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct WorkbenchMacroEditBody {
    slot: u8,
    act: String,
    draft: ksx_api::MacroView,
}

#[derive(serde::Serialize)]
struct WorkbenchMacroEditOutcome {
    ok: bool,
    said: String,
    draft: ksx_api::MacroView,
    view: crate::macro_editor::NocturneMacroEditor,
}

async fn macro_edit_on(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<WorkbenchMacroEditBody>,
    page: &'static str,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let slot = staged
            .slots
            .iter()
            .find(|candidate| candidate.number == body.slot);
        let persona = slot.map_or("xbox360", |candidate| candidate.persona.as_str());
        let keyboard = staged
            .device
            .as_ref()
            .map(|device| device.alias.as_str())
            .unwrap_or("");
        let mapper =
            slot.and_then(|candidate| ksx_api::staged_mapper_slot(candidate, keyboard).ok());
        let mut draft = body.draft;
        let (ok, said) = match crate::macro_draft::apply(&mut draft, &body.act, mapper.as_ref()) {
            Ok(said) => (true, said.unwrap_or_default()),
            Err(reason) => (false, reason),
        };
        let view = crate::macro_editor::NocturneMacroEditor::compose(
            &draft,
            persona,
            mapper.as_ref(),
            body.slot,
            None,
            page,
        );
        WorkbenchMacroEditOutcome {
            ok,
            said,
            draft,
            view,
        }
    })
    .await;
    match outcome {
        Ok(outcome) => axum::Json(serde_json::json!(outcome)).into_response(),
        Err(_) => axum::Json(serde_json::json!({
            "ok": false,
            "said": "the macro edit panicked — nothing was changed",
        }))
        .into_response(),
    }
}

pub(super) async fn workbench_api_macro_edit_redesign(
    state: State<Arc<AppState>>,
    body: axum::Json<WorkbenchMacroEditBody>,
) -> Response {
    macro_edit_on(state, body, "/redesign").await
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum StartIdentifyResult {
    Selected(String),
    TimedOut,
    Failed,
    Busy,
    Cancelled,
}

/// One cancellable identify transaction for the redesign. The browser nonce
/// and daemon generation stay paired in the server-owned registry, so a late
/// cancel from one tab cannot stop another tab's listener or stage after a
/// cancellation response has won.
pub(super) async fn identify_and_stage_for_redesign(
    state: Arc<AppState>,
    attempt: String,
) -> StartIdentifyResult {
    let cleanup_attempt = attempt.clone();
    let worker_state = Arc::clone(&state);
    let result = tokio::task::spawn_blocking(move || {
        {
            let mut registry = state.redesign_identify.lock().unwrap();
            match registry.lease.as_ref() {
                Some(super::RedesignIdentifyLease::Pending { attempt: owner })
                    if owner == &attempt => {}
                Some(super::RedesignIdentifyLease::Cancelled { attempt: owner })
                    if owner == &attempt =>
                {
                    registry.lease = None;
                    return StartIdentifyResult::Cancelled;
                }
                Some(_) => return StartIdentifyResult::Busy,
                None => return StartIdentifyResult::Failed,
            }
        }
        let mut learn = state.control.learn_start();
        let Some(generation) = learn.generation else {
            let mut registry = state.redesign_identify.lock().unwrap();
            let cancelled = matches!(
                registry.lease.as_ref(),
                Some(super::RedesignIdentifyLease::Cancelled { attempt: owner })
                    if owner == &attempt
            );
            if matches!(
                registry.lease.as_ref(),
                Some(super::RedesignIdentifyLease::Pending { attempt: owner })
                    if owner == &attempt
            ) || cancelled
            {
                registry.lease = None;
            }
            return if cancelled {
                StartIdentifyResult::Cancelled
            } else {
                StartIdentifyResult::Failed
            };
        };
        enum Transition {
            Active,
            Cancelled,
            Lost,
        }
        let transition = {
            let mut registry = state.redesign_identify.lock().unwrap();
            match registry.lease.as_ref() {
                Some(super::RedesignIdentifyLease::Pending { attempt: owner })
                    if owner == &attempt =>
                {
                    registry.lease = Some(super::RedesignIdentifyLease::Active {
                        attempt: attempt.clone(),
                        generation,
                    });
                    Transition::Active
                }
                Some(super::RedesignIdentifyLease::Cancelled { attempt: owner })
                    if owner == &attempt =>
                {
                    registry.lease = None;
                    Transition::Cancelled
                }
                _ => Transition::Lost,
            }
        };
        if !matches!(transition, Transition::Active) {
            let _ = state.control.learn_cancel_generation(Some(generation));
            return if matches!(transition, Transition::Cancelled) {
                StartIdentifyResult::Cancelled
            } else {
                StartIdentifyResult::Failed
            };
        }
        let finish = |outcome| {
            let mut registry = state.redesign_identify.lock().unwrap();
            if registry.lease.as_ref().is_some_and(|lease| {
                matches!(
                    lease,
                    super::RedesignIdentifyLease::Active {
                        attempt: owner,
                        generation: owner_generation,
                    } | super::RedesignIdentifyLease::Resolving {
                        attempt: owner,
                        generation: owner_generation,
                    } if owner == &attempt && *owner_generation == generation
                )
            }) {
                registry.lease = None;
            }
            outcome
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(11);
        loop {
            if !learn.ok || learn.generation != Some(generation) {
                return finish(StartIdentifyResult::Failed);
            }
            match learn.state.as_str() {
                "hit" => {
                    if learn
                        .key
                        .as_deref()
                        .is_some_and(|key| key.eq_ignore_ascii_case("Escape"))
                    {
                        let _ = state.control.learn_cancel_generation(Some(generation));
                        return finish(StartIdentifyResult::Cancelled);
                    }
                    {
                        let mut registry = state.redesign_identify.lock().unwrap();
                        if !registry.lease.as_ref().is_some_and(|lease| {
                            matches!(
                                lease,
                                super::RedesignIdentifyLease::Active {
                                    attempt: owner,
                                    generation: owner_generation,
                                } if owner == &attempt && *owner_generation == generation
                            )
                        }) {
                            return StartIdentifyResult::Failed;
                        }
                        registry.lease = Some(super::RedesignIdentifyLease::Resolving {
                            attempt: attempt.clone(),
                            generation,
                        });
                    }
                    let Some(observed_instance) = learn
                        .device
                        .as_deref()
                        .filter(|instance| !instance.trim().is_empty())
                    else {
                        return finish(StartIdentifyResult::Failed);
                    };
                    let identified = match state.machine.device_identify(observed_instance) {
                        Ok(identified) => identified,
                        Err(_) => return finish(StartIdentifyResult::Failed),
                    };
                    let selector = identified.selector;
                    return finish(
                        match choose_device_preserving_preparation(
                            &state,
                            selector.clone(),
                            identified.alias,
                            identified.label,
                        ) {
                            DeviceChoice::Chosen | DeviceChoice::Unchanged => {
                                StartIdentifyResult::Selected(selector)
                            }
                            DeviceChoice::Refused => StartIdentifyResult::Failed,
                        },
                    );
                }
                "listening" => {
                    if std::time::Instant::now() >= deadline {
                        let _ = state.control.learn_cancel_generation(Some(generation));
                        return finish(StartIdentifyResult::TimedOut);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    learn = state.control.learn_poll();
                }
                "timeout" => return finish(StartIdentifyResult::TimedOut),
                "idle" | "cancelled" | "failed" | "unavailable" | "unknown" => {
                    return finish(StartIdentifyResult::Failed);
                }
                _ => return finish(StartIdentifyResult::Failed),
            }
        }
    })
    .await;
    match result {
        Ok(outcome) => outcome,
        Err(_) => {
            let generation = {
                let mut registry = worker_state.redesign_identify.lock().unwrap();
                let generation = match registry.lease.as_ref() {
                    Some(super::RedesignIdentifyLease::Active {
                        attempt: owner,
                        generation,
                    })
                    | Some(super::RedesignIdentifyLease::Resolving {
                        attempt: owner,
                        generation,
                    }) if owner == &cleanup_attempt => Some(*generation),
                    _ => None,
                };
                let owned = match registry.lease.as_ref() {
                    Some(super::RedesignIdentifyLease::Pending { attempt: owner }) => {
                        owner == &cleanup_attempt
                    }
                    Some(super::RedesignIdentifyLease::Active { attempt: owner, .. })
                    | Some(super::RedesignIdentifyLease::Resolving { attempt: owner, .. })
                    | Some(super::RedesignIdentifyLease::Cancelled { attempt: owner }) => {
                        owner == &cleanup_attempt
                    }
                    _ => false,
                };
                if owned {
                    registry.lease = None;
                }
                generation
            };
            if let Some(generation) = generation {
                let _ = tokio::task::spawn_blocking(move || {
                    worker_state
                        .control
                        .learn_cancel_generation(Some(generation))
                })
                .await;
            }
            StartIdentifyResult::Failed
        }
    }
}
