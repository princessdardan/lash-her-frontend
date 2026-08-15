import { createCustomerEmailOutboxCronHandler } from "@/lib/commerce/customer-email-outbox-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCustomerEmailOutboxCronHandler();
