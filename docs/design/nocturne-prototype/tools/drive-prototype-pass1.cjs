// Drive the Nocturne prototype end-to-end, screenshotting every state and
// journaling what each step observed. Resilient: a missed selector logs and
// moves on rather than aborting the walkthrough.
const { chromium } = require("playwright");
const fs = require("fs");

const SHOTS = "C:/Projects/KeyboardSplitterXboxPro/docs/design/nocturne-prototype/shots";
const SRC =
  "file:///C:/Users/Victor/.claude/projects/C--Users-Victor/874d2022-a3ed-400d-99b4-7bae35a8c69c/tool-results/artifact-58371700-1786930482-84d4.html";

const journal = [];
let n = 0;

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

  // Click a prototype "clickable" (they are DIVs with cursor:pointer) by its
  // visible text. exact=false substring match on normalized text.
  async function clickText(text, note) {
    try {
      const el = page.locator(`text=${text}`).first();
      await el.click();
      await page.waitForTimeout(400);
      return true;
    } catch (e) {
      journal.push({ n: null, name: "MISS", note: `${note}: could not click "${text}"` });
      console.log(`MISS: ${note} ("${text}")`);
      return false;
    }
  }

  async function grabText(sel) {
    try {
      return (await page.locator(sel).first().textContent({ timeout: 1500 }) || "").trim().replace(/\s+/g, " ");
    } catch { return ""; }
  }

  await page.goto(SRC, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // ── 1. Overview ──
  await shot("overview-idle", "Initial state: config chip, 4 keyboards, P1 staged, 16/24 bound, idle stage");

  // ── 2. Config dropdown ──
  if (await clickText("Apex Legends — WASD", "open config menu")) {
    await shot("config-menu", "Config dropdown: saved configurations, Start over, Save as new, Import/Export, Saved games, autostart");
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 500);
    await page.waitForTimeout(300);
  }

  // ── 3. Device selection ──
  if (await clickText("G915 TKL", "select another keyboard")) {
    await shot("device-switch", "Selected the G915 TKL: selection dot moves, keyboard diagram should follow the device");
  }
  await clickText("K70 RGB MK.2", "back to K70");
  await page.waitForTimeout(300);

  // ── 4. Identify by key ──
  if (await clickText("Identify by key", "start identify")) {
    await page.waitForTimeout(400);
    await shot("identify-listening", "Identify-by-key listening state");
    await page.keyboard.press("KeyJ");
    await page.waitForTimeout(500);
    await shot("identify-resolved", "After pressing a key during identify");
  }

  // ── 5. Capture behaviour radios ──
  if (await clickText("Whole keyboard — Freeze", "switch to Freeze")) {
    await shot("behaviour-freeze", "Freeze selected: whole keyboard devoted to play");
  }
  await clickText("Bound keys only — Split", "back to Split");
  await page.waitForTimeout(300);

  // ── 6. Create controller dialog (empty slot) ──
  if (await clickText("P2 empty slot", "click empty slot P2")) {
    await page.waitForTimeout(400);
    await shot("create-dialog", "Create-controller dialog: persona grid, capacity notes, starter bindings, SOCD pills");
    // try picking a persona then create
    const personaTried = (await clickText("DualShock 4", "pick DualShock 4 persona")) ||
      (await clickText("PlayStation", "pick PlayStation persona")) ||
      (await clickText("Xbox 360", "pick Xbox persona in dialog"));
    if (personaTried) await shot("create-dialog-persona", "Persona selected in the create dialog");
    const created = (await clickText("Create controller", "confirm create")) ||
      (await clickText("Create", "confirm create (short)"));
    await page.waitForTimeout(500);
    if (created) await shot("created-p2", "P2 created and now in the rack");
    else { await page.keyboard.press("Escape"); await page.mouse.click(700, 500); }
  }

  // ── 7. Duplicate P1 ──
  if (await clickText("⧉", "duplicate P1")) {
    await page.waitForTimeout(400);
    await shot("duplicated", "Duplicated a controller into the next slot");
  }

  // ── 8. Remove + undo chip ──
  {
    const removes = page.locator("text=✕");
    try {
      const count = await removes.count();
      if (count > 1) {
        await removes.nth(count - 1).click();
        await page.waitForTimeout(300);
        await shot("removed-undo", "Removed the last controller: 6-second undo chip visible");
        const undone = await clickText("Undo", "undo the remove");
        await page.waitForTimeout(400);
        if (undone) await shot("undone", "Undo restored the controller");
      }
    } catch { console.log("MISS: remove/undo"); }
  }

  // back to P1 selected for binding flows
  await clickText("P1", "select P1");
  await page.waitForTimeout(300);

  // ── 9. Assign flow ──
  {
    const assigns = page.locator("text=Assign");
    try {
      await assigns.first().click();
      await page.waitForTimeout(400);
      await shot("capture-armed", "Capture state armed: press-a-key banner, Esc cancels, Backspace clears");
      await page.keyboard.press("KeyI");
      await page.waitForTimeout(500);
      await shot("capture-bound", "Key I bound to the assigned input; chip replaces Assign");
    } catch { journal.push({ n: null, name: "MISS", note: "assign flow" }); console.log("MISS assign"); }
  }

  // ── 10. Conflict flow ──
  {
    const assigns = page.locator("text=Assign");
    try {
      await assigns.first().click();
      await page.waitForTimeout(300);
      await page.keyboard.press("KeyW"); // W is bound to RT already
      await page.waitForTimeout(500);
      await shot("conflict-dialog", "Conflict dialog: the key is taken — Swap / Move here / Keep both with consequences");
      const kept = (await clickText("Keep both", "resolve: keep both")) ||
        (await clickText("Move here", "resolve: move here")) ||
        (await clickText("Cancel", "dismiss conflict"));
      await page.waitForTimeout(400);
      if (kept) await shot("conflict-resolved", "Conflict resolved");
    } catch { console.log("MISS conflict"); }
  }

  // ── 11. Row expander: Hold|Toggle, Turbo ──
  if (await clickText("Left stick — Left", "expand a bound row")) {
    await page.waitForTimeout(400);
    await shot("row-expanded", "Expanded binding row: Rebind/Clear, Hold|Toggle, Turbo + rate, macro entry");
    if (await clickText("Toggle", "flip Hold->Toggle")) {
      await shot("row-toggle", "Toggle mode set on the input");
      await clickText("Hold", "back to Hold");
    }
    if (await clickText("Turbo", "enable turbo")) {
      await page.waitForTimeout(300);
      await shot("row-turbo", "Turbo enabled with its rate control");
    }
  }

  // ── 12. Macro entry ──
  {
    const tried = (await clickText("Record macro", "open macro recorder")) ||
      (await clickText("Macro", "open macro editor")) ||
      (await clickText("+ Add macro", "add macro"));
    if (tried) {
      await page.waitForTimeout(500);
      await shot("macro-editor", "Macro editor: steps × holds grid, motion writer, durations, record, test");
      await page.keyboard.press("Escape");
      const closed = (await clickText("Close", "close macro editor")) || (await clickText("Done", "done macro editor"));
      await page.waitForTimeout(300);
      if (!closed) await page.mouse.click(700, 120);
    }
  }

  // ── 13. Pad diagram click ──
  try {
    await page.locator('[data-input="Y"]').first().click();
    await page.waitForTimeout(400);
    await shot("pad-zone-selected", "Clicked Y on the pad: input selected / capture armed from the diagram");
    await page.keyboard.press("Escape");
  } catch { console.log("MISS pad zone"); }

  // ── 14. Keyboard diagram inspect ──
  if (await clickText("W RT", "click bound key W on the keyboard diagram")) {
    await shot("keyboard-inspect", "Clicked bound key W: inspection/selection of what it drives");
  }

  // ── 15. Filter ──
  try {
    const filter = page.locator('input[placeholder*="Filter"], input[type="search"]').first();
    await filter.fill("stick");
    await page.waitForTimeout(400);
    await shot("filter-stick", "Filter 'stick': list narrowed to stick groups");
    await clickText("Reset", "reset filter");
    await page.waitForTimeout(300);
  } catch { journal.push({ n: null, name: "MISS", note: "filter" }); console.log("MISS filter"); }

  // ── 16. Play / live ──
  if (await clickText("Play", "start live session")) {
    await page.waitForTimeout(700);
    await shot("live-started", "Live state: stage glow, session stats running, ticker ready");
    await page.keyboard.down("KeyW");
    await page.keyboard.down("KeyA");
    await page.waitForTimeout(450);
    await shot("live-pressing", "Holding W+A live: pad zones light, keyboard keys light, ticker shows inputs");
    await page.keyboard.up("KeyW");
    await page.keyboard.up("KeyA");
    // turbo strobe if any turbo input pressed
    await page.keyboard.down("KeyS");
    await page.waitForTimeout(400);
    await shot("live-turbo", "Holding a turbo'd input live (strobe state)");
    await page.keyboard.up("KeyS");
    const paused = (await clickText("Pause", "pause & edit")) || (await clickText("Pause & edit", "pause & edit"));
    await page.waitForTimeout(500);
    if (paused) await shot("paused", "Paused: pads disconnected, editing re-enabled");
    const stopped = (await clickText("Stop", "stop session")) || (await clickText("Resume", "resume then stop"));
    await page.waitForTimeout(400);
    if (stopped) await shot("stopped", "Back to idle after the session");
  }

  // ── 17. Collapse panels ──
  if (await clickText("‹", "collapse left panel")) {
    await shot("left-collapsed", "Left panel collapsed to its 52px rail");
    await clickText("›", "expand left panel");
    await page.waitForTimeout(300);
  }

  // ── 18. Save ──
  if (await clickText("Save", "save config")) {
    await page.waitForTimeout(400);
    await shot("saved", "After Save: chip shows saved state");
  }

  // Final full state
  await shot("final-state", "End of walkthrough");

  fs.writeFileSync(
    "C:/Projects/KeyboardSplitterXboxPro/docs/design/nocturne-prototype/walkthrough-journal.json",
    JSON.stringify(journal, null, 2),
  );
  console.log("JOURNAL steps:", journal.length);
  await browser.close();
})();
