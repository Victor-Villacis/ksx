//! The daemon-lifetime claim: one WinUSB claim, two modes, many sessions.
//!
//! # Why this type exists
//!
//! With Interception the capture backend is created and destroyed per session
//! (`supervise()` owns it), and that is correct there: between sessions every
//! keyboard is an ordinary keyboard whether ksx runs or not. A WinUSB claim
//! inverts it. Releasing the claim between sessions would **not** give the panel
//! back to Windows — the interface is bound to `winusb.sys` until somebody runs
//! `pnputil` — it would only stop anything reading it. A per-session claim
//! therefore means a panel that is dead in exactly the moments the frontend
//! needs it.
//!
//! So the **daemon** claims once, at startup, and keeps it for its whole
//! lifetime. Sessions borrow it:
//!
//! ```text
//!  ┌─ Panel (daemon lifetime) ──────────────────────────────────────────┐
//!  │  WinUsbBackend (claimed, NullInjector)  ── events ──▶ typethrough  │
//!  │      ▲ ctl (Shutdown only, at quit)                    thread      │
//!  └──────┼─────────────────────────────────────────────────┼──────────┘
//!         │                                   attach/detach │ mode
//!    ┌────┴──────────────────────────────────────────────┐  │
//!    │ PanelSession — a CaptureBackend the supervisor     │◀─┘
//!    │ runs and shuts down per session. Claims nothing.   │
//!    └───────────────────────────────────────────────────┘
//! ```
//!
//! Switching between "typethrough" (the panel types) and "translate to pads"
//! (the session owns it) is one acknowledged message to one thread. No rebind,
//! no re-claim, no device I/O at all — which is what makes start/stop/reload
//! cycles free and what makes an idle daemon a working keyboard.
//!
//! # One injector, on purpose
//!
//! The panel's capture backend is built with
//! [`ksx_platform::inject::NullInjector`], so the *only* thing that ever types
//! for a claimed board is [`super::typethrough`]'s `Typethrough`. Two injectors
//! would mean two independent records of what Windows believes is held down,
//! and every mode switch would be a chance to strand a key — the exact bug
//! `Typethrough` exists to prevent. `ksx run` (one session, no daemon, no
//! typethrough) is unaffected: there the backend is the only injector and still
//! gets a real one (`crate::capture::build`).
//!
//! # What this module does NOT do
//!
//! It never rebinds a device and never claims one on its own initiative: the
//! claim it owns was handed to it, already made, by `crate::capture`. A device
//! that appears in the configuration *after* the daemon started is refused with
//! an explanation rather than claimed behind the user's back — capture mode is
//! a per-device choice, never a migration.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use ksx_capture::{
    CaptureBackend, CaptureCtl, DeviceInfo, EscapeHandle, ExitReason, Handles, HealthHandle,
    PresenceHandle,
};
use ksx_core::{DeviceId, KeyEvent};
use ksx_platform::inject::KeyInjector;

use super::typethrough::{TypethroughConfig, TypethroughCtl, TypethroughService};
use super::PanelKeyboard;

/// Claim → typethrough channel depth. Same order as the supervisor's
/// capture→engine channel: deep enough that a hiccup costs nothing, shallow
/// enough that a genuinely stalled consumer is noticed rather than buffered.
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// How often an attached session re-checks that the claim is still alive.
/// Bounds how long a session runs after its panel was physically unplugged.
const POLL: Duration = Duration::from_millis(50);

/// One or more claimed WinUSB interfaces, owned for the daemon's lifetime.
pub struct Panel {
    devices: Vec<DeviceInfo>,
    handles: Handles,
    presence: PresenceHandle,
    /// The claim's control channel. Held here for the daemon's whole lifetime:
    /// dropping it (or sending `Shutdown`) ends the capture thread, and with it
    /// the claim.
    capture_ctl: Sender<CaptureCtl>,
    capture: Mutex<Option<std::thread::JoinHandle<ExitReason>>>,
    typethrough_ctl: TypethroughCtl,
    typethrough: Mutex<Option<TypethroughService>>,
    /// A session is currently borrowing the panel. Guards against two sessions
    /// attaching at once — which would fan one keystroke into two engines.
    attached: AtomicBool,
}

