// Focused browser contract for the redesign's truthful setup/recovery UX.
// It drives the real Forma island and Rust macro fixture: no mocked page DOM.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_TRUTH_RECOVERY_PORT ?? 4562);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

const IPAC = "usb:d209:0430:00";
const G915 = "usb:046d:c545:00";

let server;
let browser;

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/redesign`);
      if (response.ok) return;
    } catch {
      // The fixture is still linking or starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE}`);

  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the redesign truth/recovery fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT), "--generation=truth-recovery"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "redesign truth/recovery fixture");
  }
});

async function openBench() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/redesign?slot=1`, { waitUntil: "domcontentloaded" });
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

async function setSetupOpen(page, open) {
  const setup = page.locator(".rd-setupd");
  if ((await setup.evaluate((element) => element.open)) !== open) {
    await page.locator(".rd-setup-sum").click();
  }
}

async function makeDraftDirty(page) {
  await setSetupOpen(page, false);
  const card = page.locator('.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]');
  await card.locator(".rd-ctrlcard-name").click();
  const form = page.locator('[data-rd-form="controller-socd"]');
  await form.waitFor({ state: "visible" });
  const select = form.locator('select[name="socd"]');
  const current = await select.inputValue();
  const next = await select.locator("option").evaluateAll(
    (options, value) => options.find((option) => option.value !== value)?.value ?? "",
    current,
  );
  assert.notEqual(next, "", "the fixture must offer another SOCD policy");
  await select.selectOption(next);
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(
    () => /edited|Unsaved/i.test(document.querySelector(".rd-draft-label")?.textContent ?? ""),
  );
  const close = page.locator('.rd-inspector:not([hidden]) [data-nx="rd-insp-close"]');
  if (await close.count()) await close.click();
}

async function assertGlobalMutationLock(page) {
  const lock = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll(
      'form[data-rd-form] button[type="submit"], ' +
        'form[data-rd-form] input[type="submit"], select.rd-ctrlplayer, ' +
        '[data-nx="rd-refresh-retry"], [data-rd-live-retry]',
    ));
    return {
      count: controls.length,
      enabled: controls.filter((control) => !("disabled" in control) || !control.disabled)
        .map((control) => control.outerHTML.slice(0, 160)),
    };
  });
  assert.ok(lock.count >= 8, "the fixture must expose a meaningful island-wide mutation surface");
  assert.deepEqual(lock.enabled, [], "every mutation control is locked during one transaction");
}

async function delayedLifecycle(page, {
  path: requestPath,
  formKind,
  pendingText,
  settledFlash,
}) {
  const url = `${BASE}${requestPath}`;
  let releaseRoute;
  const gate = new Promise((resolve) => {
    releaseRoute = resolve;
  });
  let markSeen;
  const seen = new Promise((resolve) => {
    markSeen = resolve;
  });
  let requestCount = 0;
  const handler = async (route) => {
    requestCount += 1;
    markSeen();
    await gate;
    await route.continue();
  };
  await page.route(url, handler);

  const button = page.locator(
    `[data-rd-form="${formKind}"] button[type="submit"]:visible`,
  ).first();
  try {
    await button.click();
    await seen;
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.getAttribute("aria-busy") === "true",
    );
    assert.equal(await button.getAttribute("aria-busy"), "true");
    assert.equal(
      (await button.locator(".rd-action-pending:not([hidden])").textContent())?.trim(),
      pendingText,
      "the initiating action names the work that is pending",
    );
    assert.equal(await button.locator(".rd-action-label:not([hidden])").count(), 0);
    await assertGlobalMutationLock(page);
    assert.equal(requestCount, 1, "one click issues exactly one lifecycle request");
  } finally {
    releaseRoute();
  }
  await page.waitForFunction(
    () => !document.querySelector("[data-forma-island]")?.hasAttribute("aria-busy") &&
      document.querySelector("[data-forma-island]")?.dataset.rdMutationPending !== "true",
    null,
    { timeout: 20_000 },
  );
  await page.unroute(url, handler);
  await page.waitForFunction(
    (expected) => document.querySelector(".rd-flash")?.textContent?.includes(expected),
    settledFlash,
    { timeout: 20_000 },
  );
  assert.equal(requestCount, 1, "settling the transaction does not replay its POST");
  assert.equal(
    await page.locator('.rd-action-pending:not([hidden])').count(),
    0,
    "no stale pending label survives the authoritative repaint",
  );
}

describe("redesign truth, recovery and pending feedback", { concurrency: false }, () => {
  test("the workbench exposes exact recovery, actionable progress and honest device/action states", async () => {
    const page = await openBench();

    // Exact-device recovery is persistent even though the operational Setup
    // disclosure starts closed. The CTA opens the one source-of-truth card
    // and puts keyboard focus on it.
    assert.equal(await page.locator(".rd-setupd").evaluate((element) => element.open), false);
    const attention = page.locator("[data-rd-attention]");
    await attention.waitFor({ state: "visible" });
    assert.match(await attention.locator("h2").textContent(), /Ultimarc I-PAC 4 · Preparation required/);
    assert.match(await attention.textContent(), /Prepare this input before Save or Play/i);
    await attention.getByRole("button", { name: "Review preparation" }).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-setupd")?.hasAttribute("open") &&
        document.activeElement?.id === "rd-capture-readiness",
    );

    // Journey rows carry machine actions; they never infer destinations from
    // customer copy. Input routes to exact capture recovery and Controllers
    // routes to the persistent composition tray.
    assert.deepEqual(
      await page.locator("[data-journey-step]").evaluateAll((rows) =>
        Object.fromEntries(rows.map((row) => [row.dataset.journeyStep, row.dataset.journeyAction]))
      ),
      { input: "capture", controller: "controllers", mapping: "mapping", play: "play" },
    );
    await page.locator('[data-journey-step="input"]').click();
    await page.waitForFunction(() => document.activeElement?.id === "rd-capture-readiness");
    await page.locator('[data-journey-step="controller"]').click();
    await page.locator(".rd-ctrlmodal-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator(".rd-setupd").evaluate((element) => element.open), false);
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rd-ctrlmodal-panel")),
      true,
      "the Controllers journey step lands inside the tray",
    );
    await page.locator('.rd-ctrlmodal-head [data-nx="rd-ctrls-close"]').click();

    // The picker and device cards share one product vocabulary. Bench
    // membership is not called staging, and choosing the mapping input is the
    // explicit "Use as input source" verb.
    await page.locator('[data-nx="rd-devs-open"]').click();
    const ipacRow = page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`);
    const g915Row = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    assert.equal((await ipacRow.locator(".rd-dev-connectedchip").textContent())?.trim(), "Connected");
    assert.equal((await ipacRow.locator(".rd-dev-stagedchip").textContent())?.trim(), "Input source");
    assert.doesNotMatch((await ipacRow.textContent()) ?? "", /staged|mapping input/i);
    await ipacRow.click();
    await g915Row.click();
    assert.match((await ipacRow.locator(".rd-dev-word").textContent()) ?? "", /On canvas/);
    assert.match((await g915Row.locator(".rd-dev-word").textContent()) ?? "", /On canvas/);
    await page.locator('.rd-devmodal-head [data-nx="rd-devs-close"]').click();

    const inspectorClose = page.locator(
      '.rd-inspector:not([hidden]) [data-nx="rd-insp-close"]',
    );
    if (await inspectorClose.count()) await inspectorClose.click();

    const ipacCard = page.locator(`.rd-dev-node[data-selector="${IPAC}"]`);
    const g915Card = page.locator(`.rd-dev-node[data-selector="${G915}"]`);
    await ipacCard.waitFor({ state: "visible" });
    assert.deepEqual(
      await ipacCard.locator(".rd-device-state").allTextContents(),
      ["Connected", "On canvas", "Input source", "Preparation required"],
    );
    assert.deepEqual(
      await g915Card.locator(".rd-device-state").allTextContents(),
      ["Connected", "On canvas"],
    );
    assert.equal((await g915Card.locator(".rd-stagebtn").textContent())?.trim(), "Use as input source");
    assert.doesNotMatch((await ipacCard.locator(".rd-devcard").textContent()) ?? "", /staged|mapping input/i);
    assert.doesNotMatch((await g915Card.locator(".rd-devcard").textContent()) ?? "", /staged|mapping input/i);

    // Prepare is gated on purpose so the browser has time to prove the
    // initiating label, aria-busy state, and whole-island transaction lock.
    await attention.getByRole("button", { name: "Review preparation" }).click();
    const prepare = page.locator('[data-rd-form="capture-prepare"]');
    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await delayedLifecycle(page, {
      path: "/redesign/capture/prepare",
      formKind: "capture-prepare",
      pendingText: "Preparing…",
      settledFlash: "Keyboard prepared",
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rd-setup-sum")),
      true,
      "a settled Prepare returns focus to the stable Setup summary",
    );
    assert.equal(await page.locator("[data-rd-attention]:visible").count(), 0);

    // The same contract holds for the ordinary lifecycle rail. Save, Play and
    // Stop each name their pending state, issue one POST, restore the product
    // lock, and move focus to the next valid lifecycle action.
    await makeDraftDirty(page);
    await page.locator('[data-rd-form="save"] button:visible').waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-rd-form="save"] button:visible').isDisabled(), false);
    await delayedLifecycle(page, {
      path: "/redesign/save",
      formKind: "save",
      pendingText: "Saving…",
      settledFlash: "Setup saved",
    });
    assert.match(await page.locator(".rd-flash").textContent(), /Play was not started or changed/i);
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rd-setup-sum")),
      true,
    );

    await delayedLifecycle(page, {
      path: "/redesign/play",
      formKind: "play",
      pendingText: "Starting…",
      settledFlash: "Play is running",
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('[data-rd-form="stop"]') !== null),
      true,
      "Play completion moves focus to Stop",
    );

    await delayedLifecycle(page, {
      path: "/redesign/stop",
      formKind: "stop",
      pendingText: "Stopping…",
      settledFlash: "Play stopped",
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('[data-rd-form="play"]') !== null),
      true,
      "Stop completion moves focus back to Play",
    );

    assert.deepEqual(page.ksxNoise, [], "the complete truth/recovery loop stays error-free");
    await page.close();
  });
});
