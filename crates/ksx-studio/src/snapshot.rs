//! The status contract — **now `ksx-api`'s** — plus the two PAGE payloads,
//! which stay here because they are this page's shape and nobody else's.
//!
//! `StatusSource` and its snapshots moved to `ksx-api` for the reason
//! docs/M9-DECISION.md §6 gives: the read side must be satisfiable with NO
//! daemon running (ksx-backend's collectors read the config store and the platform
//! directly), and it is consumed by surfaces that do not link this crate. What
//! remains below is the part that genuinely belongs to a web page: the
//! envelope the islands protocol serializes into the document and the poller
//! reads back.

pub use ksx_api::status::*;

use serde::{Deserialize, Serialize};

/// The one live-data shape: what `GET /api/status` serves AND what the page
/// embeds (render.rs serializes it into the `__ksx-payload` script block).
/// One struct, one serializer — the client seeds its signals from the block
/// and then overwrites the SAME signals from `/api/status` every 2 s, so the
/// two must never drift. `render.rs` has the parity test;
/// `studio-ui/src/StatusIsland.ts` mirrors the field names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusPayload {
    pub snapshot: StatusSnapshot,
    pub session: crate::control::SessionView,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/status` — a poll is not an action — and `Some` only in the
    /// page-render props, where the client shows it once and clears it.
    pub flash: Option<String>,
}

/// What `GET /api/map` serves AND what the mapper island's props carry — the
/// same one-struct-one-serializer rule as [`StatusPayload`], parity pinned in
/// `render_map.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MapPayload {
    pub mapper: MapperSnapshot,
    pub session: crate::control::SessionView,
    /// Where the daemon's learner stands (also tells the page whether
    /// learning is possible at all).
    pub learn: crate::control::LearnView,
    /// Slot number selected for the SSR paint (`/map?slot=N`, defaulting to
    /// the first slot). The client keeps its own selection afterwards.
    pub selected: u8,
    /// The selected slot's macros, read per request like everything else.
    #[serde(default)]
    pub macros: MacroSnapshot,
    /// Macro name selected for the SSR paint (`/map?macro=NAME`), empty for
    /// "the first one". Same contract as [`selected`](Self::selected): it
    /// drives the server paint, the client keeps its own choice afterwards —
    /// and because the macro tabs are anchors, a page with no JavaScript can
    /// still walk through every macro the preset defines.
    #[serde(default)]
    pub macro_selected: String,
    /// `stage` means the existing mapper is aimed at the in-memory first-run
    /// setup. Empty/`saved` means its traditional on-disk target. Defaulted so
    /// older fixtures and clients retain the saved-layout behavior.
    #[serde(default)]
    pub target: String,
    /// The keyboard shelf for EVERY slot (key → the controls it drives, plus
    /// the summary sentence), keyed by slot number as a string because it
    /// crosses JSON. Composed once, in Rust (`render_map::shelf_views`), and
    /// rendered verbatim by the island's list — the parity suite caught the
    /// previous shape, where the SSR paint said "No bound keys yet" and the
    /// client rebuilt the shelf imperatively on adoption.
    #[serde(default)]
    pub shelf: std::collections::BTreeMap<String, ShelfView>,
}

/// One slot's keyboard shelf: the summary line + one row per bound key.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShelfView {
    pub summary: String,
    pub keys: Vec<ShelfKeyRow>,
}

/// One bound physical key on the shelf, display-ready. The island binds these
/// fields as direct member reads; nothing is derived client-side.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShelfKeyRow {
    pub key: String,
    /// The controls it drives, joined "|" — the button's `data-controls`.
    pub controls: String,
    pub title: String,
    pub use_label: String,
}

/// What `GET /api/check` serves AND what the button-check island's props carry
/// — the same one-struct-one-serializer rule as [`StatusPayload`], parity
/// pinned in `render_check.rs`.
///
/// **There is no live data in here, and that is the shape of the page.** This
/// payload is the STRUCTURE — which slots exist, which controls each one's
/// preset names, which keys drive them — read from disk on the server and
/// re-read every few seconds. The lighting-up arrives on a different channel
/// entirely (`GET /api/live`, `crate::live`), at display rate, and touches no
/// signal on the page. Putting a frame in here would mean a button check whose
/// echo was as fast as an HTTP poll, which is not a button check.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckPayload {
    /// The slot roster with every preset's whole binding table — the SAME
    /// `StatusSource::mapper()` read the mapper page uses.
    ///
    /// The control list per slot is `MapperSlot::bindings`' key set, which is
    /// every function the preset names, unbound ones included. That is where
    /// the roster has to come from: a list of "the controls an Xbox pad has"
    /// written into the page would be a second answer to a question the
    /// backend already answers, and docs/SURFACES.md §1 names that failure.
    pub mapper: MapperSnapshot,
    /// The daemon's session state — the page prints it, because "nothing is
    /// lighting up" and "nothing is running" are the same picture and
    /// different problems.
    pub session: crate::control::SessionView,
    /// One sentence saying what this screen watches and where the frames come
    /// from. Composed in Rust so the island words nothing.
    pub feed_hint: String,
}

/// What `GET /api/pads` serves AND what the pads island's props carry — the
/// same one-struct-one-serializer rule as [`StatusPayload`], parity pinned in
/// `render_pads.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadsPayload {
    /// The bus, its children, and both verbs' preconditions — one
    /// `MachineSource::pads_view` call, never re-derived here.
    pub pads: ksx_api::PadsView,
    /// Whether the daemon answers at all. Not a precondition for this page:
    /// the pad list and the prune plan are collector reads, and the session is
    /// shown because a running one is what REFUSES both verbs.
    pub session: crate::control::SessionView,
    /// Is the destructive panel armed (`/pads?confirm=1`)?
    ///
    /// Always `false` from `/api/pads` — a poll is not a user saying yes, and
    /// a poll that could re-arm a prune would make the confirm panel reappear
    /// after someone had deliberately navigated away from it.
    #[serde(default)]
    pub confirm: bool,
    /// Why the machine read failed, if it did. Rendered as a banner instead of
    /// an empty pad list, which would read as "your bus is clean".
    #[serde(default)]
    pub unavailable: Option<String>,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/pads`, `Some` only in the page-render props.
    pub flash: Option<String>,
}

/// What `GET /api/devices` serves AND what the `/devices` island's props
/// carry — the same one-struct-one-serializer rule as [`StatusPayload`],
/// parity pinned in `render_devices.rs`.
///
/// The scan and the reason it is missing are SEPARATE fields on purpose. An
/// empty `DeviceScanView` is a real answer on a machine with nothing plugged
/// in; it is also what a refusal would degrade to if the two were collapsed,
/// and "no boards found" on a machine with four boards is the worst possible
/// lie for this page to tell. [`Self::unavailable`] non-empty means the view
/// below is not a reading of anything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesPayload {
    pub scan: ksx_api::DeviceScanView,
    /// **What ksx left behind**, from `MachineSource::winusb_residue`. A
    /// SEPARATE read from the scan and deliberately so: the device tree is the
    /// thing that looks healthy while the receipt store disagrees with it, and
    /// a page that only ever read the tree is why nine stale receipts sat
    /// unreported on an affected machine.
    #[serde(default)]
    pub residue: ksx_api::WinusbResidueView,
    /// Session state, for the header pill and for the one caution this page
    /// owes a running cabinet: a `[[device]]` edit lands in `config.toml`, and
    /// the session already running keeps the devices it opened until it is
    /// restarted.
    pub session: crate::control::SessionView,
    /// Empty when the scan answered. Otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/devices` — a poll is not an action.
    pub flash: Option<String>,
}

/// What `GET /api/profiles` serves AND what the Profiles island's props carry
/// — the same one-struct-one-serializer rule as [`StatusPayload`], parity
/// pinned in `render_profiles.rs`.
///
/// Two machine views side by side rather than one flattened shape, because
/// they are two backend reads with two failure modes: games.toml can be
/// unreadable while the presets folder is fine, and the page has to be able to
/// say which. [`notes`](Self::notes) is where either read's complaint lands —
/// a refusal renders as a note beside an empty list, never as an empty list on
/// its own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfilesPayload {
    pub profiles: ksx_api::ProfilesView,
    pub presets: ksx_api::PresetsView,
    pub session: crate::control::SessionView,
    /// The refusal that stopped the games.toml read, if it stopped.
    ///
    /// This field is the difference between two sentences that a count cannot
    /// tell apart: **"you have no profiles"** and **"I could not read your
    /// profiles."** Before it existed the handler substituted a
    /// `ProfilesView::default()` on `Err`, so an unreadable games.toml printed
    /// "no profiles in games.toml" at the top of the page with the real reason
    /// four cards further down. That is this project's signature failure —
    /// a surface reporting success over a read that did not happen — and it is
    /// the exact thing the rest of this page was written to stop.
    ///
    /// `Some` means the list below is empty BECAUSE THE READ FAILED, and every
    /// derived line ([`ProfilesDerived`]) says so instead of counting.
    #[serde(default)]
    pub profiles_error: Option<String>,
    /// The same, for the presets folder. Kept separate because the two reads
    /// fail independently and the page has to be able to say which.
    #[serde(default)]
    pub presets_error: Option<String>,
    /// Anything either read had to say out loud, including a whole read that
    /// refused. Rendered; never swallowed.
    #[serde(default)]
    pub notes: Vec<String>,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/profiles` — a poll is not an action.
    pub flash: Option<String>,
    /// Every displayed string and every branch this page needs, computed ONCE
    /// — see [`ProfilesDerived`]. Recomputed from the fields above by
    /// [`Self::derived`]; never assembled by hand.
    #[serde(default)]
    pub view: ProfilesDerived,
}

impl ProfilesPayload {
    /// Fill [`Self::view`] from the raw provider data.
    ///
    /// Every producer of a payload calls this — the page render and
    /// `GET /api/profiles` — so the server paint and the 2 s poll are the same
    /// bytes by construction rather than by two implementations agreeing.
    #[must_use]
    pub fn derived(mut self) -> Self {
        self.view = ProfilesDerived::of(&self);
        self
    }
}

/// Everything the Profiles page DISPLAYS that is not verbatim provider data:
/// the summary lines, the row lines, the pill classes, the option lists, the
/// slot ceiling, and every `show:` branch.
///
/// # Why it is a serialized struct and not two functions
///
/// It was two functions, and that was the review finding. Every line below
/// existed twice — once in `render_profiles.rs` for the server paint, once in
/// `ProfilesIsland.ts` for the 2 s poll — which docs/SURFACES.md §1 forbids
/// for exactly the reason it went wrong here: the TypeScript half carried a
/// hardcoded `"16"` slot ceiling that no poll could correct, so the first
/// `ksx_core::MAX_SLOTS` raise would have had the server render `max="32"` and
/// hydration write `16` straight back over it. Two copies of a SENTENCE drift
/// silently; two copies of a NUMBER drift silently and then refuse a legal
/// input. `main.rs`'s `slot_arg` module exists to commemorate the same bug.
///
/// So the derivation happens here, once, in the backend, and both the SSR slot
/// injection and the browser read the result. The island computes nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfilesDerived {
    /// The line above the profile list. Says "could not be read" — NOT
    /// "no profiles" — when [`ProfilesPayload::profiles_error`] is set.
    pub profiles_summary: String,
    pub broken_summary: String,
    pub presets_summary: String,
    pub templates_summary: String,
    /// The sentence above the template list, roster included. It was static
    /// copy in `ProfilesIsland.ts` naming four templates while the registry
    /// ships six — the copy-is-logic drift docs/SURFACES.md §1a is about,
    /// already stale on the day it was reviewed. Composed here from the same
    /// list the rows and the `<select>` options are built from.
    pub templates_intro: String,
    /// Customer-facing session state for the Games screen. The raw control
    /// transport line remains in the payload for diagnostics but is never
    /// painted as product copy.
    pub play_status: String,
    /// The exact `ksx daemon …` line for this cabinet.
    pub daemon_cmd: String,
    /// `ksx_core::MAX_SLOTS`, as the slot-count input's `max`. The ONE place
    /// this number may come from; a client-side literal was the finding.
    pub max_slots: u8,
    /// The widest player block any offered template carries — the preset
    /// form's `max`, which used to be the literal `"4"` whether or not the
    /// selected template had four blocks.
    pub max_player: u8,
    pub profile_rows: Vec<ProfileRowView>,
    pub broken_rows: Vec<BrokenRowView>,
    pub preset_rows: Vec<PresetRowView>,
    /// [`Self::preset_rows`] minus the built-ins. A second list rather than a
    /// flag on the first, because the compiler cannot emit a conditional
    /// inside a list item, and a disabled control is a promise a page cannot
    /// keep.
    pub preset_edit_rows: Vec<PresetRowView>,
    /// The in-box templates as a LIST, carrying `detail` — the panel note
    /// ksx-api documents as the thing that makes a template identifiable.
    /// Served since the beginning and rendered nowhere until now.
    pub template_rows: Vec<TemplateRowView>,
    pub preset_options: Vec<OptionView>,
    pub template_options: Vec<OptionView>,
    pub note_rows: Vec<NoteView>,

    // ── The `show:` branches. Booleans, because a page that decides in two
    //    languages decides differently in one of them.
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    pub no_daemon: bool,
    /// A running game can be stopped without leaving this screen.
    pub can_stop: bool,
    pub any_broken: bool,
    /// Offer the Switch button (a start could actually be accepted).
    pub rows_live: bool,
    pub rows_plain: bool,
    /// The games.toml read REFUSED. Distinct from "no profiles" on purpose.
    pub profiles_unreadable: bool,
    /// The create-profile form is usable: presets were read, and there is one.
    pub can_make_profile: bool,
    /// Presets were read and there are none — a real, fixable empty state
    /// whose copy points at the template form below, which will work.
    pub no_presets_yet: bool,
    /// **No layouts of the customer's own.** Distinct from
    /// [`Self::no_presets_yet`], which is also false when the two built-ins
    /// are all there is — and the built-ins are exactly what the rename and
    /// delete card cannot offer.
    pub no_editable_presets: bool,
    /// The presets read REFUSED. NOT [`Self::no_presets_yet`]: that sentence
    /// sends the user to a template form whose `<select>` is also empty, so
    /// the only path it offers cannot succeed — a closed loop with a wrong
    /// sentence on it.
    pub presets_unreadable: bool,
    /// The template form is usable at all (the presets read, which carries the
    /// template list, succeeded).
    pub can_make_preset: bool,
    pub any_notes: bool,
}

/// One `[[game]]` profile as a row.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileRowView {
    /// Opaque backend revision returned unchanged by update/delete forms.
    pub revision: String,
    pub title: String,
    pub path: String,
    pub arguments: String,
    /// Form-ready player count. Kept as text because Forma list-item
    /// attributes bind directly to row members.
    pub slots: String,
    pub max_slots: String,
    /// The current primary layout. Saving an edit deliberately applies the
    /// selected layout to every resulting player.
    pub preset: String,
    /// Valid controller layouts with the row's current one first. A select
    /// uses this instead of accepting an arbitrary internal name.
    pub layout_options: Vec<OptionView>,
    pub detail: String,
    pub verdict: String,
    /// The pill class. Derived from `ProfileDetail::state` HERE so the pill a
    /// poll paints is the pill the server painted.
    pub statecls: String,
    pub statelabel: String,
    /// False for a missing local program. The row stays editable, but Play is
    /// disabled until the program is corrected.
    pub play_disabled: bool,
}

/// One broken profile in the alarm card.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokenRowView {
    pub title: String,
    /// The path that does not resolve — the whole reason the card exists.
    pub path: String,
    pub verdict: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetRowView {
    pub name: String,
    pub detail: String,
    pub statecls: String,
    pub statelabel: String,
    /// **This layout may be renamed and deleted.** False for the two in-box
    /// seeds, whose identity other things assume — the row still renders, it
    /// just carries no controls, which is the honest shape for "not yours".
    pub editable: bool,
    /// What deleting it would break, in words, or empty when nothing names
    /// it. Rendered NEXT to the delete control so the guard is readable
    /// before the click rather than only in the refusal after it.
    pub used_line: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateRowView {
    pub id: String,
    pub label: String,
    /// The panel note that travels with the template.
    pub detail: String,
    /// "player 1" / "players 1–2" — the block range this template can
    /// instantiate, so the number the form asks for is visible next to it.
    pub players: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionView {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteView {
    pub line: String,
}

impl ProfilesDerived {
    /// Derive the whole display layer from one payload.
    fn of(p: &ProfilesPayload) -> Self {
        let profiles_failed = p.profiles_error.is_some();
        let presets_failed = p.presets_error.is_some();
        let has_presets = p.presets.presets.iter().any(|layout| layout.usable);
        let can_start = p.session.reachable && !p.session.running;

        // The provider's word, never a re-derivation: deciding what counts as
        // broken outside the provider is what docs/SURFACES.md §1 forbids.
        let broken: Vec<&ksx_api::ProfileDetail> = p
            .profiles
            .profiles
            .iter()
            .filter(|g| g.state == "broken")
            .collect();

        Self {
            profiles_summary: profiles_summary(p.profiles.profiles.len(), profiles_failed),
            broken_summary: broken_summary(broken.len()),
            presets_summary: presets_summary(p.presets.presets.len(), presets_failed),
            templates_summary: templates_summary(p.presets.templates.len(), presets_failed),
            templates_intro: templates_intro(&p.presets.templates, presets_failed),
            play_status: session_play_status(&p.session),
            daemon_cmd: crate::render::daemon_command(&p.session),
            max_slots: ksx_api::MAX_SLOTS,
            max_player: p
                .presets
                .templates
                .iter()
                .filter_map(|t| t.players.iter().copied().max())
                .max()
                .unwrap_or(1),
            profile_rows: p
                .profiles
                .profiles
                .iter()
                .map(|g| ProfileRowView {
                    revision: g.revision.clone(),
                    title: g.title.clone(),
                    path: g.path.clone(),
                    arguments: g.arguments.clone(),
                    slots: g.slots.to_string(),
                    max_slots: ksx_api::MAX_SLOTS.to_string(),
                    preset: g.presets.first().cloned().unwrap_or_default(),
                    layout_options: profile_layout_options(
                        &p.presets.presets,
                        g.presets.first().map(String::as_str),
                    ),
                    detail: profile_detail_line(g),
                    verdict: profile_verdict(g),
                    statecls: state_class(&g.state).to_owned(),
                    statelabel: match g.state.as_str() {
                        "broken" => "needs attention".to_owned(),
                        "launcher" => "game link".to_owned(),
                        _ => "ready".to_owned(),
                    },
                    play_disabled: g.state == "broken",
                })
                .collect(),
            broken_rows: broken
                .iter()
                .map(|g| BrokenRowView {
                    title: g.title.clone(),
                    // `broken_path` is the provider's answer to "which string
                    // is wrong"; falling back to `path` keeps the row honest
                    // for the empty-path case, where there IS no bad path.
                    path: g.broken_path.clone().unwrap_or_else(|| g.path.clone()),
                    verdict: profile_verdict(g),
                })
                .collect(),
            preset_edit_rows: preset_row_views(&p.presets.presets)
                .into_iter()
                .filter(|r| r.editable)
                .collect(),
            preset_rows: preset_row_views(&p.presets.presets),
            template_rows: p
                .presets
                .templates
                .iter()
                .map(|t| TemplateRowView {
                    id: t.id.clone(),
                    label: t.label.clone(),
                    detail: t.detail.clone(),
                    players: player_range(&t.players),
                })
                .collect(),
            preset_options: p
                .presets
                .presets
                .iter()
                .filter(|r| r.usable)
                .map(|r| OptionView {
                    value: r.name.clone(),
                    label: r.name.clone(),
                })
                .collect(),
            template_options: p
                .presets
                .templates
                .iter()
                .map(|t| OptionView {
                    value: t.id.clone(),
                    // The player range is IN the option, because the form's
                    // player field is one ceiling for every template and the
                    // user is the only one who can see which they picked.
                    label: format!("{} ({})", t.label, player_range(&t.players)),
                })
                .collect(),
            note_rows: p
                .notes
                .iter()
                .map(|line| NoteView { line: line.clone() })
                .collect(),

            pill_running: p.session.reachable && p.session.running,
            pill_idle: can_start,
            pill_down: !p.session.reachable,
            no_daemon: !p.session.reachable,
            can_stop: p.session.reachable && p.session.running,
            any_broken: !broken.is_empty(),
            rows_live: can_start && !profiles_failed,
            rows_plain: !can_start && !profiles_failed,
            profiles_unreadable: profiles_failed,
            can_make_profile: has_presets && !presets_failed && !profiles_failed,
            no_presets_yet: !has_presets && !presets_failed,
            no_editable_presets: !presets_failed && p.presets.presets.iter().all(|r| r.protected),
            presets_unreadable: presets_failed,
            can_make_preset: !presets_failed,
            any_notes: !p.notes.is_empty(),
        }
    }
}

/// The setup page's read: `ksx_api::MachineSource::setup_state`, plus the one
/// fact a bare `Result` cannot carry into a template — WHY there is nothing.
///
/// The same shape, and the same reason, as [`MapperSnapshot::unavailable`]: a
/// provider that refuses must produce a page that SAYS so, not an empty
/// checklist that looks like a machine with nothing configured. Those two
/// states are opposite advice ("import a config" vs "this build has no machine
/// provider") and a blank page gives the wrong one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupSnapshot {
    /// The machine provider answered.
    pub available: bool,
    /// Where the facts came from, or — with `available` false — why there are
    /// none. Rendered either way.
    pub source: String,
    pub view: ksx_api::SetupView,
}

impl SetupSnapshot {
    pub fn ready(view: ksx_api::SetupView) -> Self {
        Self {
            available: true,
            source: "read from this machine's config root".to_owned(),
            view,
        }
    }

    /// No setup facts; `reason` renders where the checklist would be.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            source: reason.to_owned(),
            view: ksx_api::SetupView::default(),
        }
    }
}

/// The line above the profile list.
///
/// The `failed` arm is the point of this function. "no profiles in games.toml"
/// is a statement about the file's CONTENTS; when the read refused, nothing is
/// known about the contents, and printing the count sentence asserts an
/// absence nobody checked.
fn profiles_summary(count: usize, failed: bool) -> String {
    if failed {
        return "Saved games could not be read. The reason is below.".to_owned();
    }
    match count {
        0 => "No saved games yet.".to_owned(),
        1 => "1 saved game".to_owned(),
        n => format!("{n} saved games"),
    }
}

fn broken_summary(count: usize) -> String {
    match count {
        1 => "1 saved game points at a program that is not there:".to_owned(),
        n => format!("{n} saved games point at a program that is not there:"),
    }
}

fn presets_summary(count: usize, failed: bool) -> String {
    if failed {
        return "Controller layouts could not be read. The reason is below.".to_owned();
    }
    match count {
        0 => "No controller layouts yet.".to_owned(),
        1 => "1 controller layout".to_owned(),
        n => format!("{n} controller layouts"),
    }
}

/// The templates ship inside the binary, so an empty list here means the read
/// that carries them refused — never "this build has no templates".
fn templates_summary(count: usize, failed: bool) -> String {
    if failed {
        return "Starter layouts could not be listed.".to_owned();
    }
    match count {
        0 => "No starter layouts are available.".to_owned(),
        1 => "1 starter layout available".to_owned(),
        n => format!("{n} starter layouts available"),
    }
}

/// The short introduction above the starter-layout select.
///
/// The full served roster still renders from `template_rows`, now inside the
/// optional comparison disclosure. Keeping its names out of this paragraph
/// prevents the first action from being buried under a six-layout catalogue.
fn templates_intro(templates: &[ksx_api::TemplateRow], failed: bool) -> String {
    if failed || templates.is_empty() {
        return "Starter layouts could not be listed. Reopen ksx and try again.".to_owned();
    }
    "Choose a starter layout that resembles your controls. It makes an editable controller \
     layout of your own, and every button can be changed later in Controls."
        .to_owned()
}

fn session_play_status(session: &crate::control::SessionView) -> String {
    if !session.reachable {
        return "Play is unavailable. Reopen ksx and try again.".to_owned();
    }
    if session.running {
        return session
            .profile
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map_or_else(
                || "A game is playing.".to_owned(),
                |name| format!("Playing “{name}”."),
            );
    }
    "Ready to play.".to_owned()
}

/// Valid choices for one edit form, with its current valid layout first so a
/// native `<select>` preserves the row without client-side selection logic.
fn profile_layout_options(
    layouts: &[ksx_api::PresetRow],
    current: Option<&str>,
) -> Vec<OptionView> {
    let mut options = layouts
        .iter()
        .filter(|layout| layout.usable)
        .map(|layout| OptionView {
            value: layout.name.clone(),
            label: layout.name.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(index) = current.and_then(|current| {
        options
            .iter()
            .position(|option| option.value.eq_ignore_ascii_case(current))
    }) {
        options.rotate_left(index);
    }
    options
}

/// A profile's state as the pill class that carries it.
///
/// `launcher` gets the NEUTRAL pill, not the OK one, and that is not a style
/// choice: `ksx_games::preflight` cannot resolve a `steam://` URL — only the
/// shell knows whether `rungameid/9999` names a real game — so a green badge
/// would be ksx claiming a check it did not make.
fn state_class(state: &str) -> &'static str {
    match state {
        "broken" => "pill pill-warn",
        "launcher" => "pill pill-idle",
        _ => "pill pill-ok",
    }
}

