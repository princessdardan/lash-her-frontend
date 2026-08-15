import { log } from "@/lib/logging/logger";
import { getHelcimWebhookVerifierToken } from "@/lib/env/private-checkout";
import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import {
  recordHelcimWebhookEventWithOrder,
  markHelcimWebhookEventProcessingStatus,
  type HelcimWebhookEventRecordResult,
} from "@/lib/commerce/order-store";
import {
  finalizeAppointmentPaymentForOrder,
  isAppointmentCheckoutPurpose,
  isBookingFinalizationStatusAlertable,
} from "@/lib/booking/finalizer";
import {
  sendBookingConfirmationEmailForOrder,
  sendBookingSchedulingFailureAdminEmail,
} from "@/lib/booking/email";
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
import { activateShipmentForPaidOrder } from "@/lib/shipping/shipment-store";
import { reconcileProductOrderRefund } from "@/lib/shipping/customer-refunds";
import { classifyHelcimTransaction } from "@/lib/commerce/helcim-contract";
import { finalizeProductPayment } from "@/lib/commerce/product-payment-finalizer";
import { parseProviderMoneyCents } from "@/lib/shipping/provider-money";

export const runtime = "nodejs";

const webhookPaymentMockStore = createPaymentMockStore();
const HELCIM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

interface HelcimWebhookDependencies {
  activateShipmentForPaidOrder?: typeof activateShipmentForPaidOrder;
  finalizeAppointmentPaymentForOrder: typeof finalizeAppointmentPaymentForOrder;
  finalizeProductPayment?: typeof finalizeProductPayment;
  getAppointmentHoldByCheckoutOrderPublicId?: typeof import("@/lib/booking/holds").getAppointmentHoldByCheckoutOrderPublicId;
  getCardTransaction: (
    cardTransactionId: string,
    req: Request,
  ) => ReturnType<typeof getHelcimCardTransaction>;
  getVerifierToken: typeof getHelcimWebhookVerifierToken;
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing: typeof getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing;
  getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice: typeof getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice;
  recordEvent: typeof recordHelcimWebhookEventWithOrder;
  markEventProcessingStatus?: typeof markHelcimWebhookEventProcessingStatus;
  reconcileProductOrderRefund?: typeof reconcileProductOrderRefund;
  sendBookingConfirmationEmailForOrder: typeof sendBookingConfirmationEmailForOrder;
  sendBookingSchedulingFailureAdminEmail?: (
    input: import("@/lib/booking/email").SendBookingSchedulingFailureAdminEmailInput,
  ) => Promise<void>;
  sendProductOrderConfirmationEmailForOrder: typeof sendProductOrderConfirmationEmailForOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
}

