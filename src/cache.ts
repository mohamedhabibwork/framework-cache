import { type Cache as CacheEngine, increment as engineIncrement } from '@mohamedhabibwork/cachekit';
import { createMemoryEngine, createRedisEngine, DRIVER_CAPABILITIES } from './cachekit';
import { CACHE_ERROR_CODES, CacheError, mapCounterError, mapDriverError } from './errors';
import { serializeCacheValue } from './serialization';
import type {
  Cache,
  CacheCapabilities,
  CacheDriverKind,
  CacheEntryInput,
  CacheHealth,
  GetOptions,
  GetOrSetOptions,
  IncrementOptions,
  RedisCacheOptions,
  SetOptions,
  TagInvalidationResult,
} from './types';
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

  async get<T>(key: string, options: GetOptions = {}): Promise<T | null> {
    try {
      const value = await (await this.#engine).get<T>(key, engineGetOptions(options));
      return value === undefined ? null : value;
    } catch (error) {
      throw mapDriverError(`cache.get("${key}")`, error);
    }
  }

  async set<T>(key: string, value: T, ttlOrOptions: number | SetOptions = {}): Promise<void> {
    const options: SetOptions = typeof ttlOrOptions === 'number' ? { ttlSeconds: ttlOrOptions } : ttlOrOptions;
    assertSetOptions(key, options);
    // Enforce the serialization contract before the engine sees the value.
    serializeCacheValue(value);
    try {
      const engine = await this.#engine;
      await engine.set(key, value, engineSetOptions(options));
    } catch (error) {
      throw mapDriverError(`cache.set("${key}")`, error);
    }
  }

  async getMany<T>(keys: readonly string[], options: GetOptions = {}): Promise<Map<string, T>> {
    if (keys.length === 0) return new Map();
    try {
      return await (await this.#engine).getMany<T>(keys, engineGetOptions(options));
    } catch (error) {
      throw mapDriverError('cache.getMany', error);
    }
  }

  async setMany(entries: readonly CacheEntryInput[], options: SetOptions = {}): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      assertSetOptions(entry.key, entry.options ?? {});
      serializeCacheValue(entry.value);
    }
    try {
      const engine = await this.#engine;
      await engine.setMany(
        entries.map((entry) => ({
          key: entry.key,
          value: entry.value,
          options: { ...engineSetOptions(options), ...engineSetOptions(entry.options ?? {}) },
        })),
      );
    } catch (error) {
      throw mapDriverError('cache.setMany', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      return (await (await this.#engine).delete(key)).deleted;
    } catch (error) {
      throw mapDriverError(`cache.delete("${key}")`, error);
    }
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      return await (await this.#engine).deleteMany(keys);
    } catch (error) {
      throw mapDriverError('cache.deleteMany', error);
    }
  }

  async has(key: string, options: GetOptions = {}): Promise<boolean> {
    try {
      return await (await this.#engine).has(key, engineGetOptions(options));
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

  async getOrSet<T>(
    key: string,
    loader: (context: { signal: AbortSignal }) => T | Promise<T>,
    options: GetOrSetOptions = {},
  ): Promise<T> {
    assertSetOptions(key, options);
    try {
      return await (
        await this.#engine
      ).getOrSet<T>(
        key,
        async ({ signal }) => {
          const value = await loader({ signal });
          serializeCacheValue(value);
          return value;
        },
        {
          ...engineSetOptions(options),
          ...(options.serveStale !== undefined ? { serveStale: options.serveStale } : {}),
        },
      );
    } catch (error) {
      throw mapDriverError(`cache.getOrSet("${key}")`, error);
    }
  }

  async touch(key: string, ttlSeconds: number, options: GetOptions = {}): Promise<boolean> {
    assertTtlSeconds(ttlSeconds, `touch("${key}")`);
    try {
      return await (await this.#engine).touch(key, ttlSecondsToMs(ttlSeconds), engineGetOptions(options));
    } catch (error) {
      throw mapDriverError(`cache.touch("${key}")`, error);
    }
  }

  async invalidateTags(tags: readonly string[], options: GetOptions = {}): Promise<TagInvalidationResult> {
    if (tags.length === 0) return { invalidated: 0, mode: 'delete' };
    if (!this.capabilities.tags) {
      throw new CacheError(
        CACHE_ERROR_CODES.UNSUPPORTED,
        'cache.invalidateTags: this driver has no tag index; delete the known keys instead',
      );
    }
    try {
      return await (await this.#engine).invalidateTags(tags, engineGetOptions(options));
    } catch (error) {
      throw mapDriverError('cache.invalidateTags', error);
    }
  }

  async health(): Promise<CacheHealth> {
    try {
      return await (await this.#engine).health();
    } catch (error) {
      throw mapDriverError('cache.health', error);
    }
  }

  async native(): Promise<unknown> {
    try {
      return await (await this.#engine).native();
    } catch (error) {
      // The memory engine has no client; surface the catalogued code instead of
      // the kit's own error class.
      throw mapDriverError('cache.native', error);
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
  constructor(options: { readonly defaultTtlMs?: number; readonly maxEntries?: number } = {}) {
    super('memory', createMemoryEngine(options));
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
  constructor(options: RedisCacheOptions, engineOptions: { readonly defaultTtlMs?: number } = {}) {
    super('redis', createRedisEngine(options, 'cache', engineOptions));
  }
}

/**
 * Rejects an option the driver cannot honour instead of silently dropping it:
 * asking for tags on the Redis driver would otherwise look like it worked and
 * invalidate nothing.
 */
function assertSetOptions(key: string, options: SetOptions): void {
  if (options.ttlSeconds !== undefined) assertTtlSeconds(options.ttlSeconds, `set("${key}")`);
  if (options.staleTtlSeconds !== undefined) assertTtlSeconds(options.staleTtlSeconds, `set("${key}")`);
}

/** Maps framework {@link SetOptions} onto cachekit's `SetOptions` (ms TTLs). */
function engineSetOptions(options: SetOptions): Record<string, unknown> {
  return {
    ...(options.ttlSeconds !== undefined ? { ttl: ttlSecondsToMs(options.ttlSeconds) } : {}),
    ...(options.staleTtlSeconds !== undefined ? { staleTtl: ttlSecondsToMs(options.staleTtlSeconds) } : {}),
    ...(options.tags !== undefined ? { tags: [...options.tags] } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.native !== undefined ? { native: options.native } : {}),
  };
}

/** Maps framework {@link GetOptions} onto cachekit's `GetOptions`. */
function engineGetOptions(options: GetOptions): Record<string, unknown> {
  return {
    ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.native !== undefined ? { native: options.native } : {}),
  };
}
