//! The status contract — **now `ksx-api`'s** — plus the two PAGE payloads,
//! which stay here because they are this page's shape and nobody else's.
//!
//! `StatusSource` and its snapshots moved to `ksx-api` for the reason
//! docs/M9-DECISION.md §6 gives: the read side must be satisfiable with NO
//! daemon running (ksx-backend's collectors read the config store and the platform
//! directly), and it is consumed by surfaces that do not link this crate. What
//! remains below is the part that genuinely belongs to a web page: the
//! envelope the islands protocol serializes into the document and the poller
//! reads back.

pub use ksx_api::status::*;

use serde::{Deserialize, Serialize};

/// What `GET /api/check` serves AND what the button-check island's props carry
/// — the same one-struct-one-serializer rule as [`StatusPayload`], parity
/// pinned in `render_check.rs`.
///
/// **There is no live data in here, and that is the shape of the page.** This
/// payload is the STRUCTURE — which slots exist, which controls each one's
/// preset names, which keys drive them — read from disk on the server and
/// re-read every few seconds. The lighting-up arrives on a different channel
/// entirely (`GET /api/live`, `crate::live`), at display rate, and touches no
/// signal on the page. Putting a frame in here would mean a button check whose
/// echo was as fast as an HTTP poll, which is not a button check.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckPayload {
    /// The slot roster with every preset's whole binding table — the SAME
    /// `StatusSource::mapper()` read the mapper page uses.
    ///
    /// The control list per slot is `MapperSlot::bindings`' key set, which is
    /// every function the preset names, unbound ones included. That is where
    /// the roster has to come from: a list of "the controls an Xbox pad has"
    /// written into the page would be a second answer to a question the
    /// backend already answers, and docs/SURFACES.md §1 names that failure.
    pub mapper: MapperSnapshot,
    /// The daemon's session state — the page prints it, because "nothing is
    /// lighting up" and "nothing is running" are the same picture and
    /// different problems.
    pub session: crate::control::SessionView,
    /// One sentence saying what this screen watches and where the frames come
    /// from. Composed in Rust so the island words nothing.
    pub feed_hint: String,
}

/// Stable automation truth for `GET /api/health`.
///
/// Studio's product payloads are presentation contracts and are expected to
/// evolve with their surfaces.  The managed-lane launchers need a much
/// smaller, longer-lived answer: which provider owns the listener, whether
/// the staged daemon channel answered, and which configuration root this
/// process opened.  Keeping that answer independent prevents a product-route
/// redesign from silently weakening the real-hardware provenance gate.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioHealthPayload {
    pub environment: ksx_api::RuntimeEnvironmentView,
    pub staged: StudioHealthStaged,
    pub setup: Option<StudioHealthSetup>,
    #[serde(default)]
    pub setup_error: String,
}

/// The only staged-setup facts an environment health probe may consume.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioHealthStaged {
    pub reachable: bool,
    pub error: Option<String>,
}

/// The only saved-configuration fact needed to prove lane isolation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StudioHealthSetup {
    pub config_root: String,
}

/// What `GET /api/redesign` serves AND what the redesign island's props
/// carry — the transplant lane's blank workbench. Deliberately minimal: the
/// machine-provenance chip and nothing else, so the lane can never be
/// mistaken for the cabinet. Every field a transplanted piece needs joins
/// here, server-worded, as the piece arrives.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignPayload {
    /// Stable provider identity and generation. The redesign uses these only
    /// to keep synthetic fixture-owned browser chrome from leaking across a
    /// reseed; real-machine state is never cleared by this mechanism.
    #[serde(default)]
    pub environment_id: String,
    #[serde(default)]
    pub environment_generation: String,
    #[serde(default)]
    pub environment_fixture: bool,
    /// The environment's compact label, verbatim from the source.
    pub environment_label: String,
    /// `n-environment` + the fixture/live/unknown variant — presentation
    /// class, composed in Rust so the island words nothing.
    pub environment_cls: String,
    /// Visible support metadata for screenshots and support conversations.
    /// This is the Studio build serving the page, not a guessed daemon or
    /// driver version.
    #[serde(default)]
    pub studio_version: String,
    /// The Studio theme roster for the topbar menu — the first transplanted
    /// content. Composed by the ONE shared [`theme_rows`] composer and
    /// re-dressed through the same [`NocturneChoiceRow`] shape `/nocturne`
    /// serves, so the two pages cannot mark different rows.
    #[serde(default)]
    pub theme_rows: Vec<NocturneChoiceRow>,
    /// The workbench device picker's truth — see [`RedesignDeviceRows`].
    #[serde(default)]
    pub devices: RedesignDeviceRows,
    /// The staged controllers and the persona picker — see
    /// [`RedesignControllers`].
    #[serde(default)]
    pub controllers: RedesignControllers,
    /// The keyboard widget's whole serving — the SAME [`BoardPanel`]
    /// `/nocturne`'s plate destructures, from the one composer.
    #[serde(default)]
    pub board: BoardPanel,
    /// The staged input's capture behaviour — the daemon's roster with the
    /// current answer marked, from the one [`compose_capture_rows`]
    /// composer (freeze / split / take nothing, reworded for an encoder).
    #[serde(default)]
    pub capture_rows: Vec<NocturneChoiceRow>,
    #[serde(default)]
    pub capture_note: String,
    /// The staged input's verified Windows identity, for pinning a mapping
    /// gesture to the exact device the user saw — the same
    /// [`StartCaptureView`] pair `/nocturne`'s learn flow pins
    /// (`cap_selector`/`cap_instance`). Empty when nothing is staged or the
    /// scan refused: the learn flow refuses to arm rather than listen
    /// against an unverified source.
    #[serde(default)]
    pub learn_selector: String,
    #[serde(default)]
    pub learn_instance: String,
    /// The operational shell: draft-vs-saved provenance, the full daemon
    /// session answer, and every lifecycle action with its current
    /// availability AND reason.  Keeping disabled actions in this contract
    /// lets the redesign explain what is missing instead of reshuffling or
    /// leaving an inert button on a failed read.
    #[serde(default)]
    pub operations: RedesignOperationalState,
    /// Exact-device preparation/release, including machine-keyed recovery
    /// rows for keyboards Windows says ksx is holding even when the draft is
    /// empty.  Browser values are stale-action guards; the POST handlers
    /// still re-resolve both identities from the current machine scan.
    #[serde(default)]
    pub capture: RedesignCaptureState,
    /// The compact four-stop setup spine.  This deliberately leaves the
    /// deferred panel builder out: pick input -> add controllers -> map ->
    /// play is the cutover-critical journey.
    #[serde(default)]
    pub journey: RedesignJourney,
}

/// One lifecycle verb as the redesign presents it.
///
/// `reason` is never empty: when the action is available it says what the
/// click does; when unavailable it says which authoritative read or
/// prerequisite prevents it.  This is intentionally richer than a `can_*`
/// bit so a dead daemon cannot look like a disabled mystery control.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignActionState {
    pub label: String,
    /// Whether the compact action dock should place this verb.  Expanded
    /// setup may still explain a hidden action through [`Self::reason`].
    pub visible: bool,
    pub allowed: bool,
    pub reason: String,
}

impl RedesignActionState {
    fn new(
        label: impl Into<String>,
        visible: bool,
        allowed: bool,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            label: label.into(),
            visible,
            allowed,
            reason: reason.into(),
        }
    }
}

/// Draft, durable configuration, and running-session truth for the redesign
/// action rail.  The complete [`crate::control::SessionView`] travels here so
/// active origin/profile/elapsed facts are not flattened into a decorative
/// "Running" chip and lost to the next block.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignOperationalState {
    pub draft_label: String,
    pub draft_detail: String,
    pub draft_dirty: bool,
    pub draft_empty: bool,
    pub saved_label: String,
    pub saved_detail: String,
    pub session: crate::control::SessionView,
    pub session_cls: String,
    /// Daemon-owned whole-draft incarnation + mutation generation. Empty only
    /// when the daemon/older protocol cannot serve it; never recovered from a
    /// row token or synthesized by the page.
    pub draft_revision: String,
    /// Daemon-captured revision of the draft that actually started/applied
    /// the active staged session. Empty means synchronization is not proven
    /// (idle, config-origin, unreachable, or an older daemon), never a match.
    pub active_stage_revision: String,
    pub escape_line: String,
    pub save: RedesignActionState,
    pub play: RedesignActionState,
    pub apply: RedesignActionState,
    pub stop: RedesignActionState,
    pub adopt: RedesignActionState,
    pub discard: RedesignActionState,
}

impl RedesignOperationalState {
    pub(crate) fn of(
        staged: &ksx_api::StagedSetupView,
        setup: Option<&ksx_api::SetupView>,
        setup_error: &str,
        session: &crate::control::SessionView,
        outputs: &ksx_api::ControllerOutputsView,
        capture: &RedesignCaptureState,
    ) -> Self {
        let draft_label = if !staged.reachable {
            "Draft unavailable"
        } else if staged.empty {
            "New draft"
        } else if staged.origin == "config" && staged.dirty {
            "Saved setup · edited"
        } else if staged.origin == "config" {
            "Saved setup"
        } else if staged.origin.starts_with("profile:") && staged.dirty {
            "Loaded setup · edited"
        } else if staged.origin.starts_with("profile:") {
            "Loaded setup"
        } else {
            "Unsaved draft"
        }
        .to_owned();
        let draft_detail = if !staged.reachable {
            "The ksx background helper is not answering. Editing and lifecycle actions are unavailable until it returns."
                .to_owned()
        } else if staged.empty {
            "Nothing is staged yet. Pick an input and add a controller to begin.".to_owned()
        } else {
            let controllers = match staged.slots.len() {
                0 => "no controllers".to_owned(),
                1 => "1 controller".to_owned(),
                n => format!("{n} controllers"),
            };
            let input = staged
                .device
                .as_ref()
                .map(|device| device.label.as_str())
                .unwrap_or("no input");
            if staged.dirty {
                format!("{input} · {controllers} · changes have not been saved")
            } else {
                format!("{input} · {controllers} · no uncommitted edits")
            }
        };

        let (saved_label, saved_detail, saved_exists) = match setup {
            Some(setup) if setup.config_exists => {
                let count = setup
                    .slots
                    .iter()
                    .filter(|slot| slot.source == "config.toml")
                    .count();
                let controllers = match count {
                    0 => "no controllers".to_owned(),
                    1 => "1 controller".to_owned(),
                    n => format!("{n} controllers"),
                };
                (
                    "Saved configuration".to_owned(),
                    format!("Stored on this machine · {controllers}"),
                    true,
                )
            }
            Some(_) => (
                "Nothing saved yet".to_owned(),
                "Save writes the current draft as this machine's configuration.".to_owned(),
                false,
            ),
            None => (
                "Saved configuration unavailable".to_owned(),
                if setup_error.trim().is_empty() {
                    "The saved configuration could not be read. Reopen ksx and try again."
                        .to_owned()
                } else {
                    setup_error.to_owned()
                },
                false,
            ),
        };

        let stage_ready = staged.reachable && staged.ready && capture.ready_for_commit();
        let needs_save = staged.dirty || staged.origin != "config" || !saved_exists;
        let save_allowed = stage_ready && needs_save;
        let save_reason = if !staged.reachable {
            "The draft cannot be read while the background helper is unavailable.".to_owned()
        } else if !capture.ready_for_commit() && staged.device.is_some() {
            capture.commit_blocker()
        } else if !staged.ready {
            staged_readiness_reason(staged, "save")
        } else if !needs_save {
            "This draft already matches the saved configuration.".to_owned()
        } else {
            "Writes this draft as the machine's saved configuration. Play does not start."
                .to_owned()
        };

        // Play is deliberately still offered while a session runs.  Apply
        // can discover a structural difference only when it is tried, and
        // its prescribed recovery is Play; hiding Play in that state was the
        // legacy shell's contradictory dead end.
        let output_ready = outputs.can_play;
        let play_allowed = stage_ready && session.reachable && output_ready;
        let play_label = if session.running {
            "Restart Play"
        } else {
            "Play"
        };
        let play_reason = if !staged.reachable {
            "The draft cannot be read while the background helper is unavailable.".to_owned()
        } else if !session.reachable {
            "The running-session state cannot be reached. Reopen ksx before starting controllers."
                .to_owned()
        } else if !capture.ready_for_commit() && staged.device.is_some() {
            capture.commit_blocker()
        } else if !staged.ready {
            staged_readiness_reason(staged, "play")
        } else if outputs.blocked {
            "A required controller output is not working on this machine. The draft can still be saved."
                .to_owned()
        } else if !output_ready {
            "Controller output support could not be verified. Reopen ksx and try again; the draft can still be saved."
                .to_owned()
        } else if session.running {
            "Stops and replaces the running session with this complete draft; virtual controllers may reconnect."
                .to_owned()
        } else {
            "Starts the virtual controllers from this draft without writing the saved configuration."
                .to_owned()
        };

        let draft_revision = staged.revision.trim();
        let active_stage_revision = session
            .active_stage_revision
            .as_deref()
            .map(str::trim)
            .filter(|revision| !revision.is_empty());
        // Dirty is a saved-file fact, not a live-session synchronization
        // fact. Apply is licensed only when the daemon proves a staged-origin
        // session is running and names a different whole-draft revision.
        let apply_allowed = staged.reachable
            && session.reachable
            && session.running
            && session.origin == ksx_api::SessionOrigin::Staged
            && !draft_revision.is_empty()
            && active_stage_revision.is_some()
            && active_stage_revision != Some(draft_revision);
        let apply_reason = if !staged.reachable {
            "The draft cannot be read while the background helper is unavailable.".to_owned()
        } else if !session.reachable {
            "The running-session state cannot be reached.".to_owned()
        } else if !session.running {
            "Nothing is running. Use Play when the draft is ready.".to_owned()
        } else if session.origin != ksx_api::SessionOrigin::Staged {
            "The running session did not start from this staged draft. Use Replace session to replace it safely."
                .to_owned()
        } else if draft_revision.is_empty() || active_stage_revision.is_none() {
            "ksx cannot prove which draft revision the running session contains. Use Replace session instead of applying uncertain changes."
                .to_owned()
        } else if active_stage_revision == Some(draft_revision) {
            "The running session already contains this exact draft revision.".to_owned()
        } else {
            "Applies binding-only changes without reconnecting controllers. If structure changed, Replace session replaces it safely."
                .to_owned()
        };

        let stop_allowed = session.reachable && session.running;
        let stop_reason = if !session.reachable {
            "The running-session state cannot be reached. The emergency key gesture still remains available."
                .to_owned()
        } else if !session.running {
            "No Play session is running.".to_owned()
        } else {
            "Ends Play and returns captured keyboards to their normal stopped-session behaviour."
                .to_owned()
        };

        let adopt_allowed = staged.reachable && staged.empty && saved_exists;
        let adopt_reason = if !staged.reachable {
            "The draft cannot be reached, so loading cannot be verified.".to_owned()
        } else if setup.is_none() {
            "The saved configuration could not be read.".to_owned()
        } else if !saved_exists {
            "There is no saved configuration to load yet.".to_owned()
        } else if !staged.empty {
            "Start over first. Loading never overwrites a draft that already has content."
                .to_owned()
        } else {
            "Loads the saved configuration into this draft for review. It does not start Play."
                .to_owned()
        };

        let discard_allowed = staged.reachable && !staged.empty;
        let discard_reason = if !staged.reachable {
            "The draft cannot be reached, so it cannot be cleared safely.".to_owned()
        } else if staged.empty {
            "This draft is already empty.".to_owned()
        } else if staged.dirty {
            "Clears this unsaved draft from memory. Saved files and any running session are not changed."
                .to_owned()
        } else {
            "Clears this draft from memory. Saved files and any running session are not changed."
                .to_owned()
        };

        Self {
            draft_label,
            draft_detail,
            draft_dirty: staged.reachable && staged.dirty,
            draft_empty: staged.reachable && staged.empty,
            saved_label,
            saved_detail,
            session: session.clone(),
            session_cls: if !session.reachable {
                "down"
            } else if session.running {
                "running"
            } else {
                "idle"
            }
            .to_owned(),
            draft_revision: staged.revision.clone(),
            active_stage_revision: session.active_stage_revision.clone().unwrap_or_default(),
            escape_line: staged.escape_hatch.clone(),
            save: RedesignActionState::new("Save", true, save_allowed, save_reason),
            // Compact dock swaps Play for Stop while running. The expanded
            // panel retains this action + reason, including the structural
            // restart path when Apply refuses.
            play: RedesignActionState::new(play_label, !session.running, play_allowed, play_reason),
            apply: RedesignActionState::new(
                "Apply changes",
                apply_allowed,
                apply_allowed,
                apply_reason,
            ),
            stop: RedesignActionState::new("Stop", session.running, stop_allowed, stop_reason),
            adopt: RedesignActionState::new("Load saved setup", true, adopt_allowed, adopt_reason),
            discard: RedesignActionState::new("Start over", true, discard_allowed, discard_reason),
        }
    }
}

fn staged_readiness_reason(staged: &ksx_api::StagedSetupView, verb: &str) -> String {
    let consequence = if verb == "save" {
        "Nothing will be written."
    } else {
        "Nothing will be started."
    };
    if staged.device.is_none() {
        return format!("Pick an input before {verb}. {consequence}");
    }
    if staged.slots.is_empty() {
        return format!("Add a controller before {verb}. {consequence}");
    }
    if staged.slots.iter().any(|slot| slot.bindings == 0) {
        return format!(
            "Every controller needs at least one mapped key before {verb}. {consequence}"
        );
    }
    if staged.blocking.is_none() {
        return format!(
            "Choose what happens to keyboard input while playing before {verb}. {consequence}"
        );
    }
    format!("Finish the setup steps before {verb}. {consequence}")
}

/// One exact held keyboard that may be released even when the draft is
/// empty.  Ambiguous identities remain visible with `can_release=false` and
/// a physical remedy instead of offering a POST that can only refuse.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignHeldCaptureRow {
    /// Stable island/list identity for this one machine row.  Recovery can
    /// outlive the selector and keyboard interface that normally identify a
    /// board, so the browser must not fall back to a display name (two
    /// identical keyboards are ordinary) or collapse empty identities into
    /// one row.
    #[serde(default)]
    pub key: String,
    pub name: String,
    pub transport: String,
    pub detail: String,
    pub selector: String,
    pub instance: String,
    pub can_release: bool,
    pub note: String,
}

/// Exact-device preparation and recovery state for the redesign shell.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignCaptureState {
    pub mode: String,
    /// Server-authored identity for compact recovery alerts.  This is either
    /// the staged device's own label or a name derived from the held rows;
    /// consumers must not join it against the separately refreshed catalog.
    #[serde(default)]
    pub device_label: String,
    pub heading: String,
    pub line: String,
    pub recovery_line: String,
    pub selector: String,
    pub instance: String,
    pub can_prepare: bool,
    pub can_release: bool,
    pub held: Vec<RedesignHeldCaptureRow>,
    /// Fully composed presentation for the persistent recovery rail and the
    /// compact state chip. These remain server-owned so SSR and a later API
    /// repaint never disagree about whether recovery is visible or what it
    /// calls the exact device.
    #[serde(default)]
    pub state_label: String,
    #[serde(default)]
    pub state_tone: String,
    #[serde(default)]
    pub attention_cls: String,
    #[serde(default)]
    pub attention_title: String,
    #[serde(default)]
    pub attention_line: String,
    #[serde(default)]
    pub attention_detail: String,
    #[serde(default)]
    pub attention_review_label: String,
    #[serde(default)]
    pub attention_retry_cls: String,
}

