// One-off fidelity shot of /nocturne at the prototype walkthrough's viewport
// (1600×1000 dark — the same frame as docs/design/nocturne-prototype/shots/,
// so the two screenshots diff side-by-side). Run from pwtest with the
// macro_fixture example serving on 4476; not part of any suite.
//   node shot-nocturne.cjs [out.png]
const { chromium } = require("playwright");
const path = require("path");
const { tmpdir } = require("os");

(async () => {
  const out = process.argv[2] || path.join(tmpdir(), "nocturne-now.png");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("http://127.0.0.1:4476/nocturne", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  await page.screenshot({ path: out });
  console.log("shot:", out, "| h-overflow px:", overflow, "| console errors:", errors.length);
  errors.forEach((e) => console.log("  ERR:", e));
  await browser.close();
})();
