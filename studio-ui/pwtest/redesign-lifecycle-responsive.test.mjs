// The lifecycle rail's compact-width contract, in the real /redesign page.
// A running, edited draft exposes the rail's widest verb set: Save, Apply and
// Stop. That state must not push the document sideways between the desktop and
// phone tiers, and the environment warning must remain a visible, named beacon.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_LIFECYCLE_RESPONSIVE_PORT ?? 4545);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

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
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the responsive lifecycle fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, KSX_FIXTURE_SESSION: "running" },
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "responsive lifecycle fixture");
  }
});

async function openRunningDirtyBench() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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

  const card = page.locator('.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]');
  await card.waitFor({ state: "visible" });
  await card.locator(".rd-ctrlcard-name").click();
  const socd = page.locator('[data-rd-form="controller-socd"]');
  await socd.waitFor({ state: "visible" });
  const select = socd.locator('select[name="socd"]');
  const current = await select.inputValue();
  const next = await select.locator("option").evaluateAll(
    (options, value) => options.find((option) => option.value !== value)?.value ?? "",
    current,
  );
  assert.notEqual(next, "", "fixture controller must offer another SOCD policy");
  await select.selectOption(next);
  await socd.locator('button[type="submit"]').click();
  await page.waitForFunction(
    () => {
      const form = document.querySelector('[data-rd-form="apply"]');
      const button = form?.querySelector("button");
      return form && !form.classList.contains("none") && button && !button.disabled;
    },
    null,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => /edited|Unsaved/i.test(document.querySelector(".rd-draft-label")?.textContent ?? ""),
  );
  await page.locator('[data-nx="rd-insp-close"]').click();
  return page;
}

function assertBoxInsideViewport(box, viewport, label) {
  assert.ok(box, `${label} has no visible bounding box at ${viewport}px`);
  assert.ok(box.x >= -0.5, `${label} starts outside ${viewport}px: ${JSON.stringify(box)}`);
  assert.ok(
    box.x + box.width <= viewport + 0.5,
    `${label} ends outside ${viewport}px: ${JSON.stringify(box)}`,
  );
  assert.ok(box.y >= -0.5, `${label} starts above the viewport: ${JSON.stringify(box)}`);
  assert.ok(
    box.y + box.height <= 900.5,
    `${label} ends below the viewport: ${JSON.stringify(box)}`,
  );
}

async function assertLifecycleRail(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(
    (expected) => document.documentElement.clientWidth === expected,
    width,
  );

  const documentWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(
    documentWidth.scroll <= documentWidth.client,
    `${width}px lifecycle page scrolls horizontally: ${JSON.stringify(documentWidth)}`,
  );
  assert.equal(
    await page.locator(".rd-run-actions").getAttribute("aria-label"),
    "Lifecycle controls",
  );

  const environment = page.locator(".rd-top > .n-environment");
  const environmentLabel = (await environment.textContent())?.trim() ?? "";
  assert.match(environmentLabel, /fixture/i, `${width}px loses the environment identity`);
  assert.equal(
    await environment.getAttribute("title"),
    environmentLabel,
    `${width}px beacon must retain its full accessible tooltip`,
  );
  assert.equal(await environment.getAttribute("aria-hidden"), null);
  const environmentVisual = await environment.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      display: style.display,
      visibility: style.visibility,
    };
  });
  assert.notEqual(environmentVisual.display, "none");
  assert.equal(environmentVisual.visibility, "visible");
  assert.notEqual(
    environmentVisual.background,
    "rgba(0, 0, 0, 0)",
    `${width}px environment beacon has no visible fill`,
  );
  const environmentBox = await environment.boundingBox();
  assertBoxInsideViewport(environmentBox, width, "Environment beacon");
  if (width <= 1140) {
    assert.ok(
      environmentBox.width >= 10 && environmentBox.width <= 16 &&
        environmentBox.height >= 10 && environmentBox.height <= 16,
      `${width}px environment did not contract to a safety beacon: ${JSON.stringify(environmentBox)}`,
    );
  } else {
    assert.ok(
      environmentBox.width > 16,
      `${width}px environment should retain its full badge: ${JSON.stringify(environmentBox)}`,
    );
  }

  assert.equal(
    await page.locator(".rd-theme-rail-home .rd-themed").isVisible(),
    width > 680,
    `${width}px desktop Theme trigger should follow the labeled rail tier`,
  );

  for (const [kind, name] of [
    ["save", "Save"],
    ["apply", "Apply"],
    ["stop", "Stop"],
  ]) {
    const button = page.locator(`.rd-run-actions [data-rd-form="${kind}"] button`);
    assert.equal(await button.isVisible(), true, `${name} is hidden at ${width}px`);
    assert.match((await button.textContent())?.trim() ?? "", new RegExp(name, "i"));
    assertBoxInsideViewport(await button.boundingBox(), width, name);
  }
}

