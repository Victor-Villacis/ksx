//! `ksx winusb {status,claim,release}` — the WinUSB rebind lifecycle.
//!
//! The decision surface (survey, refusals, INF shape, command consequences)
//! lives in `ksx_platform::winusb`, where it is pure and CI-tested against a
//! synthetic copy of the device tree. This file is the command around it:
//! argument parsing, the dry-run/`--yes` gate, rendering, and exit codes.
//!
//! # Why every verb is a dry run by default
//!
//! `install-drivers` runs a signed installer; the worst case is a driver you did
//! not want. `winusb claim` takes a keyboard *out of the keyboard stack*. The
//! worst case is a panel that no longer types and a user who cannot type the
//! command to undo it. So the default of every mutating verb is to print the
//! consequences and stop. `--yes` never executes those displayed commands
//! directly: it invokes the installed, elevated, journaled helper, which
//! prepares and signs the package in the protected transaction store.
//!
//! # Exit codes
//!
//! | 0 | reported, or the operation succeeded |
//! | 1 | unexpected error |
//! | 2 | refused: unknown/ambiguous device, not a keyboard, already claimed, elevation needed, **or the last keyboard on the machine** |
//! | 3 | pnputil ran and failed |

use ksx_platform::winusb::{self, ClaimPlan, Refusal, ReleasePlan, Survey};

use ksx_api::{Refusal as ApiRefusal, WinusbMutationView, WinusbPrepareSpec, WinusbReleaseSpec};

/// Fixed helper operation. No path, package, certificate or command argument
/// can cross this boundary from a surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelperMutation {
    Prepare,
    Release,
    /// Give back every keyboard ksx claimed, using only what the machine
    /// reports. Takes no device, because the case it exists for is the one
    /// where nothing on disk can say which devices those were.
    ReleaseAll,
    /// Bring the journal and the machine back into agreement.
    Repair,
    /// Remove the signing certificates nothing depends on. Names no device
    /// for the same reason `ReleaseAll` does not: this is about the machine's
    /// trust stores, which no single keyboard owns.
    SweepCertificates,
}

pub trait HelperElevator: Send + Sync {
    fn run(&self, action: HelperMutation, instance_id: &str) -> Result<u32, ApiRefusal>;
}

impl HelperMutation {
    /// The helper verb this mutation invokes. One spelling, used for the
    /// argument and for the log line that reports its exit code.
    pub const fn verb(self) -> &'static str {
        match self {
            HelperMutation::Prepare => "prepare-exact",
            HelperMutation::Release => "release-exact",
            HelperMutation::ReleaseAll => "release-all",
            HelperMutation::Repair => "repair",
            HelperMutation::SweepCertificates => "sweep-certificates",
        }
    }
}

fn helper_arguments(action: HelperMutation, instance_id: &str) -> Vec<String> {
    // `release-all` names no device, and must not: the machine is the only
    // source of truth left in the situation it recovers from.
    if matches!(
        action,
        HelperMutation::ReleaseAll | HelperMutation::Repair | HelperMutation::SweepCertificates
    ) {
        return vec![action.verb().to_owned()];
    }
    let mut args = vec![action.verb().to_owned(), instance_id.to_owned()];
    match action {
        HelperMutation::Prepare => args.extend([
            "--confirm-spare-keyboard".to_owned(),
            "--confirm-rebind".to_owned(),
            "--confirm-machine-certificate".to_owned(),
        ]),
        HelperMutation::Release => args.push("--confirm-release".to_owned()),
        HelperMutation::ReleaseAll | HelperMutation::Repair | HelperMutation::SweepCertificates => {
            unreachable!("handled above")
        }
    }
    args
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObservedBinding {
    HidUsb,
    WinUsb,
    Missing,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedMutation {
    pub instance_id: String,
    pub hardware_id: String,
    pub binding: ObservedBinding,
    pub ownership: Option<ksx_platform::winusb::transaction::OwnershipState>,
}

pub trait MutationObserver: Send + Sync {
    fn preflight(
        &self,
        action: HelperMutation,
        expected_selector: &str,
        instance_id: &str,
    ) -> Result<ObservedMutation, ApiRefusal>;
    fn observe(&self, instance_id: &str) -> Result<ObservedMutation, ApiRefusal>;
}

pub struct SystemHelperElevator;

/// What the helper's exit codes mean, so a log line is readable without going
/// to `crates/ksx-winusb-helper/src/main.rs` to look them up.
fn helper_exit_meaning(code: u32) -> &'static str {
    match code {
        0 => "success",
        2 => "refused: a precondition the helper will not override",
        3 => "internal: the helper could not complete the transaction",
        4 => "recovery-required: durable state needs inspection before retry",
        _ => "unrecognised",
    }
}

impl HelperElevator for SystemHelperElevator {
    fn run(&self, action: HelperMutation, instance_id: &str) -> Result<u32, ApiRefusal> {
        let helper = ksx_platform::process::protected_winusb_helper().map_err(|err| {
            ApiRefusal::with_remedy(
                "winusb-helper-untrusted",
                format!("the installed elevated helper could not be trusted: {err}"),
                "install or repair the machine-wide KSX version; portable and developer copies cannot rebind drivers",
            )
        })?;
        let args = helper_arguments(action, instance_id);
        // The helper is launched through ShellExecuteEx for the UAC prompt,
        // which cannot redirect its stdout — so the JSON it prints, including
        // the one sentence naming the refusal, is discarded by Windows before
        // anything here can read it. The exit code is all that survives, and it
        // used to be discarded too: a user saw "Windows could not prepare this
        // keyboard" and the log file held not one line about it, which cost
        // three round trips and a hand-written diagnostic script to recover.
        //
        // At minimum, record what crossed the boundary.
        tracing::info!(
            operation = action.verb(),
            instance = instance_id,
            "running the elevated WinUSB helper"
        );
        ksx_platform::process::run_elevated_and_wait(helper, &args)
            .map(|exit| {
                if exit.code == 0 {
                    tracing::info!(
                        operation = action.verb(),
                        instance = instance_id,
                        "the elevated WinUSB helper succeeded"
                    );
                } else {
                    tracing::warn!(
                        operation = action.verb(),
                        instance = instance_id,
                        exit = exit.code,
                        meaning = helper_exit_meaning(exit.code),
                        "the elevated WinUSB helper refused. Its own message goes to a stdout Windows does not hand back through the UAC prompt; run the same verb from an elevated prompt with output redirected to read it"
                    );
                }
                exit.code
            })
            .map_err(|err| match err {
                ksx_platform::process::ElevationError::Cancelled => ApiRefusal::with_remedy(
                    "elevation-cancelled",
                    "the Windows administrator prompt was cancelled",
                    "nothing was assumed; approve the prompt when you are ready",
                ),
                ksx_platform::process::ElevationError::Timeout => ApiRefusal::with_remedy(
                    "winusb-helper-timeout",
                    "the elevated driver helper did not finish within five minutes; it was left running",
                    "do not launch it again; wait, then run `ksx winusb status` to read the durable receipt",
                ),
                other @ (ksx_platform::process::ElevationError::Untracked(_)
                | ksx_platform::process::ElevationError::Wait(_)) => ApiRefusal::with_remedy(
                    "winusb-helper-state-unknown",
                    other.to_string(),
                    "do not launch it again; wait, then run `ksx winusb status` to re-survey the device and protected recovery receipt",
                ),
                other => ApiRefusal::with_remedy(
                    "winusb-helper-failed",
                    other.to_string(),
                    "repair the KSX installation and try again",
                ),
            })
    }
}

pub struct SystemMutationObserver;

impl SystemMutationObserver {
    fn live(instance_id: &str) -> Result<ObservedMutation, ApiRefusal> {
        let survey = winusb::survey();
        let candidate = survey.resolve_exact_interface(instance_id).ok();
        let binding = match candidate.map(|candidate| candidate.state) {
            Some(winusb::ClaimState::Claimed) => ObservedBinding::WinUsb,
            Some(winusb::ClaimState::Claimable) => ObservedBinding::HidUsb,
            Some(_) => ObservedBinding::Other,
            None => ObservedBinding::Missing,
        };
        let hardware_id = candidate
            .and_then(|candidate| candidate.interface.usb_hardware_id())
            .unwrap_or_default();
        let ownership = winusb::transaction::ownership_state(instance_id).map_err(|err| {
            ApiRefusal::with_remedy(
                "winusb-state-unavailable",
                err.to_string(),
                "do not repeat the operation until KSX can read its protected recovery record",
            )
        })?;
        Ok(ObservedMutation {
            instance_id: instance_id.to_uppercase(),
            hardware_id,
            binding,
            ownership,
        })
    }

    fn selector_targets(expected: &str, instance_id: &str) -> Result<(), ApiRefusal> {
        let candidates = ksx_capture::usb_candidates().map_err(|err| {
            ApiRefusal::with_remedy(
                "usb-enumeration-unavailable",
                err.to_string(),
                "keep the keyboard connected and try again",
            )
        })?;
        let facts: Vec<_> = candidates
            .iter()
            .map(ksx_capture::UsbCandidate::facts)
            .collect();
        selector_targets_against(expected, instance_id, &facts)
    }
}

fn selector_targets_against(
    expected: &str,
    instance_id: &str,
    facts: &[ksx_core::DeviceFacts],
) -> Result<(), ApiRefusal> {
    use ksx_core::Match;
    let selector = ksx_core::DeviceSelector::parse(expected.trim())
        .map_err(|err| ApiRefusal::new(ksx_api::codes::BAD_REQUEST, err.to_string()))?;
    match selector.match_against(facts) {
        Match::One(found) if found.id.as_str().eq_ignore_ascii_case(instance_id) => Ok(()),
        Match::One(found) => Err(ApiRefusal::new(
            "staged-device-changed",
            format!(
                "the expected selector now resolves to {}, not {}",
                found.id, instance_id
            ),
        )),
        Match::None => Err(ApiRefusal::new(
            "staged-device-missing",
            "the expected keyboard is not connected now",
        )),
        Match::Ambiguous(found) => Err(ApiRefusal::new(
            "staged-device-ambiguous",
            format!("the expected selector matches {} keyboards", found.len()),
        )),
    }
}

/// May this action run against a device in this binding?
///
/// Three answers, not two. "It is already in the state you asked for" is not
/// the same refusal as "it is in some other state", and collapsing them was
/// defect 3 of the 2026-08-11 hardware session: preparing a keyboard twice
/// reported *"Windows could not prepare this keyboard"* — an error about the
/// machine, for the most ordinary thing a user can do, on a machine where
/// nothing was wrong. It gets its own code so a surface can name the state and
/// offer the action that actually follows from it.
///
/// Pure, and separate from the observer, so the three answers are pinned in CI
/// rather than only on a desk with an I-PAC on it.
fn binding_gate(
    action: HelperMutation,
    instance_id: &str,
    observed: ObservedBinding,
) -> Result<(), ApiRefusal> {
    let (needs, already) = match action {
        HelperMutation::Prepare => (ObservedBinding::HidUsb, ObservedBinding::WinUsb),
        HelperMutation::Release => (ObservedBinding::WinUsb, ObservedBinding::HidUsb),
        // Store-free release names no device, so no per-device gate applies to
        // it. Reaching here means a caller asked whether one binding is right
        // for an action that is about all of them.
        HelperMutation::ReleaseAll | HelperMutation::Repair | HelperMutation::SweepCertificates => {
            return Err(ApiRefusal::new(
                "winusb-live-state-changed",
                "this action is about the whole machine, not one device",
            ))
        }
    };
    if observed == needs {
        return Ok(());
    }
    if observed == already {
        return Err(match action {
            HelperMutation::ReleaseAll
            | HelperMutation::Repair
            | HelperMutation::SweepCertificates => ApiRefusal::new(
                "winusb-live-state-changed",
                "this action is about the whole machine, not one device",
            ),
            HelperMutation::Prepare => ApiRefusal::with_remedy(
                "winusb-already-prepared",
                format!("{instance_id} is already prepared and bound to winusb.sys"),
                "nothing to do; use Release to give this keyboard back to Windows",
            ),
            HelperMutation::Release => ApiRefusal::with_remedy(
                "winusb-already-released",
                format!("{instance_id} is already a normal keyboard on hidusb.sys"),
                "nothing to do; use Prepare if you want ksx to take this keyboard",
            ),
        });
    }
    Err(ApiRefusal::new(
        "winusb-live-state-changed",
        format!("{instance_id} is {observed:?}, not the state required for {action:?}"),
    ))
}

impl MutationObserver for SystemMutationObserver {
    fn preflight(
        &self,
        action: HelperMutation,
        expected_selector: &str,
        instance_id: &str,
    ) -> Result<ObservedMutation, ApiRefusal> {
        Self::selector_targets(expected_selector, instance_id)?;
        let observed = Self::live(instance_id)?;
        binding_gate(action, instance_id, observed.binding)?;
        Ok(observed)
    }

    fn observe(&self, instance_id: &str) -> Result<ObservedMutation, ApiRefusal> {
        Self::live(instance_id)
    }
}

/// What the machine looks like after a store-free release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseAllView {
    pub helper_exit: u32,
    /// USB interfaces still bound to winusb.sys, read fresh afterwards.
    pub still_bound: Vec<String>,
    pub message: String,
}

