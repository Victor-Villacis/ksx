//! Explicit, fixed-size HID report transport.
//!
//! This module is intentionally separate from [`crate::hid`]. The inventory
//! remains passive; a caller must pass one exact collection path and the
//! expected descriptor identity before this module requests read/write access.
//! Opening a path is not enough authorization: the live handle is re-checked
//! with `HidD_GetAttributes` and `HidP_GetCaps` before any transfer is exposed.
//! Admission also pins the opened handle's raw `VersionNumber`/`bcdDevice` so
//! a same-VID/PID device running another firmware cannot cross the mutation
//! boundary after passive inventory selected the supported profile.

use std::io;
use std::time::Duration;

/// The complete input and output report size of the supported configuration
/// collection, including its report-id byte.
pub const HID_REPORT_BYTES: usize = 5;

/// Raw USB `bcdDevice` exposed by the only currently supported I-PAC4
/// programming profile. `HidD_GetAttributes` calls this `VersionNumber`.
pub const IPAC4_VERSION_NUMBER: u16 = 0x0056;
/// Measured top-level collection discriminator for the connected release-0056
/// I-PAC 4X PAC256 chart channel. Windows reports MI_02/COL01 as Generic
/// Desktop / Undefined, not as a vendor-page collection.
pub const IPAC4_USAGE_PAGE: u16 = 0x0001;
pub const IPAC4_USAGE: u16 = 0x0000;

const HID_REPORT_BYTES_U16: u16 = HID_REPORT_BYTES as u16;
const OUTPUT_WORKER_ARG: &str = "__ksx-hid-output-worker-v1";
const OUTPUT_WORKER_MAGIC: [u8; 8] = *b"KSXHID01";
const OUTPUT_WORKER_REQUEST_BYTES: usize = OUTPUT_WORKER_MAGIC.len() + 8 + 8 + HID_REPORT_BYTES;
#[cfg(windows)]
const OUTPUT_WORKER_TIMEOUT_MS: u32 = 2_000;
#[cfg(windows)]
const OUTPUT_WORKER_KILL_WAIT_MS: u32 = 1_000;
const OUTPUT_WORKER_EXIT_BAD_REQUEST: i32 = 20;
const OUTPUT_WORKER_EXIT_REPORT_FAILED: i32 = 21;
const OUTPUT_WORKER_EXIT_TIMED_OUT: i32 = 22;

/// Descriptor identity that the caller expects at an exact collection path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HidReportIdentity {
    pub vendor_id: u16,
    pub product_id: u16,
}

/// Report lengths observed from the handle's preparsed descriptor data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HidReportCapabilities {
    pub usage_page: u16,
    pub usage: u16,
    pub input_report_bytes: u16,
    pub output_report_bytes: u16,
}

