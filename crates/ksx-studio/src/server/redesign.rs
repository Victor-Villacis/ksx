//! `/redesign` — the transplant rebuild's workbench.
//!
//! The same shape as every page module here: one collector on a blocking
//! worker, one GET that renders it themed, one JSON twin the island polls —
//! plus the theme and device-staging verbs transplanted from `/nocturne`,
//! each re-homed with its own 303 target and the same allowlisted `?flash=`
//! outcome channel.

use super::*;

#[derive(Deserialize)]
pub(super) struct RedesignQuery {
    flash: Option<String>,
    /// The selected controller slot — the nocturne selection rule: an
    /// explicit `?slot=` wins, otherwise the first staged controller speaks
    /// for the inspector panel.
    slot: Option<u8>,
}

/// The sentences this page may be asked to repeat after a redirect, resolved
/// against an allowlist exactly like `/nocturne` — never reflected. Every
/// verb's sentences ARE nocturne's constants: one wording, two pages, so the
/// copy cannot drift between the surfaces (the cutover's "provider text"
/// lesson, applied in advance).
const RD_FLASH_ALLOWLIST: [&str; 25] = [
    N_THEME_OK,
    N_THEME_UNKNOWN,
    N_DEVICE_OK,
    N_DEVICE_ALREADY_OK,
    N_FORM_UNREADABLE,
    N_EDIT_OK,
    N_EDIT_ERROR,
    N_MOVE_AT_END,
    N_ADD_LAYOUT_ERROR,
    N_UNKNOWN_FLASH_ERROR,
    N_CLEAR_ALL_OK,
    N_UNDO_OK,
    N_UNDO_GONE,
    N_UNDO_FULL,
    N_DUP_OK,
    N_DUP_FULL,
    N_TURBO_OK,
    N_TURBO_INPUT_ERROR,
    N_TURBO_UNBOUND_ERROR,
    N_TOGGLE_OK,
    N_TOGGLE_OLD_DAEMON,
    N_TOGGLE_UNBOUND_ERROR,
    N_KEY_CLEAR_OK,
    N_KEY_CLEAR_NONE,
    N_BLOCKING_OK,
];

pub(super) fn redesign_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        RD_FLASH_ALLOWLIST
            .into_iter()
            .find(|safe| *safe == flash)
            .unwrap_or(N_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

fn redesign_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/redesign?flash={}", urlencode(flash))).into_response()
}

/// One fresh [`RedesignPayload`]: the machine provenance and the theme
/// roster, on a blocking worker like every other collector read. The page
/// derives its `<html data-theme>` stamp from the chosen row in this payload,
/// so the stamp and the menu cannot disagree within a render.
pub(super) async fn collect_redesign(
    state: &Arc<AppState>,
    selected_slot: Option<u8>,
) -> RedesignPayload {
    let redesign_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let setup = redesign_state
            .machine_cache
            .setup_state(&*redesign_state.machine)
            .ok();
        // The device scan, for the workbench picker. Deliberately UNCACHED,
        // for the reason `/devices` gives — a board unplugged ten minutes ago
        // must stop being offered — and affordable here because this page has
        // no interval poller: the read runs on a page render and after a
        // verb, not every two seconds. The refusal keeps its remedy (the
        // `/devices` composition): it is going onto a page, and "run `ksx
        // devices`" is the whole value of the message.
        let scan = redesign_state
            .machine
            .device_scan()
            .map_err(|refusal| match &refusal.remedy {
                Some(remedy) => format!("{} — {remedy}", refusal.message),
                None => refusal.message.clone(),
            });
        // The staged device — the daemon's answer to "which board does ksx
        // split", marked onto the picker rows and the bench cards.
        let staged = redesign_state.control.staged();
        // The undo chip label off this page's OWN stash (the shared helper
        // also sweeps an expired stash).
        let undo_label = undo_chip_label(&redesign_state.redesign_undo);
        let mut payload = crate::render_redesign::payload(
            &redesign_state.source.environment(),
            setup,
            scan,
            &staged,
            selected_slot,
            undo_label.as_deref(),
        );
        // Which parked ghosts the studio still HOLDS (authoring included),
        // so a ghost card can say "bindings kept" vs "staged fresh" before
        // the press. Studio state, not a daemon read — set here like the
        // staging line, not composed in the pure payload fn.
        payload.controllers.parked_held = redesign_state
            .redesign_parked
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
        payload
    })
    .await
    .unwrap_or_default()
}

