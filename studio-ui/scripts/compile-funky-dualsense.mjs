import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, "../src/dualSensePremiumGeometry.ts");
const EXPECTED_HASH = "1A295010C4318D1EE64A735E2F285F75E47A4D64F8727AA1C0708A06BADF10BA";
const SOURCE_VIEWBOX = "0 0 3801 2521";
const PAID_TRANSFORM = "matrix(0.2421052632 0 0 0.2421052632 80 234)";

// One licensed drawing supplies the geometry. These are app-owned material
// palettes informed by the real controller's color families; no product
// photograph or pixels from one are embedded in the generated module.
const VARIANTS = [
  {
    slug: "white",
    label: "White",
    swatch: "#d9dde6",
    tones: {
      shell: "#d9dde6", shellEdge: "#d3d8e2", shellHighlight: "#dde1ea",
      core: "#1e222b", shoulder: "#181820", shoulderHighlight: "#2b2b3a",
      touchBed: "#394356", touchEdge: "#a6afc4", light: "#025df7",
      controlShadow: "#82878d", faceShadow: "#000000", controlRim: "#c8cbda", controlCap: "#dbdfe8",
      dpadGlyph: "#81878d", faceGlyph: "#a2a7ab", utilityGlyph: "#848e97",
      micGlyph: "#3c4f60",
    },
  },
  {
    slug: "midnight-black",
    label: "Midnight black",
    swatch: "#252733",
    tones: {
      shell: "#252733", shellEdge: "#171923", shellHighlight: "#353846",
      core: "#10121a", shoulder: "#090a0f", shoulderHighlight: "#20232e",
      touchBed: "#171b26", touchEdge: "#454a5b", light: "#3d8cff",
      controlShadow: "#11131a", faceShadow: "#08090d", controlRim: "#2c2f3b", controlCap: "#383c4a",
      dpadGlyph: "#8e94a6", faceGlyph: "#aab0c0", utilityGlyph: "#8e94a6",
      micGlyph: "#5b6680",
    },
  },
  {
    slug: "cosmic-red",
    label: "Cosmic red",
    swatch: "#b72446",
    tones: {
      shell: "#b72446", shellEdge: "#83172f", shellHighlight: "#d13a59",
      core: "#1b1d26", shoulder: "#111219", shoulderHighlight: "#30313d",
      touchBed: "#272936", touchEdge: "#dd627c", light: "#4993ff",
      controlShadow: "#341922", faceShadow: "#171018", controlRim: "#90213d", controlCap: "#bc3150",
      dpadGlyph: "#eba4b4", faceGlyph: "#f0aebe", utilityGlyph: "#d78297",
      micGlyph: "#765162",
    },
  },
  {
    slug: "nova-pink",
    label: "Nova pink",
    swatch: "#e86f99",
    tones: {
      shell: "#e86f99", shellEdge: "#bf4d77", shellHighlight: "#f28bad",
      core: "#20212b", shoulder: "#15161d", shoulderHighlight: "#363743",
      touchBed: "#2c2e3a", touchEdge: "#f2a4bd", light: "#5aa1ff",
      controlShadow: "#6b3549", faceShadow: "#1c161d", controlRim: "#d5668e", controlCap: "#ef88aa",
      dpadGlyph: "#f8c2d3", faceGlyph: "#fbd0dd", utilityGlyph: "#efb1c6",
      micGlyph: "#8c6173",
    },
  },
  {
    slug: "starlight-blue",
    label: "Starlight blue",
    swatch: "#4b9fd0",
    tones: {
      shell: "#4b9fd0", shellEdge: "#2879a8", shellHighlight: "#69b8df",
      core: "#1b202a", shoulder: "#11151c", shoulderHighlight: "#303743",
      touchBed: "#26313d", touchEdge: "#8acbe8", light: "#3b8dff",
      controlShadow: "#234b62", faceShadow: "#101820", controlRim: "#438eb9", controlCap: "#66afd4",
      dpadGlyph: "#b6dcec", faceGlyph: "#c7e5f1", utilityGlyph: "#9bcadd",
      micGlyph: "#526f80",
    },
  },
  {
    slug: "galactic-purple",
    label: "Galactic purple",
    swatch: "#7049a7",
    tones: {
      shell: "#7049a7", shellEdge: "#4b2d78", shellHighlight: "#8a63bc",
      core: "#1d1c28", shoulder: "#121119", shoulderHighlight: "#343042",
      touchBed: "#2b2938", touchEdge: "#a987cf", light: "#538fff",
      controlShadow: "#35264c", faceShadow: "#15101b", controlRim: "#664395", controlCap: "#835cae",
      dpadGlyph: "#cbb5df", faceGlyph: "#dbc9e9", utilityGlyph: "#b9a2cf",
      micGlyph: "#69597e",
    },
  },
];

