//! `ksx panel status` — passive encoder identity and HID capabilities.
//!
//! This is a read, not a programming transport. USB descriptors come from the
//! same enumeration as `ksx devices`; HID top-level collection metadata comes
//! from handles opened with desired access zero. No input, output, or feature
//! report is requested or sent, and the EEPROM chart remains an explicit
//! unattempted state until a read protocol is verified.

use std::fmt::Write as _;

use ksx_api::{
    PanelHidCollectionRow, PanelInterfaceRow, PanelStatusRow, PanelStatusSpec, PanelStatusView,
    Refusal,
};
use ksx_core::{DeviceSelector, Match};
use ksx_platform::hid::{HidCollection, HidSurvey};

use crate::devices::{self, DevicesReport, UsbRow};

const INSPECTION_NOTE: &str = "Read-only metadata inspection: HID handles used desired access 0; no input, output, or feature report was requested or sent.";

#[derive(Clone, Copy)]
struct PanelDriver {
    id: &'static str,
    label: &'static str,
}

/// Protocol drivers are intentionally separate from `ksx_core::vendors`, which
/// is display-only. Registering a board here means only that ksx recognises the
/// protocol family; v1 still declares chart/mode reads unsupported.
fn driver_for(vendor_id: u16, product_id: u16) -> Option<PanelDriver> {
    match (vendor_id, product_id) {
        (0xD209, 0x0430) => Some(PanelDriver {
            id: "ultimarc-ipac",
            label: "Ultimarc I-PAC protocol family recognised; read-back protocol unverified",
        }),
        _ => None,
    }
}

struct BoardGroup<'a> {
    board_id: String,
    interfaces: Vec<&'a UsbRow>,
    search_terms: Vec<String>,
}

/// Compose the typed status view from injected, already-collected facts.
///
/// Pure and cross-platform so grouping, selector resolution and every wording
/// decision run in CI without touching a USB device.
pub fn view(
    report: &DevicesReport,
    hid: &HidSurvey,
    spec: &PanelStatusSpec,
) -> Result<PanelStatusView, Refusal> {
    let groups = groups(report);
    if spec.device.is_some() && !report.usb_available {
        return Err(Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            "USB enumeration failed, so the selected panel could not be resolved; this is not evidence that it is absent",
            "restore USB enumeration, then run `ksx panel status --device` again",
        ));
    }
    let selected = resolve_groups(&groups, report, spec.device.as_deref())?;
    let mut panels = Vec::with_capacity(selected.len());
    for index in selected {
        panels.push(panel_row(&groups[index], hid));
    }

    let mut notes = Vec::new();
    if !report.usb_available {
        notes.push("USB enumeration failed; no empty result should be read as proof that no panel is connected".to_owned());
    }
    if !hid.available {
        notes.push(
            "HID collection enumeration was unavailable; collection rows were not read".to_owned(),
        );
    }
    notes.extend(hid.errors.iter().cloned());
    let unjoined = hid
        .collections
        .iter()
        .filter(|collection| collection.board_id.is_none())
        .count();
    if unjoined > 0 {
        notes.push(format!(
            "{unjoined} HID collection(s) could not be joined to a physical USB board; affected board status remains indeterminate"
        ));
    }

    let summary = match (spec.device.as_deref(), panels.len(), report.usb_available) {
        (_, _, false) => "Panel status is incomplete because USB enumeration failed".to_owned(),
        (Some(_), 1, _) => format!(
            "1 physical USB board matched; {} HID collection(s) were inspected",
            panels[0].hid_collections.len()
        ),
        (_, count, _) => format!(
            "{count} physical USB {} found; status lists all of them without choosing one",
            if count == 1 { "board" } else { "boards" }
        ),
    };
    let hid_complete = hid_inventory_complete(hid);
    let access_detail = match (report.usb_available, hid.available, hid_complete) {
        (true, true, true) => {
            "USB descriptors and passive HID collection metadata were readable"
        }
        (true, true, false) => {
            "USB descriptors were readable; HID collection metadata was only partially readable"
        }
        (true, false, _) => {
            "USB descriptors were readable; HID collection metadata was unavailable, not empty"
        }
        (false, true, true) => {
            "HID collection metadata was readable; USB board enumeration was unavailable"
        }
        (false, true, false) => {
            "USB board enumeration was unavailable; HID collection metadata was only partially readable"
        }
        (false, false, _) => "USB and HID metadata reads were both unavailable",
    };

    Ok(PanelStatusView {
        generated_at: stamp_utc(),
        summary,
        inspection_note: INSPECTION_NOTE.to_owned(),
        access_detail: access_detail.to_owned(),
        usb_available: report.usb_available,
        hid_available: hid.available,
        panels,
        notes,
    })
}

