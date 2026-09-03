//! Route-neutral slot adapters shared by the setup presentations.
//!
//! These values are part of the staged-workbench seam rather than a page
//! renderer. Keeping them here lets `/redesign` serialize shared device and
//! choice rows without coupling route and domain composition.

use forma_ir::parser::IrModule;
use forma_ir::slot::SlotValue;

use crate::snapshot::{NocturneDeviceRow, NocturneOtherRow};

fn html_text(out: &mut String, value: &str) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

fn html_attr(out: &mut String, name: &str, value: &str) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out.push('"');
}

fn open_tag(out: &mut String, tag: &str, attrs: &[(&str, &str)]) {
    out.push('<');
    out.push_str(tag);
    for (name, value) in attrs {
        html_attr(out, name, value);
    }
    out.push('>');
}

fn close_tag(out: &mut String, tag: &str) {
    out.push_str("</");
    out.push_str(tag);
    out.push('>');
}

fn text_tag(out: &mut String, tag: &str, class: &str, text: &str) {
    open_tag(out, tag, &[("class", class)]);
    html_text(out, text);
    close_tag(out, tag);
}

fn button(out: &mut String, class: &str, text: &str, attrs: &[(&str, &str)]) {
    out.push_str("<button type=\"button\"");
    html_attr(out, "class", class);
    for (name, value) in attrs {
        html_attr(out, name, value);
    }
    out.push('>');
    html_text(out, text);
    out.push_str("</button>");
}

