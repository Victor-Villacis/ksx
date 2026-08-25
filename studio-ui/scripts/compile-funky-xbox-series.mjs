import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, "../src/xboxSeriesPremiumGeometry.ts");
const VIEWBOX = "0 0 3800 2647";
const VARIANTS = [
  { slug: "black", label: "Carbon black", swatch: "#232323" },
  { slug: "white", label: "Robot white", swatch: "#d7d7d7" },
  { slug: "blue", label: "Shock blue", swatch: "#1c448a" },
  { slug: "red", label: "Pulse red", swatch: "#e71717" },
  { slug: "green", label: "Electric volt", swatch: "#c1db31" },
];
const EXPECTED_HASHES = [
  "15229EA57B7059D3EDDABA5C223E080799E322172688F928759D133D3F36F0A1",
  "20CF3E05F273CA70D2B081FE49BD7A0EB5B44EBAAFFC3D73D7AFCD41258DC487",
  "0241274A159DE2B8B10E0E816AF95FAB366C077A7A749D113F910BA5428EDC0E",
  "226B5CDE638C72AE4FC3745E530D84A55AEEF0FAA836D97D4BCAD72618CD247A",
  "39A9BD501B696E886CEAFEDFC968F94ED7DE69E42813C7D6C5F70B318AA4C82A",
];
const BASE_GROUP_COUNTS = {
  root: 9,
  "left-stick": 8,
  "right-stick": 8,
  dpad: 10,
  x: 8,
  b: 7,
  a: 7,
  y: 8,
  view: 5,
  share: 5,
  menu: 5,
};
const COLOR_GROUP_COUNTS = {
  ...BASE_GROUP_COUNTS,
  root: 13,
  "left-stick": 9,
  "right-stick": 9,
};
const COLOR_STICK_ROLES = [2, 0, 1, 4, 5, 6, 7, 8];
const GUIDE = { cx: "1900", cy: "461.432", r: "121" };
const LEFT_BUMPER =
  "M581,327c128,-103 349,-173 743,-215c-4,25 -16,49 -34,72c-313,36 -535,99 -679,185c-13,-12 -23,-26 -30,-42Z";
const RIGHT_BUMPER =
  "M3219,327c-128,-103 -349,-173 -743,-215c4,25 16,49 34,72c313,36 535,99 679,185c13,-12 23,-26 30,-42Z";

if (process.argv.length !== 7) {
  throw new Error(
    "usage: node scripts/compile-funky-xbox-series.mjs BLACK.svg WHITE.svg BLUE.svg RED.svg GREEN.svg",
  );
}

