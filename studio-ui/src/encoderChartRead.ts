/**
 * Read-only encoder chart contract used by the redesign profile lab.
 *
 * The server deliberately accepts only `{ selector }` and forces
 * `backup: false`. Keeping this browser module equally narrow prevents a
 * visual inspection surface from quietly growing a programming verb.
 */

export interface EncoderChartKeyValue {
  code: number;
  key?: string | null;
  label: string;
  supported: boolean;
}

export interface EncoderChartTerminal {
  terminal_id: string;
  terminal_label: string;
  player: number;
  kind: string;
  normal: EncoderChartKeyValue;
  shifted: EncoderChartKeyValue;
  shift_state: string;
  is_shift: boolean;
  press_resolves: boolean;
}

export type EncoderChartShift =
  | { state: "unreadable" }
  | { state: "enabled"; terminal_id: string; terminal_label: string; reachable: number }
  | { state: "none-enabled"; stranded: number; opaque: number }
  | { state: "ambiguous"; terminal_ids: string[] };

export interface EncoderChartOutcome {
  ok: boolean;
  board_name?: string;
  image_sha256?: string;
  terminals?: EncoderChartTerminal[];
  shift?: EncoderChartShift;
  notes?: string[];
  error?: string;
  remedy?: string;
}

export interface EncoderChartSnapshot {
  boardName: string;
  imageSha256: string;
  readAt: string;
  terminals: readonly EncoderChartTerminal[];
  shift?: EncoderChartShift;
  notes: readonly string[];
}

export type EncoderChartRequestResult =
  | { kind: "answered"; outcome: EncoderChartOutcome }
  | { kind: "refused" | "unavailable"; message: string };

export type EncoderChartValidation =
  | { ok: true; snapshot: EncoderChartSnapshot }
  | { ok: false; message: string };

export const ENCODER_CHART_REQUEST_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function isKeyValue(value: unknown): value is EncoderChartKeyValue {
  if (!isRecord(value)) return false;
  return isIntegerInRange(value.code, 0xFFFF) &&
    (value.key === undefined || value.key === null || typeof value.key === "string") &&
    typeof value.label === "string" && typeof value.supported === "boolean";
}

function isTerminal(value: unknown): value is EncoderChartTerminal {
  if (!isRecord(value)) return false;
  return typeof value.terminal_id === "string" && value.terminal_id.trim().length > 0 &&
    typeof value.terminal_label === "string" && isIntegerInRange(value.player, 0xFF) &&
    typeof value.kind === "string" && isKeyValue(value.normal) && isKeyValue(value.shifted) &&
    (value.shift_state === "disabled" || value.shift_state === "enabled" ||
      value.shift_state === "opaque") &&
    typeof value.is_shift === "boolean" && value.is_shift === (value.shift_state === "enabled") &&
    typeof value.press_resolves === "boolean";
}

function isShift(value: unknown): value is EncoderChartShift {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  switch (value.state) {
    case "unreadable": return true;
    case "enabled":
      return typeof value.terminal_id === "string" && typeof value.terminal_label === "string" &&
        isIntegerInRange(value.reachable, Number.MAX_SAFE_INTEGER);
    case "none-enabled":
      return isIntegerInRange(value.stranded, Number.MAX_SAFE_INTEGER) &&
        isIntegerInRange(value.opaque, Number.MAX_SAFE_INTEGER);
    case "ambiguous":
      return Array.isArray(value.terminal_ids) && value.terminal_ids.every((id) => typeof id === "string");
    default: return false;
  }
}

function shiftMatchesRoster(
  shift: EncoderChartShift | undefined,
  terminals: readonly EncoderChartTerminal[],
  terminalIds: ReadonlySet<string>,
): boolean {
  if (!shift) return false;
  const rowById = new Map(terminals.map((terminal) => [terminal.terminal_id, terminal]));
  const enabledRows = terminals.filter((terminal) => terminal.is_shift);
  switch (shift.state) {
    case "unreadable": return terminals.length === 0 && enabledRows.length === 0;
    case "enabled": {
      const row = rowById.get(shift.terminal_id);
      return enabledRows.length === 1 && enabledRows[0]?.terminal_id === shift.terminal_id &&
        terminalIds.has(shift.terminal_id) && row?.is_shift === true &&
        row.terminal_label === shift.terminal_label &&
        shift.reachable <= terminals.length;
    }
    case "none-enabled":
      return terminals.every((terminal) => !terminal.is_shift) &&
        shift.stranded <= terminals.length && shift.opaque <= terminals.length;
    case "ambiguous": {
      const unique = new Set(shift.terminal_ids);
      return shift.terminal_ids.length >= 2 && unique.size === shift.terminal_ids.length &&
        enabledRows.length === unique.size &&
        enabledRows.every((row) => unique.has(row.terminal_id)) &&
        shift.terminal_ids.every((id) => terminalIds.has(id) && rowById.get(id)?.is_shift === true);
    }
  }
}

