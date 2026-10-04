import { NextResponse, type NextRequest } from "next/server";

import { isActiveHold, type BookingHoldRecord } from "@/lib/booking/holds";
import { serviceBookingMovedResponse } from "@/lib/booking/fresha";

interface BookingCheckoutRequestBody {
  holdReference?: string;
  paymentSessionReference?: string;
}

interface BookingCheckoutPostHandlerDependencies {
  getAppointmentHoldByPaymentSessionReference: (
    paymentSessionReference: string,
  ) => Promise<BookingHoldRecord | null>;
  getAppointmentHoldByPublicReference: (
    publicReference: string,
  ) => Promise<BookingHoldRecord | null>;
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
  return async function bookingCheckoutPostHandler(
    req: NextRequest,
  ): Promise<Response> {
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
      hold =
        checkoutRequest.paymentSessionReference !== undefined
          ? await dependencies.getAppointmentHoldByPaymentSessionReference(
              checkoutRequest.paymentSessionReference,
            )
          : await dependencies.getAppointmentHoldByPublicReference(
              checkoutRequest.holdReference ?? "",
            );

      if (hold === null || !isCheckoutStartableHold(hold, now)) {
        return unavailableBookingHoldResponse();
      }

      // Lookup only: no provider request, hold transition, or new payment link.
      if (
        hold.state !== "payment_pending" ||
        hold.paymentProvider !== "square" ||
        !hold.squarePaymentLinkUrl ||
        !hold.squarePaymentLinkId ||
        !hold.checkoutOrderPublicId
      ) {
        return serviceBookingMovedResponse(req);
      }

      return NextResponse.json<BookingCheckoutResponseBody>(
        {
          checkoutUrl: hold.squarePaymentLinkUrl,
          holdReference: hold.publicReference,
          orderId: hold.checkoutOrderPublicId,
          paymentProvider: "square",
          reused: true,
          ...(hold.squareOrderId ? { squareOrderId: hold.squareOrderId } : {}),
          squarePaymentLinkId: hold.squarePaymentLinkId,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      console.error("[booking checkout] Unable to look up existing checkout", {
        error:
          error instanceof Error ? error.message : "Unknown checkout error",
      });

      return NextResponse.json(
        { error: "Unable to look up existing booking checkout" },
        { status: 400 },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const holdsModule = await import("@/lib/booking/holds");
  return createBookingCheckoutPostHandler({
    getAppointmentHoldByPaymentSessionReference:
      holdsModule.getAppointmentHoldByPaymentSessionReference,
    getAppointmentHoldByPublicReference:
      holdsModule.getAppointmentHoldByPublicReference,
  })(req);
}

function isCheckoutStartableHold(hold: BookingHoldRecord, now: Date): boolean {
  return (
    (hold.state === "held" && hold.expiresAt > now) ||
    (hold.state === "payment_pending" && isActiveHold(hold, now))
  );
}

function parseBookingCheckoutRequest(
  body: unknown,
): BookingCheckoutRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const holdReference = parseOptionalString(body.holdReference);
  const paymentSessionReference = parseOptionalString(
    body.paymentSessionReference,
  );

  // A checkout must be started by exactly one reference type.
  if (
    (holdReference === null && paymentSessionReference === null) ||
    (holdReference !== null && paymentSessionReference !== null)
  ) {
    return null;
  }

  if (holdReference !== null) {
    return { holdReference };
  }

  return { paymentSessionReference: paymentSessionReference as string };
}

function parseOptionalString(value: unknown): string | null {
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
