/**
 * Physical-keyboard canvas surfaces.
 *
 * Every intentionally added keyboard owns one persistent DOM subtree. The
 * reactive island keeps a hidden blueprint because device canvas items are
 * client-authored, but a live surface is cloned only once and is never moved
 * between devices. Subsequent payloads reconcile attributes and text in
 * place, preserving focus, element identity, and browser state on peer
 * refresh/removal.
 */

export const KEYBOARD_SURFACE_ATTRIBUTE = "data-rd-keyboard-surface";
export const KEYBOARD_SURFACE_TEMPLATE_ATTRIBUTE = "data-rd-keyboard-surface-template";
export const KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE =
  "data-rd-keyboard-surface-template-body";
export const KEYBOARD_SURFACE_HOST_ATTRIBUTE = "data-rd-keyboard-surface-host";

export const KEYBOARD_SURFACE_SELECTOR = `[${KEYBOARD_SURFACE_ATTRIBUTE}]`;
export const KEYBOARD_SURFACE_TEMPLATE_BODY_SELECTOR =
  `[${KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE}]`;

export interface KeyboardSurfaceInstanceOptions {
  /** Exact backend selector. Never slug or canonicalize source identity. */
  sourceId: string;
  /** Collision-safe canvas instance id, used only to namespace DOM ids. */
  instanceId: string;
  sourceLabel: string;
  /** Whether this exact source currently belongs to the editable draft. */
  mappingAvailable: boolean;
}

export interface KeyboardSourceMappingControl {
  function: string;
  label: string;
  keys: string[];
}

export interface KeyboardSourceMappingMacro {
  name: string;
  triggers: string[];
}

export interface KeyboardSourceMappingRoute {
  slot: number;
  controls: KeyboardSourceMappingControl[];
  macros: KeyboardSourceMappingMacro[];
}

/** Source-qualified painting for one physical board. The selected slot only
 * chooses which readable control label is printed on a cap; every route still
 * contributes an owner band, so changing inspector focus cannot hide or
 * disable a peer controller mapping. */
export interface KeyboardSourceMappingProjection {
  sourceLabel: string;
  selectedSlot: number;
  routes: KeyboardSourceMappingRoute[];
}

/** Minimal wire shape needed to derive one board's existing routes. An
 * unrouted source row remains useful first-bind authority elsewhere, but it
 * must not appear as a player owned by this physical keyboard. */
export interface KeyboardSourceMappingPad {
  slot: number;
  sources?: Array<{
    source_id: string;
    routed: boolean;
    mapping_available: boolean;
    controls?: KeyboardSourceMappingControl[];
    macros?: KeyboardSourceMappingMacro[];
  }>;
}

export function keyboardSourceMappingRoutes(
  pads: readonly KeyboardSourceMappingPad[],
  sourceId: string,
): KeyboardSourceMappingRoute[] {
  return pads.flatMap((pad) => {
    const source = pad.sources?.find((candidate) => candidate.source_id === sourceId);
    if (!source?.routed || source.mapping_available === false) return [];
    return [{
      slot: pad.slot,
      controls: (source.controls ?? []).map((control) => ({
        function: control.function,
        label: control.label,
        keys: [...control.keys],
      })),
      macros: (source.macros ?? []).map((macro) => ({
        name: macro.name,
        triggers: [...macro.triggers],
      })),
    }];
  });
}

/** The persistent target placed inside each physical-keyboard canvas item. */
export function createKeyboardSurfaceHost(document: Document): HTMLElement {
  const host = document.createElement("div");
  host.className = "rd-keyboard-device-surface-host";
  host.setAttribute(KEYBOARD_SURFACE_HOST_ATTRIBUTE, "");
  return host;
}

const ID_REFERENCE_ATTRIBUTES = ["aria-controls", "aria-describedby", "aria-labelledby"];