/// Failure to admit or transact with an explicit HID report collection.
#[derive(Debug, thiserror::Error)]
pub enum HidReportError {
    #[error("the HID collection path is empty")]
    EmptyPath,
    #[error("the HID collection path contains an interior NUL")]
    PathContainsNul,
    #[error("opening the exact HID collection path for read/write access failed: {0}")]
    Open(#[source] io::Error),
    #[error("HidD_GetAttributes failed on the opened HID collection: {0}")]
    Attributes(#[source] io::Error),
    #[error(
        "the opened HID collection identity is {actual_vendor_id:04X}:{actual_product_id:04X}, expected {expected_vendor_id:04X}:{expected_product_id:04X}"
    )]
    IdentityMismatch {
        expected_vendor_id: u16,
        expected_product_id: u16,
        actual_vendor_id: u16,
        actual_product_id: u16,
    },
    #[error(
        "the opened HID collection reports raw VersionNumber/bcdDevice 0x{actual:04X}, expected 0x{expected:04X}"
    )]
    VersionNumberMismatch { expected: u16, actual: u16 },
    #[error("HidD_GetPreparsedData failed on the opened HID collection: {0}")]
    PreparsedData(#[source] io::Error),
    #[error("HidP_GetCaps failed with NTSTATUS 0x{status:08X}")]
    Capabilities { status: u32 },
    #[error(
        "the opened HID collection has {input_report_bytes}-byte input and {output_report_bytes}-byte output reports; both must be exactly 5 bytes"
    )]
    ReportSizeMismatch {
        input_report_bytes: u16,
        output_report_bytes: u16,
    },
    #[error(
        "the opened HID collection usage is {actual_usage_page:04X}:{actual_usage:04X}, expected 0001:0000"
    )]
    CollectionUsageMismatch {
        actual_usage_page: u16,
        actual_usage: u16,
    },
    #[error("HidD_SetOutputReport failed: {0}")]
    SetOutputReport(#[source] io::Error),
    #[error("the killable HID output helper executable could not be resolved: {0}")]
    OutputWorkerExecutable(#[source] io::Error),
    #[error("the killable HID output helper could not be started: {0}")]
    OutputWorkerSpawn(#[source] io::Error),
    #[error("the exact HID handle could not be duplicated into the output helper: {0}")]
    OutputWorkerDuplicate(#[source] io::Error),
    #[error(
        "the retained parent-process handle could not be duplicated into the output helper: {0}"
    )]
    OutputWorkerParentDuplicate(#[source] io::Error),
    #[error("the fixed HID output request could not be delivered to its helper: {0}")]
    OutputWorkerRequest(#[source] io::Error),
    #[error("waiting for the killable HID output helper failed: {0}")]
    OutputWorkerWait(#[source] io::Error),
    #[error("the HID output helper exceeded its {timeout_ms} ms deadline and was terminated")]
    OutputWorkerTimedOut { timeout_ms: u32 },
    #[error(
        "the HID output helper exceeded its {timeout_ms} ms deadline, but terminating the exact retained child failed: {source}"
    )]
    OutputWorkerKillFailed {
        timeout_ms: u32,
        #[source]
        source: io::Error,
    },
    #[error("the HID output helper exited with code {code} without completing the report")]
    OutputWorkerFailed { code: i32 },
    #[error("creating the private overlapped-read event failed: {0}")]
    CreateReadEvent(#[source] io::Error),
    #[error("starting the overlapped five-byte HID read failed: {0}")]
    StartRead(#[source] io::Error),
    #[error("waiting for the overlapped five-byte HID read failed: {0}")]
    WaitForRead(#[source] io::Error),
    #[error("the overlapped HID read wait returned unexpected status {status:#X}")]
    UnexpectedWaitStatus { status: u32 },
    #[error("the five-byte HID read timed out after {timeout_ms} ms")]
    ReadTimedOut { timeout_ms: u32 },
    #[error("cleaning up a pending HID read failed: {0}")]
    CancelRead(#[source] io::Error),
    #[error("the HID report handle was closed after an undrained cancelled read")]
    ClosedAfterCancellation,
    #[error("completing the overlapped five-byte HID read failed: {0}")]
    CompleteRead(#[source] io::Error),
    #[error("the HID read completed with {actual} bytes, expected exactly 5")]
    UnexpectedReadLength { actual: u32 },
    #[error("explicit HID report transport is supported only on Windows")]
    UnsupportedPlatform,
}

/// One admitted, exact HID collection opened for fixed five-byte reports.
///
/// Methods take `&mut self` so one handle cannot accidentally carry concurrent
/// reads whose responses could be attributed to the wrong request.
pub struct HidReportDevice {
    inner: platform::Device,
    identity: HidReportIdentity,
    version_number: u16,
    capabilities: HidReportCapabilities,
}

impl HidReportDevice {
    /// Open exactly `device_path` with read/write + overlapped access, then
    /// re-verify its VID/PID, raw `VersionNumber`/`bcdDevice`, and its five-byte
    /// input/output report lengths.
    ///
    /// This function never enumerates devices and never guesses another path.
    pub fn open_exact(
        device_path: &str,
        expected: HidReportIdentity,
    ) -> Result<Self, HidReportError> {
        validate_path(device_path)?;
        let (inner, actual, version_number, capabilities) = platform::open_exact(device_path)?;
        verify_identity(expected, actual)?;
        verify_version_number(version_number)?;
        verify_capabilities(capabilities)?;
        Ok(Self {
            inner,
            identity: actual,
            version_number,
            capabilities,
        })
    }

    /// Identity re-read from the live handle after it was opened.
    pub fn identity(&self) -> HidReportIdentity {
        self.identity
    }

    /// Raw `VersionNumber`/`bcdDevice` re-read from the live handle after it
    /// was opened.
    pub fn version_number(&self) -> u16 {
        self.version_number
    }

    /// Capabilities re-read from the live handle after it was opened.
    pub fn capabilities(&self) -> HidReportCapabilities {
        self.capabilities
    }

    /// Send one complete five-byte output report with
    /// `HidD_SetOutputReport`.
    pub fn send_output_report(
        &mut self,
        report: [u8; HID_REPORT_BYTES],
    ) -> Result<(), HidReportError> {
        platform::send_output_report(&mut self.inner, report)
    }

    /// Read one complete five-byte input report with a bounded overlapped
    /// `ReadFile` operation.
    pub fn read_input_report(
        &mut self,
        timeout: Duration,
    ) -> Result<[u8; HID_REPORT_BYTES], HidReportError> {
        platform::read_input_report(&mut self.inner, timeout)
    }
}

/// Dispatch the fixed, pre-Clap worker mode used by [`HidReportDevice`].
///
/// A shipping executable that can host panel programming calls this before
/// logging or argument parsing. Ordinary invocations return `None`. The exact
/// internal spelling accepts no additional arguments; the request itself is a
/// 29-byte binary frame on the child's private stdin: magic, the duplicated
/// HID handle, the duplicated parent-process handle, and one five-byte report.
pub fn maybe_run_output_report_worker() -> Option<i32> {
    let mut args = std::env::args_os();
    let _executable = args.next();
    let requested = args
        .next()
        .is_some_and(|arg| arg == std::ffi::OsStr::new(OUTPUT_WORKER_ARG));
    if !requested || args.next().is_some() {
        return None;
    }
    Some(platform::run_output_report_worker())
}

fn output_worker_request(
    remote_handle: u64,
    remote_parent_handle: u64,
    report: [u8; HID_REPORT_BYTES],
) -> [u8; OUTPUT_WORKER_REQUEST_BYTES] {
    let mut request = [0_u8; OUTPUT_WORKER_REQUEST_BYTES];
    request[..OUTPUT_WORKER_MAGIC.len()].copy_from_slice(&OUTPUT_WORKER_MAGIC);
    let handle_start = OUTPUT_WORKER_MAGIC.len();
    request[handle_start..handle_start + 8].copy_from_slice(&remote_handle.to_le_bytes());
    let parent_start = handle_start + 8;
    request[parent_start..parent_start + 8].copy_from_slice(&remote_parent_handle.to_le_bytes());
    request[parent_start + 8..].copy_from_slice(&report);
    request
}

fn parse_output_worker_request(
    request: [u8; OUTPUT_WORKER_REQUEST_BYTES],
) -> Option<(u64, u64, [u8; HID_REPORT_BYTES])> {
    if request[..OUTPUT_WORKER_MAGIC.len()] != OUTPUT_WORKER_MAGIC {
        return None;
    }
    let handle_start = OUTPUT_WORKER_MAGIC.len();
    let remote_handle =
        u64::from_le_bytes(request[handle_start..handle_start + 8].try_into().ok()?);
    let parent_start = handle_start + 8;
    let remote_parent_handle =
        u64::from_le_bytes(request[parent_start..parent_start + 8].try_into().ok()?);
    let report = request[parent_start + 8..].try_into().ok()?;
    Some((remote_handle, remote_parent_handle, report))
}

fn validate_path(device_path: &str) -> Result<(), HidReportError> {
    if device_path.is_empty() {
        return Err(HidReportError::EmptyPath);
    }
    if device_path.encode_utf16().any(|word| word == 0) {
        return Err(HidReportError::PathContainsNul);
    }
    Ok(())
}

fn verify_identity(
    expected: HidReportIdentity,
    actual: HidReportIdentity,
) -> Result<(), HidReportError> {
    if actual == expected {
        return Ok(());
    }
    Err(HidReportError::IdentityMismatch {
        expected_vendor_id: expected.vendor_id,
        expected_product_id: expected.product_id,
        actual_vendor_id: actual.vendor_id,
        actual_product_id: actual.product_id,
    })
}

fn verify_version_number(actual: u16) -> Result<(), HidReportError> {
    if actual == IPAC4_VERSION_NUMBER {
        return Ok(());
    }
    Err(HidReportError::VersionNumberMismatch {
        expected: IPAC4_VERSION_NUMBER,
        actual,
    })
}

fn verify_capabilities(capabilities: HidReportCapabilities) -> Result<(), HidReportError> {
    if capabilities.usage_page != IPAC4_USAGE_PAGE || capabilities.usage != IPAC4_USAGE {
        return Err(HidReportError::CollectionUsageMismatch {
            actual_usage_page: capabilities.usage_page,
            actual_usage: capabilities.usage,
        });
    }
    if capabilities.input_report_bytes == HID_REPORT_BYTES_U16
        && capabilities.output_report_bytes == HID_REPORT_BYTES_U16
    {
        return Ok(());
    }
    Err(HidReportError::ReportSizeMismatch {
        input_report_bytes: capabilities.input_report_bytes,
        output_report_bytes: capabilities.output_report_bytes,
    })
}

fn exact_report(
    report: [u8; HID_REPORT_BYTES],
    transferred: u32,
) -> Result<[u8; HID_REPORT_BYTES], HidReportError> {
    if transferred == HID_REPORT_BYTES as u32 {
        Ok(report)
    } else {
        Err(HidReportError::UnexpectedReadLength {
            actual: transferred,
        })
    }
}

#[cfg(any(windows, test))]
fn bounded_wait_millis(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }
    // Round up so a positive sub-millisecond deadline never silently becomes
    // an immediate poll. `u32::MAX` is INFINITE, so it is never returned.
    timeout
        .as_nanos()
        .div_ceil(1_000_000)
        .min((u32::MAX - 1) as u128) as u32
}

#[cfg(windows)]
mod platform {
    use std::io::{Read as _, Write as _};
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use std::process::{Child, Stdio};
    use std::ptr;
    use std::time::Duration;

    use windows_sys::Win32::Devices::HumanInterfaceDevice::{
        HidD_FreePreparsedData, HidD_GetAttributes, HidD_GetPreparsedData, HidD_SetOutputReport,
        HidP_GetCaps, HIDD_ATTRIBUTES, HIDP_CAPS, HIDP_STATUS_SUCCESS, PHIDP_PREPARSED_DATA,
    };
    use windows_sys::Win32::Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_IO_INCOMPLETE, ERROR_IO_PENDING,
        ERROR_NOT_FOUND, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    use super::{
        bounded_wait_millis, exact_report, output_worker_request, parse_output_worker_request,
        HidReportCapabilities, HidReportError, HidReportIdentity, HID_REPORT_BYTES,
        OUTPUT_WORKER_EXIT_BAD_REQUEST, OUTPUT_WORKER_EXIT_REPORT_FAILED,
        OUTPUT_WORKER_EXIT_TIMED_OUT, OUTPUT_WORKER_KILL_WAIT_MS, OUTPUT_WORKER_REQUEST_BYTES,
        OUTPUT_WORKER_TIMEOUT_MS,
    };

    const HID_DESIRED_ACCESS: u32 = GENERIC_READ | GENERIC_WRITE;
    // Configuration transactions must not interleave with WinIPAC or another
    // process. If anything already owns this exact collection, fail closed.
    const HID_SHARE_MODE: u32 = 0;
    const HID_OPEN_FLAGS: u32 = FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED;
    const CANCEL_DRAIN_TIMEOUT_MS: u32 = 1_000;

    pub(super) struct Device {
        // An undrained cancellation takes and closes this handle. Keeping the
        // public session alive but inert prevents a later request from racing
        // the quarantined read and consuming its response.
        handle: Option<OwnedHandle>,
    }

    impl Device {
        fn raw_handle(&self) -> Result<HANDLE, HidReportError> {
            self.handle
                .as_ref()
                .map(|handle| handle.as_raw_handle().cast())
                .ok_or(HidReportError::ClosedAfterCancellation)
        }
    }

    struct Preparsed(PHIDP_PREPARSED_DATA);

    impl Drop for Preparsed {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: hidclass allocated this pointer for the live device
                // handle and transfers exactly one matching free to us.
                unsafe {
                    HidD_FreePreparsedData(self.0);
                }
            }
        }
    }

    struct PendingRead {
        event: OwnedHandle,
        overlapped: OVERLAPPED,
        /// Kernel-visible storage. The boxed owner never moves while the I/O
        /// is pending. Failed bounded cancellation deliberately leaks it.
        report: [u8; HID_REPORT_BYTES],
    }

    impl PendingRead {
        fn new() -> Result<Box<Self>, HidReportError> {
            // SAFETY: null security/name create an unnamed, non-inheritable
            // manual-reset event owned exclusively by this operation.
            let raw_event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
            if raw_event.is_null() {
                return Err(HidReportError::CreateReadEvent(
                    std::io::Error::last_os_error(),
                ));
            }
            // SAFETY: CreateEventW returned one owned handle.
            let event = unsafe { OwnedHandle::from_raw_handle(raw_event.cast()) };
            let mut pending = Box::new(Self {
                event,
                overlapped: OVERLAPPED::default(),
                report: [0; HID_REPORT_BYTES],
            });
            pending.overlapped.hEvent = pending.event.as_raw_handle().cast();
            Ok(pending)
        }
    }

    pub(super) fn open_exact(
        device_path: &str,
    ) -> Result<(Device, HidReportIdentity, u16, HidReportCapabilities), HidReportError> {
        let wide: Vec<u16> = device_path
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is the caller's exact path followed by one NUL. The
        // handle requests both report directions and is explicitly overlapped.
        let raw_handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                HID_DESIRED_ACCESS,
                HID_SHARE_MODE,
                ptr::null(),
                OPEN_EXISTING,
                HID_OPEN_FLAGS,
                ptr::null_mut(),
            )
        };
        if raw_handle == INVALID_HANDLE_VALUE {
            return Err(HidReportError::Open(std::io::Error::last_os_error()));
        }
        // SAFETY: CreateFileW returned one owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle.cast()) };

        let mut attributes = HIDD_ATTRIBUTES {
            Size: size_of::<HIDD_ATTRIBUTES>() as u32,
            ..HIDD_ATTRIBUTES::default()
        };
        // SAFETY: attributes is correctly sized writable storage and the
        // opened handle remains live.
        if !unsafe { HidD_GetAttributes(handle.as_raw_handle().cast(), &mut attributes) } {
            return Err(HidReportError::Attributes(std::io::Error::last_os_error()));
        }
        let identity = HidReportIdentity {
            vendor_id: attributes.VendorID,
            product_id: attributes.ProductID,
        };
        let version_number = attributes.VersionNumber;

        let mut raw_preparsed: PHIDP_PREPARSED_DATA = 0;
        // SAFETY: the out pointer is valid and the guard below owns the one
        // matching HidD_FreePreparsedData call.
        if !unsafe { HidD_GetPreparsedData(handle.as_raw_handle().cast(), &mut raw_preparsed) } {
            return Err(HidReportError::PreparsedData(
                std::io::Error::last_os_error(),
            ));
        }
        let preparsed = Preparsed(raw_preparsed);
        let mut caps = HIDP_CAPS::default();
        // SAFETY: preparsed data and output storage remain live for this call.
        let status = unsafe { HidP_GetCaps(preparsed.0, &mut caps) };
        if status != HIDP_STATUS_SUCCESS {
            return Err(HidReportError::Capabilities {
                status: status as u32,
            });
        }
        let capabilities = HidReportCapabilities {
            usage_page: caps.UsagePage,
            usage: caps.Usage,
            input_report_bytes: caps.InputReportByteLength,
            output_report_bytes: caps.OutputReportByteLength,
        };
        Ok((
            Device {
                handle: Some(handle),
            },
            identity,
            version_number,
            capabilities,
        ))
    }

    pub(super) fn send_output_report(
        device: &mut Device,
        report: [u8; HID_REPORT_BYTES],
    ) -> Result<(), HidReportError> {
        let handle = device.raw_handle()?;
        send_output_report_in_worker(handle, report)
    }

    /// Put the one synchronous, non-cancellable hidclass call in an
    /// expendable process. The admitted parent handle remains open for the
    /// complete report session; the worker receives a duplicate of that exact
    /// kernel object, so no path is reopened and no other panel tool can slip
    /// between a request and its response.
    fn send_output_report_in_worker(
        handle: HANDLE,
        report: [u8; HID_REPORT_BYTES],
    ) -> Result<(), HidReportError> {
        let executable = std::env::current_exe().map_err(HidReportError::OutputWorkerExecutable)?;
        let mut command = std::process::Command::new(executable);
        crate::process::no_window(
            command
                .arg(super::OUTPUT_WORKER_ARG)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        );
        let mut child = command.spawn().map_err(HidReportError::OutputWorkerSpawn)?;

        let mut remote_handle: HANDLE = ptr::null_mut();
        // SAFETY: `handle` is the live, descriptor-admitted HID handle owned
        // by the parent. `child.as_raw_handle()` is the exact retained process
        // object returned by CreateProcess. The target duplicate is explicitly
        // non-inheritable and receives the same access rights.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                handle,
                child.as_raw_handle().cast(),
                &mut remote_handle,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            let source = std::io::Error::last_os_error();
            let _ = terminate_output_worker(&mut child);
            return Err(HidReportError::OutputWorkerDuplicate(source));
        }

        let mut remote_parent_handle: HANDLE = ptr::null_mut();
        // SAFETY: both source arguments are this parent's pseudo-handle and
        // `child.as_raw_handle()` is the retained target process. Duplicating
        // the pseudo-handle converts it to a real handle in the child, limited
        // to SYNCHRONIZE. The worker can therefore watch this exact process
        // object without a pid lookup or pid-reuse identity race.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                GetCurrentProcess(),
                child.as_raw_handle().cast(),
                &mut remote_parent_handle,
                PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
        {
            let source = std::io::Error::last_os_error();
            let _ = terminate_output_worker(&mut child);
            return Err(HidReportError::OutputWorkerParentDuplicate(source));
        }

        let request = output_worker_request(
            remote_handle as usize as u64,
            remote_parent_handle as usize as u64,
            report,
        );
        let delivered = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("the helper stdin pipe was not created"))
            .and_then(|mut stdin| stdin.write_all(&request));
        if let Err(source) = delivered {
            let _ = terminate_output_worker(&mut child);
            return Err(HidReportError::OutputWorkerRequest(source));
        }

        // SAFETY: the child handle remains owned by `child` for this finite
        // wait. INFINITE is never used. A timeout terminates this exact helper,
        // never a user process; the durable encoder journal above this layer
        // therefore remains unresolved while the OS closes the duplicate HID
        // handle and aborts the wedged synchronous call.
        let waited =
            unsafe { WaitForSingleObject(child.as_raw_handle().cast(), OUTPUT_WORKER_TIMEOUT_MS) };
        if waited == WAIT_TIMEOUT {
            return match terminate_output_worker(&mut child) {
                Ok(()) => Err(HidReportError::OutputWorkerTimedOut {
                    timeout_ms: OUTPUT_WORKER_TIMEOUT_MS,
                }),
                Err(source) => Err(HidReportError::OutputWorkerKillFailed {
                    timeout_ms: OUTPUT_WORKER_TIMEOUT_MS,
                    source,
                }),
            };
        }
        if waited == WAIT_FAILED {
            let source = std::io::Error::last_os_error();
            let _ = terminate_output_worker(&mut child);
            return Err(HidReportError::OutputWorkerWait(source));
        }
        if waited != WAIT_OBJECT_0 {
            let _ = terminate_output_worker(&mut child);
            return Err(HidReportError::OutputWorkerWait(std::io::Error::other(
                format!("process wait returned unexpected status {waited:#X}"),
            )));
        }

        let status = child
            .try_wait()
            .map_err(HidReportError::OutputWorkerWait)?
            .ok_or_else(|| {
                HidReportError::OutputWorkerWait(std::io::Error::other(
                    "the helper process was signalled but had no exit status",
                ))
            })?;
        if status.success() {
            Ok(())
        } else if status.code() == Some(OUTPUT_WORKER_EXIT_TIMED_OUT) {
            Err(HidReportError::OutputWorkerTimedOut {
                timeout_ms: OUTPUT_WORKER_TIMEOUT_MS,
            })
        } else {
            Err(HidReportError::OutputWorkerFailed {
                code: status.code().unwrap_or(-1),
            })
        }
    }

    fn terminate_output_worker(child: &mut Child) -> std::io::Result<()> {
        if child.try_wait()?.is_none() {
            // This process exists solely to contain one otherwise unbounded
            // kernel call. Unlike `GameProcess`, it owns no user state and is
            // deliberately terminated on its deadline.
            child.kill()?;
        }
        // SAFETY: the retained child handle stays live for a bounded cleanup
        // wait. Windows has no zombie process once the handle is dropped, so a
        // second unbounded `Child::wait` is neither needed nor allowed here.
        let waited = unsafe {
            WaitForSingleObject(child.as_raw_handle().cast(), OUTPUT_WORKER_KILL_WAIT_MS)
        };
        if waited != WAIT_OBJECT_0 {
            return if waited == WAIT_FAILED {
                Err(std::io::Error::last_os_error())
            } else {
                Err(std::io::Error::other(format!(
                    "terminated output helper did not exit inside {OUTPUT_WORKER_KILL_WAIT_MS} ms (wait status {waited:#X})"
                )))
            };
        }
        let _ = child.try_wait()?;
        Ok(())
    }

    pub(super) fn run_output_report_worker() -> i32 {
        let mut request = [0_u8; OUTPUT_WORKER_REQUEST_BYTES];
        if std::io::stdin().read_exact(&mut request).is_err() {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        }
        let Some((remote_handle, remote_parent_handle, report)) =
            parse_output_worker_request(request)
        else {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        };
        let Ok(remote_handle) = usize::try_from(remote_handle) else {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        };
        let Ok(remote_parent_handle) = usize::try_from(remote_parent_handle) else {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        };
        if remote_handle == 0 || remote_handle == INVALID_HANDLE_VALUE as usize {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        }
        if remote_parent_handle == 0 || remote_parent_handle == INVALID_HANDLE_VALUE as usize {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        }
        // SAFETY: the parent duplicated its own process pseudo-handle into this
        // child with SYNCHRONIZE access and sent that target-process value over
        // private stdin. This child now owns exactly one matching close.
        let parent = unsafe { OwnedHandle::from_raw_handle(remote_parent_handle as *mut _) };
        let watchdog = std::thread::Builder::new()
            .name("ksx-hid-output-watchdog".to_owned())
            .spawn(move || {
                // A thread is not being presented as cancellation here. It ends
                // the expendable PROCESS, which is the actual isolation boundary,
                // if either the retained parent dies or the hard call deadline
                // expires. This also prevents an orphaned hung helper after a
                // parent crash.
                let _ = unsafe {
                    WaitForSingleObject(parent.as_raw_handle().cast(), OUTPUT_WORKER_TIMEOUT_MS)
                };
                // SAFETY: GetCurrentProcess is this helper's pseudo-handle. The
                // process owns no durable state; the parent journal remains the
                // recovery authority and its original HID handle is unaffected.
                unsafe {
                    TerminateProcess(GetCurrentProcess(), OUTPUT_WORKER_EXIT_TIMED_OUT as u32)
                };
            });
        if watchdog.is_err() {
            return OUTPUT_WORKER_EXIT_BAD_REQUEST;
        }
        // SAFETY: the parent created this process, duplicated its already
        // admitted HID handle into this process, and sent that target-process
        // value through our private stdin. This worker takes sole ownership of
        // the duplicate and closes it on every return path.
        let handle = unsafe { OwnedHandle::from_raw_handle(remote_handle as *mut _) };
        // SAFETY: `report` is the fixed descriptor-verified five-byte frame and
        // remains live for the call. If hidclass never returns, only this child
        // is wedged; the parent terminates it at the bounded deadline.
        if unsafe {
            HidD_SetOutputReport(
                handle.as_raw_handle().cast(),
                report.as_ptr().cast(),
                HID_REPORT_BYTES as u32,
            )
        } {
            0
        } else {
            OUTPUT_WORKER_EXIT_REPORT_FAILED
        }
    }

    pub(super) fn read_input_report(
        device: &mut Device,
        timeout: Duration,
    ) -> Result<[u8; HID_REPORT_BYTES], HidReportError> {
        let handle = device.raw_handle()?;
        let mut pending = PendingRead::new()?;
        let mut immediate_bytes = 0u32;
        // SAFETY: the device was opened with FILE_FLAG_OVERLAPPED. Both the
        // boxed OVERLAPPED and its fixed buffer remain stable until completion
        // is observed or bounded cleanup quarantines the whole allocation.
        let started = unsafe {
            ReadFile(
                handle,
                pending.report.as_mut_ptr(),
                HID_REPORT_BYTES as u32,
                &mut immediate_bytes,
                &mut pending.overlapped,
            )
        };
        if started != 0 {
            return exact_report(pending.report, immediate_bytes);
        }
        let start_error = std::io::Error::last_os_error();
        if start_error.raw_os_error().map(|code| code as u32) != Some(ERROR_IO_PENDING) {
            return Err(HidReportError::StartRead(start_error));
        }

        let timeout_ms = bounded_wait_millis(timeout);
        // SAFETY: the private event remains live for this finite wait.
        let waited =
            unsafe { WaitForSingleObject(pending.event.as_raw_handle().cast(), timeout_ms) };
        if waited == WAIT_OBJECT_0 {
            let mut transferred = 0u32;
            // SAFETY: the operation event is signalled and all kernel-visible
            // storage remains live; this is a nonblocking terminal query.
            if unsafe { GetOverlappedResult(handle, &pending.overlapped, &mut transferred, 0) } == 0
            {
                let completion = std::io::Error::last_os_error();
                if completion.raw_os_error().map(|code| code as u32) == Some(ERROR_IO_INCOMPLETE) {
                    cancel_pending(device, pending)?;
                }
                return Err(HidReportError::CompleteRead(completion));
            }
            return exact_report(pending.report, transferred);
        }

        if waited == WAIT_TIMEOUT {
            cancel_pending(device, pending)?;
            return Err(HidReportError::ReadTimedOut { timeout_ms });
        }
        if waited == WAIT_FAILED {
            let wait_error = std::io::Error::last_os_error();
            cancel_pending(device, pending)?;
            return Err(HidReportError::WaitForRead(wait_error));
        }
        cancel_pending(device, pending)?;
        Err(HidReportError::UnexpectedWaitStatus { status: waited })
    }

    fn cancel_pending(
        device: &mut Device,
        pending: Box<PendingRead>,
    ) -> Result<(), HidReportError> {
        let handle = device.raw_handle()?;
        // SAFETY: the boxed OVERLAPPED identifies this exact pending operation
        // and cannot move during cancellation.
        if unsafe { CancelIoEx(handle, &pending.overlapped) } == 0 {
            let cancellation = std::io::Error::last_os_error();
            if cancellation.raw_os_error().map(|code| code as u32) != Some(ERROR_NOT_FOUND) {
                // The kernel may still own both pointers. A bounded API cannot
                // await an uncooperative driver forever, so quarantine the
                // tiny allocation rather than risk freeing live I/O storage.
                quarantine(device, pending);
                return Err(HidReportError::CancelRead(std::io::Error::other(format!(
                    "CancelIoEx failed; pending storage was quarantined: {cancellation}"
                ))));
            }
        }

        // SAFETY: the private event and pending storage remain live for this
        // finite cleanup wait. No unbounded GetOverlappedResult call is used.
        let waited = unsafe {
            WaitForSingleObject(
                pending.event.as_raw_handle().cast(),
                CANCEL_DRAIN_TIMEOUT_MS,
            )
        };
        if waited == WAIT_OBJECT_0 {
            let mut transferred = 0u32;
            // SAFETY: a signalled event permits a nonblocking terminal query.
            // Cancellation normally reports ERROR_OPERATION_ABORTED, which is
            // terminal and therefore safe to drop.
            if unsafe { GetOverlappedResult(handle, &pending.overlapped, &mut transferred, 0) } == 0
            {
                let terminal = std::io::Error::last_os_error();
                if terminal.raw_os_error().map(|code| code as u32) == Some(ERROR_IO_INCOMPLETE) {
                    quarantine(device, pending);
                    return Err(HidReportError::CancelRead(std::io::Error::other(
                        "cancelled HID read remained incomplete; pending storage was quarantined",
                    )));
                }
            }
            return Ok(());
        }

        let failure = if waited == WAIT_TIMEOUT {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "cancelled HID read did not drain inside the cleanup ceiling",
            )
        } else if waited == WAIT_FAILED {
            std::io::Error::last_os_error()
        } else {
            std::io::Error::other(format!(
                "cancel drain wait returned unexpected status {waited:#X}"
            ))
        };
        quarantine(device, pending);
        Err(HidReportError::CancelRead(failure))
    }

    fn quarantine(device: &mut Device, pending: Box<PendingRead>) {
        // Preserve every kernel-visible address first, then close the device
        // handle so no later transaction can cross with this unknown read.
        let _ = Box::leak(pending);
        let _ = device.handle.take();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn report_handle_is_read_write_and_overlapped() {
            assert_eq!(HID_DESIRED_ACCESS, GENERIC_READ | GENERIC_WRITE);
            assert_eq!(
                HID_SHARE_MODE, 0,
                "another panel tool cannot interleave reports"
            );
            assert_ne!(HID_OPEN_FLAGS & FILE_FLAG_OVERLAPPED, 0);
        }

        #[test]
        fn cancellation_cleanup_is_finite() {
            assert_ne!(CANCEL_DRAIN_TIMEOUT_MS, 0);
            assert_ne!(CANCEL_DRAIN_TIMEOUT_MS, u32::MAX);
        }

        #[test]
        fn output_worker_kill_fixture() {
            let Some(ready) = std::env::var_os("KSX_OUTPUT_WORKER_KILL_FIXTURE") else {
                return;
            };
            std::fs::write(ready, b"ready").unwrap();
            std::thread::sleep(Duration::from_secs(30));
        }

        /// Exercise termination on an exact retained child without opening a
        /// HID collection. The child announces that it reached a deliberately
        /// long wait; the parent then uses the same bounded cleanup primitive
        /// as a wedged `HidD_SetOutputReport` call.
        #[test]
        fn output_worker_timeout_terminates_the_exact_child_process() {
            let ready = std::env::temp_dir().join(format!(
                "ksx-output-worker-kill-{}-{}.ready",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = std::fs::remove_file(&ready);
            let executable = std::env::current_exe().unwrap();
            let mut command = std::process::Command::new(executable);
            crate::process::no_window(
                command
                    .args([
                        "--exact",
                        "hid_report::platform::tests::output_worker_kill_fixture",
                    ])
                    .env("KSX_OUTPUT_WORKER_KILL_FIXTURE", &ready)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null()),
            );
            let mut child = command.spawn().unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !ready.is_file() {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "kill fixture exited before announcing readiness"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "kill fixture never announced readiness"
                );
                std::thread::sleep(Duration::from_millis(10));
            }

            terminate_output_worker(&mut child).unwrap();
            assert!(child.try_wait().unwrap().is_some());
            std::fs::remove_file(&ready).unwrap();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::time::Duration;

    use super::{HidReportCapabilities, HidReportError, HidReportIdentity, HID_REPORT_BYTES};

    pub(super) struct Device;

    pub(super) fn open_exact(
        _device_path: &str,
    ) -> Result<(Device, HidReportIdentity, u16, HidReportCapabilities), HidReportError> {
        Err(HidReportError::UnsupportedPlatform)
    }

    pub(super) fn send_output_report(
        _device: &mut Device,
        _report: [u8; HID_REPORT_BYTES],
    ) -> Result<(), HidReportError> {
        Err(HidReportError::UnsupportedPlatform)
    }

    pub(super) fn read_input_report(
        _device: &mut Device,
        _timeout: Duration,
    ) -> Result<[u8; HID_REPORT_BYTES], HidReportError> {
        Err(HidReportError::UnsupportedPlatform)
    }

    pub(super) fn run_output_report_worker() -> i32 {
        super::OUTPUT_WORKER_EXIT_BAD_REQUEST
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED: HidReportIdentity = HidReportIdentity {
        vendor_id: 0xD209,
        product_id: 0x0430,
    };

    #[test]
    fn collection_paths_are_exact_nonempty_strings() {
        assert!(matches!(validate_path(""), Err(HidReportError::EmptyPath)));
        assert!(matches!(
            validate_path("prefix\0suffix"),
            Err(HidReportError::PathContainsNul)
        ));
        assert!(validate_path(r"\\?\hid#vid_d209&pid_0430#exact").is_ok());
    }

    #[test]
    fn descriptor_identity_must_match_both_words() {
        assert!(verify_identity(EXPECTED, EXPECTED).is_ok());
        for actual in [
            HidReportIdentity {
                vendor_id: 0xD208,
                ..EXPECTED
            },
            HidReportIdentity {
                product_id: 0x0431,
                ..EXPECTED
            },
        ] {
            assert!(matches!(
                verify_identity(EXPECTED, actual),
                Err(HidReportError::IdentityMismatch { .. })
            ));
        }
    }

    #[test]
    fn live_handle_firmware_must_match_the_supported_raw_bcd_device() {
        assert!(verify_version_number(IPAC4_VERSION_NUMBER).is_ok());
        for actual in [0x0000, 0x0055, 0x0057, 0x5600] {
            assert!(matches!(
                verify_version_number(actual),
                Err(HidReportError::VersionNumberMismatch {
                    expected: IPAC4_VERSION_NUMBER,
                    actual: found,
                }) if found == actual
            ));
        }
    }

    #[test]
    fn both_report_lengths_must_be_exact_not_merely_large_enough() {
        let exact = HidReportCapabilities {
            usage_page: IPAC4_USAGE_PAGE,
            usage: IPAC4_USAGE,
            input_report_bytes: 5,
            output_report_bytes: 5,
        };
        assert!(verify_capabilities(exact).is_ok());
        for capabilities in [
            HidReportCapabilities {
                input_report_bytes: 4,
                ..exact
            },
            HidReportCapabilities {
                input_report_bytes: 6,
                ..exact
            },
            HidReportCapabilities {
                output_report_bytes: 4,
                ..exact
            },
            HidReportCapabilities {
                output_report_bytes: 6,
                ..exact
            },
        ] {
            assert!(matches!(
                verify_capabilities(capabilities),
                Err(HidReportError::ReportSizeMismatch { .. })
            ));
        }
    }

    #[test]
    fn collection_usage_is_part_of_live_writer_admission() {
        let exact = HidReportCapabilities {
            usage_page: IPAC4_USAGE_PAGE,
            usage: IPAC4_USAGE,
            input_report_bytes: 5,
            output_report_bytes: 5,
        };
        assert!(verify_capabilities(exact).is_ok());
        for capabilities in [
            HidReportCapabilities {
                usage_page: 0xFF00,
                ..exact
            },
            HidReportCapabilities {
                usage: 0x0001,
                ..exact
            },
        ] {
            assert!(matches!(
                verify_capabilities(capabilities),
                Err(HidReportError::CollectionUsageMismatch { .. })
            ));
        }
    }

    #[test]
    fn only_an_exact_completed_read_becomes_a_report() {
        let report = [0x03, 1, 2, 3, 4];
        assert_eq!(exact_report(report, 5).unwrap(), report);
        for actual in [0, 4, 6] {
            assert!(matches!(
                exact_report(report, actual),
                Err(HidReportError::UnexpectedReadLength { actual: found }) if found == actual
            ));
        }
    }

    #[test]
    fn output_worker_request_is_one_fixed_exact_frame() {
        let report = [0x03, 1, 2, 3, 4];
        let request = output_worker_request(0x0123_4567_89AB_CDEF, 0xFEDC_BA98_7654_3210, report);
        assert_eq!(OUTPUT_WORKER_REQUEST_BYTES, 29);
        assert_eq!(request.len(), OUTPUT_WORKER_REQUEST_BYTES);
        assert_eq!(
            parse_output_worker_request(request),
            Some((0x0123_4567_89AB_CDEF, 0xFEDC_BA98_7654_3210, report))
        );

        let mut wrong_magic = request;
        wrong_magic[0] ^= 0xFF;
        assert_eq!(parse_output_worker_request(wrong_magic), None);
    }

    /// Regression for the synchronous parent call: a detached thread cannot
    /// cancel `HidD_SetOutputReport`, so the only honest timeout boundary is a
    /// retained child process that can be terminated by its exact handle.
    /// Source inspection is pure and never opens a HID collection.
    #[test]
    fn synchronous_output_exists_only_inside_the_killable_worker() {
        let source = include_str!("hid_report.rs").replace("\r\n", "\n");
        let parent = source
            .split("fn send_output_report_in_worker(")
            .nth(1)
            .expect("parent output boundary")
            .split("pub(super) fn run_output_report_worker()")
            .next()
            .unwrap();
        for required in [
            "DuplicateHandle(",
            "PROCESS_SYNCHRONIZE",
            "WaitForSingleObject(",
            "OUTPUT_WORKER_TIMEOUT_MS",
            "child.kill()",
            "crate::process::no_window(",
        ] {
            assert!(parent.contains(required), "missing {required}");
        }
        assert!(parent.matches("DuplicateHandle(").count() >= 2);
        assert!(parent.contains("status.code() == Some(OUTPUT_WORKER_EXIT_TIMED_OUT)"));
        assert!(!parent.contains("HidD_SetOutputReport("));

        let worker = source
            .split("pub(super) fn run_output_report_worker()")
            .nth(1)
            .expect("child output worker")
            .split("pub(super) fn read_input_report(")
            .next()
            .unwrap();
        assert!(worker.contains("HidD_SetOutputReport("));
        assert!(worker.contains("OwnedHandle::from_raw_handle"));
        assert!(!worker.contains("OpenProcess("));
        assert!(worker.contains("TerminateProcess("));
    }

    #[test]
    fn wait_deadlines_round_up_and_never_become_infinite() {
        assert_eq!(bounded_wait_millis(Duration::ZERO), 0);
        assert_eq!(bounded_wait_millis(Duration::from_nanos(1)), 1);
        assert_eq!(bounded_wait_millis(Duration::from_micros(1_001)), 2);
        assert_eq!(bounded_wait_millis(Duration::from_millis(99)), 99);
        assert_eq!(
            bounded_wait_millis(Duration::from_secs(u32::MAX as u64)),
            u32::MAX - 1
        );
    }

    #[test]
    fn explicit_transport_does_not_enumerate_or_use_feature_reports() {
        let source = include_str!("hid_report.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        let forbidden = [
            ["Setup", "Di"].concat(),
            ["HidD", "_SetFeature"].concat(),
            ["HidD", "_GetFeature"].concat(),
            ["Write", "File("].concat(),
            ["Device", "IoControl"].concat(),
        ];
        for symbol in forbidden {
            assert!(
                !production.contains(&symbol),
                "explicit transport gained out-of-scope primitive {symbol}"
            );
        }
    }
}
