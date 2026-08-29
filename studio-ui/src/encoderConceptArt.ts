import { createCanvasItem } from "./genui/canvas/index";
import {
  detectEncoderVisualProfile,
  type BackendEncoderFacts,
  type EncoderDetectionResult,
} from "./encoderDetection";
import {
  getEncoderVisualProfile,
  listEncoderVisualProfiles,
  summarizeEncoderTopology,
  type EncoderVisualProfile,
  type EncoderVisualProfileId,
  type EncoderVisualTerminal,
} from "./encoderVisualRegistry";

/** One stable canvas node. Profile changes repaint it; they never move it. */
export const ENCODER_PROFILE_LAB_INSTANCE_ID = "encoder-profile-lab";

const SVG_NS = "http://www.w3.org/2000/svg";
const CATALOG_PREFIX = "catalog:";
const CONNECTED_PREFIX = "connected:";
const AMBIGUOUS_SAMPLE = "sample:ambiguous-minipac";
const UNKNOWN_SAMPLE = "sample:unknown-hid";

export interface EncoderProfileLabDevice {
  selector: string;
  name: string;
  alias?: string;
  backend: BackendEncoderFacts;
}

export interface EncoderProfileLabOptions {
  connectedEncoders?: readonly EncoderProfileLabDevice[];
  /** A catalog id only. Connected-device selectors are never stored. */
  initialProfileId?: EncoderVisualProfileId;
  onProfileChange?: (profileId: EncoderVisualProfileId) => void;
}

export interface EncoderProfileLabHome {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

export interface EncoderProfileLabCanvasItem {
  item: HTMLElement;
  home: EncoderProfileLabHome;
  updateConnectedEncoders: (devices: readonly EncoderProfileLabDevice[]) => void;
}

interface ObservedSignal {
  id: string;
  source: string;
  emission: string;
}

interface LabSelection {
  value: string;
  label: string;
  group: "connected" | "evidence" | "catalog";
  device?: EncoderProfileLabDevice;
  profileId?: EncoderVisualProfileId;
  backend?: BackendEncoderFacts;
  observations: readonly ObservedSignal[];
}

type SvgAttributes = Record<string, string | number | undefined>;

const UNKNOWN_SAMPLE_SIGNALS: readonly ObservedSignal[] = [
  { id: "kbd-arrow-up", source: "Keyboard collection", emission: "ArrowUp" },
  { id: "kbd-arrow-left", source: "Keyboard collection", emission: "ArrowLeft" },
  { id: "kbd-key-a", source: "Keyboard collection", emission: "KeyA" },
  { id: "kbd-key-s", source: "Keyboard collection", emission: "KeyS" },
  { id: "kbd-digit-1", source: "Keyboard collection", emission: "Digit1" },
  { id: "kbd-digit-5", source: "Keyboard collection", emission: "Digit5" },
];

const LAB_HOME: EncoderProfileLabHome = {
  x: 160,
  y: 140,
  width: 900,
  height: 700,
  z: 20,
  manualScale: 1,
};

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
  anchor: "start" | "middle" | "end" = "start",
): SVGTextElement {
  const text = svgElement(document_, "text", { x, y, class: className, "text-anchor": anchor });
  text.textContent = value;
  return text;
}

function html<K extends keyof HTMLElementTagNameMap>(
  document_: Document,
  name: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document_.createElement(name);
  if (className) element.className = className;
  return element;
}

function topologyValue(profile: EncoderVisualProfile): string {
  const capacity = profile.topology.capacity;
  switch (capacity.kind) {
    case "exact": return String(capacity.inputCount);
    case "discrete": return capacity.inputCounts.join(" / ");
    case "range": return `${capacity.minimumInputCount}–${capacity.maximumInputCount}`;
    case "logical": return String(capacity.controlCount);
    case "unknown": return "Unknown";
  }
}

function topologyUnit(profile: EncoderVisualProfile): string {
  switch (profile.topology.capacity.kind) {
    case "logical": return "logical controls";
    case "discrete": return "variant controls";
    case "range": return "family controls";
    case "exact": return "profile inputs";
    case "unknown": return "terminal capacity";
  }
}

function confidenceLabel(profile: EncoderVisualProfile): string {
  switch (profile.topology.confidence) {
    case "measured": return "Measured roster";
    case "manufacturer-published": return "Vendor documented";
    case "official-project-reference": return "Official reference";
    case "logical-only": return "Logical only";
    case "unknown": return "Unknown";
  }
}

function resolutionLabel(result: EncoderDetectionResult): string {
  switch (result.resolution) {
    case "backend-exact": return "Exact backend profile";
    case "backend-family": return "Backend family match";
    case "manual": return "User-selected reference";
    case "ambiguous-family": return "Variant confirmation required";
    case "known-family": return "Known family · visual topology unavailable";
    case "identity-conflict": return "Identity conflict — drawing withheld";
    case "unrecognised": return "Unknown device";
  }
}

