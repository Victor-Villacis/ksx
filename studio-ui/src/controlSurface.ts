/**
 * Browser-kept physical control-surface documents for Nocturne's canvas.
 *
 * A document owns geometry and the association between a drawn component and
 * the host signal the real hardware emits. It deliberately does NOT own KSX
 * bindings: routing still goes through the backend's existing bind verb, and
 * the canvas derives route labels from the backend-owned mapping projection.
 */

import {
  KEYBOARD_THEME_SLUGS,
  keyboardThemeIsValid,
  type KeyboardThemeSlug,
  type KeyboardWorkbenchPlacedKey,
  type KeyboardWorkbenchRenderMode,
} from "./keyboardWorkbench";

export const CONTROL_SURFACE_STORAGE_KEY = "ksx-nocturne-control-surfaces1";
export const CONTROL_SURFACE_STORE_VERSION = 2 as const;
export const CONTROL_SURFACE_BOUNDS = { width: 1200, height: 720 } as const;

export const CONTROL_SURFACE_TEMPLATE_SLUGS = [
  "blank",
  "arcade-stick",
  "leverless",
  "four-player",
  "mapping-selected",
  "mapping-four",
] as const;

export type ControlSurfaceTemplate = (typeof CONTROL_SURFACE_TEMPLATE_SLUGS)[number];
export type ControlSurfaceStoredTemplate =
  | ControlSurfaceTemplate
  | "custom"
  | "workbench-migration";
export type ControlSurfacePanelLayout = "single" | "four-player";
export type ControlSurfacePhysicalResolution = "confirmed" | "unresolved-shared-signal";
export type ControlSurfaceStage = "design" | "teach" | "route";
export type ControlSurfaceControlKind = "button30" | "button24" | "keycap" | "joystick";
export type ControlSurfaceOrigin = "template" | "manual" | "mapping-generated" | "workbench-migration";

export interface ControlSurfaceInput {
  kind: "unassigned" | "keyboard";
  key: string;
  /** The exact learner-reported device when available; otherwise the selected keyboard identity. */
  device: string;
}

/** What the physical encoder is expected to emit after a reviewed hardware
 *  program. This is deliberately separate from `input`, which remains the
 *  signal Teach actually observed from Windows. */
export interface ControlSurfaceEncoderAssignment {
  driver: string;
  boardFingerprint: string;
  terminalId: string;
  terminalLabel: string;
  expectedKey: string;
  verification: "unverified" | "matched" | "mismatch";
}

export interface ControlSurfaceChannel {
  id: string;
  label: string;
  input: ControlSurfaceInput;
  encoder?: ControlSurfaceEncoderAssignment;
}

export interface ControlSurfaceControl {
  /** Stable visual instance identity. */
  id: string;
  /** Stable physical-switch identity. Mirrors share it; duplicates do not. */
  physicalId: string;
  /** Whether repeated mapped views are known to be one switch or several. */
  physicalResolution: ControlSurfacePhysicalResolution;
  kind: ControlSurfaceControlKind;
  label: string;
  playerSlot: number | null;
  origin: ControlSurfaceOrigin;
  x: number;
  y: number;
  width: number;
  height: number;
  channels: ControlSurfaceChannel[];
}

export interface ControlSurfaceState {
  open: boolean;
  started: boolean;
  name: string;
  template: ControlSurfaceStoredTemplate;
  /** The durable panel shape. Unlike `template`, ordinary edits never erase it. */
  panelLayout: ControlSurfacePanelLayout;
  stage: ControlSurfaceStage;
  theme: KeyboardThemeSlug;
  controls: ControlSurfaceControl[];
  selectedControlId: string;
  selectedChannelId: string;
  nextId: number;
}

export interface ControlSurfaceStore {
  version: typeof CONTROL_SURFACE_STORE_VERSION;
  devices: Record<string, ControlSurfaceState>;
  /** One-way migration marker; the old workbench remains readable and recoverable. */
  migratedWorkbench: Record<string, true>;
}

export interface ControlSurfaceMappingRecord {
  key: string;
  slot: number;
  functionName: string;
  controlLabel: string;
  playerLabel: string;
}

const MAX_DEVICE_IDENTITIES = 64;
// A four-player Workbench can truthfully contain four views of every one of
// its 128 selected keys. Keep the sanitizer cap large enough to migrate that
// complete document; truncating a physical panel is data loss, not cleanup.
export const CONTROL_SURFACE_MAX_CONTROLS = 512;
const MAX_CHANNELS = 8;
const MAX_STRING = 96;
const MAX_ID = 128;
const DEFAULT_DEVICE = "keyboard:default";
const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const EMPTY_INPUT: ControlSurfaceInput = { kind: "unassigned", key: "", device: "" };

export const DEFAULT_CONTROL_SURFACE_STATE: ControlSurfaceState = {
  open: false,
  started: false,
  name: "Control Surface",
  template: "blank",
  panelLayout: "single",
  stage: "design",
  theme: "carbon-forge",
  controls: [],
  selectedControlId: "",
  selectedChannelId: "",
  nextId: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, max = MAX_STRING): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function canonicalDevice(value: unknown): string {
  const device = cleanString(value, 240);
  return !device || FORBIDDEN_RECORD_KEYS.has(device) ? DEFAULT_DEVICE : device;
}

