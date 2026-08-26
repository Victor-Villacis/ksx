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
use crate::snapshot::{
    NocturneBindRow, NocturneChoiceRow, NocturneCtlChip, NocturneDeviceRow, NocturneEmptyRow,
    NocturneGameRow, NocturneKeyCell, NocturneKeyRow, NocturneLegendRow, NocturneMacroRow,
    NocturneOptionRow, NocturneOtherRow, NocturnePayload, NocturnePersonaRow, NocturneRackRow,
};

/// How many server-injected `createShow` pairs this page has.
const SHOW_COUNT: usize = 2;

const LIST_SLOT_ENCODERS: &str = "list:nDevEncoders:array";
const LIST_SLOT_DEVICES: &str = "list:nDevRows:array";
const LIST_SLOT_EXP: &str = "list:nDevExp:array";
const LIST_SLOT_OTHER: &str = "list:nDevOther:array";
const LIST_SLOT_MODES: &str = "list:nModeRows:array";
const LIST_SLOT_THEMES: &str = "list:nThemeRows:array";
/// The SECOND `createList` over the same binding. Forma names a reused list
/// binding with an occurrence suffix (docs/FORMA-DOGFOOD.md #12), so the edit
/// disclosures under the saved-games menu are a distinct slot that must be
/// served with the same rows — otherwise the walker warns "server-sourced slot
/// has no value at render time" and the section renders empty server-side.
const LIST_SLOT_GAMES_EDIT: &str = "list:nGameRows#2:array";
const LIST_SLOT_RACK: &str = "list:nRackRows:array";
const LIST_SLOT_RACK_EMPTY: &str = "list:nRackEmpty:array";
const LIST_SLOT_PERSONAS: &str = "list:nPersonaRows:array";
const LIST_SLOT_LAYOUTS: &str = "list:nLayoutOpts:array";
const LIST_SLOT_SOCDS: &str = "list:nSocdOpts:array";
const LIST_SLOT_SOCD_EDIT: &str = "list:nSocdEditOpts:array";
const LIST_SLOT_BIND_FACE: &str = "list:nBindFace:array";
const LIST_SLOT_BIND_DPAD: &str = "list:nBindDpad:array";
const LIST_SLOT_BIND_SHL: &str = "list:nBindShl:array";
const LIST_SLOT_BIND_LS: &str = "list:nBindLs:array";
const LIST_SLOT_BIND_RS: &str = "list:nBindRs:array";
const LIST_SLOT_BIND_SYS: &str = "list:nBindSys:array";
const LIST_SLOT_GAMES: &str = "list:nGameRows:array";
const LIST_SLOT_MACROS: &str = "list:nMacroRows:array";
const LIST_SLOT_KEYROWS: &str = "list:nKeyRows:array";
const LIST_SLOT_AVAIL_MAIN: &str = "list:nAvailMain:array";
const LIST_SLOT_AVAIL_NAV: &str = "list:nAvailNav:array";
const LIST_SLOT_AVAIL_NUM: &str = "list:nAvailNum:array";
const LIST_SLOT_CTL_FACE: &str = "list:nCtlFace:array";
const LIST_SLOT_CTL_DPAD: &str = "list:nCtlDpad:array";
const LIST_SLOT_CTL_SHL: &str = "list:nCtlShl:array";
const LIST_SLOT_CTL_LS: &str = "list:nCtlLs:array";
const LIST_SLOT_CTL_RS: &str = "list:nCtlRs:array";
const LIST_SLOT_CTL_SYS: &str = "list:nCtlSys:array";
const LIST_SLOT_LEGEND: &str = "list:nLegend:array";
const LIST_SLOT_MAC_COLS: &str = "list:nMacCols:array";
const LIST_SLOT_MAC_GROUPS: &str = "list:nMacGroups:array";
const LIST_SLOT_MAC_ROWS: &str = "list:nMacRows:array";
const LIST_SLOT_MAC_CELLS: &str = "list:nMacCells:array";
const LIST_SLOT_MAC_POLS: &str = "list:nMacPols:array";
const LIST_SLOT_MAC_MOTIONS: &str = "list:nMacMotions:array";
const LIST_SLOT_KB: [&str; 7] = [
    "list:nKbRow1:array",
    "list:nKbRow2:array",
    "list:nKbRow3:array",
    "list:nKbRow4:array",
    "list:nKbRow5:array",
    "list:nKbRow6:array",
    "list:nKbTray:array",
];

