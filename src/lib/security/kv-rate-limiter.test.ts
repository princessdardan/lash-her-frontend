import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireExpiringQuotaWithStore,
  checkSlidingWindowRateLimitWithStore,
  releaseExpiringQuotaWithStore,
  type RedisScriptStore,
} from "./kv-rate-limiter";

interface SortedMember {
  member: string;
  score: number;
}

function createFakeRedisStore(): RedisScriptStore {
  const sets = new Map<string, SortedMember[]>();

  return {
    async eval<TResult>(script: string, keys: string[], args: string[]) {
      const key = keys[0] ?? "";
      if (script.includes("lash_her_sliding_window_v1")) {
        const now = Number(args[0]);
        const windowMs = Number(args[1]);
        const limit = Number(args[2]);
        const member = args[3] ?? "";
        const recent = (sets.get(key) ?? [])
          .filter((entry) => entry.score > now - windowMs)
          .sort((first, second) => first.score - second.score);
        sets.set(key, recent);
        if (recent.length >= limit) {
          return [
            0,
            recent.length,
            Math.max(1, (recent[0]?.score ?? now) + windowMs - now),
          ] as TResult;
        }
        recent.push({ member, score: now });
        return [1, recent.length, 0] as TResult;
      }

      if (script.includes("lash_her_expiring_quota_v1")) {
        const now = Number(args[0]);
        const expiresAt = Number(args[1]);
        const limit = Number(args[2]);
        const member = args[3] ?? "";
        const active = (sets.get(key) ?? [])
          .filter((entry) => entry.score > now)
          .sort((first, second) => first.score - second.score);
        sets.set(key, active);
        if (active.length >= limit) {
          return [
            0,
            active.length,
            Math.max(1, (active[0]?.score ?? expiresAt) - now),
          ] as TResult;
        }
        active.push({ member, score: expiresAt });
        return [1, active.length, 0] as TResult;
      }

      if (script.includes("lash_her_release_expiring_quota_v1")) {
        const member = args[0] ?? "";
        const before = sets.get(key) ?? [];
        const after = before.filter((entry) => entry.member !== member);
        sets.set(key, after);
        return (before.length - after.length) as TResult;
      }

      throw new Error("Unexpected script");
    },
  };
}

test("sliding-window limiter blocks beyond the limit and recovers after the window", async () => {
  const store = createFakeRedisStore();
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await checkSlidingWindowRateLimitWithStore(store, {
      key: "booking:abuse:hold-attempts:test",
      limit: 5,
      nowMs: index * 1_000,
      requestId: `request-${index}`,
      windowMs: 10_000,
    }), { allowed: true, remaining: 4 - index });
  }

  assert.deepEqual(await checkSlidingWindowRateLimitWithStore(store, {
    key: "booking:abuse:hold-attempts:test",
    limit: 5,
    nowMs: 5_000,
    requestId: "request-blocked",
    windowMs: 10_000,
  }), { allowed: false, retryAfterSeconds: 5 });
  assert.deepEqual(await checkSlidingWindowRateLimitWithStore(store, {
    key: "booking:abuse:hold-attempts:test",
    limit: 5,
    nowMs: 11_000,
    requestId: "request-recovered",
    windowMs: 10_000,
  }), { allowed: true, remaining: 1 });
});

test("expiring quota is atomic, releasable, and reports retry timing", async () => {
  const store = createFakeRedisStore();
  const baseInput = {
    key: "booking:abuse:active-holds:test",
    limit: 2,
    nowMs: 1_000,
    ttlMs: 600_000,
  };
  assert.deepEqual(await acquireExpiringQuotaWithStore(store, {
    ...baseInput,
    leaseId: "lease-1",
  }), { allowed: true, leaseId: "lease-1", remaining: 1 });
  assert.deepEqual(await acquireExpiringQuotaWithStore(store, {
    ...baseInput,
    leaseId: "lease-2",
  }), { allowed: true, leaseId: "lease-2", remaining: 0 });
  assert.deepEqual(await acquireExpiringQuotaWithStore(store, {
    ...baseInput,
    leaseId: "lease-3",
  }), { allowed: false, retryAfterSeconds: 600 });

  await releaseExpiringQuotaWithStore(store, {
    key: baseInput.key,
    leaseId: "lease-1",
  });
  assert.deepEqual(await acquireExpiringQuotaWithStore(store, {
    ...baseInput,
    leaseId: "lease-4",
  }), { allowed: true, leaseId: "lease-4", remaining: 0 });
});

test("limiter storage failures propagate so routes can fail safely", async () => {
  const store: RedisScriptStore = {
    eval: async () => {
      throw new Error("redis unavailable");
    },
  };
  await assert.rejects(
    checkSlidingWindowRateLimitWithStore(store, {
      key: "booking:abuse:availability:test",
      limit: 30,
      nowMs: 1_000,
      requestId: "request-1",
      windowMs: 60_000,
    }),
    /redis unavailable/,
  );
});
