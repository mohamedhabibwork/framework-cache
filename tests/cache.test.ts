import { afterAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import {
  CACHE_ERROR_CODES,
  CacheError,
  MemoryCache,
  MemoryLockStore,
  MemoryRateLimiter,
  RedisCache,
  RedisLockStore,
  RedisRateLimiter,
} from '../src';
import { createMemoryEngine, createRedisEngine, NAMESPACE_SEPARATOR } from '../src/cachekit';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');

const prefix = `test-cache-${crypto.randomUUID()}`;
const otherPrefix = `${prefix}-other`;

/**
 * Physical key of a namespaced cache key: cachekit stores namespaced keys as
 * `<namespace><separator><key>`, so raw-key assertions (planting corrupt
 * payloads, reading TTLs) must address the engine's layout.
 */
function physical(namespace: string, key: string): string {
  return `${namespace}${NAMESPACE_SEPARATOR}${key}`;
}

const cacheNamespace = `${prefix}:cache:`;
const rateLimitNamespace = `${prefix}:ratelimit:`;

/** Deletes every key under a test namespace with SCAN/DEL — never FLUSHDB. */
async function purgeNamespace(client: RedisClient, namespace: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await client.del(...keys);
  } while (cursor !== '0');
}

describe('MemoryCache', () => {
  const cache = new MemoryCache();

  test('reports its capabilities, mapped from the cachekit engine', () => {
    const engine = createMemoryEngine();
    expect(cache.capabilities).toEqual({
      atomicIncrement: true,
      locking: true,
      tags: engine.capabilities.tags !== 'unsupported',
      clearNamespace: engine.capabilities.clearNamespace !== 'unsupported',
      distributedLocks: engine.capabilities.distributedLocks !== 'unsupported',
    });
    // The memory engine has tags and namespace clear, but only process-local locks.
    expect(cache.capabilities).toEqual({
      atomicIncrement: true,
      locking: true,
      tags: true,
      clearNamespace: true,
      distributedLocks: false,
    });
  });

  test('expires entries after their TTL', async () => {
    await cache.set('ttl:key', { n: 1 }, 0.05);
    expect(await cache.get<{ n: number }>('ttl:key')).toEqual({ n: 1 });
    expect(await cache.has('ttl:key')).toBe(true);
    await Bun.sleep(80);
    expect(await cache.get('ttl:key')).toBeNull();
    expect(await cache.has('ttl:key')).toBe(false);
    expect(await cache.delete('ttl:key')).toBe(false);
  });

  test('rejects non-JSON values and invalid TTLs', async () => {
    expect(cache.set('bad:value', () => 1)).rejects.toMatchObject({ code: CACHE_ERROR_CODES.SERIALIZATION });
    expect(cache.set('bad:ttl', 1, 0)).rejects.toMatchObject({ code: CACHE_ERROR_CODES.INVALID_TTL });
    expect(cache.remember('bad:ttl', -1, () => 1)).rejects.toMatchObject({ code: CACHE_ERROR_CODES.INVALID_TTL });
  });

  test('remember memoizes the factory until the TTL passes', async () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return calls * 7;
    };
    expect(await cache.remember('memo', 1, factory)).toBe(7);
    expect(await cache.remember('memo', 1, factory)).toBe(7);
    expect(calls).toBe(1);
    await Bun.sleep(1100);
    expect(await cache.remember('memo', 1, factory)).toBe(14);
    expect(calls).toBe(2);
  });

  test('increments and decrements atomically with expire-on-first-increment', async () => {
    expect(await cache.increment('counter:a')).toBe(1);
    expect(await cache.increment('counter:a', { by: 4 })).toBe(5);
    expect(await cache.decrement('counter:a')).toBe(4);
    expect(await cache.decrement('counter:a', { by: 2 })).toBe(2);
    expect(await cache.get<number>('counter:a')).toBe(2);

    // ttlSeconds applies only when the counter is created.
    expect(await cache.increment('counter:b', { by: 5, ttlSeconds: 0.05 })).toBe(5);
    await Bun.sleep(80);
    expect(await cache.increment('counter:b')).toBe(1);
  });

  test('refuses to increment non-integer values', async () => {
    await cache.set('counter:bad', 'not-a-number');
    expect(cache.increment('counter:bad')).rejects.toMatchObject({ code: CACHE_ERROR_CODES.NOT_INTEGER });
  });

  test('clear() empties the namespace; prefix-scoped clear is unsupported', async () => {
    await cache.set('orders:1', 'a');
    await cache.set('users:1', 'c');
    // The engine has no prefix-scoped clear: the framework surfaces that
    // instead of re-emulating a partial wipe, and nothing is deleted.
    expect(cache.clear('orders:')).rejects.toMatchObject({ code: CACHE_ERROR_CODES.UNSUPPORTED });
    expect(await cache.has('orders:1')).toBe(true);
    expect(await cache.has('users:1')).toBe(true);
    // Whole-namespace clear stays native on the memory engine.
    expect(await cache.clear()).toBeGreaterThanOrEqual(2);
    expect(await cache.has('orders:1')).toBe(false);
    expect(await cache.has('users:1')).toBe(false);
  });
});

