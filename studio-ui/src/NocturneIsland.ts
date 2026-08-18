import { createList, createShow, createSignal, h } from "@getforma/core";
import { fetchJSON } from "@getforma/core/http";

// ── /nocturne — THE NOCTURNE FRONT END, MIGRATING ONTO THE REAL BACKEND ────
//
// Migration state (2026-08-17, pass 5): the KEYBOARD pane, the CONTROLLER
// RACK, the BINDING LIST with its LEARN-DRIVEN REBIND EDITOR, the dressed
// keyboard diagram, the stage's meta bar and the SESSION verbs are REAL —
// served by render_nocturne.rs off the live machine scan, the daemon-held
// draft and the session, and mutated only through real verbs. No invented
// values remain on the page: what cannot be real yet is either absent or
// says so in a served sentence. Still to migrate: the configuration menu's
// contents and the live input echo.
//
// The compiler contracts this file obeys (earned the hard way; see the
// FORMA-DOGFOOD additions): `...CONST.map(…)` unrolls only FLAT module-level
// arrays of OBJECT literals; every dynamic binding is an ARROW-WRAPPED
// getter; every dynamic attribute is the LAST prop on its element; list
// bodies are member reads; no helper functions returning h(); visibility is
// class-driven (`… none`) rather than nested createShow.

// ── Served row shapes (copied from snapshot.rs, never derived here) ────────

export interface NocturneDeviceRowView {
  cls: string;
  name: string;
  meta: string;
  selector: string;
  alias: string;
  label: string;
}

export interface NocturneOtherRowView {
  name: string;
  meta: string;
}

export interface NocturneChoiceRowView {
  name: string;
  title: string;
  detail: string;
  cls: string;
}

export interface NocturneRackRowView {
  number: string;
  badge: string;
  name: string;
  meta: string;
  cls: string;
  href: string;
}

export interface NocturneEmptyRowView {
  badge: string;
}

export interface NocturnePersonaRowView {
  name: string;
  label: string;
  api: string;
  note: string;
  cls: string;
}

export interface NocturneOptionRowView {
  value: string;
  label: string;
}

export interface NocturneKeyCellView {
  cap: string;
  key: string;
  cls: string;
  short: string;
  title: string;
}

export interface NocturneMacroRowView {
  name: string;
  fn_name: string;
  chip: string;
  chip_cls: string;
  meta: string;
  cls: string;
  slot: string;
  edit_href: string;
  toggle_label: string;
  toggle_value: string;
}

export interface NocturneGameRowView {
  title: string;
  meta: string;
  cls: string;
  ico_cls: string;
}

export interface NocturneBindRowView {
  function: string;
  label: string;
  chip: string;
  note: string;
  cls: string;
  chip_cls: string;
  clear_cls: string;
  slot: string;
  turbo: string;
  hold_cls: string;
  tog_cls: string;
}

export interface NocturneView {
  dev_count: string;
  dev_note: string;
  kb_title: string;
  mode_note: string;
  dev_rows: NocturneDeviceRowView[];
  dev_exp: NocturneDeviceRowView[];
  dev_other: NocturneOtherRowView[];
  exp_head: string;
  exp_fold_cls: string;
  other_head: string;
  other_fold_cls: string;
  mode_rows: NocturneChoiceRowView[];
  cap_line: string;
  capd_cls: string;
  cap_sw_cls: string;
  cap_selector: string;
  cap_instance: string;
  cap_prepare: boolean;
  cap_release: boolean;
  version: string;
  chip_text: string;
  save_text: string;
  escape_line: string;
  play_cls: string;
  stop_cls: string;
  rack_rows: NocturneRackRowView[];
  rack_empty: NocturneEmptyRowView[];
  rack_caption: string;
  add_lede: string;
  add_preset: string;
  persona_rows: NocturnePersonaRowView[];
  layout_opts: NocturneOptionRowView[];
  socd_opts: NocturneOptionRowView[];
  pad_badge: string;
  pad_name: string;
  pad_sub: string;
  pad_xbox_cls: string;
  pad_ps_cls: string;
  bind_title: string;
  bind_rows: NocturneBindRowView[];
  bind_foot: string;
  macros_head: string;
  macro_rows: NocturneMacroRowView[];
  macros_note: string;
  kb_row1: NocturneKeyCellView[];
  kb_row2: NocturneKeyCellView[];
  kb_row3: NocturneKeyCellView[];
  kb_row4: NocturneKeyCellView[];
  kb_row5: NocturneKeyCellView[];
  kb_row6: NocturneKeyCellView[];
  kb_tray: NocturneKeyCellView[];
  kb_tray_head: string;
  kb_tray_cls: string;
  kb_note: string;
  cfg_line: string;
  cfg_meta: string;
  cfg_cls: string;
  cfg_check: string;
  adopt_cls: string;
  discard_note: string;
  games_head: string;
  game_rows: NocturneGameRowView[];
  games_note: string;
  auto_line: string;
  auto_sw_cls: string;
  auto_dir: string;
  auto_btn: string;
  auto_note: string;
  auto_form_cls: string;
}

export interface NocturnePayload {
  unavailable: string;
  view: NocturneView;
  /// The raw session fact the payload carries beside the derived view — the
  /// live echo's license (fail-closed origin rule) and its uptime clock.
  session?: {
    reachable: boolean;
    running: boolean;
    origin: string;
    profile: string | null;
    active?: { elapsed: string } | null;
  };
}

// ── SERVED signals — copiers, never derivers ───────────────────────────────

const [nDevCount, setNDevCount] = createSignal("");
const [nModeNote, setNModeNote] = createSignal("");
const [nDevNote, setNDevNote] = createSignal("");
const [nDevRows, setNDevRows] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevExp, setNDevExp] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevOther, setNDevOther] = createSignal<NocturneOtherRowView[]>([]);
const [nExpHead, setNExpHead] = createSignal("");
const [nExpFoldCls, setNExpFoldCls] = createSignal("n-devfold none");
const [nOtherHead, setNOtherHead] = createSignal("");
const [nOtherFoldCls, setNOtherFoldCls] = createSignal("n-devfold none");
const [nModeRows, setNModeRows] = createSignal<NocturneChoiceRowView[]>([]);
const [nKbTitle, setNKbTitle] = createSignal("");
const [nCapLine, setNCapLine] = createSignal("");
const [nCapdCls, setNCapdCls] = createSignal("n-capd none");
const [nCapSwCls, setNCapSwCls] = createSignal("n-capsw");
const [nCapSelector, setNCapSelector] = createSignal("");
const [nCapInstance, setNCapInstance] = createSignal("");
const [nCapPrep, setNCapPrep] = createSignal(false);
const [nCapRel, setNCapRel] = createSignal(false);
const [nVersion, setNVersion] = createSignal("");
const [nChipText, setNChipText] = createSignal("");
const [nSaveText, setNSaveText] = createSignal("");
const [nEscapeLine, setNEscapeLine] = createSignal("");
const [nPlayCls, setNPlayCls] = createSignal("n-play");
const [nStopCls, setNStopCls] = createSignal("n-stop none");
const [nRackRows, setNRackRows] = createSignal<NocturneRackRowView[]>([]);
const [nRackEmpty, setNRackEmpty] = createSignal<NocturneEmptyRowView[]>([]);
const [nRackCaption, setNRackCaption] = createSignal("");
const [nAddLede, setNAddLede] = createSignal("");
const [nAddPreset, setNAddPreset] = createSignal("");
const [nPersonaRows, setNPersonaRows] = createSignal<NocturnePersonaRowView[]>([]);
const [nLayoutOpts, setNLayoutOpts] = createSignal<NocturneOptionRowView[]>([]);
const [nSocdOpts, setNSocdOpts] = createSignal<NocturneOptionRowView[]>([]);
const [nPadBadge, setNPadBadge] = createSignal("");
const [nPadName, setNPadName] = createSignal("");
const [nPadSub, setNPadSub] = createSignal("");
const [nPadXboxCls, setNPadXboxCls] = createSignal("n-padwrap");
const [nPadPsCls, setNPadPsCls] = createSignal("n-padwrap none");
const [nBindTitle, setNBindTitle] = createSignal("");
const [nBindRows, setNBindRows] = createSignal<NocturneBindRowView[]>([]);
const [nBindFoot, setNBindFoot] = createSignal("");
const [nMacrosHead, setNMacrosHead] = createSignal("");
const [nMacroRows, setNMacroRows] = createSignal<NocturneMacroRowView[]>([]);
const [nMacrosNote, setNMacrosNote] = createSignal("");
const [nKbRow1, setNKbRow1] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow2, setNKbRow2] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow3, setNKbRow3] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow4, setNKbRow4] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow5, setNKbRow5] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow6, setNKbRow6] = createSignal<NocturneKeyCellView[]>([]);
const [nKbTray, setNKbTray] = createSignal<NocturneKeyCellView[]>([]);
const [nKbTrayHead, setNKbTrayHead] = createSignal("");
const [nKbTrayCls, setNKbTrayCls] = createSignal("n-kbtray none");
const [nKbNote, setNKbNote] = createSignal("");
const [nCfgLine, setNCfgLine] = createSignal("");
const [nCfgMeta, setNCfgMeta] = createSignal("");
const [nCfgCls, setNCfgCls] = createSignal("nm-cfg");
const [nCfgCheck, setNCfgCheck] = createSignal("");
const [nAdoptCls, setNAdoptCls] = createSignal("nm-item none");
const [nDiscardNote, setNDiscardNote] = createSignal("");
const [nGamesHead, setNGamesHead] = createSignal("");
const [nGameRows, setNGameRows] = createSignal<NocturneGameRowView[]>([]);
const [nGamesNote, setNGamesNote] = createSignal("");
const [nAutoLine, setNAutoLine] = createSignal("");
const [nAutoSwCls, setNAutoSwCls] = createSignal("n-capsw");
const [nAutoDir, setNAutoDir] = createSignal("");
const [nAutoBtn, setNAutoBtn] = createSignal("");
const [nAutoNote, setNAutoNote] = createSignal("");
const [nAutoFormCls, setNAutoFormCls] = createSignal("n-capform none");

// The action flash. The server fills these from the allowlisted query
// parameter on a full-page load; the fetch-submit layer applies the same
// copy here. A poll is not an action and never touches them.
const [nFlashLine, setNFlashLine] = createSignal("");
const [nFlashCls, setNFlashCls] = createSignal("n-flash none");

