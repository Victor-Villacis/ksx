//! Surface-facing I-PAC programmer.
//!
//! The parent module owns the injected, pure protocol and transaction core.
//! This layer is the single composition root that may enumerate a board, open
//! its exact configuration collection, acquire the cross-process lock, choose
//! the backup store, and translate typed API views. CLI and Studio both call
//! these functions; neither surface can assemble or replay raw chart bytes.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ksx_api::{
    PanelBackupRow, PanelBackupsView, PanelByteDiffRow, PanelChartView, PanelDriverCapabilities,
    PanelKeyOption, PanelKeyValue, PanelProgramOutcome, PanelProgramPlanView,
    PanelRoutingAuthoritySpec, PanelRoutingGuard, PanelShiftState, PanelStatusRow,
    PanelTerminalDiffRow, PanelTerminalRow, Refusal,
};
use ksx_core::{DeviceSelector, Key, Match};
use ksx_platform::hid_report::{
    HidReportDevice, HidReportError, HidReportIdentity, HID_REPORT_BYTES,
};

use super::*;
use crate::panel_catalog::{profile_for, PanelProtocolDriver, PanelProtocolProfile};

pub use ksx_api::{
    PanelBackupsSpec, PanelChartSpec, PanelProgramApplySpec, PanelProgramSpec,
    PanelRestoreApplySpec, PanelRestoreSpec, PanelTerminalEdit,
};

const BACKUP_DIR: &str = "panel-backups";
const TRANSACTION_SCHEMA: &str = "ksx.panel-transaction.v1";
const PENDING_TRANSACTION_FILE: &str = "panel-transaction.pending.json";
const TRANSACTION_RECEIPT_EXTENSION: &str = ".ksxpanel-transaction.json";
const MAX_PRIOR_TRANSACTIONS: usize = 32;
const QUALIFICATION_SCHEMA: &str = "ksx.panel-qualification.v1";
const PENDING_QUALIFICATION_FILE: &str = "panel-qualification.pending.json";
const VERIFIED_QUALIFICATION_FILE: &str = "panel-qualification.verified.json";

struct SelectedPanel {
    board_id: String,
    name: String,
    device_path: String,
    input_instance: String,
    staged_selector_names_input: bool,
    identity: BoardIdentity,
    profile: &'static PanelProtocolProfile,
}

struct HidIo(HidReportDevice);

/// Routing owns both exclusion layers until the daemon has committed its
/// staged binding. Fields drop in declaration order: close the exclusive
/// MI_02 configuration handle first, then release the machine-wide lease, so
/// another process can never acquire the lease while this transaction still
/// owns the live collection.
struct LivePanelRoutingGuard {
    _configuration_handle: HidIo,
    _programming_lease: PanelProgrammingLease,
}

impl PanelRoutingGuard for LivePanelRoutingGuard {}

impl PanelReportIo for HidIo {
    fn send_report(&mut self, report: &[u8]) -> Result<(), ReportIoError> {
        let report: [u8; HID_REPORT_BYTES] = report.try_into().map_err(|_| {
            ReportIoError::new(format!(
                "refused a {}-byte output report; this collection requires exactly {HID_REPORT_BYTES}",
                report.len()
            ))
        })?;
        self.0
            .send_output_report(report)
            .map_err(report_transport_error)
    }

    fn receive_report(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>, ReportIoError> {
        match self.0.read_input_report(timeout) {
            Ok(report) => Ok(Some(report.to_vec())),
            Err(HidReportError::ReadTimedOut { .. }) => Ok(None),
            Err(error) => Err(report_transport_error(error)),
        }
    }
}

fn report_transport_error(error: HidReportError) -> ReportIoError {
    ReportIoError::new(error.to_string())
}

fn acquire_programming_lease(config_dir: &Path) -> Result<PanelProgrammingLease, Refusal> {
    let recovery_root = panel_recovery_root(config_dir)?;
    // The non-Windows lease is a filesystem sentinel. Keep it beside, never
    // beneath, the recovery tree: a passive status read must not call
    // `create_dir_all` through a substituted `panel-backups` symlink before
    // the shared path-integrity walk has had a chance to reject that tree.
    #[cfg(windows)]
    let lease_root = recovery_root.as_path();
    #[cfg(not(windows))]
    let lease_root = recovery_root.parent().ok_or_else(|| {
        refused(
            "KSX cannot resolve a safe parent for the panel programming lease; nothing was changed",
            "restore the installed configuration directory, then retry",
        )
    })?;
    PanelProgrammingLease::acquire(lease_root).map_err(|error| {
        refused(
            format!(
                "another KSX panel operation or Play start owns the hardware lease ({error}); nothing was changed"
            ),
            "finish the other panel operation or stop Play, then retry this one",
        )
    })
}

/// Acquire the same machine lease as persistent encoder maintenance and then
/// prove no interrupted hardware transaction is still awaiting recovery.
///
/// The order is load-bearing: checking the journal before taking the lease
/// would let a programmer create `panel-transaction.pending.json` between the
/// check and packet zero. Daemon Play and standalone run/play both funnel
/// through this guard before opening a capture backend or virtual pad.
pub(crate) fn acquire_play_start_guard(
    config_dir: &Path,
) -> Result<PanelProgrammingLease, Refusal> {
    let lease = acquire_programming_lease(config_dir)?;
    require_no_pending_panel_transactions(config_dir)?;
    Ok(lease)
}

/// EEPROM recovery belongs to the physical machine, not to the movable
/// portable/config root. Daemon and Studio are separate processes, and a
/// portable marker can appear, disappear or differ beside their executables.
/// Every production process therefore pins the installed recovery directory
/// once; chart backup, program, restore, journals and Play all ask this same
/// authority. Tests retain an injected root so parallel fixtures stay apart.
#[derive(Default)]
struct PanelRecoveryRootAuthority(std::sync::OnceLock<PathBuf>);

impl PanelRecoveryRootAuthority {
    fn resolve(
        &self,
        discover_installed: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<PathBuf, Refusal> {
        if let Some(root) = self.0.get() {
            return Ok(root.clone());
        }
        let installed = discover_installed().ok_or_else(|| {
            Refusal::with_remedy(
                ksx_api::codes::RECOVERY_REQUIRED,
                "KSX cannot resolve the machine-scoped panel recovery root; persistent encoder recovery cannot proceed safely",
                "keep Play stopped; restore this account's installed config directory, then run `ksx panel chart --backup` before Play",
            )
        })?;
        let candidate = installed.join(BACKUP_DIR);
        let _ = self.0.set(candidate);
        Ok(self
            .0
            .get()
            .expect("panel recovery root was initialized")
            .clone())
    }
}

#[cfg(not(test))]
fn panel_recovery_root(_config_dir: &Path) -> Result<PathBuf, Refusal> {
    static AUTHORITY: std::sync::OnceLock<PanelRecoveryRootAuthority> = std::sync::OnceLock::new();
    AUTHORITY
        .get_or_init(PanelRecoveryRootAuthority::default)
        .resolve(ksx_config::installed_config_dir)
}

#[cfg(test)]
fn panel_recovery_root(config_dir: &Path) -> Result<PathBuf, Refusal> {
    Ok(config_dir.join(BACKUP_DIR))
}

fn require_no_pending_panel_transactions(config_dir: &Path) -> Result<(), Refusal> {
    let backup_root = panel_recovery_root(config_dir)?;
    require_no_pending_panel_transactions_at(&backup_root)
}

fn require_no_pending_panel_transactions_at(backup_root: &Path) -> Result<(), Refusal> {
    let pending_paths = pending_panel_transaction_paths_at(backup_root)?;
    let Some(pending_path) = pending_paths.first() else {
        return Ok(());
    };
    Err(pending_play_start_refusal(
        pending_path,
        pending_paths.len(),
    ))
}

/// Inventory durable transaction markers while proving that every path level
/// which can redirect the recovery decision is an ordinary filesystem object.
/// Passive status and Play/start share this walk so neither surface can call a
/// substituted recovery tree "settled" while the other refuses it.
fn pending_panel_transaction_paths_at(backup_root: &Path) -> Result<Vec<PathBuf>, Refusal> {
    let backup_metadata = match std::fs::symlink_metadata(backup_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(panel_recovery_store_refusal(backup_root, &error)),
    };
    require_plain_recovery_directory(backup_root, &backup_metadata, "panel backup root")?;
    let driver_dirs = std::fs::read_dir(backup_root)
        .map_err(|error| panel_recovery_store_refusal(backup_root, &error))?;

    let mut pending_paths = Vec::new();
    for driver in driver_dirs {
        let driver = driver.map_err(|error| panel_recovery_store_refusal(backup_root, &error))?;
        let driver_path = driver.path();
        let driver_metadata = std::fs::symlink_metadata(&driver_path)
            .map_err(|error| panel_recovery_store_refusal(&driver.path(), &error))?;
        require_plain_recovery_directory(&driver_path, &driver_metadata, "panel driver level")?;
        let board_root = driver_path;
        let boards = std::fs::read_dir(&board_root)
            .map_err(|error| panel_recovery_store_refusal(&board_root, &error))?;
        for board in boards {
            let board = board.map_err(|error| panel_recovery_store_refusal(&board_root, &error))?;
            let board_path = board.path();
            let board_metadata = std::fs::symlink_metadata(&board_path)
                .map_err(|error| panel_recovery_store_refusal(&board.path(), &error))?;
            require_plain_recovery_directory(&board_path, &board_metadata, "panel board level")?;
            let pending = board_path.join(PENDING_TRANSACTION_FILE);
            match std::fs::symlink_metadata(&pending) {
                Ok(metadata) if metadata.is_file() && !metadata_is_reparse(&metadata) => {
                    pending_paths.push(pending)
                }
                Ok(_) => {
                    return Err(Refusal::with_remedy(
                        ksx_api::codes::RECOVERY_REQUIRED,
                        "Play/start is blocked because a panel transaction recovery marker is not an ordinary non-reparse file, so KSX cannot prove the encoder is settled",
                        "keep Play stopped; preserve the panel-backups folder, restore its filesystem integrity, then run `ksx panel chart --backup` (add `--device QUERY` when needed), then restore the exact safety backup",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(panel_recovery_store_refusal(&pending, &error)),
            }
        }
    }

    pending_paths.sort();
    Ok(pending_paths)
}

fn require_plain_recovery_directory(
    path: &Path,
    metadata: &std::fs::Metadata,
    level: &str,
) -> Result<(), Refusal> {
    if metadata.is_dir() && !metadata_is_reparse(metadata) {
        return Ok(());
    }
    Err(Refusal::with_remedy(
        ksx_api::codes::RECOVERY_REQUIRED,
        format!(
            "Play/start is blocked because the {level} is not an ordinary non-reparse directory ({}); KSX will not follow a symlink, junction, or substitute object while deciding whether panel recovery is pending",
            path.display()
        ),
        "keep Play stopped; preserve the real panel-backups folder, replace the symlink/junction/wrong-kind object with its expected ordinary directory, then run `ksx panel chart --backup` (add `--device QUERY` when needed) or restore the exact safety backup",
    ))
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn panel_recovery_store_refusal(path: &Path, error: &std::io::Error) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::RECOVERY_REQUIRED,
        format!(
            "Play/start is blocked because KSX could not prove the panel recovery store is settled ({}: {error})",
            path.display()
        ),
        "keep Play stopped; restore access to the panel-backups folder, then run `ksx panel chart --backup` (add `--device QUERY` when needed), then restore the exact safety backup",
    )
}

fn pending_play_start_refusal(path: &Path, pending_count: usize) -> Refusal {
    let pending = std::fs::read(path)
        .map_err(|error| panel_recovery_store_refusal(path, &error))
        .and_then(|raw| {
            serde_json::from_slice::<PendingPanelTransaction>(&raw)
                .map_err(|error| unreadable_pending_refusal(error.to_string()))
        })
        .and_then(|pending| {
            let current = &pending.current;
            if pending.schema != TRANSACTION_SCHEMA
                || pending.profile != IPAC4_PROTOCOL_PROFILE
                || !safe_transaction_component(&current.transaction_id)
                || !matches!(current.operation.as_str(), "program" | "restore")
                || BackupId::new(current.safety_backup_id.clone()).is_err()
            {
                Err(unreadable_pending_refusal(
                    "its recovery contract fields are invalid",
                ))
            } else {
                Ok(pending)
            }
        });

    match pending {
        Ok(pending) => {
            let more = pending_count.saturating_sub(1);
            let suffix = if more == 0 {
                String::new()
            } else {
                format!("; {more} additional pending panel transaction(s) also require recovery")
            };
            Refusal::with_remedy(
                ksx_api::codes::RECOVERY_REQUIRED,
                format!(
                    "Play/start is blocked because panel transaction {} ({}) is unresolved{suffix}; the encoder may not match its last verified chart",
                    pending.current.transaction_id, pending.current.operation
                ),
                format!(
                    "keep Play stopped; run `ksx panel chart --backup` (adding `--device QUERY` when needed) to reconcile a stable full-chart read, or restore exact safety backup {}",
                    pending.current.safety_backup_id
                ),
            )
        }
        Err(refusal) => refusal,
    }
}

fn unreadable_pending_refusal(detail: impl std::fmt::Display) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::RECOVERY_REQUIRED,
        format!(
            "Play/start is blocked because a durable panel transaction journal is present but cannot be interpreted ({detail})"
        ),
        "keep Play stopped and preserve the panel-backups folder; run `ksx panel chart --backup` (add `--device QUERY` when needed) or restore the exact safety backup after the journal is repaired",
    )
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct PanelTransactionSnapshot {
    transaction_id: String,
    operation: String,
    created_at: String,
    base_sha256: String,
    desired_sha256: String,
    safety_backup_id: String,
    /// Present only for the first-use one-terminal writer test.  Keeping the
    /// intent in the pre-packet durable journal closes the crash window before
    /// the later qualification receipt can be written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    qualification_terminal: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct PendingPanelTransaction {
    schema: String,
    profile: String,
    driver: String,
    board_fingerprint: String,
    bcd_device: u16,
    current: PanelTransactionSnapshot,
    #[serde(default)]
    prior_unresolved: Vec<PanelTransactionSnapshot>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct PendingPanelQualification {
    schema: String,
    profile: String,
    driver: String,
    board_fingerprint: String,
    bcd_device: u16,
    created_at: String,
    terminal_id: String,
    base_sha256: String,
    validation_sha256: String,
    safety_backup_id: String,
    /// True only after the complete desired test chart was observed. A
    /// partial/unknown first write must be restored for safety, then repeated;
    /// it cannot qualify the full writer.
    write_verified: bool,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct VerifiedPanelQualification {
    schema: String,
    profile: String,
    driver: String,
    board_fingerprint: String,
    bcd_device: u16,
    qualified_at: String,
    terminal_id: String,
    base_sha256: String,
    validation_sha256: String,
    restored_sha256: String,
    safety_backup_id: String,
}

#[derive(Clone, Debug)]
enum PanelQualificationState {
    Required,
    ValidationWritten(Box<PendingPanelQualification>),
    Qualified,
}

impl PanelQualificationState {
    fn api_state(&self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::ValidationWritten(pending) if pending.write_verified => "validation-written",
            Self::ValidationWritten(_) => "validation-recovery",
            Self::Qualified => "qualified",
        }
    }

    fn detail(&self) -> String {
        match self {
            Self::Required => "Before a full chart can be programmed, change one noncritical normal terminal to a safe letter or top-row number and restore its exact safety backup. This proves both write and recovery on this physical encoder.".to_owned(),
            Self::ValidationWritten(pending) if pending.write_verified => format!(
                    "The one-terminal validation write verified. Restore safety backup {} to prove recovery and unlock full-chart programming.",
                    pending.safety_backup_id
                ),
            Self::ValidationWritten(pending) => format!(
                    "The first validation write was interrupted or did not reach its complete reviewed chart. Restore safety backup {} before retrying the one-terminal test; this recovery will not unlock full-chart programming.",
                    pending.safety_backup_id
                ),
            Self::Qualified => "This physical encoder completed a verified one-terminal write and verified restore; full-chart programming is unlocked.".to_owned(),
        }
    }

    fn restore_backup_id(&self) -> Option<String> {
        match self {
            Self::ValidationWritten(pending) => Some(pending.safety_backup_id.clone()),
            Self::Required | Self::Qualified => None,
        }
    }
}

struct PanelQualificationStore {
    dir: PathBuf,
}

impl PanelQualificationStore {
    fn new(store: &BackupStore, identity: &BoardIdentity) -> Self {
        Self {
            dir: store.board_dir(identity),
        }
    }

    fn pending_path(&self) -> PathBuf {
        self.dir.join(PENDING_QUALIFICATION_FILE)
    }

    fn verified_path(&self) -> PathBuf {
        self.dir.join(VERIFIED_QUALIFICATION_FILE)
    }

    fn state(
        &self,
        backups: &mut BackupStore,
        identity: &BoardIdentity,
    ) -> Result<PanelQualificationState, BackupError> {
        if let Some(verified) =
            self.read_json::<VerifiedPanelQualification>(&self.verified_path())?
        {
            self.validate_verified(&verified, identity)?;
            return Ok(PanelQualificationState::Qualified);
        }
        let Some(pending) = self.read_json::<PendingPanelQualification>(&self.pending_path())?
        else {
            return Ok(PanelQualificationState::Required);
        };
        self.validate_pending(&pending, backups, identity)?;
        Ok(PanelQualificationState::ValidationWritten(Box::new(
            pending,
        )))
    }

    fn read_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &Path,
    ) -> Result<Option<T>, BackupError> {
        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(BackupError::Io {
                    path: path.to_owned(),
                    source,
                })
            }
        };
        serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|source| BackupError::Json {
                path: path.to_owned(),
                source,
            })
    }

