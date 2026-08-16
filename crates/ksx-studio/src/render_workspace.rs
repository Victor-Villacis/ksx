//! The /workspace render seam: embedded FMIR + one [`WorkspacePayload`] →
//! HTML — the M0 skeleton of the Nocturne workspace.
//!
//! Same four-part slot seam as [`crate::render`] — scalars, shows, (no lists
//! yet), and the layout test that pins them — so read `render.rs`'s module
//! docs for the protocol. What is worth writing down here is what this page
//! is FOR.
//!
//! # The destination, and why the frame lands first
//!
//! The v0.5 redesign collapses `/start` (the staged draft), `/map` (the
//! mapper) and `/` (status + play) into one three-pane workspace: keyboard +
//! player rack on the left, the controller and keyboard diagrams in the
//! center, the binding list on the right, session controls in the title bar.
//! That page will carry more slots than any current screen, so the route, the
//! payload, the seam and every gate (slot contract, payload parity, visual
//! smoke, hydration parity) exist FIRST, at skeleton size, where their shape
//! can be reviewed — instead of arriving in the same change as a thousand
//! lines of panes.
//!
//! # Every sentence is composed once, in Rust
//!
//! The whole displayed surface of this page is [`WorkspaceDerived`]
//! (snapshot.rs): strings and booleans computed from the staged view and the
//! session, injected as slots here and copied — never re-derived — by
//! `WorkspaceIsland.ts`. That is the `ProfilesDerived` rule, adopted from the
//! start so the page this grows into never accumulates a second derivation to
//! keep in step (docs/SURFACES.md §1; the parity suite is the gate).

use forma_ir::parser::IrModule;
use forma_ir::slot::{SlotData, SlotValue};
use forma_server::{render_page, PageConfig, PageOutput, RenderMode};

use crate::render::{body_prefix, with_icon_links, EmbeddedPage, PERSONALITY_CSS};
use crate::snapshot::{WorkspaceChoiceRow, WorkspaceOptionRow, WorkspacePayload, WorkspaceSlotRow};

/// The island table this page compiles to: exactly one island — the whole
/// screen. Its name is the `activateIslands` registry key in
/// `studio-ui/src/workspace.ts`.
#[cfg(test)]
const ISLAND_COMPONENT: &str = "WorkspaceIsland";

/// How many `createShow` pairs this page has; the layout test pins both the
/// count and every name.
const SHOW_COUNT: usize = 13;

/// `() => wsRackRows()` compiles to `list:wsRackRows:array`. Rename a list
/// signal in WorkspaceIsland.ts and the layout test fails by name here.
const LIST_SLOT_RACK: &str = "list:wsRackRows:array";
const LIST_SLOT_BLOCKING: &str = "list:wsBlockingRows:array";
const LIST_SLOT_SOCD_SLOTS: &str = "list:wsSocdSlotOptions:array";
const LIST_SLOT_SOCD_POLICIES: &str = "list:wsSocdPolicyOptions:array";
const LIST_SLOT_ADD_PERSONAS: &str = "list:wsAddPersonaOptions:array";
const LIST_SLOT_ADD_LAYOUTS: &str = "list:wsAddLayoutOptions:array";

/// Bare-named slots this page renders and the seam deliberately never fills.
/// EMPTY, and that is the claim.
#[cfg(test)]
const CLIENT_ONLY_SLOTS: [&str; 0] = [];

/// Anonymous (`attr:`/`text:`) slots this page compiles to. EMPTY — every
/// attribute value and every text child is either a named signal binding or
/// static markup.
#[cfg(test)]
const ANONYMOUS_SLOTS: [&str; 0] = [];

