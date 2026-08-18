const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const svg = (process.env.SVG || "").split("\\").join("/");
  await page.goto("file:///" + svg);
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT });
  await browser.close();
})();
