//! Narrow elevated boundary for KSX-owned WinUSB preparation.
//!
//! This executable deliberately accepts no paths, driver bytes, certificate
//! names or arbitrary commands. The unelevated product selects one exact live
//! USB interface and launches this installed sibling through Windows `runas`.
//! The platform transaction then revalidates the device, writes its protected
//! journal before mutation, and owns rollback and release.

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

use std::ffi::OsString;
use std::io::{self, Write as _};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use ksx_platform::winusb::transaction::{
    cleanup_owned, initialize_store, prepare_exact, release_exact, CleanupResult, MutationResult,
    Phase, PrepareSpec, ReleaseSpec, TransactionError,
};
use serde_json::{json, Value};

const EXIT_SUCCESS: i32 = 0;
const EXIT_REFUSED: i32 = 2;
const EXIT_INTERNAL: i32 = 3;
const EXIT_RECOVERY: i32 = 4;

/// The uninstaller must never wait forever, but it also must never terminate a
/// helper that may be between durable journal phases.  The public cleanup verb
/// therefore observes a private worker for a bounded interval and, on expiry,
/// exits while leaving that worker alive.  The worker owns the transaction
/// mutex for its full mutation lifetime.
const CLEANUP_WORKER_WAIT: Duration = Duration::from_secs(10 * 60);
const CLEANUP_WORKER_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Operation {
    InitializeStore,
    Prepare(PrepareSpec),
    Release(ReleaseSpec),
    CleanupCoordinator,
    CleanupWorker,
}

#[derive(Debug, PartialEq, Eq)]
enum ParseError {
    NonUnicode,
    WrongShape,
}

fn parse_args<I>(args: I) -> Result<Operation, ParseError>
where
    I: IntoIterator<Item = OsString>,
{
    let args = args
        .into_iter()
        .map(|arg| arg.into_string().map_err(|_| ParseError::NonUnicode))
        .collect::<Result<Vec<_>, _>>()?;

    match args.as_slice() {
        [verb] if verb == "initialize-store" => Ok(Operation::InitializeStore),
        [verb, instance, spare, rebind, certificate]
            if verb == "prepare-exact"
                && spare == "--confirm-spare-keyboard"
                && rebind == "--confirm-rebind"
                && certificate == "--confirm-machine-certificate" =>
        {
            Ok(Operation::Prepare(PrepareSpec {
                instance_id: instance.clone(),
                confirm_spare_keyboard: true,
                confirm_rebind: true,
                confirm_machine_certificate: true,
            }))
        }
        [verb, instance, confirmation]
            if verb == "release-exact" && confirmation == "--confirm-release" =>
        {
            Ok(Operation::Release(ReleaseSpec {
                instance_id: instance.clone(),
                confirm_release: true,
            }))
        }
        [verb] if verb == "cleanup-owned" => Ok(Operation::CleanupCoordinator),
        [verb] if verb == "cleanup-owned-worker" => Ok(Operation::CleanupWorker),
        _ => Err(ParseError::WrongShape),
    }
}

/// Resolve this executable through the same Program Files + live ACL boundary
/// used by the unelevated launcher.  In particular, the cleanup coordinator
/// must never self-spawn a sibling copied into Downloads or another
/// user-writable directory.
fn installed_self() -> Result<PathBuf, String> {
    let current = std::env::current_exe()
        .map_err(|error| format!("the running recovery helper could not be located: {error}"))?;
    ksx_platform::process::protected_install_sibling(&current, &current)
        .map_err(|error| format!("the recovery helper is not in a protected installation: {error}"))
}

/// Poll an owned process handle until it exits or the observer's deadline
/// expires. `None` means timeout; it never means the worker was terminated.
/// Keeping this generic makes the deadline/no-kill policy deterministic in
/// tests without starting a real driver transaction.
fn observe_until<T, E>(
    timeout: Duration,
    poll_interval: Duration,
    mut poll: impl FnMut() -> Result<Option<T>, E>,
    mut sleep: impl FnMut(Duration),
) -> Result<Option<T>, E> {
    let started = Instant::now();
    loop {
        if let Some(value) = poll()? {
            return Ok(Some(value));
        }
        if started.elapsed() >= timeout {
            return Ok(None);
        }
        sleep(poll_interval);
    }
}

