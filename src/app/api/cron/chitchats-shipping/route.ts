import { createShippingWorkerCronHandler } from "./handler";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";

export const runtime = "nodejs";

export const GET = createShippingWorkerCronHandler(
  undefined,
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (result) =>
        result.needsReview > 0 ||
        result.refunds.some((refund) => refund.status !== "succeeded"),
    }),
  (task) => runWriterAdmission("recovery", task),
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (result) =>
        result.retried > 0 || result.deadLettered > 0 || result.fenced > 0,
    }),
);
