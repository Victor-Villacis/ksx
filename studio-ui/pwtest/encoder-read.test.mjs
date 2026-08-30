// The encoder read surface, in a real browser.
//
// WHY THIS LEVEL: the Rust test that decodes `--messy-panel` calls the chart
// builder directly, so it passed for a whole day while the surface it feeds was
// UNREACHABLE — the fixture's board row never set `chart_readable`, which
// defaults to false, so `#n-encoder-read` stayed hidden and not one of the
// states that fixture exists to render could be seen. A test that never opens a
// browser cannot notice that. This one does.
//
// What each test here would have caught while it was being written:
//  - the read section never revealed, because a served boolean defaulted false
//  - "press that control to find out" offered for a HID usage Windows never
//    delivers to ksx, where pressing produces nothing at all to hear
//  - a byte of zero rendered as a bare "Unassigned", asserting the one thing a
//    chart read cannot establish
//  - the board-level shift fact repeated on 56 rows as a raw wire enum
//  - the backend's composed notes fetched, typed, and thrown away
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_ENCODER_PORT ?? 4524);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;
let fixtureGeneration = "";

async function waitForServer(base = BASE, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/nocturne`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/nocturne`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  // `--messy-panel` is the whole point: the seeded fixture's chart is 56 clean
  // supported keys, so every state below would be unreachable without it.
  server = spawn(fixtureExe, [String(PORT), "--messy-panel"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  await waitForServer(BASE);
  const provenance = await fetch(`${BASE}/api/nocturne`).then((response) => response.json());
  fixtureGeneration = provenance.environment?.generation ?? "";
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "encoder fixture");
  }
});

/** The page with the I-PAC selected and its chart already read. */
async function readTheBoard() {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });
  await page.addInitScript(
    ({ expectedOrigin, generation }) => {
      if (location.origin !== expectedOrigin) return;
      localStorage.setItem("ksx-studio-fixture-generation-v1", generation);
    },
    { expectedOrigin: BASE, generation: fixtureGeneration },
  );
  await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });

  // The device row is SERVER-RENDERED and visible long before the island
  // hydrates, so a click can land on DOM nobody is listening to — the
  // selection silently does not happen and every wait below times out 30 s
  // later. This was the suite's one intermittent (seen locally and on CI run
  // 33114699364, same test, same 30 s shape). visual-smoke.test.mjs already
  // states the rule: interact only after the island reports active, and after
  // the canvas engine has adopted its widgets — the workbench this journey
  // opens is one of them.
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => {
      const kb = document.querySelector('.n-canvas [data-instance-id="keyboard"]');
      return !document.querySelector(".n-canvas") || kb?.dataset.canvasX !== undefined;
    },
    undefined,
    { timeout: 30_000 },
  );

  // Pick the encoder the way a person does: press its row.
  const row = page.locator("button.n-dev", { hasText: "Ultimarc I-PAC 4" }).first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();

  // `#n-encoder-read`'s reveal gate (`syncControlSurfaceChrome`) needs the
  // SELECTION to be island state, not just a click that happened: the row
  // repaints with class `on` when the selection lands. Waiting on that fact
  // (a server-marked class, not prose) is what separates "the click landed"
  // from "the click happened" — the gap this journey's one intermittent
  // lived in.
  await page
    .locator("button.n-dev.on", { hasText: "Ultimarc I-PAC 4" })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  // `#n-encoder-read` lives inside the control-surface workbench widget, which
  // is mounted on the canvas only once that surface is open. Selecting the
  // board is necessary and not sufficient.
  await page.click('[data-nx="surface-open"]');

  const section = page.locator("#n-encoder-read");
  await section.waitFor({ state: "visible", timeout: 30_000 });

  await page.locator('[data-nx="encoder-read"]').click();
  // The status line is the read's own answer; wait for it to stop being empty.
  await page.waitForFunction(
    () => (document.querySelector("[data-encoder-status]")?.textContent ?? "").includes("Read "),
    undefined,
    { timeout: 30_000 },
  );
  return { page, section };
}

