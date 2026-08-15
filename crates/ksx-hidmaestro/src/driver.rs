//! Legacy in-process availability model and deliberately unavailable
//! [`crate::HmDriverApi`].
//!
//! The production DualSense route does **not** use this trait or probe. It uses
//! the fixed authenticated out-of-process host in `windows_transport`, while
//! this older model remains available to its pure lifecycle/concurrency tests.
//! [`UnavailableDriver`] therefore still refuses every in-process operation;
//! wiring it to the machine would bypass the product privilege boundary.
//!
//! The probe below is legacy model evidence only. `ksx doctor` owns the live
//! exact-package hash probe in `ksx-platform`, and product routing owns the
//! fixed host client.
//!
//! So this module contains no fake driver. It answers the sweep honestly
//! (nothing to sweep, because ksx created nothing) and refuses everything else.
//! The surrounding seqlock, lifecycle, routing, and cadence code remains a
//! private conformance model; production integration must bind or replace it
//! against the supported runtime rather than assume it can run unchanged.
//!
//! ## Why this model remains unavailable
//!
//! HIDMaestro's author has supplied the exact object names and the authoritative
//! MIT sources: `driver/driver.h` for packed structures/bounds and
//! `sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs` for creator/writer behavior.
//! They prove that the real protocol is not this crate's small open-existing
//! latch. The production route is instead a narrowed, source-built runtime
//! behind a fixed NativeAOT host, with no provisioning or global-cleanup
//! protocol authority. A direct in-process/native protocol client remains
//! intentionally absent. The main daemon and games stay unelevated.

use crate::error::{HmError, ProbeSummary};

/// Where a real install puts things. Checked in order; any hit is reported so a
/// partial install is distinguishable from no install.
///
/// This list belongs only to the legacy model. The live Doctor collector uses
/// a stronger exact Driver Store INF/DLL hash proof.
pub const PROBE_TARGETS: &[&str] = &[
    r"HKLM\SYSTEM\CurrentControlSet\Services\HIDMaestro",
    r"%SystemRoot%\System32\drivers\UMDF\HIDMaestro.dll",
    r"%ProgramFiles%\HIDMaestro",
];

/// Is HIDMaestro installed?
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Availability {
    pub installed: bool,
    pub probe: ProbeSummary,
}

impl Availability {
    /// Turns a probe into the error the CLI shows, or `Ok` if installed.
    pub fn require(&self) -> Result<(), HmError> {
        if self.installed {
            Ok(())
        } else {
            Err(HmError::NotInstalled {
                probe: self.probe.clone(),
            })
        }
    }
}

/// Decides installed-vs-not from raw probe hits.
///
/// Pure, so the *policy* ("a service key alone is not an install") is testable
/// without touching a registry. The policy: HIDMaestro counts as installed only
/// when the UMDF driver binary is actually on disk. A leftover service key from
/// an uninstall would otherwise let ksx promise personas it cannot deliver, and
/// fail later at create time instead of at config-validation time.
pub fn evaluate(hits: &[bool]) -> Availability {
    assert_eq!(hits.len(), PROBE_TARGETS.len(), "one hit per probe target");
    let found: Vec<String> = PROBE_TARGETS
        .iter()
        .zip(hits)
        .filter(|(_, hit)| **hit)
        .map(|(t, _)| (*t).to_string())
        .collect();
    // Index 1 is the UMDF driver binary — the load-bearing artifact.
    let installed = hits[1];
    Availability {
        installed,
        probe: ProbeSummary {
            looked_for: PROBE_TARGETS.iter().map(|t| (*t).to_string()).collect(),
            found,
        },
    }
}

/// Probes the live machine.
#[cfg(windows)]
pub fn probe() -> Availability {
    fn expand(path: &str) -> std::path::PathBuf {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".to_string());
        std::path::PathBuf::from(
            path.replace("%SystemRoot%", &system_root)
                .replace("%ProgramFiles%", &program_files),
        )
    }
    // The service key is a registry path; checking it needs no registry API
    // here — its presence is reported by `ksx doctor` (ksx-platform already
    // owns registry access). This crate's own decision rests on the driver
    // binary, so a missing registry answer cannot change the verdict.
    let hits = [
        false,
        expand(PROBE_TARGETS[1]).is_file(),
        expand(PROBE_TARGETS[2]).is_dir(),
    ];
    evaluate(&hits)
}

#[cfg(not(windows))]
pub fn probe() -> Availability {
    // HIDMaestro is a Windows UMDF2 driver; there is nothing to find elsewhere.
    evaluate(&[false, false, false])
}

/// The [`crate::context::HmDriverApi`] this build ships — the one that cannot
/// create a device.
///
/// Deliberately **not** a mock or a stub: it does not pretend to create
/// devices, and it does not silently succeed. It refuses at the first step that
/// would need a device to exist, and it refuses for the true reason (nothing
/// here can build one) rather than the plausible one (the driver is absent).
pub struct UnavailableDriver {
    availability: Availability,
}

/// What is specifically missing, carried by every refusal below.
///
/// Short and concrete on purpose: [`HmError::NotImplemented`]'s own message
/// already supplies the consequences, so this only has to name the hole.
const GAP: &str = "HIDMaestro's real creator/input/output protocol is not implemented here; the \
                   experimental latch is not wire-compatible and cannot create a controller";

impl UnavailableDriver {
    pub fn new() -> Self {
        Self {
            availability: probe(),
        }
    }