    fn validate_identity(
        schema: &str,
        profile: &str,
        driver: &str,
        board_fingerprint: &str,
        bcd_device: u16,
        identity: &BoardIdentity,
    ) -> Result<(), BackupError> {
        if schema != QUALIFICATION_SCHEMA
            || profile != IPAC4_PROTOCOL_PROFILE
            || driver != identity.driver
            || board_fingerprint != identity.fingerprint
            || bcd_device != identity.bcd_device
        {
            return Err(BackupError::InvalidDocument(
                "the panel qualification receipt does not match this exact physical board/profile"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    fn validate_pending(
        &self,
        pending: &PendingPanelQualification,
        backups: &mut BackupStore,
        identity: &BoardIdentity,
    ) -> Result<(), BackupError> {
        Self::validate_identity(
            &pending.schema,
            &pending.profile,
            &pending.driver,
            &pending.board_fingerprint,
            pending.bcd_device,
            identity,
        )?;
        validate_sha256(&pending.base_sha256, "qualification base_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        validate_sha256(
            &pending.validation_sha256,
            "qualification validation_sha256",
        )
        .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        if ipac4_terminal(&pending.terminal_id).is_none() {
            return Err(BackupError::InvalidDocument(
                "the panel qualification names an unknown terminal".to_owned(),
            ));
        }
        let backup_id = BackupId::new(pending.safety_backup_id.clone())?;
        let backup = backups.load_verified(identity, &backup_id)?;
        if !backup
            .image
            .sha256()
            .eq_ignore_ascii_case(&pending.base_sha256)
        {
            return Err(BackupError::InvalidDocument(
                "the panel qualification is not bound to its exact safety backup".to_owned(),
            ));
        }
        Ok(())
    }

    fn validate_verified(
        &self,
        verified: &VerifiedPanelQualification,
        identity: &BoardIdentity,
    ) -> Result<(), BackupError> {
        Self::validate_identity(
            &verified.schema,
            &verified.profile,
            &verified.driver,
            &verified.board_fingerprint,
            verified.bcd_device,
            identity,
        )?;
        validate_sha256(
            &verified.validation_sha256,
            "qualification validation_sha256",
        )
        .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        validate_sha256(&verified.base_sha256, "qualification base_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        validate_sha256(&verified.restored_sha256, "qualification restored_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        let _ = BackupId::new(verified.safety_backup_id.clone())?;
        if ipac4_terminal(&verified.terminal_id).is_none()
            || !verified
                .restored_sha256
                .eq_ignore_ascii_case(&verified.base_sha256)
        {
            return Err(BackupError::InvalidDocument(
                "the verified panel qualification receipt is internally inconsistent".to_owned(),
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // One immutable receipt binds every transaction identity dimension.
    fn record_validation(
        &self,
        identity: &BoardIdentity,
        terminal_id: &str,
        base_sha256: &str,
        validation_sha256: &str,
        safety_backup: &StoredBackup,
        write_verified: bool,
        timestamp: Timestamp,
    ) -> Result<PendingPanelQualification, BackupError> {
        let pending = PendingPanelQualification {
            schema: QUALIFICATION_SCHEMA.to_owned(),
            profile: IPAC4_PROTOCOL_PROFILE.to_owned(),
            driver: identity.driver.clone(),
            board_fingerprint: identity.fingerprint.clone(),
            bcd_device: identity.bcd_device,
            created_at: timestamp_rfc3339(timestamp),
            terminal_id: terminal_id.to_owned(),
            base_sha256: base_sha256.to_owned(),
            validation_sha256: validation_sha256.to_owned(),
            safety_backup_id: safety_backup.id.as_str().to_owned(),
            write_verified,
        };
        self.write_json_no_replace(&self.pending_path(), &pending)?;
        Ok(pending)
    }

    fn complete(
        &self,
        identity: &BoardIdentity,
        pending: &PendingPanelQualification,
        restored_sha256: &str,
        timestamp: Timestamp,
    ) -> Result<bool, BackupError> {
        if !restored_sha256.eq_ignore_ascii_case(&pending.base_sha256) {
            return Err(BackupError::InvalidDocument(
                "the qualification restore did not return to the validation baseline".to_owned(),
            ));
        }
        if pending.write_verified {
            let verified = VerifiedPanelQualification {
                schema: QUALIFICATION_SCHEMA.to_owned(),
                profile: IPAC4_PROTOCOL_PROFILE.to_owned(),
                driver: identity.driver.clone(),
                board_fingerprint: identity.fingerprint.clone(),
                bcd_device: identity.bcd_device,
                qualified_at: timestamp_rfc3339(timestamp),
                terminal_id: pending.terminal_id.clone(),
                base_sha256: pending.base_sha256.clone(),
                validation_sha256: pending.validation_sha256.clone(),
                restored_sha256: restored_sha256.to_owned(),
                safety_backup_id: pending.safety_backup_id.clone(),
            };
            self.write_json_no_replace(&self.verified_path(), &verified)?;
        }
        match std::fs::remove_file(self.pending_path()) {
            Ok(()) => sync_parent_directory(&self.pending_path())?,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                sync_parent_directory(&self.pending_path())?;
            }
            Err(source) => {
                return Err(BackupError::Io {
                    path: self.pending_path(),
                    source,
                })
            }
        }
        Ok(pending.write_verified)
    }

    fn write_json_no_replace<T: serde::Serialize>(
        &self,
        destination: &Path,
        value: &T,
    ) -> Result<(), BackupError> {
        std::fs::create_dir_all(&self.dir).map_err(|source| BackupError::Io {
            path: self.dir.clone(),
            source,
        })?;
        let mut rendered =
            serde_json::to_vec_pretty(value).map_err(|source| BackupError::Json {
                path: destination.to_owned(),
                source,
            })?;
        rendered.push(b'\n');
        let temp = create_transaction_temp(&self.dir)?;
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&temp)
                .map_err(|source| BackupError::Io {
                    path: temp.clone(),
                    source,
                })?;
            file.write_all(&rendered)
                .and_then(|_| file.sync_all())
                .map_err(|source| BackupError::Io {
                    path: temp.clone(),
                    source,
                })
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
        if let Err(source) = finalize_backup_no_replace(&temp, destination) {
            let _ = std::fs::remove_file(&temp);
            return Err(BackupError::Io {
                path: destination.to_owned(),
                source,
            });
        }
        sync_parent_directory(destination)
    }
}

struct PanelTransactionJournal {
    dir: PathBuf,
}

impl PanelTransactionJournal {
    fn new(store: &BackupStore, identity: &BoardIdentity) -> Self {
        Self {
            dir: store.board_dir(identity),
        }
    }

    fn pending_path(&self) -> PathBuf {
        self.dir.join(PENDING_TRANSACTION_FILE)
    }

    fn load_pending(
        &self,
        store: &mut BackupStore,
        identity: &BoardIdentity,
    ) -> Result<Option<PendingPanelTransaction>, BackupError> {
        let path = self.pending_path();
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(BackupError::Io { path, source }),
        };
        let pending: PendingPanelTransaction =
            serde_json::from_slice(&raw).map_err(|source| BackupError::Json {
                path: path.clone(),
                source,
            })?;
        self.validate_pending(&pending, store, identity)?;
        Ok(Some(pending))
    }

    fn validate_pending(
        &self,
        pending: &PendingPanelTransaction,
        store: &mut BackupStore,
        identity: &BoardIdentity,
    ) -> Result<(), BackupError> {
        if pending.schema != TRANSACTION_SCHEMA
            || pending.profile != IPAC4_PROTOCOL_PROFILE
            || pending.driver != identity.driver
            || pending.board_fingerprint != identity.fingerprint
            || pending.bcd_device != identity.bcd_device
            || pending.prior_unresolved.len() > MAX_PRIOR_TRANSACTIONS
        {
            return Err(BackupError::InvalidDocument(
                "the pending panel transaction does not match this exact board/profile".to_owned(),
            ));
        }
        for snapshot in std::iter::once(&pending.current).chain(&pending.prior_unresolved) {
            if !safe_transaction_component(&snapshot.transaction_id) {
                return Err(BackupError::InvalidDocument(
                    "the pending panel transaction id is not one safe filename component"
                        .to_owned(),
                ));
            }
            validate_sha256(&snapshot.base_sha256, "pending base_sha256")
                .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
            validate_sha256(&snapshot.desired_sha256, "pending desired_sha256")
                .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
            if !matches!(snapshot.operation.as_str(), "program" | "restore") {
                return Err(BackupError::InvalidDocument(
                    "the pending panel transaction has an unknown operation".to_owned(),
                ));
            }
            if let Some(terminal) = snapshot.qualification_terminal.as_deref() {
                let action = terminal.trim_start_matches(char::is_numeric);
                if snapshot.operation != "program"
                    || ipac4_terminal(terminal).is_none()
                    || !action.starts_with("sw")
                {
                    return Err(BackupError::InvalidDocument(
                        "the pending panel writer qualification intent is invalid".to_owned(),
                    ));
                }
            }
            let backup_id = BackupId::new(snapshot.safety_backup_id.clone())?;
            let backup = store.load_verified(identity, &backup_id)?;
            if !backup
                .image
                .sha256()
                .eq_ignore_ascii_case(&snapshot.base_sha256)
            {
                return Err(BackupError::InvalidDocument(format!(
                    "pending transaction {} is not bound to its safety backup",
                    snapshot.transaction_id
                )));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // The journal deliberately captures the complete pre-packet authorization.
    fn begin(
        &self,
        identity: &BoardIdentity,
        operation: &str,
        base_sha256: &str,
        desired_sha256: &str,
        safety_backup: &StoredBackup,
        timestamp: Timestamp,
        prior: Option<PendingPanelTransaction>,
        qualification_terminal: Option<&str>,
    ) -> Result<PendingPanelTransaction, BackupError> {
        validate_sha256(base_sha256, "transaction base_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        validate_sha256(desired_sha256, "transaction desired_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        if operation == "program" && prior.is_some() {
            return Err(BackupError::InvalidDocument(
                "an unresolved panel transaction blocks new programming".to_owned(),
            ));
        }
        let mut identity_hasher = Sha256::new();
        identity_hasher.update(safety_backup.id.as_str().as_bytes());
        let backup_nonce = hex_upper(&identity_hasher.finish());
        let transaction_id = format!(
            "{}-{operation}-{}-{}",
            timestamp.backup_suffix(),
            desired_sha256[..12].to_ascii_lowercase(),
            backup_nonce[..8].to_ascii_lowercase(),
        );
        let current = PanelTransactionSnapshot {
            transaction_id,
            operation: operation.to_owned(),
            created_at: timestamp_rfc3339(timestamp),
            base_sha256: base_sha256.to_owned(),
            desired_sha256: desired_sha256.to_owned(),
            safety_backup_id: safety_backup.id.as_str().to_owned(),
            qualification_terminal: qualification_terminal.map(str::to_owned),
        };
        let mut prior_unresolved = Vec::new();
        if let Some(prior) = prior {
            prior_unresolved.push(prior.current);
            prior_unresolved.extend(prior.prior_unresolved);
        }
        if prior_unresolved.len() > MAX_PRIOR_TRANSACTIONS {
            return Err(BackupError::InvalidDocument(format!(
                "more than {MAX_PRIOR_TRANSACTIONS} unresolved recovery attempts require manual inspection"
            )));
        }
        let pending = PendingPanelTransaction {
            schema: TRANSACTION_SCHEMA.to_owned(),
            profile: IPAC4_PROTOCOL_PROFILE.to_owned(),
            driver: identity.driver.clone(),
            board_fingerprint: identity.fingerprint.clone(),
            bcd_device: identity.bcd_device,
            current,
            prior_unresolved,
        };
        self.write_pending(&pending, operation == "restore")?;
        Ok(pending)
    }

    fn write_pending(
        &self,
        pending: &PendingPanelTransaction,
        replace_existing: bool,
    ) -> Result<(), BackupError> {
        std::fs::create_dir_all(&self.dir).map_err(|source| BackupError::Io {
            path: self.dir.clone(),
            source,
        })?;
        let mut rendered =
            serde_json::to_vec_pretty(pending).map_err(|source| BackupError::Json {
                path: self.dir.clone(),
                source,
            })?;
        rendered.push(b'\n');
        let temp = create_transaction_temp(&self.dir)?;
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&temp)
                .map_err(|source| BackupError::Io {
                    path: temp.clone(),
                    source,
                })?;
            file.write_all(&rendered)
                .and_then(|_| file.sync_all())
                .map_err(|source| BackupError::Io {
                    path: temp.clone(),
                    source,
                })
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
        let pending_path = self.pending_path();
        let finalized = if replace_existing {
            finalize_transaction_replace(&temp, &pending_path)
        } else {
            finalize_backup_no_replace(&temp, &pending_path)
        };
        if let Err(source) = finalized {
            let _ = std::fs::remove_file(&temp);
            return Err(BackupError::Io {
                path: pending_path,
                source,
            });
        }
        sync_parent_directory(&pending_path)
    }

    fn resolve(
        &self,
        pending: &PendingPanelTransaction,
        resolution: &str,
        observed_sha256: &str,
    ) -> Result<(), BackupError> {
        validate_sha256(observed_sha256, "transaction observed_sha256")
            .map_err(|refusal| BackupError::InvalidDocument(refusal.message))?;
        if !safe_transaction_component(resolution) {
            return Err(BackupError::InvalidDocument(
                "the panel transaction resolution is not one safe filename component".to_owned(),
            ));
        }
        let source = self.pending_path();
        let file_name = format!(
            "{}-{resolution}-{}{}",
            pending.current.transaction_id,
            observed_sha256[..12].to_ascii_lowercase(),
            TRANSACTION_RECEIPT_EXTENSION
        );
        let destination = self.dir.join(file_name);
        if destination.parent() != Some(self.dir.as_path()) {
            return Err(BackupError::InvalidDocument(
                "the panel transaction receipt escaped its board directory".to_owned(),
            ));
        }
        finalize_transaction_receipt(&source, &destination).map_err(|source| BackupError::Io {
            path: destination.clone(),
            source,
        })?;
        sync_parent_directory(&destination)
    }
}

fn safe_transaction_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn create_transaction_temp(dir: &Path) -> Result<PathBuf, BackupError> {
    for nonce in 0..10_000usize {
        let path = dir.join(format!(
            ".panel-transaction.tmp-{}-{nonce}",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(BackupError::Io { path, source }),
        }
    }
    Err(BackupError::NameExhausted(dir.to_owned()))
}

#[cfg(windows)]
fn finalize_transaction_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn finalize_transaction_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn finalize_transaction_receipt(source: &Path, destination: &Path) -> std::io::Result<()> {
    finalize_backup_no_replace(source, destination)
}

#[cfg(not(windows))]
fn finalize_transaction_receipt(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, destination)?;
    std::fs::remove_file(source)
}

fn bad_request(message: impl Into<String>, remedy: impl Into<String>) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::BAD_REQUEST, message, remedy)
}

fn refused(message: impl Into<String>, remedy: impl Into<String>) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::REFUSED, message, remedy)
}

fn programming_error(error: PanelProgrammingError) -> Refusal {
    refused(
        format!("{error}; nothing further was changed"),
        "keep the encoder in keyboard mode, review its latest backup, and retry only after the cause is resolved",
    )
}

fn backup_error(error: BackupError) -> Refusal {
    refused(
        format!("{error}; no encoder byte was changed"),
        "fix the KSX backup folder or choose another verified restore point, then try again",
    )
}

fn validate_sha256(value: &str, field: &str) -> Result<(), Refusal> {
    let value = value.trim();
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(bad_request(
            format!("{field} must be the exact 64-character SHA-256 KSX served"),
            "read the chart or rebuild the diff, then use the hash from that response",
        ))
    }
}

fn validate_supervised_binding(
    selected: &SelectedPanel,
    expected_fingerprint: &str,
    expected_profile: &str,
    supervised: bool,
) -> Result<(), Refusal> {
    if !supervised {
        return Err(bad_request(
            "the supervised hardware-write acknowledgement is required; nothing was changed",
            "review the recovery requirements while physically present at the cabinet, then confirm again",
        ));
    }
    if expected_fingerprint.trim().is_empty()
        || !selected
            .identity
            .fingerprint
            .eq_ignore_ascii_case(expected_fingerprint.trim())
    {
        return Err(bad_request(
            "the selected board fingerprint no longer matches the reviewed hardware diff; nothing was changed",
            "read the exact encoder again and review a fresh diff",
        ));
    }
    if expected_profile.trim() != IPAC4_PROTOCOL_PROFILE {
        return Err(bad_request(
            format!(
                "the reviewed protocol profile is not {IPAC4_PROTOCOL_PROFILE}; nothing was changed"
            ),
            "read the exact encoder again and use the protocol profile from that response",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SessionWriteGate {
    Stopped,
    Running,
    Unreachable(String),
}

fn session_write_gate() -> SessionWriteGate {
    use ksx_api::ControlSource as _;
    let session = ksx_api::Client::new(ksx_api::PipeTransport::new()).session();
    if !session.reachable {
        SessionWriteGate::Unreachable(session.line)
    } else if session.running {
        SessionWriteGate::Running
    } else {
        SessionWriteGate::Stopped
    }
}

fn require_session_stopped(action: &str) -> Result<(), Refusal> {
    match session_write_gate() {
        SessionWriteGate::Stopped => Ok(()),
        SessionWriteGate::Running => Err(refused(
            format!("stop Play before {action} the physical encoder; nothing was changed"),
            format!("stop the running session, rebuild the {action} diff, then confirm again"),
        )),
        SessionWriteGate::Unreachable(reason) => Err(refused(
            format!(
                "KSX cannot prove Play is stopped because the daemon did not answer ({reason}); nothing was changed"
            ),
            "start or reconnect the KSX daemon, prove the session is stopped, then rebuild the hardware diff",
        )),
    }
}

fn session_write_blockers(action: &str) -> Vec<String> {
    match session_write_gate() {
        SessionWriteGate::Stopped => Vec::new(),
        SessionWriteGate::Running => {
            vec![format!(
                "Stop Play before {action} persistent encoder memory."
            )]
        }
        SessionWriteGate::Unreachable(reason) => vec![format!(
            "Reconnect the KSX daemon before {action}; Play's stopped state could not be proved ({reason})."
        )],
    }
}

fn packet_zero_session_guard(action: &str) -> Result<(), PanelProgrammingError> {
    require_session_stopped(action).map_err(|refusal| PanelProgrammingError::WriteGuardRefused {
        reason: refusal.message,
    })
}

fn pending_transaction_refusal(pending: &PendingPanelTransaction) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::RECOVERY_REQUIRED,
        format!(
            "panel transaction {} ({}) is still unresolved; new programming is locked",
            pending.current.transaction_id, pending.current.operation
        ),
        format!(
            "read and back up the complete chart to reconcile its current state, or restore safety backup {}",
            pending.current.safety_backup_id
        ),
    )
}

fn qualification_validation_terminal<'a>(
    spec: &PanelProgramSpec,
    plan: &'a PanelProgramPlan,
    baseline: &RawPanelImage,
) -> Option<&'a str> {
    if spec.layout != "custom" || plan.semantic_diff.len() != 1 || plan.byte_diff.len() != 1 {
        return None;
    }
    let diff = &plan.semantic_diff[0];
    let state = decode_ipac4_terminals(baseline)
        .into_iter()
        .find(|state| state.terminal.id == diff.terminal)?;
    let action_button = diff
        .terminal
        .trim_start_matches(char::is_numeric)
        .starts_with("sw");
    let safe_existing_action = matches!(
        diff.before,
        SemanticValue::Action(TerminalAction::Unassigned | TerminalAction::Keyboard(_))
    );
    let test_writes_a_safe_key = match diff.after {
        SemanticValue::Action(TerminalAction::Keyboard(usage)) => {
            key_for_usage(usage).is_some_and(qualification_key_is_safe)
        }
        _ => false,
    };
    (diff.plane == TerminalPlane::Normal
        && action_button
        && safe_existing_action
        && test_writes_a_safe_key
        && matches!(state.shift, SemanticValue::ShiftDisabled))
    .then_some(diff.terminal)
}

/// Keep the first persistent-write test away from keys that can dismiss,
/// submit, navigate, modify, lock, or invoke OS/application commands. A lone
/// printable alphanumeric is observable while remaining deliberately boring.
fn qualification_key_is_safe(key: Key) -> bool {
    matches!(
        key,
        Key::A
            | Key::B
            | Key::C
            | Key::D
            | Key::E
            | Key::F
            | Key::G
            | Key::H
            | Key::I
            | Key::J
            | Key::K
            | Key::L
            | Key::M
            | Key::N
            | Key::O
            | Key::P
            | Key::Q
            | Key::R
            | Key::S
            | Key::T
            | Key::U
            | Key::V
            | Key::W
            | Key::X
            | Key::Y
            | Key::Z
            | Key::Zero
            | Key::One
            | Key::Two
            | Key::Three
            | Key::Four
            | Key::Five
            | Key::Six
            | Key::Seven
            | Key::Eight
            | Key::Nine
    )
}

fn qualification_program_blockers(
    qualification: &PanelQualificationState,
    spec: &PanelProgramSpec,
    plan: &PanelProgramPlan,
    baseline: &RawPanelImage,
) -> Vec<String> {
    match qualification {
        PanelQualificationState::Qualified => Vec::new(),
        PanelQualificationState::Required
            if qualification_validation_terminal(spec, plan, baseline).is_some() =>
        {
            Vec::new()
        }
        PanelQualificationState::Required => vec![
            "This physical encoder is not write-qualified yet. Customize exactly one noncritical normal terminal to a safe letter or top-row number, program and verify it, then restore the safety backup before using a full-chart layout."
                .to_owned(),
        ],
        PanelQualificationState::ValidationWritten(pending) => vec![format!(
            "The validation write passed. Restore its exact safety backup {} before any further programming.",
            pending.safety_backup_id
        )],
    }
}

fn require_qualification_program(
    qualification: &PanelQualificationState,
    spec: &PanelProgramSpec,
    plan: &PanelProgramPlan,
    baseline: &RawPanelImage,
) -> Result<Option<&'static str>, Refusal> {
    match qualification {
        PanelQualificationState::Qualified => Ok(None),
        PanelQualificationState::Required => qualification_validation_terminal(spec, plan, baseline)
            .map(|terminal| {
                // Terminal ids are drawn from the static PAC256 table.
                ipac4_terminal(terminal)
                    .expect("qualification terminal was resolved")
                    .id
            })
            .map(Some)
            .ok_or_else(|| {
                refused(
                    "this physical encoder is not write-qualified, so only one ordinary action-button terminal with shift disabled may receive one safe letter or top-row number; nothing was changed",
                    "choose Customize, change exactly one eligible SW action terminal to an A–Z or top-row 0–9 key, review the one desired-byte diff and consent to retransmitting the complete 256-byte chart as all 64 HID reports, then restore its safety backup",
                )
            }),
        PanelQualificationState::ValidationWritten(pending) => Err(refused(
            "the one-terminal validation write is awaiting its required restore; nothing was changed",
            format!(
                "restore exact safety backup {} to qualify this physical encoder",
                pending.safety_backup_id
            ),
        )),
    }
}

fn qualification_restore_blocker(
    qualification: &PanelQualificationState,
    backup_id: &BackupId,
) -> Option<String> {
    match qualification {
        PanelQualificationState::Required => Some(
            "Restore is a full persistent chart write and is blocked until this physical encoder passes the one-terminal writer qualification."
                .to_owned(),
        ),
        PanelQualificationState::ValidationWritten(pending)
            if pending.safety_backup_id != backup_id.as_str() =>
        {
            Some(format!(
                "Restore validation safety backup {} first; another restore point cannot qualify this encoder.",
                pending.safety_backup_id
            ))
        }
        PanelQualificationState::Qualified => None,
        PanelQualificationState::ValidationWritten(_) => None,
    }
}

fn require_qualification_restore<'a>(
    qualification: &'a PanelQualificationState,
    backup_id: &BackupId,
) -> Result<Option<&'a PendingPanelQualification>, Refusal> {
    match qualification {
        PanelQualificationState::Required => Err(refused(
            "restore would write the complete persistent chart before this physical encoder has passed its one-terminal writer qualification; nothing was changed",
            "run the guided one-SW validation write first, then restore the exact safety backup it creates",
        )),
        PanelQualificationState::ValidationWritten(pending)
            if pending.safety_backup_id != backup_id.as_str() =>
        {
            Err(refused(
                "a different restore point cannot complete the encoder's pending qualification; nothing was changed",
                format!(
                    "restore exact safety backup {} first",
                    pending.safety_backup_id
                ),
            ))
        }
        PanelQualificationState::ValidationWritten(pending) => Ok(Some(pending)),
        PanelQualificationState::Qualified => Ok(None),
    }
}

fn config_root() -> Result<ksx_config::ConfigRoot, Refusal> {
    ksx_config::ConfigRoot::discover().map_err(|error| {
        refused(
            format!("the KSX configuration folder could not be resolved: {error}"),
            "restore access to the KSX configuration folder, then try again",
        )
    })
}

fn backup_store(root: &ksx_config::ConfigRoot) -> Result<BackupStore, Refusal> {
    Ok(BackupStore::new(panel_recovery_root(root.dir())?))
}

fn fingerprint(
    board_id: &str,
    physical_topology: &str,
    vid: u16,
    pid: u16,
    bcd_device: u16,
    serial: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(IPAC4_DRIVER.as_bytes());
    hasher.update(&vid.to_le_bytes());
    hasher.update(&pid.to_le_bytes());
    hasher.update(&bcd_device.to_le_bytes());
    // Ultimarc's measured "serials" are model-like, low-entropy strings (the
    // repository's captured I-PAC reports literally `4`).  They cannot prove
    // per-unit identity and must never merge two cabinets' backups or pending
    // transactions.  Pin recovery to the physical board/container topology;
    // moving a serial-less or duplicate-serial encoder requires an explicit
    // supervised migration rather than silently adopting another board's
    // persistent state.
    hasher.update(b"board-id\0");
    hasher.update(board_id.trim().to_ascii_uppercase().as_bytes());
    hasher.update(b"physical-topology\0");
    hasher.update(physical_topology.trim().to_ascii_uppercase().as_bytes());
    if let Some(serial) = serial.map(str::trim).filter(|serial| !serial.is_empty()) {
        hasher.update(b"serial\0");
        hasher.update(serial.to_ascii_uppercase().as_bytes());
    }
    let digest = hex_upper(&hasher.finish());
    format!("IPAC4-{}", &digest[..24])
}

fn board_identity_from_status(
    report: &crate::devices::DevicesReport,
    panel: &PanelStatusRow,
) -> Result<BoardIdentity, Refusal> {
    let topologies = report
        .usb
        .iter()
        .filter(|row| {
            row.candidate
                .parent_id
                .eq_ignore_ascii_case(&panel.board_id)
        })
        .map(|row| {
            format!(
                "bus:{};ports:{}",
                row.candidate.bus_id,
                row.candidate
                    .port_chain
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(".")
            )
        })
        .collect::<BTreeSet<_>>();
    if topologies.len() != 1
        || topologies
            .first()
            .is_some_and(|topology| topology.starts_with("bus:;") || topology.ends_with("ports:"))
    {
        return Err(refused(
            "KSX could not prove one physical bus/port path for the selected encoder; nothing was sent",
            "reconnect the encoder directly, refresh panel status, and retry only after one stable port path is reported",
        ));
    }
    let physical_topology = topologies.first().expect("one checked topology");
    Ok(BoardIdentity {
        driver: IPAC4_DRIVER.to_owned(),
        vid: panel.vendor_id,
        pid: panel.product_id,
        bcd_device: panel.bcd_device,
        serial: panel.serial.clone(),
        fingerprint: fingerprint(
            &panel.board_id,
            physical_topology,
            panel.vendor_id,
            panel.product_id,
            panel.bcd_device,
            panel.serial.as_deref(),
        ),
    })
}

fn recovery_detail_for_identity(
    store: &mut BackupStore,
    identity: &BoardIdentity,
) -> Result<Option<String>, Refusal> {
    let journal = PanelTransactionJournal::new(store, identity);
    let pending = journal
        .load_pending(store, identity)
        .map_err(backup_error)?;
    Ok(pending.map(|pending| {
        format!(
            "Persistent {} transaction {} is unresolved for this exact encoder. Routes stay suspended until a complete stable chart is read and backed up or its verified safety backup is restored.",
            pending.current.operation, pending.current.transaction_id,
        )
    }))
}

/// Add machine-scoped recovery authority to passive status without opening a
/// HID report handle. Each row is joined to its own bus/port fingerprint, so
/// an interrupted transaction for detached board A cannot lock selected board
/// B merely because both share a VID/PID.
pub(crate) fn decorate_recovery_status(
    report: &crate::devices::DevicesReport,
    panels: &mut [PanelStatusRow],
) {
    let root = match config_root() {
        Ok(root) => root,
        Err(refusal) => {
            mark_recovery_status_unknown(panels, &refusal.message);
            return;
        }
    };
    let recovery_root = match panel_recovery_root(root.dir()) {
        Ok(recovery_root) => recovery_root,
        Err(refusal) => {
            mark_recovery_status_unknown(panels, &refusal.message);
            return;
        }
    };
    decorate_recovery_status_guarded_at(root.dir(), &recovery_root, report, panels);
}

fn mark_recovery_status_unknown(panels: &mut [PanelStatusRow], detail: &str) {
    for panel in panels {
        if admitted_programming_profile(panel, PanelProfileAccess::ReadChart).is_ok() {
            panel.programming_recovery_required = true;
            panel.programming_recovery_detail =
                format!("KSX cannot prove this encoder's recovery journal is settled: {detail}");
        }
    }
}

/// Hold the same nonblocking machine lease as Play/start and programming while
/// taking the durable journal snapshot. Without this exclusion a second
/// process could acquire the writer lease after status saw no marker but
/// before that writer committed its pre-packet journal.
fn decorate_recovery_status_guarded_at(
    config_dir: &Path,
    recovery_root: &Path,
    report: &crate::devices::DevicesReport,
    panels: &mut [PanelStatusRow],
) {
    let _lease = match acquire_programming_lease(config_dir) {
        Ok(lease) => lease,
        Err(refusal) => {
            mark_recovery_status_unknown(panels, &refusal.message);
            return;
        }
    };
    if let Err(refusal) = pending_panel_transaction_paths_at(recovery_root) {
        mark_recovery_status_unknown(panels, &refusal.message);
        return;
    }
    decorate_recovery_status_at(recovery_root, report, panels);
}

fn decorate_recovery_status_at(
    recovery_root: &Path,
    report: &crate::devices::DevicesReport,
    panels: &mut [PanelStatusRow],
) {
    let mut store = BackupStore::new(recovery_root);
    for panel in panels {
        if admitted_programming_profile(panel, PanelProfileAccess::ReadChart).is_err() {
            continue;
        }
        match board_identity_from_status(report, panel)
            .and_then(|identity| recovery_detail_for_identity(&mut store, &identity))
        {
            Ok(Some(detail)) => {
                panel.programming_recovery_required = true;
                panel.programming_recovery_detail = detail;
            }
            Ok(None) => {
                panel.programming_recovery_required = false;
                panel.programming_recovery_detail.clear();
            }
            Err(refusal) => {
                // An unreadable exact-board journal is not evidence that the
                // board is settled. Fail closed, but preserve passive status.
                panel.programming_recovery_required = true;
                panel.programming_recovery_detail = format!(
                    "KSX cannot prove this encoder's recovery journal is settled: {}",
                    refusal.message
                );
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PanelProfileAccess {
    ReadChart,
    PersistentWrite,
}

fn capabilities_admit(capabilities: PanelDriverCapabilities, access: PanelProfileAccess) -> bool {
    match access {
        PanelProfileAccess::ReadChart => capabilities.can_read_chart,
        PanelProfileAccess::PersistentWrite => {
            capabilities.can_read_chart
                && capabilities.can_write_chart
                && capabilities.write_is_persistent
        }
    }
}

/// Resolve passive status to one exact measured chart profile.
///
/// Family recognition is deliberately insufficient: adding a VID/PID to the
/// read-only catalog must never make this programming facade open a report
/// collection. The current facade can dispatch only the independently
/// measured PAC256 implementation.
fn admitted_programming_profile(
    panel: &PanelStatusRow,
    access: PanelProfileAccess,
) -> Result<&'static PanelProtocolProfile, Refusal> {
    let profile = profile_for(panel.vendor_id, panel.product_id, panel.bcd_device).ok_or_else(|| {
        refused(
            format!(
                "{} has no exact measured chart profile for {:04X}:{:04X} release {:04X}; nothing was sent",
                panel.name, panel.vendor_id, panel.product_id, panel.bcd_device,
            ),
            "keep using Teach and Route; a separate measured protocol profile is required for this exact encoder revision",
        )
    })?;
    if !panel.driver_supported
        || panel.driver != profile.driver_id
        || panel.family_id.as_deref() != Some(profile.family_id)
        || panel.capabilities != profile.capabilities
        || !capabilities_admit(profile.capabilities, access)
        || profile.protocol_profile != IPAC4_PROTOCOL_PROFILE
        || profile.driver != PanelProtocolDriver::Ipac4Pac256V1
    {
        return Err(refused(
            format!(
                "{} did not match the complete {} admission contract; nothing was sent",
                panel.name, profile.protocol_profile,
            ),
            "refresh panel status and use Teach and Route until the exact measured profile is available",
        ));
    }
    Ok(profile)
}

/// Prove that a staged device selector names the exact live keyboard input,
/// not merely another interface which happens to share its physical board.
///
/// Panel inventory intentionally groups MI_00 and MI_02 for presentation and
/// maintenance. Routing cannot use that broader relation: the staged daemon
/// source must resolve uniquely, through the normal selector engine, to the
/// same MI_00 boot-keyboard devnode which supplied the browser-observed key.
fn staged_selector_names_exact_input(
    report: &crate::devices::DevicesReport,
    selector: &str,
    expected_input_instance: &str,
) -> bool {
    let Ok(selector) = DeviceSelector::parse(selector) else {
        return false;
    };
    let facts = report
        .usb
        .iter()
        .map(|row| row.candidate.facts())
        .collect::<Vec<_>>();
    let Match::One(resolved) = selector.match_against(&facts) else {
        return false;
    };
    if !resolved
        .id
        .as_str()
        .eq_ignore_ascii_case(expected_input_instance)
    {
        return false;
    }
    report.usb.iter().any(|row| {
        row.candidate
            .id
            .as_str()
            .eq_ignore_ascii_case(expected_input_instance)
            && row.candidate.interface_number == 0
            && row.candidate.is_boot_keyboard()
    })
}

#[cfg(windows)]
fn select_panel(
    device: Option<String>,
    access: PanelProfileAccess,
) -> Result<SelectedPanel, Refusal> {
    let report = crate::devices::collect();
    let hid = ksx_platform::hid::survey();
    let view = crate::panel::view(
        &report,
        &hid,
        &ksx_api::PanelStatusSpec {
            device: device.clone(),
        },
    )?;
    let mut panels = view.panels;
    if panels.len() != 1 {
        return Err(bad_request(
            format!(
                "panel programming needs exactly one physical board, but {} matched",
                panels.len()
            ),
            "select one encoder in Studio or pass `--device` from `ksx panel status`",
        ));
    }
    let panel = panels.remove(0);
    let profile = admitted_programming_profile(&panel, access)?;
    if panel.observed_mode != "keyboard-compatible" {
        return Err(refused(
            format!(
                "{} is not presently proven to be in keyboard-compatible mode; nothing was sent",
                panel.name
            ),
            "restore keyboard mode with the documented hardware gesture, refresh panel status, then retry",
        ));
    }
    let input_instances = panel
        .interfaces
        .iter()
        .filter(|interface| interface.boot_keyboard && interface.interface_number == 0)
        .map(|interface| interface.instance_id.clone())
        .collect::<Vec<_>>();
    let [input_instance] = input_instances.as_slice() else {
        return Err(refused(
            "the selected encoder did not expose one exact MI_00 keyboard input interface; nothing was sent",
            "refresh panel status and resolve the input-interface warning before retrying",
        ));
    };
    let collection_id = panel.configuration_collection.as_deref().ok_or_else(|| {
        refused(
            format!(
                "{} does not have one unambiguous 5-byte configuration collection; nothing was sent",
                panel.name
            ),
            "reconnect the encoder, run `ksx panel status`, and resolve any unavailable or ambiguous HID row",
        )
    })?;
    let matching: Vec<_> = hid
        .collections
        .iter()
        .filter(|collection| {
            collection.instance_id.eq_ignore_ascii_case(collection_id)
                && collection
                    .board_id
                    .as_deref()
                    .is_some_and(|board| board.eq_ignore_ascii_case(&panel.board_id))
        })
        .collect();
    let [collection] = matching.as_slice() else {
        return Err(refused(
            "the exact configuration collection changed between inventory and admission; nothing was sent",
            "refresh panel status and retry with the currently selected encoder",
        ));
    };
    if !collection
        .instance_id
        .to_ascii_uppercase()
        .contains(profile.collection.interface_token)
    {
        return Err(refused(
            "the configuration collection was not the pinned MI_02 interface; nothing was sent",
            "keep using Teach and Route until KSX has a measured profile for this interface topology",
        ));
    }
    let attributes = collection.attributes.ok_or_else(|| {
        refused(
            "the selected configuration collection has no readable HID identity; nothing was sent",
            "reconnect the encoder and retry its hardware inspection",
        )
    })?;
    let capabilities = collection.capabilities.ok_or_else(|| {
        refused(
            "the selected configuration collection has no readable report lengths; nothing was sent",
            "reconnect the encoder and retry its hardware inspection",
        )
    })?;
    if !collection.errors.is_empty()
        || attributes.vendor_id != panel.vendor_id
        || attributes.product_id != panel.product_id
        || attributes.version_number != profile.bcd_device
        || !profile.collection.matches(
            &collection.instance_id,
            capabilities.usage_page,
            capabilities.usage,
            capabilities.input_report_bytes,
            capabilities.output_report_bytes,
        )
        || collection.device_path.is_empty()
    {
        return Err(refused(
            "the selected configuration collection failed exact identity/capability admission; nothing was sent",
            "run `ksx panel status --device` and resolve every collection warning before retrying",
        ));
    }
    let identity = board_identity_from_status(&report, &panel)?;
    let staged_selector_names_input = device.as_deref().is_some_and(|selector| {
        staged_selector_names_exact_input(&report, selector, input_instance)
    });
    Ok(SelectedPanel {
        board_id: panel.board_id,
        name: panel.name,
        device_path: collection.device_path.clone(),
        input_instance: input_instance.clone(),
        staged_selector_names_input,
        identity,
        profile,
    })
}

#[cfg(not(windows))]
fn select_panel(
    _device: Option<String>,
    _access: PanelProfileAccess,
) -> Result<SelectedPanel, Refusal> {
    Err(refused(
        "I-PAC chart programming is available only on Windows; nothing was changed",
        "run this command on the Windows cabinet that owns the encoder",
    ))
}

fn open_panel(selected: &SelectedPanel) -> Result<HidIo, Refusal> {
    HidReportDevice::open_exact(
        &selected.device_path,
        HidReportIdentity {
            vendor_id: selected.identity.vid,
            product_id: selected.identity.pid,
        },
    )
    .map(HidIo)
    .map_err(panel_open_refusal)
}

fn panel_open_refusal(error: HidReportError) -> Refusal {
    #[cfg(windows)]
    if matches!(
        &error,
        HidReportError::Open(source)
            if source.raw_os_error()
                == Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32)
    ) {
        return Refusal::with_remedy(
            ksx_api::codes::PANEL_INTERFACE_BUSY,
            "Another app is using this I-PAC's configuration interface. KSX could not acquire the exclusive handle required for this step; no persistent chart write was started.",
            "Close WinIPAC or the other encoder tool, then choose Read board again. KSX keyboard input can continue while the configuration interface is busy.",
        );
    }

    refused(
        format!(
            "the exact I-PAC configuration collection could not be opened: {error}; no persistent chart write was started"
        ),
        "reconnect the encoder and confirm its configuration interface is available to this Windows account, then retry; if another hardware tool is open, close it first",
    )
}

/// Prove that the pinned chart is stable across two independent HID sessions.
/// Closing and reopening is intentional: one lucky packet sequence is not
/// enough authority for a persistent EEPROM write or restore plan.
fn read_stable_panel_image(selected: &SelectedPanel) -> Result<RawPanelImage, Refusal> {
    read_stable_panel_image_with_final_handle(selected).map(|(image, _handle)| image)
}

/// The routing variant retains the second independently opened MI_02 handle.
/// Its exclusive share mode is the final hardware-side fence: another tool
/// cannot rewrite the chart after validation and before the daemon commits the
/// staged route. The caller must keep the returned handle alive for that
/// entire interval.
fn read_stable_panel_image_with_final_handle(
    selected: &SelectedPanel,
) -> Result<(RawPanelImage, HidIo), Refusal> {
    let first = {
        let mut io = open_panel(selected)?;
        read_ipac4_image(&mut io).map_err(programming_error)?
    };
    let mut final_handle = open_panel(selected)?;
    let second = read_ipac4_image(&mut final_handle).map_err(programming_error)?;
    if first.len() != IPAC4_IMAGE_BYTES || second.len() != IPAC4_IMAGE_BYTES {
        return Err(refused(
            format!(
                "the pinned I-PAC4 profile requires exactly {IPAC4_IMAGE_BYTES} chart bytes; nothing was changed"
            ),
            "keep using Teach and Route until KSX has a separately measured profile for this encoder",
        ));
    }
    if !first.sha256().eq_ignore_ascii_case(second.sha256()) {
        return Err(refused(
            "the complete encoder chart changed between two independent reads; nothing was changed",
            "close WinIPAC, stop Play, leave the encoder connected, and read the chart again",
        ));
    }
    Ok((second, final_handle))
}

fn key_for_usage(usage: KeyboardUsage) -> Option<Key> {
    let (code, state) = ksx_capture::hid::usage::usage_to_stroke(usage.hid_usage(), true)?;
    if !ksx_capture::keymap::is_down(state) {
        return None;
    }
    let key = ksx_capture::keymap::corrected_key(code, state);
    (!matches!(key, Key::None | Key::Unknown)).then_some(key)
}

fn key_roster() -> Vec<(Key, KeyboardUsage)> {
    let mut seen = BTreeSet::new();
    let mut roster = Vec::new();
    for raw in 0u8..=u8::MAX {
        let Ok(usage) = KeyboardUsage::new(raw) else {
            continue;
        };
        let Some(key) = key_for_usage(usage) else {
            continue;
        };
        if seen.insert(key) {
            roster.push((key, usage));
        }
    }
    roster
}

fn usage_for_key_name(name: &str) -> Result<Option<KeyboardUsage>, Refusal> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    key_roster()
        .into_iter()
        .find(|(key, _)| key.name().eq_ignore_ascii_case(name))
        .map(|(_, usage)| Some(usage))
        .ok_or_else(|| {
            bad_request(
                format!("'{name}' is not a keyboard action KSX can both program and observe"),
                "choose a key from the encoder setup's served key list",
            )
        })
}

/// Normalize a surface spelling through the exact program-and-observe key
/// roster. Portable hardware profiles call this before they reach a board, so
/// a saved layout cannot contain an action the programmer would later refuse.
pub(crate) fn canonical_panel_key_name(name: &str) -> Result<Option<String>, Refusal> {
    usage_for_key_name(name).map(|usage| {
        usage.map(|usage| {
            key_for_usage(usage)
                .expect("usage_for_key_name returns only observable usages")
                .name()
                .to_owned()
        })
    })
}

pub(crate) fn terminal_edits(spec: &PanelProgramSpec) -> Result<Vec<TerminalEdit>, Refusal> {
    match spec.layout.as_str() {
        "canonical-four-player" => {
            if !spec.edits.is_empty() {
                return Err(bad_request(
                    "the recommended layout cannot be mixed with custom terminal edits",
                    "choose Recommended or Customize, then review one coherent plan",
                ));
            }
            return Ok(canonical_four_player_edits());
        }
        "blank" => {
            if !spec.edits.is_empty() {
                return Err(bad_request(
                    "the blank layout cannot be mixed with custom terminal edits",
                    "choose Blank hardware or Customize, then review one coherent plan",
                ));
            }
            return Ok(blank_edits());
        }
        "custom" => {}
        other => {
            return Err(bad_request(
                format!("unknown panel layout '{other}'"),
                "choose `blank`, `canonical-four-player`, or `custom`",
            ));
        }
    }

    let mut normal_keys: BTreeMap<String, Vec<(&PanelTerminalEdit, String)>> = BTreeMap::new();
    let mut shifted_keys: BTreeMap<String, Vec<(&PanelTerminalEdit, String)>> = BTreeMap::new();
    let mut edits = Vec::new();
    for edit in &spec.edits {
        let terminal = edit.terminal_id.trim().to_ascii_lowercase();
        if terminal.is_empty() || ipac4_terminal(&terminal).is_none() {
            return Err(bad_request(
                format!("'{}' is not a physical I-PAC 4 terminal", edit.terminal_id),
                "choose a terminal from the complete chart KSX served",
            ));
        }
        if let Some(name) = &edit.normal_key {
            let usage = usage_for_key_name(name)?;
            if let Some(usage) = usage {
                let canonical = key_for_usage(usage)
                    .expect("served usage has a key")
                    .name()
                    .to_owned();
                normal_keys
                    .entry(canonical)
                    .or_default()
                    .push((edit, terminal.clone()));
            }
            edits.push(TerminalEdit::normal(terminal.clone(), usage));
        }
        if let Some(name) = &edit.shifted_key {
            let usage = usage_for_key_name(name)?;
            if let Some(usage) = usage {
                let canonical = key_for_usage(usage)
                    .expect("served usage has a key")
                    .name()
                    .to_owned();
                shifted_keys
                    .entry(canonical)
                    .or_default()
                    .push((edit, terminal.clone()));
            }
            edits.push(TerminalEdit::alternate(terminal.clone(), usage));
        }
        if let Some(enabled) = edit.is_shift {
            edits.push(TerminalEdit::shift(terminal, enabled));
        }
    }
    validate_shared_keys(&normal_keys, "normal")?;
    validate_shared_keys(&shifted_keys, "shifted")?;
    Ok(edits)
}

fn terminal_edits_for_image(
    spec: &PanelProgramSpec,
    image: &RawPanelImage,
) -> Result<Vec<TerminalEdit>, Refusal> {
    if spec.layout == "blank" || spec.layout == "canonical-four-player" {
        // `terminal_edits` still validates that Blank has no custom rows and
        // that the layout spelling is known before these baseline-sensitive
        // layouts decide which *known-enabled* shift bytes may be reset.
        terminal_edits(spec)?;
        Ok(if spec.layout == "blank" {
            blank_edits_for_image(image)
        } else {
            canonical_four_player_edits_for_image(image)
        })
    } else {
        let mut edits = terminal_edits(spec)?;
        let shift_states = decode_ipac4_terminals(image)
            .into_iter()
            .map(|state| (state.terminal.id, state.shift))
            .collect::<BTreeMap<_, _>>();
        edits.retain(|edit| match edit {
            // `false` means "no active shift role", not permission to
            // normalize an unrecognized vendor byte. Disabled is already the
            // desired state; opaque is deliberately preserved.
            TerminalEdit::Shift {
                terminal,
                enabled: false,
            } => shift_states.get(terminal.as_str()) == Some(&SemanticValue::ShiftEnabled),
            _ => true,
        });
        Ok(edits)
    }
}

fn validate_shared_keys(
    keys: &BTreeMap<String, Vec<(&PanelTerminalEdit, String)>>,
    layer: &str,
) -> Result<(), Refusal> {
    for (key, uses) in keys {
        let terminals: BTreeSet<_> = uses.iter().map(|(_, terminal)| terminal).collect();
        if terminals.len() > 1 && uses.iter().any(|(edit, _)| !edit.allow_shared_key) {
            return Err(bad_request(
                format!(
                    "{key} is assigned to more than one {layer}-layer terminal without deliberate shared-key confirmation"
                ),
                "choose distinct keys, or explicitly mark every participating physical terminal as shared",
            ));
        }
    }
    Ok(())
}

fn complete_key_groups(image: &RawPanelImage) -> BTreeMap<(String, String), BTreeSet<String>> {
    let mut groups = BTreeMap::new();
    for state in decode_ipac4_terminals(image) {
        for (layer, action) in [("normal", state.normal), ("shifted", state.alternate)] {
            let TerminalAction::Keyboard(usage) = action else {
                continue;
            };
            let Some(key) = key_for_usage(usage) else {
                continue;
            };
            groups
                .entry((layer.to_owned(), key.name().to_ascii_uppercase()))
                .or_insert_with(BTreeSet::new)
                .insert(state.terminal.id.to_owned());
        }
    }
    groups
}

/// A sparse custom request must not hide a collision with an unchanged chart
/// row. Existing duplicate groups may be preserved, but any newly created or
/// expanded fan-in requires an explicit acknowledgement on every physical
/// terminal participating in the desired group.
fn validate_complete_desired_keys(
    spec: &PanelProgramSpec,
    baseline: &RawPanelImage,
    desired: &RawPanelImage,
) -> Result<(), Refusal> {
    if spec.layout != "custom" {
        return Ok(());
    }
    let before = complete_key_groups(baseline);
    let after = complete_key_groups(desired);
    for ((layer, key), terminals) in after {
        if terminals.len() < 2 || before.get(&(layer.clone(), key.clone())) == Some(&terminals) {
            continue;
        }
        let all_confirmed = terminals.iter().all(|terminal| {
            spec.edits.iter().any(|edit| {
                edit.terminal_id.eq_ignore_ascii_case(terminal) && edit.allow_shared_key
            })
        });
        if !all_confirmed {
            return Err(bad_request(
                format!(
                    "{key} would be shared by {} {layer}-layer terminals without deliberate confirmation on every terminal",
                    terminals.len()
                ),
                "choose distinct keys, or include and explicitly confirm every physical terminal in this shared signal",
            ));
        }
    }
    Ok(())
}

fn key_value(raw: u8, action: TerminalAction) -> PanelKeyValue {
    match action {
        TerminalAction::Unassigned => PanelKeyValue {
            code: raw as u16,
            key: None,
            label: "Unassigned".to_owned(),
            supported: true,
        },
        TerminalAction::Keyboard(usage) => match key_for_usage(usage) {
            Some(key) => PanelKeyValue {
                code: raw as u16,
                key: Some(key.name().to_owned()),
                label: key.name().to_owned(),
                supported: true,
            },
            None => PanelKeyValue {
                code: raw as u16,
                key: None,
                label: format!("{} 0x{raw:02X}", crate::panel_truth::UNOBSERVABLE_ACTION),
                supported: false,
            },
        },
        TerminalAction::Opaque(value) => PanelKeyValue {
            code: raw as u16,
            key: None,
            label: format!("Preserved vendor action 0x{value:02X}"),
            supported: false,
        },
    }
}

fn terminal_label(id: &str, player: u8) -> (String, String) {
    let suffix = id.trim_start_matches(char::is_numeric);
    let (part, kind) = match suffix {
        "up" => ("Up".to_owned(), "direction"),
        "down" => ("Down".to_owned(), "direction"),
        "left" => ("Left".to_owned(), "direction"),
        "right" => ("Right".to_owned(), "direction"),
        "start" => ("Start".to_owned(), "start"),
        "coin" => ("Coin".to_owned(), "coin"),
        other if other.starts_with("sw") => (
            format!("Button {}", other.trim_start_matches("sw")),
            "button",
        ),
        other => (other.to_owned(), "button"),
    };
    (format!("Player {player} · {part}"), kind.to_owned())
}

fn backup_row(stored: &StoredBackup) -> PanelBackupRow {
    let reason = match stored.reason {
        BackupReason::InitialCapture => "Initial capture in this backup set",
        BackupReason::Manual => "Chart snapshot",
        BackupReason::BeforeProgram => "Before program",
        BackupReason::BeforeRestore => "Before restore",
    };
    PanelBackupRow {
        backup_id: stored.id.as_str().to_owned(),
        label: format!(
            "{reason} · {} · {}",
            stored.created_at,
            &stored.image_sha256[..12]
        ),
        created_at: stored.created_at.clone(),
        board_fingerprint: String::new(),
        image_sha256: stored.image_sha256.clone(),
        image_bytes: stored.image_len,
        reason: stored.reason.as_str().replace('_', "-"),
    }
}

fn backup_row_for(identity: &BoardIdentity, stored: &StoredBackup) -> PanelBackupRow {
    let mut row = backup_row(stored);
    row.board_fingerprint = identity.fingerprint.clone();
    row
}

fn terminal_rows(image: &RawPanelImage) -> (Vec<PanelTerminalRow>, usize) {
    let mut unknown_actions = 0usize;
    let terminals = decode_ipac4_terminals(image)
        .into_iter()
        .map(|state| {
            let normal = key_value(state.normal_raw, state.normal);
            let shifted = key_value(state.alternate_raw, state.alternate);
            let shift_state = match state.shift {
                SemanticValue::ShiftDisabled => PanelShiftState::Disabled,
                SemanticValue::ShiftEnabled => PanelShiftState::Enabled,
                SemanticValue::ShiftOpaque(_) => PanelShiftState::Opaque,
                // An action byte here is unreachable BY CONVENTION, not by type:
                // `Ipac4TerminalState.shift` is a plain field of a four-variant
                // enum, and only `decode_ipac4_terminals` currently fills it from
                // the shift plane. Nothing at the compiler level stops a future
                // caller from putting a Normal byte there, and the first vendor
                // byte through that path would abort a verb whose entire contract
                // is that it only reads. `Opaque` is what this module already means
                // by "a byte ksx cannot name" — so say that instead of aborting.
                SemanticValue::Action(_) => PanelShiftState::Opaque,
            };
            unknown_actions += usize::from(!normal.supported)
                + usize::from(!shifted.supported)
                + usize::from(shift_state == PanelShiftState::Opaque);
            let (terminal_label, kind) = terminal_label(state.terminal.id, state.terminal.player);
            // Computed before `normal` is moved into the row below.
            let press_resolves = !normal.supported
                && !normal.label.contains(crate::panel_truth::UNOBSERVABLE_ACTION);
            PanelTerminalRow {
                terminal_id: state.terminal.id.to_owned(),
                terminal_label,
                player: state.terminal.player,
                kind,
                normal,
                shifted,
                shift_state,
                is_shift: shift_state == PanelShiftState::Enabled,
                // Served rather than left for a surface to work out, because
                // the only clue on the wire is the display label and every
                // consumer that read it would be a second copy of the rule in
                // `panel_truth::press_would_help`. A vendor byte a press can
                // resolve and a HID usage Windows never delivers to ksx both
                // arrive as `supported: false`, and they need opposite offers.
                press_resolves,
            }
        })
        .collect();
    (terminals, unknown_actions)
}

fn recommended_terminal_rows(image: &RawPanelImage) -> Vec<PanelTerminalRow> {
    let edits = canonical_four_player_edits_for_image(image);
    let plan = plan_program(image, &edits)
        .expect("the internal canonical I-PAC4 roster must always form a valid program plan");
    terminal_rows(&plan.desired).0
}

fn chart_view(
    selected: &SelectedPanel,
    image: &RawPanelImage,
    backup: Option<&StoredBackup>,
    pending: Option<&PendingPanelTransaction>,
    reconciled_interruption: bool,
    qualification: &PanelQualificationState,
) -> PanelChartView {
    let (terminals, unknown_actions) = terminal_rows(image);
    let recommended_terminals = recommended_terminal_rows(image);
    let mut notes = vec![format!(
        "The complete {}-byte raw chart remains authoritative; semantic edits preserve every untouched byte.",
        image.len()
    )];
    notes.push(
        "Backups and pending recovery are pinned to this physical USB bus/port path. Moving the encoder deliberately does not auto-adopt persistent state, because Ultimarc serial strings are not proven unique."
            .to_owned(),
    );
    if unknown_actions > 0 {
        notes.push(format!(
            "{unknown_actions} vendor or unobservable action(s) are preserved exactly and cannot be selected as KSX keys."
        ));
    }
    if reconciled_interruption {
        notes.push(
            "A durable interrupted-transaction marker was reconciled only after this complete chart was read twice and saved as a verified backup."
                .to_owned(),
        );
    }
    let session_gate = session_write_gate();
    let (programming_state, programming_detail) = if let Some(pending) = pending {
        (
            "recovery-required",
            format!(
                "Transaction {} is unresolved. New programming stays locked until a complete stable read is backed up or a verified safety backup is restored.",
                pending.current.transaction_id
            ),
        )
    } else {
        match &session_gate {
        SessionWriteGate::Stopped => (
            "supervised",
            "The pinned I-PAC4 profile supports an explicitly supervised write: immutable backup, exact diff, persistent program, complete readback, verification, and restore."
                .to_owned(),
        ),
        SessionWriteGate::Running => (
            "write-locked",
            "The complete chart is readable, but Play must stop before persistent hardware memory can change."
                .to_owned(),
        ),
        SessionWriteGate::Unreachable(reason) => (
            "write-locked",
            format!(
                "The complete chart is readable, but KSX cannot prove Play is stopped because the daemon did not answer ({reason})."
            ),
        ),
        }
    };
    PanelChartView {
        generated_at: timestamp_rfc3339(Timestamp::now_utc()),
        summary: if backup.is_some() {
            format!(
                "Complete {}-byte chart read and losslessly backed up.",
                image.len()
            )
        } else {
            format!(
                "Complete {}-byte chart read; nothing was changed.",
                image.len()
            )
        },
        board_id: selected.board_id.clone(),
        board_name: selected.name.clone(),
        board_fingerprint: selected.identity.fingerprint.clone(),
        driver: selected.identity.driver.clone(),
        protocol_profile: selected.profile.protocol_profile.to_owned(),
        image_sha256: image.sha256().to_owned(),
        image_bytes: image.len(),
        programming_state: programming_state.to_owned(),
        programming_detail,
        qualification_state: qualification.api_state().to_owned(),
        qualification_detail: qualification.detail(),
        qualification_restore_backup_id: qualification.restore_backup_id(),
        shift: crate::panel_truth::compose_shift(&terminals),
        terminals,
        recommended_terminals,
        key_options: key_roster()
            .into_iter()
            .map(|(key, usage)| PanelKeyOption {
                key: key.name().to_owned(),
                label: key.name().to_owned(),
                code: usage.encode() as u16,
                safe_for_qualification: qualification_key_is_safe(key),
            })
            .collect(),
        backup: backup.map(|stored| backup_row_for(&selected.identity, stored)),
        notes,
    }
}

fn semantic_label(value: SemanticValue) -> String {
    match value {
        SemanticValue::Action(TerminalAction::Unassigned) => "Unassigned".to_owned(),
        SemanticValue::Action(TerminalAction::Keyboard(usage)) => key_for_usage(usage).map_or_else(
            || format!("Unobservable HID 0x{:02X}", usage.hid_usage()),
            |key| key.name().to_owned(),
        ),
        SemanticValue::Action(TerminalAction::Opaque(value)) => {
            format!("Vendor action 0x{value:02X}")
        }
        SemanticValue::ShiftDisabled => "Not shift control".to_owned(),
        SemanticValue::ShiftEnabled => "Shift control".to_owned(),
        SemanticValue::ShiftOpaque(value) => format!("Vendor shift state 0x{value:02X}"),
    }
}

fn byte_meaning(offset: usize) -> String {
    for terminal in IPAC4_TERMINALS {
        for plane in [
            TerminalPlane::Normal,
            TerminalPlane::Alternate,
            TerminalPlane::Shift,
        ] {
            if terminal.image_offset(plane) == offset {
                return format!("{} {plane}", terminal.id);
            }
        }
    }
    match offset {
        0..=3 => "chart header/configuration".to_owned(),
        199..=255 => "preserved onboard macro/vendor data".to_owned(),
        _ => "preserved vendor data".to_owned(),
    }
}

fn plan_view(
    selected: &SelectedPanel,
    plan: &PanelProgramPlan,
    mut blockers: Vec<String>,
    confirmation_action: &str,
    qualification_full_chart_consent: bool,
) -> PanelProgramPlanView {
    if plan.is_noop() {
        blockers
            .push("The proposed chart is byte-identical; there is nothing to write.".to_owned());
    }
    let mut confirmation = format!(
        "{confirmation_action} on {} ({})",
        selected.name, selected.identity.fingerprint
    );
    if qualification_full_chart_consent {
        confirmation.push_str(
            ". I understand that exactly one desired byte differs, but KSX retransmits the complete 256-byte chart as all 64 HID reports.",
        );
    }
    PanelProgramPlanView {
        summary: format!(
            "{} terminal change(s), {} byte change(s), {} bytes preserved.",
            plan.semantic_diff.len(),
            plan.byte_diff.len(),
            plan.desired.len().saturating_sub(plan.byte_diff.len())
        ),
        board_id: selected.board_id.clone(),
        board_name: selected.name.clone(),
        board_fingerprint: selected.identity.fingerprint.clone(),
        protocol_profile: selected.profile.protocol_profile.to_owned(),
        base_sha256: plan.baseline_sha256.clone(),
        desired_sha256: plan.desired_sha256.clone(),
        image_bytes: plan.desired.len(),
        terminal_diff: plan
            .semantic_diff
            .iter()
            .map(|diff| PanelTerminalDiffRow {
                terminal_id: diff.terminal.to_owned(),
                terminal_label: terminal_label(
                    diff.terminal,
                    ipac4_terminal(diff.terminal).map_or(0, |row| row.player),
                )
                .0,
                layer: diff.plane.to_string(),
                before: semantic_label(diff.before),
                after: semantic_label(diff.after),
            })
            .collect(),
        byte_diff: plan
            .byte_diff
            .iter()
            .map(|diff| PanelByteDiffRow {
                offset: diff.offset,
                before: diff.before as u16,
                after: diff.after as u16,
                meaning: byte_meaning(diff.offset),
            })
            .collect(),
        preserved_byte_count: plan.desired.len().saturating_sub(plan.byte_diff.len()),
        confirmation,
        blockers,
    }
}

fn recovery_outcome(
    error: &PanelProgrammingError,
    selected: &SelectedPanel,
    store: &mut BackupStore,
    expected_sha256: &str,
) -> Option<Result<PanelProgramOutcome, Refusal>> {
    let (backup_id, observed) = match error {
        PanelProgrammingError::VerificationFailed {
            backup,
            actual_sha256,
            ..
        } => (backup.clone(), Some(actual_sha256.clone())),
        PanelProgrammingError::TransactionFailed { backup, .. } => (backup.clone(), None),
        _ => return None,
    };
    Some(match store.load_verified(&selected.identity, &backup_id) {
        Ok(loaded) => Ok(PanelProgramOutcome {
                state: "recovery-required".to_owned(),
                summary: error.to_string(),
                board_fingerprint: selected.identity.fingerprint.clone(),
                expected_sha256: expected_sha256.to_owned(),
                observed_sha256: observed,
                backup: backup_row_for(&selected.identity, &loaded.stored),
                verified_at: timestamp_rfc3339(Timestamp::now_utc()),
                next_step: format!(
                    "Do not retry blindly. Inspect the board, then review the pre-transaction safety backup {}.",
                    backup_id
                ),
            }),
        Err(backup_failure) => Err(Refusal::with_remedy(
            ksx_api::codes::RECOVERY_REQUIRED,
            format!(
                "{error}; KSX also could not reopen safety backup {backup_id}: {backup_failure}. The encoder's current state is unknown and may have changed"
            ),
            "do not retry or disconnect the encoder; preserve the panel-backups folder and inspect the board with a supervised recovery procedure",
        )),
    })
}

/// Establish one routing transaction against the exact chart that emitted a
/// browser-observed key. The returned opaque guard owns the same machine-wide
/// lease as programming and restore; callers must retain it until their
/// staged binding commit has completed.
pub fn routing_guard(
    spec: &PanelRoutingAuthoritySpec,
) -> Result<Box<dyn PanelRoutingGuard>, Refusal> {
    let expected_selector = spec
        .expected_selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            bad_request(
                "this programmable encoder binding has no exact board selector; nothing was mapped",
                "read the complete encoder chart, then teach or assign the key again",
            )
        })?;
    if !expected_selector.eq_ignore_ascii_case(spec.device.trim()) {
        return Err(bad_request(
            "the encoder selected by the browser is no longer the staged input; nothing was mapped",
            "refresh the canvas, read the selected encoder's complete chart, then try again",
        ));
    }
    let expected_instance = spec
        .expected_instance
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            bad_request(
                "this programmable encoder binding has no exact keyboard interface; nothing was mapped",
                "refresh the selected encoder, read its complete chart, then try again",
            )
        })?;
    let expected_fingerprint = spec
        .expected_board_fingerprint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            bad_request(
                "this programmable encoder binding has no board fingerprint; nothing was mapped",
                "read the complete encoder chart, then teach or assign the key again",
            )
        })?;
    let expected_chart = spec
        .expected_chart_sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            bad_request(
                "this programmable encoder binding has no complete-chart identity; nothing was mapped",
                "read the complete encoder chart, then teach or assign the key again",
            )
        })?;
    validate_sha256(expected_chart, "expected_chart_sha256")?;

    let root = config_root()?;
    let lease = acquire_programming_lease(root.dir())?;
    let selected = select_panel(
        Some(spec.device.trim().to_owned()),
        PanelProfileAccess::ReadChart,
    )?;
    if !selected.staged_selector_names_input {
        return Err(bad_request(
            "the staged device selector does not uniquely name this encoder's MI_00 keyboard input; nothing was mapped",
            "select the encoder's exact keyboard input in Setup, refresh the canvas, then teach the key again",
        ));
    }
    if !selected
        .input_instance
        .eq_ignore_ascii_case(expected_instance)
    {
        return Err(bad_request(
            "the encoder keyboard interface changed after this binding was opened; nothing was mapped",
            "refresh the canvas, read the selected encoder's complete chart, then try again",
        ));
    }
    if !selected
        .identity
        .fingerprint
        .eq_ignore_ascii_case(expected_fingerprint)
    {
        return Err(bad_request(
            "the physical encoder no longer matches the board that supplied this key; nothing was mapped",
            "read the currently connected encoder's complete chart, then teach the key again",
        ));
    }

    let mut store = backup_store(&root)?;
    let journal = PanelTransactionJournal::new(&store, &selected.identity);
    if let Some(pending) = journal
        .load_pending(&mut store, &selected.identity)
        .map_err(backup_error)?
    {
        return Err(pending_transaction_refusal(&pending));
    }
    let (current, configuration_handle) = read_stable_panel_image_with_final_handle(&selected)?;
    check_baseline(&current, expected_chart).map_err(programming_error)?;
    Ok(Box::new(LivePanelRoutingGuard {
        _configuration_handle: configuration_handle,
        _programming_lease: lease,
    }))
}

