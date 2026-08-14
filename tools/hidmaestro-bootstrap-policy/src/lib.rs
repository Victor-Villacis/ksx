#![forbid(unsafe_code)]
#![allow(
    dead_code,
    reason = "policy-only harness; production wiring is intentionally absent"
)]

//! Pure policy for KSX's future native HIDMaestro bootstrap.
//!
//! This crate has no binary target and performs no operating-system action.
//! It freezes inputs for a later native implementation without granting it
//! process, pipe, CLR, or elevation authority.

use std::fmt;
use std::num::{NonZeroU32, NonZeroUsize};

const BOOTSTRAP_IMAGE: &str = "ksx-hidmaestro-bootstrap.exe";
const MANAGED_HOST_IMAGE: &str = "ksx-hidmaestro-host.exe";
const OUTER_VERB: &str = "serve-v1";
const INNER_VERB: &str = "serve-inherited-v1";
const PIPE_LEAF_PREFIX: &str = "KSX.HIDMaestro.Play.v1.";
const TOKEN_BYTES: usize = 32;
const TOKEN_CHARACTERS: usize = TOKEN_BYTES * 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PolicyError {
    OuterArgumentCount,
    OuterVerb,
    RendezvousToken,
    DaemonPid,
    SystemRoot,
}

/// Exact outer launch data. The token is decoded immediately so neither
/// `Debug` nor an accidentally derived formatter can print its source text.
#[derive(Clone, PartialEq, Eq)]
struct BootstrapArguments {
    token: [u8; TOKEN_BYTES],
    daemon_pid: NonZeroU32,
}

impl fmt::Debug for BootstrapArguments {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BootstrapArguments")
            .field("token", &"[REDACTED]")
            .field("daemon_pid", &self.daemon_pid)
            .finish()
    }
}

impl BootstrapArguments {
    fn parse(args: &[&str]) -> Result<Self, PolicyError> {
        if args.len() != 3 {
            return Err(PolicyError::OuterArgumentCount);
        }
        if args[0] != OUTER_VERB {
            return Err(PolicyError::OuterVerb);
        }
        let token = decode_token(args[1]).ok_or(PolicyError::RendezvousToken)?;
        let daemon_pid = parse_canonical_nonzero_u32(args[2]).ok_or(PolicyError::DaemonPid)?;
        Ok(Self { token, daemon_pid })
    }