fn cleanup_worker_exit_value(code: i32) -> (i32, Value) {
    if code == EXIT_SUCCESS {
        return (
            EXIT_SUCCESS,
            json!({
                "ok": true,
                "operation": "cleanup-owned",
                "message": "the bounded recovery worker verified that all KSX-owned WinUSB state is released",
            }),
        );
    }
    let category = if code == EXIT_RECOVERY {
        "recovery-required"
    } else if code == EXIT_REFUSED {
        "refused"
    } else {
        "internal"
    };
    (
        code,
        error_value(
            "cleanup-owned",
            category,
            format!("the recovery worker exited with code {code}; nothing may be uninstalled"),
        ),
    )
}

fn coordinate_cleanup() -> (i32, Value) {
    let executable = match installed_self() {
        Ok(path) => path,
        Err(message) => {
            return (
                EXIT_INTERNAL,
                error_value("cleanup-owned", "internal", message),
            );
        }
    };
    let mut child = match Command::new(executable)
        .arg("cleanup-owned-worker")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return (
                EXIT_INTERNAL,
                error_value(
                    "cleanup-owned",
                    "internal",
                    format!("the recovery worker could not be started: {error}"),
                ),
            );
        }
    };

    match observe_until(
        CLEANUP_WORKER_WAIT,
        CLEANUP_WORKER_POLL,
        || child.try_wait(),
        std::thread::sleep,
    ) {
        Ok(Some(status)) => status.code().map_or_else(
            || {
                (
                    EXIT_INTERNAL,
                    error_value(
                        "cleanup-owned",
                        "internal",
                        "the recovery worker ended without a Windows exit code; nothing may be uninstalled"
                            .to_owned(),
                    ),
                )
            },
            cleanup_worker_exit_value,
        ),
        Ok(None) => {
            // Dropping `Child` closes our observation handle; Rust does not
            // terminate the process.  The worker remains alive and keeps the
            // global transaction mutex until its journaled mutation finishes.
            (
                EXIT_RECOVERY,
                error_value(
                    "cleanup-owned",
                    "recovery-required",
                    format!(
                        "the recovery worker is still running after {} minutes; it was left running and nothing may be uninstalled",
                        CLEANUP_WORKER_WAIT.as_secs() / 60
                    ),
                ),
            )
        }
        Err(error) => (
            EXIT_INTERNAL,
            error_value(
                "cleanup-owned",
                "internal",
                format!("the recovery worker could not be observed: {error}"),
            ),
        ),
    }
}

fn phase_value(phase: Phase) -> Value {
    serde_json::to_value(phase).unwrap_or_else(|_| Value::String("unknown".to_owned()))
}

fn mutation_value(operation: &'static str, result: MutationResult) -> Value {
    json!({
        "ok": true,
        "operation": operation,
        "instance_id": result.instance_id,
        "hardware_id": result.hardware_id,
        "phase": phase_value(result.phase),
        "message": result.message,
        "warning": result.warning,
    })
}

fn cleanup_value(result: CleanupResult) -> Value {
    json!({
        "ok": true,
        "operation": "cleanup-owned",
        "phase": phase_value(result.phase),
        "cleaned_receipts": result.cleaned_receipts,
        "disconnected_receipts": result.disconnected_receipts,
        "message": result.message,
        "warning": result.warning,
    })
}

fn error_value(operation: &'static str, category: &'static str, message: String) -> Value {
    json!({
        "ok": false,
        "operation": operation,
        "category": category,
        "message": message,
    })
}

