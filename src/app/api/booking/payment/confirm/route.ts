export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import {
  confirmChargeAndStoreBooking,
  type ChargeAndStoreBookingRequestBody,
  type ChargeAndStoreBookingResult,
  type RecordMarketingChoiceInput,
} from "@/lib/booking/payments/service-charge-and-store";
import {
  createServicePaymentAlertLogger,
  type ServicePaymentAlertLogger,
} from "@/lib/booking/payments/service-payment-alerts";
import type { RecordBookingMarketingChoiceInput } from "@/lib/marketing-contact/marketing-contact-store";

interface ServiceBookingPaymentConfirmPostHandlerDependencies {
  alerts: ServicePaymentAlertLogger;
  confirm: (
    input: ChargeAndStoreBookingRequestBody,
  ) => Promise<ChargeAndStoreBookingResult>;
}

export function createServiceBookingPaymentConfirmPostHandler(
  dependencies: ServiceBookingPaymentConfirmPostHandlerDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function serviceBookingPaymentConfirmPostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidRequestResponse("Invalid JSON body");
    }

    const request = parseChargeAndStoreBookingRequest(req, body);

    if (request === null) {
      return invalidRequestResponse("Invalid booking confirmation request");
    }

    const result = await dependencies.confirm(request);

    if (!result.ok) {
      if (result.error === "invalid_request") {
        return invalidRequestResponse(result.message);
      }

      if (result.error === "hold_unavailable") {
        return conflictResponse(result.message);
      }

      if (result.error === "payment_declined") {
        return paymentRequiredResponse(result.message);
      }

      if (result.error === "square_api_error") {
        dependencies.alerts.alert({
          category: "square_card_save_failed",
          severity: "warning",
          message:
            "Charge-and-store booking Square API failure surfaced to client",
          context: { error: result.message },
        });

        return badGatewayResponse("Unable to process payment with provider");
      }

      dependencies.alerts.alert({
        category: "stuck_payment_state",
        severity: "error",
        message:
          "Charge-and-store booking infrastructure failure surfaced to client",
        context: { error: result.message },
      });

      return serviceUnavailableResponse(
        "Unable to complete booking confirmation",
      );
    }

    return Response.json({
      bookingStatus: result.bookingStatus,
      card: pickCardResponseFields(result.card),
      holdReference: result.holdReference,
      paymentStatus: result.paymentStatus,
    });
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  if (process.env.SERVICE_BOOKING_SQUARE_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Service booking payment is not enabled" },
      { status: 404 },
    );
  }

  const alerts = createServicePaymentAlertLogger({});
  const confirm = await createDefaultChargeAndStoreConfirm(alerts);

  return createServiceBookingPaymentConfirmPostHandler({
    alerts,
    confirm,
  })(req);
}

async function createDefaultChargeAndStoreConfirm(
  alerts: ServicePaymentAlertLogger,
): Promise<
  (
    input: ChargeAndStoreBookingRequestBody,
  ) => Promise<ChargeAndStoreBookingResult>
> {
  const [
    { getSquareServiceBookingRuntimeEnv },
    { createSquarePaymentsClient },
    { createSquareCustomersClient },
    { createSquareCardsClient },
    { createSquareInvoicesClient },
    { createCardOnFileCalendarFinalizer },
    { createServiceBookingPaymentRepository },
    { recordBookingMarketingChoice },
  ] = await Promise.all([
    import("@/lib/booking/square-runtime"),
    import("@/lib/payments/square/payments-client"),
    import("@/lib/payments/square/customers-client"),
    import("@/lib/payments/square/cards-client"),
    import("@/lib/payments/square/invoice-client"),
    import("@/lib/booking/payments/service-card-on-file-calendar-finalizer"),
    import("@/lib/private-db/service-booking-payment-repository"),
    import("@/lib/marketing-contact/marketing-contact-store"),
  ]);

  const env = getSquareServiceBookingRuntimeEnv();

  if (env === null) {
    return async function disabledConfirm() {
      return {
        ok: false,
        error: "infrastructure_error",
        message: "Square service booking is not configured",
      } as const;
    };
  }

  const squarePayments = createSquarePaymentsClient({
    accessToken: env.accessToken,
    environment: env.environment,
  });
  const squareCustomers = createSquareCustomersClient({
    accessToken: env.accessToken,
    environment: env.environment,
  });
  const squareCards = createSquareCardsClient({
    accessToken: env.accessToken,
    environment: env.environment,
  });
  const squareInvoices = createSquareInvoicesClient({
    accessToken: env.accessToken,
    environment: env.environment,
  });
  const repository = await createServiceBookingPaymentRepository();
  const calendarFinalizer = createCardOnFileCalendarFinalizer();

  return async function defaultConfirm(
    input: ChargeAndStoreBookingRequestBody,
  ): Promise<ChargeAndStoreBookingResult> {
    return confirmChargeAndStoreBooking(input, {
      alerts,
      calendarFinalizer,
      locationId: env.locationId,
      recordMarketingChoice: createRecordMarketingChoice(
        recordBookingMarketingChoice,
      ),
      repository,
      squareCards,
      squareCustomers,
      squareInvoices,
      squarePayments,
    });
  };
}