/** Copy one served payload into the signals. */
export function applyNocturne(p: NocturnePayload): void {
  const v = p.view;
  setNDevCount(v.dev_count);
  setNModeNote(v.mode_note);
  setNDevNote(v.dev_note);
  setNKbTitle(v.kb_title);
  setNDevRows(v.dev_rows);
  setNDevExp(v.dev_exp);
  setNDevOther(v.dev_other);
  setNExpHead(v.exp_head);
  setNExpFoldCls(v.exp_fold_cls);
  setNOtherHead(v.other_head);
  setNOtherFoldCls(v.other_fold_cls);
  setNModeRows(v.mode_rows);
  setNCapLine(v.cap_line);
  setNCapdCls(v.capd_cls);
  setNCapSwCls(v.cap_sw_cls);
  setNCapSelector(v.cap_selector);
  setNCapInstance(v.cap_instance);
  setNCapPrep(v.cap_prepare);
  setNCapRel(v.cap_release);
  setNVersion(v.version);
  setNChipText(v.chip_text);
  setNSaveText(v.save_text);
  setNEscapeLine(v.escape_line);
  setNPlayCls(v.play_cls);
  setNStopCls(v.stop_cls);
  setNRackRows(v.rack_rows);
  setNRackEmpty(v.rack_empty);
  setNRackCaption(v.rack_caption);
  setNAddLede(v.add_lede);
  setNAddPreset(v.add_preset);
  setNPersonaRows(v.persona_rows);
  setNLayoutOpts(v.layout_opts);
  setNSocdOpts(v.socd_opts);
  setNPadBadge(v.pad_badge);
  setNPadName(v.pad_name);
  setNPadSub(v.pad_sub);
  setNPadXboxCls(v.pad_xbox_cls);
  setNPadPsCls(v.pad_ps_cls);
  setNBindTitle(v.bind_title);
  setNBindRows(v.bind_rows);
  setNBindFoot(v.bind_foot);
  setNMacrosHead(v.macros_head);
  setNMacroRows(v.macro_rows);
  setNMacrosNote(v.macros_note);
  setNKbRow1(v.kb_row1);
  setNKbRow2(v.kb_row2);
  setNKbRow3(v.kb_row3);
  setNKbRow4(v.kb_row4);
  setNKbRow5(v.kb_row5);
  setNKbRow6(v.kb_row6);
  setNKbTray(v.kb_tray);
  setNKbTrayHead(v.kb_tray_head);
  setNKbTrayCls(v.kb_tray_cls);
  setNKbNote(v.kb_note);
  setNCfgLine(v.cfg_line);
  setNCfgMeta(v.cfg_meta);
  setNCfgCls(v.cfg_cls);
  setNCfgCheck(v.cfg_check);
  setNAdoptCls(v.adopt_cls);
  setNDiscardNote(v.discard_note);
  setNGamesHead(v.games_head);
  setNGameRows(v.game_rows);
  setNGamesNote(v.games_note);
  setNAutoLine(v.auto_line);
  setNAutoSwCls(v.auto_sw_cls);
  setNAutoDir(v.auto_dir);
  setNAutoBtn(v.auto_btn);
  setNAutoNote(v.auto_note);
  setNAutoFormCls(v.auto_form_cls);
  // The live echo's license rides the same payload (fail-closed origin).
  reconcileLiveSession(p);
}

/** The poll could not reach the server: say so, change nothing else. */
export function applyNocturneUnreachable(): void {
  setNDevCount("unavailable");
  setNDevNote("ksx could not be reached — this list may be stale. Reopen ksx.");
}

/** Report one action outcome (the redirect's allowlisted ?flash= copy), and
 *  settle any in-flight identify banner. */
export function applyFlash(flash: string | null): void {
  ui.identify = false;
  // A dialog or menu whose form just answered is done — the flash line and
  // the refreshed panes are the answer now.
  ui.dlg = false;
  applyNocturneUi();
  closeMenu();
  if (!flash || !flash.trim()) return;
  const err = flash.startsWith("error");
  setNFlashLine(flash.replace(/^error:\s*/, ""));
  setNFlashCls(err ? "n-flash err" : "n-flash ok");
}

// ── CLIENT-ONLY UI state: dialogs, rails, the identify banner ──────────────
// The configuration menu is NOT here: it is a native `details` since the
// menu pass, so its verbs work with scripting off and its served facts paint
// on the SSR pass. JS only adds outside-click dismissal.

const [nDlgOpen, setNDlgOpen] = createSignal(false);
const [nLeftCls, setNLeftCls] = createSignal("n-left");
const [nRightCls, setNRightCls] = createSignal("n-right");
const [nIdLinkCls, setNIdLinkCls] = createSignal("n-link");
const [nIdBoxCls, setNIdBoxCls] = createSignal("n-idbox none");
const [nIdText, setNIdText] = createSignal("Press a key on the keyboard you want to use");

const ui: {
  dlg: boolean;
  leftRail: boolean;
  rightRail: boolean;
  identify: boolean;
} = {
  dlg: false,
  leftRail: false,
  rightRail: false,
  identify: false,
};

function applyNocturneUi(): void {
  setNDlgOpen(ui.dlg);
  setNLeftCls(ui.leftRail ? "n-left rail" : "n-left");
  setNRightCls(ui.rightRail ? "n-right rail" : "n-right");
  setNIdLinkCls(ui.identify ? "n-link on" : "n-link");
  setNIdBoxCls(ui.identify ? "n-idbox listen" : "n-idbox none");
  setNIdText("Press a key on the keyboard you want to use");
}

/** Close the configuration menu (a native details, not signal state). */
function closeMenu(): void {
  learnRoot?.querySelector(".n-chipd[open]")?.removeAttribute("open");
}

// ── The learn flow (ported from map.ts, single-target) ─────────────────────
// click Rebind/Add → POST /api/learn/start → poll GET /api/learn every 33 ms
// until hit / timeout / cancelled → on hit POST /nocturne/api/bind (conflict
// → the consequence dialog re-POSTs with force) → flash the outcome → the 2 s
// poll repaints the rows from the staged truth.
//
// The fail-closed handshake is kept verbatim in spirit: the browser keeps its
// own generation (late HTTP completions check it) AND the daemon's exact
// learner generation (another tab, Identify, or a setup proof can supersede
// the listener; no key is ever written unless the polled result still belongs
// to this exact attempt).

interface NocturneLearnView {
  ok: boolean;
  state: string;
  generation: number | null;
  remaining_ms: number | null;
  device: string | null;
  key: string | null;
  error: string | null;
}

interface NocturneBindOutcome {
  ok: boolean;
  message: string | null;
  error: string | null;
  code: string | null;
  conflicts: { scope: string; preset: string; function: string; slot: number | null }[];
  also_drives: string[];
}

interface LearnTarget {
  fn: string;
  label: string;
  slot: string;
  mode: "replace" | "add";
}

/** PadForge's recorder tick — snappy but far under the daemon's own rate. */
const LEARN_POLL_MS = 33;

const [nLearnCls, setNLearnCls] = createSignal("n-learnbar none");
const [nLearnText, setNLearnText] = createSignal("");
const [nLearnSub, setNLearnSub] = createSignal("");
const [nConfOpen, setNConfOpen] = createSignal(false);
const [nConfTitle, setNConfTitle] = createSignal("");
const [nConfLines, setNConfLines] = createSignal("");

let learnRow: LearnTarget | null = null;
/** Browser-request supersede guard: every arm bumps it; late completions
 *  compare. Deliberately separate from the daemon generation below. */
let learnGen = 0;
/** Exact daemon learner generation returned by `learn-key`. */
let daemonGen: number | null = null;
let learnTimer: number | undefined;
/** At most one daemon `learn-key` start in flight (clicks can cross). */
let learnStartFlight: Promise<NocturneLearnView> | null = null;
let learnRoot: HTMLElement | null = null;
/** The hit waiting on the conflict dialog's verdict. */
let pendingConflict: { row: LearnTarget; key: string } | null = null;

/** The page poller, installed by the entry so a successful JSON bind
 *  repaints the rows immediately instead of waiting out the 2 s tick. */
let nocturnePollFn: () => void = () => {};

export function setNocturnePoll(fn: () => void): void {
  nocturnePollFn = fn;
}

function learnSentence(mode: "replace" | "add"): string {
  return mode === "add"
    ? "The key joins this control's list — any one of them presses it."
    : "The key replaces this control's binding.";
}

function validGen(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/** Best-effort daemon cleanup. The daemon compares generations atomically,
 *  so either request order is safe when a start and a cancel cross. */
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

/** While armed the panel's keys reach Windows and therefore this page; a
 *  letter would type into anything focusable and Space would "click" the
 *  button that armed the learn. Swallow everything at the capture phase —
 *  except Escape, which cancels. */
function guardLearnKeys(ev: KeyboardEvent): void {
  if (!learnRow) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.key === "Escape") void cancelLearn();
}

function armFocusGuard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
  window.addEventListener("keydown", guardLearnKeys, true);
  window.addEventListener("keypress", guardLearnKeys, true);
}

function disarmFocusGuard(): void {
  window.removeEventListener("keydown", guardLearnKeys, true);
  window.removeEventListener("keypress", guardLearnKeys, true);
}

function markArmedRow(fnName: string | null): void {
  if (!learnRoot) return;
  for (const el of Array.from(learnRoot.querySelectorAll<HTMLElement>(".n-bind.arm"))) {
    el.classList.remove("arm");
  }
  if (fnName !== null) {
    learnRoot
      .querySelector<HTMLElement>(`.n-bind[data-fn="${CSS.escape(fnName)}"]`)
      ?.classList.add("arm");
  }
}

function armLearnUi(row: LearnTarget): void {
  setNLearnCls("n-learnbar listen");
  setNLearnText(`Press the panel key for P${row.slot} · ${row.label}`);
  setNLearnSub(`${learnSentence(row.mode)} Esc cancels.`);
  markArmedRow(row.fn);
}

function disarmLearnUi(): void {
  setNLearnCls("n-learnbar none");
  markArmedRow(null);
}

/** Retire the current browser attempt in one place. */
function retireLearn(): void {
  stopLearnTimer();
  learnGen += 1;
  learnRow = null;
  daemonGen = null;
  disarmFocusGuard();
  disarmLearnUi();
}

async function startLearn(row: LearnTarget): Promise<void> {
  // PadForge convention: clicking the control being recorded cancels it.
  if (learnRow && learnRow.fn === row.fn && learnRow.mode === row.mode) {
    await cancelLearn();
    return;
  }
  // Retire the previous attempt BEFORE installing the new target, so a timer
  // poll can never snapshot the new target with the old daemon generation.
  const previousDaemonGen = daemonGen;
  const gen = ++learnGen;
  stopLearnTimer();
  learnRow = null;
  daemonGen = null;
  disarmFocusGuard();
  if (previousDaemonGen !== null) void cancelDaemonGen(previousDaemonGen);
  learnRow = row;
  pendingConflict = null;
  setNConfOpen(false);
  armFocusGuard();
  armLearnUi(row);
  try {
    // A previous start may still be travelling to the sequential pipe: wait
    // for and retire its exact daemon generation before sending ours.
    const prior = learnStartFlight;
    if (prior !== null) {
      try {
        const superseded = await prior;
        if (validGen(superseded.generation)) void cancelDaemonGen(superseded.generation);
      } catch {
        // The prior owner reports its own transport failure.
      }
      if (learnGen !== gen) return;
    }
    const flight = fetchJSON<NocturneLearnView>("/api/learn/start", { method: "POST" });
    learnStartFlight = flight;
    let started: NocturneLearnView;
    try {
      started = await flight;
    } finally {
      if (learnStartFlight === flight) learnStartFlight = null;
    }
    if (learnGen !== gen) {
      // Reached the daemon but superseded here: retire only its generation.
      if (validGen(started.generation)) void cancelDaemonGen(started.generation);
      return;
    }
    if (
      !validGen(started.generation) ||
      (started.state !== "listening" && started.state !== "hit")
    ) {
      retireLearn();
      applyFlash(
        "error: Can't listen for a key right now — if a session is running, stop it first. Nothing changed.",
      );
      return;
    }
    daemonGen = started.generation;
    stopLearnTimer();
    learnTimer = window.setInterval(() => void pollLearn(), LEARN_POLL_MS);
    // A fast press can land before the start response reaches the browser.
    if (started.state === "hit") void pollLearn();
  } catch {
    if (learnGen !== gen) return;
    retireLearn();
    applyFlash("error: Can't listen for a key — is ksx studio still running?");
  }
}