async function assertCompactThemeKeyboard(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const setup = page.locator(".rd-setupd");
  const setupSummary = setup.locator(":scope > .rd-setup-sum");
  if (await setup.getAttribute("open") !== null) {
    await setupSummary.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".rd-setupd")?.hasAttribute("open"));
  }

  // Reach both disclosures from the ordinary keyboard order: Setup first,
  // then the compact Theme summary as its first interactive child.
  await setupSummary.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".rd-setupd")?.hasAttribute("open"));
  await page.keyboard.press("Tab");

  const theme = page.locator(".rd-theme-compact-home .rd-themed-compact");
  const themeSummary = theme.locator(":scope > .rd-theme-compact-sum");
  assert.equal(await theme.isVisible(), true, `compact Theme is hidden at ${width}px`);
  assert.equal(await themeSummary.getAttribute("aria-label"), "Choose Studio theme");
  assert.equal(
    await themeSummary.evaluate((element) => document.activeElement === element),
    true,
    `Tab did not reach compact Theme at ${width}px`,
  );

  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".rd-theme-compact-home .rd-themed-compact")?.hasAttribute("open"));
  const choices = await theme.locator('[data-rd-form="theme"]').evaluateAll((forms) =>
    forms.map((form) => ({
      current: form.querySelector("button")?.getAttribute("aria-current") === "true",
      value: form.querySelector('input[name="theme"]')?.value ?? "",
    })),
  );
  const targetIndex = choices.findIndex((choice) => !choice.current && choice.value);
  assert.ok(targetIndex >= 0, "fixture must expose an alternate Studio theme");
  const targetTheme = choices[targetIndex].value;

  // Enter opened the native details with focus still on its summary. Tab to
  // the first row, then continue through the menu to the selected alternate.
  for (let index = 0; index <= targetIndex; index += 1) {
    await page.keyboard.press("Tab");
  }
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.closest('[data-rd-form="theme"]')
        ?.querySelector('input[name="theme"]')?.value ?? ""),
    targetTheme,
    `keyboard focus did not reach ${targetTheme} at ${width}px`,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction((themeName) =>
    themeName === "system"
      ? !document.documentElement.hasAttribute("data-theme")
      : document.documentElement.dataset.theme === themeName,
  targetTheme);
  await page.waitForFunction(() =>
    !document.querySelector(".rd-theme-compact-home .rd-themed-compact")?.hasAttribute("open"));

  const documentWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(
    documentWidth.scroll <= documentWidth.client,
    `${width}px compact Theme introduced horizontal overflow: ${JSON.stringify(documentWidth)}`,
  );
}

describe("the responsive redesign lifecycle rail", { concurrency: false }, () => {
  test("every rail tier retains the environment, Save, Apply and Stop without page overflow", async () => {
    const page = await openRunningDirtyBench();
    try {
      for (const width of [390, 481, 600, 680, 681, 900, 1140, 1141, 1279, 1280]) {
        await assertLifecycleRail(page, width);
      }
      assert.deepEqual(page.ksxNoise, [], "the responsive page must stay error-free");
    } finally {
      await page.close();
    }
  });

  test("compact Theme stays keyboard-reachable and applies at phone and tablet widths", async () => {
    const page = await openRunningDirtyBench();
    try {
      for (const width of [390, 600]) {
        await assertCompactThemeKeyboard(page, width);
      }
      assert.deepEqual(page.ksxNoise, [], "compact Theme must stay error-free");
    } finally {
      await page.close();
    }
  });
});
