//! **The contrast contract, enforced.**
//!
//! `docs/DESIGN-SYSTEM.md` §3 says text is ≥ 4.5:1 against the surface it sits
//! on, in both themes. That sentence has been true only by inspection: every
//! ratio in that document was measured once, by hand, at the moment it was
//! written, and nothing has re-measured them since. Tokens drift — a number in
//! a doc does not defend itself.
//!
//! So this file re-derives every ratio from the CSS that actually ships, on
//! every `cargo test`. It parses the sheet — since TK0 the generated
//! `tokens.gen.css` (compiled from `studio-ui/tokens/`, the single palette
//! source) concatenated with the authored `studio.css`, the same order the
//! build hashes them — rather than restating values, because a test that
//! hardcodes the palette is a second copy of the palette and would drift in
//! exactly the same way.
//!
//! # What it checks, and why those pairs
//!
//! Not the cartesian product of colors and grounds — that would fail on
//! combinations the app never draws and force the palette darker than the
//! design needs. The ground sets below are the ones that **actually compose**
//! in `studio.css`:
//!
//! - **Text tiers** sit on all four panel grounds, and on `--panel-3` when a
//!   control is hovered. `--panel-3` carries only `--text`/`--text-2`: every
//!   `:hover` rule that sets it also sets one of those two
//!   (`.btn:hover`, `.tab:hover`, `.navlink:active`), so `--text-3` is not
//!   checked against it.
//! - **Colored roles** sit on the four panel grounds — including
//!   `--bg-2`, which is a real card ground (`.legendcard`, `.macrocard`,
//!   `.hint`, `.grid .card`, `.strow.sthead`), not just a page wash. They are
//!   never drawn on `--panel-3`.
//! - **A role on its own tint** is the state triad from §3 ("dot + tint +
//!   full-strength text"), and it is the case hand-measurement misses: a pill
//!   is accent text on `--accent-dim`, not accent text on the panel. Three of
//!   the four real defects this file was written to catch were of this shape.
//!
//! # Floors
//!
//! | Pair | Floor | Source |
//! |---|---|---|
//! | anything that renders as text | 4.5 | WCAG 2.2 AA, and DESIGN-SYSTEM §3 |
//! | the focus ring against its ground | 3.0 | WCAG 2.2 AA non-text (1.4.11) |
//! | a separator against its ground | 1.12 | calibrated, see below |
//!
//! The 1.12 separator floor is **not** a WCAG number. Hairline borders in this
//! system are decorative — §5's "dark mode separates by surface lightness + a
//! hairline border" — and the perceivable boundary that 1.4.11 actually cares
//! about is the focus ring, which is held to 3.0 above. 1.12 is the faintest
//! separator in the theme that shipped and was reviewed (dark
//! `--line-soft`/`--panel`), so it encodes "no worse than what we already
//! accepted" and catches a token going flat, without pretending to be an
//! accessibility threshold.

use std::collections::BTreeMap;

/// The sheet as the browser reads it: the GENERATED token CSS first, the
/// authored component CSS after — the same order build.mjs concatenates them
/// into the hashed studio.<hash>.css. Since TK0 every token lives in
/// tokens.gen.css (compiled from studio-ui/tokens/), and build-tokens.mjs
/// fails the build if a `:root` block or a second light media query creeps
/// back into studio.css — which is what keeps `split_themes` below reading
/// the right region.
const CSS: &str = concat!(
    include_str!("../../../studio-ui/src/tokens.gen.css"),
    "\n", // generateCss joins array inputs with \n — keep the constant byte-exact
    include_str!("../../../studio-ui/src/genui-canvas.css"),
    "\n",
    include_str!("../../../studio-ui/src/studio.css"),
);
/// The generated Rust module the anti-flash pin reads. An integration test
/// cannot see a `pub(crate)` const, so the pin matches the module's SOURCE —
/// which obliges the generator to emit each pinned rule as one unbroken
/// string literal (no concat seams or line continuations mid-rule).
const THEME_TOKENS_RS: &str = include_str!("../src/theme_tokens.rs");
/// The controller art as SHIPPED: the committed embed output, which CI pins
/// to a fresh build. Parsing the emitted asset (rather than build.mjs's
/// source, as this file did while the sheet was hand-mirrored) checks the
/// whole chain: token source → build.mjs templating → the SVG a browser gets.
const PAD_XBOX_SVG: &str = include_str!("../assets/pad-xbox.svg");
const PAD_DS4_SVG: &str = include_str!("../assets/pad-ds4.svg");

const TEXT_FLOOR: f64 = 4.5;
const NON_TEXT_FLOOR: f64 = 3.0;
/// See the module docs: calibrated to the outgoing theme, not to WCAG.
const SEPARATOR_FLOOR: f64 = 1.12;

