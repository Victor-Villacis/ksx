/**
 * Frontend contracts for supervised panel-encoder programming.
 *
 * This module is deliberately pure. It neither touches localStorage nor sends
 * a request. Complete chart images and restorable backups stay backend-owned;
 * the browser receives display rows, hashes, and short-lived metadata.
 * A plan is never evidence that hardware changed, and a successful write is
 * never evidence that a physical control emitted the expected signal.
 */

export const PANEL_ASSIGNMENT_MODES = ["recommended", "custom", "keep-current"] as const;
export const PANEL_EDITOR_PHASES = ["closed", "assign", "review", "confirm"] as const;
export const PANEL_INSPECTION_PHASES = [
  "idle",
  "loading",
  "ready",
  "unavailable",
  "changed",
] as const;
export const PANEL_TRANSACTION_PHASES = [
  "idle",
  "writing",
  "verifying",
  "verified",
  "recovery-required",
] as const;

export type PanelAssignmentMode = (typeof PANEL_ASSIGNMENT_MODES)[number];
export type PanelEditorPhase = (typeof PANEL_EDITOR_PHASES)[number];
export type PanelInspectionPhase = (typeof PANEL_INSPECTION_PHASES)[number];
export type PanelTransactionPhase = (typeof PANEL_TRANSACTION_PHASES)[number];
export type PanelProgrammingCapability = "unsupported" | "read-only" | "programmable";
export type PanelProgrammingOperation = "program" | "restore";
export type PanelProgramLayout = "canonical-four-player" | "custom";
export type PanelTerminalShiftState = "disabled" | "enabled" | "opaque";
export type PanelProgrammingQualificationState =
  | "required"
  | "validation-written"
  | "validation-recovery"
  | "qualified";

/** Stable public identity plus the opaque fingerprint every plan is bound to. */
export interface PanelProgrammingBoardView {
  board_id: string;
  name: string;
  identity: string;
  vendor_id: number;
  product_id: number;
  bcd_device: number;
  serial: string | null;
  driver: string;
  fingerprint: string;
}

/** Backend-owned capability words copied from `PanelChartView`. */
export interface PanelProgrammingCapabilitiesView {
  state: string;
  detail: string;
}

/**
 * Short-lived authority for the exact chart read shown in the browser.
 * The hash identifies bytes held by the backend; it is not a chart image and
 * MUST NOT be put into localStorage, a URL, or a control-surface document.
 */
export interface PanelChartAuthority {
  target_selector: string;
  board_fingerprint: string;
  protocol_profile: string;
  base_sha256: string;
}

export interface PanelKeyValueView {
  code: number;
  key?: string | null;
  label: string;
  supported: boolean;
}

export interface PanelChartTerminalView {
  terminal_id: string;
  terminal_label: string;
  player: number;
  kind: string;
  normal: PanelKeyValueView;
  shifted: PanelKeyValueView;
  shift_state: PanelTerminalShiftState;
  /** Display convenience only; qualification must inspect `shift_state`. */
  is_shift: boolean;
}

export interface PanelKeyOptionView {
  key: string;
  label: string;
  code: number;
  /** Backend-owned first-write policy; absent/false remains fail-closed. */
  safe_for_qualification: boolean;
}

export interface PanelChartView {
  generated_at: string;
  summary: string;
  board_id: string;
  board_name: string;
  board_fingerprint: string;
  driver: string;
  protocol_profile: string;
  image_sha256: string;
  image_bytes: number;
  programming_state: string;
  programming_detail: string;
  /**
   * Hardware-writer qualification is backend-owned and bound to this exact
   * board/profile. Missing fields are treated as `required` by the UI so an
   * older response can never unlock a full-chart write.
   */
  qualification_state?: PanelProgrammingQualificationState;
  qualification_detail?: string;
  /** Exact backend-owned restore point required by either validation state. */
  qualification_restore_backup_id?: string | null;
  terminals: PanelChartTerminalView[];
  key_options: PanelKeyOptionView[];
  backup?: PanelBackupView | null;
  notes: string[];
}

