/**
 * Pure keyboard-workbench data and layout helpers.
 *
 * Coordinates use an app-owned 900 x 300 logical board. The visual layer may
 * scale that board responsively, but persisted positions remain independent of
 * pixels, DOM measurements, or any third-party keyboard artwork.
 */

export const KEYBOARD_THEME_SLUGS = [
  "carbon-forge",
  "lunar-shell",
  "violet-circuit",
  "glacier-current",
  "ghost-mint",
  "retro-terminal",
] as const;

export type KeyboardThemeSlug = (typeof KEYBOARD_THEME_SLUGS)[number];

export interface KeyboardThemeDescriptor {
  slug: KeyboardThemeSlug;
  label: string;
  description: string;
  swatch: string;
  tone: "dark" | "light";
}

export const KEYBOARD_THEMES: readonly KeyboardThemeDescriptor[] = [
  {
    slug: "carbon-forge",
    label: "Carbon Forge",
    description: "Graphite case with deep charcoal sculpted caps.",
    swatch: "#303447",
    tone: "dark",
  },
  {
    slug: "lunar-shell",
    label: "Lunar Shell",
    description: "Cool silver chassis with soft white keycaps.",
    swatch: "#d9dde5",
    tone: "light",
  },
  {
    slug: "violet-circuit",
    label: "Violet Circuit",
    description: "Near-black case with restrained violet key tones.",
    swatch: "#6f62ad",
    tone: "dark",
  },
  {
    slug: "glacier-current",
    label: "Glacier Current",
    description: "Navy hardware with crisp ice-blue caps.",
    swatch: "#7fc4dc",
    tone: "dark",
  },
  {
    slug: "ghost-mint",
    label: "Ghost Mint",
    description: "Pale mineral case with a quiet mint key field.",
    swatch: "#a9d4c2",
    tone: "light",
  },
  {
    slug: "retro-terminal",
    label: "Retro Terminal",
    description: "Warm computer beige with classic two-tone caps.",
    swatch: "#c4ad82",
    tone: "light",
  },
];

export type KeyboardWorkbenchLayoutMode = "compact" | "leverless" | "free";
export type KeyboardWorkbenchRenderMode = "keycap" | "arcade";

export interface KeyboardWorkbenchPosition {
  x: number;
  y: number;
}

export interface KeyboardWorkbenchState {
  open: boolean;
  theme: KeyboardThemeSlug;
  selectedKeys: string[];
  layoutMode: KeyboardWorkbenchLayoutMode;
  renderMode: KeyboardWorkbenchRenderMode;
  positions: Record<string, KeyboardWorkbenchPosition>;
}

export interface KeyboardWorkbenchStore {
  version: typeof KEYBOARD_WORKBENCH_STORE_VERSION;
  devices: Record<string, KeyboardWorkbenchState>;
}

export interface KeyboardWorkbenchRecord {
  key: string;
  cls: string;
  cap: string;
  short: string;
  aria: string;
}

export interface KeyboardWorkbenchPlacedKey extends KeyboardWorkbenchRecord {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const KEYBOARD_WORKBENCH_STORAGE_KEY = "ksx-nocturne-keyboard-workbench1";
export const KEYBOARD_WORKBENCH_STORE_VERSION = 1 as const;
export const KEYBOARD_WORKBENCH_BOUNDS = { width: 900, height: 300 } as const;

const MAX_DEVICE_IDENTITIES = 64;
const MAX_SELECTED_KEYS = 128;
const MAX_KEY_LENGTH = 96;
const MAX_DEVICE_IDENTITY_LENGTH = 240;
const DEFAULT_DEVICE_IDENTITY = "keyboard:default";
const FORBIDDEN_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const DEFAULT_KEYBOARD_WORKBENCH_STATE: KeyboardWorkbenchState = {
  open: false,
  theme: "carbon-forge",
  selectedKeys: [],
  layoutMode: "compact",
  renderMode: "keycap",
  positions: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanPosition(value: unknown): KeyboardWorkbenchPosition | null {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: roundCoordinate(clamp(x, 0, KEYBOARD_WORKBENCH_BOUNDS.width)),
    y: roundCoordinate(clamp(y, 0, KEYBOARD_WORKBENCH_BOUNDS.height)),
  };
}

function emptyStore(): KeyboardWorkbenchStore {
  return { version: KEYBOARD_WORKBENCH_STORE_VERSION, devices: {} };
}

export function keyboardThemeIsValid(value: unknown): value is KeyboardThemeSlug {
  return typeof value === "string" && KEYBOARD_THEME_SLUGS.includes(value as KeyboardThemeSlug);
}

export function keyboardWorkbenchLayoutModeIsValid(
  value: unknown,
): value is KeyboardWorkbenchLayoutMode {
  return value === "compact" || value === "leverless" || value === "free";
}

export function keyboardWorkbenchRenderModeIsValid(
  value: unknown,
): value is KeyboardWorkbenchRenderMode {
  return value === "keycap" || value === "arcade";
}

/** Preserve the server's canonical KSX key spelling while removing unsafe persistence noise. */
export function canonicalKeyboardWorkbenchKey(value: unknown): string {
  return cleanString(value, MAX_KEY_LENGTH);
}

/** Produce a stable, bounded map key for one physical keyboard identity. */
export function canonicalKeyboardDeviceIdentity(value: unknown): string {
  const identity = cleanString(value, MAX_DEVICE_IDENTITY_LENGTH);
  if (!identity || FORBIDDEN_RECORD_KEYS.has(identity)) return DEFAULT_DEVICE_IDENTITY;
  return identity;
}

export function cloneKeyboardWorkbenchState(
  state: KeyboardWorkbenchState,
): KeyboardWorkbenchState {
  const positions: Record<string, KeyboardWorkbenchPosition> = {};
  for (const [key, position] of Object.entries(state.positions)) {
    positions[key] = { x: position.x, y: position.y };
  }
  return {
    open: state.open,
    theme: state.theme,
    selectedKeys: [...state.selectedKeys],
    layoutMode: state.layoutMode,
    renderMode: state.renderMode,
    positions,
  };
}

export function sanitizeKeyboardWorkbenchState(raw: unknown): KeyboardWorkbenchState {
  if (!isRecord(raw)) return cloneKeyboardWorkbenchState(DEFAULT_KEYBOARD_WORKBENCH_STATE);

  const selectedKeys: string[] = [];
  const selected = new Set<string>();
  if (Array.isArray(raw.selectedKeys)) {
    for (const candidate of raw.selectedKeys) {
      const key = canonicalKeyboardWorkbenchKey(candidate);
      if (!key || selected.has(key)) continue;
      selected.add(key);
      selectedKeys.push(key);
      if (selectedKeys.length >= MAX_SELECTED_KEYS) break;
    }
  }

  const positions: Record<string, KeyboardWorkbenchPosition> = {};
  if (isRecord(raw.positions)) {
    let count = 0;
    for (const [candidate, value] of Object.entries(raw.positions)) {
      const key = canonicalKeyboardWorkbenchKey(candidate);
      const position = cleanPosition(value);
      if (!key || FORBIDDEN_RECORD_KEYS.has(key) || !position || positions[key]) continue;
      positions[key] = position;
      count += 1;
      if (count >= MAX_SELECTED_KEYS) break;
    }
  }

  return {
    open: raw.open === true,
    theme: keyboardThemeIsValid(raw.theme) ? raw.theme : DEFAULT_KEYBOARD_WORKBENCH_STATE.theme,
    selectedKeys,
    layoutMode: keyboardWorkbenchLayoutModeIsValid(raw.layoutMode)
      ? raw.layoutMode
      : DEFAULT_KEYBOARD_WORKBENCH_STATE.layoutMode,
    renderMode: keyboardWorkbenchRenderModeIsValid(raw.renderMode)
      ? raw.renderMode
      : DEFAULT_KEYBOARD_WORKBENCH_STATE.renderMode,
    positions,
  };
}

/**
 * Sanitize a parsed payload or the JSON text read by a caller. Unknown store
 * versions deliberately reset instead of being interpreted as the current model.
 */
export function sanitizeKeyboardWorkbenchStore(raw: unknown): KeyboardWorkbenchStore {
  let candidate = raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return emptyStore();
    }
  }
  if (!isRecord(candidate) || candidate.version !== KEYBOARD_WORKBENCH_STORE_VERSION) {
    return emptyStore();
  }
  if (!isRecord(candidate.devices)) return emptyStore();

  const devices: Record<string, KeyboardWorkbenchState> = {};
  let count = 0;
  for (const [rawIdentity, rawState] of Object.entries(candidate.devices)) {
    const identity = canonicalKeyboardDeviceIdentity(rawIdentity);
    if (FORBIDDEN_RECORD_KEYS.has(identity) || devices[identity]) continue;
    devices[identity] = sanitizeKeyboardWorkbenchState(rawState);
    count += 1;
    if (count >= MAX_DEVICE_IDENTITIES) break;
  }
  return { version: KEYBOARD_WORKBENCH_STORE_VERSION, devices };
}