impl Panel {
    /// Take ownership of an already-claimed backend and start typing.
    ///
    /// `backend` must have been built with the same `handles` (that is how one
    /// escape latch and one health state cover the whole session) and with an
    /// injector that does nothing — see the module docs.
    ///
    /// On error nothing is left running: the backend is dropped, which releases
    /// the claim.
    pub fn start<I: KeyInjector + 'static>(
        mut backend: Box<dyn CaptureBackend>,
        handles: Handles,
        injector: I,
    ) -> std::io::Result<Arc<Self>> {
        let devices = backend.devices();
        let presence = backend.presence();
        let (ev_tx, ev_rx) = crossbeam_channel::bounded::<KeyEvent>(EVENT_CHANNEL_CAPACITY);
        let (ctl_tx, ctl_rx) = crossbeam_channel::unbounded::<CaptureCtl>();

        // The typethrough first: if its thread cannot start, `backend` is
        // dropped here and the claim goes with it, rather than leaving a
        // claimed panel with nothing reading it.
        let typethrough = TypethroughService::spawn_with_config(
            ev_rx,
            injector,
            TypethroughConfig {
                escapes: Some(handles.escapes.clone()),
                health: handles.health.clone(),
            },
        )?;
        let capture = backend.run(ev_tx, ctl_rx)?;

        tracing::info!(
            devices = devices.len(),
            "the daemon owns the claim for its whole lifetime; the panel types until a \
             session takes it"
        );
        Ok(Arc::new(Self {
            devices,
            handles,
            presence,
            capture_ctl: ctl_tx,
            capture: Mutex::new(Some(capture)),
            typethrough_ctl: typethrough.ctl(),
            typethrough: Mutex::new(Some(typethrough)),
            attached: AtomicBool::new(false),
        }))
    }

    /// The claimed boards, as a capture backend reports them.
    pub fn devices(&self) -> Vec<DeviceInfo> {
        self.devices.clone()
    }

    /// The shared health/escape handles the claim publishes into. A session
    /// composing an Interception backend alongside the panel must use these, or
    /// `LeftCtrl ×5` would free only half the machine.
    pub fn handles(&self) -> Handles {
        self.handles.clone()
    }

    pub fn escapes(&self) -> EscapeHandle {
        self.handles.escapes.clone()
    }

    /// Clear the escape passthrough latch (counters untouched).
    ///
    /// Called by the control loop at the same instant it mutes the panel, so
    /// "the panel went dead" and "a fresh gesture can revive it" are one event.
    /// Doing this later — once the supervisor is up, after pads have plugged —
    /// would erase an escape made in between, which is exactly when a user
    /// staring at a dead panel reaches for one.
    pub fn arm_escapes(&self) {
        self.handles.escapes.arm();
    }

    pub fn health(&self) -> HealthHandle {
        self.handles.health.clone()
    }

    /// Is this device one of the ones the daemon claimed at startup?
    pub fn covers(&self, id: &DeviceId) -> bool {
        self.devices.iter().any(|d| &d.id == id)
    }

    /// Has the claim's capture thread ended (the board was unplugged, the
    /// endpoint died)? A panel that is lost cannot serve a session.
    pub fn lost(&self) -> bool {
        match self.capture.lock() {
            Ok(guard) => guard
                .as_ref()
                .is_none_or(std::thread::JoinHandle::is_finished),
            // Poisoned: something panicked holding it. Assume the worst.
            Err(_) => true,
        }
    }

    /// `true` = emulation owns the panel, so it types nothing.
    ///
    /// Returns once the change is in effect (the typethrough acknowledges it),
    /// which is what makes "emulation owns the panel from here on" true at the
    /// instant this returns rather than eventually.
    pub fn set_emulating(&self, emulating: bool) {
        self.typethrough_ctl.set_emulating(emulating);
    }

    /// Emulation owns exactly what these takes name — the split mode.
    ///
    /// An empty list means emulation owns nothing here, which is the same
    /// answer `set_emulating(false)` gives: a session capturing somebody else's
    /// keyboard leaves this panel typing.
    pub fn set_owning(&self, takes: Vec<(ksx_core::DeviceId, ksx_capture::Take)>) {
        self.typethrough_ctl.set_owning(takes);
    }

    /// Listen in on the claim for one observation, and stop typing while it
    /// lasts.
    ///
    /// This is how the mapper hears a claimed board. It cannot use Raw Input:
    /// a claimed interface has left the keyboard stack, which is the whole
    /// point of the claim, so `WM_INPUT` never carries a key from it. And it
    /// cannot claim the board a second time — the daemon already holds it. The
    /// only place those keys exist is the stream this panel is already pumping,
    /// so a learn borrows it exactly the way a session does.
    ///
    /// Returns a guard: dropping it stops the forwarding and puts the panel
    /// back to typing. Independent of an attached session — but note that
    /// [`super::pipe`] refuses a learn while a session is running, so in
    /// practice the two do not overlap.
    pub fn observe(self: &Arc<Self>, events: Sender<KeyEvent>) -> PanelTap {
        self.typethrough_ctl.observe(events);
        PanelTap {
            ctl: self.typethrough_ctl.clone(),
        }
    }

    /// A [`CaptureBackend`] the supervisor can run for one session. It claims
    /// nothing — running it attaches this panel's event stream to that session,
    /// and shutting it down detaches it again with the claim untouched.
    pub fn session_backend(self: &Arc<Self>) -> Box<dyn CaptureBackend> {
        Box::new(PanelSession {
            panel: Arc::clone(self),
        })
    }

    /// Release the claim and everything behind it. Idempotent.
    ///
    /// Order matters: stop the claim first so no further event can arrive, then
    /// join the typethrough, whose `Typethrough` releases every key it is still
    /// holding on the way out. A daemon killed mid-hold must not leave a
    /// synthetic key latched down on a desktop that now has one fewer keyboard.
    pub fn shutdown(&self) {
        let _ = self.capture_ctl.send(CaptureCtl::Shutdown);
        if let Ok(mut guard) = self.capture.lock() {
            if let Some(handle) = guard.take() {
                let reason = handle.join().unwrap_or(ExitReason::Panicked);
                tracing::info!(?reason, "the daemon released its WinUSB claim");
            }
        }
        if let Ok(mut guard) = self.typethrough.lock() {
            if let Some(mut service) = guard.take() {
                let stats = service.join();
                tracing::info!(
                    injected = stats.injected,
                    suppressed = stats.suppressed,
                    failed = stats.failed,
                    "typethrough stopped"
                );
            }
        }
    }
}