function validKind(value: unknown): value is ControlSurfaceControlKind {
  return value === "button30" || value === "button24" || value === "keycap" || value === "joystick";
}

function validOrigin(value: unknown): value is ControlSurfaceOrigin {
  return value === "template" || value === "manual" || value === "mapping-generated" || value === "workbench-migration";
}

function validStage(value: unknown): value is ControlSurfaceStage {
  return value === "design" || value === "teach" || value === "route";
}

function validPanelLayout(value: unknown): value is ControlSurfacePanelLayout {
  return value === "single" || value === "four-player";
}

function validPhysicalResolution(value: unknown): value is ControlSurfacePhysicalResolution {
  return value === "confirmed" || value === "unresolved-shared-signal";
}

function validTemplate(value: unknown): value is ControlSurfaceStoredTemplate {
  return value === "custom" || value === "workbench-migration" ||
    (typeof value === "string" && CONTROL_SURFACE_TEMPLATE_SLUGS.includes(value as ControlSurfaceTemplate));
}

function cleanInput(value: unknown): ControlSurfaceInput {
  if (!isRecord(value) || value.kind !== "keyboard") return { ...EMPTY_INPUT };
  const key = cleanString(value.key);
  if (!key) return { ...EMPTY_INPUT };
  return { kind: "keyboard", key, device: cleanString(value.device, 240) };
}

function cleanEncoderAssignment(value: unknown): ControlSurfaceEncoderAssignment | undefined {
  if (!isRecord(value)) return undefined;
  const driver = cleanString(value.driver, 64);
  const boardFingerprint = cleanString(value.boardFingerprint, 160);
  const terminalId = cleanString(value.terminalId, 32);
  const terminalLabel = cleanString(value.terminalLabel, 64);
  const expectedKey = cleanString(value.expectedKey, 64);
  const verification = value.verification === "matched" || value.verification === "mismatch"
    ? value.verification
    : "unverified";
  if (!driver || !boardFingerprint || !terminalId) return undefined;
  return {
    driver,
    boardFingerprint,
    terminalId,
    terminalLabel: terminalLabel || terminalId,
    expectedKey,
    verification,
  };
}

function cleanChannels(value: unknown, kind: ControlSurfaceControlKind): ControlSurfaceChannel[] {
  const fallback = channelsForKind(kind);
  if (!Array.isArray(value)) return fallback;
  const channels: ControlSurfaceChannel[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = cleanString(raw.id, 32);
    if (!id || seen.has(id) || FORBIDDEN_RECORD_KEYS.has(id)) continue;
    seen.add(id);
    channels.push({
      id,
      label: cleanString(raw.label, 40) || id,
      input: cleanInput(raw.input),
      encoder: cleanEncoderAssignment(raw.encoder),
    });
    if (channels.length >= MAX_CHANNELS) break;
  }
  return channels.length > 0 ? channels : fallback;
}

function cleanControl(value: unknown, index: number): ControlSurfaceControl | null {
  if (!isRecord(value) || !validKind(value.kind)) return null;
  const width = clamp(finite(value.width, sizeForKind(value.kind).width), 36, 280);
  const height = clamp(finite(value.height, sizeForKind(value.kind).height), 36, 280);
  const id = cleanString(value.id, MAX_ID) || `c${index + 1}`;
  if (FORBIDDEN_RECORD_KEYS.has(id)) return null;
  const physicalId = cleanString(value.physicalId, MAX_ID) || `physical:${id}`;
  const rawSlot = finite(value.playerSlot, 0);
  const playerSlot = Number.isInteger(rawSlot) && rawSlot >= 1 && rawSlot <= 4 ? rawSlot : null;
  return {
    id,
    physicalId,
    physicalResolution: validPhysicalResolution(value.physicalResolution)
      ? value.physicalResolution
      : "confirmed",
    kind: value.kind,
    label: cleanString(value.label, 64) || defaultLabel(value.kind),
    playerSlot,
    origin: validOrigin(value.origin) ? value.origin : "manual",
    x: round(clamp(finite(value.x, 24), 0, CONTROL_SURFACE_BOUNDS.width - width)),
    y: round(clamp(finite(value.y, 24), 0, CONTROL_SURFACE_BOUNDS.height - height)),
    width: round(width),
    height: round(height),
    channels: cleanChannels(value.channels, value.kind),
  };
}

function keyboardKeys(control: ControlSurfaceControl): Set<string> {
  return new Set(
    control.channels
      .filter((channel) => channel.input.kind === "keyboard")
      .map((channel) => channel.input.key),
  );
}

function reconcileUnresolvedSignals(
  controls: readonly ControlSurfaceControl[],
): ControlSurfaceControl[] {
  const unresolved = controls.filter(
    (control) => control.physicalResolution === "unresolved-shared-signal",
  );
  const keysById = new Map(unresolved.map((control) => [control.id, keyboardKeys(control)]));
  return controls.map((control) => {
    if (control.physicalResolution !== "unresolved-shared-signal") return control;
    const keys = keysById.get(control.id) ?? new Set<string>();
    const hasPeer = keys.size > 0 && unresolved.some((candidate) =>
      candidate.id !== control.id &&
      [...(keysById.get(candidate.id) ?? [])].some((key) => keys.has(key))
    );
    return hasPeer ? control : { ...control, physicalResolution: "confirmed" };
  });
}