export function keyboardWorkbenchStateForDevice(
  store: KeyboardWorkbenchStore,
  deviceIdentity: unknown,
): KeyboardWorkbenchState {
  const safeStore = sanitizeKeyboardWorkbenchStore(store);
  const identity = canonicalKeyboardDeviceIdentity(deviceIdentity);
  return cloneKeyboardWorkbenchState(
    safeStore.devices[identity] ?? DEFAULT_KEYBOARD_WORKBENCH_STATE,
  );
}

export function withKeyboardWorkbenchState(
  store: KeyboardWorkbenchStore,
  deviceIdentity: unknown,
  state: KeyboardWorkbenchState,
): KeyboardWorkbenchStore {
  const safeStore = sanitizeKeyboardWorkbenchStore(store);
  const identity = canonicalKeyboardDeviceIdentity(deviceIdentity);
  // Updating an existing device moves it to the newest end of insertion
  // order. A genuinely new 65th device evicts the oldest entry first, so the
  // state the caller just wrote can never be the one sanitization drops.
  const devices = { ...safeStore.devices };
  delete devices[identity];
  const overflow = Object.keys(devices).length - (MAX_DEVICE_IDENTITIES - 1);
  if (overflow > 0) {
    for (const oldest of Object.keys(devices).slice(0, overflow)) delete devices[oldest];
  }
  devices[identity] = sanitizeKeyboardWorkbenchState(state);
  return {
    version: KEYBOARD_WORKBENCH_STORE_VERSION,
    devices,
  };
}

export function withKeyboardWorkbenchPosition(
  state: KeyboardWorkbenchState,
  keyValue: unknown,
  positionValue: unknown,
): KeyboardWorkbenchState {
  const safeState = sanitizeKeyboardWorkbenchState(state);
  const key = canonicalKeyboardWorkbenchKey(keyValue);
  const position = cleanPosition(positionValue);
  if (!key || FORBIDDEN_RECORD_KEYS.has(key) || !position) return safeState;
  return { ...safeState, positions: { ...safeState.positions, [key]: position } };
}

interface SizedKey extends KeyboardWorkbenchRecord {
  width: number;
  height: number;
}

interface PackedKey extends SizedKey {
  x: number;
  y: number;
}

function keycapUnits(cls: string): number {
  const match = cls.match(/(?:^|\s)u(\d+)(?:_(\d+))?(?:\s|$)/);
  if (!match) return 1;
  const whole = Number(match[1]);
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  const units = whole + fraction;
  return Number.isFinite(units) ? clamp(units, 1, 3.25) : 1;
}

