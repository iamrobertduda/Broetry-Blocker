const MINUTE_MS = 60_000;

export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Per-key counters that reset at UTC midnight. Everything lives in memory,
 * so a redeploy also resets the counters, which is acceptable for a
 * single Railway instance.
 */
export class DailyCounter {
  #day = "";
  #counts = new Map();
  #now;

  constructor(now = Date.now) {
    this.#now = now;
  }

  #roll() {
    const today = utcDay(this.#now());
    if (today !== this.#day) {
      this.#day = today;
      this.#counts.clear();
    }
  }

  used(key) {
    this.#roll();
    return this.#counts.get(key) ?? 0;
  }

  add(key, n) {
    this.#roll();
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + n);
  }

  refund(key, n) {
    this.#roll();
    const next = (this.#counts.get(key) ?? 0) - n;
    if (next > 0) this.#counts.set(key, next);
    else this.#counts.delete(key);
  }

  get size() {
    this.#roll();
    return this.#counts.size;
  }
}

/** Classic token bucket keyed by install ID, used to cap bursts. */
export class TokenBuckets {
  #buckets = new Map();
  #capacity;
  #refillPerMs;
  #now;

  constructor({ capacity, refillPerMinute }, now = Date.now) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerMinute / MINUTE_MS;
    this.#now = now;
  }

  #bucket(key) {
    const now = this.#now();
    let b = this.#buckets.get(key);
    if (!b) {
      b = { tokens: this.#capacity, ts: now };
      this.#buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.#capacity, b.tokens + (now - b.ts) * this.#refillPerMs);
      b.ts = now;
    }
    return b;
  }

  /** Milliseconds until `n` tokens are available (0 when available now). */
  waitMs(key, n) {
    const b = this.#bucket(key);
    if (b.tokens >= n) return 0;
    if (n > this.#capacity || this.#refillPerMs === 0) return Infinity;
    return Math.ceil((n - b.tokens) / this.#refillPerMs);
  }

  take(key, n) {
    this.#bucket(key).tokens -= n;
  }

  /** Drop buckets that have been idle long enough to be full again. */
  sweep() {
    const fullAfterMs = this.#refillPerMs > 0 ? this.#capacity / this.#refillPerMs : Infinity;
    const now = this.#now();
    for (const [key, b] of this.#buckets) {
      if (now - b.ts > fullAfterMs) this.#buckets.delete(key);
    }
  }
}

/**
 * Combines every limit that applies to a classification request. `charge`
 * is all-or-nothing: either every counter is incremented or none is.
 */
export class RateLimiter {
  #limits;
  #now;
  #installs;
  #ips;
  #global;
  #registrations;
  #bursts;

  constructor(limits, now = Date.now) {
    this.#limits = limits;
    this.#now = now;
    this.#installs = new DailyCounter(now);
    this.#ips = new DailyCounter(now);
    this.#global = new DailyCounter(now);
    this.#registrations = new DailyCounter(now);
    this.#bursts = new TokenBuckets(
      { capacity: limits.burstCapacity, refillPerMinute: limits.burstRefillPerMinute },
      now,
    );
  }

  #resetAt() {
    return nextUtcMidnight(this.#now());
  }

  /**
   * @returns {{ok: true, quota: object} | {ok: false, reason: string, retryAfterMs: number, quota: object}}
   */
  charge({ installId, ip }, n) {
    const l = this.#limits;
    const deny = (reason, retryAfterMs) => ({
      ok: false,
      reason,
      retryAfterMs,
      quota: this.quota(installId),
    });

    if (this.#installs.used(installId) + n > l.postsPerDayPerInstall) {
      return deny("daily_limit", this.#resetAt() - this.#now());
    }
    if (this.#ips.used(ip) + n > l.postsPerDayPerIp) {
      return deny("daily_limit", this.#resetAt() - this.#now());
    }
    if (this.#global.used("*") + n > l.globalPostsPerDay) {
      return deny("service_busy", this.#resetAt() - this.#now());
    }
    const wait = this.#bursts.waitMs(installId, n);
    if (wait > 0) {
      return deny("burst_limit", Number.isFinite(wait) ? wait : MINUTE_MS);
    }

    this.#installs.add(installId, n);
    this.#ips.add(ip, n);
    this.#global.add("*", n);
    this.#bursts.take(installId, n);
    return { ok: true, quota: this.quota(installId) };
  }

  /** Give back quota for posts we failed to classify. */
  refund({ installId, ip }, n) {
    if (n <= 0) return;
    this.#installs.refund(installId, n);
    this.#ips.refund(ip, n);
    this.#global.refund("*", n);
  }

  allowRegistration(ip) {
    if (this.#registrations.used(ip) >= this.#limits.registrationsPerDayPerIp) return false;
    this.#registrations.add(ip, 1);
    return true;
  }

  quota(installId) {
    const limit = this.#limits.postsPerDayPerInstall;
    return {
      limit,
      remaining: Math.max(0, limit - this.#installs.used(installId)),
      resetAt: new Date(this.#resetAt()).toISOString(),
    };
  }

  stats() {
    return {
      postsToday: this.#global.used("*"),
      activeInstallsToday: this.#installs.size,
    };
  }

  sweep() {
    this.#bursts.sweep();
  }
}