export function cloneControlSurfaceState(state: ControlSurfaceState): ControlSurfaceState {
  return {
    ...state,
    controls: state.controls.map((control) => ({
      ...control,
      channels: control.channels.map((channel) => ({
        ...channel,
        input: { ...channel.input },
        encoder: channel.encoder ? { ...channel.encoder } : undefined,
      })),
    })),
  };
}

export function sanitizeControlSurfaceState(value: unknown): ControlSurfaceState {
  if (!isRecord(value)) return cloneControlSurfaceState(DEFAULT_CONTROL_SURFACE_STATE);
  const controls: ControlSurfaceControl[] = [];
  const ids = new Set<string>();
  const legacyPhysicalResolution = new Set<string>();
  if (Array.isArray(value.controls)) {
    for (const raw of value.controls) {
      const control = cleanControl(raw, controls.length);
      if (!control || ids.has(control.id)) continue;
      ids.add(control.id);
      if (!isRecord(raw) || !validPhysicalResolution(raw.physicalResolution)) {
        legacyPhysicalResolution.add(control.id);
      }
      controls.push(control);
      if (controls.length >= CONTROL_SURFACE_MAX_CONTROLS) break;
    }
  }
  // Early generated documents assumed equal mapped keys meant one physical
  // switch. That cannot be known from mappings alone: two separately wired
  // controls can emit the same host signal. Migrate only that legacy shape;
  // Workbench migrations remain proven mirrors and keep their shared id.
  const legacyGeneratedGroups = new Map<string, ControlSurfaceControl[]>();
  for (const control of controls) {
    if (control.origin !== "mapping-generated" || !legacyPhysicalResolution.has(control.id)) continue;
    const group = legacyGeneratedGroups.get(control.physicalId) ?? [];
    group.push(control);
    legacyGeneratedGroups.set(control.physicalId, group);
  }
  for (const group of legacyGeneratedGroups.values()) {
    if (group.length < 2) continue;
    for (const control of group) {
      control.physicalId = `physical:${control.id}`;
      control.physicalResolution = "unresolved-shared-signal";
    }
  }
  const reconciledControls = reconcileUnresolvedSignals(controls);
  const selectedControlId = cleanString(value.selectedControlId, MAX_ID);
  const selected = controls.find((control) => control.id === selectedControlId);
  const selectedChannelId = selected?.channels.some(
    (channel) => channel.id === cleanString(value.selectedChannelId, 32),
  )
    ? cleanString(value.selectedChannelId, 32)
    : selected?.channels[0]?.id ?? "";
  const rawNext = finite(value.nextId, controls.length + 1);
  const highestGeneratedId = controls.reduce((highest, control) => {
    const match = /^c([1-9]\d*)$/.exec(control.id);
    if (!match) return highest;
    const candidate = Number(match[1]);
    return Number.isSafeInteger(candidate) ? Math.max(highest, candidate) : highest;
  }, 0);
  // Version-one documents predate the durable panel-layout field. A pristine
  // four-player template is unambiguous, while an edited one has already
  // become `custom`; its surviving player assignments recover the same shape.
  const inferredPanelLayout = value.template === "four-player" || value.template === "mapping-four" ||
      new Set(
        controls
          .map((control) => control.playerSlot)
          .filter((slot): slot is number => slot !== null),
      ).size > 1
    ? "four-player"
    : "single";
  return {
    open: value.open === true,
    started: value.started === true,
    name: cleanString(value.name, 64) || DEFAULT_CONTROL_SURFACE_STATE.name,
    template: validTemplate(value.template) ? value.template : "custom",
    panelLayout: validPanelLayout(value.panelLayout) ? value.panelLayout : inferredPanelLayout,
    stage: validStage(value.stage) ? value.stage : "design",
    theme: keyboardThemeIsValid(value.theme) ? value.theme : DEFAULT_CONTROL_SURFACE_STATE.theme,
    controls: reconciledControls,
    selectedControlId: selected?.id ?? "",
    selectedChannelId,
    nextId: Math.max(
      1,
      Math.min(Number.MAX_SAFE_INTEGER, Math.max(Math.trunc(rawNext), highestGeneratedId + 1)),
    ),
  };
}

function emptyStore(): ControlSurfaceStore {
  return { version: CONTROL_SURFACE_STORE_VERSION, devices: {}, migratedWorkbench: {} };
}

export function sanitizeControlSurfaceStore(value: unknown): ControlSurfaceStore {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return emptyStore();
    }
  }
  if (
    !isRecord(candidate) ||
    (candidate.version !== 1 && candidate.version !== CONTROL_SURFACE_STORE_VERSION)
  ) return emptyStore();
  const devices: Record<string, ControlSurfaceState> = {};
  if (isRecord(candidate.devices)) {
    for (const [rawIdentity, rawState] of Object.entries(candidate.devices)) {
      const identity = canonicalDevice(rawIdentity);
      if (FORBIDDEN_RECORD_KEYS.has(identity) || devices[identity]) continue;
      devices[identity] = sanitizeControlSurfaceState(rawState);
      if (Object.keys(devices).length >= MAX_DEVICE_IDENTITIES) break;
    }
  }
  const migratedWorkbench: Record<string, true> = {};
  if (isRecord(candidate.migratedWorkbench)) {
    for (const [rawIdentity, migrated] of Object.entries(candidate.migratedWorkbench)) {
      const identity = canonicalDevice(rawIdentity);
      if (migrated === true && !FORBIDDEN_RECORD_KEYS.has(identity)) migratedWorkbench[identity] = true;
      if (Object.keys(migratedWorkbench).length >= MAX_DEVICE_IDENTITIES) break;
    }
  }
  return { version: CONTROL_SURFACE_STORE_VERSION, devices, migratedWorkbench };
}

