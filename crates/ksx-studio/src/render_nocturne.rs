//! The /nocturne render seam — the DESIGN PROOF route.
//!
//! `/nocturne` is the whole Nocturne prototype
//! (`docs/design/nocturne-prototype/`) rebuilt as one Forma route with
//! placeholder data and no backend: the point is to prove the entire redesign
//! renders under the compiler + SSR before the real workspace adopts each
//! piece. Every string on the page is authored in `NocturneIsland.ts` as
//! build-time constants, so this seam is the degenerate case of the slot
//! protocol: NO payload and NO injection — the only named slots in the IR
//! are the island's CLIENT-ONLY UI demos (the expanded-row editor and the
//! capture-armed state), rendered from their compile-time defaults, and the
//! tests below pin that set by name. The moment the proof route grows a
//! served sentence, it has stopped being a proof and started being a product
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

    /// Every named slot on the proof route is CLIENT-ONLY UI state — the
    /// island's demo signals (increment 2: the expanded-row editor and the
    /// capture-armed variant), whose compile-time DEFAULTS are the idle
    /// screen. The seam injects nothing, ever. This pin makes slot growth a
    /// deliberate act twice over: a slot appearing here that is not in the
    /// list means either a data-shape regression in NocturneIsland.ts (a
    /// nested array, a bare-identifier binding, a string-element array
    /// degrading to a shell) or a served sentence sneaking into what must
    /// stay a placeholder page.
    #[test]
    fn nocturne_named_slots_are_exactly_the_ui_demos() {
        const CLIENT_ONLY_SLOTS: [&str; 35] = [
            "nConflictOpen",
            "show:nConflictOpen",
            "nMacroOpen",
            "show:nMacroOpen",
            "nDev1Cls",
            "nDev2Cls",
            "nDev3Cls",
            "nKbTitle",
            "nMode1Cls",
            "nMode2Cls",
            "nMode3Cls",
            "nMenuOpen",
            "show:nMenuOpen",
            "nAutoCls",
            "nDlgOpen",
            "show:nDlgOpen",
            "nLeftCls",
            "nRightCls",
            "nMetaHint",
            "nKbHint",
            "nRowUpCls",
            "nRowLeftCls",
            "nWedgeUpCls",
            "nWedgeLeftCls",
            "nHoldCls",
            "nTogCls",
            "nSwCls",
            "nTogBadgeCls",
            "nRateBadgeCls",
            "nRatesCls",
            "nxExplain",
            "nxOpenLeft",
            "nxOpenUp",
            "show:nxOpenUp",
            "show:nxOpenLeft",
        ];
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
        for name in &named {
            assert!(
                CLIENT_ONLY_SLOTS.contains(&name.as_str()),
                "unexpected named slot {name:?} — the proof route's slots are all \
                 client-only UI demos; add it to the pin only if it is one",
            );
        }
        for name in CLIENT_ONLY_SLOTS {
            assert!(
                named.iter().any(|n| n == name),
                "pinned client-only slot {name:?} is gone from the IR",
            );
        }
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
            // The two hint lines are now SLOT DEFAULTS (client-only UI
            // signals): their presence in SSR proves defaults resolve.
            "Click an input, then a key below",
            "Click a bound key to inspect it",
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
