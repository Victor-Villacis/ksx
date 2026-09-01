//! Source-qualified fan-in: several physical keyboards may independently feed
//! one virtual-controller slot without collapsing equal key names or transform
//! state.

use ksx_core::{
    Axis, Binding, Chord, DeviceId, Engine, Interrupt, Key, KeyEvent, Macro, MacroStep,
    MacroTrigger, Macros, PadState, Preset, ResolvedSlot, SlotSpec, Socd, SourceSpec, TurboBinding,
    XButton, XButtons, AXIS_MAX, AXIS_MIN,
};

fn preset(name: &str, entries: Vec<(Key, Binding)>) -> Preset {
    Preset {
        name: name.to_owned(),
        entries,
        chords: Vec::new(),
        macros: Macros::default(),
        turbo: Vec::new(),
        toggle: Vec::new(),
        protected: false,
    }
}

fn event(device: &DeviceId, key: Key, down: bool) -> KeyEvent {
    KeyEvent {
        device: device.clone(),
        key,
        down,
        t: 0,
    }
}

fn engine_for(
    first_device: &DeviceId,
    first: Preset,
    second_device: &DeviceId,
    second: Preset,
) -> Engine {
    engine_for_with_socd(first_device, first, second_device, second, Socd::Off)
}

fn engine_for_with_socd(
    first_device: &DeviceId,
    first: Preset,
    second_device: &DeviceId,
    second: Preset,
    socd: Socd,
) -> Engine {
    let spec = SlotSpec::from_sources(
        1,
        vec![
            SourceSpec::keyboard(first_device.clone(), first.name.clone()),
            SourceSpec::keyboard(second_device.clone(), second.name.clone()),
        ],
        first.name.clone(),
    )
    .expect("valid slot")
    .with_socd(socd);
    Engine::new(vec![
        ResolvedSlot::new(spec, first).with_additional_presets(vec![second])
    ])
}

fn cross_source_strafe(socd: Socd) -> (DeviceId, DeviceId, Engine) {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let left = Binding::Axis {
        axis: Axis::X,
        value: AXIS_MIN,
    };
    let right = Binding::Axis {
        axis: Axis::X,
        value: AXIS_MAX,
    };
    let engine = engine_for_with_socd(
        &first,
        preset("first", vec![(Key::A, left)]),
        &second,
        preset("second", vec![(Key::D, right)]),
        socd,
    );
    (first, second, engine)
}

#[test]
fn two_keyboards_can_map_the_same_key_to_different_controls_on_one_slot() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let mut engine = engine_for(
        &first,
        preset("first", vec![(Key::Q, Binding::Button(XButton::A))]),
        &second,
        preset("second", vec![(Key::Q, Binding::Button(XButton::B))]),
    );

    engine.handle(&event(&first, Key::Q, true));
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    engine.handle(&event(&second, Key::Q, true));
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::A | XButtons::B
    );

    engine.handle(&event(&first, Key::Q, false));
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::B);
}

#[test]
fn shared_destination_stays_held_until_both_sources_release() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut engine = engine_for(
        &first,
        preset("first", vec![(Key::S, binding)]),
        &second,
        preset("second", vec![(Key::S, binding)]),
    );

    assert_eq!(engine.handle(&event(&first, Key::S, true)).len(), 1);
    assert!(engine.handle(&event(&second, Key::S, true)).is_empty());
    assert!(
        engine.handle(&event(&first, Key::S, false)).is_empty(),
        "releasing keyboard A must not clear keyboard B's holder"
    );
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    let released = engine.handle(&event(&second, Key::S, false));
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].state, PadState::default());
}

