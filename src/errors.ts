import { FrameworkError } from '@framework/core';
import {
  CacheClosedError as KitClosedError,
  CacheDecodeError as KitDecodeError,
  CacheError as KitError,
  CacheInvalidConfigError as KitInvalidConfigError,
  CacheLockTimeoutError as KitLockTimeoutError,
  CacheSerializationError as KitSerializationError,
  CacheUnsupportedOperationError as KitUnsupportedOperationError,
} from '@mohamedhabibwork/cachekit';

/**
 * Catalogued `CACHE_*` error codes. Callers branch on `error.code` to decide
 * fail-open vs fail-closed — the cache package itself never silently bypasses
 * a failure.
 */
export const CACHE_ERROR_CODES = {
  /** Backend unreachable or the operation failed at the driver (Redis errors). */
  UNAVAILABLE: 'CACHE_UNAVAILABLE',
  /** Value passed to `set` is not JSON-serializable. */
  SERIALIZATION: 'CACHE_SERIALIZATION_FAILED',
  /** Stored payload is not valid JSON (corrupt or written by another tool). */
  DESERIALIZATION: 'CACHE_DESERIALIZATION_FAILED',
  /** `withLock` could not acquire the lock. */
  LOCK_NOT_ACQUIRED: 'CACHE_LOCK_NOT_ACQUIRED',
  /** A TTL/duration argument is missing, non-finite, or not positive. */
  INVALID_TTL: 'CACHE_INVALID_TTL',
  /** `increment`/`decrement` hit a stored value that is not an integer. */
  NOT_INTEGER: 'CACHE_VALUE_NOT_INTEGER',
  /** Invalid `RateLimiter` argument (limit/window). */
  INVALID_ARGUMENT: 'CACHE_INVALID_ARGUMENT',
  /** Provider configuration is invalid (e.g. driver "redis" without a URL). */
  CONFIG: 'CACHE_CONFIG_INVALID',
  /** The engine does not implement the operation (e.g. Redis namespace clear, prefix-scoped clear). */
  UNSUPPORTED: 'CACHE_UNSUPPORTED_OPERATION',
} as const;

export type CacheErrorCode = (typeof CACHE_ERROR_CODES)[keyof typeof CACHE_ERROR_CODES];

/** Framework failure with a stable machine-readable `CACHE_*` code. */
export class CacheError extends FrameworkError {
  constructor(code: CacheErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

/** Maps the engine's error kinds onto the catalog. Counters get their own mapping (see {@link mapCounterError}). */
export function mapDriverError(operation: string, error: unknown): CacheError {
  if (error instanceof CacheError) return error;
  if (error instanceof KitUnsupportedOperationError) {
    return new CacheError(CACHE_ERROR_CODES.UNSUPPORTED, `${operation}: not supported by the engine`, { cause: error });
  }
  if (error instanceof KitDecodeError) {
    return new CacheError(CACHE_ERROR_CODES.DESERIALIZATION, `${operation} failed: cached payload is unreadable`, {
      cause: error,
    });
  }
  if (error instanceof KitSerializationError) {
    return new CacheError(CACHE_ERROR_CODES.SERIALIZATION, `${operation} failed: value is not JSON-serializable`, {
      cause: error,
    });
  }
  if (error instanceof KitInvalidConfigError) {
    return new CacheError(CACHE_ERROR_CODES.INVALID_ARGUMENT, `${operation} failed: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof KitLockTimeoutError || error instanceof KitClosedError) {
    return new CacheError(CACHE_ERROR_CODES.UNAVAILABLE, `${operation} failed`, { cause: error });
  }
  return wrapUnknown(operation, error);
}

/**
 * Error mapping for counter operations (`increment`/`decrement`/rate-limit
 * consume): a payload that cannot be interpreted as a numeric counter is a
 * `CACHE_VALUE_NOT_INTEGER`, whether the engine reports it as an unreadable
 * envelope (redis) or a non-number value (memory).
 */
export function mapCounterError(operation: string, error: unknown): CacheError {
  if (error instanceof CacheError) return error;
  if (error instanceof KitDecodeError || error instanceof KitInvalidConfigError) {
    return new CacheError(CACHE_ERROR_CODES.NOT_INTEGER, `${operation} failed: stored value is not an integer`, {
      cause: error,
    });
  }
  return mapDriverError(operation, error);
}

/** Last-resort mapping: Redis type errors become `CACHE_VALUE_NOT_INTEGER`, everything else `CACHE_UNAVAILABLE`. */
function wrapUnknown(operation: string, error: unknown): CacheError {
  const message = error instanceof KitError || error instanceof Error ? error.message : String(error);
  if (/\bWRONGTYPE\b|value is not an integer|out of range/i.test(message)) {
    return new CacheError(CACHE_ERROR_CODES.NOT_INTEGER, `${operation} failed: ${message}`);
  }
  return new CacheError(CACHE_ERROR_CODES.UNAVAILABLE, `${operation} failed`, { cause: error });
}