/// The root stamp for one already-collected payload. System is represented by
/// the absence of `data-theme`, just as it is everywhere else; an unreadable
/// setup has no chosen row and therefore also renders without a claim.
///
/// Deliberately do not read setup again here. The chosen row was composed from
/// the collector's one cached `SetupView`, making it the page's single theme
/// truth for both SSR chrome and the document root.
fn theme_from_payload(payload: &RedesignPayload) -> Option<&str> {
    payload
        .theme_rows
        .iter()
        .find(|row| row.chosen)
        .map(|row| row.name.as_str())
        .filter(|theme| *theme != "system")
}

/// `GET /redesign` — the redesign lane's canvas workbench.
pub(super) async fn redesign_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RedesignQuery>,
) -> Response {
    let payload = collect_redesign(&state, query.slot).await;
    let flash = redesign_flash_from_query(query.flash.as_deref());
    let out = crate::render::with_theme(
        render_redesign(&state.redesign_page.get(), &payload, flash.as_deref()),
        theme_from_payload(&payload),
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

/// The poller's endpoint — the same [`RedesignPayload`] the /redesign page
/// embeds as island props (parity unit-tested in render_redesign.rs).
pub(super) async fn api_redesign(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RedesignQuery>,
) -> Response {
    let payload = collect_redesign(&state, query.slot).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct RedesignThemeForm {
    theme: Option<String>,
}

/// POST /redesign/theme — `nocturne_form_theme`, re-homed for this page's
/// menu (the handler body is that verb's, verbatim; only the redirect target
/// differs). A config write like blocking, but read per page render rather
/// than by the daemon, so "saved" IS "in effect" — the router-wide layer
/// invalidates `machine_cache` around every non-GET, which is what lets the
/// redirect's own render stamp the new choice.
///
/// `system` is stored as the EMPTY id deliberately: absence means "follow the
/// operating system", so there is no third state to keep in step, and an id
/// this build does not ship is refused rather than written.
pub(super) async fn redesign_form_theme(
    State(state): State<Arc<AppState>>,
    Form(form): Form<RedesignThemeForm>,
) -> Response {
    let Some(field) = form.theme else {
        // Keep the scripted and no-JavaScript paths on the same allowlisted
        // feedback channel. A literal here would be read directly from the
        // redirect URL by fetch enhancement but replaced on a full render.
        return redesign_redirect(N_THEME_UNKNOWN);
    };
    let wanted = field.trim().to_owned();
    let stored = if wanted == "system" {
        String::new()
    } else if let Some(meta) = crate::theme_tokens::THEMES.iter().find(|t| t.id == wanted) {
        meta.id.to_owned()
    } else {
        return redesign_redirect(N_THEME_UNKNOWN);
    };
    let ok = tokio::task::spawn_blocking(move || {
        state
            .machine
            .set_theme(&ksx_api::ThemeSpec { theme: stored })
            .is_ok()
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_THEME_OK } else { N_EDIT_ERROR })
}

/// A form this page might not be able to read — the nocturne rule: axum's
/// own rejection is a 422 with no Location, which a fetch-submitting page
/// renders as nothing at all. Answer in a sentence instead.
type RedesignForm<T> = Result<Form<T>, axum::extract::rejection::FormRejection>;

#[derive(Deserialize)]
pub(super) struct RedesignDeviceForm {
    /// The `ksx_core::DeviceSelector` the bench card carried (served).
    /// **Never a path anybody typed** — the card has no text input.
    selector: String,
    alias: String,
    label: String,
}

/// POST /redesign/device — `nocturne_form_device`, re-homed for the bench
/// card's "Stage this board" action. The body is that verb's, through the
/// SAME [`choose_device_preserving_preparation`] guard — both doors to
/// staging keep the one preparation-preserving compare, so a WinUSB-prepared
/// board pressed again never silently drops back to interception.
pub(super) async fn redesign_form_device(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignDeviceForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let outcome = tokio::task::spawn_blocking(move || {
        choose_device_preserving_preparation(&state, form.selector, form.alias, form.label)
    })
    .await
    .unwrap_or(DeviceChoice::Refused);
    redesign_redirect(match outcome {
        // Not a refusal: the user asked for a state the page is already in,
        // and it is in it (and the preparation survived — the sentence's
        // second half is the part that matters).
        DeviceChoice::Unchanged => N_DEVICE_ALREADY_OK,
        DeviceChoice::Chosen => N_DEVICE_OK,
        DeviceChoice::Refused => N_EDIT_ERROR,
    })
}

// ── The controller verbs: the rack's add / reorder / remove, re-homed ───────
// Each is `nocturne_form_*`'s body with this page's redirect. The daemon owns
// every consequence — slot numbering, the XInput ceiling, persona
// availability — and the picker re-reads the whole staged view afterwards, so
// the workbench can never hold a slot the daemon does not.

#[derive(Deserialize)]
pub(super) struct RedesignAddForm {
    /// A persona `name` off the served roster.
    persona: String,
    /// From the served `next_preset` — served, because it becomes a file name.
    preset: String,
    /// The served default layout, so a fresh slot binds keys and is playable
    /// without a mapper. Optional like nocturne's — an empty value adds bare.
    #[serde(default)]
    layout: Option<String>,
}

/// POST /redesign/controller — stage the next slot, dressed in the served
/// layout (`nocturne_form_add`, minus the create dialog's SOCD answer — the
/// workbench edits that later, where the slot already exists).
pub(super) async fn redesign_form_ctrl_add(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignAddForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
            number: None,
            persona: form.persona,
            preset: form.preset,
            layout: None,
        });
        if !added.ok {
            return N_EDIT_ERROR;
        }
        let Some(number) = added.setup.slots.iter().map(|slot| slot.number).max() else {
            return N_EDIT_ERROR;
        };
        if let Some(layout) = form.layout.filter(|layout| !layout.trim().is_empty()) {
            // The nocturne dressing chain, verbatim: a layout dresses the
            // slot's own player block when it has one; past the blocks it was
            // authored for, fall back to the player-1 block. A slot that
            // cannot be dressed at all is removed rather than left bare and
            // unplayable behind a success sentence.
            let dressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                number,
                layout: layout.clone(),
                player: None,
            });
            if !dressed.ok {
                let redressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                    number,
                    layout,
                    player: Some(1),
                });
                if !redressed.ok {
                    let _ = state
                        .control
                        .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
                    return N_ADD_LAYOUT_ERROR;
                }
            }
        }
        N_EDIT_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignSlotForm {
    number: u8,
}