function createRecordMarketingChoice(
  recordBookingMarketingChoice: (
    input: RecordBookingMarketingChoiceInput,
  ) => Promise<{ submissionId: string }>,
): (input: RecordMarketingChoiceInput) => Promise<void> {
  return async function recordMarketingChoice(input) {
    await recordBookingMarketingChoice({
      answers: input.answers.map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer,
      })),
      bookingType: input.bookingType,
      consentText: input.consentText,
      email: input.email,
      marketingOptIn: input.marketingOptIn,
      name: input.name,
      phone: input.phone,
      sourcePath: input.sourcePath,
      submittedAt: new Date(),
    });
  };
}

function parseChargeAndStoreBookingRequest(
  req: NextRequest,
  body: unknown,
): ChargeAndStoreBookingRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const paymentSessionReference = parseRequiredString(
    body.paymentSessionReference,
  );
  const idempotencyKey = parseRequiredString(body.idempotencyKey);
  const sourceId = parseRequiredString(body.sourceId);
  const customer = parseCustomer(body.customer);
  const payment = parsePayment(body.payment);
  const policy = parsePolicy(body.policy);

  if (
    paymentSessionReference === null ||
    idempotencyKey === null ||
    sourceId === null ||
    customer === null ||
    payment === null ||
    policy === null
  ) {
    return null;
  }

  const verificationToken = parseOptionalString(body.verificationToken);
  const ipAddress = getClientIpHashInput(req);
  const userAgent = getUserAgentHashInput(req);

  return {
    paymentSessionReference,
    idempotencyKey,
    sourceId,
    customer,
    payment,
    policy,
    verificationToken,
    ipAddress,
    userAgent,
  };
}

function parseCustomer(
  value: unknown,
): ChargeAndStoreBookingRequestBody["customer"] | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = parseRequiredString(value.name);
  const email = parseEmailLike(value.email);
  const phone = parseRequiredString(value.phone);

  if (name === null) {
    return null;
  }

  if (email === null) {
    return null;
  }

  if (phone === null) {
    return null;
  }

  if (typeof value.marketingOptIn !== "boolean") {
    return null;
  }

  return {
    name,
    email,
    phone,
    marketingOptIn: value.marketingOptIn,
  };
}

function parsePayment(
  value: unknown,
): ChargeAndStoreBookingRequestBody["payment"] | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.option !== "deposit" &&
    value.option !== "full" &&
    value.option !== "customPartial"
  ) {
    return null;
  }

  const expectedAmountCents = parsePositiveInteger(value.expectedAmountCents);

  if (expectedAmountCents === null) {
    return null;
  }

  const result: ChargeAndStoreBookingRequestBody["payment"] = {
    option: value.option,
    expectedAmountCents,
  };

  if (value.option === "customPartial") {
    const customAmountCents = parsePositiveInteger(value.customAmountCents);
    if (customAmountCents === null) {
      return null;
    }
    result.customAmountCents = customAmountCents;
  }

  return result;
}

function parsePolicy(
  value: unknown,
): ChargeAndStoreBookingRequestBody["policy"] | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.accepted !== true) {
    return null;
  }

  const policyVersion = parseRequiredString(value.policyVersion);
  const policyTextHash = parseRequiredString(value.policyTextHash);

  if (policyVersion === null || policyTextHash === null) {
    return null;
  }

  return {
    accepted: true,
    policyVersion,
    policyTextHash,
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

function parseEmailLike(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || !trimmed.includes("@")) {
    return null;
  }

  return trimmed;
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

function pickCardResponseFields(
  card:
    | { brand?: string; last4?: string; expMonth?: number; expYear?: number }
    | undefined,
): { brand?: string; last4?: string; expMonth?: number; expYear?: number } {
  if (card === undefined) {
    return {};
  }

  return {
    brand: typeof card.brand === "string" ? card.brand : undefined,
    last4: typeof card.last4 === "string" ? card.last4 : undefined,
    expMonth: typeof card.expMonth === "number" ? card.expMonth : undefined,
    expYear: typeof card.expYear === "number" ? card.expYear : undefined,
  };
}

function invalidRequestResponse(
  message: string,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 400 });
}

function conflictResponse(message: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 409 });
}

function paymentRequiredResponse(
  message: string,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 402 });
}

function badGatewayResponse(message: string): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 502 });
}

function serviceUnavailableResponse(
  message: string,
): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 503 });
}
