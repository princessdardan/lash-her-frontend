import { withWriterAdmission } from "@/lib/writer-admission/route";
import { createSquareWebhookPostHandler, defaultDependencies } from "./handler";

export const runtime = "nodejs";

// Only signature-verified refund events adopt admission here. Other Square
// branches still require their own effect/outcome qualification.
export const POST = createSquareWebhookPostHandler(defaultDependencies, task =>
  withWriterAdmission("recovery", task)(),
);
