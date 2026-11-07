import "server-only";

import { markWriterOperationUncertain } from "./context";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
  type WriterOperationKind,
} from "@/lib/writer-admission/runtime";

// The callback must await every effect and mark any caught uncertain outcome.
// Perform framework redirects only after this promise has settled.
export async function runActionWriterAdmission<T>(
  kind: WriterOperationKind,
  task: () => Promise<T>,
  unavailable: () => T,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  try {
    return await run(kind, task);
  } catch (error) {
    markWriterOperationUncertain();
    if (!(error instanceof WriterAdmissionError)) throw error;
    return unavailable();
  }
}

// Nested boundaries must preserve an unknown inner outcome in their caller,
// even when that caller catches the inner admission error as a domain failure.
export async function runWriterAdmissionWithParent<T>(
  kind: WriterOperationKind,
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  try {
    return await run(kind, task);
  } catch (error) {
    markWriterOperationUncertain();
    throw error;
  }
}
