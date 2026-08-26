// "Identify by key", in a real browser — the two things the server cannot see.
//
// WHY THIS LEVEL: identify's whole shape lives in the browser. The server
// blocks for up to 11 s inside `identify_and_stage`, stages a device and
// redirects with one fixed sentence; everything the USER experiences in
// between — whether their keypress scrolls the page out from under them, and
// whether the answer says which keyboard responded — is client behaviour that
// no Rust test can reach. The render tests pin that the form and its sentences
// are SERVED; only this can pin that pressing a key does not throw the pane
// 327 px down the page.
//
// What each test here would have caught, and did not, until 2026-08-26:
//
//  - THE JUMP. `submitForm` disables the button it just submitted, so Chrome
//    blurs it to <body>. The user then presses a real key on the real
//    keyboard — which is the entire point of the verb — and nothing swallows
//    it, so Chrome runs its default scroll action against `.n-left`: the only
//    scroller on the page, because `.nocturne { height: 100vh; overflow:
//    hidden }` means the document itself cannot scroll. Measured on the live
//    lane: ArrowDown 36 px, ArrowDown 75 px, Space 402 px, PageDown 434 px
//    (max) — the Identify button went from y=408 to y=-26, off the top of the
//    pane, carrying its answer box with it. `armFocusGuard` had existed all
//    along and was called from exactly one place: `startLearn`.
//
//  - THE MISSING ANSWER. `N_IDENTIFY_OK` never names the device. It renders
//    in a 32 px bar at the top of the page while the user is looking at the
//    left pane. `.n-idbox.done` — a settled, non-pulsing state of the box
//    directly under the button — was designed for exactly this and written by
//    nothing: `grep -c "n-idbox done"` on the built bundle was 0.
//
// The in-flight window is created with `page.route`, not with a real 11 s
// wait: the fixture's scripted learner answers the first poll, so identify
// completes in milliseconds here and the guard would be armed and disarmed
// before a keypress could land. Delaying the POST reproduces the real timing
// deterministically and without sleeping.
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
const PORT = Number(process.env.KSX_PWTEST_IDENTIFY_PORT ?? 4481);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

/** The one sentence `nocturne_form_identify` redirects with on success
 *  (`server/nocturne.rs` `N_IDENTIFY_OK`). Pinned to the Rust constant by
 *  `the_identify_success_sentence_is_the_one_the_island_matches`. */
const IDENTIFY_OK = "Keyboard identified and selected. Nothing has been captured, saved, or started.";

/** What the fixture's scripted learner resolves to, and therefore the served
 *  `kb_title` the answer box must show. It is a SERVED value on purpose — the
 *  box reads `kb_title`, never a sentence the island composed. */
const FIXTURE_BOARD = "Ultimarc I-PAC 4";

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
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio identify fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer(BASE);
  const provenance = await fetch(`${BASE}/api/nocturne`).then((response) => response.json());
  fixtureGeneration = provenance.environment?.generation ?? "";
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "identify fixture");
  }
});

/** A hydrated /nocturne whose canvas has adopted the keyboard widget.
 *
 *  The adoption wait is the same one the rest of the suite uses, and for the
 *  same reason `visual-smoke.test.mjs` gives: every other assertion on this
 *  page passes with a dead canvas, so the engine's geometry write is the only
 *  honest "the page is alive" signal.
 *
 *  The viewport is 900 tall deliberately — it is the height the live-lane
 *  measurement was taken at, and it is what makes `.n-left` a real scroller
 *  with the Identify button below the fold. A taller window would let the pane
 *  fit its content and the jump would be unreproducible. */
async function openNocturne() {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  await page.addInitScript(
    ({ expectedOrigin, generation }) => {
      if (location.origin !== expectedOrigin) return;
      localStorage.setItem("ksx-studio-fixture-generation-v1", generation);
    },
    { expectedOrigin: BASE, generation: fixtureGeneration },
  );
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
      undefined,
    null,
    { timeout: 20_000 },
  );
  return page;
}

/** Hold the identify POST open, so the page is genuinely mid-identify while
 *  the test's keys arrive. Returns the release function.
 *
 *  Without this the window does not exist to test: the fixture's scripted
 *  learner answers the first poll, so the whole transaction completes in
 *  milliseconds and the guard is armed and disarmed before a key can land.
 *  Against the real daemon the window is up to eleven seconds. */
