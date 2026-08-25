//! Where a learn hears its key from — all of the places at once.
//!
//! # The defect this module exists to fix
//!
//! `learn-key` observed with `ksx_capture::observe_next_key`, which is pure Raw
//! Input. A WinUSB-claimed interface has **left the keyboard stack** — that is
//! the entire point of the claim, and what makes blocking structural instead of
//! a race — so `WM_INPUT` never carries a key from it. The result, measured on
//! hardware 2026-08-11: prepare a board and the mapper goes deaf on it; release
//! it and the mapper works again. Preparing a keyboard disabled the one screen
//! whose whole job is to bind that keyboard's keys.
//!
//! # Three sources, one answer
//!
//! A user with an arcade panel and a desk keyboard should be able to press
//! either one, whether or not either is prepared, without ksx caring which:
//!
//! | the board is… | heard through |
//! |---|---|
//! | an ordinary keyboard | Raw Input, exactly as before |
//! | claimed by the daemon (a configured panel) | the claim the daemon already pumps ([`Panel::observe`]) |
//! | prepared but held by nobody (first-run staging) | a claim taken for the length of the observation |
//!
//! The third row is not a corner case, it is the **first run**: an idle daemon
//! has no plan, so `capture::claim_panel` claims nothing, so a freshly prepared
//! board is bound to `winusb.sys` with no reader at all. That is the exact
//! state a user is in the moment after Setup says "Keyboard prepared" — which
//! is when they go looking for the mapper.
//!
//! # Why not just one source
//!
//! Because prepare-order would otherwise be load-bearing, and nothing tells the
//! user what the order is. Listening on all three costs one channel and one
//! thread per learn, on a cold path bounded by a ten-second human timeout.
//!
//! # What this module does NOT do
//!
//! It never rebinds anything, and the claims it takes are released when the
//! observation ends — every exit path, including a panic, by [`Drop`]. A learn
//! must not be able to leave a board held.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use ksx_core::{Key, KeyEvent};

/// One press, wherever it came from.
///
/// Carries a [`Key`] rather than its name because `ksx setup` binds by key and
/// the learn service reports by name; naming it here and re-parsing it there
/// would put a round trip through a string in the middle of the one thing this
/// module exists to get right.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Press {
    /// Device instance path, in the namespace `config.toml` stores.
    pub device: String,
    pub key: Key,
}

impl Press {
    /// The `(device, key name)` tuple [`super::learn::ObserveFn`] is defined in.
    pub fn named(self) -> (String, String) {
        (self.device, self.key.name().to_owned())
    }
}

/// How long the fan-in waits before re-checking the cancel flag. PadForge's
/// observer slice, the same number `rawinput::observe_next_key` polls on.
const SLICE: Duration = Duration::from_millis(33);

/// Depth of the key-event channel every claimed source feeds.
///
/// A learn cares about ONE press and the user makes it with their hand, so this
/// only has to absorb the modifiers and autorepeat around it. Deliberately not
/// the capture path's 1024: a deep buffer here would just mean answering with a
/// key pressed seconds ago.
const KEY_CHANNEL_CAPACITY: usize = 64;

