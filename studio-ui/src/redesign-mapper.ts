// The MAPPER on the redesign workbench: click a control chip (or a control
// on the pad art), press a key, it binds — plus the BY-KEY assign twin
// (hold a key in hand, click the control), the "Bind several" chain, the
// auto-map walk, and the key-conflict consequence dialog.
//
// The PROTOCOL is 4460's, verbatim in every invariant that matters — the
// server is the shared implementation (`/api/learn*` and the aliased
// `/redesign/api/bind` reach the same backend writer), and this module keeps
// the proven fail-closed discipline around it:
//  - two generations (browser supersede counter + the daemon's exact
//    learner generation) — a late completion dies silently;
//  - the SOURCE PIN: a gesture is pinned to the staged input's verified
//    Windows identity captured at arm time, and a hit from any other
//    device is ignored with its own sentence;
//  - the TARGET PIN: the served `target_revision` travels with the gesture
//    and the server refuses a stale row (this module also re-checks before
//    every commit);
//  - the conflict dialog: cross-slot fan-out is asked about, never
//    assumed — "Use here too" retries the SAME pinned gesture with force.
//
// What deliberately did NOT come over (the nocturne module carries them for
// its own neighbours): the `surface`/`panel-test` purposes (the Control
// Surface Builder and input-test live on 4460 until their own migrations)
// and the vestigial panel-test arm that had no arm site even there.
//
// UI is page-shaped by design (nocturne's own precedent: the pads grid vs
// this canvas): the banner, key cue, dialog and arming marks live in this
// page's own nodes, injected through MapperHost.

import { fetchJSON } from "@getforma/core/http";

/** Wire shape of `/api/learn` and `/api/learn/start` (the daemon's learner
 *  plus the server-resolved canonical selector). */
export interface RdLearnView {
  ok: boolean;
  state: string;
  generation: number | null;
  remaining_ms?: number | null;
  device?: string | null;
  selector?: string | null;
  key?: string | null;
  error?: string | null;
}

/** Wire shape of POST /redesign/api/bind. */
export interface RdBindOutcome {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  conflicts: { scope: string; preset: string; function: string; slot: number | null }[];
  also_drives: string[];
}

export interface MapperTarget {
  fn: string;
  label: string;
  slot: string;
  mode: "replace" | "add" | "remove";
  expectedTargetRevision?: string;
  bindingAuthorityPinned?: boolean;
  expectedDevice?: string;
  expectedInstance?: string;
}

/** One control of the selected slot, for the auto-map walk — the served
 *  authoring order (`NocturneControlAuthoring` rows). */
export interface MapperControl {
  function: string;
  label: string;
  keys: string[];
}

/** What the island lends the mapper — every page truth as a port, so this
 *  module owns protocol and interaction state and nothing else. */
export interface MapperHost {
  root(): HTMLElement | null;
  flash(line: string): void;
  /** The page repaint (the entry's refresh) — awaited after a successful
   *  bind so the revision-advance check reads the NEW truth. */
  refresh(): Promise<boolean>;
  announce(message: string): void;
  /** The staged input's verified identity pair (served; empty = refuse to
   *  arm — the fail-closed rule). */
  learnSource(): { selector: string; instance: string };
  /** The served pads (target revisions + controls) — always the CURRENT
   *  array, re-read after every refresh. */
  pads(): { slot: number; target_revision?: string; preset: string }[];
  selectedSlot(): string;
  controlsFor(slot: string): MapperControl[];
  /** The page's one mutation gate (the entry's beginMutation/endMutation),
   *  so a bind commit cannot interleave with an in-flight form verb. Null
   *  from begin = another mutation owns the page; the commit waits. */
  beginMutation(): unknown | null;
  endMutation(token: unknown): void;
}

const LEARN_POLL_MS = 33;
const ASSIGN_WINDOW_MS = 12000;

let host: MapperHost | null = null;

// ── Protocol state (nocturne's own variables, names kept) ────────────────
let learnRow: MapperTarget | null = null;
let learnGen = 0;
let daemonGen: number | null = null;
let learnTimer: number | undefined;
let learnStartFlight: Promise<RdLearnView> | null = null;
let pendingConflict: {
  row: MapperTarget;
  key: string;
  origin: "assign" | "learn";
  chain: boolean;
  assignMode: "replace" | "add" | "remove";
} | null = null;
let lastWrite: {
  origin: "assign" | "learn";
  chain: boolean;
  assignMode: "replace" | "add" | "remove";
} = { origin: "learn", chain: false, assignMode: "replace" };
let autoMap: { steps: { fn: string; label: string }[]; idx: number; bound: number } | null = null;
let assignKey: string | null = null;
let assignMode: "replace" | "add" | "remove" = "replace";
let assignSourcePin: { expectedDevice: string; expectedInstance: string } | null = null;
let assignDraftRevision = "";
let assignTimer: number | undefined;