async function holdIdentify(page) {
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/nocturne/device/identify", async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

/** Record every keydown that reaches `window` and whether its default action
 *  was cancelled. Added at the BUBBLE phase, so it runs after the island's
 *  capture-phase guard and sees the guard's verdict.
 *
 *  `defaultPrevented` is the honest observable here, and it is the mechanism
 *  itself rather than a proxy for it: "the pane scrolled" IS the default
 *  action of an unhandled ArrowDown/Space/PageDown, and `preventDefault` is
 *  precisely the statement that the default action does not run. The scroll
 *  cannot be asserted directly in this suite — headless Chromium does not
 *  perform the default key-scroll against a NESTED scroller for synthesized
 *  keys, measured: with `.n-left` holding 715 px of scroll room, an unguarded
 *  PageDown moves it 0 px here and 434 px on the live lane. So the scroll was
 *  measured where it happens (docs in the header) and the cancellation is
 *  gated where it can be. */
async function watchKeys(page) {
  await page.evaluate(() => {
    window.__ksxKeys = [];
    window.addEventListener("keydown", (event) => {
      window.__ksxKeys.push([event.key, event.defaultPrevented]);
    });
  });
}

const keysSeen = (page) => page.evaluate(() => window.__ksxKeys);

describe("identify by key", () => {
  test("a key pressed while identify is listening is swallowed, and Escape gives it back", async () => {
    const page = await openNocturne();
    try {
      // The precondition the whole complaint rests on: the left pane really is
      // a scroller, and the Identify button really is below its fold. If this
      // stops being true the jump is unreproducible and so is its absence.
      const room = await page.evaluate(() => {
        const left = document.querySelector(".n-left");
        return left.scrollHeight - left.clientHeight;
      });
      assert.ok(
        room > 100,
        `.n-left has only ${room} px of scroll room in this viewport — the jump this ` +
          "test exists to prevent could not happen, so the test would prove nothing",
      );

      const release = await holdIdentify(page);
      await watchKeys(page);
      await page.locator(".n-idform button").click();
      await page.waitForSelector(".n-idbox.listen", { timeout: 5_000 });

      // The four keys measured on the live lane, in the order they were
      // measured. Space was the worst of them at 327 px on its own.
      for (const key of ["ArrowDown", "ArrowDown", "Space", "PageDown"]) {
        await page.keyboard.press(key);
      }
      const guarded = await keysSeen(page);
      assert.equal(guarded.length, 4, `expected four keydowns, saw ${JSON.stringify(guarded)}`);
      for (const [key, prevented] of guarded) {
        assert.ok(
          prevented,
          `${key} kept its default action while identify was listening — nothing swallows ` +
            "it, so the browser scrolls `.n-left` (the page's only scroller, because " +
            "`.nocturne` is `height: 100vh; overflow: hidden`) and carries the Identify " +
            "button and the answer box under it off the top of the pane. `armFocusGuard` " +
            "has always existed; it was called from `startLearn` and nowhere else",
        );
      }

      // Escape hands the keyboard back. It cannot cancel the POST — the
      // learner generation lives inside `identify_and_stage` on the server —
      // so releasing the guard is the honest thing it CAN do, and it is what
      // keeps an eleven-second round trip from feeling like a modal.
      await page.evaluate(() => {
        window.__ksxKeys = [];
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("PageDown");
      const afterEscape = await keysSeen(page);
      assert.deepEqual(
        afterEscape.map(([key]) => key),
        ["Escape", "PageDown"],
      );
      assert.equal(
        afterEscape[1][1],
        false,
        "Escape did not release the key guard — the page stays deaf until the round trip " +
          "ends, which is up to eleven seconds against the real daemon",
      );

      release();
      await page.waitForFunction(
        () => !document.querySelector(".n-idbox")?.classList.contains("listen"),
        null,
        { timeout: 15_000 },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a Space pressed while identify is listening does not press the button under it", async () => {
    // The other half of what the guard is for, and the half headless CAN
    // show. `armFocusGuard`'s own comment names it: "a letter would type into
    // anything focusable and Space would 'click' the button that armed the
    // learn". On this page every device row IS a submit button, so an
    // unguarded Space during identify re-posts `/nocturne/device` — the user's
    // keypress, meant to say WHICH keyboard, silently re-stages one instead.
    // Measured unguarded on this fixture: submits `["/nocturne/device"]`.
    const page = await openNocturne();
    try {
      const release = await holdIdentify(page);
      await page.locator(".n-idform button").click();
      await page.waitForSelector(".n-idbox.listen", { timeout: 5_000 });

      await page.evaluate(() => {
        window.__ksxSubmits = [];
        document.addEventListener(
          "submit",
          (event) => window.__ksxSubmits.push(event.target.getAttribute("action")),
          true,
        );
        document.querySelector(".n-left .n-devform button")?.focus();
      });
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);

      assert.deepEqual(
        await page.evaluate(() => window.__ksxSubmits),
        [],
        "a key pressed during identify activated the focused control — the keypress the " +
          "user meant as an ANSWER became a second verb",
      );

      release();
      await page.waitForFunction(
        () => !document.querySelector(".n-idbox")?.classList.contains("listen"),
        null,
        { timeout: 15_000 },
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the answer names the keyboard that responded, in the box under the button", async () => {
    const page = await openNocturne();
    try {
      // What the source widget's header is already showing — the SERVED
      // `kb_title`. The box must echo this value, not compose its own.
      const servedTitle = (
        await page.locator(".n-widget-kb .n-kick").first().textContent()
      ).trim();
      assert.ok(
        servedTitle.includes(FIXTURE_BOARD),
        `the fixture's staged board is not ${FIXTURE_BOARD}: ${servedTitle}`,
      );

      await page.locator(".n-idform button").click();

      const box = page.locator(".n-idbox.done");
      await box.waitFor({ timeout: 15_000 });

      // 1. It says WHICH keyboard, using the served value verbatim.
      const answer = (await page.locator(".n-idbox.done .n-idtxt").textContent()).trim();
      assert.equal(
        answer,
        servedTitle,
        "the answer box is not showing the served kb_title — a device name composed " +
          "anywhere but the payload can name a keyboard the daemon did not stage",
      );

      // 2. And it reads as an answer, not a bare name. The label is static
      //    markup, so it is in the SSR bytes too.
      assert.equal(
        (await page.locator(".n-idbox.done .n-idlabel").textContent()).trim(),
        "Identified",
      );
      assert.ok(await page.locator(".n-idbox.done .n-idlabel").isVisible());

      // 3. The pulsing dot is gone: this state is settled, not listening.
      assert.equal(await page.locator(".n-idbox.done .n-idot").isVisible(), false);

      // 4. The button beside it is no longer lit — a lit button next to a
      //    settled answer reads as still armed.
      assert.equal(await page.locator(".n-idform button.on").count(), 0);

      // 5. The row in the left pane that IS the answer pulses, with the same
      //    `.locate` animation the bind and key rows use. Found by selector on
      //    purpose: the device lists are `createList`s keyed on `cls`, so the
      //    row that just became `n-dev on` was destroyed and rebuilt by the
      //    poll that named it.
      await page.waitForFunction(
        () => document.querySelector(".n-left .n-devform button.n-dev.on.locate") !== null,
        null,
        { timeout: 5_000 },
      );

      // 6. The flash bar still carries the served sentence — the no-JS
      //    outcome channel is untouched by any of the above, and it is
      //    reported as a success, not a refusal.
      const flash = page.locator(".n-flash");
      assert.equal((await flash.textContent()).trim(), IDENTIFY_OK);
      assert.ok((await flash.getAttribute("class")).includes("n-flash ok"));

      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the answer settles by itself and leaves the box collapsed", async () => {
    const page = await openNocturne();
    try {
      await page.locator(".n-idform button").click();
      await page.locator(".n-idbox.done").waitFor({ timeout: 15_000 });
      // The box is a report, not a second piece of permanent chrome. It holds
      // long enough to read a device name after looking up from the keyboard
      // (IDENTIFY_DONE_MS = 6 s) and then returns the space.
      //
      // Waited for by CLASS, not by visibility: the collapsed state IS
      // `display: none`, so a visibility wait on `.n-idbox.none` can never be
      // satisfied — it resolves the element and then waits forever for a box
      // whose whole point is that it is not there.
      await page.waitForFunction(
        () => document.querySelector(".n-idbox")?.className === "n-idbox none",
        null,
        { timeout: 15_000 },
      );
      assert.equal(await page.locator(".n-idbox.done").count(), 0);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });
});
