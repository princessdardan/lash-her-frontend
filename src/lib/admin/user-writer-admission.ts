import "server-only";

import type { AdminUserRepository } from "./admin-user-store";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
  type WriterOperationKind,
} from "@/lib/writer-admission/runtime";

// These entries also cover admin renders that update identity without a parent
// action. Existing-user refresh is recovery; first binding/bootstrap is new work.
export function withAdminUserWriterAdmission(
  repository: AdminUserRepository,
  run: WriterAdmissionRunner = runWriterAdmission,
): AdminUserRepository {
  return {
    ...repository,
    bindIdentity: (input) =>
      runAdminIdentityWriter(
        "new-work",
        () => repository.bindIdentity(input),
        run,
      ),
    createBootstrapOwner: (input) =>
      runAdminIdentityWriter(
        "new-work",
        () => repository.createBootstrapOwner(input),
        run,
      ),
    recordSignIn: (input) =>
      runAdminIdentityWriter(
        "recovery",
        () => repository.recordSignIn(input),
        run,
      ),
  };
}

export async function runAdminIdentityWriter<T>(
  kind: WriterOperationKind,
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  try {
    return await run(kind, task);
  } catch (error) {
    // Nested admission restores its caller's context before rejecting. Preserve
    // the parent's uncertainty when auth policy catches the inner failure.
    markWriterOperationUncertain();
    throw error;
  }
}
