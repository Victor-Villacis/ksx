/**
 * Data-only encoder drawings for Studio.
 *
 * This module describes what may be drawn. It deliberately contains no USB
 * recognition and no chart read/write flags. Hardware identity and protocol
 * capability are backend facts; `encoderDetection.ts` joins those facts to a
 * visual without allowing a published terminal count to authorize a report.
 */

export const ENCODER_VISUAL_PROFILE_IDS = [
  "ultimarc-ipac4",
  "ultimarc-ipac2",
  "ultimarc-ultimate-io",
  "ultimarc-minipac-32",
  "ultimarc-minipac-four",
  "ultimarc-jpac",
  "brook-ufb-fusion",
  "gp2040-ce-reference",
  "unknown-hid",
] as const;

export type EncoderVisualProfileId = (typeof ENCODER_VISUAL_PROFILE_IDS)[number];

export type EncoderTopologyConfidence =
  | "measured"
  | "manufacturer-published"
  | "official-project-reference"
  | "logical-only"
  | "unknown";

export type EncoderVisualKind =
  | "terminal-board"
  | "harness-board"
  | "jamma-board"
  | "fight-board"
  | "firmware-reference"
  | "generic-hid";

export type EncoderTerminalKind =
  | "direction"
  | "action"
  | "start"
  | "coin"
  | "auxiliary"
  | "service"
  | "test"
  | "tilt";

export interface EncoderVisualTerminal {
  /** Stable join key. I-PAC 4 ids intentionally match PanelTerminalTruth. */
  id: string;
  label: string;
  groupId: string;
  kind: EncoderTerminalKind;
  player?: number;
  /** Physical means a published/measured contact; logical never claims a pin. */
  identityScope: "physical-terminal" | "logical-control";
  connection: "screw" | "harness" | "jamma-edge" | "logical";
  /** Variant-only contacts are visible but never counted as universally present. */
  presence: "always" | "variant-only";
  capabilities: readonly ("switch" | "optical-axis" | "gamepad-action")[];
  sourceRefs: readonly string[];
}

export type EncoderInputCapacity =
  | { kind: "exact"; inputCount: number }
  | { kind: "discrete"; inputCounts: readonly number[] }
  | { kind: "range"; minimumInputCount: number; maximumInputCount: number }
  | { kind: "logical"; controlCount: number; physicalInputCount: "not-asserted" }
  | { kind: "unknown" };

export interface EncoderTopology {
  confidence: EncoderTopologyConfidence;
  confidenceDetail: string;
  capacity: EncoderInputCapacity;
  terminals: readonly EncoderVisualTerminal[];
  auxiliaryCounts: readonly {
    id: string;
    label: string;
    count: number;
    /** True when the auxiliary function shares terminals counted above. */
    sharesInputCapacity: boolean;
  }[];
}

export interface EncoderVisualLayoutHints {
  strategy: "player-banks" | "jamma-edge" | "logical-control-grid" | "adaptive-observed";
  /** Width divided by height; advisory only, never a physical board dimension. */
  preferredAspectRatio: number;
  preferredColumns: number;
  groupOrder: readonly string[];
}

export interface EncoderEvidenceSource {
  id: string;
  authority: "manufacturer" | "official-project" | "repository-measurement";
  title: string;
  url?: string;
  repositoryPath?: string;
  supports: readonly ("identity" | "capacity" | "terminal-roster" | "connection" | "output-behavior")[];
}

export interface EncoderVisualProfile {
  id: EncoderVisualProfileId;
  manufacturer: string;
  model: string;
  shortLabel: string;
  summary: string;
  visualKind: EncoderVisualKind;
  /**
   * Only backend-authored family ids live here. A browser never matches a USB
   * id, product string, or display label against this list.
   */
  backendFamilyIds: readonly string[];
  manualSelection: "allowed" | "required-for-variant" | "fallback-only";
  topology: EncoderTopology;
  layout: EncoderVisualLayoutHints;
  connections: readonly string[];
  advertisedOutputs: readonly string[];
  sources: readonly EncoderEvidenceSource[];
}