const defaultDependencies: HelcimWebhookDependencies = {
  activateShipmentForPaidOrder,
  finalizeAppointmentPaymentForOrder,
  finalizeProductPayment,
  getAppointmentHoldByCheckoutOrderPublicId: undefined,
  getCardTransaction: async (cardTransactionId, req) => {
    const gateway = await resolveHelcimWebhookGatewayForRequest(req);
    return gateway.getCardTransaction(cardTransactionId);
  },
  getVerifierToken: getHelcimWebhookVerifierToken,
  getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing:
    getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing,
  getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice,
  recordEvent: recordHelcimWebhookEventWithOrder,
  markEventProcessingStatus: markHelcimWebhookEventProcessingStatus,
  reconcileProductOrderRefund,
  sendBookingConfirmationEmailForOrder,
  sendBookingSchedulingFailureAdminEmail,
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
      log("warn", "[helcim-webhook] Missing signature headers");
      return new Response(null, { status: 401 });
    }

    let rawBody: string;
    try {
      rawBody = await readBoundedRequestText(
        req,
        HELCIM_WEBHOOK_MAX_BODY_BYTES,
      );
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return new Response(null, { status: 413 });
      }
      return new Response(null, { status: 400 });
    }
    const isValidSignature = verifyHelcimWebhookSignature(
      headers,
      rawBody,
      dependencies.getVerifierToken(),
    );

    if (!isValidSignature) {
      log("warn", "[helcim-webhook] Invalid signature");
      return new Response(null, { status: 401 });
    }

    let event: ParsedHelcimWebhook;

    try {
      event = parseVerifiedHelcimWebhook(headers, rawBody);
    } catch (error) {
      log("warn", "[helcim-webhook] Invalid payload", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 400 });
    }

    let eventForStorage: ParsedHelcimWebhook;

    try {
      eventForStorage = await reconcileCardTransactionWebhook(
        req,
        event,
        dependencies,
      );
    } catch (error) {
      log("warn", "[helcim-webhook] Transaction detail fetch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 503 });
    }

    let recordedEvent: HelcimWebhookEventRecordResult;

    try {
      recordedEvent = await dependencies.recordEvent(eventForStorage);
    } catch (error) {
      log("warn", "[helcim-webhook] Storage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(null, { status: 503 });
    }

    try {
      await quarantinePaymentEventWhenRequired(
        eventForStorage,
        recordedEvent,
        dependencies,
      );
    } catch (error) {
      log(
        "error",
        "[helcim-webhook] Payment reconciliation quarantine failed",
        {
          error: error instanceof Error ? error.message : String(error),
          eventId: eventForStorage.eventId,
        },
      );
      return new Response(null, { status: 503 });
    }

    try {
      await reconcileRefundWebhook(eventForStorage, dependencies);
    } catch (error) {
      log("error", "[helcim-webhook] Refund reconciliation failed", {
        error:
          error instanceof Error
            ? error.message
            : "Unknown reconciliation error",
        eventId: eventForStorage.eventId,
      });
      return new Response(null, { status: 503 });
    }

    try {
      await finalizeAppointmentWebhookPayment(
        eventForStorage,
        recordedEvent,
        dependencies,
      );
    } catch (error) {
      log("error", "[helcim-webhook] Appointment payment finalization failed", {
        error:
          error instanceof Error ? error.message : "Unknown finalization error",
        eventId: eventForStorage.eventId,
      });
      return new Response(null, { status: 503 });
    }

    try {
      await recoverProductOrderConfirmationEmail(
        eventForStorage,
        recordedEvent,
        dependencies,
      );
    } catch (error) {
      log(
        "error",
        "[helcim-webhook] Product confirmation email recovery failed",
        {
          error:
            error instanceof Error ? error.message : "Unknown recovery error",
          eventId: eventForStorage.eventId,
        },
      );
      return new Response(null, { status: 503 });
    }

    try {
      await recoverTrainingPaymentNotification(
        req,
        eventForStorage,
        dependencies,
      );
    } catch (error) {
      log(
        "error",
        "[helcim-webhook] Training payment notification recovery failed",
        {
          error:
            error instanceof Error ? error.message : "Unknown recovery error",
          eventId: eventForStorage.eventId,
        },
      );
      return new Response(null, { status: 503 });
    }

    return new Response(null, { status: 200 });
  };
}

class RequestBodyTooLargeError extends Error {}

