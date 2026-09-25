/* global BB_CONFIG, BB_ROASTS */
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const CFG = BB_CONFIG;

  // LinkedIn changes its markup often; every selector has fallbacks.
  const POST_SELECTOR = [
    // Current feed (2026): hashed class names, cards are list items keyed by update.
    '[role="listitem"][componentkey^="update-card"]',
    "div.feed-shared-update-v2",
    '[data-urn^="urn:li:activity:"]',
    '[data-id^="urn:li:activity:"]',
    '[data-view-name="feed-full-update"]',
  ].join(",");
  const TEXT_SELECTOR = [
    '[data-testid="expandable-text-box"]',
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
  const animated = new WeakSet();
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

  // Small seeded PRNG so a post's slime looks the same every time it's drawn.
  function seededRandom(seed) {
    let state = hashString(seed) || 1;
    return () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
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

  // The banner melts: SVG shapes run through a blur + alpha threshold ("goo")
  // filter so drips neck and merge like liquid, with a specular pass for gloss.
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function ensureGooFilter() {
    if (document.getElementById("bb-goo-filter")) return;
    const defs = svg("svg", { width: 0, height: 0, "aria-hidden": "true" });
    defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    const filter = svg("filter", {
      id: "bb-goo-filter",
      x: "-10%",
      y: "-10%",
      width: "120%",
      height: "130%",
      "color-interpolation-filters": "sRGB",
    });
    const light = svg("feSpecularLighting", {
      in: "bump",
      surfaceScale: 5,
      specularConstant: 1.1,
      specularExponent: 28,
      "lighting-color": "#ffffff",
      result: "spec",
    });
    light.append(svg("feDistantLight", { azimuth: 235, elevation: 48 }));
    filter.append(
      svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 5, result: "blur" }),
      svg("feColorMatrix", {
        in: "blur",
        values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10",
        result: "goo",
      }),
      svg("feGaussianBlur", { in: "goo", stdDeviation: 2.5, result: "bump" }),
      light,
      svg("feComposite", { in: "spec", in2: "goo", operator: "in", result: "shine" }),
      svg("feComposite", { in: "goo", in2: "shine", operator: "arithmetic", k2: 1, k3: 0.55 }),
    );
    defs.append(filter);
    document.body.append(defs);
  }

  function buildGoo(random) {
    ensureGooFilter();
    const root = svg("svg", { class: "bb-goo", "aria-hidden": "true" });
    const goo = svg("g", { class: "bb-goo-body", filter: "url(#bb-goo-filter)" });
    // The lip: extends up under the banner so only its wavy lower edge shows.
    goo.append(svg("rect", { x: "-5%", y: -40, width: "110%", height: 46 }));
    for (let i = 0; i < 14; i++) {
      goo.append(svg("circle", { cx: `${random() * 100}%`, cy: 5, r: (4 + random() * 7).toFixed(1) }));
    }
    const count = 6 + Math.floor(random() * 4);
    for (let i = 0; i < count; i++) {
      const width = 7 + random() * 11;
      const length = 18 + random() ** 1.6 * 95;
      const drip = svg("svg", { x: `${((i + 0.15 + random() * 0.7) / count) * 100}%`, overflow: "visible" });
      drip.setAttribute("class", "bb-drip");
      drip.style.setProperty("--len", `${length.toFixed(0)}px`);
      drip.style.setProperty("--delay", `${(0.55 + random() * 0.9).toFixed(2)}s`);
      drip.append(
        svg("rect", { class: "bb-drip-stem", x: -width / 2, y: 0, width, height: length, rx: width / 2 }),
        svg("circle", { class: "bb-drip-tip", cx: 0, cy: length, r: (width * 0.78).toFixed(1) }),
      );
      if (random() < 0.45) {
        drip.append(svg("circle", { class: "bb-drip-drop", cx: 0, cy: length, r: (width * 0.62).toFixed(1) }));
        drip.style.setProperty("--every", `${(3 + random() * 3).toFixed(2)}s`);
      }
      goo.append(drip);
    }
    root.append(goo);
    return root;
  }

  function buildBanner(post, result, animate) {
    const random = seededRandom(post.dataset.bbId + result.flavor);
    const banner = el("div", animate ? "bb-banner bb-animate" : "bb-banner");
    banner.append(el("div", "bb-stamp", "AI SLOP"));
    const info = el("div", "bb-info");
    const percent = Math.round(result.slop * 100);
    info.append(
      el("div", "bb-meta", `${t("slopPercent", [String(percent)])} · ${flavorLabel(result.flavor)}`),
      el("div", "bb-roast", roastFor(result, post.dataset.bbId + result.flavor)),
    );
    banner.append(info, buildGoo(random));
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
    post.classList.remove("bb-slop", "bb-mode-label", "bb-mode-collapse", "bb-mode-hide", "bb-shake");
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
    if (mode === "label") {
      // Only the first appearance gets the full splat; redraws stay quiet.
      const animate = !animated.has(post);
      animated.add(post);
      post.prepend(buildBanner(post, result, animate));
      if (animate) post.classList.add("bb-shake");
    }
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
      item.post.dataset.bbSlop = r.slop.toFixed(2);
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

  function onVisible(entries, observer) {
    for (const entry of entries) {
      // While disabled, keep watching so nothing is spent on quota.
      if (!entry.isIntersecting || !settings.enabled) continue;
      observer.unobserve(entry.target);
      enqueue(entry.target);
    }
  }

  // The feed scrolls inside its own container, which clips the viewport's
  // rootMargin away. Observing relative to that container keeps the lookahead.
  function scrollRoot(post) {
    for (let node = post.parentElement; node && node !== document.body; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  const observers = new Map();
  const watchedBy = new WeakMap();

  function watch(post) {
    const root = scrollRoot(post);
    let observer = observers.get(root);
    if (!observer) {
      observer = new IntersectionObserver(onVisible, { root, rootMargin: "600px 0px" });
      observers.set(root, observer);
    }
    watchedBy.set(post, observer);
    observer.observe(post);
  }

  function scan() {
    for (const post of document.querySelectorAll(POST_SELECTOR)) {
      const state = post.dataset.bbState;
      if (state && state !== "retry") continue;
      if (!isOutermostPost(post)) continue;
      post.dataset.bbState = "observed";
      watch(post);
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
          watchedBy.get(post)?.unobserve(post);
          watch(post);
        }
      }
    });
    scan();
    mutations.observe(document.body, { childList: true, subtree: true });
  }

  start();
})();
