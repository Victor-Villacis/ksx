//! The render seam: embedded FMIR + a per-request domain payload → HTML, with
//! the same data emitted twice — slots for the SSR first paint, the source
//! payload for client hydration.
//!
//! This module is SHARED INFRASTRUCTURE, not a page. It once rendered the
//! status page; that page is gone and `/redesign` is the current product core, but
//! nineteen files still take [`with_theme`], [`payload_json`], [`art_for`] and
//! [`assert_island_slot_contract`] from here. What follows describes the seam
//! every surviving page renders through — `render_redesign.rs` is the current
//! core example to read alongside it.
//!
//! # SSR slots for first paint, a payload block for hydration (and why both)
//!
//! A page is one Forma ISLAND (compiled between ISLAND_START/ISLAND_END
//! opcodes). Per request this seam:
//!
//! 1. **Injects slots** — the compiler declares NAMED slots in the FMIR slot
//!    table, [`SlotData`] is populated before the IR walk, and the walker
//!    renders the full page server-side. This is what the browser paints
//!    before (or without) any JavaScript; the no-JS experience is the whole
//!    page, not a shell.
//! 2. **Emits the SAME data as the domain payload** — JSON in the
//!    [`PAYLOAD_SCRIPT_ID`] script block (a non-executing
//!    `type="application/json"` data block, so the strict CSP is untouched).
//!    The client seeds its signals from it BEFORE adoption — dogfood ledger
//!    #5: adoption binds effects that immediately write signal state into the
//!    DOM, so plain hydration clobbers SSR values; seeding first is the one
//!    sanctioned live path.
//!
//!    Keeping BOTH emissions is deliberate: slots alone give a correct first
//!    paint but hydration would clobber it (ledger #5); the payload alone
//!    would require client rendering and break the no-JS baseline. The
//!    redundancy is the design, not an accident — same struct, same
//!    serializer, one derivation mirror on the TypeScript side covered by
//!    tests on this one.
//!
//!    Since compiler 0.3.1 the walker ALSO emits `data-forma-props` on the
//!    island root, built from the island's `slot_ids` (ledger #8 closed — the
//!    `__forma_islands` impersonation this file used to hand-emit is gone).
//!    Those native props carry the rendered SLOT values; the block above
//!    carries the SOURCE payload the client's own model needs. Ledger #19.
//!
//! Three flavours of slot exist:
//!
//! - **Scalars** — every `createSignal` in the island's TypeScript becomes a
//!   slot named after the signal getter. Unique names, injected via
//!   [`SlotData::from_json`] (name-keyed, defaults preserved for misses).
//!   Compiler 0.3.1 walks island component files for signal scopes, so the
//!   twin re-declarations the old `*Page.ts` files carried are gone
//!   (ledger #9).
//! - **Lists** — every `createList` becomes an Array slot. Since the lists
//!   read from named signals (`() => padTiles()`), compiler 0.2.0 derives the
//!   slot name from the BINDING (`list:padTiles:array`) instead of the
//!   positional `list:#N:array` v3 lived with — reordering lists in the page
//!   no longer shifts names (ledger #3, mostly resolved for us). **A binding
//!   used by a SECOND `createList` gets an occurrence suffix**
//!   (`list:padTiles#2:array`); serve that name too or the second list
//!   renders empty server-side while the client fills it after adoption,
//!   which reads as a flicker rather than a bug (trap #12).
//! - **Shows** — every `createShow` becomes a Bool slot named after its
//!   CONDITION binding (`createShow(() => canStart(), …)` →
//!   `show:canStart`), so shows are injected by name like everything else
//!   (compiler 0.3.1; dogfood ledger #4 closed 2026-08-06 — the `SHOW_ORDER`
//!   positional array and its "append, never insert" rule are gone). The show
//!   pairs are what color state server-side (the server picks which
//!   statically-styled variant renders), and after hydration the same pairs
//!   flip live from client signals.
//!
//! Each page's own slot-layout test pins the exact list slot NAMES (order
//! included), the exact show slot NAMES, and the island table including its
//! non-empty `slot_ids` — a compiler bump that renames slots, or an island
//! edit that adds or renames lists or shows, is a test failure, not a
//! silently blank section. Those tests then hand the whole slot table to
//! [`assert_island_slot_contract`], which asserts the thing a name-exists
//! check cannot: that every name the seam injects is one the ISLAND RENDERS,
//! and that every scalar the island renders is one the seam injects. Read that
//! function before touching this seam — "the slot exists" was the assertion
//! that let a dead slot through the whole gate on 2026-08-06.
//!
//! History: compiler 0.1.8 named EVERY list `list:array`, and this seam
//! resolved lists positionally too (a `LIST_ORDER` table, since deleted).
//! Per-instance slot naming was the upstream feature request this seam
//! dogfooded (docs/ENHANCEMENTS.md E7 loop); fixed upstream in
//! `@getforma/compiler` 0.2.0, adopted 2026-08-05 — the E7 dogfood loop's
//! first closed cycle. Per-instance `createShow` naming (ledger #4) and
//! populated island `slot_ids` (ledger #8) landed in 0.3.1 and were adopted
//! 2026-08-06; the same release stopped extracting signals from the root
//! `*Page` file ONLY (ledger #9), which is why the page entry modules are
//! four lines instead of thirty declarations.

