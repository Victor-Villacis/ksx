// The macro STEP EDITOR on the redesign workbench: rows are steps, columns are
// this pad's controls, a cell is
// held or not (docs/INPUT-TRANSFORMS.md §6.2). The BROWSER holds the
// `[macros.<name>]` table it is editing; every verb is the server's. An act
// posts the whole table and one word to the page-aliased edit core
// (`/redesign/api/macro/edit` — the same authoritative edit core), and the
// answer is the new table plus the roll that draws it — so the diagonal
// lens, the sampling floor and every sentence come from the one place that
// already paints them on the server. Save writes through `/api/macro/save`,
// the verb the CLI uses.
//
// The one page-shaped difference: the canvas page receives escaped SSR markup
// for a cold open URL and adopts it once; after that this module paints the
// dialog from the same served view with safe DOM APIs. A repaint is skipped when
// the view is unchanged so the 2 s background poll can never steal the caret
// from a duration box, and THE DRAFT WINS over the payload: a poll must
// never wipe an edit nobody has saved yet.

export interface RdMacColView {
  id: string;
  cls: string;
  title: string;
}

export interface RdMacGroupView {
  label: string;
  cls: string;
  count: string;
  count_cls: string;
}

export interface RdMacRowView {
  n: string;
  cls: string;
  hold: string;
  hold_cls: string;
  exp: string;
  exp_cls: string;
  dur: string;
  dur_val: string;
  dur_row: string;
  dur_cls: string;
  dur_title: string;
  unit: string;
  unit_act: string;
  unit_title: string;
  warn: string;
  warn_cls: string;
  warn_title: string;
  short: boolean;
  up_act: string;
  up_cls: string;
  dn_act: string;
  dn_cls: string;
  ia_act: string;
  ib_act: string;
  del_act: string;
  del_title: string;
}

export interface RdMacCellView {
  cell: string;
  cls: string;
  mark: string;
  on: string;
  tab: string;
  title: string;
}

export interface RdMacPolView {
  act: string;
  cls: string;
  head: string;
  head_cls: string;
  label: string;
  note: string;
  note_cls: string;
  title: string;
}

export interface RdMacMotionView {
  act: string;
  shape: string;
  label: string;
  title: string;
}

/** `NocturneMacroEditor` on the wire — the whole dialog, served. */
export interface RdMacView {
  back_cls: string;
  open: boolean;
  name: string;
  slot: string;
  preset: string;
  head: string;
  trigger: string;
  note: string;
  grid_cls: string;
  close_href: string;
  map_href: string;
  motion_line: string;
  policy_line: string;
  ring: string;
  rule: string;
  toml: string;
  turbo_cls: string;
  turbo_val: string;
  turbo_label: string;
  cols: RdMacColView[];
  groups: RdMacGroupView[];
  rows: RdMacRowView[];
  cells: RdMacCellView[];
  pols: RdMacPolView[];
  motions: RdMacMotionView[];
  table: MacroDraftTable | null;
}

interface MacroDraftStep {
  hold: string[];
  ms: number | null;
  frames: number | null;
  allow_short: boolean;
}

export interface MacroDraftTable {
  name: string;
  steps: MacroDraftStep[];
  on_release: string;
  retrigger: string;
  interrupt: string;
  repeat: string;
  turbo_hz: number | null;
  gap_ms: number | null;
  triggers: string[];
  disabled: boolean;
}

export interface MacHost {
  root(): HTMLElement | null;
  /** The page repaint (the entry's refresh) — a save's truth comes back on
   *  the next served payload. */
  refresh(): Promise<boolean>;
}

let host: MacHost | null = null;
let macView: RdMacView | null = null;
let macViewKey = "";
let macDraft: MacroDraftTable | null = null;
let macDirty = false;
let macBusy = false;
/** Resolves when the act currently applying has finished, or null when the
 *  thing in flight is a SAVE rather than an act (nocturne's busy latch: a
 *  duration commits on the mousedown that presses Save — waiting for that
 *  act is right; dropping the press is the one outcome this must never
 *  produce; null during a save so a second press is still ignored). */
let macInFlight: Promise<void> | null = null;
let macInFlightDone: (() => void) | null = null;
let macAskedShort = false;
let macShortRow: number | null = null;
let macCloseArmed = false;
let macSayText = "";
let macSayKind: "" | "warn" | "err" = "";
let macSaveLabel = "Save this macro";

