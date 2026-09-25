import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { LruCache } from "./cache.js";
import { createClassifier, FLAVORS } from "./classifier.js";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./limiter.js";
import { issueToken, verifyToken } from "./tokens.js";

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be JSON");
  }
}

/** The client IP as seen by the last `hops` trusted proxies (Railway's edge). */
export function clientIp(req, hops) {
  const forwarded = req.headers["x-forwarded-for"];
  if (hops > 0 && typeof forwarded === "string") {
    const chain = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function hashText(text) {
  return createHash("sha256").update(text).digest("base64url");
}

/** Limits how many classifier calls run at once. */
function createSemaphore(max) {
  let active = 0;
  const waiting = [];
  return async function run(fn) {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createApp({ config, classifier, now = Date.now, log = console }) {
  const limiter = new RateLimiter(config.limits, now);
  const cache = new LruCache(config.cacheSize);
  const inflight = new Map();
  const runLimited = createSemaphore(config.maxConcurrentClassifications);

  function classifyCached(text) {
    const key = hashText(text);
    const hit = cache.get(key);
    if (hit) return Promise.resolve({ ...hit, cached: true });
    let pending = inflight.get(key);
    if (!pending) {
      pending = runLimited(() => classifier.classify(text))
        .then((result) => {
          const flavor = Object.hasOwn(FLAVORS, result.flavor) ? result.flavor : "genuine";
          const clean = {
            slop: Math.min(1, Math.max(0, Number(result.slop) || 0)),
            flavor,
          };
          cache.set(key, clean);
          return clean;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending.then((r) => ({ ...r, cached: false }));
  }

  function authenticate(req) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const installId = verifyToken(token, config.tokenSecret);
    if (!installId) throw new HttpError(401, "invalid_token", "Missing or invalid install token");
    return installId;
  }

  function parsePosts(body) {
    const posts = body?.posts;
    if (!Array.isArray(posts) || posts.length === 0) {
      throw new HttpError(400, "invalid_request", "`posts` must be a non-empty array");
    }
    if (posts.length > config.maxBatchSize) {
      throw new HttpError(400, "batch_too_large", `At most ${config.maxBatchSize} posts per request`);
    }
    return posts.map((p) => {
      if (typeof p?.id !== "string" || p.id.length === 0 || p.id.length > 200) {
        throw new HttpError(400, "invalid_request", "Each post needs a string `id`");
      }
      if (typeof p.text !== "string") {
        throw new HttpError(400, "invalid_request", "Each post needs a string `text`");
      }
      const text = p.text.trim().slice(0, config.maxTextChars);
      if (text.length < config.minTextChars) {
        throw new HttpError(400, "text_too_short", `Post text must be at least ${config.minTextChars} characters`);
      }
      return { id: p.id, text };
    });
  }

  async function handleClassify(req, res) {
    const installId = authenticate(req);
    const ip = clientIp(req, config.trustProxyHops);
    const posts = parsePosts(await readJson(req));

    const charge = limiter.charge({ installId, ip }, posts.length);
    if (!charge.ok) {
      const retryAfterSec = Math.max(1, Math.ceil(charge.retryAfterMs / 1000));
      throw new HttpError(429, charge.reason, "Rate limit exceeded", {
        retryAfterMs: charge.retryAfterMs,
        quota: charge.quota,
        headers: { "retry-after": String(retryAfterSec) },
      });
    }

    const settled = await Promise.allSettled(posts.map((p) => classifyCached(p.text)));
    let failures = 0;
    const results = settled.map((s, i) => {
      if (s.status === "fulfilled") return { id: posts[i].id, ...s.value };
      failures++;
      log.warn(`[classify] ${classifier.name} failed: ${s.reason?.message ?? s.reason}`);
      return { id: posts[i].id, error: "classification_failed" };
    });
    limiter.refund({ installId, ip }, failures);

    send(res, 200, { results, quota: limiter.quota(installId) });
  }

  function handleRegister(req, res) {
    const ip = clientIp(req, config.trustProxyHops);
    if (!limiter.allowRegistration(ip)) {
      throw new HttpError(429, "registration_limit", "Too many installs from this network today");
    }
    const { token, installId } = issueToken(config.tokenSecret, now());
    send(res, 200, { token, quota: limiter.quota(installId) });
  }

  function handleQuota(req, res) {
    const installId = authenticate(req);
    send(res, 200, { quota: limiter.quota(installId) });
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      switch (route) {
        case "GET /":
          send(res, 200, { name: "broetry-blocker", status: "ok" });
          return;
        case "GET /healthz":
          send(res, 200, {
            status: "ok",
            classifier: classifier.name,
            cacheEntries: cache.size,
            ...limiter.stats(),
          });
          return;
        case "POST /v1/register":
          handleRegister(req, res);
          return;
        case "GET /v1/quota":
          handleQuota(req, res);
          return;
        case "POST /v1/classify":
          await handleClassify(req, res);
          return;
        default:
          throw new HttpError(404, "not_found", "Not found");
      }
    } catch (err) {
      if (err instanceof HttpError) {
        const { headers, ...extra } = err.extra;
        send(res, err.status, { error: err.code, message: err.message, ...extra }, headers);
      } else {
        log.error(`[server] ${route} failed`, err);
        send(res, 500, { error: "internal_error", message: "Something went wrong" });
      }
    }
  }

  return { handle, limiter, cache };
}

export function startServer(config = loadConfig()) {
  const classifier = createClassifier(config);
  const app = createApp({ config, classifier });
  const server = createServer(app.handle);
  const sweeper = setInterval(() => app.limiter.sweep(), 5 * 60_000);
  sweeper.unref();

  if (config.tokenSecretIsEphemeral) {
    console.warn("[server] TOKEN_SECRET not set: using a random one, install tokens won't survive a restart");
  }
  server.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (classifier: ${classifier.name})`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