const ULTIMARC_IPACS_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-ipacs-index",
  authority: "manufacturer",
  title: "Ultimarc control interfaces — I-PACs",
  url: "https://www.ultimarc.com/control-interfaces/i-pacs/",
  supports: ["identity", "capacity", "connection", "output-behavior"],
};

const IPAC4_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-ipac4-product",
  authority: "manufacturer",
  title: "Ultimarc I-PAC4 product and installation guide",
  url: "https://www.ultimarc.com/control-interfaces/i-pacs/i-pac4-board/",
  supports: ["identity", "capacity", "terminal-roster", "connection", "output-behavior"],
};

const IPAC4_MEASURED_SOURCE: EncoderEvidenceSource = {
  id: "ksx-ipac4-measured-map",
  authority: "repository-measurement",
  title: "KSX lossless I-PAC 4 release-0056 terminal map",
  repositoryPath: "crates/ksx-backend/src/panel_programming.rs",
  supports: ["identity", "capacity", "terminal-roster"],
};

const IPAC2_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-ipac2-product",
  authority: "manufacturer",
  title: "Ultimarc I-PAC2 product and installation guide",
  url: "https://www.ultimarc.com/control-interfaces/i-pacs/i-pac2/",
  supports: ["identity", "capacity", "terminal-roster", "connection", "output-behavior"],
};

const ULTIMATE_IO_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-ultimate-io-product",
  authority: "manufacturer",
  title: "Ultimarc I-PAC Ultimate I/O product and installation guide",
  url: "https://www.ultimarc.com/control-interfaces/i-pacs/i-pac-ultimate-i-o/",
  supports: ["identity", "capacity", "terminal-roster", "connection", "output-behavior"],
};

const MINIPAC_32_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-minipac-standard-product",
  authority: "manufacturer",
  title: "Ultimarc Mini-PAC Standard product and installation guide",
  url: "https://www.ultimarc.com/control-interfaces/mini-pac-en/mini-pac/",
  supports: ["identity", "capacity", "terminal-roster", "connection", "output-behavior"],
};

const MINIPAC_FOUR_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-minipac-four-product",
  authority: "manufacturer",
  title: "Ultimarc Mini-PAC FOUR product and installation guide",
  url: "https://www.ultimarc.com/control-interfaces/mini-pac-en/mini-pac-standard-clone/",
  supports: ["identity", "capacity", "terminal-roster", "connection", "output-behavior"],
};

const JPAC_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-jpac-product",
  authority: "manufacturer",
  title: "Ultimarc J-PAC JAMMA interface",
  url: "https://www.ultimarc.com/control-interfaces/j-pac-en/j-pac-jamma-interface/",
  supports: ["identity", "terminal-roster", "connection", "output-behavior"],
};

const JPAC_C_SOURCE: EncoderEvidenceSource = {
  id: "ultimarc-jpac-c-product",
  authority: "manufacturer",
  title: "Ultimarc J-PAC-C control-only variant",
  url: "https://www.ultimarc.com/control-interfaces/j-pac-en/j-pac-c-control-only-version/",
  supports: ["identity", "terminal-roster", "connection"],
};

const BROOK_FUSION_SOURCE: EncoderEvidenceSource = {
  id: "brook-ufb-fusion-product",
  authority: "manufacturer",
  title: "Brook Universal Fighting Board Fusion",
  url: "https://www.brookaccessory.com/products/ufbfusion/index.html",
  supports: ["identity", "terminal-roster", "connection", "output-behavior"],
};

const GP2040_SOURCE: EncoderEvidenceSource = {
  id: "gp2040-ce-wiring",
  authority: "official-project",
  title: "GP2040-CE microcontroller board wiring",
  url: "https://gp2040-ce.info/controller-build/wiring",
  supports: ["identity", "connection", "output-behavior"],
};

const GP2040_PIN_SOURCE: EncoderEvidenceSource = {
  id: "gp2040-ce-pin-mapping",
  authority: "official-project",
  title: "GP2040-CE Web Configurator pin mapping",
  url: "https://gp2040-ce.info/web-configurator/menu-pages/gpio-pin-mapping/",
  supports: ["terminal-roster", "connection", "output-behavior"],
};

const DIRECTIONS = ["up", "down", "left", "right"] as const;

