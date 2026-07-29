import "server-only";

import { Redis } from "@upstash/redis";

import { getBookingEnv } from "@/sanity/env";
import {
  consumeBookingCalendarOAuthState as consumeCalendarOAuthState,
  saveBookingCalendarOAuthState as saveCalendarOAuthState,
  type BookingCalendarOAuthState,
  type BookingCalendarOAuthStateStorage,
} from "./calendar-oauth-state";
import {
  readGoogleRefreshToken,
  writeGoogleRefreshToken,
  type BookingDeploymentEnvironment,
  type GoogleRefreshTokenStorage,
} from "./google-refresh-token-store";

export {
  isBookingCalendarOAuthState,
  type BookingCalendarOAuthState,
  type BookingCalendarOAuthStateStorage,
} from "./calendar-oauth-state";

const CALENDAR_LOCK_KEY = "booking:calendar-lock";
const RELEASE_LOCK_SCRIPT = `#!lua flags=allow-key-locking
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient !== null) {
    return redisClient;
  }

  const env = getBookingEnv();
  redisClient = new Redis({
    url: env.kvRestApiUrl,
    token: env.kvRestApiToken,
  });

  return redisClient;
}

export async function getGoogleRefreshToken(
  storage: GoogleRefreshTokenStorage = getRedis(),
  environment: BookingDeploymentEnvironment = process.env,
): Promise<string | null> {
  return readGoogleRefreshToken(storage, environment);
}

export async function saveGoogleRefreshToken(
  refreshToken: string,
  storage: GoogleRefreshTokenStorage = getRedis(),
  environment: BookingDeploymentEnvironment = process.env,
): Promise<void> {
  await writeGoogleRefreshToken(refreshToken, storage, environment);
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
  await getRedis().eval(RELEASE_LOCK_SCRIPT, [CALENDAR_LOCK_KEY], [lockId]);
}

export async function acquireScopedBookingLock(input: {
  key: string;
  lockId: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const result = await getRedis().set(
    toScopedBookingLockKey(input.key),
    input.lockId,
    {
      nx: true,
      ex: input.ttlSeconds,
    },
  );

  return result === "OK";
}

export async function releaseScopedBookingLock(input: {
  key: string;
  lockId: string;
}): Promise<void> {
  await getRedis().eval(
    RELEASE_LOCK_SCRIPT,
    [toScopedBookingLockKey(input.key)],
    [input.lockId],
  );
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

export async function saveBookingCalendarOAuthState(
  input: {
    state: string;
    payload: BookingCalendarOAuthState;
    ttlSeconds: number;
  },
  storage: BookingCalendarOAuthStateStorage = getRedis(),
): Promise<boolean> {
  return saveCalendarOAuthState(input, storage);
}

export async function consumeBookingCalendarOAuthState(
  state: string,
  storage: BookingCalendarOAuthStateStorage = getRedis(),
): Promise<BookingCalendarOAuthState | null> {
  return consumeCalendarOAuthState(state, storage);
}

function toScopedBookingLockKey(key: string): string {
  return `booking:lock:${encodeURIComponent(key)}`;
}