export function controlSurfaceStateForDevice(
  store: ControlSurfaceStore,
  deviceIdentity: unknown,
  theme: KeyboardThemeSlug = DEFAULT_CONTROL_SURFACE_STATE.theme,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceStore(store);
  const identity = canonicalDevice(deviceIdentity);
  const found = safe.devices[identity];
  return found
    ? cloneControlSurfaceState(found)
    : { ...cloneControlSurfaceState(DEFAULT_CONTROL_SURFACE_STATE), theme };
}

export function withControlSurfaceState(
  store: ControlSurfaceStore,
  deviceIdentity: unknown,
  state: ControlSurfaceState,
): ControlSurfaceStore {
  const safe = sanitizeControlSurfaceStore(store);
  const identity = canonicalDevice(deviceIdentity);
  const devices = { ...safe.devices };
  delete devices[identity];
  while (Object.keys(devices).length >= MAX_DEVICE_IDENTITIES) {
    delete devices[Object.keys(devices)[0]];
  }
  devices[identity] = sanitizeControlSurfaceState(state);
  return { ...safe, devices };
}

export function controlSurfaceWorkbenchMigrated(
  store: ControlSurfaceStore,
  deviceIdentity: unknown,
): boolean {
  const safe = sanitizeControlSurfaceStore(store);
  return safe.migratedWorkbench[canonicalDevice(deviceIdentity)] === true;
}

export function withControlSurfaceWorkbenchMigrated(
  store: ControlSurfaceStore,
  deviceIdentity: unknown,
): ControlSurfaceStore {
  const safe = sanitizeControlSurfaceStore(store);
  const identity = canonicalDevice(deviceIdentity);
  const migratedWorkbench = { ...safe.migratedWorkbench, [identity]: true as const };
  while (Object.keys(migratedWorkbench).length > MAX_DEVICE_IDENTITIES) {
    delete migratedWorkbench[Object.keys(migratedWorkbench)[0]];
  }
  return { ...safe, migratedWorkbench };
}

function sizeForKind(kind: ControlSurfaceControlKind): { width: number; height: number } {
  if (kind === "button24") return { width: 58, height: 58 };
  if (kind === "button30") return { width: 74, height: 74 };
  if (kind === "joystick") return { width: 168, height: 168 };
  return { width: 88, height: 64 };
}

function defaultLabel(kind: ControlSurfaceControlKind): string {
  if (kind === "button24") return "Aux";
  if (kind === "button30") return "Button";
  if (kind === "joystick") return "Stick";
  return "Key";
}

function channelsForKind(kind: ControlSurfaceControlKind): ControlSurfaceChannel[] {
  const labels = kind === "joystick"
    ? [["up", "Up"], ["right", "Right"], ["down", "Down"], ["left", "Left"]]
    : [["press", "Press"]];
  return labels.map(([id, label]) => ({ id, label, input: { ...EMPTY_INPUT } }));
}

interface BuildContext {
  controls: ControlSurfaceControl[];
  nextId: number;
}

function appendControl(
  context: BuildContext,
  kind: ControlSurfaceControlKind,
  label: string,
  x: number,
  y: number,
  options: {
    playerSlot?: number | null;
    origin?: ControlSurfaceOrigin;
    physicalId?: string;
    physicalResolution?: ControlSurfacePhysicalResolution;
    width?: number;
    height?: number;
    inputKey?: string;
    device?: string;
  } = {},
): ControlSurfaceControl {
  const id = `c${context.nextId++}`;
  const size = sizeForKind(kind);
  const channels = channelsForKind(kind);
  if (options.inputKey && channels[0]) {
    channels[0].input = { kind: "keyboard", key: options.inputKey, device: options.device ?? "" };
  }
  const control = cleanControl({
    id,
    physicalId: options.physicalId ?? `physical:${id}`,
    physicalResolution: options.physicalResolution ?? "confirmed",
    kind,
    label,
    playerSlot: options.playerSlot ?? null,
    origin: options.origin ?? "template",
    x,
    y,
    width: options.width ?? size.width,
    height: options.height ?? size.height,
    channels,
  }, context.controls.length);
  if (!control) throw new Error("control surface template emitted an invalid component");
  context.controls.push(control);
  return control;
}

function arcadeStickTemplate(context: BuildContext): void {
  appendControl(context, "joystick", "Player stick", 110, 230);
  const labels = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"];
  labels.forEach((label, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    appendControl(context, "button30", label, 565 + column * 112, 190 + row * 104 + column * 8);
  });
  appendControl(context, "button24", "Coin", 405, 565);
  appendControl(context, "button24", "Start", 492, 565);
}