fn hid_inventory_complete(hid: &HidSurvey) -> bool {
    hid.available
        && hid.errors.is_empty()
        && hid.collections.iter().all(|collection| {
            collection.board_id.is_some()
                && collection.attributes.is_some()
                && collection.capabilities.is_some()
                && collection.errors.is_empty()
        })
}

fn groups(report: &DevicesReport) -> Vec<BoardGroup<'_>> {
    let selectors = devices::suggested_selectors(&report.usb);
    let mut groups: Vec<BoardGroup<'_>> = Vec::new();
    for (index, row) in report.usb.iter().enumerate() {
        let board_id = &row.candidate.parent_id;
        let at = groups
            .iter()
            .position(|group| group.board_id.eq_ignore_ascii_case(board_id));
        let group = match at {
            Some(at) => &mut groups[at],
            None => {
                groups.push(BoardGroup {
                    board_id: board_id.clone(),
                    interfaces: Vec::new(),
                    search_terms: vec![board_id.clone()],
                });
                groups.last_mut().expect("just pushed")
            }
        };
        group.interfaces.push(row);
        group
            .search_terms
            .push(row.candidate.id.as_str().to_owned());
        if let Some(selector) = selectors.get(index) {
            group.search_terms.push(selector.clone());
        }
        if let Some(alias) = &row.alias {
            group.search_terms.push(alias.clone());
        }
        if let Some(serial) = &row.candidate.serial {
            group.search_terms.push(serial.clone());
        }
        if let Some(name) = row.candidate.friendly() {
            group.search_terms.push(name.to_owned());
        }
        if let Some(name) =
            ksx_core::vendors::name_for(row.candidate.vendor_id, row.candidate.product_id)
        {
            group.search_terms.push(name.to_owned());
        }
    }
    groups
}

fn resolve_groups(
    groups: &[BoardGroup<'_>],
    report: &DevicesReport,
    query: Option<&str>,
) -> Result<Vec<usize>, Refusal> {
    let Some(query) = query else {
        return Ok((0..groups.len()).collect());
    };
    let query = query.trim();
    if query.is_empty() {
        return Err(unknown_refusal(query, groups));
    }

    // Printed board/interface ids and aliases are first-class selectors too.
    // Some PnP paths are also parseable as a generic DeviceSelector; honour
    // the exact inventory spelling before asking that parser to interpret it.
    let exact: Vec<usize> = groups
        .iter()
        .enumerate()
        .filter(|(_, group)| {
            group
                .search_terms
                .iter()
                .any(|term| term.eq_ignore_ascii_case(query))
        })
        .map(|(index, _)| index)
        .collect();
    if !exact.is_empty() {
        return one_or_refusal(query, exact, groups);
    }

    // Stable `usb:vid:pid:mi...` selectors are the normal value supplied by a
    // staged setup. Resolve them through DeviceSelector itself rather than
    // pretending their text is a PnP-path substring.
    if let Ok(selector) = DeviceSelector::parse(query) {
        let facts: Vec<_> = report.usb.iter().map(|row| row.candidate.facts()).collect();
        let matching_ids: Vec<String> = match selector.match_against(&facts) {
            Match::None => Vec::new(),
            Match::One(facts) => vec![facts.id.as_str().to_owned()],
            Match::Ambiguous(found) => found
                .iter()
                .map(|facts| facts.id.as_str().to_owned())
                .collect(),
        };
        let matched = dedup_group_indices(groups, matching_ids.iter().map(String::as_str));
        return one_or_refusal(query, matched, groups);
    }

    let needle = query.to_lowercase();
    let matched = groups
        .iter()
        .enumerate()
        .filter(|(_, group)| {
            group
                .search_terms
                .iter()
                .any(|term| term.to_lowercase().contains(&needle))
        })
        .map(|(index, _)| index)
        .collect();
    one_or_refusal(query, matched, groups)
}

fn dedup_group_indices<'a>(
    groups: &[BoardGroup<'_>],
    ids: impl Iterator<Item = &'a str>,
) -> Vec<usize> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(index) = groups.iter().position(|group| {
            group
                .interfaces
                .iter()
                .any(|row| row.candidate.id.as_str().eq_ignore_ascii_case(id))
        }) {
            if !out.contains(&index) {
                out.push(index);
            }
        }
    }
    out
}