type MacroFocusAttribute =
  | "data-maccell"
  | "data-macdur"
  | "data-macrate"
  | "data-macmotion"
  | "data-macpol"
  | "data-macact"
  | "data-macfocus";

interface MacroFocusBookmark {
  attribute: MacroFocusAttribute;
  value: string;
}

interface MacroReturnTarget {
  element: HTMLElement | null;
  name: string;
  slot: string;
}

let macWiredRoot: HTMLElement | null = null;
let macDialogWasOpen = false;
let macDialogIdentity = "";
let macGridFocusCell: string | null = null;
let macFocusBookmark: MacroFocusBookmark | null = null;
let macReturnTarget: MacroReturnTarget | null = null;
let macCloseRefreshPending = false;
let macFocusEpoch = 0;
let macRestoringFocus = false;

function macroDoor(target: EventTarget | null): HTMLAnchorElement | null {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor) return null;
  try {
    const url = new URL(anchor.href, window.location.origin);
    return url.pathname === "/redesign" && url.searchParams.has("macro") ? anchor : null;
  } catch {
    return null;
  }
}

function rememberMacroOpener(anchor: HTMLAnchorElement): void {
  if (macRestoringFocus) return;
  const url = new URL(anchor.href, window.location.origin);
  macReturnTarget = {
    element: anchor,
    name: url.searchParams.get("macro") ?? "",
    slot: url.searchParams.get("slot") ?? "",
  };
}

function captureMacroOpener(event: Event): void {
  const anchor = macroDoor(event.target);
  if (anchor) rememberMacroOpener(anchor);
}

export function macWire(h: MacHost): void {
  host = h;
  const root = h.root();
  if (root !== macWiredRoot) {
    macWiredRoot?.removeEventListener("click", captureMacroOpener, true);
    macWiredRoot?.removeEventListener("focusin", captureMacroOpener, true);
    macWiredRoot = root;
    macWiredRoot?.addEventListener("click", captureMacroOpener, true);
    macWiredRoot?.addEventListener("focusin", captureMacroOpener, true);
  }
  // The embedded payload is applied before the island gives this module its
  // host. A cold ?macro= URL already has complete escaped server markup: adopt
  // that exact tree so hydration cannot blank/refill the dialog. Client-only
  // opens and later draft edits keep using the safe DOM painter below.
  if (macView && !adoptServedDialog(macView)) renderDialog(macView);
}

export function rdMacOpen(): boolean {
  return macView?.open === true && !macView.back_cls.includes("none");
}

function holderEl(): HTMLElement | null {
  return host?.root()?.querySelector<HTMLElement>(".rd-macdlg") ?? null;
}

function bookmarkFor(target: Element | null): MacroFocusBookmark | null {
  if (!target) return null;
  const attributes: MacroFocusAttribute[] = [
    "data-maccell",
    "data-macdur",
    "data-macrate",
    "data-macmotion",
    "data-macpol",
    "data-macact",
    "data-macfocus",
  ];
  for (const attribute of attributes) {
    const owner = target.closest<HTMLElement>(`[${attribute}]`);
    const value = owner?.getAttribute(attribute);
    if (value !== null && value !== undefined) return { attribute, value };
  }
  return null;
}

function findBookmark(dlg: HTMLElement, bookmark: MacroFocusBookmark | null): HTMLElement | null {
  if (!bookmark) return null;
  return Array.from(dlg.querySelectorAll<HTMLElement>(`[${bookmark.attribute}]`)).find(
    (candidate) => candidate.getAttribute(bookmark.attribute) === bookmark.value,
  ) ?? null;
}

function macroFocusable(dlg: HTMLElement): HTMLElement[] {
  const candidates = dlg.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(candidates).filter((candidate) => {
    if (candidate.closest("[inert], [hidden], [aria-hidden=\"true\"]")) return false;
    return candidate.getClientRects().length > 0;
  });
}

function focusMacroTarget(target: HTMLElement | null, scrollCell = false): boolean {
  if (!target?.isConnected) return false;
  target.focus({ preventScroll: true });
  if (document.activeElement !== target) return false;
  if (scrollCell) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function focusDoorForView(root: HTMLElement, v: RdMacView): HTMLElement | null {
  const exact = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).find((anchor) => {
    try {
      const url = new URL(anchor.href, window.location.origin);
      const name = macReturnTarget?.name || v.name;
      const slot = macReturnTarget?.slot || v.slot;
      return url.pathname === "/redesign" && url.searchParams.get("macro") === name &&
        (!slot || url.searchParams.get("slot") === slot);
    } catch {
      return false;
    }
  });
  if (exact) return exact;
  const instanceId = `ctrl-slot-${macReturnTarget?.slot || v.slot}`;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-instance-id]")).find(
    (candidate) => candidate.dataset.instanceId === instanceId,
  ) ?? root.querySelector<HTMLElement>('[data-nx="rd-ctrls-open"]');
}