/// Run the elevated store-free release and then say what is TRUE, rather than
/// what the helper claimed.
///
/// The helper is launched through `ShellExecuteEx` for its UAC prompt, which
/// cannot redirect stdout, so its JSON never comes back. Every other mutating
/// verb here answers that the same way and so does this one: ignore the words,
/// re-survey the machine, and report the state.
pub fn release_all_machine_with(
    elevator: &dyn HelperElevator,
    survey: &dyn Fn() -> Result<Vec<String>, ApiRefusal>,
) -> Result<ReleaseAllView, ApiRefusal> {
    let exit = elevator.run(HelperMutation::ReleaseAll, "")?;
    let still_bound = survey()?;
    let message = if still_bound.is_empty() {
        "no USB interface on this machine is bound to winusb.sys".to_owned()
    } else {
        format!(
            "{} USB interface(s) are still bound to winusb.sys; ksx removed every package it \
             published, so these belong to something else",
            still_bound.len()
        )
    };
    Ok(ReleaseAllView {
        helper_exit: exit,
        still_bound,
        message,
    })
}

/// What a sweep left behind, verified by RE-READING the stores rather than by
/// believing the helper's exit code — the same discipline
/// [`release_all_machine_with`] applies for the same reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepCertificatesView {
    pub helper_exit: u32,
    pub leftover_certificates: usize,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CertificateSweepPostState {
    pub leftover_certificates: usize,
    pub blocked: Vec<String>,
}

const SWEEP_REFUSED: &str = "winusb-certificate-sweep-refused";
const SWEEP_FAILED: &str = "winusb-certificate-sweep-failed";
const SWEEP_RECOVERY_REQUIRED: &str = "winusb-certificate-sweep-recovery-required";
const SWEEP_UNVERIFIED: &str = "winusb-certificate-sweep-unverified";
const SWEEP_INCOMPLETE: &str = "winusb-certificate-sweep-incomplete";

fn helper_sweep_refusal(exit: u32) -> ApiRefusal {
    match exit {
        2 => ApiRefusal::with_remedy(
            SWEEP_REFUSED,
            "Windows refused the certificate cleanup before anything was removed",
            "reopen Devices or run `ksx winusb sweep-certificates` to read the current classification",
        ),
        4 => ApiRefusal::with_remedy(
            SWEEP_RECOVERY_REQUIRED,
            "the certificate cleanup stopped in a state that requires recovery",
            "do not repeat it blindly; run `ksx doctor` and inspect the WinUSB recovery report",
        ),
        _ => ApiRefusal::with_remedy(
            SWEEP_FAILED,
            format!("the elevated certificate cleanup failed with helper exit {exit}"),
            "leave the certificates in place and run `ksx doctor` before retrying",
        ),
    }
}

pub fn sweep_certificates_machine_with(
    elevator: &dyn HelperElevator,
    report: &dyn Fn() -> Result<CertificateSweepPostState, ApiRefusal>,
) -> Result<SweepCertificatesView, ApiRefusal> {
    let exit = elevator.run(HelperMutation::SweepCertificates, "")?;
    if exit != 0 {
        return Err(helper_sweep_refusal(exit));
    }
    let after = report().map_err(|refusal| {
        ApiRefusal::with_remedy(
            SWEEP_UNVERIFIED,
            format!(
                "the helper finished, but the machine certificate state could not be verified: {}",
                refusal.message
            ),
            "do not repeat the cleanup; run `ksx doctor` and inspect the current WinUSB state",
        )
    })?;
    if !after.blocked.is_empty() {
        return Err(ApiRefusal::with_remedy(
            SWEEP_UNVERIFIED,
            format!(
                "the helper finished, but the fresh certificate classification is blocked: {}",
                after.blocked.join("; ")
            ),
            "do not repeat the cleanup; run `ksx doctor` and inspect the installed WinUSB packages",
        ));
    }
    if after.leftover_certificates != 0 {
        return Err(ApiRefusal::with_remedy(
            SWEEP_INCOMPLETE,
            format!(
                "{} leftover signing certificate(s) remain after the helper finished",
                after.leftover_certificates
            ),
            "do not remove certificates manually; run `ksx doctor` and inspect the current classification",
        ));
    }
    Ok(SweepCertificatesView {
        helper_exit: exit,
        leftover_certificates: 0,
        message: "no leftover signing certificates remain on this machine".to_owned(),
    })
}

