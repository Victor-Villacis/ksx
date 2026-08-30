// The redesign macro editor is a client-owned modal. This focused harness
// exercises that module directly so its keyboard contract does not depend on
// the much larger controller fixture or duplicate that suite's setup.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildSync } from "esbuild";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(tmpdir(), `ksx-redesign-macro-a11y-${process.pid}.js`);

let browser;

before(() => {
  buildSync({
    entryPoints: [path.resolve(here, "../src/redesign-macro-editor.ts")],
    bundle: true,
    format: "iife",
    globalName: "MacroTest",
    platform: "browser",
    outfile: bundlePath,
  });
  browser = chromium.launch();
});

after(async () => {
  await (await browser)?.close();
  if (existsSync(bundlePath)) unlinkSync(bundlePath);
});

function row(n) {
  const index = String(n - 1);
  return {
    n: String(n),
    cls: "n-macrow",
    hold: "—",
    hold_cls: "n-machold",
    exp: "empty",
    exp_cls: "n-macexp",
    dur: "50 ms",
    dur_val: "50",
    dur_row: index,
    dur_cls: "n-macdur",
    dur_title: `Step ${n} duration`,
    unit: "ms",
    unit_act: `unit|${index}`,
    unit_title: `Use milliseconds for step ${n}`,
    warn: "",
    warn_cls: "none",
    warn_title: "",
    short: false,
    up_act: `up|${index}`,
    up_cls: "n-macbtn",
    dn_act: `down|${index}`,
    dn_cls: "n-macbtn",
    ia_act: `insert-above|${index}`,
    ib_act: `insert-below|${index}`,
    del_act: `delete|${index}`,
    del_title: `Delete step ${n}`,
  };
}

function view(open = true) {
  const controls = ["A", "B", "X"];
  return {
    back_cls: open ? "nd-back" : "nd-back none",
    open,
    name: "focus-combo",
    slot: "1",
    preset: "Mapper P1",
    head: "2 steps",
    trigger: "Triggered by K",
    note: "Choose the controls held in each step.",
    grid_cls: "n-macroll",
    close_href: "/redesign?slot=1",
    map_href: "/redesign?slot=1",
    motion_line: "",
    policy_line: "",
    ring: "Rows are steps.",
    rule: "One roving cell is in the Tab order.",
    toml: "[macros.focus-combo]",
    turbo_cls: "none",
    turbo_val: "",
    turbo_label: "Auto-fire rate",
    cols: controls.map((id) => ({ id, cls: "n-maccol", title: `${id} control` })),
    groups: [],
    rows: [row(1), row(2)],
    cells: [0, 1].flatMap((step) => controls.map((control, column) => ({
      cell: `${step}|${control}`,
      cls: "n-maccell",
      mark: "",
      on: "false",
      tab: step === 0 && column === 0 ? "0" : "-1",
      title: `step ${step + 1} does not hold ${control}`,
    }))),
    pols: [],
    motions: [],
    table: {
      name: "focus-combo",
      steps: [
        { hold: [], ms: 50, frames: null, allow_short: false },
        { hold: [], ms: 50, frames: null, allow_short: false },
      ],
      on_release: "finish",
      retrigger: "restart",
      interrupt: "allow",
      repeat: "once",
      turbo_hz: null,
      gap_ms: null,
      triggers: ["K"],
      disabled: false,
    },
  };
}