function protocolLabel(result: EncoderDetectionResult): string {
  switch (result.protocol.chartRead) {
    case "supported": return "Configuration read available";
    case "unsupported": return "No KSX configuration reader";
    case "not-reported": return "Configuration access not verified";
  }
}

function terminalShortLabel(terminal: EncoderVisualTerminal): string {
  if (terminal.kind === "direction") {
    if (terminal.id.endsWith("up") || terminal.id === "up") return "↑";
    if (terminal.id.endsWith("down") || terminal.id === "down") return "↓";
    if (terminal.id.endsWith("left") || terminal.id === "left") return "←";
    if (terminal.id.endsWith("right") || terminal.id === "right") return "→";
  }
  if (terminal.kind === "start") return "ST";
  if (terminal.kind === "coin") return "CO";
  const withoutPlayer = terminal.label.replace(/^P\d+\s+/i, "");
  const numberedButton = /^Button\s+(\d+)$/i.exec(withoutPlayer);
  if (numberedButton) return `B${numberedButton[1]}`;
  return withoutPlayer.length <= 5 ? withoutPlayer : withoutPlayer.slice(0, 4);
}

function groupLabel(groupId: string): string {
  const player = /^player-(\d+)$/.exec(groupId);
  if (player) return `Player ${player[1]}`;
  if (groupId === "directions") return "Directions";
  if (groupId === "actions") return "Actions";
  if (groupId === "system") return "System";
  if (groupId === "cabinet") return "Cabinet";
  return groupId.replace(/[-_]+/g, " ");
}

function appendMountingHoles(document_: Document, svg: SVGSVGElement): void {
  for (const [cx, cy] of [[44, 58], [796, 58], [44, 302], [796, 302]]) {
    const hole = svgElement(document_, "g", { class: "rd-encoder-profile-mount" });
    hole.append(
      svgElement(document_, "circle", { cx, cy, r: 9 }),
      svgElement(document_, "circle", { cx, cy, r: 3.5, class: "rd-encoder-profile-mount-core" }),
    );
    svg.append(hole);
  }
}

function createProfileSvg(
  document_: Document,
  profile: EncoderVisualProfile,
  description: string,
): SVGSVGElement {
  const titleId = `rd-encoder-svg-${profile.id}-title`;
  const descriptionId = `rd-encoder-svg-${profile.id}-description`;
  const svg = svgElement(document_, "svg", {
    class: "rd-encoder-profile-svg",
    viewBox: "0 0 840 360",
    role: "img",
    "aria-labelledby": `${titleId} ${descriptionId}`,
    preserveAspectRatio: "xMidYMid meet",
    focusable: "false",
    "data-profile-id": profile.id,
    "data-layout-fidelity": profile.topology.confidence,
  });
  const title = svgElement(document_, "title", { id: titleId });
  title.textContent = profile.id === "unknown-hid"
    ? `${profile.model} encoder evidence`
    : `${profile.manufacturer} ${profile.model} encoder profile`;
  const desc = svgElement(document_, "desc", { id: descriptionId });
  desc.textContent = description;
  svg.append(title, desc);
  return svg;
}

function groupPositions(profile: EncoderVisualProfile): Array<{
  id: string;
  terminals: readonly EncoderVisualTerminal[];
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const grouped = new Map<string, EncoderVisualTerminal[]>();
  for (const terminal of profile.topology.terminals) {
    const group = grouped.get(terminal.groupId) ?? [];
    group.push(terminal);
    grouped.set(terminal.groupId, group);
  }
  const orderedIds = [
    ...profile.layout.groupOrder.filter((id) => grouped.has(id)),
    ...Array.from(grouped.keys()).filter((id) => !profile.layout.groupOrder.includes(id)),
  ];
  const columns = Math.max(1, Math.min(profile.layout.preferredColumns, orderedIds.length));
  const rows = Math.max(1, Math.ceil(orderedIds.length / columns));
  const gapX = 22;
  const gapY = 18;
  const left = 62;
  const top = 68;
  const availableWidth = 716;
  const availableHeight = 232;
  const width = (availableWidth - gapX * (columns - 1)) / columns;
  const height = (availableHeight - gapY * (rows - 1)) / rows;
  return orderedIds.map((id, index) => ({
    id,
    terminals: grouped.get(id) ?? [],
    x: left + (index % columns) * (width + gapX),
    y: top + Math.floor(index / columns) * (height + gapY),
    width,
    height,
  }));
}

