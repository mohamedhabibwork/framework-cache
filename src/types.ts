/**
 * Every interface and type alias of `@framework/cache`, in one import point.
 * Runtime values (classes, tokens, functions) live in their own modules.
 */

/** Which backend backs the cache stack: memory for development/tests, redis for shared state. */
export type CacheDriverKind = 'memory' | 'redis';

/**
 * Capabilities a driver declares, mapped from the cachekit engine's capability
 * matrix. Callers must not assume an unsupported capability: guards like
 * "if (cache.capabilities.clearNamespace)" decide between the fast path and a
 * safe fallback, never between fail-open and bypass.
 */
export interface CacheCapabilities {
  /** `increment`/`decrement` are atomic under concurrent writers. */
  readonly atomicIncrement: boolean;
  /** A `LockStore` built on this driver provides mutual exclusion (redis: instance-wide, memory: process-wide). */
  readonly locking: boolean;
  /** Entries can carry tags for group invalidation (memory: native; redis: unsupported by the engine). */
  readonly tags: boolean;
  /** `clear()` can delete the whole namespace (memory: native; redis: unsupported — delete known keys instead). */
  readonly clearNamespace: boolean;
  /** Locks exclude across processes/instances, not only within one (redis: distributed, memory: process-wide only). */
  readonly distributedLocks: boolean;
}

// -- Cache ---------------------------------------------------------------------

export interface IncrementOptions {
  /** Amount to add (defaults to 1). */
  readonly by?: number;
  /** Expiry applied when the counter is created (expire-on-first-increment); leaves an existing counter's TTL untouched. */
  readonly ttlSeconds?: number;
}

/**
 * Provider-native options bag, forwarded verbatim to the cachekit engine and
 * from there to the provider. cachekit ships no native options of its own today
 * (its maps are empty), so this exists for custom engines and future drivers.
 */
export type NativeOptions = Readonly<Record<string, unknown>>;

