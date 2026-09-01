import { createList, createSignal, h } from "@getforma/core";
import {
  createCanvasItem,
  WidgetCanvas,
  WidgetCanvasCapacityError,
} from "./genui/canvas/index";
import {
  claimSavedDeviceGeometryKey,
  deviceInstanceId,
} from "./device-instance-id";
import { Ds4PremiumPadArt } from "./ds4PremiumPadArt";
import { DualSensePremiumArt } from "./dualSensePremiumArt";
import { loadControllerFinishes, loadDs4Variants } from "./padFinishes";
import { PadPaintServers } from "./padPaintServers";
import {
  MappingFlowLayer,
  mappingPathModeIsValid,
  type MappingFlowPad,
  type MappingPathMode,
} from "./mappingFlow";
import {
  armAssign,
  assignHeld,
  cancelAssign,
  cancelLearn,
  chainWanted,
  conflictCancel,
  conflictForce,
  mapperBusy,
  mapperEscape,
  mapperOnSlotChange,
  mapperReconcile,
  mapperRemark,
  resolveAssignWithControl,
  resolveLearnWithKey,
  skipAutoMapStep,
  startAutoMap,
  startLearn,
} from "./redesign-mapper";
import {
  renderControllerPanel,
  takePendingJumpFns,
  type InspectorTab,
  type RdKeyPanelView,
  type RdMacroRowView,
  type RdPanelView,
} from "./redesign-controller-inspector";
import {
  applyRdMacPayload,
  rdMacChange,
  rdMacClick,
  rdMacClose,
  rdMacOpen,
  type RdMacView,
} from "./redesign-macro-editor";
import {
  closeRedesignToolsDisclosure,
  REDESIGN_RAIL_PREFERENCES_MEDIA,
  redesignCompactToolsDisclosure,
  redesignToolsDisclosure,
  wireRedesignToolsDisclosures,
} from "./redesign-tools-menu";
import {
  syncControllerWidgets,
  type ParkedController,
  type RdControllerCardView,
  type RdPadSourceView,
  type RdPadView,
} from "./redesign-controllers";
import { SwitchProPremiumArt } from "./switchProPremiumArt";
import { X360PadArt } from "./x360PadArt";
import { XboxSeriesPremiumArt } from "./xboxSeriesPremiumArt";
import {
  createEncoderProfileLabCanvasItem,
  createEncoderWorkbenchSurface,
  disposeEncoderProfileLabCanvasItem,
  ENCODER_PROFILE_LAB_INSTANCE_ID,
  type EncoderProfileLabDevice,
  type EncoderWorkbenchSurface,
} from "./encoderConceptArt";
import {
  createKeyboardSurfaceInstance,
  createKeyboardSurfaceHost,
  KEYBOARD_SURFACE_SELECTOR,
  KEYBOARD_SURFACE_TEMPLATE_BODY_SELECTOR,
  syncKeyboardSourceMapping,
  syncKeyboardSurfaceInstance,
} from "./redesign-keyboard-device";

// ─────────────────────────────────────────────────────────────────────────────
// /redesign — the sole product workbench after hard cutover.
//
// The whole viewport is the pan/zoom canvas, plus its minimap, camera verbs,
// attached hardware, virtual controllers, inspector, mapping and lifecycle
// controls. These blocks were extracted from the retired Nocturne island into
// focused modules while preserving the measured interaction contracts.
//
// The root keeps the `nocturne` class ON PURPOSE: all pages share one hashed
// stylesheet, so reusing the class names (`nocturne`, `n-main`, `n-center`,
// `n-canvas`, the meta-bar vocabulary) IS the copy — renaming the root would
// orphan every scoped rule including the `:not(.js)` no-JS relaxation.
// ─────────────────────────────────────────────────────────────────────────────

/** One theme-menu row — `NocturneChoiceRow` on the wire (snapshot.rs), the
 *  same shape /nocturne's pickers consume. */
export interface RdChoiceRowView {
  name: string;
  title: string;
  detail: string;
  cls: string;
  chosen: boolean;
}

/** The rendered twin keeps ARIA token semantics instead of handing a boolean
 * to an attribute setter (where `true` becomes the meaningless empty value). */
interface RdRenderedChoiceRow extends Omit<RdChoiceRowView, "chosen"> {
  chosen: "true" | "false";
}

/** One picker device row — `NocturneDeviceRow` on the wire (snapshot.rs),
 *  the shape /nocturne's roster consumes. `selector` is the RAW backend
 *  string — canonicalizing it is how twin boards collide (the I-PAC
 *  lesson), so it rides untouched into data-selector and the bench store. */
export interface RdDeviceRowView {
  cls: string;
  name: string;
  meta: string;
  role: string;
  selector: string;
  /** Exact staged-device authority; empty until this board joins the draft. */
  staged_revision?: string;
  /** Exact runtime HID instance from the authoritative scan. Empty when the
   * provider cannot prove one; live paint then fails closed by selector/alias. */
  instance_id?: string;
  /** Server-authored short identity for disambiguating same-name boards. */
  connection_label: string;
  alias: string;
  label: string;
  aria_current: string;
  title: string;
  chart_readable: string;
  family_id?: string | null;
  protocol_profile?: string | null;
  profile_state: string;
  terminal_count?: number | null;
  capture_badge: string;
  capture_state: string;
  capture_cls: string;
}

/** A device the picker shows but cannot offer — no keyboard interface, or
 *  no selector to address it by. A name and a meta line and nothing else. */
export interface RdOtherRowView {
  name: string;
  meta: string;
}

/** The workbench picker's truth — `RedesignDeviceRows` on the wire. */
export interface RdDeviceRows {
  keyboards: RdDeviceRowView[];
  encoders: RdDeviceRowView[];
  experimental: RdDeviceRowView[];
  other: RdOtherRowView[];
  keyboards_head: string;
  keyboards_fold_cls: string;
  encoders_head: string;
  encoders_fold_cls: string;
  exp_head: string;
  exp_fold_cls: string;
  other_head: string;
  other_fold_cls: string;
  scan_line: string;
  scan_authoritative: boolean;
  staging_reachable: boolean;
  staging_line: string;
}

/** One persona the controller picker offers — `RedesignPersonaRow` on the
 *  wire (snapshot.rs). `usable` is a served word ("true"/"false"), so the
 *  island routes on a fact instead of parsing a class string. */
export interface RdPersonaRowView {
  name: string;
  label: string;
  api: string;
  note: string;
  cls: string;
  usable: string;
}

/** The controller picker's truth — `RedesignControllers` on the wire. The
 *  CARDS are daemon truth (the staged rack), reconciled onto the canvas by
 *  redesign-controllers.ts; the roster and every ceiling are served. */
export interface RdControllers {
  /** Exact source used to compose the selected controller's authoring views. */
  source?: string;
  source_revision?: string;
  source_preset?: string;
  add_source?: string;
  add_source_revision?: string;
  cards: RdControllerCardView[];
  personas: RdPersonaRowView[];
  add_preset: string;
  add_layout: string;
  add_note: string;
  counts_line: string;
  reachable: boolean;
  parked_held: string[];
  /** Every staged controller's canvas dressing — the same `NocturnePadView`
   *  rows /nocturne's widgets clone and dress, from the one composer. */
  pads: RdPadView[];
  /** The selected controller's whole panel — the same `ControllerPanel`
   *  /nocturne's right pane serves. */
  panel: RdPanelView;
  /** The panel's other reading — the Keys tab, the same `KeyPanel`
   *  /nocturne's By-key view serves. */
  keys: RdKeyPanelView;
  /** The selected slot's macro lifecycle rows — `compose_macro_rows` on
   *  the wire, this page's own edit doors. */
  macros_head: string;
  macro_rows: RdMacroRowView[];
  macros_note: string;
  /** The macro STEP EDITOR's whole projection when ?macro= names one —
   *  `NocturneMacroEditor` on the wire (closed otherwise). */
  mac: RdMacroEditorView;
  /** The short server-held undo window after a ✕ removal. */
  undo_cls: string;
  undo_label: string;
}

/** One macro lifecycle row — `NocturneMacroRow` on the wire. */
/** The macro step editor's served projection — `NocturneMacroEditor` on
 *  the wire, consumed whole by the redesign-macro-editor module. */
export type RdMacroEditorView = RdMacView;

/** One plate cell — `NocturneKeyCell` on the wire (snapshot.rs). */
export interface RdKeyCellView {
  cap: string;
  key: string;
  cls: string;
  short: string;
  title: string;
  aria: string;
  disabled: boolean;
  tab: string;
  aria_hidden: string;
  style: string;
}

/** One legend chip — `NocturneLegendRow` on the wire. */
export interface RdLegendRowView {
  slot: string;
  badge: string;
  name: string;
  cls: string;
}

/** The keyboard widget's serving — `BoardPanel` on the wire, the same
 *  struct /nocturne's plate destructures. */
export interface RdBoardPanel {
  source?: string;
  source_revision?: string;
  source_preset?: string;
  kb_title: string;
  kb_cls: string;
  board_case_style: string;
  board_origin: string;
  board_line: string;
  board_rows: RdChoiceRowView[];
  kb_row1: RdKeyCellView[];
  kb_row2: RdKeyCellView[];
  kb_row3: RdKeyCellView[];
  kb_row4: RdKeyCellView[];
  kb_row5: RdKeyCellView[];
  kb_row6: RdKeyCellView[];
  kb_tray: RdKeyCellView[];
  kb_tray_head: string;
  kb_tray_cls: string;
  legend: RdLegendRowView[];
  solo_label: string;
  kb_more_cls: string;
  kb_note: string;
}

/** The payload the server embeds and /api/redesign serves — seeded into the
 *  signals by the entry BEFORE the island returns (ledger #5). */
export interface RedesignPayload {
  /** Stable source identity. Fixture generation is used only to expire
   * redesign-owned browser chrome after a synthetic reseed. */
  environment_id: string;
  environment_generation: string;
  environment_fixture: boolean;
  environment_label: string;
  environment_cls: string;
  /** The Studio build serving this document, for support screenshots. */
  studio_version: string;
  /** Server-resolved exact authoring source. It is inspector context only. */
  source?: string;
  theme_rows: RdChoiceRowView[];
  devices: RdDeviceRows;
  controllers: RdControllers;
  board: RdBoardPanel;
  /** The staged input's capture behaviour — `compose_capture_rows` on the
   *  wire (freeze / split / take nothing, the current answer marked). */
  capture_rows: RdChoiceRowView[];
  capture_note: string;
  /** The staged input's verified Windows identity — the mapper's source
   *  pin (empty = refuse to arm, the fail-closed rule). */
  learn_selector: string;
  learn_instance: string;
  /** Draft, durable configuration, and running-session truth for the
   * operational shell. Kept as one namespaced seam so the next Library
   * payload can remain on-demand instead of bloating the canvas poll. */
  operations?: RdOperationalState;
  /** Exact input preparation and machine-keyed held-device recovery. */
  capture?: RdCaptureState;
  /** The required four-stop product journey: input -> controllers -> map ->
   * Play. Advanced surface authoring is deliberately not a gate. */
  journey?: RdJourneyState;
}

export interface RdActionState {
  label: string;
  allowed: boolean;
  reason: string;
  visible?: boolean;
}

export interface RdActiveSessionView {
  elapsed: string;
  input: string;
  outputs: string;
  escape_hatch: string;
  stage_revision?: string;
}

export interface RdSessionView {
  reachable: boolean;
  running: boolean;
  line: string;
  profile?: string | null;
  origin: "unknown" | "config" | "staged" | string;
  active?: RdActiveSessionView | null;
}

export interface RdOperationalState {
  draft_label: string;
  draft_detail: string;
  draft_dirty?: boolean;
  draft_empty?: boolean;
  draft_revision?: string;
  active_stage_revision?: string;
  saved_label: string;
  saved_detail: string;
  session: RdSessionView;
  session_cls: string;
  escape_line: string;
  save: RdActionState;
  play: RdActionState;
  apply: RdActionState;
  stop: RdActionState;
  adopt: RdActionState;
  discard: RdActionState;
}

export interface RdHeldCaptureRow {
  /** Opaque, server-authored identity; selector/instance may both be absent. */
  key: string;
  name: string;
  transport: string;
  detail: string;
  selector: string;
  instance: string;
  can_release: boolean;
  note: string;
  /** SSR/client presentation fields projected from the authoritative row. */
  summary?: string;
  disabled?: boolean;
}

export interface RdCaptureState {
  mode: string;
  /** Server-authored exact selected/held device identity for compact alerts. */
  device_label: string;
  heading: string;
  line: string;
  recovery_line: string;
  selector: string;
  instance: string;
  can_prepare: boolean;
  can_release: boolean;
  held: RdHeldCaptureRow[];
  state_label: string;
  state_tone: string;
  attention_cls: string;
  attention_title: string;
  attention_line: string;
  attention_detail: string;
  attention_review_label: string;
  attention_retry_cls: string;
}

export interface RdJourneyRow {
  key: string;
  /** Stable UI destination. Never infer this from customer-facing copy. */
  action: string;
  title: string;
  detail: string;
  badge: string;
  cls: string;
  aria_current: string;
}

export interface RdJourneyState {
  line: string;
  compact?: string;
  rows: RdJourneyRow[];
}

// ── SERVED signals — copiers, never derivers ────────────────────────────────

const [rdEnvCls, setRdEnvCls] = createSignal("n-environment unknown");
const [rdEnvFullText, setRdEnvFullText] = createSignal("ENVIRONMENT UNKNOWN");
const [rdEnvCompactText, setRdEnvCompactText] = createSignal("UNKNOWN");
const [rdEnvAccessibleText, setRdEnvAccessibleText] = createSignal("Environment unknown");
const [rdStudioVersion, setRdStudioVersion] = createSignal("");
const [rdThemeRows, setRdThemeRows] = createSignal<RdRenderedChoiceRow[]>([]);
const [rdCompactThemeRows, setRdCompactThemeRows] = createSignal<RdRenderedChoiceRow[]>([]);
const [rdDevKb, setRdDevKb] = createSignal<RdDeviceRowView[]>([]);
const [rdDevEnc, setRdDevEnc] = createSignal<RdDeviceRowView[]>([]);
const [rdDevExp, setRdDevExp] = createSignal<RdDeviceRowView[]>([]);
const [rdDevOther, setRdDevOther] = createSignal<RdOtherRowView[]>([]);
const [rdDevScanLine, setRdDevScanLine] = createSignal("");

/** The compact rail must name demo data instead of collapsing provenance to
 * an unlabeled dot. The source label remains in the tooltip for diagnostics,
 * while the visible fixture wording answers the product question directly. */
function setRdEnvironmentPresentation(label: string, className: string): void {
  const tokens = className.split(/\s+/);
  if (tokens.includes("fixture")) {
    const source = label.trim();
    setRdEnvFullText("DEMO DATA · NO HARDWARE");
    setRdEnvCompactText("DEMO");
    setRdEnvAccessibleText(
      `${source ? `${source} — ` : ""}synthetic demo data; no physical devices are read or written.`,
    );
  } else {
    const source = label || "Environment unknown";
    setRdEnvFullText(label || "ENVIRONMENT UNKNOWN");
    setRdEnvCompactText(tokens.includes("live") ? "LIVE" : "UNKNOWN");
    setRdEnvAccessibleText(source);
  }
}
const [rdDevKbHead, setRdDevKbHead] = createSignal("");
const [rdDevKbFoldCls, setRdDevKbFoldCls] = createSignal("n-devfold none");
const [rdDevEncHead, setRdDevEncHead] = createSignal("");
const [rdDevEncFoldCls, setRdDevEncFoldCls] = createSignal("n-devfold none");
const [rdDevExpHead, setRdDevExpHead] = createSignal("");
const [rdDevExpFoldCls, setRdDevExpFoldCls] = createSignal("n-devfold none");
const [rdDevOtherHead, setRdDevOtherHead] = createSignal("");
const [rdDevOtherFoldCls, setRdDevOtherFoldCls] = createSignal("n-devfold none");
const [rdCtrlPersonas, setRdCtrlPersonas] = createSignal<RdPersonaRowView[]>([]);
// The keyboard widget's served slots (the nocturne plate's own signal set).
const [rdKbRow1, setRdKbRow1] = createSignal<RdKeyCellView[]>([]);
const [rdKbRow2, setRdKbRow2] = createSignal<RdKeyCellView[]>([]);
const [rdKbRow3, setRdKbRow3] = createSignal<RdKeyCellView[]>([]);
const [rdKbRow4, setRdKbRow4] = createSignal<RdKeyCellView[]>([]);
const [rdKbRow5, setRdKbRow5] = createSignal<RdKeyCellView[]>([]);
const [rdKbRow6, setRdKbRow6] = createSignal<RdKeyCellView[]>([]);
const [rdKbTray, setRdKbTray] = createSignal<RdKeyCellView[]>([]);
const [rdKbLegend, setRdKbLegend] = createSignal<RdLegendRowView[]>([]);
const [rdKbTitle, setRdKbTitle] = createSignal("");
const [rdKbCls, setRdKbCls] = createSignal("n-kb");
const [rdBoardCaseStyle, setRdBoardCaseStyle] = createSignal("");
const [rdBoardOrigin, setRdBoardOrigin] = createSignal("");
const [rdKbTrayHead, setRdKbTrayHead] = createSignal("");
const [rdKbTrayCls, setRdKbTrayCls] = createSignal("n-kbtray none");
const [rdKbNote, setRdKbNote] = createSignal("");
const [rdKbMoreCls, setRdKbMoreCls] = createSignal("n-lgdmore none");
const [rdSoloLbl, setRdSoloLbl] = createSignal("Only this player");
// The staged input's capture behaviour (freeze / split / take nothing).
const [rdCaptureRows, setRdCaptureRows] = createSignal<RdChoiceRowView[]>([]);
const [rdCaptureNote, setRdCaptureNote] = createSignal("");
// The operational shell is server-owned truth in three independent state
// machines: draft/durable config, running session, and exact-device capture.
// Keeping them separate avoids the legacy `dirty === needs Apply` mistake.
const [rdOpDraftLabel, setRdOpDraftLabel] = createSignal("New draft");
const [rdOpDraftDetail, setRdOpDraftDetail] = createSignal("");
const [rdOpSavedLabel, setRdOpSavedLabel] = createSignal("Nothing saved yet");
const [rdOpSavedDetail, setRdOpSavedDetail] = createSignal("");
const [rdOpSessionLine, setRdOpSessionLine] = createSignal("Session status unavailable");
const [rdOpSessionCls, setRdOpSessionCls] = createSignal("rd-session-state down");
const [rdOpSessionBadge, setRdOpSessionBadge] = createSignal("Status unavailable");
const [rdOpSessionBadgeState, setRdOpSessionBadgeState] = createSignal("attention");
const [rdOpEscapeLine, setRdOpEscapeLine] = createSignal("");
const [rdDraftDirty, setRdDraftDirty] = createSignal(false);
const [rdDraftRevision, setRdDraftRevision] = createSignal("");
const [rdDiscardConfirmCls, setRdDiscardConfirmCls] = createSignal("rd-danger-confirm none");

const [rdSaveLabel, setRdSaveLabel] = createSignal("Save");
const [rdSaveDisabled, setRdSaveDisabled] = createSignal(true);
const [rdSaveReason, setRdSaveReason] = createSignal("Finish the setup before saving.");
const [rdPlayLabel, setRdPlayLabel] = createSignal("Play");
const [rdPlayDisabled, setRdPlayDisabled] = createSignal(true);
const [rdPlayReason, setRdPlayReason] = createSignal("Finish the setup before Play.");
const [rdPlayCls, setRdPlayCls] = createSignal("rd-runform");
const [rdApplyLabel, setRdApplyLabel] = createSignal("Apply changes");
const [rdApplyDisabled, setRdApplyDisabled] = createSignal(true);
const [rdApplyReason, setRdApplyReason] = createSignal("Nothing is running.");
const [rdApplyCls, setRdApplyCls] = createSignal("rd-runform none");
const [rdStopLabel, setRdStopLabel] = createSignal("Stop");
const [rdStopDisabled, setRdStopDisabled] = createSignal(true);
const [rdStopReason, setRdStopReason] = createSignal("Nothing is running.");
const [rdStopCls, setRdStopCls] = createSignal("rd-runform none");
const [rdReplacePlayCls, setRdReplacePlayCls] = createSignal("rd-panel-replace none");
const [rdAdoptLabel, setRdAdoptLabel] = createSignal("Load saved setup");
const [rdAdoptDisabled, setRdAdoptDisabled] = createSignal(true);
const [rdAdoptReason, setRdAdoptReason] = createSignal("There is no saved setup to load.");
const [rdDiscardLabel, setRdDiscardLabel] = createSignal("Start over");
const [rdDiscardDisabled, setRdDiscardDisabled] = createSignal(true);
const [rdDiscardReason, setRdDiscardReason] = createSignal("This draft is already empty.");

const [rdJourneyLine, setRdJourneyLine] = createSignal("Pick an input to begin.");
const [rdJourneyCompact, setRdJourneyCompact] = createSignal("Setup · 0/4");
const [rdJourneyRows, setRdJourneyRows] = createSignal<RdJourneyRow[]>([]);

const [rdCaptureMode, setRdCaptureMode] = createSignal("none");
const [rdCaptureDeviceLabel, setRdCaptureDeviceLabel] = createSignal("");
const [rdCaptureStateLabel, setRdCaptureStateLabel] = createSignal("No input");
const [rdCaptureStateTone, setRdCaptureStateTone] = createSignal("stopped");
const [rdCaptureAttentionCls, setRdCaptureAttentionCls] = createSignal("rd-attention none");
const [rdCaptureAttentionTitle, setRdCaptureAttentionTitle] = createSignal("");
const [rdCaptureAttentionLine, setRdCaptureAttentionLine] = createSignal("");
const [rdCaptureAttentionDetail, setRdCaptureAttentionDetail] = createSignal("");
const [rdCaptureAttentionReviewLabel, setRdCaptureAttentionReviewLabel] = createSignal("Review recovery");
const [rdCaptureAttentionRetryCls, setRdCaptureAttentionRetryCls] = createSignal("rd-panel-action rd-attention-retry none");
const [rdCaptureHeading, setRdCaptureHeading] = createSignal("No input selected");
const [rdCaptureLine, setRdCaptureLine] = createSignal("Pick the input this setup will listen to.");
const [rdCaptureRecoveryLine, setRdCaptureRecoveryLine] = createSignal("");
const [rdCaptureSelector, setRdCaptureSelector] = createSignal("");
const [rdCaptureInstance, setRdCaptureInstance] = createSignal("");
const [rdCapturePrepareCls, setRdCapturePrepareCls] = createSignal("rd-capture-prepare none");
const [rdCaptureHeldCls, setRdCaptureHeldCls] = createSignal("rd-held-recovery none");
const [rdCaptureHeld, setRdCaptureHeld] = createSignal<RdHeldCaptureRow[]>([]);
const [rdCtrlAddNote, setRdCtrlAddNote] = createSignal("");
const [rdCtrlCountsLine, setRdCtrlCountsLine] = createSignal("");
const [rdCtrlAddPreset, setRdCtrlAddPreset] = createSignal("");
const [rdCtrlAddLayout, setRdCtrlAddLayout] = createSignal("");
const [rdCtrlAddSource, setRdCtrlAddSource] = createSignal("");
const [rdCtrlAddSourceRevision, setRdCtrlAddSourceRevision] = createSignal("");
// The macro editor remains client-managed after adoption, but an open ?macro=
// URL must paint the SAME dialog before hydration. The renderer inserts the
// escaped children into the marked empty host; this island serves its class,
// and the editor module adopts the tree before owning later draft repaints.
const [rdMacHolderCls, setRdMacHolderCls] = createSignal("rd-macdlg nd-back none");
/** The served card list, held for the canvas reconciler — cards are canvas
 *  widgets, not a template list, so this is plain data, not a signal. */
let rdCtrlCards: RdControllerCardView[] = [];
/** The ghost ids the server still holds parked material for — plain data
 *  for the same reason. */
let rdCtrlParkedHeld: string[] = [];
/** The served pad dressing rows, keyed to the cards by slot — plain data
 *  (the canvas reconciler consumes them, no template list). */
let rdCtrlPads: RdPadView[] = [];
/** The selected controller's served panel — plain data (the inspector body
 *  is client-painted, renderInspector's own pattern). */
let rdCtrlPanel: RdPanelView | null = null;
/** The Keys tab's served rows — plain data for the same reason. */
let rdCtrlKeys: RdKeyPanelView | null = null;
/** The selected slot's macro section + the step editor's projection. */
let rdCtrlMacrosHead = "Macros";
let rdCtrlMacroRows: RdMacroRowView[] = [];
let rdCtrlMacrosNote = "";
let rdCtrlMac: RdMacroEditorView | null = null;
/** The staged input's verified identity — the mapper's source pin. */
let rdLearnSource = { selector: "", instance: "" };
/** Full operational facts for the live-feed license and entry-level action
 * coordinator. Canvas markup consumes signals; protocol-sensitive clients
 * read this immutable served object instead of parsing labels or classes. */
let rdOperations: RdOperationalState | null = null;

export function redesignOperationalState(): RdOperationalState | null {
  return rdOperations;
}

/** Product availability after the page-wide mutation lock releases. Dynamic
 * `data-*` mirrors cannot be emitted faithfully by Forma SSR, so the entry
 * asks the same served state the buttons render from. `undefined` leaves
 * older widget-specific dataset contracts in charge. */
export function redesignFormProductDisabled(form: HTMLFormElement): boolean | undefined {
  const kind = form.dataset.rdForm ?? "";
  const action = kind === "play-replace" ? "play" : kind;
  if (
    action === "save" || action === "play" || action === "apply" ||
    action === "stop" || action === "adopt" || action === "discard"
  ) {
    const state = rdOperations?.[action];
    return state ? state.allowed !== true : true;
  }
  if (kind === "capture-prepare") {
    return rdCapturePrepareCls().includes("none");
  }
  if (kind === "capture-release") {
    const selector = (form.elements.namedItem("expected_selector") as HTMLInputElement | null)
      ?.value ?? "";
    const instance = (form.elements.namedItem("instance_id") as HTMLInputElement | null)
      ?.value ?? "";
    const row = rdCaptureHeld().find(
      (candidate) => candidate.selector === selector &&
        candidate.instance.toLowerCase() === instance.toLowerCase(),
    );
    return row ? !row.can_release : true;
  }
  return undefined;
}
export function redesignLearnSource(): { selector: string; instance: string } {
  const selector = currentAuthoringSource();
  const row = selector ? deviceRowFor(selector) : null;
  if (row?.aria_current === "true") {
    return { selector: row.selector, instance: row.instance_id?.trim() ?? "" };
  }
  // Older payloads expose only the compatibility source pair. Preserve that
  // narrow fallback when no source-qualified context exists at all.
  return selector ? { selector: "", instance: "" } : rdLearnSource;
}
/** The mapper's ports onto the served truth (always the CURRENT arrays —
 *  re-read after every refresh, never captured). */
export function redesignPads(): RdPadView[] {
  return rdCtrlPads;
}
export function redesignSelectedSlot(): string {
  return rdCtrlPanel?.slot_val ?? "";
}
export function redesignControlsFor(
  slot: string,
): { function: string; label: string; keys: string[] }[] {
  const pad = rdCtrlPads.find((candidate) => String(candidate.slot) === slot);
  const source = pad?.sources?.find(
    (candidate) => candidate.source_id === currentAuthoringSource(),
  );
  return (source?.controls ?? pad?.controls ?? []).map((control) => ({
    function: control.function,
    label: control.label,
    keys: control.keys,
  }));
}

// ── The mapping cords: key → (macro) → control, drawn in world space ─────
// One MappingFlowLayer owns the product geometry contract; this page provides
// its four layers, the Paths control, and
// the processor-offset store in its own canvasPrefs.
let mappingFlowLayer: MappingFlowLayer | null = null;

function processorOffsetFor(id: string): { x: number; y: number } | undefined {
  return canvasPrefs.processorOffsets?.[id];
}

function commitProcessorOffset(id: string, offset: { x: number; y: number } | null): boolean {
  const offsets = { ...(canvasPrefs.processorOffsets ?? {}) };
  if (offset) offsets[id] = offset;
  else delete offsets[id];
  canvasPrefs = { ...canvasPrefs, processorOffsets: offsets };
  return saveCanvasPrefs();
}

/** Re-derive the cord graph from the served pads (mode + selected slot are
 *  page state). Cheap: the layer fingerprints and skips no-op sets. */
function syncMappingCords(): void {
  const mode = canvasPrefs.mappingPaths ?? "off";
  const selectedSlot = Number(rdCtrlPanel?.slot_val || "0");
  mappingFlowLayer?.setGraph(
    (rdCtrlPads as unknown as MappingFlowPad[]) ?? [],
    mode,
    selectedSlot,
  );
  const select = rdRoot?.querySelector<HTMLSelectElement>('[data-nx="rd-mapping-paths"]');
  if (select && select.value !== mode) select.value = mode;
}

/** Frame-rate live feedback reaches the mapping layer through one narrow
 * imperative port. The lifecycle entry owns the EventSource; the island owns
 * the graph, so neither module needs to know the other's implementation. */
export function redesignSetLivePaths(
  keysDown: ReadonlySet<string>,
  keyHits: ReadonlySet<string>,
  slotFunctionsDown: ReadonlyMap<number, ReadonlySet<string>>,
  slotFunctionHits: ReadonlyMap<number, ReadonlySet<string>>,
): void {
  mappingFlowLayer?.setLive(keysDown, keyHits, slotFunctionsDown, slotFunctionHits);
}

function setMappingPathMode(mode: MappingPathMode): void {
  if (!mappingPathModeIsValid(mode)) return;
  canvasPrefs = { ...canvasPrefs, mappingPaths: mode };
  saveCanvasPrefs();
  syncMappingCords();
}

/** The cords' count line — the layer's layout summary, painted onto the
 *  Paths control's output (nocturne's paintMappingFlowCount, trimmed to
 *  this page's chrome). */
function paintMappingCordCount(summary: import("./mappingFlow").MappingFlowLayoutSummary): void {
  const out = rdRoot?.querySelector<HTMLElement>(".rd-pathcount");
  if (!out) return;
  const mode = canvasPrefs.mappingPaths ?? "off";
  if (mode === "off" || summary.total === 0) {
    out.textContent = "";
    out.title = "Mapping paths are off";
    return;
  }
  const unresolved = summary.unresolved > 0 ? ` · ${summary.unresolved} off-screen` : "";
  out.textContent = `${summary.total}`;
  out.title = `${summary.total} mapping path${summary.total === 1 ? "" : "s"} drawn${unresolved}`;
}

/** The step editor follows the served `mac` projection. This slice only
 *  guards the door (the editor itself is the next migration): a served
 *  OPEN mac with no dialog on this page yet closes itself back through the
 *  URL rather than pretending. */
function syncMacroDialog(): void {
  // The editor module owns the dialog: the served projection goes to it
  // whole, and THE DRAFT WINS over a background poll (its own dirty guard).
  if (rdCtrlMac) applyRdMacPayload(rdCtrlMac);
}
/** Which reading the inspector shows (4460's Controls|Keys pair), kept per
 *  browser like the nocturne UI store. */
const RD_UI_STORE = "ksx-redesign-ui";
const RD_CONTROLLER_COLOR_STORE = "ksx-redesign-controller-colors1";
const RD_STATE_PROVENANCE_STORE = "ksx-redesign-state-provenance1";
interface RdStateProvenance {
  environmentId: string;
  generation: string;
  fixture: boolean;
}
type RdStateProvenanceIndex = Record<string, RdStateProvenance>;
let activeEnvironment: RdStateProvenance | null = null;
let redesignPersistenceSuspended = false;

function readRedesignStateProvenance(): RdStateProvenanceIndex {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(RD_STATE_PROVENANCE_STORE) ?? "{}",
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        const row = value as Partial<RdStateProvenance> | null;
        return typeof row === "object" && row !== null &&
          typeof row.environmentId === "string" &&
          typeof row.generation === "string" && typeof row.fixture === "boolean";
      }),
    ) as RdStateProvenanceIndex;
  } catch {
    return {};
  }
}

/** Decide before a write. A fixture may persist state it created, but it may
 * never mutate an existing unmarked store or one owned by a real machine;
 * those changes stay in this document's in-memory preferences only. */
function redesignStorePersistenceAllowed(store: string): boolean {
  if (redesignPersistenceSuspended) return false;
  const environment = activeEnvironment;
  if (!environment || !environment.fixture) return true;
  const provenance = readRedesignStateProvenance();
  const previous = provenance[store];
  return previous?.fixture === true ||
    (previous === undefined && window.localStorage.getItem(store) === null);
}

/** Stamp only after the store write succeeded. */
function markRedesignStore(store: string): void {
  const environment = activeEnvironment;
  if (!environment) return;
  try {
    const provenance = readRedesignStateProvenance();
    provenance[store] = environment;
    window.localStorage.setItem(RD_STATE_PROVENANCE_STORE, JSON.stringify(provenance));
  } catch {
    // Storage-blocked state cannot become stale across a browser restart.
  }
}

let inspTab: InspectorTab = "controls";
try {
  const saved = JSON.parse(window.localStorage.getItem(RD_UI_STORE) ?? "{}") as {
    inspTab?: string;
  };
  inspTab = saved.inspTab === "keys" ? "keys" : "controls";
} catch {
  inspTab = "controls";
}
function setInspTab(next: InspectorTab): void {
  inspTab = next;
  saveKbUi();
  renderInspector();
}
/** A control the next Controls render should open and show — set by a
 *  click on the pad art's own zone (the 4460 pointer enhancement) or by a
 *  Keys-row jump. */
let pendingLocateFns: string | null = null;
/** A KEY the next Keys render should reveal — set by a click on a plate
 *  cell (the board is the Keys tab's own picture). */
let pendingLocateKey: string | null = null;
/** Inspector repaint memoization is client state, not document state. A
 * WeakMap keeps it off the served container so hydration parity can continue
 * asserting every attribute on that client-populated subtree. */
const inspectorRenderFingerprints = new WeakMap<HTMLElement, string>();

// ── The keyboard lens: mute chips, the solo shortcut, the finish ──────────
// The crossings share 4460's store (a crossing belongs to the CONTROLLER,
// keyed by preset, and follows it across pages); solo and the finish are
// this page's own view preferences in RD_UI_STORE.
const KB_STRIPS_STORE = "ksx-nocturne-strips2";
let kbHiddenStrips = new Set<string>();
try {
  const raw = window.localStorage.getItem(KB_STRIPS_STORE);
  kbHiddenStrips = new Set(raw ? (JSON.parse(raw) as string[]) : []);
} catch {
  kbHiddenStrips = new Set();
}
function saveKbStrips(): void {
  try {
    if (!redesignStorePersistenceAllowed(KB_STRIPS_STORE)) return;
    window.localStorage.setItem(KB_STRIPS_STORE, JSON.stringify([...kbHiddenStrips]));
    markRedesignStore(KB_STRIPS_STORE);
  } catch {
    // A crossing is chrome; blocked storage only makes it temporary.
  }
}
let kbSolo = false;
let kbTheme = "carbon-forge";
let controllerColors: Record<string, number> = {};
try {
  const saved = JSON.parse(window.localStorage.getItem(RD_UI_STORE) ?? "{}") as {
    kbSolo?: boolean;
    kbTheme?: string;
  };
  kbSolo = saved.kbSolo === true;
  if (typeof saved.kbTheme === "string" && saved.kbTheme) kbTheme = saved.kbTheme;
  const colors = JSON.parse(
    window.localStorage.getItem(RD_CONTROLLER_COLOR_STORE) ?? "{}",
  ) as Record<string, unknown>;
  controllerColors = Object.fromEntries(
    Object.entries(colors).filter(
      ([preset, color]) => preset.trim() !== "" && Number.isInteger(color) &&
        Number(color) >= 1 && Number(color) <= 16,
    ),
  ) as Record<string, number>;
} catch {
  // defaults hold
}

