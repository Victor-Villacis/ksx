//! Order-aware SOCD: last-input ("snap tap") and first-input priority
//! (docs/INPUT-TRANSFORMS.md §2.6).
//!
//! The static policies (off, neutral, up-priority) are generated chords and
//! are pinned as such in `ksx-core/src/socd.rs`; what this suite pins is the
//! ENGINE half the chords cannot express — which side was pressed more
//! recently — and that the two runtime modes disagree at exactly one moment:
//! the opposite press landing while the first side is still held.

mod common;

use common::{engine_with_socd, ev, ipac_device, preset, preset_with_chords, preset_with_toggle};
use ksx_core::{
    Axis, Binding, Chord, DpadDirection, Engine, Key, PadState, Socd, XButton, XButtons, AXIS_MAX,
    AXIS_MIN,
};

const LEFT: Binding = Binding::Axis {
    axis: Axis::X,
    value: AXIS_MIN,
};
const RIGHT: Binding = Binding::Axis {
    axis: Axis::X,
    value: AXIS_MAX,
};

fn engine_with_socd_of(entries: Vec<(Key, Binding)>, socd: Socd) -> Engine {
    engine_with_socd(preset("socd", entries), socd)
}

fn strafe(socd: Socd) -> Engine {
    engine_with_socd_of(vec![(Key::A, LEFT), (Key::D, RIGHT)], socd)
}

fn state(engine: &Engine) -> PadState {
    engine.pad_state(1).expect("slot 1")
}

fn press(engine: &mut Engine, key: Key, now: u64) {
    engine.handle_at(&ev(&ipac_device(), key, true), now);
}

fn release(engine: &mut Engine, key: Key, now: u64) {
    engine.handle_at(&ev(&ipac_device(), key, false), now);
}

/// Snap tap in one scenario: hold Left, tap Right — the newer press wins,
/// and letting it go hands the stick straight back to the still-held Left.
#[test]
fn last_input_follows_the_newer_press_and_hands_back() {
    let mut e = engine_with_socd_of(vec![(Key::A, LEFT), (Key::D, RIGHT)], Socd::LastInput);
    press(&mut e, Key::A, 0);
    assert_eq!(state(&e).lx, AXIS_MIN, "one direction alone is untouched");
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MAX, "the newer press wins immediately");
    release(&mut e, Key::D, 20);
    assert_eq!(state(&e).lx, AXIS_MIN, "release hands back to the held key");
    press(&mut e, Key::D, 30);
    assert_eq!(state(&e).lx, AXIS_MAX, "…and each new tap wins again");
    release(&mut e, Key::A, 40);
    assert_eq!(
        state(&e).lx,
        AXIS_MAX,
        "the loser releasing changes nothing"
    );
    release(&mut e, Key::D, 50);
    assert_eq!(state(&e).lx, 0, "all keys up: centre");
}

/// First-input is the same scenario with the opposite answer at the one
/// moment the modes differ: the opposite press WAITS while the first key
/// holds, and takes over the instant the first is released.
#[test]
fn first_input_holds_the_first_press_until_it_is_released() {
    let mut e = engine_with_socd_of(vec![(Key::A, LEFT), (Key::D, RIGHT)], Socd::FirstInput);
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MIN, "the first press holds");
    release(&mut e, Key::D, 20);
    press(&mut e, Key::D, 30);
    assert_eq!(state(&e).lx, AXIS_MIN, "re-pressing changes nothing either");
    release(&mut e, Key::A, 40);
    assert_eq!(state(&e).lx, AXIS_MAX, "…until the first is released");
    press(&mut e, Key::A, 50);
    assert_eq!(state(&e).lx, AXIS_MAX, "and now Right is the incumbent");
}

