import "server-only";

import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { runWriterAdmission, type WriterAdmissionRunner, type WriterOperationKind } from "@/lib/writer-admission/runtime";

// Only non-streaming handlers whose provider/database work is awaited. Deferred
// and detached work needs the full operation context before adopting this adapter.
export function withWriterAdmission<Args extends unknown[]>(
  kind: WriterOperationKind,
  handler: (...args: Args) => Promise<Response>,
  run: WriterAdmissionRunner = runWriterAdmission,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await run(kind, () => handler(...args), { uncertainResult: response => response.status >= 500 });
    } catch (error) {
      if (!(error instanceof WriterAdmissionError)) throw error;
      return Response.json({ error: "This operation is temporarily unavailable. Please retry shortly." }, {
        status: 503, headers: { "cache-control": "no-store", "retry-after": "30" },
      });
    }
  };
}
