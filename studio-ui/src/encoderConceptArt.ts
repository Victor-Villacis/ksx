import { createCanvasItem } from "./genui/canvas/index";

// The encoder lab is deliberately app-authored geometry. The paid/free asset
// library has excellent controller and keyboard references, but no licensed
// encoder PCB master. More importantly, copying one vendor's board silhouette
// would imply knowledge the generic HID path does not have. These three SVGs
// instead make the evidence model visible: profile/read, observed, declared,
// and still unknown.

const SVG_NS = "http://www.w3.org/2000/svg";

export type EncoderConceptId = "read-backed" | "guided-teach" | "hybrid-truth";

export const ENCODER_CONCEPT_INSTANCE_IDS = [
  "encoder-concept-read-backed",
  "encoder-concept-guided-teach",
  "encoder-concept-hybrid-truth",
] as const;

export interface EncoderConceptHome {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

export interface EncoderConceptCanvasItem {
  item: HTMLElement;
  home: EncoderConceptHome;
}

interface EncoderConceptDefinition {
  id: EncoderConceptId;
  instanceId: (typeof ENCODER_CONCEPT_INSTANCE_IDS)[number];
  option: string;
  title: string;
  subtitle: string;
  note: string;
  recommendation?: string;
  metrics: Array<{ value: string; label: string; tone?: string }>;
  legend: Array<{ label: string; tone: string }>;
  home: EncoderConceptHome;
  render: (document_: Document) => SVGSVGElement;
}

type SvgAttributes = Record<string, string | number | undefined>;

function svgElement<K extends keyof SVGElementTagNameMap>(
  document_: Document,
  name: K,
  attributes: SvgAttributes = {},
): SVGElementTagNameMap[K] {
  const element = document_.createElementNS(SVG_NS, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    if (value !== undefined) element.setAttribute(attribute, String(value));
  }
  return element;
}

function svgText(
  document_: Document,
  value: string,
  x: number,
  y: number,
  className: string,
  anchor?: "start" | "middle" | "end",
): SVGTextElement {
  const text = svgElement(document_, "text", {
    x,
    y,
    class: className,
    "text-anchor": anchor,
  });
  text.textContent = value;
  return text;
}

function conceptSvg(
  document_: Document,
  id: EncoderConceptId,
  titleText: string,
  description: string,
): SVGSVGElement {
  const svg = svgElement(document_, "svg", {
    class: "rd-encoder-svg",
    viewBox: "0 0 700 360",
    "aria-hidden": "true",
    focusable: "false",
    preserveAspectRatio: "xMidYMid meet",
  });
  const title = svgElement(document_, "title", { id: `rd-encoder-${id}-title` });
  title.textContent = titleText;
  const desc = svgElement(document_, "desc", { id: `rd-encoder-${id}-desc` });
  desc.textContent = description;
  svg.append(title, desc);
  return svg;
}

const TERMINAL_KINDS = [
  { id: "up", short: "↑", label: "Up" },
  { id: "down", short: "↓", label: "Down" },
  { id: "left", short: "←", label: "Left" },
  { id: "right", short: "→", label: "Right" },
  { id: "sw1", short: "1", label: "SW1" },
  { id: "sw2", short: "2", label: "SW2" },
  { id: "sw3", short: "3", label: "SW3" },
  { id: "sw4", short: "4", label: "SW4" },
  { id: "sw5", short: "5", label: "SW5" },
  { id: "sw6", short: "6", label: "SW6" },
  { id: "sw7", short: "7", label: "SW7" },
  { id: "sw8", short: "8", label: "SW8" },
  { id: "start", short: "ST", label: "Start" },
  { id: "coin", short: "CO", label: "Coin" },
] as const;

const SAMPLE_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ControlLeft",
  "AltLeft",
  "Space",
  "ShiftLeft",
  "KeyZ",
  "KeyX",
  "KeyC",
  "KeyV",
  "Digit1",
  "Digit5",
] as const;

