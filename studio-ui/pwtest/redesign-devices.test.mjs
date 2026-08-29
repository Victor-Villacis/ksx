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
import { stopFixtureProcess } from "./fixture-process.mjs";
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
      'export { getEncoderVisualProfile, validateEncoderVisualRegistry } from "../src/encoderVisualRegistry.ts";',
      'export { validateEncoderChart } from "../src/encoderChartRead.ts";',
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
  getEncoderVisualProfile,
  parseEncoderObservationView,
  validateEncoderChart,
  validateEncoderDetectionRules,
  validateEncoderVisualRegistry,
} = await import(
  `data:text/javascript;base64,${Buffer.from(encoderContractBundle.outputFiles[0].text).toString("base64")}`
);
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

// The fixture's roster, by RAW selector (macro_fixture.rs device_scan).
const IPAC = "usb:d209:0430:00";
const IPAC_TWIN = "usb:d209:0430:01";
const G915 = "usb:046d:c545:00";
const IPAC_SLUG = deviceInstanceId(IPAC);
const IPAC_TWIN_SLUG = deviceInstanceId(IPAC_TWIN);
const G915_SLUG = deviceInstanceId(G915);

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
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
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
    await context?.close();
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
async function openBench() {
  const page = await context.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
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

/** The catalog/evidence comparison surface remains as an internal regression
 * harness, but it is deliberately absent from the product chrome. */
async function toggleEncoderResearchHarness(page) {
  await page.locator('[data-nx="rd-encoder-profiles"]').evaluate((button) => button.click());
}

describe("the device workbench", () => {
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

  test("adding a detected encoder creates the product terminal workbench", async () => {
    const productContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
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
      held: state === "listening" ? ["ArrowDown"] : [],
      seen: state === "idle" ? [] : ["ArrowDown"],
      peak: state === "idle" ? 0 : 1,
      events: state === "idle" ? 0 : 2,
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
      assert.equal(await node.getAttribute("data-selector"), IPAC);
      assert.equal(await node.getAttribute("data-canvas-width"), "960");
      assert.ok(Number(await node.getAttribute("data-canvas-height")) >= 760);
      assert.equal(await node.locator("[data-rd-encoder-model]").count(), 0);
      assert.doesNotMatch(await node.textContent(), /profile or evidence case|research-backed preview/i);
      assert.match(await node.textContent(), /connected/i);
      assert.match(await node.textContent(), /recognized/i);
      assert.match(await node.textContent(), /56 inputs/i);
      assert.equal(await node.locator("[data-terminal-id]").count(), 56);
      assert.equal(
        await node.locator('[data-terminal-id][tabindex="0"]').count(),
        1,
        "the board exposes one roving keyboard entry point",
      );
      await node.focus();
      await page.locator('[data-nx="rd-center-sel"]').evaluate((button) => button.click());
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
      assert.equal(hardwareCalls.length, 0, "adding the device performs no implicit hardware action");

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

      const read = node.getByRole("button", { name: "Read keys" });
      await read.click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loaded"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(hardwareCalls.filter((call) => /\/api\/panel\/chart/.test(call.url)).length, 1);
      assert.equal(await node.locator("[data-terminal-id][data-configured-emission]").count(), 56);
      assert.doesNotMatch(
        await node.locator('[data-rd-encoder-terminal-inspector]').textContent(),
        /configured key\s*read keys/i,
      );

      const start = node.getByRole("button", { name: "Start button test" });
      await start.click();
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation][data-state="listening"]`,
        ),
        IPAC_SLUG,
      );
      const sink = node.locator("[data-rd-encoder-observation-sink]");
      await page.waitForFunction(
        (id) => document.activeElement === document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-observation-sink]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await start.isDisabled(), true, "the active test keeps Start disabled");
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

      const details = node.locator(".rd-encoder-product-details");
      assert.equal(await details.getAttribute("open"), null, "technical facts are closed by default");
      await details.locator(":scope > summary").click();
      assert.match(await details.textContent(), /technical evidence/i);
      assert.match(await details.textContent(), new RegExp(IPAC, "i"));
      assert.deepEqual(noise, [], "the product encoder stays error-free");
    } finally {
      await productContext.close();
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
    await page.route(`${BASE}/api/redesign`, async (route) => {
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
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="light"]) button');
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
      assert.equal(await node.locator("[data-terminal-id]").count(), 0);
      assert.match(await node.textContent(), /generic setup/i);
      assert.match(await node.textContent(), /capacity unknown/i);
      assert.equal(await node.getByRole("button", { name: "Read keys" }).count(), 0);
      assert.equal(await node.getByRole("button", { name: "Start button test" }).count(), 1);
      const labels = node.locator("[data-rd-encoder-manual-labels]");
      await labels.fill("P1 UP, P1 FIRE, COIN");
      await node.getByRole("button", { name: "Build control list" }).click();
      assert.equal(await node.locator("[data-declared-terminal-id]").count(), 3);
      assert.equal(
        await node.locator("[data-terminal-id]").count(),
        0,
        "declared controls never masquerade as discovered hardware terminals",
      );
      assert.deepEqual(noise, []);
    } finally {
      await page.unroute(`${BASE}/api/redesign`);
      await genericContext.close();
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
    let releaseChart;
    let reportChart;
    const chartGate = new Promise((resolve) => { releaseChart = resolve; });
    const chartSeen = new Promise((resolve) => { reportChart = resolve; });
    let chartReported = false;
    await page.route("**/api/panel/chart", async (route) => {
      if (!chartReported) {
        chartReported = true;
        reportChart(route.request().postDataJSON());
      }
      await chartGate;
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
      await node.getByRole("button", { name: "Read keys" }).click();
      assert.deepEqual(await chartSeen, { selector: IPAC });
      assert.equal(
        await node.locator('[data-rd-encoder-chart][data-state="loading"]').count(),
        1,
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
      const staleChartResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/panel/chart"
      );
      releaseChart();
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
        "the late pre-pagehide chart cannot restore stale Reading or loaded results",
      );
      assert.equal(await node.locator("[data-configured-emission]").count(), 0);

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
      releaseChart?.();
      await lifecycleContext.close();
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
    await page.route(`${BASE}/api/redesign`, async (route) => {
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
      await node.getByRole("button", { name: "Read keys" }).click();
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
      await page.unroute(`${BASE}/api/redesign`);
      await authorityContext.close();
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
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") noise.push(`console: ${message.text()}`);
    });
    await page.route(`${BASE}/api/redesign`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const original = payload.devices.encoders.find((row) => row.selector === IPAC);
      assert.ok(original, "the fixture must serve the primary I-PAC");
      if (!payload.devices.encoders.some((row) => row.selector === IPAC_TWIN)) {
        payload.devices.encoders.push({
          ...original,
          selector: IPAC_TWIN,
          name: "Ultimarc I-PAC 4X · second cabinet",
          alias: "Second cabinet",
          label: "Second cabinet I-PAC 4X",
          aria_current: "false",
        });
      }
      await route.fulfill({ response, json: payload });
    });
    let releaseChart;
    let reportChart;
    const chartGate = new Promise((resolve) => { releaseChart = resolve; });
    const chartSeen = new Promise((resolve) => { reportChart = resolve; });
    let laterChartGate = null;
    let reportLaterChart = null;
    await page.route("**/api/panel/chart", async (route) => {
      const body = route.request().postDataJSON();
      chartBodies.push(body);
      if (chartBodies.length === 1) {
        reportChart(body);
        await chartGate;
      } else if (laterChartGate) {
        const gate = laterChartGate;
        const report = reportLaterChart;
        laterChartGate = null;
        reportLaterChart = null;
        report?.(body);
        await gate;
      }
      await route.continue();
    });
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
      await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
      await page.click(`.rd-devmodal button[data-selector="${IPAC_TWIN}"]`);
      await page.keyboard.press("Escape");
      const primary = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_SLUG}"]`);
      const twin = page.locator(`.rd-encoder-device-node[data-instance-id="${IPAC_TWIN_SLUG}"]`);
      assert.equal(await primary.count(), 1);
      assert.equal(await twin.count(), 1);

      await primary.getByRole("button", { name: "Read keys" }).click();
      assert.deepEqual(await chartSeen, { selector: IPAC });
      await page.waitForFunction(
        (id) => document.querySelector(
          `[data-instance-id="${id}"] [data-rd-encoder-chart][data-state="loading"]`,
        ),
        IPAC_SLUG,
      );
      assert.equal(await twin.locator("[data-rd-encoder-read]").isDisabled(), true);
      assert.equal(await twin.locator('[data-rd-encoder-observe="start"]').isDisabled(), true);
      assert.match(
        await twin.locator(".rd-encoder-product-actions").textContent(),
        /another encoder is reading its stored keys/i,
      );
      await twin.locator("[data-rd-encoder-read]").evaluate((button) => button.click());
      await page.waitForTimeout(25);
      assert.deepEqual(chartBodies, [{ selector: IPAC }], "the disabled twin cannot race the read");

      const chartResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/panel/chart"
      );
      releaseChart();
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
      assert.deepEqual(chartBodies, [{ selector: IPAC }], "an active twin test blocks a second read");
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

      let releaseLaterChart;
      let reportLaterChartSeen;
      const laterChartSeen = new Promise((resolve) => { reportLaterChartSeen = resolve; });
      laterChartGate = new Promise((resolve) => { releaseLaterChart = resolve; });
      reportLaterChart = reportLaterChartSeen;
      await primary.locator("[data-rd-encoder-read]").evaluate((button) => button.click());
      assert.deepEqual(await laterChartSeen, { selector: IPAC });
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
      releaseLaterChart();
      await laterChartResponse;
      await waitForBothSurfacesReady();
      assert.equal(
        await primary.locator('[data-rd-encoder-chart][data-state="idle"]').count(),
        1,
        "the pre-pagehide chart remains stale after its coordinator hold settles",
      );
      assert.deepEqual(noise, []);
    } finally {
      releaseChart?.();
      await page.unroute(`${BASE}/api/redesign`);
      await leaseContext.close();
    }
  });

  test("the picker serves every tier; picking two boards benches two widgets", async () => {
    const page = await openBench();
    const opener = page.locator('[data-nx="rd-devs-open"]');
    await opener.click();
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the modal opens",
    );
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-devmodal button[data-nx="rd-devs-close"]')
      ),
      true,
      "the picker lands on its first reliable control",
    );
    // The modal owns keyboard focus in both directions.
    const modalControls = page.locator(".rd-devmodal-panel button:not([disabled])");
    await modalControls.last().focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-devmodal button[data-nx="rd-devs-close"]')
      ),
      true,
      "Tab wraps from the last control to the first",
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement === document.querySelectorAll(
        ".rd-devmodal-panel button:not([disabled])",
      ).item(document.querySelectorAll(".rd-devmodal-panel button:not([disabled])").length - 1)),
      true,
      "Shift+Tab wraps from the first control to the last",
    );
    // Ctrl+K transfers ownership instead of stacking two modal surfaces. Its
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
      (await page.locator(".rd-devmodal .n-devnote").textContent()) ?? "",
      /keyboard-capable/,
      "the scan line speaks",
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
    // Pick BOTH the keyboard and the encoder. The modal stays open — the
    // multi-add is the point.
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the modal stays open for more picks",
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
      /On the workbench/,
      "the row says where the board went",
    );
    // Escape is the picker's rung on the ladder.
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      1,
      "Escape closes the picker first",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-devs-open"]')),
      true,
      "closing the picker restores its opener",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the workbench survives a reload — the arrangement store remembers", async () => {
    const page = await openBench();
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
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("selected picker removal clears the Inspector and survives a reload", async () => {
    const page = await openBench();
    await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).click();
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
    await page.close();

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
    await again.close();
  });

  test("staging from the bench card runs the daemon verb; the marking follows the truth", async () => {
    const page = await openBench();
    await page.evaluate(() => {
      window.__ksxStay = 42;
    });
    // The seeded fixture stages its I-PAC from the START — the served
    // daemon fact must arrive on the benched card without any press, chip
    // on, verb withdrawn. (The stage-scoped selector matters: the minimap
    // marker wears the same data-instance-id.)
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "true",
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"] .rd-stageform`)
        .evaluate((form) => getComputedStyle(form).display),
      "none",
      "a staged card offers the chip, not the verb",
    );
    // Bench the keyboard again and promote IT: the verb runs through the
    // preparation-preserving guard, the flash speaks, and the marking MOVES
    // — off the encoder, onto the keyboard, on cards and rows alike.
    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .canvasX !== undefined,
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`)
        .getAttribute("data-staged"),
      "false",
      "an unstaged board's card offers the verb",
    );
    await page.click(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"] .rd-stagebtn`);
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "true",
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(await page.evaluate(() => window.__ksxStay), 42, "staging does not reload");
    await page.waitForFunction(
      (id) =>
        document.activeElement ===
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`)
        .evaluate((item) => item === document.activeElement),
      true,
      "focus moves from the hidden verb to its durable canvas card",
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".rd-flash")?.textContent ===
          "Keyboard selected. Nothing has been saved or started.",
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "false",
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${G915}"][aria-current="true"]`)
        .count(),
      1,
      "the picker row carries the staged fact",
    );
    assert.equal(
      await page.locator('.rd-devmodal button[aria-current="true"]').count(),
      1,
      "exactly one row is the staged one",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("Theme and Stage share one lock, including cards added while a request is pending", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    const g915PickerRow = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    if ((await g915PickerRow.getAttribute("aria-pressed")) === "true") {
      await g915PickerRow.click();
    }
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).count(),
      0,
      "the regression starts with one card available to add during the request",
    );
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`${BASE}/redesign/device`, async (route) => {
      await requestGate;
      await route.continue();
    });
    try {
      const requestStarted = page.waitForRequest(`${BASE}/redesign/device`);
      await page.click(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"] .rd-stagebtn`);
      await requestStarted;
      assert.equal(
        await page.locator('.rd-stageform button[type="submit"]:not(:disabled)').count(),
        0,
        "one Stage request locks every bench-card mutation",
      );
      assert.equal(
        await page.locator('.rd-thememenu button[type="submit"]:not(:disabled)').count(),
        0,
        "Theme cannot race a Stage request's full-payload repaint",
      );

      await page.click('[data-nx="rd-devs-open"]');
      await g915PickerRow.click();
      const newStageButton = page.locator(
        `.forma-canvas-stage [data-instance-id="${G915_SLUG}"] .rd-stagebtn`,
      );
      assert.equal(
        await newStageButton.isDisabled(),
        true,
        "a card mounted during the request immediately inherits the shared lock",
      );
      releaseRequest();
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .staged === "true",
        IPAC_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0, "the modal stays open");
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
        await newStageButton.isDisabled(),
        false,
        "the shared lock also releases a card mounted after the request began",
      );
    } finally {
      releaseRequest();
      await page.unroute(`${BASE}/redesign/device`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("a Stage refresh that loses its board returns focus to the workbench picker", async () => {
    const page = await openBench();
    const card = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    assert.equal(await card.getAttribute("data-staged"), "false");
    await page.route(`${BASE}/api/redesign`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const tier of ["keyboards", "encoders", "experimental"]) {
        payload.devices[tier] = payload.devices[tier].filter((row) => row.selector !== G915);
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await card.locator(".rd-devcard-name").click();
      await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
      await card.locator(".rd-stagebtn").click();
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
        G915_SLUG,
        { timeout: 10_000 },
      );
      const picker = page.locator('[data-nx="rd-devs-open"]');
      assert.equal(
        await picker.evaluate((button) => button === document.activeElement),
        true,
        "focus lands on a durable control when the initiating card disappears",
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

      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      const centerError = await page.evaluate((id) => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const item = document
          .querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)
          ?.getBoundingClientRect();
        if (!viewport || !item) return Number.POSITIVE_INFINITY;
        return Math.abs(
          item.left + item.width / 2 - (viewport.left + viewport.width / 2),
        );
      }, IPAC_SLUG);
      assert.ok(
        centerError <= 2,
        `Fit still used a stale Inspector inset (${centerError}px from the full canvas centre)`,
      );
    } finally {
      await page.unroute(`${BASE}/api/redesign`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("provider unknown is preserved, authoritative absence unmounts, and return restores geometry", async () => {
    const page = await openBench();
    const item = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    const before = await item.evaluate((node) => ({
      x: Number(node.dataset.canvasX),
      y: Number(node.dataset.canvasY),
      width: Number(node.dataset.canvasWidth),
      height: Number(node.dataset.canvasHeight),
    }));
    let rosterMode = "staging-unreachable";
    await page.route(`${BASE}/api/redesign`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (rosterMode === "staging-unreachable") {
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
        await item.locator(".rd-stagebtn").isDisabled(),
        true,
        "an unreachable staging provider keeps Stage visible but safely disabled",
      );
      assert.equal(
        await item.locator(".rd-stagebtn").isVisible(),
        true,
        "the disabled action remains discoverable beside its reason",
      );
      assert.match(
        await item.locator(".rd-devcard-staged").textContent(),
        /Staging unavailable/,
      );

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
      assert.match(await item.locator(".rd-devcard-meta").textContent(), /Status unavailable/);

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
        before,
        "the returning board reclaims the exact saved geometry",
      );
    } finally {
      await page.unroute(`${BASE}/api/redesign`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
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
    await page.close();
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
    await page.close();
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
      if (!page.isClosed()) await page.close();
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
      assert.match(await node.textContent(), /exact Stop action remains available/i);
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
      if (!page.isClosed()) await page.close();
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
      if (!page.isClosed()) await page.close();
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
      if (!page.isClosed()) await page.close();
    }
  });

  test("an unknown connected encoder shows a bounded 12-signal preview and releases on disappearance", async () => {
    const page = await openBench();
    const emissions = Array.from({ length: 12 }, (_, index) => `Signal-${index + 1}`);
    const inputCalls = [];
    let active = false;
    let rosterMode = "unknown";
    await page.route(`${BASE}/api/redesign`, async (route) => {
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
      if (!page.isClosed()) await page.close();
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
      await accessibleContext.close();
    }
  });

  test("an open encoder lab reconciles connected truth by raw selector", async () => {
    const page = await openBench();
    await toggleEncoderResearchHarness(page);
    const node = page.locator(".rd-encoder-profile-node");
    const model = node.locator("[data-rd-encoder-model]");
    const twinSelector = `${IPAC}:mi_01`;
    let rosterMode = "twins";
    await page.route(`${BASE}/api/redesign`, async (route) => {
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
      await page.unroute(`${BASE}/api/redesign`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("removing a non-primary board repaints the surviving multi-selection", async () => {
    const page = await openBench();
    const g915 = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    const ipac = page.locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"]`);
    const ipacName = await ipac.getAttribute("data-widget-name");
    await g915.click();
    await ipac.click({ modifiers: ["Shift"] });
    await page.waitForFunction(
      () => document.querySelector(".rd-insp-name")?.textContent === "2 widgets selected",
    );

    await page.click('[data-nx="rd-devs-open"]');
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
      await page.locator(".rd-insp-name").textContent(),
      ipacName,
      "the Inspector repaints from multi-select to the surviving board",
    );

    // Keep the suite's shared arrangement intact for any later regression.
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.keyboard.press("Escape");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
