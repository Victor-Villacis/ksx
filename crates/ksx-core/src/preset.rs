//! Bindings and presets, including KSX's two protected native built-ins.

use crate::key::Key;
use crate::macros::{Macro, MacroTrigger, MIN_STEP_MS, TURBO_MAX_HZ};
use crate::pad::{Axis, DpadDirection, Trigger, XButton, AXIS_MAX, AXIS_MIN};

/// One preset entry: a key drives one xbox function.
///
/// Custom axis values are first-class: `Axis { value }` holds any `i16`, not
/// just Min/Max. Equality on `Binding` gives every output category the same
/// all-keys-up aggregation rule.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum Binding {
    Button(XButton),
    Trigger(Trigger),
    Axis {
        axis: Axis,
        value: i16,
    },
    Dpad(DpadDirection),
    /// **Output nothing.** Only meaningful on a [`Chord`], where the chord's
    /// value is entirely in its CONSUMPTION: the constituents are suppressed
    /// and no endpoint is driven in their place. `[Left+Right] → Consume` is
    /// SOCD-neutral (see [`crate::socd`]).
    ///
    /// Modeled as a `Binding` variant rather than `Option<Binding>` on
    /// [`Chord`] for two reasons:
    ///
    /// 1. **The file format is keyed by function name.** `[bindings]` maps a
    ///    function to its key(s), so a consume-only row needs a *name* to live
    ///    under; as a variant it gets `consume` from the existing
    ///    `function_name`/`parse_function` pair and round-trips with no new
    ///    machinery. An `Option` would have needed a parallel spelling.
    /// 2. **`Chord.binding` is public API constructed by struct literal in
    ///    three crates.** A new variant is additive; changing the field type is
    ///    not.
    ///
    /// The cost is that `Consume` is *representable* in [`Preset::entries`],
    /// where it means nothing — an unguarded row consumes nothing by
    /// definition. The engine ignores such rows exactly like a [`Key::None`]
    /// placeholder, and validation reports them.
    Consume,
}

/// A binding that only applies while other keys are (or are not) held — the
/// CHORD (docs/INPUT-TRANSFORMS.md §1b).
///
/// A chord is deliberately **not** a new [`Binding`] kind: it is an ordinary
/// binding plus a guard, so it composes with buttons, triggers, axes and dpad
/// alike ("A+B → RT" and "A+B → lx.min" are the same construct).
///
/// - `key` is the TRIGGER: the key whose press completes the chord.
/// - `when` keys must ALL be held for the chord to apply.
/// - `unless` keys must NONE be held (MAME's `NOT`).
///
/// **Consumption**: while the chord is active, its constituents (`key` plus
/// every `when` key) are suppressed — their own unguarded entries produce
/// nothing, so the game sees the chord's output instead of the parts. `unless`
/// keys are a negative condition, never consumed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    /// Trigger key. [`Key::None`] makes the whole chord an inert placeholder.
    pub key: Key,
    /// What the chord drives while it is active.
    pub binding: Binding,
    /// All of these must be held.
    pub when: Vec<Key>,
    /// None of these may be held.
    pub unless: Vec<Key>,
}

impl Chord {
    /// A `when`-only chord (the common shape).
    pub fn new(key: Key, binding: Binding, when: Vec<Key>) -> Self {
        Self {
            key,
            binding,
            when,
            unless: Vec::new(),
        }
    }

    /// A chord that outputs NOTHING and exists purely to consume its
    /// constituents ([`Binding::Consume`]) — the SOCD-neutral primitive.
    pub fn consuming(key: Key, when: Vec<Key>) -> Self {
        Self::new(key, Binding::Consume, when)
    }

    /// Does this chord drive an endpoint at all?
    pub fn emits(&self) -> bool {
        self.binding != Binding::Consume
    }

    /// Guard size: how many extra conditions this chord carries. A chord with
    /// a LARGER guard is more specific and wins over one with a smaller guard
    /// that shares a constituent (A+B+C beats A+B). Equal specificity is a
    /// config error, caught by `ksx-config`'s validation rather than resolved
    /// by a coin flip.
    pub fn specificity(&self) -> usize {
        self.when.len() + self.unless.len()
    }

