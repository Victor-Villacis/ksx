//! `/map` — the mapper: bindings, chords, turbo and macros, saved or staged.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

/// One fresh mapper payload. Blocking work (config store reads + up to two
/// pipe requests) off the async workers, like [`collect`].
pub(super) async fn collect_map(
    state: &Arc<AppState>,
    selected: Option<u8>,
    macro_selected: Option<String>,
    target: &'static str,
) -> MapPayload {
    let map_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let session = map_state.control.session();
        let learn = map_state.control.learn_poll();
        let staged = (target == "stage").then(|| map_state.control.staged());
        let mapper = staged.as_ref().map_or_else(
            || map_state.source.mapper(),
            ksx_api::staged_mapper_snapshot,
        );
        if target == "stage"
            && selected.is_some_and(|number| !mapper.slots.iter().any(|slot| slot.number == number))
        {
            let number = selected.unwrap_or(0);
            let reason = format!(
                "staged controller {number} no longer exists — return to Setup and choose a controller"
            );
            return MapPayload {
                target: target.to_owned(),
                mapper: crate::snapshot::MapperSnapshot::unavailable(&reason),
                session,
                learn,
                selected: number,
                macros: crate::snapshot::MacroSnapshot::unavailable(&reason),
                macro_selected: macro_selected.unwrap_or_default(),
                shelf: Default::default(),
            };
        }
        let selected = selected
            .filter(|n| mapper.slots.iter().any(|s| s.number == *n))
            .or_else(|| mapper.slots.first().map(|s| s.number))
            .unwrap_or(0);
        // v11: the macro editor reads ONE preset — the selected slot's, since
        // that is the pad whose controls are the grid's columns.
        let macros = if let Some(staged) = staged.as_ref() {
            staged
                .slots
                .iter()
                .find(|slot| slot.number == selected)
                .map_or_else(
                    || {
                        crate::snapshot::MacroSnapshot::unavailable(
                            "no staged controller is selected, so there are no controls to edit",
                        )
                    },
                    ksx_api::staged_macro_snapshot,
                )
        } else {
            match mapper.slots.iter().find(|s| s.number == selected) {
                Some(slot) => map_state.source.macros(&slot.preset),
                None => crate::snapshot::MacroSnapshot::unavailable(
                    "no slot is selected, so there is no preset to read macros from",
                ),
            }
        };
        MapPayload {
            target: target.to_owned(),
            mapper,
            session,
            learn,
            selected,
            macros,
            macro_selected: macro_selected.unwrap_or_default(),
            shelf: Default::default(),
        }
    })
    .await
    .map(|mut payload| {
        // The shelf is composed from whatever mapper this collect produced —
        // saved, staged, or the unavailable sentinel (whose empty slot list
        // yields an empty shelf). One composition site, so the page render and
        // `/api/map` cannot disagree.
        payload.shelf = crate::render_map::shelf_views(&payload.mapper);
        payload
    })
    .unwrap_or_else(|_| MapPayload {
        target: target.to_owned(),
        mapper: crate::snapshot::MapperSnapshot::unavailable("mapper collection panicked"),
        session: SessionView::unreachable("mapper collection panicked"),
        learn: crate::control::LearnView::unavailable("mapper collection panicked"),
        selected: 0,
        macros: crate::snapshot::MacroSnapshot::unavailable("mapper collection panicked"),
        macro_selected: String::new(),
        shelf: Default::default(),
    })
}

#[derive(Deserialize)]
pub(super) struct MapQuery {
    slot: Option<u8>,
    /// `stage` aims the existing mapper at first-run's in-memory setup. Every
    /// other spelling is deliberately the saved mapper; URLs cannot invent a
    /// third write destination.
    target: Option<String>,
    /// v11: which `[macros.<name>]` table the macro editor paints. The tabs
    /// are anchors, so this is how a page with no JavaScript walks a preset's
    /// macros — exactly like `slot=` walks its slots.
    #[serde(rename = "macro")]
    macro_name: Option<String>,
    /// v9: the outcome of the no-JS form POST that redirected here. Same
    /// post-redirect-get channel `/` has always used for its session forms.
    flash: Option<String>,
}

