import type { WebhookEventPayload } from "resend";

import { recordResendUnsubscribe } from "@/lib/marketing-contact/marketing-contact-store";
import { readBoundedTextBody } from "@/lib/security/bounded-text-body";
import { getResendClient } from "@/lib/transactional-email";

export const runtime = "nodejs";

/**
 * Hard cap on the raw webhook body we will buffer and verify. Svix signs
 * `${id}.${timestamp}.${body}`, so verification must run over the exact raw
 * bytes and cannot parse first. Real Resend webhook events are a few KB; 64 KB
 * is far above any legitimate event while keeping an unauthenticated caller from
 * making us buffer and HMAC an unbounded body. An oversized body is rejected
 * before any signature work — see the bounded read in
 * createResendWebhookPostHandler.
 */
const RESEND_WEBHOOK_BODY_MAX_BYTES = 64_000;

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

    // Read the raw body with a hard byte cap BEFORE any signature verification.
    // Svix verifies the HMAC over the exact raw bytes, so we cannot parse first;
    // a bounded raw-text read rejects an oversized body (413) without hashing it.
    const boundedBody = await readBoundedTextBody(
      req,
      RESEND_WEBHOOK_BODY_MAX_BYTES,
    );
    if (!boundedBody.ok) {
      dependencies.logWarn(
        "[resend-webhook] Rejected webhook body over the size limit before signature verification",
        { maxBytes: RESEND_WEBHOOK_BODY_MAX_BYTES },
      );
      return new Response(null, { status: 413 });
    }
    const payload = boundedBody.value;
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
        dependencies.logError(
          "[resend-webhook] Unsubscribe persistence failed",
          {
            error:
              error instanceof Error
                ? error.message
                : "Unknown unsubscribe persistence error",
            resendContactId: event.data.id,
          },
        );
        return new Response(null, { status: 503 });
      }
    }

    return new Response(null, { status: 200 });
  };
}

function getResendWebhookHeaders(
  headers: Headers,
): ResendWebhookHeaders | null {
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