function leverlessTemplate(context: BuildContext): void {
  [
    ["Left", 105, 330],
    ["Down", 200, 350],
    ["Right", 295, 330],
    ["Up", 235, 470],
  ].forEach(([label, x, y]) => appendControl(context, "button30", String(label), Number(x), Number(y)));
  ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"].forEach((label, index) => {
    const row = Math.floor(index / 4);
    const column = index % 4;
    appendControl(context, "button30", label, 570 + column * 110, 250 + row * 102 + column * 7);
  });
  appendControl(context, "button24", "Select", 448, 580);
  appendControl(context, "button24", "Start", 530, 580);
}

function fourPlayerTemplate(context: BuildContext): void {
  for (let slot = 1; slot <= 4; slot += 1) {
    const column = (slot - 1) % 2;
    const row = Math.floor((slot - 1) / 2);
    const originX = 26 + column * 590;
    const originY = 28 + row * 342;
    appendControl(context, "joystick", `P${slot} stick`, originX + 34, originY + 72, { playerSlot: slot });
    for (let button = 0; button < 6; button += 1) {
      const buttonRow = Math.floor(button / 3);
      const buttonColumn = button % 3;
      appendControl(
        context,
        "button30",
        `P${slot} B${button + 1}`,
        originX + 292 + buttonColumn * 82,
        originY + 74 + buttonRow * 82 + buttonColumn * 5,
        { playerSlot: slot },
      );
    }
    appendControl(context, "button24", `P${slot} Start`, originX + 246, originY + 254, { playerSlot: slot });
    appendControl(context, "button24", `P${slot} Coin`, originX + 318, originY + 254, { playerSlot: slot });
  }
}

function compactFourPlayerGrid(
  count: number,
  slot: number,
): {
  kind: "button24" | "button30";
  positions: readonly { x: number; y: number }[];
} {
  if (count <= 0) return { kind: "button24", positions: [] };
  // Each player owns one 590 x 342 quadrant. Twelve or fewer controls can
  // keep the full 30 mm treatment; denser controller vocabularies use 24 mm
  // caps and an adaptive grid. At the complete 25-function vocabulary this
  // becomes a 5 x 5 matrix with four pixels of vertical breathing room, so
  // neither a neighbour nor the next player's quadrant is crossed.
  const kind = count <= 12 ? "button30" as const : "button24" as const;
  const size = sizeForKind(kind);
  const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(count * 1.25))));
  const rows = Math.ceil(count / columns);
  const panelColumn = (slot - 1) % 2;
  const panelRow = Math.floor((slot - 1) / 2);
  const region = {
    x: 28 + panelColumn * 590,
    y: 30 + panelRow * 342,
    width: 548,
    height: 314,
  };
  const gapX = columns === 1
    ? 0
    : Math.min(104, (region.width - size.width) / (columns - 1));
  const gapY = rows === 1
    ? 0
    : Math.min(106, (region.height - size.height) / (rows - 1));
  const gridWidth = size.width + gapX * (columns - 1);
  const gridHeight = size.height + gapY * (rows - 1);
  const startX = region.x + (region.width - gridWidth) / 2;
  const startY = region.y + (region.height - gridHeight) / 2;
  return {
    kind,
    positions: Array.from({ length: count }, (_, index) => ({
      x: round(startX + (index % columns) * gapX),
      y: round(startY + Math.floor(index / columns) * gapY),
    })),
  };
}

function mappingTemplate(
  context: BuildContext,
  records: readonly ControlSurfaceMappingRecord[],
  selectedSlot: number,
  fourPlayers: boolean,
  device: string,
): void {
  const eligible = records.filter((record) =>
    fourPlayers ? record.slot >= 1 && record.slot <= 4 : record.slot === selectedSlot
  );
  const grouped = new Map<string, ControlSurfaceMappingRecord[]>();
  for (const record of eligible) {
    const group = `${record.slot}\u0000${record.key}`;
    const bucket = grouped.get(group) ?? [];
    bucket.push(record);
    grouped.set(group, bucket);
  }
  const groups = [...grouped.values()].sort((a, b) =>
    a[0].slot - b[0].slot || a[0].key.localeCompare(b[0].key)
  );
  const keyAppearances = new Map<string, number>();
  for (const group of groups) {
    const key = group[0].key;
    keyAppearances.set(key, (keyAppearances.get(key) ?? 0) + 1);
  }
  const slots = fourPlayers ? [1, 2, 3, 4] : [selectedSlot];
  for (const slot of slots) {
    const slotGroups = groups.filter((group) => group[0].slot === slot);
    const compact = fourPlayers ? compactFourPlayerGrid(slotGroups.length, slot) : null;
    const columns = 8;
    slotGroups.forEach((group, index) => {
      const record = group[0];
      const controlNames = [...new Set(group.map((item) => item.controlLabel || item.functionName))];
      const label = controlNames.join(" · ") || record.key;
      const position = compact?.positions[index] ?? {
        x: 70 + (index % columns) * 128,
        y: 145 + Math.floor(index / columns) * 112,
      };
      appendControl(
        context,
        compact?.kind ?? "button30",
        label,
        position.x,
        position.y,
        {
          playerSlot: fourPlayers ? record.slot : null,
          origin: "mapping-generated",
          // Equal host signals do not prove equal hardware. Keep every
          // generated control physically distinct until the user identifies
          // a mirror or confirms separate switches; the shared key still
          // groups them for a truthful unresolved relationship in the UI.
          physicalResolution: (keyAppearances.get(record.key) ?? 0) > 1
            ? "unresolved-shared-signal"
            : "confirmed",
          inputKey: record.key,
          device,
        },
      );
    });
  }
}