pub(super) fn map_target(value: Option<&str>) -> &'static str {
    if value == Some("stage") {
        "stage"
    } else {
        "saved"
    }
}

pub(super) async fn map_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MapQuery>,
) -> Response {
    let target = map_target(query.target.as_deref());
    let payload = collect_map(&state, query.slot, query.macro_name.clone(), target).await;
    let flash = query
        .flash
        .as_deref()
        .filter(|f| !f.trim().is_empty())
        .map(|flash| {
            consumer_map_detail(
                flash,
                if flash.starts_with("error") {
                    "error: That change could not be completed. Nothing changed."
                } else {
                    "The change was completed."
                },
            )
        });
    let out = render_map(&state.map_page, &payload, flash.as_deref());
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_str(&out.csp)
                    .unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'")),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        out.html,
    )
        .into_response()
}

/// The mapper poller's endpoint — the same [`MapPayload`] shape the /map page
/// embeds as island props (parity unit-tested in render_map.rs).
pub(super) async fn api_map(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MapQuery>,
) -> Response {
    let target = map_target(query.target.as_deref());
    let payload = collect_map(&state, query.slot, query.macro_name.clone(), target).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

pub(super) async fn api_learn_poll(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| control.learn_poll()).await
}

pub(super) async fn api_learn_start(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| control.learn_start()).await
}

#[derive(Deserialize)]
pub(super) struct LearnCancelBody {
    generation: u64,
}

pub(super) async fn api_learn_cancel(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<LearnCancelBody>,
) -> Response {
    control_json(state, move |control| {
        control.learn_cancel_generation(Some(body.generation))
    })
    .await
}

pub(super) struct TargetBind<'a> {
    target: Option<&'a str>,
    slot: Option<u8>,
    preset: &'a str,
    function: &'a str,
    keys: &'a [String],
    force: bool,
    reload: bool,
    turbo_hz: Option<u32>,
}

/// Presentation boundary for Controls. Backend diagnostics remain available
/// to logs and typed codes; the primary workflow never reflects command lines,
/// storage addresses, or internal nouns into a flash/toast.
pub(super) fn consumer_map_detail(raw: &str, fallback: &str) -> String {
    // Provider text is diagnostic input, not customer copy. The Map surface
    // gets structured conflicts/chords through their typed fields and uses an
    // action-specific authored fallback for every scalar outcome. An
    // allow-by-absence blacklist would inevitably leak a novel HID address,
    // registry key, parser detail or storage path.
    let _ = raw;
    fallback.to_owned()
}

pub(super) fn consumerize_bind(mut outcome: BindOutcome) -> BindOutcome {
    if !outcome.ok {
        outcome.error = Some(consumer_map_detail(
            outcome.error.as_deref().unwrap_or(""),
            "That control could not be changed. Nothing changed.",
        ));
    }
    outcome
}

