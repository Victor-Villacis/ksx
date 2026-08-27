//! How many of Windows' four XInput slots are occupied **right now**.
//!
//! This exists because counting ViGEmBus children answers a different
//! question. [`crate::virtual_pads`] can only ever see ksx's own virtual pads
//! — its module header says so explicitly: "a REAL DualShock or Xbox pad
//! plugged into the cabinet carries the very same ids, but it hangs off a USB
//! hub devnode, never off ViGEmBus, so it cannot reach the classifier at all."
//! A cabinet with two real wired Xbox 360 pads and no virtual ones therefore
//! reports zero XInput pads from the bus, and any sentence built on that
//! number ("so four more will be readable") is wrong by two.
//!
//! `XInputGetState` asks the thing that actually hands out the slots. Real
//! pads, virtual pads and pads created by some other process all count, which
//! is exactly the property a "how many more will a game see" sentence needs.
//!
//! **Read-only and cheap.** No handle is opened, no state is changed, and the
//! four calls are a poll of a driver that is already resident. It is *not*
//! free of races — another process can take a slot a microsecond later — so
//! callers must phrase the result as a ceiling ("at most N more"), never as a
//! promise.

/// How many of the [`ksx_core::MAX_XINPUT_SLOTS`] slots have a pad in them.
///
/// `None` means **ksx could not ask** — not "none are in use". The two are
/// different sentences and a surface must render them differently: a caller
/// that folds `None` into `0` produces "four more pads will be readable" on a
/// machine it never actually looked at.
#[cfg(windows)]
pub fn slots_in_use() -> Option<u8> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::UI::Input::XboxController::{XInputGetState, XINPUT_STATE};

    let mut used = 0u8;
    for index in 0..u32::from(ksx_core::MAX_XINPUT_SLOTS) {
        // SAFETY: `state` is a plain C struct that zeroes validly and
        // XInputGetState fills it on success. The call takes a scalar index
        // and an out-pointer to storage we own; it cannot fail unsafely. The
        // same call ksx-cabinet's `read_pad` makes every frame.
        let mut state: XINPUT_STATE = unsafe { std::mem::zeroed() };
        let result = unsafe { XInputGetState(index, &mut state) };
        // Anything other than success — ERROR_DEVICE_NOT_CONNECTED included —
        // means no pad is answering on this index.
        if result == ERROR_SUCCESS {
            used += 1;
        }
    }
    Some(used)
}

/// Off Windows there are no XInput slots to read, and saying "zero are in
/// use" would be a claim about a machine this build cannot inspect.
#[cfg(not(windows))]
pub fn slots_in_use() -> Option<u8> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smoke, and only a smoke: the call runs, does not panic, and answers
    /// `Some` on Windows / `None` off it.
    ///
    /// Read the two assertions before trusting them. `Some(used)` is a literal
    /// in the Windows arm, and `used` increments at most once per iteration of
    /// a loop bounded by the very constant it is compared against — so
    /// **neither can fail for any implementation of the loop**. The `None` arm
    /// is the only one carrying weight, and it is the arm this build never
    /// compiles. What the count actually *means* is pinned below.
    #[test]
    fn asking_xinput_never_panics_and_never_guesses_off_windows() {
        let answer = slots_in_use();
        if cfg!(windows) {
            let used = answer.expect("Windows can always ask XInput");
            assert!(
                used <= ksx_core::MAX_XINPUT_SLOTS,
                "{used} occupied slots is more than Windows has"
            );
        } else {
            assert_eq!(
                answer, None,
                "off Windows this must be unanswerable, never 0 — 0 is a claim"
            );
        }
    }

    /// **What the number means**, which no live call on one machine can check:
    /// a slot is counted when XInput SUCCEEDS, and the ceiling is the shared
    /// constant.
    ///
    /// Invert the comparison to `!=` and a cabinet with nothing plugged in
    /// reports all four slots occupied — the surface then says "no more pads
    /// will be readable" about a machine it did look at and misread, which is
    /// the mirror image of the failure this module's header exists to prevent.
    /// The live smoke above stays green through that change on every machine,
    /// and so does the whole workspace.
    ///
    /// A source fence rather than a table-driven test because the counting is
    /// welded to the `XInputGetState` call. Extracting
    /// `fn count_connected(results: &[u32]) -> u8` would let this be fixtures
    /// (`[SUCCESS, NOT_CONNECTED, SUCCESS, NOT_CONNECTED] -> 2`) and would be
    /// the better shape; until then, read the counter.
    #[test]
    fn a_slot_is_counted_only_where_xinput_succeeded() {
        let source = include_str!("xinput.rs").replace("\r\n", "\n");
        let counter = source
            .split("pub fn slots_in_use()")
            .nth(1)
            .expect("xinput.rs still counts occupied slots")
            .split("#[cfg(not(windows))]")
            .next()
            .unwrap();

        assert!(
            counter.contains("0..u32::from(ksx_core::MAX_XINPUT_SLOTS)"),
            "the poll must be bounded by the shared constant, not a literal 4: {counter}"
        );
        assert!(
            counter.contains("if result == ERROR_SUCCESS {"),
            "a slot counts only where XInput answered SUCCESS: {counter}"
        );
        assert!(
            !counter.contains("!= ERROR_SUCCESS"),
            "counting the failures reports an empty machine as full: {counter}"
        );
        assert_eq!(
            counter.matches("used += 1").count(),
            1,
            "one increment, inside the success branch: {counter}"
        );
    }
}
