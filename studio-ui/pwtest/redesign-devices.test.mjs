// The redesign device workbench, in a real browser.
//
// WHY THIS LEVEL: the Rust tests pin that the picker is SERVED (four tiers,
// the nocturne sorting rules, the raw selector on every row — render_redesign
// and snapshot.rs). Only a browser can pin the workbench itself: that picking
// boards mounts widgets on the canvas — several at once, the lane's whole
// thesis — that membership survives a reload through the arrangement store,
// that removal is a toggle away, and that the unavailable tier is visible but
// never a control.
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { build as bundle } from "esbuild";
import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";
import {
  claimSavedDeviceGeometryKey,
  deviceInstanceId,
  legacyDeviceInstanceId,
} from "../src/device-instance-id.ts";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_REDESIGN_DEVICES_PORT ?? 4531);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const encoderContractBundle = await bundle({
  stdin: {
    contents: [
      'export { detectEncoderVisualProfile, validateEncoderDetectionRules } from "../src/encoderDetection.ts";',
      'export { getEncoderVisualProfile, listEncoderVisualProfiles, validateEncoderVisualRegistry } from "../src/encoderVisualRegistry.ts";',
      'export { encoderEmissionLabel, encoderEmissionShortLabel, validateEncoderChart } from "../src/encoderChartRead.ts";',
      'export { parseEncoderObservationView } from "../src/encoderSignalObservation.ts";',
    ].join("\n"),
    resolveDir: path.join(repoRoot, "studio-ui", "pwtest"),
    sourcefile: "encoder-profile-contract-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  write: false,
});
const {
  detectEncoderVisualProfile,
  encoderEmissionLabel,
  encoderEmissionShortLabel,
  getEncoderVisualProfile,
  listEncoderVisualProfiles,
  parseEncoderObservationView,
  validateEncoderChart,
  validateEncoderDetectionRules,
  validateEncoderVisualRegistry,
} = await import(
  `data:text/javascript;base64,${Buffer.from(encoderContractBundle.outputFiles[0].text).toString("base64")}`
);
const encoderProductSimulationBundle = await bundle({
  stdin: {
    contents: 'export { createEncoderWorkbenchSurface } from "../src/encoderConceptArt.ts";',
    resolveDir: path.join(repoRoot, "studio-ui", "pwtest"),
    sourcefile: "encoder-product-simulation-entry.ts",
  },
  bundle: true,
  format: "iife",
  globalName: "KsxEncoderProductSimulation",
  platform: "browser",
  target: "es2022",
  write: false,
});
const encoderProductSimulationSource = encoderProductSimulationBundle.outputFiles[0].text;

const ENCODER_RENDER_CASES = [
  {
    id: "ultimarc-ipac4", capacity: "56", groupCounts: [14, 14, 14, 14],
    physical: 56, logical: 0, connection: "screw", variant: 0,
    visualKind: "terminal-board", confidence: "measured", grammar: "screw-terminals",
    reach: "automatic", backendFamilyId: "ultimarc-ipac4", reportedCount: 56,
    harnessInterfaces: [], auxiliaryInterfaces: [], interfaceGeometries: [],
  },
  {
    id: "ultimarc-ipac2", capacity: "32", groupCounts: [16, 16],
    physical: 32, logical: 0, connection: "screw", variant: 0,
    visualKind: "terminal-board", confidence: "manufacturer-published", grammar: "screw-terminals",
    reach: "automatic", backendFamilyId: "ultimarc-ipac2", reportedCount: 32,
    harnessInterfaces: ["optical-header", "paclink-header"],
    auxiliaryInterfaces: ["optical-header", "paclink-header"],
    interfaceGeometries: ["optical-header", "paclink-header"],
  },
  {
    id: "ultimarc-ultimate-io", capacity: "48", groupCounts: [16, 16, 8, 8],
    physical: 48, logical: 0, connection: "harness", variant: 0,
    visualKind: "harness-board", confidence: "manufacturer-published", grammar: "keyed-harness",
    reach: "automatic", backendFamilyId: "ultimarc-ipac-ultimate-io", reportedCount: 48,
    harnessInterfaces: ["main-input-harness", "expansion-input-harness"],
    auxiliaryInterfaces: [], interfaceGeometries: ["main-input-harness", "expansion-input-harness"],
  },
  {
    id: "ultimarc-minipac-32", capacity: "32", groupCounts: [16, 16],
    physical: 32, logical: 0, connection: "harness", variant: 0,
    visualKind: "harness-board", confidence: "manufacturer-published", grammar: "keyed-harness",
    reach: "variant-confirmation", backendFamilyId: "ultimarc-minipac", reportedCount: 32,
    harnessInterfaces: ["switch-harness"], auxiliaryInterfaces: [],
    interfaceGeometries: ["switch-harness"],
  },
  {
    id: "ultimarc-minipac-four", capacity: "56", groupCounts: [14, 14, 14, 14],
    physical: 56, logical: 0, connection: "harness", variant: 0,
    visualKind: "harness-board", confidence: "manufacturer-published", grammar: "keyed-harness",
    reach: "variant-confirmation", backendFamilyId: "ultimarc-minipac", reportedCount: 56,
    harnessInterfaces: ["switch-harness-a", "switch-harness-b"], auxiliaryInterfaces: [],
    interfaceGeometries: ["switch-harness-a", "switch-harness-b"],
  },
  {
    id: "ultimarc-jpac", capacity: "27 / 31", groupCounts: [14, 14, 3],
    physical: 0, logical: 31, connection: "logical", variant: 4,
    visualKind: "jamma-board", confidence: "manufacturer-published", grammar: "jamma-logical-routes",
    reach: "automatic", backendFamilyId: "ultimarc-jpac", reportedCount: 27,
    harnessInterfaces: [], auxiliaryInterfaces: [], interfaceGeometries: ["jamma-edge"],
  },
  {
    id: "brook-ufb-fusion", capacity: "18", groupCounts: [4, 8, 6],
    physical: 0, logical: 18, connection: "logical", variant: 0,
    visualKind: "fight-board", confidence: "logical-only", grammar: "logical-fight-controls",
    reach: "reference-only", backendFamilyId: null, reportedCount: null,
    harnessInterfaces: [], auxiliaryInterfaces: [], interfaceGeometries: [],
  },
  {
    id: "gp2040-ce-reference", capacity: "18", groupCounts: [4, 8, 6],
    physical: 0, logical: 18, connection: "logical", variant: 0,
    visualKind: "firmware-reference", confidence: "official-project-reference",
    grammar: "remappable-logical-controls", reach: "reference-only",
    backendFamilyId: null, reportedCount: null,
    harnessInterfaces: [], auxiliaryInterfaces: [], interfaceGeometries: [],
  },
  {
    id: "unknown-hid", capacity: "unknown", groupCounts: [],
    physical: 0, logical: 0, connection: null, variant: 0,
    visualKind: "generic-hid", confidence: "unknown", grammar: "observed-signals-only",
    reach: "fallback", backendFamilyId: null, reportedCount: null,
    harnessInterfaces: [], auxiliaryInterfaces: [], interfaceGeometries: [],
  },
];
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

// The fixture's roster, by RAW selector (macro_fixture.rs device_scan).
const IPAC = "usb:d209:0430:00";
const IPAC_TWIN = "usb:d209:0430:01";
const G915 = "usb:046d:c545:00";
const G915_TWIN = "usb:046d:c545:01";
const IPAC_SLUG = deviceInstanceId(IPAC);
const IPAC_TWIN_SLUG = deviceInstanceId(IPAC_TWIN);
const G915_SLUG = deviceInstanceId(G915);
const G915_TWIN_SLUG = deviceInstanceId(G915_TWIN);

let server;
let browser;
/** ONE context for the whole suite — the workbench remembers through
 *  localStorage, and a fresh context per test would silently test nothing. */
let context;

async function waitForServer(base = BASE, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/redesign`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio devices fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer(BASE);
  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });
});

after(async () => {
  try {
    await closeContext(context);
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopFixtureProcess(server, "devices fixture");
    }
  }
});

/** A hydrated /redesign whose canvas has adopted. The workbench starts
 *  empty, so the engine's first camera transform is the adoption mark —
 *  restoreBench runs in the same init, so any remembered boards are mounted
 *  by the time the transform lands. */
async function openBench({ onRequest } = {}) {
  const page = await context.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  if (onRequest) page.on("request", onRequest);
  page.ksxNoise = noise;
  await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
    null,
    { timeout: 20_000 },
  );
  return page;
}

/** Playwright's default route teardown does not wait for an async handler.
 * Closing a page while a handler is between `route.fetch()` and `fulfill()`
 * turns an otherwise passing suite into a process-level unhandled rejection.
 * Every page/context in this route-heavy suite drains those handlers first. */
async function closePage(page) {
  if (!page || page.isClosed()) return;
  await page.unrouteAll({ behavior: "wait" });
  await page.close();
}

async function closeContext(browserContext) {
  if (!browserContext) return;
  for (const page of browserContext.pages()) await closePage(page);
  await browserContext.close();
}

/** Use the canvas's own minimap navigation contract to bring a potentially
 *  off-screen workbench item into view before exercising visible controls. */
async function revealCanvasItem(page, instanceId) {
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"][data-canvas-x]`,
    ),
    instanceId,
  );
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
  await page.locator(`.navigator-item[data-instance-id="${instanceId}"]`)
    .evaluate((marker) => marker.click());
  await page.waitForFunction(
    (id) => {
      const item = document.querySelector(
        `.forma-canvas-stage > [data-instance-id="${id}"]`,
      );
      return item?.getAttribute("aria-current") === "true" &&
        !document.querySelector(".is-camera-animating");
    },
    instanceId,
  );
}

/** The catalog/evidence comparison surface remains as an internal regression
 * harness, but it is deliberately absent from the product chrome. */
async function toggleEncoderResearchHarness(page) {
  const toggle = page.locator('[data-nx="rd-encoder-profiles"]');
  const opening = await toggle.getAttribute("aria-pressed") !== "true";
  await toggle.evaluate((button) => button.click());
  if (opening) await revealCanvasItem(page, "encoder-profile-lab");
}