/// A live observation of the panel, from [`Panel::observe`].
///
/// Exists so that every exit path of a learn — hit, timeout, cancel, supersede,
/// panic — puts the panel back to typing. A learn that returned early and left
/// the panel muted would be indistinguishable, from the user's chair, from a
/// dead keyboard.
pub struct PanelTap {
    ctl: TypethroughCtl,
}

impl Drop for PanelTap {
    fn drop(&mut self) {
        self.ctl.unobserve();
    }
}

/// The daemon quitting, panicking, or simply dropping the panel all end here.
/// This is the only thing standing between an unwinding daemon and a claimed
/// board with a key held down on it.
impl Drop for Panel {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A [`PanelKeyboard`] view of the panel, for the daemon control loop.
///
/// The loop wants `&mut dyn PanelKeyboard`; the panel is shared with the
/// session factory, so it is behind an `Arc`. This is that adapter and nothing
/// else.
pub struct PanelKeyboardHandle(pub Arc<Panel>);

impl PanelKeyboard for PanelKeyboardHandle {
    fn set_emulating(&mut self, emulating: bool) {
        self.0.set_emulating(emulating);
    }

    fn arm_escapes(&mut self) {
        self.0.arm_escapes();
    }
}

// ---------------------------------------------------------------------------
// The per-session view of the claim
// ---------------------------------------------------------------------------

/// One session's borrowed view of the daemon's claim.
///
/// It satisfies [`CaptureBackend`] so `supervise()` cannot tell the difference
/// between a borrowed panel and a freshly built backend — same events, same
/// control channel, same health/escape/presence handles. What it does *not* do
/// is own anything: `run` attaches, `Shutdown` detaches, and the claim outlives
/// both.
struct PanelSession {
    panel: Arc<Panel>,
}

impl CaptureBackend for PanelSession {
    fn devices(&mut self) -> Vec<DeviceInfo> {
        self.panel.devices()
    }

    fn health(&self) -> HealthHandle {
        self.panel.health()
    }

    fn escapes(&self) -> EscapeHandle {
        self.panel.escapes()
    }

    fn presence(&self) -> PresenceHandle {
        self.panel.presence.clone()
    }

