//! Narrow dynamic binding to KSX's pinned libwdi prepare-only provider.
//!
//! No install export is loaded or represented here.  The provider may create
//! a signed INF/catalog and place its exact public certificate in the machine
//! stores; the transaction layer independently verifies those artifacts before
//! `pnputil` is reachable.

use std::path::{Path, PathBuf};

/// Provider-owned input bytes. `include_str!` makes the installed helper carry
/// the reviewed template without trusting a loose file beside the executable.
pub const CANONICAL_INF_TEMPLATE: &str =
    include_str!("../../../third_party/libwdi/src/winusb.inf.in");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareRequest {
    pub output_dir: PathBuf,
    /// Existing `.inf` file containing [`CANONICAL_INF_TEMPLATE`]. The provider
    /// reads it completely before replacing it with UTF-16 prepared output.
    pub inf_path: PathBuf,
    pub instance_id: String,
    pub hardware_id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub interface_number: Option<u8>,
    /// Unique per transaction, including the `CN=` prefix.
    pub certificate_subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedPaths {
    pub inf_path: PathBuf,
    pub catalog_path: PathBuf,
}

pub trait DriverPreparer: Send + Sync {
    fn prepare(&self, request: &PrepareRequest) -> Result<PreparedPaths, PrepareError>;
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error("the libwdi provider is available only on 64-bit Windows")]
    Unsupported,
    #[error("could not locate the running KSX executable: {0}")]
    CurrentExe(#[source] std::io::Error),
    #[error("libwdi.dll must be the exact installed sibling of the KSX helper: {0}")]
    ProviderPath(String),
    #[error("a provider path cannot be represented as UTF-8: {0}")]
    NonUnicodePath(String),
    #[error("a provider argument contains an embedded NUL")]
    EmbeddedNul,
    #[error("could not load the pinned provider at {path}: {source}")]
    Load {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("the pinned provider does not export {0}")]
    MissingExport(&'static str),
    #[error("the pinned provider does not support WDI_WINUSB")]
    WinusbUnsupported,
    #[error("libwdi preparation failed ({code}): {message}")]
    Failed { code: i32, message: String },
}

/// The production provider: an absolute canonical `libwdi.dll` beside the
/// current executable. It never consults CWD or PATH.
#[derive(Clone, Debug)]
pub struct WdiProvider {
    dll_path: PathBuf,
}

impl WdiProvider {
    pub fn installed_sibling() -> Result<Self, PrepareError> {
        let exe = std::env::current_exe().map_err(PrepareError::CurrentExe)?;
        let parent = exe.parent().ok_or_else(|| {
            PrepareError::ProviderPath("the current executable has no parent directory".to_owned())
        })?;
        let dll_path = crate::process::protected_install_sibling(&exe, &parent.join("libwdi.dll"))
            .map_err(|err| PrepareError::ProviderPath(err.to_string()))?;
        Ok(Self { dll_path })
    }

    /// Explicit constructor used by ABI/load tests. `exe_path` pins the one
    /// directory the DLL is allowed to occupy.
    pub fn at(dll_path: PathBuf, exe_path: &Path) -> Result<Self, PrepareError> {
        if !dll_path.is_absolute() {
            return Err(PrepareError::ProviderPath(
                "the provider path is not absolute".to_owned(),
            ));
        }
        let exe_parent = exe_path.parent().ok_or_else(|| {
            PrepareError::ProviderPath("the executable has no parent directory".to_owned())
        })?;
        let canonical_parent = exe_parent.canonicalize().map_err(|err| {
            PrepareError::ProviderPath(format!(
                "cannot canonicalize {}: {err}",
                exe_parent.display()
            ))
        })?;
        let canonical_dll = dll_path
            .canonicalize()
            .map_err(|err| PrepareError::ProviderPath(format!("{}: {err}", dll_path.display())))?;
        if canonical_dll.parent() != Some(canonical_parent.as_path()) {
            return Err(PrepareError::ProviderPath(format!(
                "{} is not beside {}",
                canonical_dll.display(),
                exe_path.display()
            )));
        }
        Ok(Self {
            dll_path: canonical_dll,
        })
    }

    pub fn dll_path(&self) -> &Path {
        &self.dll_path
    }
}

#[cfg(windows)]
mod windows_provider {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString, OsStr};
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        LOAD_LIBRARY_SEARCH_SYSTEM32,
    };

    const WDI_WINUSB: i32 = 0;

    #[repr(C)]
    struct WdiDeviceInfo {
        next: *mut WdiDeviceInfo,
        vid: u16,
        pid: u16,
        is_composite: i32,
        mi: u8,
        desc: *mut c_char,
        driver: *mut c_char,
        device_id: *mut c_char,
        hardware_id: *mut c_char,
        compatible_id: *mut c_char,
        upper_filter: *mut c_char,
        driver_version: u64,
    }

    #[repr(C)]
    struct WdiPrepareOptions {
        driver_type: i32,
        vendor_name: *mut c_char,
        device_guid: *mut c_char,
        disable_cat: i32,
        disable_signing: i32,
        cert_subject: *mut c_char,
        use_wcid_driver: i32,
        external_inf: i32,
    }

    type IsSupported = unsafe extern "system" fn(i32, *mut c_void) -> i32;
    type Prepare = unsafe extern "system" fn(
        *mut WdiDeviceInfo,
        *const c_char,
        *const c_char,
        *mut WdiPrepareOptions,
    ) -> i32;
    type StrError = unsafe extern "system" fn(i32) -> *const c_char;

    struct Library(HMODULE);

    impl Drop for Library {
        fn drop(&mut self) {
            // SAFETY: this handle came from LoadLibraryExW and all loaded
            // function pointers are used before `Library` drops.
            unsafe { FreeLibrary(self.0) };
        }
    }

    fn cstring(value: &str) -> Result<CString, PrepareError> {
        CString::new(value).map_err(|_| PrepareError::EmbeddedNul)
    }

    fn path_cstring(path: &Path) -> Result<CString, PrepareError> {
        let text = path
            .to_str()
            .ok_or_else(|| PrepareError::NonUnicodePath(path.display().to_string()))?;
        cstring(text)
    }

    unsafe fn export<T>(library: HMODULE, name: &'static [u8]) -> Result<T, PrepareError>
    where
        T: Copy,
    {
        let raw = unsafe { GetProcAddress(library, name.as_ptr()) }.ok_or_else(|| {
            PrepareError::MissingExport(
                std::str::from_utf8(&name[..name.len() - 1]).unwrap_or("unknown"),
            )
        })?;
        // Function pointers returned by GetProcAddress have the ABI declared
        // by libwdi.h. The x64 layout assertions below pin every data argument.
        Ok(unsafe { std::mem::transmute_copy(&raw) })
    }

    impl DriverPreparer for WdiProvider {
        fn prepare(&self, request: &PrepareRequest) -> Result<PreparedPaths, PrepareError> {
            if std::mem::size_of::<usize>() != 8 {
                return Err(PrepareError::Unsupported);
            }
            let dll_wide: Vec<u16> = OsStr::new(&self.dll_path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: absolute NUL-terminated path; restricted search flags
            // prevent dependency resolution through CWD/PATH.
            let handle = unsafe {
                LoadLibraryExW(
                    dll_wide.as_ptr(),
                    std::ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            if handle.is_null() {
                return Err(PrepareError::Load {
                    path: self.dll_path.display().to_string(),
                    source: std::io::Error::last_os_error(),
                });
            }
            let library = Library(handle);
            // SAFETY: names and ABIs are pinned to the reviewed libwdi.h/.def.
            let supported: IsSupported =
                unsafe { export(library.0, b"wdi_is_driver_supported\0")? };
            let prepare: Prepare = unsafe { export(library.0, b"wdi_prepare_driver\0")? };
            let strerror: StrError = unsafe { export(library.0, b"wdi_strerror\0")? };
            if unsafe { supported(WDI_WINUSB, std::ptr::null_mut()) } == 0 {
                return Err(PrepareError::WinusbUnsupported);
            }

            let desc = cstring(super::super::SAFE_INF_DEVICE_NAME)?;
            let instance = cstring(&request.instance_id)?;
            let hardware = cstring(&request.hardware_id)?;
            let vendor = cstring("KSX")?;
            let guid = cstring(super::super::KSX_DEVICE_INTERFACE_GUID)?;
            let subject = cstring(&request.certificate_subject)?;
            let output = path_cstring(&request.output_dir)?;
            let inf = path_cstring(&request.inf_path)?;

            let mut device = WdiDeviceInfo {
                next: std::ptr::null_mut(),
                vid: request.vendor_id,
                pid: request.product_id,
                is_composite: i32::from(request.interface_number.is_some()),
                mi: request.interface_number.unwrap_or(0),
                desc: desc.as_ptr() as *mut _,
                driver: std::ptr::null_mut(),
                device_id: instance.as_ptr() as *mut _,
                hardware_id: hardware.as_ptr() as *mut _,
                compatible_id: std::ptr::null_mut(),
                upper_filter: std::ptr::null_mut(),
                driver_version: 0,
            };
            let mut options = WdiPrepareOptions {
                driver_type: WDI_WINUSB,
                vendor_name: vendor.as_ptr() as *mut _,
                device_guid: guid.as_ptr() as *mut _,
                disable_cat: 0,
                disable_signing: 0,
                cert_subject: subject.as_ptr() as *mut _,
                use_wcid_driver: 0,
                external_inf: 1,
            };
            // SAFETY: all C strings and structs remain alive through the call;
            // this invokes prepare only and no install entry point is loaded.
            let code = unsafe { prepare(&mut device, output.as_ptr(), inf.as_ptr(), &mut options) };
            if code != 0 {
                let ptr = unsafe { strerror(code) };
                let message = if ptr.is_null() {
                    "unknown libwdi error".to_owned()
                } else {
                    unsafe { CStr::from_ptr(ptr) }
                        .to_string_lossy()
                        .into_owned()
                };
                return Err(PrepareError::Failed { code, message });
            }
            let catalog_path = request.inf_path.with_extension("cat");
            if !request.inf_path.is_file() || !catalog_path.is_file() {
                return Err(PrepareError::Failed {
                    code: -1,
                    message: "the provider reported success without both INF and CAT outputs"
                        .to_owned(),
                });
            }
            Ok(PreparedPaths {
                inf_path: request.inf_path.clone(),
                catalog_path,
            })
        }
    }

    #[cfg(test)]
    mod abi_tests {
        use super::*;

        #[test]
        fn pinned_x64_libwdi_layout_matches_msvc() {
            if std::mem::size_of::<usize>() != 8 {
                return;
            }
            assert_eq!(std::mem::size_of::<WdiDeviceInfo>(), 80);
            assert_eq!(std::mem::offset_of!(WdiDeviceInfo, vid), 8);
            assert_eq!(std::mem::offset_of!(WdiDeviceInfo, is_composite), 12);
            assert_eq!(std::mem::offset_of!(WdiDeviceInfo, mi), 16);
            assert_eq!(std::mem::offset_of!(WdiDeviceInfo, desc), 24);
            assert_eq!(std::mem::offset_of!(WdiDeviceInfo, driver_version), 72);
            assert_eq!(std::mem::size_of::<WdiPrepareOptions>(), 48);
            assert_eq!(std::mem::offset_of!(WdiPrepareOptions, vendor_name), 8);
            assert_eq!(std::mem::offset_of!(WdiPrepareOptions, cert_subject), 32);
            assert_eq!(std::mem::offset_of!(WdiPrepareOptions, external_inf), 44);
        }
    }
}

#[cfg(not(windows))]
impl DriverPreparer for WdiProvider {
    fn prepare(&self, _request: &PrepareRequest) -> Result<PreparedPaths, PrepareError> {
        Err(PrepareError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_template_is_prepare_only_winusb_x64() {
        let normalized = CANONICAL_INF_TEMPLATE.replace("\r\n", "\n");
        assert!(normalized.contains("Needs   = WINUSB.NT.Services"));
        assert!(normalized.contains("ksxDevice,NTamd64"));
        assert!(!normalized.contains("NTarm64"));
        for forbidden in ["CopyFiles", "CoInstallers", "ServiceBinary", "libusb"] {
            assert!(!normalized.contains(forbidden), "{forbidden} in template");
        }
    }
}