async function pollLearn(): Promise<void> {
  const row = learnRow;
  const gen = learnGen;
  const expected = daemonGen;
  if (!row) {
    stopLearnTimer();
    return;
  }
  let learn: NocturneLearnView;
  try {
    learn = await fetchJSON<NocturneLearnView>("/api/learn");
  } catch {
    return; // transient — keep listening on the last known state
  }
  if (learnGen !== gen) return; // superseded meanwhile
  if (expected === null || !validGen(learn.generation) || learn.generation !== expected) {
    // A different action owns the daemon listener now. Fail closed: never
    // bind its hit into this attempt, never cancel the newer listener.
    retireLearn();
    applyFlash("error: Another key-listening action replaced this one. Nothing changed.");
    return;
  }
  switch (learn.state) {
    case "listening": {
      const secs = Math.max(0, Math.ceil((learn.remaining_ms ?? 0) / 1000));
      setNLearnSub(`${learnSentence(row.mode)} ${secs}s left · Esc cancels.`);
      break;
    }
    case "hit":
      // Retire before the asynchronous write: the 33 ms timer and the
      // fast-hit poll may overlap, and only the first terminal response may
      // reach the bind verb.
      retireLearn();
      if (learn.key) void writeLearnedKey(row, learn.key, false);
      break;
    case "timeout":
      retireLearn();
      applyFlash(
        `error: Timed out — no key was pressed in time for ${row.label}. Nothing changed.`,
      );
      break;
    case "cancelled":
      retireLearn();
      break;
    default:
      // failed / unavailable / idle-after-restart: report and stop.
      retireLearn();
      applyFlash("error: Key listening stopped. Nothing changed.");
      break;
  }
}

async function cancelLearn(): Promise<void> {
  const generation = daemonGen;
  retireLearn();
  pendingConflict = null;
  setNConfOpen(false);
  // Generation-qualified end to end: a stale attempt cannot stop a listener
  // that superseded it in the daemon.
  if (generation === null) return;
  await cancelDaemonGen(generation);
}

/** One learned key onto one staged control, through the server-resolved bind
 *  verb. The server reads the slot's preset identity and current key list
 *  itself; this browser is never trusted with a key list it made up. */
async function writeLearnedKey(row: LearnTarget, key: string, force: boolean): Promise<void> {
  let outcome: NocturneBindOutcome;
  try {
    outcome = await fetchJSON<NocturneBindOutcome>("/nocturne/api/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot: Number(row.slot),
        function: row.fn,
        key,
        mode: row.mode,
        force,
      }),
    });
  } catch {
    applyFlash("error: The bind request failed — is ksx studio still running?");
    return;
  }
  if (outcome.ok) {
    pendingConflict = null;
    setNConfOpen(false);
    let line =
      row.mode === "add"
        ? `${key} added to ${row.label} — any of its keys presses it.`
        : `${row.label} is now ${key}.`;
    if (outcome.also_drives.length > 0) {
      line += ` That key also drives ${outcome.also_drives.join(" · ")}.`;
    }
    applyFlash(line);
    nocturnePollFn();
  } else if (outcome.code === "conflict" && outcome.conflicts.length > 0) {
    // Cross-slot (or a second macro trigger): fan-out is the product, but it
    // is asked about, never assumed. "Use here too" takes nothing away.
    pendingConflict = { row, key };
    const lines = outcome.conflicts.map((c) => {
      const control = c.function.startsWith("macro.")
        ? `the "${c.function.slice(6)}" macro`
        : c.function;
      const where = c.slot !== null ? ` for Player ${c.slot}` : " for another player";
      return c.scope === "macro"
        ? `${key} already starts ${control}${where}`
        : `${key} already controls ${control}${where}`;
    });
    setNConfTitle(`Give ${key} to ${row.label} too?`);
    setNConfLines(
      `${lines.join("; ")}. "Use here too" shares the key — the other control keeps it as well; nothing is taken away.`,
    );
    setNConfOpen(true);
  } else {
    pendingConflict = null;
    setNConfOpen(false);
    // The error is authored, self-contained customer copy either way: the
    // server module's own guard sentences, or its consumerized fallback.
    applyFlash(`error: ${outcome.error ?? "That control could not be changed. Nothing changed."}`);
  }
}

// ── The live echo (SSE) ────────────────────────────────────────────────────
// One read-only EventSource on /api/live; EventSource owns reconnection. ALL
// paint is IMPERATIVE classList/textContent against data-key / data-fn —
// never a list re-render at frame rate. The fail-closed origin rule is
// ported from map.ts: frames paint only while the CURRENT polled session
// says a session is running FROM THIS PAGE'S DRAFT (origin "staged"); any
// session transition clears every lit element and the ledger, so a frame
// from one setup can never light another. The turbo strobe stays capped at
// ≤3 Hz by construction: lit fills are steady and the only motion is the
// 1.3 s noct-pulse (photosensitivity — non-negotiable).

interface NocturneLiveFrame {
  running: boolean;
  slots: {
    slot: number;
    down: string[];
    hit: string[];
    lt: number;
    rt: number;
    lx: number;
    ly: number;
    rx: number;
    ry: number;
  }[];
  keys: { key: string; device: string; alias: string; down: boolean }[];
  dropped: number;
  off_panel: number;
}

interface NocturneLiveEnvelope {
  frame: NocturneLiveFrame;
  unavailable?: string | null;
}

/** The session fact the last payload carried — the paint license. */
let liveSession: {
  reachable: boolean;
  running: boolean;
  origin: string;
  profile: string | null;
  elapsed: string;
} | null = null;
let liveConfirmed = false;
let liveAccepted: string | null = null;
/** Client accumulators, reset at every session boundary. */
let liveEvents = 0;
let liveDropped = 0;
const liveKeysDown = new Set<string>();
const liveFnsDown = new Set<string>();
const liveTicker: string[] = [];

function liveFingerprint(): string {
  const s = liveSession;
  return s ? JSON.stringify([s.reachable, s.running, s.origin, s.profile]) : "no-payload";
}

function liveLicensed(): boolean {
  return (
    liveConfirmed &&
    liveSession !== null &&
    liveSession.running &&
    liveSession.origin === "staged"
  );
}

function clearLivePaint(): void {
  if (!learnRoot) return;
  for (const el of Array.from(learnRoot.querySelectorAll<HTMLElement>(".live"))) {
    el.classList.remove("live");
  }
  const stats = learnRoot.querySelector<HTMLElement>(".n-livestats");
  if (stats) stats.textContent = "";
  const ticker = learnRoot.querySelector<HTMLElement>(".n-ticker");
  if (ticker) ticker.textContent = "";
}

function resetLiveLedger(): void {
  liveAccepted = null;
  liveEvents = 0;
  liveDropped = 0;
  liveKeysDown.clear();
  liveFnsDown.clear();
  liveTicker.length = 0;
  clearLivePaint();
}

/** Announce ONLY transitions — the stats strip itself is aria-hidden so the
 *  uptime clock cannot spam a screen reader every other second. */
function liveAnnounce(text: string): void {
  const sr = learnRoot?.querySelector<HTMLElement>(".n-live-sr");
  if (sr && sr.textContent !== text) sr.textContent = text;
}

/** Every poll re-reads the license. Called from applyNocturne with the
 *  payload's own session fact, so a confirmation can only ever be issued by
 *  the truth it will be checked against. */
function reconcileLiveSession(p: NocturnePayload): void {
  const s = p.session;
  const before = liveFingerprint();
  liveSession = s
    ? {
        reachable: s.reachable,
        running: s.running,
        origin: s.origin,
        profile: s.profile,
        elapsed: s.active?.elapsed ?? "",
      }
    : null;
  if (liveFingerprint() !== before) resetLiveLedger();
  liveConfirmed = true;
  if (!liveLicensed()) {
    clearLivePaint();
    liveAnnounce(
      liveSession?.running
        ? "Live input is unavailable: Play is using a different setup."
        : "Live input is inactive.",
    );
  }
}

function invalidateLive(): void {
  // The ordinary 2 s poll re-confirms from fresh session truth; forcing one
  // here would turn EventSource's reconnect cadence into poll spam.
  liveConfirmed = false;
  resetLiveLedger();
}

function normalizedFn(control: string): string {
  return control.trim().toLowerCase();
}

function paintLive(envelope: NocturneLiveEnvelope): void {
  if (!envelope.frame.running) {
    resetLiveLedger();
    liveAnnounce("Live input is inactive.");
    return;
  }
  if (!liveLicensed()) return;
  const root = learnRoot;
  if (!root) return;
  const session = liveFingerprint();
  if (liveAccepted !== session) {
    resetLiveLedger();
    liveAccepted = session;
    liveAnnounce("Live input is active.");
  }

  // The FIRST slot is this page's selected slot (its rows, its board).
  const slot = envelope.frame.slots.find((s) => s.slot === 1) ?? envelope.frame.slots[0];
  liveFnsDown.clear();
  if (slot) {
    for (const control of slot.down) liveFnsDown.add(normalizedFn(control));
    for (const control of slot.hit) liveFnsDown.add(normalizedFn(control));
  }
  for (const hit of envelope.frame.keys) {
    const key = hit.key.trim();
    if (key === "") continue;
    if (hit.down) liveKeysDown.add(key);
    else liveKeysDown.delete(key);
    liveEvents += 1;
    liveTicker.push(`${key}${hit.down ? "↓" : "↑"}`);
    if (liveTicker.length > 10) liveTicker.shift();
  }
  liveDropped += envelope.frame.dropped;

  // Paint: one sweep, class toggles only.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-key]"))) {
    el.classList.toggle("live", liveKeysDown.has(el.dataset.key ?? ""));
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-fn]"))) {
    // Space-separated where one element stands for several functions — a
    // stick lights on its click OR any of its four directions, the Xbox
    // cross on any d-pad direction.
    const fns = (el.dataset.fn ?? "").split(/\s+/);
    el.classList.toggle(
      "live",
      fns.some((fnName) => liveFnsDown.has(normalizedFn(fnName))),
    );
  }
  const stats = root.querySelector<HTMLElement>(".n-livestats");
  if (stats) {
    const parts = ["Live"];
    if (liveSession?.elapsed) parts.push(liveSession.elapsed);
    parts.push(`${liveEvents} events`);
    parts.push("60 Hz loop");
    if (liveDropped > 0) parts.push(`${liveDropped} frames dropped`);
    stats.textContent = parts.join(" · ");
  }
  const ticker = root.querySelector<HTMLElement>(".n-ticker");
  if (ticker) ticker.textContent = liveTicker.join("  ");
}

/** Open the stream. Called once at activation; EventSource reconnects. */
export function nocturneLiveConnect(): void {
  const source = new EventSource("/api/live");
  source.addEventListener("frame", (event) => {
    try {
      paintLive(JSON.parse((event as MessageEvent<string>).data) as NocturneLiveEnvelope);
    } catch {
      invalidateLive();
    }
  });
  source.addEventListener("unavailable", () => invalidateLive());
  source.addEventListener("error", () => invalidateLive());
}

/** The filter (client chrome over served rows): IMPERATIVE hide/show — the
 *  live-echo idiom, legitimate for state no slot carries. */
function applyNocturneFilter(root: HTMLElement, q: string): void {
  const pane = root.querySelector(".n-right");
  if (!pane) return;
  const query = q.trim().toLowerCase();
  for (const el of Array.from(pane.querySelectorAll<HTMLElement>(".n-bind"))) {
    const label = (el.querySelector(".n-bind-label")?.textContent ?? "").toLowerCase();
    el.classList.toggle("hide", query !== "" && !label.includes(query));
  }
}

/** Delegated events on the island root (the map.ts idiom): every interactive
 *  control carries `data-nx`; everything else is inert. */