fn profile_detail_line(p: &ksx_api::ProfileDetail) -> String {
    let slots = match p.slots {
        1 => "1 player".to_owned(),
        n => format!("{n} players"),
    };
    if p.presets.is_empty() {
        format!("{slots} — no controller layout selected")
    } else {
        format!("{slots} — {}", p.presets.join(", "))
    }
}

fn profile_verdict(p: &ksx_api::ProfileDetail) -> String {
    match p.state.as_str() {
        "broken" => {
            "The program could not be found. Open Edit or delete and correct the game link."
                .to_owned()
        }
        "launcher" => "This game link will be opened when Play starts it.".to_owned(),
        _ => "Ready to launch.".to_owned(),
    }
}

/// **One description of a controller layout, for both lists.**
///
/// `/profiles` shows every layout, and a second list shows only the ones that
/// can be renamed or deleted. Two `map` bodies would be two chances for the
/// same layout to be described differently in the same page, so there is one.
fn preset_row_views(presets: &[ksx_api::PresetRow]) -> Vec<PresetRowView> {
    presets
        .iter()
        .map(|r| PresetRowView {
            name: r.name.clone(),
            detail: r.problem.clone().unwrap_or_else(|| preset_detail_line(r)),
            statecls: if !r.usable {
                "pill pill-warn".to_owned()
            } else if r.protected {
                "pill pill-idle".to_owned()
            } else {
                "pill pill-ok".to_owned()
            },
            statelabel: if !r.usable {
                "needs attention".to_owned()
            } else if r.protected {
                "built-in".to_owned()
            } else {
                "yours".to_owned()
            },
            editable: !r.protected,
            used_line: match r.used_by {
                0 => "Not used by any controller.".to_owned(),
                1 => "Used by 1 controller.".to_owned(),
                n => format!("Used by {n} controllers."),
            },
        })
        .collect()
}
fn preset_detail_line(p: &ksx_api::PresetRow) -> String {
    let controls = match p.bound {
        1 => "1 control".to_owned(),
        n => format!("{n} controls"),
    };
    let macros = match p.macros {
        0 => String::new(),
        n => format!(", {n} macro(s)"),
    };
    format!("{controls}{macros}")
}

/// "player 1" / "players 1–3" — the blocks a template can instantiate.
fn player_range(players: &[u8]) -> String {
    match (players.iter().min(), players.iter().max()) {
        (Some(lo), Some(hi)) if lo == hi => format!("player {lo}"),
        (Some(lo), Some(hi)) => format!("players {lo}–{hi}"),
        _ => "no player blocks".to_owned(),
    }
}

/// The sentence a refused read produces, everywhere it appears. A page that
/// could not read a machine says THIS; it never says the machine is empty.
const UNREADABLE: &str = "The configuration could not be read.";

/// **Every sentence `/setup` states as a fact, composed once, in Rust.**
///
/// docs/SURFACES.md §1, applied to the render seam: the SSR paint and the
/// island's two-second poll show the same words because there is only one
/// implementation of them, not two that a reviewer has to diff. `SetupIsland.ts`
/// reads these fields and renders them; it derives nothing. Six of these lines
/// were hand-mirrored in TypeScript until an adversarial review pointed out
/// that the test claiming to pin the two sides together only ever read the Rust
/// one.
///
/// The other half of the job is [`SetupSnapshot::available`]. A provider that
/// REFUSED knows nothing about this machine, so not one line below may assert
/// absence — "I could not read this" and "there is nothing here" are different
/// sentences and a user acts on them differently.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupLines {
    /// The loudest line on the page: the whole configuration in one sentence.
    pub config: String,
    /// The inventory's board heading.
    pub boards: String,
    /// The inventory's slot heading.
    pub slots: String,
    /// What is on disk, in one line.
    pub library: String,
    /// What the Export button would hand back.
    pub export: String,
    /// Where the daemon's learner stands, as step 3 reads it.
    pub prove: String,
    /// WHY the wire-a-slot control is disabled, or empty when it is not.
    ///
    /// One reason, never a disjunction: `wireable` is two facts ANDed, and a
    /// single sentence covering both told a user with a running daemon to start
    /// the daemon, and a user with presets on disk to go and make a preset.
    pub wire_blocked: String,
    /// WHY the learner control is disabled, or empty when it is not. Same rule:
    /// "no daemon" and "a daemon whose listener is unavailable" are different
    /// states and the page knows which one it is in.
    pub prove_blocked: String,
    /// What wiring a slot will do to the pads, for the session there actually
    /// is. The unconditional "REPLUGS the pads" was false against an idle
    /// daemon — which the form is offered on, because `wireable` turns on
    /// `reachable`, not on `running`.
    pub wire_warning: String,
    /// What this keyboard does while a game is running, in one sentence, with
    /// the honest hedge when nothing is configured yet.
    pub blocking_line: String,
}

impl SetupLines {
    /// Compose every line for one read. The only implementation.
    pub fn of(
        setup: &SetupSnapshot,
        session: &crate::control::SessionView,
        learn: &crate::control::LearnView,
    ) -> Self {
        let view = &setup.view;
        if !setup.available {
            // NOT "there is nothing configured" — that sentence is advice
            // ("import one"), and it would be the wrong advice. Every line here
            // says the same thing the guard on the card says.
            return Self {
                config: UNREADABLE.to_owned(),
                boards: "the boards on this machine could not be read".to_owned(),
                slots: "the slots on this machine could not be read".to_owned(),
                library: "What is on disk could not be read — which is not the same as \
                          nothing being there."
                    .to_owned(),
                export: "Export hands back what this machine holds; ksx could not read it \
                         to say what that is."
                    .to_owned(),
                prove: learn_line(learn),
                wire_blocked: "disabled — this machine's configuration could not be read, \
                               so ksx cannot offer the presets a slot would point at."
                    .to_owned(),
                prove_blocked: prove_blocked_line(session, learn),
                wire_warning: wire_warning_line(session),
                blocking_line: "What the keyboard does while you play could not be read."
                    .to_owned(),
            };
        }

        Self {
            config: if view.config_exists {
                format!(
                    "Configured — {} board(s), {} slot(s), {} preset(s).",
                    view.devices.len(),
                    view.slots.len(),
                    view.presets.len()
                )
            } else {
                "There is no configuration on this machine yet.".to_owned()
            },
            boards: match view.devices.len() {
                0 => "no boards named yet".to_owned(),
                1 => "1 board named:".to_owned(),
                n => format!("{n} boards named:"),
            },
            slots: match view.slots.len() {
                0 => "no slots wired yet".to_owned(),
                1 => "1 slot wired:".to_owned(),
                n => format!("{n} slots wired:"),
            },
            library: format!(
                "{} preset(s) and {} game profile(s) on disk.",
                view.presets.len(),
                view.profiles.len()
            ),
            export: format!(
                "One JSON file: settings, boards, slots, {} game profile(s) and {} preset(s).",
                view.profiles.len(),
                view.presets.len()
            ),
            prove: learn_line(learn),
            wire_blocked: wire_blocked_line(session, view),
            prove_blocked: prove_blocked_line(session, learn),
            wire_warning: wire_warning_line(session),
            blocking_line: blocking_line(view),
        }
    }
}

/// What the keyboard does while a game runs, as one sentence.
///
/// Composed from the SAVED value, and hedged when there is no config yet: an
/// unconfigured machine has a default in memory, and printing that as though
/// somebody had chosen it is the kind of small lie that sends a person looking
/// for a setting they never set.
fn blocking_line(view: &ksx_api::SetupView) -> String {
    if !view.config_exists {
        return "Nothing is configured yet, so there is no answer to this until you finish \
                setting a keyboard up."
            .to_owned();
    }
    match view
        .blocking_options
        .iter()
        .find(|option| option.name == view.blocking)
    {
        Some(option) => format!("{} - {}", option.title, option.detail),
        // A value the roster does not know: an older or hand-edited config.
        // Named rather than smoothed over, because the next session will act
        // on it and a page that showed nothing would leave that invisible.
        None if view.blocking.is_empty() => {
            "This machine's configuration does not say, so ksx will use its default.".to_owned()
        }
        None => format!(
            "This machine's configuration says \"{}\", which this build does not recognise. \
             Pick one below to replace it.",
            view.blocking
        ),
    }
}

/// The learner, as the sentence step 3 reads.
fn learn_line(learn: &crate::control::LearnView) -> String {
    match learn.state.as_str() {
        "listening" => "Listening — press any button on the panel now.".to_owned(),
        "hit" => match learn.device.as_deref() {
            Some(device) => format!("Seen, on {device}."),
            None => "Seen.".to_owned(),
        },
        "unavailable" => learn
            .error
            .clone()
            .unwrap_or_else(|| "the daemon's listener is not available".to_owned()),
        _ if !learn.ok => learn
            .error
            .clone()
            .unwrap_or_else(|| "the daemon's listener is not available".to_owned()),
        _ => {
            "Nothing is listening. Start the listener, then press a button on the panel.".to_owned()
        }
    }
}

/// One reason the wire form is not offered — the one that is actually true.
fn wire_blocked_line(session: &crate::control::SessionView, view: &ksx_api::SetupView) -> String {
    match (session.reachable, view.presets.is_empty()) {
        (true, false) => String::new(),
        (false, true) => "disabled — no daemon is running to take the write, and there is no \
                          preset on disk for a slot to point at. Start the daemon, and import \
                          or create a preset."
            .to_owned(),
        (false, false) => "disabled — wiring a slot is a daemon write, and no daemon is \
                           running. Start it and this control comes back."
            .to_owned(),
        (true, true) => "disabled — a slot points at a preset, and there is not one on disk \
                         yet. Import a configuration below, or run `ksx preset new`."
            .to_owned(),
    }
}

/// One reason the learner is not offered.
fn prove_blocked_line(
    session: &crate::control::SessionView,
    learn: &crate::control::LearnView,
) -> String {
    if !session.reachable {
        return "disabled — the listener lives in the daemon, and no daemon is running. \
                `ksx monitor` does the same job in a shell."
            .to_owned();
    }
    if learn.state == "unavailable" {
        let reason = learn
            .error
            .clone()
            .unwrap_or_else(|| "no reason given".to_owned());
        return format!(
            "disabled — the daemon is running, but its listener is not: {reason}. \
             `ksx monitor` does the same job in a shell."
        );
    }
    String::new()
}

/// What a slot write will do to the pads on THIS session.
fn wire_warning_line(session: &crate::control::SessionView) -> String {
    if session.running {
        "Wiring a slot REPLUGS the pads: every controller vanishes and comes back, and \
         anything mid-game sees it. Bindings do not — those swap in place."
            .to_owned()
    } else {
        "Nothing is running, so nothing replugs — the next start reads the new wiring. Wire \
         a slot while a session IS running and every controller vanishes and comes back."
            .to_owned()
    }
}

/// **Every `createShow` boolean on `/setup`, decided once, in Rust.**
///
/// Same rule and same reason as [`SetupLines`]: the seam injects these into the
/// SSR paint and `SetupIsland.ts` assigns them straight into its signals, so
/// the learner partition and the "is this readable" gate cannot be true on one
/// side of the seam and false on the other.
///
/// The two flash booleans are deliberately NOT here: a flash is one-shot action
/// feedback the client owns (it clears itself on a timer), so it is not a fact
/// about the machine and a poll must never rewrite it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupFlags {
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    pub no_daemon: bool,
    /// The machine provider REFUSED. Everything that would state a fact about
    /// this machine is gated off by it.
    pub setup_down: bool,
    /// The machine provider answered — the gate every inventory row, every
    /// checklist row and every "nothing here yet" sentence sits behind.
    pub setup_known: bool,
    pub first_run: bool,
    pub configured: bool,
    pub can_wire: bool,
    pub cannot_wire: bool,
    pub prove_down: bool,
    pub prove_listening: bool,
    pub prove_hit: bool,
    pub prove_idle: bool,
    pub has_boards: bool,
    pub no_boards: bool,
    pub has_slots: bool,
    pub no_slots: bool,
    pub has_notes: bool,
}

impl SetupFlags {
    pub fn of(
        setup: &SetupSnapshot,
        session: &crate::control::SessionView,
        learn: &crate::control::LearnView,
    ) -> Self {
        let view = &setup.view;
        let available = setup.available;

        // "Can this page write a slot?" is three facts now: a config we could
        // READ, a daemon to take the write, and a preset for the slot to point
        // at. A menu with no options and a live button is the shape that makes
        // a user think they did something.
        let wireable = available && session.reachable && !view.presets.is_empty();

        let listener_down = !session.reachable || learn.state == "unavailable";
        let listening = !listener_down && learn.state == "listening";
        let hit = !listener_down && learn.state == "hit";

        Self {
            pill_running: session.reachable && session.running,
            pill_idle: session.reachable && !session.running,
            pill_down: !session.reachable,
            no_daemon: !session.reachable,
            setup_down: !available,
            setup_known: available,
            first_run: available && !view.config_exists,
            configured: available && view.config_exists,
            can_wire: wireable,
            cannot_wire: !wireable,
            prove_down: listener_down,
            prove_listening: listening,
            prove_hit: hit,
            prove_idle: !listener_down && !listening && !hit,
            // EVERY one of these is `available &&`. Without it a refused read
            // renders "No board has a name yet" — a claim about a machine
            // nothing was read from.
            has_boards: available && !view.devices.is_empty(),
            no_boards: available && view.devices.is_empty(),
            has_slots: available && !view.slots.is_empty(),
            no_slots: available && view.slots.is_empty(),
            has_notes: available && !view.notes.is_empty(),
        }
    }
}

/// One checklist step as the row the page draws.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStepRowView {
    /// "1", "2", "3" — the position, as the badge text.
    pub badge: String,
    pub title: String,
    pub detail: String,
    /// `step done` | `step now` | `step later` — presentation of the BACKEND's
    /// state word, composed here so neither language re-derives it.
    pub cls: String,
}

/// A title-over-detail row (the inventory's boards and slots).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPairRowView {
    pub title: String,
    pub detail: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupOptionRowView {
    pub value: String,
    pub label: String,
}

/// One plain-text row (presets, profiles, notes).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupTextRowView {
    pub text: String,
}

/// **Every list row `/setup` draws, composed once, in Rust** — the same
/// docs/SURFACES.md §1 rule [`SetupLines`] and [`SetupFlags`] already follow,
/// applied to the row and label formatters.
///
/// These used to live twice: `render_setup.rs::list_values` composed
/// "Slot 3 — Panel P1" for the SSR paint and `SetupIsland.ts` composed it
/// again for the two-second poll. Two copies of a SENTENCE drift silently
/// (the Profiles page's `ProfilesDerived` header tells the longer version of
/// this story); now both seams read these rows verbatim and format nothing.
/// One split-or-freeze answer, on the page that edits a SAVED config.
///
/// The same three answers `/start` asks with, from the same
/// `BlockingOption::roster()` - deliberately not a second wording. What differs
/// is only that here the chosen one is a fact about a file, not about a stage.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupBlockingRowView {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub chosen_cls: String,
    pub button: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupRows {
    pub steps: Vec<SetupStepRowView>,
    pub devices: Vec<SetupPairRowView>,
    pub slots: Vec<SetupPairRowView>,
    /// `1..=SetupView::max_slots` — the ceiling the backend serves, never a
    /// literal in either language.
    pub slot_options: Vec<SetupOptionRowView>,
    pub preset_options: Vec<SetupTextRowView>,
    /// Controller identities this build can actually create. The full served
    /// roster remains on [`ksx_api::SetupView::persona_options`] so unavailable
    /// identities are not erased from the contract; this form intentionally
    /// omits them rather than offering a write the daemon must refuse.
    pub persona_options: Vec<SetupOptionRowView>,
    pub profile_options: Vec<SetupTextRowView>,
    pub notes: Vec<SetupTextRowView>,
    /// The split-or-freeze answers, current one marked. Composed here so the
    /// browser never decides which of the three is chosen.
    pub blocking: Vec<SetupBlockingRowView>,
    /// The SOCD `<select>`'s options, served. The blank "leave it as it is"
    /// entry is the FORM's, not a policy, so it is not in here.
    pub socd_options: Vec<SetupOptionRowView>,
}

impl SetupRows {
    /// Compose every row for one read. The only implementation.
    pub fn of(setup: &SetupSnapshot) -> Self {
        let view = &setup.view;
        Self {
            steps: view
                .steps
                .iter()
                .enumerate()
                .map(|(i, step)| SetupStepRowView {
                    badge: (i + 1).to_string(),
                    title: step.title.clone(),
                    detail: step.detail.clone(),
                    cls: format!("step {}", step.state),
                })
                .collect(),
            devices: view
                .devices
                .iter()
                .map(|device| SetupPairRowView {
                    title: device.alias.clone(),
                    detail: format!("{} · {}", device.backend, device.id),
                })
                .collect(),
            slots: view
                .slots
                .iter()
                .map(|slot| SetupPairRowView {
                    title: format!("Slot {} — {}", slot.number, slot.preset),
                    // The SOCD is named ONLY when it is doing something.
                    // "off" is the default and the overwhelming majority of
                    // rows, and a detail line that repeated it on every slot
                    // would bury the one row where it matters.
                    detail: if slot.socd.is_empty() || slot.socd == "off" {
                        format!("{} · {} · {}", slot.device, slot.persona, slot.source)
                    } else {
                        format!(
                            "{} · {} · {} · {}",
                            slot.device, slot.persona, slot.socd, slot.source
                        )
                    },
                })
                .collect(),
            slot_options: (1..=view.max_slots)
                .map(|n| SetupOptionRowView {
                    value: n.to_string(),
                    label: format!("Slot {n}"),
                })
                .collect(),
            preset_options: view
                .presets
                .iter()
                .map(|name| SetupTextRowView { text: name.clone() })
                .collect(),
            persona_options: view
                .persona_options
                .iter()
                .filter(|option| option.can_plug)
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: persona_picker_label(option),
                })
                .collect(),
            profile_options: view
                .profiles
                .iter()
                .map(|title| SetupTextRowView {
                    text: title.clone(),
                })
                .collect(),
            notes: view
                .notes
                .iter()
                .map(|note| SetupTextRowView { text: note.clone() })
                .collect(),
            socd_options: view
                .socd_options
                .iter()
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: option.title.clone(),
                })
                .collect(),
            blocking: view
                .blocking_options
                .iter()
                .map(|option| {
                    let chosen = view.blocking == option.name;
                    SetupBlockingRowView {
                        name: option.name.clone(),
                        title: option.title.clone(),
                        detail: option.detail.clone(),
                        chosen_cls: if chosen {
                            "pill pill-ok".to_owned()
                        } else {
                            "pill pill-none".to_owned()
                        },
                        // The chosen row's button says so rather than inviting a
                        // no-op write; the others say what picking them does.
                        button: if chosen {
                            "This is how it is set".to_owned()
                        } else {
                            option.title.clone()
                        },
                    }
                })
                .collect(),
        }
    }
}