function namespaceDomIds(root: HTMLElement, namespace: string): void {
  const ids = new Map<string, string>();
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("[id]"))]) {
    const previous = element.id;
    if (!previous) continue;
    const next = `${previous}--${namespace}`;
    ids.set(previous, next);
    element.id = next;
  }
  if (ids.size === 0) return;
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    for (const attribute of ID_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const rewritten = value
        .split(/\s+/)
        .map((token) => ids.get(token) ?? token)
        .join(" ");
      if (rewritten !== value) element.setAttribute(attribute, rewritten);
    }
  }
}

function mappingNeutralClassName(className: string): string {
  return className.replace(
    /\s+(?:bound|shared|bstack|bn\d+|bcount\d+|b[abcd]\d+)/g,
    "",
  );
}

function replaceNamespacedChildren(
  target: HTMLElement,
  source: HTMLElement,
  namespace: string,
): void {
  const clone = source.cloneNode(true) as HTMLElement;
  namespaceDomIds(clone, namespace);
  target.replaceChildren(...Array.from(clone.childNodes));
}

function syncKeyboardRows(
  surface: HTMLElement,
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): void {
  const sourceKeys = template.querySelectorAll<HTMLButtonElement>(".n-kbcase button[data-key]");
  const targetKeys = surface.querySelectorAll<HTMLButtonElement>(".n-kbcase button[data-key]");
  for (let index = 0; index < Math.min(sourceKeys.length, targetKeys.length); index += 1) {
    const source = sourceKeys[index];
    const target = targetKeys[index];
    const cap = target.querySelector<HTMLElement>(".n-key-cap")?.textContent ??
      target.dataset.key ?? "Key";
    // The hidden template is projected for the inspector's current source.
    // Geometry and cap labels are reusable; its binding classes are not. Each
    // physical board receives exact-source paint in
    // `syncKeyboardSourceMapping` after this structural reconciliation.
    target.className = mappingNeutralClassName(source.className);
    const short = target.querySelector<HTMLElement>(".n-key-short");
    if (short) short.textContent = "";
    if (options.mappingAvailable) {
      target.title = "";
      target.setAttribute("aria-label", `${cap} on ${options.sourceLabel}`);
      target.removeAttribute("aria-disabled");
    } else {
      target.title = `${cap} on ${options.sourceLabel} — mapping is not available for this device yet`;
      target.setAttribute("aria-label", `${cap} on ${options.sourceLabel}`);
      target.setAttribute("aria-disabled", "true");
    }
  }
}

interface KeyPaint {
  selectedTargets: string[];
  owners: number[];
}

const BAND_KEYS = ["ba", "bb", "bc", "bd"] as const;

function readableShort(label: string, fnName: string): string {
  const readable = label.trim();
  if (readable.length > 0 && readable.length <= 5) return readable;
  const token = fnName.trim().toLowerCase();
  const replacements: Record<string, string> = {
    left_stick_up: "LS↑",
    left_stick_down: "LS↓",
    left_stick_left: "LS←",
    left_stick_right: "LS→",
    right_stick_up: "RS↑",
    right_stick_down: "RS↓",
    right_stick_left: "RS←",
    right_stick_right: "RS→",
    dpad_up: "↑",
    dpad_down: "↓",
    dpad_left: "←",
    dpad_right: "→",
  };
  if (replacements[token]) return replacements[token];
  const initials = readable
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
  return (initials || token.replace(/[^a-z0-9]/g, "").toUpperCase()).slice(0, 5);
}

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

function mappingPaint(projection: KeyboardSourceMappingProjection): Map<string, KeyPaint> {
  const paint = new Map<string, KeyPaint>();
  const entry = (key: string): KeyPaint => {
    let current = paint.get(key);
    if (!current) {
      current = { selectedTargets: [], owners: [] };
      paint.set(key, current);
    }
    return current;
  };
  for (const route of projection.routes) {
    const own = (key: string, selectedTarget: string): void => {
      const normalized = key.trim();
      if (!normalized) return;
      const current = entry(normalized);
      if (!current.owners.includes(route.slot)) current.owners.push(route.slot);
      if (route.slot === projection.selectedSlot) addUnique(current.selectedTargets, selectedTarget);
    };
    for (const control of route.controls) {
      const label = control.label.trim() || control.function;
      for (const key of control.keys) own(key, label);
    }
    for (const macro of route.macros) {
      for (const key of macro.triggers) own(key, `Macro ${macro.name}`);
    }
  }
  for (const value of paint.values()) value.owners.sort((a, b) => a - b);
  return paint;
}