/// POST /redesign/controller/remove — drop one staged slot, then close the
/// gap. `RemoveSlot` alone leaves a HOLE (survivors keep their numbers and
/// `next_slot` fills it later — the nocturne rack's choice); the workbench's
/// law is the player line instead: survivors move UP in arrival order, so a
/// card's number always IS its play position. One `ReorderSlots` over the
/// surviving order renumbers 1..N — the daemon's own compaction, not ours.
/// No undo stash here (the nocturne rack's short undo window is its own
/// feature); the refreshed payload is the whole answer.
pub(super) async fn redesign_form_ctrl_remove(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let ok = tokio::task::spawn_blocking(move || {
        // The nocturne chip's contract on this page's own stash: the
        // resurrection material is read BEFORE the removal, server-held for
        // the short window, and never handed to the browser.
        let stash = stash_removed_slot(&state.control.staged(), form.number);
        let removed = state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot {
                number: form.number,
            })
            .ok;
        if !removed {
            return false;
        }
        *state.redesign_undo.lock().unwrap() = stash;
        compact_staged_slots(&state);
        true
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

/// Close any number gap: one `ReorderSlots` over the surviving order
/// renumbers 1..N. Best-effort past the initiating edit (a daemon too old
/// to reorder simply keeps the hole, and the flash reports the edit that
/// DID happen). The workbench's law: a card's number IS its play position.
fn compact_staged_slots(state: &AppState) {
    let survivors: Vec<u8> = state
        .control
        .staged()
        .slots
        .iter()
        .map(|slot| slot.number)
        .collect();
    let contiguous = survivors
        .iter()
        .enumerate()
        .all(|(at, number)| usize::from(*number) == at + 1);
    if survivors.is_empty() || contiguous {
        return;
    }
    let _ = state
        .control
        .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers: survivors });
}

