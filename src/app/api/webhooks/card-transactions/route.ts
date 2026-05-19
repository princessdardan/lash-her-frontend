import { getHelcimWebhookVerifierToken } from "@/lib/env/private-checkout";
import {
  recordHelcimWebhookEventWithOrder,
  type HelcimWebhookEventRecordResult,
} from "@/lib/commerce/order-store";
import {
  finalizeAppointmentPaymentForOrder,
  isAppointmentCheckoutPurpose,
} from "@/lib/booking/finalizer";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import { sendTrainingPaymentNotificationEmails } from "@/lib/commerce/training-payment-email";
import {
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
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
  finalizeAppointmentPaymentForOrder: typeof finalizeAppointmentPaymentForOrder;
  getCardTransaction: typeof getHelcimCardTransaction;
  getVerifierToken: typeof getHelcimWebhookVerifierToken;
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: typeof getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing;
  markTrainingEnrollmentStaffAlerted: typeof markTrainingEnrollmentStaffAlerted;
  recordEvent: typeof recordHelcimWebhookEventWithOrder;
  sendTrainingPaymentNotificationEmails: typeof sendTrainingPaymentNotificationEmails;
}

const defaultDependencies: HelcimWebhookDependencies = {
  finalizeAppointmentPaymentForOrder,
  getCardTransaction: getHelcimCardTransaction,
  getVerifierToken: getHelcimWebhookVerifierToken,
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
  markTrainingEnrollmentStaffAlerted,
  recordEvent: recordHelcimWebhookEventWithOrder,
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

    let recordedEvent: HelcimWebhookEventRecordResult;

    try {
      recordedEvent = await dependencies.recordEvent(eventForStorage);
    } catch (error) {
      console.warn("[helcim-webhook] Storage failed", error);
      return new Response(null, { status: 503 });
    }

    try {
      await finalizeAppointmentWebhookPayment(eventForStorage, recordedEvent, dependencies);
    } catch (error) {
      console.error("[helcim-webhook] Appointment payment finalization failed", {
        error: error instanceof Error ? error.message : "Unknown finalization error",
        eventId: eventForStorage.eventId,
      });
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

async function finalizeAppointmentWebhookPayment(
  event: ParsedHelcimWebhook,
  recordedEvent: HelcimWebhookEventRecordResult,
  dependencies: Pick<HelcimWebhookDependencies, "finalizeAppointmentPaymentForOrder">,
): Promise<void> {
  const transactionId = event.helcimTransactionId;

  if (
    !recordedEvent.paid ||
    recordedEvent.matchedOrder === null ||
    transactionId === undefined ||
    !isApprovedWebhookPayment(event) ||
    !isAppointmentCheckoutPurpose(recordedEvent.matchedOrder.purpose)
  ) {
    return;
  }

  const result = await dependencies.finalizeAppointmentPaymentForOrder({
    order: recordedEvent.matchedOrder,
    source: "webhook",
    transactionId,
  });

  if (!result.ok) {
    console.error("[helcim-webhook] Appointment booking finalization requires follow-up", {
      error: result.error,
      orderId: recordedEvent.matchedOrder.orderId,
      status: result.status,
    });
  }
}

async function recoverTrainingPaymentNotification(
  req: Request,
  event: ParsedHelcimWebhook,
  dependencies: Pick<
    HelcimWebhookDependencies,
    | "getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing"
    | "markTrainingEnrollmentStaffAlerted"
    | "sendTrainingPaymentNotificationEmails"
  >,
): Promise<void> {
  if (!isApprovedWebhookPayment(event)) {
    return;
  }

  const enrollment = await dependencies.getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing({
    helcimInvoiceId: event.helcimInvoiceId,
    helcimInvoiceNumber: event.helcimInvoiceNumber,
  });

  if (!enrollment) {
    return;
  }

  const alertClaimed = await dependencies.markTrainingEnrollmentStaffAlerted({
    enrollmentId: enrollment.enrollmentId,
  });

  if (!alertClaimed) {
    return;
  }

  await dependencies.sendTrainingPaymentNotificationEmails({
    customerEmail: enrollment.checkoutOrder.customerEmail,
    customerName: enrollment.checkoutOrder.customerName,
    orderId: enrollment.checkoutOrder.orderId,
    programTitle: enrollment.programSnapshot.title,
    schedulingUrl: buildAbsoluteSchedulingUrl(new URL(req.url).origin, enrollment.checkoutOrder.orderId),
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

function buildAbsoluteSchedulingUrl(origin: string, orderId: string): string {
  const url = new URL("/booking", origin);
  url.searchParams.set("type", "training-call");
  url.searchParams.set("order", orderId);
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
