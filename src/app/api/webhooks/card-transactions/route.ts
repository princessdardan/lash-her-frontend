import { getHelcimWebhookVerifierToken } from "@/lib/env/private-checkout";
import { recordHelcimWebhookEvent } from "@/lib/commerce/order-store";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import { sendTrainingPaymentNotificationEmails } from "@/lib/commerce/training-payment-email";
import {
  issueTrainingSchedulingTokenForPaidHelcimInvoiceIfMissing,
  markTrainingEnrollmentStaffAlerted,
} from "@/lib/commerce/training-enrollment-store";
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
  issueSchedulingTokenForPaidHelcimInvoiceIfMissing: typeof issueTrainingSchedulingTokenForPaidHelcimInvoiceIfMissing;
  markTrainingEnrollmentStaffAlerted: typeof markTrainingEnrollmentStaffAlerted;
  recordEvent: typeof recordHelcimWebhookEvent;
  sendTrainingPaymentNotificationEmails: typeof sendTrainingPaymentNotificationEmails;
}

const defaultDependencies: HelcimWebhookDependencies = {
  getCardTransaction: getHelcimCardTransaction,
  getVerifierToken: getHelcimWebhookVerifierToken,
  issueSchedulingTokenForPaidHelcimInvoiceIfMissing: issueTrainingSchedulingTokenForPaidHelcimInvoiceIfMissing,
  markTrainingEnrollmentStaffAlerted,
  recordEvent: recordHelcimWebhookEvent,
  sendTrainingPaymentNotificationEmails,
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

    try {
      await recoverTrainingPaymentNotification(req, eventForStorage, dependencies);
    } catch (error) {
      console.error("[helcim-webhook] Training payment notification recovery failed", {
        error: error instanceof Error ? error.message : "Unknown recovery error",
        eventId: eventForStorage.eventId,
      });
    }

    return new Response(null, { status: 200 });
  };
}

type ParsedHelcimWebhook = ReturnType<typeof parseVerifiedHelcimWebhook>;

async function recoverTrainingPaymentNotification(
  req: Request,
  event: ParsedHelcimWebhook,
  dependencies: Pick<
    HelcimWebhookDependencies,
    | "issueSchedulingTokenForPaidHelcimInvoiceIfMissing"
    | "markTrainingEnrollmentStaffAlerted"
    | "sendTrainingPaymentNotificationEmails"
  >,
): Promise<void> {
  if (!isApprovedWebhookPayment(event)) {
    return;
  }

  const issued = await dependencies.issueSchedulingTokenForPaidHelcimInvoiceIfMissing({
    helcimInvoiceId: event.helcimInvoiceId,
    helcimInvoiceNumber: event.helcimInvoiceNumber,
  });

  if (!issued) {
    return;
  }

  await dependencies.sendTrainingPaymentNotificationEmails({
    customerEmail: issued.checkoutOrder.customerEmail,
    customerName: issued.checkoutOrder.customerName,
    orderId: issued.checkoutOrder.orderId,
    programTitle: issued.programSnapshot.title,
    schedulingUrl: buildAbsoluteSchedulingUrl(new URL(req.url).origin, issued.schedulingToken),
  });
  await dependencies.markTrainingEnrollmentStaffAlerted({
    enrollmentId: issued.enrollmentId,
  });
}

function isApprovedWebhookPayment(event: ParsedHelcimWebhook): boolean {
  if (event.eventType !== "cardTransaction" || event.helcimTransactionId === undefined) {
    return false;
  }

  return event.status !== undefined && ["approved", "completed", "success", "succeeded", "true"].includes(
    event.status.trim().toLowerCase(),
  );
}

function buildAbsoluteSchedulingUrl(origin: string, schedulingToken: string): string {
  const url = new URL("/booking", origin);
  url.searchParams.set("type", "training-call");
  url.searchParams.set("token", schedulingToken);
  return url.toString();
}

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
