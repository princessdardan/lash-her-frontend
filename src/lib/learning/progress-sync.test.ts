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

test("an offline write is retried only after Course reports the same revision", async () => {
  const calls: string[] = [];
  const attempts: { revision: number; keepalive: boolean }[] = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      calls.push("read");
      return row;
    },
    write: async (body, keepalive) => {
      calls.push("write");
      attempts.push({ revision: body.expectedProgressRevision, keepalive });
      if (calls.length === 1) throw new TypeError("offline");
      return {
        ...row,
        revision: 2,
        resumePositionSeconds: body.resumePositionSeconds!,
        maxPositionSeconds: body.maxPositionSeconds!,
      };
    },
  });
  await sync.queue({ resumePositionSeconds: 15, maxPositionSeconds: 15 }, true);
  await sync.queue({ resumePositionSeconds: 4, maxPositionSeconds: 8 });
  assert.deepEqual(calls, ["write"]);
  await sync.retry();
  assert.deepEqual(calls, ["write", "read", "write"]);
  assert.deepEqual(attempts, [
    { revision: 1, keepalive: true },
    { revision: 1, keepalive: true },
  ]);
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

test("duplicate lifecycle snapshots use the first acknowledged position without another write", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Array<{ resume?: number; revision: number; keepalive: boolean }> = [];
  const sync = createProgressSync({
    initial: { ...row, maxPositionSeconds: 16 },
    latest: async () => row,
    write: async (body, keepalive) => {
      calls.push({
        resume: body.resumePositionSeconds,
        revision: body.expectedProgressRevision,
        keepalive,
      });
      if (calls.length === 1) await hold;
      return {
        ...row,
        revision: body.expectedProgressRevision + 1,
        resumePositionSeconds: body.resumePositionSeconds!,
        maxPositionSeconds: body.maxPositionSeconds!,
      };
    },
  });
  const hidden = sync.queue(
    { resumePositionSeconds: 12, maxPositionSeconds: 12 },
    true,
  );
  const exit = sync.queue(
    { resumePositionSeconds: 12, maxPositionSeconds: 13 },
    true,
  );
  release();
  await Promise.all([hidden, exit]);
  assert.deepEqual(calls, [{ resume: 12, revision: 1, keepalive: true }]);
  assert.equal(sync.snapshot()?.revision, 2);
  await sync.queue({ resumePositionSeconds: 13, maxPositionSeconds: 13 }, true);
  await sync.queue({ resumePositionSeconds: 13, maxPositionSeconds: 13 });
  assert.deepEqual(calls.slice(1), [
    { resume: 13, revision: 2, keepalive: true },
    { resume: 13, revision: 3, keepalive: false },
  ]);
  assert.equal(sync.snapshot()?.maxPositionSeconds, 16);
});

test("an ordinary pause queued behind the same hidden position is coalesced only within that drain", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Array<
    ProgressUpdate & { expectedProgressRevision: number; keepalive: boolean }
  > = [];
  const position = { resumePositionSeconds: 12, maxPositionSeconds: 14 };
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body, keepalive) => {
      calls.push({ ...body, keepalive });
      if (calls.length === 1) await hold;
      return {
        ...row,
        revision: body.expectedProgressRevision + 1,
        resumePositionSeconds: body.resumePositionSeconds!,
        maxPositionSeconds: body.maxPositionSeconds!,
      };
    },
  });
  const hidden = sync.queue(position, true);
  const pause = sync.queue(position);
  const hiddenWrite = { ...position, expectedProgressRevision: 1, keepalive: true };
  assert.deepEqual(calls, [hiddenWrite]);
  release();
  await Promise.all([hidden, pause]);
  assert.deepEqual(calls, [hiddenWrite]);
  assert.equal(sync.snapshot()?.revision, 2);
  await sync.queue(position);
  assert.deepEqual(calls, [
    hiddenWrite,
    { ...position, expectedProgressRevision: 2, keepalive: false },
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

test("an empty exit flush cannot strand a position queued in the same turn", async () => {
  const calls: Array<ProgressUpdate & { keepalive: boolean }> = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body, keepalive) => {
      calls.push({ ...body, keepalive });
      return { ...row, revision: 2, resumePositionSeconds: 2 };
    },
  });
  const empty = sync.flush(true);
  const queued = sync.queue({ resumePositionSeconds: 2 }, true);
  await Promise.all([empty, queued]);
  assert.deepEqual(calls, [
    {
      resumePositionSeconds: 2,
      expectedProgressRevision: 1,
      keepalive: true,
    },
  ]);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 2);
});