/// Complete, escaped first-paint children for the redesign macro dialog.
///
/// The editor becomes client-owned after hydration, but a cold `?macro=` URL
/// must not paint an empty scrim and fill it a frame later. This markup is built
/// from the exact served projection the browser receives. The redesign
/// renderer inserts it into one explicitly marked empty host; every payload
/// value is escaped here before that narrowly scoped splice.
pub(crate) fn macro_dialog_ssr_html(mac: &crate::macro_editor::NocturneMacroEditor) -> String {
    if !mac.open {
        return String::new();
    }

    let mut out = String::with_capacity(24_000);

    // Header. The marker is the editor module's one-time adoption handshake.
    open_tag(
        &mut out,
        "div",
        &[("class", "n-machd"), ("data-rd-mac-ssr", "")],
    );
    text_tag(&mut out, "div", "nd-kick", "Macro");
    open_tag(
        &mut out,
        "div",
        &[("class", "nd-title"), ("id", "rd-mac-title")],
    );
    html_text(&mut out, &mac.name);
    close_tag(&mut out, "div");
    text_tag(&mut out, "div", "nd-lede", &mac.trigger);
    text_tag(&mut out, "div", "n-macmeta", &mac.head);
    open_tag(
        &mut out,
        "div",
        &[("class", "n-macdis"), ("id", "rd-mac-description")],
    );
    html_text(&mut out, &mac.note);
    close_tag(&mut out, "div");
    open_tag(
        &mut out,
        "div",
        &[("class", "n-macsay n-macsay-line none"), ("role", "status")],
    );
    close_tag(&mut out, "div");
    open_tag(
        &mut out,
        "a",
        &[
            ("class", "n-macx"),
            ("data-nx", "mac-close"),
            ("data-macfocus", "close-top"),
            ("aria-label", "Close the macro editor"),
            ("href", &mac.close_href),
        ],
    );
    html_text(&mut out, "✕");
    close_tag(&mut out, "a");
    close_tag(&mut out, "div");

    // Roll: step ledger beside grouped, roving-focus grid cells.
    open_tag(&mut out, "div", &[("class", &mac.grid_cls)]);
    open_tag(&mut out, "div", &[("class", "n-macbar")]);
    text_tag(&mut out, "div", "n-macbarhd", "step");
    for row in &mac.rows {
        open_tag(
            &mut out,
            "div",
            &[("class", &row.cls), ("title", &row.dur_title)],
        );
        text_tag(&mut out, "span", "n-macn", &row.n);
        text_tag(&mut out, "span", &row.hold_cls, &row.hold);
        open_tag(
            &mut out,
            "span",
            &[("class", &row.exp_cls), ("title", &row.exp)],
        );
        html_text(&mut out, &row.exp);
        close_tag(&mut out, "span");
        text_tag(&mut out, "span", "n-macdurw", &row.dur);
        open_tag(&mut out, "span", &[("class", "n-macdured")]);
        open_tag(
            &mut out,
            "input",
            &[
                ("type", "number"),
                ("min", "1"),
                ("step", "1"),
                ("value", &row.dur_val),
                ("title", &row.dur_title),
                ("data-macdur", &row.dur_row),
                ("class", &row.dur_cls),
            ],
        );
        button(
            &mut out,
            "n-macunit",
            &row.unit,
            &[("title", &row.unit_title), ("data-macact", &row.unit_act)],
        );
        close_tag(&mut out, "span");
        open_tag(
            &mut out,
            "span",
            &[("class", &row.warn_cls), ("title", &row.warn_title)],
        );
        html_text(&mut out, &row.warn);
        close_tag(&mut out, "span");
        open_tag(&mut out, "span", &[("class", "n-macverbs")]);
        button(
            &mut out,
            &row.up_cls,
            "▴",
            &[
                ("title", "Move this step up"),
                ("aria-label", "Move this step up"),
                ("data-macact", &row.up_act),
            ],
        );
        button(
            &mut out,
            &row.dn_cls,
            "▾",
            &[
                ("title", "Move this step down"),
                ("aria-label", "Move this step down"),
                ("data-macact", &row.dn_act),
            ],
        );
        button(
            &mut out,
            "n-macbtn",
            "⤒",
            &[
                ("title", "Insert a step above this one"),
                ("aria-label", "Insert a step above this one"),
                ("data-macact", &row.ia_act),
            ],
        );
        button(
            &mut out,
            "n-macbtn",
            "⤓",
            &[
                ("title", "Insert a step below this one"),
                ("aria-label", "Insert a step below this one"),
                ("data-macact", &row.ib_act),
            ],
        );
        button(
            &mut out,
            "n-macbtn del",
            "✕",
            &[
                ("title", &row.del_title),
                ("aria-label", &row.del_title),
                ("data-macact", &row.del_act),
            ],
        );
        close_tag(&mut out, "span");
        close_tag(&mut out, "div");
    }
    close_tag(&mut out, "div");

    open_tag(&mut out, "div", &[("class", "n-macscroll")]);
    open_tag(&mut out, "div", &[("class", "n-macgrps")]);
    for group in &mac.groups {
        open_tag(&mut out, "span", &[("class", &group.cls)]);
        text_tag(&mut out, "span", "n-macgrp-l", &group.label);
        text_tag(&mut out, "span", &group.count_cls, &group.count);
        close_tag(&mut out, "span");
    }
    close_tag(&mut out, "div");
    open_tag(&mut out, "div", &[("class", "n-maccols")]);
    for column in &mac.cols {
        open_tag(
            &mut out,
            "span",
            &[("class", &column.cls), ("title", &column.title)],
        );
        html_text(&mut out, &column.id);
        close_tag(&mut out, "span");
    }
    close_tag(&mut out, "div");

    let col_count = mac.cols.len().max(1);
    let row_count = mac.cells.len().div_ceil(col_count);
    let served_roving = mac
        .cells
        .iter()
        .find(|cell| cell.tab == "0")
        .or_else(|| mac.cells.first())
        .map(|cell| cell.cell.as_str());
    let col_count_text = mac.cols.len().to_string();
    let row_count_text = row_count.to_string();
    let matrix_style = format!("grid-template-columns: repeat({col_count}, var(--maccol-w));");
    let matrix_label = format!("Steps by control for {}", mac.name);
    open_tag(
        &mut out,
        "div",
        &[
            ("class", "n-macmatrix"),
            ("role", "grid"),
            ("aria-label", &matrix_label),
            ("aria-multiselectable", "true"),
            ("aria-colcount", &col_count_text),
            ("aria-rowcount", &row_count_text),
            ("style", &matrix_style),
        ],
    );
    for (row_index, cells) in mac.cells.chunks(col_count).enumerate() {
        let aria_row = (row_index + 1).to_string();
        let row_label = format!(
            "Step {}",
            mac.rows
                .get(row_index)
                .map_or_else(|| aria_row.as_str(), |row| row.n.as_str())
        );
        let row_style = format!(
            "display: grid; grid-template-columns: repeat({col_count}, var(--maccol-w)); grid-column: 1 / -1;"
        );
        open_tag(
            &mut out,
            "div",
            &[
                ("class", "n-macgridrow"),
                ("role", "row"),
                ("aria-rowindex", &aria_row),
                ("aria-label", &row_label),
                ("style", &row_style),
            ],
        );
        for (col_index, cell) in cells.iter().enumerate() {
            let aria_col = (col_index + 1).to_string();
            let tab = if served_roving == Some(cell.cell.as_str()) {
                "0"
            } else {
                "-1"
            };
            button(
                &mut out,
                &cell.cls,
                &cell.mark,
                &[
                    ("title", &cell.title),
                    ("aria-label", &cell.title),
                    ("aria-selected", &cell.on),
                    ("aria-rowindex", &aria_row),
                    ("aria-colindex", &aria_col),
                    ("role", "gridcell"),
                    ("tabindex", tab),
                    ("data-maccell", &cell.cell),
                ],
            );
        }
        close_tag(&mut out, "div");
    }
    close_tag(&mut out, "div");
    close_tag(&mut out, "div");
    close_tag(&mut out, "div");

    // Help and edit verbs.
    open_tag(&mut out, "details", &[("class", "n-machelp")]);
    open_tag(&mut out, "summary", &[("data-macfocus", "help")]);
    html_text(&mut out, "How to read this roll");
    close_tag(&mut out, "summary");
    text_tag(&mut out, "p", "n-macring", &mac.ring);
    text_tag(&mut out, "p", "n-macrule", &mac.rule);
    close_tag(&mut out, "details");
    open_tag(&mut out, "div", &[("class", "n-macedit")]);
    button(&mut out, "n-bbtn", "Add step", &[("data-macact", "add")]);
    button(
        &mut out,
        "n-bbtn ghost",
        "Allow a short step",
        &[("data-macact", "short")],
    );
    close_tag(&mut out, "div");

    open_tag(&mut out, "div", &[("class", "n-macmotions")]);
    text_tag(&mut out, "div", "n-kick", "Common motions");
    text_tag(&mut out, "p", "n-macmotline", &mac.motion_line);
    open_tag(&mut out, "div", &[("class", "n-macmotrow")]);
    for motion in &mac.motions {
        out.push_str("<button type=\"button\"");
        html_attr(&mut out, "class", "n-macmot");
        html_attr(&mut out, "title", &motion.title);
        html_attr(&mut out, "data-macmotion", &motion.act);
        out.push('>');
        text_tag(&mut out, "span", "n-macmot-s", &motion.shape);
        text_tag(&mut out, "span", "n-macmot-l", &motion.label);
        out.push_str("</button>");
    }
    close_tag(&mut out, "div");
    close_tag(&mut out, "div");

    open_tag(&mut out, "div", &[("class", "n-macpols")]);
    text_tag(&mut out, "div", "n-kick", "Behaviour");
    text_tag(&mut out, "p", "n-macpolline", &mac.policy_line);
    for policy in &mac.pols {
        open_tag(&mut out, "span", &[("class", "n-macpolw")]);
        text_tag(&mut out, "span", &policy.head_cls, &policy.head);
        text_tag(&mut out, "span", &policy.note_cls, &policy.note);
        button(
            &mut out,
            &policy.cls,
            &policy.label,
            &[("title", &policy.title), ("data-macpol", &policy.act)],
        );
        close_tag(&mut out, "span");
    }
    open_tag(&mut out, "label", &[("class", &mac.turbo_cls)]);
    text_tag(&mut out, "span", "n-macratel", &mac.turbo_label);
    open_tag(
        &mut out,
        "input",
        &[
            ("type", "number"),
            ("min", "1"),
            ("step", "1"),
            ("data-macrate", "1"),
            ("value", &mac.turbo_val),
        ],
    );
    close_tag(&mut out, "label");
    close_tag(&mut out, "div");

    open_tag(&mut out, "details", &[("class", "n-mactoml")]);
    open_tag(&mut out, "summary", &[("data-macfocus", "table")]);
    html_text(&mut out, "The table this writes");
    close_tag(&mut out, "summary");
    text_tag(&mut out, "pre", "n-mactomlbox", &mac.toml);
    close_tag(&mut out, "details");

    open_tag(&mut out, "div", &[("class", "n-macfoot")]);
    text_tag(&mut out, "span", "n-macdirty", "");
    button(
        &mut out,
        "n-bbtn n-macsave",
        "Save this macro",
        &[("data-macact", "save")],
    );
    open_tag(
        &mut out,
        "a",
        &[
            ("class", "n-bbtn ghost"),
            ("data-nx", "mac-close"),
            ("data-macfocus", "close-bottom"),
            ("href", &mac.close_href),
        ],
    );
    html_text(&mut out, "Close");
    close_tag(&mut out, "a");
    close_tag(&mut out, "div");

    out
}