describe("the device workbench", () => {
  test("the complete encoder registry simulates every admitted visual without inventing topology", () => {
    const profiles = listEncoderVisualProfiles();
    assert.deepEqual(
      [...profiles.map((profile) => profile.id), getEncoderVisualProfile("unknown-hid").id],
      ENCODER_RENDER_CASES.map((entry) => entry.id),
      "the simulation matrix must fail when a dynamic board is added without an acceptance case",
    );
    const capacityLabel = (capacity) => {
      if (capacity.kind === "exact") return String(capacity.inputCount);
      if (capacity.kind === "discrete") return capacity.inputCounts.join(" / ");
      if (capacity.kind === "range") {
        return `${capacity.minimumInputCount}–${capacity.maximumInputCount}`;
      }
      if (capacity.kind === "logical") return String(capacity.controlCount);
      return "unknown";
    };
    for (const expected of ENCODER_RENDER_CASES) {
      const profile = getEncoderVisualProfile(expected.id);
      const terminals = profile.topology.terminals;
      assert.equal(capacityLabel(profile.topology.capacity), expected.capacity, `${expected.id} capacity`);
      assert.equal(profile.visualKind, expected.visualKind, `${expected.id} board grammar`);
      assert.equal(profile.topology.confidence, expected.confidence, `${expected.id} evidence`);
      assert.deepEqual(
        profile.layout.groupOrder.map((groupId) =>
          terminals.filter((terminal) => terminal.groupId === groupId).length
        ),
        expected.groupCounts,
        `${expected.id} complete group shape`,
      );
      assert.equal(
        terminals.filter((terminal) => terminal.identityScope === "physical-terminal").length,
        expected.physical,
        `${expected.id} physical rows`,
      );
      assert.equal(
        terminals.filter((terminal) => terminal.identityScope === "logical-control").length,
        expected.logical,
        `${expected.id} logical rows`,
      );
      assert.equal(
        terminals.filter((terminal) => terminal.presence === "variant-only").length,
        expected.variant,
        `${expected.id} variant-only rows`,
      );
      assert.deepEqual(
        [...new Set(terminals.map((terminal) => terminal.connection))],
        expected.connection ? [expected.connection] : [],
        `${expected.id} connection vocabulary`,
      );
      assert.equal(new Set(terminals.map((terminal) => terminal.id)).size, terminals.length,
        `${expected.id} ids are unique`);
      if (expected.reach === "automatic") {
        assert.ok(profile.backendFamilyIds.includes(expected.backendFamilyId));
        assert.notEqual(profile.manualSelection, "required-for-variant");
      } else if (expected.reach === "variant-confirmation") {
        assert.equal(profile.manualSelection, "required-for-variant");
      } else if (expected.reach === "reference-only") {
        assert.deepEqual(profile.backendFamilyIds, []);
      } else {
        assert.equal(profile.manualSelection, "fallback-only");
      }
    }
    assert.deepEqual(
      getEncoderVisualProfile("ultimarc-ultimate-io").topology.auxiliaryCounts,
      [
        { id: "led-output", label: "LED output channels", count: 96, sharesInputCapacity: false },
        { id: "optical-input", label: "Optical-capable inputs", count: 6, sharesInputCapacity: true },
      ],
      "Ultimate I/O auxiliary capabilities never become extra switch targets",
    );
  });

  test("the complete raw selector owns a collision-resistant canvas identity", () => {
    const punctuationTwinA = "opaque:panel/a";
    const punctuationTwinB = "opaque:panel:a";
    const longSharedPrefix = `usb:${"a".repeat(120)}`;
    const longTwinA = `${longSharedPrefix}:port=1`;
    const longTwinB = `${longSharedPrefix}:port=2`;

    for (const [left, right] of [
      [punctuationTwinA, punctuationTwinB],
      [longTwinA, longTwinB],
    ]) {
      assert.equal(
        legacyDeviceInstanceId(left),
        legacyDeviceInstanceId(right),
        "the fixture pair must reproduce the old lossy-key collision",
      );
      assert.notEqual(
        deviceInstanceId(left),
        deviceInstanceId(right),
        "the complete selector must distinguish twin boards",
      );
      for (const id of [deviceInstanceId(left), deviceInstanceId(right)]) {
        assert.match(id, /^[A-Za-z0-9_-]+$/, "the engine-safe charset is preserved");
        assert.ok(id.length <= 96, `canvas identity is ${id.length} characters`);
      }
    }
    assert.equal(
      deviceInstanceId(IPAC),
      "dev-usb-d209-0430-00-01xwu04m1az45",
      "the persisted identity for a known selector stays stable",
    );

    const legacyKey = legacyDeviceInstanceId(punctuationTwinA);
    const savedKeys = new Set([legacyKey]);
    const owners = new Map();
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinA, savedKeys, owners),
      legacyKey,
      "the first raw selector claims its migrated coordinates",
    );
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinB, savedKeys, owners),
      undefined,
      "a colliding twin falls back to its staggered home instead of stacking",
    );
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinA, savedKeys, owners),
      legacyKey,
      "the same board can reclaim its position after a remove/add cycle",
    );
  });

  test("encoder profile detection fails closed on contradictory or impossible facts", () => {
    assert.equal(validateEncoderVisualRegistry().valid, true);
    assert.equal(validateEncoderDetectionRules().valid, true);

    const jpac = getEncoderVisualProfile("ultimarc-jpac");
    assert.deepEqual(jpac.topology.capacity, { kind: "discrete", inputCounts: [27, 31] });
    assert.equal(
      jpac.topology.terminals.every((terminal) =>
        terminal.identityScope === "logical-control" && terminal.connection === "logical"
      ),
      true,
      "a family-level J-PAC drawing must not invent variant-specific edge/screw routing",
    );
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          familyId: "ultimarc-jpac",
          profileState: "unprofiled-release",
          profileTerminalCount: 28,
        },
      }).resolution,
      "identity-conflict",
      "the discrete 27/31 J-PAC family never accepts an impossible in-between count",
    );

    const narrowedMiniPac = detectEncoderVisualProfile({
      backend: {
        role: "panel-encoder",
        familyId: "ultimarc-minipac",
        profileState: "unprofiled-release",
        profileTerminalCount: 32,
      },
    });
    assert.equal(narrowedMiniPac.resolution, "backend-family");
    assert.equal(narrowedMiniPac.profile.id, "ultimarc-minipac-32");
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          familyId: "ultimarc-minipac",
          profileState: "unprofiled-release",
          profileTerminalCount: 999,
        },
      }).resolution,
      "identity-conflict",
    );
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          familyId: "ultimarc-minipac",
          profileState: "unprofiled-release",
        },
        manualProfileId: "brook-ufb-fusion",
      }).resolution,
      "identity-conflict",
      "a manual catalog choice cannot override an incompatible backend family",
    );

    for (const familyId of ["ultimarc-uhid", "constructor", "__proto__"]) {
      const knownWithoutVisual = detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          familyId,
          familyLabel: familyId,
          profileState: "unprofiled-release",
        },
      });
      assert.equal(knownWithoutVisual.resolution, "known-family");
      assert.equal(knownWithoutVisual.identity.source, "backend-family");
      assert.equal(knownWithoutVisual.profile.id, "unknown-hid");
    }
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "keyboard",
          familyId: "ultimarc-ipac4",
          profileState: "unrecognised",
        },
      }).resolution,
      "identity-conflict",
      "contradictory role and recognition facts never select a board drawing",
    );

    const exactButUnprofiled = detectEncoderVisualProfile({
      backend: {
        role: "panel-encoder",
        familyId: "ultimarc-ipac4",
        visualProfileId: "ultimarc-ipac4",
        profileState: "unprofiled-release",
        capabilities: { canReadChart: false },
      },
    });
    assert.equal(exactButUnprofiled.resolution, "backend-exact");
    assert.equal(exactButUnprofiled.profile.id, "ultimarc-ipac4");
    assert.equal(
      exactButUnprofiled.protocol.chartRead,
      "unsupported",
      "exact visual identity does not invent support for an unprofiled firmware release",
    );
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          visualProfileId: "ultimarc-ipac4",
          profileState: "unrecognised",
        },
      }).resolution,
      "identity-conflict",
      "an unrecognised state still cannot claim an exact board visual",
    );
    assert.equal(
      detectEncoderVisualProfile({
        backend: {
          role: "panel-encoder",
          familyId: "ultimarc-ipac2",
          profileState: "unprofiled-release",
          capabilities: { canReadChart: true },
        },
      }).resolution,
      "identity-conflict",
      "an unprofiled release cannot advertise a configuration reader",
    );
  });

  test("encoder charts require backend-consistent key tuples and exact Shift summaries", () => {
    const expectedIds = ["1sw1", "1sw2", "1sw3"];
    const unassigned = () => ({ code: 0, key: null, label: "Unassigned", supported: true });
    const terminal = (terminalId, terminalLabel) => ({
      terminal_id: terminalId,
      terminal_label: terminalLabel,
      player: 1,
      kind: "button",
      normal: unassigned(),
      shifted: unassigned(),
      shift_state: "disabled",
      is_shift: false,
      press_resolves: true,
    });
    const terminals = [
      terminal("1sw1", "Player 1 · Button 1"),
      terminal("1sw2", "Player 1 · Button 2"),
      terminal("1sw3", "Player 1 · Button 3"),
    ];
    const outcome = (rows, shift) => ({
      ok: true,
      board_name: "Contract board",
      image_sha256: "a".repeat(64),
      terminals: rows,
      shift,
    });
    const validates = (rows, shift) => validateEncoderChart(outcome(rows, shift), expectedIds).ok;

    assert.equal(
      validates(terminals, { state: "none-enabled", stranded: 0, opaque: 0 }),
      true,
      "the backend's unassigned tuple remains valid",
    );

    const contradictoryNormalValues = [
      { code: 0, key: "KeyK", label: "KeyK", supported: true },
      { code: 0x0e, key: "KeyK", label: "KeyK", supported: false },
      { code: 0x0e, key: null, label: "KeyK", supported: true },
      { code: 0, key: null, label: "Preserved action", supported: false },
    ];
    for (const normal of contradictoryNormalValues) {
      const rows = terminals.map((row, index) => index === 0 ? { ...row, normal } : row);
      assert.equal(
        validates(rows, { state: "none-enabled", stranded: 0, opaque: 0 }),
        false,
        `the impossible key tuple ${JSON.stringify(normal)} is withheld`,
      );
    }
    const zeroNamedKey = { code: 0, key: "K", label: "K", supported: true };
    const unsupportedNamedKey = {
      code: 0x0e,
      key: "K",
      label: "Preserved action 0x0E",
      supported: false,
    };
    assert.notEqual(encoderEmissionLabel(zeroNamedKey), "K");
    assert.notEqual(encoderEmissionShortLabel(zeroNamedKey), "K");
    assert.notEqual(encoderEmissionLabel(unsupportedNamedKey), "K");
    assert.notEqual(encoderEmissionShortLabel(unsupportedNamedKey), "K");

    const oneShiftedKey = terminals.map((row, index) => index === 0
      ? { ...row, shifted: { code: 0x0e, key: "KeyK", label: "KeyK", supported: true } }
      : index === 1
        ? { ...row, shift_state: "opaque" }
        : row);
    assert.equal(
      validates(oneShiftedKey, { state: "none-enabled", stranded: 1, opaque: 1 }),
      true,
      "none-enabled counts exactly one observable shifted key and one opaque Shift byte",
    );
    assert.equal(
      validates(oneShiftedKey, { state: "none-enabled", stranded: 0, opaque: 1 }),
      false,
      "a lower stranded count cannot hide a reachable shifted key",
    );
    assert.equal(
      validates(oneShiftedKey, { state: "none-enabled", stranded: 1, opaque: 0 }),
      false,
      "a lower opaque count cannot hide an unknown Shift byte",
    );

    const oneEnabledShift = oneShiftedKey.map((row, index) => index === 2
      ? { ...row, shift_state: "enabled", is_shift: true }
      : row);
    const enabledSummary = {
      state: "enabled",
      terminal_id: oneEnabledShift[2].terminal_id,
      terminal_label: oneEnabledShift[2].terminal_label,
      reachable: 1,
    };
    assert.equal(validates(oneEnabledShift, enabledSummary), true);
    assert.equal(
      validates(oneEnabledShift, { ...enabledSummary, reachable: 0 }),
      false,
      "an enabled summary cannot under-report the observable shifted plane",
    );

    const ambiguousShift = oneShiftedKey.map((row, index) => index === 0 || index === 2
      ? { ...row, shift_state: "enabled", is_shift: true }
      : row);
    const enabledIds = [ambiguousShift[0].terminal_id, ambiguousShift[2].terminal_id];
    assert.equal(validates(ambiguousShift, { state: "ambiguous", terminal_ids: enabledIds }), true);
    assert.equal(
      validates(ambiguousShift, { state: "ambiguous", terminal_ids: enabledIds.toReversed() }),
      false,
      "an ambiguous summary preserves the backend's enabled-row order",
    );
  });

  test("signal-observation responses preserve unique-set semantics", () => {
    const valid = {
      ok: true,
      state: "listening",
      generation: 9,
      selector: IPAC,
      remaining_ms: 10_000,
      held: ["ArrowUp"],
      seen: ["ArrowUp", "KeyA"],
      peak: 2,
      events: 4,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: "Exact-device evidence.",
      error: null,
    };
    assert.ok(parseEncoderObservationView(valid));
    assert.equal(
      parseEncoderObservationView({ ...valid, seen: ["ArrowUp", "ArrowUp"] }),
      null,
      "seen is a unique signal set, not an event log",
    );
    assert.equal(
      parseEncoderObservationView({ ...valid, held: ["KeyB"] }),
      null,
      "a held signal must already belong to the seen set",
    );
    assert.equal(
      parseEncoderObservationView({ ...valid, seen: ["ArrowUp", ""] }),
      null,
      "empty signal names never become evidence chips",
    );
  });

  test("every dynamic product board renders its truthful connector grammar without collisions", async () => {
    const page = await openBench();
    await page.addScriptTag({ content: encoderProductSimulationSource });
    for (const expected of ENCODER_RENDER_CASES) {
      const audit = await page.evaluate(async (entry) => {
        const root = document.createElement("div");
        root.dataset.formaCanvas = "";
        Object.assign(root.style, {
          position: "fixed", inset: "0 auto auto 0", width: "960px", height: "900px",
          zIndex: "2147483646", overflow: "hidden", background: "var(--n-bg)",
        });
        const item = document.createElement("article");
        item.className = "widget-instance rd-encoder-device-node";
        Object.assign(item.style, { width: "960px", height: "900px" });
        item.style.setProperty("--widget-min-height", "900px");
        const shell = document.createElement("div");
        shell.className = "rd-encoder-device-shell";
        const backend = entry.id === "unknown-hid"
          ? { role: "panel-encoder", profileState: "unrecognised", capabilities: { canReadChart: false } }
          : {
            role: "panel-encoder",
            visualProfileId: entry.id,
            ...(entry.backendFamilyId ? { familyId: entry.backendFamilyId } : {}),
            profileState: "unprofiled-release",
            ...(entry.reportedCount === null ? {} : { profileTerminalCount: entry.reportedCount }),
            capabilities: { canReadChart: false },
          };
        const surface = window.KsxEncoderProductSimulation.createEncoderWorkbenchSurface(
          document,
          {
            selector: `simulation:${entry.id}`,
            name: `Simulation ${entry.id}`,
            meta: "Deterministic product-render simulation",
            backend,
          },
        );
        shell.append(surface.content);
        item.append(shell);
        root.append(item);
        document.body.append(root);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const svg = root.querySelector(".rd-encoder-product-svg");
        const terminals = [...root.querySelectorAll("[data-terminal-id]")];
        const groups = [...root.querySelectorAll(".rd-encoder-product-group")];
        const board = root.querySelector(".rd-encoder-product-board");
        const chip = root.querySelector(".rd-encoder-product-chip > rect");
        const boardBox = board?.getBoundingClientRect();
        const chipBox = chip?.getBoundingClientRect();
        const rects = terminals.map((terminal) => {
          const target = terminal.querySelector(".rd-encoder-product-terminal-hit");
          const box = target?.getBoundingClientRect();
          const center = box
            ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
              ?.closest("[data-terminal-id]")
            : null;
          return {
            id: terminal.getAttribute("data-terminal-id"),
            left: box?.left ?? 0, right: box?.right ?? 0,
            top: box?.top ?? 0, bottom: box?.bottom ?? 0,
            width: box?.width ?? 0, height: box?.height ?? 0,
            center: center?.getAttribute("data-terminal-id") ?? null,
          };
        });
        const intersects = (left, right, inset = 0.25) =>
          left.left < right.right - inset && left.right > right.left + inset &&
          left.top < right.bottom - inset && left.bottom > right.top + inset;
        const overlaps = [];
        for (let left = 0; left < rects.length; left += 1) {
          for (let right = left + 1; right < rects.length; right += 1) {
            if (intersects(rects[left], rects[right])) {
              overlaps.push(`${rects[left].id}:${rects[right].id}`);
            }
          }
        }
        const chipConflicts = chipBox
          ? rects.filter((rect) => intersects(rect, chipBox)).map((rect) => rect.id)
          : [];
        const interfaceGeometries = [...root.querySelectorAll("[data-interface-geometry]")].map((element) => {
          const box = element.getBoundingClientRect();
          return {
            id: element.getAttribute("data-interface-geometry"),
            left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          };
        });
        const groupLabels = [...root.querySelectorAll(".rd-encoder-product-group-label")].map((element) => {
          const box = element.getBoundingClientRect();
          return {
            id: element.closest("[data-terminal-group]")?.getAttribute("data-terminal-group") ?? "unknown",
            left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          };
        });
        const interfaceChipConflicts = chipBox
          ? interfaceGeometries.filter((geometry) => intersects(geometry, chipBox)).map((geometry) => geometry.id)
          : [];
        const interfaceLabelConflicts = groupLabels.flatMap((label) =>
          interfaceGeometries.filter((geometry) => intersects(label, geometry))
            .map((geometry) => `${label.id}:${geometry.id}`)
        );
        const groupLabelChipConflicts = chipBox
          ? groupLabels.filter((label) => intersects(label, chipBox)).map((label) => label.id)
          : [];
        const groupLabelTerminalConflicts = groupLabels.flatMap((label) =>
          rects.filter((rect) => intersects(label, rect))
            .map((rect) => `${label.id}:${rect.id}`)
        );
        const outOfBoard = boardBox
          ? rects.filter((rect) => rect.left < boardBox.left - 0.5 || rect.right > boardBox.right + 0.5 ||
              rect.top < boardBox.top - 0.5 || rect.bottom > boardBox.bottom + 0.5)
            .map((rect) => rect.id)
          : [];
        const urlReferences = [...svg.querySelectorAll("[fill^='url(#']")].map((element) => {
          const id = /^url\(#(.+)\)$/.exec(element.getAttribute("fill") ?? "")?.[1] ?? "";
          return { id, resolves: Boolean(svg.querySelector(`[id="${CSS.escape(id)}"]`)) };
        });
        const result = {
          profileId: svg?.getAttribute("data-profile-id"),
          capacity: svg?.getAttribute("data-capacity"),
          confidence: svg?.getAttribute("data-capacity-source"),
          visualKind: svg?.getAttribute("data-visual-kind"),
          grammar: svg?.getAttribute("data-interface-grammar"),
          boardKind: board?.classList.contains(`is-${entry.visualKind}`) ?? false,
          terminalCount: terminals.length,
          uniqueIds: new Set(terminals.map((terminal) => terminal.getAttribute("data-terminal-id"))).size,
          groupCounts: groups.map((group) => group.querySelectorAll("[data-terminal-id]").length),
          physical: terminals.filter((terminal) =>
            terminal.getAttribute("data-identity-scope") === "physical-terminal").length,
          logical: terminals.filter((terminal) =>
            terminal.getAttribute("data-identity-scope") === "logical-control").length,
          variant: terminals.filter((terminal) => terminal.getAttribute("data-presence") === "variant-only").length,
          screwFaces: root.querySelectorAll(".rd-encoder-product-terminal-screw").length,
          harnessFaces: root.querySelectorAll(".rd-encoder-product-terminal-socket").length,
          logicalFaces: root.querySelectorAll(".rd-encoder-product-terminal-logical-node").length,
          jammaFaces: root.querySelectorAll(".rd-encoder-product-terminal-edge").length,
          opticalMarkers: root.querySelectorAll(".rd-encoder-product-terminal-optical").length,
          harnessInterfaces: [...root.querySelectorAll("[data-harness-interface]")]
            .map((element) => element.getAttribute("data-harness-interface")),
          auxiliaryInterfaces: [...root.querySelectorAll("[data-auxiliary-interface]")]
            .map((element) => element.getAttribute("data-auxiliary-interface")),
          interfaceGeometries: interfaceGeometries.map((geometry) => geometry.id),
          motifCount: root.querySelectorAll("[data-interface-motif]").length,
          roving: root.querySelectorAll('[data-terminal-id][tabindex="0"]').length,
          readActions: root.querySelectorAll("[data-rd-encoder-read]").length,
          buttonTests: root.querySelectorAll('[data-rd-encoder-observe="start"]').length,
          minimumWidth: rects.length ? Math.min(...rects.map((rect) => rect.width)) : null,
          minimumHeight: rects.length ? Math.min(...rects.map((rect) => rect.height)) : null,
          wrongCenters: rects.filter((rect) => rect.center !== rect.id)
            .map((rect) => `${rect.id}->${rect.center ?? "none"}`),
          overlaps,
          chipConflicts,
          interfaceChipConflicts,
          interfaceLabelConflicts,
          groupLabelChipConflicts,
          groupLabelTerminalConflicts,
          outOfBoard,
          brokenUrlReferences: urlReferences.filter((reference) => !reference.resolves),
          svgDefinitionIds: [...svg.querySelectorAll("defs [id]")].map((node) => node.id),
        };
        surface.dispose();
        root.remove();
        return result;
      }, expected);

      const terminalCount = expected.physical + expected.logical;
      assert.equal(audit.profileId, expected.id, `${expected.id} selects the requested visual`);
      assert.equal(audit.capacity, expected.capacity, `${expected.id} rendered capacity`);
      assert.equal(audit.confidence, expected.confidence, `${expected.id} rendered provenance`);
      assert.equal(audit.visualKind, expected.visualKind, `${expected.id} visual kind`);
      assert.equal(audit.grammar, expected.grammar, `${expected.id} interface grammar`);
      assert.equal(audit.boardKind, true, `${expected.id} board class`);
      assert.equal(audit.terminalCount, terminalCount, `${expected.id} complete row count`);
      assert.equal(audit.uniqueIds, terminalCount, `${expected.id} unique row identities`);
      assert.deepEqual(audit.groupCounts, expected.groupCounts, `${expected.id} group geometry`);
      assert.equal(audit.physical, expected.physical, `${expected.id} physical identity count`);
      assert.equal(audit.logical, expected.logical, `${expected.id} logical identity count`);
      assert.equal(audit.variant, expected.variant, `${expected.id} variant identity count`);
      assert.equal(audit.screwFaces, expected.connection === "screw" ? terminalCount : 0,
        `${expected.id} never borrows screw imagery for another connector`);
      assert.equal(audit.harnessFaces, expected.connection === "harness" ? terminalCount : 0,
        `${expected.id} harness channels use keyed sockets`);
      assert.equal(audit.logicalFaces, expected.connection === "logical" ? terminalCount : 0,
        `${expected.id} logical rows remain abstract controls`);
      assert.equal(audit.jammaFaces, expected.connection === "jamma-edge" ? terminalCount : 0);
      assert.equal(audit.opticalMarkers, expected.id === "ultimarc-ultimate-io" ? 6 : 0,
        `${expected.id} marks only published dual-role optical channels`);
      assert.deepEqual(audit.harnessInterfaces, expected.harnessInterfaces,
        `${expected.id} draws only published connector bodies without invented pin counts`);
      assert.deepEqual(audit.auxiliaryInterfaces, expected.auxiliaryInterfaces,
        `${expected.id} keeps distinct non-input interfaces outside the terminal count`);
      assert.deepEqual(audit.interfaceGeometries, expected.interfaceGeometries,
        `${expected.id} exposes every interface geometry to collision simulation`);
      assert.equal(audit.motifCount, expected.id === "unknown-hid" ? 0 : 1,
        `${expected.id} has one board-level interface motif`);
      assert.equal(audit.roving, terminalCount > 0 ? 1 : 0, `${expected.id} roving entry`);
      assert.equal(audit.readActions, 0, `${expected.id} unprofiled simulation never offers chart read`);
      assert.equal(audit.buttonTests, 1, `${expected.id} keeps exact-device button testing`);
      if (terminalCount > 0) {
        assert.ok(audit.minimumWidth >= 44, `${expected.id} ${audit.minimumWidth}px target width`);
        assert.ok(audit.minimumHeight >= 44, `${expected.id} ${audit.minimumHeight}px target height`);
      }
      assert.deepEqual(audit.wrongCenters, [], `${expected.id} owns every target centre`);
      assert.deepEqual(audit.overlaps, [], `${expected.id} has disjoint targets`);
      assert.deepEqual(audit.chipConflicts, [], `${expected.id} terminals clear the processor`);
      assert.deepEqual(audit.interfaceChipConflicts, [], `${expected.id} interface bodies clear the processor`);
      assert.deepEqual(audit.interfaceLabelConflicts, [], `${expected.id} labels clear interface bodies`);
      assert.deepEqual(audit.groupLabelChipConflicts, [], `${expected.id} group labels clear the processor`);
      assert.deepEqual(audit.groupLabelTerminalConflicts, [], `${expected.id} group labels clear terminal targets`);
      assert.deepEqual(audit.outOfBoard, [], `${expected.id} targets stay on the board`);
      assert.deepEqual(audit.brokenUrlReferences, [], `${expected.id} local SVG definitions resolve`);
      assert.equal(new Set(audit.svgDefinitionIds).size, audit.svgDefinitionIds.length,
        `${expected.id} definition ids are unique within the SVG`);
    }

    const radioAudit = await page.evaluate(async () => {
      const root = document.createElement("div");
      root.dataset.formaCanvas = "";
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.zIndex = "2147483646";
      const surfaces = ["a", "b"].map((suffix) =>
        window.KsxEncoderProductSimulation.createEncoderWorkbenchSurface(document, {
          selector: `simulation:minipac:${suffix}`,
          name: `Unresolved Mini-PAC ${suffix.toUpperCase()}`,
          backend: {
            role: "panel-encoder", familyId: "ultimarc-minipac",
            profileState: "unprofiled-release", capabilities: { canReadChart: false },
          },
        })
      );
      surfaces.forEach((surface, index) => {
        const item = document.createElement("article");
        item.className = "widget-instance rd-encoder-device-node";
        item.style.width = "960px";
        item.style.height = "900px";
        item.style.position = "absolute";
        item.style.left = `${index * 980}px`;
        const shell = document.createElement("div");
        shell.className = "rd-encoder-device-shell";
        shell.append(surface.content);
        item.append(shell);
        root.append(item);
      });
      document.body.append(root);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const fieldsets = [...root.querySelectorAll(".rd-encoder-profile-candidates")];
      const names = fieldsets.map((fieldset) => fieldset.querySelector("input")?.getAttribute("name"));
      fieldsets[0]?.querySelector("input")?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = {
        names,
        firstProfile: root.querySelectorAll(".rd-encoder-profile")[0]?.getAttribute("data-profile-id"),
        secondProfile: root.querySelectorAll(".rd-encoder-profile")[1]?.getAttribute("data-profile-id"),
        firstStatus: root.querySelectorAll(".rd-encoder-product-status")[0]?.textContent ?? "",
        secondChecked: root.querySelectorAll(".rd-encoder-profile-candidates")[0]
          ?.querySelectorAll("input:checked").length ?? 0,
      };
      surfaces.forEach((surface) => surface.dispose());
      root.remove();
      return result;
    });
    assert.equal(new Set(radioAudit.names).size, 2, "each Mini-PAC widget owns its radio group");
    assert.equal(radioAudit.firstProfile, "ultimarc-minipac-32");
    assert.match(radioAudit.firstStatus, /user confirmed/i);
    assert.doesNotMatch(radioAudit.firstStatus, /recognized/i,
      "manual variant confirmation is never relabeled as backend recognition");
    assert.equal(radioAudit.secondProfile, "unknown-hid",
      "confirming one board never changes its unresolved twin");
    assert.equal(radioAudit.secondChecked, 0,
      "the unresolved twin retains no cross-widget native selection");
    assert.deepEqual(page.ksxNoise, [], "the complete product simulation remains error-free");
    await closePage(page);
  });

  test("adding a detected encoder creates the product terminal workbench", async () => {
    const productContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
      hasTouch: true,
    });
    const page = await productContext.newPage();
    const noise = [];
    const hardwareCalls = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    page.on("request", (request) => {
      if (/\/api\/(?:panel\/chart|input-test)/.test(new URL(request.url()).pathname)) {
        hardwareCalls.push({ method: request.method(), url: request.url() });
      }
    });
    let observationActive = false;
    const observationGeneration = 501;
    const observationView = (state) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : observationGeneration,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_000 : null,
      held: state === "listening" ? ["K"] : [],
      seen: state === "idle" ? [] : ["K", "H", "E"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 6,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Exact product-device test.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const pathName = new URL(route.request().url()).pathname;
      if (pathName === "/api/input-test/start") {
        observationActive = true;
        await route.fulfill({ status: 200, json: observationView("listening") });
      } else if (pathName === "/api/input-test/cancel") {
        observationActive = false;
        await route.fulfill({ status: 200, json: observationView("cancelled") });
      } else {
        await route.fulfill({
          status: 200,
          json: observationView(observationActive ? "listening" : "idle"),
        });
      }
    });
    await page.route("**/api/panel/chart", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const [terminalId, key, code] of [
        ["1sw1", "E", 0x08],
        ["1sw4", "H", 0x0B],
        ["1sw7", "K", 0x0E],
      ]) {
        const terminal = payload.terminals.find((row) => row.terminal_id === terminalId);
        assert.ok(terminal, `fixture chart contains ${terminalId}`);
        terminal.normal = { code, key, label: key, supported: true };
      }
      const unreachableShift = payload.terminals.find((row) => row.terminal_id === "1sw2");
      assert.ok(unreachableShift);
      unreachableShift.shifted = { code: 0x0E, key: "K", label: "K", supported: true };
      assert.equal(payload.shift.state, "none-enabled");
      payload.shift.stranded += 1;
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
        null,
        { timeout: 20_000 },
      );

      assert.equal(
        await page.locator('[data-nx="rd-encoder-profiles"]').isHidden(),
        true,
        "the internal profile catalog is absent from product chrome",
      );
      await page.click('[data-nx="rd-devs-open"]');
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.keyboard.press("Escape");
      const node = page.locator(
        `.forma-canvas-stage > .rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`,
      );
      await node.waitFor({ state: "attached" });
      assert.equal(
        await node.getAttribute("aria-current"),
        "true",
        "the visible Add gesture selects and reveals the encoder it created",
      );
      assert.deepEqual(
        await node.evaluate((item) => {
          const geometry = (candidate) => ({
            id: candidate.dataset.instanceId,
            x: Number(candidate.dataset.canvasX),
            y: Number(candidate.dataset.canvasY),
            width: Number(candidate.dataset.canvasWidth),
            height: Number(candidate.dataset.canvasHeight),
          });
          const target = geometry(item);
          return Array.from(
            item.parentElement?.querySelectorAll(":scope > [data-instance-id][data-canvas-x]") ?? [],
          ).filter((candidate) => candidate !== item)
            .map(geometry)
            .filter((candidate) =>
              target.x < candidate.x + candidate.width &&
              target.x + target.width > candidate.x &&
              target.y < candidate.y + candidate.height &&
              target.y + target.height > candidate.y
            )
            .map((candidate) => candidate.id);
        }),
        [],
        "a fresh encoder lands beside the keyboard and controllers, never beneath them",
      );
      assert.equal(await node.getAttribute("data-selector"), IPAC);
      assert.equal(await node.getAttribute("data-canvas-width"), "960");
      assert.ok(Number(await node.getAttribute("data-canvas-height")) >= 760);
      assert.equal(await node.locator("[data-rd-encoder-model]").count(), 0);
      assert.doesNotMatch(await node.textContent(), /profile or evidence case|research-backed preview/i);
      assert.match(await node.textContent(), /connected/i);
      assert.match(await node.textContent(), /recognized/i);
      assert.match(await node.textContent(), /56 inputs/i);
      assert.equal(await node.locator("[data-terminal-id]").count(), 56);
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
      const productSurface = node.locator('.rd-encoder-profile[data-presentation="product"]');
      const board = productSurface.locator(
        '.rd-encoder-product-svg[data-capacity="56"][data-interactive="true"]',
      );
      assert.equal(await board.count(), 1, "the known-device surface keeps one complete interactive board");
      assert.equal(
        await node.locator('[data-rd-encoder-terminal-inspector]').getAttribute("data-layout"),
        "strip",
        "terminal context is one compact horizontal strip beneath the board",
      );
      const actionDock = node.locator('.rd-encoder-product-actions[data-layout="dock"]');
      assert.equal(await actionDock.count(), 1, "stored reads and button tests share one cohesive action dock");
      assert.equal(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
        true,
        "this product audit exercises the coarse-pointer target rules",
      );
      assert.deepEqual(
        await actionDock.locator(".rd-encoder-command-help > summary").evaluateAll((summaries) =>
          summaries.map((summary) => Number.parseFloat(getComputedStyle(summary).minHeight) >= 44)
        ),
        [true, true],
        "both optional-guidance disclosures keep 44px coarse-pointer targets",
      );
      assert.equal(
        await actionDock.locator('[data-rd-encoder-read][data-rd-encoder-inspector-read]').count(),
        1,
        "one action owns both the dock and inspector stored-assignment contracts",
      );
      assert.equal(
        await node.locator('[data-rd-encoder-read], [data-rd-encoder-inspector-read]').count(),
        1,
        "the streamlined surface never duplicates its stored-assignment action",
      );
      const nextNotice = node.locator(".rd-encoder-product-next");
      assert.equal(
        await nextNotice.count(),
        1,
        "the future controller-assignment handoff appears once",
      );
      assert.ok(
        await node.locator(".rd-encoder-product-status > .rd-encoder-product-pill").count() <= 2,
        "the healthy connected state needs at most two status pills",
      );
      const details = node.locator(".rd-encoder-product-details");
      const technical = details.locator(".rd-encoder-product-technical");
      const roster = technical.locator(".rd-encoder-profile-roster");
      assert.equal(await details.getAttribute("open"), null, "device facts are closed by default");
      assert.equal(await technical.getAttribute("open"), null, "technical evidence is closed by default");
      assert.equal(await roster.getAttribute("open"), null, "the complete terminal roster is closed by default");
      assert.equal(
        hardwareCalls.filter((call) => /\/api\/panel\/chart/.test(call.url)).length,
        1,
        "adding the recognized encoder automatically reads its stored chart once",
      );
      assert.equal(await node.locator("[data-terminal-id][data-configured-emission]").count(), 56);
      assert.equal(await node.locator('[data-terminal-id="1sw1"][data-configured-key="E"]').count(), 1);
      assert.equal(await node.locator('[data-terminal-id="1sw4"][data-configured-key="H"]').count(), 1);
      assert.equal(await node.locator('[data-terminal-id="1sw7"][data-configured-key="K"]').count(), 1);
      assert.equal(
        await node.locator('[data-terminal-id="1sw2"][data-configured-shift-key=""]').count(),
        1,
        "a shifted value is not treated as reachable when the chart reports no enabled Shift",
      );
      assert.doesNotMatch(await node.textContent(), /chart not read yet/i);
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /chart not read yet/i,
        "the hidden picker does not retain stale pre-read copy after hydration",
      );
      assert.doesNotMatch(
        await node.locator('[data-rd-encoder-terminal-inspector]').textContent(),
        /configured key\s*read keys/i,
      );
      assert.equal(
        await node.locator('[data-terminal-id][tabindex="0"]').count(),
        1,
        "the board exposes one roving keyboard entry point",
      );
      await node.focus();
      await page.getByRole("button", { name: "Pan it to the middle (C)", exact: true })
        .evaluate((button) => button.click());
      await page.locator('[data-nx="rd-z-100"]').evaluate((button) => button.click());
      await page.waitForFunction(
        () => document.querySelector(".n-zoomval")?.textContent?.trim() === "100%" &&
          !document.querySelector(".is-camera-animating"),
      );
      assert.equal(
        await page.locator(".forma-canvas-viewport").getAttribute("data-canvas-zoom-tier"),
        "editing",
        "rendered target QA runs at the canvas's editing-distance 100% zoom",
      );
      assert.equal(await nextNotice.isVisible(), true, "the one handoff notice remains visible while editing");
      assert.ok(
        await nextNotice.evaluate((element) => element.getBoundingClientRect().height) >= 16,
        "the product grid reserves a real footer row for the handoff notice",
      );
      const hitAudit = await node.locator(".rd-encoder-product-terminal-hit").evaluateAll(
        (targets) => {
          const entries = targets.map((target) => {
            const terminal = target.closest("[data-terminal-id]");
            const box = target.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;
            const hit = document.elementFromPoint(centerX, centerY)?.closest("[data-terminal-id]");
            return {
              id: terminal?.getAttribute("data-terminal-id") ?? "",
              centerHit: hit?.getAttribute("data-terminal-id") ?? "",
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
          });
          const overlaps = [];
          for (let left = 0; left < entries.length; left += 1) {
            for (let right = left + 1; right < entries.length; right += 1) {
              const a = entries[left];
              const b = entries[right];
              if (a.left < b.right - 0.25 && a.right > b.left + 0.25 &&
                  a.top < b.bottom - 0.25 && a.bottom > b.top + 0.25) {
                overlaps.push(`${a.id}:${b.id}`);
              }
            }
          }
          return {
            count: entries.length,
            undersized: entries.filter((entry) => entry.width < 44 || entry.height < 44)
              .map((entry) => `${entry.id}:${entry.width.toFixed(2)}x${entry.height.toFixed(2)}`),
            wrongCenters: entries.filter((entry) => entry.centerHit !== entry.id)
              .map((entry) => `${entry.id}->${entry.centerHit || "none"}`),
            overlaps,
          };
        },
      );
      assert.deepEqual(
        hitAudit,
        { count: 56, undersized: [], wrongCenters: [], overlaps: [] },
        "all rendered terminal targets are at least 44 CSS px, disjoint, and own their centre hit",
      );
      const firstTerminal = node.locator('[data-terminal-id="1up"]');
      await firstTerminal.focus();
      await firstTerminal.press("ArrowRight");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-terminal-id") === "1down",
      );
      assert.equal(
        await node.locator('[data-rd-encoder-terminal-inspector][data-selected-terminal-id="1down"]').count(),
        1,
        "arrow navigation selects the corresponding terminal inspector",
      );
      assert.equal(
        await node.locator('[data-rd-encoder-terminal-inspector]').getAttribute("data-selected-terminal-id"),
        "1down",
      );
      await page.keyboard.press("Escape");
      assert.equal(await node.evaluate((item) => document.activeElement === item), true);
      await node.press("F2");
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-terminal-id") === "1down",
      );
      const priorAttention = await node.evaluate((item) => ({
        scale: item.getAttribute("data-attention-scale"),
        cssScale: item.style.getPropertyValue("--widget-attention-scale"),
      }));
      await node.evaluate((item) => {
        item.dataset.attentionScale = "0.89";
        item.style.setProperty("--widget-attention-scale", "0.89");
      });
      await page.waitForFunction((id) => {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        const host = item?.querySelector('.rd-encoder-profile[data-presentation="product"] .rd-encoder-profile-host');
        return item?.getAttribute("data-encoder-editable") === "false" && host?.inert === true;
      }, IPAC_SLUG);
      assert.equal(
        await node.locator('.rd-encoder-profile[data-presentation="product"] .rd-encoder-profile-host')
          .getAttribute("aria-hidden"),
        "true",
        "a sub-boundary schematic is visible but unavailable to pointer and keyboard routing",
      );
      await node.evaluate((item) => {
        item.dataset.attentionScale = "0.9";
        item.style.setProperty("--widget-attention-scale", "0.9");
      });
      await page.waitForFunction((id) => {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        const host = item?.querySelector('.rd-encoder-profile[data-presentation="product"] .rd-encoder-profile-host');
        return item?.getAttribute("data-encoder-editable") === "true" && host?.inert === false;
      }, IPAC_SLUG);
      assert.ok(
        await node.locator(".rd-encoder-product-terminal-hit").evaluateAll((targets) =>
          Math.min(...targets.flatMap((target) => {
            const box = target.getBoundingClientRect();
            return [box.width, box.height];
          }))
        ) >= 44,
        "the exact editing boundary admits controls only after every target clears 44px",
      );
      await node.evaluate((item, previous) => {
        if (previous.scale === null) delete item.dataset.attentionScale;
        else item.dataset.attentionScale = previous.scale;
        if (previous.cssScale) item.style.setProperty("--widget-attention-scale", previous.cssScale);
        else item.style.removeProperty("--widget-attention-scale");
      }, priorAttention);
      await page.waitForFunction(
        (id) => document.querySelector(`[data-instance-id="${id}"]`)
          ?.getAttribute("data-encoder-editable") === "true",
        IPAC_SLUG,
      );

      // The engine's supported minimum manual scale is exactly 60%. F2 must
      // cross the editing boundary even with floating-point multiplication,
      // then restore real (not merely present) terminal controls.
      for (let step = 0; step < 4; step += 1) {
        await page.getByRole("button", { name: "Smaller", exact: true }).click();
      }
      assert.equal(await node.getAttribute("data-canvas-manual-scale"), "0.6");
      await node.focus();
      await node.press("F2");
      await page.waitForFunction((id) => {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        const host = item?.querySelector(
          '.rd-encoder-profile[data-presentation="product"] .rd-encoder-profile-host',
        );
        return item?.getAttribute("data-encoder-editable") === "true" && host?.inert === false;
      }, IPAC_SLUG);
      assert.ok(
        await page.evaluate((id) => {
          const item = document.querySelector(`[data-instance-id="${id}"]`);
          const viewport = document.querySelector(".forma-canvas-viewport");
          return Number(item?.getAttribute("data-canvas-manual-scale")) *
            Number(viewport?.style.getPropertyValue("--canvas-zoom")) > 0.9;
        }, IPAC_SLUG),
        "minimum-scale entry keeps a positive safety margin above the 44px boundary",
      );
      await page.getByRole("button", { name: "Reset size", exact: true }).click();
      await page.locator('[data-nx="rd-z-100"]').evaluate((button) => button.click());

      const testHelp = node.locator(
        'details[data-rd-encoder-disclosure="test-help"]',
      );
      await testHelp.locator(":scope > summary").click();
      assert.equal(await testHelp.getAttribute("open"), "", "optional guidance opens on demand");
      const start = node.getByRole("button", { name: "Start button test" });
      await start.click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(
        await node.locator('details[data-rd-encoder-disclosure="test-help"]').getAttribute("open"),
        "",
        "a live-state repaint preserves the user-opened guidance disclosure",
      );
      const sink = node.locator("[data-rd-encoder-observation-sink]");
      await page.waitForFunction(
        (id) => document.activeElement === document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation-sink]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await start.isDisabled(), true, "the active test keeps Start disabled");
      assert.equal(await node.locator('[data-terminal-id="1sw7"].is-held').count(), 1);
      assert.equal(await node.locator('[data-terminal-id="1sw4"].is-seen').count(), 1);
      assert.equal(await node.locator('[data-terminal-id="1sw1"].is-seen').count(), 1);
      assert.equal(
        await node.locator('[data-terminal-id="1sw2"].is-held, [data-terminal-id="1sw2"].is-seen').count(),
        0,
        "an unreachable shifted K never borrows the live state of the real K terminal",
      );
      await sink.press("Escape");
      await page.waitForFunction(
        ({ id, terminalId }) => {
          const item = document.querySelector(`[data-instance-id="${id}"]`);
          return document.activeElement === item ||
            document.activeElement?.getAttribute("data-terminal-id") === terminalId;
        },
        { id: IPAC_SLUG, terminalId: "1down" },
      );
      assert.deepEqual(
        await node.evaluate((item) => ({
          onSelectedTerminal: document.activeElement?.getAttribute("data-terminal-id") === "1down",
          onWidget: document.activeElement === item,
          onDisabledStart: document.activeElement?.matches('[data-rd-encoder-observe="start"]') ?? false,
        })),
        { onSelectedTerminal: true, onWidget: false, onDisabledStart: false },
        "Escape leaves capture on the selected terminal, never on disabled Start",
      );
      assert.equal(
        await node.locator('[data-rd-encoder-observation][data-state="listening"]').count(),
        1,
        "Escape releases keyboard capture without silently ending the button test",
      );
      await node.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="complete"]`,
        ),
        IPAC_SLUG,
      );

      await details.locator(":scope > summary").click();
      assert.deepEqual(
        await details.locator("[data-device-fact]").evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-device-fact"))
        ),
        ["device", "connection", "detected-model", "inputs", "assignments"],
        "the compact disclosure preserves every user-facing device fact",
      );
      assert.equal(
        await details.locator("[data-device-fact]").evaluateAll((rows) =>
          rows.every((row) => row.getClientRects().length > 0)
        ),
        true,
        "opening Device details makes every device fact reachable",
      );
      assert.equal(await technical.getAttribute("open"), null, "technical evidence remains nested and closed");
      await technical.locator(":scope > summary").click();
      const selectorFact = technical.locator(".rd-encoder-profile-fact").filter({
        hasText: "Exact selector",
      });
      assert.equal(await selectorFact.count(), 1);
      assert.equal(await selectorFact.isVisible(), true, "the exact backend selector is reachable on demand");
      assert.match(await selectorFact.textContent(), new RegExp(IPAC, "i"));
      assert.equal(
        await roster.locator(":scope > summary").isVisible(),
        true,
        "the complete terminal roster is reachable inside Technical evidence",
      );
      await roster.locator(":scope > summary").click();
      assert.equal(await roster.locator("[data-rd-encoder-chart-row]").count(), 56);
      assert.equal(
        await roster.locator("[data-rd-encoder-chart-row]").first().isVisible(),
        true,
        "expanding the roster reveals the measured terminal assignments",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      await page.waitForFunction((id) => {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        return ["device-details", "technical-evidence", "terminal-roster"].every((key) =>
          item?.querySelector(`details[data-rd-encoder-disclosure="${key}"]`)?.open
        );
      }, IPAC_SLUG);
      assert.ok(
        await nextNotice.evaluate((element) => element.getBoundingClientRect().height) >= 16,
        "expanded evidence stays in the scrolling host and never collapses the fixed handoff footer",
      );

      const canvasViewport = page.locator(".forma-canvas-viewport");
      for (const targetTier of ["structure", "overview"]) {
        const preset = targetTier === "structure" ? "rd-z-75" : "rd-z-25";
        await page.locator(`[data-nx="${preset}"]`).evaluate((button) => button.click());
        await page.waitForFunction(
          (tier) => document.querySelector(".forma-canvas-viewport")
            ?.getAttribute("data-canvas-zoom-tier") === tier &&
            !document.querySelector(".is-camera-animating"),
          targetTier,
        );
        assert.equal(
          await canvasViewport.getAttribute("data-canvas-zoom-tier"),
          targetTier,
          `the camera reaches the ${targetTier} semantic tier`,
        );
        await node.focus();
        const interactionAudit = await productSurface.evaluate((surface) => {
          const selector = [
            "button:not(:disabled)",
            "input:not(:disabled)",
            "textarea:not(:disabled)",
            "select:not(:disabled)",
            "a[href]",
            "summary",
            "[data-terminal-id][tabindex]",
          ].join(", ");
          const controls = Array.from(surface.querySelectorAll(selector));
          const item = surface.closest("[data-instance-id]");
          const label = (control) =>
            control.getAttribute("data-terminal-id") ??
            control.getAttribute("data-rd-encoder-observe") ??
            control.textContent?.trim().slice(0, 48) ??
            control.tagName;
          const pointerHits = [];
          let pointerProbes = 0;
          for (const control of controls) {
            const box = control.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;
            if (box.width <= 0 || box.height <= 0 || centerX < 0 || centerY < 0 ||
                centerX >= window.innerWidth || centerY >= window.innerHeight) continue;
            pointerProbes += 1;
            const hit = document.elementFromPoint(centerX, centerY)?.closest(selector);
            if (hit && surface.contains(hit)) pointerHits.push(label(hit));
          }
          const focusHits = [];
          for (const control of controls) {
            item?.focus({ preventScroll: true });
            control.focus?.({ preventScroll: true });
            if (document.activeElement === control) focusHits.push(label(control));
          }
          item?.focus({ preventScroll: true });
          return {
            controlCount: controls.length,
            pointerProbes,
            pointerHits: [...new Set(pointerHits)],
            focusHits,
          };
        });
        assert.ok(interactionAudit.controlCount > 0, `${targetTier} still contains encoder semantics`);
        assert.ok(interactionAudit.pointerProbes > 0, `${targetTier} probes visible encoder geometry`);
        assert.deepEqual(
          interactionAudit.pointerHits,
          [],
          `${targetTier} encoder controls are not pointer targets`,
        );
        assert.deepEqual(
          interactionAudit.focusHits,
          [],
          `${targetTier} encoder controls cannot retain keyboard focus`,
        );
      }
      assert.deepEqual(noise, [], "the product encoder stays error-free");
    } finally {
      await closeContext(productContext);
    }
  });

  test("a failed stored-assignment read keeps live K/H/E unassigned and offers a real retry", async () => {
    const failureContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    const page = await failureContext.newPage();
    const noise = [];
    let chartReads = 0;
    let observationActive = false;
    let releaseRetryChart;
    let reportRetryChart;
    const retryChartGate = new Promise((resolve) => { releaseRetryChart = resolve; });
    const retryChartSeen = new Promise((resolve) => { reportRetryChart = resolve; });
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    await page.route("**/api/panel/chart", async (route) => {
      chartReads += 1;
      if (chartReads === 2) {
        reportRetryChart(route.request().postDataJSON());
        await retryChartGate;
      }
      await route.fulfill({
        status: 200,
        json: {
          ok: false,
          error: "The encoder did not return a stable chart.",
          remedy: "Reconnect it and retry the stored-assignment read.",
        },
      });
    });
    const observationView = (state) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : 551,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_000 : null,
      held: state === "listening" ? ["K"] : [],
      seen: state === "idle" ? [] : ["K", "H", "E"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 6,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Exact device signals only.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const pathName = new URL(route.request().url()).pathname;
      if (pathName === "/api/input-test/start") observationActive = true;
      if (pathName === "/api/input-test/cancel") observationActive = false;
      await route.fulfill({
        status: 200,
        json: observationView(observationActive ? "listening" :
          pathName === "/api/input-test/cancel" ? "cancelled" : "idle"),
      });
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.click('[data-nx="rd-devs-open"]');
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.keyboard.press("Escape");
      const node = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`);
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="error"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(chartReads, 1, "adding the encoder makes one automatic, read-only chart attempt");
      const retry = node.getByRole("button", { name: "Retry stored-assignment read" });
      assert.equal(await retry.count(), 1, "the inspector exposes a genuine retry button");
      assert.equal(await retry.evaluate((element) => element.tagName), "BUTTON");
      assert.equal(await retry.isEnabled(), true);
      assert.equal(await node.locator("[data-configured-emission]").count(), 0);
      assert.equal(await node.locator("[data-configured-key]").count(), 0);

      await retry.focus();
      await retry.click();
      assert.deepEqual(await retryChartSeen, { selector: IPAC });
      assert.equal(
        await node.locator("[data-rd-encoder-status]").evaluate((element) =>
          document.activeElement === element),
        true,
        "the durable status target owns focus while the inspector is repainted",
      );
      releaseRetryChart();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="error"]`,
        ),
        IPAC_SLUG,
      );
      await page.waitForFunction(
        (id) => document.activeElement === document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-inspector-read]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(chartReads, 2, "Retry performs exactly one new read and restores its focus target");

      await node.getByRole("button", { name: "Start button test" }).click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_SLUG,
      );
      assert.deepEqual(
        await node.locator("[data-rd-encoder-observed-seen] code").allTextContents(),
        ["K", "H", "E"],
        "live signals remain visible even when terminal association is unavailable",
      );
      assert.equal(
        await node.locator("[data-terminal-id].is-held, [data-terminal-id].is-seen").count(),
        0,
        "Button Test never invents terminal ownership without a valid stored-key chart",
      );
      assert.deepEqual(noise, []);
    } finally {
      releaseRetryChart?.();
      await closeContext(failureContext);
    }
  });

  test("an unrecognized encoder builds from declared labels without inventing terminals", async () => {
    const genericContext = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      colorScheme: "dark",
    });
    const page = await genericContext.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const encoder = payload.devices.encoders.find((row) => row.selector === IPAC);
      assert.ok(encoder);
      Object.assign(encoder, {
        name: "Cabinet HID encoder",
        meta: "USB · Connected · model not recognized",
        family_id: null,
        protocol_profile: null,
        profile_state: "unrecognised",
        terminal_count: null,
        chart_readable: "false",
      });
      await route.fulfill({ response, json: payload });
    });
    let observationActive = false;
    const observationView = (state) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : 581,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_000 : null,
      held: [],
      seen: state === "idle" ? [] : ["K"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 1,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Generic-draft fixture.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const pathName = new URL(route.request().url()).pathname;
      if (pathName === "/api/input-test/start") observationActive = true;
      if (pathName === "/api/input-test/cancel") observationActive = false;
      await route.fulfill({
        status: 200,
        json: observationView(observationActive ? "listening" :
          pathName === "/api/input-test/cancel" ? "cancelled" : "idle"),
      });
    });
    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
        null,
        { timeout: 20_000 },
      );
      // Initial HTML carries the fixture's normal roster. A theme mutation
      // performs the live `/api/redesign` repaint this test has overridden.
      await page.click(".rd-setupd > .rd-setup-sum");
      await page.click(".rd-theme-compact-home .rd-theme-compact-sum");
      await page.click(
        '.rd-thememenu-compact form:has(input[value="light"]) button',
      );
      await page.waitForFunction(
        (selector) => document.querySelector(
          `.rd-devmodal button[data-selector="${selector}"] .n-dev-name`,
        )?.textContent === "Cabinet HID encoder",
        IPAC,
      );
      await page.click('[data-nx="rd-devs-open"]');
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.keyboard.press("Escape");
      const node = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`);
      await node.focus();
      await node.press("F2");
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")
          ?.getAttribute("data-canvas-zoom-tier") === "editing",
      );
      assert.equal(await node.locator("[data-terminal-id]").count(), 0);
      assert.match(await node.textContent(), /generic setup/i);
      assert.match(await node.textContent(), /capacity unknown/i);
      assert.equal(await node.getByRole("button", { name: "Read stored assignments" }).count(), 0);
      assert.equal(await node.getByRole("button", { name: "Start button test" }).count(), 1);
      const labels = node.locator("[data-rd-encoder-manual-labels]");
      const draft = "P1 UP, P1 FIRE, COIN";
      await labels.fill(draft);
      await labels.evaluate((input) => {
        input.focus();
        input.setSelectionRange(7, 7);
        window.dispatchEvent(new Event("pageshow"));
      });
      assert.deepEqual(
        await labels.evaluate((input) => ({
          value: input.value,
          focused: document.activeElement === input,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        })),
        { value: draft, focused: true, selectionStart: 7, selectionEnd: 7 },
        "an unrelated surface repaint preserves the exact generic draft and caret",
      );
      await node.getByRole("button", { name: "Start button test" })
        .evaluate((button) => button.click());
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await labels.inputValue(), draft, "Button Test does not erase the unbuilt draft");
      await node.getByRole("button", { name: "Done", exact: true }).click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="complete"]`,
        ),
        IPAC_SLUG,
      );
      await node.getByRole("button", { name: "Build control list" }).click();
      assert.equal(await node.locator("[data-declared-terminal-id]").count(), 3);
      assert.equal(
        await node.locator("[data-terminal-id]").count(),
        0,
        "declared controls never masquerade as discovered hardware terminals",
      );
      assert.deepEqual(noise, []);
    } finally {
      // A theme mutation can leave the intercepted authority refresh in flight.
      // Plain `unroute` returns immediately, so closing the page can race the
      // handler's eventual `fulfill` and surface as an unhandled rejection on
      // slower CI runners. Drain the handler before this test yields the page.
      await page.unrouteAll({ behavior: "wait" });
      await closeContext(genericContext);
    }
  });

  test("product encoder clears transient Reading and Listening UI across page lifecycle", async () => {
    const lifecycleContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    const page = await lifecycleContext.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    let releaseManualChart;
    let reportManualChart;
    const chartBodies = [];
    const manualChartGate = new Promise((resolve) => { releaseManualChart = resolve; });
    const manualChartSeen = new Promise((resolve) => { reportManualChart = resolve; });
    await page.route("**/api/panel/chart", async (route) => {
      chartBodies.push(route.request().postDataJSON());
      if (chartBodies.length === 2) {
        reportManualChart(route.request().postDataJSON());
        await manualChartGate;
      }
      await route.continue();
    });
    let observationActive = false;
    const observationGeneration = 601;
    const inputCalls = [];
    const observationView = (state, selector = IPAC) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : observationGeneration,
      selector: state === "idle" ? null : selector,
      remaining_ms: state === "listening" ? 28_500 : null,
      held: state === "listening" ? ["ArrowUp"] : [],
      seen: state === "idle" ? [] : ["ArrowUp"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 2,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Lifecycle fixture.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      inputCalls.push({ path: pathName, body });
      if (pathName === "/api/input-test/start") {
        observationActive = true;
        await route.fulfill({ status: 200, json: observationView("listening") });
      } else if (pathName === "/api/input-test/cancel") {
        observationActive = false;
        await route.fulfill({ status: 200, json: observationView("cancelled") });
      } else {
        await route.fulfill({
          status: 200,
          json: observationView(observationActive ? "listening" : "idle"),
        });
      }
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.click('[data-nx="rd-devs-open"]');
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.keyboard.press("Escape");
      const node = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`);
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
      assert.deepEqual(chartBodies, [{ selector: IPAC }], "the Add gesture performs one initial read");
      const refresh = node.getByRole("button", { name: "Refresh stored assignments" });
      await refresh.focus();
      await refresh.click();
      assert.deepEqual(await manualChartSeen, { selector: IPAC });
      assert.equal(
        await node.locator('[data-rd-encoder-chart][data-state="loading"]').count(),
        1,
      );
      assert.equal(
        await node.locator("[data-rd-encoder-status]").evaluate((element) =>
          document.activeElement === element),
        true,
        "the durable live target owns focus while the manual read repaints",
      );
      assert.match(await node.textContent(), /Reading this board/i);

      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="idle"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(
        await node.locator("[data-rd-encoder-read]").isDisabled(),
        true,
        "BFCache restore clears stale Reading UI but keeps the unfinished hardware lane closed",
      );
      assert.match(await node.locator(".rd-encoder-product-actions").textContent(), /read is still settling/i);
      assert.doesNotMatch(await node.textContent(), /Reading this board/i);
      await page.waitForFunction(
        (id) => document.activeElement === document.querySelector(
          `.forma-canvas-stage > [data-instance-id="${id}"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(
        await node.evaluate((item) => document.activeElement === item),
        true,
        "BFCache returns focus to the visible canvas object while its read button is settling",
      );
      await page.waitForTimeout(50);
      assert.deepEqual(
        chartBodies,
        [{ selector: IPAC }, { selector: IPAC }],
        "pageshow never turns an interrupted manual read into a page-load hardware action",
      );
      const staleChartResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/panel/chart"
      );
      releaseManualChart();
      await staleChartResponse;
      await page.waitForFunction(
        (id) => !document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-read]`,
        )?.disabled,
        IPAC_SLUG,
      );
      assert.equal(
        await node.locator('[data-rd-encoder-chart][data-state="idle"]').count(),
        1,
        "the late pre-pagehide response is discarded without an implicit retry",
      );
      assert.equal(await node.locator("[data-configured-emission]").count(), 0);
      assert.deepEqual(
        chartBodies,
        [{ selector: IPAC }, { selector: IPAC }],
        "the user can explicitly read again after the stale transaction settles",
      );

      await node.getByRole("button", { name: "Start button test" }).click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_SLUG,
      );
      assert.match(await node.textContent(), /Listening/i);
      const cancelSeen = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/input-test/cancel" &&
        request.postDataJSON()?.generation === observationGeneration
      );
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await cancelSeen;
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="idle"]`,
        ),
        IPAC_SLUG,
      );
      await page.waitForFunction(
        (id) => !document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observe="start"]`,
        )?.disabled,
        IPAC_SLUG,
      );
      assert.equal(
        await node.getByRole("button", { name: "Start button test" }).isEnabled(),
        true,
      );
      assert.equal(await node.getByRole("button", { name: "Done", exact: true }).count(), 0);
      assert.doesNotMatch(await node.textContent(), /Listening\s*(?:·|$)/i);
      assert.deepEqual(
        inputCalls.filter((call) => call.path === "/api/input-test/cancel").map((call) => call.body),
        [{ generation: observationGeneration }],
        "pagehide releases only the exact active product observation",
      );
      assert.deepEqual(noise, []);
    } finally {
      releaseManualChart?.();
      await closeContext(lifecycleContext);
    }
  });

  test("a non-authoritative scan preserves product results but pauses new hardware actions", async () => {
    const authorityContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    const page = await authorityContext.newPage();
    const noise = [];
    const hardwareCalls = [];
    let authoritative = true;
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    page.on("request", (request) => {
      const pathName = new URL(request.url()).pathname;
      if (/^\/api\/(?:panel\/chart|input-test)/.test(pathName)) {
        hardwareCalls.push({ path: pathName, method: request.method() });
      }
    });
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (!authoritative) {
        payload.devices.scan_authoritative = false;
        payload.devices.scan_line = "Device scan unavailable — retain last confirmed results.";
        for (const tier of ["keyboards", "encoders", "experimental", "other"]) {
          payload.devices[tier] = [];
        }
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route("**/api/input-test**", async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          state: "idle",
          generation: null,
          selector: null,
          remaining_ms: null,
          held: [],
          seen: [],
          peak: 0,
          events: 0,
          dropped: 0,
          rollover_visibility: "unavailable",
          detail: "No observation is active.",
          error: null,
        },
      });
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.click('[data-nx="rd-devs-open"]');
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.keyboard.press("Escape");
      const node = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`);
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await node.locator("[data-configured-emission]").count(), 56);
      const beforeUnknown = hardwareCalls.length;

      authoritative = false;
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="matrix"]) button');
      await page.waitForFunction(
        (id) => document.querySelector(`[data-instance-id="${id}"]`)?.dataset
          .scanAuthoritative === "false",
        IPAC_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await node.count(), 1, "an unanswered scan does not remove the encoder");
      assert.equal(
        await node.locator('.rd-encoder-profile[data-presentation="product"]')
          .getAttribute("data-connection-confirmed"),
        "false",
      );
      assert.match(await node.locator(".rd-encoder-product-status").textContent(), /connection unconfirmed/i);
      assert.match(
        await node.locator('[data-device-fact="connection"] dd').textContent(),
        /unconfirmed.*latest device scan did not answer/i,
      );
      assert.equal(
        await node.locator('[data-rd-encoder-chart][data-state="loaded"]').count(),
        1,
        "the last explicit result stays available",
      );
      assert.equal(await node.locator("[data-configured-emission]").count(), 56);
      const read = node.locator("[data-rd-encoder-read]");
      const start = node.locator('[data-rd-encoder-observe="start"]');
      assert.deepEqual(
        {
          readDisabled: await read.isDisabled(),
          readLabel: await read.textContent(),
          testDisabled: await start.isDisabled(),
          testLabel: await start.textContent(),
        },
        {
          readDisabled: true,
          readLabel: "Wait for device",
          testDisabled: true,
          testLabel: "Wait for device",
        },
      );
      assert.match(
        await node.locator(".rd-encoder-product-actions").textContent(),
        /existing results stay visible.*confirmed scan/i,
      );
      assert.equal(hardwareCalls.length, beforeUnknown, "a refused scan starts no new hardware work");
      assert.deepEqual(noise, []);
    } finally {
      authoritative = true;
      await page.unrouteAll({ behavior: "wait" });
      await closeContext(authorityContext);
    }
  });

  test("two product encoders retain one hardware-action lease through abandoned requests", async () => {
    const leaseContext = await browser.newContext({
      viewport: { width: 1800, height: 1100 },
      colorScheme: "dark",
    });
    const page = await leaseContext.newPage();
    const noise = [];
    const chartBodies = [];
    const inputCalls = [];
    // Keep this browser-only hardware-lease fixture independent from whatever
    // staged roster an earlier test left in the shared daemon.
    const stagedEncoders = new Set();
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.encoders.find((row) => row.selector === IPAC);
      assert.ok(original, "the fixture must serve the primary I-PAC");
      original.aria_current = stagedEncoders.has(IPAC) ? "true" : "false";
      const twin = {
        ...original,
        selector: IPAC_TWIN,
        name: "Ultimarc I-PAC 4X · second cabinet",
        alias: "Second cabinet",
        label: "Second cabinet I-PAC 4X",
        aria_current: stagedEncoders.has(IPAC_TWIN) ? "true" : "false",
      };
      const existingTwin = payload.devices.encoders.find((row) => row.selector === IPAC_TWIN);
      if (existingTwin) Object.assign(existingTwin, twin);
      else payload.devices.encoders.push(twin);
      await route.fulfill({ response, json: payload });
    });
    await page.route(`${BASE}/redesign/device`, async (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      const selector = body.get("selector");
      if (selector !== IPAC && selector !== IPAC_TWIN) {
        await route.continue();
        return;
      }
      stagedEncoders.add(selector);
      await route.fulfill({ status: 204 });
    });
    let laterChartGate = null;
    let reportLaterChart = null;
    let releaseOutstandingChart = null;
    await page.route("**/api/panel/chart", async (route) => {
      const body = route.request().postDataJSON();
      chartBodies.push(body);
      if (laterChartGate) {
        const gate = laterChartGate;
        const report = reportLaterChart;
        laterChartGate = null;
        reportLaterChart = null;
        report?.(body);
        await gate;
      }
      // The browser roster is extended with a synthetic second instance, but
      // both surfaces share the fixture's verified 56-terminal profile. Read
      // the fixture chart through its real selector so each UI instance can
      // exercise automatic loading and the global hardware lease.
      const response = await route.fetch({
        postData: JSON.stringify({ selector: IPAC }),
      });
      await route.fulfill({ response });
    });
    const gateNextChart = () => {
      let report;
      let release;
      const seen = new Promise((resolve) => { report = resolve; });
      laterChartGate = new Promise((resolve) => { release = resolve; });
      reportLaterChart = report;
      releaseOutstandingChart = release;
      return {
        seen,
        release: () => {
          releaseOutstandingChart = null;
          release();
        },
      };
    };
    let activeSelector = null;
    let generation = 700;
    let heldStartGate = null;
    let reportHeldStart = null;
    let heldCancelGate = null;
    let reportHeldCancel = null;
    const observationView = (state, selector = activeSelector) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : generation,
      selector: state === "idle" ? null : selector,
      remaining_ms: state === "listening" ? 28_000 : null,
      held: state === "listening" ? ["KeyA"] : [],
      seen: state === "idle" ? [] : ["KeyA"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 2,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Shared lease fixture.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      inputCalls.push({ path: pathName, body });
      if (pathName === "/api/input-test/start") {
        generation += 1;
        const requestedSelector = body.selector;
        const gate = heldStartGate;
        const report = reportHeldStart;
        heldStartGate = null;
        reportHeldStart = null;
        report?.(body);
        if (gate) await gate;
        activeSelector = requestedSelector;
        await route.fulfill({ status: 200, json: observationView("listening") });
      } else if (pathName === "/api/input-test/cancel") {
        const stoppedSelector = activeSelector;
        const gate = heldCancelGate;
        const report = reportHeldCancel;
        heldCancelGate = null;
        reportHeldCancel = null;
        report?.(body);
        if (gate) await gate;
        activeSelector = null;
        await route.fulfill({
          status: 200,
          json: observationView("cancelled", stoppedSelector),
        });
      } else {
        await route.fulfill({
          status: 200,
          json: observationView(activeSelector ? "listening" : "idle"),
        });
      }
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="light"]) button');
      await page.waitForFunction(
        (selector) => Boolean(document.querySelector(`.rd-devmodal button[data-selector="${selector}"]`)),
        IPAC_TWIN,
      );
      await page.click('[data-nx="rd-devs-open"]');
      const primary = page.locator(
        `.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`,
      );
      const twin = page.locator(
        `.rd-encoder-device-node[data-instance-id="${IPAC_TWIN_SLUG}"]`,
      );
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await primary.waitFor({ state: "attached", timeout: 20_000 });
      await page.click(`.rd-devmodal button[data-selector="${IPAC_TWIN}"]`);
      await twin.waitFor({ state: "attached", timeout: 20_000 });
      await page.keyboard.press("Escape");
      assert.equal(await primary.count(), 1);
      assert.equal(await twin.count(), 1);
      await page.waitForFunction(
        ({ primaryId, twinId }) => [primaryId, twinId].every((id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        )),
        { primaryId: IPAC_SLUG, twinId: IPAC_TWIN_SLUG },
      );
      assert.deepEqual(
        chartBodies,
        [{ selector: IPAC }, { selector: IPAC_TWIN }],
        "adding each encoder reads its stored assignments once, through one serialized hardware lane",
      );

      const heldRefresh = gateNextChart();
      await revealCanvasItem(page, IPAC_SLUG);
      // Minimap navigation frames the whole 960×900 board. Enter its editing
      // controls explicitly so this lease test does not depend on the spare
      // viewport height left by unrelated product chrome.
      await primary.focus();
      await primary.press("F2");
      await primary.getByRole("button", { name: "Refresh stored assignments" }).click();
      assert.deepEqual(await heldRefresh.seen, { selector: IPAC });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loading"]`,
        ),
        IPAC_SLUG,
      );
      await revealCanvasItem(page, IPAC_TWIN_SLUG);
      await twin.focus();
      await twin.press("F2");
      assert.equal(await twin.locator("[data-rd-encoder-read]").isDisabled(), true);
      assert.equal(await twin.locator('[data-rd-encoder-observe="start"]').isDisabled(), true);
      assert.equal(
        await twin.getByRole("button", { name: "Another encoder is reading", exact: true }).count(),
        1,
        "the blocked action names the actual hardware lane instead of a generic wait state",
      );
      assert.match(
        await twin.locator(".rd-encoder-product-actions").textContent(),
        /another encoder is reading its stored assignments/i,
      );
      await twin.locator("[data-rd-encoder-read]").evaluate((button) => button.click());
      await page.waitForTimeout(25);
      assert.deepEqual(
        chartBodies,
        [{ selector: IPAC }, { selector: IPAC_TWIN }, { selector: IPAC }],
        "the disabled twin cannot race the refresh",
      );

      const chartResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/panel/chart"
      );
      heldRefresh.release();
      await chartResponse;
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await twin.locator("[data-rd-encoder-read]").isEnabled(), true);
      assert.equal(await twin.locator('[data-rd-encoder-observe="start"]').isEnabled(), true);

      await twin.getByRole("button", { name: "Start button test" })
        .evaluate((button) => button.click());
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_TWIN_SLUG,
      );
      assert.equal(await primary.locator("[data-rd-encoder-read]").isDisabled(), true);
      assert.equal(await primary.locator('[data-rd-encoder-observe="start"]').isDisabled(), true);
      assert.match(
        await primary.locator(".rd-encoder-product-actions").textContent(),
        /button test is active for another encoder/i,
      );
      await primary.locator("[data-rd-encoder-read]").evaluate((button) => button.click());
      await page.waitForTimeout(25);
      assert.deepEqual(
        chartBodies,
        [{ selector: IPAC }, { selector: IPAC_TWIN }, { selector: IPAC }],
        "an active twin test blocks another read",
      );
      assert.deepEqual(
        inputCalls.filter((call) => call.path === "/api/input-test/start").map((call) => call.body),
        [{ selector: IPAC_TWIN, duration_ms: 30_000 }],
      );

      await twin.getByRole("button", { name: "Done", exact: true })
        .evaluate((button) => button.click());
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="complete"]`,
        ),
        IPAC_TWIN_SLUG,
      );
      assert.equal(await primary.locator("[data-rd-encoder-read]").isEnabled(), true);
      assert.equal(await primary.locator('[data-rd-encoder-observe="start"]').isEnabled(), true);

      const gateObservationCleanup = () => {
        let releaseStartRequest;
        let releaseCancelRequest;
        const startRequestSeen = new Promise((resolve) => { reportHeldStart = resolve; });
        const cancelRequestSeen = new Promise((resolve) => { reportHeldCancel = resolve; });
        heldStartGate = new Promise((resolve) => { releaseStartRequest = resolve; });
        heldCancelGate = new Promise((resolve) => { releaseCancelRequest = resolve; });
        return {
          startRequestSeen,
          cancelRequestSeen,
          releaseStartRequest,
          releaseCancelRequest,
        };
      };
      const assertBothSurfacesBlocked = async (reason) => {
        for (const surface of [primary, twin]) {
          assert.equal(await surface.locator("[data-rd-encoder-read]").isDisabled(), true, reason);
          assert.equal(
            await surface.locator('[data-rd-encoder-observe="start"]').isDisabled(),
            true,
            reason,
          );
        }
      };
      const waitForBothSurfacesReady = () => page.waitForFunction(
        ({ primaryId, twinId }) => [primaryId, twinId].every((id) => {
          const item = document.querySelector(`[data-instance-id="${id}"]`);
          const read = item?.querySelector("[data-rd-encoder-read]");
          const start = item?.querySelector('[data-rd-encoder-observe="start"]');
          return read && !read.disabled && start && !start.disabled;
        }),
        { primaryId: IPAC_SLUG, twinId: IPAC_TWIN_SLUG },
      );

      let abandoned = gateObservationCleanup();
      await twin.locator('[data-rd-encoder-observe="start"]')
        .evaluate((button) => button.click());
      assert.deepEqual(await abandoned.startRequestSeen, {
        selector: IPAC_TWIN,
        duration_ms: 30_000,
      });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation]`,
        )?.getAttribute("data-state") === "starting",
        IPAC_TWIN_SLUG,
      );
      await twin.locator("[data-rd-encoder-observation-sink]").press("Escape");
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation]`,
        )?.getAttribute("data-state") === "error",
        IPAC_TWIN_SLUG,
      );
      await assertBothSurfacesBlocked("Escape clears capture UI without releasing the pending start");
      assert.match(
        await twin.locator(".rd-encoder-product-actions").textContent(),
        /button-test request is still settling.*exact cleanup/i,
      );
      const callsBeforeLateStart = { charts: chartBodies.length, inputs: inputCalls.length };
      abandoned.releaseStartRequest();
      assert.deepEqual(await abandoned.cancelRequestSeen, { generation: 702 });
      await assertBothSurfacesBlocked("the late exact generation keeps the lane closed through cancel");
      assert.deepEqual(
        { charts: chartBodies.length, inputs: inputCalls.length },
        { charts: callsBeforeLateStart.charts, inputs: callsBeforeLateStart.inputs + 1 },
        "only the exact cleanup request is admitted while cancellation is pending",
      );
      abandoned.releaseCancelRequest();
      await waitForBothSurfacesReady();

      abandoned = gateObservationCleanup();
      await primary.locator('[data-rd-encoder-observe="start"]')
        .evaluate((button) => button.click());
      assert.deepEqual(await abandoned.startRequestSeen, {
        selector: IPAC,
        duration_ms: 30_000,
      });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation]`,
        )?.getAttribute("data-state") === "starting",
        IPAC_SLUG,
      );
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation]`,
        )?.getAttribute("data-state") === "idle",
        IPAC_SLUG,
      );
      await assertBothSurfacesBlocked("BFCache clears pending-start UI without opening either surface");
      abandoned.releaseStartRequest();
      assert.deepEqual(await abandoned.cancelRequestSeen, { generation: 703 });
      await assertBothSurfacesBlocked("BFCache late-start cleanup remains exclusive until acknowledged");
      abandoned.releaseCancelRequest();
      await waitForBothSurfacesReady();

      const heldLateChart = gateNextChart();
      await primary.locator("[data-rd-encoder-read]").evaluate((button) => button.click());
      assert.deepEqual(await heldLateChart.seen, { selector: IPAC });
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart]`,
        )?.getAttribute("data-state") === "idle",
        IPAC_SLUG,
      );
      await assertBothSurfacesBlocked("BFCache clears Reading UI but the held chart still owns the lane");
      const inputsBeforeChartRelease = inputCalls.length;
      await twin.locator('[data-rd-encoder-observe="start"]').evaluate((button) => button.click());
      await page.waitForTimeout(25);
      assert.equal(inputCalls.length, inputsBeforeChartRelease, "a disabled twin cannot overlap the held chart");
      const laterChartResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/panel/chart"
      );
      heldLateChart.release();
      await laterChartResponse;
      await waitForBothSurfacesReady();
      assert.equal(
        await primary.locator('[data-rd-encoder-chart][data-state="idle"]').count(),
        1,
        "the pre-pagehide chart remains stale after its coordinator hold settles",
      );
      assert.deepEqual(noise, []);
    } finally {
      releaseOutstandingChart?.();
      await page.unrouteAll({ behavior: "wait" });
      await closeContext(leaseContext);
    }
  });

  test("the Add tray keeps the workbench live while picking several boards", async () => {
    const page = await openBench();
    const opener = page.locator('[data-nx="rd-devs-open"]');
    await opener.click();
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the tray opens",
    );
    assert.equal(await opener.getAttribute("aria-expanded"), "true");
    assert.equal(await opener.getAttribute("aria-controls"), "rd-device-picker");
    assert.equal(await page.locator("#rd-device-picker").evaluate((node) => node.tagName), "ASIDE");
    assert.equal(
      await page.locator("#rd-device-picker").getAttribute("aria-modal"),
      null,
      "the persistent tray is a non-modal region",
    );
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-devmodal button[data-nx="rd-devs-close"]')
      ),
      true,
      "the picker lands on its first reliable control",
    );
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".rd-devmodal-panel")?.getBoundingClientRect();
      const canvas = document.querySelector(".n-canvas")?.getBoundingClientRect();
      return panel && canvas
        ? { panelRight: panel.right, canvasLeft: canvas.left, canvasWidth: canvas.width }
        : null;
    });
    assert.ok(geometry, "the tray and canvas are measurable");
    assert.ok(geometry.panelRight <= geometry.canvasLeft);
    assert.ok(
      geometry.canvasLeft - geometry.panelRight <= 24,
      "the canvas is physically laid out beside the tray with only its normal gutter",
    );
    assert.ok(geometry.canvasWidth > geometry.panelRight, "most of the workbench remains visible");

    // A catalog region is not a focus trap: keyboard navigation continues
    // naturally into the visible canvas after its final control.
    const trayControls = page.locator(".rd-devmodal-panel button:not([disabled])");
    await trayControls.last().focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        !document.querySelector(".rd-devmodal-panel")?.contains(document.activeElement)
      ),
      true,
      "Tab leaves the tray for the workbench instead of wrapping",
    );
    // Ctrl+K transfers ownership instead of stacking two surfaces. Its
    // Escape return lands on the original Devices opener.
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 1, "palette closes Devices");
    assert.equal(await page.locator(".rd-palette[hidden]").count(), 0, "palette opens alone");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-palette-input")),
      true,
      "the palette owns focus",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rd-palette[hidden]").count(), 1, "Escape closes the palette");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-devs-open"]')),
      true,
      "closing the replacement overlay returns to the Devices opener",
    );
    await opener.click();
    // All four folds, with the fixture's counts — and the scan's own line.
    for (const head of [
      "Keyboards · 1",
      "Panel encoders · 1",
      "Not keyboards — experimental · 1",
      "Unavailable devices · 1",
    ]) {
      assert.ok(
        await page.locator(".rd-devmodal .rd-devhead", { hasText: head }).count(),
        `fold head ${head} is painted`,
      );
    }
    assert.match(
      (await page.locator(".rd-devmodal .n-devnote:not(.rd-devmodal-purpose)").textContent()) ?? "",
      /keyboard-capable/,
      "the scan line speaks",
    );
    assert.match(
      (await page.locator(".rd-devmodal-purpose").textContent()) ?? "",
      /Add places that physical device's own board.*Every added connected keyboard is an independent source.*map to any controller.*shared with another keyboard/s,
      "the picker explains additive source membership and many-to-many routing",
    );
    // The unavailable tier is visible but NEVER a control.
    assert.equal(
      await page.locator(".rd-devmodal .n-dev.off").count(),
      1,
      "the unpickable board is shown",
    );
    assert.equal(
      await page.locator('.rd-devmodal button[data-selector=""], .rd-devmodal .n-dev.off button')
        .count(),
      0,
      "no button hides in the unavailable tier",
    );
    // Pick BOTH the keyboard and the encoder. The tray stays open — the
    // multi-add is the point.
    for (const selector of [G915, IPAC]) {
      const row = page.locator(`.rd-devmodal button[data-selector="${selector}"]`);
      if ((await row.getAttribute("aria-pressed")) !== "true") {
        await row.click();
        await page.waitForFunction(
          (wanted) => document.querySelector(
            `.rd-devmodal button[data-selector="${wanted}"]`,
          )?.getAttribute("aria-pressed") === "true",
          selector,
          { timeout: 10_000 },
        );
      }
    }
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the tray stays open for more picks",
    );
    for (const slug of [G915_SLUG, IPAC_SLUG]) {
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        slug,
        { timeout: 10_000 },
      );
    }
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "selection confirms the add on-canvas without opening a second side panel",
    );
    // Pad-art activation opens the Inspector directly rather than through the
    // selection callback. It still yields to the active composition tray.
    await page.locator(
      '.forma-canvas-stage [data-instance-id^="ctrl-slot-"] .rd-ctrlcard-artwrap [data-fn]',
    ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    })));
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "direct canvas actions cannot reopen the Inspector beside the Add tray",
    );
    // The widgets carry the RAW selector, and the rows now say so.
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"][data-selector="${IPAC}"]`)
        .count(),
      1,
      "the widget keeps the raw selector",
    );
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${IPAC}"][aria-pressed="true"]`)
        .count(),
      1,
      "the encoder row is pressed",
    );
    assert.match(
      (await page.locator(`.rd-devmodal button[data-selector="${G915}"] .rd-dev-word`).textContent()) ?? "",
      /On canvas/,
      "the row says where the board went",
    );
    // Escape is the picker's rung on the ladder.
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      1,
      "Escape closes the picker first",
    );
    assert.equal(await opener.getAttribute("aria-expanded"), "false");
    assert.equal(
      await page.locator(".rd-inspector:not([hidden])").count(),
      1,
      "closing composition resumes the deferred inspection of the selected addition",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-devs-open"]')),
      true,
      "closing the picker restores its opener",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("the shared tray slot switches catalogs and returns to the initiating opener", async () => {
    const page = await openBench();
    const devices = page.locator('[data-nx="rd-devs-open"]');
    const controllers = page.locator('[data-nx="rd-ctrls-open"]');
    await devices.click();
    await controllers.click();
    assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 1);
    assert.equal(await page.locator(".rd-ctrlmodal[hidden]").count(), 0);
    assert.equal(await devices.getAttribute("aria-expanded"), "false");
    assert.equal(await controllers.getAttribute("aria-expanded"), "true");
    assert.equal(
      await page.locator(".rd.is-add-panel-open").count(),
      1,
      "a catalog switch keeps one reserved canvas lane",
    );
    await page.click('.rd-ctrlmodal-head button[data-nx="rd-ctrls-close"]');
    assert.equal(await controllers.getAttribute("aria-expanded"), "false");
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "opening and closing catalogs alone does not invent inspection intent",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-ctrls-open"]')),
      true,
      "Done returns to Controllers, not the stale Devices opener",
    );
    assert.deepEqual(page.ksxNoise, []);
    await closePage(page);
  });

  test("a narrow viewport reserves a live canvas above the bottom Add tray", async () => {
    const page = await openBench();
    await page.setViewportSize({ width: 420, height: 900 });
    await page.click('[data-nx="rd-devs-open"]');
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".rd-devmodal-panel")?.getBoundingClientRect();
      const canvas = document.querySelector(".n-canvas")?.getBoundingClientRect();
      return panel && canvas
        ? {
          panelTop: panel.top,
          panelWidth: panel.width,
          canvasBottom: canvas.bottom,
          canvasHeight: canvas.height,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }
        : null;
    });
    assert.ok(geometry);
    assert.ok(geometry.canvasBottom <= geometry.panelTop);
    assert.ok(
      geometry.panelTop - geometry.canvasBottom <= 24,
      "the bottom tray follows the resized canvas after its normal gutter",
    );
    assert.ok(geometry.canvasHeight >= 260, "the workbench remains materially visible");
    assert.equal(Math.round(geometry.panelWidth), geometry.viewportWidth);
    assert.ok(
      geometry.scrollWidth <= geometry.viewportWidth,
      "the responsive tray creates no horizontal page overflow",
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(page.ksxNoise, []);
    await closePage(page);
  });

  test("a phone-width landscape keeps the Add tray below a usable canvas", async () => {
    const page = await openBench();
    await page.setViewportSize({ width: 568, height: 320 });
    await page.click('[data-nx="rd-devs-open"]');
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".rd-devmodal-panel")?.getBoundingClientRect();
      const canvas = document.querySelector(".n-canvas")?.getBoundingClientRect();
      return panel && canvas
        ? {
          panelTop: panel.top,
          panelWidth: panel.width,
          canvasBottom: canvas.bottom,
          canvasHeight: canvas.height,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }
        : null;
    });
    assert.ok(geometry);
    assert.ok(
      geometry.canvasBottom <= geometry.panelTop,
      "phone landscape keeps the catalog below, rather than squeezing beside, the canvas",
    );
    assert.ok(
      geometry.panelTop - geometry.canvasBottom <= 24,
      "the compact tray follows the live canvas after its normal gutter",
    );
    assert.ok(geometry.canvasHeight >= 80, "the short viewport retains a usable workbench");
    assert.equal(Math.round(geometry.panelWidth), geometry.viewportWidth);
    assert.ok(
      geometry.scrollWidth <= geometry.viewportWidth,
      "the landscape tray creates no horizontal page overflow",
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(page.ksxNoise, []);
    await closePage(page);
  });

  test("reload and authoritative reconnect restore the workbench without passive chart reads", async () => {
    // Seed the persisted arrangement explicitly so this regression is valid
    // both in the full ordered suite and under a focused name filter.
    const seed = await openBench();
    await seed.click('[data-nx="rd-devs-open"]');
    let addedEncoder = false;
    for (const selector of [G915, IPAC]) {
      const row = seed.locator(`.rd-devmodal button[data-selector="${selector}"]`);
      if (await row.getAttribute("aria-pressed") !== "true") {
        await row.click();
        await seed.waitForFunction(
          (wanted) => document.querySelector(
            `.rd-devmodal button[data-selector="${wanted}"]`,
          )?.getAttribute("aria-pressed") === "true",
          selector,
          { timeout: 10_000 },
        );
        if (selector === IPAC) addedEncoder = true;
      }
    }
    await seed.keyboard.press("Escape");
    if (addedEncoder) {
      await seed.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
    }
    await closePage(seed);

    const chartCalls = [];
    const page = await openBench({
      onRequest: (request) => {
        if (new URL(request.url()).pathname === "/api/panel/chart") {
          chartCalls.push(request.postDataJSON());
        }
      },
    });
    for (const slug of [G915_SLUG, IPAC_SLUG]) {
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        slug,
        { timeout: 10_000 },
      );
    }
    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page.locator('.rd-devmodal button[aria-pressed="true"]').count(),
      2,
      "both rows still marked after the reload",
    );
    await page.waitForTimeout(50);
    assert.deepEqual(chartCalls, [], "restoring persisted membership performs no chart transaction");
    await page.keyboard.press("Escape");

    let rosterMode = "absent";
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (rosterMode === "absent") {
        payload.devices.encoders = payload.devices.encoders.filter((row) => row.selector !== IPAC);
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="matrix"]) button');
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
        IPAC_SLUG,
      );
      rosterMode = "present";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="system"]) button');
      await page.waitForFunction(
        (id) => document.querySelector(
          `.forma-canvas-stage [data-instance-id="${id}"] [data-rd-encoder-read]`,
        ),
        IPAC_SLUG,
      );
      await page.waitForTimeout(50);
      assert.deepEqual(
        chartCalls,
        [],
        "an encoder returning through an authoritative roster refresh waits for explicit Read",
      );
    } finally {
      // An intercepted authority request can remain in flight on a slower
      // runner. Wait for its handler before page teardown races `fulfill`.
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("selected picker removal clears the Inspector and survives a reload", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    for (const selector of [G915, IPAC]) {
      const row = page.locator(`.rd-devmodal button[data-selector="${selector}"]`);
      if ((await row.getAttribute("aria-pressed")) !== "true") {
        await row.click();
        await page.waitForFunction(
          (wanted) => document.querySelector(
            `.rd-devmodal button[data-selector="${wanted}"]`,
          )?.getAttribute("aria-pressed") === "true",
          selector,
          { timeout: 10_000 },
        );
      }
    }
    await page.keyboard.press("Escape");
    await revealCanvasItem(page, G915_SLUG);
    await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.waitForFunction(
      (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${G915}"][aria-pressed="false"]`)
        .count(),
      1,
      "the row un-pressed",
    );
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "removing the selected board closes its Inspector behind the picker",
    );
    assert.equal(
      await page.locator(".rd.is-inspector-open").count(),
      0,
      "the removed selection releases the Inspector's canvas inset",
    );
    await closePage(page);

    const again = await openBench();
    assert.equal(
      await again.evaluate(
        (id) => Boolean(document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)),
        G915_SLUG,
      ),
      false,
      "the removed board stays off the bench",
    );
    await again.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .canvasX !== undefined,
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    assert.deepEqual(again.ksxNoise, [], "the page must stay error-free");
    await closePage(again);
  });

  test("picker addition stages an independent keyboard without replacing peer sources", async () => {
    const page = await openBench();
    await page.evaluate(() => {
      window.__ksxStay = 42;
    });
    await page.click('[data-nx="rd-devs-open"]');
    const initialIpacRow = page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`);
    if ((await initialIpacRow.getAttribute("aria-pressed")) !== "true") {
      await initialIpacRow.click();
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (id) => document.querySelector(
        `.forma-canvas-stage [data-instance-id="${id}"]`,
      )?.dataset.mappingAvailable === "true",
      IPAC_SLUG,
      { timeout: 10_000 },
    );

    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      (await page.locator(
        `.rd-devmodal button[data-selector="${IPAC}"] .rd-dev-word`,
      ).textContent())?.trim(),
      "On canvas — press to remove",
    );
    assert.equal(
      (await page.locator(
        '.rd-devmodal button[data-role="other"] .rd-dev-word',
      ).textContent())?.trim(),
      "Show on canvas",
    );
    const g915PickerRow = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    assert.equal(
      (await g915PickerRow.locator(".rd-dev-word").textContent())?.trim(),
      "Add keyboard board to canvas",
    );
    await g915PickerRow.click();
    await page.keyboard.press("Escape");

    const g915Board = page.locator(
      `.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`,
    );
    await page.waitForFunction(
      (id) => document.querySelector(
        `.forma-canvas-stage [data-instance-id="${id}"]`,
      )?.dataset.mappingAvailable === "true",
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(await page.evaluate(() => window.__ksxStay), 42, "addition does not reload");
    assert.equal(await g915Board.getAttribute("data-staged"), "true");
    assert.equal(await g915Board.getAttribute("data-source-enabled"), "true");
    assert.equal(await g915Board.getAttribute("data-source-id"), G915);
    assert.equal(await g915Board.locator(".rd-devcard, .rd-stagebtn").count(), 0);
    assert.equal(await g915Board.locator("[data-rd-keyboard-surface] .n-kb").count(), 1);
    assert.ok(
      await g915Board.locator("[data-rd-keyboard-surface] .n-kb [data-key]").count() > 80,
      "every intentionally added keyboard owns a full interactive key surface",
    );
    assert.equal(
      Number(await g915Board.getAttribute("data-canvas-height")) >= 460,
      true,
      "a physical keyboard reserves its full board footprint",
    );
    assert.equal(
      (await g915Board.locator(".n-kbhead > .n-kick").textContent())?.trim(),
      "Logitech G915 TKL",
    );
    assert.equal(await g915Board.locator('.n-kb button.n-key[data-key="A"]').count(), 1);
    assert.equal(
      await page.locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"]`)
        .getAttribute("data-mapping-available"),
      "true",
      "adding a keyboard never disarms the existing encoder source",
    );
    assert.equal(
      await page.locator('[data-instance-id="keyboard"]').count(),
      0,
      "the retired synthetic keyboard never returns",
    );
    assert.equal(
      await page.locator("[data-rd-global-source-controls-host] [data-rd-source-controls]").count(),
      1,
      "session-wide input policy stays global rather than belonging to one board",
    );

    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page.locator(
        `.rd-devmodal button[data-selector="${G915}"][aria-current="true"]`,
      ).count(),
      1,
      "the keyboard row carries its staged-source fact",
    );
    assert.ok(
      await page.locator('.rd-devmodal button[aria-current="true"]').count() >= 2,
      "staged membership is additive rather than a singleton marker",
    );
    assert.equal(
      (await g915PickerRow.locator(".rd-dev-word").textContent())?.trim(),
      "On canvas — press to remove board",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("two same-name keyboards own independent full surfaces across refresh and peer removal", async () => {
    const twinContext = await browser.newContext({
      // Keep both full boards materially on screen so source-focus changes
      // test DOM ownership rather than canvas virtualization.
      viewport: { width: 2600, height: 1200 },
      colorScheme: "dark",
    });
    const page = await twinContext.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });

    const stagedSelectors = new Set([G915]);
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.keyboards.find((row) => row.selector === G915);
      assert.ok(original, "the fixture must serve its physical keyboard");
      payload.devices.keyboards = [
        ...payload.devices.keyboards.filter(
          (row) => row.selector !== G915 && row.selector !== G915_TWIN,
        ),
        {
          ...original,
          aria_current: stagedSelectors.has(G915) ? "true" : "false",
        },
        {
          ...original,
          selector: G915_TWIN,
          // Deliberately keep the same display name: raw connection identity,
          // never a lossy label slug, must distinguish these two boards.
          name: original.name,
          connection_label: "USB 046D:C545 · connection 01",
          alias: "second keyboard connection",
          label: "Logitech G915 TKL · second connection",
          meta: "Bluetooth · Ready to use · second connection",
          title: "Logitech G915 TKL · second connection",
          aria_current: stagedSelectors.has(G915_TWIN) ? "true" : "false",
        },
      ];
      payload.devices.keyboards_head = "KEYBOARDS · 2";
      payload.devices.scan_authoritative = true;
      payload.devices.staging_reachable = true;
      await route.fulfill({ response, json: payload });
    });
    await page.route(`${BASE}/redesign/device`, async (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      const wanted = body.get("selector");
      assert.ok(
        wanted === G915 || wanted === G915_TWIN,
        `unexpected routed keyboard selection ${wanted}`,
      );
      stagedSelectors.add(wanted);
      // The following `/api/redesign` repaint exposes additive staged-source
      // truth without changing fixture hardware.
      await route.fulfill({ status: 204 });
    });
    await page.route(`${BASE}/redesign/device/remove`, async (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      const wanted = body.get("selector");
      assert.ok(wanted === G915 || wanted === G915_TWIN);
      stagedSelectors.delete(wanted);
      await route.fulfill({ status: 204 });
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        (selector) => Boolean(document.querySelector(
          `.rd-devmodal button[data-selector="${selector}"]`,
        )),
        G915_TWIN,
        { timeout: 20_000 },
      );

      // Exercise the future-proof id namespace seam even though today's
      // standard keyboard blueprint has no native ids of its own.
      await page.evaluate(() => {
        const template = document.querySelector("[data-rd-keyboard-surface-template-body]");
        const heading = template?.querySelector(".n-kbhead > .n-kick");
        if (!template || !heading) throw new Error("keyboard blueprint is missing");
        heading.id = "keyboard-surface-title";
        template.setAttribute("aria-labelledby", heading.id);
      });

      await page.click('[data-nx="rd-devs-open"]');
      for (const selector of [G915, G915_TWIN]) {
        await page.locator(`.rd-devmodal button[data-selector="${selector}"]`).click();
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        ([left, right]) => [left, right].every((id) =>
          document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
            ?.dataset.canvasX !== undefined
        ),
        [G915_SLUG, G915_TWIN_SLUG],
      );

      const primary = page.locator(
        `.forma-canvas-stage > [data-instance-id="${G915_SLUG}"]`,
      );
      const twin = page.locator(
        `.forma-canvas-stage > [data-instance-id="${G915_TWIN_SLUG}"]`,
      );
      assert.equal(await page.locator(".rd-keyboard-device-node").count(), 2);
      assert.notEqual(G915_SLUG, G915_TWIN_SLUG, "raw selectors own distinct canvas ids");
      const twinTitles = await page.locator(
        ".rd-keyboard-device-node .n-kbhead > .n-kick",
      ).allTextContents();
      assert.equal(
        new Set(twinTitles).size,
        2,
        "same-model boards expose two distinct exact-connection titles",
      );
      assert.ok(
        twinTitles.some((title) => /Logitech G915 TKL.*connection 00/i.test(title)),
        "the first board title names connection 00",
      );
      assert.ok(
        twinTitles.some((title) => /Logitech G915 TKL.*connection 01/i.test(title)),
        "the twin board title names connection 01",
      );
      assert.deepEqual(
        await page.locator(".rd-keyboard-device-node").evaluateAll((items) =>
          items.map((item) => item.dataset.instanceId).sort()
        ),
        [G915_SLUG, G915_TWIN_SLUG].sort(),
        "same-name keyboards remain two stable board nodes",
      );
      assert.equal(await page.locator("[data-rd-keyboard-surface]").count(), 2);
      assert.equal(await page.locator("[data-rd-keyboard-surface-depot]").count(), 0);
      assert.equal(await page.locator("[data-rd-keyboard-surface-active]").count(), 0);
      assert.equal(
        await page.locator('.rd-keyboard-device-node[data-mapping-available="true"]').count(),
        2,
      );
      assert.equal(
        await page.locator('.rd-keyboard-device-node[data-source-enabled="true"]').count(),
        2,
      );
      assert.equal(await page.locator("[data-mapping-source]").count(), 0);
      assert.ok(
        await page.locator("[data-authoring-source]").count() <= 1,
        "authoring focus may name one board but never grants runtime exclusivity",
      );
      assert.equal(await primary.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(await twin.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(await primary.getAttribute("data-source-id"), G915);
      assert.equal(await twin.getAttribute("data-source-id"), G915_TWIN);
      assert.equal(
        await primary.locator("[data-rd-keyboard-surface]").getAttribute("data-source-id"),
        G915,
      );
      assert.equal(
        await twin.locator("[data-rd-keyboard-surface]").getAttribute("data-source-id"),
        G915_TWIN,
      );
      assert.equal(await primary.getAttribute("data-mapping-available"), "true");
      assert.equal(await twin.getAttribute("data-mapping-available"), "true");
      assert.ok(await primary.locator(".n-kb [data-key]").count() > 80);
      assert.ok(await twin.locator(".n-kb [data-key]").count() > 80);
      assert.equal(await twin.locator(".n-kb .n-key.bound").count(), 0);
      assert.match(
        (await twin.locator("[data-rd-keyboard-mapping-status]").textContent()) ?? "",
        /Independent source/i,
      );
      assert.equal(await twin.locator(".rd-keyboard-device-identity, .rd-stagebtn").count(), 0);
      const idAudit = await page.locator("[data-rd-keyboard-surface]").evaluateAll((surfaces) =>
        surfaces.map((surface) => ({
          ids: [surface, ...surface.querySelectorAll("[id]")]
            .map((element) => element.id)
            .filter(Boolean),
          labelledby: surface.getAttribute("aria-labelledby"),
        }))
      );
      assert.equal(new Set(idAudit.flatMap((surface) => surface.ids)).size, 2);
      assert.notEqual(idAudit[0].ids[0], idAudit[1].ids[0]);
      for (const surface of idAudit) assert.equal(surface.labelledby, surface.ids[0]);

      await page.locator('[data-nx="rd-z-100"]').evaluate((button) => button.click());
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")?.dataset.canvasZoomTier ===
            "editing" && !document.querySelector(".is-camera-animating"),
      );
      const primaryKey = primary.locator('.n-kb button.n-key[data-key="A"]');
      const twinKey = twin.locator('.n-kb button.n-key[data-key="A"]');
      const primaryGeometry = await primary.evaluate((item) => ({
        x: item.dataset.canvasX,
        y: item.dataset.canvasY,
        width: item.dataset.canvasWidth,
        height: item.dataset.canvasHeight,
      }));
      await primaryKey.evaluate((key) => key.click());
      await page.waitForFunction(
        ([id, selector]) =>
          new URL(window.location.href).searchParams.get("source") === selector &&
          document.querySelector(
            `.forma-canvas-stage > [data-instance-id="${id}"]`,
          )?.hasAttribute("data-authoring-source"),
        [G915_SLUG, G915],
        { timeout: 12_000 },
      );
      assert.equal(await page.locator("[data-authoring-source]").count(), 1);
      assert.equal(await primary.getAttribute("data-mapping-available"), "true");
      assert.equal(await twin.getAttribute("data-mapping-available"), "true");

      await twinKey.evaluate((key) => key.click());
      await page.waitForFunction(
        ([id, selector]) =>
          new URL(window.location.href).searchParams.get("source") === selector &&
          document.querySelector(
            `.forma-canvas-stage > [data-instance-id="${id}"]`,
          )?.hasAttribute("data-authoring-source"),
        [G915_TWIN_SLUG, G915_TWIN],
        { timeout: 12_000 },
      );
      assert.equal(await page.locator("[data-authoring-source]").count(), 1);
      assert.equal(await primary.getAttribute("data-mapping-available"), "true");
      assert.equal(await twin.getAttribute("data-mapping-available"), "true");
      assert.deepEqual(
        await primary.evaluate((item) => ({
          x: item.dataset.canvasX,
          y: item.dataset.canvasY,
          width: item.dataset.canvasWidth,
          height: item.dataset.canvasHeight,
        })),
        primaryGeometry,
        "changing authoring focus never changes keyboard A's geometry",
      );

      await twinKey.focus();
      assert.equal(await twinKey.evaluate((key) => document.activeElement === key), true);
      const twinGeometry = await twin.evaluate((item) => ({
        x: item.dataset.canvasX,
        y: item.dataset.canvasY,
        width: item.dataset.canvasWidth,
        height: item.dataset.canvasHeight,
      }));
      await page.locator(`.rd-devmodal button[data-selector="${G915}"]`)
        .evaluate((button) => button.click());
      await page.waitForFunction(
        (id) => !document.querySelector(
          `.forma-canvas-stage > [data-instance-id="${id}"]`,
        ),
        G915_SLUG,
      );
      assert.deepEqual(
        await twin.evaluate((item) => ({
          x: item.dataset.canvasX,
          y: item.dataset.canvasY,
          width: item.dataset.canvasWidth,
          height: item.dataset.canvasHeight,
        })),
        twinGeometry,
        "removing keyboard A leaves keyboard B's geometry untouched",
      );
      assert.equal(
        await twinKey.evaluate((key) => document.activeElement === key),
        true,
        "removing a peer leaves focus inside keyboard B's persistent board",
      );
      assert.equal(await page.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(
        await page.locator("[data-rd-global-source-controls-host] [data-rd-source-controls]").count(),
        1,
      );
      assert.deepEqual(noise, [], "independent keyboard surfaces stay error-free");
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await closeContext(twinContext);
    }
  });

  test("a routed keyboard stays selectable and removable while disconnected", async () => {
    const recoveryContext = await browser.newContext({
      viewport: { width: 2200, height: 1100 },
      colorScheme: "dark",
    });
    const page = await recoveryContext.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    let connected = true;
    let twinStaged = true;
    let removedSelector = "";
    let removedAuthority = null;
    let servedDraftRevision = "";

    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.keyboards.find((row) => row.selector === G915);
      assert.ok(original, "the fixture must serve its keyboard template row");
      const primary = {
        ...original,
        aria_current: "true",
        staged_revision: "device-primary-r7",
      };
      const twin = {
        ...original,
        selector: G915_TWIN,
        connection_label: "USB 046D:C545 · connection 01",
        alias: "recovery keyboard",
        label: "Logitech G915 TKL · recovery connection",
        meta: "Bluetooth · Ready to use · recovery connection",
        aria_current: "true",
        staged_revision: "device-recovery-r7",
      };
      payload.devices.keyboards = [
        ...payload.devices.keyboards.filter(
          (row) => row.selector !== G915 && row.selector !== G915_TWIN,
        ),
        primary,
        ...(connected && twinStaged ? [twin] : []),
      ];
      payload.devices.keyboards_head = `Keyboards · ${payload.devices.keyboards.length}`;
      payload.devices.experimental = [
        ...payload.devices.experimental.filter((row) => row.selector !== G915_TWIN),
        ...(!connected && twinStaged
          ? [{
              ...twin,
              role: "offline-source",
              instance_id: "",
              meta: "Connection unavailable · still in the mapping draft",
              capture_badge: "Disconnected",
              capture_state: "attention",
              capture_cls: "rd-dev-capturechip",
              title: "This exact source is still in the mapping draft but is not connected. Reconnect it to resume input, or remove it without affecting peer sources.",
            }]
          : []),
      ];
      payload.devices.exp_head = !connected && twinStaged
        ? `Experimental and disconnected · ${payload.devices.experimental.length}`
        : `Not keyboards — experimental · ${payload.devices.experimental.length}`;
      payload.devices.exp_fold_cls = payload.devices.experimental.length
        ? "n-devfold"
        : "n-devfold none";
      payload.devices.scan_authoritative = true;
      payload.devices.staging_reachable = true;

      const pad = payload.controllers.pads[0];
      assert.ok(pad, "the fixture must serve one controller");
      const seed = pad.sources?.[0] ?? {
        source_id: G915,
        source_alias: primary.alias,
        source_label: primary.label,
        routed: true,
        revision: "source-a-r1",
        preset: "Player 1 · keyboard A",
        fn_keys: {},
        controls: [],
        mapping_available: true,
        mapping_reason: "",
        macros: [],
        macro_available: true,
        macro_reason: "",
      };
      const sourceA = {
        ...seed,
        source_id: G915,
        source_alias: primary.alias,
        source_label: primary.label,
        routed: true,
        revision: "source-a-r1",
        controls: [],
        macros: [],
        mapping_available: true,
        mapping_reason: "",
      };
      const sourceB = {
        ...seed,
        source_id: G915_TWIN,
        source_alias: twin.alias,
        source_label: twin.label,
        routed: true,
        revision: "source-b-r1",
        controls: [],
        macros: [],
        mapping_available: connected,
        mapping_reason: connected ? "" : "Reconnect this exact keyboard before Save or Play.",
      };
      pad.sources = [sourceA, ...(twinStaged ? [sourceB] : [])];
      payload.source = twinStaged ? G915_TWIN : G915;
      payload.controllers.source = payload.source;
      if (payload.operations) {
        servedDraftRevision = payload.operations.draft_revision;
        payload.operations.save.allowed = connected || !twinStaged;
        payload.operations.play.allowed = connected || !twinStaged;
        payload.operations.save.reason = !connected && twinStaged
          ? "Reconnect Logitech G915 TKL · recovery connection, or remove that exact source."
          : payload.operations.save.reason;
        payload.operations.play.reason = !connected && twinStaged
          ? "Reconnect Logitech G915 TKL · recovery connection, or remove that exact source."
          : payload.operations.play.reason;
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route(`${BASE}/redesign/device/remove`, async (route) => {
      const body = new URLSearchParams(route.request().postData() ?? "");
      removedSelector = body.get("selector") ?? "";
      removedAuthority = {
        draft: body.get("expected_revision"),
        source: body.get("expected_source_revision"),
      };
      twinStaged = false;
      await route.fulfill({ status: 204 });
    });

    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
      );
      await page.waitForFunction(
        (selector) => Boolean(document.querySelector(
          `.rd-devmodal button[data-selector="${selector}"]`,
        )),
        G915_TWIN,
        { timeout: 20_000 },
      );
      await page.click('[data-nx="rd-devs-open"]');
      for (const selector of [G915, G915_TWIN]) {
        const row = page.locator(`.rd-devmodal button[data-selector="${selector}"]`);
        if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        ([left, right]) => [left, right].every((id) =>
          document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
        ),
        [G915_SLUG, G915_TWIN_SLUG],
      );
      const primary = page.locator(
        `.forma-canvas-stage > [data-instance-id="${G915_SLUG}"]`,
      );
      const twin = page.locator(
        `.forma-canvas-stage > [data-instance-id="${G915_TWIN_SLUG}"]`,
      );
      const twinGeometry = await twin.evaluate((item) => ({
        x: item.dataset.canvasX,
        y: item.dataset.canvasY,
        width: item.dataset.canvasWidth,
        height: item.dataset.canvasHeight,
      }));
      assert.equal(await page.locator(".rd-keyboard-device-node").count(), 2);

      await revealCanvasItem(page, G915_SLUG);
      const focusedTwinKey = twin.locator('[data-key="A"]').first();
      await focusedTwinKey.evaluate((key) => key.focus());
      assert.equal(await primary.getAttribute("aria-current"), "true");
      assert.equal(await twin.getAttribute("aria-current"), null);
      assert.equal(
        await twin.evaluate((item) => item.contains(document.activeElement)),
        true,
        "native focus inside an unselected peer is independent from canvas selection",
      );

      connected = false;
      await page.waitForFunction(
        (id) => document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
          ?.dataset.deviceRole === "offline-source",
        G915_TWIN_SLUG,
        { timeout: 15_000 },
      );
      assert.equal(await primary.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(await twin.locator("[data-rd-keyboard-surface]").count(), 0);
      assert.equal(await twin.getAttribute("data-source-enabled"), "unknown");
      assert.equal(await twin.getAttribute("data-mapping-available"), "false");
      assert.equal(
        await twin.evaluate((item) => document.activeElement === item),
        true,
        "a selected board's recovery presentation retains keyboard focus",
      );
      assert.equal(
        await twin.getAttribute("aria-current"),
        null,
        "disconnect does not promote the focused peer into the selection",
      );
      assert.equal(await primary.getAttribute("aria-current"), "true");
      assert.match((await twin.textContent()) ?? "", /Disconnected source/i);
      assert.match(
        (await page.locator("#rd-save-reason").textContent()) ?? "",
        /Reconnect Logitech G915 TKL/i,
        "the exact unavailable source blocker stays visible beside Save",
      );
      assert.equal(
        new URL(page.url()).searchParams.get("source"),
        G915_TWIN,
        "connection loss never erases canonical authoring focus",
      );
      assert.deepEqual(
        await twin.evaluate((item) => ({
          x: item.dataset.canvasX,
          y: item.dataset.canvasY,
          width: item.dataset.canvasWidth,
          height: item.dataset.canvasHeight,
        })),
        twinGeometry,
        "the recovery card retains the physical board's geometry",
      );
      await page.click('[data-nx="rd-devs-open"]');
      const offlineRow = page.locator(
        `.rd-devmodal button[data-selector="${G915_TWIN}"][data-role="offline-source"]`,
      );
      assert.equal(await offlineRow.count(), 1);
      assert.match((await offlineRow.textContent()) ?? "", /Disconnected|Still in mapping draft/i);
      await page.keyboard.press("Escape");

      await revealCanvasItem(page, G915_TWIN_SLUG);
      await twin.focus();
      connected = true;
      await page.waitForFunction(
        (id) => document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
          ?.classList.contains("rd-keyboard-device-node"),
        G915_TWIN_SLUG,
        { timeout: 15_000 },
      );
      assert.equal(await twin.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(
        await twin.evaluate((item) => document.activeElement === item),
        true,
        "reconnecting returns focus to the restored full keyboard board",
      );
      assert.equal(await twin.getAttribute("aria-current"), "true");
      assert.deepEqual(
        await twin.evaluate((item) => ({
          x: item.dataset.canvasX,
          y: item.dataset.canvasY,
          width: item.dataset.canvasWidth,
          height: item.dataset.canvasHeight,
        })),
        twinGeometry,
      );

      await twin.focus();
      connected = false;
      await page.waitForFunction(
        (id) => document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
          ?.dataset.deviceRole === "offline-source",
        G915_TWIN_SLUG,
        { timeout: 15_000 },
      );
      assert.equal(await twin.evaluate((item) => document.activeElement === item), true);
      assert.equal(await twin.getAttribute("aria-current"), "true");
      const removeDisconnected = twin.getByRole("button", {
        name: "Remove disconnected source",
      });
      await revealCanvasItem(page, G915_TWIN_SLUG);
      await twin.focus();
      await twin.press("F2");
      await removeDisconnected.waitFor({ state: "visible", timeout: 15_000 });
      await removeDisconnected.click();
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`),
        G915_TWIN_SLUG,
      );
      assert.equal(removedSelector, G915_TWIN);
      assert.deepEqual(removedAuthority, {
        draft: servedDraftRevision,
        source: "device-recovery-r7",
      });
      assert.equal(await primary.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(new URL(page.url()).searchParams.get("source"), G915);
      assert.deepEqual(noise, []);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await closeContext(recoveryContext);
    }
  });

  test("Theme and additive Device changes share one serialized island mutation", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    const g915PickerRow = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    if ((await g915PickerRow.getAttribute("aria-pressed")) === "true") {
      await g915PickerRow.click();
    }
    await page.waitForFunction(
      (id) => !document.querySelector(
        `.forma-canvas-stage [data-instance-id="${id}"]`,
      ),
      G915_SLUG,
    );
    assert.equal(
      await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).count(),
      0,
      "the regression starts with one keyboard available to add",
    );
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`${BASE}/redesign/device`, async (route) => {
      await requestGate;
      await route.continue();
    });
    let deviceRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/redesign/device") deviceRequests += 1;
    });
    try {
      const requestStarted = page.waitForRequest(`${BASE}/redesign/device`);
      await g915PickerRow.click();
      await requestStarted;
      assert.equal(
        await page.locator('.rd-thememenu button[type="submit"]:not(:disabled)').count(),
        0,
        "Theme cannot race a Device request's full-payload repaint",
      );
      assert.ok(
        await page.locator('.rd-devmodal [data-nx="rd-dev-toggle"]:not(:disabled)').count() > 0,
        "the multi-add tray remains browsable while the request owns mutation authority",
      );
      await g915PickerRow.click();
      await page.waitForTimeout(50);
      assert.equal(
        deviceRequests,
        1,
        "a second picker gesture is ignored instead of racing the in-flight source add",
      );
      assert.equal(
        await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).count(),
        0,
        "the board mounts only after staged-source authority commits",
      );
      releaseRequest();
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .mappingAvailable === "true",
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0, "the Add tray stays open");
      assert.equal(
        await g915PickerRow.evaluate((button) => button === document.activeElement),
        true,
        "the delayed response leaves focus with the active picker control",
      );
      assert.equal(
        await page.locator('.rd-thememenu button[type="submit"]:disabled').count(),
        0,
        "the shared lock releases after repaint",
      );
      assert.equal(
        await page.locator(
          `.forma-canvas-stage [data-instance-id="${G915_SLUG}"] .rd-stagebtn`,
        ).count(),
        0,
        "the committed keyboard is a full source board, never a staging card",
      );
    } finally {
      releaseRequest();
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("a Device add whose authority refresh loses the hardware never mounts a stale board", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    const row = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    if ((await row.getAttribute("aria-pressed")) === "true") {
      await row.click();
      await page.waitForFunction(
        (id) => !document.querySelector(
          `.forma-canvas-stage [data-instance-id="${id}"]`,
        ),
        G915_SLUG,
        { timeout: 10_000 },
      );
    }
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const tier of ["keyboards", "encoders", "experimental"]) {
        payload.devices[tier] = payload.devices[tier].filter((row) => row.selector !== G915);
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await row.click();
      await page.waitForFunction(
        () => !document.querySelector("[data-rd-mutation-pending]"),
        null,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.locator(
          `.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`,
        ).count(),
        0,
        "an exact device absent from the authoritative repaint cannot be mounted from the stale clicked row",
      );
      assert.equal(
        await page.locator('[data-nx="rd-devs-close"]').evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "focus lands on the durable tray close when the initiating row disappears",
      );
      assert.equal(
        await page.locator(".rd-inspector[hidden]").count(),
        1,
        "authoritative disappearance closes the removed board's Inspector",
      );
      assert.equal(
        await page.locator(".rd.is-inspector-open").count(),
        0,
        "authoritative disappearance releases the Inspector's safe inset",
      );

      await page.locator('[data-nx="rd-devs-close"]').click();
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      // Measure the UNION of every mounted widget, not one widget: the
      // workbench also carries the staged controller cards now, so a single
      // card legitimately sits off-centre after Fit. A stale Inspector inset
      // would shift the whole union, so the claim under test is unchanged —
      // it is just population-independent.
      const centerError = await page.evaluate(() => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const items = Array.from(
          document.querySelectorAll(".forma-canvas-stage > [data-instance-id]"),
        ).map((item) => item.getBoundingClientRect());
        if (!viewport || items.length === 0) return Number.POSITIVE_INFINITY;
        const left = Math.min(...items.map((r) => r.left));
        const right = Math.max(...items.map((r) => r.right));
        return Math.abs((left + right) / 2 - (viewport.left + viewport.width / 2));
      });
      assert.ok(
        centerError <= 5,
        `Fit still used a stale Inspector inset (${centerError}px from the full canvas centre)`,
      );
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("provider unknown is preserved, authoritative absence unmounts, and return restores geometry", async () => {
    const page = await openBench();
    const item = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    if (await item.count() === 0) {
      await page.click('[data-nx="rd-devs-open"]');
      await page.locator(`.rd-devmodal button[data-selector="${G915}"]`).click();
      await page.keyboard.press("Escape");
    }
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
          ?.dataset.canvasX !== undefined,
      G915_SLUG,
    );
    let rosterMode = "staging-unreachable";
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (rosterMode === "staging-unreachable") {
        for (const tier of ["keyboards", "encoders", "experimental", "other"]) {
          for (const row of payload.devices[tier] ?? []) {
            row.aria_current = row.selector === G915 ? "true" : "false";
          }
        }
        payload.devices.staging_reachable = false;
        payload.devices.staging_line = "Staging unavailable — test helper did not answer.";
      } else if (rosterMode === "unknown-scan") {
        payload.devices.scan_authoritative = false;
        payload.devices.scan_line = "Device scan unavailable — try again.";
        for (const tier of ["keyboards", "encoders", "experimental", "other"]) {
          payload.devices[tier] = [];
        }
      } else if (rosterMode === "absent") {
        for (const tier of ["keyboards", "encoders", "experimental"]) {
          payload.devices[tier] = payload.devices[tier].filter((row) => row.selector !== G915);
        }
      } else if (rosterMode === "full") {
        for (const tier of ["keyboards", "encoders", "experimental", "other"]) {
          for (const row of payload.devices[tier] ?? []) {
            row.aria_current = row.selector === G915 ? "true" : "false";
          }
        }
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="matrix"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .stagingReachable === "false",
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(
        await item.locator(".rd-stagebtn").count(),
        0,
        "a keyboard board never regresses to the retired card-level staging verb",
      );
      assert.equal(await item.getAttribute("data-mapping-available"), "false");
      await page.waitForFunction(() => !document.querySelector("[data-rd-mutation-pending]"));
      await item.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")?.dataset.canvasZoomTier === "editing",
      );
      assert.equal(
        await item.locator("[data-rd-keyboard-surface]").count(),
        1,
        "provider failure preserves the keyboard-shaped board",
      );
      await page.keyboard.press("Escape");

      rosterMode = "unknown-scan";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="dark"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .scanAuthoritative === "false",
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await item.count(), 1, "a refused scan is unknown, not an empty machine");
      assert.match(
        (await item.locator("[data-rd-keyboard-mapping-status]").textContent()) ?? "",
        /Connection status unavailable.*mapping are paused/i,
      );
      assert.equal(
        await page.locator('[data-mapping-available="true"]').count(),
        0,
        "no device is editable while the scan is unknown",
      );
      assert.equal(
        await item.locator("[data-rd-keyboard-surface]").count(),
        1,
        "unknown connection truth does not remove or reparent its full surface",
      );
      assert.equal(await item.getAttribute("data-source-enabled"), "unknown");
      assert.equal(await item.getAttribute("data-mapping-available"), "false");
      assert.equal(
        await page.locator(
          "[data-rd-global-source-controls-host] [data-rd-source-controls]",
        ).count(),
        1,
        "session-wide source policy remains global while connection truth is unknown",
      );
      const beforeRemoval = await item.evaluate((node) => ({
        x: Number(node.dataset.canvasX),
        y: Number(node.dataset.canvasY),
        width: Number(node.dataset.canvasWidth),
        height: Number(node.dataset.canvasHeight),
      }));

      rosterMode = "absent";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="light"]) button');
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.evaluate((selector) => {
          const saved = JSON.parse(localStorage.getItem("ksx-redesign-canvas") ?? "{}");
          return saved.bench?.includes(selector) === true;
        }, G915),
        true,
        "temporary absence keeps browser-owned membership",
      );

      rosterMode = "full";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="system"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.deepEqual(
        await item.evaluate((node) => ({
          x: Number(node.dataset.canvasX),
          y: Number(node.dataset.canvasY),
          width: Number(node.dataset.canvasWidth),
          height: Number(node.dataset.canvasHeight),
        })),
        beforeRemoval,
        "the returning board reclaims the exact saved geometry",
      );
      assert.equal(await item.getAttribute("data-mapping-available"), "true");
      assert.equal(await item.locator("[data-rd-keyboard-surface]").count(), 1);
      assert.equal(await item.locator("[data-rd-source-controls]").count(), 0);
      assert.equal(
        await page.locator(
          "[data-rd-global-source-controls-host] [data-rd-source-controls]",
        ).count(),
        1,
      );
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("one dynamic encoder profile lab renders only what its evidence justifies", async () => {
    const page = await openBench();
    const hardwareCalls = [];
    page.on("request", (request) => {
      if (/\/api\/panel\/(?:chart|truth)/.test(new URL(request.url()).pathname)) {
        hardwareCalls.push({ method: request.method(), url: request.url() });
      }
    });
    const toggle = page.locator('[data-nx="rd-encoder-profiles"]');
    const beforeCount = await page.locator(
      ".forma-canvas-stage > [data-instance-id]",
    ).count();
    const beforeTransform = await page.locator(".forma-canvas-stage").evaluate(
      (stage) => stage.style.transform,
    );

    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(await toggle.getAttribute("aria-label"), "Encoder profiles");
    assert.equal(await toggle.getAttribute("hidden"), "");
    assert.equal(await toggle.getAttribute("aria-hidden"), "true");
    await toggleEncoderResearchHarness(page);
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-encoder-profile-node").length === 1,
    );

    const node = page.locator(".rd-encoder-profile-node");
    const model = node.locator("[data-rd-encoder-model]");
    const encoderStatus = node.locator("[data-rd-encoder-status]");
    assert.equal(
      await node.evaluate((item) => {
        const ownZ = Number(item.dataset.canvasZ);
        const otherZ = Array.from(
          item.parentElement?.querySelectorAll(":scope > [data-instance-id][data-canvas-z]") ?? [],
        ).filter((candidate) => candidate !== item)
          .map((candidate) => Number(candidate.dataset.canvasZ));
        return otherZ.every((z) => ownZ > z);
      }),
      true,
      "the newly opened research surface owns the top canvas layer",
    );
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await node.locator("svg").count(), 1, "the lab has one native SVG slot");
    assert.equal(
      await node.getAttribute("data-canvas-resizable"),
      "false",
      "the review hull stays stable while evidence changes",
    );
    assert.equal(
      await page.locator(".rd-map-count").textContent(),
      `${beforeCount + 1} widget${beforeCount + 1 === 1 ? "" : "s"}`,
      "the minimap counts one lab, not one node per profile",
    );
    assert.match(
      await page.locator(".n-live-sr:not([data-rd-encoder-status])").textContent(),
      /passive identity facts.*no hardware read or write/i,
    );

    const initialGeometry = await node.evaluate((item) => ({
      x: item.dataset.canvasX,
      y: item.dataset.canvasY,
      width: item.dataset.canvasWidth,
      height: item.dataset.canvasHeight,
    }));
    // Keyboard focus may legitimately reveal a clipped native control once.
    // Take the stability baseline after that accessibility adjustment.
    await model.focus();
    await page.waitForTimeout(50);
    let fittedTransform = await page.locator(".forma-canvas-stage").evaluate(
      (stage) => stage.style.transform,
    );

    assert.equal(await model.inputValue(), `connected:${IPAC}`);
    assert.match(
      await model.locator("option:checked").textContent(),
      /usb:d209:0430:00/i,
      "the connected option exposes the collision-free backend identity",
    );
    assert.equal(
      await node.locator(".rd-encoder-profile").getAttribute("data-profile-id"),
      "ultimarc-ipac4",
    );
    assert.equal(
      await node.locator("[data-rd-encoder-evidence]").getAttribute("data-evidence-state"),
      "backend-family",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 56);
    assert.deepEqual(
      await node.locator("[data-terminal-id]").evaluateAll((terminals) => {
        const ids = terminals.map((terminal) => terminal.getAttribute("data-terminal-id"));
        return {
          first: ids[0],
          last: ids.at(-1),
          unique: new Set(ids).size,
        };
      }),
      { first: "1up", last: "4coin", unique: 56 },
      "the connected I-PAC uses the measured backend terminal vocabulary",
    );
    assert.match(await node.textContent(), /configuration read available/i);
    assert.match(await node.textContent(), /this lab did not read it/i);
    assert.equal(hardwareCalls.length, 0, "opening the lab never starts a chart transaction");

    const rosterSummary = node.locator(".rd-encoder-profile-roster > summary");
    await rosterSummary.focus();
    await rosterSummary.press("Escape");
    await page.waitForFunction(
      () => document.activeElement?.classList.contains("rd-encoder-profile-node"),
    );
    assert.equal(
      await node.evaluate((item) => item === document.activeElement),
      true,
      "Escape returns from a native details summary to the widget shell",
    );
    fittedTransform = await page.locator(".forma-canvas-stage").evaluate(
      (stage) => stage.style.transform,
    );

    await model.selectOption("catalog:ultimarc-ultimate-io");
    await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
        "ultimarc-ultimate-io",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 48);
    assert.equal(await encoderStatus.count(), 1, "the live status remains one stable node");
    await page.waitForFunction(
      () => document.querySelector(".rd-encoder-profile-node [data-rd-encoder-status]")?.textContent
        ?.includes("User-selected reference"),
    );
    assert.match(await node.textContent(), /96 LED output channels/i);
    assert.match(await node.textContent(), /six inputs may be reassigned to optical axes/i);

    await model.selectOption("catalog:brook-ufb-fusion");
    await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
        "brook-ufb-fusion",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 18);
    assert.equal(
      await node.locator('[data-terminal-id][data-identity-scope="physical-terminal"]').count(),
      0,
      "Brook is a logical control reference, not a fabricated screw layout",
    );
    assert.match(await node.textContent(), /does not claim a physical terminal count/i);
    assert.equal(
      await page.locator(".forma-canvas-stage").evaluate((stage) => stage.style.transform),
      fittedTransform,
      "switching profile drawings does not move the camera",
    );

    await model.selectOption("catalog:ultimarc-jpac");
    await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
        "ultimarc-jpac",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 31);
    assert.equal(
      await node.locator('[data-terminal-id][data-connection]:not([data-connection="logical"])').count(),
      0,
      "the merged J-PAC family never invents variant-specific edge/screw routing",
    );
    assert.deepEqual(
      await node.locator('[data-terminal-id="1b7"], [data-terminal-id="1b8"]').evaluateAll(
        (terminals) => terminals.map((terminal) =>
          terminal.querySelector(".rd-encoder-profile-terminal-label")?.textContent
        ),
      ),
      ["B7", "B8"],
      "variant buttons remain visually distinguishable in the compact board drawing",
    );
    assert.match(await node.textContent(), /27 or 31 variant-dependent controls/i);

    await model.selectOption("sample:ambiguous-minipac");
    await page.waitForFunction(
      () => document.querySelector(".rd-encoder-profile-node [data-rd-encoder-evidence]")?.getAttribute(
        "data-evidence-state",
      ) === "ambiguous-family",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 0);
    assert.equal(await node.locator("[data-profile-candidate]").count(), 2);
    assert.match(await node.textContent(), /knows the family, not the variant/i);
    await node.locator(
      '[data-profile-candidate="ultimarc-minipac-four"] input',
    ).click();
    await page.waitForFunction(
      () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
        "ultimarc-minipac-four",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 56);
    assert.equal(
      await node.locator("[data-rd-encoder-evidence]").getAttribute("data-profile-provenance"),
      "manual",
      "confirmation changes the drawing but remains user provenance",
    );
    assert.match(await model.inputValue(), /ambiguous-minipac$/);
    await page.waitForFunction(
      () => document.activeElement?.hasAttribute("data-rd-encoder-model"),
    );
    assert.equal(
      await model.evaluate((select) => select === document.activeElement),
      true,
      "confirmation returns focus to the stable model selector",
    );

    await model.selectOption("sample:unknown-hid");
    await page.waitForFunction(
      () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId === "unknown-hid",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 0);
    assert.equal(
      await node.locator(".rd-encoder-profile-svg [data-observed-signal-id]").count(),
      6,
    );
    assert.equal(await node.locator("svg").getAttribute("data-capacity"), "unknown");
    assert.match(await node.textContent(), /terminal capacity unknown/i);
    assert.equal(
      await node.locator(".rd-encoder-profile-metric dt").last().textContent(),
      "illustrative signal sample",
      "fixture-only keys are never counted as observed hardware evidence",
    );
    assert.match(await node.textContent(), /terminal not associated/i);
    assert.match(await node.textContent(), /no exact backend encoder identity is available/i);
    assert.doesNotMatch(
      await node.textContent(),
      /backend classified this as an encoder/i,
      "the generic sample does not pretend the backend recognized an unknown model",
    );

    const manualLabels = node.locator("[data-rd-encoder-manual-labels]");
    await manualLabels.fill("UP, DOWN, LEFT, RIGHT, SW1, SW2");
    await node.getByRole("button", { name: "Apply declared labels" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-encoder-profile-node [data-declared-terminal-id]").length === 6,
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 0);
    assert.equal(await node.locator("[data-declared-terminal-id]").count(), 6);
    assert.match(await node.textContent(), /user-declared slots only/i);

    assert.deepEqual(
      await node.evaluate((item) => ({
        x: item.dataset.canvasX,
        y: item.dataset.canvasY,
        width: item.dataset.canvasWidth,
        height: item.dataset.canvasHeight,
      })),
      initialGeometry,
      "profile changes repaint one node without changing canvas geometry",
    );
    assert.equal(hardwareCalls.length, 0, "catalog, ambiguity, and fallback stay read-only");

    await page.waitForTimeout(50);
    const canvasViewport = page.locator(".forma-canvas-viewport");
    for (let step = 0; step < 8; step += 1) {
      if (await canvasViewport.getAttribute("data-canvas-zoom-tier") === "overview") break;
      await page.click('[data-nx="canvas-zoom-out"]');
    }
    assert.equal(await canvasViewport.getAttribute("data-canvas-zoom-tier"), "overview");
    await node.focus();
    await node.press("F2");
    await page.waitForFunction(
      () => document.querySelector(".forma-canvas-viewport")?.dataset.canvasZoomTier === "editing",
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        model: document.activeElement?.hasAttribute("data-rd-encoder-model") ?? false,
        manual: document.activeElement?.hasAttribute("data-rd-encoder-manual-labels") ?? false,
      })),
      { tag: "SELECT", model: true, manual: false },
      "F2 enters the lab's first native control",
    );
    await model.press("Escape");
    await page.waitForFunction(
      () => document.activeElement?.classList.contains("rd-encoder-profile-node"),
    );
    assert.equal(
      await node.evaluate((item) => item === document.activeElement),
      true,
      "Escape returns from an adapter-less native control to the widget shell",
    );

    await page.setViewportSize({ width: 420, height: 900 });
    assert.equal(await toggle.isHidden(), true, "the internal harness has no product chrome");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "the lab adds no page-level horizontal overflow",
    );
    assert.deepEqual(
      await node.locator(".rd-encoder-profile").evaluate((card) => ({
        horizontal: card.scrollWidth <= card.clientWidth,
        vertical: card.scrollHeight <= card.clientHeight,
      })),
      { horizontal: true, vertical: true },
      "the fixed review hull contains every state",
    );
    await page.setViewportSize({ width: 1600, height: 1000 });

    await toggleEncoderResearchHarness(page);
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-encoder-profile-node").length === 0,
    );
    await page.waitForFunction(
      (transform) => document.querySelector(".forma-canvas-stage")?.style.transform === transform,
      beforeTransform,
    );
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(
      await page.locator(".rd-map-count").textContent(),
      beforeCount === 1 ? "1 widget" : `${beforeCount} widgets`,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("ksx-redesign-canvas") ?? "{}");
        return Object.keys(saved.widgets ?? {}).filter((key) => key === "encoder-profile-lab");
      }),
      [],
      "hiding the lab leaves no review geometry in the durable arrangement",
    );

    await toggleEncoderResearchHarness(page);
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-encoder-profile-node").length === 1,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      (transform) => document.querySelector(".forma-canvas-stage")?.style.transform === transform,
      beforeTransform,
      { timeout: 20_000 },
    );
    assert.equal(await page.locator(".rd-encoder-profile-node").count(), 0);
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("the encoder lab reads one exact complete chart only after explicit consent", async () => {
    const page = await openBench();
    const chartRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/panel/chart") chartRequests.push(request);
    });
    await toggleEncoderResearchHarness(page);
    const node = page.locator(".rd-encoder-profile-node");
    const expectedIds = getEncoderVisualProfile("ultimarc-ipac4").topology.terminals
      .map((terminal) => terminal.id);

    assert.equal(chartRequests.length, 0, "opening the lab makes no chart request");
    assert.equal(await node.locator('[data-rd-encoder-chart][data-state="idle"]').count(), 1);
    const [response] = await Promise.all([
      page.waitForResponse((candidate) =>
        new URL(candidate.url()).pathname === "/api/panel/chart" &&
        candidate.request().method() === "POST"
      ),
      node.getByRole("button", { name: "Read configured emissions" }).click(),
    ]);
    const payload = await response.json();
    assert.equal(chartRequests.length, 1, "one activation makes one read transaction");
    assert.deepEqual(chartRequests[0].postDataJSON(), { selector: IPAC });
    assert.deepEqual(
      payload.terminals.map((terminal) => terminal.terminal_id),
      expectedIds,
      "the fixture and visual profile agree on the complete ordered 56-terminal roster",
    );
    assert.equal(validateEncoderChart(payload, expectedIds, "2026-08-28T00:00:00Z").ok, true);
    assert.equal(
      validateEncoderChart({ ...payload, terminals: payload.terminals.slice(0, -1) }, expectedIds).ok,
      false,
      "a partial chart is withheld atomically",
    );
    assert.equal(
      validateEncoderChart({
        ...payload,
        terminals: [...payload.terminals.slice(0, -1), payload.terminals[0]],
      }, expectedIds).ok,
      false,
      "a duplicate terminal cannot masquerade as a complete chart",
    );
    assert.equal(
      validateEncoderChart({ ...payload, image_sha256: "not-a-proof" }, expectedIds).ok,
      false,
      "an invalid proof hash is withheld",
    );
    const { shift: _omittedShift, ...withoutShift } = payload;
    assert.equal(
      validateEncoderChart(withoutShift, expectedIds).ok,
      false,
      "a successful roster without its board-level Shift summary is withheld",
    );
    assert.equal(
      validateEncoderChart({
        ...payload,
        terminals: payload.terminals.map((terminal, index) => index === 0
          ? { ...terminal, normal: { ...terminal.normal, code: 65_536 } }
          : terminal),
      }, expectedIds).ok,
      false,
      "a value outside the backend's u16 contract is withheld",
    );
    assert.equal(
      validateEncoderChart({
        ...payload,
        shift: { state: "enabled", terminal_id: "not-a-terminal", terminal_label: "Ghost", reachable: 1 },
      }, expectedIds).ok,
      false,
      "a board-level Shift claim cannot point outside the exact roster",
    );
    assert.equal(
      validateEncoderChart({
        ...payload,
        shift: { state: "none-enabled", stranded: expectedIds.length + 1, opaque: 0 },
      }, expectedIds).ok,
      false,
      "impossible board-level Shift counts are withheld",
    );
    const twoShiftRows = payload.terminals.map((terminal, index) => index < 2
      ? { ...terminal, shift_state: "enabled", is_shift: true }
      : terminal);
    assert.equal(
      validateEncoderChart({
        ...payload,
        terminals: twoShiftRows,
        shift: {
          state: "enabled",
          terminal_id: twoShiftRows[0].terminal_id,
          terminal_label: twoShiftRows[0].terminal_label,
          reachable: 1,
        },
      }, expectedIds).ok,
      false,
      "an enabled summary cannot hide a second Shift row",
    );

    await page.waitForFunction(
      () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-chart]')?.getAttribute("data-state") ===
        "loaded",
    );
    assert.equal(await node.locator("[data-rd-encoder-chart-row]").count(), 56);
    assert.equal(
      await node.locator('[data-rd-encoder-chart-row] th[scope="row"]').count(),
      56,
      "terminal identity is the accessible row header for each emission pair",
    );
    assert.equal(
      await node.locator('[data-rd-encoder-chart-row] th[scope="row"]').first()
        .evaluate((cell) => getComputedStyle(cell).position),
      "static",
      "row headers never stick over the column header while the table scrolls",
    );
    assert.deepEqual(
      await node.locator("[data-rd-encoder-chart-row]").evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-terminal-roster-id"))
      ),
      expectedIds,
      "the detailed table joins every stored emission to the profile-owned terminal ID",
    );
    assert.equal(
      await node.locator("[data-terminal-id][data-configured-emission]").count(),
      56,
      "the compact board paints only the validated all-terminal snapshot",
    );
    assert.match(await node.textContent(), /proof [0-9a-f]{16}/i);
    assert.match(await node.locator("[data-rd-encoder-chart-status] time").textContent(), /read at/i);
    assert.match(
      await node.textContent(),
      /nothing stored.*or a macro/i,
      "zero bytes retain their on-board macro ambiguity",
    );
    assert.match(await node.textContent(), /physical wiring remains a separate, unknown fact/i);
    assert.equal(
      await node.locator('[data-rd-encoder-observe="start"]').isDisabled(),
      false,
      "a completed read releases the observer control",
    );

    await node.locator("[data-rd-encoder-model]").selectOption("catalog:ultimarc-ipac2");
    assert.equal(await node.locator("[data-rd-encoder-read]").count(), 0);
    assert.equal(await node.locator("[data-rd-encoder-chart-row]").count(), 0);
    assert.equal(chartRequests.length, 1, "catalog selection never authorizes another read");
    await toggleEncoderResearchHarness(page);
    await page.waitForFunction(() => !document.querySelector(".rd-encoder-profile-node"));
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("a pending chart locks observation and a stale response cannot repaint another profile", async () => {
    const page = await openBench();
    let releaseChart;
    let reportChart;
    let reportFulfilled;
    const chartGate = new Promise((resolve) => { releaseChart = resolve; });
    const chartSeen = new Promise((resolve) => { reportChart = resolve; });
    const chartFulfilled = new Promise((resolve) => { reportFulfilled = resolve; });
    await page.route("**/api/panel/chart", async (route) => {
      const request = route.request();
      const response = await route.fetch();
      const payload = await response.json();
      reportChart({ method: request.method(), body: request.postDataJSON() });
      await chartGate;
      await route.fulfill({ response, json: payload });
      reportFulfilled();
    });

    try {
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      await node.getByRole("button", { name: "Read configured emissions" }).click();
      assert.deepEqual(
        await chartSeen,
        { method: "POST", body: { selector: IPAC } },
      );
      assert.equal(await node.locator('[data-rd-encoder-chart][data-state="loading"]').count(), 1);
      assert.equal(await node.locator('[data-rd-encoder-observe="start"]').isDisabled(), true);
      assert.equal(await node.locator('[data-rd-encoder-observe="start"]').textContent(), "Wait for chart read");

      await node.locator("[data-rd-encoder-model]").selectOption("catalog:ultimarc-ipac2");
      assert.equal(await node.locator("[data-rd-encoder-read]").count(), 0);
      releaseChart();
      await chartFulfilled;
      await page.waitForTimeout(50);
      assert.equal(await node.locator("[data-rd-encoder-model]").inputValue(), "catalog:ultimarc-ipac2");
      assert.equal(await node.locator("[data-rd-encoder-chart-row]").count(), 0);
      assert.equal(await node.locator('[data-rd-encoder-chart][data-state="loaded"]').count(), 0);
      assert.doesNotMatch(await node.textContent(), /proof [0-9a-f]{16}/i);
      assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    } finally {
      releaseChart?.();
      await closePage(page);
    }
  });

  test("signal observation is exact-device, generation-bound, contained, and releasable", async () => {
    const page = await openBench();
    const calls = [];
    const allRequests = [];
    page.on("request", (request) => {
      allRequests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
      });
    });
    let active = false;
    let pollUnexpected = false;
    let preflightMode = "normal";
    let startAsUnknown = false;
    let generation = 40;
    const view = (state, overrides = {}) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : generation,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_500 : null,
      held: state === "listening" ? ["ArrowRight"] : [],
      seen: state === "idle" ? [] : ["ArrowRight", "Digit1", "Enter"],
      peak: state === "idle" ? 0 : 2,
      events: state === "idle" ? 0 : 6,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Exact-device evidence only.",
      error: null,
      ...overrides,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({ path: pathName, method: request.method(), body });
      if (pathName === "/api/input-test/start") {
        generation += 1;
        active = true;
        await route.fulfill({
          status: 200,
          json: view(startAsUnknown ? "future-running" : "listening"),
        });
      } else if (pathName === "/api/input-test/cancel") {
        assert.deepEqual(body, { generation });
        active = false;
        await route.fulfill({
          status: 200,
          json: view("cancelled", { generation: body.generation }),
        });
      } else {
        await route.fulfill({
          status: 200,
          json: preflightMode === "unknown"
            ? view("future-lease", { generation: 700, selector: IPAC })
            : preflightMode === "listening-exact"
              ? view("listening", { generation: 700, selector: IPAC })
            : active
              ? pollUnexpected
                ? view("unavailable", {
                  ok: false,
                  generation: null,
                  selector: null,
                  error: "The observer returned an unexpected owned state.",
                })
                : view("listening")
              : view("idle"),
        });
      }
    });

    try {
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      assert.deepEqual(calls, [], "opening and selecting the lab never starts observation");
      const beforeGeometry = await node.evaluate((item) => ({
        x: item.dataset.canvasX,
        y: item.dataset.canvasY,
        width: item.dataset.canvasWidth,
        height: item.dataset.canvasHeight,
      }));

      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      assert.deepEqual(calls.slice(0, 2), [
        { path: "/api/input-test", method: "GET", body: null },
        {
          path: "/api/input-test/start",
          method: "POST",
          body: { selector: IPAC, duration_ms: 30_000 },
        },
      ]);
      assert.equal(await node.locator("[data-rd-encoder-read]").isDisabled(), true);
      await page.waitForFunction(
        () => document.activeElement?.hasAttribute("data-rd-encoder-observation-sink"),
      );
      const capturedTransform = await page.locator(".forma-canvas-stage").evaluate(
        (stage) => stage.style.transform,
      );
      const sink = node.locator("[data-rd-encoder-observation-sink]");
      for (const key of ["ArrowRight", "Digit1", "Enter"]) await sink.press(key);
      assert.equal(
        await node.locator('[data-rd-encoder-observation][data-state="listening"]').count(),
        1,
        "captured encoder keys cannot activate Stop",
      );
      assert.equal(
        await page.locator(".forma-canvas-stage").evaluate((stage) => stage.style.transform),
        capturedTransform,
        "captured arrows and number keys do not move the canvas",
      );
      assert.deepEqual(
        await node.evaluate((item) => ({
          x: item.dataset.canvasX,
          y: item.dataset.canvasY,
          width: item.dataset.canvasWidth,
          height: item.dataset.canvasHeight,
        })),
        beforeGeometry,
      );
      assert.equal(calls.filter((call) => call.path === "/api/input-test/cancel").length, 0);
      await sink.press("Tab");
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.matches('[data-rd-encoder-observe="stop"]')
        ),
        true,
        "Tab stays inside the two-stop Capture/Done focus loop",
      );
      await page.keyboard.press("Enter");
      assert.equal(
        calls.filter((call) => call.path === "/api/input-test/cancel").length,
        0,
        "ordinary Enter on Done is treated as captured encoder input",
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.hasAttribute("data-rd-encoder-observation-sink")
        ),
        true,
        "Tab wraps from Done back to Capture",
      );
      pollUnexpected = true;
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "unknown",
      );
      assert.match(await node.textContent(), /stop remains bound to that exact observation/i);
      assert.match(await node.textContent(), /held at last confirmed snapshot/i);

      await node.getByRole("button", { name: "Done — stop listening" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "complete",
      );
      assert.deepEqual(
        calls.find((call) => call.path === "/api/input-test/cancel")?.body,
        { generation: 41 },
        "Stop carries only the exact owned generation",
      );
      assert.match(await node.textContent(), /terminal association: none/i);
      assert.match(await node.textContent(), /usb:d209:0430:00/i);
      assert.equal(await node.locator("[data-terminal-id]").count(), 56);
      assert.equal(await node.locator("[data-rd-encoder-chart-row]").count(), 0);

      pollUnexpected = false;
      preflightMode = "listening-exact";
      await node.getByRole("button", { name: "Check and observe again" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "foreign-live",
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/input-test/start").length,
        1,
        "an existing exact preflight generation blocks rather than being adopted or restarted",
      );
      assert.match(await node.textContent(), /this lab did not start it/i);
      assert.equal(
        await node.getByRole("button", { name: "Recheck observation lease" }).count(),
        1,
      );
      assert.equal(await node.locator("[data-rd-encoder-read]").textContent(), "Observation lease busy");

      preflightMode = "unknown";
      await node.getByRole("button", { name: "Recheck observation lease" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "foreign-live",
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/input-test/start").length,
        1,
        "a recheck never claims or starts over a future live lease",
      );

      preflightMode = "normal";
      await node.getByRole("button", { name: "Recheck observation lease" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "idle",
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/input-test/start").length,
        1,
        "rechecking a cleared foreign lease never starts a new observation",
      );
      assert.equal(await node.locator("[data-rd-encoder-read]").isDisabled(), false);

      startAsUnknown = true;
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "unknown",
      );
      // The state transition is synchronous; its aria-live announcement is
      // queued on the next animation frame. Assert the durable visible model
      // copy here so this safety contract does not race that announcement.
      assert.match(await node.textContent(), /Stop remains bound to its exact generation/i);
      const model = node.locator("[data-rd-encoder-model]");
      const selectionCancel = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/input-test/cancel" &&
        request.postDataJSON()?.generation === 42
      );
      await model.selectOption("catalog:ultimarc-ipac2");
      await selectionCancel;
      assert.equal(await node.locator("[data-rd-encoder-read]").count(), 0);

      await model.selectOption(`connected:${IPAC}`);
      startAsUnknown = false;
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      assert.equal(generation, 43, "each successful start owns a distinct generation");
      const removalCancel = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/input-test/cancel" &&
        request.postDataJSON()?.generation === 43
      );
      await toggleEncoderResearchHarness(page);
      await removalCancel;
      await page.waitForFunction(() => !document.querySelector(".rd-encoder-profile-node"));
      assert.deepEqual(
        calls.filter((call) => call.path === "/api/input-test/cancel").map((call) => call.body),
        [{ generation: 41 }, { generation: 42 }, { generation: 43 }],
        "Stop, selection change, and removal each release only their current exact generation",
      );
      assert.equal(
        allRequests.filter((request) =>
          request.method === "POST" &&
          !["/api/input-test/start", "/api/input-test/cancel"].includes(request.path)
        ).length,
        0,
        `the whole page request log stays read/observe-only: ${JSON.stringify(allRequests)}`,
      );
      assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    } finally {
      await closePage(page);
    }
  });

  test("a replaced observer is never cancelled and a failed Stop retries the same generation", async () => {
    const page = await openBench();
    const calls = [];
    let active = false;
    let generation = 300;
    let pollMode = "normal";
    let failNextCancel = true;
    const view = (state, overrides = {}) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : generation,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_500 : null,
      held: state === "listening" ? ["ArrowUp"] : [],
      seen: state === "idle" ? [] : ["ArrowUp"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 2,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Exact-device evidence.",
      error: null,
      ...overrides,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({ path: pathName, method: request.method(), body });
      if (pathName === "/api/input-test/start") {
        generation += 1;
        active = true;
        await route.fulfill({ status: 200, json: view("listening") });
      } else if (pathName === "/api/input-test/cancel") {
        if (failNextCancel) {
          failNextCancel = false;
          await route.fulfill({
            status: 200,
            json: view("unavailable", {
              ok: false,
              generation: null,
              selector: null,
              error: "Cancellation acknowledgement was unavailable.",
            }),
          });
        } else {
          active = false;
          await route.fulfill({ status: 200, json: view("cancelled") });
        }
      } else {
        await route.fulfill({
          status: 200,
          json: pollMode === "replacement"
            ? view("listening", { generation: 999, selector: G915 })
            : view(active ? "listening" : "idle"),
        });
      }
    });

    try {
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      pollMode = "replacement";
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "foreign-live",
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/input-test/cancel").length,
        0,
        "a replacement selector/generation is never cancelled by the old owner",
      );
      assert.equal(await node.locator('[data-rd-encoder-observe="stop"]').count(), 0);
      assert.match(await node.textContent(), /will not stop or reuse that foreign generation/i);

      active = false;
      pollMode = "normal";
      await node.getByRole("button", { name: "Recheck observation lease" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "idle",
      );
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      assert.equal(generation, 302);
      await node.getByRole("button", { name: "Done — stop listening" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "unknown",
      );
      assert.equal(await node.locator('[data-rd-encoder-observe="stop"]').count(), 1);
      assert.match(
        await node.textContent(),
        /retry Stop for (?:that exact observation|this exact generation)/i,
      );
      assert.deepEqual(
        calls.filter((call) => call.path === "/api/input-test/cancel").map((call) => call.body),
        [{ generation: 302 }],
      );

      await node.getByRole("button", { name: "Done — stop listening" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "complete",
      );
      assert.deepEqual(
        calls.filter((call) => call.path === "/api/input-test/cancel").map((call) => call.body),
        [{ generation: 302 }, { generation: 302 }],
        "retry never broadens or changes the owned generation",
      );
      assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    } finally {
      await closePage(page);
    }
  });

  test("pending starts and page hide release their exact generations while capture stays contained", async () => {
    const page = await openBench();
    const calls = [];
    let active = false;
    let generation = 90;
    let releaseStart;
    let reportStart;
    let reportStartFulfilled;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const startSeen = new Promise((resolve) => { reportStart = resolve; });
    const startFulfilled = new Promise((resolve) => { reportStartFulfilled = resolve; });
    const view = (state, overrides = {}) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : generation,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_500 : null,
      held: [],
      seen: [],
      peak: 0,
      events: 0,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Late exact start.",
      error: null,
      ...overrides,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({ path: pathName, method: request.method(), body });
      if (pathName === "/api/input-test/start") {
        generation += 1;
        active = true;
        reportStart();
        if (generation === 91) await startGate;
        await route.fulfill({ status: 200, json: view("listening") });
        if (generation === 91) reportStartFulfilled();
      } else if (pathName === "/api/input-test/cancel") {
        active = false;
        await route.fulfill({
          status: 200,
          json: view("cancelled", { generation: body.generation }),
        });
      } else {
        await route.fulfill({ status: 200, json: view(active ? "listening" : "idle") });
      }
    });

    try {
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await startSeen;
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "starting" && document.activeElement?.hasAttribute("data-rd-encoder-observation-sink"),
      );
      const beforeTransform = await page.locator(".forma-canvas-stage").evaluate(
        (stage) => stage.style.transform,
      );
      const sink = node.locator("[data-rd-encoder-observation-sink]");
      for (const key of ["ArrowLeft", "Digit2", "Enter"]) await sink.press(key);
      assert.equal(
        await page.locator(".forma-canvas-stage").evaluate((stage) => stage.style.transform),
        beforeTransform,
        "the start-response gap is already a contained capture state",
      );

      await sink.press("Escape");
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "error" && document.activeElement?.matches('[data-rd-encoder-observe="start"]'),
      );
      assert.match(await node.textContent(), /capture focus was released while start is still resolving/i);
      const lateCancel = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/input-test/cancel" &&
        request.postDataJSON()?.generation === 91
      );
      releaseStart();
      await startFulfilled;
      await lateCancel;

      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      const pageHideCalls = await page.evaluate(() => {
        const originalFetch = window.fetch;
        const captured = [];
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
          if (new URL(url, location.href).pathname === "/api/input-test/cancel") {
            captured.push({
              method: init?.method,
              keepalive: init?.keepalive,
              body: JSON.parse(String(init?.body ?? "{}")),
            });
            return Promise.resolve(new Response(JSON.stringify({
              ok: true,
              state: "cancelled",
              generation: 92,
              selector: "usb:d209:0430:00",
              remaining_ms: null,
              held: [],
              seen: [],
              peak: 0,
              events: 0,
              dropped: 0,
              rollover_visibility: "unavailable",
              detail: "Stopped on page hide.",
              error: null,
            }), { status: 200, headers: { "content-type": "application/json" } }));
          }
          return originalFetch(input, init);
        };
        window.dispatchEvent(new Event("pagehide"));
        window.fetch = originalFetch;
        return captured;
      });
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      assert.deepEqual(
        calls.filter((call) => call.path === "/api/input-test/cancel").map((call) => call.body),
        [{ generation: 91 }],
        "a superseded pending start releases only the late exact generation",
      );
      assert.deepEqual(
        pageHideCalls,
        [{ method: "POST", keepalive: true, body: { generation: 92 } }],
        "page hide sends one keepalive cancellation for only the currently owned generation",
      );
      assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    } finally {
      releaseStart?.();
      await closePage(page);
    }
  });

  test("an unknown connected encoder shows a bounded 12-signal preview and releases on disappearance", async () => {
    const page = await openBench();
    const emissions = Array.from({ length: 12 }, (_, index) => `Signal-${index + 1}`);
    const inputCalls = [];
    let active = false;
    let rosterMode = "unknown";
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.encoders.find((row) => row.selector === IPAC);
      assert.ok(original, "the fixture must serve its I-PAC encoder");
      const unknown = {
        ...original,
        name: "Unidentified twelve-signal encoder",
        family_id: null,
        protocol_profile: null,
        profile_state: "unrecognised",
        terminal_count: null,
        chart_readable: "false",
      };
      payload.devices.encoders = rosterMode === "unknown" ? [unknown] : [];
      await route.fulfill({ response, json: payload });
    });
    const observationView = (state) => ({
      ok: true,
      state,
      generation: state === "idle" ? null : 61,
      selector: state === "idle" ? null : IPAC,
      remaining_ms: state === "listening" ? 29_000 : null,
      held: state === "listening" ? emissions.slice(0, 2) : [],
      seen: state === "idle" ? [] : emissions,
      peak: 2,
      events: emissions.length,
      dropped: 0,
      rollover_visibility: "unavailable",
      detail: state === "idle" ? "No observation is active." : "Exact-device signals.",
      error: null,
    });
    await page.route("**/api/input-test**", async (route) => {
      const request = route.request();
      const pathName = new URL(request.url()).pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      inputCalls.push({ path: pathName, body });
      if (pathName === "/api/input-test/start") {
        active = true;
        await route.fulfill({ status: 200, json: observationView("listening") });
      } else if (pathName === "/api/input-test/cancel") {
        assert.deepEqual(body, { generation: 61 });
        active = false;
        await route.fulfill({ status: 200, json: observationView("cancelled") });
      } else {
        await route.fulfill({
          status: 200,
          json: observationView(active ? "listening" : "idle"),
        });
      }
    });

    try {
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="system"]) button');
      await page.waitForFunction(
        (selector) => document.querySelector(`button[data-selector="${selector}"]`)?.textContent
          ?.includes("Unidentified twelve-signal encoder"),
        IPAC,
      );
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      assert.equal(await node.locator(".rd-encoder-profile").getAttribute("data-profile-id"), "unknown-hid");
      assert.equal(await node.locator("[data-rd-encoder-read]").count(), 0);
      await node.getByRole("button", { name: "Observe emitted signals" }).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile-node [data-rd-encoder-observation]')?.getAttribute("data-state") ===
          "listening",
      );
      const drawing = node.locator('svg[data-profile-id="unknown-hid"]');
      assert.deepEqual(
        await drawing.evaluate((svg) => ({
          observed: svg.dataset.observedCount,
          hidden: svg.dataset.hiddenObservedCount,
          kind: svg.dataset.observationKind,
        })),
        { observed: "12", hidden: "3", kind: "exact-device" },
      );
      assert.equal(await drawing.locator("[data-observed-signal-id]").count(), 9);
      assert.equal(
        await drawing.locator("[data-observed-signal-id]").evaluateAll((signals) =>
          signals.every((signal) => {
            const box = signal.getBoundingClientRect();
            const board = signal.ownerSVGElement
              ?.querySelector(".rd-encoder-profile-board")?.getBoundingClientRect();
            return Boolean(board) && box.left >= board.left && box.right <= board.right &&
              box.top >= board.top && box.bottom <= board.bottom;
          })
        ),
        true,
        "every compact signal card stays inside the board body",
      );
      assert.match(await drawing.locator("desc").textContent(), /complete evidence list remains available/i);
      assert.equal(
        await node.locator('.rd-encoder-profile-roster[data-observation-sample="false"] [role="listitem"]').count(),
        12,
        "the detailed evidence list retains every observed signal",
      );
      assert.equal(await node.locator("[data-terminal-id]").count(), 0);

      rosterMode = "gone";
      const disappearanceCancel = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/input-test/cancel" &&
        request.postDataJSON()?.generation === 61
      );
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="matrix"]) button');
      await disappearanceCancel;
      await page.waitForFunction(
        () => !document.querySelector('.rd-encoder-profile-node [data-rd-encoder-model] option[value^="connected:"]'),
      );
      assert.equal(
        inputCalls.filter((call) => call.path === "/api/input-test/cancel").length,
        1,
        "device disappearance releases the exact owned generation once",
      );
      assert.equal(await node.locator('[data-rd-encoder-observe="start"]').count(), 0);
      assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    } finally {
      await closePage(page);
    }
  });

  test("encoder controls keep accessible targets in forced colors and coarse-pointer mode", async () => {
    const accessibleContext = await browser.newContext({
      viewport: { width: 420, height: 900 },
      colorScheme: "dark",
      forcedColors: "active",
      hasTouch: true,
    });
    const page = await accessibleContext.newPage();
    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await toggleEncoderResearchHarness(page);
      const node = page.locator(".rd-encoder-profile-node");
      await node.focus();
      await node.press("F2");
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")?.dataset.canvasZoomTier ===
          "editing",
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          forced: matchMedia("(forced-colors: active)").matches,
          coarse: matchMedia("(pointer: coarse)").matches,
          overflow: document.documentElement.scrollWidth <= innerWidth,
        })),
        { forced: true, coarse: true, overflow: true },
      );
      for (const control of [
        node.locator("[data-rd-encoder-read]"),
        node.locator('[data-rd-encoder-observe="start"]'),
        node.locator(".rd-encoder-profile-roster > summary"),
      ]) {
        const size = await control.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: Number.parseFloat(style.height),
            minHeight: Number.parseFloat(style.minHeight),
          };
        });
        assert.ok(
          size.height >= 44 || size.minHeight >= 44,
          `coarse target CSS height was ${JSON.stringify(size)}`,
        );
      }
      assert.equal(
        await node.locator("[data-terminal-id]").first().evaluate((terminal) =>
          getComputedStyle(terminal.querySelector("rect")).stroke !== "none"
        ),
        true,
        "terminal slots retain a forced-colors outline",
      );
    } finally {
      await closeContext(accessibleContext);
    }
  });

  test("an open encoder lab reconciles connected truth by raw selector", async () => {
    const page = await openBench();
    await toggleEncoderResearchHarness(page);
    const node = page.locator(".rd-encoder-profile-node");
    const model = node.locator("[data-rd-encoder-model]");
    const twinSelector = `${IPAC}:mi_01`;
    let rosterMode = "twins";
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.encoders.find((row) => row.selector === IPAC);
      assert.ok(original, "the fixture must serve its I-PAC encoder");
      const left = { ...original, name: "Twin encoder", alias: "left bay" };
      const right = {
        ...original,
        selector: twinSelector,
        name: "Twin encoder",
        alias: rosterMode === "unrelated-roster" ? "right bay renamed" : "right bay",
      };
      if (rosterMode === "ambiguous-minipac" || rosterMode === "measured-minipac-32") {
        Object.assign(left, {
          name: "Ultimarc Mini-PAC",
          family_id: "ultimarc-minipac",
          protocol_profile: null,
          profile_state: "unprofiled-release",
          terminal_count: rosterMode === "measured-minipac-32" ? 32 : null,
          chart_readable: "false",
        });
      } else if (rosterMode === "known-family") {
        Object.assign(left, {
          name: "Ultimarc U-HID",
          family_id: "ultimarc-uhid",
          protocol_profile: null,
          profile_state: "unprofiled-release",
          terminal_count: null,
          chart_readable: "false",
        });
      } else if (rosterMode === "identity-conflict") {
        Object.assign(left, {
          name: "Contradictory I-PAC4",
          family_id: "ultimarc-ipac4",
          protocol_profile: "ipac4-pac256-v1",
          profile_state: "profiled",
          terminal_count: 999,
          chart_readable: "true",
        });
      }
      payload.devices.encoders = rosterMode === "only-twin" ? [right] : [left, right];
      await route.fulfill({ response, json: payload });
    });
    const submitTheme = async (theme) => {
      await page.click(".rd-themed > summary");
      await page.click(`.rd-thememenu form:has(input[value="${theme}"]) button`);
      await page.waitForFunction(() => !document.querySelector("[data-rd-mutation-pending]"));
    };
    try {
      assert.equal(await model.inputValue(), `connected:${IPAC}`);
      await submitTheme("dark");
      await page.waitForFunction(
        () => document.querySelectorAll('.rd-encoder-profile-node [data-rd-encoder-model] option[value^="connected:"]')
          .length === 2,
      );
      assert.equal(
        await model.inputValue(),
        `connected:${IPAC}`,
        "a served refresh preserves the selected physical encoder",
      );
      assert.deepEqual(
        await model.locator('option[value^="connected:"]').evaluateAll((options) => ({
          values: options.map((option) => option.value),
          labels: options.map((option) => option.textContent),
          uniqueLabels: new Set(options.map((option) => option.textContent)).size,
        })),
        {
          values: [`connected:${IPAC}`, `connected:${twinSelector}`],
          labels: [
            `Twin encoder · left bay · ${IPAC}`,
            `Twin encoder · right bay · ${twinSelector}`,
          ],
          uniqueLabels: 2,
        },
        "identical models retain distinct identities and visible path context",
      );

      await model.selectOption("sample:unknown-hid");
      const draft = node.locator("[data-rd-encoder-manual-labels]");
      await draft.fill("UP, DOWN, UNAPPLIED DRAFT");
      await draft.evaluate((textarea) => {
        window.__ksxEncoderDraftNode = textarea;
      });
      rosterMode = "unrelated-roster";
      await submitTheme("matrix");
      assert.equal(
        await draft.inputValue(),
        "UP, DOWN, UNAPPLIED DRAFT",
        "an unrelated connected-device refresh preserves an unapplied fallback draft",
      );
      assert.equal(
        await draft.evaluate((textarea) => textarea === window.__ksxEncoderDraftNode),
        true,
        "an unrelated roster change does not replace the active form subtree",
      );

      rosterMode = "ambiguous-minipac";
      await submitTheme("light");
      await model.selectOption(`connected:${IPAC}`);
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.evidenceState ===
          "ambiguous-family",
      );
      await node.locator(
        '[data-profile-candidate="ultimarc-minipac-four"] input',
      ).click();
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
          "ultimarc-minipac-four",
      );

      rosterMode = "measured-minipac-32";
      await submitTheme("dark");
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.profileId ===
          "ultimarc-minipac-32",
      );
      assert.equal(
        await node.locator(".rd-encoder-profile").getAttribute("data-evidence-state"),
        "backend-family",
        "changed backend evidence invalidates the old user-confirmed variant",
      );
      assert.equal(await node.locator("[data-terminal-id]").count(), 32);

      rosterMode = "identity-conflict";
      await submitTheme("matrix");
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.evidenceState ===
          "identity-conflict",
      );
      assert.equal(
        await node.locator("[data-rd-encoder-read]").count(),
        0,
        "a protocol capability cannot authorize reads while visual identity facts conflict",
      );
      assert.equal(await node.locator("[data-terminal-id]").count(), 0);

      rosterMode = "known-family";
      await submitTheme("system");
      await page.waitForFunction(
        () => document.querySelector('.rd-encoder-profile[data-presentation="research"]')?.dataset.evidenceState ===
          "known-family",
      );
      assert.equal(await model.inputValue(), `connected:${IPAC}`);
      assert.equal(await node.locator("[data-terminal-id]").count(), 0);
      assert.match(await node.textContent(), /known family · visual topology unavailable/i);
      assert.match(await node.textContent(), /no verified visual topology is registered yet/i);
      assert.match(
        await node.locator("svg title").textContent(),
        /Ultimarc U-HID · visual topology unavailable/i,
        "the accessible drawing keeps known identity separate from missing topology",
      );
      assert.match(
        await node.textContent(),
        /no verified visual source is registered for this known family/i,
      );
      assert.doesNotMatch(
        await node.textContent(),
        /no exact backend family\/profile fact is available/i,
      );

      rosterMode = "only-twin";
      await submitTheme("light");
      await page.waitForFunction(
        (value) => document.querySelector(".rd-encoder-profile-node [data-rd-encoder-model]")?.value === value,
        `connected:${twinSelector}`,
      );
      assert.equal(
        await model.inputValue(),
        `connected:${twinSelector}`,
        "a disconnected selection falls back to the remaining real encoder",
      );
    } finally {
      // The last theme submission can still be completing its intercepted
      // authority refresh on a slower runner. Wait for that route handler so
      // page teardown cannot race its final `fulfill` call.
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });

  test("removing a non-primary board repaints the surviving multi-selection", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    for (const selector of [G915, IPAC]) {
      const row = page.locator(`.rd-devmodal button[data-selector="${selector}"]`);
      if ((await row.getAttribute("aria-pressed")) !== "true") {
        await row.click();
        await page.waitForFunction(
          (wanted) => document.querySelector(
            `.rd-devmodal button[data-selector="${wanted}"]`,
          )?.getAttribute("aria-pressed") === "true",
          selector,
          { timeout: 10_000 },
        );
      }
    }
    await page.keyboard.press("Escape");
    const g915 = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    const ipac = page.locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"]`);
    const ipacName = await ipac.getAttribute("data-widget-name");
    await revealCanvasItem(page, G915_SLUG);
    await ipac.evaluate((item) => item.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      pointerType: "",
      shiftKey: true,
    })));
    await page.waitForFunction(
      () => document.querySelector(".rd-insp-name")?.textContent === "2 widgets selected",
    );

    await page.click('[data-nx="rd-devs-open"]');
    page.once("dialog", (dialog) => dialog.accept());
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.waitForFunction(
      (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await ipac.getAttribute("aria-current"),
      "true",
      "the surviving primary remains the selection anchor",
    );
    assert.equal(
      await page.locator(".forma-canvas-stage > .is-active").count(),
      1,
      "the removed non-primary no longer occupies the selection set",
    );
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "the Add tray keeps the Inspector from competing with composition",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (name) => document.querySelector(".rd-insp-name")?.textContent === name,
      ipacName,
    );
    assert.equal(
      await page.locator(".rd-insp-name").textContent(),
      ipacName,
      "the Inspector repaints from multi-select to the surviving board",
    );

    // Keep the suite's shared arrangement intact for any later regression.
    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.keyboard.press("Escape");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await closePage(page);
  });
});
