/**
 * Engine wiring for `@mohamedhabibwork/cachekit` (storage delegation).
 *
 * The framework keeps deciding drivers and configuration; cachekit is the
 * storage engine underneath. The Redis driver speaks to Redis through Bun's
 * native `RedisClient` adapted to cachekit's injectable `sendCommand` client
 * surface — the optional `redis` SDK is never needed. Each driver owns one
 * physical key scope (`<prefix>:<scope>:` + cachekit's internal namespace
 * separator), so several apps can share one Redis without crosstalk.
 */
import { type Cache as CacheEngine, createMemoryCache, createRedisCompatibleCache } from '@mohamedhabibwork/cachekit';
import type { RedisClient as CacheKitRedisClient } from '@mohamedhabibwork/cachekit/redis';
import { RedisClient as BunRedisClient } from 'bun';
import type { CacheDriverKind, RedisCacheOptions } from './types';

/** Physical key scopes one Redis driver owns inside the shared keyspace. */
export type RedisScope = 'cache' | 'locks' | 'ratelimit';

/**
 * cachekit's internal namespace separator: keys are stored as
 * `<namespace><separator><key>`. Exposed for operations that must address
 * physical keys (the owner-token release EVAL) and for tests that plant raw
 * payloads.
 */
export const NAMESPACE_SEPARATOR = '\u001f';

/** Framework capability view mapped from cachekit's capability matrix per engine kind. */
export const DRIVER_CAPABILITIES: Record<
  CacheDriverKind,
  {
    atomicIncrement: boolean;
    locking: boolean;
    tags: boolean;
    clearNamespace: boolean;
    distributedLocks: boolean;
  }
> = {
  // Memory: in-process TTL, tags and namespace clear are native; locks are
  // process-wide mutexes, not distributed.
  memory: { atomicIncrement: true, locking: true, tags: true, clearNamespace: true, distributedLocks: false },
  // Redis-protocol: distributed locks and atomic set-if-absent are native;
  // tags and namespace clear are deliberately unsupported by the engine.
  redis: { atomicIncrement: true, locking: true, tags: false, clearNamespace: false, distributedLocks: true },
};

/**
 * Bun's native `RedisClient` behind cachekit's injectable client surface.
 * Bun replies (status strings, integers, nil) already match what the engine
 * parses; the adapter only translates the call shape and makes `close`
 * idempotent.
 */
class BunRedisTransport implements CacheKitRedisClient {
  readonly #client: BunRedisClient;
  #closed = false;

  constructor(url: string) {
    this.#client = new BunRedisClient(url);
  }

  async sendCommand(command: readonly string[]): Promise<string | number | null> {
    const [name, ...args] = command;
    if (name === undefined) {
      throw new Error('Redis command must have a name');
    }
    if (this.#closed) {
      throw new Error('Redis client is closed');
    }
    return this.#client.send(name, args);
  }

  async quit(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#client.close();
  }
}

/** Creates the in-process cachekit engine behind the memory driver. */
export function createMemoryEngine(): CacheEngine<'memory'> {
  // No cachekit namespace: memory keys stay exactly as the application wrote them.
  return createMemoryCache();
}

/**
 * The physical key namespace a Redis driver owns for `scope`:
 * `<prefix>:<scope>:` (cachekit appends its internal separator on every key).
 */
export function redisNamespace(options: RedisCacheOptions, scope: RedisScope): string {
  return `${options.prefix}:${scope}:`;
}

/**
 * Creates the Redis-protocol cachekit engine behind the redis driver, scoped
 * to `<prefix>:<scope>:` so cache keys, locks and rate-limit counters never
 * share key ranges.
 */
export function createRedisEngine(options: RedisCacheOptions, scope: RedisScope): Promise<CacheEngine<'redis'>> {
  return createRedisCompatibleCache('redis', {
    client: new BunRedisTransport(options.url),
    namespace: redisNamespace(options, scope),
  });
}
