/**
 * Thin client for the daemon-owned simultaneous-input diagnostic.
 *
 * These verbs observe host-visible signals from one exact selector. They do
 * not identify physical terminals, infer wiring, or write a mapping.
 */

export const ENCODER_OBSERVATION_DURATION_MS = 30_000;
export const ENCODER_OBSERVATION_POLL_MS = 120;
export const ENCODER_OBSERVATION_REQUEST_TIMEOUT_MS = 5_000;

export type EncoderObservationBackendState =
  | "idle"
  | "listening"
  | "timeout"
  | "cancelled"
  | "failed"
  | "unavailable"
  | "unknown";

export interface EncoderObservationView {
  ok: boolean;
  state: EncoderObservationBackendState;
  generation: number | null;
  selector: string | null;
  remaining_ms: number | null;
  held: readonly string[];
  seen: readonly string[];
  peak: number;
  events: number;
  dropped: number;
  rollover_visibility: string;
  detail: string;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 512 ||
      !value.every((row) => typeof row === "string" && row.trim().length > 0 && row.length <= 256)) {
    return null;
  }
  return new Set(value).size === value.length ? value : null;
}

function backendState(value: unknown): EncoderObservationBackendState {
  switch (value) {
    case "idle":
    case "listening":
    case "timeout":
    case "cancelled":
    case "failed":
    case "unavailable": return value;
    default: return "unknown";
  }
}

export function parseEncoderObservationView(value: unknown): EncoderObservationView | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  const generation = numberOrNull(value.generation);
  const remaining = numberOrNull(value.remaining_ms);
  const held = stringArray(value.held);
  const seen = stringArray(value.seen);
  if (generation === undefined || remaining === undefined || !held || !seen ||
      !Number.isSafeInteger(value.peak) || Number(value.peak) < 0 ||
      !Number.isSafeInteger(value.events) || Number(value.events) < 0 ||
      !Number.isSafeInteger(value.dropped) || Number(value.dropped) < 0 ||
      typeof value.rollover_visibility !== "string" || typeof value.detail !== "string" ||
      (value.selector !== null && typeof value.selector !== "string") ||
      (value.error !== null && typeof value.error !== "string")) return null;
  const seenSet = new Set(seen);
  if (!held.every((signal) => seenSet.has(signal))) return null;
  return {
    ok: value.ok,
    state: backendState(value.state),
    generation,
    selector: value.selector,
    remaining_ms: remaining,
    held,
    seen,
    peak: Number(value.peak),
    events: Number(value.events),
    dropped: Number(value.dropped),
    rollover_visibility: value.rollover_visibility,
    detail: value.detail,
    error: value.error,
  };
}

async function observationJSON(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  fetcher: typeof fetch = fetch,
  keepalive = false,
): Promise<EncoderObservationView> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENCODER_OBSERVATION_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method,
      headers: method === "POST"
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      cache: "no-store",
      keepalive,
      signal: controller.signal,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const view = parseEncoderObservationView(await response.json().catch(() => null));
    if (!response.ok || !view) {
      throw new Error(view?.error || "KSX did not return a valid signal observation.");
    }
    return view;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("KSX signal observation timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function startEncoderObservation(
  selector: string,
  fetcher: typeof fetch = fetch,
): Promise<EncoderObservationView> {
  return observationJSON("/api/input-test/start", "POST", {
    selector,
    duration_ms: ENCODER_OBSERVATION_DURATION_MS,
  }, fetcher);
}

export function pollEncoderObservation(fetcher: typeof fetch = fetch): Promise<EncoderObservationView> {
  return observationJSON("/api/input-test", "GET", undefined, fetcher);
}

export function cancelEncoderObservation(
  generation: number,
  fetcher: typeof fetch = fetch,
  keepalive = false,
): Promise<EncoderObservationView> {
  return observationJSON("/api/input-test/cancel", "POST", { generation }, fetcher, keepalive);
}

export function observationBelongsTo(
  view: EncoderObservationView,
  selector: string,
  generation?: number,
): boolean {
  return view.selector === selector && view.generation !== null &&
    (generation === undefined || view.generation === generation);
}
