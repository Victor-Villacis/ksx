//! Deterministic native replay oracle.
//!
//! A synthetic keyboard panel feeds four slots with disjoint KSX-authored
//! layouts. The event script is generated in code, includes an unassigned desk
//! keyboard, and ends balanced. This keeps the wire-level drift detector and
//! multi-slot fan-out coverage without carrying a user's hardware recording or
//! imported profile files in the repository.

use std::collections::BTreeMap;

use ksx_core::{
    Axis, Binding, DeviceId, Engine, Key, KeyEvent, PadState, Preset, ResolvedSlot, SlotSpec,
    Trigger, XButton, AXIS_MAX, AXIS_MIN,
};

const PANEL: &str = r"HID\VID_1209&PID_4B53&MI_00\SYNTHETIC-PANEL";
const DESK: &str = r"HID\VID_1209&PID_4B54&MI_00\SYNTHETIC-DESK";

const PLAYER_KEYS: [[Key; 4]; 4] = [
    [Key::A, Key::S, Key::D, Key::F],
    [Key::J, Key::K, Key::L, Key::SemicolonColon],
    [Key::One, Key::Two, Key::Three, Key::Four],
    [Key::Numpad1, Key::Numpad2, Key::Numpad3, Key::Numpad4],
];

struct Event {
    device: DeviceId,
    key: Key,
    down: bool,
}

fn native_slots() -> Vec<ResolvedSlot> {
    let panel = DeviceId::from(PANEL);
    PLAYER_KEYS
        .iter()
        .enumerate()
        .map(|(index, keys)| {
            let direction = if index % 2 == 0 { AXIS_MAX } else { AXIS_MIN };
            let trigger = if index % 2 == 0 {
                Trigger::Left
            } else {
                Trigger::Right
            };
            let preset = Preset {
                name: format!("Synthetic Player {}", index + 1),
                entries: vec![
                    (keys[0], Binding::Button(XButton::A)),
                    (keys[1], Binding::Button(XButton::B)),
                    (
                        keys[2],
                        Binding::Axis {
                            axis: Axis::X,
                            value: direction,
                        },
                    ),
                    (keys[3], Binding::Trigger(trigger)),
                ],
                chords: Vec::new(),
                macros: Default::default(),
                turbo: Vec::new(),
                toggle: Vec::new(),
                protected: false,
            };
            ResolvedSlot::new(
                SlotSpec::new(
                    (index + 1) as u8,
                    Some(panel.clone()),
                    None,
                    preset.name.clone(),
                )
                .expect("valid synthetic slot"),
                preset,
            )
        })
        .collect()
}

fn fixture_events() -> Vec<Event> {
    let panel = DeviceId::from(PANEL);
    let desk = DeviceId::from(DESK);
    let desk_keys = [Key::Q, Key::W, Key::E, Key::R];
    let mut events = Vec::new();

    for round in 0..8 {
        for keys in PLAYER_KEYS {
            for key in keys {
                events.push(Event {
                    device: panel.clone(),
                    key,
                    down: true,
                });
                events.push(Event {
                    device: panel.clone(),
                    key,
                    down: false,
                });
            }
        }
        let key = desk_keys[round % desk_keys.len()];
        events.push(Event {
            device: desk.clone(),
            key,
            down: true,
        });
        events.push(Event {
            device: desk.clone(),
            key,
            down: false,
        });
    }
    events
}

/// FNV-1a over the exact XInput wire fields of the whole transition sequence.
/// `DefaultHasher` is deliberately avoided because it is not stable across
/// Rust releases.
fn digest(transitions: &[(u8, PadState)]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |byte: u8| {
        h ^= u64::from(byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for (slot, state) in transitions {
        eat(*slot);
        state
            .buttons
            .bits()
            .to_le_bytes()
            .iter()
            .copied()
            .for_each(&mut eat);
        eat(state.lt);
        eat(state.rt);
        for axis in [state.lx, state.ly, state.rx, state.ry] {
            axis.to_le_bytes().iter().copied().for_each(&mut eat);
        }
    }
    h
}

const SESSION_DIGEST: u64 = 16_610_086_525_548_893_573;
const SESSION_TRANSITIONS: usize = 256;

#[test]
fn native_script_replays_deterministically() {
    let events = fixture_events();
    assert!(events.len() > 250, "fixture should exercise a busy session");

    let mut engine = Engine::new(native_slots());
    let mut per_slot = [0usize; 5];
    let mut last = BTreeMap::<u8, PadState>::new();
    let mut sequence: Vec<(u8, PadState)> = Vec::new();

    for (i, event) in events.iter().enumerate() {
        for delta in engine.handle(&KeyEvent {
            device: event.device.clone(),
            key: event.key,
            down: event.down,
            t: i as u64,
        }) {
            assert_ne!(
                last.get(&delta.slot),
                Some(&delta.state),
                "slot {} re-emitted an identical state at event {i}",
                delta.slot
            );
            last.insert(delta.slot, delta.state);
            per_slot[delta.slot as usize] += 1;
            sequence.push((delta.slot, delta.state));
        }
    }

    for slot in 1..=4u8 {
        assert!(
            per_slot[slot as usize] > 0,
            "slot {slot} saw no transitions; fan-out is broken"
        );
    }
    assert_eq!(
        (sequence.len(), digest(&sequence)),
        (SESSION_TRANSITIONS, SESSION_DIGEST),
        "the native fixture no longer produces the same wire-level sequence"
    );

    let residual = engine.release_device(&DeviceId::from(PANEL));
    assert!(
        residual.is_empty(),
        "balanced input left residual deltas: {residual:?}"
    );
    for (slot, state) in &last {
        assert_eq!(
            *state,
            PadState::default(),
            "slot {slot} did not return to neutral"
        );
    }
}

#[test]
fn every_fixture_key_is_reachable_from_a_hid_usage() {
    use ksx_capture::hid::usage_to_scancode;
    use ksx_capture::keymap::{corrected_key, KEY_DOWN};

    let reachable: std::collections::BTreeSet<Key> = (0u8..=0xFF)
        .filter_map(usage_to_scancode)
        .map(|(code, prefix)| corrected_key(code, prefix | KEY_DOWN))
        .collect();
    let scripted: std::collections::BTreeSet<Key> =
        fixture_events().iter().map(|event| event.key).collect();

    let unreachable: Vec<&Key> = scripted.difference(&reachable).collect();
    assert!(
        unreachable.is_empty(),
        "fixture keys unreachable through WinUSB HID translation: {unreachable:?}"
    );
}