// ── color ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rgba {
    r: f64,
    g: f64,
    b: f64,
    a: f64,
}

impl Rgba {
    fn opaque(r: u8, g: u8, b: u8) -> Self {
        Self {
            r: r as f64,
            g: g as f64,
            b: b as f64,
            a: 1.0,
        }
    }

    /// Composite `self` over `bg`. The tint tokens are the whole reason this
    /// exists: `--accent-dim` is `rgba(accent, 0.13)`, and what a reader sees
    /// is that *over a ground*, which is neither of the two colors named.
    fn over(self, bg: Rgba) -> Rgba {
        Rgba {
            r: self.r * self.a + bg.r * (1.0 - self.a),
            g: self.g * self.a + bg.g * (1.0 - self.a),
            b: self.b * self.a + bg.b * (1.0 - self.a),
            a: 1.0,
        }
    }

    fn luminance(self) -> f64 {
        fn chan(c: f64) -> f64 {
            let s = c / 255.0;
            if s <= 0.040_45 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        }
        0.2126 * chan(self.r) + 0.7152 * chan(self.g) + 0.0722 * chan(self.b)
    }
}

/// WCAG 2.x relative-contrast ratio. Both inputs must already be opaque.
fn ratio(fg: Rgba, bg: Rgba) -> f64 {
    let (a, b) = (fg.luminance(), bg.luminance());
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

fn parse_color(raw: &str) -> Option<Rgba> {
    let raw = raw.trim();
    if let Some(h) = raw.strip_prefix('#') {
        let h = h.trim();
        return match h.len() {
            6 => Some(Rgba::opaque(
                u8::from_str_radix(&h[0..2], 16).ok()?,
                u8::from_str_radix(&h[2..4], 16).ok()?,
                u8::from_str_radix(&h[4..6], 16).ok()?,
            )),
            3 => {
                let d = |i: usize| -> Option<u8> {
                    let c = u8::from_str_radix(&h[i..=i], 16).ok()?;
                    Some(c * 17)
                };
                Some(Rgba::opaque(d(0)?, d(1)?, d(2)?))
            }
            _ => None,
        };
    }
    if let Some(rest) = raw.strip_prefix("rgba(").and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<f64> = rest
            .split(',')
            .map(|p| p.trim().parse::<f64>().unwrap_or(f64::NAN))
            .collect();
        if parts.len() == 4 && !parts.iter().any(|v| v.is_nan()) {
            return Some(Rgba {
                r: parts[0],
                g: parts[1],
                b: parts[2],
                a: parts[3],
            });
        }
    }
    None
}

// ── parsing the sheet (tokens.gen.css + studio.css) ──────────────────────

/// The light theme lives in `@media (prefers-color-scheme: light)`. Everything
/// before it is the dark theme plus the theme-agnostic primitives; the media
/// block is an override layer on top.
fn split_themes(css: &str) -> (String, String) {
    let marker = "@media (prefers-color-scheme: light)";
    let start = css
        .find(marker)
        .expect("tokens.gen.css must contain the light-theme media query");
    let after = &css[start..];
    let open = after.find('{').expect("media query must open a block");
    let mut depth = 0usize;
    let mut end = None;
    for (i, ch) in after[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end.expect("light media query must close");
    (css[..start].to_owned(), after[open..=end].to_owned())
}

/// Every `--name: <color>` declaration in `block`. Non-color custom
/// properties (`--macrow: 1.9rem`) simply do not parse and are skipped.
fn tokens(block: &str) -> BTreeMap<String, Rgba> {
    let mut out = BTreeMap::new();
    for line in block.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("--") else {
            continue;
        };
        let Some((name, value)) = rest.split_once(':') else {
            continue;
        };
        // Several tokens carry a trailing `/* … */` note on the same line
        // (`--accent-on: #04241f; /* text ON an accent fill */`), so the
        // comment has to come off before the semicolon does.
        let value = value.split("/*").next().unwrap_or(value);
        let value = value.trim().trim_end_matches(';').trim();
        if let Some(c) = parse_color(value) {
            out.insert(name.trim().to_owned(), c);
        }
    }
    out
}

struct Theme {
    name: String,
    /// `dark` or `light` — what the block's own `color-scheme` declares.
    /// Scrollbars and form controls follow it, so the anti-flash pin needs it
    /// per theme.
    scheme: String,
    tok: BTreeMap<String, Rgba>,
}

