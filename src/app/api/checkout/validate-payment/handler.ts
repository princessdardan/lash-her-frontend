import type { NextRequest } from "next/server";
import {
  finalizeAppointmentPaymentForOrder,
  isAppointmentCheckoutPurpose,
} from "@/lib/booking/finalizer";
import { sendBookingConfirmationEmailForOrder } from "@/lib/booking/email";
import { getAppointmentHoldByCheckoutOrderPublicId } from "@/lib/booking/holds";
import { isSafeServiceConfirmationSlug } from "@/lib/booking-confirmation";
import {
  getPendingOrderByCheckoutToken,
  markOrderPaid,
  markOrderVerificationFailed,
} from "@/lib/commerce/order-store";
import { sendProductOrderConfirmationEmailForOrder } from "@/lib/commerce/product-order-email";
import { sendTrainingPaymentNotificationEmailsIfNeeded } from "@/lib/commerce/training-payment-notifications";
import {
  getOrIssueTrainingSchedulingTokenForPaidOrder,
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
} from "@/lib/commerce/training-enrollment-store";
import {
  persistVerifiedPayment,
  verifyHelcimPayment,
} from "@/lib/commerce/verified-payment";
import type { VerifiablePendingOrder } from "@/lib/commerce/verified-payment";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";
import type { HelcimCardTransactionResponse } from "@/lib/commerce/helcim-types";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import { normalizeHelcimCardTransactionDetails } from "@/lib/commerce/helcim-webhook";
import {
  buildServiceBookingConfirmationResolverUrl,
  buildServiceBookingConfirmationUrl,
  buildTrainingScheduleUrl,
} from "@/lib/training-checkout";
import { activateShipmentForPaidOrder } from "@/lib/shipping/shipment-store";
import { classifyProductOrderPaymentRisk } from "@/lib/shipping/fraud";
import { finalizeProductPayment } from "@/lib/commerce/product-payment-finalizer";
import { isPaymentMockMode } from "@/lib/env/private-checkout";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";

const VALIDATE_PAYMENT_BODY_MAX_BYTES = 32 * 1024;

interface ValidatePaymentBody {
  checkoutToken: string;
  data: Record<string, HelcimPayloadValue>;
  hash: string;
}

type ValidatePaymentRequest = Request & {
  nextUrl?: {
    origin: string;
  };
};

interface ValidatePaymentPostHandlerDependencies {
  allowProductCallbackFallback?: boolean;
  activateShipmentForPaidOrder?: typeof activateShipmentForPaidOrder;
  finalizeAppointmentPaymentForOrder: typeof finalizeAppointmentPaymentForOrder;
  finalizeProductPayment?: typeof finalizeProductPayment;
  getAppointmentHoldByCheckoutOrderPublicId: typeof getAppointmentHoldByCheckoutOrderPublicId;
  getOrIssueTrainingSchedulingTokenForPaidOrder: typeof getOrIssueTrainingSchedulingTokenForPaidOrder;
  getPendingOrderByCheckoutToken: typeof getPendingOrderByCheckoutToken;
  getProductCardTransaction?: (
    transactionId: string,
  ) => Promise<HelcimCardTransactionResponse | null>;
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: typeof getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId;
  logError: typeof console.error;
  markOrderPaid: typeof markOrderPaid;
  markOrderVerificationFailed: typeof markOrderVerificationFailed;
  persistVerifiedPayment: typeof persistVerifiedPayment;
  sendBookingConfirmationEmailForOrder: typeof sendBookingConfirmationEmailForOrder;
  sendProductOrderConfirmationEmailForOrder: typeof sendProductOrderConfirmationEmailForOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
  verifyHelcimPayment: typeof verifyHelcimPayment;
  classifyProductOrderPaymentRisk?: typeof classifyProductOrderPaymentRisk;
}

