//! Passive panel-family recognition and exact protocol-profile admission.
//!
//! These two tables deliberately answer different questions:
//!
//! - [`family_for`] recognizes a physical encoder from an exact USB VID/PID.
//!   Recognition may choose the arcade-encoder UX, but authorizes no report.
//! - [`profile_for`] admits one exact, measured firmware/profile tuple. Only a
//!   profile may advertise chart reads or persistent writes.
//!
//! Keeping those questions separate lets KSX recognize useful hardware from
//! public identity evidence without silently borrowing another board's packet
//! format. Display-only USB names remain in `ksx_core::vendors`.

use ksx_api::PanelDriverCapabilities;

/// A physical encoder family recognized from one exact USB VID/PID pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PanelFamily {
    pub id: &'static str,
    pub label: &'static str,
    pub vendor_id: u16,
    pub product_id: u16,
}

/// The protocol implementation selected only after an exact profile match.
///
/// An enum is sufficient while KSX has one measured protocol. It creates the
/// dispatch seam without pretending the I-PAC-specific chart model is already
/// a generic multi-vendor trait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PanelProtocolDriver {
    Ipac4Pac256V1,
}

/// Passive HID metadata which must identify the configuration collection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PanelCollectionRule {
    pub interface_token: &'static str,
    pub usage_page: u16,
    pub usage: u16,
    pub input_report_bytes: u16,
    pub output_report_bytes: u16,
}

impl PanelCollectionRule {
    pub(crate) fn matches(
        self,
        instance_id: &str,
        usage_page: u16,
        usage: u16,
        input_report_bytes: u16,
        output_report_bytes: u16,
    ) -> bool {
        instance_id
            .to_ascii_uppercase()
            .contains(self.interface_token)
            && usage_page == self.usage_page
            && usage == self.usage
            && input_report_bytes == self.input_report_bytes
            && output_report_bytes == self.output_report_bytes
    }
}

/// One exact firmware/profile tuple with independently measured capabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PanelProtocolProfile {
    pub family_id: &'static str,
    pub bcd_device: u16,
    pub driver: PanelProtocolDriver,
    pub driver_id: &'static str,
    pub driver_label: &'static str,
    pub protocol_profile: &'static str,
    pub firmware_label: &'static str,
    pub firmware_detail: &'static str,
    pub terminal_count: usize,
    pub capabilities: PanelDriverCapabilities,
    pub collection: PanelCollectionRule,
}

const FAMILIES: &[PanelFamily] = &[
    PanelFamily {
        id: "ultimarc-ipac-legacy",
        label: "Ultimarc legacy I-PAC series",
        vendor_id: 0xD208,
        product_id: 0x0310,
    },
    PanelFamily {
        id: "ultimarc-ipac-ultimate-io",
        label: "Ultimarc I-PAC Ultimate I/O",
        vendor_id: 0xD209,
        product_id: 0x0410,
    },
    PanelFamily {
        id: "ultimarc-ipac2",
        label: "Ultimarc I-PAC 2",
        vendor_id: 0xD209,
        product_id: 0x0420,
    },
    PanelFamily {
        id: "ultimarc-ipac4",
        label: "Ultimarc I-PAC 4X",
        vendor_id: 0xD209,
        product_id: 0x0430,
    },
    PanelFamily {
        id: "ultimarc-minipac",
        label: "Ultimarc Mini-PAC",
        vendor_id: 0xD209,
        product_id: 0x0440,
    },
    PanelFamily {
        id: "ultimarc-jpac",
        label: "Ultimarc J-PAC",
        vendor_id: 0xD209,
        product_id: 0x0450,
    },
    PanelFamily {
        id: "ultimarc-uhid",
        label: "Ultimarc U-HID",
        vendor_id: 0xD209,
        product_id: 0x1501,
    },
];

const PROFILES: &[PanelProtocolProfile] = &[PanelProtocolProfile {
    family_id: "ultimarc-ipac4",
    bcd_device: 0x0056,
    driver: PanelProtocolDriver::Ipac4Pac256V1,
    driver_id: "ultimarc-ipac",
    driver_label: "Ultimarc I-PAC 4 lossless chart driver",
    protocol_profile: "ipac4-pac256-v1",
    firmware_label: "1.56",
    firmware_detail: "Measured KSX I-PAC 4 release-0056 profile matched USB bcdDevice 0x0056; firmware was not queried from the board.",
    terminal_count: 56,
    capabilities: PanelDriverCapabilities {
        can_identify: true,
        can_report_mode: false,
        can_read_chart: true,
        can_write_chart: true,
        write_is_persistent: true,
    },
    collection: PanelCollectionRule {
        interface_token: "&MI_02&",
        usage_page: 0x0001,
        usage: 0x0000,
        input_report_bytes: 5,
        output_report_bytes: 5,
    },
}];

