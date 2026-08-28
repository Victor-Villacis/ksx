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
use crate::render_nocturne::{mode_row, named_slot_ids};
use crate::snapshot::{theme_rows, NocturneChoiceRow, RedesignPayload, SetupSnapshot};

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
/// never disagree about what a fixture looks like. `setup` is the same
/// `machine_cache.setup_state` read `page_theme` stamps the page from, so the
/// menu's marked row and the `<html data-theme>` stamp derive from one truth.
pub(crate) fn payload(
    environment: &ksx_api::RuntimeEnvironmentView,
    setup: Option<ksx_api::SetupView>,
) -> RedesignPayload {
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
    }
}

/// The one served list this page renders so far: the topbar theme menu's
/// rows. The name convention is the compiler's, proven on `/nocturne`
/// (`LIST_SLOT_THEMES` in render_nocturne.rs).
const LIST_SLOT_THEME_ROWS: &str = "list:rdThemeRows:array";

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
    })
}

/// Populate every server-injected slot: the scalars, plus the theme-rows
/// list. Further lists and shows join as the transplants arrive.
fn build_slots(module: &IrModule, payload: &RedesignPayload, flash: Option<&str>) -> SlotData {
    let scalars = scalar_slots(payload, flash).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    if let Some(id) = named_slot_ids(module, LIST_SLOT_THEME_ROWS).into_iter().next() {
        slots.set(
            id,
            SlotValue::array(payload.theme_rows.iter().map(mode_row).collect()),
        );
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
        )
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
        assert!(
            names.contains(&LIST_SLOT_THEME_ROWS),
            "the theme-rows list slot is missing from the embedded IR; slots: {names:?}"
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
        for signal in ["rdEnvLabel", "rdEnvCls", "rdFlashLine", "rdFlashCls"] {
            assert!(
                REDESIGN_ISLAND_TS.contains(&format!("const [{signal}, ")),
                "RedesignIsland.ts no longer declares the '{signal}' signal the seam injects"
            );
        }
        assert!(
            REDESIGN_ISLAND_TS.contains("const [rdThemeRows, "),
            "RedesignIsland.ts no longer declares the theme-rows list signal the seam fills"
        );
    }
}