function mappingClasses(owners: readonly number[]): string[] {
  if (owners.length === 0) return [];
  if (owners.length > BAND_KEYS.length) return ["bstack", `bcount${owners.length}`];
  return [
    `bn${owners.length}`,
    ...owners.map((slot, index) => `${BAND_KEYS[index]}${slot}`),
  ];
}

/** Reconcile the cloned, server-wide legend to this exact physical source.
 * The hidden blueprint contains every staged controller, so leaving its
 * visibility untouched makes an unrouted peer board claim mappings owned by
 * another keyboard. The stack badge is likewise derived from this source's
 * key ownership, never from the blueprint's aggregate board projection. */
function syncSourceLegend(
  surface: HTMLElement,
  projection: KeyboardSourceMappingProjection,
  paint: ReadonlyMap<string, KeyPaint>,
): void {
  const legend = surface.querySelector<HTMLElement>(".n-legend");
  if (!legend) return;

  const sourceSlots = new Set(projection.routes.map((route) => route.slot));
  let visibleChips = 0;
  for (const chip of Array.from(legend.querySelectorAll<HTMLElement>("[data-slot]"))) {
    const visible = sourceSlots.has(Number(chip.dataset.slot));
    chip.hidden = !visible;
    if (visible) chip.removeAttribute("aria-hidden");
    else chip.setAttribute("aria-hidden", "true");
    if (visible) visibleChips += 1;
  }

  const hasStackedKey = [...paint.values()].some(
    (keyPaint) => keyPaint.owners.length > BAND_KEYS.length,
  );
  const more = legend.querySelector<HTMLElement>(".n-lgdmore");
  if (more) {
    more.hidden = !hasStackedKey;
    more.classList.toggle("none", !hasStackedKey);
  }
  legend.hidden = visibleChips === 0 && !hasStackedKey;
}

function paintKey(
  key: HTMLButtonElement,
  paint: KeyPaint | undefined,
  projection: KeyboardSourceMappingProjection,
): void {
  key.className = mappingNeutralClassName(key.className);
  const cap = key.querySelector<HTMLElement>(".n-key-cap")?.textContent?.trim() ||
    key.dataset.key || "Key";
  const short = key.querySelector<HTMLElement>(".n-key-short");
  const selectedTargets = paint?.selectedTargets ?? [];
  const owners = paint?.owners ?? [];
  if (owners.length > 0) key.classList.add("bound", ...mappingClasses(owners));
  if (selectedTargets.length > 1) key.classList.add("shared");
  if (short) {
    const selectedRoute = projection.routes.find((route) => route.slot === projection.selectedSlot);
    const control = selectedRoute?.controls.find((candidate) =>
      candidate.keys.some((candidateKey) => candidateKey === key.dataset.key)
    );
    short.textContent = selectedTargets.length === 0
      ? ""
      : control
        ? readableShort(control.label, control.function)
        : "M";
  }
  const otherOwners = owners.filter((slot) => slot !== projection.selectedSlot);
  let title = "";
  if (selectedTargets.length > 0) {
    title = `${cap} — drives ${selectedTargets.join(" · ")} on P${projection.selectedSlot}`;
  }
  if (otherOwners.length > 0) {
    const suffix = `bound on ${otherOwners.map((slot) => `P${slot}`).join(" · ")}`;
    title = title ? `${title}; also ${suffix}` : `${cap} — ${suffix}`;
  }
  key.title = title;
  key.setAttribute(
    "aria-label",
    title ? `${title} via ${projection.sourceLabel}` : `${cap} on ${projection.sourceLabel}`,
  );
}

