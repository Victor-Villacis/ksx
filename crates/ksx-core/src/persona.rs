//! Which *kind* of controller a slot presents itself as.
//!
//! A persona changes only the shape of the device Windows sees. It does not
//! change capture, presets, or bindings: the wire vocabulary stays Xbox-flavored
//! everywhere (`A`, `B`, `LeftBumper`), and ✕○△□ are display aliases, not a
//! second binding language. Re-persona-ing a slot must never require editing its
//! preset — the one documented exception is the D-pad, see [`Persona::dpad_is_hat`].
//!
//! Why it exists (measured, `docs/research/m6.5-ds4-findings.md`):
//! - **Correct prompts.** A PS1/PS2/PS3 emulator reading a PlayStation pad shows
//!   ✕ instead of A. That is the whole point for a cabinet profile.
//! - **Players 5+.** Windows exposes exactly four XInput slots and no virtual bus
//!   can create a fifth. PlayStation targets are plain HID, so they neither
//!   consume nor compete for those four — six were enumerated on the cabinet
//!   while four X360 pads already held every slot.

use std::fmt;
use std::str::FromStr;

/// The controller a slot presents itself as.
///
/// Serialized by its canonical [`Persona::as_str`]; parsed leniently by
/// [`FromStr`], which accepts the aliases people actually type.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum Persona {
    /// Xbox 360 wired pad — a genuine XInput device via Microsoft's own
    /// `xusb22.sys`. The most compatible gamepad persona ever made (every
    /// XInput title, 2006→today), which is why it is the default and why slots
    /// 1–4 should stay on it.
    #[default]
    Xbox360,
    /// Sony DualShock 4 wired pad — plain HID/DirectInput. Read by MAME,
    /// RetroArch, SDL, and Steam Input; *not* by XInput-only games.
    ///
    /// Named for the family, not the model: the wire shape is a DS4 because
    /// that is what ViGEmBus emulates, but users configure `persona =
    /// "playstation"` and are not asked to care which Sony pad it clones.
    PlayStation,
    /// Sony DualSense (PS5) — **HIDMaestro only** (M8). ViGEmBus has no
    /// DualSense target and never will; the project is frozen.
    ///
    /// Distinct from [`Persona::PlayStation`] on purpose: a PS5-era game or
    /// emulator that sniffs for VID 054C/PID 0CE6 shows DualSense prompts and
    /// enables adaptive-trigger UI, which a DS4 clone does not get. Anyone who
    /// just wants ✕○△□ should stay on `playstation` — it needs no second driver.
    DualSense,
    /// Nintendo Switch Pro Controller — **HIDMaestro only** (M8).
    ///
    /// The persona that makes Switch/Wii U emulators (yuzu/ryujinx lineage,
    /// Cemu, Dolphin) show Nintendo prompts and the B/A swap without a
    /// per-emulator remap.
    SwitchPro,
    /// Xbox Series X|S pad — **HIDMaestro only** (M8), and specifically the
    /// *Bluetooth* profile (`xbox-series-xs-bt`).
    ///
    /// Not a better [`Persona::Xbox360`], and never a replacement for it: slots
    /// 1–4 stay on ViGEm's genuine `xusb22.sys` (see
    /// [`Persona::backend`]). This exists for titles that check for a
    /// current-generation pad, and it is the BT profile rather than a wired one
    /// because WGI/GameInput consumers (every browser gamepad tester, and the
    /// GameInput-era titles behind them) do not route force feedback to the
    /// X360 XUSB companion — they drive the HID output path instead
    /// (`docs/research/padforge-code-audit.md` §3.5).
    XboxSeries,
    /// SNES pad — **HIDMaestro only**, presented as the iBuffalo Classic USB
    /// Gamepad (0583:2060), the canonical emulator SNES pad: a decade of
    /// RetroArch/SDL auto-config entries key on this exact identity, and its
    /// 3-byte report (X, Y, 8 buttons) is the cleanest descriptor in the
    /// catalog. Chosen over the NSO SNES pad, whose catalog profile is a
    /// synthesized Joy-Con-family placeholder that SDL's HIDAPI would
    /// handshake and find dead (measured 2026-08-20,
    /// `docs/HIDMAESTRO-STATE.md` retro scope call).
    Snes,
    /// Sega Genesis / Mega Drive pad — **HIDMaestro only**, presented as the
    /// DaemonBite Genesis/Saturn adapter (2341:8036): 9 buttons + signed X/Y,
    /// straight from the adapter firmware's own descriptor, no vendor
    /// protocol for any consumer to expect. The same wire identity serves
    /// Saturn per the adapter's own notes. Chosen over the Mega Drive Mini
    /// pad, whose Usage(0) hat the SDK's report builder cannot address — its
    /// D-pad would be dead (measured 2026-08-20).
    Genesis,
}