function restoreMacroOpener(
  v: RdMacView,
  expected: MacroReturnTarget | null,
  clearAfter: boolean,
): void {
  if (expected && macReturnTarget !== expected) return;
  const root = host?.root();
  if (!root || rdMacOpen()) return;
  let target = expected?.element?.isConnected ? expected.element : null;
  if (!target) target = focusDoorForView(root, v);
  const details = target?.closest("details");
  if (details instanceof HTMLDetailsElement) details.open = true;
  macRestoringFocus = true;
  try {
    focusMacroTarget(target);
  } finally {
    macRestoringFocus = false;
  }
  if (clearAfter && (!expected || macReturnTarget === expected)) macReturnTarget = null;
}

function scheduleMacroOpenerRestore(
  v: RdMacView,
  expected: MacroReturnTarget | null,
  clearAfter: boolean,
): void {
  window.requestAnimationFrame(() => restoreMacroOpener(v, expected, clearAfter));
}

/** The served projection arrives (payload or edit answer). THE DRAFT WINS:
 *  while dirty, only an edit answer repaints (it passes `force`). */
export function applyRdMacPayload(v: RdMacView): void {
  if (macDirty) return;
  applyView(v, false);
  seedDraft(v);
}

function seedDraft(v: RdMacView): void {
  if (macDirty) return;
  if (!v.open) {
    macDraft = null;
    macAskedShort = false;
    return;
  }
  macDraft = v.table ?? null;
}

function applyView(v: RdMacView, force: boolean): void {
  macView = v;
  const key = JSON.stringify(v);
  if (!force && key === macViewKey) return;
  macViewKey = key;
  renderDialog(v);
}

/** The editor's answer, inside the panel the reader is looking at —
 *  `.rd-flash` lives under the title bar, BEHIND this dialog's own scrim. */
function macSay(text: string, kind: "" | "warn" | "err"): void {
  macSayText = text;
  macSayKind = kind;
  const say = holderEl()?.querySelector<HTMLElement>(".n-macsay-line");
  if (say) {
    say.textContent = text;
    say.className = text
      ? `n-macsay n-macsay-line${kind ? " " + kind : ""}`
      : "n-macsay n-macsay-line none";
  }
}

function macDirtyMark(): void {
  const el = holderEl()?.querySelector<HTMLElement>(".n-macdirty");
  if (el) el.textContent = macDirty ? "Unsaved changes" : "";
  const btn = holderEl()?.querySelector<HTMLButtonElement>(".n-macsave");
  if (btn) btn.textContent = macSaveLabel;
}

/** One act, applied by the server, answered with the whole roll. */
async function macAct(act: string): Promise<void> {
  if (!macDraft || macBusy || !macView) return;
  macBusy = true;
  macInFlight = new Promise<void>((resolve) => {
    macInFlightDone = resolve;
  });
  // Which duration box has the caret, so the rebuild can hand it back.
  const focused = document.activeElement as HTMLElement | null;
  const keepRow = focused?.dataset?.macdur ?? null;
  try {
    const res = await fetch("/redesign/api/macro/edit", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ slot: Number(macView.slot) || 0, act, draft: macDraft }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const out = (await res.json()) as {
      ok: boolean;
      said: string;
      draft: MacroDraftTable;
      view: RdMacView;
    };
    // A REFUSED ACT CHANGED NOTHING (nocturne's rule): marking the macro
    // dirty over a rejected duration left the number in the box disagreeing
    // with the number Save would write.
    if (!out.ok) {
      macSay(out.said, "err");
      if (keepRow !== null) {
        const box = holderEl()?.querySelector<HTMLInputElement>(`[data-macdur="${keepRow}"]`);
        const row = macView.rows[Number(keepRow)];
        if (box && row) box.value = row.dur_val;
      }
      return;
    }
    macDraft = out.draft;
    macDirty = true;
    macAskedShort = false;
    macCloseArmed = false;
    macSaveLabel = "Save this macro";
    macSayText = "";
    macSayKind = "";
    applyView(out.view, true);
    macDirtyMark();
    if (out.said) macSay(out.said, "");
    if (keepRow !== null) {
      holderEl()?.querySelector<HTMLInputElement>(`[data-macdur="${keepRow}"]`)?.focus();
    }
  } catch {
    macSay("The studio did not answer — is ksx still running?", "err");
  } finally {
    macBusy = false;
    macInFlightDone?.();
    macInFlight = null;
    macInFlightDone = null;
  }
}

