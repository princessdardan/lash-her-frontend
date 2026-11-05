import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
} from "@/lib/writer-admission/runtime";
import { AdminAuthError } from "./types";

type AdminReadOperation =
  | "appointment-detail"
  | "marketing-contacts"
  | "calendar-discovery";
const context = new AsyncLocalStorage<AdminReadOperation>();

// These reads refresh an existing identity, record access, or refresh an existing
// Calendar credential. Binding/bootstrap retains its own new-work admission.
// An unrelated writer or another read domain cannot qualify this operation.
export async function runAdminReadOperation<T>(
  operation: AdminReadOperation,
  work: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  if (context.getStore() === operation) return work();
  const outcome = await runWriterAdmissionWithParent("recovery", () =>
    context.run(operation, async () => {
      try {
        return { ok: true as const, value: await work() };
      } catch (error) {
        if (error instanceof AdminAuthError) return { ok: false as const, error };
        throw error;
      }
    }), run);
  // Framework redirects and known denials occur only after durable settlement.
  // A caught/marked uncertain audit still prevents successful settlement.
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
