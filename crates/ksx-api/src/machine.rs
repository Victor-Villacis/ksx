//! The MACHINE verbs: the operations docs/CONTROL-SURFACE.md enumerates that
//! are neither a `DaemonCommand` nor a preset write — devices, pads, presets,
//! autostart, doctor, WinUSB.
//!
//! They are here for the same reason [`crate::ControlSource`] is: a native
//! shell, the MCP shim and Studio must reach them through ONE typed surface,
//! or each grows its own JSON and the standing rule ("every front-door action
//! maps to an existing backend verb") becomes a thing reviewers enforce by
//! reading.
//!
//! **Status, stated plainly: this is the typed surface, and nothing implements
//! it yet.** Every method is defaulted, and every default is a WORDED refusal
//! naming the command that does work — never a silent no-op, never an empty
//! view that looks like real data. That is exactly what CONTROL-SURFACE's own
//! column says about these rows today ("M9: same verb in-process. M10: api"):
//! the CLI is the front door, and a surface asking through this trait is told
//! so, per call, with the line to type.
//!
//! The reads (devices, presets, autostart, doctor, WinUSB status) are
//! daemon-free and safe from anywhere, so ksx-backend can implement them the day a
//! surface consumes them — the shapes below are what it would fill in. The
//! mutating and elevated ones are a different question and not merely
//! unimplemented: a pad test COMPETES for the four XInput slots, and `winusb
//! claim`/`release` can leave a panel that no longer types. Those keep the
//! CLI's dry-run-first consent shape, and the refusal says which command
//! carries it.
//!
//! Writing the trait before the implementations is deliberate, and it is the
//! cheap half: it fixes the vocabulary (one `DevicesView`, not one per
//! surface), and it means the first consumer adds a provider instead of
//! inventing a second JSON shape on its way to the same collectors.

use serde::{Deserialize, Serialize};

use crate::refusal::Refusal;

/// The machine ksx is installed on, as a surface can see it.
pub trait MachineSource: Send + Sync {
    /// `ksx devices` — the keyboards Interception sees and the USB interfaces
    /// ksx can reason about. Read-only and safe mid-session.
    fn devices(&self) -> Result<DevicesView, Refusal> {
        Err(Refusal::not_here("listing devices", "run `ksx devices`"))
    }

    /// `ksx device scan` — the SAME enumeration [`Self::devices`] returns,
    /// grouped into the physical boards a person picks from, with the
    /// `[[device]]` entries that are configured against them.
    ///
    /// It exists beside `devices` for the reason `crates/ksx-backend/src/
    /// device_scan.rs` opens with: one interface per row is the right shape
    /// for diagnosing a backend and the wrong shape for CHOOSING. On the
    /// a representative multi-device setup can expose many interfaces, three
    /// of which belong to one I-PAC. A picker that offered those three would ask the user to
    /// know which `MI_` number carries the keys.
    ///
    /// Read-only and safe mid-session, exactly like `devices`: it enumerates
    /// and describes. Nothing is opened, claimed or written.
    fn device_scan(&self) -> Result<DeviceScanView, Refusal> {
        Err(Refusal::not_here(
            "grouping the devices into boards",
            "run `ksx device scan`",
        ))
    }

    /// `ksx panel status` — passive encoder identity and HID capabilities.
    ///
    /// This read opens HID metadata handles with desired access zero and sends
    /// no input, output, or feature report. Exact vendor mode and EEPROM chart
    /// reads remain explicit unsupported/unverified states in the returned
    /// view; a surface must not infer them from USB topology.
    fn panel_status(&self, _spec: &PanelStatusSpec) -> Result<PanelStatusView, Refusal> {
        Err(Refusal::not_here(
            "inspecting panel encoder capabilities",
            "run `ksx panel status`",
        ))
    }

    /// `ksx panel chart` — explicitly read one supported encoder's complete
    /// configuration image and decode the terminal assignments KSX knows.
    ///
    /// This is deliberately separate from [`Self::panel_status`]. Status is a
    /// desired-access-zero inventory read; chart inspection performs the
    /// vendor report transaction the user requested and therefore remains an
    /// on-demand action on every surface.
    fn panel_chart(&self, _spec: &PanelChartSpec) -> Result<PanelChartView, Refusal> {
        Err(Refusal::not_here(
            "reading the panel encoder chart",
            "run `ksx panel chart`",
        ))
    }

    /// `ksx panel backups` — immutable, lossless hardware restore points for
    /// the selected physical encoder. Raw images stay in the backend store;
    /// this view exposes identity and hashes, never EEPROM bytes.
    fn panel_backups(&self, _spec: &PanelBackupsSpec) -> Result<PanelBackupsView, Refusal> {
        Err(Refusal::not_here(
            "listing panel encoder backups",
            "run `ksx panel backups`",
        ))
    }

    /// List portable, complete semantic hardware layouts saved by KSX.
    ///
    /// These are deliberately not raw EEPROM recovery images. A hardware
    /// layout can be renamed, copied to another supported I-PAC and edited by
    /// a surface; the raw transaction journal remains machine/board-bound.
    fn panel_hardware_profiles(&self) -> Result<PanelHardwareProfilesView, Refusal> {
        Err(Refusal::not_here(
            "listing saved encoder layouts",
            "open Encoder setup in KSX Studio",
        ))
    }

    /// Create or update one complete portable encoder layout. Updates carry
    /// the revision returned by [`Self::panel_hardware_profiles`] so an older
    /// editor cannot overwrite a newer save.
    fn panel_hardware_profile_save(
        &self,
        _spec: &PanelHardwareProfileSaveSpec,
    ) -> Result<PanelHardwareProfileMutationView, Refusal> {
        Err(Refusal::not_here(
            "saving an encoder layout",
            "open Encoder setup in KSX Studio",
        ))
    }

    /// Delete one saved portable layout. This never clears or otherwise
    /// changes the physical encoder; hardware programming is a separate,
    /// reviewed [`Self::panel_program`] transaction.
    fn panel_hardware_profile_delete(
        &self,
        _spec: &PanelHardwareProfileDeleteSpec,
    ) -> Result<PanelHardwareProfileMutationView, Refusal> {
        Err(Refusal::not_here(
            "deleting a saved encoder layout",
            "open Encoder setup in KSX Studio",
        ))
    }

    /// Read-only `ksx panel program` planning. It explicitly reads the current
    /// chart, but sends no write report and creates no backup. The returned
    /// identity, profile, and hashes are the stale-write contract the apply
    /// call must prove again immediately before packet zero.
    fn panel_program_plan(
        &self,
        _spec: &PanelProgramSpec,
    ) -> Result<PanelProgramPlanView, Refusal> {
        Err(Refusal::not_here(
            "planning a panel encoder change",
            "run `ksx panel program` without `--yes`",
        ))
    }

    /// Confirmed `ksx panel program --yes` transaction: re-read, stale-hash
    /// guard, durable lossless backup, write, complete readback, byte verify.
    fn panel_program(&self, _spec: &PanelProgramApplySpec) -> Result<PanelProgramOutcome, Refusal> {
        Err(Refusal::not_here(
            "programming the panel encoder",
            "run `ksx panel program --yes`",
        ))
    }

    /// Read-only reverse diff for one immutable hardware backup. Planning
    /// explicitly reads the current chart but sends no write report.
    fn panel_restore_plan(
        &self,
        _spec: &PanelRestoreSpec,
    ) -> Result<PanelProgramPlanView, Refusal> {
        Err(Refusal::not_here(
            "planning a panel encoder restore",
            "run `ksx panel restore` without `--yes`",
        ))
    }

    /// Confirmed restore. The current chart is itself backed up before the
    /// older image is written, and success still requires full readback.
    fn panel_restore(&self, _spec: &PanelRestoreApplySpec) -> Result<PanelProgramOutcome, Refusal> {
        Err(Refusal::not_here(
            "restoring the panel encoder",
            "run `ksx panel restore --yes`",
        ))
    }

    /// Resolve one physical key observation from the daemon learner through
    /// the same board inventory as [`Self::device_scan`], and return the exact
    /// served values a subsequent [`Self::device_pick`] would use.
    ///
    /// The caller obtains `observed_instance` through the control source's
    /// daemon-owned learner. That ownership is load-bearing on Windows: a
    /// prepared panel can already be exclusively claimed by the daemon and a
    /// second local observer cannot hear it. Resolution itself remains
    /// observational: it does not suppress the key, capture the keyboard,
    /// write configuration, or start a session. A surface may use the result
    /// as the explicit human selection in its ordinary staging flow; the
    /// stage writer remains the authority for that mutation.
    fn device_identify(&self, _observed_instance: &str) -> Result<DeviceIdentifyView, Refusal> {
        Err(Refusal::not_here(
            "identifying a keyboard by key press",
            "run `ksx setup`",
        ))
    }

    /// `ksx device pick` — write the `[[device]]` entry for one board.
    ///
    /// Not a claim, and the distinction is load-bearing
    /// (`docs/DEVICE-IDENTITY.md` §7): this writes four lines of TOML and
    /// stops. Taking the board off the Windows keyboard stack is
    /// [`Self::winusb_claim`], which needs elevation and a separate `--yes`.
    /// A surface that renders "picked" as "claimed" produces a user who
    /// discovers otherwise mid-game.
    fn device_pick(&self, _spec: &DevicePickSpec) -> Result<DevicePickView, Refusal> {
        Err(Refusal::not_here(
            "writing a [[device]] entry",
            "run `ksx device pick <ID>`",
        ))
    }

    /// `ksx device remove` — delete one `[[device]]` entry.
    ///
    /// The narrowest of the three removals ksx has, and the three must never be
    /// confused: `ksx pads --prune` drops stale VIRTUAL PADS off the ViGEm bus,
    /// `ksx winusb release` puts a claimed board BACK on the keyboard stack,
    /// and this forgets a config entry. Deleting the entry releases nothing —
    /// which is why [`DeviceRemoveView::still_claimed`] exists.
    fn device_remove(&self, _spec: &DeviceRemoveSpec) -> Result<DeviceRemoveView, Refusal> {
        Err(Refusal::not_here(
            "deleting a [[device]] entry",
            "run `ksx device remove <ALIAS>`",
        ))
    }

    /// `ksx preset list [--templates]` — the presets on disk and the templates
    /// a new one can be seeded from.
    fn presets(&self) -> Result<PresetsView, Refusal> {
        Err(Refusal::not_here(
            "listing presets",
            "run `ksx preset list`",
        ))
    }

    /// The `[[game]]` profiles in games.toml, **with the launch preflight
    /// already run**.
    ///
    /// That last clause is the whole reason this is not just
    /// [`StatusSnapshot::profiles`](crate::status::StatusSnapshot::profiles),
    /// which carries a title and a composed line and nothing a surface can
    /// branch on. `ksx_games::preflight` has always been able to say "that
    /// .exe is not there" — it just ran at LAUNCH time, so a profile pointing
    /// at a moved emulator looked perfectly healthy in every list until the
    /// moment someone tried to play. Running the same check on the read side
    /// costs one `is_file()` per row and turns a mystery into a row with the
    /// wrong path printed on it.
    fn profiles(&self) -> Result<ProfilesView, Refusal> {
        Err(Refusal::not_here(
            "listing games.toml profiles",
            "run `ksx config export --what games`",
        ))
    }

    /// Add a game profile.
    ///
    /// There is no equivalent CLI verb, so an implementation-free provider
    /// points to profile management without assuming which consumer called it.
    fn profile_new(&self, _spec: &NewProfile) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "creating a game profile",
            "use a ksx surface that supports profile management",
        ))
    }

    /// Update one game profile, identified by its title before the edit.
    ///
    /// `original_title` makes renames unambiguous. Device selectors are kept
    /// by default; [`UpdateProfile::rebase_devices`] is the explicit request
    /// to take them from the machine's current controller setup instead.
    fn profile_update(&self, _spec: &UpdateProfile) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "updating a game profile",
            "use a ksx surface that supports profile management",
        ))
    }

    /// Delete exactly one game profile. Presets and the base controller setup
    /// are separate resources and are never implied by this request.
    fn profile_delete(&self, _spec: &DeleteProfile) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "deleting a game profile",
            "use a ksx surface that supports profile management",
        ))
    }

    /// `ksx preset new <NAME> --from-template <ID>` — one atomic write that
    /// turns an in-box template into an ordinary, editable preset file.
    fn preset_new(&self, _spec: &NewPreset) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "creating a preset",
            "run `ksx preset new \"<NAME>\" --from-template <ID>`",
        ))
    }

    /// `ksx preset rename <FROM> <TO>` — the file AND every slot naming it.
    fn preset_rename(&self, _spec: &RenamePreset) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "renaming a preset",
            "run `ksx preset rename \"<FROM>\" \"<TO>\"`",
        ))
    }

    /// `ksx preset delete <NAME>` — refused while slots still name it.
    fn preset_delete(&self, _spec: &DeletePreset) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "deleting a preset",
            "run `ksx preset delete \"<NAME>\"`",
        ))
    }

    /// `ksx autostart --status` — the logon-task registration.
    fn autostart(&self) -> Result<AutostartView, Refusal> {
        Err(Refusal::not_here(
            "reading the autostart registration",
            "run `ksx autostart --status`",
        ))
    }

    /// **Register or remove the logon task.**
    ///
    /// The one machine-lifecycle write that belongs on a surface other than
    /// the CLI, and the reason is `FIRST-RUN.md`: a cabinet that does not come
    /// up on its own is not commissioned, and the flow that commissions it
    /// promises no terminal. `parity.rs` used to exempt this verb as "not
    /// something anyone performs while ksx runs" - true of a running ksx,
    /// false of the ten minutes in which somebody is setting one up.
    ///
    /// Registers a PER-USER task. No elevation, no service, nothing outside
    /// the signed-in account - which is what makes it safe to reach from the
    /// same page that staged the controllers, unlike the WinUSB verbs above.
    fn set_autostart(&self, _spec: &AutostartSpec) -> Result<AutostartView, Refusal> {
        Err(Refusal::not_here(
            "changing the autostart registration",
            "run `ksx autostart --enable`",
        ))
    }

    /// **Change split-or-freeze on a saved config.**
    ///
    /// A whole-config write, so it takes the same backup discipline every other
    /// config writer here takes. Returns what is on disk AFTER the write, plus
    /// whether a session is live - the daemon reads settings at start, so a
    /// running game keeps the old answer until it is restarted.
    /// `session_running` is a parameter rather than something this trait
    /// reads, for the reason `pads_view` takes it: whether a game is live is a
    /// `ControlSource` fact, and a machine provider that guessed at it would be
    /// a second, quietly disagreeing answer.
    fn set_blocking(
        &self,
        _spec: &BlockingSpec,
        _session_running: bool,
    ) -> Result<BlockingView, Refusal> {
        Err(Refusal::not_here(
            "changing split-or-freeze",
            "answer it again on the first-run screen",
        ))
    }

    /// **Remember the Studio's theme choice on a saved config.**
    ///
    /// A whole-config write, so it takes the same backup discipline every
    /// other config writer here takes and returns what is on disk AFTER the
    /// write. Unlike [`Self::set_blocking`] there is no session caveat: the
    /// theme is read per page render, never by the daemon.
    fn set_theme(&self, _spec: &ThemeSpec) -> Result<ThemeView, Refusal> {
        Err(Refusal::not_here(
            "remembering a theme choice",
            "pick it on the Studio's configuration page",
        ))
    }

    /// **What ksx left behind**, compared against what Windows reports.
    ///
    /// Read-only: reads the receipt store, the device tree and the driver
    /// store, and changes none of them. `ksx winusb repair --dry-run` is the
    /// same read; this exists so it is not the only way to see it.
    fn winusb_residue(&self) -> Result<WinusbResidueView, Refusal> {
        Err(Refusal::not_here(
            "what ksx left behind on this machine",
            "run `ksx winusb repair --dry-run`",
        ))
    }

    /// Remove only KSX signing certificates that no installed driver package
    /// depends on, plus stranded KSX one-time signing-key containers.
    ///
    /// This is a machine trust-store write, so the explicit confirmation is
    /// part of the typed request and an implementation may elevate only the
    /// installed fixed-purpose helper. The returned residue view is a fresh
    /// post-operation read; a surface must not infer success from the helper's
    /// exit code or output.
    fn winusb_sweep_certificates(
        &self,
        _spec: &WinusbCertificateSweepSpec,
    ) -> Result<WinusbResidueView, Refusal> {
        Err(Refusal::not_here(
            "removing leftover KSX signing certificates",
            "use the installed KSX application, or run `ksx winusb sweep-certificates --yes` and approve its Windows permission prompt",
        ))
    }

    /// `ksx doctor` — driver health plus advice, with the stable codes.
    fn doctor(&self) -> Result<DoctorView, Refusal> {
        Err(Refusal::not_here("the driver report", "run `ksx doctor`"))
    }

    /// **Can the currently staged controller personas be materialized?**
    ///
    /// This is deliberately persona-aware. Xbox 360 and PlayStation slots
    /// require ViGEmBus; DualSense requires HIDMaestro; an empty stage requires
    /// neither. A universal "pad bus" check is wrong in both directions: it
    /// warns a DualSense-only setup about a bus it never uses and paints a
    /// green ViGEmBus result over a missing HIDMaestro package.
    ///
    /// The provider probes only the backends named by supported personas in
    /// `staged`. The returned rows keep a machine prerequisite separate from a
    /// runtime promise: HIDMaestro's exact package can be proved here, while
    /// its protected host and controller endpoint are verified only when Play
    /// starts. Read-only; no driver is installed or controller plugged.
    fn controller_outputs(
        &self,
        _staged: &crate::StagedSetupView,
    ) -> Result<ControllerOutputsView, Refusal> {
        Err(Refusal::not_here(
            "the controller-output state",
            "run `ksx doctor`",
        ))
    }

    /// `ksx winusb status` — read-only; nothing is opened or claimed.
    fn winusb(&self) -> Result<WinusbView, Refusal> {
        Err(Refusal::not_here(
            "the WinUSB survey",
            "run `ksx winusb status`",
        ))
    }

    /// `ksx pads` / `ksx pads --prune`, as a page can read them: what is on
    /// the bus, what would be removed, and what a spawn may legally offer.
    ///
    /// Read-only. Everything a surface needs to decide *before* a click —
    /// including the XInput ceiling stated in words — arrives here, so no
    /// surface has to know that four is the number (docs/SURFACES.md §1).
    ///
    /// **`session_running` is an input, not something this re-reads.** Both
    /// pad verbs refuse while emulation is live, so the answer appears twice
    /// on one screen: in the header pill and in the spawn panel's refusal. A
    /// second daemon round-trip inside this call would make those two reads
    /// separate points in time, and a session that starts between them paints
    /// "idle" beside "a session is running". One read, one render.
    fn pads_view(&self, _session_running: bool) -> Result<PadsView, Refusal> {
        Err(Refusal::not_here(
            "the virtual-pad report",
            "run `ksx pads --prune` (a dry run) or `ksx doctor`",
        ))
    }

    /// `ksx pads` — plug N test pads, run the pattern, unplug.
    ///
    /// Defaulted-refused, and the default is still the honest answer for any
    /// surface that has not thought about the two things the CLI carried
    /// implicitly: test pads COMPETE for the four XInput slots, so this is
    /// only ever legal while emulation is stopped, and the Ctrl+C that ends a
    /// console run does not exist on a web page. An implementation owes both —
    /// a refusal while a session is live, and a bounded hold that unplugs
    /// itself — which is why the spec carries [`PadsSpawnSpec::hold_secs`]
    /// rather than leaving "how does this end" to the caller.
    fn pads(&self, _spec: &PadsSpawnSpec) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "the pad test",
            "run `ksx pads --count 4` with emulation stopped",
        ))
    }

    /// `ksx pads --prune` — clear pads that outlived whatever made them.
    ///
    /// `confirm` is the CLI's `--yes`, and it means the same thing: without it
    /// this is a DRY RUN that only says what it would do. The dry-run-first
    /// consent shape is not the surface's to choose — a verb that restarts a
    /// bus device and drops every pad on it keeps it wherever it is called
    /// from.
    ///
    /// Restarting a bus devnode needs an administrator token and ksx never
    /// self-elevates, so an implementation running unelevated must REFUSE in
    /// words with the command to run instead — never silently do nothing.
    /// [`PadsView::elevated`] is how a page says that before the click.
    fn pads_prune(&self, _confirm: bool) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "clearing the bus",
            "run `ksx pads --prune` (a dry run) and then `--yes` from an elevated prompt",
        ))
    }

    /// `ksx winusb claim` — takes a keyboard OUT of the keyboard stack.
    ///
    /// Defaulted-refused deliberately, and this one is not a scheduling
    /// concern: the worst case is a panel that no longer types and a user who
    /// cannot type the command to undo it. It is a dry run by default, needs
    /// `--yes` AND elevation, and CONTROL-SURFACE keeps it local on purpose.
    fn winusb_claim(&self, _device: &str) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "claiming a panel for WinUSB",
            "run `ksx winusb claim <ID>` (a dry run) and then `--yes` from an elevated prompt",
        ))
    }

    /// Prepare one exact, live USB interface for WinUSB through the installed
    /// elevated helper.  The typed selector is a stale-action guard and the
    /// instance id is never resolved by substring.
    fn winusb_prepare(&self, _spec: &WinusbPrepareSpec) -> Result<WinusbMutationView, Refusal> {
        Err(Refusal::not_here(
            "preparing a panel for WinUSB",
            "use the installed ksx application, or run `ksx winusb claim <ID>` from an elevated prompt",
        ))
    }

    /// Put one KSX-owned WinUSB preparation back on the keyboard stack.
    fn winusb_release(&self, _spec: &WinusbReleaseSpec) -> Result<WinusbMutationView, Refusal> {
        Err(Refusal::not_here(
            "releasing a panel back to the keyboard stack",
            "use the installed ksx application, or run `ksx winusb release <ID>` from an elevated prompt",
        ))
    }

    /// The first-run state: what the config root already holds, and which of
    /// the onboarding steps is next.
    ///
    /// The STEPS are part of the answer on purpose. "Which step comes next" is
    /// a decision about configuration, and docs/SURFACES.md §1 puts decisions
    /// in the backend — a surface that worked it out from the rows would be a
    /// second, silently diverging copy of the rule the moment a fifth step
    /// exists.
    fn setup_state(&self) -> Result<SetupView, Refusal> {
        Err(Refusal::not_here(
            "reading the first-run state",
            "run `ksx setup`",
        ))
    }

    /// `ksx config export` — the config root as ONE interop JSON document,
    /// **in memory**.
    ///
    /// Deliberately not a path. The CLI's export writes to stdout or to a file
    /// because that is what a shell can consume; a surface that offers the user
    /// a DOWNLOAD needs the bytes, and giving it a path instead would put the
    /// filesystem back in front of a person who asked for a file (which is the
    /// whole reason `/setup` exists). Same `ksx_config::interop` machinery
    /// underneath either way — there is no second serializer.
    fn config_export(&self, _request: &ExportRequest) -> Result<ConfigExport, Refusal> {
        Err(Refusal::not_here(
            "exporting the configuration",
            "run `ksx config export`",
        ))
    }

    /// `ksx config import` — a document in, **dry run unless
    /// [`ImportRequest::apply`]**.
    ///
    /// The consent shape is load-bearing and is the CLI's, unchanged
    /// (`ksx-backend/src/config_io.rs`): a first call reports exactly which files
    /// it would create and which it would overwrite, every overwrite leaves a
    /// timestamped `.bak`, and validation faults refuse the write unless
    /// [`ImportRequest::force`] says otherwise. A surface may not skip the dry
    /// run — replacing a cabinet's whole configuration is not a thing to do on
    /// one click.
    fn config_import(&self, _request: &ImportRequest) -> Result<ImportReport, Refusal> {
        Err(Refusal::not_here(
            "importing a configuration",
            "run `ksx config import`",
        ))
    }

    /// Get ksx Studio on screen — start it if nothing is listening, wait for
    /// the port to answer, then hand the URL to the shell.
    ///
    /// Returns the URL, so a surface that cannot open a browser (a cabinet on a
    /// 10-foot screen with no pointer, a phone across the room) can still
    /// *display* it. That is the whole reason this returns a string rather than
    /// `()`: on a cabinet the useful outcome is often "type this on your
    /// phone", not "a window appeared".
    ///
    /// The implementation must never open a browser before the port answers —
    /// `docs/M9-DECISION.md` §4: *it must never be possible to reach
    /// `ERR_CONNECTION_REFUSED` by clicking a ksx shortcut.* A menu item that
    /// opens a browser at a dead port has not opened Studio; it has produced an
    /// error page with ksx's name on it.
    fn open_studio(&self) -> Result<String, Refusal> {
        Err(Refusal::not_here(
            "opening ksx Studio",
            "run `ksx studio` and browse to the address it prints",
        ))
    }
}

