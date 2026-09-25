import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createHeuristicClassifier, createJevClassifier } from "../src/classifier.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { issueToken, verifyToken } from "../src/tokens.js";

const BROETRY = `I got rejected from 47 jobs.

Then I got rejected from 48.

But I didn't give up.

I kept going.

Today I'm humbled to announce I'm the CEO of my own company.

Here's the thing: failure is just feedback.

Agree?`;

const GENUINE =
  "We just released version 2.3 of our open source PDF parser. It now handles scanned documents " +
  "with OCR and is about 40% faster on large files. Changelog and benchmarks are in the repo.";

const quietLog = { warn() {}, error() {}, log() {} };

function startApp({ env = {}, classifier } = {}) {
  const config = loadConfig({
    TOKEN_SECRET: "test-secret",
    LIMIT_POSTS_PER_DAY_INSTALL: "12",
    LIMIT_BURST_CAPACITY: "50",
    LIMIT_REGISTRATIONS_PER_DAY_IP: "20",
    ...env,
  });
  const calls = [];
  const inner = classifier ?? createHeuristicClassifier();
  const counting = {
    name: inner.name,
    classify: (text) => {
      calls.push(text);
      return inner.classify(text);
    },
  };
  const app = createApp({ config, classifier: counting, log: quietLog });
  const server = createServer(app.handle);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, calls });
    });
  });
}

async function register(base) {
  const res = await fetch(`${base}/v1/register`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

function classify(base, token, posts) {
  return fetch(`${base}/v1/classify`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ posts }),
  });
}

let ctx;
before(async () => {
  ctx = await startApp();
});
after(() => ctx.server.close());

test("tokens round-trip and reject tampering", () => {
  const { token, installId } = issueToken("s");
  assert.equal(verifyToken(token, "s"), installId);
  assert.equal(verifyToken(token, "other"), null);
  assert.equal(verifyToken(token.replace(installId, "00000000-0000-0000-0000-000000000000"), "s"), null);
  assert.equal(verifyToken("garbage", "s"), null);
});

test("classify requires a valid token", async () => {
  const res = await classify(ctx.base, "v1.nope.1.sig", [{ id: "1", text: GENUINE }]);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "invalid_token");
});

test("classifies a batch and flags slop", async () => {
  const token = await register(ctx.base);
  const res = await classify(ctx.base, token, [
    { id: "slop", text: BROETRY },
    { id: "real", text: GENUINE },
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  const byId = Object.fromEntries(body.results.map((r) => [r.id, r]));
  assert.ok(byId.slop.slop > 0.7, `expected slop, got ${byId.slop.slop}`);
  assert.ok(byId.real.slop < 0.5, `expected genuine, got ${byId.real.slop}`);
  assert.equal(byId.real.flavor, "genuine");
  assert.equal(body.quota.remaining, 10);
});

test("identical texts hit the cache", async () => {
  const token = await register(ctx.base);
  const text = `${GENUINE} (cache test)`;
  const before = ctx.calls.length;
  await classify(ctx.base, token, [{ id: "a", text }]);
  const res = await classify(ctx.base, token, [{ id: "b", text }]);
  const body = await res.json();
  assert.equal(body.results[0].cached, true);
  assert.equal(ctx.calls.length - before, 1);
});

test("daily quota returns 429 with Retry-After", async () => {
  const token = await register(ctx.base);
  const posts = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `${GENUINE} #${i}` }));
  assert.equal((await classify(ctx.base, token, posts)).status, 200);
  const res = await classify(ctx.base, token, posts.slice(0, 3));
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  const body = await res.json();
  assert.equal(body.error, "daily_limit");
  assert.equal(body.quota.remaining, 2);
});

test("validates the request body", async () => {
  const token = await register(ctx.base);
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ id: String(i), text: GENUINE }));
  assert.equal((await classify(ctx.base, token, tooMany)).status, 400);
  assert.equal((await classify(ctx.base, token, [{ id: "x", text: "short" }])).status, 400);
  assert.equal((await classify(ctx.base, token, [{ text: GENUINE }])).status, 400);
  assert.equal((await classify(ctx.base, token, [])).status, 400);
});

