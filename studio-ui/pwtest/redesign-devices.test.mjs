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
const G915 = "usb:046d:c545:00";
const IPAC_SLUG = deviceInstanceId(IPAC);
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
    await toggle.click();
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
      `${beforeCount + 1} widgets`,
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
      () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
        "ultimarc-ultimate-io",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 48);
    assert.equal(await encoderStatus.count(), 1, "the live status remains one stable node");
    await page.waitForFunction(
      () => document.querySelector("[data-rd-encoder-status]")?.textContent
        ?.includes("User-selected reference"),
    );
    assert.match(await node.textContent(), /96 LED output channels/i);
    assert.match(await node.textContent(), /six inputs may be reassigned to optical axes/i);

    await model.selectOption("catalog:brook-ufb-fusion");
    await page.waitForFunction(
      () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
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
      () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
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
      () => document.querySelector("[data-rd-encoder-evidence]")?.getAttribute(
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
      () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
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
      () => document.querySelector(".rd-encoder-profile")?.dataset.profileId === "unknown-hid",
    );
    assert.equal(await node.locator("[data-terminal-id]").count(), 0);
    assert.equal(
      await node.locator(".rd-encoder-profile-svg [data-observed-signal-id]").count(),
      6,
    );
    assert.equal(await node.locator("svg").getAttribute("data-capacity"), "unknown");
    assert.match(await node.textContent(), /terminal capacity unknown/i);
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
      () => document.querySelectorAll("[data-declared-terminal-id]").length === 6,
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
    const narrowToggle = await toggle.boundingBox();
    assert.ok(narrowToggle, "the encoder toggle stays rendered on a narrow canvas");
    assert.ok(
      narrowToggle.x >= 0 && narrowToggle.x + narrowToggle.width <= 420,
      "the compact toggle stays inside the viewport",
    );
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

    await toggle.click();
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

    await toggle.click();
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

  test("an open encoder lab reconciles connected truth by raw selector", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-encoder-profiles"]');
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
        () => document.querySelectorAll('[data-rd-encoder-model] option[value^="connected:"]')
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
        () => document.querySelector(".rd-encoder-profile")?.dataset.evidenceState ===
          "ambiguous-family",
      );
      await node.locator(
        '[data-profile-candidate="ultimarc-minipac-four"] input',
      ).click();
      await page.waitForFunction(
        () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
          "ultimarc-minipac-four",
      );

      rosterMode = "measured-minipac-32";
      await submitTheme("dark");
      await page.waitForFunction(
        () => document.querySelector(".rd-encoder-profile")?.dataset.profileId ===
          "ultimarc-minipac-32",
      );
      assert.equal(
        await node.locator(".rd-encoder-profile").getAttribute("data-evidence-state"),
        "backend-family",
        "changed backend evidence invalidates the old user-confirmed variant",
      );
      assert.equal(await node.locator("[data-terminal-id]").count(), 32);

      rosterMode = "known-family";
      await submitTheme("system");
      await page.waitForFunction(
        () => document.querySelector(".rd-encoder-profile")?.dataset.evidenceState ===
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
        (value) => document.querySelector("[data-rd-encoder-model]")?.value === value,
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
