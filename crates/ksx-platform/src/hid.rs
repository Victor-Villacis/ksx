//! Passive HID collection inventory.
//!
//! This is deliberately narrower than a HID transport. It enumerates present
//! top-level collections, opens each handle with **desired access 0**, and asks
//! hidclass only for cached attributes and preparsed capabilities. It never
//! calls an input-, output-, or feature-report API. In particular, discovering
//! a five-byte output report is evidence about a collection's shape, not
//! permission to send a packet to it.

/// Device descriptor identity returned by `HidD_GetAttributes`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HidAttributes {
    pub vendor_id: u16,
    pub product_id: u16,
    /// Raw `VersionNumber`/`bcdDevice`. This is not interpreted as firmware.
    pub version_number: u16,
}

/// Report sizes and top-level usage returned by `HidP_GetCaps`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HidCapabilities {
    pub usage_page: u16,
    pub usage: u16,
    pub input_report_bytes: u16,
    pub output_report_bytes: u16,
    pub feature_report_bytes: u16,
}

/// One present HID top-level collection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HidCollection {
    /// HID child instance id (`HID\VID_...&COL01\...`).
    pub instance_id: String,
    /// Symbolic interface path used only to open the metadata handle. It is not
    /// exposed by the API view and must never be reconstructed from an instance
    /// id: one USB interface can expose several `COLxx` paths.
    pub device_path: String,
    /// Topmost PnP ancestor, normalized uppercase, when the HID child could be
    /// joined to the present device tree.
    pub board_id: Option<String>,
    pub attributes: Option<HidAttributes>,
    pub capabilities: Option<HidCapabilities>,
    /// Per-collection partial failures. A row remains visible when its handle
    /// or one metadata query fails; failed read is not absence.
    pub errors: Vec<String>,
}

/// One complete HID interface enumeration attempt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HidSurvey {
    /// Did SetupAPI return a collection set? Partial per-row failures do not
    /// clear this; they live on the row or in [`Self::errors`].
    pub available: bool,
    pub collections: Vec<HidCollection>,
    /// Enumeration-level failures, including an interrupted SetupAPI walk.
    pub errors: Vec<String>,
}

#[cfg(windows)]
fn board_id_for(instance_id: &str, nodes: &[crate::winusb::DeviceNode]) -> Option<String> {
    let node = nodes
        .iter()
        .find(|node| node.instance_id.eq_ignore_ascii_case(instance_id))?;
    Some(crate::winusb::board_of(node, nodes).to_uppercase())
}

/// Enumerate passive HID metadata for the current machine.
#[cfg(windows)]
pub fn survey() -> HidSurvey {
    windows_impl::survey()
}

/// There is no Windows HID collection inventory on other platforms.
#[cfg(not(windows))]
pub fn survey() -> HidSurvey {
    HidSurvey {
        available: false,
        collections: Vec::new(),
        errors: vec!["HID collection enumeration is Windows-only".to_owned()],
    }
}

