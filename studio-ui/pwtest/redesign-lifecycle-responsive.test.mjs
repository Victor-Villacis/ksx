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
import { REDESIGN_RAIL_PREFERENCES_MEDIA } from "../src/redesign-tools-menu.ts";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_LIFECYCLE_RESPONSIVE_PORT ?? 4545);
const BASE = `http://127.0.0.1:${PORT}`;
const COMPACT_PRIMARY_MAX = 1140;
const RAIL_PREFERENCES_MIN = 1440;
const BACK_VIEW_MIN = 1600;
const FULL_CANVAS_CHROME_MIN = 1920;
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

async function lockAdverseRailState(page) {
  await page.evaluate(() => {
    const forceAdverseState = () => {
      const root = document.querySelector(".rd");
      const status = root?.querySelector("[data-rd-live-status]");
      const short = status?.querySelector(".rd-live-short");
      const detail = status?.querySelector(".rd-live-detail");
      const stats = root?.querySelector("[data-rd-live-stats]");
      const environment = root?.querySelector(".rd-top > .n-environment");
      const backs = Array.from(root?.querySelectorAll('[data-nx="rd-back"]') ?? []);
      if (!root || !status || !short || !detail || !stats || !environment || backs.length === 0) return;
      if (root.dataset.rdLiveState !== "offline") root.dataset.rdLiveState = "offline";
      if (status.hidden) status.hidden = false;
      if (short.textContent !== "Offline") short.textContent = "Offline";
      const message = "Live input is offline. Reopen ksx and try again.";
      if (detail.textContent !== message) detail.textContent = message;
      if (stats.textContent !== "") stats.textContent = "";
      const environmentLabel = "LIVE MACHINE · REAL HARDWARE";
      if (environment.textContent !== environmentLabel) environment.textContent = environmentLabel;
      if (environment.getAttribute("title") !== environmentLabel) {
        environment.setAttribute("title", environmentLabel);
      }
      for (const back of backs) {
        if (back.hidden) back.hidden = false;
        if (back.getAttribute("title") !== "Back view — Device overview") {
          back.setAttribute("title", "Back view — Device overview");
        }
      }
    };
    forceAdverseState();
    window.ksxAdverseRailObserver?.disconnect();
    window.ksxAdverseRailObserver = new MutationObserver(forceAdverseState);
    window.ksxAdverseRailObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.waitForFunction(
    () => document.querySelector(".rd")?.dataset.rdLiveState === "offline" &&
      document.querySelector(".rd-live-retry")?.getClientRects().length > 0,
  );
}

async function assertTopRailGeometry(page, width) {
  const rail = await page.locator(".rd-top").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  assert.ok(
    rail.scroll <= rail.client,
    `${width}px top rail overflows its clipped frame: ${JSON.stringify(rail)}`,
  );

  const controls = await page
    .locator(".rd-top button, .rd-top summary")
    .evaluateAll((elements) => elements.filter((element) => element.checkVisibility()).map((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        label: element.getAttribute("aria-label")
          ?? element.getAttribute("title")
          ?? element.textContent?.trim()
          ?? element.tagName,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        hit: hit === element || element.contains(hit),
      };
    }));

  for (const control of controls) {
    assert.ok(control.left >= -0.5, `${control.label} starts outside ${width}px`);
    assert.ok(control.right <= width + 0.5, `${control.label} ends outside ${width}px`);
    assert.equal(control.hit, true, `${control.label} loses its center hit target at ${width}px`);
  }
  const ordered = [...controls].sort((left, right) => left.left - right.left);
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex];
      const sharesRow = left.top < right.bottom - 0.5 && right.top < left.bottom - 0.5;
      if (!sharesRow) continue;
      assert.ok(
        right.left >= left.right - 0.5,
        `${left.label} overlaps ${right.label} at ${width}px: ${JSON.stringify({ left, right })}`,
      );
    }
  }
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
    rail: (() => {
      const top = document.querySelector(".rd-top");
      return top ? { client: top.clientWidth, scroll: top.scrollWidth } : null;
    })(),
    controls: Array.from(document.querySelectorAll(".rd-top button, .rd-top summary"))
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.getAttribute("aria-label") ?? element.textContent?.trim(),
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        };
      }),
  }));
  assert.ok(
    documentWidth.scroll <= documentWidth.client,
    `${width}px lifecycle page scrolls horizontally: ${JSON.stringify(documentWidth)}`,
  );
  assert.equal(
    await page.locator(".rd-run-actions").getAttribute("aria-label"),
    "Lifecycle controls",
  );
  assert.equal(
    await page.locator(".rd").getAttribute("data-rd-live-state"),
    "offline",
    `${width}px rail fixture lost its widest real live state`,
  );
  assert.equal(
    await page.locator(".rd-live-retry").isVisible(),
    true,
    `${width}px offline rail lost Retry`,
  );

  const environment = page.locator(".rd-top > .n-environment");
  const environmentLabel = (await environment.textContent())?.trim() ?? "";
  assert.equal(
    environmentLabel,
    "LIVE MACHINE · REAL HARDWARE",
    `${width}px loses the longest supported environment identity`,
  );
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
  if (width <= COMPACT_PRIMARY_MAX) {
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

  const liveShort = page.locator(".rd-live-short");
  if (width <= COMPACT_PRIMARY_MAX) {
    const liveBox = await liveShort.boundingBox();
    assert.ok(liveBox && liveBox.width > 0 && liveBox.height > 0, `${width}px live state is dot-only`);
    const liveVisual = await liveShort.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, fontSize: Number.parseFloat(style.fontSize), text: element.textContent };
    });
    assert.ok(liveVisual.text?.trim(), `${width}px live state has no short name`);
    assert.ok(liveVisual.fontSize > 0, `${width}px live state text has zero font size`);
    assert.notEqual(liveVisual.color, "rgba(0, 0, 0, 0)", `${width}px live state text is transparent`);
  } else {
    assert.equal(await liveShort.isVisible(), false, `${width}px duplicated the compact live label`);
    const liveBox = await page.locator(".rd-live-state").boundingBox();
    assert.ok(
      liveBox && liveBox.width >= 64,
      `${width}px live witness lost its readable name: ${JSON.stringify(liveBox)}`,
    );
  }

  const brand = page.locator(".rd-brand");
  if (await brand.isVisible()) {
    const brandLines = await brand.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        whiteSpace: style.whiteSpace,
      };
    });
    assert.equal(brandLines.whiteSpace, "nowrap", `${width}px brand may wrap`);
    assert.ok(
      brandLines.height <= brandLines.lineHeight + 0.5,
      `${width}px brand wrapped onto another line: ${JSON.stringify(brandLines)}`,
    );
  }
  if (width <= 440) {
    const setupVisual = await page.locator(".rd-setup-sum").evaluate((element) => {
      const after = getComputedStyle(element, "::after");
      return {
        childOpacity: Array.from(element.children).map((child) => getComputedStyle(child).opacity),
        content: after.content,
        color: after.color,
        text: element.textContent?.trim() ?? "",
        title: element.getAttribute("title") ?? "",
      };
    });
    assert.ok(
      setupVisual.childOpacity.every((opacity) => opacity === "0"),
      `${width}px icon Setup leaked clipped progress text: ${JSON.stringify(setupVisual)}`,
    );
    assert.match(setupVisual.content, /◆/, `${width}px icon Setup lost its visible mark`);
    assert.notEqual(setupVisual.color, "rgba(0, 0, 0, 0)");
    assert.match(setupVisual.text, /complete/i, `${width}px icon Setup lost its accessible progress`);
    assert.match(setupVisual.title, /setup progress/i, `${width}px icon Setup lost its tooltip`);
  } else if (width <= COMPACT_PRIMARY_MAX) {
    const setupChildren = await page.locator(".rd-setup-sum").evaluate((element) =>
      Array.from(element.children)
        .filter((child) => child.checkVisibility())
        .map((child) => ({ text: child.textContent?.trim() ?? "", opacity: getComputedStyle(child).opacity })),
    );
    assert.ok(setupChildren.length > 0, `${width}px Setup lost its visible progress text`);
    assert.ok(
      setupChildren.every((child) => child.opacity === "1"),
      `${width}px Setup progress became transparent: ${JSON.stringify(setupChildren)}`,
    );
  }

  assert.equal(
    await page.locator(".rd-theme-rail-home .rd-themed").isVisible(),
    width >= RAIL_PREFERENCES_MIN,
    `${width}px desktop Theme trigger should follow the labeled rail tier`,
  );
  assert.equal(
    await page.locator(".rd-utility-rail-home [data-rd-tools-menu]").isVisible(),
    width >= RAIL_PREFERENCES_MIN,
    `${width}px desktop Tools trigger should follow the labeled rail tier`,
  );
  for (const [selector, label] of [
    ['[data-nx="rd-search"]', "Search"],
    ['[data-nx="rd-keys"]', "Shortcut sheet"],
  ]) {
    assert.equal(
      await page.locator(`.rd-top > ${selector}`).isVisible(),
      width >= FULL_CANVAS_CHROME_MIN,
      `${label} is in the wrong rail tier at ${width}px`,
    );
  }
  assert.equal(
    await page.locator('.rd-top > [data-nx="rd-back"]').isVisible(),
    width >= BACK_VIEW_MIN,
    `Back view is in the wrong rail tier at ${width}px`,
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

  await assertTopRailGeometry(page, width);
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
      await lockAdverseRailState(page);
      for (const width of [
        390, 440, 441, 481, 520, 521, 600, 680, 681, 900,
        1140, 1141, 1279, 1280,
        1439, 1440, 1599, 1600,
        1919, 1920,
      ]) {
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
      for (const width of [390, 600, 1141, 1439]) {
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
    for (const width of [390, 681, 1280, 1440]) {
      const page = await openSurface("/redesign?slot=1", { width, height: 900 });
      try {
        let tools;
        if (width < RAIL_PREFERENCES_MIN) {
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
          { compact: width < RAIL_PREFERENCES_MIN },
        );

        assert.deepEqual(
          await tools.locator(".rd-utility-link[href]").evaluateAll((links) =>
            links.map((link) => link.getAttribute("href"))),
          ["/check", "/pads", "/devices"],
          `${width}px Tools menu lost an operational route`,
        );
        assert.deepEqual(
          await tools.locator(".rd-utility-action").evaluateAll((buttons) =>
            buttons.map((button) => button.getAttribute("data-nx"))),
          ["rd-back", "rd-search", "rd-keys"],
          `${width}px Tools menu lost a discoverable canvas command`,
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

  test("Tools keeps deferred canvas commands discoverable at common desktop widths", async () => {
    assert.equal(
      REDESIGN_RAIL_PREFERENCES_MEDIA,
      "(width < 1440px)",
      "the JS disclosure boundary must be the exact fractional-safe CSS range",
    );

    for (const width of [1366, 1440, 1600, 1919]) {
      const page = await openSurface("/redesign?slot=1", { width, height: 900 });
      try {
        const openTools = async () => {
          let tools;
          if (width < RAIL_PREFERENCES_MIN) {
            const setup = page.locator(".rd-setupd");
            if (await setup.getAttribute("open") === null) {
              await setup.locator(":scope > .rd-setup-sum").click();
            }
            tools = page.locator(".rd-utility-compact-home [data-rd-tools-menu]");
          } else {
            tools = page.locator(".rd-utility-rail-home [data-rd-tools-menu]");
          }
          const summary = tools.locator(":scope > .rd-utility-sum");
          if (await tools.getAttribute("open") === null) await summary.click();
          await page.waitForFunction(
            ({ compact }) => document.querySelector(
              compact
                ? ".rd-utility-compact-home [data-rd-tools-menu]"
                : ".rd-utility-rail-home [data-rd-tools-menu]",
            )?.hasAttribute("open"),
            { compact: width < RAIL_PREFERENCES_MIN },
          );
          return tools;
        };

        let tools = await openTools();
        await tools.locator('[data-nx="rd-search"]').click();
        assert.equal(await tools.getAttribute("open"), null, `${width}px Search left Tools open`);
        assert.equal(await page.locator(".rd-palette").getAttribute("hidden"), null);
        assert.equal(
          await page.locator(".rd-palette-input").evaluate((input) =>
            document.activeElement === input),
          true,
          `${width}px Tools Search did not focus the command field`,
        );
        await page.keyboard.press("Escape");

        tools = await openTools();
        await tools.locator('[data-nx="rd-keys"]').click();
        assert.equal(await tools.getAttribute("open"), null, `${width}px Shortcuts left Tools open`);
        assert.equal(await page.locator(".rd-sheet").getAttribute("hidden"), null);
        await page.keyboard.press("Escape");

        // A zoom-menu pick creates one real camera-history entry. Every Back
        // copy must reveal, and the Tools copy must consume that same entry.
        await page.locator('[data-nx="rd-zoom-menu"]').click();
        await page.locator('[data-nx="rd-z-25"]').click();
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('[data-nx="rd-back"]'))
            .every((button) => !button.hidden));
        tools = await openTools();
        const back = tools.locator('[data-nx="rd-back"]');
        assert.equal(await back.isVisible(), true, `${width}px Tools Back stayed hidden`);
        await back.click();
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('[data-nx="rd-back"]'))
            .every((button) => button.hidden));
        assert.equal(await tools.getAttribute("open"), null, `${width}px Back left Tools open`);
        assert.deepEqual(page.ksxNoise, [], `canvas Tools failed at ${width}px`);
      } finally {
        await page.close();
      }
    }
  });

  test("no-script Tools exposes real routes without inert canvas commands", async () => {
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: false,
    });
    try {
      await page.goto(`${BASE}/redesign?slot=1`, { waitUntil: "domcontentloaded" });
      await page.locator(".rd-setupd > .rd-setup-sum").click();
      const tools = page.locator(".rd-utility-compact-home [data-rd-tools-menu]");
      await tools.locator(":scope > .rd-utility-sum").click();
      assert.equal(await tools.locator(".rd-utility-action").count(), 3);
      assert.equal(await tools.locator(".rd-utility-action:visible").count(), 0);
      assert.deepEqual(
        await tools.locator(".rd-utility-link[href]:visible").evaluateAll((links) =>
          links.map((link) => link.getAttribute("href"))),
        ["/check", "/pads", "/devices"],
      );
    } finally {
      await page.close();
    }
  });

  test("Tools keeps one disclosure state while crossing the compact breakpoint", async () => {
    const page = await openSurface(
      "/redesign?slot=1",
      { width: RAIL_PREFERENCES_MIN, height: 900 },
    );
    try {
      const rail = page.locator(".rd-utility-rail-home [data-rd-tools-menu]");
      const railSummary = rail.locator(":scope > .rd-utility-sum");
      await railSummary.focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await rail.getAttribute("open"), null);

      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
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

      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-tools-menu][open]").length === 0,
      );
      assert.equal(
        await railSummary.evaluate((element) => document.activeElement === element),
        true,
        "the hidden compact Tools summary retained focus after widening",
      );

      // Closed summaries are focus owners too. Chromium moves focus to body
      // before the media-query callback, so both directions need an explicit
      // handoff even when no disclosure content was open.
      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
      await page.waitForFunction(
        () => document.activeElement?.matches(".rd-setupd > .rd-setup-sum"),
      );
      const setup = page.locator(".rd-setupd");
      if (await setup.getAttribute("open") === null) await page.keyboard.press("Enter");
      await compactSummary.focus();
      assert.equal(await compact.getAttribute("open"), null);
      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN, height: 900 });
      await page.waitForFunction(
        () => document.activeElement?.matches(
          ".rd-utility-rail-home [data-rd-tools-menu] > .rd-utility-sum",
        ),
      );

      // An open native disclosure is not a focus trap. If the user Tabs back
      // into the lifecycle controls, crossing the breakpoint may close the
      // now-hidden menu but must not pull focus back to Tools.
      await page.keyboard.press("Enter");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page.locator(".rd-run-actions").evaluate((group) =>
          group.contains(document.activeElement)),
        true,
        "the keyboard did not leave open Tools for the lifecycle rail",
      );
      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-tools-menu][open]").length === 0,
      );
      assert.equal(
        await page.locator(".rd-run-actions").evaluate((group) =>
          group.contains(document.activeElement)),
        true,
        "closing an unfocused Tools copy stole focus at its breakpoint",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Theme keeps one disclosure state and visible focus across its rail breakpoint", async () => {
    const page = await openSurface(
      "/redesign?slot=1",
      { width: RAIL_PREFERENCES_MIN, height: 900 },
    );
    try {
      const rail = page.locator(".rd-theme-rail-home [data-rd-theme-menu]");
      const railSummary = rail.locator(":scope > .rd-theme-sum");
      await railSummary.focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await rail.getAttribute("open"), null);
      assert.equal(await page.locator("[data-rd-theme-menu][open]").count(), 1);

      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-theme-menu][open]").length === 0,
      );
      const setup = page.locator(".rd-setupd");
      const setupSummary = setup.locator(":scope > .rd-setup-sum");
      assert.equal(
        await setupSummary.evaluate((element) => document.activeElement === element),
        true,
        "the hidden rail Theme summary retained focus after narrowing",
      );

      await page.keyboard.press("Enter");
      const compact = page.locator(".rd-theme-compact-home [data-rd-theme-menu]");
      const compactSummary = compact.locator(":scope > .rd-theme-compact-sum");
      await compactSummary.focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await compact.getAttribute("open"), null);
      assert.equal(await page.locator("[data-rd-theme-menu][open]").count(), 1);

      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-theme-menu][open]").length === 0,
      );
      assert.equal(
        await railSummary.evaluate((element) => document.activeElement === element),
        true,
        "the hidden compact Theme summary retained focus after widening",
      );

      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
      await page.waitForFunction(
        () => document.activeElement?.matches(".rd-setupd > .rd-setup-sum"),
      );
      if (await setup.getAttribute("open") === null) await page.keyboard.press("Enter");
      await compactSummary.focus();
      assert.equal(await compact.getAttribute("open"), null);
      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN, height: 900 });
      await page.waitForFunction(
        () => document.activeElement?.matches(
          ".rd-theme-rail-home [data-rd-theme-menu] > .rd-theme-sum",
        ),
      );

      await page.keyboard.press("Enter");
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page.locator(".rd-run-actions").evaluate((group) =>
          group.contains(document.activeElement)),
        true,
        "the keyboard did not leave open Theme for the lifecycle rail",
      );
      await page.setViewportSize({ width: RAIL_PREFERENCES_MIN - 1, height: 900 });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-rd-theme-menu][open]").length === 0,
      );
      assert.equal(
        await page.locator(".rd-run-actions").evaluate((group) =>
          group.contains(document.activeElement)),
        true,
        "closing an unfocused Theme copy stole focus at its breakpoint",
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
      const firstLink = tools.locator(".rd-utility-link[href]").first();
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

  test("the retired product bookmark keeps safe context and exposes no legacy API", async () => {
    const bookmark = await fetch(`${BASE}/nocturne?slot=1&flash=hostile`, {
      redirect: "manual",
    });
    assert.equal(bookmark.status, 308);
    assert.equal(bookmark.headers.get("location"), "/redesign?slot=1");
    assert.equal((await fetch(`${BASE}/api/nocturne`)).status, 404);
    assert.equal((await fetch(`${BASE}/nocturne/save`, { method: "POST" })).status, 404);
  });
});