/// Machine-stable list identity for a held board, without exposing a Windows
/// device path in the DOM.  The ordinary release identity can be absent after
/// a driver rebind, so walk the remaining evidence from exact physical or
/// interface identifiers down to descriptive inventory facts.  Truly
/// indistinguishable rows deliberately share this base; the composer adds a
/// deterministic enumeration suffix rather than dropping either row.
fn held_capture_key_base(board: &ksx_api::BoardRow) -> String {
    let normalized = |value: &str| value.trim().to_ascii_lowercase();
    let sorted_evidence = |values: Vec<String>| {
        let mut values = values
            .into_iter()
            .map(|value| normalized(&value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        values.sort_unstable();
        values.dedup();
        values.join("\u{1f}")
    };

    let keyboard = board
        .keyboard
        .as_deref()
        .map(&normalized)
        .filter(|value| !value.is_empty());
    let physical_boards = sorted_evidence(
        board
            .interfaces
            .iter()
            .filter_map(|row| row.board.clone())
            .collect(),
    );
    let interface_instances = sorted_evidence(
        board
            .interfaces
            .iter()
            .map(|row| row.instance_id.clone())
            .collect(),
    );
    let selector = board
        .selector
        .as_deref()
        .map(&normalized)
        .filter(|value| !value.is_empty());
    let interface_selectors = sorted_evidence(
        board
            .interfaces
            .iter()
            .filter_map(|row| row.selector.clone())
            .collect(),
    );
    let release_command = board
        .release_command
        .as_deref()
        .map(&normalized)
        .filter(|value| !value.is_empty());

    let evidence = if let Some(keyboard) = keyboard {
        format!("keyboard:{keyboard}")
    } else if !physical_boards.is_empty() {
        format!("physical-board:{physical_boards}")
    } else if !interface_instances.is_empty() {
        format!("interfaces:{interface_instances}")
    } else if let Some(selector) = selector {
        format!("selector:{selector}")
    } else if !interface_selectors.is_empty() {
        format!("interface-selectors:{interface_selectors}")
    } else if let Some(release_command) = release_command {
        format!("release:{release_command}")
    } else {
        // A last-resort base still includes all honest inventory facts.  It is
        // intentionally allowed to collide for two indistinguishable boards;
        // the enumeration suffix below is the only identity claim available.
        let descriptors = sorted_evidence(
            board
                .interfaces
                .iter()
                .map(|row| {
                    format!(
                        "{}:{}:{}:{}:{}",
                        row.transport,
                        row.description,
                        row.vendor_id,
                        row.product_id,
                        row.bcd_device
                    )
                })
                .collect(),
        );
        format!(
            "fallback:{}:{}:{}:{}",
            normalized(&board.name),
            normalized(&board.transport),
            board.role.code(),
            descriptors
        )
    };

    format!("held-{}", selector_fingerprint(&evidence))
}

impl RedesignCaptureState {
    pub(crate) fn of(
        staged: &ksx_api::StagedSetupView,
        scan: Option<&ksx_api::DeviceScanView>,
        scan_error: &str,
    ) -> Self {
        let empty_scan = ksx_api::DeviceScanView::default();
        let scan_view = scan.unwrap_or(&empty_scan);
        let resolved = StartCaptureView::from_parts(staged, scan_view, scan.is_some());
        let base_mode = resolved.mode_word();

        let mut held_key_counts = std::collections::BTreeMap::<String, usize>::new();
        let held = scan
            .into_iter()
            .flat_map(|view| view.boards.iter())
            .filter(|board| board.claimed)
            .map(|board| {
                // A partial inventory is still recovery evidence.  In
                // particular, rebinding a keyboard to WinUSB can remove the
                // HID identity we would normally use to release it.  Dropping
                // that row turns "this keyboard is held" into "nothing to
                // recover" at exactly the moment a person needs the warning.
                // Keep the row, but never turn an incomplete or ambiguous
                // identity into an actionable POST.
                let selector = board.selector.as_deref().unwrap_or_default().trim();
                let instance = board.keyboard.as_deref().unwrap_or_default().trim();
                let selector_unique = scan_view
                    .boards
                    .iter()
                    .filter(|candidate| {
                        candidate
                            .selector
                            .as_deref()
                            .is_some_and(|value| value.trim() == selector)
                    })
                    .count()
                    == 1;
                let instance_unique = scan_view
                    .boards
                    .iter()
                    .flat_map(|candidate| candidate.interfaces.iter())
                    .filter(|row| row.instance_id.eq_ignore_ascii_case(instance))
                    .count()
                    == 1;
                let can_release = !selector.is_empty()
                    && !instance.is_empty()
                    && board.winusb_eligible
                    && selector_unique
                    && instance_unique;
                let note = if selector.is_empty() && instance.is_empty() {
                    "ksx can see that this device is held, but Windows did not provide a safe selector or keyboard-interface identity. Restore its HID keyboard driver in Device Manager, reconnect it, then rescan."
                        .to_owned()
                } else if selector.is_empty() {
                    "ksx cannot derive a unique selector for this held device, so automatic release is disabled. Restore its HID keyboard driver in Device Manager, reconnect it, then rescan."
                        .to_owned()
                } else if instance.is_empty() {
                    "Windows did not expose the exact held keyboard interface, so ksx will not guess. Restore this device's HID keyboard driver in Device Manager, reconnect it, then rescan."
                        .to_owned()
                } else if !board.winusb_eligible {
                    "ksx cannot verify this row as safe for automatic WinUSB release. Restore the device's HID keyboard driver in Device Manager, then rescan."
                        .to_owned()
                } else if !selector_unique && !instance_unique {
                    "Two attached devices share both recovery identities. Unplug the other matching device, rescan, then release the remaining keyboard."
                        .to_owned()
                } else if !selector_unique {
                    "Two attached devices share this selector. Unplug the other matching device, rescan, then release the remaining keyboard."
                        .to_owned()
                } else if !instance_unique {
                    "Two attached devices share this keyboard-interface identity. Unplug the other matching device, rescan, then release the remaining keyboard."
                        .to_owned()
                } else {
                    String::new()
                };
                let key_base = held_capture_key_base(board);
                let occurrence = held_key_counts.entry(key_base.clone()).or_default();
                *occurrence += 1;
                let key = if *occurrence == 1 {
                    key_base
                } else {
                    format!("{key_base}-{}", *occurrence)
                };
                RedesignHeldCaptureRow {
                    key,
                    name: board.name.clone(),
                    transport: board.transport_label.clone(),
                    detail: "Held by ksx · normal typing is unavailable until release".to_owned(),
                    selector: selector.to_owned(),
                    instance: instance.to_owned(),
                    can_release,
                    note,
                }
            })
            .collect::<Vec<_>>();

        let exact_held = held.iter().find(|row| {
            row.selector == resolved.expected_selector
                && row.instance.eq_ignore_ascii_case(&resolved.instance_id)
        });
        let (mut mode, mut heading, mut line, mut recovery_line, mut selector, mut instance, can_prepare, mut can_release) =
            match base_mode {
                "ready" => (
                    "ready".to_owned(),
                    "Ready for input".to_owned(),
                    "This input is on the Windows keyboard path and ready for ksx.".to_owned(),
                    String::new(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    false,
                    false,
                ),
                "prepare-optional" => (
                    "prepare-optional".to_owned(),
                    "Ready · direct capture available".to_owned(),
                    "Windows input works now. Direct WinUSB capture is available but optional."
                        .to_owned(),
                    String::new(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    true,
                    false,
                ),
                "prepare" => (
                    "prepare".to_owned(),
                    "Preparation required".to_owned(),
                    "Prepare this input before Save or Play so the draft and Windows use the same capture path."
                        .to_owned(),
                    "Keep a second keyboard available while Windows changes this device's driver."
                        .to_owned(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    true,
                    false,
                ),
                "release" => (
                    "release".to_owned(),
                    "Prepared for direct capture".to_owned(),
                    "This input is ready for ksx. Release returns it to normal Windows typing."
                        .to_owned(),
                    String::new(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    false,
                    true,
                ),
                "held" => (
                    "held".to_owned(),
                    "Capture state needs recovery".to_owned(),
                    "Windows says ksx holds this input, but the draft expects ordinary keyboard input."
                        .to_owned(),
                    "Release it, then continue with the ordinary input path or prepare it again deliberately."
                        .to_owned(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    false,
                    exact_held.is_some_and(|row| row.can_release),
                ),
                "blocked" if scan.is_none() => (
                    "unavailable".to_owned(),
                    "Capture status unavailable".to_owned(),
                    "ksx could not verify how this exact input is connected.".to_owned(),
                    if scan_error.trim().is_empty() {
                        "Rescan devices or reopen ksx before Save or Play.".to_owned()
                    } else {
                        scan_error.to_owned()
                    },
                    resolved.expected_selector,
                    resolved.instance_id,
                    false,
                    false,
                ),
                "blocked" => (
                    "blocked".to_owned(),
                    "Capture path not verified".to_owned(),
                    "ksx cannot match the staged input to one exact keyboard interface."
                        .to_owned(),
                    "Reconnect or rescan the input. ksx will not guess between devices."
                        .to_owned(),
                    resolved.expected_selector,
                    resolved.instance_id,
                    false,
                    false,
                ),
                _ => (
                    "none".to_owned(),
                    "No input selected".to_owned(),
                    "Pick the keyboard or encoder this setup will listen to.".to_owned(),
                    String::new(),
                    String::new(),
                    String::new(),
                    false,
                    false,
                ),
            };

        // Machine-keyed way back: a WinUSB keyboard can be stranded while
        // the daemon has no draft at all.  Promote one unambiguous held row
        // into the primary control while retaining every held row below it.
        // If none is safe to post, still promote the recovery fact: silence
        // would imply that choosing a new input is the only work left while a
        // physical keyboard remains unusable.
        if mode == "none" {
            let mut releasable = held.iter().filter(|row| row.can_release);
            if let Some(row) = releasable.next() {
                if releasable.next().is_none() {
                    mode = "release-held".to_owned();
                    heading = "Keyboard held by ksx".to_owned();
                    line = format!("{} cannot type normally until it is released.", row.name);
                    selector = row.selector.clone();
                    instance = row.instance.clone();
                    can_release = true;
                    recovery_line = "This keyboard is held outside the current draft. Release is resolved from the live device tree."
                        .to_owned();
                } else {
                    mode = "held".to_owned();
                    heading = "Keyboards held by ksx".to_owned();
                    line = "More than one keyboard is held. Choose the exact recovery row below."
                        .to_owned();
                    recovery_line = "Each Release action is resolved independently from the current Windows device tree."
                        .to_owned();
                }
            } else if !held.is_empty() {
                mode = "held".to_owned();
                heading = "Held input needs manual recovery".to_owned();
                line = "ksx can see a held input, but cannot identify one exact interface safely enough to release it automatically."
                    .to_owned();
                recovery_line = "Follow the recovery note on each device below. ksx will not guess between incomplete identities."
                    .to_owned();
            }
        }

        let device_label = if let Some(device) = staged.device.as_ref() {
            let label = device.label.trim();
            if label.is_empty() {
                "Selected input".to_owned()
            } else {
                label.to_owned()
            }
        } else if mode == "release-held" {
            held.iter()
                .find(|row| {
                    row.selector == selector && row.instance.eq_ignore_ascii_case(&instance)
                })
                .map(|row| row.name.clone())
                .unwrap_or_else(|| "Held keyboard".to_owned())
        } else {
            match held.as_slice() {
                [] => String::new(),
                [row] => row.name.clone(),
                _ => "Multiple held keyboards".to_owned(),
            }
        };

        let (state_label, state_tone) = match mode.as_str() {
            "prepare" => ("Preparation required", "attention"),
            "release" => ("Prepared", "ready"),
            "ready" | "prepare-optional" => ("Ready", "ready"),
            "none" => ("No input", "stopped"),
            _ => ("Action required", "attention"),
        };
        let is_attention_mode = matches!(
            mode.as_str(),
            "prepare" | "held" | "blocked" | "unavailable" | "release-held"
        );
        let additional_held = held
            .iter()
            .filter(|row| {
                row.selector.is_empty()
                    || row.instance.is_empty()
                    || row.selector != selector
                    || !row.instance.eq_ignore_ascii_case(&instance)
            })
            .collect::<Vec<_>>();
        let attention_visible = is_attention_mode || !additional_held.is_empty();
        let attention_rows = if is_attention_mode {
            held.iter().collect::<Vec<_>>()
        } else {
            additional_held.clone()
        };
        let attention_device = if is_attention_mode {
            if device_label.is_empty() {
                "Selected input".to_owned()
            } else {
                device_label.clone()
            }
        } else if let [row] = additional_held.as_slice() {
            row.name.clone()
        } else {
            format!("{} held keyboards", additional_held.len())
        };
        let attention_heading = if is_attention_mode {
            heading.clone()
        } else if additional_held.len() == 1 {
            "Another keyboard needs recovery".to_owned()
        } else {
            "Other keyboards need recovery".to_owned()
        };
        let attention_line = if is_attention_mode {
            line.clone()
        } else if let [row] = additional_held.as_slice() {
            format!(
                "{} is held by ksx and cannot type normally until it is recovered.",
                row.name
            )
        } else {
            format!(
                "{} keyboards are held by ksx and need individual recovery.",
                additional_held.len()
            )
        };
        let mut attention_detail = if is_attention_mode {
            recovery_line.clone()
        } else if let [row] = additional_held.as_slice() {
            if row.note.is_empty() {
                "Review this exact device before returning it to ordinary typing.".to_owned()
            } else {
                row.note.clone()
            }
        } else {
            "Review each exact device before returning it to ordinary typing.".to_owned()
        };
        if is_attention_mode && !additional_held.is_empty() {
            let other = match additional_held.len() {
                1 => "One other keyboard also needs recovery in Setup.".to_owned(),
                count => format!("{count} other keyboards also need recovery in Setup."),
            };
            if attention_detail.is_empty() {
                attention_detail = other;
            } else {
                attention_detail = format!("{attention_detail} {other}");
            }
        }
        let attention_review_label = if mode == "prepare" {
            "Review preparation"
        } else if attention_rows.len() == 1 && attention_rows[0].can_release {
            "Review release"
        } else {
            "Review recovery"
        };
        let attention_retry_cls = if matches!(mode.as_str(), "blocked" | "unavailable") {
            "rd-panel-action rd-attention-retry"
        } else {
            "rd-panel-action rd-attention-retry none"
        };

        Self {
            mode,
            device_label,
            heading,
            line,
            recovery_line,
            selector,
            instance,
            can_prepare,
            can_release,
            held,
            state_label: state_label.to_owned(),
            state_tone: state_tone.to_owned(),
            attention_cls: if attention_visible {
                "rd-attention"
            } else {
                "rd-attention none"
            }
            .to_owned(),
            attention_title: format!("{attention_device} · {attention_heading}"),
            attention_line,
            attention_detail,
            attention_review_label: attention_review_label.to_owned(),
            attention_retry_cls: attention_retry_cls.to_owned(),
        }
    }

    pub(crate) fn ready_for_commit(&self) -> bool {
        matches!(self.mode.as_str(), "ready" | "prepare-optional" | "release")
    }

    fn commit_blocker(&self) -> String {
        match self.mode.as_str() {
            "prepare" => "Prepare the selected input before Save or Play.".to_owned(),
            "held" => "Release the held input so Windows and the draft agree before Save or Play."
                .to_owned(),
            "unavailable" => {
                "The exact capture path could not be verified. Rescan or reopen ksx before Save or Play."
                    .to_owned()
            }
            _ => "The selected input is not ready for capture. Reconnect or rescan it before Save or Play."
                .to_owned(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignJourneyStep {
    pub key: String,
    /// Stable destination/verb for a clickable journey row.  The browser must
    /// never infer navigation from the customer-facing title or blocker copy.
    #[serde(default)]
    pub action: String,
    pub title: String,
    pub detail: String,
    pub badge: String,
    pub cls: String,
    /// Literal ARIA state for the list renderer; list-row ternaries cannot be
    /// evaluated safely by Forma's server compiler.
    #[serde(default)]
    pub aria_current: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignJourney {
    pub compact: String,
    pub line: String,
    pub rows: Vec<RedesignJourneyStep>,
}

impl RedesignJourney {
    pub(crate) fn of(
        staged: &ksx_api::StagedSetupView,
        session: &crate::control::SessionView,
        capture: &RedesignCaptureState,
        play: &RedesignActionState,
    ) -> Self {
        if !staged.reachable {
            return Self {
                compact: "Progress unavailable".to_owned(),
                line: "Setup progress is unavailable until the ksx background helper returns."
                    .to_owned(),
                rows: [
                    ("input", "Pick the input"),
                    ("controller", "Add controllers"),
                    ("mapping", "Map the controls"),
                    ("play", "Play"),
                ]
                .into_iter()
                .map(|(key, title)| {
                    redesign_journey_step(
                        key,
                        "retry",
                        title,
                        "Waiting for the background helper.",
                        "Unavailable",
                        "blocked",
                    )
                })
                .collect(),
            };
        }

        let input_selected = staged.device.is_some();
        let input_done = input_selected && capture.ready_for_commit();
        let controllers_done = !staged.slots.is_empty();
        // Every slot, not merely ANY slot.  The old rail's `any` made a
        // two-player setup look mapped while player two would plug dead.
        let mapping_done = controllers_done
            && staged.slots.iter().all(|slot| slot.bindings > 0)
            && staged.blocking.is_some();
        let running = session.reachable && session.running;

        let facts = [input_done, controllers_done, mapping_done, running];
        let next = facts.iter().position(|done| !done);
        let input_label = staged
            .device
            .as_ref()
            .map(|device| device.label.trim())
            .filter(|label| !label.is_empty())
            .unwrap_or("The selected input");
        let recovery_without_input =
            !input_selected && matches!(capture.mode.as_str(), "held" | "release-held");
        let input_title = if input_done {
            "Input ready"
        } else if capture.mode == "release-held" {
            "Release the held input"
        } else if capture.mode == "held" {
            "Recover the held input"
        } else if !input_selected {
            "Pick the input"
        } else if capture.mode == "prepare" {
            "Prepare the input"
        } else {
            "Resolve the input"
        };
        let input_done_detail =
            format!("{input_label} is selected and its exact capture path is ready.");
        let input_todo_detail = if recovery_without_input {
            let state = capture.line.trim();
            if state.is_empty() {
                "A keyboard is still held by ksx and must be recovered before setup continues."
                    .to_owned()
            } else {
                state.to_owned()
            }
        } else if !input_selected {
            "Choose the keyboard or encoder this setup listens to.".to_owned()
        } else {
            let state = capture.line.trim();
            if state.is_empty() {
                format!(
                    "{input_label} is selected, but its exact capture path still needs attention."
                )
            } else {
                format!("{input_label} is selected. {state}")
            }
        };
        let mut rows = Vec::with_capacity(4);
        for (index, (key, title, done_detail, todo_detail)) in [
            (
                "input",
                input_title,
                input_done_detail.as_str(),
                input_todo_detail.as_str(),
            ),
            (
                "controller",
                "Add controllers",
                "At least one virtual controller is staged.",
                "Add the virtual controllers this input will drive.",
            ),
            (
                "mapping",
                "Map the controls",
                "Every staged controller has live bindings and input behaviour is chosen.",
                "Give every controller at least one live key binding and choose what happens to keyboard input.",
            ),
            (
                "play",
                "Play",
                "The virtual controllers are running.",
                play.reason.as_str(),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let action = match key {
                "input" if capture.mode == "unavailable" => "retry",
                "input" if (input_selected || recovery_without_input) && !input_done => "capture",
                "input" => "devices",
                "controller" => "controllers",
                "mapping" => "mapping",
                "play" => "play",
                _ => "retry",
            };
            let (badge, cls, detail) = if facts[index] {
                ("Done", "done", done_detail)
            } else if Some(index) == next {
                if key == "input" && input_selected && capture.mode == "prepare" {
                    ("Prepare", "now", todo_detail)
                } else if key == "input" && (input_selected || recovery_without_input) {
                    ("Action required", "blocked", todo_detail)
                } else if key == "play" && !play.allowed {
                    ("Blocked", "blocked", todo_detail)
                } else {
                    ("Now", "now", todo_detail)
                }
            } else {
                ("Next", "later", todo_detail)
            };
            rows.push(redesign_journey_step(
                key, action, title, detail, badge, cls,
            ));
        }
        let line = if running {
            if facts.iter().all(|done| *done) {
                "Playing now. Stop returns the captured input to its stopped-session behaviour."
                    .to_owned()
            } else {
                "A session is playing, but the current draft still has unfinished setup work. Stop ends the running session; the draft remains available to finish."
                    .to_owned()
            }
        } else if let Some(row) = rows
            .iter()
            .find(|row| row.badge != "Done" && row.badge != "Next")
        {
            format!("Next: {}", row.detail)
        } else {
            "The setup is ready to play.".to_owned()
        };
        // This is a completion COUNT, not the ordinal number of the first
        // incomplete row.  Controllers and mappings can already exist when a
        // device is changed or removed; calling that state "1/4" claimed the
        // later work had vanished even while its rows correctly said Done.
        let completed = facts.iter().filter(|done| **done).count();
        let compact_state = if running && completed == facts.len() {
            "Playing"
        } else if running {
            "Session playing · draft incomplete"
        } else if !input_done {
            match capture.mode.as_str() {
                "prepare" => "Preparation required",
                "held" => "Recovery required",
                "release-held" => "Release required",
                _ if !input_selected => "Pick input",
                _ => "Input needs attention",
            }
        } else if !controllers_done {
            "Add controllers"
        } else if !mapping_done {
            "Map controls"
        } else if play.allowed {
            "Ready to play"
        } else {
            "Play blocked"
        };
        let compact = format!("{completed}/4 complete · {compact_state}");
        Self {
            compact,
            line,
            rows,
        }
    }
}

fn redesign_journey_step(
    key: &str,
    action: &str,
    title: &str,
    detail: &str,
    badge: &str,
    cls: &str,
) -> RedesignJourneyStep {
    RedesignJourneyStep {
        key: key.to_owned(),
        action: action.to_owned(),
        title: title.to_owned(),
        detail: detail.to_owned(),
        badge: badge.to_owned(),
        cls: format!("rd-journey-step {cls}"),
        aria_current: if matches!(badge, "Done" | "Next") {
            "false"
        } else {
            "step"
        }
        .to_owned(),
    }
}

/// One staged controller on the workbench — a card per slot, straight off
/// [`ksx_api::StagedSetupView`]. The daemon's slot order IS the play order:
/// pads plug in this order at session start, and Windows hands each XInput
/// pad the lowest FREE user index at that moment — so the number chip is the
/// authored order, while the actual P-light is discovered at Play (ViGEm's
/// notification callback; `ksx-core/slot.rs` — "never derived from this
/// number").
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignControllerCard {
    /// The daemon's slot number, as text (a list body is bare member reads).
    pub number: String,
    /// The persona code (`xbox360` | `playstation` | …) for family styling —
    /// presentation routes on this, never on the label's words.
    pub persona: String,
    pub persona_label: String,
    pub preset: String,
    /// What this slot costs at Play, in one served sentence: an XInput
    /// persona occupies one of Windows' four XInput slots; a HID persona
    /// takes none of them.
    pub api_line: String,
    /// The presentation family, from the ONE total [`pad_presentation`]
    /// record — never re-decided in the browser. `"unknown"` means "draw a
    /// named placeholder, not a wrong silhouette" (the record's rule).
    #[serde(default)]
    pub family: String,
    /// The vendored body drawing for that family (`/_assets/pad-*.svg`),
    /// served beside it so the two can never disagree.
    #[serde(default)]
    pub art: String,
}

/// One persona the picker offers — or honestly refuses to, reason attached.
/// Unavailable personas stay listed: a menu that silently drops choices
/// teaches a user the product has fewer (the nocturne create form's rule).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignPersonaRow {
    pub name: String,
    pub label: String,
    pub api: String,
    pub note: String,
    pub cls: String,
    /// `"true"` when this persona can be added RIGHT NOW — the daemon's
    /// `can_plug && available`, served as a word so the island routes on a
    /// fact instead of parsing a class string.
    pub usable: String,
}

/// The controller picker's truth and the workbench's staged cards, composed
/// from the ONE [`ksx_api::StagedSetupView`] the collector already holds —
/// every ceiling (`max_slots`, `max_xinput_slots`) and every availability
/// flag is the daemon's, served, never re-derived here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignControllers {
    pub cards: Vec<RedesignControllerCard>,
    pub personas: Vec<RedesignPersonaRow>,
    /// `next_preset`, served because it becomes a FILE NAME (stage.rs's
    /// rule); empty when every slot is staged.
    pub add_preset: String,
    /// The layout the add verb dresses a fresh slot in — the served default,
    /// so a first-run controller binds keys and is playable without a mapper
    /// (MAPPER-UX commandment 9).
    pub add_layout: String,
    /// The lede over the picker: what adding does, or why nothing can be
    /// added (full / unreachable), in the server's words.
    pub add_note: String,
    /// "N of M slots staged · X of Y Xbox (XInput)" — every number served.
    pub counts_line: String,
    pub reachable: bool,
    /// The ghost ids whose parked slot the server still HOLDS (authoring
    /// included) — set by the collector from the studio's parked store, so
    /// a ghost card can say "bindings kept" or "staged fresh" truthfully
    /// BEFORE the press. A daemon restart empties it.
    #[serde(default)]
    pub parked_held: Vec<String>,
    /// Every staged controller's canvas dressing — the SAME
    /// [`NocturnePadView`] rows `/nocturne`'s widgets clone and dress
    /// (family, fn→keys callouts, honest mapping availability), from the one
    /// [`compose_pad_views`] composer.
    #[serde(default)]
    pub pads: Vec<NocturnePadView>,
    /// The selected controller's whole panel — meta words, six bind groups,
    /// free-control chips, SOCD editor — the SAME [`ControllerPanel`]
    /// `/nocturne`'s right pane serves, from the one composer.
    #[serde(default)]
    pub panel: ControllerPanel,
    /// The panel's other reading: the BY-KEY view, from the one
    /// [`compose_key_panel`] composer, over the standard board (this page
    /// has no board picker yet — the keyboard migration brings it).
    #[serde(default)]
    pub keys: KeyPanel,
    /// The selected slot's macro lifecycle rows — the SAME
    /// [`compose_macro_rows`] serving `/nocturne`'s pane, with this page's
    /// own edit door.
    #[serde(default)]
    pub macros_head: String,
    #[serde(default)]
    pub macro_rows: Vec<NocturneMacroRow>,
    #[serde(default)]
    pub macros_note: String,
    /// The macro STEP EDITOR's whole projection, when `?macro=` names one
    /// on the selected slot — [`crate::macro_editor::NocturneMacroEditor`],
    /// closed otherwise (the nocturne rule: an unknown name leaves the
    /// dialog closed rather than inventing a macro).
    #[serde(default)]
    pub mac: crate::macro_editor::NocturneMacroEditor,
    /// The short server-held undo window after a removal (the nocturne
    /// chip's contract: no browser state, a reload keeps the offer).
    #[serde(default)]
    pub undo_cls: String,
    #[serde(default)]
    pub undo_label: String,
}

impl RedesignControllers {
    pub fn of(
        staged: &ksx_api::StagedSetupView,
        selected_slot: Option<u8>,
        undo_label: Option<&str>,
        macro_selected: Option<&str>,
        q: Option<&str>,
    ) -> Self {
        // The nocturne selection rule verbatim: an explicit `?slot=` wins,
        // otherwise the first staged controller speaks for the pane.
        let selected = selected_slot
            .and_then(|number| staged.slots.iter().find(|slot| slot.number == number))
            .or_else(|| staged.slots.first());
        let panel = compose_controller_panel(staged, selected, q);
        // The macro lifecycle rows + the step editor, exactly nocturne's
        // composition: the editor opens only on a name `?macro=` carries AND
        // the selected slot actually has.
        let (macros_head, macro_rows, macros_note) = compose_macro_rows(selected, "/redesign");
        let keyboard_name = staged
            .device
            .as_ref()
            .map(|device| device.label.as_str())
            .unwrap_or("(none)");
        let mac = match (selected, macro_selected) {
            (Some(slot), Some(name)) if !name.is_empty() => {
                let snap = ksx_api::staged_macro_snapshot(slot);
                let mapper = ksx_api::staged_mapper_slot(slot, keyboard_name).ok();
                snap.macros
                    .iter()
                    .find(|m| m.name == name)
                    .map(|m| {
                        crate::macro_editor::NocturneMacroEditor::compose(
                            m,
                            &slot.persona,
                            mapper.as_ref(),
                            slot.number,
                            q,
                            "/redesign",
                        )
                    })
                    .unwrap_or_else(|| {
                        crate::macro_editor::NocturneMacroEditor::closed_on("/redesign")
                    })
            }
            _ => crate::macro_editor::NocturneMacroEditor::closed_on("/redesign"),
        };
        // The Keys tab over the STANDARD board (no saved choice, no panel
        // stores, no encoder staged): the same fallback nocturne draws when
        // nothing is chosen. The board picker arrives with the keyboard
        // migration.
        let keys = compose_key_panel(
            staged,
            selected,
            &crate::board::Board::resolve("", &[], &[], false),
        );
        let pads = compose_pad_views(staged, "/redesign");
        let (undo_cls, undo_label) = match undo_label {
            Some(label) => ("rd-undochip".to_owned(), label.to_owned()),
            None => ("rd-undochip none".to_owned(), String::new()),
        };
        let cards = staged
            .slots
            .iter()
            .map(|slot| {
                let presentation = pad_presentation(&slot.persona);
                RedesignControllerCard {
                    number: slot.number.to_string(),
                    persona: slot.persona.clone(),
                    persona_label: slot.persona_label.clone(),
                    preset: slot.preset.clone(),
                    api_line: if slot.is_xinput {
                        "XInput — takes one of Windows' four XInput slots at Play".to_owned()
                    } else {
                        "HID — no XInput slot; games and Steam see it by connection order"
                            .to_owned()
                    },
                    family: presentation.family.to_owned(),
                    art: presentation.art.to_owned(),
                }
            })
            .collect();
        let personas = staged
            .personas
            .iter()
            .map(|persona| {
                let usable = staged.reachable && persona.can_plug && persona.available;
                RedesignPersonaRow {
                    name: persona.name.clone(),
                    label: persona.label.clone(),
                    api: if persona.is_xinput {
                        format!("{} · XInput", persona.backend_label)
                    } else {
                        persona.backend_label.clone()
                    },
                    note: persona
                        .unavailable_reason
                        .clone()
                        .or_else(|| persona.gap.clone())
                        .unwrap_or_default(),
                    cls: if usable { "n-dev" } else { "n-dev off" }.to_owned(),
                    usable: if usable { "true" } else { "false" }.to_owned(),
                }
            })
            .collect();
        let add_note = if !staged.reachable {
            staged
                .error
                .clone()
                .unwrap_or_else(|| "The daemon is not answering.".to_owned())
        } else if staged.next_slot.is_none() {
            // The nocturne create form's own full-house sentence, verbatim.
            "Every controller slot is staged. Remove one to add another.".to_owned()
        } else {
            "Adding stages the next slot — nothing is saved or started until Play.".to_owned()
        };
        Self {
            counts_line: format!(
                "{} of {} slots staged · {} of {} Xbox (XInput)",
                staged.slots.len(),
                staged.max_slots,
                staged.xinput_used,
                staged.max_xinput_slots,
            ),
            add_preset: staged.next_preset.clone().unwrap_or_default(),
            add_layout: staged.default_layout.clone(),
            add_note,
            reachable: staged.reachable,
            cards,
            personas,
            // The studio's parked store is not a daemon read; the collector
            // overlays the held ids (`server/redesign.rs`), the same way the
            // daemon overlays `dirty`/`origin` on the staged view.
            parked_held: Vec::new(),
            pads,
            panel,
            keys,
            macros_head,
            macro_rows,
            macros_note,
            mac,
            undo_cls,
            undo_label,
        }
    }
}

/// The workbench device roster — what `/redesign`'s picker offers, tiered by
/// the product's scan rules (pickable → selector → role →
/// looks_like_a_keyboard; a board failing the first two
/// lands in `other` with a name and a meta line and nothing else — that is
/// exactly where a recognised encoder with no keyboard collection ends up,
/// so the family name has to ride in the meta or it is not said anywhere).
///
/// The rules and the verdict sentences are copied from that loop rather than
/// extracted because the two pages disagree ONLY in the verb: `/nocturne`'s
/// canvas holds one staged board ("replaces the current one"), the workbench
/// holds several at once — so the row copy differs while the tiering and the
/// verdicts stay word-for-word. Drift between the two loops is a defect;
/// they sit in this one file so a change to either is a diff on both.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedesignDeviceRows {
    pub keyboards: Vec<NocturneDeviceRow>,
    pub encoders: Vec<NocturneDeviceRow>,
    pub experimental: Vec<NocturneDeviceRow>,
    pub other: Vec<NocturneOtherRow>,
    /// The four fold headers ("… · N") and visibility classes; an empty tier
    /// hides its fold entirely, exactly like the nocturne device folds.
    pub keyboards_head: String,
    pub keyboards_fold_cls: String,
    pub encoders_head: String,
    pub encoders_fold_cls: String,
    pub exp_head: String,
    pub exp_fold_cls: String,
    pub other_head: String,
    pub other_fold_cls: String,
    /// One sentence over the whole picker: the scan's own summary, or — when
    /// the read refused — the refusal with its remedy, so an empty modal
    /// never impersonates an empty machine.
    pub scan_line: String,
    /// `true` only when the scan answered. Missing rows are authoritative
    /// absence only in that state; on refusal, remembered canvas cards must
    /// remain present with an unknown-status treatment.
    pub scan_authoritative: bool,
    /// Whether the daemon answered the separate staging read. An unreachable
    /// daemon is not the same as "nothing staged" and must disable Stage
    /// actions with its reason instead of clearing the current mark.
    pub staging_reachable: bool,
    /// Authored, safe UI copy when staging is unreachable. Never the raw
    /// control-channel/provider diagnostic.
    pub staging_line: String,
}

impl RedesignDeviceRows {
    /// `scan: None` means the read REFUSED (`unavailable` carries its
    /// sentence); an empty board list inside `Some` is a real answer on a
    /// machine with nothing plugged in. `staged` is the daemon's staged
    /// device selector — the ONE board ksx splits — marked onto its row as
    /// `aria_current: "true"` (a served daemon fact, distinct from the
    /// browser's own workbench membership, which the client decorates).
    pub fn of(
        scan: Option<&ksx_api::DeviceScanView>,
        unavailable: &str,
        staged: Option<&str>,
    ) -> Self {
        let scan_authoritative = scan.is_some();
        let fold = |n: usize| {
            if n == 0 {
                "n-devfold none".to_owned()
            } else {
                "n-devfold".to_owned()
            }
        };
        let mut keyboards = Vec::new();
        let mut encoders = Vec::new();
        let mut experimental = Vec::new();
        let mut other = Vec::new();
        if let Some(scan) = scan {
            for b in &scan.boards {
                if !b.pickable {
                    other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: format!("{} · {}{}", b.transport_label, b.backends, identity_meta(b)),
                    });
                    continue;
                }
                let Some(selector) = b.selector.clone() else {
                    other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: format!("{}{}", b.backends, identity_meta(b)),
                    });
                    continue;
                };
                // The verdict, verbatim from the nocturne roster loop: an
                // encoder's reachable HID interface proves nothing about its
                // chart, and this row must not call an unread — or
                // deliberately cleared — EEPROM chart "ready".
                let verdict = if b.claimed {
                    "Held by ksx"
                } else if b.role == ksx_api::BoardRole::PanelEncoder {
                    if b.chart_readable {
                        "Connected · chart not read yet"
                    } else {
                        "Connected · outputs not checked"
                    }
                } else if b.cannot_type_line.trim().is_empty() {
                    "Ready to use"
                } else {
                    "Cannot type right now"
                };
                // The staged compare, exactly the preparation-preserving
                // guard's (`choose_device_preserving_preparation`): selector
                // alone, trimmed, never empty-equals-empty.
                let is_staged =
                    staged.is_some_and(|s| !s.trim().is_empty() && s.trim() == selector.trim());
                let row = NocturneDeviceRow {
                    cls: "n-dev".to_owned(),
                    name: b.name.clone(),
                    meta: format!("{} · {}{}", b.transport_label, verdict, identity_meta(b)),
                    // `aria_current` carries the DAEMON fact — this board is
                    // the staged one, the board ksx splits. Workbench
                    // membership is the browser's own arrangement state and
                    // rides a different channel (aria-pressed, client-set):
                    // the two facts are different answers and stay apart.
                    aria_current: if is_staged { "true" } else { "false" }.to_owned(),
                    title: {
                        let verb = "Add this board to the workbench — several can share it. \
                                    Nothing is saved or started.";
                        if b.profile_detail.is_empty() || b.family_label.is_none() {
                            verb.to_owned()
                        } else {
                            format!("{verb} {}", b.profile_detail)
                        }
                    },
                    chart_readable: if b.chart_readable { "true" } else { "false" }.to_owned(),
                    family_id: b.family_id.clone(),
                    protocol_profile: b.protocol_profile.clone(),
                    profile_state: b.profile_state.clone(),
                    terminal_count: b.terminal_count,
                    role: b.role.code().to_owned(),
                    connection_label: device_connection_label(&selector),
                    selector,
                    alias: b.alias_hint.clone(),
                    label: b.name.clone(),
                    capture_badge: String::new(),
                    capture_state: String::new(),
                    capture_cls: String::new(),
                };
                if b.role == ksx_api::BoardRole::PanelEncoder {
                    encoders.push(row);
                } else if b.looks_like_a_keyboard {
                    keyboards.push(row);
                } else {
                    experimental.push(row);
                }
            }
        }
        Self {
            keyboards_head: format!("Keyboards · {}", keyboards.len()),
            keyboards_fold_cls: fold(keyboards.len()),
            encoders_head: format!("Panel encoders · {}", encoders.len()),
            encoders_fold_cls: fold(encoders.len()),
            exp_head: format!("Not keyboards — experimental · {}", experimental.len()),
            exp_fold_cls: fold(experimental.len()),
            other_head: format!("Unavailable devices · {}", other.len()),
            other_fold_cls: fold(other.len()),
            scan_line: match scan {
                Some(s) => s.boards_summary.clone(),
                None => unavailable.to_owned(),
            },
            scan_authoritative,
            // Direct roster composition assumes its caller has an
            // authoritative staging read. `render_redesign::payload` replaces
            // these two fields from the actual StagedSetupView.
            staging_reachable: true,
            staging_line: String::new(),
            keyboards,
            encoders,
            experimental,
            other,
        }
    }
}

/// What `GET /api/pads` serves AND what the pads island's props carry — the
/// same one-struct-one-serializer rule as [`StatusPayload`], parity pinned in
/// `render_pads.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadsPayload {
    /// The bus, its children, and both verbs' preconditions — one
    /// `MachineSource::pads_view` call, never re-derived here.
    pub pads: ksx_api::PadsView,
    /// Whether the daemon answers at all. Not a precondition for this page:
    /// the pad list and the prune plan are collector reads, and the session is
    /// shown because a running one is what REFUSES both verbs.
    pub session: crate::control::SessionView,
    /// Is the destructive panel armed (`/pads?confirm=1`)?
    ///
    /// Always `false` from `/api/pads` — a poll is not a user saying yes, and
    /// a poll that could re-arm a prune would make the confirm panel reappear
    /// after someone had deliberately navigated away from it.
    #[serde(default)]
    pub confirm: bool,
    /// Why the machine read failed, if it did. Rendered as a banner instead of
    /// an empty pad list, which would read as "your bus is clean".
    #[serde(default)]
    pub unavailable: Option<String>,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/pads`, `Some` only in the page-render props.
    pub flash: Option<String>,
}

/// What `GET /api/devices` serves AND what the `/devices` island's props
/// carry — the same one-struct-one-serializer rule as [`StatusPayload`],
/// parity pinned in `render_devices.rs`.
///
/// The scan and the reason it is missing are SEPARATE fields on purpose. An
/// empty `DeviceScanView` is a real answer on a machine with nothing plugged
/// in; it is also what a refusal would degrade to if the two were collapsed,
/// and "no boards found" on a machine with four boards is the worst possible
/// lie for this page to tell. [`Self::unavailable`] non-empty means the view
/// below is not a reading of anything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesPayload {
    pub scan: ksx_api::DeviceScanView,
    /// **What ksx left behind**, from `MachineSource::winusb_residue`. A
    /// SEPARATE read from the scan and deliberately so: the device tree is the
    /// thing that looks healthy while the receipt store disagrees with it, and
    /// a page that only ever read the tree is why nine stale receipts sat
    /// unreported on an affected machine.
    #[serde(default)]
    pub residue: ksx_api::WinusbResidueView,
    /// Session state, for the header pill and for the one caution this page
    /// owes a running cabinet: a `[[device]]` edit lands in `config.toml`, and
    /// the session already running keeps the devices it opened until it is
    /// restarted.
    pub session: crate::control::SessionView,
    /// Empty when the scan answered. Otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/devices` — a poll is not an action.
    pub flash: Option<String>,
}

/// The setup page's read: `ksx_api::MachineSource::setup_state`, plus the one
/// fact a bare `Result` cannot carry into a template — WHY there is nothing.
///
/// The same shape, and the same reason, as [`MapperSnapshot::unavailable`]: a
/// provider that refuses must produce a page that SAYS so, not an empty
/// checklist that looks like a machine with nothing configured. Those two
/// states are opposite advice ("import a config" vs "this build has no machine
/// provider") and a blank page gives the wrong one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupSnapshot {
    /// The machine provider answered.
    pub available: bool,
    /// Where the facts came from, or — with `available` false — why there are
    /// none. Rendered either way.
    pub source: String,
    pub view: ksx_api::SetupView,
}

impl SetupSnapshot {
    pub fn ready(view: ksx_api::SetupView) -> Self {
        Self {
            available: true,
            source: "read from this machine's config root".to_owned(),
            view,
        }
    }

    /// No setup facts; `reason` renders where the checklist would be.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            source: reason.to_owned(),
            view: ksx_api::SetupView::default(),
        }
    }
}

/// **Every `createShow` boolean on `/setup`, decided once, in Rust.**
///
/// Same rule and same reason as [`SetupLines`]: the seam injects these into the
/// SSR paint and `SetupIsland.ts` assigns them straight into its signals, so
/// the learner partition and the "is this readable" gate cannot be true on one
/// side of the seam and false on the other.
///
/// The two flash booleans are deliberately NOT here: a flash is one-shot action
/// feedback the client owns (it clears itself on a timer), so it is not a fact
/// about the machine and a poll must never rewrite it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupFlags {
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    pub no_daemon: bool,
    /// The machine provider REFUSED. Everything that would state a fact about
    /// this machine is gated off by it.
    pub setup_down: bool,
    /// The machine provider answered — the gate every inventory row, every
    /// checklist row and every "nothing here yet" sentence sits behind.
    pub setup_known: bool,
    pub first_run: bool,
    pub configured: bool,
    pub can_wire: bool,
    pub cannot_wire: bool,
    pub prove_down: bool,
    pub prove_listening: bool,
    pub prove_hit: bool,
    pub prove_idle: bool,
    pub has_boards: bool,
    pub no_boards: bool,
    pub has_slots: bool,
    pub no_slots: bool,
    pub has_notes: bool,
}

impl SetupFlags {
    pub fn of(
        setup: &SetupSnapshot,
        session: &crate::control::SessionView,
        learn: &crate::control::LearnView,
    ) -> Self {
        let view = &setup.view;
        let available = setup.available;

        // "Can this page write a slot?" is three facts now: a config we could
        // READ, a daemon to take the write, and a preset for the slot to point
        // at. A menu with no options and a live button is the shape that makes
        // a user think they did something.
        let wireable = available && session.reachable && !view.presets.is_empty();

        let listener_down = !session.reachable || learn.state == "unavailable";
        let listening = !listener_down && learn.state == "listening";
        let hit = !listener_down && learn.state == "hit";

        Self {
            pill_running: session.reachable && session.running,
            pill_idle: session.reachable && !session.running,
            pill_down: !session.reachable,
            no_daemon: !session.reachable,
            setup_down: !available,
            setup_known: available,
            first_run: available && !view.config_exists,
            configured: available && view.config_exists,
            can_wire: wireable,
            cannot_wire: !wireable,
            prove_down: listener_down,
            prove_listening: listening,
            prove_hit: hit,
            prove_idle: !listener_down && !listening && !hit,
            // EVERY one of these is `available &&`. Without it a refused read
            // renders "No board has a name yet" — a claim about a machine
            // nothing was read from.
            has_boards: available && !view.devices.is_empty(),
            no_boards: available && view.devices.is_empty(),
            has_slots: available && !view.slots.is_empty(),
            no_slots: available && view.slots.is_empty(),
            has_notes: available && !view.notes.is_empty(),
        }
    }
}

/// One checklist step as the row the page draws.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStepRowView {
    /// "1", "2", "3" — the position, as the badge text.
    pub badge: String,
    pub title: String,
    pub detail: String,
    /// `step done` | `step now` | `step later` — presentation of the BACKEND's
    /// state word, composed here so neither language re-derives it.
    pub cls: String,
}