use forma_ir::parser::IrModule;
use forma_server::{AssetManifest, PageOutput};
use rust_embed::Embed;

use crate::error::StudioError;

/// The committed `studio-ui` build output (see the crate docs for the
/// regeneration command — Node is never needed to build or run ksx).
#[derive(Embed)]
#[folder = "assets/"]
pub(crate) struct Assets;

/// The brand icons: `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`.
/// Written by `tools/icongen` from the two master SVGs — see
/// `assets/brand/README.md`.
///
/// A SECOND embed, rooted at `brand/` rather than `assets/`, for one concrete
/// reason: `assets/` is the OUTPUT DIRECTORY of `studio-ui/build.mjs`, and
/// `@getforma/build` `rmSync`s it at the top of every run. Icons parked there
/// would survive exactly until the next UI rebuild and then 404, with nothing
/// in any build log to say why. The icons are not UI build output and they do
/// not belong in the UI build's scratch space.
#[derive(Embed)]
#[folder = "brand/"]
pub(crate) struct BrandAssets;

/// The `<head>` icon links, identical on both pages.
///
/// Three declarations because three consumers choose differently, and each
/// wants a different file:
///
/// - **`favicon.svg`** — the modern path; browsers that support SVG icons
///   prefer it over the `.ico`. It is the SIMPLIFIED master, not the
///   detailed one, because what a browser does with it is render it into a
///   16–32 px tab. Handing it the detailed art would throw away the whole
///   point of having two drawings.
/// - **`favicon.ico`** — the fallback, and what Windows itself reads when the
///   page is pinned or saved as a shortcut. No `sizes` attribute: the file
///   carries eight size-specific entries and the consumer reads the ICO
///   directory to choose. A hand-written list here could only ever go stale
///   against `tools/icongen`'s table.
/// - **`apple-touch-icon.png`** — 180 px, flattened onto the plate color, so
///   iOS's home-screen mask has no transparent corners to composite black.
///
/// # Why this is spliced in rather than passed to `render_page`
///
/// forma-server 0.2.0's `PageConfig` has no head hook — the field list
/// (title, route_pattern, manifest, config_script, config_json, body_class,
/// personality_css, body_prefix, render_mode, ir_module, slots) reaches many
/// places, but not `<head>`'s link section and not the `<html>` opener
/// (which is why [`with_theme`] splices too). One `</head>` insertion is a
/// smaller and more honest workaround than forking the template, and the
/// tests below fail the moment upstream grows a real hook or changes the
/// markup — which is the point at which this should go away.
///
const ICON_LINKS: &str = concat!(
    r#"<link rel="icon" href="/favicon.svg" type="image/svg+xml">"#,
    r#"<link rel="icon" href="/favicon.ico" type="image/x-icon">"#,
    r#"<link rel="apple-touch-icon" href="/apple-touch-icon.png">"#,
);

/// Splice [`ICON_LINKS`] into a rendered page's `<head>`.
///
/// A missing `</head>` costs the page its icons and nothing else, so it is a
/// warning rather than a panic: a status page that renders without a favicon
/// still tells the user whether their cabinet is working.
pub(crate) fn with_icon_links(mut out: PageOutput) -> PageOutput {
    match out.html.find("</head>") {
        Some(at) => out.html.insert_str(at, ICON_LINKS),
        None => tracing::warn!("rendered page has no </head>; ksx icon links not added"),
    }
    out
}

