import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

// Only this semantic admin boundary may reuse its parent. An unrelated writer
// context does not qualify staff authentication, transport and validation.
const context = new AsyncLocalStorage<boolean>();
export async function runCourseAdminOperation<T>(work: () => Promise<T>, run: WriterAdmissionRunner = runWriterAdmission): Promise<T> {
  if (context.getStore() === true) return work();
  return runWriterAdmissionWithParent("new-work", () => context.run(true, work), run);
}
