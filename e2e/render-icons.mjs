// Renders extension/icons/icon.svg to the PNG sizes the manifest needs.
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const svg = await readFile(new URL("../extension/icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
  );
  await page.screenshot({
    path: new URL(`../extension/icons/icon-${size}.png`, import.meta.url).pathname,
    omitBackground: true,
  });
}
await browser.close();