fn verified_mutation_value(
    operation: &'static str,
    expected: Phase,
    result: MutationResult,
) -> (i32, Value) {
    if result.phase == expected {
        return (EXIT_SUCCESS, mutation_value(operation, result));
    }
    (
        EXIT_RECOVERY,
        error_value(
            operation,
            "recovery-required",
            format!(
                "the transaction returned nonterminal phase {:?}; recovery must finish before retrying",
                result.phase
            ),
        ),
    )
}

fn verified_cleanup_value(result: CleanupResult) -> (i32, Value) {
    if result.phase == Phase::Released {
        return (EXIT_SUCCESS, cleanup_value(result));
    }
    (
        EXIT_RECOVERY,
        error_value(
            "cleanup-owned",
            "recovery-required",
            format!(
                "cleanup returned nonterminal phase {:?}; nothing may be uninstalled",
                result.phase
            ),
        ),
    )
}

fn transaction_exit(error: &TransactionError) -> i32 {
    match error {
        TransactionError::RebootRequired(_) | TransactionError::RecoveryRequired(_) => {
            EXIT_RECOVERY
        }
        TransactionError::MissingPrepareConsent
        | TransactionError::MissingReleaseConsent
        | TransactionError::InvalidInstance(_)
        | TransactionError::NotClaimable(_)
        | TransactionError::NotOwned(_)
        | TransactionError::LastKeyboard { .. }
        | TransactionError::SharedHardwareId { .. }
        | TransactionError::DeviceChanged(_)
        | TransactionError::UnsafeHardwareId(_) => EXIT_REFUSED,
        TransactionError::Verification(_)
        | TransactionError::Inventory(_)
        | TransactionError::CommandFailed { .. }
        | TransactionError::Journal(_)
        | TransactionError::Prepare(_)
        | TransactionError::Windows(_)
        | TransactionError::Unsupported => EXIT_INTERNAL,
    }
}

fn failed_transaction_value(name: &'static str, error: TransactionError) -> (i32, Value) {
    let exit = transaction_exit(&error);
    let category = if exit == EXIT_RECOVERY {
        "recovery-required"
    } else if exit == EXIT_REFUSED {
        "refused"
    } else {
        "internal"
    };
    (exit, error_value(name, category, error.to_string()))
}

fn execute(operation: Operation) -> (i32, Value) {
    match operation {
        Operation::InitializeStore => match ksx_platform::process::protected_store_initializer() {
            Ok(_) => match initialize_store() {
                Ok(()) => (
                    EXIT_SUCCESS,
                    json!({
                        "ok": true,
                        "operation": "initialize-store",
                        "message": "the fixed machine-wide WinUSB recovery store has the exact protected access policy",
                    }),
                ),
                Err(error) => failed_transaction_value("initialize-store", error),
            },
            Err(error) => (
                EXIT_INTERNAL,
                error_value(
                    "initialize-store",
                    "internal",
                    format!("the installer recovery initializer is not protected: {error}"),
                ),
            ),
        },
        Operation::Prepare(spec) => match installed_self() {
            Ok(_) => match prepare_exact(&spec) {
                Ok(result) => verified_mutation_value("prepare-exact", Phase::Active, result),
                Err(error) => failed_transaction_value("prepare-exact", error),
            },
            Err(message) => (
                EXIT_INTERNAL,
                error_value("prepare-exact", "internal", message),
            ),
        },
        Operation::Release(spec) => match installed_self() {
            Ok(_) => match release_exact(&spec) {
                Ok(result) => verified_mutation_value("release-exact", Phase::Released, result),
                Err(error) => failed_transaction_value("release-exact", error),
            },
            Err(message) => (
                EXIT_INTERNAL,
                error_value("release-exact", "internal", message),
            ),
        },
        Operation::CleanupCoordinator => coordinate_cleanup(),
        Operation::CleanupWorker => match installed_self() {
            Ok(_) => match cleanup_owned() {
                Ok(result) => verified_cleanup_value(result),
                Err(error) => failed_transaction_value("cleanup-owned", error),
            },
            Err(message) => (
                EXIT_INTERNAL,
                error_value("cleanup-owned", "internal", message),
            ),
        },
    }
}

