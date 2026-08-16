//! Toggle-hold: press a driving key once and the endpoint stays held until it
//! is pressed again (docs/INPUT-TRANSFORMS.md §2 catalog item 8).
//!
//! The latch DELIBERATELY survives all-keys-up — that is the feature: press
//! once, walk away, the button stays down. Every exit path still releases it
//! (the escape door, a device yank, a hot swap, reset), because a latched
//! button on a pad the player has left is the stuck-input failure this
//! project refuses to ship — and each exit is pinned below.

mod common;

use common::{ev, ipac_device, preset_with_toggle};
use ksx_core::{
    Binding, Chord, Engine, EngineTables, Key, PadState, ResolvedSlot, SlotSpec, TurboBinding,
    XButton, XButtons,
};

const A: Binding = Binding::Button(XButton::A);
const RT: Binding = Binding::Trigger(ksx_core::Trigger::Right);
const LX_MIN: Binding = Binding::Axis {
    axis: ksx_core::Axis::X,
    value: ksx_core::AXIS_MIN,
};

fn engine_for(p: ksx_core::Preset) -> Engine {
    let dev = ipac_device();
    Engine::new(vec![ResolvedSlot {
        spec: SlotSpec::new(1, Some(dev), None, p.name.clone()).expect("valid slot"),
        preset: p,
    }])
}

/// `A = { key = "G", toggle = true }` — the whole feature in one row.
fn engine_toggle_a() -> Engine {
    engine_for(preset_with_toggle(
        "toggle",
        vec![(Key::G, A)],
        Vec::new(),
        Vec::new(),
        vec![A],
    ))
}

fn state(engine: &Engine) -> PadState {
    engine.pad_state(1).expect("slot 1")
}

fn a_down(engine: &Engine) -> bool {
    state(engine).buttons.contains(XButtons::A)
}

fn press(engine: &mut Engine, key: Key, now: u64) {
    engine.handle_at(&ev(&ipac_device(), key, true), now);
}

fn release(engine: &mut Engine, key: Key, now: u64) {
    engine.handle_at(&ev(&ipac_device(), key, false), now);
}

/// The feature in one sentence: the key RELEASE changes nothing, and the
/// second PRESS is what lets go.
#[test]
fn press_once_holds_press_again_releases() {
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    assert!(a_down(&e), "the first press latches");
    release(&mut e, Key::G, 10);
    assert!(
        a_down(&e),
        "releasing the key is the whole point: A stays held"
    );
    press(&mut e, Key::G, 20);
    assert!(!a_down(&e), "the second press unlatches");
    release(&mut e, Key::G, 30);
    assert!(!a_down(&e), "…and its release changes nothing either");
}

/// Windows repeats a held key ~30×/s as key-down events for a key that is
/// already down. A latch that flipped on every repeat would strobe — the same
/// cabinet bug the macro edge-guard fixed, so the same rule applies.
#[test]
fn autorepeat_does_not_flip_the_latch() {
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    assert!(a_down(&e));
    // Autorepeats: down events with the key already down. No edge, no flip.
    press(&mut e, Key::G, 33);
    press(&mut e, Key::G, 66);
    press(&mut e, Key::G, 99);
    assert!(a_down(&e), "repeats must not flip the latch");
    release(&mut e, Key::G, 120);
    press(&mut e, Key::G, 150);
    assert!(!a_down(&e), "the next real press still unlatches");
}

/// Several keys on one latched endpoint form ONE flipper, exactly as several
/// keys on one turbo form one clock: the latch flips when the GROUP goes from
/// silent to driving, so pressing the second key while the first is held is
/// not a second flip.
#[test]
fn two_keys_are_one_flipper() {
    let mut e = engine_for(preset_with_toggle(
        "toggle",
        vec![(Key::G, A), (Key::H, A)],
        Vec::new(),
        Vec::new(),
        vec![A],
    ));
    press(&mut e, Key::G, 0);
    assert!(a_down(&e), "either key latches");
    press(&mut e, Key::H, 10);
    assert!(
        a_down(&e),
        "a second key while the first is held is not a flip"
    );
    release(&mut e, Key::G, 20);
    release(&mut e, Key::H, 30);
    assert!(a_down(&e), "all keys up: still latched");
    press(&mut e, Key::H, 40);
    assert!(!a_down(&e), "the other key unlatches just the same");
}

/// A chord can be the flipper: the latch flips when the chord ACTIVATES.
/// While the chord holds the trigger consumed, the trigger's own entries stay
/// suppressed exactly as for any chord.
#[test]
fn a_chord_activation_flips_the_latch() {
    let mut e = engine_for(preset_with_toggle(
        "toggle",
        vec![(Key::G, A)],
        vec![Chord::new(Key::T, RT, vec![Key::B])],
        Vec::new(),
        vec![RT],
    ));
    press(&mut e, Key::B, 0);
    assert_eq!(state(&e).rt, 0, "the guard alone drives nothing");
    press(&mut e, Key::T, 10);
    assert_eq!(state(&e).rt, u8::MAX, "chord activation latches RT");
    release(&mut e, Key::T, 20);
    release(&mut e, Key::B, 30);
    assert_eq!(state(&e).rt, u8::MAX, "chord released: RT stays latched");
    press(&mut e, Key::B, 40);
    press(&mut e, Key::T, 50);
    assert_eq!(state(&e).rt, 0, "the second activation unlatches");
}