async function readBoundedRequestText(
  req: Request,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

type ParsedHelcimWebhook = ReturnType<typeof parseVerifiedHelcimWebhook>;

async function quarantinePaymentEventWhenRequired(
  event: ParsedHelcimWebhook,
  recorded: HelcimWebhookEventRecordResult,
  dependencies: Pick<HelcimWebhookDependencies, "markEventProcessingStatus">,
): Promise<void> {
  const classification = classifyHelcimTransaction(event);
  const missingProductObligation = Boolean(
    classification.kind === "purchase" &&
    classification.successful &&
    recorded.matchedOrder?.purpose === "product" &&
    !recorded.matchedOrder.paymentObligationId,
  );
  if (
    classification.kind !== "unknown" &&
    !(
      classification.kind === "purchase" &&
      classification.successful &&
      recorded.matchedOrder === null
    ) &&
    !missingProductObligation
  ) {
    return;
  }
  const reasonCode =
    classification.kind === "unknown"
      ? "HELCIM_PAYMENT_CONTRACT_UNKNOWN"
      : missingProductObligation
        ? "HELCIM_PURCHASE_OBLIGATION_AMBIGUOUS"
        : "UNMATCHED_APPROVED_HELCIM_PURCHASE";
  await dependencies.markEventProcessingStatus?.({
    eventId: event.eventId,
    status: "review_required",
    reasonCode,
    message:
      classification.kind === "unknown"
        ? "Helcim transaction type or status is outside the certified contract"
        : missingProductObligation
          ? "Approved product purchase could not be correlated to one obligation"
          : "Approved Helcim purchase could not be matched to a local order",
  });
}

async function reconcileRefundWebhook(
  event: ParsedHelcimWebhook,
  dependencies: Pick<
    HelcimWebhookDependencies,
    "reconcileProductOrderRefund" | "markEventProcessingStatus"
  >,
): Promise<void> {
  const classification = classifyHelcimTransaction(event);
  if (classification.kind !== "refund") return;
  let amountCents: number | null = null;
  try {
    const rawAmount = String(event.amount ?? "").trim();
    amountCents = parseProviderMoneyCents(
      rawAmount.startsWith("-") ? rawAmount.slice(1) : rawAmount,
    );
  } catch {
    amountCents = null;
  }
  if (
    !dependencies.reconcileProductOrderRefund ||
    !event.helcimTransactionId ||
    !event.originalTransactionId ||
    !classification.successful ||
    amountCents === null ||
    amountCents <= 0 ||
    !event.currency?.trim()
  ) {
    await dependencies.markEventProcessingStatus?.({
      eventId: event.eventId,
      status: "review_required",
      message: "Refund provider evidence was incomplete or unsuccessful",
    });
    return;
  }
  const reconciled = await dependencies.reconcileProductOrderRefund({
    originalTransactionId: event.originalTransactionId,
    providerRefundId: event.helcimTransactionId,
    amountCents,
    currency: event.currency,
    ...(event.merchantReference
      ? { providerMerchantReference: event.merchantReference }
      : {}),
  });
  await dependencies.markEventProcessingStatus?.({
    eventId: event.eventId,
    status: reconciled ? "processed" : "review_required",
    ...(!reconciled
      ? {
          message:
            "Refund could not be uniquely correlated to a local ledger row",
        }
      : {}),
  });
}

async function finalizeAppointmentWebhookPayment(
  event: ParsedHelcimWebhook,
  recordedEvent: HelcimWebhookEventRecordResult,
  dependencies: Pick<
    HelcimWebhookDependencies,
    | "finalizeAppointmentPaymentForOrder"
    | "getAppointmentHoldByCheckoutOrderPublicId"
    | "sendBookingConfirmationEmailForOrder"
    | "sendBookingSchedulingFailureAdminEmail"
  >,
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
    log(
      "error",
      "[helcim-webhook] Appointment booking finalization requires follow-up",
      {
        error: result.error,
        orderId: recordedEvent.matchedOrder.orderId,
        status: result.status,
      },
    );

    if (
      isBookingFinalizationStatusAlertable(result.status) &&
      dependencies.sendBookingSchedulingFailureAdminEmail !== undefined
    ) {
      try {
        await dependencies.sendBookingSchedulingFailureAdminEmail({
          amountCents: Math.round(recordedEvent.matchedOrder.amount * 100),
          currency: recordedEvent.matchedOrder.currency,
          currentBookingStatus: result.status,
          failureReason: result.error,
          orderId: recordedEvent.matchedOrder.orderId,
          paymentProvider: "helcim",
          paymentReference: transactionId,
          paymentStatus: event.status ?? "unknown",
        });
      } catch (emailError) {
        log("error", "[helcim-webhook] Admin scheduling failure alert failed", {
          error:
            emailError instanceof Error
              ? emailError.message
              : "Unknown email error",
          orderId: recordedEvent.matchedOrder.orderId,
        });
      }
    }
  }

  if (result.ok) {
    await dependencies.sendBookingConfirmationEmailForOrder(
      recordedEvent.matchedOrder.orderId,
    );
  }
}