function parseOutcome(value: unknown): EncoderChartOutcome | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    return {
      ok: false,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(typeof value.remedy === "string" ? { remedy: value.remedy } : {}),
    };
  }
  if (typeof value.board_name !== "string" || typeof value.image_sha256 !== "string" ||
      !Array.isArray(value.terminals) || !value.terminals.every(isTerminal)) return null;
  if (value.shift !== undefined && !isShift(value.shift)) return null;
  if (value.notes !== undefined &&
      (!Array.isArray(value.notes) || !value.notes.every((note) => typeof note === "string"))) return null;
  return {
    ok: true,
    board_name: value.board_name,
    image_sha256: value.image_sha256,
    terminals: value.terminals,
    ...(value.shift !== undefined ? { shift: value.shift } : {}),
    ...(value.notes !== undefined ? { notes: value.notes } : {}),
  };
}

/** One explicit hardware transaction. Calling this function is the only place
 * the redesign encoder surface may reach the chart route. */
export async function requestEncoderChart(
  selector: string,
  fetcher: typeof fetch = fetch,
): Promise<EncoderChartRequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENCODER_CHART_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher("/api/panel/chart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { kind: "unavailable", message: "KSX did not answer. Nothing on the board was changed." };
    }
    const outcome = parseOutcome(await response.json());
    if (!outcome) {
      return { kind: "unavailable", message: "KSX returned an invalid chart. Nothing on the board was changed." };
    }
    if (!outcome.ok) {
      const message = [outcome.error, outcome.remedy].filter(Boolean).join(" ");
      return {
        kind: "refused",
        message: message || "That board's chart could not be read. Nothing on the board was changed.",
      };
    }
    return { kind: "answered", outcome };
  } catch {
    return {
      kind: "unavailable",
      message: controller.signal.aborted
        ? "KSX chart read timed out. Nothing on the board was changed."
        : "KSX did not answer. Nothing on the board was changed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Bind a response to the drawing that requested it. A count match is not
 * enough: every stable terminal id must match exactly once before any emission
 * is painted onto the board.
 */
export function validateEncoderChart(
  outcome: EncoderChartOutcome,
  expectedTerminalIds: readonly string[],
  readAt = new Date().toISOString(),
): EncoderChartValidation {
  const terminals = outcome.terminals ?? [];
  const boardName = outcome.board_name?.trim() ?? "";
  const imageSha256 = outcome.image_sha256?.trim().toLocaleLowerCase() ?? "";
  const expected = new Set(expectedTerminalIds);
  const received = new Set(terminals.map((terminal) => terminal.terminal_id));
  const rosterMatches = expected.size === expectedTerminalIds.length &&
    received.size === terminals.length && terminals.length === expectedTerminalIds.length &&
    expectedTerminalIds.every((id) => received.has(id));
  const semanticsMatch = terminals.every(isTerminal) &&
    outcome.shift !== undefined && isShift(outcome.shift) &&
    shiftMatchesRoster(outcome.shift, terminals, expected);

  if (!outcome.ok || !boardName || !/^[0-9a-f]{64}$/.test(imageSha256) ||
      !rosterMatches || !semanticsMatch) {
    return {
      ok: false,
      message: "The read did not match this exact terminal profile, so KSX withheld it. Nothing on the board was changed.",
    };
  }
  return {
    ok: true,
    snapshot: {
      boardName,
      imageSha256,
      readAt,
      terminals,
      ...(outcome.shift ? { shift: outcome.shift } : {}),
      notes: (outcome.notes ?? []).filter(Boolean),
    },
  };
}

export function encoderChartTerminalMap(
  snapshot: EncoderChartSnapshot | null | undefined,
): ReadonlyMap<string, EncoderChartTerminal> {
  return new Map((snapshot?.terminals ?? []).map((terminal) => [terminal.terminal_id, terminal]));
}

/** A zero byte is intentionally not called “unassigned”: onboard macros and an
 * empty assignment are byte-identical in the measured PAC256 image. */
export function encoderEmissionLabel(value: EncoderChartKeyValue): string {
  const key = value.key?.trim();
  if (key) return key;
  if (value.supported && value.code === 0) return "Nothing stored — or a macro, which looks the same";
  return value.label || `Preserved byte 0x${value.code.toString(16).padStart(2, "0").toUpperCase()}`;
}

export function encoderEmissionShortLabel(value: EncoderChartKeyValue): string {
  const key = value.key?.trim();
  if (key) {
    const arrows: Record<string, string> = {
      ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    };
    if (arrows[key]) return arrows[key];
    const compact = key.replace(/^Key/, "").replace(/^Digit/, "");
    return compact.length <= 5 ? compact : `${compact.slice(0, 4)}…`;
  }
  if (value.supported && value.code === 0) return "0/M";
  return `#${value.code.toString(16).padStart(2, "0").toUpperCase()}`;
}

export function encoderChartShiftSentence(shift: EncoderChartShift | undefined): string {
  switch (shift?.state) {
    case "enabled":
      return `${shift.terminal_label || shift.terminal_id} is the Shift key; ${shift.reachable} shifted ` +
        `value${shift.reachable === 1 ? " is" : "s are"} reachable.`;
    case "none-enabled":
      return "No decoded terminal claims Shift, so shifted values are unreachable" +
        (shift.opaque ? `; ${shift.opaque} opaque shift byte${shift.opaque === 1 ? " remains" : "s remain"}.` : ".");
    case "ambiguous":
      return `Multiple terminals claim Shift (${shift.terminal_ids.join(", ")}); KSX cannot say which the board honours.`;
    default:
      return "The board-level Shift state was not readable.";
  }
}
