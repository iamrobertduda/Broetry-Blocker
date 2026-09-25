// Loads the real extension into Chromium, serves a LinkedIn-like feed from a
// fixture and runs it against a local backend using the heuristic classifier.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { chromium } from "playwright";
import { createHeuristicClassifier } from "../backend/src/classifier.js";
import { loadConfig } from "../backend/src/config.js";
import { createApp } from "../backend/src/server.js";

const EXTENSION = fileURLToPath(new URL("../extension", import.meta.url));
const FEED = await readFile(new URL("./fixtures/feed.html", import.meta.url), "utf8");
const SCREENSHOTS = process.env.SCREENSHOT_DIR;

function startBackend(env = {}) {
  const config = loadConfig({ TOKEN_SECRET: "e2e", TRUST_PROXY_HOPS: "0", ...env });
  const app = createApp({ config, classifier: createHeuristicClassifier(), log: { warn() {}, error() {} } });
  const counts = { classify: 0 };
  const server = createServer((req, res) => {
    if (req.url === "/v1/classify") counts.classify++;
    return app.handle(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, counts, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

async function launch(apiBase, settings) {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "bb-e2e-")), {
    channel: "chromium",
    locale: "de-DE",
    // Chromium on Linux takes its UI language (used by chrome.i18n) from the environment.
    env: { ...process.env, LANG: "de_DE.UTF-8", LANGUAGE: "de" },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, "--lang=de-DE"],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(
    ([base, s]) => chrome.storage.local.set({ apiBase: base, settings: s }),
    [apiBase, settings],
  );
  await context.route("https://www.linkedin.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: FEED }),
  );
  return { context, worker, extensionId };
}

const setSettings = (worker, settings) =>
  worker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

const post = (page, name) => page.locator(`[data-testpost="${name}"]`);

let backend;
before(async () => {
  backend = await startBackend();
});
after(() => backend.server.close());

test("labels, collapses and hides slop in the feed", async () => {
  const { context, worker, extensionId } = await launch(backend.base, {
    enabled: true,
    mode: "label",
    sensitivity: "normal",
  });
  try {
    const page = await context.newPage();
    await page.goto("https://www.linkedin.com/feed/");

    // Label mode: big red stamp on slop, nothing on genuine or short posts.
    await post(page, "broetry").locator(".bb-banner").waitFor();
    await post(page, "ai").locator(".bb-banner").waitFor();
    await post(page, "late-story").locator(".bb-banner").waitFor();
    assert.equal(await post(page, "broetry").locator(".bb-stamp").textContent(), "AI SLOP");
    assert.match(await post(page, "broetry").locator(".bb-meta").textContent(), /% Slop · /);
    assert.equal(await post(page, "genuine").getAttribute("data-bb-state"), "done");
    assert.equal(await post(page, "genuine").locator(".bb-banner").count(), 0);
    assert.match(await post(page, "short").getAttribute("data-bb-state"), /^(retry|skip)$/);
    if (SCREENSHOTS) await page.screenshot({ path: join(SCREENSHOTS, "label-mode.png"), fullPage: true });

    // Collapse mode, and revealing a single post.
    await setSettings(worker, { enabled: true, mode: "collapse", sensitivity: "normal" });
    await post(page, "broetry").locator(".bb-collapsed").waitFor();
    assert.equal(await post(page, "broetry").locator(".actor").isVisible(), false);
    if (SCREENSHOTS) await page.screenshot({ path: join(SCREENSHOTS, "collapse-mode.png"), fullPage: true });
    await post(page, "broetry").locator(".bb-reveal").click();
    await post(page, "broetry").locator(".bb-banner").waitFor();
    assert.equal(await post(page, "ai").locator(".bb-collapsed").count(), 1);

    // Hide mode removes slop completely.
    await setSettings(worker, { enabled: true, mode: "hide", sensitivity: "normal" });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testpost="ai"]');
      return getComputedStyle(el).display === "none";
    });
    assert.equal(await post(page, "genuine").isVisible(), true);

    // Popup shows stats and remaining quota.
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 352, height: 470 });
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.locator("#quota").filter({ hasText: /von 1000/ }).waitFor();
    assert.ok(Number(await popup.locator("#today").textContent()) >= 3);
    assert.equal(await popup.locator('[data-i18n="modeHide"]').textContent(), "Komplett ausblenden");
    if (SCREENSHOTS) await popup.screenshot({ path: join(SCREENSHOTS, "popup.png") });

    // Turning it off restores everything.
    await setSettings(worker, { enabled: false, mode: "hide", sensitivity: "normal" });
    await page.waitForFunction(() => document.querySelectorAll(".bb-slop").length === 0);
    assert.equal(await post(page, "ai").isVisible(), true);
  } finally {
    await context.close();
  }
});

test("stops asking the backend once the daily limit is hit", async () => {
  const limited = await startBackend({ LIMIT_POSTS_PER_DAY_INSTALL: "2" });
  const { context, extensionId } = await launch(limited.base, {
    enabled: true,
    mode: "label",
    sensitivity: "normal",
  });
  try {
    const page = await context.newPage();
    await page.goto("https://www.linkedin.com/feed/");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    // The popup updates itself once the background hits the limit.
    await popup.locator("#quota").filter({ hasText: "Tageslimit erreicht" }).waitFor();
    // Nothing got classified: the batch of 3+ posts exceeded the limit of 2.
    assert.equal(await page.locator('[data-bb-state="done"]').count(), 0);
    // The post that shows up later is not sent to the backend at all.
    await page.locator('[data-testpost="late-story"][data-bb-state="queued"]').waitFor();
    await page.waitForTimeout(1000);
    assert.equal(limited.counts.classify, 1);
  } finally {
    await context.close();
    limited.server.close();
  }
});