function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([:\w-]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function styleMap(style = "") {
  return Object.fromEntries(
    style.split(";").filter(Boolean).map((part) => {
      const cut = part.indexOf(":");
      return [part.slice(0, cut), part.slice(cut + 1)];
    }),
  );
}

function normalizeGroup(id) {
  const normalized = id.toLowerCase().replaceAll("_", "-");
  if (normalized.startsWith("xb-seriesx-")) return "root";
  return {
    "left-stick": "left-stick",
    "right-stick": "right-stick",
    dpad: "dpad",
    x: "x",
    b: "b",
    a: "a",
    y: "y",
    "view-button": "view",
    "share-button": "share",
    "menu-button": "menu",
  }[normalized] ?? normalized;
}

function parseSvg(text) {
  const svgAttrs = attributes(text.match(/<svg\b([^>]*)>/)?.[1] ?? "");
  const stack = [];
  const shapes = [];
  const groups = new Map();
  const token = /<\/g\s*>|<g\b([^>]*)>|<(path|circle|rect)\b([^>]*)\/>/g;

  for (const match of text.matchAll(token)) {
    if (match[0].startsWith("</g")) {
      if (stack.pop() === undefined) throw new Error("source contains an unmatched </g>");
      continue;
    }
    if (match[0].startsWith("<g")) {
      const id = attributes(match[1]).id;
      if (!id) throw new Error("source contains an unnamed geometry group");
      stack.push(normalizeGroup(id));
      continue;
    }

    const group = stack.at(-1);
    if (!group) throw new Error("source contains geometry outside its controller group");
    const attrs = attributes(match[3]);
    const grouped = groups.get(group) ?? [];
    const shape = { tag: match[2], attrs, group, ordinal: grouped.length, index: shapes.length };
    grouped.push(shape);
    groups.set(group, grouped);
    shapes.push(shape);
  }

  if (stack.length !== 0) throw new Error("source contains an unclosed <g>");
  const visibleShapeCount = [...text.matchAll(/<(path|circle|rect|ellipse|polygon|polyline|line)\b[^>]*\/>/g)].length;
  if (visibleShapeCount !== shapes.length) {
    throw new Error(`source contains an unsupported vector primitive (${visibleShapeCount} != ${shapes.length})`);
  }
  return { viewBox: svgAttrs.viewBox, shapes, groups };
}

function validateGroups(source, expected, label) {
  const names = [...source.groups.keys()].sort();
  const expectedNames = Object.keys(expected).sort();
  if (names.join("|") !== expectedNames.join("|")) {
    throw new Error(`${label} group vocabulary drifted: ${names.join(", ")}`);
  }
  for (const [group, count] of Object.entries(expected)) {
    const actual = source.groups.get(group)?.length ?? 0;
    if (actual !== count) {
      throw new Error(`${label} ${group} shape count drifted: expected ${count}, got ${actual}`);
    }
  }
}

function validatePaletteDots(source, label) {
  const dots = source.groups.get("root").slice(9).map((shape) => {
    if (shape.tag !== "circle") throw new Error(`${label} palette artifact is no longer a circle`);
    return `${shape.attrs.cx},${shape.attrs.cy},${shape.attrs.r}`;
  }).sort();
  const expected = [
    "2829.69,719.303,15.137",
    "2881.74,667.25,15.137",
    "2881.74,771.357,15.137",
    "2933.79,719.303,15.137",
  ].sort();
  if (dots.join("|") !== expected.join("|")) {
    throw new Error(`${label} embedded palette artifacts drifted: ${dots.join("; ")}`);
  }
}

function sourceRole(source, canonicalShape, variantIndex) {
  let ordinal = canonicalShape.ordinal;
  if (
    variantIndex >= 2 &&
    (canonicalShape.group === "left-stick" || canonicalShape.group === "right-stick")
  ) {
    ordinal = COLOR_STICK_ROLES[ordinal];
  }
  const shape = source.groups.get(canonicalShape.group)?.[ordinal];
  if (!shape) {
    throw new Error(
      `${VARIANTS[variantIndex].label} lacks ${canonicalShape.group}[${canonicalShape.ordinal}] paint role`,
    );
  }
  if (shape.tag !== canonicalShape.tag) {
    throw new Error(
      `${VARIANTS[variantIndex].label} changed ${canonicalShape.group}[${canonicalShape.ordinal}] from ${canonicalShape.tag} to ${shape.tag}`,
    );
  }
  return shape;
}

function fillOf(shape) {
  return (styleMap(shape.attrs.style).fill ?? shape.attrs.fill ?? "#000000").toLowerCase();
}

function q(value) {
  return JSON.stringify(value);
}

function renderProps(props) {
  return Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
}

function geometryAttrs(shape) {
  return Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style" && name !== "fill"
    ),
  );
}

