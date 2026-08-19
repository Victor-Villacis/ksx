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
  /** The player-identity ramp shade (`n-pbadge np1..np4`, wrapping). */
  badge_cls: string;
  name: string;
  meta: string;
  cls: string;
  href: string;
  /** The whole slot order with this row swapped one place — precomposed
   *  server-side; empty at that end of the order. */
  up_order: string;
  down_order: string;
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

export interface NocturneCtlChipView {
  function: string;
  label: string;
  cls: string;
}

export interface NocturneKeyRowView {
  key: string;
  targets: string;
  fns: string;
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

export interface NocturneLegendRowView {
  slot: string;
  badge: string;
  name: string;
  cls: string;
}

export interface NocturneMacroRowView {
  name: string;
  fn_name: string;
  chip: string;
  chip_cls: string;
  chip_title: string;
  add_cls: string;
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
  chip_title: string;
  badge: string;
  badge_cls: string;
  add_cls: string;
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
  apply_cls: string;
  rack_rows: NocturneRackRowView[];
  rack_empty: NocturneEmptyRowView[];
  rack_caption: string;
  add_lede: string;
  add_preset: string;
  persona_rows: NocturnePersonaRowView[];
  layout_opts: NocturneOptionRowView[];
  socd_opts: NocturneOptionRowView[];
  socd_cls: string;
  socd_num: string;
  socd_lab: string;
  socd_edit_opts: NocturneOptionRowView[];
  pad_badge: string;
  pad_badge_cls: string;
  kb_cls: string;
  undo_cls: string;
  undo_label: string;
  stage_word: string;
  pad_name: string;
  pad_sub: string;
  pad_xbox_cls: string;
  pad_ps_cls: string;
  bind_title: string;
  bind_face: NocturneBindRowView[];
  bind_dpad: NocturneBindRowView[];
  bind_shoulders: NocturneBindRowView[];
  bind_lstick: NocturneBindRowView[];
  bind_rstick: NocturneBindRowView[];
  bind_system: NocturneBindRowView[];
  bind_face_n: string;
  bind_dpad_n: string;
  bind_shoulders_n: string;
  bind_lstick_n: string;
  bind_rstick_n: string;
  bind_system_n: string;
  bind_g_cls: string;
  bind_face_cls: string;
  bind_dpad_cls: string;
  bind_shoulders_cls: string;
  bind_lstick_cls: string;
  bind_rstick_cls: string;
  bind_system_cls: string;
  slot_val: string;
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
  key_rows: NocturneKeyRowView[];
  keys_note: string;
  avail_main: NocturneKeyRowView[];
  avail_nav: NocturneKeyRowView[];
  avail_num: NocturneKeyRowView[];
  avail_main_head: string;
  avail_nav_head: string;
  avail_num_head: string;
  avail_main_cls: string;
  avail_nav_cls: string;
  avail_num_cls: string;
  legend: NocturneLegendRowView[];
  solo_label: string;
  pads: {
    slot: number;
    family: string;
    preset: string;
    title: string;
    fn_keys: Record<string, string>;
    fn_names: Record<string, string>;
  }[];
  avail_ctl_face: NocturneCtlChipView[];
  avail_ctl_dpad: NocturneCtlChipView[];
  avail_ctl_shoulders: NocturneCtlChipView[];
  avail_ctl_lstick: NocturneCtlChipView[];
  avail_ctl_rstick: NocturneCtlChipView[];
  avail_ctl_system: NocturneCtlChipView[];
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
const [nApplyCls, setNApplyCls] = createSignal("n-apply none");
const [nRackRows, setNRackRows] = createSignal<NocturneRackRowView[]>([]);
const [nRackEmpty, setNRackEmpty] = createSignal<NocturneEmptyRowView[]>([]);
const [nRackCaption, setNRackCaption] = createSignal("");
const [nAddLede, setNAddLede] = createSignal("");
const [nAddPreset, setNAddPreset] = createSignal("");
const [nPersonaRows, setNPersonaRows] = createSignal<NocturnePersonaRowView[]>([]);
const [nLayoutOpts, setNLayoutOpts] = createSignal<NocturneOptionRowView[]>([]);
const [nSocdOpts, setNSocdOpts] = createSignal<NocturneOptionRowView[]>([]);
// The rack's opposite-directions editor for the SELECTED slot. Its roster is
// a SEPARATE served list from the dialog's `nSocdOpts` — one signal cannot
// feed two createLists (the slot names would collide).
const [nSocdCls, setNSocdCls] = createSignal("n-socdform none");
const [nSocdNum, setNSocdNum] = createSignal("");
const [nSocdLab, setNSocdLab] = createSignal("");
const [nSocdEditOpts, setNSocdEditOpts] = createSignal<NocturneOptionRowView[]>([]);
const [nPadBadge, setNPadBadge] = createSignal("");
const [nPadBadgeCls, setNPadBadgeCls] = createSignal("n-pbadge");
const [nKbCls, setNKbCls] = createSignal("n-kb");
const [nUndoCls, setNUndoCls] = createSignal("n-undochip none");
const [nUndoLabel, setNUndoLabel] = createSignal("");
const [nStageWord, setNStageWord] = createSignal("");
const [nPadName, setNPadName] = createSignal("");
const [nPadSub, setNPadSub] = createSignal("");
const [nPadXboxCls, setNPadXboxCls] = createSignal("n-padwrap");
const [nPadPsCls, setNPadPsCls] = createSignal("n-padwrap none");
const [nBindTitle, setNBindTitle] = createSignal("");
// The binding list, grouped the way the physical controller is organised.
// Six lists (a list body is one flat template); the headers carry served
// "N of M bound" counts, and one served class hides the frames when no
// slot serves rows.
const [nBindFace, setNBindFace] = createSignal<NocturneBindRowView[]>([]);
const [nBindDpad, setNBindDpad] = createSignal<NocturneBindRowView[]>([]);
const [nBindShl, setNBindShl] = createSignal<NocturneBindRowView[]>([]);
const [nBindLs, setNBindLs] = createSignal<NocturneBindRowView[]>([]);
const [nBindRs, setNBindRs] = createSignal<NocturneBindRowView[]>([]);
const [nBindSys, setNBindSys] = createSignal<NocturneBindRowView[]>([]);
const [nBindFaceN, setNBindFaceN] = createSignal("");
const [nBindDpadN, setNBindDpadN] = createSignal("");
const [nBindShlN, setNBindShlN] = createSignal("");
const [nBindLsN, setNBindLsN] = createSignal("");
const [nBindRsN, setNBindRsN] = createSignal("");
const [nBindSysN, setNBindSysN] = createSignal("");
const [nBindGCls, setNBindGCls] = createSignal("n-bindgroups none");
// Per-group section classes: the server hides a group whose rows are ALL
// filtered by ?q= (the no-JS filter), and the client sweep mirrors it.
const [nBindFaceCls, setNBindFaceCls] = createSignal("n-bindg");
const [nBindDpadCls, setNBindDpadCls] = createSignal("n-bindg");
const [nBindShlCls, setNBindShlCls] = createSignal("n-bindg");
const [nBindLsCls, setNBindLsCls] = createSignal("n-bindg");
const [nBindRsCls, setNBindRsCls] = createSignal("n-bindg");
const [nBindSysCls, setNBindSysCls] = createSignal("n-bindg");
// The current slot number, for the filter form's hidden field.
const [nSlotVal, setNSlotVal] = createSignal("");
const [nBindFoot, setNBindFoot] = createSignal("");
const [nMacrosHead, setNMacrosHead] = createSignal("");
const [nMacroRows, setNMacroRows] = createSignal<NocturneMacroRowView[]>([]);
const [nMacrosNote, setNMacrosNote] = createSignal("");
const [nLegend, setNLegend] = createSignal<NocturneLegendRowView[]>([]);
const [nSoloLbl, setNSoloLbl] = createSignal("");
const [nKbRow1, setNKbRow1] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow2, setNKbRow2] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow3, setNKbRow3] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow4, setNKbRow4] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow5, setNKbRow5] = createSignal<NocturneKeyCellView[]>([]);
const [nKbRow6, setNKbRow6] = createSignal<NocturneKeyCellView[]>([]);
const [nKbTray, setNKbTray] = createSignal<NocturneKeyCellView[]>([]);
const [nKeyRows, setNKeyRows] = createSignal<NocturneKeyRowView[]>([]);
const [nKeysNote, setNKeysNote] = createSignal("");
const [nAvailMain, setNAvailMain] = createSignal<NocturneKeyRowView[]>([]);
const [nAvailNav, setNAvailNav] = createSignal<NocturneKeyRowView[]>([]);
const [nAvailNum, setNAvailNum] = createSignal<NocturneKeyRowView[]>([]);
const [nAvailMainHead, setNAvailMainHead] = createSignal("");
const [nAvailNavHead, setNAvailNavHead] = createSignal("");
const [nAvailNumHead, setNAvailNumHead] = createSignal("");
const [nAvailMainCls, setNAvailMainCls] = createSignal("n-akeysec none");
const [nAvailNavCls, setNAvailNavCls] = createSignal("n-akeysec none");
const [nAvailNumCls, setNAvailNumCls] = createSignal("n-akeysec none");
const [nCtlFace, setNCtlFace] = createSignal<NocturneCtlChipView[]>([]);
const [nCtlDpad, setNCtlDpad] = createSignal<NocturneCtlChipView[]>([]);
const [nCtlShl, setNCtlShl] = createSignal<NocturneCtlChipView[]>([]);
const [nCtlLs, setNCtlLs] = createSignal<NocturneCtlChipView[]>([]);
const [nCtlRs, setNCtlRs] = createSignal<NocturneCtlChipView[]>([]);
const [nCtlSys, setNCtlSys] = createSignal<NocturneCtlChipView[]>([]);
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
  setNApplyCls(v.apply_cls);
  setNRackRows(v.rack_rows);
  setNRackEmpty(v.rack_empty);
  setNRackCaption(v.rack_caption);
  setNAddLede(v.add_lede);
  setNAddPreset(v.add_preset);
  setNPersonaRows(v.persona_rows);
  setNLayoutOpts(v.layout_opts);
  setNSocdOpts(v.socd_opts);
  setNSocdCls(v.socd_cls);
  setNSocdNum(v.socd_num);
  setNSocdLab(v.socd_lab);
  setNSocdEditOpts(v.socd_edit_opts);
  setNPadBadge(v.pad_badge);
  setNPadBadgeCls(v.pad_badge_cls);
  setNKbCls(v.kb_cls);
  setNUndoCls(v.undo_cls);
  setNUndoLabel(v.undo_label);
  setNStageWord(v.stage_word);
  setNPadName(v.pad_name);
  setNPadSub(v.pad_sub);
  setNPadXboxCls(v.pad_xbox_cls);
  setNPadPsCls(v.pad_ps_cls);
  setNBindTitle(v.bind_title);
  setNBindFace(v.bind_face);
  setNBindDpad(v.bind_dpad);
  setNBindShl(v.bind_shoulders);
  setNBindLs(v.bind_lstick);
  setNBindRs(v.bind_rstick);
  setNBindSys(v.bind_system);
  setNBindFaceN(v.bind_face_n);
  setNBindDpadN(v.bind_dpad_n);
  setNBindShlN(v.bind_shoulders_n);
  setNBindLsN(v.bind_lstick_n);
  setNBindRsN(v.bind_rstick_n);
  setNBindSysN(v.bind_system_n);
  setNBindGCls(v.bind_g_cls);
  setNBindFaceCls(v.bind_face_cls);
  setNBindDpadCls(v.bind_dpad_cls);
  setNBindShlCls(v.bind_shoulders_cls);
  setNBindLsCls(v.bind_lstick_cls);
  setNBindRsCls(v.bind_rstick_cls);
  setNBindSysCls(v.bind_system_cls);
  setNSlotVal(v.slot_val);
  setNBindFoot(v.bind_foot);
  setNMacrosHead(v.macros_head);
  setNMacroRows(v.macro_rows);
  setNMacrosNote(v.macros_note);
  setNLegend(v.legend);
  setNSoloLbl(v.solo_label);
  setNKbRow1(v.kb_row1);
  setNKbRow2(v.kb_row2);
  setNKbRow3(v.kb_row3);
  setNKbRow4(v.kb_row4);
  setNKbRow5(v.kb_row5);
  setNKbRow6(v.kb_row6);
  setNKbTray(v.kb_tray);
  setNKeyRows(v.key_rows);
  setNKeysNote(v.keys_note);
  setNAvailMain(v.avail_main);
  setNAvailNav(v.avail_nav);
  setNAvailNum(v.avail_num);
  setNAvailMainHead(v.avail_main_head);
  setNAvailNavHead(v.avail_nav_head);
  setNAvailNumHead(v.avail_num_head);
  setNAvailMainCls(v.avail_main_cls);
  setNAvailNavCls(v.avail_nav_cls);
  setNAvailNumCls(v.avail_num_cls);
  setNCtlFace(v.avail_ctl_face);
  setNCtlDpad(v.avail_ctl_dpad);
  setNCtlShl(v.avail_ctl_shoulders);
  setNCtlLs(v.avail_ctl_lstick);
  setNCtlRs(v.avail_ctl_rstick);
  setNCtlSys(v.avail_ctl_system);
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
  // Reconciliation may have replaced rows or keycaps: the live paint's
  // cached node lists re-query on the next frame, the board refits, and
  // the filter re-applies — a fresh row arrives without the imperative
  // `.hide` class its predecessor carried.
  liveKeyNodes = null;
  liveFnNodes = null;
  scheduleKbFit();
  const root = learnRoot;
  if (root) {
    const query = root.querySelector<HTMLInputElement>(".n-filter-in")?.value ?? "";
    if (query.trim() !== "") applyNocturneFilter(root, query);
    // Fresh rows arrive closed; the user's open editors come back.
    for (const el of Array.from(
      root.querySelectorAll<HTMLDetailsElement>(".n-right details[data-fn]"),
    )) {
      el.open = openRows.has(el.getAttribute("data-fn") ?? "");
    }
    syncExpandLabel();
    paintStageCallouts();
    if (assignKey) markAssignTargets(assignKey);
  }
  lastBindView = v;
  if (learnRoot) {
    paintStageCallouts();
    syncPadGrid();
    // Reorders move controllers between seats: the identity colours, the
    // mute classes and the legend follow their presets to the new numbers.
    applySlotColors();
    applyNocturneUi();
    syncBoardFilter();
  }
}

/** The last applied view, for repainting the stage callouts after the
 *  island mounts — the seed applies BEFORE `learnRoot` exists, and an idle
 *  page's deduped polls never re-apply. */
let lastBindView: NocturneView | null = null;

/** The stage's glance callouts: every control shows the key(s) that press
 *  it, straight from the served rows. Imperative textContent on
 *  data-live-chatter nodes (the ticker's contract). */
export function paintStageCallouts(): void {
  const root = learnRoot;
  const v = lastBindView;
  if (!root || !v) return;
  const fnKeys = new Map<string, string>();
  for (const rows of [
    v.bind_face,
    v.bind_dpad,
    v.bind_shoulders,
    v.bind_lstick,
    v.bind_rstick,
    v.bind_system,
  ]) {
    for (const bindRow of rows) {
      if (bindRow.chip !== "Unbound") fnKeys.set(bindRow.function.toLowerCase(), bindRow.chip);
    }
  }
  // Callouts speak the BOARD's printed-cap vocabulary ("9", "LShift") \u2014 the
  // full key name lives in the pane; the diagram gets the keycap spelling.
  const capFor = (name: string): string => {
    const cap = root
      .querySelector<HTMLElement>(`.n-kb .n-key[data-key="${CSS.escape(name)}"] .n-key-cap`)
      ?.textContent?.trim();
    if (!cap || cap === name) return name;
    if (name.startsWith("Left") && name.length > 4 && !cap.startsWith("L")) return "L" + cap;
    if (name.startsWith("Right") && name.length > 5 && !cap.startsWith("R")) return "R" + cap;
    return cap;
  };
  for (const el of Array.from(root.querySelectorAll<SVGTextElement>(".n-stage text.n-fnkey"))) {
    const fns = (el.getAttribute("data-fn") ?? "").split(/\s+/);
    const parts: string[] = [];
    for (const fn of fns) {
      const keys = fnKeys.get(fn.toLowerCase());
      if (keys) parts.push(keys.split(" \u00b7 ").map(capFor).join("\u00b7"));
    }
    let text = parts.join("\u00b7");
    if (text.length > 9) text = text.slice(0, 8) + "\u2026";
    el.textContent = text;
  }
}

/** The multi-pad grid: every staged controller cloned from its family's
 *  master art, colour-framed, slot-stamped — all mappable at once. Clones
 *  are built imperatively AFTER hydration from browser-kept preference
 *  (the parity gate's empty-storage run stays single-pad), and rebuilt
 *  only when the pad roster changes. */
let padGridPrint = "";

/** The zoom ladder: EXACT pad widths (fixed tracks, so every step is a
 *  visible size change; auto-fill wraps the columns). `padZoom` of -1 is
 *  FIT: the largest width that shows every pad without scrolling, solved
 *  against the stage's box and re-solved on resize. */
const PAD_STEPS = [240, 300, 380, 480, 600, 760];