function appendMountingHoles(document_: Document, svg: SVGSVGElement): void {
  for (const [cx, cy] of [[50, 58], [650, 58], [50, 302], [650, 302]]) {
    const hole = svgElement(document_, "g", { class: "rd-encoder-mount" });
    hole.append(
      svgElement(document_, "circle", { cx, cy, r: 10 }),
      svgElement(document_, "circle", { cx, cy, r: 4, class: "rd-encoder-mount-core" }),
    );
    svg.append(hole);
  }
}

/** A full profile roster and chart can truthfully produce all 56 terminal
 * identities and mappings. Geometry remains a schematic until a model
 * descriptor owns exact screw coordinates, so the art says that plainly. */
function renderReadBackedBoard(document_: Document): SVGSVGElement {
  const svg = conceptSvg(
    document_,
    "read-backed",
    "Read-backed encoder board map",
    "A profile-backed I-PAC 4X sample showing 56 known terminal identities and chart mappings. The roster is exact; physical placement and cabinet wiring are not inferred.",
  );
  svg.dataset.terminalCount = "56";
  svg.dataset.capacitySource = "measured-profile";

  svg.append(
    svgElement(document_, "rect", {
      x: 25,
      y: 35,
      width: 650,
      height: 285,
      rx: 24,
      class: "rd-encoder-board",
    }),
    svgElement(document_, "rect", {
      x: 314,
      y: 24,
      width: 72,
      height: 24,
      rx: 5,
      class: "rd-encoder-port",
    }),
    svgText(document_, "USB", 350, 40, "rd-encoder-port-label", "middle"),
  );
  appendMountingHoles(document_, svg);

  const traceLayer = svgElement(document_, "g", { class: "rd-encoder-traces" });
  for (const path of [
    "M 286 110 C 314 110, 316 146, 334 154",
    "M 414 110 C 386 110, 384 146, 366 154",
    "M 286 238 C 314 238, 316 214, 334 206",
    "M 414 238 C 386 238, 384 214, 366 206",
  ]) {
    traceLayer.append(svgElement(document_, "path", { d: path }));
  }
  svg.append(traceLayer);

  const banks = [
    { player: 1, x: 62, y: 70 },
    { player: 2, x: 390, y: 70 },
    { player: 3, x: 62, y: 202 },
    { player: 4, x: 390, y: 202 },
  ];
  for (const bank of banks) {
    const group = svgElement(document_, "g", {
      class: `rd-encoder-bank rd-encoder-bank-p${bank.player}`,
      transform: `translate(${bank.x} ${bank.y})`,
      "data-player": bank.player,
    });
    group.append(
      svgElement(document_, "rect", {
        width: 248,
        height: 86,
        rx: 11,
        class: "rd-encoder-bank-body",
      }),
      svgText(document_, `PLAYER ${bank.player}`, 10, 15, "rd-encoder-bank-label"),
    );
    TERMINAL_KINDS.forEach((terminal, index) => {
      const column = index % 7;
      const row = Math.floor(index / 7);
      const x = 10 + column * 33;
      const y = 23 + row * 27;
      // Match PanelTerminalTruth.terminal_id exactly. Player/kind remain
      // separate display metadata; inventing a prettier ID here would make a
      // real chart row impossible to join to its SVG terminal.
      const terminalId = `${bank.player}${terminal.id}`;
      const normalKey = SAMPLE_KEYS[(index + (bank.player - 1) * 3) % SAMPLE_KEYS.length];
      const cell = svgElement(document_, "g", {
        class: "rd-encoder-terminal is-read",
        transform: `translate(${x} ${y})`,
        "data-terminal-id": terminalId,
        "data-player": bank.player,
        "data-terminal-kind": terminal.id,
        "data-normal-key": normalKey,
        "data-evidence": "profile-chart",
        "aria-hidden": "true",
      });
      const title = svgElement(document_, "title");
      title.textContent = `Player ${bank.player} ${terminal.label} — sample chart: ${normalKey}`;
      cell.append(
        title,
        svgElement(document_, "rect", { width: 29, height: 21, rx: 4 }),
        svgText(document_, terminal.short, 14.5, 14.5, "rd-encoder-terminal-label", "middle"),
      );
      group.append(cell);
    });
    svg.append(group);
  }

  const processor = svgElement(document_, "g", { class: "rd-encoder-processor" });
  processor.append(
    svgElement(document_, "rect", { x: 315, y: 137, width: 70, height: 86, rx: 10 }),
    svgText(document_, "PROFILE", 350, 164, "rd-encoder-chip-kick", "middle"),
    svgText(document_, "56", 350, 190, "rd-encoder-chip-count", "middle"),
    svgText(document_, "CHART", 350, 209, "rd-encoder-chip-kick", "middle"),
  );
  svg.append(
    processor,
    svgText(
      document_,
      "Exact roster · sample mapping · schematic placement",
      350,
      344,
      "rd-encoder-svg-caption",
      "middle",
    ),
  );
  return svg;
}