/// A title-over-detail row (the inventory's boards and slots).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPairRowView {
    pub title: String,
    pub detail: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupOptionRowView {
    pub value: String,
    pub label: String,
}

/// One plain-text row (presets, profiles, notes).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupTextRowView {
    pub text: String,
}

/// **Every list row `/setup` draws, composed once, in Rust** — the same
/// docs/SURFACES.md §1 rule [`SetupLines`] and [`SetupFlags`] already follow,
/// applied to the row and label formatters.
///
/// These used to live twice: `render_setup.rs::list_values` composed
/// "Slot 3 — Panel P1" for the SSR paint and `SetupIsland.ts` composed it
/// again for the two-second poll. Two copies of a SENTENCE drift silently
/// (the Profiles page's `ProfilesDerived` header tells the longer version of
/// this story); now both seams read these rows verbatim and format nothing.
/// One split-or-freeze answer, on the page that edits a SAVED config.
///
/// The same three answers `/start` asks with, from the same
/// `BlockingOption::roster()` - deliberately not a second wording. What differs
/// is only that here the chosen one is a fact about a file, not about a stage.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupBlockingRowView {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub chosen_cls: String,
    pub button: String,
}

/// One theme choice, current one marked — the blocking-row idiom exactly
/// (member `chosen_cls` + a per-row one-hidden-input POST form), because it
/// is the repo's one established "pick one of N, server decides which is
/// current" widget and it works with scripting switched off.
///
/// Rows come from the GENERATED roster (`theme_tokens::THEMES`) plus the
/// System row, so shipping a new theme never edits TS or this composition.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupThemeRowView {
    /// What the row's form posts: a theme id, or `system`.
    pub value: String,
    pub title: String,
    pub detail: String,
    pub chosen_cls: String,
    pub button: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupRows {
    pub steps: Vec<SetupStepRowView>,
    pub devices: Vec<SetupPairRowView>,
    pub slots: Vec<SetupPairRowView>,
    /// `1..=SetupView::max_slots` — the ceiling the backend serves, never a
    /// literal in either language.
    pub slot_options: Vec<SetupOptionRowView>,
    pub preset_options: Vec<SetupTextRowView>,
    /// Controller identities this build can actually create. The full served
    /// roster remains on [`ksx_api::SetupView::persona_options`] so unavailable
    /// identities are not erased from the contract; this form intentionally
    /// omits them rather than offering a write the daemon must refuse.
    pub persona_options: Vec<SetupOptionRowView>,
    pub profile_options: Vec<SetupTextRowView>,
    pub notes: Vec<SetupTextRowView>,
    /// The split-or-freeze answers, current one marked. Composed here so the
    /// browser never decides which of the three is chosen.
    pub blocking: Vec<SetupBlockingRowView>,
    /// The SOCD `<select>`'s options, served. The blank "leave it as it is"
    /// entry is the FORM's, not a policy, so it is not in here.
    pub socd_options: Vec<SetupOptionRowView>,
    /// The theme choices (System first, then the generated roster), current
    /// one marked. Same rule as blocking: the browser never decides.
    #[serde(default)]
    pub themes: Vec<SetupThemeRowView>,
}

impl SetupRows {
    /// Compose every row for one read. The only implementation.
    pub fn of(setup: &SetupSnapshot) -> Self {
        let view = &setup.view;
        Self {
            steps: view
                .steps
                .iter()
                .enumerate()
                .map(|(i, step)| SetupStepRowView {
                    badge: (i + 1).to_string(),
                    title: step.title.clone(),
                    detail: step.detail.clone(),
                    cls: format!("step {}", step.state),
                })
                .collect(),
            devices: view
                .devices
                .iter()
                .map(|device| SetupPairRowView {
                    title: device.alias.clone(),
                    detail: format!("{} · {}", device.backend, device.id),
                })
                .collect(),
            slots: view
                .slots
                .iter()
                .map(|slot| SetupPairRowView {
                    title: format!("Slot {} — {}", slot.number, slot.preset),
                    // The SOCD is named ONLY when it is doing something.
                    // "off" is the default and the overwhelming majority of
                    // rows, and a detail line that repeated it on every slot
                    // would bury the one row where it matters.
                    detail: if slot.socd.is_empty() || slot.socd == "off" {
                        format!("{} · {} · {}", slot.device, slot.persona, slot.source)
                    } else {
                        format!(
                            "{} · {} · {} · {}",
                            slot.device, slot.persona, slot.socd, slot.source
                        )
                    },
                })
                .collect(),
            slot_options: (1..=view.max_slots)
                .map(|n| SetupOptionRowView {
                    value: n.to_string(),
                    label: format!("Slot {n}"),
                })
                .collect(),
            preset_options: view
                .presets
                .iter()
                .map(|name| SetupTextRowView { text: name.clone() })
                .collect(),
            persona_options: view
                .persona_options
                .iter()
                .filter(|option| option.can_plug)
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: persona_picker_label(option),
                })
                .collect(),
            profile_options: view
                .profiles
                .iter()
                .map(|title| SetupTextRowView {
                    text: title.clone(),
                })
                .collect(),
            notes: view
                .notes
                .iter()
                .map(|note| SetupTextRowView { text: note.clone() })
                .collect(),
            socd_options: view
                .socd_options
                .iter()
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: option.title.clone(),
                })
                .collect(),
            blocking: view
                .blocking_options
                .iter()
                .map(|option| {
                    let chosen = view.blocking == option.name;
                    SetupBlockingRowView {
                        name: option.name.clone(),
                        title: option.title.clone(),
                        detail: option.detail.clone(),
                        chosen_cls: if chosen {
                            "pill pill-ok".to_owned()
                        } else {
                            "pill pill-none".to_owned()
                        },
                        // The chosen row's button says so rather than inviting a
                        // no-op write; the others say what picking them does.
                        button: if chosen {
                            "This is how it is set".to_owned()
                        } else {
                            option.title.clone()
                        },
                    }
                })
                .collect(),
            themes: theme_rows(setup),
        }
    }
}

/// The Studio theme roster, composed once and served by every page that lets
/// someone change it. Extracted from `SetupRows::of` when `/nocturne` grew its
/// own picker: one implementation means the two pages cannot disagree about
/// which theme is marked, which is the whole point of the three-state rule
/// documented inside.
pub fn theme_rows(setup: &SetupSnapshot) -> Vec<SetupThemeRowView> {
    let view = &setup.view;
    // Three states, three honest markings (review-caught: the
    // first cut marked System "in use" even when the config could
    // not be READ — a claim about a file nothing read, on the page
    // whose signature rule is that a refusal renders as one):
    //  - unreadable → NO row marked and every button stays an
    //    action; theme_line carries the refusal sentence.
    //  - unknown id → System IS what renders (the pill is true)
    //    but not what is SET, so the button offers the useful act
    //    — clearing the id — instead of claiming "this is how it
    //    is set" about a config that says otherwise.
    //  - known/empty → the blocking card's marking exactly.
    let known = crate::theme_tokens::THEMES
        .iter()
        .any(|t| t.id == view.theme);
    let readable = setup.available;
    let system_set = readable && view.theme.is_empty();
    let system_fallback = readable && !view.theme.is_empty() && !known;
    // `chosen_cls` is not a status chip — it is the CLASS OF THE ROW'S OWN
    // SUBMIT BUTTON (`render_nocturne.rs` pushes these rows through `mode_row`,
    // the same serializer the blocking rows use, and the island renders
    // `h("button", { type: "submit", class: r.cls }, …)`). So it must speak the
    // surviving surface's idiom, `n-radio`, the way the doc comment above has
    // always claimed it does.
    //
    // It said "pill pill-ok" / "pill pill-none" until 2026-08-26, inherited
    // verbatim from the DELETED `/setup` page where the same string painted a
    // SEPARATE chip beside the row and the row's button had a class of its own.
    // Migrated onto /nocturne it became the whole control's class, and
    // `.pill-none { display: none }` — a rule written for a device-health chip
    // whose one deliberately-invisible level is "none" — hid every unchosen
    // theme. The picker rendered exactly one row, the one you were already on,
    // whose button re-posted the value you already had: "I click on it and
    // nothing happens" and "where is it?" were the same defect. The nocturne
    // cutover's signature failure mode — a verb that survives migration while
    // the CSS that painted it does not.
    //
    // `.n-modeform button.n-radio { display: flex }` is what restores the
    // layout, and it matches `.n-radio` only; the guard in
    // `render_nocturne.rs` now asserts no theme button ever carries `pill-none`
    // again.
    let mark = |chosen: bool| {
        if chosen {
            "n-radio on".to_owned()
        } else {
            "n-radio".to_owned()
        }
    };
    let mut rows = vec![SetupThemeRowView {
        value: "system".to_owned(),
        title: "Match the operating system".to_owned(),
        detail: "Light or dark follows the system setting on the machine \
                         viewing the page."
            .to_owned(),
        chosen_cls: mark(system_set || system_fallback),
        button: if system_set {
            "This is how it is set".to_owned()
        } else if system_fallback {
            "Follow the operating system instead".to_owned()
        } else {
            "Match the operating system".to_owned()
        },
    }];
    rows.extend(crate::theme_tokens::THEMES.iter().map(|meta| {
        let chosen = readable && view.theme == meta.id;
        SetupThemeRowView {
            value: meta.id.to_owned(),
            title: meta.label.to_owned(),
            // The theme's OWN sentence, authored beside its palette in
            // `studio-ui/tokens/` and generated into the roster. Derived from
            // `meta.scheme` until 2026-08-26, which read fine while three of
            // the four rows were invisible and became a bug the moment they
            // were not: Dark and Matrix are both `scheme: "dark"`, so they
            // described themselves in identical words. `build-tokens.mjs`
            // refuses to emit a theme without a blurb.
            detail: meta.blurb.to_owned(),
            chosen_cls: mark(chosen),
            button: if chosen {
                "This is how it is set".to_owned()
            } else {
                meta.label.to_owned()
            },
        }
    }));
    rows
}

// ───────────────────────────────────────────────────────────────────────────
// /start — the first run, moments 4 to 7 (docs/FIRST-RUN.md)
// ───────────────────────────────────────────────────────────────────────────

/// The scalar-only capture-preparation seam for `/start`.
///
/// This deliberately is not a device row and does not carry a backend field.
/// The browser can confirm the exact selection it was shown, but only the
/// server decides which backend follows an authoritative prepare/release
/// result. `mode` is server-only; the redesign derivation turns it into the
/// three scalar branches that Forma renders.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartCaptureView {
    pub expected_selector: String,
    pub instance_id: String,
    #[serde(skip)]
    mode: StartCaptureMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum StartCaptureMode {
    #[default]
    None,
    Ready,
    Prepare,
    PrepareOptional,
    Release,
    /// **The machine says prepared; the stage says ordinary Windows path.**
    ///
    /// Reachable the instant a user picks a board ksx is already holding:
    /// `StageEdit::ChooseDevice` always stages `Interception` (the stage is a
    /// pure value and knows nothing about drivers), so choosing an
    /// already-prepared keyboard leaves the two disagreeing.
    ///
    /// It is NOT `Prepare`, which is what this page used to show for it —
    /// "Prepare this keyboard for play" over a keyboard Windows had already
    /// prepared, whose only possible outcome was the provider's
    /// `winusb-already-prepared` refusal telling the user to "use Release",
    /// which the same page then did not draw. That is the 2026-08-11 QA
    /// report, and `docs/FIRST-RUN.md` §6's "a screen reports success while
    /// nothing works" turned inside out: a screen offering the one action that
    /// cannot apply.
    ///
    /// It is not [`Self::Release`] either, because that one counts as READY
    /// and this one must not: a session started on a stage that says
    /// Interception, over an interface that is off the keyboard stack, is the
    /// dead panel this project keeps rediscovering. So it reads as blocked,
    /// says which two facts disagree, and the way out is the held-keyboard
    /// list above it, which releases by identity rather than through the
    /// stage.
    Held,
    Blocked,
}

impl StartCaptureView {
    /// The ONE capture-mode derivation, shared by `/start`'s card and
    /// `/nocturne`'s prepared-for-play control. Extracted rather than copied
    /// when the keyboard backend migrated (2026-08-17): two mode machines
    /// would eventually disagree about the same physical keyboard.
    pub(crate) fn from_parts(
        staged: &ksx_api::StagedSetupView,
        scan: &ksx_api::DeviceScanView,
        scan_read: bool,
    ) -> Self {
        let Some(device) = staged.device.as_ref() else {
            return Self::default();
        };
        if !staged.reachable {
            return Self::default();
        }
        if !scan_read {
            return Self::blocked(device.selector.clone());
        }

        // A selector chosen from the served inventory should name one board.
        // Re-check that invariant instead of taking the first match: a stale
        // or malformed inventory must remove the action, never retarget it.
        let mut matches = scan
            .boards
            .iter()
            .filter(|board| board.selector.as_deref() == Some(device.selector.as_str()));
        let Some(board) = matches.next() else {
            return Self::blocked(device.selector.clone());
        };
        if matches.next().is_some() {
            return Self::blocked(device.selector.clone());
        }
        let Some(instance_id) = board.keyboard.as_ref() else {
            return Self::blocked(device.selector.clone());
        };
        if scan
            .boards
            .iter()
            .flat_map(|candidate| candidate.interfaces.iter())
            .filter(|row| row.instance_id.eq_ignore_ascii_case(instance_id))
            .count()
            != 1
        {
            return Self::blocked(device.selector.clone());
        }

        // These are the two canonical wire spellings accepted by StageEdit.
        // They are server-owned constants; no browser field selects either.
        let backend = device.backend.as_str();
        let interception = "interception";
        let winusb = "winusb";
        let interception_ready = backend == interception
            && scan.interception_available
            && board.interception_eligible
            && board.can_type
            && !board.claimed;
        let mode = if interception_ready && board.winusb_eligible {
            // The optional built-in path must remain reachable even when a
            // shared Interception install happens to make this machine work.
            // It is an option, not a readiness blocker.
            StartCaptureMode::PrepareOptional
        } else if interception_ready {
            StartCaptureMode::Ready
        } else if backend == winusb && board.winusb_eligible && board.claimed {
            StartCaptureMode::Release
        } else if board.claimed {
            // **The machine's answer wins over the stage's.** `claimed` is read
            // from the live device tree; `backend` is what this visit's staged
            // value happens to say. When they disagree the board is still off
            // the keyboard stack, and a card that offered Prepare here would be
            // offering the one action the provider refuses.
            StartCaptureMode::Held
        } else if (backend == interception || backend == winusb) && board.winusb_eligible {
            StartCaptureMode::Prepare
        } else {
            StartCaptureMode::Blocked
        };
        Self {
            expected_selector: device.selector.clone(),
            instance_id: instance_id.clone(),
            mode,
        }
    }