test("a position queued while a completed drain settles is acknowledged before its caller resolves", async () => {
  const calls: Array<ProgressUpdate & { keepalive: boolean }> = [];
  let queued: Promise<void> | undefined;
  const sync = createProgressSync({
    initial: row,
    latest: async () => row,
    write: async (body, keepalive) => {
      calls.push({ ...body, keepalive });
      return {
        ...row,
        revision: calls.length + 1,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
    },
    changed: (_progress, status) => {
      if (status === "saved" && calls.length === 1)
        queueMicrotask(() => {
          queued = sync.queue({ resumePositionSeconds: 2 }, true);
        });
    },
  });
  await sync.queue({ resumePositionSeconds: 1 });
  assert.ok(queued);
  await queued;
  assert.deepEqual(calls, [
    { resumePositionSeconds: 1, expectedProgressRevision: 1, keepalive: false },
    { resumePositionSeconds: 2, expectedProgressRevision: 2, keepalive: true },
  ]);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 2);
});

test("explicit server refresh waits for pending resume writes and refuses to discard unknown outcomes", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = false;
  let committed = row;
  const sync = createProgressSync({
    initial: row,
    latest: async () => committed,
    write: async (body) => {
      await hold;
      if (fail) throw new TypeError("offline");
      committed = {
        ...row,
        revision: body.expectedProgressRevision + 1,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
      return committed;
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
  assert.equal(sync.snapshot()?.resumePositionSeconds, 10);
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

test("lost acknowledgements block refresh until revision recovery adopts the committed state without replay", async () => {
  let committed = row;
  const calls: string[] = [];
  const states: string[] = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      calls.push("read");
      return committed;
    },
    write: async (body) => {
      calls.push("write");
      assert.deepEqual(body, {
        resumePositionSeconds: 12,
        expectedProgressRevision: 1,
      });
      committed = {
        ...row,
        revision: 2,
        resumePositionSeconds: body.resumePositionSeconds!,
      };
      throw new TypeError("Acknowledgement was lost after commit");
    },
    changed: (_progress, status) => states.push(status),
  });
  await sync.queue({ resumePositionSeconds: 12 });
  await sync.queue({ resumePositionSeconds: 3 });
  assert.equal(await sync.prepareRefresh(), false);
  assert.deepEqual(calls, ["write"]);
  await sync.retry();
  assert.equal(await sync.prepareRefresh(), true);
  await sync.queue({ resumePositionSeconds: 3 });
  await sync.retry();
  assert.equal(sync.snapshot(), committed);
  assert.deepEqual(calls, ["write", "read"]);
  assert.deepEqual(states, ["saving", "error", "conflict"]);
});

test("retry discards local positions and events if a peer committed a newer revision during the outage", async () => {
  const peer = {
    ...row,
    revision: 3,
    resumePositionSeconds: 40,
    maxPositionSeconds: 50,
  };
  let writes = 0;
  const sync = createProgressSync({
    initial: row,
    latest: async () => peer,
    write: async () => {
      writes++;
      throw new TypeError("offline");
    },
  });
  await sync.queue({ resumePositionSeconds: 15 });
  await sync.queue({ resumePositionSeconds: 2, event: "lesson_completed" }, true);
  await sync.retry();
  await sync.flush(true);
  assert.equal(writes, 1);
  assert.equal(sync.snapshot(), peer);
  assert.equal(await sync.prepareRefresh(), true);
});

test("a failed read during uncertain write recovery keeps the write blocked until a later read succeeds", async () => {
  const calls: string[] = [];
  const states: string[] = [];
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      calls.push("read");
      if (calls.length === 2) throw new TypeError("still offline");
      return row;
    },
    write: async (body) => {
      calls.push("write");
      if (calls.length === 1) throw new TypeError("offline");
      assert.deepEqual(body, {
        resumePositionSeconds: 7,
        expectedProgressRevision: 1,
      });
      return { ...row, revision: 2, resumePositionSeconds: 7 };
    },
    changed: (_progress, status) => states.push(status),
  });
  await sync.queue({ resumePositionSeconds: 15 });
  await sync.retry();
  await sync.queue({ resumePositionSeconds: 7 });
  await sync.refresh();
  assert.deepEqual(calls, ["write", "read"]);
  assert.equal(await sync.prepareRefresh(), false);
  await sync.retry();
  assert.deepEqual(calls, ["write", "read", "read", "write"]);
  assert.deepEqual(states, ["saving", "error", "error", "saving", "saved"]);
  assert.equal(await sync.prepareRefresh(), true);
});

test("a peer write after the recovery read still conflicts and adopts the authoritative position without replay", async () => {
  const calls: string[] = [];
  const peer = {
    ...row,
    revision: 2,
    resumePositionSeconds: 42,
    maxPositionSeconds: 50,
  };
  const sync = createProgressSync({
    initial: row,
    latest: async () => {
      calls.push("read");
      return calls.length === 2 ? row : peer;
    },
    write: async (body) => {
      calls.push("write");
      assert.equal(body.expectedProgressRevision, 1);
      if (calls.length === 1) throw new TypeError("offline");
      throw new LearningRequestError("conflict", 409);
    },
  });
  await sync.queue({ resumePositionSeconds: 15 });
  await sync.retry();
  await sync.queue({ resumePositionSeconds: 7 });
  await sync.retry();
  assert.deepEqual(calls, ["write", "read", "write", "read"]);
  assert.equal(sync.snapshot(), peer);
  assert.equal(await sync.prepareRefresh(), true);
});
