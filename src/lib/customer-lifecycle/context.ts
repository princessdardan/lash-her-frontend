import { AsyncLocalStorage } from "node:async_hooks";
import { runWriterAdmission, type WriterOperationKind } from "@/lib/writer-admission/runtime";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { AccountLifecycleError } from "./policy";

const context = new AsyncLocalStorage<boolean>();
export function assertAccountWriter(): void {
  if (!context.getStore()) throw new Error("ACCOUNT_WRITER_REQUIRES_ADMISSION");
}
export async function runAccountWriter<T>(kind: WriterOperationKind, task: () => Promise<T>): Promise<T> {
  if (context.getStore()) return task();
  const outcome = await runWriterAdmission(kind, () => context.run(true, async () => {
    try { return { value: await task() }; }
    catch (error) {
      // A confirmed transaction rollback/domain refusal is a known outcome.
      // Throw it only after the enclosing admission operation settles cleanly.
      if (error instanceof AccountLifecycleError) return { denied: error };
      markWriterOperationUncertain();
      throw error;
    }
  }));
  if ("denied" in outcome) throw outcome.denied;
  return outcome.value;
}
