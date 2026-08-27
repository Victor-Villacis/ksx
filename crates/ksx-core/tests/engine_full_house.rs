//! The full house: SIXTEEN slots on one board.
//!
//! # Why this file exists (2026-08-26 audit)
//!
//! Nothing in the workspace built an engine with more than FOUR slots. Sixteen
//! is ksx's own ceiling ([`MAX_SLOTS`]) and the exact size `Deltas`,
//! `KeyTargets` and `SyncSlots` are inlined for, so the one configuration where
//! "sized for 16" either holds or spills to the heap was the one configuration
//! never built.
//!
//! That is not hypothetical. `engine.rs`'s own comment above `Deltas` records
//! the defect: *"Held at 4, this allocated on EVERY event the moment five slots
//! shared one key — which is what a coin or start button on a big panel is."*
//! The fix shipped; the case that would have caught it did not, and the fan-out
//! key here is exactly that coin button.
//!
//! The allocation half lives in `engine_scheduler_alloc.rs` (its own binary,
//! because the counter is process-global). This file is the behaviour half.

mod common;

use std::time::Instant;

use common::{ev, ipac_device, FANOUT_KEY, FULL_HOUSE};
use ksx_core::{
    Engine, EngineTables, Key, PadState, Preset, ResolvedSlot, SlotSpec, XButton, XButtons,
    MAX_SLOTS,
};

fn slot_numbers(deltas: &ksx_core::Deltas) -> Vec<u8> {
    let mut numbers: Vec<u8> = deltas.iter().map(|d| d.slot).collect();
    numbers.sort_unstable();
    numbers
}

fn all_sixteen() -> Vec<u8> {
    (1..=FULL_HOUSE as u8).collect()
}

#[test]
fn the_fixture_sits_exactly_on_ksxs_own_ceiling() {
    // If `MAX_SLOTS` ever moves, this fixture stops being the boundary case and
    // silently becomes an ordinary one.
    assert_eq!(FULL_HOUSE, usize::from(MAX_SLOTS));
    let engine = common::full_house_engine();
    for n in all_sixteen() {
        assert!(engine.pad_state(n).is_some(), "slot {n} must exist");
    }
    assert!(engine.pad_state(0).is_none());
    assert!(engine.pad_state(MAX_SLOTS + 1).is_none());
}

/// One key, sixteen pads. The coin-button case from the `Deltas` comment.
#[test]
fn one_key_fans_out_to_every_slot_in_one_batch() {
    let dev = ipac_device();
    let mut engine = common::full_house_engine();

    let deltas = engine.handle(&ev(&dev, FANOUT_KEY, true));
    assert_eq!(
        deltas.len(),
        FULL_HOUSE,
        "one press on a key bound in all {FULL_HOUSE} slots must produce \
         {FULL_HOUSE} deltas — not a truncated batch",
    );
    assert_eq!(slot_numbers(&deltas), all_sixteen(), "one delta per slot");
    for delta in &deltas {
        assert!(
            delta.state.buttons.contains(XButtons::A),
            "slot {} did not get the press",
            delta.slot,
        );
    }
    // ...and the engine agrees with the batch it just handed out.
    for n in all_sixteen() {
        assert!(engine.pad_state(n).unwrap().buttons.contains(XButtons::A));
    }

    let released = engine.handle(&ev(&dev, FANOUT_KEY, false));
    assert_eq!(released.len(), FULL_HOUSE);
    for n in all_sixteen() {
        assert_eq!(engine.pad_state(n).unwrap(), PadState::default());
    }
}

/// Sixteen slots, sixteen separate pads. A private key touches exactly one.
#[test]
fn each_slots_own_keys_reach_only_that_slot() {
    let dev = ipac_device();
    let mut engine = common::full_house_engine();
    let privates = common::full_house_private_keys();

    for (i, keys) in privates.iter().enumerate() {
        let number = (i + 1) as u8;
        let deltas = engine.handle(&ev(&dev, keys[0], true));
        assert_eq!(
            slot_numbers(&deltas),
            vec![number],
            "{:?} is bound only in slot {number}",
            keys[0],
        );
        assert!(engine
            .pad_state(number)
            .unwrap()
            .buttons
            .contains(XButtons::B));
    }

    // Every slot now holds B, and each got there on its own key.
    for n in all_sixteen() {
        assert!(engine.pad_state(n).unwrap().buttons.contains(XButtons::B));
        assert!(
            !engine.pad_state(n).unwrap().buttons.contains(XButtons::A),
            "slot {n} must not have picked up a neighbour's binding",
        );
    }
}

/// Yanking the board clears all sixteen, not the first four.
#[test]
fn release_device_clears_every_slot() {
    let dev = ipac_device();
    let mut engine = common::full_house_engine();

    engine.handle(&ev(&dev, FANOUT_KEY, true));
    for keys in common::full_house_private_keys() {
        engine.handle(&ev(&dev, keys[0], true));
    }

    let deltas = engine.release_device(&dev);
    assert_eq!(
        slot_numbers(&deltas),
        all_sixteen(),
        "a yanked board must release every slot it drove",
    );
    for n in all_sixteen() {
        assert_eq!(
            engine.pad_state(n).unwrap(),
            PadState::default(),
            "slot {n} kept a held button after the board was unplugged — the \
             stuck-input failure this project refuses to ship",
        );
    }
}