async function recoverProductOrderConfirmationEmail(
  event: ParsedHelcimWebhook,
  recordedEvent: HelcimWebhookEventRecordResult,
  dependencies: Pick<
    HelcimWebhookDependencies,
    | "activateShipmentForPaidOrder"
    | "sendProductOrderConfirmationEmailForOrder"
    | "finalizeProductPayment"
    | "markEventProcessingStatus"
  >,
): Promise<void> {
  if (
    recordedEvent.matchedOrder === null ||
    recordedEvent.matchedOrder.paymentProvider !== "helcim" ||
    recordedEvent.matchedOrder.purpose !== "product" ||
    !isApprovedWebhookPayment(event)
  ) {
    return;
  }

  if (!dependencies.finalizeProductPayment) {
    await dependencies.markEventProcessingStatus?.({
      eventId: event.eventId,
      status: "retryable_failed",
      message: "Product payment finalizer was unavailable",
    });
    throw new Error("Product payment finalizer was unavailable");
  }

  try {
    const finalization = await dependencies.finalizeProductPayment({
      orderReference: recordedEvent.matchedOrder.orderId,
      obligationId: recordedEvent.matchedOrder.paymentObligationId,
      transactionId: event.helcimTransactionId!,
      source: "helcim_api",
      certifiedEvidence: {
        avsCode: event.avsCode,
        cvvCode: event.cvvCode,
      },
      data: {
        amount: event.amount ?? null,
        currency: event.currency ?? null,
        status: event.status ?? null,
        transactionType: event.transactionType ?? null,
        originalTransactionId: event.originalTransactionId ?? null,
        transactionId: event.helcimTransactionId ?? null,
        avsResponse: event.avsCode ?? null,
        cvvResponse: event.cvvCode ?? null,
      },
    });
    if (!["applied", "already_applied"].includes(finalization.transition)) {
      await dependencies.markEventProcessingStatus?.({
        eventId: event.eventId,
        status: "review_required",
        reasonCode: "PRODUCT_PAYMENT_FINALIZATION_CONFLICT",
        message: `Product payment finalization returned ${finalization.transition}`,
      });
      return;
    }
    await dependencies.sendProductOrderConfirmationEmailForOrder(
      recordedEvent.matchedOrder.orderId,
    );
    await dependencies.markEventProcessingStatus?.({
      eventId: event.eventId,
      status: "processed",
    });
  } catch (error) {
    await dependencies.markEventProcessingStatus?.({
      eventId: event.eventId,
      status: "retryable_failed",
      message:
        error instanceof Error
          ? error.message
          : "Product payment finalization failed",
    });
    throw error;
  }
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

  const enrollment =
    await dependencies.getPaidPendingTrainingEnrollmentNotificationByHelcimInvoiceIfMissing(
      {
        helcimInvoiceId: event.helcimInvoiceId,
        helcimInvoiceNumber: event.helcimInvoiceNumber,
      },
    );

  if (!enrollment) {
    return;
  }

  const schedulingToken =
    await dependencies.getOrIssueTrainingSchedulingTokenForPaidHelcimInvoice({
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
  if (
    event.eventType !== "cardTransaction" ||
    event.helcimTransactionId === undefined
  ) {
    return false;
  }

  const classification = classifyHelcimTransaction(event);
  return classification.kind === "purchase" && classification.successful;
}

function buildAbsoluteSchedulingUrl(
  origin: string,
  programSlug: string,
  schedulingToken: string,
): string {
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
  if (
    event.eventType !== "cardTransaction" ||
    event.helcimTransactionId === undefined
  ) {
    return event;
  }

  try {
    const details = await dependencies.getCardTransaction(
      event.helcimTransactionId,
      req,
    );
    return mergeHelcimCardTransactionDetails(event, details);
  } catch (cause) {
    throw new HelcimWebhookReconciliationError(cause);
  }
}

export async function resolveHelcimWebhookGatewayForRequest(
  req: Request,
): Promise<HelcimGateway> {
  const [env, runtimeControls] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("@/lib/payment-mocks/runtime-controls"),
  ]);
  const runtimeEnvironment = env.getPaymentMockRuntimeEnvironment();

  runtimeControls.assertPaymentMockAllowed({
    env: runtimeEnvironment,
    request: req,
  });

  if (
    runtimeControls.resolvePaymentGatewayMode(runtimeEnvironment) !== "mock"
  ) {
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
