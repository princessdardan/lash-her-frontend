import { LearningRequestError } from "./browser-request";
import type { LessonProgress } from "./types";

export type ProgressUpdate = { resumePositionSeconds?: number; maxPositionSeconds?: number; event?: "lesson_started" | "lesson_completed" };
export type ProgressSyncStatus = "ready" | "saving" | "saved" | "error" | "conflict";
function merge(left: ProgressUpdate | null, right: ProgressUpdate | null): ProgressUpdate {
  return { ...left, ...right, ...(left?.maxPositionSeconds === undefined && right?.maxPositionSeconds === undefined ? {} : { maxPositionSeconds: Math.max(left?.maxPositionSeconds ?? 0, right?.maxPositionSeconds ?? 0) }) };
}

/** Serialize writes from one player and never replay stale positions over a
 * different device. The receiver remains the authority for quiz completion. */
export function createProgressSync(dependencies: {
  initial: LessonProgress | null;
  write: (body: ProgressUpdate & { expectedProgressRevision: number }, keepalive: boolean) => Promise<LessonProgress>;
  latest: () => Promise<LessonProgress | null>;
  changed?: (progress: LessonProgress | null, status: ProgressSyncStatus, error?: unknown) => void;
}) {
  let progress = dependencies.initial;
  let pending: ProgressUpdate | null = null;
  let running: Promise<void> | null = null;
  let blocked: "error" | "conflict" | null = null;
  let disposed = false;
  const changed = (status: ProgressSyncStatus, error?: unknown) => { if (!disposed) dependencies.changed?.(progress, status, error); };
  async function drain(keepalive: boolean) {
    while (pending && !blocked) {
      const current = pending; pending = null; changed("saving");
      try {
        progress = await dependencies.write({ ...current, ...(current.maxPositionSeconds === undefined ? {} : { maxPositionSeconds: Math.max(progress?.maxPositionSeconds ?? 0, current.maxPositionSeconds) }), expectedProgressRevision: progress?.revision ?? 0 }, keepalive);
        changed("saved");
      } catch (error) {
        if (error instanceof LearningRequestError && error.status === 409) {
          // Discard local positions/events queued against a stale revision.
          // A reload resumes the latest device position, without silent replay.
          pending = null; blocked = "conflict";
          try { progress = await dependencies.latest(); } catch { /* retain last acknowledged state */ }
          changed("conflict");
        } else {
          pending = merge(current, pending);
          blocked = "error"; changed("error", error);
        }
      }
    }
  }
  function flush(keepalive = false): Promise<void> {
    if (running) return running;
    running = drain(keepalive).finally(() => { running = null; });
    return running;
  }
  return {
    snapshot: () => progress,
    async queue(update: ProgressUpdate, keepalive = false) {
      if (blocked === "conflict") return;
      pending = { ...pending, ...update, ...(pending?.maxPositionSeconds === undefined && update.maxPositionSeconds === undefined ? {} : {
        maxPositionSeconds: Math.max(progress?.maxPositionSeconds ?? 0, pending?.maxPositionSeconds ?? 0, update.maxPositionSeconds ?? 0),
      }) };
      await flush(keepalive);
    },
    flush,
    async retry() { if (blocked !== "error") return; blocked = null; await flush(); },
    async refresh() {
      await flush();
      if (blocked) return;
      try { progress = await dependencies.latest(); changed("saved"); }
      catch { blocked = "error"; changed("error"); }
    },
    dispose() { disposed = true; },
  };
}
