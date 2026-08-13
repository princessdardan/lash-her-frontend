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
      limit: 10,
      windowMs: 15 * 60_000,
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
