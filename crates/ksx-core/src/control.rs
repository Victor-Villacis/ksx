//! [`PadControl`] — the ENDPOINT a [`Binding`] drives on a virtual pad.
//!
//! A [`Binding`] says *what to do* (`lx.16000`); a [`PadControl`] says *where*
//! (`lx`). Collapsing the axis value out of the key is what lets one holder
//! table answer "who is driving this endpoint", which is the resolver rule in
//! `docs/UNIVERSAL-IO.md` §2:
//!
//! > A digital control is the OR of its holders. An analog control takes the
//! > sign of the most recent rising demand on that axis and, among currently
//! > held holders of that sign, the largest magnitude; a control with no holder
//! > is neutral. Press and release run the same function over the post-event
//! > holder set.
//!
//! Two neighbours this is deliberately NOT:
//!
//! - [`crate::socd`]'s private control ids (`socd.rs:249-255`) are **coarser**:
//!   `DPAD_H` merges Left and Right into one control because SOCD is defined
//!   over opposing *pairs*, and there are no buttons or triggers at all. Do not
//!   unify them — SOCD needs the pair-merged view and the resolver needs the
//!   per-endpoint one.
//! - `ksx_api::control::ControlSource` is an unrelated trait (a source of
//!   control *input* to the daemon), not an endpoint.
//!
//! The matching *address* type `SourceControl` — where a physical control lives
//! on a source device — lands in `source.rs` in M13. Neither type is ever
//! called plain `Control`; see `docs/UNIVERSAL-IO.md` §2.

use crate::pad::{Axis, DpadDirection, Trigger, XButton};
use crate::preset::Binding;

/// One independently-writable cell of a [`crate::PadState`]: 11 buttons, 4 dpad
/// bits, 2 triggers, 4 axes.
///
/// Derives match [`Binding`]'s exactly, because this is a [`std::collections::HashMap`]
/// key on the engine's hot path and must be [`Copy`] + [`Hash`] + [`Eq`].
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum PadControl {
    Button(XButton),
    Trigger(Trigger),
    Axis(Axis),
    Dpad(DpadDirection),
}

impl PadControl {
    /// The endpoint a binding drives, or `None` for [`Binding::Consume`] —
    /// which drives nothing by definition, so "no endpoint" is unrepresentable
    /// here rather than representable-and-ignored. (The same choice
    /// [`crate::socd::pointing`] makes, and the reason [`DpadDirection`] has no
    /// `Off` variant.)
    ///
    /// Exhaustive on purpose: a new [`Binding`] variant must fail to compile
    /// here rather than silently resolve to nothing.
    pub const fn of(binding: Binding) -> Option<Self> {
        match binding {
            Binding::Button(b) => Some(Self::Button(b)),
            Binding::Trigger(t) => Some(Self::Trigger(t)),
            Binding::Axis { axis, .. } => Some(Self::Axis(axis)),
            Binding::Dpad(d) => Some(Self::Dpad(d)),
            Binding::Consume => None,
        }
    }

    /// `true` for the four stick axes — the controls whose holders carry a
    /// magnitude and therefore need the resolver. Everything else is the
    /// degenerate OR-of-holders case.
    ///
    /// A trigger is **digital** here: ksx drives `lt`/`rt` to `u8::MAX` or `0`
    /// and nothing else. Analog trigger travel is `Binding::Pressure`, which
    /// arrives in M12 (`docs/UNIVERSAL-IO.md` §3).
    pub const fn is_analog(self) -> bool {
        matches!(self, Self::Axis(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pad::AXIS_MIN;

    #[test]
    fn two_axis_bindings_with_different_values_are_one_control() {
        let weak = Binding::Axis {
            axis: Axis::X,
            value: 16_000,
        };
        let full = Binding::Axis {
            axis: Axis::X,
            value: AXIS_MIN,
        };
        assert_ne!(weak, full, "the bindings differ");
        assert_eq!(
            PadControl::of(weak),
            PadControl::of(full),
            "but they drive the same endpoint — this is the whole point of the type"
        );
    }

    #[test]
    fn a_consume_binding_drives_no_endpoint() {
        assert_eq!(PadControl::of(Binding::Consume), None);
    }

    #[test]
    fn only_the_sticks_are_analog() {
        for axis in Axis::ALL {
            assert!(PadControl::Axis(*axis).is_analog());
        }
        for t in Trigger::ALL {
            assert!(
                !PadControl::Trigger(*t).is_analog(),
                "{t:?} is binary today"
            );
        }
        for d in DpadDirection::ALL {
            assert!(!PadControl::Dpad(*d).is_analog());
        }
        for b in XButton::ALL {
            assert!(!PadControl::Button(*b).is_analog());
        }
    }
}