fn sweep_block_message(block: &ksx_platform::winusb::SweepBlock) -> String {
    match block {
        ksx_platform::winusb::SweepBlock::UnattributedPackage { published_name } => {
            format!("installed package {published_name} has no attributable KSX signer")
        }
        ksx_platform::winusb::SweepBlock::MismatchedCertificateIdentity { subject } => {
            format!("{subject} names different certificate identities across the machine stores")
        }
    }
}

/// Fresh, authoritative state used to judge the elevated helper. A successful
/// helper exit is necessary but never sufficient.
pub fn certificate_sweep_state_now() -> Result<CertificateSweepPostState, ApiRefusal> {
    let (rows, blocked) =
        ksx_platform::winusb::transaction::certificate_report().map_err(|err| {
            ApiRefusal::with_remedy(
                "winusb-certificate-read-failed",
                format!("the machine certificate state could not be read: {err}"),
                "leave the certificates in place and run `ksx doctor` before retrying",
            )
        })?;
    Ok(CertificateSweepPostState {
        leftover_certificates: rows
            .iter()
            .filter(|row| !row.in_use)
            .map(|row| row.stores.len())
            .sum(),
        blocked: blocked.iter().map(sweep_block_message).collect(),
    })
}

pub fn sweep_certificates_machine() -> Result<SweepCertificatesView, ApiRefusal> {
    sweep_certificates_machine_with(&SystemHelperElevator, &certificate_sweep_state_now)
}

/// Interfaces currently bound to winusb.sys, as a fresh read of the machine.
pub fn winusb_bound_now() -> Result<Vec<String>, ApiRefusal> {
    let candidates = ksx_capture::usb_candidates().map_err(|err| {
        ApiRefusal::with_remedy(
            "usb-enumeration-unavailable",
            err.to_string(),
            "keep the keyboard connected and try again",
        )
    })?;
    Ok(candidates
        .iter()
        .filter(|c| c.binding.is_winusb())
        .map(|c| c.id.as_str().to_owned())
        .collect())
}

pub fn release_all_machine() -> Result<ReleaseAllView, ApiRefusal> {
    release_all_machine_with(&SystemHelperElevator, &winusb_bound_now)
}

pub fn prepare_machine_with(
    spec: &WinusbPrepareSpec,
    elevator: &dyn HelperElevator,
    observer: &dyn MutationObserver,
) -> Result<WinusbMutationView, ApiRefusal> {
    if !(spec.confirm_spare_keyboard && spec.confirm_rebind && spec.confirm_machine_certificate) {
        return Err(ApiRefusal::with_remedy(
            ksx_api::codes::BAD_REQUEST,
            "all three WinUSB confirmations are required",
            "confirm the spare keyboard, rebind consequence, and machine certificate",
        ));
    }
    let before = observer.preflight(
        HelperMutation::Prepare,
        &spec.expected_selector,
        &spec.instance_id,
    )?;
    let exit = elevator.run(HelperMutation::Prepare, &before.instance_id)?;
    let after = observer.observe(&before.instance_id)?;
    if after.instance_id.eq_ignore_ascii_case(&before.instance_id)
        && after.hardware_id.eq_ignore_ascii_case(&before.hardware_id)
        && after.binding == ObservedBinding::WinUsb
        && after
            .ownership
            .as_ref()
            .is_some_and(|owned| owned.phase == winusb::transaction::Phase::Active)
    {
        return Ok(WinusbMutationView {
            instance_id: after.instance_id,
            hardware_id: after.hardware_id,
            state: "prepared".to_owned(),
            message: "this exact keyboard is prepared and live on WinUSB".to_owned(),
            warning: None,
        });
    }
    if let Some(owned) = after
        .ownership
        .filter(|owned| owned.phase == winusb::transaction::Phase::RecoveryRequired)
    {
        return Ok(WinusbMutationView {
            instance_id: after.instance_id,
            hardware_id: owned.hardware_id,
            state: "recovery-required".to_owned(),
            message: "the WinUSB operation did not reach a safely verified final state".to_owned(),
            warning: owned.recovery_reason,
        });
    }
    Err(ApiRefusal::with_remedy(
        "winusb-prepare-unverified",
        format!(
            "the elevated helper exited {exit}, but a fresh survey did not verify the requested WinUSB binding"
        ),
        "do not retry blindly; run `ksx winusb status` to read the receipt, then `ksx winusb release <device> --force --yes` from an elevated prompt",
    ))
}

pub fn release_machine_with(
    spec: &WinusbReleaseSpec,
    elevator: &dyn HelperElevator,
    observer: &dyn MutationObserver,
) -> Result<WinusbMutationView, ApiRefusal> {
    if !spec.confirm_release {
        return Err(ApiRefusal::new(
            ksx_api::codes::BAD_REQUEST,
            "release confirmation is required",
        ));
    }
    let before = observer.preflight(
        HelperMutation::Release,
        &spec.expected_selector,
        &spec.instance_id,
    )?;
    let exit = elevator.run(HelperMutation::Release, &before.instance_id)?;
    let after = observer.observe(&before.instance_id)?;
    if after.instance_id.eq_ignore_ascii_case(&before.instance_id)
        && after.hardware_id.eq_ignore_ascii_case(&before.hardware_id)
        && after.binding == ObservedBinding::HidUsb
        && after
            .ownership
            .as_ref()
            .is_some_and(|owned| owned.phase == winusb::transaction::Phase::Released)
    {
        return Ok(WinusbMutationView {
            instance_id: after.instance_id,
            hardware_id: after.hardware_id,
            state: "released".to_owned(),
            message: "this exact keyboard is back on the HID keyboard stack".to_owned(),
            warning: None,
        });
    }
    if let Some(owned) = after
        .ownership
        .filter(|owned| owned.phase == winusb::transaction::Phase::RecoveryRequired)
    {
        return Ok(WinusbMutationView {
            instance_id: after.instance_id,
            hardware_id: owned.hardware_id,
            state: "recovery-required".to_owned(),
            message: "release did not reach a safely verified final state".to_owned(),
            warning: owned.recovery_reason,
        });
    }
    Err(ApiRefusal::with_remedy(
        "winusb-release-unverified",
        format!(
            "the elevated helper exited {exit}, but a fresh survey did not verify the HID keyboard binding"
        ),
        "do not rescan or reinstall blindly; run `ksx winusb status` to read the receipt, then `ksx winusb release <device> --force --yes` from an elevated prompt",
    ))
}

pub fn prepare_machine(spec: &WinusbPrepareSpec) -> Result<WinusbMutationView, ApiRefusal> {
    prepare_machine_with(spec, &SystemHelperElevator, &SystemMutationObserver)
}

pub fn release_machine(spec: &WinusbReleaseSpec) -> Result<WinusbMutationView, ApiRefusal> {
    release_machine_with(spec, &SystemHelperElevator, &SystemMutationObserver)
}

/// Refused — nothing was changed. Same value as every other "cannot start".
pub const EXIT_REFUSED: i32 = 2;
/// pnputil ran and returned a failure.
pub const EXIT_APPLY_FAILED: i32 = 3;
/// A durable transaction exists, but its final binding could not be verified.
pub const EXIT_RECOVERY_REQUIRED: i32 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Status,
    Claim {
        device: String,
    },
    Release {
        device: String,
        force: bool,
    },
    /// Every ksx-claimed keyboard, without consulting the journal.
    ReleaseAll,
    /// Reconcile the journal against the machine.
    Repair,
    /// Remove the signing certificates no installed package depends on.
    SweepCertificates,
}

pub struct Options {
    pub action: Action,
    /// Report only. Default for every mutating verb.
    pub dry_run: bool,
    /// Actually run pnputil. Required on top of `!dry_run`.
    pub yes: bool,
    pub json: bool,
}