/// Which driver stack materializes a [`Persona`].
///
/// **Derived, never configured.** A ksx config expresses *intent* (`persona =
/// "dualsense"`); the backend is plumbing, and asking a user to name it would
/// let them write a combination that cannot exist (`persona = "xbox360",
/// backend = "hidmaestro"`) and then debug it.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum PadBackend {
    /// ViGEmBus — kernel bus, `xusb22.sys` for X360, plain HID for DS4.
    Vigem,
    /// HIDMaestro — user-mode (UMDF2) HID descriptor emulator. Adds the
    /// personas ViGEmBus cannot express, at the cost of a second driver.
    HidMaestro,
}

const HIDMAESTRO_BUILD_GAP: &str =
    "this HIDMaestro controller persona has not yet completed its independent production runtime";

impl PadBackend {
    pub const ALL: &'static [PadBackend] = &[PadBackend::Vigem, PadBackend::HidMaestro];

    pub const fn as_str(self) -> &'static str {
        match self {
            PadBackend::Vigem => "vigem",
            PadBackend::HidMaestro => "hidmaestro",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            PadBackend::Vigem => "ViGEmBus",
            PadBackend::HidMaestro => "HIDMaestro",
        }
    }

    /// Whether THIS BUILD of ksx contains code that can create at least one
    /// persona on this stack.
    ///
    /// A fact about the binary, and deliberately **not** a probe of the
    /// machine. The two disagree in the one case that matters: an installed
    /// HIDMaestro driver makes a machine probe succeed even when this binary
    /// has no production runtime for a particular profile. A probe-based gate
    /// would offer that profile and send the user back to a driver they had
    /// already installed.
    ///
    /// This is a backend-level diagnostic. Product gates must call
    /// [`PadBackend::supports`] (normally through [`Persona::can_plug`]) so a
    /// measured DualSense rollout cannot accidentally enable Switch Pro and
    /// Xbox Series at the same time.
    pub const fn is_implemented(self) -> bool {
        match self {
            PadBackend::Vigem => true,
            PadBackend::HidMaestro => self.supports(Persona::DualSense),
        }
    }

    /// Whether this exact persona is implemented by this backend in this
    /// build.
    ///
    /// The HIDMaestro arms are intentionally separate: each flips `true`
    /// only when its independently distributable production runtime ships,
    /// because a persona listed here is a promise the Studio makes to a
    /// player. The source-built host currently carries one DualSense. The
    /// other catalog profiles stay known but gated while the retired
    /// SDK-backed runtime remains excluded from releases.
    ///
    /// `docs/HIDMAESTRO-STATE.md` is the living record of what has actually
    /// been observed versus merely implemented, with the measurement behind
    /// each claim. Read it before flipping any arm here.
    pub const fn supports(self, persona: Persona) -> bool {
        match (self, persona) {
            (PadBackend::Vigem, Persona::Xbox360 | Persona::PlayStation) => true,
            (PadBackend::HidMaestro, Persona::DualSense) => true,
            (PadBackend::HidMaestro, Persona::SwitchPro) => false,
            (PadBackend::HidMaestro, Persona::XboxSeries) => false,
            (PadBackend::HidMaestro, Persona::Snes) => false,
            (PadBackend::HidMaestro, Persona::Genesis) => false,
            _ => false,
        }
    }

    /// What is missing, so a refusal can explain itself instead of asserting.
    /// `None` exactly when [`PadBackend::is_implemented`].
    ///
    /// Phrased to close off the wrong fix: "not installed" is the answer users
    /// act on, and acting on it here costs a driver install that changes
    /// nothing.
    pub const fn gap(self) -> Option<&'static str> {
        if self.is_implemented() {
            None
        } else {
            Some(HIDMAESTRO_BUILD_GAP)
        }
    }

    /// What is missing for one exact persona.
    ///
    /// Unlike [`PadBackend::gap`], this remains truthful after a partial
    /// backend rollout.
    pub const fn gap_for(self, persona: Persona) -> Option<&'static str> {
        if self.supports(persona) {
            return None;
        }
        match self {
            PadBackend::Vigem => Some("ViGEmBus cannot emulate this controller persona"),
            PadBackend::HidMaestro => Some(HIDMAESTRO_BUILD_GAP),
        }
    }
}