interface PlayerBankOptions {
  player: number;
  switchCount: number;
  includeAB?: boolean;
  includeStartCoin?: boolean;
  connection: EncoderVisualTerminal["connection"];
  identityScope?: EncoderVisualTerminal["identityScope"];
  sourceRefs: readonly string[];
}

function playerBank(options: PlayerBankOptions): EncoderVisualTerminal[] {
  const player = options.player;
  const groupId = `player-${player}`;
  const identityScope = options.identityScope ?? "physical-terminal";
  const result: EncoderVisualTerminal[] = DIRECTIONS.map((direction) => ({
    id: `${player}${direction}`,
    label: `P${player} ${direction[0].toUpperCase()}${direction.slice(1)}`,
    groupId,
    kind: "direction",
    player,
    identityScope,
    connection: options.connection,
    presence: "always",
    capabilities: ["switch"],
    sourceRefs: options.sourceRefs,
  }));
  for (let index = 1; index <= options.switchCount; index += 1) {
    result.push({
      id: `${player}sw${index}`,
      label: `P${player} SW${index}`,
      groupId,
      kind: "action",
      player,
      identityScope,
      connection: options.connection,
      presence: "always",
      capabilities: ["switch"],
      sourceRefs: options.sourceRefs,
    });
  }
  if (options.includeAB) {
    for (const suffix of ["a", "b"] as const) {
      result.push({
        id: `${player}${suffix}`,
        label: `P${player} ${suffix.toUpperCase()}`,
        groupId,
        kind: "auxiliary",
        player,
        identityScope,
        connection: options.connection,
        presence: "always",
        capabilities: ["switch"],
        sourceRefs: options.sourceRefs,
      });
    }
  }
  if (options.includeStartCoin) {
    result.push(
      {
        id: `${player}start`,
        label: `P${player} Start`,
        groupId,
        kind: "start",
        player,
        identityScope,
        connection: options.connection,
        presence: "always",
        capabilities: ["switch"],
        sourceRefs: options.sourceRefs,
      },
      {
        id: `${player}coin`,
        label: `P${player} Coin`,
        groupId,
        kind: "coin",
        player,
        identityScope,
        connection: options.connection,
        presence: "always",
        capabilities: ["switch"],
        sourceRefs: options.sourceRefs,
      },
    );
  }
  return result;
}

function fourPlayer56(
  connection: EncoderVisualTerminal["connection"],
  sourceRefs: readonly string[],
): EncoderVisualTerminal[] {
  return [1, 2, 3, 4].flatMap((player) => playerBank({
    player,
    switchCount: 8,
    includeStartCoin: true,
    connection,
    sourceRefs,
  }));
}

function twoPlayer32(
  connection: EncoderVisualTerminal["connection"],
  sourceRefs: readonly string[],
): EncoderVisualTerminal[] {
  return [1, 2].flatMap((player) => playerBank({
    player,
    switchCount: 8,
    includeAB: true,
    includeStartCoin: true,
    connection,
    sourceRefs,
  }));
}

function ultimateIo48(): EncoderVisualTerminal[] {
  const refs = [ULTIMATE_IO_SOURCE.id];
  const terminals = [1, 2].flatMap((player) => playerBank({
    player,
    switchCount: 8,
    includeAB: true,
    includeStartCoin: true,
    connection: "harness",
    sourceRefs: refs,
  }));
  terminals.push(...[3, 4].flatMap((player) => playerBank({
    player,
    switchCount: 4,
    connection: "harness",
    sourceRefs: refs,
  })));
  return terminals.map((terminal) => {
    const optical = terminal.player === 3 && terminal.kind === "direction"
      || terminal.player === 4 && (terminal.id === "4left" || terminal.id === "4right");
    return optical
      ? { ...terminal, capabilities: ["switch", "optical-axis"] as const }
      : terminal;
  });
}