    /// The keys this chord CONSUMES while active: the trigger plus every
    /// `when` key. Guard keys listed in `unless` are not consumed — they are
    /// not held in the first place.
    pub fn constituents(&self) -> impl Iterator<Item = Key> + '_ {
        std::iter::once(self.key).chain(self.when.iter().copied())
    }

    /// Every key the guard mentions (`when` then `unless`) — the keys whose
    /// state can change this chord's activation, minus the trigger.
    pub fn guard_keys(&self) -> impl Iterator<Item = Key> + '_ {
        self.when.iter().copied().chain(self.unless.iter().copied())
    }
}

/// **Auto-fire on a plain binding** (docs/INPUT-TRANSFORMS.md §3).
///
/// Turbo used to be reachable only as [`crate::Repeat::Turbo`] on a macro,
/// which meant "make A auto-fire" cost a named sequence, a step list and a
/// scheduler entry per step. This is the cheap spelling: a rate written on the
/// binding row itself.
///
/// ```toml
/// [bindings]
/// A = { key = "G", turbo_hz = 12 }   # hold G -> A auto-fires at 12 Hz
/// ```
///
/// # Turbo is a property of the OUTPUT, not of the key
///
/// The file is keyed by function name, so one row — and therefore one rate —
/// exists per endpoint, and the model matches: [`Preset::turbo`] maps a
/// [`Binding`] to its rate. Three consequences, all of them the ones a player
/// would guess:
///
/// - **Multi-bind** (`A = [{ key = "G", turbo_hz = 12 }, "H"]`) is ONE clock.
///   Holding either key runs it, holding both runs it once, and it stops when
///   the last one comes up — the all-keys-up rule, unchanged. Two keys cannot
///   phase-fight over one button because there is only ever one phase.
/// - **Chords compose** (`rt = { key = "A", when = ["B"], turbo_hz = 8 }`). The
///   guard decides whether the chord is *driving*; turbo decides what the
///   endpoint does while it is. Guard falls → the chord stops driving → the
///   turbo stops and the endpoint releases, in the same delta batch.
/// - **Macro steps are exempt.** A step that holds a turbo'd endpoint drives it
///   flat for the step's duration. A macro already owns a timeline; running its
///   step through a second clock would make the sequence unreproducible.
///
/// # The rate is a promise about SAMPLING, not about hertz
///
/// One cycle is a press AND a release, and each half must be visible to a 60 Hz
/// poller ([`MIN_STEP_MS`]) or it never happened (§0.2). So the authored rate is
/// clamped to [`TURBO_MAX_HZ`] and then each half is floored, which is why
/// [`TurboBinding::effective_hz`] is the number worth printing rather than the
/// one that was typed.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub struct TurboBinding {
    /// The endpoint that auto-fires.
    pub binding: Binding,
    /// Requested full cycles (press + release) per second, as authored.
    /// Clamped on use, never on the way in: a file keeps the number it wrote so
    /// validation can say both it and the effective rate.
    pub hz: u32,
}

impl TurboBinding {
    pub const fn new(binding: Binding, hz: u32) -> Self {
        Self { binding, hz }
    }

    /// The authored rate after the sampling ceiling, and never zero (a
    /// `turbo_hz = 0` is a file that meant "off", not a division by zero —
    /// validation names it and the engine gives it the slowest legal cycle).
    pub const fn clamped_hz(self) -> u32 {
        if self.hz < 1 {
            1
        } else if self.hz > TURBO_MAX_HZ {
            TURBO_MAX_HZ
        } else {
            self.hz
        }
    }

    /// How long the endpoint is PRESSED in one cycle, in milliseconds.
    ///
    /// Half the cycle, floored at [`MIN_STEP_MS`]: a press the game never
    /// samples is not a press.
    pub const fn on_ms(self) -> u32 {
        let half = (1_000 / self.clamped_hz()).div_ceil(2);
        if half < MIN_STEP_MS {
            MIN_STEP_MS
        } else {
            half
        }
    }

    /// How long it is RELEASED, same floor and same reason: a released window
    /// nobody samples reads as one long hold, and the turbo silently does
    /// nothing.
    pub const fn off_ms(self) -> u32 {
        let cycle = 1_000 / self.clamped_hz();
        let rest = cycle.saturating_sub(self.on_ms());
        if rest < MIN_STEP_MS {
            MIN_STEP_MS
        } else {
            rest
        }
    }

    /// Press plus release — the cycle the engine actually runs.
    pub const fn cycle_ms(self) -> u32 {
        self.on_ms() + self.off_ms()
    }

    /// The rate this binding ACTUALLY delivers, in hertz, rounded to nearest.
    pub const fn effective_hz(self) -> u32 {
        let cycle = self.cycle_ms();
        (1_000 + cycle / 2) / cycle
    }

