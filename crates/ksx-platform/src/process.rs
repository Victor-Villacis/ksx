//! Process inspection and shell activation — the OS half of game launching.
//!
//! `ksx-games` owns the *policy* (when to launch, when a launcher counts as a
//! hand-off, when a session is over); this module owns the two Win32 calls that
//! policy needs and cannot be expressed with `std`:
//!
//! - [`snapshot`] — one `CreateToolhelp32Snapshot` pass, so "is `mame.exe`
//!   still running?" is answerable for a process ksx never spawned. Required
//!   for Steam/Epic/launcher hand-offs, where the thing we started is gone and
//!   the thing we care about was started by somebody else.
//! - [`shell_open`] — `ShellExecuteW("open", …)` for `steam://rungameid/NNN`
//!   and other protocol targets. `Command::new("steam://…")` cannot work:
//!   there is no such executable, the URL is resolved by the shell's protocol
//!   registration.
//!
//! Everything here is off the input hot path by construction — it is polled at
//! a few hertz from the supervisor thread.
//!
//! - [`launch`] — start an executable and keep a **process handle**, so
//!   liveness is answered without ever consulting a pid (pids are reused;
//!   handles are not).
//!
//! Off Windows every function degrades to a documented no-op/`Unsupported`
//! rather than failing to compile, so `ksx-games`' policy layer keeps its
//! cross-platform unit tests.
//!
//! # No-kill policy (deliberate, and enforced by a test)
//!
//! There is no `kill`, `terminate` or `stop` primitive in this module and there
//! will not be one. ksx starts the user's game as a convenience; it does not
//! own it. `TerminateProcess` gives a game no chance to flush a save, and the
//! one thing worse than a cabinet that will not stop cleanly is a cabinet that
//! eats a two-hour campaign because emulation wanted to shut down. When ksx
//! stops first, the game keeps running with a plain keyboard. Preserving the
//! player's running game is the contract.
//!
//! [`GameProcess`] therefore exposes only `is_alive` and `wait_timeout`.
//! `std::process::Child::kill` is reachable through the inner handle by
//! construction; `into_inner` does not exist, the field is private, and
//! `tests::no_kill_primitive_exists` reads this file to keep it that way.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// UAC includes human response time and driver work, but never an unbounded
/// wait which can freeze Studio or an uninstaller forever.
pub const ELEVATED_HELPER_WAIT_MS: u32 = 5 * 60 * 1_000;

/// Why an executable sibling is not safe to cross an elevation boundary.
///
/// A same-directory check alone is insufficient: an unelevated copy launched
/// from Downloads could place an arbitrary helper or DLL beside itself.  KSX
/// therefore requires a canonical Program Files location obtained from Known
/// Folders *and* a DACL on the directory and both files which grants mutation
/// rights only to SYSTEM, Administrators, or TrustedInstaller.
#[derive(Debug, thiserror::Error)]
pub enum ProtectedInstallError {
    #[error("the installed executable or sibling is missing: {0}")]
    Missing(String),
    #[error("the installed executable and sibling must be absolute canonical files")]
    NotAbsolute,
    #[error("the recovery-store initializer must be named ksx-winusb-helper.exe")]
    UnexpectedInitializerName,
    #[error("the protected executable must be named {expected}; found {actual}")]
    UnexpectedExecutableName {
        expected: &'static str,
        actual: String,
    },
    #[error("the installed sibling is not beside the running executable")]
    NotSibling,
    #[error("the KSX installation is not under a Windows Program Files Known Folder")]
    OutsideProgramFiles,
    #[error("could not resolve a Windows Program Files Known Folder: {0}")]
    KnownFolder(String),
    #[error("the KSX installation path is not protected: {0}")]
    UnsafeAcl(String),
    #[error("the protected executable could not be sealed to one file object: {0}")]
    Seal(#[source] std::io::Error),
    #[error("protected installation validation is available only on Windows")]
    Unsupported,
}

/// One fixed executable whose canonical installed path and live ACL were
/// validated and whose file object is held against writes, deletes and swaps.
///
/// There is no public constructor and no `Clone`: callers obtain one only from
/// [`protected_winusb_helper`] and spend it in [`launch_elevated`]. After
/// successful launch identity establishment, the token moves into
/// [`ElevatedChild`], extending the seal across the whole elevated conversation
/// instead of merely across ShellExecuteEx.
pub struct ProtectedExecutable {
    _sealed: crate::sealed::SealedFile,
    canonical_image: PathBuf,
}

impl std::fmt::Debug for ProtectedExecutable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtectedExecutable")
            .field("canonical_image", &self.canonical_image)
            .finish_non_exhaustive()
    }
}

impl ProtectedExecutable {
    /// Handle-derived canonical image which will be passed to ShellExecuteEx.
    pub fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }
}

/// Validate and return one canonical installed sibling suitable for a
/// protected load.
///
/// The roots come from `SHGetKnownFolderPath`, never environment variables.
/// Prefix membership is only the first gate; the live ACL check below is what
/// catches a Program Files subtree whose permissions were weakened. Elevated
/// execution requires one of the fixed sealed-token factories above.
#[cfg(windows)]
pub fn protected_install_sibling(
    executable: &Path,
    sibling: &Path,
) -> Result<PathBuf, ProtectedInstallError> {
    let executable = executable.canonicalize().map_err(|err| {
        ProtectedInstallError::Missing(format!("{}: {err}", executable.display()))
    })?;
    let sibling = sibling
        .canonicalize()
        .map_err(|err| ProtectedInstallError::Missing(format!("{}: {err}", sibling.display())))?;
    let roots = program_files_known_folders()?;
    let policy = crate::installer::SearchPolicy {
        elevated: Some(true),
        protected_roots: roots,
    };
    validate_canonical_install_sibling_with(&executable, &sibling, &policy, strong_acl)?;
    Ok(sibling)
}

#[cfg(windows)]
fn protected_executable_sibling(
    executable: &Path,
    sibling: &Path,
    expected_name: &'static str,
) -> Result<ProtectedExecutable, ProtectedInstallError> {
    let canonical = protected_install_sibling(executable, sibling)?;
    validate_protected_executable_name(&canonical, expected_name)?;
    verify_non_reparse_kind(&canonical, false)?;
    let sealed =
        crate::sealed::SealedFile::open_strict(&canonical).map_err(ProtectedInstallError::Seal)?;
    let handle_path = sealed.exec_path().to_path_buf();
    if !executable_path_eq(&canonical, &handle_path) {
        return Err(ProtectedInstallError::Seal(std::io::Error::other(
            "the sealed handle resolves to a different executable path",
        )));
    }
    Ok(ProtectedExecutable {
        _sealed: sealed,
        canonical_image: handle_path,
    })
}

#[cfg(windows)]
fn protected_current_executable_sibling(
    expected_name: &'static str,
) -> Result<ProtectedExecutable, ProtectedInstallError> {
    let current = std::env::current_exe()
        .map_err(|err| ProtectedInstallError::Missing(format!("the current executable: {err}")))?;
    let parent = current.parent().ok_or(ProtectedInstallError::NotSibling)?;
    protected_executable_sibling(&current, &parent.join(expected_name), expected_name)
}

/// Resolve and seal the fixed installed WinUSB recovery helper.
///
/// Neither image path nor basename comes from a request, configuration, CWD,
/// `PATH`, or environment variable.
#[cfg(windows)]
pub fn protected_winusb_helper() -> Result<ProtectedExecutable, ProtectedInstallError> {
    protected_current_executable_sibling("ksx-winusb-helper.exe")
}

/// Resolve and seal the fixed installed HIDMaestro runtime host.
///
/// The basename, directory and launch image are not configurable. The host is
/// deliberately unavailable from a portable copy: it crosses an elevation
/// boundary and therefore requires the Program Files/DACL proof enforced by
/// [`protected_current_executable_sibling`].
#[cfg(windows)]
pub fn protected_hidmaestro_host() -> Result<ProtectedExecutable, ProtectedInstallError> {
    protected_current_executable_sibling("ksx-hidmaestro-host.exe")
}

/// The SDK-lane elevated host: Switch Pro and Xbox Series through the pinned
/// official HIDMaestro SDK. A separate installed sibling from the candidate
/// host (which is NativeAOT and stays byte-stable); the same Program
/// Files/DACL proof applies.
#[cfg(windows)]
pub fn protected_hidmaestro_sdk_host() -> Result<ProtectedExecutable, ProtectedInstallError> {
    protected_current_executable_sibling("ksx-hidmaestro-sdk-host.exe")
}

fn validate_protected_executable_name(
    canonical: &Path,
    expected_name: &'static str,
) -> Result<(), ProtectedInstallError> {
    let actual = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let expected_path = Path::new(expected_name);
    if expected_path.file_name() != Some(std::ffi::OsStr::new(expected_name))
        || !expected_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        || !actual.eq_ignore_ascii_case(expected_name)
    {
        Err(ProtectedInstallError::UnexpectedExecutableName {
            expected: expected_name,
            actual,
        })
    } else {
        Ok(())
    }
}

/// Validate the one temporary executable the installer may use to bootstrap
/// the fixed ProgramData recovery store.
///
/// Unlike [`protected_install_sibling`], this entrypoint intentionally does
/// not require Program Files: before files are installed, Inno runs the helper
/// from its private temporary directory. The executable name is fixed, both it
/// and its immediate parent must be ordinary non-reparse objects, and their
/// live owner/DACL must allow mutation only to installation authorities. The
/// initializer accepts no path and loads no sibling DLL.
#[cfg(windows)]
pub fn protected_store_initializer() -> Result<PathBuf, ProtectedInstallError> {
    let executable = std::env::current_exe()
        .map_err(|err| ProtectedInstallError::Missing(format!("the current executable: {err}")))?;
    let parent = executable
        .parent()
        .ok_or(ProtectedInstallError::NotAbsolute)?;
    verify_non_reparse_kind(parent, true)?;
    verify_non_reparse_kind(&executable, false)?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|err| ProtectedInstallError::Missing(format!("{}: {err}", parent.display())))?;
    let canonical_executable = executable.canonicalize().map_err(|err| {
        ProtectedInstallError::Missing(format!("{}: {err}", executable.display()))
    })?;
    validate_canonical_store_initializer_with(
        &canonical_executable,
        &canonical_parent,
        strong_acl,
    )?;
    Ok(canonical_executable)
}

#[cfg(not(windows))]
pub fn protected_store_initializer() -> Result<PathBuf, ProtectedInstallError> {
    Err(ProtectedInstallError::Unsupported)
}

#[cfg(windows)]
pub(crate) fn verify_non_reparse_kind(
    path: &Path,
    directory: bool,
) -> Result<(), ProtectedInstallError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a live NUL-terminated path.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == u32::MAX
        || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(ProtectedInstallError::UnsafeAcl(format!(
            "{} is missing, has the wrong kind, or is a reparse point",
            path.display()
        )));
    }
    Ok(())
}

