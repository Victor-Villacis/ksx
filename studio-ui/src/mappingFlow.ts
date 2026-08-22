/**
 * Read-only mapping-flow projection for Nocturne's canvas.
 *
 * The mapper owns the binding graph; this layer only turns that truth into
 * visible edges.  Keeping the graph separate from DOM anchors is deliberate:
 * direct bindings are `key -> control` today, while a later automation editor
 * can split the same typed edge into `key -> macro -> control` without
 * pretending that the virtual controller itself performs the transform.
 */

export type MappingPathMode = "off" | "selected" | "all";

export interface MappingFlowPad {
  slot: number;
  preset: string;
  title: string;
  fn_keys: Record<string, string>;
  fn_names: Record<string, string>;
}

export interface DirectMappingFlow {
  id: string;
  kind: "binding";
  source: {
    kind: "key";
    id: string;
    key: string;
  };
  target: {
    kind: "control";
    id: string;
    slot: number;
    functionName: string;
    label: string;
  };
}

export interface MappingFlowLayoutSummary {
  total: number;
  resolved: number;
  unresolved: number;
}

interface MappingFlowEntry {
  route: DirectMappingFlow;
  lineGroup: SVGGElement;
  path: SVGPathElement;
  portGroup: SVGGElement;
  sourcePort: SVGCircleElement;
  targetPort: SVGCircleElement;
  sourceElement: Element | null;
  targetElement: Element | null;
}