export interface PanelChartPayload {
  target_selector: string | null;
  unavailable: string | null;
  view: PanelChartView | null;
}

/** One physical channel's proposed terminal/key association. */
export interface PanelTerminalDraftAssignment {
  physical_id: string;
  channel_id: string;
  component_label: string;
  player_slot: number | null;
  terminal_id: string;
  layer_id: string;
  requested_key: string;
  /** Deliberate fan-in. Coincidental duplicate keys remain a conflict. */
  allow_shared_key: boolean;
}

export interface PanelTerminalEdit {
  terminal_id: string;
  normal_key?: string | null;
  shifted_key?: string | null;
  is_shift?: boolean;
  allow_shared_key?: boolean;
}

export interface PanelProgramRequest {
  expected_selector: string;
  expected_base_sha256: string;
  layout: PanelProgramLayout;
  edits: PanelTerminalEdit[];
}

export interface PanelProgramApplyRequest {
  expected_selector: string;
  program: Omit<PanelProgramRequest, "expected_selector">;
  expected_board_fingerprint: string;
  expected_protocol_profile: string;
  expected_desired_sha256: string;
  confirm: boolean;
  supervised: boolean;
}

export interface PanelTerminalDiffView {
  terminal_id: string;
  terminal_label: string;
  layer: string;
  before: string;
  after: string;
}

export interface PanelByteDiffView {
  offset: number;
  before: number;
  after: number;
  meaning: string;
}

export interface PanelPlanView {
  summary: string;
  board_id: string;
  board_name: string;
  board_fingerprint: string;
  protocol_profile: string;
  base_sha256: string;
  desired_sha256: string;
  image_bytes: number;
  terminal_diff: PanelTerminalDiffView[];
  byte_diff: PanelByteDiffView[];
  preserved_byte_count: number;
  confirmation: string;
  blockers: string[];
}

export type PanelPlanRequest = PanelProgramRequest;

export interface PanelPlanPayload {
  target_selector: string | null;
  unavailable: string | null;
  plan: PanelPlanView | null;
}

export interface PanelBackupView {
  backup_id: string;
  label: string;
  created_at: string;
  board_fingerprint: string;
  image_sha256: string;
  image_bytes: number;
  reason: string;
}

export interface PanelProgramOutcomeView {
  state: "verified" | "recovery-required";
  summary: string;
  board_fingerprint: string;
  expected_sha256: string;
  observed_sha256?: string | null;
  backup: PanelBackupView;
  verified_at: string;
  next_step: string;
}

export type PanelMutationDisposition =
  | "not-started"
  | "verified"
  | "recovery-required"
  | "unknown";

export interface PanelProgramPayload {
  target_selector: string | null;
  unavailable: string | null;
  refusal_code: string | null;
  remedy: string | null;
  mutation_disposition: PanelMutationDisposition;
  outcome: PanelProgramOutcomeView | null;
}

export interface PanelBackupsView {
  summary: string;
  board_fingerprint: string;
  backups: PanelBackupView[];
}

export interface PanelBackupsPayload {
  target_selector: string | null;
  unavailable: string | null;
  view: PanelBackupsView | null;
}

export interface PanelRestorePlanRequest {
  expected_selector: string;
  backup_id: string;
  expected_current_sha256: string;
}

export type PanelRestorePlanPayload = PanelPlanPayload;

export interface PanelRestoreRequest {
  expected_selector: string;
  backup_id: string;
  expected_current_sha256: string;
}

export interface PanelRestoreApplyRequest {
  expected_selector: string;
  restore: Omit<PanelRestoreRequest, "expected_selector">;
  expected_board_fingerprint: string;
  expected_protocol_profile: string;
  expected_desired_sha256: string;
  confirm: boolean;
  supervised: boolean;
}

export interface PanelRestorePayload {
  target_selector: string | null;
  unavailable: string | null;
  refusal_code: string | null;
  remedy: string | null;
  mutation_disposition: PanelMutationDisposition;
  outcome: PanelProgramOutcomeView | null;
}

