// The redesign topbar's theme menu, in a real browser.
//
// WHY THIS LEVEL: the Rust tests pin that the menu's rows are SERVED (every
// row painted, one marked, the verb routed and guarded — render_redesign.rs
// and tests/http.rs). Only a browser can pin that picking one RESTAMPS
// <html data-theme> without a reload (the fetch-submit + refresh path in
// redesign.ts), that the choice survives a full reload because the daemon
// owns it, and that the whole flow still works with scripting OFF — the
// no-JS baseline the native <details> + plain form POST exist to serve.
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { deviceInstanceId } from "../src/device-instance-id.ts";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_REDESIGN_THEME_PORT ?? 4530);
const BASE = `http://127.0.0.1:${PORT}`;
const G915 = "usb:046d:c545:00";
const G915_ID = deviceInstanceId(G915);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;

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
  assert.equal(built.status, 0, "could not build the ksx-studio theme fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  // No KSX_FIXTURE_THEME seed: the suite starts un-stamped (System) and
  // drives every transition through the page itself.
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer(BASE);
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "theme fixture");
  }
});

/** A hydrated /redesign page, with every page error and console error kept. */
async function openRedesign(options = {}, route = "/redesign") {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
    ...options,
  });
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  return page;
}

async function revealCanvasItem(page, instanceId) {
  await page.waitForSelector(
    `.forma-canvas-stage > [data-instance-id="${instanceId}"][data-canvas-x]`,
    { timeout: 20_000 },
  );
  await page.locator(`.navigator-item[data-instance-id="${instanceId}"]`)
    .evaluate((marker) => marker.click());
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
        ?.getAttribute("aria-current") === "true" &&
      !document.querySelector(".is-camera-animating"),
    instanceId,
    { timeout: 20_000 },
  );
}

async function ensureActiveKeyboard(page) {
  const board = page.locator(
    `.forma-canvas-stage > [data-instance-id="${G915_ID}"][data-selector="${G915}"]`,
  );
  if ((await board.count()) === 0) {
    await page.click('[data-nx="rd-devs-open"]');
    await page.locator(`.rd-devmodal button[data-selector="${G915}"]`).click();
    await page.keyboard.press("Escape");
  } else if ((await board.getAttribute("data-mapping-available")) !== "true") {
    await page.click('[data-nx="rd-devs-open"]');
    const row = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    await row.click();
    await board.waitFor({ state: "detached" });
    await row.click();
    await page.keyboard.press("Escape");
  }
  await revealCanvasItem(page, G915_ID);
  await page.waitForFunction(
    (id) =>
      document.querySelector(
        `.forma-canvas-stage > [data-instance-id="${id}"]`,
      )?.getAttribute("data-mapping-available") === "true",
    G915_ID,
    { timeout: 20_000 },
  );
  return board;
}