interface MappingInspection {
  key?: string;
  slot?: number;
  functionName?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function mappingPathModeIsValid(value: unknown): value is MappingPathMode {
  return value === "off" || value === "selected" || value === "all";
}

function normalizedFunctionName(value: string): string {
  return value.trim().toLowerCase();
}

function routePart(value: string): string {
  // These identifiers live in Maps and data attributes, not CSS id selectors.
  // Keep URI escaping intact so values such as `A B` and `A_20B` cannot
  // collapse to the same route identity.
  return encodeURIComponent(value);
}

/** One edge per physical key -> virtual function, never per decorative SVG
 * hook.  Macro trigger ownership is intentionally absent: it is not a direct
 * controller binding and will become its own typed edge when served. */
export function deriveDirectMappingFlow(
  pads: readonly MappingFlowPad[],
): DirectMappingFlow[] {
  const routes: DirectMappingFlow[] = [];
  const seen = new Set<string>();
  for (const pad of [...pads].sort((left, right) => left.slot - right.slot)) {
    const entries = Object.entries(pad.fn_keys).sort(([left], [right]) =>
      normalizedFunctionName(left).localeCompare(normalizedFunctionName(right))
    );
    for (const [canonicalFunction, joinedKeys] of entries) {
      const functionName = normalizedFunctionName(canonicalFunction);
      if (!functionName) continue;
      const labelEntry = Object.entries(pad.fn_names).find(
        ([candidate]) => normalizedFunctionName(candidate) === functionName,
      );
      const label = labelEntry?.[1]?.trim() || canonicalFunction;
      for (const candidate of joinedKeys.split(/\s*·\s*/u)) {
        const key = candidate.trim();
        if (!key) continue;
        const signature = `${pad.slot}\u0000${key}\u0000${functionName}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        routes.push({
          id:
            `binding:${pad.slot}:${routePart(pad.preset)}:${routePart(key)}:${routePart(functionName)}`,
          kind: "binding",
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
    left?.functionName === right?.functionName;
}

/** Owns the two non-interactive SVG projections. The line layer sits below
 * widgets; the port layer sits above them. Both mirror the stage camera. */
export class MappingFlowLayer {
  readonly #root: HTMLElement;
  readonly #viewport: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #lines: SVGSVGElement;
  readonly #ports: SVGSVGElement;
  readonly #onLayout: (summary: MappingFlowLayoutSummary) => void;
  readonly #entries = new Map<string, MappingFlowEntry>();
  readonly #mutationObserver: MutationObserver;
  readonly #resizeObserver: ResizeObserver;
  readonly #abort = new AbortController();
  readonly #relatedAnchors = new Set<Element>();
  readonly #observedAnchors = new Set<Element>();
  #routes: DirectMappingFlow[] = [];
  #fingerprint = "";
  #mode: MappingPathMode = "off";
  #selectedSlot = 0;
  #pointerInspection: MappingInspection | null = null;
  #focusInspection: MappingInspection | null = null;
  #layoutFrame = 0;

  constructor(
    root: HTMLElement,
    viewport: HTMLElement,
    stage: HTMLElement,
    lines: SVGSVGElement,
    ports: SVGSVGElement,
    onLayout: (summary: MappingFlowLayoutSummary) => void = () => undefined,
  ) {
    this.#root = root;
    this.#viewport = viewport;
    this.#stage = stage;
    this.#lines = lines;
    this.#ports = ports;
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
    const all = deriveDirectMappingFlow(pads);
    this.#routes = mode === "off"
      ? []
      : mode === "selected"
        ? all.filter((route) => route.target.slot === selectedSlot)
        : all;
    const fingerprint = this.#routes.map((route) => route.id).join("|");
    const hidden = mode === "off";
    // SVGSVGElement does not consistently reflect HTMLElement.hidden; keep
    // the actual global attribute authoritative for CSS and accessibility.
    this.#lines.toggleAttribute("hidden", hidden);
    this.#ports.toggleAttribute("hidden", hidden);
    this.#viewport.dataset.canvasPaths = mode;
    this.#lines.dataset.flowMode = mode;
    this.#ports.dataset.flowMode = mode;
    if (fingerprint !== this.#fingerprint) {
      this.#fingerprint = fingerprint;
      this.#rebuild();
    } else {
      // Labels and other semantic metadata may change without changing the
      // edge set. Keep the retained DOM entries attached to current truth.
      for (const route of this.#routes) {
        const entry = this.#entries.get(route.id);
        if (entry) entry.route = route;
      }
    }
    this.#syncCameraTransform();
    if (hidden) {
      if (this.#layoutFrame !== 0) cancelAnimationFrame(this.#layoutFrame);
      this.#layoutFrame = 0;
      this.#clearInspections();
      this.#syncObservedAnchors(new Set());
      this.#publishSummary({ total: 0, resolved: 0, unresolved: 0 });
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
    slotFunctions: ReadonlyMap<number, ReadonlySet<string>>,
  ): void {
    for (const entry of this.#entries.values()) {
      const live = keysDown.has(entry.route.source.key) &&
        (slotFunctions.get(entry.route.target.slot)?.has(entry.route.target.functionName) ?? false);
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
    this.#lines.replaceChildren();
    this.#ports.replaceChildren();
  }

  #rebuild(): void {
    this.#clearRelatedAnchors();
    this.#entries.clear();
    this.#lines.replaceChildren();
    this.#ports.replaceChildren();
    this.#resizeObserver.disconnect();
    this.#observedAnchors.clear();
    this.#resizeObserver.observe(this.#viewport);
    const document_ = this.#root.ownerDocument;
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
      });
    }
  }

  #stampRoute(group: SVGGElement, route: DirectMappingFlow): void {
    group.dataset.flowId = route.id;
    group.dataset.flowKind = route.kind;
    group.dataset.flowKey = route.source.key;
    group.dataset.flowSlot = String(route.target.slot);
    group.dataset.flowFn = route.target.functionName;
    group.dataset.flowPattern = String(((route.target.slot - 1) % 16 + 16) % 16 + 1);
    group.style.setProperty("--n-flow-color", `var(--pcs${route.target.slot})`);
  }

  #syncCameraTransform(): void {
    const transform = this.#stage.style.transform;
    this.#lines.style.transform = transform;
    this.#ports.style.transform = transform;
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
      });
      return;
    }
    const inverse = matrix.inverse();
    const scale = Math.max(0.01, Math.hypot(matrix.a, matrix.b));
    let resolved = 0;
    let index = 0;
    const observedAnchors = new Set<Element>();
    for (const entry of this.#entries.values()) {
      const sourceElement = this.#resolveSource(entry.route);
      const targetElement = this.#resolveTarget(entry.route);
      entry.sourceElement = sourceElement;
      entry.targetElement = targetElement;
      const visible = sourceElement !== null && targetElement !== null;
      entry.lineGroup.classList.toggle("is-unresolved", !visible);
      entry.portGroup.classList.toggle("is-unresolved", !visible);
      if (!visible) continue;

      const sourceScreen = elementCenter(sourceElement);
      const targetScreen = elementCenter(targetElement);
      const sourcePoint = this.#lines.createSVGPoint();
      sourcePoint.x = sourceScreen.x;
      sourcePoint.y = sourceScreen.y;
      const targetPoint = this.#lines.createSVGPoint();
      targetPoint.x = targetScreen.x;
      targetPoint.y = targetScreen.y;
      const source = sourcePoint.matrixTransform(inverse);
      const target = targetPoint.matrixTransform(inverse);
      const lane = ((index % 7) - 3) * (4 / scale);
      const pathValue = mappingCurve(source, target, lane);
      entry.path.setAttribute("d", pathValue);
      const halo = entry.lineGroup.querySelector<SVGPathElement>(".n-flow-halo");
      halo?.setAttribute("d", pathValue);
      const radius = 3.7 / scale;
      entry.sourcePort.setAttribute("cx", source.x.toFixed(2));
      entry.sourcePort.setAttribute("cy", source.y.toFixed(2));
      entry.sourcePort.setAttribute("r", radius.toFixed(2));
      entry.targetPort.setAttribute("cx", target.x.toFixed(2));
      entry.targetPort.setAttribute("cy", target.y.toFixed(2));
      entry.targetPort.setAttribute("r", radius.toFixed(2));
      resolved += 1;
      index += 1;
      observedAnchors.add(sourceElement);
      observedAnchors.add(targetElement);
    }
    this.#syncObservedAnchors(observedAnchors);
    const summary = {
      total: this.#routes.length,
      resolved,
      unresolved: this.#routes.length - resolved,
    };
    this.#applyInspection();
    this.#publishSummary(summary);
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
    this.#lines.dataset.flowCount = String(summary.resolved);
    this.#lines.dataset.flowUnresolved = String(summary.unresolved);
    this.#ports.dataset.flowCount = String(summary.resolved);
    this.#ports.dataset.flowUnresolved = String(summary.unresolved);
    this.#onLayout(summary);
  }

  #resolveSource(route: DirectMappingFlow): Element | null {
    const key = CSS.escape(route.source.key);
    const slot = String(route.target.slot);
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

  #resolveTarget(route: DirectMappingFlow): Element | null {
    const pad = this.#stage.querySelector(
      `.n-widget-pad [data-pad-slot="${route.target.slot}"]`,
    );
    if (!pad) return null;
    const candidates = Array.from(pad.querySelectorAll("svg [data-fn]"))
      .filter((element) => {
        if (element.localName === "text" || element.classList.contains("n-fnkey")) return false;
        const functions = (element.getAttribute("data-fn") ?? "")
          .split(/\s+/)
          .map(normalizedFunctionName);
        return functions.includes(route.target.functionName) && endpointVisible(element);
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

  #inspectionFor(target: EventTarget | null): MappingInspection | null {
    if (!(target instanceof Element)) return null;
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

  #routeMatchesInspection(route: DirectMappingFlow): boolean {
    const inspection = this.#activeInspection();
    if (!inspection) return false;
    if (inspection.key) return route.source.key === inspection.key;
    return route.target.functionName === inspection.functionName &&
      route.target.slot === inspection.slot;
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
    for (const entry of this.#entries.values()) {
      const related = this.#routeMatchesInspection(entry.route);
      entry.lineGroup.classList.toggle("is-related", related);
      entry.portGroup.classList.toggle("is-related", related);
      if (!related) continue;
      if (entry.sourceElement) this.#relatedAnchors.add(entry.sourceElement);
      if (entry.targetElement) this.#relatedAnchors.add(entry.targetElement);
    }
    for (const anchor of this.#relatedAnchors) anchor.classList.add("n-flow-anchor-related");
  }
}