function createTrayKey(
  document: Document,
  keyName: string,
  paint: KeyPaint,
  projection: KeyboardSourceMappingProjection,
): HTMLButtonElement {
  const key = document.createElement("button");
  key.type = "button";
  key.className = "n-key tray";
  key.dataset.key = keyName;
  // The board is one composite Tab stop. `syncKeyboardRovingFocus` chooses
  // the current key after the whole plate (including this dynamic tray) has
  // been reconciled.
  key.tabIndex = -1;
  const cap = document.createElement("span");
  cap.className = "n-key-cap";
  cap.textContent = keyName;
  const short = document.createElement("span");
  short.className = "n-key-short";
  key.append(cap, short);
  paintKey(key, paint, projection);
  return key;
}

const KEYBOARD_KEY_SELECTOR =
  ".n-kbcase button[data-key], .n-kbtray-row button[data-key]";
const KEYBOARD_ROW_SELECTOR = ".n-kbrow, .n-kbtray-row";

function keyboardKeyIsAvailable(key: HTMLButtonElement): boolean {
  return !key.disabled && key.getAttribute("aria-hidden") !== "true" &&
    !key.closest("[hidden], [inert]");
}

function keyboardRovingKeys(surface: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    surface.querySelectorAll<HTMLButtonElement>(KEYBOARD_KEY_SELECTOR),
  ).filter(keyboardKeyIsAvailable);
}

function keyboardRowKeys(
  surface: HTMLElement,
  row: Element | null,
): HTMLButtonElement[] {
  if (!row) return [];
  return Array.from(row.querySelectorAll<HTMLButtonElement>("button[data-key]"))
    .filter((key) => surface.contains(key) && keyboardKeyIsAvailable(key));
}

function keyboardHorizontalCenter(key: HTMLButtonElement): number | null {
  const rect = key.getBoundingClientRect();
  return rect.width > 0 ? rect.left + rect.width / 2 : null;
}

function keyboardVerticalTarget(
  surface: HTMLElement,
  current: HTMLButtonElement,
  direction: -1 | 1,
): HTMLButtonElement | null {
  const rows = Array.from(surface.querySelectorAll<HTMLElement>(KEYBOARD_ROW_SELECTOR))
    .filter((row) => keyboardRowKeys(surface, row).length > 0);
  const currentRow = current.closest(KEYBOARD_ROW_SELECTOR);
  const rowIndex = rows.findIndex((row) => row === currentRow);
  if (rowIndex < 0) return null;

  const currentRowKeys = keyboardRowKeys(surface, currentRow);
  const currentIndex = Math.max(0, currentRowKeys.indexOf(current));
  const currentCenter = keyboardHorizontalCenter(current);
  for (
    let candidateRowIndex = rowIndex + direction;
    candidateRowIndex >= 0 && candidateRowIndex < rows.length;
    candidateRowIndex += direction
  ) {
    const candidates = keyboardRowKeys(surface, rows[candidateRowIndex]);
    if (candidates.length === 0) continue;
    if (currentCenter === null) {
      return candidates[Math.min(currentIndex, candidates.length - 1)] ?? null;
    }
    return candidates.reduce((nearest, candidate) => {
      const nearestCenter = keyboardHorizontalCenter(nearest);
      const candidateCenter = keyboardHorizontalCenter(candidate);
      if (candidateCenter === null) return nearest;
      if (nearestCenter === null) return candidate;
      return Math.abs(candidateCenter - currentCenter) < Math.abs(nearestCenter - currentCenter)
        ? candidate
        : nearest;
    });
  }
  return null;
}

