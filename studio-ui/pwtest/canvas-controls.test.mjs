// The canvas's navigation controls, in a real browser.
//
// WHY THIS LEVEL: none of this exists server-side. The camera, the selection,
// a widget's manual scale and the map's markers are all browser state written
// by the vendored genui engine (studio-ui/src/genui/), and the only honest way
// to know a button still does what it claims is to press it and read the
// engine's own attributes back. The Rust tests can pin that the CONTROLS are
// served; only this can pin that they WORK.
//
// What each test here would have caught while it was being written:
//  - "Tidy up" silently doing nothing (an engine with no public placement API)
//  - the size readout drifting from the widget's real scale
//  - Escape not leaving focus mode unless the widget itself held focus, which
//    it never does right after you press a button
//  - the map rendering into detached nodes: markers exist, and clicking one
//    still selects, so the corner is not decoration
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_CANVAS_PORT ?? 4479);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;
let fixtureExe;
let fixtureGeneration = "";

async function waitForServer(base = BASE, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/nocturne`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/nocturne`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio canvas fixture");
  fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer(BASE);
  const provenance = await fetch(`${BASE}/api/nocturne`).then((response) => response.json());
  fixtureGeneration = provenance.environment?.generation ?? "";
  assert.match(
    fixtureGeneration,
    /^pid-\d+-[0-9a-f]+$/,
    "a directly launched fixture exposes a process-start generation, not a reusable PID alone",
  );
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "canvas fixture");
  }
});

/** A page whose canvas has finished adopting AND finished its opening camera
 *  move. Adoption lands in the island's post-mount frame — not a fixed
 *  distance behind hydration — so this waits for the engine's own geometry
 *  write rather than a delay, then lets the fit animation settle. */
async function openCanvas(options = {}, prepare = async () => {}) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    ...options,
  });
  await page.addInitScript(({ expectedOrigin, generation }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem("ksx-studio-fixture-generation-v1", generation);
  }, { expectedOrigin: BASE, generation: fixtureGeneration });
  await prepare(page);
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
        undefined,
    null,
    { timeout: 20_000 },
  );
  await settle(page);
  return page;
}

/** Variant for concurrency tests which must close one page without destroying
 * the shared storage context that owns its surviving peer. */
async function openCanvasInContext(context, prepare = async () => {}) {
  const page = await context.newPage();
  await page.addInitScript(({ expectedOrigin, generation }) => {
    if (location.origin !== expectedOrigin) return;
    localStorage.setItem("ksx-studio-fixture-generation-v1", generation);
  }, { expectedOrigin: BASE, generation: fixtureGeneration });
  await prepare(page);
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
    null,
    { timeout: 20_000 },
  );
  await settle(page);
  return page;
}

/** Wait until the Input source widget is drawing the device that was just
 *  picked.
 *
 *  This used to read `data-input-kind` off `.n-widget-kb` — "keyboard" or
 *  "panel-encoder". `3901990` ("cut ksx over to /nocturne — remove the encoder
 *  chart surface") deleted the encoder rendering and the attribute with it, and
 *  put nothing in its place: `dataset.inputKind` appears nowhere in the client
 *  now, so every wait on it was a promise that could never be kept and ran to
 *  its 30 s deadline. Eight tests spent that deadline before their first
 *  assertion.
 *
 *  The widget's own kicker is the stronger replacement, not merely the
 *  available one: it names the EXACT device — "Logitech G915 TKL · Bluetooth",
 *  "Ultimarc I-PAC 4 · USB" — so a gate on it cannot pass while the board a
 *  previous test selected is still on screen, which a category attribute
 *  could. (This fixture is stateful and the selection persists; that is what
 *  `restoreFixturePanelSource` exists for.) */
async function waitForSourceWidget(page, deviceName) {
  await page.waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll(".n-widget-kb .n-kick")).some((kick) =>
        (kick.textContent ?? "").includes(name),
      ),
    deviceName,
    { timeout: 20_000 },
  );
}

/** The camera is still: no animation running, and none scheduled for the next
 *  frame either (fitAll arms its animation one frame after it is asked). */