/// What `GET /api/setup` serves AND what the setup island's props carry — the
/// same one-struct-one-serializer rule as [`StatusPayload`], parity pinned in
/// `render_setup.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPayload {
    pub setup: SetupSnapshot,
    pub session: crate::control::SessionView,
    /// Where the daemon's learner stands. This is step 3 — "press a button and
    /// watch it land" — and it is read on every page render, so the no-JS
    /// `<noscript>` refresh shows the press without any client code at all.
    pub learn: crate::control::LearnView,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/setup` — a poll is not an action.
    pub flash: Option<String>,
    /// The page's sentences, composed from the three above. Derived, never
    /// authored: [`SetupPayload::composed`] is what fills it.
    #[serde(default)]
    pub lines: SetupLines,
    /// The page's `createShow` booleans, decided from the three above. Same
    /// rule.
    #[serde(default)]
    pub flags: SetupFlags,
    /// The page's list rows, composed from [`Self::setup`]. Same rule again —
    /// see [`SetupRows`].
    #[serde(default)]
    pub rows: SetupRows,
}

impl SetupPayload {
    /// Recompose [`lines`](Self::lines), [`flags`](Self::flags) and
    /// [`rows`](Self::rows) from this payload's own facts.
    ///
    /// Called on the way OUT — by the render seam and by `/api/setup` — rather
    /// than at construction, so a payload assembled field by field (every test
    /// does, and so does the collector) can never serve sentences that
    /// contradict the facts sitting beside them.
    #[must_use]
    pub fn composed(mut self) -> Self {
        self.lines = SetupLines::of(&self.setup, &self.session, &self.learn);
        self.flags = SetupFlags::of(&self.setup, &self.session, &self.learn);
        self.rows = SetupRows::of(&self.setup);
        self
    }
}

// ───────────────────────────────────────────────────────────────────────────
// /start — the first run, moments 4 to 7 (docs/FIRST-RUN.md)
// ───────────────────────────────────────────────────────────────────────────

/// What `GET /api/start` serves AND what the `/start` island's props carry —
/// the same one-struct-one-serializer rule as [`StatusPayload`], parity pinned
/// in `render_start.rs`.
///
/// **Independent reads keep independent failure states.** They are kept apart for the
/// reason `docs/SURFACES.md` §1b gives: a daemon that is down and a machine
/// with no boards are opposite advice, and collapsing either into an empty
/// value is how a page ends up saying "you have staged nothing" when the truth
/// is "nothing answered". [`Self::staged`] carries its own `reachable` +
/// `error`; [`Self::controller_outputs`] carries per-required-backend read
/// state; the other reads carry theirs beside them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartPayload {
    /// The staged setup, from `ControlSource::staged` — the DAEMON's memory,
    /// not a file. Its own `reachable`/`error` fields say when there is none.
    pub staged: ksx_api::StagedSetupView,
    /// The device enumeration, from `MachineSource::device_scan` — the same
    /// read `/devices` renders.
    pub scan: ksx_api::DeviceScanView,
    pub session: crate::control::SessionView,
    /// Output readiness for exactly the supported personas currently staged,
    /// from `MachineSource::controller_outputs`.
    ///
    /// The machine fact this page cannot get from the daemon or device list,
    /// and the one that decides whether moment 7 can happen: a missing backend
    /// required by a staged persona leaves every authoring step functional but
    /// cannot materialize that controller.
    /// Read-only — `docs/SURFACES.md` §3 marks driver installation `never` for
    /// the browser, and this is how a page obeys that rule and still tells the
    /// truth before the button. ViGEmBus is considered only for staged
    /// Xbox/PlayStation personas; HIDMaestro only for staged DualSense. A
    /// refused read preserves those requirements as unknown, and an installed
    /// HIDMaestro package remains `verified-on-play` rather than false green.
    #[serde(default)]
    pub controller_outputs: ksx_api::ControllerOutputsView,
    /// Empty when the scan answered. Otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// The presets ON DISK, from `MachineSource::presets`. Not what the stage
    /// holds — what a save would land next to, which is the only way this page
    /// can say "a preset of that name is already there" before the click.
    #[serde(default)]
    pub presets: Vec<ksx_api::PresetRow>,
    /// Empty when the preset read answered; otherwise the refusal. Separate
    /// from an empty list, because "no presets yet" is a first run and "I could
    /// not read the presets folder" is a broken install.
    #[serde(default)]
    pub presets_error: String,
    /// The selected keyboard's capture preparation, composed from the staged
    /// selector and the current machine inventory.  The two identifiers are
    /// form values, not presentation copy: the card never prints either one,
    /// and the server revalidates both before it asks the machine provider to
    /// do anything privileged.
    #[serde(default)]
    pub capture: StartCaptureView,
    /// **The logon task**, from `MachineSource::autostart` - `None` when the
    /// read refused, which is NOT the same as "not registered" and must not
    /// render as it.
    #[serde(default)]
    pub autostart_read: Option<ksx_api::AutostartView>,
    /// Empty when the logon read answered; otherwise the refusal.
    #[serde(default)]
    pub autostart_error: String,
    /// The logon card, composed from the two above.
    #[serde(default)]
    pub autostart: StartAutostartView,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/start` — a poll is not an action.
    pub flash: Option<String>,
    /// Backend-owned progress semantics for the persistent four-stage rail.
    /// The browser never infers completion or invents blocker reasons from a
    /// route: these four rows are composed from the same staged/capture/output
    /// facts that gate Save and Play.
    #[serde(default)]
    pub journey: StartJourney,
    /// The page's sentences, composed from the four above. Derived, never
    /// authored — [`StartPayload::composed`] fills it.
    #[serde(default)]
    pub lines: StartLines,
    /// The page's `createShow` booleans, decided from the same four.
    #[serde(default)]
    pub flags: StartFlags,
    /// The page's list rows, same rule again.
    #[serde(default)]
    pub rows: StartRows,
}

impl StartPayload {
    /// Recompose [`lines`](Self::lines), [`flags`](Self::flags) and
    /// [`rows`](Self::rows) from this payload's own facts. Called on the way
    /// OUT, like [`SetupPayload::composed`], so a payload assembled field by
    /// field can never serve sentences that contradict the facts beside them.
    #[must_use]
    pub fn composed(mut self) -> Self {
        self.capture = StartCaptureView::of(&self);
        self.autostart = StartAutostartView::of(&self);
        self.lines = StartLines::of(&self);
        self.flags = StartFlags::of(&self);
        self.rows = StartRows::of(&self);
        self.journey = StartJourney::of(&self);
        self
    }

    /// Is the device enumeration a reading of this machine at all?
    fn scan_read(&self) -> bool {
        self.unavailable.trim().is_empty()
    }
}

/// The scalar-only capture-preparation seam for `/start`.
///
/// This deliberately is not a device row and does not carry a backend field.
/// The browser can confirm the exact selection it was shown, but only the
/// server decides which backend follows an authoritative prepare/release
/// result. `mode` is server-only; the three rendered branches travel through
/// [`StartFlags`] so Forma gets three scalar shows and no new list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartCaptureView {
    pub expected_selector: String,
    pub instance_id: String,
    #[serde(skip)]
    mode: StartCaptureMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum StartCaptureMode {
    #[default]
    None,
    Ready,
    Prepare,
    PrepareOptional,
    Release,
    /// **The machine says prepared; the stage says ordinary Windows path.**
    ///
    /// Reachable the instant a user picks a board ksx is already holding:
    /// `StageEdit::ChooseDevice` always stages `Interception` (the stage is a
    /// pure value and knows nothing about drivers), so choosing an
    /// already-prepared keyboard leaves the two disagreeing.
    ///
    /// It is NOT `Prepare`, which is what this page used to show for it —
    /// "Prepare this keyboard for play" over a keyboard Windows had already
    /// prepared, whose only possible outcome was the provider's
    /// `winusb-already-prepared` refusal telling the user to "use Release",
    /// which the same page then did not draw. That is the 2026-08-11 QA
    /// report, and `docs/FIRST-RUN.md` §6's "a screen reports success while
    /// nothing works" turned inside out: a screen offering the one action that
    /// cannot apply.
    ///
    /// It is not [`Self::Release`] either, because that one counts as READY
    /// and this one must not: a session started on a stage that says
    /// Interception, over an interface that is off the keyboard stack, is the
    /// dead panel this project keeps rediscovering. So it reads as blocked,
    /// says which two facts disagree, and the way out is the held-keyboard
    /// list above it, which releases by identity rather than through the
    /// stage.
    Held,
    Blocked,
}

impl StartCaptureView {
    fn of(payload: &StartPayload) -> Self {
        Self::from_parts(&payload.staged, &payload.scan, payload.scan_read())
    }

    /// The ONE capture-mode derivation, shared by `/start`'s card and
    /// `/nocturne`'s prepared-for-play control. Extracted rather than copied
    /// when the keyboard backend migrated (2026-08-17): two mode machines
    /// would eventually disagree about the same physical keyboard.
    pub(crate) fn from_parts(
        staged: &ksx_api::StagedSetupView,
        scan: &ksx_api::DeviceScanView,
        scan_read: bool,
    ) -> Self {
        let Some(device) = staged.device.as_ref() else {
            return Self::default();
        };
        if !staged.reachable {
            return Self::default();
        }
        if !scan_read {
            return Self::blocked(device.selector.clone());
        }

        // A selector chosen from the served inventory should name one board.
        // Re-check that invariant instead of taking the first match: a stale
        // or malformed inventory must remove the action, never retarget it.
        let mut matches = scan
            .boards
            .iter()
            .filter(|board| board.selector.as_deref() == Some(device.selector.as_str()));
        let Some(board) = matches.next() else {
            return Self::blocked(device.selector.clone());
        };
        if matches.next().is_some() {
            return Self::blocked(device.selector.clone());
        }
        let Some(instance_id) = board.keyboard.as_ref() else {
            return Self::blocked(device.selector.clone());
        };
        if scan
            .boards
            .iter()
            .flat_map(|candidate| candidate.interfaces.iter())
            .filter(|row| row.instance_id.eq_ignore_ascii_case(instance_id))
            .count()
            != 1
        {
            return Self::blocked(device.selector.clone());
        }

        // These are the two canonical wire spellings accepted by StageEdit.
        // They are server-owned constants; no browser field selects either.
        let backend = device.backend.as_str();
        let interception = "interception";
        let winusb = "winusb";
        let interception_ready = backend == interception
            && scan.interception_available
            && board.interception_eligible
            && board.can_type
            && !board.claimed;
        let mode = if interception_ready && board.winusb_eligible {
            // The optional built-in path must remain reachable even when a
            // shared Interception install happens to make this machine work.
            // It is an option, not a readiness blocker.
            StartCaptureMode::PrepareOptional
        } else if interception_ready {
            StartCaptureMode::Ready
        } else if backend == winusb && board.winusb_eligible && board.claimed {
            StartCaptureMode::Release
        } else if board.claimed {
            // **The machine's answer wins over the stage's.** `claimed` is read
            // from the live device tree; `backend` is what this visit's staged
            // value happens to say. When they disagree the board is still off
            // the keyboard stack, and a card that offered Prepare here would be
            // offering the one action the provider refuses.
            StartCaptureMode::Held
        } else if (backend == interception || backend == winusb) && board.winusb_eligible {
            StartCaptureMode::Prepare
        } else {
            StartCaptureMode::Blocked
        };
        Self {
            expected_selector: device.selector.clone(),
            instance_id: instance_id.clone(),
            mode,
        }
    }

    fn blocked(expected_selector: String) -> Self {
        Self {
            expected_selector,
            mode: StartCaptureMode::Blocked,
            ..Self::default()
        }
    }

    pub(crate) fn ready(&self) -> bool {
        matches!(
            self.mode,
            StartCaptureMode::Ready | StartCaptureMode::PrepareOptional | StartCaptureMode::Release
        )
    }

    /// The mode as a stable word, for derivations OUTSIDE this module
    /// (`NocturneDerived`) that need the full seven-way answer without the
    /// private enum crossing the boundary.
    pub(crate) fn mode_word(&self) -> &'static str {
        match self.mode {
            StartCaptureMode::None => "none",
            StartCaptureMode::Ready => "ready",
            StartCaptureMode::Prepare => "prepare",
            StartCaptureMode::PrepareOptional => "prepare-optional",
            StartCaptureMode::Release => "release",
            StartCaptureMode::Held => "held",
            StartCaptureMode::Blocked => "blocked",
        }
    }

    fn prepare(&self) -> bool {
        matches!(
            self.mode,
            StartCaptureMode::Prepare | StartCaptureMode::PrepareOptional
        )
    }

    fn release(&self) -> bool {
        self.mode == StartCaptureMode::Release
    }

    /// The warn card, which [`StartCaptureMode::Held`] shares with
    /// [`StartCaptureMode::Blocked`]: both are "no action here", both are
    /// not-ready, and the wording — not a second island branch — is what makes
    /// them different sentences.
    fn blocked_state(&self) -> bool {
        matches!(
            self.mode,
            StartCaptureMode::Blocked | StartCaptureMode::Held
        )
    }
}

/// **Every sentence `/start` states as a fact, composed once, in Rust.**
///
/// Same rule and same reason as [`SetupLines`]: the SSR paint and the island's
/// poll show identical words because there is one implementation of them. The
/// island assigns these to signals and composes nothing.
///
/// What is deliberately NOT here: the split-or-freeze wording, the escape hatch
/// and the per-session scope. Those are `ksx_api::BlockingOption::roster()`,
/// `ESCAPE_HATCH_LINE` and `BLOCKING_SCOPE_LINE` — `docs/FIRST-RUN.md` §3 is a
/// question about what the CAPTURE THREAD does, so its words belong beside the
/// type that answers it and not on the one screen that currently asks.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartLines {
    /// The keyboard step's heading line — chosen, or what to do about it.
    pub device_line: String,
    /// The chosen board's id, as SMALL PRINT. `FIRST-RUN.md` §5: the path
    /// belongs in small print for support, never as the identifier on screen.
    pub device_detail: String,
    /// `scan.boards_summary`, verbatim — the one line that distinguishes "no
    /// keyboard-capable board" from "nothing could be read".
    pub boards_line: String,
    /// The held-keyboard banner's heading and sentence. Empty when nothing on
    /// this machine is held — the banner is a fact about the DEVICE TREE, so
    /// it appears on a fresh install with no config and no staged setup, which
    /// is the state it exists for.
    #[serde(default)]
    pub prepared_heading: String,
    #[serde(default)]
    pub prepared_line: String,
    /// Customer copy for the scalar capture-preparation card. Exact instance
    /// ids and provider/helper messages never enter these fields.
    pub capture_heading: String,
    pub capture_line: String,
    pub capture_detail: String,
    pub capture_prepare_cls: String,
    pub capture_button_cls: String,
    pub capture_button: String,
    /// The controller step's line: how many are staged and what that costs.
    pub controller_line: String,
    /// The XInput occupancy, from the SERVED numbers.
    pub xinput_line: String,
    /// Where the one question stands: the answer, or that it has not been
    /// asked. Never a pre-selected default — §3.
    pub blocking_line: String,
    /// What the mapper edits and where the staged preset stands relative to
    /// the presets on disk.
    pub preset_line: String,
    /// **What the mapper is, beside the link to it.** The one sentence that
    /// keeps "I mapped it in the mapper" from meaning "Play here will use
    /// that" — see [`MAPPER_LINE`].
    pub mapper_line: String,
    /// Ready to save or play, or a customer-facing next step selected from the
    /// staged facts. Raw domain refusals remain support data.
    pub ready_line: String,
    /// Save and Play have different prerequisites. Save needs a complete
    /// staged setup and capture path; controller output is irrelevant because
    /// saving plugs nothing. Play additionally needs a readable, non-blocked
    /// output view. These separate lines keep a driver problem from making a
    /// valid setup look unsaveable.
    #[serde(default)]
    pub save_status: String,
    #[serde(default)]
    pub play_status: String,
    /// The output banner's heading. What the SENTENCES say is
    /// `ksx_api::ControllerOutputsView`'s and arrives composed; what this page decides is
    /// how to introduce it — "cannot" and "could not be checked" are two
    /// different headings and a page that used one for both would be asserting
    /// the machine's state from a read that failed.
    pub bus_heading: String,
    /// The banner's class: red for a bus that is known not to work, amber for
    /// one nothing could be learned about. Served rather than derived in
    /// TypeScript for the reason every other `_cls` on this page is
    /// (`StartBoardRow::caveat_cls`): the severity is a judgement, and
    /// judgements are the backend's.
    pub bus_cls: String,
    /// What pressing Play actually does — moment 7's first sentence.
    pub play_line: String,
    /// Moment 7's one fact about the pad itself.
    pub guide_line: String,
    /// The always-available way to stop Play, in customer language.
    #[serde(default)]
    pub escape_line: String,
    /// Which keyboards and how long the split/freeze answer affects.
    #[serde(default)]
    pub scope_line: String,
    /// The daemon refusal that makes staging impossible, if any.
    pub stage_error: String,
    /// The scan refusal, if any.
    pub scan_error: String,
    /// The preset-read refusal, if any.
    pub presets_error: String,
}

impl StartLines {
    /// Compose every line for one payload. The only implementation.
    pub fn of(p: &StartPayload) -> Self {
        let staged = &p.staged;
        Self {
            device_line: match (&staged.device, staged.reachable) {
                (Some(device), _) => format!(
                    "Using {} for this setup. You can change it before Save or Play.",
                    device.label
                ),
                (None, true) => {
                    "Pick the keyboard you want to play with. Nothing happens when you pick it: \
                     it is remembered for this visit and written only if you save."
                        .to_owned()
                }
                // No daemon: the list below is still a real reading of the
                // machine, so the sentence is about the button, not the boards.
                (None, false) => "The background helper is not ready, so Setup cannot remember a \
                                  keyboard yet. Close and reopen ksx; your devices have not been \
                                  changed."
                    .to_owned(),
            },
            device_detail: match &staged.device {
                Some(device) if device.survives_replug => format!(
                    "{} is selected for this setup. You can unplug it, move it to another USB \
                     socket, or pick a different device before Save or Play.",
                    device.label
                ),
                Some(device) => format!(
                    "{} is selected for this setup. Keep it in this USB socket, or pick it again \
                     after moving it. You can change your mind before Save or Play.",
                    device.label
                ),
                None => String::new(),
            },
            boards_line: p.scan.boards_summary.clone(),
            prepared_heading: PREPARED_HEADING.to_owned(),
            prepared_line: prepared_line(p),
            capture_heading: capture_heading(&p.capture).to_owned(),
            capture_line: capture_line(&p.capture).to_owned(),
            capture_detail: capture_detail(&p.capture).to_owned(),
            capture_prepare_cls: capture_prepare_cls(&p.capture).to_owned(),
            capture_button_cls: capture_button_cls(&p.capture).to_owned(),
            capture_button: capture_button(&p.capture).to_owned(),
            controller_line: controller_line(staged),
            xinput_line: format!(
                "{} of {} available Xbox-style controller places would be used. Additional \
                 players use PlayStation-style controllers, which supported games can read.",
                staged.xinput_used, staged.max_xinput_slots
            ),
            blocking_line: match &staged.blocking {
                Some(name) => match staged.blocking_options.iter().find(|o| &o.name == name) {
                    Some(chosen) => format!("Answered: {}.", chosen.title),
                    // Do not reflect an unknown wire value into primary copy.
                    // The served choices below are the safe way to repair it.
                    None => "This keyboard choice could not be checked. Pick Freeze, Split, or \
                             Take nothing again before saving or playing."
                        .to_owned(),
                },
                None => "Not asked yet. There is no default here on purpose: a screen showing one \
                         option pre-selected has answered the question for you."
                    .to_owned(),
            },
            preset_line: preset_line(p),
            mapper_line: MAPPER_LINE.to_owned(),
            bus_heading: bus_heading(&p.controller_outputs).to_owned(),
            bus_cls: bus_cls(&p.controller_outputs).to_owned(),
            ready_line: play_status(p),
            save_status: save_status(p),
            play_status: play_status(p),
            play_line: PLAY_LINE.to_owned(),
            guide_line: GUIDE_LINE.to_owned(),
            escape_line: ESCAPE_LINE.to_owned(),
            scope_line: SCOPE_LINE.to_owned(),
            stage_error: if staged.error.is_some() {
                "The background helper did not answer. Close and reopen ksx; if this keeps \
                 happening, contact support and include the Technical details shown here. \
                 Nothing has been changed."
                    .to_owned()
            } else {
                String::new()
            },
            scan_error: p.unavailable.trim().to_owned(),
            presets_error: p.presets_error.trim().to_owned(),
        }
    }
}

fn setup_prerequisite(payload: &StartPayload) -> Option<String> {
    let staged = &payload.staged;
    if !staged.reachable {
        return Some(
            "Setup is temporarily unavailable. Close and reopen ksx; nothing has been changed."
                .to_owned(),
        );
    }
    if staged.device.is_none() {
        return Some("Choose a keyboard before saving or playing.".to_owned());
    }
    if !payload.capture.ready() {
        return Some(if payload.capture.prepare() {
            "Prepare the selected keyboard before saving or playing.".to_owned()
        } else {
            "The selected keyboard is not ready for capture. Follow the highlighted keyboard \
             guidance before saving or playing."
                .to_owned()
        });
    }
    if staged.slots.is_empty() {
        return Some("Add at least one controller before saving or playing.".to_owned());
    }
    if let Some(slot) = staged.slots.iter().find(|slot| slot.bindings == 0) {
        return Some(format!(
            "Player {} has no controls yet. Choose a ready-made layout or open Controls before \
             saving or playing.",
            slot.number
        ));
    }
    if staged.blocking.is_none() {
        return Some(
            "Choose whether this keyboard should freeze or keep typing before saving or playing."
                .to_owned(),
        );
    }
    if !staged.ready {
        return Some("Finish the highlighted Setup choices before saving or playing.".to_owned());
    }
    None
}

/// One rail destination. `cls` is presentation state only; `badge` is its
/// glanceable word and `detail` is the full accessible explanation rendered
/// beside the destination for assistive technology.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartJourneyStep {
    pub cls: String,
    pub badge: String,
    pub detail: String,
}

