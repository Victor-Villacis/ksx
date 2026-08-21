//! `/profiles` — saved games, and the presets they point at.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

// ---------------------------------------------------------------------------
// /profiles — the games.toml profiles and the presets, with the two creates
// ---------------------------------------------------------------------------

/// One fresh profiles payload. Both machine reads hit the config store, which
/// blocks; kept off the async workers like [`collect`] and [`collect_map`].
///
/// A read that REFUSES is recorded as a REFUSAL, not as an empty view.
///
/// This was the review finding, and it is this project's signature bug: on
/// `Err` the handler substituted `ProfilesView::default()`, so the page said
/// "no profiles in games.toml" at the top and buried "games.toml could not be
/// read: …" in the last card. The presets side was worse — a `PresetsView`
/// default made `noPresetsYet` true, whose copy sends the user to a template
/// form whose `<select>` is ALSO empty, so the one route offered could not
/// succeed. "I could not read this" and "there is nothing here" are different
/// sentences, and a user acts on them differently.
///
/// So the refusal lands in a typed field ([`ProfilesPayload::profiles_error`])
/// that every derived line branches on, AND in the notes, which is where a
/// warning from a read that SUCCEEDED goes.
pub(super) async fn collect_profiles(state: &Arc<AppState>) -> ProfilesPayload {
    let read_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let session = read_state.control.session();
        let mut notes = Vec::new();
        let mut profiles_error = None;
        let mut presets_error = None;
        let profiles = match read_state.machine.profiles() {
            Ok(mut view) => {
                if !view.notes.is_empty() {
                    notes.push(
                        "Some saved-game details need attention. Reopen ksx after correcting them."
                            .to_owned(),
                    );
                    view.notes = notes.clone();
                }
                view
            }
            Err(_) => {
                let message = "Saved Games could not be read. Reopen ksx and try again.";
                notes.push(message.to_owned());
                profiles_error = Some(message.to_owned());
                ksx_api::ProfilesView::default()
            }
        };
        let presets = match read_state.machine.presets() {
            Ok(view) => view,
            Err(_) => {
                let message = "Controller layouts could not be read. Reopen ksx and try again.";
                notes.push(message.to_owned());
                presets_error = Some(message.to_owned());
                ksx_api::PresetsView::default()
            }
        };
        // Both reads discover the config root independently, so a machine with
        // no config root refuses BOTH with the identical sentence. Printing it
        // twice reads as two problems, and the client keys its note list by the
        // line — duplicate keys are a reconcile hazard as well as a lie.
        // `Vec::dedup` would not do it: the duplicates are not adjacent (the
        // first read contributes a message AND its remedy before the second
        // read's message arrives).
        let mut seen = std::collections::BTreeSet::new();
        notes.retain(|line| seen.insert(line.clone()));
        ProfilesPayload {
            profiles,
            presets,
            session,
            profiles_error,
            presets_error,
            notes,
            flash: None,
            view: Default::default(),
        }
        .derived()
    })
    .await
    .unwrap_or_else(|_| {
        // A panicked read is a FAILED read, not an empty machine — the same
        // distinction, arriving by a different door.
        ProfilesPayload {
            session: SessionView::unreachable("Play is temporarily unavailable."),
            profiles_error: Some(
                "Saved Games could not be read. Reopen ksx and try again.".to_owned(),
            ),
            presets_error: Some(
                "Controller layouts could not be read. Reopen ksx and try again.".to_owned(),
            ),
            notes: vec!["Saved Games is temporarily unavailable.".to_owned()],
            ..ProfilesPayload::default()
        }
        .derived()
    })
}

pub(super) async fn profiles_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Response {
    let payload = collect_profiles(&state).await;
    let flash = crate::render_profiles::profiles_flash_from_query(query.flash.as_deref());
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        crate::render_profiles::render_profiles(&state.profiles_page, &payload, flash),
        theme.as_deref(),
    );
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