function fitPadWidth(grid: HTMLElement, count: number): number {
  const stage = grid.closest<HTMLElement>(".n-stage");
  const cw = grid.clientWidth - 20;
  const ch = (stage?.clientHeight ?? 0) - 24;
  if (cw <= 0 || ch <= 0 || count === 0) return 340;
  // A card's height follows its width; measure a real card when one
  // exists, else start from the art's rough aspect.
  const sample = grid.querySelector<HTMLElement>(".n-mini");
  const ratio =
    sample && sample.offsetWidth > 0 ? sample.offsetHeight / sample.offsetWidth : 0.95;
  const gap = 14;
  let best = 220;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    // Width capped by BOTH axes: the columns' share of the width AND the
    // rows' share of the height — a wide short stage fits pads by height,
    // not by collapsing to the floor.
    const byWidth = (cw - gap * (cols - 1)) / cols;
    const byHeight = (ch - gap * (rows - 1)) / rows / ratio;
    const w = Math.floor(Math.min(byWidth, byHeight));
    if (w < 220) continue;
    best = Math.max(best, Math.min(w, 820));
  }
  return best;
}

let padFitQueued = false;
function schedulePadFit(): void {
  if (padFitQueued) return;
  padFitQueued = true;
  window.requestAnimationFrame(() => {
    padFitQueued = false;
    if (ui.padsAll) syncPadGrid();
  });
}

function calloutText(chip: string, capFor: (name: string) => string): string {
  let text = chip
    .split(" \u00b7 ")
    .map(capFor)
    .join("\u00b7");
  if (text.length > 9) text = text.slice(0, 8) + "\u2026";
  return text;
}

function capForBoard(root: HTMLElement): (name: string) => string {
  return (name: string): string => {
    const cap = root
      .querySelector<HTMLElement>(`.n-kb .n-key[data-key="${CSS.escape(name)}"] .n-key-cap`)
      ?.textContent?.trim();
    if (!cap || cap === name) return name;
    if (name.startsWith("Left") && name.length > 4 && !cap.startsWith("L")) return "L" + cap;
    if (name.startsWith("Right") && name.length > 5 && !cap.startsWith("R")) return "R" + cap;
    return cap;
  };
}