/// Truthful progress for the four-stage setup journey.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartJourney {
    pub keyboard: StartJourneyStep,
    pub controller: StartJourneyStep,
    pub mapping: StartJourneyStep,
    pub play: StartJourneyStep,
}

impl StartJourneyStep {
    fn new(base: &str, state: &str, badge: &str, detail: String) -> Self {
        Self {
            cls: if state.is_empty() {
                format!("navlink workflow-link {base}")
            } else {
                format!("navlink workflow-link {base} workflow-{state}")
            },
            badge: badge.to_owned(),
            detail,
        }
    }
}

impl StartJourney {
    fn of(p: &StartPayload) -> Self {
        let staged = &p.staged;
        let keyboard_complete = staged.device.is_some();
        let keyboard = if keyboard_complete {
            StartJourneyStep::new(
                "workflow-keyboard",
                "complete",
                "done",
                "Keyboard complete: one physical keyboard is selected.".to_owned(),
            )
        } else if !staged.reachable
            || !p.scan_read()
            || (!p.flags.has_boards && !p.flags.has_experimental)
        {
            StartJourneyStep::new(
                "workflow-keyboard",
                "blocked",
                "blocked",
                format!("Keyboard blocked: {}", p.lines.device_line),
            )
        } else {
            StartJourneyStep::new(
                "workflow-keyboard",
                "pending",
                "next",
                "Keyboard next: choose the physical keyboard you want to play with.".to_owned(),
            )
        };

        let controller_complete = keyboard_complete && !staged.slots.is_empty();
        let controller = if controller_complete {
            StartJourneyStep::new(
                "workflow-controller",
                "complete",
                "done",
                format!(
                    "Controller complete: {} virtual controller{} staged.",
                    staged.slots.len(),
                    if staged.slots.len() == 1 { "" } else { "s" }
                ),
            )
        } else if !keyboard_complete {
            StartJourneyStep::new(
                "workflow-controller",
                "upcoming",
                "waiting",
                "Controller waiting: choose a keyboard first.".to_owned(),
            )
        } else if p.flags.can_add {
            StartJourneyStep::new(
                "workflow-controller",
                "pending",
                "next",
                "Controller next: add at least one virtual controller.".to_owned(),
            )
        } else {
            StartJourneyStep::new(
                "workflow-controller",
                "blocked",
                "blocked",
                format!("Controller blocked: {}", p.lines.controller_line),
            )
        };

        let unmapped = staged.slots.iter().find(|slot| slot.bindings == 0);
        let mapping_complete = staged.ready;
        let mapping = if mapping_complete {
            StartJourneyStep::new(
                "workflow-mapping",
                "complete",
                "done",
                "Mapping complete: controls and keyboard behavior are ready.".to_owned(),
            )
        } else if !controller_complete {
            StartJourneyStep::new(
                "workflow-mapping",
                "upcoming",
                "waiting",
                "Mapping waiting: create a controller first.".to_owned(),
            )
        } else if p.flags.can_layout || staged.blocking.is_none() {
            let detail = unmapped.map_or_else(
                || "Mapping next: choose how the keyboard behaves while playing.".to_owned(),
                |slot| {
                    format!(
                        "Mapping next: Player {} needs at least one mapped control.",
                        slot.number
                    )
                },
            );
            StartJourneyStep::new("workflow-mapping", "pending", "next", detail)
        } else {
            StartJourneyStep::new(
                "workflow-mapping",
                "blocked",
                "blocked",
                format!("Mapping blocked: {}", p.lines.save_status),
            )
        };

        let play = if p.session.reachable && p.session.running {
            StartJourneyStep::new(
                "workflow-play",
                "live",
                "active",
                "Play active: a gameplay session is starting or running.".to_owned(),
            )
        } else if p.flags.can_play {
            StartJourneyStep::new(
                "workflow-play",
                "ready",
                "ready",
                "Play ready: this staged setup can start.".to_owned(),
            )
        } else if staged.ready {
            StartJourneyStep::new(
                "workflow-play",
                "blocked",
                "blocked",
                format!("Play blocked: {}", p.lines.play_status),
            )
        } else {
            StartJourneyStep::new(
                "workflow-play",
                "upcoming",
                "waiting",
                format!("Play waiting: {}", p.lines.play_status),
            )
        };

        Self {
            keyboard,
            controller,
            mapping,
            play,
        }
    }
}

fn save_status(payload: &StartPayload) -> String {
    match setup_prerequisite(payload) {
        Some(problem) => problem,
        None => "Ready to save. Saving keeps this setup for later and starts nothing.".to_owned(),
    }
}

fn play_status(payload: &StartPayload) -> String {
    if let Some(problem) = setup_prerequisite(payload) {
        return problem;
    }
    if payload.controller_outputs.blocked {
        return "This setup is ready to save, but Play cannot create every staged controller \
                until the highlighted controller-output problem is repaired."
            .to_owned();
    }
    if payload.controller_outputs.unknown {
        return "This setup is ready to save, but controller output could not be checked. Reopen \
                ksx or use the advanced driver check before Play."
            .to_owned();
    }
    if payload.controller_outputs.verified_on_play {
        return "Ready. Save keeps this setup for later; Play verifies the DualSense endpoint \
                while starting it and saves nothing."
            .to_owned();
    }
    "Ready. Save keeps this setup for later; Play starts it without saving.".to_owned()
}

/// **Every board this machine is holding that the capture card is not already
/// offering to release** — the one list on this page that does not go through
/// the staged setup.
///
/// The filter is `BoardRow::claimed`, read from the live device tree. It is
/// therefore independent of `config.toml` (a board can be held with no
/// `[[device]]` entry naming it: the binding is Windows's and the receipt is
/// under ProgramData, and neither is the config root) and independent of the
/// stage (a fresh visit stages nothing at all). Both of those are the bug: on
/// the QA build the ONLY release control was the staged device's card, so a
/// held keyboard was invisible on a fresh install, invisible after choosing a
/// different keyboard, and invisible after choosing itself — because
/// `ChooseDevice` stages the Interception backend and the card keyed Release
/// off that.
///
/// The one exclusion is the board the capture card IS already offering to
/// release, so the page never draws the same action twice.
fn held_boards(p: &StartPayload) -> Vec<&ksx_api::BoardRow> {
    // A refused scan is not a machine with nothing held (`SURFACES.md` §1b).
    // The banner stays silent and the scan's own failure banner speaks.
    if !p.scan_read() {
        return Vec::new();
    }
    let offered = p
        .capture
        .release()
        .then_some(p.capture.expected_selector.as_str());
    p.scan
        .boards
        .iter()
        .filter(|board| board.claimed)
        .filter(|board| offered.is_none() || board.selector.as_deref() != offered)
        .collect()
}

/// Compose one [`StartPreparedRow`].
///
/// The identity guards are the SAME two the capture card applies and the
/// server re-applies before elevating: one board answering to this selector,
/// one interface answering to this instance. A row that fails either is still
/// DRAWN — a keyboard that cannot type must never be missing from the list of
/// keyboards that cannot type — and loses only its button, with the sentence
/// that says what to do instead.
fn prepared_row(p: &StartPayload, board: &ksx_api::BoardRow) -> StartPreparedRow {
    let selector = board.selector.clone().unwrap_or_default();
    let instance_id = board.keyboard.clone().unwrap_or_default();
    let twins = p
        .scan
        .boards
        .iter()
        .filter(|other| {
            !selector.is_empty() && other.selector.as_deref() == Some(selector.as_str())
        })
        .count();
    let interfaces = p
        .scan
        .boards
        .iter()
        .flat_map(|other| other.interfaces.iter())
        .filter(|row| !instance_id.is_empty() && row.instance_id.eq_ignore_ascii_case(&instance_id))
        .count();
    let note = if selector.is_empty() || instance_id.is_empty() {
        "ksx cannot identify one exact interface on this board right now, so it will not offer \
         to release the wrong one. Reconnect it and Rescan."
            .to_owned()
    } else if twins != 1 || interfaces != 1 {
        "Another connected device answers to the same identity, so ksx will not guess which one \
         to give back. Unplug the other one, then Rescan."
            .to_owned()
    } else {
        String::new()
    };
    StartPreparedRow {
        name: board.name.clone(),
        transport: board.transport_label.clone(),
        detail: "It cannot type to Windows while ksx is holding it. Giving it back opens a \
                 Windows permission prompt and changes nothing else in this setup."
            .to_owned(),
        path: instance_id.clone(),
        selector,
        instance_id,
        note_cls: hidden_when_empty(&note, "dv-warn"),
        form_cls: if note.is_empty() {
            "capture-form".to_owned()
        } else {
            "capture-form dv-hide".to_owned()
        },
        note,
    }
}

/// The held-keyboard banner's heading, named because three places have to
/// agree on it: this banner, [`capture_detail`]'s `Held` sentence, which sends
/// the reader here by name, and the layout test that proves both are on the
/// page at once.
pub const PREPARED_HEADING: &str = "Keyboards ksx is holding";

/// **The sentence a user with a dead keyboard needs, before anything else.**
///
/// Composed from the count alone, and deliberately says the two things that
/// are not guessable: that the state survives everything a user would try
/// (closing ksx, rebooting, starting Setup over — it is a Windows driver
/// binding plus a receipt under ProgramData, neither of which is this or any
/// config), and that the button below undoes it. Before this existed the only
/// documented way out of it was `docs/RECOVERY.md` and an elevated shell,
/// which `docs/FIRST-RUN.md` §6 lists as a thing that must never happen.
fn prepared_line(p: &StartPayload) -> String {
    match held_boards(p).len() {
        0 => String::new(),
        1 => "One keyboard on this computer is currently held by ksx, so it cannot type to \
              Windows. That lasts until it is given back — closing ksx, restarting the computer \
              or starting Setup over does not undo it."
            .to_owned(),
        n => format!(
            "{n} keyboards on this computer are currently held by ksx, so they cannot type to \
             Windows. That lasts until they are given back — closing ksx, restarting the \
             computer or starting Setup over does not undo it."
        ),
    }
}

fn capture_heading(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare => "Prepare this keyboard for play",
        StartCaptureMode::PrepareOptional => "Use KSX’s built-in Windows USB mode",
        StartCaptureMode::Release => "This keyboard is prepared for ksx",
        StartCaptureMode::Held => "ksx is already holding this keyboard",
        StartCaptureMode::Blocked => "This keyboard is not ready for capture",
        StartCaptureMode::None | StartCaptureMode::Ready => "",
    }
}

fn capture_line(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare => {
            "Windows needs to prepare only the keyboard you selected before ksx can use it. \
             This takes it out of normal typing until you release it here."
        }
        StartCaptureMode::PrepareOptional => {
            "This keyboard is ready through a shared optional capture driver. You can keep that \
             mode, or prepare this exact USB keyboard for KSX’s built-in Windows USB mode."
        }
        StartCaptureMode::Release => {
            "Windows has prepared this selected keyboard for ksx, and capture is ready. It will \
             not type as a normal keyboard while it stays prepared."
        }
        StartCaptureMode::Held => {
            "Windows has already given this keyboard to ksx, so it cannot type. This setup is \
             still set to use the ordinary Windows path, which cannot read a keyboard ksx is \
             holding — so it is not ready to play as it stands."
        }
        StartCaptureMode::Blocked => {
            "ksx could not verify one exact, supported keyboard interface for the current \
             selection. Nothing was prepared and the setup was not changed."
        }
        StartCaptureMode::None | StartCaptureMode::Ready => "",
    }
}

fn capture_detail(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare | StartCaptureMode::PrepareOptional => {
            "Keep a different keyboard connected and test that it can type. Continuing opens a \
             Windows permission prompt and installs a machine-local certificate used only to \
             sign this computer's generated device package. Windows matches that package by \
             keyboard model, so release it here before connecting another identical keyboard."
        }
        StartCaptureMode::Release => {
            "If another identical keyboard was connected later, unplug it first so this exact \
             selection stays unambiguous. Release removes the shared Windows package and returns \
             this keyboard to ordinary typing; the twin returns when reconnected. Your unsaved \
             controller choices stay on this screen. ksx then rechecks capture before Play."
        }
        StartCaptureMode::Held => {
            "Use “Give this keyboard back to Windows” in Keyboards ksx is holding, at the top of \
             this page, to return it to ordinary typing. That works whichever keyboard is \
             selected here, and it does not change your controller choices."
        }
        StartCaptureMode::Blocked => {
            "Built-in preparation supports one exact USB keyboard. Reconnect or choose a \
             supported USB keyboard, then Rescan. Bluetooth keyboard capture is not available \
             on a clean install."
        }
        StartCaptureMode::None | StartCaptureMode::Ready => "",
    }
}

fn capture_prepare_cls(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare => "card wide capture-card warnbox",
        StartCaptureMode::PrepareOptional => "card wide capture-card",
        _ => "",
    }
}

fn capture_button_cls(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare => "btn btn-primary",
        StartCaptureMode::PrepareOptional => "btn",
        _ => "",
    }
}

fn capture_button(capture: &StartCaptureView) -> &'static str {
    match capture.mode {
        StartCaptureMode::Prepare => "Prepare selected keyboard",
        StartCaptureMode::PrepareOptional => "Use built-in USB mode",
        _ => "",
    }
}

/// **What the mapper is, said beside the link to it.**
///
const MAPPER_LINE: &str =
    "Controls lets you choose each controller button and the keyboard key that activates it. \
     Changes return here immediately. The keyboard and this setup stay untouched until you \
     choose Play or Save.";

/// **What Play does**, stated before the button rather than after it.
///
/// The two halves are the ones a first-run user has no way to predict: one pad
/// appears through each persona's routed output backend (so a game finds a
/// controller that was not there a second ago) and their keyboard changes
/// behaviour (which, under Freeze, means it stops typing). Both are reversible
/// and the sentence says how — Stop, or the escape latch, which is the same one
/// §3's card carries.
const PLAY_LINE: &str =
    "Play makes one game controller for each controller above and uses the keyboard you picked \
     to operate them. Stop removes those game controllers and returns the keyboard to normal — \
     Left Ctrl five times temporarily frees or recaptures the keyboard without removing the game \
     controllers.";

const ESCAPE_LINE: &str =
    "Press Left Ctrl five times at any time to toggle keyboard capture off or on. Turning it off \
     returns every keyboard to normal without ending Play, even if the app window is closed; use \
     Stop or Ctrl+Alt+Del to end Play.";

const SCOPE_LINE: &str =
    "This choice applies only to the keyboard you picked and only while Play is active. Other \
     keyboards on this PC are not affected.";

/// Moment 7's Windows-owned prerequisite.
///
/// `ksx_core::pad::XButton::Guide` already exists and every persona publishes
/// it; whether Windows answers it is a per-user Game Bar setting, not something
/// ksx controls. Composed here rather than in `ksx-api` because it is a sentence
/// about this SCREEN's last step, and no other surface has that step yet. The
/// day the cabinet grows one, it moves — the same way §3's wording already lives
/// in `ksx-api`.
const GUIDE_LINE: &str =
    "GUIDE can ask Windows to open Xbox Game Bar only when Game Bar is available and “Allow your \
     controller to open Game Bar” is turned on in Windows Settings > Gaming > Game Bar. ksx does \
     not change that Windows setting.";

/// The output banner's heading, and the only place this page words the
/// difference between the two reasons it appears.
///
/// A `blocked` bus is a statement about the machine and reads like one. An
/// `unknown` one is a statement about this page's own read — `SURFACES.md` §1b
/// — and must never borrow the first heading, because "ksx cannot plug a
/// controller" is a claim nothing here is entitled to make.
///
/// A fully preflighted requirement set gets the EMPTY string, not the nearest
/// of the three. The banner is hidden either way (`StartFlags::bus_warn`), but the payload block is
/// served verbatim to the island and to `/api/start`, so a heading left lying
/// in it would be a sentence about a machine that is fine, saying it is not.
fn bus_heading(outputs: &ksx_api::ControllerOutputsView) -> &'static str {
    match (outputs.blocked, outputs.unknown, outputs.verified_on_play) {
        (true, _, _) => "Play cannot plug a controller on this machine yet",
        (_, true, _) => "The required controller output could not be checked",
        (_, _, true) => "DualSense is verified when Play starts",
        _ => "",
    }
}

/// Red for a bus that is known not to work, amber for one nothing is known
/// about, and nothing at all for a healthy one — same rule as
/// [`bus_heading`]. Both banners are `.card.alarm`; `.alarm.warn` is the amber
/// variant (`studio.css` §4.9). The deferred HIDMaestro check is amber too:
/// it is neither a false green nor a known failure.
fn bus_cls(outputs: &ksx_api::ControllerOutputsView) -> &'static str {
    match (outputs.blocked, outputs.unknown, outputs.verified_on_play) {
        (true, _, _) => "card alarm",
        (_, true, _) | (_, _, true) => "card alarm warn",
        _ => "",
    }
}

fn controller_line(staged: &ksx_api::StagedSetupView) -> String {
    let base = match staged.slots.len() {
        0 => format!(
            "Pick what the keyboard should become. Nothing is plugged and nothing is written — \
             changing your mind costs a click. Up to {} controllers.",
            staged.max_slots
        ),
        1 => "1 controller is ready to customize. It is still only on this screen, and Remove \
              leaves no trace."
            .to_owned(),
        n => format!(
            "{n} controllers are ready to customize. They are still only on this screen, and \
             Remove leaves no trace."
        ),
    };
    let capacity = staged
        .personas
        .iter()
        .filter(|persona| persona.can_plug && !persona.available)
        .filter_map(|persona| persona.unavailable_reason.as_deref())
        .collect::<Vec<_>>();
    if capacity.is_empty() {
        base
    } else {
        format!("{base} {}", capacity.join(" "))
    }
}

/// A persona picker says both the public identity and the immutable output
/// route. A per-session ceiling belongs in the option too: it is useful before
/// the first pick, while [`ksx_api::PersonaOption::available`] prevents an impossible
/// later pick from appearing at all.
fn persona_picker_label(option: &ksx_api::PersonaOption) -> String {
    let backend = if option.backend_label.trim().is_empty() {
        option.backend.as_str()
    } else {
        option.backend_label.as_str()
    };
    match option.instance_limit {
        Some(1) => format!("{} · {} · one per session", option.label, backend),
        Some(limit) => format!("{} · {} · up to {limit} per session", option.label, backend),
        None if backend.trim().is_empty() => option.label.clone(),
        None => format!("{} · {}", option.label, backend),
    }
}

/// What the mapper step can honestly say, which depends on whether the presets
/// were readable at all.
///
/// The failed-read arm is the point: a preset name that "is not on disk" is a
/// claim about the presets folder, and when the read refused nothing is known
/// about it. Saying "this will create it" there is `SURFACES.md` §1b's bug.
fn preset_line(p: &StartPayload) -> String {
    const LEAD: &str = "Start from a ready-made layout, then open Controls to change individual \
                        buttons, add alternate keys, set auto-fire, or build macros. Every edit \
                        stays in this setup until you choose Save; Play uses it immediately \
                        without saving.";
    if !p.presets_error.trim().is_empty() {
        return format!(
            "{LEAD} Existing saved setups could not be checked, so ksx cannot yet say whether \
             Save would replace one with the same name."
        );
    }
    let clashes: Vec<&str> = p
        .staged
        .slots
        .iter()
        .filter(|slot| {
            p.presets
                .iter()
                .any(|row| row.name.eq_ignore_ascii_case(&slot.preset))
        })
        .map(|slot| slot.preset.as_str())
        .collect();
    if clashes.is_empty() {
        return format!("{LEAD} These controller names are new, so Save will create them.");
    }
    format!(
        "{LEAD} {} already has a saved version. Save will replace it while keeping a recovery \
         copy.",
        clashes.join(", ")
    )
}

/// **Every `createShow` boolean on `/start`, decided once, in Rust.**
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartFlags {
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    /// The staged setup could not be reached — every verb on the page is inert
    /// and the banner says why.
    pub stage_down: bool,
    /// The device scan refused. NOT the same as an empty machine.
    pub scan_down: bool,
    /// The preset read refused.
    pub presets_down: bool,
    /// **A required output needs saying before the Play button.** Known
    /// blockers, unknown reads, and HIDMaestro's Play-time verification are
    /// distinct states. False only when no backend is required or every
    /// required backend is fully preflighted.
    pub bus_warn: bool,
    /// A keyboard is staged.
    pub has_device: bool,
    /// **This machine is holding at least one keyboard the capture card is not
    /// already offering to release.** Read off the device tree, so it is true
    /// on a machine with no config and an empty stage — which is exactly the
    /// state where the only release control used to be unreachable.
    #[serde(default)]
    pub has_prepared: bool,
    /// The three mutually exclusive scalar branches of the capture card.
    pub capture_prepare: bool,
    pub capture_release: bool,
    pub capture_blocked: bool,
    /// Keyboard-shaped boards that can be picked on the ordinary path.
    pub has_boards: bool,
    /// Pickable HID devices that do not identify themselves as keyboards.
    /// These stay available as an explicit playground, never mixed into the
    /// ordinary keyboard list.
    pub has_experimental: bool,
    /// **The enumeration ANSWERED and found no keyboard-capable board.** The
    /// only flag that licenses the "there is nothing here" paragraph; false
    /// whenever the list is empty because nothing could be read.
    pub no_boards: bool,
    /// Boards with no keyboard interface, listed so "why is my device not
    /// here" has an answer.
    pub has_other: bool,
    pub has_notes: bool,
    /// Controllers are staged.
    pub has_slots: bool,
    /// A controller can still be added (a free slot AND a persona to put in
    /// it AND a keyboard to drive it).
    pub can_add: bool,
    /// Every slot is taken — the ceiling, said before the button vanishes.
    pub slots_full: bool,
    /// Personas this build cannot plug, listed with the reason.
    pub has_gaps: bool,
    /// A staged controller can be dressed in a layout — there is one to dress
    /// and a daemon to hold the result.
    pub can_layout: bool,
    /// §3 has been answered.
    pub blocking_answered: bool,
    /// Save and Play deliberately have different gates. Controller-output
    /// readiness affects Play only: committing the staged files is safe and
    /// useful even on a machine whose required driver is missing or unread.
    #[serde(default)]
    pub can_save: bool,
    #[serde(default)]
    pub can_play: bool,
    #[serde(default)]
    pub cannot_save: bool,
    #[serde(default)]
    pub cannot_play: bool,
    /// Compatibility pair for the current island while it migrates to the
    /// split shows. They mirror Save's gate so a driver problem never hides a
    /// valid Save action; the server independently guards Play with `can_play`.
    pub ready: bool,
    pub not_ready: bool,
    /// Anything at all is staged, so "Start over" means something.
    pub can_discard: bool,
    /// A game is already using the current setup, so the page says before the
    /// click that Play replaces it as one serialized action.
    pub session_live: bool,
    pub flash_ok: bool,
    pub flash_error: bool,
}