pub fn run(opts: Options) -> anyhow::Result<()> {
    let survey = winusb::survey();
    match &opts.action {
        Action::Status => status(&survey, opts.json),
        Action::Claim { device } => claim(&survey, device, &opts),
        Action::Release { device, force } => release(&survey, device, *force, &opts),
        Action::ReleaseAll => release_all(&opts),
        Action::Repair => repair(&opts),
        Action::SweepCertificates => sweep_certificates(&opts),
    }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

fn status(survey: &Survey, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&survey.to_json())?);
    } else {
        print!("{}", render_status(survey));
    }
    Ok(())
}

/// Rendered separately from printing so the shape is snapshot-testable.
pub fn render_status(survey: &Survey) -> String {
    use winusb::ClaimState;

    let mut out = String::new();
    out.push_str("USB interfaces ksx can reason about (read-only; nothing was opened)\n\n");
    if survey.candidates.is_empty() {
        out.push_str("  (none found)\n");
    }
    for c in &survey.candidates {
        let driver = c.interface.service.as_deref().unwrap_or("(none)");
        let verdict = match c.state {
            ClaimState::Claimed => "CLAIMED  — ksx can open this; Windows sees no keyboard",
            ClaimState::Claimable => "CLAIMABLE — ksx could claim this",
            ClaimState::NotAKeyboard => "no keys   — not a keyboard interface; ksx leaves it alone",
            ClaimState::ForeignDriver => "foreign   — another vendor's driver owns it",
            // Not "cannot be used". It is a keyboard, ksx captures it today
            // through Interception, and only the CLAIM is impossible — for the
            // transport, permanently. The verdict word has to carry that or
            // this screen becomes the place people learn the wrong lesson.
            ClaimState::InterceptionOnly => {
                "no claim  — Bluetooth: no USB interface to bind, so WinUSB never applies; \
                 Interception captures it as it is"
            }
        };
        out.push_str(&format!(
            "  {}\n    driver     : {driver}\n    device     : {}\n    verdict    : {verdict}\n",
            // Uppercased deliberately. This is the string a user pastes into
            // `[[device]] id`, and `ksx_capture::winusb::enumerate` canonicalizes
            // every id it produces to uppercase, while config matching
            // (`run::plan`, `capture::build`) is byte-exact. The registry hands
            // this path back in mixed case, so printing it verbatim would show
            // the same interface two different ways in two different ksx
            // commands and a config built from THIS one would not match.
            // `ksx winusb claim/release` fold case on lookup, so they still
            // accept it.
            c.interface.instance_id.to_uppercase(),
            c.interface.description(),
        ));
        if let Some(kb) = &c.keyboard {
            out.push_str(&format!("    keyboard   : {}\n", kb.instance_id));
        }
        // The board's name if ksx knows it, not "the vendor makes encoders".
        // A SpinTrak is an Ultimarc too, and calling it an arcade encoder is
        // the same mistake in a different sentence.
        if let Some((vid, pid)) = c.interface.vid_pid() {
            if let Some(name) = ksx_core::vendors::name_for(vid, pid) {
                out.push_str(&format!("    note       : {name}\n"));
            }
        }
        out.push('\n');
    }

    // Deliberately "can type right now", not "present": a claimed, disabled or
    // paired-but-disconnected keyboard is present and will not type the command
    // that undoes a claim. This number is the refusal's, and printing anything
    // else here would make the refusal look arbitrary.
    out.push_str(&format!(
        "keyboards that can type right now: {}\n",
        survey.keyboard_count()
    ));
    for kb in survey.usable_keyboards() {
        out.push_str(&format!(
            "  {}  {}\n",
            kb.node.instance_id,
            kb.node.description()
        ));
    }
    let unusable: Vec<&ksx_platform::winusb::KeyboardNode> = survey
        .keyboards
        .iter()
        .filter(|kb| !kb.is_usable())
        .collect();
    if !unusable.is_empty() {
        out.push_str("not counted (present, but cannot deliver a keystroke):\n");
        for kb in unusable {
            out.push_str(&format!(
                "  {}  {} — {}\n",
                kb.node.instance_id,
                kb.node.description(),
                kb.unusable.unwrap_or("unknown")
            ));
        }
    }
    if survey.keyboard_count() <= 1 {
        out.push_str(
            "\n[!] Only one keyboard is present. `ksx winusb claim` will REFUSE to take it: a\n\
             \x20   claimed interface is invisible to Windows, and SendInput re-injection cannot\n\
             \x20   reach the lock screen, a UAC prompt or Ctrl+Alt+Del. Plug a second keyboard\n\
             \x20   into a different port and leave it unassigned.\n",
        );
    }
    out.push_str(
        "\nA claimed panel types only while ksx is running: `ksx daemon` holds the claim for\n\
         its whole lifetime and re-injects the panel's keys whenever emulation is stopped,\n\
         including between two games. `ksx run` claims for one session only, so the panel is\n\
         dark before and after it. See docs/ARCHITECTURE.md \"M6\" and docs/RECOVERY.md \
         section 2.\n",
    );
    out
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

fn claim(survey: &Survey, device: &str, opts: &Options) -> anyhow::Result<()> {
    let dir = inf_dir()?;
    let plan = match winusb::plan_claim(survey, device, &dir) {
        Ok(plan) => plan,
        Err(refusal) => refuse(&refusal, opts.json),
    };

    let will_apply = opts.yes && !opts.dry_run;

    report_claim(&plan, opts, will_apply)?;
    if !will_apply {
        return Ok(());
    }

    let result = prepare_machine(&WinusbPrepareSpec {
        expected_selector: plan.instance_id.clone(),
        instance_id: plan.instance_id.clone(),
        confirm_spare_keyboard: true,
        confirm_rebind: true,
        confirm_machine_certificate: true,
    })
    .unwrap_or_else(|err| mutation_refused(&err, opts.json));
    if result.state != "prepared" || !result.instance_id.eq_ignore_ascii_case(&plan.instance_id) {
        mutation_unverified(&result, "prepared", opts.json);
    }
    report_mutation(&result, opts.json)?;
    if !opts.json {
        println!(
            "To undo this exact KSX-owned preparation:\n  ksx winusb release {} --yes",
            result.instance_id
        );
    }
    Ok(())
}

fn report_claim(plan: &ClaimPlan, opts: &Options, will_apply: bool) -> anyhow::Result<()> {
    if opts.json {
        let mut value = plan.to_json(!will_apply);
        value["will_apply"] = serde_json::json!(will_apply);
        value["mutation_authority"] = serde_json::json!("installed-elevated-helper");
        value["confirmations"] = serde_json::json!({
            "spare_keyboard": will_apply,
            "interface_rebind": will_apply,
            "machine_certificate": will_apply,
        });
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    print!("{}", plan.render_human(!will_apply));
    println!(
        "\nSECURE APPLY: the installed elevated helper will re-resolve this exact interface,\n\
         create a durable rollback receipt, generate and sign a fixed WinUSB-only catalog,\n\
         and install a machine-local certificate. --yes confirms all three consequences:\n\
         a spare keyboard is connected; this interface leaves the keyboard stack; and the\n\
         temporary KSX signing certificate is trusted until release/cleanup."
    );
    if !will_apply {
        println!(
            "\nNothing was written and nothing was run. Re-run with --yes to apply.\n\
             Read docs/MIGRATION-WINUSB.md first — this changes what the device IS."
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

/// `ksx winusb repair`: say what disagrees, then settle it.
///
/// The read-only half runs without elevation, which is the point: a user who
/// wants to know whether anything is wrong should not have to approve a UAC
/// prompt to be told "nothing is". Only `--yes` crosses into the helper.
fn repair(opts: &Options) -> anyhow::Result<()> {
    let (findings, orphans) = match ksx_platform::winusb::transaction::reconcile_report() {
        Ok(pair) => pair,
        Err(err) => {
            if opts.json {
                println!(
                    "{}",
                    serde_json::json!({ "ok": false, "error": err.to_string() })
                );
            } else {
                println!("The recovery store could not be read: {err}");
                println!();
                println!("  If it has been deleted or damaged, `ksx winusb release-all --yes`");
                println!("  gives every ksx-claimed keyboard back without reading it.");
            }
            std::process::exit(EXIT_REFUSED);
        }
    };

    let drifted: Vec<_> = findings
        .iter()
        .filter(|f| f.drift != ksx_platform::winusb::transaction::Drift::Consistent)
        .collect();
    let will_apply = opts.yes && !opts.dry_run;

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "action": "repair",
                "receipts": findings.len(),
                "drifted": drifted.len(),
                "orphan_packages": orphans,
                "will_apply": will_apply,
            }))?
        );
    } else {
        println!("{} receipt(s) on this machine.", findings.len());
        if drifted.is_empty() && orphans.is_empty() {
            println!("  Nothing disagrees with the machine.");
        }
        for finding in &drifted {
            println!(
                "  {}  says {:?}, machine says {}",
                &finding.transaction_id[..8.min(finding.transaction_id.len())],
                finding.phase,
                finding.drift.word()
            );
        }
        for orphan in &orphans {
            println!("  {orphan}  a ksx driver package with no receipt");
        }
        if !orphans.is_empty() {
            println!();
            println!("  Repair reports orphans and does not remove them.");
            println!(
                "  `ksx winusb release-all --yes` is what removes a package no receipt describes."
            );
        }
        if !will_apply && !drifted.is_empty() {
            println!();
            println!("Nothing was changed. Re-run with --yes to settle it.");
        }
    }

    if !will_apply || drifted.is_empty() {
        return Ok(());
    }

    let exit = match SystemHelperElevator.run(HelperMutation::Repair, "") {
        Ok(exit) => exit,
        Err(err) => mutation_refused(&err, opts.json),
    };
    // The helper's own JSON never comes back through the UAC prompt, so the
    // answer is a fresh read rather than its word -- the same rule every other
    // mutating verb here follows.
    let after = ksx_platform::winusb::transaction::reconcile_report()
        .map(|(findings, orphans)| {
            (
                findings
                    .iter()
                    .filter(|f| f.drift != ksx_platform::winusb::transaction::Drift::Consistent)
                    .count(),
                orphans.len(),
            )
        })
        .unwrap_or((usize::MAX, usize::MAX));
    if opts.json {
        println!(
            "{}",
            serde_json::json!({ "helper_exit": exit, "drifted_after": after.0 })
        );
    } else if after.0 == 0 {
        println!();
        println!("Settled: the journal and the machine agree.");
    } else {
        println!();
        println!(
            "{} receipt(s) still disagree. `ksx winusb status` has the detail.",
            after.0
        );
    }
    Ok(())
}