function jpacFamilyControls(): EncoderVisualTerminal[] {
  const refs = [JPAC_SOURCE.id, JPAC_C_SOURCE.id];
  const controls = [1, 2].flatMap((player) => playerBank({
    player,
    switchCount: 6,
    includeStartCoin: true,
    // The standard J-PAC and J-PAC-C route several later buttons
    // differently. This family-level visual names logical controls only;
    // the profile-level connection note carries the safe shared topology.
    connection: "logical",
    identityScope: "logical-control",
    sourceRefs: refs,
  }));
  for (const player of [1, 2]) {
    for (const button of [7, 8]) {
      controls.push({
        id: `${player}b${button}`,
        label: `P${player} Button ${button}`,
        groupId: `player-${player}`,
        kind: "action",
        player,
        identityScope: "logical-control",
        connection: "logical",
        presence: "variant-only",
        capabilities: ["switch"],
        sourceRefs: [JPAC_SOURCE.id],
      });
    }
  }
  controls.push(...([
    ["service", "Service", "service"],
    ["test", "Test", "test"],
    ["tilt", "Tilt", "tilt"],
  ] as const).map(([id, label, kind]) => ({
    id,
    label,
    groupId: "cabinet",
    kind,
    identityScope: "logical-control" as const,
    connection: "logical" as const,
    presence: "always" as const,
    capabilities: ["switch"] as const,
    sourceRefs: refs,
  })));
  return controls;
}

interface LogicalControlSpec {
  id: string;
  label: string;
  groupId: string;
  kind: EncoderTerminalKind;
}

function logicalControls(
  controls: readonly LogicalControlSpec[],
  sourceRefs: readonly string[],
): EncoderVisualTerminal[] {
  return controls.map((control) => ({
    ...control,
    identityScope: "logical-control",
    connection: "logical",
    presence: "always",
    capabilities: ["gamepad-action"],
    sourceRefs,
  }));
}

const BROOK_FUSION_CONTROLS: readonly LogicalControlSpec[] = [
  ...DIRECTIONS.map((direction) => ({
    id: direction,
    label: direction[0].toUpperCase() + direction.slice(1),
    groupId: "directions",
    kind: "direction" as const,
  })),
  ...["1p", "2p", "3p", "4p", "1k", "2k", "3k", "4k"].map((id) => ({
    id,
    label: id.toUpperCase(),
    groupId: "actions",
    kind: "action" as const,
  })),
  ...[
    ["select", "Select / Share"],
    ["start", "Start / Options"],
    ["l3", "L3"],
    ["r3", "R3"],
    ["home", "Home / PS / Xbox"],
    ["touchpad", "Touchpad press"],
  ].map(([id, label]) => ({ id, label, groupId: "system", kind: "auxiliary" as const })),
];

const GP2040_LOGICAL_CONTROLS: readonly LogicalControlSpec[] = [
  ...DIRECTIONS.map((direction) => ({
    id: direction,
    label: direction[0].toUpperCase() + direction.slice(1),
    groupId: "directions",
    kind: "direction" as const,
  })),
  ...["b1", "b2", "b3", "b4", "l1", "l2", "r1", "r2"].map((id) => ({
    id,
    label: id.toUpperCase(),
    groupId: "actions",
    kind: "action" as const,
  })),
  ...[
    ["s1", "Select / View"],
    ["s2", "Start / Menu"],
    ["l3", "L3"],
    ["r3", "R3"],
    ["a1", "Home"],
    ["a2", "Capture / Touchpad"],
  ].map(([id, label]) => ({ id, label, groupId: "system", kind: "auxiliary" as const })),
];

