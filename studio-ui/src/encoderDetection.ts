/**
 * Strict visual-profile selection from backend-owned identity facts.
 *
 * There are intentionally no VID/PID, product-name, interface, or HID-usage
 * fields here. The browser consumes the backend's family/profile verdict and
 * displays it. A manual choice may select a drawing, but never upgrades chart
 * read/write support.
 */

import {
  ENCODER_VISUAL_PROFILES,
  EncoderVisualProfile,
  EncoderVisualProfileId,
  getEncoderVisualProfile,
  isEncoderVisualProfileId,
} from "./encoderVisualRegistry";

export interface BackendEncoderCapabilities {
  canIdentify?: boolean;
  canReportMode?: boolean;
  canReadChart?: boolean;
  canWriteChart?: boolean;
  writeIsPersistent?: boolean;
}

export interface BackendEncoderFacts {
  /** Backend-authored role; never derived from a browser-visible product name. */
  role?: "panel-encoder" | "keyboard" | "other" | string | null;
  /** Stable backend catalog id, for example `ultimarc-ipac4`. */
  familyId?: string | null;
  familyLabel?: string | null;
  /** Optional future backend-owned exact visual id. */
  visualProfileId?: string | null;
  /** Exact measured protocol profile, when the backend serves it. */
  protocolProfileId?: string | null;
  profileState?: "profiled" | "unprofiled-release" | "unrecognised" | string | null;
  profileTerminalCount?: number | null;
  capabilities?: BackendEncoderCapabilities | null;
}

export interface EncoderDetectionRequest {
  backend?: BackendEncoderFacts | null;
  /** Explicit user choice. It changes the drawing only, never capabilities. */
  manualProfileId?: EncoderVisualProfileId | null;
}

export interface EncoderProtocolVerdict {
  source: "backend" | "not-reported";
  integrity: "consistent" | "conflicting" | "not-reported";
  profileId?: string;
  identify: "supported" | "unsupported" | "not-reported";
  modeRead: "supported" | "unsupported" | "not-reported";
  chartRead: "supported" | "unsupported" | "not-reported";
  chartWrite: "supported" | "unsupported" | "not-reported";
  persistentWrite: "supported" | "unsupported" | "not-reported";
}

export type EncoderResolution =
  | "backend-exact"
  | "backend-family"
  | "manual"
  | "ambiguous-family"
  | "known-family"
  | "identity-conflict"
  | "unrecognised";

export interface EncoderDetectionResult {
  profile: EncoderVisualProfile;
  resolution: EncoderResolution;
  identity: {
    source: "backend-profile" | "backend-family" | "manual" | "none";
    familyId?: string;
    familyLabel?: string;
    topologyMatchesReportedCount: boolean | "not-comparable";
  };
  protocol: EncoderProtocolVerdict;
  candidates: readonly EncoderVisualProfileId[];
  warnings: readonly string[];
}

interface UniqueFamilyRule {
  kind: "unique";
  profileId: EncoderVisualProfileId;
}

interface AmbiguousFamilyRule {
  kind: "ambiguous";
  profileIds: readonly EncoderVisualProfileId[];
}

type FamilyRule = UniqueFamilyRule | AmbiguousFamilyRule;

const FAMILY_RULES: ReadonlyMap<string, FamilyRule> = new Map<string, FamilyRule>([
  ["ultimarc-ipac4", { kind: "unique", profileId: "ultimarc-ipac4" }],
  ["ultimarc-ipac2", { kind: "unique", profileId: "ultimarc-ipac2" }],
  ["ultimarc-ipac-ultimate-io", { kind: "unique", profileId: "ultimarc-ultimate-io" }],
  ["ultimarc-minipac", {
    kind: "ambiguous",
    profileIds: ["ultimarc-minipac-32", "ultimarc-minipac-four"],
  }],
  // The J-PAC visual is deliberately family-safe: its 27-control core and
  // four variant-only extensions preserve the standard/J-PAC-C distinction.
  ["ultimarc-jpac", { kind: "unique", profileId: "ultimarc-jpac" }],
]);