function isValidBody(body: unknown): body is ValidatePaymentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.checkoutToken !== "string") return false;
  if (typeof b.hash !== "string") return false;
  if (!b.data || typeof b.data !== "object") return false;

  for (const value of Object.values(b.data)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

export function createValidatePaymentPostHandler(
  dependencies: ValidatePaymentPostHandlerDependencies,
): (req: ValidatePaymentRequest) => Promise<Response> {
  return async function validatePaymentPostHandler(
    req: ValidatePaymentRequest,
  ): Promise<Response> {
    try {
      const parsedBody = await readBoundedJsonBody(
        req,
        VALIDATE_PAYMENT_BODY_MAX_BYTES,
      );
      if (!parsedBody.ok) {
        return Response.json(
          {
            error:
              parsedBody.reason === "too_large"
                ? "Request body is too large"
                : "Invalid request body",
          },
          { status: parsedBody.reason === "too_large" ? 413 : 400 },
        );
      }
      const body: unknown = parsedBody.value;

      if (!isValidBody(body)) {
        return Response.json(
          { error: "Invalid request body" },
          { status: 400 },
        );
      }

      const { checkoutToken, data, hash } = body;

      const order =
        await dependencies.getPendingOrderByCheckoutToken(checkoutToken);

      if (!order) {
        return Response.json(
          { error: "Checkout session not found" },
          { status: 404 },
        );
      }

      if (!hasHelcimInvoiceIdentifiers(order)) {
        return Response.json(
          { error: "Payment could not be verified" },
          { status: 400 },
        );
      }

      const payment = dependencies.verifyHelcimPayment({
        data,
        hash,
        order,
        secretToken: order.secretToken,
      });

      if (!payment.ok) {
        const authenticatedUnknownTransactionId =
          order.purpose === "product" &&
          payment.reason !== "invalid_hash" &&
          ["unknown_transaction_type", "unapproved_payment"].includes(
            payment.reason,
          )
            ? paymentPayloadText(data.transactionId ?? data.id)
            : null;
        if (
          authenticatedUnknownTransactionId &&
          dependencies.finalizeProductPayment
        ) {
          await finalizeProductPaymentFromAuthoritativeEvidence({
            dependencies,
            orderReference: order.orderId,
            obligationId: order.paymentObligationId,
            transactionId: authenticatedUnknownTransactionId,
            callbackData: data,
          });
          return Response.json(
            {
              orderId: order.orderId,
              paymentStatus: "review_required",
              error:
                "Payment status was received and requires provider review.",
            },
            { status: 202 },
          );
        }
        return Response.json(
          { error: "Payment could not be verified" },
          { status: 400 },
        );
      }

      const productFinalization =
        order.purpose === "product" && dependencies.finalizeProductPayment
          ? await finalizeProductPaymentFromAuthoritativeEvidence({
              dependencies,
              orderReference: order.orderId,
              obligationId: order.paymentObligationId,
              transactionId: payment.transactionId,
              callbackData: data,
              authenticatedCallbackIdentity: {
                orderReference: order.orderId,
                obligationId: order.paymentObligationId,
                transactionId: payment.transactionId,
              },
            })
          : null;
      if (
        productFinalization &&
        ["outcome_unknown", "state_conflict", "transaction_conflict"].includes(
          productFinalization.transition,
        )
      ) {
        return Response.json(
          {
            orderId: order.orderId,
            paymentStatus: "review_required",
            error:
              "Payment received; fulfillment confirmation is under review.",
          },
          { status: 202 },
        );
      }
      if (productFinalization?.transition === "not_found") {
        return Response.json(
          {
            paymentStatus: "review_required",
            error: "Payment requires manual reconciliation.",
          },
          { status: 409 },
        );
      }
      const persisted = productFinalization
        ? ["applied", "already_applied"].includes(
            productFinalization.transition,
          )
        : await dependencies.persistVerifiedPayment({
            markPaid: async (orderId, transactionId) => {
              const transition = await dependencies.markOrderPaid(
                orderId,
                transactionId,
              );
              if (
                transition !== "applied" &&
                transition !== "already_applied"
              ) {
                throw new Error(
                  `Payment transition requires review: ${transition}`,
                );
              }
            },
            orderId: order.orderId,
            transactionId: payment.transactionId,
          });

      if (!persisted) {
        return Response.json(
          { error: "Payment verified but order could not be recorded" },
          { status: 500 },
        );
      }

      if (order.purpose === "product" && !productFinalization)
        await dependencies.classifyProductOrderPaymentRisk?.(
          order.orderId,
          data,
        );

      if (isAppointmentCheckoutPurpose(order.purpose)) {
        const booking = await dependencies.finalizeAppointmentPaymentForOrder({
          order,
          source: "client_validation",
          transactionId: payment.transactionId,
        });
        const redirectUrl = await getAppointmentBookingConfirmationRedirectUrl({
          getAppointmentHoldByCheckoutOrderPublicId:
            dependencies.getAppointmentHoldByCheckoutOrderPublicId,
          orderId: order.orderId,
        });

        if (booking.ok) {
          try {
            await dependencies.sendBookingConfirmationEmailForOrder(
              order.orderId,
            );
          } catch (error) {
            dependencies.logError(
              "[checkout] Booking confirmation email failed",
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown email error",
                orderId: order.orderId,
              },
            );
          }

          return Response.json({
            bookingStatus: booking.status,
            eventId: booking.eventId,
            orderId: order.orderId,
            redirectUrl,
          });
        }

        dependencies.logError(
          "[checkout] Appointment booking finalization failed",
          {
            error: booking.error,
            orderId: order.orderId,
            status: booking.status,
          },
        );

        if (booking.status === "finalization_pending") {
          return Response.json(
            {
              bookingStatus: booking.status,
              error:
                "Payment received; booking confirmation is still in progress",
              orderId: order.orderId,
            },
            { status: 409 },
          );
        }

        return Response.json(
          {
            bookingStatus: booking.status,
            error: "Payment received; booking requires manual follow-up",
            orderId: order.orderId,
            redirectUrl,
          },
          { status: 202 },
        );
      }

      const trainingEnrollment =
        await dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(
          order.orderId,
        );

      if (trainingEnrollment) {
        const programSlug = trainingEnrollment.programSnapshot.slug;

        if (!programSlug) {
          return Response.json(
            {
              error:
                "Payment verified but training confirmation could not be prepared",
            },
            { status: 500 },
          );
        }

        const safeProgramSlug: string = programSlug;
        const schedulingToken =
          await dependencies.getOrIssueTrainingSchedulingTokenForPaidOrder(
            order.orderId,
          );

        if (!schedulingToken) {
          return Response.json(
            {
              error:
                "Payment verified but training scheduling could not be prepared",
            },
            { status: 500 },
          );
        }

        const redirectUrl = buildTrainingScheduleUrl({
          programSlug: safeProgramSlug,
          schedulingToken: schedulingToken.schedulingToken,
        });

        if (
          trainingEnrollment.studentPaymentEmailSentAt === null ||
          trainingEnrollment.staffAlertedAt === null
        ) {
          try {
            await dependencies.sendTrainingPaymentNotificationEmailsIfNeeded({
              enrollment: trainingEnrollment,
              paymentProvider: "helcim",
              schedulingUrl: buildAbsoluteSchedulingUrl(
                getRequestOrigin(req),
                safeProgramSlug,
                schedulingToken.schedulingToken,
              ),
            });
          } catch (error) {
            dependencies.logError(
              "[checkout] Training payment notification email failed",
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown email error",
                orderId: order.orderId,
              },
            );
          }
        }

        return Response.json({
          orderId: order.orderId,
          redirectUrl,
        });
      }

      try {
        await dependencies.sendProductOrderConfirmationEmailForOrder(
          order.orderId,
        );
      } catch (error) {
        dependencies.logError(
          "[checkout] Product order confirmation email failed",
          {
            error:
              error instanceof Error ? error.message : "Unknown email error",
            orderId: order.orderId,
          },
        );
      }

      if (productFinalization && productFinalization.riskStatus !== "cleared") {
        return Response.json(
          {
            message:
              "Payment received; fulfillment confirmation is under review.",
            orderId: order.orderId,
            redirectUrl: `/products/confirmation?order=${encodeURIComponent(order.orderId)}`,
          },
          { status: 202 },
        );
      }

      return Response.json({
        orderId: order.orderId,
        redirectUrl: `/products/confirmation?order=${encodeURIComponent(order.orderId)}`,
      });
    } catch (error) {
      dependencies.logError("[checkout] Payment validation failed", {
        error:
          error instanceof Error ? error.message : "Unknown validation error",
      });
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

function paymentPayloadText(
  value: HelcimPayloadValue | undefined,
): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const paymentMockMode = isPaymentMockMode();
  return createValidatePaymentPostHandler({
    allowProductCallbackFallback: paymentMockMode,
    activateShipmentForPaidOrder,
    classifyProductOrderPaymentRisk,
    finalizeProductPayment,
    finalizeAppointmentPaymentForOrder,
    getOrIssueTrainingSchedulingTokenForPaidOrder,
    getAppointmentHoldByCheckoutOrderPublicId,
    getPendingOrderByCheckoutToken,
    getProductCardTransaction: paymentMockMode
      ? undefined
      : getHelcimCardTransaction,
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
    logError: console.error,
    markOrderPaid,
    markOrderVerificationFailed,
    persistVerifiedPayment,
    sendBookingConfirmationEmailForOrder,
    sendProductOrderConfirmationEmailForOrder,
    sendTrainingPaymentNotificationEmailsIfNeeded,
    verifyHelcimPayment,
  })(req);
}

async function finalizeProductPaymentFromAuthoritativeEvidence(input: {
  dependencies: ValidatePaymentPostHandlerDependencies;
  orderReference: string;
  obligationId?: string;
  transactionId: string;
  callbackData: Record<string, HelcimPayloadValue>;
  authenticatedCallbackIdentity?: {
    orderReference: string;
    obligationId?: string;
    transactionId: string;
  };
}) {
  const { dependencies } = input;
  const finalize = dependencies.finalizeProductPayment;
  if (!finalize) return null;

  if (dependencies.allowProductCallbackFallback) {
    return finalize({
      orderReference: input.orderReference,
      obligationId: input.obligationId,
      transactionId: input.transactionId,
      source: "client_callback",
      data: input.callbackData,
    });
  }

  if (!dependencies.getProductCardTransaction) {
    return finalize({
      orderReference: input.orderReference,
      obligationId: input.obligationId,
      transactionId: input.transactionId,
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "unavailable",
      authenticatedCallbackIdentity: input.authenticatedCallbackIdentity,
    });
  }

  let authoritative: HelcimCardTransactionResponse | null;
  try {
    authoritative = await dependencies.getProductCardTransaction(
      input.transactionId,
    );
  } catch (error) {
    dependencies.logError(
      "[checkout] Authoritative product payment lookup failed",
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown Helcim lookup error",
        orderId: input.orderReference,
        transactionId: input.transactionId,
      },
    );
    return finalize({
      orderReference: input.orderReference,
      obligationId: input.obligationId,
      transactionId: input.transactionId,
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "request_failed",
      authenticatedCallbackIdentity: input.authenticatedCallbackIdentity,
    });
  }

  if (!authoritative) {
    return finalize({
      orderReference: input.orderReference,
      obligationId: input.obligationId,
      transactionId: input.transactionId,
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "not_found",
      authenticatedCallbackIdentity: input.authenticatedCallbackIdentity,
    });
  }

  const normalized = normalizeHelcimCardTransactionDetails(authoritative);
  if (!authoritativeTransactionResponseIsWellFormed(normalized)) {
    return finalize({
      orderReference: input.orderReference,
      obligationId: input.obligationId,
      transactionId: input.transactionId,
      source: "helcim_api",
      data: {},
      authoritativeLookupFailure: "malformed_response",
      authenticatedCallbackIdentity: input.authenticatedCallbackIdentity,
    });
  }

  return finalize({
    orderReference: input.orderReference,
    obligationId: input.obligationId,
    transactionId: input.transactionId,
    source: "helcim_api",
    data: Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined),
    ) as Record<string, HelcimPayloadValue>,
    certifiedEvidence: {
      avsCode: normalized.avsCode,
      cvvCode: normalized.cvvCode,
    },
  });
}

