import "server-only";

import { randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";

import {
  acquireExpiringQuotaWithStore,
  checkSlidingWindowRateLimitWithStore,
  releaseExpiringQuotaWithStore,
  type ExpiringQuotaDecision,
  type RateLimitDecision,
  type RedisScriptStore,
} from "./kv-rate-limiter";

export const BOOKING_AVAILABILITY_RATE_LIMIT = {
  limit: 30,
  windowMs: 60_000,
} as const;
export const BOOKING_HOLD_RATE_LIMIT = {
  limit: 5,
  windowMs: 10 * 60_000,
} as const;
export const BOOKING_ACTIVE_HOLD_LIMIT = 2;

let redisStore: RedisScriptStore | null = null;

export async function checkBookingAvailabilityRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  return checkSlidingWindowRateLimitWithStore(getRedisStore(), {
    ...BOOKING_AVAILABILITY_RATE_LIMIT,
    key: input.key,
    nowMs: input.now.getTime(),
    requestId: randomUUID(),
  });
}

export async function checkBookingHoldRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  return checkSlidingWindowRateLimitWithStore(getRedisStore(), {
    ...BOOKING_HOLD_RATE_LIMIT,
    key: input.key,
    nowMs: input.now.getTime(),
    requestId: randomUUID(),
  });
}

export async function acquireBookingActiveHoldQuota(input: {
  key: string;
  now: Date;
  ttlMs: number;
}): Promise<ExpiringQuotaDecision> {
  return acquireExpiringQuotaWithStore(getRedisStore(), {
    key: input.key,
    leaseId: randomUUID(),
    limit: BOOKING_ACTIVE_HOLD_LIMIT,
    nowMs: input.now.getTime(),
    ttlMs: input.ttlMs,
  });
}

export async function releaseBookingActiveHoldQuota(input: {
  key: string;
  leaseId: string;
}): Promise<void> {
  await releaseExpiringQuotaWithStore(getRedisStore(), input);
}

function getRedisStore(): RedisScriptStore {
  if (redisStore) return redisStore;

  const url = requireEnv("KV_REST_API_URL");
  const token = requireEnv("KV_REST_API_TOKEN");
  const redis = new Redis({ token, url });
  redisStore = {
    eval: <TResult>(script: string, keys: string[], args: string[]) =>
      redis.eval<string[], TResult>(script, keys, args),
  };
  return redisStore;
}

function requireEnv(name: "KV_REST_API_TOKEN" | "KV_REST_API_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