function capabilityVerdict(value: boolean | undefined): "supported" | "unsupported" | "not-reported" {
  return value === true ? "supported" : value === false ? "unsupported" : "not-reported";
}

/** Protocol support is copied only from backend capabilities. Registry data,
 * a manual model selection, and a matching terminal count are never inputs. */
export function protocolVerdictFromBackend(
  backend?: BackendEncoderFacts | null,
): EncoderProtocolVerdict {
  const capabilities = backend?.capabilities;
  if (!capabilities) {
    return {
      source: "not-reported",
      integrity: "not-reported",
      ...(backend?.protocolProfileId ? { profileId: backend.protocolProfileId } : {}),
      identify: "not-reported",
      modeRead: "not-reported",
      chartRead: "not-reported",
      chartWrite: "not-reported",
      persistentWrite: "not-reported",
    };
  }
  const integrity = capabilities.canWriteChart === true && capabilities.canReadChart !== true
    || capabilities.writeIsPersistent === true && capabilities.canWriteChart !== true
    ? "conflicting"
    : "consistent";
  return {
    source: "backend",
    integrity,
    ...(backend?.protocolProfileId ? { profileId: backend.protocolProfileId } : {}),
    identify: capabilityVerdict(capabilities.canIdentify),
    modeRead: capabilityVerdict(capabilities.canReportMode),
    chartRead: capabilityVerdict(capabilities.canReadChart),
    chartWrite: capabilityVerdict(capabilities.canWriteChart),
    persistentWrite: capabilityVerdict(capabilities.writeIsPersistent),
  };
}

function protocolIntegrityWarnings(backend?: BackendEncoderFacts | null): string[] {
  const capabilities = backend?.capabilities;
  if (!capabilities) return [];
  const warnings: string[] = [];
  if (capabilities.canWriteChart === true && capabilities.canReadChart !== true) {
    warnings.push("Backend capabilities claim chart writes without the read support required for safe verification.");
  }
  if (capabilities.writeIsPersistent === true && capabilities.canWriteChart !== true) {
    warnings.push("Backend capabilities claim persistent writes without reporting chart write support.");
  }
  return warnings;
}

function topologyCountMatches(
  profile: EncoderVisualProfile,
  reportedCount: number | null | undefined,
): boolean | "not-comparable" {
  if (!Number.isInteger(reportedCount) || (reportedCount as number) < 0) return "not-comparable";
  const capacity = profile.topology.capacity;
  switch (capacity.kind) {
    case "exact":
      return reportedCount === capacity.inputCount;
    case "discrete":
      return capacity.inputCounts.includes(reportedCount as number);
    case "range":
      return reportedCount! >= capacity.minimumInputCount && reportedCount! <= capacity.maximumInputCount;
    case "logical":
    case "unknown":
      return "not-comparable";
  }
}

function result(
  profileId: EncoderVisualProfileId,
  resolution: EncoderResolution,
  backend: BackendEncoderFacts | null | undefined,
  identitySource: EncoderDetectionResult["identity"]["source"],
  candidates: readonly EncoderVisualProfileId[],
  warnings: readonly string[],
): EncoderDetectionResult {
  const profile = getEncoderVisualProfile(profileId);
  return {
    profile,
    resolution,
    identity: {
      source: identitySource,
      ...(backend?.familyId ? { familyId: backend.familyId } : {}),
      ...(backend?.familyLabel ? { familyLabel: backend.familyLabel } : {}),
      topologyMatchesReportedCount: topologyCountMatches(profile, backend?.profileTerminalCount),
    },
    protocol: protocolVerdictFromBackend(backend),
    candidates,
    warnings: [...warnings, ...protocolIntegrityWarnings(backend)],
  };
}

