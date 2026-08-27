//! **What somebody pressed, and what somebody typed — kept on the server.**
//!
//! # Why this file exists at all
//!
//! `docs/SURFACES.md` §"Where this is currently broken" calls the Control
//! Surface document "the largest one" and the only *whole document class the
//! backend has never heard of*: `physicalId` and `physicalResolution` are
//! measurements about hardware that live in `window.localStorage` under
//! `ksx-nocturne-control-surfaces1` and nowhere else. Three live defects follow
//! from that, all named there: export/import silently drops it, the CLI and the
//! cabinet cannot see it, and clearing browser data is an undocumented
//! destructive product operation.
//!
//! The same section names the forcing function — "the first returning verb
//! therefore either adopts this document into `ksx-api` or ships a second,
//! disagreeing copy of the same fact — which is the moment to pay it off." The
//! chart verb returned. This is the payment: the durable half of that document,
//! server-side, reachable by every surface at once.
//!
//! # Why this is not `panel_profiles`, and not `boards`
//!
//! [`crate::panel_profiles`] holds what a terminal SHOULD emit — a semantic
//! layout that can be programmed ONTO a board, which is why it refuses anything
//! but the exact 56 terminal ids. [`crate::boards`] holds a picture somebody
//! drew. This store holds neither: it holds **evidence about a specific physical
//! board**, gathered from Windows and from the person at the cabinet, and it can
//! never be programmed anywhere. Its rows are not a layout, and a layout must
//! never be able to overwrite them.
//!
//! What the three DO share is the discipline, so that is what is reused rather
//! than reimplemented: [`crate::panel_profiles::StoreLease`] for the
//! cross-process compare-and-replace and [`crate::panel_profiles::write_atomic`]
//! so a reader never sees a torn document.
//!
//! # The four rules this store exists to hold
//!
//! **1. It never caches a chart value.** A [`ksx_api::PanelChartEvidence::Read`]
//! is instantaneous truth about bytes the board holds *for the request that
//! produced it*; nothing in ksx watches a board between requests and WinIPAC can
//! rewrite one at any moment. So nothing decoded from a chart is stored here —
//! only observations, declarations, and the `image_sha256` each was taken
//! against. A cached chart value re-served later is precisely how a stale answer
//! is presented as fresh.
//!
//! **2. `vouching` is recomputed, never stored.** This is rule 1 in its
//! sharpest form and it is worth stating separately, because
//! [`ksx_api::PanelObservationVouching`] looks durable and is not.
//! `Vouched` means "a chart read *in this response* proves the board still holds
//! the image this observation was taken against" — a conclusion about a chart,
//! wearing an observation's clothes. It is therefore absent from every spec here
//! (a caller physically cannot supply it), forced to `Unproven` on write, and
//! forced to `Unproven` again on load so a hand-edited file cannot smuggle one
//! in. `Unproven` is the `Default`, and it fails closed.
//!
//! `attribution` is the opposite and is preserved exactly. It records how the
//! observation came to be FILED — a judgement made once, at capture, against
//! `against_image_sha256`. That is a durable fact about the past. Whether the
//! board still holds that image is a question only a live read can answer.
//!
//! **3. It does not take the programming lease.**
//! [`crate::panel_programming::PanelProgrammingLease`] is machine-wide,
//! zero-wait, and held for the whole lifetime of Play and of the input-test
//! observer. Taking it here would make writing an observation deadlock the
//! observer against itself — the flow whose entire purpose is producing
//! observations. `StoreLease` is keyed by DIRECTORY, and this store's directory
//! is its own, so it contends with nothing.
//!
//! **4. Reads take no lease of any kind.** `boards_at` and `profiles_at` both
//! had one removed for the same reason: the lease refuses a competitor rather
//! than queueing, so a two-second Studio poll and a save contended and whichever
//! lost was told another process held the store when it was the user's own page.
//! Durability never depended on it — every write lands through `write_atomic`,
//! so a reader sees the whole old file or the whole new one. What the lease DID
//! mask is the file-vanish race, which is handled below where it happens.
//!
//! # What is checked at this door
//!
//! The KEY, for `boards`'s reason: `ksx-studio` does not link `ksx-core` at
//! runtime and cannot resolve one, so a key that resolves to nothing would be
//! stored, shown, look bound, and match nothing forever.
//!
//! The ATTRIBUTION against its own evidence: `ChartUnique` and `SharedSignal`
//! both mean "a chart read was in hand", so neither is accepted without the hash
//! of the image it was in hand for. Accepting one would let the weakest source
//! in the product claim the strongest provenance in it.
//!
//! And the IMAGE HASH's shape, because a truncated one is a real hazard rather
//! than a hypothetical: the panel facade already renders `&image_sha256[..12]`
//! for display, and a display string stored as if it were the full hash would
//! compare unequal to every future read and quietly mark every observation
//! rewritten.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use ksx_api::{
    PanelDeclaredEvidence, PanelObservationAttribution, PanelObservationVouching,
    PanelObservedEvidence, Refusal,
};
use ksx_config::{ConfigRoot, Timestamp};
use ksx_platform::sha256::{hex_upper, Sha256};

use crate::panel_profiles::{write_atomic, StoreLease};

/// The noun a lease refusal uses for this store. `StoreLease` is shared with
/// the saved layouts and the drawn boards, and it carries this so an
/// observation write never claims that encoder layouts are busy.
const TERMINAL_OBSERVATIONS: &str = "terminal observations";

const OBSERVATIONS_SCHEMA: &str = "ksx.panel-observations.v1";
const OBSERVATIONS_EXTENSION: &str = ".ksxpanel-observations.json";

/// A generous ceiling well above any encoder ksx has measured (the I-PAC 4 has
/// 56), which stops a client with a broken terminal id from filling the config
/// root one junk row at a time.
const MAX_TERMINALS: usize = 512;

/// One press producing this many keys is already extraordinary. Past it the
/// burst is REFUSED rather than truncated: a 100-key macro silently filed as a
/// 64-key one is a false statement about the hardware, and the multi-key burst
/// is the only macro evidence a board with no macro reader will ever give.
const MAX_KEYS_PER_OBSERVATION: usize = 64;

const MAX_IDENTITY_CHARS: usize = 128;
const MAX_TERMINAL_ID_CHARS: usize = 48;
const MAX_DEVICE_CHARS: usize = 256;
const MAX_NOTE_CHARS: usize = 500;

/// Length of `hex_upper` over a SHA-256 digest, which is what every image hash
/// in the panel stack is.
const SHA256_HEX_LEN: usize = 64;

// ───────────────────────────────────────────────────────────────────────────
// Refusals
// ───────────────────────────────────────────────────────────────────────────

fn bad_request(message: impl Into<String>, remedy: impl Into<String>) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::BAD_REQUEST, message, remedy)
}

/// Store failures name the absolute folder. Authored copy belongs on a page;
/// a backend message that says "its observations folder" leaves the person
/// with nothing to check.
fn store_refusal(dir: &Path, message: impl Into<String>) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::REFUSED,
        message,
        format!(
            "make sure KSX can read and write {}, then try again",
            dir.display()
        ),
    )
}

fn root() -> Result<ConfigRoot, Refusal> {
    // The same resolution the saved layouts and the drawn boards use, so a
    // portable install keeps its observations with the cabinet they describe.
    ConfigRoot::discover().map_err(|error| {
        Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            format!(
                "KSX could not resolve the configuration root for terminal observations: {error}"
            ),
            "restore access to the KSX configuration folder, then try again",
        )
    })
}

// ───────────────────────────────────────────────────────────────────────────
// The document
// ───────────────────────────────────────────────────────────────────────────

/// **Which board, and which terminal model.**
///
/// Both halves, always. The fingerprint alone would let a future second driver
/// with its own terminal numbering read the I-PAC 4's rows and answer for
/// screws that do not exist on it; the signature alone would merge two physical
/// cabinets of the same model into one set of facts.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PanelBoardScope {
    /// The board fingerprint, as `panel_programming` derives it.
    pub board_fingerprint: String,
    /// The ordered terminal model, as `ipac4_terminal_signature` derives it.
    pub terminal_signature: String,
}