impl StartFlags {
    /// Decide every branch for one payload. The only implementation.
    pub fn of(p: &StartPayload) -> Self {
        let staged = &p.staged;
        let session = &p.session;
        let scan_read = p.scan_read();
        let flash = p.flash.as_deref().unwrap_or_default().trim();
        let flash_error = flash.starts_with("error");
        let can_save = staged.reachable && staged.ready && p.capture.ready();
        let can_play = can_save && p.controller_outputs.can_play;
        Self {
            pill_running: session.reachable && session.running,
            pill_idle: session.reachable && !session.running,
            pill_down: !session.reachable,
            stage_down: !staged.reachable,
            scan_down: !scan_read,
            presets_down: !p.presets_error.trim().is_empty(),
            // `!silent()`, not `blocked`. A read that failed is the case this
            // page has historically got wrong in the other direction — and
            // "unknown" is the one state where saying nothing is indefensible,
            // because the page would be resolving the doubt in the machine's
            // favour on the user's behalf.
            bus_warn: !p.controller_outputs.silent(),
            has_device: staged.device.is_some(),
            has_prepared: !held_boards(p).is_empty(),
            capture_prepare: p.capture.prepare(),
            capture_release: p.capture.release(),
            capture_blocked: p.capture.blocked_state(),
            has_boards: scan_read
                && p.scan
                    .boards
                    .iter()
                    .any(|board| board.pickable && board.looks_like_a_keyboard),
            // `no_pickable_board_found` and nothing else. `boards.is_empty()`
            // is the version that tells a cabinet with four boards plugged in
            // that it has none, on the one read where that is most wrong.
            no_boards: scan_read
                && !p
                    .scan
                    .boards
                    .iter()
                    .any(|board| board.pickable && board.looks_like_a_keyboard),
            has_experimental: scan_read
                && p.scan
                    .boards
                    .iter()
                    .any(|board| board.pickable && !board.looks_like_a_keyboard),
            has_other: scan_read && p.scan.other_boards > 0,
            has_notes: !p.scan.notes.is_empty(),
            has_slots: !staged.slots.is_empty(),
            can_add: staged.reachable
                && staged.device.is_some()
                && staged.next_slot.is_some()
                && staged.personas.iter().any(|p| p.can_plug && p.available),
            slots_full: staged.reachable && staged.device.is_some() && staged.next_slot.is_none(),
            has_gaps: staged.personas.iter().any(|p| !p.can_plug),
            can_layout: staged.reachable && !staged.slots.is_empty() && !staged.layouts.is_empty(),
            blocking_answered: staged.blocking.is_some(),
            can_save,
            can_play,
            cannot_save: !can_save,
            cannot_play: !can_play,
            ready: can_save,
            not_ready: !can_save,
            can_discard: staged.reachable && !staged.empty,
            session_live: session.reachable && session.running,
            flash_ok: !flash.is_empty() && !flash_error,
            flash_error,
        }
    }
}

/// One board a first-run user could pick.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartBoardRow {
    /// **The identifier on screen** — the vendor table's name (`FIRST-RUN.md`
    /// §5).
    pub name: String,
    /// `USB` | `Bluetooth`, as a human reads it.
    pub transport: String,
    /// What can reach it, served by `DeviceScanView::read` — the sentence that
    /// says a Bluetooth keyboard can be split but never WinUSB-claimed.
    pub backends: String,
    /// Its keyboard interface's verdict.
    pub verdict: String,
    /// The honest caveat when nothing on it DECLARES itself a keyboard, else
    /// empty. Rendered on every row and hidden when empty — a `createShow`
    /// inside a `createList` is not a shape this compiler emits.
    pub caveat: String,
    pub caveat_cls: String,
    /// "it is present and cannot type right now", when that applies.
    pub cannot_type: String,
    pub cannot_type_cls: String,
    /// SMALL PRINT: the Windows instance path, for a support conversation.
    /// Never the identifier — §5.
    pub path: String,
    /// What the form posts: the SERVED `DeviceSelector`, and the alias a pick
    /// would write. Neither is derived here and neither is ever typed.
    pub selector: String,
    pub alias: String,
    /// Is this the board already staged?
    pub chosen_cls: String,
    pub button: String,
}

/// **One keyboard ksx is holding, and the form that gives it back.**
///
/// The two identifiers are FORM VALUES, exactly as the capture card's are: the
/// row prints the human name and keeps the instance path in the support
/// details, and the server re-resolves both before it asks the privileged
/// provider for anything (`docs/FIRST-RUN.md` §5 — a user is never asked to
/// read, type or paste a device path).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartPreparedRow {
    /// The vendor table's name — the identifier on screen.
    pub name: String,
    /// `USB` | `Bluetooth`, as a human reads it.
    pub transport: String,
    /// What being held costs, for this row.
    pub detail: String,
    /// SMALL PRINT: the Windows instance path, for a support conversation.
    pub path: String,
    /// The served selector and exact interface the release form posts.
    pub selector: String,
    pub instance_id: String,
    /// Why this row carries no button, when it does not — and it is a
    /// sentence, never a command, because the remedy for the one case that
    /// reaches it is physical (`docs/SURFACES.md` §3a: ksx refuses to guess
    /// between twins; unplug one, then release). Empty when the form is live.
    pub note: String,
    pub note_cls: String,
    /// The form's class: hidden when [`Self::note`] explains why there is no
    /// action. A `createShow` inside a `createList` is not a shape this
    /// compiler emits, so the row hides by class like every other row here.
    pub form_cls: String,
}

/// One board that cannot be picked at all, and why.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartOtherRow {
    pub name: String,
    pub transport: String,
    pub reason: String,
    pub backends: String,
}

/// One staged controller.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartSlotRow {
    /// The form value.
    pub number: String,
    pub title: String,
    /// **Both halves of moment 5 in one line.** `FIRST-RUN.md` §1 says the
    /// controller "appears **ready**", and §2 says nothing has been plugged,
    /// claimed or written — and a row that said only the second reads as a
    /// half-finished thing rather than a decision that has been made.
    pub state: String,
    pub persona: String,
    /// Whether it occupies one of Windows' four XInput slots, as a sentence.
    pub xinput: String,
    /// The preset it binds, and how many controls that is — including zero,
    /// which is a real answer a page should say before a game does.
    pub preset: String,
    pub bindings: String,
    /// Existing mapper, pointed at this in-memory slot rather than a saved
    /// preset. Served so the island never invents routing semantics.
    pub map_href: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartOptionRow {
    pub value: String,
    pub label: String,
}

/// One in-box layout, as a row somebody reads before choosing it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartLayoutRow {
    pub label: String,
    /// `TemplateRow::detail` — the panel this is for, verbatim from
    /// `ksx_core::templates`. Never paraphrased here.
    pub panel: String,
    /// Which players it dresses, and — for the one that binds nothing — what
    /// choosing it costs. Both in one line, because a `createShow` inside a
    /// `createList` is not a shape this compiler emits.
    pub players: String,
}

/// One persona this build cannot plug, with `Persona::gap()`'s own sentence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartGapRow {
    pub label: String,
    pub gap: String,
    pub instead: String,
}

/// One answer to §3's question.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartBlockingRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    /// Marks the answer that was actually given. Empty otherwise — no option
    /// is ever pre-marked, which is the whole point of `blocking` being
    /// optional.
    pub chosen_cls: String,
    pub button: String,
}

/// One plain-text row.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartTextRow {
    pub text: String,
}

/// **Every list row `/start` draws, composed once, in Rust.**
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartRows {
    pub boards: Vec<StartBoardRow>,
    /// **Boards ksx is holding, each with its own way back.** Built from
    /// [`held_boards`], so it answers "which keyboards cannot type right now"
    /// from the device tree rather than from the stage or the config.
    #[serde(default)]
    pub prepared: Vec<StartPreparedRow>,
    /// Pickable arbitrary HID interfaces. Kept separate from [`Self::boards`]
    /// so mice, lighting controllers and unusual composite devices remain a
    /// useful opt-in playground without masquerading as ordinary keyboards.
    pub experimental: Vec<StartBoardRow>,
    pub other: Vec<StartOtherRow>,
    pub notes: Vec<StartTextRow>,
    pub slots: Vec<StartSlotRow>,
    /// The personas this build can plug AND this stage can still add, in
    /// `Persona::ALL` order. Nothing here is spelled in TypeScript:
    /// `docs/SURFACES.md` §10 already settled that the full roster is served
    /// with build capability plus stage-specific availability per entry.
    pub personas: Vec<StartOptionRow>,
    /// The ones it cannot, listed rather than hidden — a menu that silently
    /// drops three of eight choices teaches a user the product has five.
    pub gaps: Vec<StartGapRow>,
    pub blocking: Vec<StartBlockingRow>,
    /// The in-box layouts as `<option>`s, **the served default first** — a
    /// `<select>` shows its first option, so this is how "Add a controller"
    /// means "with the arcade chart" without anybody choosing.
    pub layouts: Vec<StartOptionRow>,
    /// The same layouts as readable rows: what panel each one is for, which
    /// sets of player keys it carries, and whether it binds anything at all. A
    /// layout nobody can identify from a list is a layout nobody picks.
    pub layout_details: Vec<StartLayoutRow>,
    /// The staged slot numbers, as the options of "give slot N this layout".
    ///
    /// A second `<select>` rather than a form per row: a `createList` inside a
    /// `createList` is not a shape this compiler emits, and the per-row
    /// alternative would be a layout menu drawn once per staged controller.
    pub slot_numbers: Vec<StartOptionRow>,
}

impl StartRows {
    /// Compose every row for one payload. The only implementation.
    pub fn of(p: &StartPayload) -> Self {
        let staged = &p.staged;
        let chosen = staged.device.as_ref().map(|d| d.selector.as_str());
        let board_row = |b: &ksx_api::BoardRow| {
            let selector = b.selector.clone().unwrap_or_default();
            let is_chosen = !selector.is_empty() && chosen == Some(selector.as_str());
            StartBoardRow {
                name: b.name.clone(),
                transport: b.transport_label.clone(),
                backends: b.backends.clone(),
                // HELD FIRST, and it is not a nicety. `cannot_type_line` is
                // deliberately blank for a claimed board (`machine.rs`: "the
                // row already says `claimed`, the backends line already says
                // why") — but that reasoning is `/devices`'s, where the row
                // DOES say claimed. This row has no such field, so the
                // suppression removed the only signal and left the fallback,
                // and a board the banner above calls "held by ksx, so it
                // cannot type to Windows" read "Ready to use" ten lines lower.
                //
                // The same words as the banner, on purpose: one board saying
                // two things on one page is how somebody concludes the page
                // does not know what it is talking about.
                verdict: if b.claimed {
                    "Held by ksx".to_owned()
                } else if b.cannot_type_line.trim().is_empty() {
                    "Ready to use".to_owned()
                } else {
                    "Detected — review the note below".to_owned()
                },
                caveat: b.caveat.clone(),
                caveat_cls: hidden_when_empty(&b.caveat, "dv-warn"),
                cannot_type: b.cannot_type_line.clone(),
                cannot_type_cls: hidden_when_empty(&b.cannot_type_line, "dv-warn"),
                path: b.keyboard.clone().unwrap_or_default(),
                selector,
                alias: b.alias_hint.clone(),
                chosen_cls: if is_chosen {
                    "pill pill-ok".to_owned()
                } else {
                    "pill pill-none".to_owned()
                },
                button: if is_chosen {
                    "Chosen — pick it again".to_owned()
                } else {
                    "Use this device".to_owned()
                },
            }
        };
        Self {
            boards: p
                .scan
                .boards
                .iter()
                .filter(|b| b.pickable && b.looks_like_a_keyboard)
                .map(&board_row)
                .collect(),
            prepared: held_boards(p)
                .into_iter()
                .map(|b| prepared_row(p, b))
                .collect(),
            experimental: p
                .scan
                .boards
                .iter()
                .filter(|b| b.pickable && !b.looks_like_a_keyboard)
                .map(board_row)
                .collect(),
            other: p
                .scan
                .boards
                .iter()
                .filter(|b| !b.pickable)
                .map(|b| StartOtherRow {
                    name: b.name.clone(),
                    transport: b.transport_label.clone(),
                    reason: b.keyboard_verdict.clone(),
                    backends: b.backends.clone(),
                })
                .collect(),
            notes: p
                .scan
                .notes
                .iter()
                .map(|note| StartTextRow { text: note.clone() })
                .collect(),
            slots: staged
                .slots
                .iter()
                .map(|slot| StartSlotRow {
                    number: slot.number.to_string(),
                    title: format!("Player {}", slot.number),
                    // The state a row claims follows its BINDINGS. A row that
                    // said "ready" over a pad on which nothing works is
                    // `FIRST-RUN.md` §6's "a screen reports success while
                    // nothing works", one line long.
                    state: if slot.bindings == 0 {
                        "not ready — no controls are mapped".to_owned()
                    } else {
                        "ready — it will exist the moment you press Play".to_owned()
                    },
                    persona: slot.persona_label.clone(),
                    xinput: if slot.is_xinput {
                        "uses an Xbox-style controller place".to_owned()
                    } else {
                        "uses a PlayStation-style controller place".to_owned()
                    },
                    preset: slot.preset.clone(),
                    bindings: match slot.bindings {
                        0 => "nothing mapped yet — Play would create a controller that does \
                              nothing, so choose a layout or map a control first."
                            .to_owned(),
                        1 => "1 control bound".to_owned(),
                        n => format!("{n} controls bound"),
                    },
                    map_href: format!("/map?target=stage&slot={}", slot.number),
                })
                .collect(),
            personas: staged
                .personas
                .iter()
                .filter(|p| p.can_plug && p.available)
                .map(|p| StartOptionRow {
                    value: p.name.clone(),
                    label: persona_picker_label(p),
                })
                .collect(),
            gaps: staged
                .personas
                .iter()
                .filter(|p| !p.can_plug)
                .map(|p| StartGapRow {
                    label: p.label.clone(),
                    // `Persona::gap()`'s own sentence. A surface that
                    // paraphrased it into "install HIDMaestro" would be
                    // promising a fix that does not exist for two of the three.
                    gap: p.gap.clone().unwrap_or_default(),
                    instead: format!("Use {} instead.", p.instead),
                })
                .collect(),
            blocking: staged
                .blocking_options
                .iter()
                .map(|option| {
                    let is_chosen = staged.blocking.as_deref() == Some(option.name.as_str());
                    StartBlockingRow {
                        name: option.name.clone(),
                        title: option.title.clone(),
                        detail: option.detail.clone(),
                        chosen_cls: if is_chosen {
                            "pill pill-ok".to_owned()
                        } else {
                            "pill pill-none".to_owned()
                        },
                        button: if is_chosen {
                            "This is the answer".to_owned()
                        } else {
                            option.title.clone()
                        },
                    }
                })
                .collect(),
            // The SERVED default first, because a `<select>` shows its first
            // option: "Add this controller" then means "with the layout ksx
            // recommends" for anybody who does not touch the menu.
            layouts: layout_options(staged),
            layout_details: staged
                .layouts
                .iter()
                .map(|layout| StartLayoutRow {
                    label: layout.label.clone(),
                    panel: layout.detail.clone(),
                    players: layout_players_line(layout),
                })
                .collect(),
            slot_numbers: staged
                .slots
                .iter()
                .map(|slot| StartOptionRow {
                    value: slot.number.to_string(),
                    label: format!("Player {}", slot.number),
                })
                .collect(),
        }
    }
}

/// **The logon-task card** - `FIRST-RUN.md`'s last moment, the one that makes
/// moment 7 repeat with nobody present.
///
/// Every sentence is composed here, like the rest of this page: a cabinet that
/// does not come up on its own is not commissioned, and the difference between
/// "off", "on", "on but pointing at a ksx that is gone" and "I could not ask
/// the scheduler" is four different things to say, not one boolean.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartAutostartView {
    /// The scheduler answered. False renders the card DISABLED WITH THE
    /// REASON, never as "off": "off" is a claim about a machine nobody could
    /// read (`SURFACES.md` §1b, the same rule `reachable` follows).
    pub readable: bool,
    /// Why not, when it could not be read.
    pub error: String,
    pub registered: bool,
    /// The state as one sentence.
    pub line: String,
    /// What the button would do, said before it is pressed.
    pub detail: String,
    /// The submit label.
    pub button: String,
    /// What the form posts - the inverse of the current state, except when the
    /// registration is stale, where BOTH the repair and the removal are on.
    pub enable: bool,
    /// Registered, and it will not work.
    pub stale: bool,
    /// Why - composed by the provider, never `Staleness::message`, whose
    /// remedy names a CLI command.
    pub stale_detail: String,
}

impl StartAutostartView {
    fn of(p: &StartPayload) -> Self {
        let Some(view) = p.autostart_read.as_ref() else {
            return Self {
                readable: false,
                error: if p.autostart_error.is_empty() {
                    "Windows could not be asked what happens at sign-in.".to_owned()
                } else {
                    p.autostart_error.clone()
                },
                line: "Whether ksx starts at sign-in could not be read.".to_owned(),
                detail: "This says nothing about whether it is on. Reload the page to ask again."
                    .to_owned(),
                button: "Start ksx when I sign in".to_owned(),
                enable: true,
                ..Self::default()
            };
        };

        let stale = view.stale;
        let stale_detail = view.stale_detail.clone().unwrap_or_default();
        // A stale registration offers the REPAIR, not the removal: turning it
        // on again rewrites the task to point here, which is the whole fix. An
        // "off" button would leave the cabinet in the state it is already
        // failing in.
        let enable = !view.registered || stale;
        Self {
            readable: true,
            error: String::new(),
            registered: view.registered,
            line: if !view.registered {
                "ksx does not start on its own. After a restart, somebody has to open it before \
                 the controllers work."
                    .to_owned()
            } else if stale {
                "ksx is set to start at sign-in, but the registration is out of date.".to_owned()
            } else {
                "ksx starts by itself when you sign in.".to_owned()
            },
            detail: if enable && !view.registered {
                "Turn this on and the cabinet comes up ready on its own - no keyboard, no mouse, \
                 nobody standing at it."
                    .to_owned()
            } else if enable {
                "Turning it on again points it back at this copy of ksx.".to_owned()
            } else {
                "Turning this off means somebody has to open ksx by hand after every restart."
                    .to_owned()
            },
            button: if enable {
                "Start ksx when I sign in".to_owned()
            } else {
                "Stop starting ksx at sign-in".to_owned()
            },
            enable,
            stale,
            stale_detail,
        }
    }
}

/// The layout `<option>`s, served **playable-for-the-next-controller first**.
///
/// Sorted rather than trusted to arrive in a helpful order: the roster is
/// `ksx_core::templates::TEMPLATES`, whose order exists for
/// `ksx preset list --templates`, and "the first option is the recommended
/// one" is a claim this page makes and must therefore make true.
///
/// **Why the next slot number is part of the sort.** A template's player
/// block is chosen by slot number (`ksx_api::stage::instantiate`, `player =
/// number`), so a layout with two blocks does not merely fit slot 3 badly —
/// it REFUSES it (`ksx_core::templates::TemplateError::NoSuchPlayer`), and
/// the whole `AddSlot` fails. Serving the served default unconditionally
/// therefore made "Add this controller", menu untouched, fail on the third
/// press of a four-player panel: every in-box layout except `arcade-4way`
/// carries at most two blocks.
///
/// Layouts that cannot dress the next controller are still offered, never
/// filtered: sharing one player's keys across two controllers is a real
/// choice somebody may want. It is only never the RECOMMENDED one.
fn layout_options(staged: &ksx_api::StagedSetupView) -> Vec<StartOptionRow> {
    let next = staged.next_slot;
    let mut rows: Vec<&ksx_api::TemplateRow> = staged.layouts.iter().collect();
    rows.sort_by_key(|layout| {
        (
            !next.is_none_or(|number| layout.players.contains(&number)),
            layout.id != staged.default_layout,
        )
    });
    rows.into_iter()
        .map(|layout| StartOptionRow {
            value: layout.id.clone(),
            label: layout.label.clone(),
        })
        .collect()
}

/// Which players a layout dresses — and, for the one that binds nothing, what
/// picking it costs, in the same line.
///
/// The blank one is `TemplateRow::blank`, served, never matched on an id here:
/// "does this bind anything" is a fact about the rows, and a second blank
/// template must not be offered as if it were a working layout.
fn layout_players_line(layout: &ksx_api::TemplateRow) -> String {
    if layout.blank {
        return "No keys are assigned. Pick this only if you mean to set every button yourself; \
                until you do, the controller would do nothing and Play will ask you to finish \
                its controls."
            .to_owned();
    }
    match layout.players.len() {
        0 | 1 => "One set of player keys: every controller using it gets the same keys, so it \
                  suits one keyboard per player rather than a shared panel."
            .to_owned(),
        n => format!(
            "{n} sets of player keys — player 1's keys go to the first controller, player 2's \
             to the second, and so on, so two people on one panel never share a key."
        ),
    }
}

/// A line that is rendered on every row and HIDDEN when it has nothing to say
/// — `render_devices.rs`'s `optional_line`, and the same constraint: a
/// `createShow` inside a `createList` is not a shape this compiler emits.
///
/// The `dv-*` classes are `/devices`'s and are reused deliberately: this page
/// draws the same KIND of thing — a list of boards, each a stack of facts with
/// optional warnings — and a second set of class names for it would be a second
/// place to keep the amber plate and the hide rule in step.
fn hidden_when_empty(text: &str, class: &str) -> String {
    if text.trim().is_empty() {
        format!("{class} dv-hide")
    } else {
        class.to_owned()
    }
}