export function applyControlSurfaceTemplate(
  state: ControlSurfaceState,
  template: ControlSurfaceTemplate,
  records: readonly ControlSurfaceMappingRecord[] = [],
  selectedSlot = 1,
  device = "",
): ControlSurfaceState {
  if (template === "mapping-selected" || template === "mapping-four") {
    const generated = new Set(
      records
        .filter((record) => template === "mapping-four"
          ? record.slot >= 1 && record.slot <= 4
          : record.slot === selectedSlot)
        .map((record) => `${record.slot}\u0000${record.key}`),
    ).size;
    if (generated > CONTROL_SURFACE_MAX_CONTROLS) return sanitizeControlSurfaceState(state);
  }
  const context: BuildContext = { controls: [], nextId: 1 };
  if (template === "arcade-stick") arcadeStickTemplate(context);
  else if (template === "leverless") leverlessTemplate(context);
  else if (template === "four-player") fourPlayerTemplate(context);
  else if (template === "mapping-selected") {
    mappingTemplate(context, records, selectedSlot, false, device);
  } else if (template === "mapping-four") {
    mappingTemplate(context, records, selectedSlot, true, device);
  }
  const first = context.controls[0];
  return sanitizeControlSurfaceState({
    ...state,
    open: true,
    started: true,
    template,
    panelLayout: template === "four-player" || template === "mapping-four"
      ? "four-player"
      : "single",
    stage: template.startsWith("mapping-") ? "route" : "design",
    controls: context.controls,
    selectedControlId: first?.id ?? "",
    selectedChannelId: first?.channels[0]?.id ?? "",
    nextId: context.nextId,
  });
}

export function addControlSurfaceControl(
  state: ControlSurfaceState,
  kind: ControlSurfaceControlKind,
  playerSlot: number | null = null,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  if (safe.controls.length >= CONTROL_SURFACE_MAX_CONTROLS) return safe;
  const context: BuildContext = { controls: [...safe.controls], nextId: safe.nextId };
  const index = context.controls.length;
  const size = sizeForKind(kind);
  const ownedSlot = playerSlot !== null && playerSlot >= 1 && playerSlot <= 4
    ? playerSlot
    : null;
  const ownedIndex = ownedSlot === null
    ? index
    : context.controls.filter((control) => control.playerSlot === ownedSlot).length;
  const quadrantX = ownedSlot !== null && ownedSlot % 2 === 0 ? 600 : 0;
  const quadrantY = ownedSlot !== null && ownedSlot > 2 ? 360 : 0;
  const cellWidth = ownedSlot === null ? 112 : 108;
  const cellHeight = ownedSlot === null ? 112 : 104;
  const columns = ownedSlot === null ? 8 : 5;
  const originX = ownedSlot === null ? 72 : quadrantX + 24;
  const originY = ownedSlot === null ? 96 : quadrantY + 22;
  const control = appendControl(
    context,
    kind,
    defaultLabel(kind),
    originX + (ownedIndex % columns) * cellWidth + Math.max(0, (cellWidth - size.width) / 2),
    originY + (Math.floor(ownedIndex / columns) % 3) * cellHeight + Math.max(0, (cellHeight - size.height) / 2),
    { playerSlot, origin: "manual", width: size.width, height: size.height },
  );
  return sanitizeControlSurfaceState({
    ...safe,
    started: true,
    template: "custom",
    stage: "design",
    controls: context.controls,
    selectedControlId: control.id,
    selectedChannelId: control.channels[0]?.id ?? "",
    nextId: context.nextId,
  });
}

export function selectControlSurfaceControl(
  state: ControlSurfaceState,
  controlId: string,
  channelId = "",
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const control = safe.controls.find((item) => item.id === controlId);
  if (!control) return { ...safe, selectedControlId: "", selectedChannelId: "" };
  const channel = control.channels.find((item) => item.id === channelId) ?? control.channels[0];
  return { ...safe, selectedControlId: control.id, selectedChannelId: channel?.id ?? "" };
}

export function renameControlSurfaceControl(
  state: ControlSurfaceState,
  controlId: string,
  labelValue: unknown,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const label = cleanString(labelValue, 64);
  if (!label || !safe.controls.some((control) => control.id === controlId)) return safe;
  return sanitizeControlSurfaceState({
    ...safe,
    template: safe.template === "workbench-migration" ? safe.template : "custom",
    controls: safe.controls.map((control) =>
      control.id === controlId ? { ...control, label } : control
    ),
  });
}

export function setControlSurfacePlayerSlot(
  state: ControlSurfaceState,
  controlId: string,
  playerSlot: number | null,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  if (!safe.controls.some((control) => control.id === controlId)) return safe;
  const slot = typeof playerSlot === "number" && Number.isInteger(playerSlot) &&
      playerSlot >= 1 && playerSlot <= 4
    ? playerSlot
    : null;
  return sanitizeControlSurfaceState({
    ...safe,
    template: safe.template === "workbench-migration" ? safe.template : "custom",
    controls: safe.controls.map((control) =>
      control.id === controlId ? { ...control, playerSlot: slot } : control
    ),
  });
}