/// Everything durable ksx knows about ONE screw terminal.
///
/// Deliberately two `Option`s and nothing else. The composed sentence, the
/// chart evidence and the live vouching are all
/// [`ksx_api::PanelTerminalTruth`]'s business, computed per response from a
/// chart in hand. Storing any of them here would be storing a conclusion.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PanelObservationRow {
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<PanelObservedEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared: Option<PanelDeclaredEvidence>,
}

impl PanelObservationRow {
    fn is_empty(&self) -> bool {
        self.observed.is_none() && self.declared.is_none()
    }
}

/// **One document per board, every terminal row inside it, one revision.**
///
/// Matching [`ksx_api::PanelHardwareProfile`] rather than a file per terminal.
/// A terminal is not independently meaningful — "which of my buttons collide?"
/// is a question about a whole panel at one moment, and 56 files could be read
/// mid-rewrite and answer it from two different moments.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PanelObservationsDocument {
    pub schema: String,
    pub document_id: String,
    pub board_fingerprint: String,
    pub terminal_signature: String,
    pub revision: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub terminals: Vec<PanelObservationRow>,
}

/// What one board's stored facts look like to a caller.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PanelObservationsView {
    pub summary: String,
    /// Absolute, for the same reason the refusals carry one.
    pub config_root: String,
    pub board_fingerprint: String,
    pub terminal_signature: String,
    pub document_id: String,
    /// Empty when nothing has ever been stored for this board — which is the
    /// exact value a first write must pass as `expected_revision: None`.
    pub revision: String,
    pub terminals: Vec<PanelObservationRow>,
}

/// The outcome of one row-scoped write.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PanelObservationMutationView {
    /// `observed` | `declared` | `forgotten`.
    pub state: String,
    pub document_id: String,
    pub terminal_id: String,
    pub revision: String,
    pub summary: String,
}

// ───────────────────────────────────────────────────────────────────────────
// The specs
// ───────────────────────────────────────────────────────────────────────────

/// File what Windows received when somebody pressed a control.
///
/// There is no `observed_at` and no `vouching`, and both absences are the
/// point: the timestamp is the server's (a browser clock can be anything at
/// all, including a value that makes an observation look older than the chart
/// it was taken against), and vouching is a live judgement this store must
/// never be handed.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct PanelObserveSpec {
    pub scope: PanelBoardScope,
    pub terminal_id: String,
    /// `None` files this observation over whatever the row held. See
    /// [`check_revision`] for why that is an append rather than a lost update.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    /// Every canonical key the press produced, in arrival order.
    pub keys: Vec<String>,
    pub device: String,
    /// **Server knowledge, and never wire input.**
    ///
    /// `skip_deserializing` is the guard, not the doc comment above it. This
    /// spec derives `Deserialize`, so the day a route forwards a browser body
    /// into `record_observation` — the ordinary shape of every other route on
    /// this server — a page could assert the provenance of a chart read the
    /// server never performed. `ChartUnique` is the ONLY attribution that can
    /// reach `Matched`, and the image hash is the other half of that claim.
    ///
    /// Skipped, both fields fall to their weakest defaults (`Prompted`, no
    /// image) no matter what arrives, and a caller that has genuinely read a
    /// chart sets them in Rust from the read it holds.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub against_image_sha256: Option<String>,
    #[serde(default, skip_deserializing)]
    pub attribution: PanelObservationAttribution,
}

/// File what the person at the cabinet typed and locked in.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct PanelDeclareSpec {
    pub scope: PanelBoardScope,
    pub terminal_id: String,
    /// Required once this board has a document. A declaration is the one row
    /// no later press can reconstruct.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    /// A key name, or empty for "I know this one is unassigned".
    pub key: String,
    /// Server knowledge, for [`PanelObserveSpec::against_image_sha256`]'s
    /// reason: what ksx knew when this was locked in is a fact the server read,
    /// so a later contradiction can be stated as what CHANGED.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub against_image_sha256: Option<String>,
    #[serde(default)]
    pub note: String,
}

/// Drop one or both halves of one row, at the user's explicit request.
///
/// [`ksx_api::PanelDeclaredEvidence`] says a declaration is "never deleted or
/// silently corrected". Silently. Somebody asking to remove their own wrong
/// note is not ksx overruling them, and a store with no way to take one back
/// makes a typo permanent.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct PanelForgetSpec {
    pub scope: PanelBoardScope,
    pub terminal_id: String,
    /// Always required. Nothing is dropped from a document the caller has not
    /// actually seen.
    pub expected_revision: String,
    #[serde(default)]
    pub forget_observed: bool,
    #[serde(default)]
    pub forget_declared: bool,
}

// ───────────────────────────────────────────────────────────────────────────
// The verbs
// ───────────────────────────────────────────────────────────────────────────

/// Everything stored for one board. Never refuses merely because nothing has
/// been stored yet.
pub fn observations(scope: &PanelBoardScope) -> Result<PanelObservationsView, Refusal> {
    observations_at(&root()?, scope)
}

/// File one observation under one terminal.
pub fn record_observation(
    spec: &PanelObserveSpec,
) -> Result<PanelObservationMutationView, Refusal> {
    record_observation_at(&root()?, spec, Timestamp::now_utc())
}

/// File one declaration under one terminal.
pub fn declare(spec: &PanelDeclareSpec) -> Result<PanelObservationMutationView, Refusal> {
    declare_at(&root()?, spec, Timestamp::now_utc())
}

/// Drop what the caller names, and nothing else.
pub fn forget(spec: &PanelForgetSpec) -> Result<PanelObservationMutationView, Refusal> {
    forget_at(&root()?, spec, Timestamp::now_utc())
}

// ───────────────────────────────────────────────────────────────────────────
// Naming and identity
// ───────────────────────────────────────────────────────────────────────────

/// **The file key carries both halves of the scope.**
///
/// Derived by hashing rather than by spelling, so a fingerprint from a future
/// driver can contain any character at all and still become a name that cannot
/// leave this folder. The NUL separator is unambiguous because
/// [`normalize_identity`] refuses control characters, which is what stops
/// `("ab", "c")` and `("a", "bc")` from colliding.
///
/// Case is NOT folded. Two identity strings that differ only in case are two
/// identities; collapsing them would be this store guessing that a future
/// driver spells its fingerprints the way `panel_programming` does.
fn document_id(scope: &PanelBoardScope) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ksx.panel-observations.v1\0");
    hasher.update(b"board-fingerprint\0");
    hasher.update(scope.board_fingerprint.as_bytes());
    hasher.update(b"\0terminal-signature\0");
    hasher.update(scope.terminal_signature.as_bytes());
    let digest = hex_upper(&hasher.finish());
    format!("po1-{}", digest[..32].to_ascii_lowercase())
}

fn safe_document_id(id: &str) -> bool {
    id.len() == 36
        && id.starts_with("po1-")
        && id[4..].chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A document id becomes a filename, so the gate stays here even though
/// [`document_id`] can only ever produce a safe one. The next caller to build
/// an id some other way meets the same door.
fn document_path(dir: &Path, document_id: &str) -> Result<PathBuf, Refusal> {
    if !safe_document_id(document_id) {
        return Err(bad_request(
            format!("'{document_id}' is not an observations document id"),
            "re-read this board's observations and try the change again",
        ));
    }
    Ok(dir.join(format!("{document_id}{OBSERVATIONS_EXTENSION}")))
}

fn document_revision(document: &PanelObservationsDocument) -> String {
    let mut content = document.clone();
    content.revision.clear();
    let bytes =
        serde_json::to_vec(&content).unwrap_or_else(|_| format!("{content:?}").into_bytes());
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("po1r-{}", hex_upper(&hasher.finish()))
}

/// The same spelling every other store under this root uses, so the three
/// never disagree about what a timestamp looks like on disk.
fn timestamp_rfc3339(timestamp: Timestamp) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        timestamp.year,
        timestamp.month,
        timestamp.day,
        timestamp.hour,
        timestamp.minute,
        timestamp.second
    )
}

// ───────────────────────────────────────────────────────────────────────────
// Normalisation — every check here, nothing downstream
// ───────────────────────────────────────────────────────────────────────────