test("registration is limited per IP", async () => {
  const app = await startApp({ env: { LIMIT_REGISTRATIONS_PER_DAY_IP: "1" } });
  try {
    assert.equal((await fetch(`${app.base}/v1/register`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${app.base}/v1/register`, { method: "POST" })).status, 429);
  } finally {
    app.server.close();
  }
});

test("uses the rightmost X-Forwarded-For hop as client IP", async () => {
  const app = await startApp({ env: { LIMIT_REGISTRATIONS_PER_DAY_IP: "1" } });
  const reg = (xff) =>
    fetch(`${app.base}/v1/register`, { method: "POST", headers: { "x-forwarded-for": xff } });
  try {
    assert.equal((await reg("6.6.6.6, 1.2.3.4")).status, 200);
    // A spoofed leftmost entry doesn't create a fresh identity.
    assert.equal((await reg("7.7.7.7, 1.2.3.4")).status, 429);
    assert.equal((await reg("5.6.7.8")).status, 200);
  } finally {
    app.server.close();
  }
});

test("failed classifications are reported per post and refunded", async () => {
  const flaky = {
    name: "flaky",
    classify: async (text) => {
      if (text.includes("boom")) throw new Error("upstream down");
      return { slop: 0.9, flavor: "broetry" };
    },
  };
  const app = await startApp({ classifier: flaky });
  try {
    const token = await register(app.base);
    const res = await classify(app.base, token, [
      { id: "ok", text: GENUINE },
      { id: "bad", text: `${GENUINE} boom` },
    ]);
    const body = await res.json();
    assert.deepEqual(body.results.map((r) => r.error ?? r.flavor), ["broetry", "classification_failed"]);
    assert.equal(body.quota.remaining, 11);
  } finally {
    app.server.close();
  }
});

test("unknown flavors from the model are normalised", async () => {
  const weird = { name: "weird", classify: async () => ({ slop: 7, flavor: "__proto__" }) };
  const app = await startApp({ classifier: weird });
  try {
    const token = await register(app.base);
    const body = await (await classify(app.base, token, [{ id: "1", text: GENUINE }])).json();
    assert.equal(body.results[0].flavor, "genuine");
    assert.equal(body.results[0].slop, 1);
  } finally {
    app.server.close();
  }
});

test("Jev classifier sends a System One request and maps the answers", async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          slop: { type: "noul", noul: 0.93 },
          flavor: {
            type: "choice",
            choice: "broetry",
            confidence: 0.8,
            probabilities: { broetry: 0.8, genuine: 0.2 },
          },
        },
        usage: { input_tokens: 120, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const jev = createJevClassifier({
    apiKey: "sk-test",
    baseURL: "https://jev.example",
    model: "jev-latest",
    timeoutMs: 1000,
    fetch: fakeFetch,
  });

  const result = await jev.classify(BROETRY);

  assert.deepEqual(result, { slop: 0.93, flavor: "broetry", flavorConfidence: 0.8 });
  assert.equal(captured.url, "https://jev.example/v1/systemone");
  assert.equal(new Headers(captured.init.headers).get("authorization"), "Bearer sk-test");
  assert.equal(captured.body.model, "jev-latest");
  assert.deepEqual(captured.body.state, { platform: "LinkedIn", post: BROETRY });
  assert.equal(captured.body.questions.slop.type, "noul");
  assert.equal(captured.body.questions.flavor.type, "choice");
  assert.ok("genuine" in captured.body.questions.flavor.criteria);
});

test("config refuses jev without an API key", () => {
  assert.throws(() => loadConfig({ CLASSIFIER: "jev" }), /TYPESAFE_API_KEY/);
  assert.equal(loadConfig({}).classifier, "heuristic");
  assert.equal(loadConfig({ TYPESAFE_API_KEY: "k" }).classifier, "jev");
});