export interface PanelInspectionState {
  phase: PanelInspectionPhase;
  target_selector: string;
  board: PanelProgrammingBoardView | null;
  chart: PanelChartView | null;
  error: string;
}

export interface PanelCapabilityState {
  kind: PanelProgrammingCapability;
  view: PanelProgrammingCapabilitiesView | null;
  reason: string;
}

export interface PanelEditorState {
  phase: PanelEditorPhase;
  assignment_mode: PanelAssignmentMode;
  assignments: PanelTerminalDraftAssignment[];
  plan_expected_selector: string;
  plan: PanelPlanView | null;
  show_unchanged: boolean;
}

export interface PanelTransactionState {
  phase: PanelTransactionPhase;
  operation: PanelProgrammingOperation | null;
  /** Exact staged selector that owned this transaction. Kept at runtime so a
   * completed result cannot be offered as an action for a newly selected
   * encoder. */
  target_selector: string;
  outcome: PanelProgramOutcomeView | null;
}

/**
 * Runtime-only UI state. It contains short-lived server authority and MUST NOT
 * be persisted wholesale. Use `panelProgrammingPreferencesForStorage` for the
 * only browser-safe subset.
 */
export interface PanelProgrammingState {
  inspection: PanelInspectionState;
  capability: PanelCapabilityState;
  editor: PanelEditorState;
  transaction: PanelTransactionState;
}

export function createPanelProgrammingState(): PanelProgrammingState {
  return {
    inspection: {
      phase: "idle",
      target_selector: "",
      board: null,
      chart: null,
      error: "",
    },
    capability: {
      kind: "unsupported",
      view: null,
      reason: "A complete panel chart has not been read.",
    },
    editor: {
      phase: "closed",
      assignment_mode: "custom",
      assignments: [],
      plan_expected_selector: "",
      plan: null,
      show_unchanged: false,
    },
    transaction: {
      phase: "idle",
      operation: null,
      target_selector: "",
      outcome: null,
    },
  };
}

export function panelProgrammingCapability(
  capabilities: PanelProgrammingCapabilitiesView | null | undefined,
): PanelCapabilityState {
  if (!capabilities) {
    return {
      kind: "unsupported",
      view: null,
      reason: "A complete panel chart has not been read.",
    };
  }
  if (capabilities.state === "supervised") {
    return {
      kind: "programmable",
      view: capabilities,
      reason: capabilities.detail ||
        "A pinned protocol profile is available for an explicitly supervised backup, write, verification, and restore.",
    };
  }
  if (capabilities.state === "read-only" || capabilities.state === "write-locked" ||
      capabilities.state === "recovery-required") {
    return {
      kind: "read-only",
      view: capabilities,
      reason: capabilities.detail || "The complete chart can be viewed but cannot be safely changed.",
    };
  }
  return {
    kind: "unsupported",
    view: capabilities,
    reason: capabilities.detail || "The complete panel chart cannot be read losslessly.",
  };
}

export function panelProgrammingCapabilitiesFromChart(
  chart: PanelChartView | null | undefined,
): PanelProgrammingCapabilitiesView | null {
  return chart
    ? { state: chart.programming_state, detail: chart.programming_detail }
    : null;
}

/** Extracts the three values that bind a plan to one exact hardware read. */
export function panelChartAuthority(payload: PanelChartPayload): PanelChartAuthority | null {
  const target = payload.target_selector?.trim() ?? "";
  const view = payload.view;
  if (!target || !view?.board_fingerprint.trim() || !view.protocol_profile.trim() ||
      !view.image_sha256.trim()) return null;
  return {
    target_selector: target,
    board_fingerprint: view.board_fingerprint,
    protocol_profile: view.protocol_profile,
    base_sha256: view.image_sha256,
  };
}

export type PanelPlanInvalidationReason =
  | "no-current-chart"
  | "target-changed"
  | "board-changed"
  | "profile-changed"
  | "chart-changed";

function sameIdentity(left: string, right: string): boolean {
  return left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
}