pub(super) fn consumerize_macro(
    mut outcome: crate::control::MacroOutcome,
) -> crate::control::MacroOutcome {
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

pub(super) fn bind_for_target(control: &dyn ControlSource, bind: TargetBind<'_>) -> BindOutcome {
    if map_target(bind.target) != "stage" {
        return control.bind_keys(
            bind.preset,
            bind.function,
            bind.keys,
            bind.force,
            bind.reload,
            bind.turbo_hz,
        );
    }

    let Some(number) = bind.slot else {
        return BindOutcome {
            ok: false,
            error: Some("a staged binding write needs an exact controller slot".to_owned()),
            code: Some(ksx_api::codes::BAD_SLOT.to_owned()),
            ..BindOutcome::default()
        };
    };
    control.stage_bind(&ksx_api::StagedBindRequest {
        number,
        preset: bind.preset.to_owned(),
        function: bind.function.to_owned(),
        keys: bind.keys.to_vec(),
        force: bind.force,
        turbo_hz: bind.turbo_hz,
        // The Studio bind form has no toggle control yet; absent means
        // "leave any latch as it is", never "clear it".
        toggle: None,
    })
}

pub(super) fn macro_for_target(
    control: &dyn ControlSource,
    target: Option<&str>,
    slot: Option<u8>,
    write: &crate::control::MacroWrite,
) -> crate::control::MacroOutcome {
    if map_target(target) != "stage" {
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
pub(super) struct TargetedBindRequest {
    #[serde(flatten)]
    request: BindRequest,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    slot: Option<u8>,
}

pub(super) async fn api_bind(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<TargetedBindRequest>,
) -> Response {
    control_json(state, move |control| {
        let keys = request.request.key.iter().cloned().collect::<Vec<_>>();
        consumerize_bind(bind_for_target(
            control,
            TargetBind {
                target: request.target.as_deref(),
                slot: request.slot,
                preset: &request.request.preset,
                function: &request.request.function,
                keys: &keys,
                force: request.request.force,
                reload: request.request.reload,
                turbo_hz: None,
            },
        ))
    })
    .await
}

/// POST /api/bind/keys — the JSON twin of `/map/add` + `/map/key/remove`.
/// The caller sends the FULL key list it wants the control to hold; what the
/// island computed and what a form computed therefore go through the same
/// [`ControlSource::bind_keys`], which is the one place that knows what the
/// daemon can express.
#[derive(Deserialize)]
pub(super) struct BindKeysRequest {
    preset: String,
    function: String,
    /// Empty = clear the control. There is no null-vs-empty distinction here:
    /// "hold no keys" and "be unbound" are the same state.
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    reload: bool,
    /// AUTO-FIRE (docs/INPUT-TRANSFORMS.md §3). Absent leaves the control's
    /// existing rate alone — "Add another key" must not switch an auto-fire
    /// off — `0` clears it, `n` sets it.
    #[serde(default)]
    turbo_hz: Option<u32>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    slot: Option<u8>,
}

pub(super) async fn api_bind_keys(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<BindKeysRequest>,
) -> Response {
    control_json(state, move |control| {
        consumerize_bind(bind_for_target(
            control,
            TargetBind {
                target: request.target.as_deref(),
                slot: request.slot,
                preset: &request.preset,
                function: &request.function,
                keys: &request.keys,
                force: request.force,
                reload: request.reload,
                turbo_hz: request.turbo_hz,
            },
        ))
    })
    .await
}

/// POST /api/macro/save — write (or delete) one whole `[macros.<name>]` table.
///
/// `reload` is forced on, exactly like the restore route: the daemon only
/// applies to a session that is actually RUNNING, and a macro body is a
/// binding change — it changes no slot, persona or device, so the session
/// hot-swaps it with the pads left plugged instead of bouncing them.
///
/// Feedback parity with every other write on this page: `message` is the
/// toast, `problems` are the refusal's rows, `warnings` are the advisories a
/// successful save still has to say out loud (a step below the sampling
/// floor), and `backup` names the restore point this edit left — which the
/// mapper's existing "Restore backup from …" (`latest-backup`) undoes.
pub(super) async fn api_macro_save(
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
pub(super) struct TargetedMacroWrite {
    #[serde(flatten)]
    write: crate::control::MacroWrite,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    slot: Option<u8>,
}

#[derive(Deserialize)]
pub(super) struct RestoreRequest {
    preset: String,
    #[serde(default)]
    target: Option<String>,
    /// Parsed as a typed [`crate::control::RestoreMode`] here so a typo is a
    /// 200-with-error the page can flash, not a daemon round-trip.
    mode: String,
}

/// POST /api/preset/restore — the mapper's three restore destinations, one
/// pipe `map-restore` per call (reload always requested: the daemon only
/// applies to a RUNNING session). Answers `{ok, message}` / `{ok:false,
/// error}`; the daemon's message already names what was written and what was
/// backed up first.
pub(super) async fn api_preset_restore(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<RestoreRequest>,
) -> Response {
    if map_target(request.target.as_deref()) == "stage" {
        return (
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "This unsaved setup has no recovery copy yet. Save it first, or keep editing it in memory."
            })),
        )
            .into_response();
    }
    let Some(mode) = crate::control::RestoreMode::parse(&request.mode) else {
        return (
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "Choose one of the recovery options shown on the page.",
            })),
        )
            .into_response();
    };
    control_json(state, move |control| {
        match control.restore(&request.preset, mode) {
            Ok(message) => serde_json::json!({
                "ok": true,
                "message": consumer_map_detail(&message, "Your controller layout was restored.")
            }),
            Err(refusal) => serde_json::json!({
                "ok": false,
                "error": consumer_map_detail(
                    &refusal.message,
                    "That recovery copy could not be applied. Nothing changed."
                )
            }),
        }
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PresetRequest {
    preset: String,
    #[serde(default)]
    target: Option<String>,
}

/// POST /api/preset/clear-all — unbind every function of one preset. One pipe
/// `map-clear-all`; the daemon takes a timestamped backup first, so the page's
/// confirm can promise a road home and mean it.
pub(super) async fn api_preset_clear_all(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<PresetRequest>,
) -> Response {
    if map_target(request.target.as_deref()) == "stage" {
        return (
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "Clear all is available after this setup is saved."
            })),
        )
            .into_response();
    }
    control_json(state, move |control| {
        match control.clear_all(&request.preset) {
            Ok(message) => serde_json::json!({
                "ok": true,
                "message": consumer_map_detail(
                    &message,
                    "All controls were cleared. Use Undo this session to recover them."
                )
            }),
            Err(refusal) => serde_json::json!({
                "ok": false,
                "error": consumer_map_detail(
                    &refusal.message,
                    "The controller layout could not be cleared. Nothing changed."
                )
            }),
        }
    })
    .await
}