export function mapperWire(h: MapperHost): void {
  host = h;
  window.addEventListener("keydown", guardLearnKeys, { capture: true });
}

/** Is any mapping gesture holding the page (learn armed, key in hand, or
 *  the conflict dialog open)? The canvas's single-key shortcuts suspend
 *  while this is true. */
export function mapperBusy(): boolean {
  return learnRow !== null || assignKey !== null || pendingConflict !== null;
}

/** The escape ladder's mapper rung. Returns true when Escape was consumed
 *  (a dialog closed, an assign or learn cancelled). */
export function mapperEscape(): boolean {
  if (pendingConflict) {
    dismissConflict();
    return true;
  }
  if (assignKey) {
    cancelAssign();
    return true;
  }
  if (learnRow) {
    if (autoMap) {
      // Esc skips ONE step of the walk (nocturne's wizard contract).
      const row = learnRow;
      void cancelLearn().then(() => {
        if (autoMap && row) autoMapAdvance(false);
      });
    } else {
      void cancelLearn();
    }
    return true;
  }
  return false;
}

// ── The capture-phase key guard (nocturne's, binding-purpose only) ───────
function guardLearnKeys(ev: KeyboardEvent): void {
  if (!learnRow) return;
  if (ev.key === "Escape") return; // the ladder owns Escape
  // While armed the keys reach Windows AND this page; a letter would type
  // into anything focusable and Space would "click" the arming button.
  ev.preventDefault();
  ev.stopPropagation();
}

// ── Banner / cue / marks (this page's own nodes) ─────────────────────────
function banner(): HTMLElement | null {
  return host?.root()?.querySelector<HTMLElement>(".rd-learnbar") ?? null;
}

function setBanner(cls: string, text: string, sub: string, skip: boolean, chain: boolean): void {
  const bar = banner();
  if (!bar) return;
  bar.className = cls;
  const t = bar.querySelector<HTMLElement>(".rd-learn-line");
  const s = bar.querySelector<HTMLElement>(".rd-learn-sub");
  if (t) t.textContent = text;
  if (s) s.textContent = sub;
  const skipBtn = bar.querySelector<HTMLElement>('[data-nx="rd-learn-skip"]');
  if (skipBtn) skipBtn.hidden = !skip;
  const chainLab = bar.querySelector<HTMLElement>(".rd-chain");
  if (chainLab) chainLab.hidden = !chain;
}

function setBannerSub(sub: string): void {
  const s = banner()?.querySelector<HTMLElement>(".rd-learn-sub");
  if (s) s.textContent = sub;
}

function hideBanner(): void {
  const bar = banner();
  if (bar) bar.className = "rd-learnbar n-learnbar none";
  setChainBox(false);
}

function setKeyCue(text: string | null): void {
  const cue = host?.root()?.querySelector<HTMLElement>(".rd-keycue");
  if (!cue) return;
  cue.classList.toggle("none", text === null);
  const span = cue.querySelector<HTMLElement>(".rd-keycue-text");
  if (span) span.textContent = text ?? "";
}

export function chainWanted(): boolean {
  return banner()?.querySelector<HTMLInputElement>(".rd-chain-box")?.checked === true;
}

function setChainBox(on: boolean): void {
  const box = banner()?.querySelector<HTMLInputElement>(".rd-chain-box");
  if (box) box.checked = on;
}

/** Mark the armed control everywhere it is drawn: the inspector row, its
 *  free chip, and the card zone (clones are slot-stamped). Nocturne's
 *  markArmedRow with this page's selectors. */
function markArmedRow(fnName: string | null, slot?: string): void {
  const root = host?.root();
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".arm"))) {
    el.classList.remove("arm");
  }
  if (fnName === null) return;
  const armSlot = slot ?? host?.selectedSlot() ?? "";
  const want = fnName.toLowerCase();
  if (armSlot === host?.selectedSlot()) {
    root
      .querySelector<HTMLElement>(`.rd-insp-body .n-bind[data-fn="${CSS.escape(fnName)}"]`)
      ?.classList.add("arm");
    for (const chip of Array.from(
      root.querySelectorAll<HTMLElement>(".rd-insp-body .n-ctlchip[data-fn]"),
    )) {
      if ((chip.getAttribute("data-fn") ?? "").toLowerCase() === want) chip.classList.add("arm");
    }
  }
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(".rd-ctrlcard-artwrap [data-fn]"),
  )) {
    const padSlot = el.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot");
    if (padSlot !== armSlot) continue;
    const fns = (el.getAttribute("data-fn") ?? "").toLowerCase().split(/\s+/);
    if (fns.includes(want)) el.classList.add("arm");
  }
}

