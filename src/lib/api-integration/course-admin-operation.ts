import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { requireStagingOwnerCourseReader } from "@/lib/admin/auth";
import { stagingOwnerRequest } from "@/lib/admin/staging-owner-auth";
import type { AdminActor } from "@/lib/admin/types";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

// Only this semantic admin boundary may reuse its parent. An unrelated writer
// context does not qualify staff authentication, transport and validation.
const context = new AsyncLocalStorage<boolean>();
const ownerRead = new AsyncLocalStorage<AdminActor>();
export async function runCourseAdminOperation<T>(work: () => Promise<T>, run: WriterAdmissionRunner = runWriterAdmission): Promise<T> {
  if (context.getStore() === true) return work();
  return runWriterAdmissionWithParent("new-work", () => context.run(true, work), run);
}

// The protected staging owner lookup is read-only. Its context can qualify
// Course editor GETs, while Course mutations still enter their own admission.
export async function runCourseAdminReadOperation<T>(
  work: (owner: AdminActor | null) => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  const current = ownerRead.getStore();
  if (current) return work(current);
  if (!(await stagingOwnerRequest()))
    return runCourseAdminOperation(() => work(null), run);
  const actor = await requireStagingOwnerCourseReader();
  return ownerRead.run(actor, () => work(actor));
}