// ── v9: the no-JavaScript mapper forms ─────────────────────────────────────
// Everything below is the SAME ControlSource verb the /api/* route above it
// calls — no new daemon surface, no second writer. What differs is only the
// wire shape a browser without scripting can produce: an
// `application/x-www-form-urlencoded` body in, a 303 to
// `/map?slot=N&flash=…` out. The flash is the page's whole feedback channel
// when there is no toast stack to write to.
//
// A form body names a SLOT NUMBER, never a preset: the server resolves one
// from the other against the config it just read, so a hand-made POST can
// only ever address a slot this cabinet actually has.

#[derive(Deserialize)]
pub(super) struct MapSlotForm {
    slot: Option<u8>,
    #[serde(default)]
    target: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct MapBindForm {
    slot: Option<u8>,
    #[serde(default)]
    target: Option<String>,
    function: String,
    /// The `<select name="key">` value. The empty placeholder means "nothing
    /// picked" — an honest refusal, never a silent clear (that is what the
    /// Clear button beside it is for).
    #[serde(default)]
    key: Option<String>,
    /// The panel's checkbox. Present at all = ticked (HTML omits an unchecked
    /// box entirely), which is this path's answer to a cross-slot refusal.
    #[serde(default)]
    force: Option<String>,
    /// The row's turbo box. Blank leaves the rate alone; `0` clears it. Only
    /// the "Turbo" submit reads it — Bind/Add/Remove/Clear all send it too
    /// (one form, several verbs), and each one decides for itself.
    #[serde(default)]
    turbo_hz: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct MapRestoreForm {
    slot: Option<u8>,
    #[serde(default)]
    target: Option<String>,
    mode: String,
}

/// 303 back to the mapper, carrying the outcome as the flash. Errors are
/// flashed exactly like successes — the no-JS page must never fail silently.
pub(super) fn map_redirect(
    target: Option<&str>,
    slot: u8,
    outcome: Result<String, String>,
) -> Response {
    let flash = match outcome {
        Ok(message) => message,
        Err(error) => format!("error: {error}"),
    };
    let target = if map_target(target) == "stage" {
        "target=stage&"
    } else {
        ""
    };
    Redirect::to(&format!(
        "/map?{target}slot={slot}&flash={}",
        urlencode(&flash)
    ))
    .into_response()
}

/// Run one slot-scoped verb for the slot a form named. Blocking work (a
/// config read plus one pipe request) off the async workers, like [`act`].
///
/// The whole SLOT is handed to the verb, not just its preset name, because
/// v10's add/remove-one are read-modify-write on the control's key list: the
/// same config read that resolves the preset already carries the bindings the
/// edit has to be computed against, so nothing reads the file twice and no
/// form has to be trusted with a key list it made up.
pub(super) async fn map_act_slot<F>(
    state: Arc<AppState>,
    target: Option<String>,
    slot: Option<u8>,
    verb: F,
) -> Response
where
    F: FnOnce(&dyn ControlSource, &crate::snapshot::MapperSlot) -> Result<String, String>
        + Send
        + 'static,
{
    let redirect_target = target.clone();
    let (number, outcome) = tokio::task::spawn_blocking(move || {
        let mapper = if map_target(target.as_deref()) == "stage" {
            ksx_api::staged_mapper_snapshot(&state.control.staged())
        } else {
            state.source.mapper()
        };
        let staged = map_target(target.as_deref()) == "stage";
        let chosen = if staged {
            slot.and_then(|n| mapper.slots.iter().find(|s| s.number == n))
        } else {
            slot.and_then(|n| mapper.slots.iter().find(|s| s.number == n))
                .or_else(|| mapper.slots.first())
        };
        match chosen {
            Some(slot) => (slot.number, verb(state.control.as_ref(), slot)),
            None if staged => {
                let number = slot.unwrap_or(0);
                let reason = if slot.is_some() {
                    format!("Player {number} is no longer in this unsaved setup. Nothing changed.")
                } else {
                    "Choose a player before changing controls. Nothing changed.".to_owned()
                };
                (number, Err(reason))
            }
            None => (
                0,
                Err(if mapper.generated_at == "(unavailable)" {
                    mapper.source
                } else {
                    "No controller is ready to edit. Add one in Setup, then return to Controls."
                        .to_owned()
                }),
            ),
        }
    })
    .await
    .unwrap_or_else(|_| (0, Err("the control call panicked".to_owned())));
    map_redirect(redirect_target.as_deref(), number, outcome)
}

/// [`map_act_slot`] for the verbs that need nothing but the preset name.
pub(super) async fn map_act<F>(
    state: Arc<AppState>,
    target: Option<String>,
    slot: Option<u8>,
    verb: F,
) -> Response
where
    F: FnOnce(&dyn ControlSource, &str) -> Result<String, String> + Send + 'static,
{
    map_act_slot(state, target, slot, move |control, slot| {
        verb(control, &slot.preset)
    })
    .await
}

/// One [`BindOutcome`] as the sentence a page with no JavaScript reads.
///
/// A cross-slot refusal names the other slot AND the way to say yes to it:
/// the learn flow asks with a Replace dialog, a form asks with the panel's
/// checkbox. Either way the answer is never "nothing happened".
pub(super) fn bind_flash(
    function: &str,
    key: Option<&str>,
    outcome: BindOutcome,
) -> Result<String, String> {
    if outcome.ok {
        let mut line = match key {
            Some(key) => format!("{function} is now {key}"),
            None => format!("{function} is now unbound"),
        };
        if !outcome.also_drives.is_empty() {
            line.push_str(&format!(
                " — that key also drives {}",
                outcome.also_drives.join(", ")
            ));
        }
        line.push('.');
        return Ok(line);
    }
    Err(bind_refusal(function, key, outcome))
}

/// The refusal half of every write on this page, in one voice: a cross-slot
/// conflict names the other slot AND the checkbox that says yes to it, and
/// anything else quotes the daemon (or [`crate::control::multi_key_refusal`],
/// which already explains itself).
pub(super) fn bind_refusal(function: &str, key: Option<&str>, outcome: BindOutcome) -> String {
    if outcome.code.as_deref() == Some("conflict") && !outcome.conflicts.is_empty() {
        let named = key.unwrap_or("that key");
        let who: Vec<String> = outcome
            .conflicts
            .iter()
            .map(|conflict| {
                let control = conflict.function.strip_prefix("macro.").map_or_else(
                    || conflict.function.clone(),
                    |name| format!("the \"{name}\" macro"),
                );
                match conflict.slot {
                    Some(player) => {
                        format!("{named} already controls {control} for Player {player}")
                    }
                    None => format!("{named} already controls {control} for another player"),
                }
            })
            .collect();
        return format!(
            "{function} was not changed: {} — tick \"let this key drive another player's \
             control too\" in the Bind by name panel and submit again",
            who.join("; ")
        );
    }
    format!(
        "{function} was not changed: {}",
        consumer_map_detail(
            outcome.error.as_deref().unwrap_or(""),
            "That control could not be changed. Nothing changed."
        )
    )
}

/// One key-SET write as the sentence a page with no JavaScript reads. It
/// reports the control's whole list, because that is the thing that changed —
/// and it says out loud that the keys are alternatives, which is the fact a
/// row of two key tags does not carry on its own.
pub(super) fn keys_flash(
    function: &str,
    key: Option<&str>,
    after: &[String],
    outcome: BindOutcome,
) -> Result<String, String> {
    if !outcome.ok {
        return Err(bind_refusal(function, key, outcome));
    }
    let mut line = match after {
        [] => format!("{function} is now unbound"),
        [one] => format!("{function} is now {one}"),
        _ => format!(
            "{function} now has {} — any one of them presses it",
            after.join(" · ")
        ),
    };
    if !outcome.also_drives.is_empty() {
        line.push_str(&format!(
            " — that key also drives {}",
            outcome.also_drives.join(", ")
        ));
    }
    line.push('.');
    Ok(line)
}

/// The key a form picked, or the refusal that names what to do instead.
/// Shared by every route that needs one, so "I forgot to pick a key" is the
/// same sentence everywhere.
pub(super) fn picked_key(form: &MapBindForm, function: &str, verb: &str) -> Result<String, String> {
    form.key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            format!("no key picked for {function} — choose one from the list before \"{verb}\"")
        })
}

