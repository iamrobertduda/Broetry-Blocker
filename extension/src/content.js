/* global BB_CONFIG, BB_ROASTS */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const CFG = BB_CONFIG;

  // LinkedIn changes its markup often; every selector has fallbacks.
  const POST_SELECTOR = [
    "div.feed-shared-update-v2",
    '[data-urn^="urn:li:activity:"]',
    '[data-id^="urn:li:activity:"]',
    '[data-view-name="feed-full-update"]',
  ].join(",");
  const TEXT_SELECTOR = [
    ".update-components-text",
    ".feed-shared-update-v2__description",
    ".feed-shared-inline-show-more-text",
    ".feed-shared-text",
    '[data-view-name="feed-commentary"]',
    '[data-test-id="main-feed-activity-card__commentary"]',
  ].join(",");
  const MAX_TEXT_ATTEMPTS = 3;
  const MAX_RETRIES = 2;

  const lang = (api.i18n?.getUILanguage?.() ?? navigator.language ?? "en").toLowerCase().startsWith("de")
    ? "de"
    : "en";
  const t = (key, subs) => api.i18n.getMessage(key, subs) || key;

  let settings = { ...CFG.DEFAULT_SETTINGS };
  const results = new WeakMap();
  const revealed = new WeakSet();
  const counted = new WeakSet();
  const attempts = new WeakMap();
  const byId = new Map();
  let nextId = 1;

  // -------------------------------------------------------------------------
  // Finding posts and their text

  function isOutermostPost(el) {
    return !el.parentElement?.closest(POST_SELECTOR);
  }

  function extractText(post) {
    // Reshares contain several text blocks; skip ones nested in another match.
    const containers = [...post.querySelectorAll(TEXT_SELECTOR)].filter(
      (el) => !el.parentElement?.closest(TEXT_SELECTOR),
    );
    const text = containers
      .map((el) => el.innerText.trim())
      .filter(Boolean)
      .join("\n\n");
    return text.slice(0, CFG.MAX_CHARS);
  }

  // -------------------------------------------------------------------------
  // Rendering verdicts

  function threshold() {
    return CFG.THRESHOLDS[settings.sensitivity] ?? CFG.THRESHOLDS.normal;
  }

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function roastFor(result, seed) {
    const lines = BB_ROASTS[lang][result.flavor] ?? BB_ROASTS[lang].genuine;
    return lines[hashString(seed) % lines.length];
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function flavorLabel(flavor) {
    return flavor && flavor !== "genuine" ? t(`flavor_${flavor}`) : t("flavor_generic");
  }

  function buildBanner(post, result) {
    const banner = el("div", "bb-banner");
    banner.append(el("div", "bb-stamp", "AI SLOP"));
    const info = el("div", "bb-info");
    const percent = Math.round(result.slop * 100);
    info.append(
      el("div", "bb-meta", `${t("slopPercent", [String(percent)])} · ${flavorLabel(result.flavor)}`),
      el("div", "bb-roast", roastFor(result, post.dataset.bbId + result.flavor)),
    );
    banner.append(info);
    return banner;
  }

  function buildCollapsedBar(post, result) {
    const bar = el("div", "bb-collapsed");
    const percent = Math.round(result.slop * 100);
    bar.append(
      el("span", "bb-collapsed-label", `🧹 ${t("collapsedLabel", [flavorLabel(result.flavor), String(percent)])}`),
    );
    const button = el("button", "bb-reveal", t("showAnyway"));
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealed.add(post);
      render(post);
    });
    bar.append(button);
    return bar;
  }

  function clear(post) {
    post.classList.remove("bb-slop", "bb-mode-label", "bb-mode-collapse", "bb-mode-hide");
    for (const child of post.querySelectorAll(":scope > .bb-banner, :scope > .bb-collapsed")) child.remove();
    delete post.dataset.bbFlag;
  }

  function render(post) {
    clear(post);
    const result = results.get(post);
    if (!settings.enabled || !result || result.slop < threshold()) return;

    const mode = revealed.has(post) ? "label" : settings.mode;
    post.dataset.bbFlag = mode;
    post.classList.add("bb-slop", `bb-mode-${mode}`);
    if (mode === "label") post.prepend(buildBanner(post, result));
    else if (mode === "collapse") post.prepend(buildCollapsedBar(post, result));

    if (!counted.has(post)) {
      counted.add(post);
      api.runtime.sendMessage({ type: "slopSeen", count: 1 }).catch(() => {});
    }
  }

  function renderAll() {
    for (const post of document.querySelectorAll('[data-bb-state="done"]')) render(post);
  }

  // LinkedIn sometimes re-renders a post and throws our banner away.
  function repairDecorations() {
    for (const post of document.querySelectorAll("[data-bb-flag]")) {
      const mode = post.dataset.bbFlag;
      const needs = mode === "label" ? ".bb-banner" : mode === "collapse" ? ".bb-collapsed" : null;
      if (needs && !post.querySelector(`:scope > ${needs}`)) render(post);
    }
  }

  // -------------------------------------------------------------------------
  // Classification queue: batches posts near the viewport and talks to the
  // background worker, which owns the backend connection and the cache.

  const queue = [];
  let flushTimer = null;
  let inflight = false;
  let pausedUntil = 0;

  function scheduleFlush(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay);
  }

  function enqueue(post) {
    const text = extractText(post);
    if (text.length < CFG.MIN_CHARS) {
      // The text may not be rendered yet; let a later scan try again.
      const n = (attempts.get(post) ?? 0) + 1;
      attempts.set(post, n);
      post.dataset.bbState = n >= MAX_TEXT_ATTEMPTS ? "skip" : "retry";
      return;
    }
    post.dataset.bbState = "queued";
    queue.push({ post, text, retries: 0 });
    if (queue.length >= CFG.BATCH_SIZE) scheduleFlush(0);
    else if (!flushTimer) scheduleFlush(350);
  }

  async function flush() {
    flushTimer = null;
    if (inflight || queue.length === 0) return;
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      scheduleFlush(wait);
      return;
    }

    const batch = queue.splice(0, CFG.BATCH_SIZE).filter((item) => item.post.isConnected);
    if (batch.length === 0) return flush();
    for (const item of batch) {
      item.post.dataset.bbId ??= `p${nextId++}`;
      byId.set(item.post.dataset.bbId, item);
    }

    inflight = true;
    let response;
    try {
      response = await api.runtime.sendMessage({
        type: "classify",
        posts: batch.map((item) => ({ id: item.post.dataset.bbId, text: item.text })),
      });
    } catch (err) {
      response = { error: String(err?.message ?? err) };
    } finally {
      inflight = false;
    }

    const done = new Set();
    for (const r of response?.results ?? []) {
      const item = byId.get(r.id);
      if (!item) continue;
      done.add(item);
      results.set(item.post, { slop: r.slop, flavor: r.flavor });
      item.post.dataset.bbState = "done";
      render(item.post);
    }
    const leftover = batch.filter((item) => !done.has(item));
    for (const item of batch) byId.delete(item.post.dataset.bbId);

    if (response?.limited) {
      pausedUntil = Date.now() + (response.retryAfterMs ?? 60_000);
      for (const item of leftover) item.post.dataset.bbState = "queued";
      queue.unshift(...leftover);
    } else if (leftover.length > 0) {
      pausedUntil = Date.now() + 15_000;
      for (const item of leftover) {
        item.retries++;
        if (item.retries > MAX_RETRIES) item.post.dataset.bbState = "error";
        else queue.push(item);
      }
    }
    if (queue.length > 0) scheduleFlush(0);
  }

  // -------------------------------------------------------------------------
  // Discovery

  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // While disabled, keep watching so nothing is spent on quota.
        if (!entry.isIntersecting || !settings.enabled) continue;
        visibility.unobserve(entry.target);
        enqueue(entry.target);
      }
    },
    { rootMargin: "600px 0px" },
  );

  function scan() {
    for (const post of document.querySelectorAll(POST_SELECTOR)) {
      const state = post.dataset.bbState;
      if (state && state !== "retry") continue;
      if (!isOutermostPost(post)) continue;
      post.dataset.bbState = "observed";
      visibility.observe(post);
    }
    repairDecorations();
  }

  let scanTimer = null;
  const mutations = new MutationObserver(() => {
    scanTimer ??= setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  });

  async function start() {
    const stored = await api.storage.local.get("settings");
    settings = { ...CFG.DEFAULT_SETTINGS, ...stored.settings };
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      settings = { ...CFG.DEFAULT_SETTINGS, ...changes.settings.newValue };
      renderAll();
      if (settings.enabled) {
        // Re-observing fires the callback for posts that are already on screen.
        for (const post of document.querySelectorAll('[data-bb-state="observed"]')) {
          visibility.unobserve(post);
          visibility.observe(post);
        }
      }
    });
    scan();
    mutations.observe(document.body, { childList: true, subtree: true });
  }

  start();
})();