/** Options for `set` / `setMany` (cachekit's `SetOptions`). */
export interface SetOptions {
  /** Time to live in seconds (fractions allowed, ms precision). */
  readonly ttlSeconds?: number;
  /**
   * Serve stale for this many seconds after expiry while one caller refreshes.
   * Requires `get({ allowStale: true })` or `getOrSet({ serveStale: true })`.
   */
  readonly staleTtlSeconds?: number;
  /** Tags for group invalidation (`invalidateTags`). Requires the `tags` capability. */
  readonly tags?: readonly string[];
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** Options for `get` / `has` / `getMany`. */
export interface GetOptions {
  /** Return an expired-but-still-in-stale-window entry instead of a miss. */
  readonly allowStale?: boolean;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** Options for `getOrSet` (read-through with single-flight and stale serving). */
export interface GetOrSetOptions extends SetOptions {
  /** Serve a stale value instead of waiting for the refresh. */
  readonly serveStale?: boolean;
}

/** One entry of `setMany`. */
export interface CacheEntryInput<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly options?: SetOptions;
}

/** Result of `invalidateTags` (cachekit reports how and how many). */
export interface TagInvalidationResult {
  readonly invalidated: number;
  readonly mode: 'delete' | 'versioned' | 'unsupported';
}

/** Provider health, when the engine can report it. */
export interface CacheHealth {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly provider: string;
  readonly latency: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Application cache contract (spec §7). Two drivers: `MemoryCache` for
 * development/tests and `RedisCache` for state shared across instances.
 *
 * - TTL: `ttlSeconds` is a positive number (fractions allowed, ms precision);
 *   omitted means "no expiry" (persist until cleared or evicted).
 * - Serialization: values must be JSON-serializable (see `./serialization`);
 *   violations reject with `CACHE_SERIALIZATION_FAILED`, never store garbage.
 * - Namespace: every driver only ever touches its own keys; `clear()` is
 *   scoped to the driver's namespace and never flushes a shared Redis DB.
 * - Failure: a failing backend is never silently bypassed — operations reject
 *   with catalogued `CacheError`s (`CACHE_UNAVAILABLE`, …). Callers decide
 *   fail-open vs fail-closed; session and security-limit callers must fail
 *   closed.
 *
 * This is application caching. It is conceptually separate from Hono's HTTP
 * response cache (`hono/cache` middleware, Web Cache API).
 */
export interface Cache {
  readonly capabilities: CacheCapabilities;
  /** Typed read; resolves null on miss. A corrupt stored payload rejects with `CACHE_DESERIALIZATION_FAILED`. */
  get<T>(key: string, options?: GetOptions): Promise<T | null>;
  /**
   * JSON-serializes `value`; rejects with `CACHE_SERIALIZATION_FAILED` for
   * non-JSON values. Accepts a bare TTL in seconds (the original signature) or
   * the full {@link SetOptions} (`staleTtlSeconds`, `tags`, `native`, …).
   */
  set<T>(key: string, value: T, ttlOrOptions?: number | SetOptions): Promise<void>;
  /** Batched read; the map only contains keys that hit. */
  getMany<T>(keys: readonly string[], options?: GetOptions): Promise<Map<string, T>>;
  /** Batched write; each entry may carry its own options, merged over `options`. */
  setMany(entries: readonly CacheEntryInput[], options?: SetOptions): Promise<void>;
  /** Removes a key; resolves whether an unexpired entry existed. */
  delete(key: string): Promise<boolean>;
  /** Removes many keys; resolves the number deleted. */
  deleteMany(keys: readonly string[]): Promise<number>;
  has(key: string, options?: GetOptions): Promise<boolean>;
  /** Read-through memoization: cached hit, otherwise stores `factory()`'s result under `ttlSeconds`. */
  remember<T>(key: string, ttlSeconds: number, factory: () => T | Promise<T>): Promise<T>;
  /**
   * Read-through with single-flight deduplication and optional stale serving.
   * Rejects with `CACHE_UNSUPPORTED_OPERATION` when `tags` are requested on a
   * driver without tag support (never silently drops the tag).
   */
  getOrSet<T>(
    key: string,
    loader: (context: { signal: AbortSignal }) => T | Promise<T>,
    options?: GetOrSetOptions,
  ): Promise<T>;
  /** Extends a key's TTL; resolves false when the key is missing. */
  touch(key: string, ttlSeconds: number, options?: GetOptions): Promise<boolean>;
  /**
   * Invalidates every entry carrying one of `tags`. Requires the `tags`
   * capability (memory: yes, redis: no — rejects with
   * `CACHE_UNSUPPORTED_OPERATION`).
   */
  invalidateTags(tags: readonly string[], options?: GetOptions): Promise<TagInvalidationResult>;
  /** Provider health as reported by the engine. */
  health(): Promise<CacheHealth>;
  /** The native cachekit client (or provider client) behind this cache. */
  native(): unknown;
  /** Atomic integer counter; a missing key is created at `by`. */
  increment(key: string, options?: IncrementOptions): Promise<number>;
  /** `increment` with a negated `by`. */
  decrement(key: string, options?: IncrementOptions): Promise<number>;
  /**
   * Deletes this namespace's keys; returns the count. Requires the
   * `clearNamespace` capability — the redis engine deliberately cannot clear
   * a namespace, so it rejects with `CACHE_UNSUPPORTED_OPERATION` and callers
   * delete known keys instead. A `prefix` argument is never supported (the
   * engine has no prefix-scoped clear) and rejects on every driver.
   */
  clear(prefix?: string): Promise<number>;
  /** Releases driver resources (Redis connections); idempotent. */
  close(): Promise<void>;
}

// -- Locks ---------------------------------------------------------------------

/**
 * Named lock store used later for scheduler overlap and session limits.
 * Locks expire after `ttlMs` and carry an owner token: only the acquirer's
 * store can release the lock it took — a different store's `release` resolves
 * false without touching the lock.
 */
export interface LockStore {
  /** Tries to take `name` for `ttlMs`; resolves false when someone else holds it. */
  acquire(name: string, ttlMs: number): Promise<boolean>;
  /** Releases the lock only if the caller still owns it; resolves whether it was released. */
  release(name: string): Promise<boolean>;
  /**
   * Runs `fn` while holding the lock and releases it when `fn` settles.
   * Rejects with `CACHE_LOCK_NOT_ACQUIRED` when the lock is held elsewhere —
   * the caller decides fail-open vs fail-closed (overlap protection and
   * session limits must fail closed), it is never silently skipped.
   */
  withLock<T>(name: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// -- Rate limiting ----------------------------------------------------------------

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Hits left in the current fixed window (never negative). */
  readonly remaining: number;
  /** Seconds until the window resets; 0 while the request was allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter (login throttling, security limits). Every
 * `consume` counts, including rejected attempts. Failures reject with
 * catalogued `CacheError`s — security callers fail closed, never bypass.
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Clears the window for a key (e.g. after a successful login). */
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}

// -- Options ----------------------------------------------------------------------

export interface RedisCacheOptions {
  readonly url: string;
  /** Namespace so several apps can share one Redis without crosstalk (e.g. the application name). */
  readonly prefix: string;
}

/**
 * Engine-level cache options forwarded to cachekit when the driver is created.
 * They apply to the cache, lock and rate-limit engines alike.
 */
export interface CacheEngineOptions {
  /** TTL (seconds) applied when `set`/`setMany` omit one. */
  readonly defaultTtlSeconds?: number;
  /** Upper bound on in-process entries (memory driver only). */
  readonly maxEntries?: number;
}

export interface CacheProviderConfig {
  readonly driver?: CacheDriverKind;
  readonly redis?: RedisCacheOptions;
  /** Engine options (default TTL, memory entry cap). */
  readonly options?: CacheEngineOptions;
}
