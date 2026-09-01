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

// Nocturne may replace the client-owned flow DOM while adopting a fresh
// server snapshot. Keep this transient disclosure outside the layer instance
// so a harmless snapshot refresh cannot close it between pointerup and click.
let openProcessorNudgeId = "";

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

/** One physical source's mapping table for a controller slot. New payloads
 * carry these rows so two keyboards may bind the same key independently;
 * older payloads keep their single table on MappingFlowPad itself. */
export interface MappingFlowSource {
  sourceId?: string;
  sourceAlias?: string;
  /** Read-only aliases accepted while the Rust wire spelling remains
   * snake_case. Routes normalize both spellings immediately. */
  source_id?: string;
  source_alias?: string;
  preset?: string;
  fn_keys?: Record<string, string>;
  fn_names?: Record<string, string>;
  controls?: readonly MappingFlowControl[];
  mapping_available?: boolean;
  mapping_reason?: string;
  macros?: readonly MappingFlowMacro[];
  macro_available?: boolean;
  macro_reason?: string;
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
  /** Absent means the legacy top-level table. Present (including empty)
   * authoritatively replaces that table with source-qualified rows. */
  sources?: readonly MappingFlowSource[];
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
  sourceId: string;
  sourceAlias: string;
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
  sourceId: string;
  sourceAlias: string;
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
  sourceId?: string;
  sourceAlias?: string;
}

export interface MappingLiveKeyIdentity {
  key: string;
  sourceId: string;
  sourceAlias: string;
}

const QUALIFIED_LIVE_KEY_PREFIX = "\u0001";

/** Sets remain the narrow live-feedback port shared with RedesignIsland.
 * Qualified entries use a collision-proof JSON tuple; raw key strings remain
 * valid for old callers and old frames. */
export function mappingLiveKeyToken(
  key: string,
  sourceId = "",
  sourceAlias = "",
): string {
  return sourceId || sourceAlias
    ? `${QUALIFIED_LIVE_KEY_PREFIX}${JSON.stringify([sourceId, sourceAlias, key])}`
    : key;
}

export function parseMappingLiveKeyToken(token: string): MappingLiveKeyIdentity {
  if (token.startsWith(QUALIFIED_LIVE_KEY_PREFIX)) {
    try {
      const tuple = JSON.parse(token.slice(1)) as unknown;
      if (
        Array.isArray(tuple) && tuple.length === 3 &&
        tuple.every((part) => typeof part === "string")
      ) {
        return { sourceId: tuple[0], sourceAlias: tuple[1], key: tuple[2] };
      }
    } catch {
      // A malformed forward-compatible token is not allowed to impersonate
      // an unqualified key. It remains unmatched through the empty key.
    }
    return { sourceId: "", sourceAlias: "", key: "" };
  }
  return { sourceId: "", sourceAlias: "", key: token };
}

type MappingSourceIdentity = Pick<MappingLiveKeyIdentity, "sourceId" | "sourceAlias">;

/** Physical-source discovery is shared by static cord layout and 60 Hz live
 * paint so both layers make the same exact/ambiguous decision. */
export function mappingSourceRoots(scope: HTMLElement): HTMLElement[] {
  return Array.from(new Set(scope.querySelectorAll<HTMLElement>(
    ".rd-keyboard-device-node[data-source-id], [data-mapping-source=\"true\"]",
  )));
}

export function mappingRootSourceId(root: HTMLElement): string {
  return root.dataset.sourceId?.trim() || root.dataset.selector?.trim() || "";
}

export function mappingRootSourceAlias(root: HTMLElement): string {
  return root.dataset.sourceAlias?.trim() ||
    root.querySelector<HTMLInputElement>('.rd-stageform input[name="alias"]')?.value.trim() ||
    "";
}

function mappingRootSourceInstances(root: HTMLElement): string[] {
  return Array.from(new Set([
    root.dataset.sourceInstance,
    root.dataset.instanceId,
    root.querySelector<HTMLInputElement>('.rd-stageform input[name="instance_id"]')?.value,
  ].map((value) => value?.trim() ?? "").filter(Boolean)));
}

function uniqueMappingSource(roots: readonly HTMLElement[]): HTMLElement | null {
  return roots.length === 1 ? roots[0] : null;
}

export function resolveMappingSourceRoot(
  roots: readonly HTMLElement[],
  source: MappingSourceIdentity,
): HTMLElement | null {
  if (source.sourceId) {
    const exact = roots.filter((root) => mappingRootSourceId(root) === source.sourceId);
    if (exact.length > 0) return uniqueMappingSource(exact);
  }
  if (source.sourceAlias) {
    const aliases = roots.filter((root) => mappingRootSourceAlias(root) === source.sourceAlias);
    if (aliases.length > 0) return uniqueMappingSource(aliases);
  }
  // An old unqualified route is safe only with one possible physical node.
  if (source.sourceId || source.sourceAlias || roots.length !== 1) return null;
  return roots[0];
}