#[cfg(test)]
mod policy_tests {
    #[test]
    fn the_passive_inventory_contains_no_report_or_transfer_primitive() {
        let source = include_str!("hid.rs");
        let forbidden = [
            ["HidD", "_GetFeature"].concat(),
            ["HidD", "_SetFeature"].concat(),
            ["HidD", "_GetInputReport"].concat(),
            ["HidD", "_SetOutputReport"].concat(),
            ["Read", "File"].concat(),
            ["Write", "File"].concat(),
            ["Device", "IoControl"].concat(),
            // An access mask is the other half of the same rule: a handle
            // opened for read or write can carry a report transaction even if
            // none of the names above appears. The only open in this module
            // asks for zero — see `metadata_handles_request_no_device_access`.
            ["GENERIC", "_READ"].concat(),
            ["GENERIC", "_WRITE"].concat(),
            ["GENERIC", "_ALL"].concat(),
        ];
        for symbol in forbidden {
            assert!(
                !source.contains(&symbol),
                "passive HID inventory gained forbidden primitive {symbol}"
            );
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::mem::{size_of, zeroed};
    use std::ptr;

    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
        SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE,
        DIGCF_PRESENT, HDEVINFO, SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
        SP_DEVINFO_DATA,
    };
    use windows_sys::Win32::Devices::HumanInterfaceDevice::{
        HidD_FreePreparsedData, HidD_GetAttributes, HidD_GetHidGuid, HidD_GetPreparsedData,
        HidP_GetCaps, HIDD_ATTRIBUTES, HIDP_CAPS, HIDP_STATUS_SUCCESS, PHIDP_PREPARSED_DATA,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_NO_MORE_ITEMS, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    use super::{board_id_for, HidAttributes, HidCapabilities, HidCollection, HidSurvey};

    /// Load-bearing safety constant: metadata handles request no read or write
    /// access. HidD attributes/preparsed caps are available through such a
    /// handle; report transactions are intentionally absent from this module.
    const HID_METADATA_DESIRED_ACCESS: u32 = 0;

    struct InfoSet(HDEVINFO);

    impl Drop for InfoSet {
        fn drop(&mut self) {
            // SAFETY: `self.0` is the live handle returned by
            // `SetupDiGetClassDevsW`, owned only by this wrapper.
            unsafe {
                SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }

    struct MetadataHandle(HANDLE);

    impl Drop for MetadataHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: the handle is owned by this wrapper and closed once.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct Preparsed(PHIDP_PREPARSED_DATA);

    impl Drop for Preparsed {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: hidclass allocated this pointer for the live metadata
                // handle and transfers exactly one matching free to the caller.
                unsafe {
                    HidD_FreePreparsedData(self.0);
                }
            }
        }
    }

    pub(super) fn survey() -> HidSurvey {
        let mut hid_guid = windows_sys::core::GUID::default();
        // SAFETY: `hid_guid` is valid writable storage for the GUID.
        unsafe {
            HidD_GetHidGuid(&mut hid_guid);
        }

        // SAFETY: null enumerator/window are the documented local-machine
        // enumeration form. The returned set is read-only SetupAPI metadata.
        let raw_set = unsafe {
            SetupDiGetClassDevsW(
                &hid_guid,
                ptr::null(),
                ptr::null_mut(),
                DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
            )
        };
        if raw_set == -1 {
            return HidSurvey {
                available: false,
                collections: Vec::new(),
                errors: vec![format!(
                    "SetupDiGetClassDevsW(GUID_DEVINTERFACE_HID) failed (Windows error {})",
                    last_error()
                )],
            };
        }
        let set = InfoSet(raw_set);
        let nodes = crate::winusb::present_nodes();
        let mut result = HidSurvey {
            available: true,
            collections: Vec::new(),
            errors: Vec::new(),
        };

        let mut index = 0u32;
        loop {
            // SAFETY: zero is the documented initial state; cbSize identifies
            // the structure version to SetupAPI.
            let mut interface: SP_DEVICE_INTERFACE_DATA = unsafe { zeroed() };
            interface.cbSize = size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
            // SAFETY: every pointer is either null by contract or points to
            // initialized writable storage for the duration of the call.
            let found = unsafe {
                SetupDiEnumDeviceInterfaces(set.0, ptr::null(), &hid_guid, index, &mut interface)
            };
            if found == 0 {
                let code = last_error();
                if code != ERROR_NO_MORE_ITEMS {
                    result.errors.push(format!(
                        "HID interface enumeration stopped at index {index} (Windows error {code})"
                    ));
                }
                break;
            }
            index += 1;

            match interface_detail(set.0, &interface) {
                Ok((device_path, instance_id)) => {
                    result
                        .collections
                        .push(inspect_collection(device_path, instance_id, &nodes));
                }
                Err(error) => result.errors.push(error),
            }
        }

        result
            .collections
            .sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
        result
    }

    fn interface_detail(
        set: HDEVINFO,
        interface: &SP_DEVICE_INTERFACE_DATA,
    ) -> Result<(String, String), String> {
        let mut required = 0u32;
        // SAFETY: this first call deliberately supplies no detail buffer; its
        // documented purpose is to return the required byte count.
        unsafe {
            SetupDiGetDeviceInterfaceDetailW(
                set,
                interface,
                ptr::null_mut(),
                0,
                &mut required,
                ptr::null_mut(),
            );
        }
        if required < size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32 {
            return Err(format!(
                "SetupDiGetDeviceInterfaceDetailW did not return a usable buffer size (Windows error {})",
                last_error()
            ));
        }

        // `Vec<usize>` supplies stronger alignment than the detail structure
        // needs while still giving SetupAPI exactly its requested byte count.
        let unit = size_of::<usize>();
        let units = (required as usize).div_ceil(unit);
        let mut storage = vec![0usize; units];
        let detail = storage
            .as_mut_ptr()
            .cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>();
        // SAFETY: `detail` points into aligned storage at least `required` bytes
        // long. cbSize describes the header, not the allocation.
        unsafe {
            (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
        }

        // SAFETY: zeroed + cbSize is the SetupAPI initialization contract.
        let mut info: SP_DEVINFO_DATA = unsafe { zeroed() };
        info.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
        // SAFETY: all buffers are initialized and remain live for the call.
        let ok = unsafe {
            SetupDiGetDeviceInterfaceDetailW(
                set,
                interface,
                detail,
                required,
                &mut required,
                &mut info,
            )
        };
        if ok == 0 {
            return Err(format!(
                "reading a HID interface path failed (Windows error {})",
                last_error()
            ));
        }

        // SAFETY: `DevicePath` begins inside `storage`; constrain the NUL scan
        // to the remainder of that allocation before constructing the slice.
        let wide = unsafe { ptr::addr_of!((*detail).DevicePath).cast::<u16>() };
        let base = storage.as_ptr() as usize;
        let offset = wide as usize - base;
        let capacity = (storage.len() * unit - offset) / size_of::<u16>();
        let len = (0..capacity)
            .find(|&at| {
                // SAFETY: `at` is bounded by `capacity` above.
                unsafe { *wide.add(at) == 0 }
            })
            .ok_or_else(|| "a HID interface path was not NUL-terminated".to_owned())?;
        // SAFETY: `wide..wide+len` lies in the allocation and excludes the NUL.
        let path = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(wide, len) });
        let instance_id = instance_id(set, &info)?;
        Ok((path, instance_id.to_uppercase()))
    }

    fn instance_id(set: HDEVINFO, info: &SP_DEVINFO_DATA) -> Result<String, String> {
        let mut required = 0u32;
        // SAFETY: first call asks only for the required UTF-16 element count.
        unsafe {
            SetupDiGetDeviceInstanceIdW(set, info, ptr::null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(format!(
                "reading a HID instance-id size failed (Windows error {})",
                last_error()
            ));
        }
        let mut wide = vec![0u16; required as usize];
        // SAFETY: `wide` has exactly the capacity reported by SetupAPI.
        let ok = unsafe {
            SetupDiGetDeviceInstanceIdW(set, info, wide.as_mut_ptr(), required, &mut required)
        };
        if ok == 0 {
            return Err(format!(
                "reading a HID instance id failed (Windows error {})",
                last_error()
            ));
        }
        let len = wide
            .iter()
            .position(|&word| word == 0)
            .unwrap_or(wide.len());
        Ok(String::from_utf16_lossy(&wide[..len]))
    }

    fn inspect_collection(
        device_path: String,
        instance_id: String,
        nodes: &[crate::winusb::DeviceNode],
    ) -> HidCollection {
        let board_id = board_id_for(&instance_id, nodes);
        let mut collection = HidCollection {
            instance_id,
            device_path,
            board_id,
            attributes: None,
            capabilities: None,
            errors: Vec::new(),
        };

        let wide: Vec<u16> = collection
            .device_path
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: the path is a NUL-terminated UTF-16 string from SetupAPI.
        // Desired access is the pinned zero constant; this handle cannot be
        // used for a report transaction by the code in this module.
        let raw_handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                HID_METADATA_DESIRED_ACCESS,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if raw_handle == INVALID_HANDLE_VALUE {
            collection.errors.push(format!(
                "opening HID metadata with desired access 0 failed (Windows error {})",
                last_error()
            ));
            return collection;
        }
        let handle = MetadataHandle(raw_handle);

        let mut attributes = HIDD_ATTRIBUTES {
            Size: size_of::<HIDD_ATTRIBUTES>() as u32,
            ..HIDD_ATTRIBUTES::default()
        };
        // SAFETY: `attributes` is initialized to the required size and the
        // metadata handle remains live.
        if unsafe { HidD_GetAttributes(handle.0, &mut attributes) } {
            collection.attributes = Some(HidAttributes {
                vendor_id: attributes.VendorID,
                product_id: attributes.ProductID,
                version_number: attributes.VersionNumber,
            });
        } else {
            collection.errors.push(format!(
                "HidD_GetAttributes failed (Windows error {})",
                last_error()
            ));
        }

        let mut raw_preparsed: PHIDP_PREPARSED_DATA = 0;
        // SAFETY: the out pointer is valid and the handle remains live through
        // the matching `HidD_FreePreparsedData` guard.
        if !unsafe { HidD_GetPreparsedData(handle.0, &mut raw_preparsed) } {
            collection.errors.push(format!(
                "HidD_GetPreparsedData failed (Windows error {})",
                last_error()
            ));
            return collection;
        }
        let preparsed = Preparsed(raw_preparsed);
        let mut caps = HIDP_CAPS::default();
        // SAFETY: hidclass owns the preparsed contents; this call only decodes
        // its cached metadata into initialized output storage.
        let status = unsafe { HidP_GetCaps(preparsed.0, &mut caps) };
        if status == HIDP_STATUS_SUCCESS {
            collection.capabilities = Some(HidCapabilities {
                usage_page: caps.UsagePage,
                usage: caps.Usage,
                input_report_bytes: caps.InputReportByteLength,
                output_report_bytes: caps.OutputReportByteLength,
                feature_report_bytes: caps.FeatureReportByteLength,
            });
        } else {
            collection
                .errors
                .push(format!("HidP_GetCaps failed (NTSTATUS 0x{status:08X})"));
        }
        collection
    }

    fn last_error() -> u32 {
        // SAFETY: thread-local error retrieval has no preconditions.
        unsafe { GetLastError() }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The constant is zero **and the open actually passes it**.
        ///
        /// Only the first half used to be asserted, and a zero constant nobody
        /// uses is not a safety property: spell an access mask inline at the
        /// `CreateFileW` call instead and ksx opens, with read/write access, a
        /// HID collection the game in front of the player already has open —
        /// while `assert_eq!(HID_METADATA_DESIRED_ACCESS, 0)` stays green
        /// forever. That is the existence-versus-rendering trap, in an access
        /// mask.
        #[test]
        fn metadata_handles_request_no_device_access() {
            assert_eq!(HID_METADATA_DESIRED_ACCESS, 0);

            let source = include_str!("hid.rs");
            // Spelled in halves so this test cannot match itself.
            let open = ["CreateFile", "W("].concat();
            assert_eq!(
                source.matches(&open).count(),
                1,
                "one metadata open, or this fence is reading the wrong one"
            );
            let desired = source
                .split(&open)
                .nth(1)
                .expect("the metadata open")
                .split(',')
                .nth(1)
                .map(str::trim)
                .expect("a desired-access argument");
            assert_eq!(
                desired, "HID_METADATA_DESIRED_ACCESS",
                "the metadata open must pass the pinned constant, not an inline mask"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::winusb::DeviceNode;

    #[test]
    fn hid_collection_joins_through_interface_to_physical_board() {
        let parent = DeviceNode::new(
            r"USB\VID_D209&PID_0430\4",
            None,
            Some("usbccgp".to_owned()),
            None,
            Some("7&BOARD&0".to_owned()),
        );
        let interface = DeviceNode::new(
            r"USB\VID_D209&PID_0430&MI_02\7&BOARD&0&0002",
            None,
            Some("HidUsb".to_owned()),
            None,
            Some("8&COLLECTION&0".to_owned()),
        );
        let child = DeviceNode::new(
            r"HID\VID_D209&PID_0430&MI_02&COL01\8&COLLECTION&0&0000",
            None,
            Some("HidUsb".to_owned()),
            None,
            None,
        );
        let nodes = vec![parent, interface, child.clone()];

        assert_eq!(
            board_id_for(&child.instance_id.to_lowercase(), &nodes).as_deref(),
            Some(r"USB\VID_D209&PID_0430\4")
        );
    }

    #[test]
    fn an_unjoined_collection_stays_unknown_instead_of_guessing_a_parent() {
        assert_eq!(board_id_for("HID\\MISSING", &[]), None);
    }
}