async function settle(page) {
  for (let pass = 0; pass < 2; pass++) {
    await page.waitForFunction(() => !document.querySelector(".is-camera-animating"), null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(250);
  }
}

/** Compare the route identity that should survive a scope rebuild while also
 * proving that the current pixels encode that identity. Endpoint coordinates
 * are intentionally excluded: live hover/focus geometry may move them. */
async function directLassoState(page, lines, slot = null) {
  return page.evaluate(({ lines, slot }) => {
    const edges = Array.from(
      document.querySelectorAll(`${lines} [data-flow-kind="binding"]`),
    );
    const matrix = document.querySelector(lines)?.getScreenCTM();
    const scale = matrix ? Math.max(0.01, Math.hypot(matrix.a, matrix.b)) : NaN;
    const counts = new Map();
    for (const edge of edges) {
      const routeSlot = edge.dataset.flowSlot ?? "";
      counts.set(routeSlot, (counts.get(routeSlot) ?? 0) + 1);
    }
    const routes = edges.map((edge) => {
      const id = edge.dataset.flowId ?? "";
      const routeSlot = edge.dataset.flowSlot ?? "";
      const lane = Number(edge.dataset.flowLaneIndex);
      const d = edge.querySelector(".n-flow-core")?.getAttribute("d") ?? "";
      const commands = d.match(/[A-Za-z]/gu) ?? [];
      const values = (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
      const [sx, sy, firstX, firstY, secondX, secondY, tx, ty] = values;
      const verticalShape = values.length === 8 &&
        Math.abs(firstX - sx) <= 0.03 && Math.abs(secondX - tx) <= 0.03 &&
        Math.abs(firstY - secondY) <= 0.03;
      const horizontalShape = values.length === 8 &&
        Math.abs(firstY - sy) <= 0.03 && Math.abs(secondY - ty) <= 0.03 &&
        Math.abs(firstX - secondX) <= 0.03;
      const paintedAxis = verticalShape === horizontalShape
        ? null
        : verticalShape ? "vertical" : "horizontal";
      const majorAxis = Math.abs(ty - sy) >= Math.abs(tx - sx)
        ? "vertical"
        : "horizontal";
      // Production chooses the branch before serializing endpoints to two
      // decimals. Only a near-diagonal route can have that choice obscured by
      // the serialized values used here.
      const axisAmbiguous = Math.abs(Math.abs(ty - sy) - Math.abs(tx - sx)) <= 0.03;
      const total = counts.get(routeSlot) ?? 1;
      const gap = total > 1 ? Math.min(4, 72 / (total - 1)) : 0;
      const expectedLane = (lane - (total - 1) / 2) * (gap / scale);
      const actualLane = paintedAxis === "vertical"
        ? firstY - (sy + ty) / 2
        : firstX - (sx + tx) / 2;
      const laneError = Math.abs(actualLane - expectedLane);
      const laneScreenError = laneError * scale;
      const valid = Boolean(id) && Number.isInteger(lane) && Number.isFinite(scale) &&
        commands.length === 2 && commands[0] === "M" && commands[1] === "C" &&
        values.length === 8 && values.every(Number.isFinite) && paintedAxis !== null &&
        (axisAmbiguous || paintedAxis === majorAxis) &&
        laneError <= 0.05;
      return { id, slot: routeSlot, lane, valid, laneError, laneScreenError };
    });
    const topology = routes
      .filter((route) => slot === null || route.slot === String(slot))
      .map((route) => [route.id, route.lane])
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      topology,
      valid: routes.every((route) => route.valid),
      invalid: routes.filter((route) => !route.valid),
    };
  }, { lines, slot });
}

/** Wait for the lasso geometry itself, not an animation timer or class name.
 * A permanent stale-CTM bug still returns invalid state and fails below. */
async function settledDirectLassoState(page, lines, slot = null) {
  const deadline = Date.now() + 2_000;
  let state = await directLassoState(page, lines, slot);
  while (!state.valid && Date.now() < deadline) {
    await page.waitForTimeout(16);
    state = await directLassoState(page, lines, slot);
  }
  return state;
}

function setPadControlKeys(pad, functionName, keys) {
  const wanted = functionName.trim().toLowerCase();
  const legacyFunction = Object.keys(pad.fn_keys ?? {}).find(
    (candidate) => candidate.trim().toLowerCase() === wanted,
  ) ?? functionName;
  pad.fn_keys[legacyFunction] = keys.join(" · ");
  const control = pad.controls?.find(
    (candidate) => candidate.function.trim().toLowerCase() === wanted,
  );
  assert.ok(control, `fixture payload projects the ${functionName} control`);
  control.keys = [...keys];
}

const PANEL_SELECTOR = "usb:d209:0430:00";
const PANEL_FINGERPRINT = "panel-fixture-fingerprint";
const PANEL_BASE_SHA = "A".repeat(64);
const PANEL_DESIRED_SHA = "B".repeat(64);
const PANEL_PROTOCOL_PROFILE = "ipac4-pac256-v1";
const PANEL_TERMINAL_KINDS = [
  "up", "down", "left", "right",
  "sw1", "sw2", "sw3", "sw4", "sw5", "sw6", "sw7", "sw8",
  "start", "coin",
];
const PANEL_CANONICAL_KEYS = [
  ["A", 0x04], ["B", 0x05], ["C", 0x06], ["D", 0x07],
  ["E", 0x08], ["F", 0x09], ["G", 0x0A], ["H", 0x0B],
  ["I", 0x0C], ["J", 0x0D], ["K", 0x0E], ["L", 0x0F],
  ["M", 0x10], ["N", 0x11], ["O", 0x12], ["P", 0x13],
  ["Q", 0x14], ["R", 0x15], ["S", 0x16], ["T", 0x17],
  ["U", 0x18], ["V", 0x19], ["W", 0x1A], ["X", 0x1B],
  ["Y", 0x1C], ["Z", 0x1D], ["One", 0x1E], ["Two", 0x1F],
  ["Three", 0x20], ["Four", 0x21], ["Five", 0x22], ["Six", 0x23],
  ["Seven", 0x24], ["Eight", 0x25], ["Nine", 0x26], ["Zero", 0x27],
  ["DashUnderscore", 0x2D], ["PlusEquals", 0x2E],
  ["OpenBracketBrace", 0x2F], ["CloseBracketBrace", 0x30],
  ["BackslashPipe", 0x31], ["SemicolonColon", 0x33],
  ["SingleDoubleQuote", 0x34], ["Tilde", 0x35],
  ["CommaLeftArrow", 0x36], ["PeriodRightArrow", 0x37],
  ["F1", 0x3A], ["F2", 0x3B], ["F3", 0x3C], ["F4", 0x3D],
  ["F5", 0x3E], ["F6", 0x3F], ["F7", 0x40], ["F8", 0x41],
  ["F9", 0x42], ["F10", 0x43],
];

function panelCanonicalTerminalIds() {
  const ids = [];
  for (let player = 1; player <= 4; player += 1) {
    for (const kind of PANEL_TERMINAL_KINDS) ids.push(`${player}${kind}`);
  }
  return ids;
}

function panelCanonicalRecommendedTerminals(terminals) {
  const assignments = new Map(panelCanonicalTerminalIds().map(
    (terminalId, index) => [terminalId, PANEL_CANONICAL_KEYS[index]],
  ));
  return terminals.map((terminal) => {
    const [key, code] = assignments.get(terminal.terminal_id) ?? [null, 0];
    return {
      ...terminal,
      normal: key
        ? { code, key, label: key, supported: true }
        : { code: 0, key: null, label: "Unassigned", supported: true },
    };
  });
}

function panelBackup({
  id = "20260823T003000Z-before-program-AAAAAAAAAAAA",
  imageSha256 = PANEL_BASE_SHA,
  reason = "before-program",
} = {}) {
  return {
    backup_id: id,
    label: `Safety backup ${id.slice(0, 12)}`,
    created_at: "2026-08-23T00:30:00-04:00",
    board_fingerprint: PANEL_FINGERPRINT,
    image_sha256: imageSha256,
    image_bytes: 256,
    reason,
  };
}

function panelChartPayload({
  imageSha256 = PANEL_BASE_SHA,
  backup = panelBackup(),
  qualificationState = "qualified",
  qualificationDetail = "This synthetic encoder has completed its reversible writer check.",
  qualificationRestoreBackupId = null,
  hardwareEpoch = null,
  hardwareFence = null,
} = {}) {
  const chartKey = imageSha256 === PANEL_DESIRED_SHA ? "A" : "B";
  const keyValue = (key) => ({
    code: key === "A" ? 4 : 5,
    key,
    label: key,
    supported: true,
  });
  const terminals = [
    {
      terminal_id: "1sw1",
      terminal_label: "P1 SW1",
      player: 1,
      kind: "button",
      normal: keyValue(chartKey),
      shifted: { code: 0, key: null, label: "Unassigned", supported: true },
      shift_state: "disabled",
      is_shift: false,
    },
    {
      terminal_id: "1sw2",
      terminal_label: "P1 SW2",
      player: 1,
      kind: "button",
      normal: keyValue(chartKey),
      shifted: { code: 0, key: null, label: "Unassigned", supported: true },
      shift_state: "disabled",
      is_shift: false,
    },
  ];
  return {
    target_selector: PANEL_SELECTOR,
    unavailable: null,
    hardware_epoch: hardwareEpoch,
    hardware_fence: hardwareFence,
    view: {
      generated_at: "2026-08-23T00:30:00-04:00",
      summary: "The complete 256-byte I-PAC chart was read.",
      board_id: "USB\\VID_D209&PID_0430\\FIXTURE",
      board_name: "Ultimarc I-PAC 4X",
      board_fingerprint: PANEL_FINGERPRINT,
      driver: "ultimarc-ipac4",
      protocol_profile: PANEL_PROTOCOL_PROFILE,
      image_sha256: imageSha256,
      image_bytes: 256,
      programming_state: "supervised",
      programming_detail: "The pinned profile supports a supervised backup, guarded program, readback verification, and restore.",
      qualification_state: qualificationState,
      qualification_detail: qualificationDetail,
      qualification_restore_backup_id: qualificationRestoreBackupId,
      terminals,
      recommended_terminals: panelCanonicalRecommendedTerminals(terminals),
      key_options: [
        { key: "A", label: "A", code: 4, safe_for_qualification: true },
        { key: "B", label: "B", code: 5, safe_for_qualification: true },
        { key: "Escape", label: "Escape", code: 41, safe_for_qualification: false },
      ],
      backup,
      notes: ["Synthetic browser fixture; no physical report was sent."],
    },
  };
}

function panelProgramPlan({
  terminals = ["1sw1", "1sw2"],
  confirmation = "I understand this writes persistent I-PAC configuration and that the verified safety backup is the restore point.",
} = {}) {
  return {
    target_selector: PANEL_SELECTOR,
    unavailable: null,
    plan: {
      summary: `Change ${terminals.length} physical ${terminals.length === 1 ? "terminal" : "terminals"} and preserve every other byte.`,
      board_id: "USB\\VID_D209&PID_0430\\FIXTURE",
      board_name: "Ultimarc I-PAC 4X",
      board_fingerprint: PANEL_FINGERPRINT,
      protocol_profile: PANEL_PROTOCOL_PROFILE,
      base_sha256: PANEL_BASE_SHA,
      desired_sha256: PANEL_DESIRED_SHA,
      image_bytes: 256,
      terminal_diff: terminals.map((terminal, index) => ({
        terminal_id: terminal,
        terminal_label: `P1 SW${index + 1}`,
        layer: "normal",
        before: "B",
        after: "A",
      })),
      byte_diff: terminals.map((_, index) => ({
        offset: 4 + index,
        before: 5,
        after: 4,
        meaning: `P1 SW${index + 1} normal`,
      })),
      preserved_byte_count: 256 - terminals.length,
      confirmation,
      blockers: [],
    },
  };
}

function panelStatusPayload({
  targetSelector = PANEL_SELECTOR,
  name = "Ultimarc I-PAC 4X",
  identity = "USB D209:0430 · bcdDevice 0x0056",
  vendorId = 0xd209,
  productId = 0x0430,
  bcdDevice = 0x0056,
  driver = "ultimarc-ipac",
  driverSupported = true,
  driverLabel = driverSupported ? "Ultimarc I-PAC family" : "Unsupported panel protocol",
  familyId = driverSupported ? "ultimarc-ipac4" : null,
  familyLabel = familyId ? name : null,
  capabilities = {
    can_identify: Boolean(familyId),
    can_report_mode: false,
    can_read_chart: driverSupported,
    can_write_chart: driverSupported,
    write_is_persistent: driverSupported,
  },
  firmwareLabel = "1.56",
  firmwareDetail = "Measured KSX I-PAC 4 release-0056 profile matched USB bcdDevice 0x0056; firmware was not queried from the board.",
  profileTerminalCount = 56,
  mode = "keyboard-compatible",
  modeLabel = "Keyboard-compatible input observed",
  modeDetail = "Keyboard-compatible HID input was observed; exact vendor mode was not queried.",
  recommendation = "Keep this encoder in keyboard mode so Teach and Route retain KSX's dynamic transforms.",
  chartState = "protocol-unverified",
  chartAttempted = false,
  chartLabel = "Protocol unverified · Not attempted",
  chartDetail = "Chart read-back protocol is unverified, so no report was sent.",
  configurationState = "available-unopened",
  configurationDetail = "One exact five-byte configuration collection is available and remains unopened.",
  recoveryRequired = false,
  recoveryDetail = "",
  unavailable = null,
} = {}) {
  return {
    target_selector: targetSelector,
    unavailable,
    view: {
      generated_at: "2026-08-22T19:20:00-04:00",
      usb_available: true,
      hid_available: true,
      summary: "One selected panel encoder was inspected.",
      access_detail: "USB descriptors and passive HID collection metadata were readable",
      panels: targetSelector === null ? [] : [{
        board_id: `USB\\VID_${vendorId.toString(16).padStart(4, "0").toUpperCase()}&PID_${productId.toString(16).padStart(4, "0").toUpperCase()}\\FIXTURE`,
        name,
        identity,
        vendor_id: vendorId,
        product_id: productId,
        family_id: familyId,
        family_label: familyLabel,
        bcd_device: bcdDevice,
        firmware_label: firmwareLabel,
        firmware_detail: firmwareDetail,
        profile_terminal_count: profileTerminalCount,
        serial: null,
        driver,
        driver_supported: driverSupported,
        driver_label: driverLabel,
        observed_mode: mode,
        mode_detail: modeDetail,
        observed_mode_label: modeLabel,
        mode_read_supported: false,
        capabilities,
        chart_state: chartState,
        chart_attempted: chartAttempted,
        chart_detail: chartDetail,
        chart_label: chartLabel,
        configuration_collection_state: configurationState,
        configuration_collection: configurationState === "available-unopened" ? "HID MI_02" : null,
        configuration_collection_detail: configurationDetail,
        recommendation,
        programming_recovery_required: recoveryRequired,
        programming_recovery_detail: recoveryDetail,
        interfaces: [],
        hid_collections: [],
      }],
      inspection_note: "Inspection only. KSX did not program or change this encoder.",
      notes: [],
    },
  };
}

const scaleOf = (page, id) =>
  page.evaluate(
    (instance) =>
      Number(document.querySelector(`[data-instance-id="${instance}"]`)?.dataset.canvasManualScale ?? 1),
    id,
  );

async function restoreFixturePanelSource() {
  const response = await fetch(`${BASE}/nocturne/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      selector: PANEL_SELECTOR,
      alias: "panel",
      label: "Ultimarc I-PAC 4",
    }),
  });
  assert.equal(response.ok, true, "the shared fixture restores its baseline I-PAC source");
}

describe("the canvas navigation controls", () => {
  test("a new fixture generation clears browser-only drafts before the wire loads", async () => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    await page.addInitScript((expectedOrigin) => {
      if (location.origin !== expectedOrigin) return;
      localStorage.removeItem("ksx-studio-fixture-generation-v1");
      localStorage.setItem("ksx-reseed-probe", "stale browser draft");
    }, BASE);
    try {
      await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
        null,
        { timeout: 20_000 },
      );
      assert.equal(await page.evaluate(() => localStorage.getItem("ksx-reseed-probe")), null);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-studio-fixture-generation-v1")),
        fixtureGeneration,
      );
      assert.deepEqual(noise, []);
    } finally {
      await context.close();
    }
  });

  test("a storage-refusing live tab still reloads out of stale fixture memory", async () => {
    const page = await openCanvas();
    let replaceGeneration = true;
    const blockStorage = () => {
      const refuse = () => {
        throw new DOMException("fixture storage intentionally blocked", "SecurityError");
      };
      Storage.prototype.getItem = refuse;
      Storage.prototype.setItem = refuse;
      Storage.prototype.clear = refuse;
    };
    await page.addInitScript(blockStorage);
    await page.evaluate(blockStorage);
    await page.evaluate(() => {
      window.fixtureMemoryBeforeReseed = "stale";
    });
    await page.route("**/api/nocturne*", async (route) => {
      if (!replaceGeneration) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      if (response.status() !== 200) {
        await route.fulfill({ response });
        return;
      }
      replaceGeneration = false;
      const payload = await response.json();
      payload.environment.generation = `${payload.environment.generation}-replacement`;
      payload.view.environment_generation = payload.environment.generation;
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.locator("a.n-slot-sel").first().click();
      await page.waitForFunction(
        () => window.fixtureMemoryBeforeReseed === undefined,
        null,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => document.querySelector(".n-tbar .n-environment")?.textContent?.includes("FIXTURE"),
        null,
        { timeout: 20_000 },
      );
      await page.waitForLoadState("networkidle");
      assert.equal(
        await page.evaluate(() => window.fixtureMemoryBeforeReseed),
        undefined,
        "the stale in-memory document was replaced even though storage refused the generation write",
      );
      assert.equal(replaceGeneration, false, "the live document observed the replacement generation");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.unrouteAll({ behavior: "wait" }).catch(() => {});
      await page.close();
    }
  });

  test("the seeded fixture is unmistakably labeled as synthetic", async () => {
    const page = await openCanvas();
    try {
      const environment = page.locator(".n-tbar .n-environment");
      await environment.waitFor({ state: "visible" });
      assert.equal((await environment.textContent()).trim(), "FIXTURE · SEEDED DEMO");
      assert.equal(
        await environment.getAttribute("data-runtime-environment"),
        "fixture-seeded-demo",
      );
      assert.equal(await environment.evaluate((element) => element.classList.contains("fixture")), true);
      assert.equal(await environment.evaluate((element) => element.classList.contains("live")), false);
      assert.match(
        await environment.getAttribute("title"),
        /Synthetic seeded demo state.*no physical devices are read or written/i,
        "fixture provenance names both its synthetic state and its hardware boundary",
      );
      assert.equal(await environment.getAttribute("aria-describedby"), "n-environment-detail");
      assert.match(
        await page.locator("#n-environment-detail").textContent(),
        /Synthetic seeded demo state.*no physical devices are read or written/i,
        "the hardware boundary is exposed without relying on a mouse tooltip",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("mapping actions keep their controller truth after the legacy pane is absent", async () => {
    const page = await openCanvas();
    let bindCommitted = false;
    let committedBinding = null;
    const postWriteRevision = "fixture-pane-free-revision-after-bind";
    let resolveBind;
    const bound = new Promise((resolve) => {
      resolveBind = resolve;
    });
    let heldLearn = null;
    await page.route("**/api/learn/start", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      heldLearn = {
        ...payload,
        state: "listening",
        remaining_ms: 10_000,
        device: null,
        key: null,
        error: null,
      };
      await route.fulfill({ response, json: payload });
    });
    await page.route("**/api/learn", async (route) => {
      if (route.request().method() !== "GET" || !heldLearn) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(heldLearn),
      });
    });
    await page.route("**/api/nocturne*", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const response = await route.fetch({ headers });
      assert.equal(response.status(), 200);
      const payload = await response.json();
      if (bindCommitted && committedBinding) {
        const pad = payload.view?.pads?.find(
          (candidate) => Number(candidate.slot) === Number(committedBinding.slot),
        );
        assert.ok(pad, "fixture payload contains the committed controller");
        pad.target_revision = postWriteRevision;
        setPadControlKeys(pad, committedBinding.function, [committedBinding.key]);
        payload.view.save_text = postWriteRevision;
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route("**/nocturne/api/bind", async (route) => {
      committedBinding = JSON.parse(route.request().postData() ?? "{}");
      bindCommitted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: null,
          error: null,
          code: null,
          conflicts: [],
          also_drives: [],
        }),
      });
      resolveBind(committedBinding);
    });
    try {
      await page.click('[data-nx="surface-open"]');

      await page.locator(".n-right").evaluate((pane) => pane.remove());
      assert.equal(await page.locator(".n-right").count(), 0, "the test removes the ledger entirely");
      assert.equal(
        (await page.textContent('[data-nx="auto-map"]')).trim(),
        "Map all…",
        "the bulk-edit action is named for the capture walk it starts",
      );

      await page.click('[data-nx="auto-map"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );
      assert.match(
        await page.locator(".n-learnbar").innerText(),
        /P1 · A — 1 of 25/i,
        "Map all derives its ordered controls from payload data, not pane rows",
      );
      await page.click('[data-nx="learn-cancel"]');

      const signal = page.locator(".n-widget-kb [data-key]:not(.ghost):visible").first();
      const signalKey = await signal.getAttribute("data-key");
      assert.ok(signalKey, "the selected I-PAC exposes at least one concrete Windows signal");
      await signal.evaluate((button) => button.click());
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      const request = await bound;
      await page.waitForFunction(
        (revision) => document.querySelector(".n-saved")?.textContent?.trim() === revision,
        postWriteRevision,
      );
      assert.equal(request.slot, 1);
      assert.equal(request.key, signalKey);
      assert.equal(request.function, "A", "pad art resolves the mapper's canonical spelling");
      assert.equal(request.mode, "replace");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  // ── DELETED 2026-08-26: two encoder-chart AUTHORITY tests ───────────────
  //
  // Both pinned a promise the product no longer makes.
  //
  // "conflict consent retains its opened authority and a chained bind waits for
  // the new revision" asserted that every bind POST carries an
  // `encoder_authority` block — expected_selector, expected_instance,
  // expected_board_fingerprint, expected_chart_sha256 — and that forcing past a
  // conflict never recomputes it. `encoder_authority` appears NOWHERE in this
  // repo any more, in the client or in nocturne.rs: the chart hash and board
  // fingerprint it fenced against are things ksx cannot read since `3901990`.
  // The conflict-consent mechanism it rode on is alive and still covered — by
  // "a keyboard-only selector change cancels ordinary binding Learn" and
  // "same-selector re-enumeration cancels an armed mapping before it can
  // write", which fence on the CONTROLLER revision that survived.
  //
  // "a chart fingerprint change closes stale conflict consent" was entirely a
  // chart re-read: it clicked `surface-encoder-read`, counted two
  // `/api/panel/chart` fetches and asserted the open dialog retired. There is
  // no read verb, no route, and no fingerprint that can change.

  test("same-selector re-enumeration cancels an armed mapping before it can write", async () => {
    let reenumerate = false;
    let resolveReenumerated;
    const reenumerated = new Promise((resolve) => {
      resolveReenumerated = resolve;
    });
    let binds = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/nocturne/api/bind", async (route) => {
        binds += 1;
        await route.abort();
      });
      await candidate.route("**/api/nocturne*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200);
        const payload = await response.json();
        if (reenumerate) {
          // Same staged selector and same controller revisions: only the exact
          // Windows instance changed underneath the armed gesture.
          payload.view.cap_instance = `${payload.view.cap_instance}\\REENUMERATED`;
          reenumerate = false;
          resolveReenumerated();
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.click('[data-nx="surface-open"]');

      const signal = page.locator(".n-widget-kb [data-key]:not(.ghost):visible").first();
      await signal.evaluate((button) => button.click());
      await page.locator('.n-right [data-nx="inspector-action"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );
      reenumerate = true;
      await reenumerated;
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("none")
      );
      assert.equal(binds, 0, "the old instance never reaches the bind route");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a keyboard-only selector change cancels ordinary binding Learn", async () => {
    let changeInput = false;
    let resolveChanged;
    const changed = new Promise((resolve) => {
      resolveChanged = resolve;
    });
    let binds = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/nocturne/api/bind", async (route) => {
        binds += 1;
        await route.abort();
      });
      await candidate.route("**/api/nocturne*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200);
        const payload = await response.json();
        if (changeInput) {
          payload.view.cap_selector = "usb:feed:0002:00";
          payload.view.cap_instance = "HID\\VID_FEED&PID_0002\\KEYBOARD-B";
          for (const pad of payload.view?.pads ?? []) {
            pad.target_revision = `device-b-${pad.slot}`;
          }
          changeInput = false;
          resolveChanged();
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Logitech G915");
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      await page.locator('.n-right [data-nx="inspector-action"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );

      changeInput = true;
      await changed;
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("none")
      );
      assert.equal(binds, 0, "Keyboard A's listener cannot write after Keyboard B is selected");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      // This suite intentionally shares one stateful fixture. Return the
      // staged source to its baseline so this cancellation case cannot turn
      // the following I-PAC authority tests into keyboard tests.
      await restoreFixturePanelSource();
      await page.close();
    }
  });

  test("the mapping inspector follows canvas selection and Find returns to the whole graph", async () => {
    const page = await openCanvas();
    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Logitech G915");

      const pane = page.locator(".n-right");
      assert.match(await pane.locator(".n-inspector-kicker").innerText(), /mapping inspector/i);
      assert.match(await pane.locator(".n-filter-key").innerText(), /Ctrl K/i);
      assert.equal(await pane.locator('[data-nx="view-ctl"]').getAttribute("aria-pressed"), "true");
      assert.equal(await pane.locator('[data-nx="view-keys"]').getAttribute("aria-pressed"), "false");
      await pane.locator('[data-nx="inspector-action"]').click();
      assert.equal(
        await page.evaluate(() => document.activeElement?.classList.contains("n-filter-in")),
        true,
        "the overview's one primary action enters Find",
      );

      await page.locator('.n-widget-kb [data-key="G"]').evaluate((key) => key.click());
      await page.waitForFunction(() =>
        document.querySelector(".n-right")?.classList.contains("context-mode") &&
        document.querySelector(".n-right")?.classList.contains("keys-mode")
      );
      assert.equal(await pane.locator(".n-inspector-title").innerText(), "G");
      assert.match(await pane.locator(".n-inspector-meta").innerText(), /destinations?.*players?/i);
      assert.equal(
        await pane.locator('.n-krows .n-krow:not(.n-context-hide)[data-key="G"]').count(),
        1,
        "key context leaves its one editable relationship row",
      );
      assert.equal(await pane.locator('[data-nx="view-keys"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.isHidden(".n-learnbar"), true, "selection does not start an edit");
      await pane.locator('[data-nx="inspector-action"]').click();
      await page.waitForFunction(() => !document.querySelector(".n-learnbar")?.classList.contains("none"));
      await page.click('[data-nx="learn-cancel"]');
      await page.click('[data-nx="inspector-browse"]');
      await page.waitForFunction(() => document.activeElement?.matches('[data-nx="view-keys"]'));
      assert.equal(await pane.evaluate((element) => element.classList.contains("context-mode")), false);
      assert.equal(await pane.locator(".n-filter-row").isVisible(), true);

      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().click({ force: true });
      await page.waitForFunction(() =>
        document.querySelector(".n-right")?.classList.contains("context-mode") &&
        !document.querySelector(".n-right")?.classList.contains("keys-mode")
      );
      assert.match(await pane.locator(".n-inspector-title").innerText(), /P1 · A/i);
      assert.equal(await pane.locator('[data-nx="view-ctl"]').getAttribute("aria-pressed"), "true");
      assert.equal(
        await pane.locator('.n-bindgroups details.n-bind:not(.n-context-hide)[data-fn="A"]').count(),
        1,
        "control context leaves the full behavior editor for that control",
      );
      assert.equal(await page.isHidden(".n-learnbar"), true, "selection remains non-destructive");
      await pane.locator('[data-nx="inspector-action"]').click();
      await page.waitForFunction(() => !document.querySelector(".n-learnbar")?.classList.contains("none"));
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-2"] [data-fn~="a"]',
      ).first().click({ force: true });
      assert.match(await pane.locator(".n-inspector-title").innerText(), /^P2 ·/);
      assert.equal(
        await page.isHidden(".n-learnbar"),
        true,
        "selecting another endpoint retires the previous edit",
      );
      assert.equal(
        await pane.locator('.n-bindgroups details.n-bind:not(.n-context-hide)').count(),
        0,
        "a non-current controller gets an honest card-only Inspector",
      );

      await page.keyboard.press("Control+k");
      await page.waitForFunction(() =>
        document.activeElement?.matches(".n-right .n-filter-in")
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.classList.contains("n-filter-in")),
        true,
        "Ctrl K opens the inspector and focuses Find",
      );
      assert.equal(await pane.evaluate((element) => element.classList.contains("context-mode")), false);
      await page.keyboard.type("   ");
      assert.equal(
        await pane.evaluate((element) => element.classList.contains("filtering")),
        false,
        "whitespace does not turn the whole-graph Find lens on",
      );
      await page.keyboard.press("Control+a");
      await page.keyboard.type("hadouken");
      assert.equal(
        await pane.locator('.n-macrosec details[data-fn^="macro."]:not(.hide)').isVisible(),
        true,
        "Find covers macros as well as controls and keys",
      );
      const selected = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/nocturne" &&
          url.searchParams.get("slot") === "2" && response.status() === 200;
      });
      await page.locator('a.n-slot-sel[href*="slot=2"]').click();
      await selected;
      await page.waitForFunction(() => {
        const url = new URL(window.location.href);
        return url.searchParams.get("slot") === "2" &&
          url.searchParams.get("q") === "hadouken" &&
          document.querySelector(".n-filter-in")?.value === "hadouken";
      });
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await restoreFixturePanelSource();
      await page.close();
    }
  });

  test("an arranged keyboard keycap is a first-class mapping source", async () => {
    const page = await openCanvas();
    let bindCommitted = false;
    let committedBinding = null;
    const postWriteRevision = "fixture-workbench-revision-after-bind";
    let resolveBound;
    const bound = new Promise((resolve) => {
      resolveBound = resolve;
    });
    await page.route("**/api/nocturne*", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const response = await route.fetch({ headers });
      assert.equal(response.status(), 200);
      const payload = await response.json();
      if (bindCommitted && committedBinding) {
        const pad = payload.view?.pads?.find(
          (candidate) => Number(candidate.slot) === Number(committedBinding.slot),
        );
        assert.ok(pad, "fixture payload contains the committed controller");
        pad.target_revision = postWriteRevision;
        setPadControlKeys(pad, committedBinding.function, [committedBinding.key]);
        payload.view.save_text = postWriteRevision;
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route("**/nocturne/api/bind", async (route) => {
      committedBinding = JSON.parse(route.request().postData() ?? "{}");
      bindCommitted = true;
      const request = route.request();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: null,
          error: null,
          code: null,
          conflicts: [],
          also_drives: [],
        }),
      });
      resolveBound(request);
    });
    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Logitech G915");
      await page.click('[data-nx="kb-workbench"]');
      await page.click('[data-nx="keylab-pull-mapped"]');
      const keycap = page.locator('.n-deck-key[data-keylab-key="G"]');
      await keycap.click();
      assert.equal((await page.textContent(".n-inspector-title")).trim(), "G");
      assert.match((await page.textContent('[data-nx="inspector-action"]')).trim(), /^Connect/);
      await page.click('[data-nx="inspector-action"]');
      assert.equal(await keycap.evaluate((element) => element.classList.contains("assign")), true);
      await page.locator(
        '.forma-canvas-navigator .navigator-item[data-instance-id="pad-1"]',
      ).evaluate((button) => button.click());
      await settle(page);
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().click();
      const boundRequest = await Promise.race([
        bound,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("workbench mapping did not POST /nocturne/api/bind")),
          5_000,
        )),
      ]);
      const boundBody = JSON.parse(boundRequest.postData() ?? "{}");
      await page.waitForFunction(
        (revision) => document.querySelector(".n-saved")?.textContent?.trim() === revision,
        postWriteRevision,
      );
      assert.equal(await keycap.evaluate((element) => element.classList.contains("assign")), false);
      assert.equal(boundBody?.slot, 1);
      assert.equal(boundBody?.key, "G");
      assert.equal(boundBody?.function, "A");
      assert.equal(boundBody?.mode, "add");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await restoreFixturePanelSource();
      await page.close();
    }
  });

  test("the selection group is empty-handed until something is selected", async () => {
    const page = await openCanvas();
    try {
      assert.equal((await page.textContent(".n-sel-name")).trim(), "Nothing selected");
      const allDisabled = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".n-selbar button")).every((b) => b.disabled),
      );
      assert.ok(allDisabled, "every control must be dead while nothing is selected");

      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      const name = (await page.textContent(".n-sel-name")).trim();
      assert.notEqual(name, "Nothing selected");
      assert.match(name, /P1/, "the group must name the widget it now points at");
      assert.equal(
        await page.evaluate(() => document.querySelector('.n-selbar [data-nx="w-zoom-in"]').disabled),
        false,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a widget grows, shrinks and resets, and the readout tells the truth", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      const start = await scaleOf(page, "pad-1");

      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      const bigger = await scaleOf(page, "pad-1");
      assert.ok(bigger > start, `zoom in must grow the widget (${start} -> ${bigger})`);
      assert.equal(
        (await page.textContent(".n-selsize")).trim(),
        `${Math.round(bigger * 100)}%`,
        "the readout must be the widget's real scale, not a counter of its own",
      );

      await page.click('.n-selbar [data-nx="w-zoom-out"]');
      assert.ok(
        (await scaleOf(page, "pad-1")) < bigger,
        "zoom out must shrink what zoom in grew",
      );

      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      await page.click('.n-selbar [data-nx="w-scale-reset"]');
      assert.equal(await scaleOf(page, "pad-1"), 1, "the readout button resets to 100%");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("focus mode spotlights one widget, and Escape leaves it from anywhere", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      await page.click('.n-selbar [data-nx="w-focus"]');
      await settle(page);
      assert.equal(
        await page.getAttribute('.n-selbar [data-nx="w-focus"]', "aria-pressed"),
        "true",
      );

      // Focus was entered by pressing a BUTTON, so the widget shell does not
      // hold focus — which is exactly the case the engine's own Escape
      // binding cannot serve.
      await page.keyboard.press("Escape");
      await settle(page);
      assert.equal(
        await page.getAttribute('.n-selbar [data-nx="w-focus"]', "aria-pressed"),
        "false",
        "Escape must leave focus mode no matter what holds keyboard focus",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the simultaneous-input modal owns the first Escape over canvas focus mode", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      await page.click('.n-selbar [data-nx="w-focus"]');
      await settle(page);
      const focusToggle = page.locator('.n-selbar [data-nx="w-focus"]');
      assert.equal(await focusToggle.getAttribute("aria-pressed"), "true");

      const opener = page.locator('.n-meta [data-nx="input-test-open"]');
      await opener.click();
      const dialog = page.locator("dialog.n-input-test-dialog");
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });

      assert.equal(
        await focusToggle.getAttribute("aria-pressed"),
        "true",
        "the modal consumes Escape before the underlying canvas focus mode",
      );
      assert.equal(
        await opener.evaluate((button) => document.activeElement === button),
        true,
        "closing with Escape returns focus to the input-test action",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the camera's own controls move it", async () => {
    const page = await openCanvas();
    try {
      // The readout IS the reset button: one control that says where the
      // zoom is and puts it back.
      const readout = () => page.textContent(".n-zoomval");
      const opening = await readout();

      await page.click('[data-nx="canvas-zoom-in"]');
      await settle(page);
      const zoomedIn = await readout();
      assert.notEqual(zoomedIn, opening, "zoom in must change the zoom");

      await page.click('[data-nx="canvas-zoom-reset"]');
      await settle(page);
      assert.equal((await readout()).trim(), "100%", "the 100% button is an absolute reset");

      await page.click('[data-nx="canvas-zoom-out"]');
      await settle(page);
      assert.notEqual((await readout()).trim(), "100%", "zoom out must move off 100%");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("mapping paths project direct bindings, follow geometry, and remember their scope", async () => {
    const page = await openCanvas({}, async (candidate) => {
      // This case owns a closed geometry world. A successful background poll
      // would schedule an unrelated layout and could repair the deliberately
      // delayed Fit mutant even when the flow transition hook is absent.
      await candidate.route("**/api/nocturne*", (route) => route.fulfill({ status: 304 }));
    });
    try {
      const select = '[data-nx="mapping-paths"]';
      const lines = "#n-mapping-paths";
      const ports = "#n-mapping-ports";
      const processors = "#n-mapping-processors";
      assert.equal(await page.inputValue(select), "off", "a fresh canvas stays quiet");
      assert.equal(await page.isHidden(lines), true, "the off lens draws no canvas layer");
      assert.equal(await page.getAttribute(lines, "aria-hidden"), "true");
      assert.equal(await page.getAttribute(lines, "focusable"), "false");
      assert.equal(await page.getAttribute(select, "id"), "n-mapping-path-scope");
      assert.equal(
        await page.getAttribute('label[for="n-mapping-path-scope"]', "class"),
        "n-pathctl-label",
        "the select has one explicit label rather than a wrapper shared with output",
      );

      const selectedSlot = await page.inputValue('input[name="slot"]');
      await page.selectOption(select, "selected");
      await page.waitForFunction(
        ({ lines, selectedSlot }) => {
          const edges = Array.from(document.querySelectorAll(`${lines} .n-flow-edge`));
          return edges.length === 18 &&
            edges.every((edge) => edge.dataset.flowSlot === selectedSlot) &&
            document.querySelector(lines)?.dataset.flowCount === "18";
        },
        { lines, selectedSlot },
      );
      await page.waitForFunction(
        (selectedSlot) =>
          document.querySelector(".n-live-sr")?.textContent ===
            `18 signal links shown for Player ${selectedSlot}: 14 direct and 4 through 1 macro.`,
        selectedSlot,
      );

      const topology = await page.evaluate(({ lines, processors, selectedSlot }) => {
        const node = document.querySelector(`${processors} a.n-flow-processor`);
        const outputs = Array.from(
          document.querySelectorAll(`${lines} [data-flow-kind="macro-output"]`),
        ).map((edge) => ({
          fn: edge.dataset.flowFn,
          steps: edge.dataset.flowSteps,
        })).sort((left, right) => left.fn.localeCompare(right.fn));
        return {
          direct: document.querySelectorAll(`${lines} [data-flow-kind="binding"]`).length,
          triggers: document.querySelectorAll(`${lines} [data-flow-kind="macro-trigger"]`).length,
          outputs,
          nodes: document.querySelectorAll(`${processors} a.n-flow-processor`).length,
          nodeSlot: node?.dataset.flowSlot,
          nodeName: node?.querySelector(".n-flow-processor-name")?.textContent,
          nodeHref: node?.getAttribute("href"),
          nodeLabel: node?.getAttribute("aria-label"),
          macroConnections: document.querySelector(lines)?.dataset.flowMacroConnections,
          processorCount: document.querySelector(lines)?.dataset.flowProcessors,
          unavailableMappings: document.querySelector(lines)?.dataset.flowMappingUnavailable,
          unavailableMacros: document.querySelector(lines)?.dataset.flowMacroUnavailable,
          selectedSlot,
        };
      }, { lines, processors, selectedSlot });
      assert.equal(topology.direct, 14);
      assert.equal(topology.triggers, 1);
      assert.equal(topology.nodes, 1, "one macro group produces one shared processor node");
      assert.equal(topology.nodeSlot, selectedSlot);
      assert.equal(topology.nodeName, "hadouken");
      assert.equal(topology.nodeHref, `/nocturne?slot=${selectedSlot}&macro=hadouken`);
      assert.match(topology.nodeLabel, /Timeline: .* then .* then /);
      assert.deepEqual(
        topology.outputs,
        [
          { fn: "dpad.down", steps: "1 2" },
          { fn: "dpad.right", steps: "2" },
          { fn: "x", steps: "3" },
        ],
        "repeated holds deduplicate without losing where they occur in the timeline",
      );
      assert.equal(topology.macroConnections, "4");
      assert.equal(topology.processorCount, "1");
      assert.equal(topology.unavailableMappings, "0");
      assert.equal(topology.unavailableMacros, "0");

      const routeIndex = page.locator("details.n-flow-route-index");
      assert.equal(await routeIndex.isHidden(), false,
        "visible cords also expose a semantic route index");
      assert.equal(
        (await routeIndex.locator("[data-flow-route-index-count]").textContent()).trim(),
        "15 routes",
        "four macro segments collapse into one logical trace while direct routes stay independent",
      );
      await routeIndex.locator("summary").click();
      const sourceKey = page.locator(
        '.n-widget-kb:not([data-source-hidden="true"]) [data-key="G"]:not(.ghost):not(.extracted)',
      ).first();
      await sourceKey.evaluate((key) => {
        key.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      });
      await page.waitForFunction(
        (lines) => Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`))
          .some((edge) => edge.dataset.flowKey === "G"),
        lines,
      );
      const firstSemanticRoute = routeIndex.locator(".n-flow-route-row")
        .filter({ hasNotText: "Keyboard · G →" }).first();
      await firstSemanticRoute.evaluate((row) => row.focus());
      const semanticChain = await firstSemanticRoute.getAttribute("data-flow-chain");
      assert.ok(semanticChain, "each semantic row identifies one logical route");
      await page.waitForFunction(
        ({ lines, semanticChain }) => {
          const related = Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`));
          return related.length === 1 && related[0].dataset.flowChain === semanticChain;
        },
        { lines, semanticChain },
      );
      assert.ok(semanticChain,
        "keyboard focus wins even while a different pointer inspection remains active");
      assert.match(
        (await page.locator("#n-mapping-trace").textContent()).trim(),
        /^Tracing Keyboard · .+ → P\d+ .+$/,
        "keyboard focus gets a visible, human-readable trace instead of relying on aria-hidden SVG",
      );
      assert.equal(await page.getAttribute(lines, "aria-hidden"), "true");
      await page.locator(select).focus();
      await routeIndex.locator("summary").click();
      assert.equal(
        await page.evaluate((processors) => {
          const node = document.querySelector(`${processors} a.n-flow-processor`).getBoundingClientRect();
          return Array.from(document.querySelectorAll(".widget-drag-handle"))
            .filter((handle) => getComputedStyle(handle).visibility !== "hidden")
            .some((handle) => {
              const rect = handle.getBoundingClientRect();
              return node.left < rect.right && node.right > rect.left &&
                node.top < rect.bottom && node.bottom > rect.top;
            });
        }, processors),
        false,
        "the processing card never covers a widget move control",
      );

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() =>
        matchMedia("(prefers-reduced-motion: reduce)").matches
      );
      const reducedMotion = await page.evaluate(({ lines, processors }) => {
        const route = document.querySelector(`${lines} [data-flow-kind="binding"]`);
        route?.classList.add("is-live");
        const nodeStyle = getComputedStyle(
          document.querySelector(`${processors} a.n-flow-processor`),
        );
        const routeStyle = getComputedStyle(route?.querySelector(".n-flow-core"));
        const result = {
          nodeTransition: nodeStyle.transitionDuration,
          routeAnimation: routeStyle.animationName,
        };
        route?.classList.remove("is-live");
        return result;
      }, { lines, processors });
      assert.equal(reducedMotion.nodeTransition, "0s");
      assert.equal(reducedMotion.routeAnimation, "none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.waitForFunction(() =>
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      );
      await page.waitForFunction(() => {
        const widgets = Array.from(document.querySelectorAll(".widget-instance"));
        widgets.forEach((widget) => void getComputedStyle(widget).transform);
        return widgets.every((widget) => widget.getAnimations().filter(
          (animation) => animation instanceof CSSAnimation &&
            animation.animationName === "forma-widget-materialize",
        ).every((animation) => animation.playState === "finished"));
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

      const truth = await page.evaluate(({ lines, ports, selectedSlot }) => {
        const edges = Array.from(document.querySelectorAll(`${lines} .n-flow-edge`));
        const gFanout = edges
          .filter((edge) => edge.dataset.flowKey === "G")
          .map((edge) => edge.dataset.flowFn)
          .sort();
        const badPaths = Array.from(document.querySelectorAll(`${lines} path`))
          .filter((path) => /NaN|Infinity/.test(path.getAttribute("d") ?? ""));
        const layer = document.querySelector(lines);
        const stage = document.querySelector(".forma-canvas-stage");
        const sourceEdge = edges.find(
          (edge) => edge.dataset.flowKind === "binding" && edge.dataset.flowKey === "G",
        );
        const sourcePort = sourceEdge?.dataset.flowId
          ? document.querySelector(
            `${ports} [data-flow-id="${CSS.escape(sourceEdge.dataset.flowId)}"] .n-flow-port-source`,
          )
          : null;
        const start = sourceEdge?.querySelector(".n-flow-core")?.getAttribute("d")
          ?.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/);
        const pathStartsAtPort = Boolean(start && sourcePort) &&
          Math.abs(Number(start[1]) - Number(sourcePort.getAttribute("cx"))) < 0.01 &&
          Math.abs(Number(start[2]) - Number(sourcePort.getAttribute("cy"))) < 0.01;
        const sourceKey = document.querySelector(
          `.n-deck-key[data-keylab-key="G"][data-player-slot="${selectedSlot}"]`,
        ) ?? document.querySelector(
          '.n-widget-kb:not([data-source-hidden="true"]) [data-key="G"]:not(.ghost):not(.extracted)',
        );
        const portRect = sourcePort?.getBoundingClientRect();
        const keyRect = sourceKey?.getBoundingClientRect();
        const portCenter = portRect
          ? { x: portRect.left + portRect.width / 2, y: portRect.top + portRect.height / 2 }
          : null;
        const sourceOnKeycap = Boolean(portCenter && keyRect) &&
          portCenter.x >= keyRect.left - 1 &&
          portCenter.x <= keyRect.right + 1 &&
          portCenter.y >= keyRect.top - 1 &&
          portCenter.y <= keyRect.bottom + 1 &&
          Math.min(
            Math.abs(portCenter.x - keyRect.left),
            Math.abs(portCenter.x - keyRect.right),
            Math.abs(portCenter.y - keyRect.top),
            Math.abs(portCenter.y - keyRect.bottom),
          ) <= 1.5;
        return {
          gFanout,
          badPaths: badPaths.length,
          unresolved: document.querySelectorAll(`${lines} .is-unresolved`).length,
          pointerEvents: getComputedStyle(document.querySelector(ports)).pointerEvents,
          transformsMatch: layer.style.transform === stage.style.transform,
          lineZ: Number(getComputedStyle(layer).zIndex),
          stageZ: Number(getComputedStyle(stage).zIndex),
          portZ: Number(getComputedStyle(document.querySelector(ports)).zIndex),
          pathStartsAtPort,
          sourceOnKeycap,
          selectedOnly: edges.every((edge) => edge.dataset.flowSlot === selectedSlot),
        };
      }, { lines, ports, selectedSlot });
      assert.deepEqual(truth.gFanout, ["a", "b"], "one physical G key truthfully fans out");
      assert.equal(truth.badPaths, 0);
      assert.equal(truth.unresolved, 0, "every fixture binding finds one visible endpoint");
      assert.equal(truth.pointerEvents, "none", "the lens never steals mapping gestures");
      assert.equal(truth.transformsMatch, true, "paths share the exact canvas camera");
      assert.ok(truth.lineZ > truth.stageZ, "cords paint above opaque widget art");
      assert.ok(truth.portZ > truth.lineZ, "endpoint handles remain above their cords");
      assert.equal(truth.pathStartsAtPort, true, "the painted path begins at its source handle");
      assert.equal(truth.sourceOnKeycap, true, "the visible cord starts on the physical keycap rim");
      assert.equal(truth.selectedOnly, true);

      const minRestingContrast = await page.evaluate(() => {
        const root = document.querySelector(".nocturne");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const rgb = (color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = "#000";
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const luminance = ([red, green, blue]) => {
          const channel = (value) => {
            const normalized = value / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
        };
        const background = rgb("#191b28");
        const backgroundLuminance = luminance(background);
        for (let slot = 1; slot <= 16; slot += 1) {
          const edge = document.createElementNS("http://www.w3.org/2000/svg", "g");
          edge.classList.add("n-flow-edge");
          edge.style.setProperty("--n-flow-color", `var(--pcs${slot})`);
          const core = document.createElementNS("http://www.w3.org/2000/svg", "path");
          core.classList.add("n-flow-core");
          edge.append(core);
          svg.append(edge);
        }
        root.append(svg);
        // Re-read after connection so inherited player palette variables and
        // color-mix() are resolved in the same tree as the real canvas.
        const connectedContrasts = Array.from(svg.children).map((edge) => {
          const opacity = Number(getComputedStyle(edge).opacity);
          const stroke = rgb(getComputedStyle(edge.firstElementChild).stroke);
          const painted = stroke.map((channel, index) =>
            channel * opacity + background[index] * (1 - opacity));
          const foregroundLuminance = luminance(painted);
          return (Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
            (Math.min(backgroundLuminance, foregroundLuminance) + 0.05);
        });
        svg.remove();
        return Math.min(...connectedContrasts);
      });
      assert.ok(
        minRestingContrast >= 3,
        `all sixteen resting player cords must clear 3:1 (${minRestingContrast})`,
      );

      const source = `.n-widget-kb [data-key="G"]`;
      await page.hover(source);
      await page.waitForFunction(
        (lines) => document.querySelectorAll(`${lines} .n-flow-edge.is-related`).length === 2,
        lines,
      );
      assert.deepEqual(
        await page.evaluate((lines) =>
          Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`))
            .map((edge) => edge.dataset.flowFn)
            .sort(), lines),
        ["a", "b"],
        "endpoint inspection isolates every branch of the physical key",
      );

      const focusedTarget = 'details[data-fn="A"] > summary';
      await page.focus(focusedTarget);
      await page.hover('.n-widget-kb [data-key="W"]');
      await page.waitForFunction(
        (lines) => {
          const related = Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`));
          return related.length === 1 && related[0].dataset.flowKey === "W";
        },
        lines,
      );
      await page.hover(select);
      await page.waitForFunction(
        (lines) => {
          const related = Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`));
          return related.length === 2 && related.every((edge) => edge.dataset.flowFn === "a");
        },
        lines,
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.closest("[data-fn]")?.getAttribute("data-fn")),
        "A",
        "pointer inspection falls back to the still-focused endpoint",
      );

      await page.click(
        `.forma-canvas-navigator .navigator-item[data-instance-id="pad-${selectedSlot}"]`,
      );
      await settle(page);
      const padSelector = `.widget-instance[data-instance-id="pad-${selectedSlot}"]`;
      assert.equal(
        await page.locator(padSelector).evaluate((pad) => pad.classList.contains("is-active")),
        true,
        "the navigator selects the real pad",
      );
      const handle = `${padSelector} .widget-drag-handle`;
      await page.focus(handle);
      assert.equal(
        await page.evaluate((selector) => document.activeElement?.matches(selector), handle),
        true,
        "the selected pad exposes its keyboard move handle",
      );
      const beforeMove = await page.getAttribute(
        `${lines} [data-flow-key="G"][data-flow-fn="a"] .n-flow-core`,
        "d",
      );
      const beforePadX = await page.getAttribute(padSelector, "data-canvas-x");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ selector, beforePadX }) =>
          document.querySelector(selector)?.getAttribute("data-canvas-x") !== beforePadX,
        { selector: padSelector, beforePadX },
      );
      await page.waitForFunction(
        ({ selector, beforeMove }) => document.querySelector(selector)?.getAttribute("d") !== beforeMove,
        {
          selector: `${lines} [data-flow-key="G"][data-flow-fn="a"] .n-flow-core`,
          beforeMove,
        },
      );
      assert.equal(
        await page.evaluate((lines) =>
          Array.from(document.querySelectorAll(`${lines} path`))
            .some((path) => /NaN|Infinity/.test(path.getAttribute("d") ?? "")), lines),
        false,
        "moving a controller leaves every curve finite",
      );

      await page.click('[data-nx="canvas-zoom-in"]');
      await page.click('[data-nx="canvas-zoom-in"]');
      await settle(page);
      const processorWidthBeforeFit = await page.locator(
        `${processors} a.n-flow-processor`,
      ).evaluate((processor) => processor.getBoundingClientRect().width);
      // Make the runner timing deterministic: the broken version stopped its
      // camera loop at 220 ms while this independent flow transform was still
      // moving, then permanently kept lanes calculated against that stale CTM.
      // The layer's own transition completion must trigger the final layout.
      await page.locator(`${lines}, ${ports}, ${processors}`).evaluateAll((layers) => {
        for (const layer of layers) layer.style.transition = "transform 360ms linear";
      });
      await page.click('[data-nx="canvas-fit"]');
      await page.waitForFunction(() => document.querySelector(".is-camera-animating"));
      await page.waitForTimeout(80);
      const processorWidthDuringFit = await page.locator(
        `${processors} a.n-flow-processor`,
      ).evaluate((processor) => processor.getBoundingClientRect().width);
      await settle(page);
      const processorGeometry = await page.evaluate(({ ports, processors }) => {
        const node = document.querySelector(`${processors} a.n-flow-processor`).getBoundingClientRect();
        const center = { x: node.left + node.width / 2, y: node.top + node.height / 2 };
        const attachedPorts = [
          document.querySelector(`${ports} [data-flow-kind="macro-trigger"] .n-flow-port-target`),
          document.querySelector(`${ports} [data-flow-kind="macro-output"] .n-flow-port-source`),
        ].map((port) => {
          const rect = port.getBoundingClientRect();
          return Math.hypot(rect.left + rect.width / 2 - center.x, rect.top + rect.height / 2 - center.y);
        });
        return { width: node.width, attachedPorts };
      }, { ports, processors });
      for (const width of [processorWidthDuringFit, processorGeometry.width]) {
        assert.ok(
          Math.abs(width - processorWidthBeforeFit) <= 2,
          `processor width stays fixed through Fit (${processorWidthBeforeFit} -> ${width})`,
        );
      }
      assert.ok(
        processorGeometry.attachedPorts.every((distance) => distance <= 3),
        `macro cords finish attached to their processor (${processorGeometry.attachedPorts.join(", ")})`,
      );

      await page.hover(select);
      await page.waitForFunction(() => document.getAnimations().every((animation) => {
        const target = animation.effect?.target;
        return !(target instanceof Element) ||
          !target.matches(".n-kb .n-key, .n-deck-key, .n-ipac-signal") ||
          animation.playState === "finished";
      }));
      const selectedDirectState = await settledDirectLassoState(page, lines, selectedSlot);
      const selectedDirectTopology = selectedDirectState.topology;
      assert.equal(
        selectedDirectState.valid,
        true,
        `Selected paints each complete lasso on its declared lane (${JSON.stringify(selectedDirectState.invalid)})`,
      );
      assert.equal(
        selectedDirectTopology.every(([id, lane]) => id && Number.isInteger(lane)),
        true,
        "selected routes expose complete identities and stable integer lanes",
      );
      assert.equal(
        new Set(selectedDirectTopology.map(([id]) => id)).size,
        selectedDirectTopology.length,
        "selected route identities are unique before changing scope",
      );

      await page.selectOption(select, "all");
      await page.waitForFunction(
        (lines) => {
          const layer = document.querySelector(lines);
          return document.querySelectorAll(`${lines} .n-flow-edge`).length === 36 &&
            layer?.dataset.flowMode === "all" &&
            layer?.dataset.flowCount === "36" &&
            layer?.dataset.flowResolvedDirect === "28" &&
            layer?.dataset.flowUnresolved === "0";
        },
        lines,
      );
      assert.equal(
        await page.evaluate((lines) =>
          new Set(Array.from(document.querySelectorAll(`${lines} .n-flow-edge`))
            .map((edge) => edge.dataset.flowSlot)).size, lines),
        2,
        "the explicit all-player scope carries both staged players",
      );
      assert.equal(
        await page.locator(`${processors} a.n-flow-processor`).count(),
        2,
        "same-named macros in different slots remain separate processors",
      );
      const allDirectState = await settledDirectLassoState(page, lines, selectedSlot);
      assert.equal(
        allDirectState.valid,
        true,
        `All paints each complete lasso on its declared lane (${JSON.stringify(allDirectState.invalid)})`,
      );
      const traceability = await page.evaluate(
        ({ lines, selectedSlot }) => {
          const visible = (element) => {
            if (!(element instanceof Element) || element.closest("details:not([open])")) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2 || element.getClientRects().length === 0) return false;
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
          };
          const center = (element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          };
          const perimeter = (element, toward) => {
            const rect = element.getBoundingClientRect();
            const origin = center(element);
            const dx = toward.x - origin.x;
            const dy = toward.y - origin.y;
            const halfWidth = rect.width / 2;
            const halfHeight = rect.height / 2;
            if (
              Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 ||
              halfWidth < 1 || halfHeight < 1
            ) return origin;
            const round = element.localName === "circle" || element.localName === "ellipse" || (
              element.matches(".n-deck-key") &&
              element.closest('.n-keylab-deck[data-render-mode="arcade"]')
            );
            const distance = round
              ? 1 / Math.sqrt((dx * dx) / (halfWidth * halfWidth) + (dy * dy) / (halfHeight * halfHeight))
              : 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
            return { x: origin.x + dx * distance, y: origin.y + dy * distance };
          };
          const directional = (value) => {
            const normalized = value.trim().toLowerCase();
            const match = /^([lr][xy])\.(min|max|[+-]?\d+)$/.exec(normalized);
            if (!match) return null;
            if (match[2] === "min" || match[2] === "max") return normalized;
            const amount = Number(match[2]);
            return Number.isInteger(amount) && amount >= -32768 && amount <= 32767 && amount !== 0
              ? `${match[1]}.${amount < 0 ? "min" : "max"}`
              : null;
          };
          const sameControl = (left, right) => {
            const a = left.trim().toLowerCase();
            const b = right.trim().toLowerCase();
            return a === b || directional(a) !== null && directional(a) === directional(b);
          };
          const resolveSource = (route) => {
            const key = CSS.escape(route.key);
            const slot = CSS.escape(String(route.slot));
            const observed = ':is([data-flow-authority="matched"], [data-flow-authority="mismatch"], [data-flow-authority="observed"])';
            const provisional = ':is([data-flow-authority="configured"], [data-flow-authority="expected"], [data-flow-authority="planned"])';
            const selectors = [
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"][data-player-slot="${slot}"]${observed}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]${observed}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"]:not([data-player-slot])${observed}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])${observed}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"][data-player-slot="${slot}"]${provisional}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]${provisional}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-selected="true"]:not([data-player-slot])${provisional}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])${provisional}`,
              `.n-surface-channel-anchor[data-flow-key="${key}"][data-player-slot="${slot}"]`,
              `.n-surface-channel-anchor[data-flow-key="${key}"]:not([data-player-slot])`,
              `.n-surface-channel-anchor:not([data-flow-key])[data-key="${key}"][data-player-slot="${slot}"]`,
              `.n-surface-channel-anchor:not([data-flow-key])[data-key="${key}"]:not([data-player-slot])`,
              `.n-deck-key[data-keylab-key="${key}"][data-player-slot="${slot}"]`,
              `.n-deck-key[data-keylab-key="${key}"]:not([data-player-slot])`,
              `.n-widget-kb:not([data-source-hidden="true"]) .n-ipac-signal[data-key="${key}"][data-player-slot="${slot}"]`,
              `.n-widget-kb:not([data-source-hidden="true"]) .n-ipac-signal[data-key="${key}"]`,
              `.n-widget-kb:not([data-source-hidden="true"]) [data-key="${key}"]:not(.ghost):not(.extracted)`,
            ];
            return selectors
              .map((selector) => document.querySelector(selector))
              .find((candidate) => visible(candidate)) ?? null;
          };
          const resolveTarget = (route) => {
            const slot = CSS.escape(String(route.slot));
            const pad = document.querySelector(`.n-widget-pad [data-pad-slot="${slot}"]`);
            if (!pad) return null;
            return Array.from(pad.querySelectorAll("svg [data-fn]"))
              .filter((candidate) =>
                candidate.localName !== "text" && !candidate.classList.contains("n-fnkey") &&
                (candidate.getAttribute("data-fn") ?? "").split(/\s+/)
                  .some((fn) => sameControl(fn, route.fn)) && visible(candidate)
              )
              .map((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const hook = /hook/i.test(candidate.getAttribute("class") ?? "") ? 1000 : 0;
                const shape = /^(?:path|circle|ellipse|rect|polygon)$/.test(candidate.localName) ? 100 : 0;
                const hit = getComputedStyle(candidate).pointerEvents === "none" ? 0 : 25;
                return {
                  candidate,
                  score: hook + shape + hit - Math.log2(Math.max(1, rect.width * rect.height)),
                };
              })
              .sort((left, right) => right.score - left.score)[0]?.candidate ?? null;
          };
          const semanticEndpointDistance = (route, sourcePoint, targetPoint) => {
            const source = resolveSource(route);
            const target = resolveTarget(route);
            if (!source || !target) {
              return { sourceDistance: Infinity, targetDistance: Infinity };
            }
            const expectedSource = perimeter(source, targetPoint);
            const expectedTarget = perimeter(target, center(source));
            const sourceDistance = Math.hypot(
              sourcePoint.x - expectedSource.x,
              sourcePoint.y - expectedSource.y,
            );
            const targetDistance = Math.hypot(
              targetPoint.x - expectedTarget.x,
              targetPoint.y - expectedTarget.y,
            );
            return { sourceDistance, targetDistance };
          };
          const routes = Array.from(
            document.querySelectorAll(`${lines} [data-flow-kind="binding"]`),
          ).map((edge) => {
            const id = edge.dataset.flowId;
            const path = edge.querySelector(".n-flow-core");
            const d = path?.getAttribute("d") ?? "";
            const portGroup = id
              ? document.querySelector(
                `#n-mapping-ports [data-flow-id="${CSS.escape(id)}"]`,
              )
              : null;
            const sourcePort = portGroup?.querySelector(".n-flow-port-source");
            const targetPort = portGroup?.querySelector(".n-flow-port-target");
            const length = path?.getTotalLength() ?? 0;
            const start = path?.getPointAtLength(0);
            const finish = path?.getPointAtLength(length);
            const source = sourcePort
              ? {
                x: Number(sourcePort.getAttribute("cx")),
                y: Number(sourcePort.getAttribute("cy")),
              }
              : null;
            const target = targetPort
              ? {
                x: Number(targetPort.getAttribute("cx")),
                y: Number(targetPort.getAttribute("cy")),
              }
              : null;
            const sourceScreen = sourcePort ? center(sourcePort) : null;
            const targetScreen = targetPort ? center(targetPort) : null;
            const endpointDistances = sourceScreen && targetScreen
              ? semanticEndpointDistance({
                slot: edge.dataset.flowSlot,
                key: edge.dataset.flowKey,
                fn: edge.dataset.flowFn,
              }, sourceScreen, targetScreen)
              : { sourceDistance: Infinity, targetDistance: Infinity };
            return {
              id,
              slot: edge.dataset.flowSlot,
              key: edge.dataset.flowKey,
              fn: edge.dataset.flowFn,
              d,
              commands: d.match(/[A-Za-z]/gu) ?? [],
              laneIndex: Number(edge.dataset.flowLaneIndex),
              opacity: getComputedStyle(edge).opacity,
              touchesPorts: Boolean(start && finish && source && target) &&
                Math.hypot(start.x - source.x, start.y - source.y) <= 0.05 &&
                Math.hypot(finish.x - target.x, finish.y - target.y) <= 0.05,
              semanticEndpoints: endpointDistances.sourceDistance <= 2 &&
                endpointDistances.targetDistance <= 2,
              endpointDistances,
              path,
              length,
            };
          });
          const fanout = routes.filter(
            (route) => route.slot === selectedSlot && route.key === "G",
          );
          const fanoutSeparation = fanout.length === 2
            ? Math.max(...[0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45].map((ratio) => {
              const left = fanout[0].path.getPointAtLength(fanout[0].length * ratio);
              const right = fanout[1].path.getPointAtLength(fanout[1].length * ratio);
              return Math.hypot(left.x - right.x, left.y - right.y);
            }))
            : 0;
          return {
            routeCount: routes.length,
            uniquePathCount: new Set(routes.map((route) => route.d)).size,
            allSingleCubics: routes.every((route) =>
              route.commands.length === 2 &&
              route.commands[0] === "M" &&
              route.commands[1] === "C"
            ),
            allLaneMetadata: routes.every((route) => Number.isInteger(route.laneIndex)),
            allTouchPorts: routes.every((route) => route.touchesPorts),
            allSemanticEndpoints: routes.every((route) => route.semanticEndpoints),
            worstSemanticEndpoints: routes
              .filter((route) => !route.semanticEndpoints)
              .map((route) => ({ id: route.id, ...route.endpointDistances })),
            restingOpacities: [...new Set(routes.map((route) => route.opacity))],
            laneCounts: [...new Set(routes.map((route) => route.slot))].map((slot) => {
              const members = routes.filter((route) => route.slot === slot);
              const indexes = members.map((route) => route.laneIndex)
                .sort((left, right) => left - right);
              return {
                slot,
                count: members.length,
                unique: new Set(members.map((route) => route.laneIndex)).size,
                contiguous: indexes.every((lane, index) => lane === index),
              };
            }),
            fanoutFunctions: fanout.map((route) => route.fn).sort(),
            fanoutSeparation,
            geometry: Object.fromEntries(routes.map((route) => [route.id, route.d])),
          };
        },
        { lines, selectedSlot },
      );
      assert.equal(traceability.routeCount, 28);
      assert.equal(
        traceability.uniquePathCount,
        traceability.routeCount,
        "every logical binding owns distinct SVG geometry",
      );
      assert.equal(
        traceability.allSingleCubics,
        true,
        "direct bindings are independent lasso curves with no shared bus segments",
      );
      assert.equal(
        traceability.allLaneMetadata,
        true,
        "every resolved path exposes a stable lane identity",
      );
      assert.equal(
        traceability.allTouchPorts,
        true,
        "every lasso runs from its exact key handle to its exact control handle",
      );
      assert.equal(
        traceability.allSemanticEndpoints,
        true,
        `every lasso attaches to DOM anchors matching its key and control (${JSON.stringify(traceability.worstSemanticEndpoints)})`,
      );
      assert.deepEqual(
        traceability.restingOpacities,
        ["0.62"],
        "all-player cords retain quiet overview contrast",
      );
      assert.equal(
        traceability.laneCounts.every(({ count, unique, contiguous }) =>
          count > 7 && unique === count && contiguous
        ),
        true,
        `every direct route keeps a unique lane beyond the old seven-lane limit (${JSON.stringify(traceability.laneCounts)})`,
      );
      assert.deepEqual(
        traceability.fanoutFunctions,
        ["a", "b"],
        "the shared G endpoint keeps both truthful destinations",
      );
      assert.ok(
        traceability.fanoutSeparation >= 6,
        `G's two cords visibly diverge after their truthful shared key (${traceability.fanoutSeparation}px)`,
      );
      assert.deepEqual(
        allDirectState.topology,
        selectedDirectTopology,
        "switching from Selected to All preserves the exact route set and each route's lane identity",
      );

      await page.locator('[data-instance-id="keyboard"] [data-key="G"]').first().hover();
      await page.waitForFunction(() =>
        document.querySelector(
          '[data-instance-id="pad-2"] [data-fn~="a"].n-flow-anchor-related',
        )
      );
      const relatedHookPaint = await page.evaluate(() => {
        const hook = document.querySelector(
          '[data-instance-id="pad-2"] [data-fn~="a"].n-flow-anchor-related',
        );
        const style = getComputedStyle(hook);
        return { fill: style.fill, stroke: style.stroke };
      });
      assert.doesNotMatch(
        relatedHookPaint.fill,
        /^(?:none|rgba\(0, 0, 0, 0\))$/,
        "the exact premium-art destination receives visible related paint",
      );
      assert.notEqual(relatedHookPaint.stroke, "none");
      await page.locator(select).hover();

      const liveIdentity = await page.evaluate((lines) => {
          const first = document.querySelector(`${lines} [data-flow-slot="1"][data-flow-kind="binding"]`);
          const second = document.querySelector(`${lines} [data-flow-slot="2"][data-flow-kind="binding"]`);
          first?.style.setProperty("transition", "none");
          second?.style.setProperty("transition", "none");
          first?.classList.add("is-live");
          second?.classList.add("is-live");
          const firstCore = first?.querySelector(".n-flow-core");
          const secondCore = second?.querySelector(".n-flow-core");
          const patterns = [firstCore, secondCore].map((core) =>
            core ? getComputedStyle(core).strokeDasharray : "",
          );
          const travel = firstCore?.getAnimations().find((animation) =>
            animation instanceof CSSAnimation && animation.animationName === "n-flow-travel"
          );
          travel?.pause();
          if (travel) travel.currentTime = 0;
          const offsetBefore = firstCore ? getComputedStyle(firstCore).strokeDashoffset : "";
          if (travel) travel.currentTime = 180;
          const offsetAfter = firstCore ? getComputedStyle(firstCore).strokeDashoffset : "";
          const animation = firstCore ? getComputedStyle(firstCore).animationName : "";
          const opacity = first ? getComputedStyle(first).opacity : "";
          const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
          const connected = Boolean(first?.isConnected && firstCore?.isConnected);
          first?.classList.remove("is-live");
          second?.classList.remove("is-live");
          first?.style.removeProperty("transition");
          second?.style.removeProperty("transition");
          return {
            patterns,
            offsetBefore,
            offsetAfter,
            animation,
            opacity,
            reducedMotion,
            connected,
            travelFound: Boolean(travel),
          };
        }, lines);
      assert.notEqual(liveIdentity.patterns[0], "none", "Player 1 has a visible travel rhythm");
      assert.notEqual(
        liveIdentity.patterns[0],
        liveIdentity.patterns[1],
        "live travel keeps each player's non-color dash identity",
      );
      assert.equal(
        liveIdentity.animation,
        "n-flow-travel",
        `live travel is enabled outside reduced motion (${JSON.stringify(liveIdentity)})`,
      );
      assert.equal(liveIdentity.opacity, "1", "a live cord rises above all-player overview opacity");
      assert.notEqual(liveIdentity.offsetBefore, liveIdentity.offsetAfter, "Player 1's live cord travels");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (select) => document.querySelector(select)?.value === "all",
        select,
      );
      await page.waitForFunction(
        (lines) => document.querySelectorAll(`${lines} [data-flow-kind="binding"]`).length === 28,
        lines,
      );
      await page.waitForFunction((lines) => {
        const routes = Array.from(
          document.querySelectorAll(`${lines} [data-flow-kind="binding"]`),
        );
        const geometry = routes.map(
          (edge) => edge.querySelector(".n-flow-core")?.getAttribute("d") ?? "",
        );
        return geometry.every(Boolean) && new Set(geometry).size === routes.length;
      }, lines);
      const reloadedTraceability = await page.evaluate((lines) => {
        const routes = Array.from(
          document.querySelectorAll(`${lines} [data-flow-kind="binding"]`),
        ).map((edge) => ({
          id: edge.dataset.flowId,
          d: edge.querySelector(".n-flow-core")?.getAttribute("d") ?? "",
        }));
        return {
          ids: routes.map((route) => route.id).sort(),
          uniquePathCount: new Set(routes.map((route) => route.d)).size,
          allSingleCubics: routes.every((route) => {
            const commands = route.d.match(/[A-Za-z]/gu) ?? [];
            return commands.length === 2 && commands[0] === "M" && commands[1] === "C";
          }),
        };
      }, lines);
      assert.deepEqual(
        reloadedTraceability.ids,
        Object.keys(traceability.geometry).sort(),
        "hydration keeps the same set of bindings",
      );
      assert.equal(
        reloadedTraceability.uniquePathCount,
        reloadedTraceability.ids.length,
        "hydration keeps distinct geometry for every binding",
      );
      assert.equal(
        reloadedTraceability.allSingleCubics,
        true,
        "hydration cannot restore the removed shared-bus router",
      );
      assert.equal(await page.inputValue(select), "all", "scope persists with canvas chrome");
      assert.equal(
        await page.evaluate((selector) => document.querySelector(selector)?.tabIndex, lines),
        -1,
        "the visual-only layer never enters tab order",
      );
      await page.selectOption(select, "off");
      await page.waitForFunction(
        ({ lines, ports, processors }) =>
          document.querySelector(lines)?.hasAttribute("hidden") === true &&
          document.querySelector(ports)?.hasAttribute("hidden") === true &&
          document.querySelector(processors)?.hasAttribute("hidden") === true &&
          document.querySelector(lines)?.dataset.flowCount === "0" &&
          document.querySelector(ports)?.dataset.flowCount === "0" &&
          document.querySelector(processors)?.dataset.flowCount === "0" &&
          (document.querySelector(".n-pathcount")?.textContent ?? "") === "",
        { lines, ports, processors },
      );
      assert.equal(
        await page.getAttribute(".n-pathcount", "title"),
        "Mapping paths are off",
        "off mode clears the prior count and its stale tooltip",
      );

      await page.evaluate(() => {
        for (const selector of [".n-widget-kb", ".n-widget-keylab"]) {
          const item = document.querySelector(selector);
          if (item) item.style.visibility = "hidden";
        }
      });
      await page.selectOption(select, "selected");
      await page.waitForFunction(
        (lines) => document.querySelector(lines)?.dataset.flowMode === "selected",
        lines,
      );
      await page.waitForFunction(
        (lines) =>
          document.querySelector(lines)?.dataset.flowCount === "3" &&
          document.querySelector(lines)?.dataset.flowUnresolved === "15",
        lines,
      );
      assert.deepEqual(
        await page.evaluate((lines) => ({
          count: document.querySelector(lines)?.dataset.flowCount,
          unresolved: document.querySelector(lines)?.dataset.flowUnresolved,
          announcement: document.querySelector(".n-live-sr")?.textContent,
        }), lines),
        {
          count: "3",
          unresolved: "15",
          announcement:
            `3 signal links shown for Player ${selectedSlot}: 0 direct and 3 through 1 macro; 15 connections have endpoints that are not visible.`,
        },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the semantic route index describes independent macro triggers as alternatives", async () => {
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        for (const pad of payload.view?.pads ?? []) {
          const macro = pad.macros?.find((row) => row.name === "hadouken");
          if (macro) macro.triggers = ["G", "H"];
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      await page.waitForFunction(() =>
        document.querySelectorAll(
          '#n-mapping-paths [data-flow-kind="macro-trigger"]',
        ).length === 2
      );
      const index = page.locator("details.n-flow-route-index");
      await index.locator("summary").click();
      const route = index.locator(".n-flow-route-row").filter({ hasText: "hadouken macro" });
      await route.waitFor({ state: "visible" });
      const text = (await route.textContent()).replace(/\s+/g, " ").trim();
      assert.match(text, /Keyboard · G or Keyboard · H → P\d+ hadouken macro →/,
        "either trigger is named as an alternative, never as an invented chord");
      assert.doesNotMatch(text, /Keyboard · G \+ Keyboard · H/);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a macro processor opens the exact existing step editor without writing", async () => {
    const page = await openCanvas();
    const writes = [];
    let delayClose = false;
    let releaseClose = () => {};
    let sawCloseRequest = () => {};
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    const closeSeen = new Promise((resolve) => {
      sawCloseRequest = resolve;
    });
    await page.route("**/api/nocturne*", async (route) => {
      const url = new URL(route.request().url());
      if (delayClose && !url.searchParams.has("macro")) {
        sawCloseRequest();
        await closeGate;
      }
      await route.continue();
    });
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    try {
      const slot = await page.inputValue('input[name="slot"]');
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const node = page.locator("#n-mapping-processors a.n-flow-processor");
      await node.waitFor({ state: "visible" });
      assert.equal(await node.getAttribute("aria-haspopup"), "dialog");
      assert.equal(await node.getAttribute("aria-controls"), "n-macro-dialog");
      const modified = await node.evaluate((element) => {
        let productPrevented = true;
        const inspect = (event) => {
          productPrevented = event.defaultPrevented;
          // Keep this synthetic semantics probe from performing its native
          // navigation after the product has had its chance to handle it.
          event.preventDefault();
        };
        document.addEventListener("click", inspect, { once: true });
        element.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true,
        }));
        return { productPrevented, href: location.href };
      });
      assert.equal(modified.productPrevented, false, "Ctrl-click keeps the anchor's native semantics");
      assert.equal(new URL(modified.href).searchParams.has("macro"), false);
      await node.click();
      await page.waitForURL(new RegExp(`/nocturne\\?slot=${slot}&macro=hadouken$`));
      await page.locator("#n-macro-dialog").waitFor({ state: "visible" });
      assert.equal(await page.isVisible("#n-macro-dialog"), true);
      assert.equal(await page.getAttribute("#n-macro-dialog", "role"), "dialog");
      assert.equal(await page.getAttribute("#n-macro-dialog", "aria-modal"), "true");
      await page.waitForFunction(
        () => document.querySelector("#n-macro-dialog")?.contains(document.activeElement),
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "n-macro-dialog",
        "the enhanced link moves focus into the modal instead of leaving it on the page body",
      );
      // A poll or scope change can replace the processor DOM while its editor
      // is open. Return focus to the replacement interactive anchor, not an
      // aria-hidden SVG group that carries the same graph identifier.
      await page.selectOption('[data-nx="mapping-paths"]', "all");
      await page.waitForFunction(
        () => document.querySelectorAll("#n-mapping-processors a.n-flow-processor").length === 2,
      );
      assert.equal(
        (await page.textContent(".n-macdirty")).trim(),
        "",
        "opening and changing path scope do not create a macro edit",
      );
      delayClose = true;
      await page.click(".n-macx");
      const closeClick = await page.evaluate(() => ({
        url: location.href,
        dirty: document.querySelector(".n-macdirty")?.textContent?.trim() ?? "",
        said: document.querySelector(".n-macsay")?.textContent?.trim() ?? "",
      }));
      assert.equal(
        new URL(closeClick.url).searchParams.has("macro"),
        false,
        "the close click removes the macro query immediately: " + JSON.stringify(closeClick),
      );
      await closeSeen;
      assert.equal(await page.isVisible("#n-macro-dialog"), true, "the modal waits for close truth");
      assert.equal(
        await page.evaluate(() => document.querySelector("#n-macro-dialog")?.contains(document.activeElement)),
        true,
        "focus stays inside while the closing payload is outstanding",
      );
      releaseClose();
      await page.waitForFunction(
        () => document.activeElement?.matches("a.n-flow-processor") &&
          document.querySelector("#n-macro-dialog")?.closest(".nd-back")?.classList.contains("none"),
      );
      assert.equal(await page.isHidden("#n-macro-dialog"), true);
      assert.deepEqual(writes, [], "opening a read-only processor issues no mapping write");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseClose();
      await page.close();
    }
  });

  test("a macro processor can be pinned, moved accessibly, restored, and reloaded", async () => {
    const page = await openCanvas();
    try {
      const select = '[data-nx="mapping-paths"]';
      const shellSelector = '#n-mapping-processors .n-flow-processor-shell[data-flow-macro-id*="hadouken"]';
      const anchorSelector = `${shellSelector} > a.n-flow-processor`;
      const gripSelector = `${shellSelector} > .n-flow-processor-grip`;
      const autoSelector = `${shellSelector} > .n-flow-processor-auto`;
      const nudgeToggleSelector = `${shellSelector} > .n-flow-processor-nudge-toggle`;
      const nudgeSelector = `${shellSelector} > .n-flow-processor-nudges`;
      const triggerSelector = '#n-mapping-paths [data-flow-kind="macro-trigger"] .n-flow-core';
      const storageKey = "ksx-nocturne-canvas";
      const storedOffset = (processorId) => page.evaluate(({ storageKey, processorId }) => {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
        return saved.processorOffsets?.[processorId] ?? null;
      }, { storageKey, processorId });

      await page.selectOption(select, "selected");
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      const processorId = await page.locator(anchorSelector).getAttribute("data-flow-macro-id");
      assert.ok(processorId, "the macro keeps one stable persistence identity");
      const processorSlot = await page.locator(anchorSelector).getAttribute("data-flow-slot");
      assert.ok(processorSlot, "the movable processor keeps its player identity");
      assert.deepEqual(
        await page.locator(shellSelector).evaluate((shell) => ({
          placement: shell.dataset.flowPlacement,
          saveState: shell.dataset.flowSaveState,
          buttonInsideLink: shell.querySelector("a button") !== null,
          children: Array.from(shell.children).map((child) => child.tagName),
        })),
        {
          placement: "auto",
          saveState: "saved",
          buttonInsideLink: false,
          children: ["A", "BUTTON", "BUTTON", "BUTTON", "DIV"],
        },
        "move and Auto are sibling controls around the unchanged editor link",
      );
      assert.deepEqual(
        await page.locator(shellSelector).evaluate((shell) => {
          const grip = shell.querySelector(".n-flow-processor-grip");
          const auto = shell.querySelector(".n-flow-processor-auto");
          const nudge = shell.querySelector(".n-flow-processor-nudge-toggle");
          return {
            gripLabel: grip?.getAttribute("aria-label"),
            gripShortcuts: grip?.getAttribute("aria-keyshortcuts"),
            autoLabel: auto?.getAttribute("aria-label"),
            nudgeLabel: nudge?.getAttribute("aria-label"),
            nudgeControls: nudge?.getAttribute("aria-controls"),
          };
        }),
        {
          gripLabel:
            `Move hadouken for Player ${processorSlot}. Drag, or use Arrow keys; Shift plus Arrow moves farther. Moving pins the processor.`,
          gripShortcuts:
            "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Home Delete",
          autoLabel: `Return hadouken for Player ${processorSlot} to automatic placement`,
          nudgeLabel:
            `Show click or tap movement controls for hadouken, Player ${processorSlot}`,
          nudgeControls: await page.locator(nudgeSelector).getAttribute("id"),
        },
        "the sibling controls expose their complete move and reset contracts",
      );
      assert.equal(await page.locator(autoSelector).isHidden(), true);

      await page.locator(nudgeToggleSelector).click();
      assert.equal(await page.locator(nudgeToggleSelector).getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator(nudgeSelector).isVisible(), true,
        "a click or tap reveals movement controls without requiring a drag");
      const rightNudge = page.locator(`${nudgeSelector} [aria-label^="Move right"]`);
      await rightNudge.focus();
      await page.evaluate(() => {
        const select = document.querySelector('[data-nx="mapping-paths"]');
        if (!(select instanceof HTMLSelectElement)) throw new Error("missing path scope");
        select.value = "all";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(
        (nudgeSelector) =>
          document.querySelector('[data-nx="mapping-paths"]')?.value === "all" &&
          document.activeElement?.matches(`${nudgeSelector} [data-flow-nudge-direction="right"]`),
        nudgeSelector,
      );
      await page.evaluate(() => {
        const select = document.querySelector('[data-nx="mapping-paths"]');
        if (!(select instanceof HTMLSelectElement)) throw new Error("missing path scope");
        select.value = "selected";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(
        (nudgeSelector) =>
          document.querySelector('[data-nx="mapping-paths"]')?.value === "selected" &&
          document.activeElement?.matches(`${nudgeSelector} [data-flow-nudge-direction="right"]`),
        nudgeSelector,
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(nudgeSelector).isHidden(), true,
        "Escape closes the disclosed movement group");
      assert.equal(
        await page.locator(nudgeToggleSelector).evaluate((button) => document.activeElement === button),
        true,
        "Escape returns focus to the disclosure that opened the group",
      );
      await page.locator(nudgeToggleSelector).click();
      await rightNudge.click();
      await page.waitForFunction(
        ({ storageKey, processorId }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.x) && offset.x > 0;
        },
        { storageKey, processorId },
      );
      await page.locator(autoSelector).click();
      await page.waitForFunction(
        ({ storageKey, processorId }) =>
          JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId] === undefined,
        { storageKey, processorId },
      );

      const cameraBefore = await page.getAttribute(".forma-canvas-stage", "style");
      const routeBefore = await page.getAttribute(triggerSelector, "d");
      await page.locator(gripSelector).focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ shellSelector, storageKey, processorId }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return document.querySelector(shellSelector)?.dataset.flowPlacement === "manual" &&
            Number.isFinite(offset?.x) && Number.isFinite(offset?.y);
        },
        { shellSelector, storageKey, processorId },
      );
      const afterSmallNudge = await storedOffset(processorId);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ storageKey, processorId, before }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.x) && Number.isFinite(offset?.y) &&
            Math.abs(offset.x - before.x - 16) < 0.01 &&
            Math.abs(offset.y - before.y) < 0.01;
        },
        { storageKey, processorId, before: afterSmallNudge },
      );
      const afterRegularNudge = await storedOffset(processorId);
      await page.keyboard.press("Shift+ArrowDown");
      await page.waitForFunction(
        ({ storageKey, processorId, beforeY }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.y) && Math.abs(offset.y - beforeY - 64) < 0.01;
        },
        { storageKey, processorId, beforeY: afterRegularNudge.y },
      );
      const nudgedOffset = await storedOffset(processorId);
      assert.equal(afterRegularNudge.x - afterSmallNudge.x, 16);
      assert.equal(afterRegularNudge.y - afterSmallNudge.y, 0);
      assert.equal(nudgedOffset.x - afterRegularNudge.x, 0);
      assert.equal(nudgedOffset.y - afterRegularNudge.y, 64);
      assert.equal(await page.locator(autoSelector).isVisible(), true);
      assert.equal(
        await page.getAttribute(".forma-canvas-stage", "style"),
        cameraBefore,
        "processor arrows never move the canvas camera",
      );
      await page.waitForFunction(
        ({ triggerSelector, routeBefore }) =>
          document.querySelector(triggerSelector)?.getAttribute("d") !== routeBefore,
        { triggerSelector, routeBefore },
      );
      assert.equal(new URL(page.url()).searchParams.has("macro"), false, "Move never opens the editor");
      assert.equal((await page.textContent(".n-live-sr")).trim(), "hadouken moved and pinned.");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        ({ shellSelector, processorId, storageKey }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return document.querySelector(shellSelector)?.dataset.flowPlacement === "manual" &&
            Number.isFinite(offset?.x) && Number.isFinite(offset?.y);
        },
        { shellSelector, processorId, storageKey },
      );
      await settle(page);
      assert.deepEqual(await storedOffset(processorId), nudgedOffset, "manual offset survives hydration");
      const manualBeforeReset = await page.evaluate(
        ({ shellSelector, triggerSelector }) => {
          const shell = document.querySelector(shellSelector);
          const rect = shell?.getBoundingClientRect();
          return {
            center: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
            route: document.querySelector(triggerSelector)?.getAttribute("d") ?? "",
          };
        },
        { shellSelector, triggerSelector },
      );
      assert.ok(manualBeforeReset.center && manualBeforeReset.route, "the pinned card has rendered geometry");
      await page.locator(gripSelector).focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(
        ({ shellSelector, triggerSelector, storageKey, processorId, manualBeforeReset }) => {
          const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          const shell = document.querySelector(shellSelector);
          const rect = shell?.getBoundingClientRect();
          const centerMoved = rect && manualBeforeReset.center &&
            Math.hypot(
              rect.left + rect.width / 2 - manualBeforeReset.center.x,
              rect.top + rect.height / 2 - manualBeforeReset.center.y,
            ) > 1;
          const routeReset =
            document.querySelector(triggerSelector)?.getAttribute("d") !== manualBeforeReset.route;
          return shell?.dataset.flowPlacement === "auto" &&
            !saved.processorOffsets?.[processorId] && centerMoved && routeReset;
        },
        { shellSelector, triggerSelector, storageKey, processorId, manualBeforeReset },
      );
      assert.equal(await page.locator(autoSelector).isHidden(), true);
      assert.equal(await page.locator(gripSelector).evaluate((grip) => document.activeElement === grip), true);

      await page.click('[data-nx="canvas-zoom-in"]');
      await settle(page);
      assert.notEqual((await page.textContent(".n-zoomval")).trim(), "100%", "drag QA runs off 1× zoom");
      const dragBaseline = await page.evaluate(
        ({ shellSelector, gripSelector, triggerSelector }) => {
          const shell = document.querySelector(shellSelector);
          const grip = document.querySelector(gripSelector);
          const viewport = document.querySelector(".forma-canvas-viewport");
          if (!shell || !grip || !viewport) return null;
          const shellRect = shell.getBoundingClientRect();
          const gripRect = grip.getBoundingClientRect();
          const viewportRect = viewport.getBoundingClientRect();
          const visibleRects = (selector) =>
            [...document.querySelectorAll(selector)].filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width >= 2 && rect.height >= 2 &&
              style.display !== "none" && style.visibility !== "hidden";
            }).map((element) => element.getBoundingClientRect());
          const widgetObstacles = visibleRects(
            ".forma-canvas-stage .widget-instance:not([hidden])",
          );
          const navigatorObstacles = visibleRects(
            ".forma-canvas-navigator:not([hidden])",
          );
          const halfWidth = shellRect.width / 2;
          const halfHeight = shellRect.height / 2;
          const margin = 12;
          const center = {
            x: shellRect.left + halfWidth,
            y: shellRect.top + halfHeight,
          };
          // Ask for the nearest clear point rather than assuming one fixed
          // diagonal is open. The card planner may legitimately place Auto in
          // a narrow lane between real widgets; this scan keeps the assertion
          // exact while avoiding a false failure caused by its safety clamp.
          const candidates = [];
          for (let dx = -Math.ceil(viewportRect.width); dx <= viewportRect.width; dx += 16) {
            for (let dy = -Math.ceil(viewportRect.height); dy <= viewportRect.height; dy += 16) {
              if (Math.hypot(dx, dy) >= 48) candidates.push({ x: dx, y: dy });
            }
          }
          candidates.sort((left, right) =>
            Math.hypot(left.x, left.y) - Math.hypot(right.x, right.y) ||
            right.x - left.x || right.y - left.y
          );
          const insideAndClear = (candidate, obstacles) => {
            const x = center.x + candidate.x;
            const y = center.y + candidate.y;
            const inside =
              x - halfWidth >= viewportRect.left + margin &&
              x + halfWidth <= viewportRect.right - margin &&
              y - halfHeight >= viewportRect.top + margin &&
              y + halfHeight <= viewportRect.bottom - margin;
            const clear = obstacles.every((rect) =>
              x + halfWidth + margin <= rect.left ||
              x - halfWidth - margin >= rect.right ||
              y + halfHeight + margin <= rect.top ||
              y - halfHeight - margin >= rect.bottom
            );
            return inside && clear;
          };
          // Match the product's deliberate fallback tiers: protect widgets
          // and navigator when space exists, then keep the processor reachable
          // even when the visible widgets consume the whole viewport.
          const obstacleTiers = [
            [...widgetObstacles, ...navigatorObstacles],
            widgetObstacles,
            navigatorObstacles,
            [],
          ];
          const activeObstacles = obstacleTiers.find((obstacles) =>
            candidates.some((candidate) => insideAndClear(candidate, obstacles))
          ) ?? [];
          const requested = candidates.find((candidate) =>
            insideAndClear(candidate, activeObstacles)
          );
          return {
            center,
            grip: {
              x: gripRect.left + gripRect.width / 2,
              y: gripRect.top + gripRect.height / 2,
            },
            requested: requested ?? null,
            route: document.querySelector(triggerSelector)?.getAttribute("d") ?? "",
            camera: document.querySelector(".forma-canvas-stage")?.getAttribute("style") ?? "",
            activeWidget:
              document.querySelector(".forma-canvas-stage .widget-instance.is-active")
                ?.getAttribute("data-instance-id") ?? "",
          };
        },
        { shellSelector, gripSelector, triggerSelector },
      );
      assert.ok(dragBaseline?.requested, "the zoomed canvas offers one unclamped drag direction");
      assert.ok(dragBaseline.route, "the zoomed macro route has rendered before dragging");
      const requestedDrag = dragBaseline.requested;
      const gripHit = await page.evaluate(({ gripSelector, grip }) => {
        const expected = document.querySelector(gripSelector);
        const actual = document.elementFromPoint(grip.x, grip.y);
        return {
          reachesGrip: actual === expected || Boolean(expected?.contains(actual)),
          actual: actual instanceof HTMLElement
            ? `${actual.tagName}.${actual.className}`
            : actual?.nodeName ?? "none",
          viewport: document.querySelector(".forma-canvas-viewport")?.className ?? "",
        };
      }, { gripSelector, grip: dragBaseline.grip });
      assert.equal(gripHit.reachesGrip, true,
        `the visible Move control owns its hit point: ${JSON.stringify(gripHit)}`);
      await page.mouse.move(dragBaseline.grip.x, dragBaseline.grip.y);
      const afterMoveHit = await page.evaluate(({ gripSelector, grip }) => {
        const current = document.querySelector(gripSelector);
        const actual = document.elementFromPoint(grip.x, grip.y);
        return {
          reachesCurrent: actual === current || Boolean(current?.contains(actual)),
          actual: actual instanceof HTMLElement
            ? `${actual.tagName}.${actual.className}`
            : actual?.nodeName ?? "none",
        };
      }, { gripSelector, grip: dragBaseline.grip });
      assert.equal(afterMoveHit.reachesCurrent, true,
        `showing the trace never moves the canvas out from under Move: ${JSON.stringify(afterMoveHit)}`);
      await page.mouse.down();
      await page.mouse.move(dragBaseline.grip.x + requestedDrag.x, dragBaseline.grip.y + requestedDrag.y, {
        steps: 6,
      });
      await page.mouse.up();
      await page.waitForFunction(
        ({ shellSelector, storageKey, processorId }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return document.querySelector(shellSelector)?.dataset.flowPlacement === "manual" &&
            Number.isFinite(offset?.x) && Number.isFinite(offset?.y);
        },
        { shellSelector, storageKey, processorId },
      );
      await page.waitForFunction(
        ({ shellSelector, triggerSelector, dragBaseline, requestedDrag }) => {
          const shell = document.querySelector(shellSelector);
          const rect = shell?.getBoundingClientRect();
          if (!rect) return false;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return document.querySelector(triggerSelector)?.getAttribute("d") !== dragBaseline.route &&
            Math.abs(x - dragBaseline.center.x - requestedDrag.x) <= 2 &&
            Math.abs(y - dragBaseline.center.y - requestedDrag.y) <= 2;
        },
        { shellSelector, triggerSelector, dragBaseline, requestedDrag },
      );
      const dragResult = await page.locator(shellSelector).evaluate((shell) => {
        const rect = shell.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      assert.ok(
        Math.sign(dragResult.x - dragBaseline.center.x) === Math.sign(requestedDrag.x) &&
          Math.sign(dragResult.y - dragBaseline.center.y) === Math.sign(requestedDrag.y),
        "the zoomed processor follows the requested drag direction",
      );
      assert.equal(
        await page.getAttribute(".forma-canvas-stage", "style"),
        dragBaseline.camera,
        "dragging a processor never pans or zooms the canvas",
      );
      assert.equal(
        await page.evaluate(() =>
          document.querySelector(".forma-canvas-stage .widget-instance.is-active")
            ?.getAttribute("data-instance-id") ?? ""),
        dragBaseline.activeWidget,
        "dragging a processor never changes the active widget",
      );
      assert.equal(new URL(page.url()).searchParams.has("macro"), false, "dragging the sibling grip stays on canvas");

      await page.locator(autoSelector).click();
      await page.waitForFunction(
        ({ shellSelector, storageKey, processorId }) => {
          const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          return document.querySelector(shellSelector)?.dataset.flowPlacement === "auto" &&
            !saved.processorOffsets?.[processorId];
        },
        { shellSelector, storageKey, processorId },
      );
      assert.equal((await page.textContent(".n-live-sr")).trim(), "hadouken returned to automatic placement.");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("macro movement cancels stale gestures and reports a refused save truthfully", async () => {
    const page = await openCanvas();
    try {
      const select = '[data-nx="mapping-paths"]';
      const shellSelector =
        '#n-mapping-processors .n-flow-processor-shell[data-flow-macro-id*="hadouken"]';
      const anchorSelector = `${shellSelector} > a.n-flow-processor`;
      const gripSelector = `${shellSelector} > .n-flow-processor-grip`;
      const autoSelector = `${shellSelector} > .n-flow-processor-auto`;
      const storageKey = "ksx-nocturne-canvas";

      await page.selectOption(select, "selected");
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      const processorId = await page.locator(anchorSelector).getAttribute("data-flow-macro-id");
      assert.ok(processorId, "the cancellation test has a stable processor identity");
      const refuseCanvasStorage = () => page.evaluate((storageKey) => {
        const original = Storage.prototype.setItem;
        window.__ksxRestoreCanvasStorage = () => {
          Storage.prototype.setItem = original;
          delete window.__ksxRestoreCanvasStorage;
        };
        Storage.prototype.setItem = function setItem(key, value) {
          if (key === storageKey) throw new DOMException("storage refused", "QuotaExceededError");
          return original.call(this, key, value);
        };
      }, storageKey);

      const beginDrag = async () => {
        const box = await page.locator(gripSelector).boundingBox();
        assert.ok(box, "the macro move grip has browser geometry");
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 52, point.y + 34, { steps: 4 });
        await page.waitForFunction(
          ({ shellSelector }) =>
            document.querySelector(".forma-canvas-viewport")
              ?.classList.contains("is-dragging-flow-processor") === true &&
            document.querySelector(shellSelector)?.classList.contains("is-dragging") === true,
          { shellSelector },
        );
      };
      const assertCancelled = async (reason) => {
        await page.waitForFunction(
          ({ shellSelector, storageKey, processorId }) => {
            const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
            return document.querySelector(".forma-canvas-viewport")
              ?.classList.contains("is-dragging-flow-processor") === false &&
              document.querySelector(shellSelector)?.classList.contains("is-dragging") === false &&
              document.querySelector(shellSelector)?.dataset.flowPlacement === "auto" &&
              !saved.processorOffsets?.[processorId];
          },
          { shellSelector, storageKey, processorId },
        );
        assert.equal(
          await page.locator(shellSelector).getAttribute("data-flow-placement"),
          "auto",
          reason,
        );
      };

      await beginDrag();
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await assertCancelled("losing the window abandons the preview instead of pinning it");
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));

      const cameraBefore = await page.getAttribute(".forma-canvas-stage", "style");
      await beginDrag();
      await page.evaluate(() =>
        document.querySelector('[data-nx="canvas-zoom-in"]')?.click()
      );
      await page.waitForFunction(
        (cameraBefore) =>
          document.querySelector(".forma-canvas-stage")?.getAttribute("style") !== cameraBefore,
        cameraBefore,
      );
      await assertCancelled("a camera change abandons a drag whose captured matrix is stale");
      await page.mouse.up();
      await settle(page);

      await beginDrag();
      await page.setViewportSize({ width: 1500, height: 1000 });
      await assertCancelled("a viewport resize abandons a drag whose captured matrix is stale");
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));

      await refuseCanvasStorage();
      await page.locator(gripSelector).focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ shellSelector }) =>
          document.querySelector(shellSelector)?.dataset.flowPlacement === "manual" &&
          document.querySelector(shellSelector)?.dataset.flowSaveState === "session-only" &&
          document.querySelector(".n-live-sr")?.textContent
            ?.includes("moved for this session") === true,
        { shellSelector },
      );
      assert.equal(
        (await page.textContent(".n-live-sr")).trim(),
        "hadouken moved for this session, but its canvas position could not be saved.",
      );
      // An unchanged background session poll is infrastructure truth, not a
      // newer user-facing event. Force that payload through applyNocturne (the
      // harmless environment-detail suffix defeats the raw-body dedupe) and
      // prove it cannot erase the movement result from the shared live region.
      const sameSessionMarker = "same-session announcement regression";
      await page.route("**/api/nocturne*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        const payload = await response.json();
        payload.view.environment_detail =
          `${payload.view.environment_detail} [${sameSessionMarker}]`;
        await route.fulfill({ response, json: payload });
      });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(
        (marker) => document.querySelector("#n-environment-detail")?.textContent?.includes(marker),
        sameSessionMarker,
      );
      assert.equal(
        (await page.textContent(".n-live-sr")).trim(),
        "hadouken moved for this session, but its canvas position could not be saved.",
        "an unchanged stopped-session poll does not overwrite the user's latest action",
      );
      await page.unroute("**/api/nocturne*");
      assert.equal(
        await page.locator(shellSelector).evaluate((shell) =>
          getComputedStyle(shell, "::after").content.replaceAll('"', "")
        ),
        "Session only",
        "a sighted user can see that the manual placement is not durable",
      );
      assert.equal(
        await page.evaluate(
          ({ storageKey, processorId }) =>
            JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId] ?? null,
          { storageKey, processorId },
        ),
        null,
        "a refused save is never presented as persisted state",
      );
      await page.evaluate(() => window.__ksxRestoreCanvasStorage?.());

      // A later, unrelated successful preference write must not smuggle the
      // refused processor offset into storage. The session-only override does
      // survive rebuilding the route lens until this document is reloaded.
      await page.selectOption(select, "off");
      await page.selectOption(select, "selected");
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      assert.equal(
        await page.locator(shellSelector).getAttribute("data-flow-placement"),
        "manual",
        "the refused position remains useful for this document",
      );
      assert.equal(
        await page.locator(shellSelector).getAttribute("data-flow-save-state"),
        "session-only",
        "the session-only warning survives rebuilding the route lens",
      );
      assert.equal(
        await page.evaluate(
          ({ storageKey, processorId }) =>
            JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId] ?? null,
          { storageKey, processorId },
        ),
        null,
        "later preference saves do not accidentally persist a refused position",
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      await settle(page);
      assert.equal(
        await page.locator(shellSelector).getAttribute("data-flow-placement"),
        "auto",
        "the session-only move does not reappear after hydration",
      );

      await page.locator(gripSelector).focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ storageKey, processorId, shellSelector }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.x) && Number.isFinite(offset?.y) &&
            document.querySelector(shellSelector)?.dataset.flowSaveState === "saved";
        },
        { storageKey, processorId, shellSelector },
      );
      const persistedOffset = await page.evaluate(
        ({ storageKey, processorId }) =>
          JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets[processorId],
        { storageKey, processorId },
      );
      await refuseCanvasStorage();
      await page.locator(autoSelector).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        ({ shellSelector }) =>
          document.querySelector(shellSelector)?.dataset.flowPlacement === "auto" &&
          document.querySelector(shellSelector)?.dataset.flowSaveState === "retry-reset",
        { shellSelector },
      );
      assert.equal(await page.locator(autoSelector).isVisible(), true);
      assert.equal((await page.locator(autoSelector).textContent()).trim(), "Retry Auto");
      assert.equal(
        await page.locator(autoSelector).evaluate((button) => document.activeElement === button),
        true,
        "a failed keyboard-accessible reset keeps focus on its visible retry action",
      );
      assert.equal(
        (await page.textContent(".n-live-sr")).trim(),
        "hadouken returned to automatic placement for this session, but that reset could not be saved.",
      );
      assert.deepEqual(
        await page.evaluate(
          ({ storageKey, processorId }) =>
            JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets[processorId],
          { storageKey, processorId },
        ),
        persistedOffset,
        "a refused Auto reset leaves the last durable offset intact",
      );
      await page.evaluate(() => window.__ksxRestoreCanvasStorage?.());
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        ({ storageKey, processorId, autoSelector }) =>
          document.querySelector(autoSelector)?.hidden === true &&
          !JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId],
        { storageKey, processorId, autoSelector },
      );
      assert.equal(
        await page.locator(gripSelector).evaluate((grip) => document.activeElement === grip),
        true,
        "a successful retry returns focus to Move when Auto disappears",
      );
      assert.equal(
        (await page.textContent(".n-live-sr")).trim(),
        "hadouken returned to automatic placement.",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a clamped macro saves its visible position and moves inward immediately", async () => {
    const page = await openCanvas();
    try {
      const select = '[data-nx="mapping-paths"]';
      const shellSelector =
        '#n-mapping-processors .n-flow-processor-shell[data-flow-macro-id*="hadouken"]';
      const anchorSelector = `${shellSelector} > a.n-flow-processor`;
      const gripSelector = `${shellSelector} > .n-flow-processor-grip`;
      const autoSelector = `${shellSelector} > .n-flow-processor-auto`;
      const storageKey = "ksx-nocturne-canvas";

      await page.setViewportSize({ width: 2400, height: 1000 });
      await settle(page);
      await page.selectOption(select, "selected");
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      const processorId = await page.locator(anchorSelector).getAttribute("data-flow-macro-id");
      assert.ok(processorId, "the clamp test has a stable processor identity");
      const snapshot = () => page.evaluate(
        ({ shellSelector, storageKey, processorId }) => {
          const shell = document.querySelector(shellSelector);
          const rect = shell?.getBoundingClientRect();
          const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
          const matrix = document.querySelector("#n-mapping-paths")?.getScreenCTM();
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          if (!rect || !viewport || !matrix || !Number.isFinite(offset?.x) || !Number.isFinite(offset?.y)) {
            return null;
          }
          return {
            center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
            offset: { x: offset.x, y: offset.y },
            scale: Math.hypot(matrix.a, matrix.b),
            rightGap: viewport.right - rect.right,
            bottomGap: viewport.bottom - rect.bottom,
          };
        },
        { shellSelector, storageKey, processorId },
      );

      await page.locator(gripSelector).focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ storageKey, processorId }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.x) && Number.isFinite(offset?.y);
        },
        { storageKey, processorId },
      );
      const first = await snapshot();
      assert.ok(first, "the first manual placement is measurable");

      const gripBox = await page.locator(gripSelector).boundingBox();
      const viewportSize = page.viewportSize();
      assert.ok(gripBox && viewportSize, "the clamp drag has browser geometry");
      const gripPoint = {
        x: gripBox.x + gripBox.width / 2,
        y: gripBox.y + gripBox.height / 2,
      };
      await page.mouse.move(gripPoint.x, gripPoint.y);
      await page.mouse.down();
      await page.mouse.move(gripPoint.x, viewportSize.height - 2, { steps: 8 });
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));
      const clamped = await snapshot();
      assert.ok(clamped, "the clamped placement remains measurable");
      assert.ok(
        Math.abs(clamped.bottomGap - 12) <= 1,
        `the saturated card is clamped at the reachable bottom-edge margin: ${JSON.stringify(clamped)}`,
      );
      assert.ok(
        Math.abs(
          (clamped.offset.x - first.offset.x) * clamped.scale -
            (clamped.center.x - first.center.x),
        ) <= 2.5 &&
          Math.abs(
            (clamped.offset.y - first.offset.y) * clamped.scale -
              (clamped.center.y - first.center.y),
          ) <= 2.5,
        "the persisted world offset describes the card the user can actually see",
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(anchorSelector).waitFor({ state: "visible" });
      await settle(page);
      const reloaded = await snapshot();
      assert.ok(reloaded, "the clamped placement survives hydration");
      assert.deepEqual(reloaded.offset, clamped.offset, "hydration keeps the effective offset");
      assert.ok(
        Math.abs(reloaded.bottomGap - 12) <= 1,
        "hydration keeps the clamped card reachable after recomputing Auto placement",
      );

      await page.locator(gripSelector).focus();
      await page.keyboard.press("ArrowUp");
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));
      const inward = await snapshot();
      assert.ok(inward, "the inward nudge remains measurable");
      const inwardScreenDelta = {
        x: inward.center.x - reloaded.center.x,
        y: inward.center.y - reloaded.center.y,
      };
      const inwardWorldDelta = {
        x: inward.offset.x - reloaded.offset.x,
        y: inward.offset.y - reloaded.offset.y,
      };
      assert.ok(
        Math.hypot(inwardScreenDelta.x, inwardScreenDelta.y) > 1 &&
          Math.abs(inwardWorldDelta.x * inward.scale - inwardScreenDelta.x) <= 2.5 &&
          Math.abs(inwardWorldDelta.y * inward.scale - inwardScreenDelta.y) <= 2.5,
        "the first inward nudge moves the visible card instead of catching up with a hidden offset",
      );
      await page.locator(autoSelector).click();
      await page.waitForFunction(
        ({ storageKey, processorId }) =>
          !JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId],
        { storageKey, processorId },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a processor nudge disclosure stays usable at the right viewport edge", async () => {
    const page = await openCanvas();
    try {
      const shellSelector =
        '#n-mapping-processors .n-flow-processor-shell[data-flow-macro-id*="hadouken"]';
      const gripSelector = `${shellSelector} > .n-flow-processor-grip`;
      const toggleSelector = `${shellSelector} > .n-flow-processor-nudge-toggle`;
      const menuSelector = `${shellSelector} > .n-flow-processor-nudges`;
      const storageKey = "ksx-nocturne-canvas";

      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      await page.locator(gripSelector).waitFor({ state: "visible" });
      const processorId = await page.locator(shellSelector).getAttribute("data-flow-macro-id");
      const grip = await page.locator(gripSelector).boundingBox();
      const browserViewport = page.viewportSize();
      assert.ok(processorId && grip && browserViewport, "the edge disclosure has browser geometry");

      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(browserViewport.width - 2, grip.y + grip.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ));
      await page.locator(toggleSelector).click();

      const disclosure = await page.evaluate(({ shellSelector, menuSelector }) => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const shell = document.querySelector(shellSelector)?.getBoundingClientRect();
        const menu = document.querySelector(menuSelector);
        const menuRect = menu?.getBoundingClientRect();
        if (!viewport || !shell || !menu || !menuRect) return null;
        return {
          viewport: { left: viewport.left, right: viewport.right },
          shell: { left: shell.left, right: shell.right },
          menu: { left: menuRect.left, right: menuRect.right },
          side: menu.getAttribute("data-flow-nudge-side"),
          buttons: Array.from(menu.querySelectorAll("button")).map((button) => {
            const rect = button.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          }),
        };
      }, { shellSelector, menuSelector });
      assert.ok(disclosure, "the disclosed movement group is measurable");
      assert.ok(
        disclosure.shell.right > disclosure.viewport.right - 14,
        `the processor reached the right-edge clamp: ${JSON.stringify(disclosure)}`,
      );
      assert.equal(disclosure.side, "left", "the movement group flips to the available side");
      assert.ok(
        disclosure.menu.left >= disclosure.viewport.left + 7 &&
          disclosure.menu.right <= disclosure.viewport.right - 7 &&
          disclosure.buttons.every((button) =>
            button.left >= disclosure.viewport.left && button.right <= disclosure.viewport.right
          ),
        `every nudge target remains inside the clipped canvas viewport: ${JSON.stringify(disclosure)}`,
      );

      const before = await page.evaluate(({ storageKey, processorId }) =>
        JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId],
      { storageKey, processorId });
      await page.locator(`${menuSelector} [data-flow-nudge-direction="left"]`).click();
      await page.waitForFunction(
        ({ storageKey, processorId, beforeX }) => {
          const offset = JSON.parse(localStorage.getItem(storageKey) ?? "{}")
            .processorOffsets?.[processorId];
          return Number.isFinite(offset?.x) && offset.x < beforeX;
        },
        { storageKey, processorId, beforeX: before.x },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a processor removed before its confirming read settles without a dead dialog URL", async () => {
    let removed = false;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch();
        if (response.status() !== 200 || url.searchParams.get("macro") !== "hadouken") {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        for (const pad of payload.view?.pads ?? []) {
          pad.macros = (pad.macros ?? []).filter((macro) => macro.name !== "hadouken");
        }
        payload.view.mac.back_cls = "nd-back none";
        removed = true;
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Ultimarc I-PAC 4");
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const node = page.locator('#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="hadouken"]');
      await node.waitFor({ state: "visible" });
      await node.hover();
      assert.equal(await page.locator("#n-mapping-processors").evaluate((layer) =>
        layer.classList.contains("is-inspecting")), true);
      await node.click();
      await page.waitForFunction(
        () =>
          !new URL(location.href).searchParams.has("macro") &&
          /no longer available/i.test(document.querySelector(".n-live-sr")?.textContent ?? ""),
      );
      assert.equal(removed, true);
      assert.equal(await page.isHidden("#n-macro-dialog"), true);
      assert.equal(
        await page.locator("#n-mapping-processors").evaluate((layer) =>
          layer.classList.contains("is-inspecting")),
        false,
        "removing the inspected macro cannot leave the surviving graph dimmed",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches('[data-nx="mapping-paths"]')),
        true,
        "focus falls back to the path control when the processor itself no longer exists",
      );
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() =>
        document.querySelector('#n-mapping-processors a[data-flow-macro-id*="hadouken"]') !== null &&
        document.activeElement?.matches('[data-nx="mapping-paths"]'));
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("an open processor removed by a later poll closes truthfully and restores focus", async () => {
    let removeOnPoll = false;
    let markRemoved = () => {};
    const removed = new Promise((resolve) => {
      markRemoved = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (!removeOnPoll || response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        for (const pad of payload.view?.pads ?? []) {
          pad.macros = (pad.macros ?? []).filter((macro) => macro.name !== "hadouken");
        }
        payload.view.mac.back_cls = "nd-back none";
        removeOnPoll = false;
        markRemoved();
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const node = page.locator('#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="hadouken"]');
      await node.click();
      await page.locator("#n-macro-dialog").waitFor({ state: "visible" });
      removeOnPoll = true;
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await removed;
      await page.waitForFunction(
        () =>
          !new URL(location.href).searchParams.has("macro") &&
          document.querySelector("#n-macro-dialog")?.closest(".nd-back")?.classList.contains("none") &&
          /no longer available/i.test(document.querySelector(".n-live-sr")?.textContent ?? ""),
        null,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches('[data-nx="mapping-paths"]')),
        true,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Rescan freshness survives either ordering with a mutation refresh", async () => {
    let armed = null;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const url = new URL(route.request().url());
        const requestFresh = url.searchParams.get("fresh") === "1";
        const gate = armed;
        if (gate && requestFresh === gate.blockFresh && !gate.blocked) {
          gate.blocked = true;
          gate.markBlocked();
          await gate.release;
          await route.continue().catch(() => {});
          return;
        }
        if (gate?.blocked && requestFresh) gate.markSuccessor(url.href);
        await route.continue();
      });
    });
    const arm = (blockFresh) => {
      let markBlocked = () => {};
      let releaseGate = () => {};
      let markSuccessor = () => {};
      const blocked = new Promise((resolve) => {
        markBlocked = resolve;
      });
      const release = new Promise((resolve) => {
        releaseGate = resolve;
      });
      const successor = new Promise((resolve) => {
        markSuccessor = resolve;
      });
      armed = {
        blockFresh,
        blocked: false,
        markBlocked,
        release,
        releaseGate,
        markSuccessor,
        successor,
      };
      return armed;
    };
    const within = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 5_000)),
    ]);
    try {
      const firstSlot = page.locator("a.n-slot-sel").first();
      const selected = page.waitForResponse((response) =>
        response.url().includes("/api/nocturne?slot=1") && response.status() === 200);
      await firstSlot.click();
      await selected;
      await page.waitForURL(/\/nocturne\?slot=1$/);

      const mutationFirst = arm(false);
      await page.locator("a.n-slot-sel").first().click();
      await within(mutationFirst.blocked, "the mutation refresh never started");
      await page.locator('form:has(input[name="fresh"]) button[type="submit"]').click();
      const mutationThenFresh = await within(
        mutationFirst.successor,
        "Rescan was lost behind an active mutation refresh",
      );
      assert.equal(new URL(mutationThenFresh).searchParams.get("fresh"), "1");
      mutationFirst.releaseGate();
      armed = null;

      const freshFirst = arm(true);
      await page.locator('form:has(input[name="fresh"]) button[type="submit"]').click();
      await within(freshFirst.blocked, "the fresh refresh never started");
      await page.locator("a.n-slot-sel").first().click();
      const freshThenMutation = await within(
        freshFirst.successor,
        "the mutation superseded Rescan without carrying fresh=1",
      );
      assert.equal(new URL(freshThenMutation).searchParams.get("fresh"), "1");
      freshFirst.releaseGate();
      armed = null;
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      armed?.releaseGate();
      await page.close();
    }
  });

  test("an unrelated topology refresh preserves focus on an unchanged processor", async () => {
    let changeNext = false;
    let markChanged = () => {};
    const changed = new Promise((resolve) => {
      markChanged = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (!changeNext || response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        const pad = payload.view?.pads?.[0];
        if (pad) setPadControlKeys(pad, "a", ["F13"]);
        changeNext = false;
        markChanged();
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const node = page.locator('#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="hadouken"]');
      await node.waitFor({ state: "visible" });
      await node.focus();
      const macroId = await node.getAttribute("data-flow-macro-id");
      changeNext = true;
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await changed;
      await page.waitForFunction(
        (expected) =>
          document.querySelector(
            '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="F13"][data-flow-fn="a"]',
          ) !== null &&
          document.activeElement?.getAttribute("data-flow-macro-id") === expected,
        macroId,
        { timeout: 10_000 },
      );
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("unavailable mapper truth never draws stale direct cords and stays discoverable", async () => {
    let servedUnavailable = false;
    let bindRequests = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/nocturne/api/bind", async (route) => {
        bindRequests += 1;
        await route.abort();
      });
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        for (const pad of payload.view?.pads ?? []) {
          pad.mapping_available = false;
          pad.mapping_reason = "Fixture direct read failed.";
          pad.controls = [];
          // Deliberately stale and non-empty: availability must win.
          pad.fn_keys = { A: "G" };
        }
        servedUnavailable = true;
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      await page.waitForFunction(
        () => document.querySelector("#n-mapping-paths")?.dataset.flowMappingUnavailable === "1",
        null,
        { timeout: 10_000 },
      );
      assert.equal(servedUnavailable, true);
      assert.equal(
        await page.locator('#n-mapping-paths [data-flow-kind="binding"]').count(),
        0,
        "stale fn_keys do not override an unavailable mapper read",
      );
      assert.equal(
        await page.locator('#n-mapping-paths [data-flow-kind^="macro-"]').count(),
        4,
        "independently available macro topology remains visible",
      );
      assert.match(await page.textContent(".n-pathcount"), /partial/);
      assert.equal(
        await page.getAttribute('[data-nx="mapping-paths"]', "aria-describedby"),
        "n-mapping-path-status",
      );
      assert.match(
        await page.textContent("#n-mapping-path-status"),
        /direct mapping information is unavailable.*Fixture direct read failed/i,
      );
      await page.click('[data-nx="auto-map"]');
      await page.waitForFunction(() =>
        /No controls to map/i.test(document.querySelector(".n-flash")?.textContent ?? "")
      );
      assert.equal(
        await page.locator(".n-learnbar.listen").count(),
        0,
        "an unavailable mapper never opens canvas authoring",
      );
      const control = page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first();
      await control.click({ force: true });
      assert.equal(
        await page.locator(".n-learnbar.listen").count(),
        0,
        "an unavailable controller endpoint cannot arm key listening",
      );
      const macroSignal = page.locator('.n-widget-kb [data-key="P"]:visible');
      assert.equal(await macroSignal.count(), 1,
        "the independently available macro trigger remains a discoverable source signal");
      // ⚠️ TWO ASSERTIONS REMOVED HERE, 2026-08-26, because their subject went
      // with the encoder chart (`3901990`).
      //
      // The source widget used to draw a DERIVED list when an I-PAC was
      // selected — one `.n-ipac-signal` cap per terminal the chart proved, with
      // an `.n-ipac-signal-source` paragraph saying "ksx has not read the I-PAC
      // hardware-output chart yet… has not proven which physical terminals emit
      // them". The two removed assertions pinned that derivation: that exactly
      // ONE cap existed (the macro's routed key, and nothing inferred from a
      // failed direct read), and that the paragraph told those two things
      // apart. Nothing adds the `n-ipac-signal` class any more — the client
      // only ever filters ON it — so the widget draws the same full board for
      // every device and there is no derived list to be wrong about.
      //
      // What is still asserted is the part that survived and is the reason
      // this test exists: an unavailable mapper read draws no cords, keeps the
      // independently-available macro topology, refuses to arm authoring, and
      // cannot be talked into a write.
      await macroSignal.click();
      await control.click({ force: true });
      assert.equal(bindRequests, 0, "an unavailable controller endpoint cannot write a binding");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("partial-axis authoring keeps its raw truth while landing on the visible direction", async () => {
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        const pad = payload.view?.pads?.[0];
        if (pad) {
          pad.fn_keys["ly.-16384"] = "Q";
          pad.fn_keys["ly.+16384"] = "R";
          pad.fn_keys["ly.0"] = "T";
          pad.fn_keys["ly.999999"] = "U";
          const macro = pad.macros?.[0];
          if (
            macro &&
            !macro.outputs.some((output) => output.function === "ly.-16384")
          ) {
            macro.outputs.push({ function: "ly.-16384", steps: [4] });
            macro.timeline.push("LS ↓ at half deflection");
          }
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const direct =
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-fn="ly.-16384"]';
      const output =
        '#n-mapping-paths [data-flow-kind="macro-output"][data-flow-fn="ly.-16384"]';
      const positive =
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-fn="ly.+16384"]';
      const zero = '#n-mapping-paths [data-flow-kind="binding"][data-flow-fn="ly.0"]';
      const outOfRange =
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-fn="ly.999999"]';
      await page.waitForFunction(
        ({ direct, output, positive, zero, outOfRange }) =>
          document.querySelector(direct) !== null &&
          document.querySelector(output) !== null &&
          document.querySelector(positive) !== null &&
          document.querySelector(zero) !== null &&
          document.querySelector(outOfRange) !== null,
        { direct, output, positive, zero, outOfRange },
      );
      assert.equal(
        await page.locator(direct).evaluate((edge) => edge.classList.contains("is-unresolved")),
        false,
        "the partial direct binding lands on the down-direction hook",
      );
      assert.equal(
        await page.locator(output).evaluate((edge) => edge.classList.contains("is-unresolved")),
        false,
        "the partial macro output lands on that same hook",
      );
      assert.equal(await page.getAttribute(direct, "data-flow-fn"), "ly.-16384");
      assert.equal(await page.getAttribute(output, "data-flow-fn"), "ly.-16384");
      assert.equal(
        await page.locator(positive).evaluate((edge) => edge.classList.contains("is-unresolved")),
        false,
        "an explicitly signed positive i16 value lands on the up-direction hook",
      );
      assert.equal(
        await page.locator(zero).evaluate((edge) => edge.classList.contains("is-unresolved")),
        true,
        "zero has no directional hook",
      );
      assert.equal(
        await page.locator(outOfRange).evaluate((edge) => edge.classList.contains("is-unresolved")),
        true,
        "values outside Rust's i16 grammar never masquerade as a direction",
      );

      await page.locator(
        '[data-instance-id="pad-1"] svg [data-fn="ly.min"]:not(text)',
      ).first().hover({ force: true });
      await page.waitForFunction(
        ({ direct, output }) =>
          document.querySelector(direct)?.classList.contains("is-related") &&
          document.querySelector(output)?.classList.contains("is-related"),
        { direct, output },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("an invalid zero-step macro is never described as a neutral step", async () => {
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        const pad = payload.view?.pads?.[0];
        const seed = pad?.macros?.[0];
        if (pad && seed) {
          pad.macros.push({
            ...JSON.parse(JSON.stringify(seed)),
            name: "empty-sequence",
            timeline: [],
            meta: "0 steps",
            edit_href: "/nocturne?slot=1&macro=empty-sequence",
          });
          pad.macros.push({
            ...JSON.parse(JSON.stringify(seed)),
            name: "neutral-sequence",
            timeline: ["Neutral"],
            meta: "1 step",
            edit_href: "/nocturne?slot=1&macro=neutral-sequence",
          });
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const empty = page.locator('#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="empty-sequence"]');
      const neutral = page.locator('#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="neutral-sequence"]');
      await empty.waitFor({ state: "visible" });
      assert.match(await empty.getAttribute("title"), /Invalid macro.*Timeline: no steps/i);
      assert.match(await empty.textContent(), /NO STEPS.*no steps/is);
      assert.doesNotMatch(await empty.textContent(), /neutral only/i);
      assert.match(await neutral.getAttribute("title"), /Timeline: Neutral/i);
      assert.doesNotMatch(await neutral.getAttribute("title"), /Invalid macro/i);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("real live frames animate only correlated direct routes and fail closed after a drop", async () => {
    const livePort = Number(process.env.KSX_PWTEST_CANVAS_LIVE_PORT ?? PORT + 17);
    const liveBase = "http://127.0.0.1:" + livePort;
    let liveServer;
    let page;
    let releaseStructure = () => {};
    const structureGate = new Promise((resolve) => {
      releaseStructure = resolve;
    });
    try {
      const squatter = await fetch(liveBase + "/api/nocturne").then(
        () => true,
        () => false,
      );
      assert.equal(squatter, false, "the live-fixture port must be free");
      liveServer = spawn(fixtureExe, [String(livePort)], {
        cwd: repoRoot,
        stdio: "ignore",
        env: {
          ...process.env,
          KSX_FIXTURE_SESSION: "running",
          KSX_FIXTURE_LIVE: "1",
        },
      });
      await waitForServer(liveBase);

      page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        colorScheme: "dark",
      });
      const noise = [];
      page.on("pageerror", (error) => noise.push("pageerror: " + (error.stack ?? error)));
      page.on("console", (message) => {
        if (message.type() === "error") noise.push("console: " + message.text());
      });
      // Hold the ordinary structure refresh across the scripted stop/start
      // boundary. That makes the security contract observable: frames alone
      // cannot re-license a possibly different session.
      await page.route("**/api/nocturne*", async (route) => {
        await structureGate;
        await route.continue().catch(() => {});
      });
      await page.goto(liveBase + "/nocturne", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
            undefined,
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      await page.selectOption('[data-nx="mapping-paths"]', "all");
      await page.waitForFunction(
        () => document.querySelectorAll("#n-mapping-paths .n-flow-edge").length === 36,
      );

      await page.evaluate(() => {
        const samples = [];
        const live = (selector) => document.querySelector(selector)?.classList.contains("is-live") ?? false;
        const liveAtEnd = (selector) => {
          const order = Array.from(document.querySelectorAll(selector));
          const liveEntries = order.filter((entry) => entry.classList.contains("is-live"));
          return liveEntries.length > 0 && liveEntries.every((entry) =>
            order.indexOf(entry) >= order.length - liveEntries.length
          );
        };
        const sample = () => {
          const gA = live(
            '#n-mapping-paths [data-flow-slot="1"][data-flow-kind="binding"][data-flow-key="G"][data-flow-fn="a"]',
          );
          const gB = live(
            '#n-mapping-paths [data-flow-slot="1"][data-flow-kind="binding"][data-flow-key="G"][data-flow-fn="b"]',
          );
          if (gA && gB && !window.__ksxInspectionPaintAudit) {
            const otherKey = document.querySelector(
              '[data-instance-id="keyboard"] [data-key="J"]',
            );
            if (otherKey) {
              otherKey.dispatchEvent(new PointerEvent("pointerover", {
                bubbles: true,
                relatedTarget: null,
              }));
              const during = {
                lines: liveAtEnd("#n-mapping-paths .n-flow-edge"),
                ports: liveAtEnd("#n-mapping-ports .n-flow-edge"),
              };
              otherKey.dispatchEvent(new PointerEvent("pointerout", {
                bubbles: true,
                relatedTarget: document.body,
              }));
              window.__ksxInspectionPaintAudit = {
                during,
                after: {
                  lines: liveAtEnd("#n-mapping-paths .n-flow-edge"),
                  ports: liveAtEnd("#n-mapping-ports .n-flow-edge"),
                },
              };
            }
          }
          const padA = Array.from(
            document.querySelectorAll('[data-pad-slot="1"] [data-fn].live'),
          ).some((element) =>
            (element.getAttribute("data-fn") ?? "")
              .split(/\s+/)
              .some((fnName) => fnName.toLowerCase() === "a"),
          );
          samples.push({
            gA,
            gB,
            jX: live(
              '#n-mapping-paths [data-flow-slot="1"][data-flow-kind="binding"][data-flow-key="J"][data-flow-fn="x"]',
            ),
            padA,
            dropped: /frames dropped/.test(
              document.querySelector(".n-livestats")?.textContent ?? "",
            ),
            inactive: /inactive/i.test(
              document.querySelector(".n-live-sr")?.textContent ?? "",
            ),
            macroLive:
              document.querySelectorAll(
                '#n-mapping-paths [data-flow-kind^="macro-"].is-live',
              ).length,
            playerTwoLive:
              document.querySelectorAll(
                '#n-mapping-paths [data-flow-slot="2"].is-live',
              ).length,
            liveOnTop:
              liveAtEnd("#n-mapping-paths .n-flow-edge") &&
              liveAtEnd("#n-mapping-ports .n-flow-edge"),
          });
          if (samples.length > 600) samples.shift();
        };
        window.__ksxLiveFlowSamples = samples;
        window.__ksxLiveFlowTimer = setInterval(sample, 20);
        sample();
      });

      await page.waitForFunction(
        () => window.__ksxLiveFlowSamples?.some((sample) => sample.gA && sample.gB),
        null,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => {
          const samples = window.__ksxLiveFlowSamples ?? [];
          const liveIndex = samples.findIndex((sample) => sample.gA && sample.gB);
          return liveIndex >= 0 && samples
            .slice(liveIndex + 1)
            .some((sample) => sample.dropped && sample.padA && !sample.gA && !sample.gB);
        },
        null,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => window.__ksxLiveFlowSamples?.some((sample) => sample.jX),
        null,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        () => window.__ksxLiveFlowSamples?.some((sample) => sample.inactive),
        null,
        { timeout: 10_000 },
      );
      await page.waitForTimeout(700);
      const boundaryAudit = await page.evaluate(() => {
        const samples = window.__ksxLiveFlowSamples ?? [];
        const stopped = samples.findIndex((sample) => sample.inactive);
        return {
          stopped,
          litBeforeStructure: samples
            .slice(stopped + 1)
            .some((sample) => sample.gA || sample.gB || sample.jX),
        };
      });
      assert.ok(boundaryAudit.stopped >= 0, "the scripted stop reached the browser");
      assert.equal(
        boundaryAudit.litBeforeStructure,
        false,
        "a later running frame cannot borrow the stopped session's old license",
      );
      releaseStructure();
      await page.waitForFunction(
        () => {
          const samples = window.__ksxLiveFlowSamples ?? [];
          const stopped = samples.findIndex((sample) => sample.inactive);
          return stopped >= 0 && samples.slice(stopped + 1).some((sample) => sample.gA && sample.gB);
        },
        null,
        { timeout: 10_000 },
      );
      const audit = await page.evaluate(() => {
        clearInterval(window.__ksxLiveFlowTimer);
        const samples = window.__ksxLiveFlowSamples ?? [];
        const gLive = samples.findIndex((sample) => sample.gA && sample.gB);
        const failClosed = samples.findIndex(
          (sample, index) =>
            index > gLive && sample.dropped && sample.padA && !sample.gA && !sample.gB,
        );
        return {
          gLive,
          failClosed,
          sameFrameTap: samples.some((sample) => sample.jX),
          liveAlwaysPromoted: samples.filter((sample) => sample.gA && sample.gB)
            .every((sample) => sample.liveOnTop),
          inspectionPaint: window.__ksxInspectionPaintAudit ?? null,
          macroEverLive: samples.some((sample) => sample.macroLive > 0),
          playerTwoEverLive: samples.some((sample) => sample.playerTwoLive > 0),
        };
      });
      assert.ok(audit.gLive >= 0, "G travels to both controls it directly drives");
      assert.equal(audit.liveAlwaysPromoted, true, "live cords paint above resting cord halos");
      assert.deepEqual(
        audit.inspectionPaint,
        {
          during: { lines: true, ports: true },
          after: { lines: true, ports: true },
        },
        "hovering and leaving another binding cannot paint it over a held cable",
      );
      assert.ok(
        audit.failClosed > audit.gLive,
        "a dropped release clears G's cords even while virtual A remains down",
      );
      assert.equal(audit.sameFrameTap, true, "J down+up in one frame still travels to X");
      assert.equal(
        audit.macroEverLive,
        false,
        "aggregate control frames never pretend to reveal macro-internal provenance",
      );
      assert.equal(
        audit.playerTwoEverLive,
        false,
        "Player 1 frames cannot animate Player 2's identically bound routes",
      );
      assert.deepEqual(noise, []);
    } finally {
      releaseStructure();
      if (page) {
        await page.evaluate(() => clearInterval(window.__ksxLiveFlowTimer)).catch(() => {});
        await page.close();
      }
      await stopFixtureProcess(liveServer, "canvas live fixture");
    }
  });

  test("processor cards remain reachable beside the compact mobile navigator", async () => {
    const page = await openCanvas({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    }, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        const pad = payload.view?.pads?.[0];
        const seed = pad?.macros?.[0];
        if (pad && seed && !pad.macros.some((macro) => macro.name === "dragon-punch")) {
          pad.macros.push({
            ...JSON.parse(JSON.stringify(seed)),
            name: "dragon-punch",
            triggers: ["O"],
            timeline: ["→", "D-pad ↓ + Y"],
            edit_href: "/nocturne?slot=1&macro=dragon-punch",
          });
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const nodes = page.locator("#n-mapping-processors a.n-flow-processor");
      await page.waitForFunction(
        () => document.querySelectorAll("#n-mapping-processors a.n-flow-processor").length === 2,
      );
      const node = nodes.first();
      await node.waitFor({ state: "visible" });
      await page.locator(".n-canvas").scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => {
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const processors = Array.from(
          document.querySelectorAll("#n-mapping-processors a.n-flow-processor"),
        );
        const boxes = processors.map((processor) => processor.getBoundingClientRect());
        const map = document.querySelector(".forma-canvas-navigator").getBoundingClientRect();
        const overlap = (left, right) =>
          left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top;
        return {
          allInside: boxes.every((box) =>
            box.left >= viewport.left - 1 && box.right <= viewport.right + 1 &&
            box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1),
          allReachable: boxes.every((box, index) =>
            document
              .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
              ?.closest("a.n-flow-processor") === processors[index]),
          hits: boxes.map((box) => {
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return {
              macro: hit?.closest("a.n-flow-processor")?.getAttribute("data-flow-macro-id") ?? "",
              tag: hit?.tagName ?? "",
              cls: hit?.getAttribute("class") ?? "",
            };
          }),
          processorOverlap: boxes.some((box, index) =>
            boxes.slice(index + 1).some((other) => overlap(box, other))),
          mapOverlaps: boxes.filter((box) => overlap(box, map)).length,
          heights: boxes.map((box) => box.height),
          boxes: boxes.map(({ left, top, right, bottom, width, height }) => ({
            left,
            top,
            right,
            bottom,
            width,
            height,
          })),
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert.equal(geometry.allInside, true, "every fixed-size card stays wholly inside the canvas");
      assert.ok(
        geometry.heights.every((height) => height >= 40),
        "coarse targets are " + geometry.heights.join(", ") + "px high",
      );
      assert.equal(
        geometry.processorOverlap,
        false,
        "processor cards never cover one another: " + JSON.stringify(geometry),
      );
      assert.equal(
        geometry.allReachable,
        true,
        "every processor wins its center hit test: " + JSON.stringify(geometry),
      );
      assert.ok(geometry.mapOverlaps <= 1, "packing uses clear mobile space before the navigator");
      assert.ok(geometry.documentOverflow <= 1, `mobile page overflowed by ${geometry.documentOverflow}px`);

      await page.click(".n-mapclose");
      await page.locator(".n-mapshow").waitFor({ state: "visible" });
      await page.click(".n-mapshow");
      await page.locator(".n-navigator").waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const visible = (element) => Boolean(
          element && element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
        );
        let editable = Array.from(document.querySelectorAll(
          '#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="hadouken"]',
        )).find(visible);
        if (!editable) {
          const overflow = document.querySelector(
            "#n-mapping-processors details.n-flow-overflow:not([hidden])",
          );
          if (!visible(overflow)) return false;
          overflow.open = true;
          editable = overflow.querySelector(
            'a.n-flow-overflow-link[data-flow-macro-id*="hadouken"]',
          );
        }
        if (!visible(editable)) return false;
        // Responsive packing can move this macro between the direct card and
        // overflow bank on the next animation frame. Focus and activate the
        // representation which exists now in this one browser task.
        editable.focus();
        editable.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }));
        return true;
      });
      await page.locator("#n-macro-dialog").waitFor({ state: "visible" });
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a dense mobile macro graph folds into one reachable, scrollable bank", async () => {
    let addDirectRoute = false;
    let changeGroupedMeta = false;
    let markTopology = () => {};
    let markMetadata = () => {};
    const topologyChanged = new Promise((resolve) => {
      markTopology = resolve;
    });
    const metadataChanged = new Promise((resolve) => {
      markMetadata = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        const pad = payload.view?.pads?.[0];
        const seed = pad?.macros?.[0];
        if (pad && seed) {
          pad.macros = Array.from({ length: 12 }, (_, index) => {
            const name = index < 3
              ? `alpha-${String(index + 1).padStart(2, "0")}`
              : index === 3
                ? "hadouken"
                : `zeta-${String(index + 1).padStart(2, "0")}`;
            return {
              ...JSON.parse(JSON.stringify(seed)),
              name,
              triggers: [`F${index + 1}`],
              edit_href: `/nocturne?slot=1&macro=${name}`,
            };
          });
          if (addDirectRoute) {
            setPadControlKeys(pad, "a", ["F13"]);
            markTopology();
          }
          if (changeGroupedMeta) {
            pad.macros[11].disabled = true;
            pad.macros[11].meta = "12 steps · off";
            markMetadata();
          }
        }
        await route.fulfill({ response, json: payload });
      });
    });
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      await page.waitForFunction(
        () => document.querySelector("#n-mapping-processors")?.dataset.flowProcessorOverflow === "8",
      );
      const migrating = page.locator(
        '#n-mapping-processors a.n-flow-processor[data-flow-macro-id*="hadouken"]',
      );
      const migratingId = await migrating.getAttribute("data-flow-macro-id");
      await migrating.focus();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".n-canvas").scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (macroId) =>
          document.querySelector("#n-mapping-processors")?.dataset.flowProcessorOverflow === "11" &&
          document.activeElement?.matches("a.n-flow-overflow-link") &&
          document.activeElement?.getAttribute("data-flow-macro-id") === macroId &&
          document.querySelector("details.n-flow-overflow")?.hasAttribute("open"),
        migratingId,
      );
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.waitForFunction(
        (macroId) =>
          document.querySelector("#n-mapping-processors")?.dataset.flowProcessorOverflow === "8" &&
          document.activeElement?.matches("a.n-flow-processor:not([hidden])") &&
          document.activeElement?.getAttribute("data-flow-macro-id") === macroId,
        migratingId,
      );
      await page.keyboard.press("Enter");
      await page.locator("#n-macro-dialog").waitFor({ state: "visible" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".n-canvas").scrollIntoViewIfNeeded();
      await page.waitForFunction(() =>
        document.querySelector("#n-mapping-processors")?.dataset.flowProcessorOverflow === "11");
      await page.locator(".n-macx").click();
      await page.waitForFunction(
        (macroId) =>
          document.querySelector("#n-macro-dialog")?.closest(".nd-back")?.classList.contains("none") &&
          document.activeElement?.matches("a.n-flow-overflow-link") &&
          document.activeElement?.getAttribute("data-flow-macro-id") === macroId &&
          document.querySelector("details.n-flow-overflow")?.hasAttribute("open"),
        migratingId,
      );
      const bank = page.locator("details.n-flow-overflow");
      await bank.locator("summary").click();
      assert.equal(await bank.getAttribute("open"), null);
      const geometry = await page.evaluate(() => {
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const cards = [
          ...document.querySelectorAll("#n-mapping-processors a.n-flow-processor:not([hidden])"),
          document.querySelector("#n-mapping-processors details.n-flow-overflow:not([hidden])"),
        ].filter(Boolean);
        const boxes = cards.map((card) => card.getBoundingClientRect());
        const overlap = (left, right) =>
          left.left < right.right && left.right > right.left &&
          left.top < right.bottom && left.bottom > right.top;
        return {
          cards: cards.length,
          inside: boxes.every((box) =>
            box.left >= viewport.left - 1 && box.right <= viewport.right + 1 &&
            box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1),
          overlaps: boxes.some((box, index) =>
            boxes.slice(index + 1).some((other) => overlap(box, other))),
          reachable: boxes.every((box, index) =>
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
              ?.closest("a.n-flow-processor, details.n-flow-overflow") === cards[index]),
        };
      });
      assert.deepEqual(geometry, {
        cards: 2,
        inside: true,
        overlaps: false,
        reachable: true,
      });
      assert.match(await bank.textContent(), /\+11 more/);
      assert.match(await page.textContent("#n-mapping-path-status"), /11 macros are grouped/i);
      await bank.locator("summary").click();
      const grouped = bank.locator("a.n-flow-overflow-link");
      assert.equal(await grouped.count(), 11);
      const summary = bank.locator("summary");
      await summary.focus();
      addDirectRoute = true;
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await topologyChanged;
      await page.waitForFunction(() =>
        document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="F13"][data-flow-fn="a"]',
        ) !== null &&
        document.activeElement?.matches("details.n-flow-overflow summary") &&
        document.querySelector("details.n-flow-overflow")?.hasAttribute("open"));

      const last = grouped.last();
      await last.scrollIntoViewIfNeeded();
      const lastMacroId = await last.getAttribute("data-flow-macro-id");
      await last.focus();
      changeGroupedMeta = true;
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await metadataChanged;
      await page.waitForFunction(
        (macroId) =>
          /12 steps · off/.test(document.activeElement?.textContent ?? "") &&
          document.activeElement?.getAttribute("data-flow-macro-id") === macroId &&
          document.querySelector("details.n-flow-overflow")?.hasAttribute("open"),
        lastMacroId,
      );
      assert.equal(
        await last.evaluate((link) => {
          const box = link.getBoundingClientRect();
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            ?.closest("a.n-flow-overflow-link") === link;
        }),
        true,
        "the last grouped macro remains a real reachable link",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Space and middle-button pans can begin over a processor without opening it", async () => {
    const page = await openCanvas();
    try {
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      const viewport = page.locator(".forma-canvas-viewport");
      const node = page.locator("#n-mapping-processors a.n-flow-processor").first();
      await node.waitFor({ state: "visible" });
      const beforeSpace = await page.getAttribute(".forma-canvas-stage", "style");
      await viewport.focus();
      await page.keyboard.down("Space");
      await page.waitForFunction(() =>
        document.querySelector(".forma-canvas-viewport")?.classList.contains("is-pan-ready"));
      let box = await node.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 35, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await page.waitForFunction((before) =>
        document.querySelector(".forma-canvas-stage")?.getAttribute("style") !== before,
      beforeSpace);

      const beforeMiddle = await page.getAttribute(".forma-canvas-stage", "style");
      box = await node.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(box.x + box.width / 2 - 55, box.y + box.height / 2 + 25, { steps: 5 });
      await page.mouse.up({ button: "middle" });
      await page.waitForFunction((before) =>
        document.querySelector(".forma-canvas-stage")?.getAttribute("style") !== before,
      beforeMiddle);
      assert.equal(new URL(page.url()).searchParams.has("macro"), false);
      assert.equal(await page.isHidden("#n-macro-dialog"), true);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.keyboard.up("Space").catch(() => {});
      await page.close();
    }
  });

  test("Tidy up puts the board on top, the controllers in seat order, all in view", async () => {
    const page = await openCanvas();
    try {
      // Scatter first: a "tidy" that already matched the resting arrangement
      // would pass without doing anything at all.
      await page.evaluate(() => {
        document.querySelectorAll(".forma-canvas-stage .widget-instance").forEach((el, index) => {
          const x = 900 + index * 37;
          const y = 1200 - index * 53;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.dataset.canvasX = String(x);
          el.dataset.canvasY = String(y);
        });
      });

      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);

      const layout = await page.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        ).map((el) => ({
          id: el.dataset.instanceId,
          x: Number(el.dataset.canvasX),
          y: Number(el.dataset.canvasY),
        }));
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const offscreen = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        )
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left < viewport.left - 2 ||
              rect.right > viewport.right + 2 ||
              rect.top < viewport.top - 2 ||
              rect.bottom > viewport.bottom + 2
            );
          })
          .map((el) => el.dataset.instanceId);
        return {
          keyboard: items.find((item) => item.id === "keyboard"),
          pads: items.filter((item) => item.id !== "keyboard").sort((a, b) => a.x - b.x),
          offscreen,
        };
      });

      assert.ok(layout.keyboard, "the board is one of the widgets being arranged");
      assert.ok(
        layout.pads.every((pad) => pad.y > layout.keyboard.y),
        `the board sits above every controller (board ${layout.keyboard.y}, pads ${
          layout.pads.map((p) => p.y).join(", ")
        })`,
      );
      assert.equal(
        new Set(layout.pads.map((pad) => pad.y)).size,
        1,
        "two controllers that fit side by side share a row",
      );
      assert.deepEqual(
        layout.pads.map((pad) => pad.id),
        ["pad-1", "pad-2"],
        "controllers read left to right in seat order",
      );
      assert.deepEqual(layout.offscreen, [], "tidying also brings everything into view");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Tidy up puts every widget back to 100%", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      assert.ok(
        (await scaleOf(page, "pad-1")) > 1,
        "the widget has to be off 100% for this test to mean anything",
      );

      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);
      const scales = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-stage .widget-instance")).map((el) =>
          Number(el.dataset.canvasManualScale ?? 1),
        ),
      );
      assert.deepEqual(
        scales.filter((scale) => scale !== 1),
        [],
        "tidying is a reset: an odd size in an even row is the untidiness it ends",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the canvas is bounded: a widget cannot be pushed out of the world", async () => {
    const page = await openCanvas();
    try {
      // Ask for a position far outside the world, the way a long drag or a
      // store written before the bound existed would.
      const landed = await page.evaluate(() => {
        const item = document.querySelector('[data-instance-id="pad-1"]');
        const handle = item.querySelector(".widget-drag-handle");
        const rect = handle.getBoundingClientRect();
        const down = (type, x, y) =>
          handle.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        down("pointerdown", rect.x + 8, rect.y + 8);
        down("pointermove", rect.x + 40_000, rect.y + 40_000);
        down("pointerup", rect.x + 40_000, rect.y + 40_000);
        return {
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
          width: Number(item.dataset.canvasWidth),
          height: Number(item.dataset.canvasHeight),
        };
      });
      // CANVAS_WORLD in NocturneIsland.ts: a runaway rail at -8000 spanning
      // 20 000, NOT a workspace edge. Widgets are bounded; the CAMERA
      // deliberately is not — see "you can look anywhere" below.
      assert.ok(
        landed.x + landed.width <= 12_000 + 1 && landed.y + landed.height <= 12_000 + 1,
        `a widget dragged 40 000px away is still on the rail (landed at ${landed.x}, ${landed.y})`,
      );
      // And the near edges are nowhere near the arrangement. A bound
      // anchored at (0, 0) put a wall 140px above the tidied board, which
      // is an invisible wall in the middle of an empty canvas — the exact
      // thing this rail must never feel like. Dragging up and left has to
      // sail through zero into negative coordinates.
      const upLeft = await page.evaluate(() => {
        const item = document.querySelector('[data-instance-id="pad-2"]');
        const handle = item.querySelector(".widget-drag-handle");
        const rect = handle.getBoundingClientRect();
        const send = (type, x, y) =>
          handle.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 2,
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        send("pointerdown", rect.x + 8, rect.y + 8);
        send("pointermove", rect.x - 3000, rect.y - 3000);
        send("pointerup", rect.x - 3000, rect.y - 3000);
        return { x: Number(item.dataset.canvasX), y: Number(item.dataset.canvasY) };
      });
      assert.ok(
        upLeft.y < -500 && upLeft.x < -500,
        `a widget dragged up and left goes past zero, not into a wall (${
          JSON.stringify(upLeft)
        })`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("you can look anywhere: the view is never caged", async () => {
    const page = await openCanvas();
    try {
      const camera = () =>
        page.evaluate(() => {
          const parsed =
            /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
              document.querySelector(".forma-canvas-stage").style.transform,
            ) ?? [];
          return { panX: Number(parsed[1] ?? 0), panY: Number(parsed[2] ?? 0) };
        });

      // Pan hard past the top-left of everything, the way you would to put
      // the arrangement in the middle of the screen. Caging the camera made
      // exactly this impossible, and it read as a broken app.
      const before = await camera();
      await page.keyboard.press("Tab");
      await page.evaluate(() => document.querySelector(".forma-canvas-viewport").focus());
      for (let press = 0; press < 25; press++) {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
      }
      await settle(page);
      const after = await camera();
      assert.ok(
        after.panX < before.panX - 500 && after.panY < before.panY - 500,
        `panning keeps going past the content (${JSON.stringify(before)} -> ${
          JSON.stringify(after)
        })`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("dragging the map moves the view with it, without fighting back", async () => {
    const page = await openCanvas();
    try {
      const map = await page.locator(".forma-canvas-navigator").boundingBox();
      const readRect = () =>
        page.evaluate(() => {
          const rect = document
            .querySelector(".forma-canvas-navigator-viewport")
            .getBoundingClientRect();
          const parsed =
            /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
              document.querySelector(".forma-canvas-stage").style.transform,
            ) ?? [];
          return { x: Math.round(rect.x), panX: Number(parsed[1] ?? 0) };
        });

      // Drag across the map toward its bottom-right corner, sampling as we
      // go. What this catches: the camera and the rectangle disagreeing —
      // the rectangle sliding on while the view has stopped, which is what
      // a clamped camera under an unclamped map looked like, and it read as
      // stuttering. Starts in empty map space: pressing a MARKER is a jump
      // to that widget, which is a different gesture entirely.
      // The map redraws on the next frame, so each sample waits for one —
      // otherwise this measures rAF scheduling, not whether the two agree.
      const frame = () =>
        page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      const startX = map.x + 10;
      const startY = map.y + 10;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await frame();
      const samples = [await readRect()];
      for (let step = 1; step <= 10; step++) {
        await page.mouse.move(
          startX + (map.width - 20) * (step / 10),
          startY + (map.height - 20) * (step / 10),
        );
        await frame();
        samples.push(await readRect());
      }
      await page.mouse.up();

      await settle(page);
      const ended = await readRect();
      const first = samples[0];

      // Dragging right and down moves the view right and down (pan goes
      // more negative as the world slides left under a view moving right).
      assert.ok(
        ended.panX < first.panX,
        `the drag moved the view (${first.panX} -> ${ended.panX})`,
      );
      // And the rectangle went WITH it. The pathology this guards is the
      // two disagreeing — a rectangle that slides on while the view has
      // stopped, which is what a caged camera under an uncaged map did, and
      // which read as stuttering.
      assert.ok(
        ended.x > first.x,
        `the rectangle followed the view (${first.x} -> ${ended.x})`,
      );
      // Every sample was taken mid-drag with the mapping FROZEN, so the
      // rectangle only ever advanced — a mapping that re-scaled under the
      // gesture would have walked it backwards somewhere along the way.
      for (let index = 1; index < samples.length; index++) {
        assert.ok(
          samples[index].x >= samples[index - 1].x - 1,
          `the rectangle never doubles back mid-drag (step ${index}: ${
            JSON.stringify(samples[index - 1])
          } -> ${JSON.stringify(samples[index])})`,
        );
      }
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("every marker says which seat it is", async () => {
    const page = await openCanvas();
    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Logitech G915");
      const markers = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-navigator .navigator-item")).map(
          (el) => ({
            id: el.dataset.instanceId,
            text: (el.textContent ?? "").trim(),
            title: el.getAttribute("title") ?? "",
            seatColoured: /\bnp\d+\b/.test(el.className),
          }),
        ),
      );
      assert.ok(markers.length >= 3, "the fixture stages a board and two controllers");
      const board = markers.find((marker) => marker.id === "keyboard");
      assert.equal(board?.text, "KB", "an ordinary keyboard keeps its own source identity");
      assert.match(board?.title ?? "", /Keyboard.*physical key source/i);
      for (const marker of markers.filter((m) => m.id !== "keyboard")) {
        assert.match(
          marker.text,
          /^P\d+$/,
          `a controller marker carries its seat (${marker.id} said "${marker.text}")`,
        );
        assert.ok(
          marker.seatColoured,
          `${marker.id} wears its seat colour, the same one the rack and badge use`,
        );
        assert.match(
          marker.title,
          /^P\d+ · /,
          `${marker.id}'s tooltip carries the full name the box has no room for`,
        );
      }
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Ultimarc I-PAC 4");
      const encoderMarker = page.locator(
        '.forma-canvas-navigator .navigator-item[data-instance-id="keyboard"]',
      );
      assert.equal(
        (await encoderMarker.textContent()).trim(),
        "I-PAC",
        "selecting the encoder renames the source marker without pretending it is a keyboard",
      );
      assert.match(
        await encoderMarker.getAttribute("title"),
        /I-PAC(?: 4X?)? Signals.*terminal and keyboard host-signal source/i,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the map hides and comes back, and comes back drawn", async () => {
    const page = await openCanvas();
    try {
      const markerCount = () =>
        page.evaluate(
          () => document.querySelectorAll(".forma-canvas-navigator .navigator-item").length,
        );
      assert.ok((await markerCount()) > 0, "the map starts shown");
      assert.equal(
        await page.evaluate(() => document.querySelector(".n-mapshow").hidden),
        true,
        "and its stand-in stays out of the way while it is shown",
      );

      // The map's own × puts it away…
      await page.click(".n-mapclose");
      assert.equal(await page.evaluate(() => document.querySelector(".forma-canvas-navigator").hidden), true);
      // …and what brings it back is in the same corner, not in a bar at the
      // other end of the page.
      const corner = await page.evaluate(() => {
        const button = document.querySelector(".n-mapshow");
        const canvas = document.querySelector(".n-canvas");
        const b = button.getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        return {
          hidden: button.hidden,
          nearRight: c.right - b.right < 40,
          nearBottom: c.bottom - b.bottom < 40,
        };
      });
      assert.equal(corner.hidden, false, "the stand-in appears when the map goes away");
      assert.ok(corner.nearRight && corner.nearBottom, "and it sits in the bottom-right corner");

      await page.click(".n-mapshow");
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.querySelector(".forma-canvas-navigator").hidden), false);
      // A hidden map has no box to project onto, so this is the assertion
      // that catches it coming back blank.
      const drawn = await page.evaluate(() => {
        const rect = document.querySelector(".forma-canvas-navigator-viewport").getBoundingClientRect();
        const map = document.querySelector(".forma-canvas-navigator").getBoundingClientRect();
        return { rectW: rect.width, rectH: rect.height, mapW: map.width, mapH: map.height };
      });
      assert.ok(drawn.rectW > 0 && drawn.rectH > 0, "the camera rectangle is drawn again");
      assert.ok(
        drawn.rectW <= drawn.mapW + 1 && drawn.rectH <= drawn.mapH + 1,
        `the camera rectangle fits its map (${drawn.rectW}x${drawn.rectH} in ${drawn.mapW}x${drawn.mapH})`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the camera rectangle never outgrows the map, even zoomed all the way out", async () => {
    const page = await openCanvas();
    try {
      for (let press = 0; press < 12; press++) {
        await page.click('[data-nx="canvas-zoom-out"]');
      }
      await settle(page);
      const fit = await page.evaluate(() => {
        const rect = document.querySelector(".forma-canvas-navigator-viewport").getBoundingClientRect();
        const map = document.querySelector(".forma-canvas-navigator").getBoundingClientRect();
        return {
          overflowX: Math.round(rect.right - map.right),
          overflowY: Math.round(rect.bottom - map.bottom),
          underflowX: Math.round(map.left - rect.left),
          underflowY: Math.round(map.top - rect.top),
        };
      });
      assert.ok(
        fit.overflowX <= 1 && fit.overflowY <= 1 && fit.underflowX <= 1 && fit.underflowY <= 1,
        `the rectangle stays inside the box it is drawn on (${JSON.stringify(fit)})`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the map carries one marker per widget, and a marker selects it", async () => {
    const page = await openCanvas();
    try {
      const markers = await page.evaluate(
        () => document.querySelectorAll(".forma-canvas-navigator .navigator-item").length,
      );
      assert.equal(
        markers,
        await page.evaluate(
          () => document.querySelectorAll(".forma-canvas-stage .widget-instance").length,
        ),
        "the map must render into the DOCUMENT — a detached map has no markers",
      );

      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-navigator .navigator-item")).map((el) =>
          el.getAttribute("aria-label"),
        ),
      );
      assert.ok(
        labels.every((label) => label && label.trim() !== ""),
        "every marker names the widget it stands for",
      );

      await page.click(".forma-canvas-navigator .navigator-item");
      await settle(page);
      assert.notEqual(
        (await page.textContent(".n-sel-name")).trim(),
        "Nothing selected",
        "clicking a marker jumps to that widget and selects it",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a newly added controller is selected, centered, and impossible to lose", async () => {
    const page = await openCanvas();
    let arrivingSlot = "";
    let beforeSlots = [];
    let cleaned = false;
    try {
      const beforeIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".n-widget-pad[data-instance-id]"), (item) =>
          item.getAttribute("data-instance-id")
        ).filter(Boolean)
      );
      beforeSlots = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-slot-row]"), (row) =>
          row.getAttribute("data-slot-row")
        ).filter(Boolean)
      );

      // Leave the whole arrangement far behind first. A passing result must
      // be the arrival behavior, not a pad that happened to spawn on screen.
      await page.evaluate(() => document.querySelector(".forma-canvas-viewport").focus());
      for (let press = 0; press < 70; press++) {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
      }
      await settle(page);
      const cameraBefore = await page.evaluate(() =>
        document.querySelector(".forma-canvas-stage").style.transform
      );

      // Duplicate is the shortest real add flow: the same POST, response,
      // poll and roster reconciliation as Create, with no test-only hook.
      await page.hover('[data-slot-row="1"]');
      await page.click(
        '[data-slot-row="1"] form[action="/nocturne/controller/duplicate"] button[type="submit"]',
      );
      await page.waitForFunction(
        (count) => document.querySelectorAll(".n-widget-pad[data-instance-id]").length === count + 1,
        beforeIds.length,
        { timeout: 20_000 },
      );
      await settle(page);

      const arrival = await page.evaluate(({ beforeIds, beforeSlots }) => {
        const priorIds = new Set(beforeIds);
        const priorSlots = new Set(beforeSlots);
        const item = Array.from(
          document.querySelectorAll(".n-widget-pad[data-instance-id]"),
        ).find((candidate) => !priorIds.has(candidate.getAttribute("data-instance-id")));
        const row = Array.from(document.querySelectorAll("[data-slot-row]")).find(
          (candidate) => !priorSlots.has(candidate.getAttribute("data-slot-row")),
        );
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const rect = item?.getBoundingClientRect();
        return {
          id: item?.getAttribute("data-instance-id") ?? "",
          slot: row?.getAttribute("data-slot-row") ?? "",
          active: item?.classList.contains("is-active") ?? false,
          current: item?.getAttribute("aria-current") ?? "",
          selection: document.querySelector(".n-sel-name")?.textContent?.trim() ?? "",
          camera: document.querySelector(".forma-canvas-stage")?.style.transform ?? "",
          inset: rect
            ? {
              left: rect.left - viewport.left,
              top: rect.top - viewport.top,
              right: viewport.right - rect.right,
              bottom: viewport.bottom - rect.bottom,
            }
            : null,
          centerDelta: rect
            ? {
              x: Math.abs((rect.left + rect.right) / 2 - (viewport.left + viewport.right) / 2),
              y: Math.abs((rect.top + rect.bottom) / 2 - (viewport.top + viewport.bottom) / 2),
            }
            : null,
        };
      }, { beforeIds, beforeSlots });
      arrivingSlot = arrival.slot;

      assert.ok(arrival.id, "the duplicate produces one new canvas widget");
      assert.ok(arrivingSlot, "the duplicate produces one new controller slot");
      assert.equal(arrival.active, true, "the arriving controller becomes the selected widget");
      assert.equal(arrival.current, "true", "the selected state is exposed accessibly");
      assert.match(arrival.selection, new RegExp(`P${arrivingSlot}\\b`));
      assert.notEqual(arrival.camera, cameraBefore, "the camera travels to the arriving controller");
      assert.ok(arrival.inset, "the arriving controller has measurable geometry");
      for (const [edge, inset] of Object.entries(arrival.inset)) {
        assert.ok(inset >= 20, `${edge} keeps a comfortable viewport gutter (${inset}px)`);
      }
      assert.ok(
        arrival.centerDelta.x <= 2 && arrival.centerDelta.y <= 2,
        `the arrival is centered (${JSON.stringify(arrival.centerDelta)})`,
      );

      await page.hover(`[data-slot-row="${arrivingSlot}"]`);
      await page.click(
        `[data-slot-row="${arrivingSlot}"] form[action="/nocturne/controller/remove"] button[type="submit"]`,
      );
      await page.waitForFunction(
        (count) => document.querySelectorAll(".n-widget-pad[data-instance-id]").length === count,
        beforeIds.length,
        { timeout: 20_000 },
      );
      cleaned = true;
      await page.click('[data-nx="canvas-fit"]');
      await settle(page);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      if (!cleaned) {
        const fallbackSlot = arrivingSlot || await page.evaluate((beforeSlots) => {
          const prior = new Set(beforeSlots);
          return Array.from(document.querySelectorAll("[data-slot-row]"), (row) =>
            row.getAttribute("data-slot-row")
          ).find((slot) => slot && !prior.has(slot)) ?? "";
        }, beforeSlots);
        if (fallbackSlot) {
          await fetch(`${BASE}/nocturne/controller/remove`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `number=${encodeURIComponent(fallbackSlot)}`,
            redirect: "manual",
          });
        }
      }
      await page.close();
    }
  });

  test("keyboard finishes preserve ownership while Keyboard Arranger keeps a persistent real-key layout", async () => {
    const page = await openCanvas();
    const bindingPosts = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) bindingPosts.push(pathname);
    });

    const sourceSelector = ".n-widget-kb .n-kbcase .n-key[data-key]";
    const ownerClasses = (className) => className
      .split(/\s+/)
      .filter((name) =>
        name === "bound" ||
        name === "shared" ||
        name === "bstack" ||
        /^(?:bn|ba|bb|bc|bd|bcount)\d+$/.test(name)
      )
      .sort();
    const readKeyboard = () => page.evaluate((selector) => {
      const widget = document.querySelector(".n-widget-kb");
      const keyboardCase = widget?.querySelector(".n-kbcase");
      const sampleCap = widget?.querySelector('.n-key[data-key="Q"]');
      const caseRect = keyboardCase?.getBoundingClientRect();
      const scaleX = keyboardCase && caseRect ? caseRect.width / keyboardCase.offsetWidth : 1;
      const scaleY = keyboardCase && caseRect ? caseRect.height / keyboardCase.offsetHeight : 1;
      // Normalize through the canvas scale, then ignore sub-hundredth pixel
      // transform noise while still pinning every authored cap dimension.
      const round = (value) => Math.round(value * 100) / 100;
      const keys = Array.from(document.querySelectorAll(selector));
      const buttons = Array.from(document.querySelectorAll(".n-kbtheme"));
      return {
        theme: widget?.getAttribute("data-keyboard-theme") ?? null,
        paint: keyboardCase ? getComputedStyle(keyboardCase).backgroundImage : "",
        capPaint: sampleCap ? getComputedStyle(sampleCap, "::before").backgroundImage : "",
        source: keys.map((key) => {
          const rect = key.getBoundingClientRect();
          return {
            key: key.getAttribute("data-key") ?? "",
            className: key.className,
            rect: caseRect
              ? [
                  round((rect.left - caseRect.left) / scaleX),
                  round((rect.top - caseRect.top) / scaleY),
                  round(rect.width / scaleX),
                  round(rect.height / scaleY),
                ]
              : [],
          };
        }),
        buttons: buttons.map((button) => ({
          native: button instanceof HTMLButtonElement,
          type: button.type,
          label: button.getAttribute("aria-label") ?? "",
          slug: button.getAttribute("data-keyboard-theme") ?? "",
          pressed: button.getAttribute("aria-pressed"),
        })),
      };
    }, sourceSelector);
    const readDeck = () => page.evaluate(() => {
      const deck = document.querySelector(".n-widget-keylab .n-keylab-deck");
      const keys = Array.from(deck?.querySelectorAll(".n-deck-key[data-keylab-key]") ?? []);
      return {
        widgetCount: document.querySelectorAll(".n-widget-keylab").length,
        renderMode: deck?.getAttribute("data-render-mode") ?? null,
        layoutMode: deck?.getAttribute("data-layout-mode") ?? null,
        keycapProfile: deck?.getAttribute("data-keycap-profile") ?? null,
        keys: keys.map((key) => {
          const rect = key.getBoundingClientRect();
          const style = getComputedStyle(key);
          return {
            key: key.getAttribute("data-keylab-key") ?? "",
            canonicalKey: key.getAttribute("data-key") ?? "",
            token: key.getAttribute("data-keylab-token") ?? "",
            playerSlot: key.getAttribute("data-player-slot"),
            ownerSlots: key.getAttribute("data-owner-slots") ?? "",
            ownerBadges: Array.from(key.querySelectorAll(".n-keylab-owner")).map(
              (badge) => badge.getAttribute("data-owner-slot") ?? "",
            ),
            className: key.className,
            left: key.style.left,
            top: key.style.top,
            width: rect.width,
            height: rect.height,
            radius: style.borderTopLeftRadius,
            paint: style.backgroundImage,
          };
        }),
      };
    });
    const readSourceSemantics = () => page.evaluate(() => {
      const caps = Array.from(
        document.querySelectorAll(".n-widget-kb [data-key]:not(.ghost)"),
      );
      return {
        count: caps.length,
        roles: caps.map((cap) => cap.getAttribute("role")),
        tabStops: caps.filter((cap) => cap.tabIndex === 0)
          .map((cap) => cap.getAttribute("data-key")),
        negativeTabs: caps.filter((cap) => cap.tabIndex === -1).length,
        pressed: caps.filter((cap) => cap.getAttribute("aria-pressed") === "true")
          .map((cap) => cap.getAttribute("data-key")),
        invalidPressed: caps.filter((cap) => !["true", "false"].includes(
          cap.getAttribute("aria-pressed") ?? "",
        )).length,
      };
    });
    const persistedWorkbench = () => page.evaluate(() => {
      const raw = localStorage.getItem("ksx-nocturne-keyboard-workbench1");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Object.values(parsed.devices ?? {})[0] ?? null;
    });

    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await page.waitForFunction(() => Array.from(
        document.querySelectorAll(".n-devform:not(.n-encoder-form)"),
      ).some((row) => row.textContent?.includes("Logitech G915") &&
        row.querySelector("button.n-dev")?.classList.contains("on")));
      await waitForSourceWidget(page, "Logitech G915");
      const themeSlugs = [
        "carbon-forge",
        "lunar-shell",
        "violet-circuit",
        "glacier-current",
        "ghost-mint",
        "retro-terminal",
      ];
      const initial = await readKeyboard();
      assert.equal(initial.source.length, 108, "the standard board starts with all 108 served cells");
      assert.equal(initial.buttons.length, 6, "the keyboard exposes six restrained finish dashes");
      assert.ok(initial.buttons.every((button) => button.native), "every finish is a native button");
      assert.ok(initial.buttons.every((button) => button.type === "button"));
      assert.deepEqual(
        initial.buttons.map((button) => button.slug),
        themeSlugs,
        "the finish rail exposes the exact six app-owned materials",
      );
      assert.equal(new Set(initial.buttons.map((button) => button.label)).size, 6);
      assert.ok(initial.buttons.every((button) => button.label), "every finish has a unique name");
      assert.equal(
        initial.buttons.filter((button) => button.pressed === "true").length,
        1,
        "exactly one keyboard finish exposes selected state",
      );

      const themePaints = [];
      for (const slug of [
        "lunar-shell",
        "violet-circuit",
        "glacier-current",
        "ghost-mint",
        "retro-terminal",
        "carbon-forge",
      ]) {
        await page.click(`.n-kbtheme[data-keyboard-theme="${slug}"]`);
        await page.waitForFunction(
          (theme) => document.querySelector(".n-widget-kb")?.getAttribute(
            "data-keyboard-theme",
          ) === theme,
          slug,
        );
        await page.waitForTimeout(200);
        const themed = await readKeyboard();
        assert.deepEqual(
          themed.buttons
            .filter((button) => button.pressed === "true")
            .map((button) => button.slug),
          [slug],
          `${slug} is the sole selected finish`,
        );
        assert.deepEqual(
          themed.source.map((key) => key.key),
          initial.source.map((key) => key.key),
          `${slug} preserves canonical key order`,
        );
        assert.deepEqual(
          themed.source.map((key) => key.rect),
          initial.source.map((key) => key.rect),
          `${slug} cannot move or resize a source key`,
        );
        assert.deepEqual(
          themed.source.map((key) => ownerClasses(key.className)),
          initial.source.map((key) => ownerClasses(key.className)),
          `${slug} remains separate from every controller ownership band`,
        );
        themePaints.push({ slug, casePaint: themed.paint, capPaint: themed.capPaint });
      }
      assert.equal(
        new Set(themePaints.map((theme) => theme.casePaint)).size,
        themeSlugs.length,
        "all six materials have distinct case paint",
      );
      assert.equal(
        new Set(themePaints.map((theme) => theme.capPaint)).size,
        themeSlugs.length,
        "all six materials have distinct keycap paint",
      );

      await page.click('.n-kbtheme[data-keyboard-theme="lunar-shell"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
      );
      await page.waitForTimeout(200);
      const lunar = await readKeyboard();

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      const restoredTheme = await readKeyboard();
      assert.equal(restoredTheme.paint, lunar.paint, "the selected material survives reload");
      assert.deepEqual(
        restoredTheme.buttons
          .filter((button) => button.pressed === "true")
          .map((button) => button.slug),
        ["lunar-shell"],
      );
      const legacyIdentity = await page.evaluate(() => {
        const storageKey = "ksx-nocturne-keyboard-workbench1";
        const current = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        const identity = Object.keys(current?.devices ?? {})[0] ?? "";
        if (!identity) throw new Error("the fresh finish preference did not identify its keyboard");
        localStorage.setItem(storageKey, JSON.stringify({
          version: 1,
          devices: {
            [identity]: {
              open: false,
              sourceHidden: true,
              theme: "lunar-shell",
              capProfile: "typewriter",
              selectedKeys: [],
              layoutMode: "compact",
              renderMode: "arcade",
              positions: {},
            },
          },
        }));
        return identity;
      });
      assert.ok(legacyIdentity, "the legacy fixture targets the selected physical keyboard");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      assert.equal(
        await page.locator(".n-widget-keylab").count(),
        0,
        "the closed legacy board remains closed until Build board is requested",
      );
      await page.evaluate((selector) => {
        window.__ksxKeyboardSourceAudit = Array.from(document.querySelectorAll(selector)).map(
          (node) => ({ node, parent: node.parentElement, key: node.getAttribute("data-key") ?? "" }),
        );
      }, sourceSelector);

      await page.locator('[data-nx="kb-workbench"]').evaluate((button) => button.click());
      await page.waitForSelector(".n-widget-keylab");
      await settle(page);
      assert.equal(
        await page.locator(".n-widget-keylab").count(),
        1,
        "Build board mounts exactly one client-owned workbench widget",
      );
      assert.equal(
        await page.locator(sourceSelector).count(),
        108,
        "opening the workbench never reparents or removes source cells",
      );
      const migratedDeck = await readDeck();
      assert.equal(migratedDeck.renderMode, "keycap");
      assert.equal(migratedDeck.layoutMode, "compact");
      assert.equal(migratedDeck.keycapProfile, "sculpted");
      assert.equal(
        await page.locator(
          '.n-widget-keylab [data-nx="keylab-render-keycap"], .n-widget-keylab [data-nx="keylab-render-arcade"], .n-widget-keylab [data-nx="keylab-layout-leverless"], .n-widget-keylab [data-nx="keylab-build-players"]',
        ).count(),
        0,
        "arcade and cabinet construction no longer masquerade as keyboard arrangement",
      );
      assert.equal(
        (await page.textContent(".n-widget-keylab .n-kick")).trim(),
        "Keyboard Arranger",
      );
      assert.match(
        (await page.textContent(".n-widget-keylab .n-keylab-note")).trim(),
        /Build Surface is the separate path/,
      );
      const capProfileSlugs = ["sculpted", "low-profile", "pudding", "typewriter"];
      const profileButtons = page.locator(
        '.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile]',
      );
      assert.deepEqual(
        await profileButtons.evaluateAll((buttons) => buttons.map((button) => ({
          native: button instanceof HTMLButtonElement,
          type: button.type,
          slug: button.getAttribute("data-keycap-profile"),
          pressed: button.getAttribute("aria-pressed"),
        }))),
        capProfileSlugs.map((slug) => ({
          native: true,
          type: "button",
          slug,
          pressed: String(slug === "sculpted"),
        })),
        "fresh v2 defaults expose four native cap profiles with Sculpted selected",
      );
      assert.equal(
        await page.evaluate(() => JSON.parse(
          localStorage.getItem("ksx-nocturne-keyboard-workbench1") ?? "null",
        )?.version),
        2,
        "opening the migrated board rewrites it through the v2 store",
      );
      const propagatedTheme = await page.evaluate(() => {
        const keyboard = document.querySelector(".n-widget-kb");
        const workbench = document.querySelector(".n-widget-keylab");
        return {
          keyboardTheme: keyboard?.getAttribute("data-keyboard-theme"),
          workbenchTheme: workbench?.getAttribute("data-keyboard-theme"),
          keyboardCap: keyboard
            ? getComputedStyle(keyboard).getPropertyValue("--n-kb-key-face-top").trim()
            : "",
          workbenchCap: workbench
            ? getComputedStyle(workbench).getPropertyValue("--n-kb-key-face-top").trim()
            : "",
        };
      });
      assert.deepEqual(
        [propagatedTheme.keyboardTheme, propagatedTheme.workbenchTheme],
        ["lunar-shell", "lunar-shell"],
        "the physical keyboard and linked workbench share the selected material",
      );
      assert.equal(
        propagatedTheme.workbenchCap,
        propagatedTheme.keyboardCap,
        "the workbench inherits the same keycap paint variables",
      );
      const openSemantics = await readSourceSemantics();
      assert.ok(
        openSemantics.roles.every((role) => role === "button"),
        "build mode exposes every physical cap as a button",
      );
      assert.equal(openSemantics.tabStops.length, 1, "the source board has one roving tab stop");
      assert.equal(openSemantics.negativeTabs, openSemantics.count - 1);
      assert.deepEqual(openSemantics.pressed, []);
      assert.equal(openSemantics.invalidPressed, 0, "every source cap exposes pressed state");

      const liftedKeys = ["W", "A", "S", "D"];
      for (const key of liftedKeys) {
        const cap = page.locator(`.n-widget-kb .n-key[data-key="${key}"]`);
        await cap.focus();
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 4,
      );
      assert.equal(
        await page.locator(".n-widget-kb .n-key.extracted").count(),
        4,
        "four lifted caps leave four source sockets",
      );
      assert.equal(await page.locator(sourceSelector).count(), 108, "sockets retain the full layout");
      const extractedKeyboard = await readKeyboard();
      assert.deepEqual(
        extractedKeyboard.source.map((key) => key.key),
        restoredTheme.source.map((key) => key.key),
        "extraction preserves the source DOM order",
      );
      const maxSocketGeometryDrift = Math.max(...extractedKeyboard.source.flatMap(
        (key, index) => key.rect.map(
          (value, coordinate) => Math.abs(
            value - restoredTheme.source[index].rect[coordinate],
          ),
        ),
      ));
      assert.ok(
        maxSocketGeometryDrift <= 0.02,
        `a socket occupies its lifted keycap geometry (max drift ${maxSocketGeometryDrift}px)`,
      );
      const sourceIdentity = await page.evaluate((selector) => {
        const baseline = window.__ksxKeyboardSourceAudit ?? [];
        const current = Array.from(document.querySelectorAll(selector));
        return {
          sameLength: current.length === baseline.length,
          sameNodes: current.every((node, index) => node === baseline[index]?.node),
          sameParents: current.every(
            (node, index) => node.parentElement === baseline[index]?.parent,
          ),
          sameKeys: current.every(
            (node, index) => (node.getAttribute("data-key") ?? "") === baseline[index]?.key,
          ),
        };
      }, sourceSelector);
      assert.deepEqual(
        sourceIdentity,
        { sameLength: true, sameNodes: true, sameParents: true, sameKeys: true },
        "lifting caps mutates the served nodes in place without reparenting or replacing them",
      );
      const extractedSemantics = await readSourceSemantics();
      assert.equal(extractedSemantics.tabStops.length, 1, "roving focus remains singular");
      assert.equal(extractedSemantics.negativeTabs, extractedSemantics.count - 1);
      assert.deepEqual(extractedSemantics.pressed.sort(), [...liftedKeys].sort());
      assert.equal(extractedSemantics.invalidPressed, 0);

      const linked = await page.evaluate((keys) => {
        const ownership = (element) => Array.from(element.classList)
          .filter((name) =>
            name === "bound" ||
            name === "shared" ||
            name === "bstack" ||
            /^(?:bn|ba|bb|bc|bd|bcount)\d+$/.test(name)
          )
          .sort();
        return keys.map((key) => {
          const source = document.querySelector(`.n-widget-kb .n-key[data-key="${key}"]`);
          const clone = document.querySelector(`.n-widget-keylab .n-deck-key[data-keylab-key="${key}"]`);
          return {
            key,
            sourcePresent: Boolean(source),
            sourceExtracted: source?.classList.contains("extracted") ?? false,
            cloneCanonicalKey: clone?.getAttribute("data-key") ?? null,
            sourceOwnership: source ? ownership(source) : [],
            cloneOwnership: clone ? ownership(clone) : [],
          };
        });
      }, liftedKeys);
      assert.ok(linked.every((entry) => entry.sourcePresent && entry.sourceExtracted));
      assert.deepEqual(linked.map((entry) => entry.cloneCanonicalKey), liftedKeys);
      for (const entry of linked) {
        assert.deepEqual(
          entry.cloneOwnership,
          entry.sourceOwnership,
          `${entry.key} carries its controller ownership onto the deck clone`,
        );
      }

      const compact = await readDeck();
      assert.equal(compact.renderMode, "keycap");
      assert.equal(compact.layoutMode, "compact");
      assert.equal(compact.keycapProfile, "sculpted");
      assert.deepEqual(
        compact.keys.map((key) => key.token).sort(),
        liftedKeys.map((key) => `k:${key}`).sort(),
        "ordinary layouts use one stable k:key token per physical key",
      );
      assert.ok(
        compact.keys.every((key) => key.radius !== "50%"),
        "a freshly migrated workbench presents mechanical keycaps, not circles",
      );
      const compactIdentityAndPosition = compact.keys
        .map((key) => ({
          key: key.key,
          canonicalKey: key.canonicalKey,
          token: key.token,
          left: key.left,
          top: key.top,
        }))
        .sort((a, b) => a.token.localeCompare(b.token));
      for (const profile of ["low-profile", "pudding", "typewriter", "sculpted"]) {
        await page.click(
          `.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile="${profile}"]`,
        );
        await page.waitForFunction(
          (slug) => document.querySelector(".n-widget-keylab .n-keylab-deck")?.getAttribute(
            "data-keycap-profile",
          ) === slug,
          profile,
        );
        const profiled = await readDeck();
        assert.equal(profiled.renderMode, "keycap");
        assert.equal(profiled.keycapProfile, profile);
        assert.deepEqual(
          profiled.keys
            .map((key) => ({
              key: key.key,
              canonicalKey: key.canonicalKey,
              token: key.token,
              left: key.left,
              top: key.top,
            }))
            .sort((a, b) => a.token.localeCompare(b.token)),
          compactIdentityAndPosition,
          `${profile} changes only cap presentation, never canonical keys or positions`,
        );
        assert.deepEqual(
          await profileButtons.evaluateAll((buttons) => buttons
            .filter((button) => button.getAttribute("aria-pressed") === "true")
            .map((button) => button.getAttribute("data-keycap-profile"))),
          [profile],
          `${profile} is the sole selected cap profile`,
        );
      }

      const sourceBeforeHide = await page.evaluate((selector) => {
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const geometry = widget
          ? {
              x: widget.getAttribute("data-canvas-x"),
              y: widget.getAttribute("data-canvas-y"),
              width: widget.getAttribute("data-canvas-width"),
              height: widget.getAttribute("data-canvas-height"),
              z: widget.getAttribute("data-canvas-z"),
              manualScale: widget.getAttribute("data-canvas-manual-scale"),
              styleWidth: widget.style.width,
              styleMinHeight: widget.style.minHeight,
            }
          : null;
        window.__ksxKeyboardHiddenAudit = {
          widget,
          keys,
          parents: keys.map((key) => key.parentElement),
          geometry,
        };
        return { geometry, keyCount: keys.length };
      }, sourceSelector);
      assert.equal(sourceBeforeHide.keyCount, 108);
      assert.deepEqual(
        await page.locator('.n-widget-keylab [data-nx="keylab-source-toggle"]').evaluate(
          (button) => ({
            pressed: button.getAttribute("aria-pressed"),
            expanded: button.getAttribute("aria-expanded"),
          }),
        ),
        { pressed: null, expanded: "true" },
        "the changing source action uses expansion semantics, not an inverted pressed state",
      );
      await page.click('.n-widget-keylab [data-nx="keylab-source-toggle"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-source-hidden") === "true",
      );
      const hiddenSource = await page.evaluate((selector) => {
        const audit = window.__ksxKeyboardHiddenAudit;
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const body = widget?.querySelector(".n-widget-body");
        return {
          sameWidget: widget === audit?.widget,
          widgetConnected: audit?.widget?.isConnected ?? false,
          sameKeyCount: keys.length === audit?.keys.length,
          sameKeyNodes: keys.every((key, index) => key === audit?.keys[index]),
          sameParents: keys.every((key, index) => key.parentElement === audit?.parents[index]),
          keysConnected: audit?.keys.every((key) => key.isConnected) ?? false,
          bodyInert: body?.inert ?? false,
          bodyAriaHidden: body?.getAttribute("aria-hidden") ?? null,
        };
      }, sourceSelector);
      assert.deepEqual(
        hiddenSource,
        {
          sameWidget: true,
          widgetConnected: true,
          sameKeyCount: true,
          sameKeyNodes: true,
          sameParents: true,
          keysConnected: true,
          bodyInert: true,
          bodyAriaHidden: "true",
        },
        "Hide source parks the exact served widget and key nodes instead of destroying them",
      );
      assert.equal(
        await page.locator('.n-widget-kb [data-nx="keylab-source-show"]').count(),
        1,
        "the parked source exposes one explicit restore action",
      );
      await page.locator(
        '.forma-canvas-navigator .navigator-item[aria-label="Focus Keyboard"]',
      ).click();
      await settle(page);
      await page.locator(".n-widget-kb .widget-drag-handle").focus();
      await page.keyboard.press("ArrowRight");
      await page.click('[data-nx="w-zoom-in"]');
      await page.click('.n-widget-kb [data-nx="keylab-source-show"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-source-hidden") === "false",
      );
      await settle(page);
      const restoredSource = await page.evaluate((selector) => {
        const audit = window.__ksxKeyboardHiddenAudit;
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const body = widget?.querySelector(".n-widget-body");
        const geometry = widget
          ? {
              x: widget.getAttribute("data-canvas-x"),
              y: widget.getAttribute("data-canvas-y"),
              width: widget.getAttribute("data-canvas-width"),
              height: widget.getAttribute("data-canvas-height"),
              z: widget.getAttribute("data-canvas-z"),
              manualScale: widget.getAttribute("data-canvas-manual-scale"),
              styleWidth: widget.style.width,
              styleMinHeight: widget.style.minHeight,
            }
          : null;
        return {
          sameWidget: widget === audit?.widget,
          widgetConnected: audit?.widget?.isConnected ?? false,
          sameKeyCount: keys.length === audit?.keys.length,
          sameKeyNodes: keys.every((key, index) => key === audit?.keys[index]),
          sameParents: keys.every((key, index) => key.parentElement === audit?.parents[index]),
          keysConnected: audit?.keys.every((key) => key.isConnected) ?? false,
          bodyInert: body?.inert ?? false,
          bodyAriaHidden: body?.getAttribute("aria-hidden") ?? null,
          geometry,
        };
      }, sourceSelector);
      assert.deepEqual(
        restoredSource,
        {
          sameWidget: true,
          widgetConnected: true,
          sameKeyCount: true,
          sameKeyNodes: true,
          sameParents: true,
          keysConnected: true,
          bodyInert: false,
          bodyAriaHidden: "false",
          geometry: sourceBeforeHide.geometry,
        },
        "Show keyboard restores all six original geometry fields on the exact same served nodes",
      );
      assert.deepEqual(
        (await readDeck()).keys
          .map((key) => ({
            key: key.key,
            canonicalKey: key.canonicalKey,
            token: key.token,
            left: key.left,
            top: key.top,
          }))
          .sort((a, b) => a.token.localeCompare(b.token)),
        compactIdentityAndPosition,
        "parking the source cannot disturb its linked workbench keys",
      );

      // Restoring the much larger source widget can put the workbench under
      // the navigator at the old camera position. Follow the user-facing LAB
      // marker back to the builder before exercising its pointer surface.
      await page.locator(
        '.forma-canvas-navigator .navigator-item[aria-label="Focus Keyboard Arranger"]',
      ).click();
      await settle(page);

      const aButton = page.locator('.n-deck-key[data-keylab-key="A"]');
      const beforeDragA = await aButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      const workbenchBeforeDrag = await page.locator(".n-widget-keylab").evaluate((widget) => ({
        x: widget.getAttribute("data-canvas-x"),
        y: widget.getAttribute("data-canvas-y"),
      }));
      const aBox = await aButton.boundingBox();
      assert.ok(aBox, "the focused arranger exposes a real draggable A keycap");
      await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        aBox.x + aBox.width / 2 + 48,
        aBox.y + aBox.height / 2 + 28,
        { steps: 5 },
      );
      await page.mouse.up();
      await page.waitForFunction(
        ({ left, top }) => {
          const key = document.querySelector('.n-deck-key[data-keylab-key="A"]');
          return key?.style.left !== left && key?.style.top !== top;
        },
        beforeDragA,
      );
      const afterDragA = await aButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      assert.notDeepEqual(afterDragA, beforeDragA, "pointer drag moves the arranged keycap");
      assert.deepEqual(
        await page.locator(".n-widget-keylab").evaluate((widget) => ({
          x: widget.getAttribute("data-canvas-x"),
          y: widget.getAttribute("data-canvas-y"),
        })),
        workbenchBeforeDrag,
        "dragging a token never drags its canvas widget",
      );
      const draggedState = await persistedWorkbench();
      assert.equal(draggedState?.layoutMode, "free", "pointerup commits a custom layout");
      assert.ok(
        draggedState?.positions?.["k:A"],
        "pointerup persists A under its v2 visual instance token",
      );

      const wButton = page.locator('.n-deck-key[data-keylab-key="W"]');
      await wButton.click();
      const beforeClickNudge = await wButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      await page.click('.n-widget-keylab [data-nx="keylab-nudge"][data-keylab-dx="8"]');
      await page.waitForFunction(
        (left) => document.querySelector('.n-deck-key[data-keylab-key="W"]')?.style.left !== left,
        beforeClickNudge.left,
      );
      assert.equal(
        await wButton.evaluate((button) => button.style.top),
        beforeClickNudge.top,
        "click movement offers the same axis-safe alternative as dragging",
      );
      await wButton.focus();
      const beforeNudge = await wButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        (left) => document.querySelector('.n-deck-key[data-keylab-key="W"]')?.style.left !== left,
        beforeNudge.left,
      );
      const afterNudge = await page.locator('.n-deck-key[data-keylab-key="W"]').evaluate(
        (button) => ({ left: button.style.left, top: button.style.top }),
      );
      assert.notEqual(afterNudge.left, beforeNudge.left, "arrow keys nudge a focused deck token");
      assert.equal(afterNudge.top, beforeNudge.top, "a horizontal nudge leaves its row untouched");
      assert.ok(
        (await persistedWorkbench())?.positions?.["k:W"],
        "keyboard nudging persists W under its v2 visual instance token",
      );

      const dButton = page.locator('.n-deck-key[data-keylab-key="D"]');
      await dButton.focus();
      await page.keyboard.press("Delete");
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
      );
      await page.waitForFunction(() => {
        const active = document.activeElement;
        return Boolean(active?.matches(".n-widget-keylab .n-deck-key, .n-widget-keylab button"));
      });
      await page.waitForFunction(() =>
        document.querySelectorAll('.n-widget-kb .n-key[data-key="D"].extracted').length === 0);
      const focusAfterDelete = await page.evaluate(() => ({
        inWorkbench: Boolean(document.activeElement?.closest(".n-widget-keylab")),
        isControl: Boolean(document.activeElement?.matches(".n-deck-key, button")),
        key: document.activeElement?.getAttribute("data-keylab-key"),
      }));
      assert.equal(focusAfterDelete.inWorkbench, true, "Delete keeps keyboard focus in the workbench");
      assert.equal(focusAfterDelete.isControl, true, "focus lands on another usable control");
      assert.notEqual(focusAfterDelete.key, "D", "focus never points at the removed token");
      assert.equal(
        await page.locator('.n-widget-kb .n-key[data-key="D"].extracted').count(),
        0,
        "Delete returns the focused token to its source socket",
      );
      assert.deepEqual(
        (await readDeck()).keys.map((key) => key.key).sort(),
        ["A", "S", "W"],
      );
      assert.deepEqual(bindingPosts, [], "workbench gestures never post a binding or learner write");

      const saved = await persistedWorkbench();
      assert.equal(saved?.theme, "lunar-shell");
      assert.equal(saved?.open, true);
      assert.equal(saved?.sourceHidden, false);
      assert.equal(saved?.layoutMode, "free", "manual nudging persists a custom layout");
      assert.equal(saved?.renderMode, "keycap");
      assert.equal(saved?.capProfile, "sculpted");
      assert.deepEqual([...saved.selectedKeys].sort(), ["A", "S", "W"]);
      assert.ok(saved?.positions?.["k:A"]);
      assert.ok(saved?.positions?.["k:W"]);
      assert.equal(saved?.positions?.A, undefined, "new writes do not regress to legacy key ids");
      assert.equal(saved?.positions?.W, undefined, "new writes keep every position instance-scoped");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      const restoredDeck = await readDeck();
      assert.equal(restoredDeck.widgetCount, 1);
      assert.equal(restoredDeck.renderMode, "keycap");
      assert.equal(restoredDeck.layoutMode, "free");
      assert.equal(restoredDeck.keycapProfile, "sculpted");
      assert.deepEqual(restoredDeck.keys.map((key) => key.key).sort(), ["A", "S", "W"]);
      assert.deepEqual(
        restoredDeck.keys.find((key) => key.key === "W") && {
          left: restoredDeck.keys.find((key) => key.key === "W").left,
          top: restoredDeck.keys.find((key) => key.key === "W").top,
        },
        afterNudge,
        "the custom W position survives reload",
      );
      assert.deepEqual(
        restoredDeck.keys.find((key) => key.key === "A") && {
          left: restoredDeck.keys.find((key) => key.key === "A").left,
          top: restoredDeck.keys.find((key) => key.key === "A").top,
        },
        afterDragA,
        "the pointer-dragged A position survives reload",
      );
      assert.equal(await page.locator(".n-widget-kb .n-key.extracted").count(), 3);

      const beforeClose = restoredDeck.keys.map((key) => [key.key, key.left, key.top]);
      await page.locator('.n-widget-keylab [data-nx="kb-workbench"]').evaluate(
        (button) => button.click(),
      );
      await page.waitForFunction(() => !document.querySelector(".n-widget-keylab"));
      assert.equal(
        await page.locator(".n-widget-kb .n-key.extracted").count(),
        0,
        "closing the editor shows the complete physical keyboard again",
      );
      await page.locator('[data-nx="kb-workbench"]').evaluate((button) => button.click());
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
      );
      const reopened = await readDeck();
      assert.deepEqual(
        reopened.keys.map((key) => [key.key, key.left, key.top]),
        beforeClose,
        "closing and reopening retains the exact custom keyboard arrangement",
      );
      assert.equal(reopened.renderMode, "keycap");
      assert.equal(reopened.layoutMode, "free");
      assert.equal(reopened.keycapProfile, "sculpted");
      assert.deepEqual(bindingPosts, []);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      if (await encoderLane.count()) {
        await encoderLane.locator("button.n-dev").click().catch(() => {});
        await page.waitForFunction(() => Array.from(
          document.querySelectorAll(".n-encoder-form"),
        ).some((row) => row.textContent?.includes("Ultimarc I-PAC 4") &&
          row.querySelector("button.n-dev")?.classList.contains("on")), null, {
          timeout: 5_000,
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("one read-only simultaneous-input diagnostic serves keyboards and keyboard-mode encoders", async () => {
    const starts = [];
    const cancels = [];
    const forbiddenWrites = [];
    let releaseFirstStart = () => {};
    const firstStartGate = new Promise((resolve) => {
      releaseFirstStart = resolve;
    });
    let active = null;
    let generation = 9100;
    let failNextPoll = false;
    let loseNextStartResponse = false;
    let failNextCancel = false;
    let replaceOnNextCancel = null;
    const view = ({ state = "listening", selector = active?.selector ?? "", generation: run = active?.generation ?? 0 } = {}) => {
      const encoder = selector === PANEL_SELECTOR;
      const held = state === "listening" ? (encoder ? ["B"] : ["A", "S"]) : [];
      const seen = encoder ? ["B"] : ["A", "S"];
      return {
        ok: true,
        state,
        generation: run,
        selector,
        remaining_ms: state === "listening" ? 28_000 : 0,
        held,
        seen,
        peak: seen.length,
        events: seen.length * 2,
        dropped: 0,
        rollover_visibility: "unavailable",
        detail: state === "listening"
          ? "Listening to the exact selected source."
          : "The bounded input test was cancelled.",
        error: null,
      };
    };
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        if (request.method() !== "POST") return;
        const pathname = new URL(request.url()).pathname;
        if (/\/(?:bind)(?:\/|$)/.test(pathname) ||
            pathname === "/api/panel/program/apply" ||
            pathname === "/api/panel/restore/apply") {
          forbiddenWrites.push(pathname);
        }
      });
      await candidate.route("**/api/input-test/start", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        starts.push(body);
        active = { selector: body.selector, generation: ++generation };
        if (starts.length === 1) await firstStartGate;
        if (loseNextStartResponse) {
          loseNextStartResponse = false;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "null",
          });
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(view()),
        });
      });
      await candidate.route(/\/api\/input-test$/, (route) => {
        if (failNextPoll) {
          failNextPoll = false;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "null",
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(active ? view() : view({ state: "idle", selector: "", generation: 0 })),
        });
      });
      await candidate.route("**/api/input-test/cancel", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (failNextCancel) {
          failNextCancel = false;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "null",
          });
        }
        if (replaceOnNextCancel !== null) {
          active = {
            selector: active?.selector ?? body.selector ?? "",
            generation: replaceOnNextCancel,
          };
          replaceOnNextCancel = null;
        }
        cancels.push(body);
        if (active && body.generation !== active.generation) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(view()),
          });
        }
        const cancelled = view({ state: "cancelled" });
        active = null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(cancelled),
        });
      });
    });

    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await waitForSourceWidget(page, "Logitech G915");
      const keyboardOpen = page.locator('.n-meta [data-nx="input-test-open"]');
      await keyboardOpen.click();
      const dialog = page.locator("dialog.n-input-test-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.match(await dialog.locator("[data-input-test-source]").textContent(), /Logitech G915/i);
      assert.match(await dialog.locator(".n-input-test-intro").textContent(),
        /Release every control first.*does not infer NKRO/i);
      assert.equal(
        (await dialog.locator(".n-input-test-expected > span").textContent()).trim(),
        "Expected distinct host signals held together (optional)",
      );
      await dialog.locator("[data-input-test-expected]").fill("3");
      await dialog.locator('[data-input-test-action="start"]').evaluate((button) => {
        button.click();
        button.click();
      });
      for (let attempt = 0; starts.length === 0 && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      await page.waitForFunction(
        () => document.querySelector('dialog.n-input-test-dialog')?.getAttribute("aria-busy") === "true",
      );
      assert.equal(starts.length, 1,
        "double activation while startup is pending issues one observer request");
      assert.equal(
        await dialog.locator('[data-input-test-action="start"]').isDisabled(),
        true,
        "startup locks another activation without marking the whole listening run busy",
      );
      await dialog.locator('[data-input-test-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      releaseFirstStart();
      for (let attempt = 0; cancels.length === 0 && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.deepEqual(cancels, [{ generation: 9101 }],
        "a start response that arrives after close is cancelled by its exact generation");
      assert.equal(await keyboardOpen.evaluate((button) => document.activeElement === button), true,
        "closing during startup still returns focus to its source action");

      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      await dialog.locator("[data-input-test-expected]").fill("3");
      await dialog.locator('[data-input-test-action="start"]').click();
      await page.waitForFunction(() =>
        document.querySelector('[data-input-test-stat="peak"]')?.textContent === "2");
      assert.equal(await dialog.getAttribute("aria-busy"), "false",
        "live updates remain available to assistive technology while listening");
      assert.equal(starts.length, 2);
      assert.equal(starts[1].duration_ms, 30_000);
      assert.notEqual(starts[1].selector, PANEL_SELECTOR,
        "the ordinary-keyboard run keeps its exact keyboard selector");
      assert.deepEqual(
        await dialog.locator("[data-input-test-held] strong").allTextContents(),
        ["A", "S"],
      );
      assert.match(await dialog.locator("[data-input-test-evidence]").textContent(),
        /Rollover visibility: unavailable/i);
      failNextCancel = true;
      await dialog.locator('[data-input-test-action="stop"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "unknown");
      assert.equal(await dialog.locator('[data-input-test-action="stop"]').isVisible(), true,
        "an ambiguous cancel response keeps the same generation available for retry");
      assert.match(await dialog.locator("[data-input-test-detail-message]").textContent(),
        /could not confirm.*generation 9102 stopped.*Retry Stop or close/i);
      await dialog.locator('[data-input-test-action="stop"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "cancelled");
      for (let attempt = 0; cancels.length < 2 && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.deepEqual(cancels, [{ generation: 9101 }, { generation: 9102 }]);
      assert.match(await dialog.locator("[data-input-test-evidence]").textContent(),
        /observed 2 distinct host signals held together, below the expected 3/i);
      await dialog.locator('[data-input-test-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await keyboardOpen.evaluate((button) => document.activeElement === button), true,
        "closing returns focus to the exact source action that opened the diagnostic");

      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      failNextPoll = true;
      await dialog.locator('[data-input-test-action="start"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "unknown");
      assert.equal(
        await dialog.locator('[data-input-test-action="stop"]').isVisible(),
        true,
        "a lost poll keeps the daemon-owned generation visibly cancellable",
      );
      assert.match(await dialog.locator("[data-input-test-detail-message]").textContent(),
        /lost contact.*Stop the test or close this window.*HTTP 200/i);
      await dialog.locator('[data-input-test-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      for (let attempt = 0; cancels.length < 3 && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.deepEqual(cancels, [
        { generation: 9101 },
        { generation: 9102 },
        { generation: 9103 },
      ], "closing after a transient poll failure releases the exact live observer");

      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      loseNextStartResponse = true;
      await dialog.locator('[data-input-test-action="start"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "unknown");
      assert.match(await dialog.locator("[data-input-test-detail-message]").textContent(),
        /could not confirm the start response.*exact selected source.*generation 9104.*HTTP 200/i);
      assert.equal(await dialog.locator('[data-input-test-action="stop"]').isVisible(), true,
        "a lost start response recovers the matching daemon generation before offering cleanup");
      await dialog.locator('[data-input-test-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      for (let attempt = 0; cancels.length < 4 && attempt < 100; attempt += 1) {
        await page.waitForTimeout(10);
      }
      assert.deepEqual(cancels, [
        { generation: 9101 },
        { generation: 9102 },
        { generation: 9103 },
        { generation: 9104 },
      ], "closing after a lost start response releases the recovered exact generation");

      const keyboardSelector = starts[1].selector;
      active = { selector: keyboardSelector, generation: 9201 };
      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "listening");
      assert.equal(await dialog.locator('[data-input-test-action="stop"]').isVisible(), true,
        "a reopened tab adopts a live run only for its exact selected source");
      await dialog.locator('[data-input-test-action="stop"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "cancelled");
      await dialog.locator('[data-input-test-action="close"]').click();
      assert.deepEqual(cancels.at(-1), { generation: 9201 });

      active = { selector: PANEL_SELECTOR, generation: 9202 };
      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "unavailable");
      assert.match(await dialog.locator("[data-input-test-detail-message]").textContent(),
        /already listening.*select that exact source.*no cancellation authority/i);
      assert.equal(await dialog.locator('[data-input-test-action="start"]').isDisabled(), true,
        "a foreign live run is explained without offering a doomed second start");
      assert.equal(await dialog.locator('[data-input-test-action="stop"]').isVisible(), false,
        "a foreign generation is never exposed as cancellable");
      await dialog.locator('[data-input-test-action="close"]').click();
      assert.equal(cancels.some((entry) => entry.generation === 9202), false);

      active = { selector: keyboardSelector, generation: 9301 };
      await keyboardOpen.click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "listening");
      replaceOnNextCancel = 9302;
      await dialog.locator('[data-input-test-action="stop"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "unavailable");
      assert.match(await dialog.locator("[data-input-test-detail-message]").textContent(),
        /replaced before its cancellation completed.*newer run.*will not stop it/i);
      assert.equal(await dialog.locator('[data-input-test-action="stop"]').isVisible(), false,
        "a stale tab never gains cancellation authority for the replacement generation");
      const cancellationRequestsBeforeSecondClick = cancels.length;
      await dialog.locator('[data-input-test-action="stop"]').evaluate((button) => button.click());
      await page.waitForTimeout(100);
      assert.equal(cancels.length, cancellationRequestsBeforeSecondClick,
        "even a synthetic second activation cannot cancel the newer generation");
      await dialog.locator('[data-input-test-action="close"]').click();
      assert.equal(cancels.some((entry) => entry.generation === 9302), false);
      active = null;

      // ── THE ENCODER LEG IS GONE, 2026-08-26 ──────────────────────────────
      //
      // This test's second half opened the SAME diagnostic from the encoder's
      // own setup surface: it clicked `encoder-select-setup`, waited for
      // `.n-widget-surface[data-entry="encoder-setup"] .n-surface-terminal-editor`,
      // started a run pinned to the exact I-PAC, and read the terminal ledger
      // back — "P1 SW1 · normal", "P1 SW1 · shifted (stored; Shift inactive)".
      // Every one of those depends on a READ CHART. `3901990` took chart
      // reading out of ksx: `data-entry="encoder-setup"` is never set,
      // `.n-surface-terminal-editor` is never mounted, and there is no stored
      // normal/shifted layer to annotate. The leg could only ever time out.
      //
      // The DIAGNOSTIC itself is untouched and is what this test still proves:
      // one read-only run at a time, pinned to an exact source and generation,
      // adopted only by the tab that owns it, never cancellable by a stale tab,
      // and never a writer. An I-PAC in keyboard mode reaches it through the
      // same keyboard entry point as any other board — which the run above
      // exercises — so what is lost is the second DOOR, not the diagnostic.
      assert.deepEqual(cancels, [
        { generation: 9101 },
        { generation: 9102 },
        { generation: 9103 },
        { generation: 9104 },
        { generation: 9201 },
        { generation: 9301 },
      ], "every run this tab started, and only those, were released by it");
      assert.deepEqual(forbiddenWrites, [],
        "input diagnostics never bind a route or call a persistent hardware writer");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseFirstStart();
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      if (await encoderLane.count()) {
        await encoderLane.locator("button.n-dev").click().catch(() => {});
        await page.waitForFunction(() => Array.from(
          document.querySelectorAll(".n-encoder-form"),
        ).some((row) => row.textContent?.includes("Ultimarc I-PAC 4") &&
          row.querySelector("button.n-dev")?.classList.contains("on")), null, {
          timeout: 5_000,
        }).catch(() => {});
      }
      await page.close();
    }
  });

  test("a legacy player Workbench migrates once into a browser-persisted four-player surface", async () => {
    const identity = "keyboard:usb:d209:0430:00";
    const writes = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        if (request.method() !== "POST") return;
        const pathname = new URL(request.url()).pathname;
        if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) writes.push(pathname);
      });
      await candidate.addInitScript(({ expectedOrigin, keyboardIdentity }) => {
        if (location.origin !== expectedOrigin) return;
        const seeded = "ksx-pwtest-legacy-workbench-seeded";
        if (sessionStorage.getItem(seeded) === "1") return;
        localStorage.setItem("ksx-nocturne-keyboard-workbench1", JSON.stringify({
          version: 2,
          devices: {
            [keyboardIdentity]: {
              open: true,
              sourceHidden: false,
              theme: "carbon-forge",
              capProfile: "sculpted",
              selectedKeys: ["G"],
              layoutMode: "players",
              renderMode: "arcade",
              positions: {},
            },
          },
        }));
        localStorage.removeItem("ksx-nocturne-control-surfaces1");
        sessionStorage.setItem(seeded, "1");
      }, {
        expectedOrigin: new URL(BASE).origin,
        keyboardIdentity: identity,
      });
    });
    const readMigration = () => page.evaluate((keyboardIdentity) => {
      const surfaceStore = JSON.parse(
        localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
      );
      const workbenchStore = JSON.parse(
        localStorage.getItem("ksx-nocturne-keyboard-workbench1") ?? "null",
      );
      const surface = surfaceStore?.devices?.[keyboardIdentity] ?? null;
      const arranger = workbenchStore?.devices?.[keyboardIdentity] ?? null;
      const deck = document.querySelector(".n-widget-surface .n-surface-deck");
      const controls = Array.from(
        document.querySelectorAll(".n-widget-surface .n-surface-control"),
      ).map((control) => ({
        id: control.getAttribute("data-surface-control-id"),
        physicalId: control.getAttribute("data-physical-id"),
        playerSlot: control.getAttribute("data-player-slot"),
        mirror: control.classList.contains("mirror"),
        keys: Array.from(control.querySelectorAll(".n-surface-channel-anchor[data-key]"))
          .map((anchor) => anchor.getAttribute("data-key")),
      })).sort((left, right) => Number(left.playerSlot) - Number(right.playerSlot));
      return {
        surfaceWidgetCount: document.querySelectorAll(".n-widget-surface").length,
        surfaceDeviceCount: Object.keys(surfaceStore?.devices ?? {}).length,
        template: surface?.template ?? null,
        panelLayout: surface?.panelLayout ?? null,
        deckTemplate: deck?.getAttribute("data-template") ?? null,
        deckPanelLayout: deck?.getAttribute("data-panel-layout") ?? null,
        marker: surfaceStore?.migratedWorkbench?.[keyboardIdentity] ?? false,
        controls,
        storedControls: (surface?.controls ?? []).map((control) => ({
          id: control.id,
          physicalId: control.physicalId,
          physicalResolution: control.physicalResolution,
          origin: control.origin,
          playerSlot: control.playerSlot,
          keys: (control.channels ?? []).map((channel) => channel.input?.key ?? ""),
        })).sort((left, right) => Number(left.playerSlot) - Number(right.playerSlot)),
        arranger: arranger && {
          open: arranger.open,
          selectedKeys: arranger.selectedKeys,
          layoutMode: arranger.layoutMode,
          renderMode: arranger.renderMode,
        },
        arrangerDeck: {
          count: document.querySelectorAll(
            '.n-widget-keylab .n-deck-key[data-keylab-key="G"]',
          ).length,
          layoutMode: document.querySelector(".n-widget-keylab .n-keylab-deck")
            ?.getAttribute("data-layout-mode") ?? null,
          renderMode: document.querySelector(".n-widget-keylab .n-keylab-deck")
            ?.getAttribute("data-render-mode") ?? null,
        },
      };
    }, identity);

    try {
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-surface .n-surface-control").length === 2,
        null,
        { timeout: 20_000 },
      );
      const migrated = await readMigration();
      assert.equal(migrated.surfaceWidgetCount, 1, "migration mounts one sibling surface builder");
      assert.equal(migrated.surfaceDeviceCount, 1, "migration writes one device-scoped surface");
      assert.equal(migrated.template, "workbench-migration");
      assert.equal(migrated.deckTemplate, "workbench-migration");
      assert.equal(migrated.panelLayout, "four-player");
      assert.equal(
        migrated.deckPanelLayout,
        "four-player",
        "the panel keeps its four-player structure independently of its migration origin",
      );
      assert.equal(migrated.marker, true, "the one-way migration marker is browser-persisted");
      assert.deepEqual(
        migrated.controls.map(({ physicalId, playerSlot, mirror, keys }) => ({
          physicalId,
          playerSlot,
          mirror,
          keys,
        })),
        [
          { physicalId: "key:G", playerSlot: "1", mirror: true, keys: ["G"] },
          { physicalId: "key:G", playerSlot: "2", mirror: true, keys: ["G"] },
        ],
        "the two player views visibly remain linked to the same taught G switch",
      );
      assert.deepEqual(
        migrated.storedControls.map((control) => ({
          physicalId: control.physicalId,
          physicalResolution: control.physicalResolution,
          origin: control.origin,
          playerSlot: control.playerSlot,
          keys: control.keys,
        })),
        [
          {
            physicalId: "key:G",
            physicalResolution: "confirmed",
            origin: "workbench-migration",
            playerSlot: 1,
            keys: ["G"],
          },
          {
            physicalId: "key:G",
            physicalResolution: "confirmed",
            origin: "workbench-migration",
            playerSlot: 2,
            keys: ["G"],
          },
        ],
        "Workbench player views migrate as confirmed mirrors, not inferred shared signals",
      );
      assert.deepEqual(migrated.arranger, {
        open: true,
        selectedKeys: ["G"],
        layoutMode: "compact",
        renderMode: "keycap",
      });
      assert.deepEqual(migrated.arrangerDeck, {
        count: 0,
        layoutMode: null,
        renderMode: null,
      });
      assert.deepEqual(writes, [], "migration never binds or starts a learner");

      const firstIds = migrated.storedControls.map((control) => control.id);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-surface .n-surface-control").length === 2,
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      const restored = await readMigration();
      assert.equal(restored.surfaceWidgetCount, 1, "reload cannot mount a second surface builder");
      assert.equal(restored.surfaceDeviceCount, 1, "reload cannot duplicate the migrated document");
      assert.equal(restored.marker, true);
      assert.equal(restored.panelLayout, "four-player");
      assert.equal(restored.deckPanelLayout, "four-player");
      assert.deepEqual(
        restored.storedControls.map((control) => control.id),
        firstIds,
        "the migration marker restores the same two visual instances instead of migrating again",
      );
      assert.deepEqual(restored.arranger, migrated.arranger);
      assert.deepEqual(writes, [], "restoring a migrated surface remains read-only");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a failed surface migration preserves the complete legacy Workbench", async () => {
    const identity = "keyboard:usb:d209:0430:00";
    const writes = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        if (request.method() !== "POST") return;
        const pathname = new URL(request.url()).pathname;
        if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) writes.push(pathname);
      });
      await candidate.addInitScript(({ expectedOrigin, keyboardIdentity }) => {
        if (location.origin !== expectedOrigin) return;
        const surfaceKey = "ksx-nocturne-control-surfaces1";
        const originalSetItem = Storage.prototype.setItem;
        if (sessionStorage.getItem("ksx-pwtest-failed-surface-migration") !== "1") {
          originalSetItem.call(localStorage, "ksx-nocturne-keyboard-workbench1", JSON.stringify({
            version: 2,
            devices: {
              [keyboardIdentity]: {
                open: true,
                sourceHidden: false,
                theme: "carbon-forge",
                capProfile: "sculpted",
                selectedKeys: ["G"],
                layoutMode: "players",
                renderMode: "arcade",
                positions: {},
              },
            },
          }));
          localStorage.removeItem(surfaceKey);
          originalSetItem.call(sessionStorage, "ksx-pwtest-failed-surface-migration", "1");
        }
        Storage.prototype.setItem = function setItem(key, value) {
          if (this === localStorage && key === surfaceKey) {
            throw new DOMException("Storage unavailable", "QuotaExceededError");
          }
          return originalSetItem.call(this, key, value);
        };
      }, {
        expectedOrigin: new URL(BASE).origin,
        keyboardIdentity: identity,
      });
    });
    const readFailure = () => page.evaluate((keyboardIdentity) => {
      const workbench = JSON.parse(
        localStorage.getItem("ksx-nocturne-keyboard-workbench1") ?? "null",
      )?.devices?.[keyboardIdentity] ?? null;
      return {
        storedSurface: localStorage.getItem("ksx-nocturne-control-surfaces1"),
        workbench,
        surfaceControls: document.querySelectorAll(".n-widget-surface .n-surface-control").length,
        status: document.querySelector(".n-widget-surface .n-surface-status")?.textContent ?? "",
        arrangerLayout: document.querySelector(".n-widget-keylab .n-keylab-deck")
          ?.getAttribute("data-layout-mode") ?? null,
        arrangerRender: document.querySelector(".n-widget-keylab .n-keylab-deck")
          ?.getAttribute("data-render-mode") ?? null,
      };
    }, identity);

    try {
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-surface .n-surface-control").length === 2,
      );
      let failure = await readFailure();
      assert.equal(failure.storedSurface, null, "no migration marker is claimed after a failed write");
      assert.deepEqual(failure.workbench, {
        open: true,
        sourceHidden: false,
        theme: "carbon-forge",
        capProfile: "sculpted",
        selectedKeys: ["G"],
        layoutMode: "players",
        renderMode: "arcade",
        positions: {},
      });
      assert.equal(failure.surfaceControls, 2, "the session-only copy remains usable");
      assert.match(failure.status, /Not saved: browser storage is unavailable/i);
      assert.equal(failure.arrangerLayout, null,
        "the legacy arranger stays persisted but is not mounted over an I-PAC signal source");
      assert.equal(failure.arrangerRender, null);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-surface .n-surface-control").length === 2,
      );
      await settle(page);
      failure = await readFailure();
      assert.equal(failure.storedSurface, null, "reload retries instead of trusting a false marker");
      assert.equal(failure.workbench.layoutMode, "players");
      assert.equal(failure.workbench.renderMode, "arcade");
      assert.match(failure.status, /Not saved/i);
      assert.deepEqual(writes, [], "failed migration remains a visual, read-only operation");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("legacy v1 and v2 Control Surface documents migrate to v3 without reviving hardware authority", async () => {
    await restoreFixturePanelSource();
    const identity = "keyboard:usb:d209:0430:00";
    const exactDevice = "HID\\VID_D209&PID_0430\\FIXTURE";
    const otherDevice = "HID\\VID_046D&PID_C545\\LEGACY-KEYBOARD";
    const exactBoard = PANEL_FINGERPRINT.toLocaleUpperCase();
    const storageKey = "ksx-nocturne-control-surfaces1";
    const scenarios = [
      {
        label: "v1",
        epoch: "pwtest-v1-hardware-epoch",
        phase: "pending",
        document: {
          version: 1,
          devices: {
            [identity]: {
              open: true,
              started: true,
              name: "Legacy four-player geometry",
              template: "custom",
              stage: "route",
              theme: "violet-circuit",
              controls: [
                {
                  id: "c41",
                  physicalId: "legacy:shared-g",
                  kind: "button30",
                  label: "P1 Guard",
                  playerSlot: 1,
                  origin: "mapping-generated",
                  x: 137.125,
                  y: 209.875,
                  width: 74,
                  height: 74,
                  channels: [{
                    id: "press",
                    label: "Press",
                    input: { kind: "keyboard", key: "G", device: otherDevice },
                  }],
                },
                {
                  id: "c42",
                  physicalId: "legacy:shared-g",
                  kind: "button30",
                  label: "P2 Guard",
                  playerSlot: 2,
                  origin: "mapping-generated",
                  x: 843.5,
                  y: 219.25,
                  width: 74,
                  height: 74,
                  channels: [{
                    id: "press",
                    label: "Press",
                    input: { kind: "keyboard", key: "G", device: otherDevice },
                  }],
                },
                {
                  id: "c43",
                  physicalId: "cabinet-service",
                  kind: "keycap",
                  label: "Service",
                  playerSlot: null,
                  origin: "manual",
                  x: 560.75,
                  y: 511.125,
                  width: 88,
                  height: 64,
                  channels: [{
                    id: "press",
                    label: "Service key",
                    input: { kind: "keyboard", key: "Escape", device: exactDevice },
                  }],
                },
              ],
              selectedControlId: "c43",
              selectedChannelId: "press",
              nextId: 44,
            },
          },
          migratedWorkbench: { [identity]: true },
        },
      },
      {
        label: "v2",
        epoch: "pwtest-v2-hardware-epoch",
        phase: "settled",
        document: {
          version: 2,
          devices: {
            [identity]: {
              open: true,
              started: true,
              name: "Legacy encoder joystick",
              template: "custom",
              panelLayout: "single",
              stage: "teach",
              theme: "glacier-current",
              controls: [{
                id: "c9",
                physicalId: "physical:flight-stick",
                physicalResolution: "confirmed",
                kind: "joystick",
                label: "P3 Stick",
                playerSlot: 3,
                origin: "manual",
                x: 303.375,
                y: 271.625,
                width: 168,
                height: 168,
                channels: [
                  {
                    id: "up",
                    label: "Up",
                    input: { kind: "keyboard", key: "W", device: exactDevice },
                    encoder: {
                      driver: PANEL_PROTOCOL_PROFILE,
                      boardFingerprint: PANEL_FINGERPRINT,
                      terminalId: "3up",
                      terminalLabel: "P3 Up",
                      expectedKey: "W",
                      verification: "matched",
                    },
                  },
                  {
                    id: "right",
                    label: "Right",
                    input: { kind: "keyboard", key: "D", device: exactDevice },
                  },
                  {
                    id: "down",
                    label: "Down",
                    input: { kind: "keyboard", key: "S", device: otherDevice },
                    encoder: {
                      driver: "other-driver",
                      boardFingerprint: "other-fixture-board",
                      terminalId: "aux-down",
                      terminalLabel: "Other Down",
                      expectedKey: "S",
                      verification: "matched",
                    },
                  },
                  {
                    id: "left",
                    label: "Left",
                    input: { kind: "unassigned", key: "", device: "" },
                  },
                ],
                selected: true,
              }],
              selectedControlId: "c9",
              selectedChannelId: "right",
              nextId: 10,
            },
          },
          migratedWorkbench: {},
        },
      },
    ];

    const readSnapshot = (page) => page.evaluate(({ key, keyboardIdentity, device }) => {
      const store = JSON.parse(localStorage.getItem(key) ?? "null");
      const surface = store?.devices?.[keyboardIdentity] ?? null;
      const deck = document.querySelector(".n-widget-surface .n-surface-deck");
      const renderedControls = Array.from(
        document.querySelectorAll(".n-widget-surface .n-surface-control"),
      ).map((control) => ({
        id: control.getAttribute("data-surface-control-id"),
        physicalId: control.getAttribute("data-physical-id"),
        kind: control.getAttribute("data-control-kind"),
        playerSlot: control.getAttribute("data-player-slot"),
        sharedSignal: control.classList.contains("shared-signal"),
        geometry: [control.style.left, control.style.top, control.style.width, control.style.height],
        channels: Array.from(control.querySelectorAll(".n-surface-signal-chain")).map((channel) => {
          const keycap = channel.querySelector(".n-surface-signal-keycap");
          return {
            id: channel.getAttribute("data-surface-channel-id"),
            authoritativeKey: keycap?.getAttribute("data-key") ?? null,
          };
        }),
      }));
      return {
        store,
        version: store?.version ?? null,
        identities: Object.keys(store?.devices ?? {}),
        migratedWorkbench: store?.migratedWorkbench?.[keyboardIdentity] === true,
        hardwareEpoch: store?.hardwareEpochs?.[device] ?? null,
        surface,
        rendered: {
          template: deck?.getAttribute("data-template") ?? null,
          panelLayout: deck?.getAttribute("data-panel-layout") ?? null,
          stage: deck?.getAttribute("data-stage") ?? null,
          theme: document.querySelector(".n-widget-surface")
            ?.getAttribute("data-keyboard-theme") ?? null,
          controls: renderedControls,
        },
      };
    }, { key: storageKey, keyboardIdentity: identity, device: exactDevice.toLocaleUpperCase() });

    for (const scenario of scenarios) {
      const writes = [];
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        colorScheme: "dark",
      });
      let page = null;
      try {
        page = await openCanvasInContext(context, async (candidate) => {
          candidate.on("request", (request) => {
            if (request.method() !== "POST") return;
            const pathname = new URL(request.url()).pathname;
            if (/\/(?:bind|learn)(?:\/|$)/.test(pathname) ||
                pathname === "/api/panel/program/apply" ||
                pathname === "/api/panel/restore/apply") {
              writes.push(`${request.method()} ${pathname}`);
            }
          });
          await candidate.addInitScript((seed) => {
            if (location.origin !== seed.expectedOrigin) return;
            const marker = `ksx-pwtest-${seed.label}-surface-migration`;
            if (sessionStorage.getItem(marker) === "1") return;
            localStorage.setItem(seed.storageKey, JSON.stringify(seed.document));
            localStorage.setItem(seed.epochKey, JSON.stringify({
              version: 2,
              device: seed.exactDevice,
              epoch: seed.epoch,
              boardFingerprint: seed.exactBoard,
              selector: seed.selector,
              phase: seed.phase,
            }));
            sessionStorage.setItem(marker, "1");
          }, {
            expectedOrigin: new URL(BASE).origin,
            label: scenario.label,
            storageKey,
            document: scenario.document,
            epochKey: `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(
              exactDevice.toLocaleUpperCase(),
            )}`,
            exactDevice: exactDevice.toLocaleUpperCase(),
            exactBoard,
            selector: PANEL_SELECTOR.toLocaleUpperCase(),
            epoch: scenario.epoch,
            phase: scenario.phase,
          });
        });
        await page.waitForFunction(({ key, keyboardIdentity, device, epoch, count }) => {
          try {
            const store = JSON.parse(localStorage.getItem(key) ?? "null");
            // No `hardwareEpochs` check: the epoch ledger was chart authority,
            // and chart authority left for PacBench. The DOCUMENT migration is
            // ksx's and is what this test is about.
            return store?.version === 3 &&
              store?.devices?.[keyboardIdentity]?.controls?.length === count &&
              document.querySelectorAll(".n-widget-surface .n-surface-control").length === count;
          } catch {
            return false;
          }
        }, {
          key: storageKey,
          keyboardIdentity: identity,
          device: exactDevice.toLocaleUpperCase(),
          epoch: scenario.epoch,
          count: scenario.label === "v1" ? 3 : 1,
        }, { timeout: 20_000 });

        const migrated = await readSnapshot(page);
        assert.equal(migrated.version, 3, `${scenario.label} is durably rewritten as v3`);
        assert.deepEqual(migrated.identities, [identity],
          `${scenario.label} keeps its device-scoped document`);
        // "without reviving hardware authority" is the title, and this is it:
        // migration must NOT bring a hardware epoch back with the document.
        // Nothing in ksx publishes one any more — the chart read that did is
        // PacBench's — so a migration that resurrected it would be reviving a
        // claim this product can no longer stand behind.
        assert.equal(migrated.hardwareEpoch, null,
          `${scenario.label} does not revive hardware authority`);
        assert.equal(migrated.surface.open, true);
        assert.equal(migrated.surface.started, true);
        assert.equal(migrated.rendered.template, "custom");
        assert.equal(migrated.rendered.theme, migrated.surface.theme);
        assert.equal(migrated.rendered.controls.length, migrated.surface.controls.length);

        if (scenario.label === "v1") {
          assert.equal(migrated.migratedWorkbench, true,
            "the v1 one-way Workbench marker survives migration");
          assert.equal(migrated.surface.panelLayout, "four-player",
            "v1 infers the durable panel shape from its surviving player controls");
          assert.equal(migrated.rendered.panelLayout, "four-player");
          assert.equal(migrated.surface.stage, "route");
          assert.equal(migrated.rendered.stage, "route");
          assert.equal(migrated.surface.nextId, 44);
          assert.deepEqual(
            migrated.surface.controls.map((control) => ({
              id: control.id,
              physicalId: control.physicalId,
              physicalResolution: control.physicalResolution,
              kind: control.kind,
              label: control.label,
              playerSlot: control.playerSlot,
              origin: control.origin,
              geometry: [control.x, control.y, control.width, control.height],
              input: control.channels[0].input,
            })),
            [
              {
                id: "c41",
                physicalId: "physical:c41",
                physicalResolution: "unresolved-shared-signal",
                kind: "button30",
                label: "P1 Guard",
                playerSlot: 1,
                origin: "mapping-generated",
                geometry: [137.125, 209.875, 74, 74],
                input: { kind: "keyboard", key: "G", device: otherDevice },
              },
              {
                id: "c42",
                physicalId: "physical:c42",
                physicalResolution: "unresolved-shared-signal",
                kind: "button30",
                label: "P2 Guard",
                playerSlot: 2,
                origin: "mapping-generated",
                geometry: [843.5, 219.25, 74, 74],
                input: { kind: "keyboard", key: "G", device: otherDevice },
              },
              {
                id: "c43",
                physicalId: "cabinet-service",
                physicalResolution: "confirmed",
                kind: "keycap",
                label: "Service",
                playerSlot: null,
                origin: "manual",
                geometry: [560.75, 511.125, 88, 64],
                input: { kind: "unassigned", key: "", device: "" },
              },
            ],
            "v1 preserves geometry and control meaning while retiring only its stale exact-device observation",
          );
          assert.deepEqual(
            migrated.rendered.controls.map((control) => ({
              id: control.id,
              physicalId: control.physicalId,
              sharedSignal: control.sharedSignal,
            })),
            [
              { id: "c41", physicalId: "physical:c41", sharedSignal: true },
              { id: "c42", physicalId: "physical:c42", sharedSignal: true },
              { id: "c43", physicalId: "cabinet-service", sharedSignal: false },
            ],
            "the migrated v1 physical relationships reach the rendered panel",
          );
          assert.equal(
            migrated.rendered.controls.find((control) => control.id === "c43")
              ?.channels[0]?.authoritativeKey,
            null,
            "the v1 exact-device key cannot remain route authority after the pending epoch",
          );
        } else {
          assert.equal(migrated.migratedWorkbench, false);
          assert.equal(migrated.surface.panelLayout, "single",
            "v2 keeps its explicit panel shape even with a P3-owned component");
          assert.equal(migrated.rendered.panelLayout, "single");
          assert.equal(migrated.surface.stage, "teach");
          assert.equal(migrated.rendered.stage, "teach");
          assert.equal(migrated.surface.selectedControlId, "c9");
          assert.equal(migrated.surface.selectedChannelId, "right");
          assert.equal(migrated.surface.nextId, 10);
          const control = migrated.surface.controls[0];
          assert.deepEqual({
            id: control.id,
            physicalId: control.physicalId,
            physicalResolution: control.physicalResolution,
            kind: control.kind,
            label: control.label,
            playerSlot: control.playerSlot,
            origin: control.origin,
            geometry: [control.x, control.y, control.width, control.height],
          }, {
            id: "c9",
            physicalId: "physical:flight-stick",
            physicalResolution: "confirmed",
            kind: "joystick",
            label: "P3 Stick",
            playerSlot: 3,
            origin: "manual",
            geometry: [303.375, 271.625, 168, 168],
          }, "v2 preserves its joystick identity and exact geometry");
          assert.deepEqual(
            control.channels.map((channel) => ({
              id: channel.id,
              label: channel.label,
              input: channel.input,
              encoder: channel.encoder ?? null,
            })),
            [
              {
                id: "up",
                label: "Up",
                input: { kind: "keyboard", key: "W", device: exactDevice },
                encoder: {
                  driver: PANEL_PROTOCOL_PROFILE,
                  boardFingerprint: PANEL_FINGERPRINT,
                  terminalId: "3up",
                  terminalLabel: "P3 Up",
                  expectedKey: "W",
                  verification: "unverified",
                },
              },
              {
                id: "right",
                label: "Right",
                input: { kind: "unassigned", key: "", device: "" },
                encoder: null,
              },
              {
                id: "down",
                label: "Down",
                input: { kind: "keyboard", key: "S", device: otherDevice },
                encoder: {
                  driver: "other-driver",
                  boardFingerprint: "other-fixture-board",
                  terminalId: "aux-down",
                  terminalLabel: "Other Down",
                  expectedKey: "S",
                  verification: "matched",
                },
              },
              {
                id: "left",
                label: "Left",
                input: { kind: "unassigned", key: "", device: "" },
                encoder: null,
              },
            ],
            "v2 keeps channel order and metadata, retires exact-board verification, clears only the unlinked exact-device key, and leaves unrelated hardware alone",
          );
          assert.deepEqual(
            migrated.rendered.controls[0].channels.map((channel) => ({
              id: channel.id,
              authoritativeKey: channel.authoritativeKey,
            })),
            [
              { id: "up", authoritativeKey: null },
              { id: "right", authoritativeKey: null },
              { id: "down", authoritativeKey: null },
              { id: "left", authoritativeKey: null },
            ],
            "the rendered v2 panel exposes no route authority before this selected encoder is read again",
          );
        }

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(({ count }) =>
          document.querySelectorAll(".n-widget-surface .n-surface-control").length === count,
        { count: scenario.label === "v1" ? 3 : 1 }, { timeout: 20_000 });
        await settle(page);
        const restored = await readSnapshot(page);
        assert.deepEqual(restored.store, migrated.store,
          `${scenario.label} reloads the v3 document without resurrecting retired authority`);
        assert.deepEqual(restored.rendered, migrated.rendered,
          `${scenario.label} reload renders the same geometry and channel authority`);
        assert.deepEqual(writes, [],
          `${scenario.label} migration and reload never map a key or write panel hardware`);
        assert.deepEqual(page.ksxNoise, []);
      } finally {
        await context.close();
      }
    }
  });

  // THE THIRD STATE OF THE DEVICE AUTHORITY RULE, which the migration test
  // above cannot reach: both devices it names are recognised (an I-PAC that
  // ksx serves as `panel-encoder`, a G915 it serves as `keyboard`), so between
  // them they exercise only the retire arm and the vouch arm.
  //
  // The arm tested here is the one the owner called load-bearing: a device ksx
  // knows NOTHING about. Retiring its bindings would destroy a user's work on
  // a hunch, and keeping them silently would assert an answer for a read that
  // never happened. The only honest outcome is to keep the observation, which
  // still splits keys exactly as before, and to say on the control itself that
  // nothing stands behind it.
  test("a swept claim on a device ksx cannot recognise is kept and marked, never retired", async () => {
    await restoreFixturePanelSource();
    const identity = "keyboard:usb:d209:0430:00";
    // Served in the roster as `keyboard` (Logitech G915 TKL, usb:046d:c545:00).
    const recognised = "HID\\VID_046D&PID_C545\\LEGACY-KEYBOARD";
    // In none of the three served lists: no row anywhere carries this model.
    const unrecognised = "HID\\VID_FEED&PID_BEEF\\NO-SUCH-BOARD";
    const storageKey = "ksx-nocturne-control-surfaces1";
    const legacy = {
      version: 1,
      devices: {
        [identity]: {
          open: true,
          started: true,
          name: "Mixed-provenance panel",
          template: "custom",
          stage: "route",
          theme: "carbon-forge",
          controls: [
            {
              id: "c1",
              physicalId: "cabinet-known",
              kind: "keycap",
              label: "Known",
              playerSlot: null,
              origin: "manual",
              x: 200,
              y: 200,
              width: 88,
              height: 64,
              channels: [{
                id: "press",
                label: "Press",
                input: { kind: "keyboard", key: "K", device: recognised },
              }],
            },
            {
              id: "c2",
              physicalId: "cabinet-stranger",
              kind: "keycap",
              label: "Stranger",
              playerSlot: null,
              origin: "manual",
              x: 400,
              y: 200,
              width: 88,
              height: 64,
              channels: [{
                id: "press",
                label: "Press",
                input: { kind: "keyboard", key: "L", device: unrecognised },
              }],
            },
          ],
          selectedControlId: "c1",
          selectedChannelId: "press",
          nextId: 3,
        },
      },
      migratedWorkbench: {},
    };

    const page = await openCanvas({}, async (candidate) => {
      await candidate.addInitScript((seed) => {
        if (location.origin !== seed.expectedOrigin) return;
        localStorage.setItem(seed.storageKey, JSON.stringify(seed.document));
      }, { expectedOrigin: new URL(BASE).origin, storageKey, document: legacy });
    });
    try {
      await page.waitForFunction(({ key, keyboardIdentity }) => {
        try {
          const store = JSON.parse(localStorage.getItem(key) ?? "null");
          return store?.version === 3 &&
            store?.devices?.[keyboardIdentity]?.controls?.length === 2 &&
            document.querySelectorAll(".n-widget-surface .n-surface-control").length === 2;
        } catch {
          return false;
        }
      }, { key: storageKey, keyboardIdentity: identity }, { timeout: 20_000 });

      const swept = await page.evaluate(({ key, keyboardIdentity }) => {
        const surface = JSON.parse(localStorage.getItem(key) ?? "null")
          ?.devices?.[keyboardIdentity] ?? null;
        const controls = Array.from(
          document.querySelectorAll(".n-widget-surface .n-surface-control"),
        );
        return {
          stored: (surface?.controls ?? []).map((control) => ({
            id: control.id,
            input: control.channels[0].input,
            unverified: control.channels[0].deviceUnverified ?? false,
          })),
          markedChains: document.querySelectorAll(
            ".n-widget-surface .n-surface-signal-chain[data-device-unverified]",
          ).length,
          badges: controls.map((control) =>
            control.querySelector(".n-surface-signal-keycap small")?.textContent ?? ""),
          labels: controls.map((control) => control.getAttribute("aria-label") ?? ""),
        };
      }, { key: storageKey, keyboardIdentity: identity });

      assert.deepEqual(swept.stored, [
        {
          id: "c1",
          input: { kind: "keyboard", key: "K", device: recognised },
          unverified: false,
        },
        {
          id: "c2",
          input: { kind: "keyboard", key: "L", device: unrecognised },
          unverified: true,
        },
      ], "a keyboard's fixed output is vouched for; an unknown device's is kept unvouched");
      assert.equal(swept.markedChains, 1,
        "exactly the unrecognised channel carries the machine-readable mark");
      assert.deepEqual(swept.badges, ["LIVE", "LIVE?"],
        "the kept-but-unvouched key wears the panel's own not-verified badge, on screen");
      assert.doesNotMatch(swept.labels[0], /does not recognise/i,
        "a recognised keyboard is not hedged");
      assert.match(swept.labels[1], /does not recognise the device/i,
        "the kept-but-unvouched claim says so in its own accessible name");

      // ...and the mark has to be able to GO. A Teach is ksx watching the key
      // arrive through its own capture path, right now: it replaces the very
      // sentence the sweep could not stand behind, so a panel still hedging it
      // afterwards would be describing a read that has since happened.
      let generation = 700;
      let hitReady = false;
      let learnStarted;
      const selectedInput = await page.evaluate(() => {
        const view = JSON.parse(
          document.getElementById("__ksx-payload")?.textContent ?? "{}",
        ).view ?? {};
        return { selector: view.cap_selector ?? "", instance: view.cap_instance ?? "" };
      });
      assert.ok(selectedInput.instance, "the fixture serves the selected input's exact device");
      await page.route("**/api/learn/start", async (route) => {
        generation += 1;
        hitReady = false;
        learnStarted?.();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation,
            remaining_ms: 10_000,
            device: null,
            key: null,
            error: null,
          }),
        });
      });
      await page.route("**/api/learn", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: hitReady ? "hit" : "listening",
            generation,
            remaining_ms: hitReady ? null : 10_000,
            device: hitReady ? selectedInput.instance : null,
            selector: hitReady ? selectedInput.selector : null,
            key: hitReady ? "M" : null,
            error: null,
          }),
        });
      });
      const started = new Promise((resolve) => {
        learnStarted = resolve;
      });
      await page.locator(
        '.n-widget-surface .n-surface-control[data-surface-control-id="c2"]',
      ).evaluate((control) => control.click());
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').evaluate(
        (button) => button.click(),
      );
      await started;
      hitReady = true;
      await page.waitForFunction(() =>
        document.querySelector(
          '.n-widget-surface .n-surface-control[data-surface-control-id="c2"] .n-surface-channel-anchor',
        )?.getAttribute("data-key") === "M");

      const taught = await page.evaluate(({ key, keyboardIdentity }) => {
        const surface = JSON.parse(localStorage.getItem(key) ?? "null")
          ?.devices?.[keyboardIdentity] ?? null;
        const stranger = (surface?.controls ?? []).find((control) => control.id === "c2");
        const rendered = document.querySelector(
          '.n-widget-surface .n-surface-control[data-surface-control-id="c2"]',
        );
        return {
          key: stranger?.channels[0].input.key ?? "",
          unverified: stranger?.channels[0].deviceUnverified ?? false,
          markedChains: document.querySelectorAll(
            ".n-widget-surface .n-surface-signal-chain[data-device-unverified]",
          ).length,
          badge: rendered?.querySelector(".n-surface-signal-keycap small")?.textContent ?? "",
          label: rendered?.getAttribute("aria-label") ?? "",
        };
      }, { key: storageKey, keyboardIdentity: identity });
      assert.equal(taught.key, "M", "the live observation is what the channel now claims");
      assert.equal(taught.unverified, false,
        "a Teach clears the mark it just made obsolete, durably");
      assert.equal(taught.markedChains, 0);
      assert.equal(taught.badge, "LIVE", "and stops hedging it on screen");
      assert.doesNotMatch(taught.label, /does not recognise/i);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  // ── DELETED 2026-08-26: the ten encoder-chart tests ─────────────────────
  //
  // `3901990` ("cut ksx over to /nocturne — remove the encoder chart surface")
  // moved chart access out of ksx entirely — into PacBench. Ten Studio routes,
  // the clap `panel` verb tree, panelProgramming.ts and ~6,400 lines of
  // NocturneIsland.ts went with it. What it left behind is a SHELL:
  // `.n-surface-hardware` is still built, but nothing ever moves it off
  // `data-state="idle"`; `data-capability`, `data-qualification` and
  // `data-entry="encoder-setup"` exist nowhere in the client; and no code
  // requests `/api/panel/*`, so every `page.route()` mock for those paths was
  // inert and every wait on that surface ran to its 30 s deadline. That is
  // what made this suite look like ten silent hangs rather than ten failures.
  //
  // The ten removed here had the chart workflow as their whole SUBJECT, not as
  // scenery: reading a board, planning a write, applying one, taking a backup,
  // restoring from one, and recovering a crashed writer. None of those verbs
  // exist in this product any more, on either side of the wire, so there is
  // nothing left for a contract to hold.
  //
  //   an occupied I-PAC configuration interface explains WinIPAC and retries…
  //   I-PAC hardware outputs treat unused terminals as an intentional partial chart
  //   Encoder setup keeps three workflow stages and closes the persisted Teach…
  //   a crashed writer's pending epoch settles only with the backend's exact…
  //   a replacement encoder closes a write review queued on the previous device
  //   Encoder setup binds completed and interrupted results to the encoder…
  //   passive recovery retries transient status failures and then restores sources
  //   Encoder setup qualifies the writer with one reversible terminal before…
  //   an exact encoder profile stays blocked until its live mode and configuration…
  //   a readable encoder chart generates an honest physical panel before Teach…
  //
  // ⚠️ WHAT DID NOT GO: an I-PAC is still recognised, named, claimed and split
  // exactly as before, and every test of THAT is still here. The
  // `panelChartPayload` / `panelStatusPayload` helpers above stay too — the
  // surviving device tests use them to shape a realistic encoder ROW.

