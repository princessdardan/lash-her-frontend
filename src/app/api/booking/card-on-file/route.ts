export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import {
  createServicePaymentAlertLogger,
  type ServicePaymentAlertLogger,
} from "@/lib/booking/payments/service-payment-alerts";
import {
  confirmCardOnFileBooking,
  type CardOnFileBookingRequestBody,
  type CardOnFileBookingResult,
} from "@/lib/booking/payments/service-card-on-file";

interface CardOnFilePostHandlerDependencies {
  alerts: ServicePaymentAlertLogger;
  runCardOnFileBooking: (
    input: CardOnFileBookingRequestBody,
  ) => Promise<CardOnFileBookingResult>;
}

class CardOnFileRouteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardOnFileRouteValidationError";
  }
}

export function createCardOnFilePostHandler(
  dependencies: CardOnFilePostHandlerDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function cardOnFilePostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidRequestResponse("Invalid JSON body");
    }

    const request = parseCardOnFileBookingRequest(req, body);

    if (request === null) {
      return invalidRequestResponse("Invalid booking confirmation request");
    }

    if (request instanceof CardOnFileRouteValidationError) {
      return invalidRequestResponse(request.message);
    }

    const result = await dependencies.runCardOnFileBooking(request);

    if (!result.ok) {
      if (result.error === "invalid_request") {
        return invalidRequestResponse(result.message);
      }

      if (result.error === "hold_unavailable") {
        return conflictResponse(result.message);
      }

      if (result.error === "square_api_error") {
        dependencies.alerts.alert({
          category: "square_card_save_failed",
          severity: "warning",
          message: "Card-on-file booking Square API failure surfaced to client",
          context: { error: result.message },
        });

        return badGatewayResponse("Unable to save card with payment provider");
      }

      dependencies.alerts.alert({
        category: "stuck_payment_state",
        severity: "error",
        message:
          "Card-on-file booking infrastructure failure surfaced to client",
        context: { error: result.message },
      });

      return serviceUnavailableResponse(
        "Unable to complete booking confirmation",
      );
    }

    return Response.json({
      bookingStatus: result.bookingStatus,
      card: result.card,
      holdReference: result.holdReference,
      noShowChargeStatus: result.noShowChargeStatus,
    });
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  if (process.env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Card-on-file booking is not enabled" },
      { status: 404 },
    );
  }

  const alerts = createServicePaymentAlertLogger({});
  const runCardOnFileBooking =
    await createDefaultCardOnFileBookingRunner(alerts);

  return createCardOnFilePostHandler({
    alerts,
    runCardOnFileBooking,
  })(req);
}

async function createDefaultCardOnFileBookingRunner(
  alerts: ServicePaymentAlertLogger,
): Promise<
  (input: CardOnFileBookingRequestBody) => Promise<CardOnFileBookingResult>
> {
  const [
    {
      getSquareServiceBookingEnv,
      isSquareCardOnFileServiceBookingLocalInvoiceFallbackEnabled,
    },
    { createCardOnFileDrizzleRepository },
    { createSquareCustomersClient },
    { createSquareCardsClient },
    { createSquareInvoicesClient },
    { createCardOnFileCalendarFinalizer },
    { createCardOnFileNoShowInstrumentStep },
  ] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("@/lib/private-db/card-on-file-repository"),
    import("@/lib/payments/square/customers-client"),
    import("@/lib/payments/square/cards-client"),
    import("@/lib/payments/square/invoice-client"),
    import("@/lib/booking/payments/service-card-on-file-calendar-finalizer"),
    import("@/lib/booking/payments/service-card-on-file-no-show-instrument"),
  ]);

  const squareServiceBookingEnv = getSquareServiceBookingEnv();

  if (squareServiceBookingEnv === null) {
    return async function disabledRunner() {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Square service booking is not configured",
      } as const;
    };
  }

  const repository = await createCardOnFileDrizzleRepository();
  const squareCustomers = createSquareCustomersClient({
    environment: squareServiceBookingEnv.environment,
    accessToken: squareServiceBookingEnv.accessToken,
  });
  const squareCards = createSquareCardsClient({
    environment: squareServiceBookingEnv.environment,
    accessToken: squareServiceBookingEnv.accessToken,
  });
  const calendarFinalizer = createCardOnFileCalendarFinalizer();
  const squareInvoices = createSquareInvoicesClient({
    environment: squareServiceBookingEnv.environment,
    accessToken: squareServiceBookingEnv.accessToken,
  });
  const noShowInstrumentStep = createCardOnFileNoShowInstrumentStep({
    allowLocalFallback:
      isSquareCardOnFileServiceBookingLocalInvoiceFallbackEnabled(),
    locationId: squareServiceBookingEnv.locationId,
    repository,
    squareInvoices,
    alerts,
  });

  return async function defaultRunner(
    requestBody: CardOnFileBookingRequestBody,
  ): Promise<CardOnFileBookingResult> {
    return confirmCardOnFileBooking(requestBody, {
      alerts,
      calendarFinalizer,
      noShowInstrumentStep,
      repository,
      squareCards,
      squareCustomers,
    });
  };
}

function parseCardOnFileBookingRequest(
  req: NextRequest,
  body: unknown,
): CardOnFileBookingRequestBody | null | CardOnFileRouteValidationError {
  if (!isRecord(body)) {
    return null;
  }

  const holdReference = parseOptionalString(body.holdReference);
  const paymentSessionReference = parseOptionalString(
    body.paymentSessionReference,
  );
  const cardholderName = parseRequiredString(body.cardholderName);
  const idempotencyKey = parseRequiredString(body.idempotencyKey);
  const sourceId = parseRequiredString(body.sourceId);
  const policy = parsePolicy(body.policy);

  if (
    (holdReference === undefined) ===
    (paymentSessionReference === undefined)
  ) {
    return new CardOnFileRouteValidationError(
      "A valid booking payment session is required",
    );
  }

  if (
    cardholderName === null ||
    idempotencyKey === null ||
    sourceId === null ||
    policy === null
  ) {
    return null;
  }

  const verificationToken = parseOptionalString(body.verificationToken);
  const ipAddress = getClientIpHashInput(req);
  const userAgent = getUserAgentHashInput(req);

  return {
    cardholderName,
    holdReference,
    idempotencyKey,
    ipAddress,
    paymentSessionReference,
    policy,
    sourceId,
    userAgent,
    verificationToken,
  };
}

function parsePolicy(
  value: unknown,
): CardOnFileBookingRequestBody["policy"] | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.accepted !== true) {
    return null;
  }

  const maxChargeCents = parsePositiveInteger(value.maxChargeCents);

  if (maxChargeCents === null) {
    return null;
  }

  return {
    accepted: true,
    maxChargeCents,
  };
}

function getClientIpHashInput(req: NextRequest): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0];
    if (first !== undefined) {
      const trimmed = first.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp !== null) {
    const trimmed = realIp.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function getUserAgentHashInput(req: NextRequest): string | undefined {
  const value = req.headers.get("user-agent");
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = parseRequiredString(value);

  return trimmed ?? undefined;
}

function parsePositiveInteger(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    return null;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequestResponse(
  message: string,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 400 });
}

function conflictResponse(message: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 409 });
}

function badGatewayResponse(message: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 502 });
}

function serviceUnavailableResponse(
  message: string,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 503 });
}
