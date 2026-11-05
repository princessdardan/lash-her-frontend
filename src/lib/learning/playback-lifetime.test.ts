import assert from "node:assert/strict";
import test from "node:test";
import { playbackLifetime } from "./playback-lifetime";

const now = Date.parse("2026-11-05T12:00:00Z");
const expiry = new Date(now + 600_000).toISOString();
const serverDate = new Date(now).toUTCString();

test("playback lifetime uses the same-origin clock and subtracts response time with skewed customer clocks", () => {
  for (const localNow of [now - 3_600_000, now + 3_600_000])
    assert.equal(
      playbackLifetime(expiry, expiry, {
        serverDate,
        localNow,
        elapsedMs: 250,
      }),
      598_750,
    );
});

test("the earlier thumbnail expiry and the 600-second maximum both bound playback", () => {
  assert.equal(
    playbackLifetime(expiry, new Date(now + 30_000).toISOString(), {
      serverDate,
      localNow: now,
      elapsedMs: 50,
    }),
    28_950,
  );
  const distant = new Date(now + 3_600_000).toISOString();
  assert.equal(
    playbackLifetime(distant, distant, {
      serverDate,
      localNow: now,
      elapsedMs: 100,
    }),
    599_900,
  );
});

test("invalid, expired and network-exhausted authorizations cannot be reinstalled", () => {
  for (const [video, thumbnail, elapsedMs] of [
    ["not-a-date", expiry, 0],
    [expiry, "not-a-date", 0],
    [new Date(now).toISOString(), expiry, 0],
    [expiry, expiry, 600_000],
  ] as const)
    assert.throws(() =>
      playbackLifetime(video, thumbnail, {
        serverDate,
        localNow: now,
        elapsedMs,
      }),
    );
});

test("a missing or malformed response Date uses the local clock conservatively", () => {
  for (const date of [null, "invalid"])
    assert.equal(
      playbackLifetime(expiry, expiry, {
        serverDate: date,
        localNow: now + 1000,
        elapsedMs: 250,
      }),
      598_750,
    );
});
