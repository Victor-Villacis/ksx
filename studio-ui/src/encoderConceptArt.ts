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
import {
  encoderChartShiftSentence,
  encoderChartTerminalMap,
  encoderEmissionLabel,
  encoderEmissionShortLabel,
  requestEncoderChart,
  validateEncoderChart,
  type EncoderChartSnapshot,
} from "./encoderChartRead";
import {
  ENCODER_OBSERVATION_POLL_MS,
  cancelEncoderObservation,
  observationBelongsTo,
  pollEncoderObservation,
  startEncoderObservation,
  type EncoderObservationView,
} from "./encoderSignalObservation";

/** One stable canvas node. Profile changes repaint it; they never move it. */
export const ENCODER_PROFILE_LAB_INSTANCE_ID = "encoder-profile-lab";

const encoderProfileLabDisposers = new WeakMap<HTMLElement, () => void>();

/** Release resources for the exact mounted lab item. Keeping lifecycle
 * ownership on the item avoids a module-global callback drifting away from a
 * remounted review surface. Safe to call more than once. */
export function disposeEncoderProfileLabCanvasItem(item: HTMLElement): void {
  const dispose = encoderProfileLabDisposers.get(item);
  if (!dispose) return;
  encoderProfileLabDisposers.delete(item);
  dispose();
}

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
  dispose: () => void;
}

interface ObservedSignal {
  id: string;
  source: string;
  emission: string;
  provenance?: string;
}

type ChartReadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; snapshot: EncoderChartSnapshot }
  | { kind: "error"; message: string };

type SignalObservationState =
  | { kind: "idle" }
  | { kind: "reconciling" }
  | { kind: "starting" }
  | { kind: "listening"; view: EncoderObservationView }
  | { kind: "stopping"; view: EncoderObservationView }
  | { kind: "complete"; view: EncoderObservationView }
  | { kind: "unknown"; view: EncoderObservationView; message: string }
  | { kind: "foreign-live"; message: string }
  | { kind: "error"; message: string };

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

function renderKnownProfileSvg(
  document_: Document,
  result: EncoderDetectionResult,
  chart: EncoderChartSnapshot | null,
): SVGSVGElement {
  const profile = result.profile;
  const chartByTerminal = encoderChartTerminalMap(chart);
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
      const configured = chartByTerminal.get(terminal.id);
      const column = index % columns;
      const row = Math.floor(index / columns);
      const cellWidth = Math.max(22, Math.min(34, stepX - 4));
      const cellHeight = Math.max(17, Math.min(23, stepY - 4));
      const x = 10 + column * stepX + (stepX - cellWidth) / 2;
      const y = 25 + row * stepY + (stepY - cellHeight) / 2;
      const terminalNode = svgElement(document_, "g", {
        class: `rd-encoder-profile-terminal is-${terminal.identityScope}` +
          (terminal.presence === "variant-only" ? " is-variant" : "") +
          (configured ? " has-configured-emission" : "") +
          (configured && !configured.normal.supported ? " is-opaque-emission" : "") +
          (configured?.normal.supported && configured.normal.code === 0 ? " is-zero-emission" : ""),
        transform: `translate(${x} ${y})`,
        "data-terminal-id": terminal.id,
        "data-terminal-label": terminal.label,
        "data-identity-scope": terminal.identityScope,
        "data-connection": terminal.connection,
        "data-presence": terminal.presence,
        "data-source-refs": terminal.sourceRefs.join(" "),
        ...(configured ? {
          "data-configured-emission": encoderEmissionLabel(configured.normal),
          "data-configured-code": configured.normal.code,
        } : {}),
        "aria-hidden": "true",
      });
      const terminalTitle = svgElement(document_, "title");
      terminalTitle.textContent = `${terminal.label} · ${terminal.identityScope.replace("-", " ")}` +
        (terminal.presence === "variant-only" ? " · variant only" : "") +
        (configured ? ` · configured emission: ${encoderEmissionLabel(configured.normal)}` : "");
      terminalNode.append(
        terminalTitle,
        svgElement(document_, "rect", { width: cellWidth, height: cellHeight, rx: 4 }),
        svgText(document_, terminalShortLabel(terminal), cellWidth / 2,
          configured ? 9 : cellHeight / 2 + 3.5,
          "rd-encoder-profile-terminal-label", "middle"),
      );
      if (configured) {
        terminalNode.append(svgText(
          document_, encoderEmissionShortLabel(configured.normal), cellWidth / 2, cellHeight - 3,
          "rd-encoder-profile-terminal-emission", "middle",
        ));
      }
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
    chart
      ? `${profile.topology.terminals.length} terminal rows · configured emissions read now · wiring still not inferred`
      : `${confidenceLabel(profile)} · ${profile.topology.terminals.length} visible rows · wiring state not inferred`,
    420, 344, "rd-encoder-profile-svg-caption", "middle",
  ));
  return svg;
}

