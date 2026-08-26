//! Hot-path allocation check for the SCHEDULER — macros, turbo and toggle —
//! on a FULL sixteen-slot cabinet.
//!
//! # The hole this closes (2026-08-26 audit)
//!
//! `engine_alloc.rs` and `engine_chords_alloc.rs` both build their engine from
//! `common::preset()`, which sets `macros: Default::default(), turbo: vec![],
//! toggle: vec![]`. So `has_macros`/`has_turbo` are false and
//! [`Engine::tick`] returns on its first line. `tick` is the function that
//! fires for every macro step and every turbo phase flip during play, and it
//! was measured by nothing.
//!
//! Proven, not argued: an unconditional `Vec::with_capacity(64)` inserted at
//! the top of `Engine::tick` left all 311 `ksx-core` tests passing. `Timers::armed`,
//! `slot.macro_dirty` and `slot.scan` are three `Vec`s whose freedom from
//! reallocation rests entirely on capacity arithmetic in `EngineTables::build`
//! that nothing checked.
//!
//! Sixteen slots is deliberate and is the second half of the same gap: nothing
//! in the workspace built more than four, and sixteen (`ksx_core::MAX_SLOTS`)
//! is exactly where `Deltas`, `KeyTargets` and `SyncSlots` sit at their inline
//! capacity. `engine_alloc.rs` keeps its four-slot pin; this is the wide one.
//!
//! # Rules of this file
//!
//! It deliberately contains a SINGLE `#[test]`, exactly like its two siblings:
//! the allocation counter is process-global, so a second test in this binary
//! would run concurrently with the measured section and make it racy — which
//! is to say, quietly vacuous. Do not add one.
//!
//! Everything that is ALLOWED to allocate is hoisted above the measurement:
//! building `KeyEvent`s clones the device-id string (the capture layer's job),
//! and `EngineTables::build` allocates by design — it is the off-thread half of
//! the hot-swap contract. What must not allocate is the swap itself, and every
//! per-event and per-tick step.

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use ksx_core::{EngineTables, KeyEvent, MAX_SLOTS};

struct CountingAlloc;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: delegates to `System`, only adding a relaxed counter bump.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::SeqCst);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::SeqCst);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

/// How many pre-built table sets the swap phase consumes.
const SWAPS: usize = 8;

#[test]
fn the_scheduler_does_not_allocate_on_a_full_cabinet() {
    assert_eq!(
        common::FULL_HOUSE,
        usize::from(MAX_SLOTS),
        "this fixture must sit exactly at ksx's own ceiling",
    );

    let dev = common::ipac_device();
    let mut engine = common::full_house_scheduler_engine();

    // --- Everything allowed to allocate, hoisted out of the measurement. ---
    let keys = common::full_house_bound_keys();
    let mut press: Vec<KeyEvent> = Vec::new();
    let mut release: Vec<KeyEvent> = Vec::new();
    for &k in &keys {
        press.push(common::ev(&dev, k, true));
        release.push(common::ev(&dev, k, false));
    }
    // The off-thread half of the hot-swap contract: building tables allocates
    // by design, applying them must not.
    let mut spare: Vec<EngineTables> = (0..SWAPS)
        .map(|_| {
            EngineTables::build(common::full_house_slots(
                common::full_house_scheduler_presets(),
            ))
        })
        .collect();

    let mut sink = 0u64; // fold output so nothing can be optimized away
    let mut clock = 0u64;

    // One full cycle: press everything, run the clock through every macro step
    // and turbo phase, re-trigger mid-run, cancel, release.
    let cycle = |engine: &mut ksx_core::Engine, clock: &mut u64, sink: &mut u64| {
        for e in &press {
            for d in engine.handle_at(e, *clock) {
                *sink = sink.wrapping_add(u64::from(d.slot));
            }
        }
        // Through the whole macro (3 × 50 ms) and well past several turbo
        // phase flips, ticking at a rate a real output thread would.
        for step in 0..40 {
            *clock += 10;
            for d in engine.tick(*clock) {
                *sink = sink.wrapping_add(u64::from(d.state.buttons.bits()));
            }
            // Re-trigger mid-run: the path that restarts an in-flight macro
            // rather than starting a fresh one.
            if step == 12 {
                for e in press.iter().skip(1).take(common::FULL_HOUSE) {
                    for d in engine.handle_at(e, *clock) {
                        *sink = sink.wrapping_add(u64::from(d.slot));
                    }
                }
            }
        }
        for d in engine.cancel_macros() {
            *sink = sink.wrapping_add(u64::from(d.slot));
        }
        for e in &release {
            for d in engine.handle_at(e, *clock) {
                *sink = sink.wrapping_add(u64::from(d.slot));
            }
        }
        for d in engine.release_device(&dev) {
            *sink = sink.wrapping_add(u64::from(d.slot));
        }
        *clock += 1000;
    };

    // --- Warmup: two full cycles, so nothing is still growing lazily. ---
    cycle(&mut engine, &mut clock, &mut sink);
    cycle(&mut engine, &mut clock, &mut sink);

    let before = ALLOCATIONS.load(Ordering::SeqCst);
    // Guard against a vacuous pass: the setup above must have gone through the
    // counting hook, or this test is measuring nothing at all.
    assert!(before > 0, "counting allocator is not installed");

    for _ in 0..20 {
        cycle(&mut engine, &mut clock, &mut sink);
    }

    // The swap itself, on a live 16-slot engine holding scheduler state: the
    // `previous` buffer it diffs against is inlined for exactly 16.
    while let Some(tables) = spare.pop() {
        for d in engine.swap_tables(tables) {
            sink = sink.wrapping_add(u64::from(d.slot));
        }
    }

    let after = ALLOCATIONS.load(Ordering::SeqCst);
    assert_eq!(
        before,
        after,
        "the scheduler hot path allocated {} time(s) on a {}-slot cabinet \
         (sink={sink})",
        after - before,
        common::FULL_HOUSE,
    );
}