export function syncPadGrid(): void {
  const root = learnRoot;
  const v = lastBindView;
  if (!root || !v) return;
  const stage = root.querySelector<HTMLElement>(".n-stage");
  const grid = root.querySelector<HTMLElement>(".n-padgrid");
  if (!stage || !grid) return;
  const pads = v.pads ?? [];
  const on = ui.padsAll && pads.length > 0;
  const was = stage.classList.contains("multi");
  stage.classList.toggle("multi", on);
  // The board's height budget depends on this mode; refit it on a flip.
  if (was !== on) scheduleKbFit();
  const btn = root.querySelector<HTMLElement>(".n-padsbtn");
  btn?.setAttribute("aria-pressed", on ? "true" : "false");
  if (!on) {
    if (grid.firstChild) {
      grid.textContent = "";
      padGridPrint = "";
      liveFnNodes = null;
    }
    return;
  }
  const print = pads.map((p) => p.slot + ":" + p.family + ":" + p.title).join("|");
  if (print !== padGridPrint) {
    padGridPrint = print;
    grid.textContent = "";
    // The two masters, in template order: [0] Xbox, [1] DualShock.
    const masters = root.querySelectorAll<HTMLElement>(".n-padwrap");
    for (const pv of pads) {
      const master = pv.family === "ps" ? masters[1] : masters[0];
      const svg = master?.querySelector("svg");
      if (!svg) continue;
      const wrap = document.createElement("div");
      wrap.className = "n-mini np" + pv.slot;
      wrap.setAttribute("data-pad-slot", String(pv.slot));
      const head = document.createElement("div");
      head.className = "n-mini-head";
      const badge = document.createElement("span");
      badge.className = "n-pbadge np" + pv.slot;
      badge.textContent = "P" + pv.slot;
      const title = document.createElement("span");
      title.className = "n-mini-title";
      title.textContent = pv.title;
      head.append(badge, title);
      wrap.append(head, svg.cloneNode(true));
      grid.append(wrap);
    }
    liveFnNodes = null;
  }
  // Size the tracks AFTER the clones exist, so Fit can measure a real
  // card's aspect instead of guessing.
  let width = ui.padZoom < 0 ? fitPadWidth(grid, pads.length) : (PAD_STEPS[ui.padZoom] ?? 340);
  grid.style.setProperty("--padw", `${width}px`);
  if (ui.padZoom < 0) {
    // The estimate can miss by a hair (constant card chrome, paddings):
    // measure the real overflow and shrink once to guarantee the fit.
    const stageBox = grid.closest<HTMLElement>(".n-stage");
    if (stageBox && stageBox.scrollHeight > stageBox.clientHeight) {
      width = Math.max(
        220,
        Math.floor((width * stageBox.clientHeight) / stageBox.scrollHeight) - 2,
      );
      grid.style.setProperty("--padw", `${width}px`);
    }
  }
  root
    .querySelector('[data-nx="pad-zoom-fit"]')
    ?.setAttribute("aria-pressed", ui.padZoom < 0 ? "true" : "false");
  // Dress every clone's callouts from ITS slot's own table.
  const capFor = capForBoard(root);
  for (const wrap of Array.from(grid.querySelectorAll<HTMLElement>("[data-pad-slot]"))) {
    const pv = pads.find((x) => String(x.slot) === wrap.getAttribute("data-pad-slot"));
    if (!pv) continue;
    const byFn = new Map<string, string>();
    for (const [fnName, keys] of Object.entries(pv.fn_keys)) {
      byFn.set(fnName.toLowerCase(), keys);
    }
    for (const el of Array.from(wrap.querySelectorAll<SVGTextElement>("text.n-fnkey"))) {
      const fns = (el.getAttribute("data-fn") ?? "").split(/\s+/);
      const parts: string[] = [];
      for (const fnName of fns) {
        const keys = byFn.get(fnName.toLowerCase());
        if (keys) parts.push(calloutText(keys, capFor));
      }
      el.textContent = parts.join("\u00b7");
    }
  }
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
const [nCenterCls, setNCenterCls] = createSignal("n-center");
const [nLeftCls, setNLeftCls] = createSignal("n-left");
const [nRightCls, setNRightCls] = createSignal("n-right");
const [nIdLinkCls, setNIdLinkCls] = createSignal("n-link");
const [nIdBoxCls, setNIdBoxCls] = createSignal("n-idbox none");
const [nIdText, setNIdText] = createSignal("Press a key on the keyboard you want to use");

const ui: {
  dlg: boolean;
  leftRail: boolean;
  rightRail: boolean;
  kbClosed: boolean;
  identify: boolean;
  rightView: "controls" | "keys";
  padsAll: boolean;
  padZoom: number;
  kbSolo: boolean;
} = {
  dlg: false,
  leftRail: false,
  rightRail: false,
  kbClosed: false,
  identify: false,
  rightView: "controls",
  padsAll: false,
  padZoom: -1,
  kbSolo: false,
};

function applyNocturneUi(): void {
  setNDlgOpen(ui.dlg);
  setNLeftCls(ui.leftRail ? "n-left rail" : "n-left");
  setNRightCls(
    "n-right" + (ui.rightRail ? " rail" : "") + (ui.rightView === "keys" ? " keys-mode" : ""),
  );
  const pads = lastBindView?.pads ?? [];
  setNCenterCls(
    "n-center" +
      (ui.kbClosed ? " kb-closed" : "") +
      (ui.kbSolo ? " solo" : "") +
      pads
        .filter((pv) => hiddenStrips.has(pv.preset))
        .map((pv) => ` mute${pv.slot}`)
        .join(""),
  );
  // Any pane change resizes the center: the board refits.
  scheduleKbFit();
  setNIdLinkCls(ui.identify ? "n-link on" : "n-link");
  setNIdBoxCls(ui.identify ? "n-idbox listen" : "n-idbox none");
  setNIdText("Press a key on the keyboard you want to use");
}

// ── Chrome preferences that survive a refresh ──────────────────────────────
// The pane rails are a layout choice, not a transient disclosure: collapsing
// a pane and losing it on reload reads as the page forgetting you. Stored in
// localStorage (loaded BEFORE the island builds, so the hydrated first paint
// is already collapsed); dialogs, folds and the capture state stay
// deliberately transient.

const UI_STORE = "ksx-nocturne-ui";

function loadUiPrefs(): void {
  try {
    const raw = window.localStorage.getItem(UI_STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as {
      leftRail?: boolean;
      rightRail?: boolean;
      kbClosed?: boolean;
      rightView?: string;
      padsAll?: boolean;
      padZoom?: number;
      kbSolo?: boolean;
    };
    ui.leftRail = saved.leftRail === true;
    ui.rightView = saved.rightView === "keys" ? "keys" : "controls";
    ui.rightRail = saved.rightRail === true;
    ui.kbClosed = saved.kbClosed === true;
    ui.padsAll = saved.padsAll === true;
    ui.padZoom =
      typeof saved.padZoom === "number"
        ? Math.min(5, Math.max(-1, Math.round(saved.padZoom)))
        : -1;
    ui.kbSolo = saved.kbSolo === true;
  } catch {
    // A blocked or corrupt store reads as the defaults.
  }
}

/** Identity colours, keyed by PRESET NAME — the controller's stable
 *  identity: seats renumber on reorder, worksheets travel, and the colour
 *  travels with them. First-seen defaults are made STICKY (persisted), so
 *  even a never-touched controller keeps its colour wherever it moves;
 *  new controllers take the first free colour. Browser-kept, never daemon
 *  state; with an empty store the assignment equals the CSS defaults and
 *  no style attribute is written (the parity gate's rule). */
const COLOR_STORE = "ksx-nocturne-colors2";
let padColors: Record<string, number> = {};
/** Presets whose colour strips are hidden on the BOARD (same identity
 *  rule). The kbhead's "Colours" button stays the master switch. */
const STRIPS_STORE = "ksx-nocturne-strips2";
let hiddenStrips = new Set<string>();

function saveSlotColors(): void {
  try {
    window.localStorage.setItem(COLOR_STORE, JSON.stringify(padColors));
  } catch {
    // The preference simply will not survive this session.
  }
}

/** Every current pad's colour, resolved: picks first, then seat defaults
 *  skipping taken colours; unseen presets get their default PERSISTED so
 *  it sticks to the controller from now on. */
function colourAssignments(): Map<number, number> {
  const pads = lastBindView?.pads ?? [];
  const out = new Map<number, number>();
  const taken = new Set<number>();
  let learned = false;
  for (const pv of pads) {
    const pick = padColors[pv.preset];
    if (typeof pick === "number" && pick >= 1 && pick <= 16 && !taken.has(pick)) {
      out.set(pv.slot, pick);
      taken.add(pick);
    }
  }
  for (const pv of pads) {
    if (out.has(pv.slot)) continue;
    let idx = ((pv.slot - 1) % 16) + 1;
    while (taken.has(idx)) idx = (idx % 16) + 1;
    out.set(pv.slot, idx);
    taken.add(idx);
    padColors[pv.preset] = idx;
    learned = true;
  }
  if (learned) saveSlotColors();
  return out;
}

function presetOfSlot(slot: number): string | undefined {
  return (lastBindView?.pads ?? []).find((pv) => pv.slot === slot)?.preset;
}

function loadHiddenStrips(): void {
  try {
    const raw = window.localStorage.getItem(STRIPS_STORE);
    hiddenStrips = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    hiddenStrips = new Set();
  }
}

function saveHiddenStrips(): void {
  try {
    window.localStorage.setItem(STRIPS_STORE, JSON.stringify([...hiddenStrips]));
  } catch {
    // The preference simply will not survive this session.
  }
}

function loadSlotColors(): void {
  try {
    const raw = window.localStorage.getItem(COLOR_STORE);
    padColors = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    padColors = {};
  }
}

/** Dress every open picker's swatches with the truth: the slot's own
 *  colour ringed, colours worn by OTHER controllers disabled and named.
 *  Runs when a picker opens and after a pick — never at hydration, so the
 *  SSR paint stays byte-identical. */
function refreshSwatches(): void {
  const root = learnRoot;
  if (!root) return;
  const pads = lastBindView?.pads ?? [];
  const assigned = colourAssignments();
  for (const pick of Array.from(root.querySelectorAll<HTMLElement>(".n-cpick[data-slot]"))) {
    const slot = Number(pick.getAttribute("data-slot") ?? "");
    for (const sw of Array.from(pick.querySelectorAll<HTMLButtonElement>(".n-swatch"))) {
      const color = Number(sw.getAttribute("data-color") ?? "");
      const owner = pads.find((pv) => pv.slot !== slot && assigned.get(pv.slot) === color);
      sw.disabled = Boolean(owner);
      sw.classList.toggle("taken", Boolean(owner));
      sw.classList.toggle("mine", color === assigned.get(slot));
      sw.title = owner ? `Worn by P${owner.slot}` : `Colour ${color}`;
    }
  }
}

/** The legend chips speak their own state: a muted controller's chip goes
 *  quiet and says so. Runs after every applied payload and every toggle —
 *  never at hydration with an empty store, where the served markup is
 *  already right (the parity gate's rule). */
function syncLegend(): void {
  const root = learnRoot;
  if (!root) return;
  for (const chip of Array.from(root.querySelectorAll<HTMLElement>('[data-nx="legend-mute"]'))) {
    const preset = presetOfSlot(Number(chip.getAttribute("data-slot") ?? ""));
    const byHand = preset !== undefined && hiddenStrips.has(preset);
    // Solo is a LENS, not a merge: while it is on, the board shows the
    // selected controller and nobody else, so that is exactly what the
    // chips say — including when you had hand-crossed the selected one
    // (soloing brings it back; turning solo off returns your own state).
    const off = ui.kbSolo ? !chip.classList.contains("on") : byHand;
    chip.setAttribute("aria-pressed", off ? "false" : "true");
    chip.classList.toggle("muted", !ui.kbSolo && byHand);
    chip.title = off
      ? "Show this controller's colour on the keys"
      : "Hide this controller's colour on the keys";
  }
}

/** ONE place where the board's filter chrome learns the state: the solo
 *  button's pressed flag and every legend chip, together — so the two can
 *  never disagree about what the keys are showing. */
function syncBoardFilter(): void {
  const root = learnRoot;
  if (!root) return;
  root.querySelector(".n-kbcolors")?.setAttribute("aria-pressed", ui.kbSolo ? "true" : "false");
  syncLegend();
}

/** Is this preset the controller the page is currently editing? */
function isSelectedPreset(preset: string): boolean {
  return presetOfSlot(Number(nSlotVal() || "0")) === preset;
}

function applySlotColors(): void {
  const root = learnRoot;
  if (!root) return;
  const assigned = colourAssignments();
  for (const [slot, idx] of assigned) {
    const fallback = ((slot - 1) % 16) + 1;
    // Write only where the truth differs from the CSS default (and clear
    // where it no longer does): an untouched setup writes nothing.
    if (idx !== fallback) root.style.setProperty(`--pcs${slot}`, `var(--pal${idx})`);
    else root.style.removeProperty(`--pcs${slot}`);
  }
}

function saveUiPrefs(): void {
  try {
    window.localStorage.setItem(
      UI_STORE,
      JSON.stringify({
        leftRail: ui.leftRail,
        rightRail: ui.rightRail,
        kbClosed: ui.kbClosed,
        rightView: ui.rightView,
        padsAll: ui.padsAll,
        padZoom: ui.padZoom,
        kbSolo: ui.kbSolo,
      }),
    );
  } catch {
    // Nothing to do: the preference simply will not survive this session.
  }
}

/** Merge one query change into the page URL without navigating — the URL is
 *  the page's durable state (selection, filter), and every writer merges so
 *  it cannot clobber the other's key. */
function mergeQuery(set: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(set)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  params.delete("flash");
  const query = params.toString();
  window.history.replaceState(null, "", query === "" ? "/nocturne" : `/nocturne?${query}`);
}

/** Restore the filter from `?q=` after the island has mounted (the input
 *  does not exist before the build). Called by the entry. */
export function restoreNocturneFilter(): void {
  const root = learnRoot;
  if (!root) return;
  const q = new URLSearchParams(window.location.search).get("q") ?? "";
  const input = root.querySelector<HTMLInputElement>(".n-filter-in");
  if (input) input.value = q;
  if (q !== "") applyNocturneFilter(root, q);
}

let filterUrlTimer: number | undefined;

let kbFitRaf = 0;

export function scheduleKbFit(): void {
  if (kbFitRaf !== 0) return;
  kbFitRaf = window.requestAnimationFrame(() => {
    kbFitRaf = 0;
    fitKeyboard();
  });
}

function fitKeyboard(): void {
  const root = learnRoot;
  if (!root) return;
  const kb = root.querySelector<HTMLElement>(".n-kb");
  const kbcase = root.querySelector<HTMLElement>(".n-kbcase");
  if (!kb || !kbcase) return;
  const available = kb.clientWidth;
  const naturalW = kbcase.offsetWidth;
  const naturalH = kbcase.offsetHeight;
  if (available === 0 || naturalW === 0) return; // collapsed or not laid out
  // Width alone is not the fit: on a wide short window a width-scaled
  // board balloons and starves the stage. The board's height is budgeted
  // to a share of the centre column — tighter when the multi-pad grid is
  // open, because the pads are the point of that view.
  const center = root.querySelector<HTMLElement>(".n-center");
  const multi = Boolean(root.querySelector(".n-stage.multi"));
  const budget = center ? center.clientHeight * (multi ? 0.42 : 0.52) : Number.POSITIVE_INFINITY;
  const byWidth = available / naturalW;
  const byHeight = naturalH > 0 ? budget / naturalH : byWidth;
  const f = Math.min(1.9, Math.max(0.45, Math.min(byWidth, byHeight)));
  const next = "scale(" + f + ")";
  const changed = kbcase.style.transform !== next;
  kbcase.style.transform = next;
  kbcase.style.transformOrigin = "top left";
  kb.style.height = Math.ceil(naturalH * f) + "px";
  // The stage's height just moved; a fitted pad grid re-solves against
  // it. Converges: the second pass computes the same scale and stops.
  if (changed && multi) schedulePadFit();
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
  mode: "replace" | "add" | "remove";
}

/** PadForge's recorder tick — snappy but far under the daemon's own rate. */
const LEARN_POLL_MS = 33;

const [nLearnCls, setNLearnCls] = createSignal("n-learnbar none");
const [nLearnText, setNLearnText] = createSignal("");
const [nLearnSub, setNLearnSub] = createSignal("");
// The Apply verb's needs-restart dialog: client-only (a fetch answer),
// quoting the daemon's own difference sentence.
// Rows the user is holding open (bind + macro editors, keyed by data-fn):
// reconciliation rebuilds a row CLOSED, so the wire remembers and
// applyNocturne puts them back — an edit no longer slams the editor shut.
const openRows = new Set<string>();
const [nExpandLbl, setNExpandLbl] = createSignal("Expand all");

function syncExpandLabel(): void {
  setNExpandLbl(openRows.size > 0 ? "Collapse all" : "Expand all");
}

// The stage's assign cue — pure interaction state, like the learn banner.
const [nLearnSkipCls, setNLearnSkipCls] = createSignal("n-bbtn sm none");
const [nChainCls, setNChainCls] = createSignal("n-chain");
// The keyboard's learn cue — the mirror: a control is waiting for a key.
const [nKeyCueCls, setNKeyCueCls] = createSignal("n-key-cue none");
const [nKeyCueText, setNKeyCueText] = createSignal("");

const [nApplyOpen, setNApplyOpen] = createSignal(false);
const [nApplyMsg, setNApplyMsg] = createSignal("");
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
let pendingConflict: {
  row: LearnTarget;
  key: string;
  origin: "assign" | "learn";
  chain: boolean;
  assignMode: "replace" | "add" | "remove";
} | null = null;
/** What the write in flight was doing, so a conflict's consent dialog can
 *  resume the SAME hand ("Bind several" survives the ask). Set by every
 *  writeLearnedKey caller just before the call. */
let lastWrite: {
  origin: "assign" | "learn";
  chain: boolean;
  assignMode: "replace" | "add" | "remove";
} = { origin: "learn", chain: false, assignMode: "replace" };

/** The page poller, installed by the entry so a successful JSON bind
 *  repaints the rows immediately instead of waiting out the 2 s tick. */
let nocturnePollFn: () => void = () => {};

export function setNocturnePoll(fn: () => void): void {
  nocturnePollFn = fn;
}

function learnSentence(mode: "replace" | "add" | "remove"): string {
  if (mode === "remove") {
    return "The key you press is taken off this control's list; its other keys stay.";
  }
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
  if (ev.key === "Escape") {
    void cancelLearn();
    // Mid-walk, Esc skips just this control; the run moves on.
    autoMapAdvance(false);
  }
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

function markArmedRow(fnName: string | null, slot?: string): void {
  if (!learnRoot) return;
  for (const el of Array.from(
    learnRoot.querySelectorAll<HTMLElement>(".n-bind.arm, .n-ctlchip.arm, .n-stage .arm"),
  )) {
    el.classList.remove("arm");
  }
  if (fnName !== null) {
    // The pane speaks for the SELECTED slot only.
    const armSlot = slot ?? nSlotVal();
    if (armSlot === nSlotVal()) {
      learnRoot
        .querySelector<HTMLElement>(`.n-bind[data-fn="${CSS.escape(fnName)}"]`)
        ?.classList.add("arm");
      // A FREE control lives as its group's chip — light that too, so the
      // waiting control is visible in the pane and not just the banner.
      const wanted = fnName.toLowerCase();
      for (const chip of Array.from(
        learnRoot.querySelectorAll<HTMLElement>(".n-ctlchip[data-fn]"),
      )) {
        if ((chip.getAttribute("data-fn") ?? "").toLowerCase() === wanted) {
          chip.classList.add("arm");
        }
      }
    }
    // The waiting control glows on ITS pad — clones are slot-stamped, the
    // master speaks for the selected slot.
    const want = fnName.toLowerCase();
    for (const el of Array.from(learnRoot.querySelectorAll<HTMLElement>(".n-stage [data-fn]"))) {
      const padSlot =
        el.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot") ?? nSlotVal();
      if (padSlot !== armSlot) continue;
      const fns = (el.getAttribute("data-fn") ?? "").toLowerCase().split(/\s+/);
      if (fns.includes(want)) el.classList.add("arm");
    }
  }
}

/** The auto-map walk: every control of the selected slot in pane order,
 *  each arming its learn in turn. Purely a sequencing layer over the
 *  ordinary learn flow — every step binds, refuses and conflicts exactly
 *  like a hand-armed one. */
let autoMap: { steps: { fn: string; label: string }[]; idx: number; bound: number } | null = null;

/** The toast's "Bind several" box: while checked, an armed session
 *  survives each bind and waits for the next target, until Esc, Cancel or
 *  the timeout ends it. Shift-clicking is its one-off twin. */
function chainWanted(): boolean {
  return learnRoot?.querySelector<HTMLInputElement>(".n-chain-box")?.checked ?? false;
}

function setChainBox(on: boolean): void {
  const box = learnRoot?.querySelector<HTMLInputElement>(".n-chain-box");
  if (box) box.checked = on;
}

/** With a pane rolled away, the armed state still needs a face: the
 *  collapsed rail glows while a capture or assign waits inside. */
function setRailGlow(on: boolean): void {
  learnRoot?.querySelector<HTMLElement>(".n-right .n-rail")?.classList.toggle("arm", on);
}

function armLearnUi(row: LearnTarget): void {
  const step = autoMap ? ` — ${autoMap.idx + 1} of ${autoMap.steps.length}` : "";
  setNLearnCls("n-learnbar listen");
  setNLearnText(`Press the panel key for P${row.slot} · ${row.label}${step}`);
  setNLearnSub(`${learnSentence(row.mode)} ${autoMap ? "Esc skips this one." : "Esc cancels."}`);
  setNLearnSkipCls(autoMap ? "n-bbtn sm" : "n-bbtn sm none");
  setNChainCls(autoMap ? "n-chain none" : "n-chain");
  setNKeyCueCls("n-key-cue");
  setNKeyCueText(
    row.mode === "remove"
      ? `Waiting — press the key to remove from ${row.label}, or click it below`
      : `Waiting — press a key for ${row.label}, or click one below`,
  );
  markArmedRow(row.fn, row.slot);
  setRailGlow(true);
}

function disarmLearnUi(): void {
  setNLearnCls("n-learnbar none");
  setNLearnSkipCls("n-bbtn sm none");
  setChainBox(false);
  setNKeyCueCls("n-key-cue none");
  markArmedRow(null);
  setRailGlow(false);
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
  // The two arm flows are exclusive: a fresh learn retires a waiting assign.
  if (assignKey) cancelAssign();
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
      const esc = autoMap ? "Esc skips this one." : "Esc cancels.";
      setNLearnSub(`${learnSentence(row.mode)} ${secs}s left · ${esc}`);
      break;
    }
    case "hit": {
      // Retire before the asynchronous write: the 33 ms timer and the
      // fast-hit poll may overlap, and only the first terminal response may
      // reach the bind verb.
      const chain = chainWanted();
      lastWrite = { origin: "learn", chain, assignMode: "replace" };
      retireLearn();
      if (learn.key) {
        void writeLearnedKey(row, learn.key, false).then((ok) => {
          // "Bind several": the control keeps listening; further keys ADD.
          if (ok && chain && !autoMap) {
            void startLearn({ ...row, mode: "add" });
            setChainBox(true);
          }
        });
      }
      break;
    }
    case "timeout":
      retireLearn();
      if (autoMap) {
        // A walked-away wizard must not grind through the whole queue.
        autoMap = null;
        applyFlash(
          `error: Auto-map stopped — no key was pressed in time for ${row.label}. Nothing more changed.`,
        );
      } else {
        applyFlash(
          `error: Timed out — no key was pressed in time for ${row.label}. Nothing changed.`,
        );
      }
      break;
    case "cancelled":
      retireLearn();
      // Cancelled by someone else (another tab, Identify): fail closed.
      autoMap = null;
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

function startAutoMap(): void {
  const root = learnRoot;
  if (!root) return;
  const steps: { fn: string; label: string }[] = [];
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>(
      ".n-bindgroups details.n-bind[data-fn], .n-bindgroups .n-ctlchip[data-fn]",
    ),
  )) {
    const fn = el.getAttribute("data-fn") ?? "";
    if (!fn || fn.startsWith("macro.")) continue;
    const label =
      el.querySelector(".n-bind-label")?.textContent?.trim() || el.textContent?.trim() || fn;
    steps.push({ fn, label });
  }
  if (steps.length === 0) {
    applyFlash("error: No controls to map — add a controller first.");
    return;
  }
  autoMap = { steps, idx: 0, bound: 0 };
  stepAutoMap();
}

function stepAutoMap(): void {
  const run = autoMap;
  if (!run) return;
  if (run.idx >= run.steps.length) {
    autoMap = null;
    applyFlash(`Auto-map finished — ${run.bound} of ${run.steps.length} controls got a key.`);
    return;
  }
  const s = run.steps[run.idx];
  void startLearn({ fn: s.fn, label: s.label, slot: nSlotVal(), mode: "replace" });
}

/** One wizard step settled (bound, skipped, or conflict declined): move on. */
function autoMapAdvance(didBind: boolean): void {
  const run = autoMap;
  if (!run) return;
  if (didBind) run.bound += 1;
  run.idx += 1;
  stepAutoMap();
}

/** One learned key onto one staged control, through the server-resolved bind
 *  verb. The server reads the slot's preset identity and current key list
 *  itself; this browser is never trusted with a key list it made up. */
async function writeLearnedKey(row: LearnTarget, key: string, force: boolean): Promise<boolean> {
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
    autoMap = null;
    applyFlash("error: The bind request failed — is ksx studio still running?");
    return false;
  }
  if (outcome.ok) {
    pendingConflict = null;
    setNConfOpen(false);
    let line =
      row.mode === "add"
        ? `${key} added to ${row.label} — any of its keys presses it.`
        : row.mode === "remove"
          ? `${key} no longer drives ${row.label}.`
          : `${row.label} is now ${key}.`;
    if (outcome.also_drives.length > 0) {
      line += ` That key also drives ${outcome.also_drives.join(" · ")}.`;
    }
    applyFlash(line);
    nocturnePollFn();
    autoMapAdvance(true);
    return true;
  } else if (outcome.code === "conflict" && outcome.conflicts.length > 0) {
    // Cross-slot (or a second macro trigger): fan-out is the product, but it
    // is asked about, never assumed. "Use here too" takes nothing away.
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
    setNConfTitle(`Give ${key} to ${row.label} too?`);
    setNConfLines(
      `${lines.join("; ")}. "Use here too" shares the key — the other control keeps it as well; nothing is taken away.`,
    );
    setNConfOpen(true);
  focusDialog();
  } else {
    pendingConflict = null;
    setNConfOpen(false);
    // A refusal ends a running auto-map walk: its sentence explains why.
    autoMap = null;
    // The error is authored, self-contained customer copy either way: the
    // server module's own guard sentences, or its consumerized fallback.
    applyFlash(`error: ${outcome.error ?? "That control could not be changed. Nothing changed."}`);
  }
  return false;
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
/** Per-slot down/hit sets — the multi-pad grid lights each clone from its
 *  OWN slot's frame. */
const liveSlotFns = new Map<number, Set<string>>();
const EMPTY_FNS: ReadonlySet<string> = new Set();
const liveTicker: string[] = [];
/** Cached paint targets — invalidated whenever reconciliation may have
 *  replaced nodes (every applied payload). */
let liveKeyNodes: HTMLElement[] | null = null;
let liveFnNodes: { el: HTMLElement; fns: string[]; slot: number }[] | null = null;

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
  liveSlotFns.clear();
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

  // Every slot's frame, keyed — each pad lights from its OWN; the pane
  // rows and the board speak for the SELECTED slot.
  liveSlotFns.clear();
  for (const sf of envelope.frame.slots) {
    const set = new Set<string>();
    for (const control of sf.down) set.add(normalizedFn(control));
    for (const control of sf.hit) set.add(normalizedFn(control));
    liveSlotFns.set(sf.slot, set);
  }
  const selectedFrame =
    liveSlotFns.get(Number(nSlotVal() || "1")) ?? liveSlotFns.values().next().value ?? EMPTY_FNS;
  liveFnsDown.clear();
  for (const control of selectedFrame) liveFnsDown.add(control);
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

  // Paint: one sweep, class toggles only. The node lists are CACHED — a
  // real daemon feeds ~60 Hz, and re-querying ~200 elements per frame is
  // the kind of hidden cost that melts a laptop; applyNocturne invalidates
  // the cache whenever reconciliation may have replaced rows.
  if (liveKeyNodes === null) {
    liveKeyNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-key]"));
  }
  if (liveFnNodes === null) {
    liveFnNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-fn]")).map((el) => ({
      el,
      fns: (el.dataset.fn ?? "").split(/\s+/).map(normalizedFn),
      slot: Number(el.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot") ?? "0"),
    }));
  }
  for (const el of liveKeyNodes) {
    el.classList.toggle("live", liveKeysDown.has(el.dataset.key ?? ""));
  }
  for (const { el, fns, slot } of liveFnNodes) {
    // Space-separated where one element stands for several functions — a
    // stick lights on its click OR any of its four directions, the Xbox
    // cross on any d-pad direction. Slot-stamped nodes (the clone grid)
    // light from their OWN slot's frame.
    const down = slot === 0 ? liveFnsDown : (liveSlotFns.get(slot) ?? EMPTY_FNS);
    el.classList.toggle(
      "live",
      fns.some((fnName) => down.has(fnName)),
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
  // A row matches on its own label OR its group's ("stick" finds both
  // stick clusters even though the rows are spelled L3/←/→); a group whose
  // rows are ALL hidden hides its header too. Only under an active filter,
  // so the initial paint stays byte-equal to SSR.
  for (const group of Array.from(pane.querySelectorAll<HTMLElement>(".n-bindg"))) {
    const glabel = (group.querySelector(".n-bindg-lab")?.textContent ?? "").toLowerCase();
    const gmatch = query !== "" && glabel.includes(query);
    for (const el of Array.from(group.querySelectorAll<HTMLElement>(".n-bind"))) {
      const label = (el.querySelector(".n-bind-label")?.textContent ?? "").toLowerCase();
      el.classList.toggle("hide", query !== "" && !gmatch && !label.includes(query));
    }
    for (const chip of Array.from(group.querySelectorAll<HTMLElement>(".n-ctlchip"))) {
      const label = (chip.textContent ?? "").toLowerCase();
      chip.classList.toggle("hide", query !== "" && !gmatch && !label.includes(query));
    }
    const visible =
      group.querySelector(".n-bind:not(.hide)") !== null ||
      group.querySelector(".n-ctlchip:not(.hide)") !== null;
    group.classList.toggle("empty", query !== "" && !visible);
  }
}

/** Stage art → binding row (the pointer enhancement's worker). A multi-fn
 *  hook (a stick's click + four directions) lands on its FIRST function —
 *  the control itself; the face-button case difference (mapper UPPERCASE vs
 *  lowercase zones) is matched away. */
function locateBindRow(root: HTMLElement, fns: string): void {
  const want = (fns.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (!want) return;
  const row = Array.from(root.querySelectorAll<HTMLDetailsElement>("details.n-bind")).find(
    (el) => (el.getAttribute("data-fn") ?? "").toLowerCase() === want,
  );
  if (!row) return;
  // The pane must be visible to receive the jump.
  if (ui.rightRail) {
    ui.rightRail = false;
    saveUiPrefs();
    applyNocturneUi();
  }
  // A filter hiding the row yields to the explicit click.
  if (row.classList.contains("hide")) {
    const input = root.querySelector<HTMLInputElement>(".n-filter-in");
    if (input) input.value = "";
    applyNocturneFilter(root, "");
    mergeQuery({ q: null });
  }
  row.open = true;
  row.scrollIntoView({
    block: "nearest",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  // Restart the pulse even on a repeated click of the same control.
  row.classList.remove("locate");
  void row.offsetWidth;
  row.classList.add("locate");
  window.setTimeout(() => row.classList.remove("locate"), 3600);
}

/** The Apply form's scripted path: the same verb as the no-JS door, but the
 *  answer comes back as JSON carrying the daemon's OWN sentence — a
 *  needs-restart refusal opens the quoting dialog instead of the fixed
 *  flash the allowlist permits. */
let applyPending = false;

async function applyDraftViaJson(): Promise<void> {
  if (applyPending) return;
  applyPending = true;
  try {
    const res = await fetch("/nocturne/api/apply", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(String(res.status));
    const out = (await res.json()) as {
      done: boolean;
      code?: string;
      message?: string;
      flash?: string;
    };
    if (!out.done && out.code === "needs-restart") {
      setNApplyMsg(out.message || "The draft differs from the running session's structure.");
      setNApplyOpen(true);
      focusDialog();
    } else {
      applyFlash(out.flash ?? null);
    }
  } catch {
    applyFlash("error: request failed — is ksx studio still running?");
  } finally {
    applyPending = false;
  }
  nocturnePollFn();
}

/** Pulse a set of rows in whichever view just opened; scroll to the
 *  first. The counterpart of a jump can be SEVERAL rows (a key that fans
 *  out, a control with two keys) — all of them light. */
function pulseRows(rows: HTMLElement[]): void {
  rows.forEach((row, at) => {
    if (at === 0) {
      row.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }
    row.classList.remove("locate");
    void row.offsetWidth;
    row.classList.add("locate");
    window.setTimeout(() => row.classList.remove("locate"), 3600);
  });
}

/** The BY-KEY view's twin of locateBindRow: pulse a key's row. */
function locateKeyRow(root: HTMLElement, key: string): void {
  if (!key) return;
  const row = Array.from(
    root.querySelectorAll<HTMLElement>(".n-krows [data-key], .n-akey-grid [data-key]"),
  ).find((el) => (el.getAttribute("data-key") ?? "") === key);
  if (!row) return;
  if (ui.rightRail) {
    ui.rightRail = false;
    saveUiPrefs();
    applyNocturneUi();
  }
  row.scrollIntoView({
    block: "nearest",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  row.classList.remove("locate");
  void row.offsetWidth;
  row.classList.add("locate");
  window.setTimeout(() => row.classList.remove("locate"), 3600);
}

/** The BY-KEY assign flow: the user picked a KEY; the pad is the control
 *  picker. Rides writeLearnedKey wholesale, so refusals and the conflict
 *  dialog behave exactly like a learned key. */
let assignKey: string | null = null;
let assignMode: "replace" | "add" | "remove" = "replace";

/** Light the armed key everywhere it appears (board cap, tray, available
 *  chip) — a glow that WAITS, cleared only by resolution or Esc. */
function markAssignTargets(key: string | null): void {
  const root = learnRoot;
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".assign"))) {
    el.classList.remove("assign");
  }
  if (key) {
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(
        `.n-kb [data-key="${CSS.escape(key)}"], .n-akey-grid [data-key="${CSS.escape(key)}"]`,
      ),
    )) {
      el.classList.add("assign");
    }
  }
}

/** The assign wait has the same shape as a learn: a window, a countdown in
 *  the toast, and a timeout that says so — the two arms feel like one hand. */
const ASSIGN_WINDOW_MS = 12000;
let assignTimer: number | undefined;

function armAssign(key: string, mode: "replace" | "add" | "remove" = "replace"): void {
  assignKey = key;
  assignMode = mode;
  const deadline = Date.now() + ASSIGN_WINDOW_MS;
  setNLearnCls("n-learnbar listen");
  setNLearnText(
    mode === "add"
      ? `Click a control on the pad to add ${key}`
      : mode === "remove"
        ? `Click a control on the pad — ${key} is removed from it`
        : `Click a control on the pad — ${key} replaces its binding`,
  );
  setNChainCls("n-chain");
  setNLearnSub(`${Math.ceil(ASSIGN_WINDOW_MS / 1000)}s left · Esc cancels.`);
  setNLearnSkipCls("n-bbtn sm none");
  markAssignTargets(key);
  setRailGlow(true);
  if (assignTimer !== undefined) window.clearInterval(assignTimer);
  assignTimer = window.setInterval(() => {
    const secs = Math.ceil((deadline - Date.now()) / 1000);
    if (secs <= 0) {
      cancelAssign();
      applyFlash(`error: Timed out — no control was chosen for ${key}. Nothing changed.`);
      return;
    }
    setNLearnSub(`${secs}s left · Esc cancels.`);
  }, 250);
}

function cancelAssign(): void {
  assignKey = null;
  setChainBox(false);
  if (assignTimer !== undefined) {
    window.clearInterval(assignTimer);
    assignTimer = undefined;
  }
  setNLearnCls("n-learnbar none");
  markAssignTargets(null);
  setRailGlow(false);
}

/** The dialog keyboard contract: Escape closes the open dialog, Tab stays
 *  inside it, and focus lands on the panel when one opens — returning to
 *  the opener on close. (The learn guard's capture listener still owns
 *  Escape while a capture is armed.) */
let dialogReturnFocus: HTMLElement | null = null;

function anyDialogOpen(): boolean {
  return ui.dlg || nConfOpen() || nApplyOpen();
}

function closeOpenDialog(): void {
  if (nApplyOpen()) setNApplyOpen(false);
  else if (nConfOpen()) {
    pendingConflict = null;
    setNConfOpen(false);
  } else if (ui.dlg) {
    ui.dlg = false;
    applyNocturneUi();
  }
  restoreDialogFocus();
}

function focusDialog(): void {
  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // The createShow branch attaches on the next microtask; focus one frame on.
  window.requestAnimationFrame(() => {
    learnRoot?.querySelector<HTMLElement>(".nd")?.focus();
  });
}

function restoreDialogFocus(): void {
  const back = dialogReturnFocus;
  dialogReturnFocus = null;
  if (back && back.isConnected) back.focus();
}

function trapDialogTab(ev: KeyboardEvent): void {
  const dlg = learnRoot?.querySelector<HTMLElement>(".nd");
  if (!dlg) return;
  const focusables = Array.from(
    dlg.querySelectorAll<HTMLElement>("button, input, select, a[href], [tabindex]"),
  ).filter((el) => !el.hasAttribute("disabled"));
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || active === dlg)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  } else if (!dlg.contains(active)) {
    ev.preventDefault();
    first.focus();
  }
}

