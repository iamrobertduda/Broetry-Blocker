import { randomBytes } from "node:crypto";

function readInt(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function readString(env, name, fallback) {
  const raw = env[name];
  return raw == null || raw.trim() === "" ? fallback : raw.trim();
}

/**
 * All tunables come from the environment so they can be changed in the
 * Railway dashboard without a redeploy of new code.
 */
export function loadConfig(env = process.env) {
  const typesafeApiKey = readString(env, "TYPESAFE_API_KEY", "");
  const classifier = readString(env, "CLASSIFIER", typesafeApiKey ? "jev" : "heuristic");
  if (classifier !== "jev" && classifier !== "heuristic") {
    throw new Error(`CLASSIFIER must be "jev" or "heuristic", got "${classifier}"`);
  }
  if (classifier === "jev" && !typesafeApiKey) {
    throw new Error("CLASSIFIER=jev requires TYPESAFE_API_KEY");
  }

  let tokenSecret = readString(env, "TOKEN_SECRET", "");
  const tokenSecretIsEphemeral = !tokenSecret;
  if (tokenSecretIsEphemeral) tokenSecret = randomBytes(32).toString("hex");

  return {
    port: readInt(env, "PORT", 8080),
    classifier,
    typesafeApiKey,
    typesafeBaseURL: readString(env, "TYPESAFE_BASE_URL", undefined),
    typesafeModel: readString(env, "TYPESAFE_MODEL", "jev-latest"),
    typesafeTimeoutMs: readInt(env, "TYPESAFE_TIMEOUT_MS", 10_000),
    tokenSecret,
    tokenSecretIsEphemeral,
    // Railway's edge proxy appends the client IP to X-Forwarded-For.
    trustProxyHops: readInt(env, "TRUST_PROXY_HOPS", 1),
    limits: {
      // A heavy LinkedIn user sees a few hundred posts a day; 1000 is ~80 min
      // of non-stop scrolling at one post every five seconds.
      postsPerDayPerInstall: readInt(env, "LIMIT_POSTS_PER_DAY_INSTALL", 1000),
      // Several people can share one IP (offices, carrier NAT).
      postsPerDayPerIp: readInt(env, "LIMIT_POSTS_PER_DAY_IP", 4000),
      // Token bucket: flick-scrolling loads roughly one post per second at most.
      burstCapacity: readInt(env, "LIMIT_BURST_CAPACITY", 50),
      burstRefillPerMinute: readInt(env, "LIMIT_BURST_REFILL_PER_MINUTE", 30),
      registrationsPerDayPerIp: readInt(env, "LIMIT_REGISTRATIONS_PER_DAY_IP", 10),
      // Hard ceiling on paid API usage across all users.
      globalPostsPerDay: readInt(env, "LIMIT_GLOBAL_POSTS_PER_DAY", 200_000),
    },
    maxBatchSize: readInt(env, "MAX_BATCH_SIZE", 10),
    minTextChars: readInt(env, "MIN_TEXT_CHARS", 40),
    maxTextChars: readInt(env, "MAX_TEXT_CHARS", 3000),
    cacheSize: readInt(env, "CACHE_SIZE", 50_000),
    maxConcurrentClassifications: readInt(env, "MAX_CONCURRENT_CLASSIFICATIONS", 16),
  };
}