/// `ksx devices`, presentation-shaped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesView {
    pub generated_at: String,
    /// Keyboards the Interception driver sees, in slot order.
    pub keyboards: Vec<KeyboardRow>,
    /// Was the Interception driver available at all? `false` is the EXPECTED
    /// end state after M6, not a failure.
    pub interception_available: bool,
    /// **Every input devnode, on every transport ksx models** — HID-class USB
    /// interfaces and Bluetooth device nodes in one list.
    ///
    /// The field keeps its wire name because it has always been the device
    /// list; what changed is that it is no longer only USB. [`UsbRow::transport`]
    /// says which, and nothing downstream may infer a transport from anything
    /// else. Before the Bluetooth pass existed this list came from
    /// `nusb::list_devices()` alone, so a Bluetooth keyboard simply did not
    /// appear — the user was told, in effect, that their keyboard did not exist.
    pub usb: Vec<UsbRow>,
    /// Was USB enumeration possible?
    pub usb_available: bool,
    /// Was Bluetooth enumeration possible?
    ///
    /// A separate flag from [`Self::usb_available`] because they are separate
    /// reads and either can fail alone. Collapsing them would let a failed
    /// Bluetooth walk hide behind a successful USB one and print a list that
    /// silently omits half the machine — "I could not read this" and "there is
    /// nothing here" are different sentences.
    #[serde(default)]
    pub bluetooth_available: bool,
    /// Anything the report has to say out loud (both backends missing, an
    /// enumeration that failed) — rendered, never swallowed.
    pub notes: Vec<String>,
}

/// One passive `ksx panel status` request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelStatusSpec {
    /// Optional case-insensitive exact id/name/alias, or a unique substring.
    /// `None` lists every physical USB board; it never selects the first one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

/// `ksx panel status`, presentation-shaped for every surface.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelStatusView {
    pub generated_at: String,
    /// Backend-composed headline; surfaces copy it verbatim.
    pub summary: String,
    /// The safety boundary stated in words: metadata-only, no reports sent.
    pub inspection_note: String,
    /// Backend-composed availability line; surfaces keep the booleans for
    /// branching but never translate their combinations into user prose.
    pub access_detail: String,
    /// Did the ordinary USB enumeration complete?
    pub usb_available: bool,
    /// Did SetupAPI return a present HID collection set?
    pub hid_available: bool,
    /// One row per physical USB board. An optional request filters this list
    /// only after exact/unique resolution; it never picks an arbitrary row.
    pub panels: Vec<PanelStatusRow>,
    /// Enumeration-level failures and conservative interpretation notes.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// One physical USB board and every interface/collection joined to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelStatusRow {
    pub board_id: String,
    pub name: String,
    /// Backend-composed VID/PID/release identity line.
    pub identity: String,
    pub vendor_id: u16,
    pub product_id: u16,
    /// Raw USB `bcdDevice`; never presented as a parsed firmware version.
    pub bcd_device: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Protocol driver id, or `unsupported` when no driver is registered.
    pub driver: String,
    pub driver_supported: bool,
    pub driver_label: String,
    /// `keyboard-compatible` | `unknown`.
    pub observed_mode: String,
    pub mode_detail: String,
    pub observed_mode_label: String,
    /// False in v1: topology is observed, no vendor mode query is issued.
    pub mode_read_supported: bool,
    /// `protocol-unverified` | `unsupported-driver`.
    pub chart_state: String,
    /// Always false in v1. Kept explicit so absence cannot look like an empty
    /// chart returned by hardware.
    pub chart_attempted: bool,
    pub chart_detail: String,
    pub chart_label: String,
    /// `candidate-unverified` | `not-found` | `ambiguous` | `unavailable` |
    /// `unsupported-driver`.
    pub configuration_collection_state: String,
    /// The unique passive 5-byte IN/OUT candidate, when exactly one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_collection: Option<String>,
    pub configuration_collection_detail: String,
    /// One backend-composed next-step sentence; a surface does not interpret
    /// protocol or topology codes to invent advice.
    pub recommendation: String,
    pub interfaces: Vec<PanelInterfaceRow>,
    pub hid_collections: Vec<PanelHidCollectionRow>,
}

/// One USB interface descriptor belonging to a physical board.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelInterfaceRow {
    pub instance_id: String,
    pub interface_number: u8,
    pub interface_class: u8,
    pub interface_subclass: u8,
    pub interface_protocol: u8,
    pub binding: String,
    pub boot_keyboard: bool,
    pub description: String,
}

/// Passive metadata for one HID top-level collection.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHidCollectionRow {
    pub instance_id: String,
    /// `available` | `partial` | `unavailable`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<u16>,
    /// Raw HID `VersionNumber`; not interpreted as firmware.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_number: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_page: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_report_bytes: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_report_bytes: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_report_bytes: Option<u16>,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// An explicit complete-chart read request. `backup` is a local, immutable
/// restore point; it never alters the encoder.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelChartSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default)]
    pub backup: bool,
}

/// One key/action value decoded from the board image.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelKeyValue {
    /// Raw vendor action byte. Keeping it visible makes unknown values honest.
    pub code: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub label: String,
    pub supported: bool,
}

/// Decoded state of a terminal's shift-control byte.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PanelShiftState {
    Disabled,
    Enabled,
    /// The raw byte is preserved but is not a known enabled/disabled value.
    #[default]
    Opaque,
}

/// One physical screw terminal in the supported encoder's chart.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelTerminalRow {
    /// Stable hardware spelling, for example `1sw4`.
    pub terminal_id: String,
    pub terminal_label: String,
    pub player: u8,
    /// `direction` | `button` | `start` | `coin`.
    pub kind: String,
    pub normal: PanelKeyValue,
    pub shifted: PanelKeyValue,
    /// Lossless semantic state of the terminal's shift-control byte.
    /// `is_shift == false` alone does not mean disabled: opaque values are
    /// also false for that compatibility/display convenience field.
    #[serde(default)]
    pub shift_state: PanelShiftState,
    /// Compatibility/display convenience. Mutation safety must use
    /// `shift_state` and require `disabled` explicitly.
    pub is_shift: bool,
}

/// One keyboard action KSX can both program and observe through its capture
/// vocabulary. The backend owns this list; Studio must not invent key bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelKeyOption {
    pub key: String,
    pub label: String,
    pub code: u16,
    /// True only for the deliberately inert first-write test vocabulary.
    /// Full-chart programming may use every served option after qualification.
    #[serde(default)]
    pub safe_for_qualification: bool,
}

/// Metadata for a durable raw-image backup. The bytes and filesystem path are
/// intentionally absent from the surface contract.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelBackupRow {
    pub backup_id: String,
    pub label: String,
    pub created_at: String,
    pub board_fingerprint: String,
    pub image_sha256: String,
    pub image_bytes: usize,
    pub reason: String,
}

/// A complete successful chart read, decoded without surrendering the raw
/// image's authority. `programming_state` is `supervised`, `write-locked`, or
/// `recovery-required`; a surface presents that state and never guesses around
/// it. Writer qualification is separate from physical Teach: it proves this
/// pinned EEPROM transport can write, read back and restore one harmless test
/// assignment before a full chart is admitted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelChartView {
    pub generated_at: String,
    pub summary: String,
    pub board_id: String,
    pub board_name: String,
    pub board_fingerprint: String,
    pub driver: String,
    /// Versioned transport/image contract that admitted this exact board.
    /// Apply and restore must echo it instead of trusting a stale selector.
    pub protocol_profile: String,
    pub image_sha256: String,
    pub image_bytes: usize,
    pub programming_state: String,
    pub programming_detail: String,
    /// First-live-write safety gate: `required`, `validation-written`,
    /// `validation-recovery`, or `qualified`. A board is qualified only after
    /// one normal-terminal write and a verified restore of that transaction's
    /// exact safety backup. An interrupted test restore returns to `required`;
    /// full-chart layouts remain blocked until a clean round trip completes.
    pub qualification_state: String,
    pub qualification_detail: String,
    /// Exact restore point that completes `validation-written`, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_restore_backup_id: Option<String>,
    pub terminals: Vec<PanelTerminalRow>,
    /// Backend-owned semantic preview of the deterministic four-player KSX
    /// layout against this exact chart baseline. This is display/draft data,
    /// not write authority: applying it still requires the ordinary reviewed
    /// program plan bound to `image_sha256`. Opaque baseline shift bytes stay
    /// opaque rather than being normalized by the preview.
    #[serde(default)]
    pub recommended_terminals: Vec<PanelTerminalRow>,
    pub key_options: Vec<PanelKeyOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<PanelBackupRow>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelBackupsSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelBackupsView {
    pub summary: String,
    pub board_fingerprint: String,
    pub backups: Vec<PanelBackupRow>,
}

/// One portable semantic assignment in a complete hardware layout.
///
/// `None` means Unassigned. Opaque vendor bytes cannot be represented here:
/// they remain available only in the immutable raw recovery store. A profile
/// contains exactly one row for every terminal in its `terminal_signature`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareTerminal {
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shifted_key: Option<String>,
    #[serde(default)]
    pub is_shift: bool,
    /// Repeated assignments are accepted only when every participant carries
    /// this explicit acknowledgement.
    #[serde(default)]
    pub allow_shared_key: bool,
}

/// A complete, portable I-PAC hardware layout owned by KSX.
///
/// Recovery images are intentionally a different type and store. This model
/// carries only actions KSX can both program and observe, so it is safe to
/// edit and apply to any board admitted by the same driver/profile/signature.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareProfile {
    pub schema: String,
    pub profile_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub driver: String,
    pub protocol_profile: String,
    /// Hash of the ordered physical-terminal vocabulary for this driver.
    pub terminal_signature: String,
    /// Opaque content revision used by update/delete stale-write guards.
    pub revision: String,
    pub created_at: String,
    pub updated_at: String,
    pub terminals: Vec<PanelHardwareTerminal>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareProfilesView {
    pub summary: String,
    pub config_root: String,
    pub terminal_signature: String,
    pub profiles: Vec<PanelHardwareProfile>,
}

/// Create when both identity fields are absent; update when both are present.
/// The backend owns file ids, schema/profile metadata, timestamps and revision.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareProfileSaveSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub terminals: Vec<PanelHardwareTerminal>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareProfileDeleteSpec {
    pub profile_id: String,
    pub expected_revision: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelHardwareProfileMutationView {
    /// `created` | `updated` | `unchanged` | `deleted`.
    pub state: String,
    pub summary: String,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<PanelHardwareProfile>,
}

/// One semantic terminal edit. An absent field is unchanged; an empty key
/// spelling clears that action. The backend rejects any non-canonical key.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelTerminalEdit {
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shifted_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_shift: Option<bool>,
    /// A repeated key on separate physical terminals is rejected unless every
    /// participating edit marks that fan-in as deliberate. Mirrors collapse
    /// to one terminal edit and never need this flag.
    #[serde(default)]
    pub allow_shared_key: bool,
}

/// Pure program-plan input. `layout` is `custom`, `blank`, or
/// `canonical-four-player`; both complete layouts are allocated by the
/// backend against the live baseline so opaque vendor bytes remain untouched.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelProgramSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub expected_base_sha256: String,
    pub layout: String,
    #[serde(default)]
    pub edits: Vec<PanelTerminalEdit>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelTerminalDiffRow {
    pub terminal_id: String,
    pub terminal_label: String,
    pub layer: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelByteDiffRow {
    pub offset: usize,
    pub before: u16,
    pub after: u16,
    pub meaning: String,
}

/// Exact review model for program and restore. It contains changed bytes, not
/// an arbitrary raw image a browser could replay.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelProgramPlanView {
    pub summary: String,
    pub board_id: String,
    pub board_name: String,
    pub board_fingerprint: String,
    /// Versioned transport/image contract used to read and plan this image.
    pub protocol_profile: String,
    pub base_sha256: String,
    pub desired_sha256: String,
    pub image_bytes: usize,
    pub terminal_diff: Vec<PanelTerminalDiffRow>,
    pub byte_diff: Vec<PanelByteDiffRow>,
    pub preserved_byte_count: usize,
    pub confirmation: String,
    #[serde(default)]
    pub blockers: Vec<String>,
}

/// Confirmed apply request. The backend recomputes the desired image from the
/// semantic plan and proves both hashes; it never accepts raw report bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelProgramApplySpec {
    pub program: PanelProgramSpec,
    pub expected_desired_sha256: String,
    /// Exact physical-board identity printed by the reviewed plan.
    pub expected_board_fingerprint: String,
    /// Exact protocol/image profile printed by the reviewed plan.
    pub expected_protocol_profile: String,
    #[serde(default)]
    pub confirm: bool,
    /// Explicit acknowledgement that this remains a supervised persistent
    /// hardware write even after identity, profile, and hash checks pass.
    #[serde(default)]
    pub supervised: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelRestoreSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    pub backup_id: String,
    pub expected_current_sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelRestoreApplySpec {
    pub restore: PanelRestoreSpec,
    pub expected_desired_sha256: String,
    /// Exact physical-board identity printed by the reviewed restore plan.
    pub expected_board_fingerprint: String,
    /// Exact protocol/image profile printed by the reviewed restore plan.
    pub expected_protocol_profile: String,
    #[serde(default)]
    pub confirm: bool,
    /// Explicit acknowledgement that this remains a supervised persistent
    /// hardware write even when restoring a known-good backup.
    #[serde(default)]
    pub supervised: bool,
}

/// The only successful mutation result is `verified`. If packet delivery
/// completed but readback did not match, state is `recovery-required` and the
/// durable backup remains the road home.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelProgramOutcome {
    pub state: String,
    pub summary: String,
    pub board_fingerprint: String,
    pub expected_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_sha256: Option<String>,
    pub backup: PanelBackupRow,
    pub verified_at: String,
    pub next_step: String,
}

/// One keyboard the capture layer can see.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyboardRow {
    /// Interception's slot number — the id `[[device]]` entries name.
    pub slot: u16,
    /// The hardware id, as config matching spells it.
    pub hardware_id: String,
    /// The `[[device]]` alias bound to it, if any.
    pub alias: Option<String>,
    /// `interception` | `winusb` — which backend config asks for.
    pub backend: String,
    /// Composed human line (make/model where known, the duplicate-id warning
    /// where it applies).
    pub detail: String,
}

