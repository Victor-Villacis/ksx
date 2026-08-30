// Browser-level contract for /redesign's page-lived live-feedback client.
// The fixture here is intentionally an in-page EventSource double: these
// tests exercise DOM paint, EventTarget/message semantics, reduced-motion
// media state, and source lifetime without making a 60 Hz server feed the
// timing oracle.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(repoRoot, "studio-ui", "src", "redesign-live.ts");

let browser;
let page;
let bundle;

before(async () => {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "KSXRedesignLive",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setContent(`
    <main id="root">
      <p data-rd-live-status hidden></p>
      <div class="n-canvas">
        <button id="key-g" data-key="G">G</button>
        <button id="key-j" data-key="J">J</button>
        <article data-pad-slot="1">
          <svg><path id="slot-1-a" data-fn="a" /></svg>
        </article>
        <article data-pad-slot="2">
          <svg><path id="slot-2-b" data-fn="b" /></svg>
        </article>
        <button id="selected-control" data-fn="a">Selected A</button>
      </div>
      <output data-rd-live-stats></output>
      <output data-rd-live-ticker></output>
    </main>
  `);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    class FakeEventSource {
      listeners = new Map();
      closeCount = 0;

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type, data) {
        const event = data === undefined
          ? new Event(type)
          : new MessageEvent(type, {
              data: typeof data === "string" ? data : JSON.stringify(data),
            });
        for (const listener of this.listeners.get(type) ?? []) {
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      }

      close() {
        this.closeCount += 1;
      }
    }

    window.ksxSources = [];
    window.ksxAnnouncements = [];
    window.ksxPathCalls = [];
    window.ksxSelectedSlot = 1;
    window.ksxLive = KSXRedesignLive.createRedesignLiveFeedback({
      root: () => document.querySelector("#root"),
      selectedSlot: () => window.ksxSelectedSlot,
      announce: (message) => window.ksxAnnouncements.push(message),
      setPathLive: (keysDown, keyHits, slotDown, slotHits) => {
        const slots = (map) => Object.fromEntries(
          [...map.entries()].map(([slot, values]) => [String(slot), [...values].sort()]),
        );
        window.ksxPathCalls.push({
          keysDown: [...keysDown].sort(),
          keyHits: [...keyHits].sort(),
          slotDown: slots(slotDown),
          slotHits: slots(slotHits),
        });
      },
      eventSource: (url) => {
        const source = new FakeEventSource();
        source.url = url;
        window.ksxSources.push(source);
        return source;
      },
    });
  });
});

function frame({
  running = true,
  slots = [],
  keys = [],
  dropped = 0,
  offPanel = 0,
  unavailable = null,
  revision,
} = {}) {
  return {
    frame: {
      running,
      slots: slots.map((slot) => ({
        slot: slot.slot,
        down: slot.down ?? [],
        hit: slot.hit ?? [],
        lt: 0,
        rt: 0,
        lx: 0,
        ly: 0,
        rx: 0,
        ry: 0,
      })),
      keys: keys.map(([key, down]) => ({ key, down, alias: "panel", device: "fixture" })),
      dropped,
      off_panel: offPanel,
    },
    unavailable,
    ...(revision === undefined ? {} : { revision }),
  };
}

const matchingSession = {
  reachable: true,
  running: true,
  origin: "staged",
  profile: null,
  elapsed: "12s",
  structureRevision: "stage-7",
  runtimeRevision: "stage-7",
};

async function emit(type, data) {
  await page.evaluate(({ type, data }) => {
    window.ksxSources[0].emit(type, data);
  }, { type, data });
}