/// §3b's toggle-turbo, out of the wiring rather than a second turbo mode:
/// a latched endpoint with a rate auto-fires while latched — with the key
/// RELEASED — and stops the instant the latch is flipped off.
#[test]
fn a_latched_turbo_auto_fires_hands_free() {
    let mut e = engine_for(preset_with_toggle(
        "toggle-turbo",
        vec![(Key::G, A)],
        Vec::new(),
        vec![TurboBinding::new(A, 12)],
        vec![A],
    ));
    press(&mut e, Key::G, 0);
    assert!(a_down(&e), "latched: the first turbo press is immediate");
    release(&mut e, Key::G, 5);
    assert!(
        a_down(&e),
        "the key is up; the latch keeps the clock running"
    );
    e.tick(42);
    assert!(!a_down(&e), "released half of the cycle, hands-free");
    e.tick(83);
    assert!(
        a_down(&e),
        "pressed half again — auto-firing with no key held"
    );
    press(&mut e, Key::G, 100);
    assert!(
        !a_down(&e),
        "unlatching stops the clock and releases at once"
    );
    e.tick(200);
    assert!(!a_down(&e), "…and it stays stopped");
    assert_eq!(e.next_deadline(), None, "no timer left armed");
}

/// A latch on an axis is a held direction — auto-run. It keeps the axis
/// deflected with every key up, and unlatching returns it to centre.
#[test]
fn a_latched_axis_holds_its_direction() {
    let mut e = engine_for(preset_with_toggle(
        "auto-run",
        vec![(Key::Left, LX_MIN)],
        Vec::new(),
        Vec::new(),
        vec![LX_MIN],
    ));
    press(&mut e, Key::Left, 0);
    release(&mut e, Key::Left, 10);
    assert_eq!(
        state(&e).lx,
        ksx_core::AXIS_MIN,
        "direction held hands-free"
    );
    press(&mut e, Key::Left, 20);
    assert_eq!(state(&e).lx, 0, "unlatching centres the axis");
}

/// Every exit releases the latch. Four doors, one guarantee — a latched
/// button on a pad the player has left is exactly the stuck-input failure
/// the exits exist to prevent.
#[test]
fn every_exit_releases_the_latch() {
    // The escape door (session stop, escape gesture): cancel_macros.
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    release(&mut e, Key::G, 5);
    assert!(a_down(&e));
    let deltas = e.cancel_macros();
    assert!(!a_down(&e), "the escape door unlatches");
    assert!(
        deltas.iter().any(|d| d.slot == 1),
        "…and the release is PUBLISHED, not just recorded"
    );

    // Device yank: release_device.
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    release(&mut e, Key::G, 5);
    let deltas = e.release_device(&ipac_device());
    assert!(!a_down(&e), "a yanked device leaves no latched output");
    assert!(deltas.iter().any(|d| d.slot == 1));

    // Hot swap: fresh tables start unlatched, and the neutral deltas release.
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    release(&mut e, Key::G, 5);
    let dev = ipac_device();
    let tables = EngineTables::build(vec![ResolvedSlot {
        spec: SlotSpec::new(1, Some(dev), None, "toggle").expect("valid slot"),
        preset: preset_with_toggle("toggle", vec![(Key::G, A)], Vec::new(), Vec::new(), vec![A]),
    }]);
    let deltas = e.swap_tables(tables);
    assert!(!a_down(&e), "a swap releases what the latch held");
    assert!(deltas.iter().any(|d| d.slot == 1));

    // Reset: back to neutral, latch state included.
    let mut e = engine_toggle_a();
    press(&mut e, Key::G, 0);
    release(&mut e, Key::G, 5);
    e.reset();
    assert_eq!(state(&e), PadState::default());
    press(&mut e, Key::G, 10);
    assert!(a_down(&e), "after a reset the first press latches again");
}

/// A key the active chord CONSUMES cannot flip a latch — consumption means
/// suppressed, for a latch source exactly as for a plain binding. When the
/// chord hands the key back while it is still physically held, that hand-back
/// is a rising edge and flips the latch: the same resume-on-release rule
/// chords apply to ordinary bindings, pinned here so it cannot drift by
/// accident.
#[test]
fn a_consumed_source_cannot_flip_and_the_hand_back_is_an_edge() {
    let mut e = engine_for(preset_with_toggle(
        "toggle",
        vec![(Key::G, A)],
        vec![Chord::new(Key::T, RT, vec![Key::G])],
        Vec::new(),
        vec![A],
    ));
    // G alone: latch on (G is a chord constituent but the chord is inactive).
    press(&mut e, Key::G, 0);
    assert!(a_down(&e));
    // T completes the chord: G is consumed, the latch's source falls silent —
    // falling edges never flip, so A stays latched while RT drives.
    press(&mut e, Key::T, 10);
    assert!(a_down(&e), "a falling source never flips");
    assert_eq!(state(&e).rt, u8::MAX);
    // Chord releases: G (still held) is handed back — a rising edge, and the
    // latch flips off, exactly as a plain binding would resume pressing.
    release(&mut e, Key::T, 20);
    assert!(!a_down(&e), "the hand-back is an edge and flips the latch");
    assert_eq!(state(&e).rt, 0);
}
