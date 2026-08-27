//! Backend selection: which driver stack materializes a slot.
//!
//! # The rule
//!
//! **Config expresses intent, not plumbing.** A slot says
//! `persona = "dualsense"`; it never says `backend = "hidmaestro"`. The backend
//! is *derived* from the persona ([`ksx_core::Persona::backend`]), for a reason
//! that is not stylistic: the two are not independent. `persona = "xbox360",
//! backend = "hidmaestro"` would be a configuration a user could write, could
//! not get working, and would then debug — so it must not be expressible.
//!
//! Concretely (`docs/ENHANCEMENTS.md` E1/E4):
//! - `xbox360`, `playstation` → **ViGEmBus in the current capability matrix**.
//!   It is the shipped compatibility/fallback lane, and its X360 target reaches
//!   Microsoft's own `xusb22.sys`. The historical HIDMaestro WGI issue was fixed
//!   upstream; it is not the reason for preserving this explicit routing.
//! - `dualsense`, `switchpro`, `xboxseries` → **HIDMaestro**, because ViGEmBus
//!   cannot express them at all and never will (the project is frozen).
//!
//! # Laziness is part of the rule
//!
//! [`RoutedBackend`] only builds the HIDMaestro backend when a slot actually
//! asks for it. A cabinet running only X360/DS4 pads never constructs it,
//! never probes for the driver, and cannot be broken by its absence. A
//! DualSense-only session likewise does not open ViGEmBus.

use ksx_core::{PadBackend, PadState, Persona};

use crate::backend::{Feedback, PadHandle, VirtualPadBackend};
use crate::error::OutputError;

/// How a [`RoutedBackend`] obtains the HIDMaestro backend, the first time a
/// persona needs it.
///
/// A boxed factory rather than an eagerly-built backend so that the ordinary
/// cabinet never pays for a driver it does not use.
pub type BackendFactory =
    Box<dyn FnMut() -> Result<Box<dyn VirtualPadBackend>, OutputError> + Send>;

/// Backwards-compatible name for the second-stack factory.
pub type HidMaestroFactory = BackendFactory;

struct Entry {
    which: PadBackend,
    inner: PadHandle,
}

/// Routes each pad to the backend its persona requires.
///
/// Implements [`VirtualPadBackend`] itself, so the engine's output thread holds
/// one `Box<dyn VirtualPadBackend>` exactly as it always did and knows nothing
/// about there being two stacks.
///
/// Handles are re-issued from the router's own monotonic counter, never passed
/// through: two backends would otherwise both hand out `PadHandle(0)` and the
/// router could not tell them apart. Router handles are never reused, so a
/// stale handle always resolves to [`OutputError::UnknownHandle`] rather than
/// aliasing a live pad on the *other* stack — the worst possible failure here.
pub struct RoutedBackend {
    vigem: Option<Box<dyn VirtualPadBackend>>,
    hidmaestro: Option<Box<dyn VirtualPadBackend>>,
    vigem_factory: Option<BackendFactory>,
    hidmaestro_factory: Option<HidMaestroFactory>,
    /// Whether [`Persona::can_plug`] is enforced before anything is dispatched.
    ///
    /// True for the routers ksx builds for itself, where the answer is a fact
    /// about this binary and there is nothing to gain by handing an unfinished
    /// persona to a stack that cannot create it. False for
    /// [`RoutedBackend::with_hidmaestro`], which lets contract tests exercise
    /// the complete dispatch table with a caller-supplied backend.
    enforce_build_capability: bool,
    pads: std::collections::BTreeMap<u32, Entry>,
    next_id: u32,
}

impl RoutedBackend {
    /// A router with only ViGEmBus.
    pub fn vigem_only(vigem: Box<dyn VirtualPadBackend>) -> Self {
        Self {
            vigem: Some(vigem),
            hidmaestro: None,
            vigem_factory: None,
            hidmaestro_factory: None,
            enforce_build_capability: true,
            pads: Default::default(),
            next_id: 0,
        }
    }