async function snapshot() {
  return page.evaluate(() => ({
    sources: window.ksxSources.length,
    sourceUrl: window.ksxSources[0]?.url,
    sourceCloseCount: window.ksxSources[0]?.closeCount ?? 0,
    state: document.querySelector("#root")?.dataset.rdLiveState ?? null,
    status: document.querySelector("[data-rd-live-status]")?.textContent ?? "",
    statusHidden: document.querySelector("[data-rd-live-status]")?.hidden ?? true,
    stats: document.querySelector("[data-rd-live-stats]")?.textContent ?? "",
    statsHidden: document.querySelector("[data-rd-live-stats]")?.getAttribute("aria-hidden"),
    ticker: document.querySelector("[data-rd-live-ticker]")?.textContent ?? "",
    tickerHidden: document.querySelector("[data-rd-live-ticker]")?.getAttribute("aria-hidden"),
    keyG: document.querySelector("#key-g")?.classList.contains("live"),
    keyJ: document.querySelector("#key-j")?.classList.contains("live"),
    slot1A: document.querySelector("#slot-1-a")?.classList.contains("live"),
    slot2B: document.querySelector("#slot-2-b")?.classList.contains("live"),
    selectedA: document.querySelector("#selected-control")?.classList.contains("live"),
    canvasLive: document.querySelector(".n-canvas")?.classList.contains("live"),
    announcements: [...window.ksxAnnouncements],
    pathCalls: structuredClone(window.ksxPathCalls),
  }));
}

