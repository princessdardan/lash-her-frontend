import "server-only";

import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  checkSlidingWindowRateLimitWithStore,
  type RateLimitDecision,
} from "./kv-rate-limiter";

/**
 * Per-IP sliding-window limit for the product checkout POST (order reservation +
 * Square card charge). Protects the live Square account from card-testing / BIN
 * attacks and guards inventory from reservation spam. Mirrors the shipping-quote
 * limiter; the underlying store is Upstash Redis (durable across serverless
 * instances), so callers should fail closed if this throws.
 */
export function checkProductCheckoutRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  return runSlidingWindow({
    key: input.key,
    limit: 10,
    windowMs: 60_000,
    now: input.now,
  });
}

/**
 * Per-IP sliding-window limit for the cart-preview POST. This endpoint is called
 * on ordinary cart edits, so the limit is generous — it exists to blunt request
 * floods against the data layer, not to gate normal shopping.
 */
export function checkCartPreviewRateLimit(input: {
  key: string;
  now: Date;
}): Promise<RateLimitDecision> {
  return runSlidingWindow({
    key: input.key,
    limit: 60,
    windowMs: 60_000,
    now: input.now,
  });
}

function runSlidingWindow(input: {
  key: string;
  limit: number;
  windowMs: number;
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
      limit: input.limit,
      windowMs: input.windowMs,
      nowMs: input.now.getTime(),
      requestId: randomUUID(),
    },
  );
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