/** Mark every drawing of the key held in hand — the plate cell(s) and the
 *  Keys-tab rows. Nocturne's markAssignTargets, this page's tiers. */
function markAssignTargets(key: string | null): void {
  const root = host?.root();
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".assign"))) {
    el.classList.remove("assign");
  }
  if (key) {
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(
        `.n-kb [data-key="${CSS.escape(key)}"], .rd-insp-krows [data-key="${CSS.escape(key)}"]`,
      ),
    )) {
      el.classList.add("assign");
    }
  }
}

/** Re-apply the interaction marks after any repaint that rebuilt the nodes
 *  (renderInspector, applyRedesign) — nocturne re-marks in applyNocturne;
 *  this page's panels rebuild more often, so the pass is exported. */
export function mapperRemark(): void {
  if (learnRow) markArmedRow(learnRow.fn, learnRow.slot);
  if (assignKey) markAssignTargets(assignKey);
}

// ── Pinning (nocturne's, against this page's served truth) ───────────────
function captureSourcePin(): { expectedDevice: string; expectedInstance: string } {
  const source = host?.learnSource() ?? { selector: "", instance: "" };
  return {
    expectedDevice: source.selector.trim(),
    expectedInstance: source.instance.trim(),
  };
}

function stagedRevisionSignature(): string {
  return (host?.pads() ?? [])
    .map((pad) => `${pad.slot}:${pad.target_revision?.trim() ?? ""}`)
    .sort()
    .join("\n");
}

function pinTarget(row: MapperTarget): MapperTarget | null {
  if (row.bindingAuthorityPinned && row.expectedTargetRevision !== undefined) return row;
  const pad = (host?.pads() ?? []).find((p) => String(p.slot) === row.slot);
  const revision = pad?.target_revision?.trim() ?? "";
  if (!revision) return null;
  const source = row.bindingAuthorityPinned
    ? { expectedDevice: row.expectedDevice ?? "", expectedInstance: row.expectedInstance ?? "" }
    : captureSourcePin();
  return {
    ...row,
    expectedTargetRevision: row.expectedTargetRevision ?? revision,
    bindingAuthorityPinned: true,
    ...source,
  };
}

function sameIdentity(left: string | undefined, right: string): boolean {
  const a = (left ?? "").trim();
  return a !== "" && a.toLowerCase() === right.trim().toLowerCase();
}

function hitBelongsToPin(row: MapperTarget, learn: RdLearnView): boolean {
  const selector = learn.selector?.trim() ?? "";
  const device = learn.device?.trim() ?? "";
  if (sameIdentity(row.expectedDevice, selector)) return true;
  if (sameIdentity(row.expectedInstance, device)) return true;
  return false;
}

function sourceAuthorityCurrent(row: MapperTarget): boolean {
  const now = captureSourcePin();
  return (
    sameIdentity(row.expectedDevice, now.expectedDevice) &&
    sameIdentity(row.expectedInstance, now.expectedInstance)
  );
}

function targetAuthorityCurrent(row: MapperTarget): boolean {
  const pad = (host?.pads() ?? []).find((p) => String(p.slot) === row.slot);
  const revision = pad?.target_revision?.trim() ?? "";
  return revision !== "" && revision === row.expectedTargetRevision?.trim();
}

/** A fresh payload arrived: retire any armed gesture whose authority it
 *  invalidated (nocturne's reconcileBindingActionAuthority). */
export function mapperReconcile(): void {
  let retired = false;
  if (learnRow && !(sourceAuthorityCurrent(learnRow) && targetAuthorityCurrent(learnRow))) {
    // An auto-map walk owns this learn row. Retiring only the listener leaves
    // an invisible walk behind; the next ordinary learn would then inherit its
    // stale steps and continue mapping controls the user did not reopen.
    autoMap = null;
    void cancelLearn();
    retired = true;
  }
  if (assignKey && assignDraftRevision !== stagedRevisionSignature()) {
    cancelAssign();
    retired = true;
  }
  if (pendingConflict && !targetAuthorityCurrent(pendingConflict.row)) {
    autoMap = null;
    dismissConflict();
    retired = true;
  }
  if (retired) {
    host?.announce(
      "The selected input or controller draft changed in another action. The old mapping gesture was cancelled before it could write.",
    );
  }
  mapperRemark();
}