function unknown(
  resolution: EncoderResolution,
  backend: BackendEncoderFacts | null | undefined,
  candidates: readonly EncoderVisualProfileId[],
  warnings: readonly string[],
): EncoderDetectionResult {
  return result("unknown-hid", resolution, backend, backend?.familyId ? "backend-family" : "none", candidates, warnings);
}

/**
 * Select the safest available drawing.
 *
 * Resolution order is backend exact profile, backend family, then a manual
 * choice. A manual choice can disambiguate a family but cannot contradict an
 * unambiguous backend family. Unknown/new backend ids fail closed.
 */
export function detectEncoderVisualProfile(request: EncoderDetectionRequest): EncoderDetectionResult {
  const backend = request.backend;
  const exact = backend?.visualProfileId?.trim();
  const familyId = backend?.familyId?.trim();

  const contradictoryRole = Boolean(
    (exact || familyId) && backend?.role && backend.role !== "panel-encoder",
  );
  const contradictoryState = Boolean(
    familyId && backend?.profileState === "unrecognised" ||
    exact && backend?.profileState === "unrecognised" ||
    backend?.protocolProfileId && backend?.profileState && backend.profileState !== "profiled" ||
    backend?.capabilities?.canReadChart === true && backend?.profileState &&
      backend.profileState !== "profiled",
  );
  if (contradictoryRole || contradictoryState) {
    return unknown("identity-conflict", backend, [], [
      "Backend encoder identity facts contradict its role or recognition state; no board drawing was selected.",
    ]);
  }

  if (exact) {
    if (!isEncoderVisualProfileId(exact) || exact === "unknown-hid") {
      return unknown("identity-conflict", backend, [], [
        `Backend visual profile '${exact}' is not registered; showing an unknown device instead.`,
      ]);
    }
    const profile = getEncoderVisualProfile(exact);
    if (familyId && !profile.backendFamilyIds.includes(familyId)) {
      return unknown("identity-conflict", backend, [exact], [
        `Backend visual profile '${exact}' conflicts with backend family '${familyId}'.`,
      ]);
    }
    const countMatch = topologyCountMatches(profile, backend?.profileTerminalCount);
    if (countMatch === false) {
      return unknown("identity-conflict", backend, [exact], [
        `Backend profile '${exact}' conflicts with its reported terminal count; no exact board drawing was selected.`,
      ]);
    }
    return result(exact, "backend-exact", backend, "backend-profile", [exact], []);
  }

  const familyRule = familyId ? FAMILY_RULES.get(familyId) : undefined;
  if (familyId && !familyRule) {
    if (request.manualProfileId) {
      return unknown("identity-conflict", backend, [], [
        `Manual profile '${request.manualProfileId}' cannot override known backend family '${familyId}'.`,
      ]);
    }
    return unknown("known-family", backend, [], [
      `KSX recognizes backend family '${familyId}', but no verified visual topology is registered yet.`,
    ]);
  }

  if (familyRule?.kind === "unique") {
    if (request.manualProfileId && request.manualProfileId !== familyRule.profileId) {
      return unknown("identity-conflict", backend, [familyRule.profileId], [
        `Manual profile '${request.manualProfileId}' conflicts with backend family '${familyId}'.`,
      ]);
    }
    const profile = getEncoderVisualProfile(familyRule.profileId);
    if (topologyCountMatches(profile, backend?.profileTerminalCount) === false) {
      return unknown("identity-conflict", backend, [familyRule.profileId], [
        `Backend family '${familyId}' conflicts with the reported terminal count.`,
      ]);
    }
    return result(familyRule.profileId, "backend-family", backend, "backend-family", [familyRule.profileId], []);
  }

  if (familyRule?.kind === "ambiguous") {
    if (request.manualProfileId && !familyRule.profileIds.includes(request.manualProfileId)) {
      return unknown("identity-conflict", backend, familyRule.profileIds, [
        `Manual profile '${request.manualProfileId}' does not belong to backend family '${familyId}'.`,
      ]);
    }
    const candidates = familyRule.profileIds.filter((profileId) =>
      topologyCountMatches(getEncoderVisualProfile(profileId), backend?.profileTerminalCount) !== false
    );
    if (candidates.length === 0) {
      return unknown("identity-conflict", backend, familyRule.profileIds, [
        `Backend family '${familyId}' conflicts with the reported terminal count.`,
      ]);
    }
    if (request.manualProfileId && candidates.includes(request.manualProfileId)) {
      const selected = getEncoderVisualProfile(request.manualProfileId);
      return result(request.manualProfileId, "manual", backend, "manual", familyRule.profileIds, [
        "The backend recognizes the family but not this variant; the model drawing is user-selected.",
      ]);
    }
    if (request.manualProfileId) {
      return unknown("identity-conflict", backend, familyRule.profileIds, [
        `Manual profile '${request.manualProfileId}' conflicts with the backend-reported terminal count.`,
      ]);
    }
    if (candidates.length === 1) {
      return result(candidates[0], "backend-family", backend, "backend-family", candidates, [
        "The backend-reported terminal count narrows this family to one registered visual topology.",
      ]);
    }
    return unknown("ambiguous-family", backend, candidates, [
      "The backend recognizes this encoder family but cannot safely distinguish its terminal-count variants.",
    ]);
  }

  if (request.manualProfileId && request.manualProfileId !== "unknown-hid") {
    return result(request.manualProfileId, "manual", backend, "manual", [request.manualProfileId], [
      "This is a user-selected reference drawing; KSX has not verified the connected hardware model.",
    ]);
  }

  return unknown("unrecognised", backend, [], [
    backend?.role === "panel-encoder"
      ? "The backend classified this as an encoder but supplied no registered family/profile fact."
      : "No exact backend encoder identity is available.",
  ]);
}

