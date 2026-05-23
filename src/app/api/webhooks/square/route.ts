import { finalizeSquarePayment } from "@/lib/booking/square-payment-finalizer";
import {
  getSquareWebhookHeaders,
  parseVerifiedSquareWebhook,
  verifySquareWebhookSignature,
} from "@/lib/booking/square-webhook";

export const runtime = "nodejs";

interface SquareWebhookDependencies {
  finalizeSquarePayment: typeof finalizeSquarePayment;
  getEnv: () => Promise<SquareWebhookEnv | null> | SquareWebhookEnv | null;
}

interface SquareWebhookEnv {
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

const defaultDependencies: SquareWebhookDependencies = {
  finalizeSquarePayment,
  async getEnv() {
    const { getSquareServiceBookingRuntimeEnv } = await import("@/lib/booking/square-runtime");
    return getSquareServiceBookingRuntimeEnv();
  },
};

export const POST = createSquareWebhookPostHandler(defaultDependencies);

export function createSquareWebhookPostHandler(
  dependencies: SquareWebhookDependencies,
): (req: Request) => Promise<Response> {
  return async function postSquareWebhook(req) {
    const env = await dependencies.getEnv();

    if (env === null) {
      console.warn("[square-webhook] Square service booking is not enabled");
      return new Response(null, { status: 404 });
    }

    const headers = getSquareWebhookHeaders(req.headers);

    if (headers === null) {
      console.warn("[square-webhook] Missing signature header");
      return new Response(null, { status: 401 });
    }

    const rawBody = await req.text();
    const isValidSignature = verifySquareWebhookSignature({
      notificationUrl: env.serviceBookingWebhookUrl,
      rawBody,
      signature: headers.signature,
      signatureKey: env.webhookSignatureKey,
    });

    if (!isValidSignature) {
      console.warn("[square-webhook] Invalid signature");
      return new Response(null, { status: 401 });
    }

    let event: ReturnType<typeof parseVerifiedSquareWebhook>;

    try {
      event = parseVerifiedSquareWebhook(rawBody);
    } catch (error) {
      console.warn("[square-webhook] Invalid payload", error);
      return new Response(null, { status: 400 });
    }

    try {
      await dependencies.finalizeSquarePayment({
        event,
        source: "webhook",
      });
    } catch (error) {
      console.error("[square-webhook] Square payment finalization failed", {
        error: error instanceof Error ? error.message : "Unknown finalization error",
        eventId: event.eventId,
      });
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}