/// The Profiles poller's endpoint — the same [`ProfilesPayload`] the page
/// embeds (parity unit-tested in render_profiles.rs).
pub(super) async fn api_profiles(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_profiles(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

/// 303 back to /profiles with copy owned by the presentation seam. Neither a
/// provider sentence nor a form value is ever reflected into the redirect.
pub(super) fn profiles_redirect(
    action: crate::render_profiles::ProfilesAction,
    succeeded: bool,
) -> Response {
    let flash = crate::render_profiles::profiles_action_flash(action, succeeded);
    Redirect::to(&format!("/profiles?flash={}", urlencode(flash))).into_response()
}

/// Run one [`ksx_api::MachineSource`] verb off the async workers, then 303
/// back to /profiles. The [`act`] of this page.
pub(super) async fn machine_act<F>(
    state: Arc<AppState>,
    action: crate::render_profiles::ProfilesAction,
    verb: F,
) -> Response
where
    F: FnOnce(&dyn ksx_api::MachineSource) -> Result<String, ksx_api::Refusal> + Send + 'static,
{
    let succeeded = tokio::task::spawn_blocking(move || verb(state.machine.as_ref()).is_ok())
        .await
        .unwrap_or(false);
    profiles_redirect(action, succeeded)
}

/// Every field defaults, deliberately — including the two that are required —
/// and every field is a `String`, which is the same decision twice.
///
/// Not laxity: an extraction FAILURE is a 422 with no `Location`, and the
/// island's fetch-submit reads its outcome out of the redirect's `?flash=`
/// (`profiles.ts`). A 422 therefore arrives as `flash = null`, which the page
/// renders as nothing at all — the exact silent failure every route here is
/// written to avoid. Defaulting hands an empty spec to the planner instead,
/// which refuses in words and 303s like everything else.
///
/// The number fields were `Option<u8>` and that was HALF the fix, which is
/// worse than none because it looks finished. `#[serde(default)]` covers an
/// ABSENT key; a browser sends `slots=` — present, empty — the moment a user
/// clears a non-`required` `<input type="number">`, and serde_urlencoded
/// answers "cannot parse integer from empty string". Straight back to the 422
/// with no `Location`, and a button that does nothing at all. So the wire type
/// is a string all the way in and [`number_field`] does the parsing, where a
/// bad value is a worded refusal on a 303 like every other refusal here.
#[derive(Deserialize)]
pub(super) struct NewProfileForm {
    #[serde(default)]
    title: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    arguments: String,
    /// The form's `<input type="number">`, as text. Empty falls through to the
    /// planner's own refusal rather than a silent default: "how many players"
    /// is not a question this layer may answer on the user's behalf.
    #[serde(default)]
    slots: String,
    #[serde(default)]
    preset: String,
}

/// One numeric form field, parsed HERE instead of by the extractor.
///
/// `Ok(None)` means "the user left it blank" — the caller decides whether that
/// is a default or a refusal. `Err` selects the action's fixed refusal copy: a
/// 303 with words on it, never a 422 the page cannot read.
pub(super) fn number_field(raw: &str, field: &str) -> Result<Option<u8>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    raw.parse::<u8>().map(Some).map_err(|_| {
        format!("\"{raw}\" is not a number this form can use for {field} — type a whole number")
    })
}

/// POST /profiles/new — the verb that did not exist.
///
/// `ksx setup` writes INTO a profile and bails when the title is absent;
/// `ksx config import` replaces the whole file. Neither creates one, which is
/// why "I can't create a new profile" was a true statement about every surface
/// ksx had. One `MachineSource::profile_new` call, one plan, one write with a
/// timestamped backup.
pub(super) async fn profiles_form_new(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NewProfileForm>,
) -> Response {
    // Blank stays 0, which the planner refuses by name ("a profile hands out
    // 1..=MAX_SLOTS slots") — this layer does not pick a player count.
    let slots = match number_field(&form.slots, "players") {
        Ok(value) => value.unwrap_or(0),
        Err(_) => {
            return profiles_redirect(crate::render_profiles::ProfilesAction::CreateGame, false)
        }
    };
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::CreateGame,
        move |machine| {
            machine.profile_new(&ksx_api::NewProfile {
                title: form.title,
                path: form.path,
                arguments: form.arguments,
                slots,
                preset: form.preset,
            })
        },
    )
    .await
}

/// Defaulted, string-typed form fields keep every refusal on the page instead
/// of turning an empty number input into an extractor-level 422.
#[derive(Deserialize)]
pub(super) struct UpdateProfileForm {
    #[serde(default)]
    original_title: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    arguments: String,
    #[serde(default)]
    slots: String,
    #[serde(default)]
    preset: String,
    #[serde(default)]
    rebase_devices: bool,
}

/// POST /profiles/update — replace one exact profile while keeping its
/// existing device assignments unless the form explicitly asks to refresh
/// them from the current Setup controllers.
pub(super) async fn profiles_form_update(
    State(state): State<Arc<AppState>>,
    Form(form): Form<UpdateProfileForm>,
) -> Response {
    let slots = match number_field(&form.slots, "players") {
        Ok(value) => value.unwrap_or(0),
        Err(_) => {
            return profiles_redirect(crate::render_profiles::ProfilesAction::UpdateGame, false)
        }
    };
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::UpdateGame,
        move |machine| {
            machine.profile_update(&ksx_api::UpdateProfile {
                original_title: form.original_title,
                revision: form.revision,
                title: form.title,
                path: form.path,
                arguments: form.arguments,
                slots,
                preset: form.preset,
                rebase_devices: form.rebase_devices,
            })
        },
    )
    .await
}

#[derive(Deserialize)]
pub(super) struct DeleteProfileForm {
    #[serde(default)]
    title: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    confirm_delete: String,
}

