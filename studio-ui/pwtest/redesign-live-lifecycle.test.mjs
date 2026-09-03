// Regression for the real lifecycle boundary between /api/redesign and
// /api/live. The fixture boots IDLE; KSX_FIXTURE_LIVE only enables its
// scripted transport. Play and Stop must be the sole mutable session truth.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_LIVE_LIFECYCLE_PORT ?? 4546);
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

async function session() {
  const response = await fetch(`${BASE}/api/redesign`);
  assert.equal(response.ok, true);
  return (await response.json()).operations.session;
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
  assert.equal(built.status, 0, "could not build the live lifecycle fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], {
    cwd: repoRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      KSX_FIXTURE_SESSION: "idle",
      KSX_FIXTURE_LIVE: "1",
    },
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "redesign idle live lifecycle fixture");
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
    () => document.querySelector("[data-forma-island]")?.dataset.rdLiveState === "inactive",
    null,
    { timeout: 20_000 },
  );
  await page.evaluate(() => {
    const root = document.querySelector("[data-forma-island]");
    const read = () => ({
      state: root?.dataset.rdLiveState ?? "",
      text: root?.querySelector("[data-rd-live-status] .rd-live-detail")?.textContent ?? "",
      short: root?.querySelector("[data-rd-live-status] .rd-live-short")?.textContent ?? "",
    });
    window.ksxLiveHistory = [read()];
    let last = JSON.stringify(window.ksxLiveHistory[0]);
    const capture = () => {
      const next = read();
      const encoded = JSON.stringify(next);
      if (encoded !== last) {
        window.ksxLiveHistory.push(next);
        last = encoded;
      }
    };
    window.ksxLiveObserver = new MutationObserver(capture);
    window.ksxLiveObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-rd-live-state"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.ksxLiveTimer = setInterval(capture, 25);
  });
  return page;
}

async function clickAction(page, kind) {
  const button = page.locator(
    `[data-rd-form="${kind}"] button[type="submit"]:visible`,
  ).first();
  await button.click();
}

async function openCaptureForm(page, kind) {
  const review = page.locator('[data-rd-attention]:visible [data-nx="rd-review-recovery"]');
  if (await review.count()) {
    await review.click();
  }
  const details = page.locator(
    `.rd-device-capture:has([data-rd-form="${kind}"])`,
  ).first();
  await details.waitFor({ state: "attached" });
  if (!(await details.evaluate((element) => element.open))) {
    await details.locator(":scope > summary").click();
  }
  const form = details.locator(`[data-rd-form="${kind}"]`);
  await form.waitFor({ state: "visible" });
  return form;
}

async function history(page) {
  return page.evaluate(() => structuredClone(window.ksxLiveHistory));
}

