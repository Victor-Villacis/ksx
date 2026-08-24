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
  driver = "ultimarc-ipac",
  driverSupported = true,
  driverLabel = "Ultimarc I-PAC family",
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
  configurationState = "candidate-unverified",
  configurationDetail = "One passive 5-byte input/output candidate was observed; its protocol is unverified.",
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
        board_id: "USB\\VID_D209&PID_0430\\FIXTURE",
        name,
        identity,
        vendor_id: 0xd209,
        product_id: 0x0430,
        bcd_device: 0x0056,
        firmware_label: firmwareLabel,
        firmware_detail: firmwareDetail,
        profile_terminal_count: profileTerminalCount,
        serial: null,
        driver,
        driver_supported: driverSupported,
        driver_label: driverSupported ? driverLabel : "Unsupported panel protocol",
        observed_mode: mode,
        mode_detail: modeDetail,
        observed_mode_label: modeLabel,
        mode_read_supported: false,
        chart_state: chartState,
        chart_attempted: chartAttempted,
        chart_detail: chartDetail,
        chart_label: chartLabel,
        configuration_collection_state: configurationState,
        configuration_collection: configurationState === "candidate-unverified" ? "HID MI_02" : null,
        configuration_collection_detail: configurationDetail,
        recommendation,
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

describe("the canvas navigation controls", () => {
  test("mapping actions keep their controller truth after the legacy pane is absent", async () => {
    const page = await openCanvas();
    let resolveBind;
    const bound = new Promise((resolve) => {
      resolveBind = resolve;
    });
    await page.route("**/nocturne/api/bind", async (route) => {
      resolveBind(JSON.parse(route.request().postData() ?? "{}"));
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
    });
    try {
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
      await signal.click();
      await page.locator(
        '.n-widget-pad[data-instance-id="pad-1"] [data-fn~="a"]',
      ).first().click({ force: true });
      const request = await bound;
      assert.equal(request.slot, 1);
      assert.equal(request.key, signalKey);
      assert.equal(request.function, "A", "pad art resolves the mapper's canonical spelling");
      assert.equal(request.mode, "replace");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the mapping inspector follows canvas selection and Find returns to the whole graph", async () => {
    const page = await openCanvas();
    try {
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

      await page.locator('.n-widget-kb [data-key="G"]').click({ force: true });
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
      await page.close();
    }
  });

  test("an arranged keyboard keycap is a first-class mapping source", async () => {
    const page = await openCanvas();
    let resolveBound;
    const bound = new Promise((resolve) => {
      resolveBound = resolve;
    });
    await page.route("**/nocturne/api/bind", async (route) => {
      resolveBound(route.request());
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
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.equal(await keycap.evaluate((element) => element.classList.contains("assign")), false);
      assert.equal(boundBody?.slot, 1);
      assert.equal(boundBody?.key, "G");
      assert.equal(boundBody?.function, "A");
      assert.equal(boundBody?.mode, "add");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
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
          children: ["A", "BUTTON", "BUTTON"],
        },
        "move and Auto are sibling controls around the unchanged editor link",
      );
      assert.deepEqual(
        await page.locator(shellSelector).evaluate((shell) => {
          const grip = shell.querySelector(".n-flow-processor-grip");
          const auto = shell.querySelector(".n-flow-processor-auto");
          return {
            gripLabel: grip?.getAttribute("aria-label"),
            gripShortcuts: grip?.getAttribute("aria-keyshortcuts"),
            autoLabel: auto?.getAttribute("aria-label"),
          };
        }),
        {
          gripLabel:
            `Move hadouken for Player ${processorSlot}. Drag, or use Arrow keys; Shift plus Arrow moves farther. Moving pins the processor.`,
          gripShortcuts:
            "ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Home Delete",
          autoLabel: `Return hadouken for Player ${processorSlot} to automatic placement`,
        },
        "the sibling controls expose their complete move and reset contracts",
      );
      assert.equal(await page.locator(autoSelector).isHidden(), true);

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
      await page.mouse.move(dragBaseline.grip.x, dragBaseline.grip.y);
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
        /has not read the I-PAC chart yet.*has not proven which physical terminals emit them/i,
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
      assert.match(await encoderMarker.getAttribute("title"), /I-PAC Signals.*Windows key source/i);
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

      await page.locator(".n-kbbuild").evaluate((button) => button.click());
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
      await page.locator(".n-kbbuild").evaluate((button) => button.click());
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

  test("Control Surface inspects the selected encoder only on open, refresh, or concrete identity change", async () => {
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
        if (panelCalls === 4) markReenumeratedPanelRead();
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
      assert.equal(panelCalls, 0, "the closed Builder is absent from the two-second poll payload");

      await page.click('[data-nx="surface-open"]');
      const card = page.locator(".n-widget-surface .n-surface-hardware");
      await card.waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      assert.equal(panelCalls, 1, "opening performs one explicit read");
      assert.deepEqual(methods, ["GET"]);
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
      assert.match(cardCopy, /One passive 5-byte input\/output candidate/);
      assert.match(cardCopy, /Inspection only\. KSX did not program or change this encoder\./);
      assert.equal(await card.locator("form").count(), 0);
      assert.equal(await card.locator("button").count(), 2, "the hardware card offers passive Refresh and explicit Encoder setup");
      assert.equal((await card.locator('[data-nx="surface-encoder-open"]').textContent()).trim(), "Set up I-PAC…");
      assert.equal(await card.locator('[data-nx*="program"], [data-nx*="write"]').count(), 0);
      const hardwareDetails = card.locator("details.n-surface-hardware-details");
      assert.equal(await hardwareDetails.getAttribute("open"), null);
      await hardwareDetails.locator("summary").click();
      assert.notEqual(await hardwareDetails.getAttribute("open"), null);
      const stageLabels = await page.locator(".n-widget-surface .n-surface-stage").evaluateAll(
        (buttons) => buttons.map((button) =>
          (button.textContent ?? "").replace(/^\s*\d+\s*/, "").trim()),
      );
      assert.deepEqual(stageLabels, ["Design", "Teach inputs", "Route outputs"]);

      await page.waitForTimeout(2_250);
      assert.equal(panelCalls, 1, "ordinary Nocturne polls do not re-inspect hardware");

      holdNextPanelRead = true;
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await withinPanelRead(heldPanelStarted, "the held panel refresh never reached the endpoint");
      observedMode = "unknown";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-mode") === "unknown");
      assert.equal(panelCalls, 3, "an explicit retry supersedes the in-flight inspection");
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
      assert.equal(panelCalls, 4, "a new concrete Windows instance under the same selector refreshes once");
      await page.waitForTimeout(2_250);
      assert.equal(panelCalls, 4, "the unchanged re-enumerated target does not refresh on every poll");
      assert.deepEqual(methods, ["GET", "GET", "GET", "GET"]);
      assert.deepEqual(panelWrites, []);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseHeldPanelRead();
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
        await encoderLane.getByRole("button", { name: "Set up Ultimarc I-PAC 4" }).count(),
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
          ?.includes("Hardware Setup has not read the I-PAC chart yet"));
      assert.match(
        (await page.locator('.n-widget-kb .n-ipac-signal-source > p').textContent()).replace(/\s+/g, " "),
        /KSX routes currently reference these Windows key names.*has not read the I-PAC chart yet.*has not proven which physical terminals emit them.*terminal → Windows key ownership/i,
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
        /I-PAC Hardware Setup.*I-PAC terminal.*Windows key.*KSX mapping.*virtual controller.*game.*Unconfigured I-PAC.*Verify this I-PAC writer.*Test wiring/i,
      );
      assert.deepEqual(
        await setup.locator("[data-panel-journey-step] strong").allTextContents(),
        ["I-PAC", "Windows keys", "KSX", "Controller", "Game"],
        "the workspace teaches the complete physical-terminal-to-game signal chain",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="keys"]').getAttribute("data-state"),
        "active",
        "an empty chart stops visibly at Windows key output rather than pretending the encoder is ready",
      );
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
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("I-PAC setup names a partial hardware chart as work to finish", async () => {
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
        /Partially configured I-PAC.*Finish the terminal-to-key chart.*1 of 2 terminals currently emit a supported Windows key/i,
      );
      assert.match(
        (await encoderLane.locator(".n-dev-meta").textContent()).replace(/\s+/g, " "),
        /Partially configured.*1\/2 outputs/i,
      );
      assert.equal(
        await encoderLane.getByRole("button", { name: /Finish setup.*Ultimarc I-PAC 4/i }).count(),
        1,
        "the rail resumes with an outcome-oriented action instead of calling every board first-run",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="keys"]').getAttribute("data-state"),
        "complete",
      );
      assert.equal(
        await setup.locator('[data-panel-journey-step="mapping"]').getAttribute("data-state"),
        "active",
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
        /Hardware output is only the source.*connect these Windows keys through KSX to virtual controller controls/i,
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
          payload.view.cap_instance = "HID\\VID_D209&PID_0430\\FIXTURE-REENUMERATED";
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
        /Configured I-PAC.*Use, test, or reconfigure the outputs.*All 56 terminals currently have supported Windows key outputs/i,
      );
      assert.deepEqual(
        await setup.locator("[data-panel-journey-step] strong").allTextContents(),
        ["I-PAC", "Windows keys", "KSX", "Controller", "Game"],
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
        /draft is not written.*Test current board.*outputs that are on the I-PAC now/i,
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
      learnDevice = "HID\\VID_D209&PID_0430\\FIXTURE-REENUMERATED";
      assert.ok(learnDevice, "the passive wiring test stays pinned to the re-enumerated Windows device instance");
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

  test("Encoder setup keeps three workflow stages and requires an exact reviewed consent before a mocked write", async () => {
    let chartReads = 0;
    let capturedPlan = null;
    let capturedApply = null;
    let learnGeneration = 880;
    let taughtDevice = "";
    let markApplyStarted = () => {};
    let releaseApply = () => {};
    const applyStarted = new Promise((resolve) => {
      markApplyStarted = resolve;
    });
    const applyGate = new Promise((resolve) => {
      releaseApply = resolve;
    });
    const page = await openCanvas({}, async (candidate) => {
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
            key: "B",
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
        assert.equal(body.backup, first, "the first setup read creates a restore point; post-verify refresh does not duplicate it");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(panelChartPayload({
            imageSha256: first ? PANEL_BASE_SHA : PANEL_DESIRED_SHA,
            backup: first ? panelBackup() : null,
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
        capturedApply = JSON.parse(route.request().postData() ?? "{}");
        markApplyStarted();
        await applyGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
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

    try {
      await page.click('[data-nx="surface-open"]');
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "ready");
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      assert.equal(await page.locator(".n-widget-surface .n-surface-control").count(), 2);

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
      ))).size, 2, "the regression uses two distinct physical drawings");
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
      await apply.click();
      await applyStarted;
      await page.keyboard.press("Escape");
      assert.equal(await dialog.getAttribute("open"), "", "an in-flight hardware transaction cannot be dismissed");
      assert.match(await dialog.textContent(), /Keep the encoder connected|Reading back every byte/i);
      releaseApply();

      await page.waitForFunction(() =>
        document.querySelector("dialog.n-panel-program-dialog")?.getAttribute("data-phase") === "verified");
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
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseApply();
      await page.close();
    }
  });

  test("Encoder setup binds completed and interrupted results to the encoder that owned them", async () => {
    const replacementSelector = "usb:d209:0430:01";
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
          markApplyStarted();
          await applyGate;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              target_selector: PANEL_SELECTOR,
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
        assert.deepEqual(page.ksxNoise, []);
      } finally {
        releaseApply();
        await page.close();
      }
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
        qualificationState = "validation-written";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            target_selector: PANEL_SELECTOR,
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
      await controls.nth(0).click();
      await terminalSelect.selectOption("1sw1");
      await controls.nth(1).click();
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
        document.querySelector(".n-widget-surface .n-surface-programming")?.getAttribute("data-qualification") === "validation-recovery");
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
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "unsupported");
      let copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /Generic USB Encoder/);
      assert.match(copy, /Unsupported panel protocol/);
      assert.match(copy, /Chart read-back unsupported/);
      assert.match(copy, /Teach and Route still work/);
      assert.equal(await page.locator(".n-widget-surface .n-surface-stage").count(), 3);

      answer = "mismatch";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "error");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /selected encoder changed before this inspection finished/i);
      assert.doesNotMatch(copy, /Wrong stale encoder/);

      answer = "unavailable";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "unavailable");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /USB inventory could not be read/);
      assert.match(copy, /not an empty or healthy panel result/);

      answer = "http-error";
      await card.locator('[data-nx="surface-hardware-refresh"]').click();
      await page.waitForFunction(() =>
        document.querySelector(".n-widget-surface .n-surface-hardware")?.getAttribute("data-state") === "error");
      copy = (await card.textContent()).replace(/\s+/g, " ");
      assert.match(copy, /HTTP 503/);
      assert.match(copy, /Nothing was changed/);
      assert.doesNotMatch(copy, /Chart read-back unsupported/);
      assert.equal(panelCalls, 4);
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
        6,
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
        if (!control || !port) return null;
        const controlRect = control.getBoundingClientRect();
        const portRect = port.getBoundingClientRect();
        if (portRect.width < 1 || portRect.height < 1) return null;
        const center = {
          x: portRect.left + portRect.width / 2,
          y: portRect.top + portRect.height / 2,
        };
        return {
          inside: center.x >= controlRect.left - 1 && center.x <= controlRect.right + 1 &&
            center.y >= controlRect.top - 1 && center.y <= controlRect.bottom + 1,
          rim: Math.min(
            Math.abs(center.x - controlRect.left),
            Math.abs(center.x - controlRect.right),
            Math.abs(center.y - controlRect.top),
            Math.abs(center.y - controlRect.bottom),
          ),
          ellipseRadius: Math.sqrt(
            ((center.x - (controlRect.left + controlRect.width / 2)) / (controlRect.width / 2)) ** 2 +
            ((center.y - (controlRect.top + controlRect.height / 2)) / (controlRect.height / 2)) ** 2,
          ),
          controlRect: {
            left: controlRect.left,
            top: controlRect.top,
            right: controlRect.right,
            bottom: controlRect.bottom,
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
        cordOrigin.inside,
        true,
        `the source port stays inside the selected component (${JSON.stringify(cordOrigin)})`,
      );
      assert.ok(
        cordOrigin.ellipseRadius >= 0.9 && cordOrigin.ellipseRadius <= 1.05,
        `the cord begins on the selected physical component rim (${cordOrigin.ellipseRadius})`,
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
      const before = await storedControl(controlId);
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
      const moved = await storedControl(controlId);
      assert.ok(moved.x > before.x && moved.y > before.y, "dragging persists both panel coordinates");
      assert.equal(moved.playerSlot, null, "movement never derives semantic ownership from a quadrant");
      assert.equal(await control.getAttribute("data-player-slot"), null);

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

  test("teaching observes a signal while routing performs the real backend bind", async () => {
    const page = await openCanvas();
    const bindBodies = [];
    await page.route("**/nocturne/api/bind", async (route) => {
      bindBodies.push(JSON.parse(route.request().postData() ?? "{}"));
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
    const expectedDevice = await page.evaluate(() => JSON.parse(
      document.getElementById("__ksx-payload")?.textContent ?? "{}",
    ).view?.cap_instance ?? "");
    assert.ok(expectedDevice, "the fixture serves the exact selected Windows device instance");
    let physicalKey = "J";
    let physicalDevice = expectedDevice;
    let physicalGeneration = 900;
    let physicalHitReady = false;
    let holdNextPoll = false;
    let pendingPollStarted;
    let releasePendingPoll;
    await page.route("**/api/learn/start", async (route) => {
      physicalGeneration += 1;
      physicalHitReady = false;
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
          key: physicalHitReady ? physicalKey : null,
          error: null,
        }),
      });
    });

    try {
      await page.click('[data-nx="surface-open"]');
      await page.click('.n-widget-surface [data-surface-template="blank"]');
      await page.click('.n-widget-surface [data-nx="surface-add"][data-control-kind="button30"]');
      await page.click('.n-widget-surface [data-nx="surface-teach"]');
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("listen"));
      await page.locator('.n-widget-kb .n-ipac-signal[data-key="J"]').evaluate(
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
        "J",
      );
      assert.equal(
        await page.locator('.n-widget-surface [data-surface-stage="teach"]').getAttribute("aria-pressed"),
        "true",
        "a successful capture keeps the author in Teach mode for batch wiring",
      );

      await page.click('.n-widget-surface [data-nx="surface-mirror"]');
      await page.click('.n-widget-surface [data-nx="surface-duplicate"]');
      let views = await controls();
      assert.equal(views.length, 3);
      assert.equal(views[0].physicalId, views[1].physicalId, "a mirror shares physical identity");
      assert.notEqual(views[1].physicalId, views[2].physicalId, "a duplicate is independently wired");
      assert.deepEqual(views.map((view) => view.keys), [["J"], ["J"], ["J"]]);

      physicalKey = "Z";
      physicalDevice = "HID\\VID_0000&PID_0000\\WRONG-KEYBOARD";
      await page.click('.n-widget-surface [data-nx="surface-teach"]');
      physicalHitReady = true;
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.deepEqual((await controls()).map((view) => view.keys), [["J"], ["J"], ["J"]]);
      assert.match(
        await page.textContent(".n-live-sr"),
        /Ignored Z: Windows reported .*WRONG-KEYBOARD, not the selected keyboard or encoder/,
        "a hit from another attached keyboard is rejected before it becomes routable",
      );

      physicalKey = "K";
      physicalDevice = expectedDevice;
      await page.click('.n-widget-surface [data-nx="surface-teach"]');
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
      physicalDevice = expectedDevice;
      await page.click('.n-widget-surface [data-nx="surface-teach"]');
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
      physicalDevice = expectedDevice;
      holdNextPoll = true;
      const pollStarted = new Promise((resolve) => {
        pendingPollStarted = resolve;
      });
      await page.click('.n-widget-surface [data-nx="surface-teach"]');
      await pollStarted;
      const beforeStaleRemoval = await controls();
      await page.click('.n-widget-surface [data-nx="surface-remove"]');
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

      await page.click('.n-widget-surface [data-nx="surface-route"]');
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
      await page.waitForFunction(() => document.querySelector(".n-learnbar")?.classList.contains("none"));
      assert.deepEqual(bindBodies, [{
        slot: 2,
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