/// Stamp the chosen theme on the root element: `<html lang="en">` becomes
/// `<html lang="en" data-theme="{id}">`, which the stylesheet's
/// `:root[data-theme=…]` blocks and the anti-flash CSS both key on. `None`
/// (System) stamps nothing — the `:root:not([data-theme])` media guard then
/// follows the OS scheme, exactly the pre-TK2 behavior.
///
/// A [`with_icon_links`]-style post-render splice for the same reason that
/// one exists: forma-server 0.2.0's `PageConfig` has no hook that reaches the
/// root element (`<html lang="en">` is a template literal in both render
/// phases), and like that one, this should migrate upstream the moment a real
/// hook appears.
///
/// **Only ids in the generated [`crate::theme_tokens::THEMES`] roster are
/// stamped.** The config is hand-editable and `/setup/import` writes
/// `Settings` wholesale, so an id this build does not ship CAN reach this
/// function — and stamping it would defeat the system-follow light guard
/// while styling nothing (a light-OS user would silently get base dark).
/// Unknown means System, out loud in the log.
pub(crate) fn with_theme(mut out: PageOutput, theme: Option<&str>) -> PageOutput {
    let Some(id) = theme.filter(|id| !id.is_empty()) else {
        return out;
    };
    if !crate::theme_tokens::THEMES.iter().any(|t| t.id == id) {
        // Bounded and escaped: the id comes from a hand-editable file and
        // the import path places no shape on it, and this warn fires at
        // navigation rate — never echo an unbounded raw string into the log.
        let shown: String = id.chars().take(32).collect();
        tracing::warn!(
            "config names theme '{}', which this build does not ship; rendering as System",
            shown.escape_debug()
        );
        return out;
    }
    const OPENER: &str = "<html lang=\"en\"";
    match out.html.find(OPENER) {
        Some(at) => out
            .html
            .insert_str(at + OPENER.len(), &format!(" data-theme=\"{id}\"")),
        None => tracing::warn!("rendered page has no <html lang=\"en\"; theme not stamped"),
    }
    out
}

/// The oracle every page module's tests use: the head carries the icon links
/// this crate splices AND the viewport meta it does not — each inside
/// `<head>`, the viewport exactly once.
///
/// The inside-`<head>` half is the half that earns its keep for the icons:
/// they are spliced in after forma-server has rendered, so an upstream
/// template change that moved or renamed `</head>` would drop three `<link>`
/// elements into the body — where they do nothing whatsoever, and where the
/// page looks completely normal.
///
/// # Why an oracle in this crate asserts a tag this crate never writes
///
/// The viewport meta comes from `forma-server`'s own template
/// (`template.rs`, both 0.1.4 and 0.2.0), and it was believed absent for a
/// day: three separate greps — two reviewers' and the integrator's — searched
/// `ksx-studio/src` and `studio-ui/src`, found nothing, and a task was filed
/// to "add the one line that fixes phones". All three measured the SOURCE of
/// a page whose head is assembled by a dependency; nobody read the OUTPUT.
/// The duplicate splice that task produced was caught by this very
/// exactly-once assertion, one commit old.
///
/// So it is pinned here, in the output, for both directions: if upstream ever
/// drops the tag, phones break silently and this is the only tripwire; if
/// anyone "adds" it again, two viewport metas is a browser picking one by a
/// rule nobody reads. Either failure names this comment.
#[cfg(test)]
pub(crate) fn assert_complete_head(route: &str, html: &str) {
    let head_end = html
        .find("</head>")
        .unwrap_or_else(|| panic!("{route}: rendered page has no </head>"));
    let viewport = r#"<meta name="viewport" content="width=device-width, initial-scale=1">"#;
    assert_eq!(
        html.matches(viewport).count(),
        1,
        "{route}: forma-server's template emits the viewport meta exactly once; \
         see assert_complete_head's docs before touching this"
    );
    for extra in [
        viewport,
        r#"<link rel="icon" href="/favicon.svg" type="image/svg+xml">"#,
        r#"<link rel="icon" href="/favicon.ico" type="image/x-icon">"#,
        r#"<link rel="apple-touch-icon" href="/apple-touch-icon.png">"#,
    ] {
        let at = html
            .find(extra)
            .unwrap_or_else(|| panic!("{route}: missing head element {extra}"));
        assert!(at < head_end, "{route}: {extra} landed outside <head>");
    }
}

/// Seconds between full-page refreshes for the NO-JS fallback only (v4): the
/// meta pragma now lives inside `<noscript>`, so browsers running the island
/// poller never reload. Was 2 s while the page was read-only; a page with a
/// dropdown must leave the no-JS user time to aim at it before the reload
/// closes it.
pub(crate) const REFRESH_SECS: u32 = 5;

/// The anti-flash `<style nonce>` CSS, re-exported from the GENERATED
/// [`crate::theme_tokens`] module so every page module keeps importing it
/// from here.
///
/// This used to be a HAND COPY of two tokens, and it had drifted once
/// (`#0b0e14` against a stylesheet that had moved) — a wrong anti-flash
/// color looks exactly like the flash it exists to prevent, so nothing could
/// catch it. Then it was a checked copy (`tests/contrast.rs` pinned this
/// file and `render_map.rs`'s byte-twin against studio.css). Since TK0 it is
/// not a copy at all: `studio-ui/tokens/build-tokens.mjs` derives it from
/// the same token source `tokens.gen.css` is compiled from, and the contrast
/// gate cross-pins the generated module — a copy that cannot drift, still
/// checked, because the generator itself could be wrong once.
pub(crate) use crate::theme_tokens::PERSONALITY_CSS;