// ───────────────────────────────────────────────────────────────────────────
// /workspace — the Nocturne workspace shell (M0 skeleton)
// ───────────────────────────────────────────────────────────────────────────

/// What `GET /api/workspace` serves AND what the workspace island's props
/// carry — the same one-struct-one-serializer rule as [`StatusPayload`],
/// parity pinned in `render_workspace.rs`.
///
/// M0 is the frame of the screen that will absorb `/start`, `/map` and `/`:
/// the payload carries the daemon-held draft and the session, and every
/// sentence the page shows lives in [`WorkspaceDerived`] — composed once, in
/// Rust, exactly as [`ProfilesDerived`] and [`SetupLines`] are. The island
/// copies fields and derives nothing, so the SSR paint and the 2 s poll can
/// never disagree.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePayload {
    /// The staged setup, from `ControlSource::staged` — the DAEMON's memory,
    /// not a file. Its own `reachable`/`error` fields say when there is none.
    pub staged: ksx_api::StagedSetupView,
    pub session: crate::control::SessionView,
    /// The slot the page is LOOKING AT (`?slot=N`), resolved by the server —
    /// absent or unknown falls back to the first staged slot. The poller
    /// echoes the page's own query string, so a poll cannot flip the view.
    #[serde(default)]
    pub selected: Option<u8>,
    /// Every displayed string and every `show:` branch, computed once —
    /// recomputed from the fields above by [`Self::derived`]; never assembled
    /// by hand.
    #[serde(default)]
    pub view: WorkspaceDerived,
}

impl WorkspacePayload {
    /// Fill [`Self::view`] from the raw provider data. Every producer of a
    /// payload calls this — the page render and `GET /api/workspace` share one
    /// collector — so the server paint and the poll are the same bytes by
    /// construction rather than by two implementations agreeing.
    #[must_use]
    pub fn derived(mut self) -> Self {
        self.view = WorkspaceDerived::of(&self);
        self
    }
}

/// One staged controller as the workspace rack renders it. Every string is
/// composed HERE and every form value is precomposed — including the
/// whole-order sequence each Move button submits, because the daemon's
/// reorder verb takes the WHOLE order (`StageEdit::ReorderSlots`) and a page
/// that recomputed it client-side would be a second derivation of slot order.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSlotRow {
    /// The slot number, as the string a form field submits.
    pub number: String,
    /// `"wsrow"`, `"wsrow on"` for the selected controller.
    pub row_cls: String,
    /// `/workspace?slot=N` — selection is a LINK, so switching controllers
    /// works with no JavaScript at all.
    pub href: String,
    /// "P1 · Xbox 360".
    pub title: String,
    /// "\"Player 1\" · 12 controls".
    pub detail: String,
    /// "Opposites: Up wins", or empty for the off default — a policy nobody
    /// set is not narrated.
    pub socd_note: String,
    /// The whole slot order after moving this row UP, space-separated
    /// (`"2 1 3"`), or empty for the first row — the server answers an empty
    /// submission with the honest already-there sentence.
    pub up_order: String,
    /// Same, moving DOWN; empty for the last row.
    pub down_order: String,
}

/// One radio-row of a workspace choice group (keyboard capture). The chosen
/// state is a composed CLASS and a composed button label, never client logic.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceChoiceRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    /// `"wschoice on"` for the current answer, `"wschoice"` otherwise.
    pub row_cls: String,
    /// "This is how it is set" / "Choose".
    pub button: String,
}

/// A `<select>` option, value + label, both served.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceOptionRow {
    pub value: String,
    pub label: String,
}

/// One binding-list row of the workspace's right pane: the selected slot's
/// controls in the zone tables' own order, each with the composed strings
/// the Nocturne row anatomy renders and the fields its Clear twin submits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceBindRow {
    /// Canonical function name — the form field and the row key.
    pub function: String,
    /// "LS ▲", "D-pad ◀", "A" — the mapper's own legend label.
    pub label: String,
    /// "G · H", or the honest "—" for an unbound control.
    pub keys: String,
    /// The row's modifiers as one quiet sentence: "Turbo ~12 Hz · Toggle ·
    /// this key also drives A, B" — empty when the row is plain.
    pub notes: String,
    /// `"wsbind"` (+" unbound"/" shared").
    pub cls: String,
    /// "Clear" on a bound row, empty (and therefore hidden) on an unbound
    /// one — the list idiom for a per-row action that is sometimes a no-op.
    pub clear: String,
    /// The slot number the Clear twin submits.
    pub slot: String,
}

/// Everything the workspace SHOWS that is not verbatim provider data. The
/// island reads these fields and renders them; it derives nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceDerived {
    /// The stage card's one customer sentence for the session state.
    pub state_detail: String,
    /// The Keyboard section's one line: the staged board's LABEL
    /// (`FIRST-RUN.md` §5 — the label is the identifier on screen), or the
    /// honest empty/unreadable sentence.
    pub device_line: String,
    /// The board's capture path in small print — "USB · Interception",
    /// "USB · built-in (WinUSB)" — or empty with no board.
    pub device_meta: String,
    /// The Virtual-controllers section's one line.
    pub rack_line: String,
    /// The staged controllers, in slot order.
    pub rack: Vec<WorkspaceSlotRow>,
    /// The capacity sentence under the rack — served ceilings, never
    /// hardcoded ones.
    pub rack_caption: String,
    /// P1..Pn for the shared opposite-directions form.
    pub socd_slots: Vec<WorkspaceOptionRow>,
    /// The served SOCD roster (`SocdOption`), as select options.
    pub socd_policies: Vec<WorkspaceOptionRow>,
    /// The capture question's current-answer sentence.
    pub blocking_line: String,
    /// The three capture answers as radio-rows.
    pub blocking: Vec<WorkspaceChoiceRow>,
    /// The personas "Add a controller" may offer — this build's pluggable,
    /// this stage's still-addable, with the backend and per-session ceiling
    /// in the label (the same filter and label `/start` offers).
    pub add_personas: Vec<WorkspaceOptionRow>,
    /// The in-box layouts, best-fit-first for the next slot.
    pub add_layouts: Vec<WorkspaceOptionRow>,
    /// The preset name the add would create — SERVED, because it becomes a
    /// file name (`StagedSetupView::next_preset`'s own rule).
    pub add_preset: String,
    /// The ceiling sentence when every slot is staged, else empty.
    pub add_full_line: String,
    /// The schematic's accessible summary: the first controller's identity
    /// and bound count, with the Sony-vocabulary honesty caption for
    /// PlayStation-family pads ("shown on a generic gamepad outline").
    pub pad_caption: String,
    /// The right pane's heading line: the SELECTED controller's identity, or
    /// the honest empty/unreachable sentence.
    pub bind_title: String,
    /// The selected controller's binding list, in zone order.
    pub bind_rows: Vec<WorkspaceBindRow>,
    /// "14 of 25 controls bound · 2 keys shared." — or empty with no slot.
    pub bind_foot: String,
    /// Where the full mapper lives for the selected slot
    /// (`/map?target=stage&slot=N`), or `/map` with none.
    pub map_href: String,
    /// "Unsaved changes — …" when the draft is dirty, else empty.
    pub dirty_line: String,
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    /// The pane-structure branches: a readable non-empty draft shows the
    /// rack and its forms; a readable EMPTY draft shows the build/adopt
    /// affordances; an unreachable one shows neither (the lines above carry
    /// the failed-read sentences).
    pub stage_ready: bool,
    pub stage_empty: bool,
    pub has_device: bool,
    pub show_dirty: bool,
    pub can_add: bool,
    pub add_full: bool,
    /// Which stage schematic renders: the first controller's FAMILY decides,
    /// and an empty or unreadable draft shows the Xbox outline as the
    /// generic default. Exactly one of the pair is ever true.
    pub pad_xbox: bool,
    pub pad_ps: bool,
}

/// The slot the page is looking at: the requested one when it still exists,
/// else the first — a removed slot must not leave the pane staring at
/// nothing when there is something honest to show.
fn workspace_selected(p: &WorkspacePayload) -> Option<&ksx_api::StagedSlotView> {
    if !p.staged.reachable {
        return None;
    }
    p.selected
        .and_then(|n| p.staged.slots.iter().find(|slot| slot.number == n))
        .or_else(|| p.staged.slots.first())
}

impl WorkspaceDerived {
    fn of(p: &WorkspacePayload) -> Self {
        let staged = &p.staged;
        let ready = staged.reachable && !staged.empty;
        let selected = workspace_selected(p);
        let binds = workspace_bind_rows(staged, selected);
        Self {
            state_detail: session_play_status(&p.session),
            device_line: workspace_device_line(staged),
            device_meta: workspace_device_meta(staged),
            rack_line: workspace_rack_line(staged),
            rack: workspace_rack_rows(staged, selected.map(|slot| slot.number)),
            rack_caption: workspace_rack_caption(staged),
            socd_slots: staged
                .slots
                .iter()
                .map(|slot| WorkspaceOptionRow {
                    value: slot.number.to_string(),
                    label: format!("P{}", slot.number),
                })
                .collect(),
            socd_policies: staged
                .socd_options
                .iter()
                .map(|option| WorkspaceOptionRow {
                    value: option.name.clone(),
                    label: option.title.clone(),
                })
                .collect(),
            blocking_line: workspace_blocking_line(staged),
            blocking: workspace_blocking_rows(staged),
            add_personas: staged
                .personas
                .iter()
                .filter(|p| p.can_plug && p.available)
                .map(|p| WorkspaceOptionRow {
                    value: p.name.clone(),
                    label: persona_picker_label(p),
                })
                .collect(),
            add_layouts: layout_options(staged)
                .into_iter()
                .map(|option| WorkspaceOptionRow {
                    value: option.value,
                    label: option.label,
                })
                .collect(),
            add_preset: staged.next_preset.clone().unwrap_or_default(),
            add_full_line: if ready && staged.next_slot.is_none() {
                format!(
                    "All {} controller slots are staged — remove one to add a different one.",
                    staged.max_slots
                )
            } else {
                String::new()
            },
            pad_caption: workspace_pad_caption(selected),
            bind_title: binds.title,
            bind_rows: binds.rows,
            bind_foot: binds.foot,
            map_href: binds.map_href,
            dirty_line: if ready && staged.dirty {
                "Unsaved changes — Save writes them; Play runs them as they are.".to_owned()
            } else {
                String::new()
            },
            pill_running: p.session.reachable && p.session.running,
            pill_idle: p.session.reachable && !p.session.running,
            pill_down: !p.session.reachable,
            stage_ready: ready,
            stage_empty: staged.reachable && staged.empty,
            has_device: staged.reachable && staged.device.is_some(),
            show_dirty: ready && staged.dirty,
            can_add: ready
                && staged.next_slot.is_some()
                && staged.personas.iter().any(|p| p.can_plug && p.available),
            add_full: ready && staged.next_slot.is_none(),
            pad_ps: selected.is_some_and(|slot| !slot.is_xinput),
            pad_xbox: !selected.is_some_and(|slot| !slot.is_xinput),
        }
    }
}

/// A failed READ is not an absence (`docs/SURFACES.md` §1b): an unreachable
/// draft says so, and never renders as "No keyboard chosen yet" — which is
/// advice, and would be the wrong advice.
fn workspace_device_line(staged: &ksx_api::StagedSetupView) -> String {
    if !staged.reachable {
        return "The draft could not be read. Reopen ksx and try again.".to_owned();
    }
    match &staged.device {
        Some(device) => device.label.clone(),
        None => "No keyboard chosen yet.".to_owned(),
    }
}

fn workspace_rack_line(staged: &ksx_api::StagedSetupView) -> String {
    if !staged.reachable {
        return "Not readable right now.".to_owned();
    }
    match staged.slots.len() {
        0 => "No controllers staged yet.".to_owned(),
        1 => "1 controller staged.".to_owned(),
        n => format!("{n} controllers staged."),
    }
}

/// The capture path in the words `/start`'s device rows use, from the served
/// backend name — matched, never parsed out of a selector.
fn workspace_device_meta(staged: &ksx_api::StagedSetupView) -> String {
    let Some(device) = staged.device.as_ref().filter(|_| staged.reachable) else {
        return String::new();
    };
    match device.backend.as_str() {
        "winusb" => "USB · built-in (WinUSB)".to_owned(),
        "interception" => "USB · Interception".to_owned(),
        // A backend this build has no words for still gets shown — the served
        // name is at least true, and hiding it would claim there is none.
        other => other.to_owned(),
    }
}

fn workspace_rack_rows(
    staged: &ksx_api::StagedSetupView,
    selected: Option<u8>,
) -> Vec<WorkspaceSlotRow> {
    if !staged.reachable {
        return Vec::new();
    }
    let order: Vec<u8> = staged.slots.iter().map(|slot| slot.number).collect();
    let swapped = |a: usize, b: usize| -> String {
        let mut next = order.clone();
        next.swap(a, b);
        next.iter().map(u8::to_string).collect::<Vec<_>>().join(" ")
    };
    staged
        .slots
        .iter()
        .enumerate()
        .map(|(at, slot)| WorkspaceSlotRow {
            number: slot.number.to_string(),
            row_cls: if selected == Some(slot.number) {
                "wsrow on".to_owned()
            } else {
                "wsrow".to_owned()
            },
            href: format!("/workspace?slot={}", slot.number),
            title: format!("P{} · {}", slot.number, slot.persona_label),
            detail: format!(
                "\"{}\" · {} control{}",
                slot.preset,
                slot.bindings,
                if slot.bindings == 1 { "" } else { "s" }
            ),
            socd_note: match slot.socd.as_str() {
                "" | "off" => String::new(),
                _ => format!("Opposites: {}", slot.socd_label),
            },
            up_order: if at == 0 {
                String::new()
            } else {
                swapped(at - 1, at)
            },
            down_order: if at + 1 == order.len() {
                String::new()
            } else {
                swapped(at, at + 1)
            },
        })
        .collect()
}

/// Served ceilings, never hardcoded ones — and only the Xbox half when it is
/// the binding constraint, because "1 of 4" beside "1 of 16" reads as two
/// unrelated quotas until one of them refuses.
fn workspace_rack_caption(staged: &ksx_api::StagedSetupView) -> String {
    if !staged.reachable || staged.slots.is_empty() {
        return String::new();
    }
    format!(
        "{} of {} controllers · {} of {} Xbox seats used.",
        staged.slots.len(),
        staged.max_slots,
        staged.xinput_used,
        staged.max_xinput_slots
    )
}

fn workspace_blocking_line(staged: &ksx_api::StagedSetupView) -> String {
    if !staged.reachable {
        return String::new();
    }
    let current = staged.blocking.as_deref().unwrap_or("");
    match staged
        .blocking_options
        .iter()
        .find(|option| option.name == current)
    {
        Some(option) => format!("{} — {}", option.title, option.detail),
        None => "Not answered yet. Play needs an answer; pick one below.".to_owned(),
    }
}

/// The schematic's one accessible sentence: which pad it stands for and how
/// bound it is. No vocabulary caveat any more — the stage shows each
/// family's OWN outline (`WorkspaceDerived::pad_ps`), so the art and the
/// words already agree.
fn workspace_pad_caption(selected: Option<&ksx_api::StagedSlotView>) -> String {
    let Some(slot) = selected else {
        return String::new();
    };
    format!(
        "P{} · {} — \"{}\", {} control{} bound.",
        slot.number,
        slot.persona_label,
        slot.preset,
        slot.bindings,
        if slot.bindings == 1 { "" } else { "s" }
    )
}

/// The right pane's whole content for one selected controller, composed off
/// the SAME machinery the mapper reads (`ksx_api::staged_mapper_slot` + the
/// zone tables in render_map.rs), so the two surfaces cannot describe one
/// binding differently.
struct WorkspaceBinds {
    title: String,
    rows: Vec<WorkspaceBindRow>,
    foot: String,
    map_href: String,
}

fn workspace_bind_rows(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
) -> WorkspaceBinds {
    let empty = |title: &str| WorkspaceBinds {
        title: title.to_owned(),
        rows: Vec::new(),
        foot: String::new(),
        map_href: "/map".to_owned(),
    };
    if !staged.reachable {
        return empty("Not readable right now.");
    }
    let Some(slot) = selected else {
        return empty("No controller staged yet.");
    };
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let Ok(mapper) = ksx_api::staged_mapper_slot(slot, keyboard) else {
        // An older daemon serves no authoring table; the mapper page carries
        // the full explanation, so point there rather than paraphrasing.
        return WorkspaceBinds {
            title: format!("P{} · {}", slot.number, slot.persona_label),
            rows: Vec::new(),
            foot: String::new(),
            map_href: format!("/map?target=stage&slot={}", slot.number),
        };
    };
    let shared = crate::render_map::shared_labels(&mapper);
    let zones = crate::render_map::zones_for(&mapper.persona);
    let rows: Vec<WorkspaceBindRow> = zones
        .iter()
        .zip(&shared)
        .map(|(zone, share)| {
            let keys = crate::render_map::key_tag(&mapper, zone.fn_name);
            let unbound = keys == "—";
            let mut notes: Vec<String> = Vec::new();
            if let Some(effective) = mapper.turbo.get(zone.fn_name) {
                notes.push(format!("Turbo ~{effective} Hz"));
            }
            if mapper.toggle.contains(zone.fn_name) {
                notes.push("Toggle: a press holds until the next press".to_owned());
            }
            if !share.is_empty() {
                // `share_text` is the mapper's compact badge ("also A · B",
                // capped); this sentence gives it a subject, so the badge's
                // own "also " comes off first.
                let names = crate::render_map::share_text(share);
                notes.push(format!(
                    "this key also drives {}",
                    names.trim_start_matches("also ")
                ));
            }
            let mut cls = String::from("wsbind");
            if unbound {
                cls.push_str(" unbound");
            }
            if !share.is_empty() {
                cls.push_str(" shared");
            }
            WorkspaceBindRow {
                function: zone.fn_name.to_owned(),
                label: crate::render_map::legend_label(zone),
                keys,
                notes: notes.join(" · "),
                cls,
                clear: if unbound {
                    String::new()
                } else {
                    "Clear".to_owned()
                },
                slot: slot.number.to_string(),
            }
        })
        .collect();
    let bound = rows.iter().filter(|row| row.keys != "—").count();
    // A key is SHARED when it drives more than one control — counted once,
    // by inverting the binding table, so a key that merely sits beside a
    // shared one on some row never inflates the number.
    let shared_keys: usize = {
        let mut fanout: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for keys in mapper.bindings.values() {
            for key in keys {
                *fanout.entry(key.as_str()).or_default() += 1;
            }
        }
        fanout.values().filter(|count| **count > 1).count()
    };
    let foot = match shared_keys {
        0 => format!("{bound} of {} controls bound.", rows.len()),
        1 => format!("{bound} of {} controls bound · 1 key shared.", rows.len()),
        n => format!(
            "{bound} of {} controls bound · {n} keys shared.",
            rows.len()
        ),
    };
    WorkspaceBinds {
        title: format!(
            "P{} · {} — \"{}\"",
            slot.number, slot.persona_label, slot.preset
        ),
        rows,
        foot,
        map_href: format!("/map?target=stage&slot={}", slot.number),
    }
}

fn workspace_blocking_rows(staged: &ksx_api::StagedSetupView) -> Vec<WorkspaceChoiceRow> {
    if !staged.reachable {
        return Vec::new();
    }
    let current = staged.blocking.as_deref().unwrap_or("");
    staged
        .blocking_options
        .iter()
        .map(|option| WorkspaceChoiceRow {
            name: option.name.clone(),
            title: option.title.clone(),
            detail: option.detail.clone(),
            row_cls: if option.name == current {
                "wschoice on".to_owned()
            } else {
                "wschoice".to_owned()
            },
            button: if option.name == current {
                "This is how it is set".to_owned()
            } else {
                "Choose".to_owned()
            },
        })
        .collect()
}

// ═══ /nocturne — THE MIGRATED KEYBOARD SECTION ═════════════════════════════
//
// The first real payload behind the Nocturne route (2026-08-17): the keyboard
// facts ONLY — device pick rows off the live machine scan, the split/freeze
// roster, and the prepared-for-play control composed from the SAME
// [`StartCaptureView`] mode machine `/start`'s card uses. Everything else on
// the page stays the design proof's placeholder until its own migration pass.

/// `/nocturne`'s served facts. Independent reads with independent failure
/// modes, exactly like [`StartPayload`]: a dead daemon must not read as "you
/// have staged nothing" and a refused enumeration must not read as "you have
/// no keyboards".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NocturnePayload {
    pub staged: ksx_api::StagedSetupView,
    pub scan: ksx_api::DeviceScanView,
    pub session: crate::control::SessionView,
    /// Empty when the scan answered; otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// Every sentence and row the page renders, composed once, here.
    #[serde(default)]
    pub view: NocturneDerived,
}

impl NocturnePayload {
    /// Recompose [`view`](Self::view) from this payload's own facts — called
    /// on the way OUT, like every other `composed()`/`derived()` here.
    #[must_use]
    pub fn derived(mut self) -> Self {
        self.view = NocturneDerived::of(&self);
        self
    }

    fn scan_read(&self) -> bool {
        self.unavailable.trim().is_empty()
    }
}

/// One pickable keyboard row: the row IS the `/nocturne/device` form's
/// button, so the three hidden values ride beside the display fields. All
/// three are SERVED — `FIRST-RUN.md` §6 forbids asking anyone to type a
/// device path, and this page has no text input either.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneDeviceRow {
    pub cls: String,
    pub name: String,
    pub meta: String,
    pub selector: String,
    pub alias: String,
    pub label: String,
}

/// One board that cannot be picked, and why — kept visible, never hidden:
/// a list that silently drops rows teaches a user the machine has fewer
/// keyboards than it does.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOtherRow {
    pub name: String,
    pub meta: String,
}

/// One split-or-freeze answer, from `BlockingOption::roster()` — the same
/// words `/start` and `/workspace` ask with, deliberately not a third wording.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneChoiceRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub cls: String,
}

