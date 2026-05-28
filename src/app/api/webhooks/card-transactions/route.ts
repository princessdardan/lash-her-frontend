import { getHelcimWebhookVerifierToken } from "@/lib/env/private-checkout";
import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import {
  recordHelcimWebhookEventWithOrder,
  type HelcimWebhookEventRecordResult,
} from "@/lib/commerce/order-store";
import {
  finalizeAppointmentPaymentForOrder,
  isAppointmentCheckoutPurpose,
} from "@/lib/booking/finalizer";
import { sendBookingConfirmationEmailForOrder } from "@/lib/booking/email";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import { sendProductOrderConfirmationEmailForOrder } from "@/lib/commerce/product-order-email";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import { sendTrainingPaymentNotificationEmailsIfNeeded } from "@/lib/commerce/training-payment-notifications";
import {
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
  getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice,
} from "@/lib/commerce/training-enrollment-store";
import {
  getHelcimWebhookHeaders,
  mergeHelcimCardTransactionDetails,
  parseVerifiedHelcimWebhook,
  verifyHelcimWebhookSignature,
} from "@/lib/commerce/helcim-webhook";
import { buildTrainingScheduleUrl } from "@/lib/training-checkout";

export const runtime = "nodejs";

const webhookPaymentMockStore = createPaymentMockStore();

interface HelcimWebhookDependencies {
  finalizeAppointmentPaymentForOrder: typeof finalizeAppointmentPaymentForOrder;
  getCardTransaction: (cardTransactionId: string, req: Request) => ReturnType<typeof getHelcimCardTransaction>;
  getVerifierToken: typeof getHelcimWebhookVerifierToken;
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: typeof getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing;
  getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: typeof getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice;
  recordEvent: typeof recordHelcimWebhookEventWithOrder;
  sendBookingConfirmationEmailForOrder: typeof sendBookingConfirmationEmailForOrder;
  sendProductOrderConfirmationEmailForOrder: typeof sendProductOrderConfirmationEmailForOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
}

const defaultDependencies: HelcimWebhookDependencies = {
  finalizeAppointmentPaymentForOrder,
  getCardTransaction: async (cardTransactionId, req) => {
    const gateway = await resolveHelcimWebhookGatewayForRequest(req);
    return gateway.getCardTransaction(cardTransactionId);
  },
  getVerifierToken: getHelcimWebhookVerifierToken,
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
  getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice,
  recordEvent: recordHelcimWebhookEventWithOrder,
  sendBookingConfirmationEmailForOrder,
  sendProductOrderConfirmationEmailForOrder,
  sendTrainingPaymentNotificationEmailsIfNeeded,
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
      eventForStorage = await reconcileCardTransactionWebhook(req, event, dependencies);
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
      return new Response(null, { status: 503 });
    }

    try {
      await recoverProductOrderConfirmationEmail(eventForStorage, recordedEvent, dependencies);
    } catch (error) {
      console.error("[helcim-webhook] Product confirmation email recovery failed", {
        error: error instanceof Error ? error.message : "Unknown recovery error",
        eventId: eventForStorage.eventId,
      });
      return new Response(null, { status: 503 });
    }

    try {
      await recoverTrainingPaymentNotification(req, eventForStorage, dependencies);
    } catch (error) {
      console.error("[helcim-webhook] Training payment notification recovery failed", {
        error: error instanceof Error ? error.message : "Unknown recovery error",
        eventId: eventForStorage.eventId,
      });
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}

type ParsedHelcimWebhook = ReturnType<typeof parseVerifiedHelcimWebhook>;