/// Recognize an encoder family without authorizing any protocol transaction.
pub(crate) fn family_for(vendor_id: u16, product_id: u16) -> Option<&'static PanelFamily> {
    FAMILIES
        .iter()
        .find(|family| family.vendor_id == vendor_id && family.product_id == product_id)
}

/// Return the one exact measured protocol profile for this release, if any.
pub(crate) fn profile_for(
    vendor_id: u16,
    product_id: u16,
    bcd_device: u16,
) -> Option<&'static PanelProtocolProfile> {
    let family = family_for(vendor_id, product_id)?;
    PROFILES
        .iter()
        .find(|profile| profile.family_id == family.id && profile.bcd_device == bcd_device)
}

/// Capabilities for passive status. A recognized family without a measured
/// profile can be identified but cannot report mode, read, or write a chart.
pub(crate) fn capabilities_for(
    family: Option<&PanelFamily>,
    profile: Option<&PanelProtocolProfile>,
) -> PanelDriverCapabilities {
    profile.map_or_else(
        || PanelDriverCapabilities {
            can_identify: family.is_some(),
            ..PanelDriverCapabilities::default()
        },
        |profile| profile.capabilities,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn family_and_profile_keys_are_unique_and_profiles_name_a_family() {
        let family_keys = FAMILIES
            .iter()
            .map(|family| (family.vendor_id, family.product_id))
            .collect::<BTreeSet<_>>();
        let family_ids = FAMILIES
            .iter()
            .map(|family| family.id)
            .collect::<BTreeSet<_>>();
        assert_eq!(family_keys.len(), FAMILIES.len());
        assert_eq!(family_ids.len(), FAMILIES.len());

        let profile_keys = PROFILES
            .iter()
            .map(|profile| (profile.family_id, profile.bcd_device))
            .collect::<BTreeSet<_>>();
        let profile_ids = PROFILES
            .iter()
            .map(|profile| profile.protocol_profile)
            .collect::<BTreeSet<_>>();
        assert_eq!(profile_keys.len(), PROFILES.len());
        assert_eq!(profile_ids.len(), PROFILES.len());
        for profile in PROFILES {
            assert!(FAMILIES.iter().any(|family| family.id == profile.family_id));
            assert!(profile.capabilities.can_identify);
            if profile.capabilities.can_write_chart {
                assert!(profile.capabilities.can_read_chart);
                assert!(profile.capabilities.write_is_persistent);
            }
        }
    }

    #[test]
    fn recognition_never_borrows_the_only_measured_protocol_profile() {
        for (vid, pid) in [
            (0xD208, 0x0310),
            (0xD209, 0x0410),
            (0xD209, 0x0420),
            (0xD209, 0x0440),
            (0xD209, 0x0450),
            (0xD209, 0x1501),
        ] {
            assert!(family_for(vid, pid).is_some(), "{vid:04X}:{pid:04X}");
            assert!(
                profile_for(vid, pid, 0x0056).is_none(),
                "{vid:04X}:{pid:04X}"
            );
        }
        assert!(family_for(0xD209, 0x0430).is_some());
        assert!(profile_for(0xD209, 0x0430, 0x0057).is_none());

        let measured = profile_for(0xD209, 0x0430, 0x0056).expect("measured profile");
        assert_eq!(measured.driver, PanelProtocolDriver::Ipac4Pac256V1);
        assert!(measured.capabilities.can_read_chart);
        assert!(measured.capabilities.can_write_chart);
    }

    #[test]
    fn recognition_only_capabilities_are_identify_only() {
        let family = family_for(0xD209, 0x0440).expect("Mini-PAC family");
        let capabilities = capabilities_for(Some(family), None);
        assert!(capabilities.can_identify);
        assert!(!capabilities.can_report_mode);
        assert!(!capabilities.can_read_chart);
        assert!(!capabilities.can_write_chart);
        assert!(!capabilities.write_is_persistent);
        assert_eq!(
            capabilities_for(None, None),
            PanelDriverCapabilities::default()
        );
    }
}