/// POST /map/add — ADD the picked key to what the control already has,
/// instead of replacing it (MAME-style OR-chaining: either key presses the
/// control, docs/INPUT-TRANSFORMS.md §1a). Read-modify-write on the key list
/// the config read already carries; the whole set goes to `bind_keys`.
pub(super) async fn map_form_add(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapBindForm>,
) -> Response {
    let function = form.function.trim().to_owned();
    let force = form.force.is_some();
    let target = form.target.clone();
    let key = match picked_key(&form, &function, "Add") {
        Ok(key) => key,
        Err(refusal) => {
            return map_redirect(target.as_deref(), form.slot.unwrap_or(0), Err(refusal))
        }
    };
    let write_target = target.clone();
    map_act_slot(state, target, form.slot, move |control, slot| {
        let current = slot.bindings.get(&function).cloned().unwrap_or_default();
        let next = crate::control::with_key(&current, &key);
        if next.len() == current.len() {
            return Ok(format!(
                "{function} already has {key} — nothing to add (it has {}).",
                current.join(" · ")
            ));
        }
        let outcome = bind_for_target(
            control,
            TargetBind {
                target: write_target.as_deref(),
                slot: Some(slot.number),
                preset: &slot.preset,
                function: &function,
                keys: &next,
                force,
                reload: true,
                turbo_hz: None,
            },
        );
        keys_flash(&function, Some(&key), &next, outcome)
    })
    .await
}