/// One staged controller in the rack.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneRackRow {
    pub number: String,
    pub badge: String,
    pub name: String,
    pub meta: String,
    pub cls: String,
}

/// One free slot the rack shows as an invitation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneEmptyRow {
    pub badge: String,
}

/// One persona card in the create form. Unavailable personas stay listed —
/// a menu that silently drops choices teaches a user the product has fewer.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturnePersonaRow {
    pub name: String,
    pub label: String,
    pub api: String,
    pub note: String,
    pub cls: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOptionRow {
    pub value: String,
    pub label: String,
}

/// One binding-list row, composed off the SAME machinery the mapper reads
/// (via [`workspace_bind_rows`]) and re-dressed for the Nocturne pane.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneBindRow {
    pub function: String,
    pub label: String,
    pub chip: String,
    pub note: String,
    pub cls: String,
    pub chip_cls: String,
    pub clear_cls: String,
    pub slot: String,
}

/// One keycap on the standard board, dressed with its binding short.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneKeyCell {
    pub cap: String,
    pub cls: String,
    pub short: String,
    /// The full sentence for hover/aria: which controls this key drives.
    pub title: String,
}

/// Every sentence `/nocturne` states as a served fact.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneDerived {
    /// The device kicker's count — "N found", or the honest refusal word.
    pub dev_count: String,
    /// `scan.boards_summary` or the refusal sentence — the one line that
    /// distinguishes "no keyboard-capable board" from "nothing could be read".
    pub dev_note: String,
    /// The keyboard header over the key grid: the STAGED selection's identity.
    pub kb_title: String,
    pub dev_rows: Vec<NocturneDeviceRow>,
    /// Pickable HID devices that do NOT identify themselves as keyboards —
    /// the explicit experimentation playground, never mixed into the
    /// ordinary keyboard list (the same split `/start` draws).
    pub dev_exp: Vec<NocturneDeviceRow>,
    pub dev_other: Vec<NocturneOtherRow>,
    /// The two folds' headers ("… · N") and visibility classes; empty tiers
    /// hide their fold entirely.
    pub exp_head: String,
    pub exp_fold_cls: String,
    pub other_head: String,
    pub other_fold_cls: String,
    pub mode_rows: Vec<NocturneChoiceRow>,
    /// Why the behaviour section has nothing to offer, when it does not —
    /// an empty roster with no sentence is a silent hole, not a state.
    pub mode_note: String,
    /// The prepared-for-play control, composed from [`StartCaptureView`]'s
    /// mode machine. `capd_cls` hides the whole control (`none`) or strips
    /// its action (`noact`); the two dialog shows are exclusive.
    pub cap_line: String,
    pub capd_cls: String,
    pub cap_sw_cls: String,
    pub cap_selector: String,
    pub cap_instance: String,
    pub cap_prepare: bool,
    pub cap_release: bool,
    /// The title bar: real version, the draft's origin + dirty answer, the
    /// backend-owned escape hatch, and the session verbs' visibility.
    pub version: String,
    pub chip_text: String,
    pub save_text: String,
    pub escape_line: String,
    pub play_cls: String,
    pub stop_cls: String,
    /// The rack.
    pub rack_rows: Vec<NocturneRackRow>,
    pub rack_empty: Vec<NocturneEmptyRow>,
    pub rack_caption: String,
    /// The create form: real personas, layouts, SOCD roster, served preset
    /// name, and the lede naming the player and board.
    pub add_lede: String,
    pub add_preset: String,
    pub persona_rows: Vec<NocturnePersonaRow>,
    pub layout_opts: Vec<NocturneOptionRow>,
    pub socd_opts: Vec<NocturneOptionRow>,
    /// The stage's meta bar and the binding pane, off the first slot.
    pub pad_badge: String,
    pub pad_name: String,
    pub pad_sub: String,
    pub bind_title: String,
    pub bind_rows: Vec<NocturneBindRow>,
    pub bind_foot: String,
    /// The keyboard grid, dressed: six rows of the standard board with each
    /// key's binding short, the off-board tray, and the honesty note naming
    /// which controller the shorts describe.
    pub kb_row1: Vec<NocturneKeyCell>,
    pub kb_row2: Vec<NocturneKeyCell>,
    pub kb_row3: Vec<NocturneKeyCell>,
    pub kb_row4: Vec<NocturneKeyCell>,
    pub kb_row5: Vec<NocturneKeyCell>,
    pub kb_row6: Vec<NocturneKeyCell>,
    pub kb_tray: Vec<NocturneKeyCell>,
    pub kb_tray_head: String,
    pub kb_tray_cls: String,
    pub kb_note: String,
}