    /// The production router: ViGEmBus now, HIDMaestro if and when a slot asks
    /// for a persona that needs it **and this build can create one**.
    ///
    /// This is the one every entry point should use. It costs nothing on a
    /// cabinet that uses neither the DualSense, Switch Pro, nor Xbox Series
    /// persona: [`HidMaestroBackend::connect`](crate::HidMaestroBackend::connect)
    /// is never called, so the driver is never probed for and its absence
    /// cannot fail a run.
    ///
    /// The factory is wired for the one live DualSense path; the per-persona
    /// build gate still refuses Switch Pro and Xbox Series before this factory
    /// can touch the machine.
    pub fn standard(vigem: Box<dyn VirtualPadBackend>) -> Self {
        Self {
            vigem: Some(vigem),
            hidmaestro: None,
            vigem_factory: None,
            hidmaestro_factory: Some(Box::new(|| {
                crate::HidMaestroBackend::connect()
                    .map(|b| Box::new(b) as Box<dyn VirtualPadBackend>)
            })),
            enforce_build_capability: true,
            pads: Default::default(),
            next_id: 0,
        }
    }

    /// Production factories without opening either driver stack yet.
    ///
    /// A session that needs no ViGEm persona never opens ViGEmBus. Production
    /// entry points use this so a DualSense-only session does not acquire the
    /// compatibility backend as a hidden prerequisite.
    pub fn standard_lazy(vigem: BackendFactory) -> Self {
        Self {
            vigem: None,
            hidmaestro: None,
            vigem_factory: Some(vigem),
            hidmaestro_factory: Some(Box::new(|| {
                crate::HidMaestroBackend::connect()
                    .map(|b| Box::new(b) as Box<dyn VirtualPadBackend>)
            })),
            enforce_build_capability: true,
            pads: Default::default(),
            next_id: 0,
        }
    }

    /// A router that will build the HIDMaestro backend on first need, from a
    /// factory the caller vouches for.
    ///
    /// Does **not** apply the build-capability gate — see
    /// [`RoutedBackend::enforce_build_capability`]. Use
    /// [`RoutedBackend::standard`] for anything a user's config reaches.
    pub fn with_hidmaestro(vigem: Box<dyn VirtualPadBackend>, factory: HidMaestroFactory) -> Self {
        Self {
            vigem: Some(vigem),
            hidmaestro: None,
            vigem_factory: None,
            hidmaestro_factory: Some(factory),
            enforce_build_capability: false,
            pads: Default::default(),
            next_id: 0,
        }
    }

    /// Fully lazy two-stack router for driverless contract tests and future
    /// production preflight wiring.
    pub fn with_factories(vigem: BackendFactory, hidmaestro: HidMaestroFactory) -> Self {
        Self {
            vigem: None,
            hidmaestro: None,
            vigem_factory: Some(vigem),
            hidmaestro_factory: Some(hidmaestro),
            enforce_build_capability: false,
            pads: Default::default(),
            next_id: 0,
        }
    }

    /// Whether the HIDMaestro backend has actually been constructed.
    ///
    /// Diagnostic, and the thing the laziness test asserts on.
    pub fn hidmaestro_started(&self) -> bool {
        self.hidmaestro.is_some()
    }

    /// Whether ViGEmBus has actually been constructed.
    pub fn vigem_started(&self) -> bool {
        self.vigem.is_some()
    }

    /// Which backend a persona routes to. Restates nothing — it is
    /// [`Persona::backend`].
    pub fn backend_for(persona: Persona) -> PadBackend {
        persona.backend()
    }

    fn stack(&mut self, which: PadBackend) -> Result<&mut Box<dyn VirtualPadBackend>, OutputError> {
        match which {
            PadBackend::Vigem => {
                if self.vigem.is_none() {
                    let factory = self
                        .vigem_factory
                        .as_mut()
                        .ok_or(OutputError::BackendUnavailable(PadBackend::Vigem))?;
                    self.vigem = Some(factory()?);
                }
                Ok(self.vigem.as_mut().expect("just built"))
            }
            PadBackend::HidMaestro => {
                if self.hidmaestro.is_none() {
                    let factory = self
                        .hidmaestro_factory
                        .as_mut()
                        .ok_or(OutputError::BackendUnavailable(PadBackend::HidMaestro))?;
                    self.hidmaestro = Some(factory()?);
                }
                Ok(self.hidmaestro.as_mut().expect("just built"))
            }
        }
    }

