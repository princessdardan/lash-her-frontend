export interface RedisScriptStore {
  eval<TResult>(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<TResult>;
}

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export type ExpiringQuotaDecision =
  | { allowed: true; leaseId: string; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

const SLIDING_WINDOW_SCRIPT = `#!lua flags=allow-key-locking
-- lash_her_sliding_window_v1
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local window_start = now - window
redis.call("ZREMRANGEBYSCORE", key, "-inf", window_start)
local count = redis.call("ZCARD", key)
if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retry = window
  if oldest[2] then
    retry = math.max(1, tonumber(oldest[2]) + window - now)
  end
  redis.call("PEXPIRE", key, window)
  return {0, count, retry}
end
redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, window)
return {1, count + 1, 0}`;

const ACQUIRE_EXPIRING_QUOTA_SCRIPT = `#!lua flags=allow-key-locking
-- lash_her_expiring_quota_v1
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expires_at = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local lease_id = ARGV[4]
redis.call("ZREMRANGEBYSCORE", key, "-inf", now)
local count = redis.call("ZCARD", key)
if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retry = math.max(1, expires_at - now)
  if oldest[2] then
    retry = math.max(1, tonumber(oldest[2]) - now)
  end
  redis.call("PEXPIRE", key, math.max(1, expires_at - now))
  return {0, count, retry}
end
redis.call("ZADD", key, expires_at, lease_id)
redis.call("PEXPIRE", key, math.max(1, expires_at - now))
return {1, count + 1, 0}`;

const RELEASE_EXPIRING_QUOTA_SCRIPT = `#!lua flags=allow-key-locking
-- lash_her_release_expiring_quota_v1
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
if redis.call("ZCARD", KEYS[1]) == 0 then
  redis.call("DEL", KEYS[1])
end
return removed`;

export async function checkSlidingWindowRateLimitWithStore(
  store: RedisScriptStore,
  input: {
    key: string;
    limit: number;
    nowMs: number;
    requestId: string;
    windowMs: number;
  },
): Promise<RateLimitDecision> {
  assertLimiterInput(input);
  const result = await store.eval<unknown>(
    SLIDING_WINDOW_SCRIPT,
    [input.key],
    [
      String(input.nowMs),
      String(input.windowMs),
      String(input.limit),
      input.requestId,
    ],
  );
  const [allowed, count, retryAfterMs] = parseScriptTuple(result);

  return allowed === 1
    ? { allowed: true, remaining: Math.max(0, input.limit - count) }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
}

export async function acquireExpiringQuotaWithStore(
  store: RedisScriptStore,
  input: {
    key: string;
    leaseId: string;
    limit: number;
    nowMs: number;
    ttlMs: number;
  },
): Promise<ExpiringQuotaDecision> {
  assertQuotaInput(input);
  const result = await store.eval<unknown>(
    ACQUIRE_EXPIRING_QUOTA_SCRIPT,
    [input.key],
    [
      String(input.nowMs),
      String(input.nowMs + input.ttlMs),
      String(input.limit),
      input.leaseId,
    ],
  );
  const [allowed, count, retryAfterMs] = parseScriptTuple(result);

  return allowed === 1
    ? {
        allowed: true,
        leaseId: input.leaseId,
        remaining: Math.max(0, input.limit - count),
      }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
}

export async function releaseExpiringQuotaWithStore(
  store: RedisScriptStore,
  input: { key: string; leaseId: string },
): Promise<void> {
  assertKeyAndId(input.key, input.leaseId);
  await store.eval<unknown>(
    RELEASE_EXPIRING_QUOTA_SCRIPT,
    [input.key],
    [input.leaseId],
  );
}

function parseScriptTuple(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error("Invalid Redis limiter response");
  }
  const tuple = value.slice(0, 3).map(toFiniteNumber);
  if (tuple.some((entry) => entry === null)) {
    throw new Error("Invalid Redis limiter response");
  }
  return tuple as [number, number, number];
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function assertLimiterInput(input: {
  key: string;
  limit: number;
  nowMs: number;
  requestId: string;
  windowMs: number;
}): void {
  assertKeyAndId(input.key, input.requestId);
  assertPositiveInteger(input.limit, "limit");
  assertPositiveInteger(input.windowMs, "window");
  assertNonnegativeInteger(input.nowMs, "current time");
}

function assertQuotaInput(input: {
  key: string;
  leaseId: string;
  limit: number;
  nowMs: number;
  ttlMs: number;
}): void {
  assertKeyAndId(input.key, input.leaseId);
  assertPositiveInteger(input.limit, "limit");
  assertPositiveInteger(input.ttlMs, "quota TTL");
  assertNonnegativeInteger(input.nowMs, "current time");
}

function assertKeyAndId(key: string, id: string): void {
  if (!key || key.length > 512 || !id || id.length > 200) {
    throw new Error("Invalid Redis limiter key");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Redis limiter ${label}`);
  }
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Redis limiter ${label}`);
  }
}
