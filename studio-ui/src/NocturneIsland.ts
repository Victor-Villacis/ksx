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
  cls: string;
  short: string;
  title: string;
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
  bind_title: string;
  bind_rows: NocturneBindRowView[];
  bind_foot: string;
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
const [nBindTitle, setNBindTitle] = createSignal("");
const [nBindRows, setNBindRows] = createSignal<NocturneBindRowView[]>([]);
const [nBindFoot, setNBindFoot] = createSignal("");
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
  setNBindTitle(v.bind_title);
  setNBindRows(v.bind_rows);
  setNBindFoot(v.bind_foot);
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
          (r) => r.number + "|" + r.badge + "|" + r.name + "|" + r.meta + "|" + r.cls,
          (r) =>
            h(
              "div",
              { class: r.cls },
              h("span", { class: "n-pbadge" }, r.badge),
              h(
                "div",
                { class: "n-slot-txt" },
                h("div", { class: "n-slot-name" }, r.name),
                h("div", { class: "n-slot-meta" }, r.meta),
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
        ),
        h(
          "div",
          { class: "n-stage" },
          h(
            "svg",
            { class: "n-pad", viewBox: "0 0 640 400", "aria-hidden": "true", focusable: "false" },
            h("rect", { class: "np-zone", x: "150", y: "18", width: "80", height: "27", rx: "11" }),
            h("rect", { class: "np-zone", x: "410", y: "18", width: "80", height: "27", rx: "11" }),
            h("text", { class: "np-lab", x: "190", y: "36", "text-anchor": "middle" }, "LT"),
            h("text", { class: "np-lab", x: "450", y: "36", "text-anchor": "middle" }, "RT"),
            h("rect", { class: "np-zone", x: "130", y: "54", width: "112", height: "24", rx: "12" }),
            h("rect", { class: "np-zone", x: "398", y: "54", width: "112", height: "24", rx: "12" }),
            h("text", { class: "np-lab", x: "186", y: "70", "text-anchor": "middle" }, "LB"),
            h("text", { class: "np-lab", x: "454", y: "70", "text-anchor": "middle" }, "RB"),
            h("rect", { class: "np-body", x: "110", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(19 159 284)" }),
            h("rect", { class: "np-body", x: "432", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(-19 481 284)" }),
            h("rect", { class: "np-body", x: "95", y: "85", width: "450", height: "176", rx: "74" }),
            h("circle", { class: "np-well", cx: "175", cy: "141", r: "40" }),
            h("path", { class: "np-zone", d: "M175 93 l9 13 h-18 z" }),
            h("path", { class: "np-zone", d: "M175 189 l9 -13 h-18 z" }),
            h("path", { class: "np-zone", d: "M127 141 l13 -9 v18 z" }),
            h("path", { class: "np-zone", d: "M223 141 l-13 -9 v18 z" }),
            h("circle", { class: "np-stick", cx: "175", cy: "141", r: "25" }),
            h("circle", { class: "np-well", cx: "390", cy: "213", r: "40" }),
            h("path", { class: "np-zone", d: "M390 165 l9 13 h-18 z" }),
            h("path", { class: "np-zone", d: "M390 261 l9 -13 h-18 z" }),
            h("path", { class: "np-zone", d: "M342 213 l13 -9 v18 z" }),
            h("path", { class: "np-zone", d: "M438 213 l-13 -9 v18 z" }),
            h("circle", { class: "np-stick", cx: "390", cy: "213", r: "25" }),
            h("rect", { class: "np-zone", x: "244", y: "177", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "np-zone", x: "244", y: "223", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "np-zone", x: "211", y: "203", width: "30", height: "24", rx: "6" }),
            h("rect", { class: "np-zone", x: "271", y: "203", width: "30", height: "24", rx: "6" }),
            h("circle", { class: "np-hub", cx: "256", cy: "215", r: "9" }),
            h("circle", { class: "np-zone", cx: "465", cy: "106", r: "20" }),
            h("circle", { class: "np-zone", cx: "501", cy: "142", r: "20" }),
            h("circle", { class: "np-zone", cx: "465", cy: "178", r: "20" }),
            h("circle", { class: "np-zone", cx: "429", cy: "142", r: "20" }),
            h("text", { class: "np-face", x: "465", y: "111", "text-anchor": "middle" }, "Y"),
            h("text", { class: "np-face", x: "501", y: "147", "text-anchor": "middle" }, "B"),
            h("text", { class: "np-face", x: "465", y: "183", "text-anchor": "middle" }, "A"),
            h("text", { class: "np-face", x: "429", y: "147", "text-anchor": "middle" }, "X"),
            h("rect", { class: "np-zone", x: "286", y: "132", width: "26", height: "18", rx: "7" }),
            h("rect", { class: "np-zone", x: "328", y: "132", width: "26", height: "18", rx: "7" }),
            h("circle", { class: "np-hub", cx: "320", cy: "103", r: "17" }),
            h("circle", { class: "np-guide", cx: "320", cy: "103", r: "7" }),
            h("text", { class: "np-sys", x: "299", y: "168", "text-anchor": "middle" }, "View"),
            h("text", { class: "np-sys", x: "341", y: "168", "text-anchor": "middle" }, "Menu"),
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
            { class: "n-kbrow" },
            createList(
              () => nKbRow1(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title,
              (r) =>
                h(
                  "div",
                  { title: r.title, class: r.cls },
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
                  { title: r.title, class: r.cls },
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
                  { title: r.title, class: r.cls },
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
                  { title: r.title, class: r.cls },
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
                  { title: r.title, class: r.cls },
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
                  { title: r.title, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
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
                  { title: r.title, class: r.cls },
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