export function setControlSurfacePanelLayout(
  state: ControlSurfaceState,
  panelLayout: ControlSurfacePanelLayout,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  return validPanelLayout(panelLayout)
    ? { ...safe, template: "custom", panelLayout }
    : safe;
}

export function setControlSurfaceStage(
  state: ControlSurfaceState,
  stage: ControlSurfaceStage,
): ControlSurfaceState {
  return { ...sanitizeControlSurfaceState(state), stage };
}

export function moveControlSurfaceControl(
  state: ControlSurfaceState,
  controlId: string,
  x: number,
  y: number,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  return {
    ...safe,
    template: safe.template === "workbench-migration" ? safe.template : "custom",
    controls: safe.controls.map((control) =>
      control.id === controlId
        ? {
            ...control,
            x: round(clamp(x, 0, CONTROL_SURFACE_BOUNDS.width - control.width)),
            y: round(clamp(y, 0, CONTROL_SURFACE_BOUNDS.height - control.height)),
          }
        : control
    ),
  };
}

export function removeControlSurfaceControl(
  state: ControlSurfaceState,
  controlId: string,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const controls = safe.controls.filter((control) => control.id !== controlId);
  const selected = controls[0];
  return sanitizeControlSurfaceState({
    ...safe,
    template: "custom",
    controls,
    selectedControlId: selected?.id ?? "",
    selectedChannelId: selected?.channels[0]?.id ?? "",
  });
}

export function copyControlSurfaceControl(
  state: ControlSurfaceState,
  controlId: string,
  mode: "duplicate" | "mirror",
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const source = safe.controls.find((control) => control.id === controlId);
  if (
    !source ||
    source.physicalResolution === "unresolved-shared-signal" ||
    safe.controls.length >= CONTROL_SURFACE_MAX_CONTROLS
  ) return safe;
  const id = `c${safe.nextId}`;
  const control: ControlSurfaceControl = {
    ...source,
    id,
    physicalId: mode === "mirror" ? source.physicalId : `physical:${id}`,
    // An explicit copy choice resolves only the relationship the author just
    // declared. Mapping imports remain ambiguous until a human says whether
    // a view is the same switch or another physical switch with one signal.
    physicalResolution: "confirmed",
    origin: "manual",
    x: clamp(source.x + 28, 0, CONTROL_SURFACE_BOUNDS.width - source.width),
    y: clamp(source.y + 28, 0, CONTROL_SURFACE_BOUNDS.height - source.height),
    channels: source.channels.map((channel) => ({
      ...channel,
      input: { ...channel.input },
      // A duplicate is a different physical switch and therefore starts with
      // no claimed terminal. A mirror is another view of the same switch.
      encoder: mode === "mirror" && channel.encoder ? { ...channel.encoder } : undefined,
    })),
  };
  return sanitizeControlSurfaceState({
    ...safe,
    template: "custom",
    controls: [
      ...safe.controls.map((candidate) =>
        mode === "mirror" && candidate.physicalId === source.physicalId
          ? { ...candidate, physicalResolution: "confirmed" as const }
          : candidate
      ),
      control,
    ],
    selectedControlId: id,
    selectedChannelId: control.channels[0]?.id ?? "",
    nextId: safe.nextId + 1,
  });
}

export function resolveControlSurfaceSharedSignal(
  state: ControlSurfaceState,
  controlId: string,
  channelId: string,
  resolution: "mirror" | "duplicate",
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const selected = safe.controls.find((control) => control.id === controlId);
  const channel = selected?.channels.find((candidate) => candidate.id === channelId) ??
    selected?.channels[0];
  if (!selected || !channel || channel.input.kind !== "keyboard") return safe;
  const key = channel.input.key;
  const peers = safe.controls.filter((control) =>
    control.physicalResolution === "unresolved-shared-signal" &&
    control.channels.some(
      (candidate) => candidate.input.kind === "keyboard" && candidate.input.key === key,
    )
  );
  if (peers.length < 2) return safe;
  const peerIds = new Set(peers.map((control) => control.id));
  const physicalId = selected.physicalId;
  return sanitizeControlSurfaceState({
    ...safe,
    template: "custom",
    controls: safe.controls.map((control) =>
      peerIds.has(control.id)
        ? {
            ...control,
            physicalId: resolution === "mirror" ? physicalId : `physical:${control.id}`,
            physicalResolution: "confirmed" as const,
            channels: resolution === "mirror"
              ? control.channels.map((candidate) =>
                  candidate.input.kind === "keyboard" && candidate.input.key === key
                    ? { ...candidate, input: { ...channel.input } }
                    : candidate
                )
              : control.channels,
          }
        : control
    ),
  });
}