fn normalize_identity(value: &str, what: &str) -> Result<String, Refusal> {
    let value = value.trim();
    if value.is_empty() {
        return Err(bad_request(
            format!("this change names no {what}"),
            "select the encoder again so KSX knows which board this is about",
        ));
    }
    if value.chars().count() > MAX_IDENTITY_CHARS {
        return Err(bad_request(
            format!("the {what} is longer than KSX stores"),
            "select the encoder again so KSX knows which board this is about",
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(bad_request(
            format!("the {what} contains characters KSX cannot file"),
            "select the encoder again so KSX knows which board this is about",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_scope(scope: &PanelBoardScope) -> Result<PanelBoardScope, Refusal> {
    Ok(PanelBoardScope {
        board_fingerprint: normalize_identity(&scope.board_fingerprint, "board fingerprint")?,
        terminal_signature: normalize_identity(&scope.terminal_signature, "terminal signature")?,
    })
}

/// Syntax only, deliberately.
///
/// Refusing anything but the 56 I-PAC 4 ids is right for a portable LAYOUT,
/// which must be applicable to another board of the same model. It is wrong
/// here: the terminal signature in the file key already scopes this document to
/// one terminal model, and hardcoding a second copy of that model would make
/// the first future driver unable to file a single observation.
fn normalize_terminal_id(terminal_id: &str) -> Result<String, Refusal> {
    let terminal_id = terminal_id.trim();
    if terminal_id.is_empty() || terminal_id.chars().count() > MAX_TERMINAL_ID_CHARS {
        return Err(bad_request(
            "this change names no terminal",
            "choose a terminal on the panel and try again",
        ));
    }
    if !terminal_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(bad_request(
            format!("'{terminal_id}' is not a terminal id"),
            "choose a terminal on the panel and try again",
        ));
    }
    Ok(terminal_id.to_owned())
}

/// **The key gate**, for `boards::normalize_controls`'s reason.
///
/// The Studio owns no key vocabulary — it does not link `ksx-core` at runtime,
/// by design — so a key that resolves to nothing has to be refused at this
/// door or it is stored, shown, looks bound, and matches nothing forever. The
/// canonical spelling is what is kept, so two rows never disagree about how to
/// write one key.
fn canonical_key(raw: &str, terminal_id: &str) -> Result<String, Refusal> {
    let raw = raw.trim();
    match ksx_core::Key::from_name(raw) {
        Some(resolved) => Ok(resolved.name().to_owned()),
        None => Err(bad_request(
            format!("terminal '{terminal_id}' was recorded as sending '{raw}', which is not a key ksx can receive"),
            "press the control again so KSX can learn what it really sends",
        )),
    }
}

fn normalize_observed_keys(keys: &[String], terminal_id: &str) -> Result<Vec<String>, Refusal> {
    // **A press that produced nothing is not an observation.** Filing one would
    // assert that the terminal emits nothing, which this code cannot know: the
    // control may send a HID usage ksx does not observe, or the learner may
    // simply have been closed. A failed read is not an absence, and neither is
    // a quiet press.
    if keys.is_empty() {
        return Err(bad_request(
            format!("nothing arrived from terminal '{terminal_id}', so there is nothing to file"),
            "press the control again, and if nothing ever arrives leave the terminal unknown",
        ));
    }
    if keys.len() > MAX_KEYS_PER_OBSERVATION {
        return Err(bad_request(
            format!(
                "terminal '{terminal_id}' produced {} keys in one press; KSX files at most {MAX_KEYS_PER_OBSERVATION}",
                keys.len()
            ),
            "press the control once on its own, away from any held keys, and try again",
        ));
    }
    keys.iter()
        .map(|key| canonical_key(key, terminal_id))
        .collect()
}

fn normalize_device(device: &str, terminal_id: &str) -> Result<String, Refusal> {
    let device = device.trim();
    if device.is_empty() {
        return Err(bad_request(
            format!("the observation for terminal '{terminal_id}' names no device"),
            "run the press again from the input test so KSX records which device it arrived on",
        ));
    }
    if device.chars().count() > MAX_DEVICE_CHARS || device.chars().any(char::is_control) {
        return Err(bad_request(
            "the device this observation arrived on is not a device KSX can file",
            "run the press again from the input test",
        ));
    }
    Ok(device.to_owned())
}

/// `None` and `Some("")` are one state — taken with no chart — so the empty
/// spelling is folded away before it can be compared against a real hash and
/// look like a rewritten board.
///
/// Anything else must be a complete SHA-256. The panel facade already renders
/// `&image_sha256[..12]` for display, and a display string stored here would be
/// unequal to every later read forever.
fn normalize_image_sha256(value: &Option<String>) -> Result<Option<String>, Refusal> {
    let Some(value) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() != SHA256_HEX_LEN || !value.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad_request(
            "the chart image this was taken against is not a complete SHA-256",
            "read the board's chart again and file this against the full image hash",
        ));
    }
    Ok(Some(value.to_ascii_uppercase()))
}

/// **An attribution cannot claim evidence the row does not carry.**
///
/// `ChartUnique` means "a chart read in hand held this key on exactly one
/// terminal"; `SharedSignal` means it held it on more than one. Both are
/// statements about a chart. Without the hash of the image that chart came
/// from there is no chart, so accepting either would let the weakest source in
/// the product wear the strongest provenance in it — and `ChartUnique` is the
/// only attribution that can reach `Matched`.
fn check_attribution(
    attribution: PanelObservationAttribution,
    against_image_sha256: Option<&str>,
    keys: &[String],
) -> Result<(), Refusal> {
    let needs_chart = matches!(
        attribution,
        PanelObservationAttribution::ChartUnique | PanelObservationAttribution::SharedSignal
    );
    if needs_chart && against_image_sha256.is_none() {
        return Err(bad_request(
            "this observation claims a chart read backed it, and names no chart image",
            "read the board's chart first, then file the press against that image",
        ));
    }
    // A stored byte is ONE key. `panel_truth::attribute_press` already refuses
    // to call a burst chart-backed; this door has to refuse it too, because a
    // door that trusts one caller to have been careful is not a door. A durable
    // row carrying `ChartUnique` for an event no single stored byte can produce
    // is a lie that outlives the request that told it.
    if attribution == PanelObservationAttribution::ChartUnique && keys.len() != 1 {
        return Err(bad_request(
            "several keys arrived from one press, and no single stored byte can account for that, \
             so a chart read cannot have attributed it to one terminal",
            "file this press as prompted, or read the chart and attribute it from what the read holds",
        ));
    }
    Ok(())
}

fn normalize_note(note: &str) -> Result<String, Refusal> {
    let note = note.trim();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(bad_request(
            format!("a note is at most {MAX_NOTE_CHARS} characters"),
            "shorten the note and save it again",
        ));
    }
    if note
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(bad_request(
            "a note cannot contain control characters",
            "retype the note and save it again",
        ));
    }
    Ok(note.to_owned())
}

// ───────────────────────────────────────────────────────────────────────────
// Reading and writing the one document
// ───────────────────────────────────────────────────────────────────────────

/// Strip every conclusion a chart could have produced.
///
/// Called on load as well as on write, so a hand-edited or older file cannot
/// hand a caller a `Vouched` that no read in this response earned. The stored
/// `revision` is deliberately left alone: it is an opaque compare-and-replace
/// token, not a checksum of the bytes, and recomputing it here would make every
/// caller's held revision go stale for a change nobody made.
fn scrub_live_judgements(document: &mut PanelObservationsDocument) {
    for row in &mut document.terminals {
        if let Some(observed) = row.observed.as_mut() {
            observed.vouching = PanelObservationVouching::Unproven;
            observed.against_image_sha256 = scrub_image_hash(&observed.against_image_sha256);
        }
        if let Some(declared) = row.declared.as_mut() {
            declared.against_image_sha256 = scrub_image_hash(&declared.against_image_sha256);
        }
    }
}

/// **The write door's image check, applied on the way back IN.**
///
/// The two doors were asymmetric: a write refused anything that was not a full
/// SHA-256, and a load accepted whatever was on disk. So a hand-edited file — or
/// one written by an older build — carrying the 12-character DISPLAY hash sailed
/// through, and `panel_truth::corroborates` then compared it to a real 64-char
/// read hash, never matched, and reported that observation as taken against a
/// changed board FOREVER. That is the exact outcome the write-side check exists
/// to prevent, arriving by the other door.
///
/// Dropped to `None` rather than refusing the document: the press really did
/// happen, and losing the whole board's history to one bad field would be a
/// worse answer than an observation that cannot be vouched for.
fn scrub_image_hash(value: &Option<String>) -> Option<String> {
    normalize_image_sha256(value).unwrap_or(None)
}

fn validate_loaded(
    dir: &Path,
    path: &Path,
    mut document: PanelObservationsDocument,
    scope: &PanelBoardScope,
    expected_id: &str,
) -> Result<PanelObservationsDocument, Refusal> {
    // The scope check is requirement 2 actually enforced rather than assumed:
    // the file key derives from both halves, and the file also states both, so
    // a document that ever reached the wrong name is refused instead of
    // answering for a board it does not describe.
    if document.schema != OBSERVATIONS_SCHEMA
        || document.document_id != expected_id
        || document.board_fingerprint != scope.board_fingerprint
        || document.terminal_signature != scope.terminal_signature
        || document.revision.trim().is_empty()
        || document.created_at.trim().is_empty()
    {
        return Err(store_refusal(
            dir,
            format!(
                "{} does not describe this board, so KSX will not answer from it",
                path.display()
            ),
        ));
    }
    if document.terminals.len() > MAX_TERMINALS {
        return Err(store_refusal(
            dir,
            format!("{} holds more terminals than KSX reads", path.display()),
        ));
    }
    // Two rows for one terminal are one row to every later edit: an upsert
    // would land on whichever came first and the other would be invisible and
    // permanent.
    let mut seen = BTreeSet::new();
    for row in &document.terminals {
        if row.terminal_id.trim().is_empty() || !seen.insert(row.terminal_id.clone()) {
            return Err(store_refusal(
                dir,
                format!(
                    "{} files two rows under terminal '{}'",
                    path.display(),
                    row.terminal_id
                ),
            ));
        }
    }
    scrub_live_judgements(&mut document);
    Ok(document)
}

/// **No lease, and no `exists()` check.**
///
/// The vanish race is handled exactly here, where it happens: a document
/// removed between a caller deciding to read and this read landing is a board
/// with nothing stored, which is what the caller is about to be told anyway.
/// Asking `exists()` first would only move the race one line up.
fn load_document(
    dir: &Path,
    scope: &PanelBoardScope,
) -> Result<Option<PanelObservationsDocument>, Refusal> {
    let expected_id = document_id(scope);
    let path = document_path(dir, &expected_id)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(store_refusal(
                dir,
                format!(
                    "this board's observations could not be read ({}): {error}",
                    path.display()
                ),
            ));
        }
    };
    let document: PanelObservationsDocument = serde_json::from_slice(&bytes).map_err(|error| {
        store_refusal(
            dir,
            format!(
                "this board's observations are not readable JSON ({}): {error}",
                path.display()
            ),
        )
    })?;
    validate_loaded(dir, &path, document, scope, &expected_id).map(Some)
}

