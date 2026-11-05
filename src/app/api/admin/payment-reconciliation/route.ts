import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import {
  createPaymentReconciliationGetHandler,
  defaultDependencies,
} from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only the booking-outcome retry batch acquires this boundary. The monitor and
// commerce capture reconciliation still require independent qualification.
export const GET = createPaymentReconciliationGetHandler(
  defaultDependencies,
  (task) =>
    runWriterAdmission("recovery", task, {
      uncertainResult: (summary) => summary.failed > 0,
    }),
);
