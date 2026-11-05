import "server-only";

import { runWriterAdmissionWithParent } from "./action";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
  type WriterOperationKind,
} from "./runtime";

// The dry-run callback must remain read-only. Write-mode admission precedes
// even the inventory/provider reads used to decide which writes to perform.
export async function runManualWriterAdmission<T>(
  execute: boolean,
  kind: WriterOperationKind,
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  return execute ? runWriterAdmissionWithParent(kind, task, run) : task();
}
