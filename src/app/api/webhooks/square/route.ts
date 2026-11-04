import { withWriterAdmission } from "@/lib/writer-admission/route";
import { createSquareWebhookPostHandler, defaultDependencies } from "./handler";

export const runtime = "nodejs";

// Verified refunds, training-invoice-paid and all commerce-payment recovery adopt
// admission, as do classified no-show charges. Booking/operational branches
// require their own qualification.
const runRecovery = (task: () => Promise<Response>) =>
  withWriterAdmission("recovery", task)();
export const POST = createSquareWebhookPostHandler(
  defaultDependencies, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery, runRecovery,
);
