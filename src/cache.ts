import { type Cache as CacheEngine, increment as engineIncrement } from '@mohamedhabibwork/cachekit';
import { createMemoryEngine, createRedisEngine, DRIVER_CAPABILITIES } from './cachekit';
import { CACHE_ERROR_CODES, CacheError, mapCounterError, mapDriverError } from './errors';
import { serializeCacheValue } from './serialization';
import type { Cache, CacheCapabilities, CacheDriverKind, IncrementOptions, RedisCacheOptions } from './types';
import { assertTtlSeconds, ttlSecondsToMs } from './validate';

/**
 * Concurrent counter writers queue on the engine's lock instead of failing:
 * cachekit's locks give up immediately by default, which would turn a benign
 * increment race into a spurious rejection.
 */
const COUNTER_LOCK_WAIT_MS = 5000;

/**
 * Application cache over a cachekit engine (spec §7). The engine owns storage,
 * TTL, serialization and locking; this class translates the framework's
 * contract onto it: misses are `null`, values are validated as JSON up front,
 * TTLs are expressed in seconds, failures are wrapped into catalogued
 * `CacheError`s, and unsupported engine operations (redis namespace clear,
 * prefix-scoped clear) surface as `CACHE_UNSUPPORTED_OPERATION` instead of
 * being re-emulated.
 */
export class CachekitCache implements Cache {
  readonly capabilities: CacheCapabilities;
  readonly #engine: Promise<CacheEngine>;

  constructor(kind: CacheDriverKind, engine: CacheEngine | Promise<CacheEngine>) {
    this.#engine = Promise.resolve(engine);
    this.capabilities = { ...DRIVER_CAPABILITIES[kind] };
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await (await this.#engine).get<T>(key);
      return value === undefined ? null : value;
    } catch (error) {
      throw mapDriverError(`cache.get("${key}")`, error);
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) assertTtlSeconds(ttlSeconds, `set("${key}")`);
    // Enforce the serialization contract before the engine sees the value.
    serializeCacheValue(value);
    try {
      const engine = await this.#engine;
      await engine.set(key, value, ttlSeconds === undefined ? {} : { ttl: ttlSecondsToMs(ttlSeconds) });
    } catch (error) {
      throw mapDriverError(`cache.set("${key}")`, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      return (await (await this.#engine).delete(key)).deleted;
    } catch (error) {
      throw mapDriverError(`cache.delete("${key}")`, error);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return await (await this.#engine).has(key);
    } catch (error) {
      throw mapDriverError(`cache.has("${key}")`, error);
    }
  }

  async remember<T>(key: string, ttlSeconds: number, factory: () => T | Promise<T>): Promise<T> {
    assertTtlSeconds(ttlSeconds, `remember("${key}")`);
    try {
      // The engine deduplicates concurrent loads; values still pass the
      // serialization contract before they are stored.
      return await (
        await this.#engine
      ).getOrSet<T>(
        key,
        async () => {
          const value = await factory();
          serializeCacheValue(value);
          return value;
        },
        { ttl: ttlSecondsToMs(ttlSeconds) },
      );
    } catch (error) {
      throw mapDriverError(`cache.remember("${key}")`, error);
    }
  }

  async increment(key: string, options?: IncrementOptions): Promise<number> {
    const by = options?.by ?? 1;
    const ttlSeconds = options?.ttlSeconds;
    if (ttlSeconds !== undefined) assertTtlSeconds(ttlSeconds, `increment("${key}")`);
    try {
      // The engine's counter is a fixed-window counter: the TTL applies only
      // when the counter is created and later increments never extend it.
      return await engineIncrement(await this.#engine, key, {
        by,
        ...(ttlSeconds === undefined ? {} : { ttl: ttlSecondsToMs(ttlSeconds) }),
        lock: { wait: COUNTER_LOCK_WAIT_MS },
      });
    } catch (error) {
      throw mapCounterError(`cache.increment("${key}")`, error);
    }
  }

  async decrement(key: string, options?: IncrementOptions): Promise<number> {
    return this.increment(key, { ...options, by: -(options?.by ?? 1) });
  }

  async clear(prefix?: string): Promise<number> {
    if (prefix !== undefined) {
      throw new CacheError(
        CACHE_ERROR_CODES.UNSUPPORTED,
        `cache.clear("${prefix}"): the engine has no prefix-scoped clear; clear the namespace or delete known keys`,
      );
    }
    try {
      return (await (await this.#engine).clear()).deleted;
    } catch (error) {
      throw mapDriverError('cache.clear', error);
    }
  }

  async close(): Promise<void> {
    await (await this.#engine).close();
  }
}

/** In-process cache for development and tests, backed by cachekit's memory engine. */
export class MemoryCache extends CachekitCache {
  constructor() {
    super('memory', createMemoryEngine());
  }
}

/**
 * Shared-state cache backed by cachekit's Redis-protocol engine over Bun's
 * native `RedisClient` (spec §7). Keys are namespaced under
 * `<prefix>:cache:` + the engine's namespace separator so several apps can
 * share one Redis without crosstalk; `clear` is refused by the engine — it
 * never issues FLUSHDB/FLUSHALL against the shared database.
 */
export class RedisCache extends CachekitCache {
  constructor(options: RedisCacheOptions) {
    super('redis', createRedisEngine(options, 'cache'));
  }
}