describe("redesign live feedback", { concurrency: false }, () => {
  test("a matching session waits for proof that the live transport opened", async () => {
    await page.evaluate((session) => {
      // Production applies the structure payload before it opens EventSource.
      window.ksxLive.reconcileSession(session);
    }, matchingSession);
    let view = await snapshot();
    assert.equal(view.sources, 0);
    assert.equal(view.state, "connecting");
    assert.equal(view.status, "Connecting to live input…");
    assert.doesNotMatch(view.status, /connected/i);

    await page.evaluate(() => window.ksxLive.connect());
    view = await snapshot();
    assert.equal(view.sources, 1);
    assert.equal(view.state, "connecting");
    assert.doesNotMatch(view.status, /connected/i);

    await emit("open");
    view = await snapshot();
    assert.equal(view.state, "waiting");
    assert.equal(view.status, "Live input is connected and waiting for activity.");
  });

  test("one EventSource paints only a matching staged session and all three visual layers", async () => {
    await page.evaluate(() => {
      window.ksxLive.connect();
      window.ksxLive.connect();
      window.ksxLive.reconcileSession({
        reachable: true,
        running: true,
        origin: "config",
        structureRevision: "stage-7",
        runtimeRevision: "stage-7",
      });
    });
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    let view = await snapshot();
    assert.equal(view.sources, 1);
    assert.equal(view.sourceUrl, "/api/live");
    assert.equal(view.state, "foreign");
    assert.equal(view.keyG, false);
    assert.equal(view.slot1A, false);

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), {
      ...matchingSession,
      runtimeRevision: "stage-6",
    });
    assert.equal((await snapshot()).state, "stale");

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), matchingSession);
    await emit("frame", frame({
      slots: [
        { slot: 1, down: ["A"], hit: ["A"] },
        { slot: 2, down: ["B"], hit: [] },
      ],
      keys: [["G", true]],
    }));
    view = await snapshot();
    assert.equal(view.state, "active");
    assert.equal(view.status, "Live input is active.");
    assert.equal(view.statusHidden, false);
    assert.equal(view.keyG, true);
    assert.equal(view.slot1A, true);
    assert.equal(view.slot2B, true);
    assert.equal(view.selectedA, true);
    assert.equal(view.canvasLive, true);
    assert.match(view.stats, /^Live · 12s · 1 event · 60 Hz$/);
    assert.equal(view.ticker, "G↓");
    assert.equal(view.statsHidden, "true");
    assert.equal(view.tickerHidden, "true");
    assert.deepEqual(view.pathCalls.at(-1), {
      keysDown: ["G"],
      keyHits: ["G"],
      slotDown: { 1: ["a"], 2: ["b"] },
      slotHits: { 1: ["a"], 2: [] },
    });
    assert.equal(view.announcements.filter((line) => line === "Live input is active.").length, 1);

    // Frame-rate updates never become screen-reader chatter.
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: [] }],
      keys: [],
    }));
    view = await snapshot();
    assert.equal(view.announcements.filter((line) => line === "Live input is active.").length, 1);
  });

  test("transport setup preserves a pre-reconciled authority decision", async () => {
    await page.evaluate(() => {
      window.ksxLive.reconcileSession({
        reachable: true,
        running: true,
        origin: "config",
        structureRevision: "stage-7",
        runtimeRevision: "stage-7",
      });
      window.ksxLive.connect();
    });
    await emit("open");
    let view = await snapshot();
    assert.equal(view.state, "foreign");
    assert.match(view.status, /different setup/i);

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), {
      ...matchingSession,
      runtimeRevision: "stage-6",
    });
    await emit("open");
    view = await snapshot();
    assert.equal(view.state, "stale");
    assert.match(view.status, /Apply the current staged changes/i);

    // LiveEnvelope's unavailable reason is authoritative even when its empty
    // frame is also marked idle; transport failure must not be flattened to
    // the ordinary stopped-session copy.
    await page.evaluate((session) => window.ksxLive.reconcileSession(session), matchingSession);
    await emit("frame", frame({
      running: false,
      unavailable: "control channel \\.\\pipe\\ksx-secret is unavailable",
    }));
    view = await snapshot();
    assert.equal(view.state, "offline");
    assert.equal(view.status, "Live input is offline. Reopen ksx and try again.");
  });

  test("a dropped transition clears stale keys and paths while retaining authoritative controller state", async () => {
    await page.evaluate((session) => {
      window.ksxLive.connect();
      window.ksxLive.reconcileSession(session);
    }, matchingSession);
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: [] }],
      keys: [["J", true]],
      dropped: 1,
      offPanel: 2,
    }));
    const view = await snapshot();
    assert.equal(view.state, "degraded");
    assert.equal(view.keyG, false, "a missed release must not leave the old key held");
    assert.equal(view.keyJ, true);
    assert.equal(view.slot1A, true, "controller down is an authoritative snapshot");
    assert.deepEqual(view.pathCalls.at(-1).keysDown, ["J"]);
    assert.deepEqual(view.pathCalls.at(-1).keyHits, ["J"]);
    assert.match(view.stats, /1 frame dropped/);
    assert.match(view.stats, /2 off-panel/);
    assert.equal(
      view.announcements.at(-1),
      "Live feedback has a gap. Repeat the input before relying on this trace.",
    );
    // The module authors no motion. Existing stylesheet pulses are disabled
    // by its prefers-reduced-motion rule; counters/ticker remain aria-hidden.
    assert.equal(
      await page.locator("#key-j").evaluate((element) => element.style.animation),
      "",
    );
  });

  test("an undisclosed running revision fails closed until a lifecycle action confirms it", async () => {
    const first = {
      ...matchingSession,
      structureRevision: "stage-1",
      runtimeRevision: null,
    };
    await page.evaluate((session) => {
      window.ksxLive.connect();
      window.ksxLive.reconcileSession(session);
    }, first);
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    let view = await snapshot();
    assert.equal(view.state, "stale");
    assert.equal(view.keyG, false, "a reload cannot infer which draft Play is using");
    assert.match(view.status, /cannot verify which draft Play is using.*Replace session/i);

    // The lifecycle shell calls this only after Play/Replace session
    // succeeded and the refreshed payload disclosed stage-1 as current.
    await page.evaluate(() => window.ksxLive.acceptCurrentRevision());
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    view = await snapshot();
    assert.equal(view.state, "active");
    assert.equal(view.keyG, true);

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), {
      ...first,
      structureRevision: "stage-2",
    });
    view = await snapshot();
    assert.equal(view.state, "stale");
    assert.equal(view.keyG, false);
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    assert.equal((await snapshot()).keyG, false, "a new draft cannot animate the old session");

    // The lifecycle shell calls this only after Apply succeeded and the
    // refreshed payload disclosed stage-2 as the current structure.
    await page.evaluate(() => window.ksxLive.acceptCurrentRevision());
    await emit("frame", frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    }));
    view = await snapshot();
    assert.equal(view.state, "active");
    assert.equal(view.keyG, true);
  });

  test("stop, malformed, revision mismatch, and disconnect all revoke paint until a fresh payload", async () => {
    await page.evaluate((session) => {
      window.ksxLive.connect();
      window.ksxLive.reconcileSession(session);
    }, matchingSession);
    const lit = frame({
      slots: [{ slot: 1, down: ["a"], hit: ["a"] }],
      keys: [["G", true]],
    });
    await emit("frame", lit);
    assert.equal((await snapshot()).keyG, true);

    await emit("frame", frame({ running: false }));
    let view = await snapshot();
    assert.equal(view.state, "inactive");
    assert.equal(view.keyG, false);
    assert.equal(view.canvasLive, false);
    assert.deepEqual(view.pathCalls.at(-1).keysDown, []);

    // A running frame after the stop cannot self-license.
    await emit("frame", lit);
    assert.equal((await snapshot()).keyG, false);
    await page.evaluate((session) => window.ksxLive.reconcileSession(session), matchingSession);
    await emit("frame", lit);
    assert.equal((await snapshot()).keyG, true);

    await emit("frame", { not: "an envelope" });
    view = await snapshot();
    assert.equal(view.state, "unreadable");
    assert.equal(view.keyG, false);

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), matchingSession);
    await emit("frame", frame({ ...lit, revision: "another-stage" }));
    view = await snapshot();
    assert.equal(view.state, "stale");
    assert.equal(view.keyG, false);

    await page.evaluate((session) => window.ksxLive.reconcileSession(session), matchingSession);
    await emit("frame", lit);
    await emit("error");
    view = await snapshot();
    assert.equal(view.state, "reconnecting");
    assert.equal(view.status, "Reconnecting to live input…");
    assert.equal(view.keyG, false);
    await emit("frame", lit);
    assert.equal((await snapshot()).keyG, false, "reconnect must wait for structure truth");
  });

  test("unavailable copy is customer-safe, target caches can be retired, and dispose closes the source", async () => {
    await page.evaluate((session) => {
      window.ksxLive.connect();
      window.ksxLive.reconcileSession(session);
    }, matchingSession);
    await emit("unavailable", {
      message: "control channel \\\\.\\pipe\\ksx-secret at C:\\private\\runner",
      remedy: "run a private command",
    });
    let view = await snapshot();
    assert.equal(view.state, "offline");
    assert.equal(view.status, "Live input is offline. Reopen ksx and try again.");
    assert.doesNotMatch(view.status, /pipe|private|command/i);

    await page.evaluate((session) => {
      window.ksxLive.reconcileSession(session);
      const replacement = document.createElement("button");
      replacement.id = "late-key";
      replacement.dataset.key = "L";
      document.querySelector(".n-canvas").append(replacement);
      window.ksxLive.invalidateTargets();
    }, matchingSession);
    await emit("frame", frame({ keys: [["L", true]] }));
    assert.equal(
      await page.locator("#late-key").evaluate((element) => element.classList.contains("live")),
      true,
    );

    // The page-lived source closes at its actual browser lifetime boundary;
    // an explicit later dispose remains idempotent.
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      window.ksxLive.dispose();
    });
    view = await snapshot();
    assert.equal(view.sourceCloseCount, 1);
    assert.equal(view.state, null);
    assert.equal(view.canvasLive, false);
    assert.deepEqual(view.pathCalls.at(-1).keysDown, []);
  });

  test("a no-session refusal stays inactive through EventSource retry while daemon failure stays offline", async () => {
    await page.evaluate(() => {
      window.ksxLive.reconcileSession({
        reachable: true,
        running: false,
        origin: "unknown",
      });
      window.ksxLive.connect();
    });
    await emit("unavailable", {
      message: "nothing is running; press Play to start live input",
    });
    let view = await snapshot();
    assert.equal(view.state, "inactive");
    assert.equal(view.status, "Live input starts after you press Play.");

    // Browsers raise `error` after a server-sent refusal closes the response.
    // That transport epilogue must not relabel an ordinary stopped session as
    // reconnecting or alternate the customer copy on every retry.
    await emit("error");
    view = await snapshot();
    assert.equal(view.state, "inactive");
    assert.equal(view.status, "Live input starts after you press Play.");

    await emit("unavailable", {
      message: "no daemon control channel is available",
    });
    view = await snapshot();
    assert.equal(view.state, "offline");
    assert.equal(view.status, "Live input is offline. Reopen ksx and try again.");
  });
});