/// One devnode in the unified device list — a USB interface or a Bluetooth
/// device node.
///
/// Named `UsbRow` from when this list was USB-only. [`Self::transport`] is the
/// field that says what a row actually is, and every consumer reads it rather
/// than assuming: a Bluetooth row is not a defective USB row, it is a device on
/// a different transport with a different, permanent answer about backends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsbRow {
    /// The instance id, uppercased — the string a `[[device]] id` holds.
    pub instance_id: String,
    pub description: String,
    /// `usb` | `bluetooth` — [`ksx_core::Transport::code`].
    ///
    /// The one field that must never be inferred from another. A row's
    /// enumerator prefix, its vendor id and its description are all things a
    /// surface could squint at; the collector already knows, so it says.
    #[serde(default)]
    pub transport: String,
    /// `claimed` | `claimable` | `not-a-keyboard` | `foreign-driver`.
    pub state: String,
    /// The one sentence that says what that means for ksx.
    pub verdict: String,
    /// The `[[device]]` alias bound to this id, if any.
    pub alias: Option<String>,
    /// A `[[device]]` entry selects `backend = "winusb"` for it.
    pub selected: bool,
    /// Selected AND rebound — `ksx run` will capture it.
    pub ready: bool,
    /// The board's name, when ksx recognises the VID/PID
    /// (`ksx_core::vendors`). `None` is the normal answer and not a failure —
    /// most devices are not in the table, and [`Self::description`] carries
    /// what the device says about itself.
    ///
    /// Display only, always: `docs/DEVICE-IDENTITY.md` §6 is explicit that no
    /// capture, claim or refusal path may branch on a vendor id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// The physical board this interface belongs to.
    ///
    /// One I-PAC exposes three interfaces (`MI_00`/`01`/`02`); they are one
    /// device to a human and three devnodes to Windows. Grouping by this is
    /// what lets a picker say "I-PAC 4X — 3 interfaces, keyboard on MI_00"
    /// instead of listing three cryptic paths and asking the user to guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    /// Does this interface declare the HID **boot keyboard** protocol?
    ///
    /// The difference between "ksx could claim this" and "this is a keyboard",
    /// and a picker needs both. `state == "claimable"` is deliberately
    /// generous — it means "it is HID", because a rebound interface stops
    /// describing itself as a keyboard and plenty of NKRO firmware reports
    /// protocol 0, so guessing harder there would produce confident wrong
    /// answers. The real proof is the report descriptor at claim time.
    ///
    /// The cost of that generosity shows up the moment you render a MENU: on
    /// a representative setup can contain a mouse, an LED controller, a fan controller and
    /// a USB audio device all have HID interfaces and all read as claimable.
    /// This flag is the honest positive signal — set, it is very probably a
    /// keyboard; unset, it might still be one, and only claiming proves it.
    #[serde(default)]
    pub boot_keyboard: bool,
    /// The `[[device]] id` `ksx device pick` **would** write for this interface
    /// — the weakest rung that still names it alone, chosen against everything
    /// else connected in the same pass.
    ///
    /// Computed in the backend, exactly once, by the same
    /// `DeviceSelector::strongest_for` call the writer makes
    /// (`docs/SURFACES.md` §1: a surface renders a result, it does not re-derive
    /// one). Two surfaces cannot therefore print two different answers to "what
    /// would you write for this board?", and no surface can print one the writer
    /// would not have written.
    ///
    /// `docs/DEVICE-IDENTITY.md` §5 promises this out loud — *"`ksx device scan`
    /// prints the stronger selector it would write and leaves the decision with
    /// them"* — and so do two user-facing strings, `DeviceSelector::explain` and
    /// `ResolveError::Missing`. It was a promise nothing kept until this field
    /// existed.
    ///
    /// `None` only when no `usb:` selector could name the interface at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// **Which backends can reach this row**, as `ksx_core::Reach::eligibility`
    /// decided — never as a surface guessed.
    ///
    /// The rule is not derivable from anything else on this row, which is
    /// exactly why it is carried: a Bluetooth keyboard is Interception-eligible
    /// (it is a keyboard on the Windows input stack, so splitting it into
    /// virtual pads works today) and can NEVER be WinUSB-claimed (WinUSB binds
    /// a USB interface through an INF hardware id and there is no USB interface
    /// here). Someone reading `state == "claimable"` alone would get both
    /// halves wrong.
    #[serde(default)]
    pub interception_eligible: bool,
    #[serde(default)]
    pub winusb_eligible: bool,
    /// The one line a row shows about backends — composed in `ksx-core`, so the
    /// CLI report, Studio's Rust seam and Studio's TypeScript island cannot
    /// word it three ways. Never empty for a collected row.
    #[serde(default)]
    pub backends: String,
    /// **Can this device deliver a keystroke right now?**
    ///
    /// Not the same question as "is it present". A paired-but-disconnected
    /// Bluetooth keyboard is present all day and cannot type a character; a
    /// claimed USB interface is present and deliberately off the keyboard
    /// stack. Both are listed, and both say so.
    #[serde(default)]
    pub can_type: bool,
    /// Why not, when not. Empty when it can.
    #[serde(default)]
    pub cannot_type_reason: String,
}

/// `ksx device scan`, presentation-shaped: one row per PHYSICAL board, plus
/// the `[[device]]` entries this config already holds.
///
/// The two lists are separate on purpose and neither is derivable from the
/// other. A board can be plugged in and unconfigured (the thing to pick), and
/// an entry can be configured with its board unplugged (the thing that needs
/// saying out loud, because it looks identical to a broken config from the
/// slot's end).
///
/// # Every derived field on this view is decided by [`Self::read`]
///
/// The partition into pickable/unpickable boards, the counts, the summary
/// lines and the two "…and that emptiness is a real reading" flags are NOT
/// independently settable. They come out of [`Self::read`], and a surface's
/// only job is to render them.
///
/// That is `docs/SURFACES.md` §1 applied to the thing that keeps going wrong
/// here: Studio's SSR seam is Rust and its poller is TypeScript, so any
/// decision a surface takes gets taken TWICE, in two languages, and the two
/// drift silently. The `/devices` page shipped with exactly that — one copy
/// consulted [`Self::usb_available`] and the other did not, so a machine whose
/// enumeration FAILED was told "no keyboard-capable board found".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceScanView {
    pub generated_at: String,
    /// Can the legacy Interception capture context be constructed right now?
    /// Kept independently from USB enumeration: either backend may be absent
    /// while the other remains usable.
    #[serde(default)]
    pub interception_available: bool,
    /// Was USB enumeration possible? `false` means [`Self::boards`] is missing
    /// its USB half because nothing could be READ, not because nothing is
    /// plugged in.
    pub usb_available: bool,
    /// The same question for the Bluetooth pass, tracked separately because it
    /// is a separate read and either can fail alone.
    #[serde(default)]
    pub bluetooth_available: bool,
    /// Every device, in enumeration order (stable on one machine), probable
    /// keyboards first — **both transports in one list**, which is the whole
    /// point of this shape. [`BoardRow::transport`] says which each is.
    pub boards: Vec<BoardRow>,
    /// Every `[[device]]` entry in `config.toml`, resolved against the live
    /// enumeration.
    pub configured: Vec<ConfiguredDevice>,
    /// Anything the report has to say out loud — rendered, never swallowed.
    pub notes: Vec<String>,
    /// How many of [`Self::boards`] ksx could actually capture
    /// ([`BoardRow::pickable`]).
    #[serde(default)]
    pub pickable_boards: usize,
    /// How many of [`Self::boards`] have no keyboard interface.
    #[serde(default)]
    pub other_boards: usize,
    /// The line above the configured list.
    #[serde(default)]
    pub configured_summary: String,
    /// The line above the pickable-board list — and the one place an empty
    /// list is NOT the same sentence as an empty machine.
    #[serde(default)]
    pub boards_summary: String,
    /// The line above the "other USB interfaces" list; empty when there are
    /// none.
    #[serde(default)]
    pub other_summary: String,
    /// **Is [`Self::boards`] empty *because this machine has no keyboard-capable
    /// board*?**
    ///
    /// The single flag that licenses a surface to say "there is nothing here".
    /// `false` whenever the list is empty because nothing could be READ — a
    /// refused or failed read is not an assertion of absence, and on a cabinet
    /// with four boards plugged in the difference is the whole answer.
    #[serde(default)]
    pub no_pickable_board_found: bool,
    /// **Is [`Self::configured`] empty *because `config.toml` names no
    /// device*?** Same contract as [`Self::no_pickable_board_found`]: `false`
    /// when the config was never read.
    #[serde(default)]
    pub no_configured_device: bool,
}

/// A view of a machine nothing has been read from — NOT an empty machine.
///
/// `Default` is this deliberately, and it is hand-written rather than derived
/// so it cannot degrade into a confident wrong answer. Every path that fails to
/// read (a `MachineSource` refusal, a panicked collector, a surface that has no
/// enumerator) reaches for `DeviceScanView::default()`, and every one of them
/// must produce a view whose sentences say "not read" and whose
/// `no_*` flags are `false`.
impl Default for DeviceScanView {
    fn default() -> Self {
        Self::unreadable()
    }
}

impl DeviceScanView {
    /// Compose the view from what was actually read.
    ///
    /// The ONLY constructor for a view that describes a real machine, so that
    /// the partition, the counts, the summary lines and the per-entry health
    /// verdicts are decided once — here — rather than once per surface and
    /// once per language. Test fixtures build through it too, which is why no
    /// fixture can hand a page a summary line that disagrees with the list
    /// beneath it.
    pub fn read(
        generated_at: String,
        interception_available: bool,
        usb_available: bool,
        bluetooth_available: bool,
        mut boards: Vec<BoardRow>,
        mut configured: Vec<ConfiguredDevice>,
        notes: Vec<String>,
    ) -> Self {
        for board in &mut boards {
            board.pickable = board.keyboard.is_some();
            board.caveat = if board.looks_like_a_keyboard {
                String::new()
            } else {
                CAVEAT_NOT_A_KEYBOARD.to_owned()
            };
            let (lead, command) = command_cell(
                board.claim_command.as_deref(),
                board.release_command.as_deref(),
            );
            board.command_lead = lead;
            board.command = command;
            // The board's transport and backend eligibility are the KEYBOARD
            // interface's, because that is the devnode a pick would name. A
            // board with no keyboard falls back to its first interface, so a
            // "no backend" row still says which transport it is on — half the
            // reason a Bluetooth speaker shows up in a keyboard list at all is
            // to answer "why is my device not here".
            let source = board
                .keyboard
                .as_deref()
                .and_then(|kb| {
                    board
                        .interfaces
                        .iter()
                        .find(|i| i.instance_id.eq_ignore_ascii_case(kb))
                })
                .or_else(|| board.interfaces.first());
            if let Some(row) = source {
                board.transport = row.transport.clone();
                board.interception_eligible = row.interception_eligible;
                board.winusb_eligible = row.winusb_eligible;
                board.backends = row.backends.clone();
                board.can_type = row.can_type;
                board.cannot_type_reason = row.cannot_type_reason.clone();
                // The selector of the SAME interface, so "which board did I
                // pick" and "which board will be captured" cannot answer
                // differently. A board with no keyboard interface keeps `None`
                // even though its first devnode has one: it is not pickable,
                // and handing a surface a selector for it would be offering a
                // choice the backend then refuses.
                board.selector = board.keyboard.as_ref().and(row.selector.clone());
            }
            board.alias_hint = board
                .alias
                .clone()
                .unwrap_or_else(|| board.name.clone())
                .trim()
                .to_owned();
            board.transport_label = transport_label(&board.transport);
            // A CLAIMED board also cannot type to Windows — that is what a
            // claim does — and it must not wear this alarm: the row already
            // says `claimed`, the backends line already says why, and warning
            // about the one state that is working exactly as asked is how a
            // page teaches people to ignore its warnings.
            board.cannot_type_line =
                if board.claimed || board.can_type || board.cannot_type_reason.is_empty() {
                    String::new()
                } else {
                    format!("{} {CANNOT_TYPE_TAIL}", board.cannot_type_reason)
                };
        }
        for device in &mut configured {
            let (line, level) = device_health(device);
            device.health_line = line;
            device.health_level = level.to_owned();
            let (lead, command) = command_cell(
                device.claim_command.as_deref(),
                device.release_command.as_deref(),
            );
            device.command_lead = lead;
            device.command = command;
        }
        let pickable_boards = boards.iter().filter(|b| b.pickable).count();
        let other_boards = boards.len() - pickable_boards;
        Self {
            configured_summary: configured_summary_line(configured.len()),
            boards_summary: boards_summary_line(
                pickable_boards,
                usb_available,
                bluetooth_available,
            ),
            other_summary: other_summary_line(other_boards),
            // The two conclusions, drawn once. BOTH enumerations gate the
            // first: a machine whose Bluetooth walk failed has not been fully
            // read, so "no keyboard-capable board found" would be an assertion
            // about half a machine. The second is unconditional here because
            // reaching `read` at all means the config WAS read.
            no_pickable_board_found: usb_available && bluetooth_available && pickable_boards == 0,
            no_configured_device: configured.is_empty(),
            pickable_boards,
            other_boards,
            generated_at,
            interception_available,
            usb_available,
            bluetooth_available,
            boards,
            configured,
            notes,
        }
    }

    /// The view for a machine that could not be read: empty lists, and every
    /// line saying why the list is empty.
    ///
    /// Both `no_*` flags are `false`, so nothing downstream is licensed to
    /// draw an empty machine.
    pub fn unreadable() -> Self {
        Self {
            generated_at: String::new(),
            interception_available: false,
            usb_available: false,
            bluetooth_available: false,
            boards: Vec::new(),
            configured: Vec::new(),
            notes: Vec::new(),
            pickable_boards: 0,
            other_boards: 0,
            configured_summary: UNREAD_CONFIGURED_LINE.to_owned(),
            boards_summary: UNREAD_BOARDS_LINE.to_owned(),
            other_summary: String::new(),
            no_pickable_board_found: false,
            no_configured_device: false,
        }
    }
}

/// What the boards line says when the enumeration did not answer.
///
/// Kept as a named constant because it is the sentence this page exists to get
/// right, and because two tests assert it appears while the empty-machine
/// sentence does not.
pub const UNREAD_BOARDS_LINE: &str =
    "USB enumeration failed — this list is empty because nothing could be READ, not because \
     nothing is plugged in";

/// The same sentence for the Bluetooth half, and the reason the two halves are
/// tracked apart.
///
/// A machine whose USB walk worked and whose Bluetooth walk failed has a list
/// that is *right about USB and silent about Bluetooth*, which reads exactly
/// like a machine with no Bluetooth devices. Saying which half is missing is
/// the difference between "your keyboard is not paired" and "ksx could not
/// look".
pub const UNREAD_BLUETOOTH_LINE: &str =
    "Bluetooth enumeration failed — any Bluetooth device is MISSING from this list, and its \
     absence here is not evidence that it is unpaired";

/// The USB half failed and the Bluetooth half answered.
pub const UNREAD_USB_LINE: &str =
    "USB enumeration failed — any USB board is MISSING from this list, and its absence here is \
     not evidence that it is unplugged";

/// The same distinction for the configured list. A refusal reaches this page
/// before `config.toml` is opened, so "no [[device]] entries" would be a claim
/// about a file nobody looked at.
pub const UNREAD_CONFIGURED_LINE: &str =
    "config.toml was not read — this list is empty because nothing could be READ, not because no \
     device is configured";

/// The empty-machine sentence. Named so the tests that must prove it is ABSENT
/// under a failed read cannot drift away from the string the page emits.
pub const NO_BOARDS_LINE: &str = "no keyboard-capable board found";

/// The lead that must accompany `ksx winusb claim` wherever it is shown.
///
/// It says ELEVATED because both commands need an admin shell, and a copyable
/// command handed over without that word produces one "access denied" and no
/// explanation. It says the claim STOPS THE BOARD TYPING because that is the
/// consequence, and it is the one people do not expect.
pub const CLAIM_LEAD: &str =
    "To move it to the WinUSB backend it must be claimed — it then stops typing to Windows, which \
     is a separate, consented step. Run this in an ELEVATED shell:";

/// The same for `ksx winusb release`.
pub const RELEASE_LEAD: &str =
    "It is claimed, so Windows sees no keyboard on it. To put it back on the keyboard driver, run \
     this in an ELEVATED shell:";

/// What a board that is merely HID has to be told about itself.
///
/// `state == "claimable"` is deliberately generous — it means "it is HID" — so
/// in a representative setup a mouse, an LED controller and a fan controller all
/// read as claimable. Without this sentence "ksx could claim it" reads as a
/// recommendation.
pub const CAVEAT_NOT_A_KEYBOARD: &str =
    "NOT declared as a keyboard. This is an HID interface and may be something else entirely — on \
     a real cabinet a mouse, an LED controller and a fan controller all read as claimable.";

/// `(lead, command)` for the elevated command a row shows, or two empty
/// strings. Release wins when both are somehow present: it is the one that
/// describes the board's current state.
fn command_cell(claim: Option<&str>, release: Option<&str>) -> (String, String) {
    match (release, claim) {
        (Some(cmd), _) => (RELEASE_LEAD.to_owned(), cmd.to_owned()),
        (None, Some(cmd)) => (CLAIM_LEAD.to_owned(), cmd.to_owned()),
        (None, None) => (String::new(), String::new()),
    }
}

fn configured_summary_line(count: usize) -> String {
    match count {
        0 => "no [[device]] entries in config.toml".to_owned(),
        1 => "1 [[device]] entry in config.toml:".to_owned(),
        n => format!("{n} [[device]] entries in config.toml:"),
    }
}

/// The line above the pickable list, and the one place an empty list is NOT
/// the same sentence as an empty machine.
///
/// Two transports means two ways to be half-blind, and a partial read must not
/// read as a complete one. When one pass failed the count is still printed —
/// it is true of the half that answered — and the missing half is named beside
/// it, because "no Bluetooth device here" and "ksx could not look at Bluetooth"
/// send a user to two different places.
fn boards_summary_line(count: usize, usb_available: bool, bluetooth_available: bool) -> String {
    match (usb_available, bluetooth_available) {
        (false, false) => return UNREAD_BOARDS_LINE.to_owned(),
        (true, false) => return format!("{} — {UNREAD_BLUETOOTH_LINE}", found_line(count)),
        (false, true) => return format!("{} — {UNREAD_USB_LINE}", found_line(count)),
        (true, true) => {}
    }
    match count {
        0 => NO_BOARDS_LINE.to_owned(),
        1 => "1 keyboard-capable board:".to_owned(),
        n => format!("{n} keyboard-capable boards:"),
    }
}

/// What a partial read may still assert: the count of what it DID see.
fn found_line(count: usize) -> String {
    match count {
        1 => "1 keyboard-capable device found so far".to_owned(),
        n => format!("{n} keyboard-capable devices found so far"),
    }
}

/// `usb` → `USB`, `bluetooth` → `Bluetooth`.
///
/// An unknown or empty code renders as `?` rather than defaulting to USB: a
/// collector that forgot to set a transport is a bug, and it must LOOK like one
/// instead of quietly mislabelling a Bluetooth device as USB — which is the
/// label that decides whether the WinUSB advice on the same row is true.
fn transport_label(code: &str) -> String {
    match code {
        c if c == crate::Transport::Usb.code() => crate::Transport::Usb.label().to_owned(),
        c if c == crate::Transport::Bluetooth.code() => {
            crate::Transport::Bluetooth.label().to_owned()
        }
        _ => "?".to_owned(),
    }
}

fn other_summary_line(count: usize) -> String {
    match count {
        0 => String::new(),
        1 => "1 board has no keyboard interface — ksx cannot capture it:".to_owned(),
        n => format!("{n} boards have no keyboard interface — ksx cannot capture them:"),
    }
}

/// `(sentence, level)` for one configured entry — including the one
/// combination that is a real fault.
///
/// `backend = "winusb"` on a board that is NOT bound to `winusb.sys` is the
/// only config shape a session refuses to start on, and it refuses **only for
/// the slots that name the alias**: `run/plan.rs` builds `captureable` from
/// slots' keyboards, `run/resolve.rs` promotes an id into `plan.winusb` only if
/// it is already in `captureable`, and `capture.rs` raises `NotRebound` only
/// for ids in `plan.winusb`. An entry no slot references never enters the plan,
/// so the session starts cleanly — telling that user "ksx run will refuse"
/// sends them to debug a session that works.
///
/// It is decided here because it is a verdict about what `ksx run` does, and a
/// verdict minted in a view file is a verdict every other surface has to mint
/// again.
fn device_health(device: &ConfiguredDevice) -> (String, &'static str) {
    if !device.present {
        // Nothing is connected, so there is no driver binding to describe. A
        // stale claim pill here would be a claim about a board that is absent.
        return (String::new(), "none");
    }
    if device.claimed {
        return ("claimed — bound to winusb.sys".to_owned(), "ok");
    }
    if device.backend != "winusb" {
        return ("on the Windows keyboard stack".to_owned(), "idle");
    }
    // `backend = "winusb"` on a device that is not on the USB transport is not
    // a claim someone forgot to perform. It is a claim that can never be
    // performed, so the advice "run `ksx winusb claim`" — correct for every
    // other unclaimed entry — would send this user to a command that refuses
    // forever. The entry has to be changed, not the machine.
    if device.transport == ksx_core::Transport::Bluetooth.code() {
        return (
            format!(
                "backend is winusb and this device is on Bluetooth — {}. Change the entry to \
                 backend = \"interception\", which CAN capture it.",
                ksx_core::transport::WINUSB_NEEDS_A_USB_INTERFACE
            ),
            "warn",
        );
    }
    if device.used_by.is_empty() {
        (
            "backend is winusb but the board is NOT claimed. No [[slot]] names this alias, so a \
             session still starts — the first slot that names it will refuse."
                .to_owned(),
            "idle",
        )
    } else {
        (
            "backend is winusb but the board is NOT claimed — every slot naming it refuses to \
             start"
                .to_owned(),
            "warn",
        )
    }
}

/// Backend-owned role of one physical input board.
///
/// This is deliberately not inferred from a display name. A board can expose a
/// boot-keyboard interface while physically being an arcade encoder, and the
/// distinction decides which first-run workflow a surface offers. The backend
/// assigns `panel-encoder` only from a registered exact hardware family; an
/// unknown HID device remains a keyboard or other device until a driver owns
/// that classification.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BoardRole {
    #[default]
    Keyboard,
    PanelEncoder,
    Other,
}

impl BoardRole {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Keyboard => "keyboard",
            Self::PanelEncoder => "panel-encoder",
            Self::Other => "other",
        }
    }
}