/// A hot swap neutralizes all sixteen. `swap_tables` diffs against a
/// `previous` buffer inlined for exactly this many slots.
#[test]
fn a_hot_swap_neutralizes_every_slot() {
    let dev = ipac_device();
    let mut engine = common::full_house_engine();
    engine.handle(&ev(&dev, FANOUT_KEY, true));
    for n in all_sixteen() {
        assert!(engine.pad_state(n).unwrap().buttons.contains(XButtons::A));
    }

    // Swap in a set of slots that binds the fan-out key to nothing.
    let empty: Vec<Preset> = (0..FULL_HOUSE)
        .map(|i| common::preset(&format!("Empty {}", i + 1), Vec::new()))
        .collect();
    let deltas = engine.swap_tables(EngineTables::build(common::full_house_slots(empty)));
    assert_eq!(
        slot_numbers(&deltas),
        all_sixteen(),
        "every slot that was holding something must be told it is neutral",
    );
    for n in all_sixteen() {
        assert_eq!(engine.pad_state(n).unwrap(), PadState::default());
    }
    // The old key is genuinely gone, not merely neutralized once.
    assert!(engine.handle(&ev(&dev, FANOUT_KEY, true)).is_empty());
}

/// Tables built off-thread carry all sixteen slot numbers.
#[test]
fn sixteen_slot_tables_build_off_thread_and_report_their_shape() {
    let handle = std::thread::spawn(|| {
        EngineTables::build(common::full_house_slots(common::full_house_presets()))
    });
    let tables = handle.join().expect("tables build on any thread");
    assert_eq!(tables.slot_numbers(), all_sixteen());
    let engine = Engine::from_tables(tables);
    assert_eq!(
        engine.pad_state(MAX_SLOTS).unwrap(),
        PadState::default(),
        "the last slot must exist and start neutral",
    );
}

/// **A BLOWUP DETECTOR, NOT A LATENCY GATE.**
///
/// Read this before tightening it. `docs/ARCHITECTURE.md` rule 5 is p99
/// capture→submit under 1 ms, and the measurement that decides it is
/// `ksx doctor --latency` on the cabinet — real capture, real driver, real
/// scheduler. A wall-clock assertion inside `cargo test` measures none of
/// those and would flake on a loaded CI box or on a machine mid-thermal-event.
///
/// What this catches instead is a whole CLASS of change the allocation guards
/// cannot see: an accidental `O(n²)` rebuild, a `format!` landing on the hot
/// path, a lock taken per event. The bound is ~100× the measured cost in an
/// unoptimized debug build, so a real regression has to be enormous to trip
/// it — which is the point. Do not turn this into a benchmark.
#[test]
fn the_hot_path_does_not_blow_up_on_a_full_cabinet() {
    let dev = ipac_device();
    let mut engine = common::full_house_engine();
    let press = ev(&dev, FANOUT_KEY, true);
    let release = ev(&dev, FANOUT_KEY, false);

    const EVENTS: usize = 200_000;
    const BUDGET_SECS: u64 = 20;

    let mut sink = 0u64;
    let started = Instant::now();
    for i in 0..EVENTS {
        let e = if i % 2 == 0 { &press } else { &release };
        for d in engine.handle(e) {
            sink = sink.wrapping_add(u64::from(d.slot));
        }
    }
    let elapsed = started.elapsed();

    assert!(sink > 0, "the loop was optimized away");
    assert!(
        elapsed.as_secs() < BUDGET_SECS,
        "{EVENTS} events over {FULL_HOUSE} slots took {elapsed:?}, past the \
         {BUDGET_SECS}s blowup budget. This is NOT a p99 measurement — see this \
         test's doc comment — but something on the hot path now costs orders of \
         magnitude more than it did.",
    );
}

/// Duplicate slot numbers are a precondition violation, and in a debug build
/// they must be loud.
///
/// `EngineTables::build`'s uniqueness check is `debug_assert!`-only, so it is
/// stripped from release builds entirely. Config validation upstream is what
/// really prevents this, which is why the precondition is cheap to state and
/// was never tested — but the consequence of it silently holding is concrete:
/// with more entries than slots, `collect_deltas` pushes past `Deltas`' 16
/// inline entries and allocates on the hot path, on every event.
#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "slot numbers must be unique")]
fn duplicate_slot_numbers_are_refused_while_assertions_are_on() {
    let dev = ipac_device();
    let twice: Vec<ResolvedSlot> = (0..2)
        .map(|i| {
            let preset = common::preset(
                &format!("Clash {i}"),
                vec![(Key::G, ksx_core::Binding::Button(XButton::A))],
            );
            ResolvedSlot {
                // The same number, twice.
                spec: SlotSpec::new(1, Some(dev.clone()), None, preset.name.clone())
                    .expect("valid slot number"),
                preset,
            }
        })
        .collect();
    let _ = Engine::new(twice);
}