function semanticClasses(shape) {
  const { group, ordinal } = shape;
  if (group === "root") {
    return [
      "xboxseriespremium-trigger xboxseriespremium-trigger-left",
      "xboxseriespremium-trigger xboxseriespremium-trigger-right",
      "xboxseriespremium-shell",
      "xboxseriespremium-shell-lower",
      "xboxseriespremium-lower-seam-shadow",
      "xboxseriespremium-lower-seam",
      "xboxseriespremium-top-seam",
      "xboxseriespremium-stick-cast-shadow xboxseriespremium-stick-cast-shadow-left",
      "xboxseriespremium-stick-cast-shadow xboxseriespremium-stick-cast-shadow-right",
    ][ordinal] ?? "";
  }
  if (group === "left-stick" || group === "right-stick") {
    const side = group === "left-stick" ? "left" : "right";
    const layer = ["well", "rim-outer", "rim-inner", "cap", "face", "shade", "sheen", "texture"][ordinal];
    return `xboxseriespremium-stick-${layer} xboxseriespremium-stick-${layer}-${side}`;
  }
  if (group === "dpad") {
    return [
      "xboxseriespremium-dpad-deck",
      "xboxseriespremium-dpad-shadow",
      "xboxseriespremium-dpad-well",
      "xboxseriespremium-dpad-well-sheen",
      "xboxseriespremium-dpad-cross-shadow",
      "xboxseriespremium-dpad-cross-cap",
      "xboxseriespremium-dpad-segment xboxseriespremium-dpad-segment-left",
      "xboxseriespremium-dpad-segment xboxseriespremium-dpad-segment-up",
      "xboxseriespremium-dpad-segment xboxseriespremium-dpad-segment-right",
      "xboxseriespremium-dpad-segment xboxseriespremium-dpad-segment-down",
    ][ordinal] ?? "";
  }
  if (["x", "b", "a", "y"].includes(group)) {
    const layer = ["shadow", "rim", "cap", "shade", "glyph", "sheen", "glyph-sheen", "glyph-sheen"][ordinal];
    return `xboxseriespremium-face-${layer} xboxseriespremium-face-${layer}-${group}`;
  }
  if (["view", "share", "menu"].includes(group)) {
    const layer = ["shadow", "rim", "cap", "sheen", "glyph"][ordinal];
    return `xboxseriespremium-utility-${layer} xboxseriespremium-${group}-${layer}`;
  }
  return "";
}

function role(source, group, ordinal) {
  const shape = source.groups.get(group)?.[ordinal];
  if (!shape) throw new Error(`canonical source lacks ${group}[${ordinal}]`);
  return shape;
}

function hookProps(shape, fn) {
  return {
    "data-fn": fn,
    class: "xboxseriespremium-hook",
    ...geometryAttrs(shape),
    fill: "transparent",
    "vector-effect": "non-scaling-stroke",
  };
}

const sourcePaths = process.argv.slice(2).map((path) => resolve(path));
const sourceTexts = await Promise.all(sourcePaths.map((path) => readFile(path, "utf8")));
const hashes = sourceTexts.map((text) =>
  createHash("sha256").update(Buffer.from(text)).digest("hex").toUpperCase()
);
for (let index = 0; index < hashes.length; index += 1) {
  if (hashes[index] !== EXPECTED_HASHES[index]) {
    throw new Error(
      `${VARIANTS[index].label} source hash drifted: expected ${EXPECTED_HASHES[index]}, got ${hashes[index]}`,
    );
  }
}

const sources = sourceTexts.map(parseSvg);
for (let index = 0; index < sources.length; index += 1) {
  const source = sources[index];
  if (source.viewBox !== VIEWBOX) {
    throw new Error(`${VARIANTS[index].label} viewBox drifted: expected ${VIEWBOX}, got ${source.viewBox}`);
  }
  const colored = index >= 2;
  validateGroups(source, colored ? COLOR_GROUP_COUNTS : BASE_GROUP_COUNTS, VARIANTS[index].label);
  if (colored) validatePaletteDots(source, VARIANTS[index].label);
}

const canonical = sources[0];
if (canonical.shapes.length !== 80) {
  throw new Error(`Carbon black source shape count drifted: expected 80, got ${canonical.shapes.length}`);
}