const RAW_ENCODER_VISUAL_PROFILES: readonly EncoderVisualProfile[] = [
  {
    id: "ultimarc-ipac4",
    manufacturer: "Ultimarc",
    model: "I-PAC4 / I-PAC 4X",
    shortLabel: "I-PAC 4X",
    summary: "Four-player 56-input keyboard/gamepad encoder with a measured KSX terminal map.",
    visualKind: "terminal-board",
    backendFamilyIds: ["ultimarc-ipac4"],
    manualSelection: "allowed",
    topology: {
      confidence: "measured",
      confidenceDetail: "The 56-row order and ids match KSX's measured release-0056 profile; published capacity corroborates it.",
      capacity: { kind: "exact", inputCount: 56 },
      terminals: fourPlayer56("screw", [IPAC4_SOURCE.id, IPAC4_MEASURED_SOURCE.id]),
      auxiliaryCounts: [],
    },
    layout: { strategy: "player-banks", preferredAspectRatio: 1.9, preferredColumns: 2, groupOrder: ["player-1", "player-2", "player-3", "player-4"] },
    connections: ["USB 2.0", "screw terminals", "shared ground"],
    advertisedOutputs: ["keyboard and mouse", "four DirectInput gamepads", "four XInput gamepads"],
    sources: [IPAC4_SOURCE, IPAC4_MEASURED_SOURCE],
  },
  {
    id: "ultimarc-ipac2",
    manufacturer: "Ultimarc",
    model: "I-PAC2",
    shortLabel: "I-PAC2",
    summary: "Two-player 32-input keyboard/gamepad encoder with dedicated optical headers.",
    visualKind: "terminal-board",
    backendFamilyIds: ["ultimarc-ipac2"],
    manualSelection: "allowed",
    topology: {
      confidence: "manufacturer-published",
      confidenceDetail: "Capacity and control names come from Ultimarc; KSX has not measured this model's programming protocol.",
      capacity: { kind: "exact", inputCount: 32 },
      terminals: twoPlayer32("screw", [IPAC2_SOURCE.id]),
      auxiliaryCounts: [
        { id: "optical-header", label: "Dedicated trackball/spinner header", count: 1, sharesInputCapacity: false },
      ],
    },
    layout: { strategy: "player-banks", preferredAspectRatio: 1.75, preferredColumns: 2, groupOrder: ["player-1", "player-2"] },
    connections: ["USB", "screw terminals", "dedicated optical header", "PACLink header"],
    advertisedOutputs: ["keyboard and mouse", "two DirectInput gamepads", "two XInput gamepads"],
    sources: [ULTIMARC_IPACS_SOURCE, IPAC2_SOURCE],
  },
  {
    id: "ultimarc-ultimate-io",
    manufacturer: "Ultimarc",
    model: "I-PAC Ultimate I/O",
    shortLabel: "Ultimate I/O",
    summary: "Two- to four-player interface with 48 switch inputs and 96 LED output channels.",
    visualKind: "harness-board",
    backendFamilyIds: ["ultimarc-ipac-ultimate-io"],
    manualSelection: "allowed",
    topology: {
      confidence: "manufacturer-published",
      confidenceDetail: "Ultimarc publishes the 48-input roster and which six inputs may be reassigned to optical axes.",
      capacity: { kind: "exact", inputCount: 48 },
      terminals: ultimateIo48(),
      auxiliaryCounts: [
        { id: "led-output", label: "LED output channels", count: 96, sharesInputCapacity: false },
        { id: "optical-input", label: "Optical-capable inputs", count: 6, sharesInputCapacity: true },
      ],
    },
    layout: { strategy: "player-banks", preferredAspectRatio: 1.9, preferredColumns: 2, groupOrder: ["player-1", "player-2", "player-3", "player-4"] },
    connections: ["USB", "32-input main harness", "16-input expansion harness", "LED harnesses"],
    advertisedOutputs: ["keyboard and mouse", "two DirectInput gamepads", "two XInput gamepads", "96-channel LED control"],
    sources: [ULTIMARC_IPACS_SOURCE, ULTIMATE_IO_SOURCE],
  },
  {
    id: "ultimarc-minipac-32",
    manufacturer: "Ultimarc",
    model: "Mini-PAC Standard / Opti (32-input family)",
    shortLabel: "Mini-PAC 32",
    summary: "Harness-based two-player 32-input encoder; the Opti variant adds optical connectivity.",
    visualKind: "harness-board",
    backendFamilyIds: ["ultimarc-minipac"],
    manualSelection: "required-for-variant",
    topology: {
      confidence: "manufacturer-published",
      confidenceDetail: "The 32-input topology is published, but the current backend family fact does not distinguish Standard, Opti, and FOUR variants.",
      capacity: { kind: "exact", inputCount: 32 },
      terminals: twoPlayer32("harness", [MINIPAC_32_SOURCE.id]),
      auxiliaryCounts: [],
    },
    layout: { strategy: "player-banks", preferredAspectRatio: 1.75, preferredColumns: 2, groupOrder: ["player-1", "player-2"] },
    connections: ["USB", "32-way switch harness", "daisy-chain ground harness"],
    advertisedOutputs: ["keyboard and mouse", "two DirectInput gamepads", "two XInput gamepads"],
    sources: [ULTIMARC_IPACS_SOURCE, MINIPAC_32_SOURCE],
  },
  {
    id: "ultimarc-minipac-four",
    manufacturer: "Ultimarc",
    model: "Mini-PAC FOUR",
    shortLabel: "Mini-PAC FOUR",
    summary: "Harness-based four-player 56-input encoder; manual/backend-exact selection is required.",
    visualKind: "harness-board",
    backendFamilyIds: ["ultimarc-minipac"],
    manualSelection: "required-for-variant",
    topology: {
      confidence: "manufacturer-published",
      confidenceDetail: "Ultimarc publishes 56 inputs and I-PAC4-equivalent behavior; KSX has no measured identity/profile that separates this variant.",
      capacity: { kind: "exact", inputCount: 56 },
      terminals: fourPlayer56("harness", [MINIPAC_FOUR_SOURCE.id]),
      auxiliaryCounts: [],
    },
    layout: { strategy: "player-banks", preferredAspectRatio: 1.9, preferredColumns: 2, groupOrder: ["player-1", "player-2", "player-3", "player-4"] },
    connections: ["USB", "two switch harnesses", "daisy-chain ground harness"],
    advertisedOutputs: ["keyboard", "four DirectInput gamepads", "four XInput gamepads"],
    sources: [ULTIMARC_IPACS_SOURCE, MINIPAC_FOUR_SOURCE],
  },
  {
    id: "ultimarc-jpac",
    manufacturer: "Ultimarc",
    model: "J-PAC family",
    shortLabel: "J-PAC",
    summary: "JAMMA cabinet interface with a shared 6-button core and standard-model 7/8-button extensions.",
    visualKind: "jamma-board",
    backendFamilyIds: ["ultimarc-jpac"],
    manualSelection: "allowed",
    topology: {
      confidence: "manufacturer-published",
      confidenceDetail: "The visual preserves the J-PAC/J-PAC-C range: 27 shared logical controls, plus four standard-model button extensions.",
      capacity: { kind: "discrete", inputCounts: [27, 31] },
      terminals: jpacFamilyControls(),
      auxiliaryCounts: [],
    },
    layout: { strategy: "jamma-edge", preferredAspectRatio: 1.75, preferredColumns: 2, groupOrder: ["player-1", "player-2", "cabinet"] },
    connections: [
      "USB",
      "JAMMA edge",
      "variant-dependent auxiliary screw terminals",
      "VGA on the standard J-PAC",
    ],
    advertisedOutputs: ["keyboard-compatible controls"],
    sources: [JPAC_SOURCE, JPAC_C_SOURCE],
  },
  {
    id: "brook-ufb-fusion",
    manufacturer: "Brook Gaming",
    model: "Universal Fighting Board Fusion",
    shortLabel: "UFB Fusion",
    summary: "A one-player multi-console fight-board reference, drawn as logical controls rather than asserted screw positions.",
    visualKind: "fight-board",
    backendFamilyIds: [],
    manualSelection: "allowed",
    topology: {
      confidence: "logical-only",
      confidenceDetail: "The official product establishes the board and functions; this profile intentionally does not claim a physical terminal count or pin ordering.",
      capacity: { kind: "logical", controlCount: BROOK_FUSION_CONTROLS.length, physicalInputCount: "not-asserted" },
      terminals: logicalControls(BROOK_FUSION_CONTROLS, [BROOK_FUSION_SOURCE.id]),
      auxiliaryCounts: [],
    },
    layout: { strategy: "logical-control-grid", preferredAspectRatio: 1.65, preferredColumns: 3, groupOrder: ["directions", "actions", "system"] },
    connections: ["USB", "fight-stick wiring headers / terminals (variant dependent)"],
    advertisedOutputs: ["multi-console gamepad", "PC gamepad"],
    sources: [BROOK_FUSION_SOURCE],
  },
  {
    id: "gp2040-ce-reference",
    manufacturer: "OpenStickCommunity",
    model: "GP2040-CE reference",
    shortLabel: "GP2040-CE",
    summary: "Configurable RP2040 gamepad firmware; board and GPIO topology depend on the selected board configuration.",
    visualKind: "firmware-reference",
    backendFamilyIds: [],
    manualSelection: "allowed",
    topology: {
      confidence: "official-project-reference",
      confidenceDetail: "The generic action vocabulary is official, while GPIO pins are remappable and board-specific; no fixed PCB topology is asserted.",
      capacity: { kind: "logical", controlCount: GP2040_LOGICAL_CONTROLS.length, physicalInputCount: "not-asserted" },
      terminals: logicalControls(GP2040_LOGICAL_CONTROLS, [GP2040_PIN_SOURCE.id]),
      auxiliaryCounts: [],
    },
    layout: { strategy: "logical-control-grid", preferredAspectRatio: 1.65, preferredColumns: 3, groupOrder: ["directions", "actions", "system"] },
    connections: ["USB", "board-specific GPIO", "optional Brook-compatible harness on supported boards"],
    advertisedOutputs: ["multi-platform gamepad firmware"],
    sources: [GP2040_SOURCE, GP2040_PIN_SOURCE],
  },
  {
    id: "unknown-hid",
    manufacturer: "Unknown",
    model: "Unidentified HID device",
    shortLabel: "Unknown HID",
    summary: "A generic observed-input surface that makes no model, capacity, wiring, or protocol claim.",
    visualKind: "generic-hid",
    backendFamilyIds: [],
    manualSelection: "fallback-only",
    topology: {
      confidence: "unknown",
      confidenceDetail: "No verified visual topology is available for this device.",
      capacity: { kind: "unknown" },
      terminals: [],
      auxiliaryCounts: [],
    },
    layout: { strategy: "adaptive-observed", preferredAspectRatio: 1.5, preferredColumns: 1, groupOrder: [] },
    connections: ["unknown"],
    advertisedOutputs: ["observed HID signals only"],
    sources: [],
  },
];

