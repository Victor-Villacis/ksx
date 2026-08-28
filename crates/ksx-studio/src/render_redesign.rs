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
use forma_ir::slot::SlotData;
use forma_server::{render_page, PageConfig, PageOutput, RenderMode};

use crate::render::{body_prefix, with_icon_links, EmbeddedPage, PERSONALITY_CSS};
use crate::snapshot::RedesignPayload;

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

/// Compose the payload from the environment the source reports — the same
/// wording rule the nocturne derived block uses, copied so the two chips can
/// never disagree about what a fixture looks like.
pub(crate) fn payload(environment: &ksx_api::RuntimeEnvironmentView) -> RedesignPayload {
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
    }
}

/// Scalar slot values, keyed by the signal names in RedesignIsland.ts.
fn scalar_slots(payload: &RedesignPayload) -> serde_json::Value {
    serde_json::json!({
        "rdEnvLabel": payload.environment_label,
        "rdEnvCls": payload.environment_cls,
    })
}

/// Populate every server-injected slot. No lists, no shows yet — they join
/// as the transplants arrive.
fn build_slots(module: &IrModule, payload: &RedesignPayload) -> SlotData {
    let scalars = scalar_slots(payload).to_string();
    SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots))
}

/// Render /redesign for one payload: SSR slots for first paint, the same
/// data as island props for hydration.
pub(crate) fn render_redesign(page: &EmbeddedPage, payload: &RedesignPayload) -> PageOutput {
    let slots = build_slots(&page.module, payload);
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

    fn fixture_payload() -> RedesignPayload {
        payload(&ksx_api::RuntimeEnvironmentView {
            fixture: true,
            id: "seeded-demo".into(),
            label: "Fixture · Seeded demo".into(),
            detail: "Synthetic data for the redesign lane.".into(),
            generation: "test".into(),
        })
    }

    #[test]
    fn the_redesign_head_is_complete() {
        let page = EmbeddedPage::load("/redesign").unwrap();
        assert_complete_head(
            "/redesign",
            &render_redesign(&page, &fixture_payload()).html,
        );
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

        let scalars = scalar_slots(&RedesignPayload::default());
        for key in scalars.as_object().unwrap().keys() {
            assert!(
                names.contains(&key.as_str()),
                "scalar slot '{key}' missing from the embedded IR; slots: {names:?}"
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
        let html = render_redesign(&page, &fixture_payload()).html;
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
        for signal in ["rdEnvLabel", "rdEnvCls"] {
            assert!(
                REDESIGN_ISLAND_TS.contains(&format!("const [{signal}, ")),
                "RedesignIsland.ts no longer declares the '{signal}' signal the seam injects"
            );
        }
    }
}