/// Parsed once at server start; immutable afterwards.
pub(crate) struct EmbeddedPage {
    pub(crate) manifest: AssetManifest,
    pub(crate) module: IrModule,
}

impl EmbeddedPage {
    /// Load the embedded page for one manifest route.
    ///
    /// The manifest holds exactly five: the current `"/redesign"` workbench,
    /// retained `"/nocturne"`, and the tool pages `"/check"`, `"/pads"` and
    /// `"/devices"`. The old examples here were `"/"` and `"/map"`, both of
    /// which would now panic on the `expect` at every call site.
    pub(crate) fn load(route: &str) -> Result<Self, StudioError> {
        let manifest_json = Assets::get("manifest.json")
            .ok_or_else(|| StudioError::Asset("manifest.json missing from embed".into()))?;
        let manifest: AssetManifest = serde_json::from_slice(&manifest_json.data)
            .map_err(|e| StudioError::Asset(format!("manifest.json unparsable: {e}")))?;

        let ir_name = manifest
            .route(route)
            .and_then(|r| r.ir.clone())
            .ok_or_else(|| {
                StudioError::Asset(format!("manifest route '{route}' has no .ir entry"))
            })?;
        let ir_bytes = Assets::get(&ir_name)
            .ok_or_else(|| StudioError::Asset(format!("{ir_name} missing from embed")))?;

        let module = IrModule::parse(&ir_bytes.data)
            .map_err(|e| StudioError::Ir(format!("{ir_name}: {e}")))?;
        // There used to be a `forma_server::check_ir_compatibility(&module)`
        // call here. 0.2.0 removed the function, and re-implementing it would
        // have been re-implementing dead code: `IrModule::parse` above starts
        // with `IrHeader::parse`, which rejects a version mismatch outright
        // (`IrError::UnsupportedVersion`, forma-ir format.rs). Any module that
        // reached the old call had ALREADY passed the identical comparison, so
        // it could only ever return `Ok`.
        //
        // That was true in 0.1.4 as well — the guard is in both releases — so
        // nothing is lost here, and a mismatched IR still fails, one line
        // earlier, through `StudioError::Ir`.

        Ok(Self { manifest, module })
    }

    #[cfg(test)]
    pub(crate) fn module(&self) -> &IrModule {
        &self.module
    }
}

/// A page that notices when the asset build has moved underneath it.
///
/// **The bug this exists to remove.** `EmbeddedPage::load` resolves the
/// manifest to a SPECIFIC hashed filename — `nocturne.8734f6b3.js` — and the
/// four pages were loaded once into `AppState` and held for the life of the
/// process. In a debug build `rust_embed` reads asset BYTES from disk per
/// request, so the files stay live; the NAMES did not. Rebuilding assets under
/// a running Studio therefore left the page emitting URLs that no longer
/// existed, and `/nocturne` served a document whose script and stylesheet both
/// 404'd — with nothing in any log to say why. It cost a real debugging
/// session, and the documented workaround was "restart the lane", which is a
/// note telling you to live with it rather than a fix.
///
/// So: in a debug build every render re-reads `manifest.json` (already a disk
/// read there, already cheap) and reloads only when its bytes actually change.
/// The expensive half — `IrModule::parse` over ~500 KB for `/nocturne` — is
/// paid ONLY on a real rebuild, never per request.
///
/// In release this compiles to a clone of an `Arc`. `manifest.json` is baked
/// into the binary and cannot change while the process runs, so there is
/// nothing to check and nothing to pay for.
pub(crate) struct LivePage {
    route: &'static str,
    /// `(fingerprint of manifest.json, the page built from it)`.
    held: std::sync::RwLock<(u64, std::sync::Arc<EmbeddedPage>)>,
}

impl LivePage {
    pub(crate) fn load(route: &'static str) -> Result<Self, StudioError> {
        let page = EmbeddedPage::load(route)?;
        Ok(Self {
            route,
            held: std::sync::RwLock::new((manifest_fingerprint(), std::sync::Arc::new(page))),
        })
    }

    /// The page to render THIS request with.
    #[cfg(not(debug_assertions))]
    pub(crate) fn get(&self) -> std::sync::Arc<EmbeddedPage> {
        std::sync::Arc::clone(&self.held.read().expect("live page lock").1)
    }