#[test]
fn a_chord_cannot_be_completed_by_a_different_keyboard() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let mut first_preset = preset("first", vec![(Key::A, Binding::Button(XButton::X))]);
    first_preset.chords.push(Chord::new(
        Key::A,
        Binding::Button(XButton::A),
        vec![Key::B],
    ));
    let second_preset = preset("second", vec![(Key::B, Binding::Button(XButton::Y))]);
    let mut engine = engine_for(&first, first_preset, &second, second_preset);

    engine.handle(&event(&first, Key::A, true));
    engine.handle(&event(&second, Key::B, true));
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::X | XButtons::Y,
        "keyboard B's B key must not satisfy keyboard A's A+B chord"
    );

    engine.handle(&event(&first, Key::B, true));
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::A | XButtons::Y,
        "the chord activates only when both constituents come from A"
    );
}

#[test]
fn any_input_macro_interrupt_is_scoped_to_its_source() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let mut sequence = Macro::new(
        "hold-a",
        vec![MacroStep::new(vec![Binding::Button(XButton::A)], 100)],
    );
    sequence.interrupt = Interrupt::AnyInput;
    let mut first_preset = preset("first", vec![(Key::Q, Binding::Button(XButton::X))]);
    first_preset.macros = Macros {
        defs: vec![sequence],
        triggers: vec![MacroTrigger::new(Key::P, 0)],
    };
    let second_preset = preset("second", vec![(Key::Q, Binding::Button(XButton::B))]);
    let mut engine = engine_for(&first, first_preset, &second, second_preset);

    engine.handle_at(&event(&first, Key::P, true), 0);
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    engine.handle_at(&event(&second, Key::Q, true), 1);
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::A | XButtons::B,
        "another keyboard must not interrupt this source's macro"
    );

    engine.handle_at(&event(&first, Key::Q, true), 2);
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::B | XButtons::X,
        "input on the owning keyboard still applies the interrupt policy"
    );
}

#[test]
fn releasing_one_device_clears_only_its_contribution() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut engine = engine_for(
        &first,
        preset("first", vec![(Key::S, binding)]),
        &second,
        preset("second", vec![(Key::S, binding)]),
    );

    engine.handle(&event(&first, Key::S, true));
    engine.handle(&event(&second, Key::S, true));
    assert!(engine.release_device(&first).is_empty());
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    let released = engine.release_device(&second);
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].state, PadState::default());
}

#[test]
fn source_indices_do_not_alias_after_255_distinct_devices() {
    let devices: Vec<DeviceId> = (0..257)
        .map(|index| DeviceId::new(format!("keyboard-{index}")))
        .collect();
    let mapping = preset("shared", vec![(Key::S, Binding::Button(XButton::A))]);
    let spec = SlotSpec::from_sources(
        1,
        devices
            .iter()
            .cloned()
            .map(|device| SourceSpec::keyboard(device, "shared"))
            .collect(),
        "shared",
    )
    .expect("valid slot");
    let mut engine = Engine::new(vec![ResolvedSlot::new(spec, mapping)]);

    engine.handle(&event(&devices[0], Key::S, true));
    engine.handle(&event(&devices[256], Key::S, true));
    assert!(engine
        .handle(&event(&devices[256], Key::S, false))
        .is_empty());
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    let released = engine.handle(&event(&devices[0], Key::S, false));
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].state, PadState::default());
}

#[test]
fn neutral_socd_cancels_opposites_across_keyboards() {
    let (first, second, mut engine) = cross_source_strafe(Socd::Neutral);
    engine.handle(&event(&first, Key::A, true));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MIN);

    engine.handle(&event(&second, Key::D, true));
    assert_eq!(engine.pad_state(1).unwrap().lx, 0);

    engine.handle(&event(&second, Key::D, false));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MIN);
}

#[test]
fn last_input_socd_chooses_the_newer_keyboard_and_hands_back() {
    let (first, second, mut engine) = cross_source_strafe(Socd::LastInput);
    engine.handle(&event(&first, Key::A, true));
    engine.handle(&event(&second, Key::D, true));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MAX);

    engine.handle(&event(&second, Key::D, false));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MIN);
}

#[test]
fn first_input_socd_keeps_the_incumbent_keyboard_until_release() {
    let (first, second, mut engine) = cross_source_strafe(Socd::FirstInput);
    engine.handle(&event(&first, Key::A, true));
    engine.handle(&event(&second, Key::D, true));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MIN);

    engine.handle(&event(&first, Key::A, false));
    assert_eq!(engine.pad_state(1).unwrap().lx, AXIS_MAX);
}

