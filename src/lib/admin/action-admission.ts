import "server-only";

import { WriterAdmissionError } from "@/lib/writer-admission/config";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
} from "@/lib/writer-admission/runtime";

export const ADMIN_WRITER_UNAVAILABLE =
  "This operation is temporarily unavailable. Please retry shortly.";

// Keep redirects outside this callback so a successful mutation is settled
// before Next.js throws its redirect control-flow exception.
export async function attemptAdmittedAdminAction<T>(
  task: () => Promise<T>,
  friendlyError: (error: unknown) => string,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<{ ok: true; value: T } | { error: string; ok: false }> {
  try {
    const value = await run("new-work", task);
    return { ok: true, value };
  } catch (error) {
    return {
      error:
        error instanceof WriterAdmissionError
          ? ADMIN_WRITER_UNAVAILABLE
          : friendlyError(error),
      ok: false,
    };
  }
}