/** Write the whole table, through the same verb the CLI uses. A step under
 *  the sampling floor is never refused and never written silently: the
 *  first Save asks, and says which steps it is about. */
async function macSave(): Promise<void> {
  if (!macDraft || !macView) return;
  if (macBusy) {
    if (!macInFlight) return;
    await macInFlight;
    if (!macDraft || macBusy) return;
  }
  const short = macView.rows.filter((r) => r.short);
  if (short.length > 0 && !macAskedShort) {
    macAskedShort = true;
    macSaveLabel = "Save it anyway";
    macDirtyMark();
    macSay(
      `${short.length === 1 ? "Step" : "Steps"} ${short
        .map((r) => r.n)
        .join(", ")} ${short.length === 1 ? "is" : "are"} shorter than the 60 Hz floor. ` +
        "ksx will raise them to 33 ms unless the step allows a short one — press Save again to write it.",
      "warn",
    );
    return;
  }
  macBusy = true;
  try {
    const res = await fetch("/api/macro/save", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        target: "stage",
        slot: Number(macView.slot) || 0,
        preset: macView.preset,
        name: macDraft.name,
        steps: macDraft.steps,
        on_release: macDraft.on_release,
        retrigger: macDraft.retrigger,
        interrupt: macDraft.interrupt,
        repeat: macDraft.repeat,
        turbo_hz: macDraft.turbo_hz,
        gap_ms: macDraft.gap_ms,
        // ⚠️ THE WHOLE TABLE MEANS THE WHOLE TABLE (nocturne's scar):
        // omitting this rewrote a DISABLED macro with the default, so
        // editing one duration on a macro you had switched off started it
        // firing again.
        enabled: !macDraft.disabled,
      }),
    });
    const out = (await res.json()) as { ok: boolean; error?: string; problems?: string[] };
    if (out.ok) {
      macDirty = false;
      macAskedShort = false;
      macSaveLabel = "Save this macro";
      macDirtyMark();
      macSay(`Saved “${macDraft.name}”.`, "");
      void host?.refresh();
    } else {
      const why = [out.error ?? "The macro was refused.", ...(out.problems ?? [])].join(" ");
      macSay(why, "err");
    }
  } catch {
    macSay("The studio did not answer — is ksx still running?", "err");
  } finally {
    macBusy = false;
  }
}

/** Leave the editor the way nocturne's ✕ does — the dialog's open state IS
 *  the URL. Unsaved work is never dropped on the first press: the editor
 *  says what closing would cost, and a second press closes anyway. */
export function rdMacClose(): void {
  if (macDirty && macDraft && !macCloseArmed) {
    macSay(
      `“${macDraft.name}” has unsaved changes — closing discards them. Press Save first, ` +
        "or close again to discard.",
      "warn",
    );
    macCloseArmed = true;
    return;
  }
  macDirty = false;
  macCloseArmed = false;
  macDraft = null;
  macAskedShort = false;
  macSayText = "";
  macSayKind = "";
  macSaveLabel = "Save this macro";
  const url = new URL(window.location.href);
  url.searchParams.delete("macro");
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", query ? `${url.pathname}?${query}` : url.pathname);
  // Close NOW (the served answer confirms on the next payload).
  const closingView = macView;
  const returnTarget = macReturnTarget;
  macCloseRefreshPending = true;
  if (macView) applyView({ ...macView, open: false, back_cls: "nd-back none" }, true);
  const refresh = host?.refresh();
  if (!refresh || !closingView) {
    macCloseRefreshPending = false;
    if (closingView) scheduleMacroOpenerRestore(closingView, returnTarget, true);
    return;
  }
  void refresh.finally(() => {
    macCloseRefreshPending = false;
    restoreMacroOpener(closingView, returnTarget, true);
  });
}

/** The dialog's clicks, dispatched by the island's one listener. Returns
 *  true when the click belonged to the editor. */