/// `ksx winusb sweep-certificates` — the leftovers, and only the leftovers.
///
/// Reports without an administrator, like `repair`: reading a machine store
/// needs no elevation, and a person is entitled to know what is on their
/// computer before being asked to approve anything. Only `--yes` elevates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CertificateSweepDecision {
    ReportOnly,
    NothingToDo,
    Refused,
    Apply,
}

fn certificate_sweep_decision(
    yes: bool,
    dry_run: bool,
    blocked: bool,
    leftover_certificates: usize,
) -> CertificateSweepDecision {
    if !yes || dry_run {
        CertificateSweepDecision::ReportOnly
    } else if blocked {
        CertificateSweepDecision::Refused
    } else if leftover_certificates == 0 {
        CertificateSweepDecision::NothingToDo
    } else {
        CertificateSweepDecision::Apply
    }
}

fn sweep_certificates(opts: &Options) -> anyhow::Result<()> {
    let (rows, blocked) = match ksx_platform::winusb::transaction::certificate_report() {
        Ok(pair) => pair,
        Err(err) => {
            certificate_sweep_refused(
                &ApiRefusal::with_remedy(
                    "winusb-certificate-read-failed",
                    format!("the certificate stores could not be read: {err}"),
                    "leave the certificates in place and run `ksx doctor` before retrying",
                ),
                opts.json,
                None,
                false,
            );
        }
    };
    let orphans: Vec<_> = rows.iter().filter(|r| !r.in_use).collect();
    let kept: Vec<_> = rows.iter().filter(|r| r.in_use).collect();
    let certificates: usize = orphans.iter().map(|r| r.stores.len()).sum();
    let block_messages: Vec<String> = blocked.iter().map(sweep_block_message).collect();
    // A block is not a partial result. If any ksx package cannot say which
    // certificate signed it, nothing is safe to remove -- see
    // `sweep_orphaned_certificates`.
    let decision =
        certificate_sweep_decision(opts.yes, opts.dry_run, !blocked.is_empty(), certificates);
    let wants_apply = opts.yes && !opts.dry_run;
    let will_apply = decision == CertificateSweepDecision::Apply;
    let mut result = serde_json::json!({
        "ok": true,
        "action": "sweep-certificates",
        "leftover_subjects": orphans.iter().map(|r| &r.subject).collect::<Vec<_>>(),
        "leftover_certificates": certificates,
        "in_use_subjects": kept.iter().map(|r| &r.subject).collect::<Vec<_>>(),
        "blocked": block_messages,
        "will_apply": will_apply,
        "applied": false,
        "attempted": false,
        "verified": true,
    });

    if !opts.json {
        println!("Signing certificates ksx put in this computer's trust stores.\n");
        if rows.is_empty() {
            println!("  None. Nothing to do.");
        }
        for row in &orphans {
            println!("  leftover   {} ({})", row.subject, row.stores.join(", "));
        }
        for row in &kept {
            println!(
                "  IN USE     {} — signs an installed driver package",
                row.subject
            );
        }
        if !blocked.is_empty() {
            println!();
            println!("  REFUSED. The current package/certificate inventory is not safe to mutate:");
            for message in &block_messages {
                println!("    {message}");
            }
        } else if !orphans.is_empty() {
            println!();
            println!("  Removing the leftovers changes no driver and no keyboard. The ones");
            println!("  marked IN USE are left alone: deleting one breaks the package that");
            println!("  is holding a keyboard right now.");
        }
        if !wants_apply && blocked.is_empty() && !orphans.is_empty() {
            println!("\nNothing was removed. Re-run with --yes to apply.");
        }
    }

    if decision == CertificateSweepDecision::Refused {
        certificate_sweep_refused(
            &ApiRefusal::with_remedy(
                SWEEP_REFUSED,
                format!("certificate cleanup refused: {}", block_messages.join("; ")),
                "leave the certificates in place and run `ksx doctor` before retrying",
            ),
            opts.json,
            Some(result),
            false,
        );
    }
    if !will_apply {
        if opts.json {
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        return Ok(());
    }

    let view = match sweep_certificates_machine() {
        Ok(view) => view,
        Err(err) => certificate_sweep_refused(&err, opts.json, Some(result), true),
    };
    if opts.json {
        result["applied"] = serde_json::json!(true);
        result["attempted"] = serde_json::json!(true);
        result["verified"] = serde_json::json!(true);
        result["helper_exit"] = serde_json::json!(view.helper_exit);
        result["leftover_certificates_after"] = serde_json::json!(view.leftover_certificates);
        result["message"] = serde_json::json!(view.message);
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("\n{}", view.message);
    }
    Ok(())
}
fn release_all(opts: &Options) -> anyhow::Result<()> {
    let bound = match winusb_bound_now() {
        Ok(bound) => bound,
        Err(err) => mutation_refused(&err, opts.json),
    };
    let will_apply = opts.yes && !opts.dry_run;

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "action": "release-all",
                "winusb_bound_now": bound,
                "will_apply": will_apply,
            }))?
        );
    } else {
        println!("Give every ksx-claimed keyboard back to Windows.\n");
        if bound.is_empty() {
            println!("  Nothing on this machine is bound to winusb.sys right now.");
        } else {
            println!("  Bound to winusb.sys right now:");
            for id in &bound {
                println!("    {id}");
            }
        }
        println!();
        println!("  This removes every driver package ksx published and lets Windows");
        println!("  rebind the interfaces. It reads no receipt, so it works even if");
        println!("  C:\\ProgramData\\KSX has been deleted or damaged.");
        println!();
        println!("  A WinUSB device belonging to another program is left alone.");
        if !will_apply {
            println!("\nNothing was run. Re-run with --yes to apply.");
        }
    }
    if !will_apply {
        return Ok(());
    }

    let view = match release_all_machine() {
        Ok(view) => view,
        Err(err) => mutation_refused(&err, opts.json),
    };
    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "helper_exit": view.helper_exit,
                "still_bound": view.still_bound,
                "message": view.message,
            }))?
        );
    } else {
        println!("\n{}", view.message);
        for id in &view.still_bound {
            println!("  still bound (not ksx's): {id}");
        }
    }
    Ok(())
}