test("Control Surface starters create physical hardware without writing mappings", async () => {
    const page = await openCanvas();
    const writes = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) writes.push(pathname);
    });
    const choose = async (slug, replacing = true) => {
      if (replacing) await page.click('.n-widget-surface [data-nx="surface-new"]');
      const card = page.locator(
        `.n-widget-surface [data-surface-template="${slug}"]`,
      );
      await card.click();
      if (replacing) {
        assert.equal(await card.getAttribute("aria-pressed"), "true");
        assert.match((await card.textContent()).trim(), /^Confirm replacement/);
        await card.click();
      }
      await page.waitForFunction(
        (template) => document.querySelector(".n-widget-surface .n-surface-deck")
          ?.getAttribute("data-template") === template,
        slug,
      );
    };
    const kinds = () => page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll(
        ".n-widget-surface .n-surface-control",
      ));
      return {
        total: controls.length,
        unassigned: controls.filter((control) => control.classList.contains("unassigned")).length,
        button30: controls.filter((control) => control.getAttribute("data-control-kind") === "button30").length,
        button24: controls.filter((control) => control.getAttribute("data-control-kind") === "button24").length,
        joystick: controls.filter((control) => control.getAttribute("data-control-kind") === "joystick").length,
        byPlayer: [1, 2, 3, 4].map((slot) => controls.filter(
          (control) => control.getAttribute("data-player-slot") === String(slot),
        ).length),
      };
    });

    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForSelector(".n-widget-surface");
      assert.equal(await page.locator(".n-widget-surface").count(), 1);
      // SIX, not seven. `3901990` ("cut ksx over to /nocturne — remove the
      // encoder chart surface") deleted the `encoder-current` starter, whose
      // whole promise was "build physical controls from the terminal-to-key
      // chart stored on this board" — a chart nothing reads any more. The
      // gallery is now blank, three hand-authored panel shapes, and two
      // mapping-derived ones.
      assert.equal(
        await page.locator(".n-widget-surface [data-surface-template]").count(),
        6,
        "the starter gallery offers blank, panel-shape, and mapping-derived entries",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(
          ".n-widget-surface [data-surface-template]",
        )),
        true,
        "opening the builder puts keyboard focus into the starter gallery",
      );

      await choose("blank", false);
      assert.deepEqual(await kinds(), {
        total: 0,
        unassigned: 0,
        button30: 0,
        button24: 0,
        joystick: 0,
        byPlayer: [0, 0, 0, 0],
      });
      await page.click('.n-widget-surface [data-surface-stage="teach"]');
      await page.waitForFunction(() => document.activeElement?.matches(
        '.n-widget-surface [data-nx="surface-add"]',
      ));
      assert.match(await page.textContent(".n-live-sr"), /Add a physical component first/i);
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      const navigatorClearanceHandle = await page.waitForFunction(() => {
        const surface = document.querySelector(".n-widget-surface");
        const navigator = document.querySelector(".forma-canvas-navigator");
        if (!surface || !navigator || navigator.hidden) return null;
        const surfaceRect = surface.getBoundingClientRect();
        const navigatorRect = navigator.getBoundingClientRect();
        const clearance = navigatorRect.left - surfaceRect.right;
        return clearance >= 11
          ? {
              clearance,
              surfaceRight: surfaceRect.right,
              navigatorLeft: navigatorRect.left,
            }
          : null;
      });
      const navigatorClearance = await navigatorClearanceHandle.jsonValue();
      assert.ok(
        navigatorClearance.clearance >= 11,
        `the focused builder reserves the interactive map strip (${JSON.stringify(navigatorClearance)})`,
      );
      await page.click('.n-widget-surface [data-nx="surface-remove"]');
      await page.waitForFunction(() => document.activeElement?.matches(
        '.n-widget-surface [data-nx="surface-add"]',
      ));
      assert.equal(await page.locator(".n-widget-surface .n-surface-control").count(), 0);

      await choose("arcade-stick");
      assert.deepEqual(await kinds(), {
        total: 11,
        unassigned: 11,
        button30: 8,
        button24: 2,
        joystick: 1,
        byPlayer: [0, 0, 0, 0],
      });

      await choose("leverless");
      assert.deepEqual(await kinds(), {
        total: 14,
        unassigned: 14,
        button30: 12,
        button24: 2,
        joystick: 0,
        byPlayer: [0, 0, 0, 0],
      });

      await choose("four-player");
      assert.deepEqual(await kinds(), {
        total: 36,
        unassigned: 36,
        button30: 24,
        button24: 8,
        joystick: 4,
        byPlayer: [9, 9, 9, 9],
      });
      assert.equal(
        await page.locator(".n-widget-surface .n-surface-player-zones").evaluate(
          (zones) => getComputedStyle(zones).display,
        ),
        "grid",
        "the four-player structure remains visible as part of the panel layout",
      );

      const firstP1 = page.locator(
        '.n-widget-surface .n-surface-control[data-player-slot="1"]',
      ).first();
      await firstP1.click();
      const labelInput = page.locator('.n-widget-surface [data-nx="surface-label"]');
      await labelInput.fill("Player Two Coin");
      await labelInput.press("Tab");
      assert.equal(
        (await page.locator(".n-widget-surface .n-surface-control.selected .n-surface-control-label").textContent()).trim(),
        "Player Two Coin",
        "physical components can be named in the contextual inspector",
      );
      await page.click('.n-widget-surface [data-nx="surface-owner"][data-player-slot="2"]');
      assert.equal(
        await page.locator(".n-widget-surface .n-surface-control.selected").getAttribute("data-player-slot"),
        "2",
        "player ownership is explicit rather than inferred only from where a control was drawn",
      );
      assert.equal(
        await page.locator('.n-widget-surface [data-nx="surface-owner"]').count(),
        5,
        "the picker offers Panel-wide and the four player zones the panel can actually show",
      );
      assert.match(await page.locator(".n-widget-surface .n-surface-control.selected").getAttribute("aria-label"),
        /joystick.*P2 view/i);
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button24"]');
      const addedP2 = page.locator(".n-widget-surface .n-surface-control.selected");
      assert.equal(await addedP2.getAttribute("data-player-slot"), "2");
      const addedPlacement = await addedP2.evaluate((control) => ({
        left: Number.parseFloat(control.style.left),
        top: Number.parseFloat(control.style.top),
      }));
      assert.ok(
        addedPlacement.left >= 50 && addedPlacement.top < 50,
        `a P2 part starts inside P2's quadrant (${addedPlacement.left}, ${addedPlacement.top})`,
      );
      assert.equal(
        await page.locator(".n-widget-surface .n-surface-deck").getAttribute("data-panel-layout"),
        "four-player",
        "ordinary edits preserve the durable four-player panel structure",
      );
      assert.equal(
        await page.locator(".n-widget-surface .n-surface-player-zones").evaluate(
          (zones) => getComputedStyle(zones).display,
        ),
        "grid",
      );

      await choose("mapping-four");

      const sharedG = await page.evaluate(() => Array.from(document.querySelectorAll(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      )).map((control) => ({
        physicalId: control.getAttribute("data-physical-id"),
        relationship: control.querySelector(".n-surface-control-relation")?.textContent ?? "",
        unresolved: control.classList.contains("shared-signal"),
      })));
      assert.ok(sharedG.length >= 2, "the fixture supplies G to more than one player mapping");
      assert.equal(new Set(sharedG.map((control) => control.physicalId)).size, sharedG.length);
      assert.ok(
        sharedG.every((control) => control.unresolved && control.relationship === "SIGNAL?"),
        "mapping import shows a shared signal without inventing a physical mirror relationship",
      );

      const firstG = page.locator(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      ).first();
      await firstG.evaluate((control) => control.click());
      assert.equal(
        await page.locator('.n-widget-surface [data-nx="surface-mirror"]').count(),
        0,
        "unresolved wiring must be confirmed before additional mirrors can be invented",
      );
      await page.selectOption('[data-nx="mapping-paths"]', "all");
      const cordOriginHandle = await page.waitForFunction(() => {
        const control = document.querySelector(
          '.n-widget-surface .n-surface-control.selected:has(.n-surface-channel-anchor[data-key="G"])',
        );
        const slot = control?.getAttribute("data-player-slot");
        const edge = document.querySelector(
          `#n-mapping-paths [data-flow-kind="binding"][data-flow-key="G"][data-flow-slot="${slot}"]`,
        );
        const flowId = edge?.getAttribute("data-flow-id");
        const port = flowId
          ? document.querySelector(
              `#n-mapping-ports [data-flow-id="${CSS.escape(flowId)}"] .n-flow-port-source`,
            )
          : null;
        const keycap = control?.querySelector(
          '.n-surface-signal-keycap[data-key="G"]',
        );
        const face = control?.querySelector('.n-surface-control-face');
        if (!control || !keycap || !face || !port) return null;
        const controlRect = control.getBoundingClientRect();
        const keycapRect = keycap.getBoundingClientRect();
        const faceRect = face.getBoundingClientRect();
        const portRect = port.getBoundingClientRect();
        if (portRect.width < 1 || portRect.height < 1) return null;
        const center = {
          x: portRect.left + portRect.width / 2,
          y: portRect.top + portRect.height / 2,
        };
        return {
          insideKeycap: center.x >= keycapRect.left - 1 && center.x <= keycapRect.right + 1 &&
            center.y >= keycapRect.top - 1 && center.y <= keycapRect.bottom + 1,
          insideFace: center.x >= faceRect.left && center.x <= faceRect.right &&
            center.y >= faceRect.top && center.y <= faceRect.bottom,
          rim: Math.min(
            Math.abs(center.x - keycapRect.left),
            Math.abs(center.x - keycapRect.right),
            Math.abs(center.y - keycapRect.top),
            Math.abs(center.y - keycapRect.bottom),
          ),
          controlRect: {
            left: controlRect.left,
            top: controlRect.top,
            right: controlRect.right,
            bottom: controlRect.bottom,
          },
          keycapRect: {
            left: keycapRect.left,
            top: keycapRect.top,
            right: keycapRect.right,
            bottom: keycapRect.bottom,
          },
          portRect: {
            left: portRect.left,
            top: portRect.top,
            right: portRect.right,
            bottom: portRect.bottom,
          },
          flowId,
          slot,
        };
      });
      const cordOrigin = await cordOriginHandle.jsonValue();
      assert.equal(
        cordOrigin.insideKeycap,
        true,
        `the source port stays inside the selected control's Windows-key token (${JSON.stringify(cordOrigin)})`,
      );
      assert.equal(cordOrigin.insideFace, false,
        "the signal cord does not imply that a physical arcade button is itself a Windows key");
      assert.ok(
        cordOrigin.rim <= 1.5,
        `the cord begins on the visible keycap rim (${cordOrigin.rim})`,
      );

      await page.click('.n-widget-surface [data-nx="surface-resolve-mirror"]');
      const linkedG = await page.evaluate(() => Array.from(document.querySelectorAll(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      )).map((control) => ({
        physicalId: control.getAttribute("data-physical-id"),
        relationship: control.querySelector(".n-surface-control-relation")?.textContent ?? "",
      })));
      assert.equal(new Set(linkedG.map((control) => control.physicalId)).size, 1);
      assert.ok(linkedG.every((control) => control.relationship === "LINK"));
      await page.waitForFunction(() => document.activeElement?.matches(
        ".n-widget-surface .n-surface-control.selected",
      ));

      await choose("mapping-four");
      const unresolvedIds = await page.locator(
        '.n-widget-surface .n-surface-control.shared-signal:has(.n-surface-channel-anchor[data-key="G"])',
      ).evaluateAll((controls) => controls.map((control) => control.getAttribute("data-surface-control-id")));
      assert.ok(unresolvedIds.length >= 2);
      for (const controlId of unresolvedIds.slice(0, -1)) {
        await page.locator(
          `.n-widget-surface .n-surface-control[data-surface-control-id="${controlId}"]`,
        ).evaluate((control) => control.click());
        await page.click('.n-widget-surface [data-nx="surface-remove"]');
      }
      const loneG = page.locator(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      );
      assert.equal(await loneG.count(), 1);
      assert.equal(await loneG.evaluate((control) => control.classList.contains("shared-signal")), false);
      assert.equal((await loneG.locator(".n-surface-control-relation").textContent()).trim(), "");

      await choose("mapping-four");
      await page.locator(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      ).first().evaluate((control) => control.click());
      await page.click('.n-widget-surface [data-nx="surface-resolve-duplicate"]');
      const separateG = await page.evaluate(() => Array.from(document.querySelectorAll(
        '.n-widget-surface .n-surface-control:has(.n-surface-channel-anchor[data-key="G"])',
      )).map((control) => ({
        physicalId: control.getAttribute("data-physical-id"),
        relationship: control.querySelector(".n-surface-control-relation")?.textContent ?? "",
      })));
      assert.equal(new Set(separateG.map((control) => control.physicalId)).size, separateG.length);
      assert.ok(separateG.every((control) => control.relationship === "DUPE"));
      assert.deepEqual(writes, [], "choosing and replacing physical templates performs no backend write");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("surface components keep explicit ownership and placement through drag and reload", async () => {
    const page = await openCanvas();
    const writes = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) writes.push(pathname);
    });
    const storedControl = (controlId) => page.evaluate((id) => {
      const store = JSON.parse(localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null");
      const surface = Object.values(store?.devices ?? {})[0];
      const control = surface?.controls?.find((candidate) => candidate.id === id);
      return control
        ? { x: control.x, y: control.y, playerSlot: control.playerSlot, open: surface.open }
        : null;
    }, controlId);

    try {
      await page.click('[data-nx="surface-open"]');
      await page.locator(
        '.n-widget-surface [data-surface-template="four-player"]',
      ).click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-deck")
          ?.getAttribute("data-template") === "four-player"
      );

      let control = page.locator(
        '.n-widget-surface .n-surface-control[data-player-slot="1"]',
      ).first();
      await control.click();
      const controlId = await control.getAttribute("data-surface-control-id");
      assert.ok(controlId);
      await page.click(
        `.n-widget-surface [data-nx="surface-owner"][data-player-slot="0"][data-surface-control-id="${controlId}"]`,
      );
      await page.waitForFunction(() =>
        document.activeElement?.matches(
          '.n-widget-surface [data-nx="surface-owner"][data-player-slot="0"]',
        )
      );
      control = page.locator(
        `.n-widget-surface .n-surface-control[data-surface-control-id="${controlId}"]`,
      );
      assert.equal(await control.getAttribute("data-player-slot"), null);
      const initial = await storedControl(controlId);
      await page.click(
        `.n-widget-surface [data-nx="surface-nudge"][data-surface-move="right"][data-surface-control-id="${controlId}"]`,
      );
      await page.waitForFunction(
        ({ id, x }) => {
          const store = JSON.parse(
            localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
          );
          const surface = Object.values(store?.devices ?? {})[0];
          return surface?.controls?.find((candidate) => candidate.id === id)?.x > x;
        },
        { id: controlId, x: initial.x },
      );
      const before = await storedControl(controlId);
      assert.equal(before.y, initial.y,
        "click movement offers a horizontal panel-control move without dragging");
      assert.equal(before.playerSlot, null);

      const box = await control.boundingBox();
      assert.ok(box, "the selected component has draggable browser geometry");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 56, {
        steps: 5,
      });
      await page.mouse.up();
      await page.waitForFunction(
        ({ id, x, y }) => {
          const store = JSON.parse(
            localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
          );
          const surface = Object.values(store?.devices ?? {})[0];
          const moved = surface?.controls?.find((candidate) => candidate.id === id);
          return moved && (moved.x !== x || moved.y !== y);
        },
        { id: controlId, x: before.x, y: before.y },
      );
      let moved = await storedControl(controlId);
      assert.ok(moved.x > before.x && moved.y > before.y, "dragging persists both panel coordinates");
      assert.equal(moved.playerSlot, null, "movement never derives semantic ownership from a quadrant");
      assert.equal(await control.getAttribute("data-player-slot"), null);

      const movedBox = await control.boundingBox();
      const deckBox = await page.locator('.n-widget-surface .n-surface-deck').boundingBox();
      assert.ok(movedBox && deckBox);
      await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(deckBox.x + deckBox.width - 3, deckBox.y + deckBox.height - 3, {
        steps: 6,
      });
      await page.mouse.up();
      await page.waitForFunction(
        ({ id, previousY }) => {
          const store = JSON.parse(
            localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
          );
          const surface = Object.values(store?.devices ?? {})[0];
          const edge = surface?.controls?.find((candidate) => candidate.id === id);
          const view = document.querySelector(
            `.n-widget-surface .n-surface-control[data-surface-control-id="${CSS.escape(id)}"]`,
          );
          return edge && edge.y > previousY && view?.getAttribute("data-signal-v") === "above";
        },
        { id: controlId, previousY: moved.y },
      );
      moved = await storedControl(controlId);
      const inwardDock = await control.evaluate((element) => {
        const deck = element.closest('.n-surface-deck');
        const keycap = element.querySelector('.n-surface-signal-keycap');
        const deckRect = deck?.getBoundingClientRect();
        const faceRect = element.getBoundingClientRect();
        const keyRect = keycap?.getBoundingClientRect();
        return {
          signalV: element.getAttribute('data-signal-v'),
          faceAtBottom: Boolean(deckRect) && Math.abs((deckRect?.bottom ?? 0) - faceRect.bottom) <= 2,
          keycapInside: Boolean(deckRect && keyRect) &&
            keyRect.left >= deckRect.left - 1 && keyRect.right <= deckRect.right + 1 &&
            keyRect.top >= deckRect.top - 1 && keyRect.bottom <= deckRect.bottom + 1,
        };
      });
      assert.equal(inwardDock.signalV, "above");
      assert.equal(inwardDock.faceAtBottom, true,
        "edge docking preserves the full physical placement range");
      assert.equal(inwardDock.keycapInside, true,
        "the Windows-key token docks inward instead of becoming a hidden route endpoint");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        `.n-widget-surface .n-surface-control[data-surface-control-id="${controlId}"]`,
      );
      await settle(page);
      const restored = await storedControl(controlId);
      assert.deepEqual(restored, moved, "reload restores the exact component position and panel-wide owner");
      const restoredView = await page.locator(
        `.n-widget-surface .n-surface-control[data-surface-control-id="${controlId}"]`,
      ).evaluate((element) => ({
        left: Number.parseFloat(element.style.left),
        top: Number.parseFloat(element.style.top),
        playerSlot: element.getAttribute("data-player-slot"),
      }));
      assert.ok(Math.abs(restoredView.left - (moved.x / 1200) * 100) < 0.01);
      assert.ok(Math.abs(restoredView.top - (moved.y / 720) * 100) < 0.01);
      assert.equal(restoredView.playerSlot, null);

      await page.locator(
        `.n-widget-surface .n-surface-control[data-surface-control-id="${controlId}"]`,
      ).click();
      await page.click('.n-widget-surface [data-nx="surface-remove"]');
      const undo = page.locator('.n-widget-surface [data-nx="surface-undo"]');
      assert.equal(await undo.isDisabled(), false, "the destructive removal offers an immediate undo");
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button24"]');
      assert.equal(
        await undo.isDisabled(),
        true,
        "a later panel edit expires the snapshot before it can discard intervening work",
      );
      assert.deepEqual(writes, [], "visual panel placement never rewrites a KSX route");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("ordinary binding rejects a desk keyboard and accepts the exact selected MI_00 fallback", async () => {
    const bindBodies = [];
    let bindCommitted = false;
    let committedBinding = null;
    const postWriteRevision = "fixture-ordinary-binding-revision-after-bind";
    let markBindObserved = () => {};
    const bindObserved = new Promise((resolve) => { markBindObserved = resolve; });
    let generation = 1700;
    let hitReady = false;
    let hitDevice = "HID\\VID_046D&PID_C31C&MI_00\\9&DESK-KEYBOARD&0&0000";
    let hitSelector = "usb:046d:c31c:00";
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200);
        const payload = await response.json();
        if (bindCommitted && committedBinding) {
          const pad = payload.view?.pads?.find(
            (candidate) => Number(candidate.slot) === Number(committedBinding.slot),
          );
          assert.ok(pad, "fixture payload contains the committed controller");
          pad.target_revision = postWriteRevision;
          setPadControlKeys(pad, committedBinding.function, [committedBinding.key]);
          payload.view.save_text = postWriteRevision;
        }
        await route.fulfill({ response, json: payload });
      });
      await candidate.route("**/api/learn/start", (route) => {
        generation += 1;
        hitReady = false;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation,
            remaining_ms: 10_000,
            device: null,
            selector: null,
            key: null,
            error: null,
          }),
        });
      });
      await candidate.route("**/api/learn", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: hitReady ? "hit" : "listening",
          generation,
          remaining_ms: hitReady ? null : 10_000,
          device: hitReady ? hitDevice : null,
          selector: hitReady ? hitSelector : null,
          key: hitReady ? "Z" : null,
          error: null,
        }),
      }));
      await candidate.route("**/nocturne/api/bind", (route) => {
        committedBinding = JSON.parse(route.request().postData() ?? "{}");
        bindBodies.push(committedBinding);
        bindCommitted = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            message: null,
            error: null,
            code: null,
            conflicts: [],
            also_drives: [],
          }),
        }).then(() => markBindObserved());
      });
    });
    const armOrdinaryBinding = async () => {
      await page.locator('.n-bindgroups [data-nx="chip-learn"]').first()
        .evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
    };

    try {
      await page.click('[data-nx="surface-open"]');
      const exactMi00 = await page.evaluate(() => JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view?.cap_instance ?? "");
      assert.ok(exactMi00);

      await armOrdinaryBinding();
      hitReady = true;
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.deepEqual(bindBodies, [],
        "a desk-keyboard hit cannot write the armed controller binding");
      assert.match(await page.textContent(".n-flash"),
        /Ignored Z from another or unresolved keyboard.*binding was not changed/i);

      hitDevice = exactMi00;
      hitSelector = "";
      await armOrdinaryBinding();
      hitReady = true;
      await bindObserved;
      await page.waitForFunction(
        (revision) => document.querySelector(".n-saved")?.textContent?.trim() === revision,
        postWriteRevision,
      );
      assert.equal(bindBodies.length, 1);
      assert.equal(bindBodies[0].key, "Z");
      assert.ok(bindBodies[0].expected_target_revision,
        "learner identity proof preserves the target-revision fence");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("teaching observes a signal while routing performs the real backend bind", async () => {
    const page = await openCanvas();
    const bindBodies = [];
    let bindCommitted = false;
    let committedBinding = null;
    const postWriteRevision = "fixture-surface-routing-revision-after-bind";
    let resolveBindObserved;
    const bindObserved = new Promise((resolve) => {
      resolveBindObserved = resolve;
    });
    await page.route("**/api/nocturne*", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const response = await route.fetch({ headers });
      assert.equal(response.status(), 200);
      const payload = await response.json();
      if (bindCommitted && committedBinding) {
        const pad = payload.view?.pads?.find(
          (candidate) => Number(candidate.slot) === Number(committedBinding.slot),
        );
        assert.ok(pad, "fixture payload contains the committed controller");
        pad.target_revision = postWriteRevision;
        setPadControlKeys(pad, committedBinding.function, [committedBinding.key]);
        payload.view.save_text = postWriteRevision;
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route("**/nocturne/api/bind", async (route) => {
      committedBinding = JSON.parse(route.request().postData() ?? "{}");
      bindBodies.push(committedBinding);
      bindCommitted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: null,
          error: null,
          code: null,
          conflicts: [],
          also_drives: [],
        }),
      });
      resolveBindObserved?.();
    });
    const controls = () => page.evaluate(() => Array.from(document.querySelectorAll(
      ".n-widget-surface .n-surface-control",
    )).map((control) => ({
      id: control.getAttribute("data-surface-control-id"),
      physicalId: control.getAttribute("data-physical-id"),
      keys: Array.from(control.querySelectorAll(".n-surface-channel-anchor[data-key]"))
        .map((anchor) => anchor.getAttribute("data-key")),
      relation: control.querySelector(".n-surface-control-relation")?.textContent ?? "",
    })));
    // This test is about the Teach/Route state contract. Invoke Teach through
    // its button semantics so a canvas minimap overlapping the moved widget
    // cannot turn the authority assertion into an unrelated hit-test failure.
    let learnStartedResolve;
    const invokeSurfaceAction = (action) => page.locator(
      `.n-widget-surface [data-nx="${action}"]`,
    ).evaluate((button) => button.click());
    const clickTeach = async () => {
      const started = new Promise((resolve) => {
        learnStartedResolve = resolve;
      });
      await invokeSurfaceAction("surface-teach");
      await started;
    };
    const selectedInput = await page.evaluate(() => {
      const view = JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view ?? {};
      return { selector: view.cap_selector ?? "", instance: view.cap_instance ?? "" };
    });
    const expectedSelector = selectedInput.selector;
    const expectedDevice = selectedInput.instance;
    assert.ok(expectedSelector, "the fixture serves the selected input's canonical selector");
    assert.ok(expectedDevice, "the fixture serves the exact selected Windows device instance");
    let physicalKey = "J";
    const rawIpacChild = "HID\\VID_D209&PID_0430&MI_00\\8&RAW-INPUT-CHILD&0&0000";
    let physicalDevice = rawIpacChild;
    let physicalSelector = expectedSelector;
    let physicalGeneration = 900;
    let physicalHitReady = false;
    let holdNextPoll = false;
    let pendingPollStarted;
    let releasePendingPoll;
    await page.route("**/api/learn/start", async (route) => {
      physicalGeneration += 1;
      physicalHitReady = false;
      learnStartedResolve?.();
      learnStartedResolve = undefined;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: "listening",
          generation: physicalGeneration,
          remaining_ms: 10_000,
          device: null,
          key: null,
          error: null,
        }),
      });
    });
    await page.route("**/api/learn", async (route) => {
      if (holdNextPoll) {
        holdNextPoll = false;
        pendingPollStarted?.();
        await new Promise((resolve) => {
          releasePendingPoll = resolve;
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: physicalHitReady ? "hit" : "listening",
          generation: physicalGeneration,
          remaining_ms: physicalHitReady ? null : 10_000,
          device: physicalHitReady ? physicalDevice : null,
          selector: physicalHitReady ? physicalSelector : null,
          key: physicalHitReady ? physicalKey : null,
          error: null,
        }),
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await clickTeach();
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      await page.locator('.n-widget-kb [data-key="B"]').evaluate(
        (button) => button.click(),
      );
      assert.equal(
        await page.locator('.n-widget-surface .n-surface-channel-anchor[data-key="J"]').count(),
        0,
        "clicking a drawn key cannot masquerade as an observed hardware event",
      );
      assert.match(
        await page.textContent(".n-live-sr"),
        /only clicked in the drawing.*not recorded as physical input/i,
      );
      physicalHitReady = true;
      await page.waitForFunction(() => document.querySelector(
        '.n-widget-surface .n-surface-channel-anchor[data-key="J"]',
      ));
      assert.deepEqual(bindBodies, [], "Teach input never calls the binding verb");
      assert.equal(
        (await page.textContent(".n-widget-surface .n-surface-signal strong")).trim(),
        "Keyboard · J",
      );
      const canonicalTeachCopy = await page.textContent(
        ".n-widget-surface .n-surface-signal small",
      );
      assert.match(canonicalTeachCopy, new RegExp(expectedDevice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        "Teach persists the selected USB MI_00 identity, not Raw Input's HID child");
      assert.doesNotMatch(canonicalTeachCopy, /RAW-INPUT-CHILD/i);
      assert.equal(
        await page.locator('.n-widget-surface [data-surface-stage="teach"]').getAttribute("aria-pressed"),
        "true",
        "a successful capture keeps the author in Teach mode for batch wiring",
      );

      await invokeSurfaceAction("surface-mirror");
      await invokeSurfaceAction("surface-duplicate");
      let views = await controls();
      assert.equal(views.length, 3);
      assert.equal(views[0].physicalId, views[1].physicalId, "a mirror shares physical identity");
      assert.notEqual(views[1].physicalId, views[2].physicalId, "a duplicate is independently wired");
      assert.deepEqual(views.map((view) => view.keys), [["J"], ["J"], ["J"]]);

      physicalKey = "Z";
      physicalDevice = "HID\\VID_0000&PID_0000\\WRONG-KEYBOARD";
      physicalSelector = "usb:046d:c31c:00";
      await clickTeach();
      physicalHitReady = true;
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.deepEqual((await controls()).map((view) => view.keys), [["J"], ["J"], ["J"]]);
      assert.match(
        await page.textContent(".n-live-sr"),
        /Ignored Z: Windows reported .*WRONG-KEYBOARD, not the selected keyboard or encoder/,
        "a hit from another attached keyboard is rejected before it becomes routable",
      );

      physicalKey = "K";
      physicalDevice = rawIpacChild;
      physicalSelector = expectedSelector;
      await clickTeach();
      physicalHitReady = true;
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-control.selected .n-surface-channel-anchor")
          ?.getAttribute("data-key") === "K"
      );
      assert.match(
        await page.textContent(".n-widget-surface .n-surface-signal small"),
        /verified against the selected Windows device/,
        "the accepted physical hit retains the exact learner-reported device",
      );
      views = await controls();
      assert.deepEqual(
        views.map((view) => view.keys),
        [["J"], ["J"], ["K"]],
        "the independently wired duplicate accepts its own physical signal",
      );

      await page.locator(".n-widget-surface .n-surface-control").first().evaluate(
        (button) => button.click(),
      );
      physicalKey = "L";
      physicalDevice = rawIpacChild;
      physicalSelector = expectedSelector;
      await clickTeach();
      physicalHitReady = true;
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-control.selected .n-surface-channel-anchor")
          ?.getAttribute("data-key") === "L"
      );
      views = await controls();
      assert.deepEqual(
        views.map((view) => view.keys),
        [["L"], ["L"], ["K"]],
        "teaching a mirror updates its physical twin but leaves the duplicate independent",
      );

      await page.locator(".n-widget-surface .n-surface-control").last().evaluate(
        (button) => button.click(),
      );
      physicalKey = "M";
      physicalDevice = rawIpacChild;
      physicalSelector = expectedSelector;
      holdNextPoll = true;
      const pollStarted = new Promise((resolve) => {
        pendingPollStarted = resolve;
      });
      await clickTeach();
      await pollStarted;
      const beforeStaleRemoval = await controls();
      await invokeSurfaceAction("surface-remove");
      physicalHitReady = true;
      releasePendingPoll?.();
      await page.waitForTimeout(120);
      views = await controls();
      assert.equal(views.length, beforeStaleRemoval.length - 1);
      assert.equal(
        views.some((view) => view.keys.includes("M")),
        false,
        "a delayed learner hit cannot attach itself after its physical component was removed",
      );
      await page.unroute("**/api/learn/start");
      await page.unroute("**/api/learn");

      await invokeSurfaceAction("surface-route");
      assert.notEqual(
        await page.inputValue('[data-nx="mapping-paths"]'),
        "off",
        "Route output reveals the mapping-path lens instead of creating an invisible connection",
      );
      assert.equal(
        await page.locator(".n-widget-surface .n-surface-control.assign").count(),
        2,
        "Route output visibly arms every view of the selected physical signal",
      );
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-2"] [data-fn~="a"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      await bindObserved;
      await page.waitForFunction(
        (revision) => document.querySelector(".n-saved")?.textContent?.trim() === revision,
        postWriteRevision,
      );
      const routedTargetRevision = bindBodies[0]?.expected_target_revision;
      assert.ok(routedTargetRevision,
        "surface routing carries the exact controller revision captured with the gesture");
      // NO `encoder_authority`, 2026-08-26. The bind POST used to carry a
      // four-field fence — expected_selector, expected_instance,
      // expected_board_fingerprint, expected_chart_sha256 — so a write could
      // not land if the board or its chart had changed underneath the gesture.
      // Two of those four are chart facts, and `3901990` took chart reading out
      // of ksx; the whole block went with it and appears nowhere in the repo
      // now. The fence that survived is `expected_target_revision`, the exact
      // CONTROLLER revision captured with the gesture, and it is asserted
      // above and again here — a routed bind is still refused against a seat
      // that moved on.
      assert.deepEqual(bindBodies, [{
        slot: 2,
        expected_target_revision: routedTargetRevision,
        function: "A",
        key: "L",
        mode: "replace",
        force: false,
      }]);
      assert.equal(
        await page.inputValue('[data-nx="mapping-paths"]'),
        "all",
        "a P1-selected surface routed only to P2 widens the lens so its new cord is visible",
      );

      const beforeReload = await controls();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (expected) => document.querySelectorAll(".n-widget-surface .n-surface-control").length === expected,
        beforeReload.length,
        { timeout: 20_000 },
      );
      await settle(page);
      assert.deepEqual(await controls(), beforeReload, "physical identities and taught signals survive reload");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a ViGEm PlayStation seat wears hybrid DualShock 4 art and remembers its color", async () => {
    const page = await openCanvas();
    try {
      const readArt = () => page.evaluate(() => {
        const stage = document.querySelector(".forma-canvas-stage");
        const widgets = Array.from(stage?.querySelectorAll(".widget-instance") ?? []);
        const widget = widgets.find((el) => el.querySelector("svg.ds4premium"));
        if (!widget) return { found: false };
        const svg = widget.querySelector("svg.ds4premium");
        const shell = svg?.querySelector(".ds4premium-shell");
        const body = svg?.querySelector(".ds4premium-body");
        const depth = svg?.querySelector(".ds4premium-depth");
        const hooks = svg?.querySelector(".ds4premium-hooks");
        const group = widget.querySelector(
          '.n-ds4-variants[role="group"][aria-label="DualShock 4 color"]',
        );
        const buttons = Array.from(
          group?.querySelectorAll('button.n-ds4-variant[data-nx="ds4-variant"]') ?? [],
        );
        const hookShapes = Array.from(hooks?.querySelectorAll(".ds4premium-hook[data-fn]") ?? []);
        const depthShapes = Array.from(
          depth?.querySelectorAll(".ds4premium-depth-shadow[data-ds4-depth]") ?? [],
        );
        const geometryAttrs = [
          "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
          "width", "height", "points", "transform",
        ];
        const shapeGeometry = (el) => [
          el.tagName,
          ...geometryAttrs.map((name) => el.getAttribute(name) ?? ""),
        ].join("|");
        const allGroups = Array.from(
          stage?.querySelectorAll(
            '.n-ds4-variants[role="group"][aria-label="DualShock 4 color"]',
          ) ?? [],
        );
        const ds4Widgets = widgets.filter((el) => el.querySelector("svg.ds4premium"));
        const storeRaw = localStorage.getItem("ksx-nocturne-ds4-variants1");
        return {
          found: true,
          tag: svg?.tagName ?? null,
          hasImage: widget.querySelector("img") !== null,
          sourceIds: svg?.querySelectorAll("[id]").length ?? -1,
          privateEffects: svg?.querySelectorAll("defs, filter, mask, foreignObject, image").length ?? -1,
          effectReferences: svg?.querySelectorAll("[filter], [mask]").length ?? -1,
          variant: svg?.getAttribute("data-ds4-variant") ?? null,
          shellFill: shell ? getComputedStyle(shell).fill : "",
          viewBox: svg?.getAttribute("viewBox") ?? null,
          bodyPresent: !!body,
          depthInsideBody: !!body && !!depth && body.contains(depth),
          bodyBeforeHooks: !!body && !!hooks && Boolean(
            body.compareDocumentPosition(hooks) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          hooksInsideArt: !!svg && !!hooks && svg.contains(hooks),
          hookLayerTag: hooks?.tagName ?? null,
          hooks: hookShapes.map((el) => el.getAttribute("data-fn")),
          hookGeometry: hookShapes.map((el) => [
            el.getAttribute("data-fn") ?? "",
            shapeGeometry(el),
          ].join("|")),
          nonEmptyHookCount: hookShapes.filter((el) => {
            const box = el.getBBox();
            return box.width > 0 && box.height > 0 && getComputedStyle(el).pointerEvents !== "none";
          }).length,
          depthShapeCount: depthShapes.length,
          depthNames: depthShapes.map((el) => el.getAttribute("data-ds4-depth")),
          depthGeometry: depthShapes.map(shapeGeometry),
          nonEmptyDepthCount: depthShapes.filter((el) => {
            const box = el.getBBox();
            return box.width > 0 && box.height > 0;
          }).length,
          interactiveDepthCount: depthShapes.filter(
            (el) => getComputedStyle(el).pointerEvents !== "none",
          ).length,
          depthFnCount: depth?.querySelectorAll("[data-fn]").length ?? -1,
          depthPrivateCount: depth?.querySelectorAll(
            "svg, defs, filter, mask, image, foreignObject, use, [id]",
          ).length ?? -1,
          filteredDescendantCount: Array.from(svg?.querySelectorAll("*") ?? []).filter(
            (el) => getComputedStyle(el).filter !== "none",
          ).length,
          dpadCapCount: svg?.querySelectorAll(".ds4premium-dpad-cap").length ?? -1,
          dpadSheenCount: svg?.querySelectorAll(".ds4premium-dpad-sheen").length ?? -1,
          faceRimCount: svg?.querySelectorAll(".ds4premium-face-rim").length ?? -1,
          stickRimCount: svg?.querySelectorAll(".ds4premium-stick-rim").length ?? -1,
          geometry: Array.from(
            svg?.querySelectorAll("g, path, circle, rect, ellipse, line, polyline, polygon") ?? [],
            shapeGeometry,
          ),
          groupCount: allGroups.length,
          ds4WidgetCount: ds4Widgets.length,
          misplacedGroupCount: allGroups.filter(
            (el) => !el.closest(".widget-instance")?.querySelector("svg.ds4premium"),
          ).length,
          buttonSlugs: buttons.map((el) => el.getAttribute("data-ds4-variant")),
          buttonLabels: buttons.map((el) => el.getAttribute("aria-label")),
          buttonTypes: buttons.map((el) => el.type),
          buttonPressed: buttons.map((el) => el.getAttribute("aria-pressed")),
          nativeButtonCount: buttons.filter((el) => el instanceof HTMLButtonElement).length,
          pressed: buttons.filter((el) => el.getAttribute("aria-pressed") === "true")
            .map((el) => el.getAttribute("data-ds4-variant")),
          widgetPosition: {
            x: widget.getAttribute("data-canvas-x"),
            y: widget.getAttribute("data-canvas-y"),
            transform: widget.style.transform,
          },
          storeRaw,
        };
      });

      const expectedSlugs = ["jet-black", "glacier-white", "magma-red", "midnight-blue"];
      const expectedHooks = [
        "a", "b", "x", "y",
        "dpad.up", "dpad.down", "dpad.left", "dpad.right",
        "lb", "rb", "lt", "rt",
        "back", "start", "guide",
        "lthumb", "rthumb",
        "lx.min", "lx.max", "ly.min", "ly.max",
        "rx.min", "rx.max", "ry.min", "ry.max",
      ];
      const initial = await readArt();

      assert.ok(initial.found, "the fixture's ViGEm PlayStation seat gets the hybrid DS4 master");
      assert.equal(initial.tag, "svg", "the controller is inline vector geometry");
      assert.equal(initial.hasImage, false, "no flat controller image is pasted into the canvas");
      assert.equal(initial.sourceIds, 0, "cloned source IDs cannot collide between controller widgets");
      assert.equal(initial.privateEffects, 0, "the clone carries no private defs, effects or images");
      assert.equal(initial.effectReferences, 0, "the clone carries no dangling filter or mask references");
      assert.ok(initial.bodyPresent, "the detailed source geometry remains a distinct body layer");
      assert.ok(initial.depthInsideBody, "the authored depth layer lives inside the pointerless body");
      assert.ok(initial.bodyBeforeHooks, "visual depth paints before the mapper hook overlay");
      assert.equal(initial.depthShapeCount, 18, "the depth pass keeps its exact authored shadow set");
      assert.equal(initial.nonEmptyDepthCount, 18, "every depth shape has visible geometry");
      assert.equal(initial.interactiveDepthCount, 0, "visual depth can never intercept mapping input");
      assert.equal(initial.depthFnCount, 0, "depth shapes never impersonate mapper controls");
      assert.equal(initial.depthPrivateCount, 0, "depth stays clone-safe inline vector geometry");
      assert.equal(initial.filteredDescendantCount, 0, "depth is explicit geometry, not a clipped filter");
      assert.equal(
        initial.depthNames.filter((name) => name?.startsWith("dpad-")).length,
        8,
        "all four D-pad petals receive contact and ambient shadows",
      );
      assert.equal(new Set(
        initial.depthNames.filter((name) => name?.startsWith("dpad-")),
      ).size, 8, "no D-pad shadow layer is duplicated");
      assert.equal(initial.dpadCapCount, 4, "every D-pad petal keeps its cap layer");
      assert.equal(initial.dpadSheenCount, 4, "every D-pad petal keeps its local sheen");
      assert.equal(initial.faceRimCount, 4, "every face button keeps its raised rim");
      assert.equal(initial.stickRimCount, 2, "both sticks keep their sculpted rim");
      assert.ok(initial.hooksInsideArt, "art and the interactive overlay share one SVG coordinate space");
      assert.equal(initial.hookLayerTag, "g", "hooks are an overlay group, not a second SVG");
      assert.equal(initial.hooks.length, 25, "the DS4 exposes exactly the mapper's 25 controls");
      assert.equal(new Set(initial.hooks).size, 25, "no mapping control is duplicated");
      assert.deepEqual([...initial.hooks].sort(), [...expectedHooks].sort());
      assert.equal(initial.nonEmptyHookCount, 25, "every hook has a real, interactive button-sized zone");

      assert.equal(initial.groupCount, initial.ds4WidgetCount, "each DS4 widget gets one color picker");
      assert.equal(initial.misplacedGroupCount, 0, "Xbox and DualSense widgets get no DS4 color picker");
      assert.deepEqual(initial.buttonSlugs, expectedSlugs, "all four authored finishes are available");
      assert.equal(initial.nativeButtonCount, 4, "the finish swatches are native keyboard-operable buttons");
      assert.ok(initial.buttonTypes.every((type) => type === "button"));
      assert.equal(initial.buttonPressed.filter((pressed) => pressed === "true").length, 1);
      assert.equal(initial.buttonPressed.filter((pressed) => pressed === "false").length, 3);
      assert.equal(new Set(initial.buttonLabels).size, 4, "every finish has its own accessible name");
      assert.ok(initial.buttonLabels.every(Boolean), "no color button is unnamed");
      assert.equal(initial.pressed.length, 1, "exactly one finish reports itself selected");
      assert.equal(initial.pressed[0], initial.variant, "the selected button and painted SVG agree");
      assert.ok(expectedSlugs.includes(initial.variant), "the initial finish is one of the four choices");
      assert.ok(
        initial.widgetPosition.x !== null && initial.widgetPosition.y !== null,
        "the mounted widget exposes a real canvas position before color changes",
      );

      const [clickedSlug, keyboardSlug] = expectedSlugs.filter((slug) => slug !== initial.variant);
      await page.click(
        `.n-ds4-variants button[data-ds4-variant="${clickedSlug}"]`,
      );
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        clickedSlug,
      );
      const clicked = await readArt();
      assert.equal(clicked.variant, clickedSlug, "pointer selection repaints the controller");
      assert.deepEqual(clicked.pressed, [clickedSlug], "pointer selection updates aria-pressed");
      assert.notEqual(clicked.shellFill, initial.shellFill, "pointer selection changes computed shell paint");
      assert.deepEqual(clicked.geometry, initial.geometry, "a finish change cannot rewrite source geometry");
      assert.deepEqual(clicked.depthGeometry, initial.depthGeometry, "a finish change cannot move depth layers");
      assert.deepEqual(clicked.hookGeometry, initial.hookGeometry, "a finish change cannot move mapping zones");
      assert.deepEqual(clicked.widgetPosition, initial.widgetPosition, "a finish change cannot move the widget");
      assert.ok(clicked.storeRaw, "the selected finish is written to its own localStorage record");
      assert.ok(
        clicked.storeRaw.includes(JSON.stringify(clickedSlug)),
        "the DS4 finish record stores the pointer-selected slug",
      );

      const keyboardButton = page.locator(
        `.n-ds4-variants button[data-ds4-variant="${keyboardSlug}"]`,
      );
      await keyboardButton.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        keyboardSlug,
      );
      const keyboard = await readArt();
      assert.equal(keyboard.variant, keyboardSlug, "Space activates a focused finish button");
      assert.deepEqual(keyboard.pressed, [keyboardSlug], "keyboard selection updates aria-pressed");
      assert.notEqual(keyboard.shellFill, clicked.shellFill, "keyboard selection changes computed shell paint");
      assert.deepEqual(keyboard.geometry, initial.geometry, "keyboard selection leaves geometry untouched");
      assert.deepEqual(keyboard.depthGeometry, initial.depthGeometry, "keyboard selection leaves depth aligned");
      assert.deepEqual(keyboard.hookGeometry, initial.hookGeometry, "keyboard selection leaves hooks aligned");
      assert.deepEqual(keyboard.widgetPosition, initial.widgetPosition, "keyboard selection leaves the widget put");
      assert.ok(keyboard.storeRaw?.includes(JSON.stringify(keyboardSlug)));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        keyboardSlug,
        { timeout: 20_000 },
      );
      await settle(page);
      const restored = await readArt();
      assert.equal(restored.variant, keyboardSlug, "the selected finish returns after reload");
      assert.deepEqual(restored.pressed, [keyboardSlug], "the restored button exposes selected state");
      assert.equal(restored.shellFill, keyboard.shellFill, "reload restores the same computed shell paint");
      assert.deepEqual(restored.geometry, initial.geometry, "restoring paint does not replace the SVG");
      assert.deepEqual(restored.depthGeometry, initial.depthGeometry, "restoring paint preserves vector depth");
      assert.deepEqual(restored.hookGeometry, initial.hookGeometry, "restored mapping zones stay aligned");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a DualSense wears its own body, with its hooks on its buttons", async () => {
    // The fixture's roster is Xbox + PlayStation; stage a PS5 pad to see the
    // third art. (A DualSense drew a DualShock 4 until the family rule
    // stopped keying on `is_xinput`.)
    const staged = await fetch(`${BASE}/nocturne/controller`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "persona=dualsense&preset=Player%203",
      redirect: "manual",
    });
    assert.ok(staged.status >= 200 && staged.status < 400, `staging answered ${staged.status}`);

    const page = await openCanvas();
    try {
      const art = await page.evaluate(() => {
        const widget = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        ).find((el) => el.querySelector("svg.dualsensepremium"));
        if (!widget) return { found: false };
        const svg = widget.querySelector("svg.dualsensepremium");
        const hooks = svg?.querySelector(".dualsensepremium-hooks");
        const shell = svg?.querySelector(".dualsensepremium-shell");
        const hookShapes = Array.from(svg?.querySelectorAll(".dualsensepremium-hook") ?? []);
        const sourceIndexes = new Set(Array.from(
          svg?.querySelectorAll("[data-dualsense-source-index]") ?? [],
          (el) => el.getAttribute("data-dualsense-source-index"),
        ));
        return {
          found: true,
          tag: svg?.tagName ?? null,
          hasImage: widget.querySelector("img") !== null,
          viewBox: svg?.getAttribute("viewBox") ?? null,
          hooksInsideArt: !!svg && !!hooks && svg.contains(hooks),
          hookLayerTag: hooks?.tagName ?? null,
          transparentHookCount: hookShapes.filter(
            (el) => el.getAttribute("fill") === "transparent",
          ).length,
          sourceShapeCount: sourceIndexes.size,
          depthShapeCount: svg?.querySelectorAll(".dualsensepremium-depth-shadow").length ?? 0,
          privateEffects: svg?.querySelectorAll("defs, filter, mask, foreignObject, image, use, [id]").length ?? -1,
          calloutCount: svg?.querySelectorAll(".dualsensepremium-callouts text.n-fnkey[data-fn]").length ?? 0,
          variantCount: widget.querySelectorAll(
            '.n-controller-variants[aria-label="DualSense color"] button.n-controller-variant',
          ).length,
          shellFill: shell ? getComputedStyle(shell).fill : "",
          hooks: Array.from(widget.querySelectorAll(".dualsensepremium-hooks [data-fn]")).map(
            (el) => el.getAttribute("data-fn"),
          ),
        };
      });

      assert.ok(art.found, "a DualSense seat gets the PS5 art, not the DualShock");
      assert.equal(art.tag, "svg", "the controller is inline vector geometry");
      assert.equal(art.hasImage, false, "no product-shot image is pasted into the canvas");
      assert.equal(
        art.viewBox,
        "70 216 940 640",
        "art and hooks occupy one source-derived coordinate space",
      );
      assert.ok(art.hooksInsideArt, "the transparent hooks live inside the art SVG");
      assert.equal(art.hookLayerTag, "g", "hooks are an overlay group, not a second SVG box");
      assert.equal(art.transparentHookCount, 25, "every interactive hook starts transparent");
      assert.equal(art.sourceShapeCount, 89, "the complete paid CC0 geometry survives inline");
      assert.equal(art.depthShapeCount, 20, "physical contact shadows sit beneath the controls");
      assert.equal(art.privateEffects, 0, "the clone contains no raster or private paint server");
      assert.equal(art.calloutCount, 25, "every mapper hook has one matching callout");
      assert.equal(art.variantCount, 6, "all six DualSense finishes are available in the widget header");
      assert.match(art.shellFill, /nxg-dualsense-white/, "the shell draws through the shared satin finish");
      // Every control the mapper can actually drive has a hook. The
      // touchpad, the mic button and adaptive-trigger force are NOT here on
      // purpose: the binding vocabulary has no way to express them, and a
      // hook that binds to nothing is a promise the page cannot keep.
      for (const fn of [
        "a", "b", "x", "y",
        "dpad.up", "dpad.down", "dpad.left", "dpad.right",
        "lb", "rb", "lt", "rt",
        "back", "start", "guide",
        "lthumb", "rthumb",
        "lx.min", "lx.max", "ly.min", "ly.max",
        "rx.min", "rx.max", "ry.min", "ry.max",
      ]) {
        assert.ok(art.hooks.includes(fn), `the DualSense art hooks ${fn}`);
      }
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Switch Pro and Xbox Series keep native geometry, exact zones, and selectable finishes", async () => {
    for (const [persona, preset] of [
      ["switchpro", "Player 4"],
      ["xboxseries", "Player 5"],
    ]) {
      const staged = await fetch(`${BASE}/nocturne/controller`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `persona=${persona}&preset=${encodeURIComponent(preset)}`,
        redirect: "manual",
      });
      assert.ok(staged.status >= 200 && staged.status < 400, `staging ${persona} answered ${staged.status}`);
    }

    const page = await openCanvas();
    try {
      const specs = [
        {
          family: "switchpro",
          svg: "svg.switchpropremium",
          source: "[data-switchpro-source-index]",
          sourceCount: 76,
          depth: ".switchpro-premium-depth-shadow",
          depthCount: 16,
          hook: ".switchpro-premium-hook[data-fn]",
          callout: ".switchpro-premium-callouts text.n-fnkey[data-fn]",
          shell: ".switchpro-premium-shell",
          viewBox: "10 145 940 670",
          variants: ["carbon-black", "ink-pair", "crimson-red", "frost-white"],
        },
        {
          family: "xboxseries",
          svg: "svg.xboxseriespremium",
          source: "[data-xbox-series-source-index]",
          sourceCount: 80,
          depth: ".xboxseriespremium-depth-shadow",
          depthCount: 23,
          hook: ".xboxseriespremium-hook[data-fn]",
          callout: ".xboxseriespremium-callouts text.n-fnkey[data-fn]",
          shell: ".xboxseriespremium-shell",
          viewBox: "0 0 3800 2647",
          variants: ["black", "white", "blue", "red", "green"],
        },
      ];

      const inspect = (spec) => page.evaluate((entry) => {
        const stage = document.querySelector(".forma-canvas-stage");
        const widget = Array.from(stage?.querySelectorAll(".widget-instance") ?? [])
          .find((el) => el.querySelector(entry.svg));
        if (!widget) return { found: false };
        const svg = widget.querySelector(entry.svg);
        const hooks = Array.from(svg.querySelectorAll(entry.hook));
        const callouts = Array.from(svg.querySelectorAll(entry.callout));
        const geometryAttrs = [
          "d", "x", "y", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "transform",
        ];
        const geometry = Array.from(
          svg.querySelectorAll("g, path, circle, rect, ellipse, line, polyline, polygon"),
          (el) => [el.tagName, ...geometryAttrs.map((name) => el.getAttribute(name) ?? "")].join("|"),
        );
        const sourceIndexes = new Set(Array.from(
          svg.querySelectorAll(entry.source),
          (el) => el.getAttribute(entry.family === "switchpro"
            ? "data-switchpro-source-index"
            : "data-xbox-series-source-index"),
        ));
        const buttons = Array.from(widget.querySelectorAll(
          '.n-controller-variants button.n-controller-variant[data-controller-variant]',
        ));
        return {
          found: true,
          viewBox: svg.getAttribute("viewBox"),
          variant: svg.getAttribute("data-controller-variant"),
          sourceCount: sourceIndexes.size,
          depthCount: svg.querySelectorAll(entry.depth).length,
          hookCount: hooks.length,
          uniqueHookCount: new Set(hooks.map((el) => el.getAttribute("data-fn"))).size,
          calloutCount: callouts.length,
          uniqueCalloutCount: new Set(callouts.map((el) => el.getAttribute("data-fn"))).size,
          transparentHookCount: hooks.filter((el) => el.getAttribute("fill") === "transparent").length,
          forbiddenCount: svg.querySelectorAll("defs, filter, mask, foreignObject, image, use, [id]").length,
          buttonSlugs: buttons.map((el) => el.getAttribute("data-controller-variant")),
          pressed: buttons.filter((el) => el.getAttribute("aria-pressed") === "true")
            .map((el) => el.getAttribute("data-controller-variant")),
          shellFill: getComputedStyle(svg.querySelector(entry.shell)).fill,
          geometry,
        };
      }, spec);

      for (const spec of specs) {
        const initial = await inspect(spec);
        assert.ok(initial.found, `${spec.family} gets its own inline master`);
        assert.equal(initial.viewBox, spec.viewBox, `${spec.family} keeps its native crop`);
        assert.equal(initial.sourceCount, spec.sourceCount, `${spec.family} keeps every authored source shape`);
        assert.equal(initial.depthCount, spec.depthCount, `${spec.family} has explicit physical depth vectors`);
        assert.equal(initial.hookCount, 25, `${spec.family} exposes exactly 25 mapper hooks`);
        assert.equal(initial.uniqueHookCount, 25, `${spec.family} hooks are unique whole controls`);
        assert.equal(initial.calloutCount, 25, `${spec.family} has a callout for every hook`);
        assert.equal(initial.uniqueCalloutCount, 25, `${spec.family} callouts match the hook vocabulary`);
        assert.equal(initial.transparentHookCount, 25, `${spec.family} hooks are invisible at rest`);
        assert.equal(initial.forbiddenCount, 0, `${spec.family} contains no raster or private paint server`);
        assert.deepEqual(initial.buttonSlugs, spec.variants, `${spec.family} exposes every finish`);
        assert.deepEqual(initial.pressed, [spec.variants[0]], `${spec.family} starts on its canonical finish`);

        const next = spec.variants[1];
        await page.locator(
          `.forma-canvas-stage .widget-instance:has(${spec.svg}) ` +
          `button[data-controller-variant="${next}"]`,
        ).click();
        await page.waitForFunction(
          ({ svgSelector, slug }) => document.querySelector(
            `.forma-canvas-stage .widget-instance ${svgSelector}`,
          )?.getAttribute("data-controller-variant") === slug,
          { svgSelector: spec.svg, slug: next },
        );
        const changed = await inspect(spec);
        assert.equal(changed.variant, next, `${spec.family} finish button repaints the clone`);
        assert.deepEqual(changed.pressed, [next], `${spec.family} exposes selected state`);
        assert.notEqual(changed.shellFill, initial.shellFill, `${spec.family} changes material paint`);
        assert.deepEqual(changed.geometry, initial.geometry, `${spec.family} finish cannot move geometry or hooks`);
      }
      const storedFinishes = await page.evaluate(() =>
        localStorage.getItem("ksx-nocturne-controller-finishes1") ?? ""
      );
      assert.match(storedFinishes, /switchpro:/, "Switch Pro finish persists by family and preset");
      assert.match(storedFinishes, /xboxseries:/, "Xbox Series finish persists by family and preset");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("an arrangement survives a reload", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);
      const before = await page.evaluate(() => ({
        x: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasX,
        y: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasY,
        stored: JSON.parse(localStorage.getItem("ksx-nocturne-canvas") ?? "{}").widgets?.kb ?? null,
      }));
      assert.ok(before.stored, "the tidy must reach the store, not just the screen");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
            undefined,
        null,
        { timeout: 20_000 },
      );
      const after = await page.evaluate(() => ({
        x: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasX,
        y: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasY,
      }));
      assert.deepEqual(after, { x: before.x, y: before.y }, "the board came back where it was left");
    } finally {
      await page.close();
    }
  });
});