    /// Was the authored rate not deliverable? Returns `(asked, effective)` so
    /// validation can say both numbers rather than quietly substituting one.
    pub fn clamped(self) -> Option<(u32, u32)> {
        let effective = self.effective_hz();
        (effective != self.hz).then_some((self.hz, effective))
    }
}

/// A preset's macro table: the definitions and the rows that start them
/// (docs/INPUT-TRANSFORMS.md §1c).
///
/// One struct rather than two [`Preset`] fields so `preset.macros.is_empty()`
/// is the single check for "this preset predates macros, take the old path" —
/// the same regression guarantee `chords.is_empty()` gives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Macros {
    /// Definitions, in file order. [`MacroTrigger::index`] indexes this.
    pub defs: Vec<Macro>,
    /// `key → macro` rows. Many keys → one macro and one key → several macros
    /// are both native, exactly as for plain bindings.
    pub triggers: Vec<MacroTrigger>,
}

impl Macros {
    /// Nothing defined and nothing triggered — the byte-identical path.
    pub fn is_empty(&self) -> bool {
        self.defs.is_empty() && self.triggers.is_empty()
    }

    /// Position of the macro called `name`, compared case-insensitively (the
    /// file's function names are).
    pub fn index_of(&self, name: &str) -> Option<u16> {
        self.defs
            .iter()
            .position(|m| m.name.eq_ignore_ascii_case(name))
            .and_then(|i| u16::try_from(i).ok())
    }

    /// The macro a trigger points at, or `None` for a dangling index (which
    /// validation reports and the engine ignores).
    pub fn get(&self, index: u16) -> Option<&Macro> {
        self.defs.get(usize::from(index))
    }

    pub fn named(&self, name: &str) -> Option<&Macro> {
        self.index_of(name).and_then(|i| self.get(i))
    }

    /// Every key that starts `index`, in trigger order.
    pub fn keys_for(&self, index: u16) -> impl Iterator<Item = Key> + '_ {
        self.triggers
            .iter()
            .filter(move |t| t.index == index)
            .map(|t| t.key)
    }
}

/// A named set of key→function bindings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preset {
    pub name: String,
    /// No uniqueness constraint in either direction: many keys → one function
    /// and one key → many functions are both native; each is just more entries.
    /// Entries keyed [`Key::None`] are inert placeholders ("function present,
    /// unbound") in KSX's native model; engines must ignore them.
    ///
    /// Entries here are UNGUARDED: they apply whenever their key is down (and
    /// no active chord is consuming that key). Guarded entries live in
    /// [`Preset::chords`], which keeps this field — and every chord-free file
    /// and test — byte-for-byte unchanged.
    pub entries: Vec<(Key, Binding)>,
    /// Guarded entries: the same bindings, conditional on other keys. Empty in
    /// every preset that predates chords, which is exactly why the chord-free
    /// engine path is unchanged.
    pub chords: Vec<Chord>,
    /// Timed sequences and the keys that start them
    /// (docs/INPUT-TRANSFORMS.md §1c). Empty in every preset that predates
    /// macros, which is exactly why the macro-free engine path is unchanged.
    pub macros: Macros,
    /// Endpoints that AUTO-FIRE while something drives them
    /// (docs/INPUT-TRANSFORMS.md §3), keyed by the output rather than by the
    /// key — see [`TurboBinding`] for why that is the only spelling the file
    /// format can produce. Empty in every preset that predates turbo, which is
    /// the same regression guarantee `chords.is_empty()` gives.
    pub turbo: Vec<TurboBinding>,
    /// Endpoints that LATCH (docs/INPUT-TRANSFORMS.md §2 catalog item 8,
    /// "toggle-hold / sticky hold"): press a driving key once and the endpoint
    /// stays held until it is pressed again. Keyed by the OUTPUT for the same
    /// reason turbo is — one row per endpoint is the only spelling the file
    /// format can produce — and composing with turbo the way §3a asks
    /// ("toggle-turbo… needs the sticky/latch vocabulary, not a second turbo
    /// mode"): a latched endpoint that also has a rate auto-fires while
    /// latched. Empty in every preset that predates toggle — the same
    /// regression guarantee again.
    pub toggle: Vec<Binding>,
    /// Built-ins ship in code, are never saved, and cannot be edited/deleted.
    pub protected: bool,
}