fn release(survey: &Survey, device: &str, force: bool, opts: &Options) -> anyhow::Result<()> {
    let plan = match winusb::plan_release(survey, device, force) {
        Ok(plan) => plan,
        Err(refusal) => refuse(&refusal, opts.json),
    };

    let will_apply = opts.yes && !opts.dry_run;

    report_release(&plan, opts, will_apply, force)?;
    if !will_apply {
        return Ok(());
    }

    let result = release_machine(&WinusbReleaseSpec {
        expected_selector: plan.instance_id.clone(),
        instance_id: plan.instance_id.clone(),
        confirm_release: true,
    })
    .unwrap_or_else(|err| mutation_refused(&err, opts.json));
    if result.state != "released" || !result.instance_id.eq_ignore_ascii_case(&plan.instance_id) {
        mutation_unverified(&result, "released", opts.json);
    }
    report_mutation(&result, opts.json)
}

fn report_release(
    plan: &ReleasePlan,
    opts: &Options,
    will_apply: bool,
    force: bool,
) -> anyhow::Result<()> {
    if opts.json {
        let mut value = plan.to_json(!will_apply);
        value["will_apply"] = serde_json::json!(will_apply);
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    print!("{}", plan.render_human(!will_apply));
    if force {
        println!(
            "\nNOTE: --force changes only the read-only recovery plan. Secure apply still\n\
             requires an exact KSX ownership receipt and cannot release a foreign package."
        );
    }
    if !will_apply {
        println!("\nNothing was run. Re-run with --yes to apply.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/// Where generated INFs live. Under the ksx config root so it survives a
/// reinstall and so `release` can find the filename it published.
fn inf_dir() -> anyhow::Result<std::path::PathBuf> {
    let root = ksx_config::ConfigRoot::discover()
        .map(|r| r.dir().to_path_buf())
        .unwrap_or_else(|_| std::env::temp_dir().join("ksx"));
    Ok(root.join("winusb"))
}

fn refuse(refusal: &Refusal, json: bool) -> ! {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&refusal.to_json()).unwrap_or_default()
        );
    } else {
        eprintln!("REFUSED: {refusal}\n\n{}", refusal.advice());
    }
    std::process::exit(EXIT_REFUSED);
}

fn mutation_refused(refusal: &ApiRefusal, json: bool) -> ! {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "error": {
                    "code": refusal.code,
                    "message": refusal.message,
                    "remedy": refusal.remedy,
                }
            }))
            .unwrap_or_default()
        );
    } else {
        eprintln!("REFUSED: {}", refusal.message);
        if let Some(remedy) = &refusal.remedy {
            eprintln!("\n{remedy}");
        }
    }
    std::process::exit(EXIT_APPLY_FAILED);
}

fn certificate_sweep_exit_code(refusal: &ApiRefusal) -> i32 {
    match refusal.code.as_str() {
        SWEEP_REFUSED | "winusb-certificate-read-failed" | ksx_api::codes::BAD_REQUEST => {
            EXIT_REFUSED
        }
        SWEEP_RECOVERY_REQUIRED | SWEEP_UNVERIFIED | SWEEP_INCOMPLETE => EXIT_RECOVERY_REQUIRED,
        _ => EXIT_APPLY_FAILED,
    }
}

fn certificate_sweep_refused(
    refusal: &ApiRefusal,
    json: bool,
    plan: Option<serde_json::Value>,
    attempted: bool,
) -> ! {
    if json {
        let mut value = plan.unwrap_or_else(|| {
            serde_json::json!({
                "action": "sweep-certificates",
                "applied": false,
            })
        });
        value["ok"] = serde_json::json!(false);
        value["will_apply"] = serde_json::json!(false);
        value["attempted"] = serde_json::json!(attempted);
        value["verified"] = serde_json::json!(false);
        value["applied"] = if attempted {
            serde_json::Value::Null
        } else {
            serde_json::json!(false)
        };
        value["error"] = serde_json::json!({
            "code": refusal.code,
            "message": refusal.message,
            "remedy": refusal.remedy,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        );
    } else {
        eprintln!("REFUSED: {}", refusal.message);
        if let Some(remedy) = &refusal.remedy {
            eprintln!("\n{remedy}");
        }
    }
    std::process::exit(certificate_sweep_exit_code(refusal));
}

fn mutation_unverified(view: &WinusbMutationView, expected: &str, json: bool) -> ! {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "error": {
                    "code": "winusb-recovery-required",
                    "message": format!("expected {expected}, observed {}", view.state),
                    "mutation": view,
                }
            }))
            .unwrap_or_default()
        );
    } else {
        eprintln!(
            "RECOVERY REQUIRED: expected {expected}, but the authoritative post-operation state is {}.\n\n{}",
            view.state, view.message
        );
        if let Some(warning) = &view.warning {
            eprintln!("\n{warning}");
        }
    }
    std::process::exit(EXIT_RECOVERY_REQUIRED);
}

