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
import { persistVerifiedPayment, verifyHelcimPayment } from "@/lib/commerce/verified-payment";
import type { VerifiablePendingOrder } from "@/lib/commerce/verified-payment";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";
import {
  buildServiceBookingConfirmationResolverUrl,
  buildServiceBookingConfirmationUrl,
  buildTrainingScheduleUrl,
} from "@/lib/training-checkout";

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
  finalizeAppointmentPaymentForOrder: typeof finalizeAppointmentPaymentForOrder;
  getAppointmentHoldByCheckoutOrderPublicId: typeof getAppointmentHoldByCheckoutOrderPublicId;
  getOrIssueTrainingSchedulingTokenForPaidOrder: typeof getOrIssueTrainingSchedulingTokenForPaidOrder;
  getPendingOrderByCheckoutToken: typeof getPendingOrderByCheckoutToken;
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: typeof getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId;
  logError: typeof console.error;
  markOrderPaid: typeof markOrderPaid;
  markOrderVerificationFailed: typeof markOrderVerificationFailed;
  persistVerifiedPayment: typeof persistVerifiedPayment;
  sendBookingConfirmationEmailForOrder: typeof sendBookingConfirmationEmailForOrder;
  sendProductOrderConfirmationEmailForOrder: typeof sendProductOrderConfirmationEmailForOrder;
  sendTrainingPaymentNotificationEmailsIfNeeded: typeof sendTrainingPaymentNotificationEmailsIfNeeded;
  verifyHelcimPayment: typeof verifyHelcimPayment;
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
  return async function validatePaymentPostHandler(req: ValidatePaymentRequest): Promise<Response> {
    try {
      const body: unknown = await req.json();

      if (!isValidBody(body)) {
        return Response.json(
          { error: "Invalid request body" },
          { status: 400 }
        );
      }

      const { checkoutToken, data, hash } = body;

      const order = await dependencies.getPendingOrderByCheckoutToken(checkoutToken);

      if (!order) {
        return Response.json(
          { error: "Checkout session not found" },
          { status: 404 }
        );
      }

      if (!hasHelcimInvoiceIdentifiers(order)) {
        return Response.json(
          { error: "Payment could not be verified" },
          { status: 400 }
        );
      }

      const payment = dependencies.verifyHelcimPayment({
        data,
        hash,
        order,
        secretToken: order.secretToken,
      });

      if (!payment.ok) {
        await dependencies.markOrderVerificationFailed(order.orderId);
        return Response.json(
          { error: "Payment could not be verified" },
          { status: 400 }
        );
      }

      const persisted = await dependencies.persistVerifiedPayment({
        markPaid: dependencies.markOrderPaid,
        orderId: order.orderId,
        transactionId: payment.transactionId,
      });

      if (!persisted) {
        return Response.json(
          { error: "Payment verified but order could not be recorded" },
          { status: 500 }
        );
      }

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
            await dependencies.sendBookingConfirmationEmailForOrder(order.orderId);
          } catch (error) {
            dependencies.logError("[checkout] Booking confirmation email failed", {
              error: error instanceof Error ? error.message : "Unknown email error",
              orderId: order.orderId,
            });
          }

          return Response.json({
            bookingStatus: booking.status,
            eventId: booking.eventId,
            orderId: order.orderId,
            redirectUrl,
          });
        }

        dependencies.logError("[checkout] Appointment booking finalization failed", {
          error: booking.error,
          orderId: order.orderId,
          status: booking.status,
        });

        if (booking.status === "finalization_pending") {
          return Response.json(
            {
              bookingStatus: booking.status,
              error: "Payment received; booking confirmation is still in progress",
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

      const trainingEnrollment = await dependencies.getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(order.orderId);

      if (trainingEnrollment) {
        const programSlug = trainingEnrollment.programSnapshot.slug;

        if (!programSlug) {
          return Response.json(
            { error: "Payment verified but training confirmation could not be prepared" },
            { status: 500 },
          );
        }

        const safeProgramSlug: string = programSlug;
        const schedulingToken = await dependencies.getOrIssueTrainingSchedulingTokenForPaidOrder(order.orderId);

        if (!schedulingToken) {
          return Response.json(
            { error: "Payment verified but training scheduling could not be prepared" },
            { status: 500 },
          );
        }

        const redirectUrl = buildTrainingScheduleUrl({
          programSlug: safeProgramSlug,
          schedulingToken: schedulingToken.schedulingToken,
        });

        if (trainingEnrollment.studentPaymentEmailSentAt === null || trainingEnrollment.staffAlertedAt === null) {
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
            dependencies.logError("[checkout] Training payment notification email failed", {
              error: error instanceof Error ? error.message : "Unknown email error",
              orderId: order.orderId,
            });
          }
        }

        return Response.json({
          orderId: order.orderId,
          redirectUrl,
        });
      }

      try {
        await dependencies.sendProductOrderConfirmationEmailForOrder(order.orderId);
      } catch (error) {
        dependencies.logError("[checkout] Product order confirmation email failed", {
          error: error instanceof Error ? error.message : "Unknown email error",
          orderId: order.orderId,
        });
      }

      return Response.json({
        orderId: order.orderId,
        redirectUrl: `/products/confirmation?order=${encodeURIComponent(order.orderId)}`,
      });
    } catch (error) {
      dependencies.logError("[checkout] Payment validation failed", {
        error: error instanceof Error ? error.message : "Unknown validation error",
      });
      return Response.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  return createValidatePaymentPostHandler({
    finalizeAppointmentPaymentForOrder,
    getOrIssueTrainingSchedulingTokenForPaidOrder,
    getAppointmentHoldByCheckoutOrderPublicId,
    getPendingOrderByCheckoutToken,
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

async function getAppointmentBookingConfirmationRedirectUrl(input: {
  getAppointmentHoldByCheckoutOrderPublicId: typeof getAppointmentHoldByCheckoutOrderPublicId;
  orderId: string;
}): Promise<string> {
  const appointmentHold = await input.getAppointmentHoldByCheckoutOrderPublicId(input.orderId);
  const serviceSlug = appointmentHold?.offeringSnapshot.slug;

  if (typeof serviceSlug === "string" && isSafeServiceConfirmationSlug(serviceSlug)) {
    return buildServiceBookingConfirmationUrl({
      orderId: input.orderId,
      serviceSlug,
    });
  }

  return buildServiceBookingConfirmationResolverUrl({
    orderId: input.orderId,
  });
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

function hasHelcimInvoiceIdentifiers<T extends {
  helcimInvoiceId: number | null;
  helcimInvoiceNumber: string | null;
  paymentProvider?: string;
}>(order: T): order is T & VerifiablePendingOrder {
  return (
    order.paymentProvider === "helcim" &&
    order.helcimInvoiceId !== null &&
    order.helcimInvoiceNumber !== null
  );
}

function getRequestOrigin(req: ValidatePaymentRequest): string {
  return req.nextUrl?.origin ?? new URL(req.url).origin;
}