/// One physical board: every interface that shares a composite parent
/// (`crates/ksx-backend/src/device_scan.rs` `Board`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardRow {
    /// The vendor table's name, else the device's own product string, else the
    /// parent path. Never empty.
    pub name: String,
    /// Every devnode this one board wears.
    pub interfaces: Vec<UsbRow>,
    /// The instance id of the interface a keyboard would be captured through,
    /// when the board has one. `None` = ksx cannot capture this board, and it
    /// cannot be picked either.
    pub keyboard: Option<String>,
    /// That interface's one-sentence verdict, straight from the enumerator.
    pub keyboard_verdict: String,
    /// Does anything here DECLARE itself a keyboard (HID boot protocol), or is
    /// it merely HID? A mouse, an LED controller and a fan controller are all
    /// claimable; only this separates them from a panel.
    pub looks_like_a_keyboard: bool,
    /// What this board physically is for first-run UX. An I-PAC remains a
    /// `panel-encoder` even though keyboard mode makes MI_00 declare the boot
    /// keyboard protocol. Surfaces render this verdict; they never match a
    /// product label or VID/PID themselves.
    #[serde(default)]
    pub role: BoardRole,
    /// Is the keyboard interface bound to `winusb.sys` right now — i.e. off the
    /// Windows keyboard stack?
    pub claimed: bool,
    /// The `[[device]]` alias bound to this board, if any.
    pub alias: Option<String>,
    /// `ksx winusb claim <ID>` — present only while the board is claimABLE.
    /// A command, never an action: the claim needs elevation, so a surface
    /// that cannot elevate SHOWS this rather than running it.
    pub claim_command: Option<String>,
    /// `ksx winusb release <ID> --yes` — present only while it is claimed.
    pub release_command: Option<String>,
    /// Can this board be picked at all — i.e. does it have a keyboard
    /// interface ([`Self::keyboard`] is `Some`)?
    ///
    /// The partition every picker needs, taken once by
    /// [`DeviceScanView::read`] rather than re-derived per surface. A pick form
    /// on a board ksx cannot capture is an offer that always refuses, so the
    /// two groups are drawn differently — and before this field existed the
    /// filter was written three times in Rust and twice more in TypeScript.
    #[serde(default)]
    pub pickable: bool,
    /// The elevated command this board's row should SHOW (never run), and the
    /// sentence that has to go with it. Both empty when there is neither.
    /// Chosen from [`Self::claim_command`] / [`Self::release_command`] by
    /// [`DeviceScanView::read`].
    #[serde(default)]
    pub command_lead: String,
    #[serde(default)]
    pub command: String,
    /// The honest caveat when nothing on the board DECLARES itself a keyboard;
    /// empty when [`Self::looks_like_a_keyboard`]. See [`CAVEAT_NOT_A_KEYBOARD`].
    #[serde(default)]
    pub caveat: String,
    /// `usb` | `bluetooth` — this device's transport, taken from the interface
    /// a pick would name (its keyboard, else its first devnode).
    ///
    /// Filled by [`DeviceScanView::read`]. The transport column exists because
    /// the answer to "which backends can I use" is decided by it and by nothing
    /// else on the row.
    #[serde(default)]
    pub transport: String,
    /// Which backends can reach this device — see [`UsbRow::interception_eligible`].
    /// Filled by [`DeviceScanView::read`].
    #[serde(default)]
    pub interception_eligible: bool,
    #[serde(default)]
    pub winusb_eligible: bool,
    /// The composed backend line. Filled by [`DeviceScanView::read`].
    #[serde(default)]
    pub backends: String,
    /// Can it deliver a keystroke right now? Filled by [`DeviceScanView::read`].
    #[serde(default)]
    pub can_type: bool,
    /// Why not, when not. Filled by [`DeviceScanView::read`].
    #[serde(default)]
    pub cannot_type_reason: String,
    /// The transport as a HUMAN reads it (`USB`, `Bluetooth`), not as a
    /// consumer keys on it.
    ///
    /// Served rather than mapped per surface. The mapping is three lines, which
    /// is exactly the size of thing that gets written in Rust and again in
    /// TypeScript and then disagrees — and a device labelled two ways in two
    /// places is the specific confusion this column exists to remove.
    #[serde(default)]
    pub transport_label: String,
    /// The whole "it cannot type" caveat, or empty when there is nothing to
    /// say. Filled by [`DeviceScanView::read`] — see [`CANNOT_TYPE_TAIL`].
    #[serde(default)]
    pub cannot_type_line: String,
    /// The [`ksx_core::DeviceSelector`] spelling of the interface a pick would
    /// name — `usb:d209:0430:00`. `None` on a board with no keyboard interface,
    /// and on one whose devnode the enumerator could not describe.
    ///
    /// **This is what a surface sends back when a user picks a board**, and it
    /// exists so that no surface has to derive it from
    /// [`Self::interfaces`]. `docs/FIRST-RUN.md` §6 forbids ever asking a user
    /// for a device path; §5 forbids ever showing one as the identifier. A
    /// surface that had to pick the keyboard interface out of the list itself
    /// would be re-taking the decision [`Self::keyboard`] already records — and
    /// it would take it in TypeScript as well as in Rust.
    #[serde(default)]
    pub selector: Option<String>,
    /// The alias a pick would write for this board: the one it already has,
    /// else its name.
    ///
    /// One derivation, served. `device_edit::plan_pick` decides it the same way
    /// for an absent `--alias`, and re-picking a configured board deliberately
    /// keeps the name the user gave it, because renaming orphans every
    /// `[[slot]]` that refers to it.
    #[serde(default)]
    pub alias_hint: String,
}

/// What has to follow the reason a device cannot type.
///
/// The reason alone (`not connected (paired but absent?)`) is a fact about a
/// devnode. This is what it MEANS to the person reading a device list before
/// they claim their panel, and it is the whole point of listing an unusable
/// keyboard rather than hiding it.
pub const CANNOT_TYPE_TAIL: &str =
    "— it is present and CANNOT type right now, so it does not count as the spare keyboard a \
     claim needs";

/// One `[[device]]` entry, resolved against the machine as it is right now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfiguredDevice {
    /// The name `[[slot]]` entries use.
    pub alias: String,
    /// The `id` as the FILE spells it.
    pub id: String,
    /// `winusb` | `interception`.
    pub backend: String,
    /// One word for the rung: `model` | `serial` | `port` | `hardware-id`.
    pub rung: String,
    /// Does this id still name the same board after a replug into another
    /// socket? `false` is the PORT-PINNED case.
    pub survives_replug: bool,
    /// What the selector pins down and what it costs
    /// (`DeviceSelector::explain`).
    pub means: String,
    /// The whole PORT-PINNED paragraph, verbatim from the writer that decided
    /// it — including the half that is easy to miss, that a `port=` value names
    /// THIS PC's USB topology and does not travel to another cabinet. `None`
    /// when the id survives a replug.
    ///
    /// Carried rather than re-worded per surface: `ksx device pick` prints it
    /// at write time, and this is the same sentence standing on the entry
    /// afterwards, because the cost is a property of the entry and not of the
    /// moment it was written.
    pub port_pinned_warning: Option<String>,
    /// Does the id resolve to exactly one connected interface right now?
    pub present: bool,
    /// The board's name, when it is present.
    pub board: Option<String>,
    /// The interface it resolved to, when it is present.
    pub instance_id: Option<String>,
    /// `usb` | `bluetooth` for the device this entry resolved to; empty while
    /// it resolves to nothing.
    ///
    /// Carried because the entry's `backend` can be *permanently* wrong rather
    /// than merely not-yet-right: `backend = "winusb"` on a Bluetooth device is
    /// not a claim someone forgot to perform, it is a claim that can never be
    /// performed. [`device_health`] tells those two apart, and it needs this to
    /// do it.
    #[serde(default)]
    pub transport: String,
    /// Is that interface bound to `winusb.sys`?
    pub claimed: bool,
    pub claim_command: Option<String>,
    pub release_command: Option<String>,
    /// Every slot that names this alias, in `config.toml` AND in every
    /// games.toml profile — the list `remove` refuses on without `--force`.
    pub used_by: Vec<String>,
    /// One sentence about how this entry stands right now: claimed, on the
    /// keyboard stack, or the one combination a session refuses to start on.
    /// Empty when the board is not connected — there is then no driver binding
    /// to describe, and a stale pill would be a claim about an absent board.
    ///
    /// Decided by [`DeviceScanView::read`], never by a surface: it is a verdict
    /// about `ksx run`'s behaviour, and `run` is not something a view file can
    /// see. See `device_health` for which of `run`'s three gates it reads.
    #[serde(default)]
    pub health_line: String,
    /// Severity of [`Self::health_line`]: `ok` | `warn` | `idle` | `none`.
    /// A surface maps this to its own vocabulary of pills and colours; the
    /// judgement itself is not a surface's to make.
    #[serde(default)]
    pub health_level: String,
    /// The elevated command this entry's row should SHOW (never run), and the
    /// sentence that has to go with it. Both empty when there is neither.
    #[serde(default)]
    pub command_lead: String,
    #[serde(default)]
    pub command: String,
}

/// One `ksx device pick`, as any surface spells it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePickSpec {
    /// An instance path, an existing `[[device]]` alias, or any unique part of
    /// an instance path.
    pub query: String,
    /// The name `[[slot]]` entries will use. `None`/empty derives one from the
    /// board, and re-picking a configured board keeps the name it already has.
    pub alias: Option<String>,
}

/// What `ksx device pick` wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePickView {
    pub alias: String,
    /// The `id` value written: the weakest rung that is still unique.
    pub id: String,
    pub backend: String,
    pub board: String,
    pub instance_id: String,
    /// The alias of the entry this replaced; `None` = a new entry.
    pub replaced: Option<String>,
    /// Was the interface ALREADY bound to `winusb.sys`? Nothing here ever
    /// claims one.
    pub claimed: bool,
    /// Did the writer have to fall back to the socket to tell this board from
    /// its twin? The entry then carries
    /// [`ConfiguredDevice::port_pinned_warning`].
    pub port_pinned: bool,
    /// `ksx winusb claim <ID>`, when claiming is the sensible next step.
    pub next_step: Option<String>,
    pub backup: Option<String>,
    /// ONE sentence — a flash is one line and capped, so the structured facts
    /// above are what a page renders.
    pub summary: String,
}

/// One `ksx device remove`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRemoveSpec {
    pub alias: String,
    /// Remove it even though slots still name it.
    pub force: bool,
}

/// What `ksx device remove` deleted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRemoveView {
    pub alias: String,
    pub id: String,
    /// The interface still bound to `winusb.sys`. Deleting config does not
    /// release a board, and this is how the user finds out before the panel is
    /// dark rather than after.
    pub still_claimed: Option<String>,
    pub release_command: Option<String>,
    /// Slots that now name a device which does not exist (`--force` only).
    pub breaks: Vec<String>,
    pub backup: Option<String>,
    /// ONE sentence, for the flash.
    pub summary: String,
}

/// `ksx winusb status`, presentation-shaped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbView {
    pub generated_at: String,
    pub interfaces: Vec<UsbRow>,
    /// How many keyboards can still type right now — the number that makes
    /// "claim the last one" a refusal rather than a lockout.
    pub typing_keyboards: usize,
    pub notes: Vec<String>,
}

/// `ksx preset list`, plus the templates a new preset can be seeded from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetsView {
    pub config_root: String,
    pub presets: Vec<PresetRow>,
    pub templates: Vec<TemplateRow>,
}

/// One preset on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetRow {
    pub name: String,
    /// Bound controls (the inert `"None"` placeholders not counted).
    pub bound: usize,
    /// `[macros.<name>]` tables it defines.
    pub macros: usize,
    /// A built-in that must not be overwritten (`default`, `empty`).
    pub protected: bool,
    /// This file successfully converted to the runtime controller layout.
    ///
    /// Old providers did not send this field; treating an omitted value as
    /// usable preserves their wire behavior while current providers can keep
    /// a broken file visible without offering it in a Saved Games form.
    #[serde(default = "serde_true")]
    pub usable: bool,
    /// Product-safe reason this layout cannot be selected. Detailed parser
    /// diagnostics belong in logs/support output, not in the customer form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// Where it came from — a path, or the built-in's name.
    pub source: String,
    /// **How many slots name this layout** — config.toml's own, plus every
    /// games.toml profile's.
    ///
    /// Served so a surface can say "used by 2 controllers" NEXT TO the delete
    /// control, instead of letting somebody press it and reading the refusal
    /// afterwards. A guard the person can see before they act is a different
    /// product from a guard that only speaks after.
    ///
    /// `#[serde(default)]`: an older provider that does not send it reads as
    /// 0, which understates rather than invents.
    #[serde(default)]
    pub used_by: usize,
}

/// Change the split-or-freeze answer on a config that is already saved.
///
/// `FIRST-RUN.md` §3 asks this question once, during first run, and
/// `ksx-backend`'s `stage::apply` was the ONLY thing that had ever written it.
/// So the answer given while setting a cabinet up was permanent: changing it
/// meant redoing first run, hand-editing TOML, or importing a whole document.
/// Nothing about the question is one-time - freeze suits a tournament night,
/// split suits the same panel on a desk an hour later.
///
/// Worth noting for the parity guard: this capability had no verb on ANY
/// surface, not even the CLI, which is why `parity.rs` never noticed it
/// missing. That guard walks CLI verbs and asks which surface performs them;
/// a config concept nobody had ever given a verb to is invisible to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockingSpec {
    /// `whole` | `bound-keys` | `off` - a [`BlockingOption::name`], served.
    pub blocking: String,
}

/// What changing it did, and what it did NOT do.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockingView {
    /// The value now on disk.
    pub blocking: String,
    /// Its title, from the one roster both surfaces read.
    pub title: String,
    /// Where the previous config went.
    pub backup: Option<String>,
    /// **A session was running when this was written.** The daemon reads
    /// settings from disk at start (`Reload` is stop, re-read, start - never a
    /// hot-patch), so a live game keeps the old answer until it is restarted.
    /// Served rather than guessed at, because "saved" and "in effect" are
    /// different claims and a page that conflates them is lying at exactly the
    /// moment somebody is testing whether the change worked.
    pub session_running: bool,
}

/// What POST /setup/theme carries: a theme id, or empty for System.
///
/// The STUDIO validates the id against its own generated roster before this
/// spec is built - the roster is a Studio artifact (its stylesheet ships the
/// theme blocks), so neither this crate nor a machine provider can know it.
/// A provider's only contract is "a short css-ident or empty", so a stale
/// binary can never wedge the config with a name nothing can render.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeSpec {
    /// A theme id (`dark`, `light`, ...) or empty = System (follow the OS).
    pub theme: String,
}

/// What changing the theme did.
///
/// No `session_running` here, unlike [`BlockingView`]: the theme is read per
/// page render, never by the daemon, so "saved" and "in effect" are the same
/// claim - the next page load shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeView {
    /// The value now on disk (empty = System).
    pub theme: String,
    /// Where the previous config went.
    pub backup: Option<String>,
}

/// **What ksx left behind on this machine, and whether it matters.**
///
/// Every WinUSB preparation writes a receipt to `%ProgramData%\KSX\WinUSB`.
/// `ksx winusb repair` has always been able to compare those receipts against
/// the device tree; NOTHING has ever shown the result on a screen. So a machine
/// could carry ten receipts, nine of them describing jobs that finished long
/// ago, and every surface would report a clean bill of health - because every
/// surface reads the device tree, and the device tree is genuinely fine.
///
/// The distinction that decides the wording is the domain's own
/// (`Drift::is_bookkeeping`): a stale RECORD is housekeeping and a keyboard
/// nobody gave back is not. Conflating them would either alarm somebody whose
/// cabinet works, or reassure somebody whose keyboard does not type.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbResidueView {
    /// The receipt store could be read. `false` renders the reason, never
    /// "nothing to clean up" - an unreadable store is not an empty one.
    pub readable: bool,
    /// Why not, when it could not be read.
    pub error: String,
    /// Receipts on this machine, in total.
    pub receipts: usize,
    /// How many disagree with what Windows reports.
    pub drifted: usize,
    /// **Every disagreement is a stale record.** True means no keyboard is
    /// affected and this is tidying; false means at least one board is still
    /// holding a driver package that a person can feel.
    pub bookkeeping_only: bool,
    /// The state in one sentence.
    pub line: String,
    /// What it means for the person reading, and what would change it.
    pub detail: String,
    /// One row per disagreement. Empty when everything agrees.
    pub rows: Vec<WinusbResidueRow>,
    /// **Signing certificates left in the machine stores by attempts that are
    /// finished** — counted in certificates, not subjects, because that is
    /// what a person sees if they open certmgr.
    ///
    /// Receipts and certificates are different residue with different
    /// lifetimes: a receipt is ksx's own bookkeeping, a certificate is a
    /// change to the machine's trust stores. A view that counted only the
    /// first could call a machine clean while certificate pairs remained in
    /// LocalMachine\Root and LocalMachine\TrustedPublisher.
    #[serde(default)]
    pub leftover_certificates: usize,
    /// Certificates that are still signing an installed driver package. NOT
    /// residue: removing one breaks the package holding a keyboard.
    #[serde(default)]
    pub certificates_in_use: usize,
    /// Why the certificates could not be judged, when they could not be. A
    /// ksx package whose signer cannot be read makes every one of them
    /// unclassifiable, and saying so beats reporting a confident zero.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub certificates_unknown: String,
    /// The certificate state in one sentence, or EMPTY when there is nothing
    /// to say — a page renders no row at all rather than a cheerful "0
    /// certificates" nobody asked about.
    ///
    /// Served, like [`Self::line`] and [`Self::detail`] beside it, because
    /// this view's words are its own: a surface that recomputed them from the
    /// counts would be a second place for them to drift, and the SSR render
    /// and the hydrating island would be the two places.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub certificates_line: String,
}

/// One receipt that disagrees with the machine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbResidueRow {
    /// The board it was about, named the way `/devices` names boards - never
    /// the raw instance path, which is support detail (`FIRST-RUN.md` §5).
    pub board: String,
    /// What the receipt says, in the user's words.
    pub says: String,
    /// What the machine says.
    pub machine: String,
    /// Settling this one needs only a journal write.
    pub bookkeeping: bool,
    /// Short id, for a support conversation.
    pub reference: String,
}

/// Explicit consent for the machine-wide certificate cleanup.
///
/// No subject, thumbprint, store name or filesystem path is accepted from a
/// surface. The backend classifies the installed KSX packages and certificates
/// itself, and the fixed helper removes only certificates proven not to sign a
/// live package plus KSX's fixed one-time signing-key namespace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbCertificateSweepSpec {
    /// The person confirmed removal of KSX's leftover signing certificates.
    pub confirm: bool,
}

/// Consent and identity for an exact-device WinUSB preparation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbPrepareSpec {
    /// Selector visible when preparation began. Compared as a typed selector
    /// against the current stage after the helper returns.
    pub expected_selector: String,
    /// Exact PnP interface instance id from the current machine inventory.
    pub instance_id: String,
    /// The user confirmed a second, separately connected keyboard can type.
    #[serde(default)]
    pub confirm_spare_keyboard: bool,
    /// The user confirmed this interface will leave the keyboard stack.
    #[serde(default)]
    pub confirm_rebind: bool,
    /// The user confirmed KSX installs a machine-local signing certificate for
    /// the generated catalog.
    #[serde(default)]
    pub confirm_machine_certificate: bool,
}

/// Consent and identity for releasing an exact KSX-owned preparation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbReleaseSpec {
    pub expected_selector: String,
    pub instance_id: String,
    #[serde(default)]
    pub confirm_release: bool,
}

/// Authoritative post-helper state; never a claim inferred from an exit code.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinusbMutationView {
    pub instance_id: String,
    pub hardware_id: String,
    /// `prepared` | `released` | `recovery-required`.
    pub state: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

fn serde_true() -> bool {
    true
}

impl Default for PresetRow {
    fn default() -> Self {
        Self {
            name: String::new(),
            bound: 0,
            macros: 0,
            protected: false,
            usable: true,
            problem: None,
            source: String::new(),
            used_by: 0,
        }
    }
}

/// The games.toml profiles, preflighted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfilesView {
    pub generated_at: String,
    /// The config root these were read from.
    pub config_root: String,
    /// games.toml's own path — the file a broken row has to be fixed in, and
    /// therefore the one string a "this is wrong" row cannot leave out.
    pub games_path: String,
    pub profiles: Vec<ProfileDetail>,
    /// Anything the read has to say out loud (an unreadable file, a profile
    /// with no slots) — rendered, never swallowed.
    pub notes: Vec<String>,
}