export interface EncoderRegistryValidation {
  valid: boolean;
  errors: readonly string[];
}

/** Pure contract check kept beside the source data so adding a profile cannot
 * quietly introduce duplicate ids, invented capacity, or dangling evidence. */
export function validateEncoderVisualRegistry(
  profiles: readonly EncoderVisualProfile[] = RAW_ENCODER_VISUAL_PROFILES,
): EncoderRegistryValidation {
  const errors: string[] = [];
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) errors.push(`duplicate profile id: ${profile.id}`);
    profileIds.add(profile.id);

    const sourceIds = new Set(profile.sources.map((source) => source.id));
    if (sourceIds.size !== profile.sources.length) errors.push(`${profile.id}: duplicate source id`);
    for (const source of profile.sources) {
      if (!source.url && !source.repositoryPath) errors.push(`${profile.id}: source ${source.id} has no location`);
      if (source.url && !source.url.startsWith("https://")) errors.push(`${profile.id}: source ${source.id} is not HTTPS`);
    }

    const terminalIds = new Set<string>();
    for (const terminal of profile.topology.terminals) {
      if (!terminal.id || terminalIds.has(terminal.id)) errors.push(`${profile.id}: duplicate/empty terminal id ${terminal.id}`);
      terminalIds.add(terminal.id);
      for (const sourceRef of terminal.sourceRefs) {
        if (!sourceIds.has(sourceRef)) errors.push(`${profile.id}/${terminal.id}: unknown source ${sourceRef}`);
      }
      if (terminal.identityScope === "logical-control" && terminal.connection !== "logical") {
        errors.push(`${profile.id}/${terminal.id}: logical control claims a physical connection`);
      }
    }

    const always = profile.topology.terminals.filter((terminal) => terminal.presence === "always").length;
    const maximum = profile.topology.terminals.length;
    const capacity = profile.topology.capacity;
    if (capacity.kind === "exact" && (always !== capacity.inputCount || maximum !== capacity.inputCount)) {
      errors.push(`${profile.id}: exact capacity ${capacity.inputCount} does not match ${always}/${maximum} rows`);
    }
    if (capacity.kind === "discrete") {
      const counts = [...capacity.inputCounts].sort((left, right) => left - right);
      if (
        counts.length < 2 ||
        new Set(counts).size !== counts.length ||
        counts.some((count) => !Number.isInteger(count) || count < 0) ||
        always !== counts[0] ||
        maximum !== counts.at(-1)
      ) {
        errors.push(`${profile.id}: discrete capacity does not match ${always}/${maximum} rows`);
      }
    }
    if (capacity.kind === "range" && (always !== capacity.minimumInputCount || maximum !== capacity.maximumInputCount)) {
      errors.push(`${profile.id}: range capacity does not match ${always}/${maximum} rows`);
    }
    if (capacity.kind === "logical" && maximum !== capacity.controlCount) {
      errors.push(`${profile.id}: logical control count ${capacity.controlCount} does not match ${maximum} rows`);
    }
    if (capacity.kind === "unknown" && maximum !== 0) errors.push(`${profile.id}: unknown capacity has asserted rows`);
    if (profile.topology.confidence === "measured" && !profile.sources.some((source) => source.authority === "repository-measurement")) {
      errors.push(`${profile.id}: measured topology has no measurement source`);
    }
    const actualGroups = new Set(profile.topology.terminals.map((terminal) => terminal.groupId));
    if (new Set(profile.layout.groupOrder).size !== profile.layout.groupOrder.length) {
      errors.push(`${profile.id}: duplicate layout group`);
    }
    for (const groupId of profile.layout.groupOrder) {
      if (!actualGroups.has(groupId)) errors.push(`${profile.id}: layout names missing group ${groupId}`);
    }
    if (profile.topology.terminals.length > 0 && actualGroups.size !== profile.layout.groupOrder.length) {
      errors.push(`${profile.id}: layout does not order every terminal group`);
    }
    if (!(profile.layout.preferredAspectRatio > 0) || !Number.isInteger(profile.layout.preferredColumns) || profile.layout.preferredColumns < 1) {
      errors.push(`${profile.id}: invalid layout dimensions`);
    }
  }

  for (const expectedId of ENCODER_VISUAL_PROFILE_IDS) {
    if (!profileIds.has(expectedId)) errors.push(`missing required profile id: ${expectedId}`);
  }
  if (profileIds.size !== ENCODER_VISUAL_PROFILE_IDS.length) {
    errors.push("registry contains an id outside ENCODER_VISUAL_PROFILE_IDS");
  }
  return { valid: errors.length === 0, errors };
}

