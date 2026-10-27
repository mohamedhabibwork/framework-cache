/** Constants of `@framework/cache`: the container tokens. */
import { token } from '@framework/core';
import type { Cache, LockStore, RateLimiter } from './types';

export const CACHE = token<Cache>('cache.driver');
export const LOCK_STORE = token<LockStore>('cache.lock-store');
export const RATE_LIMITER = token<RateLimiter>('cache.rate-limiter');