/// POST /map/key/remove — take ONE key off a control and leave the others.
/// The no-JS twin of the legend chips' per-key ✕: the row's key picker says
/// WHICH key goes, so removing one of several never needs JavaScript.
pub(super) async fn map_form_remove_key(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapBindForm>,
) -> Response {
    let function = form.function.trim().to_owned();
    let target = form.target.clone();
    let key = match picked_key(&form, &function, "Remove key") {
        Ok(key) => key,
        Err(refusal) => {
            return map_redirect(target.as_deref(), form.slot.unwrap_or(0), Err(refusal))
        }
    };
    let write_target = target.clone();
    map_act_slot(state, target, form.slot, move |control, slot| {
        let current = slot.bindings.get(&function).cloned().unwrap_or_default();
        let next = crate::control::without_key(&current, &key);
        if next.len() == current.len() {
            return Err(format!(
                "{function} was not changed: it is not bound to {key}{}",
                if current.is_empty() {
                    " (it is unbound)".to_owned()
                } else {
                    format!(" (it has {})", current.join(" · "))
                }
            ));
        }
        let outcome = bind_for_target(
            control,
            TargetBind {
                target: write_target.as_deref(),
                slot: Some(slot.number),
                preset: &slot.preset,
                function: &function,
                keys: &next,
                force: false,
                reload: true,
                turbo_hz: None,
            },
        );
        // The removed key is named in the sentence, because "A is now S" on
        // its own does not say what just left.
        keys_flash(&function, Some(&key), &next, outcome)
            .map(|line| format!("{key} removed. {line}"))
    })
    .await
}

