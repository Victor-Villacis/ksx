// The macro editor's duration controls, in a real browser.
//
// WHY THIS LEVEL: everything that went wrong here lives in the client island
// and nowhere else — which unit a step was authored in, the 2 s poll that
// re-seeds the draft from the staged setup, and what the row says it holds.
// Rust cannot see any of it (the server only serves the table), and neither
// can a render test. So these drive the real page against a real ksx Studio,
// wired to a fixed staged setup by `cargo run -p ksx-studio --example
// macro_fixture`.
//
// Regression covered here: selecting a step was not treated as an edit, so the
// poll's re-seed treated the draft as untouched and cleared the selection two
// seconds later. With no step selected, the unit control had nothing to
// describe; `macroSetUnit` found nothing to set, and the sync after the poll
// wrote "ms" back over the author's choice just as the pointer arrived.
//
// ── THE REDESIGN CUTOVER ──────────────────────────────────────────────────────
//
// The editor is now a client-owned modal on `/redesign`, opened by the URL
// itself (`?slot=1&macro=<name>`). Redesign deliberately retains the stable
// `n-mac*` control vocabulary, so these tests exercise the current product
// rather than preserving a retired route. Three historical behavior changes
// still explain the assertions below:
//
//  1. PER-STEP SELECTION IS GONE. There is no `sel|N` verb and no "step 1 of
//     3 — 140 ms" line; the duration boxes live on the rows, so there is
//     nothing left for a selection to point at. The test that guarded the
//     selection across the poll is DELETED — its own comment already said the
//     boxes-on-rows fix had made selection non-load-bearing — and the
//     `selectedRow` / `stepLine` assertions elsewhere went with it.
//
//  2. THE TOAST + UNDO SYSTEM IS GONE. The editor answers on ONE `role=status`
//     line (`.n-macsay`, plus `.n-macsay warn` / `.n-macsay err`) fed by
//     `macSay()`, and nothing hands back an 8-second undo closure. Every
//     "…and it says so" assertion is re-pointed at that line — the sentences
//     are still produced, by `macro_draft.rs`, and several changed wording, so
//     they are asserted against what the server actually says today. The test
//     whose ENTIRE subject was an undo closure outliving a macro switch is
//     DELETED: no undo, and only one macro exists to switch to.
//
//  3. THE THREE-BUTTON SHORT-STEP CONFIRMATION IS GONE. `.macconfirm` with
//     "Not yet" / "Save anyway" is now PRESS-SAVE-AGAIN: the first Save says
//     what is short on `.n-macsay warn` and relabels the button "Save it
//     anyway", the second writes. "Not yet" has no button, so that leg is
//     asserted the way the product now offers it — any further edit re-arms
//     the question (`macAct` clears `macAskedShort`), so the next Save asks
//     again instead of writing behind the author's back.
//
// ── ⚠️ THE FIXTURE DATA THIS FILE NO LONGER HAS ────────────────────────────
//
// `macro_fixture.rs`'s `seed_macros()` — `piano` (a step authored in `ms` and
// a step authored in `frames`) and `written-by-hand` (five hand-authored
// holds) — reached the page through `StatusSource::macros()`. NOTHING in
// ksx-studio calls `macros()` any more; `/redesign` reads its macros from the
// STAGED SETUP, which the fixture seeds with exactly one three-step macro,
// `hadouken`:
//
//     1. dpad.down                    ms 50
//     2. dpad.down + dpad.right       ms 50     ← a hand-authored canonical pair
//     3. X                            ms 80
//
// That is enough for almost everything, because step 2 is itself a pair NOBODY
// MADE THROUGH THIS PAGE — it comes out of the fixture's staged setup, which is
// the same round trip a hand-edited preset takes. What it does NOT supply is a
// step authored in `frames`, a PARTIAL deflection (`ly.-16384 + lx.max`), a
// contradictory hold, or the hat+stick double-binding. Three of those four are
// reachable through the grid and are asserted where they are built; the partial
// deflection is not reachable through any door this fixture opens (the
// deferred Settings/Library import flow is not part of this core fixture),
// so the assertion that an INEXACT diagonal is labelled `approx` rather than
// rewritten has NO SUBJECT HERE and has been removed rather than faked. It
// wants either `seed_macros()`'s rows moved into the staged setup or a Rust
// test over `hold_expand` — both outside this file.
//
// WHAT PERSISTS BETWEEN TESTS. Only a Save. Each test opens its own page and
// the draft re-seeds from the stage, so an unsaved edit dies with the page;
// but the fixture keeps what Save wrote, which is what makes "survives a
// reload" testable at all. Four tests below save, and they are ordered so the
// ones that assert an untouched `hadouken` run first. Moving them is not free.
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port, never the 4460 a real `ksx studio` sits on — and never a port
 *  another checkout's fixture might already be sitting on either (the `before`
 *  hook below refuses to run against somebody else's server for exactly that
 *  reason). */
const PORT = Number(process.env.KSX_PWTEST_PORT ?? 4478);
const BASE = `http://127.0.0.1:${PORT}`;
/** redesign.ts's POLL_MS is 2000; anything above it has crossed at least one
 *  poll. The poll is what re-seeds a CLEAN draft from the staged setup, which
 *  is the thing several tests here exist to survive. */
const PAST_ONE_POLL = 2600;

/** The one macro the fixture stages, and the slot it belongs to. The editor is
 *  opened BY URL now — there is no card to expand and no tab to click — so the
 *  vehicle is a query string rather than a gesture. */