function renderKnownProfileSvg(document_: Document, result: EncoderDetectionResult): SVGSVGElement {
  const profile = result.profile;
  const svg = createProfileSvg(
    document_, profile, `${summarizeEncoderTopology(profile)} ${profile.topology.confidenceDetail}`,
  );
  svg.dataset.capacity = topologyValue(profile);
  svg.dataset.capacitySource = profile.topology.confidence;
  svg.dataset.resolution = result.resolution;
  svg.append(
    svgElement(document_, "rect", {
      x: 18, y: 34, width: 804, height: 286, rx: 24,
      class: `rd-encoder-profile-board is-${profile.visualKind}`,
    }),
    svgElement(document_, "rect", {
      x: 382, y: 23, width: 76, height: 25, rx: 6, class: "rd-encoder-profile-port",
    }),
    svgText(document_, "USB", 420, 40, "rd-encoder-profile-port-label", "middle"),
  );
  appendMountingHoles(document_, svg);
  const traces = svgElement(document_, "g", { class: "rd-encoder-profile-traces" });
  for (const path of [
    "M 84 174 C 210 174, 285 152, 384 154",
    "M 756 174 C 630 174, 555 152, 456 154",
    "M 84 218 C 220 218, 292 202, 384 196",
    "M 756 218 C 620 218, 548 202, 456 196",
  ]) traces.append(svgElement(document_, "path", { d: path }));
  svg.append(traces);
  for (const group of groupPositions(profile)) {
    const groupNode = svgElement(document_, "g", {
      class: "rd-encoder-profile-group",
      transform: `translate(${group.x} ${group.y})`,
      "data-terminal-group": group.id,
    });
    groupNode.append(
      svgElement(document_, "rect", {
        width: group.width, height: group.height, rx: 12,
        class: "rd-encoder-profile-group-body",
      }),
      svgText(document_, groupLabel(group.id), 12, 17, "rd-encoder-profile-group-label"),
    );
    const columns = Math.max(1, Math.min(8, Math.ceil(group.terminals.length / 2)));
    const rows = Math.max(1, Math.ceil(group.terminals.length / columns));
    const stepX = (group.width - 20) / columns;
    const stepY = (group.height - 30) / rows;
    group.terminals.forEach((terminal, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const cellWidth = Math.max(22, Math.min(34, stepX - 4));
      const cellHeight = Math.max(17, Math.min(23, stepY - 4));
      const x = 10 + column * stepX + (stepX - cellWidth) / 2;
      const y = 25 + row * stepY + (stepY - cellHeight) / 2;
      const terminalNode = svgElement(document_, "g", {
        class: `rd-encoder-profile-terminal is-${terminal.identityScope}` +
          (terminal.presence === "variant-only" ? " is-variant" : ""),
        transform: `translate(${x} ${y})`,
        "data-terminal-id": terminal.id,
        "data-terminal-label": terminal.label,
        "data-identity-scope": terminal.identityScope,
        "data-connection": terminal.connection,
        "data-presence": terminal.presence,
        "data-source-refs": terminal.sourceRefs.join(" "),
        "aria-hidden": "true",
      });
      const terminalTitle = svgElement(document_, "title");
      terminalTitle.textContent = `${terminal.label} · ${terminal.identityScope.replace("-", " ")}` +
        (terminal.presence === "variant-only" ? " · variant only" : "");
      terminalNode.append(
        terminalTitle,
        svgElement(document_, "rect", { width: cellWidth, height: cellHeight, rx: 4 }),
        svgText(document_, terminalShortLabel(terminal), cellWidth / 2, cellHeight / 2 + 3.5,
          "rd-encoder-profile-terminal-label", "middle"),
      );
      groupNode.append(terminalNode);
    });
    svg.append(groupNode);
  }
  const processor = svgElement(document_, "g", { class: "rd-encoder-profile-processor" });
  processor.append(
    svgElement(document_, "rect", { x: 389, y: 142, width: 62, height: 72, rx: 10 }),
    svgText(document_, "PROFILE", 420, 164, "rd-encoder-profile-chip-kick", "middle"),
    svgText(document_, topologyValue(profile), 420, 190, "rd-encoder-profile-chip-value", "middle"),
    svgText(document_, topologyUnit(profile).toUpperCase(), 420, 205,
      "rd-encoder-profile-chip-unit", "middle"),
  );
  if (profile.layout.preferredColumns !== 3) svg.append(processor);
  svg.append(svgText(
    document_,
    `${confidenceLabel(profile)} · ${profile.topology.terminals.length} visible rows · wiring state not inferred`,
    420, 344, "rd-encoder-profile-svg-caption", "middle",
  ));
  return svg;
}