/// POST /profiles/delete — remove only the named game profile. Presets and
/// the controller setup are independent resources and are never cascaded.
pub(super) async fn profiles_form_delete(
    State(state): State<Arc<AppState>>,
    Form(form): Form<DeleteProfileForm>,
) -> Response {
    if form.confirm_delete != "yes" {
        return profiles_redirect(crate::render_profiles::ProfilesAction::DeleteGame, false);
    }
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::DeleteGame,
        move |machine| {
            machine.profile_delete(&ksx_api::DeleteProfile {
                title: form.title,
                revision: form.revision,
            })
        },
    )
    .await
}

/// Defaulted, and string-typed, for the same reasons as [`NewProfileForm`].
#[derive(Deserialize)]
pub(super) struct NewPresetForm {
    #[serde(default)]
    name: String,
    #[serde(default)]
    template: String,
    #[serde(default)]
    player: String,
}

/// POST /profiles/preset/new — `ksx preset new`, through the same writer.
///
/// No `force` field, deliberately: a web form must not overwrite a complete
/// controller layout merely because its name collided. The action-specific
/// refusal tells the customer to choose another name without reflecting the
/// provider's internal message or remedy.
pub(super) async fn profiles_form_preset_new(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NewPresetForm>,
) -> Response {
    // Blank means player 1 — every template has a first block, and the field
    // is labelled as the multi-player exception rather than a required answer.
    let player = match number_field(&form.player, "the player choice") {
        Ok(value) => value.unwrap_or(1),
        Err(_) => {
            return profiles_redirect(crate::render_profiles::ProfilesAction::CreateLayout, false)
        }
    };
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::CreateLayout,
        move |machine| {
            machine.preset_new(&ksx_api::NewPreset {
                name: form.name,
                template: form.template,
                player,
                force: false,
            })
        },
    )
    .await
}

/// The two fields `/profiles/preset/rename` reads. Strings all the way in,
/// for the reason [`NewProfileForm`] documents at length: an extraction
/// failure is a 422 with no `Location`, which the island reads as no flash at
/// all — the silent failure every route here is written to avoid.
#[derive(Deserialize)]
pub(super) struct RenamePresetForm {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

/// POST /profiles/preset/rename — `ksx preset rename`, through the same
/// planner, so the file and every controller naming it move together.
pub(super) async fn profiles_form_preset_rename(
    State(state): State<Arc<AppState>>,
    Form(form): Form<RenamePresetForm>,
) -> Response {
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::RenameLayout,
        move |machine| {
            machine.preset_rename(&ksx_api::RenamePreset {
                from: form.from,
                to: form.to,
            })
        },
    )
    .await
}

#[derive(Deserialize)]
pub(super) struct DeletePresetForm {
    #[serde(default)]
    name: String,
    /// The checkbox. Absent means unchecked, which is a refusal here rather
    /// than a delete — the same consent shape `/profiles/delete` uses.
    #[serde(default)]
    confirm_delete: String,
}

/// POST /profiles/preset/delete — `ksx preset delete`, WITHOUT `--force`.
///
/// The CLI has a force that deletes a layout controllers still use and leaves
/// them pointing at nothing; a web form must not. A page that can strand a
/// cabinet in one click is not a page, and the row already shows the use
/// count next to the control, so the refusal is never the first time anybody
/// hears about it.
pub(super) async fn profiles_form_preset_delete(
    State(state): State<Arc<AppState>>,
    Form(form): Form<DeletePresetForm>,
) -> Response {
    if form.confirm_delete != "yes" {
        return profiles_redirect(
            crate::render_profiles::ProfilesAction::DeleteLayoutUnconfirmed,
            false,
        );
    }
    machine_act(
        state,
        crate::render_profiles::ProfilesAction::DeleteLayout,
        move |machine| {
            machine.preset_delete(&ksx_api::DeletePreset {
                name: form.name,
                force: false,
            })
        },
    )
    .await
}
/// POST /profiles/switch — start a session under one profile.
///
/// The SAME `ControlSource::start` the status page's forms post and the tray
/// enqueues; the only difference is that this one comes back to /profiles, so
/// the user keeps their place. Exactly the shape `/map/session/stop` already
/// has. There is no second "switch profile" verb and there must not be.
pub(super) async fn profiles_form_switch(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartForm>,
) -> Response {
    let profile = form
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned);
    let succeeded =
        tokio::task::spawn_blocking(move || state.control.start(profile.as_deref()).is_ok())
            .await
            .unwrap_or(false);
    profiles_redirect(crate::render_profiles::ProfilesAction::Play, succeeded)
}

/// Stop the active Play session and return to Saved Games so a cabinet is not
/// stranded on a read-only running state.
pub(super) async fn profiles_form_stop(State(state): State<Arc<AppState>>) -> Response {
    let succeeded = tokio::task::spawn_blocking(move || state.control.stop().is_ok())
        .await
        .unwrap_or(false);
    profiles_redirect(crate::render_profiles::ProfilesAction::Stop, succeeded)
}
