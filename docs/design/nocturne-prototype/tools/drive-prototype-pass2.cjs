const { chromium } = require("playwright");
const fs = require("fs");
const SHOTS = "C:/Projects/KeyboardSplitterXboxPro/docs/design/nocturne-prototype/shots";
const SRC =
  "file:///C:/Users/Victor/.claude/projects/C--Users-Victor/874d2022-a3ed-400d-99b4-7bae35a8c69c/tool-results/artifact-58371700-1786930482-84d4.html";
const journal = [];
let n = 29;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
  page.setDefaultTimeout(4000);
  async function shot(name, note) {
    n += 1;
    const file = `${String(n).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: `${SHOTS}/${file}` });
    journal.push({ n, name, note, file });
    console.log(`[${n}] ${name} — ${note}`);
  }
  async function clickText(text, note) {
    try {
      await page.locator(`text=${text}`).first().click();
      await page.waitForTimeout(450);
      return true;
    } catch { console.log(`MISS: ${note} ("${text}")`); return false; }
  }

  await page.goto(SRC, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // Create P2 as Numpad player (so cross-player conflict is possible)
  await clickText("P2 empty slot", "open create dialog");
  await clickText("PlayStation — DualShock 4", "persona ps");
  await clickText("Numpad player", "starting bindings numpad");
  await clickText("Create controller", "create");
  await page.waitForTimeout(500);

  // back to P1
  await clickText("P1", "select P1");

  // ── Cross-player conflict: assign Left stick Down, press a key P2 owns ──
  {
    const assigns = page.locator("text=Assign");
    try {
      await assigns.first().click(); // Left stick — Up is bound? first Assign = Left stick Down likely
      await page.waitForTimeout(300);
      await page.keyboard.press("Numpad4");
      await page.waitForTimeout(600);
      await shot("conflict-cross-player", "Pressed Numpad4 (P2's key) while assigning on P1 — cross-player conflict presentation");
      // try the resolutions
      const b = (await clickText("Keep both", "keep both")) || (await clickText("Move here", "move here")) || (await clickText("Swap", "swap"));
      await page.waitForTimeout(400);
      if (b) await shot("conflict-cross-resolved", "Cross-player conflict resolved");
      else { await page.keyboard.press("Escape"); }
    } catch { console.log("MISS cross conflict"); }
  }

  // ── Macro editor via Steps… ──
  await clickText("Left stick — Left", "expand row");
  if (await clickText("Steps...", "open steps") || await clickText("Steps…", "open steps ellipsis")) {
    await page.waitForTimeout(500);
    await shot("macro-steps-editor", "Macro editor opened from Steps…: step grid, holds, durations, motion writer, test");
    // try interacting: add a step / motion writer
    if (await clickText("Add step", "add step")) {
      await shot("macro-step-added", "A step added to the macro timeline");
    }
    if (await clickText("Test", "test macro")) {
      await page.waitForTimeout(600);
      await shot("macro-test", "Macro test replay running");
    }
    await page.keyboard.press("Escape");
    await clickText("Done", "close editor");
    await clickText("Close", "close editor 2");
    await page.mouse.click(760, 120);
    await page.waitForTimeout(300);
  }

  // ── Turbo ON state ──
  await clickText("Left stick — Left", "expand row again");
  try {
    // the Turbo control is a small switch; click near the label
    const t = page.locator("text=Turbo").first();
    const box = await t.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2);
      await page.waitForTimeout(400);
      await shot("turbo-on", "Turbo switched on: rate control revealed");
    }
  } catch { console.log("MISS turbo"); }

  // ── Record macro state ──
  if (await clickText("Record", "record macro")) {
    await page.waitForTimeout(400);
    await shot("macro-recording", "Macro recording armed: real-timing capture state");
    await page.keyboard.press("KeyH");
    await page.keyboard.press("KeyJ");
    await page.waitForTimeout(300);
    await shot("macro-recorded-keys", "Keys pressed during macro record");
    await page.keyboard.press("Escape");
    await clickText("Stop recording", "stop rec");
    await page.waitForTimeout(300);
  }

  // ── Right panel collapse ──
  if (await clickText("›", "collapse right panel")) {
    await shot("right-collapsed", "Right panel collapsed to its rail");
    await clickText("‹", "expand right panel back");
    await page.waitForTimeout(300);
  }

  // ── Remove + undo chip (zoom) ──
  {
    const removes = page.locator("text=✕");
    try {
      const count = await removes.count();
      await removes.nth(count - 1).click();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/38-undo-chip-zoom.png`, clip: { x: 0, y: 600, width: 600, height: 400 } });
      journal.push({ n: 38, name: "undo-chip-zoom", note: "The 6-second undo chip after removing a controller (left pane detail)", file: "38-undo-chip-zoom.png" });
      n = 38;
      console.log("[38] undo-chip-zoom");
      // try clicking the undo affordance whatever its label
      const u = (await clickText("Undo", "undo")) || (await clickText("Restore", "restore"));
      if (u) { await shot("undo-restored", "Controller restored by undo"); }
    } catch { console.log("MISS remove/undo 2"); }
  }

  // ── Saved games: play-entry + save-as-game ──
  if (await clickText("Apex Legends — WASD", "open config menu")) {
    await page.waitForTimeout(300);
    if (await clickText("Save current setup as a game...", "save as game")) {
      await page.waitForTimeout(400);
      await shot("save-as-game", "Save-current-setup-as-a-game flow");
      await page.keyboard.press("Escape");
    } else {
      await page.keyboard.press("Escape");
    }
  }

  fs.writeFileSync(
    "C:/Projects/KeyboardSplitterXboxPro/docs/design/nocturne-prototype/walkthrough-journal2.json",
    JSON.stringify(journal, null, 2),
  );
  console.log("PASS2 steps:", journal.length);
  await browser.close();
})();