fn emit(value: &Value) -> io::Result<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn run(args: impl IntoIterator<Item = OsString>) -> i32 {
    let parsed = match parse_args(args) {
        Ok(operation) => operation,
        Err(error) => {
            let message = match error {
                ParseError::NonUnicode => "arguments must be ordinary Windows text",
                ParseError::WrongShape => {
                    "the helper accepts only initialize-store, prepare-exact, release-exact or cleanup-owned in their fixed forms"
                }
            };
            let _ = emit(&error_value("arguments", "refused", message.to_owned()));
            return EXIT_REFUSED;
        }
    };

    match std::panic::catch_unwind(|| execute(parsed)) {
        Ok((exit, value)) => {
            // ShellExecuteEx/Inno launch this GUI-subsystem helper without a
            // console, so stdout may have no valid handle. JSON is a useful
            // diagnostic when a caller redirects it, but the authoritative
            // result is the verified transaction plus this exit code; a
            // missing console must never turn a successful cleanup into an
            // uninstall-blocking failure.
            let _ = emit(&value);
            exit
        }
        Err(_) => {
            let _ = emit(&error_value(
                "transaction",
                "internal",
                "the elevated helper stopped unexpectedly".to_owned(),
            ));
            EXIT_INTERNAL
        }
    }
}

