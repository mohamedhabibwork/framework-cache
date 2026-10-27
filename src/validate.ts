import { CACHE_ERROR_CODES, CacheError } from './errors';

/** Shared argument validation for both drivers; every failure is catalogued. */

export function assertTtlSeconds(ttlSeconds: number, context: string): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new CacheError(
      CACHE_ERROR_CODES.INVALID_TTL,
      `${context}: ttlSeconds must be a positive, finite number of seconds (got ${ttlSeconds})`,
    );
  }
}

export function assertTtlMs(ttlMs: number, context: string): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheError(
      CACHE_ERROR_CODES.INVALID_TTL,
      `${context}: ttlMs must be a positive, finite number of milliseconds (got ${ttlMs})`,
    );
  }
}

export function assertPositiveInt(value: number, name: string, context: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new CacheError(
      CACHE_ERROR_CODES.INVALID_ARGUMENT,
      `${context}: ${name} must be a positive integer (got ${value})`,
    );
  }
}

/** Seconds (possibly fractional) to milliseconds, minimum 1 so Redis never sees a zero expiry. */
export function ttlSecondsToMs(ttlSeconds: number): number {
  return Math.max(1, Math.round(ttlSeconds * 1000));
}