if (process.argv.length !== 3) {
  throw new Error("usage: node scripts/compile-funky-dualsense.mjs PS5_controller_small.svg");
}

function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([:\w-]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function parseSvg(text) {
  const shapes = [];
  for (const match of text.matchAll(/<(path|circle|ellipse)\b([^>]*)\/>/g)) {
    shapes.push({ tag: match[1], attrs: attributes(match[2]) });
  }
  return shapes;
}

function styleMap(style = "") {
  return Object.fromEntries(
    style.split(";").filter(Boolean).map((part) => {
      const cut = part.indexOf(":");
      return [part.slice(0, cut), part.slice(cut + 1)];
    }),
  );
}

function q(value) {
  return JSON.stringify(value);
}

const semanticClassByIndex = new Map([
  [0, "dualsensepremium-under-panel dualsensepremium-under-panel-left"],
  [1, "dualsensepremium-under-panel dualsensepremium-under-panel-right"],
  [2, "dualsensepremium-corner-plane dualsensepremium-corner-plane-left"],
  [3, "dualsensepremium-corner-plane dualsensepremium-corner-plane-right"],
  [4, "dualsensepremium-core"],
  [5, "dualsensepremium-trigger dualsensepremium-trigger-left"],
  [6, "dualsensepremium-trigger-sheen dualsensepremium-trigger-sheen-left"],
  [7, "dualsensepremium-trigger dualsensepremium-trigger-right"],
  [8, "dualsensepremium-trigger-sheen dualsensepremium-trigger-sheen-right"],
  [9, "dualsensepremium-shell dualsensepremium-shell-left"],
  [10, "dualsensepremium-shell dualsensepremium-shell-right"],
  [11, "dualsensepremium-touch-bed"],
  ...Array.from({ length: 13 }, (_, offset) => [12 + offset, `dualsensepremium-status-glow dualsensepremium-status-glow-${offset}`]),
  [25, "dualsensepremium-lightbar"],
  [26, "dualsensepremium-touch-edge dualsensepremium-touch-edge-left"],
  [27, "dualsensepremium-touch-edge dualsensepremium-touch-edge-right"],
  [28, "dualsensepremium-touchpad"],
  [29, "dualsensepremium-stick-deck dualsensepremium-stick-deck-left"],
  [30, "dualsensepremium-stick-well dualsensepremium-stick-well-left"],
  [31, "dualsensepremium-stick-border dualsensepremium-stick-border-left"],
  [32, "dualsensepremium-stick-lip dualsensepremium-stick-lip-left"],
  [33, "dualsensepremium-stick-rim dualsensepremium-stick-rim-left"],
  [34, "dualsensepremium-stick-ring dualsensepremium-stick-ring-left"],
  [35, "dualsensepremium-stick-cap dualsensepremium-stick-cap-left"],
  [36, "dualsensepremium-stick-face dualsensepremium-stick-face-left"],
  [37, "dualsensepremium-stick-deck dualsensepremium-stick-deck-right"],
  [38, "dualsensepremium-stick-well dualsensepremium-stick-well-right"],
  [39, "dualsensepremium-stick-border dualsensepremium-stick-border-right"],
  [40, "dualsensepremium-stick-lip dualsensepremium-stick-lip-right"],
  [41, "dualsensepremium-stick-rim dualsensepremium-stick-rim-right"],
  [42, "dualsensepremium-stick-ring dualsensepremium-stick-ring-right"],
  [43, "dualsensepremium-stick-cap dualsensepremium-stick-cap-right"],
  [44, "dualsensepremium-stick-face dualsensepremium-stick-face-right"],
  [45, "dualsensepremium-guide-shadow"],
  [46, "dualsensepremium-guide-cap"],
  [47, "dualsensepremium-guide-rim"],
  [48, "dualsensepremium-mute"],
  [49, "dualsensepremium-utility-cap dualsensepremium-create-cap"],
  [50, "dualsensepremium-utility-outline dualsensepremium-create-outline"],
  [51, "dualsensepremium-utility-glyph dualsensepremium-create-glyph"],
  [52, "dualsensepremium-utility-cap dualsensepremium-options-cap"],
  [53, "dualsensepremium-utility-outline dualsensepremium-options-outline"],
  [54, "dualsensepremium-utility-glyph dualsensepremium-options-glyph"],
  ...[55, 59, 63, 67].map((index, offset) => [index, `dualsensepremium-dpad-shadow dualsensepremium-dpad-shadow-${["left", "right", "up", "down"][offset]}`]),
  ...[56, 60, 64, 68].map((index, offset) => [index, `dualsensepremium-dpad-rim dualsensepremium-dpad-rim-${["left", "right", "up", "down"][offset]}`]),
  ...[57, 61, 65, 69].map((index, offset) => [index, `dualsensepremium-dpad-cap dualsensepremium-dpad-cap-${["left", "right", "up", "down"][offset]}`]),
  ...[58, 62, 66, 70].map((index, offset) => [index, `dualsensepremium-dpad-glyph dualsensepremium-dpad-glyph-${["left", "right", "up", "down"][offset]}`]),
  [71, "dualsensepremium-speaker"],
  ...[72, 76, 80, 84].map((index, offset) => [index, `dualsensepremium-face-shadow dualsensepremium-face-shadow-${["cross", "square", "triangle", "circle"][offset]}`]),
  ...[73, 77, 81, 85].map((index, offset) => [index, `dualsensepremium-face-rim dualsensepremium-face-rim-${["cross", "square", "triangle", "circle"][offset]}`]),
  ...[74, 78, 82, 86].map((index, offset) => [index, `dualsensepremium-face-cap dualsensepremium-face-cap-${["cross", "square", "triangle", "circle"][offset]}`]),
  ...[75, 79, 83, 87].map((index, offset) => [index, `dualsensepremium-face-glyph dualsensepremium-face-glyph-${["cross", "square", "triangle", "circle"][offset]}`]),
  [88, "dualsensepremium-mic-glyph"],
]);

const toneByIndex = new Map([
  ...[0, 1, 9, 10, 28].map((index) => [index, "shell"]),
  ...[2, 3].map((index) => [index, "shellEdge"]),
  ...[49, 52].map((index) => [index, "shellHighlight"]),
  ...[4, 46].map((index) => [index, "core"]),
  ...[5, 7].map((index) => [index, "shoulder"]),
  ...[6, 8].map((index) => [index, "shoulderHighlight"]),
  [11, "touchBed"],
  ...[26, 27].map((index) => [index, "touchEdge"]),
  [25, "light"],
  ...[55, 59, 63, 67].map((index) => [index, "controlShadow"]),
  ...[72, 76, 80, 84].map((index) => [index, "faceShadow"]),
  ...[56, 60, 64, 68, 73, 77, 81, 85].map((index) => [index, "controlRim"]),
  ...[57, 61, 65, 69, 74, 78, 82, 86].map((index) => [index, "controlCap"]),
  ...[58, 62, 66, 70].map((index) => [index, "dpadGlyph"]),
  ...[75, 79, 83, 87].map((index) => [index, "faceGlyph"]),
  ...[51, 54].map((index) => [index, "utilityGlyph"]),
  [88, "micGlyph"],
]);

const DEPTH_SHAPES = [
  { name: "left-shell-ambient", index: 9, transform: "translate(0 30)", kind: "ambient shell" },
  { name: "right-shell-ambient", index: 10, transform: "translate(0 30)", kind: "ambient shell" },
  { name: "touchpad-contact", index: 28, transform: "translate(0 18)", kind: "contact touchpad" },
  { name: "left-stick-contact", index: 29, transform: "translate(0 18)", kind: "contact stick" },
  { name: "right-stick-contact", index: 37, transform: "translate(0 18)", kind: "contact stick" },
  ...[["left", 55], ["right", 59], ["up", 63], ["down", 67]].flatMap(([direction, index]) => [
    { name: `dpad-${direction}-ambient`, index, transform: "translate(0 22)", kind: "ambient dpad" },
    { name: `dpad-${direction}-contact`, index, transform: "translate(0 9)", kind: "contact dpad" },
  ]),
  ...[["cross", 72], ["square", 76], ["triangle", 80], ["circle", 84]].map(([name, index]) => ({
    name: `${name}-contact`, index, transform: "translate(0 15)", kind: "contact face",
  })),
  { name: "guide-contact", index: 45, transform: "translate(0 12)", kind: "contact guide" },
  { name: "create-contact", index: 49, transform: "translate(0 10)", kind: "contact utility" },
  { name: "options-contact", index: 52, transform: "translate(0 10)", kind: "contact utility" },
];

const sourcePath = resolve(process.argv[2]);
const sourceText = await readFile(sourcePath, "utf8");
const hash = createHash("sha256").update(Buffer.from(sourceText)).digest("hex").toUpperCase();
if (hash !== EXPECTED_HASH) {
  throw new Error(`DualSense source hash drifted: expected ${EXPECTED_HASH}, got ${hash}`);
}
if (!sourceText.includes(`viewBox="${SOURCE_VIEWBOX}"`)) {
  throw new Error(`DualSense source viewBox drifted: expected ${SOURCE_VIEWBOX}`);
}
if (/<(?:defs|filter|mask|image|foreignObject|use|style)\b/i.test(sourceText)) {
  throw new Error("DualSense source acquired a forbidden resource or effect element");
}

const shapes = parseSvg(sourceText);
if (shapes.length !== 89) {
  throw new Error(`DualSense source shape count drifted: expected 89, got ${shapes.length}`);
}

function cleanAttrs(shape) {
  return Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style"
    ),
  );
}