/// How many endpoints a preset can bind.
///
/// **Derived, never written down.** It is the sum of the four rosters, so an
/// endpoint added to [`XButton::ALL`], [`Trigger::ALL`], [`Axis::ALL`] or
/// [`DpadDirection::ALL`] changes this by existing — which is the entire point
/// of M11 (`docs/UNIVERSAL-IO.md` §3). Axes count twice: a stick axis is two
/// bindable functions, its negative and its positive extreme.
pub const MAPPABLE_COUNT: usize =
    XButton::ALL.len() + Trigger::ALL.len() + Axis::ALL.len() * 2 + DpadDirection::ALL.len();

/// Every function a preset can bind, in the canonical order.
///
/// [`Binding::Consume`] is the array's filler and is NOT a mappable function —
/// it drives no endpoint by definition. `the_vocabulary_has_no_filler_left`
/// fails if one ever survives initialisation.
const MAPPABLE: [Binding; MAPPABLE_COUNT] = {
    let mut out = [Binding::Consume; MAPPABLE_COUNT];
    let mut i = 0;
    let mut n = 0;
    while n < XButton::ALL.len() {
        out[i] = Binding::Button(XButton::ALL[n]);
        i += 1;
        n += 1;
    }
    n = 0;
    while n < Trigger::ALL.len() {
        out[i] = Binding::Trigger(Trigger::ALL[n]);
        i += 1;
        n += 1;
    }
    n = 0;
    while n < Axis::ALL.len() {
        out[i] = Binding::Axis {
            axis: Axis::ALL[n],
            value: AXIS_MIN,
        };
        out[i + 1] = Binding::Axis {
            axis: Axis::ALL[n],
            value: AXIS_MAX,
        };
        i += 2;
        n += 1;
    }
    n = 0;
    while n < DpadDirection::ALL.len() {
        out[i] = Binding::Dpad(DpadDirection::ALL[n]);
        i += 1;
        n += 1;
    }
    out
};

/// The ONE control vocabulary. Every count, every blank worksheet and every
/// "does the UI offer all of them" test derives from this, so adding a function
/// is a one-line change to a roster rather than an edit to a fixed-size array
/// in four crates (`docs/UNIVERSAL-IO.md` §3, M11 piece 1).
///
/// The order is [`Preset::builtin_empty`]'s historical construction order —
/// buttons, triggers, then per-axis negative-before-positive, then dpad. The
/// TOML that presets round-trip through is keyed by a `BTreeMap` and so is
/// alphabetical regardless; the order here is what keeps `entries` itself
/// unchanged for anything that reads it positionally.
pub const fn mappable_functions() -> &'static [Binding] {
    &MAPPABLE
}

impl Preset {
    pub const DEFAULT_NAME: &'static str = "default";
    pub const EMPTY_NAME: &'static str = "empty";