interface ObservedControl {
  id: string;
  label: string;
  signal: string;
  x: number;
  y: number;
  shape?: "key";
}

const OBSERVED_CONTROLS: ObservedControl[] = [
  { id: "up", label: "UP", signal: "↑", x: 135, y: 125 },
  { id: "down", label: "DOWN", signal: "↓", x: 135, y: 215 },
  { id: "left", label: "LEFT", signal: "←", x: 90, y: 170 },
  { id: "right", label: "RIGHT", signal: "→", x: 180, y: 170 },
  { id: "sw1", label: "SW1", signal: "A", x: 350, y: 135 },
  { id: "sw2", label: "SW2", signal: "S", x: 425, y: 125 },
  { id: "sw3", label: "SW3", signal: "D", x: 500, y: 135 },
  { id: "sw4", label: "SW4", signal: "F", x: 335, y: 215 },
  { id: "sw5", label: "SW5", signal: "G", x: 410, y: 205 },
  { id: "sw6", label: "SW6", signal: "H", x: 485, y: 215 },
  { id: "start", label: "START", signal: "1", x: 585, y: 145, shape: "key" },
  { id: "coin", label: "COIN", signal: "5", x: 585, y: 215, shape: "key" },
];

/** Generic HID observation can grow a useful control surface, but not a
 * terminal-accurate PCB. Every visible control is explicitly user-named and
 * paired with the exact-device signal the input test observed. */
function renderGuidedTeachSurface(document_: Document): SVGSVGElement {
  const svg = conceptSvg(
    document_,
    "guided-teach",
    "Guided encoder teach surface",
    "A generic keyboard encoder sample with twelve user-named controls and exact-device key signals. Physical terminal capacity remains unknown.",
  );
  svg.dataset.observedControlCount = String(OBSERVED_CONTROLS.length);
  svg.dataset.capacity = "unknown";

  const steps = ["1  Name control", "2  Press once", "3  Verify source"];
  steps.forEach((step, index) => {
    const x = 78 + index * 188;
    const group = svgElement(document_, "g", { class: "rd-encoder-teach-step" });
    group.append(
      svgElement(document_, "rect", { x, y: 20, width: 164, height: 30, rx: 15 }),
      svgText(document_, step, x + 82, 39, "rd-encoder-teach-step-label", "middle"),
    );
    if (index < steps.length - 1) {
      group.append(svgElement(document_, "path", {
        d: `M ${x + 168} 35 H ${x + 182}`,
        class: "rd-encoder-step-link",
      }));
    }
    svg.append(group);
  });

  svg.append(
    svgElement(document_, "rect", {
      x: 35,
      y: 70,
      width: 630,
      height: 230,
      rx: 28,
      class: "rd-encoder-faceplate",
    }),
    svgElement(document_, "circle", {
      cx: 135,
      cy: 170,
      r: 60,
      class: "rd-encoder-joystick-guide",
    }),
    svgText(document_, "USER-NAMED CONTROLS", 350, 91, "rd-encoder-faceplate-label", "middle"),
  );

  for (const control of OBSERVED_CONTROLS) {
    const group = svgElement(document_, "g", {
      class: `rd-observed-control${control.shape === "key" ? " is-key" : ""}`,
      "data-control-id": control.id,
      "data-signal": control.signal,
      "data-evidence": "observed",
      "aria-hidden": "true",
      transform: `translate(${control.x} ${control.y})`,
    });
    const title = svgElement(document_, "title");
    title.textContent = `${control.label}, taught from observed key ${control.signal}`;
    const body = control.shape === "key"
      ? svgElement(document_, "rect", { x: -35, y: -22, width: 70, height: 44, rx: 12 })
      : svgElement(document_, "circle", { r: 27 });
    group.append(
      title,
      body,
      svgText(document_, control.label, 0, -2, "rd-observed-control-label", "middle"),
      svgElement(document_, "rect", {
        x: -15,
        y: 8,
        width: 30,
        height: 16,
        rx: 5,
        class: "rd-observed-signal-badge",
      }),
      svgText(document_, control.signal, 0, 20, "rd-observed-signal-label", "middle"),
    );
    svg.append(group);
  }

  const addNext = svgElement(document_, "g", { class: "rd-encoder-add-next" });
  addNext.append(
    svgElement(document_, "rect", { x: 530, y: 257, width: 104, height: 26, rx: 13 }),
    svgText(document_, "+ teach next", 582, 274, "rd-encoder-add-next-label", "middle"),
  );
  svg.append(
    addNext,
    svgText(
      document_,
      "12 controls taught · terminal capacity unknown",
      350,
      334,
      "rd-encoder-svg-caption",
      "middle",
    ),
  );
  return svg;
}

