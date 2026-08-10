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
    #[error("the installed sibling is not beside the running executable")]
    NotSibling,
    #[error("the KSX installation is not under a Windows Program Files Known Folder")]
    OutsideProgramFiles,
    #[error("could not resolve a Windows Program Files Known Folder: {0}")]
    KnownFolder(String),
    #[error("the KSX installation path is not protected: {0}")]
    UnsafeAcl(String),
    #[error("protected installation validation is available only on Windows")]
    Unsupported,
}

/// Validate and return one canonical executable sibling that is safe to
/// launch or load with administrator rights.
///
/// The roots come from `SHGetKnownFolderPath`, never environment variables.
/// Prefix membership is only the first gate; the live ACL check below is what
/// catches a Program Files subtree whose permissions were weakened.
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
fn verify_non_reparse_kind(path: &Path, directory: bool) -> Result<(), ProtectedInstallError> {
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

#[derive(Debug, thiserror::Error)]
pub enum ElevationError {
    #[error("the elevated executable must be an existing absolute file: {0}")]
    InvalidExecutable(String),
    #[error("the Windows administrator prompt was cancelled")]
    Cancelled,
    #[error("could not launch the elevated helper: {0}")]
    Launch(#[source] std::io::Error),
    #[error("could not wait for the elevated helper: {0}")]
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

/// Launch an exact executable with the `runas` verb, wait for it, and return
/// only its exit code. The caller deliberately does not trust stdout: driver
/// state is re-surveyed after this function returns.
#[cfg(windows)]
pub fn run_elevated_and_wait(
    executable: &Path,
    args: &[String],
) -> Result<ElevatedExit, ElevationError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    if !executable.is_absolute() || !executable.is_file() {
        return Err(ElevationError::InvalidExecutable(
            executable.display().to_string(),
        ));
    }
    let executable = executable.canonicalize().map_err(ElevationError::Launch)?;
    let file: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let parameters = args
        .iter()
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let parameters: Vec<u16> = parameters
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let directory: Vec<u16> = executable
        .parent()
        .unwrap_or_else(|| Path::new(r"C:\"))
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_HIDE,
        ..Default::default()
    };
    // SAFETY: all strings are NUL-terminated and live through the call; the
    // process handle returned under NOCLOSEPROCESS is closed below.
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
        return Err(ElevationError::Launch(std::io::Error::other(
            "ShellExecuteExW returned no process handle",
        )));
    }
    let handle = info.hProcess;
    let waited = unsafe { WaitForSingleObject(handle, ELEVATED_HELPER_WAIT_MS) };
    if waited == WAIT_TIMEOUT {
        // Closing our handle does not terminate the helper. It may be inside a
        // driver mutation, so the only safe action is to leave it running and
        // make the caller re-survey/recover rather than launch a second copy.
        unsafe { CloseHandle(handle) };
        return Err(ElevationError::Timeout);
    }
    if waited != WAIT_OBJECT_0 {
        let err = std::io::Error::last_os_error();
        unsafe { CloseHandle(handle) };
        return Err(ElevationError::Wait(err));
    }
    let mut code = 0u32;
    if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
        let err = std::io::Error::last_os_error();
        unsafe { CloseHandle(handle) };
        return Err(ElevationError::Wait(err));
    }
    unsafe { CloseHandle(handle) };
    Ok(ElevatedExit { code })
}

#[cfg(not(windows))]
pub fn run_elevated_and_wait(
    _executable: &Path,
    _args: &[String],
) -> Result<ElevatedExit, ElevationError> {
    Err(ElevationError::Unsupported)
}

/// Is this process running with an elevated token?
///
/// `None` means the question could not be answered (never assume "yes" — the
/// caller prints installation advice, and telling a non-admin user they are
/// admin wastes their time with a UAC-less failure).
#[cfg(windows)]
pub fn is_elevated() -> Option<bool> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    #[repr(C)]
    struct TokenElevationRaw {
        token_is_elevated: u32,
    }

    let mut token = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle that needs no closing;
    // `token` is closed below on the success path.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let mut info = TokenElevationRaw {
        token_is_elevated: 0,
    };
    let mut returned = 0u32;
    // SAFETY: TokenElevation's out-parameter is a TOKEN_ELEVATION, which is
    // layout-identical to the single-u32 struct above.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            (&mut info as *mut TokenElevationRaw).cast(),
            std::mem::size_of::<TokenElevationRaw>() as u32,
            &mut returned,
        )
    } != 0;
    // SAFETY: `token` came from OpenProcessToken and is not used again.
    unsafe { CloseHandle(token) };
    ok.then_some(info.token_is_elevated != 0)
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
        let source = include_str!("process.rs");
        let section = source
            .split("pub fn run_elevated_and_wait")
            .nth(1)
            .expect("elevation function");
        let section = section.split("/// Is this process running").next().unwrap();
        assert!(!section.contains("INFINITE"));
        assert!(!section.contains("TerminateProcess"));
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