/// How many parked controllers the store holds before the OLDEST park is
/// forgotten — enough for any real bench, small enough to stay nothing.
const REDESIGN_PARKED_CAP: usize = 32;

#[derive(Deserialize)]
pub(super) struct RedesignParkForm {
    number: u8,
    /// The browser's ghost id — the key re-slotting hands back.
    ghost: String,
}

/// POST /redesign/controller/park — "No player": take the slot OFF the
/// draft but keep its resurrection material (the full slot view, authoring
/// included) server-side under the ghost's id, then close the number gap.
/// The rack undo's pattern grown a KEYED store: several boards park at
/// once, and re-slotting restores bindings instead of staging fresh.
pub(super) async fn redesign_form_ctrl_park(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignParkForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    // The ghost id is browser-minted and becomes a server-held key: bound
    // it, so a buggy client cannot grow the store's keys without limit.
    if form.ghost.trim().is_empty() || form.ghost.len() > 64 {
        return redesign_redirect(N_EDIT_ERROR);
    }
    let ok = tokio::task::spawn_blocking(move || {
        let Some(slot) = state
            .control
            .staged()
            .slots
            .iter()
            .find(|slot| slot.number == form.number)
            .cloned()
        else {
            return false;
        };
        if !state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot {
                number: form.number,
            })
            .ok
        {
            return false;
        }
        compact_staged_slots(&state);
        let mut parked = state.redesign_parked.lock().unwrap();
        parked.retain(|(id, _)| *id != form.ghost);
        if parked.len() >= REDESIGN_PARKED_CAP {
            parked.remove(0);
        }
        parked.push((form.ghost, slot));
        true
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

#[derive(Deserialize)]
pub(super) struct RedesignAssignForm {
    ghost: String,
    position: u8,
    /// The fallback facts for a ghost the store no longer holds (a daemon
    /// restart forgets parks): stage it fresh instead, exactly like the
    /// picker's add. The card said which outcome the press buys BEFORE the
    /// press (`parked_held`).
    persona: String,
    preset: String,
    #[serde(default)]
    layout: Option<String>,
}

/// POST /redesign/controller/assign — re-slot a parked ghost at `position`
/// in ONE server transaction: restore (the undo verb's add → bindings →
/// socd chain, rollback on a failed bind) or fresh-stage when the store
/// lost it, then seat with one whole-order reorder. Restoring renames ONLY
/// when the old name is now worn by another slot — the duplicate verb's
/// aliasing rule: a save writes one preset file per name — and the
/// authoring's own name field moves with it.
pub(super) async fn redesign_form_ctrl_assign(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignAssignForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let held = {
            let parked = state.redesign_parked.lock().unwrap();
            parked
                .iter()
                .find(|(id, _)| *id == form.ghost)
                .map(|(_, slot)| slot.clone())
        };
        let staged = state.control.staged();
        let number = match held {
            Some(slot) => {
                let Some(mut authoring) = slot.authoring else {
                    return N_EDIT_ERROR;
                };
                let name_taken = staged.slots.iter().any(|s| s.preset == slot.preset);
                let name = if name_taken {
                    match staged.next_preset.clone() {
                        Some(fresh) => fresh,
                        None => return N_EDIT_ERROR,
                    }
                } else {
                    slot.preset.clone()
                };
                let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: slot.persona.clone(),
                    preset: name.clone(),
                    layout: None,
                });
                if !added.ok {
                    return N_EDIT_ERROR;
                }
                let Some(number) = added.setup.slots.iter().map(|s| s.number).max() else {
                    return N_EDIT_ERROR;
                };
                authoring.name = name;
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
                if !slot.socd.is_empty() && slot.socd != "off" {
                    let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
                        number,
                        socd: slot.socd.clone(),
                    });
                }
                number
            }
            None => {
                let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: form.persona,
                    preset: form.preset,
                    layout: None,
                });
                if !added.ok {
                    return N_EDIT_ERROR;
                }
                let Some(number) = added.setup.slots.iter().map(|s| s.number).max() else {
                    return N_EDIT_ERROR;
                };
                if let Some(layout) = form.layout.filter(|l| !l.trim().is_empty()) {
                    let dressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                        number,
                        layout: layout.clone(),
                        player: None,
                    });
                    if !dressed.ok {
                        let redressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                            number,
                            layout,
                            player: Some(1),
                        });
                        if !redressed.ok {
                            let _ = state
                                .control
                                .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
                            return N_ADD_LAYOUT_ERROR;
                        }
                    }
                }
                number
            }
        };
        // Seat it: the whole order with the fresh number at `position`.
        let mut order: Vec<u8> = state
            .control
            .staged()
            .slots
            .iter()
            .map(|slot| slot.number)
            .filter(|n| *n != number)
            .collect();
        let at = usize::from(form.position.max(1) - 1).min(order.len());
        order.insert(at, number);
        let seated = order
            .iter()
            .enumerate()
            .all(|(idx, n)| usize::from(*n) == idx + 1);
        if !seated {
            let _ = state
                .control
                .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers: order });
        }
        state
            .redesign_parked
            .lock()
            .unwrap()
            .retain(|(id, _)| *id != form.ghost);
        N_EDIT_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignMoveForm {
    /// The whole slot order, space-joined — precomposed server-side onto the
    /// card (`RedesignControllerCard::up_order`/`down_order`), one reorder
    /// per click; the renumbering is the daemon's. Empty means the card is
    /// already at that end: not an error and not a write.
    order: String,
}