export interface EncoderDetectionRuleValidation {
  valid: boolean;
  errors: readonly string[];
}

/** Pure source-level check for stale mappings and accidental auto-selection of
 * a profile whose own metadata says variant confirmation is required. */
export function validateEncoderDetectionRules(): EncoderDetectionRuleValidation {
  const errors: string[] = [];
  const registryIds = new Set(ENCODER_VISUAL_PROFILES.map((profile) => profile.id));
  for (const [familyId, rule] of FAMILY_RULES) {
    const ids = rule.kind === "unique" ? [rule.profileId] : rule.profileIds;
    for (const id of ids) {
      if (!registryIds.has(id)) errors.push(`${familyId}: missing profile ${id}`);
      const profile = getEncoderVisualProfile(id);
      if (!profile.backendFamilyIds.includes(familyId)) errors.push(`${familyId}: profile ${id} does not accept this backend family`);
      if (rule.kind === "unique" && profile.manualSelection === "required-for-variant") {
        errors.push(`${familyId}: variant-only profile ${id} cannot be auto-selected`);
      }
    }
    if (rule.kind === "ambiguous" && new Set(rule.profileIds).size < 2) {
      errors.push(`${familyId}: ambiguous rule needs at least two distinct candidates`);
    }
  }
  for (const profile of ENCODER_VISUAL_PROFILES) {
    for (const familyId of profile.backendFamilyIds) {
      const rule = FAMILY_RULES.get(familyId);
      const ids = rule?.kind === "unique" ? [rule.profileId] : rule?.profileIds ?? [];
      if (!ids.includes(profile.id)) errors.push(`${profile.id}: backend family ${familyId} has no reciprocal rule`);
    }
  }
  return { valid: errors.length === 0, errors };
}

const RULE_VALIDATION = validateEncoderDetectionRules();
if (!RULE_VALIDATION.valid) {
  throw new Error(`Invalid encoder detection rules:\n${RULE_VALIDATION.errors.join("\n")}`);
}
