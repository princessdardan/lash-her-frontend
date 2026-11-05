import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Service monitor, email, split and capture batches have independent entries.
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
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (summary) => !summary.ok,
    }),
);