    /// Every key this preset reacts to, in any way.
    ///
    /// The set a capture backend suppresses when it is told to take only the
    /// bound keys of a device (`ksx_capture::Take::BoundKeys`) — so someone
    /// splitting one desk keyboard into two pads keeps typing with everything
    /// this does NOT return.
    ///
    /// "Reacts to" is deliberately broad, and each inclusion is a key that
    /// would otherwise leak into the focused window at the exact moment it is
    /// doing something in a game:
    ///
    /// - **entries** — the plain bindings.
    /// - **chord triggers, `when` AND `unless`** — all three are read while a
    ///   chord is live. A `when` key is held down for the whole chord; letting
    ///   it type would spray that character for as long as the player holds it.
    ///   An `unless` key is stranger but the same: it is *checked*, so pressing
    ///   it changes what the pad does, and a key that changes game behaviour
    ///   must not also type.
    /// - **macro triggers** — a macro key starts a timed sequence.
    /// - **turbo** is deliberately absent: turbo is keyed by the ENDPOINT it
    ///   auto-fires, not by a key, so it contributes no key of its own. The
    ///   key that drives a turbo'd endpoint is already an entry or a chord.
    ///
    /// [`Key::None`] is excluded throughout: it is the inert-placeholder
    /// spelling ("function present, unbound"), not a key anybody can press.
    /// Including it would suppress nothing but would make an all-placeholder
    /// preset look like it binds something.
    pub fn bound_keys(&self) -> impl Iterator<Item = Key> + '_ {
        let entries = self.entries.iter().map(|(key, _)| *key);
        let chords = self.chords.iter().flat_map(|chord| {
            std::iter::once(chord.key)
                .chain(chord.when.iter().copied())
                .chain(chord.unless.iter().copied())
        });
        let macros = self.macros.triggers.iter().map(|trigger| trigger.key);
        entries
            .chain(chords)
            .chain(macros)
            .filter(|key| *key != Key::None)
    }

    /// **How many bindings a key can actually reach** — the honest answer to
    /// "does this pad do anything".
    ///
    /// Counted from the three places a keypress can produce pad output, each
    /// filtered by the same rule [`Self::bound_keys`] uses: a [`Key::None`] row
    /// is the inert placeholder spelling ("function present, unbound"), not
    /// something anybody can press.
    ///
    /// This exists because `entries.len()` is the number that looks right and
    /// is wrong: [`Self::builtin_empty`] lists **every** control with a
    /// `Key::None` placeholder, so a preset that binds nothing has an entries
    /// vector as long as a fully mapped one. A screen counting entries reports
    /// a couple of dozen bindings for a pad that plugs and does nothing, which
    /// is `docs/FIRST-RUN.md` §6's "a screen reports success while nothing
    /// works" with a number attached.
    pub fn live_bindings(&self) -> usize {
        let entries = self.entries.iter().filter(|(key, _)| *key != Key::None);
        let chords = self.chords.iter().filter(|chord| chord.key != Key::None);
        let macros = self
            .macros
            .triggers
            .iter()
            .filter(|trigger| trigger.key != Key::None);
        entries.count() + chords.count() + macros.count()
    }

    /// **Nothing on this preset drives the pad.** Derived from
    /// [`Self::live_bindings`] rather than restated, so the two can never
    /// disagree about a placeholder.
    pub fn binds_nothing(&self) -> bool {
        self.live_bindings() == 0
    }

    /// The turbo row for `binding`, if it auto-fires.
    ///
    /// One row per endpoint by construction (the file is keyed by function), so
    /// this is a lookup rather than a fold; a file that somehow says it twice
    /// gets the first and a named issue from validation.
    pub fn turbo_for(&self, binding: Binding) -> Option<TurboBinding> {
        self.turbo.iter().copied().find(|t| t.binding == binding)
    }

    /// The authored rate for `binding`, if it auto-fires.
    pub fn turbo_hz(&self, binding: Binding) -> Option<u32> {
        self.turbo_for(binding).map(|t| t.hz)
    }

    /// Does `binding` latch (press once = held until pressed again)?
    ///
    /// One row per endpoint by construction, exactly like [`Self::turbo_for`];
    /// a file that somehow says it twice behaves as once and validation names
    /// the duplicate.
    pub fn toggled(&self, binding: Binding) -> bool {
        self.toggle.contains(&binding)
    }

    /// The protected KSX `default` preset: a modern one-keyboard layout.
    ///
    /// WASD moves, arrows aim, the numpad carries the D-pad, and the face/
    /// shoulder controls stay around the left hand. It is authored in KSX's
    /// native model and intentionally gives every endpoint one unambiguous key.
    pub fn builtin_default() -> Self {
        let entries = vec![
            (
                Key::W,
                Binding::Axis {
                    axis: Axis::Y,
                    value: AXIS_MAX,
                },
            ),
            (
                Key::S,
                Binding::Axis {
                    axis: Axis::Y,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::A,
                Binding::Axis {
                    axis: Axis::X,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::D,
                Binding::Axis {
                    axis: Axis::X,
                    value: AXIS_MAX,
                },
            ),
            (
                Key::Up,
                Binding::Axis {
                    axis: Axis::Ry,
                    value: AXIS_MAX,
                },
            ),
            (
                Key::Down,
                Binding::Axis {
                    axis: Axis::Ry,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::Left,
                Binding::Axis {
                    axis: Axis::Rx,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::Right,
                Binding::Axis {
                    axis: Axis::Rx,
                    value: AXIS_MAX,
                },
            ),
            (Key::Numpad8, Binding::Dpad(DpadDirection::Up)),
            (Key::Numpad2, Binding::Dpad(DpadDirection::Down)),
            (Key::Numpad4, Binding::Dpad(DpadDirection::Left)),
            (Key::Numpad6, Binding::Dpad(DpadDirection::Right)),
            (Key::Space, Binding::Button(XButton::A)),
            (Key::C, Binding::Button(XButton::B)),
            (Key::R, Binding::Button(XButton::X)),
            (Key::F, Binding::Button(XButton::Y)),
            (Key::Q, Binding::Button(XButton::LeftBumper)),
            (Key::E, Binding::Button(XButton::RightBumper)),
            (Key::Z, Binding::Trigger(Trigger::Left)),
            (Key::X, Binding::Trigger(Trigger::Right)),
            (Key::LeftShift, Binding::Button(XButton::LeftThumb)),
            (Key::V, Binding::Button(XButton::RightThumb)),
            (Key::Enter, Binding::Button(XButton::Start)),
            (Key::Backspace, Binding::Button(XButton::Back)),
            (Key::LeftWindows, Binding::Button(XButton::Guide)),
        ];

        Self {
            name: Self::DEFAULT_NAME.to_owned(),
            entries,
            chords: Vec::new(),
            macros: Default::default(),
            turbo: Vec::new(),
            toggle: Vec::new(),
            protected: true,
        }
    }

    /// The protected `empty` preset: every function present with `Key::None`
    /// and no custom functions. It is the native blank worksheet used by Setup
    /// and the mapper.
    pub fn builtin_empty() -> Self {
        let entries = mappable_functions()
            .iter()
            .map(|binding| (Key::None, *binding))
            .collect();

        Self {
            name: Self::EMPTY_NAME.to_owned(),
            entries,
            chords: Vec::new(),
            macros: Default::default(),
            turbo: Vec::new(),
            toggle: Vec::new(),
            protected: true,
        }
    }

    /// Both built-ins, `default` first.
    pub fn builtins() -> Vec<Self> {
        vec![Self::builtin_default(), Self::builtin_empty()]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys_for(preset: &Preset, binding: Binding) -> Vec<Key> {
        preset
            .entries
            .iter()
            .filter(|(_, b)| *b == binding)
            .map(|(k, _)| *k)
            .collect()
    }

    /// **A preset full of placeholders binds nothing, and the count says so.**
    ///
    /// Breaks against `entries.len()` as the answer, which is the number every
    /// caller reaches for first: `builtin_empty()` has a row for every control
    /// and not one key on it, so that version reports two dozen bindings for a
    /// pad on which nothing works. `ksx_api::StagedSlotView::bindings` shipped
    /// exactly that, and `StagedSetup::commit`'s no-bindings gate is built on
    /// this predicate.
    #[test]
    fn a_placeholder_only_preset_binds_nothing_however_long_its_entry_list_is() {
        let empty = Preset::builtin_empty();
        assert!(
            !empty.entries.is_empty(),
            "the point of this fixture is a long entry list"
        );
        assert!(empty.binds_nothing());
        assert_eq!(empty.live_bindings(), 0);

        assert_eq!(
            Preset::builtin_default().live_bindings(),
            MAPPABLE_COUNT,
            "the default preset binds every mappable function"
        );
        assert!(!Preset::builtin_default().binds_nothing());

        // One live row among the placeholders is enough, and it is counted
        // once — not once per placeholder beside it.
        let mut one = Preset::builtin_empty();
        one.entries.push((Key::G, Binding::Button(XButton::A)));
        assert_eq!(one.live_bindings(), 1);
        assert!(!one.binds_nothing());

        // A chord and a macro trigger are keys somebody can press, so they
        // count too — a preset whose only content is a chord is not dead.
        let chorded = Preset {
            name: "c".to_owned(),
            entries: Vec::new(),
            chords: vec![Chord {
                key: Key::G,
                binding: Binding::Button(XButton::B),
                when: vec![Key::LeftShift],
                unless: Vec::new(),
            }],
            macros: Default::default(),
            turbo: Vec::new(),
            toggle: Vec::new(),
            protected: false,
        };
        assert_eq!(chorded.live_bindings(), 1);
        assert!(!chorded.binds_nothing());
    }

    #[test]
    fn default_preset_is_the_native_keyboard_layout() {
        let p = Preset::builtin_default();
        assert_eq!(p.name, "default");
        assert!(p.protected);
        // One unambiguous key for every controller endpoint — the count is
        // derived from the rosters, so adding an endpoint moves it by itself.
        assert_eq!(p.entries.len(), MAPPABLE_COUNT);

        assert_eq!(
            keys_for(&p, Binding::Button(XButton::Start)),
            vec![Key::Enter]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::Back)),
            vec![Key::Backspace]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::LeftThumb)),
            vec![Key::LeftShift]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::RightThumb)),
            vec![Key::V]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::LeftBumper)),
            vec![Key::Q]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::RightBumper)),
            vec![Key::E]
        );
        assert_eq!(
            keys_for(&p, Binding::Button(XButton::Guide)),
            vec![Key::LeftWindows]
        );
        assert_eq!(keys_for(&p, Binding::Button(XButton::A)), vec![Key::Space]);
        assert_eq!(keys_for(&p, Binding::Button(XButton::B)), vec![Key::C]);
        assert_eq!(keys_for(&p, Binding::Button(XButton::X)), vec![Key::R]);
        assert_eq!(keys_for(&p, Binding::Button(XButton::Y)), vec![Key::F]);

        assert_eq!(keys_for(&p, Binding::Trigger(Trigger::Left)), vec![Key::Z]);
        assert_eq!(keys_for(&p, Binding::Trigger(Trigger::Right)), vec![Key::X]);

        let axis = |axis, value| Binding::Axis { axis, value };
        assert_eq!(keys_for(&p, axis(Axis::X, AXIS_MIN)), vec![Key::A]);
        assert_eq!(keys_for(&p, axis(Axis::X, AXIS_MAX)), vec![Key::D]);
        assert_eq!(keys_for(&p, axis(Axis::Y, AXIS_MIN)), vec![Key::S]);
        assert_eq!(keys_for(&p, axis(Axis::Y, AXIS_MAX)), vec![Key::W]);
        assert_eq!(keys_for(&p, axis(Axis::Rx, AXIS_MIN)), vec![Key::Left]);
        assert_eq!(keys_for(&p, axis(Axis::Rx, AXIS_MAX)), vec![Key::Right]);
        assert_eq!(keys_for(&p, axis(Axis::Ry, AXIS_MIN)), vec![Key::Down]);
        assert_eq!(keys_for(&p, axis(Axis::Ry, AXIS_MAX)), vec![Key::Up]);

        assert_eq!(
            keys_for(&p, Binding::Dpad(DpadDirection::Up)),
            vec![Key::Numpad8]
        );
        assert_eq!(
            keys_for(&p, Binding::Dpad(DpadDirection::Down)),
            vec![Key::Numpad2]
        );
        assert_eq!(
            keys_for(&p, Binding::Dpad(DpadDirection::Left)),
            vec![Key::Numpad4]
        );
        assert_eq!(
            keys_for(&p, Binding::Dpad(DpadDirection::Right)),
            vec![Key::Numpad6]
        );
    }

    #[test]
    fn empty_preset_is_the_native_blank_worksheet() {
        let p = Preset::builtin_empty();
        assert_eq!(p.name, "empty");
        assert!(p.protected);
        // One row per mappable function, derived rather than written down.
        assert_eq!(p.entries.len(), MAPPABLE_COUNT);
        assert!(p.entries.iter().all(|(k, _)| *k == Key::None));
        // Every function appears exactly once.
        let mut bindings: Vec<Binding> = p.entries.iter().map(|(_, b)| *b).collect();
        bindings.sort();
        bindings.dedup();
        assert_eq!(bindings.len(), MAPPABLE_COUNT);
        // ...and it is exactly the vocabulary, in its order.
        assert!(
            p.entries
                .iter()
                .map(|(_, b)| b)
                .eq(mappable_functions().iter()),
            "the blank worksheet IS the vocabulary, in order"
        );
    }

    #[test]
    fn the_vocabulary_has_no_filler_left() {
        // `MAPPABLE` is initialised with `Binding::Consume` as filler. A survivor
        // means `MAPPABLE_COUNT` and the initialiser have drifted apart — the
        // array would be silently short a function.
        assert!(
            !mappable_functions().contains(&Binding::Consume),
            "Consume drives no endpoint and is not a mappable function"
        );
        assert_eq!(mappable_functions().len(), MAPPABLE_COUNT);
    }

    #[test]
    fn the_vocabulary_counts_each_roster_once_and_axes_twice() {
        // Independent arithmetic: this must not simply restate MAPPABLE_COUNT.
        let buttons = mappable_functions()
            .iter()
            .filter(|b| matches!(b, Binding::Button(_)))
            .count();
        let triggers = mappable_functions()
            .iter()
            .filter(|b| matches!(b, Binding::Trigger(_)))
            .count();
        let axes = mappable_functions()
            .iter()
            .filter(|b| matches!(b, Binding::Axis { .. }))
            .count();
        let dpad = mappable_functions()
            .iter()
            .filter(|b| matches!(b, Binding::Dpad(_)))
            .count();

        assert_eq!(buttons, XButton::ALL.len());
        assert_eq!(triggers, Trigger::ALL.len());
        assert_eq!(axes, Axis::ALL.len() * 2, "each axis is two functions");
        assert_eq!(dpad, DpadDirection::ALL.len());
        assert_eq!(buttons + triggers + axes + dpad, mappable_functions().len());
    }

    #[test]
    fn a_chord_names_its_specificity_and_its_constituents() {
        let chord = Chord {
            key: Key::A,
            binding: Binding::Trigger(Trigger::Right),
            when: vec![Key::B],
            unless: vec![Key::LeftShift],
        };
        assert_eq!(chord.specificity(), 2);
        // The trigger and every `when` key are consumed; `unless` is not.
        assert_eq!(
            chord.constituents().collect::<Vec<_>>(),
            vec![Key::A, Key::B]
        );
        assert_eq!(
            chord.guard_keys().collect::<Vec<_>>(),
            vec![Key::B, Key::LeftShift]
        );
        // A+B+C is more specific than A+B, and wins where they overlap.
        let bigger = Chord::new(
            Key::A,
            Binding::Button(XButton::LeftBumper),
            vec![Key::B, Key::C],
        );
        assert!(
            bigger.specificity() > Chord::new(Key::A, chord.binding, vec![Key::B]).specificity()
        );
        assert!(bigger.unless.is_empty());
    }

    #[test]
    fn builtins_carry_no_chords() {
        // The regression guarantee: nothing that predates chords grows one.
        assert!(Preset::builtins().iter().all(|p| p.chords.is_empty()));
    }

    #[test]
    fn builtins_order_and_protection() {
        let builtins = Preset::builtins();
        assert_eq!(builtins.len(), 2);
        assert_eq!(builtins[0].name, Preset::DEFAULT_NAME);
        assert_eq!(builtins[1].name, Preset::EMPTY_NAME);
        assert!(builtins.iter().all(|p| p.protected));
    }

    /// `bound_keys` decides which keys a desk keyboard STOPS typing, so every
    /// key it misses is a key that types into the focused window while it is
    /// also driving a pad — and every key it adds needlessly is one the user
    /// loses for no reason.
    #[test]
    fn bound_keys_covers_entries_chords_and_macro_triggers() {
        use crate::macros::MacroTrigger;

        let mut preset = Preset::builtin_empty();
        preset.entries = vec![
            (Key::W, Binding::Button(XButton::A)),
            // The inert-placeholder spelling: a function present but unbound.
            // Nobody can press it.
            (Key::None, Binding::Button(XButton::B)),
        ];
        preset.chords = vec![Chord {
            key: Key::K,
            binding: Binding::Button(XButton::X),
            when: vec![Key::LeftShift],
            unless: vec![Key::LeftAlt],
        }];
        preset.macros.triggers = vec![MacroTrigger {
            key: Key::Numpad7,
            index: 0,
        }];

        let keys: Vec<Key> = preset.bound_keys().collect();

        assert!(keys.contains(&Key::W), "a plain binding");
        assert!(keys.contains(&Key::K), "a chord trigger");
        assert!(
            keys.contains(&Key::LeftShift),
            "a `when` key is HELD for the chord's whole life — letting it type \
             would spray that character the entire time"
        );
        assert!(
            keys.contains(&Key::LeftAlt),
            "an `unless` key is read, so pressing it changes what the pad does; \
             a key that changes game behaviour must not also type"
        );
        assert!(keys.contains(&Key::Numpad7), "a macro trigger");
        assert!(
            !keys.contains(&Key::None),
            "Key::None is the unbound placeholder, not a key anyone can press"
        );

        // And the keys a user keeps.
        for free in [Key::Enter, Key::Escape, Key::Q] {
            assert!(!keys.contains(&free), "{free:?} must still type");
        }
    }

    /// The builtin EMPTY preset is every function present and every key
    /// `Key::None`. It must bind nothing — so pointing `Take::BoundKeys` at a
    /// slot nobody has mapped yet cannot silently eat a keyboard.
    #[test]
    fn the_empty_preset_binds_no_keys_despite_having_every_row() {
        let empty = Preset::builtin_empty();
        assert!(!empty.entries.is_empty(), "it does have rows");
        assert_eq!(empty.bound_keys().count(), 0, "none of them is a key");
    }
}