function authoritativeTransactionResponseIsWellFormed(
  details: ReturnType<typeof normalizeHelcimCardTransactionDetails>,
): boolean {
  return Boolean(
    details.transactionId?.trim() &&
    details.transactionType?.trim() &&
    details.status?.trim() &&
    (typeof details.amount === "string" ||
      typeof details.amount === "number") &&
    details.currency?.trim(),
  );
}

async function getAppointmentBookingConfirmationRedirectUrl(input: {
  getAppointmentHoldByCheckoutOrderPublicId: typeof getAppointmentHoldByCheckoutOrderPublicId;
  orderId: string;
}): Promise<string> {
  const appointmentHold = await input.getAppointmentHoldByCheckoutOrderPublicId(
    input.orderId,
  );
  const serviceSlug = appointmentHold?.offeringSnapshot.slug;

  if (
    typeof serviceSlug === "string" &&
    isSafeServiceConfirmationSlug(serviceSlug)
  ) {
    return buildServiceBookingConfirmationUrl({
      orderId: input.orderId,
      serviceSlug,
    });
  }

  return buildServiceBookingConfirmationResolverUrl({
    orderId: input.orderId,
  });
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

function hasHelcimInvoiceIdentifiers<
  T extends {
    helcimInvoiceId: number | null;
    helcimInvoiceNumber: string | null;
    paymentProvider?: string;
  },
>(order: T): order is T & VerifiablePendingOrder {
  return (
    order.paymentProvider === "helcim" &&
    order.helcimInvoiceId !== null &&
    order.helcimInvoiceNumber !== null
  );
}

function getRequestOrigin(req: ValidatePaymentRequest): string {
  return req.nextUrl?.origin ?? new URL(req.url).origin;
}
