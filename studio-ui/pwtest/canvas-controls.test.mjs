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
import { stopFixtureProcess } from "./fixture-process.mjs";

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
      const res = await fetch(`${base}/api/map`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/map`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
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
    await page.route("**/api/panel/chart", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelChartPayload()),
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');

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

      const signal = page.locator(".n-widget-kb .n-ipac-signal:visible").first();
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

  test("conflict consent retains its opened authority and a chained bind waits for the new revision", async () => {
    const bodies = [];
    let bindCommitted = false;
    const committedBindings = [];
    const postWriteRevision = "fixture-draft-revision-after-bind";
    const postWriteRevision2 = "fixture-draft-revision-after-chained-bind";
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/chart", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload()),
        });
      });
      await candidate.route("**/api/nocturne*", async (route) => {
        // A successful bind changes the served revision even when the fixture's
        // scripted source is otherwise unchanged. Force this mutation poll to
        // carry a body instead of forwarding its pre-bind conditional as 304.
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200);
        const payload = await response.json();
        if (bindCommitted) {
          const revision = committedBindings.length >= 2
            ? postWriteRevision2
            : postWriteRevision;
          for (const binding of committedBindings) {
            const pad = payload.view?.pads?.find(
              (candidatePad) => Number(candidatePad.slot) === Number(binding.slot),
            );
            assert.ok(pad, "fixture payload contains the committed controller");
            pad.target_revision = revision;
            setPadControlKeys(pad, binding.function, [binding.key]);
          }
          payload.view.save_text = revision;
        }
        await route.fulfill({ response, json: payload });
      });
      await candidate.route("**/nocturne/api/bind", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        bodies.push(body);
        const conflict = bodies.length === 1;
        if (!conflict) {
          bindCommitted = true;
          committedBindings.push(body);
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(conflict ? {
            ok: false,
            message: null,
            error: "F7 already controls A for Player 2",
            code: "conflict",
            conflicts: [{
              scope: "draft",
              preset: "Player 2",
              function: "A",
              slot: 2,
            }],
            also_drives: [],
          } : {
            ok: true,
            message: null,
            error: null,
            code: null,
            conflicts: [],
            also_drives: [],
          }),
        });
      });
    });
    try {
      // Read the exact programmable encoder chart so the mapping gesture has
      // selector + instance + board fingerprint + chart hash authority.
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');

      const signal = page.locator(".n-widget-kb .n-ipac-signal:visible").first();
      const key = await signal.getAttribute("data-key");
      assert.ok(key);
      await signal.evaluate((button) => button.click());
      await page.locator('.n-right [data-nx="inspector-action"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );
      await page.locator(".n-chain-box").check();
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      await page.locator('[data-nx="conf-force"]').waitFor({ state: "visible" });
      assert.equal(bodies.length, 1);
      const openedRevision = bodies[0].expected_target_revision;
      assert.ok(openedRevision, "the first POST carries the served slot revision");
      assert.ok(bodies[0].encoder_authority, "the opened action pins exact encoder authority");
      assert.deepEqual(bodies[0].encoder_authority, {
        expected_selector: PANEL_SELECTOR,
        expected_instance: bodies[0].encoder_authority.expected_instance,
        expected_board_fingerprint: PANEL_FINGERPRINT,
        expected_chart_sha256: PANEL_BASE_SHA,
      });
      assert.ok(bodies[0].encoder_authority.expected_instance);

      await page.click('[data-nx="conf-force"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );
      assert.equal(bodies.length, 2);
      assert.equal(
        bodies[1].expected_target_revision,
        openedRevision,
        "force sends the token whose conflict set was disclosed",
      );
      assert.deepEqual(
        bodies[1].encoder_authority,
        bodies[0].encoder_authority,
        "force never recomputes exact hardware authority at dialog time",
      );

      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="b"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      const deadline = Date.now() + 5_000;
      while (bodies.length < 3 && Date.now() < deadline) await page.waitForTimeout(25);
      assert.equal(bodies.length, 3, "Bind several sends its second mapping");
      assert.equal(
        bodies[2].expected_target_revision,
        postWriteRevision,
        "the chained action waits for post-write controller authority",
      );
      await page.waitForFunction(
        (revision) => document.querySelector(".n-saved")?.textContent?.trim() === revision,
        postWriteRevision2,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("same-selector re-enumeration cancels an armed mapping before it can write", async () => {
    let reenumerate = false;
    let resolveReenumerated;
    const reenumerated = new Promise((resolve) => {
      resolveReenumerated = resolve;
    });
    let binds = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/chart", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload()),
        });
      });
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');

      const signal = page.locator(".n-widget-kb .n-ipac-signal:visible").first();
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-kb")?.getAttribute("data-input-kind") === "keyboard"
      );
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

  test("a chart fingerprint change closes stale conflict consent", async () => {
    let changedChart = false;
    let chartReads = 0;
    const bodies = [];
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/chart", async (route) => {
        chartReads += 1;
        const payload = panelChartPayload({
          imageSha256: changedChart ? "C".repeat(64) : PANEL_BASE_SHA,
        });
        if (changedChart) payload.view.board_fingerprint = `${PANEL_FINGERPRINT}-replacement`;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
      await candidate.route("**/nocturne/api/bind", async (route) => {
        bodies.push(JSON.parse(route.request().postData() ?? "{}"));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            message: null,
            error: "already used",
            code: "conflict",
            conflicts: [{ scope: "draft", preset: "Player 2", function: "A", slot: 2 }],
            also_drives: [],
          }),
        });
      });
    });
    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');
      await page.locator(".n-widget-kb .n-ipac-signal:visible").first()
        .evaluate((button) => button.click());
      await page.locator('.n-right [data-nx="inspector-action"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen")
      );
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().evaluate((control) => control.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })));
      await page.locator('[data-nx="conf-force"]').waitFor({ state: "visible" });
      assert.equal(bodies.length, 1);

      changedChart = true;
      await page.locator('.n-widget-surface [data-nx="surface-encoder-read"]')
        .evaluate((button) => button.click());
      const deadline = Date.now() + 5_000;
      while (chartReads < 2 && Date.now() < deadline) await page.waitForTimeout(25);
      assert.equal(chartReads, 2, "the exact chart authority was reread");
      await page.locator('[data-nx="conf-force"]').waitFor({ state: "hidden" });
      assert.equal(bodies.length, 1, "stale force consent was retired, not resubmitted");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the mapping inspector follows canvas selection and Find returns to the whole graph", async () => {
    const page = await openCanvas();
    try {
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      await keyboardLane.locator("button.n-dev").click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-kb")?.getAttribute("data-input-kind") === "keyboard"
      );

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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-kb")?.getAttribute("data-input-kind") === "keyboard"
      );
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
    const page = await openCanvas();
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
      await page.waitForTimeout(180);

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

      const selectedDirectGeometry = await page.evaluate((lines) =>
        Object.fromEntries(
          Array.from(document.querySelectorAll(`${lines} [data-flow-kind="binding"]`))
            .map((edge) => [
              edge.dataset.flowId,
              edge.querySelector(".n-flow-core")?.getAttribute("d") ?? "",
            ]),
        ), lines);

      await page.selectOption(select, "all");
      await page.waitForFunction(
        (lines) => document.querySelectorAll(`${lines} .n-flow-edge`).length === 36,
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
      const traceability = await page.evaluate(
        ({ lines, selectedSlot, selectedDirectGeometry }) => {
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
            const values = (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
            const [sx, sy, firstX, firstY, , , tx, ty] = values;
            const laneOffset = Math.abs(ty - sy) >= Math.abs(tx - sx)
              ? firstY - (sy + ty) / 2
              : firstX - (sx + tx) / 2;
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
            return {
              id,
              slot: edge.dataset.flowSlot,
              key: edge.dataset.flowKey,
              fn: edge.dataset.flowFn,
              d,
              commands: d.match(/[A-Za-z]/gu) ?? [],
              laneOffset: Number(laneOffset.toFixed(2)),
              opacity: getComputedStyle(edge).opacity,
              touchesPorts: Boolean(start && finish && source && target) &&
                Math.hypot(start.x - source.x, start.y - source.y) <= 0.05 &&
                Math.hypot(finish.x - target.x, finish.y - target.y) <= 0.05,
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
          const selectedScopeStable = routes
            .filter((route) => route.slot === selectedSlot)
            .every((route) => selectedDirectGeometry[route.id] === route.d);
          return {
            routeCount: routes.length,
            uniquePathCount: new Set(routes.map((route) => route.d)).size,
            allSingleCubics: routes.every((route) =>
              route.commands.length === 2 &&
              route.commands[0] === "M" &&
              route.commands[1] === "C"
            ),
            allTouchPorts: routes.every((route) => route.touchesPorts),
            restingOpacities: [...new Set(routes.map((route) => route.opacity))],
            laneCounts: [...new Set(routes.map((route) => route.slot))].map((slot) => {
              const members = routes.filter((route) => route.slot === slot);
              return {
                slot,
                count: members.length,
                unique: new Set(members.map((route) => route.laneOffset)).size,
              };
            }),
            fanoutFunctions: fanout.map((route) => route.fn).sort(),
            fanoutSeparation,
            selectedScopeStable,
            geometry: Object.fromEntries(routes.map((route) => [route.id, route.d])),
          };
        },
        { lines, selectedSlot, selectedDirectGeometry },
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
        traceability.allTouchPorts,
        true,
        "every lasso runs from its exact key handle to its exact control handle",
      );
      assert.deepEqual(
        traceability.restingOpacities,
        ["0.62"],
        "all-player cords retain quiet overview contrast",
      );
      assert.equal(
        traceability.laneCounts.every(({ count, unique }) => count > 7 && unique === count),
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
      assert.equal(
        traceability.selectedScopeStable,
        true,
        "switching from Selected to All does not reroute the selected player's cords",
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

      const liveIdentity = await page.evaluate(async (lines) => {
          const first = document.querySelector(`${lines} [data-flow-slot="1"][data-flow-kind="binding"]`);
          const second = document.querySelector(`${lines} [data-flow-slot="2"][data-flow-kind="binding"]`);
          first?.classList.add("is-live");
          second?.classList.add("is-live");
          const firstCore = first?.querySelector(".n-flow-core");
          const secondCore = second?.querySelector(".n-flow-core");
          const patterns = [firstCore, secondCore].map((core) =>
            core ? getComputedStyle(core).strokeDasharray : "",
          );
          const offsetBefore = firstCore ? getComputedStyle(firstCore).strokeDashoffset : "";
          await new Promise((resolve) => setTimeout(resolve, 180));
          const offsetAfter = firstCore ? getComputedStyle(firstCore).strokeDashoffset : "";
          const animation = firstCore ? getComputedStyle(firstCore).animationName : "";
          const opacity = first ? getComputedStyle(first).opacity : "";
          first?.classList.remove("is-live");
          second?.classList.remove("is-live");
          return { patterns, offsetBefore, offsetAfter, animation, opacity };
        }, lines);
      assert.notEqual(liveIdentity.patterns[0], "none", "Player 1 has a visible travel rhythm");
      assert.notEqual(
        liveIdentity.patterns[0],
        liveIdentity.patterns[1],
        "live travel keeps each player's non-color dash identity",
      );
      assert.equal(liveIdentity.animation, "n-flow-travel");
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
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb[data-input-kind="panel-encoder"]') !== null
      );
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
      const macroSignal = page.locator('.n-widget-kb .n-ipac-signal[data-key="P"]:visible');
      assert.equal(await macroSignal.count(), 1,
        "the independently available macro trigger remains a discoverable source signal");
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal:visible').count(),
        1,
        "unavailable direct mapping truth cannot be recycled into extra inferred I-PAC signals",
      );
      assert.match(
        (await page.locator('.n-widget-kb .n-ipac-signal-source > p').textContent())
          .replace(/\s+/g, " "),
        /has not read the I-PAC(?: 4X?)? hardware-output chart yet.*has not proven which physical terminals emit them/i,
        "the source distinguishes a macro's routed key name from a proven hardware-terminal output",
      );
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
      const squatter = await fetch(liveBase + "/api/map").then(
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
      let editable = page.locator(
        '#n-mapping-processors a.n-flow-processor:not([hidden])[data-flow-macro-id*="hadouken"]',
      );
      if (!(await editable.isVisible())) {
        const overflow = page.locator(
          "#n-mapping-processors details.n-flow-overflow:not([hidden])",
        );
        await overflow.locator("summary").press("Enter");
        editable = overflow.locator(
          'a.n-flow-overflow-link[data-flow-macro-id*="hadouken"]',
        );
      }
      await editable.press("Enter");
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
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb[data-input-kind="keyboard"]') !== null
      );
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
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb[data-input-kind="panel-encoder"]') !== null
      );
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-kb")?.getAttribute("data-input-kind") === "keyboard");
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
      await candidate.route("**/api/panel/chart", (route) => {
        const payload = panelChartPayload();
        payload.view.terminals[0].shifted = {
          code: 5,
          key: "B",
          label: "B",
          supported: true,
        };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
      await candidate.route("**/api/panel/backups", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          target_selector: PANEL_SELECTOR,
          unavailable: null,
          view: {
            summary: "One complete safety backup.",
            board_fingerprint: PANEL_FINGERPRINT,
            backups: [panelBackup()],
          },
        }),
      }));
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
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb')?.getAttribute("data-input-kind") !== "panel-encoder");
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

      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.locator("button.n-dev").click();
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      const setup = page.locator('.n-widget-surface[data-entry="encoder-setup"]');
      await setup.locator(".n-surface-terminal-editor").waitFor({ state: "visible" });
      const encoderOpen = setup.locator('[data-nx="input-test-open"]');
      await encoderOpen.click();
      await dialog.waitFor({ state: "visible" });
      assert.match(await dialog.locator("[data-input-test-source]").textContent(), /I-PAC 4/i);
      await dialog.locator("[data-input-test-expected]").fill("1");
      await dialog.locator('[data-input-test-action="start"]').click();
      await page.waitForFunction(() =>
        document.querySelector('[data-input-test-stat="peak"]')?.textContent === "1");
      assert.equal(starts.length, 5);
      assert.equal(starts[4].selector, PANEL_SELECTOR,
        "the encoder run is pinned to the exact selected I-PAC");
      assert.match(
        (await dialog.locator("[data-input-test-seen]").textContent()).replace(/\s+/g, " "),
        /B.*P1 SW1 · normal.*P1 SW1 · shifted \(stored; Shift inactive\).*P1 SW2 · normal/,
        "a current read chart annotates every normal and shifted terminal layer truthfully",
      );
      await dialog.locator('[data-input-test-action="stop"]').click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-input-test-dialog")?.getAttribute("data-state") === "cancelled");
      assert.deepEqual(cancels, [
        { generation: 9101 },
        { generation: 9102 },
        { generation: 9103 },
        { generation: 9104 },
        { generation: 9201 },
        { generation: 9301 },
        { generation: 9105 },
      ]);
      await dialog.locator('[data-input-test-action="close"]').click();
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
            return store?.version === 3 && store?.hardwareEpochs?.[device] === epoch &&
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
        assert.equal(migrated.hardwareEpoch, scenario.epoch,
          `${scenario.label} records the independently published hardware epoch`);
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

  test("Control Surface passively checks recovery once, then inspects only on open, refresh, or concrete identity change", async () => {
    let panelCalls = 0;
    let observedMode = "keyboard-compatible";
    let reenumerate = false;
    let holdNextPanelRead = false;
    let releaseHeldPanelRead = () => {};
    let markHeldPanelRead = () => {};
    let markReenumeratedPanelRead = () => {};
    const heldPanelRelease = new Promise((resolve) => {
      releaseHeldPanelRead = resolve;
    });
    const heldPanelStarted = new Promise((resolve) => {
      markHeldPanelRead = resolve;
    });
    const reenumeratedPanelRead = new Promise((resolve) => {
      markReenumeratedPanelRead = resolve;
    });
    const withinPanelRead = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 10_000)),
    ]);
    const methods = [];
    const panelWrites = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/panel/status" && request.method() !== "GET") {
          panelWrites.push(`${request.method()} ${pathname}`);
        }
      });
      await candidate.route("**/api/nocturne*", async (route) => {
        if (!reenumerate) {
          const response = await route.fetch();
          await route.fulfill({ response });
          return;
        }
        // Re-enumeration is a server-state change. Strip the browser's old
        // conditional so this fixture can return that changed body instead of
        // faithfully forwarding a 304 based on the unchanged scripted store.
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200, "re-enumeration returns a fresh Nocturne payload");
        const payload = await response.json();
        payload.view.cap_instance = "HID\\VID_D209&PID_0430\\FIXTURE-REENUMERATED";
        await route.fulfill({ response, json: payload });
      });
      await candidate.route("**/api/panel/status", async (route) => {
        panelCalls += 1;
        methods.push(route.request().method());
        if (panelCalls === 5) markReenumeratedPanelRead();
        if (holdNextPanelRead) {
          holdNextPanelRead = false;
          markHeldPanelRead();
          await heldPanelRelease;
          try {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(panelStatusPayload({
                name: "Stale pre-refresh encoder",
                mode: "keyboard-compatible",
                modeLabel: "Keyboard-compatible · Recommended",
              })),
            });
          } catch {
            // The product aborts the superseded GET. Its late completion must
            // not win even when the browser has already retired the request.
          }
          return;
        }
        const payload = observedMode === "unknown"
          ? panelStatusPayload({
              mode: "unknown",
              modeLabel: "Keyboard compatibility not observed · Mode unknown",
              modeDetail: "No boot-keyboard interface was observed; no vendor mode query was sent.",
              recommendation: "Keyboard compatibility was not observed. If this I-PAC was switched to XInput, hold Start1 + P1 Button 1 for ten seconds to return to keyboard mode, then refresh.",
            })
          : panelStatusPayload();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      await page.waitForTimeout(2_250);
      assert.equal(panelCalls, 1,
        "the closed selected encoder gets one passive recovery-journal check");

      await page.click('[data-nx="surface-open"]');
      const card = page.locator(".n-widget-surface .n-surface-hardware");
      await card.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      assert.equal(panelCalls, 2, "opening performs one additional explicit read");
      assert.deepEqual(methods, ["GET", "GET"]);
      assert.equal(await card.getAttribute("aria-labelledby"), "n-surface-hardware-title");
      assert.equal(await card.locator('[role="status"][aria-live="polite"]').count(), 1);
      let cardCopy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(cardCopy, /Ultimarc I-PAC 4X/);
      assert.match(cardCopy, /USB D209:0430/);
      assert.match(cardCopy, /bcdDevice 0x0056/);
      assert.match(cardCopy, /Keyboard-compatible input observed/);
      assert.match(cardCopy, /USB descriptors and passive HID collection metadata were readable/);
      assert.match(cardCopy, /Protocol unverified · Not attempted/);
      assert.match(cardCopy, /no report was sent/);
      assert.match(cardCopy, /One exact five-byte configuration collection is available/);
      assert.match(cardCopy, /Inspection only\. KSX did not program or change this encoder\./);
      assert.equal(await card.locator("form").count(), 0);
      assert.equal(await card.locator("button").count(), 2, "the hardware card offers passive Refresh and explicit Encoder setup");
      assert.equal((await card.locator('[data-nx="surface-encoder-open"]').textContent()).trim(), "Open hardware outputs…");
      assert.equal(await card.locator('[data-nx*="program"], [data-nx*="write"]').count(), 0);
      const hardwareDetails = card.locator("details.n-surface-hardware-details");
      assert.equal(await hardwareDetails.getAttribute("open"), null);
      await hardwareDetails.locator("summary").click();
      assert.notEqual(await hardwareDetails.getAttribute("open"), null);
      const stageLabels = await page.locator(".n-widget-surface .n-surface-stage").evaluateAll(
        (buttons) => buttons.map((button) =>
          (button.textContent ?? "").replace(/^\s*\d+\s*/, "").trim()),
      );
      assert.deepEqual(stageLabels, ["Arrange appearance", "Teach host signals", "Route in KSX"]);

      await page.waitForTimeout(2_250);
      assert.equal(panelCalls, 2, "ordinary Nocturne polls do not re-inspect hardware");

      holdNextPanelRead = true;
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await withinPanelRead(heldPanelStarted, "the held panel refresh never reached the endpoint");
      observedMode = "unknown";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-mode") === "unknown");
      assert.equal(panelCalls, 4, "an explicit retry supersedes the in-flight inspection");
      releaseHeldPanelRead();
      await page.waitForTimeout(200);
      cardCopy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(cardCopy, /Keyboard compatibility not observed · Mode unknown/);
      assert.match(cardCopy, /If this I-PAC was switched to XInput/);
      assert.match(cardCopy, /hold Start1 \+ P1 Button 1 for ten seconds/);
      assert.doesNotMatch(cardCopy, /XInput mode ·/);
      assert.doesNotMatch(cardCopy, /Stale pre-refresh encoder/);

      reenumerate = true;
      await withinPanelRead(
        reenumeratedPanelRead,
        "a concrete encoder-instance change never triggered a fresh panel inspection",
      );
      assert.equal(panelCalls, 5, "a new concrete Windows instance under the same selector refreshes once");
      await page.waitForTimeout(2_250);
      assert.equal(panelCalls, 5, "the unchanged re-enumerated target does not refresh on every poll");
      assert.deepEqual(methods, ["GET", "GET", "GET", "GET", "GET"]);
      assert.deepEqual(panelWrites, []);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseHeldPanelRead();
      await page.close();
    }
  });

  test("an occupied I-PAC configuration interface explains WinIPAC and retries in place", async () => {
    let chartReads = 0;
    let planReads = 0;
    let restoreReads = 0;
    const restoreBackup = panelBackup({
      id: "20260823T002900Z-restore-BBBBBBBBBBBB",
      imageSha256: PANEL_DESIRED_SHA,
      reason: "manual-snapshot",
    });
    const hardwareWrites = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/panel/program/apply" || pathname === "/api/panel/restore/apply") {
          hardwareWrites.push(pathname);
        }
      });
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            configurationState: "available-unopened",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        chartReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(chartReads === 1
            ? {
              target_selector: PANEL_SELECTOR,
              unavailable: "Another app is using this I-PAC's configuration interface. KSX could not acquire the exclusive handle required for this step; no persistent chart write was started.",
              refusal_code: "panel-interface-busy",
              remedy: "Close WinIPAC or the other encoder tool, then choose Read board again. KSX keyboard input can continue while the configuration interface is busy, and nothing was changed.",
              hardware_epoch: null,
              hardware_fence: null,
              view: null,
            }
            : panelChartPayload()),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        planReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(planReads === 1
            ? {
              target_selector: PANEL_SELECTOR,
              unavailable: "The I-PAC configuration interface became busy before the hardware diff was built.",
              refusal_code: "panel-interface-busy",
              remedy: "Close WinIPAC or the other encoder tool, then retry this review. KSX keyboard input can continue.",
              plan: null,
            }
            : panelProgramPlan()),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified restore point.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [restoreBackup],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/restore/plan", async (route) => {
        restoreReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(restoreReads === 1
            ? {
              target_selector: PANEL_SELECTOR,
              unavailable: "The I-PAC configuration interface became busy before the restore diff was built.",
              refusal_code: "panel-interface-busy",
              remedy: "Close WinIPAC or the other encoder tool, then retry this restore. KSX keyboard input can continue.",
              plan: null,
            }
            : panelProgramPlan()),
        });
      });
    });

    try {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.waitFor({ state: "visible" });
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      const setup = page.locator('.n-widget-surface[data-entry="encoder-setup"]');
      await setup.waitFor({ state: "visible" });
      const summary = setup.locator("[data-surface-programming-summary]");
      await page.waitForFunction(() =>
        document.querySelector("[data-surface-programming-summary]")?.textContent
          ?.includes("Close WinIPAC"));

      assert.equal(chartReads, 1);
      assert.match(
        (await summary.textContent()).replace(/\s+/g, " "),
        /Another app is using.*configuration interface.*Close WinIPAC.*Read board again.*keyboard input can continue.*nothing was changed/i,
        "the hardware workspace gives a useful recovery path without claiming keyboard input stopped",
      );
      assert.match(
        (await encoderLane.locator(".n-dev-meta").textContent()).replace(/\s+/g, " "),
        /Configuration interface busy/i,
        "the collapsed encoder row keeps the failure discoverable",
      );
      assert.match(
        await encoderLane.locator('[data-nx="encoder-select-setup"]').getAttribute("title"),
        /Close WinIPAC.*Read board again.*Keyboard input can continue/i,
      );
      assert.equal(
        await setup.locator('[data-nx="surface-encoder-review"]').isDisabled(),
        true,
        "an unread chart cannot expose a hardware write",
      );
      assert.deepEqual(hardwareWrites, []);

      await setup.locator('[data-nx="surface-encoder-read"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-surface-programming")?.getAttribute("data-qualification") ===
          "qualified");
      assert.equal(chartReads, 2, "retry performs one fresh authoritative chart read");
      assert.match(
        (await encoderLane.locator(".n-dev-meta").textContent()).replace(/\s+/g, " "),
        /2\/2 outputs assigned/i,
      );
      assert.doesNotMatch((await summary.textContent()).replace(/\s+/g, " "), /WinIPAC|busy/i);
      assert.doesNotMatch(
        await encoderLane.locator('[data-nx="encoder-select-setup"]').getAttribute("title"),
        /WinIPAC|busy/i,
        "a successful chart retry clears the busy-only recovery tooltip",
      );
      const review = setup.locator('[data-nx="surface-encoder-review"]');
      await setup.locator('[data-surface-programming-mode="recommended"]').click();
      assert.equal(await review.isEnabled(), true);
      await review.click();
      await page.waitForFunction(() =>
        document.querySelector("[data-surface-programming-summary]")?.textContent
          ?.includes("retry this review"));
      assert.equal(planReads, 1);
      assert.match(
        (await summary.textContent()).replace(/\s+/g, " "),
        /became busy.*Close WinIPAC.*retry this review.*keyboard input can continue.*Nothing was written/i,
      );
      assert.equal(await page.locator("dialog.n-panel-program-dialog").isVisible(), false);
      assert.equal(await review.isEnabled(), true, "the same guarded review remains retryable");

      await review.click();
      const dialog = page.locator("dialog.n-panel-program-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.equal(planReads, 2, "retry computes one fresh hardware diff");
      await dialog.locator('[data-panel-dialog-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });

      const restore = setup.locator('[data-nx="surface-encoder-restore"]');
      await setup.locator(".n-surface-programming-recovery summary").click();
      await setup.locator("[data-surface-backup]").selectOption(restoreBackup.backup_id);
      assert.equal(await restore.isEnabled(), true);
      await restore.click();
      await page.waitForFunction(() =>
        document.querySelector("[data-surface-programming-summary]")?.textContent
          ?.includes("retry this restore"));
      assert.equal(restoreReads, 1);
      assert.match(
        (await summary.textContent()).replace(/\s+/g, " "),
        /busy.*restore diff.*Close WinIPAC.*retry this restore.*keyboard input can continue.*Nothing was written/i,
      );
      assert.equal(await restore.isEnabled(), true, "the guarded restore remains retryable");
      await restore.click();
      await dialog.waitFor({ state: "visible" });
      assert.equal(restoreReads, 2, "restore retry computes one fresh hardware diff");
      await dialog.locator('[data-panel-dialog-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(hardwareWrites, [], "read, planning, and retry never became a persistent operation");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a blank I-PAC enters guarded first-run setup before a panel or emitted key exists", async () => {
    let chartReads = 0;
    let capturedPlan = null;
    const hardwareWrites = [];
    const signalWrites = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/panel/program/apply" || pathname === "/api/panel/restore/apply") {
          hardwareWrites.push(pathname);
        }
        if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) signalWrites.push(pathname);
      });
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "This installed board has not emitted a usable key yet.",
            configurationState: "available-unopened",
            configurationDetail: "The exact I-PAC configuration collection is ready for a guarded read.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        chartReads += 1;
        const request = JSON.parse(route.request().postData() ?? "{}");
        assert.deepEqual(request, {
          expected_selector: PANEL_SELECTOR,
          backup: true,
          hardware_epoch: null,
          expected_board_fingerprint: null,
        });
        const payload = panelChartPayload({
          qualificationState: "required",
          qualificationDetail:
            "This new board needs one reversible writer check before its complete layout can be initialized.",
        });
        payload.view.summary = "The complete all-unassigned 256-byte I-PAC chart was read.";
        payload.view.terminals = payload.view.terminals.map((terminal) => ({
          ...terminal,
          normal: {
            code: 0,
            key: null,
            label: "Unassigned",
            supported: true,
          },
        }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One lossless first-run backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [panelBackup()],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        capturedPlan = JSON.parse(route.request().postData() ?? "{}");
        const payload = panelProgramPlan({
          terminals: ["1sw1"],
          confirmation:
            "Program one temporary key for the reversible writer check, then restore the exact safety backup.",
        });
        payload.plan.summary = "Temporarily assign A to P1 SW1 and preserve every other byte.";
        payload.plan.terminal_diff[0].before = "Unassigned";
        payload.plan.terminal_diff[0].after = "A";
        payload.plan.byte_diff[0].before = 0;
        payload.plan.byte_diff[0].after = 4;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.waitFor({ state: "visible" });
      assert.equal(await encoderLane.count(), 1, "the I-PAC has one dedicated encoder row");
      assert.match(
        (await page.locator(".n-encoder-kick").textContent()).replace(/\s+/g, " "),
        /Arcade encoders.*1 found/i,
      );
      assert.doesNotMatch(
        (await page.locator(".n-devform:not(.n-encoder-form) .n-dev-name").allTextContents())
          .join(" "),
        /I-PAC/i,
        "a boot-keyboard-shaped I-PAC is not presented as an ordinary keyboard",
      );
      assert.match(
        (await page.locator(".n-devform:not(.n-encoder-form) .n-dev-name").allTextContents())
          .join(" "),
        /Logitech G915/i,
        "real keyboards remain in their own lane",
      );
      assert.equal(await page.locator(".n-widget-surface").count(), 0);
      const keyboardLane = page.locator(".n-devform:not(.n-encoder-form)")
        .filter({ hasText: "Logitech G915" });
      assert.equal(
        await encoderLane.locator("button.n-dev").getAttribute("class"),
        "n-dev on",
        "the fixture's exact I-PAC is already the daemon-staged hardware authority",
      );
      assert.equal(
        await encoderLane.getByRole("button", { name: "Open outputs Ultimarc I-PAC 4" }).count(),
        1,
        "each encoder action names the exact board it will configure",
      );

      await keyboardLane.locator("button.n-dev").click();
      await page.waitForFunction(() => Array.from(
        document.querySelectorAll(".n-devform:not(.n-encoder-form)"),
      ).some((row) => row.textContent?.includes("Logitech G915") &&
        row.querySelector("button.n-dev")?.classList.contains("on")));
      assert.equal(
        (await encoderLane.locator("button.n-dev").getAttribute("class")).includes("on"),
        false,
        "first-run setup must also work when an ordinary keyboard was previously selected",
      );

      await encoderLane.locator("button.n-dev").click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb .n-ipac-signal-source > p')?.textContent
          ?.includes("KSX has not read the I-PAC"));
      assert.match(
        (await page.locator('.n-widget-kb .n-ipac-signal-source > p').textContent()).replace(/\s+/g, " "),
        /KSX routes currently reference these keyboard host signals.*KSX has not read the I-PAC(?: 4X?)? hardware-output chart yet.*has not proven which physical terminals emit them.*terminal → host-signal ownership/i,
        "before chart read, mapped names are references rather than proven I-PAC emissions",
      );

      if (await page.locator(".n-right").evaluate((element) => element.classList.contains("rail"))) {
        await page.locator('.n-right .n-rail [data-nx="pane-right"]').click();
      }
      assert.equal(await page.locator(".n-right").evaluate((element) => element.classList.contains("rail")), false,
        "the Mapping Inspector begins open so setup can prove it collapses contextually");
      for (let press = 0; press < 12; press++) {
        await page.click('[data-nx="canvas-zoom-out"]');
      }
      await settle(page);
      assert.equal((await page.textContent(".n-zoomval")).trim(), "20%",
        "the setup check begins from the worst saved overview zoom");
      const entryCameraStyle = await page.getAttribute(".forma-canvas-stage", "style");
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      const setup = page.locator('.n-widget-surface[data-entry="encoder-setup"]');
      await setup.waitFor({ state: "visible" });
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface[data-entry="encoder-setup"] .n-surface-programming')
          ?.getAttribute("data-qualification") === "required");

      assert.equal(chartReads, 1,
        "Set up performs one explicit complete-chart read and backup even when clicked twice while loading");
      assert.equal(await page.locator(".forma-canvas-viewport.is-widget-focus-mode").count(), 1,
        "hardware setup enters a focused canvas workspace instead of shrinking into the whole graph");
      assert.equal(await setup.evaluate((element) => element.classList.contains("is-focus-mode")), true);
      const focusedZoom = Number.parseInt((await page.textContent(".n-zoomval")).trim(), 10);
      assert.ok(focusedZoom >= 68,
        `hardware setup raises a miniature overview to a readable scale (got ${focusedZoom}%)`);
      const viewportBox = await page.locator(".forma-canvas-viewport").boundingBox();
      const journeyBox = await setup.locator(".n-panel-signal-journey").boundingBox();
      assert.ok(viewportBox && journeyBox &&
        journeyBox.y >= viewportBox.y - 1 && journeyBox.y < viewportBox.y + viewportBox.height,
      "an oversized hardware form opens at the beginning of its signal journey, not halfway down");
      assert.equal(await page.locator("#n-mapping-paths").isHidden(), true,
        "route cords leave the focused persistent-hardware task unobstructed");
      assert.equal(await page.locator("#n-mapping-processors").isHidden(), true,
        "floating macro cards cannot cover writer qualification or recovery controls");
      assert.equal(await page.locator(".forma-canvas-navigator").isHidden(), true,
        "the passive navigator cannot cover lower-right terminal controls in focused hardware setup");
      assert.equal(await page.locator(".n-mapshow").isHidden(), true,
        "focused hardware setup cannot replace the hidden navigator with another corner obstruction");
      assert.equal(await page.locator(".n-right").evaluate((element) => element.classList.contains("rail")), true,
        "the stale mapping inspector collapses while the user is editing persistent hardware outputs");
      assert.equal(await setup.locator(".n-surface-control").count(), 0,
        "writer qualification does not invent a drawn physical control");
      assert.equal(await setup.locator(".n-surface-starters").isHidden(), true,
        "the panel-template gallery is not a prerequisite for encoder initialization");
      assert.equal(await setup.locator(".n-surface-stages").isHidden(), true,
        "Design, Teach, and Route do not compete with the hardware-first task");
      assert.equal(await setup.locator("[data-surface-template]:visible").count(), 0);
      assert.match(
        (await setup.textContent()).replace(/\s+/g, " "),
        /I-PAC 4X.*Hardware outputs.*Panel control.*I-PAC 4X.*Host signal.*KSX transform.*Virtual controller.*Game.*No assigned hardware outputs.*Verify this I-PAC writer.*Test wiring/i,
      );
      assert.deepEqual(
        await setup.locator("[data-panel-journey-step] strong").allTextContents(),
        ["Panel control", "I-PAC 4X", "Host signal", "KSX transform", "Virtual controller", "Game"],
        "the workspace teaches the complete physical-control-to-game signal chain",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="physical"]').getAttribute("data-state"),
        "active",
        "an empty board offers the physical cabinet as the honest first design step",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="keys"]').getAttribute("data-state"),
        "upcoming",
        "the empty board does not pretend that a Windows key exists before the panel and terminal are assigned",
      );
      const designPanelFirst = setup.locator('[data-nx="surface-encoder-design-panel"]');
      assert.equal(await designPanelFirst.isVisible(), true);
      assert.equal(await designPanelFirst.isEnabled(), true);
      assert.match((await designPanelFirst.textContent()).trim(), /Design physical panel first/i);
      assert.match(
        (await setup.locator("[data-surface-programming-device]").textContent()).replace(/\s+/g, " "),
        /Windows key outputs\s*0 of 2.*KSX routes\s*0 hardware keys mapped/i,
        "device facts report the empty hardware chart and empty KSX route layer independently",
      );
      assert.deepEqual(
        await setup.locator("[data-surface-board-fact]").evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-surface-board-fact"))),
        ["board", "firmware", "input", "outputs", "routes"],
        "the setup opens with one compact board-to-KSX fact strip",
      );
      assert.equal(
        (await setup.locator('[data-surface-board-fact="firmware"] [data-surface-board-fact-value]').textContent()).trim(),
        "1.56",
        "the exact registered release is named for people instead of showing only 0x0056",
      );
      assert.match(
        (await setup.locator('[data-surface-board-fact="firmware"] [data-surface-board-fact-detail]').textContent()).replace(/\s+/g, " "),
        /I-PAC 4 release-0056 profile.*firmware was not queried from the board/i,
      );
      assert.match(
        (await setup.locator('[data-surface-board-fact="input"]').textContent()).replace(/\s+/g, " "),
        /Keyboard-compatible.*exact vendor mode was not queried/i,
        "observed HID evidence stays visibly distinct from an exact vendor-mode read",
      );
      assert.match(
        (await setup.locator('[data-surface-board-fact="outputs"] [data-surface-board-fact-detail]').textContent()).replace(/\s+/g, " "),
        /2-terminal chart read back.*backup ready.*KSX profile ipac4-pac256-v1/i,
        "the read-back facts name the actual chart and keep the KSX transport profile separate from firmware",
      );
      assert.equal(
        await setup.locator("[data-surface-board-facts]").evaluate((element) =>
          element.scrollWidth <= element.clientWidth),
        true,
        "the board fact strip fits the focused workspace without horizontal clipping",
      );
      assert.match(
        (await setup.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "),
        /Initialize it with a complete layout/i,
        "the recommended next action lives in task guidance rather than hardware facts",
      );
      assert.match(
        (await page.locator(".n-left").textContent()).replace(/\s+/g, " "),
        /Input capture behavior.*Dedicated arcade panel.*Share unused outputs with Windows.*Observe and pass through/i,
        "an encoder gets cabinet-specific capture choices instead of generic keyboard prose",
      );
      assert.deepEqual(signalWrites, [], "first-run chart setup never asks Windows to emit or learn a key");

      const qualificationTerminal = setup.locator('[data-nx="surface-qualification-terminal"]');
      await page.waitForFunction(() => document.activeElement?.matches(
        '[data-nx="surface-qualification-terminal"]',
      ));
      assert.equal(
        await qualificationTerminal.evaluate((element) => document.activeElement === element),
        true,
        "focus lands on the first safe hardware decision after read-back",
      );
      await qualificationTerminal.press("Escape");
      await page.waitForFunction(() =>
        !document.querySelector(".forma-canvas-viewport")?.classList.contains("is-widget-focus-mode")
      );
      await settle(page);
      assert.equal((await page.textContent(".n-zoomval")).trim(), "20%",
        "leaving Hardware Setup focus restores the exact overview zoom it entered from");
      assert.equal(await page.getAttribute(".forma-canvas-stage", "style"), entryCameraStyle,
        "leaving Hardware Setup restores pan and zoom rather than an intermediate one-shot reveal");
      await page.click('.n-selbar [data-nx="w-focus"]');
      await page.waitForFunction(() =>
        document.querySelector(".forma-canvas-viewport")?.classList.contains("is-widget-focus-mode")
      );
      assert.ok(Number.parseInt((await page.textContent(".n-zoomval")).trim(), 10) >= 68,
        "re-entering Hardware Setup reapplies its readable focus contract");

      const terminal = setup.locator('[data-nx="surface-qualification-terminal"]');
      const key = setup.locator('[data-nx="surface-qualification-key"]');
      const review = setup.locator('[data-nx="surface-encoder-review"]');
      assert.equal(await terminal.locator('option[value="1sw1"]').count(), 1);
      assert.match(await terminal.locator('option[value="1sw1"]').textContent(), /currently Unassigned/i);
      assert.equal(await review.isDisabled(), true);

      await terminal.selectOption("1sw1");
      await key.selectOption("A");
      assert.match(
        await setup.locator("[data-surface-qualification-selection]").textContent(),
        /P1 SW1.*Unassigned.*A.*Nothing is written until you review and confirm/i,
      );
      assert.equal(await review.isEnabled(), true,
        "one safe temporary assignment unlocks only the diff review");
      assert.equal(await setup.locator(".n-surface-control").count(), 0,
        "selecting the hardware terminal still does not create a canvas component");

      await review.click();
      const dialog = page.locator("dialog.n-panel-program-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.deepEqual(capturedPlan, {
        expected_selector: PANEL_SELECTOR,
        expected_base_sha256: PANEL_BASE_SHA,
        layout: "custom",
        edits: [{ terminal_id: "1sw1", normal_key: "A" }],
      });
      assert.match(
        (await dialog.textContent()).replace(/\s+/g, " "),
        /P1 SW1.*Unassigned.*A/i,
        "the first plan is exactly one reviewed terminal edit",
      );
      assert.deepEqual(hardwareWrites, [], "reviewing a plan does not write persistent hardware");
      assert.deepEqual(signalWrites, []);
      await dialog.locator('[data-panel-dialog-action="close"]').click();
      await dialog.waitFor({ state: "hidden" });
      await designPanelFirst.click();
      const surface = page.locator('.n-widget-surface');
      await surface.locator('.n-surface-starters').waitFor({ state: 'visible' });
      assert.equal(await surface.locator('.n-surface-control').count(), 0,
        "design-first leaves the empty hardware chart and physical canvas genuinely blank");
      await surface.locator('[data-surface-template="blank"]').click();
      assert.equal(await surface.locator('.n-surface-control').count(), 0);
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface')?.getAttribute('data-entry') === 'encoder-setup'
      );
      assert.equal(
        await surface.locator('[data-panel-journey-step="physical"]').getAttribute('data-state'),
        'active',
        "a started blank template is still awaiting its first real physical component",
      );
      await surface.locator('[data-nx="surface-encoder-close"]').click();
      await surface.locator('[data-nx="surface-new"]').click();
      const arcade = surface.locator('[data-surface-template="arcade-stick"]');
      await arcade.click();
      await arcade.click();
      assert.equal(await surface.locator('.n-surface-control').count(), 11,
        "the user can now model the wired cabinet before assigning any firmware output");
      assert.equal(chartReads, 1,
        "entering physical design preserves the complete chart already read from the board");
      assert.deepEqual(hardwareWrites, [],
        "choosing the panel shape never writes persistent I-PAC configuration");
      assert.deepEqual(signalWrites, [],
        "choosing the panel shape never fabricates a learned Windows signal");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("I-PAC hardware outputs treat unused terminals as an intentional partial chart", async () => {
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const response = await route.fetch();
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        for (const pad of payload.view?.pads ?? []) {
          pad.mapping_available = false;
          pad.macro_available = false;
          // Deliberately stale and relevant to the chart below: unavailable
          // authorities must win over their last successful payloads.
          pad.fn_keys = { A: "B" };
          const seed = pad.macros?.[0];
          if (seed) {
            pad.macros = [{ ...seed, triggers: ["B"], outputs: ["A"], disabled: false }];
          }
        }
        await route.fulfill({ response, json: payload });
      });
      await candidate.route("**/api/panel/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelStatusPayload()),
      }));
      await candidate.route("**/api/panel/chart", async (route) => {
        const payload = panelChartPayload();
        payload.view.terminals[1].normal = {
          code: 0,
          key: null,
          label: "Unassigned",
          supported: true,
        };
        payload.view.terminals[0].shifted = {
          code: 255,
          key: null,
          label: "Preserved vendor action",
          supported: false,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      const setup = page.locator('.n-widget-surface[data-entry="encoder-setup"]');
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface[data-entry="encoder-setup"] .n-surface-programming')
          ?.getAttribute("data-qualification") === "qualified");
      assert.match(
        (await setup.textContent()).replace(/\s+/g, " "),
        /Hardware outputs assigned.*Review the terminal-to-key chart and test the controls you wired.*1 of 2 terminals currently have a supported Windows key assignment.*Unused terminals may remain unassigned by design/i,
      );
      assert.match(
        (await encoderLane.locator(".n-dev-meta").textContent()).replace(/\s+/g, " "),
        /1\/2 outputs assigned/i,
      );
      assert.equal(
        await encoderLane.getByRole("button", { name: /Return to outputs.*Ultimarc I-PAC 4/i }).count(),
        1,
        "the rail returns to the already-open hardware-output workspace without judging unused terminals",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="physical"]').getAttribute("data-state"),
        "active",
        "a configured firmware chart does not invent a drawn or observed cabinet control",
      );
      assert.equal(await setup.locator(".n-surface-control").count(), 0);
      assert.equal(
        await setup.locator('[data-panel-journey-step="keys"]').getAttribute("data-state"),
        "complete",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="mapping"]').getAttribute("data-state"),
        "upcoming",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="controller"]').getAttribute("data-state"),
        "upcoming",
        "stale mapper and macro rows cannot falsely complete the controller journey",
      );
      assert.match(
        (await setup.locator("[data-surface-programming-device]").textContent()).replace(/\s+/g, " "),
        /0 hardware keys mapped/i,
        "unavailable mapper and macro authorities contribute no routed hardware keys",
      );
      assert.match(
        (await setup.locator("[data-panel-route-copy]").textContent()).replace(/\s+/g, " "),
        /Hardware output is only the source.*Build a physical panel view.*continue directly to KSX routing/i,
      );
      const advanced = setup.locator('[data-nx="surface-terminal-advanced"]');
      await advanced.check();
      const opaqueShifted = setup.locator(
        '[data-nx="surface-terminal-key"][data-panel-terminal="1sw1"][data-panel-field="shifted"]',
      );
      assert.equal(await opaqueShifted.inputValue(), "__preserve__");
      await opaqueShifted.selectOption("A");
      assert.equal(
        await opaqueShifted.locator('option[value="__preserve__"]').count(),
        1,
        "editing an opaque vendor plane keeps its lossless Preserve escape hatch",
      );
      await opaqueShifted.selectOption("__preserve__");
      assert.equal(await opaqueShifted.inputValue(), "__preserve__",
        "a deliberate key edit can be reverted to preserving the baseline byte");
      await setup.locator('[data-nx="surface-encoder-route"]').click();
      await page.waitForFunction(() =>
        !document.querySelector(".forma-canvas-viewport")?.classList.contains("is-widget-focus-mode") &&
        !document.querySelector(".n-right")?.classList.contains("rail"));
      assert.equal(await page.locator('.n-widget-surface[data-entry="encoder-setup"]').count(), 0,
        "Continue to routing leaves the optional hardware workspace and opens the mapping inspector");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("qualified I-PAC setup edits all 56 terminals and separates saved layouts from hardware writes", async () => {
    let chartReads = 0;
    let savedSpec = null;
    let plannedSpec = null;
    let learnGeneration = 760;
    let learnHitReady = false;
    let learnDevice = "";
    let learnSelector = "";
    const reenumeratedIpacMi00 =
      "USB\\VID_D209&PID_0430&MI_00\\7&FIXTURE-REENUMERATED&0&0000";
    const rawReenumeratedIpacChild =
      "HID\\VID_D209&PID_0430&MI_00\\8&FIXTURE-RAW-CHILD&0&0000";
    let encoderPresence = "present";
    let markMissingServed = () => {};
    let markReenumeratedServed = () => {};
    const missingServed = new Promise((resolve) => { markMissingServed = resolve; });
    const reenumeratedServed = new Promise((resolve) => { markReenumeratedServed = resolve; });
    const bindRequests = [];
    const terminals = [];
    for (let player = 1; player <= 4; player += 1) {
      for (const kind of PANEL_TERMINAL_KINDS) {
        const id = `${player}${kind}`;
        terminals.push({
          terminal_id: id,
          terminal_label: `P${player} ${kind.toUpperCase()}`,
          player,
          kind: kind.startsWith("sw") ? "button" : kind,
          normal: { code: 5, key: "B", label: "B", supported: true },
          shifted: { code: 0, key: null, label: "Unassigned", supported: true },
          shift_state: "disabled",
          is_shift: false,
        });
      }
    }
    const configuredTerminals = panelCanonicalRecommendedTerminals(terminals);
    terminals.splice(0, terminals.length, ...configuredTerminals);
    const savedProfile = {
      schema: "ksx-panel-hardware-profile-v1",
      profile_id: "four-player-saved",
      name: "Four player cabinet",
      description: "Portable semantic fixture",
      driver: "ultimarc-ipac4",
      protocol_profile: PANEL_PROTOCOL_PROFILE,
      terminal_signature: "fixture-terminal-signature",
      revision: "profile-revision-1",
      created_at: "2026-08-23T08:00:00-04:00",
      updated_at: "2026-08-23T08:00:00-04:00",
      terminals: terminals.map((terminal) => ({
        terminal_id: terminal.terminal_id,
        normal_key: "A",
        shifted_key: null,
        is_shift: false,
        allow_shared_key: true,
      })),
    };
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        if (encoderPresence === "present") {
          await route.continue();
          return;
        }
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        assert.equal(response.status(), 200);
        const payload = await response.json();
        if (encoderPresence === "missing") {
          payload.view.cap_selector = "";
          payload.view.cap_instance = "";
        } else {
          payload.view.cap_selector = PANEL_SELECTOR;
          payload.view.cap_instance = reenumeratedIpacMi00;
        }
        await route.fulfill({ response, json: payload });
        if (encoderPresence === "missing") markMissingServed();
        else markReenumeratedServed();
      });
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith("/api/bind")) {
          bindRequests.push(JSON.parse(request.postData() ?? "{}"));
        }
      });
      await candidate.route("**/api/learn/start", async (route) => {
        learnGeneration += 1;
        learnHitReady = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation: learnGeneration,
            remaining_ms: 10_000,
            device: null,
            key: null,
            error: null,
          }),
        });
      });
      await candidate.route("**/api/learn", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: learnHitReady ? "hit" : "listening",
            generation: learnGeneration,
            remaining_ms: learnHitReady ? null : 10_000,
            device: learnHitReady ? learnDevice : null,
            selector: learnHitReady ? learnSelector : null,
            key: learnHitReady ? "E" : null,
            error: null,
          }),
        });
      });
      await candidate.route("**/api/panel/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelStatusPayload()),
      }));
      await candidate.route("**/api/panel/chart", async (route) => {
        chartReads += 1;
        const payload = panelChartPayload();
        payload.view.terminals = terminals;
        payload.view.recommended_terminals = panelCanonicalRecommendedTerminals(terminals);
        payload.view.key_options = PANEL_CANONICAL_KEYS.map(([key, code]) => ({
          key,
          label: key,
          code,
          safe_for_qualification: /^[A-Z]$/u.test(key),
        }));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
      });
      await candidate.route("**/api/panel/backups", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          target_selector: PANEL_SELECTOR,
          unavailable: null,
          view: { summary: "One raw recovery image.", board_fingerprint: PANEL_FINGERPRINT, backups: [panelBackup()] },
        }),
      }));
      await candidate.route("**/api/panel/profiles", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          unavailable: null,
          refusal_code: null,
          remedy: null,
          view: {
            summary: "One portable hardware layout.",
            config_root: "C:\\fixture\\profiles",
            terminal_signature: "fixture-terminal-signature",
            profiles: [savedProfile],
          },
        }),
      }));
      await candidate.route("**/api/panel/profiles/save", async (route) => {
        savedSpec = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            unavailable: null,
            refusal_code: null,
            remedy: null,
            mutation: { state: "created", summary: "Saved Blank tournament panel.", profile_id: "new-profile", profile: null },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        plannedSpec = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan({ terminals: terminals.map((terminal) => terminal.terminal_id) })),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      const setup = page.locator(".n-widget-surface .n-surface-programming");
      await setup.locator(".n-surface-terminal-editor").waitFor({ state: "visible" });
      assert.equal(await setup.locator("[data-panel-terminal-row]").count(), 56);
      assert.equal(await setup.locator(".n-surface-terminal-player").count(), 4);
      assert.match(
        (await setup.textContent()).replace(/\s+/g, " "),
        /All hardware outputs assigned.*Use, test, or reconfigure the outputs.*All 56 terminals currently have supported Windows key outputs/i,
      );
      assert.deepEqual(
        await setup.locator("[data-panel-journey-step] strong").allTextContents(),
        ["Panel control", "I-PAC 4X", "Host signal", "KSX transform", "Virtual controller", "Game"],
      );
      assert.match(
        (await setup.locator(".n-surface-programming-modes").textContent()).replace(/\s+/g, " "),
        /Use current outputs.*KSX four-player/i,
      );
      assert.equal(
        await setup.locator('.n-surface-programming-modes [data-surface-programming-mode="blank"]').count(),
        0,
        "the destructive clear action is not presented as an ordinary starting layout",
      );
      const advancedHardware = setup.locator("details.n-surface-programming-advanced");
      assert.equal(await advancedHardware.getAttribute("open"), null);
      const clearOutputs = advancedHardware.locator('[data-surface-programming-mode="blank"]');
      assert.equal(await clearOutputs.isHidden(), true,
        "Disable all outputs stays behind an explicitly named advanced disclosure");
      assert.equal(await setup.locator(".n-surface-programming-recovery").getAttribute("open"), null,
        "raw recovery history stays collapsed during normal profile authoring");

      const recommended = setup.locator('[data-surface-programming-mode="recommended"]');
      const keepCurrent = setup.locator('[data-surface-programming-mode="keep-current"]');
      await recommended.click();
      assert.equal(await setup.locator("[data-panel-terminal-row]").count(), 56,
        "the recommendation is a full semantic preview rather than a promise hidden behind Apply");
      assert.equal(
        await setup.locator('[data-panel-terminal="1up"][data-panel-field="normal"]').inputValue(),
        "A",
      );
      assert.equal(
        await setup.locator('[data-panel-terminal="1sw1"][data-panel-field="normal"]').inputValue(),
        "E",
      );
      assert.equal(
        await setup.locator('[data-panel-terminal="4coin"][data-panel-field="normal"]').inputValue(),
        "F10",
      );
      assert.equal(
        await setup.locator('[data-panel-terminal][data-panel-field="normal"]:disabled').count(),
        56,
        "the backend-owned recommendation is exact but read-only until the reviewed canonical plan is chosen",
      );
      assert.match(
        (await setup.locator("[data-surface-terminal-note]").textContent()).replace(/\s+/g, " "),
        /Exact preview from the backend.*56 unique Windows key signals.*Review this table before programming/i,
      );

      await keepCurrent.click();
      const firstNormal = setup.locator(
        '[data-panel-terminal="1up"][data-panel-field="normal"]',
      );
      await firstNormal.focus();
      await firstNormal.press("Escape");
      assert.equal(await page.locator(".forma-canvas-viewport.is-widget-focus-mode").count(), 0,
        "one Escape from a Hardware Setup select exits canvas focus mode");
      await page.click('.n-selbar [data-nx="w-focus"]');
      await page.waitForFunction(() =>
        document.querySelector(".forma-canvas-viewport")?.classList.contains("is-widget-focus-mode"));
      assert.ok(Number.parseInt((await page.textContent(".n-zoomval")).trim(), 10) >= 68,
        "the shared Focus command preserves Hardware Setup's readable minimum");
      const reentryViewport = await page.locator(".forma-canvas-viewport").boundingBox();
      const reentryJourney = await setup.locator(".n-panel-signal-journey").boundingBox();
      assert.ok(reentryViewport && reentryJourney &&
        reentryJourney.y >= reentryViewport.y - 1 &&
        reentryJourney.y < reentryViewport.y + reentryViewport.height,
      "Focus re-entry starts the oversized hardware form at step 1");
      const lastNormal = setup.locator(
        '[data-panel-terminal="4coin"][data-panel-field="normal"]',
      );
      await lastNormal.focus();
      await page.waitForFunction(() => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const target = document.activeElement?.getBoundingClientRect();
        return Boolean(viewport && target && target.top >= viewport.top && target.bottom <= viewport.bottom);
      });
      assert.equal(await lastNormal.evaluate((element) => document.activeElement === element), true,
        "keyboard focus remains on the lower hardware control while the camera reveals it");
      await firstNormal.focus();
      await page.waitForFunction(() => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const target = document.activeElement?.getBoundingClientRect();
        return Boolean(viewport && target && target.top >= viewport.top && target.bottom <= viewport.bottom);
      });
      assert.equal(await firstNormal.evaluate((element) => document.activeElement === element), true,
        "reverse keyboard focus reveals the upper hardware control without losing focus");

      await firstNormal.selectOption("B");
      assert.equal(
        (await setup.locator('[data-nx="surface-encoder-test"]').textContent()).trim(),
        "Test current board",
      );
      assert.match(
        (await setup.locator("[data-panel-output-test-copy]").textContent()).replace(/\s+/g, " "),
        /draft is not written.*Test current board.*outputs that are on the I-PAC(?: 4X?)? now/i,
        "a wiring test cannot be mistaken for testing an unwritten draft",
      );

      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        !document.querySelector(".forma-canvas-viewport")?.classList.contains("is-widget-focus-mode")
      );
      encoderPresence = "missing";
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await missingServed;
      await setup.waitFor({ state: "hidden" });
      encoderPresence = "reenumerated";
      await page.evaluate(() => {
        const form = document.querySelector('form:has(input[name="fresh"])');
        form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await reenumeratedServed;
      await page.locator('.n-widget-surface [data-nx="surface-encoder-open"]')
        .waitFor({ state: "visible" });
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await setup.locator(".n-surface-terminal-editor").waitFor({ state: "visible" });
      assert.equal(await firstNormal.inputValue(), "B",
        "a transient encoder loss and same-board re-enumeration recover its dirty draft");
      assert.match(
        (await setup.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "),
        /Recovered your unsaved 56-terminal draft for this exact I-PAC.*fresh read did not change the board/i,
      );

      let discardPrompt = "";
      page.once("dialog", async (dialog) => {
        discardPrompt = dialog.message();
        await dialog.dismiss();
      });
      await recommended.click();
      assert.match(discardPrompt, /Discard the unsaved 56-terminal draft changes.*KSX four-player/i);
      assert.equal(await firstNormal.inputValue(), "B",
        "declining a source replacement preserves every dirty terminal edit");
      const readsBeforeDeclinedReread = chartReads;
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /Discard the unsaved 56-terminal draft changes.*read the board again/i);
        await dialog.dismiss();
      });
      await setup.locator('[data-nx="surface-encoder-read"]').click();
      assert.equal(chartReads, readsBeforeDeclinedReread,
        "declining Read board again performs no chart request");
      assert.equal(await firstNormal.inputValue(), "B");
      page.once("dialog", (dialog) => dialog.accept());
      await recommended.click();
      assert.equal(await firstNormal.inputValue(), "A",
        "accepting the explicit discard replaces the draft with the chosen source");
      assert.match(
        await page.locator('.n-widget-kb .n-ipac-signal[data-key="E"] span').textContent(),
        /1SW1.*P1 SW1/i,
        "the canvas source names the physical terminal id users see on the I-PAC silkscreen",
      );
      learnDevice = "HID\\VID_046D&PID_C31C&MI_00\\9&DESK-KEYBOARD&0&0000";
      learnSelector = "usb:046d:c31c:00";
      await setup.locator('[data-nx="surface-encoder-test"]').click();
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      learnHitReady = true;
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.match(
        (await setup.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "),
        /Ignored E.*did not resolve to the exact selected I-PAC/i,
        "Test wiring rejects a desk-keyboard hit before it can impersonate an encoder terminal",
      );
      assert.equal(await setup.locator('[data-panel-signal-terminal][data-hit="true"]').count(), 0);

      learnDevice = rawReenumeratedIpacChild;
      learnSelector = PANEL_SELECTOR;
      assert.ok(learnDevice, "the passive wiring test accepts the I-PAC Raw Input child through its canonical selector");
      await setup.locator('[data-nx="surface-encoder-test"]').click();
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      assert.match(
        (await page.locator(".n-learnbar").textContent()).replace(/\s+/g, " "),
        /Test I-PAC output.*no mapping changes/i,
      );
      await page.locator('.n-widget-kb .n-ipac-signal[data-key="E"]').evaluate(
        (element) => element.click(),
      );
      assert.equal(await page.locator(".n-learnbar.listen").count(), 1,
        "clicking the drawing cannot impersonate a physical I-PAC report");
      assert.match(await page.textContent(".n-live-sr"), /only clicked in the drawing.*no mapping was changed/i);
      assert.deepEqual(bindRequests, [],
        "a drawn signal can never invoke the binding route during passive wiring test");
      learnHitReady = true;
      await page.waitForFunction(() =>
        document.querySelector("[data-panel-output-test-status]")?.textContent?.includes("1sw1 emitted E"));
      assert.equal(
        await setup.locator('[data-panel-signal-terminal="1sw1"]').getAttribute("data-hit"),
        "true",
        "a real observed key resolves back to every matching terminal chip",
      );
      assert.deepEqual(bindRequests, [],
        "Test wiring observes the I-PAC signal without creating or changing any KSX binding");

      await keepCurrent.click();
      await firstNormal.selectOption("B");
      await setup.locator("[data-surface-profile]").selectOption(savedProfile.profile_id);
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /Discard the unsaved 56-terminal draft changes.*Four player cabinet/i);
        await dialog.dismiss();
      });
      await setup.locator('[data-nx="surface-profile-use"]').click();
      assert.equal(await firstNormal.inputValue(), "B",
        "declining a saved-layout replacement preserves the dirty draft");
      page.once("dialog", (dialog) => dialog.accept());
      await setup.locator('[data-nx="surface-profile-use"]').click();
      assert.equal(await setup.locator('[data-panel-terminal="1up"][data-panel-field="normal"]').inputValue(), "A");
      assert.match(await setup.locator("[data-surface-terminal-status]").textContent(), /Four player cabinet.*not written/i);

      await advancedHardware.locator("summary").click();
      assert.equal(await clearOutputs.isVisible(), true);
      await clearOutputs.click();
      assert.equal(await setup.locator('[data-panel-terminal="1up"][data-panel-field="normal"]').inputValue(), "");
      await setup.locator("[data-surface-profile-name]").fill("Blank tournament panel");
      await setup.locator('[data-nx="surface-profile-save"]').click();
      await page.waitForFunction(() => window.document.querySelector(
        '.n-widget-surface [data-surface-profiles-summary]',
      )?.textContent?.includes("saved layout"));
      assert.equal(savedSpec.name, "Blank tournament panel");
      assert.equal(savedSpec.terminals.length, 56);
      assert.equal(savedSpec.terminals.every((terminal) => terminal.normal_key === null), true);
      assert.equal("expected_selector" in savedSpec, false,
        "saving a portable layout never stages or writes selected hardware");

      await setup.locator('[data-nx="surface-encoder-review"]').click();
      await page.locator("dialog.n-panel-program-dialog").waitFor({ state: "visible" });
      assert.deepEqual(plannedSpec, {
        expected_selector: PANEL_SELECTOR,
        expected_base_sha256: PANEL_BASE_SHA,
        layout: "blank",
        edits: [],
      });
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Encoder setup keeps three workflow stages and closes the persisted Teach crash window before a mocked write", async () => {
    let chartReads = 0;
    let capturedPlan = null;
    let capturedApply = null;
    let learnGeneration = 880;
    let taughtDevice = "";
    let taughtKey = "B";
    let applyRequests = 0;
    let applyDisposition = "not-started";
    let peer = null;
    let learnPeer = null;
    let coldPeer = null;
    let peerChartReads = 0;
    let legacyPeerBindRequests = 0;
    const peerNoise = [];
    const learnPeerNoise = [];
    const coldPeerNoise = [];
    let markApplyStarted = () => {};
    let releaseApply = () => {};
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const applyGate = new Promise((resolve) => {
      releaseApply = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.addInitScript(() => {
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function setItem(key, value) {
          if (this === localStorage && key === "ksx-nocturne-control-surfaces1" &&
              sessionStorage.getItem("ksx-pwtest-refuse-prewrite-surface-save") === "1") {
            throw new DOMException("storage refused", "QuotaExceededError");
          }
          return originalSetItem.call(this, key, value);
        };
      });
      await candidate.route("**/api/learn/start", async (route) => {
        learnGeneration += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation: learnGeneration,
            remaining_ms: 10_000,
            device: null,
            key: null,
            error: null,
          }),
        });
      });
      await candidate.route("**/api/learn", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "hit",
            generation: learnGeneration,
            remaining_ms: null,
            device: taughtDevice,
            key: taughtKey,
            error: null,
          }),
        });
      });
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        chartReads += 1;
        const first = chartReads === 1;
        const body = JSON.parse(route.request().postData() ?? "{}");
        assert.equal(body.expected_selector, PANEL_SELECTOR);
        assert.equal(body.backup, first || applyDisposition === "not-started",
          "explicit setup/recovery reads create restore points; post-verify refresh does not duplicate one");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({
            imageSha256: applyDisposition === "verified" ? PANEL_DESIRED_SHA : PANEL_BASE_SHA,
            backup: body.backup ? panelBackup() : null,
          })),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        assert.equal(route.request().method(), "GET");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [panelBackup()],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        capturedPlan = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan()),
        });
      });
      await candidate.route("**/api/panel/program/apply", async (route) => {
        applyRequests += 1;
        capturedApply = JSON.parse(route.request().postData() ?? "{}");
        if (applyDisposition === "not-started") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              target_selector: PANEL_SELECTOR,
              hardware_epoch: capturedApply.hardware_epoch,
              unavailable: "The encoder became busy before the first packet.",
              refusal_code: "panel-busy",
              remedy: "Close the competing utility, then review again.",
              mutation_disposition: "not-started",
              outcome: null,
            }),
          });
          return;
        }
        markApplyStarted();
        await applyGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            hardware_epoch: capturedApply.hardware_epoch,
            unavailable: null,
            refusal_code: null,
            remedy: null,
            mutation_disposition: "verified",
            outcome: {
              state: "verified",
              summary: "The complete chart was written and read back byte-for-byte.",
              board_fingerprint: PANEL_FINGERPRINT,
              expected_sha256: PANEL_DESIRED_SHA,
              observed_sha256: PANEL_DESIRED_SHA,
              backup: panelBackup(),
              verified_at: "2026-08-23T00:31:00-04:00",
              next_step: "Teach every physical control to verify what Windows receives.",
            },
          }),
        });
      });
    });
    const storedBoardVerifications = () => page.evaluate((boardFingerprint) => {
      const value = JSON.parse(
        localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
      );
      return Object.values(value?.devices ?? {}).flatMap((surface) =>
        (surface.controls ?? []).flatMap((control) =>
          (control.channels ?? [])
            .filter((channel) => channel.encoder?.boardFingerprint === boardFingerprint)
            .map((channel) => ({
              terminal: channel.encoder.terminalId,
              verification: channel.encoder.verification,
            })),
        ),
      );
    }, PANEL_FINGERPRINT);
    const storedUnlinkedObservations = () => page.evaluate((device) => {
      const value = JSON.parse(
        localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
      );
      return Object.values(value?.devices ?? {}).flatMap((surface) =>
        (surface.controls ?? []).flatMap((control) =>
          (control.channels ?? [])
            .filter((channel) => !channel.encoder && channel.input?.kind === "keyboard" &&
              channel.input.device?.toLocaleUpperCase() === device.toLocaleUpperCase())
            .map((channel) => channel.input.key),
        ),
      );
    }, taughtDevice);
    const storedHardwareEpoch = () => page.evaluate((device) => {
      const normalized = device.trim().toLocaleUpperCase();
      const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(normalized)}`;
      return {
        key,
        record: JSON.parse(localStorage.getItem(key) ?? "null"),
      };
    }, taughtDevice);

    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      assert.equal(await page.locator(".n-widget-surface .n-surface-control").count(), 3);

      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-capability") === "programmable");
      assert.equal(await page.locator(".n-widget-surface .n-surface-stage").count(), 3,
        "Encoder setup is optional within the workflow, not a fourth permanent stage");
      assert.equal(chartReads, 1);
      assert.equal(
        await page.locator(
          '.n-widget-surface [data-surface-programming-mode="recommended"]',
        ).isEnabled(),
        true,
        "the full canonical layout unlocks only for a backend-qualified writer",
      );
      await page.click('.n-widget-surface [data-surface-programming-mode="custom"]');

      const controls = page.locator(".n-widget-surface .n-surface-control");
      assert.equal(new Set(await controls.evaluateAll((items) => items.map(
        (item) => item.getAttribute("data-physical-id"),
      ))).size, 3, "the regression uses three distinct physical drawings");
      const terminalSelect = page.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]');
      const keySelect = page.locator('.n-widget-surface [data-nx="surface-encoder-key"]');
      const sharedKey = page.locator('.n-widget-surface [data-nx="surface-encoder-share"]');
      await controls.nth(0).click();
      await terminalSelect.selectOption("1sw1");
      taughtDevice = await page.evaluate(() => JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view?.cap_instance ?? "");
      assert.ok(taughtDevice, "Teach is pinned to the selected I-PAC Windows device");
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-encoder-verification')
          ?.getAttribute("data-state") === "matched");
      await keySelect.selectOption("A");
      assert.equal(
        await page.locator('.n-widget-surface .n-surface-encoder-verification').getAttribute("data-state"),
        "unverified",
        "a future draft key clears stale Teach evidence instead of manufacturing a mismatch",
      );
      assert.doesNotMatch(
        await page.locator('.n-widget-surface .n-surface-encoder-verification').textContent(),
        /different key|check the wiring|restore the chart/i,
      );
      const plannedKeycap = page.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          '[data-verification="planned"] .n-surface-signal-keycap',
      ).first();
      assert.equal(await plannedKeycap.getAttribute("data-configured-key"), "B");
      assert.equal(await plannedKeycap.getAttribute("data-planned-key"), "A");
      assert.equal(await plannedKeycap.getAttribute("data-flow-key"), "B",
        "an unwritten draft keeps the route on the key the current chart actually emits");
      assert.equal(await plannedKeycap.getAttribute("data-flow-authority"), "configured");
      assert.equal(await plannedKeycap.getAttribute("data-key"), null,
        "the invalidated historical Teach value is not exposed as current route evidence");
      assert.match((await plannedKeycap.textContent()).replace(/\s+/g, " "), /B.*→.*A.*PLAN/i);
      assert.doesNotMatch(await plannedKeycap.textContent(), /✓/,
        "equal-looking retained strings can never recreate verification after invalidation");

      const terminalTableKey = page.locator(
        '.n-widget-surface [data-nx="surface-terminal-key"][data-panel-terminal="1sw1"][data-panel-field="normal"]',
      );
      const terminalTableShared = page.locator(
        '.n-widget-surface [data-nx="surface-terminal-shared"][data-panel-terminal="1sw1"]',
      );
      await terminalTableKey.selectOption("B");
      assert.equal(await keySelect.inputValue(), "B",
        "the complete terminal table updates an already-linked canvas control");

      await controls.nth(1).click();
      await terminalSelect.selectOption("1sw1");
      assert.equal(await keySelect.inputValue(), "B",
        "a second drawing inherits the terminal table's canonical key");
      assert.equal(await terminalTableKey.inputValue(), "B",
        "linking another view cannot overwrite the canonical terminal draft");
      await terminalTableShared.check();
      assert.equal(await sharedKey.isChecked(), true,
        "terminal-table consent is reflected by every linked drawing");
      await controls.nth(0).click();
      assert.equal(await sharedKey.isChecked(), true);
      await sharedKey.uncheck();
      assert.equal(await terminalTableShared.isChecked(), false,
        "canvas consent updates the one canonical terminal row");
      await controls.nth(1).click();
      assert.equal(await sharedKey.isChecked(), false,
        "shared-key consent cannot diverge between views of one terminal");
      await keySelect.selectOption("A");
      await controls.nth(0).click();
      assert.equal(await keySelect.inputValue(), "A",
        "editing one drawing synchronizes every control linked to that terminal");
      assert.match(
        await page.locator(".n-widget-surface [data-surface-programming-summary]").textContent(),
        /all 2 linked controls/i,
      );

      // Return to two distinct terminals deliberately sharing A so the rest of
      // this test continues through the existing fan-in consent path.
      await sharedKey.check();
      await controls.nth(1).click();
      assert.equal(await keySelect.inputValue(), "A");
      await terminalSelect.selectOption("1sw2");
      await keySelect.selectOption("A");
      await sharedKey.check();
      taughtKey = "Escape";
      await controls.nth(0).click();
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-encoder-verification')
          ?.getAttribute("data-state") === "mismatch");
      const freshMismatchKeycap = page.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          '[data-verification="mismatch"] .n-surface-signal-keycap',
      ).first();
      assert.equal(await freshMismatchKeycap.getAttribute("data-configured-key"), "B");
      assert.equal(await freshMismatchKeycap.getAttribute("data-planned-key"), "A",
        "fresh Teach evidence does not erase the separately pending hardware draft");
      assert.equal(await freshMismatchKeycap.getAttribute("data-flow-key"), "Escape");
      assert.equal(await freshMismatchKeycap.getAttribute("data-flow-authority"), "mismatch");
      assert.equal(await freshMismatchKeycap.getAttribute("data-key"), "Escape",
        "the signal Windows just observed outranks an unwritten draft for routing");
      assert.match(
        (await page.locator('.n-widget-surface .n-surface-encoder-verification').textContent())
          .replace(/\s+/g, " "),
        /observed Escape.*current board key B.*draft still plans A.*not written/i,
      );
      assert.ok(
        (await storedBoardVerifications()).some((channel) => channel.verification === "mismatch"),
        "the apply boundary starts with durable pre-write Teach evidence",
      );
      taughtKey = "Tab";
      await controls.nth(2).click();
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').click();
      await page.waitForFunction((device) => {
        const value = JSON.parse(
          localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
        );
        return Object.values(value?.devices ?? {}).some((surface) =>
          (surface.controls ?? []).some((control) =>
            (control.channels ?? []).some((channel) =>
              !channel.encoder && channel.input?.kind === "keyboard" &&
              channel.input.key === "Tab" &&
              channel.input.device?.toLocaleUpperCase() === device.toLocaleUpperCase()),
          ),
        );
      }, taughtDevice);
      assert.deepEqual(await storedUnlinkedObservations(), ["Tab"],
        "the regression begins with one durable Teach observation outside the terminal chart");

      const review = page.locator('.n-widget-surface [data-nx="surface-encoder-review"]');
      assert.equal(await review.isEnabled(), true, "deliberate fan-in resolves the otherwise-blocking shared-key conflict");
      await review.click();
      const dialog = page.locator("dialog.n-panel-program-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.equal(capturedPlan.layout, "custom");
      assert.equal(capturedPlan.expected_base_sha256, PANEL_BASE_SHA);
      assert.deepEqual(capturedPlan.edits, [
        { terminal_id: "1sw1", normal_key: "A", shifted_key: "", is_shift: false, allow_shared_key: true },
        { terminal_id: "1sw2", normal_key: "A", shifted_key: "", is_shift: false, allow_shared_key: true },
      ]);
      const apply = dialog.locator('[data-panel-dialog-action="apply"]');
      assert.equal(await apply.isDisabled(), true, "a backend plan alone grants no write consent");
      await dialog.locator("[data-panel-program-confirm]").check();
      assert.equal(await apply.isDisabled(), true,
        "exact-diff consent alone does not claim physical recovery readiness");
      await dialog.locator("[data-panel-program-supervised]").check();
      assert.equal(await apply.isEnabled(), true,
        "the write unlocks only after exact-diff and supervised-recovery consent");
      await page.evaluate(() => {
        sessionStorage.setItem("ksx-pwtest-refuse-prewrite-surface-save", "1");
      });
      await apply.click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-panel-program-dialog .n-panel-program-review-status")
          ?.textContent?.includes("Nothing was written"));
      assert.equal(applyRequests, 0,
        "the hardware request is refused when pre-write invalidation cannot be persisted");
      assert.equal(await dialog.getAttribute("data-phase"), "idle");
      assert.match(await dialog.textContent(), /browser storage is unavailable.*Nothing was written/i);
      assert.match(await page.locator(".n-live-sr").textContent(), /Nothing was written/i,
        "the storage refusal is announced as well as rerendered in the review");
      assert.ok(
        (await storedBoardVerifications()).some((channel) => channel.verification === "mismatch"),
        "a failed localStorage write cannot pretend that the saved Teach evidence was cleared",
      );
      assert.deepEqual(await storedUnlinkedObservations(), ["Tab"],
        "a failed localStorage write leaves the durable unlinked observation untouched and refuses USB");

      await page.evaluate(() => {
        sessionStorage.removeItem("ksx-pwtest-refuse-prewrite-surface-save");
      });
      await dialog.locator("[data-panel-program-confirm]").check();
      await dialog.locator("[data-panel-program-supervised]").check();
      await apply.click();
      await page.waitForFunction(() =>
        document.querySelector("dialog.n-panel-program-dialog .n-panel-program-review-status")
          ?.textContent?.includes("first packet"));
      assert.equal(applyRequests, 1);
      assert.equal(await dialog.getAttribute("data-phase"), "idle");
      assert.ok(
        (await storedBoardVerifications()).every((channel) => channel.verification === "unverified"),
        "not-started cannot restore Teach because another tab may own the hardware lease",
      );
      assert.deepEqual(await storedUnlinkedObservations(), [],
        "a refused request keeps exact-device unlinked observations retired");
      assert.match(await dialog.textContent(), /Teach evidence remains retired/i);

      // A machine-global busy refusal proves only that this request did not
      // start; it does not prove that another process left the board unchanged.
      // The initiating tab must read the current chart before it can Teach.
      await dialog.locator('[data-panel-dialog-action="close"]').click();
      assert.equal(
        await page.locator('.n-widget-surface [data-nx="surface-teach"]').isDisabled(),
        true,
        "not-started remains fail-closed until a complete current-chart read",
      );
      await page.waitForFunction(async () => !(await navigator.locks.query()).held.some(
        (lock) => lock.name.startsWith("ksx-panel-hardware-v1:"),
      ));
      page.once("dialog", (confirmation) => confirmation.accept());
      const recoveryRead = page.waitForRequest("**/api/panel/chart");
      await page.locator('.n-widget-surface [data-nx="surface-encoder-read"]').click();
      await recoveryRead;
      await page.waitForFunction(() => document.querySelector(
        '.n-widget-surface .n-surface-programming',
      )?.getAttribute("data-capability") === "programmable");
      assert.equal(chartReads, 2,
        (await page.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "));
      await page.click('.n-widget-surface [data-surface-programming-mode="custom"]');
      await controls.nth(0).click();
      await terminalSelect.selectOption("1sw1");
      await keySelect.selectOption("A");
      await sharedKey.check();
      await controls.nth(1).click();
      await terminalSelect.selectOption("1sw2");
      await keySelect.selectOption("A");
      await sharedKey.check();

      // Only the post-read physical observations regain routing authority.
      taughtKey = "Escape";
      await controls.nth(0).click();
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-encoder-verification')
          ?.getAttribute("data-state") === "mismatch");
      taughtKey = "Tab";
      await controls.nth(2).click();
      await page.locator('.n-widget-surface [data-nx="surface-teach"]').click();
      await page.waitForFunction((device) => {
        const value = JSON.parse(
          localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null",
        );
        return Object.values(value?.devices ?? {}).some((surface) =>
          (surface.controls ?? []).some((control) =>
            (control.channels ?? []).some((channel) =>
              !channel.encoder && channel.input?.kind === "keyboard" &&
              channel.input.key === "Tab" &&
              channel.input.device?.toLocaleUpperCase() === device.toLocaleUpperCase()),
          ),
        );
      }, taughtDevice);
      await review.click();
      await dialog.waitFor({ state: "visible" });

      await page.evaluate((device) => {
        const key = "ksx-nocturne-control-surfaces1";
        const store = JSON.parse(localStorage.getItem(key) ?? "null");
        const current = Object.values(store?.devices ?? {})[0];
        const staleControls = (current?.controls ?? []).flatMap((control) => {
          const channels = (control.channels ?? []).filter((channel) =>
            !channel.encoder && channel.input?.kind === "keyboard" &&
            channel.input.device?.toLocaleUpperCase() === device.toLocaleUpperCase()
          );
          return channels.length > 0 ? [{ ...control, channels }] : [];
        });
        store.devices["keyboard:stored-sibling-surface"] = {
          ...current,
          name: "Stored sibling surface",
          controls: staleControls,
          selectedControlId: staleControls[0]?.id ?? "",
          selectedChannelId: staleControls[0]?.channels?.[0]?.id ?? "",
        };
        localStorage.setItem(key, JSON.stringify(store));
      }, taughtDevice);
      assert.deepEqual((await storedUnlinkedObservations()).sort(), ["Tab", "Tab"],
        "the fixture carries the same stale exact-device observation in another stored surface");

      // A second tab is the dangerous case: it owns an in-memory copy of the
      // exact-instance Teach evidence before this tab begins programming. A
      // later whole-store save from that tab must never resurrect the old
      // Windows observation after the encoder chart may have changed.
      const peerOpened = page.waitForEvent("popup");
      await page.evaluate(() => window.open("about:blank", "_blank"));
      peer = await peerOpened;
      peer.on("pageerror", (error) => peerNoise.push(`pageerror: ${error.stack ?? error}`));
      peer.on("console", (message) => {
        if (message.type() === "error") peerNoise.push(`console: ${message.text()}`);
      });
      await peer.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await peer.route("**/api/panel/chart", async (route) => {
        peerChartReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({
            imageSha256: PANEL_DESIRED_SHA,
            backup: null,
          })),
        });
      });
      await peer.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await peer.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null, { timeout: 20_000 });
      await settle(peer);
      await peer.click('[data-nx="surface-open"]');
      await peer.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      const stalePeerKeycap = peer.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          ' .n-surface-signal-keycap',
      ).first();
      await stalePeerKeycap.waitFor({ state: "visible" });
      assert.equal(await stalePeerKeycap.getAttribute("data-flow-key"), "Escape");
      assert.equal(await stalePeerKeycap.getAttribute("data-key"), "Escape",
        "the peer really begins with the old exact-instance Teach authority");
      const stalePreWriteStore = await page.evaluate(() =>
        localStorage.getItem("ksx-nocturne-control-surfaces1"));
      assert.ok(stalePreWriteStore, "the cold-document regression captures a real stale surface document");
      await stalePeerKeycap.click();
      const peerRoute = peer.locator('.n-widget-surface [data-nx="surface-route"]');
      assert.equal(await peerRoute.isEnabled(), true);
      await peerRoute.click();
      assert.ok(await peer.locator(".n-widget-surface .n-surface-control.assign").count() > 0,
        "the peer also begins with a stale armed route awaiting a pad click");

      // The contextual compatibility mapper is a second route into the same
      // selected encoder. Keep one ordinary binding Learn active in another
      // document so the pending epoch must retire both old and new UI paths.
      // `openCanvas` uses Playwright's one-page convenience context, which
      // deliberately refuses `context.newPage()`. Open a real sibling window
      // instead: it shares this origin's localStorage, exactly like the two
      // Studio tabs whose storage-event ordering this regression exercises.
      const learnPeerOpened = peer.waitForEvent("popup");
      await peer.evaluate(() => window.open("about:blank", "_blank"));
      learnPeer = await learnPeerOpened;
      learnPeer.on("pageerror", (error) => learnPeerNoise.push(`pageerror: ${error.stack ?? error}`));
      learnPeer.on("console", (message) => {
        if (message.type() === "error") learnPeerNoise.push(`console: ${message.text()}`);
      });
      let legacyLearnGeneration = 990;
      await learnPeer.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await learnPeer.route("**/api/panel/chart", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({
            imageSha256: PANEL_BASE_SHA,
            backup: null,
          })),
        });
      });
      await learnPeer.route("**/api/learn/start", async (route) => {
        legacyLearnGeneration += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation: legacyLearnGeneration,
            remaining_ms: 10_000,
            device: null,
            key: null,
            error: null,
          }),
        });
      });
      await learnPeer.route("**/api/learn", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            state: "listening",
            generation: legacyLearnGeneration,
            remaining_ms: 10_000,
            device: null,
            key: null,
            error: null,
          }),
        });
      });
      await learnPeer.route("**/nocturne/api/bind", async (route) => {
        legacyPeerBindRequests += 1;
        await route.fulfill({ status: 500, body: "stale encoder Learn must not bind" });
      });
      await learnPeer.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await learnPeer.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null, { timeout: 20_000 });
      await settle(learnPeer);
      const learnPeerSetup = learnPeer.locator(
        '.n-widget-surface [data-nx="surface-encoder-open"]',
      );
      await learnPeer.waitForFunction(() => {
        const surface = document.querySelector(".n-widget-surface");
        const ready = surface?.querySelector(".n-surface-hardware")
          ?.getAttribute("data-state") === "ready";
        const programmable = surface?.querySelector(".n-surface-programming")
          ?.getAttribute("data-capability") === "programmable";
        return ready && (surface?.getAttribute("data-entry") === "builder" || programmable);
      });
      if (await learnPeer.locator(".n-widget-surface").getAttribute("data-entry") !== "encoder-setup") {
        await learnPeerSetup.evaluate((button) => button.click());
      }
      await learnPeer.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable");
      await learnPeer.locator(
        '.n-widget-surface [data-nx="surface-encoder-close"]',
      ).click();
      await learnPeer.click('[data-nx="auto-map"]');
      await learnPeer.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("listen"));

      applyDisposition = "verified";
      await dialog.locator("[data-panel-program-confirm]").check();
      await dialog.locator("[data-panel-program-supervised]").check();
      await apply.click();
      await applyStarted;
      assert.equal(applyRequests, 2);
      const expectedHardwareLocks = [
        `ksx-panel-hardware-v1:board:${PANEL_FINGERPRINT.toLocaleUpperCase()}`,
        `ksx-panel-hardware-v1:device:${taughtDevice.toLocaleUpperCase()}`,
      ].sort();
      const duringWriteLocks = await page.evaluate(async () => {
        const snapshot = await navigator.locks.query();
        const ours = (locks) => locks.map((lock) => lock.name)
          .filter((name) => name.startsWith("ksx-panel-hardware-v1:"))
          .sort();
        return { held: ours(snapshot.held), pending: ours(snapshot.pending) };
      });
      assert.deepEqual(duringWriteLocks.held, expectedHardwareLocks,
        "the in-flight request owns both its stable-board and exact-device Web Locks");
      assert.deepEqual(duringWriteLocks.pending, [],
        "ifAvailable contention never leaves a hidden queued hardware action");
      const pendingHardwareEpoch = await storedHardwareEpoch();
      assert.equal(pendingHardwareEpoch.record?.version, 2);
      assert.equal(pendingHardwareEpoch.record?.device, taughtDevice.toLocaleUpperCase());
      assert.equal(pendingHardwareEpoch.record?.boardFingerprint, PANEL_FINGERPRINT.toLocaleUpperCase());
      assert.equal(pendingHardwareEpoch.record?.selector, PANEL_SELECTOR.toLocaleUpperCase());
      assert.equal(pendingHardwareEpoch.record?.phase, "pending",
        "the durable sidecar records an unresolved hardware transaction before packet completion");
      assert.ok(pendingHardwareEpoch.record?.epoch);
      await peer.waitForFunction(() => {
        const keycap = document.querySelector(
          '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
            ' .n-surface-signal-keycap',
        );
        return keycap !== null && keycap.getAttribute("data-key") === null &&
          keycap.getAttribute("data-flow-key") !== "Escape";
      }, null, { timeout: 10_000 });
      assert.equal(await stalePeerKeycap.getAttribute("data-key"), null,
        "the hardware epoch invalidates another tab before the write response arrives");
      assert.notEqual(await stalePeerKeycap.getAttribute("data-flow-key"), "Escape",
        "a storage event removes stale routing authority from the peer's live DOM");
      assert.equal(await peer.locator(".n-widget-surface .n-surface-control.assign").count(), 0,
        "the hardware epoch cancels an armed stale route before it can reach a pad");
      assert.equal(await peer.locator(".n-learnbar").evaluate((bar) => bar.classList.contains("none")), true,
        "the peer's global assign affordance closes with the retired authority");
      await learnPeer.waitForFunction(() =>
        document.querySelector(".n-learnbar")?.classList.contains("none"), null,
      { timeout: 10_000 });
      assert.equal(legacyPeerBindRequests, 0,
        "a pending encoder epoch retires an ordinary compatibility Learn before it can bind");
      await peer.locator('.n-widget-surface [data-nx="surface-teach"]').evaluate((button) =>
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      assert.equal(await peer.locator(".n-learnbar").evaluate((bar) => bar.classList.contains("none")), true,
        "even a programmatic click cannot start Teach while post-transaction chart authority is locked");
      const peerSetup = peer.locator('.n-widget-surface [data-nx="surface-encoder-open"]');
      if (await peerSetup.getAttribute("aria-expanded") !== "true") await peerSetup.click();
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-read"]').click();
      await peer.waitForFunction(() => document.querySelector(
        ".n-widget-surface [data-surface-programming-summary]",
      )?.textContent?.includes("changing or reading this encoder"));
      assert.equal(peerChartReads, 0,
        "a peer cannot slip an old chart read ahead of the writer's backend lease");
      assert.match(
        (await peer.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "),
        /another KSX window is changing or reading this encoder/i,
        "the read attempt reaches the Web Lock refusal instead of merely observing stale epoch copy",
      );
      const durableDuringWrite = await storedBoardVerifications();
      assert.equal(durableDuringWrite.length, 2);
      assert.ok(durableDuringWrite.every((channel) => channel.verification === "unverified"),
        "every exact-board link is durably invalidated while the apply response is still held");
      assert.deepEqual(await storedUnlinkedObservations(), [],
        "Teach observations from the exact selected device are durably cleared even without terminal links");
      await page.keyboard.press("Escape");
      assert.equal(await dialog.getAttribute("open"), "", "an in-flight hardware transaction cannot be dismissed");
      assert.match(await dialog.textContent(), /Keep the encoder connected|Reading back every byte/i);
      releaseApply();

      await page.waitForFunction(() =>
        document.querySelector("dialog.n-panel-program-dialog")?.getAttribute("data-phase") === "verified");
      const settledHardwareEpoch = await storedHardwareEpoch();
      assert.equal(settledHardwareEpoch.key, pendingHardwareEpoch.key);
      assert.equal(settledHardwareEpoch.record?.version, 2);
      assert.equal(settledHardwareEpoch.record?.device, taughtDevice.toLocaleUpperCase());
      assert.equal(settledHardwareEpoch.record?.boardFingerprint, PANEL_FINGERPRINT.toLocaleUpperCase());
      assert.equal(settledHardwareEpoch.record?.selector, PANEL_SELECTOR.toLocaleUpperCase());
      assert.equal(settledHardwareEpoch.record?.phase, "settled",
        "a definitive response leaves a durable settled marker for documents which missed the live event");
      assert.ok(settledHardwareEpoch.record?.epoch);
      assert.notEqual(settledHardwareEpoch.record?.epoch, pendingHardwareEpoch.record?.epoch,
        "settlement publishes a fresh epoch rather than mutating meaning underneath the pending token");
      await page.waitForFunction(async (names) => {
        const snapshot = await navigator.locks.query();
        return [...snapshot.held, ...snapshot.pending].every((lock) => !names.includes(lock.name));
      }, expectedHardwareLocks);
      assert.equal(capturedApply.confirm, true);
      assert.equal(capturedApply.supervised, true);
      assert.equal(capturedApply.expected_board_fingerprint, PANEL_FINGERPRINT);
      assert.equal(capturedApply.expected_protocol_profile, PANEL_PROTOCOL_PROFILE);
      assert.equal(capturedApply.expected_desired_sha256, PANEL_DESIRED_SHA);
      assert.equal(capturedApply.program.expected_base_sha256, PANEL_BASE_SHA);
      await page.waitForFunction(() => document.querySelectorAll(
        '.n-widget-surface .n-surface-encoder-verification[data-state="unverified"]',
      ).length > 0);
      assert.match(await dialog.textContent(), /Encoder programmed and verified/i);
      await dialog.locator('[data-panel-dialog-action="teach"]').click();
      assert.equal(
        await page.locator('.n-widget-surface [data-surface-stage="teach"]').getAttribute("aria-pressed"),
        "true",
      );
      await page.waitForFunction(() => window.document.querySelector(
        '.n-widget-surface [data-nx="surface-encoder-open"]',
      )?.getAttribute("aria-expanded") === "false");
      assert.ok(chartReads >= 2, "a verified write triggers a fresh complete chart read");
      if (await peerSetup.getAttribute("aria-expanded") !== "true") await peerSetup.click();
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-read"]').click();
      await peer.waitForFunction(() => document.querySelector(
        '.n-widget-surface .n-surface-programming',
      )?.getAttribute("data-capability") === "programmable");
      assert.equal(peerChartReads, 1,
        "after completion, the peer performs its own authoritative current-chart read");
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-close"]').click();
      const refreshedKeycap = page.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          '[data-verification="configured"] .n-surface-signal-keycap',
      ).first();
      await refreshedKeycap.waitFor({ state: "visible" });
      assert.equal(await refreshedKeycap.getAttribute("data-flow-key"), "A");
      assert.equal(await refreshedKeycap.getAttribute("data-last-observed-key"), "Escape");
      assert.equal(await refreshedKeycap.getAttribute("data-key"), null);
      assert.match((await refreshedKeycap.textContent()).replace(/\s+/g, " "), /A.*\?/i);
      assert.doesNotMatch(await refreshedKeycap.textContent(), /✓/,
        "post-write readback establishes firmware truth but still requires a new physical Teach");
      await refreshedKeycap.evaluate((keycap) => keycap.click());
      assert.equal(
        await page.locator('.n-widget-surface [data-nx="surface-route"]').isDisabled(),
        true,
        "the stale pre-write Escape observation cannot route a keycap now owned by configured A",
      );

      // Simulate a suspended or discarded document which missed both storage
      // events and later restores its pre-write whole-store snapshot. The
      // independent settled sidecar must invalidate that snapshot on cold load.
      await page.evaluate((raw) => {
        localStorage.setItem("ksx-nocturne-control-surfaces1", raw);
      }, stalePreWriteStore);
      const coldPeerOpened = page.waitForEvent("popup");
      await page.evaluate(() => window.open("about:blank", "_blank"));
      coldPeer = await coldPeerOpened;
      coldPeer.on("pageerror", (error) => coldPeerNoise.push(`pageerror: ${error.stack ?? error}`));
      coldPeer.on("console", (message) => {
        if (message.type() === "error") coldPeerNoise.push(`console: ${message.text()}`);
      });
      await coldPeer.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await coldPeer.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await coldPeer.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null, { timeout: 20_000 });
      await settle(coldPeer);
      await coldPeer.click('[data-nx="surface-open"]');
      const coldKeycap = coldPeer.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          ' .n-surface-signal-keycap',
      ).first();
      await coldKeycap.waitFor({ state: "visible" });
      assert.equal(await coldKeycap.getAttribute("data-key"), null,
        "a new document cannot trust the pre-write Teach evidence in a restored stale snapshot");
      assert.notEqual(await coldKeycap.getAttribute("data-flow-key"), "Escape");
      await coldKeycap.click();
      assert.equal(
        await coldPeer.locator('.n-widget-surface [data-nx="surface-route"]').isDisabled(),
        true,
      );
      await coldPeer.waitForFunction((device) => {
        const value = JSON.parse(localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null");
        return Object.values(value?.devices ?? {}).every((surface) =>
          (surface.controls ?? []).every((control) =>
            (control.channels ?? []).every((channel) =>
              channel.input?.kind !== "keyboard" ||
              channel.input.device?.toLocaleUpperCase() !== device.toLocaleUpperCase() ||
              channel.input.key !== "Tab"
            ),
          ),
        );
      }, taughtDevice);
      assert.deepEqual(coldPeerNoise, []);
      await coldPeer.close();
      coldPeer = null;

      const peerControlCount = await peer.locator(".n-widget-surface .n-surface-control").count();
      await peer.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button24"]');
      await peer.waitForFunction((count) =>
        document.querySelectorAll(".n-widget-surface .n-surface-control").length === count + 1,
      peerControlCount);
      await peer.reload({ waitUntil: "domcontentloaded" });
      await peer.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null, { timeout: 20_000 });
      await settle(peer);
      if (!await peer.locator(".n-widget-surface").isVisible()) {
        await peer.click('[data-nx="surface-open"]');
      }
      assert.equal(
        await peer.locator(".n-widget-surface .n-surface-control").count(),
        peerControlCount + 1,
        "the peer edit really was saved before testing that stale authority stayed retired",
      );
      const reloadedPeerKeycap = peer.locator(
        '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"]' +
          ' .n-surface-signal-keycap',
      ).first();
      await reloadedPeerKeycap.waitFor({ state: "visible" });
      assert.equal(await reloadedPeerKeycap.getAttribute("data-key"), null,
        "a later save and reload cannot resurrect pre-write Teach evidence");
      assert.notEqual(await reloadedPeerKeycap.getAttribute("data-flow-key"), "Escape");
      await reloadedPeerKeycap.click();
      assert.equal(
        await peer.locator('.n-widget-surface [data-nx="surface-route"]').isDisabled(),
        true,
        "the reloaded stale tab still cannot route the pre-write observation",
      );
      assert.deepEqual(peerNoise, []);
      assert.deepEqual(learnPeerNoise, []);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseApply();
      await coldPeer?.close();
      await learnPeer?.close();
      await peer?.close();
      await page.close();
    }
  });

  test("Encoder hardware actions fail closed when Web Locks are unavailable", async () => {
    let chartRequests = 0;
    let applyRequests = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.addInitScript(() => {
        const nativeLocks = navigator.locks;
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          get: () => globalThis.__ksxPwtestLocksUnavailable ? undefined : nativeLocks,
        });
        globalThis.__ksxPwtestLocksUnavailable = true;
      });
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        chartRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload()),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [panelBackup()],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan({ terminals: ["1sw1"] })),
        });
      });
      await candidate.route("**/api/panel/program/apply", async (route) => {
        applyRequests += 1;
        await route.fulfill({ status: 500, body: "the client must not reach this route" });
      });
    });

    try {
      assert.equal(await page.evaluate(() => navigator.locks), undefined,
        "the page starts with the Web Locks capability genuinely absent");
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() => document.querySelector(
        ".n-widget-surface [data-surface-programming-summary]",
      )?.textContent?.includes("cannot safely coordinate this encoder across browser windows"));
      assert.equal(chartRequests, 0,
        "a complete-chart request cannot reach the backend without cross-window exclusion");
      assert.match(
        (await page.locator("[data-surface-programming-summary]").textContent()).replace(/\s+/g, " "),
        /cannot safely coordinate.*Nothing was changed/i,
      );

      await page.evaluate(() => {
        globalThis.__ksxPwtestLocksUnavailable = false;
      });
      assert.ok(await page.evaluate(() => navigator.locks));
      await page.locator('.n-widget-surface [data-nx="surface-encoder-read"]').click();
      await page.waitForFunction(() => document.querySelector(
        ".n-widget-surface .n-surface-programming",
      )?.getAttribute("data-capability") === "programmable");
      assert.equal(chartRequests, 1,
        "restoring Web Locks allows the same explicit chart read to proceed");
      await page.click('.n-widget-surface [data-surface-programming-mode="custom"]');
      await page.locator(".n-widget-surface .n-surface-control").first().click();
      await page.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]').selectOption("1sw1");
      await page.locator('.n-widget-surface [data-nx="surface-encoder-key"]').selectOption("A");
      await page.locator('.n-widget-surface [data-nx="surface-encoder-review"]').click();
      const dialog = page.locator("dialog.n-panel-program-dialog");
      await dialog.waitFor({ state: "visible" });
      await dialog.locator("[data-panel-program-confirm]").check();
      await dialog.locator("[data-panel-program-supervised]").check();
      await page.evaluate(() => {
        globalThis.__ksxPwtestLocksUnavailable = true;
      });
      assert.equal(await page.evaluate(() => navigator.locks), undefined);
      await dialog.locator('[data-panel-dialog-action="apply"]').click();
      await page.waitForFunction(() => document.querySelector(
        "dialog.n-panel-program-dialog .n-panel-program-review-status",
      )?.textContent?.includes("cannot safely coordinate this persistent write"));
      assert.match(
        (await dialog.locator(".n-panel-program-review-status").textContent()).replace(/\s+/g, " "),
        /cannot safely coordinate this persistent write/i,
      );
      assert.equal(applyRequests, 0,
        "a persistent program request cannot reach the backend without cross-window exclusion");
      assert.equal(await dialog.getAttribute("data-phase"), "idle");
      assert.match((await dialog.textContent()).replace(/\s+/g, " "), /Nothing was written/i);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a crashed writer's pending epoch settles only with the backend's exact ordered recovery proof", async () => {
    let capturedHardwareEpoch = "";
    let peerChartReads = 0;
    let serveOrderedFence = false;
    let hardwareImageSha256 = PANEL_BASE_SHA;
    let releaseLateApply = () => {};
    let markApplyStarted = () => {};
    let markLateApplyFinished = () => {};
    const applyGate = new Promise((resolve) => {
      releaseLateApply = resolve;
    });
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const lateApplyFinished = new Promise((resolve) => {
      markLateApplyFinished = resolve;
    });
    const crashContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    const writer = await openCanvasInContext(crashContext, async (candidate) => {
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        const request = JSON.parse(route.request().postData() ?? "{}");
        assert.equal(request.hardware_epoch ?? null, null,
          "the writer's initial read has no interrupted mutation to recover");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({ imageSha256: hardwareImageSha256 })),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [panelBackup()],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan({ terminals: ["1sw1"] })),
        });
      });
      await candidate.route("**/api/panel/program/apply", async (route) => {
        const request = JSON.parse(route.request().postData() ?? "{}");
        capturedHardwareEpoch = request.hardware_epoch ?? "";
        assert.ok(capturedHardwareEpoch, "every admitted writer carries the browser mutation token");
        markApplyStarted();
        await applyGate;
        // The ordered recovery read below wins the backend fence. A late
        // admitted request for this same token is canceled before packet zero.
        try {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              target_selector: PANEL_SELECTOR,
              hardware_epoch: capturedHardwareEpoch,
              unavailable: "The recovery read settled this hardware epoch before mutation admission.",
              refusal_code: "panel-hardware-epoch-settled",
              remedy: "Review again from the current chart.",
              mutation_disposition: "not-started",
              outcome: null,
            }),
          });
        } catch {
          // The initiating document was deliberately closed; the backend-side
          // ordering outcome remains observable through the peer's next read.
        } finally {
          markLateApplyFinished();
        }
      });
    });
    let peer = null;
    const peerNoise = [];

    try {
      await writer.click('[data-nx="surface-open"]');
      await writer.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await writer.click('.n-widget-surface [data-surface-template="blank"]');
      await writer.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await writer.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await writer.waitForFunction(() => document.querySelector(
        ".n-widget-surface .n-surface-programming",
      )?.getAttribute("data-capability") === "programmable");
      await writer.click('.n-widget-surface [data-surface-programming-mode="custom"]');
      await writer.locator(".n-widget-surface .n-surface-control").first().click();
      await writer.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]').selectOption("1sw1");
      await writer.locator('.n-widget-surface [data-nx="surface-encoder-key"]').selectOption("A");
      await writer.locator('.n-widget-surface [data-nx="surface-encoder-review"]').click();
      const writerDialog = writer.locator("dialog.n-panel-program-dialog");
      await writerDialog.waitFor({ state: "visible" });

      peer = await crashContext.newPage();
      peer.on("pageerror", (error) => peerNoise.push(`pageerror: ${error.stack ?? error}`));
      peer.on("console", (message) => {
        if (message.type() === "error") peerNoise.push(`console: ${message.text()}`);
      });
      await peer.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await peer.route("**/api/panel/chart", async (route) => {
        peerChartReads += 1;
        const request = JSON.parse(route.request().postData() ?? "{}");
        assert.equal(request.hardware_epoch, capturedHardwareEpoch,
          "recovery is fenced by the exact pending mutation token");
        assert.equal(
          request.expected_board_fingerprint?.toLocaleUpperCase(),
          PANEL_FINGERPRINT.toLocaleUpperCase(),
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({
            imageSha256: hardwareImageSha256,
            backup: null,
            hardwareEpoch: capturedHardwareEpoch,
            hardwareFence: serveOrderedFence ? "settled" : null,
          })),
        });
      });
      await peer.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await peer.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null, { timeout: 20_000 });

      await writerDialog.locator("[data-panel-program-confirm]").check();
      await writerDialog.locator("[data-panel-program-supervised]").check();
      await writerDialog.locator('[data-panel-dialog-action="apply"]').click();
      await applyStarted;
      const pendingBeforeCrash = await peer.evaluate((device) => {
        const normalized = device.trim().toLocaleUpperCase();
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(normalized)}`;
        return JSON.parse(localStorage.getItem(key) ?? "null");
      }, await writer.evaluate(() => JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view?.cap_instance ?? ""));
      assert.equal(pendingBeforeCrash?.epoch, capturedHardwareEpoch);
      assert.equal(pendingBeforeCrash?.phase, "pending");
      await writer.close();
      await peer.waitForFunction(async () => !(await navigator.locks.query()).held.some(
        (lock) => lock.name.startsWith("ksx-panel-hardware-v1:"),
      ));

      await settle(peer);
      if (!await peer.locator(".n-widget-surface").isVisible()) {
        await peer.click('[data-nx="surface-open"]');
      }
      await peer.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await peer.waitForFunction(() => document.querySelector(
        ".n-widget-surface [data-surface-programming-summary]",
      )?.textContent?.includes("did not return the matching ordered recovery proof"));
      assert.equal(peerChartReads, 1);
      const pendingAfterUnfencedRead = await peer.evaluate((device) => {
        const normalized = device.trim().toLocaleUpperCase();
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(normalized)}`;
        return JSON.parse(localStorage.getItem(key) ?? "null");
      }, pendingBeforeCrash.device);
      assert.equal(pendingAfterUnfencedRead?.epoch, capturedHardwareEpoch);
      assert.equal(pendingAfterUnfencedRead?.phase, "pending",
        "reading the old bytes cannot settle a writer without ordered backend proof");
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-close"]').click();
      assert.equal(await peer.locator('.n-widget-surface [data-nx="surface-teach"]').isDisabled(), true,
        "an unfenced recovery read cannot restore Teach authority");

      serveOrderedFence = true;
      await peer.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-read"]').click();
      await peer.waitForFunction((epoch) => {
        const device = JSON.parse(document.getElementById("__ksx-payload")?.textContent ?? "{}")
          .view?.cap_instance?.trim().toLocaleUpperCase() ?? "";
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(device)}`;
        const record = JSON.parse(localStorage.getItem(key) ?? "null");
        return record?.phase === "settled" && record.epoch !== epoch;
      }, capturedHardwareEpoch);
      assert.equal(peerChartReads, 2);
      await peer.locator('.n-widget-surface [data-nx="surface-encoder-close"]').click();
      assert.equal(await peer.locator('.n-widget-surface [data-nx="surface-teach"]').isEnabled(), true,
        "only the exact settled fence restores authority for the chart it ordered");

      releaseLateApply();
      await lateApplyFinished;
      assert.equal(hardwareImageSha256, PANEL_BASE_SHA,
        "recovery-wins cancels the detached writer before it can change hardware");
      assert.deepEqual(peerNoise, []);
    } finally {
      releaseLateApply();
      await writer.close().catch(() => {});
      await peer?.close();
      await crashContext.close();
    }
  });

  test("a queued writer preserves a crash-surviving pending token before its lock callback can POST", async () => {
    let applyRequests = 0;
    const sharedContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
    });
    const contender = await openCanvasInContext(sharedContext, async (candidate) => {
      await candidate.addInitScript(() => {
        const nativeLocks = navigator.locks;
        const queued = [];
        let holdFirstRequest = false;
        const facade = {
          query: nativeLocks.query.bind(nativeLocks),
          request(name, options, callback) {
            const request = () => nativeLocks.request(name, options, callback);
            if (!holdFirstRequest) return request();
            return new Promise((resolve, reject) => {
              queued.push(() => request().then(resolve, reject));
            });
          },
        };
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          get: () => facade,
        });
        globalThis.__ksxQueuedHardwareLockCount = () => queued.length;
        globalThis.__ksxQueueNextHardwareLock = () => {
          holdFirstRequest = true;
        };
        globalThis.__ksxReleaseQueuedHardwareLocks = () => {
          holdFirstRequest = false;
          for (const request of queued.splice(0)) request();
        };
      });
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            chartDetail: "Open Encoder setup to perform the complete chart read.",
            configurationState: "available-unopened",
            configurationDetail: "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload()),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [panelBackup()],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan({ terminals: ["1sw1"] })),
        });
      });
      await candidate.route("**/api/panel/program/apply", async (route) => {
        applyRequests += 1;
        await route.fulfill({ status: 500, body: "the stale contender must never POST" });
      });
    });
    let publisher = null;

    try {
      await contender.click('[data-nx="surface-open"]');
      await contender.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await contender.click('.n-widget-surface [data-surface-template="blank"]');
      await contender.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await contender.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await contender.waitForFunction(() => document.querySelector(
        ".n-widget-surface .n-surface-programming",
      )?.getAttribute("data-capability") === "programmable");
      await contender.click('.n-widget-surface [data-surface-programming-mode="custom"]');
      await contender.locator(".n-widget-surface .n-surface-control").first().click();
      await contender.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]').selectOption("1sw1");
      await contender.locator('.n-widget-surface [data-nx="surface-encoder-key"]').selectOption("A");
      await contender.locator('.n-widget-surface [data-nx="surface-encoder-review"]').click();
      const dialog = contender.locator("dialog.n-panel-program-dialog");
      await dialog.waitFor({ state: "visible" });
      await dialog.locator("[data-panel-program-confirm]").check();
      await dialog.locator("[data-panel-program-supervised]").check();
      await contender.evaluate(() => globalThis.__ksxQueueNextHardwareLock?.());
      await dialog.locator('[data-panel-dialog-action="apply"]').click();
      await contender.waitForFunction(() => globalThis.__ksxQueuedHardwareLockCount?.() === 1);
      assert.equal(applyRequests, 0,
        "the contender has passed its outer checks but has not entered the lock callback");

      const device = await contender.evaluate(() => JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view?.cap_instance?.trim().toLocaleUpperCase() ?? "");
      assert.ok(device);
      const publisherToken = "writer-a-crash-token";
      publisher = await sharedContext.newPage();
      await publisher.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await publisher.evaluate(({ device: exactDevice, token }) => {
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(exactDevice)}`;
        localStorage.setItem(key, JSON.stringify({
          version: 2,
          device: exactDevice,
          epoch: token,
          boardFingerprint: "PANEL-FIXTURE-FINGERPRINT",
          selector: "USB:D209:0430:00",
          phase: "pending",
        }));
      }, { device, token: publisherToken });
      await publisher.close();
      publisher = null;
      await contender.waitForFunction((token) => {
        const device = JSON.parse(document.getElementById("__ksx-payload")?.textContent ?? "{}")
          .view?.cap_instance?.trim().toLocaleUpperCase() ?? "";
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(device)}`;
        return JSON.parse(localStorage.getItem(key) ?? "null")?.epoch === token;
      }, publisherToken);

      await contender.evaluate(() => globalThis.__ksxReleaseQueuedHardwareLocks?.());
      await contender.waitForFunction(() => document.querySelector(".n-live-sr")?.textContent?.includes(
        "Another encoder transaction began while this review was waiting",
      ));
      assert.equal(applyRequests, 0,
        "the inner lock-held authority check refuses before the second hardware POST");
      const durablePublisher = await contender.evaluate((exactDevice) => {
        const key = `ksx-nocturne-control-surface-hardware-epoch2:${encodeURIComponent(exactDevice)}`;
        return JSON.parse(localStorage.getItem(key) ?? "null");
      }, device);
      assert.equal(durablePublisher?.epoch, publisherToken,
        "the contender cannot replace the crashed writer's exact mutation token");
      assert.equal(durablePublisher?.phase, "pending");
      assert.match(
        (await contender.locator(".n-live-sr").textContent()).replace(/\s+/g, " "),
        /pending hardware lock was preserved.*Nothing was written from this window/i,
      );
      assert.deepEqual(contender.ksxNoise, []);
    } finally {
      await contender.evaluate(() => globalThis.__ksxReleaseQueuedHardwareLocks?.()).catch(() => {});
      await publisher?.close();
      await sharedContext.close();
    }
  });

  test("Encoder setup binds completed and interrupted results to the encoder that owned them", async () => {
    // Re-enumeration can replace the physical Windows instance while the
    // staged selector remains byte-for-byte identical. Selector-only result
    // ownership would let this replacement inherit the first board's outcome.
    const replacementSelector = PANEL_SELECTOR;
    for (const disposition of ["verified", "recovery-required"]) {
      let switchTarget = false;
      let chartReads = 0;
      let releaseApply = () => {};
      let markApplyStarted = () => {};
      let markReplacementPayloadServed = () => {};
      const applyGate = new Promise((resolve) => {
        releaseApply = resolve;
      });
      const applyStarted = new Promise((resolve) => {
        markApplyStarted = resolve;
      });
      const replacementPayloadServed = new Promise((resolve) => {
        markReplacementPayloadServed = resolve;
      });
      const page = await openCanvas({}, async (candidate) => {
        await candidate.route("**/api/nocturne*", async (route) => {
          if (!switchTarget) {
            await route.continue();
            return;
          }
          const headers = { ...route.request().headers() };
          delete headers["if-none-match"];
          const response = await route.fetch({ headers });
          assert.equal(response.status(), 200);
          const payload = await response.json();
          payload.view.cap_selector = replacementSelector;
          payload.view.cap_instance = "HID\\VID_D209&PID_0430\\REPLACEMENT";
          await route.fulfill({ response, json: payload });
          markReplacementPayloadServed();
        });
        await candidate.route("**/api/panel/status", async (route) => {
          const targetSelector = switchTarget ? replacementSelector : PANEL_SELECTOR;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(panelStatusPayload({
              targetSelector,
              name: switchTarget ? "Replacement encoder" : "Ultimarc I-PAC 4X",
            })),
          });
        });
        await candidate.route("**/api/panel/chart", async (route) => {
          chartReads += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(panelChartPayload()),
          });
        });
        await candidate.route("**/api/panel/backups", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              target_selector: PANEL_SELECTOR,
              unavailable: null,
              view: {
                summary: "One verified backup.",
                board_fingerprint: PANEL_FINGERPRINT,
                backups: [panelBackup()],
              },
            }),
          });
        });
        await candidate.route("**/api/panel/program/plan", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(panelProgramPlan({ terminals: ["1sw1"] })),
          });
        });
        await candidate.route("**/api/panel/program/apply", async (route) => {
          const request = JSON.parse(route.request().postData() ?? "{}");
          markApplyStarted();
          await applyGate;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              target_selector: PANEL_SELECTOR,
              hardware_epoch: request.hardware_epoch,
              unavailable: null,
              refusal_code: null,
              remedy: null,
              mutation_disposition: disposition,
              outcome: {
                state: disposition,
                summary: disposition === "verified"
                  ? "The previous encoder was written and read back byte-for-byte."
                  : "The previous encoder's complete chart could not be verified.",
                board_fingerprint: PANEL_FINGERPRINT,
                expected_sha256: PANEL_DESIRED_SHA,
                observed_sha256: disposition === "verified" ? PANEL_DESIRED_SHA : null,
                backup: panelBackup(),
                verified_at: "2026-08-23T00:31:00-04:00",
                next_step: disposition === "verified"
                  ? "Verify inputs in Teach."
                  : "Read the chart and restore its safety backup.",
              },
            }),
          });
        });
      });

      try {
        await page.click('[data-nx="surface-open"]');
        await page.waitForFunction(() =>
          document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
        await page.click('.n-widget-surface [data-surface-template="blank"]');
        await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
        await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
        await page.waitForFunction(() =>
          document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-capability") === "programmable");
        await page.click('.n-widget-surface [data-surface-programming-mode="custom"]');
        await page.locator(".n-widget-surface .n-surface-control").first().click();
        await page.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]').selectOption("1sw1");
        await page.locator('.n-widget-surface [data-nx="surface-encoder-key"]').selectOption("A");
        await page.locator('.n-widget-surface [data-nx="surface-encoder-review"]').click();
        const dialog = page.locator("dialog.n-panel-program-dialog");
        await dialog.locator("[data-panel-program-confirm]").check();
        await dialog.locator("[data-panel-program-supervised]").check();
        await dialog.locator('[data-panel-dialog-action="apply"]').click();
        await applyStarted;

        switchTarget = true;
        await Promise.race([
          replacementPayloadServed,
          new Promise((_, reject) => setTimeout(() => reject(
            new Error(`replacement encoder payload was not served during ${disposition}`)
          ), 10_000)),
        ]);
        releaseApply();
        await page.waitForFunction((phase) =>
          document.querySelector("dialog.n-panel-program-dialog")?.getAttribute("data-phase") === phase,
        disposition);

        const copy = (await dialog.textContent()).replace(/\s+/g, " ");
        assert.match(copy, /previous encoder transaction/i);
        assert.match(copy, new RegExp(PANEL_SELECTOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
        assert.match(copy, /current canvas target was not changed|currently selected encoder was not changed/i);
        assert.equal(await dialog.locator('[data-panel-dialog-action="teach"]').count(), 0);
        assert.equal(await dialog.locator('[data-panel-dialog-action="restore-validation"]').count(), 0);
        assert.equal(await dialog.locator('[data-panel-dialog-action="restart-validation"]').count(), 0);
        assert.equal(await dialog.locator('[data-panel-dialog-action="recover-read"]').count(), 0);
        assert.equal(await dialog.locator('[data-panel-dialog-action="close"]').count(), 1,
          `${disposition} is informational and Close-only after target detachment`);
        assert.equal(chartReads, 1,
          "a detached result never reads the newly selected encoder as if it owned the old transaction");
        await page.locator('.n-widget-kb .n-ipac-signal').first().waitFor({
          state: "visible",
          timeout: 10_000,
        });
        assert.ok(await page.locator('.n-widget-kb .n-ipac-signal').count() > 0,
          "a replacement instance sharing the selector does not inherit the previous board's recovery lock");
        await dialog.locator('[data-panel-dialog-action="close"]').click();
        const setupButton = page.locator('.n-widget-surface [data-nx="surface-encoder-open"]');
        if (await setupButton.getAttribute("aria-expanded") === "true") {
          page.once("dialog", (confirmation) => confirmation.accept());
          await page.click('.n-widget-surface [data-nx="surface-encoder-read"]');
        } else {
          await setupButton.click();
        }
        await page.waitForFunction(() =>
          document.querySelector('.n-widget-surface .n-surface-programming')
            ?.getAttribute('data-qualification') === 'qualified');
        assert.equal(chartReads, 2,
          "the replacement instance performs its own complete authoritative chart read");
        await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');
        const settledPanelKey = page.locator(
          '.n-widget-surface .n-surface-signal-chain[data-terminal-id="1sw1"] ' +
            '.n-surface-signal-keycap[data-flow-key="B"]',
        ).first();
        await settledPanelKey.waitFor({
          state: "visible",
          timeout: 10_000,
        });
        assert.equal(await settledPanelKey.getAttribute("data-flow-authority"), "configured",
          "a settled reread clears every stale instance alias for the same physical board");
        assert.deepEqual(page.ksxNoise, []);
      } finally {
        releaseApply();
        await page.close();
      }
    }
  });

  test("closed first-run encoder sources wait for exact-board recovery status", async () => {
    const withinRecoveryStatus = (promise, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), 10_000);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    for (const recoveryCase of [
      { recoveryRequired: false, omitRecoveryField: false },
      { recoveryRequired: true, omitRecoveryField: false },
      { recoveryRequired: undefined, omitRecoveryField: true },
    ]) {
      const { recoveryRequired, omitRecoveryField } = recoveryCase;
      let releaseStatus = () => {};
      let markStatusStarted = () => {};
      let markStatusServed = () => {};
      let statusCalls = 0;
      let transientIdentityMissing = false;
      let markTransientIdentityServed = () => {};
      const statusGate = new Promise((resolve) => {
        releaseStatus = resolve;
      });
      const statusStarted = new Promise((resolve) => {
        markStatusStarted = resolve;
      });
      const statusServed = new Promise((resolve) => {
        markStatusServed = resolve;
      });
      const transientIdentityServed = new Promise((resolve) => {
        markTransientIdentityServed = resolve;
      });
      const page = await openCanvas({}, async (candidate) => {
        await candidate.addInitScript(() => {
          window.localStorage.removeItem("ksx-nocturne-control-surfaces1");
        });
        await candidate.route("**/api/nocturne*", async (route) => {
          if (!transientIdentityMissing) {
            await route.continue();
            return;
          }
          const headers = { ...route.request().headers() };
          delete headers["if-none-match"];
          const response = await route.fetch({ headers });
          assert.equal(response.status(), 200);
          const payload = await response.json();
          payload.view.cap_selector = "";
          payload.view.cap_instance = "";
          payload.view.dev_encoders = [];
          payload.view.kb_title = "Encoder inventory is temporarily unavailable";
          await route.fulfill({ response, json: payload });
          markTransientIdentityServed();
        });
        await candidate.route("**/api/panel/status", async (route) => {
          statusCalls += 1;
          markStatusStarted();
          await statusGate;
          const payload = panelStatusPayload({
            name: omitRecoveryField ? "Legacy recovery-field fixture" : "Ultimarc I-PAC 4X",
            recoveryRequired,
            recoveryDetail: recoveryRequired
              ? "The exact encoder has an unresolved durable transaction."
              : "",
          });
          if (omitRecoveryField) {
            delete payload.view.panels[0].programming_recovery_required;
            delete payload.view.panels[0].programming_recovery_detail;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(payload),
          });
          markStatusServed();
        });
      });

      try {
        await withinRecoveryStatus(
          statusStarted,
          `the ${omitRecoveryField ? "missing-field" : String(recoveryRequired)} recovery probe never reached passive status`,
        );
        assert.equal(await page.locator('.n-widget-surface').count(), 0,
          "the recovery probe does not require an open Builder or saved physical panel");
        assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
          "mapping-derived I-PAC sources stay unavailable while exact-board recovery is unknown");
        assert.match(
          (await page.locator('.n-widget-kb .n-ipac-signal-source > p').first().textContent())
            .replace(/\s+/g, ' '),
          /checking this exact .* recovery journal/i,
        );

        releaseStatus();
        await withinRecoveryStatus(
          statusServed,
          `the ${omitRecoveryField ? "missing-field" : String(recoveryRequired)} passive status response was never served`,
        );
        if (recoveryRequired) {
          await page.waitForFunction(() => /cannot prove which keys/i.test(
            document.querySelector('.n-widget-kb .n-ipac-signal-source > p')?.textContent ?? '',
          ));
          assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
            "an unresolved exact-board journal keeps mapping-derived sources suspended");
        } else if (omitRecoveryField) {
          await page.waitForFunction(() => /could not complete this exact/i.test(
            document.querySelector('.n-widget-kb .n-ipac-signal-source > p')?.textContent ?? '',
          ));
          await page.click('[data-nx="surface-open"]');
          await page.waitForFunction((name) => {
            const card = document.querySelector('.n-widget-surface .n-surface-hardware');
            return card?.getAttribute('data-state') === 'error' &&
              (card.textContent ?? '').includes(name);
          }, "Legacy recovery-field fixture");
          assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
            "an older status response without recovery authority remains fail-closed");
          assert.match(
            (await page.locator('.n-widget-kb .n-ipac-signal-source > p').first().textContent())
              .replace(/\s+/g, ' '),
            /could not complete this exact .* recovery check/i,
            "a missing recovery field is reported as indeterminate instead of pretending the request is still running",
          );
        } else {
          await page.locator('.n-widget-kb .n-ipac-signal').first().waitFor({ state: "visible" });
          assert.ok(await page.locator('.n-widget-kb .n-ipac-signal').count() > 0,
            "a settled exact-board probe restores the closed Builder's source shelf immediately");
          assert.match(
            (await page.locator('.n-widget-kb .n-ipac-signal-source > p').first().textContent())
              .replace(/\s+/g, ' '),
            /KSX has not read.*hardware-output chart/i,
            "settled status repaints ordinary shelf copy even while the Builder remains closed",
          );

          transientIdentityMissing = true;
          await page.evaluate(() => {
            const form = document.querySelector('form:has(input[name="fresh"])');
            form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
          });
          await withinRecoveryStatus(
            transientIdentityServed,
            "the transient missing-identity payload was never served",
          );
          await page.waitForFunction(() =>
            document.querySelector('.n-widget-kb')?.getAttribute('data-input-kind') ===
              'panel-encoder' &&
            document.querySelectorAll('.n-widget-kb .n-ipac-signal').length === 0 &&
            /could not complete this exact .* recovery check/i.test(
              document.querySelector('.n-widget-kb .n-ipac-signal-source > p')?.textContent ?? '',
            )
          );
          assert.equal(await page.locator('.n-widget-surface').count(), 0,
            "transient identity loss remains fail-closed while the Builder is closed");
        }
        if (recoveryRequired) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          assert.equal(statusCalls, 1,
            "a durable recovery journal is not mistaken for a transient lease and retried");
        }
        assert.deepEqual(page.ksxNoise, []);
      } finally {
        releaseStatus();
        await page.close();
      }
    }
  });

  test("passive recovery retries transient status failures and then restores sources", async () => {
    for (const transient of ["network", "missing-field", "busy-lease"]) {
      let statusCalls = 0;
      let markFirstStatusStarted = () => {};
      let markFirstStatusServed = () => {};
      let releaseFirstStatus = () => {};
      let markRetryStarted = () => {};
      let releaseRetry = () => {};
      const firstStatusStarted = new Promise((resolve) => {
        markFirstStatusStarted = resolve;
      });
      const firstStatusServed = new Promise((resolve) => {
        markFirstStatusServed = resolve;
      });
      const firstStatusGate = new Promise((resolve) => {
        releaseFirstStatus = resolve;
      });
      const retryStarted = new Promise((resolve) => {
        markRetryStarted = resolve;
      });
      const retryGate = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      const page = await openCanvas({}, async (candidate) => {
        await candidate.addInitScript(() => {
          window.localStorage.removeItem("ksx-nocturne-control-surfaces1");
        });
        await candidate.route("**/api/panel/status", async (route) => {
          statusCalls += 1;
          if (statusCalls > 1) {
            markRetryStarted();
            await retryGate;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(panelStatusPayload({ recoveryRequired: false })),
            });
            return;
          }
          markFirstStatusStarted();
          await firstStatusGate;
          if (transient === "network") {
            await route.fulfill({ status: 503, body: "hardware inventory is busy" });
          } else {
            const payload = panelStatusPayload({
              recoveryRequired: transient === "busy-lease",
              recoveryDetail: transient === "busy-lease"
                ? "Another KSX panel operation owns the hardware lease; nothing was changed."
                : "",
            });
            if (transient === "missing-field") {
              delete payload.view.panels[0].programming_recovery_required;
              delete payload.view.panels[0].programming_recovery_detail;
            }
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(payload),
            });
          }
          markFirstStatusServed();
        });
      });

      try {
        await Promise.race([
          firstStatusStarted,
          new Promise((_, reject) => setTimeout(() => reject(
            new Error(`${transient} recovery request never started`)
          ), 10_000)),
        ]);
        releaseFirstStatus();
        await Promise.race([
          firstStatusServed,
          new Promise((_, reject) => setTimeout(() => reject(
            new Error(`${transient} recovery response was never served`)
          ), 10_000)),
        ]);
        await page.waitForFunction(() => /could not complete this exact/i.test(
          document.querySelector('.n-widget-kb .n-ipac-signal-source > p')?.textContent ?? '',
        ));
        assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
          `${transient} remains fail-closed before its retry settles`);
        await Promise.race([
          retryStarted,
          new Promise((_, reject) => setTimeout(() => reject(
            new Error(`${transient} recovery retry never started`)
          ), 5000)),
        ]);
        releaseRetry();
        await page.locator('.n-widget-kb .n-ipac-signal').first().waitFor({
          state: "visible",
          timeout: 5000,
        });
        assert.equal(statusCalls, 2, `${transient} receives one bounded retry`);
        await new Promise((resolve) => setTimeout(resolve, 1750));
        assert.equal(statusCalls, 2,
          `${transient} stops retrying after the exact encoder is settled`);
        const unexpectedNoise = page.ksxNoise.filter((entry) =>
          !(transient === "network" && /503 \(Service Unavailable\)/i.test(entry))
        );
        assert.deepEqual(unexpectedNoise, []);
        if (transient === "network") {
          assert.ok(page.ksxNoise.some((entry) => /503 \(Service Unavailable\)/i.test(entry)),
            "the simulated HTTP failure remains visible to the browser while KSX recovers");
        }
      } finally {
        releaseFirstStatus();
        releaseRetry();
        await page.close();
      }
    }
  });

  test("an ambiguous current-board write suspends every stale signal authority", async () => {
    let durableRecoveryRequired = false;
    let statusCalls = 0;
    let holdRecoveryStatus = false;
    let releaseRecoveryStatus = () => {};
    let markRecoveryStatusStarted = () => {};
    let markRecoveryStatusServed = () => {};
    const recoveryStatusGate = new Promise((resolve) => {
      releaseRecoveryStatus = resolve;
    });
    const recoveryStatusStarted = new Promise((resolve) => {
      markRecoveryStatusStarted = resolve;
    });
    const recoveryStatusServed = new Promise((resolve) => {
      markRecoveryStatusServed = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/status", async (route) => {
        statusCalls += 1;
        const held = holdRecoveryStatus && durableRecoveryRequired;
        if (held) {
          markRecoveryStatusStarted();
          await recoveryStatusGate;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
          driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
          chartState: "not-read",
          configurationState: "available-unopened",
          recoveryRequired: durableRecoveryRequired,
          recoveryDetail: durableRecoveryRequired
            ? "The durable transaction journal for this exact encoder still requires recovery."
            : "",
          })),
        });
        if (held) markRecoveryStatusServed();
      });
      await candidate.route("**/api/panel/chart", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelChartPayload()),
      }));
      await candidate.route("**/api/panel/backups", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          target_selector: PANEL_SELECTOR,
          unavailable: null,
          view: {
            summary: "One verified backup.",
            board_fingerprint: PANEL_FINGERPRINT,
            backups: [panelBackup()],
          },
        }),
      }));
      await candidate.route("**/api/panel/program/plan", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelProgramPlan({ terminals: ["1sw1"] })),
      }));
      await candidate.route("**/api/panel/program/apply", (route) => {
        const request = JSON.parse(route.request().postData() ?? "{}");
        durableRecoveryRequired = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
          target_selector: PANEL_SELECTOR,
          hardware_epoch: request.hardware_epoch,
          unavailable: null,
          refusal_code: null,
          remedy: null,
          mutation_disposition: "recovery-required",
          outcome: {
            state: "recovery-required",
            summary: "The write may have started, but the complete chart could not be verified.",
            board_fingerprint: PANEL_FINGERPRINT,
            expected_sha256: PANEL_DESIRED_SHA,
            observed_sha256: null,
            backup: panelBackup(),
            verified_at: "2026-08-23T00:31:00-04:00",
            next_step: "Read the complete chart again or restore the verified backup.",
          },
          }),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      const surface = page.locator('.n-widget-surface');
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-hardware')
          ?.getAttribute('data-state') === 'ready'
      );
      await surface.locator('[data-surface-template="blank"]').click();
      await surface.locator('[data-nx="surface-add"][data-control-kind="button30"]').click();
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-programming')
          ?.getAttribute('data-capability') === 'programmable'
      );
      await surface.locator('[data-surface-programming-mode="custom"]').click();
      await surface.locator('.n-surface-control').click();
      await surface.locator('[data-nx="surface-encoder-terminal"]').selectOption('1sw1');
      await surface.locator('[data-nx="surface-encoder-key"]').selectOption('A');
      await surface.locator('[data-nx="surface-encoder-review"]').click();
      const dialog = page.locator('dialog.n-panel-program-dialog');
      await dialog.locator('[data-panel-program-confirm]').check();
      await dialog.locator('[data-panel-program-supervised]').check();
      await dialog.locator('[data-panel-dialog-action="apply"]').click();
      await page.waitForFunction(() =>
        document.querySelector('dialog.n-panel-program-dialog')
          ?.getAttribute('data-phase') === 'recovery-required'
      );
      await dialog.locator('[data-panel-dialog-action="close"]').click();
      for (const action of [
        'surface-encoder-test',
        'surface-encoder-route',
        'surface-encoder-build-panel',
        'surface-encoder-design-panel',
      ]) {
        assert.equal(await surface.locator(`[data-nx="${action}"]`).isDisabled(), true,
          `${action} cannot consume the unproven pre-write chart`);
      }
      await surface.locator('[data-nx="surface-encoder-close"]').click();
      assert.equal(await surface.locator('.n-surface-signal-keycap[data-flow-key]').count(), 0,
        "the pre-write chart cannot own a cord while its current bytes are unknown");
      assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
        "the pre-write signal shelf is removed during hardware recovery");
      assert.match(
        (await page.locator('.n-widget-kb .n-ipac-source-empty').textContent()).replace(/\s+/g, ' '),
        /outputs are intentionally hidden until hardware recovery/i,
      );
      await surface.locator('.n-surface-signal-keycap').click();
      assert.equal(await surface.locator('[data-nx="surface-route"]').isDisabled(), true);

      await surface.locator('[data-nx="surface-close"]').click();
      await page.waitForFunction(() => !document.querySelector('.n-widget-surface'));
      const statusCallsBeforeReload = statusCalls;
      holdRecoveryStatus = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
          undefined
      );
      await Promise.race([
        recoveryStatusStarted,
        new Promise((_, reject) => setTimeout(() => reject(
          new Error("closed saved encoder links did not request passive recovery status")
        ), 10_000)),
      ]);
      assert.ok(statusCalls > statusCallsBeforeReload,
        "closed saved encoder links trigger a passive recovery probe on reload");
      assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
        "unknown recovery status cannot briefly resurrect stale shelf sources");

      releaseRecoveryStatus();
      await recoveryStatusServed;
      holdRecoveryStatus = false;
      assert.equal(await page.locator('.n-widget-kb .n-ipac-signal').count(), 0,
        "durable recovery keeps the closed Builder's shelf sources suspended");

      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() => {
        const surface = document.querySelector('.n-widget-surface');
        const note = surface?.querySelector('.n-surface-hardware-note')?.textContent ?? '';
        return surface?.querySelector('.n-surface-hardware')?.getAttribute('data-state') === 'error'
          && /durable transaction journal.*requires recovery/i.test(note.replace(/\s+/g, ' '));
      });
      assert.equal(await surface.locator('.n-surface-signal-keycap[data-flow-key]').count(), 0,
        "the machine-scoped recovery journal re-suspends routes after a page reload");
      assert.match(
        (await surface.locator('.n-surface-hardware-note').textContent()).replace(/\s+/g, ' '),
        /durable transaction journal.*requires recovery/i,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Encoder setup qualifies the writer with one reversible terminal before full layouts", async () => {
    let qualificationState = "required";
    let capturedQualificationPlan = null;
    let capturedQualificationRestore = null;
    const safetyBackup = panelBackup({
      id: "20260823T003000Z-before-program-QUALIFY000001",
      reason: "before-program",
    });
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/status", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
            chartState: "not-read",
            chartLabel: "Chart not read — explicit action required",
            configurationState: "available-unopened",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", async (route) => {
        const payload = panelChartPayload({
          imageSha256: qualificationState === "required" ? PANEL_BASE_SHA : PANEL_DESIRED_SHA,
          backup: safetyBackup,
          qualificationState,
          qualificationDetail: qualificationState === "required"
            ? "Use one noncritical normal terminal for the reversible writer check."
            : `Restore exact safety backup ${safetyBackup.backup_id} before another write.`,
          qualificationRestoreBackupId: ["validation-written", "validation-recovery"].includes(
            qualificationState,
          )
            ? safetyBackup.backup_id
            : null,
        });
        const ordinary = payload.view.terminals[0];
        payload.view.terminals.push(
          { ...ordinary, terminal_id: "1up", terminal_label: "Player 1 · Up", kind: "direction" },
          { ...ordinary, terminal_id: "1start", terminal_label: "Player 1 · Start", kind: "start" },
          {
            ...ordinary,
            terminal_id: "1coin",
            terminal_label: "Player 1 · Coin",
            kind: "coin",
            normal: { code: 4, key: "A", label: "A", supported: true },
          },
          {
            ...ordinary,
            terminal_id: "1sw3",
            terminal_label: "Player 1 · Button 3",
            shift_state: "enabled",
            is_shift: true,
          },
          {
            ...ordinary,
            terminal_id: "1sw4",
            terminal_label: "Player 1 · Button 4",
            normal: { code: 255, key: null, label: "Preserved vendor action", supported: false },
          },
          {
            ...ordinary,
            terminal_id: "1sw5",
            terminal_label: "Player 1 · Button 5",
            shift_state: "opaque",
            is_shift: false,
          },
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
      await candidate.route("**/api/panel/backups", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            unavailable: null,
            view: {
              summary: "One verified qualification backup.",
              board_fingerprint: PANEL_FINGERPRINT,
              backups: [safetyBackup],
            },
          }),
        });
      });
      await candidate.route("**/api/panel/program/plan", async (route) => {
        capturedQualificationPlan = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelProgramPlan({
            terminals: ["1sw1"],
            confirmation:
              "Program the reviewed chart. I understand that exactly one desired byte differs, but KSX retransmits the complete 256-byte chart as all 64 HID reports.",
          })),
        });
      });
      await candidate.route("**/api/panel/program/apply", async (route) => {
        const request = JSON.parse(route.request().postData() ?? "{}");
        qualificationState = "validation-written";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            hardware_epoch: request.hardware_epoch,
            unavailable: null,
            refusal_code: null,
            remedy: null,
            mutation_disposition: "verified",
            outcome: {
              state: "verified",
              summary: "The one-terminal validation chart was written and read back byte-for-byte.",
              board_fingerprint: PANEL_FINGERPRINT,
              expected_sha256: PANEL_DESIRED_SHA,
              observed_sha256: PANEL_DESIRED_SHA,
              backup: safetyBackup,
              verified_at: "2026-08-23T00:31:00-04:00",
              // Deliberately stale generic advice: qualification UI must
              // override it with the mandatory exact restore.
              next_step: "Verify inputs in Teach.",
            },
          }),
        });
      });
      await candidate.route("**/api/panel/restore/plan", async (route) => {
        capturedQualificationRestore = JSON.parse(route.request().postData() ?? "{}");
        const payload = panelProgramPlan({
          terminals: ["1sw1"],
          confirmation: "Restore the exact qualification safety backup and verify every byte.",
        });
        payload.plan.base_sha256 = PANEL_DESIRED_SHA;
        payload.plan.desired_sha256 = PANEL_BASE_SHA;
        payload.plan.terminal_diff[0].before = "A";
        payload.plan.terminal_diff[0].after = "B";
        payload.plan.byte_diff[0].before = 4;
        payload.plan.byte_diff[0].after = 5;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
      await candidate.route("**/api/panel/restore/apply", async (route) => {
        const request = JSON.parse(route.request().postData() ?? "{}");
        assert.equal(request.restore.backup_id, safetyBackup.backup_id);
        assert.equal(request.restore.expected_current_sha256, PANEL_DESIRED_SHA);
        qualificationState = "required";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
            hardware_epoch: request.hardware_epoch,
            unavailable: null,
            refusal_code: null,
            remedy: null,
            mutation_disposition: "verified",
            outcome: {
              state: "verified",
              summary: "The interrupted validation chart was restored and verified byte-for-byte.",
              board_fingerprint: PANEL_FINGERPRINT,
              expected_sha256: PANEL_BASE_SHA,
              observed_sha256: PANEL_BASE_SHA,
              backup: safetyBackup,
              verified_at: "2026-08-23T00:32:00-04:00",
              next_step: "Repeat the one-terminal writer test; full-chart programming remains locked.",
            },
          }),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      const programming = page.locator(".n-widget-surface .n-surface-programming");
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "required");

      const recommended = programming.locator('[data-surface-programming-mode="recommended"]');
      const custom = programming.locator('[data-surface-programming-mode="custom"]');
      assert.equal(await custom.getAttribute("aria-pressed"), "true",
        "unqualified hardware opens in the bounded custom flow");
      assert.equal(await recommended.isDisabled(), true,
        "a full canonical chart is unavailable before writer qualification");
      assert.match(await recommended.getAttribute("title"), /one-terminal writer check/i);
      assert.match(
        (await programming.locator("[data-surface-programming-qualification]").textContent()).replace(/\s+/g, " "),
        /step 1 of 2.*one noncritical SW action button.*not a direction, Start, or Coin.*Shift state explicitly disabled.*exactly one desired byte differs.*complete 256-byte chart as all 64 HID reports/i,
      );
      assert.equal(await programming.locator("[data-surface-backup]").isDisabled(), true,
        "a pre-validation backup is visible but cannot be restored over the unchanged chart");
      assert.equal(
        await programming.locator('[data-nx="surface-encoder-restore"]').isDisabled(),
        true,
        "restore is unavailable until a validation transaction or qualified writer exists",
      );
      const qualificationTerminal = programming.locator(
        '[data-nx="surface-qualification-terminal"]',
      );
      const qualificationTerminalOptions = await qualificationTerminal.locator(
        "option",
      ).evaluateAll((options) => options.map((option) => ({
        value: option.value,
        disabled: option.disabled,
        text: option.textContent,
      })));
      assert.deepEqual(
        qualificationTerminalOptions.slice(1).map((option) => option.value),
        ["1sw1", "1sw2"],
        "the writer check offers only noncritical SW actions with an explicitly disabled Shift role",
      );
      assert.equal(
        qualificationTerminalOptions.every((option) => option.disabled === false),
        true,
        "unsafe terminals are omitted rather than mixed into the actionable picker",
      );

      const qualificationKey = programming.locator('[data-nx="surface-qualification-key"]');
      assert.deepEqual(
        await qualificationKey.locator("option").evaluateAll((options) =>
          options.map((option) => option.value).filter(Boolean)
        ),
        ["A", "B"],
        "the actionable picker contains only backend-approved safe keys",
      );
      assert.equal(
        await qualificationKey.locator('option[value="Escape"]').count(),
        0,
        "unsafe command keys are omitted instead of presented as possible actions",
      );
      assert.equal(
        await qualificationKey.locator('option[value="A"]').evaluate((option) => option.disabled),
        false,
        "the backend-approved printable subset remains selectable",
      );

      await programming.locator('[data-nx="surface-encoder-close"]').click();
      const controls = page.locator(".n-widget-surface .n-surface-control");
      await controls.first().waitFor({ state: "visible" });
      const terminalSelect = page.locator('.n-widget-surface [data-nx="surface-encoder-terminal"]');
      const keySelect = page.locator('.n-widget-surface [data-nx="surface-encoder-key"]');
      await controls.nth(0).evaluate((control) => control.click());
      await terminalSelect.selectOption("1sw1");
      await controls.nth(1).evaluate((control) => control.click());
      await terminalSelect.selectOption("1sw1");
      await keySelect.selectOption("A");
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "required");
      const review = programming.locator('[data-nx="surface-encoder-review"]');
      assert.equal(await review.isEnabled(), true,
        "two drawings of one terminal remain one physical writer-check edit");
      await review.click();
      const qualificationDialog = page.locator("dialog.n-panel-program-dialog");
      await qualificationDialog.waitFor({ state: "visible" });
      assert.deepEqual(capturedQualificationPlan.edits, [
        { terminal_id: "1sw1", normal_key: "A", allow_shared_key: true },
        { terminal_id: "1coin", normal_key: "A", allow_shared_key: true },
      ], "shared terminal views are deduplicated before the guarded plan request");
      await qualificationDialog.locator('[data-panel-dialog-action="close"]').click();

      await qualificationTerminal.selectOption("1sw1");
      await qualificationKey.selectOption("A");
      assert.equal(await review.isEnabled(), true,
        "one changed normal terminal is the only allowed qualification plan");
      await review.click();
      await qualificationDialog.waitFor({ state: "visible" });
      assert.deepEqual(capturedQualificationPlan.edits, [
        { terminal_id: "1sw1", normal_key: "A", allow_shared_key: true },
        { terminal_id: "1coin", normal_key: "A", allow_shared_key: true },
      ]);
      assert.match(
        await qualificationDialog.locator(".n-panel-program-confirm").first().textContent(),
        /exactly one desired byte differs.*complete 256-byte chart as all 64 HID reports/i,
        "first-write confirmation distinguishes the tiny diff from the complete retransmission",
      );
      await qualificationDialog.locator('[data-panel-dialog-action="close"]').click();

      assert.equal(await review.isEnabled(), true);
      await review.click();
      await qualificationDialog.locator("[data-panel-program-confirm]").check();
      await qualificationDialog.locator("[data-panel-program-supervised]").check();
      await qualificationDialog.locator('[data-panel-dialog-action="apply"]').click();
      await qualificationDialog.getByRole("heading", {
        name: /Validation write verified — restore required/i,
      }).waitFor();
      assert.equal(
        await qualificationDialog.locator('[data-panel-dialog-action="teach"]').count(),
        0,
        "Teach cannot bypass the exact restore that completes writer qualification",
      );
      const requiredRestore = qualificationDialog.locator(
        '[data-panel-dialog-action="restore-validation"]',
      );
      assert.equal(await requiredRestore.isEnabled(), true);
      assert.match(await requiredRestore.textContent(), /Review required restore/i);
      assert.match(
        (await qualificationDialog.textContent()).replace(/\s+/g, " "),
        new RegExp(`writer check is not complete.*${safetyBackup.backup_id}.*verified restore.*unlocks full layouts`, "i"),
      );
      await requiredRestore.click();
      await qualificationDialog.getByRole("heading", { name: /Review the exact restore/i }).waitFor();
      assert.equal(capturedQualificationRestore.backup_id, safetyBackup.backup_id,
        "the post-write primary action opens the backend-named safety backup directly");
      assert.equal(capturedQualificationRestore.expected_current_sha256, PANEL_DESIRED_SHA);
      await qualificationDialog.locator('[data-panel-dialog-action="close"]').click();

      await programming.locator('[data-nx="surface-encoder-read"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "validation-written");
      assert.match(
        (await programming.locator("[data-surface-programming-qualification]").textContent()).replace(/\s+/g, " "),
        /step 2 of 2.*restore (?:the )?exact safety backup.*unlocking full layouts/i,
      );
      assert.equal(await review.isDisabled(), true,
        "no second program operation is offered while the validation chart awaits restore");
      assert.match(await review.textContent(), /Restore safety backup to finish/i);
      assert.equal(await recommended.isDisabled(), true);
      await page.waitForFunction((backupId) => document.querySelector(
        '.n-widget-surface [data-surface-backup]',
      )?.value === backupId, safetyBackup.backup_id);
      assert.equal(
        await programming.locator("[data-surface-backup]").inputValue(),
        safetyBackup.backup_id,
        "the backend-named restore point is selected instead of asking the user to guess",
      );

      qualificationState = "validation-recovery";
      await programming.locator('[data-nx="surface-encoder-read"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "validation-recovery" &&
        /does not unlock Recommended/i.test(document.querySelector(
          '.n-widget-surface [data-surface-programming-mode="recommended"]',
        )?.getAttribute("title") ?? "") &&
        document.querySelector(
          '.n-widget-surface [data-nx="surface-encoder-restore"]',
        )?.disabled === false);
      const recoveryCopy = (await programming.locator(
        "[data-surface-programming-qualification]",
      ).textContent()).replace(/\s+/g, " ");
      assert.match(recoveryCopy, /Writer check · recovery/i);
      assert.match(recoveryCopy, /returns this encoder to step 1.*does not unlock full layouts/i);
      assert.match(await review.textContent(), /Restore safety backup, then retry/i);
      assert.equal(await review.isDisabled(), true);
      assert.match(await recommended.getAttribute("title"), /does not unlock Recommended/i);
      assert.equal(
        await programming.locator("[data-surface-backup]").inputValue(),
        safetyBackup.backup_id,
        "interrupted validation remains pinned to the same exact restore point",
      );
      assert.equal(
        await programming.locator('[data-nx="surface-encoder-restore"]').isEnabled(),
        true,
        "recovery exposes only the exact-backup restore path",
      );
      const recoveryHistory = programming.locator(".n-surface-programming-recovery");
      assert.equal(await recoveryHistory.getAttribute("open"), null,
        "raw recovery stays collapsed until the user needs it");
      await recoveryHistory.locator("summary").click();
      await programming.locator('[data-nx="surface-encoder-restore"]').click();
      await qualificationDialog.getByRole("heading", { name: /Review the exact restore/i }).waitFor();
      await qualificationDialog.locator("[data-panel-program-confirm]").check();
      await qualificationDialog.locator("[data-panel-program-supervised]").check();
      await qualificationDialog.locator('[data-panel-dialog-action="apply"]').click();
      await qualificationDialog.getByRole("heading", {
        name: /Recovery restore verified — repeat writer check/i,
      }).waitFor();
      assert.equal(
        await qualificationDialog.locator('[data-panel-dialog-action="teach"]').count(),
        0,
        "a recovery restore never skips the fresh validation by offering Teach",
      );
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "required");
      assert.match(
        (await qualificationDialog.textContent()).replace(/\s+/g, " "),
        /does not qualify the writer.*Return to step 1.*full-chart programming remain locked/i,
        "the open result rerenders from the authoritative Required state",
      );
      const restartValidation = qualificationDialog.locator(
        '[data-panel-dialog-action="restart-validation"]',
      );
      assert.equal(await restartValidation.isEnabled(), true);
      await restartValidation.click();
      await qualificationDialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(
          '[data-nx="surface-qualification-terminal"]',
        )),
        true,
        "recovery returns focus to the standalone writer-check picker even without relying on a modeled panel channel",
      );
      assert.equal(await custom.getAttribute("aria-pressed"), "true");
      assert.equal(await review.isDisabled(), true,
        "the restored baseline requires a fresh single-terminal change");
      assert.match(await review.textContent(), /Review one-terminal test/i);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Control Surface keeps unsupported, unavailable, stale, and failed panel reads distinct", async () => {
    let answer = "unsupported";
    let panelCalls = 0;
    const waitForPanelCalls = async (expected) => {
      const deadline = Date.now() + 10_000;
      while (panelCalls < expected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(panelCalls >= expected, `expected ${expected} panel status calls, saw ${panelCalls}`);
    };
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/status", async (route) => {
        panelCalls += 1;
        if (answer === "http-error") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixture unavailable" }),
          });
          return;
        }
        const payload = answer === "mismatch"
          ? panelStatusPayload({
              targetSelector: "usb:ffff:0001:00",
              name: "Wrong stale encoder",
            })
          : answer === "unavailable"
          ? {
              target_selector: PANEL_SELECTOR,
              unavailable: "USB inventory could not be read; this is not an empty or healthy panel result.",
              view: null,
            }
          : panelStatusPayload({
              name: "Generic USB Encoder",
              driver: "unsupported",
              driverSupported: false,
              modeLabel: "Keyboard-compatible HID mode",
              recommendation: "Teach and Route still work for its keyboard-class input, but this panel protocol cannot be inspected.",
              chartState: "unsupported-driver",
              chartAttempted: false,
              chartLabel: "Chart read-back unsupported",
              chartDetail: "No registered status driver can read this encoder's chart.",
              configurationState: "unsupported-driver",
              configurationDetail: "No configuration collection is claimed for an unsupported driver.",
            });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      const card = page.locator(".n-widget-surface .n-surface-hardware");
      await waitForPanelCalls(2);
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "unsupported" &&
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("aria-busy") === "false");
      let copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /Generic USB Encoder/);
      assert.match(copy, /Unsupported panel protocol/);
      assert.match(copy, /Chart read-back unsupported/);
      assert.match(copy, /Teach and Route still work/);
      assert.equal(await page.locator(".n-widget-surface .n-surface-stage").count(), 3);

      answer = "mismatch";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await waitForPanelCalls(3);
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "error" &&
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("aria-busy") === "false");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /selected encoder changed before this inspection finished/i);
      assert.doesNotMatch(copy, /Wrong stale encoder/);

      answer = "unavailable";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await waitForPanelCalls(4);
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "unavailable" &&
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("aria-busy") === "false");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /USB inventory could not be read/);
      assert.match(copy, /not an empty or healthy panel result/);

      answer = "http-error";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await waitForPanelCalls(5);
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "error" &&
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("aria-busy") === "false");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /HTTP 503/);
      assert.match(copy, /Nothing was changed/);
      assert.doesNotMatch(copy, /Chart read-back unsupported/);
      assert.equal(panelCalls, 5,
        "one closed-surface recovery check plus the open inspection and three explicit refreshes ran");
      const unexpectedNoise = page.ksxNoise.filter((line) =>
        !/Failed to load resource:.*503 \(Service Unavailable\)/i.test(line)
      );
      assert.deepEqual(unexpectedNoise, []);
      assert.ok(
        page.ksxNoise.some((line) => /503 \(Service Unavailable\)/i.test(line)),
        "the intentional HTTP-failure fixture reached the browser",
      );
    } finally {
      await page.close();
    }
  });

  test("an exact encoder profile stays blocked until its live mode and configuration collection are ready", async () => {
    let state = "mode";
    let chartCalls = 0;
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/status", (route) => {
        const modeBlocked = state === "mode";
        const collectionBlocked = state === "collection";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelStatusPayload({
            mode: modeBlocked ? "unknown" : "keyboard-compatible",
            modeLabel: modeBlocked ? "Keyboard-compatible mode not observed" : "Keyboard-compatible input observed",
            modeDetail: modeBlocked
              ? "The required keyboard input interface is not present."
              : "Keyboard-compatible HID input was observed.",
            configurationState: collectionBlocked ? "ambiguous" : "available-unopened",
            configurationDetail: collectionBlocked
              ? "Two possible configuration collections were observed; neither was selected."
              : "One exact five-byte configuration collection is available and remains unopened.",
          })),
        });
      });
      await candidate.route("**/api/panel/chart", (route) => {
        chartCalls += 1;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "a blocked UI must never request the chart" }),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      const surface = page.locator(".n-widget-surface");
      const card = surface.locator(".n-surface-hardware");
      const setup = surface.locator('[data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "blocked");
      assert.equal((await setup.textContent()).trim(), "Resolve hardware first");
      assert.equal(await setup.isDisabled(), true);
      assert.match(await setup.getAttribute("title"), /keyboard-compatible input.*configuration collection/i);

      state = "collection";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface [data-surface-hardware-configuration]")
          ?.textContent?.includes("Two possible configuration collections"));
      assert.equal(await card.getAttribute("data-state"), "blocked");
      assert.equal(await setup.isDisabled(), true);

      state = "ready";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "ready");
      assert.equal(await setup.isEnabled(), true);
      assert.equal((await setup.textContent()).trim(), "Open hardware outputs…");
      assert.equal(chartCalls, 0, "status recovery remains passive until the user opens setup");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a recognized encoder without an exact chart profile stays in Build, Teach, and Route", async () => {
    let chartCalls = 0;
    const hardwareWrites = [];
    const page = await openCanvas({}, async (candidate) => {
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/panel/chart") chartCalls += 1;
        if (request.method() !== "GET" && pathname.startsWith("/api/panel/")) {
          hardwareWrites.push(pathname);
        }
      });
      await candidate.route("**/api/panel/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelStatusPayload({
          name: "Ultimarc Mini-PAC",
          identity: "USB D209:0440 · bcdDevice 0x0056",
          productId: 0x0440,
          driver: "unsupported",
          driverSupported: false,
          driverLabel: "Ultimarc Mini-PAC recognized; release 0x0056 is not supported for programming",
          familyId: "ultimarc-minipac",
          familyLabel: "Ultimarc Mini-PAC",
          capabilities: {
            can_identify: true,
            can_report_mode: false,
            can_read_chart: false,
            can_write_chart: false,
            write_is_persistent: false,
          },
          firmwareLabel: null,
          profileTerminalCount: null,
          chartState: "unsupported-release",
          chartLabel: "Chart not read — this encoder release is not profiled",
          chartDetail: "KSX recognized the encoder family but did not select a report protocol.",
          configurationState: "unsupported-release",
          configurationDetail: "No configuration collection was selected.",
          recommendation: "Keep using Teach and Route while a separately measured profile is developed.",
        })),
      }));
    });

    try {
      const encoderLane = page.locator(".n-encoder-form").filter({ hasText: "Ultimarc I-PAC 4" });
      await encoderLane.locator('[data-nx="encoder-select-setup"]').click();
      const surface = page.locator(".n-widget-surface");
      await surface.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "recognized");

      assert.equal(await surface.getAttribute("data-entry"), "builder");
      assert.equal(await surface.locator(".n-surface-programming:visible").count(), 0,
        "recognition alone never opens the chart editor");
      assert.equal(chartCalls, 0, "recognition never probes a configuration report");
      const setup = surface.locator('[data-nx="surface-encoder-open"]');
      assert.equal((await setup.textContent()).trim(), "Recognition only");
      assert.equal(await setup.isDisabled(), true);
      assert.match(
        (await surface.locator(".n-surface-hardware").textContent()).replace(/\s+/g, " "),
        /Ultimarc Mini-PAC.*recognized.*not supported for programming.*Teach and Route/i,
      );
      assert.equal(await surface.locator(".n-surface-stages").isVisible(), true);
      assert.equal(await surface.locator(".n-surface-starters").isVisible(), true);
      await surface.locator('[data-surface-template="arcade-stick"]').click();
      assert.equal(await surface.locator(".n-surface-control").count(), 11,
        "a recognition-only encoder still gets the complete physical-panel workflow");
      assert.deepEqual(hardwareWrites, [], "no chart read or persistent operation was attempted");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a readable encoder chart generates an honest physical panel before Teach owns its routes", async () => {
    const writes = [];
    let chartFingerprint = PANEL_FINGERPRINT;
    let physicalGeneration = 1200;
    let physicalHitReady = false;
    let physicalDevice = "";
    let physicalKey = "W";
    let capInstanceOverride = "";
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/nocturne*", async (route) => {
        const headers = { ...route.request().headers() };
        delete headers["if-none-match"];
        const response = await route.fetch({ headers });
        if (response.status() !== 200) {
          await route.fulfill({ response });
          return;
        }
        const payload = await response.json();
        if (capInstanceOverride) payload.view.cap_instance = capInstanceOverride;
        for (const pad of payload.view?.pads ?? []) {
          if (pad.slot === 1) continue;
          pad.mapping_available = false;
          pad.macro_available = false;
        }
        await route.fulfill({ response, json: payload });
      });
      candidate.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() !== "GET" &&
            (pathname.includes("/bind") || pathname.includes("/program/apply") ||
              pathname.includes("/restore/apply"))) writes.push(pathname);
      });
      await candidate.route("**/api/learn/start", (route) => {
        physicalGeneration += 1;
        physicalHitReady = false;
        return route.fulfill({
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
      await candidate.route("**/api/learn", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          state: physicalHitReady ? "hit" : "listening",
          generation: physicalGeneration,
          remaining_ms: physicalHitReady ? null : 10_000,
          device: physicalHitReady ? physicalDevice : null,
          key: physicalHitReady ? physicalKey : null,
          error: null,
        }),
      }));
      await candidate.route("**/api/panel/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelStatusPayload({
          driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
          chartState: "not-read",
          chartLabel: "Chart not read — explicit action required",
          configurationState: "available-unopened",
          configurationDetail: "The exact configuration collection is ready for a guarded read.",
        })),
      }));
      await candidate.route("**/api/panel/chart", (route) => {
        const payload = panelChartPayload();
        payload.view.board_fingerprint = chartFingerprint;
        const keyValue = (key, code) => ({ code, key, label: key, supported: true });
        const empty = { code: 0, key: null, label: "Unassigned", supported: true };
        const terminal = (id, label, player, kind, key, code) => ({
          terminal_id: id,
          terminal_label: `Player ${player} · ${label}`,
          player,
          kind,
          normal: keyValue(key, code),
          shifted: empty,
          shift_state: "disabled",
          is_shift: false,
        });
        payload.view.terminals = [
          terminal(
            "1up",
            "Up",
            1,
            "direction",
            chartFingerprint === PANEL_FINGERPRINT ? "W" : "Q",
            chartFingerprint === PANEL_FINGERPRINT ? 26 : 20,
          ),
          terminal("1right", "Right", 1, "direction", "D", 7),
          terminal("1down", "Down", 1, "direction", "S", 22),
          terminal("1left", "Left", 1, "direction", "A", 4),
          terminal("1sw1", "Button 1", 1, "button", "J", 13),
          terminal("1sw2", "Left flipper", 1, "button", "K", 14),
          terminal("1start", "Start", 1, "start", "1", 30),
          terminal("2up", "Up", 2, "direction", "ArrowUp", 82),
          terminal("2right", "Right", 2, "direction", "ArrowRight", 79),
          terminal("2down", "Down", 2, "direction", "ArrowDown", 81),
          terminal("2left", "Left", 2, "direction", "ArrowLeft", 80),
          terminal("2sw1", "Button 1", 2, "button", "Numpad1", 89),
        ];
        payload.view.recommended_terminals = payload.view.terminals;
        payload.view.key_options = payload.view.terminals.map((row) => ({
          key: row.normal.key,
          label: row.normal.label,
          code: row.normal.code,
          safe_for_qualification: false,
        }));
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      const surface = page.locator(".n-widget-surface");
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "ready");
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface[data-entry="encoder-setup"] .n-surface-programming')
          ?.getAttribute("data-qualification") === "qualified");
      const buildPanel = surface.locator('[data-nx="surface-encoder-build-panel"]');
      assert.equal(await buildPanel.isEnabled(), true);
      await buildPanel.click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-deck")
          ?.getAttribute("data-template") === "encoder-current");
      await settle(page);

      assert.equal(await surface.locator('.n-surface-deck').getAttribute("data-panel-layout"), "four-player");
      assert.equal(await surface.locator('.n-surface-deck').getAttribute("data-stage"), "teach");
      assert.equal(await surface.locator('.n-surface-control').count(), 6,
        "four direction terminals per player collapse into one physical stick");
      assert.equal(await surface.locator('.n-surface-control.kind-joystick').count(), 2);
      assert.equal(await surface.locator('.n-surface-control.expected').count(), 6);
      assert.equal(await surface.locator('.n-surface-control.taught').count(), 0);
      assert.match(
        (await surface.locator('.n-surface-control').allTextContents()).join(" "),
        /P1\s+SW1\s*→\s*J\s*\?/i,
        "a physical action shows the board terminal and configured Windows key",
      );
      const buttonOneSignal = surface.locator(
        '.n-surface-signal-chain[data-terminal-id="1sw1"]',
      );
      assert.equal(await buttonOneSignal.count(), 1);
      assert.equal(
        (await buttonOneSignal.locator('.n-surface-terminal-chip').textContent()).trim(),
        "P1 SW1",
      );
      const buttonOneKeycap = buttonOneSignal.locator('.n-surface-signal-keycap');
      assert.equal(await buttonOneKeycap.getAttribute("data-expected-key"), "J");
      assert.equal(await buttonOneKeycap.getAttribute("data-flow-key"), "J");
      assert.equal(await buttonOneKeycap.getAttribute("data-flow-authority"), "configured");
      assert.equal(await buttonOneKeycap.getAttribute("data-key"), null,
        "the configured keycap is useful to the provisional graph without claiming a Windows observation");
      assert.equal(await surface.locator('.n-surface-channel-anchor').count(), 12);
      assert.equal(await surface.locator('.n-surface-channel-anchor[data-key]').count(), 0,
        "configured expectations do not impersonate a Teach-observed Windows signal");
      const lowerStick = surface.locator('.n-surface-control.kind-joystick').nth(1);
      const lowerStickBox = await lowerStick.boundingBox();
      const panelDeckBox = await surface.locator('.n-surface-deck').boundingBox();
      assert.ok(lowerStickBox && panelDeckBox);
      await page.mouse.move(
        lowerStickBox.x + lowerStickBox.width / 2,
        lowerStickBox.y + lowerStickBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        lowerStickBox.x + lowerStickBox.width / 2,
        panelDeckBox.y + panelDeckBox.height * (472 / 720) + lowerStickBox.height / 2,
        { steps: 5 },
      );
      await page.mouse.up();
      await page.waitForFunction(() =>
        document.querySelectorAll('.n-widget-surface .n-surface-control.kind-joystick')[1]
          ?.getAttribute('data-signal-v') === 'above'
      );
      assert.equal(await lowerStick.evaluate((element) => {
        const deckRect = element.closest('.n-surface-deck')?.getBoundingClientRect();
        return Boolean(deckRect) && Array.from(
          element.querySelectorAll('.n-surface-signal-keycap'),
        ).every((keycap) => {
          const rect = keycap.getBoundingClientRect();
          return rect.top >= deckRect.top - 1 && rect.bottom <= deckRect.bottom + 1;
        });
      }), true, "all four joystick signal rows dock inward before any keycap is clipped");
      for (let attempt = 0; attempt < 20 &&
          Number.parseInt((await page.textContent('.n-zoomval')).trim(), 10) < 200;
          attempt += 1) {
        await page.click('[data-nx="canvas-zoom-in"]');
      }
      assert.equal((await page.textContent('.n-zoomval')).trim(), '200%');
      await lowerStick.evaluate((element) => element.click());
      assert.equal(await lowerStick.getAttribute('data-signal-v'), 'above',
        "four-row docking uses untransformed deck geometry and stays correct at 200% canvas zoom");
      await page.click('[data-nx="canvas-zoom-reset"]');
      await page.click('[data-nx="canvas-fit"]');
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-kb .n-ipac-signal-roster-shell')
          ?.getAttribute('data-panel-fallback') === 'true'
      );
      const generatedSignalOwnership = await page.evaluate(() => {
        const surface = document.querySelector('.n-widget-surface');
        const workarea = surface?.querySelector('.n-surface-workarea');
        const shelf = document.querySelector('.n-widget-kb .n-ipac-signal-roster-shell');
        return {
          surfaceOpen: surface?.getAttribute('data-entry') ?? null,
          workareaHidden: workarea?.hidden ?? null,
          panelFallback: shelf?.getAttribute('data-panel-fallback') ?? null,
          shelfOpen: shelf?.hasAttribute('open') ?? null,
          flowKeys: Array.from(
            surface?.querySelectorAll('.n-surface-signal-keycap[data-flow-key]') ?? [],
            (node) => `${node.getAttribute('data-flow-key')}:${node.closest('.n-surface-control')?.getAttribute('data-player-slot') ?? '0'}`,
          ),
          pads: (JSON.parse(document.getElementById('__ksx-payload')?.textContent ?? '{}')
            .view?.pads ?? []).map((pad) => ({
              slot: pad.slot,
              mapping: pad.mapping_available,
              macros: pad.macro_available,
            })),
        };
      });
      assert.equal(
        generatedSignalOwnership.panelFallback,
        "true",
        `the complete chart-derived panel takes over the visible signal layer: ${JSON.stringify(generatedSignalOwnership)}`,
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal-roster-shell').getAttribute("open"),
        null,
        "the original terminal roster remains recoverable but folds once visible panel keycaps own every routed slot",
      );
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface')?.getAttribute('data-entry') === 'encoder-setup' &&
        document.querySelector('.n-widget-surface .n-surface-workarea')?.hidden === true
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal-roster-shell').getAttribute("open"),
        "",
        "Hardware Setup reopens the fallback while its physical keycaps are contextually hidden",
      );
      await surface.locator('[data-nx="surface-encoder-close"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface')?.getAttribute('data-entry') === 'builder' &&
        document.querySelector('.n-widget-surface .n-surface-workarea')?.hidden === false
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal-roster-shell').getAttribute("open"),
        null,
        "returning to the visible panel restores its compact source ownership",
      );
      await surface.locator('[data-nx="surface-new"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-workarea')?.hidden === true &&
        document.querySelector('.n-widget-kb .n-ipac-signal-roster-shell')
          ?.getAttribute('data-panel-fallback') === 'false'
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal-roster-shell').getAttribute("open"),
        "",
        "the replacement gallery restores visible source endpoints while panel keycaps are hidden",
      );
      await surface.locator('[data-nx="surface-template-cancel"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-workarea')?.hidden === false &&
        document.querySelector('.n-widget-kb .n-ipac-signal-roster-shell')
          ?.getAttribute('data-panel-fallback') === 'true'
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-ipac-signal-roster-shell').getAttribute("open"),
        null,
        "canceling replacement returns source ownership to the visible physical panel",
      );
      await page.selectOption('[data-nx="mapping-paths"]', "selected");
      await page.waitForFunction(() =>
        document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"][data-flow-source-authority="configured"]',
        ) && document.querySelector('#n-mapping-paths')?.getAttribute('data-flow-count') !== '0');
      const provisionalOrigin = await page.evaluate(() => {
        const edge = document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"]',
        );
        const port = edge?.getAttribute('data-flow-id')
          ? document.querySelector(
            `#n-mapping-ports [data-flow-id="${CSS.escape(edge.getAttribute('data-flow-id'))}"] .n-flow-port-source`,
          )
          : null;
        const keycap = document.querySelector(
          '.n-widget-surface .n-surface-signal-keycap[data-flow-key="W"]',
        );
        const face = keycap?.closest('.n-surface-control')?.querySelector('.n-surface-control-face');
        const portRect = port?.getBoundingClientRect();
        const keyRect = keycap?.getBoundingClientRect();
        const faceRect = face?.getBoundingClientRect();
        const point = portRect
          ? { x: portRect.left + portRect.width / 2, y: portRect.top + portRect.height / 2 }
          : null;
        const onKeycap = Boolean(point && keyRect) &&
          point.x >= keyRect.left - 1 && point.x <= keyRect.right + 1 &&
          point.y >= keyRect.top - 1 && point.y <= keyRect.bottom + 1 &&
          Math.min(
            Math.abs(point.x - keyRect.left),
            Math.abs(point.x - keyRect.right),
            Math.abs(point.y - keyRect.top),
            Math.abs(point.y - keyRect.bottom),
          ) <= 1.5;
        const onPhysicalFace = Boolean(point && faceRect) &&
          point.x >= faceRect.left && point.x <= faceRect.right &&
          point.y >= faceRect.top && point.y <= faceRect.bottom;
        return {
          onKeycap,
          onPhysicalFace,
          path: edge?.querySelector('.n-flow-core')?.getAttribute('d') ?? '',
        };
      });
      assert.equal(provisionalOrigin.onKeycap, true,
        "the provisional route begins on the visible Windows-key token");
      assert.equal(provisionalOrigin.onPhysicalFace, false,
        "the route does not skip the encoder/key boundary and start on the arcade control");
      const firstStick = surface.locator('.n-surface-control.kind-joystick').first();
      const upKeycap = firstStick.locator(
        '.n-surface-signal-chain[data-terminal-id="1up"] .n-surface-signal-keycap',
      );
      const rightKeycap = firstStick.locator(
        '.n-surface-signal-chain[data-terminal-id="1right"] .n-surface-signal-keycap',
      );
      await upKeycap.dispatchEvent("click");
      assert.equal(await upKeycap.getAttribute("data-selected"), "true",
        "a joystick keycap selects its own physical channel without becoming a drag gesture");
      const rightTerminal = firstStick.locator(
        '.n-surface-signal-chain[data-terminal-id="1right"] .n-surface-terminal-chip',
      );
      const stickPosition = await firstStick.evaluate((element) => ({
        left: element.style.left,
        top: element.style.top,
      }));
      const terminalBox = await rightTerminal.boundingBox();
      assert.ok(terminalBox);
      await page.mouse.move(
        terminalBox.x + terminalBox.width / 2,
        terminalBox.y + terminalBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        terminalBox.x + terminalBox.width / 2 + 6,
        terminalBox.y + terminalBox.height / 2,
        { steps: 3 },
      );
      await page.mouse.up();
      await rightTerminal.click();
      assert.equal(await rightKeycap.getAttribute("data-selected"), "true",
        "the terminal side of a signal row selects that same joystick direction");
      assert.equal(await upKeycap.getAttribute("data-selected"), "false",
        "a terminal click never falls back to the joystick's first channel");
      assert.deepEqual(
        await firstStick.evaluate((element) => ({
          left: element.style.left,
          top: element.style.top,
        })),
        stickPosition,
        "a real pointer gesture on a signal row selects it without moving the physical control",
      );
      await upKeycap.dispatchEvent("click");
      await rightTerminal.hover();
      await page.waitForFunction(() => Boolean(document.querySelector(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="D"].is-related',
      )));
      assert.equal(await page.locator(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"].is-related',
      ).count(), 0, "hover inspection follows the visible direction keycap, not the stick's selected channel");
      await page.mouse.move(1, 1);
      physicalDevice = await page.evaluate(() => JSON.parse(
        document.getElementById("__ksx-payload")?.textContent ?? "{}",
      ).view?.cap_instance ?? "");
      assert.ok(physicalDevice, "Teach remains pinned to the exact selected Windows device");
      await surface.locator('[data-nx="surface-teach"]').evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      physicalHitReady = true;
      await page.waitForFunction(() => document.querySelector(
        '.n-widget-surface .n-surface-control.kind-joystick .n-surface-channel-anchor[data-key="W"]',
      ));
      assert.equal(
        await firstStick.locator('.n-surface-signal-keycap[data-key="W"]')
          .getAttribute('data-flow-authority'),
        'matched',
      );
      await page.waitForFunction(() => document.querySelector(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"][data-flow-source-authority="matched"]',
      ));
      const verifiedPath = await page.locator(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"] .n-flow-core',
      ).getAttribute('d');
      const pathStart = (value) => (value ?? '').match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/)
        ?.slice(1).map(Number) ?? [];
      const provisionalStart = pathStart(provisionalOrigin.path);
      const verifiedStart = pathStart(verifiedPath);
      assert.equal(provisionalStart.length, 2);
      assert.equal(verifiedStart.length, 2);
      assert.ok(
        Math.hypot(
          provisionalStart[0] - verifiedStart[0],
          provisionalStart[1] - verifiedStart[1],
        ) < 1,
        "Teach promotes the same keycap origin instead of making the cord jump to another source widget",
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        '.n-widget-surface .n-surface-signal-keycap[data-flow-key="W"]',
      );
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-hardware')
          ?.getAttribute('data-state') === 'ready'
      );
      assert.equal(
        await firstStick.locator('.n-surface-signal-keycap[data-flow-key="W"]')
          .getAttribute('data-flow-authority'),
        'observed',
        "a persisted Teach result remains a Windows observation until this session rereads the board chart",
      );

      capInstanceOverride = "HID\\VID_D209&PID_0430\\TEACH-REPLACEMENT";
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        '.n-widget-surface .n-surface-signal-keycap[data-expected-key="W"]',
      );
      await page.waitForFunction((expected) => Array.from(
        document.querySelectorAll('input[name="instance_id"]'),
      ).some((input) => input.value === expected), capInstanceOverride);
      await page.waitForFunction(() =>
        document.querySelector(
          '.n-widget-surface .n-surface-signal-chain.channel-up .n-surface-signal-keycap',
        )?.getAttribute('data-flow-authority') === 'expected');
      const replacedUp = firstStick.locator(
        '.n-surface-signal-chain.channel-up .n-surface-signal-keycap',
      );
      assert.equal(await replacedUp.getAttribute('data-last-observed-key'), 'W');
      assert.equal(await replacedUp.getAttribute('data-flow-authority'), 'expected');
      assert.equal(await replacedUp.getAttribute('data-flow-key'), null,
        "a persisted Teach result from the prior Windows instance cannot route its replacement");
      assert.equal(await replacedUp.getAttribute('data-key'), null,
        "the previous instance remains history rather than current Windows evidence");
      await replacedUp.click();
      assert.equal(await surface.locator('[data-nx="surface-route"]').isDisabled(), true,
        "Route stays unavailable until this exact replacement instance is taught");
      physicalDevice = capInstanceOverride;

      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")
          ?.getAttribute("data-state") === "ready");
      await surface.locator('[data-nx="surface-encoder-open"]')
        .evaluate((button) => button.click());
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface[data-entry="encoder-setup"] .n-surface-programming')
          ?.getAttribute('data-qualification') === 'qualified'
      );
      await surface.locator('[data-nx="surface-encoder-close"]').click();
      await page.waitForFunction(() =>
        document.querySelector(
          '.n-widget-surface .n-surface-signal-keycap[data-flow-key="W"]',
        )?.getAttribute('data-flow-authority') === 'configured'
      );
      await replacedUp.click();
      physicalKey = "W";
      await surface.locator('[data-nx="surface-teach"]').evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      physicalHitReady = true;
      await page.waitForFunction(() =>
        document.querySelector(
          '.n-widget-surface .n-surface-signal-keycap[data-flow-key="W"]',
        )?.getAttribute('data-flow-authority') === 'matched'
      );
      assert.equal(await firstStick.evaluate((element) => element.classList.contains("taught")), false,
        "one observed direction never claims that the whole four-channel stick is taught");
      assert.equal(await firstStick.evaluate((element) => element.classList.contains("partially-taught")), true);
      assert.match(
        (await firstStick.locator(".n-surface-control-signal").textContent()).replace(/\s+/g, " "),
        /U.*P1 UP.*W.*✓.*R.*P1 RIGHT.*D.*\?.*D.*P1 DOWN.*S.*\?.*L.*P1 LEFT.*A.*\?/i,
        "the taught direction and every still-unverified configured direction stay visible",
      );
      const stored = await page.evaluate(() => {
        const value = JSON.parse(localStorage.getItem("ksx-nocturne-control-surfaces1") ?? "null");
        const device = Object.values(value?.devices ?? {})[0];
        return device?.controls.flatMap((control) => control.channels.map((channel) => ({
          input: channel.input.kind,
          expected: channel.encoder?.expectedKey ?? "",
          verification: channel.encoder?.verification ?? "",
        }))) ?? [];
      });
      assert.equal(stored.length, 12);
      assert.equal(stored.filter((channel) => channel.input === "keyboard").length, 1);
      assert.equal(stored.filter((channel) => channel.verification === "matched").length, 1);
      assert.ok(stored.every((channel) => channel.expected));

      physicalKey = "K";
      const mismatchedButton = surface.locator(
        '.n-surface-control:has(.n-surface-signal-chain[data-terminal-id="1sw1"])',
      );
      await mismatchedButton.evaluate((control) => control.click());
      await surface.locator('[data-nx="surface-teach"]').evaluate((button) => button.click());
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      physicalHitReady = true;
      await page.waitForFunction(() => document.querySelector(
        '.n-surface-signal-chain[data-terminal-id="1sw1"][data-verification="mismatch"] ' +
          '.n-surface-signal-keycap[data-expected-key="J"][data-key="K"][data-flow-key="K"]',
      ));
      assert.match(
        (await mismatchedButton.locator('.n-surface-control-signal').textContent()).replace(/\s+/g, ' '),
        /P1 SW1.*J.*≠.*K/i,
        "a stale chart expectation and the observed Windows key remain visibly distinct",
      );
      await page.waitForFunction(() => document.querySelector(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="K"]' +
          '[data-flow-source-authority="mismatch"]',
      ));
      const configuredDuplicate = surface.locator(
        '.n-surface-signal-chain[data-terminal-id="1sw2"] ' +
          '.n-surface-signal-keycap[data-flow-key="K"][data-flow-authority="configured"]',
      );
      await configuredDuplicate.evaluate((keycap) => keycap.click());
      assert.equal(await configuredDuplicate.getAttribute("data-selected"), "true");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      )));
      await page.waitForFunction(() => Boolean(document.querySelector(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-slot="1"][data-flow-key="K"]' +
          '[data-flow-source-authority="mismatch"]',
      )), undefined, { timeout: 3_000 });
      const mismatchOrigin = await page.evaluate(() => {
        const edge = document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-slot="1"][data-flow-key="K"]',
        );
        const id = edge?.getAttribute('data-flow-id') ?? '';
        const port = id
          ? document.querySelector(
            `#n-mapping-ports [data-flow-id="${CSS.escape(id)}"] .n-flow-port-source`,
          )
          : null;
        const keycap = document.querySelector(
          '.n-surface-signal-keycap[data-expected-key="J"][data-key="K"]',
        );
        const portRect = port?.getBoundingClientRect();
        const keyRect = keycap?.getBoundingClientRect();
        const point = portRect
          ? { x: portRect.left + portRect.width / 2, y: portRect.top + portRect.height / 2 }
          : null;
        return Boolean(point && keyRect) &&
          point.x >= keyRect.left - 1 && point.x <= keyRect.right + 1 &&
          point.y >= keyRect.top - 1 && point.y <= keyRect.bottom + 1;
      });
      assert.equal(mismatchOrigin, true,
        "a selected configured duplicate cannot steal the route from the key Windows observed");
      await firstStick.locator(
        '.n-surface-signal-chain[data-terminal-id="1right"] .n-surface-signal-keycap',
      ).evaluate((keycap) => keycap.click());
      await surface.locator('[data-nx="surface-encoder-terminal"]').selectOption("");
      await page.mouse.move(1, 1);
      await page.waitForFunction(() =>
        document.querySelectorAll(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"].is-related',
        ).length === 0);
      await firstStick.locator(
        '.n-surface-signal-chain.channel-right .n-surface-signal-direction',
      ).evaluate((direction) => direction.dispatchEvent(new PointerEvent("pointerover", {
        bubbles: true,
      })));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      )));
      assert.equal(await page.locator(
        '#n-mapping-paths [data-flow-kind="binding"][data-flow-key="W"].is-related',
      ).count(), 0, "hovering an unassigned stick direction never highlights a sibling's route");

      chartFingerprint = `${PANEL_FINGERPRINT}:replacement`;
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await surface.locator('.n-surface-programming').waitFor({ state: "visible" });
      page.once("dialog", (dialog) => dialog.accept());
      await surface.locator('[data-nx="surface-encoder-read"]').click();
      await page.waitForFunction(() =>
        document.querySelector(
          '.n-widget-surface [data-nx="surface-terminal-key"]' +
            '[data-panel-terminal="1up"][data-panel-field="normal"]',
        )?.value === "Q"
      );
      await surface.locator('[data-nx="surface-encoder-close"]').click();
      const staleUp = firstStick.locator('.n-surface-signal-chain.channel-up .n-surface-signal-keycap');
      assert.equal(await staleUp.getAttribute('data-flow-key'), null,
        "a complete read from a different board disproves the persisted terminal link");
      await staleUp.evaluate((keycap) => keycap.click());
      assert.equal(await surface.locator('[data-nx="surface-route"]').isDisabled(), true,
        "a retained observation from the previous board cannot be routed");
      await surface.locator('[data-nx="surface-close"]').click();
      await surface.waitFor({ state: "detached" });
      const fallback = page.locator('.n-widget-kb .n-ipac-signal-roster-shell');
      assert.equal(await fallback.getAttribute("data-panel-fallback"), "false");
      assert.equal(await fallback.getAttribute("open"), "",
        "closing the physical panel immediately restores the visible signal shelf");
      assert.equal(await fallback.evaluate((element) => element.tagName), "SECTION",
        "the only visible signal shelf is structural, not user-collapsible");
      await fallback.locator('.n-ipac-signal-roster-summary').click();
      assert.equal(await fallback.getAttribute("open"), "",
        "the only visible signal shelf cannot hide every route endpoint");
      assert.equal(await fallback.locator('.n-ipac-signal[data-key="D"]').first().isVisible(), true);
      const fallbackOriginHandle = await page.waitForFunction(() => {
        const edge = document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-slot="1"][data-flow-key="D"]',
        );
        const id = edge?.getAttribute('data-flow-id') ?? '';
        const port = id
          ? document.querySelector(
            `#n-mapping-ports [data-flow-id="${CSS.escape(id)}"] .n-flow-port-source`,
          )
          : null;
        const source = document.querySelector(
          '.n-widget-kb .n-ipac-signal[data-key="D"][data-player-slot="1"]',
        );
        const portRect = port?.getBoundingClientRect();
        const sourceRect = source?.getBoundingClientRect();
        if (!edge || edge.classList.contains('is-unresolved') || !portRect || !sourceRect ||
            portRect.width < 1 || portRect.height < 1) return null;
        const center = {
          x: portRect.left + portRect.width / 2,
          y: portRect.top + portRect.height / 2,
        };
        return center.x >= sourceRect.left - 1 && center.x <= sourceRect.right + 1 &&
          center.y >= sourceRect.top - 1 && center.y <= sourceRect.bottom + 1
          ? { source: source.textContent, authority: edge.getAttribute('data-flow-source-authority') }
          : null;
      });
      const fallbackOrigin = await fallbackOriginHandle.jsonValue();
      assert.match(fallbackOrigin.source.replace(/\s+/g, " "), /1RIGHT.*Player 1.*Right.*D/i,
        "post-close layout moves the source port onto the restored terminal/key shelf");
      assert.deepEqual(writes, []);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a partial player panel keeps the slot-safe I-PAC signal fallback visible", async () => {
    const page = await openCanvas({}, async (candidate) => {
      await candidate.route("**/api/panel/status", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelStatusPayload({
          driverLabel: "Ultimarc I-PAC 4 lossless chart driver",
          chartState: "not-read",
          chartLabel: "Chart not read — explicit action required",
          configurationState: "available-unopened",
          configurationDetail: "The exact configuration collection is ready for a guarded read.",
        })),
      }));
      await candidate.route("**/api/panel/chart", async (route) => {
        const payload = panelChartPayload();
        payload.view.terminals[0] = {
          ...payload.view.terminals[0],
          terminal_id: "1sw1",
          terminal_label: "Player 1 · Button 1",
          player: 1,
          normal: { code: 26, key: "W", label: "W", supported: true },
        };
        payload.view.terminals[1] = {
          ...payload.view.terminals[1],
          terminal_id: "2sw1",
          terminal_label: "Player 2 · Button 1",
          player: 2,
          normal: { code: 89, key: "Numpad1", label: "Numpad1", supported: true },
        };
        payload.view.recommended_terminals = payload.view.terminals;
        payload.view.key_options = [
          { key: "W", label: "W", code: 26, safe_for_qualification: false },
          { key: "Numpad1", label: "Numpad1", code: 89, safe_for_qualification: false },
        ];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      const surface = page.locator('.n-widget-surface');
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-hardware')
          ?.getAttribute('data-state') === 'ready'
      );
      await surface.locator('[data-nx="surface-encoder-open"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-programming')
          ?.getAttribute('data-qualification') === 'qualified'
      );
      await surface.locator('[data-nx="surface-encoder-build-panel"]').click();
      await page.waitForFunction(() =>
        document.querySelector('.n-widget-surface .n-surface-deck')
          ?.getAttribute('data-template') === 'encoder-current'
      );

      assert.equal(await surface.locator(
        '.n-surface-signal-keycap[data-flow-key="W"][data-player-slot="1"]',
      ).count(), 1);
      assert.equal(await surface.locator(
        '.n-surface-signal-keycap[data-flow-key="W"][data-player-slot="2"]',
      ).count(), 0);
      const fallback = page.locator('.n-widget-kb .n-ipac-signal-roster-shell');
      assert.equal(await fallback.getAttribute('data-panel-fallback'), 'false');
      assert.equal(await fallback.getAttribute('open'), '',
        "a P1 W token cannot hide the only slot-compatible fallback for P2 W");
      await page.selectOption('[data-nx="mapping-paths"]', 'all');
      await page.waitForFunction(() => {
        const edge = document.querySelector(
          '#n-mapping-paths [data-flow-kind="binding"][data-flow-slot="2"][data-flow-key="W"]',
        );
        return Boolean(edge) && !edge.classList.contains('is-unresolved');
      });
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

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
      assert.equal(
        await page.locator(".n-widget-surface [data-surface-template]").count(),
        7,
        "the starter gallery offers blank, hardware, and mapping-derived entries",
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
      await candidate.route("**/api/panel/chart", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelChartPayload({ imageSha256: PANEL_BASE_SHA, backup: null })),
      }));
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable");
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');
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
    await page.route("**/api/panel/chart", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(panelChartPayload({
          imageSha256: PANEL_BASE_SHA,
          backup: null,
        })),
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready"
      );
      await page.click('.n-widget-surface [data-nx="surface-encoder-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-programming")
          ?.getAttribute("data-capability") === "programmable");
      await page.click('.n-widget-surface [data-nx="surface-encoder-close"]');
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await clickTeach();
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      await page.locator('.n-widget-kb .n-ipac-signal[data-key="B"]').evaluate(
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
      assert.deepEqual(bindBodies, [{
        slot: 2,
        expected_target_revision: routedTargetRevision,
        function: "A",
        key: "L",
        mode: "replace",
        force: false,
        encoder_authority: {
          expected_selector: PANEL_SELECTOR,
          expected_instance: expectedDevice,
          expected_board_fingerprint: PANEL_FINGERPRINT,
          expected_chart_sha256: PANEL_BASE_SHA,
        },
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
