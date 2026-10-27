import { CACHE_ERROR_CODES, CacheError } from './errors';
import type { LockStore } from './types';
import { assertTtlMs } from './validate';

/**
 * Shared `LockStore.withLock` implementation for both drivers: acquire, run
 * `fn`, release on settle. Throws `CACHE_LOCK_NOT_ACQUIRED` when the lock is
 * held elsewhere — never skips `fn` silently, so callers decide fail-open vs
 * fail-closed.
 */
export async function runWithLock<T>(
  locks: LockStore,
  name: string,
  ttlMs: number,
  fn: () => T | Promise<T>,
): Promise<T> {
  assertTtlMs(ttlMs, `withLock(${name})`);
  if (!(await locks.acquire(name, ttlMs))) {
    throw new CacheError(CACHE_ERROR_CODES.LOCK_NOT_ACQUIRED, `Lock "${name}" is held elsewhere`);
  }
  try {
    return await fn();
  } finally {
    await locks.release(name);
  }
}
