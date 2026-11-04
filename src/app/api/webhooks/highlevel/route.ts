import { createHighLevelWebhookHandler } from "@/lib/highlevel/webhook";
import { withWriterAdmission } from "@/lib/writer-admission/route";
export const runtime = "nodejs";
export const POST = withWriterAdmission("recovery", createHighLevelWebhookHandler());