/// POST /map/bind — the form twin of `/api/bind`.
pub(super) async fn map_form_bind(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapBindForm>,
) -> Response {
    let function = form.function.trim().to_owned();
    let key = form
        .key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned);
    let force = form.force.is_some();
    let target = form.target.clone();
    if key.is_none() {
        return map_redirect(
            target.as_deref(),
            form.slot.unwrap_or(0),
            Err(format!(
                "no key picked for {function} — choose one from the list (\"Clear\" is how \
                 you unbind it)"
            )),
        );
    }
    let write_target = target.clone();
    map_act_slot(state, target, form.slot, move |control, slot| {
        let keys = key.iter().cloned().collect::<Vec<_>>();
        let outcome = bind_for_target(
            control,
            TargetBind {
                target: write_target.as_deref(),
                slot: Some(slot.number),
                preset: &slot.preset,
                function: &function,
                keys: &keys,
                force,
                reload: true,
                turbo_hz: None,
            },
        );
        bind_flash(&function, key.as_deref(), outcome)
    })
    .await
}

/// POST /map/clear — the same `map` verb with a null key, which is exactly
/// what `ksx map --clear` writes. No second unbind path.
pub(super) async fn map_form_clear(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapBindForm>,
) -> Response {
    let function = form.function.trim().to_owned();
    let target = form.target.clone();
    let write_target = target.clone();
    map_act_slot(state, target, form.slot, move |control, slot| {
        let outcome = bind_for_target(
            control,
            TargetBind {
                target: write_target.as_deref(),
                slot: Some(slot.number),
                preset: &slot.preset,
                function: &function,
                keys: &[],
                force: false,
                reload: true,
                turbo_hz: None,
            },
        );
        bind_flash(&function, None, outcome)
    })
    .await
}

