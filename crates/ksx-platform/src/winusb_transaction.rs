//! Crash-recoverable exact-device WinUSB preparation/release transaction.
//!
//! The engine is dependency-injected at every mutation boundary. Unit tests
//! therefore exercise ordering, races and rollback without touching a real
//! certificate store, driver store or device. [`prepare_exact`] and
//! [`release_exact`] are the narrow production composition roots.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::wdi::{DriverPreparer, PrepareRequest, PreparedPaths, CANONICAL_INF_TEMPLATE};
use super::{
    parse_enum_drivers, ClaimState, PlannedCommand, StoreDriver, Survey, KSX_DEVICE_INTERFACE_GUID,
    SAFE_INF_DEVICE_NAME,
};

pub const JOURNAL_SCHEMA: u32 = 1;
pub const MUTATION_MUTEX_NAME: &str = r"Global\KSX.WinUSB.DriverMutation.v1";
pub const MUTATION_WAIT_MS: u32 = 5 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Preparing,
    Prepared,
    Installed,
    Active,
    Releasing,
    RolledBack,
    Released,
    RecoveryRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub schema: u32,
    pub phase: Phase,
    pub transaction_id: String,
    pub target_instance_id: String,
    pub hardware_id: String,
    pub original_service: Option<String>,
    pub original_inf: Option<String>,
    pub original_inf_name: String,
    pub published_oem_inf: Option<String>,
    pub inf_path: String,
    pub catalog_path: String,
    pub inf_sha256: Option<String>,
    pub catalog_sha256: Option<String>,
    pub certificate_subject: String,
    pub certificate_thumbprint_sha1: Option<String>,
    pub certificate_der_sha256: Option<String>,
    pub affected_instance_ids: Vec<String>,
    pub keyboards_before: usize,
    pub created_unix_seconds: u64,
    pub recovery_reason: Option<String>,
    /// Durable evidence that `/add-driver ... /install` may have run.  This is
    /// set and flushed before invoking pnputil, so recovery never mistakes an
    /// unknown command outcome for a prepare-only transaction.
    #[serde(default)]
    pub driver_mutation_attempted: bool,
    /// `pnputil` returned 3010/1641. Persisted before post-command inventory so
    /// an inventory fault cannot accidentally turn a reboot-pending mutation
    /// into an attempted live rollback.
    #[serde(default)]
    pub reboot_reported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareSpec {
    pub instance_id: String,
    pub confirm_spare_keyboard: bool,
    pub confirm_rebind: bool,
    pub confirm_machine_certificate: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseSpec {
    pub instance_id: String,
    pub confirm_release: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MutationResult {
    pub instance_id: String,
    pub hardware_id: String,
    pub phase: Phase,
    pub message: String,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupResult {
    pub phase: Phase,
    pub cleaned_receipts: usize,
    pub disconnected_receipts: usize,
    pub message: String,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnershipState {
    pub phase: Phase,
    pub instance_id: String,
    pub hardware_id: String,
    pub transaction_id: String,
    pub recovery_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustEvidence {
    pub inf_sha256: String,
    pub catalog_sha256: String,
    pub certificate_subject: String,
    pub certificate_thumbprint_sha1: String,
    pub certificate_der_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedArtifacts {
    pub inf_path: PathBuf,
    pub catalog_path: PathBuf,
    pub inf_name: String,
    pub hardware_id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub interface_number: Option<u8>,
    pub certificate_subject: String,
}

pub trait SurveySource: Send + Sync {
    fn survey(&self) -> Result<Survey, TransactionError>;
}

pub trait DriverInventory: Send + Sync {
    fn enumerate(&self) -> Result<Vec<StoreDriver>, TransactionError>;
}

pub trait TrustVerifier: Send + Sync {
    /// Machine-key containers carrying the provider's fixed ownership prefix.
    /// A prepare starts and ends with this list empty.
    fn owned_private_keys(&self) -> Result<Vec<String>, TransactionError>;
    fn verify(&self, expected: &ExpectedArtifacts) -> Result<TrustEvidence, TransactionError>;
    /// Remove only certificates belonging to this unique transaction. When
    /// evidence is absent (verification itself failed), subject is still the
    /// unique random transaction CN and cleanup must remain exact.
    fn cleanup(
        &self,
        subject: &str,
        thumbprint_sha1: Option<&str>,
        der_sha256: Option<&str>,
    ) -> Result<(), TransactionError>;
    /// Uninstaller-only audit for provider-owned residue which has no
    /// parseable receipt. Production enumerates the fixed key-container and
    /// certificate-subject namespaces; test fakes may keep the default, which
    /// still fails closed on any reported key container.
    fn cleanup_owned_residue(&self) -> Result<(), TransactionError> {
        let keys = self.owned_private_keys()?;
        if keys.is_empty() {
            Ok(())
        } else {
            Err(TransactionError::RecoveryRequired(format!(
                "owned signing-key containers have no recoverable receipt: {keys:?}"
            )))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandResult {
    pub code: i32,
    pub output: String,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, command: &PlannedCommand) -> Result<CommandResult, TransactionError>;
}

pub trait TransactionStore: Send + Sync {
    /// Persist the first journal record atomically. This must finish before the
    /// canonical template is written or libwdi is called.
    fn begin(&self, receipt: &Receipt) -> Result<(), TransactionError>;
    fn update(&self, receipt: &Receipt) -> Result<(), TransactionError>;
    fn write_template(&self, receipt: &Receipt, bytes: &[u8]) -> Result<(), TransactionError>;
    fn active_for(&self, instance_id: &str) -> Result<Option<Receipt>, TransactionError>;
    /// Every durable receipt, including incomplete and terminal records.  An
    /// uninstaller must never equate "not active" with "nothing to recover".
    fn owned_receipts(&self) -> Result<Vec<Receipt>, TransactionError>;
    fn cleanup_artifacts(&self, receipt: &Receipt) -> Result<(), TransactionError>;
}

pub struct Environment<'a> {
    pub surveys: &'a dyn SurveySource,
    pub inventory: &'a dyn DriverInventory,
    pub preparer: &'a dyn DriverPreparer,
    pub trust: &'a dyn TrustVerifier,
    pub runner: &'a dyn CommandRunner,
    pub store: &'a dyn TransactionStore,
}

#[derive(Debug, thiserror::Error)]
pub enum TransactionError {
    #[error("all three confirmations are required before a keyboard can leave the keyboard stack")]
    MissingPrepareConsent,
    #[error("release confirmation is required")]
    MissingReleaseConsent,
    #[error(
        "the target must be an exact USB interface instance id, not a fragment or HID child: {0}"
    )]
    InvalidInstance(String),
    #[error("the exact target is not a claimable USB keyboard: {0}")]
    NotClaimable(String),
    #[error("the exact target is not currently KSX-owned WinUSB: {0}")]
    NotOwned(String),
    #[error("claiming {instance_id} would leave no separately connected keyboard able to type")]
    LastKeyboard { instance_id: String },
    #[error("{instance_id} shares {hardware_id} with present interface(s): {siblings:?}; pnputil installs by hardware id and cannot target only one of them")]
    SharedHardwareId {
        instance_id: String,
        hardware_id: String,
        siblings: Vec<String>,
    },
    #[error("the device changed during preparation: {0}")]
    DeviceChanged(String),
    #[error("unsafe or malformed USB hardware id: {0}")]
    UnsafeHardwareId(String),
    #[error("artifact verification failed: {0}")]
    Verification(String),
    #[error("driver-store inventory is not authoritative: {0}")]
    Inventory(String),
    #[error("{command} failed with exit {code}: {output}")]
    CommandFailed {
        command: String,
        code: i32,
        output: String,
    },
    #[error("the driver operation requires a reboot and is recorded for recovery: {0}")]
    RebootRequired(String),
    #[error("recovery is required before another WinUSB operation: {0}")]
    RecoveryRequired(String),
    #[error("journal failure: {0}")]
    Journal(String),
    #[error("libwdi preparation failed: {0}")]
    Prepare(#[from] super::wdi::PrepareError),
    #[error("Windows operation failed: {0}")]
    Windows(String),
    #[error("WinUSB transactions are supported only by the installed 64-bit Windows helper")]
    Unsupported,
}

fn strict_hardware_parts(hardware_id: &str) -> Result<(u16, u16, Option<u8>), TransactionError> {
    let upper = hardware_id.to_ascii_uppercase();
    let parts: Vec<_> = upper.split('&').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return Err(TransactionError::UnsafeHardwareId(hardware_id.to_owned()));
    }
    let vid = parts[0]
        .strip_prefix(r"USB\VID_")
        .filter(|digits| digits.len() == 4)
        .and_then(|digits| u16::from_str_radix(digits, 16).ok())
        .ok_or_else(|| TransactionError::UnsafeHardwareId(hardware_id.to_owned()))?;
    let pid = parts[1]
        .strip_prefix("PID_")
        .filter(|digits| digits.len() == 4)
        .and_then(|digits| u16::from_str_radix(digits, 16).ok())
        .ok_or_else(|| TransactionError::UnsafeHardwareId(hardware_id.to_owned()))?;
    let interface = match parts.get(2) {
        None => None,
        Some(part) => Some(
            part.strip_prefix("MI_")
                .filter(|digits| digits.len() == 2)
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
                .ok_or_else(|| TransactionError::UnsafeHardwareId(hardware_id.to_owned()))?,
        ),
    };
    Ok((vid, pid, interface))
}

fn validate_exact_instance(instance_id: &str) -> Result<(), TransactionError> {
    let trimmed = instance_id.trim();
    if trimmed != instance_id
        || !trimmed.to_ascii_uppercase().starts_with(r"USB\")
        || trimmed.matches('\\').count() != 2
        || trimmed.contains('*')
        || trimmed.contains('?')
    {
        return Err(TransactionError::InvalidInstance(instance_id.to_owned()));
    }
    Ok(())
}

fn command(args: &[&str], why: &'static str) -> Result<PlannedCommand, TransactionError> {
    let program = super::try_pnputil_path()
        .map_err(|err| TransactionError::Windows(format!("GetSystemDirectoryW failed: {err}")))?;
    Ok(PlannedCommand {
        program: program.display().to_string(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        why,
    })
}

fn run_required(
    runner: &dyn CommandRunner,
    command: &PlannedCommand,
) -> Result<CommandResult, TransactionError> {
    let result = runner.run(command)?;
    if result.code == 3010 || result.code == 1641 {
        return Err(TransactionError::RebootRequired(command.command_line()));
    }
    if result.code != 0 {
        return Err(TransactionError::CommandFailed {
            command: command.command_line(),
            code: result.code,
            output: result.output,
        });
    }
    Ok(result)
}

fn set_recovery(
    store: &dyn TransactionStore,
    receipt: &mut Receipt,
    reason: impl Into<String>,
) -> TransactionError {
    let reason = reason.into();
    receipt.phase = Phase::RecoveryRequired;
    receipt.recovery_reason = Some(reason.clone());
    match store.update(receipt) {
        Ok(()) => TransactionError::RecoveryRequired(reason),
        Err(err) => TransactionError::RecoveryRequired(format!(
            "{reason}; the recovery phase could not be persisted: {err}"
        )),
    }
}

/// Prepare one exact interface. `transaction_id` must be an unpredictable
/// 128-bit lowercase hex value generated by the elevated production wrapper.
pub fn prepare_with(
    env: &Environment<'_>,
    spec: &PrepareSpec,
    transaction_id: &str,
    transaction_dir: &Path,
) -> Result<MutationResult, TransactionError> {
    if !(spec.confirm_spare_keyboard && spec.confirm_rebind && spec.confirm_machine_certificate) {
        return Err(TransactionError::MissingPrepareConsent);
    }
    validate_exact_instance(&spec.instance_id)?;
    if transaction_id.len() != 32
        || !transaction_id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err(TransactionError::Journal(
            "the transaction id is not 128-bit hex".to_owned(),
        ));
    }

    let before = env.surveys.survey()?;
    let target = before
        .resolve_exact_interface(&spec.instance_id)
        .map_err(|err| TransactionError::NotClaimable(err.to_string()))?;
    if target.state != ClaimState::Claimable {
        return Err(TransactionError::NotClaimable(format!(
            "{} is {}",
            target.interface.instance_id,
            target.state.code()
        )));
    }
    let hardware_id = target
        .interface
        .usb_hardware_id()
        .ok_or_else(|| TransactionError::UnsafeHardwareId(target.interface.instance_id.clone()))?;
    let (vendor_id, product_id, interface_number) = strict_hardware_parts(&hardware_id)?;
    let siblings: Vec<_> = before
        .shared_hardware_id_nodes(&target.interface.instance_id, &hardware_id)
        .into_iter()
        .map(|node| node.instance_id.clone())
        .collect();
    if !siblings.is_empty() {
        return Err(TransactionError::SharedHardwareId {
            instance_id: target.interface.instance_id.clone(),
            hardware_id,
            siblings,
        });
    }
    if before.keyboards_without(&target.board) == 0 {
        return Err(TransactionError::LastKeyboard {
            instance_id: target.interface.instance_id.clone(),
        });
    }
    let instance_id = target.interface.instance_id.to_uppercase();
    let original_service = target.interface.service.clone();
    let keyboards_before = before.keyboard_count();
    let inventory_before = env.inventory.enumerate()?;
    let stale_keys = env.trust.owned_private_keys()?;
    if !stale_keys.is_empty() {
        return Err(TransactionError::RecoveryRequired(format!(
            "owned signing-key containers already exist before preparation: {stale_keys:?}"
        )));
    }

    let inf_name = format!("ksx-winusb-{transaction_id}.inf");
    let inf_path = transaction_dir.join(&inf_name);
    let catalog_path = inf_path.with_extension("cat");
    let subject = format!("CN=KSX WinUSB {transaction_id}");
    let mut receipt = Receipt {
        schema: JOURNAL_SCHEMA,
        phase: Phase::Preparing,
        transaction_id: transaction_id.to_owned(),
        target_instance_id: instance_id.clone(),
        hardware_id: hardware_id.clone(),
        original_service,
        original_inf: None,
        original_inf_name: inf_name.clone(),
        published_oem_inf: None,
        inf_path: inf_path.display().to_string(),
        catalog_path: catalog_path.display().to_string(),
        inf_sha256: None,
        catalog_sha256: None,
        certificate_subject: subject.clone(),
        certificate_thumbprint_sha1: None,
        certificate_der_sha256: None,
        affected_instance_ids: vec![instance_id.clone()],
        keyboards_before,
        created_unix_seconds: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        recovery_reason: None,
        driver_mutation_attempted: false,
        reboot_reported: false,
    };

    // The first durable write precedes even the input template. If the process
    // dies at any later instruction, recovery knows which unique cert subject,
    // files, hardware id and target it owns.
    env.store.begin(&receipt)?;

    let outcome = (|| -> Result<MutationResult, TransactionError> {
        env.store
            .write_template(&receipt, CANONICAL_INF_TEMPLATE.as_bytes())?;
        let prepared = env.preparer.prepare(&PrepareRequest {
            output_dir: transaction_dir.to_path_buf(),
            inf_path: inf_path.clone(),
            instance_id: instance_id.clone(),
            hardware_id: hardware_id.clone(),
            vendor_id,
            product_id,
            interface_number,
            certificate_subject: subject.clone(),
        })?;
        if prepared
            != (PreparedPaths {
                inf_path: inf_path.clone(),
                catalog_path: catalog_path.clone(),
            })
        {
            return Err(TransactionError::Verification(
                "the provider returned paths outside its transaction directory".to_owned(),
            ));
        }

        let evidence = env.trust.verify(&ExpectedArtifacts {
            inf_path: inf_path.clone(),
            catalog_path: catalog_path.clone(),
            inf_name: inf_name.clone(),
            hardware_id: hardware_id.clone(),
            vendor_id,
            product_id,
            interface_number,
            certificate_subject: subject.clone(),
        })?;
        receipt.inf_sha256 = Some(evidence.inf_sha256);
        receipt.catalog_sha256 = Some(evidence.catalog_sha256);
        receipt.certificate_thumbprint_sha1 = Some(evidence.certificate_thumbprint_sha1);
        receipt.certificate_der_sha256 = Some(evidence.certificate_der_sha256);
        receipt.phase = Phase::Prepared;
        env.store.update(&receipt)?;

        // Re-survey at the last point before pnputil. A UAC delay,
        // unplug/replug, or identical arrival cannot carry the earlier
        // authorization forward.
        let fresh = env.surveys.survey()?;
        let fresh_target = fresh
            .resolve_exact_interface(&instance_id)
            .map_err(|err| TransactionError::DeviceChanged(err.to_string()))?;
        if fresh_target.state != ClaimState::Claimable
            || fresh_target.interface.usb_hardware_id().as_deref() != Some(hardware_id.as_str())
        {
            return Err(TransactionError::DeviceChanged(
                "the exact target or its binding changed".to_owned(),
            ));
        }
        let raced: Vec<_> = fresh
            .shared_hardware_id_nodes(&instance_id, &hardware_id)
            .into_iter()
            .map(|node| node.instance_id.clone())
            .collect();
        if !raced.is_empty() {
            return Err(TransactionError::SharedHardwareId {
                instance_id: instance_id.clone(),
                hardware_id: hardware_id.clone(),
                siblings: raced,
            });
        }

        let add = command(
            &["/add-driver", &receipt.inf_path, "/install"],
            "stage and install the verified KSX package",
        )?;
        // This durable boundary is deliberately before `runner.run`: after it
        // succeeds every runner error is treated as an unknown mutation.
        receipt.driver_mutation_attempted = true;
        env.store.update(&receipt)?;
        let add_result = env.runner.run(&add)?;
        if add_result.code == 3010 || add_result.code == 1641 {
            receipt.reboot_reported = true;
            env.store.update(&receipt)?;
        }

        // Inventory before interpreting the exit code. pnputil may publish a
        // package on failure or reboot-required, and recovery needs its exact
        // OEM name before returning either classification.
        let inventory_after = env.inventory.enumerate()?;
        let mut added: Vec<_> = inventory_after
            .iter()
            .filter(|driver| driver.original_name.eq_ignore_ascii_case(&inf_name))
            .filter(|driver| {
                !inventory_before.iter().any(|old| {
                    old.published_name
                        .eq_ignore_ascii_case(&driver.published_name)
                })
            })
            .collect();
        added.sort_by(|a, b| a.published_name.cmp(&b.published_name));
        if added.len() != 1 {
            return Err(TransactionError::Inventory(format!(
                "could not identify exactly one newly published package for {inf_name}; found {}",
                added.len()
            )));
        }
        receipt.published_oem_inf = Some(added[0].published_name.clone());
        receipt.phase = Phase::Installed;
        env.store.update(&receipt)?;

        if add_result.code == 3010 || add_result.code == 1641 {
            return Err(TransactionError::RebootRequired(format!(
                "{} reported reboot required after publishing {}",
                add.command_line(),
                receipt
                    .published_oem_inf
                    .as_deref()
                    .unwrap_or("the package")
            )));
        }
        if add_result.code != 0 {
            return Err(TransactionError::CommandFailed {
                command: add.command_line(),
                code: add_result.code,
                output: add_result.output,
            });
        }
        let scan = command(&["/scan-devices"], "settle the exact verified rebind")?;
        run_required(env.runner, &scan)?;

        let after = env.surveys.survey()?;
        let rebound = after
            .resolve_exact_interface(&receipt.target_instance_id)
            .map_err(|err| TransactionError::DeviceChanged(err.to_string()))?;
        let unexpected: Vec<_> = after
            .present_usb
            .iter()
            .filter(|node| {
                node.usb_hardware_id()
                    .is_some_and(|id| id.eq_ignore_ascii_case(&receipt.hardware_id))
                    && !node
                        .instance_id
                        .eq_ignore_ascii_case(&receipt.target_instance_id)
                    && node.service_is(super::WINUSB_SERVICE)
            })
            .map(|node| node.instance_id.clone())
            .collect();
        if rebound.state != ClaimState::Claimed || !unexpected.is_empty() {
            return Err(TransactionError::DeviceChanged(format!(
                "post-install survey did not prove only the exact target is WinUSB (target={}, unexpected={unexpected:?})",
                rebound.state.code()
            )));
        }
        receipt.phase = Phase::Active;
        env.store.update(&receipt)?;
        Ok(MutationResult {
            instance_id: receipt.target_instance_id.clone(),
            hardware_id: receipt.hardware_id.clone(),
            phase: Phase::Active,
            message: "prepared this exact keyboard for WinUSB; the live binding was verified"
                .to_owned(),
            warning: Some(
                "a later identical device can also match this hardware-id package; KSX will refuse while two are present"
                    .to_owned(),
            ),
        })
    })();

    match outcome {
        Ok(result) => Ok(result),
        Err(failure) => Err(compensate_prepare_failure(
            env,
            &mut receipt,
            &inventory_before,
            failure,
        )),
    }
}

fn rollback_uninstalled(
    env: &Environment<'_>,
    receipt: &mut Receipt,
) -> Result<(), TransactionError> {
    env.trust.cleanup(
        &receipt.certificate_subject,
        receipt.certificate_thumbprint_sha1.as_deref(),
        receipt.certificate_der_sha256.as_deref(),
    )?;
    let remaining = env.trust.owned_private_keys()?;
    if !remaining.is_empty() {
        return Err(TransactionError::Verification(format!(
            "owned signing-key containers remain after cleanup: {remaining:?}"
        )));
    }
    env.store.cleanup_artifacts(receipt)?;
    receipt.phase = Phase::RolledBack;
    receipt.recovery_reason = None;
    env.store.update(receipt)
}

fn compensate_prepare_failure(
    env: &Environment<'_>,
    receipt: &mut Receipt,
    inventory_before: &[StoreDriver],
    failure: TransactionError,
) -> TransactionError {
    let trigger = failure.to_string();
    if receipt.reboot_reported || matches!(failure, TransactionError::RebootRequired(_)) {
        // Inventory is still attempted so the exact OEM identity is preserved,
        // but a reboot-pending device stack is never driven through live
        // remove/delete/scan rollback commands.
        match env.inventory.enumerate() {
            Ok(inventory) => {
                let mut packages: Vec<_> = inventory
                    .iter()
                    .filter(|driver| {
                        driver
                            .original_name
                            .eq_ignore_ascii_case(&receipt.original_inf_name)
                    })
                    .filter(|driver| {
                        !inventory_before.iter().any(|old| {
                            old.published_name
                                .eq_ignore_ascii_case(&driver.published_name)
                        })
                    })
                    .collect();
                packages.sort_by(|a, b| a.published_name.cmp(&b.published_name));
                if let [package] = packages.as_slice() {
                    receipt.published_oem_inf = Some(package.published_name.clone());
                    receipt.phase = Phase::Installed;
                    let _ = env.store.update(receipt);
                } else {
                    return set_recovery(
                        env.store,
                        receipt,
                        format!(
                            "{trigger}; reboot was reported and exact OEM inventory found {} candidates",
                            packages.len()
                        ),
                    );
                }
            }
            Err(err) => {
                return set_recovery(
                    env.store,
                    receipt,
                    format!("{trigger}; reboot was reported and OEM inventory failed: {err}"),
                )
            }
        }
        return set_recovery(env.store, receipt, trigger);
    }

    if !receipt.driver_mutation_attempted {
        return match rollback_uninstalled(env, receipt) {
            Ok(()) => failure,
            Err(cleanup) => set_recovery(
                env.store,
                receipt,
                format!("{trigger}; prepare-only compensation failed: {cleanup}"),
            ),
        };
    }

    // The runner boundary was crossed. Re-inventory even when the original
    // inventory call failed; zero packages can be proven safe only together
    // with a fresh survey showing no same-HWID WinUSB binding.
    let inventory = match env.inventory.enumerate() {
        Ok(inventory) => inventory,
        Err(err) => {
            return set_recovery(
                env.store,
                receipt,
                format!("{trigger}; post-mutation inventory failed: {err}"),
            )
        }
    };
    let mut candidates: Vec<_> = inventory
        .iter()
        .filter(|driver| {
            driver
                .original_name
                .eq_ignore_ascii_case(&receipt.original_inf_name)
        })
        .filter(|driver| {
            !inventory_before.iter().any(|old| {
                old.published_name
                    .eq_ignore_ascii_case(&driver.published_name)
            })
        })
        .collect();
    candidates.sort_by(|a, b| a.published_name.cmp(&b.published_name));
    if let Some(recorded) = receipt.published_oem_inf.as_deref() {
        candidates.retain(|driver| driver.published_name.eq_ignore_ascii_case(recorded));
    }
    match candidates.as_slice() {
        [driver] => {
            receipt.published_oem_inf = Some(driver.published_name.clone());
            receipt.phase = Phase::Installed;
            // Best effort here: rollback still has the authoritative in-memory
            // OEM identity. Its terminal/recovery update will retry durability.
            let _ = env.store.update(receipt);
            match rollback_installed(env, receipt, &trigger) {
                Ok(()) => failure,
                Err(recovery) => recovery,
            }
        }
        [] => {
            let survey = match env.surveys.survey() {
                Ok(survey) => survey,
                Err(err) => {
                    return set_recovery(
                        env.store,
                        receipt,
                        format!(
                        "{trigger}; package absence could not be paired with a live survey: {err}"
                    ),
                    )
                }
            };
            let bound = survey.present_usb.iter().any(|node| {
                node.usb_hardware_id()
                    .is_some_and(|id| id.eq_ignore_ascii_case(&receipt.hardware_id))
                    && node.service_is(super::WINUSB_SERVICE)
            });
            if bound {
                return set_recovery(
                    env.store,
                    receipt,
                    format!("{trigger}; a same-hardware-id WinUSB binding exists but no exact package could be identified"),
                );
            }
            match rollback_uninstalled(env, receipt) {
                Ok(()) => failure,
                Err(cleanup) => set_recovery(
                    env.store,
                    receipt,
                    format!(
                        "{trigger}; compensation after proven package absence failed: {cleanup}"
                    ),
                ),
            }
        }
        many => set_recovery(
            env.store,
            receipt,
            format!(
                "{trigger}; {} exact-name packages appeared after the mutation boundary",
                many.len()
            ),
        ),
    }
}

fn rollback_installed(
    env: &Environment<'_>,
    receipt: &mut Receipt,
    trigger: &str,
) -> Result<(), TransactionError> {
    match rollback_installed_inner(env, receipt, trigger) {
        Ok(()) => Ok(()),
        // A `RecoveryRequired` may arrive already persisted — that is what
        // `set_recovery` does, and its reason is more specific than anything
        // this wrapper could add, so pass it through untouched.
        //
        // But it may also be minted directly, without the store ever being
        // told: `delete_matching` and `delete_owned_private_keys` construct it
        // that way. Those used to propagate here and return, leaving the
        // receipt exactly as `release_with` wrote it — `Releasing`. The
        // backend reports success only on `Released` and recovery only on
        // `RecoveryRequired`, so a stuck `Releasing` matched neither and every
        // such release told the user it had failed AFTER the driver was
        // already rebound. Four receipts on the reporting machine, all with a
        // keyboard that types fine.
        //
        // The phase, not the error type, is the record. Persist it here when
        // nobody else has.
        Err(TransactionError::RecoveryRequired(reason)) => {
            if receipt.phase == Phase::RecoveryRequired {
                Err(TransactionError::RecoveryRequired(reason))
            } else {
                Err(set_recovery(env.store, receipt, reason))
            }
        }
        Err(err) => Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger} did not complete: {err}"),
        )),
    }
}

fn rollback_installed_inner(
    env: &Environment<'_>,
    receipt: &mut Receipt,
    trigger: &str,
) -> Result<(), TransactionError> {
    // Remove every currently present devnode with the owned hardware id that
    // ended up on WinUSB. This contains a same-HWID arrival race before the
    // package is deleted.
    let survey = env.surveys.survey()?;
    let mut affected: Vec<_> = survey
        .present_usb
        .iter()
        .filter(|node| {
            node.usb_hardware_id()
                .is_some_and(|id| id.eq_ignore_ascii_case(&receipt.hardware_id))
                && node.service_is(super::WINUSB_SERVICE)
        })
        .map(|node| node.instance_id.to_uppercase())
        .collect();
    if affected.is_empty() {
        affected.push(receipt.target_instance_id.clone());
    }
    affected.sort();
    affected.dedup();
    receipt.affected_instance_ids = affected.clone();
    env.store.update(receipt)?;
    for instance in &affected {
        let remove = command(
            &["/remove-device", instance],
            "remove an affected devnode before deleting the owned package",
        )?;
        if let Err(err) = run_required(env.runner, &remove) {
            return Err(set_recovery(
                env.store,
                receipt,
                format!("rollback after {trigger}: {err}"),
            ));
        }
    }
    let Some(oem) = receipt.published_oem_inf.clone() else {
        return Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger}: no exact OEM package was recorded"),
        ));
    };
    let delete = command(
        &["/delete-driver", &oem, "/uninstall", "/force"],
        "delete only the package recorded by this transaction",
    )?;
    if let Err(err) = run_required(env.runner, &delete) {
        return Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger}: {err}"),
        ));
    }
    let inventory = env.inventory.enumerate()?;
    if inventory.iter().any(|driver| {
        driver.published_name.eq_ignore_ascii_case(&oem)
            || driver
                .original_name
                .eq_ignore_ascii_case(&receipt.original_inf_name)
    }) {
        return Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger}: package absence was not confirmed"),
        ));
    }
    let scan = command(&["/scan-devices"], "restore the in-box keyboard binding")?;
    if let Err(err) = run_required(env.runner, &scan) {
        return Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger}: {err}"),
        ));
    }
    let restored = env.surveys.survey()?;
    let target = restored
        .resolve_exact_interface(&receipt.target_instance_id)
        .map_err(|err| {
            set_recovery(
                env.store,
                receipt,
                format!("rollback after {trigger}: target did not return: {err}"),
            )
        })?;
    if target.state == ClaimState::Claimed || restored.keyboard_count() < receipt.keyboards_before {
        return Err(set_recovery(
            env.store,
            receipt,
            format!("rollback after {trigger}: keyboard restoration was not proven"),
        ));
    }
    env.trust.cleanup(
        &receipt.certificate_subject,
        receipt.certificate_thumbprint_sha1.as_deref(),
        receipt.certificate_der_sha256.as_deref(),
    )?;
    let remaining_keys = env.trust.owned_private_keys()?;
    if !remaining_keys.is_empty() {
        return Err(TransactionError::Verification(format!(
            "owned private-key containers remain after rollback: {remaining_keys:?}"
        )));
    }
    env.store.cleanup_artifacts(receipt)?;
    receipt.phase = Phase::RolledBack;
    receipt.recovery_reason = None;
    env.store.update(receipt)
}

