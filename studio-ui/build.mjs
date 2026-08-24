// ksx Studio UI build — TS → FMIR + hashed assets into crates/ksx-studio/assets/.
//
// Run with plain `node build.mjs` (no tsx needed — see
// docs/research/forma-spike-1-fmir-compat.md). Plain-CSS entries only: this
// page needs no tailwind. (The @getforma/build 0.1.8 Windows bug — `npx`
// spawned via execFileSync without shell:true, ENOENT — was fixed in 0.1.9,
// so a `tailwind: true` cssEntry would now work if ever wanted.)
//
// TEN routes — "/start" (the first run), "/workspace" (the Nocturne
// workspace shell, growing toward v0.5's single main screen), "/" (status),
// "/map" (the mapper), "/check", "/pads", "/devices", "/profiles" and
// "/setup" (the configuration: import, export, first run) — plus the vendored
// controller art copied (cleaned) from art/ into the embed.
//
// Adding a route is THREE edits in this file and none of them is optional:
// `entryPoints`, `routes` and `ssrEntryPoints`. Miss any one and
// `EmbeddedPage::load` fails at startup, so Studio does not bind at all.
// (It used to be four: the FMIR version guard at the bottom kept its own list
// until it was rewritten to walk `manifest.routes`, which is the same
// declaration `routes` already is.)
//
// Release baseline: published @getforma/compiler 0.3.1,
// @getforma/build 0.2.0 and @getforma/core 2.0.0. package-lock.json resolves
// all three from the npm registry, so `npm ci` needs no sibling forma-tools
// checkout or machine-local junction. Compiler/build removed the island
// BYPRODUCT scrub and positional seams; core 2.0.0 retired ledger #13(b)'s
// show-branch bundle patch (closure note below).

import { build } from "@getforma/build";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTokens } from "./tokens/build-tokens.mjs";

// NOTHING BUT THIS SCRIPT'S OUTPUT MAY LIVE HERE. `build()` below calls
// `rmSync(outputDir, { recursive: true, force: true })` before it emits
// anything, so any file parked in this directory by another tool disappears
// at the next UI build — silently, and only on the machine that ran it.
//
// That is why the brand icons (tools/icongen) go to
// `crates/ksx-studio/brand/` and are embedded from there as a second
// rust-embed folder. See assets/brand/README.md.
const outputDir = "../crates/ksx-studio/assets";

// ---------------------------------------------------------------------------
// SLOT-NAME COLLISIONS ARE FATAL (docs/FORMA-DOGFOOD.md #9, hardened
// 2026-08-06).
//
// Compiler 0.3.1 keeps every slot name on a page unique by SUFFIXING a
// collision (`signal-scope.ts` uniqueName): a signal declared in two scopes —
// one stray `createSignal` in a `*Page.ts` twin — gives the DEAD declaration
// the unsuffixed name and renames the RENDERED one to `<name>#2`. Injection by
// name then fills a slot nothing renders, and the page shows its authored
// default forever. Nothing errors. The compiler does say so, but it says it as
// one `console.warn` line among the thirteen benign ArrayExpression notes the
// ledger tells you not to chase — which is exactly how a warning gets missed.
//
// So it is not a warning here. `render.rs`'s `assert_island_slot_contract` is
// the durable gate (it reads the emitted IR); this is the early one, on the
// build that caused it.
// ---------------------------------------------------------------------------
const compilerWarnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  const line = args.map(String).join(" ");
  compilerWarnings.push(line);
  // Benign notes are counted and summarised below, not printed: twenty
  // lines of known-benign output is where warning twenty-one hides.
  if (!/is initialized with a \w+ the compiler cannot evaluate/.test(line)) {
    realWarn(...args);
  }
};