    fn entry(&self, handle: PadHandle) -> Result<&Entry, OutputError> {
        self.pads
            .get(&handle.0)
            .ok_or(OutputError::UnknownHandle(handle))
    }

    fn resolve(
        &mut self,
        handle: PadHandle,
    ) -> Result<(&mut Box<dyn VirtualPadBackend>, PadHandle), OutputError> {
        let entry = *self
            .pads
            .get(&handle.0)
            .map(|e| (e.which, e.inner))
            .as_ref()
            .ok_or(OutputError::UnknownHandle(handle))?;
        let (which, inner) = entry;
        let stack = match which {
            PadBackend::Vigem => self
                .vigem
                .as_mut()
                .ok_or(OutputError::UnknownHandle(handle))?,
            // Already built: a handle cannot exist for a backend that was never
            // constructed.
            PadBackend::HidMaestro => self
                .hidmaestro
                .as_mut()
                .ok_or(OutputError::UnknownHandle(handle))?,
        };
        Ok((stack, inner))
    }
}

impl VirtualPadBackend for RoutedBackend {
    fn service(&mut self) -> Result<(), OutputError> {
        if let Some(backend) = self.vigem.as_mut() {
            backend.service()?;
        }
        if let Some(backend) = self.hidmaestro.as_mut() {
            backend.service()?;
        }
        Ok(())
    }

    fn plug(&mut self) -> Result<PadHandle, OutputError> {
        self.plug_persona(Persona::default())
    }

    fn plug_persona(&mut self, persona: Persona) -> Result<PadHandle, OutputError> {
        // Checked before the machine is consulted, because the machine is the
        // wrong witness. Reaching the factory instead would probe for
        // HIDMaestro and report whatever it found — so on a machine where the
        // driver IS installed the failure would arrive as a driver error, from
        // a stack that could not have created the pad either way.
        if self.enforce_build_capability && !persona.can_plug() {
            return Err(OutputError::PersonaNotImplemented(persona));
        }
        let which = Self::backend_for(persona);
        let inner = self.stack(which)?.plug_persona(persona)?;
        let id = self.next_id;
        self.next_id += 1;
        self.pads.insert(id, Entry { which, inner });
        Ok(PadHandle(id))
    }

    fn persona(&self, handle: PadHandle) -> Option<Persona> {
        let entry = self.pads.get(&handle.0)?;
        match entry.which {
            PadBackend::Vigem => self.vigem.as_ref()?.persona(entry.inner),
            PadBackend::HidMaestro => self.hidmaestro.as_ref()?.persona(entry.inner),
        }
    }

    fn user_index(&self, handle: PadHandle) -> Option<u8> {
        let entry = self.pads.get(&handle.0)?;
        match entry.which {
            PadBackend::Vigem => self.vigem.as_ref()?.user_index(entry.inner),
            PadBackend::HidMaestro => self.hidmaestro.as_ref()?.user_index(entry.inner),
        }
    }

    fn update(&mut self, handle: PadHandle, state: &PadState) -> Result<(), OutputError> {
        let (stack, inner) = self.resolve(handle)?;
        stack.update(inner, state)
    }

    fn poll_feedback(&mut self, handle: PadHandle) -> Option<Feedback> {
        let (stack, inner) = self.resolve(handle).ok()?;
        stack.poll_feedback(inner)
    }

