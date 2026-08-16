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
use crate::snapshot::WorkspacePayload;

/// The island table this page compiles to: exactly one island — the whole
/// screen. Its name is the `activateIslands` registry key in
/// `studio-ui/src/workspace.ts`.
#[cfg(test)]
const ISLAND_COMPONENT: &str = "WorkspaceIsland";

/// How many `createShow` pairs this page has; the layout test pins both the
/// count and every name.
const SHOW_COUNT: usize = 3;

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
/// Every value is a [`WorkspaceDerived`] field — this function maps names,
/// it words nothing.
fn scalar_slots(payload: &WorkspacePayload) -> serde_json::Value {
    serde_json::json!({
        "wsStateDetail": payload.view.state_detail,
        "wsDeviceLine": payload.view.device_line,
        "wsRackLine": payload.view.rack_line,
    })
}

/// Every show slot on this page, BY NAME. The three pills are exclusive by
/// construction in [`crate::snapshot::WorkspaceDerived`]; this function maps
/// names, it decides nothing.
fn show_values(payload: &WorkspacePayload) -> [(&'static str, bool); SHOW_COUNT] {
    [
        ("show:wsPillRunning", payload.view.pill_running),
        ("show:wsPillIdle", payload.view.pill_idle),
        ("show:wsPillDown", payload.view.pill_down),
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
fn build_slots(module: &IrModule, payload: &WorkspacePayload) -> SlotData {
    let scalars = scalar_slots(payload).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    for (name, value) in show_values(payload) {
        if let Some(id) = named_slot_ids(module, name).into_iter().next() {
            slots.set(id, SlotValue::Bool(value));
        }
    }
    slots
}

/// Render /workspace for one payload: SSR slots for first paint, the same
/// data as island props for hydration. Callers pass a payload built by
/// `server/workspace.rs`'s one collector, which has already called
/// [`WorkspacePayload::derived`].
pub(crate) fn render_workspace(page: &EmbeddedPage, payload: &WorkspacePayload) -> PageOutput {
    let slots = build_slots(&page.module, payload);
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
        assert_complete_head("/workspace", &render_workspace(&page, &cabinet()).html);
    }

    /// The draft renders as facts: the board's LABEL, the slot count.
    #[test]
    fn the_frame_renders_the_draft_it_was_given() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &cabinet()).html);
        assert!(html.contains("Ultimarc I-PAC 4"), "{html}");
        assert!(html.contains("2 controllers staged."), "{html}");
        assert!(html.contains("Ready to play."), "{html}");
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
                show_values(&payload).into_iter().collect();
            let lit = values.values().filter(|on| **on).count();
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
        let html = rendered(&render_workspace(&page, &unreachable).html);
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
        let fresh_html = rendered(&render_workspace(&page, &fresh).html);
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

    /// The skeleton says what it is and where the working surfaces are —
    /// the one sentence that keeps a transition-period screenshot honest.
    #[test]
    fn the_skeleton_names_itself_and_points_at_the_working_surfaces() {
        let page = EmbeddedPage::load("/workspace").unwrap();
        let html = rendered(&render_workspace(&page, &cabinet()).html);
        assert!(html.contains("workspace preview"), "{html}");
        assert!(html.contains("The workspace is being built here"), "{html}");
        assert!(html.contains(r#"href="/start""#), "{html}");
        assert!(html.contains(r#"href="/map""#), "{html}");
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

        let scalars = scalar_slots(&WorkspacePayload::default());
        for key in scalars.as_object().unwrap().keys() {
            assert!(
                names.contains(&key.as_str()),
                "scalar slot '{key}' missing from the embedded IR; slots: {names:?}"
            );
        }
        let array_slots: Vec<&str> = names
            .iter()
            .copied()
            .filter(|n| n.starts_with("list:") && n.ends_with(":array"))
            .collect();
        assert!(
            array_slots.is_empty(),
            "M0 has no lists; a new createList needs a LIST_SLOT_* constant \
             and an injection here first: {array_slots:?}"
        );
        let ir_shows: std::collections::BTreeSet<&str> = names
            .iter()
            .copied()
            .filter(|n| n.starts_with("show:"))
            .collect();
        let seam_shows: std::collections::BTreeSet<&str> =
            show_values(&WorkspacePayload::default())
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
        let html = render_workspace(&page, &cabinet()).html;
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