const MACRO = "hadouken";
const EDITOR_URL = `${BASE}/redesign?slot=1&macro=${MACRO}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where cargo puts the fixture. Honours `CARGO_TARGET_DIR` — which is the
 *  only way two of these can be worked on at once: Windows holds a running
 *  `macro_fixture.exe` open, so a second suite (or an agent editing the same
 *  checkout) cannot RELINK it while the first one's browser is still attached,
 *  and the failure is a bare `LNK1104: cannot open file`. */
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      // Probe the authoritative redesign document, not a retired route.
      const res = await fetch(`${BASE}/api/redesign`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  // Refuse to test against somebody else's server. A stale fixture — or a real
  // `ksx studio` — answering here would make every assertion below a story
  // about the wrong build.
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  // Build, then run the BINARY — not `cargo run`. A cargo wrapper leaves the
  // real server orphaned when the suite tears down (killing cargo does not
  // kill its child on Windows), and an orphan holding 4474 is then what the
  // NEXT run silently tests against.
  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio macro fixture");
  const exe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(exe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  server.on("exit", (code) => {
    if (code !== null && code !== 0) {
      throw new Error(`the fixture server exited with ${code} — is ${BASE} already in use?`);
    }
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "macro fixture");
  }
});

/** A page with the macro editor OPEN. The dialog is served in the markup and
 *  opened by the `?macro=` in the URL, so there is nothing to click first —
 *  but the ISLAND still has to be live before any of this is real, and on
 *  the Forma island's active marker is the authority for live JavaScript. */
async function openEditor(url = EDITOR_URL) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  // The duration editor is ON THE ROWS — one box per step — so a row's own box
  // is what says the editor is live rather than a panel under the grid.
  await page.waitForSelector(".n-macbar .n-macdur", { state: "visible" });
  return page;
}

async function openWorkbench() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
    null,
    { timeout: 20_000 },
  );
  return page;
}

/** Everything an assertion here cares about, read off the live DOM. */
function editorState(page) {
  return page.evaluate(() => ({
    // per ROW — a duration and its unit belong to the step they time, and
    // there is no "the selected one" any more.
    units: [...document.querySelectorAll(".n-macbar .n-macunit")].map((b) => b.textContent),
    durations: [...document.querySelectorAll(".n-macbar .n-macdur")].map((i) => i.value),
    durClasses: [...document.querySelectorAll(".n-macbar .n-macdur")].map((i) => i.className),
    // The row's own sentence: what it holds, for how long, in which unit, and
    // what the engine will actually run it for. This is what replaced the
    // single "step 1 of 3 — 140 ms" line the panel used to carry.
    durTitles: [...document.querySelectorAll(".n-macbar .n-macdur")].map((i) =>
      i.getAttribute("title"),
    ),
    delTitles: [...document.querySelectorAll(".n-macbar .n-macbtn.del")].map((b) =>
      b.getAttribute("title"),
    ),
    activeClass: document.activeElement?.className ?? "",
    // the plain-language readout on every row — what this step holds.
    holds: [...document.querySelectorAll(".n-macbar .n-machold")].map((h) => h.textContent),
    holdClasses: [...document.querySelectorAll(".n-macbar .n-machold")].map((h) => h.className),
    // THE LEDGER: the pair each diagonal on that row is STORED as.
    expands: [...document.querySelectorAll(".n-macbar .n-macexp")].map((e) => e.textContent),
    expandClasses: [...document.querySelectorAll(".n-macbar .n-macexp")].map((e) => e.className),
    // The editor's ONE answer line — what the toast stack became.
    say: document.querySelector(".n-macsay")?.textContent ?? "",
    sayClass: document.querySelector(".n-macsay")?.className ?? "",
    // "Save this macro" until a short step is questioned; "Save it anyway"
    // while the question stands. The label IS the confirmation state now.
    saveLabel: document.querySelector(".n-macsave")?.textContent ?? "",
    toml: document.querySelector(".n-mactomlbox")?.textContent ?? "",
    warnTitles: [...document.querySelectorAll(".n-macbar .n-macwarn")].map((w) =>
      w.getAttribute("title"),
    ),
    shortRows: document.querySelectorAll(".n-macbar .n-macrow.short").length,
    dirty: document.querySelector(".n-macdirty")?.textContent ?? "",
  }));
}

/** One cell's class + mark + title, by its `data-maccell` payload. The payload
 *  format survived the move byte for byte — `0|diag:dpad:dr` still means step
 *  1's D-pad ↘ column — which is why the diagonal tests port unchanged. */
function cellState(page, cell) {
  return page.evaluate((sel) => {
    const el = document.querySelector(`[data-maccell="${sel}"]`);
    return el === null
      ? null
      : { cls: el.className, mark: el.textContent, title: el.getAttribute("title") };
  }, cell);
}

const settle = (page) => page.waitForTimeout(PAST_ONE_POLL);

/** Row `i`'s own duration box and unit toggle — the whole point of the
 *  boxes-on-rows fix is that these are addressable per row, with nothing
 *  selected first. */
const durBox = (page, i) => page.locator(`.n-macdur[data-macdur="${i}"]`);
const unitBtn = (page, i) => page.locator(`[data-macact="unit|${i}"]`);
const cellAt = (page, cell) => page.locator(`[data-maccell="${cell}"]`);
const saveBtn = (page) => page.locator('[data-macact="save"]');

/** Type a duration and LEAVE THE FIELD, the way a person does, then wait for
 *  the round trip that commits it.
 *
 *  A duration is committed on `change` — i.e. on blur or Enter — and the act
 *  is a POST to `/redesign/api/macro/edit`. Waiting for the draft to actually
 *  carry the number is not politeness: `macSave()` and `macAct()` share one
 *  `macBusy` latch, so a Save pressed while the duration act is still in
 *  flight is DROPPED. That is a real defect, and it has its own test below
 *  ("Save is not swallowed…"); every other test here commits first so that it
 *  is testing its own subject and not that one. */
async function commitDuration(page, i, value) {
  const box = durBox(page, i);
  await box.click();
  await box.fill(String(value));
  await box.blur();
  // Wait on the ROW'S TITLE, not on the box's own value. The value is what the
  // browser typed and is true the instant `fill` returns; the title is
  // composed by `macro_editor.rs` from the draft the server just applied, so
  // it is the only thing on the page that proves the round trip finished.
  // Waiting on the value (or on the dirty mark, which a previous act may have
  // already set) returns early and hands the next gesture a busy latch.
  await page.waitForFunction(
    ({ row, want }) =>
      new RegExp(`for ${want} (ms|fr)\\b`).test(
        document.querySelector(`.n-macdur[data-macdur="${row}"]`)?.getAttribute("title") ?? "",
      ),
    { row: i, want: value },
    { timeout: 10_000 },
  );
}

/** Press Save until it writes, and answer the short-step question if it is
 *  asked. Returns how many presses it took — 1 for an ordinary save, 2 when a
 *  step under the sampling floor had to be consented to. */
async function saveMacro(page, { expectQuestion = null } = {}) {
  await saveBtn(page).click();
  const first = await editorState(page);
  const asked = /\bwarn\b/.test(first.sayClass);
  if (expectQuestion !== null) {
    assert.equal(
      asked,
      expectQuestion,
      expectQuestion
        ? `Save wrote a short step silently: ${JSON.stringify(first.say)}`
        : `an ordinary save asked a question it had no reason to ask: ${JSON.stringify(first.say)}`,
    );
  }
  if (asked) await saveBtn(page).click();
  await page.waitForFunction(
    () => (document.querySelector(".n-macsay")?.textContent ?? "").startsWith("Saved"),
    null,
    { timeout: 15_000 },
  );
  return asked ? 2 : 1;
}

/** Hover the things a pointer actually crosses on the way to a control, ALL of
 *  which re-derive their lists on every poll. The pad and the key legend are
 *  behind the modal now, so the hover targets moved inside the dialog — which
 *  is where the rebuilding lists that could destroy an edit live anyway. */
async function hoverAround(page) {
  await page.locator(".n-macedit .n-bbtn").first().hover();
  await page.locator(".n-macrow").first().hover();
  await page.locator(".n-macmot").first().hover();
}

describe("the macro editor's duration controls", () => {
  test("the authored unit survives a poll, then a hover", async () => {
    const page = await openEditor();
    try {
      // Step 1 is authored in ms in the staged setup — and says so on its own
      // row, before anybody has pointed at that row.
      assert.equal((await editorState(page)).units[0], "ms");

      // The pause that used to be fatal: a poll lands between reaching for the
      // row and touching its unit.
      await settle(page);

      await unitBtn(page, 0).click();
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|0"]')?.textContent === "fr",
      );
      const picked = await editorState(page);
      assert.equal(picked.units[0], "fr", "the unit toggle snapped back on its own");
      // CONVERTED, not reinterpreted: 50 ms is 3 frames, not 50 of them.
      assert.equal(picked.durations[0], "3");
      assert.match(picked.durTitles[0], /3 fr/);
      // …and the length itself is untouched, which is the whole promise of the
      // toggle: the row still says the engine runs it for 50 ms.
      assert.match(picked.durTitles[0], /the engine runs it for 50 ms/);

      // …and now the pointer arrives, which used to reset the unit.
      await hoverAround(page);
      assert.equal((await editorState(page)).units[0], "fr", "a hover reset the unit");

      // …and a poll after that.
      await settle(page);
      const later = await editorState(page);
      assert.equal(later.units[0], "fr", "the poll reset the unit");
      assert.equal(later.durations[0], "3");
    } finally {
      await page.close();
    }
  });

  test("a hover never steals focus or rewrites a duration being typed", async () => {
    const page = await openEditor();
    try {
      // Take step 2 out to frames and back, which leaves it in ms exactly as
      // authored AND leaves the draft dirty — the state in which the poll must
      // keep its hands off. (On `/map` this row arrived authored in frames and
      // one click took it to ms; the staged setup has no frames step to start
      // from, so the round trip does the same job.)
      await unitBtn(page, 1).click();
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|1"]')?.textContent === "fr",
      );
      await unitBtn(page, 1).click();
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|1"]')?.textContent === "ms",
      );
      assert.equal((await editorState(page)).units[1], "ms");

      const box = durBox(page, 1);
      await box.click();
      await box.fill("120");
      assert.match((await editorState(page)).activeClass, /\bn-macdur\b/);

      // Hover the toolbar, a row and a motion button — all of which re-derive
      // their lists, which is what a rebuild under the caret would destroy.
      await hoverAround(page);
      await settle(page);

      const held = await editorState(page);
      assert.match(held.activeClass, /\bn-macdur\b/, "focus was taken mid-edit");
      assert.equal(held.durations[1], "120", "the box was rewritten mid-edit");
      assert.equal(held.units[1], "ms");
    } finally {
      await page.close();
    }
  });

  // ⚠️ SAVES. Step 3 leaves this test authored in frames, and stays that way
  // for the rest of the file — the fixture keeps what Save wrote, which is the
  // only reason "survives a reload" means anything.
  test("the authored unit survives Save and a reload", async () => {
    const page = await openEditor();
    try {
      await unitBtn(page, 2).click(); // step 3, authored in ms
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|2"]')?.textContent === "fr",
      );
      assert.equal((await editorState(page)).units[2], "fr");

      await saveMacro(page, { expectQuestion: false });
      const written = await editorState(page);
      assert.equal(written.units[2], "fr", "the save round trip lost the unit");
      assert.equal(written.dirty, "", "a saved macro still reads as unsaved");
      assert.equal(written.say, `Saved “${MACRO}”.`);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() =>
        document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      );
      await page.waitForSelector(".n-macbar .n-macdur", { state: "visible" });
      // NOTHING is clicked before reading it back: the unit is a fact about
      // the step in the staged setup, and the row states it whether or not
      // anybody has pointed at that row.
      assert.equal(
        (await editorState(page)).units[2],
        "fr",
        "the reloaded macro came back in ms",
      );
    } finally {
      await page.close();
    }
  });

  // ── the select-then-edit MODE is gone ────────────────────────────────────
  // The old select-then-edit mode used one duration field under the grid,
  // pointed at whichever row had last been clicked, so changing a time was a
  // two-part gesture and anything that dropped the selection dropped the edit
  // with it. Now the field is ON the row — and after the cutover there is no
  // selection left at all, so the assertions that watched one are gone too.

  test("a duration is edited without selecting anything first", async () => {
    const page = await openEditor();
    try {
      // This is a page nobody has clicked in yet.
      const fresh = await editorState(page);
      assert.equal(fresh.units[0], "ms", "step 1 is the ms-authored one");
      assert.equal(fresh.dirty, "", "the page opened already dirty");

      // Straight into the first row's box. No ⏱, no row click, no mode.
      await commitDuration(page, 0, 140);

      const after = await editorState(page);
      assert.equal(after.durations[0], "140");
      assert.match(after.toml, /ms = 140/, "the draft did not take the typed duration");
      assert.match(after.dirty, /Unsaved/);
      // The row's own sentence describes the row that was typed in.
      assert.match(after.durTitles[0], /for 140 ms/);
      // The other rows are untouched — the box writes to ITS step, which is
      // what the row index on the element is for.
      assert.deepEqual(
        after.durations.slice(1),
        fresh.durations.slice(1),
        "typing in one row retimed another",
      );

      // And it survives the poll, like every other draft edit.
      await settle(page);
      assert.equal((await editorState(page)).durations[0], "140");
    } finally {
      await page.close();
    }
  });
});

// ── a row can hold several controls, and it SAYS so ────────────────────────
// A sequence with rows ↓ then → then X has no diagonal at all, because a
// diagonal is not a separate input in storage — it IS down+forward held
// together, i.e. ONE ROW HOLDING TWO CONTROLS. The piano roll never taught
// that, and two lit cells twelve columns apart never will. The readout has to
// be LIVE: it is only a teacher if it changes under the finger that is ticking
// the cells.

describe("what a step holds, in words", () => {
  test("the readout updates as cells are toggled", async () => {
    const page = await openEditor();
    try {
      // The fixture's step 1 holds one direction, and says so.
      const start = await editorState(page);
      assert.equal(start.holds[0], "D-pad ↓");
      assert.equal(start.holdClasses[0], "n-machold");

      // Tick a SECOND control into the SAME row. It is a diagonal now, so the
      // row reads as the ONE control a player means by it — and spells out the
      // two names the file will carry, so nothing is hidden.
      await cellAt(page, "0|dpad.right").click();
      await page.waitForFunction(
        () => document.querySelector(".n-macbar .n-machold")?.textContent === "D-pad ↘",
      );
      const chord = await editorState(page);
      assert.equal(chord.holds[0], "D-pad ↘", "the pair did not read as the diagonal");
      assert.equal(
        chord.holdClasses[0],
        "n-machold",
        "a diagonal is ONE presented control, not two",
      );
      assert.equal(chord.expands[0], "↘ = dpad.down + dpad.right");

      // Untick both and the row reads as what it now is: a neutral gap, not a
      // row somebody forgot to fill in.
      await cellAt(page, "0|dpad.right").click();
      await cellAt(page, "0|dpad.down").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".n-macbar .n-machold")?.textContent ===
          "(nothing — neutral gap)",
      );
      const empty = await editorState(page);
      assert.equal(empty.holds[0], "(nothing — neutral gap)");
      assert.equal(empty.holdClasses[0], "n-machold none");

      // And it survives a poll, like every other draft edit.
      await settle(page);
      assert.equal((await editorState(page)).holds[0], "(nothing — neutral gap)");
    } finally {
      await page.close();
    }
  });

  test("a common motion inserts the chord step nobody thinks to write", async () => {
    const page = await openEditor();
    try {
      const before = (await editorState(page)).holds.length;
      await page.locator('[data-macmotion="qcf"]').click();
      await page.waitForFunction(
        (n) => document.querySelectorAll(".n-macbar .n-machold").length === n + 3,
        before,
      );
      const after = await editorState(page);
      assert.equal(after.holds.length, before + 3, "a quarter-circle is three steps");

      // The three appended steps, in order — the middle one is the diagonal.
      const added = after.holds.slice(before);
      assert.deepEqual(added, ["D-pad ↓", "D-pad ↘", "D-pad →"]);
      assert.equal(after.holdClasses[before + 1], "n-machold");
      assert.equal(after.expands[before + 1], "↘ = dpad.down + dpad.right");

      // Generated ABOVE the sampling floor: a helper that seeded steps the
      // sampler cannot see would teach the exact mistake it exists to prevent.
      assert.equal(after.shortRows, 0, "the generated steps are below the floor");
      assert.match(after.dirty, /Unsaved/);
    } finally {
      await page.close();
    }
  });
});

// ── DIAGONALS AS PRESENTATION ──────────────────────────────────────────────
// Players select a diagonal as one concept; storage still represents it as the
// two cardinal directions held together.
//
// Everything below is that promise, in both directions. The STORED model is
// unchanged — a step still holds a set of ordinary bindings — so the two things
// that must be true are: picking ↘ writes the pair, and a pair NOBODY made
// through this page reads back as ↘.

describe("diagonals are a lens over the stored pair", () => {
  test("picking ↘ writes down + right, and says so", async () => {
    const page = await openEditor();
    try {
      // Step 1 holds `dpad.down` only. The ↘ column is a thing you can point
      // at — no mapper in the field offers one.
      const before = await cellState(page, "0|diag:dpad:dr");
      assert.ok(before, "the D-pad ↘ column does not exist");
      assert.doesNotMatch(before.cls, /\bon\b/);
      assert.match(before.title, /does not hold D-pad ↘ \(down-right\)/);

      await cellAt(page, "0|diag:dpad:dr").click();
      await page.waitForFunction(
        () => document.querySelector(".n-macbar .n-machold")?.textContent === "D-pad ↘",
      );

      // THE PAIR IS WHAT IS STORED. Not a new binding shape, not a new verb —
      // the same two ordinary names a hand-edited file would carry, which is
      // why the engine and every old preset are untouched.
      const after = await editorState(page);
      assert.equal(after.holds[0], "D-pad ↘");
      assert.equal(after.expands[0], "↘ = dpad.down + dpad.right");
      assert.match(after.toml, /hold = \["dpad\.down", "dpad\.right"\]/);

      // The cell is lit, and the two cardinals it is made of show as halves —
      // the lens never hides the storage it exists to explain.
      assert.match((await cellState(page, "0|diag:dpad:dr")).cls, /\bon\b/);
      assert.equal((await cellState(page, "0|dpad.down")).cls.includes("part"), true);
      assert.equal((await cellState(page, "0|dpad.right")).mark, "·");

      // It REPORTS — the one click on this grid whose effect is not literally
      // the cell you hit, so the sentence names what was written instead.
      assert.match(
        after.say,
        /ksx wrote dpad\.down \+ dpad\.right/,
        `nothing named what was written: ${JSON.stringify(after.say)}`,
      );
      assert.match(after.say, /because that is what a diagonal is in the file/);
      assert.equal(
        after.sayClass,
        "n-macsay n-macsay-line",
        "a plain report was coloured as a fault",
      );

      // UNticking it removes exactly the two — and says which two, from the
      // hold as written.
      await cellAt(page, "0|diag:dpad:dr").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".n-macbar .n-machold")?.textContent ===
          "(nothing — neutral gap)",
      );
      const cleared = await editorState(page);
      assert.equal(cleared.holds[0], "(nothing — neutral gap)");
      assert.match(cleared.toml, /hold = \[\]/);
      assert.match(cleared.say, /cleared D-pad ↘ — removed dpad\.down \+ dpad\.right/);
    } finally {
      await page.close();
    }
  });

  test("ticking ↓ then → says the two are now a diagonal", async () => {
    // THE FOLD MOMENT — the transition that previously had no report.
    //
    // Picking ↘ is self-explanatory: you clicked ↘, you got ↘, and it reported.
    // Building the same state the way most people will — tick ↓, tick → —
    // used to be SILENT, and it is the surprising one. Four things happen on
    // that second click: the cell just clicked drops to a subordinate `·`
    // instead of a filled mark, a cell twelve columns away lights up, the row's
    // words change from "X + D-pad ↓" to "D-pad ↘ + X", and a ledger line
    // appears. From that, with nothing said, the two available conclusions are
    // "the grid is broken" and "ksx rewrote my input". The truth — their two
    // holds ARE a diagonal, and the file still spells both — is what has to be
    // said.
    const page = await openEditor();
    try {
      // Step 3 holds `X` and nothing else. Add ↓: an ordinary quiet toggle.
      await cellAt(page, "2|dpad.down").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent ===
          "X + D-pad ↓",
      );
      const one = await editorState(page);
      assert.equal(one.holds[2], "X + D-pad ↓");
      assert.equal(one.say, "", "a plain tick spoke");

      // Now →. The two are a diagonal, and the page must SAY so.
      await cellAt(page, "2|dpad.right").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent ===
          "D-pad ↘ + X",
      );
      const two = await editorState(page);
      assert.equal(two.holds[2], "D-pad ↘ + X", "the fold did not happen");
      assert.equal(two.expands[2], "↘ = dpad.down + dpad.right");

      assert.match(two.say, /are D-pad ↘/, `the fold was silent: ${JSON.stringify(two.say)}`);
      assert.match(two.say, /dpad\.down and dpad\.right/, "it did not name the two holds");
      assert.match(
        two.say,
        /the file still spells both/,
        "it did not say the storage is unchanged",
      );
      // The cell that was clicked is now a HALF — which is why this needs
      // saying at all.
      assert.match((await cellState(page, "2|dpad.right")).cls, /\bpart\b/);
      assert.match((await cellState(page, "2|diag:dpad:dr")).cls, /\bon\b/);

      // BREAKING one is reported the same way round, and names what is left.
      await cellAt(page, "2|dpad.right").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent ===
          "X + D-pad ↓",
      );
      const broke = await editorState(page);
      assert.match(
        broke.say,
        /came apart/,
        `breaking a diagonal was silent: ${JSON.stringify(broke.say)}`,
      );
      assert.match(broke.say, /dpad\.down is what is left/);
    } finally {
      await page.close();
    }
  });

  test("a hand-written pair reads back as ↘", async () => {
    // The round trip that matters: step 2 was never made through this page.
    // It comes out of the fixture's staged setup as two ordinary bindings held
    // together — exactly what somebody typing into a preset, or importing one,
    // would leave behind — and the grid still has to show what it IS.
    //
    // ⚠️ The three other hand-written shapes this test used to cover — a
    // PARTIAL deflection (`ly.-16384 + lx.max`), a contradictory hold, and the
    // hat+stick double-binding — lived in `seed_macros()`, which nothing reads
    // any more (see the header). Two of them are reachable through the grid and
    // are asserted in the tests that build them; the partial deflection is not
    // reachable at all from this fixture, and its assertion is gone rather than
    // faked.
    const page = await openEditor();
    try {
      const state = await editorState(page);
      assert.equal(state.holds[1], "D-pad ↘", "the canonical pair did not fold");
      assert.equal(state.expands[1], "↘ = dpad.down + dpad.right");
      assert.equal(state.expandClasses[1], "n-macexp");
      assert.match((await cellState(page, "1|diag:dpad:dr")).cls, /\bon\b/);
      assert.match((await cellState(page, "1|diag:dpad:dr")).title, /holds D-pad ↘ \(down-right\)/);

      // The two cardinals it is spelled with are drawn as halves, and say so.
      for (const half of ["1|dpad.down", "1|dpad.right"]) {
        const cell = await cellState(page, half);
        assert.match(cell.cls, /\bpart\b/, `${half} is not drawn as half of the diagonal`);
        assert.match(cell.title, /as half of ↘ — the ↘ column beside it is the pick/);
      }

      // …and the file is untouched by any of this looking at it.
      assert.equal(state.dirty, "", `reading a macro marked it dirty: ${state.dirty}`);
      assert.match(state.toml, /hold = \["dpad\.down", "dpad\.right"\]/);
    } finally {
      await page.close();
    }
  });

  test("clicking an UNLIT diagonal turns it on, even on a contradictory step", async () => {
    // THE RULE A GRID CANNOT BREAK: a cell that is drawn off turns ON when you
    // click it. Nothing about a piano roll survives that not being true.
    //
    // The trap is that "does this hold contain both halves?" and "does this
    // hold FOLD to that diagonal?" are different questions, and they disagree
    // on exactly one shape — a mechanism holding BOTH polarities of an axis.
    // `↓ + → + ↑` contains down and right, so a contains-both toggle calls the
    // cell already-on and CLEARS; but the cell is drawn off (it must be: which
    // diagonal `↓ + → + ↑` means depends on the slot's socd policy, which this
    // page cannot see). The user gets an empty row, no diagonal, and a sentence
    // naming two holds it did not remove.
    //
    // The old fixture carried that state hand-written. It is also two clicks
    // away from any step, and the test's own reasoning always said so — "tick
    // ←, then tick →, then reach for ↘ to sort the mess out" — so it is built
    // here rather than seeded.
    const page = await openEditor();
    try {
      await cellAt(page, "2|X").click();
      await cellAt(page, "2|dpad.down").click();
      await cellAt(page, "2|dpad.right").click();
      await cellAt(page, "2|dpad.up").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent ===
          "D-pad ↓ + D-pad → + D-pad ↑",
      );

      const before = await editorState(page);
      assert.equal(before.holds[2], "D-pad ↓ + D-pad → + D-pad ↑");
      // No ledger line: there is no diagonal to spell out, so the row must not
      // pretend there is one.
      assert.equal(before.expandClasses[2], "n-macexp none");
      const off = await cellState(page, "2|diag:dpad:dr");
      assert.doesNotMatch(off.cls, /\bon\b/, "the contradictory step lights a diagonal");
      const offUp = await cellState(page, "2|diag:dpad:ur");
      assert.doesNotMatch(offUp.cls, /\bon\b/, "the contradictory step lights a diagonal");

      await cellAt(page, "2|diag:dpad:dr").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent === "D-pad ↘",
      );

      const after = await editorState(page);
      assert.equal(
        after.holds[2],
        "D-pad ↘",
        "clicking an unlit ↘ did not turn it on — the click and the paint disagree",
      );
      assert.equal(after.expands[2], "↘ = dpad.down + dpad.right");
      assert.match((await cellState(page, "2|diag:dpad:dr")).cls, /\bon\b/);
      assert.match(
        after.toml,
        /hold = \["dpad\.down", "dpad\.right"\]/,
        "the pair was not written",
      );

      // And it SAYS what it displaced — the contradiction it resolved, not a
      // pair it left in place.
      assert.match(
        after.say,
        /Replaced dpad\.up on the dpad/,
        `it did not name what it displaced: ${JSON.stringify(after.say)}`,
      );

      // The SECOND click is the untick, and it removes the mechanism's
      // directions — nothing else on the step.
      await cellAt(page, "2|diag:dpad:dr").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][2]?.textContent ===
          "(nothing — neutral gap)",
      );
      assert.equal((await editorState(page)).holds[2], "(nothing — neutral gap)");
    } finally {
      await page.close();
    }
  });

  test("a diagonal + button step still shows both", async () => {
    // The single most common macro step in existence — the attack that ends a
    // motion. Exact-set matching on the whole step would have failed it, which
    // is what settles the whole recognition rule.
    const page = await openEditor();
    try {
      // Step 2 arrives from the staged setup as the bare diagonal. Add the
      // attack to it: the button is a passenger, and the diagonal survives it.
      await cellAt(page, "1|A").click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".n-macbar .n-machold")][1]?.textContent ===
          "D-pad ↘ + A",
      );
      const state = await editorState(page);
      assert.equal(state.holds[1], "D-pad ↘ + A");
      assert.equal(
        state.holdClasses[1],
        "n-machold both",
        "a diagonal AND a button is genuinely two presented controls",
      );
      assert.equal(state.expands[1], "↘ = dpad.down + dpad.right");
      assert.match((await cellState(page, "1|diag:dpad:dr")).cls, /\bon\b/);
      assert.match((await cellState(page, "1|A")).cls, /\bon\b/);
      assert.equal((await cellState(page, "1|A")).mark, "●");

      // The same thing built the other way round: a bare step that becomes a
      // diagonal and then takes a button.
      await cellAt(page, "0|diag:dpad:dr").click();
      await cellAt(page, "0|B").click();
      await page.waitForFunction(
        () => document.querySelector(".n-macbar .n-machold")?.textContent === "D-pad ↘ + B",
      );
      const after = await editorState(page);
      assert.equal(after.holds[0], "D-pad ↘ + B");
      assert.equal(after.expands[0], "↘ = dpad.down + dpad.right");
    } finally {
      await page.close();
    }
  });

  test("all four diagonals are picks, and the up ones deflect UP", async () => {
    // ⚠ THE SIGN. "Up" on a stick is `ly.max`, not `ly.min` — XInput's positive
    // Y is up. A mirrored sign gives an ↖ that looks perfect in every reader on
    // this page and does nothing in the game, so the assertion is on the TOML
    // the file will carry, name by name.
    const page = await openEditor();
    try {
      const want = {
        "diag:dpad:ul": ["dpad.up", "dpad.left"],
        "diag:dpad:ur": ["dpad.up", "dpad.right"],
        "diag:dpad:dl": ["dpad.down", "dpad.left"],
        "diag:dpad:dr": ["dpad.down", "dpad.right"],
        "diag:ls:ul": ["ly.max", "lx.min"],
        "diag:ls:ur": ["ly.max", "lx.max"],
        "diag:ls:dl": ["ly.min", "lx.min"],
        "diag:ls:dr": ["ly.min", "lx.max"],
        "diag:rs:ul": ["ry.max", "rx.min"],
        "diag:rs:ur": ["ry.max", "rx.max"],
        "diag:rs:dl": ["ry.min", "rx.min"],
        "diag:rs:dr": ["ry.min", "rx.max"],
      };
      const glyph = { ul: "↖", ur: "↗", dl: "↙", dr: "↘" };
      const group = { dpad: "D-pad", ls: "LS", rs: "RS" };
      const readsAs = (text) =>
        page.waitForFunction(
          (want) => document.querySelector(".n-macbar .n-machold")?.textContent === want,
          text,
        );

      // Start from a clean row, so each pick is the only thing in it.
      await cellAt(page, "0|dpad.down").click();
      await readsAs("(nothing — neutral gap)");

      for (const [token, pair] of Object.entries(want)) {
        const [, mech, d] = token.split(":");
        await cellAt(page, `0|${token}`).click();
        await readsAs(`${group[mech]} ${glyph[d]}`);
        const on = await editorState(page);
        assert.equal(
          on.holds[0],
          `${group[mech]} ${glyph[d]}`,
          `${token} did not read back as itself`,
        );
        assert.equal(on.expands[0], `${glyph[d]} = ${pair.join(" + ")}`);
        assert.ok(
          on.toml.includes(`hold = ["${pair[0]}", "${pair[1]}"]`),
          `${token} stored the wrong pair — the file says ${on.toml.split("\n")[2]}`,
        );
        // Picking the NEXT diagonal on the same mechanism replaces this one
        // rather than contradicting it; a different mechanism would not, which
        // is why each is unticked before moving on.
        await cellAt(page, `0|${token}`).click();
        await readsAs("(nothing — neutral gap)");
      }
    } finally {
      await page.close();
    }
  });

  test("a 360 walks all eight positions, four of them diagonals", async () => {
    // THE MOTION THE FEATURE IS FOR. A spinning piledriver needs ↘ ↙ ↖ ↗ — if
    // only down-forward were first class, the helper could not write it and the
    // grid could not show it. Every inserted step displaying as its own
    // diagonal is the proof that recognition and expansion agree.
    const page = await openEditor();
    try {
      const before = (await editorState(page)).holds.length;
      await page.locator('[data-macmotion="spdf"]').click();
      await page.waitForFunction(
        (n) => document.querySelectorAll(".n-macbar .n-machold").length === n + 8,
        before,
      );
      const after = await editorState(page);
      assert.equal(after.holds.length, before + 8, "a 360 is eight steps");
      assert.deepEqual(after.holds.slice(before), [
        "D-pad →",
        "D-pad ↘",
        "D-pad ↓",
        "D-pad ↙",
        "D-pad ←",
        "D-pad ↖",
        "D-pad ↑",
        "D-pad ↗",
      ]);
      // Each diagonal step spells the pair it stores — including the two UP
      // ones, which are the sign trap.
      assert.equal(after.expands[before + 1], "↘ = dpad.down + dpad.right");
      assert.equal(after.expands[before + 3], "↙ = dpad.down + dpad.left");
      assert.equal(after.expands[before + 5], "↖ = dpad.up + dpad.left");
      assert.equal(after.expands[before + 7], "↗ = dpad.up + dpad.right");
      assert.equal(after.shortRows, 0, "the generated steps are below the floor");

      // The mirrored facing is the same circle the other way round.
      const page2 = await openEditor();
      try {
        const n = (await editorState(page2)).holds.length;
        await page2.locator('[data-macmotion="spdb"]').click();
        await page2.waitForFunction(
          (want) => document.querySelectorAll(".n-macbar .n-machold").length === want + 8,
          n,
        );
        assert.deepEqual((await editorState(page2)).holds.slice(n), [
          "D-pad ←",
          "D-pad ↙",
          "D-pad ↓",
          "D-pad ↘",
          "D-pad →",
          "D-pad ↗",
          "D-pad ↑",
          "D-pad ↖",
        ]);
      } finally {
        await page2.close();
      }
    } finally {
      await page.close();
    }
  });

  test("the grid is three rings, and the SSR paint already says so", async () => {
    // The mirror: redesign-macro-editor.ts re-derives every list on each poll, so the
    // hydrated grid and the server's first paint have to agree column for
    // column — the same rule the zone tables live under.
    const ssr = await fetch(EDITOR_URL).then((r) => r.text());
    const page = await openEditor();
    try {
      const live = await page.evaluate(() => ({
        columns: [...document.querySelectorAll(".n-maccols .n-maccol")].map((c) => c.textContent),
        // The band label and its count are separate spans now, so the band's
        // NAME is read off the label rather than the whole cell's text.
        bands: [...document.querySelectorAll(".n-macgrps .n-macgrp .n-macgrp-l")].map(
          (g) => g.textContent,
        ),
        spans: [...document.querySelectorAll(".n-macgrps .n-macgrp")].map((g) => g.className),
      }));
      assert.equal(live.columns.length, 37, "25 zones → 37 columns");
      // Ring order — ↑ ↖ ← ↙ ↓ ↘ → ↗ — three times, which is what makes a
      // motion a SHAPE rather than a blob.
      const ring = ["↑", "↖", "←", "↙", "↓", "↘", "→", "↗"];
      assert.deepEqual(live.columns.slice(12, 20), ring, "the left stick's ring");
      assert.deepEqual(live.columns.slice(20, 28), ring, "the d-pad's ring");
      assert.deepEqual(live.columns.slice(29, 37), ring, "the right stick's ring");
      assert.deepEqual(live.bands, [
        "Shoulders & triggers",
        "Face buttons",
        "System",
        "Left stick",
        "D-pad",
        "Right stick",
      ]);
      assert.deepEqual(live.spans, [
        "n-macgrp g4",
        "n-macgrp g4",
        "n-macgrp g3",
        "n-macgrp g9",
        "n-macgrp g8",
        "n-macgrp g9",
      ]);
      // The no-JS page carries the same columns and the ring line that
      // explains them — it cannot tick a cell, but it can still read what a
      // diagonal pick means before JavaScript takes over.
      assert.ok(ssr.includes('data-maccell="0|diag:dpad:dr"'), "SSR has no diagonal column");
      assert.ok(ssr.includes("↑ ↖ ← ↙ ↓ ↘ → ↗ (numpad 8 7 4 1 2 3 6 9)"), "SSR has no ring line");
      assert.ok(ssr.includes("combines down and right in one step"));
    } finally {
      await page.close();
    }
  });
});

// ── a below-floor step cannot be missed ────────────────────────────────────
// The advisory existed and read as decoration, so the 1-frame steps went in
// anyway. It is now on the offending FIELD, on the ROW, and between the click
// and the write — but it never refuses, because a short step is legal.

describe("a step shorter than the sampling floor", () => {
  test("a 1-frame step marks its field and its row, in frames", async () => {
    const page = await openEditor();
    try {
      await unitBtn(page, 0).click();
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|0"]')?.textContent === "fr",
      );
      await commitDuration(page, 0, 1);

      const state = await editorState(page);
      assert.equal(state.durations[0], "1");
      assert.match(state.durClasses[0], /\bshort\b/, "the duration field is not flagged");
      assert.equal(state.shortRows, 1, "the row is not marked");
      // Answered in the unit it was AUTHORED in — not "16 ms", a number this
      // author never typed.
      assert.match(
        state.warnTitles[0],
        /1 frame is shorter than the reliable 2-frame minimum/,
        `the row said: ${JSON.stringify(state.warnTitles[0])}`,
      );
      // …and the row's own sentence says what the engine will really do with
      // it, which is the part an advisory alone never made concrete.
      assert.match(state.durTitles[0], /the engine runs it for 33 ms/);

      // Back above the floor and every mark goes away.
      await commitDuration(page, 0, 3);
      const fixed = await editorState(page);
      assert.equal(fixed.durClasses[0], "n-macdur");
      assert.equal(fixed.shortRows, 0);
      assert.equal(fixed.warnTitles[0], "");
    } finally {
      await page.close();
    }
  });

  // ⚠️ SAVES. Runs BEFORE the test that saves a short step: the fixture keeps
  // what Save wrote (that is what makes "survives a reload" testable at all),
  // so an "ordinary save" case has to be asserted while the macro is still
  // ordinary.
  test("a macro with nothing short saves on the first click", async () => {
    const page = await openEditor();
    try {
      await commitDuration(page, 0, 60); // 50 ms, authored in ms
      assert.equal((await editorState(page)).shortRows, 0);

      const presses = await saveMacro(page, { expectQuestion: false });
      assert.equal(presses, 1, "an ordinary save took more than one press");
      const saved = await editorState(page);
      assert.equal(saved.saveLabel, "Save this macro", "the button stayed in its asking state");
      assert.equal(saved.dirty, "", "a saved macro still reads as unsaved");
    } finally {
      await page.close();
    }
  });

  // ⚠️ SAVES a 1-frame step 1, which every later test inherits.
  test("Save asks before it writes one, and never refuses", async () => {
    const page = await openEditor();
    try {
      await unitBtn(page, 0).click();
      await page.waitForFunction(
        () => document.querySelector('[data-macact="unit|0"]')?.textContent === "fr",
      );
      await commitDuration(page, 0, 1);

      // FIRST press: the question, not the write.
      await saveBtn(page).click();
      await page.waitForFunction(() =>
        (document.querySelector(".n-macsay")?.className ?? "").includes("warn"),
      );
      const asked = await editorState(page);
      assert.match(asked.sayClass, /\bwarn\b/, "Save wrote it silently");
      assert.match(asked.say, /Step 1 is shorter than the 60 Hz floor/);
      assert.match(asked.say, /press Save again to write it\.$/);
      // The button IS the confirmation state now — it must say what the next
      // press will do, or "press Save again" is an instruction to press a
      // button that still claims it merely saves.
      assert.equal(asked.saveLabel, "Save it anyway");
      assert.match(asked.dirty, /Unsaved/, "the draft was written while being asked about");

      // The question survives the 2 s poll — a question that vanishes on its
      // own is the same silent save with extra steps.
      await settle(page);
      const held = await editorState(page);
      assert.match(held.sayClass, /\bwarn\b/, "the poll took the question down");
      assert.equal(held.saveLabel, "Save it anyway");

      // THE "NOT YET" LEG, as this page now offers it. There is no cancel
      // button; instead any further edit RE-ARMS the question (`macAct` clears
      // `macAskedShort`), so the next Save asks again rather than writing
      // behind the author's back — which is the promise the cancel button used
      // to keep. The edit takes the question's sentence down, exactly as
      // pressing "Not yet" used to.
      //
      // ⚠️ The SAVE BUTTON'S LABEL does not come back with it: `macAct` clears
      // the flag but only `macSave` ever rewrites the text, so the button goes
      // on reading "Save it anyway" while the next press will in fact ask
      // again. That is cosmetic — it errs towards asking, never towards a
      // silent write — so it is named here rather than pinned, and the
      // assertion below is on the half that protects the author.
      await cellAt(page, "2|B").click();
      await page.waitForFunction(
        () =>
          (document.querySelector(".n-macsay")?.className ?? "") ===
          "n-macsay n-macsay-line none",
      );
      const rearmed = await editorState(page);
      assert.match(rearmed.dirty, /Unsaved/, "an edit after the question wrote the macro");
      await saveBtn(page).click();
      await page.waitForFunction(() =>
        (document.querySelector(".n-macsay")?.className ?? "").includes("warn"),
      );
      assert.match(
        (await editorState(page)).sayClass,
        /\bwarn\b/,
        "an edit after the question let the next Save write the short step unasked",
      );

      // Answer it: the save goes through exactly as authored.
      await saveBtn(page).click();
      await page.waitForFunction(() =>
        (document.querySelector(".n-macsay")?.textContent ?? "").startsWith("Saved"),
      );
      const saved = await editorState(page);
      assert.equal(saved.say, `Saved “${MACRO}”.`);
      assert.equal(
        saved.sayClass,
        "n-macsay n-macsay-line",
        "a successful save was coloured as a fault",
      );
      assert.equal(saved.saveLabel, "Save this macro", "the question outlived the answer");
      assert.equal(saved.dirty, "");
      // The short step is still short — the save never rewrote it.
      assert.equal(saved.shortRows, 1);
    } finally {
      await page.close();
    }
  });

  test("Save is not swallowed by the duration edit that preceded it", async () => {
    // Historical regression: clicking Save directly from a duration field
    // blurred the input, started its edit request, then let the busy latch
    // silently discard the Save click. The redesign serializes that gesture.
    // The contract here is intentionally user-facing: the press is heard, so
    // the editor either writes the macro or says why it will not.
    const page = await openEditor();
    try {
      const box = durBox(page, 1);
      await box.click();
      await box.fill("70");
      // NO blur, NO wait — straight from the field to the button, which is
      // what a person does and what every other test here deliberately avoids.
      await saveBtn(page).click();
      await page.waitForFunction(
        () =>
          (document.querySelector(".n-macsay")?.className ?? "") !==
          "n-macsay n-macsay-line none",
        null,
        { timeout: 10_000 },
      );
      const after = await editorState(page);
      assert.notEqual(
        after.say,
        "",
        "the Save press was swallowed by the duration edit it followed: the editor " +
          "neither wrote the macro nor said why not",
      );
      assert.equal(after.durations[1], "70", "the duration typed before Save was lost");
    } finally {
      await page.close();
    }
  });
});

// ── the editor cannot be emptied into a dead end ───────────────────────────
// Every add affordance once lived on a row (＋↑ / ＋↓), so the last ✕
// took the last row AND every way to get one back, and the grid became a blank
// box with nothing to click.
//
// The fix is not a nicer empty state, it is an unreachable one: a macro with
// zero steps is REFUSED by the writer (`mapping::save_macro` — empty steps is
// a refusal, not a delete), so the editor must not be able to construct one.
// The ✕ on the last remaining step empties that step instead of removing it —
// a neutral gap, which is a legal, meaningful thing to hold — and the "Add
// step" toolbar above the grid belongs to no row at all.

describe("a macro can never be emptied into a dead end", () => {
  // ⚠️ SAVES a two-step macro, which is what the last test in this file sees.
  test("the last ✕ clears the step instead of deleting it, and Add step grows it back", async () => {
    const page = await openEditor();
    try {
      assert.equal((await editorState(page)).holds.length, 3, "the fixture moved");

      // Two ordinary deletes. Nothing surprising: the row goes.
      await page.locator('[data-macact="del|2"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll(".n-macbar .n-machold").length === 2,
      );
      await page.locator('[data-macact="del|1"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll(".n-macbar .n-machold").length === 1,
      );
      const one = await editorState(page);
      assert.equal(one.holds.length, 1, "the deletes did not land");
      // …and the last remaining ✕ now says what it will really do, so it does
      // not read as a delete that stopped working.
      assert.equal(one.delTitles.length, 1);
      assert.match(one.delTitles[0], /^Clear this step — a macro needs at least one/);

      // THE PRESS THAT USED TO END THE SESSION.
      await page.locator('[data-macact="del|0"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector(".n-macbar .n-machold")?.textContent ===
          "(nothing — neutral gap)",
      );
      const cleared = await editorState(page);
      assert.equal(cleared.holds.length, 1, "the last step was removed — the dead end is back");
      assert.equal(cleared.holds[0], "(nothing — neutral gap)", "the step was not emptied");
      assert.match(cleared.toml, /hold = \[\]/, "the draft is not the empty step it shows");
      assert.match(cleared.say, /it was cleared rather than removed/);

      // …and pressing it again is idempotent, not a way to sneak past it.
      await page.locator('[data-macact="del|0"]').click();
      await page.waitForTimeout(400);
      assert.equal((await editorState(page)).holds.length, 1);

      // The road out: a toolbar button that never depended on a row existing.
      await page.locator('[data-macact="add"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll(".n-macbar .n-machold").length === 2,
      );
      const grown = await editorState(page);
      assert.equal(grown.holds.length, 2, "Add step did not add a step");
      assert.equal(grown.durations[1], "50", "a new step did not arrive at 50 ms");
      assert.equal(grown.units[1], "ms");
      assert.doesNotMatch(
        grown.durClasses[1],
        /\bshort\b/,
        "a new step arrives BELOW the sampling floor",
      );

      // The macro the editor now holds is one the writer will take — which is
      // the whole reason zero steps is unreachable rather than merely ugly.
      // (An earlier case in this file saved a deliberately short step into this
      // fixture, so Save still has its short-step question to ask; the point
      // here is that it ASKS rather than refuses.)
      await cellAt(page, "1|A").click();
      await page.waitForFunction(
        () => [...document.querySelectorAll(".n-macbar .n-machold")][1]?.textContent === "A",
      );
      await saveMacro(page);
      const saved = await editorState(page);
      assert.equal(saved.holds.length, 2);
      assert.equal(saved.say, `Saved “${MACRO}”.`);
      assert.doesNotMatch(saved.sayClass, /\berr\b/, `the save was refused: ${saved.say}`);
    } finally {
      await page.close();
    }
  });
});

// ── the motion buttons speak diagonals ─────────────────────────────────────
// The labels used to spell the pair — "¼ → · ↓ · ↓+→ · →" — because an earlier
// pass wanted them to teach that one row can hold several controls at once.
// First-class diagonals landed since: the grid has a ↘ column, the row readout
// calls it ONE control, and `↓+→` on a button was the last place still calling
// it two. The model is now taught in exactly one place — the row's expansion
// ledger — which every generated step carries.

describe("motion labels speak diagonals, not pairs", () => {
  test("the buttons read as the shape, and the ledger still spells the pair", async () => {
    const page = await openEditor();
    try {
      const labels = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-macmotion]")].map((b) => [
            b.dataset.macmotion,
            { text: b.textContent, title: b.getAttribute("title") },
          ]),
        ),
      );

      // The diagonal glyph, in the position the motion walks through it.
      assert.match(labels.qcf.text, /↓ ↘ →/, `quarter-circle forward: ${labels.qcf.text}`);
      assert.match(labels.qcb.text, /↓ ↙ ←/);
      assert.match(labels.hcf.text, /← ↙ ↓ ↘ →/);
      assert.match(labels.dpf.text, /→ ↓ ↘/, `dragon punch: ${labels.dpf.text}`);
      // The 360 is the whole ring, and it always was.
      assert.match(labels.spdf.text, /→ ↘ ↓ ↙ ← ↖ ↑ ↗/);

      // NOT the pair form, on any of them — label or tooltip.
      for (const [name, { text, title }] of Object.entries(labels)) {
        assert.doesNotMatch(text, /\+/, `${name} still spells a hold pair: ${text}`);
        assert.doesNotMatch(title, /↓\s*\+|\+\s*→|held together/, `${name} tooltip: ${title}`);
      }

      // …and the ONE place that still teaches what a diagonal is stored as is
      // there the moment a motion is used: the row's own ledger.
      const before = (await editorState(page)).holds.length;
      await page.locator('[data-macmotion="qcf"]').click();
      await page.waitForFunction(
        (n) => document.querySelectorAll(".n-macbar .n-machold").length === n + 3,
        before,
      );
      const after = await editorState(page);
      assert.deepEqual(after.holds.slice(before), ["D-pad ↓", "D-pad ↘", "D-pad →"]);
      assert.equal(after.expands[before + 1], "↘ = dpad.down + dpad.right");
      assert.equal(after.expandClasses[before + 1], "n-macexp");
      // The report names the SHAPE and points at that ledger rather than
      // repeating the pair a third time.
      assert.match(
        after.say,
        /spells the pair it stores beside its name/,
        `it did not point at the row ledger: ${JSON.stringify(after.say)}`,
      );
    } finally {
      await page.close();
    }
  });
});

describe("the canvas macro processor", () => {
  test("it opens the exact editor and its accessible placement survives a reload", async () => {
    const page = await openWorkbench();
    const shell =
      '#n-mapping-processors .n-flow-processor-shell[data-flow-macro-id*="hadouken"]';
    const anchor = `${shell} > a.n-flow-processor`;
    const nudgeToggle = `${shell} > .n-flow-processor-nudge-toggle`;
    const nudges = `${shell} > .n-flow-processor-nudges`;
    const automatic = `${shell} > .n-flow-processor-auto`;
    const storageKey = "ksx-redesign-canvas";
    try {
      await page.selectOption('[data-nx="rd-mapping-paths"]', "selected");
      await page.locator(anchor).waitFor({ state: "visible" });
      const processorId = await page.locator(anchor).getAttribute("data-flow-macro-id");
      assert.ok(processorId, "the processor has no stable persistence identity");
      assert.equal(await page.locator(anchor).getAttribute("aria-haspopup"), "dialog");
      const dialogId = await page.locator(anchor).getAttribute("aria-controls");
      assert.equal(dialogId, "n-macro-dialog");
      assert.equal(
        await page.locator(`#${dialogId}`).count(),
        1,
        "the processor's aria-controls target must exist",
      );
      assert.match(
        await page.locator(anchor).getAttribute("href"),
        /^\/redesign\?slot=\d+&macro=hadouken$/,
      );

      await page.locator(anchor).click();
      await page.waitForURL(/\/redesign\?slot=\d+&macro=hadouken$/);
      await page.locator("#n-macro-dialog").waitFor({ state: "visible" });
      await page.waitForFunction(
        () => document.querySelector("#n-macro-dialog")?.contains(document.activeElement),
      );
      assert.equal((await page.locator(".n-macdirty").textContent())?.trim(), "");

      await page.locator(".n-macx").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#n-macro-dialog")?.closest(".nd-back")?.classList.contains("none") &&
          document.activeElement?.matches("a.n-flow-processor"),
      );

      await page.locator(nudgeToggle).click();
      assert.equal(await page.locator(nudgeToggle).getAttribute("aria-expanded"), "true");
      const right = page.locator(`${nudges} [data-flow-nudge-direction="right"]`);
      await right.click();
      await page.waitForFunction(
        ({ shell, storageKey, processorId }) => {
          const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          const offset = saved.processorOffsets?.[processorId];
          return document.querySelector(shell)?.getAttribute("data-flow-placement") === "manual" &&
            Number.isFinite(offset?.x) && Number.isFinite(offset?.y);
        },
        { shell, storageKey, processorId },
      );
      assert.equal(await page.locator(automatic).isVisible(), true);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        ({ shell, storageKey, processorId }) => {
          const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          return document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active" &&
            document.querySelector(shell)?.getAttribute("data-flow-placement") === "manual" &&
            Number.isFinite(saved.processorOffsets?.[processorId]?.x);
        },
        { shell, storageKey, processorId },
        { timeout: 20_000 },
      );

      await page.locator(automatic).click();
      await page.waitForFunction(
        ({ storageKey, processorId }) =>
          JSON.parse(localStorage.getItem(storageKey) ?? "{}").processorOffsets?.[processorId] ===
          undefined,
        { storageKey, processorId },
      );
      assert.equal(await page.locator(shell).getAttribute("data-flow-placement"), "auto");
    } finally {
      await page.close();
    }
  });
});
