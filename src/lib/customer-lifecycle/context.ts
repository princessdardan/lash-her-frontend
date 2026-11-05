import { AsyncLocalStorage } from "node:async_hooks";
import { runWriterAdmission, type WriterOperationKind } from "@/lib/writer-admission/runtime";

const context = new AsyncLocalStorage<boolean>();
export function assertAccountWriter(): void {
  if (!context.getStore()) throw new Error("ACCOUNT_WRITER_REQUIRES_ADMISSION");
}
export function runAccountWriter<T>(kind: WriterOperationKind, task: () => Promise<T>): Promise<T> {
  if (context.getStore()) return task();
  return runWriterAdmission(kind, () => context.run(true, task));
}