pub fn release_with(
    env: &Environment<'_>,
    spec: &ReleaseSpec,
) -> Result<MutationResult, TransactionError> {
    if !spec.confirm_release {
        return Err(TransactionError::MissingReleaseConsent);
    }
    validate_exact_instance(&spec.instance_id)?;
    let mut receipt = env
        .store
        .active_for(&spec.instance_id)?
        .ok_or_else(|| TransactionError::NotOwned(spec.instance_id.clone()))?;
    if receipt.schema != JOURNAL_SCHEMA || receipt.phase != Phase::Active {
        return Err(TransactionError::NotOwned(format!(
            "{} has no active schema-{JOURNAL_SCHEMA} KSX receipt",
            spec.instance_id
        )));
    }
    let live = env.surveys.survey()?;
    let target = live
        .resolve_exact_interface(&spec.instance_id)
        .map_err(|err| TransactionError::DeviceChanged(err.to_string()))?;
    if target.interface.usb_hardware_id().as_deref() != Some(receipt.hardware_id.as_str()) {
        return Err(TransactionError::DeviceChanged(
            "the receipt hardware id does not match the exact live target".to_owned(),
        ));
    }
    let oem = receipt
        .published_oem_inf
        .clone()
        .ok_or_else(|| TransactionError::NotOwned("receipt has no published package".to_owned()))?;
    let inventory = env.inventory.enumerate()?;
    let matching: Vec<_> = inventory
        .iter()
        .filter(|driver| {
            driver.published_name.eq_ignore_ascii_case(&oem)
                && driver
                    .original_name
                    .eq_ignore_ascii_case(&receipt.original_inf_name)
        })
        .collect();
    if matching.len() != 1 {
        return Err(TransactionError::NotOwned(
            "the recorded OEM package identity could not be proven".to_owned(),
        ));
    }
    receipt.phase = Phase::Releasing;
    env.store.update(&receipt)?;
    rollback_installed(env, &mut receipt, "requested release")?;
    receipt.phase = Phase::Released;
    env.store.update(&receipt)?;
    Ok(MutationResult {
        instance_id: receipt.target_instance_id,
        hardware_id: receipt.hardware_id,
        phase: Phase::Released,
        message: "released this exact KSX-owned interface back to the keyboard stack".to_owned(),
        warning: None,
    })
}