/// POST /map/turbo — set (or clear) a control's AUTO-FIRE rate
/// (docs/INPUT-TRANSFORMS.md §3), the no-JS twin of the learn modal's Turbo
/// row.
///
/// It writes through the SAME `bind_keys` every other row verb uses, with the
/// control's CURRENT key list: turbo is a property of the control, so setting
/// it is a re-write of that control with one more field, not a second writer.
/// A blank box is a refusal rather than a silent clear — `0` is how you say
/// "off", exactly as it is on the CLI.
pub(super) async fn map_form_turbo(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapBindForm>,
) -> Response {
    let function = form.function.trim().to_owned();
    let target = form.target.clone();
    let raw = form.turbo_hz.as_deref().map(str::trim).unwrap_or("");
    let hz = match raw.parse::<u32>() {
        Ok(hz) => hz,
        Err(_) => {
            return map_redirect(
                target.as_deref(),
                form.slot.unwrap_or(0),
                Err(format!(
                    "no turbo rate given for {function} — type a number of presses a second                      into the box (0 turns auto-fire off)"
                )),
            )
        }
    };
    let write_target = target.clone();
    map_act_slot(state, target, form.slot, move |control, slot| {
        let current = slot.bindings.get(&function).cloned().unwrap_or_default();
        if current.is_empty() && hz > 0 {
            return Err(format!(
                "{function} has no keys, so there is nothing to auto-fire — bind a key first"
            ));
        }
        let outcome = bind_for_target(
            control,
            TargetBind {
                target: write_target.as_deref(),
                slot: Some(slot.number),
                preset: &slot.preset,
                function: &function,
                keys: &current,
                force: false,
                reload: true,
                turbo_hz: Some(hz),
            },
        );
        if !outcome.ok {
            return Err(bind_refusal(&function, None, outcome));
        }
        Ok(match (hz, outcome.turbo_effective_hz) {
            (0, _) => format!("{function} no longer auto-fires."),
            (asked, Some(effective)) if effective != asked => format!(
                "{function} auto-fires about {effective} times a second. The requested {asked} is too fast for reliable press-and-release input."
            ),
            (asked, _) => format!("{function} auto-fires at {asked} Hz."),
        })
    })
    .await
}

/// POST /map/preset/restore — the form twin of `/api/preset/restore`, same
/// three destinations, same validation before any daemon round trip.
pub(super) async fn map_form_restore(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapRestoreForm>,
) -> Response {
    let mode = form.mode.trim().to_owned();
    if map_target(form.target.as_deref()) == "stage" {
        return map_redirect(
            form.target.as_deref(),
            form.slot.unwrap_or(0),
            Err("This unsaved setup has no recovery copy yet. Save it first, or keep editing it in memory.".to_owned()),
        );
    }
    let Some(mode) = crate::control::RestoreMode::parse(&mode) else {
        return map_redirect(
            form.target.as_deref(),
            form.slot.unwrap_or(0),
            Err("Choose one of the recovery options shown on the page.".to_owned()),
        );
    };
    map_act(state, form.target, form.slot, move |control, preset| {
        control
            .restore(preset, mode)
            .map(|message| consumer_map_detail(&message, "Your controller layout was restored."))
            .map_err(|refusal| {
                consumer_map_detail(
                    &flash_of(refusal),
                    "That recovery copy could not be applied. Nothing changed.",
                )
            })
    })
    .await
}

/// POST /map/preset/clear-all — the form twin of `/api/preset/clear-all`.
pub(super) async fn map_form_clear_all(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapSlotForm>,
) -> Response {
    if map_target(form.target.as_deref()) == "stage" {
        return map_redirect(
            form.target.as_deref(),
            form.slot.unwrap_or(0),
            Err("Use the individual controls while this setup is unsaved; Clear all is available after Save.".to_owned()),
        );
    }
    map_act(state, form.target, form.slot, move |control, preset| {
        control
            .clear_all(preset)
            .map(|message| {
                consumer_map_detail(
                    &message,
                    "All controls were cleared. Use Undo this session to recover them.",
                )
            })
            .map_err(|refusal| {
                consumer_map_detail(
                    &flash_of(refusal),
                    "The controller layout could not be cleared. Nothing changed.",
                )
            })
    })
    .await
}

/// POST /map/session/stop — "Pause emulation & map" without JavaScript. The
/// same `stop` verb the status page's form posts; it just comes back to /map
/// so the user keeps their place. (There is no form twin for Resume: the
/// resume bar is client-only state — this page having paused something — so
/// a no-JS page never shows it. `/` starts a session back up.)
pub(super) async fn map_form_session_stop(
    State(state): State<Arc<AppState>>,
    Form(form): Form<MapSlotForm>,
) -> Response {
    let slot = form.slot.unwrap_or(0);
    let target = form.target;
    let outcome = tokio::task::spawn_blocking(move || state.control.stop().map_err(flash_of))
        .await
        .unwrap_or_else(|_| Err("the control call panicked".to_owned()));
    map_redirect(target.as_deref(), slot, outcome)
}
