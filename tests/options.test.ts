import { afterAll, describe, expect, test } from 'bun:test';
import { CACHE_ERROR_CODES, CacheError, MemoryCache, RedisCache } from '../src';

/**
 * Option-surface tests: tags, stale-while-revalidate, batch operations, TTL
 * extension and native access. Every assertion is behavioural — an option that
 * is accepted but ignored fails here.
 */

const memory = new MemoryCache();

afterAll(async () => {
  await memory.close();
});

/** Awaits a cache operation and returns its catalogued code. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CacheError) return error.code;
    throw error;
  }
  throw new Error('expected the cache operation to reject with a CacheError');
}

describe('set options', () => {
  test('a bare TTL keeps working (backwards compatible signature)', async () => {
    await memory.set('plain', { a: 1 }, 30);
    expect(await memory.get('plain')).toEqual({ a: 1 });
  });

  test('tags are recorded and invalidateTags removes the group', async () => {
    await memory.set('product:1', { id: 1 }, { tags: ['products'] });
    await memory.set('product:2', { id: 2 }, { tags: ['products'] });
    await memory.set('cart:1', { id: 1 }, { tags: ['carts'] });

    const result = await memory.invalidateTags(['products']);
    expect(result.invalidated).toBe(2);

    expect(await memory.get('product:1')).toBeNull();
    expect(await memory.get('product:2')).toBeNull();
    expect(await memory.get('cart:1')).toEqual({ id: 1 });
  });

  test('staleTtlSeconds keeps the value readable only when allowStale is set', async () => {
    await memory.set('stale-key', 'v1', { ttlSeconds: 0.05, staleTtlSeconds: 5 });
    await Bun.sleep(80);

    expect(await memory.get('stale-key')).toBeNull();
    expect(await memory.get('stale-key', { allowStale: true })).toBe('v1');
  });

  test('an invalid TTL is rejected before anything is stored', async () => {
    expect(await codeOf(memory.set('bad-ttl', 1, { ttlSeconds: -1 }))).toBe(CACHE_ERROR_CODES.INVALID_TTL);
    expect(await memory.get('bad-ttl')).toBeNull();
  });
});

describe('batch operations', () => {
  test('setMany writes every entry with its own options, getMany reads the hits', async () => {
    await memory.setMany([
      { key: 'batch:1', value: { n: 1 }, options: { tags: ['batch'] } },
      { key: 'batch:2', value: { n: 2 } },
    ]);
    const found = await memory.getMany<{ n: number }>(['batch:1', 'batch:2', 'batch:missing']);
    expect(found.size).toBe(2);
    expect(found.get('batch:1')).toEqual({ n: 1 });
    expect(found.has('batch:missing')).toBe(false);
  });

  test('deleteMany reports how many keys were removed', async () => {
    expect(await memory.deleteMany(['batch:1', 'batch:2', 'batch:missing'])).toBe(2);
  });

  test('an empty batch is a no-op', async () => {
    expect((await memory.getMany([])).size).toBe(0);
    expect(await memory.deleteMany([])).toBe(0);
  });
});

describe('read-through options', () => {
  test('getOrSet caches the loader result and deduplicates concurrent loads', async () => {
    let calls = 0;
    const loader = async (): Promise<{ n: number }> => {
      calls += 1;
      await Bun.sleep(5);
      return { n: 42 };
    };
    const [first, second] = await Promise.all([
      memory.getOrSet('flight', loader, { ttlSeconds: 30 }),
      memory.getOrSet('flight', loader, { ttlSeconds: 30 }),
    ]);
    expect(first).toEqual({ n: 42 });
    expect(second).toEqual({ n: 42 });
    expect(calls).toBe(1);
  });

  test('getOrSet serves a stale value when serveStale is set', async () => {
    await memory.set('stale-flight', 'old', { ttlSeconds: 0.05, staleTtlSeconds: 5 });
    await Bun.sleep(80);
    const value = await memory.getOrSet('stale-flight', async () => 'new', {
      ttlSeconds: 30,
      staleTtlSeconds: 5,
      serveStale: true,
    });
    expect(value).toBe('old');
  });

  test('touch extends the TTL and reports missing keys', async () => {
    await memory.set('touched', 'v', 0.1);
    expect(await memory.touch('touched', 30)).toBe(true);
    await Bun.sleep(150);
    expect(await memory.get('touched')).toBe('v');
    expect(await memory.touch('never-stored', 30)).toBe(false);
  });
});

describe('native access and health', () => {
  test('health reports the provider', async () => {
    const health = await memory.health();
    expect(health.provider).toBe('memory');
    expect(['ok', 'degraded']).toContain(health.status);
  });

  test('native() reports an unsupported capability instead of leaking the kit error', async () => {
    // The memory engine ships no client; the framework maps that to its own
    // catalogued code so callers branch on one error surface.
    expect(await codeOf(memory.native())).toBe(CACHE_ERROR_CODES.UNSUPPORTED);
  });
});

const redisUrl = process.env.REDIS_URL;

describe('driver capability honesty', () => {
  test('the Redis driver refuses tag invalidation instead of silently no-oping', async () => {
    if (!redisUrl) throw new Error('REDIS_URL is not set; run `bun run db:up` and see .env.test.example');
    const redis = new RedisCache({ url: redisUrl, prefix: `test-cache-options-${crypto.randomUUID()}` });
    try {
      expect(redis.capabilities.tags).toBe(false);
      expect(await codeOf(redis.invalidateTags(['products']))).toBe(CACHE_ERROR_CODES.UNSUPPORTED);
    } finally {
      await redis.close();
    }
  });
});
