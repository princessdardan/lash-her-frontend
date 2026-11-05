import { createCustomerEmailOutboxCronHandler } from "@/lib/commerce/customer-email-outbox-cron";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCustomerEmailOutboxCronHandler(undefined, (task) =>
  runWriterAdmission("recovery", task, {
    uncertainResult: (result) => result.failed > 0,
  }),
);