const tones = new Map();
const shapeTone = [];
const shapeFills = [];
for (const shape of canonical.shapes) {
  const fills = sources.map((source, variantIndex) => fillOf(sourceRole(source, shape, variantIndex)));
  shapeFills.push(fills[0]);
  if (fills.every((fill) => fill === fills[0])) {
    shapeTone.push(null);
    continue;
  }
  const key = fills.join("|");
  if (!tones.has(key)) tones.set(key, { index: tones.size, fills });
  shapeTone.push(tones.get(key).index);
}

const shell = role(canonical, "root", 2);
const shellTone = shapeTone[shell.index];
if (shellTone === null) throw new Error("shell palette was not detected");
const toneList = [...tones.values()];
const shellPaint = `var(--xboxsp-tone-${shellTone}, ${fillOf(shell)})`;

const lines = [
  "import { h } from \"@getforma/core\";",
  "",
  "// GENERATED by scripts/compile-funky-xbox-series.mjs from the five Funky Designs",
  "// CC0 small SVG finishes. Canonical geometry is Carbon Black; colored-source",
  "// palette dots and alternate stick construction are intentionally not cloned.",
  "// Do not hand-edit geometry; see THIRD-PARTY-LICENSES/Funky-Designs-CC0-1.0-Dedication.pdf.",
  ...hashes.map((hash, index) => `// ${VARIANTS[index].slug}: ${hash}`),
  "",
  `export const XBOX_SERIES_PREMIUM_VIEWBOX = ${q(VIEWBOX)};`,
  "export const XBOX_SERIES_PREMIUM_VARIANTS = [",
];

for (let variant = 0; variant < VARIANTS.length; variant += 1) {
  const item = VARIANTS[variant];
  lines.push("  {");
  lines.push(`    slug: ${q(item.slug)},`);
  lines.push(`    label: ${q(item.label)},`);
  lines.push(`    swatch: ${q(item.swatch)},`);
  lines.push(`    gradient: ${q(`nxg-xboxseries-${item.slug}`)},`);
  lines.push("    tones: {");
  for (const tone of toneList) {
    lines.push(`      ${q(`--xboxsp-tone-${tone.index}`)}: ${q(tone.fills[variant])},`);
  }
  lines.push("    },");
  lines.push("  },");
}
lines.push("] as const;");
lines.push("");
lines.push("export type XboxSeriesPremiumVariantSlug = (typeof XBOX_SERIES_PREMIUM_VARIANTS)[number][\"slug\"];");
lines.push(`export const XBOX_SERIES_PREMIUM_SHELL_TONE = ${q(`--xboxsp-tone-${shellTone}`)};`);
lines.push("");
lines.push("export function XboxSeriesPremiumGeometry() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"xboxseriespremium-source\", \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\", \"stroke-miterlimit\": \"2\" },");

for (const shape of canonical.shapes) {
  const classes = ["xboxseriespremium-shape", semanticClasses(shape)].filter(Boolean).join(" ");
  const tone = shapeTone[shape.index];
  const fill = tone === null ? shapeFills[shape.index] : `var(--xboxsp-tone-${tone}, ${shapeFills[shape.index]})`;
  const props = {
    class: classes,
    "data-xbox-series-source-index": String(shape.index),
    "data-xbox-series-source-group": shape.group,
    ...geometryAttrs(shape),
    fill,
  };
  lines.push(`    h(${q(shape.tag)}, { ${renderProps(props)} }),`);
  if (shape.group === "root" && shape.ordinal === BASE_GROUP_COUNTS.root - 1) {
    // Shoulder bumpers belong above the shell but below every face control.
    lines.push(`    h("path", { class: "xboxseriespremium-owned xboxseriespremium-bumper xboxseriespremium-bumper-left", d: ${q(LEFT_BUMPER)}, fill: ${q(shellPaint)} }),`);
    lines.push(`    h("path", { class: "xboxseriespremium-owned xboxseriespremium-bumper xboxseriespremium-bumper-right", d: ${q(RIGHT_BUMPER)}, fill: ${q(shellPaint)} }),`);
  }
}

