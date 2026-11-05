import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Email, uncaptured-commerce and training-split batches have separate entries.
// The service monitor remains unqualified.
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
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (summary) => summary.failed > 0,
    }),
);
