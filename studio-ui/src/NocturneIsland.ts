import { createList, createShow, createSignal, h } from "@getforma/core";
import { fetchJSON } from "@getforma/core/http";

import { WidgetCanvas, createCanvasItem } from "./genui/canvas/index";
import {
  DS4_PREMIUM_SHELL_TONE,
  DS4_PREMIUM_VARIANTS,
  Ds4PremiumButtonHooks,
  Ds4PremiumDepth,
  Ds4PremiumGeometry,
  type Ds4PremiumVariantSlug,
} from "./ds4PremiumGeometry";
import { DualSensePremiumArt } from "./dualSensePremiumArt";
import {
  DUALSENSE_PREMIUM_SHELL_TONE,
  DUALSENSE_PREMIUM_VARIANTS,
  type DualSensePremiumVariantSlug,
} from "./dualSensePremiumGeometry";
import { SwitchProPremiumArt } from "./switchProPremiumArt";
import {
  SWITCH_PRO_PREMIUM_SHELL_TONE,
  SWITCH_PRO_PREMIUM_VARIANTS,
  type SwitchProPremiumVariantSlug,
} from "./switchProPremiumGeometry";
import { XboxSeriesPremiumArt } from "./xboxSeriesPremiumArt";
import {
  XBOX_SERIES_PREMIUM_SHELL_TONE,
  XBOX_SERIES_PREMIUM_VARIANTS,
  type XboxSeriesPremiumVariantSlug,
} from "./xboxSeriesPremiumGeometry";
import {
  DEFAULT_KEYBOARD_WORKBENCH_STATE,
  KEYBOARD_CAP_PROFILES,
  KEYBOARD_THEMES,
  KEYBOARD_WORKBENCH_BOUNDS,
  KEYBOARD_WORKBENCH_LOOSE_STRIP,
  KEYBOARD_WORKBENCH_PLAYER_PANELS,
  KEYBOARD_WORKBENCH_STORAGE_KEY,
  KEYBOARD_WORKBENCH_STORE_VERSION,
  canonicalKeyboardDeviceIdentity,
  cloneKeyboardWorkbenchState,
  keyboardCapProfileIsValid,
  keyboardThemeIsValid,
  keyboardWorkbenchStateForDevice,
  layoutKeyboardWorkbenchKeys,
  sanitizeKeyboardWorkbenchStore,
  withKeyboardWorkbenchPosition,
  withKeyboardWorkbenchState,
  type KeyboardCapProfileSlug,
  type KeyboardThemeSlug,
  type KeyboardWorkbenchPlacedKey,
  type KeyboardWorkbenchRecord,
  type KeyboardWorkbenchState,
  type KeyboardWorkbenchStore,
} from "./keyboardWorkbench";
import {
  CONTROL_SURFACE_BOUNDS,
  CONTROL_SURFACE_MAX_CONTROLS,
  CONTROL_SURFACE_STORAGE_KEY,
  CONTROL_SURFACE_STORE_VERSION,
  CONTROL_SURFACE_TEMPLATES,
  DEFAULT_CONTROL_SURFACE_STATE,
  addControlSurfaceControl,
  applyControlSurfaceTemplate,
  cloneControlSurfaceState,
  controlSurfaceStateForDevice,
  controlSurfaceWorkbenchMigrated,
  copyControlSurfaceControl,
  migrateKeyboardWorkbenchSurface,
  moveControlSurfaceControl,
  removeControlSurfaceControl,
  renameControlSurfaceControl,
  resolveControlSurfaceSharedSignal,
  sanitizeControlSurfaceStore,
  selectControlSurfaceControl,
  setControlSurfacePlayerSlot,
  setControlSurfaceStage,
  teachControlSurfaceChannel,
  withControlSurfaceState,
  withControlSurfaceWorkbenchMigrated,
  type ControlSurfaceChannel,
  type ControlSurfaceControl,
  type ControlSurfaceControlKind,
  type ControlSurfaceMappingRecord,
  type ControlSurfaceStage,
  type ControlSurfaceState,
  type ControlSurfaceStore,
  type ControlSurfaceTemplate,
} from "./controlSurface";
import {
  MappingFlowLayer,
  mappingPathModeIsValid,
  type MappingFlowLayoutSummary,
  type MappingPathMode,
} from "./mappingFlow";

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
  role: "keyboard" | "panel-encoder" | "other";
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
  aria: string;
  cap: string;
  key: string;
  cls: string;
  short: string;
  title: string;
}

export interface NocturneMacColView {
  id: string;
  cls: string;
  title: string;
}

interface NocturneMacGroupView {
  label: string;
  count: string;
  cls: string;
  count_cls: string;
}

interface NocturneMacRowView {
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
  up_cls: string;
  dn_cls: string;
  up_act: string;
  dn_act: string;
  ia_act: string;
  ib_act: string;
  del_act: string;
  del_title: string;
}

interface NocturneMacCellView {
  cls: string;
  cell: string;
  mark: string;
  title: string;
  on: string;
  tab: string;
}

interface NocturneMacPolView {
  act: string;
  label: string;
  title: string;
  cls: string;
  head: string;
  head_cls: string;
  note: string;
  note_cls: string;
}

interface NocturneMacMotionView {
  act: string;
  shape: string;
  label: string;
  title: string;
}

interface NocturneLegendRowView {
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

export interface NocturneMacroFlowView {
  name: string;
  triggers: string[];
  outputs: { function: string; steps: number[] }[];
  timeline: string[];
  meta: string;
  disabled: boolean;
  edit_href: string;
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

/** Backend-owned controller endpoint used by the canvas authoring graph.
 * Unlike the legacy pane rows, this keeps exact keys as an array and keeps
 * the controller's zone order even when no list is mounted in the DOM. */
export interface NocturneControlFlowView {
  function: string;
  label: string;
  group: string;
  order: number;
  keys: string[];
  toggle: boolean;
  turbo_hz: number | null;
}

export interface NocturneView {
  dev_count: string;
  dev_note: string;
  encoder_count: string;
  encoder_head: string;
  kb_title: string;
  mode_note: string;
  dev_encoders: NocturneDeviceRowView[];
  dev_rows: NocturneDeviceRowView[];
  dev_exp: NocturneDeviceRowView[];
  dev_other: NocturneOtherRowView[];
  exp_head: string;
  exp_fold_cls: string;
  other_head: string;
  other_fold_cls: string;
  mode_rows: NocturneChoiceRowView[];
  theme_rows: NocturneChoiceRowView[];
  cap_line: string;
  capd_cls: string;
  cap_sw_cls: string;
  cap_selector: string;
  cap_instance: string;
  cap_prepare: boolean;
  cap_release: boolean;
  version: string;
  environment_id: string;
  environment_label: string;
  environment_detail: string;
  environment_cls: string;
  environment_fixture: boolean;
  environment_generation: string;
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
  pad_ps5_cls: string;
  pad_switchpro_cls: string;
  pad_xboxseries_cls: string;
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
    target_revision?: string;
    family: string;
    preset: string;
    title: string;
    fn_keys: Record<string, string>;
    fn_names: Record<string, string>;
    mapping_available: boolean;
    mapping_reason: string;
    controls?: NocturneControlFlowView[];
    macros: NocturneMacroFlowView[];
    macro_available: boolean;
    macro_reason: string;
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
  kb_more_cls: string;
  mac: {
    back_cls: string;
    name: string;
    slot: string;
    preset: string;
    table: MacroDraftTable | null;
    head: string;
    trigger: string;
    note: string;
    grid_cls: string;
    close_href: string;
    map_href: string;
    cols: NocturneMacColView[];
    groups: NocturneMacGroupView[];
    rows: NocturneMacRowView[];
    cells: NocturneMacCellView[];
    pols: NocturneMacPolView[];
    motions: NocturneMacMotionView[];
    motion_line: string;
    policy_line: string;
    ring: string;
    rule: string;
    toml: string;
    turbo_cls: string;
    turbo_val: string;
    turbo_label: string;
  };
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
const [nEncoderCount, setNEncoderCount] = createSignal("");
const [nEncoderHead, setNEncoderHead] = createSignal("");
const [nModeNote, setNModeNote] = createSignal("");
const [nDevNote, setNDevNote] = createSignal("");
const [nDevEncoders, setNDevEncoders] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevRows, setNDevRows] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevExp, setNDevExp] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevOther, setNDevOther] = createSignal<NocturneOtherRowView[]>([]);
const [nExpHead, setNExpHead] = createSignal("");
const [nExpFoldCls, setNExpFoldCls] = createSignal("n-devfold none");
const [nOtherHead, setNOtherHead] = createSignal("");
const [nOtherFoldCls, setNOtherFoldCls] = createSignal("n-devfold none");
const [nModeRows, setNModeRows] = createSignal<NocturneChoiceRowView[]>([]);
const [nThemeRows, setNThemeRows] = createSignal<NocturneChoiceRowView[]>([]);
const [nKbTitle, setNKbTitle] = createSignal("");
const [nCapLine, setNCapLine] = createSignal("");
const [nCapdCls, setNCapdCls] = createSignal("n-capd none");
const [nCapSwCls, setNCapSwCls] = createSignal("n-capsw");
const [nCapSelector, setNCapSelector] = createSignal("");
const [nCapInstance, setNCapInstance] = createSignal("");
const [nCapPrep, setNCapPrep] = createSignal(false);
const [nCapRel, setNCapRel] = createSignal(false);
const [nVersion, setNVersion] = createSignal("");
const [nEnvironmentId, setNEnvironmentId] = createSignal("unknown-environment");
const [nEnvironmentLabel, setNEnvironmentLabel] = createSignal(
  "UNKNOWN ENVIRONMENT · NOT QA EVIDENCE",
);
const [nEnvironmentDetail, setNEnvironmentDetail] = createSignal(
  "This provider did not declare whether its data is live or synthetic.",
);
const [nEnvironmentCls, setNEnvironmentCls] = createSignal("n-environment unknown");
const FIXTURE_GENERATION_KEY = "ksx-studio-fixture-generation-v1";

/** Return true when an already-wired document is reloading into a new seed. */
function reconcileFixtureGeneration(v: NocturneView): boolean {
  if (!v.environment_fixture || !v.environment_generation.trim()) return false;
  try {
    if (window.localStorage.getItem(FIXTURE_GENERATION_KEY) === v.environment_generation) {
      return false;
    }
    // Fixture ports are dedicated synthetic origins. Restarting a seed must
    // reset both its in-memory backend and browser-only canvas drafts, or a
    // supposedly clean first-run walkthrough inherits yesterday's layout.
    window.localStorage.clear();
    window.localStorage.setItem(FIXTURE_GENERATION_KEY, v.environment_generation);
    // On first navigation applyNocturne runs before nocturneWire, so the wire
    // will load the now-clean stores. During a live reseed this document has
    // already loaded those stores into memory; reload once before they can be
    // persisted over the clean generation.
    if (learnRoot?.isConnected) {
      window.location.reload();
      return true;
    }
  } catch {
    // A browser that blocks storage also blocks stale drafts from being read
    // after a reload. An already-wired document must still discard its
    // in-memory stores; otherwise a reseed can keep yesterday's canvas alive
    // merely because storage access was refused. On the fresh module pass
    // learnRoot is not connected yet, so this cannot become a reload loop.
    if (learnRoot?.isConnected) {
      window.location.reload();
      return true;
    }
  }
  return false;
}
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
const [nPadPs5Cls, setNPadPs5Cls] = createSignal("n-padwrap none");
const [nPadSwitchProCls, setNPadSwitchProCls] = createSignal("n-padwrap none");
const [nPadXboxSeriesCls, setNPadXboxSeriesCls] = createSignal("n-padwrap none");
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
const [nKbMoreCls, setNKbMoreCls] = createSignal("n-lgdmore none");
const [nKeyboardTheme, setNKeyboardTheme] = createSignal<KeyboardThemeSlug>("carbon-forge");
const [nKeyboardCapProfile, setNKeyboardCapProfile] =
  createSignal<KeyboardCapProfileSlug>("sculpted");
const [nKeyboardWorkbenchOpen, setNKeyboardWorkbenchOpen] = createSignal(false);
const [nKbtCarbonPressed, setNKbtCarbonPressed] = createSignal("true");
const [nKbtLunarPressed, setNKbtLunarPressed] = createSignal("false");
const [nKbtVioletPressed, setNKbtVioletPressed] = createSignal("false");
const [nKbtGlacierPressed, setNKbtGlacierPressed] = createSignal("false");
const [nKbtMintPressed, setNKbtMintPressed] = createSignal("false");
const [nKbtRetroPressed, setNKbtRetroPressed] = createSignal("false");
const [nKbWorkbenchPressed, setNKbWorkbenchPressed] = createSignal("false");
// ── The macro step editor. Its data is SERVED, so a reader with no
// scripting can open a macro by link and read every step; only the editing
// controls are gated on `.js`, because a control that cannot do anything is
// the one thing this page never renders.
const [nMacBackCls, setNMacBackCls] = createSignal("nd-back none");
const [nMacName, setNMacName] = createSignal("");
const [nMacSlot, setNMacSlot] = createSignal("");
const [nMacPreset, setNMacPreset] = createSignal("");
// What the editor just did. `.n-flash` lives under the title bar, BEHIND
// this dialog's own scrim, so a sentence routed there is unreadable
// exactly when it matters most.
const [nMacSay, setNMacSay] = createSignal("");
const [nMacSayCls, setNMacSayCls] = createSignal("n-macsay none");
const [nMacHead, setNMacHead] = createSignal("");
const [nMacTrigger, setNMacTrigger] = createSignal("");
const [nMacNote, setNMacNote] = createSignal("");
const [nMacGridCls, setNMacGridCls] = createSignal("n-macroll empty");
const [nMacClose, setNMacClose] = createSignal("/nocturne");
const [nMacMapHref, setNMacMapHref] = createSignal("");
const [nMacMotionLine, setNMacMotionLine] = createSignal("");
const [nMacPolicyLine, setNMacPolicyLine] = createSignal("");
const [nMacRing, setNMacRing] = createSignal("");
const [nMacRule, setNMacRule] = createSignal("");
const [nMacToml, setNMacToml] = createSignal("");
const [nMacRateCls, setNMacRateCls] = createSignal("n-macrate none");
const [nMacRateVal, setNMacRateVal] = createSignal("");
const [nMacRateLbl, setNMacRateLbl] = createSignal("");
const [nMacCols, setNMacCols] = createSignal<NocturneMacColView[]>([]);
const [nMacGroups, setNMacGroups] = createSignal<NocturneMacGroupView[]>([]);
const [nMacRows, setNMacRows] = createSignal<NocturneMacRowView[]>([]);
const [nMacCells, setNMacCells] = createSignal<NocturneMacCellView[]>([]);
const [nMacPols, setNMacPols] = createSignal<NocturneMacPolView[]>([]);
const [nMacMotions, setNMacMotions] = createSignal<NocturneMacMotionView[]>([]);

/** Dress the roll from one view — the SAME shape whether it arrived on a
 *  payload or as the answer to an edit, so there is one way for the editor to
 *  look right and no second derivation to drift. */
function applyMacView(v: NocturnePayload["view"]["mac"]): void {
  setNMacBackCls(v.back_cls);
  setNMacName(v.name);
  setNMacSlot(v.slot);
  setNMacPreset(v.preset);
  setNMacHead(v.head);
  setNMacTrigger(v.trigger);
  setNMacNote(v.note);
  setNMacGridCls(v.grid_cls);
  setNMacClose(v.close_href);
  setNMacMapHref(v.map_href);
  setNMacMotionLine(v.motion_line);
  setNMacPolicyLine(v.policy_line);
  setNMacRing(v.ring);
  setNMacRule(v.rule);
  setNMacToml(v.toml);
  setNMacRateCls(v.turbo_cls);
  setNMacRateVal(v.turbo_val);
  setNMacRateLbl(v.turbo_label);
  setNMacCols(v.cols);
  setNMacGroups(v.groups);
  setNMacRows(v.rows);
  setNMacCells(v.cells);
  setNMacPols(v.pols);
  setNMacMotions(v.motions);
}

// ── THE DRAFT. The browser holds the `[macros.<name>]` table it is editing;
// every verb is the server's. An act posts the whole table and one word, and
// the answer is the new table plus the roll that draws it — so the diagonal
// lens, the sampling floor and every sentence come from the one place that
// already paints them on the server.
interface MacroDraftStep {
  hold: string[];
  ms: number | null;
  frames: number | null;
  allow_short: boolean;
}

interface MacroDraftTable {
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

let macDraft: MacroDraftTable | null = null;
let macDirty = false;
let macBusy = false;
/** Has the short-step question already been asked for THIS save? */
let macAskedShort = false;
/** The row the author last touched — what "allow a short step" is about. */
let macShortRow: number | null = null;
/** Has a close been warned about already? The warning must not pretend the
 *  work is saved — the draft stays dirty and the label stays honest; this is
 *  what makes the SECOND press go through. */
let macCloseArmed = false;

/** Seed the draft from the staged macro the page just served. Never over an
 *  edit in flight, and never when the dialog is closed. */
function seedMacDraft(p: NocturnePayload): void {
  if (macDirty) return;
  const open = p.view.mac.open;
  if (!open) {
    macDraft = null;
    macAskedShort = false;
    return;
  }
  macDraft = (p.view.mac.table ?? null) as MacroDraftTable | null;
}

/** The editor's answer, inside the panel the reader is looking at. */
function macSay(text: string, kind: "" | "warn" | "err"): void {
  setNMacSay(text);
  setNMacSayCls(text ? `n-macsay${kind ? " " + kind : ""}` : "n-macsay none");
}

function macSayReset(): void {
  macSay("", "");
}

function macDirtyMark(): void {
  const el = learnRoot?.querySelector<HTMLElement>(".n-macdirty");
  if (el) el.textContent = macDirty ? "Unsaved changes" : "";
}

/** One act, applied by the server, answered with the whole roll. */
async function macAct(act: string): Promise<void> {
  if (!macDraft || macBusy) return;
  macBusy = true;
  // Which duration box has the caret, so the rebuild can hand it back.
  const focused = document.activeElement as HTMLElement | null;
  const keepRow = focused?.dataset?.macdur ?? null;
  try {
    const res = await fetch("/nocturne/api/macro/edit", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ slot: Number(nMacSlot()) || 0, act, draft: macDraft }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const out = (await res.json()) as {
      ok: boolean;
      said: string;
      draft: MacroDraftTable;
      view: NocturnePayload["view"]["mac"];
    };
    // A REFUSED ACT CHANGED NOTHING. Marking the macro dirty over a
    // rejected duration left the number in the box disagreeing with the
    // number Save would write, and the refusal itself was never spoken.
    if (!out.ok) {
      macSay(out.said, "err");
      if (keepRow !== null) {
        const box = learnRoot?.querySelector<HTMLInputElement>(`[data-macdur="${keepRow}"]`);
        const row = nMacRows()[Number(keepRow)];
        if (box && row) box.value = row.dur_val;
      }
      return;
    }
    macDraft = out.draft;
    macDirty = true;
    macAskedShort = false;
    macCloseArmed = false;
    macSayReset();
    applyMacView(out.view);
    macDirtyMark();
    if (out.said) macSay(out.said, "");
    if (keepRow !== null) {
      const back = learnRoot?.querySelector<HTMLInputElement>(
        `[data-macdur="${keepRow}"]`,
      );
      back?.focus();
    }
  } catch {
    macSay("The studio did not answer — is ksx still running?", "err");
  } finally {
    macBusy = false;
  }
}

/** Write the whole table, through the same verb the CLI uses. A step under
 *  the sampling floor is never refused and never written silently: the first
 *  Save asks, and says which steps it is about. */
async function macSave(): Promise<void> {
  if (!macDraft || macBusy) return;
  // `warn` is ALSO non-empty for a step naming two units or none — faults,
  // not short steps. The row now carries the answer itself.
  const short = nMacRows().filter((r) => r.short);
  const btn = learnRoot?.querySelector<HTMLButtonElement>(".n-macsave");
  if (short.length > 0 && !macAskedShort) {
    macAskedShort = true;
    if (btn) btn.textContent = "Save it anyway";
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
        slot: Number(nMacSlot()) || 0,
        preset: nMacPreset(),
        name: macDraft.name,
        steps: macDraft.steps,
        on_release: macDraft.on_release,
        retrigger: macDraft.retrigger,
        interrupt: macDraft.interrupt,
        repeat: macDraft.repeat,
        turbo_hz: macDraft.turbo_hz,
        gap_ms: macDraft.gap_ms,
        // ⚠️ THE WHOLE TABLE MEANS THE WHOLE TABLE. Omitting this rewrote a
        // DISABLED macro with the default, so editing one duration on a
        // macro you had switched off started it firing again.
        enabled: !macDraft.disabled,
      }),
    });
    const out = (await res.json()) as {
      ok: boolean;
      error?: string;
      problems?: string[];
    };
    if (out.ok) {
      macDirty = false;
      macAskedShort = false;
      if (btn) btn.textContent = "Save this macro";
      macDirtyMark();
      macSay(`Saved “${macDraft.name}”.`, "");
      nocturnePollFn();
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
  const previouslyOpenMacro = macroDialogOpen()
    ? { slot: nMacSlot(), macro: nMacName() }
    : null;
  const v = p.view;
  if (reconcileFixtureGeneration(v)) return;
  setNDevCount(v.dev_count);
  setNEncoderCount(v.encoder_count);
  setNEncoderHead(v.encoder_head);
  setNDevNote(v.dev_note);
  setNKbTitle(v.kb_title);
  setNDevEncoders(v.dev_encoders);
  setNDevRows(v.dev_rows);
  setNDevExp(v.dev_exp);
  setNDevOther(v.dev_other);
  setNExpHead(v.exp_head);
  setNExpFoldCls(v.exp_fold_cls);
  setNOtherHead(v.other_head);
  setNOtherFoldCls(v.other_fold_cls);
  setNModeNote(v.mode_note);
  setNModeRows(v.mode_rows);
  setNThemeRows(v.theme_rows ?? []);
  setNCapLine(v.cap_line);
  setNCapdCls(v.capd_cls);
  setNCapSwCls(v.cap_sw_cls);
  setNCapSelector(v.cap_selector);
  setNCapInstance(v.cap_instance);
  setNCapPrep(v.cap_prepare);
  setNCapRel(v.cap_release);
  setNVersion(v.version);
  setNEnvironmentId(v.environment_id);
  setNEnvironmentLabel(v.environment_label);
  setNEnvironmentDetail(v.environment_detail);
  setNEnvironmentCls(v.environment_cls);
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
  setNPadPs5Cls(v.pad_ps5_cls);
  setNPadSwitchProCls(v.pad_switchpro_cls);
  setNPadXboxSeriesCls(v.pad_xboxseries_cls);
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
  setNKbMoreCls(v.kb_more_cls);
  // The DRAFT wins over the payload: a 2 s poll must never wipe an edit
  // nobody has saved yet. Everything else on the page keeps refreshing.
  if (!macDirty) {
    applyMacView(v.mac);
    seedMacDraft(p);
  }
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
  // cached node lists re-query on the next frame and the filter re-applies
  // — a fresh row arrives without the imperative `.hide` class its
  // predecessor carried.
  liveKeyNodes = null;
  liveFnNodes = null;
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
    if (assignKey) markAssignTargets(assignKey);
  }
  lastBindView = v;
  reconcileBindingActionAuthority();
  refreshInspectorCopy();
  if (learnRoot) {
    reconcileKeyboardWorkbenchIdentity();
    reconcileControlSurfaceIdentity();
    syncPadWidgets();
    syncMappingFlow();
    // Reorders move controllers between seats: the identity colors, the
    // mute classes and the legend follow their presets to the new numbers.
    pruneHiddenStrips();
    applySlotColors();
    applyNocturneUi();
    syncBoardFilter();
    applyInspectorContextRows(learnRoot);
  }
  const pendingMacroFocus = focusMacroOnNextPayload;
  if (
    pendingMacroFocus &&
    macroDialogOpen() &&
    nMacSlot() === pendingMacroFocus.slot &&
    nMacName().localeCompare(pendingMacroFocus.macro, undefined, { sensitivity: "accent" }) === 0
  ) {
    focusMacroOnNextPayload = null;
    focusDialog(false);
  } else if (pendingMacroFocus && !macroDialogOpen()) {
    // The link can disappear between paint and the confirming read (another
    // writer renamed or removed the macro). Settle the enhanced navigation
    // truthfully instead of leaving a dead ?macro= URL and a focus promise
    // that can never complete.
    focusMacroOnNextPayload = null;
    mergeQuery({ macro: null });
    keyboardWorkbenchAnnounce(`Macro “${pendingMacroFocus.macro}” is no longer available.`);
    restoreDialogFocus();
  }
  if (restoreMacroFocusOnNextPayload && !macroDialogOpen()) {
    restoreMacroFocusOnNextPayload = false;
    restoreDialogFocus();
  } else if (previouslyOpenMacro && !macroDialogOpen()) {
    // An ordinary poll can reveal that another writer removed or renamed the
    // macro currently open. Treat that as a settled navigation boundary too:
    // clear the now-dead query and return focus instead of dropping it on body.
    mergeQuery({ macro: null });
    keyboardWorkbenchAnnounce(
      `Macro “${previouslyOpenMacro.macro}” is no longer available.`,
    );
    restoreDialogFocus();
  }
}

/** The last applied view, for the canvas dressers (`syncPadWidgets`,
 *  `persistCanvas`) after the island mounts — the seed applies BEFORE
 *  `learnRoot` exists, and an idle page's deduped polls never re-apply.
 *  (The old `paintStageCallouts` died with the pad grid: it dressed the
 *  display:none masters, which nobody sees — each widget CLONE is dressed
 *  from its own slot's table inside `syncPadWidgets`.) */
let lastBindView: NocturneView | null = null;

// ── THE CANVAS (genui) ─────────────────────────────────────────────────────────
// The center is a real pan/zoom canvas (the vendored forma-genui-runtime
// engine, studio-ui/src/genui/) and the keyboard and every staged controller
// are WIDGETS on it. The keyboard widget is SSR markup the engine ADOPTS
// (mountItem takes the served article; the engine's geometry writes ride the
// parity contract's client-canvas exemption); the controller widgets are
// client-built from the payload roster — the padgrid precedent made
// contractual (data-client-widget). Geometry is browser-kept like every
// other chrome preference: keyed by PRESET (the color-store lesson — seats
// renumber, identity travels), loaded before the engine mounts, saved on the
// engine's own durable commits.
const CANVAS_STORE = "ksx-nocturne-canvas";
const DS4_VARIANT_STORE = "ksx-nocturne-ds4-variants1";
const DS4_VARIANT_SLUGS = new Set<string>(DS4_PREMIUM_VARIANTS.map((variant) => variant.slug));
let ds4Variants: Record<string, Ds4PremiumVariantSlug> = {};
const CONTROLLER_FINISH_STORE = "ksx-nocturne-controller-finishes1";

type PremiumControllerFamily = "ps5" | "switchpro" | "xboxseries";
type PremiumControllerVariantSlug =
  | DualSensePremiumVariantSlug
  | SwitchProPremiumVariantSlug
  | XboxSeriesPremiumVariantSlug;
type PremiumControllerVariant = {
  readonly slug: PremiumControllerVariantSlug;
  readonly label: string;
  readonly swatch: string;
  readonly gradient: string;
  readonly tones: Readonly<Record<string, string>>;
};
type PremiumControllerConfig = {
  readonly label: string;
  readonly selector: string;
  readonly variantAttribute: string;
  readonly shellTone: string;
  readonly variants: readonly PremiumControllerVariant[];
};

const PREMIUM_CONTROLLER_CONFIGS: Record<PremiumControllerFamily, PremiumControllerConfig> = {
  ps5: {
    label: "DualSense",
    selector: "svg.dualsensepremium",
    variantAttribute: "data-dualsense-variant",
    shellTone: DUALSENSE_PREMIUM_SHELL_TONE,
    variants: DUALSENSE_PREMIUM_VARIANTS,
  },
  switchpro: {
    label: "Switch Pro",
    selector: "svg.switchpropremium",
    variantAttribute: "data-switchpro-variant",
    shellTone: SWITCH_PRO_PREMIUM_SHELL_TONE,
    variants: SWITCH_PRO_PREMIUM_VARIANTS,
  },
  xboxseries: {
    label: "Xbox Series",
    selector: "svg.xboxseriespremium",
    variantAttribute: "data-xboxseries-variant",
    shellTone: XBOX_SERIES_PREMIUM_SHELL_TONE,
    variants: XBOX_SERIES_PREMIUM_VARIANTS,
  },
};

let controllerFinishes: Record<string, PremiumControllerVariantSlug> = {};

/** One press of canvas zoom. The engine's own wheel step is finer; a button
 *  press should be a visible move, not a nudge. */
const CANVAS_ZOOM_STEP = 1.2;

/** Hardware programming is a long form. Fitting all 56 terminal rows at once
 * turns safety-critical labels and diffs into a miniature, so focused setup
 * starts readable and lets the canvas pan through the remainder. */
const PANEL_PROGRAMMING_MIN_CAMERA_ZOOM = 0.68;

const PANEL_PROGRAMMING_FOCUS_OPTIONS = {
  minimumZoom: PANEL_PROGRAMMING_MIN_CAMERA_ZOOM,
  oversizedAlignment: "start" as const,
};

/** The runaway rail for widgets — NOT a workspace edge, and not a camera
 *  limit (the view pans freely, the way every canvas tool in this shape
 *  works). It exists only so a widget cannot be flung somewhere nothing can
 *  reach; you should never meet it by dragging.
 *
 *  ⚠️Its ORIGIN is the part that matters. A bound starting at (0, 0) put a
 *  wall 140px above the tidied board — an invisible wall in the middle of an
 *  empty canvas, which is indistinguishable from a bug. It reaches far into
 *  the negative on both axes now, and Fit / Tidy / the map are what actually
 *  bring a stray widget home. */
const CANVAS_WORLD = { x: -8000, y: -8000, width: 20000, height: 20000 };

interface CanvasItemGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

interface CanvasProcessorOffset {
  x: number;
  y: number;
}

interface CanvasPrefs {
  camera?: { panX: number; panY: number; zoom: number };
  widgets: Record<string, CanvasItemGeometry>;
  /** The map is chrome, so it remembers like every other chrome preference.
   *  Absent means shown. */
  mapHidden?: boolean;
  /** A supplementary graph lens over the canonical mapping tables. */
  mappingPaths?: MappingPathMode;
  /** User-pinned macro processor displacement in canvas world coordinates. */
  processorOffsets?: Record<string, CanvasProcessorOffset>;
}

let canvasPrefs: CanvasPrefs = { widgets: {} };
const sessionProcessorOffsets = Object.create(null) as Record<
  string,
  CanvasProcessorOffset | null
>;
let nCanvas: WidgetCanvas | null = null;
let mappingFlowLayer: MappingFlowLayer | null = null;
let pendingMappingFlowAnnouncement: {
  mode: MappingPathMode;
  selectedSlot: number;
} | null = null;
let padWidgetPrint = "";
let padRosterInitialized = false;
const padItems = new Map<number, HTMLElement>();
let keyboardWorkbenchStore: KeyboardWorkbenchStore = {
  version: KEYBOARD_WORKBENCH_STORE_VERSION,
  devices: {},
};
let keyboardWorkbenchState = cloneKeyboardWorkbenchState(DEFAULT_KEYBOARD_WORKBENCH_STATE);
let keyboardWorkbenchIdentity = canonicalKeyboardDeviceIdentity("");
let keyboardWorkbenchLastSelector = "";
let keyboardWorkbenchItem: HTMLElement | null = null;
let keyboardWorkbenchItemIdentity = "";
let keyboardWorkbenchSelectedKey = "";
let keyboardWorkbenchSelectedToken = "";
let keyboardSourceItem: HTMLElement | null = null;
let keyboardSourceGeometry: CanvasItemGeometry | null = null;
let keyboardWorkbenchDrag: {
  pointerId: number;
  key: string;
  token: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  scaleX: number;
  scaleY: number;
  moved: boolean;
} | null = null;
let controlSurfaceStore: ControlSurfaceStore = {
  version: CONTROL_SURFACE_STORE_VERSION,
  devices: {},
  migratedWorkbench: {},
  hardwareEpochs: {},
};
const CONTROL_SURFACE_HARDWARE_EPOCH_STORAGE_PREFIX =
  "ksx-nocturne-control-surface-hardware-epoch2:";
const CONTROL_SURFACE_HARDWARE_EPOCH_VERSION = 2 as const;
const CONTROL_SURFACE_HARDWARE_EPOCH_DEVICE_LIMIT = 64;
let controlSurfaceStorageSyncInstalled = false;
/** Epochs actually consumed by this document's in-memory surface. Keep this
 * separate from incoming localStorage: a stale whole-store event is data to
 * reconcile, never proof that this tab already retired its own observations. */
let controlSurfaceState = cloneControlSurfaceState(DEFAULT_CONTROL_SURFACE_STATE);
let controlSurfaceIdentity = canonicalKeyboardDeviceIdentity("");
let controlSurfaceItem: HTMLElement | null = null;
let controlSurfaceItemIdentity = "";
let controlSurfaceChoosingTemplate = false;
let controlSurfacePendingTemplate: ControlSurfaceTemplate | null = null;
let controlSurfaceUndoState: ControlSurfaceState | null = null;
let controlSurfaceUndoIdentity = "";
let controlSurfaceUndoAfterFingerprint = "";
let controlSurfaceReturnFocus: HTMLElement | null = null;
let controlSurfaceInspectorPrint = "";
let controlSurfaceSaveFailed = false;
const PANEL_RECOVERY_PROBE_RETRY_DELAYS_MS = [750, 1500] as const;
let controlSurfaceDrag: {
  pointerId: number;
  controlId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  scaleX: number;
  scaleY: number;
  moved: boolean;
} | null = null;

/** Where the board and the first pads land with an empty store: keyboard
 *  low, controllers in a row above — a deliberate opening arrangement, not
 *  the engine's generic staircase. */
const KB_HOME: CanvasItemGeometry = { x: 90, y: 540, width: 980, height: 360, z: 1, manualScale: 1 };
function padHome(index: number): CanvasItemGeometry {
  return {
    x: 90 + (index % 3) * 480,
    y: 60 + Math.floor(index / 3) * 460,
    width: 440,
    height: 400,
    z: 2 + index,
    manualScale: 1,
  };
}

function isGeometry(g: unknown): g is CanvasItemGeometry {
  const v = g as CanvasItemGeometry;
  return (
    typeof v === "object" && v !== null &&
    [v.x, v.y, v.width, v.height, v.z, v.manualScale].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  );
}

function isProcessorOffset(value: unknown): value is CanvasProcessorOffset {
  const offset = value as CanvasProcessorOffset;
  return (
    typeof offset === "object" && offset !== null &&
    Number.isFinite(offset.x) && Number.isFinite(offset.y) &&
    Math.abs(offset.x) <= CANVAS_WORLD.width &&
    Math.abs(offset.y) <= CANVAS_WORLD.height
  );
}

function cleanProcessorOffsets(value: unknown): Record<string, CanvasProcessorOffset> {
  const clean = Object.create(null) as Record<string, CanvasProcessorOffset>;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return clean;
  for (const [processorId, candidate] of Object.entries(value)) {
    if (
      !processorId || processorId === "__proto__" ||
      processorId === "constructor" || processorId === "prototype" ||
      !isProcessorOffset(candidate)
    ) {
      continue;
    }
    clean[processorId] = { x: candidate.x, y: candidate.y };
  }
  return clean;
}

function loadCanvasPrefs(): void {
  try {
    const raw = window.localStorage.getItem(CANVAS_STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as CanvasPrefs;
    const widgets: Record<string, CanvasItemGeometry> = {};
    for (const [key, g] of Object.entries(saved.widgets ?? {})) {
      if (isGeometry(g)) widgets[key] = g;
    }
    const cam = saved.camera;
    const processorOffsets = cleanProcessorOffsets(saved.processorOffsets);
    canvasPrefs = {
      widgets,
      mapHidden: saved.mapHidden === true,
      mappingPaths: mappingPathModeIsValid(saved.mappingPaths) ? saved.mappingPaths : "off",
      processorOffsets,
      camera:
        cam &&
        [cam.panX, cam.panY, cam.zoom].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
          ? { panX: cam.panX, panY: cam.panY, zoom: Math.min(2, Math.max(0.2, cam.zoom)) }
          : undefined,
    };
  } catch {
    // A blocked or corrupt store reads as the defaults.
  }
}

function writeCanvasPrefs(next: CanvasPrefs): boolean {
  try {
    window.localStorage.setItem(CANVAS_STORE, JSON.stringify(next));
    return true;
  } catch {
    // The arrangement simply will not survive this session.
    return false;
  }
}

function saveCanvasPrefs(): boolean {
  return writeCanvasPrefs(canvasPrefs);
}

function getProcessorOffset(
  processorId: string,
): CanvasProcessorOffset | null | undefined {
  if (Object.prototype.hasOwnProperty.call(sessionProcessorOffsets, processorId)) {
    const sessionOffset = sessionProcessorOffsets[processorId];
    return sessionOffset ? { x: sessionOffset.x, y: sessionOffset.y } : null;
  }
  const offset = canvasPrefs.processorOffsets?.[processorId];
  return isProcessorOffset(offset) ? { x: offset.x, y: offset.y } : undefined;
}

function processorOffsetIsSessionOnly(processorId: string): boolean {
  return Object.prototype.hasOwnProperty.call(sessionProcessorOffsets, processorId) &&
    sessionProcessorOffsets[processorId] !== null;
}

function commitProcessorOffset(
  processorId: string,
  offset: CanvasProcessorOffset,
): boolean {
  if (
    !processorId || processorId === "__proto__" ||
    processorId === "constructor" || processorId === "prototype" ||
    !isProcessorOffset(offset)
  ) {
    return false;
  }
  sessionProcessorOffsets[processorId] = { x: offset.x, y: offset.y };
  const next: CanvasPrefs = {
    ...canvasPrefs,
    processorOffsets: {
      ...(canvasPrefs.processorOffsets ?? {}),
      [processorId]: { x: offset.x, y: offset.y },
    },
  };
  if (!writeCanvasPrefs(next)) return false;
  canvasPrefs = next;
  delete sessionProcessorOffsets[processorId];
  return true;
}

function removeProcessorOffset(processorId: string): boolean {
  const offsets = canvasPrefs.processorOffsets;
  sessionProcessorOffsets[processorId] = null;
  const nextOffsets = { ...(offsets ?? {}) };
  delete nextOffsets[processorId];
  const next: CanvasPrefs = {
    ...canvasPrefs,
    processorOffsets: Object.keys(nextOffsets).length > 0 ? nextOffsets : undefined,
  };
  if (!writeCanvasPrefs(next)) return false;
  canvasPrefs = next;
  delete sessionProcessorOffsets[processorId];
  return true;
}

function loadDs4Variants(): void {
  try {
    const raw = window.localStorage.getItem(DS4_VARIANT_STORE);
    const saved = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const clean: Record<string, Ds4PremiumVariantSlug> = {};
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === "string" && DS4_VARIANT_SLUGS.has(value)) {
        clean[key] = value as Ds4PremiumVariantSlug;
      }
    }
    ds4Variants = clean;
  } catch {
    ds4Variants = {};
  }
}

function saveDs4Variants(): void {
  try {
    window.localStorage.setItem(DS4_VARIANT_STORE, JSON.stringify(ds4Variants));
  } catch {
    // A controller finish is chrome; blocked storage only makes it temporary.
  }
}

/** Repaint one clone through the four source-authored color palettes. The
 *  geometry never changes: every finish writes the same ten CSS paint tones,
 *  with only the main shell upgraded to the shared Studio gradient server. */
function applyDs4Variant(
  svg: SVGSVGElement,
  controls: HTMLElement,
  storeKey: string,
  slug: Ds4PremiumVariantSlug,
  persist: boolean,
): void {
  const variant = DS4_PREMIUM_VARIANTS.find((item) => item.slug === slug) ?? DS4_PREMIUM_VARIANTS[0];
  for (const [name, value] of Object.entries(variant.tones)) svg.style.setProperty(name, value);
  svg.style.setProperty(DS4_PREMIUM_SHELL_TONE, `url(#${variant.gradient})`);
  svg.dataset.ds4Variant = variant.slug;
  for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("button[data-ds4-variant]"))) {
    button.setAttribute("aria-pressed", String(button.dataset.ds4Variant === variant.slug));
  }
  if (persist) {
    ds4Variants[storeKey] = variant.slug;
    saveDs4Variants();
  }
}

function premiumControllerConfig(family: string): PremiumControllerConfig | null {
  return Object.prototype.hasOwnProperty.call(PREMIUM_CONTROLLER_CONFIGS, family)
    ? PREMIUM_CONTROLLER_CONFIGS[family as PremiumControllerFamily]
    : null;
}

function controllerFinishKey(family: PremiumControllerFamily, storeKey: string): string {
  return family + ":" + storeKey;
}

function loadControllerFinishes(): void {
  try {
    const raw = window.localStorage.getItem(CONTROLLER_FINISH_STORE);
    const saved = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const clean: Record<string, PremiumControllerVariantSlug> = {};
    for (const [key, value] of Object.entries(saved)) {
      const separator = key.indexOf(":");
      const family = separator > 0 ? key.slice(0, separator) : "";
      const config = premiumControllerConfig(family);
      if (config && typeof value === "string" && config.variants.some((variant) => variant.slug === value)) {
        clean[key] = value as PremiumControllerVariantSlug;
      }
    }
    controllerFinishes = clean;
  } catch {
    controllerFinishes = {};
  }
}

function saveControllerFinishes(): void {
  try {
    window.localStorage.setItem(CONTROLLER_FINISH_STORE, JSON.stringify(controllerFinishes));
  } catch {
    // A finish is visual chrome; blocked storage only makes it temporary.
  }
}

// ── KEYBOARD MATERIAL + CONTROL-SURFACE WORKBENCH ────────────────────────
// The daemon owns key identity and bindings. This browser-kept model owns
// only presentation and placement: a pulled cap is a linked visual clone of
// the same canonical key, never a second binding or a reparented served node.

function currentKeyboardWorkbenchIdentity(): string {
  const selector = nCapSelector().trim();
  const title = nKbTitle().trim();
  if (selector) {
    keyboardWorkbenchLastSelector = selector;
    return canonicalKeyboardDeviceIdentity("keyboard:" + selector);
  }
  // The server deliberately clears cap_selector when its staged read is
  // unavailable. Its title then becomes an error sentence, not a different
  // keyboard: keep the last concrete selector through that transient state.
  if (keyboardWorkbenchLastSelector && !title.startsWith("No keyboard selected")) {
    return canonicalKeyboardDeviceIdentity("keyboard:" + keyboardWorkbenchLastSelector);
  }
  if (title.startsWith("No keyboard selected")) keyboardWorkbenchLastSelector = "";
  return canonicalKeyboardDeviceIdentity("keyboard:" + (title || "default"));
}

function saveKeyboardWorkbenchPrefs(): void {
  keyboardWorkbenchStore = withKeyboardWorkbenchState(
    keyboardWorkbenchStore,
    keyboardWorkbenchIdentity,
    keyboardWorkbenchState,
  );
  try {
    window.localStorage.setItem(
      KEYBOARD_WORKBENCH_STORAGE_KEY,
      JSON.stringify(keyboardWorkbenchStore),
    );
  } catch {
    // A material/layout preference may remain session-only when storage is blocked.
  }
}

function applyKeyboardWorkbenchState(
  state: KeyboardWorkbenchState,
  persist: boolean,
  reveal = false,
): void {
  keyboardWorkbenchState = cloneKeyboardWorkbenchState(state);
  setNKeyboardTheme(keyboardWorkbenchState.theme);
  setNKeyboardCapProfile(keyboardWorkbenchState.capProfile);
  setNKeyboardWorkbenchOpen(keyboardWorkbenchState.open);
  setNKbtCarbonPressed(String(keyboardWorkbenchState.theme === "carbon-forge"));
  setNKbtLunarPressed(String(keyboardWorkbenchState.theme === "lunar-shell"));
  setNKbtVioletPressed(String(keyboardWorkbenchState.theme === "violet-circuit"));
  setNKbtGlacierPressed(String(keyboardWorkbenchState.theme === "glacier-current"));
  setNKbtMintPressed(String(keyboardWorkbenchState.theme === "ghost-mint"));
  setNKbtRetroPressed(String(keyboardWorkbenchState.theme === "retro-terminal"));
  setNKbWorkbenchPressed(String(keyboardWorkbenchState.open));
  if (persist) saveKeyboardWorkbenchPrefs();
  syncKeyboardSourceVisibility(reveal);
  syncKeyboardSourceCaps();
  syncKeyboardWorkbenchWidget(reveal);
}

function reconcileKeyboardWorkbenchSelection(
  state: KeyboardWorkbenchState,
): { state: KeyboardWorkbenchState; changed: boolean } {
  const records = keyboardWorkbenchRecords();
  // An unavailable payload proves nothing about which saved keys still
  // exist. Preserve the board until a real canonical-key roster answers.
  if (records.length === 0) return { state, changed: false };
  const known = new Set(records.map((record) => record.key));
  const selectedKeys = state.selectedKeys.filter((key) => known.has(key));
  const selected = new Set(selectedKeys);
  if (keyboardWorkbenchSelectedKey && !selected.has(keyboardWorkbenchSelectedKey)) {
    keyboardWorkbenchSelectedKey = "";
    keyboardWorkbenchSelectedToken = "";
  }
  const changed = selectedKeys.length !== state.selectedKeys.length;
  return { state: changed ? { ...state, selectedKeys } : state, changed };
}

function loadKeyboardWorkbenchPrefs(): void {
  try {
    keyboardWorkbenchStore = sanitizeKeyboardWorkbenchStore(
      window.localStorage.getItem(KEYBOARD_WORKBENCH_STORAGE_KEY),
    );
  } catch {
    keyboardWorkbenchStore = {
      version: KEYBOARD_WORKBENCH_STORE_VERSION,
      devices: {},
    };
  }
  keyboardWorkbenchIdentity = currentKeyboardWorkbenchIdentity();
  const reconciled = reconcileKeyboardWorkbenchSelection(
    keyboardWorkbenchStateForDevice(keyboardWorkbenchStore, keyboardWorkbenchIdentity),
  );
  applyKeyboardWorkbenchState(reconciled.state, reconciled.changed);
}

/** A different physical keyboard gets its own finish and loose-cap board. */
function reconcileKeyboardWorkbenchIdentity(): void {
  const identity = currentKeyboardWorkbenchIdentity();
  if (identity !== keyboardWorkbenchIdentity) {
    keyboardWorkbenchIdentity = identity;
    keyboardWorkbenchSelectedKey = "";
    keyboardWorkbenchSelectedToken = "";
    const reconciled = reconcileKeyboardWorkbenchSelection(
      keyboardWorkbenchStateForDevice(keyboardWorkbenchStore, identity),
    );
    applyKeyboardWorkbenchState(reconciled.state, reconciled.changed);
    return;
  }
  // Poll reconciliation can replace or remove keys. Keep selections whose
  // canonical source still exists, but never erase a saved board merely
  // because an unreachable/empty payload arrived.
  const reconciled = reconcileKeyboardWorkbenchSelection(keyboardWorkbenchState);
  if (reconciled.changed) {
    applyKeyboardWorkbenchState(reconciled.state, true);
  } else {
    syncKeyboardSourceCaps();
    syncKeyboardWorkbenchWidget(false);
  }
}

function chooseKeyboardTheme(value: string): void {
  if (!keyboardThemeIsValid(value) || value === keyboardWorkbenchState.theme) return;
  applyKeyboardWorkbenchState({ ...keyboardWorkbenchState, theme: value }, true);
  // A panel starts from the selected hardware's material palette. Its
  // component identities and player colors remain separate layers.
  if (controlSurfaceIdentity === keyboardWorkbenchIdentity) {
    applyControlSurfaceState({ ...controlSurfaceState, theme: value }, true);
  }
}

function chooseKeyboardCapProfile(value: string): void {
  if (!keyboardCapProfileIsValid(value) || value === keyboardWorkbenchState.capProfile) return;
  applyKeyboardWorkbenchState({ ...keyboardWorkbenchState, capProfile: value }, true);
  keyboardWorkbenchAnnounce(`${KEYBOARD_CAP_PROFILES.find((profile) => profile.slug === value)?.label ?? value} keycaps applied.`);
}

function keyboardWorkbenchAnnounce(message: string): void {
  const sr = learnRoot?.querySelector<HTMLElement>(".n-live-sr");
  if (sr) sr.textContent = message;
}
interface NocturneInputTestView {
  ok: boolean;
  state: "idle" | "listening" | "timeout" | "cancelled" | "failed" | "unavailable" | "unknown";
  generation: number | null;
  selector: string | null;
  remaining_ms: number | null;
  held: string[];
  seen: string[];
  peak: number;
  events: number;
  dropped: number;
  rollover_visibility: string;
  detail: string;
  error: string | null;
  code?: string | null;
}

const INPUT_TEST_DURATION_MS = 30_000;
const INPUT_TEST_POLL_MS = 80;
let inputTestDialog: HTMLDialogElement | null = null;
let inputTestReturnFocus: HTMLElement | null = null;
let inputTestView: NocturneInputTestView | null = null;
let inputTestTimer: number | undefined;
let inputTestRequest = 0;
let inputTestSelector = "";
let inputTestSourceName = "Selected input";
let inputTestExpectedCount = 0;
let inputTestStarting = false;
let inputTestRecovering = false;

function inputTestState(value: unknown): NocturneInputTestView["state"] {
  switch (value) {
    case "idle":
    case "listening":
    case "timeout":
    case "cancelled":
    case "failed":
    case "unavailable":
      return value;
    default:
      return "unknown";
  }
}

async function inputTestJSON(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<NocturneInputTestView> {
  const response = await fetch(url, {
    method,
    headers: method === "POST"
      ? { Accept: "application/json", "Content-Type": "application/json" }
      : { Accept: "application/json" },
    cache: "no-store",
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const payload = await response.json().catch(() => null) as NocturneInputTestView | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Input test returned HTTP ${response.status}.`);
  }
  return { ...payload, state: inputTestState(payload.state) };
}

function appendInputTestSignals(container: HTMLElement, keys: readonly string[]): void {
  const document_ = container.ownerDocument;
  const signals = keys.map((key) => ({ key, terminals: [] as string[] }));
  const fingerprint = JSON.stringify(signals);
  if (container.dataset.inputTestFingerprint === fingerprint) return;
  container.dataset.inputTestFingerprint = fingerprint;
  if (signals.length === 0) {
    const empty = document_.createElement("span");
    empty.className = "n-input-test-empty";
    empty.textContent = "None";
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...signals.map(({ key, terminals }) => {
    const chip = document_.createElement("span");
    chip.className = "n-input-test-key";
    const label = document_.createElement("strong");
    label.textContent = key;
    if (terminals.length > 0) {
      const terminal = document_.createElement("small");
      terminal.textContent = terminals.join(" · ");
      chip.append(label, terminal);
    } else {
      chip.append(label);
    }
    return chip;
  }));
}

function ensureInputTestDialog(): HTMLDialogElement {
  if (inputTestDialog?.isConnected) return inputTestDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "n-input-test-dialog";
  dialog.setAttribute("aria-labelledby", "n-input-test-title");
  const shell = document.createElement("article");
  const head = document.createElement("header");
  const heading = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.textContent = "Signal diagnostic";
  const title = document.createElement("h2");
  title.id = "n-input-test-title";
  title.textContent = "Simultaneous input test";
  const source = document.createElement("p");
  source.dataset.inputTestSource = "";
  heading.append(kicker, title, source);
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.inputTestAction = "close";
  close.setAttribute("aria-label", "Close simultaneous input test");
  close.textContent = "×";
  head.append(heading, close);

  const intro = document.createElement("p");
  intro.className = "n-input-test-intro";
  intro.textContent =
    "Release every control first. Start, then press and hold the real combination you need. KSX reports only distinct host signals it actually observes; two controls or encoder terminals assigned to the same key are indistinguishable here. This test does not infer NKRO or a hardware limit.";
  const expectedLabel = document.createElement("label");
  expectedLabel.className = "n-input-test-expected";
  const expectedText = document.createElement("span");
  expectedText.textContent = "Expected distinct host signals held together (optional)";
  const expected = document.createElement("input");
  expected.type = "number";
  expected.min = "1";
  expected.max = "128";
  expected.inputMode = "numeric";
  expected.dataset.inputTestExpected = "";
  expected.addEventListener("input", () => {
    const value = Number(expected.value);
    inputTestExpectedCount = Number.isInteger(value) && value > 0 ? Math.min(value, 128) : 0;
    renderInputTestDialog();
  });
  expectedLabel.append(expectedText, expected);

  const stats = document.createElement("dl");
  stats.className = "n-input-test-stats";
  for (const [name, label] of [
    ["held", "Distinct held now"],
    ["peak", "Peak distinct signals"],
    ["seen", "Distinct signals seen"],
    ["events", "Events"],
    ["dropped", "Dropped"],
  ] as const) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.dataset.inputTestStat = name;
    dd.textContent = "0";
    row.append(dt, dd);
    stats.append(row);
  }

  const heldLabel = document.createElement("strong");
  heldLabel.className = "n-input-test-section-label";
  heldLabel.textContent = "Held host signals";
  const held = document.createElement("div");
  held.className = "n-input-test-signals held";
  held.dataset.inputTestHeld = "";
  held.setAttribute("role", "status");
  held.setAttribute("aria-live", "polite");
  const seenLabel = document.createElement("strong");
  seenLabel.className = "n-input-test-section-label";
  seenLabel.textContent = "Seen during this run";
  const seen = document.createElement("div");
  seen.className = "n-input-test-signals";
  seen.dataset.inputTestSeen = "";
  const detail = document.createElement("p");
  detail.className = "n-input-test-detail";
  detail.dataset.inputTestDetail = "";
  detail.setAttribute("role", "status");
  const detailMessage = document.createElement("span");
  detailMessage.dataset.inputTestDetailMessage = "";
  const detailRemaining = document.createElement("span");
  detailRemaining.dataset.inputTestDetailRemaining = "";
  detailRemaining.setAttribute("aria-hidden", "true");
  detail.append(detailMessage, detailRemaining);
  const evidence = document.createElement("p");
  evidence.className = "n-input-test-evidence";
  evidence.dataset.inputTestEvidence = "";

  const actions = document.createElement("footer");
  const start = document.createElement("button");
  start.type = "button";
  start.className = "primary";
  start.dataset.inputTestAction = "start";
  start.textContent = "Start 30-second test";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.dataset.inputTestAction = "stop";
  stop.textContent = "Stop test";
  stop.hidden = true;
  actions.append(start, stop);
  shell.append(
    head,
    intro,
    expectedLabel,
    stats,
    heldLabel,
    held,
    seenLabel,
    seen,
    detail,
    evidence,
    actions,
  );
  dialog.append(shell);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void closeInputTest();
  });
  dialog.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement | null)
      ?.closest<HTMLElement>("[data-input-test-action]")?.dataset.inputTestAction;
    if (action === "start") void startInputTest();
    else if (action === "stop") void stopInputTest();
    else if (action === "close") void closeInputTest();
  });
  document.body.append(dialog);
  inputTestDialog = dialog;
  renderInputTestDialog();
  return dialog;
}

function renderInputTestDialog(): void {
  const dialog = inputTestDialog;
  if (!dialog) return;
  const view = inputTestView;
  const listening = view?.state === "listening";
  const unknownAttempt = view?.state === "unknown" && view.generation !== null;
  const foreignAttempt = view?.code === "busy-other";
  const interactionBusy = listening || unknownAttempt || foreignAttempt ||
    inputTestStarting || inputTestRecovering;
  dialog.dataset.state = view?.state ?? "idle";
  dialog.setAttribute("aria-busy", String(inputTestStarting || inputTestRecovering));
  const source = dialog.querySelector<HTMLElement>("[data-input-test-source]");
  if (source) source.textContent = `${inputTestSourceName} · ${inputTestSelector || "No exact source"}`;
  const value = (name: string, text: string): void => {
    const node = dialog.querySelector<HTMLElement>(`[data-input-test-stat="${name}"]`);
    if (node) node.textContent = text;
  };
  value("held", String(view?.held.length ?? 0));
  value("peak", String(view?.peak ?? 0));
  value("seen", String(view?.seen.length ?? 0));
  value("events", String(view?.events ?? 0));
  value("dropped", String(view?.dropped ?? 0));
  const held = dialog.querySelector<HTMLElement>("[data-input-test-held]");
  const seen = dialog.querySelector<HTMLElement>("[data-input-test-seen]");
  if (held) appendInputTestSignals(held, view?.held ?? []);
  if (seen) appendInputTestSignals(seen, view?.seen ?? []);
  const detailMessage = dialog.querySelector<HTMLElement>("[data-input-test-detail-message]");
  const detailRemaining = dialog.querySelector<HTMLElement>("[data-input-test-detail-remaining]");
  if (detailMessage) {
    const message = view?.error || (view?.state === "unknown"
      ? "KSX returned an input-test state this Studio build cannot interpret. Stop this run and try again after Studio and the daemon are on the same version."
      : view?.detail) ||
      "Ready. Release all controls, then start when the device is neutral.";
    if (detailMessage.textContent !== message) detailMessage.textContent = message;
  }
  if (detailRemaining) {
    const remaining = listening && view?.remaining_ms !== null
      ? ` · ${Math.max(0, Math.ceil((view?.remaining_ms ?? 0) / 1000))}s remaining`
      : "";
    if (detailRemaining.textContent !== remaining) detailRemaining.textContent = remaining;
  }
  const evidence = dialog.querySelector<HTMLElement>("[data-input-test-evidence]");
  if (evidence) {
    const shortfall = inputTestExpectedCount > 0 && (view?.peak ?? 0) < inputTestExpectedCount;
    const dropped = (view?.dropped ?? 0) > 0;
    evidence.dataset.tone = view?.state === "failed" || view?.state === "unavailable" ||
        view?.state === "unknown" || shortfall || dropped
      ? "warning"
      : "neutral";
    evidence.textContent = dropped && view
      ? `KSX dropped ${view.dropped} input ${view.dropped === 1 ? "event" : "events"} before reduction. This run is incomplete; repeat it before judging the device.`
      : view?.state === "unknown"
      ? "This diagnostic state is unknown, so KSX cannot treat its counts as a completed result."
      : shortfall && view && !listening
      ? `KSX observed ${view.peak} distinct host ${view.peak === 1 ? "signal" : "signals"} held together, below the expected ${inputTestExpectedCount}. Two controls assigned to one key collapse to one signal. This is evidence of the end-to-end path, not proof of the device's electrical or USB limit.`
      : view
      ? `Observed peak: ${view.peak} distinct KSX-readable host ${view.peak === 1 ? "signal" : "signals"}. Rollover visibility: ${view.rollover_visibility || "unavailable"}. Duplicate terminal key assignments collapse to one signal, and missing presses can be silent on keyboard transports.`
      : "Avoid Windows, Alt+Tab, and other system shortcuts during an ordinary-keyboard test; observation does not suppress them.";
  }
  const expected = dialog.querySelector<HTMLInputElement>("[data-input-test-expected]");
  if (expected) expected.disabled = interactionBusy;
  const start = dialog.querySelector<HTMLButtonElement>('[data-input-test-action="start"]');
  const stop = dialog.querySelector<HTMLButtonElement>('[data-input-test-action="stop"]');
  if (start) {
    start.disabled = interactionBusy || !inputTestSelector;
    start.textContent = inputTestRecovering
      ? "Checking current test…"
      : inputTestStarting
      ? "Starting…"
      : view && !listening
      ? "Run again"
      : "Start 30-second test";
  }
  if (stop) stop.hidden = !listening && !unknownAttempt;
}

function scheduleInputTestPoll(request: number, generation: number): void {
  if (inputTestTimer !== undefined) window.clearTimeout(inputTestTimer);
  inputTestTimer = window.setTimeout(() => {
    inputTestTimer = undefined;
    void pollInputTest(request, generation);
  }, INPUT_TEST_POLL_MS);
}

async function pollInputTest(request: number, generation: number): Promise<void> {
  try {
    const view = await inputTestJSON("/api/input-test", "GET");
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    if (view.generation !== generation) {
      inputTestView = {
        ...view,
        ok: false,
        state: "failed",
        error: "Another window or diagnostic replaced this input test. Start again to use the current selected device.",
      };
      renderInputTestDialog();
      return;
    }
    inputTestView = view;
    renderInputTestDialog();
    if (view.state === "listening") scheduleInputTestPoll(request, generation);
  } catch (error) {
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    const lastKnown = inputTestView;
    inputTestView = {
      ...(lastKnown ?? {
        held: [],
        seen: [],
        peak: 0,
        events: 0,
        dropped: 0,
        rollover_visibility: "unavailable",
        detail: "",
      }),
      ok: false,
      // The GET failed, not the daemon-owned observation. Keep the exact
      // generation visibly cancellable until Stop/Close reaches the daemon;
      // calling this terminal would strand the observer behind a hidden Stop.
      state: "unknown",
      generation,
      selector: inputTestSelector,
      remaining_ms: null,
      detail: "",
      error: `KSX lost contact with this running diagnostic. Stop the test or close this window to release its exact generation. ${
        error instanceof Error ? error.message : "The input test could not be polled."
      }`,
    };
    renderInputTestDialog();
  }
}

async function startInputTest(): Promise<void> {
  if (!inputTestSelector || inputTestView?.state === "listening" || inputTestStarting) return;
  const request = ++inputTestRequest;
  if (inputTestTimer !== undefined) window.clearTimeout(inputTestTimer);
  inputTestTimer = undefined;
  inputTestStarting = true;
  renderInputTestDialog();
  try {
    await cancelLearn();
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    const view = await inputTestJSON("/api/input-test/start", "POST", {
      selector: inputTestSelector,
      duration_ms: INPUT_TEST_DURATION_MS,
    });
    if (request !== inputTestRequest || !inputTestDialog?.open) {
      if (view.state === "listening" && view.generation !== null) {
        void inputTestJSON("/api/input-test/cancel", "POST", {
          generation: view.generation,
        }).catch(() => undefined);
      }
      return;
    }
    inputTestView = view;
    if (view.state === "listening") {
      if (view.generation === null) {
        inputTestView = {
          ...view,
          ok: false,
          state: "failed",
          error: "KSX began listening without a diagnostic generation. Restart Studio and the daemon, then try again.",
        };
      } else {
        scheduleInputTestPoll(request, view.generation);
      }
    }
  } catch (error) {
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    const startError = error instanceof Error ? error.message : "The input test could not start.";
    // Admission may have succeeded even when its HTTP response was lost. Ask
    // the daemon what it owns before making this look terminal; only the exact
    // requested source is safe to expose as a cancellable unknown attempt.
    try {
      const recovered = await inputTestJSON("/api/input-test", "GET");
      if (request !== inputTestRequest || !inputTestDialog?.open) return;
      if (recovered.state === "listening" && recovered.generation !== null &&
          recovered.selector === inputTestSelector) {
        inputTestView = {
          ...recovered,
          ok: false,
          state: "unknown",
          remaining_ms: null,
          error: `KSX could not confirm the start response, but the exact selected source still has a live diagnostic. Stop the test or close this window to release generation ${recovered.generation}. ${startError}`,
        };
        return;
      }
    } catch {
      // The original error remains the useful diagnosis. With no exact live
      // generation to prove, this client must not cancel another window's run.
    }
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    inputTestView = {
      ok: false,
      state: "failed",
      generation: null,
      selector: inputTestSelector,
      remaining_ms: null,
      held: [],
      seen: [],
      peak: 0,
      events: 0,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: "",
      error: startError,
    };
  } finally {
    if (request === inputTestRequest) inputTestStarting = false;
    renderInputTestDialog();
  }
}

async function stopInputTest(): Promise<void> {
  const generation = inputTestView?.generation ?? null;
  const cancellable = inputTestView?.state === "listening" || inputTestView?.state === "unknown";
  const request = ++inputTestRequest;
  if (inputTestTimer !== undefined) window.clearTimeout(inputTestTimer);
  inputTestTimer = undefined;
  if (generation === null || !cancellable) return;
  try {
    const view = await inputTestJSON("/api/input-test/cancel", "POST", { generation });
    if (request !== inputTestRequest) return;
    if (view.generation !== generation) {
      inputTestView = {
        ...view,
        ok: false,
        state: "unavailable",
        generation: null,
        remaining_ms: null,
        held: [],
        seen: [],
        peak: 0,
        events: 0,
        dropped: 0,
        code: "busy-other",
        error: `This diagnostic was replaced before its cancellation completed. The newer run${view.selector ? ` on ${view.selector}` : ""} belongs to another attempt, so this window will not stop it. Close and reopen the exact source to inspect current ownership.`,
      };
    } else {
      inputTestView = view;
    }
  } catch (error) {
    if (request !== inputTestRequest) return;
    inputTestView = inputTestView
      ? {
        ...inputTestView,
        ok: false,
        state: "unknown",
        error: `KSX could not confirm that generation ${generation} stopped. Retry Stop or close this window to release that same generation. ${
          error instanceof Error ? error.message : "The input test could not be stopped."
        }`,
      }
      : null;
  }
  renderInputTestDialog();
}

async function recoverInputTestOnOpen(request: number, selector: string): Promise<void> {
  try {
    const view = await inputTestJSON("/api/input-test", "GET");
    const exactLiveAttempt = view.state === "listening" && view.generation !== null &&
      view.selector === selector;
    if (request !== inputTestRequest || !inputTestDialog?.open) {
      if (exactLiveAttempt) {
        // Closing while the recovery GET was in flight has the same meaning as
        // closing an already-rendered run: release only its exact generation.
        void inputTestJSON("/api/input-test/cancel", "POST", {
          generation: view.generation,
        }).catch(() => undefined);
      }
      return;
    }
    if (exactLiveAttempt) {
      inputTestView = view;
      scheduleInputTestPoll(request, view.generation!);
    } else if (view.state === "listening") {
      inputTestView = {
        ...view,
        ok: false,
        state: "unavailable",
        generation: null,
        remaining_ms: null,
        held: [],
        seen: [],
        peak: 0,
        events: 0,
        dropped: 0,
        code: "busy-other",
        error: `Another simultaneous-input test is already listening to ${view.selector || "an unknown source"}. Select that exact source to inspect or stop it; this window has no cancellation authority.`,
      };
    } else {
      inputTestView = view.selector === selector ? view : null;
    }
  } catch (error) {
    if (request !== inputTestRequest || !inputTestDialog?.open) return;
    inputTestView = {
      ok: false,
      state: "failed",
      generation: null,
      selector,
      remaining_ms: null,
      held: [],
      seen: [],
      peak: 0,
      events: 0,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: "",
      error: `KSX could not check for an existing input test. ${
        error instanceof Error ? error.message : "The diagnostic status request failed."
      }`,
    };
  } finally {
    if (request === inputTestRequest) {
      inputTestRecovering = false;
      renderInputTestDialog();
    }
  }
}

function openInputTest(): void {
  const selector = nCapSelector().trim();
  if (!selector) {
    keyboardWorkbenchAnnounce(
      "Select one exact keyboard or keyboard-mode encoder before testing simultaneous inputs.",
    );
    return;
  }
  inputTestReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  inputTestSelector = selector;
  inputTestSourceName = nKbTitle().trim() || "Selected keyboard";
  const request = ++inputTestRequest;
  if (inputTestTimer !== undefined) window.clearTimeout(inputTestTimer);
  inputTestTimer = undefined;
  inputTestView = null;
  inputTestStarting = false;
  inputTestRecovering = true;
  const dialog = ensureInputTestDialog();
  renderInputTestDialog();
  if (!dialog.open) dialog.showModal();
  void recoverInputTestOnOpen(request, selector);
  window.requestAnimationFrame(() => {
    dialog.querySelector<HTMLButtonElement>('[data-input-test-action="start"]')
      ?.focus({ preventScroll: true });
  });
}

async function closeInputTest(): Promise<void> {
  const generation = inputTestView?.state === "listening" || inputTestView?.state === "unknown"
    ? inputTestView.generation
    : null;
  inputTestRequest += 1;
  inputTestStarting = false;
  inputTestRecovering = false;
  if (inputTestTimer !== undefined) window.clearTimeout(inputTestTimer);
  inputTestTimer = undefined;
  inputTestDialog?.close();
  const target = inputTestReturnFocus;
  inputTestReturnFocus = null;
  if (target?.isConnected) target.focus({ preventScroll: true });
  if (generation !== null) {
    // Closing is immediate; the daemon request is bounded and generation-
    // specific, so a late answer cannot repaint or cancel somebody else's run.
    void inputTestJSON("/api/input-test/cancel", "POST", { generation }).catch(() => undefined);
  }
}

type ControlSurfaceFlowAuthority =
  | "unassigned"
  | "expected"
  | "configured"
  | "planned"
  | "observed"
  | "matched"
  | "mismatch";

type ControlSurfaceSignalTruth = {
  authority: ControlSurfaceFlowAuthority;
  flowAuthority: ControlSurfaceFlowAuthority;
  configuredKnown: boolean;
  configuredKey: string;
  plannedKey: string;
  observedKey: string;
  flowKey: string;
};

/** Keep the three signal lifetimes visually honest:
 *
 *  - the complete chart read owns what firmware emits now;
 *  - the editor owns an unwritten plan;
 *  - Teach owns what Windows actually observed from this physical channel.
 *
 * A successful program intentionally invalidates Teach evidence while retaining
 * the historical observation. Never infer a fresh match merely because those
 * two retained strings happen to be equal. */
function controlSurfaceSignalTruth(
  channel: ControlSurfaceChannel,
): ControlSurfaceSignalTruth {
  // With no device chart to consult, the only signal truth is what Teach
  // actually observed arriving from this control.
  const observedKey = channel.input.kind === "keyboard" ? channel.input.key.trim() : "";
  return {
    authority: observedKey ? "observed" : "unassigned",
    flowAuthority: observedKey ? "observed" : "unassigned",
    configuredKnown: false,
    configuredKey: "",
    plannedKey: "",
    observedKey,
    flowKey: observedKey,
  };
}
function controlSurfaceRouteKey(channel: ControlSurfaceChannel): string {
  const truth = controlSurfaceSignalTruth(channel);
  return truth.authority === "observed" || truth.authority === "matched" ||
      truth.authority === "mismatch"
    ? truth.observedKey
    : "";
}
function controlSurfaceDocumentFingerprint(state: ControlSurfaceState): string {
  return JSON.stringify({
    name: state.name,
    template: state.template,
    panelLayout: state.panelLayout,
    theme: state.theme,
    controls: state.controls,
  });
}

function clearControlSurfaceUndo(): void {
  controlSurfaceUndoState = null;
  controlSurfaceUndoIdentity = "";
  controlSurfaceUndoAfterFingerprint = "";
}
function saveControlSurfacePrefs(): void {
  if (
    controlSurfaceUndoAfterFingerprint &&
    controlSurfaceDocumentFingerprint(controlSurfaceState) !== controlSurfaceUndoAfterFingerprint
  ) {
    clearControlSurfaceUndo();
  }
  let latestStore = controlSurfaceStore;
  try {
    latestStore = sanitizeControlSurfaceStore(
      window.localStorage.getItem(CONTROL_SURFACE_STORAGE_KEY),
    );
  } catch {
    // Rebase against the in-memory copy when the main document cannot be read;
    // the write below still decides whether this edit can become durable.
  }
  try {
    window.localStorage.setItem(
      CONTROL_SURFACE_STORAGE_KEY,
      JSON.stringify(controlSurfaceStore),
    );
    controlSurfaceSaveFailed = false;
  } catch {
    controlSurfaceSaveFailed = true;
    // A browser-kept panel layout may remain session-only when storage is blocked.
  }
}

function applyControlSurfaceState(
  state: ControlSurfaceState,
  persist: boolean,
  reveal = false,
): void {
  controlSurfaceState = cloneControlSurfaceState(state);
  if (persist) saveControlSurfacePrefs();
  syncControlSurfaceWidget(reveal);
}

function controlSurfaceMappingRecords(): ControlSurfaceMappingRecord[] {
  const records: ControlSurfaceMappingRecord[] = [];
  for (const pad of lastBindView?.pads ?? []) {
    for (const [functionName, joinedKeys] of Object.entries(pad.fn_keys)) {
      for (const candidate of joinedKeys.split(/\s*·\s*/u)) {
        const key = candidate.trim();
        if (!key) continue;
        records.push({
          key,
          slot: pad.slot,
          functionName,
          controlLabel: pad.fn_names[functionName] || functionName,
          playerLabel: pad.title || `Player ${pad.slot}`,
        });
      }
    }
  }
  return records;
}

function maybeMigrateKeyboardWorkbenchSurface(): boolean {
  if (
    controlSurfaceState.started ||
    controlSurfaceWorkbenchMigrated(controlSurfaceStore, controlSurfaceIdentity) ||
    (
      keyboardWorkbenchState.renderMode !== "arcade" &&
      keyboardWorkbenchState.layoutMode !== "leverless" &&
      keyboardWorkbenchState.layoutMode !== "players"
    )
  ) {
    return false;
  }
  const placed = keyboardWorkbenchPlacedKeys();
  if (placed.length === 0) return false;
  if (placed.length > CONTROL_SURFACE_MAX_CONTROLS) {
    keyboardWorkbenchAnnounce(
      `The legacy panel has ${placed.length} visual controls, above the ${CONTROL_SURFACE_MAX_CONTROLS}-control safety limit. It was left intact instead of being partially migrated.`,
    );
    return false;
  }
  controlSurfaceState = migrateKeyboardWorkbenchSurface(
    { ...controlSurfaceState, theme: keyboardWorkbenchState.theme },
    placed,
    keyboardWorkbenchState.renderMode,
    nCapSelector().trim() || controlSurfaceIdentity,
  );
  controlSurfaceStore = withControlSurfaceWorkbenchMigrated(
    withControlSurfaceState(
      controlSurfaceStore,
      controlSurfaceIdentity,
      controlSurfaceState,
    ),
    controlSurfaceIdentity,
  );
  let migrationSaved = false;
  try {
    window.localStorage.setItem(
      CONTROL_SURFACE_STORAGE_KEY,
      JSON.stringify(controlSurfaceStore),
    );
    migrationSaved = true;
  } catch {
    controlSurfaceSaveFailed = true;
    // Keep the legacy surface byte-for-byte when the larger replacement could
    // not be made durable. The in-memory copy remains available this session,
    // but must never be announced as a completed migration.
  }
  if (!migrationSaved) {
    keyboardWorkbenchAnnounce(
      "The old panel is still intact. This browser could not save its Control Surface copy, so the migration remains session-only.",
    );
    return true;
  }
  // The legacy surface is now safe in its own document. The Workbench returns
  // to its truthful job: arranging real keycaps from the selected keyboard.
  applyKeyboardWorkbenchState(
    {
      ...keyboardWorkbenchState,
      renderMode: "keycap",
      layoutMode: keyboardWorkbenchState.layoutMode === "free" ? "free" : "compact",
    },
    true,
  );
  keyboardWorkbenchAnnounce(
    "Your existing arcade or player-panel layout moved into Control Surface Builder; the Keyboard Arranger and every mapping were preserved.",
  );
  return true;
}

function loadControlSurfacePrefs(): void {
  try {
    controlSurfaceStore = sanitizeControlSurfaceStore(
      window.localStorage.getItem(CONTROL_SURFACE_STORAGE_KEY),
    );
  } catch {
    controlSurfaceStore = {
      version: CONTROL_SURFACE_STORE_VERSION,
      devices: {},
      migratedWorkbench: {},
      hardwareEpochs: {},
    };
  }
  controlSurfaceIdentity = currentKeyboardWorkbenchIdentity();
  controlSurfaceState = controlSurfaceStateForDevice(
    controlSurfaceStore,
    controlSurfaceIdentity,
    keyboardWorkbenchState.theme,
  );
  maybeMigrateKeyboardWorkbenchSurface();
  applyControlSurfaceState(controlSurfaceState, false);
  installControlSurfaceStorageSync();
}

/** `storage` fires in every other document sharing this origin. Hardware
 * epochs are intentionally separate from the whole surface document, so a
 * stale tab cannot overwrite both the old observation and the fact that the
 * encoder changed in one setItem. */
function installControlSurfaceStorageSync(): void {
  if (controlSurfaceStorageSyncInstalled) return;
  controlSurfaceStorageSyncInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== CONTROL_SURFACE_STORAGE_KEY &&
        !event.key?.startsWith(CONTROL_SURFACE_HARDWARE_EPOCH_STORAGE_PREFIX) &&
        event.key !== null) return;
    let sourceStore = controlSurfaceStore;
    if (event.key === CONTROL_SURFACE_STORAGE_KEY || event.key === null) {
      try {
        sourceStore = sanitizeControlSurfaceStore(
          event.key === CONTROL_SURFACE_STORAGE_KEY
            ? event.newValue
            : window.localStorage.getItem(CONTROL_SURFACE_STORAGE_KEY),
        );
      } catch {
        sourceStore = {
          version: CONTROL_SURFACE_STORE_VERSION,
          devices: {},
          migratedWorkbench: {},
          hardwareEpochs: {},
        };
      }
    }
    syncControlSurfaceWidget(false);
      mappingFlowLayer?.scheduleLayout();
  });
}

function reconcileControlSurfaceIdentity(): void {
  const identity = currentKeyboardWorkbenchIdentity();
  const changed = identity !== controlSurfaceIdentity;
  const hardwareTargetChanged = false;
  if (changed) {
    if (learnRow?.purpose === "surface") void cancelLearn();
  }
  if (changed) {
    if (assignKey) cancelAssign();
    controlSurfaceIdentity = identity;
    controlSurfaceChoosingTemplate = false;
    controlSurfacePendingTemplate = null;
    controlSurfaceUndoState = null;
    controlSurfaceUndoIdentity = "";
    controlSurfaceUndoAfterFingerprint = "";
    controlSurfaceInspectorPrint = "";
    controlSurfaceState = controlSurfaceStateForDevice(
      controlSurfaceStore,
      identity,
      keyboardWorkbenchState.theme,
    );
    }
  maybeMigrateKeyboardWorkbenchSurface();
  syncControlSurfaceWidget(false);
}

/** Repaint a premium controller without moving a single source-authored path
 * or transparent mapper hook. The body keeps its native geometry; only the
 * source's semantic paint variables and the shared shell gradient change. */
function applyPremiumControllerVariant(
  svg: SVGSVGElement,
  controls: HTMLElement,
  family: PremiumControllerFamily,
  storeKey: string,
  slug: PremiumControllerVariantSlug,
  persist: boolean,
): void {
  const config = PREMIUM_CONTROLLER_CONFIGS[family];
  const variant = config.variants.find((item) => item.slug === slug) ?? config.variants[0];
  for (const [name, value] of Object.entries(variant.tones)) svg.style.setProperty(name, value);
  svg.style.setProperty(config.shellTone, `url(#${variant.gradient})`);
  svg.setAttribute("data-controller-variant", variant.slug);
  svg.setAttribute(config.variantAttribute, variant.slug);
  for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("button[data-controller-variant]"))) {
    button.setAttribute("aria-pressed", String(button.dataset.controllerVariant === variant.slug));
  }
  if (persist) {
    controllerFinishes[controllerFinishKey(family, storeKey)] = variant.slug;
    saveControllerFinishes();
  }
}

/** A widget's durable identity in the store: the keyboard is itself; a
 *  controller is its PRESET, so its spot survives seat renumbering. Twin
 *  seats on the SAME preset get #2/#3… suffixes in slot order — without
 *  them both twins would fight over one saved spot. */
function padStoreKeys(
  pads: readonly { slot: number; preset: string }[],
): Map<number, string> {
  const seen = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const pv of pads) {
    const n = (seen.get(pv.preset) ?? 0) + 1;
    seen.set(pv.preset, n);
    keys.set(pv.slot, "p:" + pv.preset + (n > 1 ? "#" + n : ""));
  }
  return keys;
}

function keyboardWorkbenchCanvasKey(identity = keyboardWorkbenchIdentity): string {
  return "kw:" + identity;
}

function controlSurfaceCanvasKey(identity = controlSurfaceIdentity): string {
  return "cs:" + identity;
}

function currentKeyboardSourceItem(): HTMLElement | null {
  if (keyboardSourceItem) return keyboardSourceItem;
  keyboardSourceItem = learnRoot?.querySelector<HTMLElement>(
    '.n-canvas [data-instance-id="keyboard"]',
  ) ?? null;
  return keyboardSourceItem;
}

/** Collapse the served keyboard widget without destroying, detaching, or
 * cloning it. Its original canvas geometry is kept aside while the compact
 * parked stub is visible, then restored onto the exact same article. */
function syncKeyboardSourceVisibility(reveal: boolean): void {
  const item = currentKeyboardSourceItem();
  const canvas = nCanvas;
  if (!item) return;
  const hidden = keyboardWorkbenchState.open && keyboardWorkbenchState.sourceHidden;
  const wasHidden = item.dataset.sourceHidden === "true";
  if (canvas && hidden && !wasHidden) {
    keyboardSourceGeometry = canvas.getItemState(item);
    canvasPrefs.widgets["kb"] = keyboardSourceGeometry;
    saveCanvasPrefs();
  }
  item.dataset.sourceHidden = String(hidden);
  const body = item.querySelector<HTMLElement>(".n-widget-body");
  if (body) {
    body.inert = hidden;
    body.setAttribute("aria-hidden", String(hidden));
  }
  if (canvas && !hidden && wasHidden) {
    const restored = keyboardSourceGeometry ?? canvasPrefs.widgets["kb"] ?? KB_HOME;
    canvas.restoreItemState(item, restored);
  }
  labelCanvasMarkers();
  mappingFlowLayer?.scheduleLayout();
  if (reveal && canvas && !hidden) canvas.focusItem(item);
}

function setKeyboardSourceHidden(hidden: boolean): void {
  if (!keyboardWorkbenchState.open || hidden === keyboardWorkbenchState.sourceHidden) return;
  applyKeyboardWorkbenchState({ ...keyboardWorkbenchState, sourceHidden: hidden }, true);
  keyboardWorkbenchAnnounce(
    hidden
      ? "Source keyboard hidden. Its served art, mappings, and position are preserved."
      : "Source keyboard restored to the canvas.",
  );
  if (!hidden) {
    window.requestAnimationFrame(() => {
      const source = currentKeyboardSourceItem();
      if (source?.isConnected) nCanvas?.focusItem(source);
    });
  }
}

/** Read every mounted widget's geometry plus the camera back into the store
 *  — called from the engine's onCommit (its own durable boundary), from the
 *  debounced onChange trail (so a kill mid-arrangement loses at most the
 *  last second), and synchronously on pagehide. */
function persistCanvas(): void {
  const canvas = nCanvas;
  const root = learnRoot;
  const v = lastBindView;
  if (!canvas || !root) return;
  const widgets: Record<string, CanvasItemGeometry> = { ...canvasPrefs.widgets };
  const kb = root.querySelector<HTMLElement>('.n-canvas [data-instance-id="keyboard"]');
  if (kb && kb.dataset.canvasX !== undefined) {
    keyboardSourceItem = kb;
    const measured = canvas.getItemState(kb);
    if (kb.dataset.sourceHidden !== "true") keyboardSourceGeometry = measured;
    widgets["kb"] = keyboardSourceGeometry ?? measured;
  } else if (keyboardSourceGeometry) {
    widgets["kb"] = keyboardSourceGeometry;
  }
  if (keyboardWorkbenchItem?.dataset.canvasX !== undefined) {
    widgets[keyboardWorkbenchCanvasKey(keyboardWorkbenchItemIdentity)] =
      canvas.getItemState(keyboardWorkbenchItem);
  }
  if (controlSurfaceItem?.dataset.canvasX !== undefined) {
    widgets[controlSurfaceCanvasKey(controlSurfaceItemIdentity)] =
      canvas.getItemState(controlSurfaceItem);
  }
  const storeKeys = padStoreKeys(v?.pads ?? []);
  for (const [slot, item] of padItems) {
    const key = storeKeys.get(slot);
    if (key !== undefined) widgets[key] = canvas.getItemState(item);
  }
  canvasPrefs = {
    camera: canvas.getCamera(),
    widgets,
    mapHidden: canvasPrefs.mapHidden,
    mappingPaths: canvasPrefs.mappingPaths,
    processorOffsets: canvasPrefs.processorOffsets,
  };
  saveCanvasPrefs();
}

/** Show or hide the map, and swap in the small corner button that brings it
 *  back — the control for a thing in the corner belongs in that corner, not
 *  in a bar at the other end of the page.
 *  ⚠️The engine projects onto the map's MEASURED box, so a hidden one has no
 *  size to project onto: bringing it back has to re-render once it has been
 *  laid out again, or it returns blank. */
function setCanvasMap(hidden: boolean): void {
  const root = learnRoot;
  const map = root?.querySelector<HTMLElement>(".forma-canvas-navigator");
  const show = root?.querySelector<HTMLElement>(".n-mapshow");
  if (!map) return;
  map.hidden = hidden;
  if (show) show.hidden = !hidden;
  canvasPrefs = { ...canvasPrefs, mapHidden: hidden };
  saveCanvasPrefs();
  if (!hidden) {
    window.requestAnimationFrame(() => {
      nCanvas?.refreshNavigator();
      mappingFlowLayer?.scheduleLayout();
    });
  } else {
    mappingFlowLayer?.scheduleLayout();
  }
}

function paintMappingFlowCount(summary: MappingFlowLayoutSummary): void {
  const count = learnRoot?.querySelector<HTMLOutputElement>(".n-pathcount");
  const description = learnRoot?.querySelector<HTMLElement>("#n-mapping-path-status");
  const mode = canvasPrefs.mappingPaths ?? "off";
  const mappingUnavailable = summary.unavailableMappings.length === 0
    ? ""
    : `; direct mapping information is unavailable for ${summary.unavailableMappings.map((item) =>
      `Player ${item.slot} (${item.reason.replace(/[.\s]+$/u, "")})`
    ).join("; ")}`;
  const macroUnavailable = summary.unavailableMacros.length === 0
    ? ""
    : `; macro information is unavailable for ${summary.unavailableMacros.map((item) =>
      `Player ${item.slot} (${item.reason.replace(/[.\s]+$/u, "")})`
    ).join("; ")}`;
  const grouped = summary.processorOverflow === 0
    ? ""
    : `; ${summary.processorOverflow} ${summary.processorOverflow === 1 ? "macro is" : "macros are"} grouped in the macro bank`;
  if (count) {
    if (mode === "off") {
      count.textContent = "";
      count.title = "Mapping paths are off";
      if (description) description.textContent = "Mapping paths are off.";
    } else {
      const visibleCount = summary.processors > 0
        ? `${summary.resolved} ${summary.resolved === 1 ? "link" : "links"} · ${summary.processors} ${summary.processors === 1 ? "macro" : "macros"}`
        : `${summary.resolved} ${summary.resolved === 1 ? "cord" : "cords"}`;
      const partial = summary.unavailableMappings.length > 0 || summary.unavailableMacros.length > 0;
      count.textContent = `${visibleCount}${partial ? " · partial" : ""}`;
      const directKind = summary.unavailableMappings.length > 0 ? "known direct" : "direct";
      const parts = [
        `${summary.resolvedDirect} ${directKind} ${summary.resolvedDirect === 1 ? "path" : "paths"}`,
        summary.processors > 0
          ? `${summary.resolvedMacroConnections} ${summary.resolvedMacroConnections === 1 ? "macro connection" : "macro connections"} through ${summary.processors} ${summary.processors === 1 ? "processor" : "processors"}`
          : "",
      ].filter(Boolean).join(" and ");
      const hidden = summary.unresolved === 0
        ? ""
        : `; ${summary.unresolved} ${summary.unresolved === 1 ? "connection has" : "connections have"} an endpoint that is not visible`;
      count.title = `${parts} shown${hidden}${grouped}${mappingUnavailable}${macroUnavailable}`;
      if (description) description.textContent = `${count.title}.`;
    }
  }

  const announcement = pendingMappingFlowAnnouncement;
  if (!announcement || announcement.mode !== mode) return;
  pendingMappingFlowAnnouncement = null;
  if (mode === "off") {
    keyboardWorkbenchAnnounce("Mapping paths hidden.");
    return;
  }
  if (mode === "selected" && announcement.selectedSlot <= 0) {
    keyboardWorkbenchAnnounce("No player is selected, so no signal paths are available.");
    return;
  }
  const scope = mode === "selected"
    ? ` for Player ${announcement.selectedSlot}`
    : " for all players";
  if (summary.total === 0 && summary.processors === 0) {
    const certainty = summary.unavailableMappings.length > 0 || summary.unavailableMacros.length > 0
      ? "No known signal paths are available"
      : "No direct signal paths are available";
    keyboardWorkbenchAnnounce(
      `${certainty}${scope}${mappingUnavailable}${macroUnavailable}.`,
    );
    return;
  }
  const hidden = summary.unresolved === 0
    ? ""
    : `; ${summary.unresolved} ${summary.unresolved === 1 ? "connection has" : "connections have"} endpoints that are not visible`;
  const composition = summary.processors > 0
    ? `: ${summary.resolvedDirect} ${summary.unavailableMappings.length > 0 ? "known direct" : "direct"} and ${summary.resolvedMacroConnections} through ${summary.processors} ${summary.processors === 1 ? "macro" : "macros"}`
    : "";
  keyboardWorkbenchAnnounce(
    `${summary.resolved} signal ${summary.resolved === 1 ? "link" : "links"} shown${scope}${composition}${hidden}${grouped}${mappingUnavailable}${macroUnavailable}.`,
  );
}

/** Reconcile backend-owned graph truth separately from measured anchors. */
function syncMappingFlow(announce = false): void {
  const mode = canvasPrefs.mappingPaths ?? "off";
  const selectedSlot = Number(nSlotVal() || "0");
  if (announce) pendingMappingFlowAnnouncement = { mode, selectedSlot };
  mappingFlowLayer?.setGraph(lastBindView?.pads ?? [], mode, selectedSlot);
  const select = learnRoot?.querySelector<HTMLSelectElement>('[data-nx="mapping-paths"]');
  if (select && select.value !== mode) select.value = mode;
}

function setMappingPathMode(mode: MappingPathMode): void {
  if (!mappingPathModeIsValid(mode)) return;
  canvasPrefs = { ...canvasPrefs, mappingPaths: mode };
  saveCanvasPrefs();
  syncMappingFlow(true);
}

/** Name the markers on the map. The engine draws one box per widget and
 *  gives it a title and an aria-label; what it cannot know is that on THIS
 *  page a box is a seat — so the boxes get the seat's short name and the
 *  seat's colour, the same pair the rack and the badges wear. A map you can
 *  read is the difference between "click around until you find it" and
 *  "P2 is over there". */
function labelCanvasMarkers(): void {
  const root = learnRoot;
  const v = lastBindView;
  if (!root) return;
  const markers = root.querySelectorAll<HTMLElement>(".forma-canvas-navigator .navigator-item");
  for (const marker of Array.from(markers)) {
    const id = marker.dataset.instanceId ?? "";
    if (id === "keyboard") {
      marker.textContent = "KB";
      marker.classList.add("nm-kb");
      marker.title = "Keyboard · physical key source";
      marker.setAttribute("aria-label", "Focus Keyboard");
      continue;
    }
    if (id === "key-workbench") {
      marker.textContent = "KEYS";
      marker.classList.add("nm-kb", "nm-keylab");
      marker.title = "Keyboard Arranger · real keys from the selected keyboard";
      continue;
    }
    if (id === "control-surface") {
      marker.textContent = "PANEL";
      marker.classList.add("nm-kb", "nm-surface");
      marker.title = "Control Surface Builder · physical controls, taught inputs, and routes";
      continue;
    }
    const slot = Number(id.startsWith("pad-") ? id.slice(4) : NaN);
    if (!Number.isFinite(slot)) continue;
    marker.textContent = "P" + slot;
    // The seat's own colour, exactly as the rack and the pad badge wear it.
    for (const cls of Array.from(marker.classList)) {
      if (/^np\d+$/.test(cls)) marker.classList.remove(cls);
    }
    marker.classList.add("nm-pad", "np" + slot);
    const pv = (v?.pads ?? []).find((pad) => pad.slot === slot);
    if (pv) marker.title = "P" + slot + " · " + pv.title;
  }
}

let canvasPersistTimer = 0;
function scheduleCanvasPersist(): void {
  window.clearTimeout(canvasPersistTimer);
  canvasPersistTimer = window.setTimeout(persistCanvas, 1000);
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

/** The selected widget's controls, retargeted instead of cloned — the
 *  upstream app's own shape (one contextual group, not four buttons on
 *  every card), and the reason the page can carry a live size readout and
 *  honest disabled states at the scale limits.
 *
 *  ⚠️PARITY: every write here is imperative, so what it writes for "nothing
 *  selected" must be EXACTLY what the server serves — see the markup's
 *  `data-nsel` group. Nothing is selected at first paint (mounting passes
 *  `focus: false`), so the two agree byte-for-byte with no exemption. */
function syncWidgetSelection(): void {
  const root = learnRoot;
  const canvas = nCanvas;
  if (!root) return;
  const group = root.querySelector<HTMLElement>(".n-selbar");
  if (!group) return;
  const item = canvas?.activeItem() ?? null;
  const name = item?.dataset.widgetName ?? "";
  const state = item && canvas ? canvas.getItemState(item) : null;
  const percent = state ? Math.round(state.manualScale * 100) : 100;
  const focused = Boolean(item && canvas?.isFocusModeActive(item));
  group.dataset.nselState = item ? "selected" : "none";
  const label = group.querySelector<HTMLElement>(".n-sel-name");
  if (label) label.textContent = item ? name : "Nothing selected";
  const size = group.querySelector<HTMLElement>('[data-nx="w-scale-reset"]');
  if (size) {
    size.textContent = percent + "%";
    size.title = item ? name + " is at " + percent + "% — click for 100%" : "Widget size";
    size.setAttribute(
      "aria-label",
      item ? name + " size " + percent + "%; reset to 100%" : "Widget size",
    );
  }
  for (const button of Array.from(group.querySelectorAll<HTMLButtonElement>("button[data-nx]"))) {
    const nx = button.dataset.nx ?? "";
    // The scale buttons also die at the engine's own clamp, so a press that
    // could not move anything never looks available.
    const atFloor = nx === "w-zoom-out" && state !== null && state.manualScale <= 0.6;
    const atCeiling = nx === "w-zoom-in" && state !== null && state.manualScale >= 1.6;
    button.disabled = item === null || atFloor || atCeiling;
    if (nx === "w-focus") {
      button.setAttribute("aria-pressed", String(focused));
      button.textContent = focused ? "Unfocus" : "Focus";
      button.setAttribute(
        "aria-label",
        focused ? "Leave focus and restore the previous view" : "Focus " + (name || "widget"),
      );
    }
  }
}

/** Lay the whole canvas out the way a person would if they were tidy:
 *  the keyboard on top, the controllers in seat order in a row beneath it,
 *  wrapping onto further rows when they do not fit, every row centered on
 *  the board. Then frame the result. Deliberately NOT a persistent grid
 *  mode — it is one tidy-up you ask for, and anything you drag afterwards
 *  stays where you drop it. */
function arrangeCanvas(): void {
  const canvas = nCanvas;
  const root = learnRoot;
  if (!canvas || !root) return;
  const kb = root.querySelector<HTMLElement>('.n-canvas [data-instance-id="keyboard"]');
  const keylab = keyboardWorkbenchItem;
  const surface = controlSurfaceItem;
  const pads = Array.from(padItems.entries())
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item);
  if (!kb && !keylab && !surface && pads.length === 0) return;
  const GAP = 48;
  const ORIGIN_Y = 140;
  // Tidying is a RESET, not a repack: a widget somebody had shrunk to 60%
  // would otherwise keep its odd size in an otherwise even row, which is
  // exactly the untidiness the button is meant to end.
  if (kb) canvas.resetItemScale(kb);
  if (keylab) canvas.resetItemScale(keylab);
  if (surface) canvas.resetItemScale(surface);
  for (const item of pads) canvas.resetItemScale(item);
  // A widget's world footprint includes its manual scale: a widget the user
  // made bigger must be given the room it actually occupies.
  const footprint = (item: HTMLElement): { w: number; h: number } => {
    const state = canvas.getItemState(item);
    return { w: state.width * state.manualScale, h: state.height * state.manualScale };
  };
  // A fixed, near-origin corner. Tidying twice must land in the same place,
  // and the arrangement's world coordinates are nobody's business: Fit is
  // what decides where you are looking afterwards.
  const widest = Math.max(
    kb ? footprint(kb).w : 0,
    keylab ? footprint(keylab).w : 0,
    surface ? footprint(surface).w : 0,
    ...pads.map((item) => footprint(item).w),
    1,
  );
  const ORIGIN_X = 160;
  let y = ORIGIN_Y;
  let boardWidth = 0;
  if (kb) {
    const board = footprint(kb);
    boardWidth = board.w;
    canvas.placeItem(kb, ORIGIN_X + Math.round((widest - board.w) / 2), y);
    y += board.h + GAP;
  }
  if (keylab) {
    const lab = footprint(keylab);
    boardWidth = Math.max(boardWidth, lab.w);
    canvas.placeItem(keylab, ORIGIN_X + Math.round((widest - lab.w) / 2), y);
    y += lab.h + GAP;
  }
  if (surface) {
    const panel = footprint(surface);
    boardWidth = Math.max(boardWidth, panel.w);
    canvas.placeItem(surface, ORIGIN_X + Math.round((widest - panel.w) / 2), y);
    y += panel.h + GAP;
  }
  if (pads.length > 0) {
    // Rows are as wide as the board (or the widest pad, whichever is more),
    // so the arrangement reads as one column of stuff rather than a sprawl.
    const widest = Math.max(...pads.map((item) => footprint(item).w));
    const budget = Math.max(boardWidth, widest);
    const rows: HTMLElement[][] = [];
    let row: HTMLElement[] = [];
    let rowWidth = 0;
    for (const item of pads) {
      const { w } = footprint(item);
      const next = row.length === 0 ? w : rowWidth + GAP + w;
      if (row.length > 0 && next > budget) {
        rows.push(row);
        row = [item];
        rowWidth = w;
      } else {
        row.push(item);
        rowWidth = next;
      }
    }
    if (row.length > 0) rows.push(row);
    for (const members of rows) {
      const width = members.reduce(
        (total, item, index) => total + footprint(item).w + (index > 0 ? GAP : 0),
        0,
      );
      let x = ORIGIN_X + (budget - width) / 2;
      let tallest = 0;
      for (const item of members) {
        const { w, h } = footprint(item);
        canvas.placeItem(item, x, y);
        x += w + GAP;
        tallest = Math.max(tallest, h);
      }
      y += tallest + GAP;
    }
  }
  persistCanvas();
  // The arrangement is only half the ask: "bring all widgets in the
  // viewport" is the other half.
  canvas.fitAll();
}

function keyboardWorkbenchRecords(): KeyboardWorkbenchRecord[] {
  const v = lastBindView;
  if (!v) return [];
  type SlotBinding = { playerLabel: string; controls: Set<string> };
  const byKey = new Map<string, Map<number, SlotBinding>>();
  const playerBindings = (slots: Map<number, SlotBinding>) =>
    [...slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([slot, binding]) => ({
        slot,
        playerLabel: binding.playerLabel,
        controls: [...binding.controls].sort(),
      }));
  const playerLabels = new Map<number, string>();
  for (const pad of v.pads) {
    playerLabels.set(pad.slot, pad.title || `Player ${pad.slot}`);
    for (const [fnName, joinedKeys] of Object.entries(pad.fn_keys)) {
      const control = pad.fn_names[fnName] || fnName;
      for (const candidate of joinedKeys.split(/\s*·\s*/u)) {
        const key = candidate.trim();
        if (!key) continue;
        let slots = byKey.get(key);
        if (!slots) {
          slots = new Map();
          byKey.set(key, slots);
        }
        let binding = slots.get(pad.slot);
        if (!binding) {
          binding = {
            playerLabel: pad.title || `Player ${pad.slot}`,
            controls: new Set(),
          };
          slots.set(pad.slot, binding);
        }
        binding.controls.add(control);
      }
    }
  }
  const rows = [
    v.kb_row1,
    v.kb_row2,
    v.kb_row3,
    v.kb_row4,
    v.kb_row5,
    v.kb_row6,
    v.kb_tray,
  ];
  const records: KeyboardWorkbenchRecord[] = [];
  const seen = new Set<string>();
  for (const cell of rows.flat()) {
    const key = cell.key.trim();
    if (!key || seen.has(key) || cell.cls.split(/\s+/).includes("ghost")) continue;
    seen.add(key);
    const slots = byKey.get(key) ?? new Map<number, SlotBinding>();
    // The served ownership bands also include macro triggers. For one to
    // four owners they prove membership even when fn_keys has no control
    // label for it; retain that truth and leave the label generic.
    for (const token of cell.cls.split(/\s+/)) {
      const owner = token.match(/^b[abcd](\d{1,2})$/);
      const slot = owner ? Number(owner[1]) : 0;
      if (slot < 1 || slot > 16 || slots.has(slot)) continue;
      slots.set(slot, {
        playerLabel: playerLabels.get(slot) ?? `Player ${slot}`,
        controls: new Set(),
      });
    }
    records.push({
      key,
      cls: cell.cls,
      cap: cell.cap,
      short: cell.short,
      aria: cell.aria || cell.title || key,
      playerBindings: playerBindings(slots),
    });
  }
  // kb_tray is authored for the selected player. A valid key can therefore
  // be absent from every served board cell while still being mapped on a
  // different P1-P4 controller (media keys are the common example). Preserve
  // those proven mappings as generic wide caps instead of silently dropping
  // them from “Build 4 players”.
  for (const [key, slots] of [...byKey.entries()]
    .filter(([key]) => !seen.has(key))
    .sort(([a], [b]) => a.localeCompare(b))) {
    const bindings = playerBindings(slots);
    const controls = [...new Set(bindings.flatMap((binding) => binding.controls))];
    const owners = bindings.map((binding) => {
      const drives = binding.controls.length > 0 ? ` (${binding.controls.join(" · ")})` : "";
      return `P${binding.slot}${drives}`;
    }).join(", ");
    records.push({
      key,
      cls: `n-key bound offboard ${key.length > 12 ? "u3" : "u2"}`,
      cap: key,
      short: controls[0] ?? "Mapped",
      aria: `${key} — mapped on ${owners}`,
      playerBindings: bindings,
    });
  }
  return records;
}

/** Leave the served key exactly where it is; an extracted cap exposes a
 *  socket while its linked clone lives in the separate client widget. */
function syncKeyboardSourceCaps(): void {
  const root = learnRoot;
  if (!root) return;
  const selected = new Set(
    keyboardWorkbenchState.open ? keyboardWorkbenchState.selectedKeys : [],
  );
  const caps = Array.from(
    root.querySelectorAll<HTMLElement>(".n-widget-kb [data-key]"),
  ).filter((cap) =>
    !cap.classList.contains("ghost") && !cap.classList.contains("n-ipac-signal")
  );
  const active = document.activeElement;
  let roving: HTMLElement | null = null;
  for (const cap of caps) {
    const key = cap.getAttribute("data-key") ?? "";
    cap.classList.toggle("extracted", selected.has(key));
    if (keyboardWorkbenchState.open) {
      cap.setAttribute("role", "button");
      cap.setAttribute("aria-pressed", String(selected.has(key)));
      cap.tabIndex = -1;
      if (cap === active) roving = cap;
    } else {
      cap.setAttribute("role", "img");
      cap.removeAttribute("aria-pressed");
      cap.removeAttribute("tabindex");
    }
  }
  if (keyboardWorkbenchState.open && caps.length > 0) (roving ?? caps[0]).tabIndex = 0;
}

function keyboardWorkbenchPlacedKeys(): KeyboardWorkbenchPlacedKey[] {
  return layoutKeyboardWorkbenchKeys(keyboardWorkbenchRecords(), keyboardWorkbenchState);
}

function keyboardWorkbenchSetSelected(key: string, token = key ? `k:${key}` : ""): void {
  keyboardWorkbenchSelectedKey = key;
  keyboardWorkbenchSelectedToken = token;
  const item = keyboardWorkbenchItem;
  if (!item) return;
  for (const button of Array.from(item.querySelectorAll<HTMLElement>(".n-deck-key"))) {
    const selected = token !== "" && button.dataset.keylabToken === token;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  const returnButton = item.querySelector<HTMLButtonElement>('[data-nx="keylab-return"]');
  if (returnButton) returnButton.disabled = key === "";
}

function syncKeyboardWorkbenchToolbar(): void {
  const item = keyboardWorkbenchItem;
  if (!item) return;
  for (const button of Array.from(item.querySelectorAll<HTMLButtonElement>("button[data-mode]"))) {
    const mode = button.dataset.mode ?? "";
    const pressed = mode === keyboardWorkbenchState.layoutMode ||
      mode === keyboardWorkbenchState.renderMode ||
      mode === keyboardWorkbenchState.capProfile;
    button.setAttribute("aria-pressed", String(pressed));
  }
  for (const button of Array.from(
    item.querySelectorAll<HTMLButtonElement>("button[data-keyboard-theme]"),
  )) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.keyboardTheme === keyboardWorkbenchState.theme),
    );
  }
  const count = keyboardWorkbenchState.selectedKeys.length;
  const placed = keyboardWorkbenchPlacedKeys();
  const status = item.querySelector<HTMLElement>(".n-keylab-status");
  if (status) {
    status.textContent = count === 0
      ? "Choose real keycaps on the source keyboard, or bring in the selected player's mapped keys."
      : `${count} real ${count === 1 ? "key" : "keys"} · ${
          keyboardWorkbenchState.layoutMode === "free" ? "custom arrangement" : "compact arrangement"
        } · ${KEYBOARD_CAP_PROFILES.find((profile) => profile.slug === keyboardWorkbenchState.capProfile)?.label ?? "Mechanical"} keycaps`;
  }
  const deck = item.querySelector<HTMLElement>(".n-keylab-deck");
  if (deck) {
    deck.dataset.renderMode = keyboardWorkbenchState.renderMode;
    deck.dataset.layoutMode = keyboardWorkbenchState.layoutMode;
    deck.dataset.keycapProfile = keyboardWorkbenchState.capProfile;
    deck.classList.toggle("empty", count === 0);
  }
  item.dataset.keyboardTheme = keyboardWorkbenchState.theme;
  item.dataset.keycapProfile = keyboardWorkbenchState.capProfile;
  item.dataset.layoutMode = keyboardWorkbenchState.layoutMode;
  item.dataset.sourceHidden = String(keyboardWorkbenchState.sourceHidden);
  const profileGroup = item.querySelector<HTMLElement>(".n-keylab-profile-group");
  if (profileGroup) profileGroup.hidden = keyboardWorkbenchState.renderMode === "arcade";
  const source = item.querySelector<HTMLButtonElement>('[data-nx="keylab-source-toggle"]');
  if (source) {
    source.textContent = keyboardWorkbenchState.sourceHidden ? "Show source" : "Hide source";
    // This is an action whose label changes, not a persistent pressed mode.
    // aria-expanded carries the source body's actual visibility without the
    // contradictory “Show source, pressed” announcement.
    source.removeAttribute("aria-pressed");
    source.setAttribute("aria-expanded", String(!keyboardWorkbenchState.sourceHidden));
  }
  const clear = item.querySelector<HTMLButtonElement>('[data-nx="keylab-clear"]');
  if (clear) clear.disabled = count === 0;
  const mapped = item.querySelector<HTMLButtonElement>('[data-nx="keylab-pull-mapped"]');
  if (mapped) {
    mapped.disabled = !keyboardWorkbenchRecords().some((record) =>
      record.cls.split(/\s+/).includes("bound")
    );
  }
  const returnButton = item.querySelector<HTMLButtonElement>('[data-nx="keylab-return"]');
  if (returnButton) returnButton.disabled = keyboardWorkbenchSelectedKey === "";
  for (const button of Array.from(
    item.querySelectorAll<HTMLButtonElement>('[data-nx="keylab-nudge"]'),
  )) {
    button.disabled = keyboardWorkbenchSelectedToken === "";
  }

  const padBySlot = new Map((lastBindView?.pads ?? []).map((pad) => [pad.slot, pad]));
  for (const panel of Array.from(item.querySelectorAll<HTMLElement>(".n-keylab-player-panel"))) {
    const slot = Number(panel.dataset.playerSlot ?? "");
    const pad = padBySlot.get(slot);
    const controls = placed.filter((record) => record.playerSlot === slot).length;
    panel.dataset.populated = String(controls > 0);
    const name = panel.querySelector<HTMLElement>(".n-keylab-player-name");
    const tally = panel.querySelector<HTMLElement>(".n-keylab-player-count");
    if (name) name.textContent = pad?.title || "No staged player";
    if (tally) tally.textContent = `${controls} ${controls === 1 ? "control" : "controls"}`;
  }
  const looseCount = placed.filter((record) => record.playerSlot === null).length;
  const loose = item.querySelector<HTMLElement>(".n-keylab-loose-panel");
  if (loose) loose.dataset.populated = String(looseCount > 0);
}

function deckKeyModifier(key: string): boolean {
  return /^(?:Left|Right)?(?:Shift|Control|Alt|Meta)$/.test(key) ||
    new Set(["Tab", "CapsLock", "Enter", "Backspace", "Escape", "Space"]).has(key);
}

function keyboardWorkbenchCloneClass(record: KeyboardWorkbenchPlacedKey): string {
  const sourceClass = record.cls;
  const semantic = sourceClass.split(/\s+/).filter((cls) =>
    cls === "n-key" || cls === "bound" || cls === "shared" || cls === "bstack" ||
    /^(?:bn|bcount|ba|bb|bc|bd)\d+$/.test(cls)
  );
  if (record.playerSlot !== null) {
    const bound = semantic.indexOf("bound");
    if (bound >= 0) semantic.splice(bound, 1);
    const shared = semantic.indexOf("shared");
    if (shared >= 0) semantic.splice(shared, 1);
    semantic.push("bound", `np${record.playerSlot}`, "n-player-token");
    const binding = record.playerBindings?.find((item) => item.slot === record.playerSlot);
    if ((binding?.controls.length ?? 0) > 1) semantic.push("shared");
  }
  if (record.linkedSlots.length > 1) semantic.push("multi-owner");
  if (!semantic.includes("n-key")) semantic.unshift("n-key");
  semantic.push("n-deck-key");
  return [...new Set(semantic)].join(" ");
}

function renderKeyboardWorkbenchKeys(): void {
  const item = keyboardWorkbenchItem;
  const deck = item?.querySelector<HTMLElement>(".n-keylab-deck");
  if (!item || !deck) return;
  const placed = keyboardWorkbenchPlacedKeys();
  const existing = new Map<string, HTMLButtonElement>();
  for (const button of Array.from(deck.querySelectorAll<HTMLButtonElement>(".n-deck-key"))) {
    existing.set(button.dataset.keylabToken ?? "", button);
  }
  for (const record of placed) {
    let button = existing.get(record.instanceId);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.keylabKey = record.key;
      button.dataset.keylabToken = record.instanceId;
      button.dataset.key = record.key;
      const cap = document.createElement("span");
      cap.className = "n-key-cap";
      const short = document.createElement("span");
      short.className = "n-key-short";
      const owners = document.createElement("span");
      owners.className = "n-keylab-owners";
      owners.setAttribute("aria-hidden", "true");
      button.append(cap, short, owners);
    }
    existing.delete(record.instanceId);
    button.dataset.keylabKey = record.key;
    button.dataset.keylabToken = record.instanceId;
    button.dataset.key = record.key;
    button.className = keyboardWorkbenchCloneClass(record);
    button.classList.toggle("modifier", deckKeyModifier(record.key));
    button.classList.toggle("wide", record.width >= 82);
    button.classList.toggle("wider", record.width >= 120);
    button.classList.toggle("space", record.key === "Space");
    button.classList.toggle("selected", record.instanceId === keyboardWorkbenchSelectedToken);
    if (record.playerSlot === null) delete button.dataset.playerSlot;
    else button.dataset.playerSlot = String(record.playerSlot);
    button.dataset.ownerSlots = record.linkedSlots.join(",");
    button.dataset.ownerCount = String(record.linkedSlots.length);
    button.dataset.linked = String(record.linkedSlots.length > 1);
    button.dataset.keyWidth = String(record.width);
    button.dataset.keyHeight = String(record.height);
    button.style.left = `${(record.x / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
    button.style.top = `${(record.y / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
    button.style.width = `${(record.width / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
    button.style.height = `${(record.height / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
    const linked = record.linkedSlots.length > 1
      ? ` · one physical key linked to ${record.linkedSlots.map((slot) => `P${slot}`).join(", ")}`
      : "";
    const player = record.playerSlot === null
      ? ""
      : ` · P${record.playerSlot}${record.controlLabel ? `: ${record.controlLabel}` : ": mapped input"}`;
    button.title = `${record.aria}${player}${linked} · drag or use arrow keys to arrange · Delete returns every linked view of this physical key`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(record.instanceId === keyboardWorkbenchSelectedToken));
    const cap = button.querySelector<HTMLElement>(".n-key-cap");
    const short = button.querySelector<HTMLElement>(".n-key-short");
    if (cap) cap.textContent = record.cap;
    if (short) short.textContent = record.playerSlot === null ? record.short : record.controlLabel;
    const owners = button.querySelector<HTMLElement>(".n-keylab-owners");
    if (owners) {
      owners.replaceChildren(...record.linkedSlots.map((slot) => {
        const badge = document.createElement("span");
        badge.className = `n-keylab-owner np${slot}`;
        badge.dataset.ownerSlot = String(slot);
        badge.textContent = `P${slot}`;
        return badge;
      }));
    }
    deck.append(button);
  }
  for (const button of existing.values()) button.remove();
  syncKeyboardWorkbenchToolbar();
  liveKeyNodes = null;
  mappingFlowLayer?.scheduleLayout();
}

function makeKeyboardWorkbenchButton(
  label: string,
  nx: string,
  title: string,
  mode = "",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "n-keylab-button";
  button.dataset.nx = nx;
  if (mode) {
    button.dataset.mode = mode;
    button.setAttribute("aria-pressed", "false");
  }
  button.title = title;
  button.textContent = label;
  return button;
}

function makeKeyboardWorkbenchGroup(
  label: string,
  className: string,
  buttons: readonly HTMLButtonElement[],
): HTMLElement {
  const group = document.createElement("div");
  group.className = `n-keylab-toolgroup ${className}`;
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const heading = document.createElement("span");
  heading.className = "n-keylab-tool-label";
  heading.textContent = label;
  group.append(heading, ...buttons);
  return group;
}

function createKeyboardWorkbenchItem(): HTMLElement {
  const content = document.createElement("div");
  content.className = "n-keylab";
  content.setAttribute("data-forma-runtime-host", "");

  const head = document.createElement("div");
  head.className = "n-keylab-head";
  const heading = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "n-kick";
  kicker.textContent = "Keyboard Arranger";
  const sub = document.createElement("span");
  sub.className = "n-keylab-sub";
  sub.textContent = "Arrange appearance · real key identity and KSX routes stay unchanged";
  heading.append(kicker, sub);
  const close = makeKeyboardWorkbenchButton(
    "Close",
    "kb-workbench",
    "Close the arranger without discarding this keyboard layout",
  );
  close.classList.add("quiet");
  const sourceToggle = makeKeyboardWorkbenchButton(
    "Hide source",
    "keylab-source-toggle",
    "Temporarily hide the source keyboard widget; its art, mappings, and canvas position stay intact",
  );
  sourceToggle.setAttribute("aria-controls", "keyboard-source-widget");
  sourceToggle.setAttribute("aria-expanded", "true");
  sourceToggle.setAttribute("aria-pressed", "false");
  const headActions = document.createElement("div");
  headActions.className = "n-keylab-head-actions";
  headActions.append(sourceToggle, close);
  head.append(heading, headActions);

  const tools = document.createElement("div");
  tools.className = "n-keylab-tools";
  tools.setAttribute("aria-label", "Keyboard Arranger settings");
  const profileButtons = KEYBOARD_CAP_PROFILES.map((profile) => {
    const button = makeKeyboardWorkbenchButton(
      profile.label,
      "keylab-cap-profile",
      profile.description,
      profile.slug,
    );
    button.dataset.keycapProfile = profile.slug;
    const preview = document.createElement("span");
    preview.className = "n-keylab-profile-preview";
    preview.setAttribute("aria-hidden", "true");
    button.prepend(preview);
    return button;
  });
  const finishButtons = KEYBOARD_THEMES.map((theme) => {
    const button = makeKeyboardWorkbenchButton(
      theme.label,
      "kb-theme",
      theme.description,
    );
    button.classList.add("n-keylab-finish");
    button.dataset.keyboardTheme = theme.slug;
    button.setAttribute("aria-pressed", "false");
    const swatch = document.createElement("span");
    swatch.className = "n-keylab-finish-swatch";
    swatch.style.background = theme.swatch;
    swatch.setAttribute("aria-hidden", "true");
    button.prepend(swatch);
    return button;
  });
  const nudgeButtons = ([
    ["Left", -8, 0],
    ["Up", 0, -8],
    ["Down", 0, 8],
    ["Right", 8, 0],
  ] as const).map(([label, dx, dy]) => {
    const button = makeKeyboardWorkbenchButton(
      label,
      "keylab-nudge",
      `Move the selected keycap ${label.toLocaleLowerCase()} without dragging`,
    );
    button.dataset.keylabDx = String(dx);
    button.dataset.keylabDy = String(dy);
    return button;
  });
  tools.append(
    makeKeyboardWorkbenchGroup("Bring onto arranger", "n-keylab-add-group", [
      makeKeyboardWorkbenchButton(
        "Mapped keys",
        "keylab-pull-mapped",
        "Add every key mapped to the currently selected player without removing keys already on the board",
      ),
    ]),
    makeKeyboardWorkbenchGroup("Arrange", "n-keylab-layout-group", [
      makeKeyboardWorkbenchButton("Repack", "keylab-layout-compact", "Pack the selected real keys into a compact arrangement", "compact"),
    ]),
    makeKeyboardWorkbenchGroup("Move selected", "n-keylab-nudge-group", nudgeButtons),
    makeKeyboardWorkbenchGroup("Keycap shape", "n-keylab-profile-group", profileButtons),
    makeKeyboardWorkbenchGroup("Finish", "n-keylab-finish-group", finishButtons),
    makeKeyboardWorkbenchGroup("Panel", "n-keylab-remove-group", [
      makeKeyboardWorkbenchButton(
        "Remove selected",
        "keylab-return",
        "Remove the selected physical key and every linked panel view; mappings stay unchanged",
      ),
      makeKeyboardWorkbenchButton(
        "Clear panel",
        "keylab-clear",
        "Return every visual key to the source keyboard; mappings stay unchanged",
      ),
    ]),
  );

  const status = document.createElement("p");
  status.className = "n-keylab-status";
  status.id = "key-workbench-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const deck = document.createElement("div");
  deck.className = "n-keylab-deck empty";
  deck.setAttribute("role", "group");
  deck.setAttribute("aria-label", "Arrangeable pulled keys");
  deck.setAttribute("aria-describedby", "key-workbench-status key-workbench-note");
  const zones = document.createElement("div");
  zones.className = "n-keylab-player-zones";
  zones.setAttribute("aria-hidden", "true");
  for (const panel of KEYBOARD_WORKBENCH_PLAYER_PANELS) {
    const zone = document.createElement("section");
    zone.className = `n-keylab-player-panel np${panel.slot}`;
    zone.dataset.playerSlot = String(panel.slot);
    zone.style.left = `${(panel.x / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
    zone.style.top = `${(panel.y / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
    zone.style.width = `${(panel.width / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
    zone.style.height = `${(panel.height / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
    const zoneHead = document.createElement("div");
    zoneHead.className = "n-keylab-player-head";
    const badge = document.createElement("strong");
    badge.className = "n-keylab-player-badge";
    badge.textContent = panel.label;
    const name = document.createElement("span");
    name.className = "n-keylab-player-name";
    name.textContent = "No staged player";
    const tally = document.createElement("span");
    tally.className = "n-keylab-player-count";
    tally.textContent = "0 controls";
    zoneHead.append(badge, name, tally);
    const empty = document.createElement("span");
    empty.className = "n-keylab-player-empty";
    empty.textContent = "No mapped keys in this panel";
    zone.append(zoneHead, empty);
    zones.append(zone);
  }
  const loose = document.createElement("section");
  loose.className = "n-keylab-loose-panel";
  loose.style.left = `${(KEYBOARD_WORKBENCH_LOOSE_STRIP.x / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
  loose.style.top = `${(KEYBOARD_WORKBENCH_LOOSE_STRIP.y / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
  loose.style.width = `${(KEYBOARD_WORKBENCH_LOOSE_STRIP.width / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
  loose.style.height = `${(KEYBOARD_WORKBENCH_LOOSE_STRIP.height / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
  loose.textContent = "Loose keys · no proven P1-P4 owner";
  zones.append(loose);
  deck.append(zones);
  deck.addEventListener("pointerdown", keyboardWorkbenchPointerDown);
  deck.addEventListener("pointermove", keyboardWorkbenchPointerMove);
  deck.addEventListener("pointerup", keyboardWorkbenchPointerEnd);
  deck.addEventListener("pointercancel", keyboardWorkbenchPointerEnd);
  deck.addEventListener("dblclick", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(".n-deck-key");
    const key = button?.dataset.keylabKey ?? "";
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    toggleKeyboardWorkbenchKey(key, false);
  });

  const note = document.createElement("p");
  note.className = "n-keylab-note";
  note.id = "key-workbench-note";
  note.textContent =
    "Canvas appearance only: this arranges the actual selected keyboard without changing firmware, key identity, or KSX routes. Drag, tap Move selected, or use arrows to place · Delete returns the keycap to the source. Build Surface is the separate path for encoder panels, arcade buttons, and leverless layouts.";
  const deckScroll = document.createElement("div");
  deckScroll.className = "n-keylab-deck-scroll";
  deckScroll.append(deck);
  content.append(head, tools, status, deckScroll, note);

  const item = createCanvasItem({
    instanceId: "key-workbench",
    displayName: "Keyboard Arranger",
    preferredWidth: 1240,
    minHeight: 920,
    content,
  });
  item.classList.add("n-widget", "n-widget-keylab");
  item.dataset.clientWidget = "";
  item.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === "F2") && event.target === item) {
      event.preventDefault();
      event.stopPropagation();
      tools.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (event.key === "Escape" && content.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      item.focus();
    }
  }, { capture: true });
  return item;
}

function keyboardWorkbenchHome(): CanvasItemGeometry {
  const canvas = nCanvas;
  const kb = learnRoot?.querySelector<HTMLElement>('.n-canvas [data-instance-id="keyboard"]');
  if (canvas && kb) {
    const state = canvas.getItemState(kb);
    return {
      x: state.x + 20,
      y: state.y + state.height * state.manualScale + 48,
      width: 1240,
      height: 920,
      z: state.z + 1,
      manualScale: 1,
    };
  }
  return { x: 110, y: 950, width: 1240, height: 920, z: 2, manualScale: 1 };
}

function syncKeyboardWorkbenchWidget(reveal: boolean): void {
  const canvas = nCanvas;
  if (!canvas) return;
  // An encoder may have an old keyboard-arranger preference from builds that
  // misclassified it as a keyboard. Preserve that saved layout for migration
  // or later inspection, but never mount it over the truthful I-PAC signal
  // source or let routing cords prefer its fake keycaps.
  const suppressedForEncoder = false;
  if (
    keyboardWorkbenchItem &&
    (!keyboardWorkbenchState.open || suppressedForEncoder ||
      keyboardWorkbenchItemIdentity !== keyboardWorkbenchIdentity)
  ) {
    if (keyboardWorkbenchItem.dataset.canvasX !== undefined) {
      canvasPrefs.widgets[keyboardWorkbenchCanvasKey(keyboardWorkbenchItemIdentity)] =
        canvas.getItemState(keyboardWorkbenchItem);
      saveCanvasPrefs();
    }
    canvas.removeItem(keyboardWorkbenchItem, { selectFallback: false });
    keyboardWorkbenchItem = null;
    keyboardWorkbenchItemIdentity = "";
    keyboardWorkbenchDrag = null;
  }
  if (!keyboardWorkbenchState.open || suppressedForEncoder) {
    if (reveal) {
      const kb = learnRoot?.querySelector<HTMLElement>(
        '.n-canvas [data-instance-id="keyboard"]',
      );
      if (kb) canvas.focusItem(kb);
    }
    labelCanvasMarkers();
    return;
  }
  if (!keyboardWorkbenchItem) {
    keyboardWorkbenchItem = createKeyboardWorkbenchItem();
    keyboardWorkbenchItemIdentity = keyboardWorkbenchIdentity;
    const restored = canvasPrefs.widgets[keyboardWorkbenchCanvasKey()] ?? keyboardWorkbenchHome();
    canvas.mountItem(keyboardWorkbenchItem, restored, { focus: false });
  }
  keyboardWorkbenchItem.dataset.keyboardTheme = keyboardWorkbenchState.theme;
  keyboardWorkbenchItem.dataset.keycapProfile = keyboardWorkbenchState.capProfile;
  keyboardWorkbenchItem.dataset.layoutMode = keyboardWorkbenchState.layoutMode;
  const content = keyboardWorkbenchItem.querySelector<HTMLElement>(".n-keylab");
  if (content) {
    for (const cls of Array.from(content.classList)) {
      if (/^np\d+$/.test(cls)) content.classList.remove(cls);
    }
    const selectedClass = nKbCls().split(/\s+/).find((cls) => /^np\d+$/.test(cls));
    if (selectedClass) content.classList.add(selectedClass);
  }
  renderKeyboardWorkbenchKeys();
  labelCanvasMarkers();
  if (reveal) canvas.focusItem(keyboardWorkbenchItem);
}

function toggleKeyboardWorkbenchKey(key: string, pulled?: boolean): void {
  const record = keyboardWorkbenchRecords().find((candidate) => candidate.key === key);
  if (!record) return;
  const selected = new Set(keyboardWorkbenchState.selectedKeys);
  const shouldPull = pulled ?? !selected.has(key);
  const deckKeys = Array.from(
    keyboardWorkbenchItem?.querySelectorAll<HTMLElement>(".n-deck-key") ?? [],
  );
  const focusedDeckKey = (document.activeElement as HTMLElement | null)
    ?.closest<HTMLElement>(".n-deck-key");
  const focusFallbackIndex = !shouldPull && focusedDeckKey?.dataset.keylabKey === key
    ? deckKeys.indexOf(focusedDeckKey)
    : -1;
  if (shouldPull) selected.add(key);
  else selected.delete(key);
  keyboardWorkbenchSelectedKey = shouldPull ? key : "";
  const playerSlot = record.playerBindings?.find((binding) => binding.slot <= 4)?.slot;
  keyboardWorkbenchSelectedToken = shouldPull
    ? keyboardWorkbenchState.layoutMode === "players" && playerSlot
      ? `p:${playerSlot}:${key}`
      : `k:${key}`
    : "";
  applyKeyboardWorkbenchState(
    { ...keyboardWorkbenchState, selectedKeys: [...selected] },
    true,
  );
  keyboardWorkbenchAnnounce(
    shouldPull ? `${key} moved to the Key Workbench.` : `${key} returned to the keyboard.`,
  );
  if (focusFallbackIndex >= 0) {
    window.requestAnimationFrame(() => {
      const item = keyboardWorkbenchItem;
      if (!item) return;
      const remaining = Array.from(item.querySelectorAll<HTMLElement>(".n-deck-key"));
      const next = remaining[Math.min(focusFallbackIndex, remaining.length - 1)];
      if (next) {
        keyboardWorkbenchSetSelected(
          next.dataset.keylabKey ?? "",
          next.dataset.keylabToken ?? "",
        );
        next.focus({ preventScroll: true });
      } else {
        keyboardWorkbenchSetSelected("");
        item.querySelector<HTMLButtonElement>('[data-nx="kb-workbench"]')
          ?.focus({ preventScroll: true });
      }
    });
  }
}

function pullMappedKeyboardWorkbenchKeys(): void {
  const mapped = keyboardWorkbenchRecords()
    .filter((record) => record.cls.split(/\s+/).includes("bound"))
    .map((record) => record.key);
  if (mapped.length === 0) return;
  const selected = new Set(keyboardWorkbenchState.selectedKeys);
  for (const key of mapped) selected.add(key);
  keyboardWorkbenchSelectedKey = mapped[0];
  keyboardWorkbenchSelectedToken = `k:${mapped[0]}`;
  applyKeyboardWorkbenchState(
    { ...keyboardWorkbenchState, selectedKeys: [...selected] },
    true,
  );
  keyboardWorkbenchAnnounce(
    `${mapped.length} mapped ${mapped.length === 1 ? "key" : "keys"} for the selected player added. Existing panel keys stayed in place.`,
  );
}

function repackKeyboardWorkbench(): void {
  if (keyboardWorkbenchSelectedKey) {
    keyboardWorkbenchSelectedToken = `k:${keyboardWorkbenchSelectedKey}`;
  }
  applyKeyboardWorkbenchState({ ...keyboardWorkbenchState, layoutMode: "compact" }, true);
  keyboardWorkbenchAnnounce("Compact arrangement applied.");
}

function setKeyboardWorkbenchCapProfile(profile: string): void {
  chooseKeyboardCapProfile(profile);
}

function clearKeyboardWorkbenchKeys(): void {
  if (keyboardWorkbenchState.selectedKeys.length === 0) return;
  keyboardWorkbenchSelectedKey = "";
  keyboardWorkbenchSelectedToken = "";
  applyKeyboardWorkbenchState(
    { ...keyboardWorkbenchState, selectedKeys: [], positions: {}, layoutMode: "compact" },
    true,
  );
  keyboardWorkbenchAnnounce("Every pulled key returned to the keyboard.");
}

function returnSelectedKeyboardWorkbenchKey(): void {
  if (keyboardWorkbenchSelectedKey) toggleKeyboardWorkbenchKey(keyboardWorkbenchSelectedKey, false);
}

function keyboardWorkbenchMoveState(
  token: string,
  position: { x: number; y: number },
): KeyboardWorkbenchState {
  const players = keyboardWorkbenchState.layoutMode === "players";
  let state = keyboardWorkbenchState;
  if (!players && state.layoutMode !== "free") {
    const positions = { ...state.positions };
    for (const record of keyboardWorkbenchPlacedKeys()) {
      positions[record.instanceId] = { x: record.x, y: record.y };
    }
    state = { ...state, positions, layoutMode: "free" };
  }
  return withKeyboardWorkbenchPosition(
    { ...state, layoutMode: players ? "players" : "free" },
    token,
    position,
  );
}

function nudgeKeyboardWorkbenchKey(
  key: string,
  token: string,
  dx: number,
  dy: number,
): void {
  const current = keyboardWorkbenchPlacedKeys().find((record) => record.instanceId === token);
  if (!current) return;
  keyboardWorkbenchSelectedKey = key;
  keyboardWorkbenchSelectedToken = token;
  const moved = keyboardWorkbenchMoveState(token, { x: current.x + dx, y: current.y + dy });
  applyKeyboardWorkbenchState(moved, true);
}

function keyboardWorkbenchPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary) return;
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".n-deck-key");
  const deck = button?.closest<HTMLElement>(".n-keylab-deck");
  const key = button?.dataset.keylabKey ?? "";
  const token = button?.dataset.keylabToken ?? "";
  if (!button || !deck || !key || !token) return;
  const placed = keyboardWorkbenchPlacedKeys().find((record) => record.instanceId === token);
  const rect = deck.getBoundingClientRect();
  if (!placed || rect.width <= 0 || rect.height <= 0) return;
  event.preventDefault();
  event.stopPropagation();
  keyboardWorkbenchSetSelected(key, token);
  setInspectorContext({ kind: "key", key });
  button.focus({ preventScroll: true });
  button.classList.add("dragging");
  button.setPointerCapture(event.pointerId);
  keyboardWorkbenchDrag = {
    pointerId: event.pointerId,
    key,
    token,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: placed.x,
    startY: placed.y,
    scaleX: KEYBOARD_WORKBENCH_BOUNDS.width / rect.width,
    scaleY: KEYBOARD_WORKBENCH_BOUNDS.height / rect.height,
    moved: false,
  };
}

function keyboardWorkbenchPointerMove(event: PointerEvent): void {
  const drag = keyboardWorkbenchDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved) {
    drag.moved = Math.hypot(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    ) >= 4;
    if (!drag.moved) return;
  }
  const current = keyboardWorkbenchPlacedKeys().find((record) => record.instanceId === drag.token);
  if (!current) return;
  const nextX = drag.startX + (event.clientX - drag.startClientX) * drag.scaleX;
  const nextY = drag.startY + (event.clientY - drag.startClientY) * drag.scaleY;
  keyboardWorkbenchState = keyboardWorkbenchMoveState(drag.token, { x: nextX, y: nextY });
  const button = keyboardWorkbenchItem?.querySelector<HTMLElement>(
    `.n-deck-key[data-keylab-token="${CSS.escape(drag.token)}"]`,
  );
  const moved = keyboardWorkbenchPlacedKeys().find((record) => record.instanceId === drag.token);
  if (button && moved) {
    button.style.left = `${(moved.x / KEYBOARD_WORKBENCH_BOUNDS.width) * 100}%`;
    button.style.top = `${(moved.y / KEYBOARD_WORKBENCH_BOUNDS.height) * 100}%`;
  }
  syncKeyboardWorkbenchToolbar();
}

function keyboardWorkbenchPointerEnd(event: PointerEvent): void {
  const drag = keyboardWorkbenchDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  keyboardWorkbenchDrag = null;
  keyboardWorkbenchItem
    ?.querySelector<HTMLElement>(`.n-deck-key[data-keylab-token="${CSS.escape(drag.token)}"]`)
    ?.classList.remove("dragging");
  if (!drag.moved) {
    // A canceled pointer sequence is not an activation. Only a completed tap
    // may satisfy a waiting control or replace the currently selected key.
    if (event.type === "pointerup") {
      if (resolveLearnWithKey(drag.key, event.shiftKey || chainWanted())) return;
      if (assignKey) cancelAssign();
    }
    return;
  }
  saveKeyboardWorkbenchPrefs();
  renderKeyboardWorkbenchKeys();
  keyboardWorkbenchAnnounce(
    `${drag.key}${drag.token.startsWith("p:") ? " player view" : ""} placed in a custom layout.`,
  );
}

function selectedControlSurfaceControl(): ControlSurfaceControl | null {
  return controlSurfaceState.controls.find(
    (control) => control.id === controlSurfaceState.selectedControlId,
  ) ?? null;
}

function selectedControlSurfaceChannel(): ControlSurfaceChannel | null {
  const control = selectedControlSurfaceControl();
  return control?.channels.find(
    (channel) => channel.id === controlSurfaceState.selectedChannelId,
  ) ?? control?.channels[0] ?? null;
}

function controlSurfaceRoutesForKey(key: string): { slot: number; label: string; title: string }[] {
  if (!key) return [];
  const routes: { slot: number; label: string; title: string }[] = [];
  for (const pad of lastBindView?.pads ?? []) {
    for (const [functionName, joinedKeys] of Object.entries(pad.fn_keys)) {
      const keys = joinedKeys.split(/\s*·\s*/u).map((candidate) => candidate.trim());
      if (!keys.includes(key)) continue;
      routes.push({
        slot: pad.slot,
        label: `P${pad.slot} ${pad.fn_names[functionName] || functionName}`,
        title: `${key} routes to ${pad.title || `Player ${pad.slot}`} · ${pad.fn_names[functionName] || functionName}`,
      });
    }
  }
  return routes;
}

function controlSurfaceRelationship(
  control: ControlSurfaceControl,
): "mirror" | "duplicate" | "shared-signal" | "single" {
  if (control.physicalResolution === "unresolved-shared-signal") {
    return "shared-signal";
  }
  if (controlSurfaceState.controls.some(
    (candidate) => candidate.id !== control.id && candidate.physicalId === control.physicalId,
  )) {
    return "mirror";
  }
  const keys = new Set(
    control.channels
      .map((channel) => controlSurfaceSignalTruth(channel).flowKey)
      .filter(Boolean),
  );
  if (
    keys.size > 0 &&
    controlSurfaceState.controls.some((candidate) =>
      candidate.id !== control.id &&
      candidate.physicalId !== control.physicalId &&
      candidate.channels.some(
        (channel) => keys.has(controlSurfaceSignalTruth(channel).flowKey),
      )
    )
  ) {
    return "duplicate";
  }
  return "single";
}

function syncControlSurfaceInspector(): void {
  const item = controlSurfaceItem;
  const inspector = item?.querySelector<HTMLElement>(".n-surface-inspector");
  if (!item || !inspector) return;
  const control = selectedControlSurfaceControl();
  const channel = selectedControlSurfaceChannel();
  const relationship = control ? controlSurfaceRelationship(control) : "single";
  const routeFlowKey = channel ? controlSurfaceSignalTruth(channel).flowKey : "";
  const routeRows = controlSurfaceRoutesForKey(routeFlowKey);
  const print = JSON.stringify({
    control,
    channel,
    relationship,
    routeRows,
    stage: controlSurfaceState.stage,
    selectedDevice: nCapInstance(),
  });
  if (print === controlSurfaceInspectorPrint && inspector.childElementCount > 0) return;
  controlSurfaceInspectorPrint = print;
  const active = document.activeElement instanceof HTMLElement &&
      inspector.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusToken = active?.dataset.nx ?? "";
  const focusPlayer = active?.dataset.playerSlot ?? "";
  const focusChannel = active?.dataset.surfaceChannelId ?? "";
  const focusMove = active?.dataset.surfaceMove ?? "";
  inspector.replaceChildren();

  const kicker = document.createElement("span");
  kicker.className = "n-surface-inspector-kick";
  kicker.textContent = control ? "Selected physical control" : "Nothing selected";
  const title = document.createElement("strong");
  title.className = "n-surface-inspector-title";
  title.textContent = control?.label ?? "Choose a component on the panel";
  const copy = document.createElement("p");
  copy.className = "n-surface-inspector-copy";
  if (!control || !channel) {
    copy.textContent = "Add or select a button, keycap, or stick. Design, teaching, and routing stay available in any order.";
    inspector.append(kicker, title, copy);
    return;
  }
  const routeKey = controlSurfaceRouteKey(channel);

  const relationshipCopy = relationship === "mirror"
    ? "Mirror · this is another view of the same physical control. Teaching either view updates both."
    : relationship === "duplicate"
    ? "Duplicate signal · this is a separate physical control that currently emits the same signal."
    : relationship === "shared-signal"
    ? "Shared host signal · mappings prove these views emit the same keyboard signal; the physical wiring is not confirmed yet."
    : "Independent physical control";
  copy.textContent = relationshipCopy;

  const identity = document.createElement("div");
  identity.className = "n-surface-identity-editor";
  const identityLabel = document.createElement("label");
  identityLabel.textContent = "Component name";
  const identityInput = document.createElement("input");
  identityInput.type = "text";
  identityInput.maxLength = 64;
  identityInput.value = control.label;
  identityInput.dataset.nx = "surface-label";
  identityInput.dataset.surfaceControlId = control.id;
  identityInput.setAttribute("aria-label", "Component name");
  identityLabel.append(identityInput);
  identity.append(identityLabel);

  const owner = document.createElement("div");
  owner.className = "n-surface-owner-picker";
  owner.setAttribute("role", "group");
  owner.setAttribute("aria-label", `${control.label} player view`);
  const ownerLabel = document.createElement("span");
  ownerLabel.textContent = "Player view";
  owner.append(ownerLabel);
  const ownerOptions: [number, string][] = [
    [0, "Panel-wide"],
    [1, "P1"],
    [2, "P2"],
    [3, "P3"],
    [4, "P4"],
  ];
  ownerOptions.forEach(([slot, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.nx = "surface-owner";
    button.dataset.playerSlot = String(slot);
    button.dataset.surfaceControlId = control.id;
    button.setAttribute("aria-pressed", String((control.playerSlot ?? 0) === slot));
    button.textContent = label;
    owner.append(button);
  });

  const channels = document.createElement("div");
  channels.className = "n-surface-channel-picker";
  channels.setAttribute("role", "group");
  channels.setAttribute("aria-label", `${control.label} input channels`);
  for (const candidate of control.channels) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.nx = "surface-channel";
    button.dataset.surfaceControlId = control.id;
    button.dataset.surfaceChannelId = candidate.id;
    button.setAttribute("aria-pressed", String(candidate.id === channel.id));
    button.textContent = candidate.label;
    channels.append(button);
  }

  const signal = document.createElement("div");
  signal.className = "n-surface-signal";
  const signalLabel = document.createElement("span");
  signalLabel.textContent = "Host signal";
  const signalValue = document.createElement("strong");
  signalValue.textContent = channel.input.kind === "keyboard"
    ? `Keyboard · ${channel.input.key}`
    : "Unassigned";
  const signalMeta = document.createElement("small");
  const selectedDevice = nCapInstance().trim();
  const verifiedDevice = channel.input.kind === "keyboard" &&
    Boolean(channel.input.device.trim()) && Boolean(selectedDevice) &&
    channel.input.device.trim().toLocaleUpperCase() === selectedDevice.toLocaleUpperCase();
  signalMeta.textContent = channel.input.kind === "keyboard"
    ? verifiedDevice
      ? `${channel.input.device} · verified against the selected Windows device`
      : `${channel.input.device || "existing mapping"} · inherited signal; re-teach to verify this physical source`
    : "Select Teach input, then press the real wired control.";
  signal.append(signalLabel, signalValue, signalMeta);

  const actions = document.createElement("div");
  actions.className = "n-surface-inspector-actions";
  const teach = makeKeyboardWorkbenchButton(
    channel.input.kind === "keyboard" ? "Re-teach input" : "Teach input",
    "surface-teach",
    "Listen for the signal Windows receives from this physical control without changing any mapping",
  );
  teach.disabled = false;
  const route = makeKeyboardWorkbenchButton(
    "Route in KSX",
    "surface-route",
    "Hold this learned signal, then choose one or more virtual-controller controls on the canvas",
  );
  route.disabled = !routeKey;
  if (!routeKey && channel.input.kind === "keyboard") {
    route.title = "Teach this physical input again before routing; its retained observation is not authoritative for the current hardware chart";
  }
  actions.append(teach, route);

  const routes = document.createElement("div");
  routes.className = "n-surface-routes";
  const routeTitle = document.createElement("span");
  routeTitle.className = "n-surface-routes-label";
  routeTitle.id = "n-surface-route-list-label";
  routeTitle.textContent = "Backend routes";
  const routeList = document.createElement("div");
  routeList.className = "n-surface-route-list";
  routeList.setAttribute("role", "list");
  routeList.setAttribute("aria-labelledby", routeTitle.id);
  routes.append(routeTitle, routeList);
  if (routeRows.length === 0) {
    const empty = document.createElement("span");
    empty.className = "n-surface-route-empty";
    empty.setAttribute("role", "listitem");
    empty.textContent = routeFlowKey
      ? "Not routed yet"
      : channel.input.kind === "keyboard"
      ? "Teach again before routing"
      : "Teach an input first";
    routeList.append(empty);
  } else {
    for (const routeRow of routeRows) {
      const badge = document.createElement("span");
      badge.className = `n-surface-route np${routeRow.slot}`;
      badge.setAttribute("role", "listitem");
      badge.title = routeRow.title;
      badge.textContent = routeRow.label;
      routeList.append(badge);
    }
  }

  const position = document.createElement("div");
  position.className = "n-surface-position";
  position.setAttribute("role", "group");
  position.setAttribute("aria-label", `Move ${control.label} without dragging`);
  const positionLabel = document.createElement("span");
  positionLabel.textContent = "Position";
  position.append(positionLabel);
  for (const [move, label, dx, dy] of [
    ["left", "Move left", -8, 0],
    ["up", "Move up", 0, -8],
    ["down", "Move down", 0, 8],
    ["right", "Move right", 8, 0],
  ] as const) {
    const button = makeKeyboardWorkbenchButton(label.replace("Move ", ""), "surface-nudge", `${label} ${control.label}`);
    button.dataset.surfaceControlId = control.id;
    button.dataset.surfaceChannelId = channel.id;
    button.dataset.surfaceMove = move;
    button.dataset.surfaceDx = String(dx);
    button.dataset.surfaceDy = String(dy);
    button.setAttribute("aria-label", `${label} ${control.label}`);
    position.append(button);
  }

  const copies = document.createElement("div");
  copies.className = "n-surface-inspector-actions secondary";
  if (relationship === "shared-signal") {
    const resolution = document.createElement("div");
    resolution.className = "n-surface-resolution";
    const resolutionLabel = document.createElement("span");
    resolutionLabel.textContent = "Confirm the wiring";
    resolution.append(
      resolutionLabel,
      makeKeyboardWorkbenchButton(
        "Link as one physical control",
        "surface-resolve-mirror",
        "Confirm that every unresolved view carrying this signal represents one physical switch",
      ),
      makeKeyboardWorkbenchButton(
        "Confirm separate controls",
        "surface-resolve-duplicate",
        "Confirm that each unresolved view carrying this signal is independently wired",
      ),
    );
    inspector.append(kicker, title, copy, identity, owner, channels, signal, actions, routes, position, resolution, copies);
  } else {
    inspector.append(kicker, title, copy, identity, owner, channels, signal, actions, routes, position, copies);
  }
  if (relationship !== "shared-signal") {
    copies.append(
      makeKeyboardWorkbenchButton(
      "Mirror view",
      "surface-mirror",
      "Show this same physical control somewhere else; both views stay linked",
      ),
      makeKeyboardWorkbenchButton(
      "Duplicate control",
      "surface-duplicate",
      "Add a separate physical control with the same current signal",
      ),
    );
  }
  copies.append(
    makeKeyboardWorkbenchButton(
      "Remove",
      "surface-remove",
      "Remove this visual physical control; KSX mappings remain unchanged",
    ),
  );
  if (focusToken) {
    let selector = `[data-nx="${CSS.escape(focusToken)}"]`;
    if (focusPlayer) selector += `[data-player-slot="${CSS.escape(focusPlayer)}"]`;
    if (focusChannel) selector += `[data-surface-channel-id="${CSS.escape(focusChannel)}"]`;
    if (focusMove) selector += `[data-surface-move="${CSS.escape(focusMove)}"]`;
    inspector.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }
}

function controlSurfaceSignalClearance(deck: HTMLElement, channelCount: number): number {
  // clientHeight is the untransformed layout box. getBoundingClientRect()
  // includes canvas zoom, while these signal-row dimensions are CSS pixels;
  // mixing them makes bottom docking change when the user zooms the canvas.
  const layoutHeight = deck.clientHeight;
  const modelUnitsPerPixel = layoutHeight > 0
    ? CONTROL_SURFACE_BOUNDS.height / layoutHeight
    : 1;
  return (4 + channelCount * 17) * modelUnitsPerPixel;
}

function renderControlSurfaceControls(): void {
  const item = controlSurfaceItem;
  const deck = item?.querySelector<HTMLElement>(".n-surface-deck");
  if (!item || !deck) return;
  const existing = new Map<string, HTMLButtonElement>();
  for (const button of Array.from(deck.querySelectorAll<HTMLButtonElement>(".n-surface-control"))) {
    existing.set(button.dataset.surfaceControlId ?? "", button);
  }
  for (const control of controlSurfaceState.controls) {
    let button = existing.get(control.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "n-surface-control";
      const face = document.createElement("span");
      face.className = "n-surface-control-face";
      const label = document.createElement("span");
      label.className = "n-surface-control-label";
      const signal = document.createElement("span");
      signal.className = "n-surface-control-signal";
      const relation = document.createElement("span");
      relation.className = "n-surface-control-relation";
      button.append(face, label, signal, relation);
    }
    existing.delete(control.id);
    const relationship = controlSurfaceRelationship(control);
    const selected = control.id === controlSurfaceState.selectedControlId;
    const encoderChannels: ControlSurfaceChannel[] = [];
    const verifiedEncoderChannels = encoderChannels.filter((channel) => {
      const authority = controlSurfaceSignalTruth(channel).authority;
      return authority === "matched" || authority === "mismatch";
    });
    const expected = encoderChannels.length > 0;
    const taught = expected
      ? verifiedEncoderChannels.length === encoderChannels.length
      : control.channels.some(
          (channel) => controlSurfaceSignalTruth(channel).authority === "observed",
        );
    const partiallyTaught = expected && verifiedEncoderChannels.length > 0 && !taught;
    const encoderMismatch = control.channels.some(
      (channel) => controlSurfaceSignalTruth(channel).authority === "mismatch",
    );
    const teaching = learnRow?.purpose === "surface" &&
      learnRow.surfaceIdentity === controlSurfaceIdentity &&
      learnRow.surfaceControlId === control.id;
    const assigning = Boolean(assignKey) && control.channels.some(
      (channel) => controlSurfaceSignalTruth(channel).flowKey === assignKey,
    );
    button.className = `n-surface-control kind-${control.kind}${selected ? " selected" : ""}${taught ? " taught" : expected ? " expected" : " unassigned"}${partiallyTaught ? " partially-taught" : ""}${encoderMismatch ? " encoder-mismatch" : ""}${relationship !== "single" ? ` ${relationship}` : ""}${control.playerSlot ? ` np${control.playerSlot}` : ""}${teaching ? " teach" : ""}${assigning ? " assign" : ""}`;
    button.dataset.surfaceControlId = control.id;
    button.dataset.controlKind = control.kind;
    button.dataset.physicalId = control.physicalId;
    if (control.playerSlot === null) delete button.dataset.playerSlot;
    else button.dataset.playerSlot = String(control.playerSlot);
    button.style.left = `${(control.x / CONTROL_SURFACE_BOUNDS.width) * 100}%`;
    button.style.top = `${(control.y / CONTROL_SURFACE_BOUNDS.height) * 100}%`;
    button.style.width = `${(control.width / CONTROL_SURFACE_BOUNDS.width) * 100}%`;
    button.style.height = `${(control.height / CONTROL_SURFACE_BOUNDS.height) * 100}%`;
    const signalBlockHeight = controlSurfaceSignalClearance(deck, control.channels.length);
    button.dataset.signalV = control.y + control.height + signalBlockHeight >
        CONTROL_SURFACE_BOUNDS.height
      ? "above"
      : "below";
    button.dataset.signalH = control.x < 96
      ? "left"
      : control.x + control.width > CONTROL_SURFACE_BOUNDS.width - 96
      ? "right"
      : "center";
    const inputCopy = control.channels
      .map((channel) => {
        const truth = controlSurfaceSignalTruth(channel);
        const terminal = "";
        if (truth.authority === "planned") {
          return `${channel.label}: ${terminal} currently emits ${truth.configuredKey || "Disabled"}; draft plans ${truth.plannedKey || "Disabled"}, not written`;
        }
        if (truth.authority === "matched") {
          return `${channel.label}: ${terminal} is configured for ${truth.configuredKey || truth.plannedKey}; Windows Teach verified ${truth.observedKey}`;
        }
        if (truth.authority === "mismatch") {
          return `${channel.label}: ${terminal} is configured for ${truth.configuredKey || truth.plannedKey}; Windows Teach observed ${truth.observedKey}`;
        }
        if (truth.authority === "configured") {
          return `${channel.label}: ${terminal} is configured for ${truth.configuredKey}, not Teach-verified`;
        }
        if (truth.authority === "expected") {
          return `${channel.label}: ${terminal} is expected to emit ${truth.plannedKey}; read the board to confirm`;
        }
        if (truth.authority === "observed") {
          return `${channel.label}: Windows observed ${truth.observedKey}`;
        }
        return `${channel.label}: unassigned`;
      })
      .join(" · ");
    const kindCopy = control.kind === "button30"
      ? "30 millimeter arcade button"
      : control.kind === "button24"
      ? "24 millimeter arcade button"
      : control.kind === "joystick"
      ? "joystick"
      : "mechanical keycap";
    const ownerCopy = control.playerSlot === null ? "panel-wide" : `P${control.playerSlot} view`;
    const relationCopy = relationship === "mirror"
      ? " · linked mirror of one physical control"
      : relationship === "duplicate"
      ? " · separate control emitting a duplicate signal"
      : relationship === "shared-signal"
      ? " · shared mapped signal; physical relationship not confirmed"
      : "";
    button.title = `${control.label} · ${kindCopy} · ${ownerCopy} · ${inputCopy}${relationCopy} · drag or use arrow keys to arrange`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(selected));
    const label = button.querySelector<HTMLElement>(".n-surface-control-label");
    const signal = button.querySelector<HTMLElement>(".n-surface-control-signal");
    const relation = button.querySelector<HTMLElement>(".n-surface-control-relation");
    if (label) label.textContent = control.label;
    if (signal) {
      signal.replaceChildren();
      signal.dataset.channelCount = String(control.channels.length);
      for (const channel of control.channels) {
        const encoder = undefined;
        const truth = controlSurfaceSignalTruth(channel);
        const expectedKey = truth.plannedKey;
        const observedKey = truth.observedKey;
        const verification = truth.authority;
        const flowKey = truth.flowKey;
        const pendingPlan = false;
        const chain = document.createElement("span");
        chain.className = `n-surface-signal-chain channel-${channel.id}`;
        chain.dataset.surfaceChannelId = channel.id;
        chain.dataset.verification = verification;
        if (encoder?.terminalId) chain.dataset.terminalId = encoder.terminalId;

        const stem = document.createElement("span");
        stem.className = "n-surface-signal-stem";
        stem.setAttribute("aria-hidden", "true");
        if (control.kind === "joystick") {
          const direction = document.createElement("span");
          direction.className = "n-surface-signal-direction";
          direction.textContent = channel.label.slice(0, 1).toLocaleUpperCase();
          direction.title = channel.label;
          chain.append(direction);
        }
        if (encoder?.terminalId || !observedKey) {
          const terminal = document.createElement("span");
          terminal.className = "n-surface-terminal-chip";
          terminal.textContent = encoder?.terminalId
            ? encoder.terminalId.toLocaleUpperCase().replace(/^([1-4])/, "P$1 ")
            : "UNLINKED";
          terminal.title = "No encoder terminal is linked to this physical channel";
          chain.append(stem, terminal);
          const arrow = document.createElement("span");
          arrow.className = "n-surface-signal-arrow";
          arrow.textContent = "→";
          arrow.setAttribute("aria-hidden", "true");
          chain.append(arrow);
        } else {
          chain.append(stem);
        }

        const keycap = document.createElement("kbd");
        keycap.className = `n-surface-signal-keycap n-surface-channel-anchor channel-${channel.id}`;
        keycap.dataset.surfaceChannelId = channel.id;
        keycap.dataset.surfaceControlId = control.id;
        keycap.dataset.controlKind = control.kind;
        keycap.dataset.selected = String(
          selected && channel.id === controlSurfaceState.selectedChannelId,
        );
        keycap.dataset.flowAuthority = truth.flowAuthority;
        if (control.playerSlot !== null) keycap.dataset.playerSlot = String(control.playerSlot);
        if (expectedKey) keycap.dataset.expectedKey = expectedKey;
        if (truth.configuredKnown) keycap.dataset.configuredKey = truth.configuredKey;
        if (pendingPlan) keycap.dataset.plannedKey = expectedKey;
        if (flowKey) keycap.dataset.flowKey = flowKey;
        if (observedKey) keycap.dataset.lastObservedKey = observedKey;
        if (observedKey &&
            (verification === "matched" || verification === "mismatch" ||
              verification === "observed")) {
          keycap.dataset.key = observedKey;
        }
        if (verification === "mismatch") {
          const expected = document.createElement("span");
          expected.className = "n-surface-key-expected";
          expected.textContent = truth.configuredKey || expectedKey;
          const divider = document.createElement("span");
          divider.className = "n-surface-key-divider";
          divider.textContent = "≠";
          const observed = document.createElement("strong");
          observed.textContent = observedKey;
          keycap.append(expected, divider, observed);
        } else if (verification === "planned") {
          const current = document.createElement("span");
          current.className = "n-surface-key-current";
          current.textContent = truth.configuredKey || "OFF";
          const divider = document.createElement("span");
          divider.className = "n-surface-key-divider";
          divider.textContent = "→";
          const planned = document.createElement("strong");
          planned.textContent = expectedKey || "OFF";
          const state = document.createElement("small");
          state.textContent = "PLAN";
          keycap.append(current, divider, planned, state);
        } else {
          const key = document.createElement("strong");
          key.textContent = verification === "expected" ? expectedKey || "?" : flowKey || "?";
          const state = document.createElement("small");
          state.textContent = verification === "matched"
            ? "✓"
            : verification === "configured"
            ? "?"
            : verification === "expected"
            ? "PLAN?"
            : verification === "observed"
            ? "LIVE"
            : "TEACH";
          keycap.append(key, state);
        }
        keycap.title = verification === "planned" && encoder
          ? `${encoder.terminalId.toLocaleUpperCase()} currently emits ${truth.configuredKey || "Disabled"}; the draft proposes ${expectedKey || "Disabled"}. Nothing changes until Program board verifies the write.`
          : verification === "matched" && encoder
          ? `${encoder.terminalId.toLocaleUpperCase()} is configured for ${truth.configuredKey || expectedKey}; Windows Teach verified the same key${pendingPlan ? `; the draft still proposes ${expectedKey || "Disabled"}` : ""}`
          : verification === "mismatch" && encoder
          ? `${encoder.terminalId.toLocaleUpperCase()} is configured for ${truth.configuredKey || expectedKey}; Windows Teach observed ${observedKey}${pendingPlan ? `; the draft still proposes ${expectedKey || "Disabled"}` : ""}`
          : verification === "configured" && encoder
          ? `${encoder.terminalId.toLocaleUpperCase()} is configured for ${truth.configuredKey}; ${observedKey ? `last Teach saw ${observedKey}, but that evidence is stale` : "press the wired control to verify it in Windows"}`
          : verification === "expected" && encoder
          ? `${encoder.terminalId.toLocaleUpperCase()} is expected to emit ${expectedKey}; read the complete hardware chart to confirm it`
          : verification === "observed"
          ? `Windows Teach observed ${observedKey}`
          : "Link an encoder terminal or Teach this physical control";
        keycap.setAttribute("aria-hidden", "true");
        chain.append(keycap);
        signal.append(chain);
      }
    }
    if (relation) {
      relation.textContent = relationship === "mirror"
        ? "LINK"
        : relationship === "duplicate"
        ? "DUPE"
        : relationship === "shared-signal"
        ? "SIGNAL?"
        : "";
    }

    deck.append(button);
  }
  for (const button of existing.values()) button.remove();
  deck.dataset.template = controlSurfaceState.template;
  deck.dataset.panelLayout = controlSurfaceState.panelLayout;
  deck.dataset.stage = controlSurfaceState.stage;
  deck.dataset.empty = String(controlSurfaceState.controls.length === 0);
  item.dataset.keyboardTheme = controlSurfaceState.theme;
  liveKeyNodes = null;
  syncControlSurfaceInspector();
  // Once a chart-linked physical panel owns every signal, fold the separate
  // encoder roster into its recoverable fallback shelf. Re-run when Teach or a
  // panel edit changes ownership so unresolved keys never disappear.
  mappingFlowLayer?.scheduleLayout();
}

function syncControlSurfaceChrome(): void {
  const item = controlSurfaceItem;
  if (!item) return;
  const choosing = !controlSurfaceState.started || controlSurfaceChoosingTemplate;
  const starters = item.querySelector<HTMLElement>(".n-surface-starters");
  const workarea = item.querySelector<HTMLElement>(".n-surface-workarea");
  const tools = item.querySelector<HTMLElement>(".n-surface-tools");
  const stages = item.querySelector<HTMLElement>(".n-surface-stages");
  const heading = item.querySelector<HTMLElement>("[data-surface-widget-kicker]");
  const sub = item.querySelector<HTMLElement>("[data-surface-widget-sub]");
  const note = item.querySelector<HTMLElement>("[data-surface-note]");
  const widgetName = "Control Surface Builder";
  item.dataset.entry = "builder";
  item.dataset.widgetName = widgetName;
  item.setAttribute("aria-label", widgetName);
  item.querySelector<HTMLElement>(".widget-drag-handle")
    ?.setAttribute("aria-label", `Move ${widgetName}`);
  if (heading) heading.textContent = widgetName;
  if (sub) {
    sub.textContent = "Arrange physical appearance · host signal → KSX route stays separate";
  }
  if (starters) starters.hidden = !choosing;
  if (workarea) workarea.hidden = choosing;
  if (tools) tools.hidden = choosing;
  if (stages) stages.hidden = false;
  if (note) {
    note.textContent =
      "Arrange the physical controls independently of their signal source. Teach host signals observes what each control sends; Route in KSX connects that signal to virtual controllers.";
  }
  const mappingRecords = controlSurfaceMappingRecords();
  const selectedSlot = Number(nSlotVal() || "1");
  for (const card of Array.from(item.querySelectorAll<HTMLButtonElement>("[data-surface-template]"))) {
    const template = card.dataset.surfaceTemplate as ControlSurfaceTemplate | undefined;
    const descriptor = CONTROL_SURFACE_TEMPLATES.find((candidate) => candidate.slug === template);
    const label = card.querySelector<HTMLElement>("strong");
    const pending = controlSurfaceState.started && controlSurfacePendingTemplate === template;
    card.classList.toggle("confirm", pending);
    card.setAttribute("aria-pressed", String(pending));
    if (label) {
      label.textContent = pending
        ? `Confirm replacement · ${descriptor?.label ?? template}`
        : `${controlSurfaceState.started ? "Replace with " : ""}${descriptor?.label ?? template}`;
    }
    if (template === "mapping-selected") {
      card.disabled = !mappingRecords.some((record) => record.slot === selectedSlot);
    } else if (template === "mapping-four") {
      card.disabled = !mappingRecords.some((record) => record.slot >= 1 && record.slot <= 4);
    }
  }
  const cancel = item.querySelector<HTMLButtonElement>('[data-nx="surface-template-cancel"]');
  if (cancel) cancel.hidden = !controlSurfaceState.started;
  const undo = item.querySelector<HTMLButtonElement>('[data-nx="surface-undo"]');
  if (undo) {
    undo.disabled = !controlSurfaceUndoState || controlSurfaceUndoIdentity !== controlSurfaceIdentity;
  }
  for (const stageButton of Array.from(item.querySelectorAll<HTMLButtonElement>("[data-surface-stage]"))) {
    stageButton.setAttribute(
      "aria-pressed",
      String(stageButton.dataset.surfaceStage === controlSurfaceState.stage),
    );
    stageButton.disabled = !controlSurfaceState.started;
  }
  const status = item.querySelector<HTMLElement>(".n-surface-status");
  if (status) {
    status.hidden = false;
    const physical = new Map<string, ControlSurfaceControl>();
    for (const control of controlSurfaceState.controls) {
      if (!physical.has(control.physicalId)) physical.set(control.physicalId, control);
    }
    const selectedDevice = nCapInstance().trim().toLocaleUpperCase();
    const verified = [...physical.values()].reduce(
      (count, control) => count + control.channels.filter((channel) =>
        Boolean(controlSurfaceRouteKey(channel)) && Boolean(selectedDevice) &&
        channel.input.device.trim().toLocaleUpperCase() === selectedDevice
      ).length,
      0,
    );
    const channels = [...physical.values()].reduce(
      (count, control) => count + control.channels.length,
      0,
    );
    const nextStatus = choosing
      ? controlSurfaceState.started
        ? "Choose a replacement only when you mean to reset this panel; Cancel keeps every current component."
        : "Choose a starting shape. Templates create physical controls only—no KSX mapping is changed."
      : `${physical.size} physical ${physical.size === 1 ? "component" : "components"} · ${controlSurfaceState.controls.length} visual ${controlSurfaceState.controls.length === 1 ? "view" : "views"} · ${verified} of ${channels} physical ${channels === 1 ? "input" : "inputs"} verified · ${
          controlSurfaceState.stage === "design"
            ? "Arrange appearance: add and place physical controls"
            : controlSurfaceState.stage === "teach"
            ? "Teach host signals: press what the selected device emits"
            : "Route in KSX: connect learned signals to virtual outputs"
        }${controlSurfaceSaveFailed ? " · Not saved: browser storage is unavailable" : " · Browser draft saved locally"}`;
    if (status.textContent !== nextStatus) status.textContent = nextStatus;
  }
  renderControlSurfaceControls();
}

function createControlSurfaceItem(): HTMLElement {
  const content = document.createElement("div");
  content.className = "n-surface";
  content.setAttribute("data-forma-runtime-host", "");

  const head = document.createElement("div");
  head.className = "n-surface-head";
  const heading = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "n-kick";
  kicker.dataset.surfaceWidgetKicker = "";
  kicker.textContent = "Control Surface Builder";
  const sub = document.createElement("span");
  sub.className = "n-surface-sub";
  sub.dataset.surfaceWidgetSub = "";
  sub.textContent = "Arrange physical appearance · host signal and KSX route stay separate";
  heading.append(kicker, sub);
  const close = makeKeyboardWorkbenchButton(
    "Close",
    "surface-close",
    "Close the builder without discarding this panel",
  );
  close.classList.add("quiet");
  head.append(heading, close);

  const hardware = document.createElement("section");
  hardware.className = "n-surface-hardware";
  hardware.setAttribute("aria-labelledby", "n-surface-hardware-title");
  hardware.dataset.state = "idle";
  const hardwareHead = document.createElement("div");
  hardwareHead.className = "n-surface-hardware-head";
  const hardwareHeading = document.createElement("div");
  const hardwareKicker = document.createElement("span");
  hardwareKicker.className = "n-surface-hardware-kick";
  hardwareKicker.textContent = "Selected encoder";
  const hardwareName = document.createElement("strong");
  hardwareName.id = "n-surface-hardware-title";
  hardwareName.dataset.surfaceHardwareName = "";
  hardwareName.textContent = "Status not inspected";
  hardwareHeading.append(hardwareKicker, hardwareName);
  const hardwareRefresh = makeKeyboardWorkbenchButton(
    "Refresh status",
    "surface-hardware-refresh",
    "Read the selected encoder's identity, mode, and read-back capabilities without changing it",
  );
  hardwareRefresh.classList.add("quiet", "n-surface-hardware-refresh");
  const hardwareActions = document.createElement("div");
  hardwareActions.className = "n-surface-hardware-actions";
  const encoderSetup = makeKeyboardWorkbenchButton(
    "Inspect to continue",
    "surface-encoder-open",
    "Inspect this exact encoder before opening hardware configuration",
  );
  encoderSetup.classList.add("n-surface-encoder-open");
  encoderSetup.setAttribute("aria-controls", "n-surface-programming");
  encoderSetup.setAttribute("aria-expanded", "false");
  hardwareActions.append(hardwareRefresh, encoderSetup);
  hardwareHead.append(hardwareHeading, hardwareActions);

  const hardwareStatus = document.createElement("div");
  hardwareStatus.className = "n-surface-hardware-status";
  hardwareStatus.setAttribute("role", "status");
  hardwareStatus.setAttribute("aria-live", "polite");
  hardwareStatus.setAttribute("aria-atomic", "true");
  const hardwareIdentity = document.createElement("span");
  hardwareIdentity.className = "n-surface-hardware-identity";
  hardwareIdentity.dataset.surfaceHardwareIdentity = "";
  const hardwareMode = document.createElement("span");
  hardwareMode.className = "n-surface-hardware-mode";
  hardwareMode.dataset.surfaceHardwareMode = "";
  hardwareMode.dataset.tone = "neutral";
  const hardwareSummary = document.createElement("p");
  hardwareSummary.className = "n-surface-hardware-summary";
  hardwareSummary.dataset.surfaceHardwareSummary = "";
  const hardwareDetails = document.createElement("details");
  hardwareDetails.className = "n-surface-hardware-details";
  hardwareDetails.dataset.surfaceHardwareDetails = "";
  hardwareDetails.hidden = true;
  const hardwareDetailsSummary = document.createElement("summary");
  hardwareDetailsSummary.textContent = "Inspection details";
  const hardwareCapabilities = document.createElement("dl");
  hardwareCapabilities.className = "n-surface-hardware-capabilities";
  hardwareCapabilities.dataset.surfaceHardwareCapabilities = "";
  hardwareCapabilities.hidden = true;
  const hardwareAccessRow = document.createElement("div");
  const hardwareAccessTerm = document.createElement("dt");
  hardwareAccessTerm.textContent = "Inspection access";
  const hardwareAccessValue = document.createElement("dd");
  hardwareAccessValue.dataset.surfaceHardwareAccess = "";
  hardwareAccessRow.append(hardwareAccessTerm, hardwareAccessValue);
  const hardwareDriverRow = document.createElement("div");
  const hardwareDriverTerm = document.createElement("dt");
  hardwareDriverTerm.textContent = "Panel driver";
  const hardwareDriverValue = document.createElement("dd");
  hardwareDriverValue.dataset.surfaceHardwareDriver = "";
  hardwareDriverRow.append(hardwareDriverTerm, hardwareDriverValue);
  const hardwareConfigurationRow = document.createElement("div");
  const hardwareConfigurationTerm = document.createElement("dt");
  hardwareConfigurationTerm.textContent = "Configuration collection";
  const hardwareConfigurationValue = document.createElement("dd");
  hardwareConfigurationValue.dataset.surfaceHardwareConfiguration = "";
  hardwareConfigurationRow.append(hardwareConfigurationTerm, hardwareConfigurationValue);
  const hardwareChartRow = document.createElement("div");
  const hardwareChartTerm = document.createElement("dt");
  hardwareChartTerm.textContent = "Chart read-back";
  const hardwareChartValue = document.createElement("dd");
  const hardwareChartLabel = document.createElement("strong");
  hardwareChartLabel.dataset.surfaceHardwareChart = "";
  const hardwareChartDetail = document.createElement("small");
  hardwareChartDetail.dataset.surfaceHardwareChartDetail = "";
  hardwareChartValue.append(hardwareChartLabel, hardwareChartDetail);
  hardwareChartRow.append(hardwareChartTerm, hardwareChartValue);
  hardwareCapabilities.append(
    hardwareAccessRow,
    hardwareDriverRow,
    hardwareConfigurationRow,
    hardwareChartRow,
  );
  const hardwareRecommendation = document.createElement("p");
  hardwareRecommendation.className = "n-surface-hardware-recommendation";
  hardwareRecommendation.dataset.surfaceHardwareRecommendation = "";
  const hardwareNote = document.createElement("p");
  hardwareNote.className = "n-surface-hardware-note";
  hardwareNote.dataset.surfaceHardwareNote = "";
  hardwareDetails.append(
    hardwareDetailsSummary,
    hardwareCapabilities,
    hardwareRecommendation,
  );
  hardwareStatus.append(
    hardwareIdentity,
    hardwareMode,
    hardwareSummary,
    hardwareDetails,
    hardwareNote,
  );
  hardware.append(hardwareHead, hardwareStatus);

  const programming = document.createElement("section");
  programming.id = "n-surface-programming";
  programming.className = "n-surface-programming";
  programming.hidden = true;
  const signalJourney = document.createElement("ol");
  signalJourney.className = "n-panel-signal-journey";
  signalJourney.setAttribute("aria-label", "Physical control to game signal journey");
  ([
    ["physical", "1", "Panel control", "Button, stick, or key"],
    ["encoder", "2", "I-PAC", "Wired terminal"],
    ["keys", "3", "Host signal", "Keyboard key emitted to Windows"],
    ["mapping", "4", "KSX transform", "Route, macro, or behavior"],
    ["controller", "5", "Virtual controller", "Game-facing target"],
    ["game", "6", "Game", "Receives when running"],
  ] as const).forEach(([step, number, label, detail]) => {
    const item = document.createElement("li");
    item.dataset.panelJourneyStep = step;
    item.dataset.state = "upcoming";
    const badge = document.createElement("span");
    badge.textContent = number;
    const copy = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = label;
    if (step === "encoder") strong.dataset.panelJourneyEncoderLabel = "";
    const small = document.createElement("small");
    small.textContent = detail;
    copy.append(strong, small);
    item.append(badge, copy);
    signalJourney.append(item);
  });
  const programmingHead = document.createElement("div");
  programmingHead.className = "n-surface-programming-head";
  const programmingHeading = document.createElement("div");
  const programmingKicker = document.createElement("span");
  programmingKicker.dataset.surfaceProgrammingKicker = "";
  programmingKicker.textContent = "Encoder hardware";
  const programmingTitle = document.createElement("strong");
  programmingTitle.dataset.surfaceProgrammingTitle = "";
  programmingTitle.textContent = "Edit, save, clear, or program the complete 56-terminal chart";
  programmingHeading.append(programmingKicker, programmingTitle);
  const programmingClose = makeKeyboardWorkbenchButton(
    "Close setup",
    "surface-encoder-close",
    "Close encoder setup without changing the hardware",
  );
  programmingClose.classList.add("quiet");
  programmingHead.append(programmingHeading, programmingClose);
  const programmingSummary = document.createElement("p");
  programmingSummary.className = "n-surface-programming-summary";
  programmingSummary.dataset.surfaceProgrammingSummary = "";
  programmingSummary.setAttribute("role", "status");
  programmingSummary.setAttribute("aria-live", "polite");
  programmingSummary.textContent = "Read and back up the complete encoder chart before changing terminal assignments.";
  const programmingDevice = document.createElement("dl");
  programmingDevice.className = "n-surface-programming-device n-surface-board-facts";
  programmingDevice.dataset.surfaceProgrammingDevice = "";
  programmingDevice.dataset.surfaceBoardFacts = "";
  programmingDevice.setAttribute("aria-label", "Selected I-PAC facts");
  const programmingQualification = document.createElement("aside");
  programmingQualification.className = "n-surface-programming-qualification";
  programmingQualification.dataset.surfaceProgrammingQualification = "";
  programmingQualification.setAttribute("aria-live", "polite");
  programmingQualification.hidden = true;
  const qualificationStep = document.createElement("span");
  qualificationStep.dataset.surfaceQualificationStep = "";
  qualificationStep.textContent = "Writer check · step 1 of 2";
  const qualificationTitle = document.createElement("strong");
  qualificationTitle.dataset.surfaceQualificationTitle = "";
  qualificationTitle.textContent = "Verify this encoder before writing a full layout";
  const qualificationDetail = document.createElement("p");
  qualificationDetail.dataset.surfaceQualificationDetail = "";
  qualificationDetail.textContent =
    "Choose one noncritical SW action button—not a direction, Start, or Coin—with a readable normal assignment and Shift state explicitly disabled. Change it to one safe letter or top-row number so exactly one desired byte differs. Programming still retransmits the complete 256-byte chart as all 64 HID reports; review that full-write consent, then restore its exact safety backup.";
  const qualificationPicker = document.createElement("div");
  qualificationPicker.className = "n-surface-qualification-picker";
  qualificationPicker.dataset.surfaceQualificationPicker = "";
  const qualificationTerminalLabel = document.createElement("label");
  const qualificationTerminalText = document.createElement("span");
  qualificationTerminalText.textContent = "Wired test terminal";
  const qualificationTerminalSelect = document.createElement("select");
  qualificationTerminalSelect.dataset.nx = "surface-qualification-terminal";
  qualificationTerminalSelect.setAttribute("aria-label", "I-PAC safety-test terminal");
  qualificationTerminalLabel.append(qualificationTerminalText, qualificationTerminalSelect);
  const qualificationKeyLabel = document.createElement("label");
  const qualificationKeyText = document.createElement("span");
  qualificationKeyText.textContent = "Temporary test key";
  const qualificationKeySelect = document.createElement("select");
  qualificationKeySelect.dataset.nx = "surface-qualification-key";
  qualificationKeySelect.setAttribute("aria-label", "I-PAC safety-test key");
  qualificationKeyLabel.append(qualificationKeyText, qualificationKeySelect);
  const qualificationSelection = document.createElement("p");
  qualificationSelection.dataset.surfaceQualificationSelection = "";
  qualificationSelection.setAttribute("role", "status");
  qualificationPicker.append(
    qualificationTerminalLabel,
    qualificationKeyLabel,
    qualificationSelection,
  );
  programmingQualification.append(
    qualificationStep,
    qualificationTitle,
    qualificationDetail,
    qualificationPicker,
  );
  const programmingConflicts = document.createElement("ul");
  programmingConflicts.className = "n-surface-programming-conflicts";
  programmingConflicts.dataset.surfaceProgrammingConflicts = "";
  programmingConflicts.setAttribute("role", "alert");
  programmingConflicts.hidden = true;
  const programmingModes = document.createElement("div");
  programmingModes.className = "n-surface-programming-modes";
  programmingModes.setAttribute("role", "group");
  programmingModes.setAttribute("aria-label", "Start hardware layout from");
  ([
    ["keep-current", "Use current outputs", "Keep the terminal-to-key chart already on this I-PAC, test it, or edit only what you want."],
    ["recommended", "KSX four-player", "Preview 56 unique Windows key signals arranged for four players, then program only after review."],
    ["custom", "Use panel design", "Start from terminal and key links in the optional physical panel design."],
  ] as const).forEach(([mode, label, description]) => {
    const button = makeKeyboardWorkbenchButton(label, "surface-encoder-mode", description, mode);
    button.dataset.surfaceProgrammingMode = mode;
    button.dataset.surfaceProgrammingDescription = description;
    const copy = document.createElement("small");
    copy.textContent = description;
    button.append(copy);
    programmingModes.append(button);
  });
  const profiles = document.createElement("section");
  profiles.className = "n-surface-hardware-profiles";
  const profilesHead = document.createElement("div");
  const profilesTitle = document.createElement("strong");
  profilesTitle.textContent = "Saved hardware layouts";
  const profilesSummary = document.createElement("span");
  profilesSummary.dataset.surfaceProfilesSummary = "";
  profilesSummary.textContent = "Loading KSX profiles…";
  profilesHead.append(profilesTitle, profilesSummary);
  const profilesPicker = document.createElement("div");
  profilesPicker.className = "n-surface-profile-picker";
  const profileSelect = document.createElement("select");
  profileSelect.dataset.surfaceProfile = "";
  profileSelect.setAttribute("aria-label", "Saved I-PAC hardware layout");
  const profilePlaceholder = document.createElement("option");
  profilePlaceholder.value = "";
  profilePlaceholder.textContent = "Choose a saved layout";
  profileSelect.append(profilePlaceholder);
  const profileUse = makeKeyboardWorkbenchButton(
    "Use saved",
    "surface-profile-use",
    "Load this saved semantic layout into the editor without programming the board",
  );
  profilesPicker.append(profileSelect, profileUse);
  const profileFields = document.createElement("div");
  profileFields.className = "n-surface-profile-fields";
  const profileNameLabel = document.createElement("label");
  const profileNameText = document.createElement("span");
  profileNameText.textContent = "Layout name";
  const profileName = document.createElement("input");
  profileName.type = "text";
  profileName.maxLength = 80;
  profileName.placeholder = "My four-player cabinet";
  profileName.dataset.surfaceProfileName = "";
  profileNameLabel.append(profileNameText, profileName);
  const profileDescriptionLabel = document.createElement("label");
  const profileDescriptionText = document.createElement("span");
  profileDescriptionText.textContent = "Description (optional)";
  const profileDescription = document.createElement("input");
  profileDescription.type = "text";
  profileDescription.maxLength = 240;
  profileDescription.placeholder = "What this panel layout is for";
  profileDescription.dataset.surfaceProfileDescription = "";
  profileDescriptionLabel.append(profileDescriptionText, profileDescription);
  profileFields.append(profileNameLabel, profileDescriptionLabel);
  const profileActions = document.createElement("div");
  profileActions.className = "n-surface-profile-actions";
  profileActions.append(
    makeKeyboardWorkbenchButton("Save as new", "surface-profile-save", "Save this complete editor draft as a reusable KSX hardware layout"),
    makeKeyboardWorkbenchButton("Update saved", "surface-profile-update", "Replace the selected saved layout with this complete editor draft"),
    makeKeyboardWorkbenchButton("Delete saved", "surface-profile-delete", "Delete only the selected KSX layout; this never changes the I-PAC"),
  );
  const profileMessage = document.createElement("p");
  profileMessage.dataset.surfaceProfilesMessage = "";
  profileMessage.setAttribute("role", "status");
  profiles.append(profilesHead, profilesPicker, profileFields, profileActions, profileMessage);
  const terminalEditor = document.createElement("section");
  terminalEditor.className = "n-surface-terminal-editor";
  const terminalEditorHead = document.createElement("div");
  const terminalEditorTitle = document.createElement("div");
  const terminalEditorStrong = document.createElement("strong");
  terminalEditorStrong.textContent = "Terminal chart";
  const terminalEditorStatus = document.createElement("span");
  terminalEditorStatus.dataset.surfaceTerminalStatus = "";
  terminalEditorStatus.textContent = "No chart loaded";
  terminalEditorTitle.append(terminalEditorStrong, terminalEditorStatus);
  const advancedLabel = document.createElement("label");
  advancedLabel.className = "n-surface-terminal-advanced-toggle";
  const advancedInput = document.createElement("input");
  advancedInput.type = "checkbox";
  advancedInput.dataset.nx = "surface-terminal-advanced";
  const advancedText = document.createElement("span");
  advancedText.textContent = "Advanced shift layer";
  advancedLabel.append(advancedInput, advancedText);
  terminalEditorHead.append(terminalEditorTitle, advancedLabel);
  const terminalEditorNote = document.createElement("p");
  terminalEditorNote.dataset.surfaceTerminalNote = "";
  terminalEditorNote.textContent =
    "Windows key outputs are what KSX receives. Open Advanced only for the I-PAC shifted layer and terminal Shift roles.";
  const terminalGrid = document.createElement("div");
  terminalGrid.className = "n-surface-terminal-grid";
  terminalGrid.dataset.surfaceTerminalGrid = "";
  terminalEditor.append(terminalEditorHead, terminalEditorNote, terminalGrid);
  const outputTest = document.createElement("section");
  outputTest.className = "n-panel-output-test";
  const outputTestHead = document.createElement("div");
  const outputTestHeading = document.createElement("div");
  const outputTestTitle = document.createElement("strong");
  outputTestTitle.textContent = "Test wiring";
  const outputTestStatus = document.createElement("span");
  outputTestStatus.dataset.panelOutputTestStatus = "";
  outputTestStatus.textContent = "Program or load at least one output first";
  outputTestHeading.append(outputTestTitle, outputTestStatus);
  const outputTestButton = makeKeyboardWorkbenchButton(
    "Test one control",
    "surface-encoder-test",
    "Listen once and identify the Windows key and every matching I-PAC terminal without changing a KSX mapping",
  );
  const simultaneousTestButton = makeKeyboardWorkbenchButton(
    "Test simultaneous inputs…",
    "input-test-open",
    "Measure the peak distinct keyboard-mode signals KSX observes during one bounded test of this exact encoder",
  );
  outputTestHead.append(outputTestHeading, outputTestButton, simultaneousTestButton);
  const outputTestCopy = document.createElement("p");
  outputTestCopy.dataset.panelOutputTestCopy = "";
  outputTestCopy.textContent =
    "Press any wired cabinet control. KSX identifies the Windows key emitted by this I-PAC; no controller mapping changes.";
  const outputSignalGrid = document.createElement("div");
  outputSignalGrid.className = "n-panel-signal-grid";
  outputSignalGrid.dataset.panelSignalGrid = "";
  const routeActions = document.createElement("div");
  routeActions.className = "n-panel-route-actions";
  const routeCopy = document.createElement("p");
  routeCopy.dataset.panelRouteCopy = "";
  routeCopy.textContent = "After the hardware signals work, route those keys through KSX to virtual controllers.";
  const buildPanelButton = makeKeyboardWorkbenchButton(
    "Build physical panel",
    "surface-encoder-build-panel",
    "Draw physical joysticks and buttons from the terminal-to-key chart stored on this encoder",
  );
  buildPanelButton.classList.add("primary");
  const designPanelButton = makeKeyboardWorkbenchButton(
    "Design physical panel first",
    "surface-encoder-design-panel",
    "Choose the cabinet shape and physical controls before assigning I-PAC terminal outputs",
  );
  designPanelButton.classList.add("primary");
  designPanelButton.hidden = true;
  const routeButton = makeKeyboardWorkbenchButton(
    "Continue to KSX routing",
    "surface-encoder-route",
    "Leave hardware setup and open the KSX mapping inspector",
  );
  routeActions.append(routeCopy, designPanelButton, buildPanelButton, routeButton);
  outputTest.append(outputTestHead, outputTestCopy, outputSignalGrid, routeActions);
  const programmingActions = document.createElement("div");
  programmingActions.className = "n-surface-programming-actions";
  const reread = makeKeyboardWorkbenchButton(
    "Read board again",
    "surface-encoder-read",
    "Read every chart byte again and create another verified backend-owned backup",
  );
  reread.classList.add("quiet");
  const review = makeKeyboardWorkbenchButton(
    "Review & program board",
    "surface-encoder-review",
    "Compute an exact terminal and byte diff without writing anything",
  );
  review.classList.add("primary");
  programmingActions.append(reread, review);
  const advancedHardware = document.createElement("details");
  advancedHardware.className = "n-surface-programming-advanced";
  const advancedHardwareSummary = document.createElement("summary");
  advancedHardwareSummary.textContent = "Advanced hardware actions";
  const advancedHardwareCopy = document.createElement("p");
  advancedHardwareCopy.textContent =
    "Clearing the board disables every readable output. Use it only when you intentionally want a silent I-PAC; deleting a saved KSX layout does not change hardware.";
  const clearOutputs = makeKeyboardWorkbenchButton(
    "Disable all hardware outputs",
    "surface-encoder-mode",
    "Prepare a clear-all hardware draft while preserving opaque vendor bytes",
    "blank",
  );
  clearOutputs.dataset.surfaceProgrammingMode = "blank";
  clearOutputs.dataset.surfaceProgrammingDescription =
    "Clear readable actions and known Shift roles while preserving opaque vendor bytes.";
  clearOutputs.classList.add("danger");
  advancedHardware.append(advancedHardwareSummary, advancedHardwareCopy, clearOutputs);
  const recovery = document.createElement("details");
  recovery.className = "n-surface-programming-recovery";
  const recoverySummary = document.createElement("summary");
  recoverySummary.textContent = "Recovery and raw board history";
  const recoveryCopy = document.createElement("p");
  recoveryCopy.textContent =
    "Raw, board-bound recovery images are transaction safeguards. Saved hardware layouts above are the reusable profiles you normally work with.";
  const restoreGroup = document.createElement("div");
  restoreGroup.className = "n-surface-programming-restore";
  const restoreLabel = document.createElement("label");
  const restoreLabelText = document.createElement("span");
  restoreLabelText.dataset.surfaceBackupLabel = "";
  restoreLabelText.textContent = "Restore a verified backup";
  const backupSelect = document.createElement("select");
  backupSelect.dataset.surfaceBackup = "";
  backupSelect.setAttribute("aria-label", "Verified encoder backup");
  const backupPlaceholder = document.createElement("option");
  backupPlaceholder.value = "";
  backupPlaceholder.textContent = "No verified backups yet";
  backupSelect.append(backupPlaceholder);
  restoreLabel.append(restoreLabelText, backupSelect);
  const restore = makeKeyboardWorkbenchButton(
    "Review restore…",
    "surface-encoder-restore",
    "Compare this backend-owned backup with the complete current chart before restoring",
  );
  restoreGroup.append(restoreLabel, restore);
  recovery.append(recoverySummary, recoveryCopy, restoreGroup);
  programming.append(
    signalJourney,
    programmingHead,
    programmingDevice,
    programmingSummary,
    programmingQualification,
    programmingConflicts,
    programmingModes,
    profiles,
    terminalEditor,
    outputTest,
    programmingActions,
    advancedHardware,
    recovery,
  );

  const stages = document.createElement("nav");
  stages.className = "n-surface-stages";
  stages.setAttribute("aria-label", "Control surface workflow");
  ([
    ["design", "1", "Arrange appearance", "Add and arrange the physical parts without changing device firmware or KSX routes"],
    ["teach", "2", "Teach host signals", "Press each wired control and record the exact signal and source device KSX receives"],
    ["route", "3", "Route in KSX", "Connect learned host signals through KSX to virtual controls"],
  ] as const).forEach(([stage, number, label, title]) => {
    const button = makeKeyboardWorkbenchButton(label, "surface-stage", title, stage);
    button.classList.add("n-surface-stage");
    button.dataset.surfaceStage = stage;
    const badge = document.createElement("span");
    badge.textContent = number;
    button.prepend(badge);
    stages.append(button);
  });

  const status = document.createElement("p");
  status.className = "n-surface-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const starters = document.createElement("section");
  starters.className = "n-surface-starters";
  const starterHead = document.createElement("div");
  starterHead.className = "n-surface-starter-head";
  const starterTitle = document.createElement("strong");
  starterTitle.textContent = "Start the physical panel";
  const starterCopy = document.createElement("span");
  starterCopy.textContent = "Build first, import existing mappings, or start from nothing.";
  starterHead.append(starterTitle, starterCopy);
  const starterGrid = document.createElement("div");
  starterGrid.className = "n-surface-starter-grid";
  for (const template of CONTROL_SURFACE_TEMPLATES) {
    const card = document.createElement("button");
    card.type = "button";
    card.dataset.nx = "surface-template";
    card.dataset.surfaceTemplate = template.slug;
    card.title = template.note;
    const label = document.createElement("strong");
    label.textContent = template.label;
    const note = document.createElement("span");
    note.textContent = template.note;
    card.append(label, note);
    starterGrid.append(card);
  }
  const starterCancel = makeKeyboardWorkbenchButton(
    "Cancel",
    "surface-template-cancel",
    "Keep the current panel",
  );
  starterCancel.classList.add("quiet");
  starters.append(starterHead, starterGrid, starterCancel);

  const tools = document.createElement("div");
  tools.className = "n-surface-tools";
  tools.append(
    makeKeyboardWorkbenchGroup("Add physical part", "n-surface-add", [
      makeKeyboardWorkbenchButton("● 30 mm", "surface-add", "Add a standard arcade action button", "button30"),
      makeKeyboardWorkbenchButton("● 24 mm", "surface-add", "Add a compact Start, Coin, or auxiliary button", "button24"),
      makeKeyboardWorkbenchButton("▣ Keycap", "surface-add", "Add one mechanical key switch", "keycap"),
      makeKeyboardWorkbenchButton("✣ Stick", "surface-add", "Add a four-channel arcade joystick", "joystick"),
    ]),
    makeKeyboardWorkbenchGroup("Panel", "n-surface-panel-actions", [
      makeKeyboardWorkbenchButton("Choose template…", "surface-new", "Replace this panel only after choosing and confirming a new starting layout"),
      makeKeyboardWorkbenchButton("Undo removal / replacement", "surface-undo", "Restore the panel from immediately before the last destructive edit"),
    ]),
  );
  for (const button of Array.from(tools.querySelectorAll<HTMLButtonElement>('[data-nx="surface-add"]'))) {
    button.dataset.controlKind = button.dataset.mode ?? "";
    button.removeAttribute("data-mode");
    button.removeAttribute("aria-pressed");
  }

  const workarea = document.createElement("div");
  workarea.className = "n-surface-workarea";
  const deckScroll = document.createElement("div");
  deckScroll.className = "n-surface-deck-scroll";
  const deck = document.createElement("div");
  deck.className = "n-surface-deck";
  deck.setAttribute("role", "group");
  deck.setAttribute("aria-label", "Arrangeable physical control surface");
  const playerZones = document.createElement("div");
  playerZones.className = "n-surface-player-zones";
  playerZones.setAttribute("aria-hidden", "true");
  for (let slot = 1; slot <= 4; slot += 1) {
    const zone = document.createElement("span");
    zone.className = `n-surface-player-zone np${slot}`;
    zone.textContent = `P${slot}`;
    playerZones.append(zone);
  }
  deck.append(playerZones);
  deck.addEventListener("pointerdown", controlSurfacePointerDown);
  deck.addEventListener("pointermove", controlSurfacePointerMove);
  deck.addEventListener("pointerup", controlSurfacePointerEnd);
  deck.addEventListener("pointercancel", controlSurfacePointerEnd);
  deckScroll.append(deck);
  const inspector = document.createElement("aside");
  inspector.className = "n-surface-inspector";
  workarea.append(deckScroll, inspector);

  const note = document.createElement("p");
  note.className = "n-surface-note";
  note.dataset.surfaceNote = "";
  note.textContent =
    "Encoder setup is supervised: KSX reads and backs up the complete chart, previews an exact diff, then writes only after confirmation and byte-for-byte verification. Teach still proves what the physical wiring sends; Route writes the dynamic KSX mapping.";
  content.append(head, hardware, programming, stages, status, starters, tools, workarea, note);

  const item = createCanvasItem({
    instanceId: "control-surface",
    displayName: "Control Surface Builder",
    preferredWidth: 1320,
    minHeight: 940,
    content,
  });
  item.classList.add("n-widget", "n-widget-surface");
  item.dataset.clientWidget = "";
  item.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === "F2") && event.target === item) {
      event.preventDefault();
      event.stopPropagation();
      focusControlSurfacePrimary();
    } else if (event.key === "Escape" && content.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      if (nCanvas?.isFocusModeActive(item)) {
        nCanvas.exitFocusMode();
        syncWidgetSelection();
      } else {
        item.focus({ preventScroll: true });
      }
    }
  }, { capture: true });
  return item;
}

function controlSurfaceHome(): CanvasItemGeometry {
  const canvas = nCanvas;
  const source = keyboardWorkbenchItem ?? learnRoot?.querySelector<HTMLElement>(
    '.n-canvas [data-instance-id="keyboard"]',
  );
  if (canvas && source) {
    const state = canvas.getItemState(source);
    return {
      x: state.x + 24,
      y: state.y + state.height * state.manualScale + 56,
      width: 1320,
      height: 940,
      z: state.z + 1,
      manualScale: 1,
    };
  }
  return { x: 130, y: 960, width: 1320, height: 940, z: 3, manualScale: 1 };
}

function controlSurfaceFocusable(selectors: readonly string[]): HTMLElement | null {
  const item = controlSurfaceItem;
  if (!item) return null;
  for (const selector of selectors) {
    for (const candidate of Array.from(item.querySelectorAll<HTMLElement>(selector))) {
      if (candidate.closest("[hidden]") || candidate.getAttribute("aria-hidden") === "true") continue;
      if ((candidate instanceof HTMLButtonElement || candidate instanceof HTMLSelectElement ||
          candidate instanceof HTMLInputElement) && candidate.disabled) continue;
      return candidate;
    }
  }
  return null;
}

function focusControlSurfacePrimary(): void {
  window.requestAnimationFrame(() => {
    const item = controlSurfaceItem;
    if (!item) return;
    const choosing = !controlSurfaceState.started || controlSurfaceChoosingTemplate;
    const target = choosing
      ? item.querySelector<HTMLButtonElement>("[data-surface-template]")
      : item.querySelector<HTMLButtonElement>(
          `.n-surface-control[data-surface-control-id="${CSS.escape(controlSurfaceState.selectedControlId)}"]`,
        ) ?? item.querySelector<HTMLButtonElement>(".n-surface-control") ??
          item.querySelector<HTMLButtonElement>('[data-nx="surface-add"]');
    target?.focus({ preventScroll: true });
  });
}

function rememberControlSurfaceUndo(): void {
  controlSurfaceUndoState = cloneControlSurfaceState(controlSurfaceState);
  controlSurfaceUndoIdentity = controlSurfaceIdentity;
  controlSurfaceUndoAfterFingerprint = "";
}

function finishControlSurfaceUndoArm(): void {
  if (controlSurfaceUndoState && controlSurfaceUndoIdentity === controlSurfaceIdentity) {
    controlSurfaceUndoAfterFingerprint = controlSurfaceDocumentFingerprint(controlSurfaceState);
  }
}

function undoControlSurfaceDestructiveEdit(): void {
  if (!controlSurfaceUndoState || controlSurfaceUndoIdentity !== controlSurfaceIdentity) return;
  if (learnRow?.purpose === "surface") void cancelLearn();
  if (assignKey) cancelAssign();
  const restore = cloneControlSurfaceState(controlSurfaceUndoState);
  clearControlSurfaceUndo();
  controlSurfacePendingTemplate = null;
  controlSurfaceChoosingTemplate = false;
  applyControlSurfaceState({ ...restore, open: true }, true, true);
  keyboardWorkbenchAnnounce("The panel from before the last removal or replacement was restored.");
  focusControlSurfacePrimary();
}

function syncControlSurfaceWidget(reveal: boolean): void {
  const canvas = nCanvas;
  if (!canvas) return;
  if (
    controlSurfaceItem &&
    (!controlSurfaceState.open || controlSurfaceItemIdentity !== controlSurfaceIdentity)
  ) {
    if (controlSurfaceItem.dataset.canvasX !== undefined) {
      canvasPrefs.widgets[controlSurfaceCanvasKey(controlSurfaceItemIdentity)] =
        canvas.getItemState(controlSurfaceItem);
      saveCanvasPrefs();
    }
    canvas.removeItem(controlSurfaceItem, { selectFallback: false });
    controlSurfaceItem = null;
    controlSurfaceItemIdentity = "";
    controlSurfaceDrag = null;
  }
  if (!controlSurfaceState.open) {
    labelCanvasMarkers();
    return;
  }
  if (!controlSurfaceItem) {
    controlSurfaceItem = createControlSurfaceItem();
    controlSurfaceItemIdentity = controlSurfaceIdentity;
    const restored = canvasPrefs.widgets[controlSurfaceCanvasKey()] ?? controlSurfaceHome();
    canvas.mountItem(controlSurfaceItem, restored, { focus: false });
  }
  syncControlSurfaceChrome();
  labelCanvasMarkers();
  if (reveal) {
    const viewport = controlSurfaceItem.closest<HTMLElement>(".forma-canvas-viewport");
    const map = viewport?.querySelector<HTMLElement>(".forma-canvas-navigator");
    let right = 0;
    if (viewport && map && !map.hidden) {
      const style = window.getComputedStyle(map);
      const viewportRect = viewport.getBoundingClientRect();
      const mapRect = map.getBoundingClientRect();
      const intersectsViewport = style.display !== "none" && style.visibility !== "hidden" &&
        mapRect.width > 0 && mapRect.height > 0 &&
        mapRect.left < viewportRect.right && mapRect.right > viewportRect.left &&
        mapRect.top < viewportRect.bottom && mapRect.bottom > viewportRect.top;
      if (intersectsViewport) {
        right = Math.max(
          0,
          viewportRect.right - Math.max(viewportRect.left, mapRect.left) + 12,
        );
      }
    }
    canvas.focusItem(controlSurfaceItem, {
      viewportInsets: right > 0 ? { right } : undefined,
    });
    focusControlSurfacePrimary();
  }
}

function openControlSurfaceBuilder(): void {
  if (document.activeElement instanceof HTMLElement) {
    controlSurfaceReturnFocus = document.activeElement;
  }
  autoMap = null;
  void cancelLearn();
  cancelAssign();
  controlSurfaceChoosingTemplate = !controlSurfaceState.started;
  controlSurfacePendingTemplate = null;
  applyControlSurfaceState({ ...controlSurfaceState, open: true }, true, true);
  keyboardWorkbenchAnnounce(
    controlSurfaceState.started
      ? "Control Surface Builder opened with its saved physical panel."
      : "Control Surface Builder opened. Choose a blank panel, a hardware template, or generate from existing mappings.",
  );
}

function closeControlSurfaceBuilder(): void {
  if (learnRow?.purpose === "surface") void cancelLearn();
  if (assignKey) cancelAssign();
  controlSurfaceChoosingTemplate = false;
  controlSurfacePendingTemplate = null;
  applyControlSurfaceState({ ...controlSurfaceState, open: false }, true);
  keyboardWorkbenchAnnounce(
    controlSurfaceSaveFailed
      ? "Control Surface Builder closed. Browser storage is unavailable, so this draft lasts only for this session."
      : "Control Surface Builder closed. Its draft is saved in this browser.",
  );
  const restore = controlSurfaceReturnFocus?.isConnected
    ? controlSurfaceReturnFocus
    : learnRoot?.querySelector<HTMLElement>('[data-nx="surface-open"]') ?? null;
  controlSurfaceReturnFocus = null;
  window.requestAnimationFrame(() => restore?.focus({ preventScroll: true }));
}

function chooseControlSurfaceTemplate(template: ControlSurfaceTemplate): void {
  const records = controlSurfaceMappingRecords();
  const selectedSlot = Number(nSlotVal() || "1");
  const generatedRecords = template === "mapping-selected"
    ? records.filter((record) => record.slot === selectedSlot)
    : template === "mapping-four"
    ? records.filter((record) => record.slot >= 1 && record.slot <= 4)
    : [];
  const generatedCount = new Set(
    generatedRecords.map((record) => `${record.slot}\u0000${record.key}`),
  ).size;
  if (generatedCount > CONTROL_SURFACE_MAX_CONTROLS) {
    keyboardWorkbenchAnnounce(
      `This mapping would create ${generatedCount} visual controls, above the ${CONTROL_SURFACE_MAX_CONTROLS}-control safety limit. The current panel was kept intact.`,
    );
    return;
  }
  if (
    template === "mapping-selected" &&
    !records.some((record) => record.slot === selectedSlot)
  ) {
    keyboardWorkbenchAnnounce(`Player ${selectedSlot} has no existing mappings to generate.`);
    return;
  }
  if (
    template === "mapping-four" &&
    !records.some((record) => record.slot >= 1 && record.slot <= 4)
  ) {
    keyboardWorkbenchAnnounce("Players 1–4 have no existing mappings to generate.");
    return;
  }
  if (controlSurfaceState.started && controlSurfacePendingTemplate !== template) {
    controlSurfacePendingTemplate = template;
    syncControlSurfaceChrome();
    keyboardWorkbenchAnnounce(
      `Replacement is not applied yet. Press Confirm replacement · ${CONTROL_SURFACE_TEMPLATES.find((candidate) => candidate.slug === template)?.label ?? template}, or Cancel to keep this panel.`,
    );
    controlSurfaceItem
      ?.querySelector<HTMLButtonElement>(`[data-surface-template="${CSS.escape(template)}"]`)
      ?.focus({ preventScroll: true });
    return;
  }
  if (learnRow?.purpose === "surface") void cancelLearn();
  if (assignKey) cancelAssign();
  if (controlSurfaceState.started) rememberControlSurfaceUndo();
  controlSurfacePendingTemplate = null;
  controlSurfaceChoosingTemplate = false;
  applyControlSurfaceState(
    applyControlSurfaceTemplate(
      { ...controlSurfaceState, theme: keyboardWorkbenchState.theme },
      template,
      records,
      selectedSlot,
      nCapSelector().trim() || controlSurfaceIdentity,
    ),
    true,
    true,
  );
  finishControlSurfaceUndoArm();
  keyboardWorkbenchAnnounce(
    template.startsWith("mapping-")
      ? "Panel generated from backend-owned mappings. Repeated signals stay visibly unresolved until the physical wiring is identified."
      : `${CONTROL_SURFACE_TEMPLATES.find((candidate) => candidate.slug === template)?.label ?? "Panel"} created with unassigned physical inputs.`,
  );
  focusControlSurfacePrimary();
}

function addPhysicalControl(kind: ControlSurfaceControlKind): void {
  const selected = selectedControlSurfaceControl();
  const currentSlot = Number(nSlotVal() || "1");
  const playerSlot = controlSurfaceState.panelLayout === "four-player"
    ? selected?.playerSlot ?? (currentSlot >= 1 && currentSlot <= 4 ? currentSlot : 1)
    : null;
  const next = addControlSurfaceControl(controlSurfaceState, kind, playerSlot);
  if (next.controls.length === controlSurfaceState.controls.length) {
    keyboardWorkbenchAnnounce(
      `This panel has reached its ${CONTROL_SURFACE_MAX_CONTROLS}-component visual limit. Nothing was added.`,
    );
    return;
  }
  applyControlSurfaceState(next, true);
  keyboardWorkbenchAnnounce("Physical component added. Arrange it, then teach the signal its wiring emits.");
}

function chooseControlSurfaceStage(stage: ControlSurfaceStage): void {
  applyControlSurfaceState(setControlSurfaceStage(controlSurfaceState, stage), true);
  const hasControl = controlSurfaceState.controls.length > 0;
  keyboardWorkbenchAnnounce(
    stage === "design"
      ? "Design selected. Add, name, link, duplicate, and arrange physical parts."
      : !hasControl
      ? `${stage === "teach" ? "Teach host signals" : "Route in KSX"} selected. Add a physical component first.`
      : stage === "teach"
      ? "Teach host signals selected. Choose Teach input for a component, then press its real wired control."
      : "Route in KSX selected. Choose Route in KSX for a learned host signal, then choose its virtual-controller control.",
  );
  window.requestAnimationFrame(() => {
    const item = controlSurfaceItem;
    if (!item) return;
    const target = stage === "design" || !hasControl
      ? item.querySelector<HTMLElement>('[data-nx="surface-add"]')
      : stage === "teach"
      ? item.querySelector<HTMLElement>('[data-nx="surface-teach"]')
      : item.querySelector<HTMLElement>('[data-nx="surface-route"]:not(:disabled)') ??
        item.querySelector<HTMLElement>('[data-nx="surface-teach"]');
    target?.focus({ preventScroll: true });
  });
}

function selectControlSurfaceChannel(controlId: string, channelId = ""): void {
  applyControlSurfaceState(
    selectControlSurfaceControl(controlSurfaceState, controlId, channelId),
    true,
  );
  const channel = selectedControlSurfaceChannel();
  const flowKey = channel ? controlSurfaceSignalTruth(channel).flowKey : "";
  if (flowKey) setInspectorContext({ kind: "key", key: flowKey });
}

function removeSelectedControlSurfaceControl(): void {
  const control = selectedControlSurfaceControl();
  if (!control) return;
  if (learnRow?.purpose === "surface" && learnRow.surfaceControlId === control.id) {
    void cancelLearn();
  }
  if (assignKey) cancelAssign();
  rememberControlSurfaceUndo();
  applyControlSurfaceState(
    removeControlSurfaceControl(controlSurfaceState, control.id),
    true,
  );
  finishControlSurfaceUndoArm();
  keyboardWorkbenchAnnounce(`${control.label} removed from the panel. Backend mappings were not changed.`);
  window.requestAnimationFrame(() => {
    const nextControl = controlSurfaceItem?.querySelector<HTMLElement>(
      `.n-surface-control[data-surface-control-id="${CSS.escape(controlSurfaceState.selectedControlId)}"]`,
    );
    const fallback = controlSurfaceItem?.querySelector<HTMLElement>('[data-nx="surface-add"]');
    (nextControl ?? fallback)?.focus({ preventScroll: true });
  });
}

function copySelectedControlSurfaceControl(mode: "duplicate" | "mirror"): void {
  const control = selectedControlSurfaceControl();
  if (!control) return;
  if (control.physicalResolution === "unresolved-shared-signal") {
    keyboardWorkbenchAnnounce(
      "Confirm whether the existing signal views are one switch or separate wiring before making another view.",
    );
    return;
  }
  const next = copyControlSurfaceControl(controlSurfaceState, control.id, mode);
  if (next.controls.length === controlSurfaceState.controls.length) {
    keyboardWorkbenchAnnounce(
      `This panel has reached its ${CONTROL_SURFACE_MAX_CONTROLS}-component visual limit. Nothing was copied.`,
    );
    return;
  }
  applyControlSurfaceState(next, true);
  keyboardWorkbenchAnnounce(
    mode === "mirror"
      ? `${control.label} now has a linked visual mirror of the same physical input.`
      : `${control.label} duplicated as a separate physical control with the same current signal.`,
  );
  window.requestAnimationFrame(() => {
    controlSurfaceItem?.querySelector<HTMLElement>(
      `.n-surface-control[data-surface-control-id="${CSS.escape(controlSurfaceState.selectedControlId)}"]`,
    )?.focus({ preventScroll: true });
  });
}

function resolveSelectedControlSurfaceSignal(resolution: "mirror" | "duplicate"): void {
  const control = selectedControlSurfaceControl();
  const channel = selectedControlSurfaceChannel();
  if (!control || !channel) return;
  const before = controlSurfaceState.controls.filter(
    (candidate) => candidate.physicalResolution === "unresolved-shared-signal",
  ).length;
  const next = resolveControlSurfaceSharedSignal(
    controlSurfaceState,
    control.id,
    channel.id,
    resolution,
  );
  const after = next.controls.filter(
    (candidate) => candidate.physicalResolution === "unresolved-shared-signal",
  ).length;
  if (before === after) {
    keyboardWorkbenchAnnounce("No unresolved views share this channel's current signal.");
    return;
  }
  applyControlSurfaceState(next, true);
  keyboardWorkbenchAnnounce(
    resolution === "mirror"
      ? "These signal views are now linked as one confirmed physical control."
      : "These signal views are now confirmed as separately wired physical controls.",
  );
  window.requestAnimationFrame(() => {
    controlSurfaceItem?.querySelector<HTMLElement>(
      `.n-surface-control[data-surface-control-id="${CSS.escape(control.id)}"]`,
    )?.focus({ preventScroll: true });
  });
}

function startControlSurfaceTeach(): void {
  const control = selectedControlSurfaceControl();
  const channel = selectedControlSurfaceChannel();
  if (!control || !channel) {
    keyboardWorkbenchAnnounce("Select a physical component before teaching an input.");
    return;
  }
  const expectedSelector = nCapSelector().trim();
  const expectedInstance = nCapInstance().trim();
  if (!expectedSelector || !expectedInstance) {
    keyboardWorkbenchAnnounce(
      "Select a keyboard or keyboard-mode encoder with a verified Windows device before teaching its physical inputs.",
    );
    return;
  }
  chooseControlSurfaceStage("teach");
  void startLearn({
    fn: "",
    label: `${control.label} · ${channel.label}`,
    slot: nSlotVal() || "1",
    mode: "replace",
    purpose: "surface",
    surfaceIdentity: controlSurfaceIdentity,
    surfaceControlId: control.id,
    surfaceChannelId: channel.id,
    surfacePhysicalId: control.physicalId,
    expectedDevice: expectedSelector,
    expectedInstance,
  });
}

function teachSelectedControlSurfaceWithKey(
  identity: string,
  controlId: string,
  channelId: string,
  physicalId: string,
  key: string,
  expectedInstance: string,
): boolean {
  const control = controlSurfaceState.controls.find((candidate) => candidate.id === controlId);
  if (
    identity !== controlSurfaceIdentity ||
    !control ||
    control.physicalId !== physicalId ||
    !control.channels.some((channel) => channel.id === channelId)
  ) {
    keyboardWorkbenchAnnounce(
      "That teaching attempt belonged to an older panel or component, so its input was ignored.",
    );
    return false;
  }
  if (!expectedInstance || !sameBindingIdentity(expectedInstance, nCapInstance())) {
    keyboardWorkbenchAnnounce(
      `Ignored ${key}: the selected keyboard or encoder changed while Teach was listening. Nothing changed.`,
    );
    return false;
  }
  applyControlSurfaceState(
    teachControlSurfaceChannel(
      controlSurfaceState,
      controlId,
      channelId,
      key,
      expectedInstance,
    ),
    true,
  );
  setInspectorContext({ kind: "key", key });
  keyboardWorkbenchAnnounce(
    `${key} learned for the selected physical control. No KSX mapping changed; Route in KSX chooses its destination.`,
  );
  return true;
}

function routeSelectedControlSurfaceChannel(): void {
  const channel = selectedControlSurfaceChannel();
  const key = channel ? controlSurfaceRouteKey(channel) : "";
  if (!channel || !key) {
    keyboardWorkbenchAnnounce("Teach this physical input before routing it.");
    return;
  }
  chooseControlSurfaceStage("route");
  setInspectorContext({ kind: "key", key });
  const routeSlots = new Set(controlSurfaceRoutesForKey(key).map((route) => route.slot));
  const currentSlot = Number(nSlotVal() || "1");
  const needsAllPlayers = routeSlots.size > 1 || [...routeSlots].some((slot) => slot !== currentSlot);
  const currentMode = canvasPrefs.mappingPaths ?? "off";
  if (needsAllPlayers && currentMode !== "all") setMappingPathMode("all");
  else if (currentMode === "off") setMappingPathMode("selected");
  armAssign(key, "replace");
}

function nudgeControlSurfaceControl(controlId: string, dx: number, dy: number): void {
  const control = controlSurfaceState.controls.find((candidate) => candidate.id === controlId);
  if (!control) return;
  applyControlSurfaceState(
    moveControlSurfaceControl(controlSurfaceState, controlId, control.x + dx, control.y + dy),
    true,
  );
}

function controlSurfacePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary) return;
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>(".n-surface-control");
  const deck = button?.closest<HTMLElement>(".n-surface-deck");
  const controlId = button?.dataset.surfaceControlId ?? "";
  const control = controlSurfaceState.controls.find((candidate) => candidate.id === controlId);
  const rect = deck?.getBoundingClientRect();
  if (!button || !deck || !control || !rect || rect.width <= 0 || rect.height <= 0) return;
  const channelId = target?.closest<HTMLElement>(
    ".n-surface-signal-chain[data-surface-channel-id]",
  )?.dataset.surfaceChannelId ?? "";
  // The complete terminal → key row is a channel picker, not a drag handle.
  // Leave it in the DOM until the delegated click reads its exact joystick
  // direction; restricting this guard to the keycap made its terminal pill
  // select the stick's first channel and begin a drag.
  if (channelId) {
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  selectControlSurfaceChannel(controlId);
  button.focus({ preventScroll: true });
  button.classList.add("dragging");
  button.setPointerCapture(event.pointerId);
  controlSurfaceDrag = {
    pointerId: event.pointerId,
    controlId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: control.x,
    startY: control.y,
    scaleX: CONTROL_SURFACE_BOUNDS.width / rect.width,
    scaleY: CONTROL_SURFACE_BOUNDS.height / rect.height,
    moved: false,
  };
}

function controlSurfacePointerMove(event: PointerEvent): void {
  const drag = controlSurfaceDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved) {
    drag.moved = Math.hypot(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    ) >= 4;
    if (!drag.moved) return;
  }
  controlSurfaceState = moveControlSurfaceControl(
    controlSurfaceState,
    drag.controlId,
    drag.startX + (event.clientX - drag.startClientX) * drag.scaleX,
    drag.startY + (event.clientY - drag.startClientY) * drag.scaleY,
  );
  const moved = controlSurfaceState.controls.find((control) => control.id === drag.controlId);
  const button = controlSurfaceItem?.querySelector<HTMLElement>(
    `.n-surface-control[data-surface-control-id="${CSS.escape(drag.controlId)}"]`,
  );
  if (moved && button) {
    button.style.left = `${(moved.x / CONTROL_SURFACE_BOUNDS.width) * 100}%`;
    button.style.top = `${(moved.y / CONTROL_SURFACE_BOUNDS.height) * 100}%`;
    const deck = button.closest<HTMLElement>(".n-surface-deck");
    const signalBlockHeight = deck
      ? controlSurfaceSignalClearance(deck, moved.channels.length)
      : 4 + moved.channels.length * 17;
    button.dataset.signalV = moved.y + moved.height + signalBlockHeight >
        CONTROL_SURFACE_BOUNDS.height
      ? "above"
      : "below";
    button.dataset.signalH = moved.x < 96
      ? "left"
      : moved.x + moved.width > CONTROL_SURFACE_BOUNDS.width - 96
      ? "right"
      : "center";
  }
  mappingFlowLayer?.scheduleLayout();
}

function controlSurfacePointerEnd(event: PointerEvent): void {
  const drag = controlSurfaceDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  controlSurfaceDrag = null;
  controlSurfaceItem
    ?.querySelector<HTMLElement>(
      `.n-surface-control[data-surface-control-id="${CSS.escape(drag.controlId)}"]`,
    )
    ?.classList.remove("dragging");
  if (drag.moved) {
    saveControlSurfacePrefs();
    syncControlSurfaceChrome();
    keyboardWorkbenchAnnounce("Physical component placed in the custom panel layout.");
  }
}

/** Every staged controller as a canvas widget, rebuilt when the roster
 *  changes: the engine's own item factory around the same badge-and-clone
 *  card the pad grid used to build. Client-created on purpose (the padgrid
 *  precedent made contractual): the wrappers carry `data-client-widget`, so
 *  the parity gate removes them before comparing — their SSR absence is the
 *  contract, and the keyboard widget deliberately has no such marker. */
export function syncPadWidgets(): void {
  const root = learnRoot;
  const v = lastBindView;
  const canvas = nCanvas;
  if (!root || !v || !canvas) return;
  const pads = v.pads ?? [];
  const previousSlots = new Set(padItems.keys());
  const storeKeys = padStoreKeys(pads);
  let arrivingSlot: number | undefined;
  if (padRosterInitialized) {
    // The final new slot in roster order is the user's newest controller.
    // Reorder and removal keep or shrink this set, while create, duplicate
    // and undo introduce one — so non-creation changes never move the camera.
    for (const pv of pads) {
      if (!previousSlots.has(pv.slot)) arrivingSlot = pv.slot;
    }
  }
  const print = pads.map((p) => p.slot + ":" + p.family + ":" + p.preset + ":" + p.title).join("|");
  if (print !== padWidgetPrint) {
    padWidgetPrint = print;
    for (const [, item] of padItems) canvas.removeItem(item, { selectFallback: false });
    padItems.clear();
    // The hidden masters, keyed by the family they draw — NOT by template
    // order: a third art (the DualSense) is exactly the change that makes an
    // index silently hand every PlayStation seat the wrong body.
    pads.forEach((pv, index) => {
      const family = new Set(["xbox", "ps", "ps5", "switchpro", "xboxseries"]).has(pv.family)
        ? pv.family
        : "xbox";
      const master = root.querySelector<HTMLElement>(
        `.n-padwrap[data-pad-family="${family}"]`,
      );
      const art = master?.querySelector(".ps5a") ?? master?.querySelector("svg");
      if (!art) return;
      const artClone = art.cloneNode(true) as SVGSVGElement;
      const storeKey = storeKeys.get(pv.slot) ?? "p:" + pv.preset;
      const content = document.createElement("div");
      content.className = "n-mini np" + pv.slot;
      content.setAttribute("data-pad-slot", String(pv.slot));
      // CSS marker only: the engine's active/drag outlines target
      // [data-forma-runtime-host]; no runtime adapter ever claims this.
      content.setAttribute("data-forma-runtime-host", "");
      const head = document.createElement("div");
      head.className = "n-mini-head";
      const badge = document.createElement("span");
      badge.className = "n-pbadge np" + pv.slot;
      badge.textContent = "P" + pv.slot;
      const title = document.createElement("span");
      title.className = "n-mini-title";
      title.textContent = pv.title;
      head.append(badge, title);
      let variantControls: HTMLElement | null = null;
      if (pv.family === "ps" && artClone.matches("svg.ds4premium")) {
        const controls = document.createElement("div");
        controls.className = "n-ds4-variants";
        controls.setAttribute("role", "group");
        controls.setAttribute("aria-label", "DualShock 4 color");
        for (const variant of DS4_PREMIUM_VARIANTS) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "n-ds4-variant";
          button.dataset.nx = "ds4-variant";
          button.dataset.ds4Variant = variant.slug;
          button.setAttribute("aria-label", variant.label + " controller finish");
          button.setAttribute("aria-pressed", "false");
          button.title = variant.label;
          button.style.setProperty("--ds4-variant-swatch", variant.swatch);
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            applyDs4Variant(artClone, controls, storeKey, variant.slug, true);
          });
          controls.append(button);
        }
        // A swatch press must not begin a canvas drag before its click lands.
        controls.addEventListener("pointerdown", (event) => event.stopPropagation());
        applyDs4Variant(
          artClone,
          controls,
          storeKey,
          ds4Variants[storeKey] ?? DS4_PREMIUM_VARIANTS[0].slug,
          false,
        );
        head.append(controls);
        variantControls = controls;
      } else {
        const config = premiumControllerConfig(family);
        if (config && artClone.matches(config.selector)) {
          const premiumFamily = family as PremiumControllerFamily;
          const controls = document.createElement("div");
          controls.className = "n-controller-variants";
          controls.setAttribute("role", "group");
          controls.setAttribute("aria-label", config.label + " color");
          for (const variant of config.variants) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "n-controller-variant";
            button.dataset.nx = "controller-variant";
            button.dataset.controllerVariant = variant.slug;
            button.setAttribute("aria-label", variant.label + " controller finish");
            button.setAttribute("aria-pressed", "false");
            button.title = variant.label;
            button.style.setProperty("--controller-variant-swatch", variant.swatch);
            button.addEventListener("click", (event) => {
              event.stopPropagation();
              applyPremiumControllerVariant(
                artClone,
                controls,
                premiumFamily,
                storeKey,
                variant.slug,
                true,
              );
            });
            controls.append(button);
          }
          controls.addEventListener("pointerdown", (event) => event.stopPropagation());
          const saved = controllerFinishes[controllerFinishKey(premiumFamily, storeKey)];
          applyPremiumControllerVariant(
            artClone,
            controls,
            premiumFamily,
            storeKey,
            saved ?? config.variants[0].slug,
            false,
          );
          head.append(controls);
          variantControls = controls;
        }
      }
      content.append(head, artClone);
      const item = createCanvasItem({
        instanceId: "pad-" + pv.slot,
        displayName: "P" + pv.slot + " \u00b7 " + pv.title,
        preferredWidth: 440,
        minHeight: 300,
        content,
      });
      item.classList.add("n-widget", "n-widget-pad", "np" + pv.slot);
      item.dataset.clientWidget = "";
      if (variantControls) {
        item.addEventListener("keydown", (event) => {
          if ((event.key === "Enter" || event.key === "F2") && event.target === item) {
            event.preventDefault();
            event.stopPropagation();
            variantControls?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
          } else if (event.key === "Escape" && variantControls?.contains(document.activeElement)) {
            event.preventDefault();
            event.stopPropagation();
            item.focus();
          }
        }, { capture: true });
      }
      const restored = canvasPrefs.widgets[storeKey] ?? padHome(index);
      canvas.mountItem(item, restored, { focus: false });
      padItems.set(pv.slot, item);
    });
    liveFnNodes = null;
  }
  padRosterInitialized = true;
  // Dress every widget's callouts from ITS slot's own table.
  const capFor = capForBoard(root);
  for (const [slot, item] of padItems) {
    const pv = pads.find((x) => x.slot === slot);
    if (!pv) continue;
    const byFn = new Map<string, string>();
    for (const [fnName, keys] of Object.entries(pv.fn_keys)) {
      byFn.set(fnName.toLowerCase(), keys);
    }
    for (const el of Array.from(item.querySelectorAll<SVGTextElement>("text.n-fnkey"))) {
      const fns = (el.getAttribute("data-fn") ?? "").split(/\s+/);
      const parts: string[] = [];
      for (const fnName of fns) {
        const keys = byFn.get(fnName.toLowerCase());
        if (keys) parts.push(calloutText(keys, capFor));
      }
      el.textContent = parts.join("\u00b7");
    }
  }
  // The engine mints a marker per widget as it mounts, so naming them
  // belongs at the end of every roster pass, not once at startup.
  labelCanvasMarkers();
  const revealItem = arrivingSlot === undefined ? undefined : padItems.get(arrivingSlot);
  if (revealItem?.isConnected) canvas.focusItem(revealItem);
  mappingFlowLayer?.scheduleLayout();
}

/** Adopt the served canvas skeleton and keyboard widget, then mount the
 *  controller widgets. Runs once, strictly AFTER adoption (the entry's
 *  post-mount frame): the engine annotates the served nodes, and every one
 *  of its writes rides the parity contract's client-canvas exemption.
 *
 *  ⚠️It WAITS for the skeleton instead of assuming one frame is enough.
 *  Adoption rebuilds the island subtree, so the four queries can legitimately
 *  miss on the frame this first runs — and a bare early return would leave a
 *  canvas that never comes alive: no error, no console line, just a keyboard
 *  sitting at plain CSS size, which every gate but the dead-canvas assert
 *  reads as healthy. Re-asking each frame costs nothing and removes any
 *  dependence on one frame's timing; the budget stops a page that
 *  legitimately has no canvas from asking forever. */
const CANVAS_ADOPT_FRAMES = 60;
export function initNocturneCanvas(root: HTMLElement, attempt = 0): void {
  if (nCanvas) return;
  // The island root itself can be replaced by adoption; a detached one would
  // hand the engine a tree nobody sees.
  const scope = root.isConnected ? root : (learnRoot?.isConnected ? learnRoot : document.body);
  const surface = scope.querySelector<HTMLElement>(".n-canvas");
  const viewport = surface?.querySelector<HTMLElement>(".forma-canvas-viewport");
  const stage = surface?.querySelector<HTMLElement>(".forma-canvas-stage");
  const flowLines = surface?.querySelector<SVGSVGElement>('.n-flow-layer[data-flow-layer="lines"]');
  const flowPorts = surface?.querySelector<SVGSVGElement>('.n-flow-layer[data-flow-layer="ports"]');
  const flowNodes = surface?.querySelector<HTMLElement>('[data-flow-layer="processors"]');
  const flowRouteList = scope.querySelector<HTMLOListElement>("#n-mapping-route-list");
  const flowTrace = scope.querySelector<HTMLOutputElement>("#n-mapping-trace");
  // The zoom readout IS the 100% button in the meta bar: the engine writes
  // the live percentage into whatever element it is handed, and a button
  // that reads the zoom and resets it on click is one control instead of a
  // static label beside a number somewhere else (which is what it was, and
  // it never changed).
  const zoomStatus = scope.querySelector<HTMLElement>(".n-zoomval");
  if (!surface || !viewport || !stage || !zoomStatus || !surface.isConnected) {
    if (attempt < CANVAS_ADOPT_FRAMES) {
      window.requestAnimationFrame(() => initNocturneCanvas(root, attempt + 1));
    }
    return;
  }
  // The minimap navigator: served skeleton, engine-filled. Its markers are
  // one button per widget (click jumps to it) and the pale rectangle is the
  // camera — dragging inside the map pans. Both are the engine's own; this
  // only hands it the served nodes. A page missing the skeleton falls back
  // to DETACHED nodes so the canvas still runs with no map.
  const navigator = surface.querySelector<HTMLElement>(".forma-canvas-navigator") ??
    document.createElement("aside");
  const navigatorItems = navigator.querySelector<HTMLElement>(".forma-canvas-navigator-items") ??
    document.createElement("div");
  const navigatorViewport = navigator
    .querySelector<HTMLElement>(".forma-canvas-navigator-viewport") ??
    document.createElement("div");
  if (!navigatorItems.isConnected) navigator.append(navigatorItems, navigatorViewport);
  // The engine reads pointerdown ANYWHERE in the map as "navigate to here"
  // (it only excuses its own markers), so the hide button has to stop the
  // press from reaching it — otherwise putting the map away jumps the view
  // on the way out. Click still bubbles to the delegated handler.
  navigator
    .querySelector<HTMLElement>(".n-mapclose")
    ?.addEventListener("pointerdown", (event) => event.stopPropagation());
  loadCanvasPrefs();
  nCanvas = new WidgetCanvas(
    { viewport, stage, zoomStatus, navigator, navigatorItems, navigatorViewport },
    {
      onCommit: persistCanvas,
      // The trail behind onCommit: pans and in-flight drags reach the store
      // within a second even if the tab dies before a durable boundary.
      onChange: () => {
        scheduleCanvasPersist();
        mappingFlowLayer?.scheduleLayout();
      },
      // The selection group follows the canvas, never the other way round:
      // selecting, scaling and focusing all report here.
      onActiveChange: syncWidgetSelection,
      onActiveItemStateChange: syncWidgetSelection,
      onFocusModeChange: syncWidgetSelection,
      // The engine has no live region of its own; the meta bar's sr status
      // line is this page's.
      onKeyboardNavigation: (message) => {
        const sr = (learnRoot ?? scope).querySelector<HTMLElement>(".n-live-sr");
        if (sr) sr.textContent = message;
      },
      worldBounds: CANVAS_WORLD,
    },
  );
  setCanvasMap(canvasPrefs.mapHidden === true);
  const kb = stage.querySelector<HTMLElement>('[data-instance-id="keyboard"]');
  if (kb) {
    keyboardSourceItem = kb;
    nCanvas.mountItem(kb, canvasPrefs.widgets["kb"] ?? KB_HOME, { focus: false });
    keyboardSourceGeometry = nCanvas.getItemState(kb);
  }
  syncKeyboardSourceVisibility(false);
  syncKeyboardSourceCaps();
  labelCanvasMarkers();
  if (canvasPrefs.camera) nCanvas.restoreCamera(canvasPrefs.camera);
  syncPadWidgets();
  syncKeyboardWorkbenchWidget(false);
  syncControlSurfaceWidget(false);
  if (flowLines && flowPorts && flowNodes) {
    mappingFlowLayer?.dispose();
    mappingFlowLayer = new MappingFlowLayer(
      scope,
      viewport,
      stage,
      flowLines,
      flowPorts,
      flowNodes,
      {
        onLayout: paintMappingFlowCount,
        getProcessorOffset,
        processorOffsetIsSessionOnly,
        onProcessorOffsetCommit: (processorId, offset) => {
          return offset
            ? commitProcessorOffset(processorId, offset)
            : removeProcessorOffset(processorId);
        },
        announce: (message) => {
          const sr = (learnRoot ?? scope).querySelector<HTMLElement>(".n-live-sr");
          if (sr) sr.textContent = message;
        },
        routeList: flowRouteList,
        traceOutput: flowTrace,
      },
    );
    syncMappingFlow();
  }
  if (Object.keys(canvasPrefs.widgets).length === 0) {
    // Nothing arranged yet: open the way "Tidy up" would leave it, rather
    // than at spawn positions the user never chose. One frame later, so the
    // widgets have laid out and measure true.
    window.requestAnimationFrame(() => arrangeCanvas());
  } else if (!canvasPrefs.camera) {
    window.requestAnimationFrame(() => nCanvas?.fitAll());
  }
  window.addEventListener("pagehide", () => {
    // flushPendingChange only fires the onChange callback — whose debounce
    // timer will never tick in a dying page. The synchronous persist IS the
    // durability; the flush just settles the engine's pending rAF first.
    nCanvas?.flushPendingChange();
    persistCanvas();
  });
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
const [nViewCtlPressed, setNViewCtlPressed] = createSignal("true");
const [nViewKeysPressed, setNViewKeysPressed] = createSignal("false");
const [nIdLinkCls, setNIdLinkCls] = createSignal("n-link");
const [nIdBoxCls, setNIdBoxCls] = createSignal("n-idbox none");
const [nIdText, setNIdText] = createSignal("Press a key on the keyboard you want to use");

const ui: {
  dlg: boolean;
  leftRail: boolean;
  rightRail: boolean;
  identify: boolean;
  rightView: "controls" | "keys";
  kbSolo: boolean;
} = {
  dlg: false,
  leftRail: false,
  rightRail: false,
  identify: false,
  rightView: "controls",
  kbSolo: false,
};

type InspectorContext =
  | { kind: "overview" }
  | { kind: "key"; key: string }
  | { kind: "control"; slot: string; preset: string; functionName: string };

let inspectorContext: InspectorContext = { kind: "overview" };

function applyNocturneUi(): void {
  setNDlgOpen(ui.dlg);
  setNLeftCls(ui.leftRail ? "n-left rail" : "n-left");
  setNRightCls(
    "n-right" +
      (ui.rightRail ? " rail" : "") +
      (ui.rightView === "keys" ? " keys-mode" : "") +
      (inspectorContext.kind === "overview" ? "" : " context-mode"),
  );
  setNViewCtlPressed(String(ui.rightView === "controls"));
  setNViewKeysPressed(String(ui.rightView === "keys"));
  const pads = lastBindView?.pads ?? [];
  setNCenterCls(
    "n-center" +
      (ui.kbSolo ? " solo" : "") +
      pads
        .filter((pv) => hiddenStrips.has(pv.preset))
        .map((pv) => ` mute${pv.slot}`)
        .join(""),
  );
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
      rightView?: string;
      kbSolo?: boolean;
    };
    ui.leftRail = saved.leftRail === true;
    ui.rightView = saved.rightView === "keys" ? "keys" : "controls";
    ui.rightRail = saved.rightRail === true;
    ui.kbSolo = saved.kbSolo === true;
  } catch {
    // A blocked or corrupt store reads as the defaults.
  }
}

/** Identity colors, keyed by PRESET NAME — the controller's stable
 *  identity: seats renumber on reorder, worksheets travel, and the color
 *  travels with them. First-seen defaults are made STICKY (persisted), so
 *  even a never-touched controller keeps its color wherever it moves;
 *  new controllers take the first free color. Browser-kept, never daemon
 *  state; with an empty store the assignment equals the CSS defaults and
 *  no style attribute is written (the parity gate's rule). */
const COLOR_STORE = "ksx-nocturne-colors2";
let padColors: Record<string, number> = {};
/** Presets whose color strips are hidden on the BOARD (same identity
 *  rule). The kbhead's "Colors" button stays the master switch. */
const STRIPS_STORE = "ksx-nocturne-strips2";
let hiddenStrips = new Set<string>();

function saveSlotColors(): void {
  try {
    window.localStorage.setItem(COLOR_STORE, JSON.stringify(padColors));
  } catch {
    // The preference simply will not survive this session.
  }
}

/** Every current pad's color, resolved: picks first, then seat defaults
 *  skipping taken colors; unseen presets get their default PERSISTED so
 *  it sticks to the controller from now on. */
function colorAssignments(): Map<number, number> {
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
 *  color ringed, colors worn by OTHER controllers disabled and named.
 *  Runs when a picker opens and after a pick — never at hydration, so the
 *  SSR paint stays byte-identical. */
function refreshSwatches(): void {
  const root = learnRoot;
  if (!root) return;
  const pads = lastBindView?.pads ?? [];
  const assigned = colorAssignments();
  for (const pick of Array.from(root.querySelectorAll<HTMLElement>(".n-cpick[data-slot]"))) {
    const slot = Number(pick.getAttribute("data-slot") ?? "");
    for (const sw of Array.from(pick.querySelectorAll<HTMLButtonElement>(".n-swatch"))) {
      const color = Number(sw.getAttribute("data-color") ?? "");
      const owner = pads.find((pv) => pv.slot !== slot && assigned.get(pv.slot) === color);
      sw.disabled = Boolean(owner);
      sw.classList.toggle("taken", Boolean(owner));
      sw.classList.toggle("mine", color === assigned.get(slot));
      sw.title = owner ? `Worn by P${owner.slot}` : `Color ${color}`;
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
      ? "Show this controller's color on the keys"
      : "Hide this controller's color on the keys";
  }
}

/** The presets the last payload carried, so an ARRIVING controller can be
 *  told apart from one that was here all along. */
let lastPresets = new Set<string>();

/** A crossing belongs to the controller you crossed — not to its NAME. The
 *  daemon recycles preset names ("Player 2" comes back the moment a seat
 *  frees), so a crossing left behind by a removed controller would hide a
 *  brand-new one the instant it arrives. Two rules keep that honest: drop
 *  crossings whose controller is gone, and never let one apply to a
 *  controller that just showed up. Colors are deliberately NOT pruned —
 *  inheriting a color hides nothing, and it means an undone removal comes
 *  back wearing the color you gave it. */
function pruneHiddenStrips(): void {
  const pads = lastBindView?.pads ?? [];
  // An empty roster is a draft being discarded or adopted, not a removal:
  // it must not wipe the crossings the next payload will need.
  if (pads.length === 0) return;
  const live = new Set(pads.map((pv) => pv.preset));
  let changed = false;
  for (const preset of [...hiddenStrips]) {
    const gone = !live.has(preset);
    const arrived = live.has(preset) && !lastPresets.has(preset);
    if (gone || arrived) {
      hiddenStrips.delete(preset);
      changed = true;
    }
  }
  lastPresets = live;
  if (changed) saveHiddenStrips();
}

/** The lens closed and your own crossings returned: pulse them once, so
 *  the state you get back is SEEN rather than discovered later. */
function flashRestoredChips(): void {
  const root = learnRoot;
  if (!root) return;
  for (const chip of Array.from(root.querySelectorAll<HTMLElement>(".n-lgd.muted"))) {
    chip.classList.remove("back");
    void chip.offsetWidth;
    chip.classList.add("back");
    window.setTimeout(() => chip.classList.remove("back"), 1300);
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
  const assigned = colorAssignments();
  for (const [slot, idx] of assigned) {
    const fallback = ((slot - 1) % 16) + 1;
    // Write only where the truth differs from the CSS default (and clear
    // where it no longer does): an untouched setup writes nothing.
    if (idx !== fallback) {
      root.style.setProperty(`--pcs${slot}`, `var(--pal${idx})`);
      // The label's ink travels with the color it sits on — half this
      // palette is dark enough that near-black text would vanish on it.
      root.style.setProperty(`--pcs${slot}-ink`, `var(--pal${idx}-ink)`);
      root.style.setProperty(`--pcs${slot}-key`, `var(--pal${idx}-key)`);
    } else {
      root.style.removeProperty(`--pcs${slot}`);
      root.style.removeProperty(`--pcs${slot}-ink`);
      root.style.removeProperty(`--pcs${slot}-key`);
    }
  }
}

function saveUiPrefs(): void {
  try {
    window.localStorage.setItem(
      UI_STORE,
      JSON.stringify({
        leftRail: ui.leftRail,
        rightRail: ui.rightRail,
        rightView: ui.rightView,
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
  /** Canonical selector resolved server-side from the Raw Input HID child. */
  selector?: string | null;
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
  /** Opaque token from the exact served controller row this action opened
   *  on. It survives a conflict dialog unchanged; the browser never derives
   *  it from the slot number, preset, persona, or artwork. */
  expectedTargetRevision?: string;
  /** Source identity captured with the same user gesture. `null` encoder
   *  authority is meaningful: it says this was an ordinary keyboard action,
   *  not permission to discover a programmable encoder at commit time. */
  bindingAuthorityPinned?: boolean;
  purpose?: "binding" | "surface" | "panel-test";
  expectedDevice?: string;
  expectedInstance?: string;
  surfaceIdentity?: string;
  surfaceControlId?: string;
  surfaceChannelId?: string;
  surfacePhysicalId?: string;
}

interface BindingSourcePin {
  bindingAuthorityPinned: true;
  expectedDevice: string;
  expectedInstance: string;
}

function captureBindingSourcePin(): BindingSourcePin {
  return {
    bindingAuthorityPinned: true,
    expectedDevice: nCapSelector().trim(),
    expectedInstance: nCapInstance().trim(),
  };
}

function stagedBindingRevisionSignature(): string {
  return (lastBindView?.pads ?? [])
    .map((pad) => `${pad.slot}:${pad.target_revision?.trim() ?? ""}`)
    .sort()
    .join("\n");
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
let nocturnePollFn: () => Promise<void> = async () => {};

export function setNocturnePoll(fn: () => Promise<void>): void {
  nocturnePollFn = fn;
}

/** Pin a mapping action to the exact controller row the browser observed.
 *  Key-first assignment already owns a source pin before a controller exists;
 *  add only its target revision here. A fully pinned row is returned verbatim:
 *  that keeps conflict confirmation from adopting either newer authority. */
function pinBindingTarget(row: LearnTarget): LearnTarget | null {
  if ((row.purpose ?? "binding") !== "binding") return row;
  const revision = row.expectedTargetRevision?.trim() || lastBindView?.pads.find(
    (pad) => String(pad.slot) === row.slot,
  )?.target_revision?.trim() || "";
  if (!revision) return null;
  if (row.bindingAuthorityPinned) {
    return row.expectedTargetRevision?.trim()
      ? row
      : { ...row, expectedTargetRevision: revision };
  }
  return {
    ...row,
    expectedTargetRevision: revision,
    ...captureBindingSourcePin(),
  };
}

function sameBindingIdentity(left: string | undefined, right: string): boolean {
  return (left ?? "").trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

/** A learner observation is authoritative only for the exact input selected
 * when the action was armed. Real Raw Input hits usually carry a HID child,
 * while Studio's picker carries its USB MI_00 parent, so the server-resolved
 * selector is the primary proof. The exact-instance arm is the narrow fallback
 * for a direct USB observation or an older provider that cannot resolve one.
 * An unresolved HID child therefore fails closed. */
function learnHitBelongsToPinnedSource(row: LearnTarget, learn: NocturneLearnView): boolean {
  const expectedSelector = row.expectedDevice?.trim() ?? "";
  const expectedInstance = row.expectedInstance?.trim() ?? "";
  if (!expectedSelector || !expectedInstance) return false;
  if (!sameBindingIdentity(expectedSelector, nCapSelector()) ||
      !sameBindingIdentity(expectedInstance, nCapInstance())) return false;
  const selectorMatches = Boolean(learn.selector?.trim()) &&
    sameBindingIdentity(learn.selector ?? "", expectedSelector);
  const exactInstanceMatches = Boolean(learn.device?.trim()) &&
    sameBindingIdentity(learn.device ?? "", expectedInstance);
  return selectorMatches || exactInstanceMatches;
}

function bindingSourceAuthorityCurrent(row: {
  bindingAuthorityPinned?: boolean;
  expectedDevice?: string;
  expectedInstance?: string;
}): boolean {
  if (!row.bindingAuthorityPinned) return true;
  return sameBindingIdentity(row.expectedDevice, nCapSelector()) &&
    sameBindingIdentity(row.expectedInstance, nCapInstance());
}

function bindingTargetAuthorityCurrent(row: LearnTarget): boolean {
  if (!bindingSourceAuthorityCurrent(row)) return false;
  const expected = row.expectedTargetRevision?.trim();
  if (!expected) return false;
  return lastBindView?.pads.some(
    (pad) => String(pad.slot) === row.slot && pad.target_revision?.trim() === expected,
  ) ?? false;
}

/** Polls and hardware-status refreshes can invalidate a gesture while the
 *  listener, key picker, or conflict dialog is still open. Retire it as soon
 *  as that newer authority is observed; the server remains the final atomic
 *  gate if the payload and the click cross in flight. */
function reconcileBindingActionAuthority(): void {
  let retired = false;
  if (learnRow && (learnRow.purpose ?? "binding") === "binding" &&
      !bindingTargetAuthorityCurrent(learnRow)) {
    autoMap = null;
    void cancelLearn();
    retired = true;
  }
  if (assignKey && assignSourcePin &&
      (!bindingSourceAuthorityCurrent(assignSourcePin) ||
       assignDraftRevision !== stagedBindingRevisionSignature())) {
    cancelAssign();
    retired = true;
  }
  if (pendingConflict && !bindingTargetAuthorityCurrent(pendingConflict.row)) {
    pendingConflict = null;
    setNConfOpen(false);
    restoreDialogFocus();
    retired = true;
  }
  if (retired) {
    keyboardWorkbenchAnnounce(
      "The selected input or controller draft changed in another action. The old mapping gesture was cancelled before it could write.",
    );
  }
}

/** A completed write deliberately opens a new action. Strip every old pin so
 *  it captures the post-write row and hardware authority after the awaited
 *  mutation poll. Conflict retries never call this helper. */
function reopenBindingTarget(
  row: LearnTarget,
  mode: "replace" | "add" | "remove",
): LearnTarget {
  return {
    ...row,
    mode,
    expectedTargetRevision: undefined,
    bindingAuthorityPinned: undefined,
    expectedDevice: undefined,
    expectedInstance: undefined,
  };
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
    learnRoot.querySelectorAll<HTMLElement>(".n-bind.arm, .n-ctlchip.arm, .n-center .arm"),
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
    for (const el of Array.from(learnRoot.querySelectorAll<HTMLElement>(".n-canvas [data-fn]"))) {
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
  if (row.purpose === "surface") {
    setNLearnCls("n-learnbar listen");
    setNLearnText(`Teach physical input · ${row.label}`);
    setNLearnSub("Press the real wired control. KSX records what Windows receives; no mapping changes. Esc cancels.");
    setNLearnSkipCls("n-bbtn sm none");
    setNChainCls("n-chain none");
    setNKeyCueCls("n-key-cue");
    setNKeyCueText(`Teaching ${row.label} — press the real wired control`);
    markArmedRow(null);
    controlSurfaceItem
      ?.querySelector<HTMLElement>(
        `.n-surface-control[data-surface-control-id="${CSS.escape(row.surfaceControlId ?? "")}"]`,
      )
      ?.classList.add("teach");
    setRailGlow(true);
    return;
  }
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
  for (const control of Array.from(
    controlSurfaceItem?.querySelectorAll<HTMLElement>(".n-surface-control.teach") ?? [],
  )) {
    control.classList.remove("teach");
  }
  setRailGlow(false);
}

/** Retire the current browser attempt in one place. */
function retireLearn(): void {
  const wasPanelTest = learnRow?.purpose === "panel-test";
  stopLearnTimer();
  learnGen += 1;
  learnRow = null;
  daemonGen = null;
  disarmFocusGuard();
  disarmLearnUi();
}

async function startLearn(row: LearnTarget): Promise<void> {
  const pinned = pinBindingTarget(row);
  if (!pinned) {
    autoMap = null;
    applyFlash(
      "error: This controller changed or came from an older daemon. Refresh the canvas before mapping it.",
    );
    return;
  }
  row = pinned;
  if (!row.expectedDevice?.trim() || !row.expectedInstance?.trim()) {
    autoMap = null;
      applyFlash(
        "error: Select an input with a verified Windows device identity before listening for a key. Nothing changed.",
      );
    

    return;
  }
  if ((row.purpose ?? "binding") === "binding" &&
      (!bindingTargetAuthorityCurrent(row))) {
    autoMap = null;
    applyFlash(
      "error: This encoder is being changed or recovered. Read its complete chart before mapping another control.",
    );
    return;
  }
  // PadForge convention: clicking the control being recorded cancels it.
  if (
    learnRow &&
    learnRow.fn === row.fn &&
    learnRow.mode === row.mode &&
    learnRow.purpose === row.purpose &&
    learnRow.surfaceIdentity === row.surfaceIdentity &&
    learnRow.surfaceControlId === row.surfaceControlId &&
    learnRow.surfaceChannelId === row.surfaceChannelId &&
    learnRow.surfacePhysicalId === row.surfacePhysicalId &&
    learnRow.expectedTargetRevision === row.expectedTargetRevision &&
    learnRow.expectedDevice === row.expectedDevice &&
    learnRow.expectedInstance === row.expectedInstance
  ) {
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
    if (started.state === "hit") void pollLearn(started);
  } catch {
    if (learnGen !== gen) return;
    retireLearn();
    applyFlash("error: Can't listen for a key — is ksx studio still running?");
  }
}

async function pollLearn(observed?: NocturneLearnView): Promise<void> {
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
      learn = await fetchJSON<NocturneLearnView>("/api/learn");
    } catch {
      return; // transient — keep listening on the last known state
    }
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
      setNLearnSub(
        row.purpose === "panel-test"
          ? `Press any wired cabinet control; no mapping changes. ${secs}s left · Esc cancels.`
          : row.purpose === "surface"
          ? `Press the real wired control; no mapping changes. ${secs}s left · Esc cancels.`
          : `${learnSentence(row.mode)} ${secs}s left · ${esc}`,
      );
      break;
    }
    case "hit": {
      // Retire before the asynchronous write: the 33 ms timer and the
      // fast-hit poll may overlap, and only the first terminal response may
      // reach the bind verb.
      const chain = chainWanted();
      retireLearn();
      if (!learn.key) break;
      if (!learnHitBelongsToPinnedSource(row, learn)) {
        const observed = learn.device?.trim() || "an unresolved Windows input";
        if (row.purpose === "surface") {
          keyboardWorkbenchAnnounce(
            `Ignored ${learn.key}: Windows reported ${observed}, not the selected keyboard or encoder. Nothing changed.`,
          );
        } else {
          autoMap = null;
          applyFlash(
            `error: Ignored ${learn.key} from another or unresolved keyboard. The selected controller binding was not changed.`,
          );
        }
        break;
      }
      if (row.purpose === "surface") {
        const controlId = row.surfaceControlId ?? "";
        const channelId = row.surfaceChannelId ?? "";
        if (controlId && channelId) {
          teachSelectedControlSurfaceWithKey(
            row.surfaceIdentity ?? "",
            controlId,
            channelId,
            row.surfacePhysicalId ?? "",
            learn.key,
            row.expectedInstance ?? "",
          );
        }
        break;
      }
      lastWrite = { origin: "learn", chain, assignMode: "replace" };
      void writeLearnedKey(row, learn.key, false).then((ok) => {
        // "Bind several": the control keeps listening; further keys ADD.
        if (ok && chain && !autoMap) {
          void startLearn(reopenBindingTarget(row, "add"));
          setChainBox(true);
        }
      });
      break;
    }
    case "timeout":
      retireLearn();
      if (row.purpose === "surface") {
        applyFlash(
          `error: Timed out — no physical input was received for ${row.label}. Nothing changed.`,
        );
      } else if (autoMap) {
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

function normalizedControlFunction(value: string): string {
  return value.trim().toLowerCase();
}

/** The old pane renders bound rows and free-control chips as separate lists.
 * Keep that projection only as a compatibility fallback for a stale payload;
 * current payloads carry `pad.controls`, which is the authoring contract. */
function legacySelectedControls(view: NocturneView): NocturneControlFlowView[] {
  const groups: readonly [
    string,
    readonly NocturneBindRowView[],
    readonly NocturneCtlChipView[],
  ][] = [
    ["face", view.bind_face, view.avail_ctl_face],
    ["dpad", view.bind_dpad, view.avail_ctl_dpad],
    ["shoulders", view.bind_shoulders, view.avail_ctl_shoulders],
    ["left-stick", view.bind_lstick, view.avail_ctl_lstick],
    ["right-stick", view.bind_rstick, view.avail_ctl_rstick],
    ["system", view.bind_system, view.avail_ctl_system],
  ];
  const controls: NocturneControlFlowView[] = [];
  const seen = new Set<string>();
  for (const [group, bound, available] of groups) {
    for (const row of bound) {
      const identity = normalizedControlFunction(row.function);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      controls.push({
        function: row.function,
        label: row.label,
        group,
        order: controls.length,
        keys: row.chip === "—" ? [] : row.chip.split(/\s*·\s*/u).filter(Boolean),
        toggle: row.tog_cls.includes(" on"),
        turbo_hz: /^\d+$/.test(row.turbo) ? Number(row.turbo) : null,
      });
    }
    for (const row of available) {
      const identity = normalizedControlFunction(row.function);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      controls.push({
        function: row.function,
        label: row.label,
        group,
        order: controls.length,
        keys: [],
        toggle: false,
        turbo_hz: null,
      });
    }
  }
  return controls;
}

/** Ordered, exact controller endpoints without consulting rendered pane DOM.
 * This is the seam the canvas selection/composer will build on. */
function controlsForPad(
  view: NocturneView | null,
  slot: string,
): NocturneControlFlowView[] {
  if (!view) return [];
  const pad = view.pads.find((candidate) => String(candidate.slot) === slot);
  if (pad?.mapping_available === false) return [];
  if (pad?.controls !== undefined) {
    return [...pad.controls].sort((left, right) => left.order - right.order);
  }
  if (slot === view.slot_val) return legacySelectedControls(view);
  return Object.entries(pad?.fn_names ?? {}).map(([fn, label], order) => ({
    function: fn,
    label,
    group: "system",
    order,
    keys: [],
    toggle: false,
    turbo_hz: null,
  }));
}

function controlForPad(
  view: NocturneView | null,
  slot: string,
  rawFunction: string,
): NocturneControlFlowView | undefined {
  const wanted = normalizedControlFunction(rawFunction);
  return controlsForPad(view, slot).find(
    (control) => normalizedControlFunction(control.function) === wanted,
  );
}

function refreshInspectorCopy(): void {
  if (inspectorContext.kind === "control") {
    const currentPad = lastBindView?.pads.find(
      (pad) => String(pad.slot) === inspectorContext.slot,
    );
    if (!currentPad || currentPad.preset !== inspectorContext.preset) {
      inspectorContext = { kind: "overview" };
      applyNocturneUi();
    }
  }
  let kicker = "MAPPING INSPECTOR";
  let title = nBindTitle() || "Browse mappings";
  let meta = nBindFoot() || "Select a key or controller control to inspect its connections.";
  let action = "Find mappings";
  if (inspectorContext.kind === "key") {
    let count = 0;
    let players = 0;
    for (const pad of lastBindView?.pads ?? []) {
      const before = count;
      for (const control of pad.controls ?? []) {
        if (control.keys.includes(inspectorContext.key)) count += 1;
      }
      for (const macro of pad.macros ?? []) {
        if (macro.triggers.includes(inspectorContext.key)) count += 1;
      }
      if (count > before) players += 1;
    }
    kicker = "PHYSICAL KEY";
    title = inspectorContext.key;
    meta = count === 0
      ? "Unbound · ready to connect"
      : `${count} destination${count === 1 ? "" : "s"} · ${players} player${players === 1 ? "" : "s"} · P${nSlotVal()} details below`;
    action = count === 0 ? "Connect to control…" : "Connect another…";
  } else if (inspectorContext.kind === "control") {
    const control = controlForPad(
      lastBindView,
      inspectorContext.slot,
      inspectorContext.functionName,
    );
    const keys = control?.keys ?? [];
    const behavior = [
      control?.toggle ? "Toggle" : "Hold",
      control?.turbo_hz ? `${control.turbo_hz}/s turbo` : "",
    ].filter(Boolean).join(" · ");
    kicker = "CONTROLLER CONTROL";
    title = `P${inspectorContext.slot} · ${control?.label ?? inspectorContext.functionName}`;
    meta = `${keys.length === 0 ? "No source key assigned" : `Driven by ${keys.join(" · ")}`} · ${behavior}`;
    action = keys.length === 0 ? "Assign source key…" : "Add source…";
  }
  const card = learnRoot?.querySelector<HTMLElement>(".n-inspector-card");
  if (!card) return;
  card.querySelector<HTMLElement>(".n-inspector-kicker")!.textContent = kicker;
  card.querySelector<HTMLElement>(".n-inspector-title")!.textContent = title;
  card.querySelector<HTMLElement>(".n-inspector-meta")!.textContent = meta;
  card.querySelector<HTMLElement>(".n-inspector-action")!.textContent = action;
}

function applyInspectorContextRows(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>(".n-context-hide")) {
    element.classList.remove("n-context-hide");
  }
  if (inspectorContext.kind === "overview") return;

  if (inspectorContext.kind === "key") {
    for (const candidate of root.querySelectorAll<HTMLElement>(
      ".n-krows .n-krow[data-key], .n-krows .n-akey[data-key]",
    )) {
      const matches = candidate.dataset.key === inspectorContext.key;
      candidate.classList.toggle("n-context-hide", !matches);
    }
    return;
  }

  const wanted = normalizedControlFunction(inspectorContext.functionName);
  for (const candidate of root.querySelectorAll<HTMLElement>(
    ".n-bindgroups details.n-bind[data-fn], .n-bindgroups .n-ctlchip[data-fn], .n-macrosec details[data-fn]",
  )) {
    const candidateSlot = candidate.dataset.slot ?? nSlotVal();
    const matches =
      candidateSlot === inspectorContext.slot &&
      normalizedControlFunction(candidate.dataset.fn ?? "") === wanted;
    candidate.classList.toggle("n-context-hide", !matches);
    if (matches && candidate instanceof HTMLDetailsElement) candidate.open = true;
  }
}

function setInspectorContext(next: InspectorContext): void {
  inspectorContext = next;
  if (next.kind === "key") ui.rightView = "keys";
  else if (next.kind === "control") ui.rightView = "controls";
  const root = learnRoot;
  const input = root?.querySelector<HTMLInputElement>(".n-filter-in");
  if (input?.value) {
    input.value = "";
    applyNocturneFilter(root, "");
    mergeQuery({ q: null });
  }
  applyNocturneUi();
  refreshInspectorCopy();
  if (root) applyInspectorContextRows(root);
}

function clearInspectorContext(preserveFilter = false): void {
  if (!preserveFilter) {
    setInspectorContext({ kind: "overview" });
    return;
  }
  inspectorContext = { kind: "overview" };
  applyNocturneUi();
  refreshInspectorCopy();
  if (learnRoot) applyInspectorContextRows(learnRoot);
}

function startAutoMap(): void {
  const steps = controlsForPad(lastBindView, nSlotVal())
    .filter((control) => !control.function.startsWith("macro."))
    .map((control) => ({ fn: control.function, label: control.label }));
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
  const pinned = pinBindingTarget(row);
  if (!pinned || (force && pinned !== row)) {
    autoMap = null;
    pendingConflict = null;
    setNConfOpen(false);
    applyFlash(
      "error: This controller changed or came from an older daemon. Refresh the canvas before mapping it.",
    );
    return false;
  }
  row = pinned;
  // This is the final common commit boundary for captured hits, clicked-key
  // assignment, chained binding, and conflict confirmation. Authority may
  // change after any earlier arm or dialog opened, so no caller can safely
  // substitute an arm-time check for this one.
  if ((row.purpose ?? "binding") === "binding" &&
      (!bindingTargetAuthorityCurrent(row))) {
    autoMap = null;
    pendingConflict = null;
    setNConfOpen(false);
    applyFlash(
      "error: This encoder is being changed or recovered. Its unproven key was not mapped.",
    );
    return false;
  }
  // The exact machine authority belongs to the gesture, not to POST time.
  // A conflict confirmation therefore sends the same instance/fingerprint/
  // chart proof the user originally saw, while the checks above reject it if
  // that authority is no longer current.
  let outcome: NocturneBindOutcome;
  try {
    outcome = await fetchJSON<NocturneBindOutcome>("/nocturne/api/bind", {
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
    const surfaceSignal = controlSurfaceState.controls.some((control) =>
      control.channels.some(
        (channel) => controlSurfaceSignalTruth(channel).flowKey === key,
      )
    );
    if (lastWrite.origin === "assign" && surfaceSignal) {
      const slots = new Set(controlSurfaceRoutesForKey(key).map((route) => route.slot));
      const routedSlot = Number(row.slot);
      if (Number.isInteger(routedSlot) && routedSlot >= 1) slots.add(routedSlot);
      const currentSlot = Number(nSlotVal() || "1");
      if (slots.size > 1 || [...slots].some((slot) => slot !== currentSlot)) {
        setMappingPathMode("all");
      }
    }
    applyFlash(line);
    // A successful bind changes the controller's content revision. Wait for
    // the newly served row before a chained/auto-map action opens its next
    // target, rather than reusing the token that just committed.
    await nocturnePollFn();
    const refreshedRevision = lastBindView?.pads.find(
      (pad) => String(pad.slot) === row.slot,
    )?.target_revision?.trim() ?? "";
    if (!refreshedRevision || refreshedRevision === row.expectedTargetRevision?.trim()) {
      autoMap = null;
      applyFlash(
        `${line} Refresh the canvas before mapping another control; KSX could not confirm the new draft revision.`,
      );
      return false;
    }
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
const liveSlotFnsDown = new Map<number, Set<string>>();
const liveSlotFnHits = new Map<number, Set<string>>();
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
  mappingFlowLayer?.setLive(EMPTY_FNS, EMPTY_FNS, new Map(), new Map());
}

function resetLiveLedger(): void {
  liveAccepted = null;
  liveEvents = 0;
  liveDropped = 0;
  liveKeysDown.clear();
  liveFnsDown.clear();
  liveSlotFns.clear();
  liveSlotFnsDown.clear();
  liveSlotFnHits.clear();
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
  const sessionChanged = liveFingerprint() !== before;
  if (sessionChanged) resetLiveLedger();
  liveConfirmed = true;
  if (!liveLicensed()) {
    clearLivePaint();
    // The status region is shared with direct user-action feedback. An idle
    // structure poll carrying the same stopped session is not a transition and
    // must not erase a mapping, movement, or hardware announcement that just
    // landed there. A real stopped/running/profile/reachability change still
    // announces through the fingerprint transition above.
    if (sessionChanged) {
      liveAnnounce(
        liveSession?.running
          ? "Live input is unavailable: Play is using a different setup."
          : "Live input is inactive.",
      );
    }
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
    // A stopped frame is an authoritative session boundary. Revoke the
    // staged-origin license as well as its visual ledger; a later running
    // frame may belong to a different session and must wait for structure
    // truth from /api/nocturne before it can paint.
    invalidateLive();
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
  liveSlotFnsDown.clear();
  liveSlotFnHits.clear();
  for (const sf of envelope.frame.slots) {
    const down = new Set(sf.down.map(normalizedFn));
    const hits = new Set(sf.hit.map(normalizedFn));
    liveSlotFnsDown.set(sf.slot, down);
    liveSlotFnHits.set(sf.slot, hits);
    liveSlotFns.set(sf.slot, new Set([...down, ...hits]));
  }
  const selectedFrame =
    liveSlotFns.get(Number(nSlotVal() || "1")) ?? liveSlotFns.values().next().value ?? EMPTY_FNS;
  liveFnsDown.clear();
  for (const control of selectedFrame) liveFnsDown.add(control);
  // A dropped frame may have contained a release. The transition stream has
  // no authoritative held-key snapshot, so keeping the old ledger would turn
  // uncertainty into a false active cord. Fail closed, then rebuild only from
  // transitions this frame actually carries.
  if (envelope.frame.dropped > 0) liveKeysDown.clear();
  const liveKeyHits = new Set<string>();
  for (const hit of envelope.frame.keys) {
    const key = hit.key.trim();
    if (key === "") continue;
    if (hit.down) {
      liveKeysDown.add(key);
      liveKeyHits.add(key);
    }
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
    const key = el.dataset.key ?? "";
    el.classList.toggle("live", liveKeysDown.has(key) || liveKeyHits.has(key));
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
  // Runtime paint is separate from configuration truth: a cord moves only
  // when this exact physical key and its mapped control are both present in
  // the same frame. Fan-in therefore never lights the wrong source strand.
  mappingFlowLayer?.setLive(liveKeysDown, liveKeyHits, liveSlotFnsDown, liveSlotFnHits);
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
  const pane = root.querySelector<HTMLElement>(".n-right");
  if (!pane) return;
  const query = q.trim().toLowerCase();
  pane.classList.toggle("filtering", query !== "");
  // A row matches on its own label OR its group's ("stick" finds both
  // stick clusters even though the rows are spelled L3/←/→); a group whose
  // rows are ALL hidden hides its header too. Only under an active filter,
  // so the initial paint stays byte-equal to SSR.
  for (const group of Array.from(pane.querySelectorAll<HTMLElement>(".n-bindg"))) {
    const glabel = (group.querySelector(".n-bindg-lab")?.textContent ?? "").toLowerCase();
    const gmatch = query !== "" && glabel.includes(query);
    for (const el of Array.from(group.querySelectorAll<HTMLElement>(".n-bind"))) {
      const searchable = `${el.dataset.fn ?? ""} ${el.textContent ?? ""}`.toLowerCase();
      el.classList.toggle("hide", query !== "" && !gmatch && !searchable.includes(query));
    }
    for (const chip of Array.from(group.querySelectorAll<HTMLElement>(".n-ctlchip"))) {
      const searchable = `${chip.dataset.fn ?? ""} ${chip.textContent ?? ""}`.toLowerCase();
      chip.classList.toggle("hide", query !== "" && !gmatch && !searchable.includes(query));
    }
    const visible =
      group.querySelector(".n-bind:not(.hide)") !== null ||
      group.querySelector(".n-ctlchip:not(.hide)") !== null;
    group.classList.toggle("empty", query !== "" && !visible);
  }
  for (const key of pane.querySelectorAll<HTMLElement>(".n-krows [data-key]")) {
    const searchable = `${key.dataset.key ?? ""} ${key.textContent ?? ""}`.toLowerCase();
    key.classList.toggle("hide", query !== "" && !searchable.includes(query));
  }
  for (const section of pane.querySelectorAll<HTMLElement>(".n-krows .n-akeysec")) {
    section.classList.toggle(
      "filter-empty",
      query !== "" && section.querySelector(".n-akey:not(.hide)") === null,
    );
  }
  for (const macro of pane.querySelectorAll<HTMLElement>(".n-macrosec details[data-fn]")) {
    const searchable = `${macro.dataset.fn ?? ""} ${macro.textContent ?? ""}`.toLowerCase();
    macro.classList.toggle("hide", query !== "" && !searchable.includes(query));
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
let assignSourcePin: BindingSourcePin | null = null;
let assignDraftRevision = "";

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
        `.n-kb [data-key="${CSS.escape(key)}"], .n-akey-grid [data-key="${CSS.escape(key)}"], .n-deck-key[data-keylab-key="${CSS.escape(key)}"], .n-surface-control:has(.n-surface-channel-anchor[data-key="${CSS.escape(key)}"])`,
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
  assignSourcePin = captureBindingSourcePin();
  assignDraftRevision = stagedBindingRevisionSignature();
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
  assignSourcePin = null;
  assignDraftRevision = "";
  setChainBox(false);
  if (assignTimer !== undefined) {
    window.clearInterval(assignTimer);
    assignTimer = undefined;
  }
  setNLearnCls("n-learnbar none");
  markAssignTargets(null);
  setRailGlow(false);
}

function resolveLearnWithKey(key: string, chain: boolean): boolean {
  const row = learnRow;
  if (!row) return false;
  if (row.purpose === "surface" || row.purpose === "panel-test") {
    keyboardWorkbenchAnnounce(
      `${key} was only clicked in the drawing, so it was not recorded as physical input${row.purpose === "panel-test" ? " and no mapping was changed" : ""}. Press the real wired control instead.`,
    );
    return true;
  }
  lastWrite = { origin: "learn", chain, assignMode: "replace" };
  void cancelLearn();
  void writeLearnedKey(row, key, false).then((ok) => {
    if (ok && chain && !autoMap) {
      void startLearn(reopenBindingTarget(row, "add"));
      setChainBox(true);
    }
  });
  return true;
}

/** The dialog keyboard contract: Escape closes the open dialog, Tab stays
 *  inside it, and focus lands on the panel when one opens — returning to
 *  the opener on close. (The learn guard's capture listener still owns
 *  Escape while a capture is armed.) */
let dialogReturnFocus: HTMLElement | null = null;
let focusMacroOnNextPayload: { slot: string; macro: string } | null = null;
let restoreMacroFocusOnNextPayload = false;

function macroDialogOpen(): boolean {
  return !nMacBackCls().includes("none");
}

function anyDialogOpen(): boolean {
  return inputTestDialog?.open === true || ui.dlg || nConfOpen() || nApplyOpen() ||
    macroDialogOpen();
}

/** Leave the macro editor the way its ✕ does — the dialog's open state IS
 *  the URL, so closing is a navigation, enhanced here into a URL swap.
 *
 *  Unsaved work is never dropped on the first press: the editor says what
 *  closing would cost, and a second press closes anyway. */
function closeMacroDialog(): void {
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
  macDirtyMark();
  mergeQuery({ macro: null });
  focusMacroOnNextPayload = null;
  restoreMacroFocusOnNextPayload = true;
  nocturnePollFn();
}

function closeOpenDialog(): void {
  // The native input diagnostic is appended to <body>, above every island
  // dialog and canvas state. Give it first refusal so Escape cannot leak
  // through to an armed assignment, Inspector context, or widget focus mode.
  if (inputTestDialog?.open) {
    void closeInputTest();
    return;
  }
  // The macro panel is the outermost of the four, so it yields to any
  // dialog opened on top of it.
  if (!nApplyOpen() && !nConfOpen() && !ui.dlg && macroDialogOpen()) {
    closeMacroDialog();
    return;
  }
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

function focusDialog(rememberReturn = true): void {
  if (rememberReturn) {
    dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  // The createShow branch attaches on the next microtask; focus one frame on.
  window.requestAnimationFrame(() => {
    // ⚠️ THE VISIBLE ONE. The macro panel is always in the DOM and comes
    // FIRST in document order, so a bare `.nd` sent every other dialog's
    // focus into a display:none node — and then trapped Tab there, leaving
    // the create dialog's own controls keyboard-unreachable.
    learnRoot?.querySelector<HTMLElement>(".nd-back:not(.none) .nd")?.focus();
  });
}

function restoreDialogFocus(): void {
  const back = dialogReturnFocus;
  dialogReturnFocus = null;
  if (
    back?.isConnected &&
    !back.closest("[hidden]") &&
    back.getClientRects().length > 0
  ) {
    back.focus();
    if (document.activeElement === back) return;
  }
  const macroId = back?.dataset.flowMacroId;
  const direct = macroId
    ? learnRoot?.querySelector<HTMLAnchorElement>(
      `#n-mapping-processors a.n-flow-processor:not([hidden])[data-flow-macro-id="${CSS.escape(macroId)}"]`,
    )
    : null;
  if (direct) {
    direct.focus();
    return;
  }
  const grouped = macroId
    ? learnRoot?.querySelector<HTMLAnchorElement>(
      `#n-mapping-processors a.n-flow-overflow-link[data-flow-macro-id="${CSS.escape(macroId)}"]`,
    )
    : null;
  if (grouped) {
    grouped.closest<HTMLDetailsElement>("details")?.setAttribute("open", "");
    grouped.focus();
    return;
  }
  learnRoot?.querySelector<HTMLSelectElement>('[data-nx="mapping-paths"]')?.focus();
}

function trapDialogTab(ev: KeyboardEvent): void {
  const dlg = learnRoot?.querySelector<HTMLElement>(".nd-back:not(.none) .nd");
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
  loadDs4Variants();
  loadControllerFinishes();
  loadKeyboardWorkbenchPrefs();
  loadControlSurfacePrefs();
  applyNocturneUi();
  refreshInspectorCopy();
  // The wire's own "JavaScript is live" marker: scripting-only chrome (the
  // auto-map button) reveals off it, and the parity gate normalizes it.
  root.classList.add("js");
  applySlotColors();
  syncBoardFilter();
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
  // THE MACRO EDITOR. Every control is one act, applied by the server and
  // answered with the whole roll — so the browser never has to know what a
  // diagonal is, only how to draw the answer.
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const cell = target.closest<HTMLElement>("[data-maccell]");
    if (cell) {
      ev.preventDefault();
      void macAct(`cell|${cell.dataset.maccell}`);
      return;
    }
    const motion = target.closest<HTMLElement>("[data-macmotion]");
    if (motion) {
      ev.preventDefault();
      void macAct(`motion|${motion.dataset.macmotion}`);
      return;
    }
    const pol = target.closest<HTMLElement>("[data-macpol]");
    if (pol) {
      ev.preventDefault();
      void macAct(`pol|${pol.dataset.macpol}`);
      return;
    }
    const act = target.closest<HTMLElement>("[data-macact]");
    if (!act) return;
    ev.preventDefault();
    const verb = act.dataset.macact ?? "";
    if (verb === "save") {
      void macSave();
      return;
    }
    if (verb === "short") {
      // The flag belongs to a STEP, so it needs one: the row whose duration
      // box was last touched, else the first row that is actually short.
      // The flag belongs to a STEP, so it needs one that the floor would
      // really raise: the row whose duration was last touched IF that row is
      // short, else the first row that is.
      const rows = nMacRows();
      const touched = macShortRow !== null && rows[macShortRow]?.short ? macShortRow : null;
      const row = touched ?? rows.findIndex((r) => r.short);
      if (row < 0) {
        macSay("No step here is shorter than the 33 ms floor \u2014 there is nothing to allow.", "warn");
        return;
      }
      void macAct(`short|${row}`);
      return;
    }
    void macAct(verb);
  });
  // A duration is committed when the author leaves it or presses Enter —
  // never on every keystroke, so typing is never interrupted by a round trip.
  root.addEventListener("change", (ev) => {
    const surfaceLabel = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>(
      '[data-nx="surface-label"][data-surface-control-id]',
    );
    if (surfaceLabel) {
      const controlId = surfaceLabel.dataset.surfaceControlId ?? "";
      const before = controlSurfaceState.controls.find((control) => control.id === controlId);
      const next = renameControlSurfaceControl(controlSurfaceState, controlId, surfaceLabel.value);
      const after = next.controls.find((control) => control.id === controlId);
      if (before && after) {
        const blank = !surfaceLabel.value.trim();
        if (blank) surfaceLabel.value = after.label;
        applyControlSurfaceState(next, true);
        keyboardWorkbenchAnnounce(
          blank
            ? "A physical component needs a name; the previous name was kept."
            : before.label === after.label
            ? `${after.label} kept its name.`
            : `${before.label} renamed to ${after.label}.`,
        );
      }
      return;
    }
    const paths = (ev.target as HTMLElement | null)?.closest<HTMLSelectElement>(
      '[data-nx="mapping-paths"]',
    );
    if (paths && mappingPathModeIsValid(paths.value)) {
      setMappingPathMode(paths.value);
      return;
    }
    const box = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>("[data-macdur]");
    if (box) {
      macShortRow = Number(box.dataset.macdur);
      void macAct(`dur|${box.dataset.macdur}|${box.value}`);
      return;
    }
    const rate = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>("[data-macrate]");
    if (rate) void macAct(`rate|${rate.value}`);
  });
  root.addEventListener("keydown", (ev) => {
    const surfaceControl = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      ".n-surface-control[data-surface-control-id]",
    );
    if (surfaceControl) {
      const controlId = surfaceControl.dataset.surfaceControlId ?? "";
      const key = (ev as KeyboardEvent).key;
      if ((key === "Delete" || key === "Backspace") && controlId) {
        ev.preventDefault();
        selectControlSurfaceChannel(controlId);
        removeSelectedControlSurfaceControl();
        controlSurfaceItem?.querySelector<HTMLElement>(".n-surface-control")
          ?.focus({ preventScroll: true });
        return;
      }
      const step = (ev as KeyboardEvent).shiftKey ? 12 : 4;
      const dx = key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
      const dy = key === "ArrowDown" ? step : key === "ArrowUp" ? -step : 0;
      if ((dx !== 0 || dy !== 0) && controlId) {
        ev.preventDefault();
        selectControlSurfaceChannel(controlId);
        nudgeControlSurfaceControl(controlId, dx, dy);
        window.requestAnimationFrame(() => {
          controlSurfaceItem
            ?.querySelector<HTMLElement>(
              `.n-surface-control[data-surface-control-id="${CSS.escape(controlId)}"]`,
            )
            ?.focus({ preventScroll: true });
        });
        return;
      }
    }
    const deckKey = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".n-deck-key");
    if (deckKey) {
      const keyName = deckKey.dataset.keylabKey ?? "";
      const token = deckKey.dataset.keylabToken ?? "";
      const key = (ev as KeyboardEvent).key;
      if ((key === "Delete" || key === "Backspace") && keyName) {
        ev.preventDefault();
        toggleKeyboardWorkbenchKey(keyName, false);
        return;
      }
      const step = (ev as KeyboardEvent).shiftKey ? 12 : 4;
      const dx = key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
      const dy = key === "ArrowDown" ? step : key === "ArrowUp" ? -step : 0;
      if ((dx !== 0 || dy !== 0) && keyName && token) {
        ev.preventDefault();
        nudgeKeyboardWorkbenchKey(keyName, token, dx, dy);
        window.requestAnimationFrame(() => {
          keyboardWorkbenchItem
            ?.querySelector<HTMLElement>(
              `.n-deck-key[data-keylab-token="${CSS.escape(token)}"]`,
            )
            ?.focus({ preventScroll: true });
        });
        return;
      }
    }
    const sourceCap = (ev.target as HTMLElement | null)?.closest<HTMLElement>(
      ".n-widget-kb [data-key]",
    );
    if (sourceCap && keyboardWorkbenchState.open &&
        !sourceCap.classList.contains("n-ipac-signal")) {
      const keyName = sourceCap.getAttribute("data-key") ?? "";
      const key = (ev as KeyboardEvent).key;
      if ((key === "Enter" || key === " ") && keyName) {
        ev.preventDefault();
        toggleKeyboardWorkbenchKey(keyName);
        sourceCap.tabIndex = 0;
        sourceCap.focus({ preventScroll: true });
        return;
      }
      if (key.startsWith("Arrow")) {
        const rows = Array.from(
          root.querySelectorAll<HTMLElement>(".n-widget-kb .n-kbrow, .n-widget-kb .n-kbtray-row"),
        );
        const row = sourceCap.closest<HTMLElement>(".n-kbrow, .n-kbtray-row");
        const rowIndex = row ? rows.indexOf(row) : -1;
        const members = row
          ? Array.from(row.querySelectorAll<HTMLElement>("[data-key]:not(.ghost)"))
          : [];
        const memberIndex = members.indexOf(sourceCap);
        let next: HTMLElement | undefined;
        if (key === "ArrowLeft" || key === "ArrowRight") {
          next = members[Math.min(
            Math.max(memberIndex + (key === "ArrowRight" ? 1 : -1), 0),
            members.length - 1,
          )];
        } else if (rowIndex >= 0) {
          const nextRow = rows[Math.min(
            Math.max(rowIndex + (key === "ArrowDown" ? 1 : -1), 0),
            rows.length - 1,
          )];
          const nextMembers = Array.from(
            nextRow?.querySelectorAll<HTMLElement>("[data-key]:not(.ghost)") ?? [],
          );
          next = nextMembers[Math.min(Math.max(memberIndex, 0), nextMembers.length - 1)];
        }
        if (next && next !== sourceCap) {
          ev.preventDefault();
          sourceCap.tabIndex = -1;
          next.tabIndex = 0;
          next.focus({ preventScroll: true });
        }
        return;
      }
    }
    const box = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>("[data-macdur]");
    if (box && (ev as KeyboardEvent).key === "Enter") {
      ev.preventDefault();
      box.blur();
      return;
    }
    // THE MATRIX IS A GRID, not a tab sequence. One cell is in the tab order
    // and the arrows walk the rest — 37 columns times N steps is not
    // something anyone can Tab through, and the cells are useless to a
    // keyboard user without a way in.
    const cell = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-maccell]");
    if (!cell) return;
    const key = (ev as KeyboardEvent).key;
    const dx = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
    const dy = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
    if (dx === 0 && dy === 0) return;
    ev.preventDefault();
    const all = Array.from(root.querySelectorAll<HTMLElement>("[data-maccell]"));
    const at = all.indexOf(cell);
    if (at < 0) return;
    const cols = nMacCols().length || 1;
    const row = Math.floor(at / cols);
    const col = at % cols;
    const rows = Math.ceil(all.length / cols);
    const want =
      Math.min(Math.max(row + dy, 0), rows - 1) * cols + Math.min(Math.max(col + dx, 0), cols - 1);
    const next = all[want];
    if (!next || next === cell) return;
    cell.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
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
      // A color picker opening gets the current availability truth.
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
    if (inputTestDialog?.open && ev.key === "Escape") {
      ev.preventDefault();
      closeOpenDialog();
      return;
    }
    if (
      (ev.ctrlKey || ev.metaKey) &&
      ev.key.toLowerCase() === "k" &&
      !anyDialogOpen() &&
      !learnRow &&
      !assignKey
    ) {
      ev.preventDefault();
      ui.rightRail = false;
      saveUiPrefs();
      clearInspectorContext(true);
      window.requestAnimationFrame(() => {
        const input = root.querySelector<HTMLInputElement>(".n-filter-in");
        input?.focus();
        input?.select();
      });
      return;
    }
    if (assignKey && ev.key === "Escape") {
      ev.preventDefault();
      cancelAssign();
      return;
    }
    if (!anyDialogOpen()) {
      if (ev.key === "Escape" && inspectorContext.kind !== "overview") {
        ev.preventDefault();
        clearInspectorContext();
        return;
      }
      // LAST in the Escape order, after an armed assignment and any open
      // dialog have had their say: focus mode is a whole-canvas state, so
      // leaving it must not depend on which control the user last touched.
      // (The engine binds Escape on the widget shell alone — reachable only
      // when the widget itself holds focus, which it does not after a
      // button press.)
      if (ev.key === "Escape" && nCanvas?.isFocusModeActive()) {
        ev.preventDefault();
        nCanvas.exitFocusMode();
        syncWidgetSelection();
      }
      return;
    }
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
    if (
      form instanceof HTMLFormElement &&
      form.getAttribute("action") === "/nocturne/controller/remove"
    ) {
      // A crossing dies with the controller it was made for. Dropping it
      // HERE, at the removal itself, is what saves the case a later look
      // at the roster cannot: remove a crossed-out controller and add
      // another inside one poll, and the newcomer would otherwise inherit
      // the recycled preset name — and arrive hidden.
      const number = form.querySelector<HTMLInputElement>('input[name="number"]')?.value ?? "";
      const preset = presetOfSlot(Number(number));
      if (preset !== undefined && hiddenStrips.delete(preset)) saveHiddenStrips();
    }
  });
  root.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.classList.contains("n-filter-in")) {
      if (inspectorContext.kind !== "overview") clearInspectorContext(true);
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
    // An open color picker closes on any click outside itself.
    for (const pick of Array.from(root.querySelectorAll<HTMLElement>(".n-cpick[open]"))) {
      if (target && !pick.contains(target)) pick.removeAttribute("open");
    }
    // Slot selection: enhance the server-resolved ?slot=N link into an
    // in-place URL swap + immediate poll — no full reload, same truth.
    // The macro dialog's own doors: enhanced so unsaved work gets a word
    // before it is dropped, and so closing is a URL swap rather than a load.
    const macDoor = target?.closest<HTMLAnchorElement>(".n-macx, .n-macfoot a");
    if (macDoor) {
      ev.preventDefault();
      closeMacroDialog();
      return;
    }
    const processorDoor = target?.closest<HTMLAnchorElement>(
      "a.n-flow-processor, a.n-flow-overflow-link",
    );
    if (processorDoor) {
      if (
        ev instanceof MouseEvent &&
        (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey)
      ) {
        return;
      }
      const url = new URL(processorDoor.href, window.location.origin);
      const slot = url.searchParams.get("slot");
      const macro = url.searchParams.get("macro");
      if (!slot || !macro) return;
      ev.preventDefault();
      // The href remains the no-JS door. Hydrated canvases keep their camera
      // and workbench state, then focus the reconciled modal once the poll has
      // supplied the selected macro's existing editor projection.
      processorDoor.focus();
      dialogReturnFocus = processorDoor;
      mergeQuery({ slot, macro });
      restoreMacroFocusOnNextPayload = false;
      focusMacroOnNextPayload = { slot, macro };
      nocturnePollFn();
      return;
    }
    const sel = target?.closest<HTMLAnchorElement>("a.n-slot-sel");
    if (sel) {
      ev.preventDefault();
      // MERGE the slot into the current query rather than replacing the
      // whole URL — the filter's ?q= must survive a selection change.
      const chosen = new URL(sel.href, window.location.origin).searchParams.get("slot");
      // The walk was built for one slot's controls: changing slots ends it.
      autoMap = null;
      // ⚠️ A MACRO BELONGS TO ONE CONTROLLER. Carrying `?macro=` across a
      // seat change left the dialog showing the OLD seat's draft over the new
      // seat's page — and, because a dirty draft blocks the repaint, the two
      // disagreed silently. The editor closes with the controller it was for,
      // and says so when that costs unsaved work.
      if (macroDialogOpen()) {
        if (macDirty && macDraft && !macCloseArmed) {
          macSay(
            `“${macDraft.name}” belongs to this controller and has unsaved changes. Save it, ` +
              "or press the seat again to leave them behind.",
            "warn",
          );
          macCloseArmed = true;
          return;
        }
        macDraft = null;
        macDirty = false;
        macCloseArmed = false;
        macDirtyMark();
      }
      clearInspectorContext(true);
      mergeQuery({ slot: chosen, macro: null });
      nocturnePollFn();
      return;
    }
    // Stage art → binding row: every control on the silhouette already
    // carries its mapper function(s) in data-fn (the live-echo hooks), so a
    // click jumps the right pane to that row. A POINTER ENHANCEMENT only —
    // the rows themselves stay the accessible, no-JS path.
    const zone = target?.closest<Element>(".n-canvas [data-fn]");
    if (zone) {
      closeMenu();
      const fnName = (zone.getAttribute("data-fn") ?? "").split(/\s+/)[0] ?? "";
      // The clone grid stamps each pad with its slot; the master speaks
      // for the selected one. The pad's own served tables carry the
      // CANONICAL fn spelling and the readable label for ANY slot.
      const padSlot =
        zone.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot") ?? nSlotVal();
      const padView = lastBindView?.pads.find((candidate) => String(candidate.slot) === padSlot);
      const padControl = controlForPad(lastBindView, padSlot, fnName);
      const padCanonical = padControl?.function;
      const padLabel = padControl?.label;
      if (padView?.mapping_available === false) {
        applyFlash(
          `error: ${padView.mapping_reason || `Player ${padSlot}'s controls are not available yet.`}`,
        );
        return;
      }
      if (learnRow) {
        autoMap = null;
        void cancelLearn();
      }
      setInspectorContext({
        kind: "control",
        slot: padSlot,
        preset: padView?.preset ?? "",
        functionName: padCanonical ?? fnName,
      });
      if (assignKey && fnName) {
        // The pad IS the picker: give the chosen control this key.
        const held = assignKey;
        const mode = assignMode;
        const sourcePin = assignSourcePin;
        const chain = ev.shiftKey || chainWanted();
        cancelAssign();
        // Canonical spelling and persona label belong to the backend-owned
        // endpoint projection. The right-pane row is no longer an implicit
        // data store, so removing that presentation cannot corrupt a write.
        const selectedControl =
          padControl ?? controlForPad(lastBindView, nSlotVal(), fnName);
        const canonical = padCanonical ?? selectedControl?.function ?? fnName;
        lastWrite = { origin: "assign", chain, assignMode: mode };
        const label = padLabel || selectedControl?.label || fnName;
        void writeLearnedKey({
          fn: canonical,
          label,
          slot: padSlot,
          mode,
          ...(sourcePin ?? {}),
        }, held, false).then(
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
      // The controls view follows the selected endpoint. The Inspector's
      // action starts capture when the pane is open.
      const rowEl =
        padSlot === nSlotVal()
          ? Array.from(
              root.querySelectorAll<HTMLElement>("details.n-bind[data-fn], .n-ctlchip[data-fn]"),
            ).find((el) => (el.getAttribute("data-fn") ?? "").toLowerCase() === fnName)
          : undefined;
      const rowFn =
        padCanonical ?? controlForPad(lastBindView, nSlotVal(), fnName)?.function ?? fnName;
      const rowLabel =
        padLabel ||
        controlForPad(lastBindView, nSlotVal(), fnName)?.label ||
        fnName;
      if (ui.rightView !== "controls") {
        ui.rightView = "controls";
        saveUiPrefs();
        applyNocturneUi();
      }
      // An open Inspector selects without editing and reveals the full row.
      if (!ui.rightRail && root.querySelector(".n-right")) {
        rowEl?.scrollIntoView({
          block: "nearest",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        return;
      }
      // With the Inspector collapsed, keep the original fast canvas flow:
      // selecting a control immediately waits for its source key.
      autoMap = null;
      void startLearn({ fn: rowFn, label: rowLabel, slot: padSlot, mode: "replace" });
      return;
    }
    const physicalControl = target?.closest<HTMLElement>(
      ".n-surface-control[data-surface-control-id]",
    );
    if (physicalControl) {
      ev.preventDefault();
      const controlId = physicalControl.dataset.surfaceControlId ?? "";
      const channel = target?.closest<HTMLElement>(
        ".n-surface-signal-chain[data-surface-channel-id]",
      )?.dataset.surfaceChannelId ?? "";
      if (controlId) selectControlSurfaceChannel(controlId, channel);
      if (assignKey) cancelAssign();
      return;
    }
    // A loose token selects itself for arrow nudges / Return. It carries the
    // same data-key for live paint, but it is not a second mapper surface.
    const workbenchKey = target?.closest<HTMLElement>(".n-deck-key[data-keylab-key]");
    if (workbenchKey) {
      ev.preventDefault();
      const key = workbenchKey.dataset.keylabKey ?? "";
      keyboardWorkbenchSetSelected(
        key,
        workbenchKey.dataset.keylabToken ?? "",
      );
      if (key) setInspectorContext({ kind: "key", key });
      if (key && resolveLearnWithKey(key, ev.shiftKey || chainWanted())) return;
      if (assignKey) cancelAssign();
      return;
    }
    // A board cap flips the pane to the BY-KEY view and finds its row —
    // the same gesture as clicking the pad, read from the other side.
    const cap = target?.closest<HTMLElement>(".n-widget-kb [data-key]");
    if (cap) {
      closeMenu();
      const key = cap.getAttribute("data-key") ?? "";
      if (key) setInspectorContext({ kind: "key", key });
      if (key && resolveLearnWithKey(key, ev.shiftKey || chainWanted())) return;
      if (assignKey) cancelAssign();
      if (keyboardWorkbenchState.open && key && !cap.classList.contains("ghost") &&
          !cap.classList.contains("n-ipac-signal")) {
        ev.preventDefault();
        toggleKeyboardWorkbenchKey(key);
        cap.tabIndex = 0;
        cap.focus({ preventScroll: true });
        return;
      }
      // With the pane rolled away, a cap click goes straight to mapping:
      // the pad picks the control (plain click replaces its binding) —
      // the pane stays closed and its rail glows instead.
      if (ui.rightRail || !root.querySelector(".n-right")) {
        if (key && !autoMap) armAssign(key);
        return;
      }
      ui.rightView = "keys";
      saveUiPrefs();
      applyNocturneUi();
      locateKeyRow(root, key);
      // Selection is non-destructive while the Inspector is open. Its
      // primary action starts mapping; a collapsed pane keeps the quick
      // key-then-control canvas gesture above.
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
    if (hit === "mac-close") {
      closeMacroDialog();
    } else if (hit === "slot-new") {
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
    } else if (hit === "filter-reset") {
      const inp = root.querySelector<HTMLInputElement>(".n-filter-in");
      if (inp) inp.value = "";
      applyNocturneFilter(root, "");
      mergeQuery({ q: null });
    } else if (hit === "inspector-browse") {
      clearInspectorContext();
      window.requestAnimationFrame(() => {
        root.querySelector<HTMLButtonElement>(
          `[data-nx="${ui.rightView === "keys" ? "view-keys" : "view-ctl"}"]`,
        )?.focus({ preventScroll: true });
      });
    } else if (hit === "inspector-action") {
      if (inspectorContext.kind === "overview") {
        const input = learnRoot?.querySelector<HTMLInputElement>(".n-filter-in");
        input?.focus();
        input?.select();
      } else if (inspectorContext.kind === "key") {
        armAssign(inspectorContext.key, "add");
      } else {
        const pad = lastBindView?.pads.find(
          (candidate) => String(candidate.slot) === inspectorContext.slot,
        );
        if (pad?.mapping_available === false) {
          applyFlash(
            `error: ${pad.mapping_reason || `Player ${inspectorContext.slot}'s controls are not available yet.`}`,
          );
          return;
        }
        const control = controlForPad(
          lastBindView,
          inspectorContext.slot,
          inspectorContext.functionName,
        );
        void startLearn({
          fn: control?.function ?? inspectorContext.functionName,
          label: control?.label ?? inspectorContext.functionName,
          slot: inspectorContext.slot,
          mode: (control?.keys.length ?? 0) > 0 ? "add" : "replace",
        });
      }
    } else if (hit === "chip-learn" || hit === "chip-add" || hit === "chip-remove") {
      // The row's own facts travel on its element, never re-derived here.
      // The chip click must not also toggle the fold it sits in.
      ev.preventDefault();
      const holder = target?.closest<HTMLElement>("[data-fn]");
      const fnName = holder?.dataset.fn ?? "";
      const slot = holder?.dataset.slot ?? "";
      const label = holder?.querySelector(".n-bind-label")?.textContent?.trim() || fnName;
      if (fnName && slot) {
        if (!fnName.startsWith("macro.")) {
          setInspectorContext({
            kind: "control",
            slot,
            preset: lastBindView?.pads.find((pad) => String(pad.slot) === slot)?.preset ?? "",
            functionName: fnName,
          });
        }
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
    } else if (hit === "canvas-fit") {
      nCanvas?.fitAll();
    } else if (hit === "canvas-zoom-reset") {
      nCanvas?.resetZoom();
    } else if (hit === "canvas-zoom-in") {
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-zoom-out") {
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-tidy") {
      arrangeCanvas();
    } else if (hit === "canvas-map") {
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (
      hit === "w-zoom-in" || hit === "w-zoom-out" || hit === "w-scale-reset" ||
      hit === "w-center" || hit === "w-focus"
    ) {
      // The selection group: the button says WHAT, the canvas says WHICH.
      const widget = nCanvas?.activeItem();
      if (widget && nCanvas) {
        if (hit === "w-zoom-in") nCanvas.adjustItemScale(widget, 1);
        else if (hit === "w-zoom-out") nCanvas.adjustItemScale(widget, -1);
        else if (hit === "w-scale-reset") nCanvas.resetItemScale(widget);
        else if (hit === "w-center") nCanvas.centerItem(widget);
        else nCanvas.toggleFocusMode(widget);
        syncWidgetSelection();
      }
    } else if (hit === "kb-colors") {
      const leaving = ui.kbSolo;
      ui.kbSolo = !ui.kbSolo;
      saveUiPrefs();
      applyNocturneUi();
      syncBoardFilter();
      // Closing the lens hands back the crossings YOU set — the solo
      // convention every editor keeps. It is silent by nature, so the
      // chips that came back say so once.
      if (leaving) flashRestoredChips();
    } else if (hit === "kb-theme") {
      const theme = target?.closest<HTMLElement>("[data-keyboard-theme]")
        ?.dataset.keyboardTheme ?? "";
      chooseKeyboardTheme(theme);
    } else if (hit === "surface-open") {
      openControlSurfaceBuilder();
    } else if (hit === "surface-close") {
      closeControlSurfaceBuilder();
    } else if (hit === "input-test-open") {
      openInputTest();
    } else if (hit === "surface-template") {
      const template = target?.closest<HTMLElement>("[data-surface-template]")
        ?.dataset.surfaceTemplate as ControlSurfaceTemplate | undefined;
      if (template) chooseControlSurfaceTemplate(template);
    } else if (hit === "surface-template-cancel") {
      controlSurfaceChoosingTemplate = false;
      controlSurfacePendingTemplate = null;
      syncControlSurfaceChrome();
      keyboardWorkbenchAnnounce("The current control surface was kept unchanged.");
      focusControlSurfacePrimary();
    } else if (hit === "surface-new") {
      controlSurfaceChoosingTemplate = true;
      controlSurfacePendingTemplate = null;
      syncControlSurfaceChrome();
      controlSurfaceItem
        ?.querySelector<HTMLButtonElement>("[data-surface-template]")
          ?.focus({ preventScroll: true });
    } else if (hit === "surface-undo") {
      undoControlSurfaceDestructiveEdit();
    } else if (hit === "surface-stage") {
      const stage = target?.closest<HTMLElement>("[data-surface-stage]")
        ?.dataset.surfaceStage as ControlSurfaceStage | undefined;
      if (stage) chooseControlSurfaceStage(stage);
    } else if (hit === "surface-add") {
      const kind = target?.closest<HTMLElement>("[data-control-kind]")
        ?.dataset.controlKind as ControlSurfaceControlKind | undefined;
      if (kind) addPhysicalControl(kind);
    } else if (hit === "surface-channel") {
      const button = target?.closest<HTMLElement>("[data-surface-channel-id]");
      const controlId = button?.dataset.surfaceControlId ?? "";
      const channelId = button?.dataset.surfaceChannelId ?? "";
      if (controlId && channelId) selectControlSurfaceChannel(controlId, channelId);
    } else if (hit === "surface-owner") {
      const button = target?.closest<HTMLElement>("[data-player-slot][data-surface-control-id]");
      const controlId = button?.dataset.surfaceControlId ?? "";
      const value = Number(button?.dataset.playerSlot ?? "0");
      if (controlId && Number.isInteger(value) && value >= 0 && value <= 4) {
        applyControlSurfaceState(
          setControlSurfacePlayerSlot(controlSurfaceState, controlId, value === 0 ? null : value),
          true,
        );
        keyboardWorkbenchAnnounce(
          value === 0 ? "Component shown panel-wide without a player owner." : `Component assigned to the Player ${value} panel view.`,
        );
      }
    } else if (hit === "surface-nudge") {
      const button = target?.closest<HTMLButtonElement>(
        '[data-surface-control-id][data-surface-dx][data-surface-dy]',
      );
      const controlId = button?.dataset.surfaceControlId ?? "";
      const channelId = button?.dataset.surfaceChannelId ?? "";
      const dx = Number(button?.dataset.surfaceDx ?? "0");
      const dy = Number(button?.dataset.surfaceDy ?? "0");
      if (controlId && Number.isFinite(dx) && Number.isFinite(dy)) {
        selectControlSurfaceChannel(controlId, channelId);
        nudgeControlSurfaceControl(controlId, dx, dy);
        keyboardWorkbenchAnnounce(
          `${selectedControlSurfaceControl()?.label ?? "Physical control"} moved without dragging.`,
        );
      }
    } else if (hit === "surface-teach") {
      startControlSurfaceTeach();
    } else if (hit === "surface-route") {
      routeSelectedControlSurfaceChannel();
    } else if (hit === "surface-mirror") {
      copySelectedControlSurfaceControl("mirror");
    } else if (hit === "surface-duplicate") {
      copySelectedControlSurfaceControl("duplicate");
    } else if (hit === "surface-resolve-mirror") {
      resolveSelectedControlSurfaceSignal("mirror");
    } else if (hit === "surface-resolve-duplicate") {
      resolveSelectedControlSurfaceSignal("duplicate");
    } else if (hit === "surface-remove") {
      removeSelectedControlSurfaceControl();
    } else if (hit === "kb-workbench") {
      const opening = !keyboardWorkbenchState.open;
      if (opening) {
        // Pull mode and learn mode both claim the next key. Entering the
        // workshop makes that choice explicit and ends any half-finished map.
        autoMap = null;
        void cancelLearn();
        cancelAssign();
      }
      applyKeyboardWorkbenchState(
        {
          ...keyboardWorkbenchState,
          open: opening,
          sourceHidden: opening ? keyboardWorkbenchState.sourceHidden : false,
        },
        true,
        true,
      );
      keyboardWorkbenchAnnounce(
        keyboardWorkbenchState.open
          ? "Keyboard Arranger opened. Choose real caps on the keyboard to move them."
          : "Keyboard Arranger closed. Its layout is saved.",
      );
    } else if (hit === "keylab-pull-mapped") {
      pullMappedKeyboardWorkbenchKeys();
    } else if (hit === "keylab-layout-compact") {
      repackKeyboardWorkbench();
    } else if (hit === "keylab-nudge") {
      const button = target?.closest<HTMLButtonElement>(
        '[data-keylab-dx][data-keylab-dy]',
      );
      const dx = Number(button?.dataset.keylabDx ?? "0");
      const dy = Number(button?.dataset.keylabDy ?? "0");
      if (
        keyboardWorkbenchSelectedKey && keyboardWorkbenchSelectedToken &&
        Number.isFinite(dx) && Number.isFinite(dy)
      ) {
        nudgeKeyboardWorkbenchKey(
          keyboardWorkbenchSelectedKey,
          keyboardWorkbenchSelectedToken,
          dx,
          dy,
        );
        keyboardWorkbenchAnnounce(
          `${keyboardWorkbenchSelectedKey} moved without dragging.`,
        );
      }
    } else if (hit === "keylab-cap-profile") {
      setKeyboardWorkbenchCapProfile(
        target?.closest<HTMLElement>("[data-keycap-profile]")?.dataset.keycapProfile ?? "",
      );
    } else if (hit === "keylab-source-toggle") {
      setKeyboardSourceHidden(!keyboardWorkbenchState.sourceHidden);
    } else if (hit === "keylab-source-show") {
      setKeyboardSourceHidden(false);
    } else if (hit === "keylab-return") {
      returnSelectedKeyboardWorkbenchKey();
    } else if (hit === "keylab-clear") {
      clearKeyboardWorkbenchKeys();
    } else if (hit === "legend-mute") {
      // One chip, one player's color on the keys. Keyed by PRESET like
      // the colors themselves, so muting follows a controller through a
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
              void startLearn(reopenBindingTarget(pend.row, "add"));
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
        clearInspectorContext();
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
        setInspectorContext({
          kind: "control",
          slot: nSlotVal(),
          preset: lastBindView?.pads.find(
            (pad) => String(pad.slot) === nSlotVal(),
          )?.preset ?? "",
          functionName: fnName,
        });
        void startLearn({ fn: fnName, label, slot: nSlotVal(), mode: "replace" });
      }
    } else if (hit === "view-ctl" || hit === "view-keys") {
      clearInspectorContext();
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
        // A color another controller wears is UNAVAILABLE, never stolen:
        // the swatch is disabled, and this guard backs the styling up. It
        // frees the moment its owner moves off it.
        const assigned = colorAssignments();
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
      if (key) setInspectorContext({ kind: "key", key });
      if (key) armAssign(key, "remove");
    } else if (hit === "key-assign") {
      const key = target?.closest<HTMLElement>("[data-key]")?.getAttribute("data-key") ?? "";
      // The row's + means ADD (the key keeps its other controls); a free
      // chip is a plain bind.
      const mode: "replace" | "add" = target?.closest(".n-krow") ? "add" : "replace";
      if (key) setInspectorContext({ kind: "key", key });
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
    if (hit === "slot-new" || hit === "dlg-close" || hit === "mac-close" || hit === "pane-left" || hit === "pane-right" || hit === "filter-reset") {
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
      h(
        "span",
        {
          class: () => nEnvironmentCls(),
          title: () => nEnvironmentDetail(),
          role: "note",
          "aria-describedby": "n-environment-detail",
          "data-runtime-environment": () => nEnvironmentId(),
        },
        h("span", { class: "n-environment-dot", "aria-hidden": "true" }),
        () => nEnvironmentLabel(),
      ),
      h(
        "span",
        { id: "n-environment-detail", class: "n-sr-description" },
        () => nEnvironmentDetail(),
      ),
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
          h("span", { class: "n-kick" }, "Input hardware"),
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-left" }, "‹"),
        ),
        h(
          "div",
          { class: "n-kick-row n-encoder-kick" },
          h("span", { class: "n-kick" }, () => nEncoderHead()),
          h("span", { class: "n-kick-n" }, () => nEncoderCount()),
        ),
        createList(
          () => nDevEncoders(),
          (r) => r.selector + "|" + r.alias + "|" + r.label + "|" + r.cls + "|" + r.name + "|" + r.meta + "|" + r.role,
          (r) =>
            h(
              "form",
              { class: "n-devform n-encoder-form", method: "post", action: "/nocturne/device" },
              h("input", { type: "hidden", name: "selector", value: r.selector }),
              h("input", { type: "hidden", name: "alias", value: r.alias }),
              h("input", { type: "hidden", name: "label", value: r.label }),
              h(
                "button",
                { type: "submit", class: r.cls },
                h("span", { class: "n-dev-ico" }, "▦"),
                h(
                  "span",
                  { class: "n-dev-txt" },
                  h("span", { class: "n-dev-name" }, r.name),
                  h("span", { class: "n-dev-meta" }, r.meta),
                ),
                h("span", { class: "n-dev-dot" }),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "n-encoder-setup",
                  "data-nx": "encoder-select-setup",
                  title: "Open this exact encoder's hardware outputs; KSX inspects proven capabilities before offering reads or writes",
                  "data-encoder-selector": r.selector,
                },
                "Open outputs",
                h("span", { class: "n-encoder-accessible-name" }, " ", r.name),
              ),
            ),
        ),
        h(
          "div",
          { class: "n-kick-row n-keyboard-kick" },
          h("span", { class: "n-kick" }, "Keyboards"),
          h("span", { class: "n-kick-n" }, () => nDevCount()),
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
        h(
          "div",
          { class: "n-kick-row" },
          h(
            "span",
            { class: "n-kick" },
            "Input capture behavior",
          ),
        ),
        h(
          "p",
          { class: "n-devnote" },
          () => nModeNote(),
        ),
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
          h("span", { class: "n-kick" }, "How the Studio looks"),
        ),
        h(
          "p",
          { class: "n-devnote" },
          "Pages follow the operating system's light or dark choice unless you pick one here.",
        ),
        createList(
          () => nThemeRows(),
          (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls,
          (r) =>
            h(
              "form",
              { class: "n-modeform", method: "post", action: "/nocturne/theme" },
              h("input", { type: "hidden", name: "theme", value: r.name }),
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
              // text are ONE selection link. The badge wears the color;
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
                  // The color picker, as a verb: presentation state, kept
                  // in this browser, keyed to the controller's identity.
                  h(
                    "details",
                    { class: "n-cpick", "data-slot": r.number },
                    h(
                      "summary",
                      {
                        title: "Pick this controller's color",
                        "aria-label": "Pick this controller's color",
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
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "1", title: "Color 1", "aria-label": "Color 1 for this controller", class: "n-swatch pal1" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "2", title: "Color 2", "aria-label": "Color 2 for this controller", class: "n-swatch pal2" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "3", title: "Color 3", "aria-label": "Color 3 for this controller", class: "n-swatch pal3" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "4", title: "Color 4", "aria-label": "Color 4 for this controller", class: "n-swatch pal4" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "5", title: "Color 5", "aria-label": "Color 5 for this controller", class: "n-swatch pal5" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "6", title: "Color 6", "aria-label": "Color 6 for this controller", class: "n-swatch pal6" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "7", title: "Color 7", "aria-label": "Color 7 for this controller", class: "n-swatch pal7" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "8", title: "Color 8", "aria-label": "Color 8 for this controller", class: "n-swatch pal8" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "9", title: "Color 9", "aria-label": "Color 9 for this controller", class: "n-swatch pal9" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "10", title: "Color 10", "aria-label": "Color 10 for this controller", class: "n-swatch pal10" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "11", title: "Color 11", "aria-label": "Color 11 for this controller", class: "n-swatch pal11" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "12", title: "Color 12", "aria-label": "Color 12 for this controller", class: "n-swatch pal12" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "13", title: "Color 13", "aria-label": "Color 13 for this controller", class: "n-swatch pal13" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "14", title: "Color 14", "aria-label": "Color 14 for this controller", class: "n-swatch pal14" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "15", title: "Color 15", "aria-label": "Color 15 for this controller", class: "n-swatch pal15" }),
                        h("button", { type: "button", "data-nx": "slot-color", "data-color": "16", title: "Color 16", "aria-label": "Color 16 for this controller", class: "n-swatch pal16" }),
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
              class: "n-kbbuild n-input-test-open",
              "data-nx": "input-test-open",
              title:
                "Measure simultaneous signals from this exact keyboard without changing mappings",
            },
            "Test inputs…",
          ),
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
          h(
            "button",
            {
              type: "button",
              "data-nx": "surface-open",
              title: "Build an I-PAC panel, leverless controller, arcade cabinet, or custom physical control surface",
              class: "n-autobtn n-surface-open",
            },
            "Build surface",
          ),
          // The canvas camera's verbs, scripting-only like Map all — wheel,
          // Space-drag and the arrow keys carry the same moves for anyone
          // who would rather not aim at a button.
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-tidy",
              title: "Arrange every widget: the board on top, the controllers in seat order below",
              class: "n-autobtn",
            },
            "Tidy up",
          ),
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-fit",
              title: "Fit every widget on screen",
              class: "n-autobtn",
            },
            "Fit",
          ),
          h(
            "div",
            {
              class: "n-pathctl",
              title:
                "Show physical keys, processing steps, and the virtual controller controls they reach",
            },
            h("label", { class: "n-pathctl-label", for: "n-mapping-path-scope" }, "Paths"),
            h(
              "select",
              {
                id: "n-mapping-path-scope",
                class: "n-pathsel",
                "data-nx": "mapping-paths",
                "aria-controls": "n-mapping-paths n-mapping-ports n-mapping-processors n-mapping-route-list",
                "aria-describedby": "n-mapping-path-status",
              },
              h("option", { value: "off" }, "Off"),
              h("option", { value: "selected" }, "Selected player"),
              h("option", { value: "all" }, "All players"),
            ),
            h("output", {
              class: "n-pathcount",
              title: "Mapping paths are off",
              "aria-hidden": "true",
              "data-live-chatter": "",
            }),
            h("output", {
              id: "n-mapping-trace",
              class: "n-mapping-trace",
              title: "",
              "data-live-chatter": "",
              "data-client-canvas": "",
              hidden: "",
            }),
            h(
              "span",
              { id: "n-mapping-path-status", class: "n-sr-description" },
              "Mapping paths are off.",
            ),
          ),
          h(
            "details",
            {
              class: "n-flow-route-index",
              "data-client-canvas": "",
              hidden: "",
            },
            h(
              "summary",
              null,
              h("span", null, "Trace list"),
              h("span", { "data-flow-route-index-count": "" }, "0 routes"),
            ),
            h("ol", {
              id: "n-mapping-route-list",
              "aria-label": "Visible keyboard-to-controller routes",
              "data-client-subtree": "",
              hidden: "",
            }),
          ),
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-zoom-out",
              "aria-label": "Zoom out",
              title: "Zoom out",
              class: "n-autobtn n-zbtn",
            },
            "−",
          ),
          // The engine writes the LIVE zoom into the SPAN, not the button,
          // and clicking the button resets to 100%.
          // ⚠️The span on purpose: handed a BUTTON the engine also rewrites
          // its aria-label with the live number, and `data-live-chatter`
          // exempts an element's TEXT, never its attributes — which the
          // parity gate caught the moment this was wired the obvious way.
          // With no aria-label at all, the button's accessible name is its
          // own content ("Canvas zoom 84%") and follows the number for free.
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-zoom-reset",
              title: "Canvas zoom — click for 100%",
              class: "n-autobtn n-zoomread",
            },
            h("span", { class: "sr-head" }, "Canvas zoom "),
            h("span", { class: "n-zoomval", "data-live-chatter": "" }, "100%"),
          ),
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-zoom-in",
              "aria-label": "Zoom in",
              title: "Zoom in",
              class: "n-autobtn n-zbtn",
            },
            "+",
          ),
          // ── The selected widget's own controls ──────────────────────────
          // One group that retargets (the upstream app's shape), not four
          // buttons on every card. Served in its RESTING state — nothing is
          // selected at first paint — and `syncWidgetSelection` writes
          // exactly these strings back when the selection clears, so the
          // parity gate sees no drift with no exemption to hide behind.
          h(
            "div",
            {
              class: "n-selbar",
              role: "group",
              "aria-label": "Selected widget",
              "data-nsel-state": "none",
            },
            h("span", { class: "n-sel-name" }, "Nothing selected"),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-zbtn",
                "data-nx": "w-zoom-out",
                "aria-label": "Make the selected widget smaller",
                title: "Smaller",
                disabled: "",
              },
              "−",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-selsize",
                "data-nx": "w-scale-reset",
                "aria-label": "Widget size",
                title: "Widget size",
                disabled: "",
              },
              "100%",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-zbtn",
                "data-nx": "w-zoom-in",
                "aria-label": "Make the selected widget bigger",
                title: "Bigger",
                disabled: "",
              },
              "+",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn",
                "data-nx": "w-center",
                title: "Bring the selected widget to the middle of the view",
                disabled: "",
              },
              "Center",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn",
                "data-nx": "w-focus",
                "aria-pressed": "false",
                "aria-label": "Focus widget",
                title: "Spotlight it alone — Esc restores the view",
                disabled: "",
              },
              "Focus",
            ),
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
        // ── The pad masters: hidden clone templates ───────────────────────
        // The family-specific inline controller vectors live here ONCE,
        // invisible: every controller widget on the canvas deep-clones its
        // family's master — the pad grid's own economy, kept. Provenance
        // differs by family and is recorded in art/README.md + NOTICE.
        // Every hook still carries its canonical mapper function as data-fn,
        // so delegated handlers and live echo light every clone.
        // The paint servers both silhouettes draw with: one zero-size SVG
        // whose defs resolve document-wide, so the CSS can fill shells,
        // wells, sticks and buttons with real gradients instead of flats.
        // Hoisted OUTSIDE the display:none masters on purpose: non-Chromium
        // engines refuse gradient url() references into a display:none
        // subtree, and the visible widget clones resolve against THESE defs.
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
              h(
                "linearGradient",
                { id: "nxg-ds4-dpad-cap", x1: "0", y1: "0", x2: "0.82", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#686e7a" }),
                h("stop", { offset: "0.34", "stop-color": "#4b4f59" }),
                h("stop", { offset: "0.72", "stop-color": "#343740" }),
                h("stop", { offset: "1", "stop-color": "#25272e" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-dpad-bevel", x1: "0.1", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#5f646f" }),
                h("stop", { offset: "0.48", "stop-color": "#3f434c" }),
                h("stop", { offset: "1", "stop-color": "#202229" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-ds4-button-rim", cx: "0.3", cy: "0.2", r: "0.86" },
                h("stop", { offset: "0", "stop-color": "#6d7380" }),
                h("stop", { offset: "0.42", "stop-color": "#4c515c" }),
                h("stop", { offset: "1", "stop-color": "#262930" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-ds4-button-cap", cx: "0.32", cy: "0.22", r: "0.9" },
                h("stop", { offset: "0", "stop-color": "#555a65" }),
                h("stop", { offset: "0.55", "stop-color": "#41454f" }),
                h("stop", { offset: "1", "stop-color": "#272a31" }),
              ),
              h(
                "radialGradient",
                { id: "nxg-ds4-stick-rim", cx: "0.36", cy: "0.26", r: "0.82" },
                h("stop", { offset: "0", "stop-color": "#69707c" }),
                h("stop", { offset: "0.36", "stop-color": "#484d57" }),
                h("stop", { offset: "0.72", "stop-color": "#2b2e35" }),
                h("stop", { offset: "1", "stop-color": "#17191e" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-utility-cap", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#686e79" }),
                h("stop", { offset: "0.45", "stop-color": "#4b4f59" }),
                h("stop", { offset: "1", "stop-color": "#292c33" }),
              ),
              h(
                "pattern",
                { id: "nxp-ds4-stick-rubber", width: "18", height: "18", patternUnits: "userSpaceOnUse" },
                h("rect", { width: "18", height: "18", fill: "#353942" }),
                h("circle", { cx: "4", cy: "4", r: "1.35", fill: "#565b66", opacity: "0.72" }),
                h("circle", { cx: "13", cy: "11", r: "1.05", fill: "#202229", opacity: "0.78" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-jet-black", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#303139" }),
                h("stop", { offset: "0.48", "stop-color": "#202024" }),
                h("stop", { offset: "1", "stop-color": "#17171a" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-glacier-white", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ffffff" }),
                h("stop", { offset: "0.5", "stop-color": "#e4e4e6" }),
                h("stop", { offset: "1", "stop-color": "#c9cad0" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-magma-red", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ef4842" }),
                h("stop", { offset: "0.5", "stop-color": "#d42323" }),
                h("stop", { offset: "1", "stop-color": "#a81319" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-ds4-midnight-blue", x1: "0", y1: "0", x2: "0", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#3a5579" }),
                h("stop", { offset: "0.5", "stop-color": "#223355" }),
                h("stop", { offset: "1", "stop-color": "#14223a" }),
              ),
              // Product-photo-informed shell ramps for the three premium
              // controller families. They stay document-wide so cloned SVGs
              // never need private defs (the browser resolves every url()).
              h(
                "linearGradient",
                { id: "nxg-dualsense-white", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ffffff" }),
                h("stop", { offset: "0.48", "stop-color": "#d9dde6" }),
                h("stop", { offset: "1", "stop-color": "#aeb5c2" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-dualsense-midnight-black", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#4a4d5d" }),
                h("stop", { offset: "0.5", "stop-color": "#252733" }),
                h("stop", { offset: "1", "stop-color": "#10121a" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-dualsense-cosmic-red", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#e64c6b" }),
                h("stop", { offset: "0.5", "stop-color": "#b72446" }),
                h("stop", { offset: "1", "stop-color": "#74152c" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-dualsense-nova-pink", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ffa0bd" }),
                h("stop", { offset: "0.5", "stop-color": "#e86f99" }),
                h("stop", { offset: "1", "stop-color": "#a83d66" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-dualsense-starlight-blue", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#81c5e8" }),
                h("stop", { offset: "0.5", "stop-color": "#4b9fd0" }),
                h("stop", { offset: "1", "stop-color": "#24668f" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-dualsense-galactic-purple", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#a47bd5" }),
                h("stop", { offset: "0.5", "stop-color": "#7049a7" }),
                h("stop", { offset: "1", "stop-color": "#45296d" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-switchpro-carbon-black", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#737a80" }),
                h("stop", { offset: "0.52", "stop-color": "#52585c" }),
                h("stop", { offset: "1", "stop-color": "#292d31" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-switchpro-ink-pair", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#71808a" }),
                h("stop", { offset: "0.52", "stop-color": "#46515a" }),
                h("stop", { offset: "1", "stop-color": "#252b30" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-switchpro-crimson-red", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#d0525f" }),
                h("stop", { offset: "0.52", "stop-color": "#a82736" }),
                h("stop", { offset: "1", "stop-color": "#681720" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-switchpro-frost-white", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ffffff" }),
                h("stop", { offset: "0.52", "stop-color": "#eceef0" }),
                h("stop", { offset: "1", "stop-color": "#b9c0c7" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-xboxseries-black", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#515155" }),
                h("stop", { offset: "0.5", "stop-color": "#28282a" }),
                h("stop", { offset: "1", "stop-color": "#141416" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-xboxseries-white", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ffffff" }),
                h("stop", { offset: "0.5", "stop-color": "#d7d7d7" }),
                h("stop", { offset: "1", "stop-color": "#a9abad" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-xboxseries-blue", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#3677db" }),
                h("stop", { offset: "0.5", "stop-color": "#1c448a" }),
                h("stop", { offset: "1", "stop-color": "#102750" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-xboxseries-red", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#ff4b44" }),
                h("stop", { offset: "0.5", "stop-color": "#e71717" }),
                h("stop", { offset: "1", "stop-color": "#8b0b0b" }),
              ),
              h(
                "linearGradient",
                { id: "nxg-xboxseries-green", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
                h("stop", { offset: "0", "stop-color": "#e1f668" }),
                h("stop", { offset: "0.5", "stop-color": "#c1db31" }),
                h("stop", { offset: "1", "stop-color": "#728b12" }),
              ),
              // A compact touch texture for the free DS4's 640-unit source.
              // Hoisting it keeps every clone on the same app-owned paint.
              h(
                "pattern",
                { id: "nxp-ds4-touch", width: "5.48", height: "5.48", patternUnits: "userSpaceOnUse" },
                h("circle", { cx: "1.1", cy: "1.1", r: "0.72", fill: "#080910" }),
              ),
              h(
                "pattern",
                { id: "nxp-ds4-paid-touch", width: "32.531", height: "32.531", patternUnits: "userSpaceOnUse" },
                h("circle", { cx: "4.597", cy: "4.597", r: "4.15", fill: "#090a10" }),
              ),
            ),
          ),
        h(
          "div",
          { class: "n-padmasters", "aria-hidden": "true" },
          h(
            "div",
            { class: () => nPadXboxCls(), "data-pad-family": "xbox" },
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
              // (Grumbel, public domain), recolored to the carbon palette.
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
          // ── Hybrid DualShock 4 (ViGEm PlayStation) ────────────────────
          // Funky Designs' CC0 geometry supplies the real product detail;
          // our MIT/app semantic layer supplies L2/R2, exact mapper hooks and
          // key callouts. All layers share this one SVG and coordinate box.
          h(
            "div",
            { class: () => nPadPsCls(), "data-pad-family": "ps" },
            h(
              "svg",
              {
                class: "wspad ds4a ds4premium",
                viewBox: "-28 -18 696 550",
                preserveAspectRatio: "xMidYMid meet",
                "data-ds4-variant": "jet-black",
                "aria-hidden": "true",
                focusable: "false",
              },
              h(
                "g",
                { class: "ds4premium-body" },
                h(
                  "g",
                  { class: "ds4premium-trigger-bridges" },
                  h("path", { class: "ds4premium-trigger-bridge", d: "M96 77 C109 68 151 68 164 78 L166 123 C143 120 116 120 90 126 L90 96 C90 87 92 82 96 77 Z" }),
                  h("path", { class: "ds4premium-trigger-bridge", d: "M544 77 C531 68 489 68 476 78 L474 123 C497 120 524 120 550 126 L550 96 C550 87 548 82 544 77 Z" }),
                ),
                h(
                  "g",
                  { class: "ds4premium-paid", transform: "matrix(0.1684210526 0 0 0.1684210526 0 105)" },
                  h(Ds4PremiumDepth, null),
                  h(Ds4PremiumGeometry, null),
                  // The 40 KB source dot-grid becomes one shared pattern.
                  h("path", { class: "ds4premium-touch-overlay", d: "M1355.79,842.942c-49.66,0 -89.98,-40.32 -89.98,-89.98l0,-612.415c0,-10.354 8.39,-18.748 18.75,-18.748l1230.88,0c10.36,0 18.75,8.394 18.75,18.748l0,612.415c0,49.66 -40.32,89.98 -89.98,89.98l-1088.42,0Z" }),
                ),
              ),
              // Two app-authored L2 zones plus 23 exact duplicates of the
              // paid drawing's whole controls. The paid duplicates carry the
              // same matrix as the art, so hover borders cannot drift.
              h(
                "g",
                { class: "ds4premium-hooks" },
                h("path", { "data-fn": "lt", class: "ds4premium-hook", d: "M167.27,80.69l-2.79-35.54c-1.25-15.98-14.77-28.21-30.8-27.85-13.24.3-24.75,9.19-28.38,21.93L93.72,79.86c-.77,2.71,1.26,5.4,4.08,5.4h65.24c2.47,0,4.42-2.11,4.23-4.57Z", fill: "transparent", "vector-effect": "non-scaling-stroke" }),
                h("path", { "data-fn": "rt", class: "ds4premium-hook", d: "M472.73,80.69l2.79-35.54c1.25-15.98,14.77-28.21,30.8-27.85,13.24.3,24.75,9.19,28.38,21.93l11.58,40.63c.77,2.71-1.26,5.4-4.08,5.4h-65.24c-2.47,0-4.42-2.11-4.23-4.57Z", fill: "transparent", "vector-effect": "non-scaling-stroke" }),
                h(Ds4PremiumButtonHooks, null),
                h("path", { "data-fn": "lt", class: "ds4free-hook", d: "M167.27,80.69l-2.79-35.54c-1.25-15.98-14.77-28.21-30.8-27.85-13.24.3-24.75,9.19-28.38,21.93L93.72,79.86c-.77,2.71,1.26,5.4,4.08,5.4h65.24c2.47,0,4.42-2.11,4.23-4.57Z", fill: "transparent" }),
                h("path", { "data-fn": "rt", class: "ds4free-hook", d: "M472.73,80.69l2.79-35.54c1.25-15.98,14.77-28.21,30.8-27.85,13.24.3,24.75,9.19,28.38,21.93l11.58,40.63c.77,2.71-1.26,5.4-4.08,5.4h-65.24c-2.47,0-4.42-2.11-4.23-4.57Z", fill: "transparent" }),
                h("path", { "data-fn": "lb", class: "ds4free-hook", d: "M165.32,123.06v-3.76c0-3.2-2.11-6.02-5.17-6.96-31.09-9.5-55.53-1.1-65.02,3.2-2.6,1.18-4.28,3.76-4.28,6.62v3.34s38.5-2.96,74.48-2.44Z", fill: "transparent" }),
                h("path", { "data-fn": "rb", class: "ds4free-hook", d: "M549.16,125.5v-3.34c0-2.86-1.68-5.44-4.28-6.62-9.49-4.3-33.93-12.7-65.02-3.2-3.06.94-5.17,3.75-5.17,6.96v3.76s34.84-.67,74.48,2.44Z", fill: "transparent" }),
                h("rect", { "data-fn": "back", class: "ds4free-hook", x: "183", y: "141", width: "22", height: "39", rx: "10", fill: "transparent" }),
                h("rect", { "data-fn": "start", class: "ds4free-hook", x: "435", y: "141", width: "22", height: "39", rx: "10", fill: "transparent" }),
                h("path", { "data-fn": "dpad.up", class: "ds4free-hook", d: "M140.7,184.19v6.44c0,5.03-1.96,9.87-5.46,13.49l-7.64,7.89c-3,3.09-8,2.99-10.87-.22l-6.95-7.79c-3.17-3.55-4.92-8.14-4.92-12.9v-6.9c0-6.43,5.21-11.64,11.64-11.64h12.57c6.43,0,11.64,5.21,11.64,11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.right", class: "ds4free-hook", d: "M163.28,242.61h-6.44c-5.03,0-9.87-1.96-13.49-5.46l-7.89-7.64c-3.09-3-2.99-8,.22-10.87l7.79-6.95c3.55-3.17,8.14-4.92,12.9-4.92h6.9c6.43,0,11.64,5.21,11.64,11.64v12.57c0,6.43-5.21,11.64-11.64,11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.down", class: "ds4free-hook", d: "M104.86,265.19v-6.44c0-5.03,1.96-9.87,5.46-13.49l7.64-7.89c3-3.09,8-2.99,10.87.22l6.95,7.79c3.17,3.55,4.92,8.14,4.92,12.9v6.9c0,6.43-5.21,11.64-11.64,11.64h-12.57c-6.43,0-11.64-5.21-11.64-11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.left", class: "ds4free-hook", d: "M82.28,206.77h6.44c5.03,0,9.87,1.96,13.49,5.46l7.89,7.64c3.09,3,2.99,8-.22,10.87l-7.79,6.95c-3.55,3.17-8.14,4.92-12.9,4.92h-6.9c-6.43,0-11.64-5.21-11.64-11.64v-12.57c0-6.43,5.21-11.64,11.64-11.64Z", fill: "transparent" }),
                // y=triangle, b=circle, a=cross, x=square.
                h("circle", { "data-fn": "y", class: "ds4free-hook", cx: "517.22", cy: "178.98", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "b", class: "ds4free-hook", cx: "563.04", cy: "224.8", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "a", class: "ds4free-hook", cx: "517.22", cy: "270.62", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "x", class: "ds4free-hook", cx: "471.4", cy: "224.8", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "guide", class: "ds4free-hook", cx: "320.16", cy: "314.85", r: "17", fill: "transparent" }),
                h("circle", { "data-fn": "lthumb", class: "ds4free-hook", cx: "219.94", cy: "314.85", r: "24", fill: "transparent" }),
                h("circle", { "data-fn": "ly.max", class: "ds4free-hook", cx: "219.94", cy: "280", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "ly.min", class: "ds4free-hook", cx: "219.94", cy: "350", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "lx.min", class: "ds4free-hook", cx: "185", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "lx.max", class: "ds4free-hook", cx: "255", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rthumb", class: "ds4free-hook", cx: "420.06", cy: "314.85", r: "24", fill: "transparent" }),
                h("circle", { "data-fn": "ry.max", class: "ds4free-hook", cx: "420.06", cy: "280", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "ry.min", class: "ds4free-hook", cx: "420.06", cy: "350", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rx.min", class: "ds4free-hook", cx: "385", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rx.max", class: "ds4free-hook", cx: "455", cy: "314.85", r: "13", fill: "transparent" }),
              ),
              // The free source intentionally has no retail face symbols or
              // lightbar; this app-owned dressing supplies those details.
              h(
                "g",
                { class: "ds4free-dressing" },
                h("path", { class: "ds4free-grip-shade", d: "M18 328 C8 372 5 433 27 470 C43 497 75 504 99 491 C119 480 133 457 143 429 C126 449 107 460 84 463 C52 466 29 443 24 410 C20 378 24 349 32 320 Z" }),
                h("path", { class: "ds4free-grip-shade", d: "M622 328 C632 372 635 433 613 470 C597 497 565 504 541 491 C521 480 507 457 497 429 C514 449 533 460 556 463 C588 466 611 443 616 410 C620 378 616 349 608 320 Z" }),
                h("path", { class: "ds4free-touch-texture", d: "M419.35,234.87v-102.38c0-2.12-1.73-3.85-3.85-3.85h-191.01c-2.12,0-3.85,1.73-3.85,3.85v102.38c0,4.13,3.36,7.5,7.5,7.5h183.71c4.13,0,7.5-3.36,7.5-7.5Z" }),
                h("path", { class: "ds4free-lightbar", d: "M235 131 Q320 119 405 131" }),
                h("path", { class: "ds4free-touch-sheen", d: "M235 142 Q320 132 405 142" }),
                h("path", { class: "ds4free-dpad-mark", d: "M122.78 179 l-6.2 10.5 h12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M168.3 224.69 l-10.5 -6.2 v12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M122.78 270.2 l-6.2 -10.5 h12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M77.3 224.69 l10.5 -6.2 v12.4 Z" }),
                h("rect", { class: "ds4free-face-mark ds4free-square-mark", x: "463.2", y: "216.6", width: "16.4", height: "16.4", rx: "1" }),
                h("circle", { class: "ds4free-face-mark ds4free-circle-mark", cx: "563.04", cy: "224.8", r: "8.7" }),
                h("path", { class: "ds4free-face-mark ds4free-triangle-mark", d: "M517.22 169.1 l9.1 16.1 h-18.2 Z" }),
                h("path", { class: "ds4free-face-mark ds4free-cross-mark", d: "M510.7 264.1 l13 13 M523.7 264.1 l-13 13" }),
                h("path", { class: "ds4free-stick-highlight", d: "M196 304 A27 27 0 0 1 243 304" }),
                h("path", { class: "ds4free-stick-highlight", d: "M396 304 A27 27 0 0 1 444 304" }),
                h("text", { class: "ds4free-guide-mark", x: "320.16", y: "318.5", "text-anchor": "middle" }, "PS"),
                h("text", { class: "ds4free-sys", x: "133", y: "63", "text-anchor": "middle" }, "L2"),
                h("text", { class: "ds4free-sys", x: "507", y: "63", "text-anchor": "middle" }, "R2"),
                h("text", { class: "ds4free-sys", x: "129", y: "121", "text-anchor": "middle" }, "L1"),
                h("text", { class: "ds4free-sys", x: "511", y: "121", "text-anchor": "middle" }, "R1"),
                h("text", { class: "ds4free-legend", x: "194", y: "137", "text-anchor": "middle" }, "SHARE"),
                h("text", { class: "ds4free-legend", x: "446", y: "137", "text-anchor": "middle" }, "OPTIONS"),
              ),
              h(
                "g",
                { class: "ds4premium-callouts" },
                h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "88", y: "48", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "82", y: "122", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "552", y: "48", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "558", y: "122", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "194", y: "193", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "446", y: "193", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "123", y: "159", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "123", y: "298", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "56", y: "229", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "190", y: "229", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "220", y: "319", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "220", y: "270", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "220", y: "382", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "171", y: "319", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "269", y: "319", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "420", y: "319", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "420", y: "270", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "420", y: "382", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "371", y: "319", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "469", y: "319", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "320", y: "350", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "517", y: "149", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "592", y: "229", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "442", y: "229", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "517", y: "317", "text-anchor": "middle" }),
              ),
            ),
          ),
          // ── Premium CC0 DualSense ─────────────────────────────────────
          h(
            "div",
            { class: () => nPadPs5Cls(), "data-pad-family": "ps5" },
            h(DualSensePremiumArt, null),
          ),
          // ── Premium CC0 Nintendo Switch Pro ───────────────────────────
          h(
            "div",
            { class: () => nPadSwitchProCls(), "data-pad-family": "switchpro" },
            h(SwitchProPremiumArt, null),
          ),
          // ── Premium CC0 Xbox Series X|S ────────────────────────────────
          h(
            "div",
            { class: () => nPadXboxSeriesCls(), "data-pad-family": "xboxseries" },
            h(XboxSeriesPremiumArt, null),
          ),
        ),
        // ── THE CANVAS ────────────────────────────────────────────────────
        // A real pan/zoom surface: this served skeleton is exactly what the
        // vendored genui engine builds for itself, so `initNocturneCanvas`
        // ADOPTS it after hydration instead of creating structure the parity
        // gate would see. Everything the engine writes on the marked nodes
        // (geometry styles, its data- families) rides the parity contract's
        // client-canvas exemption; the zoom readout is connection chatter.
        h(
          "section",
          { class: "forma-canvas n-canvas", "data-forma-canvas": "", "data-client-canvas": "" },
          // The across-the-room read: one quiet word from the polled
          // session, visual only (the sr status line announces transitions).
          h("span", { "aria-hidden": "true", class: "n-stageword" }, () => nStageWord()),
          h(
            "div",
            {
              class: "forma-canvas-viewport",
              "data-forma-canvas-viewport": "",
              "data-client-canvas": "",
              tabindex: "0",
              "aria-label": "Controller canvas",
            },
            h("div", { class: "forma-canvas-grid", "aria-hidden": "true" }),
            h(
              "div",
              {
                class: "forma-canvas-stage",
                "data-forma-canvas-stage": "",
                "data-client-canvas": "",
                role: "list",
              },
              // The keyboard, as a canvas widget: the article shell carries
              // exactly the attributes the engine writes on mount, so
              // adoption re-stamps bytes that are already there.
              h(
                "article",
                {
                  class: "widget-instance n-widget n-widget-kb",
                  id: "keyboard-source-widget",
                  role: "listitem",
                  "aria-label": "Input source",
                  tabindex: "-1",
                  "data-client-canvas": "",
                  "data-instance-id": "keyboard",
                  "data-widget-name": "Input source",
                  "data-widget-navigation-item": "",
                  "data-canvas-preferred-width": "980",
                  "data-canvas-min-height": "320",
                  "data-canvas-resizable": "false",
                   "aria-keyshortcuts":
                     "ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter F2 M Meta+Enter Control+Enter",
                   "data-keyboard-theme": () => nKeyboardTheme(),
                   "data-keycap-profile": () => nKeyboardCapProfile(),
                   "data-source-hidden": "false",
                 },
                h(
                  "header",
                  { class: "widget-chrome" },
                   h(
                     "div",
                     { class: "widget-command-region", "data-widget-command-region": "" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "widget-drag-handle",
                        "aria-label": "Move input source",
                        title:
                          "Drag input source to move · Arrow keys nudge · Enter opens the widget",
                      },
                      h("span", {
                        class: "widget-drag-rail",
                        "data-widget-command-rail": "",
                        "aria-hidden": "true",
                      }),
                     ),
                   ),
                   h(
                     "div",
                     { class: "n-source-parked", "aria-live": "polite" },
                     h(
                       "span",
                       { class: "n-source-parked-copy" },
                       h("strong", null, "Input source hidden"),
                       h(
                         "small",
                         null,
                         "Signals, mappings, and canvas position are preserved.",
                       ),
                     ),
                     h(
                       "button",
                       {
                         type: "button",
                         class: "n-source-show",
                         "data-nx": "keylab-source-show",
                         "aria-controls": "keyboard-source-widget",
                       },
                       "Show input source",
                     ),
                   ),
                 ),
                h(
                  "div",
                  {
                    class: "n-widget-body",
                    "data-forma-runtime-host": "",
                    "aria-hidden": "false",
                  },
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
          // The board's key to its own map: which color speaks for which
          // controller. Each chip mutes that player's color on the keys —
          // the visibility control lives WITH the color it explains.
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
                    title: "Hide this controller's color on the keys",
                    class: r.cls,
                  },
                  h("span", { class: "n-lgd-dot" }),
                  h("span", { class: "n-lgd-badge" }, r.badge),
                  h("span", { class: "n-lgd-name" }, r.name),
                ),
            ),
            // ...and the key to a cap that names nobody. A mark nothing
            // labels is a mark you have to guess at, so the weave gets its
            // word right here, beside the colors it stands in for.
            h(
              "span",
              {
                title:
                  "A key five or more controllers share shows how many, instead of their colors.",
                class: () => nKbMoreCls(),
              },
              h("span", { class: "n-lgdmore-sw" }),
              h("span", { class: "n-lgdmore-lbl" }, "5+"),
              h("span", { class: "n-lgdmore-name" }, "share a key"),
            ),
          ),
          h("div", { class: "n-spring" }),
          // Material belongs to the keyboard, never to a controller seat.
          // These are six app-owned paints over the same semantic geometry;
          // the ownership bands remain a separate layer on every finish.
          h(
            "div",
            { class: "n-kbthemes", role: "group", "aria-label": "Keyboard finish" },
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "carbon-forge",
              title: "Carbon Forge",
              "aria-label": "Carbon Forge keyboard finish",
              "aria-pressed": () => nKbtCarbonPressed(),
            }),
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "lunar-shell",
              title: "Lunar Shell",
              "aria-label": "Lunar Shell keyboard finish",
              "aria-pressed": () => nKbtLunarPressed(),
            }),
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "violet-circuit",
              title: "Violet Circuit",
              "aria-label": "Violet Circuit keyboard finish",
              "aria-pressed": () => nKbtVioletPressed(),
            }),
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "glacier-current",
              title: "Glacier Current",
              "aria-label": "Glacier Current keyboard finish",
              "aria-pressed": () => nKbtGlacierPressed(),
            }),
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "ghost-mint",
              title: "Ghost Mint",
              "aria-label": "Ghost Mint keyboard finish",
              "aria-pressed": () => nKbtMintPressed(),
            }),
            h("button", {
              type: "button",
              class: "n-kbtheme",
              "data-nx": "kb-theme",
              "data-keyboard-theme": "retro-terminal",
              title: "Retro Terminal",
              "aria-label": "Retro Terminal keyboard finish",
              "aria-pressed": () => nKbtRetroPressed(),
            }),
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-kbbuild",
              "data-nx": "kb-workbench",
              title:
                "Arrange real keycaps from this detected keyboard without changing their identities or mappings",
              "aria-pressed": () => nKbWorkbenchPressed(),
            },
            () => nKeyboardWorkbenchOpen() ? "Arranging appearance" : "Arrange appearance",
          ),
          // Focus the board on the controller you are editing: everyone
          // else's color greys out — nothing is hidden, so a key never
          // looks unbound when it is not. Default ships in the markup
          // (the parity gate's rule).
          h(
            "button",
            {
              type: "button",
              "data-nx": "kb-colors",
              "aria-pressed": "false",
              title:
                "Show only this controller's color on the keys. Switch it off and your own crossings come back; click a chip while it is on to keep what you see.",
              class: "n-kbcolors",
            },
            () => nSoloLbl(),
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
          { class: () => nKbCls() },
          h(
            "div",
            { class: "n-kbcase" },
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
                ), // n-widget-body
              ), // article.widget-instance (the keyboard widget)
            ), // .forma-canvas-stage
            // Direct mapping cords use world coordinates like widgets, but
            // remain siblings of the role=list stage: edges are canvas
            // chrome, not list items. Cords and small ports sit above the art
            // so every path visibly leaves its real keycap/control. Both are
            // pointer-transparent and client-filled.
            h("svg", {
              id: "n-mapping-paths",
              class: "n-flow-layer n-flow-lines",
              "data-flow-layer": "lines",
              "data-flow-mode": "off",
              "data-flow-count": "0",
              "data-flow-unresolved": "0",
              "data-flow-direct": "0",
              "data-flow-macro-connections": "0",
              "data-flow-resolved-direct": "0",
              "data-flow-resolved-macro-connections": "0",
              "data-flow-processors": "0",
              "data-flow-processor-overflow": "0",
              "data-flow-mapping-unavailable": "0",
              "data-flow-macro-unavailable": "0",
              "data-client-subtree": "",
              "data-client-canvas": "",
              "aria-hidden": "true",
              focusable: "false",
              hidden: "",
            }),
            h("svg", {
              id: "n-mapping-ports",
              class: "n-flow-layer n-flow-ports",
              "data-flow-layer": "ports",
              "data-flow-mode": "off",
              "data-flow-count": "0",
              "data-flow-unresolved": "0",
              "data-flow-direct": "0",
              "data-flow-macro-connections": "0",
              "data-flow-resolved-direct": "0",
              "data-flow-resolved-macro-connections": "0",
              "data-flow-processors": "0",
              "data-flow-processor-overflow": "0",
              "data-flow-mapping-unavailable": "0",
              "data-flow-macro-unavailable": "0",
              "data-client-subtree": "",
              "data-client-canvas": "",
              "aria-hidden": "true",
              focusable: "false",
              hidden: "",
            }),
            h("div", {
              id: "n-mapping-processors",
              class: "n-flow-node-layer",
              "data-flow-layer": "processors",
              "data-flow-mode": "off",
              "data-flow-count": "0",
              "data-flow-unresolved": "0",
              "data-flow-direct": "0",
              "data-flow-macro-connections": "0",
              "data-flow-resolved-direct": "0",
              "data-flow-resolved-macro-connections": "0",
              "data-flow-processors": "0",
              "data-flow-processor-overflow": "0",
              "data-flow-mapping-unavailable": "0",
              "data-flow-macro-unavailable": "0",
              "data-client-subtree": "",
              "data-client-canvas": "",
              hidden: "",
            }),
            // The map in the corner: a button per widget (click to jump) and
            // a pale rectangle for the camera (drag inside to pan). Both are
            // filled by the engine — the ITEMS box is client-populated by
            // contract (parity rule 3f), the camera rectangle rides the
            // client-canvas exemption for its inline geometry.
            h(
              "aside",
              {
                class: "forma-canvas-navigator n-navigator",
                "data-forma-canvas-navigator": "",
                "aria-label": "Canvas map",
                "data-client-canvas": "",
              },
              // The map's own hide button. The meta bar's "Map" toggle does
              // the same thing, but nobody looks there to put away the thing
              // in the corner — the corner is where you reach for it.
              h(
                "button",
                {
                  type: "button",
                  class: "n-mapclose",
                  "data-nx": "canvas-map",
                  "aria-label": "Hide the canvas map",
                  title: "Hide the canvas map",
                },
                "×",
              ),
              h("div", {
                class: "forma-canvas-navigator-items",
                "data-client-subtree": "",
              }),
              h("div", {
                class: "forma-canvas-navigator-viewport",
                "aria-hidden": "true",
                "data-client-canvas": "",
              }),
            ),
            // What brings the map back, in the corner the map lives in.
            // Served hidden: the map starts shown, and this is its stand-in.
            h(
              "button",
              {
                type: "button",
                class: "n-mapshow",
                "data-nx": "canvas-map",
                "aria-label": "Show the canvas map",
                title: "Show the canvas map",
                hidden: "",
              },
              "▦",
            ),
          ), // .forma-canvas-viewport
        ), // .n-canvas
      ),
      // ── Right pane: the binding list, off the mapper's own machinery ─────
      h(
        "aside",
        { class: () => nRightCls(), "aria-label": "Mapping inspector" },
        h(
          "div",
          { class: "n-rail" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-right" }, "‹"),
          h("span", { class: "n-rail-vlab" }, "Inspector"),
        ),
        h(
          "section",
          { class: "n-inspector-card" },
          h(
            "div",
            { class: "n-inspector-top" },
            h("span", { class: "n-inspector-kicker" }, "MAPPING INSPECTOR"),
            h(
              "button",
              {
                type: "button",
                class: "n-inspector-browse",
                "data-nx": "inspector-browse",
              },
              "Browse all",
            ),
          ),
          h("h2", { class: "n-inspector-title" }, () => nBindTitle()),
          h("p", { class: "n-inspector-meta" }, () => nBindFoot()),
          h(
            "button",
            { type: "button", class: "n-inspector-action", "data-nx": "inspector-action" },
            "Find mappings",
          ),
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
            h("input", {
              class: "n-filter-in",
              type: "text",
              name: "q",
              placeholder: "Find keys, controls, macros",
              "aria-label": "Find mappings",
            }),
            h("kbd", { class: "n-filter-key", "aria-hidden": "true" }, "Ctrl K"),
          ),
          h("button", { class: "n-reset", type: "button", "data-nx": "filter-reset" }, "Reset"),
        ),
        // The pane's two READINGS of one relation: by control (game side)
        // and by key (hand side). Same facts, opposite subject.
        h(
          "div",
          { class: "n-vseg", role: "group", "aria-label": "Mapping view" },
          h(
            "button",
            {
              type: "button",
              class: "n-vseg-btn vc",
              "data-nx": "view-ctl",
              "aria-pressed": () => nViewCtlPressed(),
            },
            "Controls",
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-vseg-btn vk",
              "data-nx": "view-keys",
              "aria-pressed": () => nViewKeysPressed(),
            },
            "Keys",
          ),
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
                    "Edit steps…",
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
        h(
          "details",
          { class: "n-macnew" },
          h("summary", null, "New macro\u2026"),
          h(
            "form",
            { class: "n-macnewform", method: "post", action: "/nocturne/macro/new" },
            h("input", { type: "hidden", name: "slot", value: () => nSlotVal() }),
            h("input", {
              class: "n-macnewin",
              type: "text",
              name: "name",
              required: "",
              maxlength: "40",
              placeholder: "hadouken",
              "aria-label": "What to call the macro",
            }),
            h("button", { type: "submit", class: "n-bbtn" }, "Create"),
          ),
          h(
            "span",
            { class: "n-macnewnote" },
            "It starts with one empty step. The name becomes the table\u2019s, and \u2018macro.\u2019 plus it is the control a key can drive.",
          ),
        ),
        h("p", { class: "n-devnote" }, () => nMacrosNote()),
        ),
        h("div", { class: "n-right-foot" }, () => nBindFoot()),
      ),
    ),
    // ═══ The macro STEP editor ═══════════════════════════════════════════
    // Rows are steps, columns are this pad's controls, a cell is held or not
    // (docs/INPUT-TRANSFORMS.md §6.2). Everything here is SERVED markup wearing
    // a class — never a createShow — so the dialog opens by link, survives a
    // reload, and reads without scripting.
    h(
      "div",
      { "data-nx": "mac-close", class: () => nMacBackCls() },
      h(
        "div",
        {
          id: "n-macro-dialog",
          "data-nx": "dlg-noop",
          role: "dialog",
          "aria-modal": "true",
          tabindex: "-1",
          "aria-label": "Macro steps",
          class: "nd nd-mac",
        },
        h(
          "div",
          { class: "n-machd" },
          h("div", { class: "nd-kick" }, "Macro"),
          h("div", { class: "nd-title" }, () => nMacName()),
          h("div", { class: "nd-lede" }, () => nMacTrigger()),
          h("div", { class: "n-macmeta" }, () => nMacHead()),
          h("div", { class: "n-macdis" }, () => nMacNote()),
          h("div", { role: "status", class: () => nMacSayCls() }, () => nMacSay()),
          h(
            "a",
            {
              class: "n-macx",
              "data-nx": "mac-close",
              "aria-label": "Close the macro editor",
              href: () => nMacClose(),
            },
            "\u2715",
          ),
        ),
        // THE ROLL. Two aligned columns: the step bar (number, what the step
        // holds in words, its time and its verbs) and the scrolling matrix
        // under its own labelled bands.
        h(
          "div",
          { class: () => nMacGridCls() },
          h(
            "div",
            { class: "n-macbar" },
            h("div", { class: "n-macbarhd" }, "step"),
            createList(
              () => nMacRows(),
              (r) =>
                r.n + "|" + r.cls + "|" + r.dur + "|" + r.unit + "|" + r.del_title +
                "|" + r.warn + "|" + r.hold + "|" + r.hold_cls + "|" + r.exp +
                // The arrows' own classes: without them a row kept a dead
                // ▾ after an insert, or a live-looking one after a delete.
                "|" + r.up_cls + "|" + r.dn_cls,
              (r) =>
                h(
                  "div",
                  { title: r.dur_title, class: r.cls },
                  h("span", { class: "n-macn" }, r.n),
                  // WHAT THIS ROW HOLDS, before its timing — reading the roll
                  // must never mean decoding which of 37 columns are lit. A
                  // diagonal reads as ONE control, because that is what was
                  // picked and what it means.
                  h("span", { class: r.hold_cls }, r.hold),
                  // …and the ledger beside it: the two names the FILE carries
                  // for that diagonal.
                  h("span", { title: r.exp, class: r.exp_cls }, r.exp),
                  h("span", { class: "n-macdurw" }, r.dur),
                  h(
                    "span",
                    { class: "n-macdured" },
                    h("input", {
                      type: "number",
                      min: "1",
                      step: "1",
                      value: r.dur_val,
                      title: r.dur_title,
                      "data-macdur": r.dur_row,
                      class: r.dur_cls,
                    }),
                    h(
                      "button",
                      {
                        type: "button",
                        title: r.unit_title,
                        "data-macact": r.unit_act,
                        class: "n-macunit",
                      },
                      r.unit,
                    ),
                  ),
                  h("span", { title: r.warn_title, class: r.warn_cls }, r.warn),
                  h(
                    "span",
                    { class: "n-macverbs" },
                    h("button", { type: "button", title: "Move this step up", "aria-label": "Move this step up", "data-macact": r.up_act, class: r.up_cls }, "\u25B4"),
                    h("button", { type: "button", title: "Move this step down", "aria-label": "Move this step down", "data-macact": r.dn_act, class: r.dn_cls }, "\u25BE"),
                    h("button", { type: "button", title: "Insert a step above this one", "aria-label": "Insert a step above this one", "data-macact": r.ia_act, class: "n-macbtn" }, "\u2912"),
                    h("button", { type: "button", title: "Insert a step below this one", "aria-label": "Insert a step below this one", "data-macact": r.ib_act, class: "n-macbtn" }, "\u2913"),
                    h("button", { type: "button", title: r.del_title, "aria-label": r.del_title, "data-macact": r.del_act, class: "n-macbtn del" }, "\u2715"),
                  ),
                ),
            ),
          ),
          h(
            "div",
            { class: "n-macscroll" },
            // THE BANDS, each NAMED and each carrying how many holds live
            // under it — with 37 columns, "where is this macro's content"
            // must be answerable before you read a single cell.
            h(
              "div",
              { class: "n-macgrps" },
              createList(
                () => nMacGroups(),
                (g) => g.label + "|" + g.cls + "|" + g.count,
                (g) =>
                  h(
                    "span",
                    { class: g.cls },
                    h("span", { class: "n-macgrp-l" }, g.label),
                    h("span", { class: g.count_cls }, g.count),
                  ),
              ),
            ),
            h(
              "div",
              { class: "n-maccols" },
              createList(
                () => nMacCols(),
                (c) => c.id + "|" + c.cls + "|" + c.title,
                (c) => h("span", { title: c.title, class: c.cls }, c.id),
              ),
            ),
            h(
              "div",
              { role: "grid", "aria-label": "Steps by control", class: "n-macmatrix" },
              createList(
                () => nMacCells(),
                (c) => c.cell + "|" + c.cls + "|" + c.tab,
                (c) =>
                  h(
                    "button",
                    {
                      type: "button",
                      title: c.title,
                      "aria-label": c.title,
                      "aria-pressed": c.on,
                      tabindex: c.tab,
                      "data-maccell": c.cell,
                      class: c.cls,
                    },
                    c.mark,
                  ),
              ),
            ),
          ),
        ),
        h(
          "details",
          { class: "n-machelp" },
          h("summary", null, "How to read this roll"),
          h("p", { class: "n-macring" }, () => nMacRing()),
          h("p", { class: "n-macrule" }, () => nMacRule()),
        ),
        h(
          "div",
          { class: "n-macedit" },
          h("button", { type: "button", "data-macact": "add", class: "n-bbtn" }, "Add step"),
          h("button", { type: "button", "data-macact": "short", class: "n-bbtn ghost" }, "Allow a short step"),
        ),
        // THE MOTION WRITER. Each button carries the SHAPE a player already
        // knows and its NAME beside it — never a bare glyph.
        h(
          "div",
          { class: "n-macmotions" },
          h("div", { class: "n-kick" }, "Common motions"),
          h("p", { class: "n-macmotline" }, () => nMacMotionLine()),
          h(
            "div",
            { class: "n-macmotrow" },
            createList(
              () => nMacMotions(),
              (m) => m.act + "|" + m.shape + "|" + m.label,
              (m) =>
                h(
                  "button",
                  { type: "button", title: m.title, "data-macmotion": m.act, class: "n-macmot" },
                  h("span", { class: "n-macmot-s" }, m.shape),
                  h("span", { class: "n-macmot-l" }, m.label),
                ),
            ),
          ),
        ),
        // THE POLICIES. Every option is visible and says what choosing it
        // does — a select hides the alternatives behind a click.
        h(
          "div",
          { class: "n-macpols" },
          h("div", { class: "n-kick" }, "Behaviour"),
          h("p", { class: "n-macpolline" }, () => nMacPolicyLine()),
          createList(
            () => nMacPols(),
            (o) => o.act + "|" + o.cls + "|" + o.head_cls,
            (o) =>
              h(
                "span",
                { class: "n-macpolw" },
                h("span", { class: o.head_cls }, o.head),
                h("span", { class: o.note_cls }, o.note),
                h("button", { type: "button", title: o.title, "data-macpol": o.act, class: o.cls }, o.label),
              ),
          ),
          h(
            "label",
            { class: () => nMacRateCls() },
            h("span", { class: "n-macratel" }, () => nMacRateLbl()),
            h("input", {
              type: "number",
              min: "1",
              step: "1",
              "data-macrate": "1",
              value: () => nMacRateVal(),
            }),
          ),
        ),
        h(
          "details",
          { class: "n-mactoml" },
          h("summary", null, "The table this writes"),
          h("pre", { class: "n-mactomlbox" }, () => nMacToml()),
        ),
        h(
          "div",
          { class: "n-macfoot" },
          h("span", { class: "n-macdirty" }, ""),
          h("button", { type: "button", "data-macact": "save", class: "n-bbtn n-macsave" }, "Save this macro"),
          h("a", { class: "n-bbtn ghost", href: () => nMacClose() }, "Close"),
        ),
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