fn write_document(dir: &Path, document: &mut PanelObservationsDocument) -> Result<(), Refusal> {
    // Sorted, so the document is stable on disk and the revision of two
    // identical stores is identical.
    document
        .terminals
        .sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
    scrub_live_judgements(document);
    document.revision = document_revision(document);

    fs::create_dir_all(dir).map_err(|error| {
        store_refusal(
            dir,
            format!(
                "the observations folder {} could not be created: {error}",
                dir.display()
            ),
        )
    })?;
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        store_refusal(
            dir,
            format!("this board's observations could not be written: {error}"),
        )
    })?;
    write_atomic(
        TERMINAL_OBSERVATIONS,
        &document_path(dir, &document.document_id)?,
        &bytes,
    )
}

fn fresh_document(scope: &PanelBoardScope, now: &str) -> PanelObservationsDocument {
    PanelObservationsDocument {
        schema: OBSERVATIONS_SCHEMA.to_owned(),
        document_id: document_id(scope),
        board_fingerprint: scope.board_fingerprint.clone(),
        terminal_signature: scope.terminal_signature.clone(),
        revision: String::new(),
        created_at: now.to_owned(),
        updated_at: now.to_owned(),
        terminals: Vec::new(),
    }
}

/// **The compare-and-replace, and the one place it is relaxed.**
///
/// Every mutation here touches exactly ONE terminal row and leaves every other
/// row byte-identical. **The lease does not serialise those writers — it refuses
/// the second one.** `StoreLease::acquire` waits zero milliseconds by design, so
/// two presses arriving at once do not queue: the loser is told another process
/// is changing terminal observations, and the caller decides whether to press
/// again. That is a deliberately visible failure rather than a silent one, but
/// it is NOT the "neither loses anything" this comment used to claim, and the
/// difference matters to anyone reasoning about why the revision is optional.
///
/// `expected_revision` exists for the case that actually needs it: a caller that
/// read a row, showed it to a person, and is now replacing what that person saw.
/// When it is supplied it is enforced exactly, and a stale one refuses.
///
/// When it is absent the write is a row-scoped append. For an OBSERVATION that
/// is the correct semantics rather than a hole: pressing the control again
/// produces a fresher observation of what it emits now, and the fresher one
/// should win. Requiring a revision would also cost the input-test observer a
/// read-then-write round trip per press, which is how a store starts losing
/// races it never needed to enter.
///
/// A DECLARATION is different — it is a person's typed claim, and no later
/// press can reconstruct it — so `require` is set for that verb and only that
/// verb.
fn check_revision(
    current: Option<&PanelObservationsDocument>,
    expected: Option<&str>,
    require: bool,
    scope: &PanelBoardScope,
) -> Result<(), Refusal> {
    match (current, expected) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            format!(
                "nothing is stored for board '{}' any more; nothing was written",
                scope.board_fingerprint
            ),
            "re-read this board's observations and apply the change again",
        )),
        (Some(document), Some(expected)) => {
            if document.revision == expected {
                Ok(())
            } else {
                Err(Refusal::with_remedy(
                    ksx_api::codes::REFUSED,
                    format!(
                        "board '{}' changed while this edit was open; nothing was written",
                        scope.board_fingerprint
                    ),
                    "re-read this board's observations, review what changed, and apply the edit again",
                ))
            }
        }
        (Some(_), None) => {
            if require {
                Err(Refusal::with_remedy(
                    ksx_api::codes::REFUSED,
                    format!(
                        "board '{}' already holds facts, so this change needs the exact revision it was opened against",
                        scope.board_fingerprint
                    ),
                    "re-read this board's observations and save the declaration again",
                ))
            } else {
                Ok(())
            }
        }
    }
}

fn row_mut<'document>(
    document: &'document mut PanelObservationsDocument,
    terminal_id: &str,
) -> Result<&'document mut PanelObservationRow, Refusal> {
    let index = match document
        .terminals
        .iter()
        .position(|row| row.terminal_id == terminal_id)
    {
        Some(index) => index,
        None => {
            if document.terminals.len() >= MAX_TERMINALS {
                return Err(bad_request(
                    format!("this board already holds facts for {MAX_TERMINALS} terminals"),
                    "forget a terminal that is no longer on the panel and try again",
                ));
            }
            document.terminals.push(PanelObservationRow {
                terminal_id: terminal_id.to_owned(),
                observed: None,
                declared: None,
            });
            document.terminals.len() - 1
        }
    };
    Ok(&mut document.terminals[index])
}

// ───────────────────────────────────────────────────────────────────────────
// The verbs, with the root injected
// ───────────────────────────────────────────────────────────────────────────

fn observations_at(
    root: &ConfigRoot,
    scope: &PanelBoardScope,
) -> Result<PanelObservationsView, Refusal> {
    let dir = root.panel_observations_dir();
    let scope = normalize_scope(scope)?;
    let document = load_document(&dir, &scope)?;
    let terminals = document
        .as_ref()
        .map(|document| document.terminals.clone())
        .unwrap_or_default();
    Ok(PanelObservationsView {
        summary: match terminals.len() {
            0 => "Nothing has been observed or declared on this board yet.".to_owned(),
            1 => "1 terminal has something observed or declared.".to_owned(),
            n => format!("{n} terminals have something observed or declared."),
        },
        config_root: dir.display().to_string(),
        document_id: document_id(&scope),
        board_fingerprint: scope.board_fingerprint,
        terminal_signature: scope.terminal_signature,
        revision: document
            .as_ref()
            .map(|document| document.revision.clone())
            .unwrap_or_default(),
        terminals,
    })
}