lines.push(`    h("circle", { class: "xboxseriespremium-owned xboxseriespremium-guide-shadow", cx: ${q(GUIDE.cx)}, cy: ${q(GUIDE.cy)}, r: ${q(GUIDE.r)}, fill: "#0d0d0e" }),`);
lines.push(`    h("circle", { class: "xboxseriespremium-owned xboxseriespremium-guide-rim", cx: ${q(GUIDE.cx)}, cy: ${q(GUIDE.cy)}, r: "108", fill: "#343438" }),`);
lines.push(`    h("circle", { class: "xboxseriespremium-owned xboxseriespremium-guide-cap", cx: ${q(GUIDE.cx)}, cy: ${q(GUIDE.cy)}, r: "94", fill: "#1a1a1d" }),`);
lines.push("    h(\"path\", { class: \"xboxseriespremium-owned xboxseriespremium-guide-glyph\", d: \"M1845,417c22,3 40,12 55,27c15,-15 33,-24 55,-27c-19,13 -36,30 -50,51c19,13 38,31 55,54c-22,-19 -42,-31 -60,-38c-18,7 -38,19 -60,38c17,-23 36,-41 55,-54c-14,-21 -31,-38 -50,-51Z\", fill: \"#e7e7ea\" }),");
lines.push("    h(\"path\", { class: \"xboxseriespremium-owned xboxseriespremium-guide-sheen\", d: \"M1838,455c15,-42 87,-64 124,0c-21,-17 -42,-25 -62,-25c-20,0 -41,8 -62,25Z\", fill: \"#ffffff\", opacity: \"0.16\" }),");
lines.push("  );");
lines.push("}");
lines.push("");

const depthShapes = [
  { name: "left-trigger-contact", shape: role(canonical, "root", 0), transform: "translate(0 14)", kind: "contact trigger" },
  { name: "right-trigger-contact", shape: role(canonical, "root", 1), transform: "translate(0 14)", kind: "contact trigger" },
  { name: "left-stick-contact", shape: role(canonical, "left-stick", 0), transform: "translate(0 20)", kind: "contact stick" },
  { name: "right-stick-contact", shape: role(canonical, "right-stick", 0), transform: "translate(0 20)", kind: "contact stick" },
  { name: "dpad-ambient", shape: role(canonical, "dpad", 0), transform: "translate(0 27)", kind: "ambient dpad" },
  ...[
    ["left", 6], ["up", 7], ["right", 8], ["down", 9],
  ].flatMap(([direction, ordinal]) => [
    { name: `dpad-${direction}-ambient`, shape: role(canonical, "dpad", ordinal), transform: "translate(0 20)", kind: "ambient dpad" },
    { name: `dpad-${direction}-contact`, shape: role(canonical, "dpad", ordinal), transform: "translate(0 9)", kind: "contact dpad" },
  ]),
  ...["x", "b", "a", "y"].map((button) => ({
    name: `${button}-contact`,
    shape: role(canonical, button, 0),
    transform: "translate(0 16)",
    kind: "contact face",
  })),
  ...["view", "share", "menu"].map((button) => ({
    name: `${button}-contact`,
    shape: role(canonical, button, 0),
    transform: "translate(0 11)",
    kind: "contact utility",
  })),
];

