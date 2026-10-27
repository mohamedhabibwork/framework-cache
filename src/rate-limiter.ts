import { type Cache as CacheEngine, increment as engineIncrement } from '@mohamedhabibwork/cachekit';
import { createMemoryEngine, createRedisEngine } from './cachekit';
import { mapCounterError, mapDriverError } from './errors';
import type { RateLimiter, RateLimitResult, RedisCacheOptions } from './types';
import { assertPositiveInt, assertTtlSeconds, ttlSecondsToMs } from './validate';

/**
 * Concurrent consumers queue on the engine's lock instead of failing: every
 * `consume` counts, so a rejected increment would silently under-count.
 */
const CONSUME_LOCK_WAIT_MS = 5000;

/**
 * Fixed-window rate limiter over a cachekit engine (login throttling,
 * security limits). The engine's `increment` is a fixed-window counter — the
 * TTL is applied when the counter is created and never extended — so windows
 * reset on their own even if a client crashes mid-window. Counters are shared
 * across instances on redis, so limits hold cluster-wide. Every `consume`
 * counts, including rejected attempts; failures reject with catalogued
 * `CacheError`s and security callers must fail closed, never bypass.
 */
export class CachekitRateLimiter implements RateLimiter {
  readonly #engine: Promise<CacheEngine>;

  constructor(engine: CacheEngine | Promise<CacheEngine>) {
    this.#engine = Promise.resolve(engine);
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    assertPositiveInt(limit, 'limit', `consume("${key}")`);
    assertTtlSeconds(windowSeconds, `consume("${key}") window`);
    try {
      const engine = await this.#engine;
      const count = await engineIncrement(engine, key, {
        ttl: ttlSecondsToMs(windowSeconds),
        lock: { wait: CONSUME_LOCK_WAIT_MS },
      });
      const allowed = count <= limit;
      if (allowed) {
        return { allowed, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
      }
      // The engine stamps an absolute expiry when the window was created; read
      // it back for retry-after instead of guessing the window boundary.
      const entry = await engine.getEntry(key);
      const resetAt = entry?.expiresAt ?? Date.now();
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
    } catch (error) {
      throw mapCounterError(`rateLimit.consume("${key}")`, error);
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await (await this.#engine).delete(key);
    } catch (error) {
      throw mapDriverError(`rateLimit.reset("${key}")`, error);
    }
  }

  async close(): Promise<void> {
    await (await this.#engine).close();
  }
}

/** In-process fixed-window limiter for development and tests, backed by cachekit's memory engine. */
export class MemoryRateLimiter extends CachekitRateLimiter {
  constructor() {
    super(createMemoryEngine());
  }
}

/**
 * Fixed-window limiter over cachekit's Redis-protocol engine; counters are
 * namespaced under `<prefix>:ratelimit:` + the engine's namespace separator.
 */
export class RedisRateLimiter extends CachekitRateLimiter {
  constructor(options: RedisCacheOptions) {
    super(createRedisEngine(options, 'ratelimit'));
  }
}