fn one_or_refusal(
    query: &str,
    matched: Vec<usize>,
    groups: &[BoardGroup<'_>],
) -> Result<Vec<usize>, Refusal> {
    match matched.as_slice() {
        [one] => Ok(vec![*one]),
        [] => Err(unknown_refusal(query, groups)),
        many => Err(Refusal::with_remedy(
            ksx_api::codes::BAD_REQUEST,
            format!(
                "panel selector '{query}' matches more than one physical board: {}",
                many.iter()
                    .map(|&index| groups[index].board_id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "pass a full board, interface, serial, or port-pinned selector to `ksx panel status --device`",
        )),
    }
}

fn unknown_refusal(query: &str, groups: &[BoardGroup<'_>]) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::BAD_REQUEST,
        format!(
            "panel selector '{query}' matches no physical USB board; connected boards: {}",
            if groups.is_empty() {
                "none".to_owned()
            } else {
                groups
                    .iter()
                    .map(|group| group.board_id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
        "run `ksx panel status` without --device to list every candidate",
    )
}

fn panel_row(group: &BoardGroup<'_>, hid: &HidSurvey) -> PanelStatusRow {
    let first = &group.interfaces[0].candidate;
    let driver = driver_for(first.vendor_id, first.product_id);
    let mut collections: Vec<&HidCollection> = hid
        .collections
        .iter()
        .filter(|collection| {
            collection
                .board_id
                .as_deref()
                .is_some_and(|board| board.eq_ignore_ascii_case(&group.board_id))
        })
        .collect();
    collections.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));

    let keyboard_collection = collections.iter().find(|collection| {
        collection
            .capabilities
            .is_some_and(|caps| caps.usage_page == 0x0001 && caps.usage == 0x0006)
    });
    let boot = group
        .interfaces
        .iter()
        .find(|row| row.candidate.is_boot_keyboard());
    let (observed_mode, observed_mode_label, mode_detail) = if let Some(row) = boot {
        (
            "keyboard-compatible",
            "Keyboard-compatible input is present",
            format!(
                "{} declares the HID boot-keyboard protocol; exact vendor mode was not queried",
                row.candidate.id
            ),
        )
    } else if let Some(collection) = keyboard_collection {
        (
            "keyboard-compatible",
            "Keyboard-compatible input is present",
            format!(
                "{} declares Generic Desktop / Keyboard; exact vendor mode was not queried",
                collection.instance_id
            ),
        )
    } else {
        (
            "unknown",
            "Exact encoder mode is unknown",
            "No keyboard interface or keyboard-usage collection was observed; ksx did not guess XInput or another vendor mode".to_owned(),
        )
    };

    let config_candidates: Vec<&HidCollection> = collections
        .iter()
        .copied()
        .filter(|collection| {
            collection
                .capabilities
                .is_some_and(|caps| caps.input_report_bytes == 5 && caps.output_report_bytes == 5)
        })
        .collect();
    let uncertain_unjoined_collection = hid.collections.iter().any(|collection| {
        collection.board_id.is_none()
            && collection.attributes.is_none_or(|attributes| {
                attributes.vendor_id == first.vendor_id && attributes.product_id == first.product_id
            })
    });
    let board_hid_incomplete = !hid.available
        || !hid.errors.is_empty()
        || uncertain_unjoined_collection
        || collections.iter().any(|collection| {
            collection.attributes.is_none()
                || collection.capabilities.is_none()
                || !collection.errors.is_empty()
        });
    let (configuration_collection_state, configuration_collection, configuration_collection_detail) =
        if driver.is_none() {
            (
            "unsupported-driver",
            None,
            "No panel protocol driver is registered, so no configuration collection was selected".to_owned(),
        )
        } else if board_hid_incomplete {
            (
            "unavailable",
            None,
            "HID collection metadata was incomplete; this is not evidence that the board has no configuration collection".to_owned(),
        )
        } else {
            match config_candidates.as_slice() {
            [candidate] => (
                "candidate-unverified",
                Some(candidate.instance_id.clone()),
                "One 5-byte IN/OUT HID collection matches the unverified transport shape; ksx sent nothing".to_owned(),
            ),
            [] => (
                "not-found",
                None,
                "No 5-byte IN/OUT HID collection was observed; no report transaction was attempted".to_owned(),
            ),
            many => (
                "ambiguous",
                None,
                format!(
                    "{} HID collections match the unverified 5-byte shape; ksx refused to choose one",
                    many.len()
                ),
            ),
        }
        };

    let (chart_state, chart_label, chart_detail, recommendation) = match (driver, observed_mode) {
        (Some(_), "keyboard-compatible") => (
            "protocol-unverified",
            "Chart not read — protocol unverified",
            "No verified chart-query opcode or response framing exists in ksx; an empty chart was not fabricated",
            "Keep using the keyboard capture path; panel programming stays unavailable until read-back and backup are proven",
        ),
        (Some(_), _) => (
            "protocol-unverified",
            "Chart not read — protocol unverified",
            "No verified chart-query opcode or response framing exists in ksx; an empty chart was not fabricated",
            "Restore a documented keyboard-compatible mode before relying on ksx input; this survey did not guess the current vendor mode",
        ),
        (None, _) => (
            "unsupported-driver",
            "Chart not read — no panel protocol driver",
            "ksx reported passive USB/HID metadata only",
            "No panel protocol driver is registered for this board; use the identity and collection facts for support or driver development",
        ),
    };

    let name = ksx_core::vendors::name_for(first.vendor_id, first.product_id)
        .or_else(|| first.friendly())
        .unwrap_or(&group.board_id)
        .to_owned();
    let identity = format!(
        "USB VID {:04X}, PID {:04X}, raw bcdDevice 0x{:04X}",
        first.vendor_id, first.product_id, first.bcd_device
    );
    let mut interfaces: Vec<PanelInterfaceRow> = group
        .interfaces
        .iter()
        .map(|row| PanelInterfaceRow {
            instance_id: row.candidate.id.as_str().to_owned(),
            interface_number: row.candidate.interface_number,
            interface_class: row.candidate.interface_class,
            interface_subclass: row.candidate.interface_subclass,
            interface_protocol: row.candidate.interface_protocol,
            binding: row.candidate.binding.label().to_owned(),
            boot_keyboard: row.candidate.is_boot_keyboard(),
            description: row.candidate.friendly().unwrap_or_default().to_owned(),
        })
        .collect();
    interfaces.sort_by_key(|row| (row.interface_number, row.instance_id.clone()));

    PanelStatusRow {
        board_id: group.board_id.clone(),
        name,
        identity,
        vendor_id: first.vendor_id,
        product_id: first.product_id,
        bcd_device: first.bcd_device,
        serial: first.serial.clone(),
        driver: driver.map_or("unsupported", |driver| driver.id).to_owned(),
        driver_supported: driver.is_some(),
        driver_label: driver.map_or("No panel protocol driver registered".to_owned(), |driver| {
            driver.label.to_owned()
        }),
        observed_mode: observed_mode.to_owned(),
        mode_detail,
        observed_mode_label: observed_mode_label.to_owned(),
        mode_read_supported: false,
        chart_state: chart_state.to_owned(),
        chart_attempted: false,
        chart_detail: chart_detail.to_owned(),
        chart_label: chart_label.to_owned(),
        configuration_collection_state: configuration_collection_state.to_owned(),
        configuration_collection,
        configuration_collection_detail,
        recommendation: recommendation.to_owned(),
        interfaces,
        hid_collections: collections.into_iter().map(hid_row).collect(),
    }
}

fn hid_row(collection: &HidCollection) -> PanelHidCollectionRow {
    let state = match (
        collection.attributes.is_some(),
        collection.capabilities.is_some(),
        collection.errors.is_empty(),
    ) {
        (true, true, true) => "available",
        (false, false, _) => "unavailable",
        _ => "partial",
    };
    PanelHidCollectionRow {
        instance_id: collection.instance_id.clone(),
        state: state.to_owned(),
        vendor_id: collection.attributes.map(|attributes| attributes.vendor_id),
        product_id: collection
            .attributes
            .map(|attributes| attributes.product_id),
        version_number: collection
            .attributes
            .map(|attributes| attributes.version_number),
        usage_page: collection
            .capabilities
            .map(|capabilities| capabilities.usage_page),
        usage: collection
            .capabilities
            .map(|capabilities| capabilities.usage),
        input_report_bytes: collection
            .capabilities
            .map(|capabilities| capabilities.input_report_bytes),
        output_report_bytes: collection
            .capabilities
            .map(|capabilities| capabilities.output_report_bytes),
        feature_report_bytes: collection
            .capabilities
            .map(|capabilities| capabilities.feature_report_bytes),
        errors: collection.errors.clone(),
    }
}

/// Human rendering of the typed view. Every judgement arrives already composed
/// on the view so this stays a terminal layout, not a second policy engine.
pub fn render(view: &PanelStatusView) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Panel encoder status");
    let _ = writeln!(out, "{}", view.summary);
    let _ = writeln!(out, "{}\n", view.inspection_note);
    let _ = writeln!(out, "Inspection access: {}\n", view.access_detail);
    for panel in &view.panels {
        let _ = writeln!(out, "{}", panel.name);
        let _ = writeln!(out, "  board       : {}", panel.board_id);
        let _ = writeln!(out, "  identity    : {}", panel.identity);
        let _ = writeln!(out, "  driver      : {}", panel.driver_label);
        let _ = writeln!(out, "  mode        : {}", panel.observed_mode_label);
        let _ = writeln!(out, "                {}", panel.mode_detail);
        let _ = writeln!(out, "  chart       : {}", panel.chart_label);
        let _ = writeln!(out, "                {}", panel.chart_detail);
        let _ = writeln!(
            out,
            "  config HID  : {}",
            panel.configuration_collection_detail
        );
        let _ = writeln!(out, "  next        : {}", panel.recommendation);
        let _ = writeln!(out, "  interfaces  :");
        for interface in &panel.interfaces {
            let _ = writeln!(
                out,
                "    MI_{:02X} class {:02X}/{:02X}/{:02X} {}{}",
                interface.interface_number,
                interface.interface_class,
                interface.interface_subclass,
                interface.interface_protocol,
                interface.binding,
                if interface.boot_keyboard {
                    " (boot keyboard)"
                } else {
                    ""
                }
            );
        }
        let _ = writeln!(out, "  HID collections:");
        if panel.hid_collections.is_empty() {
            let _ = writeln!(out, "    none observed (or collection read unavailable)");
        }
        for collection in &panel.hid_collections {
            let _ = writeln!(
                out,
                "    {}  {}  usage {:04X}:{:04X}  reports in/out/feature {}/{}/{}",
                collection.instance_id,
                collection.state,
                collection.usage_page.unwrap_or(0),
                collection.usage.unwrap_or(0),
                optional_number(collection.input_report_bytes),
                optional_number(collection.output_report_bytes),
                optional_number(collection.feature_report_bytes),
            );
            for error in &collection.errors {
                let _ = writeln!(out, "      WARN: {error}");
            }
        }
        out.push('\n');
    }
    for note in &view.notes {
        let _ = writeln!(out, "NOTE: {note}");
    }
    out
}

fn optional_number(value: Option<u16>) -> String {
    value.map_or_else(|| "?".to_owned(), |value| value.to_string())
}

#[cfg(windows)]
fn stamp_utc() -> String {
    let t = ksx_config::Timestamp::now_utc();
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

#[cfg(not(windows))]
fn stamp_utc() -> String {
    String::new()
}

/// Collect and print one passive status report.
#[cfg(windows)]
pub fn run(device: Option<String>, json: bool) -> anyhow::Result<()> {
    let report = devices::collect();
    let hid = ksx_platform::hid::survey();
    let status = view(&report, &hid, &PanelStatusSpec { device })?;
    if json {
        println!("{}", serde_json::to_string_pretty(&status)?);
    } else {
        print!("{}", render(&status));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn run(_device: Option<String>, _json: bool) -> anyhow::Result<()> {
    anyhow::bail!("`ksx panel status` enumerates Windows USB/HID devices and is Windows-only")
}

#[cfg(test)]
mod tests {
    use ksx_capture::winusb::Binding;
    use ksx_core::DeviceId;
    use ksx_platform::hid::{HidAttributes, HidCapabilities};

    use super::*;

    fn usb(parent: &str, mi: u8, class: u8, subclass: u8, protocol: u8) -> UsbRow {
        let board = parent.rsplit('\\').next().unwrap_or("BOARD");
        UsbRow {
            candidate: ksx_capture::UsbCandidate {
                id: DeviceId::new(format!(
                    r"USB\VID_D209&PID_0430&MI_{mi:02X}\7&{board}&0&00{mi:02X}"
                )),
                parent_id: parent.to_owned(),
                vendor_id: 0xD209,
                product_id: 0x0430,
                bcd_device: 0x0056,
                interface_number: mi,
                interface_class: class,
                interface_subclass: subclass,
                interface_protocol: protocol,
                interface_string: None,
                product: Some("I-PAC Ultimate I/O".to_owned()),
                serial: Some("4".to_owned()),
                device_desc: Some("USB Input Device".to_owned()),
                port_chain: vec![1, 4],
                bus_id: "1".to_owned(),
                binding: Binding::HidUsb,
            },
            alias: None,
            selected: false,
        }
    }

    fn report(rows: Vec<UsbRow>) -> DevicesReport {
        DevicesReport::build(
            Vec::new(),
            false,
            rows,
            true,
            Vec::new(),
            true,
            devices::ConfiguredDevices::default(),
        )
    }

    fn collection(board: &str, id: &str, input: u16, output: u16) -> HidCollection {
        HidCollection {
            instance_id: id.to_owned(),
            device_path: format!(r"\\?\hid#{id}"),
            board_id: Some(board.to_owned()),
            attributes: Some(HidAttributes {
                vendor_id: 0xD209,
                product_id: 0x0430,
                version_number: 0x0056,
            }),
            capabilities: Some(HidCapabilities {
                usage_page: 1,
                usage: 0,
                input_report_bytes: input,
                output_report_bytes: output,
                feature_report_bytes: 0,
            }),
            errors: Vec::new(),
        }
    }

    #[test]
    fn three_interfaces_collapse_to_one_board_and_keep_raw_release() {
        let board = r"USB\VID_D209&PID_0430\4";
        let report = report(vec![
            usb(board, 0, 3, 1, 1),
            usb(board, 1, 3, 0, 0),
            usb(board, 2, 3, 0, 0),
        ]);
        let hid = HidSurvey {
            available: true,
            collections: vec![
                collection(board, r"HID\IPAC&MI_02&COL01\1", 5, 5),
                collection(board, r"HID\IPAC&MI_02&COL02\2", 97, 97),
            ],
            errors: Vec::new(),
        };

        let status = view(&report, &hid, &PanelStatusSpec::default()).unwrap();
        assert_eq!(
            status.summary,
            "1 physical USB board found; status lists all of them without choosing one"
        );
        assert_eq!(status.inspection_note, INSPECTION_NOTE);
        assert_eq!(
            status.access_detail,
            "USB descriptors and passive HID collection metadata were readable"
        );
        assert_eq!(status.panels.len(), 1);
        let panel = &status.panels[0];
        assert_eq!(panel.interfaces.len(), 3);
        assert_eq!(panel.bcd_device, 0x0056);
        assert!(panel.identity.contains("raw bcdDevice 0x0056"));
        assert_eq!(panel.driver, "ultimarc-ipac");
        assert_eq!(
            panel.driver_label,
            "Ultimarc I-PAC protocol family recognised; read-back protocol unverified"
        );
        assert_eq!(panel.observed_mode, "keyboard-compatible");
        assert_eq!(
            panel.observed_mode_label,
            "Keyboard-compatible input is present"
        );
        assert_eq!(panel.chart_state, "protocol-unverified");
        assert_eq!(panel.chart_label, "Chart not read — protocol unverified");
        assert!(!panel.chart_attempted);
        assert_eq!(panel.configuration_collection_state, "candidate-unverified");
        assert_eq!(
            panel.configuration_collection_detail,
            "One 5-byte IN/OUT HID collection matches the unverified transport shape; ksx sent nothing"
        );
        assert_eq!(
            panel.configuration_collection.as_deref(),
            Some(r"HID\IPAC&MI_02&COL01\1")
        );
        assert_eq!(
            panel.recommendation,
            "Keep using the keyboard capture path; panel programming stays unavailable until read-back and backup are proven"
        );
    }

    #[test]
    fn stable_device_selector_resolves_and_twins_are_never_guessed() {
        let a = r"USB\VID_D209&PID_0430\A";
        let b = r"USB\VID_D209&PID_0430\B";
        let one = report(vec![usb(a, 0, 3, 1, 1)]);
        let selected = view(
            &one,
            &HidSurvey::default(),
            &PanelStatusSpec {
                device: Some("usb:d209:0430:00".to_owned()),
            },
        )
        .unwrap();
        assert_eq!(selected.panels[0].board_id, a);
        let selected_by_printed_board = view(
            &one,
            &HidSurvey::default(),
            &PanelStatusSpec {
                device: Some(a.to_owned()),
            },
        )
        .unwrap();
        assert_eq!(selected_by_printed_board.panels[0].board_id, a);

        let twins = report(vec![usb(a, 0, 3, 1, 1), usb(b, 0, 3, 1, 1)]);
        let all = view(&twins, &HidSurvey::default(), &PanelStatusSpec::default()).unwrap();
        assert_eq!(
            all.panels.len(),
            2,
            "an unfiltered status lists every board"
        );
        let error = view(
            &twins,
            &HidSurvey::default(),
            &PanelStatusSpec {
                device: Some("usb:d209:0430:00".to_owned()),
            },
        )
        .unwrap_err();
        assert!(error.message.contains("more than one physical board"));
    }

    #[test]
    fn failed_usb_read_never_becomes_a_missing_selected_board() {
        let mut blind = report(Vec::new());
        blind.usb_available = false;
        let error = view(
            &blind,
            &HidSurvey::default(),
            &PanelStatusSpec {
                device: Some("usb:d209:0430:00".to_owned()),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ksx_api::codes::REFUSED);
        assert!(error.message.contains("USB enumeration failed"));
        assert!(!error.message.contains("matches no physical USB board"));
    }

    #[test]
    fn missing_hid_read_is_not_rendered_as_no_configuration_collection() {
        let board = r"USB\VID_D209&PID_0430\4";
        let status = view(
            &report(vec![usb(board, 0, 3, 1, 1)]),
            &HidSurvey {
                available: false,
                collections: Vec::new(),
                errors: vec!["SetupAPI unavailable".to_owned()],
            },
            &PanelStatusSpec::default(),
        )
        .unwrap();
        assert!(!status.hid_available);
        assert_eq!(
            status.access_detail,
            "USB descriptors were readable; HID collection metadata was unavailable, not empty"
        );
        assert_eq!(
            status.panels[0].configuration_collection_state,
            "unavailable"
        );
        assert!(status
            .notes
            .iter()
            .any(|note| note == "SetupAPI unavailable"));
    }

    #[test]
    fn partial_hid_inventory_never_becomes_no_configuration_collection() {
        let board = r"USB\VID_D209&PID_0430\4";
        let usb = report(vec![usb(board, 0, 3, 1, 1)]);

        let global_error = view(
            &usb,
            &HidSurvey {
                available: true,
                collections: Vec::new(),
                errors: vec!["HID interface enumeration stopped at index 3".to_owned()],
            },
            &PanelStatusSpec::default(),
        )
        .unwrap();
        assert_eq!(
            global_error.panels[0].configuration_collection_state,
            "unavailable"
        );
        assert!(global_error.access_detail.contains("partially readable"));

        let mut failed_caps = collection(board, r"HID\IPAC&MI_02&COL01\1", 5, 5);
        failed_caps.capabilities = None;
        failed_caps.errors.push("HidP_GetCaps failed".to_owned());
        let joined_error = view(
            &usb,
            &HidSurvey {
                available: true,
                collections: vec![failed_caps],
                errors: Vec::new(),
            },
            &PanelStatusSpec::default(),
        )
        .unwrap();
        assert_eq!(
            joined_error.panels[0].configuration_collection_state,
            "unavailable"
        );

        let mut unjoined = collection(board, r"HID\IPAC&MI_02&COL01\2", 5, 5);
        unjoined.board_id = None;
        let unjoined_error = view(
            &usb,
            &HidSurvey {
                available: true,
                collections: vec![unjoined],
                errors: Vec::new(),
            },
            &PanelStatusSpec::default(),
        )
        .unwrap();
        assert_eq!(
            unjoined_error.panels[0].configuration_collection_state,
            "unavailable"
        );
        assert!(unjoined_error
            .notes
            .iter()
            .any(|note| note.contains("could not be joined")));
    }

    #[test]
    fn unsupported_and_non_keyboard_candidates_remain_visible_with_exact_states() {
        let board = r"USB\VID_1209&PID_0001\UNKNOWN";
        let mut unknown = usb(board, 0, 0xFF, 0, 0);
        unknown.candidate.vendor_id = 0x1209;
        unknown.candidate.product_id = 0x0001;
        unknown.candidate.product = Some("Custom encoder".to_owned());
        let status = view(
            &report(vec![unknown]),
            &HidSurvey {
                available: true,
                collections: Vec::new(),
                errors: Vec::new(),
            },
            &PanelStatusSpec::default(),
        )
        .unwrap();
        assert_eq!(status.panels.len(), 1, "unknown boards are not dropped");
        let panel = &status.panels[0];
        assert_eq!(panel.driver, "unsupported");
        assert!(!panel.driver_supported);
        assert_eq!(panel.observed_mode, "unknown");
        assert_eq!(panel.chart_state, "unsupported-driver");
        assert_eq!(panel.configuration_collection_state, "unsupported-driver");
    }

    #[test]
    fn human_report_pins_the_no_report_transaction_boundary() {
        let board = r"USB\VID_D209&PID_0430\4";
        let status = view(
            &report(vec![usb(board, 0, 3, 1, 1)]),
            &HidSurvey::default(),
            &PanelStatusSpec::default(),
        )
        .unwrap();
        let text = render(&status);
        assert!(text.contains("desired access 0"));
        assert!(text.contains("no input, output, or feature report was requested or sent"));
        assert!(text.contains("Chart not read"));
    }
}