fn main() {
    std::process::exit(run(std::env::args_os().skip(1)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn prepare_shape_carries_only_exact_identity_and_all_three_consents() {
        let parsed = parse_args(args(&[
            "prepare-exact",
            r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE",
            "--confirm-spare-keyboard",
            "--confirm-rebind",
            "--confirm-machine-certificate",
        ]))
        .expect("fixed prepare shape");
        assert_eq!(
            parsed,
            Operation::Prepare(PrepareSpec {
                instance_id: r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE".to_owned(),
                confirm_spare_keyboard: true,
                confirm_rebind: true,
                confirm_machine_certificate: true,
            })
        );
    }

    #[test]
    fn missing_or_reordered_prepare_consent_is_refused() {
        for values in [
            vec![
                "prepare-exact",
                r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE",
                "--confirm-spare-keyboard",
                "--confirm-rebind",
            ],
            vec![
                "prepare-exact",
                r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE",
                "--confirm-rebind",
                "--confirm-spare-keyboard",
                "--confirm-machine-certificate",
            ],
        ] {
            assert_eq!(parse_args(args(&values)), Err(ParseError::WrongShape));
        }
    }

    #[test]
    fn release_and_cleanup_have_separate_fixed_shapes() {
        assert_eq!(
            parse_args(args(&["initialize-store"])),
            Ok(Operation::InitializeStore)
        );
        assert_eq!(
            parse_args(args(&["initialize-store", "anything"])),
            Err(ParseError::WrongShape)
        );
        assert_eq!(
            parse_args(args(&[
                "release-exact",
                r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE",
                "--confirm-release",
            ])),
            Ok(Operation::Release(ReleaseSpec {
                instance_id: r"USB\VID_1234&PID_5678&MI_00\TEST_DEVICE".to_owned(),
                confirm_release: true,
            }))
        );
        assert_eq!(
            parse_args(args(&["cleanup-owned"])),
            Ok(Operation::CleanupCoordinator)
        );
        assert_eq!(
            parse_args(args(&["cleanup-owned-worker"])),
            Ok(Operation::CleanupWorker)
        );
        assert_eq!(
            parse_args(args(&["cleanup-owned", "anything"])),
            Err(ParseError::WrongShape)
        );
        assert_eq!(
            parse_args(args(&["cleanup-owned-worker", "anything"])),
            Err(ParseError::WrongShape)
        );
    }

    #[test]
    fn coordinator_observation_is_bounded_and_does_not_need_a_kill_primitive() {
        let mut polls = 0;
        let timeout = observe_until(
            Duration::ZERO,
            Duration::from_secs(1),
            || {
                polls += 1;
                Ok::<_, ()>(None::<i32>)
            },
            |_| panic!("a zero deadline must not sleep"),
        )
        .expect("infallible fake observer");
        assert_eq!(timeout, None);
        assert_eq!(polls, 1, "poll once before declaring a timeout");

        let source = include_str!("main.rs");
        assert!(
            !source.contains(&[".ki", "ll()"].concat())
                && !source.contains(&["task", "kill"].concat())
                && !source.contains(&["Terminate", "Process"].concat()),
            "a timed-out mutating worker must be left alive"
        );
    }

    #[test]
    fn coordinator_propagates_the_worker_exit_class() {
        assert_eq!(cleanup_worker_exit_value(EXIT_SUCCESS).0, EXIT_SUCCESS);
        assert_eq!(cleanup_worker_exit_value(EXIT_REFUSED).0, EXIT_REFUSED);
        assert_eq!(cleanup_worker_exit_value(EXIT_INTERNAL).0, EXIT_INTERNAL);
        assert_eq!(cleanup_worker_exit_value(EXIT_RECOVERY).0, EXIT_RECOVERY);
    }

    #[test]
    fn recovery_and_refusal_exit_codes_are_not_collapsed() {
        assert_eq!(
            transaction_exit(&TransactionError::MissingPrepareConsent),
            EXIT_REFUSED
        );
        assert_eq!(
            transaction_exit(&TransactionError::LastKeyboard {
                instance_id: "test".to_owned()
            }),
            EXIT_REFUSED
        );
        assert_eq!(
            transaction_exit(&TransactionError::RebootRequired("test".to_owned())),
            EXIT_RECOVERY
        );
        assert_eq!(
            transaction_exit(&TransactionError::RecoveryRequired("test".to_owned())),
            EXIT_RECOVERY
        );
        assert_eq!(
            transaction_exit(&TransactionError::Verification("test".to_owned())),
            EXIT_INTERNAL
        );
    }

    #[test]
    fn result_json_has_one_machine_readable_shape() {
        let value = mutation_value(
            "prepare-exact",
            MutationResult {
                instance_id: "INSTANCE".to_owned(),
                hardware_id: r"USB\VID_1234&PID_5678&MI_00".to_owned(),
                phase: Phase::Active,
                message: "ready".to_owned(),
                warning: None,
            },
        );
        assert_eq!(value["ok"], true);
        assert_eq!(value["operation"], "prepare-exact");
        assert_eq!(value["phase"], "active");
        assert_eq!(value["instance_id"], "INSTANCE");
        assert!(value["warning"].is_null());
    }

    #[test]
    fn exit_zero_is_reserved_for_the_exact_terminal_phase() {
        let mutation = |phase| MutationResult {
            instance_id: "INSTANCE".to_owned(),
            hardware_id: r"USB\VID_1234&PID_5678&MI_00".to_owned(),
            phase,
            message: "state".to_owned(),
            warning: None,
        };
        assert_eq!(
            verified_mutation_value("prepare-exact", Phase::Active, mutation(Phase::Active)).0,
            EXIT_SUCCESS
        );
        assert_eq!(
            verified_mutation_value("prepare-exact", Phase::Active, mutation(Phase::Prepared)).0,
            EXIT_RECOVERY
        );

        let cleanup = |phase| CleanupResult {
            phase,
            cleaned_receipts: 0,
            disconnected_receipts: 0,
            message: "state".to_owned(),
            warning: None,
        };
        assert_eq!(
            verified_cleanup_value(cleanup(Phase::Released)).0,
            EXIT_SUCCESS
        );
        assert_eq!(
            verified_cleanup_value(cleanup(Phase::RecoveryRequired)).0,
            EXIT_RECOVERY
        );
    }
}