/** Returns why a plan is stale, or null while it still describes this chart. */
export function panelPlanInvalidation(
  plan: PanelPlanView,
  current: PanelChartAuthority | null | undefined,
  expectedTargetSelector: string,
): PanelPlanInvalidationReason | null {
  if (!current) return "no-current-chart";
  if (!clean(expectedTargetSelector) ||
      !sameIdentity(expectedTargetSelector, current.target_selector)) {
    return "target-changed";
  }
  if (!clean(plan.board_fingerprint) || !clean(current.board_fingerprint) ||
      !sameIdentity(plan.board_fingerprint, current.board_fingerprint)) {
    return "board-changed";
  }
  if (!clean(plan.protocol_profile) || !clean(current.protocol_profile) ||
      !sameIdentity(plan.protocol_profile, current.protocol_profile)) {
    return "profile-changed";
  }
  if (!clean(plan.base_sha256) || !clean(current.base_sha256) ||
      !sameIdentity(plan.base_sha256, current.base_sha256)) {
    return "chart-changed";
  }
  return null;
}

/**
 * Drops a stale proposal while preserving the person's draft assignments.
 * The backend remains the only authority capable of issuing a replacement.
 */
export function invalidatePanelProgrammingPlan(
  state: PanelProgrammingState,
  current: PanelChartAuthority | null | undefined,
): PanelProgrammingState {
  const plan = state.editor.plan;
  if (!plan ||
      panelPlanInvalidation(plan, current, state.editor.plan_expected_selector) === null) {
    return state;
  }
  return {
    ...state,
    editor: {
      ...state.editor,
      phase: "assign",
      plan_expected_selector: "",
      plan: null,
    },
  };
}

export type PanelAssignmentConflictKind =
  | "incomplete-assignment"
  | "inconsistent-mirror"
  | "terminal-reused"
  | "key-reused"
  | "unsupported-key";

export interface PanelAssignmentConflict {
  kind: PanelAssignmentConflictKind;
  assignment_ids: string[];
  message: string;
}

export interface PanelAssignmentConflictOptions {
  /** Empty or omitted means the backend has not supplied a constrained vocabulary. */
  supported_keys?: readonly string[];
}

function clean(value: string): string {
  return value.normalize("NFKC").trim();
}

function folded(value: string): string {
  return clean(value).toLocaleUpperCase();
}

function assignmentId(assignment: PanelTerminalDraftAssignment): string {
  return `${clean(assignment.physical_id)}:${clean(assignment.channel_id)}`;
}

function pushGroup(
  groups: Map<string, PanelTerminalDraftAssignment[]>,
  key: string,
  assignment: PanelTerminalDraftAssignment,
): void {
  const group = groups.get(key) ?? [];
  group.push(assignment);
  groups.set(key, group);
}

function uniqueAssignmentIds(assignments: readonly PanelTerminalDraftAssignment[]): string[] {
  return [...new Set(assignments.map(assignmentId))];
}

/**
 * Local, conservative validation for the assignment editor. The backend must
 * repeat every check while planning; passing this helper grants no authority.
 * Exact repeated rows from visual mirrors are accepted. Separate physical
 * controls may share a key only when every row opts into deliberate fan-in.
 */