async function assertDegradedLiveRail(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(
    (expected) => document.documentElement.clientWidth === expected &&
      document.querySelector("[data-forma-island]")?.dataset.rdLiveState === "degraded" &&
      /frame dropped/i.test(document.querySelector("[data-rd-live-stats]")?.textContent ?? ""),
    width,
  );
  const geometry = await page.evaluate(() => {
    const top = document.querySelector(".rd-top");
    const status = document.querySelector(".rd-live-state");
    const stats = document.querySelector(".rd-live-stats");
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    const children = Array.from(document.querySelectorAll(".rd-run-actions > *"))
      .filter((element) => element.checkVisibility() && getComputedStyle(element).position !== "absolute")
      .map((element) => ({
        label: element.getAttribute("data-rd-form")
          ?? (element.hasAttribute("data-rd-live-status") ? "live status" : null)
          ?? (element.hasAttribute("data-rd-live-stats") ? "live stats" : null)
          ?? element.textContent?.trim()
          ?? element.tagName,
        ...rectOf(element),
      }))
      .sort((left, right) => left.left - right.left);
    return {
      rail: top ? { client: top.clientWidth, scroll: top.scrollWidth } : null,
      status: status ? rectOf(status) : null,
      stats: stats ? {
        ...rectOf(stats),
        visible: stats.checkVisibility(),
        text: stats.textContent?.trim() ?? "",
      } : null,
      children,
    };
  });
  assert.ok(geometry.rail, `${width}px live rail is missing`);
  assert.ok(
    geometry.rail.scroll <= geometry.rail.client,
    `${width}px degraded live rail overflows: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.status && geometry.status.width >= 64,
    `${width}px degraded state lost its readable name: ${JSON.stringify(geometry.status)}`,
  );
  assert.ok(geometry.stats?.text, `${width}px degraded rail lost its statistics`);
  if (width <= 1280) {
    assert.equal(geometry.stats.visible, false, `${width}px should defer detailed live statistics`);
  } else {
    assert.equal(geometry.stats.visible, true, `${width}px should show detailed live statistics`);
    assert.ok(
      geometry.stats.width >= 64,
      `${width}px live statistics became unreadable: ${JSON.stringify(geometry.stats)}`,
    );
  }
  for (let index = 1; index < geometry.children.length; index += 1) {
    const before = geometry.children[index - 1];
    const current = geometry.children[index];
    assert.ok(
      current.left >= before.right - 0.5,
      `${before.label} overlaps ${current.label} at ${width}px: ${JSON.stringify(geometry.children)}`,
    );
  }
}

function assertInactive(entries) {
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.deepEqual(entry, {
      state: "inactive",
      text: "Live input starts after you press Play.",
      short: "Idle",
    });
  }
}

describe("redesign mutable live lifecycle", { concurrency: false }, () => {
  test("the canonical redesign launcher opts only its fixture child into live transport", async () => {
    const source = await readFile(path.join(repoRoot, "tools", "redesign", "serve.ps1"), "utf8");
    assert.match(source, /\$env:KSX_FIXTURE_LIVE\s*=\s*"1"/);
    assert.match(
      source,
      /finally\s*\{[\s\S]*SetEnvironmentVariable\("KSX_FIXTURE_LIVE",\s*\$PreviousFixtureLive,\s*"Process"\)/,
      "the launcher must restore its caller after the child inherits live transport",
    );
  });

  test("idle remains coherent across retries, Play starts frames, and Stop settles inactive", async () => {
    const page = await openBench();

    assert.equal((await session()).running, false);
    // Cover more than two server-directed EventSource retry windows. An idle
    // refusal must not flap inactive → offline/reconnecting or retain stale
    // text while its data state changes.
    await page.waitForTimeout(4_500);
    assertInactive(await history(page));

    const prepare = await openCaptureForm(page, "capture-prepare");
    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await prepare.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-rd-form="play"] button')).some(
        (button) => !button.disabled &&
          button.getAttribute("aria-disabled") === "false" &&
          button.offsetParent !== null,
      ),
      null,
      { timeout: 20_000 },
    );

    await clickAction(page, "play");
    await page.waitForFunction(
      () => ["active", "degraded"].includes(
        document.querySelector("[data-forma-island]")?.dataset.rdLiveState ?? "",
      ),
      null,
      { timeout: 20_000 },
    );
    assert.equal((await session()).running, true);
    const played = await history(page);
    const firstActive = played.findIndex(({ state }) => state === "active" || state === "degraded");
    assert.notEqual(firstActive, -1);

    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.rdLiveState === "degraded" &&
        /frame dropped/i.test(document.querySelector("[data-rd-live-stats]")?.textContent ?? ""),
      null,
      { timeout: 20_000 },
    );
    for (const width of [1141, 1280, 1281, 1439, 1440, 1599, 1600, 1919, 1920]) {
      await assertDegradedLiveRail(page, width);
    }

    // One complete six-frame choreography is 2.4 seconds. Staying longer
    // proves the fixture does not fabricate an in-band stop or regress to the
    // old boot-environment gate after Play.
    await page.waitForTimeout(3_200);
    const runningEntries = (await history(page)).slice(firstActive);
    assert.equal(
      runningEntries.some(({ state }) => ["inactive", "offline", "reconnecting"].includes(state)),
      false,
      JSON.stringify(runningEntries),
    );
    assert.ok(runningEntries.some(({ state }) => state === "active"));

    await clickAction(page, "stop");
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.rdLiveState === "inactive" &&
        document.querySelector("[data-rd-live-status] .rd-live-detail")?.textContent ===
          "Live input starts after you press Play.",
      null,
      { timeout: 20_000 },
    );
    assert.equal((await session()).running, false);
    const stoppedMark = (await history(page)).length;
    await page.waitForTimeout(4_500);
    const stoppedEntries = (await history(page)).slice(stoppedMark - 1);
    assertInactive(stoppedEntries);

    assert.deepEqual(page.ksxNoise, []);
    await page.evaluate(() => {
      clearInterval(window.ksxLiveTimer);
      window.ksxLiveObserver.disconnect();
    });
    await page.close();
  });
});
