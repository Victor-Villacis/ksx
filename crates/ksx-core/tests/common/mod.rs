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
