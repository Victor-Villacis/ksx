// Does the SSR FIRST PAINT match what the client shows after hydration?
//
// WHY THIS EXISTS. ksx Studio emits the same data twice — slots for the
// server-rendered paint, the `__ksx-payload` block for the client — and the
// two are produced by two different derivations in two different languages:
// `render_nocturne.rs`/`render.rs` on the server, `NocturneIsland.ts` on the
// client (and the same pairing again for `/check`, `/pads` and `/devices`).
// Nothing in either toolchain checks that they agree. When they disagree the
// page paints one thing and replaces it milliseconds later: a flash, in
// production, that no unit test on either side can see.
//
// It is not hypothetical. This suite's first run (2026-08-06) found the mapper
// telling a user with a running session to "Use the Pause button above" after
// hydration where the server had said 'Use "Pause emulation & map" above' —
// the second is the button's real label, so the client was both stale AND
// naming a control that does not exist. Only the RUNNING state shows it, which
// is why the fixture learned to be running (`KSX_FIXTURE_SESSION`).
//
// It is also the standing guard on ledger #4: show slots carry real SSR
// defaults now, so a compiler bump that changed which branch renders
// server-side would show up here as a whole panel appearing or disappearing.
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { stopFixtureProcess } from "./fixture-process.mjs";

/** Our own range — never 4460 (a real `ksx studio`) or 4478 (the macro
 *  suite). The files still run serially because they share one
 *  `macro_fixture.exe`, which Windows will not relink while it is running. */
const FIRST_PORT = Number(process.env.KSX_PWTEST_PARITY_PORT ?? 4488);

/** ONE PORT PER SESSION STATE, and here is why that matters.
 *
 *  These suites used to share `PORT`. `after()` calls `server.kill()`, which
 *  returns as soon as the signal is sent — the listening socket is still
 *  bound when the next suite's `before()` spawns its fixture a moment later.
 *  That fixture prints "failed to bind 127.0.0.1:4477" and exits… into
 *  `stdio: "ignore"`, so nobody ever saw it. The `before()` hook then spun
 *  for its full 60 s and failed with "fixture never answered", which names
 *  the symptom and hides the cause.
 *
 *  The effect was not flakiness, it was a DETERMINISTIC HOLE: `idle` (first)
 *  passed, `running` (second) always failed, and `down` (third) passed again
 *  because 60 s had elapsed by then and the port was free. So the state this
 *  file's own header calls out — "Only the RUNNING state shows it, which is
 *  why the fixture learned to be running" — was the one state never actually
 *  checked, on every run since it was added.
 *
 *  A port per state removes the reuse entirely. Teardown still waits for the
 *  process exit so the next FILE cannot race its executable handle. */
