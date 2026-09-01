//! Shared engine-test fixtures.
//!
//! The four layouts below are intentionally synthetic and authored directly in
//! KSX's native model. One invented keyboard feeds four slots with disjoint key
//! sets, preserving the product's central fan-out coverage without embedding a
//! user's profile or hardware instance path.
#![allow(dead_code)]

use ksx_core::{
    Axis, Binding, DeviceId, Engine, Key, KeyEvent, Preset, ResolvedSlot, SlotSpec, Trigger,
    XButton, AXIS_MAX, AXIS_MIN,
};

pub const IPAC: &str = r"HID\VID_1209&PID_4B53&MI_00\SYNTHETIC-PANEL";

pub fn ipac_device() -> DeviceId {
    DeviceId::new(IPAC)
}

pub fn ev(dev: &DeviceId, key: Key, down: bool) -> KeyEvent {
    KeyEvent {
        device: dev.clone(),
        key,
        down,
        t: 0,
    }
}

pub fn preset(name: &str, entries: Vec<(Key, Binding)>) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords: Vec::new(),
        macros: Default::default(),
        turbo: Vec::new(),
        toggle: Vec::new(),
        protected: false,
    }
}

pub fn preset_with_chords(
    name: &str,
    entries: Vec<(Key, Binding)>,
    chords: Vec<ksx_core::Chord>,
) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords,
        macros: Default::default(),
        turbo: Vec::new(),
        toggle: Vec::new(),
        protected: false,
    }
}

pub fn preset_with_macros(
    name: &str,
    entries: Vec<(Key, Binding)>,
    macros: ksx_core::Macros,
) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords: Vec::new(),
        macros,
        turbo: Vec::new(),
        toggle: Vec::new(),
        protected: false,
    }
}

pub fn preset_with_turbo(
    name: &str,
    entries: Vec<(Key, Binding)>,
    chords: Vec<ksx_core::Chord>,
    turbo: Vec<ksx_core::TurboBinding>,
) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords,
        macros: Default::default(),
        turbo,
        toggle: Vec::new(),
        protected: false,
    }
}

pub fn preset_with_toggle(
    name: &str,
    entries: Vec<(Key, Binding)>,
    chords: Vec<ksx_core::Chord>,
    turbo: Vec<ksx_core::TurboBinding>,
    toggle: Vec<Binding>,
) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords,
        macros: Default::default(),
        turbo,
        toggle,
        protected: false,
    }
}

pub fn engine_for(preset: Preset) -> Engine {
    let dev = ipac_device();
    Engine::new(vec![ResolvedSlot {
        spec: SlotSpec::new(1, Some(dev), None, preset.name.clone()).expect("valid slot"),
        preset,
        additional_presets: Vec::new(),
    }])
}

/// An engine whose one slot carries an SOCD policy — the runtime modes read
/// it from the spec; the static modes are expected to be applied to the
/// preset by the caller (`apply_socd`), exactly as `plan.rs` does.
pub fn engine_with_socd(preset: Preset, socd: ksx_core::Socd) -> Engine {
    let dev = ipac_device();
    Engine::new(vec![ResolvedSlot {
        spec: SlotSpec::new(1, Some(dev), None, preset.name.clone())
            .expect("valid slot")
            .with_socd(socd),
        preset,
        additional_presets: Vec::new(),
    }])
}

fn axis(axis: Axis, value: i16) -> Binding {
    Binding::Axis { axis, value }
}

fn player(name: &str, keys: [Key; 8]) -> Preset {
    preset(
        name,
        vec![
            (keys[0], Binding::Button(XButton::A)),
            (keys[1], Binding::Button(XButton::B)),
            (keys[2], Binding::Button(XButton::X)),
            (keys[3], Binding::Button(XButton::Y)),
            (keys[4], Binding::Trigger(Trigger::Left)),
            (keys[5], Binding::Trigger(Trigger::Right)),
            (keys[6], axis(Axis::X, AXIS_MIN)),
            (keys[7], axis(Axis::X, AXIS_MAX)),
        ],
    )
}

pub fn panel_p1() -> Preset {
    player(
        "Synthetic Player 1",
        [
            Key::A,
            Key::B,
            Key::C,
            Key::D,
            Key::E,
            Key::F,
            Key::G,
            Key::H,
        ],
    )
}

pub fn panel_p2() -> Preset {
    player(
        "Synthetic Player 2",
        [
            Key::J,
            Key::K,
            Key::L,
            Key::SemicolonColon,
            Key::O,
            Key::P,
            Key::U,
            Key::I,
        ],
    )
}

pub fn panel_p3() -> Preset {
    player(
        "Synthetic Player 3",
        [
            Key::One,
            Key::Two,
            Key::Three,
            Key::Four,
            Key::Five,
            Key::Six,
            Key::Seven,
            Key::Eight,
        ],
    )
}

pub fn panel_p4() -> Preset {
    player(
        "Synthetic Player 4",
        [
            Key::Numpad1,
            Key::Numpad2,
            Key::Numpad3,
            Key::Numpad4,
            Key::Numpad5,
            Key::Numpad6,
            Key::Numpad7,
            Key::Numpad8,
        ],
    )
}

pub fn ipac_engine() -> Engine {
    let dev = ipac_device();
    let presets = [panel_p1(), panel_p2(), panel_p3(), panel_p4()];
    let slots = presets
        .into_iter()
        .enumerate()
        .map(|(i, preset)| ResolvedSlot {
            spec: SlotSpec::new((i + 1) as u8, Some(dev.clone()), None, preset.name.clone())
                .expect("valid slot number"),
            preset,
            additional_presets: Vec::new(),
        })
        .collect();
    Engine::new(slots)
}