export function panelAssignmentConflicts(
  assignments: readonly PanelTerminalDraftAssignment[],
  options: PanelAssignmentConflictOptions = {},
): PanelAssignmentConflict[] {
  const conflicts: PanelAssignmentConflict[] = [];
  const componentGroups = new Map<string, PanelTerminalDraftAssignment[]>();
  const terminalGroups = new Map<string, PanelTerminalDraftAssignment[]>();
  const keyGroups = new Map<string, PanelTerminalDraftAssignment[]>();
  const supported = new Set((options.supported_keys ?? []).map(folded).filter(Boolean));

  for (const assignment of assignments) {
    const id = assignmentId(assignment);
    const layer = folded(assignment.layer_id);
    const terminal = folded(assignment.terminal_id);
    const key = folded(assignment.requested_key);
    if (!clean(assignment.physical_id) || !clean(assignment.channel_id) || !layer ||
        !terminal || !key) {
      conflicts.push({
        kind: "incomplete-assignment",
        assignment_ids: [id],
        message: `${assignment.component_label || "A physical control"} needs a terminal and key assignment.`,
      });
      continue;
    }
    pushGroup(componentGroups, `${folded(assignment.physical_id)}\u0000${folded(assignment.channel_id)}\u0000${layer}`, assignment);
    pushGroup(terminalGroups, `${terminal}\u0000${layer}`, assignment);
    pushGroup(keyGroups, `${key}\u0000${layer}`, assignment);
    if (supported.size > 0 && !supported.has(key)) {
      conflicts.push({
        kind: "unsupported-key",
        assignment_ids: [id],
        message: `${assignment.requested_key} cannot be observed by the selected capture backend.`,
      });
    }
  }

  for (const group of componentGroups.values()) {
    const values = new Set(group.map((assignment) =>
      `${folded(assignment.terminal_id)}\u0000${folded(assignment.requested_key)}`
    ));
    if (values.size > 1) {
      conflicts.push({
        kind: "inconsistent-mirror",
        assignment_ids: uniqueAssignmentIds(group),
        message: "Linked views of one physical control must use the same terminal and key.",
      });
    }
  }

  for (const group of terminalGroups.values()) {
    const physicalChannels = new Set(group.map(assignmentId));
    if (physicalChannels.size > 1) {
      conflicts.push({
        kind: "terminal-reused",
        assignment_ids: [...physicalChannels],
        message: `${group[0].terminal_id} is assigned to more than one physical channel.`,
      });
    }
  }

  for (const group of keyGroups.values()) {
    const physicalChannels = new Set(group.map(assignmentId));
    if (physicalChannels.size > 1 && !group.every((assignment) => assignment.allow_shared_key)) {
      conflicts.push({
        kind: "key-reused",
        assignment_ids: [...physicalChannels],
        message: `${group[0].requested_key} is shared without deliberate fan-in confirmation.`,
      });
    }
  }

  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const fingerprint = `${conflict.kind}\u0000${[...conflict.assignment_ids].sort().join("\u0000")}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

export const PANEL_PROGRAMMING_PREFERENCES_VERSION = 1 as const;

/** The complete and only panel-programming value approved for localStorage. */
export interface PanelProgrammingStoredPreferences {
  version: typeof PANEL_PROGRAMMING_PREFERENCES_VERSION;
  assignment_mode: PanelAssignmentMode;
  show_unchanged: boolean;
}

/**
 * Produces UI preferences only. No selector, chart hash, plan result, backup
 * id, transaction state, or hardware result crosses this storage boundary.
 */
export function panelProgrammingPreferencesForStorage(
  state: PanelProgrammingState,
): PanelProgrammingStoredPreferences {
  return {
    version: PANEL_PROGRAMMING_PREFERENCES_VERSION,
    assignment_mode: state.editor.assignment_mode,
    show_unchanged: state.editor.show_unchanged,
  };
}

export function panelProgramLayoutForMode(mode: PanelAssignmentMode): PanelProgramLayout | null {
  if (mode === "recommended") return "canonical-four-player";
  if (mode === "keep-current") return null;
  return "custom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizePanelProgrammingPreferences(
  value: unknown,
): PanelProgrammingStoredPreferences {
  if (!isRecord(value) || value.version !== PANEL_PROGRAMMING_PREFERENCES_VERSION) {
    return {
      version: PANEL_PROGRAMMING_PREFERENCES_VERSION,
      assignment_mode: "custom",
      show_unchanged: false,
    };
  }
  const assignmentMode =
      typeof value.assignment_mode === "string" &&
      PANEL_ASSIGNMENT_MODES.includes(value.assignment_mode as PanelAssignmentMode)
    ? value.assignment_mode as PanelAssignmentMode
    : "custom";
  return {
    version: PANEL_PROGRAMMING_PREFERENCES_VERSION,
    assignment_mode: assignmentMode,
    show_unchanged: value.show_unchanged === true,
  };
}