export function rdMacClick(target: HTMLElement | null): boolean {
  if (!target) return false;
  const cell = target.closest<HTMLElement>("[data-maccell]");
  if (cell) {
    void macAct(`cell|${cell.dataset.maccell}`);
    return true;
  }
  const motion = target.closest<HTMLElement>("[data-macmotion]");
  if (motion) {
    void macAct(`motion|${motion.dataset.macmotion}`);
    return true;
  }
  const pol = target.closest<HTMLElement>("[data-macpol]");
  if (pol) {
    void macAct(`pol|${pol.dataset.macpol}`);
    return true;
  }
  const act = target.closest<HTMLElement>("[data-macact]");
  if (!act) return false;
  const verb = act.dataset.macact ?? "";
  if (verb === "save") {
    void macSave();
    return true;
  }
  if (verb === "short") {
    // The flag belongs to a STEP that the floor would really raise: the row
    // whose duration was last touched IF that row is short, else the first
    // row that is.
    const rows = macView?.rows ?? [];
    const touched = macShortRow !== null && rows[macShortRow]?.short ? macShortRow : null;
    const row = touched ?? rows.findIndex((r) => r.short);
    if (row < 0) {
      macSay("No step here is shorter than the 33 ms floor — there is nothing to allow.", "warn");
      return true;
    }
    void macAct(`short|${row}`);
    return true;
  }
  void macAct(verb);
  return true;
}

/** The dialog's change events — a duration commits when the author leaves
 *  it or presses Enter, never on every keystroke. */
export function rdMacChange(target: HTMLElement | null): boolean {
  const box = target?.closest<HTMLInputElement>("[data-macdur]");
  if (box) {
    macShortRow = Number(box.dataset.macdur);
    void macAct(`dur|${box.dataset.macdur}|${box.value}`);
    return true;
  }
  const rate = target?.closest<HTMLInputElement>("[data-macrate]");
  if (rate) {
    void macAct(`rate|${rate.value}`);
    return true;
  }
  return false;
}

// ── The dialog, painted from the served view ─────────────────────────────
function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(cls: string, text: string, attrs: Record<string, string>): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
}

function gridRows(grid: HTMLElement): HTMLElement[][] {
  return Array.from(grid.children)
    .filter((candidate): candidate is HTMLElement =>
      candidate instanceof HTMLElement && candidate.getAttribute("role") === "row"
    )
    .map((row) => Array.from(row.querySelectorAll<HTMLElement>('[role="gridcell"]')));
}

function moveGridFocus(cell: HTMLElement, event: KeyboardEvent): boolean {
  const grid = cell.closest<HTMLElement>('[role="grid"]');
  if (!grid) return false;
  const rows = gridRows(grid);
  const rowIndex = rows.findIndex((row) => row.includes(cell));
  const colIndex = rowIndex >= 0 ? rows[rowIndex].indexOf(cell) : -1;
  if (rowIndex < 0 || colIndex < 0) return false;

  let nextRow = rowIndex;
  let nextCol = colIndex;
  const wholeGrid = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case "ArrowLeft":
      nextCol -= 1;
      break;
    case "ArrowRight":
      nextCol += 1;
      break;
    case "ArrowUp":
      nextRow -= 1;
      break;
    case "ArrowDown":
      nextRow += 1;
      break;
    case "Home":
      nextRow = wholeGrid ? 0 : rowIndex;
      nextCol = 0;
      break;
    case "End":
      nextRow = wholeGrid ? rows.length - 1 : rowIndex;
      nextCol = Number.MAX_SAFE_INTEGER;
      break;
    default:
      return false;
  }
  event.preventDefault();
  event.stopPropagation();
  nextRow = Math.min(Math.max(nextRow, 0), rows.length - 1);
  const destinationRow = rows[nextRow];
  if (!destinationRow?.length) return true;
  nextCol = Math.min(Math.max(nextCol, 0), destinationRow.length - 1);
  const next = destinationRow[nextCol];
  for (const candidate of rows.flat()) candidate.tabIndex = candidate === next ? 0 : -1;
  macGridFocusCell = next.dataset.maccell ?? null;
  macFocusBookmark = bookmarkFor(next);
  focusMacroTarget(next, true);
  return true;
}

function handleMacDialogFocus(event: FocusEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const bookmark = bookmarkFor(target);
  if (bookmark) macFocusBookmark = bookmark;
  const cell = target?.closest<HTMLElement>("[data-maccell]");
  if (cell) macGridFocusCell = cell.dataset.maccell ?? null;
}