async function finalizeAppointmentWebhookPayment(
  event: ParsedHelcimWebhook,
  recordedEvent: HelcimWebhookEventRecordResult,
  dependencies: Pick<HelcimWebhookDependencies, "finalizeAppointmentPaymentForOrder" | "sendBookingConfirmationEmailForOrder">,
): Promise<void> {
  const transactionId = event.helcimTransactionId;

  if (
    !recordedEvent.paid ||
    recordedEvent.matchedOrder === null ||
    recordedEvent.matchedOrder.paymentProvider !== "helcim" ||
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

  if (result.ok) {
    await dependencies.sendBookingConfirmationEmailForOrder(recordedEvent.matchedOrder.orderId);
  }
}

async function recoverProductOrderConfirmationEmail(
  event: ParsedHelcimWebhook,
  recordedEvent: HelcimWebhookEventRecordResult,
  dependencies: Pick<HelcimWebhookDependencies, "sendProductOrderConfirmationEmailForOrder">,
): Promise<void> {
  if (
    !recordedEvent.paid ||
    recordedEvent.matchedOrder === null ||
    recordedEvent.matchedOrder.paymentProvider !== "helcim" ||
    recordedEvent.matchedOrder.purpose !== "product" ||
    !isApprovedWebhookPayment(event)
  ) {
    return;
  }

  await dependencies.sendProductOrderConfirmationEmailForOrder(recordedEvent.matchedOrder.orderId);
}

async function recoverTrainingPaymentNotification(
  req: Request,
  event: ParsedHelcimWebhook,
  dependencies: Pick<
    HelcimWebhookDependencies,
    | "getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing"
    | "getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice"
    | "sendTrainingPaymentNotificationEmailsIfNeeded"
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

  const schedulingToken = await dependencies.getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice({
    helcimInvoiceId: event.helcimInvoiceId,
    helcimInvoiceNumber: event.helcimInvoiceNumber,
  });

  if (!schedulingToken) {
    throw new Error("Training scheduling token could not be issued");
  }

  const programSlug = enrollment.programSnapshot.slug;

  if (!programSlug) {
    throw new Error("Training program slug is missing");
  }

  await dependencies.sendTrainingPaymentNotificationEmailsIfNeeded({
    enrollment,
    paymentProvider: "helcim",
    schedulingUrl: buildAbsoluteSchedulingUrl(
      new URL(req.url).origin,
      programSlug,
      schedulingToken.schedulingToken,
    ),
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

function buildAbsoluteSchedulingUrl(origin: string, programSlug: string, schedulingToken: string): string {
  return new URL(
    buildTrainingScheduleUrl({
      programSlug,
      schedulingToken,
    }),
    origin,
  ).toString();
}

async function reconcileCardTransactionWebhook(
  req: Request,
  event: ParsedHelcimWebhook,
  dependencies: Pick<HelcimWebhookDependencies, "getCardTransaction">,
): Promise<ParsedHelcimWebhook> {
  if (event.eventType !== "cardTransaction" || event.helcimTransactionId === undefined) {
    return event;
  }

  try {
    const details = await dependencies.getCardTransaction(event.helcimTransactionId, req);
    return mergeHelcimCardTransactionDetails(event, details);
  } catch (cause) {
    throw new HelcimWebhookReconciliationError(cause);
  }
}

export async function resolveHelcimWebhookGatewayForRequest(req: Request): Promise<HelcimGateway> {
  const [env, runtimeControls] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("@/lib/payment-mocks/runtime-controls"),
  ]);
  const runtimeEnvironment = env.getPaymentMockRuntimeEnvironment();

  runtimeControls.assertPaymentMockAllowed({ env: runtimeEnvironment, request: req });

  if (runtimeControls.resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
    const liveGateway = await import("@/lib/commerce/helcim-gateway");
    return liveGateway.createLiveHelcimGateway();
  }

  const mockGateway = await import("@/lib/commerce/helcim-mock-gateway");

  return mockGateway.createMockHelcimGateway({
    scenario: runtimeControls.resolvePaymentMockScenario({
      env: runtimeEnvironment,
      now: new Date(),
      request: req,
    }),
    store: webhookPaymentMockStore,
  });
}

class HelcimWebhookReconciliationError extends Error {
  constructor(cause: unknown) {
    super("Unable to fetch Helcim transaction details", { cause });
    this.name = "HelcimWebhookReconciliationError";
  }
}
