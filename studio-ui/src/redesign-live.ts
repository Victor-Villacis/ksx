// /redesign live input feedback.
//
// This is deliberately a small imperative client, not Forma state. The daemon
// can publish close to 60 frames per second; rebuilding the keyboard,
// controller cards, and mapping graph at that cadence would turn feedback into
// a second renderer. The durable product state still arrives through
// /api/redesign. This module only borrows that state as a short-lived license
// to decorate the current DOM.

export interface RedesignLiveSlotFrame {
  slot: number;
  down: string[];
  hit: string[];
  lt: number;
  rt: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

export interface RedesignLiveKeyFrame {
  key: string;
  device: string;
  alias: string;
  down: boolean;
}

export interface RedesignLiveFrame {
  running: boolean;
  slots: RedesignLiveSlotFrame[];
  keys: RedesignLiveKeyFrame[];
  dropped: number;
  off_panel: number;
}

export interface RedesignLiveEnvelope {
  frame: RedesignLiveFrame;
  unavailable?: string | null;
  /** Optional forward-compatible correlation facts. Current daemons do not
   * emit these; when they do, a mismatch is an immediate fail-closed boundary. */
  session_id?: string | null;
  revision?: string | null;
}

/** The structure payload's authority over live paint. `structureRevision`
 * should fingerprint the staged controllers/mappings that the canvas drew.
 * When the backend can disclose the revision the active session actually
 * started from, `runtimeRevision` makes correlation exact. Otherwise the
 * client latches the structure revision at the stopped -> running boundary;
 * a later staged edit revokes paint until a successful Apply (or a successful
 * Restart Play that replaces an already-running session) explicitly calls
 * `acceptCurrentRevision`. */
export interface RedesignLiveSession {
  reachable: boolean;
  running: boolean;
  origin: string;
  profile?: string | null;
  elapsed?: string | null;
  sessionId?: string | null;
  structureRevision?: string | null;
  runtimeRevision?: string | null;
}

export interface RedesignLiveEventSource {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  close(): void;
}

export type RedesignLivePathSetter = (
  keysDown: ReadonlySet<string>,
  keyHits: ReadonlySet<string>,
  slotFunctionsDown: ReadonlyMap<number, ReadonlySet<string>>,
  slotFunctionHits: ReadonlyMap<number, ReadonlySet<string>>,
) => void;

export interface RedesignLiveHost {
  /** Re-read, never capture: Forma reconciliation and canvas mounting replace
   * descendants while this page-lived client remains alive. */
  root(): HTMLElement | null;
  selectedSlot(): string | number;
  setPathLive: RedesignLivePathSetter;
  /** The workbench owns one shared polite status region. This module only
   * announces state transitions, never clocks, counters, or individual keys. */
  announce(message: string): void;
  eventSource?: (url: string) => RedesignLiveEventSource;
}

export interface RedesignLiveFeedback {
  /** Open exactly one page-lived EventSource. Repeated calls are no-ops. */
  connect(): void;
  /** Confirm or revoke the live paint license from a freshly served payload. */
  reconcileSession(session: RedesignLiveSession | null | undefined): void;
  /** Advance the client-side running revision only after Apply/Restart Play's
   * authoritative success response and refreshed payload. Never call
   * optimistically. */
  acceptCurrentRevision(): void;
  /** Call after a structural repaint/mount so the next frame recaches targets. */
  invalidateTargets(): void;
  /** Close the stream and permanently clear transient paint. */
  dispose(): void;
}

type LiveState =
  | "connecting"
  | "waiting"
  | "active"
  | "degraded"
  | "inactive"
  | "foreign"
  | "stale"
  | "offline"
  | "reconnecting"
  | "unreadable";

interface FunctionTarget {
  element: HTMLElement;
  functions: string[];
  slot: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_MAP: ReadonlyMap<number, ReadonlySet<string>> =
  new Map<number, ReadonlySet<string>>();

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizedFunction(value: string): string {
  return value.trim().toLowerCase();
}

function finiteCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Refusals originate below the presentation boundary and can contain pipe
 * names, paths, or commands. Convert them to a stable customer action before
 * anything reaches visible status or the assistive live region. */
export function redesignLiveCustomerReason(reason: string | null | undefined): string {
  const lower = trimmed(reason).toLowerCase();
  if (!lower) return "Live input is temporarily unavailable.";
  if (lower.includes("daemon") || lower.includes("control channel") || lower.includes("pipe")) {
    return "Live input is offline. Reopen ksx and try again.";
  }
  if (lower.includes("no session") || lower.includes("not running") || lower.includes("nothing is running")) {
    return "Live input starts after you press Play.";
  }
  return "Live input is temporarily unavailable. Reopen ksx and try again.";
}

function eventMessage(event: Event): string {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return "";
  try {
    const refusal = JSON.parse(event.data) as { message?: unknown; remedy?: unknown };
    if (typeof refusal.message === "string" && refusal.message.trim()) return refusal.message;
    if (typeof refusal.remedy === "string" && refusal.remedy.trim()) return refusal.remedy;
  } catch {
    // Customer-safe fallback below. Raw event text never crosses the boundary.
  }
  return "";
}

export function createRedesignLiveFeedback(host: RedesignLiveHost): RedesignLiveFeedback {
  let source: RedesignLiveEventSource | null = null;
  let disposed = false;
  let pagehideWired = false;
  let confirmed = false;
  let transport: "idle" | "connecting" | "open" | "reconnecting" = "idle";
  let license: RedesignLiveSession | null = null;
  let inferredRuntimeRevision = "";
  let sessionIdentity = "no-session";
  let acceptedFingerprint: string | null = null;
  let state: LiveState | null = null;
  let announcedState: LiveState | null = null;
  let events = 0;
  let dropped = 0;
  let offPanel = 0;
  let keyTargets: HTMLElement[] | null = null;
  let functionTargets: FunctionTarget[] | null = null;
  const keysDown = new Set<string>();
  const selectedFunctions = new Set<string>();
  const slotFunctionsDown = new Map<number, ReadonlySet<string>>();
  const slotFunctionHits = new Map<number, ReadonlySet<string>>();
  const ticker: string[] = [];

  const root = (): HTMLElement | null => host.root();

  function fingerprint(session: RedesignLiveSession | null): string {
    if (!session) return "no-session";
    return JSON.stringify([
      session.reachable,
      session.running,
      trimmed(session.origin).toLowerCase(),
      trimmed(session.profile),
      trimmed(session.sessionId),
      trimmed(session.structureRevision),
      trimmed(session.runtimeRevision) || inferredRuntimeRevision,
    ]);
  }

  function identity(session: RedesignLiveSession | null): string {
    if (!session) return "no-session";
    return JSON.stringify([
      session.reachable,
      session.running,
      trimmed(session.origin).toLowerCase(),
      trimmed(session.profile),
      trimmed(session.sessionId),
    ]);
  }

  function revisionsAgree(session: RedesignLiveSession): boolean {
    const structure = trimmed(session.structureRevision);
    const runtime = trimmed(session.runtimeRevision) || inferredRuntimeRevision;
    // No revision claim is the legacy SessionView contract. It is still
    // origin-gated, and every session fingerprint transition resets paint.
    if (!structure && !runtime) return true;
    return Boolean(structure && runtime && structure === runtime);
  }

  function licensed(): boolean {
    return Boolean(
      confirmed &&
      license?.reachable &&
      license.running &&
      trimmed(license.origin).toLowerCase() === "staged" &&
      revisionsAgree(license),
    );
  }

  function statusElement(scope: HTMLElement): HTMLElement | null {
    return scope.querySelector<HTMLElement>("[data-rd-live-status], .rd-live-status");
  }

  function statsElement(scope: HTMLElement): HTMLElement | null {
    return scope.querySelector<HTMLElement>("[data-rd-live-stats], .n-livestats");
  }

  function tickerElement(scope: HTMLElement): HTMLElement | null {
    return scope.querySelector<HTMLElement>("[data-rd-live-ticker], .n-ticker");
  }

  function setState(next: LiveState, text: string, announce = false): void {
    const scope = root();
    if (scope) {
      scope.dataset.rdLiveState = next;
      const status = statusElement(scope);
      if (status) {
        status.textContent = text;
        status.hidden = text.trim() === "";
      }
      scope.querySelector<HTMLElement>(".n-canvas")?.classList.toggle(
        "live",
        next === "active" || next === "degraded",
      );
    }
    state = next;
    if (announce && announcedState !== next) {
      announcedState = next;
      host.announce(text);
    }
  }

  function setPathEmpty(): void {
    host.setPathLive(EMPTY_SET, EMPTY_SET, EMPTY_MAP, EMPTY_MAP);
  }

  function clearPaint(): void {
    const scope = root();
    if (scope) {
      for (const element of Array.from(
        scope.querySelectorAll<HTMLElement>("[data-key].live, [data-fn].live"),
      )) {
        element.classList.remove("live");
      }
      scope.querySelector<HTMLElement>(".n-canvas")?.classList.remove("live");
      const stats = statsElement(scope);
      if (stats) {
        stats.textContent = "";
        stats.setAttribute("aria-hidden", "true");
      }
      const tickerNode = tickerElement(scope);
      if (tickerNode) {
        tickerNode.textContent = "";
        tickerNode.setAttribute("aria-hidden", "true");
      }
    }
    setPathEmpty();
  }

  function resetLedger(): void {
    acceptedFingerprint = null;
    events = 0;
    dropped = 0;
    offPanel = 0;
    keysDown.clear();
    selectedFunctions.clear();
    slotFunctionsDown.clear();
    slotFunctionHits.clear();
    ticker.length = 0;
    clearPaint();
  }

  function invalidate(next: LiveState, text: string, announce = false): void {
    confirmed = false;
    resetLedger();
    setState(next, text, announce);
  }

  function ensureTargets(scope: HTMLElement): void {
    if (keyTargets === null) {
      keyTargets = Array.from(scope.querySelectorAll<HTMLElement>("[data-key]"));
    }
    if (functionTargets === null) {
      functionTargets = Array.from(scope.querySelectorAll<HTMLElement>("[data-fn]")).map(
        (element) => ({
          element,
          functions: (element.dataset.fn ?? "")
            .split(/\s+/)
            .map(normalizedFunction)
            .filter(Boolean),
          slot: Number(
            element.closest<HTMLElement>("[data-pad-slot]")?.dataset.padSlot ?? "0",
          ),
        }),
      );
    }
  }

  function frameCorrelates(envelope: RedesignLiveEnvelope): boolean {
    if (!license) return false;
    const expectedSession = trimmed(license.sessionId);
    const frameSession = trimmed(envelope.session_id);
    if ((expectedSession || frameSession) && expectedSession !== frameSession) return false;
    const expectedRevision = trimmed(license.runtimeRevision || license.structureRevision);
    const frameRevision = trimmed(envelope.revision);
    if (frameRevision && expectedRevision !== frameRevision) return false;
    return true;
  }

  function paint(envelope: RedesignLiveEnvelope): void {
    if (disposed) return;
    if (!envelope?.frame || typeof envelope.frame.running !== "boolean") {
      throw new Error("unreadable live envelope");
    }
    if (trimmed(envelope.unavailable)) {
      invalidate("offline", redesignLiveCustomerReason(envelope.unavailable), true);
      return;
    }
    if (envelope.frame.running !== true) {
      invalidate("inactive", "Live input is inactive.", true);
      return;
    }
    if (!licensed()) return;
    if (!frameCorrelates(envelope)) {
      invalidate(
        "stale",
        "Live input changed sessions. Waiting for the canvas to confirm the current setup.",
        true,
      );
      return;
    }
    const scope = root();
    if (!scope) return;

    const currentFingerprint = fingerprint(license);
    if (acceptedFingerprint !== currentFingerprint) {
      resetLedger();
      acceptedFingerprint = currentFingerprint;
    }

    slotFunctionsDown.clear();
    slotFunctionHits.clear();
    const slotFunctions = new Map<number, ReadonlySet<string>>();
    for (const slotFrame of Array.isArray(envelope.frame.slots) ? envelope.frame.slots : []) {
      if (!Number.isSafeInteger(slotFrame.slot) || slotFrame.slot < 1) continue;
      const downSet = new Set(
        (Array.isArray(slotFrame.down) ? slotFrame.down : [])
          .map(normalizedFunction)
          .filter(Boolean),
      );
      const hitSet = new Set(
        (Array.isArray(slotFrame.hit) ? slotFrame.hit : [])
          .map(normalizedFunction)
          .filter(Boolean),
      );
      slotFunctionsDown.set(slotFrame.slot, downSet);
      slotFunctionHits.set(slotFrame.slot, hitSet);
      slotFunctions.set(slotFrame.slot, new Set([...downSet, ...hitSet]));
    }

    const selected = Number(host.selectedSlot());
    const selectedFrame = slotFunctions.get(selected) ?? slotFunctions.values().next().value ?? EMPTY_SET;
    selectedFunctions.clear();
    for (const control of selectedFrame) selectedFunctions.add(control);

    const frameDropped = finiteCounter(envelope.frame.dropped);
    // A transition gap may contain a key release. The controller `down`
    // arrays are authoritative snapshots; physical keys are transitions, so
    // only their ledger fails closed and rebuilds from this frame.
    if (frameDropped > 0) keysDown.clear();
    const keyHits = new Set<string>();
    for (const keyFrame of Array.isArray(envelope.frame.keys) ? envelope.frame.keys : []) {
      const key = trimmed(keyFrame.key);
      if (!key) continue;
      if (keyFrame.down === true) {
        keysDown.add(key);
        keyHits.add(key);
      } else {
        keysDown.delete(key);
      }
      events += 1;
      ticker.push(`${key}${keyFrame.down === true ? "↓" : "↑"}`);
      if (ticker.length > 10) ticker.shift();
    }
    dropped += frameDropped;
    offPanel += finiteCounter(envelope.frame.off_panel);

    ensureTargets(scope);
    for (const element of keyTargets ?? []) {
      const key = element.dataset.key ?? "";
      element.classList.toggle("live", keysDown.has(key) || keyHits.has(key));
    }
    for (const target of functionTargets ?? []) {
      const controls = target.slot > 0
        ? slotFunctions.get(target.slot) ?? EMPTY_SET
        : selectedFunctions;
      target.element.classList.toggle(
        "live",
        target.functions.some((control) => controls.has(control)),
      );
    }
    host.setPathLive(keysDown, keyHits, slotFunctionsDown, slotFunctionHits);

    const stats = statsElement(scope);
    if (stats) {
      const parts = ["Live"];
      const elapsed = trimmed(license?.elapsed);
      if (elapsed) parts.push(elapsed);
      parts.push(`${events} event${events === 1 ? "" : "s"}`);
      parts.push("60 Hz");
      if (dropped > 0) parts.push(`${dropped} frame${dropped === 1 ? "" : "s"} dropped`);
      if (offPanel > 0) parts.push(`${offPanel} off-panel`);
      stats.textContent = parts.join(" · ");
      stats.setAttribute("aria-hidden", "true");
    }
    const tickerNode = tickerElement(scope);
    if (tickerNode) {
      tickerNode.textContent = ticker.join("  ");
      tickerNode.setAttribute("aria-hidden", "true");
    }

    if (dropped > 0) {
      setState(
        "degraded",
        "Live feedback has a gap. Repeat the input before relying on this trace.",
        true,
      );
    } else {
      setState("active", "Live input is active.", true);
    }
  }

  function reconcileSession(session: RedesignLiveSession | null | undefined): void {
    if (disposed) return;
    const next = session ?? null;
    const before = fingerprint(license);
    const nextIdentity = identity(next);
    if (nextIdentity !== sessionIdentity) {
      inferredRuntimeRevision = "";
      sessionIdentity = nextIdentity;
    }
    const disclosedRuntime = trimmed(next?.runtimeRevision);
    const stagedRevision = trimmed(next?.structureRevision);
    if (disclosedRuntime) {
      inferredRuntimeRevision = disclosedRuntime;
    } else if (
      next?.reachable &&
      next.running &&
      trimmed(next.origin).toLowerCase() === "staged" &&
      stagedRevision &&
      !inferredRuntimeRevision
    ) {
      // Best available boundary on the current protocol: the first served
      // running/staged payload is the setup Play started from. Keep that
      // revision pinned while subsequent staged edits arrive.
      inferredRuntimeRevision = stagedRevision;
    }
    license = next;
    const changed = fingerprint(next) !== before;
    if (changed) resetLedger();
    confirmed = true;

    if (!next?.reachable) {
      resetLedger();
      setState("offline", "Live input is offline. Reopen ksx and try again.", changed);
      return;
    }
    if (!next.running) {
      resetLedger();
      setState("inactive", "Live input starts after you press Play.", changed);
      return;
    }
    if (trimmed(next.origin).toLowerCase() !== "staged") {
      resetLedger();
      setState(
        "foreign",
        "Live feedback is unavailable because Play is using a different setup.",
        changed,
      );
      return;
    }
    if (!revisionsAgree(next)) {
      resetLedger();
      setState(
        "stale",
        "Apply the current staged changes before using live feedback.",
        changed,
      );
      return;
    }
    if (transport !== "open") {
      resetLedger();
      if (transport === "reconnecting") {
        setState("reconnecting", "Reconnecting to live input…", changed);
      } else {
        setState("connecting", "Connecting to live input…", changed);
      }
      return;
    }
    if (acceptedFingerprint === null || state !== "active" && state !== "degraded") {
      setState("waiting", "Live input is connected and waiting for activity.");
    }
  }

  function acceptCurrentRevision(): void {
    if (disposed || !license || !confirmed) return;
    const revision = trimmed(license.structureRevision);
    if (
      !revision ||
      !license.reachable ||
      !license.running ||
      trimmed(license.origin).toLowerCase() !== "staged"
    ) return;
    inferredRuntimeRevision = revision;
    resetLedger();
    if (transport === "open") {
      setState("waiting", "Live input is connected and waiting for activity.");
    } else if (transport === "reconnecting") {
      setState("reconnecting", "Reconnecting to live input…");
    } else {
      setState("connecting", "Connecting to live input…");
    }
  }

  function invalidateTargets(): void {
    keyTargets = null;
    functionTargets = null;
  }

  function connect(): void {
    if (disposed || source !== null) return;
    // The structure payload is deliberately reconciled before the stream is
    // opened on production pages. Do not let transport setup overwrite its
    // stronger foreign/stale/offline/inactive conclusion.
    transport = "connecting";
    if (!confirmed || licensed()) setState("connecting", "Connecting to live input…");
    const makeSource = host.eventSource ?? ((url: string) => new EventSource(url));
    try {
      source = makeSource("/api/live");
    } catch {
      invalidate("offline", "Live input is unavailable in this browser.", true);
      return;
    }
    source.addEventListener("open", () => {
      if (disposed) return;
      transport = "open";
      if (confirmed) {
        if (licensed() && state !== "active" && state !== "degraded" && state !== "waiting") {
          setState("waiting", "Live input is connected and waiting for activity.");
        }
      } else if (state === "connecting" || state === "reconnecting") {
        setState("inactive", "Live input is connected. Press Play when you are ready.");
      }
    });
    source.addEventListener("frame", (event) => {
      try {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") throw new Error();
        // A message can only arrive over an open stream. Treat it as the same
        // transport proof as `open` so test doubles and unusual EventSource
        // implementations cannot leave a real frame labeled Connecting.
        transport = "open";
        paint(JSON.parse(event.data) as RedesignLiveEnvelope);
      } catch {
        invalidate(
          "unreadable",
          "Live input sent something this page could not read. Waiting for a fresh status check.",
          true,
        );
      }
    });
    source.addEventListener("unavailable", (event) => {
      invalidate("offline", redesignLiveCustomerReason(eventMessage(event)), true);
    });
    // EventSource already reconnects with the server's retry cadence. Never
    // layer a second timer/backoff over it; just revoke paint until the next
    // authoritative /api/redesign payload confirms the session again.
    source.addEventListener("error", () => {
      transport = "reconnecting";
      // An explicit refusal already carries the useful customer action. SSE
      // closes after sending it, which also raises `error`; do not alternate
      // "offline" and "reconnecting" announcements on every retry cycle.
      if (state === "offline" || state === "unreadable" || state === "stale") return;
      invalidate("reconnecting", "Reconnecting to live input…", true);
    });
    if (!pagehideWired) {
      pagehideWired = true;
      window.addEventListener("pagehide", dispose, { once: true });
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    source?.close();
    source = null;
    transport = "idle";
    if (pagehideWired) {
      window.removeEventListener("pagehide", dispose);
      pagehideWired = false;
    }
    confirmed = false;
    resetLedger();
    const scope = root();
    if (scope) delete scope.dataset.rdLiveState;
  }

  return { connect, reconcileSession, acceptCurrentRevision, invalidateTargets, dispose };
}