/// One `[[game]]` profile, as a surface can see it — including whether the
/// program it names is actually on this disk.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileDetail {
    /// Opaque identity-and-content revision used by update/delete forms.
    /// Consumers must return it unchanged and must not interpret it.
    #[serde(default)]
    pub revision: String,
    pub title: String,
    /// The `path` key verbatim: an executable, or a `steam://`-style URL.
    pub path: String,
    pub arguments: String,
    /// How many `[[game.slot]]` entries it hands out.
    pub slots: usize,
    /// The presets those slots name, de-duplicated, in slot order.
    pub presets: Vec<String>,
    /// `ok` | `broken` | `launcher`.
    ///
    /// `launcher` is NOT a weaker `ok`, and collapsing the two would be a lie
    /// in the direction that matters: a `steam://` URL is unverifiable by
    /// construction — only the shell knows whether `rungameid/9999` names a
    /// real game — so ksx cannot promise it works and must not imply it has
    /// checked (`ksx_games::preflight`'s own words).
    pub state: String,
    /// The one sentence that says what that means for a launch.
    pub verdict: String,
    /// The path that does not resolve. `Some` **only** when
    /// `state == "broken"`, because a row that says "broken" without printing
    /// the string it is complaining about sends the user back to the file to
    /// guess which of two paths moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broken_path: Option<String>,
}

/// A new `[[game]]` profile, as a surface asks for one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewProfile {
    pub title: String,
    /// The program to launch: a full path to an .exe, or a launcher URL.
    pub path: String,
    /// Command line for it, split the way `CommandLineToArgvW` would.
    #[serde(default)]
    pub arguments: String,
    /// How many `[[game.slot]]` entries to seed, `1..=ksx_core::MAX_SLOTS`.
    ///
    /// Seeding is not a convenience. A profile with no slots hands out no
    /// pads, and `ksx run --game` refuses it — so "create" that produced an
    /// empty shell would answer "I can't make a profile" with a profile that
    /// cannot be used.
    pub slots: u8,
    /// The preset every seeded slot starts on. Device selectors and the other
    /// controller-specific settings come from the matching saved base slots;
    /// creation refuses rather than writing an unwired controller.
    pub preset: String,
}

/// Edit one existing game profile.
///
/// The title before the edit is separate from the desired title so a rename
/// never becomes "find whichever row now has this new name". Player count and
/// preset are whole-profile choices: the resulting slots are numbered
/// `1..=slots`, and every one uses `preset`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateProfile {
    /// The stable lookup key from the profile row being edited.
    pub original_title: String,
    /// The opaque revision served with the row. A stale or missing revision
    /// refuses before any write so two open forms cannot overwrite each other.
    #[serde(default)]
    pub revision: String,
    pub title: String,
    /// The program to launch: a full path to an .exe, or a launcher URL.
    pub path: String,
    #[serde(default)]
    pub arguments: String,
    pub slots: u8,
    pub preset: String,
    /// `false`: preserve each existing game slot's keyboard/mouse selectors;
    /// newly added slots come from the matching base controller.
    ///
    /// `true`: deliberately replace every resulting slot's selectors from the
    /// matching base controller. Existing per-game persona, SOCD, and macro
    /// choices remain profile-specific; the selected preset is still applied
    /// to every resulting slot.
    #[serde(default)]
    pub rebase_devices: bool,
}

/// Delete one existing game profile by title.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteProfile {
    pub title: String,
    /// The opaque revision served with the row being removed.
    #[serde(default)]
    pub revision: String,
}

/// A new preset, seeded from an in-box template.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewPreset {
    pub name: String,
    /// The template id ([`TemplateRow::id`]).
    pub template: String,
    /// Which player block to instantiate, `1..=`[`TemplateRow::players`].
    pub player: u8,
    /// Overwrite an existing preset of that name. A timestamped backup is
    /// taken first — same consent shape as `ksx preset new --force`.
    #[serde(default)]
    pub force: bool,
}

/// Give a preset a different name, carrying every reference with it.
///
/// Not a file rename. A preset is named by `config.toml`'s slots and by every
/// games.toml profile, so the write is a set: the file, plus every slot that
/// names it, in one pass. There is no `force` — a rename onto a name that is
/// taken is refused, because a rename that silently swallowed another layout
/// would destroy work no backup names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenamePreset {
    pub from: String,
    pub to: String,
}

/// Remove a preset file.
///
/// Refused while any slot still names it; `force` deletes anyway and LEAVES
/// those slots pointing at nothing, which the session start refuses in words.
/// A visible break beats a silent repair — nothing here can know which preset
/// the person meant instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeletePreset {
    pub name: String,
    #[serde(default)]
    pub force: bool,
}

/// One preset template (`ksx-core/src/templates.rs`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateRow {
    pub id: String,
    pub label: String,
    /// The panel note that travels with it — what this layout assumes.
    pub detail: String,
    /// Player blocks it can instantiate (P1–P4), when it has them.
    pub players: Vec<u8>,
    /// **This template binds nothing** (`empty` — every control listed, no
    /// keys on any of them).
    ///
    /// Served rather than left to a surface to notice, because it is the one
    /// option that produces something that cannot play: `StagedSetup::commit`
    /// refuses a controller with no bindings, so a menu that offered this
    /// silently would be offering the choice that dead-ends, with nothing on
    /// screen to say so.
    #[serde(default)]
    pub blank: bool,
}

impl TemplateRow {
    /// **The roster, from the one registry that holds it** —
    /// [`ksx_core::templates::TEMPLATES`], the same slice
    /// `ksx preset list --templates` prints.
    ///
    /// One composition, two consumers: the preset list (seed a new FILE) and
    /// the staged setup (dress a controller that is not a file yet). They ask
    /// the same question — "what layouts does this build know" — and a second
    /// mapping from `Template` to a row is a second chance to describe a panel
    /// differently on two screens.
    pub fn roster() -> Vec<Self> {
        ksx_core::templates::TEMPLATES
            .iter()
            .map(|t| Self {
                id: t.id.to_owned(),
                label: t.summary.to_owned(),
                detail: t.panel.to_owned(),
                players: (1..=t.players).collect(),
                // Asked of the template rather than matched on its id: "does
                // this bind anything" is a property of the rows, and a second
                // blank template would otherwise be offered as a working one.
                blank: t
                    .instantiate("probe", 1)
                    .map(|preset| preset.binds_nothing())
                    .unwrap_or(true),
            })
            .collect()
    }
}

/// `ksx pads`, presentation-shaped: the bus, its children, and both verbs'
/// preconditions in one read.
///
/// Composed sentences on purpose, like [`DevicesView`]'s `detail` and
/// [`StatusSnapshot`](crate::StatusSnapshot)'s driver lines: the wording of
/// "four XInput slots, two already taken" is a fact about ksx's own limits,
/// and a surface that re-derives it is a surface that will disagree with the
/// CLI about it (docs/SURFACES.md §1).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadsView {
    pub generated_at: String,
    /// One line: how many pads the bus is carrying.
    pub summary: String,
    /// The ViGEmBus devnode the children hang off — also the argument to the
    /// prune command. `None` when the bus has no present devnode.
    pub bus_instance_id: Option<String>,
    /// [`Self::bus_instance_id`] as a sentence, including the case where there
    /// is not one. A surface renders this; it does not compose it.
    #[serde(default)]
    pub bus_line: String,
    pub pads: Vec<VirtualPadRow>,
    /// Known splitter processes alive right now, as `name (pid N)` lines.
    /// Heuristic by nature — a third-party ViGEm feeder is invisible to it.
    pub owners: Vec<String>,
    /// [`Self::owners`] as a sentence — and, when the list is empty, the
    /// hedge the heuristic needs ("no KNOWN splitter", never "no owner").
    #[serde(default)]
    pub owners_line: String,
    /// Is emulation live? Both verbs refuse while it is: a spawn would fight
    /// the pads a player is holding, and a prune would yank them.
    pub session_running: bool,
    /// How many XInput slots Windows has (`ksx_core::MAX_XINPUT_SLOTS`).
    pub xinput_ceiling: u8,
    /// How many of those slots hold a pad right now — **any** pad on this
    /// machine, real or virtual, read from XInput itself
    /// (`ksx_platform::xinput::slots_in_use`).
    ///
    /// `None` means the reading FAILED. It is not zero, and a surface must
    /// not render it as zero: counting only ksx's own virtual pads is how a
    /// cabinet with two real wired Xbox pads gets told four more will be
    /// readable when the true answer is two.
    #[serde(default)]
    pub xinput_in_use: Option<u8>,
    /// **The ceiling, said out loud for this machine right now.** The reason
    /// this is a backend string and not a page's `if`: `ksx pads --count 8
    /// --persona xbox360` plugs eight pads and four of them are invisible to
    /// every game, and a surface must be able to say that BEFORE the button is
    /// pressed without knowing why four is the number. (The console says the
    /// same thing before its own plug, from the same constant — `ksx-backend`'s
    /// `pads::ceiling_warning`.)
    pub xinput_line: String,
    /// Does THIS process hold an administrator token? `None` = unanswerable.
    /// A prune restarts a bus device, which needs one; a page shows this
    /// before the click rather than after the refusal.
    pub elevated: Option<bool>,
    /// [`Self::elevated`] as a sentence, including the "this prune WILL be
    /// refused" consequence. Not neutral formatting — which is exactly why it
    /// is composed once here instead of twice, in two languages, on two
    /// surfaces that then disagree.
    #[serde(default)]
    pub elevation_line: String,
    /// The destructive panel's lead: what a prune removes, and that it takes
    /// every pad at once. Also not neutral formatting.
    #[serde(default)]
    pub confirm_line: String,
    /// The failed-read banner's HEADING — "ksx could not read the ViGEm bus."
    /// — set by [`Self::unreadable`] and empty on a read that answered.
    ///
    /// A field because the sentence used to exist twice: composed here, and
    /// hardcoded again as an `<h2>` in `PadsIsland.ts`. Two copies of one
    /// sentence in two languages is the drift docs/SURFACES.md §1a names, and
    /// a heading is not an exception to it — reword this constructor and a
    /// page with its own copy would keep announcing the old wording forever.
    #[serde(default)]
    pub unreadable_heading: String,
    pub prune: PrunePlanView,
    pub spawn: SpawnOffer,
}

impl PadsView {
    /// The view for a read that **failed** — which is not the same view as an
    /// empty bus, and must never render as one.
    ///
    /// This is the project's signature bug in miniature: a session once
    /// reported success while the arcade panel was dead, because a board fell
    /// back to a driver nobody had asked for. "I could not read this" and
    /// "there is nothing here" are different sentences and a user acts on
    /// them differently — the first sends them to `ksx doctor`, the second
    /// tells them the machine is fine.
    ///
    /// So every composed sentence here says the reading failed, and the spawn
    /// offer is REFUSED rather than served empty: an empty `<select>` beside a
    /// live Spawn button is a page inviting a click it cannot describe.
    pub fn unreadable(reason: &str) -> Self {
        let failed = "ksx could not read the ViGEm bus.";
        PadsView {
            generated_at: String::new(),
            summary: format!("{failed} Nothing below is a reading of this machine."),
            bus_instance_id: None,
            bus_line: format!("{failed} This is not a claim that the bus has no devnode."),
            pads: Vec::new(),
            owners: Vec::new(),
            owners_line: format!("{failed} Nothing is known about who holds the pads."),
            session_running: false,
            // A fact about Windows, not a reading of this machine — it stays
            // true whether or not the bus could be reached.
            xinput_ceiling: ksx_core::MAX_XINPUT_SLOTS,
            xinput_in_use: None,
            xinput_line: format!(
                "{failed} It cannot say how many XInput slots are free, or how many more pads a \
                 game would see."
            ),
            elevated: None,
            elevation_line: String::new(),
            confirm_line: String::new(),
            unreadable_heading: failed.to_owned(),
            prune: PrunePlanView {
                kind: "unreadable".to_owned(),
                count: 0,
                command: None,
                detail: format!("{failed} It cannot say what a prune would remove."),
            },
            spawn: SpawnOffer {
                counts: Vec::new(),
                personas: Vec::new(),
                holds: Vec::new(),
                note: String::new(),
                refused: Some(format!("{failed} {reason}")),
            },
        }
    }
}

/// One pad hanging off the bus.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VirtualPadRow {
    /// Full device instance id — what a prune removes, named exactly.
    pub instance_id: String,
    /// The id the persona guess was made from, so an `unknown pad` row is
    /// still actionable.
    pub hardware_id: String,
    /// What the bus says it is: `Xbox 360 pad`, `PlayStation (DS4) pad`, or
    /// `unknown pad`.
    pub persona: String,
    /// Does this pad hold one of the four XInput slots?
    pub xinput: bool,
}

/// What `ksx pads --prune` would do, as a page renders it.
///
/// The decision itself is the CLI's pure `plan_prune`; this is that plan on
/// the wire, so no surface re-decides "is a bus restart allowed right now".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrunePlanView {
    /// `nothing` | `no-bus` | `session-running` | `restart`. Stable strings —
    /// a surface keys its panels off these, not off the prose.
    #[serde(default)]
    pub kind: String,
    /// How many pads it would remove.
    pub count: usize,
    /// The command a user could run by hand instead, when one exists. A
    /// driver operation nobody can reproduce without ksx is one nobody can
    /// undo without ksx either.
    pub command: Option<String>,
    /// The paragraph the CLI prints. Too long for a flash (Studio caps those
    /// at 300 chars), which is exactly why it is a field and not a message.
    pub detail: String,
}

/// What a spawn may offer right now, every option already labelled with what
/// it will actually do.
///
/// The labels are the load-bearing part. "8" in a dropdown is a lie on a
/// machine with four XInput slots; "8 pads — only 4 readable, 4 invisible to
/// games" is the same click with the consequence attached, and putting that
/// sentence here rather than in a page is what stops the second surface from
/// disagreeing with the first.
///
/// **The first option in each list is the default**, because that is what a
/// `<select>` does with no further help — so the ordering here IS the default,
/// and there is no second field to keep in step with it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnOffer {
    pub counts: Vec<SpawnOption>,
    pub personas: Vec<SpawnOption>,
    pub holds: Vec<SpawnOption>,
    /// One sentence saying what a spawn will do, in advance — including the
    /// fact that it unplugs itself when the hold expires.
    pub note: String,
    /// Why a spawn must not be offered at all right now (`None` = offer it).
    pub refused: Option<String>,
}

/// One `<option>`: the value that goes on the wire, and what it means.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnOption {
    pub value: String,
    pub label: String,
}

/// `ksx pads --count N --persona P` as a typed spec.
///
/// `hold_secs` is not optional and not a detail: a console run ends at Ctrl+C
/// and a web click has no Ctrl+C, so every caller states when the pads go
/// away. See [`MachineSource::pads`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadsSpawnSpec {
    pub count: u8,
    /// A [`ksx_core::Persona`] name — `xbox360`, `playstation`, … Parsed by
    /// the implementation with the same lenient parser the CLI uses, so a
    /// surface never has to carry the alias table.
    pub persona: String,
    /// Seconds to hold the pads up before they unplug themselves.
    pub hold_secs: u64,
}

/// `ksx autostart --status`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutostartView {
    pub registered: bool,
    /// The one line the status panel prints.
    pub line: String,
    /// What it would start: `daemon` / `run` / an unrecognized command line.
    pub mode: Option<String>,
    /// The games.toml profile it is pointed at, if any.
    pub profile: Option<String>,
    /// **The registration exists but will not do what it says** -
    /// `ksx_platform::autostart::Staleness`, flattened to the one question a
    /// surface asks. The failure it catches is silent: ksx is reinstalled, the
    /// task keeps the old path, and the cabinet cold-boots to a desktop weeks
    /// later with nothing on screen to say why.
    #[serde(default)]
    pub stale: bool,
    /// Why, when it is. Composed here rather than reflected from
    /// `Staleness::message`, whose remedy sentence names a CLI command - the
    /// exact thing `FIRST-RUN.md` §6 says a surface must never be reduced to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_detail: Option<String>,
}

/// What a first-run surface may ask of the logon task: on, or off.
///
/// Deliberately NOT the CLI's option set. `ksx autostart` carries `--mode`,
/// `--game`, `--delay-secs` and `--task-name` because somebody scripting a
/// cabinet build needs them. Somebody finishing their first setup does not,
/// and each knob offered here is one more that can be set wrong on the single
/// screen whose whole promise is that it cannot be. Enabling registers the
/// tray daemon at the default delay under the default task name - what
/// `ksx autostart --enable` does with no flags.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutostartSpec {
    /// On or off. Re-enabling an already-registered task REWRITES it, which is
    /// also how a stale registration is repaired.
    pub enable: bool,
    /// The user ticked the box. Mirrors the WinUSB specs' consent fields for
    /// the same reason: a bare POST is not consent.
    #[serde(default)]
    pub confirm: bool,
}

/// `ksx doctor`, presentation-shaped: the rows, plus the advice with its
/// stable codes and severities.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorView {
    pub generated_at: String,
    /// `(subject, line)` — ViGEmBus, Interception, the CI policy, the pads.
    pub rows: Vec<DoctorRow>,
    pub advice: Vec<AdviceRow>,
    /// The worst severity present: `ok` | `info` | `warning` | `critical`.
    pub worst: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorRow {
    pub subject: String,
    pub line: String,
}

/// One piece of advice, with the code the exit status derives from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdviceRow {
    /// The stable code (`vigem-missing`, `interception-inactive`, …).
    pub code: String,
    /// `info` | `warning` | `critical`.
    pub severity: String,
    pub message: String,
    /// The command that fixes it, when one exists — the same field, and the
    /// same obligation, as [`Refusal::remedy`](crate::Refusal::remedy).
    pub remedy: Option<String>,
}

// ---------------------------------------------------------------------------
// Controller outputs required by the currently staged personas
// ---------------------------------------------------------------------------

/// Stable states for [`ControllerOutputView::state`] and
/// [`ControllerOutputsView::state`].
pub mod controller_output_states {
    /// Every required machine prerequisite was proved before Play.
    pub const READY: &str = "ready";
    /// A required prerequisite is known not to work.
    pub const BLOCKED: &str = "blocked";
    /// The prerequisite could not be read. This is never treated as missing.
    pub const UNKNOWN: &str = "unknown";
    /// The installed prerequisite was proved, but the endpoint can be verified
    /// only as part of the transactional Play start.
    pub const VERIFIED_ON_PLAY: &str = "verified-on-play";
}

/// The exact board choice produced by a press-to-identify observation.
///
/// No raw instance path leaves the trusted provider/handler boundary. The
/// provider uses that path only to join the daemon observation to
/// [`DeviceScanView`], then returns the same typed selector, alias and human
/// label the picker already serves.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceIdentifyView {
    /// `ksx_core::DeviceSelector` spelling chosen by the backend.
    pub selector: String,
    /// Existing configured alias, otherwise the board's safe alias hint.
    pub alias: String,
    /// Friendly board name for confirmation copy.
    pub label: String,
}

/// Stable ViGEmBus codes shared with `ksx doctor`.
pub mod vigem_output_codes {
    pub const HEALTHY: &str = "";
    pub const MISSING: &str = "vigembus-missing";
    pub const FILE_MISSING: &str = "vigembus-file-missing";
    pub const NOT_RUNNING: &str = "vigembus-not-running";
    pub const STATE_UNKNOWN: &str = "vigembus-state-unknown";
}

/// The supported staged personas that require one output backend.
///
/// Canonical persona ids and customer labels are both carried so a surface
/// never parses or relabels them. Requirements are unique per backend and are
/// ordered by [`ksx_core::PadBackend::ALL`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerOutputRequirement {
    pub backend: String,
    pub label: String,
    pub personas: Vec<String>,
    pub persona_labels: Vec<String>,
}

/// Evidence for one output backend.
///
/// `/start` carries only rows the current stage requires. Status/System also
/// uses the HIDMaestro row as explicit system inventory; the persona list then
/// names what that installed prerequisite can support without implying one is
/// staged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerOutputView {
    pub backend: String,
    pub label: String,
    pub personas: Vec<String>,
    pub persona_labels: Vec<String>,
    /// A stable provider/detail code. ViGEm values are the same codes Doctor
    /// emits; HIDMaestro has `hidmaestro-*` equivalents.
    pub code: String,
    /// One of [`controller_output_states`].
    pub state: String,
    /// The machine prerequisite was read. `false` means unknown, never absent.
    pub readable: bool,
    /// Known unable to materialize the staged personas.
    pub blocked: bool,
    /// The read did not produce a verdict.
    pub unknown: bool,
    /// The installed prerequisite is present, but the endpoint is verified as
    /// part of Play. This is intentionally neither green nor red.
    pub verified_on_play: bool,
    /// Driver/package file version when the probe supplied one.
    pub version: Option<String>,
    pub line: String,
    /// No-terminal route first. Empty when there is no action to take.
    pub remedy: String,
}