/// Audit and recover every KSX receipt, including incomplete, recovery, and
/// terminal records. Used by the elevated uninstaller; there is no
/// caller-provided path, package name, certificate identity or device id.
pub fn cleanup_with(env: &Environment<'_>) -> Result<CleanupResult, TransactionError> {
    let receipts = env.store.owned_receipts().map_err(|err| {
        TransactionError::RecoveryRequired(format!(
            "uninstaller could not enumerate every protected WinUSB receipt: {err}"
        ))
    })?;
    let mut cleaned = 0usize;
    let mut disconnected = 0usize;
    for mut receipt in receipts {
        if receipt.schema != JOURNAL_SCHEMA {
            let schema = receipt.schema;
            return Err(set_recovery(
                env.store,
                &mut receipt,
                format!("uninstaller found unsupported receipt schema {}", schema),
            ));
        }
        if cleanup_receipt(env, &mut receipt)? {
            disconnected += 1;
        }
        cleaned += 1;
    }
    env.trust.cleanup_owned_residue()?;
    let remaining_keys = env.trust.owned_private_keys()?;
    if !remaining_keys.is_empty() {
        return Err(TransactionError::RecoveryRequired(format!(
            "owned signing-key containers remain after uninstall cleanup: {remaining_keys:?}"
        )));
    }
    Ok(CleanupResult {
        phase: Phase::Released,
        cleaned_receipts: cleaned,
        disconnected_receipts: disconnected,
        message: format!(
            "cleaned {cleaned} KSX-owned WinUSB receipt(s); {disconnected} target(s) were disconnected"
        ),
        warning: None,
    })
}

fn cleanup_receipt(env: &Environment<'_>, receipt: &mut Receipt) -> Result<bool, TransactionError> {
    match cleanup_receipt_inner(env, receipt) {
        Ok(disconnected) => Ok(disconnected),
        Err(err @ TransactionError::RecoveryRequired(_)) => Err(err),
        Err(err) => Err(set_recovery(
            env.store,
            receipt,
            format!("uninstall recovery did not complete: {err}"),
        )),
    }
}

fn cleanup_receipt_inner(
    env: &Environment<'_>,
    receipt: &mut Receipt,
) -> Result<bool, TransactionError> {
    let before = env.surveys.survey()?;
    let disconnected = before
        .resolve_exact_interface(&receipt.target_instance_id)
        .is_err();
    let mut affected: Vec<_> = before
        .present_usb
        .iter()
        .filter(|node| {
            node.usb_hardware_id()
                .is_some_and(|id| id.eq_ignore_ascii_case(&receipt.hardware_id))
                && node.service_is(super::WINUSB_SERVICE)
        })
        .map(|node| node.instance_id.to_uppercase())
        .collect();
    affected.sort();
    affected.dedup();

    let inventory = env.inventory.enumerate()?;
    let by_original: Vec<_> = inventory
        .iter()
        .filter(|driver| {
            driver
                .original_name
                .eq_ignore_ascii_case(&receipt.original_inf_name)
        })
        .collect();
    let package = if let Some(recorded) = receipt.published_oem_inf.as_deref() {
        let same_published: Vec<_> = inventory
            .iter()
            .filter(|driver| driver.published_name.eq_ignore_ascii_case(recorded))
            .collect();
        let exact: Vec<_> = same_published
            .iter()
            .copied()
            .filter(|driver| {
                driver
                    .original_name
                    .eq_ignore_ascii_case(&receipt.original_inf_name)
            })
            .collect();
        match (same_published.len(), exact.len(), by_original.len()) {
            (0, 0, 0) => None,
            (1, 1, 1) => Some(recorded.to_owned()),
            _ => {
                return Err(TransactionError::Inventory(format!(
                "recorded package {recorded} no longer has one exact original/published identity"
            )))
            }
        }
    } else {
        match by_original.as_slice() {
            [] => None,
            [driver] => Some(driver.published_name.clone()),
            many => {
                return Err(TransactionError::Inventory(format!(
                    "{} packages claim the transaction's unique original INF name",
                    many.len()
                )))
            }
        }
    };
    if package.is_none() && !affected.is_empty() {
        return Err(TransactionError::Inventory(
            "same-hardware-id WinUSB devnodes remain but no exact owned package can be identified"
                .to_owned(),
        ));
    }

    receipt.published_oem_inf = package.clone();
    receipt.affected_instance_ids = affected.clone();
    receipt.phase = Phase::Releasing;
    receipt.recovery_reason = None;
    env.store.update(receipt)?;

    for instance in &affected {
        let remove = command(
            &["/remove-device", instance],
            "remove an exact affected devnode before owned package cleanup",
        )?;
        run_required(env.runner, &remove)?;
    }
    if let Some(oem) = package.as_deref() {
        let delete = command(
            &["/delete-driver", oem, "/uninstall", "/force"],
            "delete the exact package recorded or recovered from this receipt",
        )?;
        run_required(env.runner, &delete)?;
    }

    let after_inventory = env.inventory.enumerate()?;
    if after_inventory.iter().any(|driver| {
        package
            .as_deref()
            .is_some_and(|oem| driver.published_name.eq_ignore_ascii_case(oem))
            || driver
                .original_name
                .eq_ignore_ascii_case(&receipt.original_inf_name)
    }) {
        return Err(TransactionError::Inventory(
            "owned package absence was not confirmed; trust and files were left intact".to_owned(),
        ));
    }

    if package.is_some() || !affected.is_empty() {
        // Only after package absence: reconnect can no longer select the KSX
        // package, so settling present nodes is safe.
        let scan = command(&["/scan-devices"], "settle remaining present devnodes")?;
        run_required(env.runner, &scan)?;
        let after = env.surveys.survey()?;
        let still_bound: Vec<_> = after
            .present_usb
            .iter()
            .filter(|node| {
                node.usb_hardware_id()
                    .is_some_and(|id| id.eq_ignore_ascii_case(&receipt.hardware_id))
                    && node.service_is(super::WINUSB_SERVICE)
            })
            .map(|node| node.instance_id.clone())
            .collect();
        if !still_bound.is_empty() {
            return Err(TransactionError::DeviceChanged(format!(
                "WinUSB devnodes remain after exact package deletion: {still_bound:?}"
            )));
        }
    }

    env.trust.cleanup(
        &receipt.certificate_subject,
        receipt.certificate_thumbprint_sha1.as_deref(),
        receipt.certificate_der_sha256.as_deref(),
    )?;
    let keys = env.trust.owned_private_keys()?;
    if !keys.is_empty() {
        return Err(TransactionError::Verification(format!(
            "owned private-key containers remain: {keys:?}"
        )));
    }
    env.store.cleanup_artifacts(receipt)?;
    receipt.phase = Phase::Released;
    receipt.recovery_reason = None;
    env.store.update(receipt)?;
    Ok(disconnected)
}

// ---------------------------------------------------------------------------
// Production Windows composition
// ---------------------------------------------------------------------------

#[cfg(windows)]
struct SystemSurvey;

#[cfg(windows)]
impl SurveySource for SystemSurvey {
    fn survey(&self) -> Result<Survey, TransactionError> {
        Ok(super::survey())
    }
}

#[cfg(windows)]
struct PnPUtilRunner;

#[cfg(windows)]
impl CommandRunner for PnPUtilRunner {
    fn run(&self, command: &PlannedCommand) -> Result<CommandResult, TransactionError> {
        let expected =
            super::try_pnputil_path().map_err(|err| TransactionError::Windows(err.to_string()))?;
        if !Path::new(&command.program).eq(&expected) {
            return Err(TransactionError::Windows(format!(
                "refused non-System32 command {}",
                command.program
            )));
        }
        let output =
            crate::process::no_window(std::process::Command::new(&expected).args(&command.args))
                .output()
                .map_err(|err| {
                    TransactionError::Windows(format!("{}: {err}", command.command_line()))
                })?;
        let mut text = crate::autostart::decode_console_output(&output.stdout);
        let stderr = crate::autostart::decode_console_output(&output.stderr);
        if !stderr.trim().is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&stderr);
        }
        Ok(CommandResult {
            code: output.status.code().unwrap_or(-1),
            output: text,
        })
    }
}

#[cfg(windows)]
struct PnPUtilInventory<'a> {
    runner: &'a dyn CommandRunner,
}

#[cfg(windows)]
impl DriverInventory for PnPUtilInventory<'_> {
    fn enumerate(&self) -> Result<Vec<StoreDriver>, TransactionError> {
        let enumerate = command(&["/enum-drivers"], "inventory the driver store")?;
        let result = run_required(self.runner, &enumerate)?;
        Ok(parse_enum_drivers(&result.output))
    }
}

#[cfg(windows)]
struct MutationGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl MutationGuard {
    fn acquire() -> Result<Self, TransactionError> {
        use windows_sys::Win32::Foundation::{
            ERROR_ALREADY_EXISTS, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        let name: Vec<u16> = MUTATION_MUTEX_NAME
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: null security attributes, valid NUL-terminated fixed name.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(TransactionError::Windows(format!(
                "CreateMutexW: {}",
                std::io::Error::last_os_error()
            )));
        }
        // SAFETY: handle is a mutex and remains owned by the guard.
        let wait = unsafe { WaitForSingleObject(handle, MUTATION_WAIT_MS) };
        if wait == WAIT_TIMEOUT {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(TransactionError::RecoveryRequired(
                "another WinUSB mutation still owns the global lock after five minutes; its durable receipt must be inspected before retrying"
                    .to_owned(),
            ));
        }
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(TransactionError::Windows(format!(
                "WaitForSingleObject({wait:#x})"
            )));
        }
        let _ = ERROR_ALREADY_EXISTS; // Creation/open both serialize identically.
        Ok(Self(handle))
    }
}

#[cfg(windows)]
impl Drop for MutationGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        // SAFETY: this thread acquired the mutex above; close after release.
        unsafe {
            ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn transaction_id() -> Result<String, TransactionError> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };
    let mut bytes = [0u8; 16];
    // SAFETY: null algorithm with USE_SYSTEM_PREFERRED_RNG is the documented
    // system RNG form; the 16-byte output buffer is valid.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(TransactionError::Windows(format!(
            "BCryptGenRandom failed ({status:#x})"
        )));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(windows)]
fn known_program_data() -> Result<PathBuf, TransactionError> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath};
    let mut raw = std::ptr::null_mut();
    // SAFETY: output pointer is valid; fixed known-folder GUID, default flags,
    // current token. Shell allocates `raw` with the COM task allocator.
    let status =
        unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, std::ptr::null_mut(), &mut raw) };
    if status < 0 || raw.is_null() {
        return Err(TransactionError::Windows(format!(
            "SHGetKnownFolderPath(FOLDERID_ProgramData) failed ({status:#x})"
        )));
    }
    let len = unsafe {
        let mut len = 0usize;
        while *raw.add(len) != 0 {
            len += 1;
        }
        len
    };
    let path = PathBuf::from(std::ffi::OsString::from_wide(unsafe {
        std::slice::from_raw_parts(raw, len)
    }));
    unsafe { CoTaskMemFree(raw.cast()) };
    Ok(path)
}

/// The one recovery-store ACL KSX creates and accepts.
///
/// SYSTEM and Builtin Administrators may mutate; Builtin Users may only
/// read/list/execute. `P` disables inheritance, while `OI`/`CI` passes the same
/// policy to receipts and transaction artifacts created later.
///
/// **The Users mask is written as specific rights, and must stay that way.**
/// `0x1200a9` is FILE_GENERIC_READ|FILE_GENERIC_EXECUTE, the identical
/// permission the readable `GRGX` asks for — but Windows MAPS generic rights
/// when it stores an ACL on an object, and splits an inheritable generic ACE
/// into two: an effective entry for this object plus an inherit-only entry
/// keeping the generic bits. `GRGX` therefore went in as three ACEs and came
/// back as four:
///
/// ```text
/// written  O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)
/// stored   O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)
/// ```
///
/// `verify_exact_dacl` compares the ACL byte for byte, so it could never match
/// — including on directories this code had just created itself. Every install
/// died at `initializer exit code 3`, and nothing caught it because a
/// successful `initialize-store` had never once been executed, here or in CI.
/// `the_exact_store_dacl_survives_a_round_trip_through_windows` now runs that
/// round trip in milliseconds, without elevation.
#[cfg(windows)]
const STORE_DIRECTORY_SDDL: &str =
    "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)";

#[cfg(windows)]
struct SecurityDescriptor(*mut core::ffi::c_void);

#[cfg(windows)]
impl SecurityDescriptor {
    fn exact_store() -> Result<Self, TransactionError> {
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        let wide: Vec<u16> = STORE_DIRECTORY_SDDL
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: fixed NUL-terminated SDDL and valid output pointer. LocalFree
        // owns the returned descriptor on success.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
            || descriptor.is_null()
        {
            return Err(TransactionError::Windows(format!(
                "building the fixed recovery-store ACL failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self(descriptor))
    }

    fn dacl(&self) -> Result<*mut windows_sys::Win32::Security::ACL, TransactionError> {
        use windows_sys::Win32::Security::{GetSecurityDescriptorDacl, ACL};
        let mut present = 0i32;
        let mut defaulted = 0i32;
        let mut dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: descriptor is a valid self-relative descriptor returned by
        // ConvertStringSecurityDescriptorToSecurityDescriptorW.
        if unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) }
            == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(TransactionError::Windows(
                "the fixed recovery-store security descriptor has no DACL".to_owned(),
            ));
        }
        Ok(dacl)
    }

    fn attributes(&self) -> windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>()
                as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

#[cfg(windows)]
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by LocalAlloc inside the conversion API.
        unsafe { windows_sys::Win32::Foundation::LocalFree(self.0) };
    }
}

#[cfg(windows)]
struct ProtectedDirectory {
    handle: windows_sys::Win32::Foundation::HANDLE,
    path: PathBuf,
}

