/**
 * Normalized mapping-flow projection for Nocturne's canvas.
 *
 * The mapper owns the authoring data and this topology remains read-only: this
 * layer only turns that truth into visible edges. Keeping the graph separate
 * from DOM anchors is deliberate. Direct bindings stay `key -> control`,
 * while timed macros become `key -> processor -> controls touched across the
 * timeline`. The graph never pretends that the virtual controller itself
 * performs the transform.
 */

export type MappingPathMode = "off" | "selected" | "all";

/** Backend-owned controller endpoint in persona/zone order. Exact key arrays
 * avoid recovering authoring data from presentation strings such as `G · H`;
 * behavior fields travel with the endpoint even though this module currently
 * projects only its topology. */
export interface MappingFlowControl {
  function: string;
  label: string;
  group: string;
  order: number;
  keys: readonly string[];
  toggle: boolean;
  turbo_hz: number | null;
}

export interface MappingFlowPad {
  slot: number;
  preset: string;
  title: string;
  fn_keys: Record<string, string>;
  fn_names: Record<string, string>;
  controls?: readonly MappingFlowControl[];
  mapping_available?: boolean;
  mapping_reason?: string;
  macros?: readonly MappingFlowMacro[];
  macro_available?: boolean;
  macro_reason?: string;
}

export interface MappingFlowMacro {
  name: string;
  triggers: readonly string[];
  outputs: readonly { function: string; steps: readonly number[] }[];
  timeline: readonly string[];
  meta: string;
  disabled: boolean;
  edit_href: string;
}

interface KeyFlowEndpoint {
  kind: "key";
  id: string;
  key: string;
}

interface ControlFlowEndpoint {
  kind: "control";
  id: string;
  slot: number;
  functionName: string;
  label: string;
}

interface MacroFlowEndpoint {
  kind: "macro";
  id: string;
  slot: number;
  name: string;
}

export interface DirectMappingFlow {
  id: string;
  kind: "binding";
  chainId: string;
  slot: number;
  source: KeyFlowEndpoint;
  target: ControlFlowEndpoint;
}

export interface MacroTriggerFlow {
  id: string;
  kind: "macro-trigger";
  chainId: string;
  slot: number;
  processorId: string;
  source: KeyFlowEndpoint;
  target: MacroFlowEndpoint;
}

export interface MacroOutputFlow {
  id: string;
  kind: "macro-output";
  chainId: string;
  slot: number;
  processorId: string;
  steps: number[];
  source: MacroFlowEndpoint;
  target: ControlFlowEndpoint;
}

export type MappingFlowSegment = DirectMappingFlow | MacroTriggerFlow | MacroOutputFlow;

export interface MacroProcessorFlow {
  id: string;
  kind: "macro";
  slot: number;
  preset: string;
  name: string;
  triggers: string[];
  outputs: { functionName: string; steps: number[] }[];
  timeline: string[];
  meta: string;
  disabled: boolean;
  editHref: string;
}

export interface MappingFlowGraph {
  routes: MappingFlowSegment[];
  processors: MacroProcessorFlow[];
  unavailableMappings: MappingFlowUnavailable[];
  unavailableMacros: MappingFlowUnavailable[];
}

export interface MappingFlowUnavailable {
  slot: number;
  reason: string;
}

export interface MappingFlowLayoutSummary {
  total: number;
  resolved: number;
  unresolved: number;
  direct: number;
  macroConnections: number;
  resolvedDirect: number;
  resolvedMacroConnections: number;
  processors: number;
  processorOverflow: number;
  unavailableMappings: readonly MappingFlowUnavailable[];
  unavailableMacros: readonly MappingFlowUnavailable[];
}

interface MappingFlowEntry {
  route: MappingFlowSegment;
  lineGroup: SVGGElement;
  path: SVGPathElement;
  portGroup: SVGGElement;
  sourcePort: SVGCircleElement;
  targetPort: SVGCircleElement;
  sourceElement: Element | null;
  targetElement: Element | null;
  laneIndex: number;
}

interface MacroProcessorEntry {
  processor: MacroProcessorFlow;
  element: HTMLAnchorElement;
  sourceElements: Element[];
  targetElements: Element[];
  padElement: Element | null;
}

interface MappingAnchorCache {
  keys: Map<string, Element | null>;
  controls: Map<string, Element | null>;
  pads: Map<number, Element | null>;
}