function renderUnknownSvg(
  document_: Document,
  result: EncoderDetectionResult,
  observations: readonly ObservedSignal[],
  declaredLabels: readonly string[],
): SVGSVGElement {
  const profile = getEncoderVisualProfile("unknown-hid");
  const knownFamily = result.resolution === "known-family";
  const description = knownFamily
    ? "The backend family identity is known, but no verified terminal roster or physical topology is registered."
    : declaredLabels.length > 0
    ? `${declaredLabels.length} user-entered hardware labels are shown. Capacity and association with observed signals remain unknown.`
    : `${observations.length} sample device emissions are shown. No terminal count, PCB topology, wiring, or control association is inferred.`;
  const svg = createProfileSvg(document_, profile, description);
  if (knownFamily) {
    const title = svg.querySelector("title");
    if (title) {
      title.textContent = `${result.identity.familyLabel ?? "Known encoder family"} · visual topology unavailable`;
    }
  }
  svg.dataset.capacity = "unknown";
  svg.dataset.resolution = result.resolution;
  svg.dataset.observedCount = String(observations.length);
  svg.dataset.declaredCount = String(declaredLabels.length);
  svg.append(
    svgElement(document_, "rect", {
      x: 30, y: 42, width: 780, height: 268, rx: 26,
      class: "rd-encoder-profile-board is-unknown",
    }),
    svgText(document_, knownFamily ? "KNOWN FAMILY · TOPOLOGY WITHHELD" : "DEVICE-SCOPED EVIDENCE ONLY", 420, 73,
      "rd-encoder-profile-unknown-kick", "middle"),
  );
  if (declaredLabels.length > 0) {
    const columns = 8;
    const rows = Math.max(1, Math.ceil(declaredLabels.length / columns));
    const cellWidth = 82;
    const cellHeight = Math.min(34, 180 / rows);
    declaredLabels.forEach((label, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = 74 + column * 88;
      const y = 94 + row * cellHeight;
      const slot = svgElement(document_, "g", {
        class: "rd-encoder-profile-declared-slot",
        transform: `translate(${x} ${y})`,
        "data-declared-terminal-id": `declared-${index + 1}`,
        "data-declared-label": label,
        "aria-hidden": "true",
      });
      const slotTitle = svgElement(document_, "title");
      slotTitle.textContent = `${label} · user-entered hardware label · not backend verified`;
      slot.append(
        slotTitle,
        svgElement(document_, "rect", { width: cellWidth, height: cellHeight - 5, rx: 6 }),
        svgText(document_, label.length > 12 ? `${label.slice(0, 11)}…` : label,
          cellWidth / 2, cellHeight / 2 + 2, "rd-encoder-profile-declared-label", "middle"),
      );
      svg.append(slot);
    });
  } else if (observations.length > 0) {
    observations.forEach((signal, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = 84 + column * 238;
      const y = 105 + row * 82;
      const signalNode = svgElement(document_, "g", {
        class: "rd-encoder-profile-signal",
        transform: `translate(${x} ${y})`,
        "data-observed-signal-id": signal.id,
        "data-observed-source": signal.source,
        "data-observed-emission": signal.emission,
        "aria-hidden": "true",
      });
      const signalTitle = svgElement(document_, "title");
      signalTitle.textContent = `${signal.source} emitted ${signal.emission}; no terminal association is known`;
      signalNode.append(
        signalTitle,
        svgElement(document_, "rect", { width: 196, height: 58, rx: 12 }),
        svgText(document_, signal.source.toUpperCase(), 14, 21, "rd-encoder-profile-signal-source"),
        svgText(document_, signal.emission, 14, 44, "rd-encoder-profile-signal-value"),
      );
      svg.append(signalNode);
    });
  } else {
    svg.append(
      svgElement(document_, "circle", { cx: 420, cy: 175, r: 48, class: "rd-encoder-profile-unknown-mark" }),
      svgText(document_, "?", 420, 194, "rd-encoder-profile-unknown-value", "middle"),
      svgText(document_, knownFamily ? "Verified profile rows unavailable" : "No device-scoped signals recorded", 420, 250,
        "rd-encoder-profile-empty", "middle"),
    );
  }
  svg.append(svgText(
    document_,
    knownFamily
      ? "Known family · terminal capacity not asserted"
      : declaredLabels.length > 0
      ? `${declaredLabels.length} user-entered labels · capacity and signal association still unknown`
      : `${observations.length} observed emissions · terminal capacity unknown`,
    420, 340, "rd-encoder-profile-svg-caption", "middle",
  ));
  return svg;
}

function buildSelections(connectedEncoders: readonly EncoderProfileLabDevice[] = []): LabSelection[] {
  const selections: LabSelection[] = [];
  for (const device of connectedEncoders) {
    const alias = device.alias?.trim();
    selections.push({
      // Raw selectors are backend identities and are already collision-free.
      // This value never becomes a CSS selector or durable preference.
      value: `${CONNECTED_PREFIX}${device.selector}`,
      label: `${device.name} · ${alias ? `${alias} · ` : ""}${device.selector}`,
      group: "connected",
      device,
      backend: device.backend,
      observations: [],
    });
  }
  selections.push(
    {
      value: AMBIGUOUS_SAMPLE,
      label: "Ambiguous Mini-PAC family · confirmation flow",
      group: "evidence",
      backend: {
        role: "panel-encoder",
        familyId: "ultimarc-minipac",
        familyLabel: "Ultimarc Mini-PAC family",
        profileState: "unprofiled-release",
        capabilities: { canReadChart: false },
      },
      observations: [],
    },
    {
      value: UNKNOWN_SAMPLE,
      label: "Unidentified HID signals · observation fallback",
      group: "evidence",
      backend: {
        role: "other",
        profileState: "unrecognised",
        capabilities: { canReadChart: false },
      },
      observations: UNKNOWN_SAMPLE_SIGNALS,
    },
  );
  for (const profile of listEncoderVisualProfiles()) {
    if (profile.id === "unknown-hid") continue;
    selections.push({
      value: `${CATALOG_PREFIX}${profile.id}`,
      label: `${profile.manufacturer} · ${profile.model}`,
      group: "catalog",
      profileId: profile.id,
      observations: [],
    });
  }
  return selections;
}