    fn blocked(expected_selector: String) -> Self {
        Self {
            expected_selector,
            mode: StartCaptureMode::Blocked,
            ..Self::default()
        }
    }

    /// The mode as a stable word for the redesign derivation, without letting
    /// the private enum cross the module boundary.
    pub(crate) fn mode_word(&self) -> &'static str {
        match self.mode {
            StartCaptureMode::None => "none",
            StartCaptureMode::Ready => "ready",
            StartCaptureMode::Prepare => "prepare",
            StartCaptureMode::PrepareOptional => "prepare-optional",
            StartCaptureMode::Release => "release",
            StartCaptureMode::Held => "held",
            StartCaptureMode::Blocked => "blocked",
        }
    }
}

/// A persona picker says both the public identity and the immutable output
/// route. A per-session ceiling belongs in the option too: it is useful before
/// the first pick, while [`ksx_api::PersonaOption::available`] prevents an impossible
/// later pick from appearing at all.
fn persona_picker_label(option: &ksx_api::PersonaOption) -> String {
    let backend = if option.backend_label.trim().is_empty() {
        option.backend.as_str()
    } else {
        option.backend_label.as_str()
    };
    match option.instance_limit {
        Some(1) => format!("{} · {} · one per session", option.label, backend),
        Some(limit) => format!("{} · {} · up to {limit} per session", option.label, backend),
        None if backend.trim().is_empty() => option.label.clone(),
        None => format!("{} · {}", option.label, backend),
    }
}

/// The right pane's whole content for one selected controller, composed off
/// the SAME machinery the mapper reads (`ksx_api::staged_mapper_slot` + the
/// zone tables in render_map.rs), so the two surfaces cannot describe one
/// binding differently.
struct WorkspaceBinds {
    title: String,
    rows: Vec<WorkspaceBindRow>,
    foot: String,
}

/// One binding-list row of the workspace's right pane: the selected slot's
/// controls in the zone tables' own order, each with the composed strings
/// the Nocturne row anatomy renders and the fields its Clear twin submits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceBindRow {
    /// Canonical function name — the form field and the row key.
    pub function: String,
    /// "LS ▲", "D-pad ◀", "A" — the mapper's own legend label.
    pub label: String,
    /// "G · H", or the honest "—" for an unbound control.
    pub keys: String,
    /// The row's modifiers as one quiet sentence: "Turbo ~12 Hz · Toggle ·
    /// this key also drives A, B" — empty when the row is plain.
    pub notes: String,
    /// `"wsbind"` (+" unbound"/" shared").
    pub cls: String,
    /// The fan-out sentence ALONE ("this key also drives A · B"), for a
    /// surface that shows turbo/toggle as badges instead of prose.
    pub share_note: String,

    /// "Clear" on a bound row, empty (and therefore hidden) on an unbound
    /// one — the list idiom for a per-row action that is sometimes a no-op.
    pub clear: String,
    /// The slot number the Clear twin submits.
    pub slot: String,
    /// The control's delivered auto-fire rate as the turbo box's prefill
    /// ("12"), or empty for none.
    pub turbo_hz: String,
    /// TOGGLE-HOLD: the control latches (press once holds, press again
    /// releases).
    pub toggle: bool,
}

// The binding-row composer the Nocturne right pane uses. It was written for
// the /workspace shell and outlived it: /nocturne re-dresses these rows.
fn workspace_bind_rows(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
) -> WorkspaceBinds {
    let empty = |title: &str| WorkspaceBinds {
        title: title.to_owned(),
        rows: Vec::new(),
        foot: String::new(),
    };
    if !staged.reachable {
        return empty("Not readable right now.");
    }
    let Some(slot) = selected else {
        return empty("No controller staged yet.");
    };
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let Ok(mapper) = ksx_api::staged_mapper_slot(slot, keyboard) else {
        // An older daemon serves no authoring table; the mapper page carries
        // the full explanation, so point there rather than paraphrasing.
        return WorkspaceBinds {
            title: format!("P{} · {}", slot.number, slot.persona_label),
            rows: Vec::new(),
            foot: String::new(),
        };
    };
    let shared = crate::render_map::shared_labels(&mapper);
    let zones = crate::render_map::zones_for(&mapper.persona);
    let rows: Vec<WorkspaceBindRow> = zones
        .iter()
        .zip(&shared)
        .map(|(zone, share)| {
            let keys = crate::render_map::key_tag(&mapper, zone.fn_name);
            let unbound = keys == "—";
            let mut notes: Vec<String> = Vec::new();
            if let Some(effective) = mapper.turbo.get(zone.fn_name) {
                notes.push(format!("Turbo ~{effective} Hz"));
            }
            if mapper.toggle.contains(zone.fn_name) {
                notes.push("Toggle: a press holds until the next press".to_owned());
            }
            // PER-KEY fan-out, subject named — "this key also drives…" could
            // not say WHICH key on a multi-key row. One vocabulary
            // everywhere: keys DRIVE controls (the board's own words).
            let share_note = {
                let mut parts: Vec<String> = Vec::new();
                for key in crate::render_map::keys_of(&mapper, zone.fn_name) {
                    let others: Vec<String> = zones
                        .iter()
                        .filter(|other| other.fn_name != zone.fn_name)
                        .filter(|other| {
                            crate::render_map::keys_of(&mapper, other.fn_name).contains(&key)
                        })
                        .map(|other| {
                            crate::render_map::legend_label_for_persona(&mapper.persona, other)
                        })
                        .collect();
                    if !others.is_empty() {
                        parts.push(format!("{key} also drives {}", others.join(" · ")));
                    }
                }
                parts.join(" — ")
            };
            if !share_note.is_empty() {
                notes.push(share_note.clone());
            }
            let mut cls = String::from("wsbind");
            if unbound {
                cls.push_str(" unbound");
            }
            if !share.is_empty() {
                cls.push_str(" shared");
            }
            WorkspaceBindRow {
                function: zone.fn_name.to_owned(),
                label: crate::render_map::legend_label_for_persona(&mapper.persona, zone),
                keys,
                notes: notes.join(" · "),
                cls,
                share_note,
                clear: if unbound {
                    String::new()
                } else {
                    "Clear".to_owned()
                },
                slot: slot.number.to_string(),
                turbo_hz: mapper
                    .turbo
                    .get(zone.fn_name)
                    .map(|hz| hz.to_string())
                    .unwrap_or_default(),
                toggle: mapper.toggle.contains(zone.fn_name),
            }
        })
        .collect();

    // ── CONTROLS THIS PAD DOES NOT HAVE, THAT THIS PRESET STILL BINDS ──────
    //
    // `zones` is what the CONTROLLER has. A preset is what the FILE says, and
    // the two are allowed to disagree — `ksx_core::persona`'s module doc makes
    // it a rule: "Re-persona-ing a slot must never require editing its preset."
    // Move an Xbox seat to SNES and its `lx.max` binding is still in the TOML,
    // still loading, and driving nothing, because a SNES pad has no stick.
    //
    // A list built from `zones` alone simply omits those rows, and that omission
    // is the SAME silent-fallback failure the retro zone tables were narrowed to
    // remove, pointed the other way: the key stays bound, quietly stops working,
    // and the one page that could explain it shows nothing at all — not even a
    // Clear to undo it with. So they are appended, in their own control's group,
    // each carrying the sentence that says what happened.
    //
    // Empty for every persona that expresses the whole vocabulary, which is
    // every persona but the retro pair — so this costs nothing until it is the
    // only thing standing between a player and a control that went missing.
    let mut rows = rows;
    let mut stranded: Vec<(&String, &Vec<String>)> = mapper
        .bindings
        .iter()
        .filter(|(function, keys)| {
            !keys.is_empty()
                && !zones
                    .iter()
                    .any(|zone| zone.fn_name.eq_ignore_ascii_case(function))
        })
        .collect();
    stranded.sort_by_key(|(function, _)| (*function).clone());
    for (function, _) in stranded {
        rows.push(WorkspaceBindRow {
            function: function.clone(),
            // No zone means no persona word for it; the canonical name is the
            // only honest label, and it is also what the user's TOML says.
            label: function.clone(),
            keys: crate::render_map::key_tag(&mapper, function),
            notes: String::new(),
            cls: "wsbind".to_owned(),
            share_note: format!(
                "{} has no such control — this key is still bound and drives \
                 nothing. Clear it, or give this player a controller that has \
                 one.",
                slot.persona_label
            ),
            clear: "Clear".to_owned(),
            slot: slot.number.to_string(),
            turbo_hz: mapper
                .turbo
                .get(function)
                .map(|hz| hz.to_string())
                .unwrap_or_default(),
            toggle: mapper.toggle.contains(function),
        });
    }

    let bound = rows.iter().filter(|row| row.keys != "—").count();
    // A key is SHARED when it drives more than one control — counted once,
    // by inverting the binding table, so a key that merely sits beside a
    // shared one on some row never inflates the number.
    let shared_keys: usize = {
        let mut fanout: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for keys in mapper.bindings.values() {
            for key in keys {
                *fanout.entry(key.as_str()).or_default() += 1;
            }
        }
        fanout.values().filter(|count| **count > 1).count()
    };
    let foot = match shared_keys {
        0 => format!("{bound} of {} controls bound.", rows.len()),
        1 => format!("{bound} of {} controls bound · 1 key shared.", rows.len()),
        n => format!(
            "{bound} of {} controls bound · {n} keys shared.",
            rows.len()
        ),
    };
    WorkspaceBinds {
        title: format!(
            "P{} · {} — \"{}\"",
            slot.number, slot.persona_label, slot.preset
        ),
        rows,
        foot,
    }
}

/// One pickable keyboard row: the row IS the `/nocturne/device` form's
/// button, so the three hidden values ride beside the display fields. All
/// three are SERVED — `FIRST-RUN.md` §6 forbids asking anyone to type a
/// device path, and this page has no text input either.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneDeviceRow {
    pub cls: String,
    pub name: String,
    pub meta: String,
    /// `keyboard` | `panel-encoder` | `other`, copied from the backend-owned
    /// [`ksx_api::BoardRole`]. The island uses this value for presentation; it
    /// never identifies an encoder by matching the display name.
    pub role: String,
    /// Short, stable presentation identity for boards whose product names
    /// match. The full selector remains the transaction identity; this keeps
    /// its final instance component visible without asking the browser to
    /// derive served copy (and is therefore present in SSR HTML).
    #[serde(default)]
    pub connection_label: String,
    pub selector: String,
    pub alias: String,
    pub label: String,
    /// `"true"` on the staged board, `"false"` on every other row — the
    /// ASSISTIVE half of what `cls: "n-dev on"` says visually.
    ///
    /// Served as a word rather than a flag because the attribute is written
    /// from a list row: an empty string still SETS an attribute in the
    /// runtime's generic-attribute path, so "absent" is not expressible here.
    /// `aria-current="false"` is valid ARIA and means exactly what it says, so
    /// the two-word vocabulary is the honest encoding rather than a
    /// workaround.
    #[serde(default)]
    pub aria_current: String,
    /// What pressing this row does, in the server's words — the `title` the
    /// row carries. The chosen row explains why pressing it changes nothing;
    /// the others say what choosing them costs (a replacement, and nothing
    /// else).
    ///
    /// `docs/SURFACES.md` §1a: rendered copy is logic too. The browser has no
    /// business composing "replaces the current one" out of a class name.
    #[serde(default)]
    pub title: String,
    /// `"true"` when a chart read is possible for this EXACT board, from
    /// `panel_catalog::capabilities_for`. A word, not a flag, for the reason
    /// `aria_current` is: an empty string still sets an attribute from a list
    /// row, so "absent" is not expressible.
    ///
    /// Served rather than inferred. The island needs a BOOLEAN here — it hides
    /// a whole verb on it — and reading that out of a display sentence is the
    /// pattern `role` exists to replace: "the island uses this value for
    /// presentation; it never identifies an encoder by matching the display
    /// name."
    pub chart_readable: String,
    /// Stable backend-owned family/profile facts for presentation joins. Their
    /// absence is meaningful: the browser must not reconstruct either from a
    /// display label, VID/PID, or terminal count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_profile: Option<String>,
    /// `profiled` | `unprofiled-release` | `unrecognised`, copied from the
    /// device scan rather than re-derived in the island.
    #[serde(default)]
    pub profile_state: String,
    /// Exact measured profile capacity when one exists. Never a browser guess
    /// about the family's physical screw count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_count: Option<usize>,
    /// Redesign-only, server-composed capture badge fields. The shared device
    /// row keeps them empty on legacy routes; `/redesign` decorates every row
    /// after capture truth is composed so SSR and API refreshes share one
    /// literal presentation.
    #[serde(default)]
    pub capture_badge: String,
    #[serde(default)]
    pub capture_state: String,
    #[serde(default)]
    pub capture_cls: String,
}

/// One board that cannot be picked, and why — kept visible, never hidden:
/// a list that silently drops rows teaches a user the machine has fewer
/// keyboards than it does.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOtherRow {
    pub name: String,
    pub meta: String,
}

/// One split-or-freeze answer, from `BlockingOption::roster()` — the same
/// words `/start` and `/workspace` ask with, deliberately not a third wording.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneChoiceRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub cls: String,
    /// **Whether this is the answer currently in effect**, as a FACT rather
    /// than something to be read back out of [`Self::cls`].
    ///
    /// The class paints the marker; it cannot announce it. Without this the
    /// only signal was a decorative `.n-radio.on` dot, so every row of a
    /// picker read identically to a screen reader and the one you were on
    /// was unknowable without sight. It is a separate field because the
    /// alternative — parsing the class string in the browser — is the exact
    /// coupling that let a stale `.pill-none` rule hide three of four theme
    /// rows while every test still passed.
    pub chosen: bool,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOptionRow {
    pub value: String,
    pub label: String,
}

/// One binding-list row, composed off the SAME machinery the mapper reads
/// (via [`workspace_bind_rows`]) and re-dressed for the Nocturne pane.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneBindRow {
    pub function: String,
    pub label: String,
    pub chip: String,
    pub note: String,
    pub cls: String,
    pub chip_cls: String,
    /// `n-minus` when the chip carries several keys (a pair to choose),
    /// `n-minus none` otherwise — the ⊖ only shows where it can act.
    pub minus_cls: String,
    pub clear_cls: String,
    pub slot: String,
    /// The turbo box's prefill — the delivered rate ("12"), or empty.
    pub turbo: String,
    /// The chip's hover sentence: the RELATION, stated from the game's side
    /// ("Driven by G or H — …"), because the chip lives on a control row.
    pub chip_title: String,

    /// The summary badge — "Toggle · 12/s" / "12/s" / "Toggle", with its
    /// visibility class ("" cannot ride CSS `:empty`: the renderer keeps a
    /// zero-width text node in an empty slot).
    pub badge: String,
    pub badge_cls: String,
    /// The ghost "+" add-a-key chip: hidden on an unbound row, whose main
    /// chip already binds the first key.
    pub add_cls: String,
    /// The Hold|Toggle pill pair, precomposed: exactly one carries `on`.
    pub hold_cls: String,
    pub tog_cls: String,
}

/// One macro of the selected slot's layout, as the right pane's lifecycle
/// row: trigger keys, a step/policy summary, and the enable/disable state.
/// Step EDITING stays on the Controls editor until its own pass; this row
/// says so with a link instead of pretending.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroRow {
    /// The table name — the display label.
    pub name: String,
    /// `macro.<name>` — the binding-table function the learn flow rebinds.
    pub fn_name: String,
    /// Trigger keys joined, or the honest "No trigger key".
    pub chip: String,
    /// The chip's hover sentence — the relation, plus the gesture.
    pub chip_title: String,
    /// The ghost "+" add-a-trigger chip; hidden until one trigger exists.
    pub add_cls: String,
    pub chip_cls: String,
    /// "3 steps · repeats while held · …".
    pub meta: String,
    pub cls: String,
    pub slot: String,
    /// The Controls editor, opened at exactly this macro.
    pub edit_href: String,
    /// The lifecycle pair, precomposed: what the submit does and the wire
    /// value it sends ("yes" enables, empty disables).
    pub toggle_label: String,
    pub toggle_value: String,
}

/// One FREE control in the By-control view's per-group strip: click it,
/// then press (or click) a key — the control-side twin of a free key chip.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneCtlChip {
    /// The mapper's own spelling, for the learn target.
    pub function: String,
    pub label: String,
    pub cls: String,
}

/// One row of the pane's BY-KEY view: a bound key and everything it
/// drives, the relation read from the keyboard's side.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneKeyRow {
    /// The board-authored cap text ("Ctrl", "↑", "1"), kept separate from
    /// [`Self::key`] so a surface can speak like the physical keyboard without
    /// ever posting presentation text back to the mapper.
    #[serde(default)]
    pub key_label: String,
    pub key: String,
    /// The controls this key drives, in readable zone labels ("A · RB").
    pub targets: String,
    /// The same controls as canonical fn tokens, space-joined lowercase —
    /// the client's door to the By-control rows.
    pub fns: String,
    /// `n-krow` (+" shared" when the key fans out to several controls).
    pub cls: String,
    /// The selected slot's number, carried so the row's per-key Clear form
    /// twin can name it. Empty on the free-key chips (nothing to clear).
    pub slot: String,
}

/// One chip of the board's color legend: which color speaks for which
/// controller, and the door to muting it on the keys.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneLegendRow {
    pub slot: String,
    pub badge: String,
    /// The persona label, so the chip says who as well as which color.
    pub name: String,
    /// `n-lgd np{N}` — the chip wears the controller's own color.
    pub cls: String,
}

/// One controller for the stage's MULTI-PAD grid: everything the client
/// needs to clone the right master art and dress it for this slot. Pure
/// payload data — no template reads it, so it mints no slots.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturnePadView {
    pub slot: u8,
    /// Opaque staged-controller revision served with this exact row. The
    /// browser returns it unchanged with a bind; it is not presentation data
    /// and must never be reconstructed from the visible preset/persona.
    #[serde(default)]
    pub target_revision: String,
    /// "xbox" | "ps" — which master silhouette the client clones.
    pub family: String,
    /// The slot's preset name — the controller's STABLE identity across
    /// reorders (seats renumber, worksheets travel), which is what the
    /// client keys its identity colors by.
    pub preset: String,
    pub title: String,
    /// Canonical fn → its key chip ("G · H"), for the clone's callouts.
    pub fn_keys: std::collections::BTreeMap<String, String>,
    /// `false` means the provider could not project this slot's direct mapper
    /// table. An empty `fn_keys` is otherwise the valid fact "nothing is
    /// bound", so availability has to travel separately.
    #[serde(default)]
    pub mapping_available: bool,
    #[serde(default)]
    pub mapping_reason: String,
    /// Every controller control in one stable authoring order. Unlike
    /// `fn_keys`, this keeps the exact key vector and the per-control
    /// transforms the canvas needs to edit a connection without reading the
    /// legacy binding pane's DOM. Empty is meaningful only while
    /// `mapping_available` is true; otherwise `mapping_reason` says why no
    /// authoring projection could be made.
    #[serde(default)]
    pub controls: Vec<NocturneControlAuthoring>,
    /// Canonical fn → the persona's readable label ("LS ↑", "△") — the
    /// toast's vocabulary for arming ANY pad's control, not just the
    /// selected one.
    pub fn_names: std::collections::BTreeMap<String, String>,
    /// Timed processors owned by this preset. The canvas renders these as
    /// real key → macro → control chains instead of pretending a trigger
    /// key is a direct controller binding.
    #[serde(default)]
    pub macros: Vec<NocturneMacroFlow>,
    /// `false` means the provider could not answer the macro read. It must not
    /// collapse into an empty macro list: "unknown" and "defines none" are
    /// different authoring facts.
    #[serde(default)]
    pub macro_available: bool,
    #[serde(default)]
    pub macro_reason: String,
}

/// One controller-side endpoint in the canvas authoring graph.
///
/// The identity comes from [`crate::render_map::zones_for`], while binding
/// and transform facts come straight from [`ksx_api::MapperSlot`]. This is a
/// normalized backend projection, not a transcription of whichever rows a
/// surface happens to render.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneControlAuthoring {
    /// Canonical mapper function spelling (`A`, `dpad.up`, `lx.min`).
    pub function: String,
    /// Persona-aware control name (`A`, `△`, `Create`, `LS ←`).
    pub label: String,
    /// Stable machine group slug: face, dpad, shoulders, left-stick,
    /// right-stick, or system.
    pub group: String,
    /// Zero-based position in the complete normalized control sequence.
    pub order: usize,
    /// Exact authored OR-chain, in file order. Empty means unbound.
    pub keys: Vec<String>,
    /// Whether a press latches until the next press.
    pub toggle: bool,
    /// Authored auto-fire rate; absent means ordinary non-turbo behavior.
    pub turbo_hz: Option<u32>,
}

/// The read-only part of one macro needed by the canvas signal graph.
///
/// This is composed from the same staged [`ksx_api::MacroSnapshot`] as the
/// lifecycle rows and step editor. The browser receives presentation-ready
/// step words plus canonical output names; it does not interpret macro files
/// or invent execution semantics of its own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroFlow {
    pub name: String,
    pub triggers: Vec<String>,
    /// Unique canonical functions touched anywhere in the timeline, in first
    /// appearance order. A neutral-only macro legitimately leaves this empty.
    pub outputs: Vec<NocturneMacroFlowOutput>,
    /// One persona-aware sentence per step ("D-pad ↓", "D-pad ↘", "X").
    pub timeline: Vec<String>,
    pub meta: String,
    pub disabled: bool,
    pub edit_href: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroFlowOutput {
    pub function: String,
    /// One-based step numbers where this output is held. This is what keeps a
    /// sequence from being presented as simultaneous fan-out.
    pub steps: Vec<usize>,
}

fn nocturne_macro_meta(mac: &ksx_api::MacroView) -> String {
    let mut notes = vec![match mac.steps.len() {
        1 => "1 step".to_owned(),
        n => format!("{n} steps"),
    }];
    match mac.repeat.as_str() {
        "while-held" => notes.push("repeats while held".to_owned()),
        "turbo" => notes.push(match (mac.turbo_hz, mac.gap_ms) {
            (Some(hz), _) => format!("turbo {hz} Hz"),
            (_, Some(gap)) => format!("turbo · {gap} ms gap"),
            _ => "turbo".to_owned(),
        }),
        _ => {}
    }
    if mac.on_release == "abort" {
        notes.push("aborts on release".to_owned());
    }
    if mac.disabled {
        notes.push("disabled — keeps every step, never starts".to_owned());
    }
    notes.join(" · ")
}

fn nocturne_macro_outputs(mac: &ksx_api::MacroView) -> Vec<NocturneMacroFlowOutput> {
    let mut positions = std::collections::HashMap::<String, usize>::new();
    let mut outputs: Vec<NocturneMacroFlowOutput> = Vec::new();
    for (step_index, step) in mac.steps.iter().enumerate() {
        for function in &step.hold {
            let normalized = function.to_ascii_lowercase();
            if let Some(index) = positions.get(&normalized).copied() {
                outputs[index].steps.push(step_index + 1);
            } else {
                positions.insert(normalized, outputs.len());
                outputs.push(NocturneMacroFlowOutput {
                    function: function.clone(),
                    steps: vec![step_index + 1],
                });
            }
        }
    }
    outputs
}

/// How many owner bands a keycap can carry before the last one becomes the
/// neutral "and more" mark: four 6px bands is the legible floor at 30px, and
/// no palette is readable past a handful of hues anyway.
const BAND_MAX: usize = 4;

/// The band class prefixes, in paint order (left to right).
const BAND_KEYS: [&str; BAND_MAX] = ["ba", "bb", "bc", "bd"];

/// One keycap on the standard board, dressed with its binding short.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneKeyCell {
    pub cap: String,
    /// The canonical `ksx_core::Key` name — the live feed's `KeyHit.key`
    /// vocabulary, carried as `data-key` so live lighting is a lookup.
    pub key: String,
    pub cls: String,
    pub short: String,
    /// The hover sentence: which controls this key drives, in the persona's
    /// readable zone labels. Empty on an unbound cap.
    pub title: String,
    /// The assistive name (`role="img"` + `aria-label`): the same sentence
    /// on a bound cap, the bare cap otherwise — never empty.
    pub aria: String,
    /// Spacer cells share the plate's geometry grammar but are not controls.
    /// Serve their interaction state explicitly so SSR and hydration agree:
    /// an empty ghost must never become an unnamed keyboard Tab stop.
    pub disabled: bool,
    pub tab: String,
    pub aria_hidden: String,
    /// **Where this control sits on the board**, as an inline `style`.
    ///
    /// Percentages of the board's own bounds — `left`, `top`, `width`,
    /// `height` — so the plate scales to whatever width its card gives it
    /// instead of being hand-fitted to one. `keyboardWorkbench` has positioned
    /// its keys this way all along; this is the same arithmetic, served rather
    /// than computed in the browser.
    ///
    /// Inline `style=""` is deliberate and already load-bearing on this page:
    /// the CSP carries `style-src-attr 'unsafe-inline'` precisely so the
    /// mapper's 25 hit zones can position themselves, and `style-src` stays
    /// nonce-locked so `<style>` blocks gain nothing from it.
    pub style: String,
}

