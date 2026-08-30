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
      text: root?.querySelector("[data-rd-live-status]")?.textContent ?? "",
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

async function openSetup(page) {
  const details = page.locator(".rd-setupd");
  if (!(await details.evaluate((element) => element.open))) {
    await page.locator(".rd-setup-sum").click();
  }
}

async function history(page) {
  return page.evaluate(() => structuredClone(window.ksxLiveHistory));
}

function assertInactive(entries) {
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.deepEqual(entry, {
      state: "inactive",
      text: "Live input starts after you press Play.",
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

    await openSetup(page);
    const prepare = page.locator('[data-rd-form="capture-prepare"]');
    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await prepare.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-rd-form="play"] button')).some(
        (button) => !button.disabled && button.offsetParent !== null,
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
        document.querySelector("[data-rd-live-status]")?.textContent ===
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