function learnSentence(mode: "replace" | "add" | "remove"): string {
  if (mode === "remove") {
    return "The key you press is taken off this control's list; its other keys stay.";
  }
  return mode === "add"
    ? "The key joins this control's list — any one of them presses it."
    : "The key replaces this control's binding.";
}

function reopenTarget(row: MapperTarget, mode: "replace" | "add" | "remove"): MapperTarget {
  return {
    ...row,
    mode,
    expectedTargetRevision: undefined,
    bindingAuthorityPinned: undefined,
    expectedDevice: undefined,
    expectedInstance: undefined,
  };
}

function validGen(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

async function cancelDaemonGen(generation: number): Promise<void> {
  try {
    await fetch("/api/learn/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation }),
    });
  } catch {
    // A lost cleanup expires at the daemon's bounded learner timeout.
  }
}

function stopLearnTimer(): void {
  if (learnTimer !== undefined) {
    window.clearInterval(learnTimer);
    learnTimer = undefined;
  }
}

function retireLearn(): void {
  learnGen += 1;
  learnRow = null;
  daemonGen = null;
  stopLearnTimer();
  hideBanner();
  setKeyCue(null);
  markArmedRow(null);
}

export async function cancelLearn(): Promise<void> {
  const gen = daemonGen;
  retireLearn();
  if (validGen(gen)) await cancelDaemonGen(gen);
}

// ── Arm a learn ──────────────────────────────────────────────────────────
export async function startLearn(row: MapperTarget): Promise<void> {
  const pinned = pinTarget(row);
  if (!pinned) {
    autoMap = null;
    host?.flash(
      "error: This controller changed or came from an older daemon. Refresh the canvas before mapping it.",
    );
    return;
  }
  row = pinned;
  if (!row.expectedDevice?.trim() || !row.expectedInstance?.trim()) {
    autoMap = null;
    host?.flash(
      "error: Select an input with a verified Windows device identity before listening for a key. Nothing changed.",
    );
    return;
  }
  // PadForge convention: clicking the control being recorded cancels it.
  if (learnRow && learnRow.fn === row.fn && learnRow.slot === row.slot && learnRow.mode === row.mode) {
    // A row toggle is the banner's whole-run Cancel twin, not its one-step
    // Skip verb. Retire the walk before the listener so a later ordinary
    // learn cannot inherit an invisible auto-map queue.
    autoMap = null;
    void cancelLearn();
    return;
  }
  if (assignKey) cancelAssign();
  const gen = ++learnGen;
  learnRow = row;
  armUi(row);
  // At most one daemon start in flight (clicks can cross).
  const flight = learnStartFlight ?? fetchJSON<RdLearnView>("/api/learn/start", { method: "POST" });
  learnStartFlight = flight;
  let learn: RdLearnView;
  try {
    learn = await flight;
  } catch {
    if (learnGen === gen) {
      autoMap = null;
      retireLearn();
      host?.flash("error: Key listening could not start — is ksx studio still running?");
    }
    return;
  } finally {
    if (learnStartFlight === flight) learnStartFlight = null;
  }
  if (learnGen !== gen) {
    // Superseded while starting. A newer waiter may share this same flight;
    // let every already-queued promise continuation run, then cancel the
    // returned generation unless one of them actually adopted it. Without
    // this cleanup a quick cancel leaves the daemon consuming keys until its
    // timeout even though the page shows no active listener.
    if (validGen(learn.generation)) {
      const staleGeneration = learn.generation;
      window.queueMicrotask(() => {
        if (daemonGen !== staleGeneration) void cancelDaemonGen(staleGeneration);
      });
    }
    return;
  }
  if (!learn.ok || !validGen(learn.generation)) {
    autoMap = null;
    retireLearn();
    host?.flash(`error: ${learn.error ?? "Key listening could not start. Nothing changed."}`);
    return;
  }
  daemonGen = learn.generation;
  stopLearnTimer();
  learnTimer = window.setInterval(() => void pollLearn(), LEARN_POLL_MS);
  void pollLearn(learn);
}

function armUi(row: MapperTarget): void {
  const step = autoMap ? ` — ${autoMap.idx + 1} of ${autoMap.steps.length}` : "";
  setBanner(
    "rd-learnbar n-learnbar listen",
    `Press the key for P${row.slot} · ${row.label}${step}`,
    `${learnSentence(row.mode)} ${autoMap ? "Esc skips this one." : "Esc cancels."}`,
    Boolean(autoMap),
    !autoMap,
  );
  setKeyCue(
    row.mode === "remove"
      ? `Waiting — press the key to remove from ${row.label}, or click it on the plate`
      : `Waiting — press a key for ${row.label}, or click one on the plate`,
  );
  markArmedRow(row.fn, row.slot);
}

