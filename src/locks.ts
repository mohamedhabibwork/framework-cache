import { addIfAbsent, type Cache as CacheEngine, normalizeKey } from '@mohamedhabibwork/cachekit';
import type { RedisClient as CacheKitRedisClient } from '@mohamedhabibwork/cachekit/redis';
import { createMemoryEngine, createRedisEngine, redisNamespace } from './cachekit';
import { mapDriverError } from './errors';
import type { LockStore, RedisCacheOptions } from './types';
import { assertTtlMs } from './validate';
import { runWithLock } from './with-lock';

/**
 * Atomic compare-and-delete release, run through the engine's native client:
 * the lock key holds the acquirer's owner token, so only a release carrying
 * the same token deletes the key and a stale or foreign release can never
 * drop someone else's lock.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Runs one raw command on the engine's native redis client. The generic
 * engine types the native client as unknown, so the lock store narrows it
 * here — the only place raw commands are ever issued.
 */
async function sendRedis(client: unknown, command: readonly string[]): Promise<string | number | null> {
  return (client as CacheKitRedisClient).sendCommand(command);
}

/**
 * Lock store over a cachekit engine, keeping the framework's contract:
 * `acquire`/`release` with owner tokens (only the acquiring store can release)
 * and expiring locks. On redis, acquisition is a raw `SET ... NX PX` and
 * release the compare-and-delete EVAL, both through the engine's own native
 * client (`nativeRequest`); on memory it is the engine's atomic
 * add-if-absent with a token compare. `withLock` composes the two.
 */
export class CachekitLockStore implements LockStore {
  readonly #engine: Promise<CacheEngine>;
  readonly #redisKey: ((name: string) => string) | null;
  /** Locks taken through this store, by name — the owner tokens it may release. */
  readonly #owned = new Map<string, string>();

  constructor(engine: CacheEngine | Promise<CacheEngine>, redisNamespace?: string) {
    this.#engine = Promise.resolve(engine);
    this.#redisKey = redisNamespace === undefined ? null : (name) => normalizeKey(name, redisNamespace);
  }

  async acquire(name: string, ttlMs: number): Promise<boolean> {
    assertTtlMs(ttlMs, `acquire("${name}")`);
    const token = crypto.randomUUID();
    try {
      const engine = await this.#engine;
      const redisKey = this.#redisKey;
      // On redis the lock value must be the raw owner token (the release EVAL
      // compares it byte-for-byte), so acquisition goes through the engine's
      // native client as a single `SET <key> <token> PX <ttl> NX` — ttlMs is
      // already milliseconds, matching the engine's numeric TTL unit.
      const stored = redisKey
        ? (await engine.nativeRequest((client) =>
            sendRedis(client, ['SET', redisKey(name), token, 'PX', String(ttlMs), 'NX']),
          )) !== null
        : await addIfAbsent(engine, name, token, { ttl: ttlMs });
      if (!stored) return false;
      this.#owned.set(name, token);
      return true;
    } catch (error) {
      throw mapDriverError(`lock.acquire("${name}")`, error);
    }
  }

  async release(name: string): Promise<boolean> {
    const token = this.#owned.get(name);
    if (token === undefined) return false;
    try {
      const engine = await this.#engine;
      const redisKey = this.#redisKey;
      let released: boolean;
      if (redisKey) {
        const result = await engine.nativeRequest((client) =>
          sendRedis(client, ['EVAL', RELEASE_SCRIPT, '1', redisKey(name), token]),
        );
        released = Number(result) === 1;
      } else {
        const current = await engine.get<string>(name);
        if (current !== token) {
          released = false;
        } else {
          await engine.delete(name);
          released = true;
        }
      }
      // Forget the token either way: it is no longer actionable if the lock
      // expired or was taken over while we were releasing.
      this.#owned.delete(name);
      return released;
    } catch (error) {
      throw mapDriverError(`lock.release("${name}")`, error);
    }
  }

  withLock<T>(name: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T> {
    return runWithLock(this, name, ttlMs, fn);
  }

  async close(): Promise<void> {
    this.#owned.clear();
    await (await this.#engine).close();
  }
}

/** Process-local lock store for development and tests, backed by cachekit's memory engine. */
export class MemoryLockStore extends CachekitLockStore {
  constructor() {
    super(createMemoryEngine());
  }
}

/**
 * Distributed lock store over cachekit's Redis-protocol engine: locks are
 * namespaced under `<prefix>:locks:` + the engine's namespace separator and
 * shared across instances, so concurrent acquirers get exactly one winner.
 * Used later for scheduler overlap and session limits; callers of `withLock`
 * decide fail-open vs fail-closed (those uses must fail closed).
 */
export class RedisLockStore extends CachekitLockStore {
  constructor(options: RedisCacheOptions) {
    super(createRedisEngine(options, 'locks'), redisNamespace(options, 'locks'));
  }
}