fn record_observation_at(
    root: &ConfigRoot,
    spec: &PanelObserveSpec,
    timestamp: Timestamp,
) -> Result<PanelObservationMutationView, Refusal> {
    let dir = root.panel_observations_dir();
    let scope = normalize_scope(&spec.scope)?;
    let terminal_id = normalize_terminal_id(&spec.terminal_id)?;
    let keys = normalize_observed_keys(&spec.keys, &terminal_id)?;
    let device = normalize_device(&spec.device, &terminal_id)?;
    let against_image_sha256 = normalize_image_sha256(&spec.against_image_sha256)?;
    check_attribution(spec.attribution, against_image_sha256.as_deref(), &keys)?;
    let now = timestamp_rfc3339(timestamp);

    // This store's own directory, so this lease is not the layouts lease, not
    // the boards lease, and above all not the machine-wide programming lease
    // that Play and the input-test observer hold for their whole lifetime.
    let _lease = StoreLease::acquire(&dir, TERMINAL_OBSERVATIONS)?;
    let current = load_document(&dir, &scope)?;
    check_revision(
        current.as_ref(),
        spec.expected_revision.as_deref(),
        false,
        &scope,
    )?;

    let mut document = current.unwrap_or_else(|| fresh_document(&scope, &now));
    document.updated_at = now.clone();
    let row = row_mut(&mut document, &terminal_id)?;
    row.observed = Some(PanelObservedEvidence {
        keys: keys.clone(),
        observed_at: now,
        device,
        against_image_sha256,
        attribution: spec.attribution,
        // Never from the caller, never from disk. Whether anything still
        // stands behind this is a question only a live chart read answers.
        vouching: PanelObservationVouching::Unproven,
    });
    write_document(&dir, &mut document)?;

    Ok(PanelObservationMutationView {
        state: "observed".to_owned(),
        document_id: document.document_id.clone(),
        terminal_id: terminal_id.clone(),
        revision: document.revision.clone(),
        // "Filed under", not "emitted by": nothing here proves the person
        // pressed the screw the prompt named. That is what `attribution` is
        // for, and this sentence must not overstate it.
        summary: format!(
            "Observation filed under terminal '{terminal_id}': {}.",
            keys.join(", ")
        ),
    })
}

fn declare_at(
    root: &ConfigRoot,
    spec: &PanelDeclareSpec,
    timestamp: Timestamp,
) -> Result<PanelObservationMutationView, Refusal> {
    let dir = root.panel_observations_dir();
    let scope = normalize_scope(&spec.scope)?;
    let terminal_id = normalize_terminal_id(&spec.terminal_id)?;
    // Empty is not a typo here: "I know this one is unassigned" is a real
    // claim, and the only one a person can make about a terminal that stores
    // nothing they can see.
    let key = if spec.key.trim().is_empty() {
        String::new()
    } else {
        canonical_key(&spec.key, &terminal_id)?
    };
    let note = normalize_note(&spec.note)?;
    let against_image_sha256 = normalize_image_sha256(&spec.against_image_sha256)?;
    let now = timestamp_rfc3339(timestamp);

    let _lease = StoreLease::acquire(&dir, TERMINAL_OBSERVATIONS)?;
    let current = load_document(&dir, &scope)?;
    check_revision(
        current.as_ref(),
        spec.expected_revision.as_deref(),
        true,
        &scope,
    )?;

    let mut document = current.unwrap_or_else(|| fresh_document(&scope, &now));
    document.updated_at = now.clone();
    let row = row_mut(&mut document, &terminal_id)?;
    row.declared = Some(PanelDeclaredEvidence {
        key: key.clone(),
        declared_at: now,
        against_image_sha256,
        note,
    });
    write_document(&dir, &mut document)?;

    Ok(PanelObservationMutationView {
        state: "declared".to_owned(),
        document_id: document.document_id.clone(),
        terminal_id: terminal_id.clone(),
        revision: document.revision.clone(),
        summary: format!(
            "Declaration filed under terminal '{terminal_id}': {}.",
            if key.is_empty() {
                "unassigned"
            } else {
                key.as_str()
            }
        ),
    })
}