const portFor = (session) => FIRST_PORT + SESSIONS.indexOf(session);
const baseFor = (session) => `http://127.0.0.1:${portFor(session)}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");
const exe = path.join(
  targetDir,
  "debug",
  "examples",
  process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
);

/** Every server-rendered route, plus the canvas's alternate slot view.
 *  `/nocturne` includes the scalar capture preparation branch, whose hidden
 *  exact-target values must survive adoption without a first-paint swap. */
const ROUTES = [
  "/nocturne",
  "/nocturne?slot=1&macro=hadouken",
  "/check",
  "/pads",
  "/devices",
  "/redesign",
];

/** The session states the show pairs actually move between. `modal open` is
 *  deliberately absent: every modal show (`show:modalOpen` and its three inner
 *  states) is injected `false` unconditionally, so the modal CANNOT be part of
 *  a first paint and has no SSR side to disagree with. */
const SESSIONS = ["idle", "running", "down"];

let browser;

/** The island subtree, normalized for the differences that are BY DESIGN.
 *  Each removal is a decision, not a convenience — anything left over is a
 *  real disagreement between the server's paint and the client's. */
const SNAPSHOT = `(() => {
  const root = document.querySelector("[data-forma-island]");
  if (!root) return "NO ISLAND ROOT";
  const clone = root.cloneNode(true);
  // 1. The runtime's own lifecycle marker: "pending" before hydration,
  //    "active" after. It IS the thing that changed; it is not content.
  clone.removeAttribute("data-forma-status");
  // 2. Native island props (ledger #8): an HTML-escaped duplicate of the
  //    markup, emitted only server-side. Not content either.
  clone.removeAttribute("data-forma-props");
  clone.querySelectorAll("[data-forma-props]").forEach((el) => el.removeAttribute("data-forma-props"));
  // 3. The client's own "JavaScript is live" marker class — the whole point of
  //    which is to differ.
  clone.classList.remove("js");
  clone.querySelectorAll(".js").forEach((el) => el.classList.remove("js"));
  // 3b. CONNECTION CHATTER, by contract. A node marked data-live-chatter
  //    carries the live feed's own connection state ("connecting…",
  //    "reconnecting…", "live") — a value the server can never know, because
  //    the stream is opened by the browser after adoption. The MARKER is the
  //    decision: only nodes that declare themselves chatter are exempt, their
  //    presence still compares, and any un-marked sentence that flashes still
  //    fails. Durable state goes through separate announcers and show pairs,
  //    which stay fully asserted.
  clone.querySelectorAll("[data-live-chatter]").forEach((el) => { el.textContent = ""; });
  // 3c. RETIRED (was CLIENT FIT, data-client-fit: the old stage's
  //    zoom-to-fit style exemption). The canvas replaced fit-scaling with
  //    real camera geometry — nothing emits the marker any more, and a
  //    normalization no node can trigger is a hole waiting for a tenant.
  //    3d is the successor. Letters stay stable; do not reuse 3c.
  // 3d. CLIENT CANVAS, by contract. A node marked data-client-canvas is
  //    managed by the workspace canvas engine after adoption (the vendored
  //    genui runtime): camera and widget geometry ride its STYLE attribute,
  //    and the engine annotates its own state through five data- namespaces
  //    (data-canvas-* geometry mirrors; data-widget-* navigation, chrome
  //    dock and focus mode; data-attention-*, data-runtime-* and
  //    data-virtualization-* visibility ranking). The selected input device's
  //    reconciled role is likewise annotated as data-input-kind after mount;
  //    the served shell is intentionally the protocol-neutral Input source.
  //    These are all browser-side facts the server can never know. Exactly
  //    those channels are exempt ON THE
  //    MARKED NODE ITSELF — stripped from BOTH captures, so the served
  //    identity attrs that share a prefix (data-widget-name) vanish equally
  //    rather than escaping the compare. Everything else on the node
  //    (data-instance-id, class, role, aria-*, tabindex), its whole content
  //    subtree (the keyboard widget's served rows above all) and every
  //    unmarked node still compare byte-for-byte.
  clone.querySelectorAll("[data-client-canvas]").forEach((el) => {
    el.removeAttribute("style");
    for (const attr of Array.from(el.attributes)) {
      if (
        attr.name === "data-input-kind" ||
        /^data-(canvas-|widget-|attention-|runtime-|virtualization-)/.test(attr.name)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  });
  // 3e. CLIENT WIDGETS, by contract. Elements marked data-client-widget are
  //    canvas widgets the island BUILDS from the payload roster after
  //    adoption (the controller cards — the old pad grid's clones, made
  //    contractual): their SSR absence is the point, exactly like the grid
  //    they replace, so they are removed before comparing. The keyboard
  //    widget deliberately carries NO such marker — it is served markup the
  //    engine adopts, and its content stays fully asserted.
  clone.querySelectorAll("[data-client-widget]").forEach((el) => el.remove());
  // 3f. CLIENT-POPULATED SUBTREE, by contract. A node marked
  //    data-client-subtree is a served, asserted CONTAINER whose CHILDREN
  //    the client fills from live state (the canvas map's one marker per
  //    mounted widget). Its children — and only its children — are dropped
  //    before comparing: the container itself, its attributes and its
  //    position among its siblings still compare byte-for-byte, so deleting
  //    the map or renaming it still fails. Deliberately NOT the same rule as
  //    3e: those nodes are absent server-side by contract, while this one
  //    must be SERVED and empty.
  clone.querySelectorAll("[data-client-subtree]").forEach((el) => {
    el.replaceChildren();
  });
  let html = clone.outerHTML;
  // 4. forma-ir's U+200B placeholders, which hold the position of an empty
  //    dynamic text slot server-side.
  html = html.replace(/\\u200B/g, "");
  // 5. SSR reconcile markers (<!--f:...-->), the walker's own bookkeeping.
  html = html.replace(/<!--[^>]*?-->/g, "");
  // 6. An EMPTY value attribute the client writes into the form controls it
  //    owns. Empty only — a value the two sides disagree ABOUT still fails.
  html = html.replace(/ value=""/g, "");
  // 7. <noscript> SUBTREES. With scripting enabled the parser stores noscript
  //    content as raw TEXT, so the SSR serialization shows escaped markup —
  //    but adoption rebuilds the island through the DOM API, which bypasses
  //    the parser and gives noscript real ELEMENT children. Both serialize
  //    differently while neither can ever paint (scripting is on in both
  //    captures by definition), so the difference is unobservable and
  //    by-design. Emptying the wrapper keeps its PRESENCE asserted — a page
  //    that dropped its noscript block entirely still fails.
  html = html.replace(/<noscript[^>]*>[\\s\\S]*?<\\/noscript>/g, "<noscript></noscript>");
  return html;
})()`;

/** The page as the server painted it: the app bundle is blocked, so the
 *  island never hydrates. (Blocking the request beats `javaScriptEnabled:
 *  false`, which would also disable `evaluate`.) */
async function ssrDom(url) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  await ctx.route("**/_assets/*.js", (route) => route.abort());
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // 3e removes [data-client-widget] from BOTH captures, so a server that
    // wrongly SERVED one would sail through the compare. Their SSR absence
    // is the contract — assert it on the raw document, before normalizing.
    const servedClientWidgets = await page.evaluate(
      () => document.querySelectorAll("[data-client-widget]").length,
    );
    assert.equal(
      servedClientWidgets,
      0,
      `${url} SERVED ${servedClientWidgets} data-client-widget node(s) — ` +
        "client-built widgets must not exist in SSR markup (parity rule 3e)",
    );
    return await page.evaluate(SNAPSHOT);
  } finally {
    await ctx.close();
  }
}

/** The same page after the island has adopted it and seeded from the payload. */
async function hydratedDom(url) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      null,
      { timeout: 20_000 },
    );
    // The canvas adopts in the island's post-mount frame and then opens on
    // an animated fitAll. Capturing in either window would compare a
    // half-annotated page against a settled one, and `is-camera-animating`
    // is a CLASS, which no exemption covers. Note the adoption wait cannot
    // be a plain delay: it is not a fixed distance behind hydration. Both
    // waits pass instantly on the routes that have no canvas.
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".n-canvas");
        if (!canvas) return true;
        const kb = canvas.querySelector('[data-instance-id="keyboard"]');
        if (kb) return kb.dataset.canvasX !== undefined;
        // A WIDGET-LESS canvas (the redesign lane): the engine's first
        // camera render writes the stage's inline transform — the served
        // stage carries no style attribute, so that write is the
        // engine's own alive mark.
        const stage = canvas.querySelector(".forma-canvas-stage");
        return Boolean(stage && stage.style.transform);
      },
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => !document.querySelector(".is-camera-animating"),
      null,
      { timeout: 20_000 },
    );
    // One frame past adoption, before the 2 s poller could rewrite anything:
    // the flash this suite hunts happens in that window.
    await page.waitForTimeout(300);
    return await page.evaluate(SNAPSHOT);
  } finally {
    await ctx.close();
  }
}

/** Point at the first difference in words rather than in 190 000 characters. */
function firstDifference(a, b) {
  const at = a.split(/(?=<)/);
  const bt = b.split(/(?=<)/);
  for (let i = 0; i < Math.max(at.length, bt.length); i++) {
    if (at[i] !== bt[i]) {
      return `node #${i} of ${at.length}\n  SSR      : ${JSON.stringify((at[i] ?? "<missing>").slice(0, 400))}\n  HYDRATED : ${JSON.stringify((bt[i] ?? "<missing>").slice(0, 400))}`;
    }
  }
  return "(lengths differ with no differing node — check trailing content)";
}