/// Autorepeat is not a press (§1c's edge rule, everywhere): a held key's
/// repeats must not re-win a last-input battle it has already lost.
#[test]
fn autorepeat_never_re_wins() {
    let mut e = strafe(Socd::LastInput);
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MAX);
    // Windows repeats the held A ~30×/s: down events, key already down.
    press(&mut e, Key::A, 33);
    press(&mut e, Key::A, 66);
    assert_eq!(
        state(&e).lx,
        AXIS_MAX,
        "repeats of the loser change nothing"
    );
    press(&mut e, Key::D, 99);
    assert_eq!(state(&e).lx, AXIS_MAX, "repeats of the winner neither");
}

/// Several keys on one direction are ONE side (multi-bind is one clock, one
/// flipper — and here one side): a second key on the already-driving side is
/// not a new press, so it does not re-win.
#[test]
fn multi_bind_is_one_side() {
    let mut e = engine_with_socd_of(
        vec![(Key::A, LEFT), (Key::S, LEFT), (Key::D, RIGHT)],
        Socd::LastInput,
    );
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MAX, "Right won");
    press(&mut e, Key::S, 20);
    assert_eq!(
        state(&e).lx,
        AXIS_MAX,
        "a second key on the LOSING side while it is held is not a new press"
    );
    release(&mut e, Key::D, 30);
    assert_eq!(
        state(&e).lx,
        AXIS_MIN,
        "…but the side is still held: resume"
    );
    release(&mut e, Key::A, 40);
    assert_eq!(
        state(&e).lx,
        AXIS_MIN,
        "one of two keys up: side still held"
    );
    press(&mut e, Key::D, 50);
    assert_eq!(state(&e).lx, AXIS_MAX, "the side rising again wins again");
}

/// The dpad is covered by the same rule — vertical too, with no up bias:
/// unlike up-priority, the order decides, whichever direction is newer.
#[test]
fn the_dpad_and_the_vertical_axis_follow_order_not_up() {
    let mut e = engine_with_socd_of(
        vec![
            (Key::I, Binding::Dpad(DpadDirection::Up)),
            (Key::K, Binding::Dpad(DpadDirection::Down)),
        ],
        Socd::LastInput,
    );
    press(&mut e, Key::I, 0);
    press(&mut e, Key::K, 10);
    assert!(
        state(&e).buttons.contains(XButtons::DPAD_DOWN)
            && !state(&e).buttons.contains(XButtons::DPAD_UP),
        "DOWN is newer, so DOWN wins — order-aware, not up-priority"
    );
    release(&mut e, Key::K, 20);
    assert!(
        state(&e).buttons.contains(XButtons::DPAD_UP),
        "release hands back to UP"
    );
}

/// A hand-written chord over the pair outranks the policy at runtime, the
/// same way it shadows generation for the static modes: while the chord has
/// both keys consumed, neither side is "driving" and the chord's own output
/// is what the game sees.
#[test]
fn a_user_chord_over_the_pair_wins() {
    let mut e = engine_with_socd(
        preset_with_chords(
            "chorded",
            vec![(Key::A, LEFT), (Key::D, RIGHT)],
            vec![Chord::new(
                Key::A,
                Binding::Button(XButton::Y),
                vec![Key::D],
            )],
        ),
        Socd::LastInput,
    );
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    let s = state(&e);
    assert!(s.buttons.contains(XButtons::Y), "the chord drives");
    assert_eq!(
        s.lx, 0,
        "…and both direction keys are the chord's, not SOCD's"
    );
    release(&mut e, Key::D, 20);
    let s = state(&e);
    assert!(!s.buttons.contains(XButtons::Y));
    assert_eq!(s.lx, AXIS_MIN, "the surviving key resumes its own binding");
}

/// A key bound to BOTH halves of one control belongs to neither side: it
/// opposes itself, and there is no honest "newer press" for a key that says
/// both at once — it keeps its raw behavior instead of being half-suppressed.
#[test]
fn a_self_opposing_key_is_left_alone() {
    let mut e = engine_with_socd_of(
        vec![
            (Key::A, LEFT),
            (Key::D, RIGHT),
            (Key::X, LEFT),
            (Key::X, RIGHT),
        ],
        Socd::LastInput,
    );
    // The A/D pair still cleans...
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MAX);
    release(&mut e, Key::A, 20);
    release(&mut e, Key::D, 30);
    // ...while X, which drives both, is untouched by the policy: last entry
    // wins within the key itself, exactly as with no SOCD at all.
    press(&mut e, Key::X, 40);
    assert_eq!(state(&e).lx, AXIS_MAX, "raw behavior for the ambiguous key");
}