function handleMacDialogKey(event: KeyboardEvent): void {
  const dlg = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!dlg) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    rdMacClose();
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const duration = target?.closest<HTMLInputElement>("[data-macdur]");
  if (duration && event.key === "Enter") {
    event.preventDefault();
    duration.blur();
    return;
  }
  const cell = target?.closest<HTMLElement>("[data-maccell]");
  if (cell && moveGridFocus(cell, event)) return;
  if (event.key !== "Tab") return;

  const focusable = macroFocusable(dlg);
  if (focusable.length === 0) {
    event.preventDefault();
    dlg.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  const at = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
  const wrapsBackward = event.shiftKey && at <= 0;
  const wrapsForward = !event.shiftKey && (at < 0 || at === focusable.length - 1);
  if (!wrapsBackward && !wrapsForward) return;
  event.preventDefault();
  event.stopPropagation();
  focusMacroTarget(event.shiftKey ? focusable[focusable.length - 1] : focusable[0]);
}

function scheduleDialogFocus(
  dlg: HTMLElement,
  bookmark: MacroFocusBookmark | null,
  opening: boolean,
  epoch: number,
): void {
  window.requestAnimationFrame(() => {
    if (epoch !== macFocusEpoch || !rdMacOpen() || !dlg.isConnected) return;
    const target = opening
      ? dlg.querySelector<HTMLElement>('[data-macfocus="close-top"]')
      : findBookmark(dlg, bookmark) ??
        dlg.querySelector<HTMLElement>('[data-macfocus="close-top"]');
    focusMacroTarget(target, Boolean(target?.matches("[data-maccell]")));
  });
}

/** Adopt the complete first-paint dialog emitted for a cold `?macro=` URL.
 * The server and payload were composed together, so this marker is stronger
 * than re-deriving a client checksum. Only listeners, roving-focus memory and
 * the initial focus move are client-owned; the visible tree is left intact. */
function adoptServedDialog(v: RdMacView): boolean {
  if (!v.open) return false;
  const holder = holderEl();
  const dlg = holder?.querySelector<HTMLElement>(".nd-mac");
  if (!holder || !dlg?.querySelector("[data-rd-mac-ssr]")) return false;

  holder.className = `rd-macdlg ${v.back_cls}`;
  macDialogWasOpen = true;
  macDialogIdentity = `${v.slot}\u0000${v.name}`;
  macGridFocusCell =
    dlg.querySelector<HTMLElement>('[data-maccell][tabindex="0"]')?.dataset.maccell ??
    dlg.querySelector<HTMLElement>("[data-maccell]")?.dataset.maccell ??
    null;
  const epoch = ++macFocusEpoch;
  dlg.onkeydown = handleMacDialogKey;
  dlg.removeEventListener("focusin", handleMacDialogFocus);
  dlg.addEventListener("focusin", handleMacDialogFocus);
  scheduleDialogFocus(dlg, null, true, epoch);
  return true;
}

