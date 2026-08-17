//! The /nocturne render seam — the DESIGN PROOF route.
//!
//! `/nocturne` is the whole Nocturne prototype
//! (`docs/design/nocturne-prototype/`) rebuilt as one Forma route with
//! placeholder data and no backend: the point is to prove the entire redesign
//! renders under the compiler + SSR before the real workspace adopts each
//! piece. Every string on the page is authored in `NocturneIsland.ts` as
//! build-time constants, so this seam is the degenerate case of the slot
//! protocol: NO payload, NO scalars, NO shows, NO lists — the tests below pin
//! that emptiness as the contract. The moment the proof route grows a served
//! sentence, it has stopped being a proof and started being a product
//! surface; move the work to `render_workspace.rs` instead.

use forma_ir::slot::SlotData;
use forma_server::{render_page, PageConfig, PageOutput, RenderMode};

use crate::render::{with_icon_links, EmbeddedPage, PERSONALITY_CSS};

/// Render /nocturne: static SSR of the compiled island, defaults only.
pub(crate) fn render_nocturne(page: &EmbeddedPage) -> PageOutput {
    let slots = SlotData::new_from_defaults(&page.module.slots);
    with_icon_links(render_page(&PageConfig {
        title: "ksx Studio — Nocturne design proof",
        route_pattern: "/nocturne",
        manifest: &page.manifest,
        config_script: None,
        config_json: None,
        body_class: None,
        personality_css: Some(PERSONALITY_CSS),
        body_prefix: None,
        render_mode: RenderMode::Phase2SsrReconcile,
        ir_module: Some(&page.module),
        slots: Some(&slots),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::assert_complete_head;

    fn page() -> EmbeddedPage {
        EmbeddedPage::load("/nocturne").expect("embedded /nocturne page must load")
    }

    /// The proof route is fully static: the compiler unrolled every
    /// `...CONST.map(…)` at build time, so the IR carries NO named slots —
    /// no scalars, no `show:`, no `list:`. A named slot appearing here means
    /// a data-shape regression in NocturneIsland.ts (a nested array, a bare
    /// ternary, a string-element array) silently degraded part of the page
    /// to an empty island shell; the build warning gate catches the shells,
    /// this test catches the slots.
    #[test]
    fn nocturne_ir_has_no_named_slots() {
        let page = page();
        let named: Vec<String> = page
            .module
            .slots
            .entries()
            .iter()
            .filter_map(|e| page.module.strings.get(e.name_str_idx).ok())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        assert!(
            named.is_empty(),
            "the design proof must stay fully static; found named slots: {named:?}",
        );
    }

    #[test]
    fn nocturne_renders_the_idle_screen() {
        let out = render_nocturne(&page());
        assert_complete_head("/nocturne", &out.html);
        // One sentinel per region, all authored in NocturneIsland.ts: title
        // bar, device list, behaviour radios, rack, rack footer, center meta,
        // keyboard header, a bound keycap short, binding groups, pane footer.
        for sentinel in [
            "KSX Studio",
            "Apex Legends — WASD",
            "L-Ctrl ×5 pauses capture",
            "K70 RGB MK.2",
            "Offline · last seen 3 days ago",
            "Bound keys only — Split",
            "16 bound · XInput 1/4",
            "any persona",
            "16 slots is the KSX ceiling",
            "ViGEmBus · XInput · SOCD Neutral",
            "Corsair K70 RGB MK.2 · USB · 104 keys",
            "Shoulders &amp; triggers",
            "Right stick — Click (R3)",
            "16 of 24 inputs bound",
        ] {
            assert!(
                out.html.contains(sentinel),
                "SSR of /nocturne is missing {sentinel:?}",
            );
        }
    }

    /// The page serves no payload block and no meta-refresh: there is nothing
    /// to poll and nothing to fall back to — the SSR IS the whole experience.
    #[test]
    fn nocturne_has_no_payload_and_no_refresh() {
        let out = render_nocturne(&page());
        assert!(!out.html.contains("__ksx-payload"));
        assert!(!out.html.contains("http-equiv=\"refresh\""));
    }
}