/// Classify the selected staged source from fresh machine inventory. Only an
/// exact profile with persistent chart-write capability needs chart-bound
/// routing authority; ordinary keyboards and recognized read-only encoders
/// retain the legacy bind path.
pub fn routing_guard_if_needed(
    spec: &PanelRoutingAuthoritySpec,
) -> Result<Option<Box<dyn PanelRoutingGuard>>, Refusal> {
    let report = crate::devices::collect();
    let hid = ksx_platform::hid::survey();
    let view = crate::panel::view(
        &report,
        &hid,
        &ksx_api::PanelStatusSpec {
            device: Some(spec.device.clone()),
        },
    )?;
    let [panel] = view.panels.as_slice() else {
        return Err(refused(
            "KSX could not resolve the staged input to one physical board; nothing was mapped",
            "reconnect the selected input, refresh the canvas, then try again",
        ));
    };
    if !panel.capabilities.can_write_chart || !panel.capabilities.write_is_persistent {
        return Ok(None);
    }
    routing_guard(spec).map(Some)
}

pub fn chart(spec: &PanelChartSpec) -> Result<PanelChartView, Refusal> {
    let selected = select_panel(spec.device.clone(), PanelProfileAccess::ReadChart)?;
    let root = config_root()?;
    let _lease = acquire_programming_lease(root.dir())?;
    let image = read_stable_panel_image(&selected)?;
    let mut store = backup_store(&root)?;
    let journal = PanelTransactionJournal::new(&store, &selected.identity);
    let mut pending = journal
        .load_pending(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let qualification_store = PanelQualificationStore::new(&store, &selected.identity);
    let mut reconciled_interruption = false;
    let saved = if spec.backup {
        // This is only the earliest retained capture in this backup set. It
        // must not be described as factory or pre-KSX provenance: the folder
        // may have been migrated, replaced, or deleted in the board's past.
        let reason = if store
            .list_verified(&selected.identity)
            .map_err(backup_error)?
            .is_empty()
        {
            BackupReason::InitialCapture
        } else {
            BackupReason::Manual
        };
        let stored = store
            .save_immutable(&selected.identity, &image, Timestamp::now_utc(), reason)
            .map_err(backup_error)?;
        verify_saved_backup(&mut store, &selected.identity, &stored, &image)
            .map_err(programming_error)?;
        Some(stored)
    } else {
        None
    };
    let mut qualification = qualification_store
        .state(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let mut completed_qualification = false;
    if spec.backup {
        if matches!(&qualification, PanelQualificationState::Required) {
            if let Some(unresolved) = pending.as_ref() {
                if unresolved.current.operation == "program" {
                    if let Some(terminal_id) = unresolved.current.qualification_terminal.as_deref()
                    {
                        if !image
                            .sha256()
                            .eq_ignore_ascii_case(&unresolved.current.base_sha256)
                        {
                            let safety_id =
                                BackupId::new(unresolved.current.safety_backup_id.clone())
                                    .map_err(backup_error)?;
                            let safety = store
                                .load_verified(&selected.identity, &safety_id)
                                .map_err(backup_error)?;
                            let reconstructed = qualification_store
                                .record_validation(
                                    &selected.identity,
                                    terminal_id,
                                    &unresolved.current.base_sha256,
                                    &unresolved.current.desired_sha256,
                                    &safety.stored,
                                    image
                                        .sha256()
                                        .eq_ignore_ascii_case(&unresolved.current.desired_sha256),
                                    Timestamp::now_utc(),
                                )
                                .map_err(backup_error)?;
                            qualification =
                                PanelQualificationState::ValidationWritten(Box::new(reconstructed));
                        }
                    }
                }
            }
        }
        if let (PanelQualificationState::ValidationWritten(validation), Some(unresolved)) =
            (&qualification, pending.as_ref())
        {
            if unresolved.current.operation == "restore"
                && unresolved
                    .current
                    .desired_sha256
                    .eq_ignore_ascii_case(&validation.base_sha256)
                && image.sha256().eq_ignore_ascii_case(&validation.base_sha256)
            {
                let qualified = qualification_store
                    .complete(
                        &selected.identity,
                        validation,
                        image.sha256(),
                        Timestamp::now_utc(),
                    )
                    .map_err(backup_error)?;
                qualification = if qualified {
                    PanelQualificationState::Qualified
                } else {
                    PanelQualificationState::Required
                };
                completed_qualification = qualified;
            }
        }
    }
    if spec.backup {
        if let Some(unresolved) = pending.as_ref() {
            journal
                .resolve(unresolved, "reconciled-read", image.sha256())
                .map_err(|error| {
                    Refusal::with_remedy(
                        ksx_api::codes::RECOVERY_REQUIRED,
                        format!(
                            "the complete chart and backup were verified, but the interrupted-transaction receipt could not be reconciled: {error}"
                        ),
                        "preserve the panel-backups folder and retry the supervised chart read before any new program",
                    )
                })?;
            pending = None;
            reconciled_interruption = true;
        }
    }
    let mut view = chart_view(
        &selected,
        &image,
        saved.as_ref(),
        pending.as_ref(),
        reconciled_interruption,
        &qualification,
    );
    if completed_qualification {
        view.notes.push(
            "The stable chart matched the qualification baseline and was backed up; the physical encoder is now qualified for full-chart programming."
                .to_owned(),
        );
    }
    Ok(view)
}

pub fn backups(spec: &PanelBackupsSpec) -> Result<PanelBackupsView, Refusal> {
    let selected = select_panel(spec.device.clone(), PanelProfileAccess::ReadChart)?;
    let root = config_root()?;
    let store = backup_store(&root)?;
    let rows = store
        .list_verified(&selected.identity)
        .map_err(backup_error)?
        .into_iter()
        .map(|stored| backup_row_for(&selected.identity, &stored))
        .collect::<Vec<_>>();
    Ok(PanelBackupsView {
        summary: format!(
            "{} verified lossless restore point{} for {}.",
            rows.len(),
            if rows.len() == 1 { "" } else { "s" },
            selected.name
        ),
        board_fingerprint: selected.identity.fingerprint,
        backups: rows,
    })
}

pub fn program_plan(spec: &PanelProgramSpec) -> Result<PanelProgramPlanView, Refusal> {
    validate_sha256(&spec.expected_base_sha256, "expected_base_sha256")?;
    terminal_edits(spec)?;
    let selected = select_panel(spec.device.clone(), PanelProfileAccess::PersistentWrite)?;
    let root = config_root()?;
    let _lease = acquire_programming_lease(root.dir())?;
    let mut store = backup_store(&root)?;
    let journal = PanelTransactionJournal::new(&store, &selected.identity);
    if let Some(pending) = journal
        .load_pending(&mut store, &selected.identity)
        .map_err(backup_error)?
    {
        return Err(pending_transaction_refusal(&pending));
    }
    let image = read_stable_panel_image(&selected)?;
    check_baseline(&image, &spec.expected_base_sha256).map_err(programming_error)?;
    let edits = terminal_edits_for_image(spec, &image)?;
    let plan = plan_program(&image, &edits).map_err(programming_error)?;
    validate_complete_desired_keys(spec, &image, &plan.desired)?;
    let qualification = PanelQualificationStore::new(&store, &selected.identity)
        .state(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let qualification_full_chart_consent =
        matches!(&qualification, PanelQualificationState::Required)
            && qualification_validation_terminal(spec, &plan, &image).is_some();
    let mut blockers = session_write_blockers("programming");
    blockers.extend(qualification_program_blockers(
        &qualification,
        spec,
        &plan,
        &image,
    ));
    Ok(plan_view(
        &selected,
        &plan,
        blockers,
        "Program the reviewed chart",
        qualification_full_chart_consent,
    ))
}

pub fn program(spec: &PanelProgramApplySpec) -> Result<PanelProgramOutcome, Refusal> {
    if !spec.confirm {
        return Err(bad_request(
            "explicit programming confirmation is required; nothing was changed",
            "review the exact terminal and byte diff, then confirm that named board",
        ));
    }
    validate_sha256(&spec.program.expected_base_sha256, "expected_base_sha256")?;
    validate_sha256(&spec.expected_desired_sha256, "expected_desired_sha256")?;
    require_session_stopped("programming")?;
    terminal_edits(&spec.program)?;
    let selected = select_panel(
        spec.program.device.clone(),
        PanelProfileAccess::PersistentWrite,
    )?;
    validate_supervised_binding(
        &selected,
        &spec.expected_board_fingerprint,
        &spec.expected_protocol_profile,
        spec.supervised,
    )?;
    let root = config_root()?;
    let _lease = acquire_programming_lease(root.dir())?;
    let mut store = backup_store(&root)?;
    let journal = PanelTransactionJournal::new(&store, &selected.identity);
    if let Some(pending) = journal
        .load_pending(&mut store, &selected.identity)
        .map_err(backup_error)?
    {
        return Err(pending_transaction_refusal(&pending));
    }
    let current = read_stable_panel_image(&selected)?;
    check_baseline(&current, &spec.program.expected_base_sha256).map_err(programming_error)?;
    let edits = terminal_edits_for_image(&spec.program, &current)?;
    let reviewed = plan_program(&current, &edits).map_err(programming_error)?;
    validate_complete_desired_keys(&spec.program, &current, &reviewed.desired)?;
    let qualification_store = PanelQualificationStore::new(&store, &selected.identity);
    let qualification = qualification_store
        .state(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let qualification_terminal =
        require_qualification_program(&qualification, &spec.program, &reviewed, &current)?;
    if reviewed.is_noop() {
        return Err(bad_request(
            "the reviewed chart is already present; no hardware write or backup was needed",
            "close the review or make a real terminal change",
        ));
    }
    if !reviewed
        .desired_sha256
        .eq_ignore_ascii_case(spec.expected_desired_sha256.trim())
    {
        return Err(bad_request(
            "the desired chart hash no longer matches the reviewed diff; nothing was changed",
            "rebuild and review the hardware diff before confirming again",
        ));
    }
    let mut io = open_panel(&selected)?;
    require_session_stopped("programming")?;
    let transaction_timestamp = Timestamp::now_utc();
    let mut started_transaction = None;
    let result = apply_program_guarded(
        &mut io,
        &mut store,
        &selected.identity,
        &spec.program.expected_base_sha256,
        &edits,
        transaction_timestamp,
        |backup, plan| {
            packet_zero_session_guard("programming")?;
            started_transaction = Some(journal.begin(
                &selected.identity,
                "program",
                &plan.baseline_sha256,
                &plan.desired_sha256,
                backup,
                transaction_timestamp,
                None,
                qualification_terminal,
            )?);
            Ok(())
        },
    );
    match result {
        Ok(outcome) => {
            let Some(stored) = outcome.backup.as_ref() else {
                return Err(Refusal::with_remedy(
                    ksx_api::codes::RECOVERY_REQUIRED,
                    "the hardware transaction returned without its required backup",
                    "do not retry; inspect the panel backup folder and report this invariant failure",
                ));
            };
            let Some(started) = started_transaction.as_ref() else {
                return Err(Refusal::with_remedy(
                    ksx_api::codes::RECOVERY_REQUIRED,
                    "the encoder verified, but its durable transaction receipt was missing",
                    "do not program again; preserve the panel-backups folder and inspect this board",
                ));
            };
            let validation = if let Some(terminal_id) = qualification_terminal {
                match qualification_store.record_validation(
                    &selected.identity,
                    terminal_id,
                    &reviewed.baseline_sha256,
                    &reviewed.desired_sha256,
                    stored,
                    true,
                    Timestamp::now_utc(),
                ) {
                    Ok(validation) => Some(validation),
                    Err(error) => {
                        return Err(Refusal::with_remedy(
                            ksx_api::codes::RECOVERY_REQUIRED,
                            format!(
                                "the one-terminal hardware write verified, but its qualification receipt could not be saved: {error}"
                            ),
                            format!(
                                "do not program another key; restore safety backup {} and preserve the panel-backups folder",
                                stored.id
                            ),
                        ))
                    }
                }
            } else {
                None
            };
            journal
                .resolve(started, "verified", &outcome.verified_sha256)
                .map_err(|error| {
                    Refusal::with_remedy(
                        ksx_api::codes::RECOVERY_REQUIRED,
                        format!(
                            "the encoder verified, but its pending transaction receipt could not be completed: {error}"
                        ),
                        "do not program again; read and back up the complete chart to reconcile the durable pending transaction",
                    )
                })?;
            Ok(PanelProgramOutcome {
                state: "verified".to_owned(),
                summary: format!(
                    "{} was programmed and all {} bytes matched the reviewed chart on readback.",
                    selected.name,
                    reviewed.desired.len()
                ),
                board_fingerprint: selected.identity.fingerprint.clone(),
                expected_sha256: outcome.desired_sha256,
                observed_sha256: Some(outcome.verified_sha256),
                backup: backup_row_for(&selected.identity, stored),
                verified_at: timestamp_rfc3339(Timestamp::now_utc()),
                next_step: validation.map_or_else(
                    || "Teach each physical control so KSX can compare the Windows signal with its programmed terminal assignment.".to_owned(),
                    |validation| format!(
                        "Validation write verified. Restore exact safety backup {} now; full-chart programming stays locked until that readback also verifies.",
                        validation.safety_backup_id
                    ),
                ),
            })
        }
        Err(error) => {
            recovery_outcome(&error, &selected, &mut store, &spec.expected_desired_sha256)
                .unwrap_or_else(|| Err(programming_error(error)))
        }
    }
}

pub fn restore_plan(spec: &PanelRestoreSpec) -> Result<PanelProgramPlanView, Refusal> {
    validate_sha256(&spec.expected_current_sha256, "expected_current_sha256")?;
    let backup_id = BackupId::new(spec.backup_id.clone()).map_err(backup_error)?;
    let selected = select_panel(spec.device.clone(), PanelProfileAccess::PersistentWrite)?;
    let root = config_root()?;
    let _lease = acquire_programming_lease(root.dir())?;
    let mut store = backup_store(&root)?;
    let target = store
        .load_verified(&selected.identity, &backup_id)
        .map_err(backup_error)?;
    let current = read_stable_panel_image(&selected)?;
    check_baseline(&current, &spec.expected_current_sha256).map_err(programming_error)?;
    let plan = plan_restore(&current, &target.image).map_err(programming_error)?;
    let qualification = PanelQualificationStore::new(&store, &selected.identity)
        .state(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let mut blockers = session_write_blockers("restoring");
    if let Some(blocker) = qualification_restore_blocker(&qualification, &backup_id) {
        blockers.push(blocker);
    }
    Ok(plan_view(
        &selected,
        &plan,
        blockers,
        &format!("Restore verified backup {}", backup_id),
        false,
    ))
}

pub fn restore(spec: &PanelRestoreApplySpec) -> Result<PanelProgramOutcome, Refusal> {
    if !spec.confirm {
        return Err(bad_request(
            "explicit restore confirmation is required; nothing was changed",
            "review the exact reverse diff, then confirm that named board",
        ));
    }
    validate_sha256(
        &spec.restore.expected_current_sha256,
        "expected_current_sha256",
    )?;
    validate_sha256(&spec.expected_desired_sha256, "expected_desired_sha256")?;
    require_session_stopped("restoring")?;
    let backup_id = BackupId::new(spec.restore.backup_id.clone()).map_err(backup_error)?;
    let selected = select_panel(
        spec.restore.device.clone(),
        PanelProfileAccess::PersistentWrite,
    )?;
    validate_supervised_binding(
        &selected,
        &spec.expected_board_fingerprint,
        &spec.expected_protocol_profile,
        spec.supervised,
    )?;
    let root = config_root()?;
    let _lease = acquire_programming_lease(root.dir())?;
    let mut store = backup_store(&root)?;
    let journal = PanelTransactionJournal::new(&store, &selected.identity);
    let prior_pending = journal
        .load_pending(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let qualification_store = PanelQualificationStore::new(&store, &selected.identity);
    let qualification = qualification_store
        .state(&mut store, &selected.identity)
        .map_err(backup_error)?;
    let qualification_validation =
        require_qualification_restore(&qualification, &backup_id)?.cloned();
    let target = store
        .load_verified(&selected.identity, &backup_id)
        .map_err(backup_error)?;
    let current = read_stable_panel_image(&selected)?;
    check_baseline(&current, &spec.restore.expected_current_sha256).map_err(programming_error)?;
    let reviewed = plan_restore(&current, &target.image).map_err(programming_error)?;
    if reviewed.is_noop() {
        return Err(bad_request(
            "the selected backup is already present on the encoder; nothing was written",
            "choose another restore point or close the review",
        ));
    }
    if !reviewed
        .desired_sha256
        .eq_ignore_ascii_case(spec.expected_desired_sha256.trim())
    {
        return Err(bad_request(
            "the restore hash no longer matches the reviewed reverse diff; nothing was changed",
            "rebuild and review the restore diff before confirming again",
        ));
    }
    let mut io = open_panel(&selected)?;
    require_session_stopped("restoring")?;
    let transaction_timestamp = Timestamp::now_utc();
    let mut started_transaction = None;
    let result = apply_restore_guarded(
        &mut io,
        &mut store,
        &selected.identity,
        &backup_id,
        &spec.restore.expected_current_sha256,
        &spec.expected_desired_sha256,
        transaction_timestamp,
        |backup, plan| {
            packet_zero_session_guard("restoring")?;
            started_transaction = Some(journal.begin(
                &selected.identity,
                "restore",
                &plan.baseline_sha256,
                &plan.desired_sha256,
                backup,
                transaction_timestamp,
                prior_pending.clone(),
                None,
            )?);
            Ok(())
        },
    );
    match result {
        Ok(outcome) => {
            let Some(stored) = outcome.backup.as_ref() else {
                return Err(Refusal::with_remedy(
                    ksx_api::codes::RECOVERY_REQUIRED,
                    "the restore transaction returned without its required safety backup",
                    "do not retry; inspect the panel backup folder and report this invariant failure",
                ));
            };
            let Some(started) = started_transaction.as_ref() else {
                return Err(Refusal::with_remedy(
                    ksx_api::codes::RECOVERY_REQUIRED,
                    "the encoder restore verified, but its durable transaction receipt was missing",
                    "do not restore again; preserve the panel-backups folder and inspect this board",
                ));
            };
            let qualification_completed = if let Some(validation) =
                qualification_validation.as_ref()
            {
                Some(qualification_store
                    .complete(
                        &selected.identity,
                        validation,
                        &outcome.verified_sha256,
                        Timestamp::now_utc(),
                    )
                    .map_err(|error| {
                        Refusal::with_remedy(
                            ksx_api::codes::RECOVERY_REQUIRED,
                            format!(
                                "the validation restore verified, but its qualification receipt could not be completed: {error}"
                            ),
                            "do not program another chart; read and back up the complete chart to reconcile the pending restore",
                        )
                    })?)
            } else {
                None
            };
            journal
                .resolve(started, "verified", &outcome.verified_sha256)
                .map_err(|error| {
                    Refusal::with_remedy(
                        ksx_api::codes::RECOVERY_REQUIRED,
                        format!(
                            "the encoder restore verified, but its pending transaction receipt could not be completed: {error}"
                        ),
                        "do not restore again; read and back up the complete chart to reconcile the durable pending transaction",
                    )
                })?;
            Ok(PanelProgramOutcome {
                state: "verified".to_owned(),
                summary: format!(
                    "{} was restored and all {} bytes matched the selected backup on readback.",
                    selected.name,
                    reviewed.desired.len()
                ),
                board_fingerprint: selected.identity.fingerprint.clone(),
                expected_sha256: outcome.desired_sha256,
                observed_sha256: Some(outcome.verified_sha256),
                backup: backup_row_for(&selected.identity, stored),
                verified_at: timestamp_rfc3339(Timestamp::now_utc()),
                next_step: match qualification_completed {
                    Some(true) => "Writer qualification is complete. Full-chart layouts are now unlocked; review a fresh chart before programming one."
                        .to_owned(),
                    Some(false) => "The interrupted validation chart was safely restored. Repeat the one-terminal writer test; full-chart programming remains locked."
                        .to_owned(),
                    None => "Teach the panel again so every physical signal is verified against the restored chart."
                        .to_owned(),
                },
            })
        }
        Err(error) => {
            recovery_outcome(&error, &selected, &mut store, &spec.expected_desired_sha256)
                .unwrap_or_else(|| Err(programming_error(error)))
        }
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn render_chart(view: &PanelChartView) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Panel encoder chart");
    let _ = writeln!(out, "{}", view.summary);
    let _ = writeln!(out, "Board       : {}", view.board_name);
    let _ = writeln!(out, "Fingerprint : {}", view.board_fingerprint);
    let _ = writeln!(out, "Profile     : {}", view.protocol_profile);
    let _ = writeln!(
        out,
        "Image       : {} bytes · {}",
        view.image_bytes, view.image_sha256
    );
    let _ = writeln!(out, "Programming : {}", view.programming_detail);
    let _ = writeln!(out, "Qualification: {}", view.qualification_detail);
    if let Some(backup) = &view.backup {
        let _ = writeln!(out, "Backup      : {}", backup.backup_id);
    }
    let _ = writeln!(
        out,
        "\nTerminal       Normal                 Shifted                Shift state"
    );
    for row in &view.terminals {
        let _ = writeln!(
            out,
            "{:<14} {:<22} {:<22} {}",
            row.terminal_id,
            row.normal.label,
            row.shifted.label,
            match row.shift_state {
                PanelShiftState::Disabled => "disabled",
                PanelShiftState::Enabled => "enabled",
                PanelShiftState::Opaque => "opaque (preserved)",
            }
        );
    }
    out
}

fn render_backups(view: &PanelBackupsView) -> String {
    let mut out = format!("Panel encoder backups\n{}\n", view.summary);
    for backup in &view.backups {
        let _ = writeln!(
            out,
            "{}  {} bytes  {}\n  {}",
            backup.backup_id, backup.image_bytes, backup.reason, backup.image_sha256
        );
    }
    out
}

fn render_plan(view: &PanelProgramPlanView) -> String {
    let mut out = format!(
        "Panel hardware diff\n{}\nBoard   : {}\nProfile : {}\nBase    : {}\nDesired : {}\n",
        view.summary, view.board_name, view.protocol_profile, view.base_sha256, view.desired_sha256
    );
    for row in &view.terminal_diff {
        let _ = writeln!(
            out,
            "  {} {}: {} -> {}",
            row.terminal_id, row.layer, row.before, row.after
        );
    }
    if !view.byte_diff.is_empty() {
        let _ = writeln!(out, "\nExact byte changes:");
        for row in &view.byte_diff {
            let _ = writeln!(
                out,
                "  [{:03}] 0x{:02X} -> 0x{:02X}  {}",
                row.offset, row.before, row.after, row.meaning
            );
        }
    }
    for blocker in &view.blockers {
        let _ = writeln!(out, "BLOCKED: {blocker}");
    }
    let _ = writeln!(out, "\nConfirmation: {}", view.confirmation);
    out
}

fn render_outcome(view: &PanelProgramOutcome) -> String {
    format!(
        "Panel transaction · {}\n{}\nExpected : {}\nObserved : {}\nBackup   : {}\nNext     : {}\n",
        view.state,
        view.summary,
        view.expected_sha256,
        view.observed_sha256.as_deref().unwrap_or("unavailable"),
        view.backup.backup_id,
        view.next_step
    )
}

pub fn run_chart_cli(spec: PanelChartSpec, json: bool) -> anyhow::Result<()> {
    let view = chart(&spec)?;
    if json {
        print_json(&view)
    } else {
        print!("{}", render_chart(&view));
        Ok(())
    }
}

pub fn run_backups_cli(spec: PanelBackupsSpec, json: bool) -> anyhow::Result<()> {
    let view = backups(&spec)?;
    if json {
        print_json(&view)
    } else {
        print!("{}", render_backups(&view));
        Ok(())
    }
}

/// Read one board's chart and print it.
///
/// Takes plain arguments rather than a spec because `ksx-app` does not depend on
/// `ksx-api` — `panel::run` sets the same precedent, and widening the binary's
/// dependency graph to name one struct would be the wrong trade.
pub fn run_chart(device: Option<String>, backup: bool, json: bool) -> anyhow::Result<()> {
    run_chart_cli(PanelChartSpec { device, backup }, json)
}

/// List the local restore points. Reads the backup store; opens no device.
pub fn run_backups(device: Option<String>, json: bool) -> anyhow::Result<()> {
    run_backups_cli(PanelBackupsSpec { device }, json)
}

pub fn run_program_cli(
    spec: PanelProgramSpec,
    expected_desired_sha256: Option<String>,
    expected_board_fingerprint: Option<String>,
    expected_protocol_profile: Option<String>,
    supervised: bool,
    yes: bool,
    json: bool,
) -> anyhow::Result<()> {
    if yes {
        let view = program(&PanelProgramApplySpec {
            program: spec,
            expected_desired_sha256: expected_desired_sha256.ok_or_else(|| {
                anyhow::anyhow!("--yes requires --expected-desired-sha256 from the reviewed plan")
            })?,
            expected_board_fingerprint: expected_board_fingerprint.ok_or_else(|| {
                anyhow::anyhow!(
                    "--yes requires --expected-board-fingerprint from the reviewed plan"
                )
            })?,
            expected_protocol_profile: expected_protocol_profile.ok_or_else(|| {
                anyhow::anyhow!("--yes requires --expected-protocol-profile from the reviewed plan")
            })?,
            confirm: true,
            supervised,
        })?;
        if json {
            print_json(&view)
        } else {
            print!("{}", render_outcome(&view));
            Ok(())
        }
    } else {
        let view = program_plan(&spec)?;
        if json {
            print_json(&view)
        } else {
            print!("{}", render_plan(&view));
            Ok(())
        }
    }
}

pub fn run_restore_cli(
    spec: PanelRestoreSpec,
    expected_desired_sha256: Option<String>,
    expected_board_fingerprint: Option<String>,
    expected_protocol_profile: Option<String>,
    supervised: bool,
    yes: bool,
    json: bool,
) -> anyhow::Result<()> {
    if yes {
        let view = restore(&PanelRestoreApplySpec {
            restore: spec,
            expected_desired_sha256: expected_desired_sha256.ok_or_else(|| {
                anyhow::anyhow!("--yes requires --expected-desired-sha256 from the reviewed plan")
            })?,
            expected_board_fingerprint: expected_board_fingerprint.ok_or_else(|| {
                anyhow::anyhow!(
                    "--yes requires --expected-board-fingerprint from the reviewed plan"
                )
            })?,
            expected_protocol_profile: expected_protocol_profile.ok_or_else(|| {
                anyhow::anyhow!("--yes requires --expected-protocol-profile from the reviewed plan")
            })?,
            confirm: true,
            supervised,
        })?;
        if json {
            print_json(&view)
        } else {
            print!("{}", render_outcome(&view));
            Ok(())
        }
    } else {
        let view = restore_plan(&spec)?;
        if json {
            print_json(&view)
        } else {
            print!("{}", render_plan(&view));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use ksx_capture::winusb::Binding;
    use ksx_core::DeviceId;

    use super::*;

    static JOURNAL_TEST_SERIAL: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    struct JournalTestDir(PathBuf);

    impl JournalTestDir {
        fn new() -> Self {
            let serial = JOURNAL_TEST_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ksx-panel-journal-test-{}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for JournalTestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_identity() -> BoardIdentity {
        BoardIdentity {
            driver: IPAC4_DRIVER.to_owned(),
            vid: 0xD209,
            pid: 0x0430,
            bcd_device: IPAC4_BCD_DEVICE,
            serial: Some("journal-test".to_owned()),
            fingerprint: "IPAC4-JOURNAL-TEST".to_owned(),
        }
    }

    fn test_profile() -> &'static PanelProtocolProfile {
        profile_for(0xD209, 0x0430, IPAC4_BCD_DEVICE).expect("measured I-PAC 4 profile")
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_names_the_busy_configuration_interface() {
        let refusal = panel_open_refusal(HidReportError::Open(std::io::Error::from_raw_os_error(
            windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32,
        )));

        assert_eq!(refusal.code, ksx_api::codes::PANEL_INTERFACE_BUSY);
        assert!(refusal.message.contains("Another app is using"));
        assert!(refusal
            .message
            .contains("no persistent chart write was started"));
        assert!(!refusal.message.contains("nothing was sent"));
        assert!(refusal
            .remedy
            .as_deref()
            .is_some_and(|line| line.contains("WinIPAC") && line.contains("keyboard input")));
    }

    #[test]
    fn other_open_failures_do_not_claim_an_interface_owner() {
        // Windows access denied is 5. Only sharing violation 32 proves that
        // another process owns the exclusive configuration collection.
        let refusal =
            panel_open_refusal(HidReportError::Open(std::io::Error::from_raw_os_error(5)));

        assert_eq!(refusal.code, ksx_api::codes::REFUSED);
        assert!(!refusal.message.contains("open in another app"));
        assert!(refusal
            .message
            .contains("no persistent chart write was started"));
        assert!(refusal
            .remedy
            .as_deref()
            .is_some_and(|line| line.contains("reconnect the encoder")));
    }

    fn status_row_for(vid: u16, pid: u16, bcd_device: u16) -> PanelStatusRow {
        let family = crate::panel_catalog::family_for(vid, pid);
        let profile = profile_for(vid, pid, bcd_device);
        PanelStatusRow {
            name: family
                .map_or("Test encoder", |family| family.label)
                .to_owned(),
            vendor_id: vid,
            product_id: pid,
            family_id: family.map(|family| family.id.to_owned()),
            family_label: family.map(|family| family.label.to_owned()),
            bcd_device,
            driver: profile
                .map_or("unsupported", |profile| profile.driver_id)
                .to_owned(),
            driver_supported: profile.is_some(),
            capabilities: crate::panel_catalog::capabilities_for(family, profile),
            ..PanelStatusRow::default()
        }
    }

    fn status_usb(parent: &str, bus: &str, port: u8) -> crate::devices::UsbRow {
        crate::devices::UsbRow {
            candidate: ksx_capture::UsbCandidate {
                id: DeviceId::new(format!(r"{parent}&MI_00")),
                parent_id: parent.to_owned(),
                vendor_id: 0xD209,
                product_id: 0x0430,
                bcd_device: IPAC4_BCD_DEVICE,
                interface_number: 0,
                interface_class: 3,
                interface_subclass: 1,
                interface_protocol: 1,
                interface_string: None,
                product: Some("I-PAC 4".to_owned()),
                serial: Some("4".to_owned()),
                device_desc: Some("USB Input Device".to_owned()),
                port_chain: vec![port],
                bus_id: bus.to_owned(),
                binding: Binding::HidUsb,
            },
            alias: None,
            selected: false,
        }
    }

    fn status_usb_sibling(
        parent: &str,
        bus: &str,
        port: u8,
        interface_number: u8,
    ) -> crate::devices::UsbRow {
        let mut row = status_usb(parent, bus, port);
        let instance = ksx_core::DeviceFacts::instance_of(parent);
        row.candidate.id = DeviceId::new(format!(
            r"USB\VID_D209&PID_0430&MI_{interface_number:02X}\{instance}"
        ));
        row.candidate.interface_number = interface_number;
        if interface_number != 0 {
            row.candidate.interface_subclass = 0;
            row.candidate.interface_protocol = 0;
        }
        row
    }

    /// Broken version caught: panel selection grouped MI_00 and MI_02 by
    /// physical parent, allowing a staged selector for the configuration
    /// interface to borrow the keyboard interface's routing authority.
    #[test]
    fn routing_selector_must_uniquely_name_the_exact_mi00_input() {
        const BOARD: &str = r"USB\VID_D209&PID_0430\ROUTE_BOARD";
        let input = status_usb_sibling(BOARD, "1", 4, 0);
        let configuration = status_usb_sibling(BOARD, "1", 4, 2);
        let input_id = input.candidate.id.as_str().to_owned();
        let configuration_id = configuration.candidate.id.as_str().to_owned();
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![input, configuration],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );

        assert!(staged_selector_names_exact_input(
            &report,
            "usb:d209:0430:00",
            &input_id,
        ));
        assert!(staged_selector_names_exact_input(
            &report, &input_id, &input_id
        ));
        assert!(!staged_selector_names_exact_input(
            &report,
            "usb:d209:0430:02",
            &input_id,
        ));
        assert!(!staged_selector_names_exact_input(
            &report,
            &configuration_id,
            &input_id,
        ));
        assert!(!staged_selector_names_exact_input(
            &report,
            "usb:d209:0430:00",
            &configuration_id,
        ));
    }

    #[test]
    fn routing_selector_refuses_ambiguous_mi00_twins() {
        const BOARD_A: &str = r"USB\VID_D209&PID_0430\ROUTE_A";
        const BOARD_B: &str = r"USB\VID_D209&PID_0430\ROUTE_B";
        let input_a = status_usb_sibling(BOARD_A, "1", 4, 0);
        let input_a_id = input_a.candidate.id.as_str().to_owned();
        let input_b = status_usb_sibling(BOARD_B, "1", 5, 0);
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![input_a, input_b],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );

        assert!(!staged_selector_names_exact_input(
            &report,
            "usb:d209:0430:00",
            &input_a_id,
        ));
    }

    #[test]
    fn passive_status_scopes_durable_recovery_to_the_exact_physical_board() {
        const BOARD_A: &str = r"USB\VID_D209&PID_0430\BOARD_A";
        const BOARD_B: &str = r"USB\VID_D209&PID_0430\BOARD_B";
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![status_usb(BOARD_A, "1", 4), status_usb(BOARD_B, "1", 5)],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );
        let mut panel_a = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        panel_a.board_id = BOARD_A.to_owned();
        panel_a.serial = Some("4".to_owned());
        let mut panel_b = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        panel_b.board_id = BOARD_B.to_owned();
        panel_b.serial = Some("4".to_owned());

        let dir = JournalTestDir::new();
        let identity_a = board_identity_from_status(&report, &panel_a).unwrap();
        let mut store = BackupStore::new(&dir.0);
        let baseline = image();
        let backup = store
            .save_immutable(
                &identity_a,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        let journal = PanelTransactionJournal::new(&store, &identity_a);
        let pending = journal
            .begin(
                &identity_a,
                "program",
                baseline.sha256(),
                &"B".repeat(64),
                &backup,
                test_stamp(),
                None,
                None,
            )
            .unwrap();

        let mut panels = vec![panel_a.clone(), panel_b.clone()];
        decorate_recovery_status_at(&dir.0, &report, &mut panels);
        assert!(panels[0].programming_recovery_required);
        assert!(!panels[1].programming_recovery_required);
        assert!(panels[0]
            .programming_recovery_detail
            .contains(&pending.current.transaction_id));

        journal
            .resolve(&pending, "verified-readback", baseline.sha256())
            .unwrap();
        decorate_recovery_status_at(&dir.0, &report, &mut panels);
        assert!(!panels[0].programming_recovery_required);
        assert!(!panels[1].programming_recovery_required);

        std::fs::write(journal.pending_path(), b"{ malformed journal").unwrap();
        decorate_recovery_status_at(&dir.0, &report, &mut panels);
        assert!(panels[0].programming_recovery_required);
        assert!(!panels[1].programming_recovery_required);
        assert!(panels[0]
            .programming_recovery_detail
            .contains("cannot prove"));
    }

    /// Broken version caught: status could observe no marker after a second
    /// process acquired the writer lease but before that writer committed its
    /// pre-packet journal, briefly publishing false route authority.
    #[test]
    fn passive_status_fails_closed_while_the_machine_lease_is_busy() {
        const BOARD: &str = r"USB\VID_D209&PID_0430\BUSY_STATUS";
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![status_usb(BOARD, "1", 4)],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );
        let mut panel = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        panel.board_id = BOARD.to_owned();
        panel.serial = Some("4".to_owned());
        let dir = JournalTestDir::new();
        let recovery_root = dir.0.join(BACKUP_DIR);
        let _lease = acquire_programming_lease(&dir.0).expect("first lease");

        decorate_recovery_status_guarded_at(
            &dir.0,
            &recovery_root,
            &report,
            std::slice::from_mut(&mut panel),
        );

        assert!(panel.programming_recovery_required);
        assert!(panel.programming_recovery_detail.contains("hardware lease"));
    }

    /// Broken version caught: passive status followed or ignored substituted
    /// recovery path levels while Play/start rejected the same store.
    #[test]
    fn passive_status_rejects_a_wrong_kind_recovery_path() {
        const BOARD: &str = r"USB\VID_D209&PID_0430\WRONG_KIND_STATUS";
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![status_usb(BOARD, "1", 4)],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );
        let mut panel = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        panel.board_id = BOARD.to_owned();
        panel.serial = Some("4".to_owned());
        let dir = JournalTestDir::new();
        let recovery_root = dir.0.join(BACKUP_DIR);
        std::fs::create_dir_all(&recovery_root).unwrap();
        std::fs::write(recovery_root.join(IPAC4_DRIVER), b"not a directory").unwrap();

        decorate_recovery_status_guarded_at(
            &dir.0,
            &recovery_root,
            &report,
            std::slice::from_mut(&mut panel),
        );

        assert!(panel.programming_recovery_required);
        assert!(panel
            .programming_recovery_detail
            .contains("panel driver level"));
    }

    /// Broken version caught: on Unix the filesystem lease was created below
    /// `panel-backups`, so even a passive status request followed and wrote
    /// through a substituted recovery-root symlink before rejecting it.
    #[test]
    fn passive_status_never_follows_a_reparse_recovery_root() {
        const BOARD: &str = r"USB\VID_D209&PID_0430\REPARSE_STATUS";
        let report = crate::devices::DevicesReport::build(
            Vec::new(),
            false,
            vec![status_usb(BOARD, "1", 4)],
            true,
            Vec::new(),
            true,
            crate::devices::ConfiguredDevices::default(),
        );
        let mut panel = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        panel.board_id = BOARD.to_owned();
        panel.serial = Some("4".to_owned());
        let dir = JournalTestDir::new();
        let target = dir.0.join("redirect-target");
        std::fs::create_dir_all(&target).unwrap();
        let recovery_root = dir.0.join(BACKUP_DIR);
        create_test_directory_link(&recovery_root, &target);

        decorate_recovery_status_guarded_at(
            &dir.0,
            &recovery_root,
            &report,
            std::slice::from_mut(&mut panel),
        );

        assert!(panel.programming_recovery_required);
        assert!(panel
            .programming_recovery_detail
            .contains("symlink, junction"));
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
    }

    #[test]
    fn programming_admission_requires_the_exact_measured_profile_not_family_recognition() {
        let measured = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        assert_eq!(
            admitted_programming_profile(&measured, PanelProfileAccess::ReadChart)
                .expect("measured profile")
                .driver,
            PanelProtocolDriver::Ipac4Pac256V1
        );

        for recognition_only in [
            status_row_for(0xD208, 0x0310, IPAC4_BCD_DEVICE),
            status_row_for(0xD209, 0x0410, IPAC4_BCD_DEVICE),
            status_row_for(0xD209, 0x0420, IPAC4_BCD_DEVICE),
            status_row_for(0xD209, 0x0430, 0x0057),
            status_row_for(0xD209, 0x0440, IPAC4_BCD_DEVICE),
            status_row_for(0xD209, 0x0450, IPAC4_BCD_DEVICE),
            status_row_for(0xD209, 0x1501, IPAC4_BCD_DEVICE),
        ] {
            let refusal =
                admitted_programming_profile(&recognition_only, PanelProfileAccess::ReadChart)
                    .unwrap_err();
            assert!(refusal.message.contains("no exact measured chart profile"));
        }

        let mut stale_status = measured;
        stale_status.driver_supported = false;
        let refusal =
            admitted_programming_profile(&stale_status, PanelProfileAccess::ReadChart).unwrap_err();
        assert!(refusal
            .message
            .contains("complete ipac4-pac256-v1 admission contract"));

        let mut capability_drift = status_row_for(0xD209, 0x0430, IPAC4_BCD_DEVICE);
        capability_drift.capabilities.can_write_chart = false;
        let refusal =
            admitted_programming_profile(&capability_drift, PanelProfileAccess::PersistentWrite)
                .unwrap_err();
        assert!(refusal
            .message
            .contains("complete ipac4-pac256-v1 admission contract"));
    }

    #[test]
    fn read_only_capabilities_never_admit_a_persistent_mutation() {
        let read_only = PanelDriverCapabilities {
            can_identify: true,
            can_report_mode: false,
            can_read_chart: true,
            can_write_chart: false,
            write_is_persistent: false,
        };
        assert!(capabilities_admit(read_only, PanelProfileAccess::ReadChart));
        assert!(!capabilities_admit(
            read_only,
            PanelProfileAccess::PersistentWrite
        ));

        let volatile_writer = PanelDriverCapabilities {
            can_write_chart: true,
            ..read_only
        };
        assert!(!capabilities_admit(
            volatile_writer,
            PanelProfileAccess::PersistentWrite
        ));
        assert!(capabilities_admit(
            test_profile().capabilities,
            PanelProfileAccess::PersistentWrite
        ));
    }

    fn test_stamp() -> Timestamp {
        Timestamp {
            year: 2026,
            month: 8,
            day: 23,
            hour: 12,
            minute: 0,
            second: 0,
        }
    }

    fn image() -> RawPanelImage {
        let mut bytes = vec![0; IPAC4_IMAGE_BYTES];
        bytes[..4].copy_from_slice(&[0x50, 0xDD, 0x56, 0x01]);
        RawPanelImage::new(bytes).unwrap()
    }

    fn qualification_image() -> RawPanelImage {
        let mut bytes = image().bytes().to_vec();
        for terminal in IPAC4_TERMINALS {
            bytes[terminal.image_offset(TerminalPlane::Shift)] = 0x01;
        }
        RawPanelImage::new(bytes).unwrap()
    }

    #[test]
    fn served_key_roster_is_unique_and_observable() {
        let roster = key_roster();
        // 106 mapped HID usages minus the 0x31/0x32 alias and Pause (which
        // cannot produce a press in KSX's E1 contract).
        assert_eq!(roster.len(), 104);
        assert_eq!(
            roster
                .iter()
                .map(|(key, _)| *key)
                .collect::<BTreeSet<_>>()
                .len(),
            roster.len()
        );
        assert!(roster.iter().any(|(key, _)| *key == Key::J));
        assert!(!roster.iter().any(|(key, _)| *key == Key::Pause));
    }

    #[test]
    fn canonical_layout_is_unique_in_the_ksx_key_vocabulary() {
        let keys = canonical_four_player_edits()
            .into_iter()
            .filter_map(|edit| match edit {
                TerminalEdit::Normal {
                    usage: Some(usage), ..
                } => key_for_usage(usage),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(keys.len(), IPAC4_TERMINAL_COUNT);
    }

    #[test]
    fn custom_duplicate_keys_need_explicit_fan_in() {
        let mut spec = PanelProgramSpec {
            layout: "custom".to_owned(),
            edits: vec![
                PanelTerminalEdit {
                    terminal_id: "1sw1".to_owned(),
                    normal_key: Some("J".to_owned()),
                    ..Default::default()
                },
                PanelTerminalEdit {
                    terminal_id: "2sw1".to_owned(),
                    normal_key: Some("J".to_owned()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert!(terminal_edits(&spec).is_err());
        for edit in &mut spec.edits {
            edit.allow_shared_key = true;
        }
        assert!(terminal_edits(&spec).is_ok());
    }

    #[test]
    fn custom_fan_in_checks_the_complete_desired_chart() {
        let j = usage_for_key_name("J").unwrap().unwrap();
        let baseline = plan_program(&image(), &[TerminalEdit::normal("2sw1", Some(j))])
            .unwrap()
            .desired;
        let mut spec = PanelProgramSpec {
            layout: "custom".to_owned(),
            edits: vec![PanelTerminalEdit {
                terminal_id: "1sw1".to_owned(),
                normal_key: Some("J".to_owned()),
                allow_shared_key: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let edits = terminal_edits(&spec).unwrap();
        let plan = plan_program(&baseline, &edits).unwrap();
        assert!(validate_complete_desired_keys(&spec, &baseline, &plan.desired).is_err());

        spec.edits.push(PanelTerminalEdit {
            terminal_id: "2sw1".to_owned(),
            normal_key: Some("J".to_owned()),
            allow_shared_key: true,
            ..Default::default()
        });
        let edits = terminal_edits(&spec).unwrap();
        let plan = plan_program(&baseline, &edits).unwrap();
        assert!(validate_complete_desired_keys(&spec, &baseline, &plan.desired).is_ok());
    }

    /// Catches treating a complete profile's `is_shift=false` as authority to
    /// normalize an opaque vendor shift byte.
    #[test]
    fn custom_false_disables_only_a_known_enabled_shift_role() {
        let mut bytes = qualification_image().bytes().to_vec();
        bytes[IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift)] = 0x41;
        bytes[IPAC4_TERMINALS[1].image_offset(TerminalPlane::Shift)] = 0x7F;
        let baseline = RawPanelImage::new(bytes).unwrap();
        let spec = PanelProgramSpec {
            layout: "custom".to_owned(),
            edits: vec![
                PanelTerminalEdit {
                    terminal_id: IPAC4_TERMINALS[0].id.to_owned(),
                    is_shift: Some(false),
                    ..Default::default()
                },
                PanelTerminalEdit {
                    terminal_id: IPAC4_TERMINALS[1].id.to_owned(),
                    is_shift: Some(false),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let edits = terminal_edits_for_image(&spec, &baseline).unwrap();
        assert_eq!(
            edits,
            vec![TerminalEdit::shift(IPAC4_TERMINALS[0].id, false)]
        );
        let plan = plan_program(&baseline, &edits).unwrap();
        assert_eq!(
            plan.desired.bytes()[IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift)],
            0x01
        );
        assert_eq!(
            plan.desired.bytes()[IPAC4_TERMINALS[1].image_offset(TerminalPlane::Shift)],
            0x7F
        );
    }

    #[test]
    fn chart_view_never_contains_raw_image_or_backup_path() {
        let selected = SelectedPanel {
            board_id: "board".to_owned(),
            name: "I-PAC 4".to_owned(),
            device_path: "secret-device-path".to_owned(),
            input_instance: "USB\\VID_D209&PID_0430&MI_00\\TEST".to_owned(),
            staged_selector_names_input: true,
            identity: BoardIdentity {
                driver: IPAC4_DRIVER.to_owned(),
                vid: 0xD209,
                pid: 0x0430,
                bcd_device: 0x0056,
                serial: None,
                fingerprint: "IPAC4-TEST".to_owned(),
            },
            profile: test_profile(),
        };
        let mut bytes = qualification_image().bytes().to_vec();
        bytes[IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift)] = 0x41;
        bytes[IPAC4_TERMINALS[1].image_offset(TerminalPlane::Shift)] = 0x7F;
        let decoded = RawPanelImage::new(bytes).unwrap();
        let view = chart_view(
            &selected,
            &decoded,
            None,
            None,
            false,
            &PanelQualificationState::Required,
        );
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("secret-device-path"));
        assert!(!json.contains("image.data"));
        assert_eq!(view.terminals.len(), IPAC4_TERMINAL_COUNT);
        assert_eq!(view.terminals[0].shift_state, PanelShiftState::Enabled);
        assert!(view.terminals[0].is_shift);
        assert_eq!(view.terminals[1].shift_state, PanelShiftState::Opaque);
        assert!(!view.terminals[1].is_shift);
        assert_eq!(view.terminals[2].shift_state, PanelShiftState::Disabled);
        assert!(!view.terminals[2].is_shift);
        assert_eq!(
            view.recommended_terminals.len(),
            IPAC4_TERMINAL_COUNT,
            "the chart response must carry a complete backend-owned recommended roster"
        );
        assert_eq!(
            view.recommended_terminals[0].shift_state,
            PanelShiftState::Disabled,
            "the recommended plan disables a baseline shift byte only when it is known enabled"
        );
        assert_eq!(
            view.recommended_terminals[1].shift_state,
            PanelShiftState::Opaque,
            "the recommended plan must preserve opaque baseline shift state"
        );
        assert_eq!(
            view.terminals[0].shift_state,
            PanelShiftState::Enabled,
            "building the preview must not mutate the current semantic chart"
        );
        assert!(view
            .recommended_terminals
            .iter()
            .all(|terminal| terminal.normal.supported
                && terminal.normal.key.is_some()
                && terminal.shifted.supported
                && terminal.shifted.key.is_none()));
        assert_eq!(
            view.recommended_terminals
                .iter()
                .filter_map(|terminal| terminal.normal.key.as_deref())
                .collect::<BTreeSet<_>>()
                .len(),
            IPAC4_TERMINAL_COUNT,
            "the served preview must retain the canonical roster's collision-free key allocation"
        );
        assert!(view
            .key_options
            .iter()
            .find(|option| option.key == "J")
            .is_some_and(|option| option.safe_for_qualification));
        assert!(view
            .key_options
            .iter()
            .find(|option| option.key == "Escape")
            .is_some_and(|option| !option.safe_for_qualification));
    }

    #[test]
    fn first_write_gate_allows_one_safe_sw_normal_key_and_rejects_critical_controls() {
        let baseline = qualification_image();
        let spec = PanelProgramSpec {
            layout: "custom".to_owned(),
            edits: vec![PanelTerminalEdit {
                terminal_id: "1sw8".to_owned(),
                normal_key: Some("J".to_owned()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let plan = plan_program(&baseline, &terminal_edits(&spec).unwrap()).unwrap();
        assert_eq!(
            require_qualification_program(
                &PanelQualificationState::Required,
                &spec,
                &plan,
                &baseline,
            )
            .unwrap(),
            Some("1sw8")
        );
        let review = plan_view(
            &SelectedPanel {
                board_id: "board".to_owned(),
                name: "I-PAC 4".to_owned(),
                device_path: "test-device-path".to_owned(),
                input_instance: "USB\\VID_D209&PID_0430&MI_00\\TEST".to_owned(),
                staged_selector_names_input: true,
                identity: test_identity(),
                profile: test_profile(),
            },
            &plan,
            Vec::new(),
            "Program the reviewed chart",
            true,
        );
        assert!(
            review
                .confirmation
                .contains("exactly one desired byte differs")
                && review.confirmation.contains("complete 256-byte chart")
                && review.confirmation.contains("all 64 HID reports"),
            "the first-write review must disclose the complete retransmission: {}",
            review.confirmation
        );

        let critical = PanelProgramSpec {
            edits: vec![PanelTerminalEdit {
                terminal_id: "1start".to_owned(),
                normal_key: Some("K".to_owned()),
                ..Default::default()
            }],
            ..spec.clone()
        };
        let critical_plan = plan_program(&baseline, &terminal_edits(&critical).unwrap()).unwrap();
        assert!(require_qualification_program(
            &PanelQualificationState::Required,
            &critical,
            &critical_plan,
            &baseline,
        )
        .is_err());

        let command_key = PanelProgramSpec {
            edits: vec![PanelTerminalEdit {
                terminal_id: "1sw8".to_owned(),
                normal_key: Some("Escape".to_owned()),
                ..Default::default()
            }],
            ..spec.clone()
        };
        let command_key_plan =
            plan_program(&baseline, &terminal_edits(&command_key).unwrap()).unwrap();
        assert!(
            require_qualification_program(
                &PanelQualificationState::Required,
                &command_key,
                &command_key_plan,
                &baseline,
            )
            .is_err(),
            "an ordinary SW terminal must not make a command key safe for the first write"
        );

        let canonical = PanelProgramSpec {
            layout: "canonical-four-player".to_owned(),
            edits: Vec::new(),
            ..Default::default()
        };
        let canonical_plan = plan_program(&baseline, &terminal_edits(&canonical).unwrap()).unwrap();
        assert!(!qualification_program_blockers(
            &PanelQualificationState::Required,
            &canonical,
            &canonical_plan,
            &baseline,
        )
        .is_empty());
    }

    #[test]
    fn qualification_requires_the_exact_validation_backup_before_unlocking() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(&dir.0);
        let qualification = PanelQualificationStore::new(&store, &identity);
        let baseline = qualification_image();
        let validation = plan_program(
            &baseline,
            &[TerminalEdit::normal(
                "1sw8",
                Some(usage_for_key_name("J").unwrap().unwrap()),
            )],
        )
        .unwrap();
        let backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        assert!(
            require_qualification_restore(&PanelQualificationState::Required, &backup.id,).is_err()
        );
        let pending = qualification
            .record_validation(
                &identity,
                "1sw8",
                baseline.sha256(),
                &validation.desired_sha256,
                &backup,
                true,
                test_stamp(),
            )
            .unwrap();
        let loaded = qualification.state(&mut store, &identity).unwrap();
        assert!(matches!(
            loaded,
            PanelQualificationState::ValidationWritten(_)
        ));

        let other = store
            .save_immutable(
                &identity,
                &validation.desired,
                Timestamp {
                    second: 1,
                    ..test_stamp()
                },
                BackupReason::Manual,
            )
            .unwrap();
        assert!(require_qualification_restore(&loaded, &other.id).is_err());
        assert!(require_qualification_restore(&loaded, &backup.id)
            .unwrap()
            .is_some());

        assert!(qualification
            .complete(&identity, &pending, baseline.sha256(), test_stamp())
            .unwrap());
        assert!(matches!(
            qualification.state(&mut store, &identity).unwrap(),
            PanelQualificationState::Qualified
        ));
        assert!(!qualification.pending_path().exists());
        assert!(qualification.verified_path().is_file());
    }

    #[test]
    fn interrupted_validation_restore_returns_to_required_without_qualifying() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(&dir.0);
        let qualification = PanelQualificationStore::new(&store, &identity);
        let baseline = qualification_image();
        let validation = plan_program(
            &baseline,
            &[TerminalEdit::normal(
                "1sw8",
                Some(usage_for_key_name("J").unwrap().unwrap()),
            )],
        )
        .unwrap();
        let backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        let pending = qualification
            .record_validation(
                &identity,
                "1sw8",
                baseline.sha256(),
                &validation.desired_sha256,
                &backup,
                false,
                test_stamp(),
            )
            .unwrap();
        let recovery = qualification.state(&mut store, &identity).unwrap();
        assert_eq!(recovery.api_state(), "validation-recovery");
        assert!(require_qualification_restore(&recovery, &backup.id)
            .unwrap()
            .is_some());

        assert!(
            !qualification
                .complete(&identity, &pending, baseline.sha256(), test_stamp())
                .unwrap(),
            "an unverified test write cannot create writer qualification"
        );
        assert!(matches!(
            qualification.state(&mut store, &identity).unwrap(),
            PanelQualificationState::Required
        ));
        assert!(!qualification.pending_path().exists());
        assert!(!qualification.verified_path().exists());
    }

    #[test]
    fn duplicate_ultimarc_serials_on_different_ports_never_share_a_fingerprint() {
        let first = fingerprint(
            "parent-4",
            "bus:1;ports:1.4",
            0xD209,
            0x0430,
            0x0056,
            Some("4"),
        );
        let second = fingerprint(
            "parent-4",
            "bus:1;ports:1.5",
            0xD209,
            0x0430,
            0x0056,
            Some("4"),
        );
        assert_ne!(first, second);
    }

    #[test]
    fn durable_journal_blocks_program_replacement_and_restore_resolves_its_chain() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(&dir.0);
        let journal = PanelTransactionJournal::new(&store, &identity);
        let baseline = image();
        let first_backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        let desired = "B".repeat(64);
        let pending = journal
            .begin(
                &identity,
                "program",
                baseline.sha256(),
                &desired,
                &first_backup,
                test_stamp(),
                None,
                Some("1sw8"),
            )
            .unwrap();
        assert_eq!(
            pending.current.qualification_terminal.as_deref(),
            Some("1sw8")
        );
        assert!(journal.pending_path().is_file());
        assert!(journal
            .begin(
                &identity,
                "program",
                baseline.sha256(),
                &desired,
                &first_backup,
                test_stamp(),
                Some(pending.clone()),
                None,
            )
            .is_err());

        let loaded = journal
            .load_pending(&mut store, &identity)
            .unwrap()
            .unwrap();
        let restore_backup = store
            .save_immutable(
                &identity,
                &baseline,
                Timestamp {
                    second: 1,
                    ..test_stamp()
                },
                BackupReason::BeforeRestore,
            )
            .unwrap();
        let restored = journal
            .begin(
                &identity,
                "restore",
                baseline.sha256(),
                &"C".repeat(64),
                &restore_backup,
                Timestamp {
                    second: 1,
                    ..test_stamp()
                },
                Some(loaded),
                None,
            )
            .unwrap();
        assert_eq!(restored.prior_unresolved.len(), 1);
        journal
            .resolve(&restored, "verified", &"C".repeat(64))
            .unwrap();
        assert!(!journal.pending_path().exists());
        assert!(std::fs::read_dir(store.board_dir(&identity))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .ends_with(TRANSACTION_RECEIPT_EXTENSION)));
    }

    /// Broken version caught: the durable journal gated only the next encoder
    /// mutation. Once a killed process released the lease, Play could start
    /// against an encoder whose persistent chart had an unknown outcome.
    #[test]
    fn play_start_guard_blocks_an_unresolved_journal_until_verified_resolution() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(dir.0.join(BACKUP_DIR));
        let journal = PanelTransactionJournal::new(&store, &identity);
        let baseline = image();
        let backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        let pending = journal
            .begin(
                &identity,
                "program",
                baseline.sha256(),
                &"B".repeat(64),
                &backup,
                test_stamp(),
                None,
                Some("1sw8"),
            )
            .unwrap();

        let refusal = acquire_play_start_guard(&dir.0)
            .err()
            .expect("an unresolved durable journal must block Play/start");
        assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
        assert!(refusal.message.contains(&pending.current.transaction_id));
        let remedy = refusal.remedy.expect("recovery owes an actionable route");
        assert!(remedy.contains("ksx panel chart --backup"), "{remedy}");
        assert!(
            remedy.contains(&pending.current.safety_backup_id),
            "{remedy}"
        );

        journal
            .resolve(&pending, "verified", &"B".repeat(64))
            .unwrap();
        let lease = acquire_play_start_guard(&dir.0)
            .expect("a verified journal resolution unlocks Play/start");
        drop(lease);
    }

    /// Broken version caught: a malformed marker was treated like no marker
    /// because only a successfully decoded transaction was considered pending.
    #[test]
    fn play_start_guard_fails_closed_on_an_unreadable_pending_marker() {
        let dir = JournalTestDir::new();
        let pending_dir = dir
            .0
            .join(BACKUP_DIR)
            .join(IPAC4_DRIVER)
            .join("IPAC4-CORRUPT-JOURNAL");
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(
            pending_dir.join(PENDING_TRANSACTION_FILE),
            b"not valid transaction JSON",
        )
        .unwrap();

        let refusal = acquire_play_start_guard(&dir.0)
            .err()
            .expect("an unreadable durable marker must block Play/start");
        assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
        assert!(refusal.message.contains("cannot be interpreted"));
        assert!(refusal
            .remedy
            .as_deref()
            .is_some_and(|remedy| remedy.contains("ksx panel chart --backup")));
    }

    /// Broken version caught: every non-directory entry was silently skipped,
    /// so replacing a driver or board directory with a file made a pending
    /// journal disappear from Play's decision.
    #[test]
    fn play_start_guard_rejects_wrong_kind_objects_at_every_directory_level() {
        let root_file = JournalTestDir::new();
        std::fs::write(root_file.0.join(BACKUP_DIR), b"not a directory").unwrap();
        let root_refusal = require_no_pending_panel_transactions(&root_file.0).unwrap_err();
        assert!(root_refusal.message.contains("panel backup root"));

        let driver_file = JournalTestDir::new();
        let backup_root = driver_file.0.join(BACKUP_DIR);
        std::fs::create_dir_all(&backup_root).unwrap();
        std::fs::write(backup_root.join(IPAC4_DRIVER), b"not a directory").unwrap();
        let driver_refusal = require_no_pending_panel_transactions(&driver_file.0).unwrap_err();
        assert!(driver_refusal.message.contains("panel driver level"));

        let board_file = JournalTestDir::new();
        let driver_root = board_file.0.join(BACKUP_DIR).join(IPAC4_DRIVER);
        std::fs::create_dir_all(&driver_root).unwrap();
        std::fs::write(driver_root.join("IPAC4-WRONG-KIND"), b"not a directory").unwrap();
        let board_refusal = require_no_pending_panel_transactions(&board_file.0).unwrap_err();
        assert!(board_refusal.message.contains("panel board level"));

        for refusal in [root_refusal, driver_refusal, board_refusal] {
            assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
            assert!(refusal.message.contains("ordinary non-reparse directory"));
            assert!(refusal
                .remedy
                .as_deref()
                .is_some_and(|remedy| remedy.contains("ksx panel chart --backup")));
        }
    }

    /// Broken version caught: `read_dir(...): NotFound` treated a dangling
    /// symlink/junction backup root exactly like a root that never existed.
    /// `symlink_metadata` must classify the link itself before following it.
    #[test]
    fn play_start_guard_distinguishes_absent_root_from_directory_reparse_root() {
        let absent = JournalTestDir::new();
        assert!(require_no_pending_panel_transactions(&absent.0).is_ok());

        let linked = JournalTestDir::new();
        let target = linked.0.join("recovery-target");
        std::fs::create_dir_all(&target).unwrap();
        let backup_root = linked.0.join(BACKUP_DIR);
        create_test_directory_link(&backup_root, &target);

        let refusal = require_no_pending_panel_transactions(&linked.0).unwrap_err();
        assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
        assert!(refusal.message.contains("symlink, junction"));
    }

    /// Broken version caught: a junction at either nested level was accepted
    /// as a directory and followed into a substitute recovery store.
    #[test]
    fn play_start_guard_rejects_reparse_driver_and_board_levels() {
        for level in ["driver", "board"] {
            let dir = JournalTestDir::new();
            let backup_root = dir.0.join(BACKUP_DIR);
            let target = dir.0.join(format!("{level}-target"));
            std::fs::create_dir_all(&target).unwrap();
            if level == "driver" {
                std::fs::create_dir_all(&backup_root).unwrap();
                create_test_directory_link(&backup_root.join(IPAC4_DRIVER), &target);
            } else {
                let driver_root = backup_root.join(IPAC4_DRIVER);
                std::fs::create_dir_all(&driver_root).unwrap();
                create_test_directory_link(&driver_root.join("IPAC4-REPARSE"), &target);
            }

            let refusal = require_no_pending_panel_transactions(&dir.0).unwrap_err();
            assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
            assert!(refusal.message.contains("ordinary non-reparse directory"));
            assert!(refusal.message.contains(level), "{refusal}");
        }
    }

    /// Broken version caught: A -> B failed write -> A let a point-in-time
    /// comparison pass while the unresolved marker remained under B. The
    /// machine authority must make the B writer journal A in the first place,
    /// so the later A Play scan necessarily sees it.
    #[test]
    fn machine_recovery_root_survives_portable_a_b_a_and_keeps_the_marker_visible() {
        let dir = JournalTestDir::new();
        let authority = PanelRecoveryRootAuthority::default();
        let installed = dir.0.join("installed-machine-root");
        let recovery_a = authority.resolve(|| Some(installed.clone())).unwrap();

        let rediscovery_called = std::cell::Cell::new(false);
        let recovery_during_b = authority
            .resolve(|| {
                rediscovery_called.set(true);
                Some(dir.0.join("portable-b-must-not-own-recovery"))
            })
            .unwrap();
        assert!(
            !rediscovery_called.get(),
            "the process root must stay pinned"
        );
        assert_eq!(recovery_during_b, recovery_a);

        let pending_dir = recovery_during_b
            .join(IPAC4_DRIVER)
            .join("IPAC4-A-B-A-RECOVERY");
        std::fs::create_dir_all(&pending_dir).unwrap();
        std::fs::write(
            pending_dir.join(PENDING_TRANSACTION_FILE),
            b"failed B-time write left this durable marker",
        )
        .unwrap();

        let recovery_back_at_a = authority
            .resolve(|| Some(installed.join("portable-a-again")))
            .unwrap();
        assert_eq!(recovery_back_at_a, recovery_a);
        let refusal = require_no_pending_panel_transactions_at(&recovery_back_at_a).unwrap_err();
        assert_eq!(refusal.code, ksx_api::codes::RECOVERY_REQUIRED);
        assert!(refusal
            .message
            .contains("durable panel transaction journal"));
    }

    #[cfg(windows)]
    fn create_test_directory_link(link: &Path, target: &Path) {
        let output = ksx_platform::process::no_window(
            std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target),
        )
        .output()
        .expect("launch cmd.exe to create a disposable test junction");
        assert!(
            output.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn create_test_directory_link(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).expect("create a disposable test symlink");
    }

    /// A killed output worker cannot prove whether hidclass delivered packet
    /// zero before it wedged. The pre-packet journal is therefore recovery
    /// authority and must remain pending; only verified readback or an exact
    /// supervised restore may resolve it. This test is filesystem + synthetic
    /// error only and never opens a HID collection.
    #[test]
    fn output_worker_timeout_keeps_the_durable_transaction_unresolved() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(&dir.0);
        let journal = PanelTransactionJournal::new(&store, &identity);
        let baseline = image();
        let backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        let pending = journal
            .begin(
                &identity,
                "program",
                baseline.sha256(),
                &"B".repeat(64),
                &backup,
                test_stamp(),
                None,
                Some("1sw8"),
            )
            .unwrap();

        let timeout = PanelProgrammingError::Transport {
            operation: IoOperation::Write,
            packet: 0,
            source: report_transport_error(HidReportError::OutputWorkerTimedOut {
                timeout_ms: 2_000,
            }),
        };
        let failure = transaction_failure(backup.id.clone(), TransactionPhase::Program, timeout);
        assert!(matches!(
            failure,
            PanelProgrammingError::TransactionFailed { .. }
        ));
        assert!(journal.pending_path().is_file());
        assert_eq!(
            journal
                .load_pending(&mut store, &identity)
                .unwrap()
                .unwrap()
                .current
                .transaction_id,
            pending.current.transaction_id
        );
    }

    #[test]
    fn journal_rejects_a_tampered_transaction_id_before_resolving_a_path() {
        let dir = JournalTestDir::new();
        let identity = test_identity();
        let mut store = BackupStore::new(&dir.0);
        let journal = PanelTransactionJournal::new(&store, &identity);
        let baseline = image();
        let backup = store
            .save_immutable(
                &identity,
                &baseline,
                test_stamp(),
                BackupReason::BeforeProgram,
            )
            .unwrap();
        journal
            .begin(
                &identity,
                "program",
                baseline.sha256(),
                &"D".repeat(64),
                &backup,
                test_stamp(),
                None,
                None,
            )
            .unwrap();
        let path = journal.pending_path();
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        *value.pointer_mut("/current/transaction_id").unwrap() = serde_json::json!("..\\escape");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();

        assert!(matches!(
            journal.load_pending(&mut store, &identity),
            Err(BackupError::InvalidDocument(message)) if message.contains("safe filename")
        ));
        assert!(!dir.0.join("escape.ksxpanel-transaction.json").exists());
    }
}
