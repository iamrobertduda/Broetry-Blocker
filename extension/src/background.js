/* global importScripts, BB_CONFIG */
importScripts("config.js");

const api = globalThis.browser ?? globalThis.chrome;

const CACHE_KEY = "resultCache";
const CACHE_MAX = 3000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Result cache: the same post shows up again and again while scrolling, and
// every repeat would otherwise cost quota.

let cachePromise;
let cacheSaveTimer;

function loadCache() {
  cachePromise ??= api.storage.local.get(CACHE_KEY).then((stored) => {
    const now = Date.now();
    const map = new Map();
    for (const [key, entry] of Object.entries(stored[CACHE_KEY] ?? {})) {
      if (now - entry.t < CACHE_TTL_MS) map.set(key, entry);
    }
    return map;
  });
  return cachePromise;
}

function scheduleCacheSave(cache) {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    api.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache) });
  }, 1000);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Backend access with an anonymous install token (no login).

async function apiBase() {
  const { apiBase: override } = await api.storage.local.get("apiBase");
  return (override || BB_CONFIG.API_BASE).replace(/\/+$/, "");
}

let tokenPromise;

function getToken() {
  tokenPromise ??= (async () => {
    const { token } = await api.storage.local.get("token");
    if (token) return token;
    const res = await fetch(`${await apiBase()}/v1/register`, { method: "POST" });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const body = await res.json();
    await api.storage.local.set({ token: body.token, quota: body.quota });
    return body.token;
  })();
  tokenPromise.catch(() => {
    tokenPromise = undefined;
  });
  return tokenPromise;
}

async function forgetToken() {
  tokenPromise = undefined;
  await api.storage.local.remove("token");
}

async function postClassify(posts, retried = false) {
  const token = await getToken();
  const res = await fetch(`${await apiBase()}/v1/classify`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ posts }),
  });
  if (res.status === 401 && !retried) {
    await forgetToken();
    return postClassify(posts, true);
  }
  const body = await res.json().catch(() => ({}));
  if (body.quota) await api.storage.local.set({ quota: body.quota });
  return { status: res.status, body };
}

/**
 * @param {{id: string, text: string}[]} posts
 * @returns {Promise<{results: object[]} | {limited: string, retryAfterMs: number} | {error: string}>}
 */
async function classify(posts) {
  const cache = await loadCache();
  const results = [];
  const todo = [];
  for (const post of posts) {
    const key = await sha256(post.text);
    const hit = cache.get(key);
    if (hit) results.push({ id: post.id, slop: hit.slop, flavor: hit.flavor, cached: true });
    else todo.push({ ...post, key });
  }
  if (todo.length === 0) return { results };

  const { limitedUntil = 0, limitReason } = await api.storage.local.get(["limitedUntil", "limitReason"]);
  if (limitedUntil > Date.now()) {
    return { limited: limitReason ?? "daily_limit", retryAfterMs: limitedUntil - Date.now(), results };
  }

  let response;
  try {
    response = await postClassify(todo.map(({ id, text }) => ({ id, text })));
  } catch (err) {
    return { error: String(err?.message ?? err), results };
  }
  const { status, body } = response;
  if (status === 429) {
    const until = Date.now() + (body.retryAfterMs ?? 60_000);
    if (body.error !== "burst_limit") await api.storage.local.set({ limitedUntil: until, limitReason: body.error });
    return { limited: body.error ?? "rate_limited", retryAfterMs: body.retryAfterMs ?? 60_000, results };
  }
  if (status !== 200) return { error: body.error ?? `http_${status}`, results };

  const keyById = new Map(todo.map((p) => [p.id, p.key]));
  for (const r of body.results) {
    if (r.error) continue;
    cache.set(keyById.get(r.id), { slop: r.slop, flavor: r.flavor, t: Date.now() });
    results.push(r);
  }
  scheduleCacheSave(cache);
  return { results };
}

// ---------------------------------------------------------------------------
// Stats for the popup ("slop blocked today").

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Content scripts report in parallel; serialise the read-modify-write.
let statsWrite = Promise.resolve();

function recordSlop(count) {
  statsWrite = statsWrite.then(() => writeSlop(count)).catch(() => {});
  return statsWrite;
}

async function writeSlop(count) {
  const { stats = {} } = await api.storage.local.get("stats");
  const day = today();
  const next = {
    day,
    today: (stats.day === day ? stats.today : 0) + count,
    total: (stats.total ?? 0) + count,
  };
  await api.storage.local.set({ stats: next });
}

async function status() {
  const { stats = {}, quota, limitedUntil = 0, limitReason } = await api.storage.local.get([
    "stats",
    "quota",
    "limitedUntil",
    "limitReason",
  ]);
  return {
    today: stats.day === today() ? stats.today : 0,
    total: stats.total ?? 0,
    quota: quota ?? null,
    limited: limitedUntil > Date.now() ? { until: limitedUntil, reason: limitReason } : null,
  };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    classify: () => classify(message.posts),
    slopSeen: () => recordSlop(message.count ?? 1),
    status,
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler().then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

api.runtime.onInstalled.addListener(async () => {
  const { settings } = await api.storage.local.get("settings");
  if (!settings) await api.storage.local.set({ settings: BB_CONFIG.DEFAULT_SETTINGS });
});