export function nocturneWire(root: HTMLElement): void {
  learnRoot = root;
  // Identify-by-key is a REAL verb: the form posts and the server listens
  // for one keypress (up to 11 s). The submit hook only shows the listening
  // banner while the round-trip is in flight; applyFlash settles it.
  root.addEventListener("submit", (ev) => {
    const form = ev.target as HTMLElement | null;
    if (form && form.classList.contains("n-idform")) {
      ui.identify = true;
      applyNocturneUi();
    }
  });
  root.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.classList.contains("n-filter-in")) {
      applyNocturneFilter(root, t.value);
    }
  });
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    // Slot selection: enhance the server-resolved ?slot=N link into an
    // in-place URL swap + immediate poll — no full reload, same truth.
    const sel = target?.closest<HTMLAnchorElement>("a.n-slot-sel");
    if (sel) {
      ev.preventDefault();
      window.history.pushState(null, "", sel.getAttribute("href") ?? "/nocturne");
      nocturnePollFn();
      return;
    }
    const hit = target?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    if (!hit) {
      // Any un-annotated click closes the open configuration menu (a
      // native details; JS only adds outside-click dismissal).
      closeMenu();
      return;
    }
    if (hit === "menu-sum") {
      // The chip summary: let the native details toggle run.
      return;
    }
    if (hit === "menu-noop") {
      // A click inside the open menu panel: stays open, and real form
      // controls in it keep working — never preventDefault here.
      return;
    }
    if (hit === "slot-new") ui.dlg = true;
    else if (hit === "dlg-close") ui.dlg = false;
    else if (hit === "pane-left") ui.leftRail = !ui.leftRail;
    else if (hit === "pane-right") ui.rightRail = !ui.rightRail;
    else if (hit === "filter-reset") {
      const inp = root.querySelector<HTMLInputElement>(".n-filter-in");
      if (inp) inp.value = "";
      applyNocturneFilter(root, "");
    } else if (hit === "bind-learn" || hit === "bind-add") {
      // The row's own facts travel on its element, never re-derived here.
      const holder = target?.closest<HTMLElement>("[data-fn]");
      const fnName = holder?.dataset.fn ?? "";
      const slot = holder?.dataset.slot ?? "";
      const label = holder?.querySelector(".n-bind-label")?.textContent?.trim() || fnName;
      if (fnName && slot) {
        void startLearn({
          fn: fnName,
          label,
          slot,
          mode: hit === "bind-add" ? "add" : "replace",
        });
      }
    } else if (hit === "learn-cancel") {
      void cancelLearn();
    } else if (hit === "conf-force") {
      const pend = pendingConflict;
      pendingConflict = null;
      setNConfOpen(false);
      if (pend) void writeLearnedKey(pend.row, pend.key, true);
    } else if (hit === "conf-cancel") {
      pendingConflict = null;
      setNConfOpen(false);
    } else if (hit === "dlg-noop") {
      // A dialog panel: exists so panel clicks stop here instead of
      // reaching the backdrop's dlg-close. Never preventDefault — the
      // panel contains real form controls.
      return;
    }
    if (hit === "slot-new" || hit === "dlg-close" || hit === "pane-left" || hit === "pane-right" || hit === "filter-reset") {
      ev.preventDefault();
    }
    applyNocturneUi();
  });
}

