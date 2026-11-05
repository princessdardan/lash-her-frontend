import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The email and uncaptured-commerce batches acquire separate recovery entries.
// The service monitor and training-split reconciliation remain unqualified.
export const GET = createPaymentReconciliationGetHandler(
  defaultDependencies,
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (summary) => summary.failed > 0,
    }),
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (summary) =>
        summary.failed > 0 || summary.uncollected > 0,
    }),
);