test("the macro modal owns focus and exposes one complete roving grid", async () => {
  const instance = await browser;
  const page = await instance.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route("http://ksx.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html>
      <style>.none{display:none}.nd-back{display:block}.nd-mac{padding:1rem}</style>
      <main id="root">
        <details id="macro-row" open>
          <summary>Macro</summary>
          <a id="opener" href="/redesign?slot=1&macro=focus-combo">Edit steps…</a>
        </details>
        <div class="rd-macdlg nd-back none" data-nx="mac-close">
          <div class="nd nd-mac" data-nx="dlg-noop" role="dialog" aria-modal="true" tabindex="-1"></div>
        </div>
      </main>`,
  }));
  await page.goto("http://ksx.test/redesign");
  await page.addScriptTag({ path: bundlePath });
  await page.evaluate((initial) => {
    window.__macroView = initial;
    window.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/redesign/api/macro/edit")) {
        const next = structuredClone(window.__macroView);
        next.head = "edited";
        next.cells[0].on = "true";
        next.cells[0].mark = "●";
        next.cells[0].cls = "n-maccell on";
        window.__macroView = next;
        return new Response(JSON.stringify({
          ok: true,
          said: "A is held.",
          draft: next.table,
          view: next,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    window.MacroTest.macWire({
      root: () => document.querySelector("#root"),
      refresh: async () => {
        const next = structuredClone(window.__macroView);
        next.head = `${next.head} refreshed`;
        const stillOpen = new URL(window.location.href).searchParams.has("macro");
        next.open = stillOpen;
        next.back_cls = stillOpen ? "nd-back" : "nd-back none";
        window.__macroView = next;
        window.MacroTest.applyRdMacPayload(next);
        return true;
      },
    });
    document.querySelector("#opener").focus();
    history.replaceState(null, "", "/redesign?slot=1&macro=focus-combo");
    window.MacroTest.applyRdMacPayload(initial);
  }, view());

  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-macfocus") === "close-top",
  );
  const semantics = await page.evaluate(() => {
    const dialog = document.querySelector(".nd-mac");
    const grid = dialog.querySelector('[role="grid"]');
    const labelledBy = dialog.getAttribute("aria-labelledby");
    return {
      dialogName: labelledBy ? document.getElementById(labelledBy)?.textContent : null,
      rows: grid.querySelectorAll(':scope > [role="row"]').length,
      cells: grid.querySelectorAll('[role="gridcell"]').length,
      namedCells: Array.from(grid.querySelectorAll('[role="gridcell"]')).every((cell) =>
        Boolean(cell.getAttribute("aria-label")) && Boolean(cell.getAttribute("aria-rowindex")) &&
        Boolean(cell.getAttribute("aria-colindex")) && cell.hasAttribute("aria-selected")
      ),
      rowCount: grid.getAttribute("aria-rowcount"),
      colCount: grid.getAttribute("aria-colcount"),
      roving: grid.querySelectorAll('[role="gridcell"][tabindex="0"]').length,
    };
  });
  assert.deepEqual(semantics, {
    dialogName: "focus-combo",
    rows: 2,
    cells: 6,
    namedCells: true,
    rowCount: "2",
    colCount: "3",
    roving: 1,
  });

  const gridCell = page.locator('[role="gridcell"][tabindex="0"]');
  await gridCell.focus();
  const expectCell = async (cell) => {
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-maccell")),
      cell,
    );
    assert.equal(await page.locator('[role="gridcell"][tabindex="0"]').count(), 1);
  };
  await page.keyboard.press("ArrowRight");
  await expectCell("0|B");
  await page.keyboard.press("End");
  await expectCell("0|X");
  await page.keyboard.press("ArrowDown");
  await expectCell("1|X");
  await page.keyboard.press("Home");
  await expectCell("1|A");
  await page.keyboard.press("ArrowUp");
  await expectCell("0|A");
  await page.keyboard.press("Control+End");
  await expectCell("1|X");
  await page.keyboard.press("Control+Home");
  await expectCell("0|A");
  await page.keyboard.press("ArrowLeft");
  await expectCell("0|A");

  await page.locator('[data-macfocus="close-bottom"]').focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-macfocus")),
    "close-top",
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-macfocus")),
    "close-bottom",
  );

  await gridCell.focus();
  await page.evaluate(() => window.MacroTest.rdMacClick(document.activeElement));
  await page.waitForFunction(
    () => document.querySelector(".n-macdirty")?.textContent === "Unsaved changes" &&
      document.activeElement?.getAttribute("data-maccell") === "0|A",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".rd-macdlg").evaluate((node) => node.classList.contains("none")), false);
  assert.match((await page.locator(".n-macsay-line").textContent()) ?? "", /unsaved changes/);
  await expectCell("0|A");

  await page.locator('[data-macact="save"]').focus();
  await page.evaluate(() => window.MacroTest.rdMacClick(document.activeElement));
  await page.waitForFunction(
    () => document.querySelector(".n-macsay-line")?.textContent?.includes("Saved") &&
      document.activeElement?.getAttribute("data-macact") === "save",
  );

  // Simulate the Inspector repaint replacing and collapsing the original
  // opener. Closing must find the equivalent door, reveal it, and focus it.
  await page.evaluate(() => {
    const old = document.querySelector("#opener");
    const replacement = document.createElement("a");
    replacement.id = "replacement-opener";
    replacement.href = "/redesign?slot=1&macro=focus-combo";
    replacement.textContent = "Edit steps…";
    old.replaceWith(replacement);
    document.querySelector("#macro-row").removeAttribute("open");
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector(".rd-macdlg")?.classList.contains("none") &&
      document.activeElement?.id === "replacement-opener" &&
      document.querySelector("#macro-row")?.hasAttribute("open"),
  );

  // Reopen, make another dirty edit, then take the explicit discard path:
  // the first Escape warns and the second is the modal's cancel.
  await page.evaluate(() => {
    document.querySelector("#replacement-opener").focus();
    history.replaceState(null, "", "/redesign?slot=1&macro=focus-combo");
    const reopened = structuredClone(window.__macroView);
    reopened.open = true;
    reopened.back_cls = "nd-back";
    reopened.head = `${reopened.head} reopened`;
    window.__macroView = reopened;
    window.MacroTest.applyRdMacPayload(reopened);
  });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-macfocus") === "close-top",
  );
  await page.locator('[role="gridcell"][tabindex="0"]').focus();
  await page.evaluate(() => window.MacroTest.rdMacClick(document.activeElement));
  await page.waitForFunction(
    () => document.querySelector(".n-macdirty")?.textContent === "Unsaved changes" &&
      document.activeElement?.hasAttribute("data-maccell"),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".rd-macdlg").evaluate((node) => node.classList.contains("none")), false);
  assert.match((await page.locator(".n-macsay-line").textContent()) ?? "", /unsaved changes/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelector(".rd-macdlg")?.classList.contains("none") &&
      document.activeElement?.id === "replacement-opener",
  );

  await page.close();
});