function renderProps(props) {
  return Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
}

const lines = [
  'import { h } from "@getforma/core";',
  "",
  "// GENERATED by scripts/compile-funky-dualsense.mjs from the Funky Designs",
  "// CC0 PS5_controller_small.svg. Do not hand-edit this geometry.",
  `// source-sha256: ${hash}`,
  "",
  `export const DUALSENSE_PREMIUM_SOURCE_VIEWBOX = ${q(SOURCE_VIEWBOX)};`,
  `export const DUALSENSE_PREMIUM_TRANSFORM = ${q(PAID_TRANSFORM)};`,
  "export const DUALSENSE_PREMIUM_SHELL_TONE = \"--dualsensep-shell\";",
  "",
  "export const DUALSENSE_PREMIUM_VARIANTS = [",
];

for (const variant of VARIANTS) {
  lines.push("  {");
  lines.push(`    slug: ${q(variant.slug)},`);
  lines.push(`    label: ${q(variant.label)},`);
  lines.push(`    swatch: ${q(variant.swatch)},`);
  lines.push(`    gradient: ${q(`nxg-dualsense-${variant.slug}`)},`);
  lines.push("    tones: {");
  for (const [name, value] of Object.entries(variant.tones)) {
    lines.push(`      ${q(`--dualsensep-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)}: ${q(value)},`);
  }
  lines.push("    },");
  lines.push("  },");
}
lines.push("] as const;");
lines.push("");
lines.push("export type DualSensePremiumVariantSlug = (typeof DUALSENSE_PREMIUM_VARIANTS)[number][\"slug\"];");
lines.push("");
lines.push("export function DualSensePremiumGeometry() {");
lines.push("  return h(");
lines.push('    "g",');
lines.push('    { class: "dualsensepremium-source", "fill-rule": "evenodd", "clip-rule": "evenodd", "stroke-linejoin": "round", "stroke-miterlimit": "2" },');

for (let index = 0; index < shapes.length; index += 1) {
  const shape = shapes[index];
  const style = styleMap(shape.attrs.style);
  const tone = toneByIndex.get(index);
  const fallbackFill = style.fill ?? "#000000";
  const classes = ["dualsensepremium-shape", semanticClassByIndex.get(index)].filter(Boolean).join(" ");
  const props = {
    class: classes,
    "data-dualsense-source-index": String(index),
    ...cleanAttrs(shape),
    fill: tone ? `var(--dualsensep-${tone.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}, ${fallbackFill})` : fallbackFill,
  };
  lines.push(`    h(${q(shape.tag)}, { ${renderProps(props)} }),`);
}

lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function DualSensePremiumDepth() {");
lines.push("  return h(");
lines.push('    "g",');
lines.push('    { class: "dualsensepremium-depth", "aria-hidden": "true", "fill-rule": "evenodd", "clip-rule": "evenodd", "stroke-linejoin": "round" },');
for (const item of DEPTH_SHAPES) {
  const shape = shapes[item.index];
  const props = {
    class: `dualsensepremium-depth-shadow ${item.kind.split(" ").map((kind) => `dualsensepremium-depth-${kind}`).join(" ")}`,
    "data-dualsense-depth": item.name,
    ...cleanAttrs(shape),
    transform: item.transform,
  };
  lines.push(`    h(${q(shape.tag)}, { ${renderProps(props)} }),`);
}
lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function DualSensePremiumButtonHooks() {");
lines.push("  return h(");
lines.push('    "g",');
lines.push('    { class: "dualsensepremium-button-hooks" },');
// The paid front view exposes one shoulder pair. The established mapper also
// needs L1/R1, so these two exact current-viewBox pills are deliberately
// app-owned and can share the visible bumper geometry added by integration.
lines.push('    h("rect", { "data-fn": "lb", class: "dualsensepremium-hook dualsensepremium-hook-app-bumper", x: "152", y: "288", width: "132", height: "36", rx: "17", fill: "transparent", "vector-effect": "non-scaling-stroke" }),');
lines.push('    h("rect", { "data-fn": "rb", class: "dualsensepremium-hook dualsensepremium-hook-app-bumper", x: "798", y: "288", width: "132", height: "36", rx: "17", fill: "transparent", "vector-effect": "non-scaling-stroke" }),');
lines.push('    h("g", { class: "dualsensepremium-paid-hooks", transform: DUALSENSE_PREMIUM_TRANSFORM },');
for (const [fn, index] of [
  ["lt", 5], ["rt", 7], ["back", 49], ["start", 52],
  ["dpad.left", 55], ["dpad.right", 59], ["dpad.up", 63], ["dpad.down", 67],
  ["guide", 45],
]) {
  const shape = shapes[index];
  lines.push(`      h(${q(shape.tag)}, { "data-fn": ${q(fn)}, class: "dualsensepremium-hook", ${renderProps(cleanAttrs(shape))}, fill: "transparent", "vector-effect": "non-scaling-stroke" }),`);
}
for (const [fn, index] of [["a", 72], ["x", 76], ["y", 80], ["b", 84]]) {
  const shape = shapes[index];
  lines.push(`      h("circle", { "data-fn": ${q(fn)}, class: "dualsensepremium-hook", ${renderProps(cleanAttrs(shape))}, fill: "transparent", "vector-effect": "non-scaling-stroke" }),`);
}
const stickHooks = [
  ["lthumb", 1291.5, 1246.54, 137.255],
  ["ly.max", 1291.5, 1019.37, 99.13], ["ly.min", 1291.5, 1473.71, 99.13],
  ["lx.min", 1064.33, 1246.54, 99.13], ["lx.max", 1518.67, 1246.54, 99.13],
  ["rthumb", 2508.87, 1246.54, 137.255],
  ["ry.max", 2508.87, 1019.37, 99.13], ["ry.min", 2508.87, 1473.71, 99.13],
  ["rx.min", 2281.7, 1246.54, 99.13], ["rx.max", 2736.04, 1246.54, 99.13],
];
for (const [fn, cx, cy, radius] of stickHooks) {
  lines.push(`      h("circle", { "data-fn": ${q(fn)}, class: "dualsensepremium-hook", cx: ${q(String(cx))}, cy: ${q(String(cy))}, r: ${q(String(radius))}, fill: "transparent", "vector-effect": "non-scaling-stroke" }),`);
}
lines.push("    ),");
lines.push("  );");
lines.push("}");
lines.push("");

await writeFile(OUTPUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUTPUT} (${shapes.length} visible shapes, ${VARIANTS.length} palettes, ${DEPTH_SHAPES.length} depth shapes, 25 hooks)`);