async function pollLearn(observed?: RdLearnView): Promise<void> {
  const row = learnRow;
  const gen = learnGen;
  const expected = daemonGen;
  if (!row) {
    stopLearnTimer();
    return;
  }
  let learn = observed;
  if (!learn) {
    try {
      learn = await fetchJSON<RdLearnView>("/api/learn");
    } catch {
      return; // transient — keep listening on the last known state
    }
  }
  if (learnGen !== gen) return;
  if (expected === null || !validGen(learn.generation) || learn.generation !== expected) {
    autoMap = null;
    retireLearn();
    host?.flash("error: Another key-listening action replaced this one. Nothing changed.");
    return;
  }
  switch (learn.state) {
    case "listening": {
      const secs = Math.max(0, Math.ceil((learn.remaining_ms ?? 0) / 1000));
      const esc = autoMap ? "Esc skips this one." : "Esc cancels.";
      setBannerSub(`${learnSentence(row.mode)} ${secs}s left · ${esc}`);
      break;
    }
    case "hit": {
      const chain = chainWanted();
      retireLearn();
      if (!learn.key) {
        autoMap = null;
        host?.flash("error: Key listening stopped without a key. Auto-map was cancelled.");
        break;
      }
      if (!hitBelongsToPin(row, learn)) {
        autoMap = null;
        host?.flash(
          `error: Ignored ${learn.key} from another or unresolved keyboard. The selected controller binding was not changed.`,
        );
        break;
      }
      lastWrite = { origin: "learn", chain, assignMode: "replace" };
      void writeLearnedKey(row, learn.key, false).then((ok) => {
        if (ok && chain && !autoMap) {
          void startLearn(reopenTarget(row, "add"));
          setChainBox(true);
        }
      });
      break;
    }
    case "timeout":
      retireLearn();
      if (autoMap) {
        autoMap = null;
        host?.flash(
          `error: Auto-map stopped — no key was pressed in time for ${row.label}. Nothing more changed.`,
        );
      } else {
        host?.flash(
          `error: Timed out — no key was pressed in time for ${row.label}. Nothing changed.`,
        );
      }
      break;
    case "cancelled":
      retireLearn();
      autoMap = null;
      break;
    default:
      autoMap = null;
      retireLearn();
      host?.flash("error: Key listening stopped. Nothing changed.");
      break;
  }
}

// ── The one commit boundary ──────────────────────────────────────────────
async function writeLearnedKey(row: MapperTarget, key: string, force: boolean): Promise<boolean> {
  const pinned = pinTarget(row);
  if (!pinned || (force && pinned !== row)) {
    autoMap = null;
    dismissConflict();
    host?.flash(
      "error: This controller changed or came from an older daemon. Refresh the canvas before mapping it.",
    );
    return false;
  }
  row = pinned;
  // One mutation surface with the page's form verbs: a bind commit racing
  // an in-flight form write would interleave staged edits and double
  // repaints. Wait for the gate rather than bypassing it.
  let gate = host?.beginMutation() ?? null;
  for (let tries = 0; gate === null && tries < 40; tries += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    gate = host?.beginMutation() ?? null;
  }
  if (gate === null) {
    autoMap = null;
    host?.flash("error: The page is busy with another change — try again.");
    return false;
  }
  let outcome: RdBindOutcome;
  try {
    outcome = await fetchJSON<RdBindOutcome>("/redesign/api/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot: Number(row.slot),
        expected_target_revision: row.expectedTargetRevision,
        function: row.fn,
        key,
        mode: row.mode,
        force,
      }),
    });
  } catch {
    host?.endMutation(gate);
    autoMap = null;
    host?.flash("error: The bind request failed — is ksx studio still running?");
    return false;
  }
  if (outcome.ok) {
    dismissConflict();
    let line =
      row.mode === "add"
        ? `${key} added to ${row.label} — any of its keys presses it.`
        : row.mode === "remove"
          ? `${key} no longer drives ${row.label}.`
          : `${row.label} is now ${key}.`;
    if (outcome.also_drives.length > 0) {
      line += ` That key also drives ${outcome.also_drives.join(" · ")}.`;
    }
    host?.flash(line);
    // A successful bind changes the controller's content revision. Wait for
    // the newly served row before a chained/auto-map action opens its next
    // target, rather than reusing the token that just committed.
    await host?.refresh();
    host?.endMutation(gate);
    const refreshed = (host?.pads() ?? [])
      .find((pad) => String(pad.slot) === row.slot)
      ?.target_revision?.trim() ?? "";
    if (!refreshed || refreshed === row.expectedTargetRevision?.trim()) {
      autoMap = null;
      host?.flash(
        `error: ${line} KSX could not confirm the new draft revision, so mapping stopped — refresh the canvas before mapping another control.`,
      );
      return false;
    }
    autoMapAdvance(true);
    return true;
  }
  host?.endMutation(gate);
  if (outcome.code === "conflict" && outcome.conflicts.length > 0) {
    pendingConflict = { row, key, ...lastWrite };
    const lines = outcome.conflicts.map((c) => {
      const control = c.function.startsWith("macro.")
        ? `the "${c.function.slice(6)}" macro`
        : c.function;
      const where = c.slot !== null ? ` for Player ${c.slot}` : " for another player";
      return c.scope === "macro"
        ? `${key} already starts ${control}${where}`
        : `${key} already controls ${control}${where}`;
    });
    openConflict(
      `Give ${key} to ${row.label} too?`,
      `${lines.join("; ")}. "Use here too" shares the key — the other control keeps it as well; nothing is taken away.`,
    );
  } else {
    dismissConflict();
    autoMap = null;
    host?.flash(`error: ${outcome.error ?? "That control could not be changed. Nothing changed."}`);
  }
  return false;
}