/// The honest zero value: no provider answered, so no output is known ready.
impl Default for ControllerOutputView {
    fn default() -> Self {
        Self {
            backend: "unknown".to_owned(),
            label: "Controller output".to_owned(),
            personas: Vec::new(),
            persona_labels: Vec::new(),
            code: "controller-output-unreadable".to_owned(),
            state: controller_output_states::UNKNOWN.to_owned(),
            readable: false,
            blocked: false,
            unknown: true,
            verified_on_play: false,
            version: None,
            line: "The controller-output prerequisite has not been read. This does not mean a \
                   driver is missing."
                .to_owned(),
            remedy: NO_OUTPUT_READ_REMEDY.to_owned(),
        }
    }
}

impl ControllerOutputView {
    /// Build the ViGEm row from Doctor's own stable verdict.
    pub fn vigem(
        requirement: ControllerOutputRequirement,
        code: &str,
        version: Option<String>,
    ) -> Self {
        let subject = requirement_subject(&requirement);
        let base = Self::base(requirement, code, version.clone());
        match code {
            vigem_output_codes::HEALTHY => Self {
                state: controller_output_states::READY.to_owned(),
                readable: true,
                line: format!(
                    "ViGEmBus{} is installed and running for {subject}.",
                    version
                        .as_ref()
                        .map(|value| format!(" v{value}"))
                        .unwrap_or_default()
                ),
                ..base
            },
            vigem_output_codes::MISSING => Self {
                state: controller_output_states::BLOCKED.to_owned(),
                readable: true,
                blocked: true,
                line: format!(
                    "ViGEmBus is not installed, so ksx cannot create {subject} on this machine."
                ),
                remedy: INSTALL_VIGEM_REMEDY.to_owned(),
                ..base
            },
            vigem_output_codes::FILE_MISSING => Self {
                state: controller_output_states::BLOCKED.to_owned(),
                readable: true,
                blocked: true,
                line: format!(
                    "ViGEmBus is registered with Windows but its driver file is gone, so ksx \
                     cannot create {subject}."
                ),
                remedy: INSTALL_VIGEM_REMEDY.to_owned(),
                ..base
            },
            vigem_output_codes::NOT_RUNNING => Self {
                state: controller_output_states::BLOCKED.to_owned(),
                readable: true,
                blocked: true,
                line: format!(
                    "ViGEmBus is installed but not running, so ksx cannot create {subject} yet."
                ),
                remedy: "Restart Windows. If ViGEmBus is still stopped afterwards, run the ksx \
                         installer again and leave the ViGEmBus controller-driver task selected."
                    .to_owned(),
                ..base
            },
            vigem_output_codes::STATE_UNKNOWN => Self {
                state: controller_output_states::UNKNOWN.to_owned(),
                readable: true,
                unknown: true,
                line: format!(
                    "ViGEmBus is installed, but Windows did not report whether it is running, so \
                     readiness for {subject} is unknown."
                ),
                remedy: NO_OUTPUT_READ_REMEDY.to_owned(),
                ..base
            },
            other => Self {
                state: controller_output_states::UNKNOWN.to_owned(),
                readable: true,
                unknown: true,
                line: format!(
                    "ViGEmBus reported an unrecognized state (\"{other}\"), so readiness for \
                     {subject} is unknown."
                ),
                remedy: NO_OUTPUT_READ_REMEDY.to_owned(),
                ..base
            },
        }
    }

    /// Build the HIDMaestro row from the exact package/hash probe Doctor uses.
    ///
    /// `installed` proves the pinned package prerequisite. It does not promise
    /// that a virtual DualSense already exists: the protected host handshake
    /// and endpoint creation are intentionally transactional with Play.
    pub fn hidmaestro(
        requirement: ControllerOutputRequirement,
        installed: bool,
        partial: bool,
        version: Option<String>,
    ) -> Self {
        let subject = requirement_subject(&requirement);
        let base = Self::base(
            requirement,
            if installed {
                "hidmaestro-verified-on-play"
            } else if partial {
                "hidmaestro-partial"
            } else {
                "hidmaestro-missing"
            },
            version.clone(),
        );
        if installed {
            return Self {
                state: controller_output_states::VERIFIED_ON_PLAY.to_owned(),
                readable: true,
                verified_on_play: true,
                line: format!(
                    "The exact HIDMaestro package{} required for {subject} is installed. ksx \
                     verifies the protected controller endpoint when Play starts; no controller \
                     is running yet.",
                    version
                        .as_ref()
                        .map(|value| format!(" v{value}"))
                        .unwrap_or_default()
                ),
                ..base
            };
        }
        if partial {
            return Self {
                state: controller_output_states::BLOCKED.to_owned(),
                readable: true,
                blocked: true,
                line: format!(
                    "The HIDMaestro installation is incomplete or does not match the pinned \
                     package, so ksx cannot create {subject}."
                ),
                remedy: INSTALL_HIDMAESTRO_REMEDY.to_owned(),
                ..base
            };
        }
        Self {
            state: controller_output_states::BLOCKED.to_owned(),
            readable: true,
            blocked: true,
            line: format!(
                "HIDMaestro is not installed, so ksx cannot create {subject} on this machine."
            ),
            remedy: INSTALL_HIDMAESTRO_REMEDY.to_owned(),
            ..base
        }
    }

    /// Machine-inventory view for the one supported HIDMaestro lane.
    ///
    /// Unlike [`ControllerOutputsView::requirements`], this does not imply a
    /// DualSense is staged. It names the backend's supported personas because
    /// the Status/System panel inventories installed plumbing, while retaining
    /// the same package-versus-endpoint distinction the staged Play gate uses.
    pub fn hidmaestro_inventory(installed: bool, partial: bool, version: Option<String>) -> Self {
        Self::hidmaestro(
            output_requirement(ksx_core::PadBackend::HidMaestro, |_| true),
            installed,
            partial,
            version,
        )
    }

    /// The Status/System inventory could not read the HIDMaestro prerequisite.
    /// This remains unknown rather than being collapsed into "not installed".
    pub fn hidmaestro_inventory_unreadable(reason: impl std::fmt::Display) -> Self {
        Self::unreadable(
            output_requirement(ksx_core::PadBackend::HidMaestro, |_| true),
            reason,
        )
    }

    /// A provider refusal is a state of knowledge, not a missing driver.
    pub fn unreadable(
        requirement: ControllerOutputRequirement,
        reason: impl std::fmt::Display,
    ) -> Self {
        let subject = requirement_subject(&requirement);
        let code = format!("{}-unreadable", requirement.backend);
        Self {
            state: controller_output_states::UNKNOWN.to_owned(),
            readable: false,
            unknown: true,
            line: format!(
                "The output required by {subject} could not be checked ({reason}). That is not \
                 the same as its driver being missing."
            ),
            remedy: NO_OUTPUT_READ_REMEDY.to_owned(),
            ..Self::base(requirement, &code, None)
        }
    }

    fn base(requirement: ControllerOutputRequirement, code: &str, version: Option<String>) -> Self {
        Self {
            backend: requirement.backend,
            label: requirement.label,
            personas: requirement.personas,
            persona_labels: requirement.persona_labels,
            code: code.to_owned(),
            state: String::new(),
            readable: false,
            blocked: false,
            unknown: false,
            verified_on_play: false,
            version,
            line: String::new(),
            remedy: String::new(),
        }
    }
}

/// Readiness of exactly the output backends required by the current stage.
///
/// `ready` is deliberately stricter than `can_play`: HIDMaestro's exact
/// package check yields `verified_on_play`, not a false green `ready`, while
/// Play may still proceed and perform the authoritative host/endpoint check.
/// A provider read that failed is not evidence that the driver is missing, but
/// it still cannot license the Play button. A successful `verified-on-play`
/// preflight may proceed to the authoritative session transaction.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerOutputsView {
    pub required: Vec<ControllerOutputView>,
    /// Aggregate state, using blocked > unknown > verified-on-play > ready.
    pub state: String,
    pub readable: bool,
    pub ready: bool,
    pub can_play: bool,
    pub blocked: bool,
    pub unknown: bool,
    pub verified_on_play: bool,
    /// All required row facts, preserved in backend order for the existing
    /// scalar banner and non-JavaScript first paint.
    pub line: String,
    /// Unique row remedies in backend order.
    pub remedy: String,
}

impl Default for ControllerOutputsView {
    fn default() -> Self {
        Self {
            required: Vec::new(),
            state: controller_output_states::UNKNOWN.to_owned(),
            readable: false,
            ready: false,
            can_play: false,
            blocked: false,
            unknown: true,
            verified_on_play: false,
            line: "The controller outputs required by this setup have not been read. This does \
                   not mean a driver is missing."
                .to_owned(),
            remedy: NO_OUTPUT_READ_REMEDY.to_owned(),
        }
    }
}

impl ControllerOutputsView {
    /// Which output stacks this staged value actually requires. Unsupported
    /// personas cannot enter a valid stage and are intentionally excluded if a
    /// malformed external fixture constructs one by hand.
    pub fn requirements(staged: &crate::StagedSetupView) -> Vec<ControllerOutputRequirement> {
        if !staged.reachable {
            return Vec::new();
        }
        ksx_core::PadBackend::ALL
            .iter()
            .filter_map(|backend| {
                let requirement = output_requirement(*backend, |persona| {
                    staged
                        .slots
                        .iter()
                        .any(|slot| slot.persona == persona.as_str())
                });
                (!requirement.personas.is_empty()).then_some(requirement)
            })
            .collect()
    }

    /// Compose aggregate flags and copy from provider rows.
    pub fn from_required(required: Vec<ControllerOutputView>) -> Self {
        if required.is_empty() {
            return Self::not_required();
        }
        let blocked = required.iter().any(|row| row.blocked);
        let unknown = required.iter().any(|row| row.unknown);
        let verified_on_play = required.iter().any(|row| row.verified_on_play);
        let state = if blocked {
            controller_output_states::BLOCKED
        } else if unknown {
            controller_output_states::UNKNOWN
        } else if verified_on_play {
            controller_output_states::VERIFIED_ON_PLAY
        } else {
            controller_output_states::READY
        };
        let line = required
            .iter()
            .map(|row| row.line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let mut remedies = Vec::new();
        for row in &required {
            let remedy = row.remedy.trim();
            if !remedy.is_empty() && !remedies.iter().any(|known| known == &remedy) {
                remedies.push(remedy);
            }
        }
        // `remedies` borrows the rows in `required`; finish the aggregate
        // sentence before moving those rows into the returned view.
        let remedy = remedies.join(" ");
        Self {
            readable: required.iter().all(|row| row.readable),
            ready: state == controller_output_states::READY,
            can_play: !blocked && !unknown,
            blocked,
            unknown,
            verified_on_play,
            required,
            state: state.to_owned(),
            line,
            remedy,
        }
    }

    /// No staged supported persona means no output prerequisite. This is a
    /// successful empty requirement set, not an unread machine.
    pub fn not_required() -> Self {
        Self {
            required: Vec::new(),
            state: controller_output_states::READY.to_owned(),
            readable: true,
            ready: true,
            can_play: true,
            blocked: false,
            unknown: false,
            verified_on_play: false,
            line: "No controller output is required until a supported controller is staged."
                .to_owned(),
            remedy: String::new(),
        }
    }

    /// Preserve the stage's requirements when the provider read refuses.
    pub fn unreadable(staged: &crate::StagedSetupView, reason: impl std::fmt::Display) -> Self {
        let requirements = Self::requirements(staged);
        if requirements.is_empty() {
            return if staged.reachable && staged.slots.is_empty() {
                Self::not_required()
            } else {
                Self::default()
            };
        }
        let reason = reason.to_string();
        Self::from_required(
            requirements
                .into_iter()
                .map(|requirement| ControllerOutputView::unreadable(requirement, &reason))
                .collect(),
        )
    }

    /// Nothing needs saying only when no backend is required or every required
    /// backend is fully preflighted. `verified-on-play` remains visible because
    /// hiding it would turn a deferred check into a green promise.
    pub fn silent(&self) -> bool {
        self.state == controller_output_states::READY
    }
}

fn output_requirement(
    backend: ksx_core::PadBackend,
    include: impl Fn(ksx_core::Persona) -> bool,
) -> ControllerOutputRequirement {
    let personas: Vec<ksx_core::Persona> = ksx_core::Persona::ALL
        .iter()
        .copied()
        .filter(|persona| persona.can_plug() && persona.backend() == backend)
        .filter(|persona| include(*persona))
        .collect();
    ControllerOutputRequirement {
        backend: backend.as_str().to_owned(),
        label: backend.label().to_owned(),
        personas: personas
            .iter()
            .map(|persona| persona.as_str().to_owned())
            .collect(),
        persona_labels: personas
            .iter()
            .map(|persona| persona.label().to_owned())
            .collect(),
    }
}

fn requirement_subject(requirement: &ControllerOutputRequirement) -> String {
    match requirement.persona_labels.as_slice() {
        [] => "controller support".to_owned(),
        [only] => format!("{only} controllers"),
        many => format!("{} controllers", many.join(" and ")),
    }
}

pub const INSTALL_VIGEM_REMEDY: &str =
    "Run the ksx installer again and leave the ViGEmBus controller-driver task selected. The \
     driver is bundled with ksx; `ksx install-drivers --yes` from an administrator terminal is \
     the advanced equivalent.";

pub const INSTALL_HIDMAESTRO_REMEDY: &str =
    "Run the ksx installer again and leave the HIDMaestro DualSense-driver task selected. It \
     uses the pinned official package and may require internet access.";

pub const NO_OUTPUT_READ_REMEDY: &str =
    "Nothing needs to be installed based on this message alone. Reopen ksx to retry; the Start \
     menu's \"ksx (advanced) > driver check\" can show the detailed machine report.";

// ---------------------------------------------------------------------------
// First run, and the config in/out that has no path in it
// ---------------------------------------------------------------------------

/// Stable [`SetupStep::id`] values, in the order a first run performs them.
///
/// Named constants because a surface routes on them (the board step is a link
/// to the devices screen, the prove step is a button that starts the learner),
/// and a typo in a match arm would silently render a step nobody can act on.
pub mod setup_steps {
    /// Find the board and give it a name — one `[[device]]` entry.
    pub const BOARD: &str = "board";
    /// Point a slot at a preset — one `[[slot]]`, or one `[[game.slot]]`.
    pub const SLOT: &str = "slot";
    /// Press a button and watch ksx name it.
    pub const PROVE: &str = "prove";
}

/// Stable [`SetupStep::state`] values.
pub mod setup_states {
    /// Already true of this machine — nothing to do.
    pub const DONE: &str = "done";
    /// The next thing to do.
    pub const NOW: &str = "now";
    /// Real, but an earlier step has to happen first.
    pub const LATER: &str = "later";
}

/// The first run, as a surface reads it: what is already configured, and what
/// the next step is.
///
/// The `now` step is the backend's decision and every implementation owes the
/// same invariant — exactly one step is next, always. It is held where a real
/// implementation can be driven against it: `ksx-backend`'s
/// `onboard::exactly_one_step_is_next_for_every_state_of_the_machine`, which
/// runs `plan_steps` over every combination of the three counts. A hand-built
/// `SetupView` asserted against here would only test the `vec!` literal beside
/// it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupView {
    pub generated_at: String,
    /// **The split-or-freeze answer currently on disk** - a
    /// [`BlockingOption::name`]. Served because it is the one setting whose
    /// wrong value stays invisible until somebody is mid-game: a panel that was
    /// meant to be frozen and is not types into the chat box.
    #[serde(default)]
    pub blocking: String,
    /// The three answers, from `BlockingOption::roster()` - the same list
    /// `/start` asks with, so the two screens cannot word one question two
    /// ways.
    #[serde(default)]
    pub blocking_options: Vec<crate::stage::BlockingOption>,
    /// **The Studio theme id currently on disk**, or empty for System (follow
    /// the OS light/dark choice). The Studio owns the roster of valid ids and
    /// sanitizes at render time; this view reports what the config SAYS, so
    /// the setup page can show a choice the build does not ship instead of
    /// silently pretending it was never made.
    #[serde(default)]
    pub theme: String,
    /// What opposite directions can be made to do, per slot. Served for the
    /// same reason the blocking answers are: the wording is the domain's.
    #[serde(default)]
    pub socd_options: Vec<crate::stage::SocdOption>,
    /// Controller identities this build knows, with the same build-capability
    /// flags, immutable output backend and persona-specific ceiling the guided
    /// `/start` flow uses. The setup surface renders only
    /// entries whose [`crate::stage::PersonaOption::can_plug`] is true; keeping
    /// the full roster here means every surface starts from the same answer and
    /// a newly implemented persona cannot be forgotten by this maintenance
    /// screen.
    #[serde(default = "default_persona_options")]
    pub persona_options: Vec<crate::stage::PersonaOption>,
    /// **Support detail, never an interface.** A person setting a cabinet up
    /// does not operate on a directory — they import, export, and follow the
    /// steps. This is here so a bug report can quote it, and it belongs in
    /// small print.
    pub config_root: String,
    /// A `config.toml` (or `config.json`) is really on disk. `false` is the
    /// first-run state, and it is not an error.
    pub config_exists: bool,
    /// `[[device]]` entries — the boards this cabinet has been told about.
    pub devices: Vec<SetupDeviceRow>,
    /// Every wired slot, from `config.toml` and from every games.toml profile.
    pub slots: Vec<SetupSlotRow>,
    /// Preset names on disk.
    pub presets: Vec<String>,
    /// games.toml profile titles.
    pub profiles: Vec<String>,
    /// The onboarding checklist, ordered, with exactly one step in
    /// [`setup_states::NOW`] while anything is left to do.
    pub steps: Vec<SetupStep>,
    /// Anything the read has to say out loud (a games.toml that would not
    /// parse) — rendered, never swallowed.
    pub notes: Vec<String>,
    /// **The highest slot number this build accepts** — `ksx_core::MAX_SLOTS`,
    /// carried so a surface can offer the slots the daemon would actually take.
    ///
    /// Here rather than in the view code for the reason docs/SURFACES.md §1
    /// gives: "which slots exist" is a decision about configuration, and a
    /// surface that answers it from a constant of its own is a second copy of
    /// the rule. Task #17 lifted this number from an arbitrary 8 and had to
    /// chase three frozen `1..=8` literals to do it; a menu built from this
    /// field cannot become the fourth.
    #[serde(default = "default_max_slots")]
    pub max_slots: u8,
}

/// The ceiling a document that predates the field gets — the real one, never
/// zero. A missing field means "an older ksx wrote this", not "no slots".
fn default_max_slots() -> u8 {
    ksx_core::MAX_SLOTS
}

fn default_persona_options() -> Vec<crate::stage::PersonaOption> {
    crate::stage::PersonaOption::roster()
}

impl Default for SetupView {
    /// Hand-written for one field: `max_slots` defaults to the ceiling this
    /// build really has. A derived `Default` would hand every caller a zero,
    /// and a zero renders as a slot menu with nothing in it.
    fn default() -> Self {
        Self {
            generated_at: String::new(),
            // The roster, not an empty list: a page that offered no answers
            // would render the question as unanswerable rather than unread.
            blocking: String::new(),
            blocking_options: crate::stage::BlockingOption::roster(),
            theme: String::new(),
            socd_options: crate::stage::SocdOption::roster(),
            persona_options: default_persona_options(),
            config_root: String::new(),
            config_exists: false,
            devices: Vec::new(),
            slots: Vec::new(),
            presets: Vec::new(),
            profiles: Vec::new(),
            steps: Vec::new(),
            notes: Vec::new(),
            max_slots: default_max_slots(),
        }
    }
}

/// One `[[device]]` entry, as the setup page shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupDeviceRow {
    /// The name the user gave it — what slots refer to.
    pub alias: String,
    /// The selector it resolves through. Long and machine-shaped: small print.
    pub id: String,
    /// `interception` | `winusb`.
    pub backend: String,
}

/// One wired slot.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupSlotRow {
    pub number: u8,
    /// The `[[device]]` alias (or the raw selector, in a games.toml profile),
    /// or `(any)` when the slot takes whatever is plugged in.
    pub device: String,
    pub preset: String,
    pub persona: String,
    /// What opposite directions do on this slot - a `ksx_core::Socd` name.
    /// Shown so a row states its own policy instead of leaving it invisible.
    #[serde(default)]
    pub socd: String,
    /// `config.toml`, or the games.toml profile title this slot lives in.
    pub source: String,
}