    /// The page to render THIS request with, reloading first if the asset
    /// build has run since the last one.
    ///
    /// A reload FAILURE keeps serving the page we already have. A half-written
    /// `manifest.json` — which the asset build produces for a moment every
    /// time, since `build.mjs` clears the directory before it emits — must not
    /// take the lane down; the next request picks up the finished build.
    #[cfg(debug_assertions)]
    pub(crate) fn get(&self) -> std::sync::Arc<EmbeddedPage> {
        let now = manifest_fingerprint();
        {
            let held = self.held.read().expect("live page lock");
            if held.0 == now {
                return std::sync::Arc::clone(&held.1);
            }
        }
        let mut held = self.held.write().expect("live page lock");
        // Another request may have reloaded while this one waited.
        if held.0 == now {
            return std::sync::Arc::clone(&held.1);
        }
        match EmbeddedPage::load(self.route) {
            Ok(page) => {
                let page = std::sync::Arc::new(page);
                *held = (now, std::sync::Arc::clone(&page));
                tracing::info!(route = self.route, "assets changed on disk; page reloaded");
                page
            }
            Err(error) => {
                tracing::warn!(
                    route = self.route,
                    %error,
                    "assets changed but the new build could not be read; \
                     serving the page already loaded"
                );
                std::sync::Arc::clone(&held.1)
            }
        }
    }
}

/// A cheap stand-in for "has the asset build run since we last looked".
///
/// The manifest names every hashed file, so any rebuild that changes an asset
/// changes these bytes. In a debug build `Assets::get` reads it from disk; in
/// release it is the embedded copy and never moves.
fn manifest_fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match Assets::get("manifest.json") {
        Some(file) => file.data.hash(&mut hasher),
        // Mid-rebuild: `build.mjs` clears the directory before emitting. Hash a
        // constant so this transient state is not mistaken for a NEW build and
        // does not trigger a reload that would only fail.
        None => 0u64.hash(&mut hasher),
    }
    hasher.finish()
}

/// The vendored controller art, served from the embed (`/_assets/...`).
/// Gamepad-Asset-Pack by AL2009man, MIT — see `studio-ui/art/README.md`; the
/// page footers carry the visible credit (pinned by tests on both pages).
pub(crate) const ART_XBOX: &str = "/_assets/pad-xbox.svg";
pub(crate) const ART_DS4: &str = "/_assets/pad-ds4.svg";

/// The vendored body drawing a persona is served with.
///
/// One line, because the decision is not made here: it is one field of the
/// persona's row in `PAD_PRESENTATIONS` ([`crate::snapshot::pad_presentation`]),
/// beside the family, the zone table and the legend that must agree with it.
///
/// This used to substring-match seven PlayStation tokens and return
/// [`ART_XBOX`] for everything else, which is a fall-through and not a
/// decision — a persona nobody had thought about got the Xbox pad silently,
/// while `pad_art_family`'s own fall-through gave the SAME persona a DualShock
/// on the SAME page. Two silent fallbacks disagreeing is the bug class the
/// single record exists to make unrepresentable.
pub(crate) fn art_for(persona: &str) -> &'static str {
    crate::snapshot::pad_presentation(persona).art
}

/// The id of the DOMAIN PAYLOAD data block — ksx's own channel, not Forma's.
///
/// History (dogfood ledger #8, adopted 2026-08-06): this block used to be
/// `__forma_islands` and used to carry `{"0": <payload>}`, because compiler
/// 0.2.0 registered islands with EMPTY `slot_ids`, which meant forma-ir's
/// walker never emitted `data-forma-props` and the islands protocol's
/// script-tag shared-props path was the only way to get server data to the
/// client. Compiler 0.3.1 populates `slot_ids`, so the walker emits
/// `data-forma-props` ITSELF and `loadIslandProps` prefers it — the
/// impersonation is deleted, along with the island-id keying it needed.
///
/// What is left is a genuinely different thing, which is why it kept a block
/// and got a ksx name: native island props carry the RENDERED SLOT VALUES
/// (`vigemLine`, `show:canStart`, `list:padTiles:array`, …). The clients own
/// an editing model over the SOURCE payload — `map.ts` keeps `lastPayload`
/// and derives conflicts, macro drafts and undo from it — and no slot carries
/// that. See ledger #19.
pub(crate) const PAYLOAD_SCRIPT_ID: &str = "__ksx-payload";