const OBSERVED_CHANNELS = new Set([0, 1, 2, 3, 4, 16, 17, 18, 19, 20]);
const DECLARED_CHANNELS = new Set([...OBSERVED_CHANNELS, 5, 21]);

/** The recommended long-term model keeps sources separate instead of
 * collapsing them into one confident-looking board. Known capacity comes
 * from a model descriptor; declaration and observation add evidence without
 * turning the remaining channels into fabricated wiring claims. */
function renderHybridTruthMap(document_: Document): SVGSVGElement {
  const svg = conceptSvg(
    document_,
    "hybrid-truth",
    "Hybrid encoder truth map",
    "A hypothetical user-selected 32-channel catalog model combines twelve declared mappings and ten observed signals while preserving twenty unmapped unknown channels.",
  );
  svg.dataset.capacity = "32";
  svg.dataset.capacitySource = "sample-catalog";
  svg.dataset.declaredCount = "12";
  svg.dataset.observedCount = "10";

  svg.append(
    svgElement(document_, "rect", {
      x: 28,
      y: 56,
      width: 644,
      height: 238,
      rx: 24,
      class: "rd-encoder-board rd-encoder-hybrid-board",
    }),
  );
  appendMountingHoles(document_, svg);

  for (let index = 0; index < 32; index += 1) {
    const onTop = index < 16;
    const column = index % 16;
    const x = 51 + column * 38;
    const y = onTop ? 67 : 267;
    const observed = OBSERVED_CHANNELS.has(index);
    const declared = DECLARED_CHANNELS.has(index);
    const evidenceState = observed && declared
      ? "observed-and-declared"
      : declared
      ? "declared-only"
      : "unknown";
    const channel = svgElement(document_, "g", {
      class:
        `rd-hybrid-channel${observed ? " has-observation" : ""}` +
        `${declared ? " has-declaration" : ""}`,
      transform: `translate(${x} ${y})`,
      "data-channel-id": `ch-${String(index + 1).padStart(2, "0")}`,
      "data-model-source": "sample-catalog",
      "data-declared": String(declared),
      "data-observed": String(observed),
      "data-evidence-state": evidenceState,
      "aria-hidden": "true",
    });
    const title = svgElement(document_, "title");
    title.textContent = `Channel ${index + 1}: ${evidenceState}`;
    channel.append(
      title,
      svgElement(document_, "rect", { width: 28, height: 20, rx: 4 }),
      svgText(
        document_,
        String(index + 1).padStart(2, "0"),
        14,
        14,
        "rd-hybrid-channel-label",
        "middle",
      ),
    );
    svg.append(channel);
  }

  const layers = [
    { x: 78, kick: "CATALOG", value: "32", detail: "sample channels" },
    { x: 278, kick: "DECLARED", value: "12", detail: "mappings" },
    { x: 478, kick: "OBSERVED", value: "10", detail: "signals" },
  ];
  layers.forEach((layer, index) => {
    const group = svgElement(document_, "g", {
      class: `rd-truth-layer rd-truth-layer-${index + 1}`,
    });
    group.append(
      svgElement(document_, "rect", { x: layer.x, y: 123, width: 144, height: 100, rx: 16 }),
      svgText(document_, layer.kick, layer.x + 72, 147, "rd-truth-layer-kick", "middle"),
      svgText(document_, layer.value, layer.x + 72, 183, "rd-truth-layer-value", "middle"),
      svgText(document_, layer.detail, layer.x + 72, 204, "rd-truth-layer-detail", "middle"),
    );
    if (index < layers.length - 1) {
      group.append(
        svgElement(document_, "path", {
          d: `M ${layer.x + 152} 173 H ${layer.x + 188}`,
          class: "rd-truth-layer-link",
        }),
        svgElement(document_, "path", {
          d: `M ${layer.x + 183} 168 L ${layer.x + 190} 173 L ${layer.x + 183} 178`,
          class: "rd-truth-layer-arrow",
        }),
      );
    }
    svg.append(group);
  });

  svg.append(
    svgText(
      document_,
      "Catalog sample · independent evidence can agree, conflict, or stay unknown",
      350,
      330,
      "rd-encoder-svg-caption",
      "middle",
    ),
  );
  return svg;
}

