export const runtime = "nodejs";

import { eq, and, gt } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import {
  resolveServiceBookingPaymentSession,
  type ServiceBookingPaymentSessionDisplay,
} from "@/lib/booking/payment-session";
import {
  calculateAuthorizedServicePromotionSnapshot,
  calculateServicePromotionSnapshot,
  type ServicePromotionSnapshot,
} from "@/lib/booking/payments/service-promotion";
import {
  parsePromotionCodeInput,
  PROMOTION_CODE_MAX_LENGTH,
  type PromotionCode,
} from "@/lib/commerce/discounts";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import type { RateLimitDecision } from "@/lib/security/kv-rate-limiter";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";

const PROMOTION_CODE_BODY_MAX_BYTES = 1024;
const PAYMENT_SESSION_REFERENCE_MAX_LENGTH = 128;

export type ServiceBookingPromotionAction = "apply" | "remove";

export interface ServiceBookingPromotionCodeRequestBody {
  action: ServiceBookingPromotionAction;
  code?: string;
  paymentSessionReference: string;
}

export interface ServiceBookingPromotionCodeResponseBody {
  session: ServiceBookingPaymentSessionDisplay;
}

export interface ServiceBookingPromotionCodeErrorBody {
  error: string;
}

type ServiceBookingPromotionHoldContext =
  | {
      basePriceCents: number;
      bookingModelVersion: 2;
      offeringId: string;
      serviceSlug: string;
    }
  | {
      basePriceCents: number;
      bookingModelVersion: 1;
      serviceIds: string[];
      serviceSlug: string;
    };

export interface ServiceBookingPromotionCodeHandlerDependencies {
  checkRateLimit?: (input: {
    key: string;
    now: Date;
  }) => Promise<RateLimitDecision>;
  getNow?: () => Date;
  getHoldContext: (
    paymentSessionReference: string,
  ) => Promise<ServiceBookingPromotionHoldContext | null>;
  getPromotionCode: (code: string) => Promise<PromotionCode | null>;
  resolveOperationalPromotionCode: (input: {
    code: string;
    now: Date;
    offeringId: string;
  }) => Promise<PromotionCode | null>;
  resolveSession: (input: {
    paymentSessionReference: string;
    serviceSlug: string;
    now: Date;
  }) => Promise<
    | {
        status: "active";
        session: ServiceBookingPaymentSessionDisplay;
      }
    | { status: "inactive" }
  >;
  updateHoldPromotionSnapshot: (input: {
    paymentSessionReference: string;
    promotionSnapshot: ServicePromotionSnapshot | null;
    now: Date;
  }) => Promise<
    { ok: true } | { ok: false; reason: "not_found" | "unavailable" }
  >;
}

