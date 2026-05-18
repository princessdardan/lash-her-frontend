import type { NextRequest } from "next/server";
import {
  getPendingOrderByCheckoutToken,
  markOrderPaid,
  markOrderVerificationFailed,
} from "@/lib/commerce/order-store";
import { sendProductOrderConfirmationEmail } from "@/lib/commerce/product-order-email";
import { sendTrainingPaymentNotificationEmails } from "@/lib/commerce/training-payment-email";
import {
  issueTrainingSchedulingTokenForPaidOrder,
  markTrainingEnrollmentStaffAlerted,
} from "@/lib/commerce/training-enrollment-store";
import { persistVerifiedPayment, verifyHelcimPayment } from "@/lib/commerce/verified-payment";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";
import { buildTrainingConfirmationUrl } from "@/lib/training-checkout";

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
  getPendingOrderByCheckoutToken: typeof getPendingOrderByCheckoutToken;
  issueTrainingSchedulingTokenForPaidOrder: typeof issueTrainingSchedulingTokenForPaidOrder;
  logError: typeof console.error;
  markOrderPaid: typeof markOrderPaid;
  markOrderVerificationFailed: typeof markOrderVerificationFailed;
  markTrainingEnrollmentStaffAlerted: typeof markTrainingEnrollmentStaffAlerted;
  persistVerifiedPayment: typeof persistVerifiedPayment;
  sendProductOrderConfirmationEmail: typeof sendProductOrderConfirmationEmail;
  sendTrainingPaymentNotificationEmails: typeof sendTrainingPaymentNotificationEmails;
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

      const trainingSchedulingToken = await dependencies.issueTrainingSchedulingTokenForPaidOrder(order.orderId);

      if (trainingSchedulingToken) {
        const programSlug = trainingSchedulingToken.programSnapshot.slug;

        if (!programSlug) {
          return Response.json(
            { error: "Payment verified but training confirmation could not be prepared" },
            { status: 500 },
          );
        }

        const redirectUrl = buildTrainingConfirmationUrl({
          orderId: order.orderId,
          programSlug,
          schedulingToken: trainingSchedulingToken.schedulingToken,
        });

        try {
          await dependencies.sendTrainingPaymentNotificationEmails({
            customerEmail: trainingSchedulingToken.checkoutOrder.customerEmail,
            customerName: trainingSchedulingToken.checkoutOrder.customerName,
            orderId: order.orderId,
            programTitle: trainingSchedulingToken.programSnapshot.title,
            schedulingUrl: buildAbsoluteSchedulingUrl(
              getRequestOrigin(req),
              trainingSchedulingToken.schedulingToken,
            ),
          });
          await dependencies.markTrainingEnrollmentStaffAlerted({
            enrollmentId: trainingSchedulingToken.enrollmentId,
          });
        } catch (error) {
          dependencies.logError("[checkout] Training payment notification email failed", {
            error: error instanceof Error ? error.message : "Unknown email error",
            orderId: order.orderId,
          });
        }

        return Response.json({
          orderId: order.orderId,
          redirectUrl,
        });
      }

      try {
        await dependencies.sendProductOrderConfirmationEmail({
          currency: order.currency,
          customerEmail: order.customerEmail,
          customerName: order.customerName,
          lineItems: order.lineItems,
          orderId: order.orderId,
          totalAmount: order.amount,
        });
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
    getPendingOrderByCheckoutToken,
    issueTrainingSchedulingTokenForPaidOrder,
    logError: console.error,
    markOrderPaid,
    markOrderVerificationFailed,
    markTrainingEnrollmentStaffAlerted,
    persistVerifiedPayment,
    sendProductOrderConfirmationEmail,
    sendTrainingPaymentNotificationEmails,
    verifyHelcimPayment,
  })(req);
}

function buildAbsoluteSchedulingUrl(origin: string, schedulingToken: string): string {
  const url = new URL("/booking", origin);
  url.searchParams.set("type", "training-call");
  url.searchParams.set("token", schedulingToken);
  return url.toString();
}

function getRequestOrigin(req: ValidatePaymentRequest): string {
  return req.nextUrl?.origin ?? new URL(req.url).origin;
}
