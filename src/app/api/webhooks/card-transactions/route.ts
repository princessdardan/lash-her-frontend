import { getHelcimWebhookVerifierToken } from "@/lib/env/private-checkout";
import { recordHelcimWebhookEvent } from "@/lib/commerce/order-store";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import {
  getHelcimWebhookHeaders,
  mergeHelcimCardTransactionDetails,
  parseVerifiedHelcimWebhook,
  verifyHelcimWebhookSignature,
} from "@/lib/commerce/helcim-webhook";

export const runtime = "nodejs";

interface HelcimWebhookDependencies {
  getCardTransaction: typeof getHelcimCardTransaction;
  getVerifierToken: typeof getHelcimWebhookVerifierToken;
  recordEvent: typeof recordHelcimWebhookEvent;
}

const defaultDependencies: HelcimWebhookDependencies = {
  getCardTransaction: getHelcimCardTransaction,
  getVerifierToken: getHelcimWebhookVerifierToken,
  recordEvent: recordHelcimWebhookEvent,
};

export const POST = createHelcimWebhookPostHandler(defaultDependencies);

export function createHelcimWebhookPostHandler(
  dependencies: HelcimWebhookDependencies,
): (req: Request) => Promise<Response> {
  return async function postHelcimWebhook(req: Request): Promise<Response> {
    const headers = getHelcimWebhookHeaders(req.headers);

    if (headers === null) {
      console.warn("[helcim-webhook] Missing signature headers");
      return new Response(null, { status: 401 });
    }

    const rawBody = await req.text();
    const isValidSignature = verifyHelcimWebhookSignature(
      headers,
      rawBody,
      dependencies.getVerifierToken(),
    );

    if (!isValidSignature) {
      console.warn("[helcim-webhook] Invalid signature");
      return new Response(null, { status: 401 });
    }

    let event: ParsedHelcimWebhook;

    try {
      event = parseVerifiedHelcimWebhook(headers, rawBody);
    } catch (error) {
      console.warn("[helcim-webhook] Invalid payload", error);
      return new Response(null, { status: 400 });
    }

    let eventForStorage: ParsedHelcimWebhook;

    try {
      eventForStorage = await reconcileCardTransactionWebhook(event, dependencies);
    } catch (error) {
      console.warn("[helcim-webhook] Transaction detail fetch failed", error);
      return new Response(null, { status: 503 });
    }

    try {
      await dependencies.recordEvent(eventForStorage);
    } catch (error) {
      console.warn("[helcim-webhook] Storage failed", error);
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}

type ParsedHelcimWebhook = ReturnType<typeof parseVerifiedHelcimWebhook>;

async function reconcileCardTransactionWebhook(
  event: ParsedHelcimWebhook,
  dependencies: Pick<HelcimWebhookDependencies, "getCardTransaction">,
): Promise<ParsedHelcimWebhook> {
  if (event.eventType !== "cardTransaction" || event.helcimTransactionId === undefined) {
    return event;
  }

  try {
    const details = await dependencies.getCardTransaction(event.helcimTransactionId);
    return mergeHelcimCardTransactionDetails(event, details);
  } catch (cause) {
    throw new HelcimWebhookReconciliationError(cause);
  }
}

class HelcimWebhookReconciliationError extends Error {
  constructor(cause: unknown) {
    super("Unable to fetch Helcim transaction details", { cause });
    this.name = "HelcimWebhookReconciliationError";
  }
}
