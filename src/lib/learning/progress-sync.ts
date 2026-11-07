import { LearningRequestError } from "./browser-request";
import type { LessonProgress } from "./types";

export type ProgressUpdate = {
  resumePositionSeconds?: number;
  maxPositionSeconds?: number;
  event?: "lesson_started" | "lesson_completed";
};
export type ProgressSyncStatus =
  | "ready"
  | "saving"
  | "saved"
  | "error"
  | "conflict";
function merge(
  left: ProgressUpdate | null,
  right: ProgressUpdate | null,
): ProgressUpdate {
  return {
    ...left,
    ...right,
    ...(left?.maxPositionSeconds === undefined &&
    right?.maxPositionSeconds === undefined
      ? {}
      : {
          maxPositionSeconds: Math.max(
            left?.maxPositionSeconds ?? 0,
            right?.maxPositionSeconds ?? 0,
          ),
        }),
  };
}

/** Serialize writes from one player and never replay stale positions over a
 * different device. The receiver remains the authority for quiz completion. */
export function createProgressSync(dependencies: {
  initial: LessonProgress | null;
  write: (
    body: ProgressUpdate & { expectedProgressRevision: number },
    keepalive: boolean,
  ) => Promise<LessonProgress>;
  latest: () => Promise<LessonProgress | null>;
  changed?: (
    progress: LessonProgress | null,
    status: ProgressSyncStatus,
    error?: unknown,
  ) => void;
}) {
  let progress = dependencies.initial;
  let pending: ProgressUpdate | null = null;
  let running: Promise<void> | null = null;
  let blocked: "error" | "conflict" | null = null;
  let pendingKeepalive = false;
  let pendingRead = false;
  let readBeforeWrites = false;
  let uncertainRevision: number | undefined;
  let disposed = false;
  const changed = (status: ProgressSyncStatus, error?: unknown) => {
    if (!disposed) dependencies.changed?.(progress, status, error);
  };
  function blockOnConflict() {
    pending = null;
    pendingRead = false;
    pendingKeepalive = false;
    readBeforeWrites = false;
    uncertainRevision = undefined;
    blocked = "conflict";
  }
  async function drain() {
    let acknowledgedKeepaliveRevision: number | undefined;
    while ((pending || pendingRead) && !blocked) {
      if (pendingRead && (!pending || readBeforeWrites)) {
        try {
          progress = await dependencies.latest();
          pendingRead = false;
          readBeforeWrites = false;
          if (uncertainRevision === undefined) {
            changed("saved");
          } else if ((progress?.revision ?? 0) !== uncertainRevision) {
            blockOnConflict();
            changed("conflict");
          } else {
            uncertainRevision = undefined;
          }
        } catch (error) {
          // Resolve the authoritative read before sending queued positions.
          readBeforeWrites = true;
          blocked = "error";
          changed("error", error);
        }
        continue;
      }
      if (!pending) continue;
      const keepalive = pendingKeepalive;
      pendingKeepalive = false;
      const current = pending;
      const expectedProgressRevision = progress?.revision ?? 0;
      pending = null;
      const maxPositionSeconds =
        current.maxPositionSeconds === undefined
          ? undefined
          : Math.max(progress?.maxPositionSeconds ?? 0, current.maxPositionSeconds);
      // Visibility, pagehide and unmount can report the same final position.
      // Skip only a queued duplicate of a keepalive this drain confirmed.
      if (
        keepalive &&
        progress &&
        progress.revision === acknowledgedKeepaliveRevision &&
        current.event === undefined &&
        (current.resumePositionSeconds === undefined ||
          current.resumePositionSeconds === progress.resumePositionSeconds) &&
        (maxPositionSeconds === undefined ||
          maxPositionSeconds === progress.maxPositionSeconds)
      ) {
        changed("saved");
        continue;
      }
      changed("saving");
      try {
        progress = await dependencies.write(
          {
            ...current,
            ...(maxPositionSeconds === undefined ? {} : { maxPositionSeconds }),
            expectedProgressRevision,
          },
          keepalive,
        );
        acknowledgedKeepaliveRevision =
          keepalive && current.event === undefined ? progress.revision : undefined;
        changed("saved");
      } catch (error) {
        if (error instanceof LearningRequestError && error.status === 409) {
          // Discard local positions/events queued against a stale revision.
          // A reload resumes the latest device position, without silent replay.
          blockOnConflict();
          try {
            progress = await dependencies.latest();
          } catch {
            /* retain last acknowledged state */
          }
          changed("conflict");
        } else {
          pending = merge(current, pending);
          pendingKeepalive ||= keepalive;
          // The write may have committed even if the response was lost.
          // A retry may send these updates only against the same revision.
          uncertainRevision = expectedProgressRevision;
          pendingRead = true;
          readBeforeWrites = true;
          blocked = "error";
          changed("error", error);
        }
      }
    }
  }
  function flush(keepalive = false): Promise<void> {
    if (keepalive && pending) pendingKeepalive = true;
    if (running) return running;
    if ((!pending && !pendingRead) || blocked) return Promise.resolve();
    running = drain().finally(() => {
      running = null;
      // A caller can enqueue after drain exits but before this cleanup runs.
      // Include that work in the same flush instead of leaving it stranded.
      if ((pending || pendingRead) && !blocked) return flush();
    });
    return running;
  }
  return {
    snapshot: () => progress,
    async queue(update: ProgressUpdate, keepalive = false) {
      if (blocked === "conflict") return;
      pending = {
        ...pending,
        ...update,
        ...(pending?.maxPositionSeconds === undefined &&
        update.maxPositionSeconds === undefined
          ? {}
          : {
              maxPositionSeconds: Math.max(
                progress?.maxPositionSeconds ?? 0,
                pending?.maxPositionSeconds ?? 0,
                update.maxPositionSeconds ?? 0,
              ),
            }),
      };
      await flush(keepalive);
    },
    flush,
    async prepareRefresh() {
      await flush(true);
      // A CAS conflict already discarded local stale writes and requires the
      // explicit authoritative reload. Unknown outcomes still need recovery.
      return blocked !== "error" && pending === null && !pendingRead;
    },
    async retry() {
      if (blocked !== "error") return;
      blocked = null;
      await flush();
    },
    async refresh() {
      pendingRead = true;
      await flush();
    },
    dispose() {
      disposed = true;
    },
  };
}