// ---------------------------------------------------------------------------
// MAPPABLE ZONES (M11 piece 1b): Rust owns both the controller vocabulary and
// the mapper's persona-specific art geometry. Its freshness test emits and
// verifies tokens/zones.json; this build validates that interchange file and
// turns it into the literal TypeScript tables Forma and the browser consume.
// Keeping the transform here means neither MapIsland.ts nor MapPage.ts carries
// a hand-maintained copy, while the generated output is still rebuilt and
// byte-diffed with every other committed Studio artifact.
// ---------------------------------------------------------------------------
function zoneDataError(detail) {
  throw new Error(`tokens/zones.json: ${detail}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readZoneData(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    zoneDataError(`could not be parsed (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!isRecord(value)) zoneDataError("root must be an object");
  const rootKeys = Object.keys(value).sort();
  const expectedRootKeys = ["ds4", "functions", "version", "xbox"];
  if (rootKeys.join("\0") !== expectedRootKeys.join("\0")) {
    zoneDataError("root must contain exactly version, functions, xbox, and ds4");
  }
  if (value.version !== 1) zoneDataError(`version must be 1, got ${JSON.stringify(value.version)}`);
  if (!Array.isArray(value.functions) || value.functions.length === 0) {
    zoneDataError("functions must be a non-empty array");
  }

  const functions = value.functions.map((fn, index) => {
    if (typeof fn !== "string" || fn.length === 0 || fn.trim() !== fn) {
      zoneDataError(`functions[${index}] must be a non-empty, trimmed string`);
    }
    return fn;
  });
  const functionSet = new Set(functions);
  if (functionSet.size !== functions.length) zoneDataError("functions contains a duplicate spelling");

  const readPersona = (name) => {
    const rows = value[name];
    if (!Array.isArray(rows)) zoneDataError(`${name} must be an array`);
    const seen = new Set();
    const parsed = rows.map((row, index) => {
      const at = `${name}[${index}]`;
      if (!isRecord(row)) zoneDataError(`${at} must be an object`);
      const keys = Object.keys(row).sort();
      const expectedKeys = ["function", "kind", "label", "palette", "rect"];
      if (keys.join("\0") !== expectedKeys.join("\0")) {
        zoneDataError(`${at} must contain exactly function, label, palette, rect, and kind`);
      }
      for (const field of ["function", "label", "palette", "kind"]) {
        if (
          typeof row[field] !== "string" ||
          row[field].length === 0 ||
          row[field].trim() !== row[field]
        ) {
          zoneDataError(`${at}.${field} must be a non-empty, trimmed string`);
        }
      }
      if (!functionSet.has(row.function)) {
        zoneDataError(`${at}.function '${row.function}' is absent from functions`);
      }
      if (seen.has(row.function)) zoneDataError(`${name} repeats function '${row.function}'`);
      seen.add(row.function);
      if (
        !Array.isArray(row.rect) ||
        row.rect.length !== 4 ||
        row.rect.some((part) => typeof part !== "number" || !Number.isFinite(part))
      ) {
        zoneDataError(`${at}.rect must contain exactly four finite numbers`);
      }
      return row;
    });

    const missing = functions.filter((fn) => !seen.has(fn));
    if (missing.length > 0 || seen.size !== functionSet.size) {
      zoneDataError(
        `${name} must cover functions exactly once` +
          (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""),
      );
    }
    return parsed;
  };

  return {
    functions,
    xbox: readPersona("xbox"),
    ds4: readPersona("ds4"),
  };
}

function renderZoneTypescript(data) {
  const functionRows = data.functions.map((fn) => `  { k: ${JSON.stringify(fn)} },`).join("\n");
  const zoneRows = (rows) =>
    rows
      .map((row) => {
        const tuple = [
          row.function,
          row.label,
          row.palette,
          ...row.rect,
          row.kind,
        ];
        return `  [${tuple.map((part) => JSON.stringify(part)).join(", ")}],`;
      })
      .join("\n");

  return (
    "// Generated by studio-ui/build.mjs — DO NOT EDIT.\n" +
    "// Source of truth: studio-ui/tokens/zones.json (emitted and verified by Rust).\n" +
    "// Regenerate: cd studio-ui && node build.mjs\n" +
    "\n" +
    "export interface FunctionOption {\n" +
    "  readonly k: string;\n" +
    "}\n" +
    "\n" +
    "export type ZoneDef = readonly [\n" +
    "  functionName: string,\n" +
    "  label: string,\n" +
    "  palette: string,\n" +
    "  cx: number,\n" +
    "  cy: number,\n" +
    "  width: number,\n" +
    "  height: number,\n" +
    "  kind: string,\n" +
    "];\n" +
    "\n" +
    "export const FUNCTIONS: FunctionOption[] = [\n" +
    `${functionRows}\n` +
    "];\n" +
    "\n" +
    "export const ZONE_XBOX: readonly ZoneDef[] = [\n" +
    `${zoneRows(data.xbox)}\n` +
    "];\n" +
    "\n" +
    "export const ZONE_DS4: readonly ZoneDef[] = [\n" +
    `${zoneRows(data.ds4)}\n` +
    "];\n"
  );
}

// ---------------------------------------------------------------------------
// TOKENS FIRST (TK0, docs/research/token-system-design.md): studio-ui/tokens/
// is the single source of the palette. buildTokens() validates it (throws —
// fatal, like a slot collision) and emits the COMMITTED generated files:
// src/tokens.gen.css (prepended into the hashed sheet below) and
// crates/ksx-studio/src/theme_tokens.rs (the anti-flash const the render
// seams share), plus src/zones.gen.ts from Rust's interchange file. All are
// pinned by the same ci.yml byte-diff as assets/ and are LF from birth. The
// token build also validates that src/studio.css itself stayed
// token-free — a leftover :root block or prefers-color-scheme query would
// shadow the generated tokens while the contrast gate (which reads only the
// FIRST light marker) stayed green.
// ---------------------------------------------------------------------------
const authoredCss = readFileSync("src/studio.css", "utf8").replace(/\r\n?/g, "\n");
const tokens = buildTokens({ authoredCss });
writeFileSync("src/tokens.gen.css", tokens.css, "utf8");
writeFileSync("../crates/ksx-studio/src/theme_tokens.rs", tokens.rustModule, "utf8");
const zoneData = readZoneData("tokens/zones.json");
writeFileSync("src/zones.gen.ts", renderZoneTypescript(zoneData), "utf8");

// @getforma/build 0.2.0 concatenates plain CSS byte-for-byte. A Windows
// worktree can therefore hand it mixed/CRLF bytes while a clean Actions
// checkout hands it LF, producing different content hashes from the same Git
// commit. Feed the framework ephemeral LF-normalized copies instead. The CSS
// has no relative @import/url references, so changing its temporary directory
// cannot change resolution semantics. generateCss accepts an ARRAY input and
// joins the files with "\n" before hashing, so the token sheet is prepended
// with no framework patch.
const cssTempDir = mkdtempSync(join(tmpdir(), "ksx-studio-css-"));
const tokensCssTmp = join(cssTempDir, "tokens.gen.css");
writeFileSync(tokensCssTmp, tokens.css, "utf8");
// The vendored genui canvas sheet (studio-ui/src/genui/README.md carries the
// provenance) rides BETWEEN the tokens and the authored sheet, so studio.css
// §9's canvas skin can override its literals at equal specificity by order.
const canvasCssTmp = join(cssTempDir, "genui-canvas.css");
writeFileSync(
  canvasCssTmp,
  readFileSync("src/genui-canvas.css", "utf8").replace(/\r\n?/g, "\n"),
  "utf8",
);
const normalizedCss = join(cssTempDir, "studio.css");
writeFileSync(normalizedCss, authoredCss, "utf8");

try {
  await build({
    entryPoints: [
      { entry: "src/start.ts", outfile: "start.js" },
      { entry: "src/workspace.ts", outfile: "workspace.js" },
      { entry: "src/nocturne.ts", outfile: "nocturne.js" },
      { entry: "src/status.ts", outfile: "status.js" },
      { entry: "src/map.ts", outfile: "map.js" },
      { entry: "src/check.ts", outfile: "check.js" },
      { entry: "src/pads.ts", outfile: "pads.js" },
      { entry: "src/devices.ts", outfile: "devices.js" },
      { entry: "src/profiles.ts", outfile: "profiles.js" },
      { entry: "src/setup.ts", outfile: "setup.js" },
    ],
    cssEntries: [{ input: [tokensCssTmp, canvasCssTmp, normalizedCss], outfile: "studio.css" }],
    routes: {
      "/start": { js: ["start"], css: ["studio"] },
      "/workspace": { js: ["workspace"], css: ["studio"] },
      "/nocturne": { js: ["nocturne"], css: ["studio"] },
      "/": { js: ["status"], css: ["studio"] },
      "/map": { js: ["map"], css: ["studio"] },
      "/check": { js: ["check"], css: ["studio"] },
      "/pads": { js: ["pads"], css: ["studio"] },
      "/devices": { js: ["devices"], css: ["studio"] },
      "/profiles": { js: ["profiles"], css: ["studio"] },
      "/setup": { js: ["setup"], css: ["studio"] },
    },
    outputDir,
    // The mapping-flow lens, contextual Inspector, Keyboard Arranger, physical
    // Control Surface Builder, complete 56-terminal encoder editor, portable
    // hardware-layout profiles, supervised backup/program/verify/restore,
    // blank-encoder entry, movable macro processors, multi-family discovery,
    // chart-derived panels, visible control → terminal → key handoffs, and the
    // fallback signal shelf live in Nocturne's one island. The measured
    // compressed route is 275,015 bytes (~268.6 KiB) after the cross-window
    // hardware journal and canonical learner identity; keep a narrow
    // 275,100-byte ceiling so those deliberate safety costs are not an
    // open-ended bump.
    budgetThreshold: 275_100,
    ssr: true,
    ssrEntryPoints: {
      start: "src/start.ts",
      workspace: "src/workspace.ts",
      nocturne: "src/nocturne.ts",
      status: "src/status.ts",
      map: "src/map.ts",
      check: "src/check.ts",
      pads: "src/pads.ts",
      devices: "src/devices.ts",
      profiles: "src/profiles.ts",
      setup: "src/setup.ts",
    },
  });
} finally {
  console.warn = realWarn;
  rmSync(cssTempDir, { recursive: true, force: true });
}
const collisions = compilerWarnings.filter((line) =>
  /is also declared in another scope on this page/.test(line),
);
if (collisions.length) {
  throw new Error(
    `${collisions.length} slot-name collision(s) — the renamed slot is the one ` +
      "the page RENDERS, so the seam's injection would fill a dead slot and the " +
      "page would show compile-time defaults. Declare the signal once (in the " +
      `*Island.ts file) and delete the twin:\n${collisions.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// EVERY OTHER COMPILER WARNING IS FATAL.
//
// The collision check above exists because one important warning was arriving
// "as one console.warn line among the thirteen benign ArrayExpression notes
// the ledger tells you not to chase". That is still the shape of the problem:
// a normal build prints ~20 of those notes, and nobody reads twenty lines of
// known-benign output, so warning number twenty-one arrives invisible.
//
// So the benign class is COUNTED, not printed, and anything unrecognised stops
// the build. Adding a genuinely new benign class is a deliberate edit here.
//
// Why the ArrayExpression note is benign FOR THIS CODEBASE: it fires for every
// signal initialised with `[]`, warning that bindings to it land in anonymous
// slots that render empty server-side. True of a bare `() => rows()` binding —
// and this codebase never writes one. Those signals are read only inside
// `createList`, which compiles to a NAMED `list:<signal>:array` slot that
// `render_*.rs` fills. Verified by fetching a page with the hydration JSON
// stripped: the rows are in the server-rendered markup.
// ---------------------------------------------------------------------------
const BENIGN = [
  /is initialized with a \w+ the compiler cannot evaluate/,
];
const benign = compilerWarnings.filter((line) => BENIGN.some((re) => re.test(line)));
const unknown = compilerWarnings.filter(
  (line) =>
    !BENIGN.some((re) => re.test(line)) &&
    !/is also declared in another scope on this page/.test(line),
);
if (unknown.length) {
  throw new Error(
    `${unknown.length} unrecognised compiler warning(s). Each one is either a ` +
      "real defect or a new benign class that belongs in BENIGN above — decide " +
      `which, deliberately:\n${unknown.join("\n")}`,
  );
}
if (benign.length) {
  console.log(
    `note: ${benign.length} benign 'cannot evaluate initializer' notes for list ` +
      "signals (they render through named list: slots; see build.mjs)",
  );
}

// The island BYPRODUCT scrub (`*.islands.js` / `*.islands.json`) lived here
// until 2026-08-06 — see docs/FORMA-DOGFOOD.md #12. Those files mapped each
// island to the page ROOT component (the exact clobber pattern ledger #5
// bans) and imported `../src/...` paths that do not resolve from the output
// dir, so they had to be deleted from the embed and the manifest, per entry.
// @getforma/build 0.2.0 stops emitting them; the scrub is gone with them.
const manifestPath = join(outputDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const logical of Object.keys(manifest.assets)) {
  if (/\.islands\./.test(logical)) {
    throw new Error(
      `'${logical}' is back in the manifest — the build is emitting island ` +
        "byproducts again (ledger #12); restore the scrub before shipping",
    );
  }
}

// Dogfood ledger #13(b) CLOSED at @getforma/core 2.0.0: the bundle patch that
// rewrote setupShowEffect to route branch creation through __ksxShowBranch is
// gone, and so is the helper the entries installed for it.
//
// Upstream now wraps each show branch in createRoot(...) + untrack(...) — the
// exact semantics the patch supplied — so re-toggled branches own their own
// bindings and survive the effect re-running. The anchored-replacement guard
// did its job on the way out: the first build against 2.0.0 failed with
// "matched 0x (expected exactly 1) — upstream changed", which is how a
// workaround is supposed to announce that its bug is fixed rather than
// silently reapplying itself to code that no longer needs it.
// ---------------------------------------------------------------------------
// Vendored controller art (Gamepad-Asset-Pack, MIT, by AL2009man — see
// art/README.md): the committed sources are print-style assets — a hidden
// reference raster (display:none <image>, ~18 KB of base64), a SOLID BLACK
// body silhouette (fill:#000000) and white control shapes (fill:#ffffff),
// authored for light backgrounds. On the studio's dark ground the black body
// reads as a shapeless blob, so the copy step is a real transform now:
//
//   1. drop the hidden rasters, display:none leftovers, path-effect defs and
//      editor metadata (geometry untouched; also a big byte diet);
//   2. reclass the two source colors — fill:#000000 → .pad-body,
//      fill:#ffffff → .pad-detail (the DS4 touchpad → .pad-inset so the big
//      slab stays subtler than the buttons). Inline fill/stroke declarations
//      are stripped so the injected sheet wins;
//   3. inject a <style> sheet mapping those classes to the studio palette
//      (tokens mirrored from studio.css) with a prefers-color-scheme:light
//      override — SVG-internal media queries apply inside <img>, so ONE
//      asset serves both themes;
//   4. add the few controls the icons never drew (Xbox guide/view/menu, DS4
//      share/options/PS) as small .pad-detail shapes at the exact spots the
//      hit-zone tables expect (stage % → art mm → +layer translate).
//
// render.rs serves the results at /_assets/pad-xbox.svg and
// /_assets/pad-ds4.svg; the status page's .tileart uses the same files.
// ---------------------------------------------------------------------------

// Palette sheet. An <img> SVG is its own document and inherits no custom
// properties from the page, so var() is impossible here — but the four values
// that ARE token mirrors (dark stroke = --text-3; light body/stroke/detail =
// --panel-2/--text-3/--text-2) are TEMPLATED from the token source rather
// than hand-copied, so they cannot drift. The remaining literals are bespoke
// art colors chosen against the silhouette (dark body/detail, both insets) —
// copies of nothing, deliberately not pinned. `contrast.rs` parses the
// EMITTED pad-xbox.svg (this sheet as shipped) for floors and the token pins.
// vector-effect keeps the silhouette outline ~1.5 px at any <img> size.
//
// Violet family as of the Street Fighter palette pass: the art used to be
// blue-steel (#1d2534/#8593ad), which read as a foreign hue sitting on a
// purple ground — the one place on the page where "the picture doesn't
// belong to the app" was visible. Separations are held at the outgoing
// art's values (detail/body 9.08 vs 9.44, body/page 1.20 vs 1.27).
const PAD_SHEET =
  "<style>" +
  `.pad-body{fill:#261c3b;stroke:${tokens.resolveHex("dark", "--text-3")};stroke-width:1.5;stroke-linejoin:round;vector-effect:non-scaling-stroke}` +
  ".pad-detail{fill:#c9bfd6}" +
  ".pad-inset{fill:#37294e}" +
  "@media (prefers-color-scheme:light){" +
  `.pad-body{fill:${tokens.resolveHex("light", "--panel-2")};stroke:${tokens.resolveHex("light", "--text-3")}}` +
  `.pad-detail{fill:${tokens.resolveHex("light", "--text-2")}}` +
  ".pad-inset{fill:#dcd2c8}" +
  "}</style>";

// Inline declarations that would defeat the injected sheet on reclassed
// elements. Keeps fill-rule/display/opacity.
const DROP_DECL =
  /^(?:fill|fill-opacity|stroke|stroke-width|stroke-miterlimit|stroke-linecap|stroke-linejoin|color|-inkscape-stroke|paint-order)$/;

function reclassElement(el) {
  const styleAttr = /style="([^"]*)"/.exec(el);
  if (!styleAttr) return el;
  let cls = null;
  if (styleAttr[1].includes("fill:#000000")) cls = "pad-body";
  else if (styleAttr[1].includes("fill:#ffffff"))
    cls = /id="rect1268"/.test(el) ? "pad-inset" : "pad-detail";
  if (!cls) return el;
  const kept = styleAttr[1]
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !DROP_DECL.test(d.split(":")[0].trim()));
  const replacement =
    `class="${cls}"` + (kept.length ? ` style="${kept.join(";")}"` : "");
  return el.replace(styleAttr[0], replacement);
}

function cleanSvg(source, extraShapes) {
  return (
    readFileSync(join("art", source), "utf8")
      // FIRST, before anything that reasons about newlines: the art sources
      // are text files, so a checkout under core.autocrlf hands this function
      // CRLF and the `\n{3,}` collapse below stops matching — the vendored
      // svg then differs byte-for-byte between two checkouts of the same
      // commit, which is exactly the "committed assets match a fresh build"
      // check failing for no source change at all.
      .replace(/\r\n?/g, "\n")
      .replace(/<sodipodi:namedview[\s\S]*?\/>/g, "")
      .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
      // The hidden trace rasters and any other display:none leftovers.
      .replace(/<image\b[^>]*>/g, "")
      .replace(/<(?:path|circle|rect)\b[^>]*display:none[^>]*>/g, "")
      .replace(/<inkscape:path-effect[\s\S]*?\/>/g, "")
      .replace(/\s+(?:inkscape|sodipodi):[\w-]+="[^"]*"/g, "")
      .replace(/\s+xmlns:(?:inkscape|sodipodi|xlink)="[^"]*"/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      // Theme reclass + the palette sheet.
      .replace(/<(?:path|circle|rect|g)\b[^>]*>/g, reclassElement)
      .replace(/(<svg\b[^>]*>)/, `$1\n  ${PAD_SHEET}`)
      // Undrawn controls, injected inside the layer group.
      .replace(/<\/g>\s*<\/svg>/, `${extraShapes}</g></svg>`)
      .replace(/\n{3,}/g, "\n\n")
  );
}

// Xbox: guide (stage 50,27), view (44,39), menu (56,39) → art mm + layer
// translate (82.634594,166.69041). DS4: share (30,25.5), options (70,25.5),
// PS (50,63) → + (26.849948,130.35184). Stage→art: x% of viewBox width,
// (y−14)/0.86 % of viewBox height (ART_SHARE mapping in render_map.rs).
const XBOX_EXTRA =
  '<circle class="pad-detail" cx="138.86" cy="178.28" r="4.1"/>' +
  '<circle class="pad-detail" cx="132.11" cy="188.98" r="1.9"/>' +
  '<circle class="pad-detail" cx="145.61" cy="188.98" r="1.9"/>';
const DS4_EXTRA =
  '<rect class="pad-detail" x="59.56" y="137.55" width="2.2" height="5.0" rx="1.1"/>' +
  '<rect class="pad-detail" x="104.63" y="137.55" width="2.2" height="5.0" rx="1.1"/>' +
  '<circle class="pad-detail" cx="83.19" cy="171.68" r="2.9"/>';

const ART = [
  ["src-xboxseries.svg", "pad-xbox.svg", XBOX_EXTRA],
  ["src-ds4.svg", "pad-ds4.svg", DS4_EXTRA],
];
for (const [source, out, extra] of ART) {
  writeFileSync(join(outputDir, out), cleanSvg(source, extra));
}

// The theme roster (id/label/scheme + resolved --bg/--text anchors), for the
// browser suite's painted-theme assertions. Unhashed like the pad SVGs;
// CI-pinned by the same assets byte-diff.
writeFileSync(join(outputDir, "themes.json"), tokens.themesJson);

// ---------------------------------------------------------------------------
// FMIR version guard (docs/research/forma-spike-1-fmir-compat.md "cheap
// insurance"): forma-server 0.2.0 renders FMIR v2 only. Refuse to emit
// anything a compiler bump silently made incompatible — for EVERY route.
// ---------------------------------------------------------------------------
// Every route in the manifest, not a hand-kept list: a page whose IR is
// unverified is a page that fails at `EmbeddedPage::load` and takes the WHOLE
// server down with it (serve() loads all routes eagerly, so one bad .ir means
// Studio never binds) — and `routes` above is already the single declaration
// of what exists, so a new page cannot forget to add itself here.
for (const route of Object.keys(manifest.routes)) {
  const irName = manifest.routes[route].ir;
  if (!irName) throw new Error(`manifest route '${route}' lost its .ir entry`);
  const ir = readFileSync(join(outputDir, irName));
  const magic = ir.subarray(0, 4).toString("latin1");
  const version = ir.readUInt16LE(4);
  if (magic !== "FMIR" || version !== 2) {
    throw new Error(
      `IR guard failed: ${irName} is ${magic} v${version}, expected FMIR v2 ` +
        "(forma-server 0.2.0 contract)",
    );
  }
  if (!manifest.routes[route].js?.length) {
    throw new Error(
      `manifest route '${route}' has no client js — the island runtime cannot load`,
    );
  }
  console.log(`OK: ${route} → ${irName} is FMIR v2; island client bundle kept`);
}
console.log("OK: controller art vendored (pad-xbox.svg, pad-ds4.svg)");