fn validate_canonical_store_initializer_with<F>(
    executable: &Path,
    parent: &Path,
    mut acl: F,
) -> Result<(), ProtectedInstallError>
where
    F: FnMut(&Path) -> Result<(), ProtectedInstallError>,
{
    if !executable.is_absolute() || !parent.is_absolute() || executable.parent() != Some(parent) {
        return Err(ProtectedInstallError::NotAbsolute);
    }
    if !executable.file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case("ksx-winusb-helper.exe")
    }) {
        return Err(ProtectedInstallError::UnexpectedInitializerName);
    }
    acl(parent)?;
    acl(executable)
}

#[cfg(not(windows))]
pub fn protected_install_sibling(
    _executable: &Path,
    _sibling: &Path,
) -> Result<PathBuf, ProtectedInstallError> {
    Err(ProtectedInstallError::Unsupported)
}

#[cfg(not(windows))]
pub fn protected_winusb_helper() -> Result<ProtectedExecutable, ProtectedInstallError> {
    Err(ProtectedInstallError::Unsupported)
}

#[cfg(not(windows))]
pub fn protected_hidmaestro_sdk_host() -> Result<ProtectedExecutable, ProtectedInstallError> {
    Err(ProtectedInstallError::Unsupported)
}

#[cfg(not(windows))]
pub fn protected_hidmaestro_host() -> Result<ProtectedExecutable, ProtectedInstallError> {
    Err(ProtectedInstallError::Unsupported)
}

/// Pure policy half, with ACL inspection injected for regression tests.  Both
/// inputs must already be canonical: production obtains them from
/// `Path::canonicalize`, while tests can use synthetic Windows paths without
/// touching an installed copy.
fn validate_canonical_install_sibling_with<F>(
    executable: &Path,
    sibling: &Path,
    policy: &crate::installer::SearchPolicy,
    mut acl: F,
) -> Result<(), ProtectedInstallError>
where
    F: FnMut(&Path) -> Result<(), ProtectedInstallError>,
{
    if !executable.is_absolute() || !sibling.is_absolute() {
        return Err(ProtectedInstallError::NotAbsolute);
    }
    let parent = executable
        .parent()
        .ok_or(ProtectedInstallError::NotSibling)?;
    if sibling.parent() != Some(parent) {
        return Err(ProtectedInstallError::NotSibling);
    }
    if !policy.is_protected(parent) {
        return Err(ProtectedInstallError::OutsideProgramFiles);
    }
    let mut chain = Vec::new();
    for ancestor in parent.ancestors() {
        chain.push(ancestor);
        if policy
            .protected_roots
            .iter()
            .any(|root| path_eq_ci(ancestor, root))
        {
            break;
        }
    }
    if !chain.last().is_some_and(|ancestor| {
        policy
            .protected_roots
            .iter()
            .any(|root| path_eq_ci(ancestor, root))
    }) {
        return Err(ProtectedInstallError::OutsideProgramFiles);
    }
    for directory in chain.into_iter().rev() {
        acl(directory)?;
    }
    acl(executable)?;
    acl(sibling)?;
    Ok(())
}

fn path_eq_ci(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

fn executable_path_eq(left: &Path, right: &Path) -> bool {
    let left = left.as_os_str().to_string_lossy();
    let right = right.as_os_str().to_string_lossy();
    crate::sealed::strip_dos_prefix(&left)
        .eq_ignore_ascii_case(crate::sealed::strip_dos_prefix(&right))
}

#[cfg(windows)]
fn program_files_known_folders() -> Result<Vec<PathBuf>, ProtectedInstallError> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX64, FOLDERID_ProgramFilesX86,
        SHGetKnownFolderPath,
    };

    let mut roots = Vec::new();
    for folder in [
        FOLDERID_ProgramFiles,
        FOLDERID_ProgramFilesX64,
        FOLDERID_ProgramFilesX86,
    ] {
        let mut raw = std::ptr::null_mut();
        // SAFETY: `raw` is an out pointer freed with CoTaskMemFree.
        let status = unsafe { SHGetKnownFolderPath(&folder, 0, std::ptr::null_mut(), &mut raw) };
        if status < 0 || raw.is_null() {
            return Err(ProtectedInstallError::KnownFolder(format!(
                "SHGetKnownFolderPath failed ({status:#x})"
            )));
        }
        let len = unsafe {
            let mut len = 0usize;
            while *raw.add(len) != 0 {
                len += 1;
            }
            len
        };
        let root = PathBuf::from(std::ffi::OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw, len)
        }));
        unsafe { CoTaskMemFree(raw.cast()) };
        let root = root.canonicalize().map_err(|err| {
            ProtectedInstallError::KnownFolder(format!("{}: {err}", root.display()))
        })?;
        if !roots.iter().any(|known: &PathBuf| {
            known
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&root.as_os_str().to_string_lossy())
        }) {
            roots.push(root);
        }
    }
    if roots.is_empty() {
        return Err(ProtectedInstallError::KnownFolder(
            "Windows returned no Program Files directories".to_owned(),
        ));
    }
    Ok(roots)
}

/// Fail-closed ACL validation for an install directory or executable file.
/// Any principal other than the three Windows installation authorities may
/// read/execute, but may not alter, delete, replace, or rewrite permissions.
#[cfg(windows)]
pub(crate) fn trusted_owner(path: &Path) -> Result<(), ProtectedInstallError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, IsWellKnownSid, WinBuiltinAdministratorsSid, WinLocalSystemSid,
        OWNER_SECURITY_INFORMATION, PSID,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: output pointers are valid and the returned descriptor is freed.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 || descriptor.is_null() || owner.is_null() {
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor) };
        }
        return Err(ProtectedInstallError::UnsafeAcl(format!(
            "cannot read the owner of {} (error {status})",
            path.display()
        )));
    }
    let trusted_installer_text: Vec<u16> =
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
    let mut trusted_installer: PSID = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(trusted_installer_text.as_ptr(), &mut trusted_installer) }
        == 0
        || trusted_installer.is_null()
    {
        unsafe { LocalFree(descriptor) };
        return Err(ProtectedInstallError::UnsafeAcl(
            "cannot construct the TrustedInstaller SID".to_owned(),
        ));
    }
    let trusted = unsafe {
        IsWellKnownSid(owner, WinLocalSystemSid) != 0
            || IsWellKnownSid(owner, WinBuiltinAdministratorsSid) != 0
            || EqualSid(owner, trusted_installer) != 0
    };
    unsafe {
        LocalFree(trusted_installer);
        LocalFree(descriptor);
    }
    if !trusted {
        return Err(ProtectedInstallError::UnsafeAcl(format!(
            "{} is not owned by SYSTEM, Administrators, or TrustedInstaller",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn strong_acl(path: &Path) -> Result<(), ProtectedInstallError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::{LocalFree, GENERIC_ALL, GENERIC_WRITE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, IsWellKnownSid, WinBuiltinAdministratorsSid, WinLocalSystemSid,
        ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
        OWNER_SECURITY_INFORMATION, PSID,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_APPEND_DATA, FILE_DELETE_CHILD,
        FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE,
        ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE, ACCESS_ALLOWED_OBJECT_ACE_TYPE,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: output pointers are valid and the returned descriptor is freed.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 || descriptor.is_null() || owner.is_null() || dacl.is_null() {
        if !descriptor.is_null() {
            unsafe { LocalFree(descriptor) };
        }
        return Err(ProtectedInstallError::UnsafeAcl(format!(
            "cannot read {} (error {status})",
            path.display()
        )));
    }

    let trusted_installer_text: Vec<u16> =
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
    let mut trusted_installer: PSID = std::ptr::null_mut();
    if unsafe { ConvertStringSidToSidW(trusted_installer_text.as_ptr(), &mut trusted_installer) }
        == 0
        || trusted_installer.is_null()
    {
        unsafe { LocalFree(descriptor) };
        return Err(ProtectedInstallError::UnsafeAcl(
            "cannot construct the TrustedInstaller SID".to_owned(),
        ));
    }
    let trusted = |sid: PSID| unsafe {
        IsWellKnownSid(sid, WinLocalSystemSid) != 0
            || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
            || EqualSid(sid, trusted_installer) != 0
    };
    if !trusted(owner) {
        unsafe {
            LocalFree(trusted_installer);
            LocalFree(descriptor);
        }
        return Err(ProtectedInstallError::UnsafeAcl(format!(
            "{} is not owned by SYSTEM, Administrators, or TrustedInstaller",
            path.display()
        )));
    }

    let dangerous = GENERIC_ALL
        | GENERIC_WRITE
        | FILE_WRITE_DATA
        | FILE_APPEND_DATA
        | FILE_ADD_FILE
        | FILE_ADD_SUBDIRECTORY
        | FILE_DELETE_CHILD
        | FILE_WRITE_ATTRIBUTES
        | DELETE
        | WRITE_DAC
        | WRITE_OWNER;
    for index in 0..unsafe { (*dacl).AceCount as u32 } {
        let mut ace = std::ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            unsafe {
                LocalFree(trusted_installer);
                LocalFree(descriptor);
            }
            return Err(ProtectedInstallError::UnsafeAcl(format!(
                "cannot enumerate the ACL on {}",
                path.display()
            )));
        }
        let header = ace.cast::<windows_sys::Win32::Security::ACE_HEADER>();
        let ace_type = unsafe { (*header).AceType } as u32;
        let ace_flags = unsafe { (*header).AceFlags };
        if ace_type == ACCESS_ALLOWED_ACE_TYPE {
            let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
            let mask = unsafe { (*allowed).Mask };
            let sid = unsafe { (&mut (*allowed).SidStart as *mut u32).cast() };
            if allowed_ace_mutates_current_object(
                ace_flags,
                mask,
                dangerous,
                trusted(sid),
                INHERIT_ONLY_ACE as u8,
            ) {
                unsafe {
                    LocalFree(trusted_installer);
                    LocalFree(descriptor);
                }
                return Err(ProtectedInstallError::UnsafeAcl(format!(
                    "{} grants mutation rights to a non-installation principal",
                    path.display()
                )));
            }
        } else if matches!(
            ace_type,
            ACCESS_ALLOWED_OBJECT_ACE_TYPE
                | ACCESS_ALLOWED_CALLBACK_ACE_TYPE
                | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE
        ) {
            // Every allowed ACE layout begins with ACE_HEADER then Mask.  We
            // intentionally do not attempt the variable object/callback SID
            // layout: a dangerous unfamiliar allow rule is refused outright.
            let mask = unsafe {
                std::ptr::read_unaligned(
                    ace.cast::<u8>()
                        .add(std::mem::size_of::<windows_sys::Win32::Security::ACE_HEADER>())
                        .cast::<u32>(),
                )
            };
            if allowed_ace_mutates_current_object(
                ace_flags,
                mask,
                dangerous,
                false,
                INHERIT_ONLY_ACE as u8,
            ) {
                unsafe {
                    LocalFree(trusted_installer);
                    LocalFree(descriptor);
                }
                return Err(ProtectedInstallError::UnsafeAcl(format!(
                    "{} has an unsupported allow ACE with mutation rights",
                    path.display()
                )));
            }
        }
    }
    unsafe {
        LocalFree(trusted_installer);
        LocalFree(descriptor);
    }
    Ok(())
}

/// Pure ACE decision used by the live ACL walker and its Program Files fixture
/// test. `CREATOR OWNER:(OI)(CI)(IO)(F)` is ordinary and safe for the current
/// object because `IO` means inherit-only; dropping that flag would make every
/// normal machine-wide install fail closed forever.
#[cfg(windows)]
fn allowed_ace_mutates_current_object(
    ace_flags: u8,
    mask: u32,
    dangerous: u32,
    trusted_principal: bool,
    inherit_only_flag: u8,
) -> bool {
    ace_flags & inherit_only_flag == 0 && mask & dangerous != 0 && !trusted_principal
}

/// Windows' native system directory, obtained from the kernel rather than an
/// inherited environment variable.  Security-sensitive tools such as
/// `pnputil.exe` must never be resolved through `%SystemRoot%` or `PATH` in an
/// elevated process.
#[cfg(windows)]
pub fn system_directory() -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = vec![0u16; 260];
    loop {
        // SAFETY: `buffer` is writable for the advertised number of UTF-16
        // code units and remains alive through the call.
        let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if len == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let len = len as usize;
        if len < buffer.len() {
            return Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..len],
            )));
        }
        buffer.resize(len + 1, 0);
    }
}