function sizeKey(
  record: KeyboardWorkbenchRecord,
  renderMode: KeyboardWorkbenchRenderMode,
  scale: number,
): SizedKey {
  const baseHeight = renderMode === "arcade" ? 60 : 58;
  const baseWidth =
    renderMode === "arcade" ? 60 : 58 + (keycapUnits(record.cls) - 1) * 42;
  return {
    ...record,
    width: roundCoordinate(baseWidth * scale),
    height: roundCoordinate(baseHeight * scale),
  };
}

function packAtScale(
  records: readonly KeyboardWorkbenchRecord[],
  renderMode: KeyboardWorkbenchRenderMode,
  scale: number,
  originX: number,
  originY: number,
  regionWidth: number,
  regionHeight: number,
): { keys: PackedKey[]; fits: boolean } {
  const gap = roundCoordinate(12 * scale);
  const sized = records.map((record) => sizeKey(record, renderMode, scale));
  const rows: SizedKey[][] = [];
  let row: SizedKey[] = [];
  let rowWidth = 0;
  for (const key of sized) {
    const nextWidth = row.length === 0 ? key.width : rowWidth + gap + key.width;
    if (row.length > 0 && nextWidth > regionWidth) {
      rows.push(row);
      row = [key];
      rowWidth = key.width;
    } else {
      row.push(key);
      rowWidth = nextWidth;
    }
  }
  if (row.length > 0) rows.push(row);

  const rowHeight = sized.reduce((maximum, key) => Math.max(maximum, key.height), 0);
  const contentHeight = rows.length * rowHeight + Math.max(0, rows.length - 1) * gap;
  const keys: PackedKey[] = [];
  let y = originY + Math.max(0, (regionHeight - contentHeight) / 2);
  for (const packedRow of rows) {
    const contentWidth =
      packedRow.reduce((sum, key) => sum + key.width, 0) +
      Math.max(0, packedRow.length - 1) * gap;
    let x = originX + Math.max(0, (regionWidth - contentWidth) / 2);
    for (const key of packedRow) {
      keys.push({ ...key, x: roundCoordinate(x), y: roundCoordinate(y) });
      x += key.width + gap;
    }
    y += rowHeight + gap;
  }
  const widestKey = sized.reduce((maximum, key) => Math.max(maximum, key.width), 0);
  return {
    keys,
    fits: widestKey <= regionWidth && contentHeight <= regionHeight,
  };
}

function compactLayout(
  records: readonly KeyboardWorkbenchRecord[],
  renderMode: KeyboardWorkbenchRenderMode,
  originX = 18,
  originY = 18,
  regionWidth = KEYBOARD_WORKBENCH_BOUNDS.width - 36,
  regionHeight = KEYBOARD_WORKBENCH_BOUNDS.height - 36,
): PackedKey[] {
  let packed = packAtScale(
    records,
    renderMode,
    1,
    originX,
    originY,
    regionWidth,
    regionHeight,
  );
  for (let scale = 0.95; !packed.fits && scale >= 0.5; scale -= 0.05) {
    packed = packAtScale(
      records,
      renderMode,
      scale,
      originX,
      originY,
      regionWidth,
      regionHeight,
    );
  }
  return packed.keys;
}

type MovementRole = "left" | "down" | "right" | "up";

const MOVEMENT_CANDIDATES: Record<MovementRole, readonly string[]> = {
  left: ["A", "Left"],
  down: ["S", "Down"],
  right: ["D", "Right"],
  up: ["W", "Up"],
};

const MOVEMENT_CENTERS: Record<MovementRole, KeyboardWorkbenchPosition> = {
  left: { x: 65, y: 145 },
  down: { x: 139, y: 145 },
  right: { x: 213, y: 145 },
  up: { x: 287, y: 205 },
};