const SOURCE_VALIDATION = validateEncoderVisualRegistry();
if (!SOURCE_VALIDATION.valid) {
  throw new Error(`Invalid encoder visual registry:\n${SOURCE_VALIDATION.errors.join("\n")}`);
}

export const ENCODER_VISUAL_PROFILES: readonly EncoderVisualProfile[] = RAW_ENCODER_VISUAL_PROFILES;

export function isEncoderVisualProfileId(value: string): value is EncoderVisualProfileId {
  return (ENCODER_VISUAL_PROFILE_IDS as readonly string[]).includes(value);
}

export function getEncoderVisualProfile(id: EncoderVisualProfileId): EncoderVisualProfile {
  const profile = ENCODER_VISUAL_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Encoder visual profile '${id}' is not registered`);
  return profile;
}

export function listEncoderVisualProfiles(includeFallback = false): readonly EncoderVisualProfile[] {
  return includeFallback
    ? [...ENCODER_VISUAL_PROFILES]
    : ENCODER_VISUAL_PROFILES.filter((profile) => profile.manualSelection !== "fallback-only");
}

export function findEncoderVisualTerminal(
  profileId: EncoderVisualProfileId,
  terminalId: string,
): EncoderVisualTerminal | undefined {
  return getEncoderVisualProfile(profileId).topology.terminals.find((terminal) => terminal.id === terminalId);
}

export function summarizeEncoderTopology(profile: EncoderVisualProfile): string {
  const capacity = profile.topology.capacity;
  switch (capacity.kind) {
    case "exact":
      return `${capacity.inputCount} physical inputs · ${profile.topology.confidence}`;
    case "discrete":
      return `${capacity.inputCounts.join(" or ")} variant-dependent controls · ${profile.topology.confidence}`;
    case "range":
      return `${capacity.minimumInputCount}–${capacity.maximumInputCount} variant-dependent controls · ${profile.topology.confidence}`;
    case "logical":
      return `${capacity.controlCount} logical controls · physical topology not asserted`;
    case "unknown":
      return "Capacity and physical topology unknown";
  }
}