// ── The conflict consequence dialog ──────────────────────────────────────
function conflictDialog(): HTMLElement | null {
  return host?.root()?.querySelector<HTMLElement>(".rd-confdlg") ?? null;
}

let conflictReturnFocus: Element | null = null;
let conflictReturnSelector: string | null = null;
let conflictTrapPanel: HTMLElement | null = null;

interface ConflictFocusReturn {
  element: Element | null;
  selector: string | null;
}

function conflictOpenerSelector(active: Element): string | null {
  const holder = active.closest<HTMLElement>("[data-fn], [data-key]");
  const identity = holder?.dataset.fn
    ? `[data-fn="${CSS.escape(holder.dataset.fn)}"]`
    : holder?.dataset.key
      ? `[data-key="${CSS.escape(holder.dataset.key)}"]`
      : "";
  const ownSlot = holder?.dataset.slot;
  const padSlot = holder?.closest<HTMLElement>("[data-pad-slot]")?.dataset.padSlot;
  const instanceId = holder?.closest<HTMLElement>("[data-instance-id]")?.dataset.instanceId;
  const nx = active.getAttribute("data-nx");
  if (!holder || !identity) return null;
  const holderSelector = `${identity}${
    ownSlot ? `[data-slot="${CSS.escape(ownSlot)}"]` : ""
  }`;
  if (!nx && holder === active) {
    if (active.hasAttribute("data-rd-pad-action")) {
      return padSlot
        ? `[data-pad-slot="${CSS.escape(padSlot)}"] ${holderSelector}[data-rd-pad-action]`
        : `${holderSelector}[data-rd-pad-action]`;
    }
    // The keyboard plate is also direct manipulation, but it is native HTML
    // and deliberately has no pad-action marker. Scope its canonical key to
    // the durable canvas instance so a refresh can find the replacement cap.
    return instanceId
      ? `[data-instance-id="${CSS.escape(instanceId)}"] ${holderSelector}`
      : holderSelector;
  }
  if (!nx) return null;
  return holder === active
    ? `${holderSelector}[data-nx="${CSS.escape(nx)}"]`
    : `${holderSelector} [data-nx="${CSS.escape(nx)}"]`;
}

function conflictFocusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
        'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (control) =>
      !control.hidden &&
      !control.closest("[hidden]") &&
      control.getAttribute("aria-hidden") !== "true",
  );
}

/** The consequence question is modal keyboard state. Keep Tab inside its two
 *  answers; Escape continues to bubble to the island's single escape ladder. */
