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
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

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
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
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

async function openSurface(
  pathname,
  viewport = { width: 1280, height: 900 },
  pageOptions = {},
) {
  const page = await browser.newPage({ ...pageOptions, viewport });
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}${pathname}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
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

  test("the phone Inspector drawer owns its visible close button above the lifecycle rail", async () => {
    const page = await openRunningDirtyBench();
    try {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.waitForFunction(() => document.documentElement.clientWidth === 390);

      const card = page.locator('.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]');
      await card.locator(".rd-ctrlcard-name").click();
      const inspector = page.locator(".rd-inspector");
      const close = inspector.locator('[data-nx="rd-insp-close"]');
      await close.waitFor({ state: "visible" });
      // Playwright's visible state is true on animation frame zero even
      // though the drawer is still translated one viewport to the right.
      // Test the settled hit target: the contract here is stacking above the
      // rail, not whether the entrance animation has elapsed.
      await page.waitForFunction(
        () => document.querySelector(".rd-inspector")?.getAnimations().length === 0,
      );

      const hitTarget = await close.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit === button || button.contains(hit);
      });
      assert.equal(
        hitTarget,
        true,
        "the visible Inspector close target is covered by another responsive layer",
      );

      await close.click();
      await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === true);
      assert.equal(await inspector.isHidden(), true, "the phone Inspector did not close");
      assert.deepEqual(page.ksxNoise, [], "the phone Inspector must stay error-free");
    } finally {
      await page.close();
    }
  });

  test("Tools stays keyboard-reachable without crowding the phone lifecycle rail", async () => {
    for (const width of [390, 681, 1280]) {
      const page = await openSurface("/redesign?slot=1", { width, height: 900 });
      try {
        let tools;
        if (width <= 680) {
          const setup = page.locator(".rd-setupd");
          await setup.locator(":scope > .rd-setup-sum").focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => document.querySelector(".rd-setupd")?.hasAttribute("open"));
          tools = page.locator(".rd-utility-compact-home [data-rd-tools-menu]");
        } else {
          tools = page.locator(".rd-utility-rail-home [data-rd-tools-menu]");
        }

        const summary = tools.locator(":scope > .rd-utility-sum");
        assert.equal(await tools.isVisible(), true, `Tools is hidden at ${width}px`);
        assert.equal(await summary.getAttribute("aria-label"), "Open Studio tools");
        await summary.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          ({ compact }) => document.querySelector(
            compact
              ? ".rd-utility-compact-home [data-rd-tools-menu]"
              : ".rd-utility-rail-home [data-rd-tools-menu]",
          )?.hasAttribute("open"),
          { compact: width <= 680 },
        );

        assert.deepEqual(
          await tools.locator(".rd-utility-link").evaluateAll((links) =>
            links.map((link) => link.getAttribute("href"))),
          ["/check", "/pads", "/devices"],
          `${width}px Tools menu lost an operational route`,
        );
        await page.keyboard.press("Escape");
        assert.equal(await tools.getAttribute("open"), null, `Escape did not close Tools at ${width}px`);
        assert.equal(
          await summary.evaluate((element) => document.activeElement === element),
          true,
          `Escape did not restore Tools focus at ${width}px`,
        );
        assert.deepEqual(page.ksxNoise, [], `Tools produced browser errors at ${width}px`);
      } finally {
        await page.close();
      }
    }
  });

  test("Tools keeps one disclosure state while crossing the compact breakpoint", async () => {
    const page = await openSurface("/redesign?slot=1", { width: 681, height: 900 });
    try {
      const rail = page.locator(".rd-utility-rail-home [data-rd-tools-menu]");
      const railSummary = rail.locator(":scope > .rd-utility-sum");
      await railSummary.focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await rail.getAttribute("open"), null);

      await page.setViewportSize({ width: 680, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-tools-menu][open]").length === 0,
      );
      const setupSummary = page.locator(".rd-setupd > .rd-setup-sum");
      assert.equal(
        await setupSummary.evaluate((element) => document.activeElement === element),
        true,
        "the hidden desktop Tools summary retained focus after compacting",
      );

      await page.keyboard.press("Enter");
      const compact = page.locator(".rd-utility-compact-home [data-rd-tools-menu]");
      const compactSummary = compact.locator(":scope > .rd-utility-sum");
      await compactSummary.focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await compact.getAttribute("open"), null);
      assert.equal(
        await page.locator("[data-rd-tools-menu][open]").count(),
        1,
        "responsive Tools peers diverged",
      );

      await page.setViewportSize({ width: 681, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-tools-menu][open]").length === 0,
      );
      assert.equal(
        await railSummary.evaluate((element) => document.activeElement === element),
        true,
        "the hidden compact Tools summary retained focus after widening",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Tools keeps a touch-size target and forced-colors focus ring", async () => {
    const page = await openSurface(
      "/redesign?slot=1",
      { width: 390, height: 900 },
      { hasTouch: true },
    );
    try {
      await page.locator(".rd-setupd > .rd-setup-sum").click();
      const tools = page.locator(".rd-utility-compact-home [data-rd-tools-menu]");
      const summary = tools.locator(":scope > .rd-utility-sum");
      const box = await summary.boundingBox();
      assert.ok(box && box.height >= 44, `coarse-pointer Tools target is ${box?.height}px`);

      await page.emulateMedia({ forcedColors: "active" });
      await summary.focus();
      assert.equal(
        await summary.evaluate((element) => getComputedStyle(element).outlineStyle),
        "solid",
      );
      await page.keyboard.press("Enter");
      const firstLink = tools.locator(".rd-utility-link").first();
      await firstLink.focus();
      assert.equal(
        await firstLink.evaluate((element) => getComputedStyle(element).outlineStyle),
        "solid",
        "forced-colors removed the Tools link focus indicator",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Nocturne's native configuration menu exposes the same recovery routes", async () => {
    const page = await openSurface("/nocturne");
    try {
      const menu = page.locator(".n-chipd");
      await menu.locator(":scope > summary").click();
      assert.deepEqual(
        await menu.locator('a[href="/check"], a[href="/pads"], a[href="/devices"]').evaluateAll(
          (links) => links.map((link) => link.getAttribute("href")),
        ),
        ["/check", "/pads", "/devices"],
      );
      assert.deepEqual(page.ksxNoise, [], "Nocturne Tools links produced browser errors");
    } finally {
      await page.close();
    }
  });
});