/// One step of the first run.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStep {
    /// One of [`setup_steps`] — what a surface routes on.
    pub id: String,
    pub title: String,
    /// What is true about this step RIGHT NOW, in one sentence.
    pub detail: String,
    /// One of [`setup_states`].
    pub state: String,
}

/// What to export. Empty `what` is the whole root.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportRequest {
    /// `config` | `games` | `presets`; empty = all three.
    #[serde(default)]
    pub what: Vec<String>,
}

/// One exported document, held in memory rather than written anywhere.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigExport {
    /// A suggested name for whatever the surface does with the bytes.
    pub filename: String,
    /// The document — interop JSON (TOML stays canonical on disk).
    pub document: String,
    pub bytes: usize,
    /// Which parts it carries: `config`, `games`, `presets`.
    pub parts: Vec<String>,
    /// How many presets travelled with it.
    pub presets: usize,
    /// Anything the read had to say (unknown keys in a file, a shadowed
    /// `.json`) — said out loud, never swallowed.
    pub warnings: Vec<String>,
}

/// One import attempt. `apply` false — the default — is a DRY RUN.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportRequest {
    /// The document itself. A bare (un-enveloped) document needs `what` to
    /// name what it is, exactly as the CLI does — importing the wrong file
    /// over the wrong file is the failure this verb exists to prevent.
    pub document: String,
    #[serde(default)]
    pub what: Vec<String>,
    /// **Write.** Absent or false reports what would happen and changes
    /// nothing.
    #[serde(default)]
    pub apply: bool,
    /// Write even though validation found faults (advisories never block).
    #[serde(default)]
    pub force: bool,
}

/// What an import did, or would do.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    /// The verb ended the way it was asked to. A DRY RUN with a clean plan is
    /// `true`; a write refused by validation faults and a write that stopped
    /// half way are both `false`.
    ///
    /// A separate field from [`applied`](Self::applied) so no surface has to
    /// re-derive "did this go wrong" from two other booleans and get it
    /// subtly different from the next surface.
    pub ok: bool,
    /// Files were really written. `false` is a dry-run report — or a refusal.
    pub applied: bool,
    /// ONE sentence, short enough to survive a redirect's `?flash=` — the
    /// no-JavaScript path has nowhere else to put it.
    pub summary: String,
    /// The write that stopped a half-finished import. The paths in
    /// [`written`](Self::written) ARE on disk; the rest are not.
    pub error: Option<String>,
    pub parts: Vec<String>,
    /// Every file the import touches, whether or not it was applied.
    pub writes: Vec<ImportWrite>,
    /// Validation faults in the configuration this import would produce.
    /// Non-empty and `force` unset means nothing was written.
    pub faults: Vec<String>,
    /// Validation advisories — never blocking, always shown.
    pub advisories: Vec<String>,
    pub warnings: Vec<String>,
    /// Paths really written (empty on a dry run).
    pub written: Vec<String>,
    /// The `.bak-YYYYMMDD-HHMMSS` copies taken first — the road home.
    pub backups: Vec<String>,
}