#[test]
fn up_priority_socd_keeps_cross_source_up() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let down = Binding::Axis {
        axis: Axis::Y,
        value: AXIS_MIN,
    };
    let up = Binding::Axis {
        axis: Axis::Y,
        value: AXIS_MAX,
    };
    let mut engine = engine_for_with_socd(
        &first,
        preset("first", vec![(Key::S, down)]),
        &second,
        preset("second", vec![(Key::W, up)]),
        Socd::UpPriority,
    );

    engine.handle(&event(&first, Key::S, true));
    engine.handle(&event(&second, Key::W, true));
    assert_eq!(engine.pad_state(1).unwrap().ly, AXIS_MAX);
}

#[test]
fn destination_turbo_applies_to_combined_sources_and_survives_other_device_yank() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut first_preset = preset("first", vec![(Key::G, binding)]);
    first_preset.turbo.push(TurboBinding::new(binding, 12));
    let turbo = first_preset.turbo[0];
    let mut engine = engine_for(
        &first,
        first_preset,
        &second,
        preset("second", vec![(Key::H, binding)]),
    );

    engine.handle_at(&event(&first, Key::G, true), 0);
    engine.handle_at(&event(&second, Key::H, true), 1);
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);
    assert!(
        engine.release_device(&first).is_empty(),
        "unplugging driving A must not stop B's shared destination clock"
    );
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    engine.tick(u64::from(turbo.on_ms()));
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::empty(),
        "B's ordinary binding must inherit the destination turbo policy"
    );
}

#[test]
fn destination_turbo_releases_when_its_last_driving_source_disappears() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut first_preset = preset("first", vec![(Key::G, binding)]);
    first_preset.turbo.push(TurboBinding::new(binding, 12));
    let mut engine = engine_for(
        &first,
        first_preset,
        &second,
        preset("second", vec![(Key::H, binding)]),
    );

    engine.handle_at(&event(&second, Key::H, true), 0);
    let released = engine.release_device(&second);
    assert_eq!(released.len(), 1);
    assert_eq!(engine.pad_state(1).unwrap(), PadState::default());
    assert_eq!(engine.next_deadline(), None);
}

#[test]
fn destination_toggle_is_one_flipper_for_combined_sources() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut first_preset = preset("first", vec![(Key::G, binding)]);
    first_preset.toggle.push(binding);
    let mut engine = engine_for(
        &first,
        first_preset,
        &second,
        preset("second", vec![(Key::H, binding)]),
    );

    engine.handle(&event(&second, Key::H, true));
    engine.handle(&event(&first, Key::G, true));
    engine.handle(&event(&second, Key::H, false));
    engine.handle(&event(&first, Key::G, false));
    assert_eq!(
        engine.pad_state(1).unwrap().buttons,
        XButtons::A,
        "B's ordinary binding must feed the destination latch declared by A"
    );
    assert!(
        engine.release_device(&first).is_empty(),
        "unplugging A must not clear latch state raised by B"
    );
    assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);

    let released = engine.release_device(&second);
    assert_eq!(
        released.len(),
        1,
        "the latch owner disappearing releases it"
    );
    assert_eq!(engine.pad_state(1).unwrap(), PadState::default());
}

#[test]
#[should_panic(expected = "conflicting turbo rates")]
fn conflicting_destination_turbo_rates_across_sources_are_not_silently_chosen() {
    let first = DeviceId::new("keyboard-a");
    let second = DeviceId::new("keyboard-b");
    let binding = Binding::Button(XButton::A);
    let mut first_preset = preset("first", vec![(Key::G, binding)]);
    first_preset.turbo.push(TurboBinding::new(binding, 8));
    let mut second_preset = preset("second", vec![(Key::H, binding)]);
    second_preset.turbo.push(TurboBinding::new(binding, 12));

    let _ = engine_for(&first, first_preset, &second, second_preset);
}