#[cfg(not(windows))]
pub fn system_directory() -> std::io::Result<std::path::PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "the Windows system directory is available only on Windows",
    ))
}

/// `CREATE_NO_WINDOW` — "this console application is being run without a
/// console window" (`winbase.h`).
///
/// Named here rather than pulled from `windows-sys` so the constant is
/// available in the one place every spawn already imports, and so the value is
/// visible beside the reason it exists.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// **Spawn without conjuring a console window.**
///
/// ksx's daemon calls `FreeConsole` the moment its tray icon is up
/// (`crate::console` in `ksx-app`), so from then on it has *no* console. On
/// Windows a console-subsystem child started by a parent with no console gets a
/// **brand new console window of its own** — which is drawn, focused, and torn
/// down again when the child exits. That is not a theoretical nuisance: the
/// cabinet window's status refresh runs `schtasks /Query` every two seconds, so
/// a black window flashed over the 10-foot panel every two seconds for the
/// whole of an evening's hardware session, with nothing in any log to name it.
///
/// So: **every spawn ksx makes for its own plumbing goes through this.** The
/// two deliberate exceptions are marked `NO_WINDOW_EXEMPT:` at the call site,
/// with a reason, and [`tests::every_spawn_either_hides_its_console_or_says_why`]
/// keeps that list honest.
///
/// Off Windows this is the identity function: there is no such flag, and there
/// is no console to conjure.
pub fn no_window(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// One live process, as the OS snapshot reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    /// Parent pid as recorded at snapshot time. Unreliable by nature (the
    /// parent may already be gone and the id reused), so ksx uses it only as a
    /// *tie-breaker*, never as the identity of a tracked game.
    pub parent_pid: u32,
    /// Image name only (`mame.exe`), never a full path — that is all
    /// `PROCESSENTRY32W` carries.
    pub name: String,
}

impl ProcessEntry {
    /// Windows process names are case-insensitive; profiles must not have to
    /// match the on-disk casing.
    pub fn name_matches(&self, wanted: &str) -> bool {
        self.name.eq_ignore_ascii_case(wanted)
    }
}

/// Enumerate every process visible to this token.
///
/// Returns an empty vector (never an error) when the snapshot cannot be taken:
/// a failed enumeration must read as "nothing matched yet", so a transient
/// failure cannot be mistaken for "the game exited". The caller's grace window
/// is what turns a *persistent* failure into a decision.
#[cfg(windows)]
pub fn snapshot() -> Vec<ProcessEntry> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut out = Vec::new();
    // SAFETY: TH32CS_SNAPPROCESS with pid 0 is the documented "all processes"
    // form; the returned handle is closed on every path below.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == INVALID_HANDLE_VALUE {
        return out;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `entry` is a correctly sized, zeroed PROCESSENTRY32W owned here.
    let mut ok = unsafe { Process32FirstW(snap, &mut entry) } != 0;
    while ok {
        let len = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        out.push(ProcessEntry {
            pid: entry.th32ProcessID,
            parent_pid: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        ok = unsafe { Process32NextW(snap, &mut entry) } != 0;
    }
    // SAFETY: `snap` is a valid handle from CreateToolhelp32Snapshot.
    unsafe { CloseHandle(snap) };
    out
}

#[cfg(not(windows))]
pub fn snapshot() -> Vec<ProcessEntry> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// Launching, with a handle
// ---------------------------------------------------------------------------

/// A process ksx started and still holds a handle to.
///
/// The handle — not the pid — is the identity. A pid can be recycled the
/// instant the process dies, so "is pid 4242 still there?" is a question that
/// can be answered `yes` about a completely different program; a handle stays
/// valid and signalled for as long as this value lives.
///
/// See the module docs for why there is no way to kill it.
pub struct GameProcess {
    child: std::process::Child,
    pid: u32,
    /// Cached once the process has been reaped, so repeated polls after exit
    /// stay cheap and consistent.
    exit_code: Option<i32>,
}

impl std::fmt::Debug for GameProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GameProcess")
            .field("pid", &self.pid)
            .field("exit_code", &self.exit_code)
            .finish()
    }
}

/// Why a process could not be started.
#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("the executable does not exist: {0}")]
    NotFound(String),
    #[error("could not start '{path}': {source}")]
    Spawn {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// Start `exe` with `args`, in `working_dir` (defaulting to the exe's own
/// directory).
///
/// The existence check up front is not redundant with the spawn error: it lets
/// the caller distinguish "this profile is misconfigured" (checkable before
/// anything is plugged, exit 2) from "the OS refused to start it" (exit 3).
///
/// # No `CREATE_NO_WINDOW` here, deliberately
///
/// Every *other* spawn in ksx goes through [`no_window`], because every other
/// spawn is ksx's own plumbing whose output ksx captures. This one starts **the
/// user's program**, and the same policy that says ksx never terminates a game
/// (the no-kill rule in the module docs) says ksx must not decide that a game's
/// console is invisible:
///
/// - a GUI game is unaffected either way — the flag is ignored for a
///   non-console subsystem, so setting it would buy nothing;
/// - a console emulator (MAME's `-verbose`, DOSBox, a ScummVM build) shows its
///   log in that window on purpose, and a cabinet owner debugging a ROM path
///   needs to see it;
/// - a `.bat`/`.cmd` front end — a very common cabinet launcher — runs under
///   `cmd.exe`, a console app. Hidden, a prompt or an error in it becomes a
///   game that "does nothing" with no window to read.
///
/// The tray-flash argument does not apply: a game is *supposed* to put
/// something on screen. So the flag is omitted, and the omission is stated
/// rather than left to be re-derived.
pub fn launch(
    exe: &Path,
    args: &[String],
    working_dir: Option<&Path>,
) -> Result<GameProcess, LaunchError> {
    if !exe.is_file() {
        return Err(LaunchError::NotFound(exe.display().to_string()));
    }
    // NO_WINDOW_EXEMPT: this is the user's game, not ksx's plumbing — see above.
    let mut command = std::process::Command::new(exe);
    command.args(args);
    match working_dir.or_else(|| exe.parent()) {
        Some(dir) if !dir.as_os_str().is_empty() => {
            command.current_dir(dir);
        }
        _ => {}
    }
    let child = command.spawn().map_err(|source| LaunchError::Spawn {
        path: exe.display().to_string(),
        source,
    })?;
    let pid = child.id();
    Ok(GameProcess {
        child,
        pid,
        exit_code: None,
    })
}

impl GameProcess {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Exit code, once known. `None` while the process is still running.
    pub fn exit_code(&self) -> Option<i32> {
        self.exit_code
    }

    /// Is the process still running? Non-blocking, and it reaps on the way past
    /// so no zombie is left behind.
    ///
    /// A failure to ask (the handle is gone, the OS said no) is reported as
    /// **not alive**: an unanswerable question about a process we started can
    /// only be resolved by giving up on it, and the alternative — treating it
    /// as alive forever — would hang the session on a cabinet nobody is
    /// watching.
    pub fn is_alive(&mut self) -> bool {
        if self.exit_code.is_some() {
            return false;
        }
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                self.exit_code = Some(status.code().unwrap_or(-1));
                false
            }
            Err(err) => {
                tracing::warn!(pid = self.pid, %err, "cannot poll the launched game; treating it as exited");
                self.exit_code = Some(-1);
                false
            }
        }
    }

    /// Block for at most `timeout`, then report whether the process exited.
    ///
    /// On Windows this is a real `WaitForSingleObject` on the process handle —
    /// no polling loop, so a game that exits 3 ms into a 60 s wait is noticed in
    /// 3 ms. Elsewhere it degrades to a bounded poll.
    pub fn wait_timeout(&mut self, timeout: Duration) -> bool {
        if self.exit_code.is_some() {
            return true;
        }
        self.wait_for_signal(timeout);
        !self.is_alive()
    }

    #[cfg(windows)]
    fn wait_for_signal(&self, timeout: Duration) {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        let handle = self.child.as_raw_handle() as HANDLE;
        // SAFETY: `handle` is the live process handle owned by `self.child`,
        // which outlives this call; WaitForSingleObject only reads it.
        unsafe { WaitForSingleObject(handle, ms) };
    }

    #[cfg(not(windows))]
    fn wait_for_signal(&self, timeout: Duration) {
        // No handle-wait primitive in std; the policy layer polls anyway and
        // this path exists only so the tests build off Windows.
        std::thread::sleep(timeout.min(Duration::from_millis(50)));
    }
}

/// Why a shell activation could not be performed.
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("ShellExecute failed for '{target}' (code {code}): {hint}")]
    Failed {
        target: String,
        code: isize,
        hint: &'static str,
    },
    #[error("shell activation is Windows-only; cannot open '{0}'")]
    Unsupported(String),
}

/// `ShellExecuteW("open", target)`, the Windows mechanism for starting a
/// `steam://rungameid/NNN` target.
///
/// Returns as soon as the shell has *accepted* the request. For a protocol URL
/// that is essentially immediate and there is no process to wait on, which is
/// exactly why a profile that uses one must also name its `process_name`.
#[cfg(windows)]
pub fn shell_open(target: &str) -> Result<(), ShellError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both strings are NUL-terminated and outlive the call; a null HWND
    // and null parameter/directory pointers are the documented "no parent
    // window, no extra arguments" form.
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if rc > 32 {
        return Ok(());
    }
    Err(ShellError::Failed {
        target: target.to_owned(),
        code: rc,
        hint: shell_hint(rc),
    })
}

