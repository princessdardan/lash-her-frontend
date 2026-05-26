import { NextResponse, type NextRequest } from "next/server";

import { isActiveHold, type BookingHoldRecord } from "@/lib/booking/holds";
import { getBookingPaymentSelection } from "@/lib/booking/payment-policy";
import type { SquareServiceCheckoutResult } from "@/lib/booking/square-service-checkout";

interface BookingCheckoutRequestBody {
  holdReference: string;
}

interface BookingCheckoutPostHandlerDependencies {
  createSquareServiceBookingCheckout: (input: {
    hold: BookingHoldRecord;
    now?: Date;
    request?: NextRequest;
  }) => Promise<SquareServiceCheckoutResult>;
  getAppointmentHoldByPublicReference: (publicReference: string) => Promise<BookingHoldRecord | null>;
  releaseHeldAppointmentHold: (input: { holdId: string; now: Date }) => Promise<BookingHoldRecord | null>;
}

interface BookingCheckoutResponseBody {
  checkoutUrl: string;
  holdReference: string;
  orderId: string;
  paymentProvider: "square";
  reused: boolean;
  squareOrderId?: string;
  squarePaymentLinkId: string;
}

export function createBookingCheckoutPostHandler(
  dependencies: BookingCheckoutPostHandlerDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function bookingCheckoutPostHandler(req: NextRequest): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidBookingCheckoutRequest();
    }

    const checkoutRequest = parseBookingCheckoutRequest(body);

    if (checkoutRequest === null) {
      return invalidBookingCheckoutRequest();
    }

    const now = new Date();
    let hold: BookingHoldRecord | null = null;

    try {
      hold = await dependencies.getAppointmentHoldByPublicReference(
        checkoutRequest.holdReference,
      );

      if (hold === null || !isCheckoutStartableHold(hold, now)) {
        return unavailableBookingHoldResponse();
      }

      if (getBookingPaymentSelection(hold) === null) {
        await releaseHoldAfterCheckoutFailure({ dependencies, hold, now, reason: "Booking payment is not configured" });

        return NextResponse.json(
          { error: "Booking payment is not configured" },
          { status: 400 },
        );
      }

      const checkout = await dependencies.createSquareServiceBookingCheckout({ hold, now, request: req });

      return NextResponse.json<BookingCheckoutResponseBody>({
        checkoutUrl: checkout.checkoutUrl,
        holdReference: checkout.holdReference,
        orderId: checkout.orderId,
        paymentProvider: "square",
        reused: checkout.reused,
        ...(checkout.squareOrderId ? { squareOrderId: checkout.squareOrderId } : {}),
        squarePaymentLinkId: checkout.squarePaymentLinkId,
      });
    } catch (error) {
      if (isUnavailableBookingHoldError(error)) {
        return unavailableBookingHoldResponse();
      }

      if (hold !== null) {
        await releaseHoldAfterCheckoutFailure({ dependencies, hold, now, reason: "Square checkout setup failed" });
      }

      console.error("[booking checkout] Unable to initialize checkout", {
        error: error instanceof Error ? error.message : "Unknown checkout error",
      });

      return NextResponse.json(
        { error: "Unable to start booking checkout" },
        { status: 400 },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const [squareCheckoutModule, holdsModule] = await Promise.all([
    import("@/lib/booking/square-service-checkout"),
    import("@/lib/booking/holds"),
  ]);

  return createBookingCheckoutPostHandler({
    createSquareServiceBookingCheckout: squareCheckoutModule.createSquareServiceBookingCheckout,
    getAppointmentHoldByPublicReference: holdsModule.getAppointmentHoldByPublicReference,
    releaseHeldAppointmentHold: (input) => holdsModule.transitionAppointmentHold({
      expiresAfter: input.now,
      holdId: input.holdId,
      now: input.now,
      requiredState: "held",
      status: "released",
    }),
  })(req);
}

function isCheckoutStartableHold(hold: BookingHoldRecord, now: Date): boolean {
  return (hold.state === "held" && hold.expiresAt > now) ||
    (hold.state === "payment_pending" && isActiveHold(hold, now));
}

async function releaseHoldAfterCheckoutFailure(input: {
  dependencies: BookingCheckoutPostHandlerDependencies;
  hold: BookingHoldRecord;
  now: Date;
  reason: string;
}): Promise<void> {
  if (input.hold.state !== "held") {
    return;
  }

  try {
    await input.dependencies.releaseHeldAppointmentHold({ holdId: input.hold.id, now: input.now });
  } catch (error) {
    console.warn("[booking checkout] Failed to release hold after checkout failure", {
      error: error instanceof Error ? error.message : "Unknown release error",
      holdId: input.hold.id,
      reason: input.reason,
    });
  }
}

function parseBookingCheckoutRequest(body: unknown): BookingCheckoutRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const holdReference = parseRequiredString(body.holdReference);

  if (holdReference === null) {
    return null;
  }

  return { holdReference };
}

function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBookingCheckoutRequest(): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error: "Invalid booking checkout request" },
    { status: 400 },
  );
}

function unavailableBookingHoldResponse(): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error: "Booking hold is no longer available" },
    { status: 409 },
  );
}

function isUnavailableBookingHoldError(error: unknown): boolean {
  return error instanceof Error && error.message === "Booking hold is no longer available";
}