function trapConflictFocus(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const panel = event.currentTarget as HTMLElement;
  const controls = conflictFocusables(panel);
  if (controls.length === 0) {
    event.preventDefault();
    panel.focus({ preventScroll: true });
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  } else if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function wireConflictTrap(panel: HTMLElement): void {
  if (conflictTrapPanel === panel) return;
  conflictTrapPanel?.removeEventListener("keydown", trapConflictFocus);
  conflictTrapPanel = panel;
  conflictTrapPanel.addEventListener("keydown", trapConflictFocus);
}

function focusConflictTarget(target: Element | null): boolean {
  if (!target?.isConnected || !("focus" in target)) return false;
  const focus = (target as HTMLElement).focus;
  if (typeof focus !== "function") return false;
  focus.call(target, { preventScroll: true });
  return document.activeElement === target;
}

function takeConflictFocus(): ConflictFocusReturn {
  const saved = {
    element: conflictReturnFocus,
    selector: conflictReturnSelector,
  };
  conflictReturnFocus = null;
  conflictReturnSelector = null;
  return saved;
}

function restoreConflictFocus(saved: ConflictFocusReturn = takeConflictFocus()): void {
  if (focusConflictTarget(saved.element)) return;
  const replacement = saved.selector
    ? host?.root()?.querySelector<Element>(saved.selector) ?? null
    : null;
  if (focusConflictTarget(replacement)) return;
  host
    ?.root()
    ?.querySelector<HTMLElement>('.forma-canvas-viewport, [data-nx="rd-ctrls-open"]')
    ?.focus({ preventScroll: true });
}

function openConflict(title: string, lines: string): void {
  const dialog = conflictDialog();
  if (!dialog) return;
  const panel = dialog.querySelector<HTMLElement>(".nd");
  const active = document.activeElement;
  if (
    active instanceof Element &&
    active !== document.body &&
    active !== document.documentElement &&
    !dialog.contains(active)
  ) {
    conflictReturnFocus = active;
    conflictReturnSelector = conflictOpenerSelector(active);
  }
  const t = dialog.querySelector<HTMLElement>(".nd-title");
  const l = dialog.querySelector<HTMLElement>(".nd-lede");
  if (t) t.textContent = title;
  if (l) l.textContent = lines;
  dialog.classList.remove("none");
  if (panel) {
    // RedesignIsland carries the SSR twin; stamping it here keeps this module
    // self-contained if a fixture or future host supplies only role=dialog.
    panel.setAttribute("aria-modal", "true");
    wireConflictTrap(panel);
    panel.focus({ preventScroll: true });
  }
}

function dismissConflict(restoreFocus = true): void {
  pendingConflict = null;
  const dialog = conflictDialog();
  const wasOpen = Boolean(dialog && !dialog.classList.contains("none"));
  if (dialog) dialog.classList.add("none");
  if (restoreFocus && (wasOpen || conflictReturnFocus !== null)) restoreConflictFocus();
}

/** Accepting a conflict hides the modal before its write/refresh completes.
 * Restore only while focus still belongs to that dismissed modal (or the
 * browser dropped it to the document during repaint). A user who deliberately
 * moved to another live control while the request was pending keeps it. */
function acceptedConflictOwnsFocus(dialog: HTMLElement | null, owner: Element | null): boolean {
  const active = document.activeElement;
  if (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    !active.isConnected
  ) {
    return true;
  }
  // The shared dialog may already have reopened for a newer conflict; that
  // newer modal owns focus and the completed older write must not disturb it.
  if (dialog && !dialog.classList.contains("none")) return false;
  return active === owner || Boolean(dialog?.contains(active));
}

/** The dialog's two verbs (wired by the island's click dispatch). */
export function conflictForce(): void {
  const held = pendingConflict;
  // The accepted write refreshes both the inspector and controller card.
  // Hold the logical return target until that repaint completes; restoring
  // before the write would focus a node the refresh immediately detaches.
  const returnFocus = takeConflictFocus();
  const dialog = conflictDialog();
  const focusOwner = document.activeElement;
  dismissConflict(false);
  if (!held) {
    if (acceptedConflictOwnsFocus(dialog, focusOwner)) restoreConflictFocus(returnFocus);
    return;
  }
  lastWrite = { origin: held.origin, chain: held.chain, assignMode: held.assignMode };
  void writeLearnedKey(held.row, held.key, true)
    .then((ok) => {
      if (!ok || !held.chain) return;
      if (held.origin === "assign") {
        armAssign(held.key, held.assignMode);
        setChainBox(true);
      } else if (!autoMap) {
        void startLearn(reopenTarget(held.row, "add"));
        setChainBox(true);
      }
    })
    .finally(() => {
      if (acceptedConflictOwnsFocus(dialog, focusOwner)) restoreConflictFocus(returnFocus);
    });
}

export function conflictCancel(): void {
  dismissConflict();
  // Declining a conflict mid-walk skips that control; the run moves on
  // (nocturne's conf-cancel, verbatim). A lone decline is silent — the
  // dialog's own dismissal is the answer.
  autoMapAdvance(false);
}

export function conflictOpen(): boolean {
  return pendingConflict !== null;
}

// ── The BY-KEY assign twin ───────────────────────────────────────────────
export function armAssign(key: string, mode: "replace" | "add" | "remove" = "replace"): void {
  if (learnRow) void cancelLearn();
  assignKey = key;
  assignMode = mode;
  assignSourcePin = captureSourcePin();
  assignDraftRevision = stagedRevisionSignature();
  const deadline = Date.now() + ASSIGN_WINDOW_MS;
  setBanner(
    "rd-learnbar n-learnbar listen",
    mode === "add"
      ? `Click a control on the pad to add ${key}`
      : mode === "remove"
        ? `Click a control on the pad — ${key} is removed from it`
        : `Click a control on the pad — ${key} replaces its binding`,
    `${Math.ceil(ASSIGN_WINDOW_MS / 1000)}s left · Esc cancels.`,
    false,
    true,
  );
  markAssignTargets(key);
  if (assignTimer !== undefined) window.clearInterval(assignTimer);
  assignTimer = window.setInterval(() => {
    const secs = Math.ceil((deadline - Date.now()) / 1000);
    if (secs <= 0) {
      const held = assignKey;
      cancelAssign();
      host?.flash(`error: Timed out — no control was chosen for ${held}. Nothing changed.`);
      return;
    }
    setBannerSub(`${secs}s left · Esc cancels.`);
  }, 250);
}

export function cancelAssign(): void {
  assignKey = null;
  assignSourcePin = null;
  assignDraftRevision = "";
  if (assignTimer !== undefined) {
    window.clearInterval(assignTimer);
    assignTimer = undefined;
  }
  hideBanner();
  markAssignTargets(null);
}

export function assignHeld(): string | null {
  return assignKey;
}

/** A control was clicked while a key is in hand: give it the key. The
 *  canonical fn spelling and label come from the caller (the served pad
 *  tables). */
export function resolveAssignWithControl(
  slot: string,
  fn: string,
  label: string,
  shiftChain: boolean,
): boolean {
  if (!assignKey) return false;
  const held = assignKey;
  const mode = assignMode;
  const sourcePin = assignSourcePin;
  const chain = shiftChain || chainWanted();
  cancelAssign();
  lastWrite = { origin: "assign", chain, assignMode: mode };
  void writeLearnedKey(
    {
      fn,
      label,
      slot,
      mode,
      ...(sourcePin ? { bindingAuthorityPinned: true as const, ...sourcePin } : {}),
    },
    held,
    false,
  ).then((ok) => {
    if (ok && chain) {
      armAssign(held, mode);
      setChainBox(true);
    }
  });
  return true;
}

/** A key was CLICKED (on the plate or a Keys row) while a learn is armed:
 *  it resolves the learn exactly like pressing it. */
export function resolveLearnWithKey(key: string, shiftChain: boolean): boolean {
  const row = learnRow;
  if (!row) return false;
  const chain = shiftChain || chainWanted();
  lastWrite = { origin: "learn", chain, assignMode: "replace" };
  void cancelLearn();
  void writeLearnedKey(row, key, false).then((ok) => {
    if (ok && chain && !autoMap) {
      void startLearn(reopenTarget(row, "add"));
      setChainBox(true);
    }
  });
  return true;
}

// ── The auto-map walk ────────────────────────────────────────────────────
export function startAutoMap(): void {
  const slot = host?.selectedSlot() ?? "";
  const steps = (host?.controlsFor(slot) ?? [])
    .filter((control) => control.keys.length === 0)
    .map((control) => ({ fn: control.function, label: control.label }));
  if (steps.length === 0) {
    host?.flash("Every control on this controller already has a key. Nothing to walk.");
    return;
  }
  autoMap = { steps, idx: 0, bound: 0 };
  stepAutoMap();
}

function stepAutoMap(): void {
  const walk = autoMap;
  if (!walk) return;
  const step = walk.steps[walk.idx];
  if (!step) {
    const bound = walk.bound;
    autoMap = null;
    host?.flash(`Auto-map finished — ${bound} control${bound === 1 ? "" : "s"} bound.`);
    return;
  }
  void startLearn({ fn: step.fn, label: step.label, slot: host?.selectedSlot() ?? "", mode: "replace" });
}

function autoMapAdvance(didBind: boolean): void {
  const walk = autoMap;
  if (!walk) return;
  if (didBind) walk.bound += 1;
  walk.idx += 1;
  stepAutoMap();
}

/** The banner's Skip button (auto-map only): skip ONE step. */
export function skipAutoMapStep(): void {
  if (!autoMap) return;
  void cancelLearn().then(() => autoMapAdvance(false));
}

export function autoMapRunning(): boolean {
  return autoMap !== null;
}

/** A slot selection change ends any armed gesture — the pane speaks for
 *  one controller at a time (nocturne's seat-change rule). */
export function mapperOnSlotChange(): void {
  if (learnRow) {
    autoMap = null;
    void cancelLearn();
  }
  if (assignKey) cancelAssign();
}