pub(crate) fn device_row(row: &NocturneDeviceRow) -> SlotValue {
    SlotValue::object(vec![
        ("cls".to_owned(), SlotValue::Text(row.cls.clone())),
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
        ("role".to_owned(), SlotValue::Text(row.role.clone())),
        (
            "connection_label".to_owned(),
            SlotValue::Text(row.connection_label.clone()),
        ),
        (
            "connection_badge".to_owned(),
            SlotValue::Text(row.connection_badge.clone()),
        ),
        (
            "connection_state".to_owned(),
            SlotValue::Text(row.connection_state.clone()),
        ),
        (
            "instance_id".to_owned(),
            SlotValue::Text(row.instance_id.clone()),
        ),
        ("selector".to_owned(), SlotValue::Text(row.selector.clone())),
        ("alias".to_owned(), SlotValue::Text(row.alias.clone())),
        ("label".to_owned(), SlotValue::Text(row.label.clone())),
        (
            "aria_current".to_owned(),
            SlotValue::Text(row.aria_current.clone()),
        ),
        ("title".to_owned(), SlotValue::Text(row.title.clone())),
        (
            "chartReadable".to_owned(),
            SlotValue::Text(row.chart_readable.clone()),
        ),
        (
            "capture_badge".to_owned(),
            SlotValue::Text(row.capture_badge.clone()),
        ),
        (
            "capture_state".to_owned(),
            SlotValue::Text(row.capture_state.clone()),
        ),
        (
            "capture_cls".to_owned(),
            SlotValue::Text(row.capture_cls.clone()),
        ),
        (
            "capture_mode".to_owned(),
            SlotValue::Text(row.capture_mode.clone()),
        ),
        (
            "capture_detail".to_owned(),
            SlotValue::Text(row.capture_detail.clone()),
        ),
        (
            "capture_action_label".to_owned(),
            SlotValue::Text(row.capture_action_label.clone()),
        ),
        (
            "capture_can_prepare".to_owned(),
            SlotValue::Bool(row.capture_can_prepare),
        ),
        (
            "capture_can_release".to_owned(),
            SlotValue::Bool(row.capture_can_release),
        ),
    ])
}

