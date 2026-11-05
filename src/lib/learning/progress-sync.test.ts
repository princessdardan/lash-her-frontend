import assert from "node:assert/strict";
import test from "node:test";
import { createProgressSync, type ProgressUpdate } from "./progress-sync";
import { LearningRequestError } from "./browser-request";
import type { LessonProgress } from "./types";

const row: LessonProgress = { id: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", lessonId: "33333333-3333-4333-8333-333333333333", enrollmentId: null,
  revision: 1, resumePositionSeconds: 10, maxPositionSeconds: 10, completedQuizRevision: null, completedAt: null, createdAt: "2026-11-05T12:00:00Z", updatedAt: "2026-11-05T12:00:00Z", lastWatchedAt: null };

test("player writes serialize by revision while resume may move backwards and watched progress stays monotonic", async () => {
  const calls: Array<ProgressUpdate & { expectedProgressRevision: number }> = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const sync = createProgressSync({ initial: null, latest: async () => null, write: async body => {
    calls.push(body); if (calls.length === 1) await hold;
    return { ...row, revision: calls.length, resumePositionSeconds: body.resumePositionSeconds ?? 0, maxPositionSeconds: Math.max(10, body.maxPositionSeconds ?? 0) };
  } });
  const first = sync.queue({ resumePositionSeconds: 10, maxPositionSeconds: 10 });
  const second = sync.queue({ resumePositionSeconds: 4, maxPositionSeconds: 4 });
  assert.equal(calls.length, 1); release(); await Promise.all([first, second]);
  assert.deepEqual(calls, [{ resumePositionSeconds: 10, maxPositionSeconds: 10, expectedProgressRevision: 0 }, { resumePositionSeconds: 4, maxPositionSeconds: 10, expectedProgressRevision: 1 }]);
  assert.equal(sync.snapshot()?.maxPositionSeconds, 10); assert.equal(sync.snapshot()?.resumePositionSeconds, 4);
});

test("stale CAS reloads newer cross-device progress and never replays queued local positions or completion", async () => {
  let calls = 0, reads = 0;
  const states: string[] = [];
  const latest = { ...row, revision: 8, resumePositionSeconds: 40, maxPositionSeconds: 60 };
  const sync = createProgressSync({ initial: row, latest: async () => { reads++; return latest; }, write: async () => { calls++; throw new LearningRequestError("conflict", 409); }, changed: (_progress, status) => states.push(status) });
  await sync.queue({ resumePositionSeconds: 2, event: "lesson_completed" });
  await sync.queue({ resumePositionSeconds: 3 }); await sync.retry();
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(sync.snapshot(), latest); assert.equal(states.at(-1), "conflict");
});

test("network failure retains the latest queued position for explicit retry without an automatic retry loop", async () => {
  let calls = 0;
  const sync = createProgressSync({ initial: row, latest: async () => row, write: async body => {
    if (++calls === 1) throw new TypeError("offline");
    return { ...row, revision: 2, resumePositionSeconds: body.resumePositionSeconds!, maxPositionSeconds: body.maxPositionSeconds! };
  } });
  await sync.queue({ resumePositionSeconds: 15, maxPositionSeconds: 15 });
  await sync.queue({ resumePositionSeconds: 4, maxPositionSeconds: 8 });
  assert.equal(calls, 1); await sync.retry(); assert.equal(calls, 2);
  assert.equal(sync.snapshot()?.resumePositionSeconds, 4); assert.equal(sync.snapshot()?.maxPositionSeconds, 15);
});

test("assessment refresh uses authoritative completion and page-exit flush uses a single keepalive write", async () => {
  let keepalive = false;
  const completed = { ...row, revision: 3, completedAt: row.createdAt, completedQuizRevision: 2 };
  const sync = createProgressSync({ initial: row, latest: async () => completed, write: async (_body, value) => { keepalive = value; return { ...row, revision: 2 }; } });
  await sync.queue({ resumePositionSeconds: 7 }, true); assert.equal(keepalive, true);
  await sync.refresh(); assert.equal(sync.snapshot(), completed);
});