function renderUnknownSvg(
  document_: Document,
  result: EncoderDetectionResult,
  observations: readonly ObservedSignal[],
  declaredLabels: readonly string[],
  observationsAreLive: boolean,
): SVGSVGElement {
  const profile = getEncoderVisualProfile("unknown-hid");
  const knownFamily = result.resolution === "known-family";
  const compactSignalCount = Math.min(observations.length, 9);
  const compactSignalQualifier = observations.length > compactSignalCount
    ? ` The compact diagram shows the first ${compactSignalCount}; the complete evidence list remains available below.`
    : "";
  const description = knownFamily
    ? "The backend family identity is known, but no verified terminal roster or physical topology is registered."
    : declaredLabels.length > 0
    ? `${declaredLabels.length} user-entered hardware labels are shown. Capacity and association with observed signals remain unknown.`
    : observationsAreLive
      ? `${observations.length} exact-device host emissions are available.${compactSignalQualifier} No terminal count, PCB topology, wiring, or control association is inferred.`
      : `${observations.length} illustrative device emissions are available.${compactSignalQualifier} No terminal count, PCB topology, wiring, or control association is inferred.`;
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
  svg.dataset.hiddenObservedCount = String(Math.max(0, observations.length - compactSignalCount));
  svg.dataset.observationKind = observationsAreLive ? "exact-device" : "illustrative";
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
    const visibleSignals = observations.slice(0, 9);
    const hiddenSignalCount = observations.length - visibleSignals.length;
    visibleSignals.forEach((signal, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = 84 + column * 238;
      const y = 94 + row * 66;
      const signalNode = svgElement(document_, "g", {
        class: "rd-encoder-profile-signal",
        transform: `translate(${x} ${y})`,
        "data-observed-signal-id": signal.id,
        "data-observed-source": signal.source,
        "data-observed-emission": signal.emission,
        ...(signal.provenance ? { "data-observed-provenance": signal.provenance } : {}),
        "aria-hidden": "true",
      });
      const signalTitle = svgElement(document_, "title");
      signalTitle.textContent = `${signal.source} emitted ${signal.emission}; no terminal association is known` +
        (signal.provenance ? ` · exact selector ${signal.provenance}` : "");
      signalNode.append(
        signalTitle,
        svgElement(document_, "rect", { width: 196, height: 50, rx: 12 }),
        svgText(document_, signal.source.toUpperCase(), 14, 18, "rd-encoder-profile-signal-source"),
        svgText(document_, signal.emission, 14, 38, "rd-encoder-profile-signal-value"),
      );
      svg.append(signalNode);
    });
    if (hiddenSignalCount > 0) {
      svg.append(svgText(
        document_,
        `+${hiddenSignalCount} more signal${hiddenSignalCount === 1 ? "" : "s"} in the evidence list`,
        420, 302, "rd-encoder-profile-empty", "middle",
      ));
    }
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
      : `${observations.length} ${observationsAreLive ? "observed" : "illustrative"} emissions · terminal capacity unknown`,
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

function terminalRoster(
  document_: Document,
  profile: EncoderVisualProfile,
  chart: EncoderChartSnapshot | null,
): HTMLDetailsElement {
  const details = html(document_, "details", "rd-encoder-profile-roster");
  details.dataset.profileId = profile.id;
  if (chart) details.dataset.chartLoaded = "true";
  const summary = html(document_, "summary");
  summary.textContent = chart
    ? `Inspect terminal emissions · ${profile.topology.terminals.length}`
    : `Inspect profile rows · ${profile.topology.terminals.length}`;
  if (chart) {
    const byTerminal = encoderChartTerminalMap(chart);
    const table = html(document_, "table", "rd-encoder-profile-chart-table");
    const caption = html(document_, "caption");
    caption.textContent = "Exact profile terminal identity and the emissions stored in the latest explicit read";
    const head = html(document_, "thead");
    const headingRow = html(document_, "tr");
    for (const value of ["Terminal", "Printed label", "Normal emission", "Shifted emission"]) {
      const cell = html(document_, "th");
      cell.scope = "col";
      cell.textContent = value;
      headingRow.append(cell);
    }
    head.append(headingRow);
    const body = html(document_, "tbody");
    for (const terminal of profile.topology.terminals) {
      const configured = byTerminal.get(terminal.id);
      if (!configured) continue;
      const row = html(document_, "tr");
      row.dataset.terminalRosterId = terminal.id;
      row.dataset.rdEncoderChartRow = "";
      if (!configured.normal.supported) row.dataset.unknownByte = "";
      if (configured.normal.supported && configured.normal.code === 0) row.dataset.zeroByte = "";
      const idCell = html(document_, "th");
      idCell.scope = "row";
      const code = html(document_, "code");
      code.textContent = terminal.id;
      idCell.append(code);
      const labelCell = html(document_, "td");
      labelCell.textContent = terminal.label;
      const normalCell = html(document_, "td");
      normalCell.textContent = encoderEmissionLabel(configured.normal);
      const shiftedCell = html(document_, "td");
      shiftedCell.textContent = encoderEmissionLabel(configured.shifted);
      row.append(idCell, labelCell, normalCell, shiftedCell);
      body.append(row);
    }
    table.append(caption, head, body);
    const tableScroll = html(document_, "div", "rd-encoder-profile-chart-scroll");
    tableScroll.tabIndex = 0;
    tableScroll.setAttribute("role", "region");
    tableScroll.setAttribute("aria-label", "Configured terminal emissions");
    tableScroll.append(table);
    details.append(summary, tableScroll);
    return details;
  }
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
  observationsAreLive: boolean,
): HTMLDetailsElement | null {
  if (observations.length === 0) return null;
  const details = html(document_, "details", "rd-encoder-profile-roster");
  details.dataset.observationSample = String(!observationsAreLive);
  const summary = html(document_, "summary");
  summary.textContent = `${observationsAreLive ? "Inspect observed host signals" : "Inspect illustrative signal sample"} · ${observations.length}`;
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

function chartReadPanel(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  state: ChartReadState,
  observationBlock: SignalObservationState["kind"] | null,
  onRead: () => void,
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-read");
  panel.dataset.rdEncoderChart = "";
  panel.dataset.state = state.kind;
  const copy = html(document_, "div", "rd-encoder-profile-read-copy");
  const heading = html(document_, "h3");
  heading.textContent = "Configured emissions";
  const description = html(document_, "p");
  const canRead = chartReadIsAdmitted(result, selection);
  description.textContent = canRead
    ? "Ask this exact board what each terminal is configured to emit. Read only: this does not map controls, write firmware, or prove a wire."
    : selection.device
      ? "This exact release has no admitted KSX chart reader. Its sourced topology remains visible, but no stored emissions are guessed."
      : "Connect an exact backend-supported board to read stored emissions. Catalog profiles never authorize a hardware protocol.";
  copy.append(heading, description);

  const controls = html(document_, "div", "rd-encoder-profile-read-controls");
  if (canRead) {
    const button = html(document_, "button");
    button.type = "button";
    button.dataset.rdEncoderRead = "";
    button.disabled = state.kind === "loading" || observationBlock !== null;
    button.textContent = observationBlock !== null
      ? observationBlock === "listening" || observationBlock === "unknown" ||
          observationBlock === "stopping"
        ? "Stop observation first"
        : observationBlock === "foreign-live"
          ? "Observation lease busy"
          : "Wait for observation"
      : state.kind === "loading"
      ? "Reading…"
      : state.kind === "loaded" ? "Read again" : "Read configured emissions";
    button.addEventListener("click", onRead);
    controls.append(button);
  }

  const status = html(document_, "div", "rd-encoder-profile-read-status");
  status.dataset.rdEncoderChartStatus = "";
  status.dataset.state = state.kind;
  if (state.kind === "loading") {
    status.textContent = "Reading this board’s configuration…";
  } else if (state.kind === "error") {
    status.textContent = state.message;
  } else if (state.kind === "loaded") {
    const headline = html(document_, "strong");
    headline.textContent = `Read ${state.snapshot.terminals.length} exact terminals from ${state.snapshot.boardName}.`;
    const freshness = html(document_, "p");
    const time = html(document_, "time");
    time.dateTime = state.snapshot.readAt;
    const readDate = new Date(state.snapshot.readAt);
    time.textContent = Number.isNaN(readDate.getTime())
      ? "Read this session"
      : `Read at ${readDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    time.title = state.snapshot.readAt;
    freshness.append(
      time,
      document_.createTextNode(
        ` · proof ${state.snapshot.imageSha256.slice(0, 16)} · not watched; read again after WinIPAC changes.`,
      ),
    );
    const shift = html(document_, "p");
    shift.textContent = encoderChartShiftSentence(state.snapshot.shift);
    status.append(headline, freshness, shift);
    if (state.snapshot.notes.length > 0) {
      const notes = html(document_, "ul");
      for (const value of state.snapshot.notes) {
        const note = html(document_, "li");
        note.textContent = value;
        notes.append(note);
      }
      status.append(notes);
    }
  } else {
    status.textContent = canRead
      ? "Not read. Opening this lab never talks to encoder configuration hardware."
      : "No configuration read is available for this selection.";
  }
  controls.append(status);
  panel.append(copy, controls);
  return panel;
}

function chartReadIsAdmitted(
  result: EncoderDetectionResult,
  selection: LabSelection,
): boolean {
  return Boolean(
    selection.device &&
    result.profile.id !== "unknown-hid" &&
    (result.resolution === "backend-exact" || result.resolution === "backend-family") &&
    result.protocol.chartRead === "supported",
  );
}

function observationView(state: SignalObservationState): EncoderObservationView | null {
  switch (state.kind) {
    case "listening":
    case "stopping":
    case "complete":
    case "unknown": return state.view;
    default: return null;
  }
}

function observationProvesReplacement(
  view: EncoderObservationView,
  selector: string,
  generation: number,
): boolean {
  return view.selector !== null && view.generation !== null &&
    !observationBelongsTo(view, selector, generation);
}

function observedSignals(
  selection: LabSelection,
  state: SignalObservationState,
): readonly ObservedSignal[] {
  const view = observationView(state);
  if (!view) return selection.observations;
  return view.seen.map((emission, index) => ({
    id: `observed-${index + 1}`,
    source: selection.device?.name ?? "Selected device",
    emission,
    ...(selection.device ? { provenance: selection.device.selector } : {}),
  }));
}

function appendObservationSignals(
  document_: Document,
  container: HTMLElement,
  values: readonly string[],
): void {
  if (values.length === 0) {
    const empty = html(document_, "span");
    empty.textContent = "None";
    empty.dataset.empty = "true";
    container.append(empty);
    return;
  }
  for (const value of values) {
    const chip = html(document_, "code");
    chip.textContent = value;
    container.append(chip);
  }
}

function paintSignalObservationStatus(
  document_: Document,
  status: HTMLElement,
  selection: LabSelection,
  state: SignalObservationState,
): void {
  status.replaceChildren();
  status.dataset.state = state.kind;
  const view = observationView(state);
  if (state.kind === "reconciling") {
    status.textContent = "Checking whether the daemon already owns an observation…";
  } else if (state.kind === "starting") {
    status.textContent = "Asking the daemon to listen to this exact device…";
  } else if (state.kind === "error") {
    status.textContent = `Signal observation unavailable — ${state.message}`;
  } else if (state.kind === "foreign-live") {
    status.textContent = state.message;
  } else if (state.kind === "unknown") {
    const warning = html(document_, "p", "rd-encoder-profile-observe-warning");
    warning.textContent = state.message;
    status.append(warning);
  }
  if (view) {
    const headline = html(document_, "strong");
    headline.textContent = state.kind === "listening"
      ? `Listening${view.remaining_ms === null ? "" : ` · ${Math.max(0, Math.ceil(view.remaining_ms / 1000))}s remaining`}`
      : state.kind === "stopping" ? "Stopping this exact observation…"
      : `${view.seen.length} unique host signal${view.seen.length === 1 ? "" : "s"} observed.`;
    const detail = html(document_, "p");
    detail.textContent = view.error || view.detail ||
      "Duplicate terminal assignments collapse to one signal; no terminal association is inferred.";
    const metrics = html(document_, "dl", "rd-encoder-profile-observe-metrics");
    for (const [label, value] of [
      ["Peak held", view.peak],
      ["Events", view.events],
      ["Dropped", view.dropped],
    ] as const) {
      const metric = html(document_, "div");
      const term = html(document_, "dt");
      term.textContent = label;
      const definition = html(document_, "dd");
      definition.textContent = String(value);
      metric.append(term, definition);
      metrics.append(metric);
    }
    const signalRows = html(document_, "div", "rd-encoder-profile-observe-signals");
    const heldRow = html(document_, "div");
    const heldLabel = html(document_, "span");
    heldLabel.textContent = state.kind === "listening"
      ? "Held now"
      : state.kind === "complete"
      ? "Held at final snapshot"
      : "Held at last confirmed snapshot";
    const held = html(document_, "div");
    held.dataset.rdEncoderObservedHeld = "";
    appendObservationSignals(document_, held, view.held);
    heldRow.append(heldLabel, held);
    const seenRow = html(document_, "div");
    const seenLabel = html(document_, "span");
    seenLabel.textContent = "Unique seen";
    const seen = html(document_, "div");
    seen.dataset.rdEncoderObservedSeen = "";
    appendObservationSignals(document_, seen, view.seen);
    seenRow.append(seenLabel, seen);
    signalRows.append(heldRow, seenRow);
    status.append(headline, detail, metrics, signalRows);
    const provenance = html(document_, "p", "rd-encoder-profile-observe-provenance");
    provenance.textContent = `Exact selector: ${view.selector ?? selection.device?.selector ?? "unavailable"} · terminal association: none · rollover visibility: ${view.rollover_visibility || "unavailable"}.`;
    status.append(provenance);
    if (view.dropped > 0) {
      const warning = html(document_, "p", "rd-encoder-profile-observe-warning");
      warning.textContent = `KSX dropped ${view.dropped} event${view.dropped === 1 ? "" : "s"}; repeat this run before judging the device.`;
      status.append(warning);
    }
    if (view.state === "failed") {
      const warning = html(document_, "p", "rd-encoder-profile-observe-warning");
      warning.textContent = "The observer failed. Counts above are partial evidence, not a completed run.";
      status.append(warning);
    }
  } else if (state.kind === "idle") {
    status.textContent = selection.device
      ? "Not listening. Opening or changing this lab never starts input capture."
      : "No live device is selected.";
  }
}

function signalObservationPanel(
  document_: Document,
  selection: LabSelection,
  state: SignalObservationState,
  blockedByChart: boolean,
  onStart: () => void,
  onStop: () => void,
  onEscapeCapture: () => void,
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-observe");
  panel.dataset.rdEncoderObservation = "";
  panel.dataset.state = state.kind;
  const currentView = observationView(state);
  if (currentView) panel.dataset.backendState = currentView.state;
  if (selection.device) panel.dataset.selector = selection.device.selector;
  const copy = html(document_, "div", "rd-encoder-profile-observe-copy");
  const heading = html(document_, "h3");
  heading.textContent = "Observed host signals";
  const description = html(document_, "p");
  description.textContent = selection.device
    ? "Listen to this exact device for 30 seconds. Signals are device-scoped evidence—not terminals, wiring, capacity, or a KSX mapping. Tab stays inside Capture/Done; Ctrl/Cmd+Enter activates Done; Esc leaves Capture without stopping. Windows and system shortcuts can still escape."
    : "Choose a connected encoder to observe what reaches Windows. Reference profiles cannot emit live evidence.";
  copy.append(heading, description);
  panel.append(copy);

  const controls = html(document_, "div", "rd-encoder-profile-observe-controls");
  if (selection.device) {
    const listening = state.kind === "listening" || state.kind === "unknown";
    const captureActive = listening || state.kind === "starting" || state.kind === "stopping";
    const actions = html(document_, "div", "rd-encoder-profile-observe-actions");
    const start = html(document_, "button");
    start.type = "button";
    start.dataset.rdEncoderObserve = "start";
    start.disabled = state.kind === "reconciling" || state.kind === "starting" ||
      state.kind === "stopping" || listening || blockedByChart;
    start.textContent = blockedByChart
      ? "Wait for chart read"
      : state.kind === "reconciling"
      ? "Checking…"
      : state.kind === "starting"
      ? "Starting…"
      : state.kind === "foreign-live"
        ? "Recheck observation lease"
        : state.kind === "complete"
          ? "Check and observe again" : "Observe emitted signals";
    start.addEventListener("click", onStart);
    actions.append(start);
    const sink = html(document_, "div", "rd-encoder-profile-observe-sink");
    sink.tabIndex = captureActive ? 0 : -1;
    sink.dataset.rdEncoderObservationSink = "";
    sink.setAttribute("role", "group");
    sink.hidden = !captureActive;
    sink.textContent = state.kind === "starting" ? "Preparing capture focus" :
      captureActive ? "Capture focus" : "";
    sink.setAttribute("aria-label", captureActive
      ? "Encoder observation capture. Tab cycles between capture and Done. Control or Command plus Enter activates Done."
      : "Encoder observation inactive.");
    actions.append(sink);
    let stop: HTMLButtonElement | null = null;
    if (listening) {
      stop = html(document_, "button");
      stop.type = "button";
      stop.dataset.rdEncoderObserve = "stop";
      stop.textContent = "Done — stop listening";
      stop.title = "Stop this exact observation (Ctrl/Cmd+Enter from keyboard)";
      stop.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
      stop.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onStop();
      });
      stop.addEventListener("click", onStop);
      actions.append(stop);
    }
    if (captureActive) {
      controls.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          onEscapeCapture();
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopImmediatePropagation();
          const destination = event.shiftKey
            ? event.target === sink ? stop ?? sink : sink
            : event.target === stop ? sink : stop ?? sink;
          destination.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && event.target === stop) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true });
    }
    controls.append(actions);
  }
  const status = html(document_, "div", "rd-encoder-profile-observe-status");
  status.dataset.rdEncoderObservationStatus = "";
  paintSignalObservationStatus(document_, status, selection, state);
  controls.append(status);
  panel.append(controls);
  return panel;
}

function dynamicProfileContent(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  declaredLabels: readonly string[],
  chartState: ChartReadState,
  observationState: SignalObservationState,
  onConfirm: (profileId: EncoderVisualProfileId) => void,
  onDeclaredLabels: (labels: readonly string[]) => void,
  onReadChart: () => void,
  onStartObservation: () => void,
  onStopObservation: () => void,
  onEscapeObservationCapture: () => void,
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
  const signals = observedSignals(selection, observationState);
  const observationsAreLive = observationView(observationState) !== null;
  appendMetric(
    document_,
    metrics,
    signals.length > 0 ? String(signals.length) : "None",
    observationsAreLive
      ? "observed host signals"
      : signals.length > 0 ? "illustrative signal sample" : "observed host signals",
    observationsAreLive ? "observed" : "unknown",
  );
  const candidate = candidateConfirmation(document_, result, onConfirm);
  const chart = chartState.kind === "loaded" ? chartState.snapshot : null;
  const observationBusy = observationState.kind === "reconciling" ||
    observationState.kind === "starting" || observationState.kind === "listening" ||
    observationState.kind === "stopping" || observationState.kind === "unknown" ||
    observationState.kind === "foreign-live";
  const chartPanel = chartReadPanel(
    document_, result, selection, chartState,
    observationBusy ? observationState.kind : null,
    onReadChart,
  );
  const observationPanel = signalObservationPanel(
    document_, selection, observationState, chartState.kind === "loading",
    onStartObservation, onStopObservation, onEscapeObservationCapture,
  );
  const work = html(document_, "div", "rd-encoder-profile-work");
  const figure = html(document_, "figure", "rd-encoder-profile-figure");
  const known = result.profile.id !== "unknown-hid" &&
    result.resolution !== "identity-conflict" && result.resolution !== "ambiguous-family";
  figure.append(known
    ? renderKnownProfileSvg(document_, result, chart)
    : renderUnknownSvg(document_, result, signals, declaredLabels, observationsAreLive));
  const caption = html(document_, "figcaption");
  caption.textContent = known
    ? chart
      ? "Profile-owned terminal identity with one fresh configuration read. Physical wiring remains a separate, unknown fact."
      : "Profile-owned slots. Configuration emissions and physical wiring remain separate facts."
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
    chart
      ? `${chart.terminals.length} stored normal and shifted emissions read explicitly; proof ${chart.imageSha256.slice(0, 16)}.`
      : result.protocol.chartRead === "supported"
      ? "Readable after an explicit user action; this lab did not read it."
      : "No configuration was read. Catalog facts never authorize a protocol.",
    chart ? "fresh-chart-read" : result.protocol.source);
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
  region.append(chartPanel);
  region.append(observationPanel);
  region.append(work);
  if (known) region.append(terminalRoster(document_, result.profile, chart));
  else {
    const observations = observationRoster(document_, signals, observationsAreLive);
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
  dispose: () => void;
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
  let chartState: ChartReadState = { kind: "idle" };
  let chartRequestEpoch = 0;
  let observationState: SignalObservationState = { kind: "idle" };
  let observationOwnership: { selector: string; generation: number } | null = null;
  let observationRequestEpoch = 0;
  let observationPollTimer: number | undefined;
  let pageHiding = false;
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
  safety.textContent = "Explicit reads only · never writes";
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
      document_, result, current, declaredLabels, chartState, observationState,
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
      () => { void readCurrentChart(); },
      () => { void startCurrentObservation(); },
      () => { void stopCurrentObservation(); },
      () => {
        if (observationState.kind === "starting") {
          observationRequestEpoch += 1;
          clearObservationPoll();
          observationState = {
            kind: "error",
            message: "Capture focus was released while start is still resolving. KSX will release any exact generation returned by that request.",
          };
          repaint();
          announce("Capture focus released. Any late exact start generation will be cancelled.");
          focusObservationStart();
          return;
        }
        if (observationState.kind === "stopping") {
          const owned = observationState.view;
          observationRequestEpoch += 1;
          clearObservationPoll();
          observationState = {
            kind: "unknown",
            view: owned,
            message: `Capture focus was released while generation ${owned.generation ?? "unknown"} is stopping. Exact Stop remains available for retry.`,
          };
          repaint();
          announce("Capture focus released. Exact Stop remains available for retry.");
        } else {
          announce("Capture focus released. The exact observation continues until Done or timeout.");
        }
        select.focus({ preventScroll: true });
      },
    ));
    announce(`${resolutionLabel(result)}. ${result.warnings[0] ?? result.profile.topology.confidenceDetail}`);
  };
  const clearObservationPoll = (): void => {
    const view = document_.defaultView;
    if (observationPollTimer !== undefined && view) view.clearTimeout(observationPollTimer);
    observationPollTimer = undefined;
  };
  const patchObservationSurface = (): void => {
    const panel = dynamicHost.querySelector<HTMLElement>("[data-rd-encoder-observation]");
    const status = panel?.querySelector<HTMLElement>("[data-rd-encoder-observation-status]");
    if (!panel || !status) return;
    panel.dataset.state = observationState.kind;
    const currentView = observationView(observationState);
    if (currentView) panel.dataset.backendState = currentView.state;
    else delete panel.dataset.backendState;
    paintSignalObservationStatus(document_, status, current, observationState);
    const start = panel.querySelector<HTMLButtonElement>('[data-rd-encoder-observe="start"]');
    const stop = panel.querySelector<HTMLButtonElement>('[data-rd-encoder-observe="stop"]');
    const listening = observationState.kind === "listening" || observationState.kind === "unknown";
    if (start) start.disabled = listening || observationState.kind === "reconciling" ||
      observationState.kind === "starting" || observationState.kind === "stopping" ||
      chartState.kind === "loading";
    if (stop) {
      stop.disabled = observationState.kind === "stopping";
      stop.textContent = observationState.kind === "stopping"
        ? "Stopping…" : "Done — stop listening";
    }
  };
  const focusObservationSink = (): void => {
    dynamicHost.querySelector<HTMLElement>("[data-rd-encoder-observation-sink]")
      ?.focus({ preventScroll: true });
  };
  const focusObservationStart = (): void => {
    document_.defaultView?.requestAnimationFrame(() => {
      dynamicHost.querySelector<HTMLButtonElement>('[data-rd-encoder-observe="start"]')
        ?.focus({ preventScroll: true });
    });
  };
  const ownedObservation = (): EncoderObservationView | null => {
    const ownership = observationOwnership;
    if (!ownership) return null;
    if (observationState.kind !== "listening" && observationState.kind !== "unknown" &&
        observationState.kind !== "stopping") return null;
    const view = observationState.view;
    return observationBelongsTo(view, ownership.selector, ownership.generation) ? view : null;
  };
  const releaseObservation = (keepalive = false): void => {
    const owned = observationOwnership;
    observationOwnership = null;
    observationRequestEpoch += 1;
    clearObservationPoll();
    observationState = { kind: "idle" };
    if (owned) {
      void cancelEncoderObservation(owned.generation, fetch, keepalive).catch(() => undefined);
    }
  };
  const scheduleObservationPoll = (epoch: number, selector: string, generation: number): void => {
    const view = document_.defaultView;
    if (!view) return;
    clearObservationPoll();
    observationPollTimer = view.setTimeout(() => {
      observationPollTimer = undefined;
      void pollCurrentObservation(epoch, selector, generation);
    }, ENCODER_OBSERVATION_POLL_MS);
  };
  const pollCurrentObservation = async (
    epoch: number,
    selector: string,
    generation: number,
  ): Promise<void> => {
    const previous = observationState.kind === "listening" ? observationState.view : null;
    try {
      const view = await pollEncoderObservation();
      if (epoch !== observationRequestEpoch || current.value !== `${CONNECTED_PREFIX}${selector}`) return;
      if (observationProvesReplacement(view, selector, generation)) {
        observationOwnership = null;
        observationState = {
          kind: "foreign-live",
          message: "Another window or diagnostic replaced this observation. KSX will not stop or reuse that foreign generation.",
        };
        repaint();
        announce(`Observation ownership changed — ${observationState.message}`);
        focusObservationStart();
        return;
      }
      if (observationBelongsTo(view, selector, generation) &&
          view.state === "listening" && view.ok) {
        observationState = { kind: "listening", view };
        patchObservationSurface();
        scheduleObservationPoll(epoch, selector, generation);
        return;
      }
      if (observationBelongsTo(view, selector, generation) &&
          (view.state === "timeout" || view.state === "cancelled" || view.state === "failed")) {
        observationOwnership = null;
        observationState = { kind: "complete", view };
        repaint();
        announce(view.state === "failed"
          ? "Signal observation failed; partial evidence remains visible."
          : `Observation finished with ${view.seen.length} unique host signals. No terminal association was inferred.`);
        focusObservationStart();
        return;
      }
      if (previous) {
        observationState = {
          kind: "unknown",
          view: previous,
          message: `${view.error || view.detail ||
            `Generation ${generation} returned an unexpected state.`} ` +
            "Stop remains bound to that exact observation.",
        };
        patchObservationSurface();
        announce("The observer returned an unexpected state. Its exact Stop action remains available.");
      }
    } catch (error) {
      if (epoch !== observationRequestEpoch || !previous) return;
      observationState = {
        kind: "unknown",
        view: previous,
        message: `KSX lost contact with generation ${generation}. Stop remains bound to that exact observation. ${
          error instanceof Error ? error.message : "The observation could not be polled."
        }`,
      };
      patchObservationSurface();
      announce("Contact with the running signal observation was lost. Its exact Stop action remains available.");
    }
  };
  const adoptListeningObservation = (
    view: EncoderObservationView,
    selector: string,
    epoch: number,
  ): boolean => {
    if (!view.ok || view.state !== "listening" || !observationBelongsTo(view, selector)) return false;
    const generation = view.generation;
    if (generation === null) return false;
    observationOwnership = { selector, generation };
    observationState = { kind: "listening", view };
    repaint();
    focusObservationSink();
    scheduleObservationPoll(epoch, selector, generation);
    announce("Listening to exact-device host signals. No mapping or hardware write is active.");
    return true;
  };
  const startCurrentObservation = async (): Promise<void> => {
    const selector = current.device?.selector;
    if (!selector || chartState.kind === "loading" || observationState.kind === "reconciling" ||
        observationState.kind === "starting" || observationState.kind === "listening" ||
        observationState.kind === "stopping" || observationState.kind === "unknown") return;
    const requestedSelection = current.value;
    const recheckOnly = observationState.kind === "foreign-live";
    const epoch = ++observationRequestEpoch;
    clearObservationPoll();
    observationState = { kind: "reconciling" };
    repaint();
    announce("Checking the current signal-observation lease before starting.");
    let existing: EncoderObservationView;
    try {
      existing = await pollEncoderObservation();
    } catch (error) {
      if (epoch !== observationRequestEpoch || current.value !== requestedSelection) return;
      observationState = {
        kind: "error",
        message: error instanceof Error ? error.message : "KSX could not inspect the current observation lease.",
      };
      repaint();
      announce(`Signal observation unavailable — ${observationState.message}`);
      focusObservationStart();
      return;
    }
    if (epoch !== observationRequestEpoch || current.value !== requestedSelection) return;
    if (recheckOnly) {
      if (existing.ok && (existing.state === "idle" || existing.state === "timeout" ||
          existing.state === "cancelled" || existing.state === "failed")) {
        observationState = { kind: "idle" };
        repaint();
        announce("The foreign observation lease has ended. No new observation was started.");
      } else {
        observationState = {
          kind: "foreign-live",
          message: existing.generation !== null
            ? "An observation lease still exists. This lab will not claim it or start over it."
            : existing.error || existing.detail ||
              "KSX could not prove that the foreign observation lease ended.",
        };
        repaint();
        announce(`Observation lease still busy — ${observationState.message}`);
      }
      focusObservationStart();
      return;
    }
    if (existing.state === "listening") {
      observationState = {
        kind: "foreign-live",
        message: existing.selector === selector
          ? "A live run already exists for this exact selector. This lab did not start it and will not stop or reuse it."
          : "A signal observation is already running for another exact device. This lab has no authority to stop it.",
      };
      repaint();
      announce(`Observation lease busy — ${observationState.message}`);
      focusObservationStart();
      return;
    }
    if (existing.state === "unknown" && existing.generation !== null) {
      observationState = {
        kind: "foreign-live",
        message: existing.selector === selector
          ? "The daemon reports an unrecognized live generation for this selector. This lab will neither start over it nor claim authority to stop it."
          : "The daemon reports an unrecognized live generation. This lab will neither start over it nor claim authority to stop it.",
      };
      repaint();
      announce(`Observation lease busy — ${observationState.message}`);
      focusObservationStart();
      return;
    }
    if (!existing.ok || existing.state === "unavailable" || existing.state === "unknown") {
      observationState = {
        kind: "error",
        message: existing.error || existing.detail ||
          "KSX could not prove that the signal-observation lease is idle.",
      };
      repaint();
      announce(`Signal observation unavailable — ${observationState.message}`);
      focusObservationStart();
      return;
    }

    observationState = { kind: "starting" };
    repaint();
    focusObservationSink();
    try {
      const view = await startEncoderObservation(selector);
      if (epoch !== observationRequestEpoch || current.value !== requestedSelection) {
        if ((view.state === "listening" || view.state === "unknown") &&
            observationBelongsTo(view, selector) && view.generation !== null) {
          void cancelEncoderObservation(view.generation, fetch, pageHiding).catch(() => undefined);
        }
        return;
      }
      if (adoptListeningObservation(view, selector, epoch)) return;
      if ((view.state === "listening" || view.state === "unknown") &&
          observationBelongsTo(view, selector) &&
          view.generation !== null) {
        observationOwnership = { selector, generation: view.generation };
        observationState = {
          kind: "unknown",
          view,
          message: view.state === "unknown"
            ? "The daemon returned an unrecognized state for this exact start. Stop remains bound to its exact generation."
            : "The daemon returned a live exact generation without a successful start result. Stop remains bound to its exact generation.",
        };
        repaint();
        focusObservationSink();
        announce("The exact observation entered an unconfirmed state. Its exact Stop action remains available.");
        return;
      }
      if (view.selector === selector &&
          (view.state === "timeout" || view.state === "cancelled" || view.state === "failed")) {
        observationOwnership = null;
        observationState = { kind: "complete", view };
      } else {
        observationOwnership = null;
        observationState = { kind: "error", message: view.error || view.detail ||
          "KSX did not begin an exact-device signal observation." };
      }
      repaint();
      announce(observationState.kind === "complete"
        ? `Observation ended with ${observationState.view.seen.length} unique host signals.`
        : `Signal observation unavailable — ${observationState.message}`);
      focusObservationStart();
    } catch (error) {
      const stale = epoch !== observationRequestEpoch || current.value !== requestedSelection;
      try {
        const recovered = await pollEncoderObservation();
        const nowStale = stale || epoch !== observationRequestEpoch ||
          current.value !== requestedSelection;
        const recoveredGeneration = recovered.generation;
        if ((recovered.state === "listening" || recovered.state === "unknown") &&
            recoveredGeneration !== null &&
            observationBelongsTo(recovered, selector, recoveredGeneration)) {
          if (nowStale) {
            void cancelEncoderObservation(recoveredGeneration, fetch, pageHiding)
              .catch(() => undefined);
            return;
          }
          observationOwnership = {
            selector,
            generation: recoveredGeneration,
          };
          observationState = {
            kind: "unknown",
            view: recovered,
            message: recovered.state === "unknown"
              ? "KSX could not confirm the start response, and this exact generation is in an unrecognized state. Stop remains bound to it."
              : "KSX could not confirm the start response, but this exact device owns a live observation. Stop it before retrying.",
          };
          repaint();
          focusObservationSink();
          announce("The start response was lost, but an exact owned generation remains. Its exact Stop action is available.");
          return;
        }
        if (nowStale) return;
      } catch {
        // Keep the original start error; no exact live generation was proven.
      }
      if (stale || epoch !== observationRequestEpoch || current.value !== requestedSelection) return;
      observationState = {
        kind: "error",
        message: error instanceof Error ? error.message : "The signal observation could not start.",
      };
      repaint();
      announce(`Signal observation unavailable — ${observationState.message}`);
      focusObservationStart();
    }
  };
  const stopCurrentObservation = async (): Promise<void> => {
    const owned = ownedObservation();
    if (!owned || owned.generation === null || !owned.selector) return;
    const epoch = ++observationRequestEpoch;
    clearObservationPoll();
    const generation = owned.generation;
    const selector = owned.selector;
    observationState = { kind: "stopping", view: owned };
    patchObservationSurface();
    focusObservationSink();
    try {
      const view = await cancelEncoderObservation(generation);
      if (epoch !== observationRequestEpoch) return;
      if (observationProvesReplacement(view, selector, generation)) {
        observationOwnership = null;
        observationState = {
          kind: "foreign-live",
          message: "The observation was replaced before Stop completed. KSX did not cancel the newer generation.",
        };
      } else if (observationBelongsTo(view, selector, generation) &&
          (view.state === "cancelled" || view.state === "timeout" || view.state === "failed")) {
        observationOwnership = null;
        observationState = { kind: "complete", view };
      } else {
        observationState = {
          kind: "unknown",
          view: owned,
          message: `Generation ${generation} did not confirm a terminal stop. Retry Stop for this exact generation.`,
        };
      }
      repaint();
      announce(observationState.kind === "complete"
        ? `Observation stopped with ${observationState.view.seen.length} unique host signals.`
        : observationState.kind === "unknown" ? observationState.message : "Observation ownership changed.");
      if (observationState.kind === "unknown") focusObservationSink();
      else focusObservationStart();
    } catch (error) {
      if (epoch !== observationRequestEpoch) return;
      observationState = {
        kind: "unknown",
        view: owned,
        message: `KSX could not confirm that generation ${generation} stopped. Retry Stop for that exact observation. ${
          error instanceof Error ? error.message : ""
        }`,
      };
      repaint();
      announce("KSX could not confirm the stop. The exact Stop action remains available for retry.");
      focusObservationSink();
    }
  };
  const readCurrentChart = async (): Promise<void> => {
    const result = selectedDetection(current, confirmedCandidate);
    const selector = current.device?.selector;
    const observationBusy = observationState.kind === "reconciling" ||
      observationState.kind === "starting" || observationState.kind === "listening" ||
      observationState.kind === "stopping" || observationState.kind === "unknown" ||
      observationState.kind === "foreign-live";
    if (!selector || !chartReadIsAdmitted(result, current) || chartState.kind === "loading" ||
        observationBusy) return;
    const requestedSelection = current.value;
    const epoch = ++chartRequestEpoch;
    chartState = { kind: "loading" };
    repaint();
    announce(`Reading configured emissions from ${current.device?.name ?? "the selected encoder"}.`);
    const response = await requestEncoderChart(selector);
    if (epoch !== chartRequestEpoch || current.value !== requestedSelection) return;
    if (response.kind !== "answered") {
      chartState = { kind: "error", message: response.message };
    } else {
      const validation = validateEncoderChart(
        response.outcome,
        result.profile.topology.terminals.map((terminal) => terminal.id),
      );
      chartState = validation.ok
        ? { kind: "loaded", snapshot: validation.snapshot }
        : { kind: "error", message: validation.message };
    }
    repaint();
    announce(chartState.kind === "loaded"
      ? `Read ${chartState.snapshot.terminals.length} configured terminal emissions. No hardware was changed.`
      : chartState.kind === "error" ? chartState.message : "");
    document_.defaultView?.requestAnimationFrame(() => {
      dynamicHost.querySelector<HTMLButtonElement>("[data-rd-encoder-read]")
        ?.focus({ preventScroll: true });
    });
  };
  select.addEventListener("change", () => {
    const next = selections.find((selection) => selection.value === select.value);
    if (!next) return;
    releaseObservation();
    current = next;
    chartRequestEpoch += 1;
    chartState = { kind: "idle" };
    confirmedCandidate = undefined;
    declaredLabels = [];
    if (current.profileId) options.onProfileChange?.(current.profileId);
    repaint();
  });
  const footer = html(document_, "footer", "rd-encoder-profile-foot");
  footer.textContent =
    "Read-only inspection. KSX control assignment comes later; this surface stops at terminal identity, stored configuration, and device-scoped host signals.";
  content.append(header, toolbar, dynamicHost, footer, liveStatus);
  const onPageHide = (): void => {
    pageHiding = true;
    chartRequestEpoch += 1;
    releaseObservation(true);
  };
  const onPageShow = (): void => {
    pageHiding = false;
  };
  document_.defaultView?.addEventListener("pagehide", onPageHide);
  document_.defaultView?.addEventListener("pageshow", onPageShow);
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
        releaseObservation();
        chartRequestEpoch += 1;
        chartState = { kind: "idle" };
        confirmedCandidate = undefined;
        declaredLabels = [];
      }
      repaintOptions();
      if (selectionChanged || evidenceChanged) repaint();
      else paintHeader(selectedDetection(current, confirmedCandidate));
    },
    dispose: () => {
      document_.defaultView?.removeEventListener("pagehide", onPageHide);
      document_.defaultView?.removeEventListener("pageshow", onPageShow);
      chartRequestEpoch += 1;
      // Ordinary widget removal keeps the page alive, so use a normal request.
      // `pagehide` above owns the only lifecycle that needs keepalive delivery.
      releaseObservation();
      if (announcementFrame) document_.defaultView?.cancelAnimationFrame(announcementFrame);
      announcementFrame = 0;
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
  encoderProfileLabDisposers.set(item, lab.dispose);
  return {
    item,
    home: { ...LAB_HOME },
    updateConnectedEncoders: lab.updateConnectedEncoders,
    dispose: () => disposeEncoderProfileLabCanvasItem(item),
  };
}
