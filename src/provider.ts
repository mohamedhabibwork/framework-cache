import { ConfigError, defineProvider, type ServiceProvider } from '@framework/core';
import { z } from 'zod/v4';
import { MemoryCache, RedisCache } from './cache';
import { CACHE, LOCK_STORE, RATE_LIMITER } from './constants';
import { MemoryLockStore, RedisLockStore } from './locks';
import { MemoryRateLimiter, RedisRateLimiter } from './rate-limiter';
import type { Cache, CacheProviderConfig, LockStore, RateLimiter, RedisCacheOptions } from './types';

export const cacheConfigSchema = z.object({
  driver: z.enum(['memory', 'redis']).default('memory'),
  redis: z
    .object({
      url: z.string().min(1),
      prefix: z.string().min(1),
    })
    .optional(),
  /** Engine options forwarded to cachekit (default TTL, memory entry cap). */
  options: z
    .object({
      defaultTtlSeconds: z.number().positive().optional(),
      maxEntries: z.number().int().positive().optional(),
    })
    .optional(),
});

/**
 * Builds the application cache stack from configuration (spec §7):
 * `driver: 'memory'` for development/tests, `driver: 'redis'` for state shared
 * across instances. Registers `CACHE`, `LOCK_STORE` and `RATE_LIMITER` on one
 * driver; Redis services each own a dedicated connection and are closed with
 * the container.
 *
 * This is application caching. It is conceptually separate from Hono's HTTP
 * response cache (`hono/cache` middleware over the Web Cache API) — never
 * reuse `CACHE` to store HTTP responses.
 */
export const createCacheProvider = <TConfig extends object>(
  select: (config: TConfig) => CacheProviderConfig,
): ServiceProvider<TConfig> =>
  defineProvider<TConfig>({
    name: 'cache',
    register({ container, config }) {
      const parsed = cacheConfigSchema.safeParse(select(config));
      if (!parsed.success) {
        throw new ConfigError(parsed.error.issues.map((issue) => `cache.${issue.path.join('.')}: ${issue.message}`));
      }
      const redis: RedisCacheOptions | undefined =
        parsed.data.driver === 'redis' ? requireRedisOptions(parsed.data.redis) : undefined;

      const engineOptions = {
        ...(parsed.data.options?.defaultTtlSeconds !== undefined
          ? { defaultTtlMs: Math.max(1, Math.round(parsed.data.options.defaultTtlSeconds * 1000)) }
          : {}),
        ...(parsed.data.options?.maxEntries !== undefined ? { maxEntries: parsed.data.options.maxEntries } : {}),
      };
      const cache: Cache = redis ? new RedisCache(redis, engineOptions) : new MemoryCache(engineOptions);
      const locks: LockStore = redis ? new RedisLockStore(redis) : new MemoryLockStore();
      const limiter: RateLimiter = redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();

      container.singleton(
        CACHE,
        () => cache,
        (instance) => instance.close(),
      );
      container.singleton(
        LOCK_STORE,
        () => locks,
        (instance) => instance.close(),
      );
      container.singleton(
        RATE_LIMITER,
        () => limiter,
        (instance) => instance.close(),
      );
    },
  });

function requireRedisOptions(redis: RedisCacheOptions | undefined): RedisCacheOptions {
  if (!redis) {
    throw new ConfigError(['cache.driver: "redis" requires cache.redis.url and cache.redis.prefix']);
  }
  return redis;
}