describe("the redesign theme menu", () => {
  test("a pick restamps <html> in place — no reload, flash spoken, marking moved", async () => {
    const page = await openRedesign();
    // The un-stamped opener: System in effect, no data-theme on <html>.
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      undefined,
      "the suite must start un-stamped",
    );
    // Every roster row is served and PAINTED (the pill-none regression's
    // browser-side twin: the rust test counts forms; this counts what a
    // browser actually lays out once the fold is open).
    await page.click(".rd-themed > summary");
    const rows = page.locator('.rd-thememenu form[action="/redesign/theme"] button');
    assert.equal(await rows.count(), 4, "System + the three shipped themes");
    for (let i = 0; i < 4; i += 1) {
      assert.ok(
        (await rows.nth(i).boundingBox()) !== null,
        `theme row ${i} is served but not painted`,
      );
    }
    // A marker that dies with the document: if the pick navigates, it is
    // gone and the assertion below fails loudly.
    await page.evaluate(() => {
      window.__ksxStay = 42;
    });
    // Hold the request long enough to prove the whole picker — not only the
    // chosen row's separate form — becomes one locked mutation surface.
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`${BASE}/redesign/theme`, async (route) => {
      await requestGate;
      await route.continue();
    });
    const matrix = page.locator('.rd-thememenu form:has(input[value="matrix"]) button');
    try {
      const requestStarted = page.waitForRequest(`${BASE}/redesign/theme`);
      await matrix.focus();
      await page.keyboard.press("Enter");
      await requestStarted;
      assert.equal(
        await rows.evaluateAll((buttons) => buttons.every((button) => button.disabled)),
        true,
        "one in-flight pick disables every theme choice",
      );
    } finally {
      releaseRequest();
    }
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "matrix",
      null,
      { timeout: 10_000 },
    );
    await page.unroute(`${BASE}/redesign/theme`);
    assert.equal(
      await page.evaluate(() => window.__ksxStay),
      42,
      "the stamp must arrive WITHOUT a navigation — fetch-submit, not reload",
    );
    // The outcome line is the server's allowlisted sentence, worn visibly.
    await page.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent === "Studio theme updated.",
      null,
      { timeout: 10_000 },
    );
    assert.match(
      await page.locator(".rd-flash").getAttribute("class"),
      /\bok\b/,
      "a success flash wears the success colour",
    );
    // The marking followed the refresh and remains a valid ARIA token after
    // the client repaint — not a boolean attribute serialized as empty.
    await page.waitForFunction(
      () =>
        document
          .querySelector('.rd-thememenu form:has(input[value="matrix"]) button')
          ?.getAttribute("aria-current") === "true",
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.locator('.rd-thememenu form button[aria-current="true"]').count(),
      1,
      "exactly one row claims to be current",
    );
    // The fold that just acted closed itself.
    assert.equal(
      await page.locator(".rd-themed[open]").count(),
      0,
      "the menu closes after an action",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-theme-sum")),
      true,
      "a keyboard pick returns focus to the Theme summary",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("Theme owns Escape and layers above an open Inspector", async () => {
    const page = await openRedesign();
    const board = await ensureActiveKeyboard(page);
    // The full physical board is the interaction surface. Its exact key opens
    // the controller Inspector while retaining that keyboard as authoring
    // focus; there is no separate identity card to target.
    await board.locator('.n-kb button.n-key[data-key="A"]').click();
    await page.waitForFunction(() => !document.querySelector(".rd-inspector")?.hidden);
    const summary = page.locator(".rd-themed > summary");
    await summary.click();
    const layers = await page.evaluate(() => ({
      theme: Number.parseInt(getComputedStyle(document.querySelector(".rd-themed")).zIndex, 10),
      inspector: Number.parseInt(getComputedStyle(document.querySelector(".rd-inspector")).zIndex, 10),
    }));
    assert.ok(
      layers.theme > layers.inspector,
      `the open theme layer (${layers.theme}) must clear the Inspector (${layers.inspector})`,
    );
    await page
      .locator('.rd-thememenu form:has(input[value="matrix"]) button')
      .click({ trial: true });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rd-themed[open]").count(), 0, "Escape closes Theme first");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-theme-sum")),
      true,
      "Escape restores focus to the Theme summary",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("Theme stays reachable beside the narrowest desktop Inspector", async () => {
    const page = await openRedesign({ viewport: { width: 601, height: 900 } });
    // This test owns the responsive collision, not key hit-testing at an
    // extreme semantic zoom. Put the real drawer into its real open geometry
    // deterministically, then exercise the Theme trigger without force.
    await page.evaluate(() => {
      const root = document.querySelector("[data-forma-island]");
      const inspector = document.querySelector(".rd-inspector");
      root?.classList.add("is-inspector-open");
      if (inspector instanceof HTMLElement) inspector.hidden = false;
    });
    await page.waitForFunction(
      () => document.querySelector(".rd-inspector")?.getAnimations().length === 0,
    );
    await page.locator(".rd-theme-home .rd-theme-sum").click();
    const geometry = await page.evaluate(() => {
      const menu = document.querySelector(".rd-thememenu")?.getBoundingClientRect();
      const inspector = document.querySelector(".rd-inspector")?.getBoundingClientRect();
      return menu && inspector
        ? { menuLeft: menu.left, menuRight: menu.right, inspectorLeft: inspector.left }
        : null;
    });
    assert.ok(geometry, "Theme or Inspector geometry is missing");
    assert.ok(
      geometry.menuLeft >= 0 && geometry.menuRight <= geometry.inspectorLeft,
      `Theme menu is clipped or covered beside the Inspector: ${JSON.stringify(geometry)}`,
    );
    assert.deepEqual(page.ksxNoise, [], "narrow desktop Theme stays error-free");
    await page.close();
  });

  test("a served flash survives hydration, then its query is consumed", async () => {
    const message = "Studio theme updated.";
    const page = await openRedesign(
      {},
      `/redesign?flash=${encodeURIComponent(message)}`,
    );
    assert.equal(await page.locator(".rd-flash").textContent(), message);
    assert.match(await page.locator(".rd-flash").getAttribute("class"), /\bok\b/);
    assert.equal(new URL(page.url()).searchParams.has("flash"), false, "history is cleaned once");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the theme enhancer leaves unrelated redesign POST forms alone", async () => {
    const page = await openRedesign();
    const result = await page.evaluate(() => {
      const root = document.querySelector("[data-forma-island]");
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/redesign/future-widget-probe";
      root.append(form);
      const event = new Event("submit", { bubbles: true, cancelable: true });
      const allowed = form.dispatchEvent(event);
      const prevented = event.defaultPrevented;
      form.remove();
      return { allowed, prevented };
    });
    assert.deepEqual(result, { allowed: true, prevented: false });
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("Theme meets the coarse-pointer target floor", async () => {
    const page = await openRedesign({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const box = await page.locator(".rd-theme-home .rd-theme-sum").boundingBox();
    assert.ok(
      box && box.width >= 40 && box.height >= 40,
      `Theme target is ${box?.width ?? 0}×${box?.height ?? 0}px`,
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("a failed repaint keeps the picker open and reports the uncertain state", async () => {
    const page = await openRedesign();
    await page.route("**/api/redesign*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "not-json",
      });
    });
    await page.click(".rd-themed > summary");
    const matrix = page.locator('.rd-thememenu form:has(input[value="matrix"]) button');
    await matrix.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent?.includes("could not refresh"),
      null,
      { timeout: 10_000 },
    );
    assert.equal(await page.locator(".rd-themed[open]").count(), 1, "choices stay available");
    assert.equal(
      await page.locator(".rd-thememenu button:disabled").count(),
      0,
      "the menu-wide lock releases",
    );
    assert.equal(
      await matrix.evaluate((button) => button === document.activeElement),
      true,
      "focus returns to the attempted choice for retry",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the choice survives a full reload — the daemon owns it, SSR stamps it", async () => {
    const page = await openRedesign();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      "matrix",
      "the previous test's write must persist across a fresh page",
    );
    await page.click(".rd-themed > summary");
    assert.equal(
      await page
        .locator('.rd-thememenu form:has(input[value="matrix"]) button[aria-current="true"]')
        .count(),
      1,
      "the served marking agrees with the stamp",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("System clears the stamp, and the clearing also survives a reload", async () => {
    const page = await openRedesign();
    await page.click(".rd-themed > summary");
    await page.click('.rd-thememenu form:has(input[value="system"]) button');
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === undefined,
      null,
      { timeout: 10_000 },
    );
    await page.close();

    const again = await openRedesign();
    assert.equal(
      await again.evaluate(() => document.documentElement.dataset.theme),
      undefined,
      "`system` is stored as absence and renders as absence",
    );
    assert.deepEqual(again.ksxNoise, [], "the page must stay error-free");
    await again.close();
  });

  test("scripting off: native profile and capture state survive beyond the old refresh timer", async () => {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "light",
      javaScriptEnabled: false,
    });
    const route = "/redesign?slot=1&q=face%20buttons";
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.click(".rd-profiled > summary");
    const consent = page.locator(
      '.rd-capture-native form[action="/redesign/capture/prepare"] ' +
        'input[name="confirm_spare_keyboard"]',
    );
    await consent.check();

    // The removed fallback timer fired at five seconds and navigated to bare
    // /redesign, collapsing native disclosures and clearing every confirmation. Wait past
    // that boundary so all three assertions prove the real browser behavior.
    await page.waitForTimeout(5_500);
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, route);
    assert.equal(await page.locator(".rd-profiled[open]").count(), 1, "Profile stays open");
    assert.equal(await page.locator(".rd-setupd").count(), 0, "removed Setup stays absent");
    assert.equal(await consent.isChecked(), true, "required consent stays checked");
    await page.close();
  });

  test("scripting off: the native details + plain form POST still change the theme", async () => {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "light",
      javaScriptEnabled: false,
    });
    await page.goto(
      `${BASE}/redesign?slot=2&macro=missing-preview&q=face%20buttons`,
      { waitUntil: "domcontentloaded" },
    );
    // The summary is real chrome without scripting (deliberately NOT an
    // `.n-autobtn`, which the stylesheet hides until the wire stamps `.js`).
    await page.click(".rd-themed > summary");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('.rd-thememenu form:has(input[value="dark"]) button'),
    ]);
    // The baseline round trip: POST + 303 back to THIS page, outcome in the
    // query, the redirect's own render already stamped.
    const landed = new URL(page.url());
    assert.equal(landed.pathname, "/redesign", `the 303 target is fixed: ${page.url()}`);
    assert.ok(landed.searchParams.has("flash"), `the outcome is present: ${page.url()}`);
    assert.equal(landed.searchParams.get("slot"), "2", "selected controller survives");
    assert.equal(landed.searchParams.get("macro"), "missing-preview", "macro door survives");
    assert.equal(landed.searchParams.get("q"), "face buttons", "binding filter survives");
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      "dark",
      "the redirect's render stamps the new choice with scripting off",
    );
    const flash = await page.locator(".rd-flash").textContent();
    assert.equal(flash, "Studio theme updated.", "the server painted the outcome line");
    await page.close();
  });
});
