//! The /nocturne render seam — the Nocturne front end's REAL slots.
//!
//! Until 2026-08-17 this was the design proof's degenerate seam: no payload,
//! no injection, every named slot a client-only UI demo. The keyboard
//! section's migration changed that: the device pick rows, the
//! split-or-freeze roster, the keyboard header and the prepared-for-play
//! control are SERVED now, composed once in [`NocturneDerived`]
//! (snapshot.rs) and injected here — the same four-part slot seam as
//! [`crate::render_workspace`]. Everything else on the page (rack, binding
//! list, session demos) remains client-only placeholder state, and the
//! layout test below pins WHICH slot is which so a served sentence cannot
//! quietly appear in the placeholder half or vice versa.

use forma_ir::parser::IrModule;
use forma_ir::slot::{SlotData, SlotValue};
use forma_server::{render_page, PageConfig, PageOutput, RenderMode};

use crate::render::{body_prefix, with_icon_links, EmbeddedPage, PERSONALITY_CSS};
use crate::snapshot::{NocturneChoiceRow, NocturneDeviceRow, NocturneOtherRow, NocturnePayload};

/// How many server-injected `createShow` pairs this page has.
const SHOW_COUNT: usize = 2;

const LIST_SLOT_DEVICES: &str = "list:nDevRows:array";
const LIST_SLOT_OTHER: &str = "list:nDevOther:array";
const LIST_SLOT_MODES: &str = "list:nModeRows:array";

/// Scalar slot values, keyed by the signal names in NocturneIsland.ts. Every
/// value is a [`NocturneDerived`] field except the flash — the one SSR-only
/// slot, filled from the allowlisted query parameter, never from the payload.
fn scalar_slots(payload: &NocturnePayload, flash: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "nDevCount": payload.view.dev_count,
        "nDevNote": payload.view.dev_note,
        "nKbTitle": payload.view.kb_title,
        "nCapLine": payload.view.cap_line,
        "nCapdCls": payload.view.capd_cls,
        "nCapSwCls": payload.view.cap_sw_cls,
        "nCapSelector": payload.view.cap_selector,
        "nCapInstance": payload.view.cap_instance,
        "nFlashLine": flash.map(|f| f.trim_start_matches("error: ")).unwrap_or(""),
        "nFlashCls": match flash {
            None => "n-flash none",
            Some(f) if f.starts_with("error") => "n-flash err",
            Some(_) => "n-flash ok",
        },
    })
}