/// Which of the right pane's six controller clusters a mapper function
/// belongs to — the order a hand finds them: face buttons, D-pad,
/// shoulders & triggers, left stick, right stick, system. The rows carry
/// the MAPPER's spelling, which writes the face buttons UPPERCASE while the
/// zone vocabulary is lowercase (the live-echo lesson) — match both.
/// Anything unrecognised lands in the system group rather than disappearing.
/// The six group names, exactly as the island's markup spells them — the
/// server-side filter and the client sweep both match against these.
const NOCTURNE_BIND_GROUP_LABELS: [&str; 6] = [
    "Face buttons",
    "D-pad",
    "Shoulders & triggers",
    "Left stick",
    "Right stick",
    "System",
];

/// Stable canvas vocabulary for the same six physical clusters. These are
/// slugs rather than display copy so a frontend can group controls without
/// inheriting the right pane's headings.
const NOCTURNE_CONTROL_GROUPS: [&str; 6] = [
    "face",
    "dpad",
    "shoulders",
    "left-stick",
    "right-stick",
    "system",
];

/// **Everything a surface needs to draw ONE persona, in ONE record.**
///
/// The table below ([`PAD_PRESENTATIONS`]) is the single persona →
/// presentation decision in ksx Studio. Before it there were FIVE, none of
/// which knew about the other four and none of which mentioned `snes` or
/// `genesis`:
///
/// - `pad_art_family` matched three persona names and then fell through to
///   `slot.is_xinput`, so a staged SNES seat (plain HID, `is_xinput == false`)
///   became `"ps"` — a DualShock 4;
/// - [`crate::render::art_for`] substring-matched seven PlayStation tokens and
///   fell through to the Xbox art, so the SAME seat became an Xbox pad;
/// - [`crate::render_map::zones_for`] delegated to `art_for` and so handed that
///   seat `ZONE_XBOX` — two analog sticks, two analog triggers, an L3/R3 and a
///   guide button, none of which exist on the device;
/// - [`crate::render_map::legend_label_for_persona`] substring-matched Switch
///   and PS5 and printed Xbox words for everything else;
/// - `NocturneIsland.ts` re-decided the whole thing from a hardcoded
///   five-name `Set` and fell back to `"xbox"`.
///
/// Every one of the five failed by SILENT FALLBACK, and two of them fell
/// different ways, which is why one page could draw the same controller as a
/// DualShock in the pad grid and an Xbox pad in the mapper.
///
/// **The rule this record replaces them with.** The mapping is TOTAL: a
/// persona string either matches a row or it resolves to
/// [`UNKNOWN_PRESENTATION`], which is a *named* outcome carrying the family
/// `"unknown"` — not a fall-through to Xbox. The browser reads
/// [`NocturnePadView::family`] and never re-decides; an unknown family there is
/// a visible placeholder, not a silhouette we made up.
///
/// **Why the key is a STRING and not a `Persona`.** `render_map.rs` links
/// ksx-core only as a dev-dependency and that boundary is deliberate
/// (`docs/M9-DECISION.md` §6, argued at length above `zones_for`). So the match
/// keys off the SERVED persona name — `StagedSlotView::persona` is documented
/// as the canonical [`ksx_core::Persona::as_str`] spelling — and exhaustiveness
/// cannot come from the compiler. It comes from
/// `every_persona_resolves_to_a_presentation`, which walks `Persona::ALL`
/// through the dev-dependency and fails if any persona has no row.
pub(crate) struct PadPresentation {
    /// The canonical persona name, exactly as `Persona::as_str` spells it.
    pub persona: &'static str,
    /// Spellings other than the canonical one that must resolve to this row.
    ///
    /// Kept because the functions this record replaced were *substring*
    /// matchers: `art_for` answered DS4 for anything containing `ds4`, `ps4`,
    /// `ps5`, `dualshock`… and callers outside the staged-slot path are not all
    /// proven to pass a canonical name. Pinned against ksx-core's own
    /// [`FromStr`](std::str::FromStr) by `presentation_aliases_match_ksx_core`,
    /// so this list can never come to mean something the engine disagrees with.
    pub aliases: &'static [&'static str],
    /// Which drawn body a seat wears: the master the canvas clones, and the
    /// no-JS page's visible `.n-padwrap`.
    pub family: &'static str,
    /// The vendored `<img>` art for the surfaces that serve a URL (`/pads`
    /// tiles, and `/check`'s PlayStation-vocabulary test).
    pub art: &'static str,
    /// The controls this pad HAS — the authoring vocabulary for every surface
    /// that asks "what can this seat bind": the binding pane's rows and free
    /// chips, the canvas's control list, the macro grid's columns, and the
    /// readable names on the keyboard.
    pub zones: &'static [crate::render_map::Zone],
    /// Function → the word THIS persona prints, for personas that share a
    /// geometry table with another but not its vocabulary (Switch Pro over the
    /// Xbox table, DualSense over the DS4 one). A persona whose whole
    /// vocabulary differs gets its own table instead and leaves this empty.
    pub legend: &'static [(&'static str, &'static str)],
    /// Mappable functions this controller DOES NOT HAVE, named one by one.
    ///
    /// Derivable as `mappable_functions() - zones` and stated anyway, because
    /// the two say different things. A missing zone is an absence; this list is
    /// a DECISION, and `zone_tables_cover_every_mappable_function` proves the
    /// two are exactly complementary — so a function added to ksx-core cannot
    /// quietly become "absent everywhere", it fails until somebody says which
    /// of these pads has it.
    ///
    /// Read only by that test, hence the allow — the same arrangement, and the
    /// same reason, as `Zone`'s geometry fields: this exists to be CHECKED, and
    /// deleting it to silence `dead_code` would delete the check with it. A
    /// runtime reader arrives the day a surface says "this controller has no
    /// right stick" out loud instead of simply not offering one.
    #[cfg_attr(not(test), allow(dead_code))]
    pub absent: &'static [&'static str],
}

/// No vocabulary delta — this persona's own zone table already prints the
/// words it wants.
const LEGEND_SAME_AS_TABLE: &[(&str, &str)] = &[];

/// DualSense over the DS4 geometry: one button was renamed between the
/// generations, and that is the whole delta.
const LEGEND_DUALSENSE: &[(&str, &str)] = &[("back", "Create")];

/// Switch Pro over the Xbox geometry: same physical layout, Nintendo words.
const LEGEND_SWITCHPRO: &[(&str, &str)] = &[
    ("lt", "ZL"),
    ("lb", "L"),
    ("rb", "R"),
    ("rt", "ZR"),
    ("back", "Capture"),
    ("start", "Plus"),
    ("guide", "Home"),
];

/// The ten analog functions neither retro pad can express, and the three
/// buttons neither pad physically has.
///
/// **This is a shape claim, not a bit-order one**, and every part of it is
/// already measured in the tree:
///
/// - `ibuffalo-snes` (0583:2060) is a **3-byte report: X/Y + 8 buttons**;
///   `daemonbite-genesis` (2341:8036) is **9 buttons + signed X/Y**
///   (`docs/HIDMAESTRO-STATE.md`, retro scope call 2026-08-20, and the doc
///   comments on `ksx_core::Persona::{Snes, Genesis}`).
/// - ksx needs SIX analog roles (`ksx_hidmaestro::axis::AxisRole::ALL`: two
///   sticks and two triggers). Each retro descriptor carries exactly ONE axis
///   pair, and on both physical pads that pair IS the D-pad. So the right
///   stick and both analog triggers have nowhere on the wire to land, and the
///   left stick would only be a second name for a direction the D-pad already
///   drives.
/// - `lthumb`/`rthumb` are stick CLICKS and neither pad has a stick to click.
///   `guide` is a home button and neither pad has one — the SNES pad's eight
///   are B/A/Y/X/L/R/Select/Start, and the DaemonBite adapter's nine are the
///   Saturn/MD6 set.
///
/// L and R on both pads are DIGITAL, so they are already `lb`/`rb`; a player
/// who binds a key to `lt` on one of these seats is binding a key to nothing.
/// That is the whole reason this list exists rather than a truncated table
/// with no explanation beside it.
const ABSENT_ON_A_DIGITAL_RETRO_PAD: &[&str] = &[
    "lt", "rt", "lthumb", "rthumb", "guide", "lx.min", "lx.max", "ly.min", "ly.max", "rx.min",
    "rx.max", "ry.min", "ry.max",
];

/// Nothing is missing: this persona expresses ksx's whole control vocabulary.
const ABSENT_NOTHING: &[&str] = &[];

/// **The one persona → presentation table.** One row per
/// [`ksx_core::Persona`], plus [`UNKNOWN_PRESENTATION`] for a name this build
/// does not recognise.
///
/// ⚠️ ART: ksx ships exactly TWO vendored body drawings — `pad-xbox.svg` and
/// `pad-ds4.svg` (`studio-ui/art/README.md`; the five inline `.n-padwrap`
/// masters on /nocturne are xbox, ps, ps5, switchpro and xboxseries). **There is
/// no SNES art and no Genesis art in this tree, and none is invented here.**
/// Both retro rows therefore name the Xbox body as a DELIBERATE stand-in, which
/// is a different thing from the fall-through they used to get: it is written
/// down, it is the neutral outline the page already uses as empty-roster
/// ground, and it is the closer of the two — a cross D-pad, a four-button face
/// cluster and two shoulder chips, where the DS4 body has four separate D-pad
/// arrows and a touchpad. The seat's own title still says "SNES", and the
/// ZONES are the retro ones, so the picture is a stand-in while every control
/// the page offers is real.
pub(crate) const PAD_PRESENTATIONS: &[PadPresentation] = &[
    PadPresentation {
        persona: "xbox360",
        aliases: &["x360", "xbox", "360", "xinput"],
        family: "xbox",
        art: crate::render::ART_XBOX,
        zones: crate::render_map::ZONE_XBOX,
        legend: LEGEND_SAME_AS_TABLE,
        absent: ABSENT_NOTHING,
    },
    PadPresentation {
        persona: "playstation",
        aliases: &["ps", "ds4", "ps4", "dualshock", "dualshock4", "sony"],
        family: "ps",
        art: crate::render::ART_DS4,
        zones: crate::render_map::ZONE_DS4,
        legend: LEGEND_SAME_AS_TABLE,
        absent: ABSENT_NOTHING,
    },
    PadPresentation {
        // Its OWN family: a DualSense is not a DualShock — its own shell, its
        // own Create/Options pair, its own touchpad. It borrows the DS4 hit
        // geometry (same physical layout) and renames the one button Sony
        // renamed.
        persona: "dualsense",
        aliases: &["ds5", "ps5", "dualsense5"],
        family: "ps5",
        art: crate::render::ART_DS4,
        zones: crate::render_map::ZONE_DS4,
        legend: LEGEND_DUALSENSE,
        absent: ABSENT_NOTHING,
    },
    PadPresentation {
        persona: "switchpro",
        aliases: &["switch", "procontroller", "switchprocontroller", "nintendo"],
        family: "switchpro",
        art: crate::render::ART_XBOX,
        zones: crate::render_map::ZONE_XBOX,
        legend: LEGEND_SWITCHPRO,
        absent: ABSENT_NOTHING,
    },
    PadPresentation {
        persona: "xboxseries",
        aliases: &[
            "xboxseriesx",
            "xboxseriess",
            // `Persona::label()` for this one is "Xbox Series X|S", the string
            // a surface holding a label rather than an id would pass in. Every
            // other persona's label normalizes to its canonical name already.
            "xboxseriesx|s",
            "xboxseriesxs",
            "xboxseriesxsbt",
            "series",
            "xsx",
        ],
        family: "xboxseries",
        art: crate::render::ART_XBOX,
        zones: crate::render_map::ZONE_XBOX,
        legend: LEGEND_SAME_AS_TABLE,
        absent: ABSENT_NOTHING,
    },
    PadPresentation {
        // The SNES words are safe to print: `Persona::Snes`'s own doc states
        // the anchor this build measured — "positional faces (ksx A = bottom =
        // SNES B)" — and L/R/Select/Start are what is written on the shell.
        // They live in `ZONE_SNES`'s own label column, so there is no override
        // list here.
        persona: "snes",
        aliases: &["supernintendo", "superfamicom", "sfc"],
        family: "xbox",
        art: crate::render::ART_XBOX,
        zones: crate::render_map::ZONE_SNES,
        legend: LEGEND_SAME_AS_TABLE,
        absent: ABSENT_ON_A_DIGITAL_RETRO_PAD,
    },
    PadPresentation {
        // ⚠️ Its own table, printing ksx's function vocabulary rather than
        // SEGA letters — a DECISION, argued in full on `ZONE_GENESIS`: the
        // button-label table is recorded PROVISIONAL until the joy.cpl
        // press-check, and this one wire identity serves three different face
        // layouts (Genesis, Mega Drive, Saturn). The SHAPE is certain and is
        // what the table states; the letters are not, so it prints none.
        persona: "genesis",
        aliases: &[
            "megadrive",
            "md",
            "sega",
            "saturn",
            "segagenesis",
            "segamegadrive",
            "segasaturn",
            "megadrive6b",
        ],
        family: "xbox",
        art: crate::render::ART_XBOX,
        zones: crate::render_map::ZONE_GENESIS,
        legend: LEGEND_SAME_AS_TABLE,
        absent: ABSENT_ON_A_DIGITAL_RETRO_PAD,
    },
];

/// **The named outcome for a persona string this build does not recognise.**
///
/// Reachable exactly one way: a daemon newer than this Studio serving a
/// persona added after this binary was built. The old behavior for that case
/// was to draw a DualShock 4 (via `is_xinput == false`) and label it with Xbox
/// words, which is a confident answer to a question we cannot answer.
///
/// What each field says, and why:
///
/// - `family: "unknown"` — the ONE field the browser reads. No `.n-padwrap`
///   master carries that value, so the no-JS page deliberately draws NO body
///   rather than a wrong one, and the canvas renders a visible placeholder
///   naming the family instead of a silhouette.
/// - `zones: ZONE_XBOX` — not a guess about the device. ksx's wire vocabulary
///   is Xbox-flavored for EVERY persona (`ksx_core::persona` module doc: "the
///   wire vocabulary stays Xbox-flavored everywhere… ✕○△□ are display aliases,
///   not a second binding language"), so the Xbox table is the vocabulary
///   itself with no relabeling applied — the only table that claims nothing
///   about the hardware.
/// - `absent: &[]` — we must not claim a control is MISSING on a device we do
///   not recognise. "We do not know this pad" and "this pad has no right
///   stick" are different statements.
/// - `art: ART_XBOX` — `/pads` needs a URL for its tile and the Xbox line
///   drawing is the neutral one; the tile prints the persona name beside it.
pub(crate) const UNKNOWN_PRESENTATION: PadPresentation = PadPresentation {
    persona: "",
    aliases: &[],
    family: "unknown",
    art: crate::render::ART_XBOX,
    zones: crate::render_map::ZONE_XBOX,
    legend: LEGEND_SAME_AS_TABLE,
    absent: ABSENT_NOTHING,
};

/// Resolve a served persona name to its presentation. **Total** — every input
/// has an answer, and the answer for an unrecognised name is
/// [`UNKNOWN_PRESENTATION`], which says so.
///
/// Normalized the way `ksx_core::Persona::from_str` normalizes (drop spaces,
/// hyphens and underscores; lowercase) so a hand-edited `Xbox 360` and a
/// catalog slug `xbox-series-xs-bt` both land where the engine would put them.
///
/// **Two passes, and both are EXACT.**
///
/// 1. The name as given. Every machine-name caller lands here —
///    `StagedSlotView::persona` and `MapperSlot::persona` are documented as the
///    canonical [`ksx_core::Persona::as_str`] spelling.
///
/// 2. The name with its DECORATION removed — a parenthesised aside and a
///    trailing noun — matched exactly again. This exists for exactly one
///    caller: `/pads` does not serve persona ids at all. It lists what is on
///    the ViGEm bus, classified from hardware ids, and serves
///    `ksx_platform::PersonaGuess::label()` — the human strings `"Xbox 360
///    pad"` and `"PlayStation (DS4) pad"` — straight into `art_for`. Those drew
///    the right art only because the substring matcher this table replaced
///    happened to accept them, so dropping to one exact pass would have handed
///    every live DualShock 4 on that page an Xbox body: the very bug this
///    record exists to remove, reintroduced by its removal.
///    `a_human_label_still_finds_its_pad` pins those strings.
///
/// ⚠️ It is `strip_suffix`, deliberately NOT `contains`. A `contains` pass over
/// the canonical names resolves a future `"playstation6"` to the PlayStation
/// row and draws a PS6 as a DualShock 4 — silently, and for exactly the reason
/// this whole record was written. Extending a name must NOT inherit its
/// presentation; only stripping a word that is not part of any name may.
pub(crate) fn pad_presentation(persona: &str) -> &'static PadPresentation {
    /// Nouns a display name puts after the controller's actual name. None of
    /// them appears inside a canonical persona name or alias, which is what
    /// makes removing one safe.
    const DECORATIONS: [&str; 3] = ["pad", "gamepad", "controller"];

    let normalized: String = persona
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    let row_for = |name: &str| -> Option<&'static PadPresentation> {
        PAD_PRESENTATIONS
            .iter()
            .find(|row| row.persona == name || row.aliases.contains(&name))
    };
    if let Some(exact) = row_for(&normalized) {
        return exact;
    }
    // Drop any parenthesised aside ("PlayStation (DS4) pad"), then one
    // trailing noun, and ask again — still an exact question.
    let mut bare = String::with_capacity(normalized.len());
    let mut depth = 0usize;
    for c in normalized.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => bare.push(c),
            _ => {}
        }
    }
    for noun in DECORATIONS {
        if let Some(stem) = bare.strip_suffix(noun) {
            if let Some(row) = row_for(stem) {
                return row;
            }
        }
    }
    row_for(&bare).unwrap_or(&UNKNOWN_PRESENTATION)
}

/// Which drawn body a seat wears — read by both the per-slot pad views (what
/// each canvas widget clones) and the no-JS master classes.
///
/// One line of decision, because the decision is [`pad_presentation`]'s. The
/// `is_xinput` fall-through this used to end in is gone: it was a question
/// about Windows' four XInput slots being asked to answer "what does this
/// controller look like", and it answered "DualShock 4" for every plain-HID
/// persona ksx has added since.
///
/// `None` is the EMPTY ROSTER — no seat to draw — and keeps the neutral Xbox
/// outline as ground. That is a different case from an unrecognised persona,
/// which resolves to the `"unknown"` family instead.
fn pad_art_family(persona: Option<&str>) -> &'static str {
    match persona {
        Some(persona) => pad_presentation(persona).family,
        None => "xbox",
    }
}

fn nocturne_bind_group(function: &str) -> usize {
    match function {
        "a" | "b" | "x" | "y" | "A" | "B" | "X" | "Y" => 0,
        f if f.starts_with("dpad.") => 1,
        "lb" | "rb" | "lt" | "rt" => 2,
        "lthumb" => 3,
        f if f.starts_with("lx.") || f.starts_with("ly.") => 3,
        "rthumb" => 4,
        f if f.starts_with("rx.") || f.starts_with("ry.") => 4,
        _ => 5,
    }
}

/// The selected controller's WHOLE panel — the meta-strip words, the six
/// bind groups with their free-control chips and counts, the SOCD editor —
/// composed once for every page that shows a controller. `/nocturne`'s
/// right pane and `/redesign`'s inspector both serve exactly this struct,
/// so the two pages cannot disagree about a row, a count, or a class.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerPanel {
    pub slot_val: String,
    pub pad_badge: String,
    pub pad_badge_cls: String,
    pub pad_name: String,
    pub pad_sub: String,
    pub bind_title: String,
    pub bind_foot: String,
    pub bind_face: Vec<NocturneBindRow>,
    pub bind_dpad: Vec<NocturneBindRow>,
    pub bind_shoulders: Vec<NocturneBindRow>,
    pub bind_lstick: Vec<NocturneBindRow>,
    pub bind_rstick: Vec<NocturneBindRow>,
    pub bind_system: Vec<NocturneBindRow>,
    pub avail_face: Vec<NocturneCtlChip>,
    pub avail_dpad: Vec<NocturneCtlChip>,
    pub avail_shoulders: Vec<NocturneCtlChip>,
    pub avail_lstick: Vec<NocturneCtlChip>,
    pub avail_rstick: Vec<NocturneCtlChip>,
    pub avail_system: Vec<NocturneCtlChip>,
    pub bind_face_n: String,
    pub bind_dpad_n: String,
    pub bind_shoulders_n: String,
    pub bind_lstick_n: String,
    pub bind_rstick_n: String,
    pub bind_system_n: String,
    pub bind_face_cls: String,
    pub bind_dpad_cls: String,
    pub bind_shoulders_cls: String,
    pub bind_lstick_cls: String,
    pub bind_rstick_cls: String,
    pub bind_system_cls: String,
    pub bind_g_cls: String,
    pub socd_cls: String,
    pub socd_num: String,
    pub socd_lab: String,
    /// The selected slot's canonical SOCD name. The option roster is not
    /// ordered by current value, so browsers must not mistake its first row
    /// for the saved policy.
    #[serde(default)]
    pub socd_current: String,
    pub socd_edit_opts: Vec<NocturneOptionRow>,
}