function selectedDetection(
  selection: LabSelection,
  confirmedCandidate?: EncoderVisualProfileId,
): EncoderDetectionResult {
  if (selection.profileId) return detectEncoderVisualProfile({ manualProfileId: selection.profileId });
  return detectEncoderVisualProfile({ backend: selection.backend, manualProfileId: confirmedCandidate });
}

function appendMetric(
  document_: Document,
  metrics: HTMLElement,
  value: string,
  label: string,
  tone: string,
): void {
  const cell = html(document_, "div", "rd-encoder-profile-metric");
  cell.dataset.tone = tone;
  const term = html(document_, "dt");
  term.textContent = label;
  const definition = html(document_, "dd");
  definition.textContent = value;
  definition.title = value;
  cell.append(term, definition);
  metrics.append(cell);
}

function appendFact(
  document_: Document,
  list: HTMLElement,
  label: string,
  value: string,
  provenance: string,
): void {
  const row = html(document_, "div", "rd-encoder-profile-fact");
  row.dataset.profileProvenance = provenance;
  const term = html(document_, "dt");
  term.textContent = label;
  const definition = html(document_, "dd");
  definition.textContent = value;
  row.append(term, definition);
  list.append(row);
}

function candidateConfirmation(
  document_: Document,
  result: EncoderDetectionResult,
  onConfirm: (profileId: EncoderVisualProfileId) => void,
): HTMLFieldSetElement | null {
  if (result.resolution !== "ambiguous-family" || result.candidates.length === 0) return null;
  const fieldset = html(document_, "fieldset", "rd-encoder-profile-candidates");
  fieldset.dataset.evidenceState = "ambiguous";
  const legend = html(document_, "legend");
  legend.textContent = "KSX knows the family, not the variant. Confirm the printed model:";
  fieldset.append(legend);
  for (const profileId of result.candidates) {
    const profile = getEncoderVisualProfile(profileId);
    const label = html(document_, "label");
    label.dataset.profileCandidate = profileId;
    const radio = html(document_, "input");
    radio.type = "radio";
    radio.name = "rd-encoder-profile-candidate";
    radio.value = profileId;
    radio.addEventListener("change", () => onConfirm(profileId));
    const copy = html(document_, "span");
    const strong = html(document_, "strong");
    strong.textContent = profile.shortLabel;
    const detail = html(document_, "small");
    detail.textContent = summarizeEncoderTopology(profile);
    copy.append(strong, detail);
    label.append(radio, copy);
    fieldset.append(label);
  }
  return fieldset;
}

function terminalRoster(document_: Document, profile: EncoderVisualProfile): HTMLDetailsElement {
  const details = html(document_, "details", "rd-encoder-profile-roster");
  details.dataset.profileId = profile.id;
  const summary = html(document_, "summary");
  summary.textContent = `Inspect profile rows · ${profile.topology.terminals.length}`;
  const list = html(document_, "div", "rd-encoder-profile-roster-grid");
  list.setAttribute("role", "list");
  for (const terminal of profile.topology.terminals) {
    const row = html(document_, "span");
    row.setAttribute("role", "listitem");
    row.dataset.terminalRosterId = terminal.id;
    const code = html(document_, "code");
    code.textContent = terminal.id;
    const label = html(document_, "span");
    label.textContent = terminal.label + (terminal.presence === "variant-only" ? " · variant only" : "");
    row.append(code, label);
    list.append(row);
  }
  details.append(summary, list);
  return details;
}

function observationRoster(
  document_: Document,
  observations: readonly ObservedSignal[],
): HTMLDetailsElement | null {
  if (observations.length === 0) return null;
  const details = html(document_, "details", "rd-encoder-profile-roster");
  details.dataset.observationSample = "true";
  const summary = html(document_, "summary");
  summary.textContent = `Inspect illustrative signal sample · ${observations.length}`;
  const list = html(document_, "div", "rd-encoder-profile-roster-grid");
  list.setAttribute("role", "list");
  for (const signal of observations) {
    const row = html(document_, "span");
    row.setAttribute("role", "listitem");
    row.dataset.observedSignalId = signal.id;
    const code = html(document_, "code");
    code.textContent = signal.emission;
    const label = html(document_, "span");
    label.textContent = `${signal.source} · terminal not associated`;
    row.append(code, label);
    list.append(row);
  }
  details.append(summary, list);
  return details;
}