function setKeyboardRovingTarget(
  surface: HTMLElement,
  requested: HTMLButtonElement | null,
  moveFocus: boolean,
): void {
  const keys = keyboardRovingKeys(surface);
  const target = requested && keys.includes(requested) ? requested : keys[0] ?? null;
  for (const key of keys) key.tabIndex = key === target ? 0 : -1;
  if (!target) {
    delete surface.dataset.keyboardRovingKey;
    return;
  }
  surface.dataset.keyboardRovingKey = target.dataset.key ?? "";
  if (moveFocus) target.focus({ preventScroll: true });
}

function installKeyboardRovingFocus(surface: HTMLElement): void {
  if (surface.dataset.keyboardRoving === "true") return;
  surface.dataset.keyboardRoving = "true";
  surface.addEventListener("focusin", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(KEYBOARD_KEY_SELECTOR)
      : null;
    if (target && surface.contains(target)) setKeyboardRovingTarget(surface, target, false);
  });
  surface.addEventListener("keydown", (event) => {
    const current = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(KEYBOARD_KEY_SELECTOR)
      : null;
    if (!current || !surface.contains(current) || event.altKey || event.metaKey) return;

    const row = current.closest(KEYBOARD_ROW_SELECTOR);
    const rowKeys = keyboardRowKeys(surface, row);
    const rowIndex = rowKeys.indexOf(current);
    let target: HTMLButtonElement | null = null;
    switch (event.key) {
      case "ArrowLeft":
        if (!event.ctrlKey) target = rowKeys[rowIndex - 1] ?? null;
        break;
      case "ArrowRight":
        if (!event.ctrlKey) target = rowKeys[rowIndex + 1] ?? null;
        break;
      case "ArrowUp":
        if (!event.ctrlKey) target = keyboardVerticalTarget(surface, current, -1);
        break;
      case "ArrowDown":
        if (!event.ctrlKey) target = keyboardVerticalTarget(surface, current, 1);
        break;
      case "Home": {
        const keys = event.ctrlKey ? keyboardRovingKeys(surface) : rowKeys;
        target = keys[0] ?? null;
        break;
      }
      case "End": {
        const keys = event.ctrlKey ? keyboardRovingKeys(surface) : rowKeys;
        target = keys.at(-1) ?? null;
        break;
      }
      default:
        return;
    }
    // Arrow keys belong to the keyboard composite even at an edge. Letting
    // an unhandled edge press bubble would move the entire canvas widget.
    event.preventDefault();
    event.stopPropagation();
    if (target) setKeyboardRovingTarget(surface, target, true);
  });
}

function syncKeyboardRovingFocus(
  surface: HTMLElement,
  preferredKey = "",
  restoreFocus = false,
): void {
  installKeyboardRovingFocus(surface);
  const keys = keyboardRovingKeys(surface);
  const active = surface.ownerDocument.activeElement;
  const activeKey = active instanceof HTMLButtonElement && keys.includes(active)
    ? active
    : null;
  const wantedKey = preferredKey || surface.dataset.keyboardRovingKey || "";
  const remembered = wantedKey
    ? keys.find((key) => key.dataset.key === wantedKey) ?? null
    : null;
  const existing = keys.find((key) => key.tabIndex === 0) ?? null;
  setKeyboardRovingTarget(surface, activeKey ?? remembered ?? existing, false);
  if (restoreFocus) {
    const target = remembered ?? activeKey ?? existing ?? keys[0] ?? null;
    if (target) setKeyboardRovingTarget(surface, target, true);
  }
}

/** Paint one persistent board from only that physical source's routes. This is
 * deliberately separate from inspector focus: all controller owners remain
 * visible and live while one slot supplies the cap's short label. */