export function createServiceBookingPromotionCodePostHandler(
  dependencies: ServiceBookingPromotionCodeHandlerDependencies,
): (req: NextRequest) => Promise<Response> {
  return async function serviceBookingPromotionCodePostHandler(
    req: NextRequest,
  ): Promise<Response> {
    const parsedBody = await readBoundedJsonBody(
      req,
      PROMOTION_CODE_BODY_MAX_BYTES,
    );
    if (!parsedBody.ok) {
      return parsedBody.reason === "too_large"
        ? NextResponse.json<ServiceBookingPromotionCodeErrorBody>(
            { error: "Promotion code request is too large" },
            { status: 413 },
          )
        : invalidRequestResponse("Invalid JSON body");
    }

    const request = parsePromotionCodeRequest(parsedBody.value);
    if (request === null) {
      return invalidRequestResponse("Invalid promotion code request");
    }

    const now = dependencies.getNow?.() ?? new Date();

    const rateLimitResponse = await enforcePromotionCodeRateLimit({
      dependencies,
      now,
      req,
      action: request.action,
    });
    if (rateLimitResponse !== null) {
      return rateLimitResponse;
    }

    const holdContext = await dependencies.getHoldContext(
      request.paymentSessionReference,
    );

    if (holdContext === null) {
      return holdUnavailableResponse();
    }

    if (request.action === "remove") {
      const removeResult = await dependencies.updateHoldPromotionSnapshot({
        paymentSessionReference: request.paymentSessionReference,
        promotionSnapshot: null,
        now,
      });

      if (!removeResult.ok) {
        return holdUnavailableResponse();
      }

      return resolveSessionResponse(
        dependencies.resolveSession,
        request.paymentSessionReference,
        holdContext.serviceSlug,
        now,
      );
    }

    if (request.code === undefined) {
      return invalidRequestResponse("Promotion code is required");
    }

    const promotionCode =
      holdContext.bookingModelVersion === 2
        ? await dependencies.resolveOperationalPromotionCode({
            code: request.code,
            now,
            offeringId: holdContext.offeringId,
          })
        : await dependencies.getPromotionCode(request.code);

    if (promotionCode === null || promotionCode.isEnabled === false) {
      return invalidRequestResponse("Promotion code is not valid");
    }

    const promotionSnapshot =
      holdContext.bookingModelVersion === 2
        ? calculateAuthorizedServicePromotionSnapshot({
            promotionCode,
            basePriceCents: holdContext.basePriceCents,
          })
        : calculateServicePromotionSnapshot({
            promotionCode,
            serviceIds: holdContext.serviceIds,
            basePriceCents: holdContext.basePriceCents,
          });

    if (promotionSnapshot === null) {
      return invalidRequestResponse(
        "Promotion code does not apply to this service",
      );
    }

    const applyResult = await dependencies.updateHoldPromotionSnapshot({
      paymentSessionReference: request.paymentSessionReference,
      promotionSnapshot,
      now,
    });

    if (!applyResult.ok) {
      return holdUnavailableResponse();
    }

    return resolveSessionResponse(
      dependencies.resolveSession,
      request.paymentSessionReference,
      holdContext.serviceSlug,
      now,
    );
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  if (process.env.SERVICE_BOOKING_SQUARE_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Service booking payment is not enabled" },
      { status: 404 },
    );
  }

  return createServiceBookingPromotionCodePostHandler({
    checkRateLimit: async (input) => {
      const { checkBookingPromotionCodeRateLimit } =
        await import("@/lib/security/booking-abuse-control");
      return checkBookingPromotionCodeRateLimit(input);
    },
    getHoldContext: async (paymentSessionReference) => {
      const { getAppointmentHoldByPaymentSessionReference } =
        await import("@/lib/booking/holds");
      const hold = await getAppointmentHoldByPaymentSessionReference(
        paymentSessionReference,
      );

      if (hold === null) return null;

      return readServiceBookingPromotionHoldContext(hold.offeringSnapshot);
    },
    getPromotionCode: async (code) => {
      const { loaders } = await import("@/data/loaders");
      return loaders.getPromotionCode(code);
    },
    resolveOperationalPromotionCode: async (input) => {
      const { resolveActiveServicePromotionCode } =
        await import("@/lib/private-db/service-promotion-repository");
      return resolveActiveServicePromotionCode(input);
    },
    resolveSession: async ({ paymentSessionReference, serviceSlug, now }) => {
      const result = await resolveServiceBookingPaymentSession({
        paymentSessionReference,
        serviceSlug,
        now,
      });

      if (result.status !== "active") {
        return { status: "inactive" };
      }

      return { status: "active", session: result.session };
    },
    updateHoldPromotionSnapshot: createDefaultUpdateHoldPromotionSnapshot(),
  })(req);
}

export function readServiceBookingPromotionHoldContext(
  snapshot: Record<string, unknown>,
): ServiceBookingPromotionHoldContext | null {
  const serviceSlug = parseRequiredString(snapshot.serviceSlug);
  const basePriceCents = readHeldBasePriceCents(snapshot);

  if (serviceSlug === null || basePriceCents === null) {
    return null;
  }

  if (snapshot.bookingModelVersion === 2) {
    const offeringId = parseRequiredString(snapshot.offeringId);
    if (offeringId === null) {
      return null;
    }

    return {
      basePriceCents,
      bookingModelVersion: 2,
      offeringId,
      serviceSlug,
    };
  }

  const legacyServiceId = parseRequiredString(snapshot.id);
  return legacyServiceId === null
    ? null
    : {
        basePriceCents,
        bookingModelVersion: 1,
        serviceIds: [legacyServiceId],
        serviceSlug,
      };
}

async function resolveSessionResponse(
  resolveSession: ServiceBookingPromotionCodeHandlerDependencies["resolveSession"],
  paymentSessionReference: string,
  serviceSlug: string,
  now: Date,
): Promise<Response> {
  const sessionResult = await resolveSession({
    paymentSessionReference,
    now,
    serviceSlug,
  });

  if (sessionResult.status !== "active") {
    return holdUnavailableResponse();
  }

  return NextResponse.json<ServiceBookingPromotionCodeResponseBody>({
    session: sessionResult.session,
  });
}