#[cfg(windows)]
impl ProtectedDirectory {
    fn open(path: &Path, write_dacl: bool) -> Result<Self, TransactionError> {
        use std::os::windows::ffi::OsStrExt as _;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
            OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
        };
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let access = FILE_LIST_DIRECTORY
            | FILE_READ_ATTRIBUTES
            | READ_CONTROL
            | if write_dacl { WRITE_DAC } else { 0 };
        // Deliberately omit FILE_SHARE_DELETE. Holding every ancestor handle
        // prevents a name swap while descendants are inspected/created.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(TransactionError::Journal(format!(
                "opening protected directory {} failed: {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
        let directory = Self {
            handle,
            path: path.to_path_buf(),
        };
        directory.verify_non_reparse_directory()?;
        directory.verify_path_identity()?;
        Ok(directory)
    }

    fn verify_non_reparse_directory(&self) -> Result<(), TransactionError> {
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the handle is live and `info` is writable.
        if unsafe { GetFileInformationByHandle(self.handle, &mut info) } == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(TransactionError::Journal(format!(
                "{} is not an ordinary non-reparse directory",
                self.path.display()
            )));
        }
        Ok(())
    }

    fn verify_path_identity(&self) -> Result<(), TransactionError> {
        use std::os::windows::ffi::OsStringExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
        };
        let mut buffer = vec![0u16; 512];
        let final_path = loop {
            // SAFETY: buffer is writable for its advertised UTF-16 length.
            let len = unsafe {
                GetFinalPathNameByHandleW(
                    self.handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if len == 0 {
                return Err(TransactionError::Journal(format!(
                    "reading the opened identity of {} failed: {}",
                    self.path.display(),
                    std::io::Error::last_os_error()
                )));
            }
            if len < buffer.len() {
                break PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]));
            }
            buffer.resize(len + 1, 0);
        };
        let expected = self.path.canonicalize().map_err(|err| {
            TransactionError::Journal(format!(
                "canonicalizing {} failed: {err}",
                self.path.display()
            ))
        })?;
        let normalize = |path: &Path| {
            let text = path.as_os_str().to_string_lossy();
            text.strip_prefix(r"\\?\UNC\")
                .map(|rest| format!(r"\\{rest}"))
                .or_else(|| text.strip_prefix(r"\\?\").map(str::to_owned))
                .unwrap_or_else(|| text.into_owned())
        };
        if !normalize(&final_path).eq_ignore_ascii_case(&normalize(&expected)) {
            return Err(TransactionError::Journal(format!(
                "opened directory identity {} does not equal {}",
                final_path.display(),
                expected.display()
            )));
        }
        Ok(())
    }

    fn apply_exact_dacl(&self, expected: &SecurityDescriptor) -> Result<(), TransactionError> {
        use windows_sys::Win32::Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        };
        let dacl = expected.dacl()?;
        // SAFETY: handle was opened with WRITE_DAC and the expected DACL lives
        // for the duration of the call. Owner/group/SACL are intentionally
        // unchanged.
        let status = unsafe {
            SetSecurityInfo(
                self.handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null(),
            )
        };
        if status != 0 {
            return Err(TransactionError::Journal(format!(
                "setting the exact protected ACL on {} failed ({status})",
                self.path.display()
            )));
        }
        self.verify_exact_dacl(expected)
    }

    fn verify_exact_dacl(&self, expected: &SecurityDescriptor) -> Result<(), TransactionError> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorControl, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED,
        };
        let mut actual_dacl: *mut ACL = std::ptr::null_mut();
        let mut actual_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: output pointers are valid and descriptor is freed below.
        let status = unsafe {
            GetSecurityInfo(
                self.handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut actual_dacl,
                std::ptr::null_mut(),
                &mut actual_descriptor,
            )
        };
        if status != 0 || actual_descriptor.is_null() || actual_dacl.is_null() {
            if !actual_descriptor.is_null() {
                unsafe { LocalFree(actual_descriptor) };
            }
            return Err(TransactionError::Journal(format!(
                "reading the handle ACL for {} failed ({status})",
                self.path.display()
            )));
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        let protected =
            unsafe { GetSecurityDescriptorControl(actual_descriptor, &mut control, &mut revision) }
                != 0
                && control & SE_DACL_PROTECTED != 0;
        let expected_dacl = expected.dacl()?;
        let actual_size = unsafe { (*actual_dacl).AclSize as usize };
        let expected_size = unsafe { (*expected_dacl).AclSize as usize };
        let same = actual_size == expected_size
            && unsafe {
                std::slice::from_raw_parts(actual_dacl.cast::<u8>(), actual_size)
                    == std::slice::from_raw_parts(expected_dacl.cast::<u8>(), expected_size)
            };
        unsafe { LocalFree(actual_descriptor) };
        if !protected || !same {
            return Err(TransactionError::Journal(format!(
                "{} does not have the exact protected KSX recovery-store DACL",
                self.path.display()
            )));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProtectedDirectory {
    fn drop(&mut self) {
        // SAFETY: handle is owned and valid until this drop.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
fn create_exact_directory(
    path: &Path,
    security: &SecurityDescriptor,
) -> Result<ProtectedDirectory, TransactionError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let attributes = security.attributes();
    // The DACL is attached atomically with name creation; there is no interval
    // in which inherited ProgramData grants can populate the directory.
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        return Err(TransactionError::Journal(format!(
            "creating protected directory {} failed: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    let directory = ProtectedDirectory::open(path, true)?;
    directory.apply_exact_dacl(security)?;
    crate::process::strong_acl(path).map_err(|err| TransactionError::Journal(err.to_string()))?;
    Ok(directory)
}

#[cfg(windows)]
fn entry_exists(path: &Path) -> Result<bool, TransactionError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(TransactionError::Journal(format!(
            "inspecting {} failed: {err}",
            path.display()
        ))),
    }
}

#[cfg(windows)]
fn open_existing_store_directory(
    path: &Path,
) -> Result<Option<ProtectedDirectory>, TransactionError> {
    if !entry_exists(path)? {
        return Ok(None);
    }
    let directory = ProtectedDirectory::open(path, true)?;
    // A legacy directory may have an inherited writable DACL which this
    // initializer exists to replace, but elevation must never bless an object
    // owned by an ordinary user. The live handle prevents replacement while
    // this owner check and later handle-relative DACL update run.
    crate::process::trusted_owner(path)
        .map_err(|err| TransactionError::Journal(err.to_string()))?;
    Ok(Some(directory))
}

#[cfg(windows)]
fn audit_known_children(path: &Path, allowed: &[&str]) -> Result<(), TransactionError> {
    for entry in std::fs::read_dir(path)
        .map_err(|err| TransactionError::Journal(format!("{}: {err}", path.display())))?
    {
        let entry = entry.map_err(|err| TransactionError::Journal(err.to_string()))?;
        let name = entry.file_name();
        let known = allowed
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(std::ffi::OsStr::new(allowed)));
        if !known {
            return Err(TransactionError::Journal(format!(
                "unknown pre-existing entry in the protected store: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn audit_existing_leaf_entries(
    journal: &Path,
    transactions: &Path,
) -> Result<(), TransactionError> {
    if journal.exists() {
        for entry in
            std::fs::read_dir(journal).map_err(|err| TransactionError::Journal(err.to_string()))?
        {
            let entry = entry.map_err(|err| TransactionError::Journal(err.to_string()))?;
            if entry.path().extension() != Some(std::ffi::OsStr::new("json")) {
                return Err(TransactionError::Journal(format!(
                    "unknown pre-existing journal entry: {}",
                    entry.path().display()
                )));
            }
            verify_protected_file(&entry.path())?;
        }
    }
    if transactions.exists() {
        for entry in std::fs::read_dir(transactions)
            .map_err(|err| TransactionError::Journal(err.to_string()))?
        {
            let entry = entry.map_err(|err| TransactionError::Journal(err.to_string()))?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                TransactionError::Journal("non-Unicode transaction directory".to_owned())
            })?;
            if name.len() != 32
                || !name
                    .chars()
                    .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
            {
                return Err(TransactionError::Journal(format!(
                    "unknown pre-existing transaction entry: {}",
                    entry.path().display()
                )));
            }
            verify_protected_directory(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn verify_protected_directory(path: &Path) -> Result<(), TransactionError> {
    verify_protected_object(path, true)
}

#[cfg(windows)]
fn verify_protected_file(path: &Path) -> Result<(), TransactionError> {
    verify_protected_object(path, false)
}

#[cfg(windows)]
fn verify_protected_object(path: &Path, directory: bool) -> Result<(), TransactionError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    if (directory && !path.is_dir()) || (!directory && !path.is_file()) {
        return Err(TransactionError::Journal(format!(
            "the protected {} is missing: {}",
            if directory { "directory" } else { "file" },
            path.display()
        )));
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: valid NUL-terminated path.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    if attributes == u32::MAX
        || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (attributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(TransactionError::Journal(format!(
            "{} is unreadable, has the wrong kind, or is a reparse point",
            path.display()
        )));
    }
    crate::process::strong_acl(path).map_err(|err| TransactionError::Journal(err.to_string()))
}

#[cfg(windows)]
struct ProgramDataStore {
    journal: PathBuf,
    transactions: PathBuf,
}

#[cfg(windows)]
impl ProgramDataStore {
    /// Create or normalize the fixed recovery-store tree without ever opening
    /// a caller-provided path.
    ///
    /// Every existing expected component is first opened as the reparse point
    /// itself, held without delete sharing, and proven to have a trusted owner
    /// before *any* ACL is changed. The exact DACL is then applied outer to
    /// inner before children are enumerated. Every new component receives that
    /// DACL in `CreateDirectoryW` itself. This permits normalization of a
    /// legacy inherited DACL without ever following or blessing a hostile
    /// junction, wrong-kind object, or user-owned directory.
    fn initialize() -> Result<Self, TransactionError> {
        let program_data_path = known_program_data()?;
        let program_data = ProtectedDirectory::open(&program_data_path, false)?;

        let ksx_path = program_data_path.join("KSX");
        let root_path = ksx_path.join("WinUSB");
        let journal_path = root_path.join("journal");
        let transactions_path = root_path.join("transactions");

        let mut ksx = open_existing_store_directory(&ksx_path)?;
        let mut root = if ksx.is_some() {
            open_existing_store_directory(&root_path)?
        } else {
            None
        };
        let mut journal = if root.is_some() {
            open_existing_store_directory(&journal_path)?
        } else {
            None
        };
        let mut transactions = if root.is_some() {
            open_existing_store_directory(&transactions_path)?
        } else {
            None
        };

        let security = SecurityDescriptor::exact_store()?;
        let secure_or_create = |slot: &mut Option<ProtectedDirectory>, path: &Path| {
            if let Some(directory) = slot.as_ref() {
                directory.apply_exact_dacl(&security)?;
                crate::process::strong_acl(path)
                    .map_err(|err| TransactionError::Journal(err.to_string()))?;
            } else {
                *slot = Some(create_exact_directory(path, &security)?);
            }
            Result::<(), TransactionError>::Ok(())
        };

        // Outer-to-inner is essential: once a parent is normalized, an
        // ordinary user cannot create, delete, or swap its expected child while
        // that child's handle/DACL is being finalized.
        secure_or_create(&mut ksx, &ksx_path)?;
        secure_or_create(&mut root, &root_path)?;
        secure_or_create(&mut journal, &journal_path)?;
        secure_or_create(&mut transactions, &transactions_path)?;

        // Only now is path-based enumeration safe. Unknown entries fail closed
        // after the expected tree itself has been made non-writable, so an
        // attacker cannot race the audit with a child replacement.
        audit_known_children(&ksx_path, &["WinUSB"])?;
        audit_known_children(&root_path, &["journal", "transactions"])?;
        audit_existing_leaf_entries(&journal_path, &transactions_path)?;

        let store = Self {
            journal: journal_path,
            transactions: transactions_path,
        };
        // Parse every receipt and audit every child now, while all ancestor
        // handles still prevent swaps. Unknown, orphaned, malformed, or unsafe
        // entries fail closed rather than being trusted after normalization.
        store.receipts()?;
        // Pin the postcondition against enumeration omissions or future
        // changes to receipt parsing: the expected names and leaf kinds/ACLs
        // must still be exactly the ones audited above.
        audit_known_children(&ksx_path, &["WinUSB"])?;
        audit_known_children(&root_path, &["journal", "transactions"])?;
        audit_existing_leaf_entries(&store.journal, &store.transactions)?;
        drop(program_data);
        Ok(store)
    }

    fn open() -> Result<Self, TransactionError> {
        let program_data = known_program_data()?.canonicalize().map_err(|err| {
            TransactionError::Journal(format!("ProgramData cannot be canonicalized: {err}"))
        })?;
        let ksx_root = program_data.join("KSX");
        verify_protected_directory(&ksx_root)?;
        let root = ksx_root.join("WinUSB");
        verify_protected_directory(&root)?;
        let canonical = root
            .canonicalize()
            .map_err(|err| TransactionError::Journal(format!("{}: {err}", root.display())))?;
        if !canonical.starts_with(&program_data) {
            return Err(TransactionError::Journal(
                "the WinUSB data directory resolves outside ProgramData".to_owned(),
            ));
        }
        let journal = canonical.join("journal");
        let transactions = canonical.join("transactions");
        verify_protected_directory(&journal)?;
        verify_protected_directory(&transactions)?;
        Ok(Self {
            journal,
            transactions,
        })
    }

    fn transaction_dir(&self, id: &str) -> PathBuf {
        self.transactions.join(id)
    }

    fn journal_path(&self, id: &str) -> PathBuf {
        self.journal.join(format!("{id}.json"))
    }

    fn validate_receipt_paths(&self, receipt: &Receipt) -> Result<PathBuf, TransactionError> {
        if receipt.transaction_id.len() != 32
            || !receipt
                .transaction_id
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
            || receipt.original_inf_name != format!("ksx-winusb-{}.inf", receipt.transaction_id)
        {
            return Err(TransactionError::Journal(
                "receipt transaction identity is malformed".to_owned(),
            ));
        }
        let tx = self.transaction_dir(&receipt.transaction_id);
        if Path::new(&receipt.inf_path).parent() != Some(tx.as_path())
            || Path::new(&receipt.catalog_path).parent() != Some(tx.as_path())
            || Path::new(&receipt.inf_path).file_name()
                != Some(std::ffi::OsStr::new(&receipt.original_inf_name))
            || Path::new(&receipt.catalog_path).file_name()
                != Some(std::ffi::OsStr::new(
                    &receipt.original_inf_name.replace(".inf", ".cat"),
                ))
        {
            return Err(TransactionError::Journal(
                "receipt artifact paths escaped their transaction directory".to_owned(),
            ));
        }
        Ok(tx)
    }

    fn atomic_write(&self, receipt: &Receipt, create: bool) -> Result<(), TransactionError> {
        use std::io::Write as _;
        use std::os::windows::ffi::OsStrExt as _;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let destination = self.journal_path(&receipt.transaction_id);
        if create && destination.exists() {
            return Err(TransactionError::Journal(format!(
                "transaction {} already exists",
                receipt.transaction_id
            )));
        }
        if !create && destination.exists() {
            verify_protected_file(&destination)?;
        }
        let temporary = self.journal.join(format!(
            ".{}.{}.tmp",
            receipt.transaction_id,
            std::process::id()
        ));
        let bytes = serde_json::to_vec_pretty(receipt)
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        verify_protected_file(&temporary)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        drop(file);
        let from: Vec<u16> = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: both paths are NUL-terminated and pinned inside the verified
        // protected journal directory. WRITE_THROUGH makes phase transitions
        // durable before the next mutation.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(TransactionError::Journal(format!(
                "atomic journal replace failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        verify_protected_file(&destination)?;
        Ok(())
    }

    fn receipts(&self) -> Result<Vec<Receipt>, TransactionError> {
        let mut found = Vec::new();
        let entries = std::fs::read_dir(&self.journal)
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|err| {
                TransactionError::Journal(format!("enumerating journal entries failed: {err}"))
            })?;
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                return Err(TransactionError::Journal(format!(
                    "unknown entry in protected journal: {}",
                    entry.path().display()
                )));
            }
            verify_protected_file(&entry.path())?;
            let bytes = std::fs::read(entry.path())
                .map_err(|err| TransactionError::Journal(err.to_string()))?;
            let receipt: Receipt = serde_json::from_slice(&bytes)
                .map_err(|err| TransactionError::Journal(err.to_string()))?;
            if entry.path().file_stem() != Some(std::ffi::OsStr::new(&receipt.transaction_id)) {
                return Err(TransactionError::Journal(format!(
                    "journal filename does not match transaction {}",
                    receipt.transaction_id
                )));
            }
            self.validate_receipt_paths(&receipt)?;
            let tx = self.transaction_dir(&receipt.transaction_id);
            if tx.exists() {
                verify_protected_directory(&tx)?;
                for artifact in std::fs::read_dir(&tx)
                    .map_err(|err| TransactionError::Journal(err.to_string()))?
                {
                    let artifact = artifact.map_err(|err| {
                        TransactionError::Journal(format!(
                            "enumerating transaction artifacts failed: {err}"
                        ))
                    })?;
                    let name = artifact.file_name();
                    let allowed = name == std::ffi::OsStr::new(&receipt.original_inf_name)
                        || name
                            == std::ffi::OsStr::new(
                                &receipt.original_inf_name.replace(".inf", ".cat"),
                            );
                    if !allowed {
                        return Err(TransactionError::Journal(format!(
                            "unknown transaction artifact: {}",
                            artifact.path().display()
                        )));
                    }
                    verify_protected_file(&artifact.path())?;
                }
            }
            found.push(receipt);
        }
        let known: std::collections::BTreeSet<_> = found
            .iter()
            .map(|receipt| receipt.transaction_id.as_str())
            .collect();
        for entry in std::fs::read_dir(&self.transactions)
            .map_err(|err| TransactionError::Journal(err.to_string()))?
        {
            let entry = entry.map_err(|err| {
                TransactionError::Journal(format!(
                    "enumerating transaction directories failed: {err}"
                ))
            })?;
            let name = entry.file_name();
            let name = name.to_str().ok_or_else(|| {
                TransactionError::Journal("non-Unicode transaction directory".to_owned())
            })?;
            if !known.contains(name) {
                return Err(TransactionError::Journal(format!(
                    "transaction directory {name} has no protected receipt"
                )));
            }
            verify_protected_directory(&entry.path())?;
        }
        found.sort_by(|a, b| {
            a.created_unix_seconds
                .cmp(&b.created_unix_seconds)
                .then_with(|| a.transaction_id.cmp(&b.transaction_id))
        });
        Ok(found)
    }
}

#[cfg(windows)]
impl TransactionStore for ProgramDataStore {
    fn begin(&self, receipt: &Receipt) -> Result<(), TransactionError> {
        let tx = self.validate_receipt_paths(receipt)?;
        std::fs::create_dir(&tx).map_err(|err| TransactionError::Journal(err.to_string()))?;
        verify_protected_directory(&tx)?;
        self.atomic_write(receipt, true)
    }

    fn update(&self, receipt: &Receipt) -> Result<(), TransactionError> {
        self.validate_receipt_paths(receipt)?;
        if !self.journal_path(&receipt.transaction_id).is_file() {
            return Err(TransactionError::Journal(
                "cannot update a transaction with no journal".to_owned(),
            ));
        }
        self.atomic_write(receipt, false)
    }

    fn write_template(&self, receipt: &Receipt, bytes: &[u8]) -> Result<(), TransactionError> {
        use std::io::Write as _;
        let tx = self.validate_receipt_paths(receipt)?;
        verify_protected_directory(&tx)?;
        let path = Path::new(&receipt.inf_path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        verify_protected_file(path)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|err| TransactionError::Journal(err.to_string()))
    }

    fn active_for(&self, instance_id: &str) -> Result<Option<Receipt>, TransactionError> {
        let mut found: Vec<_> = self
            .owned_receipts()?
            .into_iter()
            .filter(|receipt| receipt.phase == Phase::Active)
            .filter(|receipt| receipt.target_instance_id.eq_ignore_ascii_case(instance_id))
            .collect();
        match found.len() {
            0 => Ok(None),
            1 => Ok(found.pop()),
            count => Err(TransactionError::Journal(format!(
                "{count} active receipts claim the same interface"
            ))),
        }
    }

    fn owned_receipts(&self) -> Result<Vec<Receipt>, TransactionError> {
        let mut found = self.receipts()?;
        found.sort_by(|a, b| a.transaction_id.cmp(&b.transaction_id));
        Ok(found)
    }

    fn cleanup_artifacts(&self, receipt: &Receipt) -> Result<(), TransactionError> {
        let tx = self.validate_receipt_paths(receipt)?;
        if !tx.exists() {
            return Ok(());
        }
        let canonical = tx
            .canonicalize()
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        let base = self
            .transactions
            .canonicalize()
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        if canonical.parent() != Some(base.as_path()) {
            return Err(TransactionError::Journal(
                "refused artifact cleanup outside the transaction root".to_owned(),
            ));
        }
        verify_protected_directory(&canonical)?;
        for entry in std::fs::read_dir(&canonical)
            .map_err(|err| TransactionError::Journal(err.to_string()))?
        {
            let entry = entry.map_err(|err| TransactionError::Journal(err.to_string()))?;
            let name = entry.file_name();
            let allowed = name == std::ffi::OsStr::new(&receipt.original_inf_name)
                || name == std::ffi::OsStr::new(&receipt.original_inf_name.replace(".inf", ".cat"));
            if !allowed {
                return Err(TransactionError::Journal(format!(
                    "refused to clean unknown transaction artifact {}",
                    entry.path().display()
                )));
            }
            verify_protected_file(&entry.path())?;
            std::fs::remove_file(entry.path())
                .map_err(|err| TransactionError::Journal(err.to_string()))?;
        }
        std::fs::remove_dir(&canonical).map_err(|err| TransactionError::Journal(err.to_string()))
    }
}

#[cfg(windows)]
struct WindowsTrustVerifier;

#[cfg(windows)]
mod windows_trust {
    use super::*;
    use std::os::windows::ffi::OsStrExt as _;
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Foundation::{
        GetLastError, CRYPT_E_NOT_FOUND, ERROR_NO_MORE_ITEMS, HANDLE, HWND,
    };
    use windows::Win32::Security::Cryptography::Catalog::{
        CryptCATAdminCalcHashFromFileHandle, CryptCATClose, CryptCATEnumerateMember,
        CryptCATGetAttrInfo, CryptCATOpen, CRYPTCAT_OPEN_EXISTING, CRYPTCAT_VERSION_1,
    };
    use windows::Win32::Security::Cryptography::{
        CertCloseStore, CertDeleteCertificateFromStore, CertDuplicateCertificateContext,
        CertEnumCertificatesInStore, CertGetCertificateContextProperty, CertGetNameStringW,
        CertOpenStore, CryptAcquireContextW, CryptGetProvParam, CryptReleaseContext, CERT_CONTEXT,
        CERT_KEY_CONTEXT_PROP_ID, CERT_KEY_PROV_HANDLE_PROP_ID, CERT_KEY_PROV_INFO_PROP_ID,
        CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_NCRYPT_KEY_HANDLE_PROP_ID, CERT_OPEN_STORE_FLAGS,
        CERT_QUERY_ENCODING_TYPE, CERT_SHA1_HASH_PROP_ID, CERT_STORE_MAXIMUM_ALLOWED_FLAG,
        CERT_STORE_OPEN_EXISTING_FLAG, CERT_STORE_PROV_SYSTEM_W, CERT_SYSTEM_STORE_LOCAL_MACHINE,
        CRYPT_DELETEKEYSET, CRYPT_FIRST, CRYPT_MACHINE_KEYSET, CRYPT_NEXT, CRYPT_SILENT,
        CRYPT_VERIFYCONTEXT, HCERTSTORE, MS_ENH_RSA_AES_PROV_W, PKCS_7_ASN_ENCODING,
        PP_ENUMCONTAINERS, PROV_RSA_AES, X509_ASN_ENCODING,
    };
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    struct Store(HCERTSTORE);
    impl Drop for Store {
        fn drop(&mut self) {
            let _ = unsafe { CertCloseStore(Some(self.0), 0) };
        }
    }

    struct CertificateContext(*const CERT_CONTEXT);
    impl CertificateContext {
        fn into_raw(self) -> *const CERT_CONTEXT {
            let raw = self.0;
            std::mem::forget(self);
            raw
        }
    }
    impl Drop for CertificateContext {
        fn drop(&mut self) {
            let _ = unsafe {
                windows::Win32::Security::Cryptography::CertFreeCertificateContext(Some(self.0))
            };
        }
    }

    struct Catalog(HANDLE);
    impl Drop for Catalog {
        fn drop(&mut self) {
            let _ = unsafe { CryptCATClose(self.0) };
        }
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn decode_prepared_inf(path: &Path) -> Result<String, TransactionError> {
        let bytes = std::fs::read(path)
            .map_err(|err| TransactionError::Verification(format!("{}: {err}", path.display())))?;
        if bytes.len() < 4 || !bytes.starts_with(&[0xff, 0xfe]) || bytes.len() % 2 != 0 {
            return Err(TransactionError::Verification(
                "the prepared INF is not BOM-prefixed UTF-16LE".to_owned(),
            ));
        }
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units)
            .map_err(|err| TransactionError::Verification(format!("INF UTF-16: {err}")))
    }

    fn normalize_driver_version(text: &str) -> Result<String, TransactionError> {
        let mut out = Vec::new();
        let mut found = 0usize;
        for line in text.replace("\r\n", "\n").replace('\r', "\n").lines() {
            if line.trim_start().starts_with("DriverVer") {
                found += 1;
                let value = line
                    .split_once('=')
                    .map(|(_, value)| value.trim())
                    .ok_or_else(|| {
                        TransactionError::Verification("malformed DriverVer".to_owned())
                    })?;
                let (date, version) = value.split_once(',').ok_or_else(|| {
                    TransactionError::Verification("malformed DriverVer value".to_owned())
                })?;
                let date_parts: Vec<_> = date.trim().split('/').collect();
                let version_parts: Vec<_> = version.trim().split('.').collect();
                if date_parts.len() != 3
                    || date_parts[0].len() != 2
                    || date_parts[1].len() != 2
                    || date_parts[2].len() != 4
                    || !date_parts
                        .iter()
                        .all(|part| part.chars().all(|ch| ch.is_ascii_digit()))
                    || version_parts.len() != 4
                    || !version_parts.iter().all(|part| {
                        !part.is_empty()
                            && part.chars().all(|ch| ch.is_ascii_digit())
                            && part.parse::<u16>().is_ok()
                    })
                {
                    return Err(TransactionError::Verification(format!(
                        "unsafe DriverVer value '{value}'"
                    )));
                }
                out.push("DriverVer   = #DRIVER_DATE#, #DRIVER_VERSION#".to_owned());
            } else {
                out.push(line.to_owned());
            }
        }
        if found != 1 {
            return Err(TransactionError::Verification(format!(
                "prepared INF has {found} DriverVer rows"
            )));
        }
        Ok(out.join("\n").trim_end_matches('\n').to_owned())
    }

    fn verify_inf(expected: &ExpectedArtifacts) -> Result<(), TransactionError> {
        let actual = normalize_driver_version(&decode_prepared_inf(&expected.inf_path)?)?;
        let hardware = expected
            .hardware_id
            .strip_prefix(r"USB\")
            .ok_or_else(|| TransactionError::UnsafeHardwareId(expected.hardware_id.clone()))?;
        let catalog = expected.inf_name.replace(".inf", ".cat");
        let canonical = CANONICAL_INF_TEMPLATE
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace("#INF_FILENAME#", &expected.inf_name)
            .replace("#DEVICE_DESCRIPTION#", SAFE_INF_DEVICE_NAME)
            .replace("#DEVICE_MANUFACTURER#", "KSX")
            .replace("#DEVICE_HARDWARE_ID#", hardware)
            .replace("#DEVICE_INTERFACE_GUID#", KSX_DEVICE_INTERFACE_GUID)
            .replace("#CAT_FILENAME#", &catalog)
            .replace("#USE_DEVICE_INTERFACE_GUID#", "AddDeviceInterfaceGUID")
            .trim_end_matches('\n')
            .to_owned();
        if actual != canonical {
            return Err(TransactionError::Verification(
                "prepared INF is not the exact expansion of the reviewed KSX WinUSB template"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    /// The hash the catalog subsystem itself computes for a file: the exact
    /// value `CryptCATPutMemberInfo` recorded as the member digest.
    fn catalog_file_hash(path: &Path) -> Result<Vec<u8>, TransactionError> {
        use std::os::windows::io::AsRawHandle as _;
        let file = std::fs::File::open(path)
            .map_err(|err| TransactionError::Verification(format!("{}: {err}", path.display())))?;
        let handle = HANDLE(file.as_raw_handle());
        let mut length = 0u32;
        // A null out-pointer asks for the size; it fails with
        // ERROR_INSUFFICIENT_BUFFER, which is the documented way to be told.
        let _ = unsafe { CryptCATAdminCalcHashFromFileHandle(handle, &mut length, None, None) };
        if length == 0 {
            return Err(TransactionError::Verification(format!(
                "the catalog subsystem reported no hash length for {}",
                path.display()
            )));
        }
        let mut hash = vec![0u8; length as usize];
        if !unsafe {
            CryptCATAdminCalcHashFromFileHandle(handle, &mut length, Some(hash.as_mut_ptr()), None)
        }
        .as_bool()
        {
            return Err(TransactionError::Verification(format!(
                "computing the catalog file hash for {} failed: {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
        hash.truncate(length as usize);
        Ok(hash)
    }

    /// A catalog member's `File` attribute.
    ///
    /// # Safety
    /// `member` must be a live member of the open `catalog`.
    unsafe fn member_file_attribute(
        catalog: HANDLE,
        member: *mut windows::Win32::Security::Cryptography::Catalog::CRYPTCATMEMBER,
    ) -> Result<String, TransactionError> {
        let tag: Vec<u16> = "File".encode_utf16().chain(std::iter::once(0)).collect();
        let attribute = unsafe { CryptCATGetAttrInfo(catalog, member, PCWSTR(tag.as_ptr())) };
        if attribute.is_null() {
            return Err(TransactionError::Verification(
                "catalog member carries no File attribute".to_owned(),
            ));
        }
        let bytes = unsafe { (*attribute).cbValue } as usize;
        let value = unsafe { (*attribute).pbValue };
        if value.is_null() || bytes < 2 {
            return Err(TransactionError::Verification(
                "catalog member File attribute is empty".to_owned(),
            ));
        }
        let wide = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), bytes / 2) };
        Ok(String::from_utf16_lossy(wide)
            .trim_end_matches(char::from(0))
            .to_owned())
    }

    fn verify_catalog_member(expected: &ExpectedArtifacts) -> Result<(), TransactionError> {
        let wide_path = wide(&expected.catalog_path);
        let encoding = X509_ASN_ENCODING.0 | PKCS_7_ASN_ENCODING.0;
        let handle = unsafe {
            CryptCATOpen(
                PCWSTR(wide_path.as_ptr()),
                CRYPTCAT_OPEN_EXISTING,
                0,
                CRYPTCAT_VERSION_1,
                encoding,
            )
        };
        if handle.is_invalid() {
            return Err(TransactionError::Verification(format!(
                "CryptCATOpen({}) failed",
                expected.catalog_path.display()
            )));
        }
        let catalog = Catalog(handle);
        // The SAME primitive the provider used to build the member, so the two
        // can never disagree about an algorithm again. This was
        // `crate::sha256::hash_file` while the catalog carried SHA-1 members --
        // the "both sides must move together" mistake, made in the verifier
        // this time.
        let inf_hash = catalog_file_hash(&expected.inf_path)?;
        let mut previous = std::ptr::null_mut();
        let mut members = 0usize;
        loop {
            let member = unsafe { CryptCATEnumerateMember(catalog.0, previous) };
            if member.is_null() {
                break;
            }
            previous = member;
            members += 1;
            // The name lives in the member's `File` ATTRIBUTE.
            // `CryptCATPutMemberInfo` does not set `pwszFileName`, so the
            // provider leaves it empty and reading it reported every member as
            // '' -- which is what stopped preparation here.
            let name = unsafe { member_file_attribute(catalog.0, member) }?;
            if !name.eq_ignore_ascii_case(&expected.inf_name) {
                return Err(TransactionError::Verification(format!(
                    "catalog contains unexpected member '{name}'"
                )));
            }
            let indirect = unsafe { (*member).pIndirectData };
            if indirect.is_null() {
                return Err(TransactionError::Verification(
                    "catalog member has no indirect digest".to_owned(),
                ));
            }
            let digest = unsafe { (*indirect).Digest };
            if digest.cbData as usize != inf_hash.len() || digest.pbData.is_null() {
                return Err(TransactionError::Verification(format!(
                    "catalog member digest is {} bytes, expected {}",
                    digest.cbData,
                    inf_hash.len()
                )));
            }
            let recorded =
                unsafe { std::slice::from_raw_parts(digest.pbData, digest.cbData as usize) };
            if recorded != inf_hash {
                return Err(TransactionError::Verification(
                    "catalog digest does not match the exact prepared INF bytes".to_owned(),
                ));
            }
        }
        if members != 1 {
            return Err(TransactionError::Verification(format!(
                "catalog contains {members} members instead of exactly one INF"
            )));
        }
        Ok(())
    }

    unsafe fn cert_name(cert: *const CERT_CONTEXT) -> Result<String, TransactionError> {
        let len = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, None) };
        if len <= 1 {
            return Err(TransactionError::Verification(
                "catalog signer has no readable subject".to_owned(),
            ));
        }
        let mut buffer = vec![0u16; len as usize];
        let written = unsafe {
            CertGetNameStringW(
                cert,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                0,
                None,
                Some(&mut buffer),
            )
        };
        if written <= 1 {
            return Err(TransactionError::Verification(
                "catalog signer subject could not be read".to_owned(),
            ));
        }
        Ok(String::from_utf16_lossy(&buffer[..written as usize - 1]))
    }

    unsafe fn certificate_property(
        cert: *const CERT_CONTEXT,
        property: u32,
    ) -> Result<Vec<u8>, TransactionError> {
        let mut len = 0u32;
        unsafe { CertGetCertificateContextProperty(cert, property, None, &mut len) }
            .map_err(|err| TransactionError::Verification(err.to_string()))?;
        let mut value = vec![0u8; len as usize];
        unsafe {
            CertGetCertificateContextProperty(
                cert,
                property,
                Some(value.as_mut_ptr().cast()),
                &mut len,
            )
        }
        .map_err(|err| TransactionError::Verification(err.to_string()))?;
        value.truncate(len as usize);
        Ok(value)
    }

    unsafe fn signer(path: &Path) -> Result<(String, Vec<u8>, String), TransactionError> {
        let wide_path = wide(path);
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide_path.as_ptr()),
            hFile: HANDLE::default(),
            pgKnownSubject: std::ptr::null_mut(),
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            dwProvFlags: WTD_REVOCATION_CHECK_NONE,
            ..Default::default()
        };
        let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let trust = unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action,
                (&mut data as *mut WINTRUST_DATA).cast(),
            )
        };
        let result = if trust != 0 || data.hWVTStateData.is_invalid() {
            Err(TransactionError::Verification(format!(
                "catalog Authenticode trust failed ({trust:#x})"
            )))
        } else {
            let provider = unsafe { WTHelperProvDataFromStateData(data.hWVTStateData) };
            let signer = if provider.is_null() {
                std::ptr::null()
            } else {
                unsafe { WTHelperGetProvSignerFromChain(provider, 0, false, 0) }
            };
            if signer.is_null()
                || unsafe { (*signer).csCertChain } == 0
                || unsafe { (*signer).pasCertChain }.is_null()
            {
                Err(TransactionError::Verification(
                    "catalog trust state contains no signer chain".to_owned(),
                ))
            } else {
                let cert = unsafe { (*(*signer).pasCertChain).pCert };
                if cert.is_null() {
                    Err(TransactionError::Verification(
                        "catalog signer certificate is missing".to_owned(),
                    ))
                } else {
                    let subject = unsafe { cert_name(cert) }?;
                    let der = unsafe {
                        std::slice::from_raw_parts(
                            (*cert).pbCertEncoded,
                            (*cert).cbCertEncoded as usize,
                        )
                        .to_vec()
                    };
                    let thumbprint = crate::sha256::hex_upper(&unsafe {
                        certificate_property(cert, CERT_SHA1_HASH_PROP_ID)
                    }?);
                    Ok((subject, der, thumbprint))
                }
            }
        };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action,
                (&mut data as *mut WINTRUST_DATA).cast(),
            )
        };
        result
    }

    fn open_machine_store(name: &str) -> Result<Store, TransactionError> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // MAXIMUM_ALLOWED, because this store is also deleted from. Without it
        // the system provider hands back a view whose
        // `CertDeleteCertificateFromStore` REPORTS SUCCESS and never commits:
        // compensation then found the certificate still present, called itself
        // a failed rollback, and left the transaction recovery-required with a
        // certificate in LocalMachine Root and TrustedPublisher per attempt.
        // Measured on the reporting machine: the identical delete commits when
        // the store is opened for write.
        let flags = CERT_OPEN_STORE_FLAGS(
            CERT_SYSTEM_STORE_LOCAL_MACHINE
                | CERT_STORE_OPEN_EXISTING_FLAG.0
                | CERT_STORE_MAXIMUM_ALLOWED_FLAG.0,
        );
        let store = unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                CERT_QUERY_ENCODING_TYPE(0),
                None,
                flags,
                Some(wide.as_ptr().cast()),
            )
        }
        .map_err(|err| TransactionError::Verification(format!("open LM\\{name}: {err}")))?;
        Ok(Store(store))
    }

    unsafe fn next_certificate(
        store: HCERTSTORE,
        previous: Option<*const CERT_CONTEXT>,
    ) -> Result<Option<*const CERT_CONTEXT>, TransactionError> {
        let cert = unsafe { CertEnumCertificatesInStore(store, previous) };
        if !cert.is_null() {
            return Ok(Some(cert));
        }
        let last = unsafe { GetLastError() };
        if last.0 as i32 == CRYPT_E_NOT_FOUND.0 {
            Ok(None)
        } else {
            Err(TransactionError::Verification(format!(
                "certificate-store enumeration failed ({:#x})",
                last.0
            )))
        }
    }

    unsafe fn certificate_identity(
        cert: *const CERT_CONTEXT,
    ) -> Result<(String, String), TransactionError> {
        let der = unsafe {
            std::slice::from_raw_parts((*cert).pbCertEncoded, (*cert).cbCertEncoded as usize)
        };
        let mut hasher = crate::sha256::Sha256::new();
        hasher.update(der);
        let der_hash = crate::sha256::hex_upper(&hasher.finish());
        let thumbprint = crate::sha256::hex_upper(&unsafe {
            certificate_property(cert, CERT_SHA1_HASH_PROP_ID)
        }?);
        Ok((thumbprint, der_hash))
    }

    unsafe fn has_private_key(cert: *const CERT_CONTEXT) -> Result<bool, TransactionError> {
        for property in [
            CERT_KEY_PROV_INFO_PROP_ID,
            CERT_KEY_CONTEXT_PROP_ID,
            CERT_KEY_PROV_HANDLE_PROP_ID,
            CERT_NCRYPT_KEY_HANDLE_PROP_ID,
        ] {
            let mut len = 0u32;
            match unsafe { CertGetCertificateContextProperty(cert, property, None, &mut len) } {
                Ok(()) => return Ok(true),
                Err(err) if err.code() == CRYPT_E_NOT_FOUND => {}
                Err(err) => {
                    return Err(TransactionError::Verification(format!(
                        "private-key property {property} check failed: {err}"
                    )))
                }
            }
        }
        Ok(false)
    }

    fn owned_private_keys() -> Result<Vec<String>, TransactionError> {
        let mut provider = 0usize;
        unsafe {
            CryptAcquireContextW(
                &mut provider,
                PCWSTR::null(),
                MS_ENH_RSA_AES_PROV_W,
                PROV_RSA_AES,
                CRYPT_VERIFYCONTEXT | CRYPT_MACHINE_KEYSET.0 | CRYPT_SILENT,
            )
        }
        .map_err(|err| {
            TransactionError::Verification(format!("open machine RSA-AES provider: {err}"))
        })?;
        struct Provider(usize);
        impl Drop for Provider {
            fn drop(&mut self) {
                let _ = unsafe { CryptReleaseContext(self.0, 0) };
            }
        }
        let provider = Provider(provider);
        let mut names = Vec::new();
        let mut flag = CRYPT_FIRST;
        loop {
            let mut buffer = vec![0u8; 1024];
            let mut len = buffer.len() as u32;
            match unsafe {
                CryptGetProvParam(
                    provider.0,
                    PP_ENUMCONTAINERS,
                    Some(buffer.as_mut_ptr()),
                    &mut len,
                    flag,
                )
            } {
                Ok(()) => {
                    let end = buffer
                        .iter()
                        .position(|byte| *byte == 0)
                        .unwrap_or(len as usize)
                        .min(buffer.len());
                    let name = String::from_utf8_lossy(&buffer[..end]).into_owned();
                    if name.starts_with("KSX-libwdi-")
                        && name["KSX-libwdi-".len()..].len() == 32
                        && name["KSX-libwdi-".len()..]
                            .chars()
                            .all(|ch| ch.is_ascii_hexdigit())
                    {
                        names.push(name);
                    }
                    flag = CRYPT_NEXT;
                }
                Err(err) if err.code() == ERROR_NO_MORE_ITEMS.to_hresult() => break,
                Err(err) => {
                    return Err(TransactionError::Verification(format!(
                        "enumerating machine RSA-AES key containers failed: {err}"
                    )))
                }
            }
        }
        names.sort();
        Ok(names)
    }

    fn delete_owned_private_keys() -> Result<(), TransactionError> {
        for container in owned_private_keys()? {
            let wide: Vec<u16> = container.encode_utf16().chain(std::iter::once(0)).collect();
            let mut unused = 0usize;
            unsafe {
                CryptAcquireContextW(
                    &mut unused,
                    PCWSTR(wide.as_ptr()),
                    MS_ENH_RSA_AES_PROV_W,
                    PROV_RSA_AES,
                    CRYPT_DELETEKEYSET | CRYPT_MACHINE_KEYSET.0 | CRYPT_SILENT,
                )
            }
            .map_err(|err| {
                TransactionError::RecoveryRequired(format!(
                    "delete owned private-key container {container}: {err}"
                ))
            })?;
        }
        let remaining = owned_private_keys()?;
        if !remaining.is_empty() {
            return Err(TransactionError::RecoveryRequired(format!(
                "owned private-key containers remain after cleanup: {remaining:?}"
            )));
        }
        Ok(())
    }

    fn require_store_der(name: &str, der: &[u8]) -> Result<(), TransactionError> {
        let store = open_machine_store(name)?;
        let mut previous = None;
        let mut found = 0usize;
        while let Some(cert) = (unsafe { next_certificate(store.0, previous) })? {
            previous = Some(cert);
            let current = unsafe {
                std::slice::from_raw_parts((*cert).pbCertEncoded, (*cert).cbCertEncoded as usize)
            };
            if current == der {
                found += 1;
                if unsafe { has_private_key(cert) }? {
                    return Err(TransactionError::Verification(format!(
                        "the exact LM\\{name} certificate still exposes a private-key provider"
                    )));
                }
            }
        }
        if found != 1 {
            return Err(TransactionError::Verification(format!(
                "exact signer DER appears {found} times in LM\\{name}"
            )));
        }
        Ok(())
    }

    fn delete_matching(
        name: &str,
        subject: &str,
        thumbprint: Option<&str>,
        der_hash: Option<&str>,
    ) -> Result<(), TransactionError> {
        let store = open_machine_store(name)?;
        let simple = subject.strip_prefix("CN=").unwrap_or(subject);
        let mut previous = None;
        let mut duplicate: Option<CertificateContext> = None;
        let mut matches = 0usize;
        while let Some(cert) = (unsafe { next_certificate(store.0, previous) })? {
            previous = Some(cert);
            if unsafe { cert_name(cert) }? != simple {
                continue;
            }
            matches += 1;
            let (actual_thumb, actual_der) = unsafe { certificate_identity(cert) }?;
            if der_hash.is_some_and(|expected| !actual_der.eq_ignore_ascii_case(expected)) {
                return Err(TransactionError::RecoveryRequired(format!(
                    "LM\\{name} contains the unique KSX subject with a different DER identity"
                )));
            }
            if thumbprint.is_some_and(|expected| !actual_thumb.eq_ignore_ascii_case(expected)) {
                return Err(TransactionError::RecoveryRequired(format!(
                    "LM\\{name} contains the unique KSX subject with a different thumbprint"
                )));
            }
            if unsafe { has_private_key(cert) }? {
                return Err(TransactionError::RecoveryRequired(format!(
                    "refused to delete LM\\{name} certificate while its private-key provider remains"
                )));
            }
            if matches > 1 {
                return Err(TransactionError::RecoveryRequired(format!(
                    "LM\\{name} contains the unique KSX subject more than once"
                )));
            }
            let context = unsafe { CertDuplicateCertificateContext(Some(cert)) };
            if context.is_null() {
                return Err(TransactionError::Windows(
                    "CertDuplicateCertificateContext failed".to_owned(),
                ));
            }
            duplicate = Some(CertificateContext(context));
        }
        drop(store);
        if let Some(duplicate) = duplicate {
            unsafe { CertDeleteCertificateFromStore(duplicate.into_raw()) }.map_err(|err| {
                TransactionError::Windows(format!("delete LM\\{name} certificate: {err}"))
            })?;
        }
        let verify = open_machine_store(name)?;
        let mut previous = None;
        while let Some(cert) = (unsafe { next_certificate(verify.0, previous) })? {
            previous = Some(cert);
            if unsafe { cert_name(cert) }? == simple {
                return Err(TransactionError::RecoveryRequired(format!(
                    "LM\\{name} still contains the unique KSX certificate subject after deletion"
                )));
            }
        }
        Ok(())
    }

    #[derive(Clone)]
    struct OwnedCertificate {
        subject: String,
        thumbprint: String,
        der_hash: String,
    }

    fn owned_certificates(name: &str) -> Result<Vec<OwnedCertificate>, TransactionError> {
        let store = open_machine_store(name)?;
        let mut previous = None;
        let mut owned = Vec::new();
        while let Some(cert) = (unsafe { next_certificate(store.0, previous) })? {
            previous = Some(cert);
            let subject = unsafe { cert_name(cert) }?;
            if !subject.starts_with("KSX WinUSB ") {
                continue;
            }
            let suffix = &subject["KSX WinUSB ".len()..];
            if suffix.len() != 32 || !suffix.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Err(TransactionError::RecoveryRequired(format!(
                    "LM\\{name} contains a malformed certificate in the KSX-owned subject namespace"
                )));
            }
            let (thumbprint, der_hash) = unsafe { certificate_identity(cert) }?;
            owned.push(OwnedCertificate {
                subject: format!("CN={subject}"),
                thumbprint,
                der_hash,
            });
        }
        Ok(owned)
    }

    impl TrustVerifier for WindowsTrustVerifier {
        fn owned_private_keys(&self) -> Result<Vec<String>, TransactionError> {
            owned_private_keys()
        }

        fn verify(&self, expected: &ExpectedArtifacts) -> Result<TrustEvidence, TransactionError> {
            verify_protected_file(&expected.inf_path)?;
            verify_protected_file(&expected.catalog_path)?;
            verify_inf(expected)?;
            verify_catalog_member(expected)?;
            let (subject, der, thumbprint) = unsafe { signer(&expected.catalog_path) }?;
            let expected_simple = expected
                .certificate_subject
                .strip_prefix("CN=")
                .unwrap_or(&expected.certificate_subject);
            if subject != expected_simple {
                return Err(TransactionError::Verification(format!(
                    "catalog signer '{subject}' is not '{expected_simple}'"
                )));
            }
            require_store_der("Root", &der)?;
            require_store_der("TrustedPublisher", &der)?;
            let keys = owned_private_keys()?;
            if !keys.is_empty() {
                return Err(TransactionError::Verification(format!(
                    "provider-owned private-key containers remain after prepare: {keys:?}"
                )));
            }
            let inf_sha256 = crate::sha256::hex_upper(
                &crate::sha256::hash_file(&expected.inf_path)
                    .map_err(|err| TransactionError::Verification(err.to_string()))?,
            );
            let catalog_sha256 = crate::sha256::hex_upper(
                &crate::sha256::hash_file(&expected.catalog_path)
                    .map_err(|err| TransactionError::Verification(err.to_string()))?,
            );
            let mut hasher = crate::sha256::Sha256::new();
            hasher.update(&der);
            let certificate_der_sha256 = crate::sha256::hex_upper(&hasher.finish());
            Ok(TrustEvidence {
                inf_sha256,
                catalog_sha256,
                certificate_subject: expected.certificate_subject.clone(),
                certificate_thumbprint_sha1: thumbprint,
                certificate_der_sha256,
            })
        }

        fn cleanup(
            &self,
            subject: &str,
            thumbprint_sha1: Option<&str>,
            der_sha256: Option<&str>,
        ) -> Result<(), TransactionError> {
            // Delete any provider-owned orphan first; certificate deletion can
            // otherwise erase the last metadata that names a key container.
            delete_owned_private_keys()?;
            delete_matching("TrustedPublisher", subject, thumbprint_sha1, der_sha256)?;
            delete_matching("Root", subject, thumbprint_sha1, der_sha256)
        }

        fn cleanup_owned_residue(&self) -> Result<(), TransactionError> {
            delete_owned_private_keys()?;
            for store in ["TrustedPublisher", "Root"] {
                for cert in owned_certificates(store)? {
                    delete_matching(
                        store,
                        &cert.subject,
                        Some(&cert.thumbprint),
                        Some(&cert.der_hash),
                    )?;
                }
                let remaining = owned_certificates(store)?;
                if !remaining.is_empty() {
                    return Err(TransactionError::RecoveryRequired(format!(
                        "LM\\{store} retains {} KSX-owned certificate(s)",
                        remaining.len()
                    )));
                }
            }
            Ok(())
        }
    }
}

/// Initialize the fixed machine-wide recovery store.
///
/// This is the sole installer bootstrap operation. It accepts no path and
/// creates only `{KnownFolder ProgramData}\KSX\WinUSB\{journal,transactions}`
/// with the fixed protected ACL. The elevated helper must validate its own
/// executable anchor before calling this function.
#[cfg(windows)]
pub fn initialize_store() -> Result<(), TransactionError> {
    if crate::process::is_elevated() != Some(true) {
        return Err(TransactionError::Windows(
            "the WinUSB store initializer is not elevated".to_owned(),
        ));
    }
    let _lock = MutationGuard::acquire()?;
    ProgramDataStore::initialize()?;
    Ok(())
}

#[cfg(not(windows))]
pub fn initialize_store() -> Result<(), TransactionError> {
    Err(TransactionError::Unsupported)
}

/// Read-only audit of the fixed store path, for Setup to run BEFORE it copies
/// anything.
///
/// This exists because `initialize_store` cannot run at that moment and never
/// could: it requires the calling executable to sit in a directory only
/// SYSTEM/Administrators/TrustedInstaller can write, and Setup necessarily runs
/// its extracted copy from a temporary directory owned by the invoking user.
/// The mutating path keeps that rule. This one does not need it, because it
/// creates nothing, changes no DACL, and writes nothing: the worst a swapped
/// caller achieves is being told about a directory it can already read.
///
/// `PrepareToInstall` is also the only phase whose failure aborts an install.
/// An exception from `CurStepChanged(ssPostInstall)` is reported and then
/// ignored — Inno has already logged "Installation process succeeded" by then —
/// so a hostile ProgramData has to be refused here or not at all.
#[cfg(windows)]
pub fn check_store() -> Result<(), TransactionError> {
    let program_data = known_program_data()?;
    let ksx = program_data.join("KSX");
    let root = ksx.join("WinUSB");

    for path in [&ksx, &root] {
        if !entry_exists(path)? {
            continue;
        }
        // Explicit, rather than inferred from the open below: a junction whose
        // own reparse point happens to be admin-owned would otherwise pass an
        // owner check while still pointing wherever its author chose.
        crate::process::verify_non_reparse_kind(path, true)
            .map_err(|err| TransactionError::Journal(err.to_string()))?;
        // Opens the entry as itself and proves a trusted owner. Elevation must
        // never bless an object an ordinary user owns.
        open_existing_store_directory(path)?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn check_store() -> Result<(), TransactionError> {
    Err(TransactionError::Unsupported)
}

/// Real exact-device preparation. The installed elevated helper is the only
/// intended caller.
#[cfg(windows)]
pub fn prepare_exact(spec: &PrepareSpec) -> Result<MutationResult, TransactionError> {
    if crate::process::is_elevated() != Some(true) {
        return Err(TransactionError::Windows(
            "the WinUSB helper is not elevated".to_owned(),
        ));
    }
    let _lock = MutationGuard::acquire()?;
    let store = ProgramDataStore::open()?;
    let id = transaction_id()?;
    let transaction_dir = store.transaction_dir(&id);
    let runner = PnPUtilRunner;
    let inventory = PnPUtilInventory { runner: &runner };
    let provider = super::wdi::WdiProvider::installed_sibling()?;
    let trust = WindowsTrustVerifier;
    let surveys = SystemSurvey;
    let environment = Environment {
        surveys: &surveys,
        inventory: &inventory,
        preparer: &provider,
        trust: &trust,
        runner: &runner,
        store: &store,
    };
    prepare_with(&environment, spec, &id, &transaction_dir)
}

/// Latest durable KSX ownership state for one exact interface. Read-only and
/// safe in the unelevated application after the helper exits.
#[cfg(windows)]
pub fn ownership_state(instance_id: &str) -> Result<Option<OwnershipState>, TransactionError> {
    validate_exact_instance(instance_id)?;
    let store = ProgramDataStore::open()?;
    Ok(store
        .receipts()?
        .into_iter()
        .rev()
        .find(|receipt| receipt.target_instance_id.eq_ignore_ascii_case(instance_id))
        .map(|receipt| OwnershipState {
            phase: receipt.phase,
            instance_id: receipt.target_instance_id,
            hardware_id: receipt.hardware_id,
            transaction_id: receipt.transaction_id,
            recovery_reason: receipt.recovery_reason,
        }))
}

#[cfg(not(windows))]
pub fn ownership_state(_instance_id: &str) -> Result<Option<OwnershipState>, TransactionError> {
    Err(TransactionError::Unsupported)
}

#[cfg(not(windows))]
pub fn prepare_exact(_spec: &PrepareSpec) -> Result<MutationResult, TransactionError> {
    Err(TransactionError::Unsupported)
}

#[cfg(windows)]
pub fn release_exact(spec: &ReleaseSpec) -> Result<MutationResult, TransactionError> {
    if crate::process::is_elevated() != Some(true) {
        return Err(TransactionError::Windows(
            "the WinUSB helper is not elevated".to_owned(),
        ));
    }
    let _lock = MutationGuard::acquire()?;
    let store = ProgramDataStore::open()?;
    let runner = PnPUtilRunner;
    let inventory = PnPUtilInventory { runner: &runner };
    let trust = WindowsTrustVerifier;
    let surveys = SystemSurvey;
    // Release never calls the preparer, but the environment keeps one stable
    // shape; this object is not loaded until `prepare` is actually invoked.
    struct NoPrepare;
    impl DriverPreparer for NoPrepare {
        fn prepare(&self, _: &PrepareRequest) -> Result<PreparedPaths, super::wdi::PrepareError> {
            Err(super::wdi::PrepareError::Unsupported)
        }
    }
    let no_prepare = NoPrepare;
    let environment = Environment {
        surveys: &surveys,
        inventory: &inventory,
        preparer: &no_prepare,
        trust: &trust,
        runner: &runner,
        store: &store,
    };
    release_with(&environment, spec)
}

#[cfg(windows)]
pub fn cleanup_owned() -> Result<CleanupResult, TransactionError> {
    if crate::process::is_elevated() != Some(true) {
        return Err(TransactionError::Windows(
            "the WinUSB helper is not elevated".to_owned(),
        ));
    }
    let _lock = MutationGuard::acquire()?;
    let store = ProgramDataStore::open()?;
    let runner = PnPUtilRunner;
    let inventory = PnPUtilInventory { runner: &runner };
    let trust = WindowsTrustVerifier;
    let surveys = SystemSurvey;
    struct NoPrepare;
    impl DriverPreparer for NoPrepare {
        fn prepare(&self, _: &PrepareRequest) -> Result<PreparedPaths, super::wdi::PrepareError> {
            Err(super::wdi::PrepareError::Unsupported)
        }
    }
    let no_prepare = NoPrepare;
    let environment = Environment {
        surveys: &surveys,
        inventory: &inventory,
        preparer: &no_prepare,
        trust: &trust,
        runner: &runner,
        store: &store,
    };
    cleanup_with(&environment)
}

#[cfg(not(windows))]
pub fn release_exact(_spec: &ReleaseSpec) -> Result<MutationResult, TransactionError> {
    Err(TransactionError::Unsupported)
}

#[cfg(not(windows))]
pub fn cleanup_owned() -> Result<CleanupResult, TransactionError> {
    Err(TransactionError::Unsupported)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// The store DACL must survive a round trip through Windows, because
    /// `verify_exact_dacl` compares the ACL byte for byte.
    ///
    /// It did not, and could not. `STORE_DIRECTORY_SDDL` carried GENERIC rights
    /// (`GRGX`) on an inheritable ACE; Windows maps generic bits when it stores
    /// an ACL on an object and SPLITS such an ACE into two — one effective
    /// entry for this object, one inherit-only entry keeping the generic bits:
    ///
    ///   written  ...(A;OICI;GRGX;;;BU)
    ///   stored   ...(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)
    ///
    /// Three ACEs out, four back, different sizes, never equal. So
    /// `initialize-store` refused every directory it was given INCLUDING ones
    /// it had just created itself, every install died at exit code 3, and no
    /// test noticed because nothing had ever run a successful initialization.
    ///
    /// This needs no elevation: it sets a DACL on a directory it owns.
    #[test]
    fn the_exact_store_dacl_survives_a_round_trip_through_windows() {
        let path = std::env::temp_dir().join(format!(
            "ksx-store-dacl-roundtrip-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);

        std::fs::create_dir_all(&path).expect("a scratch directory");
        let security = SecurityDescriptor::exact_store().expect("the fixed store descriptor");
        let directory = ProtectedDirectory::open(&path, true).expect("open the scratch directory");

        // `apply_exact_dacl` sets the DACL and then verifies it, which is the
        // exact pairing `initialize()` performs on every existing level. Owner
        // and group are untouched by it, so this runs without elevation —
        // `create_exact_directory` would additionally set `O:BA`, which a
        // non-elevated process may not do (error 1307).
        let verdict = directory.apply_exact_dacl(&security);

        drop(directory);
        let _ = std::fs::remove_dir_all(&path);

        verdict.expect(
            "a directory created with the exact store DACL must satisfy the exact-DACL check. \
             If this fails, STORE_DIRECTORY_SDDL asks for something Windows does not store \
             verbatim — generic rights on an inheritable ACE are the known cause — and every \
             install will refuse itself.",
        );
    }

    const TARGET: &str = r"USB\VID_D209&PID_0430&MI_00\TARGET";
    const TX: &str = "0123456789abcdef0123456789abcdef";
    const INF: &str = "ksx-winusb-0123456789abcdef0123456789abcdef.inf";
    const OEM: &str = "oem42.inf";
    const HID_CLASS: &str = "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}";

    #[derive(Default)]
    struct FakeState {
        events: Vec<String>,
        counts: HashMap<String, usize>,
        fail_at: Option<String>,
        /// Like `fail_at`, but mints `RecoveryRequired` WITHOUT persisting a
        /// phase — the shape `delete_matching` and `delete_owned_private_keys`
        /// produce, and the one that used to leave a receipt stranded in
        /// `Releasing`.
        recovery_at: Option<String>,
        receipt: Option<Receipt>,
        installed: bool,
        bound: bool,
        target_present: bool,
        duplicate_package: bool,
        add_code: i32,
        artifacts: bool,
        keys: Vec<String>,
    }

    impl FakeState {
        fn hit(&mut self, base: &str) -> Result<(), TransactionError> {
            let count = self.counts.entry(base.to_owned()).or_default();
            *count += 1;
            let event = format!("{base}#{count}");
            self.events.push(event.clone());
            if self.fail_at.as_deref() == Some(&event) {
                self.fail_at = None;
                return Err(TransactionError::Windows(format!(
                    "injected failure at {event}"
                )));
            }
            if self.recovery_at.as_deref() == Some(&event) {
                self.recovery_at = None;
                return Err(TransactionError::RecoveryRequired(format!(
                    "injected unpersisted recovery at {event}"
                )));
            }
            Ok(())
        }
    }

    fn node(
        id: &str,
        class: &str,
        service: &str,
        parent: Option<&str>,
    ) -> super::super::DeviceNode {
        super::super::DeviceNode::new(
            id,
            Some(class.to_owned()),
            Some(service.to_owned()),
            Some("test device".to_owned()),
            parent.map(str::to_owned),
        )
    }

    fn survey_of(state: &FakeState) -> Survey {
        let mut nodes = Vec::new();
        if state.target_present {
            nodes.push(node(
                TARGET,
                HID_CLASS,
                if state.bound { "WinUSB" } else { "HidUsb" },
                Some("8&target&0"),
            ));
            if !state.bound {
                nodes.push(node(
                    r"HID\VID_D209&PID_0430&MI_00\8&target&0&0000",
                    super::super::KEYBOARD_CLASS_GUID,
                    "kbdhid",
                    None,
                ));
            }
        }
        nodes.push(node(
            r"USB\VID_A11A&PID_B22B&MI_00\SPARE",
            HID_CLASS,
            "HidUsb",
            Some("8&spare&0"),
        ));
        nodes.push(node(
            r"HID\VID_A11A&PID_B22B&MI_00\8&spare&0&0000",
            super::super::KEYBOARD_CLASS_GUID,
            "kbdhid",
            None,
        ));
        Survey::from_nodes(&nodes)
    }

    fn inventory_of(state: &FakeState) -> Vec<StoreDriver> {
        if !state.installed {
            return Vec::new();
        }
        let mut drivers = vec![StoreDriver {
            published_name: OEM.to_owned(),
            original_name: INF.to_owned(),
            provider: "KSX".to_owned(),
        }];
        if state.duplicate_package {
            drivers.push(StoreDriver {
                published_name: "oem43.inf".to_owned(),
                original_name: INF.to_owned(),
                provider: "KSX".to_owned(),
            });
        }
        drivers
    }

    #[derive(Clone)]
    struct FakeSurvey(Arc<Mutex<FakeState>>);
    impl SurveySource for FakeSurvey {
        fn survey(&self) -> Result<Survey, TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("survey")?;
            Ok(survey_of(&state))
        }
    }

    #[derive(Clone)]
    struct FakeInventory(Arc<Mutex<FakeState>>);
    impl DriverInventory for FakeInventory {
        fn enumerate(&self) -> Result<Vec<StoreDriver>, TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("inventory")?;
            Ok(inventory_of(&state))
        }
    }

    #[derive(Clone)]
    struct FakePreparer(Arc<Mutex<FakeState>>);
    impl DriverPreparer for FakePreparer {
        fn prepare(
            &self,
            request: &PrepareRequest,
        ) -> Result<PreparedPaths, super::super::wdi::PrepareError> {
            if let Err(err) = self.0.lock().unwrap().hit("preparer") {
                return Err(super::super::wdi::PrepareError::Failed {
                    code: -1,
                    message: err.to_string(),
                });
            }
            Ok(PreparedPaths {
                inf_path: request.inf_path.clone(),
                catalog_path: request.inf_path.with_extension("cat"),
            })
        }
    }

    #[derive(Clone)]
    struct FakeTrust(Arc<Mutex<FakeState>>);
    impl TrustVerifier for FakeTrust {
        fn owned_private_keys(&self) -> Result<Vec<String>, TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("trust:keys")?;
            Ok(state.keys.clone())
        }

        fn verify(&self, expected: &ExpectedArtifacts) -> Result<TrustEvidence, TransactionError> {
            self.0.lock().unwrap().hit("trust:verify")?;
            Ok(TrustEvidence {
                inf_sha256: "11".repeat(32),
                catalog_sha256: "22".repeat(32),
                certificate_subject: expected.certificate_subject.clone(),
                certificate_thumbprint_sha1: "33".repeat(20),
                certificate_der_sha256: "44".repeat(32),
            })
        }

        fn cleanup(
            &self,
            _subject: &str,
            _thumbprint_sha1: Option<&str>,
            _der_sha256: Option<&str>,
        ) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("trust:cleanup")?;
            state.keys.clear();
            Ok(())
        }

        fn cleanup_owned_residue(&self) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("trust:residue")?;
            state.keys.clear();
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeRunner(Arc<Mutex<FakeState>>);
    impl CommandRunner for FakeRunner {
        fn run(&self, command: &PlannedCommand) -> Result<CommandResult, TransactionError> {
            let action = if command.args.first().is_some_and(|arg| arg == "/add-driver") {
                "add"
            } else if command
                .args
                .first()
                .is_some_and(|arg| arg == "/remove-device")
            {
                "remove"
            } else if command
                .args
                .first()
                .is_some_and(|arg| arg == "/delete-driver")
            {
                "delete"
            } else {
                "scan"
            };
            let mut state = self.0.lock().unwrap();
            if action == "add" {
                // A runner error after invocation has an unknown outcome. The
                // fake models the hard case: package and binding both landed.
                state.installed = true;
                state.bound = true;
            }
            state.hit(&format!("runner:{action}"))?;
            match action {
                "remove" => state.bound = false,
                "delete" => state.installed = false,
                _ => {}
            }
            Ok(CommandResult {
                code: if action == "add" { state.add_code } else { 0 },
                output: String::new(),
            })
        }
    }

    #[derive(Clone)]
    struct FakeStore(Arc<Mutex<FakeState>>);
    impl TransactionStore for FakeStore {
        fn begin(&self, receipt: &Receipt) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:begin")?;
            state.receipt = Some(receipt.clone());
            Ok(())
        }

        fn update(&self, receipt: &Receipt) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:update")?;
            state.receipt = Some(receipt.clone());
            Ok(())
        }

        fn write_template(
            &self,
            _receipt: &Receipt,
            _bytes: &[u8],
        ) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:template")?;
            state.artifacts = true;
            Ok(())
        }

        fn active_for(&self, instance_id: &str) -> Result<Option<Receipt>, TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:active")?;
            Ok(state.receipt.clone().filter(|receipt| {
                receipt.phase == Phase::Active
                    && receipt.target_instance_id.eq_ignore_ascii_case(instance_id)
            }))
        }

        fn owned_receipts(&self) -> Result<Vec<Receipt>, TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:receipts")?;
            Ok(state.receipt.clone().into_iter().collect())
        }

        fn cleanup_artifacts(&self, _receipt: &Receipt) -> Result<(), TransactionError> {
            let mut state = self.0.lock().unwrap();
            state.hit("store:artifacts")?;
            state.artifacts = false;
            Ok(())
        }
    }

    struct Harness {
        state: Arc<Mutex<FakeState>>,
        surveys: FakeSurvey,
        inventory: FakeInventory,
        preparer: FakePreparer,
        trust: FakeTrust,
        runner: FakeRunner,
        store: FakeStore,
    }

    impl Harness {
        fn new(fail_at: Option<&str>) -> Self {
            let state = Arc::new(Mutex::new(FakeState {
                fail_at: fail_at.map(str::to_owned),
                target_present: true,
                ..FakeState::default()
            }));
            Self {
                surveys: FakeSurvey(state.clone()),
                inventory: FakeInventory(state.clone()),
                preparer: FakePreparer(state.clone()),
                trust: FakeTrust(state.clone()),
                runner: FakeRunner(state.clone()),
                store: FakeStore(state.clone()),
                state,
            }
        }

        fn environment(&self) -> Environment<'_> {
            Environment {
                surveys: &self.surveys,
                inventory: &self.inventory,
                preparer: &self.preparer,
                trust: &self.trust,
                runner: &self.runner,
                store: &self.store,
            }
        }

        fn prepare(&self) -> Result<MutationResult, TransactionError> {
            prepare_with(
                &self.environment(),
                &PrepareSpec {
                    instance_id: TARGET.to_owned(),
                    confirm_spare_keyboard: true,
                    confirm_rebind: true,
                    confirm_machine_certificate: true,
                },
                TX,
                Path::new(
                    r"C:\ProgramData\KSX\WinUSB\transactions\0123456789abcdef0123456789abcdef",
                ),
            )
        }

        fn release(&self) -> Result<MutationResult, TransactionError> {
            release_with(
                &self.environment(),
                &ReleaseSpec {
                    instance_id: TARGET.to_owned(),
                    confirm_release: true,
                },
            )
        }

        fn phase(&self) -> Option<Phase> {
            self.state.lock().unwrap().receipt.as_ref().map(|r| r.phase)
        }
    }

    /// A release that ends in recovery must SAY so in the receipt.
    ///
    /// `set_recovery` persists the phase; `delete_matching` and
    /// `delete_owned_private_keys` mint `RecoveryRequired` directly and do
    /// not. Those used to pass through `rollback_installed` untouched, leaving
    /// the receipt on `Releasing` — a phase the backend treats as neither
    /// success nor recovery, so the user was told the release failed after the
    /// driver had already been rebound. Four such receipts were found on the
    /// machine that reported it, each beside a keyboard that typed perfectly.
    ///
    /// Fails against that version: the assertion below reads `Releasing`.
    #[test]
    fn a_release_that_ends_in_recovery_records_recovery_not_releasing() {
        let harness = Harness::new(None);
        harness.prepare().expect("prepare reaches Active");
        assert_eq!(harness.phase(), Some(Phase::Active));

        // Certificate cleanup is the step that mints an unpersisted
        // RecoveryRequired, and it runs after the rebind has committed.
        harness.state.lock().unwrap().recovery_at = Some("trust:cleanup#1".to_owned());

        let err = harness.release().expect_err("release cannot verify");
        assert!(
            matches!(err, TransactionError::RecoveryRequired(_)),
            "{err:?}"
        );
        assert_eq!(
            harness.phase(),
            Some(Phase::RecoveryRequired),
            "the receipt must record where the transaction ended; `Releasing` is \
             neither success nor recovery and the backend reports it as a generic failure"
        );
        let reason = harness
            .state
            .lock()
            .unwrap()
            .receipt
            .as_ref()
            .and_then(|r| r.recovery_reason.clone())
            .expect("a persisted recovery carries its reason");
        assert!(reason.contains("trust:cleanup#1"), "{reason}");
    }

    #[test]
    fn every_prepare_only_fault_after_begin_converges_to_rolled_back() {
        for fault in [
            "store:template#1",
            "preparer#1",
            "trust:verify#1",
            "store:update#1",
            "survey#2",
            "store:update#2",
        ] {
            let harness = Harness::new(Some(fault));
            harness.prepare().expect_err(fault);
            let state = harness.state.lock().unwrap();
            assert_eq!(
                state.receipt.as_ref().unwrap().phase,
                Phase::RolledBack,
                "{fault}"
            );
            assert!(!state.installed, "{fault}");
            assert!(!state.bound, "{fault}");
            assert!(!state.artifacts, "{fault}");
            assert!(
                !state
                    .events
                    .iter()
                    .any(|event| event.starts_with("runner:add")),
                "{fault}: mutation must not be reached"
            );
        }
    }

    #[test]
    fn every_unknown_or_post_mutation_fault_runs_ordered_compensation() {
        for fault in [
            "runner:add#1",
            "inventory#2",
            "store:update#3",
            "runner:scan#1",
            "survey#3",
            "store:update#4",
        ] {
            let harness = Harness::new(Some(fault));
            harness.prepare().expect_err(fault);
            let state = harness.state.lock().unwrap();
            assert_eq!(
                state.receipt.as_ref().unwrap().phase,
                Phase::RolledBack,
                "{fault}"
            );
            assert!(!state.installed, "{fault}");
            assert!(!state.bound, "{fault}");
            assert!(!state.artifacts, "{fault}");
            let remove = state
                .events
                .iter()
                .position(|event| event.starts_with("runner:remove"))
                .expect(fault);
            let delete = state
                .events
                .iter()
                .position(|event| event.starts_with("runner:delete"))
                .expect(fault);
            let cleanup = state
                .events
                .iter()
                .position(|event| event.starts_with("trust:cleanup"))
                .expect(fault);
            assert!(
                remove < delete && delete < cleanup,
                "{fault}: {:?}",
                state.events
            );
        }
    }

    #[test]
    fn reboot_records_exact_oem_before_recovery_and_leaves_mutation_intact() {
        let harness = Harness::new(None);
        harness.state.lock().unwrap().add_code = 3010;
        let error = harness.prepare().expect_err("reboot is recovery");
        assert!(matches!(error, TransactionError::RecoveryRequired(_)));
        let state = harness.state.lock().unwrap();
        let receipt = state.receipt.as_ref().unwrap();
        assert_eq!(receipt.phase, Phase::RecoveryRequired);
        assert_eq!(receipt.published_oem_inf.as_deref(), Some(OEM));
        assert!(receipt.driver_mutation_attempted);
        assert!(state.installed && state.bound);
        assert!(!state
            .events
            .iter()
            .any(|event| event.starts_with("runner:delete")));
    }

    #[test]
    fn reboot_plus_inventory_failure_retries_identity_but_never_live_rolls_back() {
        let harness = Harness::new(Some("inventory#2"));
        harness.state.lock().unwrap().add_code = 3010;
        let error = harness.prepare().expect_err("reboot plus inventory fault");
        assert!(matches!(error, TransactionError::RecoveryRequired(_)));
        let state = harness.state.lock().unwrap();
        let receipt = state.receipt.as_ref().unwrap();
        assert_eq!(receipt.phase, Phase::RecoveryRequired);
        assert_eq!(receipt.published_oem_inf.as_deref(), Some(OEM));
        assert!(receipt.reboot_reported);
        assert!(state.installed && state.bound);
        assert!(!state
            .events
            .iter()
            .any(|event| event.starts_with("runner:remove")));
        assert!(!state
            .events
            .iter()
            .any(|event| event.starts_with("runner:delete")));
    }

    #[test]
    fn every_rollback_boundary_fault_becomes_recovery_required() {
        for fault in [
            "inventory#3",
            "survey#3",
            "store:update#5",
            "runner:remove#1",
            "runner:delete#1",
            "inventory#4",
            "runner:scan#1",
            "survey#4",
            "trust:cleanup#1",
            "trust:keys#2",
            "store:artifacts#1",
            "store:update#6",
        ] {
            let harness = Harness::new(Some(fault));
            harness.state.lock().unwrap().add_code = 5;
            let error = harness.prepare().expect_err(fault);
            assert!(
                matches!(error, TransactionError::RecoveryRequired(_)),
                "{fault}: {error}"
            );
            let state = harness.state.lock().unwrap();
            assert_eq!(
                state.receipt.as_ref().unwrap().phase,
                Phase::RecoveryRequired,
                "{fault}: {:?}",
                state.events
            );
        }
    }

    #[test]
    fn ambiguous_post_mutation_inventory_is_recovery_not_guessing() {
        let harness = Harness::new(None);
        harness.state.lock().unwrap().duplicate_package = true;
        let error = harness.prepare().expect_err("ambiguous inventory");
        assert!(matches!(error, TransactionError::RecoveryRequired(_)));
        let state = harness.state.lock().unwrap();
        assert_eq!(
            state.receipt.as_ref().unwrap().phase,
            Phase::RecoveryRequired
        );
        assert!(
            state.installed,
            "ambiguous packages are preserved for recovery"
        );
    }

    #[test]
    fn uninstall_recovers_nonterminal_disconnected_receipt_and_all_residue() {
        let harness = Harness::new(None);
        harness.prepare().expect("first prepare reaches active");
        {
            let mut state = harness.state.lock().unwrap();
            state.target_present = false;
            state.artifacts = true;
            state.keys = vec!["KSX-libwdi-0123456789abcdef0123456789abcdef".to_owned()];
            let receipt = state.receipt.as_mut().unwrap();
            receipt.phase = Phase::RecoveryRequired;
            receipt.recovery_reason = Some("injected crash".to_owned());
        }
        let result = cleanup_with(&harness.environment()).expect("recover all owned residue");
        assert_eq!(result.phase, Phase::Released);
        assert_eq!(result.cleaned_receipts, 1);
        assert_eq!(result.disconnected_receipts, 1);
        let state = harness.state.lock().unwrap();
        assert_eq!(state.receipt.as_ref().unwrap().phase, Phase::Released);
        assert!(!state.installed && !state.artifacts);
        assert!(
            !state.target_present,
            "the disconnected target was not invented"
        );
        assert!(state.keys.is_empty());
    }

    #[test]
    fn receipt_enumeration_failure_is_recovery_required_not_empty_success() {
        let harness = Harness::new(Some("store:receipts#1"));
        let error = cleanup_with(&harness.environment()).expect_err("enumeration failed");
        assert!(matches!(error, TransactionError::RecoveryRequired(_)));
    }

    #[test]
    fn global_mutation_wait_is_bounded() {
        assert_eq!(MUTATION_WAIT_MS, 300_000);
        let source = include_str!("winusb_transaction.rs");
        let acquire = source
            .split("fn acquire()")
            .nth(1)
            .expect("mutex acquire")
            .split("impl Drop for MutationGuard")
            .next()
            .unwrap();
        assert!(!acquire.contains("INFINITE"));
    }
}
