import assert from "node:assert/strict";
import test from "node:test";
import { createProgressSync, type ProgressUpdate } from "./progress-sync";
import { LearningRequestError } from "./browser-request";
import type { LessonProgress } from "./types";

const row: LessonProgress = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  lessonId: "33333333-3333-4333-8333-333333333333",
  enrollmentId: null,
  revision: 1,
  resumePositionSeconds: 10,
  maxPositionSeconds: 10,
  completedQuizRevision: null,
  completedAt: null,
  createdAt: "2026-11-05T12:00:00Z",
  updatedAt: "2026-11-05T12:00:00Z",
  lastWatchedAt: null,
};

test("player writes serialize by revision while resume may move backwards and watched progress stays monotonic", async () => {
  const calls: Array<ProgressUpdate & { expectedProgressRevision: number }> =
    [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sync = createProgressSync({
    initial: null,
    latest: async () => null,
    write: async (body) => {
      calls.push(body);
      if (calls.length === 1) await hold;
      return {
        ...row,
        revision: calls.length,
        resumePositionSeconds: body.resumePositionSeconds ?? 0,
        maxPositionSeconds: Math.max(10, body.maxPositionSeconds ?? 0),
      };
    },
  });
  const first = sync.queue({
    resumePositionSeconds: 10,
    maxPositionSeconds: 10,
  });
  const second = sync.queue({
    resumePositionSeconds: 4,
    maxPositionSeconds: 4,
  });
  assert.equal(calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    {
      resumePositionSeconds: 10,
      maxPositionSeconds: 10,
      expectedProgressRevision: 0,
    },
    {
      resumePositionSeconds: 4,
      maxPositionSeconds: 10,
      expectedProgressRevision: 1,
    },
  ]);
  assert.equal(sync.snapshot()?.maxPositionSeconds, 10);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 4);
});

test("stale CAS reloads newer cross-device progress and never replays queued local positions or completion", async () => {
  let calls = 0,
    reads = 0;
  const states: string[] = [];
  const latest = {
    ...row,
    revision: 8,
    resumePositionSeconds: 40,
    maxPositionSeconds: 60,
  };
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      reads++;
      return latest;
    },
    write: async () => {
      calls++;
      throw new LearningRequestError("conflict", 409);
    },
    changed: (_progress, status) => states.push(status),
  });
  await sync.queue({ resumePositionSeconds: 2, event: "lesson_completed" });
  await sync.queue({ resumePositionSeconds: 3 });
  await sync.retry();
  assert.equal(calls, 1);
  assert.equal(reads, 1);
  assert.equal(sync.snapshot(), latest);
  assert.equal(states.at(-1), "conflict");
});

test("network failure retains the latest queued position for explicit retry without an automatic retry loop", async () => {
  let calls = 0;
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body) => {
      if (++calls === 1) throw new TypeError("offline");
      return {
        ...row,
        revision: 2,
        resumePositionSeconds: body.resumePositionSeconds!,
        maxPositionSeconds: body.maxPositionSeconds!,
      };
    },
  });
  await sync.queue({ resumePositionSeconds: 15, maxPositionSeconds: 15 });
  await sync.queue({ resumePositionSeconds: 4, maxPositionSeconds: 8 });
  assert.equal(calls, 1);
  await sync.retry();
  assert.equal(calls, 2);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 4);
  assert.equal(sync.snapshot()?.maxPositionSeconds, 15);
});

test("assessment refresh uses authoritative completion and page-exit flush uses a single keepalive write", async () => {
  let keepalive = false;
  const completed = {
    ...row,
    revision: 3,
    completedAt: row.createdAt,
    completedQuizRevision: 2,
  };
  const sync = createProgressSync({
    initial: row,
    latest: async () => completed,
    write: async (_body, value) => {
      keepalive = value;
      return { ...row, revision: 2 };
    },
  });
  await sync.queue({ resumePositionSeconds: 7 }, true);
  assert.equal(keepalive, true);
  await sync.refresh();
  assert.equal(sync.snapshot(), completed);
});