function saveControllerColors(): void {
  try {
    if (!redesignStorePersistenceAllowed(RD_CONTROLLER_COLOR_STORE)) return;
    window.localStorage.setItem(
      RD_CONTROLLER_COLOR_STORE,
      JSON.stringify(controllerColors),
    );
    markRedesignStore(RD_CONTROLLER_COLOR_STORE);
  } catch {
    // A presentation preference may remain session-only when storage is blocked.
  }
}
function saveKbUi(): void {
  try {
    if (!redesignStorePersistenceAllowed(RD_UI_STORE)) return;
    const saved = JSON.parse(window.localStorage.getItem(RD_UI_STORE) ?? "{}") as Record<
      string,
      unknown
    >;
    saved.kbSolo = kbSolo;
    saved.kbTheme = kbTheme;
    saved.inspTab = inspTab;
    window.localStorage.setItem(RD_UI_STORE, JSON.stringify(saved));
    markRedesignStore(RD_UI_STORE);
  } catch {
    // chrome only
  }
}
function presetOfSlotRd(slot: number): string | undefined {
  return rdCtrlCards.find((card) => card.number === String(slot))?.preset;
}

/** The finish system's established twin-preset identity rule, kept local so
 * colors and finishes make the same best-possible choice from the served
 * data: first occurrence is p:preset, later twins are #2/#3 in slot order. */
function controllerColorStoreKeys(
  cards: readonly RdControllerCardView[],
): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const card of [...cards].sort(
    (left, right) => Number(left.number) - Number(right.number),
  )) {
    const occurrence = (seen.get(card.preset) ?? 0) + 1;
    seen.set(card.preset, occurrence);
    keys.set(
      card.number,
      `p:${card.preset}${occurrence > 1 ? `#${occurrence}` : ""}`,
    );
  }
  return keys;
}

function controllerColorStoreKey(slot: number): string | undefined {
  return controllerColorStoreKeys(rdCtrlCards).get(String(slot));
}

const CONTROLLER_COLOR_NAMES = [
  "N64 red",
  "Hedgehog blue",
  "Xbox green",
  "Puck yellow",
  "Hunter orange",
  "GameCube indigo",
  "CRT grey",
  "Famicom maroon",
  "Arcade pink",
  "Atari wood",
  "Rival purple",
  "Dino lime",
  "Space navy",
  "Void blue",
  "Ice white",
  "Phazon teal",
] as const;

/** Resolve controller identity colors in served seat order. Saved identity
 * follows the preset through a reorder; a duplicated/corrupt collision gives
 * the earlier live seat priority and deterministically repairs the other.
 * With at most 16 staged seats, every live controller remains distinct. */
function resolvedControllerColors(): Map<string, number> {
  const resolved = new Map<string, number>();
  const claimed = new Set<number>();
  const ordered = [...rdCtrlCards].sort(
    (left, right) => Number(left.number) - Number(right.number),
  );
  const storeKeys = controllerColorStoreKeys(ordered);
  const unresolved: { card: RdControllerCardView; key: string }[] = [];
  let changed = false;

  for (const card of ordered) {
    const key = storeKeys.get(card.number) ?? `p:${card.preset}`;
    const saved = controllerColors[key];
    if (Number.isInteger(saved) && saved >= 1 && saved <= 16 && !claimed.has(saved)) {
      resolved.set(key, saved);
      claimed.add(saved);
    } else {
      unresolved.push({ card, key });
    }
  }
  for (const { card, key } of unresolved) {
    const seat = Math.max(1, Number(card.number) || 1);
    const preferred = ((seat - 1) % CONTROLLER_COLOR_NAMES.length) + 1;
    let color = preferred;
    for (let offset = 0; offset < CONTROLLER_COLOR_NAMES.length; offset += 1) {
      const candidate = ((preferred - 1 + offset) % CONTROLLER_COLOR_NAMES.length) + 1;
      if (!claimed.has(candidate)) {
        color = candidate;
        break;
      }
    }
    resolved.set(key, color);
    claimed.add(color);
    if (controllerColors[key] !== color) {
      controllerColors[key] = color;
      changed = true;
    }
  }
  if (changed) saveControllerColors();
  return resolved;
}

/** Paint the seat-indexed CSS variables from preset-indexed identity. The
 * controller art, its badge and the keyboard ownership wash all consume the
 * same `--pcsN` family, so one choice changes every representation together. */
function applyControllerIdentityColors(): void {
  const root = rdRoot;
  if (!root) return;
  const resolved = resolvedControllerColors();
  for (let slot = 1; slot <= CONTROLLER_COLOR_NAMES.length; slot += 1) {
    root.style.removeProperty(`--pcs${slot}`);
    root.style.removeProperty(`--pcs${slot}-ink`);
    root.style.removeProperty(`--pcs${slot}-key`);
  }
  for (const card of rdCtrlCards) {
    const slot = Number(card.number);
    const key = controllerColorStoreKey(slot);
    const color = key ? resolved.get(key) : undefined;
    if (!Number.isInteger(slot) || slot < 1 || slot > 16 || color === undefined) continue;
    root.style.setProperty(`--pcs${slot}`, `var(--pal${color})`);
    root.style.setProperty(`--pcs${slot}-ink`, `var(--pal${color}-ink)`);
    root.style.setProperty(`--pcs${slot}-key`, `var(--pal${color}-key)`);
  }
}

function controllerIdentityColorEditor(slot: number): HTMLElement {
  const section = document.createElement("section");
  section.className = "rd-controller-color";
  section.setAttribute("aria-labelledby", `rd-controller-color-title-${slot}`);
  const heading = document.createElement("div");
  heading.className = "rd-controller-color-head";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.id = `rd-controller-color-title-${slot}`;
  title.textContent = "Identity color";
  const note = document.createElement("p");
  note.textContent = "Follows this controller if its player seat changes.";
  copy.append(title, note);
  const grid = document.createElement("div");
  grid.className = "rd-controller-color-grid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `Choose Player ${slot} identity color`);
  const identity = controllerColorStoreKey(slot) ?? "";
  const resolved = resolvedControllerColors();
  const selected = resolved.get(identity) ?? slot;
  const owners = new Map<number, RdControllerCardView>();
  for (const card of rdCtrlCards) {
    const key = controllerColorStoreKey(Number(card.number));
    const color = key ? resolved.get(key) : undefined;
    if (color !== undefined) owners.set(color, card);
  }
  for (let color = 1; color <= CONTROLLER_COLOR_NAMES.length; color += 1) {
    const owner = owners.get(color);
    const ownerIdentity = owner ? controllerColorStoreKey(Number(owner.number)) : undefined;
    const usedElsewhere = owner !== undefined && ownerIdentity !== identity;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rd-controller-swatch${color === selected ? " selected" : ""}${usedElsewhere ? " used" : ""}`;
    button.dataset.nx = "rd-controller-color";
    button.dataset.slot = String(slot);
    button.dataset.color = String(color);
    button.style.setProperty("--rd-controller-swatch", `var(--pal${color})`);
    button.setAttribute("aria-pressed", String(color === selected));
    if (usedElsewhere) button.setAttribute("aria-disabled", "true");
    const ownerText = usedElsewhere ? `, used by Player ${owner.number}` : "";
    button.setAttribute(
      "aria-label",
      `${CONTROLLER_COLOR_NAMES[color - 1]}${color === selected ? ", selected" : ""}${ownerText}`,
    );
    button.title = `${CONTROLLER_COLOR_NAMES[color - 1]}${ownerText}`;
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    button.append(dot);
    grid.append(button);
  }
  heading.append(copy);
  section.append(heading, grid);
  return section;
}

function controllerSourceEditor(slot: number): HTMLElement | null {
  const pad = rdCtrlPads.find((candidate) => candidate.slot === slot);
  const sources = pad?.sources ?? [];
  if (sources.length === 0) return null;
  const section = document.createElement("section");
  section.className = "rd-controller-sources";
  const title = document.createElement("h3");
  title.textContent = "Input mappings";
  const note = document.createElement("p");
  note.textContent = "Choose the exact device whose routes you are editing. Every source remains independent and available.";
  const tabs = document.createElement("div");
  tabs.className = "rd-controller-source-tabs";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", `Input mappings for Player ${slot}`);
  const current = currentAuthoringSource();
  for (const source of sources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "n-autobtn rd-controller-source";
    button.dataset.nx = "rd-source-authoring";
    button.dataset.selector = source.source_id;
    const selected = source.source_id === current;
    button.setAttribute("aria-pressed", String(selected));
    if (selected) button.classList.add("on");
    const label = controllerSourceLabel(source, sources);
    button.textContent = `${label}${source.routed ? "" : " · not routed"}`;
    button.title = source.routed
      ? `Edit ${label}'s independent mappings to Player ${slot}`
      : `Start ${label}'s first mapping to Player ${slot}`;
    tabs.append(button);
  }
  section.append(title, note, tabs);
  return section;
}

/** Paint the mute/solo lens and the finish. The nocturne CSS drives the
 *  same effect through `.n-center.muteN` classes; here the identical
 *  custom properties are written inline on the plate — one mechanism, no
 *  second sheet. Solo mutes every band and hands the selected controller
 *  its color back (nothing is hidden, so a key never looks unbound). */
function syncKbLens(): void {
  const root = rdRoot;
  if (!root) return;
  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".rd-keyboard-device-node"),
  )) {
    item.setAttribute("data-keyboard-theme", kbTheme);
  }
  for (const surface of Array.from(
    root.querySelectorAll<HTMLElement>(KEYBOARD_SURFACE_SELECTOR),
  )) {
    const kb = surface.querySelector<HTMLElement>(".n-kb");
    if (kb) {
      const selectedSlot = Number(rdCtrlPanel?.slot_val || "0");
      for (let n = 1; n <= 16; n += 1) {
        const preset = presetOfSlotRd(n);
        const muted = kbSolo
          ? n !== selectedSlot
          : preset !== undefined && kbHiddenStrips.has(preset);
        if (muted) kb.style.setProperty(`--kb${n}`, "var(--band-mute)");
        else kb.style.removeProperty(`--kb${n}`);
      }
    }
    // The chips speak their own state (nocturne's syncLegend wording).
    for (const chip of Array.from(
      surface.querySelectorAll<HTMLElement>('[data-nx="legend-mute"]'),
    )) {
      const preset = presetOfSlotRd(Number(chip.getAttribute("data-slot") ?? ""));
      const byHand = preset !== undefined && kbHiddenStrips.has(preset);
      const off = kbSolo ? !chip.classList.contains("on") : byHand;
      chip.setAttribute("aria-pressed", off ? "false" : "true");
      chip.classList.toggle("muted", !kbSolo && byHand);
      chip.title = off
        ? "Show this controller's color on the keys"
        : "Hide this controller's color on the keys";
    }
    surface
      .querySelector(".n-kbcolors")
      ?.setAttribute("aria-pressed", kbSolo ? "true" : "false");
    for (const button of Array.from(
      surface.querySelectorAll<HTMLElement>('[data-nx="kb-theme"]'),
    )) {
      button.setAttribute(
        "aria-pressed",
        String(button.getAttribute("data-keyboard-theme") === kbTheme),
      );
    }
  }
}

/** Open, reveal and pulse the row (or free chip) for one control inside the
 *  freshly painted panel body. Case-bridged: zones spell functions
 *  lowercase, the mapper may spell them UPPERCASE. */
function locateBindRow(body: HTMLElement, fns: string): void {
  const wanted = fns.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!wanted) return;
  const rows = Array.from(body.querySelectorAll<HTMLElement>("details.n-bind[data-fn]"));
  const row = rows.find((r) => (r.dataset.fn ?? "").toLowerCase() === wanted);
  const target =
    row ??
    Array.from(body.querySelectorAll<HTMLElement>(".n-ctlstrip [data-fn]")).find(
      (chip) => (chip.dataset.fn ?? "").toLowerCase() === wanted,
    );
  if (!target) return;
  if (target instanceof HTMLDetailsElement) target.open = true;
  target.scrollIntoView({ block: "center" });
  target.classList.add("rd-row-pulse");
  window.setTimeout(() => target.classList.remove("rd-row-pulse"), 1400);
}
// The removal-undo chip: SSR chrome (it must show without the inspector,
// exactly like nocturne's rack chip), so these two are signals with slots.
const [rdUndoCls, setRdUndoCls] = createSignal("rd-undochip none");
const [rdUndoLabel, setRdUndoLabel] = createSignal("");
let rdDeviceScanAuthoritative = false;
let rdStagingReachable = false;
let rdStagingLine = "";

// The action flash. The server fills these from the allowlisted query
// parameter on a full-page load; the fetch-submit layer applies the same
// copy here. A refresh is not an action and never touches them.
const [rdFlashLine, setRdFlashLine] = createSignal("");
const [rdFlashCls, setRdFlashCls] = createSignal("n-flash rd-flash none");

