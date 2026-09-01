//! One backend-specific live identity resolver.
//!
//! A persisted `usb:` selector names a USB interface.  WinUSB captures that
//! interface directly, while Interception emits the HID stack's registry
//! `HardwareID` for the keyboard child below it.  Treating those as one string
//! produces a plan that passes validation and can never receive a key.  This
//! module owns the only conversion between those two exact identities.

use std::collections::BTreeSet;

use ksx_capture::{
    Binding, CaptureBackend as _, DeviceInfo, DeviceKind, InterceptionBackend, UsbCandidate,
};
use ksx_config::Backend;
use ksx_core::{DeviceFacts, DeviceId, DeviceSelector, Match};
use ksx_platform::winusb::{ClaimState, DeviceNode, Survey};

/// Everything collected in one read-only pass for a plan/preflight decision.
#[derive(Debug)]
pub(crate) struct LiveInventory {
    usb: Vec<UsbCandidate>,
    survey: Survey,
    interception: Vec<DeviceInfo>,
}

/// The concrete ID a capture backend will actually publish.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedIdentity {
    pub capture_id: DeviceId,
    pub usb: Option<DeviceFacts>,
    pub binding: Option<Binding>,
}

/// A refusal from exact live identity resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum IdentityError {
    Enumeration(String),
    InterceptionUnavailable(String),
    Missing(String),
    SelectorAmbiguous(Vec<DeviceFacts>),
    CaptureAmbiguous { id: DeviceId, count: usize },
    WrongBinding(String),
    Uncorrelated(String),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Enumeration(detail) => write!(f, "device enumeration failed: {detail}"),
            Self::InterceptionUnavailable(detail) => {
                write!(f, "Interception is not available: {detail}")
            }
            Self::Missing(detail) => f.write_str(detail),
            Self::SelectorAmbiguous(found) => write!(
                f,
                "the selector matches {} connected USB interfaces",
                found.len()
            ),
            Self::CaptureAmbiguous { id, count } => write!(
                f,
                "Interception reports {count} keyboards with the exact hardware id {id}"
            ),
            Self::WrongBinding(detail) | Self::Uncorrelated(detail) => f.write_str(detail),
        }
    }
}

impl std::error::Error for IdentityError {}