impl fmt::Display for PadBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Persona {
    pub const ALL: &'static [Persona] = &[
        Persona::Xbox360,
        Persona::PlayStation,
        Persona::DualSense,
        Persona::SwitchPro,
        Persona::XboxSeries,
        Persona::Snes,
        Persona::Genesis,
    ];

    /// Canonical name — what [`Persona`] serializes to and what error messages
    /// and `--json` output print. Stable; the aliases are free to grow.
    pub const fn as_str(self) -> &'static str {
        match self {
            Persona::Xbox360 => "xbox360",
            Persona::PlayStation => "playstation",
            Persona::DualSense => "dualsense",
            Persona::SwitchPro => "switchpro",
            Persona::XboxSeries => "xboxseries",
            Persona::Snes => "snes",
            Persona::Genesis => "genesis",
        }
    }

    /// Short label for humans (tray tooltips, `ksx pads` rows).
    pub const fn label(self) -> &'static str {
        match self {
            Persona::Xbox360 => "Xbox 360",
            Persona::PlayStation => "PlayStation",
            Persona::DualSense => "DualSense",
            Persona::SwitchPro => "Switch Pro",
            Persona::XboxSeries => "Xbox Series X|S",
            Persona::Snes => "SNES",
            Persona::Genesis => "Genesis",
        }
    }

    /// Which driver stack has to materialize this persona.
    ///
    /// **The current capability rule, stated as code**
    /// (`docs/ENHANCEMENTS.md` E1/E4): Xbox 360 and PlayStation use the shipped
    /// ViGEmBus compatibility lane; richer identities route to HIDMaestro,
    /// where each profile has its own capability gate. ViGEmBus's X360 target
    /// reaches Microsoft's genuine `xusb22.sys`
    /// stack and is kept as a supported fallback even after HIDMaestro ships.
    /// The historical HIDMaestro WGI double-input issue was fixed upstream and
    /// is no longer an architectural reason for this routing rule.
    pub const fn backend(self) -> PadBackend {
        match self {
            Persona::Xbox360 | Persona::PlayStation => PadBackend::Vigem,
            Persona::DualSense
            | Persona::SwitchPro
            | Persona::XboxSeries
            | Persona::Snes
            | Persona::Genesis => PadBackend::HidMaestro,
        }
    }

    /// Whether this persona occupies one of Windows' four XInput slots.
    ///
    /// Drives two things: the `MAX_XINPUT_SLOTS` validation rule, and whether
    /// the output backend bothers running slot correlation (600 ms per pad that
    /// can only ever fail for a HID pad — see `ksx-output/src/vigem.rs`).
    /// `true` for [`Persona::XboxSeries`] as well, and that is deliberate:
    /// an Xbox Series virtual is created as a software-device companion that
    /// Windows' own inbox `xinputhid` driver binds (measured 2026-08-20: every
    /// Xbox profile in the catalog is `driverMode: xinputhid`, and the created
    /// devnode's HID child hardware id is what `xinputhid.inf` matches), which
    /// is precisely what claims an XInput slot. So an Xbox Series pad competes
    /// for the same four slots a real one would, and must be counted by the
    /// [`crate::MAX_XINPUT_SLOTS`] rule. Sony and Nintendo personas are plain
    /// HID and consume nothing. An earlier revision credited a "GIP companion"
    /// for the slot — the wrong mechanism, the right conclusion.
    pub const fn is_xinput(self) -> bool {
        matches!(self, Persona::Xbox360 | Persona::XboxSeries)
    }

    /// Whether the pad reports its D-pad as a 4-bit hat instead of four
    /// independent buttons.
    ///
    /// **The one place a persona is not transparent.** ksx's aggregation can
    /// legitimately produce Up+Down at once (two keys held, or a custom function
    /// spanning both); XInput represents that faithfully, a hat cannot. The
    /// collapse rule is documented and tested in `ksx-output/src/ds4.rs`.
    ///
    /// True for every persona except Xbox 360: the DS4/DualSense/Switch Pro HID
    /// reports all carry a 4-bit hat, and so does the Xbox Series **Bluetooth**
    /// HID report (the one HIDMaestro's `xbox-series-xs-bt` profile presents).
    /// Xbox 360 over XUSB is the outlier that gets four independent bits.
    pub const fn dpad_is_hat(self) -> bool {
        !matches!(self, Persona::Xbox360)
    }

    /// Whether the bus can push rumble/LED state back to us for this persona.
    ///
    /// `false` for PlayStation: ViGEmBus exposes no notification IOCTL for DS4
    /// targets, so there is nothing to subscribe to. Not a gap in ksx — the
    /// driver simply has no such channel, and no lightbar or rumble will ever
    /// arrive on one of these pads.
    ///
    /// `false` for [`Persona::SwitchPro`] too, and that one is an *honest gap*
    /// rather than a driver fact: HIDMaestro delivers output packets for every
    /// device it hosts, but the decode table we hold
    /// (`padforge-code-audit.md` §3.4 — XInput IOCTL, Xbox Series BT short HID,
    /// Xbox legacy HID, Sony `validFlag0`-gated motors, HID-PID) has **no
    /// Switch rumble entry**. Claiming feedback we cannot decode would make
    /// `poll_feedback` a promise of silence. Flip this to `true` in the same
    /// commit that adds the Switch subcommand decode, not before.
    pub const fn has_feedback(self) -> bool {
        matches!(
            self,
            Persona::Xbox360 | Persona::DualSense | Persona::XboxSeries
        )
    }

    /// Whether THIS BUILD of ksx can create this persona at all.
    ///
    /// The gate that decides whether a persona is *offered* — by the config
    /// validator, by the router, by `ksx doctor`. It resolves to
    /// [`PadBackend::supports`], which is a fact about the binary and not
    /// about the machine, and that distinction is the whole point: a gate built
    /// on a driver probe is wrong in exactly the case it is there for. Install
    /// HIDMaestro, the probe says yes, the picker offers `switchpro`, and the
    /// plug fails anyway.
    ///
    /// Note what this does NOT do: remove the persona from the vocabulary.
    /// [`Persona::ALL`] still lists it, `FromStr` still parses it, and a config
    /// that names it still loads. A name that stops parsing produces "unknown
    /// persona", which is a lie — the persona is known, it just cannot be built
    /// — and it would break every file that already says `persona =
    /// "dualsense"`.
    pub const fn can_plug(self) -> bool {
        self.backend().supports(self)
    }

    /// Maximum number of this exact persona one ksx session may create.
    ///
    /// `None` means the backend has no persona-specific ceiling beyond ksx's
    /// normal slot limits. The current source-built HIDMaestro runtime owns one
    /// fixed device, but that is a backend-wide pool enforced by
    /// [`crate::MAX_HIDMAESTRO_PADS`], not a separate DualSense rule.
    pub const fn instance_limit(self) -> Option<usize> {
        let _ = self;
        None
    }

    /// Why this exact persona cannot be plugged by this build.
    ///
    /// Product surfaces use this instead of a backend-wide gap so enabling one
    /// HIDMaestro profile never silences the refusal for the others.
    pub const fn gap(self) -> Option<&'static str> {
        self.backend().gap_for(self)
    }

    /// The nearest persona this build *can* plug, so a refusal ends in a fix
    /// rather than a dead end.
    ///
    /// **Never a substitution.** Nothing calls this to downgrade a slot behind
    /// the user's back — silently handing a PS5 name a DS4 is precisely what
    /// [`FromStr`] refuses to do. It exists so the message that turns down
    /// an unfinished profile can name a working compatibility persona in the
    /// same breath.
    pub const fn nearest_pluggable(self) -> Persona {
        // A persona this build can plug is always its own answer — derived
        // from the gate, so flipping a persona live can never leave a stale
        // fallback suggesting something else.
        if self.can_plug() {
            return self;
        }
        match self {
            // Gated personas land on the most compatible pad there is; the
            // invariant test refuses a suggestion that cannot itself plug.
            Persona::SwitchPro | Persona::XboxSeries | Persona::Snes | Persona::Genesis => {
                Persona::Xbox360
            }
            already => already,
        }
    }
}