/// The first real press from either stream, or `None` on timeout/cancel.
///
/// Kept free of every Windows type on purpose: this is the part with the
/// decisions in it (what counts as a press, who wins a tie, when to give up),
/// and it is exercised directly in the tests below with two plain channels.
///
/// `keys` carries transitions from claimed boards; `raw` carries already-named
/// hits from the Raw Input sink. Whichever speaks first wins — there is no
/// priority between them, because a user pressing a key does not know which
/// list their board is on.
fn first_press(
    keys: &Receiver<KeyEvent>,
    raw: &Receiver<Press>,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Option<Press> {
    let deadline = Instant::now() + timeout;
    // Both sides can end early — the Raw Input thread returns at its own
    // timeout, and a source with nothing behind it drops its sender
    // immediately. The observation is over only when BOTH are done.
    let (mut keys_live, mut raw_live) = (true, true);

    while keys_live || raw_live {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        let slice = left.min(SLICE);

        crossbeam_channel::select! {
            recv(keys) -> event => match event {
                Ok(event) => {
                    if let Some(hit) = press(&event) {
                        return Some(hit);
                    }
                }
                Err(_) => keys_live = false,
            },
            recv(raw) -> hit => match hit {
                Ok(hit) => return Some(hit),
                Err(_) => raw_live = false,
            },
            default(slice) => {}
        }
    }
    None
}

/// A key transition, as a learn wants it — or `None` if it is not one.
///
/// Two filters, both matching what the Raw Input observer already does so the
/// three sources cannot disagree about what a bindable press is:
///
/// - **presses only.** Binding on the release would name the right key but at
///   the wrong moment, and a learn that ends when you *let go* reads as lag.
/// - **no `Key::Unknown`.** A scancode outside the preset vocabulary has no
///   name a preset can store; handing one back would write a binding that
///   nothing can ever match.
///
/// No wait-for-release re-baselining, unlike Raw Input: these streams carry
/// *transitions*, so a key already held when the observation starts produces
/// nothing until it is released and pressed again. The property Raw Input has
/// to reconstruct is free here.
fn press(event: &KeyEvent) -> Option<Press> {
    if !event.down || event.key == Key::Unknown {
        return None;
    }
    Some(Press {
        device: event.device.as_str().to_owned(),
        key: event.key,
    })
}

#[cfg(windows)]
pub use windows_observer::{input_observer, observer, Sources};

#[cfg(windows)]
mod windows_observer {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use crossbeam_channel::Sender;
    use ksx_capture::{CaptureBackend, CaptureCtl, ExitReason, HealthView};
    use ksx_core::{DeviceId, Key, KeyEvent};

    use super::super::input_test::{InputTransition, ObserveEventsFn};
    use super::super::learn::ObserveFn;
    use super::super::panel::{Panel, PanelTap};
    use super::super::{RunState, SharedState};
    use super::{first_press, Press, KEY_CHANNEL_CAPACITY};

    /// The observer the daemon gives its learn service.
    ///
    /// `panel` is the claim the daemon took at startup, if it took one. `None`
    /// is the ordinary first-run daemon — and the ad-hoc source below is what
    /// makes a learn work there, so this is not a degraded mode.
    ///
    /// The sources are started and dropped **per learn**, because a learn is a
    /// discrete ten-second act and holding a board between two of them would
    /// mean a panel silently muted for as long as the mapper page is open.
    /// `ksx setup` is the other way round — see [`Sources`].
    pub fn observer(panel: Option<Arc<Panel>>) -> ObserveFn {
        Arc::new(move |timeout, cancel| {
            Sources::start(panel.as_ref())
                .first(timeout, &cancel)
                .map(|hit| hit.map(Press::named))
        })
    }

    /// The exact-device, multi-transition counterpart of [`observer`].
    ///
    /// A fresh machine inventory resolves the canonical selector before any
    /// listener starts. Ordinary keyboards use Raw Input; a prepared board
    /// uses either the daemon's existing claim or one exact temporary claim.
    /// No fallback is allowed: failure of the selected source is a failed test,
    /// never apparent silence from some other keyboard.
    pub fn input_observer(
        panel: Option<Arc<Panel>>,
        state: SharedState,
        config_dir: PathBuf,
    ) -> ObserveEventsFn {
        // Windows inventory is read-only but not cancellable. A diagnostic's
        // foreground budget may expire while that helper is still unwinding;
        // keep one process-local fence so repeated starts cannot accumulate
        // detached resolver threads behind a wedged device stack.
        let resolver_in_flight = Arc::new(AtomicBool::new(false));
        Arc::new(move |selector, deadline, cancel, emit| {
            // Keep the daemon-owned state as the fast, descriptive gate. The
            // same check inside the machine lease closes the check/acquire
            // interval against tray/autostart transitions.
            if session_owns_input(&state) {
                return Err(
                    "the simultaneous-input test cannot start while Play is running or starting"
                        .into(),
                );
            }
            with_input_test_machine_lease(&config_dir, || {
                if session_owns_input(&state) {
                    return Err(
                        "the simultaneous-input test cannot start while Play is running or starting"
                            .into(),
                    );
                }
                let Some(target) = resolve_target_bounded(
                    selector,
                    deadline,
                    Arc::clone(&cancel),
                    Arc::clone(&state),
                    Arc::clone(&resolver_in_flight),
                    Target::resolve,
                )?
                else {
                    return Ok(0);
                };
                if target.claimed {
                    let sources = Sources::start_target(panel.as_ref(), &target)?;
                    // Opening a panel tap/temporary claim is cold hardware work.
                    // Re-check every terminal condition immediately afterwards so
                    // a tray/autostart Play transition can never turn it into an
                    // apparently-live diagnostic.
                    if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        return Ok(sources.dropped());
                    }
                    if session_owns_input(&state) {
                        return Err(
                            "Play started while the simultaneous-input test was preparing; the selected keyboard was released before accepting a signal"
                                .into(),
                        );
                    }
                    loop {
                        if session_owns_input(&state) {
                            return Err(
                                "Play started while the simultaneous-input test was listening; the test stopped before accepting another signal"
                                    .into(),
                            );
                        }
                        if cancel.load(Ordering::SeqCst) {
                            return Ok(sources.dropped());
                        }
                        let left = deadline.saturating_duration_since(std::time::Instant::now());
                        if left.is_zero() {
                            return Ok(sources.dropped());
                        }
                        match sources.keys.recv_timeout(left.min(super::SLICE)) {
                            Ok(event) => {
                                if let Some(transition) =
                                    claimed_transition_while_idle(&state, &target, event)?
                                {
                                    emit(transition);
                                }
                            }
                            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                                return Err(
                                    "the selected claimed keyboard stopped delivering input".into(),
                                )
                            }
                        }
                    }
                }

                // A Play transition can arrive through the tray/autostart rather
                // than this pipe, so the pipe's start gate is not sufficient.
                // Wake the Raw Input window within one observer slice even when
                // the user is holding no key; the callback repeats the same check
                // before emitting to close the event-vs-watch race.
                let stop = Arc::new(AtomicBool::new(false));
                let play_started = Arc::new(AtomicBool::new(false));
                let watch = InputTestWatch::start(
                    Arc::clone(&cancel),
                    Arc::clone(&stop),
                    Arc::clone(&state),
                    Arc::clone(&play_started),
                )?;
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() || cancel.load(Ordering::SeqCst) {
                    return Ok(0);
                }
                let observed = ksx_capture::observe_key_events(left, &stop, |event| {
                    if session_owns_input(&state) {
                        play_started.store(true, Ordering::SeqCst);
                        return true;
                    }
                    if target.matches(&event.instance_path) && event.key != Key::Unknown {
                        emit(InputTransition {
                            key: event.key.name().to_owned(),
                            down: event.down,
                        });
                    }
                    cancel.load(Ordering::SeqCst)
                });
                drop(watch);
                observed
                    .map_err(|err| format!("could not observe the selected keyboard: {err}"))?;
                if play_started.load(Ordering::SeqCst) || session_owns_input(&state) {
                    return Err(
                        "Play started while the simultaneous-input test was listening; the test stopped before accepting another signal"
                            .into(),
                    );
                }
                Ok(0)
            })
        })
    }

    /// The diagnostic owns the same cross-process lease as Play and persistent
    /// encoder maintenance for its complete worker lifetime. The local
    /// [`RunState`] checks remain the fast, descriptive gate; this lease closes
    /// the separate-process and Studio-machine-operation races they cannot see.
    fn with_input_test_machine_lease<T>(
        config_dir: &std::path::Path,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _lease = crate::panel_programming::acquire_play_start_guard(config_dir)
            .map_err(|refusal| refusal.message)?;
        operation()
    }

    fn session_owns_input(state: &SharedState) -> bool {
        state.lock().map_or(true, |state| {
            matches!(&state.run, RunState::Running { .. } | RunState::Starting)
        })
    }

    /// Turn one already-received claimed-panel event into diagnostic evidence
    /// only while the diagnostic still owns input. The second ownership check
    /// belongs after the blocking receive: tray/autostart Play can win while
    /// that receive is asleep, and accepting the waking key before the next
    /// loop iteration would make the failed diagnostic include gameplay-era
    /// evidence.
    fn claimed_transition_while_idle(
        state: &SharedState,
        target: &Target,
        event: KeyEvent,
    ) -> Result<Option<InputTransition>, String> {
        if !target.matches(event.device.as_str()) || event.key == Key::Unknown {
            return Ok(None);
        }
        if session_owns_input(state) {
            return Err(
                "Play started while the simultaneous-input test was listening; the test stopped before accepting another signal"
                    .into(),
            );
        }
        Ok(Some(InputTransition {
            key: event.key.name().to_owned(),
            down: event.down,
        }))
    }

    /// Resolve an exact source without letting a slow machine inventory extend
    /// the diagnostic's wall-clock budget or hide a Play transition.
    ///
    /// Resolution is read-only, so it may finish harmlessly on its detached
    /// helper thread after a cancel/deadline. Hardware is opened only by the
    /// caller after this function returns `Some`, never by that helper.
    fn resolve_target_bounded<R>(
        selector: String,
        deadline: Instant,
        cancel: Arc<AtomicBool>,
        state: SharedState,
        resolver_in_flight: Arc<AtomicBool>,
        resolve: R,
    ) -> Result<Option<Target>, String>
    where
        R: FnOnce(&str) -> Result<Target, String> + Send + 'static,
    {
        if resolver_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(
                "the previous exact-device resolver is still completing; wait for it to finish before starting another simultaneous-input test"
                    .into(),
            );
        }
        let (tx, rx) = crossbeam_channel::bounded(1);
        let flight = Arc::clone(&resolver_in_flight);
        let resolver = std::thread::Builder::new()
            .name("ksx-input-test-resolve".into())
            .spawn(move || {
                let _flight = ResolverFlight(flight);
                let _ = tx.send(resolve(&selector));
            });
        let resolver = match resolver {
            Ok(resolver) => resolver,
            Err(err) => {
                resolver_in_flight.store(false, Ordering::SeqCst);
                return Err(format!("could not start the exact-device resolver: {err}"));
            }
        };
        let mut resolver = Some(resolver);

        loop {
            if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                return Ok(None);
            }
            if session_owns_input(&state) {
                return Err(
                    "Play started while the simultaneous-input test was preparing; no keyboard observer was opened"
                        .into(),
                );
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left.min(super::SLICE)) {
                Ok(target) => {
                    if let Some(resolver) = resolver.take() {
                        let _ = resolver.join();
                    }
                    if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        return Ok(None);
                    }
                    if session_owns_input(&state) {
                        return Err(
                            "Play started while the simultaneous-input test was preparing; no keyboard observer was opened"
                                .into(),
                        );
                    }
                    return target.map(Some);
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    if let Some(resolver) = resolver.take() {
                        let _ = resolver.join();
                    }
                    return Err("the exact-device resolver stopped without an answer".into());
                }
            }
        }
    }

    struct ResolverFlight(Arc<AtomicBool>);

    impl Drop for ResolverFlight {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    #[derive(Debug)]
    struct Target {
        identities: Vec<String>,
        keyboard: DeviceId,
        claimed: bool,
    }

    impl Target {
        fn resolve(selector: &str) -> Result<Self, String> {
            let devices = crate::devices::to_view(&crate::devices::collect());
            let store = crate::device_edit::store()
                .map_err(|err| format!("could not open the device configuration: {err}"))?;
            let config = store
                .load_config()
                .map_err(|err| format!("could not read config.toml: {err}"))?
                .value;
            let games = store
                .load_games()
                .map_err(|err| format!("could not read games.toml: {err}"))?
                .value;
            let scan = crate::device_scan::view(
                &devices,
                &crate::device_edit::connected_facts(),
                &config,
                &games,
            );
            Self::from_boards(&scan.boards, selector)
        }

        fn from_boards(boards: &[ksx_api::BoardRow], selector: &str) -> Result<Self, String> {
            let matched: Vec<_> = boards
                .iter()
                .filter(|board| {
                    board
                        .selector
                        .as_deref()
                        .is_some_and(|served| served.eq_ignore_ascii_case(selector))
                })
                .collect();
            let [board] = matched.as_slice() else {
                return Err(
                    "the selected device did not resolve to exactly one keyboard on this machine"
                        .into(),
                );
            };
            if !board.pickable {
                return Err(
                    "the selected device has no keyboard signal interface; switch the encoder to keyboard mode before testing it"
                        .into(),
                );
            }
            let Some(keyboard) = board.keyboard.as_deref() else {
                return Err(
                    "the selected device has no keyboard signal interface; switch the encoder to keyboard mode before testing it"
                        .into(),
                );
            };
            if !board.claimed && !board.can_type {
                return Err(if board.cannot_type_reason.trim().is_empty() {
                    "the selected keyboard is present but cannot deliver a Windows signal right now"
                        .into()
                } else {
                    board.cannot_type_reason.clone()
                });
            }
            let mut identities: Vec<String> = board
                .interfaces
                .iter()
                .map(|interface| interface.instance_id.to_ascii_uppercase())
                .collect();
            identities.push(keyboard.to_ascii_uppercase());
            identities.sort();
            identities.dedup();
            Ok(Self {
                identities,
                keyboard: DeviceId::new(keyboard),
                claimed: board.claimed,
            })
        }

        fn matches(&self, observed: &str) -> bool {
            let mut candidates = vec![observed.to_ascii_uppercase()];
            candidates.extend(
                ksx_platform::ancestor_instance_ids(observed, 4)
                    .into_iter()
                    .map(|candidate| candidate.to_ascii_uppercase()),
            );
            candidates
                .iter()
                .any(|candidate| self.identities.iter().any(|id| id == candidate))
        }
    }

    /// Everything that can hear a key, held open together.
    ///
    /// Two callers with opposite lifetimes: [`observer`] builds one per learn,
    /// and `ksx setup` builds ONE for the whole wizard because it asks for a
    /// dozen keys in a row and re-claiming a USB interface between every prompt
    /// would be churn with no purpose.
    pub struct Sources {
        keys: crossbeam_channel::Receiver<KeyEvent>,
        /// Dropping these releases every ad-hoc claim.
        _adhoc: AdhocClaims,
        /// Dropping this un-mutes the daemon's panel.
        _tap: Option<PanelTap>,
        panel_health: Option<HealthView>,
    }

    impl Sources {
        /// Start listening on all three. Never fails: a source that cannot
        /// start is one fewer place a key can come from, not a refusal — the
        /// user still has the other two, and refusing outright would make a
        /// missing board fatal to a wizard that has not asked anything yet.
        pub fn start(panel: Option<&Arc<Panel>>) -> Self {
            let (key_tx, keys) = crossbeam_channel::bounded::<KeyEvent>(KEY_CHANNEL_CAPACITY);
            // 1 · The daemon's own claim. The tap also mutes the panel while it
            //     lives, so the key being bound does not type into whatever has
            //     focus behind the mapper.
            let panel_health = panel.map(|panel| HealthView::new(panel.health()));
            let tap = panel.map(|panel| panel.observe(key_tx.clone()));
            // 2 · Prepared boards nobody is holding — the first-run case.
            let adhoc = AdhocClaims::start(panel, key_tx);
            Self {
                keys,
                _adhoc: adhoc,
                _tap: tap,
                panel_health,
            }
        }

        fn start_target(panel: Option<&Arc<Panel>>, target: &Target) -> Result<Self, String> {
            let (key_tx, keys) = crossbeam_channel::bounded::<KeyEvent>(KEY_CHANNEL_CAPACITY);
            let covered = panel.is_some_and(|panel| panel.covers(&target.keyboard));
            if covered && panel.is_some_and(|panel| panel.lost()) {
                return Err(
                    "the daemon's claim for the selected keyboard is no longer live".into(),
                );
            }
            let panel_health = covered
                .then(|| panel.map(|panel| HealthView::new(panel.health())))
                .flatten();
            let tap = covered.then(|| panel.expect("covered panel").observe(key_tx.clone()));
            let adhoc = if covered {
                AdhocClaims::empty()
            } else {
                AdhocClaims::start_one(&target.keyboard, key_tx)?
            };
            Ok(Self {
                keys,
                _adhoc: adhoc,
                _tap: tap,
                panel_health,
            })
        }

        fn dropped(&self) -> u64 {
            let panel = self
                .panel_health
                .as_ref()
                .map(|health| health.snapshot().dropped_events)
                .unwrap_or(0);
            panel.saturating_add(self._adhoc.dropped())
        }

        /// The first press on any source, or `Ok(None)` on timeout/cancel.
        ///
        /// Raw Input is started here rather than in [`Self::start`] because it
        /// is the one source that is inherently one-shot: it registers a window
        /// and an input sink, answers once, and unregisters. The claimed
        /// sources are streams and stay open across calls.
        pub fn first(
            &self,
            timeout: Duration,
            cancel: &Arc<AtomicBool>,
        ) -> Result<Option<Press>, String> {
            let (raw_tx, raw_rx) = crossbeam_channel::bounded::<Press>(1);
            // Its own cancel flag, chained to the caller's: `first` must be able
            // to stop the Raw Input thread when a claimed source answers, and
            // it must not do that by poisoning a flag the caller reuses for the
            // next slice (`ksx setup` calls this once a second).
            let stop = Arc::new(AtomicBool::new(false));

            // 3 · Raw Input, for every board that is still an ordinary
            //     keyboard. Its error is kept rather than thrown, so a Raw
            //     Input failure cannot lose a hit one of the other two sources
            //     already has.
            let failure = Arc::new(Mutex::new(None::<String>));
            let raw = std::thread::Builder::new()
                .name("ksx-observe-rawinput".into())
                .spawn({
                    let stop = Arc::clone(&stop);
                    let failure = Arc::clone(&failure);
                    move || match ksx_capture::observe_next_key(timeout, &stop) {
                        Ok(Some(hit)) => {
                            let _ = raw_tx.send(Press {
                                device: hit.instance_path,
                                key: hit.key,
                            });
                        }
                        Ok(None) => {}
                        Err(err) => {
                            *failure.lock().expect("observe failure poisoned") =
                                Some(err.to_string());
                        }
                    }
                })
                .map_err(|err| format!("could not start the Raw Input observer: {err}"))?;

            // The caller's cancel has to reach the Raw Input thread too, or
            // `learn-cancel` would return while a window it owns is still up.
            let watch = Watch::start(Arc::clone(cancel), Arc::clone(&stop));
            let hit = first_press(&self.keys, &raw_rx, timeout, cancel);
            drop(watch);

            // Stop the Raw Input thread before returning: it holds a window and
            // a registered input sink, and an observation that answered while
            // its own observer is still running would leave one per attempt.
            stop.store(true, Ordering::SeqCst);
            let _ = raw.join();

            match hit {
                Some(hit) => Ok(Some(hit)),
                // Nothing heard AND Raw Input could not listen: that is a
                // failure, not a timeout, and the difference is the whole
                // reason a user knows to look at their machine rather than
                // their fingers.
                None => match failure.lock().expect("observe failure poisoned").take() {
                    Some(err) => Err(err),
                    None => Ok(None),
                },
            }
        }
    }

    /// Mirrors one cancel flag onto another until dropped.
    ///
    /// The two flags exist for different reasons — the caller's outlives this
    /// call, the Raw Input thread's must be set when any source answers — and
    /// this is the one place they have to agree.
    struct Watch {
        done: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Watch {
        fn start(from: Arc<AtomicBool>, to: Arc<AtomicBool>) -> Self {
            let done = Arc::new(AtomicBool::new(false));
            let thread = std::thread::Builder::new()
                .name("ksx-observe-cancel".into())
                .spawn({
                    let done = Arc::clone(&done);
                    move || {
                        while !done.load(Ordering::SeqCst) {
                            if from.load(Ordering::SeqCst) {
                                to.store(true, Ordering::SeqCst);
                                return;
                            }
                            std::thread::sleep(super::SLICE);
                        }
                    }
                })
                .ok();
            Self { done, thread }
        }
    }

    impl Drop for Watch {
        fn drop(&mut self) {
            self.done.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Stops an ordinary-keyboard Raw Input observation when either its owner
    /// cancels or Play takes ownership of input through any daemon surface.
    /// Unlike [`Watch`], failure to create this guard is a refusal: without it
    /// a quiet keyboard could leave the Raw Input registration alive for the
    /// rest of the diagnostic after a tray-started session begins.
    struct InputTestWatch {
        done: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl InputTestWatch {
        fn start(
            cancel: Arc<AtomicBool>,
            stop: Arc<AtomicBool>,
            state: SharedState,
            play_started: Arc<AtomicBool>,
        ) -> Result<Self, String> {
            let done = Arc::new(AtomicBool::new(false));
            let thread = std::thread::Builder::new()
                .name("ksx-input-test-watch".into())
                .spawn({
                    let done = Arc::clone(&done);
                    move || {
                        while !done.load(Ordering::SeqCst) {
                            if cancel.load(Ordering::SeqCst) {
                                stop.store(true, Ordering::SeqCst);
                                return;
                            }
                            if session_owns_input(&state) {
                                play_started.store(true, Ordering::SeqCst);
                                stop.store(true, Ordering::SeqCst);
                                return;
                            }
                            std::thread::sleep(super::SLICE);
                        }
                    }
                })
                .map_err(|err| format!("could not start the input-ownership watcher: {err}"))?;
            Ok(Self {
                done,
                thread: Some(thread),
            })
        }
    }

    impl Drop for InputTestWatch {
        fn drop(&mut self) {
            self.done.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Claims taken for the length of one observation, and released after it.
    ///
    /// Only boards that are **prepared** (`winusb.sys`) and **not already held**
    /// by the daemon's panel. A board on the ordinary HID stack is Raw Input's
    /// job; a board the daemon holds is the panel tap's; claiming either here
    /// would be taking a keyboard off the machine to answer a question that was
    /// already answered.
    pub(super) struct AdhocClaims {
        ctl: Vec<Sender<CaptureCtl>>,
        threads: Vec<std::thread::JoinHandle<ExitReason>>,
        health: Vec<HealthView>,
    }

    impl AdhocClaims {
        pub(super) fn start(panel: Option<&Arc<Panel>>, events: Sender<KeyEvent>) -> Self {
            let mut claims = Self {
                ctl: Vec::new(),
                threads: Vec::new(),
                health: Vec::new(),
            };
            let candidates = match ksx_capture::usb_candidates() {
                Ok(candidates) => candidates,
                Err(err) => {
                    // Not fatal, and not worth failing a learn over: the other
                    // two sources are still listening.
                    tracing::debug!(%err, "could not enumerate USB boards for the learn");
                    return claims;
                }
            };
            for candidate in candidates {
                if !candidate.binding.is_winusb() {
                    continue; // an ordinary keyboard: Raw Input hears it
                }
                if panel.is_some_and(|panel| panel.covers(&candidate.id)) {
                    continue; // the daemon holds it; the tap hears it
                }
                // NullInjector, deliberately: the key pressed to bind "P1 · A"
                // must not also be typed. Nothing else types for a claimed
                // board, so this is simply silence for the ten seconds.
                let backend = match ksx_capture::WinUsbBackend::claim(
                    &candidate,
                    Box::new(ksx_platform::inject::NullInjector),
                ) {
                    Ok(backend) => backend,
                    Err(err) => {
                        // Most often: something else already holds it (`ksx
                        // run` in another window). Skip it and keep listening
                        // on the rest.
                        tracing::debug!(id = %candidate.id, %err, "not listening on this board");
                        continue;
                    }
                };
                let health = HealthView::new(backend.health());
                let (ctl_tx, ctl_rx) = crossbeam_channel::unbounded::<CaptureCtl>();
                match Box::new(backend).run(events.clone(), ctl_rx) {
                    Ok(handle) => {
                        tracing::debug!(id = %candidate.id, "listening on a prepared board");
                        claims.ctl.push(ctl_tx);
                        claims.threads.push(handle);
                        claims.health.push(health);
                    }
                    Err(err) => {
                        tracing::debug!(id = %candidate.id, %err, "could not run the claim");
                    }
                }
            }
            claims
        }

        fn empty() -> Self {
            Self {
                ctl: Vec::new(),
                threads: Vec::new(),
                health: Vec::new(),
            }
        }

        fn start_one(target: &DeviceId, events: Sender<KeyEvent>) -> Result<Self, String> {
            let candidate = ksx_capture::usb_candidates()
                .map_err(|err| format!("could not enumerate the selected keyboard: {err}"))?
                .into_iter()
                .find(|candidate| &candidate.id == target)
                .ok_or_else(|| {
                    "the selected keyboard disappeared before the input test started".to_owned()
                })?;
            if !candidate.binding.is_winusb() {
                return Err(
                    "the selected encoder is not prepared for direct keyboard observation".into(),
                );
            }
            let backend = ksx_capture::WinUsbBackend::claim(
                &candidate,
                Box::new(ksx_platform::inject::NullInjector),
            )
            .map_err(|err| format!("could not open the selected keyboard: {err}"))?;
            let health = HealthView::new(backend.health());
            let (ctl_tx, ctl_rx) = crossbeam_channel::unbounded::<CaptureCtl>();
            let handle = Box::new(backend)
                .run(events, ctl_rx)
                .map_err(|err| format!("could not run the selected keyboard claim: {err}"))?;
            Ok(Self {
                ctl: vec![ctl_tx],
                threads: vec![handle],
                health: vec![health],
            })
        }

        fn dropped(&self) -> u64 {
            self.health.iter().fold(0u64, |total, health| {
                total.saturating_add(health.snapshot().dropped_events)
            })
        }
    }

    impl Drop for AdhocClaims {
        fn drop(&mut self) {
            for ctl in self.ctl.drain(..) {
                let _ = ctl.send(CaptureCtl::Shutdown);
            }
            for thread in self.threads.drain(..) {
                let _ = thread.join();
            }
        }
    }

    #[cfg(test)]
    mod target_tests {
        use super::*;

        fn board(
            selector: Option<&str>,
            keyboard: Option<&str>,
            pickable: bool,
        ) -> ksx_api::BoardRow {
            ksx_api::BoardRow {
                name: "test board".into(),
                selector: selector.map(str::to_owned),
                keyboard: keyboard.map(str::to_owned),
                pickable,
                can_type: true,
                interfaces: keyboard
                    .into_iter()
                    .map(|instance_id| ksx_api::UsbRow {
                        instance_id: instance_id.into(),
                        ..ksx_api::UsbRow::default()
                    })
                    .collect(),
                ..ksx_api::BoardRow::default()
            }
        }

        #[test]
        fn selector_resolution_is_exact_and_ambiguity_refuses() {
            let boards = vec![
                board(Some("usb:d209:0430:00"), Some("USB\\IPAC\\ONE"), true),
                board(
                    Some("usb:d209:0430:00:serial=x"),
                    Some("USB\\IPAC\\TWO"),
                    true,
                ),
            ];
            let exact = Target::from_boards(&boards, "USB:D209:0430:00").unwrap();
            assert_eq!(exact.keyboard.as_str(), "USB\\IPAC\\ONE");
            assert!(Target::from_boards(&boards, "d209:0430").is_err());

            let ambiguous = vec![
                board(Some("usb:d209:0430:00"), Some("USB\\IPAC\\ONE"), true),
                board(Some("usb:d209:0430:00"), Some("USB\\IPAC\\TWO"), true),
            ];
            assert!(Target::from_boards(&ambiguous, "usb:d209:0430:00").is_err());
        }

        #[test]
        fn a_non_keyboard_mode_board_refuses_instead_of_listening_elsewhere() {
            let boards = vec![board(Some("usb:d209:0430:00"), None, false)];
            let error = Target::from_boards(&boards, "usb:d209:0430:00").unwrap_err();
            assert!(error.contains("keyboard mode"), "{error}");
        }

        #[test]
        fn a_present_but_disconnected_keyboard_refuses_instead_of_looking_silent() {
            let mut disconnected = board(
                Some("bt:046d:b342:serial=desk"),
                Some("BTHENUM\\DEV_DESK"),
                true,
            );
            disconnected.can_type = false;
            disconnected.cannot_type_reason =
                "paired, but not connected — switch it on or replace its battery".into();

            let error =
                Target::from_boards(&[disconnected], "bt:046d:b342:serial=desk").unwrap_err();
            assert!(error.contains("not connected"), "{error}");

            let mut claimed = board(Some("usb:d209:0430:00"), Some("USB\\IPAC\\ONE"), true);
            claimed.claimed = true;
            claimed.can_type = false; // expected: WinUSB removed it from kbdclass
            assert!(Target::from_boards(&[claimed], "usb:d209:0430:00").is_ok());
        }

        fn resolved_target(claimed: bool) -> Target {
            Target {
                identities: vec!["USB\\IPAC\\ONE".into()],
                keyboard: DeviceId::new("USB\\IPAC\\ONE"),
                claimed,
            }
        }

        /// A standalone `ksx run` and Studio's persistent encoder writer do
        /// not share this daemon's [`RunState`]. The machine lease is therefore
        /// the only truthful cross-process exclusion: if it is busy, not even
        /// exact-device resolution may begin.
        #[test]
        fn a_busy_machine_lease_refuses_before_the_input_observer_starts() {
            static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "ksx-input-test-lease-{}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let held = crate::panel_programming::acquire_play_start_guard(&dir)
                .expect("hold the shared Play/programming lease");
            let observer_started = Arc::new(AtomicBool::new(false));
            let marker = Arc::clone(&observer_started);

            let refused = with_input_test_machine_lease(&dir, move || {
                marker.store(true, Ordering::SeqCst);
                Ok(())
            })
            .expect_err("a second observer must not enter the leased operation");

            assert!(refused.contains("hardware lease"), "{refused}");
            assert!(
                !observer_started.load(Ordering::SeqCst),
                "exact-device observation began while another process owned the machine"
            );
            drop(held);

            with_input_test_machine_lease(&dir, || {
                assert!(
                    crate::panel_programming::acquire_play_start_guard(&dir).is_err(),
                    "the observer did not retain the machine lease for its operation"
                );
                Ok(())
            })
            .expect("the diagnostic acquires the released lease");
            let after = crate::panel_programming::acquire_play_start_guard(&dir)
                .expect("the diagnostic released the lease after observer cleanup");
            drop(after);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn play_winning_during_resolution_opens_neither_a_panel_tap_nor_an_adhoc_claim() {
            for claimed in [false, true] {
                let state = Arc::new(Mutex::new(crate::daemon::DaemonState::default()));
                let resolver_state = Arc::clone(&state);
                let result = resolve_target_bounded(
                    "usb:d209:0430:00".into(),
                    Instant::now() + Duration::from_secs(1),
                    Arc::new(AtomicBool::new(false)),
                    state,
                    Arc::new(AtomicBool::new(false)),
                    move |_| {
                        resolver_state.lock().unwrap().run = RunState::Starting;
                        Ok(resolved_target(claimed))
                    },
                );
                let error = result.unwrap_err();
                assert!(error.contains("no keyboard observer was opened"), "{error}");
            }
        }

        #[test]
        fn slow_resolution_obeys_the_absolute_deadline_and_cancel_budget() {
            let state = Arc::new(Mutex::new(crate::daemon::DaemonState::default()));
            let started = Instant::now();
            let timed_out = resolve_target_bounded(
                "usb:d209:0430:00".into(),
                started + Duration::from_millis(40),
                Arc::new(AtomicBool::new(false)),
                Arc::clone(&state),
                Arc::new(AtomicBool::new(false)),
                |_| {
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(resolved_target(false))
                },
            )
            .unwrap();
            assert!(timed_out.is_none());
            assert!(
                started.elapsed() < Duration::from_millis(300),
                "resolution outlived the wall-clock budget: {:?}",
                started.elapsed()
            );

            let cancel = Arc::new(AtomicBool::new(false));
            let set_cancel = Arc::clone(&cancel);
            let canceller = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(40));
                set_cancel.store(true, Ordering::SeqCst);
            });
            let started = Instant::now();
            let cancelled = resolve_target_bounded(
                "usb:d209:0430:00".into(),
                started + Duration::from_secs(2),
                cancel,
                state,
                Arc::new(AtomicBool::new(false)),
                |_| {
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(resolved_target(true))
                },
            )
            .unwrap();
            canceller.join().unwrap();
            assert!(cancelled.is_none());
            assert!(
                started.elapsed() < Duration::from_millis(300),
                "cancel waited for the slow resolver: {:?}",
                started.elapsed()
            );
        }

        /// A timeout returns control promptly, but Windows inventory itself is
        /// not cancellable. The shared observer must refuse another resolver
        /// until that helper really exits, otherwise one bad device stack can
        /// grow an unbounded thread per retry.
        #[test]
        fn a_draining_resolver_fences_retries_without_extending_the_deadline() {
            let state = Arc::new(Mutex::new(crate::daemon::DaemonState::default()));
            let in_flight = Arc::new(AtomicBool::new(false));
            let release = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let first_release = Arc::clone(&release);
            let first_calls = Arc::clone(&calls);
            let started = Instant::now();
            let first = resolve_target_bounded(
                "usb:d209:0430:00".into(),
                started + Duration::from_millis(40),
                Arc::new(AtomicBool::new(false)),
                Arc::clone(&state),
                Arc::clone(&in_flight),
                move |_| {
                    first_calls.fetch_add(1, Ordering::SeqCst);
                    while !first_release.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Ok(resolved_target(false))
                },
            )
            .unwrap();
            assert!(first.is_none());
            assert!(started.elapsed() < Duration::from_millis(300));
            assert!(in_flight.load(Ordering::SeqCst));

            let retry_started = Arc::new(AtomicBool::new(false));
            let retry_probe = Arc::clone(&retry_started);
            let retry = resolve_target_bounded(
                "usb:d209:0430:00".into(),
                Instant::now() + Duration::from_secs(1),
                Arc::new(AtomicBool::new(false)),
                Arc::clone(&state),
                Arc::clone(&in_flight),
                move |_| {
                    retry_probe.store(true, Ordering::SeqCst);
                    Ok(resolved_target(false))
                },
            )
            .unwrap_err();
            assert!(retry.contains("still completing"), "{retry}");
            assert!(
                !retry_started.load(Ordering::SeqCst),
                "retry spawned a resolver"
            );

            release.store(true, Ordering::SeqCst);
            let drained = Instant::now() + Duration::from_secs(2);
            while in_flight.load(Ordering::SeqCst) {
                assert!(Instant::now() < drained, "resolver fence did not release");
                std::thread::sleep(Duration::from_millis(2));
            }
            let final_calls = Arc::clone(&calls);
            let resolved = resolve_target_bounded(
                "usb:d209:0430:00".into(),
                Instant::now() + Duration::from_secs(1),
                Arc::new(AtomicBool::new(false)),
                state,
                in_flight,
                move |_| {
                    final_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(resolved_target(false))
                },
            )
            .unwrap();
            assert!(resolved.is_some());
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }

        /// Regression: Play can start from the tray without traversing the
        /// pipe gate. A quiet keyboard still has to release its Raw Input
        /// registration promptly; waiting for a key event is too late.
        #[test]
        fn a_play_transition_stops_a_quiet_raw_input_observer() {
            let state = Arc::new(Mutex::new(crate::daemon::DaemonState::default()));
            let cancel = Arc::new(AtomicBool::new(false));
            let stop = Arc::new(AtomicBool::new(false));
            let play_started = Arc::new(AtomicBool::new(false));
            let watch = InputTestWatch::start(
                cancel,
                Arc::clone(&stop),
                Arc::clone(&state),
                Arc::clone(&play_started),
            )
            .unwrap();

            state.lock().unwrap().run = RunState::Starting;
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !stop.load(Ordering::SeqCst) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "input ownership watcher did not stop"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(play_started.load(Ordering::SeqCst));
            drop(watch);
        }

        /// Regression: the claimed-panel loop can be blocked in `recv_timeout`
        /// after its top-of-loop ownership check. A tray-started session that
        /// wins during that wait must reject the event that wakes the receive,
        /// not count it and notice Play only on the following iteration.
        #[test]
        fn a_claimed_event_received_after_play_starts_is_not_accepted() {
            let state = Arc::new(Mutex::new(crate::daemon::DaemonState::default()));
            let target = resolved_target(true);
            state.lock().unwrap().run = RunState::Starting;

            let error = claimed_transition_while_idle(
                &state,
                &target,
                KeyEvent {
                    device: DeviceId::new("USB\\IPAC\\ONE"),
                    key: Key::J,
                    down: true,
                    t: 0,
                },
            )
            .unwrap_err();

            assert!(error.contains("before accepting another signal"), "{error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksx_core::DeviceId;

    fn event(device: &str, key: Key, down: bool) -> KeyEvent {
        KeyEvent {
            device: DeviceId::new(device),
            key,
            down,
            t: 0,
        }
    }

    const PATIENCE: Duration = Duration::from_secs(5);

    /// The defect, in one test: a claimed board's keys arrive as `KeyEvent`s on
    /// the claim's own stream and nowhere else. Before this module a learn read
    /// Raw Input only — an empty `raw` here — and answered `None`.
    #[test]
    fn a_key_from_a_claimed_board_is_learned_with_no_raw_input_at_all() {
        let (keys, key_rx) = crossbeam_channel::unbounded();
        let (_raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        keys.send(event(r"USB\VID_D209&PID_0430&MI_00\7&1", Key::G, true))
            .unwrap();

        let hit = first_press(&key_rx, &raw_rx, PATIENCE, &AtomicBool::new(false));
        assert_eq!(
            hit.map(Press::named),
            Some((
                r"USB\VID_D209&PID_0430&MI_00\7&1".to_owned(),
                "G".to_owned()
            ))
        );
    }

    /// Raw Input still wins on its own, unchanged — an ordinary keyboard must
    /// not have got worse.
    #[test]
    fn a_key_from_an_unprepared_board_is_learned_over_raw_input() {
        let (_keys, key_rx) = crossbeam_channel::unbounded::<KeyEvent>();
        let (raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        raw.send(Press {
            device: r"HID\VID_03F0&PID_034A".to_owned(),
            key: Key::F2,
        })
        .unwrap();

        let hit = first_press(&key_rx, &raw_rx, PATIENCE, &AtomicBool::new(false));
        assert_eq!(hit.unwrap().key, Key::F2);
    }

    /// A release is not a binding, and neither is a key with no preset name.
    /// Both are skipped *without ending the observation* — the next real press
    /// still lands, which is what makes "press the key" work when the user is
    /// already holding Shift.
    #[test]
    fn releases_and_unnameable_keys_are_skipped_not_answered() {
        let (keys, key_rx) = crossbeam_channel::unbounded();
        let (_raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        keys.send(event("panel", Key::G, false)).unwrap();
        keys.send(event("panel", Key::Unknown, true)).unwrap();
        keys.send(event("panel", Key::F2, true)).unwrap();

        let hit = first_press(&key_rx, &raw_rx, PATIENCE, &AtomicBool::new(false));
        assert_eq!(hit.unwrap().key, Key::F2);
    }

    #[test]
    fn silence_times_out() {
        let (_keys, key_rx) = crossbeam_channel::unbounded::<KeyEvent>();
        let (_raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        let hit = first_press(
            &key_rx,
            &raw_rx,
            Duration::from_millis(60),
            &AtomicBool::new(false),
        );
        assert_eq!(hit, None);
    }

    /// Every source ending is also an end — otherwise a learn on a machine
    /// where nothing can listen would sit at "listening" for the full ten
    /// seconds instead of saying so.
    #[test]
    fn no_live_source_ends_the_observation_early() {
        let (keys, key_rx) = crossbeam_channel::unbounded::<KeyEvent>();
        let (raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        drop(keys);
        drop(raw);

        let start = Instant::now();
        let hit = first_press(&key_rx, &raw_rx, PATIENCE, &AtomicBool::new(false));
        assert_eq!(hit, None);
        assert!(start.elapsed() < PATIENCE, "waited for a dead observation");
    }

    #[test]
    fn cancel_ends_the_observation() {
        let (_keys, key_rx) = crossbeam_channel::unbounded::<KeyEvent>();
        let (_raw, raw_rx) = crossbeam_channel::unbounded::<Press>();
        let hit = first_press(&key_rx, &raw_rx, PATIENCE, &AtomicBool::new(true));
        assert_eq!(hit, None);
    }
}
