import "server-only";

import type { AdminUserRepository } from "./admin-user-store";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
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
    createBootstrapOwner: (input, options) =>
      runAdminIdentityWriter(
        "new-work",
        () => repository.createBootstrapOwner(input, options),
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
  return runWriterAdmissionWithParent(kind, task, run);
}