impl LiveInventory {
    /// Collect only the inventories the selected transport/backend needs.
    /// Bluetooth and legacy hardware-ID plans never call the USB descriptor
    /// enumerator; a `usb:` selector does.
    pub(crate) fn collect(
        require_usb: bool,
        require_interception: bool,
    ) -> Result<Self, IdentityError> {
        let usb = if require_usb {
            ksx_capture::usb_candidates()
                .map_err(|err| IdentityError::Enumeration(err.to_string()))?
        } else {
            Vec::new()
        };
        let survey = ksx_platform::winusb::survey();
        let interception = if require_interception {
            let mut backend = InterceptionBackend::new()
                .map_err(|err| IdentityError::InterceptionUnavailable(err.to_string()))?;
            backend.devices()
        } else {
            Vec::new()
        };
        Ok(Self {
            usb,
            survey,
            interception,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_parts(
        usb: Vec<UsbCandidate>,
        survey: Survey,
        interception: Vec<DeviceInfo>,
    ) -> Self {
        Self {
            usb,
            survey,
            interception,
        }
    }

    /// Resolve a persisted selector to the identity `backend.devices()` emits.
    pub(crate) fn resolve(
        &self,
        selector: &DeviceSelector,
        backend: Backend,
    ) -> Result<ResolvedIdentity, IdentityError> {
        match (selector, backend) {
            (DeviceSelector::Usb { .. } | DeviceSelector::InstancePath(_), Backend::Winusb) => {
                let selected = self.usb_candidate(selector)?;
                Ok(ResolvedIdentity {
                    capture_id: selected.id.clone(),
                    usb: Some(selected.facts()),
                    binding: Some(selected.binding.clone()),
                })
            }
            (
                DeviceSelector::Usb { .. } | DeviceSelector::InstancePath(_),
                Backend::Interception,
            ) => self.resolve_usb_interception(selector),
            (DeviceSelector::HardwareId(wanted), Backend::Interception) => {
                self.resolve_hardware_interception(wanted)
            }
            (DeviceSelector::HardwareId(wanted), Backend::Winusb) => {
                Err(IdentityError::WrongBinding(format!(
                    "'{wanted}' is a keyboard-stack hardware id, not an exact USB interface; WinUSB cannot capture it"
                )))
            }
        }
    }

    fn usb_candidate(&self, selector: &DeviceSelector) -> Result<&UsbCandidate, IdentityError> {
        let facts: Vec<_> = self.usb.iter().map(UsbCandidate::facts).collect();
        let selected = match selector.match_against(&facts) {
            Match::One(selected) => selected,
            Match::None => {
                return Err(IdentityError::Missing(format!(
                    "the selected USB keyboard '{selector}' is not connected"
                )))
            }
            Match::Ambiguous(found) => {
                return Err(IdentityError::SelectorAmbiguous(
                    found.into_iter().cloned().collect(),
                ))
            }
        };
        self.usb
            .iter()
            .find(|candidate| candidate.id == selected.id)
            .ok_or_else(|| {
                IdentityError::Uncorrelated(
                    "the USB selector result disappeared during the same inventory pass".to_owned(),
                )
            })
    }

    fn resolve_usb_interception(
        &self,
        selector: &DeviceSelector,
    ) -> Result<ResolvedIdentity, IdentityError> {
        let selected = self.usb_candidate(selector)?;
        if !matches!(selected.binding, Binding::HidUsb) {
            return Err(IdentityError::WrongBinding(format!(
                "{} is bound to {}, so Interception cannot see its keyboard child",
                selected.id,
                selected.binding.label()
            )));
        }

        let matches: Vec<_> = self
            .survey
            .candidates
            .iter()
            .filter(|candidate| {
                candidate
                    .interface
                    .instance_id
                    .eq_ignore_ascii_case(selected.id.as_str())
            })
            .collect();
        let candidate = match matches.as_slice() {
            [candidate] => *candidate,
            [] => {
                return Err(IdentityError::Uncorrelated(format!(
                    "the exact USB interface {} has no verified HID child in the live PnP tree",
                    selected.id
                )))
            }
            many => {
                return Err(IdentityError::Uncorrelated(format!(
                    "the live PnP tree contains {} copies of the exact interface {}",
                    many.len(),
                    selected.id
                )))
            }
        };
        if candidate.state != ClaimState::Claimable {
            return Err(IdentityError::WrongBinding(format!(
                "{} is not a working keyboard on the HID stack ({})",
                selected.id,
                candidate.state.code()
            )));
        }
        let keyboard = candidate.keyboard.as_ref().ok_or_else(|| {
            IdentityError::Uncorrelated(format!(
                "the exact USB interface {} has no keyboard child",
                selected.id
            ))
        })?;
        let capture_id = self.capture_id_for_keyboard(keyboard)?;
        Ok(ResolvedIdentity {
            capture_id,
            usb: Some(selected.facts()),
            binding: Some(selected.binding.clone()),
        })
    }

    fn resolve_hardware_interception(
        &self,
        wanted: &str,
    ) -> Result<ResolvedIdentity, IdentityError> {
        let exact: Vec<_> = self
            .interception
            .iter()
            .filter(|device| {
                device.kind == DeviceKind::Keyboard
                    && device.id.as_str().eq_ignore_ascii_case(wanted)
            })
            .collect();
        match exact.as_slice() {
            [device] => {
                return Ok(ResolvedIdentity {
                    capture_id: device.id.clone(),
                    usb: None,
                    binding: None,
                })
            }
            [] => {}
            many => {
                return Err(IdentityError::CaptureAmbiguous {
                    id: DeviceId::new(wanted),
                    count: many.len(),
                })
            }
        }

        // A picker may persist the exact PnP instance of a HID/ACPI keyboard,
        // or a BTHENUM service node.  Join that node to its keyboard, then use
        // the keyboard's actual HardwareID list to reach Interception.
        let mut keyboards: Vec<&DeviceNode> = self
            .survey
            .keyboards
            .iter()
            .filter(|keyboard| keyboard.node.instance_id.eq_ignore_ascii_case(wanted))
            .map(|keyboard| &keyboard.node)
            .collect();
        for candidate in self.survey.candidates.iter().filter(|candidate| {
            candidate.interface.instance_id.eq_ignore_ascii_case(wanted)
                || candidate
                    .keyboard
                    .as_ref()
                    .is_some_and(|keyboard| keyboard.instance_id.eq_ignore_ascii_case(wanted))
        }) {
            if let Some(keyboard) = candidate.keyboard.as_ref() {
                keyboards.push(keyboard);
            }
        }
        keyboards.sort_by_key(|keyboard| keyboard.instance_id.to_uppercase());
        keyboards.dedup_by(|a, b| a.instance_id.eq_ignore_ascii_case(&b.instance_id));
        let keyboard = match keyboards.as_slice() {
            [keyboard] => *keyboard,
            [] => {
                return Err(IdentityError::Missing(format!(
                    "the selected Interception keyboard '{wanted}' is not connected"
                )))
            }
            many => {
                return Err(IdentityError::CaptureAmbiguous {
                    id: DeviceId::new(wanted),
                    count: many.len(),
                })
            }
        };
        let capture_id = self.capture_id_for_keyboard(keyboard)?;
        Ok(ResolvedIdentity {
            capture_id,
            usb: None,
            binding: None,
        })
    }

    fn capture_id_for_keyboard(&self, keyboard: &DeviceNode) -> Result<DeviceId, IdentityError> {
        let mut exact_ids: BTreeSet<String> = keyboard
            .hardware_ids
            .iter()
            .map(|id| id.to_uppercase())
            .collect();
        // Some bus drivers expose the instance path itself.  Accepting an
        // exact value is safe; deriving a hardware id from it is not.
        exact_ids.insert(keyboard.instance_id.to_uppercase());
        let matches: Vec<_> = self
            .interception
            .iter()
            .filter(|device| {
                device.kind == DeviceKind::Keyboard
                    && exact_ids.contains(&device.id.as_str().to_uppercase())
            })
            .collect();
        match matches.as_slice() {
            [device] => Ok(device.id.clone()),
            [] => Err(IdentityError::Missing(format!(
                "the exact keyboard child {} is present, but Interception does not report any of its registry HardwareID values",
                keyboard.instance_id
            ))),
            many => Err(IdentityError::CaptureAmbiguous {
                id: many[0].id.clone(),
                count: many.len(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksx_platform::winusb::{DeviceNode, NodeStatus, KEYBOARD_CLASS_GUID};

    const USB_MI: &str = r"USB\VID_D209&PID_0430&MI_00\7&A1B2C3D4&0&0000";
    const HID_MI_NODE: &str = r"HID\VID_D209&PID_0430&MI_00\8&DEADBEEF&0&0000";
    const HID_MI_HWID: &str = r"HID\VID_D209&PID_0430&REV_0001&MI_00";
    const USB_PLAIN: &str = r"USB\VID_1209&PID_0001\5&11111111&0&2";
    const HID_PLAIN_NODE: &str = r"HID\VID_1209&PID_0001\6&22222222&0&0000";
    const HID_PLAIN_HWID: &str = r"HID\VID_1209&PID_0001&REV_0100";

    fn usb(id: &str, vid: u16, pid: u16, mi: u8) -> UsbCandidate {
        UsbCandidate {
            id: DeviceId::new(id),
            parent_id: id.to_owned(),
            vendor_id: vid,
            product_id: pid,
            bcd_device: 0x0056,
            interface_number: mi,
            interface_class: 3,
            interface_subclass: 1,
            interface_protocol: 1,
            interface_string: None,
            product: None,
            serial: None,
            device_desc: None,
            port_chain: vec![1],
            bus_id: "1".to_owned(),
            binding: Binding::HidUsb,
        }
    }

    fn node(
        id: &str,
        class: Option<&str>,
        service: &str,
        parent: Option<&str>,
        hardware_ids: &[&str],
    ) -> DeviceNode {
        DeviceNode::new(
            id,
            class.map(str::to_owned),
            Some(service.to_owned()),
            Some("test".to_owned()),
            parent.map(str::to_owned),
        )
        .with_hardware_ids(hardware_ids.iter().map(|id| (*id).to_owned()).collect())
        .with_status(NodeStatus {
            started: true,
            problem: 0,
        })
    }

    fn visible(id: &str, slot: u8) -> DeviceInfo {
        DeviceInfo {
            id: DeviceId::new(id),
            interception_slot: Some(slot),
            friendly: None,
            kind: DeviceKind::Keyboard,
        }
    }

    fn composite_inventory(visible_devices: Vec<DeviceInfo>) -> LiveInventory {
        let nodes = vec![
            node(USB_MI, None, "HidUsb", Some("8&DEADBEEF&0"), &[]),
            node(
                HID_MI_NODE,
                Some(KEYBOARD_CLASS_GUID),
                "kbdhid",
                None,
                &[HID_MI_HWID],
            ),
        ];
        LiveInventory::from_parts(
            vec![usb(USB_MI, 0xD209, 0x0430, 0)],
            Survey::from_nodes(&nodes),
            visible_devices,
        )
    }

    #[test]
    fn composite_usb_resolves_to_the_exact_interception_hardware_id() {
        let inventory = composite_inventory(vec![visible(HID_MI_HWID, 1)]);
        let resolved = inventory
            .resolve(
                &DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                Backend::Interception,
            )
            .unwrap();
        assert_eq!(resolved.capture_id, DeviceId::new(HID_MI_HWID));
        assert_ne!(resolved.capture_id, DeviceId::new(USB_MI));
    }

    #[test]
    fn staged_plan_and_capture_control_use_the_exact_hid_id_not_the_usb_id() {
        let inventory = composite_inventory(vec![visible(HID_MI_HWID, 1)]);
        let config: ksx_config::ConfigFile = toml::from_str(
            "schema_version = 1\n\
             [settings]\nblock_keyboards = 'bound-keys'\n\n\
             [[device]]\nid = 'usb:d209:0430:00'\nalias = 'panel'\nbackend = 'interception'\n\n\
             [[slot]]\nnumber = 1\nkeyboard = 'panel'\npreset = 'P1'\n",
        )
        .unwrap();
        let presets = vec![toml::from_str("name = 'P1'\n[bindings]\nA = 'Space'\n").unwrap()];
        let mut plan = crate::run::plan::build_plan(
            &config,
            &ksx_config::GamesFile::default(),
            &presets,
            None,
        )
        .unwrap();
        crate::run::resolve::apply_live(&mut plan, &config.devices, &inventory).unwrap();

        let hid = DeviceId::new(HID_MI_HWID);
        assert_eq!(plan.captureable, vec![hid.clone()]);
        assert_eq!(plan.slots[0].spec.keyboard(), Some(&hid));
        assert!(plan.winusb.is_empty());
        assert!(!plan.captureable.contains(&DeviceId::new(USB_MI)));

        let present: BTreeSet<_> = [hid.clone()].into_iter().collect();
        let (tx, rx) = crossbeam_channel::unbounded();
        crate::run::supervisor::apply_capture(&tx, &None, true, &present, &plan);
        let ksx_capture::CaptureCtl::SetCapturedWith(takes) = rx.try_recv().unwrap() else {
            panic!("bound-keys plan must send SetCapturedWith");
        };
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0].0, hid);
        assert_ne!(takes[0].0, DeviceId::new(USB_MI));
    }

    #[test]
    fn ordinary_non_composite_usb_requires_no_mi_in_the_hid_id() {
        let nodes = vec![
            node(USB_PLAIN, None, "HidUsb", Some("6&22222222&0"), &[]),
            node(
                HID_PLAIN_NODE,
                Some(KEYBOARD_CLASS_GUID),
                "kbdhid",
                None,
                &[HID_PLAIN_HWID],
            ),
        ];
        let inventory = LiveInventory::from_parts(
            vec![usb(USB_PLAIN, 0x1209, 0x0001, 0)],
            Survey::from_nodes(&nodes),
            vec![visible(HID_PLAIN_HWID, 1)],
        );
        let resolved = inventory
            .resolve(
                &DeviceSelector::parse("usb:1209:0001:00").unwrap(),
                Backend::Interception,
            )
            .unwrap();
        assert_eq!(resolved.capture_id, DeviceId::new(HID_PLAIN_HWID));
    }

    #[test]
    fn bluetooth_pnp_identity_joins_to_the_exact_interception_id() {
        let bt = r"BTHENUM\DEV_02A1B2C3D4E5\7&A1B2C3D4&0&BLUETOOTHDEVICE_02A1B2C3D4E5";
        let bt_hwid = r"BTHENUM\DEV_02A1B2C3D4E5";
        let nodes = vec![node(
            bt,
            Some(KEYBOARD_CLASS_GUID),
            "kbdhid",
            None,
            &[bt_hwid],
        )];
        let inventory = LiveInventory::from_parts(
            Vec::new(),
            Survey::from_nodes(&nodes),
            vec![visible(bt_hwid, 1)],
        );
        let resolved = inventory
            .resolve(&DeviceSelector::parse(bt).unwrap(), Backend::Interception)
            .unwrap();
        assert_eq!(resolved.capture_id, DeviceId::new(bt_hwid));
    }

    #[test]
    fn unplug_and_interception_twins_are_refused() {
        let unplugged = composite_inventory(Vec::new())
            .resolve(
                &DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                Backend::Interception,
            )
            .unwrap_err();
        assert!(matches!(unplugged, IdentityError::Missing(_)));

        let twins = composite_inventory(vec![visible(HID_MI_HWID, 1), visible(HID_MI_HWID, 2)])
            .resolve(
                &DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                Backend::Interception,
            )
            .unwrap_err();
        assert!(matches!(
            twins,
            IdentityError::CaptureAmbiguous { count: 2, .. }
        ));
    }

    #[test]
    fn model_selector_survives_replug_but_an_unqualified_twin_does_not() {
        let moved = r"USB\VID_D209&PID_0430&MI_00\6&BEEFBEEF&0&0000";
        let moved_hid = r"HID\VID_D209&PID_0430&MI_00\9&AAAA1111&0&0000";
        let moved_hwid = HID_MI_HWID;
        let nodes = vec![
            node(moved, None, "HidUsb", Some("9&AAAA1111&0"), &[]),
            node(
                moved_hid,
                Some(KEYBOARD_CLASS_GUID),
                "kbdhid",
                None,
                &[moved_hwid],
            ),
        ];
        let one = LiveInventory::from_parts(
            vec![usb(moved, 0xD209, 0x0430, 0)],
            Survey::from_nodes(&nodes),
            vec![visible(moved_hwid, 1)],
        );
        assert_eq!(
            one.resolve(
                &DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                Backend::Interception,
            )
            .unwrap()
            .capture_id,
            DeviceId::new(moved_hwid)
        );

        let mut both_usb = one.usb.clone();
        both_usb.push(usb(USB_MI, 0xD209, 0x0430, 0));
        let twins = LiveInventory::from_parts(both_usb, one.survey, one.interception)
            .resolve(
                &DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                Backend::Interception,
            )
            .unwrap_err();
        assert!(matches!(twins, IdentityError::SelectorAmbiguous(found) if found.len() == 2));
    }
}