export function syncKeyboardSourceMapping(
  surface: HTMLElement,
  projection: KeyboardSourceMappingProjection,
): void {
  const active = surface.ownerDocument.activeElement;
  const focusedKey = active instanceof HTMLButtonElement && surface.contains(active) &&
      active.matches(KEYBOARD_KEY_SELECTOR)
    ? active
    : null;
  const focusedKeyName = focusedKey?.dataset.key ?? "";
  const paint = mappingPaint(projection);
  syncSourceLegend(surface, projection, paint);
  const plateKeys = Array.from(
    surface.querySelectorAll<HTMLButtonElement>(".n-kbcase button[data-key]"),
  );
  const onPlate = new Set(plateKeys.map((key) => key.dataset.key ?? "").filter(Boolean));
  for (const key of plateKeys) paintKey(key, paint.get(key.dataset.key ?? ""), projection);

  const tray = surface.querySelector<HTMLElement>(".n-kbtray");
  const trayRow = tray?.querySelector<HTMLElement>(".n-kbtray-row");
  const trayHead = tray?.querySelector<HTMLElement>(".n-kbtray-head");
  const offBoard = [...paint.entries()]
    .filter(([key, value]) => !onPlate.has(key) && value.owners.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (trayRow) {
    trayRow.replaceChildren(
      ...offBoard.map(([key, value]) =>
        createTrayKey(surface.ownerDocument, key, value, projection)
      ),
    );
  }
  if (trayHead) trayHead.textContent = `Bound off this board · ${offBoard.length}`;
  if (tray) {
    tray.hidden = offBoard.length === 0;
    tray.classList.toggle("none", offBoard.length === 0);
  }
  syncKeyboardRovingFocus(
    surface,
    focusedKeyName,
    Boolean(focusedKey && !focusedKey.isConnected),
  );
}

/** Create one independent surface. It is cloned once and remains owned by the
 * same device until that device is explicitly removed from the canvas. */
export function createKeyboardSurfaceInstance(
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): HTMLElement {
  const surface = template.cloneNode(true) as HTMLElement;
  surface.removeAttribute(KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE);
  surface.setAttribute(KEYBOARD_SURFACE_ATTRIBUTE, "");
  namespaceDomIds(surface, options.instanceId);
  syncKeyboardSurfaceInstance(surface, template, options);
  return surface;
}

/** Reconcile served presentation onto an existing device-owned surface.
 * Native key nodes are updated, never replaced, so focus cannot jump to a
 * peer when the server refreshes. */
export function syncKeyboardSurfaceInstance(
  surface: HTMLElement,
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): void {
  surface.dataset.sourceId = options.sourceId;
  surface.dataset.mappingAvailable = options.mappingAvailable ? "true" : "false";
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", `${options.sourceLabel} keyboard`);
  surface.setAttribute("aria-description", "Use arrow keys to move between keyboard keys.");
  const title = surface.querySelector<HTMLElement>(".n-kbhead > .n-kick");
  if (title) title.textContent = options.sourceLabel;
  syncKeyboardRows(surface, template, options);

  const tray = surface.querySelector<HTMLElement>(".n-kbtray");
  if (tray && !options.mappingAvailable) tray.hidden = true;
  const legend = surface.querySelector<HTMLElement>(".n-legend");
  const colors = surface.querySelector<HTMLElement>(".n-kbcolors");
  if (options.mappingAvailable) {
    const active = surface.ownerDocument.activeElement;
    if (legend) legend.hidden = false;
    if (colors) colors.hidden = false;
    const sourceLegend = template.querySelector<HTMLElement>(".n-legend");
    if (
      sourceLegend && legend && sourceLegend.textContent !== legend.textContent &&
      !legend.contains(active)
    ) {
      replaceNamespacedChildren(legend, sourceLegend, options.instanceId);
    }
    const sourceTray = template.querySelector<HTMLElement>(".n-kbtray");
    if (sourceTray && tray && !tray.contains(active)) {
      tray.className = sourceTray.className;
      replaceNamespacedChildren(tray, sourceTray, options.instanceId);
    }
  } else {
    if (legend) legend.hidden = true;
    if (colors) colors.hidden = true;
    surface.querySelector<HTMLElement>(".rd-keycue")?.classList.add("none");
  }
  syncKeyboardRovingFocus(surface);
}