    fn unplug(&mut self, handle: PadHandle) -> Result<(), OutputError> {
        // Look up first, remove only on the way out: a failed unplug must not
        // orphan the pad in the underlying backend with no handle left to
        // retry through.
        let _ = self.entry(handle)?;
        let (stack, inner) = self.resolve(handle)?;
        let result = stack.unplug(inner);
        if result.is_ok() {
            self.pads.remove(&handle.0);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use ksx_core::pad::XButtons;

    use super::*;
    use crate::MockBackend;

    /// What ONE stack was actually handed.
    ///
    /// **Why this exists (2026-08-26 audit).** The router owns its backends
    /// behind `Box<dyn VirtualPadBackend>` and exposes no way to reach them, so
    /// a test holding only the router could not see WHICH stack received a
    /// call — which is the entire property the routing tests are about. They
    /// asserted on `r.persona(handle)` instead, which reads the router's own
    /// `pads` map and never touches a backend.
    ///
    /// That was not a theoretical gap. Measured: replacing
    /// `RoutedBackend::update` with a version that ignores `entry.which` and
    /// dispatches every pad to the ViGEm stack — so every DualSense state lands
    /// on an Xbox 360 pad, the exact failure the module doc calls "the worst
    /// possible failure here" — left all 13 router tests and all 45
    /// `ksx-output` tests passing.
    #[derive(Debug, Default)]
    struct Tap {
        /// Every `(handle, state)` this stack was handed, in order.
        updates: Vec<(PadHandle, PadState)>,
        /// Feedback scripted onto this stack, drained by whichever pad asks.
        feedback: VecDeque<Feedback>,
        /// How many times this stack's `service` was called.
        services: usize,
    }

    /// A [`MockBackend`] with a window: it delegates every call, and publishes
    /// what it was handed through a `Tap` the test still holds.
    struct Recording {
        inner: MockBackend,
        tap: Arc<Mutex<Tap>>,
        /// Makes `service` fail, for the fan-out error policy.
        fail_service: bool,
    }

    impl Recording {
        fn new(tap: Arc<Mutex<Tap>>) -> Self {
            Self {
                inner: MockBackend::new(),
                tap,
                fail_service: false,
            }
        }

        fn failing_service(tap: Arc<Mutex<Tap>>) -> Self {
            Self {
                fail_service: true,
                ..Self::new(tap)
            }
        }
    }

    impl VirtualPadBackend for Recording {
        fn service(&mut self) -> Result<(), OutputError> {
            self.tap.lock().unwrap().services += 1;
            if self.fail_service {
                return Err(OutputError::HidMaestroHostUnavailable);
            }
            Ok(())
        }

        fn plug(&mut self) -> Result<PadHandle, OutputError> {
            self.inner.plug()
        }

        fn plug_persona(&mut self, persona: Persona) -> Result<PadHandle, OutputError> {
            self.inner.plug_persona(persona)
        }

        fn persona(&self, handle: PadHandle) -> Option<Persona> {
            self.inner.persona(handle)
        }

        fn user_index(&self, handle: PadHandle) -> Option<u8> {
            self.inner.user_index(handle)
        }

        fn update(&mut self, handle: PadHandle, state: &PadState) -> Result<(), OutputError> {
            // Delegate first, so the mock's unknown-handle contract still
            // governs and the tap only ever records deliveries that happened.
            self.inner.update(handle, state)?;
            self.tap.lock().unwrap().updates.push((handle, *state));
            Ok(())
        }

        fn poll_feedback(&mut self, _handle: PadHandle) -> Option<Feedback> {
            self.tap.lock().unwrap().feedback.pop_front()
        }

        fn unplug(&mut self, handle: PadHandle) -> Result<(), OutputError> {
            self.inner.unplug(handle)
        }
    }

    /// A lazy two-stack router whose stacks are both observable.
    fn recording_router() -> (RoutedBackend, Arc<Mutex<Tap>>, Arc<Mutex<Tap>>) {
        recording_router_with(false)
    }

    fn recording_router_with(
        vigem_service_fails: bool,
    ) -> (RoutedBackend, Arc<Mutex<Tap>>, Arc<Mutex<Tap>>) {
        let vigem = Arc::new(Mutex::new(Tap::default()));
        let hidmaestro = Arc::new(Mutex::new(Tap::default()));
        let v = vigem.clone();
        let h = hidmaestro.clone();
        let router = RoutedBackend::with_factories(
            Box::new(move || {
                let tap = v.clone();
                Ok(Box::new(if vigem_service_fails {
                    Recording::failing_service(tap)
                } else {
                    Recording::new(tap)
                }) as Box<dyn VirtualPadBackend>)
            }),
            Box::new(move || Ok(Box::new(Recording::new(h.clone())) as Box<dyn VirtualPadBackend>)),
        );
        (router, vigem, hidmaestro)
    }

    fn router() -> (RoutedBackend, Arc<AtomicUsize>) {
        let builds = Arc::new(AtomicUsize::new(0));
        let counter = builds.clone();
        let router = RoutedBackend::with_hidmaestro(
            Box::new(MockBackend::new()),
            Box::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                Ok(Box::new(MockBackend::new()) as Box<dyn VirtualPadBackend>)
            }),
        );
        (router, builds)
    }