impl NocturneDerived {
    fn of(p: &NocturnePayload) -> Self {
        let staged = &p.staged;
        let scan_read = p.scan_read();
        let chosen = staged.device.as_ref().map(|d| d.selector.as_str());

        let mut dev_rows = Vec::new();
        let mut dev_exp = Vec::new();
        let mut dev_other = Vec::new();
        if scan_read {
            for b in &p.scan.boards {
                if !b.pickable {
                    dev_other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: format!("{} · {}", b.transport_label, b.backends),
                    });
                    continue;
                }
                let Some(selector) = b.selector.clone() else {
                    dev_other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: b.backends.clone(),
                    });
                    continue;
                };
                let is_chosen = chosen == Some(selector.as_str());
                let verdict = if b.claimed {
                    "Held by ksx"
                } else if b.cannot_type_line.trim().is_empty() {
                    "Ready to use"
                } else {
                    "Cannot type right now"
                };
                let row = NocturneDeviceRow {
                    cls: if is_chosen {
                        "n-dev on".to_owned()
                    } else {
                        "n-dev".to_owned()
                    },
                    name: b.name.clone(),
                    meta: format!("{} · {}", b.transport_label, verdict),
                    selector,
                    alias: b.alias_hint.clone(),
                    label: b.name.clone(),
                };
                if b.looks_like_a_keyboard {
                    dev_rows.push(row);
                } else {
                    dev_exp.push(row);
                }
            }
        }
        let exp_head = format!("Not keyboards — experimental · {}", dev_exp.len());
        let exp_fold_cls = if dev_exp.is_empty() {
            "n-devfold none".to_owned()
        } else {
            "n-devfold".to_owned()
        };
        let other_head = format!("Unavailable devices · {}", dev_other.len());
        let other_fold_cls = if dev_other.is_empty() {
            "n-devfold none".to_owned()
        } else {
            "n-devfold".to_owned()
        };

        let dev_count = if scan_read {
            format!("{} found", dev_rows.len())
        } else {
            "unavailable".to_owned()
        };
        let dev_note = if scan_read {
            p.scan.boards_summary.clone()
        } else {
            p.unavailable.clone()
        };

        let kb_title = match staged.device.as_ref() {
            _ if !staged.reachable => "The draft could not be read — reopen ksx".to_owned(),
            Some(d) => {
                let transport = p
                    .scan
                    .boards
                    .iter()
                    .find(|b| b.selector.as_deref() == Some(d.selector.as_str()))
                    .map(|b| b.transport_label.as_str())
                    .filter(|t| !t.trim().is_empty());
                match transport {
                    Some(t) => format!("{} · {}", d.label, t),
                    None => d.label.clone(),
                }
            }
            None => "No keyboard selected — pick one on the left".to_owned(),
        };

        let mode_note = if staged.reachable {
            String::new()
        } else {
            "The draft could not be read, so the capture answer cannot be shown. Reopen ksx."
                .to_owned()
        };
        let current_mode = staged.blocking.as_deref().unwrap_or("");
        let mode_rows = if staged.reachable {
            staged
                .blocking_options
                .iter()
                .map(|option| NocturneChoiceRow {
                    name: option.name.clone(),
                    title: option.title.clone(),
                    detail: option.detail.clone(),
                    cls: if option.name == current_mode {
                        "n-radio on".to_owned()
                    } else {
                        "n-radio".to_owned()
                    },
                })
                .collect()
        } else {
            Vec::new()
        };

        let cap = StartCaptureView::from_parts(staged, &p.scan, scan_read);
        let mode = cap.mode_word();
        let (cap_prepare, cap_release) = match mode {
            "prepare" | "prepare-optional" => (true, false),
            "release" => (false, true),
            _ => (false, false),
        };
        let cap_line = match mode {
            "none" => String::new(),
            "ready" => {
                "Ready through the shared capture driver — typing normally until Play.".to_owned()
            }
            "prepare-optional" => {
                "Typing normally — the shared driver is ready; preparing the built-in path is \
                 optional."
                    .to_owned()
            }
            "prepare" => {
                "Prepare for play — Windows stops this keyboard's ordinary typing until it is \
                 released here."
                    .to_owned()
            }
            "release" => {
                "Prepared for play — this keyboard will not type until it is released here."
                    .to_owned()
            }
            "held" => "Held by ksx but staged for the ordinary Windows path — release it from the \
                 held-keyboards list on the Start screen."
                .to_owned(),
            _ => "This keyboard is not ready for capture right now.".to_owned(),
        };
        let capd_cls = match mode {
            "none" => "n-capd none".to_owned(),
            "prepare" | "prepare-optional" | "release" => "n-capd".to_owned(),
            _ => "n-capd noact".to_owned(),
        };
        let cap_sw_cls = if mode == "release" {
            "n-capsw on".to_owned()
        } else {
            "n-capsw".to_owned()
        };

        let version = format!("v{}", env!("CARGO_PKG_VERSION"));
        let chip_text = if !staged.reachable {
            "Draft unavailable".to_owned()
        } else if staged.origin == "config" {
            "Saved configuration".to_owned()
        } else {
            "New draft".to_owned()
        };
        let save_text = if !staged.reachable {
            String::new()
        } else if staged.dirty {
            "Unsaved changes".to_owned()
        } else {
            "Saved".to_owned()
        };
        let escape_line = ksx_api::stage::ESCAPE_HATCH_LINE.to_owned();
        let running = p.session.reachable && p.session.running;
        let play_cls = if running { "n-play none" } else { "n-play" }.to_owned();
        let stop_cls = if running { "n-stop" } else { "n-stop none" }.to_owned();

        let rack_rows: Vec<NocturneRackRow> = if staged.reachable {
            staged
                .slots
                .iter()
                .map(|slot| NocturneRackRow {
                    number: slot.number.to_string(),
                    badge: format!("P{}", slot.number),
                    name: slot.persona_label.clone(),
                    meta: format!(
                        "\"{}\" · {} bound · SOCD {}",
                        slot.preset, slot.bindings, slot.socd_label
                    ),
                    cls: "n-slot on".to_owned(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let rack_empty: Vec<NocturneEmptyRow> = if !staged.reachable {
            Vec::new()
        } else {
            match staged.next_slot {
                None => Vec::new(),
                Some(next) => {
                    // Fill the rack to four visible rows the way the design
                    // does; past four, one invitation for the next slot.
                    let upto = if staged.slots.len() < 4 {
                        (u8::try_from(staged.slots.len()).unwrap_or(u8::MAX) + 1)..=4
                    } else {
                        next..=next
                    };
                    upto.map(|n| NocturneEmptyRow {
                        badge: format!("P{n}"),
                    })
                    .collect()
                }
            }
        };
        let rack_caption = if staged.reachable {
            format!(
                "{}/{} XInput · {}/{} slots",
                staged.xinput_used,
                staged.max_xinput_slots,
                staged.slots.len(),
                staged.max_slots
            )
        } else {
            String::new()
        };

        let add_lede = match (staged.next_slot, staged.device.as_ref()) {
            (Some(next), Some(device)) => {
                format!("Games will see Player {next}, driven by {}.", device.label)
            }
            (Some(next), None) => {
                format!("Games will see Player {next}, driven by the selected keyboard.")
            }
            (None, _) => "Every controller slot is staged. Remove one to add another.".to_owned(),
        };
        let add_preset = staged.next_preset.clone().unwrap_or_default();
        let persona_rows: Vec<NocturnePersonaRow> = staged
            .personas
            .iter()
            .map(|persona| {
                let usable = persona.can_plug && persona.available;
                NocturnePersonaRow {
                    name: persona.name.clone(),
                    label: persona.label.clone(),
                    api: if persona.is_xinput {
                        format!("{} · XInput", persona.backend_label)
                    } else {
                        persona.backend_label.clone()
                    },
                    note: persona
                        .unavailable_reason
                        .clone()
                        .or_else(|| persona.gap.clone())
                        .unwrap_or_default(),
                    cls: if usable {
                        "nd-card sel".to_owned()
                    } else {
                        "nd-card off".to_owned()
                    },
                }
            })
            .collect();
        let layout_opts: Vec<NocturneOptionRow> = staged
            .layouts
            .iter()
            .map(|layout| NocturneOptionRow {
                value: layout.id.clone(),
                label: layout.label.clone(),
            })
            .collect();
        let socd_opts: Vec<NocturneOptionRow> = staged
            .socd_options
            .iter()
            .map(|option| NocturneOptionRow {
                value: option.name.clone(),
                label: option.title.clone(),
            })
            .collect();

        let selected = staged.slots.first();
        let (pad_badge, pad_name, pad_sub) = match selected {
            Some(slot) => (
                format!("P{}", slot.number),
                slot.persona_label.clone(),
                format!("\"{}\" · SOCD {}", slot.preset, slot.socd_label),
            ),
            None => (String::new(), String::new(), String::new()),
        };
        // The keyboard grid: the SAME mapper table the binding pane reads,
        // inverted key→functions, painted onto the standard-board layout.
        let keyboard_name = staged
            .device
            .as_ref()
            .map(|device| device.label.as_str())
            .unwrap_or("(none)");
        let mapper =
            selected.and_then(|slot| ksx_api::staged_mapper_slot(slot, keyboard_name).ok());
        let mut key_fns: std::collections::BTreeMap<&str, Vec<&str>> =
            std::collections::BTreeMap::new();
        if let Some(mapper) = mapper.as_ref() {
            for (fn_name, keys) in &mapper.bindings {
                for key in keys {
                    key_fns
                        .entry(key.as_str())
                        .or_default()
                        .push(fn_name.as_str());
                }
            }
        }
        let persona = selected
            .map(|slot| slot.persona.as_str())
            .unwrap_or("xbox360");
        let dress = |cell: &crate::keyboard_layout::KeyCell| {
            let mut cls = String::from("n-key");
            if !cell.unit.is_empty() {
                cls.push(' ');
                cls.push_str(cell.unit);
            }
            if cell.sp {
                cls.push_str(" sp");
            }
            if cell.ghost {
                cls.push_str(" ghost");
            }
            let fns = key_fns.get(cell.key).filter(|fns| !fns.is_empty());
            let (short, title) = match fns {
                Some(fns) => {
                    cls.push_str(" bound");
                    if fns.len() > 1 {
                        cls.push_str(" shared");
                    }
                    let names: Vec<String> = fns
                        .iter()
                        .map(|f| crate::keyboard_layout::short_for(persona, f))
                        .collect();
                    (
                        names[0].clone(),
                        format!("{} — drives {}", cell.cap, names.join(" · ")),
                    )
                }
                None => (String::new(), String::new()),
            };
            NocturneKeyCell {
                cap: cell.cap.to_owned(),
                cls,
                short,
                title,
            }
        };
        let kb_rows: Vec<Vec<NocturneKeyCell>> = crate::keyboard_layout::ROWS
            .iter()
            .map(|row| row.iter().map(dress).collect())
            .collect();
        let mut kb_rows = kb_rows.into_iter();
        let kb_row1 = kb_rows.next().unwrap_or_default();
        let kb_row2 = kb_rows.next().unwrap_or_default();
        let kb_row3 = kb_rows.next().unwrap_or_default();
        let kb_row4 = kb_rows.next().unwrap_or_default();
        let kb_row5 = kb_rows.next().unwrap_or_default();
        let kb_row6 = kb_rows.next().unwrap_or_default();
        // Off-board keys: bound in the table but not on the standard board.
        let board_keys: std::collections::BTreeSet<&str> = crate::keyboard_layout::ROWS
            .iter()
            .flat_map(|row| row.iter())
            .filter(|cell| !cell.key.is_empty())
            .map(|cell| cell.key)
            .collect();
        let kb_tray: Vec<NocturneKeyCell> = key_fns
            .iter()
            .filter(|(key, _)| !board_keys.contains(*key))
            .map(|(key, fns)| {
                let names: Vec<String> = fns
                    .iter()
                    .map(|f| crate::keyboard_layout::short_for(persona, f))
                    .collect();
                NocturneKeyCell {
                    cap: (*key).to_owned(),
                    cls: if fns.len() > 1 {
                        "n-key tray bound shared".to_owned()
                    } else {
                        "n-key tray bound".to_owned()
                    },
                    short: names[0].clone(),
                    title: format!("{key} — drives {}", names.join(" · ")),
                }
            })
            .collect();
        let kb_tray_head = format!("Bound off this board · {}", kb_tray.len());
        let kb_tray_cls = if kb_tray.is_empty() {
            "n-kbtray none".to_owned()
        } else {
            "n-kbtray".to_owned()
        };
        let kb_note = match selected {
            Some(slot) if mapper.is_some() => format!(
                "Key shorts show what drives P{} · {} — on a standard board layout.",
                slot.number, slot.persona_label
            ),
            _ => String::new(),
        };

        let binds = workspace_bind_rows(staged, selected);
        let bind_rows: Vec<NocturneBindRow> = binds
            .rows
            .iter()
            .map(|row| {
                // The mapper's own unbound placeholder (`key_tag`).
                let bound = row.keys != "—";
                NocturneBindRow {
                    function: row.function.clone(),
                    label: row.label.clone(),
                    chip: if bound {
                        row.keys.clone()
                    } else {
                        "Unbound".to_owned()
                    },
                    note: row.notes.clone(),
                    cls: if bound {
                        "n-bind on".to_owned()
                    } else {
                        "n-bind".to_owned()
                    },
                    chip_cls: if bound {
                        "n-keychip".to_owned()
                    } else {
                        "n-keychip ghost".to_owned()
                    },
                    clear_cls: if bound {
                        "n-bclear".to_owned()
                    } else {
                        "n-bclear none".to_owned()
                    },
                    slot: row.slot.clone(),
                }
            })
            .collect();

        Self {
            version,
            chip_text,
            save_text,
            escape_line,
            play_cls,
            stop_cls,
            rack_rows,
            rack_empty,
            rack_caption,
            add_lede,
            add_preset,
            persona_rows,
            layout_opts,
            socd_opts,
            pad_badge,
            pad_name,
            pad_sub,
            bind_title: binds.title,
            bind_rows,
            bind_foot: binds.foot,
            kb_row1,
            kb_row2,
            kb_row3,
            kb_row4,
            kb_row5,
            kb_row6,
            kb_tray,
            kb_tray_head,
            kb_tray_cls,
            kb_note,
            dev_count,
            dev_note,
            kb_title,
            dev_rows,
            dev_exp,
            dev_other,
            exp_head,
            exp_fold_cls,
            other_head,
            other_fold_cls,
            mode_rows,
            mode_note,
            cap_line,
            capd_cls,
            cap_sw_cls,
            cap_selector: cap.expected_selector.clone(),
            cap_instance: cap.instance_id.clone(),
            cap_prepare,
            cap_release,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The saved answer is marked, and an unconfigured machine claims
    /// nothing.**
    ///
    /// The three answers come from `BlockingOption::roster()` - the same list
    /// `/start` asks with - so this pins the part that is genuinely this page's
    /// own: which one is chosen, and what the line says when there is nothing
    /// to choose from yet. An unconfigured machine has a default in MEMORY,
    /// and printing that as though somebody had picked it sends a person
    /// hunting for a setting they never set.
    #[test]
    fn the_saved_split_or_freeze_answer_is_the_marked_one() {
        let configured = ksx_api::SetupView {
            config_exists: true,
            blocking: "whole".to_owned(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        let rows = SetupRows::of(&SetupSnapshot::ready(configured.clone())).blocking;
        assert_eq!(
            rows.len(),
            3,
            "every answer is offered, not just the others"
        );
        let chosen: Vec<&str> = rows
            .iter()
            .filter(|r| r.chosen_cls.contains("pill-ok"))
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(chosen, ["whole"], "exactly the saved answer is marked");
        assert!(
            rows.iter()
                .find(|r| r.name == "whole")
                .is_some_and(|r| r.button.contains("how it is set")),
            "the current answer does not invite a no-op write"
        );

        let line = blocking_line(&configured);
        assert!(line.starts_with("Freeze this keyboard"), "{line}");

        // Nothing configured: no answer to report, and none invented.
        let fresh = ksx_api::SetupView {
            config_exists: false,
            blocking: String::new(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        let fresh_line = blocking_line(&fresh);
        assert!(
            fresh_line.contains("Nothing is configured yet"),
            "{fresh_line}"
        );
        for option in ksx_api::BlockingOption::roster() {
            assert!(
                !fresh_line.contains(&option.title),
                "an unset machine must not read as having chosen {}: {fresh_line}",
                option.title
            );
        }

        // A value this build does not know (an older or hand-edited config) is
        // NAMED, not smoothed over - the next session will act on it.
        let strange = ksx_api::SetupView {
            config_exists: true,
            blocking: "half-on".to_owned(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        let strange_line = blocking_line(&strange);
        assert!(strange_line.contains("half-on"), "{strange_line}");
        assert!(
            SetupRows::of(&SetupSnapshot::ready(strange))
                .blocking
                .iter()
                .all(|r| !r.chosen_cls.contains("pill-ok")),
            "an unknown value marks none of the three as in use"
        );
    }

    /// **A stale registration offers the REPAIR, not the removal.**
    ///
    /// The subtle case, and the one a cabinet actually lands in: ksx is
    /// reinstalled, the scheduled task keeps the old path, and the machine
    /// would cold-boot to nothing. Deriving the button from `registered` alone
    /// would offer "stop starting ksx at sign-in" - which is already what the
    /// machine effectively does, and would leave the user in the broken state
    /// with the fix nowhere on screen. Turning it ON again rewrites the task.
    ///
    /// Also pins the third state apart from the other two: a read that
    /// REFUSED must not render as "off" (`SURFACES.md` §1b) - "nothing is
    /// registered" and "nobody could ask" are different sentences.
    #[test]
    fn a_stale_logon_task_offers_the_repair_and_an_unreadable_one_claims_nothing() {
        let card = |view: Option<ksx_api::AutostartView>| {
            StartAutostartView::of(&StartPayload {
                autostart_read: view,
                ..StartPayload::default()
            })
        };

        let stale = card(Some(ksx_api::AutostartView {
            registered: true,
            line: "registered".into(),
            stale: true,
            stale_detail: Some("points somewhere else".into()),
            ..ksx_api::AutostartView::default()
        }));
        assert!(stale.enable, "a stale task must offer to be rewritten");
        assert!(stale.stale && !stale.stale_detail.is_empty());
        assert!(stale.button.contains("Start ksx"), "{}", stale.button);

        let healthy = card(Some(ksx_api::AutostartView {
            registered: true,
            line: "registered".into(),
            ..ksx_api::AutostartView::default()
        }));
        assert!(!healthy.enable, "a working task offers to be turned off");

        let off = card(Some(ksx_api::AutostartView::default()));
        assert!(off.enable && off.readable && !off.registered);

        let unreadable = card(None);
        assert!(!unreadable.readable, "a refused read is not an answer");
        assert!(
            !unreadable.registered,
            "and it must never be reported as registered either"
        );
        assert!(
            !unreadable.line.contains("does not start on its own"),
            "an unreadable scheduler must not claim ksx is off: {}",
            unreadable.line
        );
    }

    /// **The four-player panel, layout menu untouched** - `FIRST-RUN.md` §1
    /// moment 5, pressed four times.
    ///
    /// A template's player block is chosen by SLOT NUMBER (`ksx_api`'s
    /// `instantiate`, `player = number`), so "Add this controller" with the
    /// `<select>` left alone sends whatever `layout_options` put first. Every
    /// in-box layout except `arcade-4way` carries at most two blocks, so
    /// before the sort knew the next slot number the THIRD press was refused
    /// outright with `TemplateError::NoSuchPlayer` - the wall a four-player
    /// cabinet walks into, reported as "Reopen ksx and try again".
    ///
    /// Driven through the real `StageEdit::apply` rather than asserting an
    /// order, and deliberately never naming `arcade-4way`: an assertion on
    /// that id would keep passing if the sort broke and that template merely
    /// happened to stay first.
    #[test]
    fn adding_four_controllers_without_touching_the_layout_menu_is_accepted() {
        let mut setup = ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".to_owned(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
        }
        .apply(&ksx_core::stage::StagedSetup::new())
        .expect("staging the panel");

        for expected in 1..=4u8 {
            let view = ksx_api::StagedSetupView::of(&setup);
            assert_eq!(view.next_slot, Some(expected), "slot order");

            // Exactly what the untouched form posts: the first option, and the
            // served preset name.
            let offered = layout_options(&view);
            let first = offered.first().expect("a layout to offer").value.clone();
            let persona = view
                .personas
                .iter()
                .find(|p| p.can_plug)
                .expect("a persona this build can plug")
                .name
                .clone();

            setup = ksx_api::StageEdit::AddSlot {
                number: None,
                persona,
                preset: view.next_preset.clone().expect("a served preset name"),
                layout: Some(first.clone()),
            }
            .apply(&setup)
            .unwrap_or_else(|refusal| {
                panic!(
                    "player {expected} refused the layout the menu offered first \
                     ({first}): {}",
                    refusal.message
                )
            });
        }

        assert_eq!(ksx_api::StagedSetupView::of(&setup).slots.len(), 4);
    }
    #[test]
    fn saved_games_derivation_preserves_revisions_and_offers_only_valid_layouts() {
        let payload = ProfilesPayload {
            profiles: ksx_api::ProfilesView {
                profiles: vec![ksx_api::ProfileDetail {
                    revision: "g1-row".to_owned(),
                    title: "Example Game".to_owned(),
                    path: "steam://rungameid/620".to_owned(),
                    slots: 2,
                    presets: vec!["Arcade".to_owned()],
                    state: "launcher".to_owned(),
                    ..ksx_api::ProfileDetail::default()
                }],
                ..ksx_api::ProfilesView::default()
            },
            presets: ksx_api::PresetsView {
                presets: vec![
                    ksx_api::PresetRow {
                        name: "Broken".to_owned(),
                        usable: false,
                        problem: Some("This controller layout needs attention.".to_owned()),
                        ..ksx_api::PresetRow::default()
                    },
                    ksx_api::PresetRow {
                        name: "Keyboard".to_owned(),
                        usable: true,
                        ..ksx_api::PresetRow::default()
                    },
                    ksx_api::PresetRow {
                        name: "Arcade".to_owned(),
                        usable: true,
                        ..ksx_api::PresetRow::default()
                    },
                ],
                ..ksx_api::PresetsView::default()
            },
            session: crate::control::SessionView {
                reachable: true,
                running: false,
                line: "idle — daemon pipe reachable".to_owned(),
                profile: None,
                // Idle: nothing ran, so nothing is known about what it would
                // have been built from. `Unknown` is that, not a guess at
                // `Config`.
                origin: ksx_api::SessionOrigin::Unknown,
                active: None,
            },
            ..ProfilesPayload::default()
        };
        let derived = ProfilesDerived::of(&payload);
        assert_eq!(derived.profile_rows[0].revision, "g1-row");
        assert_eq!(
            derived.profile_rows[0]
                .layout_options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["Arcade", "Keyboard"],
            "the current valid layout is first and invalid layouts are absent"
        );
        assert_eq!(
            derived
                .preset_options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["Keyboard", "Arcade"]
        );
        assert_eq!(derived.preset_rows[0].statelabel, "needs attention");
        assert_eq!(derived.play_status, "Ready to play.");
        assert!(!derived.play_status.to_ascii_lowercase().contains("daemon"));
    }

    #[test]
    fn failed_saved_games_read_disables_add_edit_and_play_rows() {
        let payload = ProfilesPayload {
            profiles_error: Some("an internal parser detail".to_owned()),
            presets: ksx_api::PresetsView {
                presets: vec![ksx_api::PresetRow {
                    name: "Arcade".to_owned(),
                    usable: true,
                    ..ksx_api::PresetRow::default()
                }],
                ..ksx_api::PresetsView::default()
            },
            session: crate::control::SessionView {
                reachable: true,
                running: false,
                ..crate::control::SessionView::default()
            },
            ..ProfilesPayload::default()
        };
        let derived = ProfilesDerived::of(&payload);
        assert!(derived.profiles_unreadable);
        assert!(!derived.can_make_profile);
        assert!(!derived.rows_live);
        assert!(!derived.rows_plain);
    }

    /// Internal starter-layout ids are form values, never customer copy. The
    /// full served roster still drives the options and comparison rows, while
    /// a failed read promises none of it.
    #[test]
    fn the_template_intro_never_exposes_internal_ids() {
        let row = |id: &str| ksx_api::TemplateRow {
            id: id.to_owned(),
            label: String::new(),
            detail: String::new(),
            players: vec![1],
            blank: false,
        };
        let templates = [row("arcade-6button"), row("keyboard-2p"), row("empty")];

        let intro = templates_intro(&templates, false);
        for t in &templates {
            assert!(!intro.contains(&t.id), "internal id leaked: {intro}");
        }
        assert!(intro.contains("Choose a starter layout"), "{intro}");

        let refused = templates_intro(&templates, true);
        for t in &templates {
            assert!(
                !refused.contains(&t.id),
                "a failed read must not enumerate templates: {refused}"
            );
        }
    }

    /// The payload's field names are client contract (StatusIsland.ts reads
    /// them); pin the envelope on top of the snapshot's own pinned names
    /// (`ksx-api`'s `status` module keeps those).
    #[test]
    fn payload_serializes_to_stable_envelope_field_names() {
        let payload = StatusPayload {
            snapshot: StatusSnapshot {
                generated_at: "2026-08-04 12:00:00 UTC".into(),
                ..StatusSnapshot::default()
            },
            session: crate::control::SessionView {
                reachable: true,
                running: false,
                line: "idle — daemon reachable".into(),
                profile: None,
                origin: ksx_api::SessionOrigin::Unknown,
                active: None,
            },
            flash: None,
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            v.pointer("/snapshot/generated_at"),
            Some(&serde_json::json!("2026-08-04 12:00:00 UTC"))
        );
        assert_eq!(
            v.pointer("/session/reachable"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            v.pointer("/session/running"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            v.pointer("/session/line"),
            Some(&serde_json::json!("idle — daemon reachable"))
        );
        // `flash` is always present (null when absent) — the client types it
        // `string | null`, not optional.
        assert_eq!(v.pointer("/flash"), Some(&serde_json::json!(null)));
    }

    /// The same rule for the setup envelope: `SetupIsland.ts` reads these
    /// names, and the poller overwrites the signals the SSR paint seeded, so a
    /// rename on either side has to be a test failure rather than a page that
    /// flickers back to its defaults every two seconds.
    #[test]
    fn the_setup_payload_envelope_names_are_stable() {
        let payload = SetupPayload {
            setup: SetupSnapshot::ready(ksx_api::SetupView {
                config_root: "C:\\cfg\\ksx".into(),
                config_exists: true,
                ..ksx_api::SetupView::default()
            }),
            session: crate::control::SessionView::default(),
            learn: crate::control::LearnView::unavailable("no daemon"),
            flash: None,
            ..SetupPayload::default()
        }
        .composed();
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(
            v.pointer("/setup/available"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            v.pointer("/setup/view/config_root"),
            Some(&serde_json::json!("C:\\cfg\\ksx"))
        );
        assert_eq!(
            v.pointer("/setup/view/config_exists"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            v.pointer("/setup/view/steps"),
            Some(&serde_json::json!([])),
            "steps must always be an array — the page renders a list, not a maybe"
        );
        assert_eq!(
            v.pointer("/learn/state"),
            Some(&serde_json::json!("unavailable"))
        );
        assert_eq!(v.pointer("/flash"), Some(&serde_json::json!(null)));
        // The two DERIVED halves are part of the envelope too: `SetupIsland.ts`
        // reads `lines.*` and `flags.*` by these exact names and renders them
        // without deriving anything, so a rename here is a page that shows its
        // compile-time placeholders for ever.
        assert_eq!(
            v.pointer("/lines/config"),
            Some(&serde_json::json!(
                "Configured — 0 board(s), 0 slot(s), 0 preset(s)."
            ))
        );
        assert_eq!(
            v.pointer("/lines/wire_blocked"),
            Some(&serde_json::json!(
                "disabled — no daemon is running to take the write, and there is no preset \
                 on disk for a slot to point at. Start the daemon, and import or create a \
                 preset."
            ))
        );
        assert_eq!(
            v.pointer("/flags/setup_known"),
            Some(&serde_json::json!(true))
        );
        assert_eq!(
            v.pointer("/flags/no_boards"),
            Some(&serde_json::json!(true))
        );

        // A refused provider still produces the whole envelope, with the reason
        // in it: the page must be able to SAY why it has nothing.
        let down = SetupPayload {
            setup: SetupSnapshot::unavailable("no machine provider on this surface"),
            ..SetupPayload::default()
        };
        let v = serde_json::to_value(&down).unwrap();
        assert_eq!(
            v.pointer("/setup/available"),
            Some(&serde_json::json!(false))
        );
        assert_eq!(
            v.pointer("/setup/source"),
            Some(&serde_json::json!("no machine provider on this surface"))
        );
    }

    fn live_session() -> crate::control::SessionView {
        crate::control::SessionView {
            reachable: true,
            running: true,
            line: "running — 4 pad(s)".into(),
            profile: None,
            origin: ksx_api::SessionOrigin::Config,
            active: None,
        }
    }

    fn idle_learner() -> crate::control::LearnView {
        crate::control::LearnView {
            ok: true,
            state: "idle".into(),
            generation: None,
            remaining_ms: None,
            device: None,
            key: None,
            error: None,
        }
    }

    /// **"I could not read this" and "there is nothing here" are different
    /// sentences.**
    ///
    /// The signature bug of this project, in the config seam: a session once
    /// reported success while the arcade panel was dead, because a WinUSB board
    /// had fallen back to Interception. A page that renders a refused read as
    /// an empty machine makes the same trade — it converts "unknown" into a
    /// confident "nothing", and the user acts on it (they import, or they go
    /// looking for the board they were told is not named).
    ///
    /// This fails against the shipped version, where only `config` carried the
    /// `available` guard: there, every other line below was byte-identical to
    /// the empty-but-successfully-read machine's, and `no_boards` / `no_slots`
    /// were both true with nothing read.
    #[test]
    fn a_refused_read_is_never_rendered_as_an_empty_machine() {
        let session = live_session();
        let learn = idle_learner();

        let refused = SetupSnapshot::unavailable("no machine provider on this surface");
        let refused_lines = SetupLines::of(&refused, &session, &learn);
        let refused_flags = SetupFlags::of(&refused, &session, &learn);

        // A machine that WAS read and really holds nothing. Every sentence
        // below is the honest version of "there is nothing here".
        let empty = SetupSnapshot::ready(ksx_api::SetupView::default());
        let empty_lines = SetupLines::of(&empty, &session, &learn);
        let empty_flags = SetupFlags::of(&empty, &session, &learn);

        for (what, refused_line, empty_line) in [
            ("config", &refused_lines.config, &empty_lines.config),
            ("boards", &refused_lines.boards, &empty_lines.boards),
            ("slots", &refused_lines.slots, &empty_lines.slots),
            ("library", &refused_lines.library, &empty_lines.library),
            ("export", &refused_lines.export, &empty_lines.export),
            (
                "wire_blocked",
                &refused_lines.wire_blocked,
                &empty_lines.wire_blocked,
            ),
        ] {
            assert_ne!(
                refused_line, empty_line,
                "the {what} line says the same thing whether the read failed or the \
                 machine is empty: {refused_line:?}"
            );
        }

        // …and not one flag that would render an "it is empty" sentence.
        assert!(refused_flags.setup_down && !refused_flags.setup_known);
        for (what, on) in [
            ("no_boards", refused_flags.no_boards),
            ("no_slots", refused_flags.no_slots),
            ("has_boards", refused_flags.has_boards),
            ("has_slots", refused_flags.has_slots),
            ("has_notes", refused_flags.has_notes),
            ("first_run", refused_flags.first_run),
            ("configured", refused_flags.configured),
            // A daemon is reachable here: only the unreadable config stops it.
            ("can_wire", refused_flags.can_wire),
        ] {
            assert!(
                !on,
                "a refused read lit {what}, which renders a claim about a machine \
                 nothing was read from"
            );
        }
        // The empty-but-read machine still says all of those, loudly — the
        // guard must not have flattened both states into silence.
        assert!(empty_flags.setup_known && empty_flags.no_boards && empty_flags.no_slots);
        assert!(empty_lines
            .config
            .contains("no configuration on this machine"));
    }

    /// A disabled control names the reason that is TRUE, not the union of every
    /// reason it could have been.
    ///
    /// Fails against the shipped version, which rendered one static sentence
    /// ("Start the daemon, and import or create a preset first") for both
    /// single-cause states — telling a user with a live daemon to start it.
    #[test]
    fn a_disabled_control_names_the_cause_that_actually_fired() {
        let learn = idle_learner();
        let with_presets = SetupSnapshot::ready(ksx_api::SetupView {
            presets: vec!["Panel P1".into()],
            ..ksx_api::SetupView::default()
        });
        let no_presets = SetupSnapshot::ready(ksx_api::SetupView::default());
        let up = live_session();
        let down = crate::control::SessionView::unreachable("no daemon");

        // Daemon UP, no preset: it must not tell them to start the daemon.
        let a = SetupLines::of(&no_presets, &up, &learn).wire_blocked;
        assert!(a.contains("preset"), "{a}");
        assert!(
            !a.to_lowercase().contains("start the daemon"),
            "told a user with a running daemon to start it: {a}"
        );

        // Daemon DOWN, presets on disk: it must not tell them to make a preset.
        let b = SetupLines::of(&with_presets, &down, &learn).wire_blocked;
        assert!(b.contains("daemon"), "{b}");
        assert!(
            !b.contains("preset new") && !b.contains("not one on disk"),
            "told a user with presets on disk to go and create one: {b}"
        );
        assert_ne!(a, b, "the two causes must not share one sentence");

        // Both wrong: one sentence, both facts.
        let both = SetupLines::of(&no_presets, &down, &learn).wire_blocked;
        assert!(both.contains("daemon") && both.contains("preset"), "{both}");

        // The learner's two down-states are likewise distinct — a reachable
        // daemon with a dead listener must not be told there is no daemon.
        let listener_dead = crate::control::LearnView::unavailable("no listener in this build");
        let dead_listener_line = SetupLines::of(&with_presets, &up, &listener_dead).prove_blocked;
        assert!(
            dead_listener_line.contains("the daemon is running"),
            "a live daemon with a dead listener was told there is no daemon: \
             {dead_listener_line}"
        );
        let no_daemon_line = SetupLines::of(&with_presets, &down, &listener_dead).prove_blocked;
        assert_ne!(dead_listener_line, no_daemon_line);
        // …and a working listener says nothing at all.
        assert_eq!(SetupLines::of(&with_presets, &up, &learn).prove_blocked, "");
    }

    /// The pad-bounce warning is about the session there IS.
    ///
    /// Fails against the shipped version, whose warning was unconditional: the
    /// wire form is offered whenever the daemon is REACHABLE, so an idle daemon
    /// got "every controller vanishes and comes back" for a write that would
    /// replug nothing.
    #[test]
    fn the_pad_bounce_warning_follows_the_running_session() {
        let learn = idle_learner();
        let view = SetupSnapshot::ready(ksx_api::SetupView::default());
        let idle = crate::control::SessionView {
            running: false,
            ..live_session()
        };

        let running_line = SetupLines::of(&view, &live_session(), &learn).wire_warning;
        assert!(running_line.contains("REPLUGS the pads"), "{running_line}");

        let idle_line = SetupLines::of(&view, &idle, &learn).wire_warning;
        assert!(
            !idle_line.contains("REPLUGS the pads"),
            "an idle daemon was told its controllers would vanish: {idle_line}"
        );
        assert!(idle_line.contains("Nothing is running"), "{idle_line}");
    }

    /// The composed halves are DERIVED: mutate a fact and the sentence beside
    /// it changes with it. A payload that cached its lines at construction
    /// would serve the old ones here.
    #[test]
    fn composing_a_payload_re_derives_its_lines_from_its_facts() {
        let payload = SetupPayload {
            setup: SetupSnapshot::ready(ksx_api::SetupView::default()),
            session: live_session(),
            learn: idle_learner(),
            flash: None,
            ..SetupPayload::default()
        }
        .composed();
        assert!(payload.lines.config.contains("no configuration"));
        assert!(payload.flags.setup_known);

        let mut refused = payload.clone();
        refused.setup = SetupSnapshot::unavailable("no machine provider");
        let refused = refused.composed();
        assert_eq!(refused.lines.config, UNREADABLE);
        assert!(refused.flags.setup_down && !refused.flags.no_boards);

        // Every field of both derived halves really moved.
        assert_ne!(payload.lines, refused.lines);
        assert_ne!(payload.flags, refused.flags);
    }

    /// The ROW sentences are composed here and nowhere else. This pins the
    /// exact strings both seams (render_setup.rs's SSR injection and
    /// SetupIsland.ts's poll) now read verbatim — the formatters they used to
    /// each own are gone, so this is the only place a row wording can change.
    #[test]
    fn the_setup_rows_are_composed_once_from_the_view() {
        let view = ksx_api::SetupView {
            devices: vec![ksx_api::SetupDeviceRow {
                alias: "P1 board".to_owned(),
                id: "usb:d209:0430:00".to_owned(),
                backend: "interception".to_owned(),
            }],
            slots: vec![ksx_api::SetupSlotRow {
                number: 3,
                device: "P1 board".to_owned(),
                preset: "Panel P1".to_owned(),
                persona: "Xbox 360 pad".to_owned(),
                socd: String::new(),
                source: "config.toml".to_owned(),
            }],
            presets: vec!["Panel P1".to_owned()],
            profiles: vec!["Example Game".to_owned()],
            steps: vec![ksx_api::SetupStep {
                id: ksx_api::setup_steps::SLOT.to_owned(),
                title: "Wire a slot".to_owned(),
                detail: "One slot is wired.".to_owned(),
                state: ksx_api::setup_states::NOW.to_owned(),
            }],
            notes: vec!["a note".to_owned()],
            ..ksx_api::SetupView::default()
        };
        let rows = SetupRows::of(&SetupSnapshot::ready(view));

        assert_eq!(rows.steps[0].badge, "1");
        assert_eq!(rows.steps[0].cls, "step now");
        assert_eq!(rows.devices[0].title, "P1 board");
        assert_eq!(rows.devices[0].detail, "interception · usb:d209:0430:00");
        assert_eq!(rows.slots[0].title, "Slot 3 — Panel P1");
        assert_eq!(
            rows.slots[0].detail,
            "P1 board · Xbox 360 pad · config.toml"
        );
        assert_eq!(rows.preset_options[0].text, "Panel P1");
        assert_eq!(
            rows.persona_options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            ["xbox360", "playstation", "dualsense"],
            "the maintenance menu offers every live persona and no gated one"
        );
        assert_eq!(rows.persona_options[0].label, "Xbox 360 · ViGEmBus");
        assert_eq!(
            rows.persona_options[2].label,
            "DualSense · HIDMaestro · one per session"
        );
        assert_eq!(rows.profile_options[0].text, "Example Game");
        assert_eq!(rows.notes[0].text, "a note");

        // The menu is 1..=the ceiling the BACKEND serves — never a literal in
        // a view layer (the shipped page held `SLOT_CHOICES = 8` in two
        // languages while `ksx_core::MAX_SLOTS` was 16).
        assert_eq!(rows.slot_options.len(), usize::from(ksx_core::MAX_SLOTS));
        assert_eq!(rows.slot_options[0].value, "1");
        assert_eq!(rows.slot_options[0].label, "Slot 1");
        let last = rows.slot_options.last().unwrap();
        assert_eq!(last.value, ksx_core::MAX_SLOTS.to_string());
    }
}