fn report_mutation(view: &WinusbMutationView, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(view)?);
    } else {
        println!("\n{}", view.message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksx_platform::winusb::DeviceNode;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// The keyboard interface of the board every one of these tests is about.
    const IPAC: &str = r"USB\VID_D209&PID_0430&MI_00\7&1A2B3C4D&0&0000";

    struct FakeElevator {
        exit: u32,
        calls: Mutex<Vec<(HelperMutation, String)>>,
    }

    impl HelperElevator for FakeElevator {
        fn run(&self, action: HelperMutation, instance_id: &str) -> Result<u32, ApiRefusal> {
            self.calls
                .lock()
                .unwrap()
                .push((action, instance_id.to_owned()));
            Ok(self.exit)
        }
    }

    struct FakeObserver {
        values: Mutex<VecDeque<ObservedMutation>>,
    }

    impl MutationObserver for FakeObserver {
        fn preflight(
            &self,
            _action: HelperMutation,
            _expected_selector: &str,
            _instance_id: &str,
        ) -> Result<ObservedMutation, ApiRefusal> {
            self.values
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ApiRefusal::new("test-observer-empty", "no preflight observation"))
        }

        fn observe(&self, _instance_id: &str) -> Result<ObservedMutation, ApiRefusal> {
            self.values
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ApiRefusal::new("test-observer-empty", "no final observation"))
        }
    }

    fn observed(
        binding: ObservedBinding,
        phase: Option<winusb::transaction::Phase>,
    ) -> ObservedMutation {
        let instance_id = r"USB\VID_D209&PID_0430&MI_00\EXACT".to_owned();
        ObservedMutation {
            hardware_id: r"USB\VID_D209&PID_0430&MI_00".to_owned(),
            ownership: phase.map(|phase| winusb::transaction::OwnershipState {
                phase,
                instance_id: instance_id.clone(),
                hardware_id: r"USB\VID_D209&PID_0430&MI_00".to_owned(),
                transaction_id: "0123456789abcdef0123456789abcdef".to_owned(),
                recovery_reason: (phase == winusb::transaction::Phase::RecoveryRequired)
                    .then(|| "injected recovery".to_owned()),
            }),
            instance_id,
            binding,
        }
    }

    #[test]
    fn machine_prepare_trusts_fresh_state_not_helper_exit_or_output() {
        let elevator = FakeElevator {
            exit: 3,
            calls: Mutex::new(Vec::new()),
        };
        let observer = FakeObserver {
            values: Mutex::new(VecDeque::from([
                observed(ObservedBinding::HidUsb, None),
                observed(
                    ObservedBinding::WinUsb,
                    Some(winusb::transaction::Phase::Active),
                ),
            ])),
        };
        let result = prepare_machine_with(
            &WinusbPrepareSpec {
                expected_selector: "usb:vid=d209,pid=0430,mi=00,port=exact".to_owned(),
                instance_id: r"USB\VID_D209&PID_0430&MI_00\EXACT".to_owned(),
                confirm_spare_keyboard: true,
                confirm_rebind: true,
                confirm_machine_certificate: true,
            },
            &elevator,
            &observer,
        )
        .expect("authoritative active receipt and WinUSB binding win");
        assert_eq!(result.state, "prepared");
        assert_eq!(elevator.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn helper_argv_is_the_fixed_path_free_contract() {
        let instance = r"USB\VID_D209&PID_0430&MI_00\EXACT";
        assert_eq!(
            helper_arguments(HelperMutation::Prepare, instance),
            vec![
                "prepare-exact",
                instance,
                "--confirm-spare-keyboard",
                "--confirm-rebind",
                "--confirm-machine-certificate",
            ]
        );
        assert_eq!(
            helper_arguments(HelperMutation::Release, instance),
            vec!["release-exact", instance, "--confirm-release"]
        );
        assert_eq!(
            helper_arguments(HelperMutation::SweepCertificates, "ignored"),
            vec!["sweep-certificates"]
        );
    }

    fn sweep_state(left: usize, blocked: &[&str]) -> CertificateSweepPostState {
        CertificateSweepPostState {
            leftover_certificates: left,
            blocked: blocked
                .iter()
                .map(|message| (*message).to_owned())
                .collect(),
        }
    }

    #[test]
    fn certificate_sweep_requires_zero_exit_and_a_clean_authoritative_postread() {
        for (exit, expected_code) in [
            (2, SWEEP_REFUSED),
            (3, SWEEP_FAILED),
            (4, SWEEP_RECOVERY_REQUIRED),
            (19, SWEEP_FAILED),
        ] {
            let elevator = FakeElevator {
                exit,
                calls: Mutex::new(Vec::new()),
            };
            let report = || panic!("a failed helper must not be licensed by a later read");
            let refusal = sweep_certificates_machine_with(&elevator, &report)
                .expect_err("nonzero helper exit");
            assert_eq!(refusal.code, expected_code, "exit {exit}");
        }

        let elevator = FakeElevator {
            exit: 0,
            calls: Mutex::new(Vec::new()),
        };
        let leftovers = || Ok(sweep_state(2, &[]));
        let refusal =
            sweep_certificates_machine_with(&elevator, &leftovers).expect_err("leftovers remain");
        assert_eq!(refusal.code, SWEEP_INCOMPLETE);

        let blocked = || Ok(sweep_state(0, &["signer attribution changed"]));
        let refusal =
            sweep_certificates_machine_with(&elevator, &blocked).expect_err("blocked postread");
        assert_eq!(refusal.code, SWEEP_UNVERIFIED);

        let unreadable = || {
            Err(ApiRefusal::new(
                "winusb-certificate-read-failed",
                "store unavailable",
            ))
        };
        let refusal = sweep_certificates_machine_with(&elevator, &unreadable)
            .expect_err("unreadable poststate");
        assert_eq!(refusal.code, SWEEP_UNVERIFIED);

        let clean = || Ok(sweep_state(0, &[]));
        let view = sweep_certificates_machine_with(&elevator, &clean).expect("verified clean");
        assert_eq!(view.helper_exit, 0);
        assert_eq!(view.leftover_certificates, 0);
        assert_eq!(
            elevator.calls.lock().unwrap().as_slice(),
            &[
                (HelperMutation::SweepCertificates, String::new()),
                (HelperMutation::SweepCertificates, String::new()),
                (HelperMutation::SweepCertificates, String::new()),
                (HelperMutation::SweepCertificates, String::new()),
            ]
        );
    }

    #[test]
    fn certificate_sweep_exit_codes_distinguish_refusal_failure_and_recovery() {
        assert_eq!(
            certificate_sweep_exit_code(&ApiRefusal::new(SWEEP_REFUSED, "blocked")),
            EXIT_REFUSED
        );
        assert_eq!(
            certificate_sweep_exit_code(&ApiRefusal::new(SWEEP_FAILED, "failed")),
            EXIT_APPLY_FAILED
        );
        for code in [SWEEP_RECOVERY_REQUIRED, SWEEP_UNVERIFIED, SWEEP_INCOMPLETE] {
            assert_eq!(
                certificate_sweep_exit_code(&ApiRefusal::new(code, "unverified")),
                EXIT_RECOVERY_REQUIRED
            );
        }
    }

    #[test]
    fn certificate_sweep_never_elevates_for_report_dry_run_block_or_zero_leftovers() {
        assert_eq!(
            certificate_sweep_decision(false, false, false, 2),
            CertificateSweepDecision::ReportOnly
        );
        assert_eq!(
            certificate_sweep_decision(true, true, false, 2),
            CertificateSweepDecision::ReportOnly
        );
        assert_eq!(
            certificate_sweep_decision(true, false, true, 2),
            CertificateSweepDecision::Refused
        );
        assert_eq!(
            certificate_sweep_decision(true, false, false, 0),
            CertificateSweepDecision::NothingToDo
        );
        assert_eq!(
            certificate_sweep_decision(true, false, false, 2),
            CertificateSweepDecision::Apply
        );
    }

    #[test]
    fn machine_release_normalizes_only_verified_hidusb_to_released() {
        let elevator = FakeElevator {
            exit: 0,
            calls: Mutex::new(Vec::new()),
        };
        let observer = FakeObserver {
            values: Mutex::new(VecDeque::from([
                observed(
                    ObservedBinding::WinUsb,
                    Some(winusb::transaction::Phase::Active),
                ),
                observed(
                    ObservedBinding::HidUsb,
                    Some(winusb::transaction::Phase::Released),
                ),
            ])),
        };
        let result = release_machine_with(
            &WinusbReleaseSpec {
                expected_selector: "usb:vid=d209,pid=0430,mi=00,port=exact".to_owned(),
                instance_id: r"USB\VID_D209&PID_0430&MI_00\EXACT".to_owned(),
                confirm_release: true,
            },
            &elevator,
            &observer,
        )
        .expect("verified release");
        assert_eq!(result.state, "released");
    }

    #[test]
    fn machine_prepare_refuses_before_elevation_without_all_consents() {
        let elevator = FakeElevator {
            exit: 0,
            calls: Mutex::new(Vec::new()),
        };
        let observer = FakeObserver {
            values: Mutex::new(VecDeque::new()),
        };
        let refused = prepare_machine_with(&WinusbPrepareSpec::default(), &elevator, &observer)
            .expect_err("missing consent");
        assert_eq!(refused.code, ksx_api::codes::BAD_REQUEST);
        assert!(elevator.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn an_ambiguous_selector_blocks_release_before_elevation() {
        let facts = [
            ksx_core::DeviceFacts {
                id: ksx_core::DeviceId::new(r"USB\VID_D209&PID_0430&MI_00\FIRST"),
                vendor_id: 0xd209,
                product_id: 0x0430,
                interface_number: 0,
                serial: None,
                instance: "FIRST".to_owned(),
            },
            ksx_core::DeviceFacts {
                id: ksx_core::DeviceId::new(r"USB\VID_D209&PID_0430&MI_00\TWIN"),
                vendor_id: 0xd209,
                product_id: 0x0430,
                interface_number: 0,
                serial: None,
                instance: "TWIN".to_owned(),
            },
        ];
        let refusal = selector_targets_against(
            "usb:d209:0430:00",
            r"USB\VID_D209&PID_0430&MI_00\FIRST",
            &facts,
        )
        .expect_err("a weak selector cannot authenticate the originally staged twin");
        assert_eq!(refusal.code, "staged-device-ambiguous");
    }

    /// The direct, unjournaled `apply_claim`/`apply_release` route is gone: a
    /// driver mutation may only reach Windows through the elevated helper,
    /// which journals and can compensate.
    ///
    /// Only the shipping half of this file is scanned, and that is the whole
    /// difficulty. This test has to name the calls it forbids, so scanning its
    /// own text matched every time and the assertion could never hold — it
    /// shipped unsatisfiable. Splitting at `#[cfg(test)]` is what makes it a
    /// question about the product instead of a question about itself.
    #[test]
    fn shipping_cli_has_only_the_journaled_helper_mutation_authority() {
        let (shipping, _tests) = include_str!("winusb.rs")
            .split_once("\n#[cfg(test)]")
            .expect("winusb.rs keeps its tests behind a column-0 #[cfg(test)]");

        for forbidden in ["winusb::apply_claim(", "winusb::apply_release("] {
            assert!(
                !shipping.contains(forbidden),
                "`{forbidden}` mutates the driver store without a journal to roll back from"
            );
        }
        for required in [
            "prepare_machine(&WinusbPrepareSpec",
            "release_machine(&WinusbReleaseSpec",
            "confirm_machine_certificate: true",
        ] {
            assert!(
                shipping.contains(required),
                "the journaled helper route lost `{required}`"
            );
        }
    }

    fn node(id: &str, class: &str, service: &str, desc: &str, prefix: Option<&str>) -> DeviceNode {
        DeviceNode::new(
            id,
            Some(class.to_owned()),
            Some(service.to_owned()),
            Some(desc.to_owned()),
            prefix.map(str::to_owned),
        )
    }

    const HID: &str = "{745a17a0-74d3-11d0-b6fe-00a0c90f57da}";

    fn one_keyboard_only() -> Survey {
        Survey::from_nodes(&[
            node(
                r"USB\VID_D209&PID_0430&MI_00\7&1a2b3c4d&0&0000",
                HID,
                "HidUsb",
                "@input.inf,%hid.devicedesc%;USB Input Device",
                Some("8&a1b2c3d4&0"),
            ),
            node(
                r"HID\VID_D209&PID_0430&MI_00\8&a1b2c3d4&0&0000",
                winusb::KEYBOARD_CLASS_GUID,
                "kbdhid",
                "@keyboard.inf,%hid.keyboarddevice%;HID Keyboard Device",
                None,
            ),
        ])
    }

    /// Every code is asserted against the one `run` publishes, never against a
    /// literal: a `winusb` that answered 3 while the rest of the CLI answered 3
    /// for a *different* reason is exactly the drift these names exist to
    /// prevent. The numbers themselves are pinned once, in
    /// `run::tests::exit_codes_are_the_documented_values`.
    #[test]
    fn exit_codes_match_the_rest_of_the_cli() {
        assert_eq!(EXIT_REFUSED, crate::run::EXIT_CANNOT_START);
        assert_eq!(EXIT_REFUSED, crate::install::EXIT_REFUSED);
        assert_eq!(EXIT_APPLY_FAILED, crate::run::EXIT_RUNTIME_FAILURE);
    }

    /// `status` is the command a user runs *before* they can hurt themselves,
    /// so the one-keyboard warning has to be there and has to say why.
    #[test]
    fn status_warns_loudly_when_there_is_only_one_keyboard() {
        let text = render_status(&one_keyboard_only());
        assert!(text.contains("Only one keyboard"), "{text}");
        assert!(text.contains("REFUSE"), "{text}");
        assert!(text.contains("lock screen"), "{text}");
        assert!(text.contains("different port"), "{text}");
    }

    /// Status must print the instance path in the **canonical (uppercase)**
    /// form — it is the argument for every other verb, the string
    /// docs/RECOVERY.md tells people to copy, and the value that ends up in
    /// `[[device]] id`.
    ///
    /// The registry returns this path in mixed case. `ksx devices` and
    /// `ksx_capture::winusb::enumerate` canonicalize to uppercase, and config
    /// matching (`run::plan`, `capture::build`) is byte-exact — so printing the
    /// raw casing here would show one interface two different ways in two ksx
    /// commands, and a config built from this screen would not match the
    /// backend's id. Uppercase costs nothing because `Survey::resolve` folds
    /// case, so `ksx winusb claim` still accepts what is printed.
    #[test]
    fn status_prints_the_instance_path_the_other_verbs_take() {
        let survey = one_keyboard_only();
        let text = render_status(&survey);
        let canonical = r"USB\VID_D209&PID_0430&MI_00\7&1A2B3C4D&0&0000";
        assert!(text.contains(canonical), "{text}");
        assert!(
            !text.contains(r"7&1a2b3c4d&0&0000"),
            "the non-canonical casing must not be what a user copies: {text}"
        );
        // ...and what was printed still resolves, so the copy-paste works.
        assert!(
            survey.resolve(canonical).is_ok(),
            "the canonical form must round-trip through the claim lookup"
        );
        assert!(
            text.contains(r"HID\VID_D209&PID_0430&MI_00\8&a1b2c3d4&0&0000"),
            "the HID keyboard child is what `ksx devices` shows: {text}"
        );
        assert!(text.contains("CLAIMABLE"), "{text}");
        assert!(text.contains("Ultimarc"), "{text}");
        // And the trade-off is stated on the screen a user actually reads.
        assert!(text.contains("only while ksx is running"), "{text}");
    }

    #[test]
    fn status_says_nothing_was_opened() {
        assert!(render_status(&Survey::default()).contains("nothing was opened"));
    }

    /// The refusal and the screen must agree about what a keyboard is.
    ///
    /// A paired-but-disconnected Bluetooth keyboard is *present* all day. If
    /// `status` counted it, the user would read "2 keyboards", claim the panel,
    /// and discover the second one was in a drawer with no batteries. So it is
    /// listed — hiding it would be its own lie — but under a heading that says
    /// it does not count, and the warning fires anyway.
    #[test]
    fn status_does_not_count_a_keyboard_that_cannot_type() {
        let bt = r"BTHENUM\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&0800\7&A1B2C3D4&0&02A1B2C3D4E5_C00000000";
        let mut nodes = vec![
            node(
                r"USB\VID_D209&PID_0430&MI_00\7&1a2b3c4d&0&0000",
                HID,
                "HidUsb",
                "@input.inf,%hid.devicedesc%;USB Input Device",
                Some("8&a1b2c3d4&0"),
            ),
            node(
                r"HID\VID_D209&PID_0430&MI_00\8&a1b2c3d4&0&0000",
                winusb::KEYBOARD_CLASS_GUID,
                "kbdhid",
                "@keyboard.inf,%hid.keyboarddevice%;HID Keyboard Device",
                None,
            ),
        ];
        nodes.push(
            node(
                bt,
                winusb::KEYBOARD_CLASS_GUID,
                "kbdhid",
                "@keyboard.inf,%hid.keyboarddevice%;Bluetooth Keyboard",
                None,
            )
            .with_status(winusb::NodeStatus {
                started: false,
                problem: winusb::CM_PROB_DEVICE_NOT_CONNECTED,
            }),
        );
        let survey = Survey::from_nodes(&nodes);
        let text = render_status(&survey);

        assert!(
            text.contains("keyboards that can type right now: 1"),
            "{text}"
        );
        assert!(text.contains("not counted"), "{text}");
        assert!(text.contains("not connected"), "{text}");
        assert!(
            text.contains("Only one keyboard"),
            "the warning must still fire: {text}"
        );

        // ...and the claim itself is refused, which is the whole point.
        let refusal = winusb::plan_claim(&survey, "MI_00", std::path::Path::new("."))
            .expect_err("the panel is the only keyboard that can type");
        assert_eq!(refusal.code(), "last-keyboard");
    }

    /// The last-keyboard refusal is exit **2**, like every other "nothing was
    /// changed" answer. Scripts and the runbook both key on it.
    #[test]
    fn the_last_keyboard_refusal_exits_two() {
        let refusal = winusb::plan_claim(&one_keyboard_only(), "MI_00", std::path::Path::new("."))
            .expect_err("one keyboard, and it is the panel");
        assert_eq!(refusal.code(), "last-keyboard");
        assert_eq!(EXIT_REFUSED, 2);
        assert!(refusal.advice().contains("second keyboard"), "{refusal}");
    }

    /// Preparing an already-prepared keyboard is a redundant request, not a
    /// broken machine, and it has to SAY so.
    ///
    /// Fails against the version that had one refusal for every wrong binding:
    /// the code below was `winusb-live-state-changed`, which Studio flattened
    /// into "Windows could not prepare this keyboard. Nothing in Setup was
    /// changed; keep the spare keyboard connected and try again" — three
    /// pieces of advice, none of which applies.
    #[test]
    fn a_second_prepare_says_already_prepared_and_offers_release() {
        let refusal = binding_gate(HelperMutation::Prepare, IPAC, ObservedBinding::WinUsb)
            .expect_err("nothing to do");
        assert_eq!(refusal.code, "winusb-already-prepared");
        assert!(refusal.message.contains(IPAC), "{}", refusal.message);
        let remedy = refusal.remedy.unwrap_or_default();
        assert!(remedy.contains("Release"), "{remedy}");
    }

    #[test]
    fn a_second_release_says_already_released_and_offers_prepare() {
        let refusal = binding_gate(HelperMutation::Release, IPAC, ObservedBinding::HidUsb)
            .expect_err("nothing to do");
        assert_eq!(refusal.code, "winusb-already-released");
        let remedy = refusal.remedy.unwrap_or_default();
        assert!(remedy.contains("Prepare"), "{remedy}");
    }

    /// The state each action needs is still simply allowed, and a binding that
    /// is NEITHER end of the rebind is still the generic refusal — a board on
    /// libusbK is a machine problem and must not be reported as "already done".
    #[test]
    fn the_gate_still_separates_ready_from_a_foreign_driver() {
        assert!(binding_gate(HelperMutation::Prepare, IPAC, ObservedBinding::HidUsb).is_ok());
        assert!(binding_gate(HelperMutation::Release, IPAC, ObservedBinding::WinUsb).is_ok());
        for action in [HelperMutation::Prepare, HelperMutation::Release] {
            let refusal = binding_gate(action, IPAC, ObservedBinding::Other)
                .expect_err("a foreign driver is not a state ksx can act on");
            assert_eq!(refusal.code, "winusb-live-state-changed");
        }
    }
}