function leverlessLayout(
  records: readonly KeyboardWorkbenchRecord[],
  renderMode: KeyboardWorkbenchRenderMode,
): PackedKey[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const movement = new Map<MovementRole, KeyboardWorkbenchRecord>();
  const claimed = new Set<string>();
  for (const role of Object.keys(MOVEMENT_CANDIDATES) as MovementRole[]) {
    const record = MOVEMENT_CANDIDATES[role]
      .map((candidate) => byKey.get(candidate))
      .find((candidate): candidate is KeyboardWorkbenchRecord => Boolean(candidate));
    if (record) {
      movement.set(role, record);
      claimed.add(record.key);
    }
  }

  if (movement.size === 0 && records.length >= 4) {
    const roles: MovementRole[] = ["left", "down", "right", "up"];
    roles.forEach((role, index) => {
      const record = records[index];
      movement.set(role, record);
      claimed.add(record.key);
    });
  }

  const placed: PackedKey[] = [];
  for (const [role, record] of movement) {
    const sized = sizeKey(record, renderMode, 1);
    // Movement controls are one generic leverless token apiece. In
    // particular, the arbitrary four-key fallback must not carry a Space or
    // Shift cap's source width into centers designed for adjacent controls.
    const key = { ...sized, width: renderMode === "arcade" ? 60 : 58 };
    const center = MOVEMENT_CENTERS[role];
    placed.push({
      ...key,
      x: roundCoordinate(center.x - key.width / 2),
      y: roundCoordinate(center.y - key.height / 2),
    });
  }

  const actions = records.filter((record) => !claimed.has(record.key));
  placed.push(...compactLayout(actions, renderMode, 380, 28, 502, 244));
  return placed;
}

function clampPlacedKey(key: PackedKey): KeyboardWorkbenchPlacedKey {
  return {
    ...key,
    x: roundCoordinate(clamp(key.x, 0, KEYBOARD_WORKBENCH_BOUNDS.width - key.width)),
    y: roundCoordinate(clamp(key.y, 0, KEYBOARD_WORKBENCH_BOUNDS.height - key.height)),
  };
}

function cleanRecords(
  records: readonly KeyboardWorkbenchRecord[],
): Map<string, KeyboardWorkbenchRecord> {
  const clean = new Map<string, KeyboardWorkbenchRecord>();
  for (const record of records) {
    const key = canonicalKeyboardWorkbenchKey(record.key);
    if (!key || clean.has(key)) continue;
    clean.set(key, {
      key,
      cls: cleanString(record.cls, 512),
      cap: cleanString(record.cap, 64),
      short: cleanString(record.short, 64),
      aria: cleanString(record.aria, 512),
    });
  }
  return clean;
}

/**
 * Place the state's selected keys on the 900 x 300 logical workbench.
 * Compact and leverless modes are deterministic. Free mode consumes the
 * sanitized per-key positions and uses compact placement as its fallback.
 */
export function layoutKeyboardWorkbenchKeys(
  records: readonly KeyboardWorkbenchRecord[],
  state: KeyboardWorkbenchState,
): KeyboardWorkbenchPlacedKey[] {
  const safeState = sanitizeKeyboardWorkbenchState(state);
  const byKey = cleanRecords(records);
  const selected = safeState.selectedKeys
    .map((key) => byKey.get(key))
    .filter((record): record is KeyboardWorkbenchRecord => Boolean(record));
  if (selected.length === 0) return [];

  const compact = compactLayout(selected, safeState.renderMode);
  let placed: PackedKey[];
  if (safeState.layoutMode === "leverless") {
    placed = leverlessLayout(selected, safeState.renderMode);
  } else if (safeState.layoutMode === "free") {
    placed = compact.map((key) => {
      const custom = safeState.positions[key.key];
      return custom ? { ...key, x: custom.x, y: custom.y } : key;
    });
  } else {
    placed = compact;
  }

  return placed.map(clampPlacedKey);
}