/// Replace every `/* … */` comment with spaces (newlines kept), so the
/// line-based parsers below cannot be poisoned by declaration-shaped text or
/// a `:root[data-theme="` marker INSIDE a comment — the concat carries the
/// authored sheet's prose and every theme file's note, and a changelog line
/// like `--accent: #0b7d72;` in a comment would otherwise last-wins into the
/// token map with every gate green (review-caught vector).
fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("*/") {
            Some(end) => {
                out.extend(
                    after[..end]
                        .chars()
                        .map(|c| if c == '\n' { '\n' } else { ' ' }),
                );
                rest = &after[end + 2..];
            }
            None => rest = "",
        }
    }
    out.push_str(rest);
    out
}

/// Every declaration in a block, TEXTUALLY: custom properties AND
/// `color-scheme`, values whitespace-normalized but otherwise verbatim. The
/// mirror check below uses this because parsed-color comparison has subset
/// semantics and color-only coverage — an omitted token or a diverging
/// `--ground`/`--e-*`/`--font-sans` would slip through it.
fn declarations(block: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in block.lines() {
        let line = line.trim();
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if !name.starts_with("--") && name != "color-scheme" {
            continue;
        }
        let value = value.trim().trim_end_matches(';').trim();
        out.insert(
            name.to_owned(),
            value.split_whitespace().collect::<Vec<_>>().join(" "),
        );
    }
    out
}

/// The `color-scheme` a block declares — the one non-custom-property line
/// the theme machinery cares about.
fn scheme_of(block: &str) -> Option<String> {
    block
        .lines()
        .find_map(|l| l.trim().strip_prefix("color-scheme:"))
        .map(|v| v.trim().trim_end_matches(';').to_owned())
}

impl Theme {
    fn get(&self, name: &str) -> Rgba {
        *self.tok.get(name).unwrap_or_else(|| {
            panic!(
                "{}: token --{name} is missing from the token source \
                     (studio-ui/tokens/, emitted into tokens.gen.css)",
                self.name
            )
        })
    }

    /// The four grounds a panel-level color can legitimately sit on.
    fn panel_grounds(&self) -> Vec<(&'static str, Rgba)> {
        vec![
            ("--bg (surface)", self.get("bg")),
            ("--bg-2 (sunken)", self.get("bg-2")),
            ("--panel", self.get("panel")),
            ("--panel-2 (inset)", self.get("panel-2")),
        ]
    }
}

