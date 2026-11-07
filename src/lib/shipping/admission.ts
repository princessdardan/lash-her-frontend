import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { assertWriterOperationCertain, markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
} from "@/lib/writer-admission/runtime";

// Only the same shipping operation may own a nested call. An unrelated
// admitted worker or action is not authority to bypass this boundary.
const shippingOperation = new AsyncLocalStorage<"cron" | "execution" | "redaction">();

export function runShippingExecutionAdmission<T>(
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  const parent = shippingOperation.getStore();
  if (parent === "execution") return task();
  if (parent === "cron") {
    return shippingOperation.run("execution", async () => {
      const result = await task();
      // Per-job callers reuse this batch context, so every claimed job finishes
      // before an unknown result refuses the following maintenance stage.
      assertWriterOperationCertain();
      return result;
    });
  }
  return runWriterAdmissionWithParent("recovery", () => shippingOperation.run("execution", task), run);
}

export function runShippingCronAdmission(
  task: () => Promise<Response>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<Response> {
  return runWriterAdmissionWithParent("recovery", () => shippingOperation.run("cron", async () => {
    const response = await task();
    if (response.status >= 500) markWriterOperationUncertain();
    return response;
  }), run);
}

export async function runShippingPiiAdmission<T>(
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  if (shippingOperation.getStore() === "redaction") return task();
  try {
    return await run("new-work", () => shippingOperation.run("redaction", task));
  } catch (error) {
    // The optional cron maintenance stage can skip a known pre-entry refusal:
    // no task effects started. Configuration and uncertain outcomes cannot skip.
    if (!(error instanceof WriterAdmissionError && error.code === "unavailable")) {
      markWriterOperationUncertain();
    }
    throw error;
  }
}