export function applyRedesign(v: RedesignPayload): void {
  if (reconcileRedesignEnvironment(v)) return;
  const deviceFocus = captureDeviceRowFocus();
  setRdEnvCls(v.environment_cls);
  setRdEnvironmentPresentation(v.environment_label, v.environment_cls);
  setRdStudioVersion(v.studio_version || "unknown");
  const operations = v.operations;
  rdOperations = operations ?? null;
  setRdOpDraftLabel(operations?.draft_label ?? "New draft");
  setRdOpDraftDetail(operations?.draft_detail ?? "Pick an input to begin.");
  setRdOpSavedLabel(operations?.saved_label ?? "Nothing saved yet");
  setRdOpSavedDetail(operations?.saved_detail ?? "Save writes this draft for later.");
  setRdOpSessionLine(operations?.session?.line ?? "Session status unavailable");
  setRdOpSessionCls(`rd-session-state ${operations?.session_cls || "down"}`);
  setRdOpSessionBadge(
    operations?.session?.reachable !== true
      ? "Status unavailable"
      : operations.session.running
        ? "Playing"
        : "Stopped",
  );
  setRdOpSessionBadgeState(
    operations?.session?.reachable !== true
      ? "attention"
      : operations.session.running
        ? "playing"
        : "stopped",
  );
  setRdOpEscapeLine(operations?.escape_line ?? "");
  const draftDirty = operations?.draft_dirty === true;
  setRdDraftDirty(draftDirty);
  setRdDraftRevision(operations?.draft_revision ?? "");
  setRdDiscardConfirmCls(draftDirty ? "rd-danger-confirm" : "rd-danger-confirm none");

  const save = operations?.save;
  setRdSaveLabel(save?.label || "Save");
  setRdSaveDisabled(save?.allowed !== true);
  setRdSaveReason(save?.reason ?? "Finish the setup before saving.");
  const play = operations?.play;
  setRdPlayLabel(play?.label || "Play");
  setRdPlayDisabled(play?.allowed !== true);
  setRdPlayReason(play?.reason ?? "Finish the setup before Play.");
  setRdPlayCls(play?.visible === false ? "rd-runform rd-playform none" : "rd-runform rd-playform");
  const apply = operations?.apply;
  setRdApplyLabel(apply?.label || "Apply changes");
  setRdApplyDisabled(apply?.allowed !== true);
  setRdApplyReason(apply?.reason ?? "Nothing is running.");
  setRdApplyCls(
    apply?.visible === true || apply?.allowed === true
      ? "rd-runform rd-applyform"
      : "rd-runform rd-applyform none",
  );
  const stop = operations?.stop;
  setRdStopLabel(stop?.label || "Stop");
  setRdStopDisabled(stop?.allowed !== true);
  setRdStopReason(stop?.reason ?? "Nothing is running.");
  setRdStopCls(
    stop?.visible === true || operations?.session?.running === true
      ? "rd-runform rd-stopform"
      : "rd-runform rd-stopform none",
  );
  setRdReplacePlayCls(
    operations?.session?.running === true
      ? "rd-panel-replace"
      : "rd-panel-replace none",
  );
  const adopt = operations?.adopt;
  setRdAdoptLabel(adopt?.label || "Load saved setup");
  setRdAdoptDisabled(adopt?.allowed !== true);
  setRdAdoptReason(adopt?.reason ?? "There is no saved setup to load.");
  const discard = operations?.discard;
  setRdDiscardLabel(discard?.label || "Start over");
  setRdDiscardDisabled(discard?.allowed !== true);
  setRdDiscardReason(discard?.reason ?? "This draft is already empty.");

  const journey = v.journey;
  const journeyRows = journey?.rows ?? [];
  setRdJourneyRows(journeyRows);
  setRdJourneyLine(journey?.line ?? "Pick an input to begin.");
  const journeyDone = journeyRows.filter((row) => row.badge === "Done").length;
  const journeyNow = journeyRows.find((row) => row.badge === "Now" || row.badge === "Blocked");
  setRdJourneyCompact(
    journey?.compact ||
      `${journeyDone}/4 · ${operations?.session?.running ? "Playing" : journeyNow?.title ?? "Setup"}`,
  );

  const capture = v.capture;
  setRdCaptureMode(capture?.mode ?? "none");
  setRdCaptureDeviceLabel(capture?.device_label ?? "");
  setRdCaptureStateLabel(capture?.state_label ?? "No input");
  setRdCaptureStateTone(capture?.state_tone ?? "stopped");
  setRdCaptureAttentionCls(capture?.attention_cls ?? "rd-attention none");
  setRdCaptureAttentionTitle(capture?.attention_title ?? "");
  setRdCaptureAttentionLine(capture?.attention_line ?? "");
  setRdCaptureAttentionDetail(capture?.attention_detail ?? "");
  setRdCaptureAttentionReviewLabel(capture?.attention_review_label ?? "Review recovery");
  setRdCaptureAttentionRetryCls(
    capture?.attention_retry_cls ?? "rd-panel-action rd-attention-retry none",
  );
  setRdCaptureHeading(capture?.heading ?? "No input selected");
  setRdCaptureLine(capture?.line ?? "Pick the input this setup will listen to.");
  setRdCaptureRecoveryLine(capture?.recovery_line ?? "");
  setRdCaptureSelector(capture?.selector ?? "");
  setRdCaptureInstance(capture?.instance ?? "");
  setRdCapturePrepareCls(
    capture?.can_prepare === true ? "rd-capture-prepare" : "rd-capture-prepare none",
  );
  setRdCaptureHeld(
    (capture?.held ?? []).map((row) => ({
      ...row,
      summary: `${row.transport} · ${row.detail}`,
      disabled: !row.can_release,
    })),
  );
  setRdCaptureHeldCls(
    (capture?.held?.length ?? 0) > 0 ? "rd-held-recovery" : "rd-held-recovery none",
  );
  const themeRows = v.theme_rows ?? [];
  const renderedThemeRows = themeRows.map((row) => ({
    ...row,
    chosen: row.chosen ? "true" : "false",
  }));
  setRdThemeRows(renderedThemeRows);
  setRdCompactThemeRows(renderedThemeRows);
  // The ONE verb whose effect lives outside this island's tree (the
  // nocturne lesson, carried over with the rows). Every other form's outcome
  // is repainted from this payload, but the theme is an attribute on <html>
  // that only a full server render used to stamp — so with scripting on
  // (the entry fetch-submits every POST and discards the redirect's page)
  // choosing a theme changed nothing on screen until a manual refresh. The
  // rows already carry the server's choice as DATA (`chosen`/`name`, never
  // prose), so the stamp converges here — including a change made from
  // /nocturne, another tab, or the CLI, which arrives on the next refresh.
  // `system` is the ABSENCE of a stamp: the tokens' `:root:not([data-theme])`
  // media guard needs the attribute GONE, not set to "".
  const chosen = themeRows.find((r) => r.chosen)?.name ?? "";
  const html = document.documentElement;
  if (chosen === "" || chosen === "system") {
    if (html.dataset.theme !== undefined) delete html.dataset.theme;
  } else if (html.dataset.theme !== chosen) {
    html.dataset.theme = chosen;
  }
  const d = v.devices;
  rdDeviceScanAuthoritative = d?.scan_authoritative === true;
  rdStagingReachable = d?.staging_reachable === true;
  rdStagingLine = d?.staging_line ?? "";
  setRdDevKb(d?.keyboards ?? []);
  // The encoder rows drop the transient `chart not read yet` phrase the
  // moment the page owns the live read (the encoder surface starts it at
  // mount) — the modal meta span is marked data-live-chatter for exactly
  // this: its TEXT follows the session, by the parity contract.
  setRdDevEnc((d?.encoders ?? []).map((row) => ({
    ...row,
    meta: deviceCardMeta(row),
  })));
  refreshEncoderProfileLab?.(encoderProfileLabDevices());
  setRdDevExp(d?.experimental ?? []);
  setRdDevOther(d?.other ?? []);
  const stagedSources = [
    ...(d?.keyboards ?? []),
    ...(d?.encoders ?? []),
    ...(d?.experimental ?? []),
  ].filter((row) => row.aria_current === "true");
  // Connection rows are not source authority. A routed source remains a
  // valid authoring target while unplugged so the operator can inspect its
  // routes and remove it without reconnecting hardware. The device roster's
  // offline placeholder covers an unrouted staged source; nested pad sources
  // cover the canonical routed graph (including older payload producers).
  const canonicalStagedSelectors = new Set([
    ...stagedSources.map((row) => row.selector),
    ...(v.controllers?.pads ?? []).flatMap((pad) =>
      (pad.sources ?? []).map((source) => source.source_id)
    ),
  ].filter(Boolean));
  const currentSource = currentAuthoringSource();
  const servedSource = v.source?.trim() || v.controllers?.source?.trim() || "";
  if (servedSource && canonicalStagedSelectors.has(servedSource)) {
    mergeSourceIntoUrl(servedSource, false);
  } else if (!canonicalStagedSelectors.has(currentSource)) {
    const fallback = canonicalStagedSelectors.values().next().value ?? "";
    if (fallback) mergeSourceIntoUrl(fallback, false);
    else if (currentSource) {
      const url = new URL(window.location.href);
      url.searchParams.delete("source");
      const query = url.searchParams.toString();
      window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}`);
    }
  }
  setRdDevScanLine(d?.scan_line ?? "");
  setRdDevKbHead(d?.keyboards_head ?? "");
  setRdDevKbFoldCls(d?.keyboards_fold_cls ?? "n-devfold none");
  setRdDevEncHead(d?.encoders_head ?? "");
  setRdDevEncFoldCls(d?.encoders_fold_cls ?? "n-devfold none");
  setRdDevExpHead(d?.exp_head ?? "");
  setRdDevExpFoldCls(d?.exp_fold_cls ?? "n-devfold none");
  setRdDevOtherHead(d?.other_head ?? "");
  setRdDevOtherFoldCls(d?.other_fold_cls ?? "n-devfold none");
  const c = v.controllers;
  setRdCtrlPersonas(c?.personas ?? []);
  setRdCtrlAddNote(c?.add_note ?? "");
  setRdCtrlCountsLine(c?.counts_line ?? "");
  setRdCtrlAddPreset(c?.add_preset ?? "");
  setRdCtrlAddLayout(c?.add_layout ?? "");
  setRdCtrlAddSource(c?.add_source ?? "");
  setRdCtrlAddSourceRevision(c?.add_source_revision ?? "");
  rdCtrlCards = c?.cards ?? [];
  rdCtrlParkedHeld = c?.parked_held ?? [];
  rdCtrlPads = c?.pads ?? [];
  rdCtrlPanel = c?.panel ?? null;
  rdCtrlKeys = c?.keys ?? null;
  rdCtrlMacrosHead = c?.macros_head || "Macros";
  rdCtrlMacroRows = c?.macro_rows ?? [];
  rdCtrlMacrosNote = c?.macros_note ?? "";
  rdCtrlMac = c?.mac ?? null;
  setRdMacHolderCls(`rd-macdlg ${c?.mac?.back_cls || "nd-back none"}`);
  rdLearnSource = {
    selector: v.learn_selector ?? "",
    instance: v.learn_instance ?? "",
  };
  const board = v.board;
  if (board) {
    setRdKbRow1(board.kb_row1 ?? []);
    setRdKbRow2(board.kb_row2 ?? []);
    setRdKbRow3(board.kb_row3 ?? []);
    setRdKbRow4(board.kb_row4 ?? []);
    setRdKbRow5(board.kb_row5 ?? []);
    setRdKbRow6(board.kb_row6 ?? []);
    setRdKbTray(board.kb_tray ?? []);
    setRdKbLegend(board.legend ?? []);
    setRdKbTitle(board.kb_title ?? "");
    setRdKbCls(board.kb_cls || "n-kb");
    setRdBoardCaseStyle(board.board_case_style ?? "");
    setRdBoardOrigin(board.board_origin ?? "");
    setRdKbTrayHead(board.kb_tray_head ?? "");
    setRdKbTrayCls(board.kb_tray_cls || "n-kbtray none");
    setRdKbNote(board.kb_note ?? "");
    setRdKbMoreCls(board.kb_more_cls || "n-lgdmore none");
    setRdSoloLbl(board.solo_label || "Only this player");
  }
  setRdCaptureRows(v.capture_rows ?? []);
  setRdCaptureNote(v.capture_note ?? "");
  // The mute/solo lens and the finish repaint follow every served update.
  applyControllerIdentityColors();
  syncKbLens();
  setRdUndoCls(c?.undo_cls || "rd-undochip none");
  setRdUndoLabel(c?.undo_label ?? "");
  // Reconcile browser-owned membership with the freshly served roster: a
  // disconnected board leaves the canvas without losing its remembered
  // place, and a remembered board mounts as soon as the scan sees it again.
  reconcileBenchWithRoster();
  // The controller cards are DAEMON truth: the canvas mirrors the staged
  // rack exactly (redesign-controllers.ts owns the reconcile).
  syncCtrlBench();
  // A refresh carries a possibly different panel (new bindings, new SOCD,
  // new selection): an open inspector repaints from the fresh truth.
  const panel = inspectorEl();
  if (panel && !panel.hidden) renderInspector();
  // The mapper's payload pass, AFTER the panel rebuilt: retire any armed
  // gesture the fresh truth invalidated, then re-apply the interaction
  // marks the rebuild wiped (nocturne's applyNocturne order).
  mapperReconcile();
  // The cords re-derive from the fresh pads (mode/slot unchanged).
  syncMappingCords();
  // The step editor follows ?macro= — a served `mac` opens/repaints it,
  // its absence closes it (the one-macro-one-controller invariant).
  syncMacroDialog();
  restoreDeviceRowFocus(deviceFocus);
}

/** Reconcile the canvas to the served controller cards and the parked
 *  ghosts. A no-op until the engine exists; the canvas init calls it again
 *  once it does. */
function syncCtrlBench(): void {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return;
  syncControllerWidgets(rdCtrlCards, {
    canvas,
    root,
    pads: rdCtrlPads,
    authoringSource: currentAuthoringSource(),
    draftRevision: rdDraftRevision(),
    parked: canvasPrefs.parked ?? [],
    parkedHeld: new Set(rdCtrlParkedHeld),
    addPreset: rdCtrlAddPreset(),
    addLayout: rdCtrlAddLayout(),
    addSource: rdCtrlAddSource(),
    addSourceRevision: rdCtrlAddSourceRevision(),
    savedGeometry: (id) => canvasPrefs.widgets[id],
    allocateFreshGeometry: allocateFreshCanvasGeometry,
    park: parkController,
    onMutation: () => {
      syncMapCount();
      scheduleChips();
    },
  });
}

/** Park one orphaned controller's display facts — called by the card the
 *  moment "No player" is chosen, BEFORE its remove posts, so the card's
 *  identity survives whatever the network does. */
function parkController(entry: ParkedController): void {
  canvasPrefs.parked = [...(canvasPrefs.parked ?? []), entry];
  saveCanvasPrefs();
  syncCtrlBench();
}

/** Whether the server still holds parked material for this ghost — the
 *  entry's post-assign check: a re-slot SUCCEEDED exactly when the id left
 *  the served `parked_held` (the stash entry is dropped only on the success
 *  path), which is a structural signal, never a sentence comparison. */
export function redesignGhostHeld(id: string): boolean {
  return rdCtrlParkedHeld.includes(id);
}

/** Discard one parked ghost (browser-only), or retire it after a
 *  successful re-slot. Exported for the entry's assign chain. */
export function unparkController(id: string): void {
  canvasPrefs.parked = (canvasPrefs.parked ?? []).filter((p) => p.id !== id);
  saveCanvasPrefs();
  syncCtrlBench();
}


/** Report one action outcome (the redirect's allowlisted ?flash= copy) —
 *  the server derivation in render_redesign.rs `scalar_slots`, mirrored:
 *  strip the marker for display, key the colour class off it. */
export function applyRedesignFlash(flash: string | null): void {
  if (!flash) {
    setRdFlashLine("");
    setRdFlashCls("n-flash rd-flash none");
    return;
  }
  setRdFlashLine(flash.replace(/^error: /, ""));
  setRdFlashCls(flash.startsWith("error") ? "n-flash rd-flash err" : "n-flash rd-flash ok");
}

/** Refresh health is transport state, not daemon product state. Keep the last
 * authoritative payload visible during a short outage, but make its age
 * explicit instead of presenting stale action availability as current. */
export function setRedesignRefreshHealth(
  state: "online" | "stale",
  message = "",
): void {
  const root = rdRoot;
  if (!root) return;
  root.dataset.rdRefreshState = state;
  for (const status of Array.from(
    root.querySelectorAll<HTMLElement>(".rd-refresh-health"),
  )) {
    status.dataset.state = state;
    status.textContent = message;
    status.hidden = state === "online" || message.trim() === "";
  }
  const alert = root.querySelector<HTMLElement>("[data-rd-health-alert]");
  const alertMessage = alert?.querySelector<HTMLElement>("[data-rd-health-message]");
  if (alert && alertMessage) {
    alert.dataset.state = state;
    alertMessage.textContent = message;
    alert.hidden = state === "online" || message.trim() === "";
  }
  const summary = root.querySelector<HTMLElement>(".rd-setup-sum");
  if (summary) {
    summary.title = state === "stale" && message.trim()
      ? `${message} Open Setup for details.`
      : "Setup progress, draft, session and input readiness";
  }
}

const RD_CAPTURE_ATTENTION_MODES = new Set([
  "prepare",
  "held",
  "blocked",
  "unavailable",
  "release-held",
]);

function captureIdentityMatches(row: RdHeldCaptureRow): boolean {
  return Boolean(
    row.selector && row.instance &&
    row.selector === rdCaptureSelector() &&
    row.instance.toLowerCase() === rdCaptureInstance().toLowerCase(),
  );
}

/** A prepared selected input may coexist with a second stranded keyboard.
 * Keep that independent recovery fact visible instead of reducing the whole
 * machine to the selected input's healthy mode. */
function additionalHeldCaptureRows(): RdHeldCaptureRow[] {
  return rdCaptureHeld().filter((row) => !captureIdentityMatches(row));
}

// ── The canvas (extracted from the retired Nocturne implementation) ────────

/** The lane's OWN store key — sharing /nocturne's would inherit and corrupt
 *  its camera and widget geometry. */
const CANVAS_STORE = "ksx-redesign-canvas";
function isEncoderProfileLabInstanceId(instanceId: string): boolean {
  return instanceId === ENCODER_PROFILE_LAB_INSTANCE_ID;
}

/** One press of canvas zoom. The engine's own wheel step is finer; a button
 *  press should be a visible move, not a nudge. */
const CANVAS_ZOOM_STEP = 1.25;

/** The runaway rail for widgets — NOT a workspace edge, and not a camera
 *  limit (the view pans freely, the way every canvas tool in this shape
 *  works). It exists only so a widget cannot be flung somewhere nothing can
 *  reach; you should never meet it by dragging.
 *
 *  ⚠️Its ORIGIN is the part that matters. A bound starting at (0, 0) put a
 *  wall 140px above the tidied board — an invisible wall in the middle of an
 *  empty canvas, which is indistinguishable from a bug. It reaches far into
 *  the negative on both axes now, and Fit / the map are what actually bring
 *  a stray widget home. */
const CANVAS_WORLD = { x: -8000, y: -8000, width: 20000, height: 20000 };

interface CanvasItemGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

interface CanvasVisualRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A fresh widget should land beside the existing work, never underneath it.
 *  Saved geometry is user intent and bypasses this allocator completely. */
const CANVAS_FRESH_PLACEMENT_GAP = 40;
const CANVAS_FRESH_PLACEMENT_STEPS = 12;

function canvasVisualRect(geometry: CanvasItemGeometry): CanvasVisualRect {
  const width = geometry.width * geometry.manualScale;
  const height = geometry.height * geometry.manualScale;
  return {
    x: geometry.x + (geometry.width - width) / 2,
    y: geometry.y + (geometry.height - height) / 2,
    width,
    height,
  };
}

function canvasRectsOverlap(left: CanvasVisualRect, right: CanvasVisualRect): boolean {
  const gap = CANVAS_FRESH_PLACEMENT_GAP;
  return (
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y
  );
}

function mountedCanvasGeometries(ignore: HTMLElement | null = null): CanvasItemGeometry[] {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id][data-canvas-x]",
    ),
  )
    .filter((item) => item !== ignore)
    .map((item) => canvas.getItemState(item));
}

function nextCanvasZ(minimum = 1): number {
  return Math.max(
    minimum,
    ...mountedCanvasGeometries().map((geometry) => geometry.z + 1),
  );
}

function allocateFreshCanvasGeometry(
  preferred: CanvasItemGeometry,
  ignore: HTMLElement | null = null,
): CanvasItemGeometry {
  const occupied = mountedCanvasGeometries(ignore).map(canvasVisualRect);
  const withFreshZ = { ...preferred, z: nextCanvasZ(preferred.z) };
  const isOpen = (candidate: CanvasItemGeometry) => {
    const visual = canvasVisualRect(candidate);
    return occupied.every((other) => !canvasRectsOverlap(visual, other));
  };
  if (isOpen(withFreshZ)) return withFreshZ;

  const strideX = preferred.width + CANVAS_FRESH_PLACEMENT_GAP;
  const strideY = preferred.height + CANVAS_FRESH_PLACEMENT_GAP;
  const offsets: { x: number; y: number; score: number }[] = [];
  for (let x = 0; x <= CANVAS_FRESH_PLACEMENT_STEPS; x += 1) {
    for (let y = 0; y <= CANVAS_FRESH_PLACEMENT_STEPS; y += 1) {
      if (x === 0 && y === 0) continue;
      offsets.push({ x: x * strideX, y: y * strideY, score: x + y * 1.5 });
    }
  }
  offsets.sort((left, right) =>
    left.score - right.score || left.y - right.y || left.x - right.x
  );
  for (const offset of offsets) {
    const candidate = {
      ...withFreshZ,
      x: preferred.x + offset.x,
      y: preferred.y + offset.y,
    };
    if (isOpen(candidate)) return candidate;
  }

  // The positive quadrant is intentionally preferred because it keeps the
  // workbench reading left-to-right. A very dense custom arrangement still
  // gets a bounded escape hatch before the engine applies its world clamp.
  for (let step = 1; step <= CANVAS_FRESH_PLACEMENT_STEPS; step += 1) {
    for (const candidate of [
      { ...withFreshZ, x: preferred.x - step * strideX },
      { ...withFreshZ, y: preferred.y - step * strideY },
    ]) {
      if (isOpen(candidate)) return candidate;
    }
  }
  const rightEdge = Math.max(...occupied.map((rect) => rect.x + rect.width));
  return {
    ...withFreshZ,
    x: rightEdge + CANVAS_FRESH_PLACEMENT_GAP,
  };
}

interface CanvasPrefs {
  camera?: { panX: number; panY: number; zoom: number };
  widgets: Record<string, CanvasItemGeometry>;
  /** The map is chrome, so it remembers like every other chrome preference.
   *  Absent means shown. */
  mapHidden?: boolean;
  /** The workbench: which devices are on the canvas, by RAW selector (the
   *  I-PAC lesson — canonicalizing a selector is how twin boards collide).
   *  Arrangement state like the camera, never a daemon claim; a remembered
   *  board whose device is gone simply does not mount until it returns. */
  bench?: string[];
  /** Parked controllers — cards orphaned off the draft ("No player") that
   *  wait on the canvas to be re-slotted. Display facts only: the slot
   *  itself left the daemon when it was parked. */
  parked?: ParkedController[];
  /** The mapping cords' visibility: off / selected player / all players
   *  (nocturne's own Paths modes, remembered like the camera). */
  mappingPaths?: MappingPathMode;
  /** Manual processor displacements, keyed by processor id — the cords'
   *  macro nodes remember where a hand put them. */
  processorOffsets?: Record<string, { x: number; y: number }>;
}

let canvasPrefs: CanvasPrefs = { widgets: {} };
let nCanvas: WidgetCanvas | null = null;
let encoderAttentionObserver: MutationObserver | null = null;
let rdRoot: HTMLElement | null = null;
let encoderLabReturnCamera: { panX: number; panY: number; zoom: number } | null = null;
let refreshEncoderProfileLab: ((devices: readonly EncoderProfileLabDevice[]) => void) | null = null;
let disposeEncoderProfileLab: (() => void) | null = null;
const encoderWorkbenchSurfaces = new WeakMap<HTMLElement, EncoderWorkbenchSurface>();
let sourceSurfaceFingerprint = "";
let keyboardSurfaceTemplate: HTMLElement | null = null;
let sourceControlsSurface: HTMLElement | null = null;

const REDESIGN_BROWSER_STORES = [
  RD_UI_STORE,
  CANVAS_STORE,
  RD_CONTROLLER_COLOR_STORE,
  // Migration-compatible key: the preference predates the redesign name,
  // but this surface now owns every write and its provenance boundary.
  KB_STRIPS_STORE,
] as const;

function fixtureOwnerIsStale(
  owner: RdStateProvenance,
  current: RdStateProvenance,
): boolean {
  if (!owner.fixture) return false;
  // Fixture-authored arrangement must not leak onto a cabinet either. This
  // remains safe because real-authored stores are stamped fixture:false and
  // can never satisfy this branch.
  if (!current.fixture) return true;
  if (
    owner.environmentId.trim() !== "" && current.environmentId.trim() !== "" &&
    owner.environmentId !== current.environmentId
  ) return true;
  return current.generation.trim() !== "" && owner.generation !== current.generation;
}

function resetRedesignBrowserMemory(stores: ReadonlySet<string>): void {
  if (stores.has(RD_UI_STORE)) {
    inspTab = "controls";
    kbSolo = false;
    kbTheme = "carbon-forge";
  }
  if (stores.has(RD_CONTROLLER_COLOR_STORE)) controllerColors = {};
  if (stores.has(KB_STRIPS_STORE)) kbHiddenStrips = new Set();
  if (stores.has(CANVAS_STORE)) canvasPrefs = { widgets: {} };
}

/** Reconcile fixture identity before any payload can repaint or persist.
 *
 * Each redesign store carries its own last-writer provenance. Only a store
 * proven to have been written by an older fixture is removed; unmarked and
 * real-machine values are retained. A live fixture reseed reloads after the
 * surgical clear so already-mounted engine state cannot write the old canvas
 * back during pagehide. */
function reconcileRedesignEnvironment(payload: RedesignPayload): boolean {
  const current: RdStateProvenance = {
    environmentId: payload.environment_id?.trim() || "unknown-environment",
    generation: payload.environment_generation?.trim() || "",
    fixture: payload.environment_fixture === true,
  };
  const resetStores = new Set<string>();
  try {
    const provenance = readRedesignStateProvenance();
    for (const store of REDESIGN_BROWSER_STORES) {
      const owner = provenance[store];
      if (!owner || !fixtureOwnerIsStale(owner, current)) continue;
      window.localStorage.removeItem(store);
      delete provenance[store];
      resetStores.add(store);
    }
    window.localStorage.setItem(RD_STATE_PROVENANCE_STORE, JSON.stringify(provenance));
  } catch {
    // The active-environment comparison below still protects this document's
    // in-memory fixture state when persistence is unavailable.
  }

  const liveFixtureChanged = Boolean(
    activeEnvironment && fixtureOwnerIsStale(activeEnvironment, current),
  );
  activeEnvironment = current;
  if (resetStores.size > 0) resetRedesignBrowserMemory(resetStores);
  if ((resetStores.size > 0 || liveFixtureChanged) && rdRoot?.isConnected) {
    // Pagehide normally commits the canvas. Suppress that one commit or the
    // old mounted geometry could recreate the just-removed fixture store
    // under the new generation immediately before navigation.
    redesignPersistenceSuspended = true;
    window.location.reload();
    return true;
  }
  return false;
}

interface DeviceRowFocus {
  element: HTMLElement;
  selector: string;
}

/** Served list rows can be replaced when their staged marking changes. Keep
 * keyboard focus on the equivalent picker control across that repaint; if
 * the row authoritatively disappears, the modal close button is the stable
 * fallback. */
function captureDeviceRowFocus(): DeviceRowFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !rdRoot?.contains(active)) return null;
  const row = active.closest<HTMLElement>('[data-nx="rd-dev-toggle"][data-selector]');
  const selector = row?.dataset.selector;
  return row && selector ? { element: row, selector } : null;
}

function restoreDeviceRowFocus(snapshot: DeviceRowFocus | null): void {
  if (
    !snapshot || snapshot.element.isConnected || document.activeElement !== document.body ||
    !devModalIsOpen()
  ) return;
  const replacement = Array.from(
    rdRoot?.querySelectorAll<HTMLElement>('[data-nx="rd-dev-toggle"][data-selector]') ?? [],
  ).find((row) => row.dataset.selector === snapshot.selector);
  (replacement ?? rdRoot?.querySelector<HTMLElement>('[data-nx="rd-devs-close"]'))?.focus({
    preventScroll: true,
  });
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

function loadCanvasPrefs(): void {
  try {
    const raw = window.localStorage.getItem(CANVAS_STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as CanvasPrefs;
    const widgets: Record<string, CanvasItemGeometry> = {};
    for (const [key, g] of Object.entries(saved.widgets ?? {})) {
      // Older prototype builds could strand review-only geometry in the
      // durable arrangement. Drop it on read as well as refusing it on write.
      if (!isEncoderProfileLabInstanceId(key) && isGeometry(g)) widgets[key] = g;
    }
    const cam = saved.camera;
    canvasPrefs = {
      widgets,
      mapHidden: saved.mapHidden === true,
      bench: Array.isArray(saved.bench)
        ? saved.bench.filter((s): s is string => typeof s === "string")
        : undefined,
      parked: Array.isArray(saved.parked)
        ? saved.parked
            .filter(
              (p): p is ParkedController =>
                typeof p === "object" && p !== null &&
                typeof p.id === "string" && typeof p.persona === "string" &&
                typeof p.persona_label === "string" && typeof p.preset === "string",
            )
            // Entries stored before the art fields existed draw the named
            // placeholder rather than crashing the ghost.
            .map((p) => ({
              ...p,
              family: typeof p.family === "string" ? p.family : "",
              art: typeof p.art === "string" ? p.art : "",
            }))
        : undefined,
      camera:
        cam &&
        [cam.panX, cam.panY, cam.zoom].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
          ? { panX: cam.panX, panY: cam.panY, zoom: Math.min(3, Math.max(0.08, cam.zoom)) }
          : undefined,
      // The mapping chrome's own durable state — every field a prefs writer
      // rebuilds MUST be re-listed here or it silently dies on reload.
      mappingPaths: mappingPathModeIsValid(saved.mappingPaths) ? saved.mappingPaths : undefined,
      processorOffsets:
        typeof saved.processorOffsets === "object" && saved.processorOffsets !== null
          ? Object.fromEntries(
              Object.entries(saved.processorOffsets as Record<string, { x: number; y: number }>)
                .filter(
                  ([, o]) =>
                    typeof o === "object" && o !== null &&
                    Number.isFinite(o.x) && Number.isFinite(o.y),
                ),
            )
          : undefined,
    };
  } catch {
    // A blocked or corrupt store reads as the defaults.
  }
}

function writeCanvasPrefs(next: CanvasPrefs): boolean {
  try {
    if (!redesignStorePersistenceAllowed(CANVAS_STORE)) return false;
    window.localStorage.setItem(CANVAS_STORE, JSON.stringify(next));
    markRedesignStore(CANVAS_STORE);
    return true;
  } catch {
    // The arrangement simply will not survive this session.
    return false;
  }
}

function saveCanvasPrefs(): boolean {
  return writeCanvasPrefs(canvasPrefs);
}

/** Read the camera and every mounted widget's geometry back into the store
 *  — called from the engine's onCommit (its own durable boundary), from the
 *  debounced onChange trail (so a kill mid-arrangement loses at most the
 *  last second), and synchronously on pagehide. */
function persistCanvas(): void {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return;
  const widgets: Record<string, CanvasItemGeometry> = { ...canvasPrefs.widgets };
  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".n-canvas [data-instance-id]"),
  )) {
    const id = item.dataset.instanceId;
    if (id && !isEncoderProfileLabInstanceId(id) && item.dataset.canvasX !== undefined) {
      widgets[id] = canvas.getItemState(item);
    }
  }
  canvasPrefs = {
    // The lab's automatic comparison fit is temporary chrome, not the user's
    // workbench view. While it is open, retain the exact camera it displaced.
    camera: encoderLabReturnCamera ?? canvas.getCamera(),
    widgets,
    mapHidden: canvasPrefs.mapHidden,
    bench: canvasPrefs.bench,
    parked: canvasPrefs.parked,
    // ⚠️ A REBUILD MUST CARRY EVERY DURABLE FIELD: dropping one here let a
    // camera nudge silently reset the Paths mode (the cords vanished and
    // the select snapped to Off on the next repaint).
    mappingPaths: canvasPrefs.mappingPaths,
    processorOffsets: canvasPrefs.processorOffsets,
  };
  saveCanvasPrefs();
}

/** Restore a readable semantic workbench in one deterministic pass: the
 * physical input first, attached devices next, then virtual controllers in
 * player order. It changes arrangement only — never draft membership or
 * mapping — and uses the canvas engine's public placement boundary so map,
 * visibility and persistence all receive the same update as a hand move. */
function tidyCanvas(): void {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id][data-canvas-x]",
    ),
  ).filter((item) => !isEncoderProfileLabInstanceId(item.dataset.instanceId ?? ""));
  if (items.length === 0) {
    rdAnnounce("There are no workbench items to tidy.");
    return;
  }
  if (canvas.isFocusModeActive()) canvas.exitFocusMode();
  for (const item of items) canvas.resetItemScale(item);

  const byName = (left: HTMLElement, right: HTMLElement) =>
    (left.dataset.widgetName ?? left.dataset.instanceId ?? "").localeCompare(
      right.dataset.widgetName ?? right.dataset.instanceId ?? "",
    );
  const keyboard = items
    .filter((item) => item.classList.contains("rd-keyboard-device-node"))
    .sort(byName);
  const devices = items
    .filter(
      (item) => item.classList.contains("rd-dev-node") &&
        !item.classList.contains("rd-keyboard-device-node"),
    )
    .sort(byName);
  const controllers = items
    .filter((item) => /^ctrl-slot-\d+$/.test(item.dataset.instanceId ?? ""))
    .sort((left, right) => {
      const leftSlot = Number(left.dataset.instanceId?.replace("ctrl-slot-", ""));
      const rightSlot = Number(right.dataset.instanceId?.replace("ctrl-slot-", ""));
      return leftSlot - rightSlot;
    });
  const parked = items
    .filter((item) => (item.dataset.instanceId ?? "").startsWith("ctrl-parked-"))
    .sort(byName);
  const known = new Set([...keyboard, ...devices, ...controllers, ...parked]);
  const other = items.filter((item) => !known.has(item)).sort(byName);

  const originX = 140;
  let y = 140;
  const gapX = 48;
  const gapY = 64;
  const keyboardWidth = keyboard[0] ? canvas.getItemState(keyboard[0]).width : 0;
  const shelfWidth = Math.max(1240, keyboardWidth);
  const placeShelf = (shelf: HTMLElement[]) => {
    if (shelf.length === 0) return;
    let x = originX;
    let rowHeight = 0;
    for (const item of shelf) {
      const state = canvas.getItemState(item);
      if (x > originX && x + state.width > originX + shelfWidth) {
        x = originX;
        y += rowHeight + gapY;
        rowHeight = 0;
      }
      canvas.placeItem(item, x, y);
      x += state.width + gapX;
      rowHeight = Math.max(rowHeight, state.height);
    }
    y += rowHeight + gapY;
  };
  placeShelf(keyboard);
  placeShelf(devices);
  placeShelf(controllers);
  placeShelf(parked);
  placeShelf(other);
  persistCanvas();
  canvas.fitAll();
  renderInspector();
  rdAnnounce(`Tidied ${items.length} workbench item${items.length === 1 ? "" : "s"}.`);
}

/** Show or hide the map, and swap in the small corner button that brings it
 *  back — the control for a thing in the corner belongs in that corner, not
 *  in a bar at the other end of the page.
 *  ⚠️The engine projects onto the map's MEASURED box, so a hidden one has no
 *  size to project onto: bringing it back has to re-render once it has been
 *  laid out again, or it returns blank. */
function setCanvasMap(hidden: boolean): void {
  const root = rdRoot;
  const map = root?.querySelector<HTMLElement>(".forma-canvas-navigator");
  const show = root?.querySelector<HTMLElement>(".rd-mapshow");
  if (!map) return;
  map.hidden = hidden;
  if (show) show.hidden = !hidden;
  canvasPrefs = { ...canvasPrefs, mapHidden: hidden };
  saveCanvasPrefs();
  if (!hidden) {
    window.requestAnimationFrame(() => {
      nCanvas?.refreshNavigator();
    });
  }
}

let canvasPersistTimer = 0;
function scheduleCanvasPersist(): void {
  window.clearTimeout(canvasPersistTimer);
  canvasPersistTimer = window.setTimeout(persistCanvas, 1000);
}

// ── Semantic-zoom tier readout (design handoff §4) ──────────────────────────

/** The three reading tiers, worded once. Zooming out is not shrinking: each
 *  tier says what a widget should show at this distance, and the readout in
 *  the corner names the tier the camera is in. The thresholds and their
 *  ±3% hysteresis live in the ENGINE now (it also stamps the tier onto the
 *  viewport as `data-canvas-zoom-tier`, which is what the mock nodes' CSS
 *  keys on) — this label can therefore never disagree with the attribute. */
const TIER_COPY: Record<string, string> = {
  overview: "Overview — colour, name, status",
  structure: "Structure — type, ports, one-line summary",
  editing: "Editing — full detail and controls",
};
// The terminal's 54-unit SVG hit box clears 44 CSS px at this effective scale
// on the fixed 960px product item. Below it the board remains a useful
// silhouette, but its controls are inert rather than undersized targets.
const ENCODER_MIN_EFFECTIVE_EDIT_SCALE = 0.9;
const ENCODER_EDIT_SCALE_SAFETY = 0.001;
const KEYBOARD_MIN_EFFECTIVE_EDIT_SCALE = 0.9;
const KEYBOARD_MIN_COARSE_EDIT_SCALE = 1.25;

function keyboardMinEffectiveEditScale(): number {
  return window.matchMedia?.("(pointer: coarse)").matches
    ? KEYBOARD_MIN_COARSE_EDIT_SCALE
    : KEYBOARD_MIN_EFFECTIVE_EDIT_SCALE;
}

/** Camera zoom that preserves the encoder's 44px terminal targets after the
 * item's own manual scale is applied. Fresh Add and keyboard entry share this
 * exact calculation so neither path can expose an automatic read without its
 * recovery controls. */
function encoderEditingZoom(manualScale: number): number {
  const itemScale = Number.isFinite(manualScale) && manualScale > 0 ? manualScale : 1;
  return Math.min(
    3,
    Math.max(
      0.94,
      (ENCODER_MIN_EFFECTIVE_EDIT_SCALE + ENCODER_EDIT_SCALE_SAFETY) / itemScale,
    ),
  );
}

function keyboardEditingZoom(manualScale: number): number {
  const itemScale = Number.isFinite(manualScale) && manualScale > 0 ? manualScale : 1;
  const minimum = keyboardMinEffectiveEditScale();
  return Math.min(
    3,
    Math.max(
      0.94,
      (minimum + ENCODER_EDIT_SCALE_SAFETY) / itemScale,
    ),
  );
}

function canvasZoomFromViewport(
  viewport: HTMLElement | null = rdRoot?.querySelector<HTMLElement>(".forma-canvas-viewport") ?? null,
): number {
  const value = Number(viewport?.style.getPropertyValue("--canvas-zoom"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Product encoders paint a useful board silhouette at every camera tier, but
 * their 56 native terminal controls are only honest targets at editing size.
 * `inert` keeps the visible schematic out of pointer and keyboard routing;
 * the item stamp also lets CSS collapse the supporting command chrome. */
function syncEncoderEditingAccess(
  tier: string,
  zoom = canvasZoomFromViewport(),
): void {
  const root = rdRoot;
  if (!root) return;
  for (const item of root.querySelectorAll<HTMLElement>(".rd-encoder-device-node")) {
    const manualScale = Number(item.dataset.canvasManualScale);
    const attentionScale = Number(item.dataset.attentionScale);
    // The engine's attention scale is already manual × automatic distance
    // scale. Falling back to the manual value covers the mount frame before
    // the visibility pass stamps its first attention result.
    const renderedItemScale = Number.isFinite(attentionScale) && attentionScale > 0
      ? attentionScale
      : Number.isFinite(manualScale) && manualScale > 0 ? manualScale : 1;
    const effectiveScale = zoom * renderedItemScale;
    const editable = tier === "editing" && effectiveScale >= ENCODER_MIN_EFFECTIVE_EDIT_SCALE;
    item.dataset.encoderEditable = editable ? "true" : "false";
    const host = item.querySelector<HTMLElement>(
      '.rd-encoder-profile[data-presentation="product"] .rd-encoder-profile-host',
    );
    if (!host) continue;
    const active = host.ownerDocument.activeElement;
    if (!editable && active instanceof HTMLElement && host.contains(active)) {
      item.focus({ preventScroll: true });
    }
    host.inert = !editable;
    if (editable) host.removeAttribute("aria-hidden");
    else host.setAttribute("aria-hidden", "true");
  }
}

/** The full keyboard remains a recognizable board at every distance, but its
 * native keys and finish controls are only operable when the camera makes
 * them honest targets. Every connected on-canvas keyboard is independently
 * eligible; authoring focus never disables its peers. */
function syncKeyboardEditingAccess(
  tier: string,
  zoom = canvasZoomFromViewport(),
): void {
  const root = rdRoot;
  if (!root) return;
  for (const item of root.querySelectorAll<HTMLElement>(".rd-keyboard-device-node")) {
    const manualScale = Number(item.dataset.canvasManualScale);
    const attentionScale = Number(item.dataset.attentionScale);
    const renderedItemScale = Number.isFinite(attentionScale) && attentionScale > 0
      ? attentionScale
      : Number.isFinite(manualScale) && manualScale > 0 ? manualScale : 1;
    const effectiveScale = zoom * renderedItemScale;
    const editable = item.dataset.sourceEnabled === "true" &&
      tier === "editing" && effectiveScale >= keyboardMinEffectiveEditScale();
    item.dataset.keyboardEditable = editable ? "true" : "false";
    const surface = item.querySelector<HTMLElement>(KEYBOARD_SURFACE_SELECTOR);
    if (!surface) continue;
    const active = surface.ownerDocument.activeElement;
    if (!editable && active instanceof HTMLElement && surface.contains(active)) {
      item.focus({ preventScroll: true });
    }
    surface.inert = !editable;
    if (editable) surface.removeAttribute("aria-hidden");
    else surface.setAttribute("aria-hidden", "true");
  }
}

function applyZoomTier(tier: string, zoom = canvasZoomFromViewport()): void {
  const el = rdRoot?.querySelector<HTMLElement>(".rd-tier");
  if (el) el.textContent = TIER_COPY[tier] ?? tier;
  syncEncoderEditingAccess(tier, zoom);
  syncKeyboardEditingAccess(tier, zoom);
}

// ── Chrome state the engine reports back ────────────────────────────────────

function syncToolRail(mode: "select" | "hand"): void {
  const root = rdRoot;
  if (!root) return;
  root.querySelector<HTMLElement>('[data-nx="rd-tool-select"]')
    ?.setAttribute("aria-pressed", String(mode === "select"));
  root.querySelector<HTMLElement>('[data-nx="rd-tool-hand"]')
    ?.setAttribute("aria-pressed", String(mode === "hand"));
}

function syncBackView(depth: number, topLabel: string | null): void {
  const buttons = Array.from(
    rdRoot?.querySelectorAll<HTMLButtonElement>('[data-nx="rd-back"]') ?? [],
  );
  for (const button of buttons) {
    button.hidden = depth === 0;
    button.title = topLabel ? `Back view — ${topLabel}` : "Back view";
  }
}

function syncMapCount(): void {
  const root = rdRoot;
  if (!root) return;
  const el = root.querySelector<HTMLElement>(".rd-map-count");
  if (!el) return;
  // Stage-scoped on purpose: the minimap's own markers carry
  // data-instance-id too and would double the count.
  const count = root.querySelectorAll(".forma-canvas-stage > [data-instance-id]").length;
  el.textContent = count === 1 ? "1 widget" : `${count} widgets`;
}

// ── The zoom menu, the command palette, and the shortcut sheet ──────────────
// All three are SERVED hidden as static markup (the mapshow precedent) and
// toggled client-side, so SSR parity holds with no exemption; the palette's
// result list is the one client-populated box, marked data-client-subtree.

function zoomMenuOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-menu")?.hidden === false;
}
function zoomMenuTrigger(): HTMLButtonElement | null {
  return rdRoot?.querySelector<HTMLButtonElement>('[data-nx="rd-zoom-menu"]') ?? null;
}
function zoomMenuItems(): HTMLButtonElement[] {
  return Array.from(
    rdRoot?.querySelectorAll<HTMLButtonElement>('.rd-menu [role="menuitem"]') ?? [],
  );
}
function setZoomMenu(
  open: boolean,
  focusItem: "first" | "last" = "first",
  restoreFocus = true,
): void {
  const menu = rdRoot?.querySelector<HTMLElement>(".rd-menu");
  if (!menu) return;
  menu.hidden = !open;
  const trigger = zoomMenuTrigger();
  trigger?.setAttribute("aria-expanded", String(open));
  if (open) {
    const items = zoomMenuItems();
    items[focusItem === "last" ? items.length - 1 : 0]?.focus({ preventScroll: true });
  } else if (restoreFocus && menu.contains(document.activeElement)) {
    trigger?.focus({ preventScroll: true });
  }
}

function sheetOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-sheet")?.hidden === false;
}
let sheetReturnFocus: HTMLElement | null = null;

function activeControl(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function focusCanvasContext(): void {
  const item = nCanvas?.activeItem();
  if (item?.isConnected && !item.inert) item.focus({ preventScroll: true });
  else nCanvas?.focusViewport();
}

function restoreOverlayFocus(target: HTMLElement | null): void {
  if (target?.isConnected && !target.closest("[hidden]")) {
    target.focus({ preventScroll: true });
  } else {
    focusCanvasContext();
  }
}

/** Close the native theme disclosure before a modal surface takes focus.
 *  When the disclosure itself owned focus, its summary is the durable return
 *  point — controls inside a closed details are no longer focusable. */
function closeThemeMenu(restoreFocus = false): boolean {
  const menus = Array.from(
    rdRoot?.querySelectorAll<HTMLDetailsElement>("[data-rd-theme-menu][open]") ?? [],
  );
  if (menus.length === 0) return false;
  const active = document.activeElement;
  const owner = active instanceof Element
    ? active.closest<HTMLDetailsElement>("[data-rd-theme-menu][open]")
    : null;
  const returnMenu = owner ?? menus.find((menu) => menu.offsetParent !== null) ?? menus[0];
  menus.forEach((menu) => {
    menu.open = false;
  });
  if (restoreFocus) {
    returnMenu.querySelector<HTMLElement>("[data-rd-theme-summary]")?.focus({ preventScroll: true });
  }
  return true;
}

const themeDisclosureRoots = new WeakSet<HTMLElement>();

/** The rail and Setup copies are one Theme control. Close an outgoing copy
 * before its breakpoint hides it, then restore focus to the entry point that
 * is actually rendered in the destination tier. */
function wireThemeDisclosures(root: HTMLElement): void {
  if (themeDisclosureRoots.has(root)) return;
  themeDisclosureRoots.add(root);
  let lastFocusedDisclosure: HTMLDetailsElement | null = null;
  root.ownerDocument.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const owner = target.closest<HTMLDetailsElement>("[data-rd-theme-menu]");
      if (owner) {
        lastFocusedDisclosure = owner;
      } else if (target !== root.ownerDocument.body &&
                 target !== root.ownerDocument.documentElement) {
        // Hiding a focused disclosure can make Chromium focus <body> before
        // MediaQueryList dispatches. Preserve that one transient handoff;
        // ordinary pointer movement was already cleared on pointerdown.
        lastFocusedDisclosure = null;
      }
    },
    true,
  );
  root.ownerDocument.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-rd-theme-menu]")) {
        lastFocusedDisclosure = null;
      }
    },
    true,
  );
  root.addEventListener(
    "toggle",
    (event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) ||
          !opened.matches("[data-rd-theme-menu]") || !opened.open) return;
      root.querySelectorAll<HTMLDetailsElement>("[data-rd-theme-menu][open]").forEach(
        (peer) => {
          if (peer !== opened) peer.open = false;
        },
      );
    },
    true,
  );
  const compact = window.matchMedia(REDESIGN_RAIL_PREFERENCES_MEDIA);
  compact.addEventListener("change", (event) => {
    const hadOpenDisclosure = Boolean(root.querySelector("[data-rd-theme-menu][open]"));
    const active = document.activeElement;
    const ownedFocus = active instanceof Element && Boolean(active.closest("[data-rd-theme-menu]"));
    const rememberedFocus = Boolean(lastFocusedDisclosure?.isConnected);
    lastFocusedDisclosure = null;
    if (hadOpenDisclosure) closeThemeMenu();
    if (!ownedFocus && !rememberedFocus) return;
    const target = event.matches
      ? root.querySelector<HTMLElement>(".rd-setupd > .rd-setup-sum")
      : root.querySelector<HTMLElement>(
        ".rd-theme-rail-home [data-rd-theme-menu] > .rd-theme-sum",
      );
    target?.focus({ preventScroll: true });
  });
}

function setSheet(open: boolean): void {
  const sheet = rdRoot?.querySelector<HTMLElement>(".rd-sheet");
  if (!sheet || sheet.hidden === !open) return;
  if (open) {
    // Close peers only through their close paths; none of those paths opens a
    // replacement, so modal coordination cannot recurse.
    if (devModalIsOpen()) setDevModal(false);
    if (ctrlModalIsOpen()) setCtrlModal(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    sheetReturnFocus = activeControl();
    sheet.hidden = false;
    // The bottom Close button can be below a short phone viewport. Land on
    // the visible introduction instead; Tab still reaches the dialog's
    // controls in their natural order.
    sheet.querySelector<HTMLElement>(".rd-sheet-lede")?.focus({ preventScroll: true });
  } else {
    sheet.hidden = true;
    const target = sheetReturnFocus;
    sheetReturnFocus = null;
    restoreOverlayFocus(target);
  }
}

interface PaletteCommand {
  name: string;
  hint: string;
  key: string;
  run: () => void;
}
const PALETTE_DEFAULT_WIDGET_LIMIT = 6;
const PALETTE_DEFAULT_COMMAND_LIMIT = 4;
const PALETTE_RESULT_LIMIT = 10;

function paletteCommands(): PaletteCommand[] {
  return [
    { name: "Fit workflow", hint: "frame every widget on the canvas", key: "1", run: () => nCanvas?.fitAll() },
    { name: "Tidy workbench", hint: "arrange input, devices and players in order", key: "", run: tidyCanvas },
    { name: "Fit selection", hint: "frame the selected widgets", key: "2", run: () => nCanvas?.fitSelection() },
    { name: "Zoom 100%", hint: "true size, keeps the centre point", key: "0", run: () => nCanvas?.resetZoom() },
    { name: "Center selection", hint: "pan without changing zoom", key: "C", run: () => nCanvas?.centerSelection() },
    {
      name: "Focus selected widget",
      hint: "spotlight it alone — Esc restores the view",
      key: "F",
      run: () => {
        const item = nCanvas?.activeItem();
        if (item) nCanvas?.toggleFocusMode(item);
      },
    },
    { name: "Select tool", hint: "left-drag marquee-selects", key: "V", run: () => nCanvas?.setToolMode("select") },
    { name: "Hand tool", hint: "left-drag pans", key: "H", run: () => nCanvas?.setToolMode("hand") },
    {
      name: "Toggle minimap",
      hint: "the map in the corner",
      key: "M",
      run: () => setCanvasMap(!(canvasPrefs.mapHidden === true)),
    },
  ];
}

let paletteIndex = 0;
let paletteReturnFocus: HTMLElement | null = null;
function paletteOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-palette")?.hidden === false;
}
function setPalette(open: boolean): void {
  const root = rdRoot;
  const overlay = root?.querySelector<HTMLElement>(".rd-palette");
  if (!root || !overlay) return;
  if (overlay.hidden === !open) return;
  if (open) {
    // Only one modal surface owns focus at a time. In particular, Ctrl/Cmd+K
    // replaces an open device picker or shortcut sheet instead of focusing a
    // palette hidden behind it.
    if (devModalIsOpen()) setDevModal(false);
    if (ctrlModalIsOpen()) setCtrlModal(false);
    if (sheetOpen()) setSheet(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    paletteReturnFocus = activeControl();
  }
  overlay.hidden = !open;
  if (!open) {
    const target = paletteReturnFocus;
    paletteReturnFocus = null;
    restoreOverlayFocus(target);
    return;
  }
  const input = overlay.querySelector<HTMLInputElement>(".rd-palette-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  paletteIndex = 0;
  renderPalette("");
}

function trapDialogTab(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const card = event.currentTarget as HTMLElement;
  const controls = Array.from(
    card.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((control) => !control.hidden && !control.closest("[hidden]"));
  if (controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  if (!card.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Fly the camera to one widget — the palette's landing. The design's rule:
 *  at least 90% zoom, centre it, pulse its outline so the eye finds it. */
function flyToWidget(item: HTMLElement): void {
  const canvas = nCanvas;
  if (!canvas) return;
  if (canvas.isFocusModeActive()) canvas.exitFocusMode();
  canvas.pushCameraHistory("before search jump");
  // Zoom and pan share one camera transaction; splitting them would snap to
  // 90% before the centre tween begins under normal-motion preferences.
  canvas.centerItem(item, { minimumZoom: 0.9 });
  const panel = inspectorEl();
  if (panel && !panel.hidden && inspectorInset() === 0) {
    panel.querySelector<HTMLButtonElement>('[data-nx="rd-insp-close"]')
      ?.focus({ preventScroll: true });
  } else {
    item.focus({ preventScroll: true });
  }
  item.classList.add("rd-pulse");
  window.setTimeout(() => item.classList.remove("rd-pulse"), 1500);
}

function renderPalette(query: string): void {
  const root = rdRoot;
  const list = root?.querySelector<HTMLElement>(".rd-palette-list");
  if (!root || !list) return;
  const needle = query.trim().toLowerCase();
  const widgets = Array.from(
    root.querySelectorAll<HTMLElement>(".n-canvas [data-instance-id][data-widget-name]"),
  );
  const widgetRows = widgets
    .map((item) => ({
      name: item.dataset.widgetName ?? "",
      hint: "widget on this canvas",
      key: "",
      run: () => flyToWidget(item),
    }))
    .filter((row) => row.name);
  const commandRows = paletteCommands();
  const rows = needle
    ? [...widgetRows, ...commandRows]
      .filter((row) =>
        row.name.toLowerCase().includes(needle) ||
        row.hint.toLowerCase().includes(needle)
      )
      .slice(0, PALETTE_RESULT_LIMIT)
    : [
      ...widgetRows.slice(0, PALETTE_DEFAULT_WIDGET_LIMIT),
      ...commandRows.slice(0, PALETTE_DEFAULT_COMMAND_LIMIT),
    ];
  if (paletteIndex >= rows.length) paletteIndex = Math.max(0, rows.length - 1);
  const renderedRows = rows.map((row, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rd-palette-row";
    if (index === paletteIndex) button.setAttribute("aria-current", "true");
    const name = document.createElement("span");
    name.className = "rd-palette-name";
    name.textContent = row.name;
    const hint = document.createElement("span");
    hint.className = "rd-palette-hint";
    hint.textContent = row.hint;
    button.append(name, hint);
    if (row.key) {
      const key = document.createElement("kbd");
      key.className = "rd-palette-key";
      key.textContent = row.key;
      button.append(key);
    }
    button.addEventListener("click", () => {
      setPalette(false);
      row.run();
    });
    li.append(button);
    return li;
  });
  if (renderedRows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rd-palette-empty";
    empty.setAttribute("role", "status");
    empty.textContent = `Nothing matches “${query.trim()}”`;
    renderedRows.push(empty);
  }
  list.replaceChildren(...renderedRows);
  list.dataset.rowCount = String(rows.length);
}

function paletteKeydown(event: KeyboardEvent): void {
  const list = rdRoot?.querySelector<HTMLElement>(".rd-palette-list");
  const count = Number(list?.dataset.rowCount ?? "0");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count === 0) return;
    paletteIndex = event.key === "ArrowDown"
      ? (paletteIndex + 1) % count
      : (paletteIndex - 1 + count) % count;
    const input = rdRoot?.querySelector<HTMLInputElement>(".rd-palette-input");
    renderPalette(input?.value ?? "");
  } else if (event.key === "Enter") {
    event.preventDefault();
    list
      ?.querySelectorAll<HTMLButtonElement>(".rd-palette-row")
      [paletteIndex]?.click();
  }
}

// ── The inspector (design handoff §7): overlay, never reflow ────────────────
// Served hidden; everything dynamic lives in one data-client-subtree box.
// Opening declares its width to the engine as the safe-viewport inset and
// pans by exactly the overlap needed to keep the active widget clear.

function inspectorEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-inspector") ?? null;
}

function inspectorInset(): number {
  const panel = inspectorEl();
  if (!panel || panel.hidden) return 0;
  const panelRect = panel.getBoundingClientRect();
  const viewportRect = rdRoot
    ?.querySelector<HTMLElement>(".forma-canvas-viewport")
    ?.getBoundingClientRect();
  // At the mobile breakpoint the Inspector is a full-screen drawer, not a
  // right-side obstruction. Feeding its 100vw width into the safe-inset
  // camera math leaves no usable canvas and produces a large hidden pan.
  if (viewportRect && panelRect.width >= viewportRect.width - 1) return 0;
  return Math.min(panelRect.width, viewportRect?.width ?? panelRect.width);
}

function numberField(
  label: string,
  value: number,
  onCommit: (next: number) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "rd-insp-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onCommit(next);
  });
  wrap.append(caption, input);
  return wrap;
}

function inspectorButton(label: string, nx: string, title: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "n-autobtn";
  button.dataset.nx = nx;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = label;
  return button;
}

export interface RedesignRefreshOptions {
  fresh?: boolean;
}

/** The entry's payload refetcher — registered at activation (setNocturnePoll's
 *  pattern) so the island can ask for another slot's panel without owning
 *  fetch. `fresh` is reserved for an explicit user Rescan; ordinary polls
 *  continue to benefit from the shared machine-read cache. */
let redesignRefreshFn: (options?: RedesignRefreshOptions) => Promise<boolean> = async () => false;
export function setRedesignRefresh(
  fn: (options?: RedesignRefreshOptions) => Promise<boolean>,
): void {
  redesignRefreshFn = fn;
}

export type RedesignDeviceMutationAction = "add" | "remove";
export interface RedesignDeviceMutationOptions {
  confirmRemove?: boolean;
  expectedRevision?: string;
  expectedSourceRevision?: string;
}

/** Device membership is daemon-owned even though canvas geometry is browser
 * owned. The entry injects the shared mutation/refresh coordinator so picker
 * clicks cannot race a poll or another form action. */
let redesignDeviceMutationFn: (
  action: RedesignDeviceMutationAction,
  row: RdDeviceRowView,
  options?: RedesignDeviceMutationOptions,
) => Promise<boolean> = async () => false;

export function setRedesignDeviceMutation(
  fn: typeof redesignDeviceMutationFn,
): void {
  redesignDeviceMutationFn = fn;
}

/** Merge `?slot=N` into the URL — the nocturne selection door's rule:
 *  MERGE, never replace, so other params survive, and a reload keeps the
 *  selection. Returns whether the URL actually changed (the guard that
 *  stops a repaint→refetch loop when a slot's panel cannot be served). */
function mergeSlotIntoUrl(slot: string): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get("slot") === slot) return false;
  url.searchParams.set("slot", slot);
  window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  return true;
}

function currentAuthoringSource(): string {
  return new URLSearchParams(window.location.search).get("source")?.trim() ?? "";
}

/** Select one keyboard as the inspector/listen context. This does not enable,
 * disable, or reroute any peer: all staged keyboard graphs remain live. */
function mergeSourceIntoUrl(selector: string, resetMacro = true): boolean {
  const source = selector.trim();
  if (!source) return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get("source") === source) return false;
  url.searchParams.set("source", source);
  if (resetMacro) url.searchParams.delete("macro");
  url.searchParams.delete("flash");
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}`);
  return true;
}