    fn lazy_router() -> (RoutedBackend, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let vigem_builds = Arc::new(AtomicUsize::new(0));
        let hidmaestro_builds = Arc::new(AtomicUsize::new(0));
        let vigem_counter = vigem_builds.clone();
        let hidmaestro_counter = hidmaestro_builds.clone();
        let router = RoutedBackend::with_factories(
            Box::new(move || {
                vigem_counter.fetch_add(1, Ordering::Relaxed);
                Ok(Box::new(MockBackend::new()) as Box<dyn VirtualPadBackend>)
            }),
            Box::new(move || {
                hidmaestro_counter.fetch_add(1, Ordering::Relaxed);
                Ok(Box::new(MockBackend::new()) as Box<dyn VirtualPadBackend>)
            }),
        );
        (router, vigem_builds, hidmaestro_builds)
    }

    #[test]
    fn the_rule_is_derived_from_the_persona_and_nothing_else() {
        assert_eq!(
            RoutedBackend::backend_for(Persona::Xbox360),
            PadBackend::Vigem
        );
        assert_eq!(
            RoutedBackend::backend_for(Persona::PlayStation),
            PadBackend::Vigem
        );
        for p in [Persona::DualSense, Persona::SwitchPro, Persona::XboxSeries] {
            assert_eq!(RoutedBackend::backend_for(p), PadBackend::HidMaestro, "{p}");
        }
    }

    /// The cabinet's own configuration must never touch HIDMaestro — not even
    /// to probe for it.
    #[test]
    fn a_vigem_only_cabinet_never_constructs_the_hidmaestro_backend() {
        let (mut r, builds) = router();
        for _ in 0..4 {
            r.plug_persona(Persona::Xbox360).unwrap();
        }
        for _ in 0..4 {
            r.plug_persona(Persona::PlayStation).unwrap();
        }
        assert_eq!(builds.load(Ordering::Relaxed), 0);
        assert!(!r.hidmaestro_started());
    }

    #[test]
    fn the_hidmaestro_backend_is_built_once_on_first_need() {
        let (mut r, builds) = router();
        r.plug_persona(Persona::Xbox360).unwrap();
        assert_eq!(builds.load(Ordering::Relaxed), 0);
        r.plug_persona(Persona::DualSense).unwrap();
        assert_eq!(builds.load(Ordering::Relaxed), 1);
        r.plug_persona(Persona::SwitchPro).unwrap();
        assert_eq!(builds.load(Ordering::Relaxed), 1, "built once, reused");
        assert!(r.hidmaestro_started());
    }

    #[test]
    fn either_stack_can_start_first_without_constructing_the_other() {
        let (mut r, vigem_builds, hidmaestro_builds) = lazy_router();
        assert!(!r.vigem_started());
        assert!(!r.hidmaestro_started());

        r.plug_persona(Persona::DualSense).unwrap();
        assert_eq!(hidmaestro_builds.load(Ordering::Relaxed), 1);
        assert_eq!(vigem_builds.load(Ordering::Relaxed), 0);
        assert!(!r.vigem_started());

        r.plug_persona(Persona::Xbox360).unwrap();
        assert_eq!(hidmaestro_builds.load(Ordering::Relaxed), 1);
        assert_eq!(vigem_builds.load(Ordering::Relaxed), 1);
        assert!(r.vigem_started());
    }