#[cfg(not(windows))]
pub fn shell_open(target: &str) -> Result<(), ShellError> {
    Err(ShellError::Unsupported(target.to_owned()))
}

/// The handful of `ShellExecute` failure codes worth spelling out — everything
/// else gets the generic line. Pure, so it is tested off Windows too.
pub fn shell_hint(code: isize) -> &'static str {
    match code {
        2 => "the file was not found",
        3 => "the path was not found",
        5 => "access denied",
        8 => "not enough memory",
        31 => {
            "no application is registered for this file type or URL scheme \
               (is Steam installed and has it registered steam://?)"
        }
        _ => "see ShellExecute's documented return values",
    }
}

/// Open a folder in Explorer. Used by the daemon's "Open config folder".
pub fn open_folder(path: &Path) -> Result<(), ShellError> {
    shell_open(&path.display().to_string())
}

/// Exit status of a helper launched through the Windows elevation broker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElevatedExit {
    pub code: u32,
}

/// One elevated process launched from an already-validated protected image.
///
/// The process handle, not the pid, is the identity. The pid is correlation
/// input only; it must never be treated as endpoint provenance or used by
/// itself to reopen or control the process. Likewise the handle-derived
/// canonical image is retained as launch evidence rather than rediscovered
/// through `PATH`, the current directory, or environment variables.
///
/// Dropping this value closes ksx's process and file-seal handles and performs
/// no process action. In particular there is intentionally no kill/terminate
/// operation and no raw handle escape: an elevated helper may be in the middle
/// of a durable driver transaction when its unelevated parent gives up waiting.
pub struct ElevatedChild {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    pid: u32,
    canonical_image: PathBuf,
    creation_time: u64,
    session_id: u32,
    /// Keeps the launched image's no-write/no-delete file seal alive for this
    /// value's whole lifetime, including the IPC conversation after launch.
    _image_seal: ProtectedExecutable,
    /// Cached after the handle is signalled, so repeated waits are stable and
    /// never ask the OS about a different process with a recycled pid.
    exit_code: Option<u32>,
}

impl std::fmt::Debug for ElevatedChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ElevatedChild")
            .field("pid", &self.pid)
            .field("canonical_image", &self.canonical_image)
            .field("creation_time", &self.creation_time)
            .field("session_id", &self.session_id)
            .field("exit_code", &self.exit_code)
            .finish_non_exhaustive()
    }
}

/// Crate-private evidence that a numeric candidate names the exact elevated
/// process object retained by [`ElevatedChild`].
///
/// The exact-object guarantee is intentionally not a caller-provided boolean:
/// a value of this type can be produced only while the retained ShellExecute
/// process handle remains alive and reports the same candidate pid. This does
/// **not** prove that a connected endpoint supplied that number. S1.6b must
/// combine the OS pipe-client query and this correlation behind one
/// non-bypassable transport API. Image, creation time, session, and token
/// elevation are captured from the retained object rather than from a
/// cross-account pid reopen.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct ElevatedProcessEvidence {
    pid: u32,
    session_id: u32,
    creation_time: u64,
    canonical_image: PathBuf,
    elevated: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ElevatedProcessEvidence {
    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) fn session_id(&self) -> u32 {
        self.session_id
    }

    pub(crate) fn creation_time(&self) -> u64 {
        self.creation_time
    }

    pub(crate) fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }

    /// Authoritative `TokenElevation` result from the retained process object.
    pub(crate) fn elevated(&self) -> bool {
        self.elevated
    }
}

#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum ElevatedProcessCorrelationError {
    #[error("the elevated child exited with code {code} during process correlation")]
    ChildExited { code: u32 },
    #[error("could not inspect the elevated child during process correlation: {0}")]
    ChildInspection(#[source] ElevationError),
    #[error("could not inspect the retained elevated process for candidate pid {pid}: {source}")]
    ProcessInspection {
        pid: u32,
        #[source]
        source: std::io::Error,
    },
    #[error("candidate pid {pid} is not the retained elevated process object")]
    DifferentProcess { pid: u32 },
    #[error("candidate pid {pid} is in non-interactive session zero")]
    NonInteractiveSession { pid: u32 },
    #[error("candidate pid {pid} changed its {field} identity evidence")]
    EvidenceMismatch { pid: u32, field: &'static str },
    #[error("candidate pid {pid} is the expected process object but its token is not elevated")]
    NotElevated { pid: u32 },
}

/// Exact SDK-free executable used only by the S1.6b transport integration
/// feature. It is deliberately not a production HIDMaestro host allowlist.
#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
const HIDMAESTRO_FAKE_HOST_NAME: &str = "ksx-hidmaestro-fake-host.exe";

/// Retained ordinary child for the SDK-free S1.6b fake.
///
/// Construction is available only with the integration-test feature and
/// resolves one fixed sibling of the running test executable. The child must
/// inherit the parent's measured elevation state and exact session (including
/// session zero on hosted CI); those facts are checked only after the pipe's
/// kernel client PID is available, so no post-spawn validation error can lose
/// the retained child. There is no caller-selected path, raw handle, kill
/// operation, or production conversion from this type to [`ElevatedChild`].
#[cfg(feature = "hidmaestro-fake-host-tests")]
pub struct FakeHostChild {
    #[cfg(windows)]
    child: std::process::Child,
    pid: u32,
    canonical_image: PathBuf,
    expected_session_id: u32,
    expected_elevated: bool,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
impl std::fmt::Debug for FakeHostChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeHostChild")
            .field("pid", &self.pid)
            .field("canonical_image", &self.canonical_image)
            .field("expected_session_id", &self.expected_session_id)
            .field("expected_elevated", &self.expected_elevated)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, thiserror::Error)]