/// Every `:root[data-theme="X"] { … }` block in the sheet, in document order.
/// TK1 taught the gate to ENUMERATE themes instead of hardcoding two; the
/// stamped blocks arrive with TK2 (the dark/light pins) and TK3+ (new
/// themes), and land after the light media block, outside `split_themes`'s
/// scan regions — this is the parser that sees them.
fn data_theme_blocks(css: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let marker = ":root[data-theme=\"";
    let mut at = 0usize;
    while let Some(rel) = css[at..].find(marker) {
        let name_start = at + rel + marker.len();
        let name_end = name_start
            + css[name_start..]
                .find('"')
                .expect("data-theme selector must close its quote");
        let name = css[name_start..name_end].to_owned();
        let open = name_end
            + css[name_end..]
                .find('{')
                .expect("data-theme block must open");
        let mut depth = 0usize;
        let mut end = None;
        for (i, ch) in css[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.expect("data-theme block must close");
        out.push((name, css[open..=end].to_owned()));
        at = end;
    }
    out
}

fn themes() -> Vec<Theme> {
    let css = strip_comments(CSS);
    let (dark_block, light_block) = split_themes(&css);
    let base = tokens(&dark_block);
    let mut light = base.clone();
    light.extend(tokens(&light_block));
    let mut out = vec![
        Theme {
            name: "dark".to_owned(),
            scheme: scheme_of(&dark_block).expect("the base block must declare color-scheme"),
            tok: base.clone(),
        },
        Theme {
            name: "light".to_owned(),
            scheme: scheme_of(&light_block).expect("the light block must declare color-scheme"),
            tok: light,
        },
    ];

    // The stamped blocks. An id that names an existing map ("dark" pins the
    // base values, "light" the media block's — both generated from ONE
    // source) must MATCH it token-for-token: a divergence means the generator
    // emitted two truths for one token, the exact drift class this file
    // exists to kill. Any other id is a real theme: the base map overlaid,
    // and every floor test below runs over it automatically.
    for (name, block) in data_theme_blocks(&css) {
        let declared = tokens(&block);
        if let Some(existing) = out.iter().find(|t| t.name == name) {
            for (tok_name, val) in &declared {
                let want = existing.tok.get(tok_name).unwrap_or_else(|| {
                    panic!("[data-theme={name}]: pins --{tok_name}, which the {name} map lacks")
                });
                assert_eq!(
                    val, want,
                    "[data-theme={name}]: --{tok_name} disagrees with the {name} map — \
                     the generator emitted two truths for one token"
                );
            }
            // The light mirror also gets a TEXTUAL set-equality check
            // against the media block: the parsed-color pass above has
            // subset semantics and reads only colors, so an omitted token
            // or a diverging non-color value (--ground, the shadows, an
            // optional --font-sans override) would slip through it while
            // the two "one source" copies quietly disagreed.
            if name == "light" {
                assert_eq!(
                    declarations(&block),
                    declarations(&light_block),
                    "[data-theme=light] must declare exactly what the system-follow \
                     media block declares — both are generated from themes/light.json, \
                     so any difference is the generator emitting two truths"
                );
            }
        } else {
            let scheme = scheme_of(&block).unwrap_or_else(|| {
                panic!("[data-theme={name}]: every theme block declares color-scheme")
            });
            let mut tok = base.clone();
            tok.extend(declared);
            out.push(Theme { name, scheme, tok });
        }
    }
    out
}

// ── the report ───────────────────────────────────────────────────────────

#[derive(Default)]
struct Report {
    lines: Vec<String>,
    failures: Vec<String>,
}

impl Report {
    fn check(&mut self, floor: f64, theme: &str, label: &str, fg: Rgba, bg: Rgba) {
        let v = ratio(fg, bg);
        self.lines
            .push(format!("  {v:6.2}  (>={floor:.2})  {theme:<5} {label}"));
        if v < floor {
            self.failures
                .push(format!("{theme}: {label} = {v:.2}:1, floor {floor:.2}:1"));
        }
    }

    fn finish(self, what: &str) {
        // Always print the measurements: the point of this test is the table,
        // not the boolean. `cargo test -- --nocapture` is the design review.
        println!("── {what} ──");
        for l in &self.lines {
            println!("{l}");
        }
        assert!(
            self.failures.is_empty(),
            "\n{} contrast failure(s) in {what}:\n  {}\n\n\
             Fix the TOKEN, not the component rule that revealed it \
             (DESIGN-SYSTEM §13.1). If a pair is a deliberate exemption, it \
             belongs in this file with its reason, not in a comment \
             somewhere else.\n",
            self.failures.len(),
            self.failures.join("\n  ")
        );
    }
}

// ── the checks ───────────────────────────────────────────────────────────

/// The three text tiers, on every ground that renders text.
#[test]
fn text_tiers_clear_the_floor_on_every_ground() {
    let mut r = Report::default();
    for t in themes() {
        for (gn, g) in t.panel_grounds() {
            for tier in ["text", "text-2", "text-3"] {
                r.check(
                    TEXT_FLOOR,
                    &t.name,
                    &format!("--{tier} on {gn}"),
                    t.get(tier),
                    g,
                );
            }
        }
        // `--panel-3` is the control fill under the cursor, and it gets ALL
        // THREE tiers — no carve-out.
        //
        // It used to get only --text and --text-2, justified by "every rule
        // that sets --panel-3 also sets --text or --text-2". That was an
        // unreachability claim about the markup, made in a comment, and this
        // stylesheet already contained its counter-example: `.tab .tabnum` is
        // a DESCENDANT with its own `--text-tertiary`, so `.tab:hover`'s
        // `color:` never reaches it. It is not rendered today, which is the
        // only reason light `--text-3` on `--panel-3` (4.41:1) was not
        // shipping — a fact about markup that no longer exists, guarding a
        // pair in the stylesheet that still does. The token was corrected
        // instead; this loop is what keeps it corrected.
        let hover = t.get("panel-3");
        for tier in ["text", "text-2", "text-3"] {
            r.check(
                TEXT_FLOOR,
                &t.name,
                &format!("--{tier} on --panel-3 (hover)"),
                t.get(tier),
                hover,
            );
        }
    }
    r.finish("text tiers");
}

/// Accent, identity and the three state colors, drawn as text.
#[test]
fn colored_roles_clear_the_floor_as_text() {
    let mut r = Report::default();
    for t in themes() {
        for (gn, g) in t.panel_grounds() {
            for role in ["accent", "accent-strong", "cool", "ok", "warn", "danger"] {
                r.check(
                    TEXT_FLOOR,
                    &t.name,
                    &format!("--{role} on {gn}"),
                    t.get(role),
                    g,
                );
            }
        }
    }
    r.finish("colored roles as text");
}

/// The state triad: full-strength text on its own tint, over each ground.
/// This is the pair that hand-measurement misses — and the one that caught
/// the light accent (3.33:1 on `--accent-dim-2` over `--bg-2`).
#[test]
fn role_text_clears_the_floor_on_its_own_tint() {
    let mut r = Report::default();
    for t in themes() {
        for (gn, g) in t.panel_grounds() {
            for (role, tint) in [
                ("accent", "accent-dim"),
                ("accent", "accent-dim-2"),
                ("ok", "ok-dim"),
                ("warn", "warn-dim"),
                ("danger", "danger-dim"),
            ] {
                let composed = t.get(tint).over(g);
                r.check(
                    TEXT_FLOOR,
                    &t.name,
                    &format!("--{role} on --{tint} over {gn}"),
                    t.get(role),
                    composed,
                );
            }
        }
    }
    r.finish("role text on its own tint");
}

/// Text drawn ON a solid role plate: the primary button and Stop.
#[test]
fn text_on_solid_role_plates_clears_the_floor() {
    let mut r = Report::default();
    for t in themes() {
        r.check(
            TEXT_FLOOR,
            &t.name,
            "--accent-on over --accent-fill (.btn-primary)",
            t.get("accent-on"),
            t.get("accent-fill"),
        );
        r.check(
            TEXT_FLOOR,
            &t.name,
            "--danger-on over --danger-fill (Stop)",
            t.get("danger-on"),
            t.get("danger-fill"),
        );
        r.check(
            TEXT_FLOOR,
            &t.name,
            "--accent-on over --accent-strong (:hover)",
            t.get("accent-on"),
            t.get("accent-strong"),
        );
    }
    r.finish("text on solid plates");
}

/// The focus ring is the one non-text element with a real accessibility
/// floor (WCAG 1.4.11): it must be perceivable on every surface it can land
/// on, including a hovered control.
#[test]
fn focus_ring_clears_the_non_text_floor() {
    let mut r = Report::default();
    for t in themes() {
        let mut grounds = t.panel_grounds();
        grounds.push(("--panel-3 (hover)", t.get("panel-3")));
        for (gn, g) in grounds {
            r.check(
                NON_TEXT_FLOOR,
                &t.name,
                &format!("--focus on {gn}"),
                t.get("focus"),
                g,
            );
        }
    }
    r.finish("focus ring");
}

/// Separators must stay perceptible. Calibrated, not a WCAG floor — see the
/// module docs.
#[test]
fn separators_stay_perceptible() {
    let mut r = Report::default();
    for t in themes() {
        for (line, grounds) in [
            ("line", vec!["panel", "bg", "panel-2"]),
            ("line-soft", vec!["panel"]),
            ("line-strong", vec!["panel"]),
        ] {
            for g in grounds {
                r.check(
                    SEPARATOR_FLOOR,
                    &t.name,
                    &format!("--{line} on --{g}"),
                    t.get(line),
                    t.get(g),
                );
            }
        }
    }
    r.finish("separators");
}

/// The controller art's printed markings.
///
/// `--hw-xbox-b` and `--hw-xbox-x` are a **recorded exemption**, not an
/// oversight: white on those two reds/blues is what the physical pad prints,
/// the art is a picture of a device rather than a label, and every hit zone
/// carries an `aria-label` naming the control and its bound keys. Pinning
/// them here means changing them is a decision somebody has to make on
/// purpose.
///
/// (That citation used to read `render_map.rs`. Those `aria-label`s moved to
/// the nocturne canvas with the 2026-08-21 pivot, and `render_map.rs` now
/// contains none at all — the accessibility claim this exemption rests on is
/// carried by `NocturneIsland.ts`.)
#[test]
fn hardware_markings_are_either_legible_or_a_recorded_exemption() {
    let (dark_block, _) = split_themes(&strip_comments(CSS));
    let t = Theme {
        name: "hw".to_owned(),
        scheme: "dark".to_owned(),
        tok: tokens(&dark_block),
    };
    let mut r = Report::default();

    // The pairs that must clear the text floor.
    r.check(
        TEXT_FLOOR,
        "hw",
        "xbox A letter on its disc",
        t.get("hw-xbox-a-on"),
        t.get("hw-xbox-a"),
    );
    r.check(
        TEXT_FLOOR,
        "hw",
        "xbox Y letter on its disc",
        t.get("hw-xbox-y-on"),
        t.get("hw-xbox-y"),
    );
    for glyph in ["circle", "cross", "triangle", "square"] {
        r.check(
            TEXT_FLOOR,
            "hw",
            &format!("PS {glyph} on --hw-ps-disc"),
            t.get(&format!("hw-ps-{glyph}")),
            t.get("hw-ps-disc"),
        );
    }
    r.finish("hardware markings");

    // The exemption, pinned. If someone repaints these, this fires and they
    // have to come back to the comment above and decide again.
    // FIXED 2026-08-26: this was `(got - expected).abs() < 0.02`, which
    // contradicted its own message — the text said an increase "is fine", and
    // the assertion failed on one. Repainting `--hw-xbox-b` from 4.00:1 to
    // 5.50:1, a strict accessibility improvement, broke the build. A floor is
    // the honest shape for an exemption: the pin is the WORST this may be.
    for (name, expected) in [("hw-xbox-b", 4.00_f64), ("hw-xbox-x", 3.94_f64)] {
        let got = ratio(t.get("hw-xbox-on"), t.get(name));
        assert!(
            got >= expected - 0.02,
            "--{name} is a recorded contrast exemption whose floor is \
             {expected:.2}:1, but it now measures {got:.2}:1 — it got WORSE. \
             Raising it is always allowed; lowering it is a decision — update \
             the exemption in ksx-studio/tests/contrast.rs and the \
             hardware-markings note in studio-ui/tokens/semantic.json (emitted \
             into tokens.gen.css §1)."
        );
        // ...and if it improved a lot, say so, so the floor is raised on
        // purpose rather than drifting upward unrecorded.
        assert!(
            got <= expected + 0.75,
            "--{name} now measures {got:.2}:1 against a recorded floor of \
             {expected:.2}:1. That is an improvement — raise the pin in \
             ksx-studio/tests/contrast.rs so the new value is what is defended."
        );
    }
}

/// Placeholder text, which is **not** exempt from the text floor.
///
/// `input::placeholder` takes `--text-tertiary` and sits on the field's own
/// `--surface-inset`, inside a card or the page. It carries meaning ("what
/// goes here"), it is not an inactive control, and nothing else in this file
/// measured it.
#[test]
fn placeholder_text_clears_the_text_floor() {
    let mut r = Report::default();
    for t in themes() {
        // The field is `--panel-2`; the card/page grounds are where a field
        // with a transparent-ish inset can still be read against.
        for ground in ["panel-2", "panel", "bg"] {
            r.check(
                TEXT_FLOOR,
                &t.name,
                &format!("--text-3 placeholder on --{ground}"),
                t.get("text-3"),
                t.get(ground),
            );
        }
    }
    r.finish("placeholder text");
}

/// Disabled controls — a **recorded exemption**, pinned.
///
/// WCAG 2.2 SC 1.4.3 exempts "text ... that is part of an inactive user
/// interface component", so these are conformant at any ratio; raising them
/// to 4.5 would defeat the affordance, because "dimmer than the live
/// controls" is precisely what communicates the state. They are pinned rather
/// than skipped because §13.7 says an exemption ships with its number.
///
/// The live composition: `PadsIsland.ts` renders `<div class="controls off">`
/// holding a `<select disabled>` and a `<button class="btn" disabled>` inside
/// a `.card`. Two rules set opacity on that button — `.controls.off .btn`
/// (0.40) and `.btn:disabled` (0.42) — and the three-class selector wins, so
/// **0.40 is the number that renders**, not 0.42.
///
/// (This doc used to cite `StatusIsland.ts`, deleted with `/` in the
/// 2026-08-25 cutover. The composition itself survived the move onto `/pads`,
/// so the pin still measures something a user can see.)
///
/// CSS `opacity` composites the element's whole buffer over its parent, so
/// the text AND the field fade together; that is why this cannot be measured
/// as a plain token pair.
#[test]
fn disabled_controls_are_a_pinned_exemption() {
    /// `.controls.off .btn` / `.controls.off select`.
    const DISABLED_OPACITY: f64 = 0.40;

    fn faded(c: Rgba, alpha: f64, parent: Rgba) -> Rgba {
        Rgba {
            r: c.r * alpha + parent.r * (1.0 - alpha),
            g: c.g * alpha + parent.g * (1.0 - alpha),
            b: c.b * alpha + parent.b * (1.0 - alpha),
            a: 1.0,
        }
    }

    // Measured 2026-08-06 (dark/light). PER-THEME PIN TABLE (TK1): every
    // theme ships its exemption numbers (DESIGN-SYSTEM §13.7) — a theme with
    // no row here fails loudly rather than inheriting anything. Dark reads
    // noticeably better than light because fading toward a bright parent
    // collapses the pair faster.
    const DISABLED_PINS: &[(&str, f64)] = &[("dark", 3.45), ("light", 2.36), ("matrix", 3.66)];
    for t in themes() {
        let expected = DISABLED_PINS
            .iter()
            .find(|(n, _)| *n == t.name)
            .map(|(_, v)| *v)
            .unwrap_or_else(|| {
                panic!(
                    "theme '{}' has no recorded disabled-control pin — measure the \
                     composite (this test prints it), decide it per DESIGN-SYSTEM \
                     §3.5/§13.7, and add the row to DISABLED_PINS",
                    t.name
                )
            });
        let card = t.get("panel");
        let label = faded(t.get("text"), DISABLED_OPACITY, card);
        let field = faded(t.get("panel-2"), DISABLED_OPACITY, card);
        let got = ratio(label, field);
        assert!(
            (got - expected).abs() < 0.02,
            "{}: the disabled control label measures {got:.2}:1, pinned at \
             {expected:.2}:1. This pair is a WCAG 1.4.3 exemption (inactive \
             component), NOT a free pass — if it moved, decide again and update \
             both this pin and DESIGN-SYSTEM §3.5.",
            t.name
        );
    }

    // DELETED 2026-08-26: Case 2, "the read-only mapper" (STALE), and the
    // DEAD_PINS table with it. It pinned six contrast ratios for
    // `.zone.z-dead` / `.lrow.l-dead` over `.legendcard`. Those three classes
    // exist ONLY in studio.css — no `.ts`, `.rs`, compiled `.js` or compiled
    // `.ir` in this tree emits any of them. They were `/map`'s read-only
    // mapper, and `/map` was deleted in the 2026-08-25 cutover.
    // The current redesign fail-closed HTTP coverage records the same finding
    // from the other side: unavailable state must remain legible rather than
    // being painted as an empty or live-looking workbench.
    //
    // The DESIGN QUESTION it raised outlives the pin, so it is kept here:
    // dimming REFERENCE TEXT (a bindings legend the user reads) is not the
    // same exemption as dimming an INACTIVE COMPONENT (a Start button they
    // cannot press), and WCAG 1.4.3 grants only the latter. If a read-only
    // state returns to a future editor, dim the affordance and leave the
    // information at full strength.
}

/// The anti-flash `<style>` used to be a hand copy of `--bg`/`--text` in two
/// files, and it HAD drifted before this test existed (`#0b0e14` against a
/// stylesheet that had moved to `#0a0d13`) — a wrong anti-flash color looks
/// exactly like the flash it exists to prevent. Since TK0 the const is
/// GENERATED into `theme_tokens.rs` from the same token source as the sheet,
/// so it cannot drift by hand — this pin now guards the other failure mode:
/// the generator emitting CSS and Rust that disagree.
#[test]
fn anti_flash_css_matches_the_tokens_it_mirrors() {
    let themes = themes();
    let dark = themes
        .iter()
        .find(|t| t.name == "dark")
        .expect("dark theme present");
    let light = themes
        .iter()
        .find(|t| t.name == "light")
        .expect("light theme present");

    let mut expected = vec![
        // Base + the system-follow light media rules, color-scheme included:
        // without it, scrollbars and form controls first-paint in the OS
        // scheme while the sheet is pending — the same flash class at
        // smaller scale (review-caught during TK2's design).
        "html{color-scheme:dark}".to_owned(),
        format!(
            "body{{background:{};color:{};margin:0}}",
            css_hex(dark.get("bg")),
            css_hex(dark.get("text"))
        ),
        "@media (prefers-color-scheme:light){html{color-scheme:light}".to_owned(),
        format!(
            "body{{background:{};color:{}}}",
            css_hex(light.get("bg")),
            css_hex(light.get("text"))
        ),
    ];
    // One rule pair per ENUMERATED theme: a stamped choice must win first
    // paint in both OS schemes, and a theme the sheet ships without an
    // anti-flash rule would flash the base theme at exactly its users.
    for t in &themes {
        expected.push(format!(
            "html[data-theme={}]{{color-scheme:{}}}",
            t.name, t.scheme
        ));
        expected.push(format!(
            "html[data-theme={}] body{{background:{};color:{}}}",
            t.name,
            css_hex(t.get("bg")),
            css_hex(t.get("text"))
        ));
    }

    let compact: String = THEME_TOKENS_RS
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    for want in expected {
        let want_compact: String = want.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            compact.contains(&want_compact),
            "theme_tokens.rs: PERSONALITY_CSS must carry `{want}` (derived from \
             the token source). Regenerate through tools/studio-env/build-assets.ps1"
        );
    }
}