function renderDialog(v: RdMacView): void {
  const holder = holderEl();
  if (!holder) return;
  holder.className = `rd-macdlg ${v.back_cls}`;
  const dlg = holder.querySelector<HTMLElement>(".nd-mac");
  if (!dlg) return;
  const wasOpen = macDialogWasOpen;
  const identity = `${v.slot}\u0000${v.name}`;
  const changedDialog = identity !== macDialogIdentity;
  const active = document.activeElement;
  const activeBookmark = active instanceof Element && dlg.contains(active)
    ? bookmarkFor(active)
    : null;
  const continuingBookmark = activeBookmark ?? macFocusBookmark;
  const epoch = ++macFocusEpoch;
  if (!v.open) {
    dlg.replaceChildren();
    macDialogWasOpen = false;
    macDialogIdentity = "";
    macGridFocusCell = null;
    macFocusBookmark = null;
    if (wasOpen) {
      scheduleMacroOpenerRestore(v, macReturnTarget, !macCloseRefreshPending);
    }
    return;
  }

  const opening = !wasOpen || changedDialog;
  if (opening) {
    if (!macReturnTarget && active instanceof HTMLElement && active !== document.body &&
      !holder.contains(active)) {
      macReturnTarget = { element: active, name: v.name, slot: v.slot };
    }
    macGridFocusCell = null;
    macFocusBookmark = null;
  }
  const restoreBookmark = opening ? null : continuingBookmark;
  macDialogWasOpen = true;
  macDialogIdentity = identity;
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("tabindex", "-1");
  dlg.onkeydown = handleMacDialogKey;
  dlg.addEventListener("focusin", handleMacDialogFocus);

  // ── Header ──
  const head = el("div", "n-machd");
  const title = el("div", "nd-title", v.name);
  title.id = "rd-mac-title";
  const note = el("div", "n-macdis", v.note);
  note.id = "rd-mac-description";
  dlg.removeAttribute("aria-label");
  dlg.setAttribute("aria-labelledby", title.id);
  dlg.setAttribute("aria-describedby", note.id);
  head.append(
    el("div", "nd-kick", "Macro"),
    title,
    el("div", "nd-lede", v.trigger),
    el("div", "n-macmeta", v.head),
    note,
  );
  const say = el(
    "div",
    macSayText ? `n-macsay n-macsay-line${macSayKind ? " " + macSayKind : ""}` : "n-macsay n-macsay-line none",
    macSayText,
  );
  say.setAttribute("role", "status");
  head.append(say);
  const close = document.createElement("a");
  close.className = "n-macx";
  close.dataset.nx = "mac-close";
  close.dataset.macfocus = "close-top";
  close.setAttribute("aria-label", "Close the macro editor");
  close.href = v.close_href;
  close.textContent = "✕";
  head.append(close);

  // ── The roll: step bar + scrolling matrix ──
  const roll = el("div", v.grid_cls);
  const bar = el("div", "n-macbar");
  bar.append(el("div", "n-macbarhd", "step"));
  for (const r of v.rows) {
    const row = el("div", r.cls);
    row.title = r.dur_title;
    row.append(el("span", "n-macn", r.n), el("span", r.hold_cls, r.hold));
    const exp = el("span", r.exp_cls, r.exp);
    exp.title = r.exp;
    row.append(exp, el("span", "n-macdurw", r.dur));
    const dured = el("span", "n-macdured");
    const dur = document.createElement("input");
    dur.type = "number";
    dur.min = "1";
    dur.step = "1";
    dur.value = r.dur_val;
    dur.title = r.dur_title;
    dur.dataset.macdur = r.dur_row;
    dur.className = r.dur_cls;
    dured.append(
      dur,
      btn("n-macunit", r.unit, { title: r.unit_title, "data-macact": r.unit_act }),
    );
    row.append(dured);
    const warn = el("span", r.warn_cls, r.warn);
    warn.title = r.warn_title;
    row.append(warn);
    const verbs = el("span", "n-macverbs");
    verbs.append(
      btn(r.up_cls, "▴", { title: "Move this step up", "aria-label": "Move this step up", "data-macact": r.up_act }),
      btn(r.dn_cls, "▾", { title: "Move this step down", "aria-label": "Move this step down", "data-macact": r.dn_act }),
      btn("n-macbtn", "⤒", { title: "Insert a step above this one", "aria-label": "Insert a step above this one", "data-macact": r.ia_act }),
      btn("n-macbtn", "⤓", { title: "Insert a step below this one", "aria-label": "Insert a step below this one", "data-macact": r.ib_act }),
      btn("n-macbtn del", "✕", { title: r.del_title, "aria-label": r.del_title, "data-macact": r.del_act }),
    );
    row.append(verbs);
    bar.append(row);
  }
  const scroll = el("div", "n-macscroll");
  const grps = el("div", "n-macgrps");
  for (const g of v.groups) {
    const grp = el("span", g.cls);
    grp.append(el("span", "n-macgrp-l", g.label), el("span", g.count_cls, g.count));
    grps.append(grp);
  }
  const cols = el("div", "n-maccols");
  for (const c of v.cols) {
    const col = el("span", c.cls, c.id);
    col.title = c.title;
    cols.append(col);
  }
  const matrix = el("div", "n-macmatrix");
  matrix.setAttribute("role", "grid");
  matrix.setAttribute("aria-label", `Steps by control for ${v.name}`);
  matrix.setAttribute("aria-multiselectable", "true");
  const colCount = Math.max(v.cols.length, 1);
  const rowCount = Math.ceil(v.cells.length / colCount);
  matrix.setAttribute("aria-colcount", String(v.cols.length));
  matrix.setAttribute("aria-rowcount", String(rowCount));
  matrix.style.gridTemplateColumns = `repeat(${colCount}, var(--maccol-w))`;
  const servedRoving = v.cells.find((cell) => cell.tab === "0")?.cell ?? v.cells[0]?.cell ?? null;
  const rememberedRoving = restoreBookmark?.attribute === "data-maccell"
    ? restoreBookmark.value
    : macGridFocusCell;
  const rovingCell = v.cells.some((cell) => cell.cell === rememberedRoving)
    ? rememberedRoving
    : servedRoving;
  macGridFocusCell = rovingCell;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const gridRow = el("div", "n-macgridrow");
    gridRow.setAttribute("role", "row");
    gridRow.setAttribute("aria-rowindex", String(rowIndex + 1));
    gridRow.setAttribute("aria-label", `Step ${v.rows[rowIndex]?.n ?? rowIndex + 1}`);
    gridRow.style.display = "grid";
    gridRow.style.gridTemplateColumns = `repeat(${colCount}, var(--maccol-w))`;
    gridRow.style.gridColumn = "1 / -1";
    const from = rowIndex * colCount;
    const rowCells = v.cells.slice(from, from + colCount);
    for (let colIndex = 0; colIndex < rowCells.length; colIndex += 1) {
      const c = rowCells[colIndex];
      const cell = btn(c.cls, c.mark, {
        title: c.title,
        "aria-label": c.title,
        "aria-selected": c.on === "true" ? "true" : "false",
        "aria-rowindex": String(rowIndex + 1),
        "aria-colindex": String(colIndex + 1),
        role: "gridcell",
        tabindex: c.cell === rovingCell ? "0" : "-1",
        "data-maccell": c.cell,
      });
      gridRow.append(cell);
    }
    matrix.append(gridRow);
  }
  scroll.append(grps, cols, matrix);
  roll.append(bar, scroll);

  // ── Help, edit verbs, motions, policies, TOML, foot ──
  const help = document.createElement("details");
  help.className = "n-machelp";
  const helpSum = document.createElement("summary");
  helpSum.dataset.macfocus = "help";
  helpSum.textContent = "How to read this roll";
  help.append(helpSum, el("p", "n-macring", v.ring), el("p", "n-macrule", v.rule));

  const edit = el("div", "n-macedit");
  edit.append(
    btn("n-bbtn", "Add step", { "data-macact": "add" }),
    btn("n-bbtn ghost", "Allow a short step", { "data-macact": "short" }),
  );

  const motions = el("div", "n-macmotions");
  motions.append(el("div", "n-kick", "Common motions"), el("p", "n-macmotline", v.motion_line));
  const motionRow = el("div", "n-macmotrow");
  for (const m of v.motions) {
    const mbtn = btn("n-macmot", "", { title: m.title, "data-macmotion": m.act });
    mbtn.append(el("span", "n-macmot-s", m.shape), el("span", "n-macmot-l", m.label));
    motionRow.append(mbtn);
  }
  motions.append(motionRow);

  const pols = el("div", "n-macpols");
  pols.append(el("div", "n-kick", "Behaviour"), el("p", "n-macpolline", v.policy_line));
  for (const o of v.pols) {
    const wrap = el("span", "n-macpolw");
    wrap.append(
      el("span", o.head_cls, o.head),
      el("span", o.note_cls, o.note),
      btn(o.cls, o.label, { title: o.title, "data-macpol": o.act }),
    );
    pols.append(wrap);
  }
  const rate = document.createElement("label");
  rate.className = v.turbo_cls;
  rate.append(el("span", "n-macratel", v.turbo_label));
  const rateBox = document.createElement("input");
  rateBox.type = "number";
  rateBox.min = "1";
  rateBox.step = "1";
  rateBox.dataset.macrate = "1";
  rateBox.value = v.turbo_val;
  rate.append(rateBox);
  pols.append(rate);

  const toml = document.createElement("details");
  toml.className = "n-mactoml";
  const tomlSum = document.createElement("summary");
  tomlSum.dataset.macfocus = "table";
  tomlSum.textContent = "The table this writes";
  toml.append(tomlSum, el("pre", "n-mactomlbox", v.toml));

  const foot = el("div", "n-macfoot");
  foot.append(
    el("span", "n-macdirty", macDirty ? "Unsaved changes" : ""),
    btn("n-bbtn n-macsave", macSaveLabel, { "data-macact": "save" }),
  );
  const closeBtn = document.createElement("a");
  closeBtn.className = "n-bbtn ghost";
  closeBtn.dataset.nx = "mac-close";
  closeBtn.dataset.macfocus = "close-bottom";
  closeBtn.href = v.close_href;
  closeBtn.textContent = "Close";
  foot.append(closeBtn);

  dlg.replaceChildren(head, roll, help, edit, motions, pols, toml, foot);
  scheduleDialogFocus(dlg, restoreBookmark, opening, epoch);
}