pub(crate) fn compose_controller_panel(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
    q: Option<&str>,
) -> ControllerPanel {
    let selected_number = selected.map(|slot| slot.number);
    // The selected slot's opposite-directions editor. Hidden when nothing is
    // staged — and when the daemon serves no policy roster, because a select
    // of names the engine never listed would be an invented value.
    let socd_editable = staged.reachable && selected.is_some() && !staged.socd_options.is_empty();
    let socd_cls = if socd_editable {
        "n-socdform".to_owned()
    } else {
        "n-socdform none".to_owned()
    };
    let socd_num = if socd_editable {
        selected_number.map(|n| n.to_string()).unwrap_or_default()
    } else {
        String::new()
    };
    let socd_lab = if socd_editable {
        selected
            .map(|slot| format!("Opposites — P{}", slot.number))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let socd_current = if socd_editable {
        selected
            .map(|slot| {
                if slot.socd.is_empty() {
                    "off".to_owned()
                } else {
                    slot.socd.clone()
                }
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let socd_edit_opts: Vec<NocturneOptionRow> = if socd_editable {
        staged
            .socd_options
            .iter()
            .map(|option| NocturneOptionRow {
                value: option.name.clone(),
                label: option.title.clone(),
            })
            .collect()
    } else {
        Vec::new()
    };
    // The selected slot's ramp digit, worn by the meta badge and the pane's
    // dots (the keyboard's tint stays with the board composer).
    let pad_badge_cls = match selected_number {
        Some(digit) => format!("n-pbadge np{digit}"),
        None => "n-pbadge".to_owned(),
    };
    let slot_val = selected_number.map(|n| n.to_string()).unwrap_or_default();
    let (pad_badge, pad_name, pad_sub) = match selected {
        Some(slot) => (
            format!("P{}", slot.number),
            slot.persona_label.clone(),
            format!("\"{}\" preset · SOCD {}", slot.preset, slot.socd_label),
        ),
        None => (String::new(), String::new(), String::new()),
    };
    let binds = workspace_bind_rows(staged, selected);
    // The pane groups its rows the way the physical controller is
    // organised — face cluster, D-pad, shoulders & triggers, each
    // stick, system — so a row is found where a hand would find the
    // control. Six served lists (a list body is one flat template; the
    // group headers live in the island markup over these).
    let mut bind_groups: [Vec<NocturneBindRow>; 6] = Default::default();
    let mut avail_groups: [Vec<NocturneCtlChip>; 6] = Default::default();
    let mut bind_bound = [0usize; 6];
    for row in &binds.rows {
        // The mapper's own unbound placeholder (`key_tag`).
        let bound = row.keys != "—";
        let group = nocturne_bind_group(&row.function);
        if !bound {
            // A free control is a CHIP, not a row: its whole story is
            // "available" — click it to give it a key.
            avail_groups[group].push(NocturneCtlChip {
                function: row.function.clone(),
                label: row.label.clone(),
                cls: "n-ctlchip".to_owned(),
            });
            continue;
        }
        bind_bound[group] += 1;
        bind_groups[group].push(NocturneBindRow {
            function: row.function.clone(),
            label: row.label.clone(),
            chip: if bound {
                row.keys.clone()
            } else {
                "Unbound".to_owned()
            },
            note: row.share_note.clone(),
            chip_title: if bound {
                format!(
                    "Driven by {} — click, then press a new key to replace",
                    row.keys.replace(" · ", " or ")
                )
            } else {
                "Not bound — click, then press a key".to_owned()
            },
            badge: {
                let mut parts: Vec<String> = Vec::new();
                if row.toggle {
                    parts.push("Toggle".to_owned());
                }
                if !row.turbo_hz.is_empty() {
                    parts.push(format!("{}/s", row.turbo_hz));
                }
                parts.join(" · ")
            },
            badge_cls: if row.toggle || !row.turbo_hz.is_empty() {
                "n-rowbadge".to_owned()
            } else {
                "n-rowbadge none".to_owned()
            },
            add_cls: if bound {
                "n-addchip".to_owned()
            } else {
                "n-addchip none".to_owned()
            },
            cls: if bound {
                "n-bind on".to_owned()
            } else {
                "n-bind".to_owned()
            },
            chip_cls: match (bound, row.share_note.is_empty()) {
                (true, true) => "n-keychip".to_owned(),
                // The ONE shared-key signal, the board's dashed ring.
                (true, false) => "n-keychip shared".to_owned(),
                (false, _) => "n-keychip ghost".to_owned(),
            },
            minus_cls: if bound && row.keys.contains(" · ") {
                "n-minus".to_owned()
            } else {
                "n-minus none".to_owned()
            },
            clear_cls: if bound {
                "n-rowclear".to_owned()
            } else {
                "n-rowclear none".to_owned()
            },
            slot: row.slot.clone(),
            turbo: row.turbo_hz.clone(),
            hold_cls: if row.toggle {
                "n-bpill".to_owned()
            } else {
                "n-bpill on".to_owned()
            },
            tog_cls: if row.toggle {
                "n-bpill on".to_owned()
            } else {
                "n-bpill".to_owned()
            },
        });
    }
    // Within a group the rows read in the canonical spoken order (A B X
    // Y; LB RB LT RT) rather than the zone table's diamond geometry — a
    // LIST is scanned by name, not by position on the pad.
    for (group, order) in [
        (0usize, ["a", "b", "x", "y"]),
        (2, ["lb", "rb", "lt", "rt"]),
    ] {
        bind_groups[group].sort_by_key(|row| {
            order
                .iter()
                .position(|f| row.function.eq_ignore_ascii_case(f))
                .unwrap_or(usize::MAX)
        });
    }
    // The `?q=` filter, SERVER-resolved: a row matches on its own label
    // or its group's ("stick" keeps both stick clusters), and a group
    // whose rows are all hidden hides whole. The island's sweep applies
    // the SAME rule imperatively — the two must not drift, which is why
    // both read these exact labels.
    let query = q
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);
    let mut bind_group_cls: [String; 6] = std::array::from_fn(|_| "n-bindg".to_owned());
    if let Some(query) = query.as_deref() {
        for group in 0..6 {
            let gmatch = NOCTURNE_BIND_GROUP_LABELS[group]
                .to_lowercase()
                .contains(query);
            let mut visible = 0usize;
            for row in bind_groups[group].iter_mut() {
                if gmatch || row.label.to_lowercase().contains(query) {
                    visible += 1;
                } else {
                    row.cls.push_str(" hide");
                }
            }
            for chip in avail_groups[group].iter_mut() {
                if gmatch || chip.label.to_lowercase().contains(query) {
                    visible += 1;
                } else {
                    chip.cls.push_str(" hide");
                }
            }
            if visible == 0 && !(bind_groups[group].is_empty() && avail_groups[group].is_empty()) {
                bind_group_cls[group] = "n-bindg empty".to_owned();
            }
        }
    }
    let [bind_face_cls, bind_dpad_cls, bind_shoulders_cls, bind_lstick_cls, bind_rstick_cls, bind_system_cls] =
        bind_group_cls;
    let bind_heads: Vec<String> = bind_groups
        .iter()
        .zip(avail_groups.iter())
        .zip(bind_bound)
        .map(|((rows, avail), bound)| {
            let total = rows.len() + avail.len();
            if total == 0 {
                String::new()
            } else if bound == 0 {
                "none bound".to_owned()
            } else {
                format!("{bound} of {total} bound")
            }
        })
        .collect();
    let bind_g_cls = if binds.rows.is_empty() {
        "n-bindgroups none".to_owned()
    } else {
        match selected.map(|slot| slot.number) {
            Some(digit) => format!("n-bindgroups np{digit}"),
            None => "n-bindgroups".to_owned(),
        }
    };
    let [bind_face, bind_dpad, bind_shoulders, bind_lstick, bind_rstick, bind_system] = bind_groups;
    let [avail_face, avail_dpad, avail_shoulders, avail_lstick, avail_rstick, avail_system] =
        avail_groups;
    let [bind_face_n, bind_dpad_n, bind_shoulders_n, bind_lstick_n, bind_rstick_n, bind_system_n]: [String; 6] =
        bind_heads.try_into().expect("six groups");
    ControllerPanel {
        slot_val,
        pad_badge,
        pad_badge_cls,
        pad_name,
        pad_sub,
        bind_title: binds.title,
        bind_foot: binds.foot,
        bind_face,
        bind_dpad,
        bind_shoulders,
        bind_lstick,
        bind_rstick,
        bind_system,
        avail_face,
        avail_dpad,
        avail_shoulders,
        avail_lstick,
        avail_rstick,
        avail_system,
        bind_face_n,
        bind_dpad_n,
        bind_shoulders_n,
        bind_lstick_n,
        bind_rstick_n,
        bind_system_n,
        bind_face_cls,
        bind_dpad_cls,
        bind_shoulders_cls,
        bind_lstick_cls,
        bind_rstick_cls,
        bind_system_cls,
        bind_g_cls,
        socd_cls,
        socd_num,
        socd_lab,
        socd_current,
        socd_edit_opts,
    }
}

/// Every staged controller as the canvas widget's dressing — slot, family
/// (the ONE server-side art decision), preset identity, the fn→keys callout
/// table and the authoring/macro projections. Composed once for the redesign
/// workbench that mounts the pad widgets.
pub(crate) fn compose_pad_views(
    staged: &ksx_api::StagedSetupView,
    page: &str,
) -> Vec<NocturnePadView> {
    let keyboard_name = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    staged
        .slots
        .iter()
        .map(|slot| {
            let mut fn_keys = std::collections::BTreeMap::new();
            let mut mapping_available = true;
            let mut mapping_reason = String::new();
            let mapper = match ksx_api::staged_mapper_slot(slot, keyboard_name) {
                Ok(mapper) => Some(mapper),
                Err(refusal) => {
                    mapping_available = false;
                    mapping_reason = refusal.message;
                    None
                }
            };
            if let Some(m) = mapper.as_ref() {
                for (fn_name, keys) in &m.bindings {
                    if !keys.is_empty() {
                        fn_keys.insert(fn_name.clone(), keys.join(" · "));
                    }
                }
            }
            let controls = mapper
                .as_ref()
                .map(|mapper| nocturne_control_authoring(&slot.persona, mapper))
                .unwrap_or_default();
            let fn_names = crate::render_map::zones_for(&slot.persona)
                .iter()
                .map(|zone| {
                    (
                        zone.fn_name.to_owned(),
                        crate::render_map::legend_label_for_persona(&slot.persona, zone),
                    )
                })
                .collect();
            let macro_snapshot = ksx_api::staged_macro_snapshot(slot);
            let macros = macro_snapshot
                .macros
                .iter()
                .map(|mac| NocturneMacroFlow {
                    name: mac.name.clone(),
                    triggers: mac.triggers.clone(),
                    outputs: nocturne_macro_outputs(mac),
                    timeline: mac
                        .steps
                        .iter()
                        .map(|step| {
                            crate::render_map::hold_text_for_persona(&slot.persona, &step.hold)
                        })
                        .collect(),
                    meta: nocturne_macro_meta(mac),
                    disabled: mac.disabled,
                    edit_href: format!(
                        "{page}?slot={}&macro={}",
                        slot.number,
                        crate::render_map::urlencode_value(&mac.name)
                    ),
                })
                .collect();
            NocturnePadView {
                slot: slot.number,
                target_revision: slot.target_revision.clone(),
                family: pad_art_family(Some(slot.persona.as_str())).to_owned(),
                preset: slot.preset.clone(),
                title: format!("{} — \"{}\" preset", slot.persona_label, slot.preset),
                fn_keys,
                mapping_available,
                mapping_reason,
                controls,
                fn_names,
                macros,
                macro_available: macro_snapshot.available,
                macro_reason: macro_snapshot.reason,
            }
        })
        .collect()
}

/// The BY-KEY reading of the selected controller — each bound key with its
/// whole fan-out, the still-free keys of the given board in the keyboard's
/// own geography, and the counting note. Composed once for every page that
/// offers the Keys tab; `/nocturne` passes its resolved board, `/redesign`
/// the standard one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyPanel {
    pub key_rows: Vec<NocturneKeyRow>,
    pub keys_note: String,
    pub avail_main: Vec<NocturneKeyRow>,
    pub avail_nav: Vec<NocturneKeyRow>,
    pub avail_num: Vec<NocturneKeyRow>,
    pub avail_main_head: String,
    pub avail_nav_head: String,
    pub avail_num_head: String,
    pub avail_main_cls: String,
    pub avail_nav_cls: String,
    pub avail_num_cls: String,
}

pub(crate) fn compose_key_panel(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
    board: &crate::board::Board,
) -> KeyPanel {
    let selected_number = selected.map(|slot| slot.number);
    let keyboard_name = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let mapper = selected.and_then(|slot| ksx_api::staged_mapper_slot(slot, keyboard_name).ok());
    let trigger_keys = |slot: &ksx_api::StagedSlotView| -> Vec<(String, Vec<String>)> {
        ksx_api::staged_macro_snapshot(slot)
            .macros
            .into_iter()
            .filter(|m| !m.triggers.is_empty())
            .map(|m| (format!("macro.{}", m.name), m.triggers))
            .collect()
    };
    let selected_triggers: Vec<(String, Vec<String>)> =
        selected.map(trigger_keys).unwrap_or_default();
    // The same inversion the board reads: key → every function it drives,
    // alphabetical (BTreeMap order), macro triggers included.
    let mut key_fns: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    if let Some(mapper) = mapper.as_ref() {
        for (fn_name, keys) in &mapper.bindings {
            for key in keys {
                key_fns
                    .entry(key.as_str())
                    .or_default()
                    .push(fn_name.as_str());
            }
        }
    }
    for (fn_name, keys) in &selected_triggers {
        for key in keys {
            key_fns
                .entry(key.as_str())
                .or_default()
                .push(fn_name.as_str());
        }
    }
    // The READABLE control names — the zone tables' own labels, looked up
    // case-bridged because the mapper spells face functions UPPERCASE.
    let persona = selected
        .map(|slot| slot.persona.as_str())
        .unwrap_or("xbox360");
    let zone_labels: std::collections::HashMap<String, String> =
        crate::render_map::zones_for(persona)
            .iter()
            .map(|zone| {
                (
                    zone.fn_name.to_ascii_lowercase(),
                    crate::render_map::legend_label_for_persona(persona, zone),
                )
            })
            .collect();
    let readable = |f: &str| -> String {
        if let Some(name) = f.strip_prefix("macro.") {
            format!("macro \"{name}\"")
        } else {
            zone_labels
                .get(&f.to_ascii_lowercase())
                .cloned()
                .unwrap_or_else(|| f.to_owned())
        }
    };
    // A key's identity and its printed cap are deliberately different facts
    // (`board.rs`). Keep the canonical name on the row for every mapper verb,
    // but serve the cap alongside it for the inspector's human-facing chips.
    // First physical occurrence wins on boards that intentionally repeat one
    // emitted key across several cells.
    let mut key_labels: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for cell in &board.cells {
        if !cell.ghost && !cell.key.is_empty() && !cell.cap.is_empty() {
            key_labels
                .entry(cell.key.as_str())
                .or_insert(cell.cap.as_str());
        }
    }
    let key_label = |key: &str| -> String {
        key_labels
            .get(key)
            .copied()
            .filter(|label| !label.is_empty())
            .unwrap_or(key)
            .to_owned()
    };
    let key_rows: Vec<NocturneKeyRow> = key_fns
        .iter()
        .map(|(key, fns)| NocturneKeyRow {
            key_label: key_label(key),
            key: (*key).to_owned(),
            targets: fns
                .iter()
                .map(|f| readable(f))
                .collect::<Vec<_>>()
                .join(" · "),
            fns: fns
                .iter()
                .map(|f| f.to_lowercase())
                .collect::<Vec<_>>()
                .join(" "),
            cls: if fns.len() > 1 {
                "n-krow shared".to_owned()
            } else {
                "n-krow".to_owned()
            },
            slot: selected_number.map(|n| n.to_string()).unwrap_or_default(),
        })
        .collect();
    // Every key of the given board NOT yet bound, in the keyboard's own
    // geography: main block, navigation cluster, numpad.
    const NAV_KEYS: [&str; 13] = [
        "Insert",
        "Delete",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Up",
        "Down",
        "Left",
        "Right",
        "PrintScreen",
        "ScrollLock",
        "Pause",
    ];
    let mut avail_main: Vec<NocturneKeyRow> = Vec::new();
    let mut avail_nav: Vec<NocturneKeyRow> = Vec::new();
    let mut avail_num: Vec<NocturneKeyRow> = Vec::new();
    if selected.is_some() {
        // **One chip per KEY, not per cell** — a Board makes duplicates
        // ordinary and deliberate (shared-key encoder terminals), and an
        // undeduped list hands a differ's recycled node to the wrong row.
        let mut offered: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for cell in &board.cells {
            if cell.ghost
                || cell.key.is_empty()
                || key_fns.contains_key(cell.key.as_str())
                || !offered.insert(cell.key.as_str())
            {
                continue;
            }
            let chip = NocturneKeyRow {
                key_label: key_label(&cell.key),
                key: cell.key.clone(),
                targets: String::new(),
                fns: String::new(),
                cls: "n-akey".to_owned(),
                slot: String::new(),
            };
            if cell.key.starts_with("Numpad") || cell.key == "NumLock" {
                avail_num.push(chip);
            } else if NAV_KEYS.contains(&cell.key.as_str()) {
                avail_nav.push(chip);
            } else {
                avail_main.push(chip);
            }
        }
    }
    let section = |name: &str, rows: &Vec<NocturneKeyRow>| -> (String, String) {
        if rows.is_empty() {
            (String::new(), "n-akeysec none".to_owned())
        } else {
            (format!("{name} · {}", rows.len()), "n-akeysec".to_owned())
        }
    };
    let (avail_main_head, avail_main_cls) = section("Main block", &avail_main);
    let (avail_nav_head, avail_nav_cls) = section("Navigation", &avail_nav);
    let (avail_num_head, avail_num_cls) = section("Numpad", &avail_num);
    let avail_total = avail_main.len() + avail_nav.len() + avail_num.len();
    let keys_note = match selected {
        Some(_) if !key_rows.is_empty() => format!(
            "{} keys drive this controller · {} more available below.",
            key_rows.len(),
            avail_total
        ),
        Some(_) => {
            "No keys bound yet — click an available key, then a control on the pad.".to_owned()
        }
        None => String::new(),
    };
    KeyPanel {
        key_rows,
        keys_note,
        avail_main,
        avail_nav,
        avail_num,
        avail_main_head,
        avail_nav_head,
        avail_num_head,
        avail_main_cls,
        avail_nav_cls,
        avail_num_cls,
    }
}

/// The KEYBOARD widget's whole serving — the drawn plate (cells placed as
/// percentages of the board's own bounds), the off-board tray, the legend
/// with its solo lens, the picker roster and the honest picker sentence —
/// composed once for the redesign workbench. One implementation owns the
/// board, so its canvas, inspector and picker cannot disagree about a cap, a
/// band, or a sentence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardPanel {
    pub kb_title: String,
    pub kb_cls: String,
    pub board_case_style: String,
    pub board_origin: String,
    pub board_line: String,
    pub board_rows: Vec<NocturneChoiceRow>,
    pub kb_row1: Vec<NocturneKeyCell>,
    pub kb_row2: Vec<NocturneKeyCell>,
    pub kb_row3: Vec<NocturneKeyCell>,
    pub kb_row4: Vec<NocturneKeyCell>,
    pub kb_row5: Vec<NocturneKeyCell>,
    pub kb_row6: Vec<NocturneKeyCell>,
    pub kb_tray: Vec<NocturneKeyCell>,
    pub kb_tray_head: String,
    pub kb_tray_cls: String,
    pub legend: Vec<NocturneLegendRow>,
    pub solo_label: String,
    pub kb_more_cls: String,
    pub kb_note: String,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compose_board_panel(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
    board: &crate::board::Board,
    chosen_board: &str,
    panel_profiles: &[ksx_api::PanelHardwareProfile],
    drawn_boards: &[ksx_api::BoardDocument],
    encoder_staged: bool,
    transport: Option<&str>,
    drawn_error: &str,
    panels_error: &str,
) -> BoardPanel {
    let selected_number = selected.map(|slot| slot.number);
    let keyboard_name = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let mapper = selected.and_then(|slot| ksx_api::staged_mapper_slot(slot, keyboard_name).ok());
    // ⚠️ A MACRO TRIGGER IS A BINDING TOO. `MapperSlot.bindings` is built
    // from the preset's CONTROL entries only — a macro trigger lives in a
    // separate table with no `Binding` variant — so every inversion built
    // on it alone was blind to them: the key that starts a macro painted
    // UNBOUND on the board, and "add another trigger key" appended to a
    // list it could not see, which is a replace.
    let trigger_keys = |slot: &ksx_api::StagedSlotView| -> Vec<(String, Vec<String>)> {
        ksx_api::staged_macro_snapshot(slot)
            .macros
            .into_iter()
            .filter(|m| !m.triggers.is_empty())
            .map(|m| (format!("macro.{}", m.name), m.triggers))
            .collect()
    };
    let selected_triggers: Vec<(String, Vec<String>)> =
        selected.map(trigger_keys).unwrap_or_default();
    let mut key_fns: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    if let Some(mapper) = mapper.as_ref() {
        for (fn_name, keys) in &mapper.bindings {
            for key in keys {
                key_fns
                    .entry(key.as_str())
                    .or_default()
                    .push(fn_name.as_str());
            }
        }
    }
    for (fn_name, keys) in &selected_triggers {
        for key in keys {
            key_fns
                .entry(key.as_str())
                .or_default()
                .push(fn_name.as_str());
        }
    }
    // The GLOBAL ownership read: which controllers each key drives,
    // across EVERY staged slot — the board's color strips wear it.
    let mut key_slots: std::collections::BTreeMap<String, Vec<u8>> =
        std::collections::BTreeMap::new();
    for slot in &staged.slots {
        let mut own = |key: &String| {
            let owners = key_slots.entry(key.clone()).or_default();
            if !owners.contains(&slot.number) {
                owners.push(slot.number);
            }
        };
        if let Ok(m) = ksx_api::staged_mapper_slot(slot, keyboard_name) {
            for keys in m.bindings.values() {
                for key in keys {
                    own(key);
                }
            }
        }
        // …and the keys that START a macro on this controller.
        for (_, keys) in trigger_keys(slot) {
            for key in &keys {
                own(key);
            }
        }
    }
    // OWNERSHIP IS THE CAP'S FILL. Every key that some controller drives
    // paints that controller's color; a key several controllers share
    // splits into one band each, ALWAYS in slot order. The order is
    // stable on purpose: a key P1 and P2 share reads blue|coral whoever
    // you are editing, so the stripe itself tells you who is on it and
    // the map never rearranges under you. (Which of them is YOURS is
    // the ring's job — see `--mine` in the sheet.) Four bands is the
    // honest ceiling at 30px; past it the cap stops naming owners
    // altogether and becomes a STACK.
    let bands = |owners: &[u8]| -> String {
        if owners.is_empty() {
            return String::new();
        }
        if owners.len() > BAND_MAX {
            // THE STACK. Three colors out of eight would be an arbitrary
            // three, and a band plus a separate "+N" makes you add two
            // marks that stand for the same controllers. So past four the
            // face becomes one woven texture that names NOBODY, and the
            // cap carries the TOTAL: nothing to add, nothing to guess.
            // (Every owner is still named in the cap's own sentence, and
            // the ring still says whether one of them is yours.)
            return format!(" bstack bcount{}", owners.len());
        }
        let mut order: Vec<u8> = owners.to_vec();
        order.sort_unstable();
        let mut cls = format!(" bn{}", order.len());
        for (at, slot) in order.iter().enumerate() {
            cls.push_str(&format!(" {}{slot}", BAND_KEYS[at]));
        }
        cls
    };
    // Does any key carry more owners than the bands can name? Then the
    // legend explains the stacked cap in words, beside the colors it
    // stands in for — a mark nothing names is a mark you have to guess.
    let kb_more_cls = if key_slots.values().any(|owners| owners.len() > BAND_MAX) {
        "n-lgdmore".to_owned()
    } else {
        "n-lgdmore none".to_owned()
    };
    // The board's legend: every staged controller with its color, so
    // "which color is who" is answerable without the left pane, and
    // each chip is the door to muting that player on the keys.
    let legend: Vec<NocturneLegendRow> = staged
        .slots
        .iter()
        .map(|slot| NocturneLegendRow {
            slot: slot.number.to_string(),
            badge: format!("P{}", slot.number),
            name: slot.persona_label.clone(),
            // The selected controller's chip is marked, so "only this
            // one" can cross out every OTHER chip without the browser
            // having to work out which is which.
            cls: if selected_number == Some(slot.number) {
                format!("n-lgd np{} on", slot.number)
            } else {
                format!("n-lgd np{}", slot.number)
            },
        })
        .collect();
    let solo_label = match selected_number {
        Some(number) => format!("Only P{number}"),
        None => "Only this player".to_owned(),
    };
    let persona = selected
        .map(|slot| slot.persona.as_str())
        .unwrap_or("xbox360");
    // The READABLE control names for hover/assistive sentences — the
    // zone tables' own labels ("LS ↑", "D-pad ←", "△"), looked up
    // case-bridged because the mapper spells face functions UPPERCASE.
    let zone_labels: std::collections::HashMap<String, String> =
        crate::render_map::zones_for(persona)
            .iter()
            .map(|zone| {
                (
                    zone.fn_name.to_ascii_lowercase(),
                    crate::render_map::legend_label_for_persona(persona, zone),
                )
            })
            .collect();
    let readable = |f: &str| -> String {
        if let Some(name) = f.strip_prefix("macro.") {
            format!("macro \"{name}\"")
        } else {
            zone_labels
                .get(&f.to_ascii_lowercase())
                .cloned()
                .unwrap_or_else(|| f.to_owned())
        }
    };
    let drives_whom = selected
        .map(|slot| format!(" on P{}", slot.number))
        .unwrap_or_default();
    // The plate's own coordinate system. Cells are placed as PERCENTAGES
    // of it, which is what retires the hand-fitted board width: studio.css
    // had to pick 35.5px so the plate filled one 980px card and warns
    // against 36px because that lands it wider than its scroll container.
    // A percentage board fits whatever card it is given, and a panel — a
    // different shape entirely — needs no second hand-fitting.
    let (board_w, board_h) = board.bounds;
    let board_origin = board.origin.as_str().to_owned();
    let pct = |value: f32, span: f32| {
        if span > 0.0 {
            value / span * 100.0
        } else {
            0.0
        }
    };
    let dress = |cell: &&crate::board::BoardCell| {
        let mut cls = String::from("n-key");
        if !cell.unit.is_empty() {
            cls.push(' ');
            cls.push_str(&cell.unit);
        }
        if cell.sp {
            cls.push_str(" sp");
        }
        if cell.ghost {
            cls.push_str(" ghost");
        }
        let fns = key_fns.get(cell.key.as_str()).filter(|fns| !fns.is_empty());
        let (short, title) = match fns {
            Some(fns) => {
                cls.push_str(" bound");
                if fns.len() > 1 {
                    cls.push_str(" shared");
                }
                let short = crate::keyboard_layout::short_for(persona, fns[0]);
                let spoken: Vec<String> = fns.iter().map(|f| readable(f)).collect();
                (
                    short,
                    format!("{} — drives {}{drives_whom}", cell.cap, spoken.join(" · ")),
                )
            }
            None => (String::new(), String::new()),
        };
        let owners = key_slots
            .get(cell.key.as_str())
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        let others: Vec<String> = owners
            .iter()
            .filter(|n| Some(**n) != selected_number)
            .map(|n| format!("P{n}"))
            .collect();
        let title = if !others.is_empty() {
            if title.is_empty() {
                format!("{} — bound on {}", cell.cap, others.join(" · "))
            } else {
                format!("{title}; also bound on {}", others.join(" · "))
            }
        } else {
            title
        };
        let aria = if title.is_empty() {
            cell.cap.to_owned()
        } else {
            title.clone()
        };
        cls.push_str(&bands(owners));
        NocturneKeyCell {
            cap: cell.cap.clone(),
            key: cell.key.clone(),
            cls,
            short,
            title,
            aria,
            disabled: cell.ghost || cell.key.is_empty(),
            tab: if cell.ghost || cell.key.is_empty() {
                "-1".to_owned()
            } else {
                "0".to_owned()
            },
            aria_hidden: if cell.ghost || cell.key.is_empty() {
                "true".to_owned()
            } else {
                "false".to_owned()
            },
            style: format!(
                "left:{:.4}%;top:{:.4}%;width:{:.4}%;height:{:.4}%",
                pct(cell.x, board_w),
                pct(cell.y, board_h),
                pct(cell.w, board_w),
                pct(cell.h, board_h)
            ),
        }
    };
    let kb_rows: Vec<Vec<NocturneKeyCell>> = board
        .rows()
        .iter()
        .map(|row| row.iter().map(dress).collect())
        .collect();
    let mut kb_rows = kb_rows.into_iter();
    let kb_row1 = kb_rows.next().unwrap_or_default();
    let kb_row2 = kb_rows.next().unwrap_or_default();
    let kb_row3 = kb_rows.next().unwrap_or_default();
    let kb_row4 = kb_rows.next().unwrap_or_default();
    let kb_row5 = kb_rows.next().unwrap_or_default();
    let kb_row6 = kb_rows.next().unwrap_or_default();
    // Off-board keys: bound in the table but not on the standard board.
    let board_keys: std::collections::BTreeSet<&str> = board
        .cells
        .iter()
        .filter(|cell| !cell.key.is_empty())
        .map(|cell| cell.key.as_str())
        .collect();
    let kb_tray: Vec<NocturneKeyCell> = key_fns
        .iter()
        .filter(|(key, _)| !board_keys.contains(*key))
        .map(|(key, fns)| {
            let tray_owners = key_slots.get(*key).map(|v| v.as_slice()).unwrap_or(&[]);
            let spoken: Vec<String> = fns.iter().map(|f| readable(f)).collect();
            let title = format!("{key} — drives {}{drives_whom}", spoken.join(" · "));
            // The board's cells name the other owners; so does the tray.
            let others: Vec<String> = tray_owners
                .iter()
                .filter(|n| Some(**n) != selected_number)
                .map(|n| format!("P{n}"))
                .collect();
            let title = if others.is_empty() {
                title
            } else {
                format!("{title}; also bound on {}", others.join(" · "))
            };
            NocturneKeyCell {
                cap: (*key).to_owned(),
                key: (*key).to_owned(),
                cls: {
                    let mut cls = if fns.len() > 1 {
                        "n-key tray bound shared".to_owned()
                    } else {
                        "n-key tray bound".to_owned()
                    };
                    cls.push_str(&bands(tray_owners));
                    cls
                },
                short: crate::keyboard_layout::short_for(persona, fns[0]),
                aria: title.clone(),
                title,
                disabled: false,
                tab: "0".to_owned(),
                aria_hidden: "false".to_owned(),
                // The TRAY is not on the plate. These are keys bound off
                // whatever board is drawn, so they have no place on it —
                // they stay a flowed strip, and an empty style is what
                // says so rather than a position that means nothing.
                style: String::new(),
            }
        })
        .collect();
    let kb_tray_head = format!("Bound off this board · {}", kb_tray.len());
    let kb_tray_cls = if kb_tray.is_empty() {
        "n-kbtray none".to_owned()
    } else {
        "n-kbtray".to_owned()
    };
    let kb_note = match selected {
        Some(slot) if mapper.is_some() => format!(
            "Key shorts show what drives P{} · {} — on a standard board layout.",
            slot.number, slot.persona_label
        ),
        _ => String::new(),
    };
    // This plate is the logical key space controllers bind against, not a
    // model-specific drawing of the physical board selected as the source.
    // Name that relationship directly: the device and transport are source
    // context after the stable mapping-surface title, never the title itself.
    let kb_title = match staged.device.as_ref() {
        _ if !staged.reachable => "Input source unavailable — reopen KSX".to_owned(),
        Some(d) => match transport.filter(|t| !t.trim().is_empty()) {
            Some(t) => format!("{} · {} · Active input", d.label, t),
            None => format!("{} · Active input", d.label),
        },
        None => "No input source selected".to_owned(),
    };
    // The ramp digit on the plate: the selected controller's bound-cap tint.
    let kb_cls = match selected_number {
        Some(digit) => format!("n-kb np{digit}"),
        None => "n-kb".to_owned(),
    };
    let board_case_style = format!(
        "aspect-ratio:{board_w:.2} / {board_h:.2};         max-width:min(100%, calc(var(--n-kbcase-max-h) * {board_w:.2} / {board_h:.2}))"
    );
    let board_rows: Vec<NocturneChoiceRow> =
        crate::board::Board::roster(panel_profiles, drawn_boards)
            .into_iter()
            .map(|choice| NocturneChoiceRow {
                chosen: choice.id == board.id,
                cls: if choice.id == board.id {
                    "n-radio on".to_owned()
                } else {
                    "n-radio".to_owned()
                },
                name: choice.id,
                title: choice.name,
                detail: choice.detail,
            })
            .collect();
    let board_line = if !drawn_error.is_empty() && !panels_error.is_empty() {
        format!("{drawn_error} {panels_error}")
    } else if !drawn_error.is_empty() {
        drawn_error.to_owned()
    } else if !panels_error.is_empty() {
        panels_error.to_owned()
    } else if encoder_staged && panel_profiles.len() > 1 && chosen_board.is_empty() {
        "You have more than one saved panel layout, and a saved          layout does not record which board it came off. Pick the          one that matches the encoder you plugged in."
            .to_owned()
    } else if encoder_staged && panel_profiles.is_empty() {
        "Your arcade panel can be a board here too — but ksx cannot          guess what it emits, because an encoder only ever tells the          host that a key arrived. Save a panel layout and it joins          this list."
            .to_owned()
    } else {
        "The picture only. Which key drives which control is the same          whichever board is on screen."
            .to_owned()
    };
    BoardPanel {
        kb_title,
        kb_cls,
        board_case_style,
        board_origin,
        board_line,
        board_rows,
        kb_row1,
        kb_row2,
        kb_row3,
        kb_row4,
        kb_row5,
        kb_row6,
        kb_tray,
        kb_tray_head,
        kb_tray_cls,
        legend,
        solo_label,
        kb_more_cls,
        kb_note,
    }
}

/// The staged input's capture behaviour, as choice rows — the daemon's own
/// roster with the current answer marked, reworded for an arcade encoder
/// (its "keys" are wired buttons, not typing). Composed once for every page
/// that offers the picker: `/nocturne`'s device section and `/redesign`'s
/// While-playing menu on the keyboard widget.
pub(crate) fn compose_capture_rows(
    staged: &ksx_api::StagedSetupView,
    selected_is_panel_encoder: bool,
) -> (Vec<NocturneChoiceRow>, String) {
    let note = if staged.reachable && selected_is_panel_encoder {
        "Choose how this encoder's Windows key signals behave while Play is running. Hardware assignments stay unchanged."
            .to_owned()
    } else if staged.reachable {
        String::new()
    } else {
        "The draft could not be read, so the capture answer cannot be shown. Reopen ksx.".to_owned()
    };
    let current_mode = staged.blocking.as_deref().unwrap_or("");
    let rows = if staged.reachable {
        staged
            .blocking_options
            .iter()
            .map(|option| {
                let (title, detail) = if selected_is_panel_encoder {
                    match option.name.as_str() {
                        "whole" => (
                            "Dedicated arcade panel".to_owned(),
                            "Capture every I-PAC signal during Play so cabinet buttons never type into Windows or trigger shortcuts."
                                .to_owned(),
                        ),
                        "bound-keys" => (
                            "Share unused outputs with Windows".to_owned(),
                            "Capture mapped I-PAC signals; outputs that KSX does not use still pass through to Windows."
                                .to_owned(),
                        ),
                        _ => (
                            "Observe and pass through".to_owned(),
                            "KSX routes mapped outputs while Windows receives those same I-PAC key signals too."
                                .to_owned(),
                        ),
                    }
                } else {
                    (option.title.clone(), option.detail.clone())
                };
                NocturneChoiceRow {
                chosen: option.name == current_mode,
                name: option.name.clone(),
                title,
                detail,
                cls: if option.name == current_mode {
                    "n-radio on".to_owned()
                } else {
                    "n-radio".to_owned()
                },
            }
            })
            .collect()
    } else {
        Vec::new()
    };
    (rows, note)
}

/// The selected slot's macros as lifecycle rows — trigger chip, meta,
/// enable/disable, delete, and the edit door into the step editor on the
/// CONSUMING page (`page` = "/nocturne" or "/redesign"). Composed once for
/// both inspectors.
pub(crate) fn compose_macro_rows(
    selected: Option<&ksx_api::StagedSlotView>,
    page: &str,
) -> (String, Vec<NocturneMacroRow>, String) {
    match selected {
        None => ("Macros".to_owned(), Vec::new(), String::new()),
        Some(slot) => {
            let snap = ksx_api::staged_macro_snapshot(slot);
            if !snap.available {
                ("Macros".to_owned(), Vec::new(), snap.reason.clone())
            } else {
                let rows: Vec<NocturneMacroRow> = snap
                    .macros
                    .iter()
                    .map(|mac| {
                        let triggered = !mac.triggers.is_empty();
                        NocturneMacroRow {
                            name: mac.name.clone(),
                            fn_name: format!("macro.{}", mac.name),
                            chip: if triggered {
                                mac.triggers.join(" · ")
                            } else {
                                "No trigger key".to_owned()
                            },
                            chip_title: if triggered {
                                format!(
                                    "Started by {} — click, then press a new trigger key",
                                    mac.triggers.join(" or ")
                                )
                            } else {
                                "No trigger key — click, then press a key".to_owned()
                            },
                            add_cls: if triggered {
                                "n-addchip".to_owned()
                            } else {
                                "n-addchip none".to_owned()
                            },
                            chip_cls: if triggered {
                                "n-keychip".to_owned()
                            } else {
                                "n-keychip ghost".to_owned()
                            },
                            meta: nocturne_macro_meta(mac),
                            cls: if triggered && !mac.disabled {
                                "n-bind on".to_owned()
                            } else {
                                "n-bind".to_owned()
                            },
                            slot: slot.number.to_string(),
                            edit_href: format!(
                                "{page}?slot={}&macro={}",
                                slot.number,
                                crate::render_map::urlencode_value(&mac.name)
                            ),
                            toggle_label: if mac.disabled {
                                "Enable".to_owned()
                            } else {
                                "Disable".to_owned()
                            },
                            toggle_value: if mac.disabled {
                                "yes".to_owned()
                            } else {
                                String::new()
                            },
                        }
                    })
                    .collect();
                let head = format!("Macros · {}", rows.len());
                let note = if rows.is_empty() {
                    "No macros in this layout yet — author them in the Controls editor.".to_owned()
                } else {
                    String::new()
                };
                (head, rows, note)
            }
        }
    }
}

/// A human-scannable order independent of the art tables' drawing order.
/// The tables remain the source of which controls and persona labels exist;
/// this rank only normalizes those controls into face, D-pad, shoulders,
/// sticks, system for any authoring surface.
fn nocturne_control_rank(function: &str) -> (usize, usize) {
    let group = nocturne_bind_group(function);
    let normalized = function.to_ascii_lowercase();
    let within = match group {
        0 => ["a", "b", "x", "y"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        1 => ["dpad.up", "dpad.down", "dpad.left", "dpad.right"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        2 => ["lb", "rb", "lt", "rt"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        3 => ["lthumb", "ly.max", "ly.min", "lx.min", "lx.max"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        4 => ["rthumb", "ry.max", "ry.min", "rx.min", "rx.max"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        _ => ["back", "guide", "start"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
    };
    (group, within)
}

fn nocturne_control_authoring(
    persona: &str,
    mapper: &ksx_api::MapperSlot,
) -> Vec<NocturneControlAuthoring> {
    let mut zones: Vec<_> = crate::render_map::zones_for(persona).iter().collect();
    zones.sort_by_key(|zone| nocturne_control_rank(zone.fn_name));
    zones
        .into_iter()
        .enumerate()
        .map(|(order, zone)| {
            // Face-button casing differs between some mapper providers and
            // the art vocabulary. Read every authored fact case-bridged, but
            // always serialize the zone table's canonical spelling.
            let keys = mapper
                .bindings
                .get(zone.fn_name)
                .or_else(|| {
                    mapper
                        .bindings
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(zone.fn_name))
                        .map(|(_, keys)| keys)
                })
                .cloned()
                .unwrap_or_default();
            let toggle = mapper
                .toggle
                .iter()
                .any(|name| name.eq_ignore_ascii_case(zone.fn_name));
            let turbo_hz = mapper.turbo.get(zone.fn_name).copied().or_else(|| {
                mapper
                    .turbo
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(zone.fn_name))
                    .map(|(_, rate)| *rate)
            });
            let group = nocturne_bind_group(zone.fn_name);
            NocturneControlAuthoring {
                function: zone.fn_name.to_owned(),
                label: crate::render_map::legend_label_for_persona(persona, zone),
                group: NOCTURNE_CONTROL_GROUPS[group].to_owned(),
                order,
                keys,
                toggle,
                turbo_hz,
            }
        })
        .collect()
}

/// **What ksx knows about a board, in the words the device roster has room
/// for.** Empty for a board in no catalog, which is most of them.
///
/// Composed here rather than served as six more fields because the row
/// already carries two sentences the server owns — `meta` and `title` — and
/// a fact nobody has room to render is a field that reaches nothing. The
/// backend still owns every word: this only chooses which of them fit.
fn identity_meta(board: &ksx_api::BoardRow) -> String {
    let Some(family) = board.family_label.as_deref() else {
        return String::new();
    };
    let mut out = format!(" · {family}");
    if let Some(firmware) = board.firmware_label.as_deref() {
        out.push_str(&format!(" · firmware {firmware}"));
    }
    // Only ever the capacity of a MEASURED profile. An unprofiled board
    // says nothing here rather than a number ksx would be inventing.
    if let Some(count) = board.terminal_count {
        out.push_str(&format!(" · {count} terminals"));
    }
    out
}

fn device_connection_label(selector: &str) -> String {
    let trimmed = selector.trim();
    let usb: Vec<_> = trimmed.splitn(4, ':').collect();
    if usb.len() == 4
        && usb[0].eq_ignore_ascii_case("usb")
        && usb[1].len() == 4
        && usb[2].len() == 4
        && usb[1].chars().all(|c| c.is_ascii_hexdigit())
        && usb[2].chars().all(|c| c.is_ascii_hexdigit())
        && !usb[3].is_empty()
    {
        return format!(
            "USB {}:{} · connection {}",
            usb[1].to_ascii_uppercase(),
            usb[2].to_ascii_uppercase(),
            usb[3].to_ascii_uppercase()
        );
    }
    let tail = trimmed
        .rsplit(['\\', '/', ':'])
        .find(|component| !component.is_empty());
    tail.map_or_else(
        || "Exact connection available after identification".to_owned(),
        |component| format!("Connection {component} · {}", selector_fingerprint(trimmed)),
    )
}

/// Compact, stable identity derived from every UTF-8 byte in a selector.
///
/// The readable connection tail helps people distinguish ports at a glance;
/// this suffix keeps selectors with the same tail (including punctuation-only
/// differences) from collapsing to the same label.
fn selector_fingerprint(selector: &str) -> String {
    let mut fingerprint = 0xcbf29ce484222325_u64;
    for byte in selector.as_bytes() {
        fingerprint ^= u64::from(*byte);
        fingerprint = fingerprint.wrapping_mul(0x100000001b3);
    }

    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut encoded = [b'0'; 13];
    for digit in encoded.iter_mut().rev() {
        *digit = DIGITS[(fingerprint % 36) as usize];
        fingerprint /= 36;
    }
    encoded.into_iter().map(char::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redesign_journey_counts_finished_work_and_routes_the_real_input_action() {
        let staged_slot = ksx_api::StagedSlotView {
            number: 1,
            bindings: 3,
            ..ksx_api::StagedSlotView::default()
        };
        let later_work_without_input = ksx_api::StagedSetupView {
            reachable: true,
            slots: vec![staged_slot.clone()],
            blocking: Some("split".to_owned()),
            ..ksx_api::StagedSetupView::default()
        };
        let idle = crate::control::SessionView {
            reachable: true,
            ..crate::control::SessionView::default()
        };
        let blocked_play = RedesignActionState {
            reason: "Finish setup before Play.".to_owned(),
            ..RedesignActionState::default()
        };

        let without_input = RedesignJourney::of(
            &later_work_without_input,
            &idle,
            &RedesignCaptureState::default(),
            &blocked_play,
        );
        assert_eq!(without_input.compact, "2/4 complete · Pick input");
        assert_eq!(without_input.rows[0].action, "devices");
        assert_eq!(without_input.rows[0].badge, "Now");
        assert_eq!(without_input.rows[1].badge, "Done");
        assert_eq!(without_input.rows[2].badge, "Done");

        let selected = ksx_api::StagedSetupView {
            device: Some(ksx_api::StagedDeviceView {
                label: "Ultimarc I-PAC 4".to_owned(),
                selector: "usb:d209:0430:00".to_owned(),
                backend: "winusb".to_owned(),
                ..ksx_api::StagedDeviceView::default()
            }),
            slots: vec![staged_slot],
            blocking: Some("split".to_owned()),
            reachable: true,
            ..ksx_api::StagedSetupView::default()
        };
        let preparation = RedesignCaptureState {
            mode: "prepare".to_owned(),
            line: "Prepare this input before Save or Play.".to_owned(),
            ..RedesignCaptureState::default()
        };
        let journey = RedesignJourney::of(&selected, &idle, &preparation, &blocked_play);
        assert_eq!(journey.compact, "2/4 complete · Preparation required");
        assert_eq!(journey.rows[0].title, "Prepare the input");
        assert_eq!(journey.rows[0].badge, "Prepare");
        assert_eq!(journey.rows[0].action, "capture");
        assert!(journey.rows[0].detail.contains("I-PAC 4 is selected"));
        assert_eq!(journey.rows[1].action, "controllers");
        assert_eq!(journey.rows[2].action, "mapping");
        assert_eq!(journey.rows[3].action, "play");

        let ready_capture = RedesignCaptureState {
            mode: "ready".to_owned(),
            ..RedesignCaptureState::default()
        };
        let allowed_play = RedesignActionState {
            allowed: true,
            reason: "Start these virtual controllers.".to_owned(),
            ..RedesignActionState::default()
        };
        let ready = RedesignJourney::of(&selected, &idle, &ready_capture, &allowed_play);
        assert_eq!(ready.compact, "3/4 complete · Ready to play");
        assert_eq!(ready.rows[0].title, "Input ready");
        assert_eq!(ready.rows[0].badge, "Done");
        assert_eq!(ready.rows[0].action, "devices");

        let capture_unavailable = RedesignCaptureState {
            mode: "unavailable".to_owned(),
            line: "The device inventory could not be read.".to_owned(),
            ..RedesignCaptureState::default()
        };
        let retry = RedesignJourney::of(&selected, &idle, &capture_unavailable, &blocked_play);
        assert_eq!(retry.rows[0].badge, "Action required");
        assert_eq!(retry.rows[0].action, "retry");

        let wire = serde_json::to_value(&journey).expect("journey serializes");
        assert_eq!(
            wire.pointer("/rows/0/action"),
            Some(&serde_json::json!("capture"))
        );
        assert_eq!(
            wire.pointer("/rows/1/action"),
            Some(&serde_json::json!("controllers"))
        );

        let unavailable = RedesignJourney::of(
            &ksx_api::StagedSetupView::default(),
            &idle,
            &RedesignCaptureState::default(),
            &blocked_play,
        );
        assert!(unavailable.rows.iter().all(|row| row.action == "retry"));
    }

    #[test]
    fn redesign_recovery_keeps_every_claimed_board_even_when_identity_is_incomplete() {
        let held_board = |name: &str, selector: Option<&str>, keyboard: Option<&str>| {
            let interface_id = keyboard.unwrap_or("USB\\VID_1111&PID_2222\\UNRESOLVED");
            ksx_api::BoardRow {
                name: name.to_owned(),
                interfaces: vec![ksx_api::UsbRow {
                    instance_id: interface_id.to_owned(),
                    transport: "usb".to_owned(),
                    state: "claimed".to_owned(),
                    selector: selector.map(str::to_owned),
                    winusb_eligible: true,
                    can_type: false,
                    ..ksx_api::UsbRow::default()
                }],
                keyboard: keyboard.map(str::to_owned),
                claimed: true,
                release_command: keyboard.map(|id| format!("ksx winusb release {id} --yes")),
                ..ksx_api::BoardRow::default()
            }
        };
        let no_selector = held_board(
            "Held without selector",
            None,
            Some("USB\\VID_1111&PID_2222\\NO_SELECTOR"),
        );
        let no_keyboard = held_board(
            "Held without keyboard identity",
            Some("usb:1111:2222:01"),
            None,
        );
        let exact = held_board(
            "Exact held keyboard",
            Some("usb:1111:2222:02"),
            Some("USB\\VID_1111&PID_2222\\EXACT"),
        );

        let unreadable_identity_scan = ksx_api::DeviceScanView::read(
            "fixture".to_owned(),
            true,
            true,
            true,
            vec![no_selector.clone(), no_keyboard.clone()],
            Vec::new(),
            Vec::new(),
        );
        let manual = RedesignCaptureState::of(
            &ksx_api::StagedSetupView {
                reachable: true,
                ..ksx_api::StagedSetupView::default()
            },
            Some(&unreadable_identity_scan),
            "",
        );
        assert_eq!(manual.mode, "held");
        assert_eq!(manual.heading, "Held input needs manual recovery");
        assert_eq!(manual.device_label, "Multiple held keyboards");
        assert_eq!(manual.held.len(), 2);
        assert!(manual.held.iter().all(|row| !row.can_release));
        assert!(manual
            .held
            .iter()
            .all(|row| row.note.contains("Device Manager") && row.note.contains("rescan")));

        let mixed_scan = ksx_api::DeviceScanView::read(
            "fixture".to_owned(),
            true,
            true,
            true,
            vec![no_selector, no_keyboard, exact],
            Vec::new(),
            Vec::new(),
        );
        let recovery = RedesignCaptureState::of(
            &ksx_api::StagedSetupView {
                reachable: true,
                ..ksx_api::StagedSetupView::default()
            },
            Some(&mixed_scan),
            "",
        );
        assert_eq!(recovery.held.len(), 3, "no claimed row may disappear");
        assert_eq!(
            recovery
                .held
                .iter()
                .filter(|row| row.can_release)
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Exact held keyboard"]
        );
        assert_eq!(recovery.mode, "release-held");
        assert_eq!(recovery.device_label, "Exact held keyboard");
        assert_eq!(
            serde_json::to_value(&recovery)
                .expect("capture state serializes")
                .pointer("/device_label"),
            Some(&serde_json::json!("Exact held keyboard"))
        );

        let staged_exact = ksx_api::StagedSetupView {
            reachable: true,
            device: Some(ksx_api::StagedDeviceView {
                label: "My cabinet encoder".to_owned(),
                selector: "usb:1111:2222:02".to_owned(),
                backend: "winusb".to_owned(),
                ..ksx_api::StagedDeviceView::default()
            }),
            ..ksx_api::StagedSetupView::default()
        };
        let selected_capture = RedesignCaptureState::of(&staged_exact, Some(&mixed_scan), "");
        assert_eq!(selected_capture.device_label, "My cabinet encoder");
    }

    #[test]
    fn redesign_recovery_keys_keep_identical_incomplete_claimed_boards_distinct() {
        let incomplete = ksx_api::BoardRow {
            name: "Identical held keyboard".to_owned(),
            interfaces: vec![ksx_api::UsbRow {
                instance_id: String::new(),
                description: "USB input device".to_owned(),
                transport: "usb".to_owned(),
                state: "claimed".to_owned(),
                winusb_eligible: true,
                can_type: false,
                ..ksx_api::UsbRow::default()
            }],
            keyboard: None,
            claimed: true,
            ..ksx_api::BoardRow::default()
        };
        let scan = ksx_api::DeviceScanView::read(
            "fixture".to_owned(),
            true,
            true,
            true,
            vec![incomplete.clone(), incomplete],
            Vec::new(),
            Vec::new(),
        );
        let staged = ksx_api::StagedSetupView {
            reachable: true,
            ..ksx_api::StagedSetupView::default()
        };

        let first = RedesignCaptureState::of(&staged, Some(&scan), "");
        let second = RedesignCaptureState::of(&staged, Some(&scan), "");
        let keys = first
            .held
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>();

        assert_eq!(keys.len(), 2);
        assert!(!keys[0].is_empty());
        assert_ne!(keys[0], keys[1]);
        assert_eq!(keys[1], format!("{}-2", keys[0]));
        assert_eq!(
            first
                .held
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            second
                .held
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            "the same machine inventory must reproduce the same row keys"
        );
        assert_eq!(
            serde_json::to_value(&first)
                .expect("capture state serializes")
                .pointer("/held/1/key"),
            Some(&serde_json::json!(keys[1]))
        );
    }

    #[test]
    fn redesign_empty_draft_routes_releasable_held_input_to_recovery() {
        let instance = "USB\\VID_1111&PID_2222\\HELD";
        let held = ksx_api::BoardRow {
            name: "Cabinet keyboard".to_owned(),
            interfaces: vec![ksx_api::UsbRow {
                instance_id: instance.to_owned(),
                description: "Cabinet keyboard".to_owned(),
                transport: "usb".to_owned(),
                state: "claimed".to_owned(),
                selector: Some("usb:1111:2222:00".to_owned()),
                winusb_eligible: true,
                can_type: false,
                ..ksx_api::UsbRow::default()
            }],
            keyboard: Some(instance.to_owned()),
            claimed: true,
            release_command: Some(format!("ksx winusb release {instance} --yes")),
            ..ksx_api::BoardRow::default()
        };
        let scan = ksx_api::DeviceScanView::read(
            "fixture".to_owned(),
            true,
            true,
            true,
            vec![held],
            Vec::new(),
            Vec::new(),
        );
        let staged = ksx_api::StagedSetupView {
            reachable: true,
            ..ksx_api::StagedSetupView::default()
        };
        let capture = RedesignCaptureState::of(&staged, Some(&scan), "");
        assert_eq!(capture.mode, "release-held");
        assert!(capture.can_release);

        let journey = RedesignJourney::of(
            &staged,
            &crate::control::SessionView {
                reachable: true,
                ..crate::control::SessionView::default()
            },
            &capture,
            &RedesignActionState {
                reason: "Release the held keyboard before Play.".to_owned(),
                ..RedesignActionState::default()
            },
        );

        assert_eq!(journey.compact, "0/4 complete · Release required");
        assert_eq!(journey.rows[0].title, "Release the held input");
        assert_eq!(journey.rows[0].action, "capture");
        assert_eq!(journey.rows[0].badge, "Action required");
        assert_eq!(journey.rows[0].cls, "rd-journey-step blocked");
        assert!(journey.rows[0].detail.contains("cannot type normally"));
        assert!(!journey.rows[0].detail.contains("Choose the keyboard"));
    }

    #[test]
    fn connection_labels_preserve_the_instance_that_separates_twin_boards() {
        assert_eq!(
            device_connection_label("usb:d209:0430:00"),
            "USB D209:0430 · connection 00"
        );
        assert_eq!(
            device_connection_label(r"HID\VID_D209&PID_0430\7&1A2B3C&0&0000"),
            "Connection 7&1A2B3C&0&0000 · 1ket05ls5b0gh"
        );
        assert_eq!(
            device_connection_label("  "),
            "Exact connection available after identification"
        );

        let slash = device_connection_label("opaque:panel/a");
        let colon = device_connection_label("opaque:panel:a");
        assert_eq!(slash, "Connection a · 1mcg2plvqib6i");
        assert_eq!(colon, "Connection a · 1mfabgg5dy7k3");
        assert_ne!(slash, colon);
    }

    /// The controller inspector needs two facts browsers previously guessed:
    /// which SOCD row is current, and what each canonical key prints on the
    /// selected board. Keep both on the wire while retaining the mapper value.
    #[test]
    fn controller_inspector_serves_current_socd_and_board_key_labels() {
        let mut setup = ksx_core::stage::StagedSetup::new();
        for edit in [
            ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".to_owned(),
                alias: "panel".to_owned(),
                label: "Ultimarc I-PAC 4".to_owned(),
            },
            ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "xbox360".to_owned(),
                preset: "Inspector P1".to_owned(),
                layout: Some("keyboard-2p".to_owned()),
            },
            ksx_api::StageEdit::SetSocd {
                number: 1,
                socd: "last-input".to_owned(),
            },
        ] {
            setup = edit
                .apply(&setup)
                .unwrap_or_else(|refusal| panic!("fixture edit refused: {}", refusal.message));
        }

        let staged = ksx_api::StagedSetupView::of(&setup);
        let selected = staged.slots.first().expect("one staged controller");
        let panel = compose_controller_panel(&staged, Some(selected), None);
        assert_eq!(panel.socd_current, "last-input");
        assert!(
            panel
                .socd_edit_opts
                .iter()
                .any(|option| option.value == panel.socd_current),
            "the explicit current value must resolve to the served roster"
        );
        let mut legacy = staged.clone();
        legacy.slots[0].socd.clear();
        assert_eq!(
            compose_controller_panel(&legacy, legacy.slots.first(), None).socd_current,
            "off",
            "an older omitted SOCD field means the engine's effective default"
        );

        let board = crate::board::Board::resolve("", &[], &[], false);
        let keys = compose_key_panel(&staged, Some(selected), &board);
        let row_for = |canonical: &str| {
            keys.key_rows
                .iter()
                .chain(keys.avail_main.iter())
                .chain(keys.avail_nav.iter())
                .chain(keys.avail_num.iter())
                .find(|row| row.key == canonical)
                .unwrap_or_else(|| panic!("standard board did not serve {canonical}"))
        };

        let up = row_for("Up");
        assert_eq!(up.key_label, "↑");
        assert_eq!(up.key, "Up", "display text must never replace identity");
        let control = row_for("LeftControl");
        assert_eq!(control.key_label, "Ctrl");
        assert_eq!(control.key, "LeftControl");
        let tilde = row_for("Tilde");
        assert_eq!(tilde.key_label, "`");
        assert_eq!(tilde.key, "Tilde");
    }

    /// **Every persona ksx ships has a presentation, and no two share a row.**
    ///
    /// ADDED 2026-08-26. This is the exhaustiveness the compiler cannot give
    /// us. `PAD_PRESENTATIONS` is keyed by STRING on purpose — `render_map.rs`
    /// links ksx-core only as a dev-dependency (`docs/M9-DECISION.md` §6) — so
    /// a `match` on `Persona` is not available and a new variant cannot make
    /// the build fail. It makes THIS fail instead.
    ///
    /// What it would have caught: `Persona::ALL` grew `snes` and `genesis` on
    /// 2026-08-20 and `PadBackend::supports` returned true for both, so both
    /// appeared in /nocturne's create-controller grid the same day. The string
    /// "snes" appeared in zero of the five surfaces that decide how a
    /// controller is drawn, and every one of the five answered anyway.
    #[test]
    fn every_persona_resolves_to_a_presentation() {
        use std::collections::BTreeSet;

        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for persona in ksx_core::Persona::ALL.iter().copied() {
            let name = persona.as_str();
            let row = pad_presentation(name);
            assert_eq!(
                row.persona, name,
                "persona '{name}' has no row in PAD_PRESENTATIONS — it \
                 resolved to '{}' (family '{}'). Add the row: art, zone table, \
                 legend, family and the controls the device does not have.",
                row.persona, row.family
            );
            assert!(seen.insert(row.persona), "two rows claim '{name}'");
        }
        assert_eq!(
            seen.len(),
            PAD_PRESENTATIONS.len(),
            "PAD_PRESENTATIONS holds a row for a persona ksx-core does not \
             ship: {:?}",
            PAD_PRESENTATIONS
                .iter()
                .map(|row| row.persona)
                .filter(|name| !seen.contains(name))
                .collect::<Vec<_>>()
        );

        // Every row also has to name a body the page can actually draw. The
        // five `.n-padwrap` masters are the whole set of drawn bodies; a row
        // naming a sixth would resolve to nothing on the no-JS page and to the
        // unknown-family placeholder in the browser.
        const DRAWN_BODIES: [&str; 5] = ["xbox", "ps", "ps5", "switchpro", "xboxseries"];
        for row in PAD_PRESENTATIONS {
            assert!(
                DRAWN_BODIES.contains(&row.family),
                "{}'s family '{}' is not one of the served masters {DRAWN_BODIES:?}",
                row.persona,
                row.family
            );
        }
    }

    /// **An unrecognised persona is a NAMED outcome, never a quiet Xbox pad.**
    ///
    /// The case is real: ksx Studio reads its roster over `ksx-api`, so a
    /// daemon newer than this binary can serve a persona added after it was
    /// built. The old code answered that with `slot.is_xinput` — false for any
    /// plain-HID pad — and drew a DualShock 4.
    #[test]
    fn an_unknown_persona_is_named_rather_than_guessed() {
        for made_up in ["gamecube", "n64", "", "xbox361", "playstation-6"] {
            let row = pad_presentation(made_up);
            assert_eq!(
                row.family, "unknown",
                "'{made_up}' resolved to the '{}' body — an unrecognised \
                 controller must not be drawn as a controller we know",
                row.family
            );
            assert!(
                row.absent.is_empty(),
                "'{made_up}' claims {:?} are missing from a device this build \
                 does not recognise; not knowing a pad is not the same as \
                 knowing what it lacks",
                row.absent
            );
        }
        // ...and the empty roster is a DIFFERENT case with its own answer: no
        // seat to draw, so the neutral outline stays as ground.
        assert_eq!(pad_art_family(None), "xbox");
        // The one that matters most, because it is the exact shape of the bug:
        // a plain-HID persona this build DOES know must keep its own body and
        // must never be inferred from `is_xinput`.
        assert_eq!(pad_art_family(Some("dualsense")), "ps5");
        assert_eq!(pad_art_family(Some("snes")), "xbox");
        assert_eq!(pad_art_family(Some("genesis")), "xbox");
    }

    /// **The alias column can never come to mean something ksx-core disagrees
    /// with.**
    ///
    /// `pad_presentation` accepts spellings other than the canonical name
    /// because the substring matchers it replaced did (`art_for` answered DS4
    /// for anything containing `ds4`/`ps4`/`ps5`/`dualshock`). Tolerance is
    /// fine; tolerance that DISAGREES with the parser is a page drawing one
    /// controller for a config that loads as another. So every alias is fed to
    /// the real `Persona::from_str`.
    #[test]
    fn presentation_aliases_match_ksx_core() {
        for row in PAD_PRESENTATIONS {
            let canonical: ksx_core::Persona = row
                .persona
                .parse()
                .unwrap_or_else(|e| panic!("{}: {e}", row.persona));
            for alias in row.aliases {
                let parsed: ksx_core::Persona = alias
                    .parse()
                    .unwrap_or_else(|e| panic!("{}: alias '{alias}': {e}", row.persona));
                assert_eq!(
                    parsed, canonical,
                    "'{alias}' is presented as {} but ksx-core parses it as \
                     {parsed} — the page would draw one controller for a \
                     config that loads as another",
                    row.persona
                );
            }
            // Separator and case tolerance is the parser's, so it must be
            // this table's too: `Xbox 360` and `xbox-series-xs-bt` are both
            // spellings a human or a catalog slug produces.
            assert_eq!(
                pad_presentation(&row.persona.to_uppercase()).persona,
                row.persona
            );
        }
        assert_eq!(pad_presentation("Xbox 360").persona, "xbox360");
        assert_eq!(pad_presentation("xbox-series-xs-bt").persona, "xboxseries");
        assert_eq!(pad_presentation("Sega Mega Drive").persona, "genesis");
    }

    /// **The surfaces that hold a LABEL rather than an id still find the right
    /// pad.**
    ///
    /// Nearly every caller passes a canonical persona name, and it would be
    /// easy to believe all of them do. `/pads` does not: it lists what is
    /// actually on the ViGEm bus, classified from hardware ids, and serves
    /// `ksx_platform::PersonaGuess::label()` — human strings with a noun on the
    /// end. `render_pads.rs` hands one of those straight to `art_for`.
    ///
    /// The substring matcher this table replaced accepted them by accident.
    /// Exact matching alone would have drawn every live DualShock 4 on that
    /// page as an Xbox pad — a fresh instance of the bug being fixed,
    /// introduced by the fix. Hence stage 2 of `pad_presentation`, and hence
    /// these strings written out literally.
    ///
    /// They are copied rather than imported because ksx-studio does not link
    /// ksx-platform, even in tests. If `PersonaGuess::label()` is reworded,
    /// this test keeps passing and the page quietly loses its art — so the
    /// wording is named here as the thing to re-check.
    #[test]
    fn a_human_label_still_finds_its_pad() {
        // ksx_platform::PersonaGuess::label(), verbatim (2026-08-26).
        assert_eq!(pad_presentation("Xbox 360 pad").persona, "xbox360");
        assert_eq!(
            pad_presentation("PlayStation (DS4) pad").persona,
            "playstation"
        );
        assert_eq!(
            crate::render::art_for("PlayStation (DS4) pad"),
            crate::render::ART_DS4
        );
        // ...and the third guess is genuinely unknown, so it must stay that
        // way rather than matching something by luck.
        assert_eq!(pad_presentation("unknown pad").family, "unknown");

        // ksx_core::Persona::label() for every persona, which is what any
        // surface holding a display name would pass.
        for persona in ksx_core::Persona::ALL.iter().copied() {
            assert_eq!(
                pad_presentation(persona.label()).persona,
                persona.as_str(),
                "the label {:?} must find {}'s own row",
                persona.label(),
                persona
            );
        }

        // ⚠️ The reason the second pass strips rather than searches. A future
        // persona whose name EXTENDS an existing one must not inherit its
        // body: `contains` resolves every one of these to an older pad and
        // draws it, silently, which is the entire bug this record removes.
        for extension in [
            "playstation6",
            "playstation-6",
            "xbox360x",
            "snes2",
            "dualsense2",
            "genesis32x",
        ] {
            assert_eq!(
                pad_presentation(extension).family,
                "unknown",
                "'{extension}' extends a name we know and must NOT inherit its \
                 art — that is how a new console gets drawn as an old one"
            );
        }
        // ...and a string naming two controllers is not an answer either.
        assert_eq!(pad_presentation("xbox360 or playstation").family, "unknown");
    }

    /// **The five surfaces answer with ONE voice.**
    ///
    /// The bug this closes was not any single wrong answer — it was two
    /// surfaces on the same page disagreeing about the same seat: a staged
    /// SNES pad drawn as a DualShock 4 in the pad grid (`pad_art_family` fell
    /// through `is_xinput` to `"ps"`) and as an Xbox pad in the mapper
    /// (`art_for` fell through to `ART_XBOX`, and `zones_for` read `art_for`).
    ///
    /// So this checks agreement, not values: the family a seat is drawn with
    /// must belong to the same row as the art it is served and the zone table
    /// it is authored against.
    #[test]
    fn art_family_and_zones_come_from_one_row() {
        for persona in ksx_core::Persona::ALL.iter().copied() {
            let name = persona.as_str();
            let row = pad_presentation(name);
            assert_eq!(pad_art_family(Some(name)), row.family, "{name}");
            assert_eq!(crate::render::art_for(name), row.art, "{name}");
            assert!(
                std::ptr::eq(crate::render_map::zones_for(name), row.zones),
                "{name}: zones_for returned a different table than its row names"
            );
            // A PlayStation-family body is served the PlayStation art and a
            // PlayStation vocabulary; anything else is the two disagreeing.
            let sony_body = matches!(row.family, "ps" | "ps5");
            assert_eq!(
                row.art == crate::render::ART_DS4,
                sony_body,
                "{name} is drawn as '{}' but served {} — the art and the body \
                 must be the same decision",
                row.family,
                row.art
            );
        }
    }

    /// **The retro pads offer no control their hardware does not have.**
    ///
    /// Stated as literals rather than derived from `absent`, because a test
    /// that recomputed the production list would agree with any list. These
    /// are the four things a player would notice: no analog trigger to pull,
    /// no stick to push, no stick to click, no home button — and, positively,
    /// a D-pad and four faces that DO exist and must stay bindable.
    #[test]
    fn a_snes_pad_offers_no_stick_and_no_trigger() {
        for persona in ["snes", "genesis"] {
            let drawn: Vec<&str> = crate::render_map::zones_for(persona)
                .iter()
                .map(|zone| zone.fn_name)
                .collect();
            for gone in [
                "lt", "rt", "lthumb", "rthumb", "guide", "lx.min", "lx.max", "ly.min", "ly.max",
                "rx.min", "rx.max", "ry.min", "ry.max",
            ] {
                assert!(
                    !drawn.contains(&gone),
                    "{persona} offers '{gone}', which the pinned descriptor \
                     cannot express — a key bound there drives nothing"
                );
            }
            for kept in [
                "A",
                "B",
                "X",
                "Y",
                "lb",
                "rb",
                "start",
                "dpad.up",
                "dpad.down",
                "dpad.left",
                "dpad.right",
            ] {
                assert!(drawn.contains(&kept), "{persona} lost '{kept}'");
            }
        }
        // The SNES pad prints its own words, anchored on the one mapping this
        // build measured (`Persona::Snes`: "positional faces (ksx A = bottom =
        // SNES B)"). Read through `legend_label_for_persona`, which is what
        // every surface calls.
        let label = |persona: &str, function: &str| -> String {
            let zone = crate::render_map::zones_for(persona)
                .iter()
                .find(|zone| zone.fn_name == function)
                .unwrap_or_else(|| panic!("{persona} has no {function}"));
            crate::render_map::legend_label_for_persona(persona, zone)
        };
        assert_eq!(label("snes", "A"), "B");
        assert_eq!(label("snes", "B"), "A");
        assert_eq!(label("snes", "X"), "Y");
        assert_eq!(label("snes", "Y"), "X");
        assert_eq!(label("snes", "back"), "Select");
        // Genesis deliberately prints NO Sega letters: one wire identity serves
        // Genesis, Mega Drive and Saturn, and the button-label table is
        // recorded as PROVISIONAL until the joy.cpl press-check
        // (docs/HIDMAESTRO-STATE.md, 2026-08-20). It prints ksx's own function
        // names, which claim nothing about anybody's shell. Change these four
        // in the commit that lands the press-check, not before.
        assert_eq!(label("genesis", "A"), "A");
        assert_eq!(label("genesis", "B"), "B");
        assert_eq!(label("genesis", "X"), "X");
        assert_eq!(label("genesis", "Y"), "Y");
        // …and the two retro personas must NOT have quietly become the same
        // pad: identical geometry is intended, identical WORDS would mean one
        // of the two vocabularies was never stated.
        assert_ne!(label("snes", "A"), label("genesis", "A"));
    }

    /// **Narrowing a pad's controls must not silently swallow the bindings a
    /// preset already holds for them.**
    ///
    /// The other half of the retro decision, and the half that is easy to get
    /// wrong while feeling correct. `ksx_core::persona`'s module doc makes it a
    /// rule that "re-persona-ing a slot must never require editing its preset",
    /// so a seat moved from Xbox 360 to SNES keeps its `lx.max` binding in the
    /// TOML — pointing at a stick that pad does not have.
    ///
    /// The binding pane is built from `zones_for`, so narrowing the SNES table
    /// removes that row by construction: the key stays bound, quietly does
    /// nothing, and the page cannot even offer a Clear. That is the same
    /// silent-fallback class the narrowing exists to remove, so the row is
    /// appended with the sentence that explains it.
    #[test]
    fn a_binding_the_new_pad_cannot_express_is_shown_not_swallowed() {
        let staged_slot = |persona: &str, label: &str| ksx_api::StagedSlotView {
            number: 1,
            persona: persona.to_owned(),
            persona_label: label.to_owned(),
            preset: "Player 1".to_owned(),
            authoring: Some(ksx_config::PresetFile {
                name: "Player 1".to_owned(),
                bindings: [
                    (
                        "A".to_owned(),
                        ksx_config::BindingEntry::Key("G".to_owned()),
                    ),
                    // The control a SNES pad does not have.
                    (
                        "lx.max".to_owned(),
                        ksx_config::BindingEntry::Key("K".to_owned()),
                    ),
                ]
                .into_iter()
                .collect(),
                macros: Default::default(),
            }),
            ..Default::default()
        };
        let rows_for = |persona: &str, label: &str| -> Vec<WorkspaceBindRow> {
            let slot = staged_slot(persona, label);
            let staged = ksx_api::StagedSetupView {
                reachable: true,
                slots: vec![slot.clone()],
                ..Default::default()
            };
            workspace_bind_rows(&staged, Some(&slot)).rows
        };

        // An Xbox seat HAS a left stick, so the row is an ordinary one and
        // carries no apology.
        let xbox = rows_for("xbox360", "Xbox 360");
        let xbox_row = xbox
            .iter()
            .find(|row| row.function == "lx.max")
            .expect("an Xbox pad has a left stick");
        assert_eq!(xbox_row.keys, "K");
        assert!(xbox_row.share_note.is_empty(), "{:?}", xbox_row.share_note);
        assert_eq!(xbox_row.label, "LS →", "the persona names its own control");

        // The same preset on a SNES seat: still listed, still clearable, and
        // now saying why it does nothing.
        let snes = rows_for("snes", "SNES");
        let stranded = snes
            .iter()
            .find(|row| row.function == "lx.max")
            .expect("the binding is still in the preset and must still be shown");
        assert_eq!(stranded.keys, "K");
        assert_eq!(stranded.clear, "Clear", "it must be undoable from here");
        assert!(
            stranded.share_note.contains("SNES") && stranded.share_note.contains("drives nothing"),
            "the row must say what happened: {:?}",
            stranded.share_note
        );
        // ...and the pad still offers no NEW stick control to bind.
        assert!(
            !snes.iter().any(|row| row.function == "lx.min"),
            "an unbound stick direction must not be offered on a pad with no stick"
        );
        assert!(
            snes.iter().any(|row| row.function == "A"),
            "the controls the pad DOES have are untouched"
        );
    }

    /// **One shape claim about retro hardware, not two copies of it.**
    ///
    /// `ZONE_SNES` and `ZONE_GENESIS` deliberately hold the same twelve
    /// controls at the same coordinates — they draw the same stand-in body and
    /// they make the same claim about what a digital retro pad has. Only the
    /// printed words differ. Without this, editing one table's geometry leaves
    /// the other's silently behind, and the shared claim quietly becomes two
    /// different ones.
    #[test]
    fn retro_tables_share_one_geometry() {
        let snes = crate::render_map::ZONE_SNES;
        let genesis = crate::render_map::ZONE_GENESIS;
        assert_eq!(snes.len(), genesis.len(), "retro tables differ in length");
        for (a, b) in snes.iter().zip(genesis.iter()) {
            assert_eq!(a.fn_name, b.fn_name, "retro tables list different controls");
            assert_eq!(
                (a.cx, a.cy, a.w, a.h, a.kind),
                (b.cx, b.cy, b.w, b.h, b.kind),
                "the {} zone has drifted between the two retro tables",
                a.fn_name
            );
        }
    }

    // DELETED 2026-08-26: `the_saved_split_or_freeze_answer_is_the_marked_one`
    // (STALE + DUPLICATE). It asserted `SetupRows::of(..).blocking` ->
    // `SetupBlockingRowView` / `pill pill-ok`, the DELETED `/setup` page's
    // composer. `/nocturne` derives its blocking rows from an INDEPENDENT
    // implementation in this file (`NocturneChoiceRow`, `n-radio on`), so this
    // test defended the dead twin and could not have caught a live break.
    // Every claim it made is pinned on the live path in `tests/http.rs`:
    // unanswered -> no row is `n-radio on`; answered -> exactly one is; and a
    // value this build does not know is refused at the verb rather than being
    // smoothed over into one of the three it does know.

    /// **The four-player panel, layout menu untouched** - `FIRST-RUN.md` §1
    /// moment 5, pressed four times.
    ///
    /// A template's player block is chosen by SLOT NUMBER (`ksx_api`'s
    /// `instantiate`, `player = number`), so "Add this controller" with the
    /// `<select>` left alone sends whatever `layout_options` put first. Every
    /// in-box layout except `arcade-4way` carries at most two blocks, so
    /// before the sort knew the next slot number the THIRD press was refused
    /// outright with `TemplateError::NoSuchPlayer` - the wall a four-player
    /// cabinet walks into, reported as "Reopen ksx and try again".
    ///
    /// Driven through the real `StageEdit::apply` rather than asserting an
    /// order, and deliberately never naming `arcade-4way`: an assertion on
    /// that id would keep passing if the sort broke and that template merely
    /// happened to stay first.
    #[test]
    fn adding_four_controllers_without_touching_the_layout_menu_is_accepted() {
        let mut setup = ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".to_owned(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
        }
        .apply(&ksx_core::stage::StagedSetup::new())
        .expect("staging the panel");

        for expected in 1..=4u8 {
            let view = ksx_api::StagedSetupView::of(&setup);
            assert_eq!(view.next_slot, Some(expected), "slot order");

            // Exactly what the untouched form posts: the option the menu puts
            // first, and the served preset name. The ordering is inlined from
            // the served view rather than taken from a page helper - layouts
            // that fit the next slot lead, then the default.
            let first = {
                let next = view.next_slot;
                let mut rows: Vec<&ksx_api::TemplateRow> = view.layouts.iter().collect();
                rows.sort_by_key(|layout| {
                    (
                        !next.is_none_or(|number| layout.players.contains(&number)),
                        layout.id != view.default_layout,
                    )
                });
                rows.first().expect("a layout to offer").id.clone()
            };
            let persona = view
                .personas
                .iter()
                .find(|p| p.can_plug)
                .expect("a persona this build can plug")
                .name
                .clone();

            setup = ksx_api::StageEdit::AddSlot {
                number: None,
                persona,
                preset: view.next_preset.clone().expect("a served preset name"),
                layout: Some(first.clone()),
            }
            .apply(&setup)
            .unwrap_or_else(|refusal| {
                panic!(
                    "player {expected} refused the layout the menu offered first \
                     ({first}): {}",
                    refusal.message
                )
            });
        }

        assert_eq!(ksx_api::StagedSetupView::of(&setup).slots.len(), 4);
    }

    /// The ROW sentences are composed here and nowhere else. This pins the
    /// exact strings both seams (render_setup.rs's SSR injection and
    /// SetupIsland.ts's poll) now read verbatim — the formatters they used to
    /// each own are gone, so this is the only place a row wording can change.
    /// The theme card's three states, pinned (TK2/TK3 review finding: the
    /// first cut marked System "in use" on a config nothing had READ, and
    /// claimed "this is how it is set" about a config that said otherwise).
    ///
    /// **And the vocabulary itself is pinned, because it was wrong for months
    /// while this test stayed green.** `chosen_cls` is the class of the row's
    /// own submit button, and it carried `pill pill-ok` / `pill pill-none`
    /// inherited from the deleted `/setup` page, where the same string painted
    /// a separate chip. `.pill-none { display: none }` therefore hid every
    /// unchosen theme on `/nocturne`. This test asserted the marking was
    /// CORRECT without asserting it was RENDERABLE — so it agreed, in detail,
    /// with a picker that showed one row. Both halves are now claims.
    #[test]
    fn the_theme_rows_and_line_say_only_what_the_read_supports() {
        let marked = |rows: &[SetupThemeRowView]| {
            rows.iter()
                .filter(|r| r.chosen_cls == "n-radio on")
                .map(|r| r.value.clone())
                .collect::<Vec<_>>()
        };
        // Every row must be a paintable control in EVERY state, marked or not.
        // `.n-modeform button.n-radio { display: flex }` is what gives these
        // buttons their layout, and it matches `.n-radio` only.
        let renderable = |rows: &[SetupThemeRowView]| {
            for r in rows {
                assert!(
                    r.chosen_cls == "n-radio" || r.chosen_cls == "n-radio on",
                    "theme row '{}' has chosen_cls '{}' — it is the submit button's own \
                     class, so anything but the n-radio idiom is either unstyled or (as \
                     with pill-none) display:none",
                    r.value,
                    r.chosen_cls,
                );
            }
        };

        // Nothing stored: System is genuinely how it is set.
        let snap = SetupSnapshot::ready(ksx_api::SetupView::default());
        let rows = theme_rows(&snap);
        assert_eq!(marked(&rows), ["system"]);
        assert_eq!(rows[0].button, "This is how it is set");
        renderable(&rows);

        // Every row describes itself in its own words. `scheme` cannot supply
        // this sentence: Dark and Matrix are both `scheme: "dark"`, and while
        // three rows were invisible nobody could see them say the same thing.
        let details: std::collections::BTreeSet<&str> =
            rows.iter().map(|r| r.detail.as_str()).collect();
        assert_eq!(
            details.len(),
            rows.len(),
            "two theme rows share a detail sentence — a picker cannot offer a choice it \
             refuses to describe: {:?}",
            rows.iter()
                .map(|r| (r.value.as_str(), r.detail.as_str()))
                .collect::<Vec<_>>(),
        );
        for r in &rows {
            assert!(
                !r.detail.trim().is_empty(),
                "theme row '{}' has no detail sentence",
                r.value,
            );
        }

        // A shipped id: that row is marked; System offers its action.
        let snap = SetupSnapshot::ready(ksx_api::SetupView {
            theme: "light".to_owned(),
            ..Default::default()
        });
        let rows = theme_rows(&snap);
        assert_eq!(marked(&rows), ["light"]);
        assert_eq!(rows[0].button, "Match the operating system");
        assert!(rows
            .iter()
            .any(|r| r.value == "light" && r.button == "This is how it is set"));
        renderable(&rows);

        // An id this build does not ship: System IS what renders (the pill is
        // true) but NOT what is set — the button offers the useful act.
        let snap = SetupSnapshot::ready(ksx_api::SetupView {
            theme: "matrix2".to_owned(),
            ..Default::default()
        });
        let rows = theme_rows(&snap);
        assert_eq!(marked(&rows), ["system"]);
        assert_eq!(rows[0].button, "Follow the operating system instead");
        renderable(&rows);

        // A config nothing could read: no row claims anything about it.
        let snap = SetupSnapshot::unavailable("the store refused");
        let rows = theme_rows(&snap);
        assert_eq!(marked(&rows), Vec::<String>::new());
        assert!(rows.iter().all(|r| r.button != "This is how it is set"));
        // Even with nothing marked, all four stay clickable and painted —
        // this is the state where the picker is the ONLY way out.
        renderable(&rows);
    }

    // DELETED 2026-08-26: `the_setup_rows_are_composed_once_from_the_view`
    // (STALE). It exercised `SetupRows::of`, the DELETED `/setup` page's row
    // composer, which has no production call site — only `lib.rs`'s `pub use`
    // keeps it from tripping `dead_code`. None of `steps`/`devices`/`slots`/
    // `preset_options`/`profile_options`/`notes` render on any surface.
    // What replaced each half, so nothing was silently dropped:
    //  - the persona roster -> `/nocturne` serves `view.persona_rows`, pinned
    //    live in `tests/http.rs` (the `nd-card sel` / `nd-card off` marking).
    //  - the slot ceiling, and the defect it recorded (the shipped page held
    //    `SLOT_CHOICES = 8` in two languages while `ksx_core::MAX_SLOTS` was
    //    16) -> pinned at the source by `ksx-api`'s
    //    `the_slot_ceiling_a_surface_renders_is_this_builds_max_slots`
    //    (machine.rs) and `the_slot_assign_refusals_quote_max_slots_not_a_literal`
    //    (wire.rs). Studio no longer renders a slot menu at all.
}