let bindingFilterTimer = 0;

function currentBindingQuery(): string {
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

/** Keep slot/macro and every future query door intact. The one-shot flash is
 * deliberately retired when the user starts a new navigation intent. */
function mergeBindingQueryIntoUrl(query: string): boolean {
  const url = new URL(window.location.href);
  const next = query.trim();
  if (next) url.searchParams.set("q", next);
  else url.searchParams.delete("q");
  url.searchParams.delete("flash");
  const href = `${url.pathname}${url.searchParams.size ? `?${url.searchParams.toString()}` : ""}`;
  if (`${window.location.pathname}${window.location.search}` === href) return false;
  window.history.replaceState(null, "", href);
  return true;
}

/** Immediate twin of snapshot.rs' server-side q sweep: a control matches
 * its own visible label or its group's label; empty groups collapse whole.
 * The debounced payload refresh then makes that same result authoritative. */
function applyBindingFilter(body: HTMLElement, query: string): void {
  const needle = query.trim().toLocaleLowerCase();
  let visible = 0;
  let total = 0;
  for (const group of Array.from(
    body.querySelectorAll<HTMLElement>(".n-bindgroups > section.n-bindg"),
  )) {
    const groupLabel = group.querySelector(".n-bindg-lab")?.textContent?.trim() ?? "";
    const groupMatches = groupLabel.toLocaleLowerCase().includes(needle);
    let groupVisible = 0;
    const candidates = Array.from(
      group.querySelectorAll<HTMLElement>("details.n-bind, .n-ctlstrip > [data-fn]"),
    );
    for (const candidate of candidates) {
      total += 1;
      const label = candidate.matches("details.n-bind")
        ? candidate.querySelector(".n-bind-label")?.textContent?.trim() ?? ""
        : candidate.textContent?.trim() ?? "";
      const matches = !needle || groupMatches || label.toLocaleLowerCase().includes(needle);
      candidate.classList.toggle("hide", !matches);
      if (matches) {
        visible += 1;
        groupVisible += 1;
      }
    }
    group.classList.toggle("empty", candidates.length > 0 && groupVisible === 0);
  }
  const output = body.querySelector<HTMLOutputElement>(".rd-binding-filter-count");
  if (output) {
    output.value = needle
      ? `${visible} of ${total} controls`
      : `${total} control${total === 1 ? "" : "s"}`;
    output.textContent = output.value;
  }
  const reset = body.querySelector<HTMLButtonElement>(".rd-binding-filter-reset");
  if (reset) reset.disabled = !needle;
}

function bindingFilter(slot: string): HTMLElement {
  const form = document.createElement("form");
  form.className = "rd-binding-filter";
  form.method = "get";
  form.action = "/redesign";
  form.setAttribute("role", "search");
  const label = document.createElement("label");
  label.htmlFor = `rd-binding-filter-${slot}`;
  label.textContent = "Find a control";
  const row = document.createElement("div");
  row.className = "rd-binding-filter-row";
  const input = document.createElement("input");
  input.id = `rd-binding-filter-${slot}`;
  input.className = "rd-binding-filter-input";
  input.type = "search";
  input.name = "q";
  input.autocomplete = "off";
  input.placeholder = "Buttons, sticks, system…";
  input.value = currentBindingQuery();
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "rd-binding-filter-reset";
  reset.textContent = "Reset";
  const output = document.createElement("output");
  output.className = "rd-binding-filter-count";
  output.setAttribute("aria-live", "polite");
  row.append(input, reset);
  form.append(label, row, output);

  const commit = (immediate: boolean) => {
    const body = form.closest<HTMLElement>(".rd-insp-body");
    const query = input.value.trim();
    if (body) applyBindingFilter(body, query);
    mergeBindingQueryIntoUrl(query);
    window.clearTimeout(bindingFilterTimer);
    if (immediate) void redesignRefreshFn();
    else bindingFilterTimer = window.setTimeout(() => void redesignRefreshFn(), 280);
  };
  input.addEventListener("input", () => commit(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    commit(true);
  });
  reset.addEventListener("click", () => {
    input.value = "";
    commit(true);
    input.focus({ preventScroll: true });
  });
  window.requestAnimationFrame(() => {
    const body = form.closest<HTMLElement>(".rd-insp-body");
    if (body) applyBindingFilter(body, input.value);
  });
  return form;
}

async function rescanDevices(button: HTMLButtonElement): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Rescanning…";
  rdAnnounce("Rescanning connected devices.");
  const refreshed = await redesignRefreshFn({ fresh: true });
  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.textContent = "Rescan";
  if (button.isConnected) button.focus({ preventScroll: true });
  rdAnnounce(
    refreshed
      ? "Connected devices refreshed."
      : "Device rescan could not finish. The last known list is still shown.",
  );
}

function inspectorFocusBookmark(body: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element) || !body.contains(active)) return null;
  if (active.id) return `#${CSS.escape(active.id)}`;
  if (active.matches("details.n-clearall > summary")) return "details.n-clearall > summary";
  if (active.matches("details.n-clearall button")) return "details.n-clearall button";
  if (active.matches("select.n-socd-sel")) return "select.n-socd-sel";
  if (active.matches("button.n-socd-set")) return "button.n-socd-set";
  if (active.matches(".rd-insp-vseg .vc")) return ".rd-insp-vseg .vc";
  if (active.matches(".rd-insp-vseg .vk")) return ".rd-insp-vseg .vk";

  const owner = active.closest<HTMLElement>("[data-fn], [data-key]");
  if (owner) {
    const attr = owner.dataset.fn !== undefined ? "data-fn" : "data-key";
    const value = owner.dataset.fn ?? owner.dataset.key ?? "";
    const ownerSelector = `[${attr}="${CSS.escape(value)}"]`;
    if (active.matches("summary")) return `${ownerSelector} > summary`;
    const nx = active.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    if (nx) return `${ownerSelector} [data-nx="${CSS.escape(nx)}"]`;
    if (active.matches("a[href]")) {
      const href = active.getAttribute("href");
      if (href) return `${ownerSelector} a[href="${CSS.escape(href)}"]`;
    }
  }
  const nx = active.closest<HTMLElement>("[data-nx]")?.dataset.nx;
  return nx ? `[data-nx="${CSS.escape(nx)}"]` : null;
}

function restoreInspectorFocus(body: HTMLElement, selector: string | null): void {
  if (!selector) return;
  body.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}

/** Repaint the inspector's body from the live selection. Called on every
 *  selection or item-state change while open. */