/// The slot contract both pages' layout tests assert, in one place because it
/// is one invariant: **a name the seam injects must be the name the island
/// actually renders, and a name the island renders must be one the seam
/// injects.**
///
/// Existence is NOT the check, and finding that out cost an evening. Compiler
/// 0.3.1 keeps every slot name on a page unique by SUFFIXING collisions
/// (`signal-scope.ts` `uniqueName`), so a signal declared in two scopes — the
/// ledger #9 twin shape, one careless `createSignal` in `*Page.ts` — mints the
/// UNSUFFIXED name for the DEAD declaration and pushes the rendered one to
/// `#2`. `names.contains("vigemLine")` still passes, [`SlotData::from_json`]
/// still reports the value set, and the page renders its compile-time default
/// forever. The compiler says so on one build line among the thirteen the
/// ledger tells you not to chase; nothing else noticed, and every test here
/// stayed green (verified 2026-08-06 by resurrecting one twin and running the
/// whole gate).
///
/// The island's `slot_ids` ARE the render set — that is what makes them the
/// right oracle, and the reason ledger #8's fix is load-bearing for more than
/// `data-forma-props`.
///
/// - `injected` — every slot name the seam addresses by name (scalars, lists,
///   shows). Each must resolve to exactly ONE slot, and that slot must be in
///   the island's `slot_ids`.
/// - `client_only` — bare-named slots the seam deliberately never fills,
///   because the value only exists after an interaction the server has not
///   had. Every one is a documented exception; anything else rendered by the
///   island and not injected is the #10 failure mode (a field that silently
///   shows its authored default).
/// - `anonymous` — `attr:`/`text:` slots, the compiler's name for a binding it
///   could not name after a signal. These can NEVER be injected: they render
///   their compile-time default and nothing else. Pinned as an exact set (a
///   new one is a review, not a surprise) and asserted non-empty, which is the
///   guard against ledger #10/#20(a) — an attribute whose value silently
///   vanishes.
#[cfg(test)]
pub(crate) fn assert_island_slot_contract(
    module: &IrModule,
    injected: &[&str],
    client_only: &[&str],
    anonymous: &[&str],
) {
    use std::collections::BTreeSet;

    let entries = module.slots.entries();
    let name_of = |id: u16| -> &str {
        entries
            .iter()
            .find(|e| e.slot_id == id)
            .and_then(|e| module.strings.get(e.name_str_idx).ok())
            .unwrap_or("<unknown>")
    };
    let islands = module.islands.entries();
    assert_eq!(islands.len(), 1, "expected exactly one island");
    let rendered: BTreeSet<u16> = islands[0].slot_ids.iter().copied().collect();

    for name in injected {
        let ids = named_slot_ids(module, name);
        assert_eq!(
            ids.len(),
            1,
            "slot '{name}' occurs {} times — the seam injects the FIRST, so \
             the others can never be filled",
            ids.len()
        );
        assert!(
            rendered.contains(&ids[0]),
            "slot '{name}' (id {}) is injected server-side but the island \
             never renders it — the compiler gave the rendered binding a \
             different name (look for '{name}#2' in the build log). Injection \
             will silently succeed and the page will show the authored \
             default.",
            ids[0]
        );
    }

    // The converse: every bare-named slot the island renders is either
    // injected or a documented client-only exception.
    let rendered_bare: BTreeSet<&str> = rendered
        .iter()
        .map(|id| name_of(*id))
        .filter(|n| !n.contains(':'))
        .collect();
    let accounted: BTreeSet<&str> = injected
        .iter()
        .copied()
        .filter(|n| !n.contains(':'))
        .chain(client_only.iter().copied())
        .collect();
    assert_eq!(
        rendered_bare, accounted,
        "the island renders scalar slots the seam does not inject (or the \
         seam claims ones it does not render). An un-injected scalar renders \
         its authored default on every request, forever, with no error — add \
         it to the seam, or name it in the client-only list with a reason."
    );

    // Anonymous slots: un-injectable by construction.
    let anon_found: BTreeSet<&str> = entries
        .iter()
        .filter_map(|e| module.strings.get(e.name_str_idx).ok())
        .filter(|n| n.starts_with("attr:") || n.starts_with("text:"))
        .collect();
    let anon_expected: BTreeSet<&str> = anonymous.iter().copied().collect();
    assert_eq!(
        anon_found, anon_expected,
        "the anonymous-slot set changed. These are bindings the compiler \
         could not name after a signal, so the seam can never inject them — \
         they render their COMPILE-TIME DEFAULT and nothing else. A new one \
         is fine only if that default is the finished text (a concatenation \
         of literals folds; anything reading a signal does not). Check the \
         default, then pin it here."
    );
    for name in &anon_found {
        let entry = entries
            .iter()
            .find(|e| module.strings.get(e.name_str_idx).is_ok_and(|n| n == *name))
            .expect("just enumerated");
        assert!(
            !entry.default_bytes.is_empty(),
            "anonymous slot '{name}' has an EMPTY default, so it renders as \
             nothing — this is ledger #10/#20(a) exactly: an attribute with no \
             value, or a child with no text, and no warning anywhere"
        );
    }
}

