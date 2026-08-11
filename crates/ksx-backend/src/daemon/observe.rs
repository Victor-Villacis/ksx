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
pub use windows_observer::{observer, Sources};

#[cfg(windows)]
mod windows_observer {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use crossbeam_channel::Sender;
    use ksx_capture::{CaptureBackend, CaptureCtl, ExitReason};
    use ksx_core::KeyEvent;

    use super::super::learn::ObserveFn;
    use super::super::panel::{Panel, PanelTap};
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
            let tap = panel.map(|panel| panel.observe(key_tx.clone()));
            // 2 · Prepared boards nobody is holding — the first-run case.
            let adhoc = AdhocClaims::start(panel, key_tx);
            Self {
                keys,
                _adhoc: adhoc,
                _tap: tap,
            }
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
    }

    impl AdhocClaims {
        pub(super) fn start(panel: Option<&Arc<Panel>>, events: Sender<KeyEvent>) -> Self {
            let mut claims = Self {
                ctl: Vec::new(),
                threads: Vec::new(),
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
                let (ctl_tx, ctl_rx) = crossbeam_channel::unbounded::<CaptureCtl>();
                match Box::new(backend).run(events.clone(), ctl_rx) {
                    Ok(handle) => {
                        tracing::debug!(id = %candidate.id, "listening on a prepared board");
                        claims.ctl.push(ctl_tx);
                        claims.threads.push(handle);
                    }
                    Err(err) => {
                        tracing::debug!(id = %candidate.id, %err, "could not run the claim");
                    }
                }
            }
            claims
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