    #[test]
    fn a_lazy_production_router_opens_nothing_until_a_persona_is_plugged() {
        // 2026-08-20 flip: with every persona pluggable there is no refusal
        // to observe, so laziness is pinned directly — construction opens
        // nothing, and plugging a ViGEm persona opens only ViGEm.
        let vigem_builds = Arc::new(AtomicUsize::new(0));
        let counter = vigem_builds.clone();
        let mut r = RoutedBackend::standard_lazy(Box::new(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(MockBackend::new()) as Box<dyn VirtualPadBackend>)
        }));

        assert_eq!(vigem_builds.load(Ordering::Relaxed), 0);
        assert!(!r.vigem_started());
        assert!(!r.hidmaestro_started());

        r.plug_persona(Persona::Xbox360).unwrap();
        assert_eq!(vigem_builds.load(Ordering::Relaxed), 1);
        assert!(r.vigem_started());
        assert!(!r.hidmaestro_started());
    }

    /// Handles from the two stacks must never collide. Both mocks hand out
    /// `PadHandle(0)` first, so without re-issuing, an update meant for the
    /// DualSense would land on the X360 pad.
    ///
    /// Hardened 2026-08-26: the line below this comment used to be
    /// `assert_eq!(r.persona(x), Some(Persona::Xbox360))` under the comment
    /// "the X360 pad must have received nothing" — metadata out of the router's
    /// own map, never the delivered payload. It could not observe a mis-route,
    /// and measurably did not: a `RoutedBackend::update` rewritten to dispatch
    /// everything to the ViGEm stack passed this test and the other 44. What is
    /// checked now is what each stack was HANDED.
    #[test]
    fn handles_from_the_two_stacks_never_alias() {
        let (mut r, vigem, hidmaestro) = recording_router();
        let x = r.plug_persona(Persona::Xbox360).unwrap();
        let d = r.plug_persona(Persona::DualSense).unwrap();
        assert_ne!(x.raw(), d.raw());
        assert_eq!(r.persona(x), Some(Persona::Xbox360));
        assert_eq!(r.persona(d), Some(Persona::DualSense));

        let pressed = PadState {
            buttons: XButtons::A,
            ..PadState::default()
        };
        r.update(d, &pressed).unwrap();
        assert!(
            vigem.lock().unwrap().updates.is_empty(),
            "a DualSense update reached the ViGEm stack — the mis-route this \
             router exists to prevent",
        );
        assert_eq!(
            hidmaestro.lock().unwrap().updates,
            vec![(PadHandle(0), pressed)],
            "the DualSense update must arrive on the HIDMaestro stack, at that \
             stack's OWN handle, exactly once",
        );

        // The other direction, and the inner handles collide on purpose: both
        // mocks issued `PadHandle(0)`, so a router that passed handles through
        // instead of re-issuing would look correct right up to here.
        let released = PadState::default();
        r.update(x, &released).unwrap();
        assert_eq!(
            vigem.lock().unwrap().updates,
            vec![(PadHandle(0), released)],
        );
        assert_eq!(
            hidmaestro.lock().unwrap().updates.len(),
            1,
            "the X360 update must not also land on the HIDMaestro pad",
        );

        r.unplug(d).unwrap();
        assert!(matches!(
            r.update(d, &pressed).unwrap_err(),
            OutputError::UnknownHandle(_)
        ));
        assert_eq!(
            hidmaestro.lock().unwrap().updates.len(),
            1,
            "an update on a dead handle must deliver nothing",
        );
        // ...and the surviving X360 pad is untouched by its neighbour's death.
        r.update(x, &pressed).unwrap();
        assert_eq!(vigem.lock().unwrap().updates.len(), 2);
    }

    #[test]
    fn a_stale_handle_never_aliases_a_later_pad_on_either_stack() {
        let (mut r, _) = router();
        let first = r.plug_persona(Persona::DualSense).unwrap();
        r.unplug(first).unwrap();
        let second = r.plug_persona(Persona::Xbox360).unwrap();
        assert_ne!(first.raw(), second.raw());
        assert_eq!(r.persona(first), None);
    }

    #[test]
    fn without_a_factory_a_hidmaestro_persona_is_refused_not_downgraded() {
        let mut r = RoutedBackend::vigem_only(Box::new(MockBackend::new()));
        let err = r.plug_persona(Persona::DualSense).unwrap_err();
        assert!(
            matches!(err, OutputError::BackendUnavailable(PadBackend::HidMaestro)),
            "{err}"
        );
        // A ViGEm persona still works on the same router.
        assert!(r.plug_persona(Persona::PlayStation).is_ok());
    }

    // RETIRED TEST, AND THE REGRESSION IT PINNED (retro leg flip 2026-08-20).
    //
    // A production router must refuse the unfinished HIDMaestro personas
    // WITHOUT CONSULTING THE MACHINE, because the machine's answer is the wrong
    // one: on a box where HIDMaestro is installed the probe says yes, and the
    // pad still cannot be created. A gate that flips with an install would
    // offer a persona that plugs no better than before. The enforcement still
    // ships — `plug_persona` checks `enforce_build_capability && !can_plug()`
    // before it reaches any factory — but with every persona pluggable there is
    // no subject left to observe it with. The test returns verbatim with the
    // next gated persona; git history holds its shape.
    //
    // Demoted from `///` to `//` on 2026-08-26. As a doc comment it had no item
    // of its own left and rustdoc silently attached it to
    // `the_cabinet_personas_never_touch_the_hidmaestro_side` below, which tests
    // nothing of the kind — the same defect as commit 8bab1c3, "a doc block on
    // the wrong function". A `///` claiming a guard that does not run is worse
    // than no comment at all.

    #[test]
    fn the_cabinet_personas_never_touch_the_hidmaestro_side() {
        // 2026-08-20 flip: no unbuildable persona remains, so the pinned
        // property narrows to its second half — the cabinet's own personas
        // never touch the HIDMaestro side.
        let mut r = RoutedBackend::standard(Box::new(MockBackend::new()));
        assert!(r.plug_persona(Persona::Xbox360).is_ok());
        assert!(r.plug_persona(Persona::PlayStation).is_ok());
        assert!(!r.hidmaestro_started());
    }

    #[test]
    fn a_failing_factory_surfaces_its_own_error_verbatim() {
        let mut r = RoutedBackend::with_hidmaestro(
            Box::new(MockBackend::new()),
            Box::new(|| {
                Err(OutputError::HidMaestroMissing {
                    probe: "looked for X and found none".into(),
                })
            }),
        );
        let err = r.plug_persona(Persona::XboxSeries).unwrap_err();
        assert!(
            matches!(err, OutputError::HidMaestroMissing { .. }),
            "{err}"
        );
        // And it retries next time rather than caching the failure — the user
        // may have installed the driver in between.
        assert!(r.plug_persona(Persona::XboxSeries).is_err());
        assert!(!r.hidmaestro_started());
    }

    /// `standard()` must be as lazy as the hand-wired router: a run that
    /// touches only ViGEm personas has to succeed whatever else is missing.
    #[test]
    fn the_standard_router_still_runs_a_full_cabinet_without_hidmaestro() {
        let mut r = RoutedBackend::standard(Box::new(MockBackend::new()));
        for _ in 0..4 {
            r.plug_persona(Persona::Xbox360).unwrap();
        }
        for _ in 0..4 {
            r.plug_persona(Persona::PlayStation).unwrap();
        }
        assert!(!r.hidmaestro_started());
    }

    /// Each pad drains ITS OWN stack's feedback queue.
    ///
    /// Hardened 2026-08-26: this scripted nothing and asserted both polls
    /// return `None`. Every routing decision returns `None` against an empty
    /// queue, so the test could observe nothing about "the stack that owns the
    /// pad" — it caught a panic and that is all. Distinct values per stack make
    /// a cross-over visible: rumble arriving on the wrong pad is a defect a
    /// player feels immediately and cannot diagnose.
    #[test]
    fn feedback_is_drained_from_the_stack_that_owns_the_pad() {
        let (mut r, vigem, hidmaestro) = recording_router();
        let x = r.plug_persona(Persona::Xbox360).unwrap();
        let d = r.plug_persona(Persona::DualSense).unwrap();

        let from_vigem = Feedback {
            large_motor: 0x9C,
            small_motor: 0x4E,
            led_number: 1,
        };
        let from_hidmaestro = Feedback {
            large_motor: 0x11,
            small_motor: 0x22,
            led_number: 4,
        };
        vigem.lock().unwrap().feedback.push_back(from_vigem);
        hidmaestro
            .lock()
            .unwrap()
            .feedback
            .push_back(from_hidmaestro);

        assert_eq!(
            r.poll_feedback(x),
            Some(from_vigem),
            "the X360 pad must drain the ViGEm queue, not its neighbour's",
        );
        assert_eq!(
            r.poll_feedback(d),
            Some(from_hidmaestro),
            "the DualSense must drain the HIDMaestro queue",
        );
        // Both queues are now empty, and an empty queue never blocks.
        assert_eq!(r.poll_feedback(x), None);
        assert_eq!(r.poll_feedback(d), None);

        // A dead handle drains nothing at all — it must not fall through to
        // whichever stack happens to be first.
        r.unplug(d).unwrap();
        hidmaestro
            .lock()
            .unwrap()
            .feedback
            .push_back(from_hidmaestro);
        assert_eq!(r.poll_feedback(d), None, "a dead handle owns no queue");
        assert_eq!(
            hidmaestro.lock().unwrap().feedback.len(),
            1,
            "and it must not have consumed the live queue's entry either",
        );
    }

    /// `service` reaches BOTH stacks, and only the ones that exist.
    ///
    /// Added 2026-08-26: `RoutedBackend::service` had no test at all. It is the
    /// hook HIDMaestro renews its elevated-host lease on while a game sits
    /// idle, so a fan-out that quietly stopped reaching one stack would expire
    /// a lease mid-session with nothing failing until the pads went dead.
    #[test]
    fn service_reaches_every_stack_that_has_been_built() {
        let (mut r, vigem, hidmaestro) = recording_router();

        // Nothing built yet: servicing must not construct a stack, or the
        // laziness rule dies the first time the output thread ticks.
        r.service().unwrap();
        assert_eq!(vigem.lock().unwrap().services, 0);
        assert_eq!(hidmaestro.lock().unwrap().services, 0);
        assert!(!r.vigem_started() && !r.hidmaestro_started());

        r.plug_persona(Persona::Xbox360).unwrap();
        r.service().unwrap();
        assert_eq!(vigem.lock().unwrap().services, 1);
        assert_eq!(
            hidmaestro.lock().unwrap().services,
            0,
            "an unbuilt stack is not serviced",
        );

        r.plug_persona(Persona::DualSense).unwrap();
        r.service().unwrap();
        assert_eq!(vigem.lock().unwrap().services, 2);
        assert_eq!(hidmaestro.lock().unwrap().services, 1, "now it fans out");
    }

    /// A failing stack's `service` error reaches the supervisor verbatim.
    ///
    /// The supervisor restores keyboard passthrough on this error before it
    /// tears devices down, so an error swallowed here strands the user with a
    /// dead keyboard and no explanation.
    ///
    /// NOTE, deliberately unpinned: the production fan-out `?`s on the first
    /// error, so a ViGEm failure means HIDMaestro's `service` is not called on
    /// that tick. Nobody has decided whether the second stack should still be
    /// serviced (its lease is what the hook is for), so this test does not
    /// assert either answer — asserting the current one would defend a choice
    /// that was never made. Raised in the 2026-08-26 audit.
    #[test]
    fn a_failing_stack_surfaces_its_service_error() {
        let (mut r, vigem, _hidmaestro) = recording_router_with(true);
        r.plug_persona(Persona::Xbox360).unwrap();
        let err = r.service().unwrap_err();
        assert!(
            matches!(err, OutputError::HidMaestroHostUnavailable),
            "{err}"
        );
        assert_eq!(vigem.lock().unwrap().services, 1);
    }

    #[test]
    fn user_index_comes_from_the_owning_stack() {
        let (mut r, _) = router();
        let a = r.plug_persona(Persona::Xbox360).unwrap();
        let b = r.plug_persona(Persona::Xbox360).unwrap();
        assert_eq!(r.user_index(a), Some(0));
        assert_eq!(r.user_index(b), Some(1));
        // A HID persona takes no XInput slot on either stack.
        let ps = r.plug_persona(Persona::PlayStation).unwrap();
        assert_eq!(r.user_index(ps), None);
    }
}
