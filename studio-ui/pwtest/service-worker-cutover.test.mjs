// Browser contract for the same-origin /nocturne -> /redesign cutover.
//
// Each product route first gets a clean browser context so one route cannot
// hide a missing registration on the other. A third context then proves the
// actual transition properties: shared localStorage, asset-only caching, and
// a healthy worker update followed by a controlled reload.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_SERVICE_WORKER_PORT ?? 4578);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_URL = `${BASE}/sw.js`;
const ROOT_SCOPE = `${BASE}/`;
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
  assert.equal(built.status, 0, "could not build the service-worker fixture");

  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env },
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "service-worker fixture");
  }
});

async function waitForIsland(page) {
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
}

async function activeWorker(page) {
  await page.waitForFunction(async ({ workerUrl, rootScope }) => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.some((registration) =>
      registration.scope === rootScope &&
      registration.active?.scriptURL === workerUrl &&
      registration.active.state === "activated"
    );
  }, { workerUrl: WORKER_URL, rootScope: ROOT_SCOPE }, { timeout: 20_000 });

  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      activeState: registration.active?.state ?? null,
      activeUrl: registration.active?.scriptURL ?? null,
      scope: registration.scope,
    };
  });
}

async function cacheInventory(page) {
  return page.evaluate(async () => {
    const entries = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        entries.push({ cacheName, url: request.url });
      }
    }
    return entries;
  });
}

async function openProduct(context, route) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? String(error)));
  const response = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, `${route} did not render`);
  await waitForIsland(page);
  return { page, pageErrors };
}

function assertRootWorker(worker, route) {
  assert.deepEqual(worker, {
    activeState: "activated",
    activeUrl: WORKER_URL,
    scope: ROOT_SCOPE,
  }, `${route} did not install the active root-scoped worker`);
}

function assertAssetOnly(entries) {
  assert.ok(entries.length > 0, "the active worker did not populate its precache");
  for (const entry of entries) {
    const url = new URL(entry.url);
    assert.equal(url.origin, BASE, `${entry.cacheName} cached another origin: ${entry.url}`);
    assert.match(
      url.pathname,
      /^\/_assets\//,
      `${entry.cacheName} cached a page or API instead of an immutable asset: ${entry.url}`,
    );
  }
}

describe("service-worker cutover contract", { concurrency: false }, () => {
  for (const route of ["/redesign", "/nocturne"]) {
    test(`${route} independently installs the root asset worker`, async () => {
      const context = await browser.newContext({ serviceWorkers: "allow" });
      try {
        const { page, pageErrors } = await openProduct(context, route);
        assertRootWorker(await activeWorker(page), route);
        assertAssetOnly(await cacheInventory(page));
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    });
  }

  test("same-origin cutover preserves local state and survives worker update and reload", async () => {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const { page, pageErrors } = await openProduct(context, "/nocturne");
    try {
      assertRootWorker(await activeWorker(page), "/nocturne");

      const legacyValue = JSON.stringify({ owner: "nocturne", revision: 1 });
      await page.evaluate((value) => {
        localStorage.setItem("ksx-sw-cutover-legacy-state", value);
      }, legacyValue);

      let response = await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await waitForIsland(page);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-sw-cutover-legacy-state")),
        legacyValue,
        "the redesign route stranded local state written by the legacy route",
      );

      const redesignValue = JSON.stringify({ owner: "redesign", revision: 2 });
      await page.evaluate((value) => {
        localStorage.setItem("ksx-sw-cutover-redesign-state", value);
      }, redesignValue);

      response = await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200);
      await waitForIsland(page);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-sw-cutover-legacy-state")),
        legacyValue,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-sw-cutover-redesign-state")),
        redesignValue,
        "the legacy route could not see state written by the redesign route",
      );

      // Exercise every URL class that must remain network-only. The worker's
      // fetch gate must still leave them out of CacheStorage afterwards.
      await page.evaluate(async () => {
        await Promise.all([
          fetch("/redesign"),
          fetch("/nocturne"),
          fetch("/api/redesign"),
          fetch("/api/nocturne"),
        ]);
      });
      assertAssetOnly(await cacheInventory(page));

      const updated = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
        return {
          activeState: registration.active?.state ?? null,
          activeUrl: registration.active?.scriptURL ?? null,
          scope: registration.scope,
        };
      });
      assertRootWorker(updated, "worker update");

      response = await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(response?.status(), 200, "a controlled product reload failed");
      await waitForIsland(page);
      await page.waitForFunction(
        (workerUrl) => navigator.serviceWorker.controller?.scriptURL === workerUrl,
        WORKER_URL,
        { timeout: 20_000 },
      );
      assertRootWorker(await activeWorker(page), "controlled reload");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-sw-cutover-legacy-state")),
        legacyValue,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("ksx-sw-cutover-redesign-state")),
        redesignValue,
      );
      assertAssetOnly(await cacheInventory(page));
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
});