function createDefaultUpdateHoldPromotionSnapshot(): ServiceBookingPromotionCodeHandlerDependencies["updateHoldPromotionSnapshot"] {
  return async function updateHoldPromotionSnapshot(input) {
    const [{ getPrivateDb }, { appointmentHolds }] = await Promise.all([
      import("@/lib/private-db/client"),
      import("@/lib/private-db/schema"),
    ]);
    const db = getPrivateDb();

    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: appointmentHolds.id,
          offeringSnapshot: appointmentHolds.offeringSnapshot,
          reconciliationMetadata: appointmentHolds.reconciliationMetadata,
        })
        .from(appointmentHolds)
        .where(
          and(
            eq(
              appointmentHolds.paymentSessionReference,
              input.paymentSessionReference,
            ),
            eq(appointmentHolds.status, "held"),
            gt(appointmentHolds.expiresAt, input.now),
          ),
        )
        .limit(1)
        .for("update");

      const row = rows[0];
      if (row === undefined) {
        return { ok: false, reason: "not_found" };
      }

      const metadata = isRecord(row.reconciliationMetadata)
        ? row.reconciliationMetadata
        : {};
      if (
        isActiveInProgressMarker(metadata.chargeAndStoreInProgress, input.now)
      ) {
        return { ok: false, reason: "unavailable" };
      }

      const offeringSnapshot = isRecord(row.offeringSnapshot)
        ? row.offeringSnapshot
        : {};
      const nextOfferingSnapshot = { ...offeringSnapshot };

      if (input.promotionSnapshot === null) {
        delete nextOfferingSnapshot.promotionSnapshot;
      } else {
        nextOfferingSnapshot.promotionSnapshot = input.promotionSnapshot;
      }

      const [updated] = await tx
        .update(appointmentHolds)
        .set({
          offeringSnapshot: nextOfferingSnapshot,
          updatedAt: input.now,
        })
        .where(eq(appointmentHolds.id, row.id))
        .returning();

      if (updated === undefined) {
        return { ok: false, reason: "unavailable" };
      }

      return { ok: true };
    });
  };
}

function readHeldBasePriceCents(
  snapshot: Record<string, unknown>,
): number | null {
  const pricing = isRecord(snapshot.pricing) ? snapshot.pricing : null;
  const fullPrice = pricing !== null ? pricing.fullPrice : snapshot.fullPrice;

  if (
    typeof fullPrice !== "number" ||
    !Number.isFinite(fullPrice) ||
    fullPrice <= 0
  ) {
    return null;
  }

  return Math.round(fullPrice * 100);
}

async function enforcePromotionCodeRateLimit(input: {
  action: ServiceBookingPromotionAction;
  dependencies: ServiceBookingPromotionCodeHandlerDependencies;
  now: Date;
  req: NextRequest;
}): Promise<Response | null> {
  if (input.action === "remove" || !input.dependencies.checkRateLimit) {
    return null;
  }

  const key = buildBookingAbuseKey({
    headers: input.req.headers,
    scope: "promotion-attempts",
    subject: "all",
  });
  if (key === null) {
    return promotionCodeServiceUnavailableResponse();
  }

  try {
    const decision = await input.dependencies.checkRateLimit({
      key,
      now: input.now,
    });
    return decision.allowed
      ? null
      : rateLimitedResponse(decision.retryAfterSeconds);
  } catch (error) {
    console.warn("[booking promotion code] Rate limiter unavailable", {
      error: getErrorMessage(error),
    });
    return promotionCodeServiceUnavailableResponse();
  }
}

function rateLimitedResponse(
  retryAfterSeconds: number,
): NextResponse<ServiceBookingPromotionCodeErrorBody> {
  return NextResponse.json(
    { error: "Too many promotion code attempts. Please try again later." },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
      },
      status: 429,
    },
  );
}

function promotionCodeServiceUnavailableResponse(): NextResponse<ServiceBookingPromotionCodeErrorBody> {
  return NextResponse.json(
    { error: "Promotion codes are temporarily unavailable" },
    { headers: { "Cache-Control": "no-store" }, status: 503 },
  );
}

function isActiveInProgressMarker(inProgress: unknown, now: Date): boolean {
  if (!isRecord(inProgress) || typeof inProgress.startedAt !== "string") {
    return false;
  }

  const startedAt = new Date(inProgress.startedAt).getTime();
  if (Number.isNaN(startedAt)) return false;

  return now.getTime() - startedAt < 30_000;
}

function parsePromotionCodeRequest(
  body: unknown,
): ServiceBookingPromotionCodeRequestBody | null {
  if (!isRecord(body)) return null;

  const paymentSessionReference = parseRequiredString(
    body.paymentSessionReference,
    PAYMENT_SESSION_REFERENCE_MAX_LENGTH,
  );
  const action = parsePromotionAction(body.action);

  if (paymentSessionReference === null || action === null) {
    return null;
  }

  const request: ServiceBookingPromotionCodeRequestBody = {
    action,
    paymentSessionReference,
  };

  if (action === "apply") {
    if (
      typeof body.code !== "string" ||
      body.code.length > PROMOTION_CODE_MAX_LENGTH
    ) {
      return null;
    }
    const code = parsePromotionCodeInput(body.code);
    if (!code) return null;
    request.code = code;
  }

  return request;
}

function parsePromotionAction(
  value: unknown,
): ServiceBookingPromotionAction | null {
  if (value === "apply" || value === "remove") return value;
  return null;
}

function parseRequiredString(
  value: unknown,
  maxLength = Number.MAX_SAFE_INTEGER,
): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequestResponse(
  message: string,
): NextResponse<ServiceBookingPromotionCodeErrorBody> {
  return NextResponse.json({ error: message }, { status: 400 });
}

function holdUnavailableResponse(): NextResponse<ServiceBookingPromotionCodeErrorBody> {
  return NextResponse.json(
    { error: "Booking hold is no longer available" },
    { status: 409 },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
