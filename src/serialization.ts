import { CACHE_ERROR_CODES, CacheError } from './errors';

/**
 * Serialization contract: cache values are JSON-serializable and stored as
 * JSON. The cachekit engine encodes with its `json` codec, but the framework
 * rejects non-serializable values up front (the codec alone would silently
 * stringify `undefined` into the text `"undefined"`), so a rejected write
 * never reaches storage.
 */

/** Serializes a cache value; rejects with `CACHE_SERIALIZATION_FAILED` for non-JSON values (undefined, functions, circular structures, bigint). */
export function serializeCacheValue(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new CacheError(CACHE_ERROR_CODES.SERIALIZATION, 'Cache value is not JSON-serializable', { cause: error });
  }
  if (json === undefined) {
    throw new CacheError(CACHE_ERROR_CODES.SERIALIZATION, 'Cache value is not JSON-serializable');
  }
  return json;
}