pub fn ipac_bound_keys() -> Vec<Key> {
    [panel_p1(), panel_p2(), panel_p3(), panel_p4()]
        .iter()
        .flat_map(|preset| preset.entries.iter().map(|(key, _)| *key))
        .collect()
}

// ---------------------------------------------------------------------------
// The full-house fixture: SIXTEEN slots on one board
// ---------------------------------------------------------------------------
//
// Added 2026-08-26. Until then nothing in the workspace built an engine with
// more than FOUR slots, and 16 is ksx's own ceiling (`ksx_core::MAX_SLOTS`) —
// the exact size `Deltas`, `KeyTargets`, `SyncSlots` and `swap_tables`'
// `previous` are inlined for. Every capacity claim about those buffers rested
// on arithmetic no test ever reached, so the one case where "sized for 16"
// either holds or spills to the heap was the one case never exercised.

/// ksx's own slot ceiling. Mirrors [`ksx_core::MAX_SLOTS`]; asserted equal in
/// `engine_full_house.rs` so this fixture cannot drift away from the real one.
pub const FULL_HOUSE: usize = 16;

/// The key EVERY slot binds. One press fans out to all sixteen — the widest
/// delta batch the engine can ever produce from a single event.
pub const FANOUT_KEY: Key = Key::Space;

/// Four private keys per slot, so per-slot state can be told apart.
///
/// Drawn from [`Key::ALL`] in declaration order rather than hand-listed: 64
/// distinct spellings is past the point where a literal list is easier to
/// trust than to read. Mouse pseudo-keys and the two sentinels are skipped.
pub fn full_house_private_keys() -> Vec<[Key; 4]> {
    let pool: Vec<Key> = Key::ALL
        .iter()
        .copied()
        .filter(|k| {
            *k != Key::None && *k != Key::Unknown && *k != FANOUT_KEY && !k.is_mouse_pseudo()
        })
        .take(FULL_HOUSE * 4)
        .collect();
    assert_eq!(
        pool.len(),
        FULL_HOUSE * 4,
        "the key vocabulary no longer has 64 ordinary keys to hand out",
    );
    pool.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
}

fn full_house_entries(private: [Key; 4]) -> Vec<(Key, Binding)> {
    vec![
        (FANOUT_KEY, Binding::Button(XButton::A)),
        (private[0], Binding::Button(XButton::B)),
        (private[1], Binding::Button(XButton::X)),
        (private[2], Binding::Trigger(Trigger::Left)),
        (private[3], axis(Axis::X, AXIS_MAX)),
    ]
}

/// Sixteen plain slots on one device, every one of them bound to
/// [`FANOUT_KEY`].
pub fn full_house_presets() -> Vec<Preset> {
    full_house_private_keys()
        .into_iter()
        .enumerate()
        .map(|(i, private)| {
            preset(
                &format!("Full House {}", i + 1),
                full_house_entries(private),
            )
        })
        .collect()
}

/// The same sixteen slots, each also carrying a macro, a turbo binding, a
/// toggle and a chord.
///
/// This is the shape the allocation guards never had: `common::preset()` leaves
/// `macros`, `turbo` and `toggle` empty, so `has_macros`/`has_turbo` are false
/// and `Engine::tick` returns on its first line. The whole scheduler —
/// `Timers::armed`, `slot.macro_dirty`, `slot.scan` — went unmeasured.
pub fn full_house_scheduler_presets() -> Vec<Preset> {
    full_house_private_keys()
        .into_iter()
        .enumerate()
        .map(|(i, private)| {
            let a = Binding::Button(XButton::A);
            let b = Binding::Button(XButton::B);
            Preset {
                name: format!("Full House {}", i + 1),
                entries: full_house_entries(private),
                // A two-key chord on this slot's own keys.
                chords: vec![ksx_core::Chord::new(
                    private[0],
                    Binding::Trigger(Trigger::Right),
                    vec![private[1]],
                )],
                macros: ksx_core::Macros {
                    defs: vec![ksx_core::Macro::new(
                        "fan",
                        vec![
                            ksx_core::MacroStep::new(vec![b], 50),
                            ksx_core::MacroStep::new(vec![a, b], 50),
                            ksx_core::MacroStep::new(vec![a], 50),
                        ],
                    )],
                    triggers: vec![ksx_core::MacroTrigger::new(private[2], 0)],
                },
                turbo: vec![ksx_core::TurboBinding::new(a, 12)],
                toggle: vec![b],
                protected: false,
            }
        })
        .collect()
}

pub fn full_house_slots(presets: Vec<Preset>) -> Vec<ResolvedSlot> {
    let dev = ipac_device();
    presets
        .into_iter()
        .enumerate()
        .map(|(i, preset)| ResolvedSlot {
            spec: SlotSpec::new((i + 1) as u8, Some(dev.clone()), None, preset.name.clone())
                .expect("valid slot number"),
            preset,
            additional_presets: Vec::new(),
        })
        .collect()
}

/// Sixteen plain slots, ready to drive.
pub fn full_house_engine() -> Engine {
    Engine::new(full_house_slots(full_house_presets()))
}

/// Sixteen slots carrying every timed transform at once.
pub fn full_house_scheduler_engine() -> Engine {
    Engine::new(full_house_slots(full_house_scheduler_presets()))
}

/// Every key bound anywhere in the sixteen slots, [`FANOUT_KEY`] included once.
pub fn full_house_bound_keys() -> Vec<Key> {
    let mut keys = vec![FANOUT_KEY];
    for private in full_house_private_keys() {
        keys.extend_from_slice(&private);
    }
    keys
}
