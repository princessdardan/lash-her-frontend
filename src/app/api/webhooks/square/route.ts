import { withWriterAdmission } from "@/lib/writer-admission/route";
import { createSquareWebhookPostHandler, defaultDependencies } from "./handler";

export const runtime = "nodejs";

// Verified refunds, training-invoice-paid and all commerce-payment recovery adopt
// admission, as do classified no-show/operational payments and the remaining
// ordinary booking webhook path. Returns and independent workers are separate.
const runRecovery = (task: () => Promise<Response>) =>
  withWriterAdmission("recovery", task)();
export const POST = createSquareWebhookPostHandler(
  defaultDependencies, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery,
);
