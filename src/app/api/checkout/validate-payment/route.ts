import { NextResponse, type NextRequest } from "next/server";
import {
  getPendingOrderByCheckoutToken,
  markOrderPaid,
  markOrderVerificationFailed,
} from "@/lib/commerce/order-store";
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

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body: unknown = await req.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { checkoutToken, data, hash } = body;

    const order = await getPendingOrderByCheckoutToken(checkoutToken);

    if (!order) {
      return NextResponse.json(
        { error: "Checkout session not found" },
        { status: 404 }
      );
    }

    const payment = verifyHelcimPayment({
      data,
      hash,
      order,
      secretToken: order.secretToken,
    });

    if (!payment.ok) {
      await markOrderVerificationFailed(order.orderId);
      return NextResponse.json(
        { error: "Payment could not be verified" },
        { status: 400 }
      );
    }

    const persisted = await persistVerifiedPayment({
      markPaid: markOrderPaid,
      orderId: order.orderId,
      transactionId: payment.transactionId,
    });

    if (!persisted) {
      return NextResponse.json(
        { error: "Payment verified but order could not be recorded" },
        { status: 500 }
      );
    }

    const trainingSchedulingToken = await issueTrainingSchedulingTokenForPaidOrder(order.orderId);

    if (trainingSchedulingToken) {
      const programSlug = trainingSchedulingToken.programSnapshot.slug;

      if (!programSlug) {
        return NextResponse.json(
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
        await sendTrainingPaymentNotificationEmails({
          customerEmail: trainingSchedulingToken.checkoutOrder.customerEmail,
          customerName: trainingSchedulingToken.checkoutOrder.customerName,
          orderId: order.orderId,
          programTitle: trainingSchedulingToken.programSnapshot.title,
          schedulingUrl: buildAbsoluteSchedulingUrl(
            req.nextUrl.origin,
            trainingSchedulingToken.schedulingToken,
          ),
        });
        await markTrainingEnrollmentStaffAlerted({
          enrollmentId: trainingSchedulingToken.enrollmentId,
        });
      } catch (error) {
        console.error("[checkout] Training payment notification email failed", {
          error: error instanceof Error ? error.message : "Unknown email error",
          orderId: order.orderId,
        });
      }

      return NextResponse.json({
        orderId: order.orderId,
        redirectUrl,
      });
    }

    return NextResponse.json({
      orderId: order.orderId,
      redirectUrl: `/products/confirmation?order=${encodeURIComponent(order.orderId)}`,
    });
  } catch (error) {
    console.error("[checkout] Payment validation failed", {
      error: error instanceof Error ? error.message : "Unknown validation error",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function buildAbsoluteSchedulingUrl(origin: string, schedulingToken: string): string {
  const url = new URL("/booking", origin);
  url.searchParams.set("type", "training-call");
  url.searchParams.set("token", schedulingToken);
  return url.toString();
}
