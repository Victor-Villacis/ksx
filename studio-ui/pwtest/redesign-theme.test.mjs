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
import { stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_REDESIGN_THEME_PORT ?? 4530);
const BASE = `http://127.0.0.1:${PORT}`;
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
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
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
    await page.waitForFunction(
      () =>
        document.querySelector('.forma-canvas-stage > [data-instance-id="mock-a"]')?.dataset
          .canvasX !== undefined,
      null,
      { timeout: 20_000 },
    );
    await page.locator('.forma-canvas-stage > [data-instance-id="mock-a"]').click();
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
    const box = await page.locator(".rd-theme-sum").boundingBox();
    assert.ok(box && box.height >= 40, `Theme target is ${box?.height ?? 0}px tall`);
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("a failed repaint keeps the picker open and reports the uncertain state", async () => {
    const page = await openRedesign();
    await page.route(`${BASE}/api/redesign`, async (route) => {
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

  test("scripting off: the native details + plain form POST still change the theme", async () => {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "light",
      javaScriptEnabled: false,
    });
    await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
    // The summary is real chrome without scripting (deliberately NOT an
    // `.n-autobtn`, which the stylesheet hides until the wire stamps `.js`).
    await page.click(".rd-themed > summary");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('.rd-thememenu form:has(input[value="dark"]) button'),
    ]);
    // The baseline round trip: POST + 303 back to THIS page, outcome in the
    // query, the redirect's own render already stamped.
    assert.ok(
      page.url().startsWith(`${BASE}/redesign?flash=`),
      `the 303 must land back on /redesign, got ${page.url()}`,
    );
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
