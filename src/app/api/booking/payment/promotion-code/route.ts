export const runtime = "nodejs";

import { eq, and, gt } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import {
  resolveServiceBookingPaymentSession,
  type ServiceBookingPaymentSessionDisplay,
} from "@/lib/booking/payment-session";
import {
  calculateServicePromotionSnapshot,
  type ServicePromotionSnapshot,
} from "@/lib/booking/payments/service-promotion";
import {
  parsePromotionCodeInput,
  type PromotionCode,
} from "@/lib/commerce/discounts";

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

interface ServiceBookingPromotionHoldContext {
  basePriceCents: number;
  serviceId: string;
  serviceSlug: string;
}

export interface ServiceBookingPromotionCodeHandlerDependencies {
  checkRateLimit?: (
    key: string,
  ) => { ok: true } | { ok: false; retryAfterSeconds: number };
  getHoldContext: (
    paymentSessionReference: string,
  ) => Promise<ServiceBookingPromotionHoldContext | null>;
  getPromotionCode: (code: string) => Promise<PromotionCode | null>;
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
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidRequestResponse("Invalid JSON body");
    }

    const request = parsePromotionCodeRequest(body);
    if (request === null) {
      return invalidRequestResponse("Invalid promotion code request");
    }

    const now = new Date();

    if (request.action === "apply") {
      const rateLimitKey = `${request.paymentSessionReference}:${getClientIp(req) ?? "unknown"}`;
      const rateLimit = dependencies.checkRateLimit?.(rateLimitKey);
      if (rateLimit !== undefined && !rateLimit.ok) {
        return rateLimitedResponse();
      }
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

    const promotionCode = await dependencies.getPromotionCode(request.code);

    if (promotionCode === null || promotionCode.isEnabled === false) {
      return invalidRequestResponse("Promotion code is not valid");
    }

    const promotionSnapshot = calculateServicePromotionSnapshot({
      promotionCode,
      serviceId: holdContext.serviceId,
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

  const { loaders } = await import("@/data/loaders");

  return createServiceBookingPromotionCodePostHandler({
    checkRateLimit: defaultRateLimiter.check.bind(defaultRateLimiter),
    getHoldContext: async (paymentSessionReference) => {
      const { getAppointmentHoldByPaymentSessionReference } =
        await import("@/lib/booking/holds");
      const hold = await getAppointmentHoldByPaymentSessionReference(
        paymentSessionReference,
      );

      if (hold === null) return null;

      const serviceId =
        typeof hold.offeringSnapshot.id === "string"
          ? hold.offeringSnapshot.id
          : null;
      const serviceSlug =
        typeof hold.offeringSnapshot.serviceSlug === "string"
          ? hold.offeringSnapshot.serviceSlug
          : null;
      const basePriceCents = readHeldBasePriceCents(hold.offeringSnapshot);

      return serviceId !== null &&
        serviceSlug !== null &&
        basePriceCents !== null
        ? { basePriceCents, serviceId, serviceSlug }
        : null;
    },
    getPromotionCode: loaders.getPromotionCode,
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

const defaultRateLimiter = createInMemoryRateLimiter({
  windowMs: 60_000,
  maxAttempts: 10,
});

export interface InMemoryRateLimiter {
  check(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
}

export function createInMemoryRateLimiter(options: {
  windowMs: number;
  maxAttempts: number;
}): InMemoryRateLimiter {
  const attempts = new Map<string, number[]>();

  return {
    check(key) {
      const now = Date.now();
      const windowStart = now - options.windowMs;
      const timestamps = attempts.get(key) ?? [];
      const recent = timestamps.filter((timestamp) => timestamp > windowStart);

      if (recent.length >= options.maxAttempts) {
        const oldest = recent[0] ?? now;
        const retryAfterSeconds = Math.ceil(
          (oldest + options.windowMs - now) / 1000,
        );
        return { ok: false, retryAfterSeconds };
      }

      recent.push(now);
      attempts.set(key, recent);
      return { ok: true };
    },
  };
}

function getClientIp(req: NextRequest): string | undefined {
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

function rateLimitedResponse(): NextResponse<ServiceBookingPromotionCodeErrorBody> {
  return NextResponse.json(
    { error: "Too many promotion code attempts. Please try again later." },
    { status: 429 },
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

function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
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