/// The controller art carries its own palette sheet because an
/// `<img>`-embedded SVG is its own document and inherits no custom
/// properties. Since TK0 build.mjs TEMPLATES the sheet's four token values
/// from the token source (the bespoke art colors stay literal), so this test
/// parses the sheet out of the SHIPPED asset — checking the whole chain,
/// token source → build.mjs → the bytes a browser gets — instead of
/// build.mjs's source, where the templated values no longer appear as text.
#[test]
fn pad_art_palette_stays_separable() {
    let sheet = PAD_XBOX_SVG
        .split("<style>")
        .nth(1)
        .expect("pad-xbox.svg must carry its injected palette <style>");
    let sheet = &sheet[..sheet
        .find("</style>")
        .expect("the palette sheet must close its <style>")];

    // Both pads get the identical sheet injected; pin that with one substring
    // so the DS4 cannot quietly ship a different palette.
    assert!(
        PAD_DS4_SVG.contains(sheet),
        "pad-ds4.svg must carry the same palette sheet as pad-xbox.svg — \
         regenerate both through tools/studio-env/build-assets.ps1"
    );

    let grab = |class: &str, prop: &str, nth: usize| -> Rgba {
        let hits: Vec<&str> = sheet
            .match_indices(class)
            .map(|(i, _)| &sheet[i..])
            .collect();
        let block = hits.get(nth).unwrap_or_else(|| {
            panic!(
                "the pad palette sheet must declare {class} at least {} time(s)",
                nth + 1
            )
        });
        let after = &block[block.find(prop).unwrap_or_else(|| {
            panic!("the pad palette sheet's {class} (occurrence {nth}) must set {prop}")
        })..];
        let hex_start = after.find('#').expect("declaration must use a hex color");
        parse_color(&after[hex_start..hex_start + 7]).expect("valid hex color")
    };

    let mut r = Report::default();
    // Occurrence 0 = dark, occurrence 1 = the prefers-color-scheme:light
    // override inside the same sheet.
    for (nth, theme) in [(0usize, "dark"), (1usize, "light")] {
        let body = grab(".pad-body{", "fill:", nth);
        let stroke = grab(".pad-body{", "stroke:", nth);
        let detail = grab(".pad-detail{", "fill:", nth);
        let inset = grab(".pad-inset{", "fill:", nth);
        // The art is a picture, not text: the floor is the non-text one for
        // the shapes that carry meaning (buttons against the body) and the
        // separator floor for the big slab that is only a region.
        r.check(
            NON_TEXT_FLOOR,
            theme,
            "pad detail on pad body",
            detail,
            body,
        );
        r.check(
            NON_TEXT_FLOOR,
            theme,
            "pad outline on pad body",
            stroke,
            body,
        );
        r.check(
            SEPARATOR_FLOOR,
            theme,
            "pad inset slab on pad body",
            inset,
            body,
        );
    }
    r.finish("controller art");

    // ── the mirrors, pinned ──────────────────────────────────────────────
    //
    // Separation alone does NOT catch drift: a sheet that wanders stays
    // perfectly separable while quietly disagreeing with the page around it.
    // That is how the light outline came to be `#6d6180` after `--text-3`
    // had moved to `#685c7a` — the art kept the old tertiary, and nothing
    // noticed. build.mjs now templates these four values from the token
    // source, so a mismatch here means the COMMITTED asset is stale (or the
    // templating broke), and the fix is a rebuild, not a hand edit.
    //
    // Only the values that really ARE token mirrors are pinned. The dark
    // body fill, dark detail and both insets are bespoke art colors chosen
    // against the silhouette, not copies of anything, so asserting them
    // would be inventing a contract that was never there.
    let themes = themes();
    let dark = themes
        .iter()
        .find(|t| t.name == "dark")
        .expect("dark theme present");
    let light = themes
        .iter()
        .find(|t| t.name == "light")
        .expect("light theme present");
    for (nth, theme, class, prop, token, expect) in [
        (
            0usize,
            "dark",
            ".pad-body{",
            "stroke:",
            "text-3",
            dark.get("text-3"),
        ),
        (
            1usize,
            "light",
            ".pad-body{",
            "stroke:",
            "text-3",
            light.get("text-3"),
        ),
        (
            1usize,
            "light",
            ".pad-body{",
            "fill:",
            "panel-2",
            light.get("panel-2"),
        ),
        (
            1usize,
            "light",
            ".pad-detail{",
            "fill:",
            "text-2",
            light.get("text-2"),
        ),
    ] {
        let got = grab(class, prop, nth);
        assert_eq!(
            css_hex(got),
            css_hex(expect),
            "pad-xbox.svg palette sheet: {theme} {class}{prop} must equal the \
             `--{token}` token it is templated from, but the shipped asset \
             reads {} while the token is {}. The committed art is stale — \
             regenerate through tools/studio-env/build-assets.ps1 (an <img> SVG is its \
             own document and cannot use var(), so the sheet is baked in).",
            css_hex(got),
            css_hex(expect)
        );
    }
}

fn css_hex(c: Rgba) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        c.r.round() as u8,
        c.g.round() as u8,
        c.b.round() as u8
    )
}