    /// What the probe found. **Diagnostic only** — nothing in this file branches
    /// on it any more. It used to, and that was the bug: `require()` was called
    /// and its success thrown away one line later, so "installed" and "not
    /// installed" produced the same `NotInstalled` error and the install a user
    /// performed had no observable effect anywhere.
    pub fn availability(&self) -> &Availability {
        &self.availability
    }
}

impl Default for UnavailableDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl crate::context::HmDriverApi for UnavailableDriver {
    /// Never produced — `create_controller` always refuses — but the trait
    /// needs a type, and naming the heap one keeps this file free of Windows
    /// types it does not use.
    type Storage = crate::seqlock::HeapStorage;

    fn remove_all_virtual_controllers(&mut self) -> Result<usize, HmError> {
        // Truthful whatever the machine has: ksx cannot create a HIDMaestro
        // controller, so ksx has none to sweep. This is the one step that is
        // meaningfully answerable without a driver, and answering it keeps the
        // lifecycle order under test in production too.
        Ok(0)
    }

    fn load_default_profiles(&mut self) -> Result<usize, HmError> {
        Err(HmError::NotImplemented { detail: GAP })
    }

    fn install_driver(&mut self) -> Result<(), HmError> {
        Err(HmError::NotImplemented { detail: GAP })
    }

    fn publish_pid_pool(
        &mut self,
        _slot: crate::context::SlotId,
        _profile: &crate::profile::HmProfile,
    ) -> Result<(), HmError> {
        Err(HmError::NotImplemented { detail: GAP })
    }

    fn create_controller(
        &mut self,
        _slot: crate::context::SlotId,
        _profile: &crate::profile::HmProfile,
    ) -> Result<crate::seqlock::Latch<Self::Storage>, HmError> {
        Err(HmError::NotImplemented { detail: GAP })
    }

    fn park_feedback_index(
        &mut self,
        _slot: crate::context::SlotId,
        _index: i32,
    ) -> Result<(), HmError> {
        Ok(())
    }

    fn dispose_dispatchers(&mut self, _slot: crate::context::SlotId) -> Result<(), HmError> {
        Ok(())
    }

    fn destroy_controller(&mut self, _slot: crate::context::SlotId) -> Result<(), HmError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{HmContext, HmDriverApi};

    #[test]
    fn a_leftover_service_key_alone_is_not_an_install() {
        let a = evaluate(&[true, false, false]);
        assert!(!a.installed);
        let msg = a.probe.to_string();
        assert!(msg.contains("partial install"), "{msg}");
        assert!(a.require().is_err());
    }

    #[test]
    fn the_umdf_driver_binary_is_what_counts() {
        let a = evaluate(&[false, true, false]);
        assert!(a.installed);
        assert!(a.require().is_ok());
    }

    #[test]
    fn a_clean_machine_reports_what_it_looked_for() {
        let a = evaluate(&[false, false, false]);
        assert!(!a.installed);
        assert!(a.probe.found.is_empty());
        assert_eq!(a.probe.looked_for.len(), PROBE_TARGETS.len());
        let msg = a.require().unwrap_err().to_string();
        for target in PROBE_TARGETS {
            assert!(msg.contains(target), "{msg} should name {target}");
        }
    }

    /// The honesty contract: nothing pretends, and nothing blames the machine.
    #[test]
    fn the_unavailable_driver_refuses_instead_of_faking_a_device() {
        let mut driver = UnavailableDriver::new();
        // The sweep is answerable and answered.
        assert_eq!(driver.remove_all_virtual_controllers().unwrap(), 0);
        // Everything that would need a device refuses, and says so.
        let err = driver.install_driver().unwrap_err();
        assert!(err.is_not_implemented(), "{err}");
        assert!(driver.load_default_profiles().is_err());

        // ...and through the context, `start` fails with the same error rather
        // than leaving a half-started session.
        let mut ctx = HmContext::new(UnavailableDriver::new());
        let err = ctx.start().unwrap_err();
        assert!(err.is_not_implemented(), "{err}");
        assert!(ctx.live_slots().is_empty());
    }

    /// The bug this file was carrying, stated as a test.
    ///
    /// `install_driver` and `load_default_profiles` used to call
    /// `availability.require()?` and then return `NotInstalled` on the very
    /// next line — so a machine WITH HIDMaestro got the identical "not
    /// installed" error, and installing the driver was unobservable. Nothing
    /// here may depend on the probe again: a probe-shaped answer to a
    /// build-shaped question is the whole failure.
    #[test]
    fn refusal_never_depends_on_whether_hidmaestro_is_installed() {
        let installed = probe().installed;
        let mut driver = UnavailableDriver::new();
        for err in [
            driver.install_driver().unwrap_err(),
            driver.load_default_profiles().unwrap_err(),
        ] {
            assert!(
                err.is_not_implemented(),
                "probe said installed={installed}; refusal must not blame the install: {err}"
            );
            assert!(!err.is_not_installed(), "{err}");
            let msg = err.to_string();
            assert!(msg.contains("on any machine, installed or not"), "{msg}");
        }
    }

    /// The step that actually plugs a pad, checked on its own: it is what the
    /// picker's promise cashes out to, and it never even reached `require()`.
    #[test]
    fn create_controller_refuses_as_unimplemented_not_as_uninstalled() {
        let profile = crate::profile::dualsense_conformance_stub_profile();
        let mut driver = UnavailableDriver::new();
        let err = driver.create_controller(0, &profile).unwrap_err();
        assert!(err.is_not_implemented(), "{err}");
        assert!(!err.is_not_installed(), "{err}");
        assert!(driver
            .publish_pid_pool(0, &profile)
            .unwrap_err()
            .is_not_implemented());
    }
}