pub enum FakeHostLaunchError {
    #[error("could not resolve the running transport-test executable: {0}")]
    CurrentExecutable(#[source] std::io::Error),
    #[error("the fixed SDK-free HIDMaestro fake host is missing")]
    Missing,
    #[error("the transport fake could not determine the parent process privilege")]
    ParentPrivilegeUnknown,
    #[error("the transport fake could not determine the parent process session: {0}")]
    ParentInspection(#[source] std::io::Error),
    #[error("could not start the fixed SDK-free HIDMaestro fake host: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("could not resolve the fixed SDK-free HIDMaestro fake host: {0}")]
    Resolve(#[source] std::io::Error),
    #[error("the SDK-free fake host is supported only on Windows")]
    Unsupported,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct FakeHostProcessEvidence {
    pid: u32,
    session_id: u32,
    canonical_image: PathBuf,
    elevated: bool,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[cfg_attr(not(windows), allow(dead_code))]
impl FakeHostProcessEvidence {
    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) fn session_id(&self) -> u32 {
        self.session_id
    }

    pub(crate) fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }

    pub(crate) fn elevated(&self) -> bool {
        self.elevated
    }
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, thiserror::Error)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) enum FakeHostCorrelationError {
    #[error("the SDK-free fake child exited with code {code} during process correlation")]
    ChildExited { code: u32 },
    #[error("could not inspect the retained SDK-free fake child: {0}")]
    ProcessInspection(#[source] std::io::Error),
    #[error("candidate pid {pid} is not the retained SDK-free fake child")]
    DifferentProcess { pid: u32 },
    #[error("candidate pid {pid} changed its {field} identity evidence")]
    EvidenceMismatch { pid: u32, field: &'static str },
    #[error("candidate pid {pid} changed its inherited privilege state")]
    PrivilegeMismatch { pid: u32 },
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
enum FakeInheritanceMismatch {
    Session,
    Privilege,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn validate_fake_child_inheritance(
    parent_session: u32,
    parent_elevated: bool,
    child_session: u32,
    child_elevated: bool,
) -> Result<(), FakeInheritanceMismatch> {
    if child_session != parent_session {
        return Err(FakeInheritanceMismatch::Session);
    }
    if child_elevated != parent_elevated {
        return Err(FakeInheritanceMismatch::Privilege);
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum ElevationError {
    #[error("the elevated executable must be an existing absolute canonical file: {0}")]
    InvalidExecutable(String),
    #[error("elevated argument {index} contains a NUL character")]
    InvalidArgument { index: usize },
    #[error("the Windows administrator prompt was cancelled")]
    Cancelled,
    #[error("could not launch the elevated helper: {0}")]
    Launch(#[source] std::io::Error),
    #[error("the elevated helper launched but its identity could not be established; it was left running: {0}")]
    Untracked(#[source] std::io::Error),
    #[error("could not wait for the elevated helper; it may still be running and must not be relaunched until state is re-surveyed: {0}")]
    Wait(#[source] std::io::Error),
    #[error("the elevated helper did not finish within five minutes; it was left running and its durable recovery record must be inspected")]
    Timeout,
    #[error("elevation is supported only on Windows")]
    Unsupported,
}

/// Quote one argument using the `CommandLineToArgvW`/CRT backslash rules.
/// ShellExecuteEx receives one parameter string, not an argv array.
fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return argument.to_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for ch in argument.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            out.push('"');
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
            out.push(ch);
        }
        slashes = 0;
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

/// ShellExecuteEx flags required to synchronously receive and retain the child
/// handle.  `NOASYNC` applies only to shell hand-off; [`launch_elevated`]
/// itself still returns as soon as that handle is available.
#[cfg(windows)]
const ELEVATED_EXECUTE_MASK: u32 = windows_sys::Win32::UI::Shell::SEE_MASK_NOCLOSEPROCESS
    | windows_sys::Win32::UI::Shell::SEE_MASK_NOASYNC;

/// `INFINITE` is `u32::MAX`; clamping one below it keeps every public wait
/// genuinely bounded even when a caller supplies a centuries-long Duration.
const MAX_BOUNDED_WAIT_MS: u32 = u32::MAX - 1;

fn bounded_wait_millis(timeout: Duration) -> u32 {
    timeout.as_millis().min(u128::from(MAX_BOUNDED_WAIT_MS)) as u32
}

fn elevation_parameter_line(args: &[String]) -> Result<String, ElevationError> {
    args.iter()
        .enumerate()
        .map(|(index, argument)| {
            if argument.contains('\0') {
                Err(ElevationError::InvalidArgument { index })
            } else {
                Ok(quote_windows_argument(argument))
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|quoted| quoted.join(" "))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessWait {
    Exited,
    TimedOut,
}

/// Interpret one process wait through injected OS operations.  Keeping this
/// state machine pure is what lets tests pin timeout/caching/error behavior
/// without launching anything or displaying a UAC prompt.
fn observe_elevated_exit(
    cached: &mut Option<u32>,
    wait: impl FnOnce() -> std::io::Result<ProcessWait>,
    read_exit: impl FnOnce() -> std::io::Result<u32>,
) -> std::io::Result<Option<u32>> {
    if let Some(code) = *cached {
        return Ok(Some(code));
    }
    if wait()? == ProcessWait::TimedOut {
        return Ok(None);
    }
    let code = read_exit()?;
    *cached = Some(code);
    Ok(Some(code))
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug)]
struct ObservedProcess {
    pid: u32,
    session_id: u32,
    creation_time: u64,
    canonical_image: PathBuf,
    retained_object: bool,
    elevated: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn validate_process_observation(
    expected_pid: u32,
    expected_session_id: u32,
    expected_creation_time: u64,
    expected_image: &Path,
    observed: ObservedProcess,
) -> Result<ElevatedProcessEvidence, ElevatedProcessCorrelationError> {
    if !observed.retained_object || observed.pid != expected_pid {
        return Err(ElevatedProcessCorrelationError::DifferentProcess { pid: observed.pid });
    }
    if observed.session_id == 0 {
        return Err(ElevatedProcessCorrelationError::NonInteractiveSession { pid: observed.pid });
    }
    if observed.session_id != expected_session_id {
        return Err(ElevatedProcessCorrelationError::EvidenceMismatch {
            pid: observed.pid,
            field: "interactive session",
        });
    }
    if observed.creation_time != expected_creation_time {
        return Err(ElevatedProcessCorrelationError::EvidenceMismatch {
            pid: observed.pid,
            field: "creation time",
        });
    }
    if !executable_path_eq(&observed.canonical_image, expected_image) {
        return Err(ElevatedProcessCorrelationError::EvidenceMismatch {
            pid: observed.pid,
            field: "canonical image",
        });
    }
    if !observed.elevated {
        return Err(ElevatedProcessCorrelationError::NotElevated { pid: observed.pid });
    }
    Ok(ElevatedProcessEvidence {
        pid: observed.pid,
        session_id: observed.session_id,
        creation_time: observed.creation_time,
        canonical_image: expected_image.to_path_buf(),
        elevated: true,
    })
}

#[cfg(windows)]
fn process_creation_time(handle: windows_sys::Win32::Foundation::HANDLE) -> std::io::Result<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: all out-pointers are valid FILETIMEs and `handle` is borrowed by
    // the caller for this call's duration.
    if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

#[cfg(windows)]
fn process_image(handle: windows_sys::Win32::Foundation::HANDLE) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

    // The extended-length Windows path ceiling is 32,767 UTF-16 code units.
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` is writable for `length` UTF-16 units and `handle` is a
    // live process handle with query rights.
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}

#[cfg(windows)]
fn process_session_id(pid: u32) -> std::io::Result<u32> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ProcessIdToSessionId(process_id: u32, session_id: *mut u32) -> i32;
    }

    let mut session_id = 0u32;
    // SAFETY: `session_id` is a valid writable u32 and the function only reads
    // the numeric pid.  A zero return is handled as an OS error.
    if unsafe { ProcessIdToSessionId(pid, &mut session_id) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(session_id)
    }
}

#[cfg(windows)]
fn process_token_is_elevated(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> std::io::Result<bool> {
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    let mut raw_token: HANDLE = std::ptr::null_mut();
    // SAFETY: `raw_token` is a valid out-pointer. The exact process handle is
    // borrowed by the caller; only TOKEN_QUERY is requested.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned one owned token handle.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token.cast()) };
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: `elevation` has the exact TokenElevation layout and the owned
    // token handle remains live for this call.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    if returned < std::mem::size_of::<TOKEN_ELEVATION>() as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "TokenElevation returned a truncated result",
        ));
    }
    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(windows)]
pub(crate) fn retained_process_exit_code(
    handle: windows_sys::Win32::Foundation::HANDLE,
    timeout: Duration,
) -> std::io::Result<Option<u32>> {
    use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};

    // SAFETY: the caller retains ownership of `handle` for this bounded wait.
    match unsafe { WaitForSingleObject(handle, bounded_wait_millis(timeout)) } {
        WAIT_TIMEOUT => Ok(None),
        WAIT_OBJECT_0 => {
            let mut code = 0u32;
            // SAFETY: a signalled retained process handle remains valid until
            // its owner drops it; `code` is a writable result slot.
            if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(Some(code))
            }
        }
        WAIT_FAILED => Err(std::io::Error::last_os_error()),
        other => Err(std::io::Error::other(format!(
            "WaitForSingleObject returned unexpected status {other:#x}"
        ))),
    }
}

/// Launch the one fixed, SDK-free HIDMaestro transport fake.
///
/// This symbol does not exist unless the explicit integration-test feature is
/// enabled. The path is resolved from `current_exe` internally and the array
/// width prevents adding an open-ended test command surface.
#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
pub fn launch_hidmaestro_fake_host(
    args: &[String; 3],
) -> Result<FakeHostChild, FakeHostLaunchError> {
    use std::process::Stdio;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    let parent_elevated = is_elevated().ok_or(FakeHostLaunchError::ParentPrivilegeUnknown)?;
    // SAFETY: GetCurrentProcessId has no arguments or failure state.
    let parent_pid = unsafe { GetCurrentProcessId() };
    let parent_session =
        process_session_id(parent_pid).map_err(FakeHostLaunchError::ParentInspection)?;

    let current = std::env::current_exe().map_err(FakeHostLaunchError::CurrentExecutable)?;
    let current = std::fs::canonicalize(current).map_err(FakeHostLaunchError::CurrentExecutable)?;
    let parent = current.parent().ok_or(FakeHostLaunchError::Missing)?;
    let requested = parent.join(HIDMAESTRO_FAKE_HOST_NAME);
    let canonical = match std::fs::canonicalize(&requested) {
        Ok(path) if path.is_file() => path,
        Ok(_) => return Err(FakeHostLaunchError::Missing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(FakeHostLaunchError::Missing)
        }
        Err(error) => return Err(FakeHostLaunchError::Resolve(error)),
    };
    let actual_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !actual_name.eq_ignore_ascii_case(HIDMAESTRO_FAKE_HOST_NAME) {
        return Err(FakeHostLaunchError::Missing);
    }

    let mut command = std::process::Command::new(&canonical);
    command
        .args(args)
        .current_dir(parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut command);
    let child = command.spawn().map_err(FakeHostLaunchError::Spawn)?;
    let pid = child.id();

    Ok(FakeHostChild {
        child,
        pid,
        canonical_image: canonical,
        expected_session_id: parent_session,
        expected_elevated: parent_elevated,
    })
}

#[cfg(all(not(windows), feature = "hidmaestro-fake-host-tests"))]
pub fn launch_hidmaestro_fake_host(
    _args: &[String; 3],
) -> Result<FakeHostChild, FakeHostLaunchError> {
    Err(FakeHostLaunchError::Unsupported)
}

#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
impl FakeHostChild {
    pub(crate) fn retained_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        use std::os::windows::io::AsRawHandle as _;

        self.child.as_raw_handle().cast()
    }

    pub(crate) fn correlate_fake_process_pid(
        &self,
        candidate_pid: u32,
    ) -> Result<FakeHostProcessEvidence, FakeHostCorrelationError> {
        use windows_sys::Win32::System::Threading::GetProcessId;

        let handle = self.retained_handle();
        if let Some(code) = retained_process_exit_code(handle, Duration::ZERO)
            .map_err(FakeHostCorrelationError::ProcessInspection)?
        {
            return Err(FakeHostCorrelationError::ChildExited { code });
        }
        // SAFETY: `handle` is owned by this live FakeHostChild.
        let retained_pid = unsafe { GetProcessId(handle) };
        if candidate_pid != self.pid || retained_pid != self.pid {
            return Err(FakeHostCorrelationError::DifferentProcess { pid: candidate_pid });
        }

        let session_id = process_session_id(retained_pid)
            .map_err(FakeHostCorrelationError::ProcessInspection)?;
        let observed_image =
            process_image(handle).map_err(FakeHostCorrelationError::ProcessInspection)?;
        if !executable_path_eq(&observed_image, &self.canonical_image) {
            return Err(FakeHostCorrelationError::EvidenceMismatch {
                pid: candidate_pid,
                field: "canonical image",
            });
        }
        let elevated = process_token_is_elevated(handle)
            .map_err(FakeHostCorrelationError::ProcessInspection)?;
        match validate_fake_child_inheritance(
            self.expected_session_id,
            self.expected_elevated,
            session_id,
            elevated,
        ) {
            Ok(()) => {}
            Err(FakeInheritanceMismatch::Session) => {
                return Err(FakeHostCorrelationError::EvidenceMismatch {
                    pid: candidate_pid,
                    field: "inherited session",
                })
            }
            Err(FakeInheritanceMismatch::Privilege) => {
                return Err(FakeHostCorrelationError::PrivilegeMismatch { pid: candidate_pid })
            }
        }
        if let Some(code) = retained_process_exit_code(handle, Duration::ZERO)
            .map_err(FakeHostCorrelationError::ProcessInspection)?
        {
            return Err(FakeHostCorrelationError::ChildExited { code });
        }

        Ok(FakeHostProcessEvidence {
            pid: candidate_pid,
            session_id,
            canonical_image: self.canonical_image.clone(),
            elevated,
        })
    }
}

impl ElevatedChild {
    #[cfg(windows)]
    pub(crate) fn retained_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        use std::os::windows::io::AsRawHandle as _;

        self.handle.as_raw_handle().cast()
    }

    /// Process id captured from the retained process handle at launch time.
    /// It is correlation evidence only; the handle remains the identity.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Exact canonical image supplied by the protected-install caller.
    pub fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }

    /// Exit code once a wait or liveness check has observed process exit.
    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code
    }

    /// Wait for at most `timeout`.  `Ok(None)` means the child was still
    /// running at the deadline; `Ok(Some(code))` is cached forever.
    #[cfg(windows)]
    pub fn wait_timeout(&mut self, timeout: Duration) -> Result<Option<u32>, ElevationError> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::{HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};

        let handle = self.handle.as_raw_handle() as HANDLE;
        observe_elevated_exit(
            &mut self.exit_code,
            || {
                // SAFETY: `handle` is owned by `self` and cannot be closed or
                // escaped while this borrow is live.
                let status = unsafe { WaitForSingleObject(handle, bounded_wait_millis(timeout)) };
                match status {
                    WAIT_OBJECT_0 => Ok(ProcessWait::Exited),
                    WAIT_TIMEOUT => Ok(ProcessWait::TimedOut),
                    WAIT_FAILED => Err(std::io::Error::last_os_error()),
                    other => Err(std::io::Error::other(format!(
                        "WaitForSingleObject returned unexpected status {other:#x}"
                    ))),
                }
            },
            || {
                let mut code = 0u32;
                // SAFETY: the same owned process handle remains live.  This is
                // called only after it was observed signalled.
                if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(code)
                }
            },
        )
        .map_err(ElevationError::Wait)
    }

    #[cfg(not(windows))]
    pub fn wait_timeout(&mut self, _timeout: Duration) -> Result<Option<u32>, ElevationError> {
        Err(ElevationError::Unsupported)
    }

    /// Non-blocking liveness check against the retained handle.
    pub fn is_alive(&mut self) -> Result<bool, ElevationError> {
        self.wait_timeout(Duration::ZERO).map(|exit| exit.is_none())
    }

    /// Correlate a numeric candidate with this exact elevated process object.
    ///
    /// A matching number by itself is not endpoint authentication. This
    /// brackets the check with
    /// liveness observations on the retained process handle, re-reads that
    /// handle's pid, and queries creation time, image, interactive SessionId,
    /// and `TokenElevation` from the same retained object. A pid cannot be
    /// recycled to another live object while the original retained child stays
    /// alive; if it exits during evidence collection, the trailing liveness
    /// check rejects the peer.
    ///
    /// User or logon SID equality is deliberately *not* required —
    /// over-the-shoulder UAC legitimately runs under another administrator's
    /// identity in the same interactive session. Query failure still fails
    /// closed, and standard-user/over-the-shoulder behavior remains a native
    /// release gate for this source-only checkpoint. This method is
    /// crate-private so only a future combined live-pipe authenticator can turn
    /// OS-reported client identity into transport trust.
    #[cfg(windows)]
    pub(crate) fn correlate_process_pid(
        &mut self,
        candidate_pid: u32,
    ) -> Result<ElevatedProcessEvidence, ElevatedProcessCorrelationError> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::Threading::GetProcessId;

        if let Some(code) = self
            .wait_timeout(Duration::ZERO)
            .map_err(ElevatedProcessCorrelationError::ChildInspection)?
        {
            return Err(ElevatedProcessCorrelationError::ChildExited { code });
        }
        let child_handle = self.handle.as_raw_handle() as HANDLE;
        // SAFETY: `child_handle` is the retained live process object bracketed
        // by the liveness checks in this method.
        let retained_pid = unsafe { GetProcessId(child_handle) };
        if retained_pid == 0 {
            return Err(ElevatedProcessCorrelationError::ProcessInspection {
                pid: candidate_pid,
                source: std::io::Error::last_os_error(),
            });
        }
        if candidate_pid != self.pid || retained_pid != self.pid {
            return Err(ElevatedProcessCorrelationError::DifferentProcess { pid: candidate_pid });
        }
        let observed = ObservedProcess {
            pid: candidate_pid,
            session_id: process_session_id(retained_pid).map_err(|source| {
                ElevatedProcessCorrelationError::ProcessInspection {
                    pid: candidate_pid,
                    source,
                }
            })?,
            creation_time: process_creation_time(child_handle).map_err(|source| {
                ElevatedProcessCorrelationError::ProcessInspection {
                    pid: candidate_pid,
                    source,
                }
            })?,
            canonical_image: process_image(child_handle).map_err(|source| {
                ElevatedProcessCorrelationError::ProcessInspection {
                    pid: candidate_pid,
                    source,
                }
            })?,
            retained_object: true,
            elevated: process_token_is_elevated(child_handle).map_err(|source| {
                ElevatedProcessCorrelationError::ProcessInspection {
                    pid: candidate_pid,
                    source,
                }
            })?,
        };
        let evidence = validate_process_observation(
            self.pid,
            self.session_id,
            self.creation_time,
            &self.canonical_image,
            observed,
        )?;

        // Pin the PID-correlating window at both ends: a peer that exited while
        // its evidence was being collected is not an authenticated live peer.
        match self
            .wait_timeout(Duration::ZERO)
            .map_err(ElevatedProcessCorrelationError::ChildInspection)?
        {
            Some(code) => Err(ElevatedProcessCorrelationError::ChildExited { code }),
            None => Ok(evidence),
        }
    }

    #[cfg(not(windows))]
    #[allow(dead_code)]
    pub(crate) fn correlate_process_pid(
        &mut self,
        _candidate_pid: u32,
    ) -> Result<ElevatedProcessEvidence, ElevatedProcessCorrelationError> {
        Err(ElevatedProcessCorrelationError::ChildInspection(
            ElevationError::Unsupported,
        ))
    }
}

/// Launch an exact, already-canonical protected executable with the `runas`
/// verb and return as soon as Windows provides its process handle.
///
/// The caller must first obtain `executable` from the fixed protected-image
/// factory. On success the opaque token is consumed and retained by the child,
/// so its sealed file object cannot be
/// swapped for the lifetime of the process/IPC conversation. This function
/// performs no executable discovery: `PATH`, the process CWD, and
/// environment-variable expansion are unused. The working directory is fixed
/// to the handle-derived image parent.
#[cfg(windows)]
pub fn launch_elevated(
    executable: ProtectedExecutable,
    args: &[String],
) -> Result<ElevatedChild, ElevationError> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetProcessId};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let canonical = executable.canonical_image.clone();
    if canonical.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(ElevationError::InvalidExecutable(
            canonical.display().to_string(),
        ));
    }
    let directory = canonical
        .parent()
        .ok_or_else(|| ElevationError::InvalidExecutable(canonical.display().to_string()))?;
    let parameter_line = elevation_parameter_line(args)?;
    let file: Vec<u16> = canonical
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let parameters: Vec<u16> = parameter_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let directory: Vec<u16> = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: ELEVATED_EXECUTE_MASK,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    // SAFETY: all strings are NUL-terminated and live through the call.  Under
    // NOCLOSEPROCESS a successful call transfers one owned handle to `info`.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let code = unsafe { GetLastError() };
        if code == ERROR_CANCELLED {
            return Err(ElevationError::Cancelled);
        }
        return Err(ElevationError::Launch(std::io::Error::from_raw_os_error(
            code as i32,
        )));
    }
    if info.hProcess.is_null() {
        return Err(ElevationError::Untracked(std::io::Error::other(
            "ShellExecuteExW returned no process handle",
        )));
    }
    // SAFETY: NOCLOSEPROCESS gives this call one owned process handle.  It is
    // stored privately and its only escape is OwnedHandle's close-on-drop.
    let handle = unsafe { OwnedHandle::from_raw_handle(info.hProcess.cast()) };
    // SAFETY: `handle` owns the live process handle for this call.
    let pid = unsafe { GetProcessId(info.hProcess) };
    if pid == 0 {
        return Err(ElevationError::Untracked(std::io::Error::last_os_error()));
    }
    let creation_time = process_creation_time(info.hProcess).map_err(ElevationError::Untracked)?;
    let observed_image = process_image(info.hProcess).map_err(ElevationError::Untracked)?;
    if !executable_path_eq(&observed_image, &canonical) {
        return Err(ElevationError::Untracked(std::io::Error::other(format!(
            "ShellExecuteEx launched '{}' instead of the sealed image '{}'",
            observed_image.display(),
            canonical.display()
        ))));
    }
    let session_id = process_session_id(pid).map_err(ElevationError::Untracked)?;
    // SAFETY: GetCurrentProcessId takes no arguments and has no failure mode.
    let caller_pid = unsafe { GetCurrentProcessId() };
    let caller_session = process_session_id(caller_pid).map_err(ElevationError::Untracked)?;
    if session_id != caller_session {
        return Err(ElevationError::Untracked(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "elevated child entered session {session_id}, expected interactive session {caller_session}"
            ),
        )));
    }
    Ok(ElevatedChild {
        handle,
        pid,
        canonical_image: canonical,
        creation_time,
        session_id,
        _image_seal: executable,
        exit_code: None,
    })
}

#[cfg(not(windows))]
pub fn launch_elevated(
    _executable: ProtectedExecutable,
    _args: &[String],
) -> Result<ElevatedChild, ElevationError> {
    Err(ElevationError::Unsupported)
}

/// Launch an exact executable with the `runas` verb, wait for it, and return
/// only its exit code. The caller deliberately does not trust stdout: driver
/// state is re-surveyed after this function returns.
pub fn run_elevated_and_wait(
    executable: ProtectedExecutable,
    args: &[String],
) -> Result<ElevatedExit, ElevationError> {
    let mut child = launch_elevated(executable, args)?;
    match child.wait_timeout(Duration::from_millis(u64::from(ELEVATED_HELPER_WAIT_MS)))? {
        Some(code) => Ok(ElevatedExit { code }),
        None => {
            // Dropping `child` closes only our handle.  The helper may be in a
            // driver mutation, so leave it running and force re-survey/recovery
            // rather than starting a second copy.
            Err(ElevationError::Timeout)
        }
    }
}

/// Is this process running with an elevated token?
///
/// `None` means the question could not be answered (never assume "yes" — the
/// caller prints installation advice, and telling a non-admin user they are
/// admin wastes their time with a UAC-less failure).
#[cfg(windows)]
pub fn is_elevated() -> Option<bool> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: GetCurrentProcess returns a borrowed pseudo-handle valid for the
    // process lifetime; `process_token_is_elevated` does not close it.
    process_token_is_elevated(unsafe { GetCurrentProcess() }).ok()
}

#[cfg(not(windows))]
pub fn is_elevated() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn protected_sibling_policy_rejects_portable_and_acl_weakened_copies() {
        let policy = crate::installer::SearchPolicy::with_roots(
            Some(true),
            &[r"C:\Program Files", r"C:\Program Files (x86)"],
        );
        let mut checked = Vec::new();
        validate_canonical_install_sibling_with(
            Path::new(r"C:\Program Files\KSX\ksx.exe"),
            Path::new(r"C:\Program Files\KSX\ksx-winusb-helper.exe"),
            &policy,
            |path| {
                checked.push(path.to_path_buf());
                Ok(())
            },
        )
        .expect("canonical protected siblings with strong ACLs");
        assert_eq!(
            checked.len(),
            4,
            "Program Files root, app directory, and both files are checked"
        );

        let portable = validate_canonical_install_sibling_with(
            Path::new(r"C:\Users\TestUser\Downloads\ksx.exe"),
            Path::new(r"C:\Users\TestUser\Downloads\ksx-winusb-helper.exe"),
            &policy,
            |_| panic!("ACL inspection must not bless an unprotected root"),
        );
        assert!(matches!(
            portable,
            Err(ProtectedInstallError::OutsideProgramFiles)
        ));

        let weakened = validate_canonical_install_sibling_with(
            Path::new(r"C:\Program Files\KSX\ksx.exe"),
            Path::new(r"C:\Program Files\KSX\ksx-winusb-helper.exe"),
            &policy,
            |path| {
                Err(ProtectedInstallError::UnsafeAcl(format!(
                    "{} grants Users write",
                    path.display()
                )))
            },
        );
        assert!(matches!(weakened, Err(ProtectedInstallError::UnsafeAcl(_))));
    }

    #[test]
    fn protected_executable_name_is_a_fixed_exe_basename() {
        let helper = Path::new("ksx-winusb-helper.exe");
        validate_protected_executable_name(helper, "KSX-WINUSB-HELPER.EXE")
            .expect("the fixed basename comparison is ASCII case-insensitive");

        for expected in [
            "other.exe",
            "subdir/ksx-winusb-helper.exe",
            "ksx-winusb-helper.dll",
        ] {
            assert!(matches!(
                validate_protected_executable_name(helper, expected),
                Err(ProtectedInstallError::UnexpectedExecutableName { .. })
            ));
        }
    }

    /// Only the fixed installed siblings may mint elevation tokens; no
    /// caller-selected basename or path crosses this API.
    #[test]
    fn only_fixed_product_helpers_can_mint_an_elevation_token() {
        let source = include_str!("process.rs").replace("\r\n", "\n");
        let fixed_public = ["pub fn ", "protected_winusb_helper()"].concat();
        let generic_public = ["pub fn ", "protected_executable_sibling("].concat();
        let managed_public = ["pub fn ", "protected_hidmaestro_host("].concat();
        let sdk_public = ["pub fn ", "protected_hidmaestro_sdk_host("].concat();
        let generic_private = ["fn ", "protected_executable_sibling("].concat();
        assert_eq!(
            source.matches(fixed_public.as_str()).count(),
            2,
            "one Windows implementation and one non-Windows refusal"
        );
        assert!(!source.contains(generic_public.as_str()));
        assert_eq!(
            source.matches(managed_public.as_str()).count(),
            2,
            "one Windows implementation and one non-Windows refusal"
        );
        assert_eq!(
            source.matches(sdk_public.as_str()).count(),
            2,
            "one Windows implementation and one non-Windows refusal"
        );
        assert_eq!(source.matches(generic_private.as_str()).count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn temporary_store_initializer_has_a_fixed_name_and_checks_parent_and_file() {
        let parent = Path::new(r"C:\Windows\Temp\is-ABC.tmp");
        let executable = parent.join("ksx-winusb-helper.exe");
        let mut checked = Vec::new();
        validate_canonical_store_initializer_with(&executable, parent, |path| {
            checked.push(path.to_path_buf());
            Ok(())
        })
        .expect("fixed helper in a protected temporary parent");
        assert_eq!(checked, vec![parent.to_path_buf(), executable]);

        let renamed = parent.join("initializer-copy.exe");
        assert!(matches!(
            validate_canonical_store_initializer_with(&renamed, parent, |_| Ok(())),
            Err(ProtectedInstallError::UnexpectedInitializerName)
        ));

        let weakened = validate_canonical_store_initializer_with(
            &parent.join("ksx-winusb-helper.exe"),
            parent,
            |path| {
                Err(ProtectedInstallError::UnsafeAcl(format!(
                    "{} grants Users write",
                    path.display()
                )))
            },
        );
        assert!(matches!(weakened, Err(ProtectedInstallError::UnsafeAcl(_))));
    }

    #[cfg(windows)]
    #[test]
    fn normal_program_files_inherit_only_creator_owner_ace_is_safe() {
        use windows_sys::Win32::Foundation::{GENERIC_ALL, GENERIC_WRITE};
        use windows_sys::Win32::Security::INHERIT_ONLY_ACE;

        let dangerous = GENERIC_ALL | GENERIC_WRITE;
        // Mirrors the relevant normal ACL rows: SYSTEM/Admin full control,
        // Users read/execute, and CREATOR OWNER inherit-only full control.
        let fixture = [
            (0, GENERIC_ALL, true),
            (0, GENERIC_ALL, true),
            (0, 0x0012_00a9, false),
            (INHERIT_ONLY_ACE as u8, GENERIC_ALL, false),
        ];
        assert!(fixture.iter().all(|(flags, mask, trusted)| {
            !allowed_ace_mutates_current_object(
                *flags,
                *mask,
                dangerous,
                *trusted,
                INHERIT_ONLY_ACE as u8,
            )
        }));
        assert!(allowed_ace_mutates_current_object(
            0,
            GENERIC_WRITE,
            dangerous,
            false,
            INHERIT_ONLY_ACE as u8,
        ));
    }

    #[test]
    fn name_matching_ignores_case() {
        let entry = ProcessEntry {
            pid: 1,
            parent_pid: 0,
            name: "MAME.exe".into(),
        };
        assert!(entry.name_matches("mame.exe"));
        assert!(entry.name_matches("MAME.EXE"));
        assert!(!entry.name_matches("mame"));
    }

    #[test]
    fn elevated_helper_wait_is_bounded_without_a_kill_path() {
        assert_eq!(ELEVATED_HELPER_WAIT_MS, 300_000);
        assert_eq!(bounded_wait_millis(Duration::ZERO), 0);
        assert_eq!(bounded_wait_millis(Duration::from_millis(37)), 37);
        assert_eq!(
            bounded_wait_millis(Duration::MAX),
            MAX_BOUNDED_WAIT_MS,
            "a huge Duration must never become Win32 INFINITE"
        );
        let source = include_str!("process.rs");
        let section = source
            .split("pub fn run_elevated_and_wait")
            .nth(1)
            .expect("elevation function");
        let section = section.split("/// Is this process running").next().unwrap();
        assert!(!section.contains("INFINITE"));
        assert!(!section.contains("TerminateProcess"));
    }

    /// Broken version caught: the original call asked only for a process
    /// handle. Without NOASYNC, ShellExecuteEx may return before its background
    /// shell work is complete, which makes immediate pid/pipe correlation race.
    #[cfg(windows)]
    #[test]
    fn elevated_launch_retains_the_process_handle_without_async_shell_handoff() {
        use windows_sys::Win32::UI::Shell::{SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS};

        assert_eq!(
            ELEVATED_EXECUTE_MASK,
            SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
        );
    }

    /// Broken version caught: joining unquoted arguments allowed spaces,
    /// embedded quotes and trailing backslashes to change the helper's argv.
    #[test]
    fn elevated_parameter_line_preserves_the_fixed_argv() {
        let args = vec![
            "plain".to_owned(),
            String::new(),
            "two words".to_owned(),
            "say \"hello\"".to_owned(),
            "C:\\Program Files\\KSX\\".to_owned(),
        ];
        assert_eq!(
            elevation_parameter_line(&args).unwrap(),
            "plain \"\" \"two words\" \"say \\\"hello\\\"\" \"C:\\Program Files\\KSX\\\\\""
        );

        let err = elevation_parameter_line(&["ok".to_owned(), "bad\0tail".to_owned()]).unwrap_err();
        assert!(matches!(err, ElevationError::InvalidArgument { index: 1 }));
    }

    /// Broken version caught: timeout was terminal state in the wrapper rather
    /// than an observation, and repeated polls could lose a known exit code.
    /// These injected operations display no UAC prompt and touch no process.
    #[test]
    fn elevated_wait_timeout_and_exit_cache_are_distinct_states() {
        let mut cached = None;
        let exit_reads = std::cell::Cell::new(0usize);
        let first = observe_elevated_exit(
            &mut cached,
            || Ok(ProcessWait::TimedOut),
            || {
                exit_reads.set(exit_reads.get() + 1);
                Ok(99)
            },
        )
        .unwrap();
        assert_eq!(first, None);
        assert_eq!(cached, None);
        assert_eq!(exit_reads.get(), 0, "timeout must not read an exit code");

        let second = observe_elevated_exit(
            &mut cached,
            || Ok(ProcessWait::Exited),
            || {
                exit_reads.set(exit_reads.get() + 1);
                Ok(37)
            },
        )
        .unwrap();
        assert_eq!(second, Some(37));
        assert_eq!(cached, Some(37));
        assert_eq!(exit_reads.get(), 1);

        let repeated = observe_elevated_exit(
            &mut cached,
            || panic!("a cached exit must not wait again"),
            || panic!("a cached exit must not be read again"),
        )
        .unwrap();
        assert_eq!(repeated, Some(37));
    }

    /// Broken version caught: a failed wait must not be converted to "still
    /// alive" or cache a made-up exit code.
    #[test]
    fn elevated_wait_errors_remain_errors() {
        let mut cached = None;
        let err = observe_elevated_exit(
            &mut cached,
            || Err(std::io::Error::other("wait failed")),
            || panic!("a failed wait cannot have an exit code"),
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(cached, None);

        let err = observe_elevated_exit(
            &mut cached,
            || Ok(ProcessWait::Exited),
            || Err(std::io::Error::other("exit read failed")),
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
        assert_eq!(cached, None);
    }

    /// Broken version caught: matching only the numeric pid allowed a reused
    /// or substituted process to pass. Exact kernel-object identity is
    /// mandatory even when every descriptive field happens to match.
    #[test]
    fn elevated_process_evidence_requires_retained_object_image_time_session_and_token() {
        let image = Path::new(r"C:\Program Files\KSX\ksx-winusb-helper.exe");
        let observation =
            |retained_object, session_id, creation_time, canonical_image: &Path, elevated| {
                ObservedProcess {
                    pid: 41,
                    session_id,
                    creation_time,
                    canonical_image: canonical_image.to_path_buf(),
                    retained_object,
                    elevated,
                }
            };

        let accepted = validate_process_observation(
            41,
            2,
            9001,
            image,
            observation(true, 2, 9001, image, true),
        )
        .unwrap();
        assert_eq!(accepted.pid(), 41);
        assert_eq!(accepted.session_id(), 2);
        assert_eq!(accepted.creation_time(), 9001);
        assert_eq!(accepted.canonical_image(), image);
        assert!(accepted.elevated());

        assert!(matches!(
            validate_process_observation(
                41,
                2,
                9001,
                image,
                observation(false, 2, 9001, image, true),
            ),
            Err(ElevatedProcessCorrelationError::DifferentProcess { .. })
        ));
        assert!(matches!(
            validate_process_observation(
                41,
                0,
                9001,
                image,
                observation(true, 0, 9001, image, true),
            ),
            Err(ElevatedProcessCorrelationError::NonInteractiveSession { pid: 41 })
        ));
        assert!(matches!(
            validate_process_observation(
                41,
                2,
                9001,
                image,
                observation(true, 3, 9001, image, true),
            ),
            Err(ElevatedProcessCorrelationError::EvidenceMismatch {
                field: "interactive session",
                ..
            })
        ));
        assert!(matches!(
            validate_process_observation(
                41,
                2,
                9001,
                image,
                observation(true, 2, 9002, image, true),
            ),
            Err(ElevatedProcessCorrelationError::EvidenceMismatch {
                field: "creation time",
                ..
            })
        ));
        assert!(matches!(
            validate_process_observation(
                41,
                2,
                9001,
                image,
                observation(true, 2, 9001, Path::new(r"C:\Windows\notepad.exe"), true,),
            ),
            Err(ElevatedProcessCorrelationError::EvidenceMismatch {
                field: "canonical image",
                ..
            })
        ));
        assert!(matches!(
            validate_process_observation(
                41,
                2,
                9001,
                image,
                observation(true, 2, 9001, image, false),
            ),
            Err(ElevatedProcessCorrelationError::NotElevated { pid: 41 })
        ));
    }

    #[cfg(feature = "hidmaestro-fake-host-tests")]
    #[test]
    fn fake_child_inherits_parent_session_and_privilege_even_in_session_zero() {
        assert!(validate_fake_child_inheritance(0, false, 0, false).is_ok());
        assert!(validate_fake_child_inheritance(0, true, 0, true).is_ok());
        assert!(matches!(
            validate_fake_child_inheritance(1, false, 2, false),
            Err(FakeInheritanceMismatch::Session)
        ));
        assert!(matches!(
            validate_fake_child_inheritance(1, false, 1, true),
            Err(FakeInheritanceMismatch::Privilege)
        ));
    }

    #[cfg(feature = "hidmaestro-fake-host-tests")]
    #[test]
    fn fake_launch_has_no_fallible_post_spawn_identity_edge() {
        let source = include_str!("process.rs").replace("\r\n", "\n");
        let launch = source
            .split("pub fn launch_hidmaestro_fake_host(")
            .nth(1)
            .expect("Windows fixed fake launcher")
            .split("#[cfg(all(not(windows)")
            .next()
            .unwrap();
        let after_spawn = launch
            .split("command.spawn().map_err(FakeHostLaunchError::Spawn)?")
            .nth(1)
            .expect("spawn boundary");
        assert!(!after_spawn.contains("map_err("));
        assert!(!after_spawn.contains('?'));
        assert!(after_spawn.contains("Ok(FakeHostChild"));
    }

    /// Broken versions caught: `runas` intent was converted into
    /// `elevated: true`, and an alternate-account child was reopened by pid.
    /// Correlation must use the already-retained ShellExecute process object.
    #[test]
    fn elevated_process_correlation_uses_only_the_retained_handle() {
        let source = include_str!("process.rs").replace("\r\n", "\n");
        let correlate = source
            .split("pub(crate) fn correlate_process_pid(")
            .nth(1)
            .expect("Windows process correlation")
            .split("#[cfg(not(windows))]")
            .next()
            .unwrap();
        let retained_pid = correlate
            .find("GetProcessId(child_handle)")
            .expect("pid re-read from the retained handle");
        let token = correlate
            .find("process_token_is_elevated(child_handle)")
            .expect("TokenElevation query on the retained handle");
        assert!(retained_pid < token);
        assert!(!correlate.contains("OpenProcess("));
        assert!(!correlate.contains("CompareObjectHandles"));
        assert!(!correlate.contains("elevated: true"));
    }

    /// Broken version caught: `launch_elevated(Path, argv)` was a generic UAC
    /// primitive whose protected-install precondition existed only in prose.
    /// This source assertion performs no launch and cannot display UAC.
    #[test]
    fn elevated_launch_consumes_only_an_opaque_protected_executable() {
        let source = include_str!("process.rs").replace("\r\n", "\n");
        let signature = source
            .split("#[cfg(windows)]\npub fn launch_elevated(")
            .nth(1)
            .expect("Windows elevated launcher")
            .split(") -> Result<ElevatedChild")
            .next()
            .unwrap();
        assert!(signature.contains("executable: ProtectedExecutable"));
        assert!(!signature.contains("executable: &Path"));
        assert!(!signature.contains("executable: PathBuf"));
    }

    #[test]
    fn elevated_child_has_no_kill_or_raw_handle_escape() {
        let source = include_str!("process.rs").replace("\r\n", "\n");
        let section = source
            .split("pub struct ElevatedChild")
            .nth(1)
            .expect("elevated child type")
            .split("/// Is this process running")
            .next()
            .unwrap();
        for forbidden in [
            "TerminateProcess",
            ".kill(",
            "fn kill",
            "into_raw_handle",
            "pub fn raw_handle",
        ] {
            assert!(
                !section.contains(forbidden),
                "ElevatedChild must not expose process control through '{forbidden}'"
            );
        }
    }

    #[test]
    fn shell_hint_explains_the_missing_protocol_handler() {
        assert!(shell_hint(31).contains("steam://"));
        assert!(shell_hint(2).contains("not found"));
        assert!(!shell_hint(1234).is_empty());
    }

    /// A snapshot must never *invent* a process, and on Windows it must at
    /// least find this test binary — the launcher hand-off logic is built on
    /// the assumption that an empty result means "not found", not "broken".
    #[test]
    fn snapshot_is_self_consistent() {
        let procs = snapshot();
        if cfg!(windows) {
            let me = std::process::id();
            assert!(
                procs.iter().any(|p| p.pid == me),
                "the snapshot must contain this very process"
            );
            assert!(procs.iter().all(|p| !p.name.is_empty()));
        } else {
            assert!(
                procs.is_empty(),
                "non-Windows snapshot is a documented stub"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_open_is_unsupported_off_windows() {
        assert!(matches!(
            shell_open("steam://rungameid/1"),
            Err(ShellError::Unsupported(_))
        ));
    }

    /// A missing exe is diagnosable *before* the spawn, which is what lets
    /// `ksx run --game` exit 2 without ever plugging a pad.
    #[test]
    fn launching_a_missing_executable_is_not_found_not_a_spawn_error() {
        let missing = std::env::temp_dir().join("ksx-no-such-game-9c1f.exe");
        assert!(matches!(
            launch(&missing, &[], None),
            Err(LaunchError::NotFound(_))
        ));
    }

    /// The handle really is a handle: a process that exits is observed to exit,
    /// with its code, and repeated polls stay consistent.
    #[cfg(windows)]
    #[test]
    fn a_launched_process_is_tracked_to_exit_with_its_code() {
        let cmd = std::path::PathBuf::from(std::env::var("ComSpec").unwrap_or_else(|_| {
            format!(
                "{}\\System32\\cmd.exe",
                std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
            )
        }));
        let mut proc = launch(&cmd, &["/c".into(), "exit 7".into()], None).expect("cmd.exe /c");
        assert!(proc.pid() != 0);
        assert!(
            proc.wait_timeout(Duration::from_secs(10)),
            "cmd /c exit must finish well inside the timeout"
        );
        assert!(!proc.is_alive());
        assert_eq!(proc.exit_code(), Some(7));
        // Idempotent: asking again after exit must not change the answer.
        assert!(proc.wait_timeout(Duration::from_millis(1)));
        assert_eq!(proc.exit_code(), Some(7));
    }

    /// A long-running process is reported alive, and `wait_timeout` honours its
    /// timeout instead of blocking to completion.
    #[cfg(windows)]
    #[test]
    fn a_running_process_is_alive_and_the_timeout_is_respected() {
        let cmd = std::path::PathBuf::from(std::env::var("ComSpec").unwrap_or_else(|_| {
            format!(
                "{}\\System32\\cmd.exe",
                std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
            )
        }));
        // `timeout /t` needs a console; `ping -n` is the portable sleep.
        let mut proc = launch(
            &cmd,
            &["/c".into(), "ping -n 6 127.0.0.1 >NUL".into()],
            None,
        )
        .expect("cmd.exe /c ping");
        assert!(proc.is_alive());
        let started = std::time::Instant::now();
        assert!(
            !proc.wait_timeout(Duration::from_millis(150)),
            "a 5-second sleep must not have finished in 150 ms"
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "wait_timeout blocked past its timeout: {:?}",
            started.elapsed()
        );
        // Let it go; ksx never kills a game, and neither does this test — the
        // child is reaped when cmd finishes on its own.
        assert!(proc.wait_timeout(Duration::from_secs(20)));
    }

    /// The no-kill policy is a property of the source, not of good intentions:
    /// nothing in this module may terminate a process the user is playing.
    #[test]
    fn no_kill_primitive_exists() {
        // include_str! sees this file as checked out on disk: with git's
        // core.autocrlf on (every fresh Windows clone, GitHub CI) that is
        // CRLF, and the `\n` inside the section marker below never matches.
        // Normalize first so the invariant holds on any checkout.
        let source = include_str!("process.rs").replace("\r\n", "\n");
        // Skip the doc comment and this test, which necessarily name the APIs.
        let body = source
            .split("// ---------------------------------------------------------------------------\n// Launching, with a handle")
            .nth(1)
            .expect("the launching section exists");
        let body = body.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["TerminateProcess", ".kill(", "fn kill", "ExitProcess"] {
            assert!(
                !body.contains(forbidden),
                "ksx never kills the user's game, but '{forbidden}' appears in process.rs"
            );
        }
    }

    /// **Every spawn in ksx either hides its console or says why it does not.**
    ///
    /// ksx is a tray app whose daemon has released its console, so a
    /// console-subsystem child with no creation flag gets a **new console
    /// window** — drawn on top of whatever is on the cabinet screen. Six spawn
    /// sites had no flag at all, and one of them (`schtasks`, behind the status
    /// snapshot the cabinet window re-runs every two seconds) is what produced
    /// the "ghost window that flashes but never fully loads" nobody could name.
    ///
    /// A review rule would not have caught that and did not. This scans the
    /// workspace's own sources: each `Command::new` must be within reach of a
    /// [`no_window`] call, or carry a `NO_WINDOW_EXEMPT:` comment stating why a
    /// visible console is the point there. The needle is assembled at runtime so
    /// this test does not match itself.
    #[test]
    fn every_spawn_either_hides_its_console_or_says_why() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crates/")
            .to_path_buf();
        // Built, not written: the literal would make this file a finding.
        let needle = format!("{}::{}::new(", "std::process", "Command");
        // How far after the spawn the excuse may be. Generous enough for a
        // multi-line builder chain, tight enough to stay about that one call.
        const REACH: usize = 600;

        let mut checked = 0usize;
        let mut findings: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // Only crate sources: tests/, examples/ and benches/ run in
                    // a console the developer is looking at.
                    if path.file_name().is_some_and(|n| n == "target") {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if path.extension().is_none_or(|e| e != "rs") {
                    continue;
                }
                // `crates/<name>/src/...` only.
                if !path.components().any(|c| c.as_os_str() == "src") {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let mut from = 0usize;
                while let Some(at) = text[from..].find(&needle) {
                    let at = from + at;
                    from = at + needle.len();
                    checked += 1;
                    let window_start = at.saturating_sub(REACH);
                    let window_end = (at + REACH).min(text.len());
                    // `char_indices` would be exact; these are ASCII sources
                    // with occasional UTF-8 in comments, so snap to a boundary.
                    let (mut lo, mut hi) = (window_start, window_end);
                    while !text.is_char_boundary(lo) {
                        lo += 1;
                    }
                    while !text.is_char_boundary(hi) {
                        hi -= 1;
                    }
                    let context = &text[lo..hi];
                    if context.contains("no_window(") || context.contains("NO_WINDOW_EXEMPT:") {
                        continue;
                    }
                    let line = text[..at].matches('\n').count() + 1;
                    findings.push(format!("{}:{line}", path.display()));
                }
            }
        }

        assert!(
            checked >= 5,
            "the scan found only {checked} spawn site(s) — it stopped seeing the sources"
        );
        assert!(
            findings.is_empty(),
            "these spawns would flash a console window at a tray-app user. Wrap them in \
             `ksx_platform::process::no_window(..)`, or mark the call site \
             `NO_WINDOW_EXEMPT: <why>`:\n  {}",
            findings.join("\n  ")
        );
    }
}