test("retry repeats a failed authoritative read and publishes recovery with no pending write", async () => {
  let reads = 0;
  const states: string[] = [];
  const failure = new TypeError("offline"),
    errors: unknown[] = [];
  const completed = {
    ...row,
    revision: 4,
    completedAt: row.createdAt,
    completedQuizRevision: 2,
  };
  const sync = createProgressSync({
    initial: row,
    write: async () => assert.fail("No write is pending"),
    latest: async () => {
      if (++reads === 1) throw failure;
      return completed;
    },
    changed: (_progress, status, error) => {
      states.push(status);
      errors.push(error);
    },
  });
  await sync.refresh();
  assert.equal(reads, 1);
  assert.deepEqual(states, ["error"]);
  assert.equal(errors[0], failure);
  await sync.retry();
  assert.equal(reads, 2);
  assert.equal(sync.snapshot(), completed);
  assert.deepEqual(states, ["error", "saved"]);
  assert.equal(errors.at(-1), undefined);
});

test("retry reconciles a failed assessment read before sending positions collected during the outage", async () => {
  let reads = 0;
  const calls: string[] = [];
  const completed = {
    ...row,
    revision: 4,
    completedAt: row.createdAt,
    completedQuizRevision: 2,
  };
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      calls.push("read");
      if (++reads === 1) throw new TypeError("offline");
      return completed;
    },
    write: async (body) => {
      calls.push("write");
      assert.equal(body.expectedProgressRevision, 4);
      return {
        ...completed,
        revision: 5,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
    },
  });
  await sync.refresh();
  await sync.queue({ resumePositionSeconds: 3 });
  assert.deepEqual(calls, ["read"]);
  await sync.retry();
  assert.deepEqual(calls, ["read", "read", "write"]);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 3);
  assert.equal(sync.snapshot()?.completedQuizRevision, 2);
});

test("a page-exit position queued behind an ordinary write retains its keepalive request", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Array<{
    keepalive: boolean;
    expectedProgressRevision: number;
    resumePositionSeconds?: number;
  }> = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body, keepalive) => {
      calls.push({ ...body, keepalive });
      if (calls.length === 1) await hold;
      return {
        ...row,
        revision: calls.length + 1,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
    },
  });
  const ordinary = sync.queue({ resumePositionSeconds: 12 });
  const exit = sync.queue({ resumePositionSeconds: 15 }, true);
  assert.equal(calls.length, 1);
  release();
  await Promise.all([ordinary, exit]);
  assert.deepEqual(calls, [
    {
      resumePositionSeconds: 12,
      expectedProgressRevision: 1,
      keepalive: false,
    },
    { resumePositionSeconds: 15, expectedProgressRevision: 2, keepalive: true },
  ]);
});

test("an explicit keepalive flush upgrades a queued update without replaying an active write", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const keepaliveFlags: boolean[] = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (_body, keepalive) => {
      keepaliveFlags.push(keepalive);
      if (keepaliveFlags.length === 1) await hold;
      return { ...row, revision: keepaliveFlags.length + 1 };
    },
  });
  const ordinary = sync.queue({ resumePositionSeconds: 12 });
  const queued = sync.queue({ resumePositionSeconds: 15 });
  const exit = sync.flush(true);
  release();
  await Promise.all([ordinary, queued, exit]);
  assert.deepEqual(keepaliveFlags, [false, true]);
});

test("explicit server refresh waits for pending resume writes and refuses to discard unknown outcomes", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = false;
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body) => {
      await hold;
      if (fail) throw new TypeError("offline");
      return {
        ...row,
        revision: 2,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
    },
  });
  const pending = sync.queue({ resumePositionSeconds: 9 });
  let prepared = false;
  const refresh = sync.prepareRefresh().then((value) => {
    prepared = value;
  });
  await Promise.resolve();
  assert.equal(prepared, false);
  release();
  await Promise.all([pending, refresh]);
  assert.equal(prepared, true);
  fail = true;
  await sync.queue({ resumePositionSeconds: 10 });
  assert.equal(await sync.prepareRefresh(), false);
  fail = false;
  await sync.retry();
  assert.equal(await sync.prepareRefresh(), true);
});

test("an explicit server refresh can adopt authoritative conflict state after stale local work was discarded", async () => {
  const latest = { ...row, revision: 9, resumePositionSeconds: 42 };
  const sync = createProgressSync({
    initial: row,
    latest: async () => latest,
    write: async () => {
      throw new LearningRequestError("conflict", 409);
    },
  });
  await sync.queue({ resumePositionSeconds: 2 });
  assert.equal(await sync.prepareRefresh(), true);
  assert.equal(sync.snapshot(), latest);
});