export function teachControlSurfaceChannel(
  state: ControlSurfaceState,
  controlId: string,
  channelId: string,
  keyValue: unknown,
  deviceValue: unknown,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const key = cleanString(keyValue);
  if (!key) return safe;
  const device = cleanString(deviceValue, 240);
  const selected = safe.controls.find((control) => control.id === controlId);
  if (!selected || !selected.channels.some((channel) => channel.id === channelId)) return safe;
  // Teaching a physical control updates every mirror of that switch. A
  // duplicate has its own physicalId, so it remains independently teachable.
  const controls = safe.controls.map((control) =>
    control.physicalId === selected.physicalId
      ? {
          ...control,
          channels: control.channels.map((channel) =>
            channel.id === channelId
              ? {
                  ...channel,
                  input: { kind: "keyboard" as const, key, device },
                  encoder: channel.encoder
                    ? {
                        ...channel.encoder,
                        verification: channel.encoder.expectedKey === key ? "matched" as const : "mismatch" as const,
                      }
                    : undefined,
                }
              : channel
          ),
        }
      : control
  );
  return sanitizeControlSurfaceState({
    ...safe,
    controls,
    selectedControlId: controlId,
    selectedChannelId: channelId,
  });
}

/** Attach a backend-decoded encoder terminal to one physical channel.
 * Mirrors share the assignment through `physicalId`; duplicates do not. The
 * observed input remains untouched until Teach proves what Windows receives. */
export function assignControlSurfaceTerminal(
  state: ControlSurfaceState,
  controlId: string,
  channelId: string,
  assignment: Omit<ControlSurfaceEncoderAssignment, "verification"> | null,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  const selected = safe.controls.find((control) => control.id === controlId);
  if (!selected || !selected.channels.some((channel) => channel.id === channelId)) return safe;
  const controls = safe.controls.map((control) =>
    control.physicalId === selected.physicalId
      ? {
          ...control,
          channels: control.channels.map((channel) =>
            channel.id === channelId
              ? {
                  ...channel,
                  encoder: assignment
                    ? {
                        ...assignment,
                        verification: channel.input.kind === "keyboard"
                          ? channel.input.key === assignment.expectedKey ? "matched" as const : "mismatch" as const
                          : "unverified" as const,
                      }
                    : undefined,
                }
              : channel
          ),
        }
      : control
  );
  return sanitizeControlSurfaceState({
    ...safe,
    controls,
    selectedControlId: controlId,
    selectedChannelId: channelId,
  });
}

/** A successful hardware write changes the expectation, not the observation.
 * Mark every assignment for that board unverified until Teach walks it. */
export function invalidateControlSurfaceEncoderVerification(
  state: ControlSurfaceState,
  boardFingerprint: string,
): ControlSurfaceState {
  const safe = sanitizeControlSurfaceState(state);
  return sanitizeControlSurfaceState({
    ...safe,
    controls: safe.controls.map((control) => ({
      ...control,
      channels: control.channels.map((channel) =>
        channel.encoder?.boardFingerprint === boardFingerprint
          ? { ...channel, encoder: { ...channel.encoder, verification: "unverified" as const } }
          : channel
      ),
    })),
  });
}

export function migrateKeyboardWorkbenchSurface(
  state: ControlSurfaceState,
  placed: readonly KeyboardWorkbenchPlacedKey[],
  renderMode: KeyboardWorkbenchRenderMode,
  device: string,
): ControlSurfaceState {
  if (
    state.started ||
    placed.length === 0 ||
    placed.length > CONTROL_SURFACE_MAX_CONTROLS
  ) return sanitizeControlSurfaceState(state);
  const context: BuildContext = { controls: [], nextId: 1 };
  for (const record of placed) {
    appendControl(
      context,
      renderMode === "arcade" ? "button30" : "keycap",
      record.controlLabel || record.cap || record.key,
      record.x,
      record.y,
      {
        playerSlot: record.playerSlot,
        origin: "workbench-migration",
        physicalId: `key:${record.key}`,
        width: record.width,
        height: record.height,
        inputKey: record.key,
        device,
      },
    );
  }
  const first = context.controls[0];
  const migratedSlots = new Set(
    context.controls
      .map((control) => control.playerSlot)
      .filter((slot): slot is number => slot !== null),
  );
  return sanitizeControlSurfaceState({
    ...state,
    open: true,
    started: true,
    name: "Migrated control surface",
    template: "workbench-migration",
    panelLayout: migratedSlots.size > 1 ? "four-player" : "single",
    stage: "route",
    controls: context.controls,
    selectedControlId: first?.id ?? "",
    selectedChannelId: first?.channels[0]?.id ?? "",
    nextId: context.nextId,
  });
}

/** Stable public vocabulary for start cards and tests. */
export const CONTROL_SURFACE_TEMPLATES = [
  { slug: "blank", label: "Blank / custom", note: "Start with an empty metal panel." },
  { slug: "arcade-stick", label: "Arcade stick", note: "Lever, eight actions, Start and Coin." },
  { slug: "leverless", label: "Leverless", note: "Four directions and an eight-button action bank." },
  { slug: "four-player", label: "Four-player cabinet", note: "Four independent sticks, action banks, Start and Coin." },
  { slug: "mapping-selected", label: "Current player", note: "Generate physical controls from this player's existing routes." },
  { slug: "mapping-four", label: "All four players", note: "Generate four panels and flag repeated signals for physical confirmation." },
] as const satisfies readonly {
  slug: ControlSurfaceTemplate;
  label: string;
  note: string;
}[];

// Keep the imported theme vocabulary live in this pure module: a surface
// can inherit every app-owned keyboard finish, but no arbitrary persisted
// CSS token crosses the storage boundary.
export const CONTROL_SURFACE_THEME_SLUGS = KEYBOARD_THEME_SLUGS;