impl fmt::Display for Persona {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownPersona(pub String);

// Written by hand rather than derived so the "expected one of" list is
// generated from [`Persona::ALL`]: a new persona can never ship with an error
// message that forgets to mention it.
impl fmt::Display for UnknownPersona {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown persona '{}' (expected one of: ", self.0)?;
        for (i, p) in Persona::ALL.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            f.write_str(p.as_str())?;
        }
        f.write_str(")")
    }
}

impl std::error::Error for UnknownPersona {}

impl FromStr for Persona {
    type Err = UnknownPersona;

    /// Case- and separator-insensitive, and generous with aliases: config files
    /// are hand-edited, so `ds4`, `PS4`, and `Xbox 360` all have to work.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let normalized: String = s
            .chars()
            .filter(|c| !matches!(c, ' ' | '-' | '_'))
            .flat_map(char::to_lowercase)
            .collect();
        match normalized.as_str() {
            "xbox360" | "x360" | "xbox" | "360" | "xinput" => Ok(Persona::Xbox360),
            "playstation" | "ps" | "ds4" | "ps4" | "dualshock" | "dualshock4" | "sony" => {
                Ok(Persona::PlayStation)
            }
            // `ds5`/`ps5` deliberately do NOT fall through to PlayStation: a
            // user who typed a PS5 name and silently got a DS4 would see the
            // wrong prompts and no adaptive triggers, with nothing to explain
            // it. On a machine without HIDMaestro this parses fine and fails
            // later, loudly, naming the missing driver.
            "dualsense" | "ds5" | "ps5" | "dualsense5" => Ok(Persona::DualSense),
            "switchpro" | "switch" | "procontroller" | "switchprocontroller" | "nintendo" => {
                Ok(Persona::SwitchPro)
            }
            // `xboxseriesxsbt` is HIDMaestro's own profile slug, accepted so a
            // slug copied out of the catalog just works.
            "xboxseries" | "xboxseriesx" | "xboxseriess" | "xboxseriesx|s" | "xboxseriesxs"
            | "xboxseriesxsbt" | "series" | "xsx" => Ok(Persona::XboxSeries),
            "snes" | "supernintendo" | "superfamicom" | "sfc" => Ok(Persona::Snes),
            // `saturn` is accepted because the DaemonBite adapter this
            // persona presents as is the SAME wire identity for Genesis,
            // Mega Drive and Saturn (its descriptor notes say so) — nothing
            // is silently substituted.
            "genesis" | "megadrive" | "md" | "sega" | "saturn" | "segagenesis"
            | "segamegadrive" | "segasaturn" | "megadrive6b" => Ok(Persona::Genesis),
            _ => Err(UnknownPersona(s.to_owned())),
        }
    }
}