/// Scalar slot values, keyed by the signal names in WorkspaceIsland.ts.
/// Every value is a [`WorkspaceDerived`] field except the flash — the one
/// SSR-only slot, filled from the allowlisted query parameter and never from
/// the payload (a poll is not an action).
fn scalar_slots(payload: &WorkspacePayload, flash: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "wsStateDetail": payload.view.state_detail,
        "wsDeviceLine": payload.view.device_line,
        "wsDeviceMeta": payload.view.device_meta,
        "wsRackLine": payload.view.rack_line,
        "wsRackCaption": payload.view.rack_caption,
        "wsBlockingLine": payload.view.blocking_line,
        "wsDirtyLine": payload.view.dirty_line,
        "wsAddPreset": payload.view.add_preset,
        "wsAddFullLine": payload.view.add_full_line,
        "wsPadCaption": payload.view.pad_caption,
        "wsFlashLine": flash.map(|f| f.trim_start_matches("error: ")).unwrap_or(""),
    })
}

/// Every show slot on this page, BY NAME. The three pills are exclusive by
/// construction in [`crate::snapshot::WorkspaceDerived`]; this function maps
/// names, it decides nothing — except the flash split, which keys off the
/// allowlisted copy's own `error:` prefix exactly as `/start`'s does.
fn show_values(
    payload: &WorkspacePayload,
    flash: Option<&str>,
) -> [(&'static str, bool); SHOW_COUNT] {
    let flash_err = flash.is_some_and(|f| f.starts_with("error"));
    [
        ("show:wsPillRunning", payload.view.pill_running),
        ("show:wsPillIdle", payload.view.pill_idle),
        ("show:wsPillDown", payload.view.pill_down),
        ("show:wsStageReady", payload.view.stage_ready),
        ("show:wsStageEmpty", payload.view.stage_empty),
        ("show:wsHasDevice", payload.view.has_device),
        ("show:wsShowDirty", payload.view.show_dirty),
        ("show:wsCanAdd", payload.view.can_add),
        ("show:wsAddFull", payload.view.add_full),
        ("show:wsPadXbox", payload.view.pad_xbox),
        ("show:wsPadPs", payload.view.pad_ps),
        ("show:wsFlashOk", flash.is_some() && !flash_err),
        ("show:wsFlashError", flash_err),
    ]
}

fn rack_row(row: &WorkspaceSlotRow) -> SlotValue {
    SlotValue::object(vec![
        ("number".to_owned(), SlotValue::Text(row.number.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        (
            "socd_note".to_owned(),
            SlotValue::Text(row.socd_note.clone()),
        ),
        ("up_order".to_owned(), SlotValue::Text(row.up_order.clone())),
        (
            "down_order".to_owned(),
            SlotValue::Text(row.down_order.clone()),
        ),
    ])
}

fn choice_row(row: &WorkspaceChoiceRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        ("row_cls".to_owned(), SlotValue::Text(row.row_cls.clone())),
        ("button".to_owned(), SlotValue::Text(row.button.clone())),
    ])
}

fn option_row(row: &WorkspaceOptionRow) -> SlotValue {
    SlotValue::object(vec![
        ("value".to_owned(), SlotValue::Text(row.value.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
    ])
}

fn list_values(payload: &WorkspacePayload) -> [(&'static str, SlotValue); 6] {
    let view = &payload.view;
    [
        (
            LIST_SLOT_RACK,
            SlotValue::array(view.rack.iter().map(rack_row).collect()),
        ),
        (
            LIST_SLOT_BLOCKING,
            SlotValue::array(view.blocking.iter().map(choice_row).collect()),
        ),
        (
            LIST_SLOT_SOCD_SLOTS,
            SlotValue::array(view.socd_slots.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_SOCD_POLICIES,
            SlotValue::array(view.socd_policies.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_ADD_PERSONAS,
            SlotValue::array(view.add_personas.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_ADD_LAYOUTS,
            SlotValue::array(view.add_layouts.iter().map(option_row).collect()),
        ),
    ]
}

/// Slot ids of every slot named `name`, in slot-table (== document) order.
fn named_slot_ids(module: &IrModule, name: &str) -> Vec<u16> {
    module
        .slots
        .entries()
        .iter()
        .filter(|e| module.strings.get(e.name_str_idx).is_ok_and(|n| n == name))
        .map(|e| e.slot_id)
        .collect()
}

/// Populate every server-injected slot.
fn build_slots(module: &IrModule, payload: &WorkspacePayload, flash: Option<&str>) -> SlotData {
    let scalars = scalar_slots(payload, flash).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    for (name, value) in show_values(payload, flash) {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(id, SlotValue::Bool(value));
        }
    }
    for (name, value) in list_values(payload) {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(id, value);
        }
    }
    slots
}

/// Render /workspace for one payload: SSR slots for first paint, the same
/// data as island props for hydration. Callers pass a payload built by
/// `server/workspace.rs`'s one collector, which has already called
/// [`WorkspacePayload::derived`] — and a flash that has already been through
/// the allowlist (`server/workspace.rs::workspace_flash_from_query`).
pub(crate) fn render_workspace(
    page: &EmbeddedPage,
    payload: &WorkspacePayload,
    flash: Option<&str>,
) -> PageOutput {
    let slots = build_slots(&page.module, payload, flash);
    let prefix = body_prefix(payload, "/workspace");
    with_icon_links(render_page(&PageConfig {
        title: "ksx Studio — workspace",
        route_pattern: "/workspace",
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
    use crate::control::SessionView;
    use crate::render::assert_complete_head;

    /// The island and entry sources, compiled IN so the cross-language guards
    /// below cannot silently stop reading anything: move or rename the file
    /// and this crate fails to build.
    const WORKSPACE_ISLAND_TS: &str = include_str!("../../../studio-ui/src/WorkspaceIsland.ts");
    const WORKSPACE_TS: &str = include_str!("../../../studio-ui/src/workspace.ts");

    /// The rendered document with the `__ksx-payload` data block removed, so
    /// content assertions read what a READER sees rather than matching the
    /// embedded JSON. See render_check.rs's note.
    fn rendered(html: &str) -> String {
        let Some(start) = html.find("<script id=\"__ksx-payload\"") else {
            return html.to_owned();
        };
        let end = html[start..]
            .find("</script>")
            .map_or(html.len(), |at| start + at + "</script>".len());
        format!("{}{}", &html[..start], &html[end..])
    }

    fn idle_session() -> SessionView {
        SessionView {
            reachable: true,
            running: false,
            line: "idle — daemon reachable".into(),
            profile: None,
            origin: ksx_api::SessionOrigin::Unknown,
            active: None,
        }
    }

    fn staged_draft() -> ksx_api::StagedSetupView {
        ksx_api::StagedSetupView {
            reachable: true,
            empty: false,
            device: Some(ksx_api::StagedDeviceView {
                label: "Ultimarc I-PAC 4".into(),
                alias: "panel".into(),
                selector: "usb:d209:0430:00".into(),
                rung: "model".into(),
                survives_replug: true,
                backend: "interception".into(),
            }),
            slots: vec![
                ksx_api::StagedSlotView {
                    number: 1,
                    persona: "xbox360".into(),
                    persona_label: "Xbox 360".into(),
                    is_xinput: true,
                    preset: "Player 1".into(),
                    authoring: None,
                    bindings: 12,
                    ..Default::default()
                },
                ksx_api::StagedSlotView {
                    number: 2,
                    persona: "playstation".into(),
                    persona_label: "PlayStation".into(),
                    is_xinput: false,
                    preset: "Player 2".into(),
                    authoring: None,
                    bindings: 12,
                    ..Default::default()
                },
            ],
            // The served rosters and ceilings a live daemon always carries —
            // the fixture carries them too, so the pane's forms and captions
            // render (and screenshot) as they will in production.
            xinput_used: 1,
            max_slots: ksx_core::MAX_SLOTS,
            max_xinput_slots: ksx_core::MAX_XINPUT_SLOTS,
            socd_options: ksx_api::SocdOption::roster(),
            blocking_options: ksx_api::BlockingOption::roster(),
            blocking: Some("bound-keys".into()),
            ..ksx_api::StagedSetupView::default()
        }
    }

    fn cabinet() -> WorkspacePayload {
        WorkspacePayload {
            staged: staged_draft(),
            session: idle_session(),
            view: Default::default(),
        }
        .derived()
    }

    #[test]
    fn embedded_page_loads_and_ir_is_fmir_v2() {
        let page = EmbeddedPage::load("/workspace").expect("the /workspace route is embedded");
        assert_eq!(page.module.header.version, 2);
    }

    #[test]
    fn the_workspace_head_is_complete() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        assert_complete_head(
            "/workspace",
            &render_workspace(&page, &cabinet(), None).html,
        );
    }

    /// The draft renders as facts: the board's LABEL, the slot count.
    #[test]
    fn the_frame_renders_the_draft_it_was_given() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &cabinet(), None).html);
        assert!(html.contains("Ultimarc I-PAC 4"), "{html}");
        assert!(html.contains("2 controllers staged."), "{html}");
        assert!(html.contains("Ready to play."), "{html}");
    }

    /// The rack renders each controller as a row with its composed facts —
    /// and each row's Move buttons carry the WHOLE precomposed order, because
    /// the daemon's reorder verb takes the whole order and this page must not
    /// derive slot order a second time.
    #[test]
    fn the_rack_renders_rows_with_precomposed_move_orders() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let mut payload = cabinet();
        payload.staged.slots[1].socd = "last-input".into();
        payload.staged.slots[1].socd_label = "Last press wins".into();
        let payload = WorkspacePayload {
            view: Default::default(),
            ..payload
        }
        .derived();
        let html = rendered(&render_workspace(&page, &payload, None).html);
        assert!(html.contains("P1 · Xbox 360"), "{html}");
        assert!(html.contains("P2 · PlayStation"), "{html}");
        assert!(html.contains("\"Player 1\" · 12 controls"), "{html}");
        // P2's policy is narrated; P1's off default is not.
        assert!(html.contains("Opposites: Last press wins"), "{html}");
        // P1 moves down by submitting "2 1"; its up-order is the honest empty.
        assert!(html.contains(r#"value="2 1""#), "{html}");
        assert!(html.contains("/workspace/controller/move"), "{html}");
        assert!(html.contains("/workspace/controller/remove"), "{html}");
        // The served ceilings, never hardcoded ones.
        let caption = &payload.view.rack_caption;
        assert_eq!(caption, "2 of 16 controllers · 1 of 4 Xbox seats used.");
        assert!(html.contains(caption.as_str()), "{html}");
    }

    /// The capture answer marks exactly the chosen row, and the current
    /// answer's button never invites a no-op write.
    #[test]
    fn the_capture_answer_marks_the_chosen_row() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let mut payload = cabinet();
        payload.staged.blocking = Some("bound-keys".into());
        payload.staged.blocking_options = ksx_api::BlockingOption::roster();
        let payload = WorkspacePayload {
            view: Default::default(),
            ..payload
        }
        .derived();
        let chosen: Vec<&str> = payload
            .view
            .blocking
            .iter()
            .filter(|row| row.row_cls.contains("on"))
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(chosen, ["bound-keys"]);
        let html = rendered(&render_workspace(&page, &payload, None).html);
        assert!(html.contains("This is how it is set"), "{html}");
        assert!(html.contains("/workspace/blocking"), "{html}");

        // Unanswered: no row marked, and the line says Play needs an answer.
        let mut fresh = cabinet();
        fresh.staged.blocking = None;
        fresh.staged.blocking_options = ksx_api::BlockingOption::roster();
        let fresh = WorkspacePayload {
            view: Default::default(),
            ..fresh
        }
        .derived();
        assert!(fresh
            .view
            .blocking
            .iter()
            .all(|r| !r.row_cls.contains("on")));
        assert!(fresh.view.blocking_line.contains("Not answered yet"));
    }

    /// A dirty draft says so — and a clean one says nothing, because narrating
    /// "no unsaved changes" on every visit is noise.
    #[test]
    fn the_dirty_note_appears_exactly_when_the_draft_is_dirty() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let mut payload = cabinet();
        payload.staged.dirty = true;
        let dirty = WorkspacePayload {
            view: Default::default(),
            ..payload
        }
        .derived();
        assert!(dirty.view.show_dirty);
        let html = rendered(&render_workspace(&page, &dirty, None).html);
        assert!(html.contains("Unsaved changes"), "{html}");

        let clean = cabinet();
        assert!(!clean.view.show_dirty);
        assert!(clean.view.dirty_line.is_empty());
    }

    /// An EMPTY draft offers both roads in — guided setup, and adopting the
    /// saved configuration — while a populated one offers neither.
    #[test]
    fn an_empty_draft_offers_setup_and_adoption() {
        let empty = WorkspacePayload {
            staged: ksx_api::StagedSetupView {
                reachable: true,
                empty: true,
                ..ksx_api::StagedSetupView::default()
            },
            session: idle_session(),
            view: Default::default(),
        }
        .derived();
        assert!(empty.view.stage_empty && !empty.view.stage_ready);
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &empty, None).html);
        assert!(html.contains("/workspace/adopt"), "{html}");
        assert!(html.contains("Show the saved setup here"), "{html}");

        assert!(cabinet().view.stage_ready && !cabinet().view.stage_empty);
    }

    /// The flash renders with its `error:` prefix STRIPPED (the prefix is the
    /// classifier's, not the reader's) and the right show slot lit.
    #[test]
    fn the_flash_splits_on_its_own_error_prefix() {
        let ok_shows: std::collections::BTreeMap<&str, bool> =
            show_values(&cabinet(), Some("Draft updated."))
                .into_iter()
                .collect();
        assert!(ok_shows["show:wsFlashOk"]);
        assert!(!ok_shows["show:wsFlashError"]);
        let err_shows: std::collections::BTreeMap<&str, bool> =
            show_values(&cabinet(), Some("error: nope"))
                .into_iter()
                .collect();
        assert!(!err_shows["show:wsFlashOk"]);
        assert!(err_shows["show:wsFlashError"]);
        let scalars = scalar_slots(&cabinet(), Some("error: The draft could not be updated."));
        assert_eq!(
            scalars["wsFlashLine"], "The draft could not be updated.",
            "the classifier prefix is not customer copy"
        );
    }

    /// Exactly one state pill renders, whatever the session says — a header
    /// that shows two states, or none, is lying about one of them.
    #[test]
    fn exactly_one_state_pill_renders() {
        for (session, expected) in [
            (idle_session(), "show:wsPillIdle"),
            (
                SessionView {
                    running: true,
                    line: "running — 2 pad(s)".into(),
                    ..idle_session()
                },
                "show:wsPillRunning",
            ),
            (SessionView::unreachable("test"), "show:wsPillDown"),
        ] {
            let payload = WorkspacePayload {
                staged: staged_draft(),
                session,
                view: Default::default(),
            }
            .derived();
            let values: std::collections::BTreeMap<&str, bool> =
                show_values(&payload, None).into_iter().collect();
            let lit = values
                .iter()
                .filter(|(name, on)| name.starts_with("show:wsPill") && **on)
                .count();
            assert_eq!(lit, 1, "exactly one pill: {values:?}");
            assert!(
                values.get(expected).copied().unwrap_or(false),
                "expected {expected}: {values:?}"
            );
        }
    }

    /// **A failed read is not an absence** (docs/SURFACES.md §1b): an
    /// unreachable draft must say so, and must never borrow the empty-draft
    /// advice — "No keyboard chosen yet" tells a user to go choose one, which
    /// is the wrong advice when the truth is "nothing answered".
    #[test]
    fn an_unreachable_draft_never_renders_as_an_empty_one() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let unreachable = WorkspacePayload {
            staged: ksx_api::StagedSetupView::unreachable("no daemon in this test"),
            session: SessionView::unreachable("no daemon in this test"),
            view: Default::default(),
        }
        .derived();
        let html = rendered(&render_workspace(&page, &unreachable, None).html);
        assert!(html.contains("The draft could not be read."), "{html}");
        assert!(!html.contains("No keyboard chosen yet."), "{html}");
        assert!(!html.contains("No controllers staged yet."), "{html}");

        let fresh = WorkspacePayload {
            staged: ksx_api::StagedSetupView {
                reachable: true,
                empty: true,
                ..ksx_api::StagedSetupView::default()
            },
            session: idle_session(),
            view: Default::default(),
        }
        .derived();
        let fresh_html = rendered(&render_workspace(&page, &fresh, None).html);
        assert!(
            fresh_html.contains("No keyboard chosen yet."),
            "{fresh_html}"
        );
        assert!(
            fresh_html.contains("No controllers staged yet."),
            "{fresh_html}"
        );
        assert_ne!(html, fresh_html);
    }

    /// The transition period stays honest: the page says what is still being
    /// built and where the working surfaces are.
    #[test]
    fn the_skeleton_names_itself_and_points_at_the_working_surfaces() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &cabinet(), None).html);
        assert!(html.contains("workspace preview"), "{html}");
        assert!(
            html.contains("binding surface is being built here"),
            "{html}"
        );
        assert!(html.contains(r#"href="/start""#), "{html}");
        assert!(html.contains(r#"href="/map""#), "{html}");
    }

    /// The stage shows each family's OWN controller: the first slot decides,
    /// exactly one of the pair renders, and the words on the art follow the
    /// family (LB/RB vs L1/L2, letters vs shapes). The caption stays the
    /// accessible summary; it needs no vocabulary caveat any more because the
    /// art and the words already agree.
    #[test]
    fn the_stage_shows_the_first_controllers_own_family() {
        let cabinet = cabinet();
        assert_eq!(
            cabinet.view.pad_caption,
            "P1 · Xbox 360 — \"Player 1\", 12 controls bound."
        );
        assert!(cabinet.view.pad_xbox && !cabinet.view.pad_ps);
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &cabinet, None).html);
        assert!(html.contains(r#"class="wspad""#), "{html}");
        assert!(html.contains(r#"aria-hidden="true""#), "{html}");
        assert!(html.contains(">LB<") && html.contains(">RT<"), "{html}");

        // A PlayStation pad first: the DualShock renders — touchpad, petals,
        // shape glyphs, L1/L2 — and the Xbox outline does not.
        let mut flipped = cabinet.clone();
        flipped.staged.slots.reverse();
        flipped.staged.slots[0].number = 1;
        let flipped = WorkspacePayload {
            view: Default::default(),
            ..flipped
        }
        .derived();
        assert!(flipped.view.pad_ps && !flipped.view.pad_xbox);
        assert!(
            !flipped.view.pad_caption.contains("generic gamepad outline"),
            "the caveat retired with the generic outline: {}",
            flipped.view.pad_caption
        );
        let ps_html = rendered(&render_workspace(&page, &flipped, None).html);
        assert!(
            ps_html.contains(">L1<") && ps_html.contains(">R2<"),
            "{ps_html}"
        );
        assert!(ps_html.contains("wspad-touch"), "{ps_html}");
        assert!(ps_html.contains("wspad-glyph"), "{ps_html}");
        assert!(!ps_html.contains(">LB<"), "{ps_html}");

        // An EMPTY draft still stages a controller outline — the generic
        // default is the Xbox one, and the caption honestly says nothing.
        let empty = WorkspacePayload {
            staged: ksx_api::StagedSetupView {
                reachable: true,
                empty: true,
                ..ksx_api::StagedSetupView::default()
            },
            session: idle_session(),
            view: Default::default(),
        }
        .derived();
        assert!(empty.view.pad_xbox && !empty.view.pad_ps);
        assert!(empty.view.pad_caption.is_empty());
    }

    /// The entry seeds signals from the payload block BEFORE building the
    /// island, and polls the same shape — the two source-level facts a Rust
    /// test can check about the other language (the pattern every entry
    /// follows; docs/FORMA-DOGFOOD.md #5).
    #[test]
    fn the_entry_seeds_before_building_and_polls_the_same_shape() {
        assert!(
            WORKSPACE_TS.contains("\"/api/workspace\""),
            "the poller must read the one payload endpoint"
        );
        let seed_at = WORKSPACE_TS
            .find("applyWorkspace(seed)")
            .expect("the entry seeds from the embedded payload");
        let build_at = WORKSPACE_TS
            .find("return WorkspaceIsland()")
            .expect("the entry returns the island");
        assert!(
            seed_at < build_at,
            "signals must hold the server's values BEFORE the tree is built"
        );
        assert!(
            WORKSPACE_ISLAND_TS.contains("p.view.state_detail"),
            "the island copies the derived view rather than deriving"
        );
    }

    /// The slot-table contract this seam depends on, both directions. Read
    /// [`crate::render::assert_island_slot_contract`] before touching this —
    /// "the slot exists" is not the check.
    #[test]
    fn embedded_ir_slot_layout_matches_the_seam() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let module = page.module();
        let names: Vec<&str> = module
            .slots
            .entries()
            .iter()
            .filter_map(|e| module.strings.get(e.name_str_idx).ok())
            .collect();

        let scalars = scalar_slots(&WorkspacePayload::default(), None);
        for key in scalars.as_object().unwrap().keys() {
            assert!(
                names.contains(&key.as_str()),
                "scalar slot '{key}' missing from the embedded IR; slots: {names:?}"
            );
        }
        let ir_lists: std::collections::BTreeSet<&str> = names
            .iter()
            .copied()
            .filter(|n| n.starts_with("list:") && n.ends_with(":array"))
            .collect();
        let seam_lists: std::collections::BTreeSet<&str> =
            list_values(&WorkspacePayload::default())
                .into_iter()
                .map(|(name, _)| name)
                .collect();
        assert_eq!(
            ir_lists, seam_lists,
            "list slots drifted between WorkspaceIsland.ts and list_values()"
        );
        let ir_shows: std::collections::BTreeSet<&str> = names
            .iter()
            .copied()
            .filter(|n| n.starts_with("show:"))
            .collect();
        let seam_shows: std::collections::BTreeSet<&str> =
            show_values(&WorkspacePayload::default(), None)
                .into_iter()
                .map(|(name, _)| name)
                .collect();
        assert_eq!(
            ir_shows, seam_shows,
            "show slots drifted between WorkspaceIsland.ts and show_values()"
        );
        assert_eq!(
            ir_shows.len(),
            SHOW_COUNT,
            "SHOW_COUNT is stale; slots: {names:?}"
        );
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
            .chain(seam_shows.iter().copied())
            .chain(seam_lists.iter().copied())
            .collect();
        crate::render::assert_island_slot_contract(
            module,
            &injected,
            &CLIENT_ONLY_SLOTS,
            &ANONYMOUS_SLOTS,
        );
    }

    /// The payload the page embeds is the payload `/api/workspace` serves —
    /// one struct, one serializer, so the poller cannot disagree with the
    /// paint.
    #[test]
    fn the_payload_block_matches_the_api_payload_shape() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = render_workspace(&page, &cabinet(), None).html;
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
        let parsed: WorkspacePayload =
            serde_json::from_str(body).expect("the embedded block IS a WorkspacePayload");
        assert_eq!(parsed, cabinet());
    }
}
