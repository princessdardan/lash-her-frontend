import type { WebhookEventPayload } from "resend";

import { recordResendUnsubscribe } from "@/lib/marketing-contact/marketing-contact-store";
import { getResendClient } from "@/lib/transactional-email";

export const runtime = "nodejs";

interface ResendWebhookHeaders {
  id: string;
  signature: string;
  timestamp: string;
}

interface ResendWebhookDependencies {
  getWebhookSecret: () => string | undefined;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  recordResendUnsubscribe: typeof recordResendUnsubscribe;
  verifyEvent: (input: {
    headers: ResendWebhookHeaders;
    payload: string;
    webhookSecret: string;
  }) => WebhookEventPayload;
}

const defaultDependencies: ResendWebhookDependencies = {
  getWebhookSecret: () => getOptionalEnv("RESEND_WEBHOOK_SECRET"),
  logError: console.error,
  logWarn: console.warn,
  recordResendUnsubscribe,
  verifyEvent: (input) => getResendClient().webhooks.verify(input),
};

export const POST = createResendWebhookPostHandler(defaultDependencies);

export function createResendWebhookPostHandler(
  dependencies: ResendWebhookDependencies,
): (req: Request) => Promise<Response> {
  return async function postResendWebhook(req: Request): Promise<Response> {
    const webhookSecret = dependencies.getWebhookSecret();

    if (webhookSecret === undefined) {
      return new Response(null, { status: 404 });
    }

    const headers = getResendWebhookHeaders(req.headers);

    if (headers === null) {
      dependencies.logWarn("[resend-webhook] Missing signature headers");
      return new Response(null, { status: 401 });
    }

    const payload = await req.text();
    let event: WebhookEventPayload;

    try {
      event = dependencies.verifyEvent({ headers, payload, webhookSecret });
    } catch (error) {
      dependencies.logWarn("[resend-webhook] Invalid signature", error);
      return new Response(null, { status: 401 });
    }

    if (event.type === "contact.updated" && event.data.unsubscribed) {
      try {
        await dependencies.recordResendUnsubscribe({
          email: event.data.email,
          metadata: {
            resendSegmentIds: event.data.segment_ids,
          },
          occurredAt: new Date(event.created_at),
          resendContactId: event.data.id,
        });
      } catch (error) {
        dependencies.logError("[resend-webhook] Unsubscribe persistence failed", {
          error: error instanceof Error ? error.message : "Unknown unsubscribe persistence error",
          resendContactId: event.data.id,
        });
        return new Response(null, { status: 503 });
      }
    }

    return new Response(null, { status: 200 });
  };
}

function getResendWebhookHeaders(headers: Headers): ResendWebhookHeaders | null {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");

  if (id === null || timestamp === null || signature === null) {
    return null;
  }

  return { id, signature, timestamp };
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value ? value : undefined;
}