const ENCODER_CONCEPTS: EncoderConceptDefinition[] = [
  {
    id: "read-backed",
    instanceId: ENCODER_CONCEPT_INSTANCE_IDS[0],
    option: "Concept A",
    title: "Read-backed board map",
    subtitle: "Known profile · I-PAC 4X · 56-terminal sample",
    note:
      "Use when KSX admits an exact hardware profile. The roster and programmed mappings can be real; a chart still cannot prove which screws are physically wired.",
    metrics: [
      { value: "56", label: "profile terminals", tone: "read" },
      { value: "Read", label: "mapping source", tone: "read" },
      { value: "Unknown", label: "physical wiring", tone: "unknown" },
    ],
    legend: [
      { label: "Profile + chart", tone: "read" },
      { label: "Wiring not inferred", tone: "unknown" },
    ],
    home: { x: 120, y: 120, width: 680, height: 520, z: 20, manualScale: 1 },
    render: renderReadBackedBoard,
  },
  {
    id: "guided-teach",
    instanceId: ENCODER_CONCEPT_INSTANCE_IDS[1],
    option: "Concept B",
    title: "Guided teach surface",
    subtitle: "Generic encoder · exact-device input learning",
    note:
      "Works with keyboard-mode encoders. Teach one user-named control at a time: a batch of presses loses physical association and duplicate mappings can collapse into one signal.",
    metrics: [
      { value: "12", label: "controls taught", tone: "observed" },
      { value: "Exact", label: "device source", tone: "observed" },
      { value: "Unknown", label: "terminal capacity", tone: "unknown" },
    ],
    legend: [
      { label: "Observed signal", tone: "observed" },
      { label: "User-named control", tone: "declared" },
    ],
    home: { x: 840, y: 120, width: 680, height: 520, z: 21, manualScale: 1 },
    render: renderGuidedTeachSurface,
  },
  {
    id: "hybrid-truth",
    instanceId: ENCODER_CONCEPT_INSTANCE_IDS[2],
    option: "Concept C",
    title: "Hybrid truth map",
    subtitle: "Sample catalog + declaration + teach · provenance stays attached",
    note:
      "Recommended. Start generic, accept declared mappings, retain observed signals independently, and become terminal-accurate only when a measured profile is available. Generic HID does not read model capacity.",
    recommendation: "Recommended direction",
    metrics: [
      { value: "32", label: "sample catalog channels", tone: "read" },
      { value: "12", label: "declared mappings", tone: "declared" },
      { value: "10", label: "observed signals", tone: "verified" },
    ],
    legend: [
      { label: "Observed + declared", tone: "verified" },
      { label: "Declared only", tone: "declared" },
      { label: "Unmapped / unknown", tone: "unknown" },
    ],
    home: { x: 480, y: 700, width: 680, height: 520, z: 22, manualScale: 1 },
    render: renderHybridTruthMap,
  },
];

