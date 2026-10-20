import { createHighLevelWebhookHandler } from "@/lib/highlevel/webhook";
export const runtime = "nodejs";
export const POST = createHighLevelWebhookHandler();