/// One file an import touches.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportWrite {
    /// `config` | `games` | `presets`.
    pub part: String,
    pub path: String,
    /// `create` | `overwrite`.
    pub action: String,
    /// `toml` | `json` — the format the file KEEPS, not the document's.
    pub format: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **A failed read must not render as an empty bus.**
    ///
    /// Fails against the version this replaced, which handed surfaces a
    /// `PadsView::default()` when the provider refused: every composed
    /// sentence came out either blank or, worse, an assertion of absence —
    /// the devnode line read "none present — ViGEmBus is not installed" about
    /// a bus ksx had never managed to look at, and the spawn offer arrived
    /// un-refused with three empty dropdowns beside a live button.
    #[test]
    fn an_unreadable_view_says_so_everywhere_and_asserts_nothing() {
        let view = PadsView::unreadable("the pipe did not answer");
        let default = PadsView::default();

        for (what, line) in [
            ("summary", &view.summary),
            ("bus_line", &view.bus_line),
            ("owners_line", &view.owners_line),
            ("xinput_line", &view.xinput_line),
            ("prune.detail", &view.prune.detail),
            // The banner's heading is composed HERE, once — the page renders
            // it and owns no copy of the sentence.
            ("unreadable_heading", &view.unreadable_heading),
        ] {
            assert!(
                line.contains("could not read"),
                "{what} must say the read failed, got: {line}"
            );
            assert_ne!(
                line,
                &"".to_string(),
                "{what} must not be blank — a blank line says nothing at all"
            );
            assert!(
                !line.contains("not installed") && !line.contains("no known splitter"),
                "{what} asserts an absence about a machine ksx never read: {line}"
            );
        }

        // The occupancy is UNKNOWN, not free.
        assert_eq!(view.xinput_in_use, None);
        // A verb must not be offered when the page cannot describe it.
        assert!(
            view.spawn
                .refused
                .is_some_and(|r| r.contains("the pipe did not answer")),
            "a spawn offer with empty menus and no refusal is a live button with no meaning"
        );
        assert!(view.spawn.counts.is_empty());
        // …and the prune's kind is its own state, so no panel keyed on
        // "nothing" (the empty-bus kind) can render for a failed read.
        assert_eq!(view.prune.kind, "unreadable");
        assert_ne!(view.prune.kind, default.prune.kind);
    }

    /// A surface that implements nothing still SAYS something, per call, with
    /// the command that works — the CONTROL-SURFACE invariant, as a default.
    #[test]
    fn every_unimplemented_machine_verb_names_the_command_that_works() {
        struct Nothing;
        impl MachineSource for Nothing {}

        let checks: Vec<(&str, Refusal)> = vec![
            ("ksx devices", Nothing.devices().unwrap_err()),
            ("ksx device scan", Nothing.device_scan().unwrap_err()),
            (
                "ksx panel status",
                Nothing
                    .panel_status(&PanelStatusSpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx panel chart",
                Nothing.panel_chart(&PanelChartSpec::default()).unwrap_err(),
            ),
            (
                "ksx panel backups",
                Nothing
                    .panel_backups(&PanelBackupsSpec::default())
                    .unwrap_err(),
            ),
            (
                "Encoder setup",
                Nothing.panel_hardware_profiles().unwrap_err(),
            ),
            (
                "Encoder setup",
                Nothing
                    .panel_hardware_profile_save(&PanelHardwareProfileSaveSpec::default())
                    .unwrap_err(),
            ),
            (
                "Encoder setup",
                Nothing
                    .panel_hardware_profile_delete(&PanelHardwareProfileDeleteSpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx panel program",
                Nothing
                    .panel_program_plan(&PanelProgramSpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx panel program",
                Nothing
                    .panel_program(&PanelProgramApplySpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx panel restore",
                Nothing
                    .panel_restore_plan(&PanelRestoreSpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx panel restore",
                Nothing
                    .panel_restore(&PanelRestoreApplySpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx device pick",
                Nothing.device_pick(&DevicePickSpec::default()).unwrap_err(),
            ),
            (
                "ksx device remove",
                Nothing
                    .device_remove(&DeviceRemoveSpec::default())
                    .unwrap_err(),
            ),
            ("ksx preset list", Nothing.presets().unwrap_err()),
            (
                "ksx preset new",
                Nothing.preset_new(&NewPreset::default()).unwrap_err(),
            ),
            ("ksx config export", Nothing.profiles().unwrap_err()),
            // These verbs have no CLI. Their defaults still give a
            // consumer-neutral way forward instead of inventing a command.
            (
                "profile management",
                Nothing.profile_new(&NewProfile::default()).unwrap_err(),
            ),
            (
                "profile management",
                Nothing
                    .profile_update(&UpdateProfile::default())
                    .unwrap_err(),
            ),
            (
                "profile management",
                Nothing
                    .profile_delete(&DeleteProfile::default())
                    .unwrap_err(),
            ),
            ("ksx autostart", Nothing.autostart().unwrap_err()),
            ("ksx doctor", Nothing.doctor().unwrap_err()),
            ("ksx winusb status", Nothing.winusb().unwrap_err()),
            (
                "ksx pads",
                Nothing
                    .pads(&PadsSpawnSpec {
                        count: 4,
                        persona: "xbox360".into(),
                        hold_secs: 10,
                    })
                    .unwrap_err(),
            ),
            ("ksx pads --prune", Nothing.pads_view(false).unwrap_err()),
            ("ksx pads --prune", Nothing.pads_prune(false).unwrap_err()),
            ("ksx winusb claim", Nothing.winusb_claim("ID").unwrap_err()),
            (
                "ksx winusb claim",
                Nothing
                    .winusb_prepare(&WinusbPrepareSpec::default())
                    .unwrap_err(),
            ),
            (
                "ksx winusb release",
                Nothing
                    .winusb_release(&WinusbReleaseSpec::default())
                    .unwrap_err(),
            ),
            ("ksx setup", Nothing.setup_state().unwrap_err()),
            (
                "ksx config export",
                Nothing
                    .config_export(&ExportRequest::default())
                    .unwrap_err(),
            ),
            (
                "ksx config import",
                Nothing
                    .config_import(&ImportRequest::default())
                    .unwrap_err(),
            ),
        ];
        for (command, refusal) in checks {
            assert_eq!(refusal.code, crate::refusal::codes::NOT_HERE);
            let remedy = refusal.remedy.as_deref().unwrap_or_default();
            assert!(
                remedy.contains(command),
                "the refusal for {command} must name it: {refusal}"
            );
        }
    }

    #[test]
    fn panel_apply_contract_requires_reviewed_identity_and_profile_and_defaults_unsupervised() {
        let obsolete_program = serde_json::json!({
            "program": {
                "expected_base_sha256": "A".repeat(64),
                "layout": "canonical-four-player",
                "edits": []
            },
            "expected_desired_sha256": "B".repeat(64),
            "confirm": true
        });
        assert!(
            serde_json::from_value::<PanelProgramApplySpec>(obsolete_program).is_err(),
            "an older apply request without its reviewed board/profile must fail closed"
        );

        let program: PanelProgramApplySpec = serde_json::from_value(serde_json::json!({
            "program": {
                "expected_base_sha256": "A".repeat(64),
                "layout": "canonical-four-player",
                "edits": []
            },
            "expected_desired_sha256": "B".repeat(64),
            "expected_board_fingerprint": "D209:0430:bcd0056:MI_02:fixture",
            "expected_protocol_profile": "ipac4-pac256-v1",
            "confirm": true
        }))
        .unwrap();
        assert_eq!(
            program.expected_board_fingerprint,
            "D209:0430:bcd0056:MI_02:fixture"
        );
        assert_eq!(program.expected_protocol_profile, "ipac4-pac256-v1");
        assert!(program.confirm);
        assert!(
            !program.supervised,
            "omitting the acknowledgement must never imply supervision"
        );

        let restore: PanelRestoreApplySpec = serde_json::from_value(serde_json::json!({
            "restore": {
                "backup_id": "backup-20260823",
                "expected_current_sha256": "C".repeat(64)
            },
            "expected_desired_sha256": "D".repeat(64),
            "expected_board_fingerprint": "D209:0430:bcd0056:MI_02:fixture",
            "expected_protocol_profile": "ipac4-pac256-v1",
            "confirm": true,
            "supervised": true
        }))
        .unwrap();
        assert!(restore.confirm && restore.supervised);
    }

    #[test]
    fn panel_terminal_shift_state_never_collapses_opaque_into_disabled() {
        let disabled = PanelTerminalRow {
            shift_state: PanelShiftState::Disabled,
            is_shift: false,
            ..Default::default()
        };
        let opaque = PanelTerminalRow {
            // The compatibility boolean is deliberately identical. The
            // explicit state is the mutation-safety contract.
            shift_state: PanelShiftState::Opaque,
            is_shift: false,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(disabled).unwrap()["shift_state"],
            "disabled"
        );
        assert_eq!(
            serde_json::to_value(opaque).unwrap()["shift_state"],
            "opaque"
        );
        assert_eq!(PanelShiftState::default(), PanelShiftState::Opaque);
        let older: PanelTerminalRow = serde_json::from_value(serde_json::json!({
            "terminal_id": "1sw4",
            "terminal_label": "Player 1 · Button 4",
            "player": 1,
            "kind": "button",
            "normal": { "code": 13, "key": "J", "label": "J", "supported": true },
            "shifted": { "code": 0, "label": "Unassigned", "supported": true },
            "is_shift": false
        }))
        .unwrap();
        assert_eq!(
            older.shift_state,
            PanelShiftState::Opaque,
            "an older false-only row must fail closed rather than imply disabled"
        );

        let older_key: PanelKeyOption = serde_json::from_value(serde_json::json!({
            "key": "Escape",
            "label": "Escape",
            "code": 41
        }))
        .unwrap();
        assert!(
            !older_key.safe_for_qualification,
            "missing first-write policy metadata must fail closed"
        );

        let mut older_chart = serde_json::to_value(PanelChartView::default()).unwrap();
        older_chart
            .as_object_mut()
            .unwrap()
            .remove("recommended_terminals");
        let older_chart: PanelChartView = serde_json::from_value(older_chart).unwrap();
        assert!(
            older_chart.recommended_terminals.is_empty(),
            "older chart responses remain readable, but cannot invent a backend-owned recommendation"
        );
    }

    #[test]
    fn profile_update_and_delete_requests_are_serde_compatible() {
        let update: UpdateProfile = serde_json::from_str(
            r#"{"original_title":"Existing Game","title":"Example Game","path":"C:\\\\example-game.exe","slots":2,"preset":"Arcade"}"#,
        )
        .unwrap();
        assert_eq!(update.arguments, "");
        assert_eq!(update.revision, "", "old clients deserialize safely");
        assert!(!update.rebase_devices, "preservation is the wire default");
        let delete: DeleteProfile = serde_json::from_str(
            &serde_json::to_string(&DeleteProfile {
                title: "Example Game".to_owned(),
                revision: "g1-test".to_owned(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(delete.title, "Example Game");
        assert_eq!(delete.revision, "g1-test");

        let old_layout: PresetRow = serde_json::from_str(
            r#"{"name":"Arcade","bound":20,"macros":0,"protected":false,"source":"Arcade"}"#,
        )
        .unwrap();
        assert!(old_layout.usable, "omission is the compatibility default");
        assert_eq!(old_layout.problem, None);
    }

    /// Both enumerations answered — the ordinary machine.
    fn scan(available: bool, boards: Vec<BoardRow>) -> DeviceScanView {
        DeviceScanView::read(
            "t".to_owned(),
            available,
            available,
            available,
            boards,
            Vec::new(),
            Vec::new(),
        )
    }

    fn configured(devices: Vec<ConfiguredDevice>) -> DeviceScanView {
        DeviceScanView::read(
            "t".to_owned(),
            true,
            true,
            true,
            Vec::new(),
            devices,
            Vec::new(),
        )
    }

    fn keyboard_board() -> BoardRow {
        BoardRow {
            name: "Ultimarc I-PAC 4X".to_owned(),
            keyboard: Some("USB\\VID_D209&PID_0430&MI_00\\X".to_owned()),
            ..BoardRow::default()
        }
    }

    #[test]
    fn a_board_role_has_stable_wire_words_and_an_old_row_defaults_to_keyboard() {
        assert_eq!(
            serde_json::to_string(&BoardRole::PanelEncoder).unwrap(),
            r#""panel-encoder""#
        );

        let mut old_row = serde_json::to_value(BoardRow::default()).unwrap();
        old_row
            .as_object_mut()
            .expect("board row object")
            .remove("role");
        let decoded: BoardRow = serde_json::from_value(old_row).unwrap();
        assert_eq!(decoded.role, BoardRole::Keyboard);
    }

    /// **A surface picks a board by SELECTOR, and it never derives one.**
    ///
    /// `docs/FIRST-RUN.md` §5 makes the human name the identifier on screen and
    /// §6 forbids ever asking anyone for a device path, so what a picked row
    /// sends back has to be the id ksx would write — and it has to arrive
    /// already chosen, because the choice is *which of a board's devnodes
    /// carries the keys* and [`BoardRow::keyboard`] is where that was decided.
    ///
    /// Breaks against a surface that reached into `interfaces` for itself: the
    /// obvious implementation takes `interfaces[0].selector`, which on the
    /// reference I-PAC is the AUX devnode — a selector that resolves, captures
    /// nothing, and looks correct on screen. It also breaks against filling the
    /// field on an unpickable board, which offers a choice `add_slot` then
    /// refuses.
    #[test]
    fn a_board_carries_the_selector_and_the_alias_a_pick_would_use() {
        let kb = "USB\\VID_D209&PID_0430&MI_00\\X";
        let aux = "USB\\VID_D209&PID_0430&MI_01\\X";
        let iface = |id: &str, selector: &str| UsbRow {
            instance_id: id.to_owned(),
            selector: Some(selector.to_owned()),
            ..UsbRow::default()
        };
        // The AUX devnode is FIRST, which is the ordering that catches a
        // surface reaching for `interfaces[0]`.
        let board = BoardRow {
            interfaces: vec![
                iface(aux, "usb:d209:0430:01"),
                iface(kb, "usb:d209:0430:00"),
            ],
            ..keyboard_board()
        };
        let no_keyboard = BoardRow {
            name: "Example auxiliary controller".to_owned(),
            keyboard: None,
            interfaces: vec![iface("USB\\VID_F00D&PID_CAFE&MI_01\\X", "usb:f00d:cafe:01")],
            ..BoardRow::default()
        };

        let view = scan(true, vec![board, no_keyboard]);
        assert_eq!(view.boards[0].selector.as_deref(), Some("usb:d209:0430:00"));
        assert_eq!(
            view.boards[1].selector, None,
            "a board that cannot be picked must not be handed a selector to pick it with"
        );

        // The alias is the one `plan_pick` would write: the board's name when
        // nothing is configured, and the name the USER gave it when something
        // is — renaming orphans every [[slot]] that refers to the old alias.
        assert_eq!(view.boards[0].alias_hint, "Ultimarc I-PAC 4X");
        let configured = scan(
            true,
            vec![BoardRow {
                alias: Some("panel".to_owned()),
                ..keyboard_board()
            }],
        );
        assert_eq!(configured.boards[0].alias_hint, "panel");
    }

    /// **A refused read must not render as an assertion of absence.**
    ///
    /// FAILS against the shipped `/devices` seam, which computed
    /// `no_pickable_board_found` as `pickable == 0` and never consulted
    /// `usb_available` — so a machine whose USB enumeration DIED was told "no
    /// keyboard-capable board found" while the banner above it said nothing
    /// could be read. On a populated setup that sentence can be wrong about
    /// several boards at once.
    #[test]
    fn a_failed_enumeration_is_never_an_empty_machine() {
        let blind = scan(false, Vec::new());
        assert!(
            !blind.no_pickable_board_found,
            "an unreadable machine licensed a surface to say the machine is empty"
        );
        assert_ne!(blind.boards_summary, NO_BOARDS_LINE);
        assert!(blind.boards_summary.contains("nothing could be READ"));

        // …and the ordinary empty machine still says its own, different
        // sentence. Without this half the bug could be "fixed" by never
        // answering the question at all.
        let empty = scan(true, Vec::new());
        assert!(empty.no_pickable_board_found);
        assert_eq!(empty.boards_summary, NO_BOARDS_LINE);

        // The two states must not be spelled the same way anywhere.
        assert_ne!(blind.boards_summary, empty.boards_summary);
    }

    /// **Half a read is not a whole one.** USB answered and Bluetooth did not:
    /// the count of what WAS found is still true and still printed, but the
    /// page may not conclude "nothing here" and must name the missing half.
    ///
    /// FAILS against the single `usb_available` flag this view shipped with:
    /// with Bluetooth enumeration dead and USB fine, `no_pickable_board_found`
    /// was `true` on a machine whose Bluetooth keyboard was sitting right there
    /// — the same class of confident wrong answer the USB flag was added to
    /// stop, one transport later.
    #[test]
    fn one_failed_transport_never_licenses_the_empty_machine_sentence() {
        let usb_only = DeviceScanView::read(
            "t".to_owned(),
            true,
            true,
            false,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );
        assert!(
            !usb_only.no_pickable_board_found,
            "the Bluetooth half was never read, so the machine was not read"
        );
        assert_ne!(usb_only.boards_summary, NO_BOARDS_LINE);
        assert!(
            usb_only
                .boards_summary
                .contains("Bluetooth enumeration failed"),
            "the missing half must be named: {}",
            usb_only.boards_summary
        );
        assert!(
            usb_only.boards_summary.contains("not evidence"),
            "absence from a list nobody could read is not evidence: {}",
            usb_only.boards_summary
        );

        let bt_only = DeviceScanView::read(
            "t".to_owned(),
            true,
            false,
            true,
            vec![keyboard_board()],
            Vec::new(),
            Vec::new(),
        );
        assert!(!bt_only.no_pickable_board_found);
        assert!(
            bt_only.boards_summary.contains("USB enumeration failed"),
            "{}",
            bt_only.boards_summary
        );
        assert!(
            bt_only.boards_summary.contains("1 keyboard-capable device"),
            "what WAS found is still true and still printed: {}",
            bt_only.boards_summary
        );
        // The three failure shapes must not be spelled the same way.
        assert_ne!(usb_only.boards_summary, bt_only.boards_summary);
        assert_ne!(usb_only.boards_summary, UNREAD_BOARDS_LINE);
    }

    /// **The permanent case, told apart from the not-yet case.**
    ///
    /// `backend = "winusb"` on an unclaimed USB board is a claim someone has
    /// not performed yet, and the advice is to perform it. The same line on a
    /// Bluetooth device is a claim that can NEVER be performed, and repeating
    /// "run `ksx winusb claim`" would send that user to a command that refuses
    /// forever.
    ///
    /// FAILS against the shipped `device_health`, which had one sentence for
    /// both and no idea what transport the entry resolved to.
    #[test]
    fn a_winusb_entry_on_bluetooth_is_told_no_claim_can_ever_fix_it() {
        let bt = configured(vec![ConfiguredDevice {
            transport: "bluetooth".to_owned(),
            ..loose_winusb_entry(vec!["slot 1 (keyboard)".to_owned()])
        }]);
        let line = &bt.configured[0].health_line;
        assert!(line.contains("Bluetooth"), "{line}");
        assert!(
            line.contains("no USB interface to bind"),
            "the transport fact, not a vague 'unsupported': {line}"
        );
        assert!(
            line.contains("interception"),
            "and the backend that CAN capture it: {line}"
        );
        assert!(
            !line.contains("ksx winusb claim"),
            "never advise a command that refuses forever: {line}"
        );
        assert_eq!(bt.configured[0].health_level, "warn");

        // The USB entry beside it keeps the recoverable wording.
        let usb = configured(vec![ConfiguredDevice {
            transport: "usb".to_owned(),
            ..loose_winusb_entry(vec!["slot 1 (keyboard)".to_owned()])
        }]);
        assert!(usb.configured[0].health_line.contains("refuses to start"));
        assert_ne!(usb.configured[0].health_line, *line);
    }

    /// A board's transport and backend eligibility come from the interface a
    /// pick would NAME — its keyboard — not from whichever devnode enumerated
    /// first. On an I-PAC that is the difference between describing MI_00 and
    /// describing the vendor collection on MI_02.
    #[test]
    fn a_boards_transport_is_the_one_its_keyboard_interface_is_on() {
        let vendor_iface = UsbRow {
            instance_id: "USB\\VID_D209&PID_0430&MI_02\\X".to_owned(),
            transport: "usb".to_owned(),
            backends: "wrong row".to_owned(),
            ..UsbRow::default()
        };
        let keyboard_iface = UsbRow {
            instance_id: "USB\\VID_D209&PID_0430&MI_00\\X".to_owned(),
            transport: "usb".to_owned(),
            interception_eligible: true,
            winusb_eligible: true,
            backends: "the keyboard's line".to_owned(),
            can_type: true,
            ..UsbRow::default()
        };
        let view = scan(
            true,
            vec![BoardRow {
                // Deliberately NOT first in the list.
                interfaces: vec![vendor_iface, keyboard_iface],
                ..keyboard_board()
            }],
        );
        assert_eq!(view.boards[0].backends, "the keyboard's line");
        assert!(view.boards[0].winusb_eligible);
        assert!(view.boards[0].can_type);
    }

    /// A device with no keyboard interface still gets a transport, because
    /// half the reason it is listed at all is to answer "why is my device not
    /// in the picker" — and for a Bluetooth device the answer is a permanent
    /// one a user needs to read.
    #[test]
    fn a_device_with_no_keyboard_still_reports_its_transport() {
        let view = scan(
            true,
            vec![BoardRow {
                name: "Example Bluetooth Speaker".to_owned(),
                keyboard: None,
                interfaces: vec![UsbRow {
                    transport: "bluetooth".to_owned(),
                    backends: "Bluetooth · no backend".to_owned(),
                    ..UsbRow::default()
                }],
                ..BoardRow::default()
            }],
        );
        assert!(!view.boards[0].pickable);
        assert_eq!(view.boards[0].transport, "bluetooth");
        assert!(!view.boards[0].backends.is_empty());
    }

    /// The same distinction for the configured list, which is read from a file
    /// a refusal never gets as far as opening.
    #[test]
    fn an_unread_config_is_never_a_config_with_no_devices() {
        let unread = DeviceScanView::unreadable();
        assert!(!unread.no_configured_device);
        assert!(unread.configured_summary.contains("nothing could be READ"));

        let empty = scan(true, Vec::new());
        assert!(empty.no_configured_device);
        assert_ne!(unread.configured_summary, empty.configured_summary);
    }

    /// `Default` is the UNREADABLE view, not an empty machine. Every failure
    /// path in every surface reaches for it, so if it ever degrades into "there
    /// is nothing here" the bug comes back everywhere at once.
    #[test]
    fn the_default_view_claims_nothing_about_the_machine() {
        let default = DeviceScanView::default();
        assert_eq!(default, DeviceScanView::unreadable());
        assert!(!default.no_pickable_board_found);
        assert!(!default.no_configured_device);
    }

    /// The partition and the counts are the view's, not a surface's — and they
    /// agree with the rows, because the same call sets both.
    #[test]
    fn the_partition_and_the_counts_come_from_the_rows() {
        let view = scan(
            true,
            vec![
                keyboard_board(),
                BoardRow {
                    name: "Example auxiliary controller".to_owned(),
                    keyboard: None,
                    ..BoardRow::default()
                },
            ],
        );
        assert_eq!(view.pickable_boards, 1);
        assert_eq!(view.other_boards, 1);
        assert!(view.boards[0].pickable);
        assert!(!view.boards[1].pickable);
        assert!(view.boards_summary.starts_with("1 keyboard-capable board"));
        assert!(view.other_summary.starts_with("1 board has no keyboard"));
        assert!(!view.no_pickable_board_found);
    }

    fn loose_winusb_entry(used_by: Vec<String>) -> ConfiguredDevice {
        ConfiguredDevice {
            alias: "panel".to_owned(),
            backend: "winusb".to_owned(),
            present: true,
            claimed: false,
            used_by,
            ..ConfiguredDevice::default()
        }
    }

    /// **A verdict about `ksx run` must match what `ksx run` does.**
    ///
    /// FAILS against the shipped page, which showed "ksx run will refuse" for
    /// every present-unclaimed-winusb entry regardless of whether any slot
    /// named it. `run/plan.rs` builds `captureable` from slots' keyboards and
    /// `capture.rs` only raises `NotRebound` for ids that reached
    /// `plan.winusb` through it, so an entry no slot references starts cleanly
    /// — and the user was being sent to debug a working session.
    #[test]
    fn an_unreferenced_winusb_entry_is_not_told_the_session_refuses() {
        let orphan = configured(vec![loose_winusb_entry(Vec::new())]);
        let line = &orphan.configured[0].health_line;
        assert!(
            !line.contains("refuses to start"),
            "no slot names this alias, so nothing refuses: {line}"
        );
        assert!(
            line.contains("NOT claimed"),
            "the fault is still named: {line}"
        );
        assert_eq!(orphan.configured[0].health_level, "idle");

        // The same entry WITH a slot naming it is the real fault, and it must
        // still be called one — otherwise this fix is just silence.
        let named = configured(vec![loose_winusb_entry(vec![
            "slot 1 (keyboard)".to_owned()
        ])]);
        let line = &named.configured[0].health_line;
        assert!(line.contains("refuses to start"), "{line}");
        assert_eq!(named.configured[0].health_level, "warn");
    }

    /// An absent board gets no claim verdict at all: there is no binding to
    /// describe, and "on the Windows keyboard stack" about a board that is not
    /// plugged in is the same class of confident wrong answer.
    #[test]
    fn an_absent_board_gets_no_claim_verdict() {
        let view = configured(vec![ConfiguredDevice {
            alias: "panel".to_owned(),
            backend: "winusb".to_owned(),
            present: false,
            used_by: vec!["slot 1 (keyboard)".to_owned()],
            ..ConfiguredDevice::default()
        }]);
        assert_eq!(view.configured[0].health_line, "");
        assert_eq!(view.configured[0].health_level, "none");
    }

    /// An elevated command never travels without the word ELEVATED.
    ///
    /// The pair used to be assembled separately in `render_devices.rs` and in
    /// `DevicesIsland.ts`, which is two chances to ship the command with the
    /// wrong lead or no lead at all — and a `ksx winusb claim` line pasted
    /// without it produces one "access denied" and no explanation.
    #[test]
    fn a_shown_elevated_command_always_carries_its_lead() {
        let claimable = BoardRow {
            claim_command: Some("ksx winusb claim ID".to_owned()),
            ..keyboard_board()
        };
        let claimed = BoardRow {
            release_command: Some("ksx winusb release ID --yes".to_owned()),
            ..keyboard_board()
        };
        let neither = keyboard_board();
        let view = scan(true, vec![claimable, claimed, neither]);

        for board in &view.boards {
            assert_eq!(
                board.command.is_empty(),
                board.command_lead.is_empty(),
                "a command and its lead must appear and vanish together: {board:?}"
            );
            if !board.command.is_empty() {
                assert!(
                    board.command_lead.contains("ELEVATED"),
                    "{}",
                    board.command_lead
                );
            }
        }
        assert!(view.boards[0].command_lead.starts_with("To move it"));
        assert!(view.boards[1].command_lead.starts_with("It is claimed"));
        assert!(view.boards[2].command.is_empty());
    }

    /// A board that is merely HID gets the caveat; one that declares itself a
    /// keyboard does not. Without it "ksx could claim it" reads as a
    /// recommendation to claim a fan controller.
    #[test]
    fn only_a_board_that_does_not_declare_itself_a_keyboard_gets_the_caveat() {
        let view = scan(
            true,
            vec![
                BoardRow {
                    looks_like_a_keyboard: true,
                    ..keyboard_board()
                },
                BoardRow {
                    looks_like_a_keyboard: false,
                    ..keyboard_board()
                },
            ],
        );
        assert_eq!(view.boards[0].caveat, "");
        assert_eq!(view.boards[1].caveat, CAVEAT_NOT_A_KEYBOARD);
    }

    /// The derived fields are not settable past `read`: a fixture that builds
    /// the struct literally and then lies about the summary cannot exist,
    /// because `read` overwrites every one of them.
    #[test]
    fn read_overwrites_any_derived_field_it_is_handed() {
        let lying = BoardRow {
            keyboard: None,
            pickable: true,
            ..BoardRow::default()
        };
        let view = scan(true, vec![lying]);
        assert!(!view.boards[0].pickable);
        assert_eq!(view.pickable_boards, 0);
    }

    /// The import consent shape, as a TYPE rather than as a review note: an
    /// [`ImportRequest`] a surface builds — or deserializes from a form that
    /// simply omitted the box — writes nothing at all. `apply` has to be said.
    #[test]
    fn an_import_request_is_a_dry_run_until_someone_says_so() {
        assert!(!ImportRequest::default().apply);
        assert!(!ImportRequest::default().force);
        let off_the_wire: ImportRequest =
            serde_json::from_str(r#"{"document":"{}"}"#).expect("minimal request");
        assert!(
            !off_the_wire.apply && !off_the_wire.force,
            "a document with no consent fields must not write: {off_the_wire:?}"
        );
    }

    /// The slot ceiling a surface renders is THIS build's, never zero and never
    /// a number the view code picked.
    ///
    /// Two ways it can go wrong and both are covered: a derived `Default`
    /// (`max_slots: 0`, a slot menu with nothing in it) and a plain
    /// `#[serde(default)]` on the field, which turns a document written by an
    /// older ksx into the same zero. Either regression fails here; both were
    /// live in the version that hardcoded the menu at eight.
    ///
    /// (The old test in this slot built a `SetupView` with one `now` step and
    /// then asserted it had one `now` step — it tested the `vec!` literal three
    /// lines above it. The invariant it claimed to hold is really held in
    /// ksx-backend, against `plan_steps`; see [`SetupView`].)
    #[test]
    fn the_slot_ceiling_a_surface_renders_is_this_builds_max_slots() {
        assert_eq!(SetupView::default().max_slots, ksx_core::MAX_SLOTS);
        // Compile-time, because a runtime assert on a constant is vacuous
        // (clippy agrees): if this build's ceiling were zero, every menu
        // derived from it is meaningless before any test runs.
        const _: () = assert!(ksx_core::MAX_SLOTS > 0);

        // A document from a ksx that predates the field.
        let older: SetupView = serde_json::from_str(
            r#"{"generated_at":"","config_root":"","config_exists":false,
                 "devices":[],"slots":[],"presets":[],"profiles":[],"steps":[],"notes":[]}"#,
        )
        .expect("an older document must still deserialize");
        assert_eq!(
            older.max_slots,
            ksx_core::MAX_SLOTS,
            "a missing ceiling means 'an older ksx wrote this', not 'no slots'"
        );

        // …and it survives the round trip a surface actually makes.
        let wire = serde_json::to_string(&SetupView::default()).unwrap();
        let back: SetupView = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.max_slots, ksx_core::MAX_SLOTS);
    }

    /// A setup document written before controller choices were served still
    /// receives this build's canonical roster. An empty list would make the
    /// maintenance form look as though no controller identity exists.
    #[test]
    fn an_older_setup_view_receives_this_builds_persona_roster() {
        let older: SetupView = serde_json::from_str(
            r#"{"generated_at":"","config_root":"","config_exists":false,
                 "devices":[],"slots":[],"presets":[],"profiles":[],"steps":[],"notes":[]}"#,
        )
        .expect("an older document must still deserialize");
        assert_eq!(older.persona_options, crate::PersonaOption::roster());

        let defaults = SetupView::default();
        assert_eq!(defaults.persona_options, crate::PersonaOption::roster());
        assert!(defaults
            .persona_options
            .iter()
            .any(|option| { option.name == "dualsense" && option.can_plug }));
    }

    fn staged_personas(personas: &[&str]) -> crate::StagedSetupView {
        crate::StagedSetupView {
            reachable: true,
            slots: personas
                .iter()
                .enumerate()
                .map(|(index, persona)| crate::StagedSlotView {
                    number: u8::try_from(index + 1).unwrap(),
                    persona: (*persona).to_owned(),
                    ..crate::StagedSlotView::default()
                })
                .collect(),
            ..crate::StagedSetupView::default()
        }
    }

    fn requirement(staged: &crate::StagedSetupView, backend: &str) -> ControllerOutputRequirement {
        ControllerOutputsView::requirements(staged)
            .into_iter()
            .find(|requirement| requirement.backend == backend)
            .unwrap_or_else(|| panic!("no {backend} requirement"))
    }

    /// An output document nobody collected is unknown and cannot license Play.
    #[test]
    fn uncollected_outputs_are_unknown_not_missing_or_ready() {
        let row = ControllerOutputView::default();
        assert_eq!(row.state, controller_output_states::UNKNOWN);
        assert!(!row.readable);
        assert!(row.unknown);
        assert!(!row.blocked);
        assert!(!row.line.trim().is_empty());

        let view = ControllerOutputsView::default();
        assert!(!view.readable);
        assert!(view.unknown);
        assert!(!view.blocked);
        assert!(!view.ready);
        assert!(!view.can_play);
        assert!(!view.silent());
        assert_eq!(view.state, controller_output_states::UNKNOWN);
        assert!(!view.line.trim().is_empty());
    }

    /// Requirements come only from supported personas actually in the stage.
    #[test]
    fn staged_personas_choose_their_real_backends() {
        assert!(ControllerOutputsView::requirements(&staged_personas(&[])).is_empty());

        let compatibility = ControllerOutputsView::requirements(&staged_personas(&[
            "xbox360",
            "playstation",
            "xbox360",
        ]));
        assert_eq!(compatibility.len(), 1);
        assert_eq!(compatibility[0].backend, "vigem");
        assert_eq!(
            compatibility[0].personas,
            vec![String::from("xbox360"), String::from("playstation")]
        );

        let dualsense = ControllerOutputsView::requirements(&staged_personas(&["dualsense"]));
        assert_eq!(dualsense.len(), 1);
        assert_eq!(dualsense[0].backend, "hidmaestro");
        assert_eq!(dualsense[0].personas, vec![String::from("dualsense")]);

        let mixed =
            ControllerOutputsView::requirements(&staged_personas(&["dualsense", "xbox360"]));
        assert_eq!(
            mixed
                .iter()
                .map(|row| row.backend.as_str())
                .collect::<Vec<_>>(),
            ["vigem", "hidmaestro"]
        );
    }

    /// Doctor's ViGEm states remain three-way, but are scoped to the personas
    /// that use ViGEmBus.
    #[test]
    fn every_vigem_code_lands_in_exactly_one_state() {
        let staged = staged_personas(&["xbox360"]);
        for (code, blocked, unknown) in [
            (vigem_output_codes::HEALTHY, false, false),
            (vigem_output_codes::MISSING, true, false),
            (vigem_output_codes::FILE_MISSING, true, false),
            (vigem_output_codes::NOT_RUNNING, true, false),
            (vigem_output_codes::STATE_UNKNOWN, false, true),
            ("vigembus-something-new", false, true),
        ] {
            let row = ControllerOutputView::vigem(requirement(&staged, "vigem"), code, None);
            assert_eq!(row.blocked, blocked, "blocked for {code:?}");
            assert_eq!(row.unknown, unknown, "unknown for {code:?}");
            assert!(!(row.blocked && row.unknown));
            assert!(row.readable);
            assert!(!row.line.trim().is_empty());
            let view = ControllerOutputsView::from_required(vec![row]);
            assert_eq!(view.silent(), code == vigem_output_codes::HEALTHY);
            assert_eq!(view.can_play, !blocked && !unknown);
        }
    }

    /// An exact HIDMaestro package is evidence, but not a false green endpoint.
    #[test]
    fn hidmaestro_is_verified_on_play_or_blocked_by_its_own_probe() {
        let staged = staged_personas(&["dualsense"]);
        let installed =
            ControllerOutputsView::from_required(vec![ControllerOutputView::hidmaestro(
                requirement(&staged, "hidmaestro"),
                true,
                false,
                Some("1.6.1".into()),
            )]);
        assert_eq!(installed.state, controller_output_states::VERIFIED_ON_PLAY);
        assert!(installed.verified_on_play);
        assert!(!installed.ready);
        assert!(installed.can_play);
        assert!(!installed.silent());
        assert!(installed.line.contains("when Play starts"));

        for partial in [false, true] {
            let missing =
                ControllerOutputsView::from_required(vec![ControllerOutputView::hidmaestro(
                    requirement(&staged, "hidmaestro"),
                    false,
                    partial,
                    None,
                )]);
            assert!(missing.blocked);
            assert!(!missing.can_play);
            assert_eq!(missing.state, controller_output_states::BLOCKED);
            assert!(missing.remedy.contains("HIDMaestro"));
        }
    }

    /// A healthy backend must not hide another required backend's failure.
    #[test]
    fn mixed_output_aggregate_keeps_each_backend_independent() {
        let staged = staged_personas(&["xbox360", "dualsense"]);
        let view = ControllerOutputsView::from_required(vec![
            ControllerOutputView::vigem(
                requirement(&staged, "vigem"),
                vigem_output_codes::HEALTHY,
                Some("1.22.0.0".into()),
            ),
            ControllerOutputView::hidmaestro(
                requirement(&staged, "hidmaestro"),
                false,
                false,
                None,
            ),
        ]);
        assert_eq!(view.required.len(), 2);
        assert!(view.blocked);
        assert!(!view.ready);
        assert!(!view.can_play);
        assert!(view.line.contains("ViGEmBus"));
        assert!(view.line.contains("HIDMaestro"));
    }

    /// The version is evidence, so it is printed only when it was read.
    #[test]
    fn a_healthy_vigem_row_names_its_version_only_when_there_is_one() {
        let staged = staged_personas(&["xbox360"]);
        let known = ControllerOutputView::vigem(
            requirement(&staged, "vigem"),
            vigem_output_codes::HEALTHY,
            Some("1.22.0.0".into()),
        );
        assert!(known.line.contains("v1.22.0.0"), "{}", known.line);
        let unknown = ControllerOutputView::vigem(
            requirement(&staged, "vigem"),
            vigem_output_codes::HEALTHY,
            None,
        );
        assert!(!unknown.line.contains("v1.22.0.0"), "{}", unknown.line);
    }
}
