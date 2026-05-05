import "server-only";

import { Redis } from "@upstash/redis";

import { getBookingEnv } from "@/sanity/env";

const TOKEN_KEY = "booking:google-refresh-token";
const CALENDAR_LOCK_KEY = "booking:calendar-lock";

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient !== null) {
    return redisClient;
  }

  const env = getBookingEnv();
  redisClient = new Redis({
    url: env.upstashRedisRestUrl,
    token: env.upstashRedisRestToken,
  });

  return redisClient;
}

export async function getGoogleRefreshToken(): Promise<string | null> {
  return getRedis().get<string>(TOKEN_KEY);
}

export async function saveGoogleRefreshToken(refreshToken: string): Promise<void> {
  await getRedis().set(TOKEN_KEY, refreshToken);
}

export async function acquireCalendarLock(
  lockId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await getRedis().set(CALENDAR_LOCK_KEY, lockId, {
    nx: true,
    ex: ttlSeconds,
  });

  return result === "OK";
}

export async function releaseCalendarLock(lockId: string): Promise<void> {
  const currentLockId = await getRedis().get<string>(CALENDAR_LOCK_KEY);

  if (currentLockId !== lockId) {
    return;
  }

  await getRedis().del(CALENDAR_LOCK_KEY);
}

export async function claimIdempotencyKey(
  idempotencyKey: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await getRedis().set(
    `booking:idempotency:${idempotencyKey}`,
    "claimed",
    {
      nx: true,
      ex: ttlSeconds,
    },
  );

  return result === "OK";
}