fn forget_at(
    root: &ConfigRoot,
    spec: &PanelForgetSpec,
    timestamp: Timestamp,
) -> Result<PanelObservationMutationView, Refusal> {
    let dir = root.panel_observations_dir();
    let scope = normalize_scope(&spec.scope)?;
    let terminal_id = normalize_terminal_id(&spec.terminal_id)?;
    if !spec.forget_observed && !spec.forget_declared {
        return Err(bad_request(
            "this change names nothing to forget",
            "choose the observation, the declaration, or both, and try again",
        ));
    }
    let now = timestamp_rfc3339(timestamp);

    let _lease = StoreLease::acquire(&dir, TERMINAL_OBSERVATIONS)?;
    let current = load_document(&dir, &scope)?;
    check_revision(
        current.as_ref(),
        Some(spec.expected_revision.as_str()),
        true,
        &scope,
    )?;
    let mut document =
        current.expect("check_revision refuses a missing document with an expectation");
    document.updated_at = now;

    // Refuse BEFORE touching the document. Pushing an empty row, clearing
    // nothing and retaining it away reported "the declaration was forgotten" for
    // a terminal id the user mistyped — while their note sat safely under the
    // right one — and still bumped the revision, invalidating every other
    // caller's held copy with a write that changed nothing.
    let present = document
        .terminals
        .iter()
        .find(|row| row.terminal_id == terminal_id);
    let would_clear = present.is_some_and(|row| {
        (spec.forget_observed && row.observed.is_some())
            || (spec.forget_declared && row.declared.is_some())
    });
    if !would_clear {
        return Err(bad_request(
            format!("KSX has nothing stored to forget for terminal '{terminal_id}'"),
            "check the terminal, or list what this board has stored first",
        ));
    }

    let row = row_mut(&mut document, &terminal_id)?;
    if spec.forget_observed {
        row.observed = None;
    }
    if spec.forget_declared {
        row.declared = None;
    }
    // An empty row is not a terminal ksx knows anything about, and keeping one
    // would make a document grow forever from repeated forgetting. The DOCUMENT
    // stays even when it empties, so a caller holding a revision keeps a chain
    // to follow rather than meeting a store that vanished under it.
    document.terminals.retain(|row| !row.is_empty());
    write_document(&dir, &mut document)?;

    Ok(PanelObservationMutationView {
        state: "forgotten".to_owned(),
        document_id: document.document_id.clone(),
        terminal_id: terminal_id.clone(),
        revision: document.revision.clone(),
        summary: match (spec.forget_observed, spec.forget_declared) {
            (true, true) => {
                format!("Everything KSX stored for terminal '{terminal_id}' was forgotten.")
            }
            (true, false) => format!("The observation for terminal '{terminal_id}' was forgotten."),
            _ => format!("The declaration for terminal '{terminal_id}' was forgotten."),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same throwaway-directory shape `boards` and `panel_profiles` use,
    /// for the same reason: these tests take a real cross-process lease and
    /// write real files, so each needs a root nothing else is holding.
    static TEST_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let serial = TEST_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ksx-panel-observations-{}-{label}-{serial}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_root(label: &str) -> (TestDir, ConfigRoot) {
        let dir = TestDir::new(label);
        let root = ConfigRoot::at(dir.0.clone());
        (dir, root)
    }

    fn at(second: u8) -> Timestamp {
        Timestamp {
            year: 2026,
            month: 8,
            day: 27,
            hour: 12,
            minute: 0,
            second,
        }
    }

    const IMAGE: &str = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

    fn scope() -> PanelBoardScope {
        PanelBoardScope {
            board_fingerprint: "IPAC4-0123456789ABCDEF01234567".to_owned(),
            terminal_signature: "ipac4-56-v1-FEEDFACE".to_owned(),
        }
    }

    fn observe(terminal_id: &str, keys: &[&str]) -> PanelObserveSpec {
        PanelObserveSpec {
            scope: scope(),
            terminal_id: terminal_id.to_owned(),
            expected_revision: None,
            keys: keys.iter().map(|key| (*key).to_owned()).collect(),
            device: r"\\?\HID#VID_D209&PID_0430".to_owned(),
            against_image_sha256: None,
            attribution: PanelObservationAttribution::Prompted,
        }
    }

    fn declaration(terminal_id: &str, key: &str) -> PanelDeclareSpec {
        PanelDeclareSpec {
            scope: scope(),
            terminal_id: terminal_id.to_owned(),
            expected_revision: None,
            key: key.to_owned(),
            against_image_sha256: None,
            note: "I wired this myself".to_owned(),
        }
    }

    /// Both kinds of fact survive a write and a read, with everything that
    /// makes them worth keeping — and the timestamps are the server's.
    #[test]
    fn observations_and_declarations_round_trip() {
        let (_dir, root) = temp_root("round-trip");

        let empty = observations_at(&root, &scope()).expect("an empty store still reads");
        assert!(empty.terminals.is_empty());
        assert!(empty.revision.is_empty(), "no document means no revision");
        assert!(empty.summary.contains("Nothing has been observed"));

        let recorded =
            record_observation_at(&root, &observe("1sw3", &["A", "B"]), at(1)).expect("the press");
        assert_eq!(recorded.state, "observed");

        let mut declared = declaration("1sw4", "Enter");
        declared.expected_revision = Some(recorded.revision.clone());
        let declared = declare_at(&root, &declared, at(2)).expect("the declaration");

        let view = observations_at(&root, &scope()).expect("the read");
        assert_eq!(view.terminals.len(), 2, "one document holds every row");
        assert_eq!(view.revision, declared.revision);
        assert_eq!(view.board_fingerprint, scope().board_fingerprint);

        let observed = view.terminals[0]
            .observed
            .as_ref()
            .expect("the observation");
        assert_eq!(view.terminals[0].terminal_id, "1sw3");
        assert_eq!(observed.keys, vec!["A".to_owned(), "B".to_owned()]);
        // Server-side, from the injected clock — never a browser's.
        assert_eq!(observed.observed_at, "2026-08-27T12:00:01Z");
        assert_eq!(observed.attribution, PanelObservationAttribution::Prompted);

        let declared_row = view.terminals[1]
            .declared
            .as_ref()
            .expect("the declaration");
        assert_eq!(declared_row.key, "Enter");
        assert_eq!(declared_row.declared_at, "2026-08-27T12:00:02Z");
        assert_eq!(declared_row.note, "I wired this myself");
    }

    /// **The stale-write guard**, copied from `boards`: two editors must not
    /// both accept revision A and let the last one silently win.
    #[test]
    fn an_edit_opened_against_an_older_document_is_refused() {
        let (_dir, root) = temp_root("stale");
        let first = record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();

        let mut second = declaration("1sw3", "B");
        second.expected_revision = Some(first.revision.clone());
        let second = declare_at(&root, &second, at(2)).expect("the first declaration");
        assert_ne!(second.revision, first.revision);

        // A third caller still holding the revision the second replaced.
        let mut stale = declaration("1sw3", "C");
        stale.expected_revision = Some(first.revision);
        let refusal = declare_at(&root, &stale, at(3)).expect_err("a stale write must refuse");
        assert!(
            refusal.message.contains("changed while this edit was open"),
            "unexpected refusal: {}",
            refusal.message
        );

        let view = observations_at(&root, &scope()).unwrap();
        assert_eq!(
            view.terminals[0].declared.as_ref().unwrap().key,
            "B",
            "the loser must not win"
        );

        // And a declaration onto a board that already holds facts must carry
        // one at all: a person's typed claim is the row no later press rebuilds.
        let refusal = declare_at(&root, &declaration("1sw5", "D"), at(4))
            .expect_err("a blind declaration must refuse");
        assert!(
            refusal.message.contains("needs the exact revision"),
            "unexpected refusal: {}",
            refusal.message
        );
    }

    /// Two writers on two different terminals are not a conflict. The lease
    /// serialises them and neither loses a row, which is why an OBSERVATION
    /// does not have to carry a revision — and why the input-test observer does
    /// not need a read-then-write round trip per press.
    #[test]
    fn a_second_terminals_press_never_erases_the_first() {
        let (_dir, root) = temp_root("row-scoped");
        record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();
        record_observation_at(&root, &observe("2sw1", &["B"]), at(2)).unwrap();
        // A fresher press on the SAME terminal is the correct winner: it is
        // what the control emits now.
        record_observation_at(&root, &observe("1sw3", &["C"]), at(3)).unwrap();

        let view = observations_at(&root, &scope()).unwrap();
        assert_eq!(view.terminals.len(), 2);
        assert_eq!(view.terminals[0].observed.as_ref().unwrap().keys, ["C"]);
        assert_eq!(view.terminals[1].observed.as_ref().unwrap().keys, ["B"]);
    }

    /// **The file key carries BOTH halves of the scope**, so a future second
    /// driver cannot read or overwrite the first one's facts.
    #[test]
    fn a_different_board_or_terminal_model_gets_its_own_document() {
        let (_dir, root) = temp_root("scoped");
        record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();

        let mut other_board = scope();
        other_board.board_fingerprint = "IPAC4-FFFFFFFFFFFFFFFFFFFFFFFF".to_owned();
        assert!(
            observations_at(&root, &other_board)
                .unwrap()
                .terminals
                .is_empty(),
            "a second cabinet must not read the first one's facts"
        );

        let mut other_model = scope();
        other_model.terminal_signature = "somefuture-32-v1-DEADBEEF".to_owned();
        assert!(
            observations_at(&root, &other_model)
                .unwrap()
                .terminals
                .is_empty(),
            "a second terminal model must not answer for screws it does not have"
        );
        assert_ne!(document_id(&scope()), document_id(&other_board));
        assert_ne!(document_id(&scope()), document_id(&other_model));

        // The original is untouched by either.
        assert_eq!(observations_at(&root, &scope()).unwrap().terminals.len(), 1);
    }

    /// **A document id becomes a filename.** It is derived by hashing, so a
    /// hostile identity cannot spell one — and the door refuses anything that
    /// reached it some other way regardless.
    #[test]
    fn a_document_id_can_never_leave_its_folder() {
        let hostile = [
            "../escape",
            r"..\escape",
            "a/b",
            r"C:\evil",
            "",
            "PO1-UPPERCASE0123456789ABCDEF01234",
            "po1-tooshort",
            "sp ace",
        ];
        for hostile in hostile {
            assert!(
                !safe_document_id(hostile),
                "{hostile:?} was accepted as a document id"
            );
            assert!(
                document_path(Path::new("."), hostile).is_err(),
                "{hostile:?} was turned into a path"
            );
        }

        // Every hostile identity still hashes to a name that stays put.
        for hostile in ["../escape", r"..\escape", "a/b", r"C:\evil", "a*?b"] {
            let scope = PanelBoardScope {
                board_fingerprint: hostile.to_owned(),
                terminal_signature: hostile.to_owned(),
            };
            let id = document_id(&scope);
            assert!(safe_document_id(&id), "{hostile:?} produced id {id:?}");
            let path = document_path(Path::new("root"), &id).expect("a derived id is safe");
            assert_eq!(path.parent(), Some(Path::new("root")));
        }

        // An identity KSX cannot file at all is refused before it is hashed,
        // which is what makes the NUL separator in `document_id` unambiguous.
        assert!(normalize_identity("board\u{0}fingerprint", "board fingerprint").is_err());
        assert!(normalize_identity("   ", "board fingerprint").is_err());
    }

    /// **The vanish race, and the write that must not paper over it.**
    ///
    /// A document removed under a reader is a board with nothing stored, not a
    /// failed read. But a write still holding that document's revision must
    /// refuse rather than quietly starting a new document, because the caller
    /// is replacing something it can no longer see.
    #[test]
    fn a_document_that_vanished_reads_as_nothing_stored_and_refuses_a_stale_write() {
        let (dir, root) = temp_root("vanish");
        let created = record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();

        let path = document_path(&root.panel_observations_dir(), &created.document_id).unwrap();
        assert!(path.exists());
        fs::remove_file(&path).unwrap();

        let view = observations_at(&root, &scope()).expect("a vanished document still reads");
        assert!(view.terminals.is_empty());
        assert!(view.revision.is_empty());

        let mut stale = declaration("1sw3", "B");
        stale.expected_revision = Some(created.revision);
        let refusal = declare_at(&root, &stale, at(2)).expect_err("a stale write must refuse");
        assert!(
            refusal.message.contains("nothing is stored"),
            "unexpected refusal: {}",
            refusal.message
        );

        // The whole folder disappearing is the same answer, not an error.
        fs::remove_dir_all(&dir.0).unwrap();
        assert!(observations_at(&root, &scope())
            .unwrap()
            .terminals
            .is_empty());
    }

    /// **A key that resolves to nothing is refused at this door**, for
    /// `boards`'s reason: `ksx-studio` does not link `ksx-core` at runtime, so
    /// nothing else in the chain can make this check, and a typo would be
    /// stored, shown, look bound and match nothing forever.
    #[test]
    fn a_key_nothing_can_receive_is_refused_and_the_rest_is_canonical() {
        let (_dir, root) = temp_root("keygate");

        let refusal = record_observation_at(&root, &observe("1sw3", &["Ay"]), at(1))
            .expect_err("a typo must refuse");
        assert!(
            refusal.message.contains("not a key ksx can receive"),
            "the refusal must name the problem: {}",
            refusal.message
        );
        assert!(
            observations_at(&root, &scope())
                .unwrap()
                .terminals
                .is_empty(),
            "nothing stored"
        );

        // A press that produced nothing is not an observation: filing one would
        // assert the terminal emits nothing, which this code cannot know.
        let refusal = record_observation_at(&root, &observe("1sw3", &[]), at(1))
            .expect_err("an empty press must refuse");
        assert!(
            refusal.message.contains("nothing to file"),
            "unexpected refusal: {}",
            refusal.message
        );

        // Stored in the one spelling ksx uses, so two rows never disagree.
        let stored = record_observation_at(&root, &observe("1sw3", &["  A  "]), at(2))
            .expect("padding is not a typo");
        assert!(stored.summary.contains("filed under terminal '1sw3': A"));
        assert_eq!(
            observations_at(&root, &scope()).unwrap().terminals[0]
                .observed
                .as_ref()
                .unwrap()
                .keys,
            ["A"]
        );

        // A declaration's empty key is NOT a typo — "I know this one is
        // unassigned" is a real claim, and the only one available about a
        // terminal whose byte a person cannot see.
        let mut unassigned = declaration("1sw9", "");
        unassigned.expected_revision = Some(stored.revision);
        let done = declare_at(&root, &unassigned, at(3)).expect("unassigned is a real claim");
        assert!(done.summary.contains("unassigned"));
        assert!(declare_at(&root, &declaration("1sw9", "Ay"), at(3)).is_err());

        // And the terminal id itself becomes part of a document nobody can
        // hand-repair, so it is gated too.
        assert!(record_observation_at(&root, &observe("../1sw3", &["A"]), at(4)).is_err());
        assert!(record_observation_at(&root, &observe("", &["A"]), at(4)).is_err());
    }

    /// **`vouching` is never stored and never served.**
    ///
    /// It cannot be supplied — no spec carries it — and a hand-edited document
    /// that asserts `Vouched` is scrubbed on load. Serving one would be exactly
    /// the failure the whole store exists to prevent: a conclusion about a
    /// chart, re-served later as if a read had just proved it.
    #[test]
    fn vouching_is_never_stored_and_a_hand_edited_one_is_scrubbed() {
        let (_dir, root) = temp_root("vouching");
        let created = record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();
        let dir = root.panel_observations_dir();
        let path = document_path(&dir, &created.document_id).unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(
            on_disk.contains("\"vouching\""),
            "the field is carried, so its VALUE is what must be trustworthy"
        );
        assert!(
            !on_disk.contains("vouched"),
            "a write must never persist a chart conclusion: {on_disk}"
        );

        // Somebody edits the file by hand (or an older build wrote one).
        let mut document: PanelObservationsDocument =
            serde_json::from_str(&on_disk).expect("the document parses");
        document.terminals[0].observed.as_mut().unwrap().vouching =
            PanelObservationVouching::Vouched;
        fs::write(&path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();

        let view = observations_at(&root, &scope()).expect("the read");
        assert_eq!(
            view.terminals[0].observed.as_ref().unwrap().vouching,
            PanelObservationVouching::Unproven,
            "a stored vouching must never reach a caller"
        );
    }

    /// **An attribution cannot claim evidence the row does not carry.**
    ///
    /// `ChartUnique` is the only attribution strong enough to reach `Matched`,
    /// and it means a chart read was in hand. Accepting one with no image hash
    /// would let a prompted guess wear the strongest provenance in the product.
    #[test]
    fn an_attribution_that_needs_a_chart_is_refused_without_one() {
        let (_dir, root) = temp_root("attribution");

        for attribution in [
            PanelObservationAttribution::ChartUnique,
            PanelObservationAttribution::SharedSignal,
        ] {
            let mut spec = observe("1sw3", &["A"]);
            spec.attribution = attribution;
            let refusal = record_observation_at(&root, &spec, at(1))
                .expect_err("a chart-backed claim with no chart must refuse");
            assert!(
                refusal.message.contains("names no chart image"),
                "unexpected refusal: {}",
                refusal.message
            );
        }

        // With the image it came from, it is exactly what it says it is.
        let mut spec = observe("1sw3", &["A"]);
        spec.attribution = PanelObservationAttribution::ChartUnique;
        spec.against_image_sha256 = Some(IMAGE.to_owned());
        record_observation_at(&root, &spec, at(2)).expect("a real chart-backed observation");
        let stored = observations_at(&root, &scope()).unwrap().terminals[0]
            .observed
            .clone()
            .unwrap();
        assert_eq!(stored.attribution, PanelObservationAttribution::ChartUnique);
        assert_eq!(stored.against_image_sha256.as_deref(), Some(IMAGE));

        // A DISPLAY hash is the live hazard: the panel facade already renders
        // `&image_sha256[..12]`, and one stored here would compare unequal to
        // every later read and mark this observation rewritten forever.
        let mut truncated = observe("1sw4", &["A"]);
        truncated.against_image_sha256 = Some(IMAGE[..12].to_owned());
        assert!(record_observation_at(&root, &truncated, at(3))
            .expect_err("a truncated hash must refuse")
            .message
            .contains("complete SHA-256"));

        // "No chart at all" has one spelling, so an empty string cannot later
        // be compared against a real hash and look like a rewritten board.
        let mut blank = observe("1sw5", &["A"]);
        blank.against_image_sha256 = Some("   ".to_owned());
        record_observation_at(&root, &blank, at(4)).expect("no chart is a real state");
        let view = observations_at(&root, &scope()).unwrap();
        // The refused '1sw4' left no row behind, which is the other half of a
        // door check: a refusal must not store a partial row on its way out.
        assert_eq!(
            view.terminals
                .iter()
                .map(|row| row.terminal_id.as_str())
                .collect::<Vec<_>>(),
            ["1sw3", "1sw5"]
        );
        let blank = view
            .terminals
            .iter()
            .find(|row| row.terminal_id == "1sw5")
            .and_then(|row| row.observed.as_ref())
            .expect("the chartless observation");
        assert_eq!(blank.against_image_sha256, None);
    }

    /// Forgetting is explicit, revision-gated, and drops only what it names.
    #[test]
    fn forgetting_drops_only_what_it_names() {
        let (_dir, root) = temp_root("forget");
        let recorded = record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();
        let mut declared = declaration("1sw3", "B");
        declared.expected_revision = Some(recorded.revision);
        let declared = declare_at(&root, &declared, at(2)).unwrap();

        let stale = PanelForgetSpec {
            scope: scope(),
            terminal_id: "1sw3".to_owned(),
            expected_revision: "po1r-NOPE".to_owned(),
            forget_observed: true,
            forget_declared: true,
        };
        assert!(
            forget_at(&root, &stale, at(3)).is_err(),
            "a stale forget must refuse"
        );

        let one = PanelForgetSpec {
            expected_revision: declared.revision,
            forget_declared: false,
            ..stale
        };
        let done = forget_at(&root, &one, at(4)).expect("the forget");
        assert_eq!(done.state, "forgotten");
        let view = observations_at(&root, &scope()).unwrap();
        assert!(view.terminals[0].observed.is_none());
        assert_eq!(view.terminals[0].declared.as_ref().unwrap().key, "B");

        // Emptying every row empties the document but keeps the revision chain,
        // so a caller holding one still has something to follow.
        let both = PanelForgetSpec {
            scope: scope(),
            terminal_id: "1sw3".to_owned(),
            expected_revision: done.revision,
            forget_observed: true,
            forget_declared: true,
        };
        let done = forget_at(&root, &both, at(5)).expect("the second forget");
        let view = observations_at(&root, &scope()).unwrap();
        assert!(view.terminals.is_empty());
        assert_eq!(view.revision, done.revision);
        assert!(!view.revision.is_empty());
    }

    /// **This store contends with nothing.**
    ///
    /// `StoreLease` is keyed by DIRECTORY, so holding the saved-layouts or the
    /// drawn-boards lease cannot block an observation — and, the one that would
    /// actually deadlock the product, neither can the machine-wide programming
    /// lease that Play and the input-test observer hold for their whole
    /// lifetime. Writing an observation while the observer that produced it
    /// holds that lease is the ordinary case, not an edge one.
    #[test]
    fn writing_an_observation_never_waits_on_another_store_or_on_play() {
        let (dir, root) = temp_root("leases");

        let layouts = StoreLease::acquire(
            &root.panel_layouts_dir(),
            crate::panel_profiles::SAVED_LAYOUTS,
        )
        .expect("the layouts lease");
        let boards =
            StoreLease::acquire(&root.boards_dir(), "boards you drew").expect("the boards lease");
        let programming = crate::panel_programming::PanelProgrammingLease::acquire(&dir.0)
            .expect("the programming lease Play and the input test hold");

        record_observation_at(&root, &observe("1sw3", &["A"]), at(1))
            .expect("an observation must never deadlock against the flow that produces it");
        assert!(observations_at(&root, &scope()).is_ok());

        drop(programming);
        drop(boards);
        drop(layouts);

        // And this store's OWN lease still spans its writes and no read, which
        // is the half that actually prevents a lost update.
        let own = StoreLease::acquire(&root.panel_observations_dir(), TERMINAL_OBSERVATIONS)
            .expect("this store's lease");
        assert!(
            observations_at(&root, &scope()).is_ok(),
            "a read must never be blocked by a write; a refused read reads as a lost store"
        );
        assert!(
            record_observation_at(&root, &observe("2sw1", &["B"]), at(2)).is_err(),
            "a competing writer must not pass this store's lease"
        );
        drop(own);
        record_observation_at(&root, &observe("2sw1", &["B"]), at(3)).expect("after the lease");
    }

    /// A document that does not describe the board it was asked about is
    /// refused rather than answered from — requirement 2 enforced, not assumed.
    #[test]
    fn a_document_that_describes_another_board_is_refused() {
        let (_dir, root) = temp_root("mismatch");
        let created = record_observation_at(&root, &observe("1sw3", &["A"]), at(1)).unwrap();
        let dir = root.panel_observations_dir();
        let path = document_path(&dir, &created.document_id).unwrap();

        let mut document: PanelObservationsDocument =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        document.terminal_signature = "somefuture-32-v1-DEADBEEF".to_owned();
        fs::write(&path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();

        let refusal = observations_at(&root, &scope()).expect_err("a mismatched file must refuse");
        assert!(
            refusal.message.contains("does not describe this board"),
            "unexpected refusal: {}",
            refusal.message
        );
        // The refusal names the absolute folder, so there is something to check.
        assert!(refusal
            .remedy
            .as_deref()
            .unwrap_or_default()
            .contains(&dir.display().to_string()));
    }

    /// **A browser body cannot dress a press up as chart-backed evidence.**
    ///
    /// `record_observation` takes a `Deserialize` spec, and every other route on
    /// this server is written by deserializing a body straight into one. If that
    /// ever happens here, the two fields that decide whether an observation can
    /// reach `Matched` must not be among the ones the body can set — so this
    /// asserts the guard is the serde attribute, not a comment asking callers to
    /// be careful.
    #[test]
    fn a_deserialized_spec_cannot_claim_a_chart_the_server_never_read() {
        let hostile = serde_json::json!({
            "scope": {
                "board_fingerprint": "fp",
                "terminal_signature": "sig",
                "board_label": "a board",
            },
            "terminal_id": "1sw1",
            "keys": ["KeyA"],
            "device": "a device",
            // Both halves of the strongest provenance in the product, asserted
            // by the weakest source in it.
            "against_image_sha256": IMAGE,
            "attribution": "chart-unique",
        });

        let spec: PanelObserveSpec =
            serde_json::from_value(hostile).expect("unknown fields are not the guard here");

        assert_eq!(
            spec.attribution,
            PanelObservationAttribution::Prompted,
            "a body set the attribution that is the only route to `Matched`",
        );
        assert_eq!(
            spec.against_image_sha256, None,
            "a body named the chart image its own claim is checked against",
        );
    }

    // ── REGRESSIONS FOUND BY ADVERSARIAL REVIEW ────────────────────────────

    /// **A burst cannot wear a chart read's provenance.**
    ///
    /// `attribute_press` already refuses to call several keys chart-backed. The
    /// store's own door has to refuse it too: a door that trusts one caller to
    /// have been careful is not a door, and a durable row claiming `ChartUnique`
    /// for an event no single stored byte can produce outlives the request that
    /// wrote it.
    #[test]
    fn a_multi_key_press_cannot_be_filed_as_chart_unique() {
        let (_dir, root) = temp_root("burst-attribution");
        let mut spec = observe("1sw1", &["A", "B"]);
        spec.attribution = PanelObservationAttribution::ChartUnique;
        spec.against_image_sha256 = Some(IMAGE.to_owned());

        let refusal =
            record_observation_at(&root, &spec, at(1)).expect_err("a burst is not chart-unique");
        assert_eq!(refusal.code, ksx_api::codes::BAD_REQUEST);

        // The same burst is perfectly fileable as what it actually is.
        spec.attribution = PanelObservationAttribution::Prompted;
        let stored = record_observation_at(&root, &spec, at(2)).expect("a prompted burst is fine");
        assert_eq!(stored.terminal_id, "1sw1");
    }

    /// Forgetting what was never stored must not report success, and must not
    /// burn a revision every other caller is holding.
    #[test]
    fn forgetting_nothing_refuses_instead_of_reporting_success() {
        let (_dir, root) = temp_root("forget-nothing");
        let stored =
            record_observation_at(&root, &observe("1sw1", &["A"]), at(1)).expect("one observation");

        let refusal = forget_at(
            &root,
            &PanelForgetSpec {
                scope: scope(),
                terminal_id: "4coin".to_owned(),
                expected_revision: stored.revision.clone(),
                forget_observed: true,
                forget_declared: true,
            },
            at(2),
        )
        .expect_err("nothing is stored for that terminal");
        assert_eq!(refusal.code, ksx_api::codes::BAD_REQUEST);

        // The revision the caller was holding is still valid, because nothing
        // was written.
        let after = observations_at(&root, &scope()).expect("still readable");
        assert_eq!(after.revision, stored.revision);
    }

    /// **The write door's image check, applied on the way back in.**
    ///
    /// A 12-character display hash on disk used to load unchanged, and then
    /// never equal a real 64-character read hash — so that observation reported
    /// as taken against a changed board forever, which is exactly what the
    /// write-side check exists to prevent.
    #[test]
    fn a_truncated_image_hash_on_disk_is_dropped_rather_than_believed() {
        let (_dir, root) = temp_root("truncated-hash");
        let mut spec = observe("1sw1", &["A"]);
        spec.against_image_sha256 = Some(IMAGE.to_owned());
        record_observation_at(&root, &spec, at(1)).expect("one observation");

        // Simulate a hand-edited file, or one an older build wrote.
        let dir = root.panel_observations_dir();
        let id = observations_at(&root, &scope()).expect("read").document_id;
        let path = document_path(&dir, &id).expect("a path");
        let raw = std::fs::read_to_string(&path).expect("read the document");
        std::fs::write(&path, raw.replace(IMAGE, "0123456789AB")).expect("write it back");

        let loaded = observations_at(&root, &scope()).expect("it still loads");
        let observed = loaded.terminals[0]
            .observed
            .as_ref()
            .expect("the press survived");
        assert_eq!(
            observed.against_image_sha256, None,
            "a display hash was believed as a full image hash",
        );
    }
}
