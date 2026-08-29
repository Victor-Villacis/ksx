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

use crate::render::{body_prefix, with_icon_links, EmbeddedPage, PERSONALITY_CSS};
use crate::render_nocturne::{device_row, mode_row, named_slot_ids, other_row};
use crate::snapshot::{
    compose_board_panel, BoardPanel,
    theme_rows, NocturneChoiceRow, RedesignControllers, RedesignDeviceRows, RedesignPayload,
    RedesignPersonaRow, SetupSnapshot,
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

/// Compose the payload from the environment the source reports — the same
/// wording rule the nocturne derived block uses, copied so the two chips can
/// never disagree about what a fixture looks like. `setup` is the same
/// `machine_cache.setup_state` read `page_theme` stamps the page from, so the
/// menu's marked row and the `<html data-theme>` stamp derive from one truth.
pub(crate) fn payload(
    environment: &ksx_api::RuntimeEnvironmentView,
    setup: Option<ksx_api::SetupView>,
    scan: Result<ksx_api::DeviceScanView, String>,
    staged: &ksx_api::StagedSetupView,
    selected_slot: Option<u8>,
    undo_label: Option<&str>,
) -> RedesignPayload {
    // Facts borrowed BEFORE the payload construction consumes their owners:
    // the saved board choice (setup is consumed by the theme rows) and the
    // scan's boards (for the keyboard title's transport word).
    let setup_board = setup.as_ref().map(|s| s.board.clone());
    let scan_boards: &[ksx_api::BoardRow] = match &scan {
        Ok(scan) => scan.boards.as_slice(),
        Err(_) => &[],
    };
    let staged_selector = staged
        .reachable
        .then(|| {
            staged
                .device
                .as_ref()
                .map(|device| device.selector.as_str())
        })
        .flatten();
    let mut devices = match &scan {
        Ok(scan) => RedesignDeviceRows::of(Some(scan), "", staged_selector),
        Err(unavailable) => RedesignDeviceRows::of(None, unavailable, staged_selector),
    };
    // Is the staged input an arcade encoder? The nocturne rule: the staged
    // selector sits in the picker's ENCODER tier. It reword's the capture
    // rows (wired buttons, not typing) and lets the board resolution offer
    // the panel fallbacks.
    let encoder_staged = staged.device.as_ref().is_some_and(|device| {
        devices
            .encoders
            .iter()
            .any(|row| row.selector.eq_ignore_ascii_case(&device.selector))
    });
    let (capture_rows, capture_note) =
        crate::snapshot::compose_capture_rows(staged, encoder_staged);
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
    RedesignPayload {
        environment_label: environment.label.clone(),
        environment_cls: if environment.fixture {
            "n-environment fixture"
        } else if environment.id == "live-machine" {
            "n-environment live"
        } else {
            "n-environment unknown"
        }
        .to_owned(),
        // The picker's truth. `Err` carries the refusal's sentence (with its
        // remedy — the `/devices` composition), so a refused read renders as
        // one line over an empty picker, never as an empty machine.
        devices,
        // The composition `/nocturne` performs (snapshot.rs), copied verbatim:
        // the ONE shared `theme_rows` composer, re-dressed as choice rows, so
        // the redesign menu and the nocturne picker can never mark different
        // rows for the same config.
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
        controllers: RedesignControllers::of(staged, selected_slot, undo_label),
        // The keyboard widget, off the ONE shared board composer. The board
        // choice honours the saved config; the panel/drawn stores are not
        // collected on this page yet (they arrive with the panel migration),
        // so their rosters are empty and their errors silent — the standard
        // keyboard and any `panel:`/`board:` choice degrade exactly like
        // nocturne with empty stores.
        board: {
            let selected = selected_slot
                .and_then(|number| staged.slots.iter().find(|slot| slot.number == number))
                .or_else(|| staged.slots.first());
            let chosen_board = setup_board.as_deref().unwrap_or_default();
            let resolved =
                crate::board::Board::resolve(chosen_board, &[], &[], encoder_staged);
            let transport = staged.device.as_ref().and_then(|d| {
                scan_boards
                    .iter()
                    .find(|b| b.selector.as_deref() == Some(d.selector.as_str()))
                    .map(|b| b.transport_label.as_str())
            });
            compose_board_panel(
                staged,
                selected,
                &resolved,
                chosen_board,
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
    }
}

/// The served lists this page renders: the topbar theme menu's rows and the
/// device picker's four tiers. The name convention is the compiler's, proven
/// on `/nocturne` (`LIST_SLOT_THEMES` in render_nocturne.rs).
const LIST_SLOT_THEME_ROWS: &str = "list:rdThemeRows:array";
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
const LIST_SLOT_BOARD_ROWS: &str = "list:rdBoardRows:array";
const LIST_SLOT_CAPTURE_ROWS: &str = "list:rdCaptureRows:array";

/// One plate cell, every field spelled once (the nocturne row's shape).
fn kb_cell(row: &crate::snapshot::NocturneKeyCell) -> SlotValue {
    SlotValue::object(vec![
        ("cap".to_owned(), SlotValue::Text(row.cap.clone())),
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("short".to_owned(), SlotValue::Text(row.short.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("aria".to_owned(), SlotValue::Text(row.aria.clone())),
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
        "rdEnvLabel": payload.environment_label,
        "rdEnvCls": payload.environment_cls,
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
        // The removal-undo chip: SSR chrome (a reload keeps the offer while
        // the server-held window lasts — the nocturne chip's contract).
        "rdUndoCls": payload.controllers.undo_cls,
        "rdUndoLabel": payload.controllers.undo_label,
        // The keyboard widget's chrome — every word the plate wears.
        "rdKbTitle": payload.board.kb_title,
        "rdKbCls": payload.board.kb_cls,
        "rdBoardCaseStyle": payload.board.board_case_style,
        "rdBoardOrigin": payload.board.board_origin,
        "rdBoardLine": payload.board.board_line,
        "rdKbTrayHead": payload.board.kb_tray_head,
        "rdKbTrayCls": payload.board.kb_tray_cls,
        "rdKbNote": payload.board.kb_note,
        "rdKbMoreCls": payload.board.kb_more_cls,
        "rdSoloLbl": payload.board.solo_label,
        "rdCaptureNote": payload.capture_note,
    })
}

/// Populate every server-injected slot: the scalars, plus the theme-rows
/// list. Further lists and shows join as the transplants arrive.
fn build_slots(module: &IrModule, payload: &RedesignPayload, flash: Option<&str>) -> SlotData {
    let scalars = scalar_slots(payload, flash).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    if let Some(id) = named_slot_ids(module, LIST_SLOT_THEME_ROWS)
        .into_iter()
        .next()
    {
        slots.set(
            id,
            SlotValue::array(payload.theme_rows.iter().map(mode_row).collect()),
        );
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
            LIST_SLOT_BOARD_ROWS,
            SlotValue::array(board.board_rows.iter().map(board_choice_row).collect()),
        ),
        (
            LIST_SLOT_CAPTURE_ROWS,
            SlotValue::array(payload.capture_rows.iter().map(board_choice_row).collect()),
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
    let prefix = body_prefix(payload, "/redesign");
    with_icon_links(render_page(&PageConfig {
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
    }))
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
        payload(
            &ksx_api::RuntimeEnvironmentView {
                fixture: true,
                id: "seeded-demo".into(),
                label: "Fixture · Seeded demo".into(),
                detail: "Synthetic data for the redesign lane.".into(),
                generation: "test".into(),
            },
            // A readable config with no stamp: System is the one marked row.
            Some(ksx_api::SetupView::default()),
            Ok(fixture_scan()),
            // Nothing staged, authoritatively: every device row serves
            // aria_current "false" and the workbench mounts no cards — but
            // the picker still offers the roster over served ceilings.
            &fixture_staged(Vec::new()),
            None,
            None,
        )
    }

    /// A staged view with real ceilings, the two-persona roster, and the
    /// given slots — the shape `StagedSetupView::of` serves, condensed.
    fn fixture_staged(slots: Vec<ksx_api::StagedSlotView>) -> ksx_api::StagedSetupView {
        let xinput_used = slots.iter().filter(|slot| slot.is_xinput).count();
        let full = slots.len() >= 16;
        ksx_api::StagedSetupView {
            reachable: true,
            empty: slots.is_empty(),
            next_slot: if full { None } else { Some(slots.len() as u8 + 1) },
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

    fn fixture_slot(number: u8, persona: &str, is_xinput: bool, preset: &str) -> ksx_api::StagedSlotView {
        ksx_api::StagedSlotView {
            number,
            persona: persona.into(),
            persona_label: format!("{persona} label"),
            is_xinput,
            preset: preset.into(),
            ..Default::default()
        }
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
        let defaulted = RedesignControllers::of(&staged, None, None);
        assert_eq!(defaulted.panel.slot_val, "1", "no ?slot → the first slot");
        assert_eq!(defaulted.panel.pad_badge, "P1");
        assert_eq!(defaulted.panel.pad_badge_cls, "n-pbadge np1");
        let chosen = RedesignControllers::of(&staged, Some(2), None);
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
        let chip = RedesignControllers::of(&staged, Some(2), Some("P9 (X) removed"));
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
        let view = RedesignControllers::of(&staged, None, None);
        assert_eq!(view.cards.len(), 3);
        assert_eq!(
            view.cards.iter().map(|c| c.number.as_str()).collect::<Vec<_>>(),
            ["1", "2", "3"],
            "cards ride the daemon's slot order — numbers arrive with the slots"
        );
        assert!(view.cards[0].api_line.contains("XInput"));
        assert!(view.cards[1].api_line.contains("no XInput slot"));
        assert_eq!(
            view.counts_line, "3 of 16 slots staged · 2 of 4 Xbox (XInput)",
            "every number in the counts line is the daemon's"
        );
        assert_eq!(view.add_preset, "Player 4", "the next preset is served — it becomes a file name");
        assert_eq!(view.add_layout, "keyboard-2p");
        assert!(view.add_note.contains("nothing is saved or started"), "{}", view.add_note);
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
            ("a-persona-from-the-future", "unknown", "/_assets/pad-xbox.svg"),
        ] {
            let one = RedesignControllers::of(&fixture_staged(vec![fixture_slot(
                1, persona, false, "P",
            )]), None, None);
            assert_eq!(one.cards[0].family, family, "{persona}");
            assert_eq!(one.cards[0].art, art, "{persona}");
        }

        // A full house says the nocturne sentence and offers no preset.
        let full = fixture_staged(
            (1..=16)
                .map(|n| fixture_slot(n, "playstation", false, "P"))
                .collect(),
        );
        let full_view = RedesignControllers::of(&full, None, None);
        assert_eq!(full_view.add_preset, "");
        assert!(
            full_view.add_note.contains("Every controller slot is staged"),
            "{}",
            full_view.add_note
        );

        // Unreachable: the roster stays listed, disabled, with the reason.
        let mut dead = fixture_staged(Vec::new());
        dead.reachable = false;
        dead.error = Some("the daemon pipe is closed".into());
        let dead_view = RedesignControllers::of(&dead, None, None);
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
        assert!(html.contains("rd-ctrlmodal"), "the modal shell is served");
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

    #[test]
    fn unreachable_staging_is_disabled_with_authored_copy_not_a_raw_diagnostic() {
        let raw = "named pipe \\.\\pipe\\ksx-control refused with os error 231";
        let staged = ksx_api::StagedSetupView::unreachable(raw);
        let payload = payload(
            &ksx_api::RuntimeEnvironmentView {
                fixture: true,
                id: "seeded-demo".into(),
                label: "Fixture · Seeded demo".into(),
                detail: "Synthetic data for the redesign lane.".into(),
                generation: "test".into(),
            },
            Some(ksx_api::SetupView::default()),
            Ok(fixture_scan()),
            &staged,
            None,
            None,
        );
        assert!(!payload.devices.staging_reachable);
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
        assert!(html.contains("rd-devmodal"), "the modal shell is served");
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
    }

    #[test]
    fn the_redesign_head_is_complete() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        assert_complete_head(
            "/redesign",
            &render_redesign(&page, &fixture_payload(), None).html,
        );
    }

    /// **The theme menu offers every theme, and every row is PAINTED.** The
    /// nocturne picker's own regression, applied here the day the rows were
    /// transplanted: between "the verb round-trips" and "the action string
    /// appears" once sat a picker whose unchosen rows a stale `pill-none`
    /// rule hid, so whatever theme you were on was the only one you could
    /// see (`snapshot.rs` `theme_rows` carries the full story). The class
    /// vocabulary asserted here is the surviving one — `n-radio`, never
    /// `pill` — and exactly one row may claim to be current.
    #[test]
    fn redesign_paints_every_theme_row_not_only_the_current_one() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        let html = render_redesign(&page, &fixture_payload(), None).html;
        // Isolate each theme form's own bytes so an assertion about "a theme
        // row" cannot be satisfied by markup elsewhere on the page.
        let forms: Vec<&str> = html
            .match_indices(r#"action="/redesign/theme""#)
            .map(|(start, _)| {
                let rest = &html[start..];
                let end = rest.find("</form>").expect("a theme form to close");
                &rest[..end]
            })
            .collect();
        // System + every theme in the generated roster. Composed in
        // `snapshot::theme_rows`, so shipping a theme adds a row here for
        // free — and adds it to this count.
        let expected = 1 + crate::theme_tokens::THEMES.len();
        assert_eq!(
            forms.len(),
            expected,
            "the theme menu serves {} forms, not the {expected} the roster has",
            forms.len(),
        );
        for want in
            std::iter::once("system").chain(crate::theme_tokens::THEMES.iter().map(|t| t.id))
        {
            let hidden = format!(r#"name="theme" value="{want}""#);
            assert!(
                forms.iter().any(|form| form.contains(&hidden)),
                "no theme form posts {want:?}",
            );
        }
        for form in &forms {
            assert!(
                !form.contains("pill"),
                "a theme row's submit button carries a `pill` class; that \
                 vocabulary hides rows (see snapshot.rs theme_rows): {form}",
            );
            assert!(
                form.contains("n-radio"),
                "a theme row's submit button is not an `n-radio`; only \
                 `.n-modeform button.n-radio` is laid out at all: {form}",
            );
        }
        let marked = forms
            .iter()
            .filter(|form| form.contains("n-radio on"))
            .count();
        assert_eq!(marked, 1, "{marked} theme rows claim to be the current one");
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
        assert_eq!(parsed, fixture_payload());
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
            "rdEnvLabel",
            "rdEnvCls",
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
            "rdBoardLine",
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
            "rdBoardRows",
            "rdCaptureRows",
        ] {
            assert!(
                REDESIGN_ISLAND_TS.contains(&format!("const [{signal}, ")),
                "RedesignIsland.ts no longer declares the '{signal}' list signal the seam fills"
            );
        }
    }
}