    fn pipe_name(&self) -> String {
        let mut name = String::with_capacity(9 + PIPE_LEAF_PREFIX.len() + TOKEN_CHARACTERS);
        name.push_str(r"\\.\pipe\");
        name.push_str(PIPE_LEAF_PREFIX);
        push_lower_hex(&mut name, &self.token);
        name
    }
}

fn decode_token(text: &str) -> Option<[u8; TOKEN_BYTES]> {
    if text.len() != TOKEN_CHARACTERS
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut token = [0u8; TOKEN_BYTES];
    for (index, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        token[index] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(token)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn push_lower_hex(output: &mut String, bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
}

fn parse_canonical_nonzero_u32(text: &str) -> Option<NonZeroU32> {
    let value = text.parse::<u32>().ok().and_then(NonZeroU32::new)?;
    (value.get().to_string() == text).then_some(value)
}

fn parse_canonical_nonzero_usize(text: &str) -> Option<NonZeroUsize> {
    let value = text.parse::<usize>().ok().and_then(NonZeroUsize::new)?;
    (value.get().to_string() == text).then_some(value)
}

/// Trusted only after a native implementation obtains this value directly
/// from the Windows directory API. It is never copied from the environment.
#[derive(Clone, Debug, PartialEq, Eq)]
struct QueriedSystemRoot(String);

impl QueriedSystemRoot {
    fn from_windows_query(value: &str) -> Result<Self, PolicyError> {
        let bytes = value.as_bytes();
        let drive_absolute = bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/');
        if !drive_absolute
            || value.contains('\0')
            || value.ends_with(['\\', '/'])
            || value.split(['\\', '/']).any(|component| component == "..")
        {
            return Err(PolicyError::SystemRoot);
        }
        Ok(Self(value.to_owned()))
    }
}

/// Names which must never be copied from the launcher's environment. The
/// production block is stricter still: it is built from scratch and copies no
/// inherited entry at all. This predicate exists as a review/test inventory.
fn is_managed_influence_name(name: &str) -> bool {
    let folded = name.to_ascii_uppercase();
    ["DOTNET_", "CORECLR_", "COMPLUS_", "COREHOST_", "COR_"]
        .iter()
        .any(|prefix| folded.starts_with(prefix))
}

const FIXED_ENVIRONMENT: [(&str, &str); 8] = [
    ("COMPlus_EnableDiagnostics", "0"),
    ("CORECLR_ENABLE_PROFILING", "0"),
    ("DOTNET_EnableDiagnostics", "0"),
    ("DOTNET_EnableDiagnostics_Debugger", "0"),
    ("DOTNET_EnableDiagnostics_IPC", "0"),
    ("DOTNET_EnableDiagnostics_Profiler", "0"),
    ("DOTNET_ENABLE_PROFILING", "0"),
    ("DOTNET_MULTILEVEL_LOOKUP", "0"),
];

/// Build a sorted Windows Unicode environment block from trusted values only.
/// Every entry ends in NUL and the block has one additional terminal NUL.
fn managed_environment_block(system_root: &QueriedSystemRoot) -> Vec<u16> {
    let mut entries: Vec<(String, String)> = FIXED_ENVIRONMENT
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    entries.push(("SystemRoot".to_owned(), system_root.0.clone()));
    entries.push(("WINDIR".to_owned(), system_root.0.clone()));
    entries.sort_by(|left, right| {
        left.0
            .to_ascii_uppercase()
            .cmp(&right.0.to_ascii_uppercase())
    });

    let mut block = Vec::new();
    for (name, value) in entries {
        debug_assert!(!name.contains(['=', '\0']));
        debug_assert!(!value.contains('\0'));
        block.extend(name.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ConnectedPipeHandle(NonZeroUsize);

impl fmt::Debug for ConnectedPipeHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConnectedPipeHandle([REDACTED])")
    }
}

/// Frozen launch behavior for the future native implementation. This is data,
/// not a launcher; no type in this crate can execute it.
#[derive(PartialEq, Eq)]
struct ManagedChildPlan {
    image: &'static str,
    working_directory: ChildWorkingDirectory,
    argv: [String; 2],
    unicode_environment: Vec<u16>,
    inherited_handles: [ConnectedPipeHandle; 1],
    contract: ChildLaunchContract,
    identity: ChildIdentityContract,
    managed_entry: ManagedEntryContract,
    graph_and_loader: ManagedGraphAndLoaderContract,
}

impl fmt::Debug for ManagedChildPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedChildPlan")
            .field("image", &self.image)
            .field("working_directory", &self.working_directory)
            .field("argv", &[INNER_VERB, "[HANDLE REDACTED]"])
            .field("unicode_environment", &"[FIXED ENVIRONMENT BLOCK]")
            .field("inherited_handles", &"[ONE AUTHENTICATED PIPE]")
            .field("contract", &self.contract)
            .field("identity", &self.identity)
            .field("managed_entry", &self.managed_entry)
            .field("graph_and_loader", &self.graph_and_loader)
            .finish()
    }
}

/// The child never inherits the daemon or bootstrap current directory and no
/// caller supplies a path. The implementation derives this directory from the
/// protected bootstrap module and proves it is the managed image's parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildWorkingDirectory {
    ProtectedBootstrapSiblingDirectory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChildLaunchContract {
    resolve_beside_bootstrap: bool,
    require_protected_manifest: bool,
    managed_host_is_self_contained_non_single_file: bool,
    use_path_search: bool,
    use_shell_activation: bool,
    use_extended_startup_info: bool,
    inherit_ambient_handles: bool,
    create_primary_thread_suspended: bool,
    create_kill_on_close_job_before_child: bool,
    assign_job_in_creation_attribute_list: bool,
    inherit_job_handle: bool,
    resume_only_after_job_and_identity: bool,
    retain_bootstrap_pipe_through_child_lifetime: bool,
    retain_job_through_child_lifetime: bool,
    bootstrap_waits_for_child: bool,
    bootstrap_may_terminate_child: bool,
}

const CHILD_LAUNCH_CONTRACT: ChildLaunchContract = ChildLaunchContract {
    resolve_beside_bootstrap: true,
    require_protected_manifest: true,
    managed_host_is_self_contained_non_single_file: true,
    use_path_search: false,
    use_shell_activation: false,
    use_extended_startup_info: true,
    inherit_ambient_handles: false,
    create_primary_thread_suspended: true,
    create_kill_on_close_job_before_child: true,
    assign_job_in_creation_attribute_list: true,
    inherit_job_handle: false,
    resume_only_after_job_and_identity: true,
    retain_bootstrap_pipe_through_child_lifetime: true,
    retain_job_through_child_lifetime: true,
    bootstrap_waits_for_child: true,
    bootstrap_may_terminate_child: false,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChildIdentityContract {
    use_returned_process_handle_as_identity: bool,
    compare_image_to_retained_seal: bool,
    compare_pid_to_returned_process_handle: bool,
    require_same_nonzero_session: bool,
    require_elevated_token: bool,
    retain_image_seal_through_child_lifetime: bool,
    retain_full_graph_seals_through_child_lifetime: bool,
    verify_before_first_resume: bool,
    resume_primary_thread_exactly_once: bool,
}

const CHILD_IDENTITY_CONTRACT: ChildIdentityContract = ChildIdentityContract {
    use_returned_process_handle_as_identity: true,
    compare_image_to_retained_seal: true,
    compare_pid_to_returned_process_handle: true,
    require_same_nonzero_session: true,
    require_elevated_token: true,
    retain_image_seal_through_child_lifetime: true,
    retain_full_graph_seals_through_child_lifetime: true,
    verify_before_first_resume: true,
    resume_primary_thread_exactly_once: true,
};

/// First managed-entry actions after the fixed inner argv is parsed. CoreCLR
/// has necessarily reached managed entry already; "immediate" means before
/// KSX creates a thread, initializes the SDK, or performs optional logging.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ManagedEntryContract {
    clear_pipe_inherit_flag_immediately: bool,
    verify_pipe_inherit_flag_is_clear: bool,
    fail_closed_when_flag_clear_fails: bool,
    clear_before_ksx_thread_sdk_or_logging: bool,
    never_reenable_pipe_inheritance: bool,
    never_spawn_descendants: bool,
}

const MANAGED_ENTRY_CONTRACT: ManagedEntryContract = ManagedEntryContract {
    clear_pipe_inherit_flag_immediately: true,
    verify_pipe_inherit_flag_is_clear: true,
    fail_closed_when_flag_clear_fails: true,
    clear_before_ksx_thread_sdk_or_logging: true,
    never_reenable_pipe_inheritance: true,
    never_spawn_descendants: true,
};

/// S1.5b must turn the complete managed/native load closure into retained,
/// immutable evidence. A signed apphost alone is insufficient because CoreCLR,
/// host policy, native runtime dependencies, managed assemblies and config all
/// participate before or during managed entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ManagedGraphAndLoaderContract {
    seal_every_manifest_file_before_child_creation: bool,
    retain_all_seals_through_child_lifetime: bool,
    reject_reparse_point_in_entire_graph: bool,
    hash_and_signature_reads_use_sealed_objects: bool,
    runtimeconfig_and_deps_close_the_graph: bool,
    explicit_application_path: bool,
    explicit_protected_working_directory: bool,
    inherited_path_is_absent: bool,
    prefer_system32_for_system_images: bool,
    block_remote_native_images: bool,
    block_low_integrity_native_images: bool,
    allow_native_modules_only_from_graph_or_system32: bool,
}

const MANAGED_GRAPH_AND_LOADER_CONTRACT: ManagedGraphAndLoaderContract =
    ManagedGraphAndLoaderContract {
        seal_every_manifest_file_before_child_creation: true,
        retain_all_seals_through_child_lifetime: true,
        reject_reparse_point_in_entire_graph: true,
        hash_and_signature_reads_use_sealed_objects: true,
        runtimeconfig_and_deps_close_the_graph: true,
        explicit_application_path: true,
        explicit_protected_working_directory: true,
        inherited_path_is_absent: true,
        prefer_system32_for_system_images: true,
        block_remote_native_images: true,
        block_low_integrity_native_images: true,
        allow_native_modules_only_from_graph_or_system32: true,
    };

/// The daemon must not let a completed pipe operation outrun the lifetime of
/// the exact bootstrap process authenticated during admission. A completion
/// and process exit may become observable together, so the post-completion
/// handle query is authoritative and completed read bytes remain quarantined
/// until it passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DaemonIoContract {
    retain_authenticated_bootstrap_handle: bool,
    wait_on_bootstrap_during_pending_io: bool,
    recheck_after_synchronous_completion: bool,
    recheck_after_overlapped_completion: bool,
    recheck_after_complete_frame: bool,
    discard_read_when_exit_observed: bool,
    poison_write_when_exit_observed: bool,
    bootstrap_exit_wins_completion_tie: bool,
}