/// Slot ids of every slot named `name`, in slot-table (== document) order.
///
/// Lives BELOW the contract it serves on purpose: it used to sit above it, and
/// a `///` block with no blank line between them silently reparented the whole
/// contract doc onto this six-line helper. Clippy's `doc_lazy_continuation` is
/// what noticed.
#[cfg(test)]
fn named_slot_ids(module: &IrModule, name: &str) -> Vec<u16> {
    module
        .slots
        .entries()
        .iter()
        .filter(|e| module.strings.get(e.name_str_idx).is_ok_and(|n| n == name))
        .map(|e| e.slot_id)
        .collect()
}

/// The domain payload as a JSON data block body. `<` is JSON-escaped so a
/// hostile snapshot line can never close the `<script>` data block early —
/// inside JSON, `<` only occurs in strings, where `<` is equivalent.
pub(crate) fn payload_json<T: serde::Serialize>(payload: &T) -> String {
    serde_json::to_value(payload)
        .unwrap_or(serde_json::Value::Null)
        .to_string()
        .replace('<', "\\u003c")
}

/// Everything that precedes `#app`: the no-JS fallback refresh and the domain
/// payload block.
///
/// - The `<noscript>` meta refresh targets `refresh_url` WITHOUT any query
///   string: a flash arrives via /?flash=… (post-redirect), shows for one
///   cycle, and the next no-JS refresh lands on a clean URL. (With JS the
///   poller keeps the page live and the entry clears the flash + URL itself.)
/// - The payload block is `type="application/json"` — a data block, never
///   executed, outside the CSP's script-src entirely; the entries read it by
///   id ([`PAYLOAD_SCRIPT_ID`]).
pub(crate) fn body_prefix<T: serde::Serialize>(payload: &T, refresh_url: &str) -> String {
    format!(
        "<noscript><meta http-equiv=\"refresh\" content=\"{REFRESH_SECS}; url={refresh_url}\"></noscript>{}",
        payload_block(payload)
    )
}

/// [`body_prefix`] with the no-JS refresh **suppressed**.
///
/// For the one kind of page where a timer that reloads the document is not a
/// liveness feature but a bug: a destructive confirmation. `/pads` arms its
/// prune at `/pads?confirm=1` and then asks the user to check every device id
/// in a list that can be fifteen rows long — and the refresh URL deliberately
/// carries no query string, so at five seconds the page would navigate itself
/// back to the disarmed view mid-read. There is no window in which a full bus
/// could be confirmed. A page that has asked a question waits for the answer.
pub(crate) fn body_prefix_no_refresh<T: serde::Serialize>(payload: &T) -> String {
    payload_block(payload)
}