/** Delegated events on the island root (the map.ts idiom): every interactive
 *  control carries `data-nx`; everything else is inert. */
export function nocturneWire(root: HTMLElement): void {
  learnRoot = root;
  // Chrome preferences load BEFORE the island builds (the entry calls this
  // first), so the hydrated first paint already has the panes the user left.
  loadUiPrefs();
  loadSlotColors();
  loadHiddenStrips();
  applyNocturneUi();
  // The wire's own "JavaScript is live" marker: scripting-only chrome (the
  // auto-map button) reveals off it, and the parity gate normalizes it.
  root.classList.add("js");
  applySlotColors();
  syncPadGrid();
  syncBoardFilter();
  window.addEventListener("resize", scheduleKbFit);
  window.addEventListener("resize", schedulePadFit);
  // Drag-to-reorder on the rack: a pointer enhancement over the SAME
  // whole-order verb the ▴▾ twins post — the drop rewrites the dragged
  // row's own move form and submits it through the ordinary fetch path.
  let dragSlot: string | null = null;
  let dropTarget: { slot: string; before: boolean } | null = null;
  const dropClean = (): void => {
    dropTarget = null;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-slot-row]"))) {
      el.classList.remove("dragging", "dropbefore", "dropafter");
    }
  };
  root.addEventListener("dragstart", (ev) => {
    // Only the grip starts a reorder — a text selection dragged from the
    // row body must not.
    if (!(ev.target as HTMLElement | null)?.closest?.(".n-grip")) return;
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-slot-row]");
    if (!row) return;
    dragSlot = row.getAttribute("data-slot-row");
    ev.dataTransfer?.setData("text/plain", dragSlot ?? "");
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      // The browser's default ghost is a washed-out smear of the whole
      // row. Snapshot a CRISP card instead: a styled clone, rendered
      // off-screen just long enough for setDragImage to photograph it.
      const ghost = row.cloneNode(true) as HTMLElement;
      ghost.classList.add("n-dragghost");
      ghost.classList.remove("dragging", "on");
      ghost.querySelector(".n-cpick-pop")?.remove();
      ghost.style.width = `${row.offsetWidth}px`;
      root.appendChild(ghost);
      const box = row.getBoundingClientRect();
      ev.dataTransfer.setDragImage(ghost, ev.clientX - box.left, ev.clientY - box.top);
      window.setTimeout(() => ghost.remove(), 0);
    }
    // The row itself becomes the HOLE the card left behind — a tick
    // later, so the drag image never photographs the hole state.
    window.setTimeout(() => row.classList.add("dragging"), 0);
  });
  root.addEventListener("dragover", (ev) => {
    if (dragSlot === null) return;
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-slot-row]");
    if (!row) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const slot = row.getAttribute("data-slot-row") ?? "";
    const box = row.getBoundingClientRect();
    const before = ev.clientY < box.top + box.height / 2;
    if (slot === dragSlot) {
      if (dropTarget !== null) dropClean();
      return;
    }
    // Touch the DOM only when the answer changes — dragover fires in
    // torrents and class churn would make the bar flicker.
    if (dropTarget && dropTarget.slot === slot && dropTarget.before === before) return;
    dropTarget = { slot, before };
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-slot-row]"))) {
      const here = el === row;
      el.classList.toggle("dropbefore", here && before);
      el.classList.toggle("dropafter", here && !before);
    }
  });
  root.addEventListener("drop", (ev) => {
    const from = dragSlot;
    const target = dropTarget;
    dragSlot = null;
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-slot-row]");
    if (from === null || !row) {
      dropClean();
      return;
    }
    ev.preventDefault();
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-slot-row]"));
    const numbers = rows.map((el) => el.getAttribute("data-slot-row") ?? "");
    const to = row.getAttribute("data-slot-row") ?? "";
    dropClean();
    if (from === to) return;
    // The bar told the truth, so the drop honours it: above the target's
    // midline inserts before it, below inserts after.
    const before =
      target && target.slot === to ? target.before : numbers.indexOf(from) > numbers.indexOf(to);
    const without = numbers.filter((n) => n !== from);
    let at = without.indexOf(to);
    if (!before) at += 1;
    without.splice(at, 0, from);
    if (without.join(" ") === numbers.join(" ")) return;
    const source = rows.find((el) => el.getAttribute("data-slot-row") === from);
    const form = source?.querySelector<HTMLFormElement>(
      'form[action="/nocturne/controller/move"]',
    );
    const input = form?.querySelector<HTMLInputElement>('input[name="order"]');
    if (form && input) {
      input.value = without.join(" ");
      form.requestSubmit();
    }
  });
  root.addEventListener("dragend", () => {
    dragSlot = null;
    dropClean();
  });
  root.addEventListener(
    "toggle",
    (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLDetailsElement)) return;
      // A colour picker opening gets the current availability truth.
      if (el.classList.contains("n-cpick") && el.open) {
        refreshSwatches();
        return;
      }
      if (!el.closest(".n-right")) return;
      const fn = el.getAttribute("data-fn");
      if (!fn) return;
      if (el.open) openRows.add(fn);
      else openRows.delete(fn);
      syncExpandLabel();
    },
    true,
  );
  window.addEventListener("keydown", (ev) => {
    if (assignKey && ev.key === "Escape") {
      ev.preventDefault();
      cancelAssign();
      return;
    }
    if (!anyDialogOpen()) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeOpenDialog();
    } else if (ev.key === "Tab") {
      trapDialogTab(ev);
    }
  });
  // Identify-by-key is a REAL verb: the form posts and the server listens
  // for one keypress (up to 11 s). The submit hook only shows the listening
  // banner while the round-trip is in flight; applyFlash settles it.
  root.addEventListener("submit", (ev) => {
    const form = ev.target as HTMLElement | null;
    if (form instanceof HTMLFormElement && form.classList.contains("n-applyform")) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      void applyDraftViaJson();
      return;
    }
    if (form && form.classList.contains("n-idform")) {
      ui.identify = true;
      applyNocturneUi();
    }
  });
  root.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.classList.contains("n-filter-in")) {
      applyNocturneFilter(root, t.value);
      // The filter is page state: it rides ?q= (debounced), so a refresh
      // keeps it and the poller's URL echo cannot lose it.
      if (filterUrlTimer !== undefined) window.clearTimeout(filterUrlTimer);
      filterUrlTimer = window.setTimeout(() => {
        mergeQuery({ q: t.value.trim() });
      }, 300);
    }
  });
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    // An open colour picker closes on any click outside itself.
    for (const pick of Array.from(root.querySelectorAll<HTMLElement>(".n-cpick[open]"))) {
      if (target && !pick.contains(target)) pick.removeAttribute("open");
    }
    // Slot selection: enhance the server-resolved ?slot=N link into an
    // in-place URL swap + immediate poll — no full reload, same truth.
    const sel = target?.closest<HTMLAnchorElement>("a.n-slot-sel");
    if (sel) {
      ev.preventDefault();
      // MERGE the slot into the current query rather than replacing the
      // whole URL — the filter's ?q= must survive a selection change.
      const chosen = new URL(sel.href, window.location.origin).searchParams.get("slot");
      // The walk was built for one slot's controls: changing slots ends it.
      autoMap = null;
      mergeQuery({ slot: chosen });
      nocturnePollFn();
      return;
    }
    // Stage art → binding row: every control on the silhouette already
    // carries its mapper function(s) in data-fn (the live-echo hooks), so a
    // click jumps the right pane to that row. A POINTER ENHANCEMENT only —
    // the rows themselves stay the accessible, no-JS path.
    const zone = target?.closest<Element>(".n-stage [data-fn]");
    if (zone) {
      closeMenu();
      const fnName = (zone.getAttribute("data-fn") ?? "").split(/\s+/)[0] ?? "";
      // The clone grid stamps each pad with its slot; the master speaks
      // for the selected one. The pad's own served tables carry the
      // CANONICAL fn spelling and the readable label for ANY slot.
      const padSlot =
        zone.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot") ?? nSlotVal();
      const pv = (lastBindView?.pads ?? []).find((x) => String(x.slot) === padSlot);
      const padCanonical = pv
        ? Object.keys(pv.fn_names).find((f) => f.toLowerCase() === fnName.toLowerCase())
        : undefined;
      const padLabel = padCanonical ? pv?.fn_names[padCanonical] : undefined;
      if (assignKey && fnName) {
        // The pad IS the picker: give the chosen control this key.
        const held = assignKey;
        const mode = assignMode;
        const chain = ev.shiftKey || chainWanted();
        cancelAssign();
        // The pane's row (or the FREE control's group chip) carries the
        // CANONICAL fn spelling and the label — the art's token is
        // lowercase while face buttons are uppercase in the mapper, and
        // the current-keys reads (add/remove) must speak the mapper's own.
        const owner = Array.from(
          root.querySelectorAll<HTMLElement>("details.n-bind[data-fn], .n-ctlchip[data-fn]"),
        ).find((el) => (el.getAttribute("data-fn") ?? "").toLowerCase() === fnName.toLowerCase());
        const canonical = padCanonical ?? owner?.getAttribute("data-fn") ?? fnName;
        lastWrite = { origin: "assign", chain, assignMode: mode };
        const label =
          padLabel ||
          owner?.querySelector(".n-bind-label")?.textContent?.trim() ||
          (owner?.classList.contains("n-ctlchip") ? owner.textContent?.trim() : "") ||
          fnName;
        void writeLearnedKey({ fn: canonical, label, slot: padSlot, mode }, held, false).then(
          (ok) => {
            // "Bind several": the key stays in your hand for the next
            // control; the box survives the re-arm.
            if (ok && chain) {
              armAssign(held, mode);
              setChainBox(true);
            }
          },
        );
        return;
      }
      // The mirror of the key-first flow: clicking a control ARMS its
      // learn — press a key, or click one on the board. The controls view
      // opens on the armed row (no fold, no fade: the arm wash waits).
      const rowEl =
        padSlot === nSlotVal()
          ? Array.from(
              root.querySelectorAll<HTMLElement>("details.n-bind[data-fn], .n-ctlchip[data-fn]"),
            ).find((el) => (el.getAttribute("data-fn") ?? "").toLowerCase() === fnName)
          : undefined;
      const rowFn = padCanonical ?? rowEl?.getAttribute("data-fn") ?? fnName;
      const rowLabel =
        padLabel ||
        rowEl?.querySelector(".n-bind-label")?.textContent?.trim() ||
        (rowEl?.classList.contains("n-ctlchip") ? rowEl.textContent?.trim() : "") ||
        fnName;
      if (ui.rightView !== "controls") {
        ui.rightView = "controls";
        saveUiPrefs();
        applyNocturneUi();
      }
      // A rolled-away pane STAYS away: the toast carries the wait, the rail
      // glows, and mapping needs no panel at all. Open panes still follow.
      if (!ui.rightRail) {
        rowEl?.scrollIntoView({
          block: "nearest",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
      }
      // A hand-armed control replaces any running auto-map walk.
      autoMap = null;
      void startLearn({ fn: rowFn, label: rowLabel, slot: padSlot, mode: "replace" });
      return;
    }
    // A board cap flips the pane to the BY-KEY view and finds its row —
    // the same gesture as clicking the pad, read from the other side.
    const cap = target?.closest<HTMLElement>(".n-kb [data-key]");
    if (cap) {
      closeMenu();
      const key = cap.getAttribute("data-key") ?? "";
      if (learnRow && key) {
        // A control is waiting: clicking a cap IS pressing the key.
        const row = learnRow;
        const chain = ev.shiftKey || chainWanted();
        lastWrite = { origin: "learn", chain, assignMode: "replace" };
        void cancelLearn();
        void writeLearnedKey(row, key, false).then((ok) => {
          // "Bind several": the control keeps listening; further keys ADD.
          if (ok && chain && !autoMap) {
            void startLearn({ ...row, mode: "add" });
            setChainBox(true);
          }
        });
        return;
      }
      // With the pane rolled away, a cap click goes straight to mapping:
      // the pad picks the control (plain click replaces its binding) —
      // the pane stays closed and its rail glows instead.
      if (ui.rightRail) {
        if (key && !autoMap) armAssign(key);
        return;
      }
      ui.rightView = "keys";
      saveUiPrefs();
      applyNocturneUi();
      locateKeyRow(root, key);
      // EVERY cap click puts the key in your hand: the next pad click
      // gives that control this key (its old key is replaced — the row's
      // + is the add gesture).
      if (key && !autoMap) armAssign(key);
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
    if (hit === "slot-new") {
      ui.dlg = true;
      focusDialog();
    } else if (hit === "dlg-close") {
      ui.dlg = false;
      restoreDialogFocus();
    }
    else if (hit === "pane-left") {
      ui.leftRail = !ui.leftRail;
      saveUiPrefs();
    } else if (hit === "pane-right") {
      ui.rightRail = !ui.rightRail;
      saveUiPrefs();
    } else if (hit === "pane-bottom") {
      ui.kbClosed = !ui.kbClosed;
      saveUiPrefs();
    } else if (hit === "filter-reset") {
      const inp = root.querySelector<HTMLInputElement>(".n-filter-in");
      if (inp) inp.value = "";
      applyNocturneFilter(root, "");
      mergeQuery({ q: null });
    } else if (hit === "chip-learn" || hit === "chip-add" || hit === "chip-remove") {
      // The row's own facts travel on its element, never re-derived here.
      // The chip click must not also toggle the fold it sits in.
      ev.preventDefault();
      const holder = target?.closest<HTMLElement>("[data-fn]");
      const fnName = holder?.dataset.fn ?? "";
      const slot = holder?.dataset.slot ?? "";
      const label = holder?.querySelector(".n-bind-label")?.textContent?.trim() || fnName;
      if (fnName && slot) {
        // A hand-armed chip replaces any running auto-map walk.
        autoMap = null;
        void startLearn({
          fn: fnName,
          label,
          slot,
          mode: hit.endsWith("add") ? "add" : hit.endsWith("remove") ? "remove" : "replace",
        });
      }
    } else if (hit === "row-clear") {
      // A submit button INSIDE a summary: preventDefault stops the fold
      // toggling under it (and the native submit); requestSubmit re-fires
      // the submit event so the ordinary fetch path handles the form.
      ev.preventDefault();
      target?.closest("form")?.requestSubmit();
    } else if (hit === "pad-zoom-in" || hit === "pad-zoom-out" || hit === "pad-zoom-fit") {
      const grid = root.querySelector<HTMLElement>(".n-padgrid");
      const currentW = parseFloat(grid?.style.getPropertyValue("--padw") || "") || 340;
      if (hit === "pad-zoom-fit") {
        ui.padZoom = -1;
      } else if (hit === "pad-zoom-in") {
        // From Fit, step to the first ladder rung ABOVE the fitted size.
        ui.padZoom =
          ui.padZoom >= 0
            ? Math.min(PAD_STEPS.length - 1, ui.padZoom + 1)
            : PAD_STEPS.findIndex((w) => w > currentW + 1) === -1
              ? PAD_STEPS.length - 1
              : PAD_STEPS.findIndex((w) => w > currentW + 1);
      } else {
        ui.padZoom =
          ui.padZoom >= 0
            ? Math.max(0, ui.padZoom - 1)
            : (() => {
                for (let i = PAD_STEPS.length - 1; i >= 0; i -= 1) {
                  if (PAD_STEPS[i] < currentW - 1) return i;
                }
                return 0;
              })();
      }
      saveUiPrefs();
      syncPadGrid();
    } else if (hit === "kb-colors") {
      ui.kbSolo = !ui.kbSolo;
      saveUiPrefs();
      applyNocturneUi();
      syncBoardFilter();
    } else if (hit === "legend-mute") {
      // One chip, one player's colour on the keys. Keyed by PRESET like
      // the colours themselves, so muting follows a controller through a
      // reorder.
      const chip = target?.closest<HTMLElement>("[data-slot]");
      const preset = presetOfSlot(Number(chip?.getAttribute("data-slot") ?? ""));
      if (chip && preset !== undefined) {
        // "Only P{n}" is a shortcut for crossing the others out by hand,
        // so a click after it CONTINUES from what you see: the shortcut
        // becomes the real mute set, then this chip toggles inside it.
        if (ui.kbSolo) {
          ui.kbSolo = false;
          // Write down EXACTLY what the lens was showing — the selected
          // controller visible, everyone else crossed — including undoing
          // a cross the lens was overriding. Anything less and turning the
          // lens off would contradict the screen it was just showing.
          for (const pv of lastBindView?.pads ?? []) {
            if (isSelectedPreset(pv.preset)) hiddenStrips.delete(pv.preset);
            else hiddenStrips.add(pv.preset);
          }
          saveUiPrefs();
        }
        if (hiddenStrips.has(preset)) hiddenStrips.delete(preset);
        else hiddenStrips.add(preset);
        saveHiddenStrips();
        applyNocturneUi();
        syncBoardFilter();
      }
    } else if (hit === "pads-toggle") {
      ui.padsAll = !ui.padsAll;
      saveUiPrefs();
      syncPadGrid();
    } else if (hit === "auto-map") {
      startAutoMap();
    } else if (hit === "learn-skip") {
      void cancelLearn();
      autoMapAdvance(false);
    } else if (hit === "learn-cancel") {
      // The toast's Cancel ends the whole walk, not just this step.
      autoMap = null;
      void cancelLearn();
      cancelAssign();
    } else if (hit === "conf-force") {
      const pend = pendingConflict;
      pendingConflict = null;
      setNConfOpen(false);
      restoreDialogFocus();
      if (pend) {
        void writeLearnedKey(pend.row, pend.key, true).then((ok) => {
          // "Bind several" survives the consent dialog: consenting binds
          // AND puts the same hand back up for the next target.
          if (ok && pend.chain && !autoMap) {
            if (pend.origin === "assign") {
              armAssign(pend.key, pend.assignMode);
            } else {
              void startLearn({ ...pend.row, mode: "add" });
            }
            setChainBox(true);
          }
        });
      }
    } else if (hit === "conf-cancel") {
      pendingConflict = null;
      setNConfOpen(false);
      restoreDialogFocus();
      // Declining a conflict mid-walk skips that control; the run moves on.
      autoMapAdvance(false);
    } else if (hit === "jump-controls") {
      // The targets text names controls: flip and light them all.
      ev.preventDefault();
      const fns = (target?.closest("[data-fns]")?.getAttribute("data-fns") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (fns.length > 0) {
        ui.rightView = "controls";
        saveUiPrefs();
        applyNocturneUi();
        const all = Array.from(root.querySelectorAll<HTMLElement>("details.n-bind[data-fn]"));
        const rows = fns
          .map((fn) => all.find((el) => (el.getAttribute("data-fn") ?? "").toLowerCase() === fn))
          .filter((el): el is HTMLElement => Boolean(el));
        pulseRows(rows);
      }
    } else if (hit === "ctl-assign") {
      // A FREE control chip: arm its learn — press a key, or click one.
      const chip = target?.closest<HTMLElement>("[data-fn]");
      const fnName = chip?.getAttribute("data-fn") ?? "";
      const label = chip?.textContent?.trim() || fnName;
      if (fnName) {
        void startLearn({ fn: fnName, label, slot: nSlotVal(), mode: "replace" });
      }
    } else if (hit === "view-ctl" || hit === "view-keys") {
      ui.rightView = hit === "view-keys" ? "keys" : "controls";
      saveUiPrefs();
      applyNocturneUi();
    } else if (hit === "slot-color") {
      const btn = target?.closest<HTMLElement>("[data-color]");
      const pick = btn?.closest<HTMLElement>("[data-slot]");
      const slot = Number(pick?.getAttribute("data-slot") ?? "");
      const color = Number(btn?.getAttribute("data-color") ?? "");
      const preset = presetOfSlot(slot);
      if (slot >= 1 && slot <= 16 && color >= 1 && color <= 16 && preset !== undefined) {
        // A colour another controller wears is UNAVAILABLE, never stolen:
        // the swatch is disabled, and this guard backs the styling up. It
        // frees the moment its owner moves off it.
        const assigned = colourAssignments();
        const wornBy = (lastBindView?.pads ?? []).find(
          (pv) => pv.slot !== slot && assigned.get(pv.slot) === color,
        );
        if (wornBy) return;
        padColors[preset] = color;
        saveSlotColors();
        applySlotColors();
        refreshSwatches();
        pick?.closest("details")?.removeAttribute("open");
      }
    } else if (hit === "key-remove") {
      const key = target?.closest<HTMLElement>("[data-key]")?.getAttribute("data-key") ?? "";
      if (key) armAssign(key, "remove");
    } else if (hit === "key-assign") {
      const key = target?.closest<HTMLElement>("[data-key]")?.getAttribute("data-key") ?? "";
      // The row's + means ADD (the key keeps its other controls); a free
      // chip is a plain bind.
      const mode: "replace" | "add" = target?.closest(".n-krow") ? "add" : "replace";
      if (key) armAssign(key, mode);
    } else if (hit === "bind-expand") {
      const rows = Array.from(
        root.querySelectorAll<HTMLDetailsElement>(".n-right details[data-fn]"),
      );
      const openAll = openRows.size === 0;
      for (const el of rows) el.open = openAll;
      syncExpandLabel();
    } else if (hit === "apply-cancel") {
      setNApplyOpen(false);
      restoreDialogFocus();
    } else if (hit === "apply-replace") {
      // The remedy the daemon named: stage-play replaces the session. The
      // hidden Play twin carries the verb; the generic fetch path flashes
      // and polls like any form.
      setNApplyOpen(false);
      root.querySelector<HTMLFormElement>('form[action="/nocturne/play"]')?.requestSubmit();
    } else if (hit === "dlg-noop") {
      // A dialog panel: exists so panel clicks stop here instead of
      // reaching the backdrop's dlg-close. Never preventDefault — the
      // panel contains real form controls.
      return;
    }
    if (hit === "slot-new" || hit === "dlg-close" || hit === "pane-left" || hit === "pane-right" || hit === "pane-bottom" || hit === "filter-reset") {
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
      // Apply-in-place (stage_apply): offered only while a session runs AND
      // the draft is dirty. A structural difference answers with the
      // needs-restart sentence naming Play.
      h(
        "form",
        { class: "n-inline n-applyform", method: "post", action: "/nocturne/apply" },
        h("button", { type: "submit", class: () => nApplyCls() }, "⟳ Apply"),
      ),
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
            h("input", { type: "hidden", name: "fresh", value: "1" }),
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
          (r) =>
            r.number +
            "|" +
            r.badge +
            "|" +
            r.badge_cls +
            "|" +
            r.name +
            "|" +
            r.meta +
            "|" +
            r.cls +
            "|" +
            r.href +
            "|" +
            r.up_order +
            "|" +
            r.down_order,
          (r) =>
            h(
              "div",
              { "data-slot-row": r.number, class: r.cls },
              // The drag GRIP: reordering starts here and only here — the
              // row body keeps plain click-to-select, and the keyboard's
              // path stays the ▴▾ twins in the verb pill. Pointer-only
              // chrome, so assistive tech never meets it.
              h(
                "div",
                {
                  draggable: "true",
                  "aria-hidden": "true",
                  title: "Drag to reorder",
                  class: "n-grip",
                },
                h(
                  "svg",
                  { class: "n-ico", viewBox: "0 0 256 256" },
                  h("path", { d: "M108,60A16,16,0,1,1,92,44,16,16,0,0,1,108,60Zm56,16a16,16,0,1,0-16-16A16,16,0,0,0,164,76ZM92,112a16,16,0,1,0,16,16A16,16,0,0,0,92,112Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,112ZM92,180a16,16,0,1,0,16,16A16,16,0,0,0,92,180Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,180Z" }),
                ),
              ),
              // "Select player one" = click ANYTHING in the row: badge and
              // text are ONE selection link. The badge wears the colour;
              // picking one is the palette verb in the pill.
              h(
                "a",
                { class: "n-slot-sel", href: r.href },
                h("span", { class: r.badge_cls }, r.badge),
                h(
                  "span",
                  { class: "n-slot-txt" },
                  h("span", { class: "n-slot-name" }, r.name),
                  h("span", { class: "n-slot-meta" }, r.meta),
                ),
              ),
              h(
                "div",
                { class: "n-sacts" },
                h(
                  "div",
                  { class: "n-sact-row" },
                  // The colour picker, as a verb: presentation state, kept
                  // in this browser, keyed to the controller's identity.
                  h(
                    "details",
                    { class: "n-cpick", "data-slot": r.number },
                    h(
                      "summary",
                      {
                        title: "Pick this controller's colour",
                        "aria-label": "Pick this controller's colour",
                        class: "n-sact n-csum",
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M203.57,51A107.9,107.9,0,0,0,20,128c0,44.72,27.6,82.25,72,97.94A36,36,0,0,0,140,192a12,12,0,0,1,12-12h46.21a35.79,35.79,0,0,0,35.1-28A108.6,108.6,0,0,0,236,127.09,107.23,107.23,0,0,0,203.57,51Zm6.34,95.67a11.91,11.91,0,0,1-11.7,9.3H152a36,36,0,0,0-36,36,12,12,0,0,1-16,11.3c-16.65-5.88-30.65-15.76-40.48-28.56A76,76,0,0,1,44,128a84,84,0,0,1,83.13-84H128a84.35,84.35,0,0,1,84,83.29A84.72,84.72,0,0,1,209.91,146.71ZM144,76a16,16,0,1,1-16-16A16,16,0,0,1,144,76Zm-44,24A16,16,0,1,1,84,84,16,16,0,0,1,100,100Zm0,56a16,16,0,1,1-16-16A16,16,0,0,1,100,156Zm88-56a16,16,0,1,1-16-16A16,16,0,0,1,188,100Z" }),
                      ),
                    ),
                    h(
                      "div",
                      { class: "n-cpick-pop", "data-nx": "menu-noop" },
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "1", title: "Colour 1", "aria-label": "Colour 1 for this controller", class: "n-swatch pal1" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "2", title: "Colour 2", "aria-label": "Colour 2 for this controller", class: "n-swatch pal2" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "3", title: "Colour 3", "aria-label": "Colour 3 for this controller", class: "n-swatch pal3" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "4", title: "Colour 4", "aria-label": "Colour 4 for this controller", class: "n-swatch pal4" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "5", title: "Colour 5", "aria-label": "Colour 5 for this controller", class: "n-swatch pal5" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "6", title: "Colour 6", "aria-label": "Colour 6 for this controller", class: "n-swatch pal6" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "7", title: "Colour 7", "aria-label": "Colour 7 for this controller", class: "n-swatch pal7" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "8", title: "Colour 8", "aria-label": "Colour 8 for this controller", class: "n-swatch pal8" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "9", title: "Colour 9", "aria-label": "Colour 9 for this controller", class: "n-swatch pal9" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "10", title: "Colour 10", "aria-label": "Colour 10 for this controller", class: "n-swatch pal10" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "11", title: "Colour 11", "aria-label": "Colour 11 for this controller", class: "n-swatch pal11" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "12", title: "Colour 12", "aria-label": "Colour 12 for this controller", class: "n-swatch pal12" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "13", title: "Colour 13", "aria-label": "Colour 13 for this controller", class: "n-swatch pal13" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "14", title: "Colour 14", "aria-label": "Colour 14 for this controller", class: "n-swatch pal14" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "15", title: "Colour 15", "aria-label": "Colour 15 for this controller", class: "n-swatch pal15" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "16", title: "Colour 16", "aria-label": "Colour 16 for this controller", class: "n-swatch pal16" }),
                    ),
                  ),
                  // One whole-order reorder per click; an end row's order
                  // is empty and the server answers the honest sentence.
                  h(
                    "form",
                    { class: "n-inline first", method: "post", action: "/nocturne/controller/move" },
                    h("input", { type: "hidden", name: "order", value: r.up_order }),
                    h(
                      "button",
                      { class: "n-sact", type: "submit", title: "Move up", "aria-label": "Move up" },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M216.49,168.49a12,12,0,0,1-17,0L128,97,56.49,168.49a12,12,0,0,1-17-17l80-80a12,12,0,0,1,17,0l80,80A12,12,0,0,1,216.49,168.49Z" }),
                      ),
                    ),
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/controller/move" },
                    h("input", { type: "hidden", name: "order", value: r.down_order }),
                    h(
                      "button",
                      { class: "n-sact", type: "submit", title: "Move down", "aria-label": "Move down" },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z" }),
                      ),
                    ),
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/controller/duplicate" },
                    h("input", { type: "hidden", name: "number", value: r.number }),
                    h(
                      "button",
                      { class: "n-sact", type: "submit", title: "Duplicate", "aria-label": "Duplicate" },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z" }),
                      ),
                    ),
                  ),
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/controller/remove" },
                    h("input", { type: "hidden", name: "number", value: r.number }),
                    h(
                      "button",
                      { class: "n-sact danger", type: "submit", title: "Remove", "aria-label": "Remove" },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
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
        // With scripting off the create dialog cannot open; the absence
        // explains itself instead of leaving dead chrome.
        h(
          "noscript",
          null,
          h(
            "p",
            { class: "n-foot" },
            "Adding a controller here needs JavaScript — the Start page's add form works without it.",
          ),
        ),
        // The short undo window after a removal: the SERVER holds the
        // controller's resurrection material and serves this chip while it
        // does; the verb replays it. No JavaScript state — a reload keeps
        // the chip as long as the window lasts.
        h(
          "form",
          {
            role: "status",
            method: "post",
            action: "/nocturne/controller/undo",
            class: () => nUndoCls(),
          },
          h("span", { class: "n-undo-lab" }, () => nUndoLabel()),
          h("button", { class: "n-undo-btn", type: "submit" }, "Undo"),
        ),
        // The selected slot's opposite-directions rule — the create dialog
        // sets it at birth; this changes it afterwards. Hidden when nothing
        // is staged or the daemon serves no policy roster (an older build).
        h(
          "form",
          {
            method: "post",
            action: "/nocturne/controller/socd",
            class: () => nSocdCls(),
          },
          h("span", { class: "n-socd-lab" }, () => nSocdLab()),
          h("input", { type: "hidden", name: "number", value: () => nSocdNum() }),
          h(
            "select",
            { class: "n-socd-sel", name: "socd" },
            createList(
              () => nSocdEditOpts(),
              (o) => o.value + "|" + o.label,
              (o) => h("option", { value: o.value }, o.label),
            ),
          ),
          h("button", { class: "n-socd-set", type: "submit" }, "Set"),
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
        { class: () => nCenterCls() },
        h(
          "div",
          { class: "n-meta" },
          h("span", { class: () => nPadBadgeCls() }, () => nPadBadge()),
          h("span", { class: "n-meta-name" }, () => nPadName()),
          h("span", { class: "n-meta-sub" }, () => nPadSub()),
          h("div", { class: "n-spring" }),
          // The auto-map walk exists only when scripting can run it: CSS
          // hides this until the root wears the wire's own "js" marker (the
          // parity contract already normalizes that class), so a no-JS page
          // never shows dead chrome.
          h(
            "button",
            {
              type: "button",
              "data-nx": "auto-map",
              class: "n-autobtn",
              title:
                "Walk every control in turn — press a key for each. Esc skips one; Cancel stops the run.",
            },
            "Map all…",
          ),
          // The multi-pad view: every staged controller on stage at once,
          // each mappable in place. Scripting-only chrome, like Map all.
          h(
            "button",
            {
              type: "button",
              "data-nx": "pads-toggle",
              // The default state ships in the markup so the wire's
              // re-stamp is byte-identical (the parity gate's rule).
              "aria-pressed": "false",
              title:
                "Show every staged controller at once — click any pad's control to map it; the pane keeps following the selected one.",
              class: "n-autobtn n-padsbtn",
            },
            "All pads",
          ),
          // The live echo's readouts: written IMPERATIVELY at frame rate,
          // both hidden from assistive tech (the sr twin below announces
          // transitions only, so the uptime clock cannot spam a reader).
          h("span", { "aria-hidden": "true", class: "n-ticker" }),
          h("span", { "aria-hidden": "true", class: "n-livestats" }),
          h("span", { role: "status", class: "n-live-sr" }),
        ),
        // The capture toast: capture-time browser state, floating over the
        // stage so mapping works with either pane rolled away. role=status —
        // the a11y contract from its pane-banner days carries over unchanged.
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
          // The armed session's "keep going" switch — Victor's multi-bind,
          // scoped to the moment: it exists only while something is armed
          // and dies with the arm.
          h(
            "label",
            { class: () => nChainCls() },
            h("input", { type: "checkbox", class: "n-chain-box" }),
            "Bind several",
          ),
          h("button", { type: "button", "data-nx": "learn-skip", class: () => nLearnSkipCls() }, "Skip"),
          h("button", { type: "button", class: "n-bbtn sm", "data-nx": "learn-cancel" }, "Cancel"),
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
          // The across-the-room read: one quiet word from the polled
          // session, visual only (the sr status line announces transitions).
          h("span", { "aria-hidden": "true", class: "n-stageword" }, () => nStageWord()),
          // The multi-pad grid: filled imperatively from browser-kept
          // preference; SSR and the no-JS page stay single-pad.
          h("div", { class: "n-padgrid" }),
          // Its zoom, shown only in multi mode (CSS-gated on .multi).
          h(
            "div",
            { class: "n-zoomctl" },
            h(
              "button",
              {
                type: "button",
                "data-nx": "pad-zoom-out",
                title: "Smaller pads — more on screen",
                "aria-label": "Zoom out",
                class: "n-sact",
              },
              h(
                "svg",
                { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
              ),
            ),
            h(
              "button",
              {
                type: "button",
                "data-nx": "pad-zoom-fit",
                "aria-pressed": "true",
                title: "Fit every pad on screen",
                class: "n-sact n-zfit",
              },
              "Fit",
            ),
            h(
              "button",
              {
                type: "button",
                "data-nx": "pad-zoom-in",
                title: "Bigger pads — a closer look",
                "aria-label": "Zoom in",
                class: "n-sact",
              },
              h(
                "svg",
                { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
              ),
            ),
          ),
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
              { class: "wspad x360a", viewBox: "0 0 751 660", "aria-hidden": "true", focusable: "false" },
              h(
                "defs",
                null,
                h(
                  "linearGradient",
                  { id: "x360a-pill", x1: "0", y1: "0", x2: "0", y2: "1" },
                  h("stop", { offset: "0", "stop-color": "#3a3b44" }),
                  h("stop", { offset: "0.55", "stop-color": "#2c2d34" }),
                  h("stop", { offset: "1", "stop-color": "#232429" }),
                ),
                h("filter", { id: "x360a-soft" }, h("feGaussianBlur", { stdDeviation: "16" })),
              ),
              // ── SCENARIO A: the CC0 Open Clip Art Xbox 360 gamepad
              // (Grumbel, public domain), recoloured to the carbon palette.
              // The trigger/bumper pills stay ours, scaled into this file's
              // coordinate space; a transparent overlay carries the data-fn
              // hooks so the live echo lights the art untouched.
              h(
                "g",
                null,
                h("rect", { "data-fn": "lt", x: "134", y: "6", width: "147", height: "43", rx: "21", fill: "url(#x360a-pill)", stroke: "#0c0d12", "stroke-width": "2.5" }),
                h("rect", { "data-fn": "rt", x: "471", y: "6", width: "147", height: "43", rx: "21", fill: "url(#x360a-pill)", stroke: "#0c0d12", "stroke-width": "2.5" }),
                h("text", { class: "wspad-sys x360a-sys", x: "207", y: "37", "text-anchor": "middle" }, "LT"),
                h("text", { class: "wspad-sys x360a-sys", x: "544", y: "37", "text-anchor": "middle" }, "RT"),
                h("rect", { "data-fn": "lb", x: "100", y: "69", width: "214", height: "37", rx: "18", fill: "url(#x360a-pill)", stroke: "#0c0d12", "stroke-width": "2.5" }),
                h("rect", { "data-fn": "rb", x: "438", y: "69", width: "214", height: "37", rx: "18", fill: "url(#x360a-pill)", stroke: "#0c0d12", "stroke-width": "2.5" }),
                h("text", { class: "wspad-sys x360a-sys", x: "207", y: "97", "text-anchor": "middle" }, "LB"),
                h("text", { class: "wspad-sys x360a-sys", x: "544", y: "97", "text-anchor": "middle" }, "RB"),
              ),
              h(
                "g",
                { transform: "translate(0,120)" },
                h(
                  "g",
                  { "transform": "translate(0.15288,-260.35206)" },
                  h(
                    "g",
                    { "transform": "matrix(0.5752286,0,0,0.5752286,161.90411,275.5957)", "stroke": "#0c0d12", "stroke-width": "2", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" },
                    h("rect", { "fill": "#26272d", "fill-opacity": "1", "stroke": "#0c0d12", "stroke-width": "2", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "width": "45.344299", "height": "27.532085", "x": "390.84552", "y": "630.43866", "ry": "4.973381", "rx": "4.973381" }),
                    h("rect", { "rx": "4.973381", "ry": "4.973381", "y": "630.43866", "x": "305.26193", "height": "27.532085", "width": "45.344299", "fill": "#26272d", "fill-opacity": "1", "stroke": "#0c0d12", "stroke-width": "2", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                    h("rect", { "fill": "#26272d", "fill-opacity": "1", "stroke": "#0c0d12", "stroke-width": "2", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "width": "32.910625", "height": "27.325605", "x": "354.27057", "y": "630.23145", "ry": "4.973381", "rx": "4.973381" }),
                  ),
                  h("path", { "d": "M 655.50745,318.60794 C 655.28894,317.5154 651.35577,300.47167 650.91876,297.63105 C 650.48174,294.79043 649.82621,293.26086 646.33006,290.85726 C 613.51647,268.29793 575.1238,257.40679 537.07541,263.5436 C 530.30162,264.63614 521.56124,281.67987 521.56124,281.67987 L 655.50745,318.60794 z", "fill": "#34353d", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "3", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "fill": "#34353d", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "3", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "d": "M 97.673659,318.60794 C 97.892168,317.5154 101.82534,300.47167 102.26235,297.63105 C 102.69937,294.79043 103.3549,293.26086 106.85105,290.85726 C 139.66464,268.29793 178.05731,257.40679 216.1057,263.5436 C 222.87949,264.63614 231.61987,281.67987 231.61987,281.67987 L 97.673659,318.60794 z" }),
                  h("path", { "fill": "#2c2d34", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "3", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "d": "M 692.40625,795.6875 C 729.24632,796.78087 745.21397,776.84954 748.8125,678.25 C 752.58374,574.91798 685.51396,378.56055 665.84375,329.03125 C 646.1735,279.50196 547.13046,253.20593 502.1875,281.53125 C 465.20101,304.842 424.68118,307.90625 375.15625,307.90625 C 325.63133,307.90625 285.14275,304.842 248.15625,281.53125 C 235.51605,273.56475 218.57513,269.89652 200.34375,269.875 C 153.75246,269.82 98.606739,293.43208 84.46875,329.03125 C 64.798509,378.56054 -2.2712417,574.91797 1.5,678.25 C 5.0785642,776.30266 20.906856,796.56763 57.3125,795.70312 C 141.78831,786.65213 150.45828,738.83858 207.40625,694.09375 C 260.20364,652.61006 297.18742,648.83525 374.875,650.34375 C 452.56257,648.83527 489.51511,652.61009 542.3125,694.09375 C 599.26048,738.83855 607.93044,786.63651 692.40625,795.6875 z" }),
                  h("path", { "fill": "#15161b", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "3", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "d": "M 376.55538,626.9578 C 306.48411,626.95781 270.99132,628.49411 235.21163,648.0828 C 160.64529,688.90646 145.67483,753.41543 66.61787,795.67655 C 143.80716,784.49429 153.68236,737.39373 208.80537,694.0828 C 261.60277,652.59914 298.58655,648.8243 376.27413,650.3328 C 453.9617,648.82429 490.91424,652.59914 543.71163,694.0828 C 599.02621,737.54424 608.78338,784.83136 686.71163,795.80155 C 607.46105,753.54261 592.53505,688.94455 517.89913,648.0828 C 482.11944,628.49411 446.62665,626.9578 376.55538,626.9578 z" }),
                  h("path", { "opacity": "1", "fill": "#303138", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "0.92916417", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "160.65491", "cy": "389.37787", "rx": "68.636604", "ry": "68.636604", "d": "M 229.29151,389.37787 A 68.636604,68.636604 0 1 1 92.018303,389.37787 A 68.636604,68.636604 0 1 1 229.29151,389.37787 z", "transform": "matrix(1.3186813,0,0,1.3571428,273.88333,-12.726922)" }),
                  h("path", { "opacity": "1", "fill": "#303138", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "0.92916417", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "160.65491", "cy": "389.37787", "rx": "68.636604", "ry": "68.636604", "d": "M 229.29151,389.37787 A 68.636604,68.636604 0 1 1 92.018303,389.37787 A 68.636604,68.636604 0 1 1 229.29151,389.37787 z", "transform": "matrix(1.1153846,0,0,1.0384615,-16.651483,-22.141431)" }),
                  h("path", { "transform": "matrix(1.3186813,0,0,1.3571428,52.888559,-12.726922)", "d": "M 229.29151,389.37787 A 68.636604,68.636604 0 1 1 92.018303,389.37787 A 68.636604,68.636604 0 1 1 229.29151,389.37787 z", "ry": "68.636604", "rx": "68.636604", "cy": "389.37787", "cx": "160.65491", "opacity": "1", "fill": "#303138", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "0.92916417", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "opacity": "1", "fill": "#1b1c21", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "2.64638782", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "211.80083", "cy": "443.66501", "rx": "53.410645", "ry": "53.410645", "d": "M 265.21147,443.66501 A 53.410645,53.410645 0 1 1 158.39018,443.66501 A 53.410645,53.410645 0 1 1 265.21147,443.66501 z", "transform": "matrix(1.1336207,0,0,1.1336207,25.800327,-1.4980324)" }),
                  h("path", { "fill": "#1f2026", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#515151", "stroke-width": "3.00000024", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 249.60884,556.05516 C 249.60884,561.4302 282.19542,561.01814 282.19542,556.05516 C 282.19542,536.00091 298.47109,519.72501 318.52506,519.72501 C 323.77385,520.88166 325.80104,484.17294 318.52506,483.17466 C 298.47109,483.17466 282.19542,466.89876 282.19542,446.84451 C 282.19542,441.44945 249.60884,441.0386 249.60884,446.84451 C 249.60884,466.89876 233.33317,483.17466 213.2792,483.17466 C 207.39917,482.94968 206.22358,519.51869 213.2792,519.72501 C 233.33317,519.72501 249.60884,536.00091 249.60884,556.05516 z" }),
                  h(
                    "g",
                    null,
                    h("rect", { "ry": "16.450199", "rx": "16.450203", "y": "372.24924", "x": "437.39334", "height": "29.558952", "width": "37.428303", "opacity": "1", "fill": "#d1d1d1", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#6d6d6d", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                    h("path", { "transform": "matrix(0,1.1259413,1.1259413,0,20.719223,57.395722)", "d": "M 300.92577,381.6729 L 292.76215,395.81271 L 284.59852,381.6729 L 300.92577,381.6729 z", "cy": "386.38617", "cx": "292.76215", "opacity": "1", "fill": "#585a64", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  ),
                  h(
                    "g",
                    { "transform": "matrix(-1,0,0,1,757.22326,0)" },
                    h("rect", { "opacity": "1", "fill": "#d1d1d1", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#6d6d6d", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "width": "37.428303", "height": "29.558952", "x": "437.39334", "y": "372.24924", "rx": "16.450203", "ry": "16.450199" }),
                    h("path", { "opacity": "1", "fill": "#585a64", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "292.76215", "cy": "386.38617", "d": "M 300.92577,381.6729 L 292.76215,395.81271 L 284.59852,381.6729 L 300.92577,381.6729 z", "transform": "matrix(0,1.1259413,1.1259413,0,20.719223,57.395722)" }),
                  ),
                  h("path", { "transform": "matrix(1.1370745,0,0,1.1370745,-54.470362,-59.078494)", "d": "M 418.96601,392.55499 A 37.527016,37.527016 0 1 1 343.91198,392.55499 A 37.527016,37.527016 0 1 1 418.96601,392.55499 z", "ry": "37.527016", "rx": "37.527016", "cy": "392.55499", "cx": "381.439", "opacity": "1", "fill": "#6fbe58", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "0.87944984", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "opacity": "1", "fill": "#c9cbd1", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "1.03515577", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "381.439", "cy": "392.55499", "rx": "37.527016", "ry": "37.527016", "d": "M 418.96601,392.55499 A 37.527016,37.527016 0 1 1 343.91198,392.55499 A 37.527016,37.527016 0 1 1 418.96601,392.55499 z", "transform": "matrix(0.9660382,0,0,0.9660382,10.769546,8.0626522)" }),
                  h("path", { "transform": "matrix(0.719677,0,0,0.719677,104.74129,99.730104)", "d": "M 418.96601,392.55499 A 37.527016,37.527016 0 1 1 343.91198,392.55499 A 37.527016,37.527016 0 1 1 418.96601,392.55499 z", "ry": "37.527016", "rx": "37.527016", "cy": "392.55499", "cx": "381.439", "opacity": "1", "fill": "#8f9198", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1.48899412", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "fill": "#6fbe58", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "0.25pt", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-opacity": "1", "d": "M 344.94011,404.6356 C 356.55517,375.84775 372.81663,358.36941 399.68843,354.25686 L 402.77285,356.8272 C 380.82322,364.71715 359.94283,386.25936 349.05266,410.29035 L 344.94011,404.6356 z" }),
                  h("path", { "d": "M 411.22775,403.33198 C 400.48541,376.70717 385.44579,360.5421 360.59307,356.73856 L 357.7404,359.11577 C 378.0408,366.41289 397.35229,386.33648 407.42421,408.56185 L 411.22775,403.33198 z", "fill": "#6fbe58", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "0.25pt", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-opacity": "1" }),
                  h("path", { "d": "M 542.19462,503.98223 C 542.19462,535.38796 516.70589,560.87669 485.30015,560.87669 C 453.89441,560.87669 428.40568,535.38796 428.40568,503.98223 C 428.40568,472.57648 453.89441,447.08775 485.30015,447.08775 C 516.70589,447.08775 542.19462,472.57648 542.19462,503.98223 z M 533.89089,503.98222 C 533.89089,530.80431 512.12223,552.57296 485.30015,552.57296 C 458.47806,552.57296 436.7094,530.80431 436.7094,503.98222 C 436.7094,477.16013 458.47806,455.39148 485.30015,455.39148 C 512.12223,455.39148 533.89089,477.16013 533.89089,503.98222 z", "fill": "#232430", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "2.06702876", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1" }),
                  h("path", { "fill": "#232430", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "2.06702876", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 218.67656,375.05998 C 218.67656,405.28811 194.14356,429.82111 163.91542,429.82111 C 133.68728,429.82111 109.15428,405.28811 109.15428,375.05998 C 109.15428,344.83183 133.68728,320.29883 163.91542,320.29883 C 194.14356,320.29883 218.67656,344.83183 218.67656,375.05998 z M 210.68419,375.05997 C 210.68419,400.87633 189.73177,421.82874 163.91542,421.82874 C 138.09906,421.82874 117.14664,400.87633 117.14664,375.05997 C 117.14664,349.24361 138.09906,328.2912 163.91542,328.2912 C 189.73177,328.2912 210.68419,349.24361 210.68419,375.05997 z" }),
                  h("path", { "fill": "none", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#969696", "stroke-width": "0.81337047", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 379.23104,433.61031 C 391.84679,433.61031 403.58355,428.83839 411.56194,420.32531 C 418.67644,412.73401 427.24865,406.41041 434.19669,406.41041 C 441.14473,406.41041 433.66336,406.41041 433.66336,406.41041 C 433.66336,406.41041 461.60758,406.41041 461.60758,406.41041 C 472.06124,406.41041 480.54536,397.92629 480.54536,387.3792 C 480.54536,376.83212 472.06124,368.348 461.60758,368.348 C 461.60758,368.348 433.66336,368.348 433.66336,368.348 C 433.66336,368.348 441.14473,368.348 434.19669,368.348 C 427.24865,368.348 418.67644,362.0244 411.56194,354.4331 C 403.58355,345.92002 391.82365,341.1481 379.23104,341.1481 C 366.63844,341.1481 354.87854,345.92002 346.90015,354.4331 C 339.78565,362.0244 331.21344,368.348 324.2654,368.348 C 317.31736,368.348 324.79873,368.348 324.79873,368.348 C 324.79873,368.348 296.85451,368.348 296.85451,368.348 C 286.40085,368.348 277.91673,376.83212 277.91673,387.3792 C 277.91673,397.92629 286.40085,406.41041 296.85451,406.41041 C 296.85451,406.41041 324.79873,406.41041 324.79873,406.41041 C 324.79873,406.41041 317.31736,406.41041 324.2654,406.41041 C 331.21344,406.41041 339.78565,412.73401 346.90015,420.32531 C 354.87854,428.83839 366.6153,433.61031 379.23104,433.61031 z" }),
                  h("path", { "fill": "#232430", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "2.06702876", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 338.14038,501.44979 C 338.14038,541.32529 305.77763,573.68804 265.90212,573.68804 C 226.0266,573.68804 193.66386,541.32529 193.66386,501.44979 C 193.66386,461.57427 226.0266,429.21152 265.90212,429.21152 C 305.77763,429.21152 338.14038,461.57427 338.14038,501.44979 z M 327.59723,501.44978 C 327.59723,535.50548 299.95781,563.14489 265.90212,563.14489 C 231.84642,563.14489 204.207,535.50548 204.207,501.44978 C 204.207,467.39408 231.84642,439.75467 265.90212,439.75467 C 299.95781,439.75467 327.59723,467.39408 327.59723,501.44978 z" }),
                  h(
                    "g",
                    { "transform": "translate(-321.84517,-119.25308)" },
                    h("path", { "opacity": "1", "fill": "#26272d", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "translate(-5.525239,0)" }),
                    h("path", { "transform": "matrix(0.7102804,0,0,0.7102804,136.8099,143.21219)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "opacity": "1", "fill": "#1b1c21", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "4.22368431", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                    h(
                      "g",
                      { "transform": "matrix(1.0746269,0,0,1.0746269,-36.250788,-36.889032)" },
                      h("path", { "transform": "matrix(8.4112218e-2,0,0,8.4112218e-2,471.14277,452.73529)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                      h("path", { "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "matrix(8.4112218e-2,0,0,8.4112218e-2,417.73213,452.73529)" }),
                      h("path", { "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "matrix(0,8.4112218e-2,-8.4112218e-2,0,527.33836,479.69524)" }),
                      h("path", { "transform": "matrix(0,8.4112218e-2,-8.4112218e-2,0,527.33836,426.2846)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                    ),
                  ),
                  h(
                    "g",
                    { "transform": "translate(-0.4604366,9.6691683)" },
                    h("path", { "transform": "translate(-5.525239,0)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "opacity": "1", "fill": "#26272d", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                    h("path", { "opacity": "1", "fill": "#1b1c21", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "4.22368431", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "matrix(0.7102804,0,0,0.7102804,136.8099,143.21219)" }),
                    h(
                      "g",
                      { "transform": "matrix(1.0746269,0,0,1.0746269,-36.250788,-36.889032)" },
                      h("path", { "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "matrix(8.4112218e-2,0,0,8.4112218e-2,471.14277,452.73529)" }),
                      h("path", { "transform": "matrix(8.4112218e-2,0,0,8.4112218e-2,417.73213,452.73529)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                      h("path", { "transform": "matrix(0,8.4112218e-2,-8.4112218e-2,0,527.33836,479.69524)", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "ry": "49.266716", "rx": "49.266716", "cy": "494.31305", "cx": "491.28583", "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                      h("path", { "fill": "#3d3e46", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "26.74999046", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "491.28583", "cy": "494.31305", "rx": "49.266716", "ry": "49.266716", "d": "M 540.55254,494.31305 A 49.266716,49.266716 0 1 1 442.01911,494.31305 A 49.266716,49.266716 0 1 1 540.55254,494.31305 z", "transform": "matrix(0,8.4112218e-2,-8.4112218e-2,0,527.33836,426.2846)" }),
                    ),
                  ),
                  h("path", { "transform": "matrix(1.2631579,0,0,1.2631579,-32.710591,-100.04633)", "d": "M 565.68628,384.47525 A 28.661438,28.661438 0 1 1 508.3634,384.47525 A 28.661438,28.661438 0 1 1 565.68628,384.47525 z", "ry": "28.661438", "rx": "28.661438", "cy": "384.47525", "cx": "537.02484", "opacity": "1", "fill": "#2b2c33", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "d": "M 692.40625,795.6875 C 729.24632,796.78087 745.21397,776.84954 748.8125,678.25 C 752.58374,574.91798 685.51396,378.56055 665.84375,329.03125 C 646.1735,279.50196 547.13046,253.20593 502.1875,281.53125 C 465.20101,304.842 424.68118,307.90625 375.15625,307.90625 C 325.63133,307.90625 285.14275,304.842 248.15625,281.53125 C 235.51605,273.56475 218.57513,269.89652 200.34375,269.875 C 153.75246,269.82 98.606739,293.43208 84.46875,329.03125 C 64.798509,378.56054 -2.2712417,574.91797 1.5,678.25 C 5.0785642,776.30266 20.906856,796.56763 57.3125,795.70312 C 141.78831,786.65213 150.45828,738.83858 207.40625,694.09375 C 260.20364,652.61006 297.18742,648.83525 374.875,650.34375 C 452.56257,648.83527 489.51511,652.61009 542.3125,694.09375 C 599.26048,738.83855 607.93044,786.63651 692.40625,795.6875 z", "fill": "none", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "3", "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "opacity": "1", "fill": "#2b2c33", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "537.02484", "cy": "384.47525", "rx": "28.661438", "ry": "28.661438", "d": "M 565.68628,384.47525 A 28.661438,28.661438 0 1 1 508.3634,384.47525 A 28.661438,28.661438 0 1 1 565.68628,384.47525 z", "transform": "matrix(1.2631579,0,0,1.2631579,-141.69948,-100.04633)" }),
                  h("path", { "opacity": "1", "fill": "#4a7fd6", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "536.64771", "cy": "382.96677", "rx": "25.267321", "ry": "25.267321", "d": "M 561.91503,382.96677 A 25.267321,25.267321 0 1 1 511.38038,382.96677 A 25.267321,25.267321 0 1 1 561.91503,382.96677 z" }),
                  h("path", { "opacity": "1", "fill": "#2b2c33", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "537.02484", "cy": "384.47525", "rx": "28.661438", "ry": "28.661438", "d": "M 565.68628,384.47525 A 28.661438,28.661438 0 1 1 508.3634,384.47525 A 28.661438,28.661438 0 1 1 565.68628,384.47525 z", "transform": "matrix(1.2631579,0,0,1.2631579,-87.393598,-152.08947)" }),
                  h("path", { "d": "M 561.91503,382.96677 A 25.267321,25.267321 0 1 1 511.38038,382.96677 A 25.267321,25.267321 0 1 1 561.91503,382.96677 z", "ry": "25.267321", "rx": "25.267321", "cy": "382.96677", "cx": "536.64771", "opacity": "1", "fill": "#cc4f4f", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "transform": "translate(109.36601,0)" }),
                  h("path", { "d": "M 561.91503,382.96677 A 25.267321,25.267321 0 1 1 511.38038,382.96677 A 25.267321,25.267321 0 1 1 561.91503,382.96677 z", "ry": "25.267321", "rx": "25.267321", "cy": "382.96677", "cx": "536.64771", "fill": "#d9bd45", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "transform": "matrix(-1,0,0,-1,1127.9784,711.25052)" }),
                  h("path", { "transform": "matrix(1.2631579,0,0,1.2631579,-87.393598,-44.609078)", "d": "M 565.68628,384.47525 A 28.661438,28.661438 0 1 1 508.3634,384.47525 A 28.661438,28.661438 0 1 1 565.68628,384.47525 z", "ry": "28.661438", "rx": "28.661438", "cy": "384.47525", "cx": "537.02484", "opacity": "1", "fill": "#2b2c33", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1" }),
                  h("path", { "transform": "matrix(-1,0,0,-1,1127.9784,820.61655)", "fill": "#6fbe58", "fill-opacity": "1", "fill-rule": "evenodd", "stroke": "#0c0d12", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-dasharray": "none", "stroke-opacity": "1", "cx": "536.64771", "cy": "382.96677", "rx": "25.267321", "ry": "25.267321", "d": "M 561.91503,382.96677 A 25.267321,25.267321 0 1 1 511.38038,382.96677 A 25.267321,25.267321 0 1 1 561.91503,382.96677 z" }),
                  h("path", { "fill": "#b9bcc6", "fill-opacity": "0.48677243", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 553.83094,369.19255 C 553.83094,375.08056 546.1101,370.82393 536.59692,370.82393 C 527.08374,370.82393 519.3629,375.08056 519.3629,369.19255 C 519.3629,363.30455 527.08374,358.52587 536.59692,358.52587 C 546.1101,358.52587 553.83094,363.30455 553.83094,369.19255 z" }),
                  h("path", { "d": "M 609.04671,315.31534 C 609.04671,321.20335 601.32587,316.94672 591.81269,316.94672 C 582.29951,316.94672 574.57867,321.20335 574.57867,315.31534 C 574.57867,309.42734 582.29951,304.64866 591.81269,304.64866 C 601.32587,304.64866 609.04671,309.42734 609.04671,315.31534 z", "fill": "#b9bcc6", "fill-opacity": "0.48677243", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1" }),
                  h("path", { "fill": "#b9bcc6", "fill-opacity": "0.48677243", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 609.04671,423.73903 C 609.04671,429.62704 601.32587,425.37041 591.81269,425.37041 C 582.29951,425.37041 574.57867,429.62704 574.57867,423.73903 C 574.57867,417.85103 582.29951,413.07235 591.81269,413.07235 C 601.32587,413.07235 609.04671,417.85103 609.04671,423.73903 z" }),
                  h("path", { "d": "M 663.92784,369.52718 C 663.92784,375.41519 656.207,371.15856 646.69382,371.15856 C 637.18064,371.15856 629.4598,375.41519 629.4598,369.52718 C 629.4598,363.63918 637.18064,358.8605 646.69382,358.8605 C 656.207,358.8605 663.92784,363.63918 663.92784,369.52718 z", "fill": "#b9bcc6", "fill-opacity": "0.48677243", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1" }),
                  h("path", { "d": "M 612.51723,341.12116 C 612.51723,334.58641 602.05531,345.61344 591.49718,345.61344 C 580.93905,345.61344 570.47713,334.90191 570.47713,341.43666 C 570.47713,347.97141 580.93905,352.95949 591.49718,352.95949 C 602.05531,352.95949 612.51723,347.65591 612.51723,341.12116 z", "fill": "#101114", "fill-opacity": "0.26455024", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1" }),
                  h("path", { "fill": "#101114", "fill-opacity": "0.26455024", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 612.51723,450.91606 C 612.51723,444.38131 602.05531,455.40834 591.49718,455.40834 C 580.93905,455.40834 570.47713,444.69681 570.47713,451.23156 C 570.47713,457.76631 580.93905,462.75439 591.49718,462.75439 C 602.05531,462.75439 612.51723,457.45081 612.51723,450.91606 z" }),
                  h("path", { "d": "M 557.61978,396.01861 C 557.61978,389.48386 547.15786,400.51089 536.59973,400.51089 C 526.0416,400.51089 515.57968,389.79936 515.57968,396.33411 C 515.57968,402.86886 526.0416,407.85694 536.59973,407.85694 C 547.15786,407.85694 557.61978,402.55336 557.61978,396.01861 z", "fill": "#101114", "fill-opacity": "0.26455024", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1" }),
                  h("path", { "fill": "#101114", "fill-opacity": "0.26455024", "fill-rule": "evenodd", "stroke": "none", "stroke-width": "1", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-miterlimit": "4", "stroke-opacity": "1", "d": "M 667.73018,396.01861 C 667.73018,389.48386 657.26826,400.51089 646.71013,400.51089 C 636.152,400.51089 625.69008,389.79936 625.69008,396.33411 C 625.69008,402.86886 636.152,407.85694 646.71013,407.85694 C 657.26826,407.85694 667.73018,402.55336 667.73018,396.01861 z" }),
                ),
              ),
              // The dressing the flat art lacks: light, and its lost lettering.
              h(
                "g",
                { transform: "translate(0,120)" },
                h("ellipse", { cx: "376", cy: "150", rx: "255", ry: "95", fill: "rgba(255,255,255,0.05)", filter: "url(#x360a-soft)" }),
                h("ellipse", { cx: "168", cy: "470", rx: "85", ry: "140", fill: "rgba(0,0,0,0.22)", filter: "url(#x360a-soft)" }),
                h("ellipse", { cx: "585", cy: "470", rx: "85", ry: "140", fill: "rgba(0,0,0,0.22)", filter: "url(#x360a-soft)" }),
                h("ellipse", { cx: "368", cy: "106", rx: "13", ry: "8", fill: "rgba(255,255,255,0.35)", filter: "url(#x360a-soft)" }),
                h("text", { class: "x360a-face", x: "592", y: "79", "text-anchor": "middle", fill: "#16181f" }, "Y"),
                h("text", { class: "x360a-face", x: "537", y: "135", "text-anchor": "middle", fill: "#16181f" }, "X"),
                h("text", { class: "x360a-face", x: "646", y: "135", "text-anchor": "middle", fill: "#16181f" }, "B"),
                h("text", { class: "x360a-face", x: "592", y: "191", "text-anchor": "middle", fill: "#16181f" }, "A"),
                h("text", { class: "x360a-lab", x: "299", y: "99", "text-anchor": "middle", fill: "#7c808c" }, "BACK"),
                h("text", { class: "x360a-lab", x: "459", y: "99", "text-anchor": "middle", fill: "#7c808c" }, "START"),
                h("text", { class: "x360a-num", x: "340", y: "84", "text-anchor": "middle", fill: "#565a64" }, "1"),
                h("text", { class: "x360a-num", x: "420", y: "84", "text-anchor": "middle", fill: "#565a64" }, "2"),
                h("text", { class: "x360a-num", x: "340", y: "172", "text-anchor": "middle", fill: "#565a64" }, "3"),
                h("text", { class: "x360a-num", x: "420", y: "172", "text-anchor": "middle", fill: "#565a64" }, "4"),
              ),
              // The hook overlay: invisible until the live echo fills it.
              h(
                "g",
                { transform: "translate(0,120)" },
                h("circle", { "data-fn": "lthumb", cx: "163", cy: "115", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "ly.max", cx: "163", cy: "84", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "ly.min", cx: "163", cy: "146", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "lx.min", cx: "132", cy: "115", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "lx.max", cx: "194", cy: "115", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "rthumb", cx: "487", cy: "243", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "ry.max", cx: "487", cy: "212", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "ry.min", cx: "487", cy: "274", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "rx.min", cx: "456", cy: "243", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "rx.max", cx: "518", cy: "243", r: "16", fill: "transparent" }),
                h("circle", { "data-fn": "dpad.up", cx: "266", cy: "204", r: "18", fill: "transparent" }),
                h("circle", { "data-fn": "dpad.down", cx: "266", cy: "278", r: "18", fill: "transparent" }),
                h("circle", { "data-fn": "dpad.left", cx: "230", cy: "241", r: "18", fill: "transparent" }),
                h("circle", { "data-fn": "dpad.right", cx: "301", cy: "241", r: "18", fill: "transparent" }),
                h("circle", { "data-fn": "guide", cx: "380", cy: "120", r: "43", fill: "transparent" }),
                h("circle", { "data-fn": "back", cx: "299", cy: "127", r: "17", fill: "transparent" }),
                h("circle", { "data-fn": "start", cx: "459", cy: "127", r: "17", fill: "transparent" }),
                h("circle", { "data-fn": "y", cx: "592", cy: "68", r: "29", fill: "transparent" }),
                h("circle", { "data-fn": "x", cx: "537", cy: "124", r: "29", fill: "transparent" }),
                h("circle", { "data-fn": "b", cx: "646", cy: "124", r: "29", fill: "transparent" }),
                h("circle", { "data-fn": "a", cx: "592", cy: "180", r: "29", fill: "transparent" }),
                // The glance callouts: which KEY presses each control,
                // filled imperatively per payload (data-live-chatter).
                h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "163", y: "121", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "163", y: "57", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "163", y: "183", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "105", y: "121", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "221", y: "121", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "487", y: "249", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "487", y: "186", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "487", y: "311", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "430", y: "249", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "544", y: "249", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "266", y: "174", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "266", y: "316", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "202", y: "247", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "329", y: "247", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "380", y: "179", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "299", y: "158", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "459", y: "158", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "592", y: "29", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "498", y: "130", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "685", y: "130", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "592", y: "227", "text-anchor": "middle" }),
              ),
              h(
                "g",
                null,
                h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "101", y: "34", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "101", y: "94", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "650", y: "34", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "650", y: "94", "text-anchor": "start" }),
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
                h("circle", { class: "wspad-stick", cx: "38.1", cy: "36.12", r: "6.6" }),
                h("circle", { "data-fn": "lthumb", cx: "38.1", cy: "36.12", r: "3.0", fill: "transparent" }),
                h("circle", { "data-fn": "ly.max", cx: "38.1", cy: "31.9", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "ly.min", cx: "38.1", cy: "40.3", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "lx.min", cx: "33.9", cy: "36.12", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "lx.max", cx: "42.3", cy: "36.12", r: "2.3", fill: "transparent" }),
                h("circle", { class: "wspad-well", cx: "74.46", cy: "36.12", r: "9.6" }),
                h("circle", { class: "wspad-stick", cx: "74.46", cy: "36.12", r: "6.6" }),
                h("circle", { "data-fn": "rthumb", cx: "74.46", cy: "36.12", r: "3.0", fill: "transparent" }),
                h("circle", { "data-fn": "ry.max", cx: "74.46", cy: "31.9", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "ry.min", cx: "74.46", cy: "40.3", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "rx.min", cx: "70.26", cy: "36.12", r: "2.3", fill: "transparent" }),
                h("circle", { "data-fn": "rx.max", cx: "78.66", cy: "36.12", r: "2.3", fill: "transparent" }),
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
              h(
                "g",
                null,
                h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "17", y: "5.6", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "17", y: "14.6", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "94.5", y: "5.6", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "94.5", y: "14.6", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "35.2", y: "23", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "77.4", y: "23", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "23.1", y: "28.8", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "23.1", y: "51.6", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "12.6", y: "41.2", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "33.6", y: "41.2", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "39.3", y: "56", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "39.3", y: "46", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "39.3", y: "64.8", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "31.2", y: "56", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "47.4", y: "56", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "73.3", y: "56", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "73.3", y: "46", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "73.3", y: "64.8", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "65.2", y: "56", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "81.4", y: "56", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "56.3", y: "66.5", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "89.3", y: "25.6", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "103.5", y: "40.8", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "76.4", y: "40.8", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "89.3", y: "53.8", "text-anchor": "middle" }),
              ),
            ),
          ),
        ),
        h(
          "div",
          { class: "n-kbhead" },
          h(
            "div",
            { "aria-hidden": "true", class: () => nKeyCueCls() },
            h("span", { class: "n-cue-dot" }),
            h("span", null, () => nKeyCueText()),
          ),
                  h("span", { class: "n-kick" }, () => nKbTitle()),
          // The board's key to its own map: which colour speaks for which
          // controller. Each chip mutes that player's colour on the keys —
          // the visibility control lives WITH the colour it explains.
          h(
            "div",
            { class: "n-legend" },
            createList(
              () => nLegend(),
              (r) => r.slot + "|" + r.badge + "|" + r.name + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "legend-mute",
                    "data-slot": r.slot,
                    "aria-pressed": "true",
                    title: "Hide this controller's colour on the keys",
                    class: r.cls,
                  },
                  h("span", { class: "n-lgd-dot" }),
                  h("span", { class: "n-lgd-badge" }, r.badge),
                  h("span", { class: "n-lgd-name" }, r.name),
                ),
            ),
          ),
          h("div", { class: "n-spring" }),
          // Focus the board on the controller you are editing: everyone
          // else's colour greys out — nothing is hidden, so a key never
          // looks unbound when it is not. Default ships in the markup
          // (the parity gate's rule).
          h(
            "button",
            {
              type: "button",
              "data-nx": "kb-colors",
              "aria-pressed": "false",
              title:
                "Grey out every other controller's colour, so only the selected one is coloured on the keys",
              class: "n-kbcolors",
            },
            () => nSoloLbl(),
          ),
          h(
            "button",
            {
              class: "n-collapse n-kbtoggle",
              type: "button",
              title: "Show or hide the keyboard",
              "data-nx": "pane-bottom",
            },
            "▾",
          ),
        ),
        h(
          "div",
          { class: "n-kbpane" },
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
          { "data-client-fit": "", class: () => nKbCls() },
          h(
            "div",
            { class: "n-kbcase", "data-client-fit": "" },
          h(
            "div",
            { class: "n-kbrow" },
            createList(
              () => nKbRow1(),
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
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
              (r) => r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria,
              (r) =>
                h(
                  "div",
                  { "data-key": r.key, title: r.title, role: "img", "aria-label": r.aria, class: r.cls },
                  h("span", { class: "n-key-cap" }, r.cap),
                  h("span", { class: "n-key-short" }, r.short),
                ),
            ),
          ),
        ),
        h("p", { class: "n-devnote" }, () => nKbNote()),
        ),
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
            "form",
            { class: "n-filter", method: "get", action: "/nocturne" },
            h("span", { class: "n-filter-ico" }, "⌕"),
            h("input", { type: "hidden", name: "slot", value: () => nSlotVal() }),
            h("input", { class: "n-filter-in", type: "text", name: "q", placeholder: "Filter inputs" }),
          ),
          h("button", { class: "n-reset", type: "button", "data-nx": "filter-reset" }, "Reset"),
        ),
        // The pane's two READINGS of one relation: by control (game side)
        // and by key (hand side). Same facts, opposite subject.
        h(
          "div",
          { class: "n-vseg" },
          h("button", { type: "button", class: "n-vseg-btn vc", "data-nx": "view-ctl" }, "By control"),
          h("button", { type: "button", class: "n-vseg-btn vk", "data-nx": "view-keys" }, "By key"),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, () => nBindTitle()),
        ),
        // Bulk hands on the whole list: one toggle holds every editor open
        // or shut, and Clear all sits behind its consequence fold.
        h(
          "div",
          { class: "n-bindtools" },
          h(
            "button",
            { type: "button", class: "n-bbtn sm", "data-nx": "bind-expand" },
            () => nExpandLbl(),
          ),
          h(
            "details",
            { class: "n-clearall" },
            h("summary", { class: "n-clearall-sum" }, "Clear all…"),
            h(
              "div",
              { class: "n-clearall-body" },
              h(
                "p",
                { class: "n-foot" },
                "Every key on this controller is unbound in the draft — macro trigger keys too. The macros keep their steps; nothing saved changes.",
              ),
              h(
                "form",
                { class: "n-inline", method: "post", action: "/nocturne/bind/clear-all" },
                h("input", { type: "hidden", name: "number", value: () => nSlotVal() }),
                h("button", { type: "submit", class: "n-bbtn sm danger" }, "Unbind every key"),
              ),
            ),
          ),
        ),
        // Every row is the mapper's own truth (keys, fan-out, turbo and
        // toggle notes) AND a native disclosure: the summary is the row,
        // the body is the rebind editor. Rebind/Add arm the daemon's
        // learner; Hold|Toggle and Turbo are real form twins that work
        // with scripting off; Clear was already real.
        // Grouped the way the controller is organised: the headers
        // carry served counts, and the filter hides a group whose rows
        // are all hidden. One served class hides every frame when no
        // slot serves rows.
        h(
          "div",
          { class: () => nBindGCls() },
          h(
            "p",
            { class: "n-teach" },
            "Click a key chip, then press the new key; + adds one, ✕ unbinds. Open a row for press behaviour and turbo.",
          ),
        h(
          "section",
          { class: () => nBindFaceCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "Face buttons"),
            h("span", { class: "n-bindg-n" }, () => nBindFaceN()),
          ),
          createList(
            () => nBindFace(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlFace(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: () => nBindDpadCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "D-pad"),
            h("span", { class: "n-bindg-n" }, () => nBindDpadN()),
          ),
          createList(
            () => nBindDpad(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlDpad(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: () => nBindShlCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "Shoulders & triggers"),
            h("span", { class: "n-bindg-n" }, () => nBindShlN()),
          ),
          createList(
            () => nBindShl(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlShl(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: () => nBindLsCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "Left stick"),
            h("span", { class: "n-bindg-n" }, () => nBindLsN()),
          ),
          createList(
            () => nBindLs(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlLs(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: () => nBindRsCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "Right stick"),
            h("span", { class: "n-bindg-n" }, () => nBindRsN()),
          ),
          createList(
            () => nBindRs(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlRs(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: () => nBindSysCls() },
          h(
            "div",
            { class: "n-bindg-head" },
            h("span", { class: "n-bindg-lab" }, "System"),
            h("span", { class: "n-bindg-n" }, () => nBindSysN()),
          ),
          createList(
            () => nBindSys(),
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
                r.badge,
                r.badge_cls,
                r.add_cls,
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
                  h("span", { class: r.badge_cls }, r.badge),
                  h("span", { class: "n-bind-verb" }, "driven by"),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-learn",
                      title: r.chip_title,
                      class: r.chip_cls,
                    },
                    r.chip,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-add",
                      title: "Add another key to this control",
                      "aria-label": "Add another key to this control",
                      class: r.add_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "chip-remove",
                      title: "Remove one key from this control — press it when asked",
                      "aria-label": "Remove one key from this control",
                      class: r.minus_cls,
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                    ),
                  ),
                  // The control's own Clear: a real form twin riding the
                  // hover, so unbinding is one click from the row itself.
                  h(
                    "form",
                    { class: "n-inline", method: "post", action: "/nocturne/bind/clear" },
                    h("input", { type: "hidden", name: "slot", value: r.slot }),
                    h("input", { type: "hidden", name: "function", value: r.function }),
                    h(
                      "button",
                      {
                        type: "submit",
                        "data-nx": "row-clear",
                        title: "Back to unbound",
                        "aria-label": "Unbind this control",
                        class: r.clear_cls,
                      },
                      h(
                        "svg",
                        { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                        h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                      ),
                    ),
                  ),
                ),
                h(
                  "div",
                  { class: "n-bedit" },
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
                  ),
                  h(
                    "div",
                    { class: "n-bedit-row" },
                    h(
                      "span",
                      {
                        class: "n-bedit-lab",
                        title:
                          "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).",
                      },
                      "Turbo",
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "0" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Turn auto-fire off" },
                        "Off",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "5" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Gentle — 5 presses a second" },
                        "5/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "10" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Standard — 10 presses a second" },
                        "10/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", { type: "hidden", name: "turbo_hz", value: "15" }),
                      h(
                        "button",
                        { type: "submit", class: "n-tpre", title: "Fast — 15 presses a second" },
                        "15/s",
                      ),
                    ),
                    h(
                      "form",
                      { class: "n-inline n-turbo-form", method: "post", action: "/nocturne/bind/turbo" },
                      h("input", { type: "hidden", name: "slot", value: r.slot }),
                      h("input", { type: "hidden", name: "function", value: r.function }),
                      h("input", {
                        class: "n-turbo-in",
                        type: "text",
                        inputmode: "numeric",
                        name: "turbo_hz",
                        placeholder: "Hz",
                        title: "Your own rate — presses a second; 0 turns auto-fire off",
                        value: r.turbo,
                      }),
                      h("button", { type: "submit", class: "n-bbtn sm" }, "Set"),
                    ),
                  ),
                ),
              ),
          ),
          h(
            "div",
            { class: "n-ctlstrip" },
            createList(
              () => nCtlSys(),
              (r) => r.function + "|" + r.label + "|" + r.cls,
              (r) =>
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "ctl-assign",
                    "data-fn": r.function,
                    title: "Free — click, then press a key (or click one on the board)",
                    class: r.cls,
                  },
                  r.label,
                ),
            ),
          ),
        ),
        ),
        // ── The BY-KEY view: keyboard -> controller. Assign starts from
        // the key; the pad is the picker (click the control to give it the
        // key), riding the same bind machinery and conflict dialog.
        h(
          "div",
          { class: "n-krows" },
          h(
            "p",
            { class: "n-teach" },
            "Each key, and everything it drives. + assigns the key to another control — click that control on the pad.",
          ),
          h("p", { class: "n-foot" }, () => nKeysNote()),
          createList(
            () => nKeyRows(),
            (r) => r.key + "|" + r.targets + "|" + r.fns + "|" + r.cls + "|" + r.slot,
            (r) =>
              h(
                "div",
                { "data-key": r.key, "data-fns": r.fns, class: r.cls },
                h("span", { class: "n-krow-chip" }, r.key),
                h("span", { class: "n-krow-verb" }, "drives"),
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "jump-controls",
                    title: "Open these controls in the By-control view",
                    class: "n-krow-tg door",
                  },
                  r.targets,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "key-assign",
                    title: "Assign this key to another control — then click that control on the pad",
                    "aria-label": "Assign this key to another control",
                    class: "n-addchip",
                  },
                  h(
                    "svg",
                    { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                    h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "key-remove",
                    title: "Remove this key from one control — click that control on the pad",
                    "aria-label": "Remove this key from one control",
                    class: "n-minus",
                  },
                  h(
                    "svg",
                    { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                    h("path", { d: "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z" }),
                  ),
                ),
                // The key's own Clear: takes it away from EVERYTHING it
                // drives — a real form twin, so it works with scripting off.
                h(
                  "form",
                  { class: "n-inline", method: "post", action: "/nocturne/key/clear" },
                  h("input", { type: "hidden", name: "number", value: r.slot }),
                  h("input", { type: "hidden", name: "key", value: r.key }),
                  h(
                    "button",
                    {
                      type: "submit",
                      class: "n-krow-clear",
                      title: "Unbind this key from everything it drives",
                      "aria-label": "Unbind this key from everything it drives",
                    },
                    h(
                      "svg",
                      { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                      h("path", { d: "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z" }),
                    ),
                  ),
                ),
              ),
          ),
          // The rest of the board's REAL vocabulary, free to bind — in the
          // keyboard's own geography.
          h(
            "div",
            { class: () => nAvailMainCls() },
            h("div", { class: "n-bindg-head" }, h("span", { class: "n-bindg-lab" }, () => nAvailMainHead())),
            h(
              "div",
              { class: "n-akey-grid" },
              createList(
                () => nAvailMain(),
                (r) => r.key,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "key-assign",
                      "data-key": r.key,
                      title: "Free — click, then click the control on the pad that should take it",
                      class: r.cls,
                    },
                    r.key,
                  ),
              ),
            ),
          ),
          h(
            "div",
            { class: () => nAvailNavCls() },
            h("div", { class: "n-bindg-head" }, h("span", { class: "n-bindg-lab" }, () => nAvailNavHead())),
            h(
              "div",
              { class: "n-akey-grid" },
              createList(
                () => nAvailNav(),
                (r) => r.key,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "key-assign",
                      "data-key": r.key,
                      title: "Free — click, then click the control on the pad that should take it",
                      class: r.cls,
                    },
                    r.key,
                  ),
              ),
            ),
          ),
          h(
            "div",
            { class: () => nAvailNumCls() },
            h("div", { class: "n-bindg-head" }, h("span", { class: "n-bindg-lab" }, () => nAvailNumHead())),
            h(
              "div",
              { class: "n-akey-grid" },
              createList(
                () => nAvailNum(),
                (r) => r.key,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      "data-nx": "key-assign",
                      "data-key": r.key,
                      title: "Free — click, then click the control on the pad that should take it",
                      class: r.cls,
                    },
                    r.key,
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
          { class: "n-macrosec" },
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
              r.chip_title,
              r.add_cls,
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
                h("span", { class: "n-bind-verb" }, "started by"),
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "chip-learn",
                    title: r.chip_title,
                    class: r.chip_cls,
                  },
                  r.chip,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    "data-nx": "chip-add",
                    title: "Add another trigger key",
                    "aria-label": "Add another trigger key",
                    class: r.add_cls,
                  },
                  h(
                    "svg",
                    { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
                    h("path", { d: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z" }),
                  ),
                ),
              ),
              h(
                "div",
                { class: "n-bedit" },
                h(
                  "div",
                  { class: "n-bedit-row" },
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
            { class: "nd", "data-nx": "dlg-noop", role: "dialog", tabindex: "-1", "aria-label": "Create a virtual controller" },
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
            { class: "nd", "data-nx": "dlg-noop", role: "dialog", tabindex: "-1", "aria-label": "Key conflict" },
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
    // ═══ Apply's needs-restart dialog — the daemon's own words on WHAT the ══
    // draft changed, and the remedy it named: replacing the session.
    // Client-only: a fetch answer, never server state.
    createShow(
      () => nApplyOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "apply-cancel" },
          h(
            "div",
            {
              class: "nd",
              "data-nx": "dlg-noop",
              role: "dialog",
              tabindex: "-1",
              "aria-label": "Session restart needed",
            },
            h("div", { class: "nd-kick" }, "Session restart needed"),
            h("div", { class: "nd-title" }, "The running session cannot take these changes"),
            h("div", { class: "nd-lede" }, () => nApplyMsg()),
            h(
              "div",
              { class: "nd-note" },
              "Replacing the session unplugs the pads and plugs the new draft — a game mid-match will see the controllers reconnect.",
            ),
            h(
              "div",
              { class: "nd-actions" },
              h(
                "button",
                { class: "nd-btn", type: "button", "data-nx": "apply-cancel" },
                "Keep playing as-is",
              ),
              h(
                "button",
                { class: "nd-btn primary", type: "button", "data-nx": "apply-replace" },
                "Replace the session",
              ),
            ),
          ),
        ),
    ),
  );
}