    fn run(
        self: Box<Self>,
        tx: Sender<KeyEvent>,
        ctl: Receiver<CaptureCtl>,
    ) -> std::io::Result<std::thread::JoinHandle<ExitReason>> {
        let panel = self.panel;
        if panel.lost() {
            return Err(std::io::Error::other(
                "the daemon's WinUSB claim is gone (the board was unplugged); restart the \
                 daemon once it is back",
            ));
        }
        if panel.attached.swap(true, Ordering::SeqCst) {
            return Err(std::io::Error::other(
                "the daemon's panel is already driving a session",
            ));
        }
        // Attach before the thread exists, so a session that starts is a
        // session that is already receiving.
        panel.typethrough_ctl.attach(tx);

        let spawned = std::thread::Builder::new()
            .name("ksx-panel-session".into())
            .spawn({
                let panel = Arc::clone(&panel);
                move || {
                    let reason = session_loop(&panel, &ctl);
                    // Detach first: the session's channel is about to go away,
                    // and forwarding into a dead channel is how a drop counter
                    // lies.
                    panel.typethrough_ctl.detach();
                    // Deliberately NOT `set_emulating(false)` here. The control
                    // loop hands the panel back after it has *reaped* the
                    // session (`control_loop_with`), and the supervisor's own
                    // teardown has already sent `SetPassthrough` — which this
                    // loop turned into "type again". Doing it here as well would
                    // be a second, unowned opinion about who has the panel.
                    panel.attached.store(false, Ordering::SeqCst);
                    reason
                }
            });

        if spawned.is_err() {
            // Nothing is running, so nothing will ever detach: undo the attach
            // here or the panel would forward into a dead session's channel and
            // refuse every future one.
            panel.typethrough_ctl.detach();
            panel.attached.store(false, Ordering::SeqCst);
        }
        spawned
    }
}

/// Translate the supervisor's control messages into panel modes until it is
/// told to stop (or the claim dies underneath us).
///
/// `SetCaptured`/`SetPassthrough` keep their exact meaning — "may this device's
/// input reach Windows" — and change only their mechanism, as everywhere else
/// on this backend: not a filter, but whether the typethrough types.
fn session_loop(panel: &Panel, ctl: &Receiver<CaptureCtl>) -> ExitReason {
    loop {
        match ctl.recv_timeout(POLL) {
            Ok(CaptureCtl::SetCaptured(ids)) => {
                // Captured ⇒ emulation owns the panel; not captured ⇒ it types,
                // because nothing else can deliver its keys (the inversion this
                // backend is built around). A set that names none of this
                // panel's boards therefore *unmutes* it: the session is
                // blocking somebody else's keyboard, not this one.
                //
                // All-or-nothing across the panel's boards, deliberately: every
                // device it holds is one the plan captures
                // (`RunPlan::winusb ⊆ RunPlan::captureable`), so the only ids
                // the supervisor leaves out are devices that are not present —
                // and an absent board emits nothing to mute or type.
                panel.set_emulating(ids.iter().any(|id| panel.covers(id)));
            }
            // A per-key `Take` DOES have something to act on here, and reading
            // it as a device list was defect 5 of the 2026-08-11 session. The
            // reasoning that produced the old code — "a claimed board is off
            // the stack, so there is nothing to suppress" — is true and
            // incomplete: nothing is suppressed, but nothing is *re-injected*
            // either while the typethrough is muted, so collapsing a
            // `BoundKeys` take to "mute the panel" made Split behave exactly
            // like Freeze on every prepared board while the card promised
            // "mapped keys drive the pad; everything else still types".
            //
            // Forwarded per device, not unioned: one panel can hold several
            // boards, and board A's bindings must not silence board B.
            Ok(CaptureCtl::SetCapturedWith(takes)) => {
                let mine: Vec<_> = takes
                    .into_iter()
                    .filter(|(id, _)| panel.covers(id))
                    .collect();
                panel.set_owning(mine);
            }
            Ok(CaptureCtl::SetPassthrough) => panel.set_emulating(false),
            Ok(CaptureCtl::Shutdown) => return ExitReason::Shutdown,
            Err(RecvTimeoutError::Timeout) => {
                if panel.lost() {
                    // The board went away. The session cannot continue on it,
                    // and the supervisor treats a capture exit as fatal — which
                    // is what we want: pads down, keyboards released.
                    return ExitReason::DeviceLost;
                }
            }
            // Nobody can release this device again.
            Err(RecvTimeoutError::Disconnected) => return ExitReason::Shutdown,
        }
    }
}
