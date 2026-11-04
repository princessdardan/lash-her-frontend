import { withWriterAdmission } from "@/lib/writer-admission/route";
import { createSquareWebhookPostHandler, defaultDependencies } from "./handler";

export const runtime = "nodejs";

// Only verified refunds and classified training-invoice-paid recovery adopt
// admission. Other Square branches require their own qualification.
const runRecovery = (task: () => Promise<Response>) =>
  withWriterAdmission("recovery", task)();
export const POST = createSquareWebhookPostHandler(
  defaultDependencies, runRecovery, runRecovery,
);