function encoderConceptContent(
  document_: Document,
  definition: EncoderConceptDefinition,
): HTMLElement {
  const content = document_.createElement("section");
  content.className = "rd-encoder-concept";
  content.dataset.formaRuntimeHost = "";
  content.dataset.conceptId = definition.id;
  content.dataset.sampleData = "true";

  const header = document_.createElement("header");
  header.className = "rd-encoder-concept-head";
  const headingCopy = document_.createElement("div");
  headingCopy.className = "rd-encoder-heading-copy";
  const eyebrow = document_.createElement("p");
  eyebrow.className = "rd-encoder-eyebrow";
  eyebrow.textContent = `${definition.option} · Prototype · sample data`;
  const title = document_.createElement("h2");
  title.className = "rd-encoder-title";
  title.textContent = definition.title;
  const subtitle = document_.createElement("p");
  subtitle.className = "rd-encoder-subtitle";
  subtitle.textContent = definition.subtitle;
  headingCopy.append(eyebrow, title, subtitle);
  header.append(headingCopy);
  if (definition.recommendation) {
    const recommendation = document_.createElement("span");
    recommendation.className = "rd-encoder-recommendation";
    recommendation.textContent = definition.recommendation;
    header.append(recommendation);
  }

  const metrics = document_.createElement("dl");
  metrics.className = "rd-encoder-metrics";
  for (const metric of definition.metrics) {
    const cell = document_.createElement("div");
    cell.className = "rd-encoder-metric";
    if (metric.tone) cell.dataset.tone = metric.tone;
    const label = document_.createElement("dt");
    label.textContent = metric.label;
    const value = document_.createElement("dd");
    value.textContent = metric.value;
    cell.append(label, value);
    metrics.append(cell);
  }

  const figure = document_.createElement("figure");
  figure.className = "rd-encoder-figure";
  // The visible heading, metrics, legend, and note carry the same meaning in
  // normal HTML. Keep the dense schematic decorative instead of exposing an
  // unnamed figure plus dozens of tiny SVG text fragments.
  figure.setAttribute("aria-hidden", "true");
  figure.append(definition.render(document_));

  const footer = document_.createElement("footer");
  footer.className = "rd-encoder-concept-foot";
  const legend = document_.createElement("div");
  legend.className = "rd-encoder-legend";
  for (const entry of definition.legend) {
    const chip = document_.createElement("span");
    chip.className = "rd-encoder-legend-item";
    chip.dataset.tone = entry.tone;
    const dot = document_.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    chip.append(dot, entry.label);
    legend.append(chip);
  }
  const note = document_.createElement("p");
  note.className = "rd-encoder-note";
  note.textContent = definition.note;
  const safety = document_.createElement("p");
  safety.className = "rd-encoder-safety";
  safety.textContent = "Review prototype · no hardware read or write";
  footer.append(legend, note, safety);

  content.append(header, metrics, figure, footer);
  return content;
}

export function createEncoderConceptCanvasItems(document_: Document): EncoderConceptCanvasItem[] {
  return ENCODER_CONCEPTS.map((definition) => {
    const displayName = `${definition.option} — ${definition.title}`;
    const item = createCanvasItem({
      instanceId: definition.instanceId,
      displayName,
      preferredWidth: definition.home.width,
      minHeight: definition.home.height,
      // Comparison cards have a fixed information architecture. Canvas scale
      // still works, but width-resizing would turn the dense SVG into a
      // clipped mini-layout and make the three options harder to compare.
      resizable: false,
      content: encoderConceptContent(document_, definition),
      document: document_,
    });
    item.classList.add("rd-encoder-concept-node");
    item.dataset.clientWidget = "";
    item.dataset.conceptId = definition.id;
    item.dataset.prototype = "true";
    item.dataset.sampleData = "true";
    return { item, home: { ...definition.home } };
  });
}