/// Scalar slot values, keyed by the signal names in NocturneIsland.ts. Every
/// value is a [`NocturneDerived`] field except the flash — the one SSR-only
/// slot, filled from the allowlisted query parameter, never from the payload.
fn scalar_slots(payload: &NocturnePayload, flash: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "nDevCount": payload.view.dev_count,
        "nDevNote": payload.view.dev_note,
        "nEncoderCount": payload.view.encoder_count,
        "nEncoderHead": payload.view.encoder_head,
        "nKbTitle": payload.view.kb_title,
        "nModeNote": payload.view.mode_note,
        "nExpHead": payload.view.exp_head,
        "nExpFoldCls": payload.view.exp_fold_cls,
        "nOtherHead": payload.view.other_head,
        "nOtherFoldCls": payload.view.other_fold_cls,
        "nCapLine": payload.view.cap_line,
        "nCapdCls": payload.view.capd_cls,
        "nCapSwCls": payload.view.cap_sw_cls,
        "nCapSelector": payload.view.cap_selector,
        "nCapInstance": payload.view.cap_instance,
        "nVersion": payload.view.version,
        "nEnvironmentId": payload.view.environment_id,
        "nEnvironmentLabel": payload.view.environment_label,
        "nEnvironmentDetail": payload.view.environment_detail,
        "nEnvironmentCls": payload.view.environment_cls,
        "nChipText": payload.view.chip_text,
        "nSaveText": payload.view.save_text,
        "nEscapeLine": payload.view.escape_line,
        "nPlayCls": payload.view.play_cls,
        "nStopCls": payload.view.stop_cls,
        "nApplyCls": payload.view.apply_cls,
        "nRackCaption": payload.view.rack_caption,
        "nAddLede": payload.view.add_lede,
        "nAddPreset": payload.view.add_preset,
        "nSocdCls": payload.view.socd_cls,
        "nSocdNum": payload.view.socd_num,
        "nSocdLab": payload.view.socd_lab,
        "nPadBadge": payload.view.pad_badge,
        "nPadBadgeCls": payload.view.pad_badge_cls,
        "nKbCls": payload.view.kb_cls,
        "nSoloLbl": payload.view.solo_label,
        "nUndoCls": payload.view.undo_cls,
        "nUndoLabel": payload.view.undo_label,
        "nStageWord": payload.view.stage_word,
        "nPadName": payload.view.pad_name,
        "nPadSub": payload.view.pad_sub,
        "nBindTitle": payload.view.bind_title,
        "nBindFaceN": payload.view.bind_face_n,
        "nBindDpadN": payload.view.bind_dpad_n,
        "nBindShlN": payload.view.bind_shoulders_n,
        "nBindLsN": payload.view.bind_lstick_n,
        "nBindRsN": payload.view.bind_rstick_n,
        "nBindSysN": payload.view.bind_system_n,
        "nBindGCls": payload.view.bind_g_cls,
        "nBindFaceCls": payload.view.bind_face_cls,
        "nBindDpadCls": payload.view.bind_dpad_cls,
        "nBindShlCls": payload.view.bind_shoulders_cls,
        "nBindLsCls": payload.view.bind_lstick_cls,
        "nBindRsCls": payload.view.bind_rstick_cls,
        "nBindSysCls": payload.view.bind_system_cls,
        "nSlotVal": payload.view.slot_val,
        "nBindFoot": payload.view.bind_foot,
        "nMacrosHead": payload.view.macros_head,
        "nMacrosNote": payload.view.macros_note,
        "nKbTrayHead": payload.view.kb_tray_head,
        "nKbTrayCls": payload.view.kb_tray_cls,
        "nKbNote": payload.view.kb_note,
        "nKbMoreCls": payload.view.kb_more_cls,
        "nMacBackCls": payload.view.mac.back_cls,
        "nMacName": payload.view.mac.name,
        "nMacSlot": payload.view.mac.slot,
        "nMacPreset": payload.view.mac.preset,
        "nMacHead": payload.view.mac.head,
        "nMacTrigger": payload.view.mac.trigger,
        "nMacNote": payload.view.mac.note,
        "nMacGridCls": payload.view.mac.grid_cls,
        "nMacClose": payload.view.mac.close_href,
        "nMacMapHref": payload.view.mac.map_href,
        "nMacMotionLine": payload.view.mac.motion_line,
        "nMacPolicyLine": payload.view.mac.policy_line,
        "nMacRing": payload.view.mac.ring,
        "nMacRule": payload.view.mac.rule,
        "nMacToml": payload.view.mac.toml,
        "nMacRateCls": payload.view.mac.turbo_cls,
        "nMacRateVal": payload.view.mac.turbo_val,
        "nMacRateLbl": payload.view.mac.turbo_label,
        "nKeysNote": payload.view.keys_note,
        "nAvailMainHead": payload.view.avail_main_head,
        "nAvailNavHead": payload.view.avail_nav_head,
        "nAvailNumHead": payload.view.avail_num_head,
        "nAvailMainCls": payload.view.avail_main_cls,
        "nAvailNavCls": payload.view.avail_nav_cls,
        "nAvailNumCls": payload.view.avail_num_cls,
        "nPadXboxCls": payload.view.pad_xbox_cls,
        "nPadPsCls": payload.view.pad_ps_cls,
        "nPadPs5Cls": payload.view.pad_ps5_cls,
        "nPadSwitchProCls": payload.view.pad_switchpro_cls,
        "nPadXboxSeriesCls": payload.view.pad_xboxseries_cls,
        "nCfgLine": payload.view.cfg_line,
        "nCfgMeta": payload.view.cfg_meta,
        "nCfgCls": payload.view.cfg_cls,
        "nCfgCheck": payload.view.cfg_check,
        "nAdoptCls": payload.view.adopt_cls,
        "nDiscardNote": payload.view.discard_note,
        "nGamesHead": payload.view.games_head,
        "nGamesNote": payload.view.games_note,
        "nAutoLine": payload.view.auto_line,
        "nAutoSwCls": payload.view.auto_sw_cls,
        "nAutoDir": payload.view.auto_dir,
        "nAutoBtn": payload.view.auto_btn,
        "nAutoNote": payload.view.auto_note,
        "nAutoFormCls": payload.view.auto_form_cls,
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
        ("role".to_owned(), SlotValue::Text(row.role.clone())),
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

fn rack_row(row: &NocturneRackRow) -> SlotValue {
    SlotValue::object(vec![
        ("number".to_owned(), SlotValue::Text(row.number.clone())),
        ("badge".to_owned(), SlotValue::Text(row.badge.clone())),
        ("dot_cls".to_owned(), SlotValue::Text(row.dot_cls.clone())),
        (
            "badge_cls".to_owned(),
            SlotValue::Text(row.badge_cls.clone()),
        ),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("href".to_owned(), SlotValue::Text(row.href.clone())),
        ("up_order".to_owned(), SlotValue::Text(row.up_order.clone())),
        (
            "down_order".to_owned(),
            SlotValue::Text(row.down_order.clone()),
        ),
    ])
}

fn empty_row(row: &NocturneEmptyRow) -> SlotValue {
    SlotValue::object(vec![(
        "badge".to_owned(),
        SlotValue::Text(row.badge.clone()),
    )])
}

fn persona_row(row: &NocturnePersonaRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("api".to_owned(), SlotValue::Text(row.api.clone())),
        ("note".to_owned(), SlotValue::Text(row.note.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn option_row(row: &NocturneOptionRow) -> SlotValue {
    SlotValue::object(vec![
        ("value".to_owned(), SlotValue::Text(row.value.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
    ])
}

fn ctl_chip(row: &NocturneCtlChip) -> SlotValue {
    SlotValue::object(vec![
        ("function".to_owned(), SlotValue::Text(row.function.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn key_row_view(row: &NocturneKeyRow) -> SlotValue {
    SlotValue::object(vec![
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("targets".to_owned(), SlotValue::Text(row.targets.clone())),
        ("fns".to_owned(), SlotValue::Text(row.fns.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("slot".to_owned(), SlotValue::Text(row.slot.clone())),
    ])
}

fn key_cell(row: &NocturneKeyCell) -> SlotValue {
    SlotValue::object(vec![
        ("cap".to_owned(), SlotValue::Text(row.cap.clone())),
        ("key".to_owned(), SlotValue::Text(row.key.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("short".to_owned(), SlotValue::Text(row.short.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("aria".to_owned(), SlotValue::Text(row.aria.clone())),
    ])
}

fn mac_col(row: &crate::macro_editor::NocturneMacCol) -> SlotValue {
    SlotValue::object(vec![
        ("id".to_owned(), SlotValue::Text(row.id.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
    ])
}

fn mac_group(row: &crate::macro_editor::NocturneMacGroup) -> SlotValue {
    SlotValue::object(vec![
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("count".to_owned(), SlotValue::Text(row.count.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        (
            "count_cls".to_owned(),
            SlotValue::Text(row.count_cls.clone()),
        ),
    ])
}

fn mac_row(row: &crate::macro_editor::NocturneMacRow) -> SlotValue {
    SlotValue::object(vec![
        ("n".to_owned(), SlotValue::Text(row.n.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("hold".to_owned(), SlotValue::Text(row.hold.clone())),
        ("hold_cls".to_owned(), SlotValue::Text(row.hold_cls.clone())),
        ("exp".to_owned(), SlotValue::Text(row.exp.clone())),
        ("exp_cls".to_owned(), SlotValue::Text(row.exp_cls.clone())),
        ("dur".to_owned(), SlotValue::Text(row.dur.clone())),
        ("dur_val".to_owned(), SlotValue::Text(row.dur_val.clone())),
        ("dur_row".to_owned(), SlotValue::Text(row.dur_row.clone())),
        ("dur_cls".to_owned(), SlotValue::Text(row.dur_cls.clone())),
        (
            "dur_title".to_owned(),
            SlotValue::Text(row.dur_title.clone()),
        ),
        ("unit".to_owned(), SlotValue::Text(row.unit.clone())),
        ("unit_act".to_owned(), SlotValue::Text(row.unit_act.clone())),
        (
            "unit_title".to_owned(),
            SlotValue::Text(row.unit_title.clone()),
        ),
        ("warn".to_owned(), SlotValue::Text(row.warn.clone())),
        ("warn_cls".to_owned(), SlotValue::Text(row.warn_cls.clone())),
        (
            "warn_title".to_owned(),
            SlotValue::Text(row.warn_title.clone()),
        ),
        ("up_cls".to_owned(), SlotValue::Text(row.up_cls.clone())),
        ("dn_cls".to_owned(), SlotValue::Text(row.dn_cls.clone())),
        ("up_act".to_owned(), SlotValue::Text(row.up_act.clone())),
        ("dn_act".to_owned(), SlotValue::Text(row.dn_act.clone())),
        ("ia_act".to_owned(), SlotValue::Text(row.ia_act.clone())),
        ("ib_act".to_owned(), SlotValue::Text(row.ib_act.clone())),
        ("del_act".to_owned(), SlotValue::Text(row.del_act.clone())),
        (
            "del_title".to_owned(),
            SlotValue::Text(row.del_title.clone()),
        ),
    ])
}

fn mac_cell(row: &crate::macro_editor::NocturneMacCell) -> SlotValue {
    SlotValue::object(vec![
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("cell".to_owned(), SlotValue::Text(row.cell.clone())),
        ("mark".to_owned(), SlotValue::Text(row.mark.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("on".to_owned(), SlotValue::Text(row.on.clone())),
        ("tab".to_owned(), SlotValue::Text(row.tab.clone())),
    ])
}

fn mac_pol(row: &crate::macro_editor::NocturneMacPol) -> SlotValue {
    SlotValue::object(vec![
        ("act".to_owned(), SlotValue::Text(row.act.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("head".to_owned(), SlotValue::Text(row.head.clone())),
        ("head_cls".to_owned(), SlotValue::Text(row.head_cls.clone())),
        ("note".to_owned(), SlotValue::Text(row.note.clone())),
        ("note_cls".to_owned(), SlotValue::Text(row.note_cls.clone())),
    ])
}

fn mac_motion(row: &crate::macro_editor::NocturneMacMotion) -> SlotValue {
    SlotValue::object(vec![
        ("act".to_owned(), SlotValue::Text(row.act.clone())),
        ("shape".to_owned(), SlotValue::Text(row.shape.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
    ])
}

fn legend_row(row: &NocturneLegendRow) -> SlotValue {
    SlotValue::object(vec![
        ("slot".to_owned(), SlotValue::Text(row.slot.clone())),
        ("badge".to_owned(), SlotValue::Text(row.badge.clone())),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
    ])
}

fn macro_row(row: &NocturneMacroRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("fn_name".to_owned(), SlotValue::Text(row.fn_name.clone())),
        ("chip".to_owned(), SlotValue::Text(row.chip.clone())),
        ("chip_cls".to_owned(), SlotValue::Text(row.chip_cls.clone())),
        (
            "chip_title".to_owned(),
            SlotValue::Text(row.chip_title.clone()),
        ),
        ("add_cls".to_owned(), SlotValue::Text(row.add_cls.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("slot".to_owned(), SlotValue::Text(row.slot.clone())),
        (
            "edit_href".to_owned(),
            SlotValue::Text(row.edit_href.clone()),
        ),
        (
            "toggle_label".to_owned(),
            SlotValue::Text(row.toggle_label.clone()),
        ),
        (
            "toggle_value".to_owned(),
            SlotValue::Text(row.toggle_value.clone()),
        ),
    ])
}

fn game_row(row: &NocturneGameRow) -> SlotValue {
    SlotValue::object(vec![
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("ico_cls".to_owned(), SlotValue::Text(row.ico_cls.clone())),
        ("revision".to_owned(), SlotValue::Text(row.revision.clone())),
        ("path".to_owned(), SlotValue::Text(row.path.clone())),
        (
            "arguments".to_owned(),
            SlotValue::Text(row.arguments.clone()),
        ),
        ("slots".to_owned(), SlotValue::Text(row.slots.clone())),
        ("preset".to_owned(), SlotValue::Text(row.preset.clone())),
    ])
}

fn bind_row(row: &NocturneBindRow) -> SlotValue {
    SlotValue::object(vec![
        ("function".to_owned(), SlotValue::Text(row.function.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        ("chip".to_owned(), SlotValue::Text(row.chip.clone())),
        ("note".to_owned(), SlotValue::Text(row.note.clone())),
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("chip_cls".to_owned(), SlotValue::Text(row.chip_cls.clone())),
        (
            "minus_cls".to_owned(),
            SlotValue::Text(row.minus_cls.clone()),
        ),
        (
            "clear_cls".to_owned(),
            SlotValue::Text(row.clear_cls.clone()),
        ),
        ("slot".to_owned(), SlotValue::Text(row.slot.clone())),
        ("turbo".to_owned(), SlotValue::Text(row.turbo.clone())),
        (
            "chip_title".to_owned(),
            SlotValue::Text(row.chip_title.clone()),
        ),
        ("badge".to_owned(), SlotValue::Text(row.badge.clone())),
        (
            "badge_cls".to_owned(),
            SlotValue::Text(row.badge_cls.clone()),
        ),
        ("add_cls".to_owned(), SlotValue::Text(row.add_cls.clone())),
        ("hold_cls".to_owned(), SlotValue::Text(row.hold_cls.clone())),
        ("tog_cls".to_owned(), SlotValue::Text(row.tog_cls.clone())),
    ])
}

fn list_values(payload: &NocturnePayload) -> [(&'static str, SlotValue); 45] {
    let view = &payload.view;
    [
        (
            LIST_SLOT_GAMES,
            SlotValue::array(view.game_rows.iter().map(game_row).collect()),
        ),
        (
            LIST_SLOT_LEGEND,
            SlotValue::array(view.legend.iter().map(legend_row).collect()),
        ),
        (
            LIST_SLOT_MAC_COLS,
            SlotValue::array(view.mac.cols.iter().map(mac_col).collect()),
        ),
        (
            LIST_SLOT_MAC_GROUPS,
            SlotValue::array(view.mac.groups.iter().map(mac_group).collect()),
        ),
        (
            LIST_SLOT_MAC_ROWS,
            SlotValue::array(view.mac.rows.iter().map(mac_row).collect()),
        ),
        (
            LIST_SLOT_MAC_CELLS,
            SlotValue::array(view.mac.cells.iter().map(mac_cell).collect()),
        ),
        (
            LIST_SLOT_MAC_POLS,
            SlotValue::array(view.mac.pols.iter().map(mac_pol).collect()),
        ),
        (
            LIST_SLOT_MAC_MOTIONS,
            SlotValue::array(view.mac.motions.iter().map(mac_motion).collect()),
        ),
        (
            LIST_SLOT_KEYROWS,
            SlotValue::array(view.key_rows.iter().map(key_row_view).collect()),
        ),
        (
            LIST_SLOT_AVAIL_MAIN,
            SlotValue::array(view.avail_main.iter().map(key_row_view).collect()),
        ),
        (
            LIST_SLOT_AVAIL_NAV,
            SlotValue::array(view.avail_nav.iter().map(key_row_view).collect()),
        ),
        (
            LIST_SLOT_AVAIL_NUM,
            SlotValue::array(view.avail_num.iter().map(key_row_view).collect()),
        ),
        (
            LIST_SLOT_CTL_FACE,
            SlotValue::array(view.avail_ctl_face.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_CTL_DPAD,
            SlotValue::array(view.avail_ctl_dpad.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_CTL_SHL,
            SlotValue::array(view.avail_ctl_shoulders.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_CTL_LS,
            SlotValue::array(view.avail_ctl_lstick.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_CTL_RS,
            SlotValue::array(view.avail_ctl_rstick.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_CTL_SYS,
            SlotValue::array(view.avail_ctl_system.iter().map(ctl_chip).collect()),
        ),
        (
            LIST_SLOT_MACROS,
            SlotValue::array(view.macro_rows.iter().map(macro_row).collect()),
        ),
        (
            LIST_SLOT_KB[0],
            SlotValue::array(view.kb_row1.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[1],
            SlotValue::array(view.kb_row2.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[2],
            SlotValue::array(view.kb_row3.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[3],
            SlotValue::array(view.kb_row4.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[4],
            SlotValue::array(view.kb_row5.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[5],
            SlotValue::array(view.kb_row6.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_KB[6],
            SlotValue::array(view.kb_tray.iter().map(key_cell).collect()),
        ),
        (
            LIST_SLOT_RACK,
            SlotValue::array(view.rack_rows.iter().map(rack_row).collect()),
        ),
        (
            LIST_SLOT_RACK_EMPTY,
            SlotValue::array(view.rack_empty.iter().map(empty_row).collect()),
        ),
        (
            LIST_SLOT_PERSONAS,
            SlotValue::array(view.persona_rows.iter().map(persona_row).collect()),
        ),
        (
            LIST_SLOT_LAYOUTS,
            SlotValue::array(view.layout_opts.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_SOCDS,
            SlotValue::array(view.socd_opts.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_SOCD_EDIT,
            SlotValue::array(view.socd_edit_opts.iter().map(option_row).collect()),
        ),
        (
            LIST_SLOT_BIND_FACE,
            SlotValue::array(view.bind_face.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_BIND_DPAD,
            SlotValue::array(view.bind_dpad.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_BIND_SHL,
            SlotValue::array(view.bind_shoulders.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_BIND_LS,
            SlotValue::array(view.bind_lstick.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_BIND_RS,
            SlotValue::array(view.bind_rstick.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_BIND_SYS,
            SlotValue::array(view.bind_system.iter().map(bind_row).collect()),
        ),
        (
            LIST_SLOT_ENCODERS,
            SlotValue::array(view.dev_encoders.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_DEVICES,
            SlotValue::array(view.dev_rows.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_EXP,
            SlotValue::array(view.dev_exp.iter().map(device_row).collect()),
        ),
        (
            LIST_SLOT_OTHER,
            SlotValue::array(view.dev_other.iter().map(other_row).collect()),
        ),
        (
            LIST_SLOT_MODES,
            SlotValue::array(view.mode_rows.iter().map(mode_row).collect()),
        ),
        (
            LIST_SLOT_THEMES,
            SlotValue::array(view.theme_rows.iter().map(mode_row).collect()),
        ),
        (
            LIST_SLOT_GAMES_EDIT,
            SlotValue::array(view.game_rows.iter().map(game_row).collect()),
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
                    role: ksx_api::BoardRole::PanelEncoder,
                    transport_label: "USB".to_owned(),
                    selector: Some("usb:ultimarc-ipac4".to_owned()),
                    alias_hint: "ipac".to_owned(),
                    keyboard: Some("HID\\VID_D209&PID_0430\\1".to_owned()),
                    interception_eligible: true,
                    winusb_eligible: true,
                    can_type: true,
                    pickable: true,
                    looks_like_a_keyboard: true,
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
            environment: ksx_api::RuntimeEnvironmentView::default(),
            staged,
            scan,
            macro_selected: None,
            session: crate::control::SessionView {
                reachable: true,
                running: false,
                line: "idle".to_owned(),
                profile: None,
                origin: ksx_api::SessionOrigin::Unknown,
                active: None,
            },
            unavailable: String::new(),
            setup: Some(ksx_api::SetupView {
                config_exists: true,
                slots: vec![ksx_api::SetupSlotRow {
                    number: 1,
                    device: "panel".to_owned(),
                    preset: "Panel P1".to_owned(),
                    persona: "Xbox 360 pad".to_owned(),
                    socd: String::new(),
                    source: "config.toml".to_owned(),
                }],
                ..ksx_api::SetupView::default()
            }),
            setup_error: String::new(),
            games: Some(ksx_api::ProfilesView {
                generated_at: "test".to_owned(),
                config_root: "C:\\cfg".to_owned(),
                games_path: "C:\\cfg\\games.toml".to_owned(),
                profiles: vec![ksx_api::ProfileDetail {
                    revision: "g1".to_owned(),
                    title: "Example Game".to_owned(),
                    path: "C:\\Examples\\example.exe".to_owned(),
                    arguments: String::new(),
                    slots: 2,
                    presets: vec!["Arcade".to_owned()],
                    state: "ok".to_owned(),
                    verdict: "the program is there".to_owned(),
                    broken_path: None,
                }],
                notes: Vec::new(),
            }),
            games_error: String::new(),
            autostart_read: Some(ksx_api::AutostartView::default()),
            autostart_error: String::new(),
            selected: None,
            q: None,
            undo_label: None,
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
        const SERVED_LIST_PREFIXES: [&str; 45] = [
            "list:nKeyRows:",
            "list:nAvailMain:",
            "list:nAvailNav:",
            "list:nAvailNum:",
            "list:nCtlFace:",
            "list:nCtlDpad:",
            "list:nCtlShl:",
            "list:nCtlLs:",
            "list:nCtlRs:",
            "list:nCtlSys:",
            "list:nSocdEditOpts:",
            "list:nBindFace:",
            "list:nBindDpad:",
            "list:nBindShl:",
            "list:nBindLs:",
            "list:nBindRs:",
            "list:nBindSys:",
            "list:nDevEncoders:",
            "list:nDevRows:",
            "list:nDevExp:",
            "list:nGameRows:",
            // The saved-games binding drives a SECOND `createList`, so the
            // compiler gives that one an occurrence suffix. Both are served;
            // leaving the suffixed name out renders the second list empty
            // server-side and fills it only after adoption.
            "list:nGameRows#2:",
            "list:nMacroRows:",
            "list:nLegend:",
            "list:nMacCols:",
            "list:nMacGroups:",
            "list:nMacRows:",
            "list:nMacCells:",
            "list:nMacPols:",
            "list:nMacMotions:",
            "list:nKbRow1:",
            "list:nKbRow2:",
            "list:nKbRow3:",
            "list:nKbRow4:",
            "list:nKbRow5:",
            "list:nKbRow6:",
            "list:nKbTray:",
            "list:nDevOther:",
            "list:nModeRows:",
            "list:nRackRows:",
            "list:nRackEmpty:",
            "list:nPersonaRows:",
            "list:nLayoutOpts:",
            // The Studio theme picker, brought onto /nocturne when /setup was
            // deleted: one row per shipped theme, served so the choice paints
            // without scripting.
            "list:nThemeRows:",
            "list:nSocdOpts:",
        ];
        const SERVED_SLOTS: [&str; 111] = [
            "nEnvironmentId",
            "nEnvironmentLabel",
            "nEnvironmentDetail",
            "nEnvironmentCls",
            "nKeysNote",
            "nAvailMainHead",
            "nAvailNavHead",
            "nAvailNumHead",
            "nAvailMainCls",
            "nAvailNavCls",
            "nAvailNumCls",
            "nBindFaceCls",
            "nBindDpadCls",
            "nBindShlCls",
            "nBindLsCls",
            "nBindRsCls",
            "nBindSysCls",
            "nSlotVal",
            "nUndoCls",
            "nUndoLabel",
            "nKbCls",
            "nSoloLbl",
            "nStageWord",
            "nApplyCls",
            "nPadBadgeCls",
            "nBindFaceN",
            "nBindDpadN",
            "nBindShlN",
            "nBindLsN",
            "nBindRsN",
            "nBindSysN",
            "nBindGCls",
            "nSocdCls",
            "nSocdNum",
            "nSocdLab",
            "nDevCount",
            "nEncoderCount",
            "nEncoderHead",
            "nModeNote",
            "nMacrosHead",
            "nMacrosNote",
            "nPadXboxCls",
            "nPadPsCls",
            "nPadPs5Cls",
            "nPadSwitchProCls",
            "nPadXboxSeriesCls",
            "nKbTrayHead",
            "nKbTrayCls",
            "nKbNote",
            "nKbMoreCls",
            "nMacBackCls",
            "nMacName",
            "nMacSlot",
            "nMacPreset",
            "nMacHead",
            "nMacTrigger",
            "nMacNote",
            "nMacGridCls",
            "nMacClose",
            "nMacMapHref",
            "nMacMotionLine",
            "nMacPolicyLine",
            "nMacRing",
            "nMacRule",
            "nMacToml",
            "nMacRateCls",
            "nMacRateVal",
            "nMacRateLbl",
            "nCfgLine",
            "nCfgMeta",
            "nCfgCls",
            "nCfgCheck",
            "nAdoptCls",
            "nDiscardNote",
            "nGamesHead",
            "nGamesNote",
            "nAutoLine",
            "nAutoSwCls",
            "nAutoDir",
            "nAutoBtn",
            "nAutoNote",
            "nAutoFormCls",
            "nExpHead",
            "nExpFoldCls",
            "nOtherHead",
            "nOtherFoldCls",
            "nVersion",
            "nChipText",
            "nSaveText",
            "nEscapeLine",
            "nPlayCls",
            "nStopCls",
            "nRackCaption",
            "nAddLede",
            "nAddPreset",
            "nPadBadge",
            "nPadName",
            "nPadSub",
            "nBindTitle",
            "nBindFoot",
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
        // nMenuOpen left this list with the menu pass: the configuration
        // menu is a native details now, not signal state.
        const CLIENT_ONLY_SLOTS: [&str; 42] = [
            "nMacSay",
            "nMacSayCls",
            // The auto-map toast's Skip button exists only while a walk runs
            // — SSR paints it hidden. (The auto-map button itself is static
            // markup revealed by the wire's js marker class.)
            "nLearnSkipCls",
            // ...as does the toast's "Bind several" switch.
            "nChainCls",
            // ...and the keyboard's learn cue is its mirror.
            "nKeyCueCls",
            "nKeyCueText",
            // Keyboard material and the detachable-key workbench are local
            // visual/layout preferences. They never claim daemon bindings.
            "nKeyboardTheme",
            "nKeyboardCapProfile",
            "nKeyboardWorkbenchOpen",
            "show:nKeyboardWorkbenchOpen",
            "nKbtCarbonPressed",
            "nKbtLunarPressed",
            "nKbtVioletPressed",
            "nKbtGlacierPressed",
            "nKbtMintPressed",
            "nKbtRetroPressed",
            "nKbWorkbenchPressed",
            // Which contextual inspector tab is open is canvas-local UI state;
            // the server supplies both inspectors but never chooses between them.
            "nViewCtlPressed",
            "nViewKeysPressed",
            // The expand/collapse-all toggle's label follows which editors
            // the BROWSER is holding open — state no server request carries.
            "nExpandLbl",
            // Apply's needs-restart dialog is a fetch answer, never server
            // state.
            "nApplyOpen",
            "show:nApplyOpen",
            "nApplyMsg",
            "nCapPrep",
            "nCapRel",
            "nCenterCls",
            "nDlgOpen",
            "show:nDlgOpen",
            "nLeftCls",
            "nRightCls",
            "nIdLinkCls",
            "nIdBoxCls",
            "nIdText",
            "nFlashLine",
            "nFlashCls",
            // The learn flow's banner and the key-conflict consequence dialog
            // are capture-time browser state: the server never claims a learn
            // is armed, so these stay client-only.
            "nLearnCls",
            "nLearnText",
            "nLearnSub",
            "nConfOpen",
            "show:nConfOpen",
            "nConfTitle",
            "nConfLines",
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
        for name in [
            LIST_SLOT_ENCODERS,
            LIST_SLOT_DEVICES,
            LIST_SLOT_EXP,
            LIST_SLOT_GAMES,
            LIST_SLOT_MACROS,
            LIST_SLOT_OTHER,
            LIST_SLOT_LEGEND,
            LIST_SLOT_MAC_COLS,
            LIST_SLOT_MAC_GROUPS,
            LIST_SLOT_MAC_ROWS,
            LIST_SLOT_MAC_CELLS,
            LIST_SLOT_MAC_POLS,
            LIST_SLOT_MAC_MOTIONS,
            LIST_SLOT_KB[0],
            LIST_SLOT_KB[6],
            LIST_SLOT_MODES,
            LIST_SLOT_THEMES,
            LIST_SLOT_GAMES_EDIT,
            LIST_SLOT_RACK,
            LIST_SLOT_RACK_EMPTY,
            LIST_SLOT_PERSONAS,
            LIST_SLOT_LAYOUTS,
            LIST_SLOT_SOCDS,
            LIST_SLOT_SOCD_EDIT,
            LIST_SLOT_BIND_FACE,
            LIST_SLOT_BIND_DPAD,
            LIST_SLOT_BIND_SHL,
            LIST_SLOT_BIND_LS,
            LIST_SLOT_BIND_RS,
            LIST_SLOT_BIND_SYS,
        ] {
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
            "USB · Connected · outputs not checked",
            "Mystery composite",
            "No supported capture path",
            "2 keyboard-capable boards found.",
            // dev_count counts PICKABLE boards only (matching the kicker's
            // KEYBOARD semantics); the summary sentence carries the rest.
            "1 found",
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

    /// Regression: the old derived view put every boot-keyboard-shaped board
    /// into `dev_rows`, which forced the island to recognize an I-PAC by its
    /// product copy. The backend role now survives both the derived payload and
    /// the render-row object as its own first-run lane.
    #[test]
    fn nocturne_keeps_panel_encoders_out_of_the_ordinary_keyboard_list() {
        let mut payload = keyboard_payload();
        payload.scan.boards[0].role = ksx_api::BoardRole::PanelEncoder;
        payload.scan.boards.push(ksx_api::BoardRow {
            name: "Ordinary USB keyboard".to_owned(),
            role: ksx_api::BoardRole::Keyboard,
            transport_label: "USB".to_owned(),
            selector: Some("usb:046d:c31c:00".to_owned()),
            alias_hint: "desk keyboard".to_owned(),
            keyboard: Some(r"USB\VID_046D&PID_C31C&MI_00\1".to_owned()),
            pickable: true,
            looks_like_a_keyboard: true,
            can_type: true,
            ..Default::default()
        });
        let derived = payload.derived().view;

        assert_eq!(derived.dev_encoders.len(), 1);
        assert_eq!(derived.dev_encoders[0].name, "Ultimarc I-PAC 4");
        assert_eq!(derived.dev_encoders[0].role, "panel-encoder");
        assert_eq!(derived.encoder_count, "1 found");
        assert_eq!(derived.encoder_head, "Arcade encoders");
        assert_eq!(derived.dev_rows.len(), 1);
        assert_eq!(derived.dev_rows[0].name, "Ordinary USB keyboard");
        assert_eq!(derived.dev_rows[0].role, "keyboard");
        assert_eq!(derived.dev_count, "1 found");
    }

    /// The page embeds its payload for hydration seeding and the poller.
    #[test]
    fn nocturne_embeds_the_payload() {
        let out = render_nocturne(&page(), &keyboard_payload(), None);
        assert!(out.html.contains("__ksx-payload"));
    }

    /// The configuration menu is a native details, so its SERVED facts paint
    /// on the SSR pass — the config identity, the games list, and the sign-in
    /// task in the vocabulary the deleted /start page used to own — and its
    /// placeholder sentence is gone for good.
    ///
    /// The verbs below are the ones that had to come WITH the deleted pages:
    /// export and import (/setup), the saved-game and layout editors
    /// (/profiles), the autostart task (/start), and the theme picker
    /// (/setup). Every one of them posts to a /nocturne route now, and every
    /// one works with scripting off — that is what makes the cutover a move
    /// rather than a loss, so it is pinned here.
    #[test]
    fn nocturne_renders_the_served_configuration_menu() {
        let out = render_nocturne(&page(), &keyboard_payload(), None);
        for sentinel in [
            "Saved configuration",
            "config.toml — 1 controller",
            "Saved games · 1",
            "Example Game",
            "2 controllers",
            // StartAutostartView's own words — one derivation, two surfaces.
            "ksx does not start on its own",
            "Start ksx when I sign in",
            // Everything the deleted pages used to carry, on its new route.
            "/nocturne/export.json",
            "/nocturne/import",
            "/nocturne/theme",
            "/nocturne/game",
            "/nocturne/game/update",
            "/nocturne/game/delete",
            "/nocturne/layout/rename",
            "/nocturne/layout/delete",
            "How the Studio looks",
            "Import a configuration",
            "Add a saved game",
            // The import dry-run consent, which is the whole point of the box.
            "nothing is written",
        ] {
            assert!(
                out.html.contains(sentinel),
                "SSR of the configuration menu is missing {sentinel:?}",
            );
        }
        assert!(
            !out.html.contains("arrive with the configuration pass"),
            "the menu's placeholder sentence is back",
        );
    }

    /// **No invented values.** The design proof's placeholder data is gone;
    /// this pins that none of it can quietly return.
    #[test]
    fn nocturne_serves_no_invented_values() {
        let out = render_nocturne(&page(), &keyboard_payload(), None);
        for fiction in [
            "Apex Legends",
            "16 bound",
            "16 of 24 inputs bound",
            "Click an input, then a key below",
            "K70 RGB",
            "G915",
            "Huntsman",
            "Saved 2 days ago",
        ] {
            assert!(
                !out.html.contains(fiction),
                "invented value {fiction:?} is back in SSR",
            );
        }
        // The real replacements paint instead.
        for real in [
            concat!("v", env!("CARGO_PKG_VERSION")),
            "LeftCtrl five times",
        ] {
            assert!(out.html.contains(real), "missing served value {real:?}");
        }
    }

    fn two_staged_slots() -> Vec<ksx_api::StagedSlotView> {
        vec![
            ksx_api::StagedSlotView {
                number: 1,
                persona_label: "Xbox 360".to_owned(),
                is_xinput: true,
                preset: "Player 1".to_owned(),
                ..Default::default()
            },
            ksx_api::StagedSlotView {
                number: 2,
                persona_label: "PlayStation".to_owned(),
                preset: "Player 2".to_owned(),
                ..Default::default()
            },
        ]
    }

    /// An older daemon serves the roster fields it predates as EMPTY (serde
    /// default) — and an empty `<select>` renders as a dead blank box. The
    /// seam degrades each roster to one honest option whose empty value
    /// posts nothing, and hides the rack's SOCD editor outright, because a
    /// policy select with no served names would be an invented value.
    #[test]
    fn nocturne_degrades_missing_rosters_honestly() {
        let mut payload = keyboard_payload();
        payload.staged.slots = two_staged_slots();
        payload.staged.socd_options = Vec::new();
        payload.staged.layouts = Vec::new();
        let payload = payload.derived();
        let out = render_nocturne(&page(), &payload, None);
        for honest in [
            "Daemon default — update ksx to choose a policy",
            "Empty worksheet — this ksx build serves no starting layouts",
            "n-socdform none",
        ] {
            assert!(
                out.html.contains(honest),
                "degraded roster is missing {honest:?}",
            );
        }
    }

    /// With the real policy roster the editor is live for the selected slot,
    /// and every rack row precomposes its one-swap whole orders (empty at
    /// the ends — the handler's honest at-that-end answer, not a write).
    #[test]
    fn nocturne_orders_the_rack_and_offers_the_socd_editor() {
        let mut payload = keyboard_payload();
        payload.staged.slots = two_staged_slots();
        payload.staged.socd_options = ksx_api::SocdOption::roster();
        let payload = payload.derived();
        let out = render_nocturne(&page(), &payload, None);
        assert!(out.html.contains("Opposites — P1"), "{}", out.html);
        assert!(
            !out.html.contains("n-socdform none"),
            "the SOCD editor should be live when the roster is served",
        );
        // Row 1's move-down and row 2's move-up both precompose "2 1"; the
        // end directions precompose empty orders.
        assert!(out.html.contains(r#"value="2 1""#), "{}", out.html);
    }
}