before(async () => {
  // Guard every port a suite will actually bind, not the base one that no
  // suite uses any more — a squatter check that watches the wrong door is
  // how the bind failure below became invisible in the first place.
  for (const session of SESSIONS) {
    const url = baseFor(session);
    const squatter = await fetch(`${url}/api/nocturne`).then(
      () => true,
      () => false,
    );
    assert.equal(
      squatter,
      false,
      `something is already listening on ${url} (session "${session}") — stop it first`,
    );
  }
  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio macro fixture");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

for (const session of SESSIONS) {
  describe(`SSR and hydration agree — session: ${session}`, () => {
    let server;

    const base = baseFor(session);

    before(async () => {
      // stderr is CAPTURED, not ignored: the one thing this fixture says when
      // it cannot start is the one thing worth knowing, and swallowing it is
      // what turned a bind collision into a 60 s mystery.
      let stderr = "";
      server = spawn(exe, [String(portFor(session))], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, KSX_FIXTURE_SESSION: session },
      });
      server.stderr?.on("data", (b) => (stderr += b.toString()));
      let exited = null;
      server.on("exit", (code) => (exited = code));

      const until = Date.now() + 60_000;
      for (;;) {
        const up = await fetch(`${base}/api/nocturne`).then(
          (r) => r.ok,
          () => false,
        );
        if (up) break;
        assert.equal(
          exited,
          null,
          `the fixture for session "${session}" exited with code ${exited} instead of ` +
            `serving ${base}:\n${stderr.trim() || "(it said nothing)"}`,
        );
        assert.ok(
          Date.now() < until,
          `fixture never answered on ${base}\n${stderr.trim() || "(it said nothing)"}`,
        );
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    after(async () => {
      await stopFixtureProcess(server, `parity fixture (${session})`);
    });

    for (const route of ROUTES) {
      test(`${route} paints what the client renders`, async () => {
        const url = base + route;
        const ssr = await ssrDom(url);
        const hydrated = await hydratedDom(url);
        assert.notEqual(ssr, "NO ISLAND ROOT", `${route} rendered no island root`);
        assert.equal(
          ssr,
          hydrated,
          `${route} (session ${session}) flashes: the server paints one thing and the ` +
            `client replaces it on adoption. Whichever side is wrong, the two ` +
            `derivations for this route have drifted.\n${firstDifference(ssr, hydrated)}`,
        );
      });
    }
  });
}