const DAEMON_IO_CONTRACT: DaemonIoContract = DaemonIoContract {
    retain_authenticated_bootstrap_handle: true,
    wait_on_bootstrap_during_pending_io: true,
    recheck_after_synchronous_completion: true,
    recheck_after_overlapped_completion: true,
    recheck_after_complete_frame: true,
    discard_read_when_exit_observed: true,
    poison_write_when_exit_observed: true,
    bootstrap_exit_wins_completion_tie: true,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RequiredWindowsEvidence {
    PipeClientPidStableAcrossInheritance,
    BootstrapAndManagedChildSessionStable,
    BootstrapCrashClosesJobAndReapsChild,
    BootstrapCrashRejectsQueuedFrame,
    HandleListExcludesInheritableCanaries,
    SuspendedChildCannotReachManagedEntryBeforeResume,
    IdentityMismatchCannotReachManagedEntry,
    ChildWorkingDirectoryIsProtectedSiblingDirectory,
    ManagedChildClearsPipeInheritanceImmediately,
    NativeModuleOriginsMatchProtectedGraphOrSystem32,
}

const REQUIRED_WINDOWS_EVIDENCE: [RequiredWindowsEvidence; 10] = [
    RequiredWindowsEvidence::PipeClientPidStableAcrossInheritance,
    RequiredWindowsEvidence::BootstrapAndManagedChildSessionStable,
    RequiredWindowsEvidence::BootstrapCrashClosesJobAndReapsChild,
    RequiredWindowsEvidence::BootstrapCrashRejectsQueuedFrame,
    RequiredWindowsEvidence::HandleListExcludesInheritableCanaries,
    RequiredWindowsEvidence::SuspendedChildCannotReachManagedEntryBeforeResume,
    RequiredWindowsEvidence::IdentityMismatchCannotReachManagedEntry,
    RequiredWindowsEvidence::ChildWorkingDirectoryIsProtectedSiblingDirectory,
    RequiredWindowsEvidence::ManagedChildClearsPipeInheritanceImmediately,
    RequiredWindowsEvidence::NativeModuleOriginsMatchProtectedGraphOrSystem32,
];

impl ManagedChildPlan {
    fn for_authenticated_pipe(pipe: ConnectedPipeHandle, system_root: &QueriedSystemRoot) -> Self {
        Self {
            image: MANAGED_HOST_IMAGE,
            working_directory: ChildWorkingDirectory::ProtectedBootstrapSiblingDirectory,
            argv: [INNER_VERB.to_owned(), pipe.0.get().to_string()],
            unicode_environment: managed_environment_block(system_root),
            inherited_handles: [pipe],
            contract: CHILD_LAUNCH_CONTRACT,
            identity: CHILD_IDENTITY_CONTRACT,
            managed_entry: MANAGED_ENTRY_CONTRACT,
            graph_and_loader: MANAGED_GRAPH_AND_LOADER_CONTRACT,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn outer_arguments_are_exact_canonical_and_secret_safe() {
        let parsed = BootstrapArguments::parse(&[OUTER_VERB, TOKEN, "4294967295"]).unwrap();
        assert_eq!(parsed.daemon_pid.get(), u32::MAX);
        assert_eq!(
            parsed.pipe_name(),
            format!(r"\\.\pipe\{PIPE_LEAF_PREFIX}{TOKEN}")
        );
        let debug = format!("{parsed:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(TOKEN));

        let uppercase_token = TOKEN.to_ascii_uppercase();
        for bad in [
            vec![OUTER_VERB, TOKEN],
            vec![OUTER_VERB, TOKEN, "1", "extra"],
            vec!["other", TOKEN, "1"],
            vec![OUTER_VERB, &uppercase_token, "1"],
            vec![OUTER_VERB, "abcd", "1"],
            vec![OUTER_VERB, TOKEN, "0"],
            vec![OUTER_VERB, TOKEN, "01"],
            vec![OUTER_VERB, TOKEN, "+1"],
            vec![OUTER_VERB, TOKEN, " 1"],
        ] {
            assert!(BootstrapArguments::parse(&bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn fixed_images_are_plain_basename_executables() {
        for image in [BOOTSTRAP_IMAGE, MANAGED_HOST_IMAGE] {
            assert!(image.ends_with(".exe"));
            assert!(!image.contains(['/', '\\', ':', '\0']));
        }
        assert_ne!(BOOTSTRAP_IMAGE, MANAGED_HOST_IMAGE);
    }

    #[test]
    fn managed_influence_inventory_is_case_insensitive_and_future_prefix_safe() {
        for name in [
            "DOTNET_STARTUP_HOOKS",
            "dotnet_additional_deps",
            "DotNet_Shared_Store",
            "CORECLR_ENABLE_PROFILING",
            "coreclr_profiler_path_64",
            "COMPlus_ReadyToRun",
            "corehost_tracefile",
            "COR_ENABLE_PROFILING",
        ] {
            assert!(is_managed_influence_name(name), "missed {name}");
        }
        for name in ["SystemRoot", "WINDIR", "KSX_PROFILE"] {
            assert!(!is_managed_influence_name(name), "overmatched {name}");
        }
    }

    #[test]
    fn environment_is_rebuilt_from_exact_entries_and_ends_with_double_nul() {
        let root = QueriedSystemRoot::from_windows_query(r"C:\Windows").unwrap();
        let block = managed_environment_block(&root);
        assert!(block.ends_with(&[0, 0]));
        let decoded = String::from_utf16(&block).unwrap();
        let entries: Vec<&str> = decoded.trim_end_matches('\0').split('\0').collect();
        assert_eq!(entries.len(), FIXED_ENVIRONMENT.len() + 2);
        assert!(entries.contains(&r"SystemRoot=C:\Windows"));
        assert!(entries.contains(&r"WINDIR=C:\Windows"));
        for (name, value) in FIXED_ENVIRONMENT {
            assert!(entries.contains(&format!("{name}={value}").as_str()));
        }
        for forbidden in [
            "STARTUP_HOOKS",
            "ADDITIONAL_DEPS",
            "SHARED_STORE",
            "PROFILER_PATH",
            "PROFILER={",
            "HOST_TRACEFILE",
            "PATH=",
            "TEMP=",
        ] {
            assert!(!decoded.to_ascii_uppercase().contains(forbidden));
        }
        let names: Vec<String> = entries
            .iter()
            .map(|entry| entry.split_once('=').unwrap().0.to_ascii_uppercase())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn system_root_must_look_like_a_non_parented_drive_absolute_query_result() {
        assert!(QueriedSystemRoot::from_windows_query(r"C:\Windows").is_ok());
        for bad in ["", "Windows", r"\Windows", r"C:\Windows\", r"C:\..\Windows"] {
            assert!(
                QueriedSystemRoot::from_windows_query(bad).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn child_plan_has_one_handle_exact_argv_and_no_generic_launch_escape() {
        let pipe = ConnectedPipeHandle(NonZeroUsize::new(0x1234).unwrap());
        let root = QueriedSystemRoot::from_windows_query(r"C:\Windows").unwrap();
        let plan = ManagedChildPlan::for_authenticated_pipe(pipe, &root);
        assert_eq!(plan.image, MANAGED_HOST_IMAGE);
        assert_eq!(
            plan.working_directory,
            ChildWorkingDirectory::ProtectedBootstrapSiblingDirectory
        );
        assert_eq!(plan.argv, [INNER_VERB.to_owned(), "4660".to_owned()]);
        assert_eq!(plan.inherited_handles, [pipe]);
        assert_eq!(parse_canonical_nonzero_usize(&plan.argv[1]), Some(pipe.0));
        assert!(plan.contract.resolve_beside_bootstrap);
        assert!(plan.contract.require_protected_manifest);
        assert!(plan.contract.managed_host_is_self_contained_non_single_file);
        assert!(!plan.contract.use_path_search);
        assert!(!plan.contract.use_shell_activation);
        assert!(plan.contract.use_extended_startup_info);
        assert!(!plan.contract.inherit_ambient_handles);
        assert!(plan.contract.create_primary_thread_suspended);
        assert!(plan.contract.create_kill_on_close_job_before_child);
        assert!(plan.contract.assign_job_in_creation_attribute_list);
        assert!(!plan.contract.inherit_job_handle);
        assert!(plan.contract.resume_only_after_job_and_identity);
        assert!(plan.contract.retain_bootstrap_pipe_through_child_lifetime);
        assert!(plan.contract.retain_job_through_child_lifetime);
        assert!(plan.contract.bootstrap_waits_for_child);
        assert!(!plan.contract.bootstrap_may_terminate_child);
        assert!(!format!("{plan:?}").contains("4660"));
    }

    #[test]
    fn suspended_child_is_contained_and_identified_before_its_only_resume() {
        let contract = CHILD_IDENTITY_CONTRACT;
        assert!(CHILD_LAUNCH_CONTRACT.create_primary_thread_suspended);
        assert!(CHILD_LAUNCH_CONTRACT.create_kill_on_close_job_before_child);
        assert!(CHILD_LAUNCH_CONTRACT.assign_job_in_creation_attribute_list);
        assert!(!CHILD_LAUNCH_CONTRACT.inherit_job_handle);
        assert!(CHILD_LAUNCH_CONTRACT.resume_only_after_job_and_identity);
        assert!(contract.use_returned_process_handle_as_identity);
        assert!(contract.compare_image_to_retained_seal);
        assert!(contract.compare_pid_to_returned_process_handle);
        assert!(contract.require_same_nonzero_session);
        assert!(contract.require_elevated_token);
        assert!(contract.retain_image_seal_through_child_lifetime);
        assert!(contract.retain_full_graph_seals_through_child_lifetime);
        assert!(contract.verify_before_first_resume);
        assert!(contract.resume_primary_thread_exactly_once);
    }

    #[test]
    fn managed_entry_clears_pipe_inheritance_before_any_ksx_runtime_work() {
        let contract = MANAGED_ENTRY_CONTRACT;
        assert!(contract.clear_pipe_inherit_flag_immediately);
        assert!(contract.verify_pipe_inherit_flag_is_clear);
        assert!(contract.fail_closed_when_flag_clear_fails);
        assert!(contract.clear_before_ksx_thread_sdk_or_logging);
        assert!(contract.never_reenable_pipe_inheritance);
        assert!(contract.never_spawn_descendants);
    }

    #[test]
    fn complete_graph_and_native_loader_are_closed_to_unprotected_paths() {
        let contract = MANAGED_GRAPH_AND_LOADER_CONTRACT;
        assert!(contract.seal_every_manifest_file_before_child_creation);
        assert!(contract.retain_all_seals_through_child_lifetime);
        assert!(contract.reject_reparse_point_in_entire_graph);
        assert!(contract.hash_and_signature_reads_use_sealed_objects);
        assert!(contract.runtimeconfig_and_deps_close_the_graph);
        assert!(contract.explicit_application_path);
        assert!(contract.explicit_protected_working_directory);
        assert!(contract.inherited_path_is_absent);
        assert!(contract.prefer_system32_for_system_images);
        assert!(contract.block_remote_native_images);
        assert!(contract.block_low_integrity_native_images);
        assert!(contract.allow_native_modules_only_from_graph_or_system32);
    }

    #[test]
    fn daemon_io_never_delivers_a_completion_that_lost_its_bootstrap() {
        let contract = DAEMON_IO_CONTRACT;
        assert!(contract.retain_authenticated_bootstrap_handle);
        assert!(contract.wait_on_bootstrap_during_pending_io);
        assert!(contract.recheck_after_synchronous_completion);
        assert!(contract.recheck_after_overlapped_completion);
        assert!(contract.recheck_after_complete_frame);
        assert!(contract.discard_read_when_exit_observed);
        assert!(contract.poison_write_when_exit_observed);
        assert!(contract.bootstrap_exit_wins_completion_tie);
    }

    #[test]
    fn windows_gate_inventory_covers_inheritance_crash_identity_and_racing_io() {
        assert_eq!(REQUIRED_WINDOWS_EVIDENCE.len(), 10);
        for required in [
            RequiredWindowsEvidence::PipeClientPidStableAcrossInheritance,
            RequiredWindowsEvidence::BootstrapAndManagedChildSessionStable,
            RequiredWindowsEvidence::BootstrapCrashClosesJobAndReapsChild,
            RequiredWindowsEvidence::BootstrapCrashRejectsQueuedFrame,
            RequiredWindowsEvidence::HandleListExcludesInheritableCanaries,
            RequiredWindowsEvidence::SuspendedChildCannotReachManagedEntryBeforeResume,
            RequiredWindowsEvidence::IdentityMismatchCannotReachManagedEntry,
            RequiredWindowsEvidence::ChildWorkingDirectoryIsProtectedSiblingDirectory,
            RequiredWindowsEvidence::ManagedChildClearsPipeInheritanceImmediately,
            RequiredWindowsEvidence::NativeModuleOriginsMatchProtectedGraphOrSystem32,
        ] {
            assert!(REQUIRED_WINDOWS_EVIDENCE.contains(&required));
        }
    }

    #[test]
    fn this_harness_has_no_binary_or_os_authority() {
        let manifest = include_str!("../Cargo.toml");
        assert!(manifest.contains("[lib]"));
        for forbidden_table in ["[[bin]]", "[[example]]", "[[test]]", "[[bench]]"] {
            assert!(!manifest.contains(forbidden_table));
        }
        for disabled in [
            "autobins = false",
            "autoexamples = false",
            "autotests = false",
            "autobenches = false",
            "build = false",
        ] {
            assert!(manifest.contains(disabled), "missing {disabled}");
        }
        assert!(!manifest.contains("[dependencies]"));
        assert!(!manifest.contains("[build-dependencies]"));

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for forbidden_target in [
            "build.rs",
            "src/main.rs",
            "src/bin",
            "examples",
            "tests",
            "benches",
        ] {
            assert!(
                !root.join(forbidden_target).exists(),
                "automatic target exists at {forbidden_target}"
            );
        }

        let production = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "std::process::Command",
            "windows_sys",
            "windows::Win32",
            "CreateProcess",
            "ShellExecute",
            "CreateNamedPipe",
            "CreateFileW",
            "LoadLibrary",
            "TerminateProcess",
            "hostfxr",
        ] {
            assert!(
                !production.contains(forbidden),
                "authority leaked through {forbidden}"
            );
        }
        assert!(!production.contains("pub fn "));
        assert!(!production.contains("pub struct "));
    }
}