lines.push("export function XboxSeriesPremiumDepth() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"xboxseriespremium-depth\", \"aria-hidden\": \"true\", \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\" },");
for (const item of depthShapes) {
  const props = {
    class: `xboxseriespremium-depth-shadow ${item.kind.split(" ").map((kind) => `xboxseriespremium-depth-${kind}`).join(" ")}`,
    "data-xbox-series-depth": item.name,
    ...geometryAttrs(item.shape),
    transform: item.transform,
  };
  lines.push(`    h(${q(item.shape.tag)}, { ${renderProps(props)} }),`);
}
lines.push(`    h("path", { class: "xboxseriespremium-depth-shadow xboxseriespremium-depth-contact xboxseriespremium-depth-bumper", "data-xbox-series-depth": "left-bumper-contact", d: ${q(LEFT_BUMPER)}, transform: "translate(0 12)" }),`);
lines.push(`    h("path", { class: "xboxseriespremium-depth-shadow xboxseriespremium-depth-contact xboxseriespremium-depth-bumper", "data-xbox-series-depth": "right-bumper-contact", d: ${q(RIGHT_BUMPER)}, transform: "translate(0 12)" }),`);
lines.push(`    h("circle", { class: "xboxseriespremium-depth-shadow xboxseriespremium-depth-contact xboxseriespremium-depth-guide", "data-xbox-series-depth": "guide-contact", cx: ${q(GUIDE.cx)}, cy: ${q(GUIDE.cy)}, r: ${q(GUIDE.r)}, transform: "translate(0 12)" }),`);
lines.push("  );");
lines.push("}");
lines.push("");

const pathHooks = [
  ["lt", role(canonical, "root", 0)],
  ["rt", role(canonical, "root", 1)],
  ["back", role(canonical, "view", 0)],
  ["start", role(canonical, "menu", 0)],
  ["dpad.left", role(canonical, "dpad", 6)],
  ["dpad.up", role(canonical, "dpad", 7)],
  ["dpad.right", role(canonical, "dpad", 8)],
  ["dpad.down", role(canonical, "dpad", 9)],
];
const ownedPathHooks = [["lb", LEFT_BUMPER], ["rb", RIGHT_BUMPER]];
const circleHooks = [
  ["x", "2623.89", "719.332", "139.909"],
  ["b", "3138.59", "719.332", "139.909"],
  ["a", "2881.74", "977.132", "139.909"],
  ["y", "2881.74", "461.432", "139.909"],
  ["guide", GUIDE.cx, GUIDE.cy, GUIDE.r],
  ["lthumb", "920.745", "730.627", "138.766"],
  ["ly.max", "920.745", "565.927", "82"],
  ["ly.min", "920.745", "895.327", "82"],
  ["lx.min", "756.045", "730.627", "82"],
  ["lx.max", "1085.445", "730.627", "82"],
  ["rthumb", "2408.14", "1300.63", "138.766"],
  ["ry.max", "2408.14", "1135.93", "82"],
  ["ry.min", "2408.14", "1465.33", "82"],
  ["rx.min", "2243.44", "1300.63", "82"],
  ["rx.max", "2572.84", "1300.63", "82"],
];
if (pathHooks.length + ownedPathHooks.length + circleHooks.length !== 25) {
  throw new Error("Xbox Series mapper hook vocabulary must contain exactly 25 controls");
}

lines.push("export function XboxSeriesPremiumButtonHooks() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"xboxseriespremium-hooks\" },");
for (const [fn, shape] of pathHooks) {
  lines.push(`    h(${q(shape.tag)}, { ${renderProps(hookProps(shape, fn))} }),`);
}
for (const [fn, d] of ownedPathHooks) {
  lines.push(`    h("path", { "data-fn": ${q(fn)}, class: "xboxseriespremium-hook", d: ${q(d)}, fill: "transparent", "vector-effect": "non-scaling-stroke" }),`);
}
for (const [fn, cx, cy, r] of circleHooks) {
  lines.push(`    h("circle", { "data-fn": ${q(fn)}, class: "xboxseriespremium-hook", cx: ${q(cx)}, cy: ${q(cy)}, r: ${q(r)}, fill: "transparent", "vector-effect": "non-scaling-stroke" }),`);
}
lines.push("  );");
lines.push("}");
lines.push("");

await writeFile(OUTPUT, lines.join("\n"), "utf8");
console.log(
  `wrote ${OUTPUT} (${canonical.shapes.length + 7} visible shapes, ${depthShapes.length + 3} depth shapes, ${toneList.length} color tones, 25 hooks)`,
);