fn show_values(payload: &NocturnePayload) -> [(&'static str, bool); SHOW_COUNT] {
    [
        ("show:nCapPrep", payload.view.cap_prepare),
        ("show:nCapRel", payload.view.cap_release),
    ]
}

fn device_row(row: &NocturneDeviceRow) -> SlotValue {
    SlotValue::object(vec![
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
        ("selector".to_owned(), SlotValue::Text(row.selector.clone())),
        ("alias".to_owned(), SlotValue::Text(row.alias.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
    ])
}

fn other_row(row: &NocturneOtherRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
    ])
}

fn mode_row(row: &NocturneChoiceRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("detail".to_owned(), SlotValue::Text(row.detail.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn list_values(payload: &NocturnePayload) -> [(&'static str, SlotValue); 3] {
    let view = &payload.view;
    [
        (
            LIST_SLOT_DEVICES,
            SlotValue::array(view.dev_rows.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_OTHER,
            SlotValue::array(view.dev_other.iter().map(other_row).collect()),
        ),
        (
            LIST_SLOT_MODES,
            SlotValue::array(view.mode_rows.iter().map(mode_row).collect()),
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

fn build_slots(module: &IrModule, payload: &NocturnePayload, flash: Option<&str>) -> SlotData {
    let scalars = scalar_slots(payload, flash).to_string();
    let mut slots = SlotData::from_json(&scalars, module)
        .unwrap_or_else(|_| SlotData::new_from_defaults(&module.slots));
    for (name, value) in show_values(payload) {
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

/// Render /nocturne for one payload: SSR slots for first paint, the same
/// data as the embedded payload for hydration seeding and the 2 s poll.
pub(crate) fn render_nocturne(
    page: &EmbeddedPage,
    payload: &NocturnePayload,
    flash: Option<&str>,
) -> PageOutput {
    let slots = build_slots(&page.module, payload, flash);
    let prefix = body_prefix(payload, "/nocturne");
    with_icon_links(render_page(&PageConfig {
        title: "ksx Studio — Nocturne",
        route_pattern: "/nocturne",
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

    fn page() -> EmbeddedPage {
        EmbeddedPage::load("/nocturne").expect("embedded /nocturne page must load")
    }

    fn keyboard_payload() -> NocturnePayload {
        let mut staged = ksx_api::StagedSetupView {
            reachable: true,
            blocking: Some("bound-keys".to_owned()),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..Default::default()
        };
        staged.device = Some(ksx_api::StagedDeviceView {
            label: "Ultimarc I-PAC 4".to_owned(),
            alias: "ipac".to_owned(),
            selector: "usb:ultimarc-ipac4".to_owned(),
            backend: "interception".to_owned(),
            ..Default::default()
        });
        let scan = ksx_api::DeviceScanView {
            boards_summary: "2 keyboard-capable boards found.".to_owned(),
            interception_available: true,
            boards: vec![
                ksx_api::BoardRow {
                    name: "Ultimarc I-PAC 4".to_owned(),
                    transport_label: "USB".to_owned(),
                    selector: Some("usb:ultimarc-ipac4".to_owned()),
                    alias_hint: "ipac".to_owned(),
                    keyboard: Some("HID\\VID_D209&PID_0430\\1".to_owned()),
                    interception_eligible: true,
                    winusb_eligible: true,
                    can_type: true,
                    interfaces: vec![ksx_api::UsbRow {
                        instance_id: "HID\\VID_D209&PID_0430\\1".to_owned(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                ksx_api::BoardRow {
                    name: "Mystery composite".to_owned(),
                    transport_label: "USB".to_owned(),
                    backends: "No supported capture path".to_owned(),
                    selector: None,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        NocturnePayload {
            staged,
            scan,
            unavailable: String::new(),
            view: Default::default(),
        }
        .derived()
    }

    /// Every named slot is either SERVED (injected from the payload here) or
    /// a CLIENT-ONLY UI demo whose compile-time default is the idle screen.
    /// The split is the contract: a slot showing up in neither list means the
    /// island grew state nobody classified; a served name disappearing means
    /// the seam is silently injecting into a dead slot.
    #[test]
    fn nocturne_slots_are_classified_exactly() {
        // Every slot under a served list's prefix (`:array`, `:item`, one
        // per member field) belongs to the seam wholesale.
        const SERVED_LIST_PREFIXES: [&str; 3] =
            ["list:nDevRows:", "list:nDevOther:", "list:nModeRows:"];
        const SERVED_SLOTS: [&str; 12] = [
            "nDevCount",
            "nDevNote",
            "nKbTitle",
            "nCapLine",
            "nCapdCls",
            "nCapSwCls",
            "nCapSelector",
            "nCapInstance",
            "nFlashLine",
            "nFlashCls",
            "show:nCapPrep",
            "show:nCapRel",
        ];
        const CLIENT_ONLY_SLOTS: [&str; 42] = [
            "nCapPrep",
            "nCapRel",
            "nConflictOpen",
            "show:nConflictOpen",
            "nMacroOpen",
            "show:nMacroOpen",
            "nPlayCls",
            "nStatsCls",
            "nPauseCls",
            "nStopCls",
            "nTickCls",
            "nStageCls",
            "nRtCls",
            "nSlotMeta",
            "nIdLinkCls",
            "nIdBoxCls",
            "nIdText",
            "nSavedText",
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
            let served_list = SERVED_LIST_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix));
            assert!(
                served_list
                    || SERVED_SLOTS.contains(&name.as_str())
                    || CLIENT_ONLY_SLOTS.contains(&name.as_str()),
                "unclassified named slot {name:?} — decide whether the seam serves it or the \
                 island owns it, then pin it",
            );
        }
        for name in SERVED_SLOTS.iter().chain(CLIENT_ONLY_SLOTS.iter()) {
            assert!(
                named.iter().any(|n| n == name),
                "pinned slot {name:?} is gone from the IR",
            );
        }
        for name in [LIST_SLOT_DEVICES, LIST_SLOT_OTHER, LIST_SLOT_MODES] {
            assert!(
                named.iter().any(|n| n == name),
                "served list slot {name:?} is gone from the IR",
            );
        }
    }

    /// The migrated keyboard section renders SERVED facts: the staged
    /// board's identity in the keyboard header, the pick rows off the scan,
    /// the roster answers, and the prepared-for-play line.
    #[test]
    fn nocturne_renders_the_served_keyboard_facts() {
        let payload = keyboard_payload();
        let out = render_nocturne(&page(), &payload, None);
        assert_complete_head("/nocturne", &out.html);
        for sentinel in [
            "Ultimarc I-PAC 4",
            "USB · Ready to use",
            "Mystery composite",
            "No supported capture path",
            "2 keyboard-capable boards found.",
            "2 found",
            // The staged selection heads the keyboard area.
            "Ultimarc I-PAC 4 · USB",
            // The optional built-in path line (interception ready + eligible).
            "the shared driver is ready",
        ] {
            assert!(
                out.html.contains(sentinel),
                "SSR of /nocturne is missing {sentinel:?}",
            );
        }
        // The roster's three answers, from BlockingOption::roster, with the
        // staged one marked.
        assert!(out.html.contains("n-radio on"));
    }

    /// The page embeds its payload for hydration seeding and the poller.
    #[test]
    fn nocturne_embeds_the_payload() {
        let out = render_nocturne(&page(), &keyboard_payload(), None);
        assert!(out.html.contains("__ksx-payload"));
    }

    /// The placeholder half still paints from compile-time defaults: the
    /// design-proof demos survive the migration untouched.
    #[test]
    fn nocturne_keeps_the_placeholder_demos() {
        let out = render_nocturne(&page(), &keyboard_payload(), None);
        for sentinel in [
            "Apex Legends — WASD",
            "16 bound · XInput 1/4",
            "16 of 24 inputs bound",
            "Click an input, then a key below",
        ] {
            assert!(
                out.html.contains(sentinel),
                "SSR of /nocturne is missing placeholder {sentinel:?}",
            );
        }
    }
}