describe('MemoryLockStore', () => {
  const locks = new MemoryLockStore();
  const stranger = new MemoryLockStore();

  test('exclusive acquire, owner-only release, expiry', async () => {
    expect(await locks.acquire('mem-lock', 5000)).toBe(true);
    expect(await locks.acquire('mem-lock', 5000)).toBe(false);
    expect(await stranger.release('mem-lock')).toBe(false);
    expect(await locks.release('mem-lock')).toBe(true);

    expect(await locks.acquire('mem-lock', 50)).toBe(true);
    await Bun.sleep(80);
    expect(await stranger.acquire('mem-lock', 5000)).toBe(true);
  });

  test('withLock runs the fn and refuses while the lock is held', async () => {
    expect(await locks.withLock('mem-with', 5000, () => 41 + 1)).toBe(42);
    expect(await locks.acquire('mem-with', 5000)).toBe(true);
    try {
      await locks.withLock('mem-with', 5000, () => 'never');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CacheError);
      expect((error as CacheError).code).toBe(CACHE_ERROR_CODES.LOCK_NOT_ACQUIRED);
    }
    expect(await locks.release('mem-with')).toBe(true);
  });
});

describe('MemoryRateLimiter (fixed window)', () => {
  const limiter = new MemoryRateLimiter();

  test('allows up to the limit, then blocks with retryAfter; the window resets', async () => {
    expect(await limiter.consume('login', 2, 0.3)).toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    expect(await limiter.consume('login', 2, 0.3)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = await limiter.consume('login', 2, 0.3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    await Bun.sleep(450);
    expect(await limiter.consume('login', 2, 0.3)).toMatchObject({ allowed: true, remaining: 1 });
  });

  test('reset() clears a window immediately', async () => {
    expect(await limiter.consume('reset', 1, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect((await limiter.consume('reset', 1, 60)).allowed).toBe(false);
    await limiter.reset('reset');
    expect(await limiter.consume('reset', 1, 60)).toMatchObject({ allowed: true, remaining: 0 });
  });
});

describe('RedisCache (real Redis)', () => {
  const cache = new RedisCache({ url: redisUrl, prefix });
  const replica = new RedisCache({ url: redisUrl, prefix }); // second connection, same namespace
  const foreign = new RedisCache({ url: redisUrl, prefix: otherPrefix }); // separate namespace
  const raw = new RedisClient(redisUrl);

  afterAll(async () => {
    await Promise.all([cache.close(), replica.close(), foreign.close()]);
    await purgeNamespace(raw, prefix);
    await purgeNamespace(raw, otherPrefix);
    raw.close();
  });

  test('reports its capabilities, mapped from the cachekit engine', async () => {
    const engine = await createRedisEngine({ url: redisUrl, prefix: `${prefix}-capprobe` }, 'cache');
    try {
      expect(cache.capabilities).toEqual({
        atomicIncrement: true,
        locking: true,
        tags: engine.capabilities.tags !== 'unsupported',
        clearNamespace: engine.capabilities.clearNamespace !== 'unsupported',
        distributedLocks: engine.capabilities.distributedLocks !== 'unsupported',
      });
      // The redis engine has distributed locks, but tags and namespace clear
      // are deliberately unsupported there.
      expect(cache.capabilities).toEqual({
        atomicIncrement: true,
        locking: true,
        tags: false,
        clearNamespace: false,
        distributedLocks: true,
      });
    } finally {
      await engine.close();
    }
  });

  test('round-trips values and expires after the TTL', async () => {
    await cache.set('user:1', { id: 'u1', roles: ['admin'] }, 60);
    expect(await replica.get<{ id: string; roles: string[] }>('user:1')).toEqual({ id: 'u1', roles: ['admin'] });
    await cache.set('user:short', 'gone-soon', 0.05);
    await Bun.sleep(80);
    expect(await cache.get('user:short')).toBeNull();
  });

  test('is visible across independent connections (shared state)', async () => {
    await cache.set('shared', [1, 2, 3]);
    const seen = await replica.get<number[]>('shared');
    expect(seen).toEqual([1, 2, 3]);
    await replica.delete('shared');
    expect(await cache.has('shared')).toBe(false);
  });

  test('remember memoizes the factory until the TTL passes', async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { calls };
    };
    expect(await cache.remember('redis-memo', 60, factory)).toEqual({ calls: 1 });
    expect(await replica.remember('redis-memo', 60, factory)).toEqual({ calls: 1 });
    expect(calls).toBe(1);
    await cache.delete('redis-memo');
    expect(await cache.remember('redis-memo', 60, factory)).toEqual({ calls: 2 });
  });

  test('increments across connections with expire-on-first-increment', async () => {
    expect(await cache.increment('redis-counter')).toBe(1);
    expect(await replica.increment('redis-counter', { by: 4 })).toBe(5);
    expect(await cache.decrement('redis-counter')).toBe(4);

    // ttlSeconds applies only on the first increment; later increments must
    // not extend the original window.
    expect(await cache.increment('redis-ttl', { ttlSeconds: 2 })).toBe(1);
    const ttlMsAfterFirst = await raw.pttl(physical(cacheNamespace, 'redis-ttl'));
    expect(ttlMsAfterFirst).toBeGreaterThan(0);
    expect(ttlMsAfterFirst).toBeLessThanOrEqual(2000);
    expect(await replica.increment('redis-ttl')).toBe(2);
    const ttlMsAfterSecond = await raw.pttl(physical(cacheNamespace, 'redis-ttl'));
    expect(ttlMsAfterSecond).toBeGreaterThan(0);
    expect(ttlMsAfterSecond).toBeLessThanOrEqual(ttlMsAfterFirst);
  });

  test('rejects corrupt payloads and non-integer counters with catalogued errors', async () => {
    await raw.set(physical(cacheNamespace, 'corrupt'), 'not-json{');
    expect(cache.get('corrupt')).rejects.toMatchObject({ code: CACHE_ERROR_CODES.DESERIALIZATION });
    await raw.set(physical(cacheNamespace, 'stringish'), 'plain');
    expect(cache.increment('stringish')).rejects.toMatchObject({ code: CACHE_ERROR_CODES.NOT_INTEGER });
  });

  test('clear is unsupported by the engine and leaves every namespace untouched', async () => {
    await cache.set('orders:1', 'a');
    await foreign.set('orders:1', 'other-namespace');

    // Neither a prefix-scoped nor a namespace-wide clear is offered over
    // redis; callers delete known keys instead (never FLUSHDB by accident).
    expect(cache.clear('orders:')).rejects.toMatchObject({ code: CACHE_ERROR_CODES.UNSUPPORTED });
    expect(cache.clear()).rejects.toMatchObject({ code: CACHE_ERROR_CODES.UNSUPPORTED });
    expect(await cache.has('orders:1')).toBe(true);
    expect(await foreign.get<string>('orders:1')).toBe('other-namespace');

    // Known-key deletion stays the supported path.
    expect(await cache.delete('orders:1')).toBe(true);
    expect(await cache.has('orders:1')).toBe(false);
    expect(await foreign.delete('orders:1')).toBe(true);
  });
});

describe('RedisLockStore (real Redis)', () => {
  const locks = new RedisLockStore({ url: redisUrl, prefix });
  const stranger = new RedisLockStore({ url: redisUrl, prefix });
  const raw = new RedisClient(redisUrl);

  afterAll(async () => {
    await Promise.all([locks.close(), stranger.close()]);
    await purgeNamespace(raw, prefix);
    raw.close();
  });

  test('concurrent acquirers produce exactly one winner', async () => {
    const attempts = await Promise.all([
      ...Array.from({ length: 8 }, () => locks.acquire('contention', 5000)),
      stranger.acquire('contention', 5000),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    // Exactly one of the two stores owns it; the other's release is a no-op.
    const ownedByLocks = await locks.release('contention');
    if (!ownedByLocks) expect(await stranger.release('contention')).toBe(true);
  });

  test('release only succeeds for the owner token', async () => {
    expect(await locks.acquire('owned', 5000)).toBe(true);
    expect(await stranger.release('owned')).toBe(false);
    expect(await stranger.acquire('owned', 5000)).toBe(false);
    expect(await locks.release('owned')).toBe(true);
    // Now free again — the stranger can take it and only it may release.
    expect(await stranger.acquire('owned', 5000)).toBe(true);
    expect(await locks.release('owned')).toBe(false);
    expect(await stranger.release('owned')).toBe(true);
  });

  test('withLock returns the fn result and throws when the lock is held', async () => {
    expect(await locks.withLock('redis-with', 5000, async () => 40 + 2)).toBe(42);
    expect(await locks.acquire('redis-with', 5000)).toBe(true);
    try {
      await stranger.withLock('redis-with', 5000, () => 'never');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CacheError);
      expect((error as CacheError).code).toBe(CACHE_ERROR_CODES.LOCK_NOT_ACQUIRED);
    }
    expect(await locks.release('redis-with')).toBe(true);
  });

  test('expired locks are reacquirable', async () => {
    expect(await locks.acquire('ttl-lock', 60)).toBe(true);
    expect(await stranger.acquire('ttl-lock', 5000)).toBe(false);
    await Bun.sleep(120);
    expect(await stranger.acquire('ttl-lock', 5000)).toBe(true);
    expect(await stranger.release('ttl-lock')).toBe(true);
  });
});

describe('RedisRateLimiter (real Redis, fixed window)', () => {
  const limiter = new RedisRateLimiter({ url: redisUrl, prefix });
  const replica = new RedisRateLimiter({ url: redisUrl, prefix });
  const raw = new RedisClient(redisUrl);

  afterAll(async () => {
    await Promise.all([limiter.close(), replica.close()]);
    await purgeNamespace(raw, prefix);
    raw.close();
  });

  test('counts across connections, allows up to the limit, then blocks with retryAfter', async () => {
    expect(await limiter.consume('login', 3, 0.3)).toMatchObject({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    expect(await replica.consume('login', 3, 0.3)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await limiter.consume('login', 3, 0.3)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = await replica.consume('login', 3, 0.3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // The window key carries a TTL so a crashed client cannot block forever.
    expect(await raw.pttl(physical(rateLimitNamespace, 'login'))).toBeGreaterThan(0);
  });

  test('the window resets after it passes', async () => {
    await Bun.sleep(450);
    expect(await limiter.consume('login', 3, 0.3)).toMatchObject({ allowed: true, remaining: 2 });
  });

  test('reset() clears a window immediately', async () => {
    expect(await limiter.consume('reset', 1, 60)).toMatchObject({ allowed: true, remaining: 0 });
    expect((await replica.consume('reset', 1, 60)).allowed).toBe(false);
    await limiter.reset('reset');
    expect(await replica.consume('reset', 1, 60)).toMatchObject({ allowed: true, remaining: 0 });
  });
});