function manualFallback(
  document_: Document,
  currentLabels: readonly string[],
  onApply: (labels: readonly string[]) => void,
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-manual");
  panel.dataset.manualProfileBuilder = "";
  const copy = html(document_, "div");
  const heading = html(document_, "h3");
  heading.textContent = "Build an honest fallback";
  const note = html(document_, "p");
  note.textContent =
    "Enter labels printed on the board or its manual. These become user-declared slots only; pressing buttons cannot reveal terminal capacity or wiring.";
  copy.append(heading, note);
  const field = html(document_, "label");
  field.textContent = "Printed terminal labels";
  const input = html(document_, "textarea");
  input.rows = 2;
  input.placeholder = "UP, DOWN, LEFT, RIGHT, SW1, SW2 …";
  input.value = currentLabels.join(", ");
  input.dataset.rdEncoderManualLabels = "";
  field.append(input);
  const button = html(document_, "button");
  button.type = "button";
  button.textContent = "Apply declared labels";
  button.addEventListener("click", () => {
    const seen = new Set<string>();
    const labels = input.value.split(/[\n,]+/).map((value) => value.trim()).filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 64);
    onApply(labels);
  });
  panel.append(copy, field, button);
  return panel;
}

function dynamicProfileContent(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  declaredLabels: readonly string[],
  onConfirm: (profileId: EncoderVisualProfileId) => void,
  onDeclaredLabels: (labels: readonly string[]) => void,
): HTMLElement {
  const region = html(document_, "div", "rd-encoder-profile-dynamic");
  region.dataset.rdEncoderEvidence = "";
  region.dataset.evidenceState = result.resolution;
  region.dataset.profileId = result.profile.id;
  region.dataset.profileProvenance = result.identity.source;
  const evidence = html(document_, "div", "rd-encoder-profile-evidence");
  evidence.dataset.evidenceState = result.resolution;
  const state = html(document_, "strong");
  state.textContent = resolutionLabel(result);
  const explanation = html(document_, "span");
  explanation.textContent = result.warnings[0] ?? result.profile.topology.confidenceDetail;
  evidence.append(state, explanation);
  const metrics = html(document_, "dl", "rd-encoder-profile-metrics");
  appendMetric(document_, metrics, topologyValue(result.profile), topologyUnit(result.profile),
    result.profile.topology.confidence === "unknown" ? "unknown" : "topology");
  appendMetric(document_, metrics, confidenceLabel(result.profile), "topology source", "topology");
  appendMetric(document_, metrics, protocolLabel(result), "KSX protocol", result.protocol.chartRead);
  appendMetric(document_, metrics, selection.observations.length > 0 ? String(selection.observations.length) : "None",
    "observed emissions", selection.observations.length > 0 ? "observed" : "unknown");
  const candidate = candidateConfirmation(document_, result, onConfirm);
  const work = html(document_, "div", "rd-encoder-profile-work");
  const figure = html(document_, "figure", "rd-encoder-profile-figure");
  const known = result.profile.id !== "unknown-hid" &&
    result.resolution !== "identity-conflict" && result.resolution !== "ambiguous-family";
  figure.append(known
    ? renderKnownProfileSvg(document_, result)
    : renderUnknownSvg(document_, result, selection.observations, declaredLabels));
  const caption = html(document_, "figcaption");
  caption.textContent = known
    ? "Profile-owned slots. Configuration emissions and physical wiring remain separate facts."
    : "No canonical terminal row is created until identity or user-supplied hardware labels justify one.";
  figure.append(caption);
  const facts = html(document_, "aside", "rd-encoder-profile-facts");
  const factsHeading = html(document_, "h3");
  factsHeading.textContent = "What this drawing knows";
  const factList = html(document_, "dl");
  appendFact(document_, factList, "Identity", resolutionLabel(result), result.identity.source);
  appendFact(document_, factList, "Topology", result.profile.topology.confidenceDetail,
    result.profile.topology.confidence);
  appendFact(document_, factList, "Configuration",
    result.protocol.chartRead === "supported"
      ? "Readable after an explicit user action; this lab did not read it."
      : "No configuration was read. Catalog facts never authorize a protocol.",
    result.protocol.source);
  appendFact(document_, factList, "Wiring",
    "Unknown until separately declared or observed; a configured emission does not prove a wire.",
    "not-inferred");
  if (result.profile.topology.auxiliaryCounts.length > 0) {
    appendFact(
      document_,
      factList,
      "Additional I/O",
      result.profile.topology.auxiliaryCounts.map((row) =>
        `${row.count} ${row.label}${row.sharesInputCapacity ? " (shares profile inputs)" : ""}`
      ).join(" · "),
      result.profile.topology.confidence,
    );
  }
  if (result.profile.connections.length > 0) {
    appendFact(document_, factList, "Connections", result.profile.connections.join(" · "),
      result.profile.topology.confidence);
  }
  facts.append(factsHeading, factList);
  const sourcesHeading = html(document_, "h3", "rd-encoder-profile-sources-heading");
  sourcesHeading.textContent = "Profile sources";
  const sources = html(document_, "ul", "rd-encoder-profile-sources");
  if (result.profile.sources.length === 0) {
    const empty = html(document_, "li");
    empty.textContent = result.resolution === "known-family"
      ? "No verified visual source is registered for this known family."
      : "No hardware source — unknown fallback";
    sources.append(empty);
  } else {
    for (const source of result.profile.sources) {
      const row = html(document_, "li");
      if (source.url) {
        const link = html(document_, "a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noreferrer noopener";
        link.textContent = source.title;
        row.append(link);
      } else row.textContent = `${source.title} · ${source.repositoryPath ?? "repository evidence"}`;
      sources.append(row);
    }
  }
  facts.append(sourcesHeading, sources);
  work.append(figure, facts);
  region.append(evidence, metrics);
  if (candidate) region.append(candidate);
  region.append(work);
  if (known) region.append(terminalRoster(document_, result.profile));
  else {
    const observations = observationRoster(document_, selection.observations);
    if (observations) region.append(observations);
  }
  if (result.resolution === "unrecognised" || result.resolution === "known-family") {
    region.append(manualFallback(document_, declaredLabels, onDeclaredLabels));
  }
  return region;
}

interface ProfileLabContentController {
  content: HTMLElement;
  updateConnectedEncoders: (devices: readonly EncoderProfileLabDevice[]) => void;
}

function connectedDevicesSignature(devices: readonly EncoderProfileLabDevice[]): string {
  return JSON.stringify(devices.map((device) => ({
    selector: device.selector,
    name: device.name,
    alias: device.alias ?? "",
    backend: device.backend,
  })));
}

/** Facts that can change the selected drawing or its provenance. Device-list
 * churn, labels, and aliases are deliberately excluded so an unrelated roster
 * refresh cannot rebuild the active form and erase an unapplied draft. */
function selectionEvidenceSignature(selection: LabSelection): string {
  const backend = selection.backend;
  const capabilities = backend?.capabilities;
  return JSON.stringify([
    selection.profileId ?? null,
    backend?.role ?? null,
    backend?.familyId ?? null,
    backend?.familyLabel ?? null,
    backend?.visualProfileId ?? null,
    backend?.protocolProfileId ?? null,
    backend?.profileState ?? null,
    backend?.profileTerminalCount ?? null,
    capabilities?.canIdentify ?? null,
    capabilities?.canReportMode ?? null,
    capabilities?.canReadChart ?? null,
    capabilities?.canWriteChart ?? null,
    capabilities?.writeIsPersistent ?? null,
    selection.observations.map((observation) => [
      observation.id,
      observation.source,
      observation.emission,
    ]),
  ]);
}

function createProfileLabContent(
  document_: Document,
  options: EncoderProfileLabOptions,
): ProfileLabContentController {
  let connectedSignature = connectedDevicesSignature(options.connectedEncoders ?? []);
  let selections = buildSelections(options.connectedEncoders);
  const initialCatalog = options.initialProfileId ? `${CATALOG_PREFIX}${options.initialProfileId}` : "";
  const defaultSelection = (): LabSelection | undefined =>
    selections.find((selection) => selection.group === "connected") ??
      selections.find((selection) => selection.value === `${CATALOG_PREFIX}ultimarc-ipac4`) ??
      selections[0];
  let current = selections.find((selection) => selection.value === initialCatalog) ?? defaultSelection();
  if (!current) throw new Error("encoder profile lab has no selections");
  let confirmedCandidate: EncoderVisualProfileId | undefined;
  let declaredLabels: readonly string[] = [];
  let announcementFrame = 0;
  const content = html(document_, "section", "rd-encoder-profile");
  content.dataset.formaRuntimeHost = "";
  content.dataset.rdEncoderLab = "";
  const header = html(document_, "header", "rd-encoder-profile-head");
  const headingCopy = html(document_, "div", "rd-encoder-profile-heading-copy");
  const eyebrow = html(document_, "p", "rd-encoder-profile-eyebrow");
  eyebrow.textContent = "Encoder profile lab · research-backed preview";
  const title = html(document_, "h2", "rd-encoder-profile-title");
  const subtitle = html(document_, "p", "rd-encoder-profile-subtitle");
  headingCopy.append(eyebrow, title, subtitle);
  const safety = html(document_, "span", "rd-encoder-profile-safety");
  safety.textContent = "No hardware read or write";
  header.append(headingCopy, safety);
  const toolbar = html(document_, "div", "rd-encoder-profile-toolbar");
  const field = html(document_, "label");
  field.textContent = "Profile or evidence case";
  const select = html(document_, "select");
  select.dataset.rdEncoderModel = "";
  const groupLabels: Record<LabSelection["group"], string> = {
    connected: "Connected encoders", evidence: "Evidence behavior", catalog: "Reference profiles",
  };
  const repaintOptions = (): void => {
    select.replaceChildren();
    for (const groupName of ["connected", "evidence", "catalog"] as const) {
      const choices = selections.filter((selection) => selection.group === groupName);
      if (choices.length === 0) continue;
      const group = document_.createElement("optgroup");
      group.label = groupLabels[groupName];
      for (const choice of choices) {
        const option = document_.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        option.title = choice.label;
        group.append(option);
      }
      select.append(group);
    }
    select.value = current.value;
  };
  repaintOptions();
  field.append(select);
  const thesis = html(document_, "p", "rd-encoder-profile-thesis");
  thesis.textContent = "Board terminal → configured emission → observed signal. Three facts; never one guessed map.";
  toolbar.append(field, thesis);
  const dynamicHost = html(document_, "div", "rd-encoder-profile-host");
  const liveStatus = html(document_, "span", "n-live-sr");
  liveStatus.dataset.rdEncoderStatus = "";
  liveStatus.setAttribute("role", "status");
  liveStatus.setAttribute("aria-live", "polite");
  liveStatus.setAttribute("aria-atomic", "true");
  const announce = (message: string): void => {
    const view = document_.defaultView;
    if (!view) {
      liveStatus.textContent = message;
      return;
    }
    if (announcementFrame) view.cancelAnimationFrame(announcementFrame);
    liveStatus.textContent = "";
    announcementFrame = view.requestAnimationFrame(() => {
      announcementFrame = 0;
      liveStatus.textContent = message;
    });
  };
  const paintHeader = (result: EncoderDetectionResult): void => {
    title.textContent = result.profile.id === "unknown-hid"
      ? current.device?.name ?? result.identity.familyLabel ?? result.profile.model
      : `${result.profile.manufacturer} ${result.profile.model}`;
    subtitle.textContent = result.resolution === "ambiguous-family" ||
        result.resolution === "known-family" || result.resolution === "identity-conflict"
      ? result.warnings[0] ?? result.profile.summary
      : result.profile.summary;
    content.dataset.profileId = result.profile.id;
    content.dataset.evidenceState = result.resolution;
  };
  const repaint = (): void => {
    const result = selectedDetection(current, confirmedCandidate);
    paintHeader(result);
    dynamicHost.replaceChildren(dynamicProfileContent(
      document_, result, current, declaredLabels,
      (profileId) => {
        confirmedCandidate = profileId;
        repaint();
        document_.defaultView?.requestAnimationFrame(() => {
          select.focus({ preventScroll: true });
        });
      },
      (labels) => {
        declaredLabels = labels;
        repaint();
        document_.defaultView?.requestAnimationFrame(() => {
          dynamicHost.querySelector<HTMLTextAreaElement>("[data-rd-encoder-manual-labels]")
            ?.focus({ preventScroll: true });
        });
      },
    ));
    announce(`${resolutionLabel(result)}. ${result.warnings[0] ?? result.profile.topology.confidenceDetail}`);
  };
  select.addEventListener("change", () => {
    const next = selections.find((selection) => selection.value === select.value);
    if (!next) return;
    current = next;
    confirmedCandidate = undefined;
    declaredLabels = [];
    if (current.profileId) options.onProfileChange?.(current.profileId);
    repaint();
  });
  const footer = html(document_, "footer", "rd-encoder-profile-foot");
  footer.textContent =
    "Catalog preview only. KSX control assignment comes later; this surface stops at hardware topology and emitted input facts.";
  content.append(header, toolbar, dynamicHost, footer, liveStatus);
  repaint();
  return {
    content,
    updateConnectedEncoders: (devices) => {
      const nextSignature = connectedDevicesSignature(devices);
      if (nextSignature === connectedSignature) return;
      connectedSignature = nextSignature;
      const previousValue = current.value;
      const previousEvidence = selectionEvidenceSignature(current);
      selections = buildSelections(devices);
      const replacement = selections.find((selection) => selection.value === previousValue) ??
        defaultSelection();
      if (!replacement) return;
      const selectionChanged = replacement.value !== previousValue;
      const evidenceChanged = selectionEvidenceSignature(replacement) !== previousEvidence;
      current = replacement;
      if (selectionChanged || evidenceChanged) {
        confirmedCandidate = undefined;
        declaredLabels = [];
      }
      repaintOptions();
      if (selectionChanged || evidenceChanged) repaint();
      else paintHeader(selectedDetection(current, confirmedCandidate));
    },
  };
}

export function createEncoderProfileLabCanvasItem(
  document_: Document,
  options: EncoderProfileLabOptions = {},
): EncoderProfileLabCanvasItem {
  const lab = createProfileLabContent(document_, options);
  const item = createCanvasItem({
    instanceId: ENCODER_PROFILE_LAB_INSTANCE_ID,
    displayName: "Encoder profile lab",
    preferredWidth: LAB_HOME.width,
    minHeight: LAB_HOME.height,
    resizable: false,
    content: lab.content,
    document: document_,
  });
  item.classList.add("rd-encoder-profile-node");
  // This review surface swaps between very different evidence layouts. Give
  // the non-resizable item a definite block size so its internal scroll host,
  // rather than the canvas geometry, absorbs those content changes.
  item.style.height = `${LAB_HOME.height}px`;
  item.dataset.clientWidget = "";
  item.dataset.prototype = "true";
  return {
    item,
    home: { ...LAB_HOME },
    updateConnectedEncoders: lab.updateConnectedEncoders,
  };
}