/// A release with BOTH sides still held keeps the winner; the hand-back only
/// happens when the winning side actually goes silent. (Two keys per side.)
#[test]
fn first_input_with_multi_bound_sides() {
    let mut e = engine_with_socd_of(
        vec![(Key::A, LEFT), (Key::S, LEFT), (Key::D, RIGHT)],
        Socd::FirstInput,
    );
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MIN, "Left was first");
    release(&mut e, Key::A, 20);
    assert_eq!(
        state(&e).lx,
        AXIS_MAX,
        "Left's side went silent: Right takes over"
    );
    press(&mut e, Key::S, 30);
    assert_eq!(
        state(&e).lx,
        AXIS_MAX,
        "…and is now the incumbent Left must wait on"
    );
}

/// Every exit leaves no stale order memory: after a reset the next battle is
/// decided fresh, and a swap starts from silence.
#[test]
fn resets_clear_the_order_memory() {
    let mut e = strafe(Socd::LastInput);
    press(&mut e, Key::A, 0);
    press(&mut e, Key::D, 10);
    assert_eq!(state(&e).lx, AXIS_MAX);
    e.reset();
    assert_eq!(state(&e), PadState::default());
    press(&mut e, Key::A, 20);
    assert_eq!(state(&e).lx, AXIS_MIN, "fresh: one key alone just drives");
    press(&mut e, Key::D, 30);
    assert_eq!(state(&e).lx, AXIS_MAX, "and order is honored from scratch");
}

/// The composition with a latch: the latch's SOURCE key is subject to SOCD
/// suppression like any bound key (a suppressed source cannot flip — the same
/// consumed-source rule chords pin in `engine_toggle.rs`), while the latched
/// OUTPUT is the latch's business, not the cleaner's.
#[test]
fn a_suppressed_key_cannot_flip_a_latch() {
    let mut e = engine_with_socd(
        preset_with_toggle(
            "latched",
            vec![(Key::A, LEFT), (Key::D, RIGHT)],
            Vec::new(),
            Vec::new(),
            vec![RIGHT],
        ),
        Socd::LastInput,
    );
    // D latches Right on.
    press(&mut e, Key::D, 0);
    release(&mut e, Key::D, 5);
    assert_eq!(state(&e).lx, AXIS_MAX, "latched hands-free");
    // A alone drives Left — the latch holder is not a key, so the cleaner
    // has nothing to suppress on the Right side; the axis field itself is
    // single-valued and A's press simply writes it.
    press(&mut e, Key::A, 10);
    assert_eq!(
        state(&e).lx,
        AXIS_MIN,
        "a real press outranks a latch's value"
    );
    release(&mut e, Key::A, 20);
    assert_eq!(state(&e).lx, AXIS_MAX, "the latch still holds when A lifts");
    // Unlatch to leave nothing held.
    press(&mut e, Key::D, 30);
    assert_eq!(state(&e).lx, 0);
}

/// The static three are BEHAVIORALLY unchanged by the feature existing: an
/// off slot reports both, exactly as the keys say.
#[test]
fn off_still_reports_both() {
    let mut e = engine_with_socd_of(
        vec![
            (Key::I, Binding::Dpad(DpadDirection::Up)),
            (Key::K, Binding::Dpad(DpadDirection::Down)),
        ],
        Socd::Off,
    );
    press(&mut e, Key::I, 0);
    press(&mut e, Key::K, 10);
    let b = state(&e).buttons;
    assert!(b.contains(XButtons::DPAD_UP) && b.contains(XButtons::DPAD_DOWN));
}