describe("the encoder read surface", () => {
  test("a board ksx can read offers the read, and the read fills the table", async () => {
    const { page } = await readTheBoard();
    try {
      const rows = page.locator("[data-encoder-rows] tr");
      assert.equal(await rows.count(), 56, "a complete I-PAC chart is 56 terminals");

      const status = await page.locator("[data-encoder-status]").textContent();
      assert.match(status ?? "", /Read 56 terminals/);
    } finally {
      await page.close();
    }
  });

  test("a byte no learner can hear is not answered with 'press it'", async () => {
    const { page } = await readTheBoard();
    try {
      const status = (await page.locator("[data-encoder-status]").textContent()) ?? "";

      // 1sw5 holds a vendor byte: a press CAN resolve that one.
      assert.match(status, /press that control to find out what it really sends/);
      // 1sw6 holds HID 0x66, which Windows never delivers to ksx. Offering a
      // press there is an offer that can never succeed, so the sentence has to
      // say so rather than lumping both under one count.
      assert.match(status, /will not reveal/);

      const unhearable = page.locator('[data-encoder-rows] tr[data-terminal-id="1sw6"]');
      assert.match(
        (await unhearable.textContent()) ?? "",
        /Unobservable HID action 0x66/,
        "the byte is preserved exactly, not guessed at",
      );
    } finally {
      await page.close();
    }
  });

  test("a byte of zero never claims the terminal does nothing", async () => {
    const { page } = await readTheBoard();
    try {
      // An onboard macro is byte-identical to an unassigned terminal
      // (ENHANCEMENTS.md E10), so "Unassigned" alone asserts what a chart read
      // cannot establish.
      const silent = page.locator('[data-encoder-rows] tr[data-terminal-id="3sw8"]');
      const text = (await silent.textContent()) ?? "";
      assert.match(text, /macro/i, `a zero byte read as inert: ${text}`);
      assert.equal(
        await silent.getAttribute("data-silent-byte"),
        "",
        "the row is not marked as the one a read cannot resolve",
      );
      // The shifted plane stores bytes through the same decoder, so a zero
      // there is exactly as ambiguous — yet the Shifted column shipped
      // printing bare "Unassigned" directly under a normal column that
      // refuses that claim for the identical byte. No shifted cell may ever
      // make it.
      const shifted = await page
        .locator("[data-encoder-rows] tr td:nth-child(3)")
        .allTextContents();
      assert.ok(shifted.length > 0, "no shifted cells rendered at all");
      const bare = shifted.filter((cell) => cell.trim() === "Unassigned");
      assert.equal(
        bare.length,
        0,
        `${bare.length} shifted cell(s) assert an emptiness a chart read cannot establish`,
      );
    } finally {
      await page.close();
    }
  });

  test("shift is said once for the board, not 56 times as a wire enum", async () => {
    const { page } = await readTheBoard();
    try {
      const status = (await page.locator("[data-encoder-status]").textContent()) ?? "";
      // The production label spelling ("Player 1 · Start"), which the fixture
      // now mirrors — this line failed while the fixture spoke "P1 Start", a
      // prose shape the real backend never serves.
      assert.match(status, /Player 1 · Start is the Shift key/, status);

      // Exactly one row says anything about shift, and no row prints the raw
      // kebab-case wire value.
      const cells = await page.locator("[data-encoder-rows] tr td:nth-child(4)").allTextContents();
      assert.equal(cells.filter((cell) => cell.trim()).length, 1);
      assert.equal(
        cells.filter((cell) => cell === "disabled" || cell === "opaque").length,
        0,
        "a wire enum reached the page as user-facing text",
      );
    } finally {
      await page.close();
    }
  });

  test("the backend's composed notes reach the page", async () => {
    const { page } = await readTheBoard();
    try {
      // The route serves no `summary`, so every count the read produced travels
      // in `notes`. They were fetched, typed, and dropped.
      const facts = (await page.locator("[data-encoder-facts]").textContent()) ?? "";
      assert.match(facts, /of 56 normal outputs carry a byte/, facts);
      assert.match(facts, /cannot be selected as KSX keys/, facts);
    } finally {
      await page.close();
    }
  });

  test("a selector the board no longer matches never names another board", async () => {
    // The refusal for an unknown selector formats EVERY connected board's raw
    // device instance path into its message. That must not reach the page.
    const answer = await fetch(`${BASE}/api/panel/chart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector: "no-such-board" }),
    }).then((response) => response.json());

    assert.equal(answer.ok, false);
    assert.doesNotMatch(answer.error ?? "", /USB\\|HID\\/, answer.error ?? "");
    assert.doesNotMatch(answer.error ?? "", /no-such-board/, "it echoed the caller's own string");
    assert.doesNotMatch(answer.remedy ?? "", /USB\\|HID\\/, answer.remedy ?? "");
  });
});