function renderInspector(): void {
  const canvas = nCanvas;
  const body = inspectorEl()?.querySelector<HTMLElement>(".rd-insp-body");
  if (!canvas || !body) return;
  const selected = canvas.selectedItems();
  const focusBookmark = inspectorFocusBookmark(body);
  // A background payload often changes nothing this inspector can show.
  // Keep the existing controls alive in that case: replacing an identical
  // tree would collapse consequence disclosures, reset an unsubmitted select
  // choice, and throw keyboard focus back to the page every two seconds.
  const controllerSelected = selected.some((item) =>
    /^ctrl-slot-\d+$/.test(item.dataset.instanceId ?? "")
  );
  const renderFingerprint = JSON.stringify([
    inspTab,
    currentAuthoringSource(),
    currentBindingQuery(),
    Object.entries(controllerColors).sort(([left], [right]) => left.localeCompare(right)),
    selected.map((item) => [
      item.dataset.instanceId ?? "",
      item.dataset.widgetName ?? "",
      canvas.getItemState(item),
    ]),
    controllerSelected
      ? [rdCtrlPanel, rdCtrlKeys, rdCtrlMacrosHead, rdCtrlMacroRows, rdCtrlMacrosNote]
      : null,
  ]);
  if (
    inspectorRenderFingerprints.get(body) === renderFingerprint &&
    pendingLocateFns === null &&
    pendingLocateKey === null
  ) {
    mapperRemark();
    return;
  }
  // A repaint must not lose the reader's place: every camera nudge and
  // item-state change lands here, and a full rebuild would collapse the
  // row someone just opened (or the one a pad-art click just located).
  const openFns = new Set(
    Array.from(body.querySelectorAll<HTMLElement>("details.n-bind[open]")).map(
      (row) => row.dataset.fn ?? "",
    ),
  );
  const clearAllWasOpen = Boolean(
    body.querySelector<HTMLDetailsElement>("details.n-clearall[open]"),
  );
  const keptScroll = body.scrollTop;
  const rows: (HTMLElement | null)[] = [];
  if (selected.length === 1) {
    const item = selected[0];
    const state = canvas.getItemState(item);
    const title = document.createElement("h2");
    title.className = "rd-insp-name";
    title.textContent = item.dataset.widgetName ?? item.dataset.instanceId ?? "Widget";
    const kind = document.createElement("p");
    kind.className = "rd-insp-kind";
    kind.textContent = `widget · ${Math.round(state.width)} × ${Math.round(state.height)}`;
    const scale = document.createElement("div");
    scale.className = "rd-insp-row";
    const scaleLabel = document.createElement("span");
    scaleLabel.className = "rd-insp-cap";
    scaleLabel.textContent = "Size";
    const smaller = inspectorButton("−", "rd-w-smaller", "Smaller");
    const pct = document.createElement("span");
    pct.className = "rd-insp-pct";
    pct.textContent = `${Math.round(state.manualScale * 100)}%`;
    const bigger = inspectorButton("+", "rd-w-bigger", "Bigger");
    const reset = inspectorButton("100%", "rd-w-reset", "Reset size");
    scale.append(scaleLabel, smaller, pct, bigger, reset);
    const position = document.createElement("div");
    position.className = "rd-insp-row";
    position.append(
      numberField("X", Math.round(state.x), (x) => {
        const current = canvas.getItemState(item);
        canvas.moveItemTo(item, x, current.y);
        renderInspector();
      }),
      numberField("Y", Math.round(state.y), (y) => {
        const current = canvas.getItemState(item);
        canvas.moveItemTo(item, current.x, y);
        renderInspector();
      }),
    );
    const verbs = document.createElement("div");
    verbs.className = "rd-insp-row";
    verbs.append(
      inspectorButton("Focus", "rd-focus-sel", "Spotlight it alone — Esc restores (F)"),
      inspectorButton("Fit", "rd-fit-sel", "Frame it (2)"),
      inspectorButton("Center", "rd-center-sel", "Pan it to the middle (C)"),
    );
    rows.push(title, kind, scale, position, verbs);
    // A CONTROLLER card carries the whole transplanted nocturne panel: the
    // meta strip, SOCD editor, slot verbs and the six bind groups, painted
    // from the served `ControllerPanel`. The panel is served for ONE slot
    // (the nocturne `?slot=` rule), so selecting a different card merges the
    // slot into the URL and refetches; the repaint lands here again with the
    // matching truth.
    const ctrlSlot = /^ctrl-slot-(\d+)$/.exec(item.dataset.instanceId ?? "")?.[1];
    if (ctrlSlot) {
      const moved = mergeSlotIntoUrl(ctrlSlot);
      if (moved) {
        // A seat change ends any armed mapping gesture (the pane speaks
        // for one controller at a time) and re-scopes the cords.
        mapperOnSlotChange();
        syncMappingCords();
      }
      if (rdCtrlPanel && rdCtrlKeys && rdCtrlPanel.slot_val === ctrlSlot) {
        const panelRows = renderControllerPanel(
          rdCtrlPanel,
          rdCtrlKeys,
          { head: rdCtrlMacrosHead, rows: rdCtrlMacroRows, note: rdCtrlMacrosNote },
          inspTab,
          setInspTab,
          rdDraftRevision(),
        );
        const controllerTools = [controllerIdentityColorEditor(Number(ctrlSlot))];
        const sourceEditor = controllerSourceEditor(Number(ctrlSlot));
        if (sourceEditor) controllerTools.unshift(sourceEditor);
        if (inspTab === "controls") controllerTools.push(bindingFilter(ctrlSlot));
        panelRows.splice(1, 0, ...controllerTools);
        rows.push(...panelRows);
      } else {
        const wait = document.createElement("p");
        wait.className = "rd-insp-kind";
        wait.textContent = "Fetching this controller's panel…";
        rows.push(wait);
        if (moved) void redesignRefreshFn();
      }
    }
  } else if (selected.length > 1) {
    // The multi-selection rules (design handoff §7): no empty sections —
    // only what applies to many. Selection origin moves the whole group by
    // the delta as ONE step.
    const bounds = selected.map((item) => canvas.getItemState(item));
    const minX = Math.min(...bounds.map((s) => s.x));
    const minY = Math.min(...bounds.map((s) => s.y));
    const maxX = Math.max(...bounds.map((s) => s.x + s.width));
    const maxY = Math.max(...bounds.map((s) => s.y + s.height));
    const title = document.createElement("h2");
    title.className = "rd-insp-name";
    title.textContent = `${selected.length} widgets selected`;
    const kind = document.createElement("p");
    kind.className = "rd-insp-kind";
    kind.textContent = `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} box`;
    const origin = document.createElement("div");
    origin.className = "rd-insp-row";
    origin.append(
      numberField("Origin X", Math.round(minX), (x) => {
        nCanvas?.moveSelectionBy(Math.round(x - minX), 0);
        renderInspector();
      }),
      numberField("Origin Y", Math.round(minY), (y) => {
        nCanvas?.moveSelectionBy(0, Math.round(y - minY));
        renderInspector();
      }),
    );
    const verbs = document.createElement("div");
    verbs.className = "rd-insp-row";
    verbs.append(
      inspectorButton("Fit", "rd-fit-sel", "Frame the selection (2)"),
      inspectorButton("Center", "rd-center-sel", "Pan the selection to the middle (C)"),
    );
    rows.push(title, kind, origin, verbs);
  }
  body.replaceChildren(...rows.filter((row): row is HTMLElement => Boolean(row)));
  const inspectorKeys = body.querySelector<HTMLElement>(".rd-insp-krows");
  const inspectorSource = currentAuthoringSource();
  if (inspectorKeys && inspectorSource) inspectorKeys.dataset.sourceId = inspectorSource;
  inspectorRenderFingerprints.set(body, renderFingerprint);
  // Restore the reader's place: rows they had open stay open, and the
  // panel does not jump back to its top on every repaint.
  for (const row of Array.from(body.querySelectorAll<HTMLElement>("details.n-bind"))) {
    if (openFns.has(row.dataset.fn ?? "")) (row as HTMLDetailsElement).open = true;
  }
  if (clearAllWasOpen) {
    const clearAll = body.querySelector<HTMLDetailsElement>("details.n-clearall");
    if (clearAll) clearAll.open = true;
  }
  body.scrollTop = keptScroll;
  restoreInspectorFocus(body, focusBookmark);
  // The locate pass: a click on a pad-art zone (the 4460 pointer
  // enhancement) or a Keys-row jump named a control — open its row in the
  // freshly painted Controls view. A jump's target wins (it just switched
  // the tab); an unmatched pending target survives one repaint so the
  // panel refetch can satisfy it.
  const jump = takePendingJumpFns();
  if (jump) pendingLocateFns = jump;
  if (pendingLocateFns && inspTab === "controls") {
    if (body.querySelector("details.n-bind")) {
      locateBindRow(body, pendingLocateFns);
      pendingLocateFns = null;
    }
  }
  // A plate-cell click named a KEY: reveal its row (bound) or its free
  // chip in the freshly painted Keys view.
  mapperRemark();
  if (pendingLocateKey && inspTab === "keys") {
    const wanted = pendingLocateKey;
    const row =
      body.querySelector<HTMLElement>(`.rd-insp-krows .n-krow[data-key="${CSS.escape(wanted)}"]`) ??
      body.querySelector<HTMLElement>(`.rd-insp-krows .n-akey[data-key="${CSS.escape(wanted)}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("rd-row-pulse");
      window.setTimeout(() => row.classList.remove("rd-row-pulse"), 1400);
      pendingLocateKey = null;
    } else if (body.querySelector(".rd-insp-krows")) {
      // The Keys view painted and the key is genuinely absent (another
      // player's, or not on this slot) — consume rather than loop.
      pendingLocateKey = null;
    }
  }
}

function setInspector(open: boolean): void {
  // The Add tray is a composition surface, so every Inspector-open path —
  // selection changes, focus mode, key location, and pad-art activation —
  // yields while it owns the workbench edge. The add-session bookkeeping
  // separately remembers whether the Inspector was open before composition
  // and whether a selection or direct widget action requested inspection
  // during it. Nothing covers the live canvas while adding; Done resumes the
  // established add → inspect handoff only when there was real intent.
  if (open && (devModalIsOpen() || ctrlModalIsOpen())) {
    addPanelDeferredInspector = true;
    return;
  }
  const panel = inspectorEl();
  const canvas = nCanvas;
  if (!panel || !canvas) return;
  const wasOpen = !panel.hidden;
  panel.hidden = !open;
  rdRoot?.classList.toggle("is-inspector-open", open);
  const inset = inspectorInset();
  canvas.setSafeInsetRight(inset);
  if (open) {
    renderInspector();
    // The design's panel rule: zoom preserved, pan by exactly the overlap —
    // often zero — and only when the panel is NEWLY open.
    if (!wasOpen && inset > 0) canvas.keepActiveClear();
  }
  syncChips();
}

function syncInspectorToSelection(items: HTMLElement[]): void {
  if (items.length === 0) {
    setInspector(false);
    return;
  }
  if (items.length === 1 && items[0].classList.contains("rd-keyboard-device-node")) {
    const selector = items[0].dataset.sourceId ?? items[0].dataset.selector ?? "";
    if (mergeSourceIntoUrl(selector)) {
      // Source focus is an editing context, never an exclusivity switch. An
      // armed gesture still belongs to the old context and must retire before
      // the exact-source panel is fetched.
      mapperOnSlotChange();
      void redesignRefreshFn();
    }
  }
  // Composition gating lives in setInspector so direct widget actions obey
  // the same rule as ordinary selection changes.
  // Dismissal belongs to the selection that was on screen when X was
  // pressed. A later selection is a new editing intent and reopens the
  // inspector — otherwise its body silently updates while the panel stays
  // closed, with no visible way back in.
  setInspector(true);
}

// ── Off-screen proximity chips (design handoff §6.5) ────────────────────────
// Recomputed on camera SETTLE (150ms debounce), never per frame — arrows
// that jitter during a pan are worse than arrows that appear when you stop.

let chipsTimer = 0;
function scheduleChips(): void {
  window.clearTimeout(chipsTimer);
  chipsTimer = window.setTimeout(syncChips, 150);
}

function syncChips(): void {
  const root = rdRoot;
  const canvas = nCanvas;
  const rail = root?.querySelector<HTMLElement>(".rd-chips");
  if (!root || !canvas || !rail) return;
  // Focus mode masks getCamera() to the entry camera; screen-space chrome
  // cannot be computed there, and focus dims the world anyway.
  if (canvas.isFocusModeActive()) {
    rail.replaceChildren();
    return;
  }
  const viewport = root.querySelector<HTMLElement>(".forma-canvas-viewport");
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return;
  const camera = canvas.getCamera();
  const inset = inspectorInset();
  const safeWidth = rect.width - inset;
  if (safeWidth <= 80) {
    rail.replaceChildren();
    return;
  }
  const centerWorldX = (safeWidth / 2 - camera.panX) / camera.zoom;
  const centerWorldY = (rect.height / 2 - camera.panY) / camera.zoom;
  const offscreen: { item: HTMLElement; name: string; sx: number; sy: number; dist: number }[] = [];
  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".forma-canvas-stage > [data-instance-id]"),
  )) {
    if (item.dataset.canvasX === undefined) continue;
    const state = canvas.getItemState(item);
    const cx = state.x + state.width / 2;
    const cy = state.y + state.height / 2;
    const sx = cx * camera.zoom + camera.panX;
    const sy = cy * camera.zoom + camera.panY;
    const right = (state.x + state.width) * camera.zoom + camera.panX;
    const left = state.x * camera.zoom + camera.panX;
    const top = state.y * camera.zoom + camera.panY;
    const bottom = (state.y + state.height) * camera.zoom + camera.panY;
    // The inspector counts as off-screen: a widget behind the panel
    // announces itself.
    const visible = right > 0 && left < safeWidth && bottom > 0 && top < rect.height;
    if (visible) continue;
    offscreen.push({
      item,
      name: item.dataset.widgetName ?? item.dataset.instanceId ?? "widget",
      sx,
      sy,
      dist: Math.round(Math.hypot(cx - centerWorldX, cy - centerWorldY)),
    });
  }
  offscreen.sort((a, b) => a.dist - b.dist);
  const placed: { x: number; y: number }[] = [];
  rail.replaceChildren(
    ...offscreen.slice(0, 4).map(({ item, name, sx, sy, dist }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rd-chip";
      // Clamped clear of the lane's own corners (the tool rail, the map
      // panel, the zoom pill) — a chip under other chrome is a control that
      // cannot be pressed — and SPREAD when several widgets sit off in the
      // same direction, or the nearer chip buries the rest.
      let x = Math.min(Math.max(sx, 96), safeWidth - 20);
      let y = Math.min(Math.max(sy, 56), rect.height - 72);
      while (placed.some((p) => Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 30)) {
        y = Math.min(y + 34, rect.height - 72);
        if (y >= rect.height - 72) x += 120;
      }
      placed.push({ x, y });
      chip.style.left = `${x}px`;
      chip.style.top = `${y}px`;
      const angle = Math.atan2(
        sy - rect.height / 2,
        sx - safeWidth / 2,
      );
      const caret = document.createElement("span");
      caret.className = "rd-chip-caret";
      caret.style.transform = `rotate(${Math.round((angle * 180) / Math.PI)}deg)`;
      caret.textContent = "➤";
      const label = document.createElement("span");
      label.textContent = `${name} · ${dist}px`;
      chip.append(caret, label);
      chip.addEventListener("click", () => flyToWidget(item));
      return chip;
    }),
  );
}

// ── Hover spotlight v0 (design handoff §6.5) ────────────────────────────────
// Hover a widget, dim the rest. Suppressed while a gesture or focus mode is
// active. Becomes the SIGNAL TRACE when binding edges transplant in.

function wireSpotlight(stage: HTMLElement, viewport: HTMLElement): void {
  stage.addEventListener("pointerover", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id]",
    );
    if (!item) return;
    if (
      viewport.classList.contains("is-panning") ||
      viewport.classList.contains("is-dragging-widget") ||
      nCanvas?.isFocusModeActive()
    ) return;
    stage.classList.add("rd-spotlighting");
    item.classList.add("rd-spot");
  });
  stage.addEventListener("pointerout", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id]",
    );
    if (!item) return;
    // pointerout bubbles for every child boundary. Moving from a summary into
    // its detail rows is still hovering the same widget and must not flash the
    // rest of the canvas off and back on.
    if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
    stage.classList.remove("rd-spotlighting");
    item.classList.remove("rd-spot");
  });
}

// The mock nodes lived here until 2026-08-28 — two disposable widgets that
// gave selection, marquee, drag, focus, fit and the semantic tiers something
// to act on. The first product transplant (the device workbench) landed, so
// they are gone, exactly as their own comment promised. The workbench starts
// EMPTY on purpose: boards arrive through the picker.

// ── The device workbench (the lane's thesis made real) ──────────────────────
// The canvas is a WORKBENCH: the picker adds boards to it — several at once —
// and each lands as a widget. Canvas Add owns explicit placement; the daemon's
// staged roster authorizes that remembered membership when the exact board is
// present. That distinction matters after Start over or a daemon restart:
// stale browser placement must not resurrect an unstaged input, while a
// temporarily absent board can still reclaim its geometry. Widgets are
// client-created (`data-client-widget` — parity rule 3e); they are the real
// product surface that replaced the disposable mock nodes.

function benchSelectors(): string[] {
  return canvasPrefs.bench ?? [];
}

/** Ownership for the old lossy storage keys during this canvas lifetime.
 * Twin selectors may share a legacy key, but never its coordinates. */
const legacyGeometryOwners = new Map<string, string>();

function deviceRowFor(selector: string): RdDeviceRowView | undefined {
  return [...rdDevKb(), ...rdDevEnc(), ...rdDevExp()].find((r) => r.selector === selector);
}

function deviceRowConnected(row: RdDeviceRowView | undefined): boolean {
  return rdDeviceScanAuthoritative && Boolean(row) && row?.role !== "offline-source";
}

/** Canvas chrome names a physical endpoint, not merely its product model.
 * A unique model name stays compact; twins gain the server-authored
 * connection identity that distinguishes their exact selectors. This is
 * presentation only -- actions still carry the untouched selector. */
function deviceCanvasLabel(row: RdDeviceRowView): string {
  const name = row.name.trim() || row.label.trim() || row.alias.trim() || "Physical device";
  const peers = [...rdDevKb(), ...rdDevEnc(), ...rdDevExp()];
  const isTwin = peers.some((candidate) =>
    candidate.selector !== row.selector &&
    candidate.role === row.role &&
    candidate.name.trim().toLocaleLowerCase() === row.name.trim().toLocaleLowerCase()
  );
  if (!isTwin) return name;
  const connection = row.connection_label.trim();
  const alias = row.alias.trim();
  const identity = connection ||
    (alias.toLocaleLowerCase() !== name.toLocaleLowerCase() ? alias : "") ||
    row.selector;
  return `${name} · ${identity}`;
}

/** Staged sources can outlive a scan row. Prefer the same collision-aware
 * board label while connected, then fall back to the staged alias/selector
 * so two identical disconnected sources remain distinguishable. */
function controllerSourceLabel(
  source: RdPadSourceView,
  peers: RdPadSourceView[],
): string {
  const row = deviceRowFor(source.source_id);
  if (row) return deviceCanvasLabel(row);
  const label = source.source_label?.trim() || source.source_alias?.trim() || source.source_id;
  const twin = peers.some((candidate) =>
    candidate.source_id !== source.source_id &&
    (candidate.source_label?.trim() || candidate.source_alias?.trim() || candidate.source_id)
      .toLocaleLowerCase() === label.toLocaleLowerCase()
  );
  if (!twin) return label;
  const alias = source.source_alias?.trim() ?? "";
  const identity = alias && alias.toLocaleLowerCase() !== label.toLocaleLowerCase()
    ? alias
    : source.source_id;
  return `${label} · ${identity}`;
}

const DEVICE_ROLE_BADGE: Record<string, string> = {
  "panel-encoder": "Panel encoder",
  keyboard: "Physical keyboard",
  "offline-source": "Disconnected source",
};
const STAGED_DEVICE_TITLE =
  "This exact board is one independent source in the mapping draft. Peer keyboards and routes remain enabled.";
const KEYBOARD_MAPPING_READY_TITLE =
  "Bindings on this exact keyboard can be edited independently; the same key on another keyboard is a different signal.";
const DEVICE_CARD_MIN_HEIGHT = 220;
const KEYBOARD_DEVICE_WIDTH = 980;
// One physical keyboard is the full interactive board itself. The identity is
// carried by its board header and canvas chrome, not a second summary card.
const KEYBOARD_DEVICE_MIN_HEIGHT = 480;
const DEVICE_CARD_ROW_STRIDE = DEVICE_CARD_MIN_HEIGHT + CANVAS_FRESH_PLACEMENT_GAP;

function deviceCardPurpose(row: RdDeviceRowView): string {
  if (row.role === "offline-source") {
    return "This exact source is still in the mapping draft. Reconnect it to resume input, or remove it here; peer sources and controllers remain unchanged.";
  }
  const authorityUnknown = !rdDeviceScanAuthoritative || !rdStagingReachable;
  if (authorityUnknown) {
    const kind = row.role === "keyboard" ? "physical keyboard" : "encoder";
    if (row.role === "keyboard") {
      return `This ${kind} remains on the canvas. Device status is unavailable, so its mapping controls stay read-only until KSX confirms the exact connection.`;
    }
    return row.aria_current === "true"
      ? `This ${kind} was part of the mapping draft. Status is unavailable, so its controls stay paused until KSX confirms it.`
      : `This ${kind} remains on the canvas while device status is unavailable.`;
  }
  if (row.role === "keyboard") {
    return row.aria_current === "true"
      ? "This physical keyboard is an independent source. Its keys and controller routes are edited separately from every peer."
      : "This physical keyboard has its own board but is not in the mapping draft yet.";
  }
  return row.aria_current === "true"
    ? "This encoder is an independent source. Its configured terminal emissions are mapping anchors."
    : "This board is on the canvas for inspection. Add it to the draft to map its emitted keys.";
}

function deviceCardMeta(row: RdDeviceRowView): string {
  if (row.role !== "panel-encoder") return row.meta;
  // The encoder surface owns the live read/loading/error state. The roster's
  // initial `chart not read yet` phrase becomes stale as soon as the automatic
  // read starts and should not survive beside the authoritative surface.
  return row.meta.split(/\s*·\s*/)
    .filter((part) => !/^chart\b/i.test(part.trim()))
    .join(" · ");
}

interface RdDeviceStateBadge {
  label: string;
  state: "connected" | "canvas" | "source" | "ready" | "attention";
}

/** One vocabulary for device state everywhere it appears. A board can hold
 * several independent facts at once (connected + on canvas + mapping source),
 * so these are badges rather than one lossy status sentence. */
function deviceStateBadges(row: RdDeviceRowView): RdDeviceStateBadge[] {
  const badges: RdDeviceStateBadge[] = [];
  if (row.role === "offline-source") {
    badges.push({ label: "Disconnected", state: "attention" });
    badges.push({ label: "On canvas", state: "canvas" });
    badges.push({ label: "Independent source", state: "source" });
    return badges;
  }
  if (rdDeviceScanAuthoritative) badges.push({ label: "Connected", state: "connected" });
  badges.push({ label: "On canvas", state: "canvas" });
  if (row.role === "keyboard") {
    if (!rdDeviceScanAuthoritative || !rdStagingReachable) {
      badges.push({ label: "Source status unavailable", state: "attention" });
      return badges;
    }
    if (row.aria_current === "true") {
      badges.push({ label: "Independent source", state: "source" });
      badges.push({ label: "Mapping ready", state: "ready" });
    } else badges.push({ label: "Not in draft", state: "attention" });
    return badges;
  }
  if (row.aria_current !== "true") return badges;

  if (!rdDeviceScanAuthoritative || !rdStagingReachable) {
    badges.push({ label: "Source status unavailable", state: "attention" });
    return badges;
  }

  badges.push({ label: "Independent source", state: "source" });
  if (row.capture_badge) {
    badges.push({
      label: row.capture_badge,
      state: row.capture_state === "attention" ? "attention" : "ready",
    });
  }
  return badges;
}

function syncDeviceCardStateBadges(item: HTMLElement, row: RdDeviceRowView): void {
  const list = item.querySelector<HTMLElement>(".rd-devcard-states");
  if (!list) return;
  list.replaceChildren(
    ...deviceStateBadges(row).map((badge) => {
      const chip = document.createElement("span");
      chip.className = "rd-device-state";
      chip.dataset.state = badge.state;
      chip.textContent = badge.label;
      return chip;
    }),
  );
}

function deviceCardContent(row: RdDeviceRowView): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-devcard";
  const badge = document.createElement("p");
  badge.className = "rd-devcard-badge";
  badge.dataset.role = row.role;
  badge.textContent = DEVICE_ROLE_BADGE[row.role] ?? "Experimental";
  const name = document.createElement("p");
  name.className = "rd-devcard-name";
  name.textContent = row.name;
  const meta = document.createElement("p");
  meta.className = "rd-devcard-meta";
  meta.textContent = deviceCardMeta(row);
  const states = document.createElement("p");
  states.className = "rd-devcard-states";
  const staged = document.createElement("p");
  staged.className = "rd-devcard-staged";
  staged.textContent = row.aria_current === "true"
    ? "Independent mapping source"
    : "On-canvas preview";
  staged.title = row.role === "keyboard" ? KEYBOARD_MAPPING_READY_TITLE : STAGED_DEVICE_TITLE;
  const purpose = document.createElement("p");
  purpose.className = "rd-devcard-purpose";
  purpose.textContent = deviceCardPurpose(row);
  const form = document.createElement("form");
  form.className = "rd-stageform";
  form.method = "post";
  form.action = "/redesign/device";
  form.dataset.rdForm = "device";
  for (const [fieldName, value] of [
    ["selector", row.selector],
    ["alias", row.alias],
    ["label", row.label],
  ]) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = fieldName;
    input.value = value;
    form.append(input);
  }
  const submit = document.createElement("button");
  const offline = row.role === "offline-source";
  submit.type = offline ? "button" : "submit";
  submit.className = "rd-stagebtn";
  submit.textContent = offline ? "Remove disconnected source" : "Add to mapping draft";
  submit.title = offline
    ? "Remove this exact disconnected source and its routes. Peer sources and controllers stay unchanged."
    : "Add this exact device as an independent mapping source. Existing keyboards and routes stay unchanged.";
  if (offline) submit.dataset.nx = "rd-offline-remove";
  submit.hidden = row.aria_current === "true" && !offline;
  form.append(submit);
  body.append(badge, name, meta);
  body.append(states, purpose, staged, form);
  syncDeviceCardStateBadges(body, row);
  return body;
}

/** A physical keyboard is one canvas object: its identity and one persistent
 * full keyboard surface. The hidden reactive blueprint is cloned exactly once
 * per intentionally added device; no peer ever borrows this subtree. */
function keyboardDeviceContent(row: RdDeviceRowView, instanceId: string): HTMLElement {
  const shell = document.createElement("section");
  shell.className = "rd-keyboard-device-shell";
  const host = createKeyboardSurfaceHost(document);
  const template = keyboardSurfaceTemplate;
  if (template) {
    host.append(createKeyboardSurfaceInstance(template, {
      sourceId: row.selector,
      instanceId,
      sourceLabel: deviceCanvasLabel(row),
      mappingAvailable: row.aria_current === "true" &&
        rdDeviceScanAuthoritative && rdStagingReachable,
    }));
  }
  const mappingStatus = document.createElement("p");
  mappingStatus.className = "rd-keyboard-mapping-status";
  mappingStatus.dataset.rdKeyboardMappingStatus = "";
  shell.append(host, mappingStatus);
  return shell;
}

function encoderDeviceFromRow(row: RdDeviceRowView): EncoderProfileLabDevice {
  return {
    selector: row.selector,
    name: row.name,
    alias: row.alias,
    meta: row.meta,
    backend: {
      role: row.role,
      familyId: row.family_id,
      familyLabel: row.family_id ? row.name : undefined,
      protocolProfileId: row.protocol_profile,
      profileState: row.profile_state,
      profileTerminalCount: row.terminal_count,
      capabilities: { canReadChart: row.chart_readable === "true" },
    },
  };
}

function disposeEncoderWorkbenchItem(item: HTMLElement): void {
  const surface = encoderWorkbenchSurfaces.get(item);
  if (!surface) return;
  encoderWorkbenchSurfaces.delete(item);
  surface.dispose();
}

/** Mount one board onto the workbench: the saved spot if this board has been
 *  here before (removal keeps geometry), otherwise a staggered open spot. */
function mountDeviceWidget(
  row: RdDeviceRowView,
  index: number,
  readStoredAssignmentsOnMount = false,
  focusOnMount = false,
): void {
  const canvas = nCanvas;
  if (!canvas) return;
  const slug = deviceInstanceId(row.selector);
  const savedGeometryKey = claimSavedDeviceGeometryKey(
    row.selector,
    new Set(Object.keys(canvasPrefs.widgets)),
    legacyGeometryOwners,
  );
  const selectorGeometry = savedGeometryKey ? canvasPrefs.widgets[savedGeometryKey] : undefined;
  const encoderSurface = row.role === "panel-encoder"
    ? createEncoderWorkbenchSurface(document, encoderDeviceFromRow(row), {
      readStoredAssignmentsOnMount,
      onFlowAnchorsChange: () => {
        syncMappingCords();
        rdRoot?.dispatchEvent(new CustomEvent("ksx:redesign-flow-anchors-change"));
      },
    })
    : null;
  const content = encoderSurface
    ? document.createElement("div")
    : row.role === "keyboard"
      ? keyboardDeviceContent(row, slug)
      : deviceCardContent(row);
  if (encoderSurface) {
    content.className = "rd-encoder-device-shell";
    content.append(deviceCardContent(row), encoderSurface.content);
  }
  const preferredWidth = encoderSurface
    ? 960
    : row.role === "keyboard"
      ? KEYBOARD_DEVICE_WIDTH
      : row.role === "offline-source" && isGeometry(selectorGeometry)
        ? selectorGeometry.width
        : 300;
  // Match the canvas engine's effective minimum exactly. Supplying a smaller
  // candidate makes collision allocation reason about geometry it will later
  // clamp, which can leave fresh rows closer than the engine's 40 px gap.
  const minHeight = encoderSurface
    ? 900
    : row.role === "keyboard"
      ? KEYBOARD_DEVICE_MIN_HEIGHT
      : DEVICE_CARD_MIN_HEIGHT;
  const item = createCanvasItem({
    instanceId: slug,
    displayName: deviceCanvasLabel(row),
    preferredWidth,
    minHeight,
    content,
    document,
  });
  item.dataset.clientWidget = "";
  item.dataset.selector = row.selector;
  item.dataset.deviceRole = row.role;
  item.dataset.staged = row.aria_current === "true" ? "true" : "false";
  item.dataset.sourceId = row.selector;
  item.dataset.sourceAlias = row.alias;
  item.dataset.sourceInstance = row.instance_id ?? "";
  item.dataset.sourceEnabled = deviceRowConnected(row) ? "true" : "unknown";
  item.dataset.mappingAvailable = deviceRowConnected(row) &&
      row.aria_current === "true" && rdStagingReachable
    ? "true"
    : "false";
  item.dataset.sourceState = deviceRowConnected(row) ? "enabled" : "unknown";
  item.classList.add("rd-dev-node");
  if (row.role === "keyboard") {
    item.classList.add("rd-keyboard-device-node", "n-widget", "n-widget-kb");
    item.dataset.keyboardTheme = kbTheme;
  }
  if (encoderSurface) {
    item.classList.add("rd-encoder-device-node");
    encoderWorkbenchSurfaces.set(item, encoderSurface);
  }
  const home: CanvasItemGeometry = {
    x: 140 + (index % 3) * (preferredWidth + CANVAS_FRESH_PLACEMENT_GAP),
    y: 160 + Math.floor(index / 3) * Math.max(
      DEVICE_CARD_ROW_STRIDE,
      minHeight + CANVAS_FRESH_PLACEMENT_GAP,
    ),
    width: preferredWidth,
    height: minHeight,
    z: 3 + index,
    manualScale: 1,
  };
  try {
    const legacyKeyboardGeometry = row.role === "keyboard" && !selectorGeometry &&
        row.aria_current === "true" && isGeometry(canvasPrefs.widgets.keyboard)
      ? canvasPrefs.widgets.keyboard
      : undefined;
    const retireLegacyKeyboardGeometry = row.role === "keyboard" &&
      row.aria_current === "true" && isGeometry(canvasPrefs.widgets.keyboard);
    if (
      row.role === "keyboard" &&
      !selectorGeometry &&
      row.aria_current !== "true" &&
      isGeometry(canvasPrefs.widgets.keyboard)
    ) {
      item.dataset.legacyKeyboardGeometryPending = "true";
    }
    const savedGeometry = selectorGeometry ?? legacyKeyboardGeometry;
    const normalizedSavedGeometry = savedGeometry && row.role === "keyboard"
      ? {
          ...savedGeometry,
          width: Math.max(KEYBOARD_DEVICE_WIDTH, savedGeometry.width),
          height: Math.max(KEYBOARD_DEVICE_MIN_HEIGHT, savedGeometry.height),
        }
      : savedGeometry;
    const keyboardGeometryExpanded = Boolean(
      savedGeometry && row.role === "keyboard" &&
        (savedGeometry.width < KEYBOARD_DEVICE_WIDTH ||
          savedGeometry.height < KEYBOARD_DEVICE_MIN_HEIGHT),
    );
    canvas.mountItem(
      item,
      normalizedSavedGeometry
        ? keyboardGeometryExpanded
          ? allocateFreshCanvasGeometry(normalizedSavedGeometry)
          : normalizedSavedGeometry
        : allocateFreshCanvasGeometry(home),
      { focus: focusOnMount },
    );
    if (item.dataset.legacyKeyboardGeometryPending === "true") {
      const spawn = canvas.getItemState(item);
      item.dataset.legacyKeyboardSpawnX = String(spawn.x);
      item.dataset.legacyKeyboardSpawnY = String(spawn.y);
      item.dataset.legacyKeyboardSpawnScale = String(spawn.manualScale);
    }
    if (retireLegacyKeyboardGeometry) {
      const nextWidgets = { ...canvasPrefs.widgets };
      delete nextWidgets.keyboard;
      nextWidgets[slug] = canvas.getItemState(item);
      canvasPrefs.widgets = nextWidgets;
      saveCanvasPrefs();
    }
    if (encoderSurface) {
      const viewport = (rdRoot ?? document).querySelector<HTMLElement>(".forma-canvas-viewport");
      if (focusOnMount) {
        // A visible Add starts one automatic read-only assignment request.
        // Frame its exact board at an honest editing scale so a failed request
        // can never strand Retry inside the semantic-zoom inert silhouette.
        const requiredZoom = encoderEditingZoom(canvas.getItemState(item).manualScale);
        canvas.centerItem(item, { minimumZoom: requiredZoom });
        syncEncoderEditingAccess("editing", requiredZoom);
      } else {
        syncEncoderEditingAccess(
          viewport?.dataset.canvasZoomTier ?? "editing",
          canvasZoomFromViewport(viewport),
        );
      }
    }
  } catch (error) {
    disposeEncoderWorkbenchItem(item);
    throw error;
  }
}

function benchItemEl(selector: string): HTMLElement | null {
  return (
    rdRoot?.querySelector<HTMLElement>(
      `.forma-canvas-stage > [data-instance-id="${deviceInstanceId(selector)}"]`,
    ) ?? null
  );
}

function rememberDeviceGeometry(item: HTMLElement): void {
  const canvas = nCanvas;
  const id = item.dataset.instanceId;
  if (!canvas || !id || item.dataset.canvasX === undefined) return;
  canvasPrefs.widgets = {
    ...canvasPrefs.widgets,
    [id]: canvas.getItemState(item),
  };
}

interface DeviceRouteUsage {
  slots: number[];
  bindings: number;
  macros: number;
}

function deviceRouteUsage(selector: string): DeviceRouteUsage {
  const usage: DeviceRouteUsage = { slots: [], bindings: 0, macros: 0 };
  for (const pad of rdCtrlPads) {
    const source = pad.sources?.find((candidate) => candidate.source_id === selector);
    if (!source?.routed) continue;
    const bindings = (source.controls ?? []).reduce(
      (count, control) => count + control.keys.length,
      0,
    );
    // Any authored macro makes removal destructive, including a disabled or
    // temporarily triggerless draft; the backend enforces the same rule.
    const macros = source.macros?.length ?? 0;
    if (bindings > 0 || macros > 0) usage.slots.push(pad.slot);
    usage.bindings += bindings;
    usage.macros += macros;
  }
  return usage;
}

/** Add or remove one exact board. Canvas membership and source membership are
 * one user decision: Add creates an independent staged source; Remove retires
 * that source after warning about any routes it owns. Geometry remains saved
 * locally so a later re-add returns to the same place. */
async function toggleBenchDevice(selector: string): Promise<void> {
  const bench = benchSelectors();
  const row = deviceRowFor(selector);
  if (!row) return;
  if (bench.includes(selector)) {
    const usage = deviceRouteUsage(selector);
    const hasMappings = usage.bindings > 0 || usage.macros > 0;
    if (hasMappings) {
      const destinations = usage.slots.map((slot) => `P${slot}`).join(", ");
      const accepted = window.confirm(
        `Remove ${deviceCanvasLabel(row)} from the canvas and mapping draft?\n\n` +
          `Its routes to ${destinations} will be removed. Controllers and other keyboards stay unchanged.`,
      );
      if (!accepted) return;
    }
    if (
      row.aria_current === "true" &&
      !(await redesignDeviceMutationFn("remove", row, {
        confirmRemove: hasMappings,
        expectedRevision: rdDraftRevision(),
        expectedSourceRevision: row.staged_revision ?? "",
      }))
    ) return;
    const item = benchItemEl(selector);
    if (item) {
      rememberDeviceGeometry(item);
      disposeEncoderWorkbenchItem(item);
      nCanvas?.removeItem(item, { selectFallback: false });
    }
    canvasPrefs.bench = bench.filter((s) => s !== selector);
  } else {
    if (
      row.aria_current !== "true" &&
      !(await redesignDeviceMutationFn("add", row))
    ) return;
    canvasPrefs.bench = [...bench, selector];
    const currentRow = deviceRowFor(selector);
    // Only refreshed served truth may create the canvas object. The board can
    // disconnect while its additive stage request is in flight, and a failed
    // refresh leaves the clicked row stale; either case must remember the
    // user's membership choice without mounting hardware that is no longer
    // known to be both present and staged. Reconciliation restores it at the
    // saved place when an authoritative scan offers the exact source again.
    if (
      currentRow?.aria_current === "true" && rdStagingReachable &&
      !benchItemEl(selector)
    ) {
      // The visible picker Add gesture authorizes one immediate, read-only
      // chart transaction. Passive restore/reconnect mounts use false.
      mountDeviceWidget(currentRow, bench.length, true, true);
    }
  }
  saveCanvasPrefs();
  syncMapCount();
  syncDeviceRows();
  // A card added while a mutation is pending or either provider is
  // unavailable must inherit that state immediately; the mount defaults are
  // only a structural fallback until served truth is applied.
  syncBenchCards();
}

/** Re-mount every remembered board whose device is still in the served
 *  roster. One that vanished stays remembered but not mounted — honestly
 *  absent, back the moment the scan offers it again. */
function restoreBench(): void {
  reconcileBenchWithRoster();
}

// ── Encoder profile lab (temporary review surface) ─────────────────────────
// One stable widget consumes passive backend identity facts and a sourced
// visual registry. Opening it never reads a chart; selecting a catalog model
// changes the drawing only and can never authorize a protocol.

function encoderProfileLabNode(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(
    `.forma-canvas-stage > .rd-encoder-profile-node[data-instance-id="${ENCODER_PROFILE_LAB_INSTANCE_ID}"]`,
  ) ?? null;
}

function syncEncoderProfileLabButton(): void {
  const button = rdRoot?.querySelector<HTMLButtonElement>(
    '[data-nx="rd-encoder-profiles"]',
  );
  if (!button) return;
  const shown = encoderProfileLabNode() !== null;
  button.setAttribute("aria-pressed", String(shown));
  button.textContent = "◇ Encoders";
  button.title = shown
    ? "Remove the encoder profile lab"
    : "Inspect connected and reference encoder profiles on the canvas";
}

/** The page's ONE assistive announce channel (`.n-live-sr`, role=status).
 *  Every announcer goes through here — encoder lab, mapper, cords — so two
 *  tenants cannot clobber each other through different queries; last write
 *  wins, which is a live region's own contract. */
export function rdAnnounce(message: string): void {
  const status = rdRoot?.querySelector<HTMLElement>(".n-live-sr");
  if (status) status.textContent = message;
}

function announceEncoderProfileLab(message: string): void {
  rdAnnounce(message);
}

function removeEncoderProfileLab(): void {
  const canvas = nCanvas;
  const returnCamera = encoderLabReturnCamera;
  const item = encoderProfileLabNode();
  if (item) disposeEncoderProfileLabCanvasItem(item);
  else disposeEncoderProfileLab?.();
  disposeEncoderProfileLab = null;
  if (item) {
    if (canvas) canvas.removeItem(item, { selectFallback: false });
    else item.remove();
  }
  refreshEncoderProfileLab = null;
  if (returnCamera && canvas) canvas.restoreCamera(returnCamera);
  encoderLabReturnCamera = null;
  const widgets = { ...canvasPrefs.widgets };
  delete widgets[ENCODER_PROFILE_LAB_INSTANCE_ID];
  canvasPrefs.widgets = widgets;
  if (returnCamera) canvasPrefs.camera = returnCamera;
  saveCanvasPrefs();
  syncEncoderProfileLabButton();
  syncMapCount();
  scheduleChips();
  announceEncoderProfileLab("Encoder profile lab removed. No hardware state changed.");
}

function encoderProfileLabDevices(): EncoderProfileLabDevice[] {
  return rdDevEnc().map(encoderDeviceFromRow);
}

function mountEncoderProfileLab(): void {
  const canvas = nCanvas;
  if (!canvas) return;
  const lab = createEncoderProfileLabCanvasItem(document, {
    connectedEncoders: encoderProfileLabDevices(),
  });
  try {
    const reservation = canvas.reserveItems(1);
    const returnCamera = canvas.getCamera();
    encoderLabReturnCamera = returnCamera;
    try {
      reservation.mountItem(
        lab.item,
        { ...lab.home, z: nextCanvasZ(lab.home.z) },
        { focus: false },
      );
      refreshEncoderProfileLab = lab.updateConnectedEncoders;
      disposeEncoderProfileLab = lab.dispose;
    } catch (error) {
      lab.dispose();
      encoderLabReturnCamera = null;
      refreshEncoderProfileLab = null;
      disposeEncoderProfileLab = null;
      throw error;
    } finally {
      reservation.release();
    }
  } catch (error) {
    // The controller installs a pagehide listener before capacity is known.
    // Every failed mount path must release that detached controller.
    lab.dispose();
    if (error instanceof WidgetCanvasCapacityError) {
      const free = Math.max(0, error.limit - error.current);
      announceEncoderProfileLab(
        `The encoder profile lab needs one open widget space; this canvas has ${free}. ` +
          "Remove widgets and try again.",
      );
      return;
    }
    throw error;
  }
  syncEncoderProfileLabButton();
  syncMapCount();
  scheduleChips();
  announceEncoderProfileLab(
    "Encoder profile lab added. It used passive identity facts and performed no hardware read or write.",
  );
  window.requestAnimationFrame(() => nCanvas?.fitAll());
}

function toggleEncoderProfileLab(): void {
  if (encoderProfileLabNode()) removeEncoderProfileLab();
  else mountEncoderProfileLab();
}

/** Reconcile browser-owned bench membership against current served truth.
 * An authoritative disconnect remounts a staged source as an honest neutral
 * recovery card; reconnecting remounts its real keyboard/encoder surface at
 * the same geometry. A scan refusal preserves the existing presentation
 * because absence is not proven in that state. */
function reconcileBenchWithRoster(): void {
  const canvas = nCanvas;
  if (!canvas) {
    syncDeviceRows();
    return;
  }

  let benchOrder = benchSelectors();
  let membershipChanged = false;
  if (rdStagingReachable && rdDeviceScanAuthoritative) {
    const rows = [...rdDevKb(), ...rdDevEnc(), ...rdDevExp()];
    const visible = new Map(rows.map((row) => [row.selector, row] as const));
    // A missing row may be a temporarily disconnected board; retain its
    // latent reconnect intent. A PRESENT row marked unstaged is conclusive:
    // Start over, daemon restart, or an external Remove must clear the node.
    const next = benchOrder.filter((selector) => {
      const row = visible.get(selector);
      return !row || row.aria_current === "true";
    });
    membershipChanged = next.length !== benchOrder.length ||
      next.some((selector, index) => selector !== benchOrder[index]);
    if (membershipChanged) {
      canvasPrefs.bench = next;
      benchOrder = next;
    }
  }

  const bench = new Set(benchOrder);
  const selectedIds = canvas.selectedItems()
    .map((item) => item.dataset.instanceId ?? "")
    .filter(Boolean);
  const activeId = canvas.activeItem()?.dataset.instanceId ?? "";
  const focusedBefore = document.activeElement;
  let selectedPresentationChanged = false;
  let focusedPresentationId = "";
  let changed = membershipChanged;
  for (const item of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]") ?? [],
  )) {
    const selector = item.dataset.selector ?? "";
    const row = deviceRowFor(selector);
    const presentationMatches = !row || (
      item.classList.contains("rd-encoder-device-node") === (row.role === "panel-encoder") &&
      item.classList.contains("rd-keyboard-device-node") === (row.role === "keyboard")
    );
    // A refused scan is UNKNOWN, not an authoritative empty roster. Keep the
    // remembered card mounted and let syncBenchCards mark its status unknown.
    if (
      bench.has(selector) &&
      ((row && presentationMatches) || (!row && !rdDeviceScanAuthoritative))
    ) continue;
    const instanceId = item.dataset.instanceId ?? "";
    if (selectedIds.includes(instanceId)) selectedPresentationChanged = true;
    if (
      focusedBefore instanceof Node &&
      (focusedBefore === item || item.contains(focusedBefore))
    ) focusedPresentationId = instanceId;
    rememberDeviceGeometry(item);
    disposeEncoderWorkbenchItem(item);
    canvas.removeItem(item, { selectFallback: false });
    changed = true;
  }

  benchOrder.forEach((selector, index) => {
    const row = deviceRowFor(selector);
    if (row && !benchItemEl(selector)) {
      mountDeviceWidget(row, index);
      changed = true;
    }
  });

  // A connection transition swaps presentation, not identity. Reapply the
  // exact pre-swap selection after every replacement is registered; keeping
  // the former primary last preserves multi-selection semantics. If keyboard
  // focus lived anywhere inside the replaced board, land it on the new shell
  // because its former child may not exist in the recovery presentation.
  if (selectedPresentationChanged || focusedPresentationId) {
    const mounted = new Map(
      Array.from(
        rdRoot?.querySelectorAll<HTMLElement>(
          ".forma-canvas-stage > [data-instance-id]",
        ) ?? [],
      ).map((item) => [item.dataset.instanceId ?? "", item] as const),
    );
    if (selectedPresentationChanged) {
      const restored = selectedIds
        .map((id) => mounted.get(id))
        .filter((item): item is HTMLElement => Boolean(item));
      const primary = activeId ? mounted.get(activeId) : undefined;
      if (primary && restored.includes(primary)) {
        canvas.setSelection([...restored.filter((item) => item !== primary), primary]);
      } else if (restored.length > 0) {
        canvas.setSelection(restored);
      }
    }
    const focusReplacement = focusedPresentationId
      ? mounted.get(focusedPresentationId)
      : undefined;
    focusReplacement?.focus({ preventScroll: true });
  }

  syncDeviceRows();
  syncBenchCards();
  // Names and roles can change without membership changing. Keep the
  // selection surface and proximity labels on the same served repaint.
  renderInspector();
  scheduleChips();
  if (changed) {
    saveCanvasPrefs();
    syncMapCount();
  }
}

/** One deterministic recipient for the pre-device synthetic keyboard geometry.
 * This is migration bookkeeping only; it grants no mapping exclusivity. */
function compatibilityMappingItem(): HTMLElement | null {
  if (!rdDeviceScanAuthoritative || !rdStagingReachable) return null;
  const staged = [...rdDevKb(), ...rdDevEnc(), ...rdDevExp()].filter(
    (row) => row.aria_current === "true",
  );
  const current = currentAuthoringSource();
  const selected = staged.find((row) => row.selector === current) ?? staged[0];
  return selected ? benchItemEl(selected.selector) : null;
}

/** A pre-device build stored the mapping board under the synthetic
 * `keyboard` id. If that source device was added while inactive, defer the
 * one-time claim until it actually becomes authoritative; browser persistence
 * in the meantime must not turn its temporary spawn point into a competing
 * selector-specific preference. */
function claimPendingLegacyKeyboardGeometry(item: HTMLElement | null): void {
  const canvas = nCanvas;
  if (!item || !canvas) return;
  const instanceId = item.dataset.instanceId;
  if (!instanceId) return;
  const legacy = canvasPrefs.widgets.keyboard;
  if (!isGeometry(legacy)) {
    delete item.dataset.legacyKeyboardGeometryPending;
    delete item.dataset.legacyKeyboardSpawnX;
    delete item.dataset.legacyKeyboardSpawnY;
    delete item.dataset.legacyKeyboardSpawnScale;
    return;
  }
  // Selector-specific geometry is authoritative unless this live item still
  // carries the one-session marker proving it was spawned solely to await the
  // old synthetic board. In every other case the old key is stale migration
  // residue and must be retired now, or an unrelated keyboard added later can
  // inherit it. This also closes reload/remove-before-select paths, where the
  // transient marker is correctly gone but persisted selector geometry exists.
  if (item.dataset.legacyKeyboardGeometryPending !== "true") {
    const nextWidgets = { ...canvasPrefs.widgets };
    delete nextWidgets.keyboard;
    nextWidgets[instanceId] = canvas.getItemState(item);
    canvasPrefs.widgets = nextWidgets;
    saveCanvasPrefs();
    return;
  }
  const normalized = {
    ...legacy,
    width: Math.max(KEYBOARD_DEVICE_WIDTH, legacy.width),
    height: Math.max(KEYBOARD_DEVICE_MIN_HEIGHT, legacy.height),
  };
  const expanded = legacy.width < KEYBOARD_DEVICE_WIDTH ||
    legacy.height < KEYBOARD_DEVICE_MIN_HEIGHT;
  const current = canvas.getItemState(item);
  const spawnX = Number(item.dataset.legacyKeyboardSpawnX);
  const spawnY = Number(item.dataset.legacyKeyboardSpawnY);
  const spawnScale = Number(item.dataset.legacyKeyboardSpawnScale);
  const userArranged = Number.isFinite(spawnX) && Number.isFinite(spawnY) &&
    Number.isFinite(spawnScale) &&
    (current.x !== spawnX || current.y !== spawnY || current.manualScale !== spawnScale);
  const restored = userArranged
    ? current
    : canvas.restoreItemState(
      item,
      expanded ? allocateFreshCanvasGeometry(normalized, item) : normalized,
    );
  if (!restored) return;
  const nextWidgets = { ...canvasPrefs.widgets };
  delete nextWidgets.keyboard;
  nextWidgets[instanceId] = restored;
  canvasPrefs.widgets = nextWidgets;
  delete item.dataset.legacyKeyboardGeometryPending;
  delete item.dataset.legacyKeyboardSpawnX;
  delete item.dataset.legacyKeyboardSpawnY;
  delete item.dataset.legacyKeyboardSpawnScale;
  saveCanvasPrefs();
}

/** Paint a physical keyboard from only its own source rows. Controller focus
 * chooses the readable short label on each cap; it never filters the owner
 * bands or disables another keyboard/controller route. */
function syncKeyboardSourceBindings(
  surface: HTMLElement,
  selector: string,
  sourceLabel: string,
): void {
  const routes = rdCtrlPads.flatMap((pad) => {
    const source = pad.sources?.find((candidate) => candidate.source_id === selector);
    if (!source || source.mapping_available === false) return [];
    return [{
      slot: pad.slot,
      controls: (source.controls ?? []).map((control) => ({
        function: control.function,
        label: control.label,
        keys: [...control.keys],
      })),
      macros: (source.macros ?? []).map((macro) => ({
        name: macro.name,
        triggers: [...macro.triggers],
      })),
    }];
  });
  syncKeyboardSourceMapping(surface, {
    sourceLabel,
    selectedSlot: Number(rdCtrlPanel?.slot_val ?? "0"),
    routes,
  });
}

/** Join browser-owned canvas membership to served device truth. Every staged,
 * connected keyboard is an independent editable source and owns one full
 * board. `source` in the URL chooses only the inspector/listen context. */
function syncKeyboardDevicePresentation(): void {
  const root = rdRoot;
  if (!root) return;
  const compatibilityItem = compatibilityMappingItem();
  const compatibilityKeyboard = compatibilityItem?.classList.contains(
      "rd-keyboard-device-node",
    )
    ? compatibilityItem
    : null;
  claimPendingLegacyKeyboardGeometry(compatibilityKeyboard);

  const controls = sourceControlsSurface ??
    root.querySelector<HTMLElement>("[data-rd-source-controls]");
  const globalControlsHost = root.querySelector<HTMLElement>(
    "[data-rd-global-source-controls-host]",
  );
  if (controls && globalControlsHost) {
    if (controls.parentElement !== globalControlsHost) globalControlsHost.append(controls);
    controls.hidden = false;
    controls.inert = false;
    controls.removeAttribute("aria-hidden");
  }

  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]"),
  )) {
    const selector = item.dataset.selector ?? "";
    const row = deviceRowFor(selector);
    const sourceEnabled = deviceRowConnected(row);
    const mappingAvailable = sourceEnabled && rdStagingReachable &&
      row?.aria_current === "true";
    item.dataset.sourceId = selector;
    item.dataset.sourceAlias = row?.alias ?? "";
    item.dataset.sourceInstance = row?.instance_id ?? "";
    item.dataset.sourceEnabled = sourceEnabled ? "true" : "unknown";
    item.dataset.mappingAvailable = mappingAvailable ? "true" : "false";
    item.dataset.sourceState = sourceEnabled ? "enabled" : "unknown";
    item.toggleAttribute("data-authoring-source", selector === currentAuthoringSource());
    if (!item.classList.contains("rd-keyboard-device-node")) continue;
    const host = item.querySelector<HTMLElement>("[data-rd-keyboard-surface-host]");
    let surface = host?.querySelector<HTMLElement>(KEYBOARD_SURFACE_SELECTOR) ?? null;
    const template = keyboardSurfaceTemplate;
    if (!surface && host && template && row) {
      const instanceId = item.dataset.instanceId ?? deviceInstanceId(selector);
      const sourceLabel = deviceCanvasLabel(row);
      surface = createKeyboardSurfaceInstance(template, {
        sourceId: selector,
        instanceId,
        sourceLabel,
        mappingAvailable,
      });
      host.append(surface);
    } else if (surface && template) {
      const sourceLabel = row
        ? deviceCanvasLabel(row)
        : item.dataset.widgetName ?? "Physical keyboard";
      syncKeyboardSurfaceInstance(surface, template, {
        sourceId: selector,
        instanceId: item.dataset.instanceId ?? deviceInstanceId(selector),
        sourceLabel,
        mappingAvailable,
      });
    }
    if (surface && row && mappingAvailable) {
      syncKeyboardSourceBindings(surface, selector, deviceCanvasLabel(row));
    }
    const status = item.querySelector<HTMLElement>("[data-rd-keyboard-mapping-status]");
    if (status) {
      status.dataset.state = !sourceEnabled
        ? "unavailable"
        : mappingAvailable
          ? "ready"
          : "readonly";
      status.textContent = !sourceEnabled
        ? "Connection status unavailable · this board remains on the canvas, but input and mapping are paused."
        : mappingAvailable
          ? selector === currentAuthoringSource()
            ? "Independent source · selected for mapping edits."
            : "Independent source · click this keyboard to edit its mappings."
          : "On canvas · add this keyboard to the draft before mapping it.";
    }
  }
  const nextFingerprint = Array.from(
    root.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]"),
  )
    .map((item) => {
      const selector = item.dataset.sourceId ?? "";
      const routeRevisions = selector
        ? rdCtrlPads.map((pad) => {
            const source = pad.sources?.find((candidate) => candidate.source_id === selector);
            return `${pad.slot}:${source?.revision ?? "missing"}:${source?.routed === true ? "r" : "n"}`;
          }).join(",")
        : "";
      return `${item.dataset.instanceId ?? ""}:${item.dataset.sourceEnabled ?? "false"}:${item.dataset.mappingAvailable ?? "false"}:${routeRevisions}`;
    })
    .sort()
    .join("|");
  if (nextFingerprint !== sourceSurfaceFingerprint) {
    sourceSurfaceFingerprint = nextFingerprint;
    root.dispatchEvent(new CustomEvent("ksx:redesign-source-surface-change"));
  }
  syncKbLens();
  const viewport = root.querySelector<HTMLElement>(".forma-canvas-viewport");
  const tier = viewport?.dataset.canvasZoomTier ?? "editing";
  const zoom = canvasZoomFromViewport(viewport);
  syncEncoderEditingAccess(tier, zoom);
  syncKeyboardEditingAccess(tier, zoom);
  syncMappingCords();
}

/** Repaint every served fact on mounted cards, including the daemon's staged
 * choice. Membership and geometry remain browser-owned and untouched. */
function syncBenchCards(): void {
  for (const item of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]") ?? [],
  )) {
    const row = deviceRowFor(item.dataset.selector ?? "");
    const status = item.querySelector<HTMLElement>(".rd-devcard-staged");
    const meta = item.querySelector<HTMLElement>(".rd-devcard-meta");
    const purpose = item.querySelector<HTMLElement>(".rd-devcard-purpose");
    const stageButton = item.querySelector<HTMLButtonElement>(".rd-stagebtn");
    const actionAvailable = rdDeviceScanAuthoritative && rdStagingReachable && Boolean(row);
    const sourceConnected = deviceRowConnected(row);
    item.dataset.scanAuthoritative = rdDeviceScanAuthoritative ? "true" : "false";
    item.dataset.stagingReachable = rdStagingReachable ? "true" : "false";
    item.dataset.staged = actionAvailable
      ? (row!.aria_current === "true" ? "true" : "false")
      : "unknown";
    if (item.classList.contains("rd-keyboard-device-node")) {
      item.dataset.sourceEnabled = sourceConnected ? "true" : "unknown";
      item.dataset.mappingAvailable = sourceConnected && rdStagingReachable &&
          row!.aria_current === "true"
        ? "true"
        : "false";
    }
    if (stageButton) {
      const alreadyStaged = row?.aria_current === "true";
      const offlineRemove = row?.role === "offline-source";
      stageButton.hidden = alreadyStaged && !offlineRemove;
      stageButton.dataset.rdProductDisabled = actionAvailable && (!alreadyStaged || offlineRemove)
        ? "false"
        : "true";
      stageButton.disabled = !actionAvailable || (alreadyStaged && !offlineRemove) ||
        rdRoot?.dataset.rdMutationPending === "true";
    }

    const encoderSurface = encoderWorkbenchSurfaces.get(item);
    encoderSurface?.setConnectionConfirmed(rdDeviceScanAuthoritative && Boolean(row));

    if (!rdDeviceScanAuthoritative) {
      if (meta) meta.textContent = `Status unavailable — ${rdDevScanLine()}`;
      if (status) {
        status.textContent = "Device status unavailable — latest scan did not answer";
        status.title = rdDevScanLine();
      }
      if (purpose) {
        purpose.textContent = item.classList.contains("rd-keyboard-device-node")
          ? "This keyboard remains on the canvas. Input and mapping controls pause until KSX confirms the exact connection."
          : "Device status is unavailable. Mapping controls pause until KSX confirms this exact source.";
      }
      if (item.classList.contains("rd-keyboard-device-node")) {
        syncDeviceCardStateBadges(item, {
          role: "keyboard",
          aria_current: "false",
        } as RdDeviceRowView);
      } else {
        syncDeviceCardStateBadges(item, { aria_current: "true" } as RdDeviceRowView);
      }
      continue;
    }
    if (!row) continue;
    encoderSurface?.updateDevice(encoderDeviceFromRow(row));

    if (!rdStagingReachable) {
      if (status) {
        status.textContent = rdStagingLine || "Staging unavailable";
        status.title = rdStagingLine || "Staging unavailable";
      }
    } else if (status) {
      status.textContent = row.role === "offline-source"
        ? "Disconnected · still in mapping draft"
        : row.aria_current === "true"
          ? "Independent mapping source"
          : "On-canvas preview";
      status.title = row.role === "keyboard" ? KEYBOARD_MAPPING_READY_TITLE : STAGED_DEVICE_TITLE;
    }
    const displayName = deviceCanvasLabel(row);
    item.dataset.widgetName = displayName;
    item.setAttribute("aria-label", displayName);
    const badge = item.querySelector<HTMLElement>(".rd-devcard-badge");
    if (badge) {
      badge.dataset.role = row.role;
      badge.textContent = DEVICE_ROLE_BADGE[row.role] ?? "Experimental";
    }
    const name = item.querySelector<HTMLElement>(".rd-devcard-name");
    if (name) name.textContent = row.name;
    if (meta) meta.textContent = deviceCardMeta(row);
    if (purpose) purpose.textContent = deviceCardPurpose(row);
    syncDeviceCardStateBadges(item, row);
    item.querySelector<HTMLElement>(".widget-drag-handle")?.setAttribute(
      "aria-label",
      `Move ${displayName}`,
    );
    for (const [fieldName, value] of [
      ["selector", row.selector],
      ["alias", row.alias],
      ["label", row.label],
    ]) {
      const input = item.querySelector<HTMLInputElement>(
        `.rd-stageform input[name="${fieldName}"]`,
      );
      if (input) input.value = value;
    }
    const id = item.dataset.instanceId;
    const marker = id
      ? rdRoot?.querySelector<HTMLElement>(`.navigator-item[data-instance-id="${id}"]`)
      : null;
    marker?.setAttribute("aria-label", `Focus ${displayName}`);
    if (marker) marker.title = displayName;
  }
  syncKeyboardDevicePresentation();
}

/** Decorate the picker rows with CLIENT truth — membership — after any
 *  render: aria-pressed, the `.on` marking, the verb word. Imperative like
 *  the map-marker labeller, because the rows re-render from SERVER data and
 *  membership is not server data. */
function syncDeviceRows(): void {
  const bench = benchSelectors();
  for (const btn of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>('[data-nx="rd-dev-toggle"]') ?? [],
  )) {
    const selector = btn.dataset.selector ?? "";
    const on = bench.includes(selector);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("on", on);
    const row = deviceRowFor(selector);
    const connection = btn.querySelector<HTMLElement>(".rd-dev-connectedchip");
    if (connection) {
      connection.textContent = row?.role === "offline-source" ? "Disconnected" : "Connected";
      connection.dataset.state = row?.role === "offline-source" ? "attention" : "connected";
    }
    const meta = btn.querySelector<HTMLElement>(".n-dev-meta:not(.rd-dev-word)");
    if (row && meta) meta.textContent = deviceCardMeta(row);
    const word = btn.querySelector<HTMLElement>(".rd-dev-word");
    if (word) {
      word.textContent = row?.role === "offline-source"
        ? on
          ? "On canvas — press to remove source"
          : "Show recovery card on canvas"
        : row?.role === "keyboard"
        ? on
          ? "On canvas — press to remove board"
          : "Add keyboard board to canvas"
        : on
          ? "On canvas — press to remove"
          : "Show on canvas";
    }
  }
}

// ── The persistent Add tray ─────────────────────────────────────────────────
// Devices and controllers have deliberately different truth models, but they
// share one visual slot beside the workbench. Only one tray can be open. It
// is a labelled, non-modal region: the canvas physically resizes around it,
// so Tab and pointer input may continue into the workbench while several
// items are added in one pass.

function devModalEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-devmodal") ?? null;
}

function devModalIsOpen(): boolean {
  const el = devModalEl();
  return Boolean(el && !el.hidden);
}

let devModalReturnFocus: HTMLElement | null = null;
let addPanelSessionOpen = false;
let addPanelRestoreInspector = false;
let addPanelDeferredInspector = false;

interface AddPanelTransition {
  switching?: boolean;
  restoreFocus?: boolean;
}

function syncAddPanelChrome(): void {
  const root = rdRoot;
  if (!root) return;
  const devOpen = devModalIsOpen();
  const ctrlOpen = ctrlModalIsOpen();
  root.classList.toggle("is-add-panel-open", devOpen || ctrlOpen);
  root.querySelector<HTMLElement>('[data-nx="rd-devs-open"]')
    ?.setAttribute("aria-expanded", String(devOpen));
  root.querySelector<HTMLElement>('[data-nx="rd-ctrls-open"]')
    ?.setAttribute("aria-expanded", String(ctrlOpen));
}

function beginAddPanelSession(): void {
  if (addPanelSessionOpen) return;
  addPanelSessionOpen = true;
  const inspector = inspectorEl();
  addPanelRestoreInspector = Boolean(inspector && !inspector.hidden);
  addPanelDeferredInspector = false;
  if (addPanelRestoreInspector) setInspector(false);
}

function finishAddPanelSession(): void {
  if (!addPanelSessionOpen || devModalIsOpen() || ctrlModalIsOpen()) return;
  addPanelSessionOpen = false;
  const resumeInspector = addPanelRestoreInspector || addPanelDeferredInspector;
  addPanelRestoreInspector = false;
  addPanelDeferredInspector = false;
  const active = nCanvas?.activeItem();
  if (active && resumeInspector) setInspector(true);
}

function setDevModal(open: boolean, transition: AddPanelTransition = {}): void {
  const el = devModalEl();
  if (!el || el.hidden === !open) return;
  // An identify transaction owns the modal until its exact learner
  // generation answers or is cancelled. Closing the surface while its POST
  // can still stage a board would make a later selection look spontaneous.
  if (!open && el.dataset.rdIdentifyPending === "true") {
    el.querySelector<HTMLElement>("[data-rd-identify-cancel]")?.focus({ preventScroll: true });
    return;
  }
  if (open) {
    // Capture the initiating control BEFORE a peer closes. Its close path
    // otherwise focuses the stale opener and makes a Devices → Controllers
    // switch return to the wrong button.
    const returnFocus = activeControl();
    if (ctrlModalIsOpen()) setCtrlModal(false, { switching: true, restoreFocus: false });
    if (ctrlModalIsOpen()) return;
    if (sheetOpen()) setSheet(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    beginAddPanelSession();
    devModalReturnFocus = returnFocus;
    syncDeviceRows();
    el.hidden = false;
    syncAddPanelChrome();
    el.querySelector<HTMLButtonElement>(
      '.rd-devmodal-head button[data-nx="rd-devs-close"]',
    )?.focus({ preventScroll: true });
  } else {
    el.hidden = true;
    const target = devModalReturnFocus;
    devModalReturnFocus = null;
    syncAddPanelChrome();
    if (!transition.switching) {
      finishAddPanelSession();
      if (transition.restoreFocus !== false) restoreOverlayFocus(target);
    }
  }
}

// ── The controller catalog — the device tray's twin, one per truth ─────────

function ctrlModalEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-ctrlmodal") ?? null;
}

function ctrlModalIsOpen(): boolean {
  const el = ctrlModalEl();
  return Boolean(el && !el.hidden);
}

let ctrlModalReturnFocus: HTMLElement | null = null;
function setCtrlModal(open: boolean, transition: AddPanelTransition = {}): void {
  const el = ctrlModalEl();
  if (!el || el.hidden === !open) return;
  if (open) {
    const returnFocus = activeControl();
    if (devModalIsOpen()) setDevModal(false, { switching: true, restoreFocus: false });
    // Identify owns the device tray until it answers or is cancelled. Its
    // guarded close can refuse this switch, in which case never stack trays.
    if (devModalIsOpen()) return;
    if (sheetOpen()) setSheet(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    beginAddPanelSession();
    ctrlModalReturnFocus = returnFocus;
    el.hidden = false;
    syncAddPanelChrome();
    el.querySelector<HTMLButtonElement>(
      '.rd-ctrlmodal-head button[data-nx="rd-ctrls-close"]',
    )?.focus({ preventScroll: true });
  } else {
    el.hidden = true;
    const target = ctrlModalReturnFocus;
    ctrlModalReturnFocus = null;
    syncAddPanelChrome();
    if (!transition.switching) {
      finishAddPanelSession();
      if (transition.restoreFocus !== false) restoreOverlayFocus(target);
    }
  }
}


/** Adopt the served canvas skeleton. Runs once, strictly AFTER adoption (the
 *  entry's post-mount frame): the engine annotates the served nodes, and
 *  every one of its writes rides the parity contract's client-canvas
 *  exemption.
 *
 *  ⚠️It WAITS for the skeleton instead of assuming one frame is enough.
 *  Adoption rebuilds the island subtree, so the queries can legitimately
 *  miss on the frame this first runs — and a bare early return would leave a
 *  canvas that never comes alive: no error, no console line, just a dead
 *  surface every gate but a dead-canvas assert reads as healthy. Re-asking
 *  each frame costs nothing; the budget stops a page that legitimately has
 *  no canvas from asking forever. */
const CANVAS_ADOPT_FRAMES = 60;
export function initRedesignCanvas(root: HTMLElement, attempt = 0): void {
  if (nCanvas) return;
  // The island root itself can be replaced by adoption; a detached one would
  // hand the engine a tree nobody sees.
  const scope = root.isConnected ? root : (rdRoot?.isConnected ? rdRoot : document.body);
  const surface = scope.querySelector<HTMLElement>(".n-canvas");
  const viewport = surface?.querySelector<HTMLElement>(".forma-canvas-viewport");
  const stage = surface?.querySelector<HTMLElement>(".forma-canvas-stage");
  // The zoom readout IS the 100% button in the meta bar: the engine writes
  // the live percentage into whatever element it is handed, and a button
  // that reads the zoom and resets it on click is one control instead of a
  // static label beside a number somewhere else.
  const zoomStatus = scope.querySelector<HTMLElement>(".n-zoomval");
  if (!surface || !viewport || !stage || !zoomStatus || !surface.isConnected) {
    if (attempt < CANVAS_ADOPT_FRAMES) {
      window.requestAnimationFrame(() => initRedesignCanvas(root, attempt + 1));
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
  // (it only excuses its own markers), so the whole header has to stop the
  // press from reaching it. Otherwise clicking the title or putting the map
  // away jumps the camera. Click still bubbles to the delegated handler.
  navigator
    .querySelector<HTMLElement>(".rd-map-head")
    ?.addEventListener("pointerdown", (event) => event.stopPropagation());
  loadCanvasPrefs();
  nCanvas = new WidgetCanvas(
    { viewport, stage, zoomStatus, navigator, navigatorItems, navigatorViewport },
    {
      onCommit: () => {
        persistCanvas();
        scheduleChips();
      },
      // The trail behind onCommit: pans and in-flight drags reach the store
      // within a second even if the tab dies before a durable boundary.
      onChange: () => {
        scheduleCanvasPersist();
        scheduleChips();
      },
      // The engine has no live region of its own; the meta bar's sr status
      // line is this page's.
      onKeyboardNavigation: (message) => {
        const sr = (rdRoot ?? scope).querySelector<HTMLElement>(".n-live-sr");
        if (sr) sr.textContent = message;
      },
      worldBounds: CANVAS_WORLD,
      // The design-tool model (design handoff §2): empty-drag marquees,
      // panning belongs to space/middle/right/two-finger/hand, plain wheel
      // pans and ctrl/cmd+wheel (= pinch) zooms at the pointer.
      navigationModel: "design-tool",
      zoomRange: { min: 0.08, max: 3 },
      onToolModeChange: syncToolRail,
      onZoomChange: (zoom, tier) => applyZoomTier(tier, zoom),
      onCameraHistoryChange: syncBackView,
      onSelectionChange: syncInspectorToSelection,
      onActiveItemStateChange: () => {
        renderInspector();
        const tier = viewport.dataset.canvasZoomTier ?? "editing";
        const zoom = canvasZoomFromViewport(viewport);
        syncEncoderEditingAccess(tier, zoom);
        syncKeyboardEditingAccess(tier, zoom);
      },
      // Native controls inside client-authored widgets are not Forma runtime
      // components. Enter on the move handle / Ctrl+Enter on the item still
      // needs a deterministic way into them.
      onOpenActiveControls: (item) => {
        const isEncoder = item.classList.contains("rd-encoder-device-node");
        const isKeyboard = item.classList.contains("rd-keyboard-device-node") &&
          item.dataset.sourceEnabled === "true";
        if (isEncoder) {
          const state = nCanvas?.getItemState(item);
          const manualScale = state?.manualScale ?? 1;
          const zoom = canvasZoomFromViewport(viewport);
          const requiredZoom = encoderEditingZoom(manualScale);
          if (viewport.dataset.canvasZoomTier !== "editing" ||
              zoom * manualScale < ENCODER_MIN_EFFECTIVE_EDIT_SCALE) {
            nCanvas?.setZoomTo(requiredZoom, "before opening encoder controls");
            // The camera render is scheduled. Release this exact product host
            // now so the synchronous F2 contract can focus its roving entry;
            // the render callback will restamp the authoritative tier.
            syncEncoderEditingAccess("editing", requiredZoom);
          }
        }
        if (isKeyboard) {
          const state = nCanvas?.getItemState(item);
          const manualScale = state?.manualScale ?? 1;
          const zoom = canvasZoomFromViewport(viewport);
          const requiredZoom = keyboardEditingZoom(manualScale);
          if (viewport.dataset.canvasZoomTier !== "editing" ||
              zoom * manualScale < keyboardMinEffectiveEditScale()) {
            nCanvas?.setZoomTo(requiredZoom, "before opening keyboard controls");
            syncKeyboardEditingAccess("editing", requiredZoom);
          }
        }
        const runtime = item.querySelector<HTMLElement>("[data-forma-runtime-host]");
        const control = isEncoder
          ? runtime?.querySelector<HTMLElement>('[data-terminal-id][tabindex="0"]') ??
            runtime?.querySelector<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
            )
          : runtime?.querySelector<HTMLElement>(
            "select:not(:disabled), input:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]",
          );
        if (!control) return false;
        // Semantic overview intentionally hides editing chrome. F2 is an
        // explicit request to enter it, so cross the editing threshold before
        // focusing rather than claiming success on a display:none control.
        if (!isEncoder && !isKeyboard && control.getClientRects().length === 0) {
          nCanvas?.setZoomTo(0.94, "before opening widget controls");
        }
        control.focus({ preventScroll: true });
        return document.activeElement === control;
      },
      // Focus opens the inspector (design handoff §3) and hides the chips.
      onFocusModeChange: (_item, focused) => {
        if (focused) {
          setInspector(true);
        }
        syncChips();
      },
    },
  );
  encoderAttentionObserver?.disconnect();
  encoderAttentionObserver = new MutationObserver((records) => {
    if (!records.some((record) =>
      record.target instanceof HTMLElement &&
      (
        record.target.classList.contains("rd-encoder-device-node") ||
        record.target.classList.contains("rd-keyboard-device-node")
      )
    )) return;
    const tier = viewport.dataset.canvasZoomTier ?? "editing";
    const zoom = canvasZoomFromViewport(viewport);
    syncEncoderEditingAccess(tier, zoom);
    syncKeyboardEditingAccess(tier, zoom);
  });
  encoderAttentionObserver.observe(stage, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-attention-scale", "data-canvas-manual-scale"],
  });
  setCanvasMap(canvasPrefs.mapHidden === true);
  // No device is implicit. Browser-owned bench membership decides which
  // physical boards mount; the served keyboard projection waits in its depot
  // until the authoritative source device is explicitly on the canvas.
  restoreBench();
  syncCtrlBench();
  syncEncoderProfileLabButton();
  // The mapping cords: the one layer engine over this page's stage. It
  // observes the stage's style mutations itself (camera +
  // widget geometry), so card drags and zooms repaint the cords with no
  // further call sites.
  const flowLines = surface.querySelector<SVGSVGElement>("#n-mapping-paths");
  const flowPorts = surface.querySelector<SVGSVGElement>("#n-mapping-ports");
  const flowNodes = surface.querySelector<HTMLElement>("#n-mapping-processors");
  const flowTrace = scope.querySelector<HTMLOutputElement>("#rd-mapping-trace");
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
        onLayout: paintMappingCordCount,
        getProcessorOffset: processorOffsetFor,
        onProcessorOffsetCommit: (processorId, offset) =>
          commitProcessorOffset(processorId, offset),
        announce: rdAnnounce,
        traceOutput: flowTrace,
      },
    );
    syncMappingCords();
  }
  syncMapCount();
  syncToolRail(nCanvas.toolMode());
  wireSpotlight(stage, viewport);
  scheduleChips();
  // The automatic first-open fit never pushes history — only USER camera
  // verbs mint Back-view entries.
  if (canvasPrefs.camera) nCanvas.restoreCamera(canvasPrefs.camera);
  else window.requestAnimationFrame(() => nCanvas?.fitAll(false));
  window.addEventListener("pagehide", () => {
    // flushPendingChange only fires the onChange callback — whose debounce
    // timer will never tick in a dying page. The synchronous persist IS the
    // durability; the flush just settles the engine's pending rAF first.
    nCanvas?.flushPendingChange();
    persistCanvas();
  });
}

// ── Wire: root marker, camera verbs, focus-mode escape ──────────────────────

/** Single keys must never fire while someone is typing (design handoff §2);
 *  cmd-combinations are checked BEFORE this guard so ⌘K works from a field. */
function typingIntoSomething(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable]"));
}

function canvasOwnsKeyboardFocus(): boolean {
  const canvas = rdRoot?.querySelector<HTMLElement>(".n-canvas");
  const active = document.activeElement;
  // Interactive controller regions are SVG elements, not HTMLElements. They
  // still belong to the canvas keyboard context, so keep canvas-level Escape
  // and shortcut handling available while one of those regions owns focus.
  return Boolean(canvas && active instanceof Element && canvas.contains(active));
}

function setupDetails(): HTMLDetailsElement | null {
  return rdRoot?.querySelector<HTMLDetailsElement>(".rd-setupd") ?? null;
}

function closeSetupForWorkbenchAction(): void {
  const setup = setupDetails();
  if (setup) setup.open = false;
}

function focusCaptureRecovery(): void {
  const setup = setupDetails();
  if (!setup) return;
  setup.open = true;
  window.requestAnimationFrame(() => {
    const rows = RD_CAPTURE_ATTENTION_MODES.has(rdCaptureMode())
      ? rdCaptureHeld()
      : additionalHeldCaptureRows();
    const wanted = rows.length === 1 ? rows[0] : null;
    const held = wanted
      ? Array.from(setup.querySelectorAll<HTMLElement>(".rd-held-row")).find(
        (row) => row.dataset.heldKey === wanted.key,
      )
      : null;
    const target = held ?? setup.querySelector<HTMLElement>("#rd-capture-readiness");
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  });
}

function openJourneyDevicePicker(kind: "devices" | "controllers"): void {
  closeSetupForWorkbenchAction();
  const opener = rdRoot?.querySelector<HTMLElement>(
    kind === "devices" ? '[data-nx="rd-devs-open"]' : '[data-nx="rd-ctrls-open"]',
  );
  opener?.focus({ preventScroll: true });
  if (kind === "devices") setDevModal(true);
  else setCtrlModal(true);
}

function focusJourneyMapping(): void {
  const slot = rdCtrlPanel?.slot_val || rdCtrlCards[0]?.number || "";
  const item = slot
    ? rdRoot?.querySelector<HTMLElement>(
      `.forma-canvas-stage > [data-instance-id="ctrl-slot-${CSS.escape(slot)}"]`,
    ) ?? null
    : null;
  if (!item || !nCanvas) {
    openJourneyDevicePicker("controllers");
    return;
  }
  closeSetupForWorkbenchAction();
  nCanvas.setSelection([item]);
  setInspector(true);
  renderInspector();
  window.requestAnimationFrame(() => {
    const target = rdRoot?.querySelector<HTMLElement>(
      '.rd-insp-body [data-nx="rd-automap"], .rd-insp-body details.n-bind > summary, ' +
        '.rd-inspector [data-nx="rd-insp-close"]',
    );
    target?.focus({ preventScroll: true });
  });
}

function focusJourneyPlay(): void {
  const formKind = rdOperations?.session?.running === true ? "stop" : "play";
  const action = Array.from(
    rdRoot?.querySelectorAll<HTMLButtonElement>(
      `[data-rd-form="${formKind}"] button[type="submit"]:not([disabled])`,
    ) ?? [],
  ).find((button) => button.offsetParent !== null);
  if (action) {
    closeSetupForWorkbenchAction();
    action.focus({ preventScroll: true });
    return;
  }
  const setup = setupDetails();
  if (setup) setup.open = true;
  const reason = rdRoot?.querySelector<HTMLElement>("#rd-play-reason");
  reason?.scrollIntoView({ block: "center" });
  reason?.focus({ preventScroll: true });
}

async function retryJourney(button: HTMLButtonElement | null): Promise<void> {
  if (rdRoot?.dataset.rdMutationPending === "true" || button?.dataset.rdRetryPending === "true") {
    return;
  }
  const journeyStep = button?.dataset.journeyStep ?? "";
  const badge = button?.querySelector<HTMLElement>(".rd-journey-badge") ?? null;
  const settled = badge?.textContent ?? "Retry";
  if (button) {
    button.dataset.rdRetryPending = "true";
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  }
  if (badge) badge.textContent = "Checking…";
  rdAnnounce("Checking workbench status…");
  try {
    await redesignRefreshFn();
  } finally {
    if (button) {
      delete button.dataset.rdRetryPending;
      button.removeAttribute("aria-busy");
      button.disabled = false;
      if (badge?.isConnected) badge.textContent = settled;
    }
    // A successful retry can change this row's badge/detail, which gives the
    // keyed list a new identity and disconnects the initiating button. Keep
    // focus on the same setup step after that authoritative repaint; if the
    // step disappeared, the always-present Setup summary is the stable home.
    const replacement = button?.isConnected
      ? button
      : journeyStep
        ? rdRoot?.querySelector<HTMLButtonElement>(
            `[data-journey-step="${CSS.escape(journeyStep)}"]`,
          ) ?? null
        : null;
    (replacement ?? rdRoot?.querySelector<HTMLElement>(".rd-setup-sum"))
      ?.focus({ preventScroll: true });
  }
}

function runJourneyAction(action: string, button: HTMLButtonElement | null): void {
  if (action === "devices" || action === "controllers") {
    openJourneyDevicePicker(action);
  } else if (action === "capture") {
    focusCaptureRecovery();
  } else if (action === "mapping") {
    focusJourneyMapping();
  } else if (action === "play") {
    focusJourneyPlay();
  } else if (action === "retry") {
    void retryJourney(button);
  }
}

export function redesignWire(root: HTMLElement): void {
  rdRoot = root;
  sourceSurfaceFingerprint = "";
  keyboardSurfaceTemplate = root.querySelector<HTMLElement>(
    KEYBOARD_SURFACE_TEMPLATE_BODY_SELECTOR,
  );
  sourceControlsSurface = root.querySelector<HTMLElement>("[data-rd-source-controls]");
  wireThemeDisclosures(root);
  wireRedesignToolsDisclosures(root);
  // The wire's own "JavaScript is live" marker: scripting-only chrome (the
  // camera buttons) reveals off it, and the parity gate normalizes it.
  root.classList.add("js");
  syncAddPanelChrome();
  // The migration-compatible finish stores preserve every DS4 color or
  // premium finish chosen before the hard cutover.
  loadDs4Variants();
  loadControllerFinishes();
  // The Paths scope select (a change, not a click).
  root.addEventListener("change", (ev) => {
    // A macro duration or auto-fire rate commits when the author leaves the
    // box or presses Enter — the editor module owns the act.
    if (rdMacChange(ev.target as HTMLElement | null)) return;
    const select = ev.target;
    if (
      select instanceof HTMLSelectElement &&
      select.dataset.nx === "rd-mapping-paths" &&
      mappingPathModeIsValid(select.value)
    ) {
      setMappingPathMode(select.value);
    }
  });
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const hit = target?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    // Any un-annotated click puts the zoom menu away (the nocturne
    // configuration menu's own convention).
    if (
      zoomMenuOpen() && hit !== "rd-zoom-menu" &&
      !target?.closest(".rd-menu")
    ) {
      setZoomMenu(false);
    }
    // The theme menu (a native details): an outside click puts it away —
    // the nocturne configuration menu's own convention. Closing after an
    // action belongs to the fetch-submit layer, not here.
    const themeMenu = rdRoot?.querySelector<HTMLElement>("[data-rd-theme-menu][open]");
    if (themeMenu && !target?.closest("[data-rd-theme-menu]")) {
      closeThemeMenu();
    }
    const toolsMenu = rdRoot?.querySelector<HTMLElement>("[data-rd-tools-menu][open]");
    if (toolsMenu && !target?.closest("[data-rd-tools-menu]")) {
      closeRedesignToolsDisclosure(root);
    }
    // Canvas commands duplicated inside Tools are discoverability doors, not
    // a second overlay layer. Retire the disclosure before the command opens
    // or moves anything so Escape and modal return-focus never point into
    // hidden details content. Compact Tools also retires Setup, revealing the
    // canvas that Back just restored and giving Search/Shortcuts a durable
    // return target in the rail.
    const toolsCanvasAction = target?.closest("[data-rd-tools-menu]") &&
      (hit === "rd-back" || hit === "rd-search" || hit === "rd-keys");
    if (toolsCanvasAction) {
      const fromCompactTools = Boolean(target?.closest(".rd-utility-compact-home"));
      closeRedesignToolsDisclosure(root, !fromCompactTools);
      if (fromCompactTools) {
        const setup = root.querySelector<HTMLDetailsElement>(".rd-setupd");
        setup?.removeAttribute("open");
        setup?.querySelector<HTMLElement>(":scope > .rd-setup-sum")
          ?.focus({ preventScroll: true });
      }
    }
    // The board and While-playing pickers keep the same convention: a
    // click outside a popover puts it away (each one for itself, so
    // opening one closes the other).
    for (const pick of Array.from(
      rdRoot?.querySelectorAll<HTMLElement>(".rd-boardpick[open]") ?? [],
    )) {
      if (target && !pick.contains(target)) pick.removeAttribute("open");
    }
    // THE MACRO EDITOR's own controls (cells, motions, policies, acts) —
    // checked before the [data-nx] switch because they live inside the
    // dialog's dlg-noop shield and carry data-mac* instead.
    if (rdMacClick(target)) {
      ev.preventDefault();
      return;
    }
    // Edit steps… (and any same-page ?macro= door): enhanced into a URL
    // swap + refetch so the canvas keeps its camera — SSR still serves the
    // dialog open on a cold load of the same href.
    const macroDoor = target?.closest<HTMLAnchorElement>('a[href^="/redesign?"]');
    if (macroDoor) {
      const href = macroDoor.getAttribute("href") ?? "";
      if (new URL(href, window.location.origin).searchParams.has("macro")) {
        ev.preventDefault();
        window.history.replaceState(null, "", href);
        void redesignRefreshFn();
        return;
      }
    }
    if (hit === "mac-close") {
      ev.preventDefault();
      rdMacClose();
      return;
    }
    // A canvas-only preview has no route authority yet. Refuse its key before
    // the exact-source mapper can arm a write; adding the board to the draft is
    // the one deliberate transition that makes it editable.
    const unavailableKeyboardKey = target?.closest<HTMLElement>(
      '.rd-keyboard-device-node[data-mapping-available="false"] [data-rd-keyboard-surface] [data-key]',
    );
    if (unavailableKeyboardKey) {
      ev.preventDefault();
      const item = unavailableKeyboardKey.closest<HTMLElement>(".rd-keyboard-device-node");
      const name = item?.dataset.widgetName?.trim() || "This keyboard";
      rdAnnounce(
        `${name} is on the canvas but not in the mapping draft. Add it before editing its keys.`,
      );
      return;
    }
    // Plate cell → Keys row: the board is the Keys tab's own picture, so
    // clicking a key reveals that key's row (a bound cap) or its free chip.
    // While a LEARN is armed the plate is the other way to answer it:
    // clicking a key resolves the capture exactly like pressing it.
    const cell = target?.closest<HTMLElement>(
      '.rd-keyboard-device-node[data-mapping-available="true"] .n-kb [data-key], ' +
        '.rd-keyboard-device-node[data-mapping-available="true"] .n-kbtray-row [data-key]',
    );
    const sourceItem = cell?.closest<HTMLElement>(".rd-keyboard-device-node");
    const sourcePin = sourceItem
      ? {
          selector: sourceItem.dataset.sourceId ?? "",
          instance: sourceItem.dataset.sourceInstance ?? "",
        }
      : undefined;
    const learned = cell
      ? resolveLearnWithKey(cell.getAttribute("data-key") ?? "", ev.shiftKey, sourcePin)
      : false;
    if (cell) {
      let sourceChanged = false;
      if (!learned) {
        sourceChanged = sourcePin?.selector
          ? mergeSourceIntoUrl(sourcePin.selector)
          : false;
        pendingLocateKey = cell.getAttribute("data-key") ?? "";
        if (inspTab !== "keys") {
          inspTab = "keys";
          saveKbUi();
        }
      }
      const revealExactKey = (): void => {
        // The Keys view is the SELECTED CONTROLLER's — but the click itself
        // selected the KEYBOARD widget. Hand selection to the card the served
        // exact-source panel speaks for.
        const canvas = nCanvas;
        const slot = rdCtrlPanel?.slot_val ?? "";
        const item = rdRoot?.querySelector<HTMLElement>(
          `.forma-canvas-stage > [data-instance-id="ctrl-slot-${slot}"]`,
        );
        if (canvas && item) canvas.setSelection([item]);
        if (pendingLocateKey) {
          setInspector(true);
          renderInspector();
        }
      };
      // A learn answer belongs to the controller being edited, not the
      // physical keyboard item selected by the same click. The key remains
      // the conflict dialog's durable return target.
      if (learned) {
        cell.focus({ preventScroll: true });
        return;
      }
      if (sourceChanged) {
        // Do not briefly expose another board's by-key rows. The exact-source
        // payload must arrive before the inspector opens on this key.
        mapperOnSlotChange();
        void redesignRefreshFn().then((refreshed) => {
          if (refreshed) revealExactKey();
          else pendingLocateKey = null;
        });
        return;
      }
      revealExactKey();
      return;
    }
    // Pad art → binding row: every control on a card's silhouette carries
    // its mapper function(s) in data-fn (the 4460 pointer enhancement).
    // The click already selected the card through the engine; opening the
    // inspector and locating the row is this page's half. With a KEY IN
    // HAND, the pad IS the picker: the clicked control takes the key.
    const zone = target?.closest<Element>(".rd-ctrlcard-artwrap [data-fn]");
    // Pointer activation selected the containing card on pointerdown. A
    // keyboard or assistive-technology click has no pointerdown, so make the
    // same selection explicitly before the inspector reads it. `detail === 0`
    // is the click contract for non-pointer activation; keeping this guard is
    // what preserves the canvas engine's Shift/Ctrl/Cmd pointer multi-select.
    if (zone && ev.detail === 0) {
      const card = zone.closest<HTMLElement>(
        '.widget-instance[data-instance-id^="ctrl-slot-"]',
      );
      const canvas = nCanvas;
      if (card && canvas && canvas.activeItem() !== card) canvas.setActive(card);
    }
    if (zone && assignHeld()) {
      const fnName = (zone.getAttribute("data-fn") ?? "").split(/\s+/)[0] ?? "";
      const padSlot =
        zone.closest<HTMLElement>("[data-pad-slot]")?.getAttribute("data-pad-slot") ??
        rdCtrlPanel?.slot_val ??
        "";
      const pad = rdCtrlPads.find((candidate) => String(candidate.slot) === padSlot);
      const source = pad?.sources?.find(
        (candidate) => candidate.source_id === currentAuthoringSource(),
      );
      // Canonical spelling and readable label from the SERVED pad tables —
      // the row DOM is never an implicit data store (nocturne's rule).
      const control = (source?.controls ?? pad?.controls ?? []).find(
        (candidate) => candidate.function.toLowerCase() === fnName.toLowerCase(),
      );
      const canonical = control?.function ?? fnName;
      const label = control?.label || pad?.fn_names?.[fnName] || fnName;
      if (fnName && padSlot &&
          resolveAssignWithControl(padSlot, canonical, label, ev.shiftKey)) {
        return;
      }
    }
    if (zone) {
      pendingLocateFns = zone.getAttribute("data-fn") ?? "";
      if (inspTab !== "controls") {
        inspTab = "controls";
        saveKbUi();
      }
      setInspector(true);
      renderInspector();
      return;
    }
    if (!hit) return;
    const closeMenuAfter = Boolean(target?.closest(".rd-menu"));
    if (hit === "dlg-noop") {
      // A click inside an open dialog panel: stays open.
      return;
    }
    if (hit === "rd-conf-force") {
      conflictForce();
      return;
    }
    if (hit === "rd-journey-action") {
      ev.preventDefault();
      const button = target?.closest<HTMLButtonElement>('[data-nx="rd-journey-action"]') ?? null;
      runJourneyAction(button?.dataset.journeyAction ?? "", button);
      return;
    }
    if (hit === "rd-review-recovery") {
      ev.preventDefault();
      focusCaptureRecovery();
      return;
    }
    if (hit === "rd-conf-cancel") {
      conflictCancel();
      return;
    }
    if (hit === "rd-learn-cancel") {
      if (assignHeld()) cancelAssign();
      else void cancelLearn();
      return;
    }
    if (hit === "rd-learn-skip") {
      skipAutoMapStep();
      return;
    }
    if (hit === "rd-automap") {
      startAutoMap();
      return;
    }
    if (hit === "chip-learn" || hit === "chip-add" || hit === "chip-remove") {
      // The row's own facts travel on its element, never re-derived here —
      // and the chip click must not also toggle the fold it sits in.
      ev.preventDefault();
      const holder = target?.closest<HTMLElement>("[data-fn]");
      const fnName = holder?.dataset.fn ?? "";
      const slot = holder?.dataset.slot ?? rdCtrlPanel?.slot_val ?? "";
      const label =
        holder?.querySelector(".n-bind-label")?.textContent?.trim() ||
        holder?.querySelector(".n-krow-chip")?.textContent?.trim() ||
        fnName;
      if (fnName && slot) {
        void startLearn({
          fn: fnName,
          label,
          slot,
          mode: hit.endsWith("add") ? "add" : hit.endsWith("remove") ? "remove" : "replace",
        });
      }
      return;
    }
    if (hit === "ctl-assign") {
      // A FREE control chip: click, then press a key (or click one on the
      // plate) — a replace-mode learn on an unbound control.
      const chip = target?.closest<HTMLElement>("[data-fn]");
      const fnName = chip?.dataset.fn ?? "";
      const slot = rdCtrlPanel?.slot_val ?? "";
      if (fnName && slot) {
        void startLearn({
          fn: fnName,
          label: chip?.textContent?.trim() || fnName,
          slot,
          mode: "replace",
        });
      }
      return;
    }
    if (hit === "key-assign" || hit === "key-remove") {
      // A Keys-tab row's +/−: take the key in hand, then click a control on
      // the pad (the assign twin; remove takes the key OFF the clicked one).
      const key = target?.closest<HTMLElement>("[data-key]")?.getAttribute("data-key") ?? "";
      if (key) armAssign(key, hit === "key-remove" ? "remove" : "add");
      return;
    }
    if (hit === "rd-akey") {
      // A FREE key chip in the Keys tab: the key goes in hand, replace-mode.
      const key = target?.closest<HTMLElement>("[data-key]")?.getAttribute("data-key") ?? "";
      if (key) armAssign(key, "replace");
      return;
    }
    if (hit === "rd-source-authoring") {
      const button = target?.closest<HTMLButtonElement>('[data-nx="rd-source-authoring"]');
      const selector = button?.dataset.selector ?? "";
      if (selector && mergeSourceIntoUrl(selector)) {
        mapperOnSlotChange();
        // The canonical nested source rows are already in memory. Repaint the
        // controller art immediately from the newly selected source instead
        // of leaving the previous keyboard's callouts visible until the
        // confirming network refresh returns.
        syncCtrlBench();
        const owner = button;
        button?.closest(".rd-controller-source-tabs")
          ?.querySelectorAll<HTMLButtonElement>('[data-nx="rd-source-authoring"]')
          .forEach((candidate) => {
            const selected = candidate.dataset.selector === selector;
            candidate.setAttribute("aria-pressed", String(selected));
            candidate.classList.toggle("on", selected);
          });
        void redesignRefreshFn().then(() => {
          if (
            document.activeElement !== document.body &&
            document.activeElement !== owner
          ) return;
          Array.from(
            rdRoot?.querySelectorAll<HTMLButtonElement>('[data-nx="rd-source-authoring"]') ?? [],
          ).find((candidate) => candidate.dataset.selector === selector)?.focus({
            preventScroll: true,
          });
        });
        rdAnnounce(`${button?.textContent?.replace(/ · not routed$/, "") ?? "Keyboard"} selected for mapping edits.`);
      }
      return;
    }
    if (hit === "rd-controller-color") {
      const button = target?.closest<HTMLButtonElement>('[data-nx="rd-controller-color"]');
      const slot = Number(button?.dataset.slot ?? "");
      const color = Number(button?.dataset.color ?? "");
      if (!button || !Number.isInteger(slot) || !Number.isInteger(color)) return;
      if (button.getAttribute("aria-disabled") === "true") {
        rdAnnounce(button.title || "That identity color is already in use.");
        return;
      }
      const identity = controllerColorStoreKey(slot);
      if (!identity || color < 1 || color > CONTROLLER_COLOR_NAMES.length) return;
      controllerColors[identity] = color;
      saveControllerColors();
      applyControllerIdentityColors();
      const body = inspectorEl()?.querySelector<HTMLElement>(".rd-insp-body");
      if (body) inspectorRenderFingerprints.delete(body);
      renderInspector();
      syncKbLens();
      rdAnnounce(`Player ${slot} now uses ${CONTROLLER_COLOR_NAMES[color - 1]}.`);
      return;
    }
    if (hit === "canvas-fit") {
      nCanvas?.fitAll();
    } else if (hit === "canvas-tidy") {
      tidyCanvas();
    } else if (hit === "kb-theme") {
      const theme = target?.closest<HTMLElement>("[data-keyboard-theme]")
        ?.dataset.keyboardTheme ?? "";
      if (theme) {
        kbTheme = theme;
        saveKbUi();
        syncKbLens();
      }
    } else if (hit === "kb-colors") {
      kbSolo = !kbSolo;
      saveKbUi();
      syncKbLens();
    } else if (hit === "legend-mute") {
      // One chip, one player's color on the keys — keyed by PRESET like
      // 4460's, so a crossing follows a controller through a reorder. A
      // click after solo CONTINUES from what the lens was showing: the
      // shortcut becomes the real mute set, then this chip toggles in it.
      const chip = target?.closest<HTMLElement>("[data-slot]");
      const preset = presetOfSlotRd(Number(chip?.getAttribute("data-slot") ?? ""));
      if (chip && preset !== undefined) {
        if (kbSolo) {
          kbSolo = false;
          const selectedSlot = rdCtrlPanel?.slot_val ?? "";
          for (const card of rdCtrlCards) {
            if (card.number === selectedSlot) kbHiddenStrips.delete(card.preset);
            else kbHiddenStrips.add(card.preset);
          }
        }
        if (kbHiddenStrips.has(preset)) kbHiddenStrips.delete(preset);
        else kbHiddenStrips.add(preset);
        saveKbStrips();
        saveKbUi();
        syncKbLens();
      }
    } else if (hit === "rd-fit-sel") {
      nCanvas?.fitSelection();
    } else if (hit === "rd-center-sel") {
      nCanvas?.centerSelection();
    } else if (hit === "rd-focus-sel") {
      const item = nCanvas?.activeItem();
      if (item) nCanvas?.toggleFocusMode(item);
    } else if (hit === "rd-encoder-profiles") {
      toggleEncoderProfileLab();
      return;
    } else if (hit === "rd-devs-open") {
      setDevModal(!devModalIsOpen());
      return;
    } else if (hit === "rd-rescan") {
      const button = target?.closest<HTMLButtonElement>('[data-nx="rd-rescan"]');
      if (button) void rescanDevices(button);
      return;
    } else if (hit === "rd-devs-close") {
      setDevModal(false);
      return;
    } else if (hit === "rd-dev-toggle") {
      const selector = target?.closest<HTMLElement>('[data-nx="rd-dev-toggle"]')?.dataset
        .selector;
      if (selector) void toggleBenchDevice(selector);
      return;
    } else if (hit === "rd-offline-remove") {
      const selector = target?.closest<HTMLElement>(".rd-dev-node[data-selector]")?.dataset
        .selector;
      if (selector) void toggleBenchDevice(selector);
      return;
    } else if (hit === "rd-ctrls-open") {
      setCtrlModal(!ctrlModalIsOpen());
      return;
    } else if (hit === "rd-ctrls-close") {
      setCtrlModal(false);
      return;
    } else if (hit === "rd-ctrl-discard") {
      const ghost = target?.closest<HTMLElement>('[data-nx="rd-ctrl-discard"]')?.dataset
        .ghost;
      if (ghost) unparkController(ghost);
      return;
    } else if (hit === "rd-zoom-menu") {
      setZoomMenu(!zoomMenuOpen());
      return;
    } else if (hit === "rd-z-25") {
      nCanvas?.setZoomTo(0.25, "before zoom menu pick");
    } else if (hit === "rd-z-50") {
      nCanvas?.setZoomTo(0.5, "before zoom menu pick");
    } else if (hit === "rd-z-75") {
      nCanvas?.setZoomTo(0.75, "before zoom menu pick");
    } else if (hit === "rd-z-100") {
      nCanvas?.resetZoom();
    } else if (hit === "rd-z-150") {
      nCanvas?.setZoomTo(1.5, "before zoom menu pick");
    } else if (hit === "canvas-zoom-in") {
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-zoom-out") {
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-map") {
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (hit === "rd-tool-select") {
      nCanvas?.setToolMode("select");
    } else if (hit === "rd-tool-hand") {
      nCanvas?.setToolMode("hand");
    } else if (hit === "rd-back") {
      nCanvas?.backView();
    } else if (hit === "rd-insp-close") {
      // The inspector is Focus mode's editing surface. Closing it must leave
      // that mode too, or the rest of the canvas remains inert behind a panel
      // that is no longer visible.
      nCanvas?.exitFocusMode();
      setInspector(false);
      focusCanvasContext();
    } else if (hit === "rd-w-smaller" || hit === "rd-w-bigger" || hit === "rd-w-reset") {
      const widget = nCanvas?.activeItem();
      if (widget && nCanvas) {
        if (hit === "rd-w-smaller") nCanvas.adjustItemScale(widget, -1);
        else if (hit === "rd-w-bigger") nCanvas.adjustItemScale(widget, 1);
        else nCanvas.resetItemScale(widget);
        renderInspector();
      }
    } else if (hit === "rd-search") {
      setPalette(true);
    } else if (hit === "rd-keys") {
      setSheet(true);
    } else if (hit === "rd-sheet-close") {
      setSheet(false);
    } else if (hit === "rd-palette-close") {
      setPalette(false);
    }
    if (closeMenuAfter) setZoomMenu(false);
  });

  const paletteInput = root.querySelector<HTMLInputElement>(".rd-palette-input");
  paletteInput?.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette(paletteInput.value);
  });
  paletteInput?.addEventListener("keydown", paletteKeydown);
  root.querySelector<HTMLElement>(".rd-palette-card")
    ?.addEventListener("keydown", trapDialogTab);
  root.querySelector<HTMLElement>(".rd-sheet-card")
    ?.addEventListener("keydown", trapDialogTab);

  const zoomTrigger = zoomMenuTrigger();
  const zoomMenu = root.querySelector<HTMLElement>(".rd-menu");
  zoomTrigger?.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" && event.key !== " " &&
      event.key !== "ArrowDown" && event.key !== "ArrowUp"
    ) return;
    event.preventDefault();
    event.stopPropagation();
    setZoomMenu(true, event.key === "ArrowUp" ? "last" : "first");
  });
  zoomMenu?.addEventListener("keydown", (event) => {
    const items = zoomMenuItems();
    if (items.length === 0) return;
    const activeIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      event.stopPropagation();
      items[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setZoomMenu(false);
    } else if (event.key === "Tab") {
      // A menu is not a focus trap. Move to the adjacent zoom-cluster
      // control explicitly so hiding the focused popup cannot strand focus.
      event.preventDefault();
      event.stopPropagation();
      const destination = event.shiftKey
        ? zoomTrigger
        : root.querySelector<HTMLButtonElement>('[data-nx="canvas-zoom-in"]');
      setZoomMenu(false, "first", false);
      destination?.focus({ preventScroll: true });
    }
  });
  window.addEventListener("resize", () => {
    nCanvas?.setSafeInsetRight(inspectorInset(), true);
    scheduleChips();
  });

  window.addEventListener("keydown", (ev) => {
    // Ctrl/Cmd+K / F open the palette from ANYWHERE, a text field included —
    // the one binding checked before the typing guard. NOT while a mapping
    // gesture holds the page: a key in hand or an armed learn owns the
    // keyboard (nocturne's Ctrl+K-only-when-idle rule).
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "f")) {
      if (root.querySelector<HTMLElement>("[data-rd-apply-dialog]:not([hidden])")) {
        ev.preventDefault();
        return;
      }
      if (mapperBusy()) return;
      ev.preventDefault();
      setPalette(!paletteOpen());
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // The engine's own targeted handlers (viewport arrows, the widget
    // shell's Escape/Enter) run before this window listener and
    // preventDefault when they act — never double-handle their keys.
    if (ev.defaultPrevented) return;
    if (ev.repeat && (
      ev.key === "Escape" || ev.key === "f" || ev.key === "F" ||
      ev.key === "m" || ev.key === "M" || ev.key === "?"
    )) {
      ev.preventDefault();
      return;
    }
    if (ev.key === "Escape") {
      // The MAPPER's rung sits at the top of the ladder: an open conflict
      // dialog, a key in hand, or an armed learn consumes Escape before any
      // chrome closes (the learn's own capture guard never sees Escape —
      // this is its one deterministic exit).
      if (mapperEscape()) {
        ev.preventDefault();
        return;
      }
      // The macro editor's rung: below the mapper's gestures, above every
      // chrome disclosure — its own close (with the unsaved-work warning)
      // is the honest thing Escape can do while the roll is open.
      if (rdMacOpen()) {
        ev.preventDefault();
        rdMacClose();
        return;
      }
      // The escape ladder (design handoff §2), one rung per press: theme
      // menu → device picker → sheet → palette → camera menu → focus mode →
      // back view → clear selection. A closed disclosure returns focus to
      // its trigger instead of letting the same key reach the canvas below.
      if (closeThemeMenu(true)) {
        ev.preventDefault();
        return;
      }
      if (closeRedesignToolsDisclosure(root, true)) {
        ev.preventDefault();
        return;
      }
      if (ctrlModalIsOpen()) setCtrlModal(false);
      else if (devModalIsOpen()) setDevModal(false);
      else if (sheetOpen()) setSheet(false);
      else if (paletteOpen()) setPalette(false);
      else if (zoomMenuOpen()) setZoomMenu(false);
      // Escape in an Inspector field belongs to that field; it must never
      // pop camera history or clear the selection being edited.
      else if (typingIntoSomething(ev)) return;
      else if (nCanvas?.isFocusModeActive()) {
        nCanvas.exitFocusMode();
      } else if (!nCanvas?.backView()) {
        nCanvas?.clearActive();
      }
      ev.preventDefault();
      return;
    }
    if (typingIntoSomething(ev)) return;
    // While a key is in hand (BY-KEY assign) or the conflict dialog is up,
    // the single-key canvas shortcuts suspend — pressing F with a key held
    // must not enter focus mode (the learn's capture guard swallows its own
    // keys; assign deliberately arms no guard, so THIS is its guard).
    if (mapperBusy()) return;
    // Unmodified design-tool shortcuts belong to the canvas. Keep them from
    // firing while focus is in the title bar or Inspector; Cmd/Ctrl+K and the
    // Escape ladder above remain intentionally global.
    if (!canvasOwnsKeyboardFocus()) return;
    const key = ev.key;
    if (key === "+" || key === "=") {
      ev.preventDefault();
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (key === "-") {
      ev.preventDefault();
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (key === "0") {
      ev.preventDefault();
      nCanvas?.resetZoom();
    } else if (key === "1") {
      ev.preventDefault();
      nCanvas?.fitAll();
    } else if (key === "2") {
      ev.preventDefault();
      nCanvas?.fitSelection();
    } else if (key === "c" || key === "C") {
      ev.preventDefault();
      nCanvas?.centerSelection();
    } else if (key === "f" || key === "F") {
      const item = nCanvas?.activeItem();
      if (item) {
        ev.preventDefault();
        nCanvas?.toggleFocusMode(item);
      }
    } else if (key === "m" || key === "M") {
      ev.preventDefault();
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (key === "v" || key === "V") {
      ev.preventDefault();
      nCanvas?.setToolMode("select");
    } else if (key === "h" || key === "H") {
      ev.preventDefault();
      nCanvas?.setToolMode("hand");
    } else if (key === "?") {
      ev.preventDefault();
      setSheet(!sheetOpen());
    } else if (
      key === "ArrowLeft" || key === "ArrowRight" ||
      key === "ArrowUp" || key === "ArrowDown"
    ) {
      // Arrows move the SELECTION (12px, shift 1px) when one exists; with
      // nothing selected the engine's own viewport arrows pan the camera.
      const step = ev.shiftKey ? 1 : 12;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      if (nCanvas?.moveSelectionBy(dx, dy)) ev.preventDefault();
    }
  });
}

// ── The island ──────────────────────────────────────────────────────────────

/** The same native Theme disclosure has two responsive homes: the desktop
 * rail and the compact Setup panel. Both render the server-owned rows and
 * ordinary POST forms, so narrow screens do not trade product access for fit
 * and the no-script path remains complete. Distinct presentation classes keep
 * the long-standing desktop selectors singular; data-rd-theme-* is the shared
 * behavior contract. */
function redesignThemeDisclosure() {
  return h(
    "details",
    { class: "rd-themed", "data-rd-theme-menu": "" },
    h(
      "summary",
      {
        class: "rd-theme-sum",
        title: "How the Studio looks",
        "aria-label": "Choose Studio theme",
        "data-rd-theme-summary": "",
      },
      "◐ Theme",
    ),
    h(
      "div",
      { class: "rd-thememenu" },
      h("div", { class: "n-kick-row" }, h("span", { class: "n-kick" }, "How the Studio looks")),
      h(
        "p",
        { class: "n-devnote" },
        "Pages follow the operating system's light or dark choice unless you pick one here.",
      ),
      createList(
        () => rdThemeRows(),
        (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls + "|" + r.chosen,
        (r) =>
          h(
            "form",
            {
              class: "n-modeform",
              method: "post",
              action: "/redesign/theme",
              "data-rd-form": "theme",
            },
            h("input", { type: "hidden", name: "theme", value: r.name }),
            h(
              "button",
              {
                type: "submit",
                class: r.cls,
                "aria-current": r.chosen,
              },
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
    ),
  );
}

function redesignCompactThemeDisclosure() {
  return h(
    "details",
    { class: "rd-themed-compact", "data-rd-theme-menu": "" },
    h(
      "summary",
      {
        class: "rd-theme-compact-sum",
        title: "How the Studio looks",
        "aria-label": "Choose Studio theme",
        "data-rd-theme-summary": "",
      },
      "◐ Theme",
    ),
    h(
      "div",
      { class: "rd-thememenu-compact" },
      h("div", { class: "n-kick-row" }, h("span", { class: "n-kick" }, "How the Studio looks")),
      h(
        "p",
        { class: "n-devnote" },
        "Pages follow the operating system's light or dark choice unless you pick one here.",
      ),
      createList(
        () => rdCompactThemeRows(),
        (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls + "|" + r.chosen,
        (r) =>
          h(
            "form",
            {
              class: "n-modeform",
              method: "post",
              action: "/redesign/theme",
              "data-rd-form": "theme",
            },
            h("input", { type: "hidden", name: "theme", value: r.name }),
            h(
              "button",
              {
                type: "submit",
                class: r.cls,
                "aria-current": r.chosen,
              },
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
    ),
  );
}

export function RedesignIsland() {
  return h(
    "div",
    {
      class: "nocturne rd",
      // The stream is opened only after adoption, so its visual state cannot
      // be server-painted. This narrow marker lets hydration parity ignore
      // only the client-owned data-rd-live-state attribute while continuing
      // to compare every durable lifecycle sentence and control.
      "data-client-live-state": "",
    },
    h(
      "main",
      { class: "n-main" },
      h(
        "section",
        { class: "n-center" },
        h(
          "div",
          { class: "n-meta rd-top" },
          // Product identity. The route remains /redesign during construction,
          // but the surface is the workbench people will actually use — it
          // should not make them reason about an internal migration name.
          h("span", { class: "rd-brand" }, "ksx Studio"),
          h("span", { class: "rd-crumb" }, "Workbench"),
          // Which machine answers this lane — the fixture badge, so the
          // redesign workbench can never be mistaken for the cabinet.
          h(
            "span",
            {
              class: () => rdEnvCls(),
              title: () => rdEnvAccessibleText(),
              "aria-label": () => rdEnvAccessibleText(),
            },
            h(
              "span",
              { class: "n-environment-full", "aria-hidden": "true" },
              () => rdEnvFullText(),
            ),
            h(
              "span",
              { class: "n-environment-compact", "aria-hidden": "true" },
              () => rdEnvCompactText(),
            ),
          ),
          // The compact setup spine expands into the operational shell. A
          // native details keeps every recovery and lifecycle form usable on
          // the SSR/no-script path; JavaScript only adds in-place repaint and
          // focus polish. Games, layouts and maintenance deliberately do not
          // join this payload — the next Library block owns those reads.
          h(
            "details",
            { class: "rd-setupd" },
            h(
              "summary",
              { class: "rd-setup-sum", title: "Setup progress, draft, session and input readiness" },
              h("span", { class: "rd-setup-mark", "aria-hidden": "true" }, "◆"),
              h("span", { class: "rd-setup-compact" }, () => rdJourneyCompact()),
              h("span", { class: "rd-setup-divider", "aria-hidden": "true" }, "·"),
              h("span", { class: "rd-draft-label" }, () => rdOpDraftLabel()),
              h("span", { class: "rd-caret", "aria-hidden": "true" }, "⌄"),
            ),
            h(
              "div",
              { class: "rd-setup-panel" },
              h(
                "div",
                { class: "rd-setup-panel-head" },
                h(
                  "div",
                  null,
                  h("span", { class: "n-kick" }, "Setup"),
                  h("p", { class: "rd-setup-line" }, () => rdJourneyLine()),
                ),
                h("span", { class: "rd-refresh-health", role: "status", hidden: "" }),
                h(
                  "span",
                  {
                    class: "rd-buildmeta",
                    title: "Studio build version — include this in a support report",
                    "aria-label": "Studio build version",
                  },
                  "v",
                  () => rdStudioVersion(),
                ),
                h(
                  "div",
                  { class: "rd-theme-compact-home" },
                  redesignCompactThemeDisclosure(),
                ),
              ),
              h(
                "div",
                { class: "rd-utility-compact-home" },
                redesignCompactToolsDisclosure(),
              ),
              h(
                "nav",
                { class: "rd-journey", "aria-label": "Setup progress" },
                createList(
                  () => rdJourneyRows(),
                  (row) => `${row.key}|${row.action}|${row.badge}|${row.cls}|${row.title}|${row.detail}`,
                  (row) =>
                    h(
                      "button",
                      {
                        type: "button",
                        class: row.cls,
                        "data-nx": "rd-journey-action",
                        "data-journey-step": row.key,
                        "data-journey-action": row.action,
                        "aria-current": row.aria_current,
                      },
                      h("span", { class: "rd-journey-badge" }, row.badge),
                      h(
                        "span",
                        { class: "rd-journey-copy" },
                        h("strong", null, row.title),
                        h("span", null, row.detail),
                      ),
                    ),
                ),
              ),
              h(
                "div",
                { class: "rd-setup-grid" },
                h(
                  "section",
                  { class: "rd-setup-card rd-draft-card", "aria-labelledby": "rd-draft-head" },
                  h("h2", { id: "rd-draft-head" }, "Draft and saved setup"),
                  h("p", { class: "rd-card-lede" }, () => rdOpDraftDetail()),
                  h(
                    "div",
                    { class: "rd-saved-row" },
                    h("strong", null, () => rdOpSavedLabel()),
                    h("span", null, () => rdOpSavedDetail()),
                  ),
                  h(
                    "form",
                    { method: "post", action: "/redesign/adopt", "data-rd-form": "adopt" },
                    h(
                      "button",
                      {
                        type: "submit",
                        class: "rd-panel-action",
                        disabled: () => rdAdoptDisabled(),
                        "aria-describedby": "rd-adopt-reason",
                      },
                      h("span", { class: "rd-action-label" }, () => rdAdoptLabel()),
                      h("span", { class: "rd-action-pending", hidden: "" }, "Loading…"),
                    ),
                  ),
                  h("p", { id: "rd-adopt-reason", class: "rd-action-reason" }, () => rdAdoptReason()),
                  h(
                    "details",
                    { class: "rd-start-over" },
                    h("summary", null, "Start over…"),
                    h("p", { id: "rd-discard-reason", class: "rd-action-reason" }, () => rdDiscardReason()),
                    h(
                      "form",
                      { method: "post", action: "/redesign/discard", "data-rd-form": "discard" },
                      h("input", {
                        type: "hidden",
                        name: "expected_revision",
                        value: () => rdDraftRevision(),
                      }),
                      h(
                        "label",
                        { class: () => rdDiscardConfirmCls() },
                        h("input", {
                          type: "checkbox",
                          name: "confirm_discard",
                          value: "yes",
                          required: () => rdDraftDirty(),
                        }),
                        "Discard unsaved edits",
                      ),
                      h(
                        "button",
                        {
                          type: "submit",
                          class: "rd-panel-action danger",
                          disabled: () => rdDiscardDisabled(),
                          "aria-describedby": "rd-discard-reason",
                        },
                        h("span", { class: "rd-action-label" }, () => rdDiscardLabel()),
                        h("span", { class: "rd-action-pending", hidden: "" }, "Clearing…"),
                      ),
                    ),
                  ),
                ),
                h(
                  "section",
                  {
                    class: () => rdOpSessionCls(),
                    "aria-labelledby": "rd-session-head",
                  },
                  h("h2", { id: "rd-session-head" }, "Session"),
                  h(
                    "p",
                    { class: "rd-state-strip", "aria-label": "Session state" },
                    h(
                      "span",
                      {
                        class: "rd-state-badge",
                        "data-state": () => rdOpSessionBadgeState(),
                      },
                      () => rdOpSessionBadge(),
                    ),
                  ),
                  h("p", { class: "rd-card-lede" }, () => rdOpSessionLine()),
                  h("p", { class: "rd-escape-line" }, () => rdOpEscapeLine()),
                  h("dl", { class: "rd-action-notes" },
                    h("dt", null, "Save"),
                    h("dd", { id: "rd-save-reason" }, () => rdSaveReason()),
                    h("dt", null, "Play"),
                    h("dd", { id: "rd-play-reason", tabindex: "-1" }, () => rdPlayReason()),
                    h("dt", null, "Apply"),
                    h("dd", { id: "rd-apply-reason" }, () => rdApplyReason()),
                    h("dt", null, "Stop"),
                    h("dd", { id: "rd-stop-reason" }, () => rdStopReason()),
                  ),
                  h(
                    "p",
                    { class: "rd-gamebar-help" },
                    h(
                      "span",
                      null,
                      "If a controller shortcut opens Xbox Game Bar or capture overlays interfere, check its Windows setting. ",
                    ),
                    h(
                      "a",
                      { href: "ms-settings:gaming-gamebar" },
                      "Open Game Bar settings",
                    ),
                  ),
                  h(
                    "form",
                    {
                      class: () => rdReplacePlayCls(),
                      method: "post",
                      action: "/redesign/play",
                      "data-rd-form": "play-replace",
                    },
                    h("input", {
                      type: "hidden",
                      name: "expected_revision",
                      value: () => rdDraftRevision(),
                    }),
                    h(
                      "button",
                      {
                        type: "submit",
                        class: "rd-panel-action",
                        disabled: () => rdPlayDisabled(),
                        "aria-describedby": "rd-play-reason",
                      },
                      h("span", { class: "rd-action-label" }, "Replace session"),
                      h("span", { class: "rd-action-pending", hidden: "" }, "Replacing…"),
                    ),
                  ),
                ),
                h(
                  "section",
                  {
                    class: "rd-setup-card rd-capture-card",
                    id: "rd-capture-readiness",
                    tabindex: "-1",
                    "data-capture-mode": () => rdCaptureMode(),
                    "aria-labelledby": "rd-capture-head",
                  },
                  h("h2", { id: "rd-capture-head" }, () => rdCaptureHeading()),
                  h(
                    "p",
                    { class: "rd-state-strip", "aria-label": "Input state" },
                    h(
                      "span",
                      {
                        class: "rd-state-badge",
                        "data-state": () => rdCaptureStateTone(),
                      },
                      () => rdCaptureStateLabel(),
                    ),
                    h("span", { class: "rd-state-device" }, () => rdCaptureDeviceLabel()),
                  ),
                  h("p", { class: "rd-card-lede" }, () => rdCaptureLine()),
                  h("p", { class: "rd-capture-recovery-line" }, () => rdCaptureRecoveryLine()),
                  h(
                    "form",
                    {
                      class: () => rdCapturePrepareCls(),
                      method: "post",
                      action: "/redesign/capture/prepare",
                      "data-rd-form": "capture-prepare",
                    },
                    h("input", { type: "hidden", name: "expected_selector", value: () => rdCaptureSelector() }),
                    h("input", { type: "hidden", name: "instance_id", value: () => rdCaptureInstance() }),
                    h(
                      "label",
                      { class: "rd-consent" },
                      h("input", { type: "checkbox", name: "confirm_spare_keyboard", value: "yes", required: "" }),
                      h("span", null, "I connected and tested a different keyboard that can still type."),
                    ),
                    h(
                      "label",
                      { class: "rd-consent" },
                      h("input", { type: "checkbox", name: "confirm_rebind", value: "yes", required: "" }),
                      h("span", null, "I understand this exact input stops ordinary typing until I release it here."),
                    ),
                    h(
                      "label",
                      { class: "rd-consent" },
                      h("input", { type: "checkbox", name: "confirm_machine_certificate", value: "yes", required: "" }),
                      h("span", null, "I allow ksx to install its machine-local signing certificate for this generated driver package."),
                    ),
                    h(
                      "button",
                      {
                        type: "submit",
                        class: "rd-panel-action primary",
                        "data-rd-product-disabled": "false",
                      },
                      h("span", { class: "rd-action-label" }, "Prepare this input"),
                      h("span", { class: "rd-action-pending", hidden: "" }, "Preparing…"),
                    ),
                    h("p", { class: "rd-action-reason" }, "Windows will ask for permission. ksx stays open and returns here afterward."),
                  ),
                  h(
                    "div",
                    { class: () => rdCaptureHeldCls() },
                    h("h3", null, "Keyboards held by ksx"),
                    h("p", { class: "rd-action-reason" }, "Release is resolved from the current Windows device tree, even when the draft is empty."),
                    createList(
                      () => rdCaptureHeld(),
                      (row) => row.key,
                      (row) =>
                        h(
                          "article",
                          {
                            class: "rd-held-row",
                            tabindex: "-1",
                            "data-held-key": row.key,
                            "data-held-selector": row.selector,
                            "data-held-instance": row.instance,
                          },
                          h(
                            "div",
                            null,
                            h("strong", null, row.name),
                            h("span", null, row.summary),
                            h("span", { class: "rd-held-note" }, row.note),
                          ),
                          h(
                            "form",
                            { method: "post", action: "/redesign/capture/release", "data-rd-form": "capture-release" },
                            h("input", { type: "hidden", name: "expected_selector", value: row.selector }),
                            h("input", { type: "hidden", name: "instance_id", value: row.instance }),
                            h(
                              "label",
                              { class: "rd-consent compact" },
                              h("input", {
                                type: "checkbox",
                                name: "confirm_release",
                                value: "yes",
                                required: "",
                                disabled: row.disabled,
                              }),
                              h("span", null, "Return this keyboard to ordinary typing"),
                            ),
                            h(
                              "button",
                              {
                                type: "submit",
                                class: "rd-panel-action",
                                disabled: row.disabled,
                              },
                              h("span", { class: "rd-action-label" }, "Release"),
                              h("span", { class: "rd-action-pending", hidden: "" }, "Releasing…"),
                            ),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          // The workbench feed: open the device picker. Scripting-only
          // chrome (`.n-autobtn`), rightly — the canvas it feeds is too.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-adddev",
              "data-nx": "rd-devs-open",
              "aria-controls": "rd-device-picker",
              "aria-expanded": "false",
              title: "Add devices to the workbench",
            },
            "＋ Devices",
          ),
          // The other half of the workbench: stage virtual controllers. The
          // daemon owns every consequence — numbering, the XInput ceiling,
          // persona availability — and the cards mirror its slots exactly.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-addctrl",
              "data-nx": "rd-ctrls-open",
              "aria-controls": "rd-controller-picker",
              "aria-expanded": "false",
              title: "Stage virtual controllers on the workbench",
            },
            "＋ Controllers",
          ),
          // Temporary internal research harness. It remains hidden from the
          // product chrome but stays mountable in the review fixtures that
          // approve encoder profiles and edge states.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-encoder-lab-toggle",
              "data-nx": "rd-encoder-profiles",
              "aria-pressed": "false",
              "aria-label": "Encoder profiles",
              "aria-hidden": "true",
              tabindex: "-1",
              hidden: "",
              // The NOT-SHOWN state's words — first paint's truth. The sync
              // fn rewrites this title at every toggle, and hydration runs
              // it once, so the served bytes must say what that first run
              // says or the parity gate reads the rewrite as drift.
              title: "Inspect connected and reference encoder profiles on the canvas",
            },
            "◇ Encoders",
          ),
          h("span", { class: "rd-spring" }),
          // Operational actions stay visible and explain disabled states in
          // the Setup disclosure. Play never implies Save; Apply never
          // implies disk persistence; Stop remains a dedicated escape from
          // the live session. This separation is the product contract.
          h(
            "div",
            { class: "rd-run-actions", role: "group", "aria-label": "Lifecycle controls" },
            h(
              "span",
              {
                class: "rd-live-state",
                "data-rd-live-status": "",
                "data-live-chatter": "",
                role: "status",
              },
              h("span", { class: "rd-live-short", "aria-hidden": "true" }),
              h("span", { class: "rd-live-detail" }),
            ),
            h(
              "button",
              {
                type: "button",
                class: "rd-live-retry",
                "data-nx": "rd-live-retry",
                "data-rd-live-retry": "",
                "data-live-chatter": "",
                "aria-label": "Check live input status again",
              },
              "Retry",
            ),
            h("span", {
              class: "rd-live-stats",
              "data-rd-live-stats": "",
              "data-live-chatter": "",
              "aria-hidden": "true",
            }),
            h("span", {
              class: "rd-live-ticker",
              "data-rd-live-ticker": "",
              "data-live-chatter": "",
              "aria-hidden": "true",
            }),
            h(
              "form",
              { class: "rd-runform rd-saveform", method: "post", action: "/redesign/save", "data-rd-form": "save" },
              h("input", {
                type: "hidden",
                name: "expected_revision",
                value: () => rdDraftRevision(),
              }),
              h(
                "button",
                {
                  type: "submit",
                  class: "rd-runbtn",
                  disabled: () => rdSaveDisabled(),
                  "aria-describedby": "rd-save-reason",
                },
                h("span", { class: "rd-action-label" }, () => rdSaveLabel()),
                h("span", { class: "rd-action-pending", hidden: "" }, "Saving…"),
              ),
            ),
            h(
              "form",
              { class: () => rdApplyCls(), method: "post", action: "/redesign/apply", "data-rd-form": "apply" },
              h("input", {
                type: "hidden",
                name: "expected_revision",
                value: () => rdDraftRevision(),
              }),
              h(
                "button",
                {
                  type: "submit",
                  class: "rd-runbtn apply",
                  disabled: () => rdApplyDisabled(),
                  "aria-describedby": "rd-apply-reason",
                },
                h("span", { class: "rd-action-label" }, () => rdApplyLabel()),
                h("span", { class: "rd-action-pending", hidden: "" }, "Applying…"),
              ),
            ),
            h(
              "form",
              { class: () => rdPlayCls(), method: "post", action: "/redesign/play", "data-rd-form": "play" },
              h("input", {
                type: "hidden",
                name: "expected_revision",
                value: () => rdDraftRevision(),
              }),
              h(
                "button",
                {
                  type: "submit",
                  class: "rd-runbtn primary",
                  disabled: () => rdPlayDisabled(),
                  "aria-describedby": "rd-play-reason",
                },
                h("span", { class: "rd-action-icon", "aria-hidden": "true" }, "▷"),
                h("span", { class: "rd-action-label" }, () => rdPlayLabel()),
                h("span", { class: "rd-action-pending", hidden: "" }, "Starting…"),
              ),
            ),
            h(
              "form",
              { class: () => rdStopCls(), method: "post", action: "/redesign/stop", "data-rd-form": "stop" },
              h(
                "button",
                {
                  type: "submit",
                  class: "rd-runbtn stop",
                  disabled: () => rdStopDisabled(),
                  "aria-describedby": "rd-stop-reason",
                },
                h("span", { class: "rd-action-icon", "aria-hidden": "true" }, "■"),
                h("span", { class: "rd-action-label" }, () => rdStopLabel()),
                h("span", { class: "rd-action-pending", hidden: "" }, "Stopping…"),
              ),
            ),
          ),
          // The short undo window after a ✕ removal — the nocturne chip's
          // contract verbatim: the SERVER holds the resurrection material
          // and serves this chip while the window lasts; the verb replays
          // it. No JavaScript state — a reload keeps the offer.
          h(
            "form",
            {
              role: "status",
              method: "post",
              action: "/redesign/controller/undo",
              "data-rd-form": "controller-undo",
              class: () => rdUndoCls(),
            },
            h("span", { class: "n-undo-lab" }, () => rdUndoLabel()),
            h("button", { class: "n-undo-btn", type: "submit" }, "Undo"),
          ),
          // The mapper's capture toast — SSR'd hidden; the mapper module
          // writes it imperatively on user action only (interaction state,
          // never payload truth — nocturne's learnbar contract).
          h(
            "div",
            { role: "status", class: "rd-learnbar n-learnbar none" },
            h(
              "span",
              { class: "n-learn-txt" },
              h("span", { class: "n-learn-line rd-learn-line" }),
              h("span", { class: "n-learn-sub rd-learn-sub" }),
            ),
            h(
              "label",
              { class: "n-chain rd-chain", hidden: "" },
              h("input", { type: "checkbox", class: "n-chain-box rd-chain-box" }),
              "Bind several",
            ),
            h(
              "button",
              { type: "button", "data-nx": "rd-learn-skip", class: "n-bbtn sm", hidden: "" },
              "Skip",
            ),
            h(
              "button",
              { type: "button", class: "n-bbtn sm", "data-nx": "rd-learn-cancel" },
              "Cancel",
            ),
          ),
          // Back view: appears the moment the camera history is non-empty;
          // its title carries the top entry's label.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-back",
              "data-nx": "rd-back",
              title: "Back view",
              hidden: "",
            },
            "↩ Back view",
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-search",
              "data-nx": "rd-search",
              title: "Search widgets and commands",
            },
            "Search",
            h("kbd", { class: "rd-kbd" }, "Ctrl K"),
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn n-zbtn",
              "data-nx": "rd-keys",
              "aria-label": "Canvas control — the shortcut sheet",
              title: "Canvas control (?)",
            },
            "⌨",
          ),
          // The desktop home of the native Theme disclosure. Compact widths
          // render the same forms inside Setup, where they remain reachable
          // without competing with lifecycle verbs for rail width.
          h(
            "div",
            { class: "rd-theme-rail-home" },
            redesignThemeDisclosure(),
          ),
          h(
            "div",
            { class: "rd-utility-rail-home" },
            redesignToolsDisclosure(),
          ),
          h("span", { role: "status", class: "n-live-sr", "data-live-chatter": "" }),
        ),
        // Persistent machine recovery: unlike the Setup summary, this cannot
        // be collapsed away. It is intentionally not a live region—polls may
        // refresh its facts every two seconds, while actions announce through
        // the page's one shared status channel.
        h(
          "section",
          {
            class: () => rdCaptureAttentionCls(),
            "data-rd-attention": "",
            role: "region",
            "aria-labelledby": "rd-attention-title",
          },
          h("span", { class: "rd-attention-mark", "aria-hidden": "true" }, "!"),
          h(
            "div",
            { class: "rd-attention-copy" },
            h("span", { class: "rd-attention-kick" }, "Action required"),
            h(
              "h2",
              { id: "rd-attention-title" },
              () => rdCaptureAttentionTitle(),
            ),
            h("p", { class: "rd-attention-line" }, () => rdCaptureAttentionLine()),
            h("p", { class: "rd-attention-detail" }, () => rdCaptureAttentionDetail()),
          ),
          h(
            "div",
            { class: "rd-attention-actions" },
            h(
              "button",
              {
                type: "button",
                class: "rd-panel-action primary",
                "data-nx": "rd-review-recovery",
              },
              () => rdCaptureAttentionReviewLabel(),
            ),
            h(
              "button",
              {
                type: "button",
                class: () => rdCaptureAttentionRetryCls(),
                "data-nx": "rd-refresh-retry",
              },
              "Check again",
            ),
          ),
        ),
        // Transport freshness is separate from product/capture state. Keep
        // the last authoritative workbench visible, but give stale state a
        // named, persistent retry action instead of a border on Setup alone.
        h(
          "section",
          {
            class: "rd-health-alert",
            "data-rd-health-alert": "",
            role: "region",
            "aria-labelledby": "rd-health-title",
            hidden: "",
          },
          h(
            "div",
            null,
            h("strong", { id: "rd-health-title" }, "Workbench connection"),
            h("p", { "data-rd-health-message": "", role: "status", "aria-live": "polite" }),
          ),
          h(
            "button",
            { type: "button", class: "rd-panel-action", "data-nx": "rd-refresh-retry" },
            "Retry now",
          ),
        ),
        // Identify is also a native transaction. The modal is intentionally
        // scripting-only, so this compact server form is its no-script door:
        // the same next-key listen, the same explicit staging consequence,
        // and the same POST → 303 result without pretending the canvas works.
        h(
          "section",
          {
            class: "rd-identify-card rd-identify-native",
            "aria-labelledby": "rd-identify-native-title",
          },
          h(
            "div",
            { class: "rd-identify-copy" },
            h("h2", { id: "rd-identify-native-title" }, "Identify an exact device"),
            h(
              "p",
              null,
              "Press the action, then press one key on the exact keyboard or encoder. A successful answer adds that connection as an independent mapping source; nothing is captured, saved, or started.",
            ),
          ),
          h(
            "form",
            { method: "post", action: "/redesign/device/identify" },
            h(
              "button",
              { type: "submit", class: "rd-panel-action rd-identify-start" },
              "Identify exact device",
            ),
          ),
        ),
        // Action results need room to be read. The legacy topbar pill clipped
        // the exact recovery sentence behind an ellipsis; this banner is a
        // real row and disappears entirely when there is no action outcome.
        h("div", { role: "status", class: () => rdFlashCls() }, () => rdFlashLine()),
        // Apply can update bindings in place, but structural changes require
        // replacing the running controller session. This dialog is a
        // scripted enhancement of the ordinary Apply form: the no-script
        // path receives the same fixed recovery sentence and never loses the
        // verb. The daemon's exact difference is inserted into the lede.
        h(
          "div",
          { class: "rd-restart-back", "data-rd-apply-dialog": "", hidden: "" },
          h("div", { class: "rd-restart-scrim", "data-rd-apply-cancel": "" }),
          h(
            "section",
            {
              class: "rd-restart-dialog",
              role: "dialog",
              "aria-modal": "true",
              "aria-labelledby": "rd-restart-title",
              "aria-describedby": "rd-restart-message rd-restart-note",
              tabindex: "-1",
            },
            h("span", { class: "n-kick" }, "Session restart needed"),
            h(
              "h2",
              { id: "rd-restart-title" },
              "These changes cannot be applied while Play is running",
            ),
            h("p", { id: "rd-restart-message", "data-rd-apply-message": "" }),
            h(
              "p",
              { id: "rd-restart-note", class: "rd-restart-note" },
              "Replace session briefly unplugs and reconnects the virtual controllers. A game may notice that reconnect.",
            ),
            h(
              "div",
              { class: "rd-restart-actions" },
              h(
                "button",
                { type: "button", class: "rd-panel-action", "data-rd-apply-cancel": "" },
                "Keep playing as-is",
              ),
              h(
                "form",
                { method: "post", action: "/redesign/play", "data-rd-form": "play-replace" },
                h("input", {
                  type: "hidden",
                  name: "expected_revision",
                  value: "",
                  "data-rd-apply-revision": "",
                }),
                h(
                  "button",
                  {
                    type: "submit",
                    class: "rd-panel-action primary",
                    "data-rd-product-disabled": "false",
                  },
                  h("span", { class: "rd-action-label" }, "Replace session"),
                  h("span", { class: "rd-action-pending", hidden: "" }, "Replacing…"),
                ),
              ),
            ),
          ),
        ),
        // ── The device catalog: a persistent Add tray beside the canvas ──
        // SERVED — shell, scan line, all four tiers, every row — and hidden
        // until opened. Membership decoration (aria-pressed, the `.on`
        // marking, the verb word) is client state painted by syncDeviceRows.
        // A device row is one coupled product gesture: it adds/removes the
        // exact canvas board and its independent staged source. Geometry stays
        // browser-owned; routes and source authority stay daemon-owned.
        h(
          "aside",
          {
            class: "rd-devmodal",
            id: "rd-device-picker",
            hidden: "",
            "aria-labelledby": "rd-device-picker-title",
          },
          h(
            "div",
            { class: "rd-devmodal-panel", tabindex: "-1" },
            h(
              "div",
              { class: "rd-devmodal-head" },
              h(
                "div",
                { class: "rd-addpane-heading" },
                h("span", { class: "n-kick" }, "Add to canvas"),
                h("h2", { id: "rd-device-picker-title" }, "Devices"),
              ),
              h("span", { class: "rd-spring" }),
              h(
                "button",
                {
                  type: "button",
                  class: "rd-addpane-rescan",
                  "data-nx": "rd-rescan",
                  "aria-label": "Rescan connected devices",
                  title: "Read connected devices again",
                },
                "Rescan",
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "rd-addpane-done",
                  "data-nx": "rd-devs-close",
                  "aria-label": "Close the device picker",
                  title: "Close (Esc)",
                },
                "Done",
              ),
            ),
            h("p", { class: "n-devnote" }, () => rdDevScanLine()),
            h(
              "p",
              { class: "n-devnote rd-devmodal-purpose" },
              "Add places that physical device's own board on the canvas. Every added connected keyboard is an independent source and can map to any controller, including one already shared with another keyboard.",
            ),
            h(
              "section",
              {
                class: "rd-identify-card",
                "data-rd-identify": "",
                "aria-labelledby": "rd-identify-title",
              },
              h(
                "div",
                { class: "rd-identify-copy" },
                h("h3", { id: "rd-identify-title" }, "Not sure which keyboard is which?"),
                h(
                  "p",
                  null,
                  "Start listening, then press one key on the exact keyboard or encoder you want to identify. A successful answer adds that exact connection as an independent source; nothing is captured, saved, or started.",
                ),
              ),
              h(
                "form",
                {
                  method: "post",
                  action: "/redesign/device/identify",
                  "data-rd-form": "identify",
                },
                h("input", { type: "hidden", name: "attempt", value: "" }),
                h(
                  "button",
                  { type: "submit", class: "rd-panel-action rd-identify-start" },
                  "Identify exact device",
                ),
              ),
              h(
                "div",
                {
                  class: "rd-identify-status",
                  "data-rd-identify-status": "",
                  "data-state": "idle",
                  role: "status",
                  "aria-live": "polite",
                  tabindex: "-1",
                },
                h("span", { class: "rd-identify-pulse", "aria-hidden": "true" }),
                h(
                  "span",
                  { class: "rd-identify-answer" },
                  h("strong", { "data-rd-identify-label": "" }, "Ready to identify"),
                  h(
                    "span",
                    { "data-rd-identify-detail": "" },
                    "No device changes until you start listening.",
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "rd-panel-action rd-identify-cancel",
                    "data-rd-identify-cancel": "",
                    hidden: "",
                  },
                  "Cancel",
                ),
              ),
            ),
            h(
              "div",
              { class: () => rdDevKbFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevKbHead()),
              createList(
                () => rdDevKb(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current + "|" + (r.staged_revision ?? ""),
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h("span", { class: "rd-dev-connectedchip" }, "Connected"),
                      h("span", { class: "rd-dev-stagedchip" }, "Mapping controls ready"),
                      h(
                        "span",
                        {
                          class: r.capture_cls,
                          "data-state": r.capture_state,
                        },
                        r.capture_badge,
                      ),
                      h("span", { class: "n-dev-meta" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-identity" }, r.connection_label),
                      h(
                        "span",
                        { class: "n-dev-meta rd-dev-word" },
                        "Add keyboard board to canvas",
                      ),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            h(
              "div",
              { class: () => rdDevEncFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevEncHead()),
              createList(
                () => rdDevEnc(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current + "|" + (r.staged_revision ?? ""),
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h(
                        "span",
                        { class: "rd-dev-connectedchip" },
                        "Connected",
                      ),
                      h(
                        "span",
                        { class: "rd-dev-stagedchip" },
                        "Mapping source",
                      ),
                      h(
                        "span",
                        {
                          class: r.capture_cls,
                          "data-state": r.capture_state,
                        },
                        r.capture_badge,
                      ),
                      // An ENCODER's meta line follows the live session: the
                      // surface reads the chart over the wire at mount, and
                      // the roster's "chart not read yet" is stale the moment
                      // it starts — connection chatter, by the parity
                      // contract, so hydration may reword it.
                      h("span", { class: "n-dev-meta", "data-live-chatter": "" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-identity" }, r.connection_label),
                      h(
                        "span",
                        { class: "n-dev-meta rd-dev-word" },
                        "Show on canvas",
                      ),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            h(
              "div",
              { class: () => rdDevExpFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevExpHead()),
              createList(
                () => rdDevExp(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current + "|" + (r.staged_revision ?? ""),
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h(
                        "span",
                        { class: "rd-dev-connectedchip" },
                        "Device status",
                      ),
                      h(
                        "span",
                        { class: "rd-dev-stagedchip" },
                        "Mapping source",
                      ),
                      h(
                        "span",
                        {
                          class: r.capture_cls,
                          "data-state": r.capture_state,
                        },
                        r.capture_badge,
                      ),
                      h("span", { class: "n-dev-meta" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-identity" }, r.connection_label),
                      h(
                        "span",
                        { class: "n-dev-meta rd-dev-word" },
                        "Show on canvas",
                      ),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            // The unavailable tier: shown so nobody hunts for a board the
            // machine can see but ksx cannot offer — visibly inert, with the
            // reason in the meta. Not a control.
            h(
              "div",
              { class: () => rdDevOtherFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevOtherHead()),
              createList(
                () => rdDevOther(),
                (r) => r.name + "|" + r.meta,
                (r) =>
                  h(
                    "div",
                    { class: "n-dev off" },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      h("span", { class: "n-dev-meta" }, r.meta),
                    ),
                  ),
              ),
            ),
          ),
        ),
        // ── The controller catalog: stage virtual controllers ─────────────
        // SERVED — shell, lede, counts, every persona row — hidden until
        // opened. Rows the daemon cannot offer stay listed (`n-dev off`,
        // reason in the note): a menu that silently drops choices teaches a
        // user the product has fewer. The add form's preset and layout are
        // SERVED values (a future file name; the layout that makes a fresh
        // slot playable). The daemon enforces every ceiling — an add the
        // roster disallows is refused with a sentence, so the row's disabled
        // look is presentation, never the guard.
        h(
          "aside",
          {
            class: "rd-ctrlmodal",
            id: "rd-controller-picker",
            hidden: "",
            "aria-labelledby": "rd-controller-picker-title",
          },
          h(
            "div",
            { class: "rd-ctrlmodal-panel", tabindex: "-1" },
            h(
              "div",
              { class: "rd-ctrlmodal-head" },
              h(
                "div",
                { class: "rd-addpane-heading" },
                h("span", { class: "n-kick" }, "Add to canvas"),
                h("h2", { id: "rd-controller-picker-title" }, "Virtual controllers"),
              ),
              h("span", { class: "rd-spring" }),
              h(
                "button",
                {
                  type: "button",
                  class: "rd-addpane-done",
                  "data-nx": "rd-ctrls-close",
                  "aria-label": "Close the controller picker",
                  title: "Close (Esc)",
                },
                "Done",
              ),
            ),
            h("p", { class: "n-devnote" }, () => rdCtrlAddNote()),
            h("p", { class: "n-devnote rd-ctrl-counts" }, () => rdCtrlCountsLine()),
            h("h3", { class: "rd-devhead" }, "Pick what the next slot presents as"),
            createList(
              () => rdCtrlPersonas(),
              (r) =>
                r.name + "|" + r.label + "|" + r.api + "|" + r.note + "|" + r.cls +
                "|" + r.usable,
              (r) =>
                h(
                  "form",
                  {
                    class: "rd-ctrladd-form",
                    method: "post",
                    action: "/redesign/controller",
                    "data-rd-form": "controller-add",
                    "data-usable": r.usable,
                    "data-persona": r.name,
                    "data-preset": () => rdCtrlAddPreset(),
                    "data-layout": () => rdCtrlAddLayout(),
                    "data-source": () => rdCtrlAddSource(),
                    "data-expected-revision": () => rdDraftRevision(),
                    "data-expected-source-revision": () => rdCtrlAddSourceRevision(),
                  },
                  h("input", { type: "hidden", name: "persona", value: r.name }),
                  h("input", { type: "hidden", name: "preset", value: () => rdCtrlAddPreset() }),
                  h("input", { type: "hidden", name: "layout", value: () => rdCtrlAddLayout() }),
                  h("input", { type: "hidden", name: "source", value: () => rdCtrlAddSource() }),
                  h("input", {
                    type: "hidden",
                    name: "expected_revision",
                    value: () => rdDraftRevision(),
                  }),
                  h("input", {
                    type: "hidden",
                    name: "expected_source_revision",
                    value: () => rdCtrlAddSourceRevision(),
                  }),
                  h(
                    "button",
                    { type: "submit", class: r.cls, title: r.note },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.label),
                      h("span", { class: "n-dev-meta" }, r.api),
                      h("span", { class: "n-dev-meta rd-ctrl-note" }, r.note),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
                ),
            ),
          ),
        ),
        // The key-conflict consequence dialog — the learned key already
        // works somewhere else. "Use here too" is a deliberate fan-out that
        // takes nothing away; Cancel changes nothing. SSR'd hidden; the
        // mapper fills title/lines and toggles it (capture-time state).
        h(
          "div",
          { class: "rd-confdlg nd-back none", "data-nx": "rd-conf-cancel" },
          h(
            "div",
            {
              class: "nd",
              "data-nx": "dlg-noop",
              role: "dialog",
              "aria-modal": "true",
              tabindex: "-1",
              "aria-label": "Key conflict",
            },
            h("div", { class: "nd-kick" }, "Key conflict"),
            h("div", { class: "nd-title" }),
            h("div", { class: "nd-lede" }),
            h(
              "div",
              { class: "nd-actions" },
              h(
                "button",
                { class: "nd-btn", type: "button", "data-nx": "rd-conf-cancel" },
                "Cancel",
              ),
              h(
                "button",
                { class: "nd-btn primary", type: "button", "data-nx": "rd-conf-force" },
                "Use here too",
              ),
            ),
          ),
        ),
        // The macro STEP editor's holder. An open cold URL receives escaped
        // server markup so its first paint and hydrated representation agree;
        // redesign-macro-editor adopts that tree, then owns draft repaints.
        // `.none` (never hidden — `.nd-back`'s display:grid outranks it) is the
        // one off switch, and `back_cls` remains served.
        h(
          "div",
          { class: () => rdMacHolderCls(), "data-nx": "mac-close" },
          h("div", {
            id: "n-macro-dialog",
            class: "nd nd-mac",
            "data-nx": "dlg-noop",
            // Forma cannot emit dynamic innerHTML during SSR. The redesign
            // renderer fills this exact host from the same escaped payload
            // before the response leaves the server; the marker keeps that
            // narrowly-scoped post-render seam testable.
            "data-rd-mac-host": "",
            role: "dialog",
            "aria-modal": "true",
            tabindex: "-1",
            "aria-labelledby": "rd-mac-title",
            "aria-describedby": "rd-mac-description",
          }),
        ),
        h(
          "section",
          { class: "forma-canvas n-canvas", "data-forma-canvas": "", "data-client-canvas": "" },
          // The paint servers the silhouettes draw with — document-wide
          // defs, mounted OUTSIDE the hidden masters (the nocturne hoisting
          // rule: gradient url() into a display:none subtree is refused by
          // non-Chromium engines, and the visible clones resolve here).
          h(PadPaintServers, null),
          // The hidden pad masters the controller cards CLONE — the product's
          // five shared drawings (one component per
          // family; `.n-padmasters` is display:none, clone templates only).
          // Static classes on purpose: this page has no no-JS pad display,
          // so no visibility signals ride the wraps.
          h(
            "div",
            { class: "n-padmasters", "aria-hidden": "true" },
            h("div", { class: "n-padwrap", "data-pad-family": "xbox" }, h(X360PadArt, null)),
            h("div", { class: "n-padwrap", "data-pad-family": "ps" }, h(Ds4PremiumPadArt, null)),
            h(
              "div",
              { class: "n-padwrap", "data-pad-family": "ps5" },
              h(DualSensePremiumArt, null),
            ),
            h(
              "div",
              { class: "n-padwrap", "data-pad-family": "switchpro" },
              h(SwitchProPremiumArt, null),
            ),
            h(
              "div",
              { class: "n-padwrap", "data-pad-family": "xboxseries" },
              h(XboxSeriesPremiumArt, null),
            ),
          ),
          // ── The tool cluster (design handoff §7): select and hand ───────
          // Off-screen proximity chips: client-populated, camera-settle paced.
          h("div", { class: "rd-chips", "data-client-subtree": "" }),
          // The controller silhouettes' visible credit — the vendored art's
          // MIT terms travel with the art onto every page that draws it (the
          // /pads footer's exact line). A corner OVERLAY, deliberately not in
          // the topbar's flex flow: a nowrap span there overflows narrow
          // windows, and the page's horizontal scrollbar then steals viewport
          // height mid-resize — which the camera's centre-preserving math
          // reads as a phantom translation.
          h(
            "span",
            { class: "rd-artcredit" },
            "controller art: ",
            h(
              "a",
              { href: "https://github.com/AL2009man/Gamepad-Asset-Pack" },
              "Gamepad-Asset-Pack (MIT) by AL2009man",
            ),
          ),
          h(
            "div",
            { class: "rd-tools", role: "group", "aria-label": "Canvas tools" },
            h(
              "button",
              {
                type: "button",
                class: "rd-tool",
                "data-nx": "rd-tool-select",
                "aria-pressed": "true",
                "aria-label": "Select tool — left-drag marquee-selects",
                title: "Select tool (V)",
              },
              "➤",
            ),
            h(
              "button",
              {
                type: "button",
                class: "rd-tool",
                "data-nx": "rd-tool-hand",
                "aria-pressed": "false",
                "aria-label": "Hand tool — left-drag pans",
                title: "Hand tool (H)",
              },
              "✋",
            ),
          ),
          h("div", {
            class: "rd-global-source-controls-host",
            "data-rd-global-source-controls-host": "",
            "data-client-canvas": "",
          }),
          h(
            "div",
            {
              class: "forma-canvas-viewport",
              "data-forma-canvas-viewport": "",
              "data-client-canvas": "",
              tabindex: "0",
              "aria-label": "Redesign canvas",
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
              // ── Reactive keyboard blueprint ────────────────────────────
              // Physical-device membership is browser-owned. Each added
              // keyboard clones this hidden blueprint once, namespaces any
              // ids, and then reconciles served facts onto its own persistent
              // nodes. The blueprint never becomes a canvas surface.
              h(
                "div",
                {
                  class: "rd-keyboard-surface-template",
                  hidden: true,
                  inert: "",
                  "aria-hidden": "true",
                  "data-rd-keyboard-surface-template": "",
                },
                h(
                  "div",
                  {
                    class: "n-widget-body",
                    "data-rd-keyboard-surface-template-body": "",
                    "data-forma-runtime-host": "",
                    "aria-hidden": "false",
                  },
                  h(
                    "div",
                    { class: "n-kbhead" },
                    // The mapper's mirror cue: a control is waiting for a
                    // key. Client-toggled interaction state, like 4460's.
                    h(
                      "div",
                      { "aria-hidden": "true", class: "rd-keycue n-key-cue none" },
                      h("span", { class: "n-cue-dot" }),
                      h("span", { class: "rd-keycue-text" }),
                    ),
                    h("span", { class: "n-kick" }, () => rdKbTitle()),
                    // Which color speaks for which controller; each chip
                    // mutes that player's color on the keys.
                    h(
                      "div",
                      { class: "n-legend" },
                      createList(
                        () => rdKbLegend(),
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
                      h(
                        "span",
                        {
                          title:
                            "A key five or more controllers share shows how many, instead of their colors.",
                          class: () => rdKbMoreCls(),
                        },
                        h("span", { class: "n-lgdmore-sw" }),
                        h("span", { class: "n-lgdmore-lbl" }, "5+"),
                        h("span", { class: "n-lgdmore-name" }, "share a key"),
                      ),
                    ),
                    h("div", { class: "n-spring" }),
                    // NO board picker here, deliberately (Victor, 2026-08-29):
                    // a keyboard looks like a keyboard on this page. Choosing
                    // a different picture (a saved panel, a drawn board) is a
                    // 4460 affair until an "advanced" home earns its place.
                    // The one session-wide While-playing policy is mounted in
                    // global canvas chrome, never assigned to one source.
                    // Material belongs to the keyboard, never to a seat:
                    // six app-owned paints over one semantic geometry.
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
                        "aria-pressed": "true",
                      }),
                      h("button", {
                        type: "button",
                        class: "n-kbtheme",
                        "data-nx": "kb-theme",
                        "data-keyboard-theme": "lunar-shell",
                        title: "Lunar Shell",
                        "aria-label": "Lunar Shell keyboard finish",
                        "aria-pressed": "false",
                      }),
                      h("button", {
                        type: "button",
                        class: "n-kbtheme",
                        "data-nx": "kb-theme",
                        "data-keyboard-theme": "violet-circuit",
                        title: "Violet Circuit",
                        "aria-label": "Violet Circuit keyboard finish",
                        "aria-pressed": "false",
                      }),
                      h("button", {
                        type: "button",
                        class: "n-kbtheme",
                        "data-nx": "kb-theme",
                        "data-keyboard-theme": "glacier-current",
                        title: "Glacier Current",
                        "aria-label": "Glacier Current keyboard finish",
                        "aria-pressed": "false",
                      }),
                      h("button", {
                        type: "button",
                        class: "n-kbtheme",
                        "data-nx": "kb-theme",
                        "data-keyboard-theme": "ghost-mint",
                        title: "Ghost Mint",
                        "aria-label": "Ghost Mint keyboard finish",
                        "aria-pressed": "false",
                      }),
                      h("button", {
                        type: "button",
                        class: "n-kbtheme",
                        "data-nx": "kb-theme",
                        "data-keyboard-theme": "retro-terminal",
                        title: "Retro Terminal",
                        "aria-label": "Retro Terminal keyboard finish",
                        "aria-pressed": "false",
                      }),
                    ),
                    // Focus the board on the controller being edited:
                    // everyone else's color greys out — nothing is hidden.
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
                      () => rdSoloLbl(),
                    ),
                  ),
                  h(
                    "div",
                    { class: () => rdKbCls() },
                    h(
                      "div",
                      {
                        class: "n-kbcase",
                        style: () => rdBoardCaseStyle(),
                        "data-origin": () => rdBoardOrigin(),
                      },
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow1(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow2(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow3(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow4(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow5(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                      h(
                        "div",
                        { class: "n-kbrow" },
                        createList(
                          () => rdKbRow6(),
                          (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                          (r) =>
                            h(
                              "button",
                              {
                                type: "button",
                                disabled: r.disabled,
                                tabindex: r.tab,
                                "aria-hidden": r.aria_hidden,
                                "data-key": r.key,
                                title: r.title,
                                "aria-label": r.aria,
                                class: r.cls,
                                style: r.style,
                              },
                              h("span", { class: "n-key-cap" }, r.cap),
                              h("span", { class: "n-key-short" }, r.short),
                            ),
                        ),
                      ),
                    ),
                  ),
                  // Bound keys not on this board — honest, never dropped.
                  h(
                    "div",
                    { class: () => rdKbTrayCls() },
                    h("span", { class: "n-kbtray-head" }, () => rdKbTrayHead()),
                    h(
                      "div",
                      { class: "n-kbtray-row" },
                      createList(
                        () => rdKbTray(),
                        (r) => r.key + "|" + r.cap + "|" + r.cls + "|" + r.short + "|" + r.title + "|" + r.aria + "|" + r.tab + "|" + r.aria_hidden + "|" + r.style,
                        (r) =>
                          h(
                            "button",
                            {
                              type: "button",
                              disabled: r.disabled,
                              tabindex: r.tab,
                              "aria-hidden": r.aria_hidden,
                              "data-key": r.key,
                              title: r.title,
                              "aria-label": r.aria,
                              class: r.cls,
                              style: r.style,
                            },
                            h("span", { class: "n-key-cap" }, r.cap),
                            h("span", { class: "n-key-short" }, r.short),
                          ),
                      ),
                    ),
                  ),
                  h("p", { class: "n-devnote" }, () => rdKbNote()),
                ),
                // Source policy is session-wide. It begins beside the hidden
                // reactive blueprint for SSR parity, then moves once into the
                // global canvas-policy host; it never implies one exclusive
                // physical source.
                h(
                  "details",
                  {
                    class: "rd-boardpick rd-capture",
                    "data-rd-source-controls": "",
                  },
                  h(
                    "summary",
                    { class: "n-autobtn rd-boardpick-sum" },
                    "While playing",
                  ),
                  h(
                    "div",
                    { class: "rd-boardpick-pop" },
                    h("p", { class: "n-devnote" }, () => rdCaptureNote()),
                    createList(
                      () => rdCaptureRows(),
                      (r) =>
                        r.name + "|" + r.title + "|" + r.detail + "|" + r.cls + "|" + r.chosen,
                      (r) =>
                        h(
                          "form",
                          {
                            class: "n-modeform",
                            method: "post",
                            action: "/redesign/blocking",
                            "data-rd-form": "blocking",
                          },
                          h("input", { type: "hidden", name: "blocking", value: r.name }),
                          h(
                            "button",
                            { type: "submit", class: r.cls, "aria-current": r.chosen },
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
                  ),
                ),
              ),
            ),
            // ── THE MAPPING CORDS' LAYERS (nocturne's, attribute-for- ─────
            // attribute): world-coordinate siblings of the stage — edges are
            // canvas chrome, not list items. Lines and small ports sit above
            // the art so every path visibly leaves its real keycap/control;
            // the processor nodes are HTML so a macro chain has a real,
            // focusable card. All client-filled, all pointer-transparent
            // until filled.
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
              // The map panel's header (the design's framed-panel shape): a
              // quiet label and the collapse control, in the corner the map
              // lives in — nobody looks to a bar at the other end of the
              // page to put away the thing in this corner. The button keeps
              // the n-mapclose class: the engine treats any pointerdown in
              // the map as "navigate to here", and init's shield stops the
              // press from reaching it by that class.
              h(
                "div",
                { class: "rd-map-head" },
                h("span", { class: "rd-map-title" }, "Canvas"),
                h("span", { class: "rd-map-count", "data-live-chatter": "" }, "0 widgets"),
                h(
                  "button",
                  {
                    type: "button",
                    class: "n-mapclose",
                    "data-nx": "canvas-map",
                    "aria-label": "Hide the canvas map",
                    title: "Hide the canvas map",
                  },
                  "−",
                ),
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
            // ── The zoom cluster: [−][%⌃][+] | [Fit][▦]
            // The camera's verbs, scripting-only — wheel, Space-drag and the
            // arrow keys carry the same moves for anyone who would rather
            // not aim at a button. The percentage opens the camera menu; the
            // map icon is the collapsed minimap's stand-in, living in the
            // cluster the design says it belongs to.
            h(
              "div",
              { class: "rd-zoom", role: "group", "aria-label": "Canvas zoom" },
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
              // The engine writes the LIVE zoom into the SPAN, not the
              // button.
              // ⚠️The span on purpose: handed a BUTTON the engine also
              // rewrites its aria-label with the live number, and
              // `data-live-chatter` exempts an element's TEXT, never its
              // attributes — which the parity gate caught the moment this
              // was wired the obvious way.
              h(
                "button",
                {
                  type: "button",
                  id: "rd-zoom-menu-button",
                  "data-nx": "rd-zoom-menu",
                  title: "Zoom and camera commands",
                  class: "n-autobtn n-zoomread",
                  "aria-haspopup": "menu",
                  "aria-expanded": "false",
                  "aria-controls": "rd-zoom-menu-popup",
                },
                h("span", { class: "sr-head" }, "Canvas zoom "),
                h("span", { class: "n-zoomval", "data-live-chatter": "" }, "100%"),
                h("span", { class: "rd-caret", "aria-hidden": "true" }, "⌃"),
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
              h(
                "button",
                {
                  type: "button",
                  "data-nx": "canvas-fit",
                  title: "Fit every widget on screen (1)",
                  class: "n-autobtn",
                },
                "Fit",
              ),
              // The collapsed map's stand-in. Served hidden — the map
              // starts shown; setCanvasMap swaps the two. It must sit
              // DIRECTLY beside Fit (the corner's control stays in the
              // corner cluster) — the Paths control joins the pill AFTER it.
              h(
                "button",
                {
                  type: "button",
                  class: "n-autobtn n-zbtn rd-mapshow",
                  "data-nx": "canvas-map",
                  "aria-label": "Show the canvas map",
                  title: "Show the canvas map (M)",
                  hidden: "",
                },
                "▦",
              ),
              // The mapping cords' scope — Off / Selected / All (nocturne's
              // Paths control, living in the canvas cluster it acts on).
              h(
                "div",
                {
                  class: "n-pathctl rd-pathctl",
                  title:
                    "Show physical keys, processing steps, and the virtual controller controls they reach",
                },
                h("label", { class: "n-pathctl-label", for: "rd-mapping-path-scope" }, "Paths"),
                h(
                  "select",
                  {
                    id: "rd-mapping-path-scope",
                    class: "n-pathsel",
                    "data-nx": "rd-mapping-paths",
                    "aria-controls": "n-mapping-paths n-mapping-ports n-mapping-processors",
                  },
                  h("option", { value: "off" }, "Off"),
                  h("option", { value: "selected" }, "Selected player"),
                  h("option", { value: "all" }, "All players"),
                ),
                h("output", {
                  class: "n-pathcount rd-pathcount",
                  title: "Mapping paths are off",
                  "aria-hidden": "true",
                  "data-live-chatter": "",
                }),
                h("output", {
                  id: "rd-mapping-trace",
                  class: "n-mapping-trace",
                  title: "",
                  "data-live-chatter": "",
                  "data-client-canvas": "",
                  hidden: "",
                }),
              ),
              // ── The camera menu, opening upward ───────────────────────
              h(
                "div",
                {
                  id: "rd-zoom-menu-popup",
                  class: "rd-menu",
                  role: "menu",
                  "aria-labelledby": "rd-zoom-menu-button",
                  hidden: "",
                },
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-25" },
                  h("span", {}, "25%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-50" },
                  h("span", {}, "50%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-75" },
                  h("span", {}, "75%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-100" },
                  h("span", {}, "100%"),
                  h("kbd", { class: "rd-kbd" }, "0"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-150" },
                  h("span", {}, "150%"),
                ),
                h("div", { class: "rd-menu-sep", "aria-hidden": "true" }),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "canvas-fit" },
                  h("span", {}, "Fit workflow"),
                  h("kbd", { class: "rd-kbd" }, "1"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "canvas-tidy" },
                  h("span", {}, "Tidy workbench"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-fit-sel" },
                  h("span", {}, "Fit selection"),
                  h("kbd", { class: "rd-kbd" }, "2"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-center-sel" },
                  h("span", {}, "Center selection"),
                  h("kbd", { class: "rd-kbd" }, "C"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-focus-sel" },
                  h("span", {}, "Focus selected widget"),
                  h("kbd", { class: "rd-kbd" }, "F"),
                ),
              ),
            ),
            // ── The reading-tier line (design handoff §4) ─────────────────
            // Which semantic tier the camera is in. Client-written at zoom
            // speed, so its text is chatter; served at the 100% tier the
            // camera starts on.
            h(
              "span",
              { class: "rd-tier", "aria-hidden": "true", "data-live-chatter": "" },
              "Editing — full detail and controls",
            ),
          ),
        ),
      ),
    ),
    // ── The inspector (design handoff §7): 328px, right, OVERLAY ──────────
    // It overlays the canvas — it does not reflow it, which would move
    // widget positions. Served hidden; the body is client-populated.
    h(
      "aside",
      { class: "rd-inspector", "aria-label": "Inspector", hidden: "" },
      h(
        "div",
        { class: "rd-insp-head" },
        h("span", { class: "rd-map-title" }, "Inspector"),
        h(
          "button",
          {
            type: "button",
            class: "n-mapclose",
            "data-nx": "rd-insp-close",
            "aria-label": "Close the inspector",
            title: "Close",
          },
          "×",
        ),
      ),
      h("div", { class: "rd-insp-body", "data-client-subtree": "" }),
    ),
    // ── The command palette (⌘K / ⌘F) ─────────────────────────────────────
    // Served hidden; the result list is the one client-populated box.
    h(
      "div",
      { class: "rd-palette", hidden: "" },
      h("div", { class: "rd-scrim", "data-nx": "rd-palette-close" }),
      h(
        "div",
        {
          class: "rd-palette-card",
          role: "dialog",
          "aria-label": "Search",
          "aria-modal": "true",
        },
        h("input", {
          class: "rd-palette-input",
          type: "text",
          placeholder: "Find a widget — or run a command",
          "aria-label": "Find a widget or run a command",
        }),
        h("ol", { class: "rd-palette-list", "data-client-subtree": "" }),
      ),
    ),
    // ── The shortcut sheet (?) — Canvas control ───────────────────────────
    h(
      "div",
      { class: "rd-sheet", hidden: "" },
      h("div", { class: "rd-scrim", "data-nx": "rd-sheet-close" }),
      h(
        "div",
        {
          class: "rd-sheet-card",
          role: "dialog",
          "aria-label": "Canvas control",
          "aria-modal": "true",
        },
        h(
          "p",
          { class: "rd-sheet-lede", tabindex: "-1" },
          h("strong", {}, "Canvas control"),
          " Single-key shortcuts fire only when the canvas has focus — never while you are typing in a field.",
        ),
        h(
          "div",
          { class: "rd-sheet-cols" },
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Camera"),
            h("dt", {}, "+ / −"), h("dd", {}, "zoom in / out"),
            h("dt", {}, "0"), h("dd", {}, "100%, centre kept"),
            h("dt", {}, "1"), h("dd", {}, "fit workflow"),
            h("dt", {}, "2"), h("dd", {}, "fit selection"),
            h("dt", {}, "C"), h("dd", {}, "centre selection"),
            h("dt", {}, "Esc"), h("dd", {}, "back to previous view"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Pointer"),
            h("dt", {}, "two-finger drag"), h("dd", {}, "pan"),
            h("dt", {}, "pinch · Ctrl wheel"), h("dd", {}, "zoom at the pointer"),
            h("dt", {}, "wheel / ⇧ wheel"), h("dd", {}, "pan vertically / sideways"),
            h("dt", {}, "space · middle · right drag"), h("dd", {}, "pan"),
            h("dt", {}, "left drag on empty"), h("dd", {}, "marquee select"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Items"),
            h("dt", {}, "click / ⇧ click"), h("dd", {}, "select / add to selection"),
            h("dt", {}, "double-click"), h("dd", {}, "focus the widget"),
            h("dt", {}, "F"), h("dd", {}, "focus selected widget"),
            h("dt", {}, "arrows / ⇧ arrows"), h("dd", {}, "move by 12 / 1 px"),
            h("dt", {}, "drag the header"), h("dd", {}, "move the widget"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Chrome"),
            h("dt", {}, "Ctrl K / Ctrl F"), h("dd", {}, "search and fly to a widget"),
            h("dt", {}, "M"), h("dd", {}, "minimap"),
            h("dt", {}, "V / H"), h("dd", {}, "select / hand tool"),
            h("dt", {}, "?"), h("dd", {}, "this sheet"),
          ),
        ),
        h(
          "button",
          { type: "button", class: "n-autobtn rd-sheet-dismiss", "data-nx": "rd-sheet-close" },
          "Close",
        ),
      ),
    ),
  );
}
