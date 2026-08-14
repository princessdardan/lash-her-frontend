import "server-only";

import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  checkSlidingWindowRateLimitWithStore,
  type RateLimitDecision,
} from "./kv-rate-limiter";

export async function checkShippingQuoteRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  const url = requireEnv("KV_REST_API_URL");
  const token = requireEnv("KV_REST_API_TOKEN");
  const redis = new Redis({ token, url });
  return checkSlidingWindowRateLimitWithStore(
    {
      eval: <TResult>(script: string, keys: string[], args: string[]) =>
        redis.eval<string[], TResult>(script, keys, args),
    },
    {
      key: input.key,
      limit: 12,
      windowMs: 60_000,
      nowMs: input.now.getTime(),
      requestId: randomUUID(),
    },
  );
}

export async function checkSignedShippingLinkRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  const url = requireEnv("KV_REST_API_URL");
  const token = requireEnv("KV_REST_API_TOKEN");
  const redis = new Redis({ token, url });
  return checkSlidingWindowRateLimitWithStore(
    {
      eval: <TResult>(script: string, keys: string[], args: string[]) =>
        redis.eval<string[], TResult>(script, keys, args),
    },
    {
      key: input.key,
      limit: 5,
      windowMs: 60 * 60_000,
      nowMs: input.now.getTime(),
      requestId: randomUUID(),
    },
  );
}

export async function isShippingLinkExchangeBlocked(): Promise<boolean> {
  const redis = getRedis();
  return Boolean(await redis.get("shipping-links:global-breaker"));
}

export async function recordShippingLinkFailure(
  now = new Date(),
): Promise<void> {
  const redis = getRedis();
  await redis.eval<string[], number>(
    `local failures = KEYS[1]
local breaker = KEYS[2]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local block = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', failures, '-inf', now - window)
redis.call('ZADD', failures, now, ARGV[5])
redis.call('PEXPIRE', failures, window)
local count = redis.call('ZCARD', failures)
if count >= threshold then
  redis.call('SET', breaker, '1', 'PX', block)
end
return count`,
    ["shipping-links:failures", "shipping-links:global-breaker"],
    [
      String(now.getTime()),
      String(10 * 60_000),
      "50",
      String(15 * 60_000),
      randomUUID(),
    ],
  );
}

function getRedis(): Redis {
  return new Redis({
    token: requireEnv("KV_REST_API_TOKEN"),
    url: requireEnv("KV_REST_API_URL"),
  });
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