pub(crate) fn other_row(row: &NocturneOtherRow) -> SlotValue {
    SlotValue::object(vec![
        ("name".to_owned(), SlotValue::Text(row.name.clone())),
        ("meta".to_owned(), SlotValue::Text(row.meta.clone())),
    ])
}

/// Slot ids of every slot named `name`, in slot-table/document order.
pub(crate) fn named_slot_ids(module: &IrModule, name: &str) -> Vec<u16> {
    module
        .slots
        .entries()
        .iter()
        .filter(|entry| {
            module
                .strings
                .get(entry.name_str_idx)
                .is_ok_and(|candidate| candidate == name)
        })
        .map(|entry| entry.slot_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_macro_has_no_server_children() {
        assert!(
            macro_dialog_ssr_html(&crate::macro_editor::NocturneMacroEditor::default()).is_empty()
        );
    }

    #[test]
    fn macro_server_fragment_escapes_domain_text_and_attributes() {
        let mac = crate::macro_editor::NocturneMacroEditor {
            open: true,
            name: "Dragon <script>alert(1)</script> & friends".into(),
            trigger: "K & H".into(),
            note: "Use < then >".into(),
            grid_cls: "n-macgrid".into(),
            close_href: "/redesign?macro=\"bad\"&slot=1".into(),
            cells: vec![crate::macro_editor::NocturneMacCell {
                cell: "0|a&b".into(),
                title: "A \"quoted\" cell".into(),
                on: "true".into(),
                tab: "0".into(),
                ..Default::default()
            }],
            ..Default::default()
        };

        let html = macro_dialog_ssr_html(&mac);
        assert!(html.contains("Dragon &lt;script&gt;alert(1)&lt;/script&gt; &amp; friends"));
        assert!(html.contains("K &amp; H"));
        assert!(html.contains("Use &lt; then &gt;"));
        assert!(html.contains("href=\"/redesign?macro=&quot;bad&quot;&amp;slot=1\""));
        assert!(html.contains("title=\"A &quot;quoted&quot; cell\""));
        assert!(html.contains("data-maccell=\"0|a&amp;b\""));
        assert!(!html.contains("<script>"));
        assert_eq!(html.matches("tabindex=\"0\"").count(), 1);
    }
}