// No serde impls here on purpose: ksx-core stays dependency-free and its types
// cross the config boundary by name (same rule as `Key::from_name`). The TOML
// glue lives in `ksx-config::persona_serde`, which is a thin wrapper over
// [`Persona::as_str`] and [`FromStr`] above.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_xbox360() {
        // Every config written before personas existed must keep behaving
        // exactly as it did; that is what makes `#[serde(default)]` safe.
        assert_eq!(Persona::default(), Persona::Xbox360);
    }

    #[test]
    fn canonical_names_round_trip() {
        for &p in Persona::ALL {
            assert_eq!(p.as_str().parse::<Persona>(), Ok(p), "{p} must round-trip");
        }
    }

    #[test]
    fn aliases_parse() {
        for alias in [
            "ds4",
            "DS4",
            "ps4",
            "PS4",
            "dualshock4",
            "Dual-Shock 4",
            "sony",
        ] {
            assert_eq!(alias.parse(), Ok(Persona::PlayStation), "alias {alias}");
        }
        for alias in ["xbox360", "Xbox 360", "x360", "XBOX_360", "xinput"] {
            assert_eq!(alias.parse(), Ok(Persona::Xbox360), "alias {alias}");
        }
    }

    #[test]
    fn unknown_persona_names_the_valid_ones() {
        let err = "gamecube".parse::<Persona>().unwrap_err();
        assert_eq!(err, UnknownPersona("gamecube".to_owned()));
        let msg = err.to_string();
        for &p in Persona::ALL {
            assert!(msg.contains(p.as_str()), "{msg} should list {p}");
        }
    }

    #[test]
    fn capability_flags_match_the_measured_driver_behavior() {
        assert!(Persona::Xbox360.is_xinput());
        assert!(Persona::Xbox360.has_feedback());
        assert!(!Persona::Xbox360.dpad_is_hat());
        // The three facts that make PlayStation slots different, all measured
        // on ViGEmBus 1.21.442.0 (docs/research/m6.5-ds4-findings.md).
        assert!(!Persona::PlayStation.is_xinput());
        assert!(!Persona::PlayStation.has_feedback());
        assert!(Persona::PlayStation.dpad_is_hat());
    }

    /// The M8 personas, each flag justified in the doc comment it mirrors.
    /// Written to spec (`docs/research/padforge-code-audit.md` §3); only the
    /// DualSense row is currently carried by a released production host.
    #[test]
    fn hidmaestro_persona_flags_are_stated_per_device_not_copied() {
        // Sony HID: no XInput slot, hat d-pad, and motors we CAN decode
        // (validFlag0-gated, §3.4).
        assert!(!Persona::DualSense.is_xinput());
        assert!(Persona::DualSense.dpad_is_hat());
        assert!(Persona::DualSense.has_feedback());

        // Switch Pro: the honest gap — no Switch entry in the decode table, so
        // feedback is false until one is written.
        assert!(!Persona::SwitchPro.is_xinput());
        assert!(Persona::SwitchPro.dpad_is_hat());
        assert!(!Persona::SwitchPro.has_feedback());

        // Xbox Series: the GIP companion DOES occupy an XInput slot, so it
        // counts against the four; the BT profile reports a hat.
        assert!(Persona::XboxSeries.is_xinput());
        assert!(Persona::XboxSeries.dpad_is_hat());
        assert!(Persona::XboxSeries.has_feedback());

        // The retro pair, added 2026-08-26: before this, NO literal pinned
        // either one — `dpad_is_hat` and `has_feedback` were free to flip on
        // both without a single test noticing, and the only thing touching
        // them was the XInput *count* in
        // `xbox_series_counts_against_the_four_xinput_slots`.
        //
        // Plain HID pads: no XInput slot, and no rumble to decode — an SNES pad
        // has no motors and the Genesis profile carries none, so a `true` here
        // would make `poll_feedback` a promise of silence exactly as it would
        // for Switch Pro. Both report their d-pad as a 4-bit hat, per the
        // descriptor-ordered tables the 2026-08-20 retro leg spawned.
        for retro in [Persona::Snes, Persona::Genesis] {
            assert!(!retro.is_xinput(), "{retro} is plain HID");
            assert!(retro.dpad_is_hat(), "{retro} reports a hat");
            assert!(!retro.has_feedback(), "{retro} has no motors to decode");
        }
    }

    #[test]
    fn xbox_series_counts_against_the_four_xinput_slots() {
        // Stated as its own test because it is the one flag that changes a
        // *validation* outcome: five xboxseries slots must be refused exactly
        // like five xbox360 slots, not waved through as "HID, plenty of room".
        let xinput = Persona::ALL.iter().filter(|p| p.is_xinput()).count();
        assert_eq!(xinput, 2, "only the two Xbox personas take an XInput slot");
    }

    #[test]
    fn backend_is_derived_and_slots_1_to_4_never_leave_vigem() {
        // The rule from ENHANCEMENTS E1/E4: the two personas the cabinet
        // actually runs on stay on the kernel bus, whatever else is installed.
        assert_eq!(Persona::Xbox360.backend(), PadBackend::Vigem);
        assert_eq!(Persona::PlayStation.backend(), PadBackend::Vigem);
        // The three that ViGEmBus cannot express at all.
        for p in [Persona::DualSense, Persona::SwitchPro, Persona::XboxSeries] {
            assert_eq!(p.backend(), PadBackend::HidMaestro, "{p}");
        }
        // Every persona resolves to exactly one backend, and both backends are
        // reachable — a persona list that all landed on one stack would mean
        // the routing layer is dead code.
        for &b in PadBackend::ALL {
            assert!(
                Persona::ALL.iter().any(|p| p.backend() == b),
                "no persona routes to {b}"
            );
        }
    }

    #[test]
    fn only_personas_with_shipped_production_runtimes_can_plug() {
        for persona in [Persona::Xbox360, Persona::PlayStation, Persona::DualSense] {
            assert!(persona.can_plug(), "{persona} must be offered");
        }
        for persona in [
            Persona::SwitchPro,
            Persona::XboxSeries,
            Persona::Snes,
            Persona::Genesis,
        ] {
            assert!(!persona.can_plug(), "{persona} must remain gated");
        }
    }

    #[test]
    fn the_source_built_host_uses_the_backend_pool_not_a_duplicate_persona_limit() {
        assert_eq!(crate::MAX_HIDMAESTRO_PADS, 1);
        for &persona in Persona::ALL {
            assert_eq!(persona.instance_limit(), None, "{persona}");
        }
    }

    #[test]
    fn a_refused_persona_still_parses_and_still_has_a_name() {
        // Deleting the variant, or making it stop parsing, would turn every
        // existing `persona = "snes"` into "unknown persona" — which is
        // false, and points the reader at a typo they did not make.
        //
        // These profiles stay in the vocabulary while their production
        // runtime is gated, so existing config gets an honest capability
        // refusal instead of a false "unknown persona" error.
        for (spelling, persona) in [
            ("snes", Persona::Snes),
            ("superfamicom", Persona::Snes),
            ("genesis", Persona::Genesis),
            ("saturn", Persona::Genesis),
            ("Sega Genesis", Persona::Genesis),
            ("Sega Mega Drive", Persona::Genesis),
        ] {
            let p: Persona = spelling
                .parse()
                .unwrap_or_else(|e| panic!("{spelling}: {e}"));
            assert_eq!(p, persona, "{spelling}");
            assert!(!p.can_plug(), "{p} must remain capability-gated");
            assert!(Persona::ALL.contains(&p));
        }
    }

    #[test]
    fn every_refusal_can_name_a_persona_that_works() {
        // A refusal whose suggested alternative is itself refused is a loop.
        for &p in Persona::ALL {
            let instead = p.nearest_pluggable();
            assert!(
                instead.can_plug(),
                "{p} suggests {instead}, which cannot plug either"
            );
            if p.can_plug() {
                assert_eq!(instead, p, "{p} works; nothing to suggest");
            }
        }
        // The source-built DualSense lane remains itself; gated profiles land
        // on the always-available compatibility pad.
        assert_eq!(Persona::DualSense.nearest_pluggable(), Persona::DualSense);
        for persona in [
            Persona::SwitchPro,
            Persona::XboxSeries,
            Persona::Snes,
            Persona::Genesis,
        ] {
            assert_eq!(persona.nearest_pluggable(), Persona::Xbox360, "{persona}");
        }

        assert!(
            Persona::Xbox360.can_plug(),
            "the fallback every refusal points at must itself plug"
        );
        assert_eq!(
            Persona::Xbox360.backend(),
            PadBackend::Vigem,
            "the fallback must stay on the never-gated stack, or the suggestion \
             can go stale with a rollout"
        );
    }

    #[test]
    fn a_backend_that_cannot_build_a_device_says_what_is_missing() {
        // Both stacks ship at least one production persona, so neither has a
        // backend-wide gap.
        assert_eq!(PadBackend::Vigem.gap(), None);
        assert_eq!(PadBackend::HidMaestro.gap(), None);
        for persona in [
            Persona::SwitchPro,
            Persona::XboxSeries,
            Persona::Snes,
            Persona::Genesis,
        ] {
            let gap = persona.gap().expect("gated persona needs an explanation");
            assert!(gap.contains("production runtime"), "{persona}: {gap}");
        }

        // What the test's name actually promises, and the only live rendering
        // path left: ask a backend about a persona it does not own. Both arms
        // must name the stack that is missing something and must NOT read like
        // an install instruction — "install ViGEmBus" is the wrong fix for a
        // persona ViGEmBus can never express, and the wrong fix for a profile
        // this build has not finished.
        let vigem_gap = PadBackend::Vigem
            .gap_for(Persona::DualSense)
            .expect("ViGEmBus cannot express a DualSense; that must be explainable");
        assert!(
            vigem_gap.contains("ViGEmBus") && vigem_gap.contains("cannot emulate"),
            "{vigem_gap}"
        );
        assert!(
            !vigem_gap.contains("install"),
            "a persona the driver can never express must not read as an install hint: {vigem_gap}"
        );

        let build_gap = PadBackend::HidMaestro
            .gap_for(Persona::Xbox360)
            .expect("the HIDMaestro stack does not own Xbox 360; that must be explainable");
        assert!(
            build_gap.contains("HIDMaestro") && build_gap.contains("production runtime"),
            "the build gap must name the component and the missing milestone: {build_gap}"
        );
        assert!(
            !build_gap.contains("install"),
            "an unfinished runtime must not tell the user to install anything: {build_gap}"
        );
    }

    #[test]
    fn backend_names_round_trip_for_json() {
        for &b in PadBackend::ALL {
            assert_eq!(b.to_string(), b.as_str());
            assert!(!b.label().is_empty());
        }
        assert_eq!(PadBackend::HidMaestro.as_str(), "hidmaestro");
    }

    #[test]
    fn ps5_names_never_silently_degrade_to_a_ds4() {
        for alias in ["ds5", "PS5", "DualSense", "dual-sense"] {
            assert_eq!(alias.parse(), Ok(Persona::DualSense), "alias {alias}");
        }
        for alias in ["switch", "Switch Pro", "switch_pro", "nintendo"] {
            assert_eq!(alias.parse(), Ok(Persona::SwitchPro), "alias {alias}");
        }
        for alias in ["xboxseries", "Xbox Series X", "xbox-series-xs-bt", "xsx"] {
            assert_eq!(alias.parse(), Ok(Persona::XboxSeries), "alias {alias}");
        }
        // And the pre-M8 aliases still mean what they always meant.
        assert_eq!("ps4".parse(), Ok(Persona::PlayStation));
        assert_eq!("xbox".parse(), Ok(Persona::Xbox360));
    }

    #[test]
    fn display_matches_the_canonical_name() {
        for &p in Persona::ALL {
            assert_eq!(p.to_string(), p.as_str());
            assert!(!p.label().is_empty());
        }
    }
}