interface MappingInspection {
  key?: string;
  slot?: number;
  functionName?: string;
  macroId?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function mappingPathModeIsValid(value: unknown): value is MappingPathMode {
  return value === "off" || value === "selected" || value === "all";
}

function normalizedFunctionName(value: string): string {
  return value.trim().toLowerCase();
}

/** The visible direction zone for a serialized axis value. Hand-authored
 * presets may keep a partial value (ly.-16384) instead of the picker token
 * (ly.min). The route keeps that raw value for exact live correlation; only
 * DOM-anchor and readable-label lookup use this directional equivalent. */
function directionalAnchorFunction(value: string): string | null {
  const normalized = normalizedFunctionName(value);
  const match = /^([lr][xy])\.(min|max|[+-]?\d+)$/.exec(normalized);
  if (!match) return null;
  if (match[2] === "min" || match[2] === "max") return normalized;
  const amount = Number(match[2]);
  if (!Number.isInteger(amount) || amount < -32768 || amount > 32767 || amount === 0) {
    return null;
  }
  return match[1] + "." + (amount < 0 ? "min" : "max");
}

function sameControlDirection(left: string, right: string): boolean {
  const normalizedLeft = normalizedFunctionName(left);
  const normalizedRight = normalizedFunctionName(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftDirection = directionalAnchorFunction(normalizedLeft);
  const rightDirection = directionalAnchorFunction(normalizedRight);
  return leftDirection !== null && leftDirection === rightDirection;
}

function routePart(value: string): string {
  // These identifiers live in Maps and data attributes, not CSS id selectors.
  // Keep URI escaping intact so values such as `A B` and `A_20B` cannot
  // collapse to the same route identity.
  return encodeURIComponent(value);
}

function functionLabel(pad: MappingFlowPad, canonicalFunction: string): string {
  const functionName = normalizedFunctionName(canonicalFunction);
  const direction = directionalAnchorFunction(functionName);
  const control = pad.controls?.find(
    (candidate) =>
      normalizedFunctionName(candidate.function) === functionName ||
      (direction !== null && normalizedFunctionName(candidate.function) === direction),
  );
  const normalizedLabel = control?.label.trim();
  if (normalizedLabel) return normalizedLabel;
  const labelEntry = Object.entries(pad.fn_names).find(
    ([candidate]) =>
      normalizedFunctionName(candidate) === functionName ||
      (direction !== null && normalizedFunctionName(candidate) === direction),
  );
  return labelEntry?.[1]?.trim() || canonicalFunction;
}

/** One edge per physical key -> virtual function, never per decorative SVG
 * hook. Macro triggers are intentionally absent from this direct projection;
 * `deriveMappingFlow` serves them as typed key -> processor segments. */
export function deriveDirectMappingFlow(
  pads: readonly MappingFlowPad[],
): DirectMappingFlow[] {
  const routes: DirectMappingFlow[] = [];
  const seen = new Set<string>();
  for (const pad of [...pads].sort((left, right) => left.slot - right.slot)) {
    const controls = [...(pad.controls ?? [])]
        .sort((left, right) =>
          left.order - right.order ||
          normalizedFunctionName(left.function).localeCompare(
            normalizedFunctionName(right.function),
          )
        )
        .map<[string, readonly string[]]>((control) => [control.function, control.keys]);
    const projectedFunctions = new Set(
      controls.map(([canonicalFunction]) => normalizedFunctionName(canonicalFunction)),
    );
    const legacyEntries = Object.entries(pad.fn_keys)
      // The ordered zone projection intentionally covers visible controls only.
      // Preserve non-zone mapper truth such as partial axes (`ly.-16384`) from
      // the compatibility map while preferring exact key arrays for projected
      // controls. These raw functions retain their route identity and merely
      // borrow the matching directional zone as their DOM anchor.
      .filter(([canonicalFunction]) =>
        !projectedFunctions.has(normalizedFunctionName(canonicalFunction))
      )
      .sort(([left], [right]) =>
        normalizedFunctionName(left).localeCompare(normalizedFunctionName(right))
      )
      .map<[string, readonly string[]]>(([canonicalFunction, joinedKeys]) => [
        canonicalFunction,
        joinedKeys.split(/\s*·\s*/u),
      ]);
    const entries: [string, readonly string[]][] = pad.controls === undefined
      ? legacyEntries
      : [...controls, ...legacyEntries];
    for (const [canonicalFunction, keys] of entries) {
      const functionName = normalizedFunctionName(canonicalFunction);
      if (!functionName) continue;
      const label = functionLabel(pad, canonicalFunction);
      for (const candidate of keys) {
        const key = candidate.trim();
        if (!key) continue;
        const signature = `${pad.slot}\u0000${key}\u0000${functionName}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        const id =
          `binding:${pad.slot}:${routePart(pad.preset)}:${routePart(key)}:${routePart(functionName)}`;
        routes.push({
          id,
          kind: "binding",
          chainId: id,
          slot: pad.slot,
          source: {
            kind: "key",
            id: `key:${key}`,
            key,
          },
          target: {
            kind: "control",
            id: `control:${pad.preset}:${functionName}`,
            slot: pad.slot,
            functionName,
            label,
          },
        });
      }
    }
  }
  return routes;
}

/** Derive the whole authoring graph without touching layout. Macro groups are
 * flattened into trigger and output SEGMENTS only after one processor node is
 * created, so three triggers and four outputs are seven truthful links rather
 * than twelve invented trigger×output mappings. */
export function deriveMappingFlow(pads: readonly MappingFlowPad[]): MappingFlowGraph {
  // Availability is authoritative. A compatibility payload can carry stale
  // cached rows beside a failed fresh read; drawing them would turn "unknown"
  // into an apparently current mapping.
  const routes: MappingFlowSegment[] = [
    ...deriveDirectMappingFlow(pads.filter((pad) => pad.mapping_available !== false)),
  ];
  const processors: MacroProcessorFlow[] = [];
  const unavailableMappings: MappingFlowUnavailable[] = [];
  const unavailableMacros: MappingFlowUnavailable[] = [];
  for (const pad of [...pads].sort((left, right) => left.slot - right.slot)) {
    if (pad.mapping_available === false) {
      unavailableMappings.push({
        slot: pad.slot,
        reason: pad.mapping_reason?.trim() || "Direct mapping information is unavailable.",
      });
    }
    if (pad.macro_available === false) {
      unavailableMacros.push({
        slot: pad.slot,
        reason: pad.macro_reason?.trim() || "Macro information is unavailable.",
      });
      continue;
    }
    const macros = [...(pad.macros ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const macro of macros) {
      const triggers = Array.from(new Set(macro.triggers.map((key) => key.trim()).filter(Boolean)));
      const seenOutputs = new Set<string>();
      const outputs: { functionName: string; steps: number[] }[] = [];
      for (const candidate of macro.outputs) {
        const output = normalizedFunctionName(candidate.function);
        if (!output || seenOutputs.has(output)) continue;
        seenOutputs.add(output);
        outputs.push({
          functionName: output,
          steps: Array.from(new Set(candidate.steps.filter((step) => step > 0))).sort(
            (left, right) => left - right,
          ),
        });
      }
      const processorId =
        `macro:${pad.slot}:${routePart(pad.preset)}:${routePart(macro.name)}`;
      const processor: MacroProcessorFlow = {
        id: processorId,
        kind: "macro",
        slot: pad.slot,
        preset: pad.preset,
        name: macro.name,
        triggers,
        outputs,
        timeline: [...macro.timeline],
        meta: macro.meta,
        disabled: macro.disabled,
        editHref: macro.edit_href,
      };
      processors.push(processor);
      const macroEndpoint: MacroFlowEndpoint = {
        kind: "macro",
        id: processorId,
        slot: pad.slot,
        name: macro.name,
      };
      for (const key of triggers) {
        routes.push({
          id: `${processorId}:trigger:${routePart(key)}`,
          kind: "macro-trigger",
          chainId: processorId,
          slot: pad.slot,
          processorId,
          source: { kind: "key", id: `key:${key}`, key },
          target: macroEndpoint,
        });
      }
      for (const output of outputs) {
        const { functionName, steps } = output;
        routes.push({
          id: `${processorId}:output:${routePart(functionName)}`,
          kind: "macro-output",
          chainId: processorId,
          slot: pad.slot,
          processorId,
          steps,
          source: macroEndpoint,
          target: {
            kind: "control",
            id: `control:${pad.preset}:${functionName}`,
            slot: pad.slot,
            functionName,
            label: functionLabel(pad, functionName),
          },
        });
      }
    }
  }
  return { routes, processors, unavailableMappings, unavailableMacros };
}

export function mappingCurve(
  source: { x: number; y: number },
  target: { x: number; y: number },
  lane = 0,
): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const middleY = source.y + dy / 2 + lane;
    return `M ${source.x.toFixed(2)} ${source.y.toFixed(2)} C ${source.x.toFixed(2)} ${middleY.toFixed(2)}, ${target.x.toFixed(2)} ${middleY.toFixed(2)}, ${target.x.toFixed(2)} ${target.y.toFixed(2)}`;
  }
  const middleX = source.x + dx / 2 + lane;
  return `M ${source.x.toFixed(2)} ${source.y.toFixed(2)} C ${middleX.toFixed(2)} ${source.y.toFixed(2)}, ${middleX.toFixed(2)} ${target.y.toFixed(2)}, ${target.x.toFixed(2)} ${target.y.toFixed(2)}`;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  document_: Document,
  name: K,
): SVGElementTagNameMap[K] {
  return document_.createElementNS(SVG_NS, name);
}

function endpointVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function elementCenter(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function inspectionEqual(left: MappingInspection | null, right: MappingInspection | null): boolean {
  return left?.key === right?.key &&
    left?.slot === right?.slot &&
    left?.functionName === right?.functionName &&
    left?.macroId === right?.macroId;
}

/** Owns two non-interactive SVG projections plus an interactive HTML processor
 * layer. Lines sit below widgets; ports and processor cards sit above them.
 * All three mirror the stage camera. */
export class MappingFlowLayer {
  readonly #root: HTMLElement;
  readonly #viewport: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #lines: SVGSVGElement;
  readonly #ports: SVGSVGElement;
  readonly #nodes: HTMLElement;
  readonly #onLayout: (summary: MappingFlowLayoutSummary) => void;
  readonly #entries = new Map<string, MappingFlowEntry>();
  readonly #processorEntries = new Map<string, MacroProcessorEntry>();
  readonly #mutationObserver: MutationObserver;
  readonly #resizeObserver: ResizeObserver;
  readonly #abort = new AbortController();
  readonly #relatedAnchors = new Set<Element>();
  readonly #observedAnchors = new Set<Element>();
  #routes: MappingFlowSegment[] = [];
  #processors: MacroProcessorFlow[] = [];
  #unavailableMappings: MappingFlowUnavailable[] = [];
  #unavailableMacros: MappingFlowUnavailable[] = [];
  #fingerprint = "";
  #mode: MappingPathMode = "off";
  #selectedSlot = 0;
  #pointerInspection: MappingInspection | null = null;
  #focusInspection: MappingInspection | null = null;
  #layoutFrame = 0;
  #overflowNode: HTMLDetailsElement | null = null;
  #overflowFingerprint = "";
  #processorOverflow = 0;
  #restoreProcessorFocusId: string | null = null;
  #restoreOverflowSummaryFocus = false;
  #restoreOverflowOpen = false;

  constructor(
    root: HTMLElement,
    viewport: HTMLElement,
    stage: HTMLElement,
    lines: SVGSVGElement,
    ports: SVGSVGElement,
    nodes: HTMLElement,
    onLayout: (summary: MappingFlowLayoutSummary) => void = () => undefined,
  ) {
    this.#root = root;
    this.#viewport = viewport;
    this.#stage = stage;
    this.#lines = lines;
    this.#ports = ports;
    this.#nodes = nodes;
    this.#onLayout = onLayout;
    this.#mutationObserver = new MutationObserver((records) => {
      let cameraChanged = false;
      let geometryChanged = false;
      for (const record of records) {
        if (record.target === this.#stage) cameraChanged = true;
        else geometryChanged = true;
      }
      if (cameraChanged) this.#syncCameraTransform();
      if (cameraChanged || geometryChanged) this.scheduleLayout();
    });
    this.#mutationObserver.observe(stage, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style"],
    });
    this.#resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    this.#resizeObserver.observe(viewport);
    root.addEventListener("pointerover", (event) => this.#inspectEvent("pointer", event), {
      signal: this.#abort.signal,
    });
    root.addEventListener("focusin", (event) => this.#inspectEvent("focus", event), {
      signal: this.#abort.signal,
    });
    root.addEventListener("pointerout", (event) => this.#leaveEvent("pointer", event), {
      signal: this.#abort.signal,
    });
    root.addEventListener("focusout", (event) => this.#leaveEvent("focus", event), {
      signal: this.#abort.signal,
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.#clearInspections();
    }, { signal: this.#abort.signal });
    this.#syncCameraTransform();
  }

  setGraph(
    pads: readonly MappingFlowPad[],
    mode: MappingPathMode,
    selectedSlot: number,
  ): number {
    this.#mode = mode;
    this.#selectedSlot = selectedSlot;
    const graph = deriveMappingFlow(pads);
    const inScope = (slot: number) => mode === "all" ||
      (mode === "selected" && slot === selectedSlot);
    this.#routes = mode === "off" ? [] : graph.routes.filter((route) => inScope(route.slot));
    this.#processors = mode === "off"
      ? []
      : graph.processors.filter((processor) => inScope(processor.slot));
    const processorIds = new Set(this.#processors.map((processor) => processor.id));
    if (this.#pointerInspection?.macroId && !processorIds.has(this.#pointerInspection.macroId)) {
      this.#pointerInspection = null;
    }
    if (this.#focusInspection?.macroId && !processorIds.has(this.#focusInspection.macroId)) {
      this.#focusInspection = null;
    }
    this.#unavailableMappings = mode === "off"
      ? []
      : graph.unavailableMappings.filter((unavailable) => inScope(unavailable.slot));
    this.#unavailableMacros = mode === "off"
      ? []
      : graph.unavailableMacros.filter((unavailable) => inScope(unavailable.slot));
    const fingerprint = [
      ...this.#routes.map((route) => route.id),
      ...this.#processors.map((processor) => processor.id),
    ].join("|");
    const hidden = mode === "off";
    // SVGSVGElement does not consistently reflect HTMLElement.hidden; keep
    // the actual global attribute authoritative for CSS and accessibility.
    this.#lines.toggleAttribute("hidden", hidden);
    this.#ports.toggleAttribute("hidden", hidden);
    this.#nodes.toggleAttribute("hidden", hidden);
    this.#viewport.dataset.canvasPaths = mode;
    this.#lines.dataset.flowMode = mode;
    this.#ports.dataset.flowMode = mode;
    this.#nodes.dataset.flowMode = mode;
    if (fingerprint !== this.#fingerprint) {
      this.#fingerprint = fingerprint;
      this.#rebuild();
    } else {
      // Labels and other semantic metadata may change without changing the
      // edge set. Keep the retained DOM entries attached to current truth.
      for (const processor of this.#processors) {
        const entry = this.#processorEntries.get(processor.id);
        if (!entry) continue;
        entry.processor = processor;
        this.#syncProcessorElement(entry);
      }
      for (const route of this.#routes) {
        const entry = this.#entries.get(route.id);
        if (!entry) continue;
        entry.route = route;
        this.#stampRoute(entry.lineGroup, route);
        this.#stampRoute(entry.portGroup, route);
      }
    }
    this.#syncCameraTransform();
    if (hidden) {
      this.#restoreProcessorFocusId = null;
      if (this.#layoutFrame !== 0) cancelAnimationFrame(this.#layoutFrame);
      this.#layoutFrame = 0;
      this.#clearInspections();
      this.#syncObservedAnchors(new Set());
      this.#publishSummary({
        total: 0,
        resolved: 0,
        unresolved: 0,
        direct: 0,
        macroConnections: 0,
        resolvedDirect: 0,
        resolvedMacroConnections: 0,
        processors: 0,
        processorOverflow: 0,
        unavailableMappings: [],
        unavailableMacros: [],
      });
      return 0;
    }
    this.scheduleLayout();
    return this.#routes.length;
  }

  scheduleLayout(): void {
    if (this.#mode === "off" || this.#layoutFrame !== 0) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = 0;
      this.#layout();
    });
  }

  setLive(
    keysDown: ReadonlySet<string>,
    keyHits: ReadonlySet<string>,
    slotFunctionsDown: ReadonlyMap<number, ReadonlySet<string>>,
    slotFunctionHits: ReadonlyMap<number, ReadonlySet<string>>,
  ): void {
    for (const entry of this.#entries.values()) {
      // Runtime frames carry aggregate controller state, not macro execution
      // provenance. Only a direct relation can truthfully light from these two
      // facts; macro segments stay static until the backend reports a running
      // macro/step identity.
      const live = entry.route.kind === "binding" &&
        (
          keysDown.has(entry.route.source.key) &&
            (slotFunctionsDown.get(entry.route.target.slot)?.has(entry.route.target.functionName) ?? false) ||
          keyHits.has(entry.route.source.key) &&
            (slotFunctionHits.get(entry.route.target.slot)?.has(entry.route.target.functionName) ?? false)
        );
      entry.lineGroup.classList.toggle("is-live", live);
      entry.portGroup.classList.toggle("is-live", live);
    }
  }

  dispose(): void {
    if (this.#layoutFrame !== 0) cancelAnimationFrame(this.#layoutFrame);
    this.#layoutFrame = 0;
    this.#abort.abort();
    this.#mutationObserver.disconnect();
    this.#resizeObserver.disconnect();
    this.#observedAnchors.clear();
    this.#clearRelatedAnchors();
    this.#entries.clear();
    this.#processorEntries.clear();
    this.#overflowNode = null;
    this.#overflowFingerprint = "";
    this.#processorOverflow = 0;
    this.#restoreProcessorFocusId = null;
    this.#restoreOverflowSummaryFocus = false;
    this.#restoreOverflowOpen = false;
    this.#lines.replaceChildren();
    this.#ports.replaceChildren();
    this.#nodes.replaceChildren();
  }

  #rebuild(): void {
    this.#captureProcessorFocus();
    this.#clearRelatedAnchors();
    this.#entries.clear();
    this.#processorEntries.clear();
    this.#overflowNode = null;
    this.#overflowFingerprint = "";
    this.#lines.replaceChildren();
    this.#ports.replaceChildren();
    this.#nodes.replaceChildren();
    this.#resizeObserver.disconnect();
    this.#observedAnchors.clear();
    this.#resizeObserver.observe(this.#viewport);
    const document_ = this.#root.ownerDocument;
    for (const processor of this.#processors) {
      const element = document_.createElement("a");
      element.addEventListener("pointerdown", (event) => {
        if (event.button === 0) event.stopPropagation();
      }, {
        signal: this.#abort.signal,
      });
      const entry = {
        processor,
        element,
        sourceElements: [],
        targetElements: [],
        padElement: null,
      };
      this.#syncProcessorElement(entry);
      this.#nodes.append(element);
      this.#processorEntries.set(processor.id, entry);
    }
    const overflow = document_.createElement("details");
    overflow.className = "n-flow-processor n-flow-overflow";
    overflow.hidden = true;
    overflow.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.stopPropagation();
    }, {
      signal: this.#abort.signal,
    });
    this.#nodes.append(overflow);
    this.#overflowNode = overflow;
    for (const route of this.#routes) {
      const lineGroup = svgElement(document_, "g");
      lineGroup.classList.add("n-flow-edge");
      this.#stampRoute(lineGroup, route);
      const halo = svgElement(document_, "path");
      halo.classList.add("n-flow-halo");
      halo.setAttribute("vector-effect", "non-scaling-stroke");
      const path = svgElement(document_, "path");
      path.classList.add("n-flow-core");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      lineGroup.append(halo, path);

      const portGroup = svgElement(document_, "g");
      portGroup.classList.add("n-flow-edge", "n-flow-edge-ports");
      this.#stampRoute(portGroup, route);
      const sourcePort = svgElement(document_, "circle");
      sourcePort.classList.add("n-flow-port", "n-flow-port-source");
      sourcePort.setAttribute("vector-effect", "non-scaling-stroke");
      const targetPort = svgElement(document_, "circle");
      targetPort.classList.add("n-flow-port", "n-flow-port-target");
      targetPort.setAttribute("vector-effect", "non-scaling-stroke");
      portGroup.append(sourcePort, targetPort);

      this.#lines.append(lineGroup);
      this.#ports.append(portGroup);
      this.#entries.set(route.id, {
        route,
        lineGroup,
        path,
        portGroup,
        sourcePort,
        targetPort,
        sourceElement: null,
        targetElement: null,
        laneIndex: 0,
      });
    }
  }

  #syncProcessorElement(entry: MacroProcessorEntry): void {
    const { processor, element } = entry;
    const document_ = this.#root.ownerDocument;
    const hasNoSteps = processor.timeline.length === 0;
    const timeline = hasNoSteps ? ["no steps"] : processor.timeline;
    const state = hasNoSteps ? "Invalid macro" : processor.disabled ? "Macro off" : "Macro";
    const triggerWords = processor.triggers.join(" or ");
    const triggerSentence = triggerWords
      ? `Started by ${triggerWords}.`
      : "No trigger key is assigned.";
    const visibleSteps = timeline.slice(0, 4);
    const hiddenStepCount = timeline.length - visibleSteps.length;
    const timelineWords = `${visibleSteps.join(" then ")}${
      hiddenStepCount > 0 ? `, and ${hiddenStepCount} more ${hiddenStepCount === 1 ? "step" : "steps"}` : ""
    }`;
    element.className = `n-flow-processor${processor.disabled || hasNoSteps ? " is-disabled" : ""}`;
    element.dataset.flowMacroId = processor.id;
    element.dataset.flowSlot = String(processor.slot);
    element.dataset.flowDisabled = String(processor.disabled);
    element.dataset.flowPattern = String(((processor.slot - 1) % 16 + 16) % 16 + 1);
    element.style.setProperty("--n-flow-color", `var(--pcs${processor.slot})`);
    element.href = processor.editHref;
    element.setAttribute("aria-haspopup", "dialog");
    element.setAttribute("aria-controls", "n-macro-dialog");
    element.title =
      `${state} “${processor.name}” for Player ${processor.slot}: ${processor.meta}. ` +
      `${triggerSentence} Timeline: ${timelineWords}. Open the step editor.`;
    element.setAttribute(
      "aria-label",
      `${state} ${processor.name} for Player ${processor.slot}. ${processor.meta}. ` +
        `${triggerSentence} Timeline: ${timelineWords}. Open step editor.`,
    );

    const kicker = document_.createElement("span");
    kicker.className = "n-flow-processor-kicker";
    kicker.textContent = `P${processor.slot} · ${hasNoSteps ? "NO STEPS" : processor.disabled ? "MACRO OFF" : "MACRO"}`;
    const name = document_.createElement("strong");
    name.className = "n-flow-processor-name";
    name.textContent = processor.name;
    const rail = document_.createElement("span");
    rail.className = "n-flow-processor-timeline";
    rail.setAttribute("aria-hidden", "true");
    visibleSteps.forEach((step, index) => {
      const chip = document_.createElement("span");
      chip.className = "n-flow-processor-step";
      chip.textContent = step;
      rail.append(chip);
      if (index < visibleSteps.length - 1) {
        const arrow = document_.createElement("span");
        arrow.className = "n-flow-processor-arrow";
        arrow.textContent = "›";
        rail.append(arrow);
      }
    });
    if (timeline.length > visibleSteps.length) {
      const more = document_.createElement("span");
      more.className = "n-flow-processor-more";
      more.textContent = `+${timeline.length - visibleSteps.length}`;
      rail.append(more);
    }
    const meta = document_.createElement("span");
    meta.className = "n-flow-processor-meta";
    meta.textContent = processor.meta;
    element.replaceChildren(kicker, name, rail, meta);
  }

  #syncOverflowElement(processors: readonly MacroProcessorFlow[]): void {
    const element = this.#overflowNode;
    if (!element) return;
    this.#processorOverflow = processors.length;
    element.dataset.flowOverflow = String(processors.length);
    if (processors.length === 0) {
      element.hidden = true;
      element.open = false;
      return;
    }
    element.hidden = false;
    element.style.setProperty("--n-flow-color", `var(--pcs${processors[0].slot})`);
    const fingerprint = processors.map((processor) => [
      processor.id,
      processor.name,
      processor.meta,
      processor.editHref,
      processor.disabled,
      processor.timeline.join("\u0002"),
    ].join("\u0000")).join("\u0001");
    if (fingerprint === this.#overflowFingerprint) return;
    this.#overflowFingerprint = fingerprint;

    const document_ = this.#root.ownerDocument;
    const active = document_.activeElement;
    const restoreSummary = active === element.querySelector("summary");
    const restoreMacroId = active instanceof Element && element.contains(active)
      ? active.closest<HTMLElement>("[data-flow-macro-id]")?.dataset.flowMacroId ?? null
      : null;
    const wasOpen = element.open;
    const summary = document_.createElement("summary");
    summary.className = "n-flow-overflow-summary";
    summary.setAttribute(
      "aria-label",
      `Open ${processors.length} grouped ${processors.length === 1 ? "macro" : "macros"}`,
    );
    const kicker = document_.createElement("span");
    kicker.className = "n-flow-processor-kicker";
    kicker.textContent = "MACRO BANK";
    const count = document_.createElement("strong");
    count.className = "n-flow-processor-name";
    count.textContent = `+${processors.length} more`;
    const meta = document_.createElement("span");
    meta.className = "n-flow-processor-meta";
    meta.textContent = "Open list";
    summary.append(kicker, count, meta);

    const list = document_.createElement("span");
    list.className = "n-flow-overflow-list";
    for (const processor of processors) {
      const link = document_.createElement("a");
      link.className = "n-flow-overflow-link";
      link.dataset.flowMacroId = processor.id;
      link.dataset.flowSlot = String(processor.slot);
      link.href = processor.editHref;
      link.setAttribute("aria-haspopup", "dialog");
      link.setAttribute("aria-controls", "n-macro-dialog");
      link.setAttribute(
        "aria-label",
        `${processor.timeline.length === 0 ? "Invalid macro with no steps" : processor.disabled ? "Macro off" : "Macro"} ${processor.name} for Player ${processor.slot}. Open step editor.`,
      );
      const label = document_.createElement("strong");
      label.textContent = `P${processor.slot} · ${processor.name}`;
      const detail = document_.createElement("small");
      detail.textContent = processor.meta;
      link.append(label, detail);
      list.append(link);
    }
    element.replaceChildren(summary, list);
    element.open = wasOpen;
    if (restoreSummary) summary.focus();
    else if (restoreMacroId) {
      list.querySelector<HTMLAnchorElement>(
        `a[data-flow-macro-id="${CSS.escape(restoreMacroId)}"]`,
      )?.focus();
    }
  }

  #restoreProcessorFocus(): void {
    const macroId = this.#restoreProcessorFocusId;
    const overflow = this.#overflowNode;
    if (overflow && !overflow.hidden && this.#restoreOverflowOpen) overflow.open = true;
    this.#restoreOverflowOpen = false;
    if (this.#restoreOverflowSummaryFocus) {
      this.#restoreOverflowSummaryFocus = false;
      const summary = overflow && !overflow.hidden
        ? overflow.querySelector<HTMLElement>("summary")
        : null;
      if (summary) summary.focus();
      else this.#nodes.querySelector<HTMLAnchorElement>("a.n-flow-processor:not([hidden])")?.focus();
      if (!macroId) return;
    }
    if (!macroId) return;
    const escaped = CSS.escape(macroId);
    const direct = this.#nodes.querySelector<HTMLAnchorElement>(
      `a.n-flow-processor:not([hidden])[data-flow-macro-id="${escaped}"]`,
    );
    if (direct) {
      this.#restoreProcessorFocusId = null;
      direct.focus();
      return;
    }
    const grouped = overflow?.querySelector<HTMLAnchorElement>(
      `a.n-flow-overflow-link[data-flow-macro-id="${escaped}"]`,
    );
    if (!overflow || !grouped) {
      this.#restoreProcessorFocusId = null;
      return;
    }
    this.#restoreProcessorFocusId = null;
    overflow.open = true;
    grouped.focus();
  }

  #captureProcessorFocus(): void {
    const active = this.#root.ownerDocument.activeElement;
    if (!(active instanceof Element) || !this.#nodes.contains(active)) return;
    const focusedProcessor = active.closest<HTMLElement>("[data-flow-macro-id]");
    if (focusedProcessor?.dataset.flowMacroId) {
      this.#restoreProcessorFocusId = focusedProcessor.dataset.flowMacroId;
    }
    const overflow = this.#overflowNode;
    this.#restoreOverflowSummaryFocus = active === overflow?.querySelector("summary");
    this.#restoreOverflowOpen = overflow?.open ?? false;
  }

  #stampRoute(group: SVGGElement, route: MappingFlowSegment): void {
    group.dataset.flowId = route.id;
    group.dataset.flowKind = route.kind;
    group.dataset.flowChain = route.chainId;
    group.dataset.flowSlot = String(route.slot);
    if (route.source.kind === "key") group.dataset.flowKey = route.source.key;
    else delete group.dataset.flowKey;
    if (route.target.kind === "control") group.dataset.flowFn = route.target.functionName;
    else delete group.dataset.flowFn;
    group.classList.toggle("is-processing", route.kind !== "binding");
    if (route.kind !== "binding") {
      group.dataset.flowMacroId = route.processorId;
      const processor = this.#processorEntries.get(route.processorId)?.processor;
      group.classList.toggle("is-disabled", processor?.disabled ?? false);
    } else {
      delete group.dataset.flowMacroId;
      group.classList.remove("is-disabled");
    }
    if (route.kind === "macro-output") group.dataset.flowSteps = route.steps.join(" ");
    else delete group.dataset.flowSteps;
    group.dataset.flowPattern = String(((route.slot - 1) % 16 + 16) % 16 + 1);
    group.style.setProperty("--n-flow-color", `var(--pcs${route.slot})`);
  }

  #syncCameraTransform(): void {
    const transform = this.#stage.style.transform;
    this.#lines.style.transform = transform;
    this.#ports.style.transform = transform;
    this.#nodes.style.transform = transform;
  }

  #layout(): void {
    if (this.#mode === "off") return;
    this.#syncCameraTransform();
    const matrix = this.#lines.getScreenCTM();
    if (!matrix) {
      this.#syncObservedAnchors(new Set());
      this.#publishSummary({
        total: this.#routes.length,
        resolved: 0,
        unresolved: this.#routes.length,
        direct: this.#routes.filter((route) => route.kind === "binding").length,
        macroConnections: this.#routes.filter((route) => route.kind !== "binding").length,
        resolvedDirect: 0,
        resolvedMacroConnections: 0,
        processors: this.#processors.length,
        processorOverflow: this.#processors.length,
        unavailableMappings: this.#unavailableMappings,
        unavailableMacros: this.#unavailableMacros,
      });
      return;
    }
    const inverse = matrix.inverse();
    const scale = Math.max(0.01, Math.hypot(matrix.a, matrix.b));
    let resolved = 0;
    let resolvedDirect = 0;
    let resolvedMacroConnections = 0;
    let index = 0;
    const observedAnchors = new Set<Element>();
    const anchors: MappingAnchorCache = {
      keys: new Map(),
      controls: new Map(),
      pads: new Map(),
    };
    this.#layoutProcessors(matrix, inverse, scale, observedAnchors, anchors, true);
    for (const entry of this.#entries.values()) {
      const sourceElement = this.#resolveEndpoint(entry.route.source, entry.route.slot, anchors);
      const targetElement = this.#resolveEndpoint(entry.route.target, entry.route.slot, anchors);
      entry.sourceElement = sourceElement;
      entry.targetElement = targetElement;
      const visible = sourceElement !== null && targetElement !== null;
      entry.lineGroup.classList.toggle("is-unresolved", !visible);
      entry.portGroup.classList.toggle("is-unresolved", !visible);
      if (!visible) continue;

      entry.laneIndex = index;
      const lane = ((index % 7) - 3) * (4 / scale);
      this.#positionEntry(entry, inverse, scale, lane);
      resolved += 1;
      if (entry.route.kind === "binding") resolvedDirect += 1;
      else resolvedMacroConnections += 1;
      index += 1;
      observedAnchors.add(sourceElement);
      observedAnchors.add(targetElement);
    }
    this.#syncObservedAnchors(observedAnchors);
    const summary = {
      total: this.#routes.length,
      resolved,
      unresolved: this.#routes.length - resolved,
      direct: this.#routes.filter((route) => route.kind === "binding").length,
      macroConnections: this.#routes.filter((route) => route.kind !== "binding").length,
      resolvedDirect,
      resolvedMacroConnections,
      processors: this.#processors.length,
      processorOverflow: this.#processorOverflow,
      unavailableMappings: this.#unavailableMappings,
      unavailableMacros: this.#unavailableMacros,
    };
    this.#applyInspection();
    this.#publishSummary(summary);
    // Direct routes and their endpoints share one camera transform and need no
    // per-frame work. Only fixed-screen processors (and their few adjoining
    // macro segments) follow the interpolated matrix during Fit/Center.
    if (this.#viewport.classList.contains("is-camera-animating")) {
      this.#scheduleCameraLayout();
    }
  }

  #positionEntry(
    entry: MappingFlowEntry,
    inverse: DOMMatrix,
    scale: number,
    lane: number,
  ): void {
    if (!entry.sourceElement || !entry.targetElement) return;
    const source = this.#worldCenter(entry.sourceElement, inverse);
    const target = this.#worldCenter(entry.targetElement, inverse);
    const pathValue = mappingCurve(source, target, lane);
    entry.path.setAttribute("d", pathValue);
    entry.lineGroup.querySelector<SVGPathElement>(".n-flow-halo")?.setAttribute("d", pathValue);
    const radius = 3.7 / scale;
    entry.sourcePort.setAttribute("cx", source.x.toFixed(2));
    entry.sourcePort.setAttribute("cy", source.y.toFixed(2));
    entry.sourcePort.setAttribute("r", radius.toFixed(2));
    entry.targetPort.setAttribute("cx", target.x.toFixed(2));
    entry.targetPort.setAttribute("cy", target.y.toFixed(2));
    entry.targetPort.setAttribute("r", radius.toFixed(2));
  }

  #scheduleCameraLayout(): void {
    if (this.#mode === "off" || this.#layoutFrame !== 0) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = 0;
      this.#layoutCameraFrame();
    });
  }

  #layoutCameraFrame(): void {
    if (this.#mode === "off") return;
    this.#syncCameraTransform();
    const matrix = this.#lines.getScreenCTM();
    if (!matrix) return;
    const inverse = matrix.inverse();
    const scale = Math.max(0.01, Math.hypot(matrix.a, matrix.b));
    this.#layoutProcessors(matrix, inverse, scale, new Set(), null, false);
    for (const entry of this.#entries.values()) {
      if (entry.route.kind === "binding") continue;
      this.#positionEntry(
        entry,
        inverse,
        scale,
        ((entry.laneIndex % 7) - 3) * (4 / scale),
      );
    }
    if (this.#viewport.classList.contains("is-camera-animating")) {
      this.#scheduleCameraLayout();
    } else {
      this.scheduleLayout();
    }
  }

  #syncObservedAnchors(next: ReadonlySet<Element>): void {
    for (const anchor of this.#observedAnchors) {
      if (next.has(anchor)) continue;
      this.#resizeObserver.unobserve(anchor);
      this.#observedAnchors.delete(anchor);
    }
    for (const anchor of next) {
      if (this.#observedAnchors.has(anchor)) continue;
      this.#resizeObserver.observe(anchor);
      this.#observedAnchors.add(anchor);
    }
  }

  #publishSummary(summary: MappingFlowLayoutSummary): void {
    for (const layer of [this.#lines, this.#ports, this.#nodes]) {
      layer.dataset.flowCount = String(summary.resolved);
      layer.dataset.flowUnresolved = String(summary.unresolved);
      layer.dataset.flowDirect = String(summary.direct);
      layer.dataset.flowMacroConnections = String(summary.macroConnections);
      layer.dataset.flowResolvedDirect = String(summary.resolvedDirect);
      layer.dataset.flowResolvedMacroConnections = String(summary.resolvedMacroConnections);
      layer.dataset.flowProcessors = String(summary.processors);
      layer.dataset.flowProcessorOverflow = String(summary.processorOverflow);
      layer.dataset.flowMappingUnavailable = String(summary.unavailableMappings.length);
      layer.dataset.flowMacroUnavailable = String(summary.unavailableMacros.length);
    }
    this.#onLayout(summary);
  }

  #worldCenter(element: Element, inverse: DOMMatrix): DOMPoint {
    const screen = elementCenter(element);
    const point = this.#lines.createSVGPoint();
    point.x = screen.x;
    point.y = screen.y;
    return point.matrixTransform(inverse);
  }

  #layoutProcessors(
    matrix: DOMMatrix,
    inverse: DOMMatrix,
    scale: number,
    observedAnchors: Set<Element>,
    anchors: MappingAnchorCache | null,
    refreshAnchors: boolean,
  ): void {
    this.#captureProcessorFocus();
    const peers = new Map<number, MacroProcessorFlow[]>();
    const placedProcessors: DOMRect[] = [];
    const placedEntries: MacroProcessorEntry[] = [];
    const overflowProcessors: MacroProcessorFlow[] = [];
    // One screen-space obstacle snapshot per layout. Reading every widget's
    // box once for each processor turns a large macro library into needless
    // layout thrash, especially during an interpolated Fit/Center camera.
    const viewport = this.#viewport.getBoundingClientRect();
    const navigator = this.#viewport.querySelector<HTMLElement>(
      ".forma-canvas-navigator:not([hidden])",
    )?.getBoundingClientRect();
    const widgetObstacles = Array.from(
      this.#stage.querySelectorAll<HTMLElement>(".widget-instance:not([hidden])"),
    )
      .map((widget) => widget.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    // Fixed-size, 44px-class targets cannot be packed without limit. Keep a
    // small readable set on the graph and put the rest in one scrollable,
    // keyboard-operable macro bank. This is an explicit overflow contract,
    // not a best-effort pile whose later cards become unreachable.
    const cardCapacity = viewport.width <= 600 ? 2 : viewport.width <= 900 ? 3 : 5;
    const visibleProcessorLimit = this.#processors.length > cardCapacity
      ? cardCapacity - 1
      : this.#processors.length;
    for (const processor of this.#processors) {
      const list = peers.get(processor.slot) ?? [];
      list.push(processor);
      peers.set(processor.slot, list);
    }
    let processorIndex = 0;
    for (const entry of this.#processorEntries.values()) {
      const { processor, element } = entry;
      if (processorIndex >= visibleProcessorLimit) {
        element.hidden = true;
        overflowProcessors.push(processor);
        processorIndex += 1;
        continue;
      }
      processorIndex += 1;
      element.hidden = false;
      if (refreshAnchors && anchors) {
        entry.sourceElements = processor.triggers
          .map((key) => this.#resolveKeyCached(anchors, key, processor.slot))
          .filter((candidate): candidate is Element => candidate !== null);
        entry.targetElements = processor.outputs
          .map((output) => this.#resolveControlCached(anchors, processor.slot, output.functionName))
          .filter((candidate): candidate is Element => candidate !== null);
        entry.padElement = this.#resolvePadCached(anchors, processor.slot);
      }
      const sources = entry.sourceElements;
      const targets = entry.targetElements;
      const pad = entry.padElement;
      const sourcePoints = sources.map((source) => this.#worldCenter(source, inverse));
      const targetAnchors = targets.length > 0 ? targets : pad ? [pad] : [];
      const targetPoints = targetAnchors.map((target) => this.#worldCenter(target, inverse));
      const average = (points: readonly { x: number; y: number }[]) => ({
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      });
      const source = sourcePoints.length > 0
        ? average(sourcePoints)
        : targetPoints.length > 0
          ? { x: average(targetPoints).x, y: average(targetPoints).y - 260 }
          : null;
      const target = targetPoints.length > 0
        ? average(targetPoints)
        : source
          ? { x: source.x, y: source.y + 260 }
          : null;
      if (!source || !target) {
        element.hidden = true;
        overflowProcessors.push(processor);
        continue;
      }
      const slotPeers = peers.get(processor.slot) ?? [processor];
      const peerIndex = Math.max(0, slotPeers.findIndex((item) => item.id === processor.id));
      const fan = (peerIndex - (slotPeers.length - 1) / 2) * (194 / scale);
      const vertical = Math.abs(target.y - source.y) >= Math.abs(target.x - source.x);
      element.style.setProperty("--n-flow-node-inverse", (1 / scale).toFixed(5));
      const position = this.#processorPositionAvoidingOverlays(
        element,
        {
          x: source.x + (target.x - source.x) * 0.52 + (vertical ? fan : 0),
          y: source.y + (target.y - source.y) * 0.52 + (vertical ? 0 : fan),
        },
        matrix,
        inverse,
        placedProcessors,
        widgetObstacles,
        navigator,
        viewport,
      );
      if (!position) {
        element.hidden = true;
        overflowProcessors.push(processor);
        continue;
      }
      element.style.left = `${position.x.toFixed(2)}px`;
      element.style.top = `${position.y.toFixed(2)}px`;
      const screenPosition = position.matrixTransform(matrix);
      placedProcessors.push(new DOMRect(
        screenPosition.x - element.offsetWidth / 2,
        screenPosition.y - element.offsetHeight / 2,
        element.offsetWidth,
        element.offsetHeight,
      ));
      placedEntries.push(entry);
      observedAnchors.add(element);
      for (const anchor of [...sources, ...targetAnchors]) observedAnchors.add(anchor);
    }

    const overflow = this.#overflowNode;
    if (overflowProcessors.length === 0 || !overflow) {
      this.#syncOverflowElement([]);
      this.#restoreProcessorFocus();
      return;
    }
    this.#syncOverflowElement(overflowProcessors);
    overflow.style.setProperty("--n-flow-node-inverse", (1 / scale).toFixed(5));
    const bankScreen = this.#lines.createSVGPoint();
    bankScreen.x = viewport.left + viewport.width / 2;
    bankScreen.y = viewport.top + 12 + Math.max(36, overflow.offsetHeight / 2);
    const bankWorld = bankScreen.matrixTransform(inverse);
    let bankPosition = this.#processorPositionAvoidingOverlays(
      overflow,
      bankWorld,
      matrix,
      inverse,
      placedProcessors,
      widgetObstacles,
      navigator,
      viewport,
    );
    // If the chrome and visible cards leave no honest lane for the bank,
    // fold the last visible card into it and retry. With zero visible cards
    // the placed-only pass always has a reachable answer.
    while (!bankPosition && placedEntries.length > 0) {
      const folded = placedEntries.pop();
      placedProcessors.pop();
      if (!folded) break;
      folded.element.hidden = true;
      observedAnchors.delete(folded.element);
      overflowProcessors.unshift(folded.processor);
      this.#syncOverflowElement(overflowProcessors);
      bankPosition = this.#processorPositionAvoidingOverlays(
        overflow,
        bankWorld,
        matrix,
        inverse,
        placedProcessors,
        widgetObstacles,
        navigator,
        viewport,
      );
    }
    if (!bankPosition) {
      this.#restoreProcessorFocus();
      return;
    }
    overflow.style.left = `${bankPosition.x.toFixed(2)}px`;
    overflow.style.top = `${bankPosition.y.toFixed(2)}px`;
    observedAnchors.add(overflow);
    this.#restoreProcessorFocus();
  }

  /** Processor cards live in world coordinates but keep a fixed screen size.
   * Resolve chrome collisions in screen space, then project the adjusted
   * center back into the world. This stays exact at every camera zoom. */
  #processorPositionAvoidingOverlays(
    element: HTMLElement,
    position: { x: number; y: number },
    matrix: DOMMatrix,
    inverse: DOMMatrix,
    placedProcessors: readonly DOMRect[],
    widgets: readonly DOMRect[],
    navigator: DOMRect | undefined,
    viewport: DOMRect,
  ): DOMPoint | null {
    const margin = 12;
    // Desktop cards are 176px wide; the compact phone treatment is 136px so
    // two processors can occupy real, non-overlapping lanes in the narrow
    // canvas instead of becoming a stack of partially hidden targets.
    const halfWidth = Math.max(60, element.offsetWidth / 2);
    const halfHeight = Math.max(36, element.offsetHeight / 2);
    const world = this.#lines.createSVGPoint();
    world.x = position.x;
    world.y = position.y;
    const screen = world.matrixTransform(matrix);
    const minX = viewport.left + margin + halfWidth;
    const maxX = viewport.right - margin - halfWidth;
    const minY = viewport.top + margin + halfHeight;
    const maxY = viewport.bottom - margin - halfHeight;
    const clamp = (value: number, min: number, max: number) =>
      Math.min(Math.max(min, Math.min(max, value)), Math.max(min, max));
    const ideal = {
      x: clamp(screen.x, minX, maxX),
      y: clamp(screen.y, minY, maxY),
    };
    const hardObstacles = [...widgets, ...placedProcessors];
    const intersects = (x: number, y: number, rect: DOMRect) =>
      x + halfWidth + margin > rect.left &&
      x - halfWidth - margin < rect.right &&
      y + halfHeight + margin > rect.top &&
      y - halfHeight - margin < rect.bottom;
    const nearestClear = (obstacles: readonly DOMRect[]): { x: number; y: number } | null => {
      // Walk outward from the desired midpoint and stop at the first clear
      // screen-space lane. The old obstacle-boundary Cartesian product built
      // and sorted O(N²) candidates, then scanned O(N) obstacles for every
      // processor on every animation frame. This walk is bounded by viewport
      // size, allocates no candidate cloud, and short-circuits immediately.
      const stepX = Math.max(48, halfWidth * 2 + margin * 2);
      const stepY = Math.max(40, halfHeight * 2 + margin * 2);
      const maxRadius = Math.max(
        1,
        Math.ceil(Math.max(viewport.width / stepX, viewport.height / stepY)) + 1,
      );
      const seen = new Set<string>();
      const clearAt = (dx: number, dy: number): { x: number; y: number } | null => {
        const x = clamp(ideal.x + dx * stepX, minX, maxX);
        const y = clamp(ideal.y + dy * stepY, minY, maxY);
        const token = x.toFixed(2) + ":" + y.toFixed(2);
        if (seen.has(token)) return null;
        seen.add(token);
        return obstacles.some((rect) => intersects(x, y, rect)) ? null : { x, y };
      };
      for (let radius = 0; radius <= maxRadius; radius += 1) {
        if (radius === 0) {
          const center = clearAt(0, 0);
          if (center) return center;
          continue;
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          const top = clearAt(dx, -radius);
          if (top) return top;
          const bottom = clearAt(dx, radius);
          if (bottom) return bottom;
        }
        for (let dy = -radius + 1; dy < radius; dy += 1) {
          const left = clearAt(-radius, dy);
          if (left) return left;
          const right = clearAt(radius, dy);
          if (right) return right;
        }
      }
      return null;
    };
    // Widget chrome remains operable even when the map forces the ideal node
    // away from the midpoint. On a phone all three boxes may not fit at once;
    // in that case the passive navigator may sit under the reachable card.
    const adjustedScreen = nearestClear(navigator ? [...hardObstacles, navigator] : hardObstacles) ??
      nearestClear(hardObstacles) ??
      nearestClear(navigator ? [...placedProcessors, navigator] : placedProcessors) ??
      nearestClear(placedProcessors);
    if (!adjustedScreen) return null;

    const adjusted = this.#lines.createSVGPoint();
    adjusted.x = adjustedScreen.x;
    adjusted.y = adjustedScreen.y;
    return adjusted.matrixTransform(inverse);
  }

  #resolveEndpoint(
    endpoint: KeyFlowEndpoint | ControlFlowEndpoint | MacroFlowEndpoint,
    slot: number,
    anchors: MappingAnchorCache,
  ): Element | null {
    if (endpoint.kind === "key") return this.#resolveKeyCached(anchors, endpoint.key, slot);
    if (endpoint.kind === "control") {
      return this.#resolveControlCached(anchors, endpoint.slot, endpoint.functionName);
    }
    const node = this.#processorEntries.get(endpoint.id)?.element ?? null;
    return node && !node.hidden && endpointVisible(node) ? node : null;
  }

  #resolveKeyCached(
    anchors: MappingAnchorCache,
    keyName: string,
    slot: number,
  ): Element | null {
    const id = `${slot}\u0000${keyName}`;
    if (anchors.keys.has(id)) return anchors.keys.get(id) ?? null;
    const resolved = this.#resolveKey(keyName, slot);
    anchors.keys.set(id, resolved);
    return resolved;
  }

  #resolveKey(keyName: string, slotNumber: number): Element | null {
    const key = CSS.escape(keyName);
    const slot = String(slotNumber);
    const selectors = [
      `.n-deck-key[data-keylab-key="${key}"][data-player-slot="${slot}"]`,
      `.n-deck-key[data-keylab-key="${key}"]:not([data-player-slot])`,
      `.n-widget-kb:not([data-source-hidden="true"]) [data-key="${key}"]:not(.ghost):not(.extracted)`,
    ];
    for (const selector of selectors) {
      const candidate = this.#root.querySelector(selector);
      if (candidate && endpointVisible(candidate)) return candidate;
    }
    return null;
  }

  #resolvePad(slot: number): Element | null {
    const pad = this.#stage.querySelector(
      `.n-widget-pad [data-pad-slot="${slot}"]`,
    );
    return pad?.closest(".widget-instance") ?? pad;
  }

  #resolvePadCached(anchors: MappingAnchorCache, slot: number): Element | null {
    if (anchors.pads.has(slot)) return anchors.pads.get(slot) ?? null;
    const resolved = this.#resolvePad(slot);
    anchors.pads.set(slot, resolved);
    return resolved;
  }

  #resolveControl(slot: number, functionName: string): Element | null {
    const pad = this.#stage.querySelector(
      `.n-widget-pad [data-pad-slot="${slot}"]`,
    );
    if (!pad) return null;
    const candidates = Array.from(pad.querySelectorAll("svg [data-fn]"))
      .filter((element) => {
        if (element.localName === "text" || element.classList.contains("n-fnkey")) return false;
        const functions = (element.getAttribute("data-fn") ?? "")
          .split(/\s+/)
          .map(normalizedFunctionName);
        return functions.some((candidate) => sameControlDirection(candidate, functionName)) &&
          endpointVisible(element);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const hook = /hook/i.test(element.getAttribute("class") ?? "") ? 1000 : 0;
        const shape = /^(?:path|circle|ellipse|rect|polygon)$/.test(element.localName) ? 100 : 0;
        const hit = getComputedStyle(element).pointerEvents === "none" ? 0 : 25;
        return { element, score: hook + shape + hit - Math.log2(Math.max(1, rect.width * rect.height)) };
      })
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.element ?? null;
  }

  #resolveControlCached(
    anchors: MappingAnchorCache,
    slot: number,
    functionName: string,
  ): Element | null {
    const id = `${slot}\u0000${functionName}`;
    if (anchors.controls.has(id)) return anchors.controls.get(id) ?? null;
    const resolved = this.#resolveControl(slot, functionName);
    anchors.controls.set(id, resolved);
    return resolved;
  }

  #inspectionFor(target: EventTarget | null): MappingInspection | null {
    if (!(target instanceof Element)) return null;
    const macro = target.closest<HTMLElement>("[data-flow-macro-id]");
    if (macro?.dataset.flowMacroId) {
      return {
        macroId: macro.dataset.flowMacroId,
        slot: Number(macro.dataset.flowSlot ?? this.#selectedSlot),
      };
    }
    const key = target.closest<HTMLElement>("[data-key]")?.dataset.key?.trim();
    if (key) return { key };
    const control = target.closest<HTMLElement>("[data-fn]");
    const functionName = normalizedFunctionName(
      (control?.dataset.fn ?? "").split(/\s+/)[0] ?? "",
    );
    if (!functionName) return null;
    const slotText = control?.closest<HTMLElement>("[data-pad-slot]")?.dataset.padSlot ??
      control?.dataset.slot ?? String(this.#selectedSlot);
    const slot = Number(slotText);
    return { functionName, slot: Number.isFinite(slot) ? slot : this.#selectedSlot };
  }

  #inspectEvent(kind: "pointer" | "focus", event: Event): void {
    const inspection = this.#inspectionFor(event.target);
    if (inspection) this.#setInspection(kind, inspection);
  }

  #leaveEvent(kind: "pointer" | "focus", event: Event): void {
    const from = this.#inspectionFor(event.target);
    if (!from) return;
    const related = "relatedTarget" in event ? (event as FocusEvent).relatedTarget : null;
    const to = this.#inspectionFor(related);
    if (!inspectionEqual(from, to)) this.#setInspection(kind, to);
  }

  #activeInspection(): MappingInspection | null {
    return this.#pointerInspection ?? this.#focusInspection;
  }

  #setInspection(kind: "pointer" | "focus", inspection: MappingInspection | null): void {
    const before = this.#activeInspection();
    if (kind === "pointer") this.#pointerInspection = inspection;
    else this.#focusInspection = inspection;
    if (inspectionEqual(before, this.#activeInspection())) return;
    this.#applyInspection();
  }

  #clearInspections(): void {
    const hadInspection = this.#activeInspection() !== null;
    this.#pointerInspection = null;
    this.#focusInspection = null;
    if (hadInspection) this.#applyInspection();
  }

  #inspectionChains(): ReadonlySet<string> {
    const inspection = this.#activeInspection();
    const chains = new Set<string>();
    if (!inspection) return chains;
    if (inspection.macroId) chains.add(inspection.macroId);
    for (const route of this.#routes) {
      if (inspection.key && route.source.kind === "key" && route.source.key === inspection.key) {
        chains.add(route.chainId);
      }
      if (
        inspection.functionName &&
        route.target.kind === "control" &&
        sameControlDirection(route.target.functionName, inspection.functionName) &&
        route.target.slot === inspection.slot
      ) {
        chains.add(route.chainId);
      }
    }
    return chains;
  }

  #clearRelatedAnchors(): void {
    for (const anchor of this.#relatedAnchors) anchor.classList.remove("n-flow-anchor-related");
    this.#relatedAnchors.clear();
  }

  #applyInspection(): void {
    this.#clearRelatedAnchors();
    const inspecting = this.#activeInspection() !== null;
    this.#lines.classList.toggle("is-inspecting", inspecting);
    this.#ports.classList.toggle("is-inspecting", inspecting);
    this.#nodes.classList.toggle("is-inspecting", inspecting);
    const relatedChains = this.#inspectionChains();
    for (const entry of this.#processorEntries.values()) {
      const related = relatedChains.has(entry.processor.id);
      entry.element.classList.toggle("is-related", related);
      if (related) this.#relatedAnchors.add(entry.element);
    }
    const overflowRelated = Array.from(
      this.#overflowNode?.querySelectorAll<HTMLElement>("[data-flow-macro-id]") ?? [],
    ).some((link) => relatedChains.has(link.dataset.flowMacroId ?? ""));
    this.#overflowNode?.classList.toggle("is-related", overflowRelated);
    for (const entry of this.#entries.values()) {
      const related = relatedChains.has(entry.route.chainId);
      entry.lineGroup.classList.toggle("is-related", related);
      entry.portGroup.classList.toggle("is-related", related);
      if (!related) continue;
      if (entry.sourceElement) this.#relatedAnchors.add(entry.sourceElement);
      if (entry.targetElement) this.#relatedAnchors.add(entry.targetElement);
    }
    for (const anchor of this.#relatedAnchors) anchor.classList.add("n-flow-anchor-related");
  }
}