/// The `application/json` data block both prefixes carry.
fn payload_block<T: serde::Serialize>(payload: &T) -> String {
    format!(
        "<script id=\"{PAYLOAD_SCRIPT_ID}\" type=\"application/json\">{}</script>",
        payload_json(payload)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The embed ships exactly the five live routes, and every one of them
    /// parses.**
    ///
    /// REPLACES 2026-08-26 three copies of `embedded_page_loads_and_ir_is_fmir_v2`
    /// (`render_check.rs`, `render_devices.rs`, `render_pads.rs`), each of
    /// which was `EmbeddedPage::load(route)` followed by
    /// `assert_eq!(page.module.header.version, 2)`. That assertion was
    /// TAUTOLOGICAL: `IrModule::parse` begins with `IrHeader::parse`, which
    /// rejects a version mismatch outright (`IrError::UnsupportedVersion` —
    /// see the note in `EmbeddedPage::load` above). Any module that reached
    /// the `assert_eq!` had already passed the identical comparison, so it
    /// could only ever agree, and the per-page "does it load" half is
    /// re-exercised by every other test in those files.
    ///
    /// What is NOT tautological, and is what this pins instead: WHICH routes
    /// the embed carries. `/`, `/map`, `/start`, `/setup`, `/profiles` and
    /// `/workspace` were deleted in the 2026-08-25 cutover. A stale manifest
    /// that still shipped one of their IR modules would let a route come back
    /// from the dead with no handler behind it, and `EmbeddedPage::load`'s own
    /// doc warns that the old `"/"` and `"/map"` examples would now panic at
    /// every call site.
    /// **No page links into a deleted one, and every page can reach the
    /// product page.**
    ///
    /// REPLACES 2026-08-26 three byte-identical copies — `render_check.rs` and
    /// `render_devices.rs` both had `the_nav_reaches_every_sibling_page`, and
    /// `render_pads.rs` had `the_nav_reaches_the_other_screens`. They differed
    /// only in which page they rendered. Both names also overclaimed: there
    /// are no sibling pages any more, only one workflow link plus this
    /// blocklist. The redesign joined this shared guard when it became the
    /// destination of the tool pages.
    ///
    /// Folding them closes a real gap rather than just saving runtime.
    /// `/nocturne` had NO dead-link blocklist at all — the one page that
    /// absorbed all five deleted surfaces, and therefore has by far the most
    /// links and by far the most chances to keep pointing at one of them, was
    /// the only page nothing checked. It is clean today; it was simply
    /// unguarded.
    ///
    /// The dead set is the 2026-08-25 cutover: `/`, `/map`, `/start`,
    /// `/setup`, `/profiles` and `/workspace` all 404 now.
    #[test]
    fn no_page_links_into_a_deleted_surface() {
        const DEAD: [&str; 6] = [
            r#"href="/""#,
            r#"href="/start"#,
            r#"href="/map"#,
            r#"href="/setup"#,
            r#"href="/profiles"#,
            r#"href="/workspace"#,
        ];

        let pages: [(&str, String); 5] = [
            (
                "/nocturne",
                crate::render_nocturne::render_nocturne(
                    &EmbeddedPage::load("/nocturne").unwrap(),
                    &crate::snapshot::NocturnePayload::default(),
                    None,
                )
                .html,
            ),
            (
                "/check",
                crate::render_check::render_check(
                    &EmbeddedPage::load("/check").unwrap(),
                    &crate::snapshot::CheckPayload::default(),
                )
                .html,
            ),
            (
                "/pads",
                crate::render_pads::render_pads(
                    &EmbeddedPage::load("/pads").unwrap(),
                    &crate::snapshot::PadsPayload::default(),
                )
                .html,
            ),
            (
                "/devices",
                crate::render_devices::render_devices(
                    &EmbeddedPage::load("/devices").unwrap(),
                    &crate::snapshot::DevicesPayload::default(),
                    None,
                )
                .html,
            ),
            (
                "/redesign",
                crate::render_redesign::render_redesign(
                    &EmbeddedPage::load("/redesign").unwrap(),
                    &crate::snapshot::RedesignPayload::default(),
                    None,
                )
                .html,
            ),
        ];

        for (route, html) in &pages {
            for dead in DEAD {
                assert!(
                    !html.contains(dead),
                    "{route} still renders the dead link {dead} — that surface 404s"
                );
            }
        }

        // The three focused tool pages carry the rail: one link to the current
        // workbench, and their own entry marked as current.
        for (route, html) in pages
            .iter()
            .filter(|(r, _)| matches!(*r, "/check" | "/pads" | "/devices"))
        {
            assert!(
                html.contains(r#"<a class="navlink workflow-link" href="/redesign">"#),
                "{route} cannot reach the product page"
            );
            assert!(
                html.contains(&format!(r#"<a href="{route}" aria-current="page">"#)),
                "{route} does not mark itself as the current page"
            );
        }

        // Both product shells expose every focused recovery tool. This stays
        // true until Nocturne is retired; a route existing in the router is
        // not enough if a person cannot discover it from the product.
        for (route, html) in pages
            .iter()
            .filter(|(r, _)| matches!(*r, "/nocturne" | "/redesign"))
        {
            for tool in ["/check", "/pads", "/devices"] {
                assert!(
                    html.contains(&format!(r#"href="{tool}""#)),
                    "{route} cannot reach the operational tool {tool}"
                );
            }
        }
    }

    #[test]
    fn the_embed_ships_exactly_the_live_routes() {
        const LIVE: [&str; 5] = ["/nocturne", "/check", "/pads", "/devices", "/redesign"];
        const DELETED: [&str; 6] = ["/", "/map", "/start", "/setup", "/profiles", "/workspace"];

        let raw = Assets::get("manifest.json").expect("manifest.json is embedded");
        let manifest: serde_json::Value =
            serde_json::from_slice(&raw.data).expect("manifest.json parses");
        let routes = manifest["routes"]
            .as_object()
            .expect("the manifest carries a route table");

        let mut names: Vec<&str> = routes.keys().map(String::as_str).collect();
        names.sort_unstable();
        let mut expected = LIVE.to_vec();
        expected.sort_unstable();
        assert_eq!(
            names, expected,
            "the embed's route table is not the set of live pages"
        );

        for route in DELETED {
            assert!(
                !routes.contains_key(route),
                "deleted route {route:?} is back in the manifest — it 404s in the \
                 router, so shipping IR for it is a page nobody can reach"
            );
        }

        // Every live route's IR actually loads and parses. This is the real
        // content of the three deleted tests, stated once.
        for route in LIVE {
            let page = EmbeddedPage::load(route)
                .unwrap_or_else(|e| panic!("the embedded {route} page must load: {e:?}"));
            assert!(
                !page.module.slots.entries().is_empty(),
                "{route} parsed to an IR module with no slots at all"
            );
        }
    }
}
