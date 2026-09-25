import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter, TokenBuckets } from "../src/limiter.js";

const LIMITS = {
  postsPerDayPerInstall: 20,
  postsPerDayPerIp: 30,
  burstCapacity: 10,
  burstRefillPerMinute: 10,
  registrationsPerDayPerIp: 2,
  globalPostsPerDay: 1000,
};

function clock(start = Date.UTC(2026, 8, 25, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test("burst bucket blocks until tokens refill", () => {
  const now = clock();
  const limiter = new RateLimiter(LIMITS, now);
  const who = { installId: "a", ip: "1.1.1.1" };

  assert.equal(limiter.charge(who, 10).ok, true);
  const denied = limiter.charge(who, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "burst_limit");
  assert.equal(denied.retryAfterMs, 6000);

  now.advance(6000);
  assert.equal(limiter.charge(who, 1).ok, true);
});

test("daily install limit resets at UTC midnight", () => {
  const now = clock(Date.UTC(2026, 8, 25, 23, 0, 0));
  const limiter = new RateLimiter({ ...LIMITS, burstCapacity: 100, burstRefillPerMinute: 100 }, now);
  const who = { installId: "a", ip: "1.1.1.1" };

  assert.equal(limiter.charge(who, 20).ok, true);
  const denied = limiter.charge(who, 1);
  assert.equal(denied.reason, "daily_limit");
  assert.equal(denied.retryAfterMs, 60 * 60 * 1000);
  assert.equal(denied.quota.remaining, 0);
  assert.equal(denied.quota.resetAt, "2026-09-26T00:00:00.000Z");

  now.advance(60 * 60 * 1000);
  assert.equal(limiter.charge(who, 1).ok, true);
  assert.equal(limiter.quota("a").remaining, 19);
});

test("IP limit applies across rotated install IDs", () => {
  const limiter = new RateLimiter({ ...LIMITS, burstCapacity: 100, burstRefillPerMinute: 100 }, clock());
  assert.equal(limiter.charge({ installId: "a", ip: "9.9.9.9" }, 20).ok, true);
  assert.equal(limiter.charge({ installId: "b", ip: "9.9.9.9" }, 10).ok, true);
  const denied = limiter.charge({ installId: "c", ip: "9.9.9.9" }, 1);
  assert.equal(denied.reason, "daily_limit");
});

test("global budget reports service_busy", () => {
  const limiter = new RateLimiter(
    { ...LIMITS, globalPostsPerDay: 5, burstCapacity: 100, burstRefillPerMinute: 100 },
    clock(),
  );
  assert.equal(limiter.charge({ installId: "a", ip: "1" }, 5).ok, true);
  assert.equal(limiter.charge({ installId: "b", ip: "2" }, 1).reason, "service_busy");
});

test("denied charges don't consume anything and refunds give quota back", () => {
  const limiter = new RateLimiter(LIMITS, clock());
  const who = { installId: "a", ip: "1" };
  assert.equal(limiter.charge(who, 11).ok, false);
  assert.equal(limiter.quota("a").remaining, 20);

  assert.equal(limiter.charge(who, 5).ok, true);
  limiter.refund(who, 2);
  assert.equal(limiter.quota("a").remaining, 17);
});

test("registrations are capped per IP per day", () => {
  const limiter = new RateLimiter(LIMITS, clock());
  assert.equal(limiter.allowRegistration("1"), true);
  assert.equal(limiter.allowRegistration("1"), true);
  assert.equal(limiter.allowRegistration("1"), false);
  assert.equal(limiter.allowRegistration("2"), true);
});

test("a request larger than the bucket can never fit", () => {
  const buckets = new TokenBuckets({ capacity: 5, refillPerMinute: 5 }, clock());
  assert.equal(buckets.waitMs("a", 6), Infinity);
});