export function resolveMappingLiveSourceRoot(
  roots: readonly HTMLElement[],
  identity: MappingSourceIdentity,
): HTMLElement | null {
  if (identity.sourceId) {
    const exact = roots.filter((root) => mappingRootSourceId(root) === identity.sourceId);
    if (exact.length > 0) return uniqueMappingSource(exact);
    const folded = identity.sourceId.toUpperCase();
    const instances = roots.filter((root) =>
      mappingRootSourceInstances(root).some((candidate) => candidate.toUpperCase() === folded)
    );
    if (instances.length > 0) return uniqueMappingSource(instances);
  }
  if (identity.sourceAlias) {
    const aliases = roots.filter((root) =>
      mappingRootSourceAlias(root) === identity.sourceAlias
    );
    if (aliases.length > 0) return uniqueMappingSource(aliases);
  }
  if (!identity.sourceId && !identity.sourceAlias && roots.length === 1) return roots[0];
  // A qualified event may fall back only to one truly legacy, identity-free
  // root. It never guesses between modern boards.
  const legacy = roots.filter((root) =>
    !mappingRootSourceId(root) && !mappingRootSourceAlias(root)
  );
  return roots.length === 1 ? uniqueMappingSource(legacy) : null;
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

/** A processor's manual canvas adjustment. It is deliberately an OFFSET from
 * semantic auto-placement rather than an absolute point, so moving either
 * endpoint keeps the transformation attached to the relationship the user
 * arranged. */
export interface MappingFlowProcessorOffset {
  x: number;
  y: number;
}

/** Host-owned chrome hooks. Mapping truth remains read-only in this module;
 * only the optional processor offsets cross this presentation boundary. */
export interface MappingFlowLayerOptions {
  onLayout?: (summary: MappingFlowLayoutSummary) => void;
  /** undefined = durable Auto, null = session Auto whose durable reset needs
   * retrying, finite coordinates = the current manual displacement. */
  getProcessorOffset?: (
    processorId: string,
  ) => MappingFlowProcessorOffset | null | undefined;
  processorOffsetIsSessionOnly?: (processorId: string) => boolean;
  onProcessorOffsetCommit?: (
    processorId: string,
    offset: MappingFlowProcessorOffset | null,
  ) => boolean;
  announce?: (message: string) => void;
  /** Focusable, non-SVG projection of the same causal relations. The visual
   * cords stay aria-hidden; this list is the traceable assistive-technology
   * and compact-pointer alternative. */
  routeList?: HTMLOListElement | null;
  /** Compact visible description of the relation(s) under inspection. */
  traceOutput?: HTMLOutputElement | null;
}

interface MappingFlowEntry {
  route: MappingFlowSegment;
  lineGroup: SVGGElement;
  halo: SVGPathElement;
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
  shell: HTMLDivElement;
  element: HTMLAnchorElement;
  moveGrip: HTMLButtonElement;
  autoButton: HTMLButtonElement;
  nudgeToggle: HTMLButtonElement;
  nudgeMenu: HTMLDivElement;
  sourceElements: Element[];
  targetElements: Element[];
  padElement: Element | null;
  automaticPosition: { x: number; y: number } | null;
  renderedPosition: { x: number; y: number } | null;
  manualOffset: MappingFlowProcessorOffset | null;
  previewOffset: MappingFlowProcessorOffset | null;
  savePending: boolean;
  resetPending: boolean;
}

interface MappingFlowRelationSummary {
  chainId: string;
  slot: number;
  description: string;
  routeCount: number;
}

interface MappingAnchorCache {
  keys: Map<string, Element | null>;
  controls: Map<string, Element | null>;
  pads: Map<number, Element | null>;
}

interface MappingInspection {
  key?: string;
  sourceId?: string;
  slot?: number;
  functionName?: string;
  macroId?: string;
  chainId?: string;
}

type MacroProcessorFocusTarget =
  | "editor"
  | "move"
  | "auto"
  | "nudge"
  | "nudge-left"
  | "nudge-up"
  | "nudge-down"
  | "nudge-right";

const SVG_NS = "http://www.w3.org/2000/svg";

function finiteProcessorOffset(
  value: MappingFlowProcessorOffset | null | undefined,
): MappingFlowProcessorOffset | null {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}

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

interface MappingFlowSourceProjection {
  sourceId: string;
  sourceAlias: string;
  preset: string;
  fnKeys: Record<string, string>;
  fnNames: Record<string, string>;
  controls?: readonly MappingFlowControl[];
  mappingAvailable: boolean;
  mappingReason: string;
  macros: readonly MappingFlowMacro[];
  macroAvailable: boolean;
  macroReason: string;
}

function padSourceRows(pad: MappingFlowPad): MappingFlowSourceProjection[] {
  const rows: readonly (MappingFlowSource | null)[] = pad.sources === undefined
    ? [null]
    : pad.sources;
  return rows.map((source) => ({
    sourceId: (source?.sourceId ?? source?.source_id ?? "").trim(),
    sourceAlias: (source?.sourceAlias ?? source?.source_alias ?? "").trim(),
    preset: source?.preset?.trim() || pad.preset,
    fnKeys: source === null ? pad.fn_keys : source.fn_keys ?? {},
    fnNames: source?.fn_names ?? pad.fn_names,
    controls: source === null ? pad.controls : source.controls,
    mappingAvailable: (source?.mapping_available ?? pad.mapping_available) !== false,
    mappingReason: source?.mapping_reason?.trim() || pad.mapping_reason?.trim() ||
      "Direct mapping information is unavailable.",
    macros: source === null ? pad.macros ?? [] : source.macros ?? [],
    macroAvailable: (source?.macro_available ?? pad.macro_available) !== false,
    macroReason: source?.macro_reason?.trim() || pad.macro_reason?.trim() ||
      "Macro information is unavailable.",
  }));
}

function sourceIdentity(source: MappingFlowSourceProjection): string {
  return source.sourceId || source.sourceAlias;
}

function qualifiedRoutePart(source: MappingFlowSourceProjection): string {
  const identity = sourceIdentity(source);
  return identity ? `:source:${routePart(identity)}` : "";
}

function keyEndpoint(source: MappingFlowSourceProjection, key: string): KeyFlowEndpoint {
  const identity = sourceIdentity(source);
  return {
    kind: "key",
    id: identity ? `key:${routePart(identity)}:${routePart(key)}` : `key:${key}`,
    key,
    sourceId: source.sourceId,
    sourceAlias: source.sourceAlias,
  };
}

function functionLabel(source: MappingFlowSourceProjection, canonicalFunction: string): string {
  const functionName = normalizedFunctionName(canonicalFunction);
  const direction = directionalAnchorFunction(functionName);
  const control = source.controls?.find(
    (candidate) =>
      normalizedFunctionName(candidate.function) === functionName ||
      (direction !== null && normalizedFunctionName(candidate.function) === direction),
  );
  const normalizedLabel = control?.label.trim();
  if (normalizedLabel) return normalizedLabel;
  const labelEntry = Object.entries(source.fnNames).find(
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
    for (const source of padSourceRows(pad)) {
      if (!source.mappingAvailable) continue;
      const controls = [...(source.controls ?? [])]
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
      const legacyEntries = Object.entries(source.fnKeys)
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
      const entries: [string, readonly string[]][] = source.controls === undefined
        ? legacyEntries
        : [...controls, ...legacyEntries];
      for (const [canonicalFunction, keys] of entries) {
        const functionName = normalizedFunctionName(canonicalFunction);
        if (!functionName) continue;
        const label = functionLabel(source, canonicalFunction);
        for (const candidate of keys) {
          const key = candidate.trim();
          if (!key) continue;
          // Identity and DOM id must use the same source fact. An alias is
          // presentation metadata once an exact selector exists; allowing it
          // into only the dedupe key could emit two routes with one id.
          const signature =
            `${sourceIdentity(source)}\u0000${pad.slot}\u0000${key}\u0000${functionName}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          const id =
            `binding:${pad.slot}:${routePart(source.preset)}${qualifiedRoutePart(source)}:${routePart(key)}:${routePart(functionName)}`;
          routes.push({
            id,
            kind: "binding",
            chainId: id,
            slot: pad.slot,
            source: keyEndpoint(source, key),
            target: {
              kind: "control",
              id: `control:${source.preset}:${functionName}`,
              slot: pad.slot,
              functionName,
              label,
            },
          });
        }
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
  const routes: MappingFlowSegment[] = [...deriveDirectMappingFlow(pads)];
  const processors: MacroProcessorFlow[] = [];
  const unavailableMappings: MappingFlowUnavailable[] = [];
  const unavailableMacros: MappingFlowUnavailable[] = [];
  for (const pad of [...pads].sort((left, right) => left.slot - right.slot)) {
    for (const source of padSourceRows(pad)) {
      if (!source.mappingAvailable) {
        unavailableMappings.push({
          slot: pad.slot,
          reason: source.mappingReason,
          sourceId: source.sourceId || undefined,
          sourceAlias: source.sourceAlias || undefined,
        });
      }
      if (!source.macroAvailable) {
        unavailableMacros.push({
          slot: pad.slot,
          reason: source.macroReason,
          sourceId: source.sourceId || undefined,
          sourceAlias: source.sourceAlias || undefined,
        });
        continue;
      }
      const macros = [...source.macros].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const macro of macros) {
        const triggers = Array.from(
          new Set(macro.triggers.map((key) => key.trim()).filter(Boolean)),
        );
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
          `macro:${pad.slot}:${routePart(source.preset)}${qualifiedRoutePart(source)}:${routePart(macro.name)}`;
        const processor: MacroProcessorFlow = {
          id: processorId,
          kind: "macro",
          slot: pad.slot,
          preset: source.preset,
          sourceId: source.sourceId,
          sourceAlias: source.sourceAlias,
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
            source: keyEndpoint(source, key),
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
              id: `control:${source.preset}:${functionName}`,
              slot: pad.slot,
              functionName,
              label: functionLabel(source, functionName),
            },
          });
        }
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
  const distance = Math.max(0.01, Math.hypot(dx, dy));
  const along = Math.min(distance * 0.38, 150);
  const ux = dx / distance;
  const uy = dy / distance;
  const nx = -uy;
  const ny = ux;
  const first = {
    x: source.x + ux * along + nx * lane,
    y: source.y + uy * along + ny * lane,
  };
  const second = {
    x: target.x - ux * along + nx * lane,
    y: target.y - uy * along + ny * lane,
  };
  return `M ${source.x.toFixed(2)} ${source.y.toFixed(2)} C ${first.x.toFixed(2)} ${first.y.toFixed(2)}, ${second.x.toFixed(2)} ${second.y.toFixed(2)}, ${target.x.toFixed(2)} ${target.y.toFixed(2)}`;
}

/** The original direct-binding treatment: one axis-aware S-curve from its
 * physical key to its virtual control. Macro segments intentionally retain
 * the newer tangent curve above. */
export function mappingLassoCurve(
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
  // Chromium preserves geometry for descendants of a closed <details> even
  // though they are not painted. Without this structural check cords can end
  // at invisible tokens after a source shelf is folded.
  if (element.closest("details:not([open])")) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function elementCenter(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The visible handle on a keycap's perimeter, facing its peer. Starting at
 * the center paints across the legend and makes the cord look attached to
 * the keyboard shell once opaque art covers that first half of the route. */
function elementPerimeterPoint(
  element: Element,
  toward: { x: number; y: number },
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  if (
    Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 ||
    halfWidth < 1 ||
    halfHeight < 1
  ) {
    return center;
  }
  // Arcade presentation turns a loose workbench key into a round button. A
  // control-surface route now starts at its visible Windows-key token, which is
  // intentionally rectangular even when the physical control beside it is
  // round.
  const roundSurface = element.localName === "circle" || element.localName === "ellipse";
  const distance = roundSurface || (
    element.matches(".n-deck-key") &&
      element.closest<HTMLElement>('.n-keylab-deck[data-render-mode="arcade"]')
  )
    ? 1 / Math.sqrt((dx * dx) / (halfWidth * halfWidth) + (dy * dy) / (halfHeight * halfHeight))
    : 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: center.x + dx * distance, y: center.y + dy * distance };
}

function inspectionEqual(left: MappingInspection | null, right: MappingInspection | null): boolean {
  return left?.key === right?.key &&
    left?.sourceId === right?.sourceId &&
    left?.slot === right?.slot &&
    left?.functionName === right?.functionName &&
    left?.macroId === right?.macroId &&
    left?.chainId === right?.chainId;
}

/** Owns two non-interactive SVG projections plus an interactive HTML processor
 * layer. Cords and ports sit above widget art so their per-key handles remain
 * visible; processor cards sit above both. All mirror the stage camera. */
export class MappingFlowLayer {
  readonly #root: HTMLElement;
  readonly #viewport: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #lines: SVGSVGElement;
  readonly #ports: SVGSVGElement;
  readonly #nodes: HTMLElement;
  readonly #onLayout: (summary: MappingFlowLayoutSummary) => void;
  readonly #getProcessorOffset: (
    processorId: string,
  ) => MappingFlowProcessorOffset | null | undefined;
  readonly #processorOffsetIsSessionOnly: (processorId: string) => boolean;
  readonly #onProcessorOffsetCommit: (
    processorId: string,
    offset: MappingFlowProcessorOffset | null,
  ) => boolean;
  readonly #announce: (message: string) => void;
  readonly #routeList: HTMLOListElement | null;
  readonly #traceOutput: HTMLOutputElement | null;
  readonly #entries = new Map<string, MappingFlowEntry>();
  readonly #processorEntries = new Map<string, MacroProcessorEntry>();
  readonly #mutationObserver: MutationObserver;
  readonly #resizeObserver: ResizeObserver;
  readonly #abort = new AbortController();
  readonly #relatedAnchors = new Set<Element>();
  readonly #observedAnchors = new Set<Element>();
  #liveKeysDown: readonly MappingLiveKeyIdentity[] = [];
  #liveKeyHits: readonly MappingLiveKeyIdentity[] = [];
  #liveSlotFunctionsDown: ReadonlyMap<number, ReadonlySet<string>> = new Map();
  #liveSlotFunctionHits: ReadonlyMap<number, ReadonlySet<string>> = new Map();
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
  #routeListFingerprint = "";
  #restoreProcessorFocusId: string | null = null;
  #restoreProcessorFocusTarget: MacroProcessorFocusTarget = "editor";
  #restoreOverflowSummaryFocus = false;
  #restoreOverflowOpen = false;
  #processorDragPointerId: number | null = null;
  #cancelProcessorDrag: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    viewport: HTMLElement,
    stage: HTMLElement,
    lines: SVGSVGElement,
    ports: SVGSVGElement,
    nodes: HTMLElement,
    options: MappingFlowLayerOptions | ((summary: MappingFlowLayoutSummary) => void) = {},
  ) {
    this.#root = root;
    this.#viewport = viewport;
    this.#stage = stage;
    this.#lines = lines;
    this.#ports = ports;
    this.#nodes = nodes;
    const normalizedOptions: MappingFlowLayerOptions = typeof options === "function"
      ? { onLayout: options }
      : options;
    this.#onLayout = normalizedOptions.onLayout ?? (() => undefined);
    this.#getProcessorOffset = normalizedOptions.getProcessorOffset ?? (() => undefined);
    this.#processorOffsetIsSessionOnly =
      normalizedOptions.processorOffsetIsSessionOnly ?? (() => false);
    this.#onProcessorOffsetCommit = normalizedOptions.onProcessorOffsetCommit ?? (() => true);
    this.#announce = normalizedOptions.announce ?? (() => undefined);
    this.#routeList = normalizedOptions.routeList ?? null;
    this.#traceOutput = normalizedOptions.traceOutput ?? null;
    this.#mutationObserver = new MutationObserver((records) => {
      let cameraChanged = false;
      let geometryChanged = false;
      for (const record of records) {
        if (record.target === this.#stage) cameraChanged = true;
        else geometryChanged = true;
      }
      // A pointer delta is converted through the camera matrix captured at
      // gesture start. Any camera mutation invalidates that matrix, so cancel
      // the gesture before another pointer event can apply stale coordinates.
      if (cameraChanged) this.#cancelProcessorDrag?.();
      if (cameraChanged) this.#syncCameraTransform();
      if (cameraChanged || geometryChanged) this.scheduleLayout();
    });
    this.#mutationObserver.observe(stage, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style"],
    });
    this.#resizeObserver = new ResizeObserver(() => {
      // Viewport resizes invalidate the gesture's captured camera matrix; an
      // anchor resize can move its semantic Auto point. In either case an
      // in-flight preview is no longer anchored to the geometry it began on.
      this.#cancelProcessorDrag?.();
      this.scheduleLayout();
    });
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
    // CSS hover/focus lifts keycaps without mutating inline geometry. The flow
    // SVG also starts its Fit transition just after the stage; on a busy
    // browser it can settle one frame after the camera class disappears.
    // Re-anchor after either transition reaches its authoritative transform.
    const settleTransform = (event: TransitionEvent): void => {
      if (
        event.propertyName === "transform" &&
        event.pseudoElement === "" &&
        (
          event.target === this.#lines ||
          event.target instanceof Element &&
            event.target.matches(
              ".n-widget-kb .n-key:not(.ghost), .n-deck-key, .n-surface-control",
            )
        )
      ) {
        this.scheduleLayout();
      }
    };
    root.addEventListener("transitionend", settleTransform, { signal: this.#abort.signal });
    root.addEventListener("transitioncancel", settleTransform, { signal: this.#abort.signal });
    root.addEventListener("keydown", (event) => {
      const processor = event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>(
          "a.n-flow-processor, a.n-flow-overflow-link",
        )
        : null;
      if (
        event.key === "Enter" &&
        processor &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        // The canvas owns nested keyboard scopes. Activate processors during
        // capture before a widget shell can reinterpret Enter as focus mode.
        event.preventDefault();
        event.stopPropagation();
        processor.click();
        return;
      }
      if (event.key === "Escape") {
        const focusedNudgeShell = event.target instanceof Element &&
            event.target.closest(".n-flow-processor-nudges")
          ? event.target.closest<HTMLElement>(
            ".n-flow-processor-shell[data-flow-macro-id]",
          )
          : null;
        const focusedNudgeEntry = focusedNudgeShell?.dataset.flowMacroId
          ? this.#processorEntries.get(focusedNudgeShell.dataset.flowMacroId)
          : undefined;
        this.#cancelProcessorDrag?.();
        openProcessorNudgeId = "";
        for (const entry of this.#processorEntries.values()) {
          entry.nudgeMenu.hidden = true;
          entry.nudgeToggle.setAttribute("aria-expanded", "false");
        }
        if (focusedNudgeEntry) {
          event.preventDefault();
          event.stopPropagation();
          focusedNudgeEntry.nudgeToggle.focus();
        }
        this.#clearInspections();
      }
    }, { capture: true, signal: this.#abort.signal });
    const window_ = root.ownerDocument.defaultView;
    window_?.addEventListener("blur", () => this.#cancelProcessorDrag?.(), {
      signal: this.#abort.signal,
    });
    root.ownerDocument.addEventListener("visibilitychange", () => {
      if (root.ownerDocument.hidden) this.#cancelProcessorDrag?.();
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
    if (!processorIds.has(openProcessorNudgeId)) openProcessorNudgeId = "";
    const chainIds = new Set(this.#routes.map((route) => route.chainId));
    if (this.#pointerInspection?.macroId && !processorIds.has(this.#pointerInspection.macroId)) {
      this.#pointerInspection = null;
    }
    if (this.#focusInspection?.macroId && !processorIds.has(this.#focusInspection.macroId)) {
      this.#focusInspection = null;
    }
    if (this.#pointerInspection?.chainId && !chainIds.has(this.#pointerInspection.chainId)) {
      this.#pointerInspection = null;
    }
    if (this.#focusInspection?.chainId && !chainIds.has(this.#focusInspection.chainId)) {
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
    this.#syncSemanticRoutes();
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
      this.#cancelProcessorDrag?.();
      openProcessorNudgeId = "";
      this.#restoreProcessorFocusId = null;
      this.#restoreProcessorFocusTarget = "editor";
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

  #resolveSourceRoot(source: Pick<KeyFlowEndpoint, "sourceId" | "sourceAlias">): HTMLElement | null {
    return resolveMappingSourceRoot(mappingSourceRoots(this.#root), source);
  }

  #sourceLabel(source: KeyFlowEndpoint): string {
    const root = this.#resolveSourceRoot(source);
    return source.sourceAlias || root?.dataset.widgetName?.trim() ||
      (root?.classList.contains("rd-encoder-device-node") ? "Encoder" : "Keyboard");
  }

  #sourceRootMatchesId(source: KeyFlowEndpoint, sourceId: string | undefined): boolean {
    return !sourceId || source.sourceId === sourceId;
  }

  #relationSummaries(): MappingFlowRelationSummary[] {
    const byChain = new Map<string, MappingFlowSegment[]>();
    for (const route of this.#routes) {
      const group = byChain.get(route.chainId) ?? [];
      group.push(route);
      byChain.set(route.chainId, group);
    }
    const summaries: MappingFlowRelationSummary[] = [];
    const emitted = new Set<string>();
    for (const route of this.#routes) {
      if (emitted.has(route.chainId)) continue;
      emitted.add(route.chainId);
      const chain = byChain.get(route.chainId) ?? [route];
      if (route.kind === "binding") {
        const sourceLabel = this.#sourceLabel(route.source);
        summaries.push({
          chainId: route.chainId,
          slot: route.slot,
          description: `${sourceLabel} · ${route.source.key} → P${route.slot} ${route.target.label}`,
          routeCount: 1,
        });
        continue;
      }
      const processor = this.#processors.find((candidate) => candidate.id === route.chainId);
      const triggers = Array.from(new Set(chain.flatMap((segment) =>
        segment.kind === "macro-trigger" ? [segment.source.key] : []
      )));
      const triggerSource = chain.find((segment) => segment.kind === "macro-trigger");
      const triggerSourceLabel = triggerSource?.source.kind === "key"
        ? this.#sourceLabel(triggerSource.source)
        : "Keyboard";
      const targets = Array.from(new Set(chain.flatMap((segment) =>
        segment.kind === "macro-output" ? [`P${segment.slot} ${segment.target.label}`] : []
      )));
      const triggerLabel = triggers.length === 0
        ? "No host trigger"
        : triggers.map((key) => `${triggerSourceLabel} · ${key}`).join(" or ");
      const targetLabel = targets.length === 0 ? "no virtual output" : targets.join(", ");
      summaries.push({
        chainId: route.chainId,
        slot: route.slot,
        description: `${triggerLabel} → P${route.slot} ${processor?.name ?? "Macro"} macro${
          processor?.disabled ? " (off)" : ""
        } → ${targetLabel}`,
        routeCount: chain.length,
      });
    }
    return summaries;
  }

  #syncSemanticRoutes(): void {
    const list = this.#routeList;
    if (!list) return;
    const summaries = this.#relationSummaries();
    const container = list.closest<HTMLDetailsElement>("details");
    const hidden = this.#mode === "off" || summaries.length === 0;
    list.toggleAttribute("hidden", hidden);
    if (container) container.hidden = hidden;
    const count = container?.querySelector<HTMLElement>("[data-flow-route-index-count]");
    if (count) {
      count.textContent = `${summaries.length} ${summaries.length === 1 ? "route" : "routes"}`;
    }
    const fingerprint = summaries.map((summary) =>
      `${summary.chainId}\u0000${summary.description}\u0000${summary.routeCount}`
    ).join("\u0001");
    if (fingerprint === this.#routeListFingerprint) return;
    this.#routeListFingerprint = fingerprint;
    const document_ = list.ownerDocument;
    const rows = summaries.map((summary) => {
      const item = document_.createElement("li");
      const button = document_.createElement("button");
      button.type = "button";
      button.className = `n-flow-route-row np${summary.slot}`;
      button.dataset.flowChain = summary.chainId;
      button.dataset.flowSlot = String(summary.slot);
      button.dataset.flowPattern = String(((summary.slot - 1) % 16 + 16) % 16 + 1);
      button.style.setProperty("--n-flow-color", `var(--pcs${summary.slot})`);
      button.textContent = summary.description;
      button.title = `${summary.description} · ${summary.routeCount} ${
        summary.routeCount === 1 ? "connection" : "connections"
      }`;
      item.append(button);
      return item;
    });
    list.replaceChildren(...rows);
  }

  #syncTrace(relatedChains: ReadonlySet<string>): string {
    const output = this.#traceOutput;
    if (!output) return "";
    const inspection = this.#activeInspection();
    const summaries = this.#relationSummaries().filter((summary) =>
      relatedChains.has(summary.chainId)
    );
    if (!inspection || summaries.length === 0) {
      output.hidden = true;
      output.textContent = "";
      output.title = "";
      return "";
    }
    const subject = inspection.chainId && summaries.length === 1
      ? summaries[0].description
      : inspection.key
      ? (() => {
          const route = this.#routes.find((candidate) =>
            candidate.source.kind === "key" && candidate.source.key === inspection.key &&
            (!inspection.sourceId || candidate.source.sourceId === inspection.sourceId)
          );
          return `${route?.source.kind === "key" ? this.#sourceLabel(route.source) : "Keyboard"} · ${inspection.key}`;
        })()
      : inspection.functionName
      ? (() => {
          const endpoint = this.#routes.find((route) =>
            route.target.kind === "control" &&
            route.target.slot === inspection.slot &&
            sameControlDirection(route.target.functionName, inspection.functionName ?? "")
          );
          return `P${inspection.slot ?? this.#selectedSlot} ${
            endpoint?.target.kind === "control"
              ? endpoint.target.label
              : inspection.functionName
          }`;
        })()
      : inspection.macroId
      ? summaries[0]?.description ?? "macro route"
      : `${summaries.length} related routes`;
    const text = inspection.chainId && summaries.length === 1
      ? `Tracing ${subject}`
      : `Tracing ${subject} · ${summaries.length} ${summaries.length === 1 ? "route" : "routes"}`;
    output.hidden = false;
    output.textContent = text;
    output.title = summaries.map((summary) => summary.description).join("\n");
    return text;
  }

  scheduleLayout(): void {
    if (this.#mode === "off" || this.#layoutFrame !== 0) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = 0;
      // A direct cord already shares the stage's transform. While the camera
      // moves, keep only fixed-screen processors and their short macro links
      // attached; recompute the independent direct curves once motion stops.
      if (this.#cameraMotionActive()) this.#layoutCameraFrame();
      else this.#layout();
    });
  }

  #cameraMotionActive(): boolean {
    return this.#viewport.classList.contains("is-camera-animating") ||
      this.#cameraPanActive();
  }

  #cameraPanActive(): boolean {
    return this.#viewport.classList.contains("is-panning") ||
      this.#viewport.classList.contains("is-navigating");
  }

  setLive(
    keysDown: ReadonlySet<string>,
    keyHits: ReadonlySet<string>,
    slotFunctionsDown: ReadonlyMap<number, ReadonlySet<string>>,
    slotFunctionHits: ReadonlyMap<number, ReadonlySet<string>>,
  ): void {
    this.#liveKeysDown = Array.from(keysDown, parseMappingLiveKeyToken);
    this.#liveKeyHits = Array.from(keyHits, parseMappingLiveKeyToken);
    this.#liveSlotFunctionsDown = slotFunctionsDown;
    this.#liveSlotFunctionHits = slotFunctionHits;
    this.#applyLive();
  }

  #applyLive(): void {
    // Source resolution queries the physical DOM. Resolve each distinct route
    // and live identity once per paint instead of once per route x live key at
    // the stream's 60 Hz cadence.
    const roots = mappingSourceRoots(this.#root);
    const routeRoots = new Map<string, HTMLElement | null>();
    const liveRoots = new Map<MappingLiveKeyIdentity, HTMLElement | null>();
    const routeRoot = (source: KeyFlowEndpoint): HTMLElement | null => {
      const id = `${source.sourceId}\u0000${source.sourceAlias}`;
      if (!routeRoots.has(id)) {
        routeRoots.set(id, resolveMappingSourceRoot(roots, source));
      }
      return routeRoots.get(id) ?? null;
    };
    const liveRoot = (identity: MappingLiveKeyIdentity): HTMLElement | null => {
      if (!liveRoots.has(identity)) {
        liveRoots.set(identity, resolveMappingLiveSourceRoot(roots, identity));
      }
      return liveRoots.get(identity) ?? null;
    };
    const liveKeyMatches = (
      source: KeyFlowEndpoint,
      identity: MappingLiveKeyIdentity,
    ): boolean => {
      const root = routeRoot(source);
      return Boolean(identity.key) && identity.key === source.key &&
        root !== null && root === liveRoot(identity);
    };
    for (const entry of this.#entries.values()) {
      // Runtime frames carry aggregate controller state, not macro execution
      // provenance. Only a direct relation can truthfully light from these two
      // facts; macro segments stay static until the backend reports a running
      // macro/step identity.
      const live = entry.route.kind === "binding" &&
        (
          this.#liveKeysDown.some((identity) =>
            liveKeyMatches(entry.route.source, identity)
          ) &&
            (this.#liveSlotFunctionsDown.get(entry.route.target.slot)?.has(entry.route.target.functionName) ?? false) ||
          this.#liveKeyHits.some((identity) =>
            liveKeyMatches(entry.route.source, identity)
          ) &&
            (this.#liveSlotFunctionHits.get(entry.route.target.slot)?.has(entry.route.target.functionName) ?? false)
        );
      entry.lineGroup.classList.toggle("is-live", live);
      entry.portGroup.classList.toggle("is-live", live);
    }
    this.#syncPaintOrder();
  }

  #syncPaintOrder(): void {
    const promote = (entry: MappingFlowEntry): void => {
      this.#lines.append(entry.lineGroup);
      this.#ports.append(entry.portGroup);
    };
    // SVG sibling order is its z-order. Rebuild the three paint bands every
    // time live or inspection state changes so hover can never cover a cable
    // that is carrying an input: resting, then related, then live.
    for (const entry of this.#entries.values()) {
      if (!entry.lineGroup.classList.contains("is-related") &&
          !entry.lineGroup.classList.contains("is-live")) promote(entry);
    }
    for (const entry of this.#entries.values()) {
      if (entry.lineGroup.classList.contains("is-related") &&
          !entry.lineGroup.classList.contains("is-live")) promote(entry);
    }
    for (const entry of this.#entries.values()) {
      if (entry.lineGroup.classList.contains("is-live")) promote(entry);
    }
  }

  dispose(): void {
    this.#cancelProcessorDrag?.();
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
    this.#restoreProcessorFocusTarget = "editor";
    this.#restoreOverflowSummaryFocus = false;
    this.#restoreOverflowOpen = false;
    this.#lines.replaceChildren();
    this.#ports.replaceChildren();
    this.#nodes.replaceChildren();
    this.#routeList?.replaceChildren();
    this.#routeListFingerprint = "";
    if (this.#traceOutput) {
      this.#traceOutput.hidden = true;
      this.#traceOutput.textContent = "";
      this.#traceOutput.title = "";
    }
  }

  #rebuild(): void {
    this.#captureProcessorFocus();
    this.#cancelProcessorDrag?.();
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
      const savedPlacement = this.#savedProcessorPlacement(processor.id);
      const shell = document_.createElement("div");
      shell.className = "n-flow-processor-shell";
      const element = document_.createElement("a");
      element.addEventListener("pointerdown", (event) => {
        if (event.button === 0) event.stopPropagation();
      }, {
        signal: this.#abort.signal,
      });
      const moveGrip = document_.createElement("button");
      moveGrip.type = "button";
      moveGrip.className = "n-flow-processor-grip";
      moveGrip.textContent = "Move";
      const autoButton = document_.createElement("button");
      autoButton.type = "button";
      autoButton.className = "n-flow-processor-auto";
      autoButton.textContent = "Auto";
      const nudgeToggle = document_.createElement("button");
      nudgeToggle.type = "button";
      nudgeToggle.className = "n-flow-processor-nudge-toggle";
      nudgeToggle.textContent = "Nudge";
      const nudgeMenu = document_.createElement("div");
      nudgeMenu.className = "n-flow-processor-nudges";
      nudgeMenu.id = `n-flow-nudges-${routePart(processor.id)}`;
      nudgeMenu.setAttribute("role", "group");
      nudgeMenu.setAttribute(
        "aria-label",
        `Move ${processor.name} for Player ${processor.slot}`,
      );
      nudgeMenu.hidden = openProcessorNudgeId !== processor.id;
      for (const [label, title, direction, dx, dy] of [
        ["←", "Move left", "left", -16, 0],
        ["↑", "Move up", "up", 0, -16],
        ["↓", "Move down", "down", 0, 16],
        ["→", "Move right", "right", 16, 0],
      ] as const) {
        const button = document_.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", `${title} ${processor.name}`);
        button.dataset.flowNudgeDirection = direction;
        button.dataset.flowDx = String(dx);
        button.dataset.flowDy = String(dy);
        nudgeMenu.append(button);
      }
      nudgeToggle.setAttribute("aria-controls", nudgeMenu.id);
      nudgeToggle.setAttribute("aria-expanded", String(!nudgeMenu.hidden));
      const entry: MacroProcessorEntry = {
        processor,
        shell,
        element,
        moveGrip,
        autoButton,
        nudgeToggle,
        nudgeMenu,
        sourceElements: [],
        targetElements: [],
        padElement: null,
        automaticPosition: null,
        renderedPosition: null,
        manualOffset: savedPlacement.offset,
        previewOffset: null,
        savePending: savedPlacement.savePending,
        resetPending: savedPlacement.resetPending,
      };
      this.#syncProcessorElement(entry);
      this.#syncProcessorPlacementChrome(entry);
      this.#bindProcessorControls(entry);
      shell.append(element, moveGrip, autoButton, nudgeToggle, nudgeMenu);
      this.#nodes.append(shell);
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
        halo,
        path,
        portGroup,
        sourcePort,
        targetPort,
        sourceElement: null,
        targetElement: null,
        laneIndex: 0,
      });
    }
    this.#applyLive();
  }

  #savedProcessorPlacement(processorId: string): {
    offset: MappingFlowProcessorOffset | null;
    savePending: boolean;
    resetPending: boolean;
  } {
    try {
      const saved = this.#getProcessorOffset(processorId);
      const offset = finiteProcessorOffset(saved);
      return {
        offset,
        savePending: offset !== null && this.#processorOffsetIsSessionOnly(processorId),
        // A host can return null (distinct from absent/undefined) when Auto is
        // active for this document but clearing an older stored offset failed.
        resetPending: saved === null,
      };
    } catch {
      return { offset: null, savePending: false, resetPending: false };
    }
  }

  #syncProcessorPlacementChrome(entry: MacroProcessorEntry): void {
    const manual = entry.previewOffset !== null || entry.manualOffset !== null;
    const retryReset = !manual && entry.resetPending;
    const state = manual ? "manual" : "auto";
    entry.shell.dataset.flowPlacement = state;
    entry.element.dataset.flowPlacement = state;
    entry.moveGrip.dataset.flowPlacement = state;
    entry.autoButton.dataset.flowPlacement = state;
    entry.shell.dataset.flowSaveState = retryReset
      ? "retry-reset"
      : entry.savePending
        ? "session-only"
        : "saved";
    entry.autoButton.hidden = !manual && !retryReset;
    entry.autoButton.disabled = !manual && !retryReset;
    entry.autoButton.textContent = retryReset ? "Retry Auto" : "Auto";
    let moveDescription = "Auto placement. Moving this processor pins it.";
    if (retryReset) {
      moveDescription =
        "Auto is active for this session, but its reset is not saved. Choose Retry Auto to try again.";
    } else if (entry.savePending) {
      moveDescription =
        "This manual position is session only. Move or nudge again to retry saving it.";
    } else if (manual) {
      moveDescription = "Manual position. Home or Delete returns to Auto.";
    }
    entry.moveGrip.setAttribute("aria-description", moveDescription);
    entry.autoButton.setAttribute(
      "aria-label",
      retryReset
        ? `Retry saving automatic placement for ${entry.processor.name}, Player ${entry.processor.slot}`
        : `Return ${entry.processor.name} for Player ${entry.processor.slot} to automatic placement`,
    );
    entry.autoButton.title = retryReset
      ? "Retry saving automatic placement"
      : "Return this macro to automatic placement";
  }

  #movementBaseOffset(entry: MacroProcessorEntry): MappingFlowProcessorOffset {
    if (entry.automaticPosition && entry.renderedPosition) {
      // Placement can clamp against the viewport, a widget, or the navigator.
      // Always continue from the visible position rather than a hidden raw
      // request, otherwise a card at an edge appears stuck until the input
      // catches up with the off-screen offset.
      return {
        x: Math.round((entry.renderedPosition.x - entry.automaticPosition.x) * 100) / 100,
        y: Math.round((entry.renderedPosition.y - entry.automaticPosition.y) * 100) / 100,
      };
    }
    const explicit = entry.previewOffset ?? entry.manualOffset;
    if (explicit) return { ...explicit };
    return { x: 0, y: 0 };
  }

  #settleProcessorOffset(
    entry: MacroProcessorEntry,
    requested: MappingFlowProcessorOffset,
  ): MappingFlowProcessorOffset | null {
    const previous = {
      manualOffset: entry.manualOffset ? { ...entry.manualOffset } : null,
      savePending: entry.savePending,
      resetPending: entry.resetPending,
    };
    entry.previewOffset = null;
    entry.manualOffset = { ...requested };
    entry.resetPending = false;
    this.#syncProcessorPlacementChrome(entry);
    // Resolve avoidance/clamping before persistence. The saved value must be
    // the position the user can actually see, not an unreachable request.
    this.#layout();
    if (entry.shell.hidden || !entry.renderedPosition) {
      entry.manualOffset = previous.manualOffset;
      entry.savePending = previous.savePending;
      entry.resetPending = previous.resetPending;
      this.#syncProcessorPlacementChrome(entry);
      this.#layout();
      this.scheduleLayout();
      this.#announce(`${entry.processor.name} stayed at its previous reachable position.`);
      return null;
    }
    const effective = this.#movementBaseOffset(entry);
    entry.manualOffset = { ...effective };
    this.#syncProcessorPlacementChrome(entry);
    this.scheduleLayout();
    return effective;
  }

  #emitProcessorOffset(
    entry: MacroProcessorEntry,
    offset: MappingFlowProcessorOffset | null,
  ): boolean {
    try {
      const saved = this.#onProcessorOffsetCommit(
        entry.processor.id,
        offset ? { ...offset } : null,
      );
      if (saved) {
        if (offset) {
          entry.savePending = false;
          this.#syncProcessorPlacementChrome(entry);
        }
        return true;
      }
    } catch {
      // The same truthful session-only announcement covers storage callbacks
      // that either refuse explicitly or throw.
    }
    if (offset) {
      entry.savePending = true;
      this.#syncProcessorPlacementChrome(entry);
    }
    this.#announce(
      offset
        ? `${entry.processor.name} moved for this session, but its canvas position could not be saved.`
        : `${entry.processor.name} returned to automatic placement for this session, but that reset could not be saved.`,
    );
    return false;
  }

  #resetProcessorOffset(entry: MacroProcessorEntry, focusGrip: boolean): void {
    const wasManual = entry.previewOffset !== null || entry.manualOffset !== null;
    const shouldPersist = wasManual || entry.resetPending;
    entry.previewOffset = null;
    entry.manualOffset = null;
    entry.savePending = false;
    entry.resetPending = false;
    this.#syncProcessorPlacementChrome(entry);
    this.scheduleLayout();
    if (shouldPersist) {
      if (this.#emitProcessorOffset(entry, null)) {
        this.#announce(
          `${entry.processor.name} returned to automatic placement.`,
        );
      } else {
        entry.resetPending = true;
        this.#syncProcessorPlacementChrome(entry);
      }
    } else {
      this.#announce(`${entry.processor.name} is already using automatic placement.`);
    }
    if (focusGrip) {
      if (entry.resetPending) entry.autoButton.focus();
      else entry.moveGrip.focus();
    }
  }

  #nudgeProcessor(
    entry: MacroProcessorEntry,
    deltaX: number,
    deltaY: number,
  ): void {
    const base = this.#movementBaseOffset(entry);
    const offset = {
      x: Math.round((base.x + deltaX) * 100) / 100,
      y: Math.round((base.y + deltaY) * 100) / 100,
    };
    const effective = this.#settleProcessorOffset(entry, offset);
    if (!effective) return;
    if (this.#emitProcessorOffset(entry, effective)) {
      this.#announce(`${entry.processor.name} moved and pinned.`);
    }
  }

  #positionProcessorNudgeMenu(
    entry: MacroProcessorEntry,
    viewport = this.#viewport.getBoundingClientRect(),
  ): void {
    if (entry.nudgeMenu.hidden || entry.shell.hidden) return;
    const shell = entry.shell.getBoundingClientRect();
    const menu = entry.nudgeMenu.getBoundingClientRect();
    if (menu.width <= 0 || viewport.width <= 0) return;
    const gap = 3;
    const margin = 8;
    const roomRight = viewport.right - margin - shell.right - gap;
    const roomLeft = shell.left - gap - (viewport.left + margin);
    const placeRight = roomRight >= menu.width ||
      (roomLeft < menu.width && roomRight >= roomLeft);
    const naturalLeft = placeRight
      ? shell.right + gap
      : shell.left - gap - menu.width;
    const minimumLeft = viewport.left + margin;
    const maximumLeft = Math.max(minimumLeft, viewport.right - margin - menu.width);
    const clampedLeft = Math.min(maximumLeft, Math.max(minimumLeft, naturalLeft));
    // Processor cards keep a fixed screen size while their parent layer
    // follows the camera, so this screen delta is also the menu's local CSS
    // offset. Recompute it after every layout and disclosure rather than
    // persisting a side that can become wrong after pan, zoom, or resize.
    entry.nudgeMenu.style.left = `${(clampedLeft - shell.left).toFixed(2)}px`;
    entry.nudgeMenu.dataset.flowNudgeSide = placeRight ? "right" : "left";
  }

  #bindProcessorControls(entry: MacroProcessorEntry): void {
    const { shell, moveGrip, autoButton, nudgeToggle, nudgeMenu } = entry;
    const signal = this.#abort.signal;
    const setNudgeMenuOpen = (open: boolean, announce = true): void => {
      if (open) {
        for (const candidate of this.#processorEntries.values()) {
          if (candidate === entry) continue;
          candidate.nudgeMenu.hidden = true;
          candidate.nudgeToggle.setAttribute("aria-expanded", "false");
        }
      }
      nudgeMenu.hidden = !open;
      openProcessorNudgeId = open ? entry.processor.id : "";
      nudgeToggle.setAttribute("aria-expanded", String(open));
      if (open) this.#positionProcessorNudgeMenu(entry);
      if (open && announce) {
        this.#announce(`Movement controls shown for ${entry.processor.name}.`);
      }
    };
    const toggleNudgeMenu = (): void => setNudgeMenuOpen(nudgeMenu.hidden);
    nudgeToggle.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.stopPropagation();
    }, { signal });
    nudgeToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleNudgeMenu();
    }, { signal });
    moveGrip.addEventListener("keydown", (event) => {
      if (event.key === "Home" || event.key === "Delete") {
        event.preventDefault();
        event.stopPropagation();
        this.#resetProcessorOffset(entry, true);
        return;
      }
      const amount = event.shiftKey ? 64 : 16;
      const delta = event.key === "ArrowLeft"
        ? { x: -amount, y: 0 }
        : event.key === "ArrowRight"
          ? { x: amount, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -amount }
            : event.key === "ArrowDown"
              ? { x: 0, y: amount }
              : null;
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      this.#nudgeProcessor(entry, delta.x, delta.y);
    }, { signal });
    autoButton.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.stopPropagation();
    }, { signal });
    autoButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#resetProcessorOffset(entry, true);
    }, { signal });
    for (const button of Array.from(nudgeMenu.querySelectorAll<HTMLButtonElement>("button"))) {
      button.addEventListener("pointerdown", (event) => {
        if (event.button === 0) event.stopPropagation();
      }, { signal });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#nudgeProcessor(
          entry,
          Number(button.dataset.flowDx ?? "0"),
          Number(button.dataset.flowDy ?? "0"),
        );
      }, { signal });
    }

    moveGrip.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        (event.pointerType !== "" && !event.isPrimary) ||
        this.#processorDragPointerId !== null ||
        shell.hidden ||
        this.#viewport.classList.contains("is-pan-ready") ||
        this.#viewport.classList.contains("is-panning") ||
        this.#viewport.classList.contains("is-navigating") ||
        this.#viewport.classList.contains("is-camera-animating")
      ) return;
      const matrix = this.#lines.getScreenCTM();
      if (!matrix || !entry.automaticPosition || !entry.renderedPosition) return;
      event.preventDefault();
      event.stopPropagation();
      moveGrip.focus();

      const pointerId = event.pointerId;
      const inverse = matrix.inverse();
      const startWorld = this.#worldPoint({ x: event.clientX, y: event.clientY }, inverse);
      const startingOffset = this.#movementBaseOffset(entry);
      const originalManualOffset = entry.manualOffset ? { ...entry.manualOffset } : null;
      const originalSavePending = entry.savePending;
      const originalResetPending = entry.resetPending;
      let nextOffset = { ...startingOffset };
      let moved = false;
      let ended = false;
      let usesWindowFallback = false;
      let moveFrame = 0;
      this.#processorDragPointerId = pointerId;

      const preview = (): void => {
        moveFrame = 0;
        if (!moved) return;
        entry.previewOffset = { ...nextOffset };
        this.#syncProcessorPlacementChrome(entry);
        this.scheduleLayout();
      };
      const updateOffset = (moveEvent: PointerEvent): void => {
        const world = this.#worldPoint(
          { x: moveEvent.clientX, y: moveEvent.clientY },
          inverse,
        );
        nextOffset = {
          x: Math.round((startingOffset.x + world.x - startWorld.x) * 100) / 100,
          y: Math.round((startingOffset.y + world.y - startWorld.y) * 100) / 100,
        };
      };
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        moveEvent.stopPropagation();
        const deltaX = moveEvent.clientX - event.clientX;
        const deltaY = moveEvent.clientY - event.clientY;
        if (!moved && Math.hypot(deltaX, deltaY) <= 5) return;
        if (!moved) {
          moved = true;
          shell.classList.add("is-dragging");
          this.#viewport.classList.add("is-dragging-flow-processor");
        }
        updateOffset(moveEvent);
        if (!moveFrame) moveFrame = requestAnimationFrame(preview);
      };
      const finish = (endEvent: PointerEvent | null): void => {
        if ((endEvent && endEvent.pointerId !== pointerId) || ended) return;
        ended = true;
        this.#cancelProcessorDrag = null;
        if (moved && endEvent?.type === "pointerup") updateOffset(endEvent);
        if (moveFrame) cancelAnimationFrame(moveFrame);
        moveGrip.removeEventListener("pointermove", onMove);
        moveGrip.removeEventListener("pointerup", onEnd);
        moveGrip.removeEventListener("pointercancel", onEnd);
        moveGrip.removeEventListener("lostpointercapture", onEnd);
        const window_ = this.#root.ownerDocument.defaultView;
        if (usesWindowFallback && window_) {
          window_.removeEventListener("pointermove", onMove);
          window_.removeEventListener("pointerup", onEnd);
          window_.removeEventListener("pointercancel", onEnd);
        }
        if (moveGrip.hasPointerCapture(pointerId)) moveGrip.releasePointerCapture(pointerId);
        shell.classList.remove("is-dragging");
        this.#viewport.classList.remove("is-dragging-flow-processor");
        if (this.#processorDragPointerId === pointerId) this.#processorDragPointerId = null;

        if (moved && endEvent?.type === "pointerup") {
          const effective = this.#settleProcessorOffset(entry, nextOffset);
          if (!effective) return;
          if (this.#emitProcessorOffset(entry, effective)) {
            this.#announce(`${entry.processor.name} moved and pinned.`);
          }
          return;
        }
        entry.previewOffset = null;
        entry.manualOffset = originalManualOffset;
        entry.savePending = originalSavePending;
        entry.resetPending = originalResetPending;
        this.#syncProcessorPlacementChrome(entry);
        if (moved) this.scheduleLayout();
      };
      const onEnd = (endEvent: PointerEvent): void => finish(endEvent);
      this.#cancelProcessorDrag = () => finish(null);
      try {
        moveGrip.setPointerCapture(pointerId);
        moveGrip.addEventListener("pointermove", onMove);
        moveGrip.addEventListener("pointerup", onEnd);
        moveGrip.addEventListener("pointercancel", onEnd);
        moveGrip.addEventListener("lostpointercapture", onEnd);
      } catch {
        const window_ = this.#root.ownerDocument.defaultView;
        if (!window_) {
          finish(null);
          return;
        }
        usesWindowFallback = true;
        window_.addEventListener("pointermove", onMove);
        window_.addEventListener("pointerup", onEnd);
        window_.addEventListener("pointercancel", onEnd);
      }
    }, { signal });
  }

  #syncProcessorElement(entry: MacroProcessorEntry): void {
    const { processor, shell, element, moveGrip, autoButton, nudgeToggle } = entry;
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
    const pattern = String(((processor.slot - 1) % 16 + 16) % 16 + 1);
    element.dataset.flowPattern = pattern;
    element.style.setProperty("--n-flow-color", `var(--pcs${processor.slot})`);
    shell.dataset.flowMacroId = processor.id;
    shell.dataset.flowSlot = String(processor.slot);
    shell.dataset.flowPattern = pattern;
    shell.style.setProperty("--n-flow-color", `var(--pcs${processor.slot})`);
    moveGrip.dataset.flowMacroId = processor.id;
    moveGrip.dataset.flowSlot = String(processor.slot);
    moveGrip.setAttribute(
      "aria-label",
      `Move ${processor.name} for Player ${processor.slot}. Drag, or use Arrow keys; Shift plus Arrow moves farther. Moving pins the processor.`,
    );
    moveGrip.setAttribute(
      "aria-keyshortcuts",
      "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Home Delete",
    );
    moveGrip.title =
      "Move macro · Arrow keys 16 · Shift+Arrow 64 · Home or Delete returns to Auto";
    autoButton.dataset.flowMacroId = processor.id;
    autoButton.dataset.flowSlot = String(processor.slot);
    nudgeToggle.dataset.flowMacroId = processor.id;
    nudgeToggle.dataset.flowSlot = String(processor.slot);
    nudgeToggle.setAttribute(
      "aria-label",
      `Show click or tap movement controls for ${processor.name}, Player ${processor.slot}`,
    );
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
    const directEntry = this.#processorEntries.get(macroId);
    if (directEntry && !directEntry.shell.hidden && !directEntry.element.hidden) {
      const direct = this.#restoreProcessorFocusTarget === "move"
        ? directEntry.moveGrip
        : this.#restoreProcessorFocusTarget === "auto" && !directEntry.autoButton.hidden
          ? directEntry.autoButton
          : this.#restoreProcessorFocusTarget === "nudge"
            ? directEntry.nudgeToggle
            : this.#restoreProcessorFocusTarget.startsWith("nudge-")
              ? directEntry.nudgeMenu.querySelector<HTMLButtonElement>(
                `[data-flow-nudge-direction="${
                  CSS.escape(this.#restoreProcessorFocusTarget.slice("nudge-".length))
                }"]`,
              ) ?? directEntry.nudgeToggle
              : directEntry.element;
      this.#restoreProcessorFocusId = null;
      this.#restoreProcessorFocusTarget = "editor";
      direct.focus();
      return;
    }
    const grouped = overflow?.querySelector<HTMLAnchorElement>(
      `a.n-flow-overflow-link[data-flow-macro-id="${escaped}"]`,
    );
    if (!overflow || !grouped) {
      this.#restoreProcessorFocusId = null;
      this.#restoreProcessorFocusTarget = "editor";
      return;
    }
    this.#restoreProcessorFocusId = null;
    this.#restoreProcessorFocusTarget = "editor";
    overflow.open = true;
    grouped.focus();
  }

  #captureProcessorFocus(): void {
    const active = this.#root.ownerDocument.activeElement;
    if (!(active instanceof Element) || !this.#nodes.contains(active)) return;
    const focusedProcessor = active.closest<HTMLElement>("[data-flow-macro-id]");
    if (focusedProcessor?.dataset.flowMacroId) {
      this.#restoreProcessorFocusId = focusedProcessor.dataset.flowMacroId;
      this.#restoreProcessorFocusTarget = active.classList.contains("n-flow-processor-grip")
        ? "move"
        : active.classList.contains("n-flow-processor-auto")
          ? "auto"
          : active.classList.contains("n-flow-processor-nudge-toggle")
            ? "nudge"
            : active instanceof HTMLElement && active.dataset.flowNudgeDirection
              ? `nudge-${active.dataset.flowNudgeDirection}` as MacroProcessorFocusTarget
              : "editor";
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
    if (route.source.kind === "key") {
      group.dataset.flowKey = route.source.key;
      if (route.source.sourceId) group.dataset.flowSourceId = route.source.sourceId;
      else delete group.dataset.flowSourceId;
      if (route.source.sourceAlias) group.dataset.flowSourceAlias = route.source.sourceAlias;
      else delete group.dataset.flowSourceAlias;
    } else {
      delete group.dataset.flowKey;
      delete group.dataset.flowSourceId;
      delete group.dataset.flowSourceAlias;
    }
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
      for (const entry of this.#entries.values()) {
        delete entry.lineGroup.dataset.flowLaneIndex;
      }
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
    const observedAnchors = new Set<Element>();
    const anchors: MappingAnchorCache = {
      keys: new Map(),
      controls: new Map(),
      pads: new Map(),
    };
    // Endpoint boxes are measured BEFORE the cards are placed, because where a
    // card may go depends on where its lens's own endpoints are. `#resolveEndpoint`
    // fills the shared anchor cache, so the resolution loop below re-uses these
    // lookups rather than repeating them.
    const endpoints = this.#liveEndpointRects(anchors);
    this.#layoutProcessors(matrix, inverse, scale, observedAnchors, anchors, true, endpoints);
    const directLanes = new Map<number, number>();
    const macroLanes = new Map<number, number>();
    const directTotals = new Map<number, number>();
    for (const entry of this.#entries.values()) {
      if (entry.route.kind !== "binding") continue;
      directTotals.set(entry.route.slot, (directTotals.get(entry.route.slot) ?? 0) + 1);
    }
    for (const entry of this.#entries.values()) {
      const sourceElement = this.#resolveEndpoint(entry.route.source, entry.route.slot, anchors);
      const targetElement = this.#resolveEndpoint(entry.route.target, entry.route.slot, anchors);
      entry.sourceElement = sourceElement;
      entry.targetElement = targetElement;
      const visible = sourceElement !== null && targetElement !== null;
      const sourceAuthority = entry.route.source.kind === "key"
        ? sourceElement?.getAttribute("data-flow-authority")?.trim() ?? ""
        : "";
      for (const group of [entry.lineGroup, entry.portGroup]) {
        if (sourceAuthority) group.dataset.flowSourceAuthority = sourceAuthority;
        else delete group.dataset.flowSourceAuthority;
      }
      entry.lineGroup.classList.toggle("is-unresolved", !visible);
      entry.portGroup.classList.toggle("is-unresolved", !visible);
      if (!visible) {
        delete entry.lineGroup.dataset.flowLaneIndex;
        continue;
      }

      // Every logical relationship owns one complete curve. Direct bindings
      // receive a unique offset within a bounded 72px fan, so even eight or
      // more aliases resolving to the same visible hook cannot overlap. Macro
      // segments retain their newer five-lane tangent treatment.
      const direct = entry.route.kind === "binding";
      const lanes = direct ? directLanes : macroLanes;
      const laneIndex = lanes.get(entry.route.slot) ?? 0;
      entry.laneIndex = laneIndex;
      // Unlike measured coordinates, this routing decision is stable while a
      // live endpoint follows its hover/focus geometry.
      entry.lineGroup.dataset.flowLaneIndex = String(laneIndex);
      const lane = direct
        ? (() => {
          const total = directTotals.get(entry.route.slot) ?? 1;
          const gap = total > 1 ? Math.min(4, 72 / (total - 1)) : 0;
          return (laneIndex - (total - 1) / 2) * (gap / scale);
        })()
        : ((laneIndex % 5) - 2) * (4 / scale);
      this.#positionEntry(entry, inverse, scale, lane);
      lanes.set(entry.route.slot, laneIndex + 1);
      resolved += 1;
      if (entry.route.kind === "binding") resolvedDirect += 1;
      else resolvedMacroConnections += 1;
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
    if (this.#cameraMotionActive()) {
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
    const sourceCenter = elementCenter(entry.sourceElement);
    const targetCenter = elementCenter(entry.targetElement);
    const targetScreen = entry.route.target.kind === "control"
      ? elementPerimeterPoint(entry.targetElement, sourceCenter)
      : targetCenter;
    const source = this.#worldPoint(
      entry.route.source.kind === "key"
        ? elementPerimeterPoint(entry.sourceElement, targetScreen)
        : sourceCenter,
      inverse,
    );
    const target = this.#worldPoint(targetScreen, inverse);
    const pathValue = entry.route.kind === "binding"
      ? mappingLassoCurve(source, target, lane)
      : mappingCurve(source, target, lane);
    this.#paintEntry(entry, pathValue, source, target, scale);
  }

  #paintEntry(
    entry: MappingFlowEntry,
    pathValue: string,
    source: { x: number; y: number },
    target: { x: number; y: number },
    scale: number,
  ): void {
    entry.path.setAttribute("d", pathValue);
    entry.halo.setAttribute("d", pathValue);
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
    // No endpoint set during an interpolated camera: every key and hook is
    // moving this frame, so measuring them all would cost the whole saving this
    // path exists for — and a measurement one frame stale is worse than none.
    // Cards keep the previous rung's answer while the camera flies and take
    // their endpoint-aware lane in the full layout that follows the last frame.
    this.#layoutProcessors(matrix, inverse, scale, new Set(), null, false, null);
    for (const entry of this.#entries.values()) {
      if (entry.route.kind === "binding") continue;
      this.#positionEntry(
        entry,
        inverse,
        scale,
        ((entry.laneIndex % 5) - 2) * (4 / scale),
      );
    }
    if (this.#cameraMotionActive()) {
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

  #worldPoint(screen: { x: number; y: number }, inverse: DOMMatrix): DOMPoint {
    const point = this.#lines.createSVGPoint();
    point.x = screen.x;
    point.y = screen.y;
    return point.matrixTransform(inverse);
  }

  #worldCenter(element: Element, inverse: DOMMatrix): DOMPoint {
    return this.#worldPoint(elementCenter(element), inverse);
  }

  /** Every element the lens is currently drawing a cord to or from, measured
   *  in screen space.
   *
   *  These are the boxes a processor card must never cover: a key you hover to
   *  light its routes, a control hook you hover to see what drives it. A macro
   *  endpoint is deliberately absent — that is a processor CARD, and cards
   *  already keep each other at arm's length through `placedProcessors`, so
   *  including them here would only make a card an obstacle to itself.
   *
   *  A pad used as a whole-widget fallback anchor is absent for the opposite
   *  reason: it is the size of the widget, and treating it as an endpoint would
   *  re-import exactly the "widgets are absolute" rule whose collapse this
   *  set exists to replace. */
  #liveEndpointRects(anchors: MappingAnchorCache): DOMRect[] {
    const measured = new Set<Element>();
    const rects: DOMRect[] = [];
    const add = (element: Element | null): void => {
      if (!element || measured.has(element)) return;
      measured.add(element);
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    };
    for (const entry of this.#entries.values()) {
      for (const endpoint of [entry.route.source, entry.route.target]) {
        if (endpoint.kind !== "key" && endpoint.kind !== "control") continue;
        add(this.#resolveEndpoint(endpoint, entry.route.slot, anchors));
      }
    }
    return rects;
  }

  #layoutProcessors(
    matrix: DOMMatrix,
    inverse: DOMMatrix,
    scale: number,
    observedAnchors: Set<Element>,
    anchors: MappingAnchorCache | null,
    refreshAnchors: boolean,
    endpoints: readonly DOMRect[] | null,
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
      const { processor, shell, element } = entry;
      if (processorIndex >= visibleProcessorLimit) {
        shell.hidden = true;
        element.hidden = true;
        entry.automaticPosition = null;
        entry.renderedPosition = null;
        overflowProcessors.push(processor);
        processorIndex += 1;
        continue;
      }
      processorIndex += 1;
      shell.hidden = false;
      element.hidden = false;
      if (refreshAnchors && anchors) {
        entry.sourceElements = processor.triggers
          .map((key) => this.#resolveKeyCached(anchors, {
            kind: "key",
            id: `key:${routePart(processor.sourceId || processor.sourceAlias)}:${routePart(key)}`,
            key,
            sourceId: processor.sourceId,
            sourceAlias: processor.sourceAlias,
          }, processor.slot))
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
        shell.hidden = true;
        element.hidden = true;
        entry.automaticPosition = null;
        entry.renderedPosition = null;
        overflowProcessors.push(processor);
        continue;
      }
      const slotPeers = peers.get(processor.slot) ?? [processor];
      const peerIndex = Math.max(0, slotPeers.findIndex((item) => item.id === processor.id));
      const fan = (peerIndex - (slotPeers.length - 1) / 2) * (194 / scale);
      const vertical = Math.abs(target.y - source.y) >= Math.abs(target.x - source.x);
      shell.style.setProperty("--n-flow-node-inverse", (1 / scale).toFixed(5));
      const automaticPosition = {
        x: source.x + (target.x - source.x) * 0.52 + (vertical ? fan : 0),
        y: source.y + (target.y - source.y) * 0.52 + (vertical ? 0 : fan),
      };
      entry.automaticPosition = automaticPosition;
      const placed = entry.previewOffset ?? entry.manualOffset;
      const offset = placed ?? { x: 0, y: 0 };
      const position = this.#processorPositionAvoidingOverlays(
        shell,
        {
          x: automaticPosition.x + offset.x,
          y: automaticPosition.y + offset.y,
        },
        matrix,
        inverse,
        placedProcessors,
        widgetObstacles,
        navigator,
        viewport,
        placed ? "manual" : "auto",
        endpoints,
      );
      if (!position) {
        shell.hidden = true;
        element.hidden = true;
        entry.renderedPosition = null;
        overflowProcessors.push(processor);
        continue;
      }
      shell.style.left = `${position.x.toFixed(2)}px`;
      shell.style.top = `${position.y.toFixed(2)}px`;
      entry.renderedPosition = { x: position.x, y: position.y };
      this.#syncProcessorPlacementChrome(entry);
      if (!entry.nudgeMenu.hidden) this.#positionProcessorNudgeMenu(entry, viewport);
      const screenPosition = position.matrixTransform(matrix);
      placedProcessors.push(new DOMRect(
        screenPosition.x - shell.offsetWidth / 2,
        screenPosition.y - shell.offsetHeight / 2,
        shell.offsetWidth,
        shell.offsetHeight,
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
      "auto",
      endpoints,
    );
    // If the chrome and visible cards leave no honest lane for the bank,
    // fold the last visible card into it and retry. With zero visible cards
    // the placed-only pass always has a reachable answer.
    while (!bankPosition && placedEntries.length > 0) {
      const folded = placedEntries.pop();
      placedProcessors.pop();
      if (!folded) break;
      folded.shell.hidden = true;
      folded.element.hidden = true;
      folded.renderedPosition = null;
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
        "auto",
        endpoints,
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
    placement: "auto" | "manual",
    endpoints: readonly DOMRect[] | null,
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
    // `pad` is the clearance demanded around the rect, and it is not always the
    // card-to-card margin: an ENDPOINT is only ever asked not to be COVERED
    // (pad 0). The lane a card belongs in — between the keyboard's last key row
    // and the pads' first hooks — measures ~119px on a fitted 1600x1000 canvas
    // against a 98px card, so a 12px cushion on both sides would price the card
    // out of the one place it is meant to live.
    const intersects = (x: number, y: number, rect: DOMRect, pad = margin) =>
      x + halfWidth + pad > rect.left &&
      x - halfWidth - pad < rect.right &&
      y + halfHeight + pad > rect.top &&
      y - halfHeight - pad < rect.bottom;
    // Walk outward from the desired midpoint over a bounded screen-space
    // lattice. The old obstacle-boundary Cartesian product built and sorted
    // O(N²) candidates, then scanned O(N) obstacles for every processor on
    // every animation frame. This walk is bounded by viewport size, allocates
    // no candidate cloud, and can short-circuit immediately.
    const stepX = Math.max(48, halfWidth * 2 + margin * 2);
    const stepY = Math.max(40, halfHeight * 2 + margin * 2);
    const maxRadius = Math.max(
      1,
      Math.ceil(Math.max(viewport.width / stepX, viewport.height / stepY)) + 1,
    );
    /** Offer every distinct lattice point, nearest the ideal first, until the
     *  visitor claims one by returning `true`. */
    const walkLattice = (visit: (x: number, y: number) => boolean): void => {
      const seen = new Set<string>();
      const offer = (dx: number, dy: number): boolean => {
        const x = clamp(ideal.x + dx * stepX, minX, maxX);
        const y = clamp(ideal.y + dy * stepY, minY, maxY);
        const token = x.toFixed(2) + ":" + y.toFixed(2);
        if (seen.has(token)) return false;
        seen.add(token);
        return visit(x, y);
      };
      for (let radius = 0; radius <= maxRadius; radius += 1) {
        if (radius === 0) {
          if (offer(0, 0)) return;
          continue;
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (offer(dx, -radius)) return;
          if (offer(dx, radius)) return;
        }
        for (let dy = -radius + 1; dy < radius; dy += 1) {
          if (offer(-radius, dy)) return;
          if (offer(radius, dy)) return;
        }
      }
    };
    const nearestClear = (obstacles: readonly DOMRect[]): { x: number; y: number } | null => {
      let clear: { x: number; y: number } | null = null;
      walkLattice((x, y) => {
        if (obstacles.some((rect) => intersects(x, y, rect))) return false;
        clear = { x, y };
        return true;
      });
      return clear;
    };
    /** Slide the card along ONE axis until nothing in `covered` is underneath
     *  it and nothing in `spaced` is within the ordinary margin of it, and
     *  keep whichever of the two slides is shorter.
     *
     *  WHY A SLIDE AND NOT ANOTHER LATTICE WALK: the lattice's step IS the
     *  card (200x122 here), because it exists to lay cards out beside each
     *  other. The lane a card has to reach is narrower than one step — on a
     *  fitted 1600x1000 desktop the keyboard's last key row ends at y≈526 and
     *  the pads' first hooks begin at y≈645, so every position that covers no
     *  endpoint at all lies inside a 20px window that no lattice ring can
     *  land on. Asking for the nearest FREE COORDINATE instead of the nearest
     *  lattice point costs one pass over the obstacles and lands in the lane.
     *
     *  Only axis-aligned slides are considered. An L-shaped move would open a
     *  much larger search for a card that has, by construction, already failed
     *  to find any fully clear lane; a slide that fails simply falls through to
     *  the rung below, which is the behaviour this one improves on. */
    const slideClear = (
      covered: readonly DOMRect[],
      spaced: readonly DOMRect[],
    ): { x: number; y: number } | null => {
      const blocked = (x: number, y: number): boolean =>
        covered.some((rect) => intersects(x, y, rect, 0)) ||
        spaced.some((rect) => intersects(x, y, rect));
      /** The nearest value to `centre` inside [`min`, `max`] that no forbidden
       *  interval contains. Every candidate is an interval EDGE — the shortest
       *  move that clears an obstacle always stops exactly against one. */
      const nearestFree = (
        centre: number,
        min: number,
        max: number,
        intervals: readonly (readonly [number, number])[],
      ): number | null => {
        if (min > max) return null;
        const free = (value: number): boolean =>
          intervals.every(([low, high]) => value <= low || value >= high);
        let best: number | null = null;
        const consider = (value: number): void => {
          const candidate = clamp(value, min, max);
          if (!free(candidate)) return;
          if (best === null || Math.abs(candidate - centre) < Math.abs(best - centre)) {
            best = candidate;
          }
        };
        consider(centre);
        for (const [low, high] of intervals) {
          consider(low);
          consider(high);
        }
        return best;
      };
      // Project only what actually stands in the way of THIS slide: a rect the
      // card would pass beside rather than through constrains nothing.
      const forbidden = (
        axis: "x" | "y",
      ): (readonly [number, number])[] => {
        const half = axis === "x" ? halfWidth : halfHeight;
        const otherHalf = axis === "x" ? halfHeight : halfWidth;
        const otherCentre = axis === "x" ? ideal.y : ideal.x;
        const intervals: (readonly [number, number])[] = [];
        for (const [rects, pad] of [[covered, 0], [spaced, margin]] as const) {
          for (const rect of rects) {
            const otherLow = axis === "x" ? rect.top : rect.left;
            const otherHigh = axis === "x" ? rect.bottom : rect.right;
            if (otherCentre + otherHalf + pad <= otherLow) continue;
            if (otherCentre - otherHalf - pad >= otherHigh) continue;
            const low = axis === "x" ? rect.left : rect.top;
            const high = axis === "x" ? rect.right : rect.bottom;
            intervals.push([low - half - pad, high + half + pad] as const);
          }
        }
        return intervals;
      };
      const x = nearestFree(ideal.x, minX, maxX, forbidden("x"));
      const y = nearestFree(ideal.y, minY, maxY, forbidden("y"));
      const candidates = [
        y === null ? null : { x: ideal.x, y },
        x === null ? null : { x, y: ideal.y },
      ].filter((candidate): candidate is { x: number; y: number } =>
        candidate !== null && !blocked(candidate.x, candidate.y));
      let best: { x: number; y: number } | null = null;
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        const distance = Math.hypot(candidate.x - ideal.x, candidate.y - ideal.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      return best;
    };
    // Widget chrome remains operable even when the map forces the ideal node
    // away from the midpoint. On a phone all three boxes may not fit at once;
    // in that case the passive navigator may sit under the reachable card.
    //
    // ⚠️ A CARD MAY COVER A WIDGET'S QUIET ART; IT MAY NOT COVER A LIVE
    // ENDPOINT. When no lane cleared every widget, this used to re-run the walk
    // with the widgets dropped from the obstacle list, which hands back the
    // clamped ideal: the midpoint between a key and the pad control it drives,
    // i.e. somewhere on the biggest widget on the canvas. A 176x98 anchor then
    // sat on the keyboard and swallowed every pointer event underneath it, so
    // hovering the very key the card is wired FROM did nothing at all — no cord
    // lit, no hook painted, and no way to tell that from a mapping that had
    // silently stopped working. (Measured: with the lens in All scope, Player
    // 2's card landed on the G key, whose two cords the card itself is drawn
    // beside.) Whether a fully clear lane exists is a property of the CAMERA,
    // not of the mapping: a fitted canvas whose widgets fill it has none, and
    // that is an ordinary desktop at 1600x1000, not a pathological case.
    //
    // So the fallback narrows the claim instead of dropping it. What breaks
    // when a card lands on a widget is not "pixels are hidden" but "an endpoint
    // this lens is actively drawing a cord to can no longer be hovered, focused
    // or clicked". `endpoints` is exactly that set — the resolved key and
    // control elements of the routes on screen — and it stays absolute while
    // the widget BODIES become negotiable. A card in the lane between the last
    // key row and the first hook covers nothing that answers a pointer.
    //
    // ⚠️ SCORING EVERY CANDIDATE BY BURIED WIDGET AREA WAS TRIED AND WITHDRAWN.
    // It reads as the obvious generalisation, and it is worse in both
    // directions: the global minimum of that score is a canvas CORNER, so a
    // card teleports away from the route it annotates, and because
    // `#movementBaseOffset` continues from the position the user can see, the
    // first nudge then persists the teleport — a measured `{x: -265, y: 402}`
    // written by pressing "Move right" once. A rule that both loses the card
    // and lies about where the user put it is not an improvement on covering a
    // key; it is a second bug wearing the first one's clothes.
    //
    // ⚠️ ONLY AN AUTOMATIC CARD MAY BE RE-AIMED. A manual one is where a human
    // dragged or nudged it, having LOOKED at this canvas; "you covered a key"
    // is information they already had, and answering it by sliding the card
    // somewhere else is overruling an explicit instruction — and, because the
    // resolved position is what gets persisted, it also writes the override
    // back as if it were the user's own choice. So a manual card keeps the
    // original last two rungs exactly: hold the requested point, and give up
    // only the navigator to do it.
    const spareNavigator = navigator ? [...placedProcessors, navigator] : placedProcessors;
    const live = placement === "auto" ? endpoints ?? [] : [];
    const adjustedScreen = nearestClear(navigator ? [...hardObstacles, navigator] : hardObstacles) ??
      nearestClear(hardObstacles) ??
      (live.length > 0
        ? slideClear(live, spareNavigator) ?? slideClear(live, placedProcessors)
        : null) ??
      nearestClear(spareNavigator) ?? nearestClear(placedProcessors);
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
    if (endpoint.kind === "key") return this.#resolveKeyCached(anchors, endpoint, slot);
    if (endpoint.kind === "control") {
      return this.#resolveControlCached(anchors, endpoint.slot, endpoint.functionName);
    }
    const node = this.#processorEntries.get(endpoint.id)?.element ?? null;
    return node && !node.hidden && endpointVisible(node) ? node : null;
  }

  #resolveKeyCached(
    anchors: MappingAnchorCache,
    endpoint: KeyFlowEndpoint,
    slot: number,
  ): Element | null {
    const id =
      `${slot}\u0000${endpoint.sourceId}\u0000${endpoint.sourceAlias}\u0000${endpoint.key}`;
    if (anchors.keys.has(id)) return anchors.keys.get(id) ?? null;
    const resolved = this.#resolveKey(endpoint, slot);
    anchors.keys.set(id, resolved);
    return resolved;
  }

  #resolveKey(endpoint: KeyFlowEndpoint, slotNumber: number): Element | null {
    const source = this.#resolveSourceRoot(endpoint);
    if (!source) return null;
    const key = CSS.escape(endpoint.key);
    const slot = String(slotNumber);
    const observedAuthority = ':is([data-flow-authority="matched"], [data-flow-authority="mismatch"], [data-flow-authority="observed"])';
    const provisionalAuthority = ':is([data-flow-authority="configured"], [data-flow-authority="expected"], [data-flow-authority="planned"])';
    const selectors = [
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"][data-player-slot="${slot}"]${observedAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]${observedAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"]:not([data-player-slot])${observedAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])${observedAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"][data-player-slot="${slot}"]${provisionalAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]${provisionalAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"]:not([data-player-slot])${provisionalAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])${provisionalAuthority}`,
      `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]`,
      `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])`,
      `.n-surface-channel-anchor:not([data-flow-key])[data-key="${key}"][data-player-slot="${slot}"]`,
      `.n-surface-channel-anchor:not([data-flow-key])[data-key="${key}"]:not([data-player-slot])`,
      `.rd-encoder-product-terminal[data-key="${key}"][data-player-slot="${slot}"]`,
      `.rd-encoder-product-terminal[data-key="${key}"]`,
      `.n-deck-key[data-keylab-key="${key}"][data-player-slot="${slot}"]`,
      `.n-deck-key[data-keylab-key="${key}"]:not([data-player-slot])`,
      `.n-ipac-signal[data-key="${key}"][data-player-slot="${slot}"]`,
      `.n-ipac-signal[data-key="${key}"]`,
      `[data-key="${key}"]:not(.ghost):not(.extracted)`,
    ];
    for (const selector of selectors) {
      const candidate = source.querySelector(selector);
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
    const relation = target.closest<HTMLElement>("[data-flow-chain]");
    if (relation?.dataset.flowChain) {
      return {
        chainId: relation.dataset.flowChain,
        slot: Number(relation.dataset.flowSlot ?? this.#selectedSlot),
      };
    }
    const macro = target.closest<HTMLElement>("[data-flow-macro-id]");
    if (macro?.dataset.flowMacroId) {
      return {
        macroId: macro.dataset.flowMacroId,
        slot: Number(macro.dataset.flowSlot ?? this.#selectedSlot),
      };
    }
    const physicalDevice = target.closest<HTMLElement>(".rd-dev-node[data-selector]");
    const physicalSourceId = physicalDevice?.classList.contains("rd-keyboard-device-node")
      ? mappingRootSourceId(physicalDevice)
      : "";
    if (
      physicalDevice && !physicalSourceId && physicalDevice.dataset.mappingSource !== "true"
    ) return null;
    const pointedSignalRow = target.closest<HTMLElement>(
      ".n-surface-signal-chain[data-surface-channel-id]",
    );
    const pointedEncoderTerminal = target.closest<HTMLElement>(
      ".rd-encoder-product-terminal[data-terminal-id]",
    );
    const pointedSurfaceAnchor = target.closest<HTMLElement>(
      ".n-surface-channel-anchor[data-flow-key]",
    ) ?? pointedSignalRow?.querySelector<HTMLElement>(
      ".n-surface-channel-anchor[data-flow-key]",
    ) ?? pointedEncoderTerminal?.querySelector<HTMLElement>(
      '.n-surface-channel-anchor[data-flow-key][data-flow-plane="normal"]',
    ) ?? pointedEncoderTerminal?.querySelector<HTMLElement>(
      ".n-surface-channel-anchor[data-flow-key]",
    ) ?? null;
    // A multi-channel control is not one interchangeable input. Hovering an
    // unassigned direction must not fall through to a selected sibling and
    // highlight that sibling's route.
    if (pointedSignalRow && !pointedSurfaceAnchor) return null;
    const surface = target.closest<HTMLElement>(".n-surface-control");
    const surfaceAnchor = pointedSurfaceAnchor ?? surface?.querySelector<HTMLElement>(
      '.n-surface-channel-anchor[data-flow-key][data-selected="true"]',
    ) ?? surface?.querySelector<HTMLElement>(".n-surface-channel-anchor[data-flow-key]") ??
      surface?.querySelector<HTMLElement>(
        '.n-surface-channel-anchor[data-key][data-selected="true"]',
      ) ?? surface?.querySelector<HTMLElement>(".n-surface-channel-anchor[data-key]");
    const surfaceKey = surfaceAnchor?.dataset.flowKey?.trim() ?? surfaceAnchor?.dataset.key?.trim();
    if (surfaceKey) return { key: surfaceKey, sourceId: physicalSourceId || undefined };
    const key = target.closest<HTMLElement>("[data-key]")?.dataset.key?.trim();
    if (key) return { key, sourceId: physicalSourceId || undefined };
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
    // A rerender can remove the element which owned the previous inspection
    // before pointerout/focusout reaches the delegated root. Entering blank
    // canvas space is still meaningful: it must clear that orphaned state.
    this.#setInspection(kind, this.#inspectionFor(event.target));
  }

  #leaveEvent(kind: "pointer" | "focus", event: Event): void {
    const from = this.#inspectionFor(event.target);
    if (!from) return;
    const related = "relatedTarget" in event ? (event as FocusEvent).relatedTarget : null;
    const to = this.#inspectionFor(related);
    if (!inspectionEqual(from, to)) this.#setInspection(kind, to);
  }

  #activeInspection(): MappingInspection | null {
    // The semantic route index is the keyboard-accessible equivalent of
    // pointing at a cord, so a resting mouse must not override its deliberate
    // focus. Elsewhere the canvas keeps its established pointer-first model:
    // hovering a key is still a useful temporary trace while an editor control
    // happens to retain focus.
    const active = this.#root.ownerDocument.activeElement;
    const semanticRouteFocused = active instanceof Element &&
      Boolean(this.#routeList?.contains(active));
    return semanticRouteFocused
      ? this.#focusInspection ?? this.#pointerInspection
      : this.#pointerInspection ?? this.#focusInspection;
  }

  #setInspection(kind: "pointer" | "focus", inspection: MappingInspection | null): void {
    const before = this.#activeInspection();
    if (kind === "pointer") this.#pointerInspection = inspection;
    else this.#focusInspection = inspection;
    if (inspectionEqual(before, this.#activeInspection())) return;
    this.#applyInspection();
    const active = this.#root.ownerDocument.activeElement;
    const semanticRouteFocused = active instanceof Element &&
      Boolean(this.#routeList?.contains(active));
    if (kind === "focus" && inspection && semanticRouteFocused) {
      const trace = this.#traceOutput?.textContent?.trim();
      if (trace) this.#announce(trace);
    }
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
    if (inspection.chainId) chains.add(inspection.chainId);
    if (inspection.macroId) chains.add(inspection.macroId);
    for (const route of this.#routes) {
      if (
        inspection.key && route.source.kind === "key" &&
        route.source.key === inspection.key &&
        this.#sourceRootMatchesId(route.source, inspection.sourceId)
      ) {
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
    this.#syncTrace(relatedChains);
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
    this.#syncPaintOrder();
    for (const anchor of this.#relatedAnchors) anchor.classList.add("n-flow-anchor-related");
  }
}