export function NocturneIsland() {
  return h(
    "div",
    { class: "nocturne" },
    // ═══ Title bar ════════════════════════════════════════════════════════
    h(
      "header",
      { class: "n-tbar" },
      h("div", { class: "n-logo" }),
      h("span", { class: "n-brand" }, "KSX Studio"),
      h("span", { class: "n-ver" }, () => nVersion()),
      // The configuration menu: a NATIVE details, so every verb in it works
      // with scripting off and the served facts paint on the SSR pass. JS
      // adds only outside-click dismissal (and closes it after an action).
      h(
        "details",
        { class: "n-chipd" },
        h(
          "summary",
          { class: "n-chip", "data-nx": "menu-sum" },
          h("span", { class: "n-chip-ico" }, "▣"),
          h("span", null, () => nChipText()),
          h("span", { class: "n-chip-caret" }, "▾"),
        ),
        h(
          "div",
          { class: "nm", "data-nx": "menu-noop" },
          h("div", { class: "nm-kick" }, "Configuration"),
          h(
            "div",
            { class: () => nCfgCls() },
            h(
              "span",
              { class: "nm-cfg-txt" },
              h("span", { class: "nm-cfg-t" }, () => nCfgLine()),
              h("span", { class: "nm-cfg-m" }, () => nCfgMeta()),
            ),
            h("span", { class: "nm-check" }, () => nCfgCheck()),
          ),
          h(
            "form",
            { class: "n-inline", method: "post", action: "/nocturne/adopt" },
            h(
              "button",
              { type: "submit", class: () => nAdoptCls() },
              "Load the saved configuration into this draft",
            ),
          ),
          // Start over: the dirty-aware sentence sits BEFORE the verb, in a
          // native fold — consent sized to what is at risk (a memory draft).
          h(
            "details",
            { class: "nm-sub" },
            h("summary", { class: "nm-item" }, "Start over…"),
            h(
              "div",
              { class: "nm-subbody" },
              h("p", { class: "nm-auto-note" }, () => nDiscardNote()),
              h(
                "form",
                { class: "n-inline", method: "post", action: "/nocturne/discard" },
                h("button", { type: "submit", class: "nm-item danger" }, "Discard this draft"),
              ),
            ),
          ),
          h("div", { class: "nm-div" }),
          h("div", { class: "nm-kick games" }, () => nGamesHead()),
          createList(
            () => nGameRows(),
            (r) => r.title + "|" + r.meta + "|" + r.cls + "|" + r.ico_cls,
            (r) =>
              h(
                "form",
                { class: "n-inline", method: "post", action: "/nocturne/adopt" },
                h("input", { type: "hidden", name: "profile", value: r.title }),
                h(
                  "button",
                  { type: "submit", title: "Load this game's controllers into the draft — Play stays a separate step", class: r.cls },
                  h("span", { class: r.ico_cls }, "▣"),
                  h(
                    "span",
                    { class: "nm-cfg-txt" },
                    h("span", { class: "nm-game-t" }, r.title),
                    h("span", { class: "nm-cfg-m" }, r.meta),
                  ),
                ),
              ),
          ),
          h("p", { class: "nm-auto-note nm-pad" }, () => nGamesNote()),
          h("div", { class: "nm-div" }),
          h("div", { class: "nm-kick" }, "Maintenance"),
          h(
            "a",
            { class: "nm-item nm-link", href: "/setup/export.json" },
            "Export the configuration (download)",
          ),
          h(
            "a",
            { class: "nm-item nm-link", href: "/setup" },
            "Import — opens the consent flow on Setup",
          ),
          h("div", { class: "nm-div" }),
          // The sign-in task, off the SAME derivation /start's card uses.
          h(
            "details",
            { class: "nm-sub" },
            h(
              "summary",
              { class: "nm-auto" },
              h("span", { class: () => nAutoSwCls() }, h("span", { class: "nx-knob" })),
              h("span", { class: "nm-auto-t" }, () => nAutoLine()),
            ),
            h(
              "div",
              { class: "nm-subbody" },
              h("p", { class: "nm-auto-note" }, () => nAutoNote()),
              h(
                "form",
                { method: "post", action: "/nocturne/autostart", class: () => nAutoFormCls() },
                h("input", { type: "hidden", name: "enable", value: () => nAutoDir() }),
                h(
                  "label",
                  { class: "nm-auto-note nm-consent" },
                  h("input", { type: "checkbox", name: "confirm_autostart", value: "yes" }),
                  " I understand what happens at sign-in.",
                ),
                h("button", { type: "submit", class: "nm-item" }, () => nAutoBtn()),
              ),
            ),
          ),
        ),
      ),
      h(
        "form",
        { class: "n-inline", method: "post", action: "/nocturne/save" },
        h("button", { class: "n-save", type: "submit" }, "Save"),
      ),
      h("span", { class: "n-saved" }, () => nSaveText()),
      h("div", { class: "n-spring" }),
      h("span", { class: "n-hint" }, () => nEscapeLine()),
      h(
        "form",
        { class: "n-inline", method: "post", action: "/nocturne/play" },
        h("button", { type: "submit", class: () => nPlayCls() }, "▷ Play"),
      ),
      h(
        "form",
        { class: "n-inline", method: "post", action: "/nocturne/stop" },
        h("button", { type: "submit", class: () => nStopCls() }, "⏹ Stop"),
      ),
    ),
    // The action flash (allowlisted copy only).
    h("div", { role: "status", class: () => nFlashCls() }, () => nFlashLine()),
    // ═══ Three panes ══════════════════════════════════════════════════════
    h(
      "main",
      { class: "n-main" },
      // ── Left pane ────────────────────────────────────────────────────────
      h(
        "aside",
        { class: () => nLeftCls() },
        h(
          "div",
          { class: "n-rail" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-left" }, "›"),
          h("button", { class: "n-pbadge plus", type: "button", "data-nx": "slot-new" }, "+"),
        ),
        h(
          "div",
          { class: "n-kick-row" },
          h("span", { class: "n-kick" }, "Keyboard"),
          h("span", { class: "n-kick-n" }, () => nDevCount()),
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-left" }, "‹"),
        ),
        // Device rows — the row IS the /nocturne/device form's button.
        createList(
          () => nDevRows(),
          (r) => r.selector + "|" + r.alias + "|" + r.label + "|" + r.cls + "|" + r.name + "|" + r.meta,
          (r) =>
            h(
              "form",
              { class: "n-devform", method: "post", action: "/nocturne/device" },
              h("input", { type: "hidden", name: "selector", value: r.selector }),
              h("input", { type: "hidden", name: "alias", value: r.alias }),
              h("input", { type: "hidden", name: "label", value: r.label }),
              h(
                "button",
                { type: "submit", class: r.cls },
                h("span", { class: "n-dev-ico" }, "⌨"),
                h(
                  "span",
                  { class: "n-dev-txt" },
                  h("span", { class: "n-dev-name" }, r.name),
                  h("span", { class: "n-dev-meta" }, r.meta),
                ),
                h("span", { class: "n-dev-dot" }),
              ),
            ),
        ),
        // The experimentation playground and the unavailable tier live in
        // FOLDS: honest, complete, and out of the way — the long scroll of
        // hubs and transports is one click, not the default view.
        h(
          "details",
          { class: () => nExpFoldCls() },
          h("summary", { class: "n-devfold-sum" }, () => nExpHead()),
          h(
            "p",
            { class: "n-devnote" },
            "These devices can sometimes work, but they do not identify themselves as keyboards. They are here for unusual controllers and experimentation; choose one only when you recognize it.",
          ),
          createList(
            () => nDevExp(),
            (r) => r.selector + "|" + r.alias + "|" + r.label + "|" + r.cls + "|" + r.name + "|" + r.meta,
            (r) =>
              h(
                "form",
                { class: "n-devform", method: "post", action: "/nocturne/device" },
                h("input", { type: "hidden", name: "selector", value: r.selector }),
                h("input", { type: "hidden", name: "alias", value: r.alias }),
                h("input", { type: "hidden", name: "label", value: r.label }),
                h(
                  "button",
                  { type: "submit", class: r.cls },
                  h("span", { class: "n-dev-ico" }, "⚙"),
                  h(
                    "span",
                    { class: "n-dev-txt" },
                    h("span", { class: "n-dev-name" }, r.name),
                    h("span", { class: "n-dev-meta" }, r.meta),
                  ),
                  h("span", { class: "n-dev-dot" }),
                ),
              ),
          ),
        ),
        h(
          "details",
          { class: () => nOtherFoldCls() },
          h("summary", { class: "n-devfold-sum" }, () => nOtherHead()),
          h(
            "p",
            { class: "n-devnote" },
            "Boards with no keyboard interface, listed so \"why is my device not here\" has an answer.",
          ),
          createList(
            () => nDevOther(),
            (r) => r.name + "|" + r.meta,
            (r) =>
              h(
                "div",
                { class: "n-dev off" },
                h("span", { class: "n-dev-ico" }, "⌨"),
                h(
                  "div",
                  { class: "n-dev-txt" },
                  h("div", { class: "n-dev-name" }, r.name),
                  h("div", { class: "n-dev-meta" }, r.meta),
                ),
                h("span", { class: "n-dev-dot" }),
              ),
          ),
        ),
        h("p", { class: "n-devnote" }, () => nDevNote()),
        h(
          "div",
          { class: "n-linkrow" },
          // Rescan is a fresh GET: the collector re-reads the machine on
          // every request, so reloading IS the scan (FIRST-RUN §5).
          h(
            "form",
            { method: "get", action: "/nocturne" },
            h("button", { class: "n-link", type: "submit" }, "Rescan"),
          ),
          h(
            "form",
            { class: "n-idform", method: "post", action: "/nocturne/device/identify" },
            h("button", { type: "submit", class: () => nIdLinkCls() }, "Identify by key"),
          ),
        ),
        h(
          "div",
          { class: () => nIdBoxCls() },
          h("span", { class: "n-idot" }),
          h("span", { class: "n-idtxt" }, () => nIdText()),
        ),
        h("div", { class: "n-kick-row" }, h("span", { class: "n-kick" }, "Keyboard behaviour")),
        h("p", { class: "n-devnote" }, () => nModeNote()),
        createList(
          () => nModeRows(),
          (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls,
          (r) =>
            h(
              "form",
              { class: "n-modeform", method: "post", action: "/nocturne/blocking" },
              h("input", { type: "hidden", name: "blocking", value: r.name }),
              h(
                "button",
                { type: "submit", class: r.cls },
                h("span", { class: "n-radio-dot" }),
                h(
                  "span",
                  { class: "n-radio-txt" },
                  h("span", { class: "n-radio-title" }, r.title),
                  h("span", { class: "n-radio-detail" }, r.detail),
                ),
              ),
            ),
        ),
        h(
          "div",
          { class: "n-kick-row" },
          h("span", { class: "n-kick" }, "Virtual controllers"),
          h("span", { class: "n-kick-n" }, () => nRackCaption()),
        ),
        // The rack: each staged controller with its duplicate/remove verbs.
        createList(
          () => nRackRows(),
          (r) => r.number + "|" + r.badge + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.href,
          (r) =>
            h(
              "div",
              { class: r.cls },
              // Clicking the row's identity SELECTS it: a server-resolved
              // link (?slot=N), so every pane follows with no JavaScript;
              // with it, the wire swaps the URL and polls in place.
              h(
                "a",
                { class: "n-slot-sel", href: r.href },
                h("span", { class: "n-pbadge" }, r.badge),
                h(
                  "span",
                  { class: "n-slot-txt" },
                  h("span", { class: "n-slot-name" }, r.name),
                  h("span", { class: "n-slot-meta" }, r.meta),
                ),
              ),
              h(
                "form",
                { class: "n-inline first", method: "post", action: "/nocturne/controller/duplicate" },
                h("input", { type: "hidden", name: "number", value: r.number }),
                h("button", { class: "n-slot-act", type: "submit", title: "Duplicate" }, "⧉"),
              ),
              h(
                "form",
                { class: "n-inline", method: "post", action: "/nocturne/controller/remove" },
                h("input", { type: "hidden", name: "number", value: r.number }),
                h("button", { class: "n-slot-act", type: "submit", title: "Remove" }, "✕"),
              ),
            ),
        ),
        // Free slots, as the invitation the create dialog answers.
        createList(
          () => nRackEmpty(),
          (r) => r.badge,
          (r) =>
            h(
              "button",
              { type: "button", "data-nx": "slot-new", class: "n-slot empty n-slotbtn" },
              h("span", { class: "n-pbadge dim" }, r.badge),
              h(
                "span",
                { class: "n-slot-txt" },
                h("span", { class: "n-slot-name" }, "empty slot"),
                h("span", { class: "n-slot-meta" }, "any persona"),
              ),
            ),
        ),
        h(
          "p",
          { class: "n-foot" },
          "Any persona can sit in any slot — XInput personas cap at 4 in total (Windows) · 8 players is a realistic emulator target · 16 slots is the KSX ceiling.",
        ),
      ),
      // ── Center ───────────────────────────────────────────────────────────
      h(
        "section",
        { class: "n-center" },
        h(
          "div",
          { class: "n-meta" },
          h("span", { class: "n-pbadge" }, () => nPadBadge()),
          h("span", { class: "n-meta-name" }, () => nPadName()),
          h("span", { class: "n-meta-sub" }, () => nPadSub()),
          h("div", { class: "n-spring" }),
          // The live echo's readouts: written IMPERATIVELY at frame rate,
          // both hidden from assistive tech (the sr twin below announces
          // transitions only, so the uptime clock cannot spam a reader).
          h("span", { "aria-hidden": "true", class: "n-ticker" }),
          h("span", { "aria-hidden": "true", class: "n-livestats" }),
          h("span", { role: "status", class: "n-live-sr" }),
        ),
        // The stage: the vendored Gamepad-Asset-Pack silhouettes (the
        // workspace's M2c art) with the token-painted control layer —
        // persona-aware Xbox vs true DualShock, which one shows being the
        // server's call (class pair, so both SSR-paint and neither needs a
        // hydration marker). Every control element carries its canonical
        // mapper function(s) as data-fn — space-separated where one element
        // stands for several (a stick, the Xbox cross) — so the live echo
        // lights this art with the same sweep that lights the board.
        h(
          "div",
          { class: "n-stage" },
          // The paint servers both silhouettes draw with: one zero-size SVG
          // whose defs resolve document-wide, so the CSS can fill shells,
          // wells, sticks and buttons with real gradients instead of flats.
          h(
            "svg",
            { class: "nx-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false" },
            h(
              "defs",
              null,
              h(
                "linearGradient",
                { id: "nxg-shell", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#2b2e3e" }),
                h("stop", { offset: "0.55", "stop-color": "#20222f" }),
                h("stop", { offset: "1", "stop-color": "#191b26" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-well", cx: "0.5", cy: "0.45", r: "0.65" },
                h("stop", { offset: "0", "stop-color": "#101219" }),
                h("stop", { offset: "0.8", "stop-color": "#14161f" }),
                h("stop", { offset: "1", "stop-color": "#1c1e2a" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-stick", cx: "0.38", cy: "0.32", r: "0.85" },
                h("stop", { offset: "0", "stop-color": "#3d4156" }),
                h("stop", { offset: "0.55", "stop-color": "#2b2e3e" }),
                h("stop", { offset: "1", "stop-color": "#222434" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-btn", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#2a2d3c" }),
                h("stop", { offset: "0.5", "stop-color": "#20222f" }),
                h("stop", { offset: "1", "stop-color": "#1a1c27" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-touch", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#12141d" }),
                h("stop", { offset: "1", "stop-color": "#191b26" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-lamp", cx: "0.5", cy: "0.4", r: "0.75" },
                h("stop", { offset: "0", "stop-color": "#cfc6f7" }),
                h("stop", { offset: "0.45", "stop-color": "#968ae0" }),
                h("stop", { offset: "1", "stop-color": "#5d5494" }),
              ),
            ),
          ),
          h(
            "div",
            { class: () => nPadXboxCls() },
            h(
              "svg",
              { class: "wspad", viewBox: "0 0 112.45 100", "aria-hidden": "true", focusable: "false" },
              // ── SCENARIO B: the CC0 Xbox 360 BODY GEOMETRY (Open Clip Art,
              // Grumbel, public domain) under the photoreal paint kit —
              // carbon gradients, clipped light, AO, glossy coloured domes,
              // the silver guide ball in its green ring. Same data-fn hooks.
              h(
                "defs",
                null,
                h("path", { id: "nxb-body-path", d: "M 102.41,95.69 C 107.82,95.86 110.17,92.93 110.70,78.43 C 111.25,63.24 101.39,34.38 98.50,27.10 C 95.61,19.82 81.05,15.95 74.44,20.11 C 69.01,23.54 63.05,23.99 55.77,23.99 C 48.49,23.99 42.54,23.54 37.10,20.11 C 35.24,18.94 32.75,18.40 30.07,18.40 C 23.22,18.39 15.12,21.86 13.04,27.10 C 10.15,34.38 0.29,63.24 0.84,78.43 C 1.37,92.84 3.70,95.82 9.05,95.70 C 21.47,94.37 22.74,87.34 31.11,80.76 C 38.87,74.66 44.31,74.11 55.73,74.33 C 67.15,74.11 72.58,74.66 80.34,80.76 C 88.71,87.34 89.99,94.36 102.41,95.69 z" }),
                h("clipPath", { id: "nxb-clip" }, h("use", { href: "#nxb-body-path" })),
                h(
                  "linearGradient",
                  { id: "nxb-body", x1: "0", y1: "0", x2: "0", y2: "1" },
                  h("stop", { offset: "0", "stop-color": "#33343b" }),
                  h("stop", { offset: "0.4", "stop-color": "#26272d" }),
                  h("stop", { offset: "1", "stop-color": "#1a1b20" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-well", cx: "0.5", cy: "0.45", r: "0.62" },
                  h("stop", { offset: "0", "stop-color": "#0b0c0f" }),
                  h("stop", { offset: "0.78", "stop-color": "#101115" }),
                  h("stop", { offset: "1", "stop-color": "#1e1f25" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-cap", cx: "0.5", cy: "0.48", r: "0.62" },
                  h("stop", { offset: "0", "stop-color": "#1e1f24" }),
                  h("stop", { offset: "0.62", "stop-color": "#28292f" }),
                  h("stop", { offset: "0.88", "stop-color": "#3c3d45" }),
                  h("stop", { offset: "1", "stop-color": "#232429" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-dish", cx: "0.5", cy: "0.42", r: "0.65" },
                  h("stop", { offset: "0", "stop-color": "#0d0e11" }),
                  h("stop", { offset: "0.85", "stop-color": "#121317" }),
                  h("stop", { offset: "1", "stop-color": "#212227" }),
                ),
                h(
                  "linearGradient",
                  { id: "nxb-cross", x1: "0", y1: "0", x2: "0", y2: "1" },
                  h("stop", { offset: "0", "stop-color": "#32333a" }),
                  h("stop", { offset: "1", "stop-color": "#1d1e23" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-dome", cx: "0.38", cy: "0.3", r: "0.85" },
                  h("stop", { offset: "0", "stop-color": "#3b3c44" }),
                  h("stop", { offset: "0.55", "stop-color": "#222329" }),
                  h("stop", { offset: "1", "stop-color": "#141519" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-ball", cx: "0.38", cy: "0.3", r: "0.8" },
                  h("stop", { offset: "0", "stop-color": "#ffffff" }),
                  h("stop", { offset: "0.55", "stop-color": "#dddee2" }),
                  h("stop", { offset: "1", "stop-color": "#8e9097" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-ao", cx: "0.5", cy: "0.5", r: "0.5" },
                  h("stop", { offset: "0", "stop-color": "rgba(0,0,0,0.5)" }),
                  h("stop", { offset: "0.7", "stop-color": "rgba(0,0,0,0.28)" }),
                  h("stop", { offset: "1", "stop-color": "rgba(0,0,0,0)" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-sheen", cx: "0.5", cy: "0.5", r: "0.5" },
                  h("stop", { offset: "0", "stop-color": "rgba(255,255,255,0.09)" }),
                  h("stop", { offset: "1", "stop-color": "rgba(255,255,255,0)" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-y", cx: "0.38", cy: "0.3", r: "0.85" },
                  h("stop", { offset: "0", "stop-color": "#efe08e" }),
                  h("stop", { offset: "0.55", "stop-color": "#d9bd45" }),
                  h("stop", { offset: "1", "stop-color": "#a8912e" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-x", cx: "0.38", cy: "0.3", r: "0.85" },
                  h("stop", { offset: "0", "stop-color": "#8fb4ef" }),
                  h("stop", { offset: "0.55", "stop-color": "#4a7fd6" }),
                  h("stop", { offset: "1", "stop-color": "#33569a" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-b", cx: "0.38", cy: "0.3", r: "0.85" },
                  h("stop", { offset: "0", "stop-color": "#e88a8a" }),
                  h("stop", { offset: "0.55", "stop-color": "#cc4f4f" }),
                  h("stop", { offset: "1", "stop-color": "#9a3535" }),
                ),
                h(
                  "radialGradient",
                  { id: "nxb-a", cx: "0.38", cy: "0.3", r: "0.85" },
                  h("stop", { offset: "0", "stop-color": "#8fd67d" }),
                  h("stop", { offset: "0.55", "stop-color": "#58b34a" }),
                  h("stop", { offset: "1", "stop-color": "#3d7d33" }),
                ),

                h("filter", { id: "nxb-soft" }, h("feGaussianBlur", { stdDeviation: "1.2" })),
              ),
              h(
                "g",
                null,
                h("rect", { "data-fn": "lt", class: "wspad-zone", x: "20", y: "1", width: "22", height: "6.4", rx: "3.2" }),
                h("rect", { "data-fn": "rt", class: "wspad-zone", x: "70.5", y: "1", width: "22", height: "6.4", rx: "3.2" }),
                h("text", { class: "wspad-sys", x: "31", y: "5.6", "text-anchor": "middle" }, "LT"),
                h("text", { class: "wspad-sys", x: "81.5", y: "5.6", "text-anchor": "middle" }, "RT"),
                h("rect", { "data-fn": "lb", class: "wspad-zone", x: "15", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
                h("rect", { "data-fn": "rb", class: "wspad-zone", x: "65.5", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
                h("text", { class: "wspad-sys", x: "31", y: "14.6", "text-anchor": "middle" }, "LB"),
                h("text", { class: "wspad-sys", x: "81.5", y: "14.6", "text-anchor": "middle" }, "RB"),
              ),
              h(
                "g",
                null,
                // The wings peek above the body; the lip shades beneath it.
                h("path", { d: "M 14.98,25.56 C 15.01,25.40 15.59,22.90 15.66,22.48 C 15.72,22.06 15.82,21.84 16.33,21.48 C 21.15,18.17 26.80,16.57 32.39,17.47 C 33.39,17.63 34.67,20.14 34.67,20.14 L 14.98,25.56 z", fill: "#202129", stroke: "#33343e", "stroke-width": "0.4" }),
                h("path", { d: "M 96.98,25.56 C 96.95,25.40 96.37,22.90 96.31,22.48 C 96.24,22.06 96.15,21.84 95.63,21.48 C 90.81,18.17 85.17,16.57 79.57,17.47 C 78.58,17.63 77.29,20.14 77.29,20.14 L 96.98,25.56 z", fill: "#202129", stroke: "#33343e", "stroke-width": "0.4" }),
                h("path", { d: "M 55.98,70.89 C 45.68,70.89 40.46,71.12 35.20,74.00 C 24.24,80.00 22.04,89.48 10.42,95.69 C 21.76,94.05 23.21,87.13 31.32,80.76 C 39.08,74.66 44.51,74.11 55.93,74.33 C 67.35,74.11 72.79,74.66 80.55,80.76 C 88.68,87.15 90.11,94.10 101.57,95.71 C 89.92,89.50 87.73,80.00 76.75,74.00 C 71.49,71.12 66.28,70.89 55.98,70.89 z", fill: "#14151a" }),
                h("use", { href: "#nxb-body-path", fill: "url(#nxb-body)", stroke: "#3c3d46", "stroke-width": "0.4", "stroke-linejoin": "round" }),
                h(
                  "g",
                  { "clip-path": "url(#nxb-clip)" },
                  h("ellipse", { cx: "56", cy: "24", rx: "46", ry: "16", fill: "url(#nxb-sheen)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "17", cy: "72", rx: "14", ry: "24", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "96", cy: "72", rx: "14", ry: "24", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "24.56", cy: "34.70", rx: "9.6", ry: "9", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "72.19", cy: "53.52", rx: "9.6", ry: "9", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "39.26", cy: "54.99", rx: "10.4", ry: "9.8", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "56.46", cy: "35.44", rx: "8.6", ry: "8", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                  h("ellipse", { cx: "88", cy: "36", rx: "11", ry: "10.6", fill: "url(#nxb-ao)", filter: "url(#nxb-soft)" }),
                ),
                // Guide: the silver ball in the 360's green ring.
                h("circle", { cx: "56.46", cy: "34.64", r: "6.3", fill: "url(#nxb-well)" }),
                h("circle", { cx: "56.46", cy: "34.64", r: "5.5", fill: "none", stroke: "rgba(111,190,88,0.35)", "stroke-width": "1.6", filter: "url(#nxb-soft)" }),
                h("circle", { cx: "56.46", cy: "34.64", r: "5.5", fill: "none", stroke: "#6fbe58", "stroke-width": "0.7" }),
                h("circle", { "data-fn": "guide", cx: "56.46", cy: "34.64", r: "4.4", fill: "url(#nxb-ball)", stroke: "#6f7178", "stroke-width": "0.2" }),
                h("ellipse", { cx: "55.06", cy: "32.94", rx: "1.7", ry: "1", fill: "rgba(255,255,255,0.55)", filter: "url(#nxb-soft)" }),
                // Back · Start.
                h("circle", { "data-fn": "back", cx: "44.55", cy: "35.67", r: "2.5", fill: "url(#nxb-dome)", stroke: "#0f1013", "stroke-width": "0.3" }),
                h("circle", { "data-fn": "start", cx: "68.07", cy: "35.67", r: "2.5", fill: "url(#nxb-dome)", stroke: "#0f1013", "stroke-width": "0.3" }),
                // Sticks.
                h("circle", { cx: "24.56", cy: "33.91", r: "7.4", fill: "url(#nxb-well)" }),
                h("circle", { "data-fn": "lthumb lx.min lx.max ly.min ly.max", cx: "24.56", cy: "33.91", r: "5.4", fill: "url(#nxb-cap)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("circle", { cx: "24.56", cy: "33.91", r: "4", fill: "none", stroke: "rgba(255,255,255,0.08)", "stroke-width": "0.5" }),
                h("ellipse", { cx: "23.06", cy: "32.01", rx: "1.9", ry: "1.1", fill: "rgba(255,255,255,0.09)", filter: "url(#nxb-soft)" }),

                h("circle", { cx: "72.19", cy: "52.72", r: "7.4", fill: "url(#nxb-well)" }),
                h("circle", { "data-fn": "rthumb rx.min rx.max ry.min ry.max", cx: "72.19", cy: "52.72", r: "5.4", fill: "url(#nxb-cap)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("circle", { cx: "72.19", cy: "52.72", r: "4", fill: "none", stroke: "rgba(255,255,255,0.08)", "stroke-width": "0.5" }),
                h("ellipse", { cx: "70.69", cy: "50.82", rx: "1.9", ry: "1.1", fill: "rgba(255,255,255,0.09)", filter: "url(#nxb-soft)" }),

                // D-pad: dish and cross, lower-left the 360 way.
                h("circle", { cx: "39.26", cy: "54.19", r: "8.4", fill: "url(#nxb-dish)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("path", {
                  "data-fn": "dpad.up dpad.down dpad.left dpad.right",
                  transform: "translate(39.26,54.19)",
                  d: "M -2,-6.4 h 4 v 4.4 h 4.4 v 4 h -4.4 v 4.4 h -4 v -4.4 h -4.4 v -4 h 4.4 z",
                  fill: "url(#nxb-cross)",
                  stroke: "#0f1014",
                  "stroke-width": "0.3",
                  "stroke-linejoin": "round",
                }),
                // The 360's face: COLOURED glossy domes with dark letters.
                h("circle", { "data-fn": "y", cx: "87.62", cy: "27.00", r: "4.2", fill: "url(#nxb-y)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("ellipse", { cx: "86.52", cy: "25.50", rx: "1.5", ry: "0.8", fill: "rgba(255,255,255,0.28)" }),
                h("circle", { "data-fn": "x", cx: "79.54", cy: "35.23", r: "4.2", fill: "url(#nxb-x)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("ellipse", { cx: "78.44", cy: "33.73", rx: "1.5", ry: "0.8", fill: "rgba(255,255,255,0.28)" }),
                h("circle", { "data-fn": "b", cx: "95.56", cy: "35.23", r: "4.2", fill: "url(#nxb-b)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("ellipse", { cx: "94.46", cy: "33.73", rx: "1.5", ry: "0.8", fill: "rgba(255,255,255,0.28)" }),
                h("circle", { "data-fn": "a", cx: "87.62", cy: "43.46", r: "4.2", fill: "url(#nxb-a)", stroke: "#0d0e11", "stroke-width": "0.3" }),
                h("ellipse", { cx: "86.52", cy: "41.96", rx: "1.5", ry: "0.8", fill: "rgba(255,255,255,0.28)" }),

                h("text", { class: "nxr-face", x: "87.62", y: "28.55", "text-anchor": "middle", fill: "#171920" }, "Y"),
                h("text", { class: "nxr-face", x: "79.54", y: "36.78", "text-anchor": "middle", fill: "#171920" }, "X"),
                h("text", { class: "nxr-face", x: "95.56", y: "36.78", "text-anchor": "middle", fill: "#171920" }, "B"),
                h("text", { class: "nxr-face", x: "87.62", y: "45.01", "text-anchor": "middle", fill: "#171920" }, "A"),
              ),
            ),
          ),
          h(
            "div",
            { class: () => nPadPsCls() },
            h(
              "svg",
              { class: "wspad", viewBox: "0 0 112.69 92", "aria-hidden": "true", focusable: "false" },
              h(
                "g",
                null,
                h("rect", { "data-fn": "lt", class: "wspad-zone", x: "20", y: "1", width: "22", height: "6.4", rx: "3.2" }),
                h("rect", { "data-fn": "rt", class: "wspad-zone", x: "70.5", y: "1", width: "22", height: "6.4", rx: "3.2" }),
                h("text", { class: "wspad-sys", x: "31", y: "5.6", "text-anchor": "middle" }, "L2"),
                h("text", { class: "wspad-sys", x: "81.5", y: "5.6", "text-anchor": "middle" }, "R2"),
                h("rect", { "data-fn": "lb", class: "wspad-zone", x: "15", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
                h("rect", { "data-fn": "rb", class: "wspad-zone", x: "65.5", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
                h("text", { class: "wspad-sys", x: "31", y: "14.6", "text-anchor": "middle" }, "L1"),
                h("text", { class: "wspad-sys", x: "81.5", y: "14.6", "text-anchor": "middle" }, "R1"),
              ),
              h(
                "g",
                { transform: "translate(0,18.5)" },
                // The vendored DualShock silhouette, exactly as /pads ships it.
                h("path", {
                  class: "wspad-shell",
                  transform: "translate(-26.849948,-130.35184)",
                  d: "m 48.4429,130.35201 c -2.656321,0.002 -5.205853,1.07801 -7.101494,2.99569 l -0.0057,-0.006 c -0.543507,0.54745 -1.098321,1.10607 -1.766298,2.11925 -0.667974,1.01319 -1.449449,2.47725 -2.442013,4.66586 -0.992562,2.18863 -2.195525,5.10062 -3.130175,7.74217 -0.93465,2.64154 -1.600236,5.01268 -2.344001,8.06669 -0.743765,3.054 -1.566531,6.79477 -2.252212,10.36887 -0.685683,3.57409 -1.234914,6.98145 -1.666211,10.78125 -0.431294,3.79979 -0.744851,7.98921 -1.05843,12.17755 l 0.0052,5.3e-4 c -0.01899,0.28002 -0.02902,0.5606 -0.03008,0.84129 -3e-6,7.05731 5.55134,12.77843 12.399351,12.77855 5.847836,-5.3e-4 10.900403,-4.21164 12.123982,-10.10481 1.382724,-4.83452 2.76621,-9.66981 3.610381,-12.32586 0.422087,-1.32802 0.710036,-2.11109 0.936565,-2.59002 0.22653,-0.47893 0.37992,-0.64455 0.56059,-0.77722 0.09034,-0.0663 0.164736,-0.11328 0.380122,-0.16019 0.188466,-0.041 0.490903,-0.0763 0.960937,-0.10646 1.873045,1.96002 4.430062,3.06486 7.099419,3.06752 2.757373,-5.3e-4 5.391548,-1.17723 7.277292,-3.25045 6.91036,-0.0284 15.424475,-0.0399 22.013906,-0.017 1.886814,2.08385 4.528252,3.26716 7.293889,3.2675 2.59502,-0.002 5.08708,-1.04648 6.94748,-2.91093 0.27817,0.0481 0.47234,0.1011 0.64149,0.15916 0.78442,0.26923 1.13782,0.61666 1.6268,1.62884 0.48898,1.01219 1.08143,2.66601 1.86379,5.02502 0.78234,2.35902 1.75609,5.42473 2.73034,8.49044 l 0.008,-0.003 c 1.02509,6.12639 6.17972,10.60355 12.21214,10.6071 6.84801,-1.2e-4 12.39935,-5.72124 12.39935,-12.77855 -0.003,-0.8035 -0.0793,-1.60493 -0.22818,-2.39365 l 0.007,-5.3e-4 c -0.23788,-2.90974 -0.47492,-5.82205 -0.94486,-9.36325 -0.46992,-3.54121 -1.17227,-7.70778 -1.93432,-11.66234 -0.76205,-3.95456 -1.5852,-7.69624 -2.32896,-10.75024 -0.74377,-3.05401 -1.40937,-5.42463 -2.34401,-8.06618 -0.93466,-2.64154 -2.13553,-5.55353 -3.1281,-7.74216 -0.99256,-2.18861 -1.77611,-3.65268 -2.44408,-4.66587 -0.66798,-1.01319 -1.22072,-1.5718 -1.76423,-2.11925 l -0.0129,0.0124 c -1.89832,-1.92388 -4.4541,-3.00212 -7.11656,-3.00234 -3.26568,0.002 -6.33073,1.62411 -8.23615,4.35735 H 56.685815 c -1.906805,-2.73523 -4.974838,-4.35705 -8.242898,-4.35735 z",
                }),
                // The touchpad — the DualShock's signature, front and centre.
                h("rect", { class: "wspad-touch", x: "37.11", y: "6.5", width: "38.39", height: "18.31", rx: "1.74" }),
                // Create · Options, the slim edge buttons beside it.
                h("rect", { "data-fn": "back", class: "wspad-zone", x: "32.6", y: "7.2", width: "2.4", height: "5.2", rx: "1.2" }),
                h("rect", { "data-fn": "start", class: "wspad-zone", x: "77.6", y: "7.2", width: "2.4", height: "5.2", rx: "1.2" }),
                // Dpad: the four petals, each its OWN direction.
                h(
                  "g",
                  { class: "wspad-petals", transform: "translate(-26.849948,-130.35184)" },
                  h("path", { "data-fn": "dpad.right", d: "m 57.303118,151.6163 c 0,1.25891 -0.201292,2.31652 -0.692974,2.8445 -0.440536,0.47354 -0.89262,0.58903 -1.407403,0.53623 -0.513135,-0.0528 -3.128295,-0.26234 -3.128295,-0.26234 0,0 -0.483433,-0.0957 -0.829925,-0.38938 -0.259041,-0.22109 -1.889184,-1.83639 -1.889184,-1.83639 0,0 -0.356388,-0.33659 -0.356388,-0.89262 0,-0.55603 0.356388,-0.89262 0.356388,-0.89262 0,0 1.630143,-1.61695 1.889184,-1.83804 0.346492,-0.29369 0.829925,-0.38774 0.829925,-0.38774 0,0 2.61516,-0.21119 3.128295,-0.26234 0.514783,-0.0528 0.966867,0.0627 1.407403,0.53458 0.491682,0.52799 0.692974,1.5856 0.692974,2.84616" }),
                  h("path", { "data-fn": "dpad.left", d: "m 37.936241,151.6163 c 0,1.25891 0.201292,2.31652 0.692974,2.8445 0.440536,0.47354 0.89262,0.58903 1.407403,0.53623 0.513135,-0.0528 3.128295,-0.26234 3.128295,-0.26234 0,0 0.483433,-0.0957 0.829925,-0.38938 0.259041,-0.22109 1.889184,-1.83639 1.889184,-1.83639 0,0 0.356388,-0.33659 0.356388,-0.89262 0,-0.55603 -0.356388,-0.89262 -0.356388,-0.89262 0,0 -1.630143,-1.61695 -1.889184,-1.83804 -0.346492,-0.29369 -0.829925,-0.38774 -0.829925,-0.38774 0,0 -2.61516,-0.21119 -3.128295,-0.26234 -0.514783,-0.0528 -0.966867,0.0627 -1.407403,0.53458 -0.491682,0.52799 -0.692974,1.5856 -0.692974,2.84616" }),
                  h("path", { "data-fn": "dpad.down", d: "m 47.730582,161.09428 c -1.25891,0 -2.31652,-0.20129 -2.8445,-0.69298 -0.47354,-0.44053 -0.58903,-0.89262 -0.53623,-1.4074 0.0528,-0.51313 0.26234,-3.12829 0.26234,-3.12829 0,0 0.0957,-0.48344 0.38938,-0.82993 0.22109,-0.25904 1.83639,-1.88918 1.83639,-1.88918 0,0 0.33659,-0.35639 0.89262,-0.35639 0.55603,0 0.89262,0.35639 0.89262,0.35639 0,0 1.61695,1.63014 1.83804,1.88918 0.29369,0.34649 0.38774,0.82993 0.38774,0.82993 0,0 0.21119,2.61516 0.26234,3.12829 0.0528,0.51478 -0.0627,0.96687 -0.53458,1.4074 -0.52799,0.49169 -1.5856,0.69298 -2.84616,0.69298" }),
                  h("path", { "data-fn": "dpad.up", d: "m 47.666334,141.82316 c -1.25891,0 -2.31652,0.20129 -2.8445,0.69297 -0.47354,0.44054 -0.58903,0.89262 -0.53623,1.40741 0.0528,0.51313 0.26234,3.12829 0.26234,3.12829 0,0 0.0957,0.48343 0.38938,0.82993 0.22109,0.25904 1.83639,1.88918 1.83639,1.88918 0,0 0.33659,0.35639 0.89262,0.35639 0.55603,0 0.89262,-0.35639 0.89262,-0.35639 0,0 1.61695,-1.63014 1.83804,-1.88918 0.29369,-0.3465 0.38774,-0.82993 0.38774,-0.82993 0,0 0.21119,-2.61516 0.26234,-3.12829 0.0528,-0.51479 -0.0627,-0.96687 -0.53458,-1.40741 -0.52799,-0.49168 -1.5856,-0.69297 -2.84616,-0.69297" }),
                ),
                // Sticks: symmetric and low, the PlayStation way.
                h("circle", { class: "wspad-well", cx: "38.1", cy: "36.12", r: "9.6" }),
                h("circle", { "data-fn": "lthumb lx.min lx.max ly.min ly.max", class: "wspad-stick", cx: "38.1", cy: "36.12", r: "6.6" }),
                h("circle", { class: "wspad-well", cx: "74.46", cy: "36.12", r: "9.6" }),
                h("circle", { "data-fn": "rthumb rx.min rx.max ry.min ry.max", class: "wspad-stick", cx: "74.46", cy: "36.12", r: "6.6" }),
                // The face shapes, drawn as SHAPES: triangle, circle, cross, square.
                h("circle", { "data-fn": "y", class: "wspad-zone", cx: "91.52", cy: "12.85", r: "4.1" }),
                h("circle", { "data-fn": "b", class: "wspad-zone", cx: "99.61", cy: "20.89", r: "4.1" }),
                h("circle", { "data-fn": "a", class: "wspad-zone", cx: "91.56", cy: "28.79", r: "4.1" }),
                h("circle", { "data-fn": "x", class: "wspad-zone", cx: "83.37", cy: "20.82", r: "4.1" }),
                h("path", { class: "wspad-glyph", d: "M 91.52,10.95 94.535,15.05 88.505,15.05 Z" }),
                h("circle", { class: "wspad-glyph", cx: "99.61", cy: "20.89", r: "1.9" }),
                h("path", { class: "wspad-glyph", d: "M 89.86,27.09 93.26,30.49 M 93.26,27.09 89.86,30.49" }),
                h("rect", { class: "wspad-glyph", x: "81.67", y: "19.12", width: "3.4", height: "3.4" }),
                // The PS lamp.
                h("circle", { class: "wspad-well", cx: "56.34", cy: "41.33", r: "3.4" }),
                h("circle", { "data-fn": "guide", class: "wspad-guide", cx: "56.34", cy: "41.33", r: "1.7" }),
              ),
            ),
          ),
        ),
        h(
          "div",
          { class: "n-kbhead" },
          h("span", { class: "n-kick" }, () => nKbTitle()),
          h("div", { class: "n-spring" }),
        ),
        // ── Prepared-for-play (migrated from /start's capture card) ────────
        h(
          "div",
          { class: () => nCapdCls() },
          h(
            "details",
            { class: "n-capdet" },
            h(
              "summary",
              { class: "n-capsum" },
              h("span", { class: () => nCapSwCls() }, h("span", { class: "nx-knob" })),
              h("span", { class: "n-capline" }, () => nCapLine()),
            ),
            h(
              "div",
              { class: "n-capbody" },
              createShow(
                () => nCapPrep(),
                () =>
                  h(
                    "form",
                    { class: "n-capform", method: "post", action: "/nocturne/capture/prepare" },
                    h("input", { type: "hidden", name: "expected_selector", value: () => nCapSelector() }),
                    h("input", { type: "hidden", name: "instance_id", value: () => nCapInstance() }),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Windows prepares only the keyboard you selected. It stops ordinary typing until you release it here.",
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_spare_keyboard", value: "yes", required: "" }),
                      h("span", null, "I connected and tested a different keyboard that can still type."),
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_rebind", value: "yes", required: "" }),
                      h(
                        "span",
                        null,
                        "I understand this selected keyboard will stop ordinary typing until I release it here, and I will release it before connecting another identical keyboard.",
                      ),
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_machine_certificate", value: "yes", required: "" }),
                      h(
                        "span",
                        null,
                        "I allow ksx to install a machine-local signing certificate for this computer's generated device package.",
                      ),
                    ),
                    h(
                      "div",
                      { class: "n-caprow-act" },
                      h("button", { class: "nd-btn primary", type: "submit" }, "Prepare selected keyboard"),
                    ),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Windows will show a permission prompt. The app stays open and does not show a command window.",
                    ),
                  ),
              ),
              createShow(
                () => nCapRel(),
                () =>
                  h(
                    "form",
                    { class: "n-capform", method: "post", action: "/nocturne/capture/release" },
                    h("input", { type: "hidden", name: "expected_selector", value: () => nCapSelector() }),
                    h("input", { type: "hidden", name: "instance_id", value: () => nCapInstance() }),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Release removes the Windows package and returns this keyboard to ordinary typing. Your unsaved choices stay on this screen.",
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_release", value: "yes", required: "" }),
                      h("span", null, "I want to return this selected keyboard to ordinary typing."),
                    ),
                    h(
                      "div",
                      { class: "n-caprow-act" },
                      h("button", { class: "nd-btn primary", type: "submit" }, "Release selected keyboard"),
                    ),
                  ),
              ),
            ),
          ),
        ),
        h(
          "div",
          { class: "n-kb" },
          h(
            "div",
            { class: "n-kbcase" },
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow1(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow2(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow3(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow4(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow5(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow6(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
          ),
        ),
        // Bound keys that are not on the standard board — honest, never
        // silently dropped.
        h(
          "div",
          { class: () => nKbTrayCls() },
          h("span", { class: "n-kbtray-head" }, () => nKbTrayHead()),
          h(
            "div",
            { class: "n-kbtray-row" },
            createList(
              () => nKbTray(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
        ),
        h("p", { class: "n-devnote" }, () => nKbNote()),
      ),
      // ── Right pane: the binding list, off the mapper's own machinery ─────
      h(
        "aside",
        { class: () => nRightCls() },
        h(
          "div",
          { class: "n-rail" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-right" }, "‹"),
          h("span", { class: "n-rail-vlab" }, "Bindings"),
        ),
        h(
          "div",
          { class: "n-filter-row" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-right" }, "›"),
          h(
            "div",
            { class: "n-filter" },
            h("span", { class: "n-filter-ico" }, "⌕"),
            h("input", { class: "n-filter-in", type: "text", placeholder: "Filter inputs" }),
          ),
          h("button", { class: "n-reset", type: "button", "data-nx": "filter-reset" }, "Reset"),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, () => nBindTitle()),
        ),
        // The capture banner: INLINE, role=status — a deliberate a11y
        // contract change from /map's dialog, documented at M9. It says
        // which control is armed and that Esc cancels; the countdown ticks
        // in the sub-line.
        h(
          "div",
          { role: "status", class: () => nLearnCls() },
          h("span", { class: "n-learn-dot" }),
          h(
            "span",
            { class: "n-learn-txt" },
            h("span", { class: "n-learn-line" }, () => nLearnText()),
            h("span", { class: "n-learn-sub" }, () => nLearnSub()),
          ),
          h("button", { type: "button", class: "n-bbtn sm", "data-nx": "learn-cancel" }, "Cancel"),
        ),
        // Every row is the mapper's own truth (keys, fan-out, turbo and
        // toggle notes) AND a native disclosure: the summary is the row,
        // the body is the rebind editor. Rebind/Add arm the daemon's
        // learner; Hold|Toggle and Turbo are real form twins that work
        // with scripting off; Clear was already real.
        createList(
          () => nBindRows(),
          (r) =>
            [
              r.function,
              r.label,
              r.chip,
              r.note,
              r.cls,
              r.chip_cls,
              r.clear_cls,
              r.slot,
              r.turbo,
              r.hold_cls,
              r.tog_cls,
            ].join("|"),
          (r) =>
            h(
              "details",
              { class: r.cls, "data-fn": r.function, "data-slot": r.slot },
              h(
                "summary",
                { class: "n-bind-sum" },
                h("span", { class: "n-bind-dot" }),
                h(
                  "span",
                  { class: "n-bind-txt" },
                  h("span", { class: "n-bind-label" }, r.label),
                  h("span", { class: "n-bind-note" }, r.note),
                ),
                h("span", { class: r.chip_cls }, r.chip),
              ),
              h(
                "div",
                { class: "n-bedit" },
                h(
                  "div",
                  { class: "n-bedit-row" },
                  h(
                    "button",
                    { type: "button", class: "n-bbtn", "data-nx": "bind-learn" },
                    "Rebind — press a key",
                  ),
                  h(
                    "button",
                    { type: "button", class: "n-bbtn", "data-nx": "bind-add" },
                    "Add another key",
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      { type: "submit", title: "Back to unbound", class: r.clear_cls },
                      "Clear",
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit-row" },
                  h("span", { class: "n-bedit-lab" }, "Press"),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/toggle" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h("input", { type: "hidden", name: "mode", value: "hold" }),
                    h(
                      "button",
                      { type: "submit", title: "Held while the key is down", class: r.hold_cls },
                      "Hold",
                    ),
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/toggle" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h("input", { type: "hidden", name: "mode", value: "toggle" }),
                    h(
                      "button",
                      {
                        type: "submit",
                        title: "A press holds until the next press",
                        class: r.tog_cls,
                      },
                      "Toggle",
                    ),
                  ),
                  h(
                    "form",
                    { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h("span", { class: "n-bedit-lab" }, "Turbo"),
                    h("input", {
                      class: "n-turbo-in",
                      type: "text",
                      inputmode: "numeric",
                      name: "turbo_hz",
                      placeholder: "Hz",
                      title: "Presses a second — 0 turns auto-fire off",
                      value: r.turbo,
                    }),
                    h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                  ),
                ),
              ),
            ),
        ),
        // ── Macros: lifecycle rows off the same staged authoring. The
        // trigger keys rebind through the SAME learn flow as any control
        // (the rows carry data-fn="macro.<name>"); enable/disable and
        // delete are real form twins; step EDITING stays on the Controls
        // editor until its own pass — the link says so, honestly.
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, () => nMacrosHead()),
        ),
        createList(
          () => nMacroRows(),
          (r) =>
            [
              r.name,
              r.fn_name,
              r.chip,
              r.chip_cls,
              r.meta,
              r.cls,
              r.slot,
              r.toggle_label,
              r.toggle_value,
            ].join("|"),
          (r) =>
            h(
              "details",
              { class: r.cls, "data-fn": r.fn_name, "data-slot": r.slot },
              h(
                "summary",
                { class: "n-bind-sum" },
                h("span", { class: "n-bind-dot" }),
                h(
                  "span",
                  { class: "n-bind-txt" },
                  h("span", { class: "n-bind-label" }, r.name),
                  h("span", { class: "n-bind-note" }, r.meta),
                ),
                h("span", { class: r.chip_cls }, r.chip),
              ),
              h(
                "div",
                { class: "n-bedit" },
                h(
                  "div",
                  { class: "n-bedit-row" },
                  h(
                    "button",
                    { type: "button", class: "n-bbtn", "data-nx": "bind-learn" },
                    "Rebind trigger — press a key",
                  ),
                  h(
                    "button",
                    { type: "button", class: "n-bbtn", "data-nx": "bind-add" },
                    "Add trigger key",
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/macro/toggle" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "name", value: r.name }),
                    h("input", { type: "hidden", name: "enable", value: r.toggle_value }),
                    h(
                      "button",
                      {
                        type: "submit",
                        title: "A disabled macro keeps every step and never starts",
                        class: "n-bpill",
                      },
                      r.toggle_label,
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit-row" },
                  h(
                    "a",
                    { class: "n-bbtn n-bbtn-link", href: r.edit_href },
                    "Edit steps in Controls",
                  ),
                  h(
                    "details",
                    { class: "n-bdel" },
                    h("summary", { class: "n-bbtn ghost" }, "Delete…"),
                    h(
                      "div",
                      { class: "n-bdel-body" },
                      h(
                        "span",
                        { class: "n-bedit-lab" },
                        "Removes the steps and unbinds its trigger keys — in this draft only.",
                      ),
                      h(
                        "form",
                        { class: "n-inline", method: "post", action: "/nocturne/macro/delete" },
                        h("input", { type: "hidden", name: "slot", value: r.slot }),
                        h("input", { type: "hidden", name: "name", value: r.name }),
                        h("button", { type: "submit", class: "n-bbtn danger" }, "Delete this macro"),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ),
        h("p", { class: "n-devnote" }, () => nMacrosNote()),
        h("div", { class: "n-right-foot" }, () => nBindFoot()),
      ),
    ),
    // ═══ Create-controller dialog — REAL personas, layouts, SOCD ═══════════
    createShow(
      () => nDlgOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "dlg-close" },
          h(
            "div",
            { class: "nd", "data-nx": "dlg-noop", role: "dialog", "aria-label": "Create a virtual controller" },
            h(
              "form",
              { class: "nd-form", method: "post", action: "/nocturne/controller" },
              h("input", { type: "hidden", name: "preset", value: () => nAddPreset() }),
              h(
                "div",
                null,
                h("div", { class: "nd-kick" }, "New controller"),
                h("div", { class: "nd-title" }, "Create a virtual controller"),
                h("div", { class: "nd-lede" }, () => nAddLede()),
              ),
              h(
                "div",
                null,
                h("div", { class: "nd-lab" }, "Controller persona — what games will see"),
                h(
                  "div",
                  { class: "nd-grid" },
                  createList(
                    () => nPersonaRows(),
                    (r) => r.name + "|" + r.label + "|" + r.api + "|" + r.note + "|" + r.cls,
                    (r) =>
                      h(
                        "label",
                        { class: r.cls },
                        h("input", { class: "nd-radio", type: "radio", name: "persona", required: "", value: r.name }),
                        h("span", { class: "nd-card-t" }, r.label),
                        h("span", { class: "nd-card-api" }, r.api),
                        h("span", { class: "nd-card-note" }, r.note),
                      ),
                  ),
                ),
                h(
                  "div",
                  { class: "nd-note" },
                  "Mix personas freely — XInput personas cap at 4 in total (Windows); 16 slots is the KSX ceiling.",
                ),
              ),
              h(
                "div",
                { class: "nd-cols" },
                h(
                  "div",
                  { class: "nd-col" },
                  h("div", { class: "nd-lab" }, "Starting layout"),
                  h(
                    "select",
                    { class: "nd-select", name: "layout" },
                    createList(
                      () => nLayoutOpts(),
                      (r) => r.value + "|" + r.label,
                      (r) => h("option", { value: r.value }, r.label),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "nd-col" },
                  h("div", { class: "nd-lab" }, "Opposite directions (SOCD)"),
                  h(
                    "select",
                    { class: "nd-select", name: "socd" },
                    createList(
                      () => nSocdOpts(),
                      (r) => r.value + "|" + r.label,
                      (r) => h("option", { value: r.value }, r.label),
                    ),
                  ),
                ),
              ),
              h(
                "div",
                { class: "nd-actions" },
                h("button", { class: "nd-btn", type: "button", "data-nx": "dlg-close" }, "Cancel"),
                h("button", { class: "nd-btn primary", type: "submit" }, "Create controller"),
              ),
            ),
          ),
        ),
    ),
    // ═══ Key-conflict consequence dialog — the learned key already works ════
    // somewhere else. "Use here too" is a deliberate fan-out that takes
    // nothing away; Cancel changes nothing. Client-only: capture-time state.
    createShow(
      () => nConfOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "conf-cancel" },
          h(
            "div",
            { class: "nd", "data-nx": "dlg-noop", role: "dialog", "aria-label": "Key conflict" },
            h("div", { class: "nd-kick" }, "Key conflict"),
            h("div", { class: "nd-title" }, () => nConfTitle()),
            h("div", { class: "nd-lede" }, () => nConfLines()),
            h(
              "div",
              { class: "nd-actions" },
              h("button", { class: "nd-btn", type: "button", "data-nx": "conf-cancel" }, "Cancel"),
              h(
                "button",
                { class: "nd-btn primary", type: "button", "data-nx": "conf-force" },
                "Use here too",
              ),
            ),
          ),
        ),
    ),
  );
}
