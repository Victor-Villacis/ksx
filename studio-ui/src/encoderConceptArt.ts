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
let encoderSvgSequence = 0;
let encoderSurfaceSequence = 0;
const CATALOG_PREFIX = "catalog:";
const CONNECTED_PREFIX = "connected:";
const AMBIGUOUS_SAMPLE = "sample:ambiguous-minipac";
const UNKNOWN_SAMPLE = "sample:unknown-hid";

export interface EncoderProfileLabDevice {
  selector: string;
  name: string;
  alias?: string;
  /** Served, human-facing transport / firmware line from the device picker. */
  meta?: string;
  backend: BackendEncoderFacts;
}

export interface EncoderProfileLabOptions {
  connectedEncoders?: readonly EncoderProfileLabDevice[];
  /** A catalog id only. Connected-device selectors are never stored. */
  initialProfileId?: EncoderVisualProfileId;
  onProfileChange?: (profileId: EncoderVisualProfileId) => void;
  /** `research` keeps the internal comparison harness. `product` fixes the
   * surface to one connected device selected by the workbench picker. */
  presentation?: "research" | "product";
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

export interface EncoderWorkbenchSurface {
  content: HTMLElement;
  updateDevice: (device: EncoderProfileLabDevice) => void;
  /** A refused/failed roster scan is not a disconnect. It does mean that a
   * fresh hardware action must wait until KSX can confirm the device again. */
  setConnectionConfirmed: (confirmed: boolean) => void;
  dispose: () => void;
}

export interface EncoderWorkbenchSurfaceOptions {
  /** A fresh, visible `+ Devices` Add gesture may authorize one initial
   * read-only chart transaction. Restores, reconnects, and passive roster
   * refreshes must leave this false so page lifecycle never starts hardware. */
  readStoredAssignmentsOnMount?: boolean;
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

type ChartReadFocusTarget = "inspector" | "panel";

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

type EncoderHardwareActionKind = "chart" | "observation";

interface EncoderHardwareActionLease {
  owner: symbol;
  kind: EncoderHardwareActionKind;
  selector: string;
}

/** Chart reads and the input observer both touch exclusive encoder/host state.
 * The old single profile lab could enforce that locally; product workbench
 * objects need one coordinator shared by every mounted encoder surface. */
let encoderHardwareActionLease: EncoderHardwareActionLease | null = null;
const encoderHardwareActionSubscribers = new Set<() => void>();

function notifyEncoderHardwareActionChange(): void {
  for (const subscriber of Array.from(encoderHardwareActionSubscribers)) subscriber();
}

function claimEncoderHardwareAction(
  owner: symbol,
  kind: EncoderHardwareActionKind,
  selector: string,
): boolean {
  const active = encoderHardwareActionLease;
  if (active && (active.owner !== owner || active.kind !== kind)) return false;
  if (!active) {
    encoderHardwareActionLease = { owner, kind, selector };
    notifyEncoderHardwareActionChange();
  }
  return true;
}

function releaseEncoderHardwareAction(owner: symbol, kind?: EncoderHardwareActionKind): void {
  const active = encoderHardwareActionLease;
  if (!active || active.owner !== owner || (kind && active.kind !== kind)) return;
  encoderHardwareActionLease = null;
  notifyEncoderHardwareActionChange();
}

function encoderHardwareActionBlockedFor(
  owner: symbol,
  requested: EncoderHardwareActionKind,
): EncoderHardwareActionLease | null {
  const active = encoderHardwareActionLease;
  if (!active || (active.owner === owner && active.kind === requested)) return null;
  return active;
}

function subscribeEncoderHardwareActions(subscriber: () => void): () => void {
  encoderHardwareActionSubscribers.add(subscriber);
  return () => encoderHardwareActionSubscribers.delete(subscriber);
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

/** Product copy must preserve the registry's epistemic distinction. Only an
 * exact profile may call its capacity physical inputs; family/discrete and
 * logical drawings are useful control rosters, not asserted terminal counts. */
function productTopologyLabel(profile: EncoderVisualProfile): string {
  switch (profile.topology.capacity.kind) {
    case "exact": return `${profile.topology.capacity.inputCount} inputs`;
    case "discrete": return `${topologyValue(profile)} documented variants`;
    case "range": return `${topologyValue(profile)} family controls`;
    case "logical": return `${profile.topology.capacity.controlCount} logical controls`;
    case "unknown": return "Capacity unknown";
  }
}

function productTopologySilkscreen(profile: EncoderVisualProfile): string {
  switch (profile.topology.capacity.kind) {
    case "exact": return `${profile.topology.capacity.inputCount} INPUTS`;
    case "discrete": return `${topologyValue(profile)} VARIANTS`;
    case "range": return `${topologyValue(profile)} FAMILY RANGE`;
    case "logical": return `${profile.topology.capacity.controlCount} LOGICAL CONTROLS`;
    case "unknown": return "CAPACITY UNKNOWN";
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
  const svgId = `rd-encoder-svg-${profile.id}-${++encoderSvgSequence}`;
  const titleId = `${svgId}-title`;
  const descriptionId = `${svgId}-description`;
  const svg = svgElement(document_, "svg", {
    class: "rd-encoder-profile-svg",
    viewBox: "0 0 840 360",
    role: "img",
    "aria-labelledby": `${titleId} ${descriptionId}`,
    preserveAspectRatio: "xMidYMid meet",
    focusable: "false",
    "data-profile-id": profile.id,
    "data-layout-fidelity": profile.topology.confidence,
    "data-svg-id": svgId,
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
      ? `${profile.topology.terminals.length} terminal rows · stored assignments read now · wiring still not inferred`
      : `${confidenceLabel(profile)} · ${profile.topology.terminals.length} visible rows · wiring state not inferred`,
    420, 344, "rd-encoder-profile-svg-caption", "middle",
  ));
  return svg;
}

interface ProductTerminalInteraction {
  selectedTerminalId?: string;
  observedSignals: ReadonlySet<string>;
  heldSignals: ReadonlySet<string>;
  onSelect: (terminalId: string) => void;
}

function productTerminalAriaBase(
  terminal: EncoderVisualTerminal,
  configuredEmission: string | null,
  configuredKeyKnown: boolean,
  sharedKeyCount: number,
): string {
  const identity = terminal.identityScope === "logical-control"
    ? "Logical control; physical terminal not asserted."
    : terminal.presence === "variant-only"
      ? "Available only on some documented variants."
      : terminal.connection === "harness"
        ? "Physical harness channel."
        : terminal.connection === "jamma-edge"
          ? "Physical JAMMA edge contact."
          : "Physical screw terminal.";
  const emission = configuredEmission
    ? `${configuredKeyKnown ? "Configured key" : "Stored output"} ${configuredEmission}.`
    : "Stored assignment not read yet.";
  const shared = sharedKeyCount > 1 ? ` Shared by ${sharedKeyCount} profile rows.` : "";
  const capability = terminal.capabilities.includes("optical-axis")
    ? " This channel can be reassigned to an optical axis, so it may be unavailable as a switch."
    : "";
  return `${terminal.label}. ${identity}${capability} ${emission}${shared} Controller assignment not set.`;
}

function chartShiftedAssignmentsReachable(chart: EncoderChartSnapshot | null): boolean {
  return chart?.shift?.state === "enabled";
}

function productTerminalGroups(profile: EncoderVisualProfile): Array<{
  id: string;
  terminals: readonly EncoderVisualTerminal[];
  x: number;
  y: number;
  width: number;
  edge: "top" | "bottom";
}> {
  const grouped = new Map<string, EncoderVisualTerminal[]>();
  for (const terminal of profile.topology.terminals) {
    const values = grouped.get(terminal.groupId) ?? [];
    values.push(terminal);
    grouped.set(terminal.groupId, values);
  }
  const ids = [
    ...profile.layout.groupOrder.filter((id) => grouped.has(id)),
    ...Array.from(grouped.keys()).filter((id) => !profile.layout.groupOrder.includes(id)),
  ];
  if (ids.length === 1) {
    return [{ id: ids[0]!, terminals: grouped.get(ids[0]!) ?? [], x: 82, y: 70, width: 836, edge: "top" }];
  }
  if (ids.length === 2) {
    return ids.map((id, index) => ({
      id,
      terminals: grouped.get(id) ?? [],
      x: 82,
      y: index === 0 ? 70 : 394,
      width: 836,
      edge: index === 0 ? "top" : "bottom",
    }));
  }
  if (ids.length === 3) {
    return ids.map((id, index) => ({
      id,
      terminals: grouped.get(id) ?? [],
      x: index < 2 ? 82 + index * 426 : 82,
      y: index < 2 ? 70 : 394,
      width: index < 2 ? 410 : 836,
      edge: index < 2 ? "top" : "bottom",
    }));
  }
  const half = Math.ceil(ids.length / 2);
  return ids.map((id, index) => {
    const rowIndex = index < half ? index : index - half;
    const rowCount = index < half ? half : ids.length - half;
    const gap = 18;
    const width = (836 - gap * Math.max(0, rowCount - 1)) / rowCount;
    return {
      id,
      terminals: grouped.get(id) ?? [],
      x: 82 + rowIndex * (width + gap),
      y: index < half ? 70 : 394,
      width,
      edge: index < half ? "top" : "bottom",
    };
  });
}

interface ProductTerminalGroupLayout {
  columns: number;
  rows: number;
  pitch: number;
  rowPitch: number;
  width: number;
  hitWidth: number;
  hitHeight: number;
  firstRowY: number;
}

function productTerminalGroupLayout(
  group: ReturnType<typeof productTerminalGroups>[number],
): ProductTerminalGroupLayout {
  const count = Math.max(1, group.terminals.length);
  // Dense boards need more than one row. Keeping a genuine gap between the
  // hit rectangles prevents a neighbouring SVG sibling from stealing pointer
  // input, while the full-width product figure renders them at >=44 CSS px.
  const maximumColumns = Math.max(1, Math.floor(group.width / 56));
  const columns = Math.max(1, Math.min(maximumColumns, Math.ceil(count / 2)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const pitch = group.width / columns;
  const rowPitch = 56;
  return {
    columns,
    rows,
    pitch,
    rowPitch,
    width: Math.max(24, Math.min(38, pitch - 12)),
    hitWidth: Math.min(54, pitch - 2),
    hitHeight: 54,
    firstRowY: group.edge === "bottom" ? group.y - (rows - 1) * rowPitch : group.y,
  };
}

function productInterfaceGrammar(profile: EncoderVisualProfile): string {
  switch (profile.visualKind) {
    case "terminal-board": return "screw-terminals";
    case "harness-board": return "keyed-harness";
    case "jamma-board": return "jamma-logical-routes";
    case "fight-board": return "logical-fight-controls";
    case "firmware-reference": return "remappable-logical-controls";
    case "generic-hid": return "observed-signals-only";
  }
}

function appendProductTerminalFace(
  document_: Document,
  terminalNode: SVGGElement,
  terminal: EncoderVisualTerminal,
  width: number,
): void {
  const center = width / 2;
  if (terminal.connection === "screw") {
    terminalNode.append(
      svgElement(document_, "circle", {
        cx: center, cy: 12, r: 6.5, class: "rd-encoder-product-terminal-screw",
      }),
      svgElement(document_, "path", {
        d: `M ${center - 4} 12 H ${center + 4}`,
        class: "rd-encoder-product-terminal-slot",
      }),
    );
    return;
  }
  if (terminal.connection === "harness") {
    terminalNode.append(
      svgElement(document_, "rect", {
        x: center - 9, y: 5, width: 18, height: 15, rx: 3,
        class: "rd-encoder-product-terminal-socket",
      }),
      svgElement(document_, "path", {
        d: `M ${center - 4} 9 V 16 M ${center + 4} 9 V 16`,
        class: "rd-encoder-product-terminal-pins",
      }),
      svgElement(document_, "path", {
        d: `M ${center - 3} 5 H ${center + 3}`,
        class: "rd-encoder-product-terminal-key",
      }),
    );
    return;
  }
  if (terminal.connection === "jamma-edge") {
    terminalNode.append(
      svgElement(document_, "rect", {
        x: center - 9, y: 4, width: 18, height: 17, rx: 2,
        class: "rd-encoder-product-terminal-edge",
      }),
      svgElement(document_, "path", {
        d: `M ${center} 5 V 20`,
        class: "rd-encoder-product-terminal-edge-divider",
      }),
    );
    return;
  }
  terminalNode.append(
    svgElement(document_, "circle", {
      cx: center, cy: 12, r: 8,
      class: "rd-encoder-product-terminal-logical-node",
    }),
    svgElement(document_, "path", {
      d: `M ${center - 4} 12 H ${center + 4} M ${center} 8 V 16`,
      class: "rd-encoder-product-terminal-logical-route",
    }),
  );
}

function appendProductInterfaceMotif(
  document_: Document,
  svg: SVGSVGElement,
  profile: EncoderVisualProfile,
  centerY: number,
): void {
  const grammar = productInterfaceGrammar(profile);
  const motif = svgElement(document_, "g", {
    class: `rd-encoder-product-interface is-${profile.visualKind}`,
    "data-interface-motif": grammar,
    "aria-hidden": "true",
  });
  const appendAbstractHarness = (
    x: number,
    width: number,
    label: string,
    interfaceId: string,
    auxiliary = false,
  ): void => {
    const connector = svgElement(document_, "g", {
      "data-harness-interface": interfaceId,
      ...(auxiliary ? { "data-auxiliary-interface": interfaceId } : {}),
    });
    connector.append(
      svgElement(document_, "rect", {
        x, y: centerY - 18, width, height: 36, rx: 8,
        class: "rd-encoder-product-interface-harness",
        "data-interface-geometry": interfaceId,
      }),
      svgText(document_, label, x + width / 2, centerY + 4,
        "rd-encoder-product-interface-label", "middle"),
    );
    motif.append(connector);
  };
  if (profile.id === "ultimarc-ipac2") {
    for (const x of [144, 218, 292, 366]) {
      motif.append(
        svgElement(document_, "rect", { x, y: centerY - 8, width: 38, height: 13, rx: 4 }),
        svgElement(document_, "circle", { cx: x + 12, cy: centerY + 28, r: 7 }),
        svgElement(document_, "circle", { cx: x + 30, cy: centerY + 28, r: 7 }),
      );
    }
    // The manufacturer documents these as separate interfaces. Their exact
    // connector geometry is not part of KSX's measured evidence, so the board
    // uses labelled abstract bodies instead of inventing a shared pinout.
    appendAbstractHarness(594, 128, "OPTICAL", "optical-header", true);
    appendAbstractHarness(738, 116, "PACLINK", "paclink-header", true);
  } else if (profile.visualKind === "harness-board") {
    // Connector bodies mirror only the published board-level interface
    // families. They intentionally omit pin counts because those have not been
    // admitted from a measured fixture in KSX.
    if (profile.id === "ultimarc-ultimate-io") {
      appendAbstractHarness(125, 280, "32-INPUT MAIN", "main-input-harness");
      appendAbstractHarness(595, 250, "16-INPUT EXPANSION", "expansion-input-harness");
    } else if (profile.id === "ultimarc-minipac-32") {
      appendAbstractHarness(130, 275, "32-WAY SWITCH HARNESS", "switch-harness");
    } else if (profile.id === "ultimarc-minipac-four") {
      appendAbstractHarness(125, 280, "SWITCH HARNESS A", "switch-harness-a");
      appendAbstractHarness(595, 250, "SWITCH HARNESS B", "switch-harness-b");
    }
  } else if (profile.visualKind === "jamma-board") {
    motif.append(
      svgElement(document_, "rect", {
        x: 238, y: 448, width: 524, height: 10, rx: 2,
        class: "rd-encoder-product-interface-edge",
        "data-interface-geometry": "jamma-edge",
      }),
    );
    for (let pad = 0; pad < 28; pad += 1) {
      const x = 247 + pad * 18.7;
      motif.append(svgElement(document_, "path", {
        d: `M ${x} 450 V 456`, class: "rd-encoder-product-interface-edge-pad",
      }));
    }
  } else if (profile.visualKind === "fight-board" || profile.visualKind === "firmware-reference") {
    const label = profile.visualKind === "firmware-reference" ? "REMAPPABLE GPIO" : "LOGICAL CONTROL MAP";
    const motifY = centerY + 25;
    motif.append(svgText(document_, label, 305, motifY + 5,
      "rd-encoder-product-interface-label", "middle"));
    for (const x of [168, 206, 244, 756, 794, 832]) {
      motif.append(svgElement(document_, "circle", {
        cx: x, cy: motifY, r: 7, class: "rd-encoder-product-interface-node",
      }));
    }
  } else {
    for (const x of [144, 218, 292, 366, 596, 670, 744, 818]) {
      motif.append(
        svgElement(document_, "rect", { x, y: centerY - 8, width: 38, height: 13, rx: 4 }),
        svgElement(document_, "circle", { cx: x + 12, cy: centerY + 28, r: 7 }),
        svgElement(document_, "circle", { cx: x + 30, cy: centerY + 28, r: 7 }),
      );
    }
  }
  svg.append(motif);
}

function appendProductBoardDefs(document_: Document, svg: SVGSVGElement): {
  boardGradientId: string;
  metalGradientId: string;
} {
  const namespace = svg.dataset.svgId ?? `rd-encoder-svg-${++encoderSvgSequence}`;
  const boardGradientId = `${namespace}-board-gradient`;
  const metalGradientId = `${namespace}-metal-gradient`;
  const defs = svgElement(document_, "defs");
  const board = svgElement(document_, "linearGradient", {
    id: boardGradientId, x1: "0", y1: "0", x2: "1", y2: "1",
  });
  board.append(
    svgElement(document_, "stop", { offset: "0%", class: "rd-encoder-board-stop-a" }),
    svgElement(document_, "stop", { offset: "58%", class: "rd-encoder-board-stop-b" }),
    svgElement(document_, "stop", { offset: "100%", class: "rd-encoder-board-stop-c" }),
  );
  const metal = svgElement(document_, "linearGradient", {
    id: metalGradientId, x1: "0", y1: "0", x2: "0", y2: "1",
  });
  metal.append(
    svgElement(document_, "stop", { offset: "0%", class: "rd-encoder-metal-stop-a" }),
    svgElement(document_, "stop", { offset: "48%", class: "rd-encoder-metal-stop-b" }),
    svgElement(document_, "stop", { offset: "100%", class: "rd-encoder-metal-stop-c" }),
  );
  defs.append(board, metal);
  svg.append(defs);
  return { boardGradientId, metalGradientId };
}

/** Product drawing: a premium schematic of the detected board, not a
 * photogrammetric claim. Every interactive terminal still joins by the exact
 * profile-owned terminal id, and only a validated chart may paint emissions. */
function renderProductProfileSvg(
  document_: Document,
  result: EncoderDetectionResult,
  chart: EncoderChartSnapshot | null,
  interaction: ProductTerminalInteraction,
): SVGSVGElement {
  const profile = result.profile;
  const chartByTerminal = encoderChartTerminalMap(chart);
  const configuredKeyCounts = new Map<string, number>();
  const shiftedAssignmentsReachable = chartShiftedAssignmentsReachable(chart);
  if (chart) {
    for (const terminal of chart.terminals) {
      const keys = new Set([
        terminal.normal.key?.trim() ?? "",
        shiftedAssignmentsReachable ? terminal.shifted.key?.trim() ?? "" : "",
      ].filter(Boolean));
      for (const key of keys) {
        configuredKeyCounts.set(key, (configuredKeyCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const svg = createProfileSvg(
    document_,
    profile,
    `${profile.manufacturer} ${profile.model}. Select a terminal to inspect its stored output.`,
  );
  svg.setAttribute("viewBox", "0 0 1000 520");
  svg.classList.add("rd-encoder-product-svg");
  svg.dataset.capacity = topologyValue(profile);
  svg.dataset.capacitySource = profile.topology.confidence;
  svg.dataset.resolution = result.resolution;
  svg.dataset.interactive = "true";
  svg.dataset.visualKind = profile.visualKind;
  svg.dataset.interfaceGrammar = productInterfaceGrammar(profile);
  svg.setAttribute("role", "group");
  const gradients = appendProductBoardDefs(document_, svg);
  const terminalGroups = productTerminalGroups(profile);
  const topRows = Math.max(0, ...terminalGroups
    .filter((group) => group.edge === "top")
    .map((group) => productTerminalGroupLayout(group).rows));
  const bottomRows = Math.max(0, ...terminalGroups
    .filter((group) => group.edge === "bottom")
    .map((group) => productTerminalGroupLayout(group).rows));
  const denseTop = topRows > 2;
  const denseBottom = bottomRows > 2;
  const chipY = denseTop ? 238 : denseBottom ? 184 : 202;
  const chipHeight = denseTop || denseBottom ? 96 : 116;
  const interfaceY = chipY + chipHeight / 2;
  svg.dataset.maximumTopRows = String(topRows);
  svg.dataset.maximumBottomRows = String(bottomRows);

  svg.append(
    svgElement(document_, "rect", {
      x: 36, y: 58, width: 928, height: 404, rx: 32,
      class: `rd-encoder-product-board is-${profile.visualKind}`,
      fill: `url(#${gradients.boardGradientId})`,
    }),
    svgElement(document_, "rect", {
      x: 48, y: 70, width: 904, height: 380, rx: 24,
      class: "rd-encoder-product-board-inset",
    }),
  );

  const usb = svgElement(document_, "g", { class: "rd-encoder-product-usb" });
  usb.append(
    svgElement(document_, "rect", {
      x: 8, y: 205, width: 90, height: 110, rx: 16,
      fill: `url(#${gradients.metalGradientId})`,
    }),
    svgElement(document_, "rect", { x: 19, y: 222, width: 60, height: 76, rx: 9, class: "rd-encoder-product-usb-mouth" }),
    svgText(document_, "USB", 53, 330, "rd-encoder-product-silk", "middle"),
  );
  svg.append(usb);

  for (const [cx, cy] of [[67, 91], [933, 91], [67, 429], [933, 429]]) {
    const mount = svgElement(document_, "g", { class: "rd-encoder-product-mount" });
    mount.append(
      svgElement(document_, "circle", { cx, cy, r: 13 }),
      svgElement(document_, "circle", { cx, cy, r: 5, class: "rd-encoder-product-mount-core" }),
    );
    svg.append(mount);
  }

  const traces = svgElement(document_, "g", { class: "rd-encoder-product-traces" });
  for (const d of [
    "M 130 144 C 260 155 332 198 430 222",
    "M 870 144 C 740 155 668 198 570 222",
    "M 130 376 C 260 365 332 322 430 298",
    "M 870 376 C 740 365 668 322 570 298",
    "M 114 181 C 264 190 338 224 430 242",
    "M 886 181 C 736 190 662 224 570 242",
    "M 114 339 C 264 330 338 296 430 278",
    "M 886 339 C 736 330 662 296 570 278",
  ]) traces.append(svgElement(document_, "path", { d }));
  svg.append(traces);

  const chip = svgElement(document_, "g", { class: "rd-encoder-product-chip" });
  chip.append(
    svgElement(document_, "rect", { x: 425, y: chipY, width: 150, height: chipHeight, rx: 18 }),
    svgText(document_, profile.shortLabel.toUpperCase(), 500, chipY + 34,
      "rd-encoder-product-chip-name", "middle"),
    svgText(document_, topologyValue(profile), 500, chipY + 73,
      "rd-encoder-product-chip-count", "middle"),
    svgText(document_, topologyUnit(profile).toUpperCase(), 500, chipY + 94,
      "rd-encoder-product-chip-unit", "middle"),
  );
  svg.append(chip);

  const silkY = denseTop ? 266 : denseBottom ? 174 : 230;
  const silk = svgElement(document_, "g", { class: "rd-encoder-product-silkscreen" });
  silk.append(
    svgText(document_, "KSX · INTERACTIVE ENCODER", 122, silkY, "rd-encoder-product-brand"),
    svgText(document_, profile.manufacturer.toUpperCase(), 122, silkY + 23, "rd-encoder-product-maker"),
    svgText(document_, chart ? "CHART READ" : "CHART NOT READ", 878, silkY,
      "rd-encoder-product-read-state", "end"),
    svgText(document_, productTopologySilkscreen(profile), 878, silkY + 23,
      "rd-encoder-product-maker", "end"),
  );
  svg.append(silk);
  appendProductInterfaceMotif(document_, svg, profile, interfaceY);
  const status = svgElement(document_, "g", { class: "rd-encoder-product-components" });
  status.append(
    svgElement(document_, "circle", {
      cx: 900, cy: interfaceY, r: 8, class: "rd-encoder-product-led",
    }),
    svgText(document_, "STATUS", 900, interfaceY + 24,
      "rd-encoder-product-led-label", "middle"),
  );
  svg.append(status);

  const orderedTerminals = terminalGroups.flatMap((group) => group.terminals);
  const activeTerminalId = interaction.selectedTerminalId &&
      orderedTerminals.some((terminal) => terminal.id === interaction.selectedTerminalId)
    ? interaction.selectedTerminalId
    : orderedTerminals[0]?.id;
  for (const group of terminalGroups) {
    const groupNode = svgElement(document_, "g", {
      class: `rd-encoder-product-group is-${group.edge}`,
      "data-terminal-group": group.id,
    });
    const layout = productTerminalGroupLayout(group);
    const labelY = group.edge === "top"
      ? group.y - 12
      : profile.visualKind === "jamma-board"
        ? layout.firstRowY - 4
        : group.y + 68;
    groupNode.append(svgText(
      document_, groupLabel(group.id).toUpperCase(), group.x + group.width / 2, labelY,
      "rd-encoder-product-group-label", "middle",
    ));
    group.terminals.forEach((terminal, index) => {
      const configured = chartByTerminal.get(terminal.id);
      const normalKey = configured?.normal.key?.trim() ?? "";
      const shiftedKey = shiftedAssignmentsReachable
        ? configured?.shifted.key?.trim() ?? ""
        : "";
      const seen = Boolean((normalKey && interaction.observedSignals.has(normalKey)) ||
        (shiftedKey && interaction.observedSignals.has(shiftedKey)));
      const held = Boolean((normalKey && interaction.heldSignals.has(normalKey)) ||
        (shiftedKey && interaction.heldSignals.has(shiftedKey)));
      const selected = interaction.selectedTerminalId === terminal.id;
      const sharedKeyCount = Math.max(0, ...[normalKey, shiftedKey]
        .filter(Boolean)
        .map((key) => configuredKeyCounts.get(key) ?? 0));
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const x = group.x + column * layout.pitch + (layout.pitch - layout.width) / 2;
      const y = layout.firstRowY + row * layout.rowPitch;
      const configuredEmission = configured ? encoderEmissionLabel(configured.normal) : null;
      const ariaBase = productTerminalAriaBase(
        terminal, configuredEmission, Boolean(configured?.normal.key?.trim()), sharedKeyCount,
      );
      const terminalNode = svgElement(document_, "g", {
        class: `rd-encoder-product-terminal player-${terminal.player ?? 0}` +
          ` is-connection-${terminal.connection}` +
          (terminal.capabilities.includes("optical-axis") ? " is-optical-capable" : "") +
          (terminal.presence === "variant-only" ? " is-variant" : "") +
          (terminal.identityScope === "logical-control" ? " is-logical" : "") +
          (configured ? " has-configured-emission" : "") +
          (configured && !configured.normal.supported ? " is-opaque-emission" : "") +
          (configured?.normal.supported && configured.normal.code === 0 ? " is-zero-emission" : "") +
          (sharedKeyCount > 1 ? " is-shared-emission" : "") +
          (selected ? " is-selected" : "") + (seen ? " is-seen" : "") +
          (held ? " is-held" : ""),
        transform: `translate(${x} ${y})`,
        tabindex: terminal.id === activeTerminalId ? 0 : -1,
        role: "button",
        "aria-pressed": selected ? "true" : "false",
        "aria-label": `${ariaBase}${held ? " Matching key held now." : seen
          ? " Matching key seen during this test." : ""}`,
        "data-terminal-id": terminal.id,
        "data-terminal-label": terminal.label,
        "data-terminal-aria-base": ariaBase,
        "data-terminal-column": column,
        "data-terminal-row": row,
        "data-identity-scope": terminal.identityScope,
        "data-connection": terminal.connection,
        "data-capabilities": terminal.capabilities.join(" "),
        "data-presence": terminal.presence,
        ...(configured ? {
          "data-configured-emission": encoderEmissionLabel(configured.normal),
          "data-configured-code": configured.normal.code,
          "data-configured-key": normalKey,
          "data-configured-shift-key": shiftedKey,
          ...(normalKey && configured.normal.supported ? { "data-key": normalKey } : {}),
          ...(shiftedKey && configured.shifted.supported ? { "data-shift-key": shiftedKey } : {}),
          ...(sharedKeyCount > 1 ? { "data-shared-key-count": sharedKeyCount } : {}),
        } : {}),
      });
      const activate = (): void => interaction.onSelect(terminal.id);
      terminalNode.addEventListener("click", activate);
      terminalNode.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          svg.closest<HTMLElement>(".widget-instance")?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          activate();
          return;
        }
        const currentIndex = orderedTerminals.findIndex((value) => value.id === terminal.id);
        let nextIndex = currentIndex;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          nextIndex = (currentIndex + 1) % orderedTerminals.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          nextIndex = (currentIndex - 1 + orderedTerminals.length) % orderedTerminals.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = orderedTerminals.length - 1;
        } else return;
        event.preventDefault();
        event.stopPropagation();
        const next = orderedTerminals[nextIndex];
        if (next) interaction.onSelect(next.id);
      });
      const title = svgElement(document_, "title");
      title.textContent = `${terminal.label}${configured
        ? ` · ${encoderEmissionLabel(configured.normal)}` : " · read stored assignments to inspect"}`;
      terminalNode.append(
        title,
        svgElement(document_, "rect", {
          x: (layout.width - layout.hitWidth) / 2, y: 0,
          width: layout.hitWidth, height: layout.hitHeight, rx: 8,
          class: "rd-encoder-product-terminal-hit",
        }),
        svgElement(document_, "rect", {
          width: layout.width, height: 48, rx: 6,
          class: "rd-encoder-product-terminal-body",
        }),
      );
      appendProductTerminalFace(document_, terminalNode, terminal, layout.width);
      if (terminal.capabilities.includes("optical-axis")) {
        terminalNode.append(svgElement(document_, "circle", {
          cx: layout.width - 4, cy: 5, r: 2.5,
          class: "rd-encoder-product-terminal-optical",
        }));
      }
      terminalNode.append(
        svgText(document_, terminalShortLabel(terminal), layout.width / 2, 29,
          "rd-encoder-product-terminal-label", "middle"),
        svgText(document_, configured ? encoderEmissionShortLabel(configured.normal) : "—",
          layout.width / 2, 42, "rd-encoder-product-terminal-emission", "middle"),
      );
      groupNode.append(terminalNode);
    });
    svg.append(groupNode);
  }
  return svg;
}

/** An unknown board may show only facts the user or exact-device observer
 * supplied. This intentionally has no `data-terminal-id` nodes: heard keys and
 * printed labels are useful setup material, but neither discovers a terminal. */
function renderProductUnknownSvg(
  document_: Document,
  result: EncoderDetectionResult,
  observations: readonly ObservedSignal[],
  declaredLabels: readonly string[],
  observationsAreLive: boolean,
): SVGSVGElement {
  const profile = getEncoderVisualProfile("unknown-hid");
  const svg = createProfileSvg(
    document_, profile,
    "Unknown encoder. User-declared control labels and exact-device keys are kept separate; terminal capacity and wiring are not inferred.",
  );
  svg.setAttribute("viewBox", "0 0 1000 520");
  svg.classList.add("rd-encoder-product-svg", "is-unknown");
  svg.dataset.capacity = "unknown";
  svg.dataset.capacitySource = profile.topology.confidence;
  svg.dataset.resolution = result.resolution;
  svg.dataset.visualKind = profile.visualKind;
  svg.dataset.interfaceGrammar = productInterfaceGrammar(profile);
  svg.dataset.observedCount = String(observations.length);
  svg.dataset.declaredCount = String(declaredLabels.length);
  svg.dataset.hiddenDeclaredCount = String(Math.max(0, declaredLabels.length - 16));
  const gradients = appendProductBoardDefs(document_, svg);
  svg.append(
    svgElement(document_, "rect", {
      x: 36, y: 58, width: 928, height: 404, rx: 32,
      class: "rd-encoder-product-board is-generic-hid",
      fill: `url(#${gradients.boardGradientId})`,
    }),
    svgElement(document_, "rect", {
      x: 48, y: 70, width: 904, height: 380, rx: 24,
      class: "rd-encoder-product-board-inset",
    }),
  );
  const usb = svgElement(document_, "g", { class: "rd-encoder-product-usb" });
  usb.append(
    svgElement(document_, "rect", {
      x: 8, y: 205, width: 90, height: 110, rx: 16,
      fill: `url(#${gradients.metalGradientId})`,
    }),
    svgElement(document_, "rect", {
      x: 19, y: 222, width: 60, height: 76, rx: 9,
      class: "rd-encoder-product-usb-mouth",
    }),
    svgText(document_, "USB", 53, 330, "rd-encoder-product-silk", "middle"),
  );
  svg.append(usb);
  for (const [cx, cy] of [[67, 91], [933, 91], [67, 429], [933, 429]]) {
    const mount = svgElement(document_, "g", { class: "rd-encoder-product-mount" });
    mount.append(
      svgElement(document_, "circle", { cx, cy, r: 13 }),
      svgElement(document_, "circle", {
        cx, cy, r: 5, class: "rd-encoder-product-mount-core",
      }),
    );
    svg.append(mount);
  }
  svg.append(
    svgText(document_, "GENERIC ENCODER", 112, 126, "rd-encoder-product-brand"),
    svgText(document_, "BUILD FROM WHAT THIS DEVICE ACTUALLY SENDS", 112, 150,
      "rd-encoder-product-maker"),
  );

  const visibleLabels = declaredLabels.slice(0, 16);
  const labelColumns = Math.max(1, Math.min(8, visibleLabels.length));
  const labelRows = Math.max(1, Math.ceil(visibleLabels.length / labelColumns));
  const labelWidth = 80;
  const labelPitchX = 88;
  const labelPitchY = 60;
  const labelStartX = 500 - ((labelColumns - 1) * labelPitchX + labelWidth) / 2;
  const labelStartY = 218 - ((labelRows - 1) * labelPitchY) / 2;
  visibleLabels.forEach((label, index) => {
    const column = index % labelColumns;
    const row = Math.floor(index / labelColumns);
    const x = labelStartX + column * labelPitchX;
    const y = labelStartY + row * labelPitchY;
    const node = svgElement(document_, "g", {
      class: "rd-encoder-product-declared",
      transform: `translate(${x} ${y})`,
      "data-declared-terminal-id": `declared-${index + 1}`,
      "data-declared-label": label,
      "aria-hidden": "true",
    });
    node.append(
      svgElement(document_, "rect", {
        x: 0, y: 0, width: labelWidth, height: 52, rx: 7,
      }),
      svgText(document_, label.slice(0, 9).toUpperCase(), labelWidth / 2,
        33, "rd-encoder-product-terminal-label", "middle"),
    );
    svg.append(node);
  });

  if (visibleLabels.length === 0) {
    const chip = svgElement(document_, "g", { class: "rd-encoder-product-chip is-unknown" });
    chip.append(
      svgElement(document_, "rect", { x: 390, y: 192, width: 220, height: 132, rx: 22 }),
      svgText(document_, "UNKNOWN", 500, 235, "rd-encoder-product-chip-name", "middle"),
      svgText(document_, observations.length > 0 ? String(observations.length) : "—", 500, 279,
        "rd-encoder-product-chip-count", "middle"),
      svgText(document_, observationsAreLive ? "KEYS HEARD" : "KEYS NOT TESTED", 500, 303,
        "rd-encoder-product-chip-unit", "middle"),
    );
    svg.append(chip);
  } else if (declaredLabels.length > visibleLabels.length) {
    svg.append(svgText(
      document_, `+${declaredLabels.length - visibleLabels.length} more declared labels`,
      500, 320, "rd-encoder-product-maker", "middle",
    ));
  }

  const visibleSignals = observations.slice(0, 10);
  const signalStart = 500 - ((visibleSignals.length - 1) * 76) / 2;
  visibleSignals.forEach((signal, index) => {
    const x = signalStart + index * 76;
    const key = svgElement(document_, "g", {
      class: "rd-encoder-product-signal",
      transform: `translate(${x - 31} 352)`,
      "data-observed-signal-id": signal.id,
    });
    key.append(
      svgElement(document_, "rect", { width: 62, height: 48, rx: 10 }),
      svgText(document_, signal.emission.slice(0, 8), 31, 30,
        "rd-encoder-product-signal-label", "middle"),
    );
    svg.append(key);
  });
  if (visibleSignals.length === 0) {
    svg.append(svgText(document_, "Run a button test to see this device’s keys", 500, 383,
      "rd-encoder-product-empty", "middle"));
  } else if (observations.length > visibleSignals.length) {
    svg.append(svgText(document_, `+${observations.length - visibleSignals.length} more`, 900, 417,
      "rd-encoder-product-maker", "end"));
  }
  svg.append(svgText(
    document_,
    declaredLabels.length > 0
      ? `${declaredLabels.length} user-declared labels · terminal capacity still unknown`
      : "No terminal layout has been invented",
    500, 444, "rd-encoder-product-read-state", "middle",
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
  radioGroupName: string,
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
    radio.name = radioGroupName;
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
  presentation: "research" | "product" = "research",
): HTMLDetailsElement {
  const details = html(document_, "details", "rd-encoder-profile-roster");
  details.dataset.profileId = profile.id;
  if (presentation === "product") details.dataset.rdEncoderDisclosure = "terminal-roster";
  if (chart) details.dataset.chartLoaded = "true";
  const summary = html(document_, "summary");
  summary.textContent = presentation === "product"
    ? profile.topology.capacity.kind === "exact"
      ? `All terminal assignments · ${profile.topology.terminals.length}`
      : `All profile controls · ${profile.topology.terminals.length}`
    : chart
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
  presentation: "research" | "product" = "research",
  draft = currentLabels.join(", "),
  onDraftChange: (value: string) => void = () => undefined,
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-manual");
  panel.dataset.manualProfileBuilder = "";
  const copy = html(document_, "div");
  const heading = html(document_, "h3");
  heading.textContent = presentation === "product" ? "Define this board’s controls" : "Build an honest fallback";
  const note = html(document_, "p");
  note.textContent = presentation === "product"
    ? "Add labels printed on the board or in its manual. Then use the button test to see which keyboard keys reach Windows. KSX keeps those facts separate; a selector-scoped one-button teach step will join them in the mapping block."
    : "Enter labels printed on the board or its manual. These become user-declared slots only; pressing buttons cannot reveal terminal capacity or wiring.";
  copy.append(heading, note);
  const field = html(document_, "label");
  field.textContent = "Printed terminal labels";
  const input = html(document_, "textarea");
  input.rows = 2;
  input.placeholder = "UP, DOWN, LEFT, RIGHT, SW1, SW2 …";
  input.value = draft;
  input.dataset.rdEncoderManualLabels = "";
  input.addEventListener("input", () => onDraftChange(input.value));
  field.append(input);
  const button = html(document_, "button");
  button.type = "button";
  button.textContent = presentation === "product" ? "Build control list" : "Apply declared labels";
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
  presentation: "research" | "product" = "research",
  hardwareAvailable = true,
  hardwareUnavailableReason = "",
  hardwareUnavailableLabel = "Wait for device",
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-read");
  panel.dataset.rdEncoderChart = "";
  panel.dataset.state = state.kind;
  const copy = html(document_, "div", "rd-encoder-profile-read-copy");
  const heading = html(document_, "h3");
  heading.textContent = presentation === "product" ? "Stored assignments on this encoder" : "Configured emissions";
  const description = html(document_, "p");
  const canRead = chartReadIsAdmitted(result, selection);
  description.textContent = !hardwareAvailable && presentation === "product"
    ? hardwareUnavailableReason || "Wait until KSX confirms this device before reading it."
    : canRead
      ? presentation === "product"
      ? "A fresh + Devices Add reads the stored output once. Restored boards wait for Read; use Refresh after changing assignments in WinIPAC or another encoder utility. Nothing is written."
      : "Ask this exact board what each terminal is configured to emit. Read only: this does not map controls, write firmware, or prove a wire."
    : selection.device
      ? presentation === "product"
        ? "KSX cannot read stored assignments from this model yet. You can still test the signals it sends."
        : "This exact release has no admitted KSX chart reader. Its sourced topology remains visible, but no stored emissions are guessed."
      : "Connect an exact backend-supported board to read stored emissions. Catalog profiles never authorize a hardware protocol.";
  if (presentation === "product") {
    const help = html(document_, "details", "rd-encoder-command-help");
    help.dataset.rdEncoderDisclosure = "read-help";
    const helpSummary = html(document_, "summary");
    helpSummary.textContent = "How board reads work";
    help.append(helpSummary, description);
    copy.append(heading, help);
  } else copy.append(heading, description);

  const controls = html(document_, "div", "rd-encoder-profile-read-controls");
  if (canRead) {
    const button = html(document_, "button");
    button.type = "button";
    button.dataset.rdEncoderRead = "";
    // Product mode has one read command. It carries both stable focus hooks so
    // a retry triggered from the old inspector contract returns to this exact
    // command without rendering a second competing CTA.
    if (presentation === "product") button.dataset.rdEncoderInspectorRead = "";
    button.disabled = !hardwareAvailable || state.kind === "loading" || observationBlock !== null;
    button.textContent = !hardwareAvailable
      ? hardwareUnavailableLabel
      : observationBlock !== null
      ? observationBlock === "listening" || observationBlock === "unknown" ||
          observationBlock === "stopping"
        ? "Stop observation first"
        : observationBlock === "foreign-live"
          ? "Observation lease busy"
          : "Wait for observation"
      : state.kind === "loading"
      ? "Reading…"
      : state.kind === "error"
        ? presentation === "product" ? "Retry stored-assignment read" : "Read again"
      : state.kind === "loaded"
        ? presentation === "product" ? "Refresh stored assignments" : "Read again"
        : presentation === "product" ? "Read stored assignments" : "Read configured emissions";
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
    headline.textContent = presentation === "product"
      ? `${state.snapshot.terminals.length} terminal assignments read from the encoder.`
      : `Read ${state.snapshot.terminals.length} exact terminals from ${state.snapshot.boardName}.`;
    const freshness = html(document_, "p");
    const time = html(document_, "time");
    time.dateTime = state.snapshot.readAt;
    const readDate = new Date(state.snapshot.readAt);
    time.textContent = Number.isNaN(readDate.getTime())
      ? "Read this session"
      : `Read at ${readDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    time.title = state.snapshot.readAt;
    freshness.append(time);
    if (presentation === "research") {
      freshness.append(document_.createTextNode(
        ` · proof ${state.snapshot.imageSha256.slice(0, 16)} · not watched; read again after WinIPAC changes.`,
      ));
    } else {
      freshness.append(document_.createTextNode(" · refresh after changing keys in the encoder software."));
    }
    const shift = html(document_, "p");
    shift.textContent = encoderChartShiftSentence(state.snapshot.shift);
    status.append(headline, freshness, shift);
    if (presentation === "research" && state.snapshot.notes.length > 0) {
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
      ? presentation === "product" ? "Waiting to read stored assignments from this encoder." :
        "Not read. Opening this lab never talks to encoder configuration hardware."
      : "No configuration read is available for this selection.";
  }
  controls.append(status);
  if (!hardwareAvailable && presentation === "product" && hardwareUnavailableReason) {
    const blocked = html(document_, "p", "rd-encoder-command-blocked");
    blocked.textContent = hardwareUnavailableReason;
    controls.append(blocked);
  }
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
  presentation: "research" | "product" = "research",
): void {
  status.replaceChildren();
  status.dataset.state = state.kind;
  const view = observationView(state);
  if (state.kind === "reconciling") {
    status.textContent = presentation === "product"
      ? "Checking whether another button test is already running…"
      : "Checking whether the daemon already owns an observation…";
  } else if (state.kind === "starting") {
    status.textContent = presentation === "product"
      ? "Starting the button test for this device…"
      : "Asking the daemon to listen to this exact device…";
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
    detail.textContent = view.error || view.detail || (presentation === "product"
      ? "Press the cabinet buttons. Matching configured keys light on the board; duplicate key assignments may light more than one terminal."
      : "Duplicate terminal assignments collapse to one signal; no terminal association is inferred.");
    const metrics = html(document_, "dl", "rd-encoder-profile-observe-metrics");
    if (presentation === "research") {
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
    status.append(headline, detail);
    if (presentation === "research") status.append(metrics);
    status.append(signalRows);
    if (presentation === "research") {
      const provenance = html(document_, "p", "rd-encoder-profile-observe-provenance");
      provenance.textContent = `Exact selector: ${view.selector ?? selection.device?.selector ?? "unavailable"} · terminal association: none · rollover visibility: ${view.rollover_visibility || "unavailable"}.`;
      status.append(provenance);
    }
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
      ? presentation === "product"
        ? "Not testing. Start when you are ready to press the wired controls."
        : "Not listening. Opening or changing this lab never starts input capture."
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
  presentation: "research" | "product" = "research",
  hardwareAvailable = true,
  hardwareUnavailableReason = "",
): HTMLElement {
  const panel = html(document_, "section", "rd-encoder-profile-observe");
  panel.dataset.rdEncoderObservation = "";
  panel.dataset.state = state.kind;
  const currentView = observationView(state);
  if (currentView) panel.dataset.backendState = currentView.state;
  if (selection.device) panel.dataset.selector = selection.device.selector;
  const copy = html(document_, "div", "rd-encoder-profile-observe-copy");
  const heading = html(document_, "h3");
  heading.textContent = presentation === "product" ? "Test your buttons" : "Observed host signals";
  const description = html(document_, "p");
  description.textContent = !hardwareAvailable && presentation === "product"
    ? hardwareUnavailableReason || "Wait until KSX confirms this device before starting a button test."
    : selection.device
    ? presentation === "product"
      ? "Listen for 30 seconds and press the wired controls. This shows the keys reaching Windows; controller mapping comes next."
      : "Listen to this exact device for 30 seconds. Signals are device-scoped evidence—not terminals, wiring, capacity, or a KSX mapping. Tab stays inside Capture/Done; Ctrl/Cmd+Enter activates Done; Esc leaves Capture without stopping. Windows and system shortcuts can still escape."
    : "Choose a connected encoder to observe what reaches Windows. Reference profiles cannot emit live evidence.";
  if (presentation === "product") {
    const help = html(document_, "details", "rd-encoder-command-help");
    help.dataset.rdEncoderDisclosure = "test-help";
    const helpSummary = html(document_, "summary");
    helpSummary.textContent = "How button testing works";
    help.append(helpSummary, description);
    copy.append(heading, help);
  } else copy.append(heading, description);
  panel.append(copy);

  const controls = html(document_, "div", "rd-encoder-profile-observe-controls");
  if (selection.device) {
    const listening = state.kind === "listening" || state.kind === "unknown";
    const captureActive = listening || state.kind === "starting" || state.kind === "stopping";
    const actions = html(document_, "div", "rd-encoder-profile-observe-actions");
    const start = html(document_, "button");
    start.type = "button";
    start.dataset.rdEncoderObserve = "start";
    start.disabled = !hardwareAvailable || state.kind === "reconciling" || state.kind === "starting" ||
      state.kind === "stopping" || listening || blockedByChart;
    start.textContent = !hardwareAvailable
      ? "Wait for device"
      : blockedByChart
      ? "Wait for chart read"
      : state.kind === "reconciling"
      ? "Checking…"
      : state.kind === "starting"
      ? "Starting…"
      : state.kind === "foreign-live"
        ? "Recheck observation lease"
        : state.kind === "complete"
          ? presentation === "product" ? "Test again" : "Check and observe again"
          : presentation === "product" ? "Start button test" : "Observe emitted signals";
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
      stop.textContent = presentation === "product" ? "Done" : "Done — stop listening";
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
  paintSignalObservationStatus(document_, status, selection, state, presentation);
  controls.append(status);
  if (!hardwareAvailable && presentation === "product" && hardwareUnavailableReason) {
    const blocked = html(document_, "p", "rd-encoder-command-blocked");
    blocked.textContent = hardwareUnavailableReason;
    controls.append(blocked);
  }
  panel.append(controls);
  return panel;
}

function dynamicProfileContent(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  declaredLabels: readonly string[],
  declaredLabelsDraft: string,
  chartState: ChartReadState,
  observationState: SignalObservationState,
  onConfirm: (profileId: EncoderVisualProfileId) => void,
  onDeclaredLabels: (labels: readonly string[]) => void,
  onDeclaredLabelsDraft: (value: string) => void,
  onReadChart: () => void,
  onStartObservation: () => void,
  onStopObservation: () => void,
  onEscapeObservationCapture: () => void,
  candidateRadioGroupName: string,
): HTMLElement {
  const region = html(document_, "div", "rd-encoder-profile-dynamic");
  region.dataset.rdEncoderEvidence = "";
  region.dataset.evidenceState = result.resolution;
  region.dataset.profileId = result.profile.id;
  if (selection.device) region.dataset.sourceSelector = selection.device.selector;
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
  const candidate = candidateConfirmation(document_, result, candidateRadioGroupName, onConfirm);
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
    region.append(manualFallback(
      document_, declaredLabels, onDeclaredLabels, "research",
      declaredLabelsDraft, onDeclaredLabelsDraft,
    ));
  }
  return region;
}

function appendProductPill(
  document_: Document,
  container: HTMLElement,
  label: string,
  tone: "connected" | "recognized" | "ready" | "attention" = "ready",
): void {
  const pill = html(document_, "span", "rd-encoder-product-pill");
  pill.dataset.tone = tone;
  pill.textContent = label;
  container.append(pill);
}

function productTerminalInspector(
  document_: Document,
  result: EncoderDetectionResult,
  chartState: ChartReadState,
  selectedTerminalId: string | undefined,
  observationState: SignalObservationState,
): HTMLElement {
  const inspector = html(document_, "aside", "rd-encoder-product-inspector");
  inspector.dataset.rdEncoderTerminalInspector = "";
  inspector.dataset.layout = "strip";
  const profile = result.profile;
  const terminal = profile.topology.terminals.find((value) => value.id === selectedTerminalId) ??
    profile.topology.terminals[0];
  if (!terminal) {
    const heading = html(document_, "h3");
    heading.textContent = "No verified terminal layout";
    const copy = html(document_, "p");
    copy.textContent = "Test the device to see its keyboard signals, then define only the controls you can verify.";
    inspector.append(heading, copy);
    return inspector;
  }
  inspector.dataset.selectedTerminalId = terminal.id;
  const chart = chartState.kind === "loaded" ? chartState.snapshot : null;
  const chartByTerminal = encoderChartTerminalMap(chart);
  const configured = chartByTerminal.get(terminal.id);
  const view = observationView(observationState);
  const held = new Set(view?.held ?? []);
  const seen = new Set(view?.seen ?? []);
  const normalKey = configured?.normal.key?.trim() ?? "";
  const shiftedAssignmentsReachable = chartShiftedAssignmentsReachable(chart);
  const shiftedKey = shiftedAssignmentsReachable
    ? configured?.shifted.key?.trim() ?? ""
    : "";
  const isHeld = Boolean((normalKey && held.has(normalKey)) || (shiftedKey && held.has(shiftedKey)));
  const isSeen = Boolean((normalKey && seen.has(normalKey)) || (shiftedKey && seen.has(shiftedKey)));
  inspector.dataset.liveState = isHeld ? "held" : isSeen ? "seen" : "idle";

  const eyebrow = html(document_, "p", "rd-encoder-product-inspector-eyebrow");
  eyebrow.textContent = `${terminal.identityScope === "logical-control"
    ? "Selected logical control"
    : terminal.presence === "variant-only" ? "Selected variant terminal" : "Selected terminal"} · ${groupLabel(terminal.groupId)}`;
  const headingRow = html(document_, "div", "rd-encoder-product-inspector-heading");
  const heading = html(document_, "h3");
  heading.textContent = terminal.label;
  const id = html(document_, "code");
  id.textContent = terminal.id;
  headingRow.append(heading, id);

  const emissions = html(document_, "dl", "rd-encoder-product-emissions");
  const appendEmission = (label: string, value: string, tone: string): void => {
    const row = html(document_, "div");
    row.dataset.tone = tone;
    const term = html(document_, "dt");
    term.textContent = label;
    const definition = html(document_, "dd");
    const keycap = html(document_, "kbd", "rd-encoder-product-keycap");
    keycap.textContent = value;
    definition.append(keycap);
    row.append(term, definition);
    emissions.append(row);
  };
  if (configured) {
    appendEmission(configured.normal.key?.trim() ? "Configured key" : "Stored output",
      encoderEmissionLabel(configured.normal),
      configured.normal.supported ? "configured" : "unknown");
    appendEmission(shiftedAssignmentsReachable && configured.shifted.key?.trim()
      ? "Configured shifted key" : "Stored shifted value",
    encoderEmissionLabel(configured.shifted),
      configured.shifted.supported ? "shifted" : "unknown");
  } else {
    const row = html(document_, "div");
    row.dataset.tone = chartState.kind === "error" ? "unknown" : "unread";
    const term = html(document_, "dt");
    term.textContent = "Stored assignment";
    const definition = html(document_, "dd");
    const state = html(document_, "span", "rd-encoder-product-read-inline");
    state.setAttribute("role", "status");
    state.classList.toggle("is-loading", chartState.kind === "loading");
    state.textContent = chartState.kind === "loading"
      ? "Reading…"
      : chartState.kind === "error"
        ? "Read needs attention"
        : "Not read yet";
    definition.append(state);
    row.append(term, definition);
    emissions.append(row);
  }

  const live = html(document_, "div", "rd-encoder-product-live");
  live.dataset.rdEncoderTerminalLive = "";
  live.dataset.state = isHeld ? "held" : isSeen ? "seen" : "idle";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  const liveDot = html(document_, "span");
  liveDot.setAttribute("aria-hidden", "true");
  const liveCopy = html(document_, "span");
  liveCopy.textContent = isHeld ? "Matching key held now" : isSeen ? "Matching key seen in this test" :
    view ? "Waiting for a matching key" : "Run a button test for live feedback";
  live.append(liveDot, liveCopy);

  const selectedKeys = new Set([normalKey, shiftedKey].filter(Boolean));
  if (selectedKeys.size > 0 && chart) {
    const shared = chart.terminals.filter((row) => {
      const rowKeys = [
        row.normal.key?.trim() ?? "",
        shiftedAssignmentsReachable ? row.shifted.key?.trim() ?? "" : "",
      ];
      return rowKeys.some((key) => key && selectedKeys.has(key));
    });
    if (shared.length > 1) {
      const warning = html(document_, "p", "rd-encoder-product-shared");
      warning.textContent = `Shared key assignment · ${shared.length} terminals match ${Array.from(selectedKeys).join(" / ")}. Give them unique keys in the encoder software before assigning separate controls.`;
      inspector.append(eyebrow, headingRow, emissions, live, warning);
    } else inspector.append(eyebrow, headingRow, emissions, live);
  } else inspector.append(eyebrow, headingRow, emissions, live);

  return inspector;
}

function productUnknownInspector(
  document_: Document,
  signals: readonly ObservedSignal[],
  observationsAreLive: boolean,
): HTMLElement {
  const inspector = html(document_, "aside", "rd-encoder-product-inspector is-unknown");
  inspector.dataset.rdEncoderTerminalInspector = "";
  inspector.dataset.layout = "strip";
  const eyebrow = html(document_, "p", "rd-encoder-product-inspector-eyebrow");
  eyebrow.textContent = "Generic setup";
  const heading = html(document_, "h3");
  heading.textContent = signals.length > 0 ? "Keys heard from this device" : "No keys tested yet";
  const copy = html(document_, "p");
  copy.textContent = signals.length > 0
    ? `${signals.length} unique keyboard signal${signals.length === 1 ? "" : "s"} ${observationsAreLive ? "reached Windows" : "are shown"}. They are not treated as discovered terminals.`
    : "Start a button test and press every wired control. KSX will show what the device emits without inventing its physical layout.";
  const chips = html(document_, "div", "rd-encoder-product-signal-chips");
  for (const signal of signals) {
    const chip = html(document_, "kbd", "rd-encoder-product-keycap");
    chip.textContent = signal.emission;
    chips.append(chip);
  }
  inspector.append(eyebrow, heading, copy, chips);
  return inspector;
}

function productDeviceMeta(device: EncoderProfileLabDevice | undefined, chartLoaded: boolean): string {
  const meta = device?.meta?.trim() ?? "";
  if (!meta || !chartLoaded) return meta;
  return meta.split(/\s*·\s*/).filter((part) => !/^chart\b/i.test(part.trim())).join(" · ");
}

function productDeviceDetails(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  chart: EncoderChartSnapshot | null,
  connectionConfirmed: boolean,
): HTMLDetailsElement {
  const details = html(document_, "details", "rd-encoder-product-details");
  details.dataset.rdEncoderDisclosure = "device-details";
  const summary = html(document_, "summary");
  summary.textContent = "Device details";
  const body = html(document_, "div", "rd-encoder-product-details-body");
  const facts = html(document_, "dl", "rd-encoder-product-device-facts");
  const append = (label: string, value: string): void => {
    const row = html(document_, "div");
    row.dataset.deviceFact = label.toLocaleLowerCase().replace(/\s+/g, "-");
    const term = html(document_, "dt");
    term.textContent = label;
    const definition = html(document_, "dd");
    definition.textContent = value;
    row.append(term, definition);
    facts.append(row);
  };
  const connectionLine = productDeviceMeta(selection.device, chart !== null);
  append("Device", selection.device?.name ?? result.profile.model);
  append("Connection", connectionConfirmed
    ? connectionLine || "Connected USB device"
    : "Unconfirmed — latest device scan did not answer");
  append("Detected model", result.profile.id === "unknown-hid"
    ? result.identity.familyLabel ?? "Not recognized"
    : `${result.profile.manufacturer} ${result.profile.model}`);
  append("Inputs", result.profile.topology.capacity.kind === "unknown"
    ? "Not known"
    : `${topologyValue(result.profile)} ${topologyUnit(result.profile)}`);
  append("Assignments", chart ? `${chart.terminals.length} read from the encoder this session` :
    result.protocol.chartRead === "supported" ? "Ready to read" : "Direct read unavailable");
  body.append(facts);

  const technical = html(document_, "details", "rd-encoder-product-technical");
  technical.dataset.rdEncoderDisclosure = "technical-evidence";
  const technicalSummary = html(document_, "summary");
  technicalSummary.textContent = "Technical evidence";
  const technicalFacts = html(document_, "dl", "rd-encoder-profile-facts");
  appendFact(document_, technicalFacts, "Resolution", resolutionLabel(result), result.identity.source);
  appendFact(document_, technicalFacts, "Topology", result.profile.topology.confidenceDetail,
    result.profile.topology.confidence);
  appendFact(document_, technicalFacts, "Protocol", protocolLabel(result), result.protocol.source);
  if (selection.device?.selector) {
    appendFact(document_, technicalFacts, "Exact selector", selection.device.selector, "backend-selector");
  }
  if (chart) {
    appendFact(document_, technicalFacts, "Latest chart proof",
      `${chart.imageSha256} · ${chart.readAt}`, "fresh-chart-read");
  }
  technical.append(technicalSummary, technicalFacts);
  if (result.warnings.length > 0) {
    const warnings = html(document_, "ul", "rd-encoder-product-warnings");
    for (const value of result.warnings) {
      const row = html(document_, "li");
      row.textContent = value;
      warnings.append(row);
    }
    technical.append(warnings);
  }
  const sources = html(document_, "ul", "rd-encoder-profile-sources");
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
  if (sources.childElementCount > 0) technical.append(sources);
  if (result.profile.id !== "unknown-hid" &&
      result.resolution !== "identity-conflict" && result.resolution !== "ambiguous-family") {
    technical.append(terminalRoster(document_, result.profile, chart, "product"));
  }
  body.append(technical);
  details.append(summary, body);
  return details;
}

function productDynamicContent(
  document_: Document,
  result: EncoderDetectionResult,
  selection: LabSelection,
  declaredLabels: readonly string[],
  declaredLabelsDraft: string,
  chartState: ChartReadState,
  observationState: SignalObservationState,
  selectedTerminalId: string | undefined,
  onSelectTerminal: (terminalId: string) => void,
  onConfirm: (profileId: EncoderVisualProfileId) => void,
  onDeclaredLabels: (labels: readonly string[]) => void,
  onDeclaredLabelsDraft: (value: string) => void,
  onReadChart: () => void,
  onStartObservation: () => void,
  onStopObservation: () => void,
  onEscapeObservationCapture: () => void,
  connectionConfirmed: boolean,
  chartHardwareBlock: EncoderHardwareActionLease | null,
  observationHardwareBlock: EncoderHardwareActionLease | null,
  hardwareActionOwner: symbol,
  candidateRadioGroupName: string,
): HTMLElement {
  const region = html(document_, "div", "rd-encoder-product-dynamic");
  region.dataset.rdEncoderEvidence = "";
  region.dataset.evidenceState = result.resolution;
  region.dataset.profileId = result.profile.id;
  if (selection.device) region.dataset.sourceSelector = selection.device.selector;
  const chart = chartState.kind === "loaded" ? chartState.snapshot : null;
  const view = observationView(observationState);
  const signals = observedSignals(selection, observationState);
  const observationsAreLive = view !== null;
  const known = result.profile.id !== "unknown-hid" &&
    result.resolution !== "identity-conflict" && result.resolution !== "ambiguous-family";
  const selected = known
    ? result.profile.topology.terminals.find((terminal) => terminal.id === selectedTerminalId)?.id ??
      result.profile.topology.terminals[0]?.id
    : undefined;
  const observationBusy = observationState.kind === "reconciling" ||
    observationState.kind === "starting" || observationState.kind === "listening" ||
    observationState.kind === "stopping" || observationState.kind === "unknown" ||
    observationState.kind === "foreign-live";
  const chartHardwareAvailable = connectionConfirmed && chartHardwareBlock === null;
  const observationAvailable = connectionConfirmed && observationHardwareBlock === null;
  const hardwareBlockCopy = (lease: EncoderHardwareActionLease | null): string => {
    if (!connectionConfirmed) {
      return "The latest device scan did not answer. Existing results stay visible, but a new hardware action waits for a confirmed scan.";
    }
    if (!lease) return "";
    if (lease.owner === hardwareActionOwner) {
      return lease.kind === "chart"
        ? "The previous stored-assignment read is still settling. Wait for it before starting another hardware action."
        : "The previous button-test request is still settling. Wait for its exact cleanup before starting another hardware action.";
    }
    return lease.kind === "chart"
      ? "Another encoder is reading its stored assignments. Finish that read before starting this action."
      : "A button test is active for another encoder. Finish it before starting this action.";
  };
  const chartUnavailableLabel = !connectionConfirmed
    ? "Wait for device"
    : observationBusy
      ? "Stop button test first"
      : chartHardwareBlock?.kind === "chart"
        ? chartHardwareBlock.owner === hardwareActionOwner
          ? "Wait for prior read"
          : "Another encoder is reading"
        : chartHardwareBlock?.kind === "observation"
          ? "Wait for button test"
          : "Wait to read";

  const status = html(document_, "div", "rd-encoder-product-status");
  status.dataset.layout = "summary";
  if (!connectionConfirmed) {
    appendProductPill(document_, status, "Connection unconfirmed", "attention");
  }
  const identitySummary = result.resolution === "manual"
    ? `User confirmed · ${productTopologyLabel(result.profile)}`
    : `Recognized · ${productTopologyLabel(result.profile)}`;
  appendProductPill(document_, status, known
    ? identitySummary
    : result.resolution === "ambiguous-family"
      ? "Confirm model · capacity unknown"
      : "Generic setup · capacity unknown",
  known ? result.resolution === "manual" ? "ready" : "recognized" : "attention");
  const assignmentState = chart
    ? "stored assignments loaded"
    : chartState.kind === "loading" ? "Reading stored assignments"
    : chartState.kind === "error" ? "Stored-assignment read needs attention"
    : result.protocol.chartRead === "supported" ? "stored assignments ready" : "test emitted keys";
  appendProductPill(document_, status,
    connectionConfirmed ? `Connected · ${assignmentState}` : assignmentState,
  chart ? "recognized" : chartState.kind === "error" ? "attention" : "ready");
  region.append(status);

  const candidate = candidateConfirmation(document_, result, candidateRadioGroupName, onConfirm);
  if (candidate) region.append(candidate);

  const work = html(document_, "div", "rd-encoder-product-work");
  const figure = html(document_, "figure", "rd-encoder-product-figure");
  figure.append(known
    ? renderProductProfileSvg(document_, result, chart, {
      selectedTerminalId: selected,
      observedSignals: new Set(view?.seen ?? []),
      heldSignals: new Set(view?.held ?? []),
      onSelect: onSelectTerminal,
    })
    : renderProductUnknownSvg(document_, result, signals, declaredLabels, observationsAreLive));
  const caption = html(document_, "figcaption");
  caption.textContent = known
    ? result.profile.topology.capacity.kind === "exact"
      ? chart
        ? "Select a terminal to inspect its stored key. Lit terminals match keys heard during Button Test."
        : "Select a terminal, then read stored assignments to reveal its output."
      : "Select a documented control to inspect exactly what KSX knows."
    : "Declared controls and keys heard from this exact device remain separate facts.";
  figure.append(caption);
  work.append(
    figure,
    known
      ? productTerminalInspector(
        document_, result, chartState, selected, observationState,
      )
      : productUnknownInspector(document_, signals, observationsAreLive),
  );
  region.append(work);

  const actions = html(document_, "div", "rd-encoder-product-actions");
  actions.dataset.layout = "dock";
  actions.append(
    chartReadPanel(document_, result, selection, chartState,
      observationBusy ? observationState.kind : null, onReadChart, "product",
      chartHardwareAvailable, hardwareBlockCopy(chartHardwareBlock), chartUnavailableLabel),
    signalObservationPanel(document_, selection, observationState, chartState.kind === "loading",
      onStartObservation, onStopObservation, onEscapeObservationCapture, "product",
      observationAvailable, hardwareBlockCopy(observationHardwareBlock)),
  );
  region.append(actions);
  if (!known && (result.resolution === "unrecognised" || result.resolution === "known-family" ||
      result.resolution === "identity-conflict")) {
    region.append(manualFallback(
      document_, declaredLabels, onDeclaredLabels, "product",
      declaredLabelsDraft, onDeclaredLabelsDraft,
    ));
  }
  region.append(productDeviceDetails(document_, result, selection, chart, connectionConfirmed));
  return region;
}

interface ProfileLabContentController {
  content: HTMLElement;
  updateConnectedEncoders: (devices: readonly EncoderProfileLabDevice[]) => void;
  setConnectionConfirmed: (confirmed: boolean) => void;
  dispose: () => void;
}

function connectedDevicesSignature(devices: readonly EncoderProfileLabDevice[]): string {
  return JSON.stringify(devices.map((device) => ({
    selector: device.selector,
    name: device.name,
    alias: device.alias ?? "",
    meta: device.meta ?? "",
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
  readStoredAssignmentsOnMount = false,
): ProfileLabContentController {
  const presentation = options.presentation ?? "research";
  const candidateRadioGroupName = `rd-encoder-profile-candidate-${++encoderSurfaceSequence}`;
  const makeSelections = (devices: readonly EncoderProfileLabDevice[] = []): LabSelection[] => {
    const built = buildSelections(devices);
    return presentation === "product"
      ? built.filter((selection) => selection.group === "connected")
      : built;
  };
  let connectedSignature = connectedDevicesSignature(options.connectedEncoders ?? []);
  let selections = makeSelections(options.connectedEncoders);
  const initialCatalog = options.initialProfileId ? `${CATALOG_PREFIX}${options.initialProfileId}` : "";
  const defaultSelection = (): LabSelection | undefined =>
    selections.find((selection) => selection.group === "connected") ??
      selections.find((selection) => selection.value === `${CATALOG_PREFIX}ultimarc-ipac4`) ??
      selections[0];
  let current = selections.find((selection) => selection.value === initialCatalog) ?? defaultSelection();
  if (!current) throw new Error(presentation === "product"
    ? "encoder workbench surface requires one connected device"
    : "encoder profile lab has no selections");
  let confirmedCandidate: EncoderVisualProfileId | undefined;
  let declaredLabels: readonly string[] = [];
  let declaredLabelsDraft = "";
  let selectedTerminalId: string | undefined;
  let chartState: ChartReadState = { kind: "idle" };
  let chartRequestEpoch = 0;
  let activeChartReadFocusTarget: ChartReadFocusTarget | null = null;
  let pageShowChartFocusTarget: ChartReadFocusTarget | null = null;
  let observationState: SignalObservationState = { kind: "idle" };
  let observationOwnership: { selector: string; generation: number } | null = null;
  let observationRequestEpoch = 0;
  let observationPollTimer: number | undefined;
  let pageHiding = false;
  let announcementFrame = 0;
  let connectionConfirmed = true;
  // Only a fresh `+ Devices` Add gesture may set this. A product surface also
  // mounts during restore/reconnect, but those passive lifecycles must never
  // acquire the machine-wide programming lease.
  let automaticChartReadPending = presentation === "product" && readStoredAssignmentsOnMount;
  let automaticChartReadFrame = 0;
  const hardwareActionOwner = Symbol("encoder-workbench-surface");
  const hardwareActionHolds: Record<EncoderHardwareActionKind, Set<symbol>> = {
    chart: new Set<symbol>(),
    observation: new Set<symbol>(),
  };
  let observationSessionHold: symbol | null = null;
  const acquireHardwareActionHold = (
    kind: EncoderHardwareActionKind,
    selector: string,
  ): symbol | null => {
    if (!claimEncoderHardwareAction(hardwareActionOwner, kind, selector)) return null;
    const hold = Symbol(`encoder-${kind}-hold`);
    hardwareActionHolds[kind].add(hold);
    return hold;
  };
  const releaseHardwareActionHold = (
    kind: EncoderHardwareActionKind,
    hold: symbol | null,
  ): void => {
    if (!hold || !hardwareActionHolds[kind].delete(hold)) return;
    if (hardwareActionHolds[kind].size === 0) {
      releaseEncoderHardwareAction(hardwareActionOwner, kind);
    }
  };
  const releaseObservationSessionHold = (): void => {
    const hold = observationSessionHold;
    observationSessionHold = null;
    releaseHardwareActionHold("observation", hold);
  };
  const ownedSettlingHardwareAction = (
    kind: EncoderHardwareActionKind,
  ): EncoderHardwareActionLease | null => {
    if (hardwareActionHolds[kind].size === 0) return null;
    const active = encoderHardwareActionLease;
    return active?.owner === hardwareActionOwner && active.kind === kind ? active : null;
  };
  const content = html(document_, "section", "rd-encoder-profile");
  content.dataset.formaRuntimeHost = "";
  content.dataset.rdEncoderLab = "";
  content.dataset.presentation = presentation;
  const header = html(document_, "header", "rd-encoder-profile-head");
  const headingCopy = html(document_, "div", "rd-encoder-profile-heading-copy");
  const eyebrow = html(document_, "p", "rd-encoder-profile-eyebrow");
  eyebrow.textContent = presentation === "product"
    ? "Terminal workbench"
    : "Encoder profile lab · research-backed preview";
  const title = html(document_, "h2", "rd-encoder-profile-title");
  const subtitle = html(document_, "p", "rd-encoder-profile-subtitle");
  headingCopy.append(eyebrow, title, subtitle);
  const safety = html(document_, "span", "rd-encoder-profile-safety");
  safety.textContent = presentation === "product"
    ? "Connected · read only"
    : "Explicit reads only · never writes";
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
  liveStatus.tabIndex = -1;
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
    title.textContent = presentation === "product"
      ? result.profile.id === "unknown-hid"
        ? "Generic encoder workspace"
        : `${result.profile.shortLabel} terminal map`
      : result.profile.id === "unknown-hid"
        ? current.device?.name ?? result.identity.familyLabel ?? result.profile.model
        : `${result.profile.manufacturer} ${result.profile.model}`;
    subtitle.textContent = presentation === "product"
      ? result.profile.id === "unknown-hid"
        ? "Declare printed controls and test keys without inventing terminal wiring."
        : `${productTopologyLabel(result.profile)} · stored outputs and live signals stay separate until mapping`
      : result.resolution === "ambiguous-family" ||
          result.resolution === "known-family" || result.resolution === "identity-conflict"
        ? result.warnings[0] ?? result.profile.summary
        : result.profile.summary;
    content.dataset.profileId = result.profile.id;
    content.dataset.evidenceState = result.resolution;
    content.dataset.connectionConfirmed = connectionConfirmed ? "true" : "false";
    safety.textContent = presentation === "product"
      ? connectionConfirmed ? "Connected · read only" : "Connection unconfirmed · results preserved"
      : "Explicit reads only · never writes";
  };
  const focusProductTerminal = (terminalId: string): void => {
    document_.defaultView?.requestAnimationFrame(() => {
      const terminals = Array.from(
        dynamicHost.querySelectorAll<SVGGElement>("[data-terminal-id]"),
      );
      terminals.find((terminal) => terminal.dataset.terminalId === terminalId)
        ?.focus({ preventScroll: true });
    });
  };
  const focusProductTerminalOrWidget = (): void => {
    document_.defaultView?.requestAnimationFrame(() => {
      const preferred = selectedTerminalId
        ? Array.from(dynamicHost.querySelectorAll<SVGGElement>("[data-terminal-id]"))
          .find((terminal) => terminal.dataset.terminalId === selectedTerminalId) ?? null
        : null;
      const terminal = preferred ??
        dynamicHost.querySelector<SVGGElement>('[data-terminal-id][tabindex="0"]');
      if (terminal) terminal.focus({ preventScroll: true });
      else content.closest<HTMLElement>(".widget-instance")?.focus({ preventScroll: true });
    });
  };
  const restoreChartReadFocus = (
    target: ChartReadFocusTarget,
    allowVisibleFallback = false,
  ): void => {
    document_.defaultView?.requestAnimationFrame(() => {
      const selector = target === "inspector"
        ? "[data-rd-encoder-inspector-read]"
        : "[data-rd-encoder-read]";
      const button = dynamicHost.querySelector<HTMLButtonElement>(selector);
      if (button && !button.disabled) {
        button.focus({ preventScroll: true });
        return;
      }
      if (!allowVisibleFallback) return;
      if (target === "inspector") {
        const preferred = selectedTerminalId
          ? Array.from(dynamicHost.querySelectorAll<SVGGElement>("[data-terminal-id]"))
            .find((terminal) => terminal.dataset.terminalId === selectedTerminalId) ?? null
          : null;
        const terminal = preferred ??
          dynamicHost.querySelector<SVGGElement>('[data-terminal-id][tabindex="0"]');
        if (terminal) {
          terminal.focus({ preventScroll: true });
          return;
        }
      }
      content.closest<HTMLElement>(".widget-instance")?.focus({ preventScroll: true });
    });
  };
  const confirmProfile = (profileId: EncoderVisualProfileId): void => {
    confirmedCandidate = profileId;
    selectedTerminalId = undefined;
    repaint();
    scheduleAutomaticChartRead();
    document_.defaultView?.requestAnimationFrame(() => {
      if (presentation === "product") {
        dynamicHost.querySelector<SVGGElement>('[data-terminal-id][tabindex="0"]')
          ?.focus({ preventScroll: true });
      } else select.focus({ preventScroll: true });
    });
  };
  const applyDeclaredLabels = (labels: readonly string[]): void => {
    declaredLabels = labels;
    repaint();
    document_.defaultView?.requestAnimationFrame(() => {
      dynamicHost.querySelector<HTMLTextAreaElement>("[data-rd-encoder-manual-labels]")
        ?.focus({ preventScroll: true });
    });
  };
  const escapeObservationCapture = (): void => {
    if (observationState.kind === "starting") {
      observationRequestEpoch += 1;
      clearObservationPoll();
      observationState = {
        kind: "error",
        message: "Capture focus was released while start is still resolving. KSX will release any exact generation returned by that request.",
      };
      // Clear the visible capture session now, but keep the request hold until
      // the late start response and any exact-generation cleanup have settled.
      releaseObservationSessionHold();
      repaint();
      announce("Capture focus released. Any late exact start generation will be cancelled.");
      if (presentation === "product") focusProductTerminalOrWidget();
      else focusObservationStart();
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
    if (presentation === "product") focusProductTerminalOrWidget();
    else select.focus({ preventScroll: true });
  };
  function repaint(): void {
    const openProductDisclosures = presentation === "product"
      ? new Set<string>(Array.from(
        dynamicHost.querySelectorAll<HTMLDetailsElement>("details[open][data-rd-encoder-disclosure]"),
      ).map((details) => details.dataset.rdEncoderDisclosure)
        .filter((value): value is string => Boolean(value)))
      : new Set<string>();
    const activeManualInput = document_.activeElement instanceof HTMLTextAreaElement &&
        document_.activeElement.matches("[data-rd-encoder-manual-labels]")
      ? document_.activeElement
      : null;
    const manualSelection = activeManualInput ? {
      start: activeManualInput.selectionStart,
      end: activeManualInput.selectionEnd,
      direction: activeManualInput.selectionDirection,
      scrollTop: activeManualInput.scrollTop,
      scrollLeft: activeManualInput.scrollLeft,
    } : null;
    const result = selectedDetection(current, confirmedCandidate);
    paintHeader(result);
    const observationLeaseIsVisible = observationState.kind === "reconciling" ||
      observationState.kind === "starting" || observationState.kind === "listening" ||
      observationState.kind === "stopping" || observationState.kind === "unknown" ||
      observationState.kind === "foreign-live";
    const chartHardwareBlock = encoderHardwareActionBlockedFor(hardwareActionOwner, "chart") ??
      (chartState.kind === "loading" ? null : ownedSettlingHardwareAction("chart"));
    const observationHardwareBlock =
      encoderHardwareActionBlockedFor(hardwareActionOwner, "observation") ??
      (observationLeaseIsVisible ? null : ownedSettlingHardwareAction("observation"));
    const selectedStillExists = result.profile.topology.terminals.some(
      (terminal) => terminal.id === selectedTerminalId,
    );
    if (!selectedStillExists) selectedTerminalId = result.profile.topology.terminals[0]?.id;
    const nextDynamicContent = presentation === "product"
      ? productDynamicContent(
        document_, result, current, declaredLabels, declaredLabelsDraft, chartState, observationState,
        selectedTerminalId,
        (terminalId) => {
          selectedTerminalId = terminalId;
          repaint();
          focusProductTerminal(terminalId);
        },
        confirmProfile,
        applyDeclaredLabels,
        (value) => { declaredLabelsDraft = value; },
        () => { void readCurrentChart(); },
        () => { void startCurrentObservation(); },
        () => { void stopCurrentObservation(); },
        escapeObservationCapture,
        connectionConfirmed,
        chartHardwareBlock,
        observationHardwareBlock,
        hardwareActionOwner,
        candidateRadioGroupName,
      )
      : dynamicProfileContent(
        document_, result, current, declaredLabels, declaredLabelsDraft, chartState, observationState,
        confirmProfile,
        applyDeclaredLabels,
        (value) => { declaredLabelsDraft = value; },
        () => { void readCurrentChart(); },
        () => { void startCurrentObservation(); },
        () => { void stopCurrentObservation(); },
        escapeObservationCapture,
        candidateRadioGroupName,
      );
    dynamicHost.replaceChildren(nextDynamicContent);
    if (openProductDisclosures.size > 0) {
      for (const details of dynamicHost.querySelectorAll<HTMLDetailsElement>(
        "details[data-rd-encoder-disclosure]",
      )) {
        if (openProductDisclosures.has(details.dataset.rdEncoderDisclosure)) details.open = true;
      }
    }
    if (manualSelection) {
      const replacement = dynamicHost.querySelector<HTMLTextAreaElement>(
        "[data-rd-encoder-manual-labels]",
      );
      if (replacement) {
        replacement.focus({ preventScroll: true });
        replacement.setSelectionRange(
          Math.min(manualSelection.start, replacement.value.length),
          Math.min(manualSelection.end, replacement.value.length),
          manualSelection.direction ?? undefined,
        );
        replacement.scrollTop = manualSelection.scrollTop;
        replacement.scrollLeft = manualSelection.scrollLeft;
      }
    }
    announce(presentation === "product"
      ? `${result.profile.id === "unknown-hid" ? "Generic encoder setup" : "Recognized encoder"}. ${
        chartState.kind === "loaded" ? `${chartState.snapshot.terminals.length} assignments loaded.` :
          "No hardware was changed."
      }`
      : `${resolutionLabel(result)}. ${result.warnings[0] ?? result.profile.topology.confidenceDetail}`);
  }
  const clearObservationPoll = (): void => {
    const view = document_.defaultView;
    if (observationPollTimer !== undefined && view) view.clearTimeout(observationPollTimer);
    observationPollTimer = undefined;
  };
  const patchProductSignalState = (): void => {
    if (presentation !== "product") return;
    const view = observationView(observationState);
    const seen = new Set(view?.seen ?? []);
    const held = new Set(view?.held ?? []);
    for (const terminal of Array.from(
      dynamicHost.querySelectorAll<SVGGElement>("[data-terminal-id]"),
    )) {
      const normal = terminal.dataset.configuredKey ?? "";
      const shifted = terminal.dataset.configuredShiftKey ?? "";
      const isSeen = Boolean((normal && seen.has(normal)) || (shifted && seen.has(shifted)));
      const isHeld = Boolean((normal && held.has(normal)) || (shifted && held.has(shifted)));
      terminal.classList.toggle("is-seen", isSeen);
      terminal.classList.toggle("is-held", isHeld);
      const ariaBase = terminal.dataset.terminalAriaBase ?? terminal.dataset.terminalLabel ?? "Terminal";
      const nextAriaLabel = `${ariaBase}${isHeld
        ? " Matching key held now."
        : isSeen ? " Matching key seen during this test." : ""}`;
      if (terminal.getAttribute("aria-label") !== nextAriaLabel) {
        terminal.setAttribute("aria-label", nextAriaLabel);
      }
    }
    const selected = dynamicHost.querySelector<SVGGElement>(
      ".rd-encoder-product-terminal.is-selected",
    );
    const live = dynamicHost.querySelector<HTMLElement>("[data-rd-encoder-terminal-live]");
    if (!live) return;
    const normal = selected?.dataset.configuredKey ?? "";
    const shifted = selected?.dataset.configuredShiftKey ?? "";
    const isSeen = Boolean((normal && seen.has(normal)) || (shifted && seen.has(shifted)));
    const isHeld = Boolean((normal && held.has(normal)) || (shifted && held.has(shifted)));
    const inspector = dynamicHost.querySelector<HTMLElement>("[data-rd-encoder-terminal-inspector]");
    const nextState = isHeld ? "held" : isSeen ? "seen" : "idle";
    if (inspector && inspector.dataset.liveState !== nextState) inspector.dataset.liveState = nextState;
    if (live.dataset.state !== nextState) live.dataset.state = nextState;
    const copy = live.lastElementChild;
    const nextCopy = isHeld ? "Matching key held now" : isSeen ? "Matching key seen in this test" :
      view ? "Waiting for a matching key" : "Run a button test for live feedback";
    if (copy && copy.textContent !== nextCopy) copy.textContent = nextCopy;
  };
  const patchObservationSurface = (): void => {
    const panel = dynamicHost.querySelector<HTMLElement>("[data-rd-encoder-observation]");
    const status = panel?.querySelector<HTMLElement>("[data-rd-encoder-observation-status]");
    if (!panel || !status) return;
    panel.dataset.state = observationState.kind;
    const currentView = observationView(observationState);
    if (currentView) panel.dataset.backendState = currentView.state;
    else delete panel.dataset.backendState;
    paintSignalObservationStatus(document_, status, current, observationState, presentation);
    patchProductSignalState();
    const start = panel.querySelector<HTMLButtonElement>('[data-rd-encoder-observe="start"]');
    const stop = panel.querySelector<HTMLButtonElement>('[data-rd-encoder-observe="stop"]');
    const listening = observationState.kind === "listening" || observationState.kind === "unknown";
    if (start) start.disabled = listening || observationState.kind === "reconciling" ||
      observationState.kind === "starting" || observationState.kind === "stopping" ||
      chartState.kind === "loading";
    if (stop) {
      stop.disabled = observationState.kind === "stopping";
      stop.textContent = observationState.kind === "stopping"
        ? "Stopping…" : presentation === "product" ? "Done" : "Done — stop listening";
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
    // A visible session and an HTTP request have different lifetimes. Add the
    // cleanup hold before dropping the session hold so another surface cannot
    // enter the hardware lane between those two operations.
    const cleanupHold = owned
      ? acquireHardwareActionHold("observation", owned.selector)
      : null;
    releaseObservationSessionHold();
    if (owned) {
      void cancelEncoderObservation(owned.generation, fetch, keepalive)
        .catch(() => undefined)
        .finally(() => releaseHardwareActionHold("observation", cleanupHold));
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
        releaseObservationSessionHold();
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
    if (!connectionConfirmed || !selector || chartState.kind === "loading" ||
        observationState.kind === "reconciling" ||
        observationState.kind === "starting" || observationState.kind === "listening" ||
        observationState.kind === "stopping" || observationState.kind === "unknown") return;
    const recheckOnly = observationState.kind === "foreign-live";
    if (!recheckOnly && hardwareActionHolds.observation.size > 0) {
      announce("The previous button-test request is still settling. Wait for its exact cleanup before starting again.");
      repaint();
      return;
    }
    if (encoderHardwareActionBlockedFor(hardwareActionOwner, "observation")) {
      announce("Another encoder hardware action is still active. Finish it before starting this button test.");
      repaint();
      return;
    }
    const requestedSelection = current.value;
    const epoch = ++observationRequestEpoch;
    clearObservationPoll();
    observationState = { kind: "reconciling" };
    if (!observationSessionHold) {
      observationSessionHold = acquireHardwareActionHold("observation", selector);
      if (!observationSessionHold) {
        observationState = { kind: "idle" };
        repaint();
        return;
      }
    }
    const reconciliationHold = acquireHardwareActionHold("observation", selector);
    if (!reconciliationHold) {
      observationState = { kind: "idle" };
      releaseObservationSessionHold();
      repaint();
      return;
    }
    repaint();
    announce("Checking the current signal-observation lease before starting.");
    let existing: EncoderObservationView;
    try {
      existing = await pollEncoderObservation();
    } catch (error) {
      releaseHardwareActionHold("observation", reconciliationHold);
      if (epoch !== observationRequestEpoch || current.value !== requestedSelection) return;
      const message = error instanceof Error
        ? error.message
        : "KSX could not inspect the current observation lease.";
      observationState = recheckOnly
        ? {
          kind: "foreign-live",
          message: `${message} KSX still cannot prove that the foreign observation ended.`,
        }
        : { kind: "error", message };
      repaint();
      announce(`${recheckOnly ? "Observation lease still unconfirmed" : "Signal observation unavailable"} — ${observationState.message}`);
      if (!recheckOnly) releaseObservationSessionHold();
      focusObservationStart();
      return;
    }
    releaseHardwareActionHold("observation", reconciliationHold);
    if (epoch !== observationRequestEpoch || current.value !== requestedSelection) return;
    if (recheckOnly) {
      if (existing.ok && (existing.state === "idle" || existing.state === "timeout" ||
          existing.state === "cancelled" || existing.state === "failed")) {
        observationState = { kind: "idle" };
        releaseObservationSessionHold();
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
      releaseObservationSessionHold();
      focusObservationStart();
      return;
    }

    const startHold = acquireHardwareActionHold("observation", selector);
    if (!startHold) {
      observationState = { kind: "error", message: "KSX could not reserve the button-test request." };
      releaseObservationSessionHold();
      repaint();
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
          await cancelEncoderObservation(view.generation, fetch, pageHiding).catch(() => undefined);
        }
        releaseObservationSessionHold();
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
      releaseObservationSessionHold();
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
            await cancelEncoderObservation(recoveredGeneration, fetch, pageHiding)
              .catch(() => undefined);
            releaseObservationSessionHold();
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
        if (nowStale) {
          releaseObservationSessionHold();
          return;
        }
      } catch {
        // Keep the original start error; no exact live generation was proven.
      }
      if (stale || epoch !== observationRequestEpoch || current.value !== requestedSelection) {
        releaseObservationSessionHold();
        return;
      }
      observationState = {
        kind: "error",
        message: error instanceof Error ? error.message : "The signal observation could not start.",
      };
      releaseObservationSessionHold();
      repaint();
      announce(`Signal observation unavailable — ${observationState.message}`);
      focusObservationStart();
    } finally {
      releaseHardwareActionHold("observation", startHold);
    }
  };
  const stopCurrentObservation = async (): Promise<void> => {
    const owned = ownedObservation();
    if (!owned || owned.generation === null || !owned.selector) return;
    const epoch = ++observationRequestEpoch;
    clearObservationPoll();
    const generation = owned.generation;
    const selector = owned.selector;
    const stopHold = acquireHardwareActionHold("observation", selector);
    if (!stopHold) return;
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
        releaseObservationSessionHold();
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
    } finally {
      releaseHardwareActionHold("observation", stopHold);
    }
  };
  const readCurrentChart = async (restoreFocus = true): Promise<void> => {
    const result = selectedDetection(current, confirmedCandidate);
    const selector = current.device?.selector;
    const chartFocusTarget: ChartReadFocusTarget | null = restoreFocus
      ? presentation === "product" &&
      document_.activeElement instanceof Element &&
      Boolean(document_.activeElement.closest("[data-rd-encoder-terminal-inspector]"))
        ? "inspector"
        : "panel"
      : null;
    const observationBusy = observationState.kind === "reconciling" ||
      observationState.kind === "starting" || observationState.kind === "listening" ||
      observationState.kind === "stopping" || observationState.kind === "unknown" ||
      observationState.kind === "foreign-live";
    if (!connectionConfirmed || !selector || !chartReadIsAdmitted(result, current) ||
        chartState.kind === "loading" ||
        observationBusy) return;
    if (hardwareActionHolds.chart.size > 0) {
      announce("The previous stored-assignment read is still settling. Wait before reading again.");
      repaint();
      return;
    }
    if (encoderHardwareActionBlockedFor(hardwareActionOwner, "chart")) {
      announce("Another encoder hardware action is still active. Finish it before reading these stored assignments.");
      repaint();
      return;
    }
    const requestedSelection = current.value;
    const epoch = ++chartRequestEpoch;
    chartState = { kind: "loading" };
    const chartHold = acquireHardwareActionHold("chart", selector);
    if (!chartHold) {
      chartState = { kind: "idle" };
      repaint();
      return;
    }
    automaticChartReadPending = false;
    activeChartReadFocusTarget = chartFocusTarget;
    if (chartFocusTarget) liveStatus.focus({ preventScroll: true });
    repaint();
    announce(`Reading stored assignments from ${current.device?.name ?? "the selected encoder"}.`);
    try {
      // The observer lease is daemon-global and may have been started by a
      // different tab/process, so a local coordinator alone is insufficient.
      const observation = await pollEncoderObservation();
      if (epoch !== chartRequestEpoch || current.value !== requestedSelection) return;
      const observationIdle = (observation.ok && (
        observation.state === "idle" || observation.state === "timeout" ||
        observation.state === "cancelled" || observation.state === "failed"
      )) || (observation.state === "unavailable" && observation.generation === null);
      if (!observationIdle) {
        chartState = {
          kind: "error",
          message: observation.generation !== null
            ? "A button test is active. Finish it before reading stored encoder assignments."
            : observation.error || observation.detail ||
              "KSX could not confirm that the button-test lease is idle.",
        };
      } else {
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
      }
    } catch (error) {
      if (epoch !== chartRequestEpoch || current.value !== requestedSelection) return;
      chartState = {
        kind: "error",
        message: error instanceof Error ? error.message :
          "KSX could not verify the button-test lease before reading this encoder.",
      };
    } finally {
      releaseHardwareActionHold("chart", chartHold);
    }
    if (epoch !== chartRequestEpoch || current.value !== requestedSelection) return;
    repaint();
    announce(chartState.kind === "loaded"
      ? `Read ${chartState.snapshot.terminals.length} stored terminal assignments. No hardware was changed.`
      : chartState.kind === "error" ? chartState.message : "");
    if (chartFocusTarget) {
      activeChartReadFocusTarget = null;
      if (chartFocusTarget === "inspector" && chartState.kind !== "error") {
        focusProductTerminalOrWidget();
      } else restoreChartReadFocus(chartFocusTarget);
    }
  };
  const scheduleAutomaticChartRead = (): void => {
    if (presentation !== "product" || !automaticChartReadPending || automaticChartReadFrame ||
        pageHiding || chartState.kind !== "idle") return;
    const view = document_.defaultView;
    if (!view) return;
    automaticChartReadFrame = view.requestAnimationFrame(() => {
      automaticChartReadFrame = 0;
      if (!automaticChartReadPending || pageHiding || !content.isConnected ||
          !connectionConfirmed || chartState.kind !== "idle") return;
      const result = selectedDetection(current, confirmedCandidate);
      const observationBusy = observationState.kind === "reconciling" ||
        observationState.kind === "starting" || observationState.kind === "listening" ||
        observationState.kind === "stopping" || observationState.kind === "unknown" ||
        observationState.kind === "foreign-live";
      if (!chartReadIsAdmitted(result, current) || observationBusy ||
          hardwareActionHolds.chart.size > 0 ||
          encoderHardwareActionBlockedFor(hardwareActionOwner, "chart")) return;
      void readCurrentChart(false);
    });
  };
  select.addEventListener("change", () => {
    const next = selections.find((selection) => selection.value === select.value);
    if (!next) return;
    releaseObservation();
    current = next;
    chartRequestEpoch += 1;
    activeChartReadFocusTarget = null;
    pageShowChartFocusTarget = null;
    chartState = { kind: "idle" };
    automaticChartReadPending = false;
    confirmedCandidate = undefined;
    declaredLabels = [];
    declaredLabelsDraft = "";
    selectedTerminalId = undefined;
    if (current.profileId) options.onProfileChange?.(current.profileId);
    repaint();
    scheduleAutomaticChartRead();
  });
  const footer = html(document_, "footer", "rd-encoder-profile-foot");
  footer.textContent = presentation === "product"
    ? "Reads and tests this encoder. Controller mapping is the next canvas block."
    : "Read-only inspection. KSX control assignment comes later; this surface stops at terminal identity, stored configuration, and device-scoped host signals.";
  if (presentation === "product") footer.classList.add("rd-encoder-product-next");
  if (presentation === "product") content.append(header, dynamicHost, footer, liveStatus);
  else content.append(header, toolbar, dynamicHost, footer, liveStatus);
  let disposed = false;
  const unsubscribeHardwareActions = subscribeEncoderHardwareActions(() => {
    if (!disposed && !pageHiding) {
      repaint();
      scheduleAutomaticChartRead();
    }
  });
  const onPageHide = (): void => {
    pageHiding = true;
    if (automaticChartReadFrame) {
      document_.defaultView?.cancelAnimationFrame(automaticChartReadFrame);
      automaticChartReadFrame = 0;
    }
    chartRequestEpoch += 1;
    if (chartState.kind === "loading") {
      chartState = { kind: "idle" };
      pageShowChartFocusTarget = activeChartReadFocusTarget;
      activeChartReadFocusTarget = null;
    }
    // A BFCache restore is a page lifecycle, not a renewed user Add gesture.
    automaticChartReadPending = false;
    releaseObservation(true);
  };
  const onPageShow = (): void => {
    pageHiding = false;
    const focusTarget = pageShowChartFocusTarget;
    pageShowChartFocusTarget = null;
    repaint();
    scheduleAutomaticChartRead();
    if (focusTarget) restoreChartReadFocus(focusTarget, true);
  };
  document_.defaultView?.addEventListener("pagehide", onPageHide);
  document_.defaultView?.addEventListener("pageshow", onPageShow);
  repaint();
  scheduleAutomaticChartRead();
  return {
    content,
    updateConnectedEncoders: (devices) => {
      const nextSignature = connectedDevicesSignature(devices);
      if (nextSignature === connectedSignature) return;
      connectedSignature = nextSignature;
      const previousValue = current.value;
      const previousEvidence = selectionEvidenceSignature(current);
      selections = makeSelections(devices);
      const replacement = selections.find((selection) => selection.value === previousValue) ??
        defaultSelection();
      if (!replacement) return;
      const selectionChanged = replacement.value !== previousValue;
      const evidenceChanged = selectionEvidenceSignature(replacement) !== previousEvidence;
      current = replacement;
      if (selectionChanged || evidenceChanged) {
        releaseObservation();
        chartRequestEpoch += 1;
        activeChartReadFocusTarget = null;
        pageShowChartFocusTarget = null;
        chartState = { kind: "idle" };
        automaticChartReadPending = false;
        confirmedCandidate = undefined;
        declaredLabels = [];
        declaredLabelsDraft = "";
        selectedTerminalId = undefined;
      }
      repaintOptions();
      if (selectionChanged || evidenceChanged) repaint();
      else {
        paintHeader(selectedDetection(current, confirmedCandidate));
        if (presentation === "product") {
          const deviceFact = dynamicHost.querySelector<HTMLElement>('[data-device-fact="device"] dd');
          const connectionFact = dynamicHost.querySelector<HTMLElement>(
            '[data-device-fact="connection"] dd',
          );
          if (deviceFact) deviceFact.textContent = current.device?.name ?? "Connected encoder";
          if (connectionFact) {
            const connectionLine = productDeviceMeta(current.device, chartState.kind === "loaded");
            connectionFact.textContent = connectionConfirmed
              ? connectionLine || "Connected USB device"
              : "Unconfirmed — latest device scan did not answer";
          }
        }
      }
      scheduleAutomaticChartRead();
    },
    setConnectionConfirmed: (confirmed) => {
      if (presentation !== "product" || confirmed === connectionConfirmed) return;
      connectionConfirmed = confirmed;
      if (!confirmed) automaticChartReadPending = false;
      repaint();
      scheduleAutomaticChartRead();
      announce(confirmed
        ? "Device connection confirmed. Read and button-test actions are available."
        : "Device connection is unconfirmed. Existing results remain visible; new hardware actions are paused.");
    },
    dispose: () => {
      disposed = true;
      unsubscribeHardwareActions();
      document_.defaultView?.removeEventListener("pagehide", onPageHide);
      document_.defaultView?.removeEventListener("pageshow", onPageShow);
      chartRequestEpoch += 1;
      activeChartReadFocusTarget = null;
      pageShowChartFocusTarget = null;
      // Ordinary widget removal keeps the page alive, so use a normal request.
      // `pagehide` above owns the only lifecycle that needs keepalive delivery.
      releaseObservation();
      if (automaticChartReadFrame) document_.defaultView?.cancelAnimationFrame(automaticChartReadFrame);
      automaticChartReadFrame = 0;
      if (announcementFrame) document_.defaultView?.cancelAnimationFrame(announcementFrame);
      announcementFrame = 0;
    },
  };
}

/** One connected encoder selected in `+ Devices`, rendered as a normal
 * workbench object. It intentionally exposes no catalog/evidence selector. */
export function createEncoderWorkbenchSurface(
  document_: Document,
  device: EncoderProfileLabDevice,
  options: EncoderWorkbenchSurfaceOptions = {},
): EncoderWorkbenchSurface {
  const surface = createProfileLabContent(document_, {
    connectedEncoders: [device],
    presentation: "product",
  }, options.readStoredAssignmentsOnMount === true);
  return {
    content: surface.content,
    updateDevice: (next) => surface.updateConnectedEncoders([next]),
    setConnectionConfirmed: surface.setConnectionConfirmed,
    dispose: surface.dispose,
  };
}

export function createEncoderProfileLabCanvasItem(
  document_: Document,
  options: EncoderProfileLabOptions = {},
): EncoderProfileLabCanvasItem {
  const lab = createProfileLabContent(document_, { ...options, presentation: "research" });
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