/// POST /redesign/controller/move — `nocturne_form_move`, re-homed.
pub(super) async fn redesign_form_ctrl_move(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignMoveForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let numbers: Vec<u8> = form
        .order
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if numbers.is_empty() {
        return redesign_redirect(N_MOVE_AT_END);
    }
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers })
            .ok
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

// ── The inspector's controller verbs — each a re-homed nocturne verb: the
// shared core does the work and answers the SAME sentence; only the 303
// target belongs to this page. ────────────────────────────────────────────

#[derive(Deserialize)]
pub(super) struct RedesignSocdForm {
    number: u8,
    socd: String,
}

/// POST /redesign/controller/socd — the selected slot's opposite-directions
/// rule, a name off the served roster (`nocturne_form_socd`'s one edit).
pub(super) async fn redesign_form_ctrl_socd(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSocdForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::SetSocd {
                number: form.number,
                socd: form.socd,
            })
            .ok
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

/// POST /redesign/controller/duplicate — the same controller again, next
/// free slot, bindings and rule copied (the shared composition).
pub(super) async fn redesign_form_ctrl_duplicate(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || duplicate_slot_flash(&state, form.number))
        .await
        .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

/// POST /redesign/controller/undo — put the last ✕-removed controller back
/// from THIS page's server-held stash. After the workbench's compaction its
/// old number is usually re-occupied, so the shared core seats it at the
/// next free slot — the arrival law's own answer.
pub(super) async fn redesign_form_ctrl_undo(State(state): State<Arc<AppState>>) -> Response {
    let flash =
        tokio::task::spawn_blocking(move || undo_removal_flash(&state, &state.redesign_undo))
            .await
            .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignBindForm {
    slot: u8,
    function: String,
}

/// POST /redesign/bind/clear — one control back to unbound.
pub(super) async fn redesign_form_bind_clear(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignBindForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash =
        tokio::task::spawn_blocking(move || bind_clear_flash(&state, form.slot, form.function))
            .await
            .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

/// POST /redesign/bind/clear-all — every key unbound on one slot's draft.
pub(super) async fn redesign_form_clear_all(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || clear_all_flash(&state, form.number))
        .await
        .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignBlockingForm {
    blocking: String,
}

/// POST /redesign/blocking — how the staged input's keys behave while Play
/// runs (freeze / split / take nothing), through the shared core. One
/// staged edit in the daemon; nothing saved or started.
pub(super) async fn redesign_form_blocking(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignBlockingForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    redesign_redirect(blocking_write_flash(&state, form.blocking).await)
}

// NO /redesign/board verb, deliberately (Victor, 2026-08-29): the plate
// always draws the standard keyboard on this page — a keyboard looks like a
// keyboard. Alternate pictures (saved panels, drawn boards) stay a 4460
// affair until an "advanced" home earns its place here.

#[derive(Deserialize)]
pub(super) struct RedesignKeyClearForm {
    number: u8,
    key: String,
}

/// POST /redesign/key/clear — take one key away from EVERYTHING it drives
/// on one slot's draft (the Keys tab's row ✕).
pub(super) async fn redesign_form_key_clear(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignKeyClearForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || key_clear_flash(&state, form.number, form.key))
        .await
        .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignTurboForm {
    slot: u8,
    function: String,
    #[serde(default)]
    turbo_hz: Option<String>,
}

/// POST /redesign/bind/turbo — a control's auto-fire rate (0 clears).
pub(super) async fn redesign_form_bind_turbo(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignTurboForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        bind_turbo_flash(&state, form.slot, form.function, form.turbo_hz.as_deref())
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignToggleForm {
    slot: u8,
    function: String,
    mode: String,
}

/// POST /redesign/bind/toggle — the Hold|Toggle pill pair's write.
pub(super) async fn redesign_form_bind_toggle(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignToggleForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        bind_toggle_flash(&state, form.slot, form.function, &form.mode)
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every sentence a handler in THIS module can answer must resolve to
    /// itself through the allowlist — a missing entry silently renders as
    /// the unknown-flash sentence on the no-JS path, which is exactly the
    /// drift this pairing exists to catch. Adding a verb sentence means
    /// adding it in BOTH arrays, and the reviewer sees the pairing.
    #[test]
    fn every_verb_sentence_survives_the_allowlist() {
        for sentence in [
            // theme + device (the first transplants)
            N_THEME_OK,
            N_THEME_UNKNOWN,
            N_DEVICE_OK,
            N_DEVICE_ALREADY_OK,
            // the staging verbs' shared answers
            N_FORM_UNREADABLE,
            N_EDIT_OK,
            N_EDIT_ERROR,
            N_MOVE_AT_END,
            N_ADD_LAYOUT_ERROR,
            // the inspector's re-homed controller verbs
            N_CLEAR_ALL_OK,
            N_UNDO_OK,
            N_UNDO_GONE,
            N_UNDO_FULL,
            N_DUP_OK,
            N_DUP_FULL,
            N_TURBO_OK,
            N_TURBO_INPUT_ERROR,
            N_TURBO_UNBOUND_ERROR,
            N_TOGGLE_OK,
            N_TOGGLE_OLD_DAEMON,
            N_TOGGLE_UNBOUND_ERROR,
            // the Keys tab's row ✕
            N_KEY_CLEAR_OK,
            N_KEY_CLEAR_NONE,
            // the keyboard widget: the While-playing picker
            N_BLOCKING_OK,
        ] {
            assert_eq!(
                redesign_flash_from_query(Some(sentence)).as_deref(),
                Some(sentence),
                "a verb can answer this sentence but the allowlist would \
                 render it as the unknown-flash text"
            );
        }
    }

    fn theme_row(name: &str, chosen: bool) -> crate::snapshot::NocturneChoiceRow {
        crate::snapshot::NocturneChoiceRow {
            name: name.to_owned(),
            chosen,
            ..Default::default()
        }
    }

    #[test]
    fn root_theme_comes_from_the_payloads_chosen_row() {
        let mut payload = RedesignPayload {
            theme_rows: vec![theme_row("system", true), theme_row("matrix", false)],
            ..Default::default()
        };
        assert_eq!(
            theme_from_payload(&payload),
            None,
            "System has no root stamp"
        );

        payload.theme_rows[0].chosen = false;
        payload.theme_rows[1].chosen = true;
        assert_eq!(theme_from_payload(&payload), Some("matrix"));

        for row in &mut payload.theme_rows {
            row.chosen = false;
        }
        assert_eq!(
            theme_from_payload(&payload),
            None,
            "an unreadable setup makes no root-theme claim"
        );
    }
}
