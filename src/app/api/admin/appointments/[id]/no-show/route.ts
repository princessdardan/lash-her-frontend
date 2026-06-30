import "server-only";

import { timingSafeEqual } from "node:crypto";

import {
  chargeNoShowInvoice,
  CONTROL_CHARACTER_PATTERN,
  isStaleChargePending,
  NO_SHOW_REASON_MAX_LENGTH,
  NoShowInvoiceAmountError,
  OPERATOR_ID_PATTERN,
  validateNoShowAdminAction,
  type NoShowInvoiceRepository,
} from "@/lib/booking/payments/service-no-show-invoice";
import { createServicePaymentAlertLogger } from "@/lib/booking/payments/service-payment-alerts";
import {
  getBookingAdminPaymentActionSecret,
  getSquareServiceBookingEnv,
} from "@/lib/env/private-checkout";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  appointmentHolds,
  bookingNoShowChargeRecords,
} from "@/lib/private-db/schema";
import type { NoShowChargeStatus } from "@/lib/private-db/schema";
import { createSquareInvoicesClient } from "@/lib/payments/square/invoice-client";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AdminNoShowRequestBody {
  amountCents: number;
  confirmPolicyCharge: true;
  idempotencyKey: string;
  operatorId: string;
  reason: string;
}

export interface AdminNoShowResponseBody {
  appointmentId: string;
  chargeStatus:
    | "charge_pending"
    | "charged"
    | "charge_failed"
    | "manual_followup";
  noShowChargeRecordId: string;
}

export interface BookedAppointmentWithNoShowRecord {
  appointmentId: string;
  chargeStatus: NoShowChargeStatus;
  hasSavedCard: boolean;
  holdId: string;
  maxChargeCents: number;
  noShowChargeRecordId: string;
  providerStatus?: string;
  selectedEnd: Date;
  updatedAt?: Date;
}

export interface ChargeNoShowInvoiceInput {
  amountCents: number;
  appointmentId: string;
  holdId: string;
  idempotencyKey: string;
  noShowChargeRecordId: string;
  operatorId?: string;
  reason?: string;
}

export interface ChargeNoShowInvoiceResult {
  appointmentId: string;
  chargeStatus: AdminNoShowResponseBody["chargeStatus"];
  noShowChargeRecordId: string;
}

export interface AdminNoShowDependencies {
  chargeNoShow: (
    input: ChargeNoShowInvoiceInput,
  ) => Promise<ChargeNoShowInvoiceResult>;
  findBookedAppointmentWithNoShowRecord: (
    appointmentId: string,
  ) => Promise<BookedAppointmentWithNoShowRecord | null>;
  getAdminSecret: () => string | null;
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
}

export interface ChargeNoShowCommandDependencies {
  createAlerts?: typeof createServicePaymentAlertLogger;
  createRepository?: () => Promise<NoShowInvoiceRepository>;
  createSquareInvoicesClient?: typeof createSquareInvoicesClient;
  getNow?: () => Date;
  getSquareServiceBookingEnv?: typeof getSquareServiceBookingEnv;
  logError?: typeof console.error;
}

const defaultDependencies: AdminNoShowDependencies = {
  chargeNoShow: defaultChargeNoShowCommand,
  findBookedAppointmentWithNoShowRecord:
    defaultFindBookedAppointmentWithNoShowRecord,
  getAdminSecret: getConfiguredBookingAdminPaymentActionSecret,
  getNow: () => new Date(),
  logError: console.error,
  logWarn: console.warn,
};

export const POST = createAdminNoShowPostHandler(defaultDependencies);

export function createAdminNoShowPostHandler(
  dependencies: AdminNoShowDependencies,
): (req: Request) => Promise<Response> {
  return async function adminNoShowPostHandler(
    req: Request,
  ): Promise<Response> {
    const adminSecret = dependencies.getAdminSecret();

    if (adminSecret === null) {
      dependencies.logWarn(
        "[admin:no-show] Admin payment action secret is not configured",
      );
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedAdminRequest(req, adminSecret)) {
      dependencies.logWarn(
        "[admin:no-show] Unauthorized no-show charge request",
      );
      return new Response(null, { status: 401 });
    }

    let rawBody: unknown;

    try {
      rawBody = await req.json();
    } catch {
      return invalidNoShowRequestResponse();
    }

    const parsedBody = parseAdminNoShowRequestBody(rawBody);

    if (parsedBody === null) {
      return invalidNoShowRequestResponse();
    }

    const appointmentId = extractAppointmentIdFromUrl(req.url);

    if (appointmentId === null) {
      return invalidNoShowRequestResponse();
    }

    const appointment =
      await dependencies.findBookedAppointmentWithNoShowRecord(appointmentId);

    if (appointment === null) {
      return Response.json({ error: "Appointment not found" }, { status: 404 });
    }

    if (
      !appointment.hasSavedCard ||
      appointment.noShowChargeRecordId.length === 0
    ) {
      return Response.json(
        { error: "Appointment has no saved card or no-show charge record" },
        { status: 409 },
      );
    }

    if (appointment.chargeStatus === "charged") {
      return Response.json(
        { error: "No-show charge already succeeded" },
        { status: 409 },
      );
    }

    if (appointment.selectedEnd.getTime() > dependencies.getNow().getTime()) {
      return Response.json(
        {
          error: "Appointment is not eligible for no-show charge",
          code: "NO_SHOW_APPOINTMENT_NOT_ENDED",
        },
        { status: 409 },
      );
    }

    if (appointment.chargeStatus === "charge_pending") {
      if (
        !isStaleChargePending(
          {
            status: appointment.chargeStatus,
            providerStatus: appointment.providerStatus,
            updatedAt: appointment.updatedAt,
          },
          dependencies.getNow(),
        )
      ) {
        return Response.json(
          {
            appointmentId: appointment.appointmentId,
            chargeStatus: "charge_pending",
            noShowChargeRecordId: appointment.noShowChargeRecordId,
          },
          { status: 200 },
        );
      }
    }

    if (parsedBody.amountCents !== appointment.maxChargeCents) {
      return Response.json(
        {
          error: "Invalid no-show charge amount",
          code: "NO_SHOW_AMOUNT_MUST_EQUAL_MAX_CHARGE",
          allowedAmountCents: appointment.maxChargeCents,
        },
        { status: 400 },
      );
    }

    let result: ChargeNoShowInvoiceResult;

    try {
      result = await dependencies.chargeNoShow({
        amountCents: parsedBody.amountCents,
        appointmentId: appointment.appointmentId,
        holdId: appointment.holdId,
        idempotencyKey: parsedBody.idempotencyKey,
        noShowChargeRecordId: appointment.noShowChargeRecordId,
        operatorId: parsedBody.operatorId,
        reason: parsedBody.reason,
      });
    } catch (error) {
      if (
        error instanceof NoShowInvoiceAmountError ||
        (error instanceof Error && error.name === "NoShowInvoiceAmountError")
      ) {
        return Response.json(
          {
            error: "Invalid no-show charge amount",
            code: "NO_SHOW_AMOUNT_MUST_EQUAL_MAX_CHARGE",
            allowedAmountCents:
              error instanceof NoShowInvoiceAmountError
                ? error.context?.allowedAmountCents
                : (
                    error as Error & {
                      context?: { allowedAmountCents?: number };
                    }
                  ).context?.allowedAmountCents,
          },
          { status: 400 },
        );
      }

      dependencies.logError("[admin:no-show] No-show charge command failed", {
        error: "redacted",
      });

      result = {
        appointmentId: appointment.appointmentId,
        chargeStatus: "charge_failed",
        noShowChargeRecordId: appointment.noShowChargeRecordId,
      };
    }

    const responseStatus =
      result.chargeStatus === "manual_followup" ||
      result.chargeStatus === "charge_failed"
        ? 202
        : 200;

    return Response.json(
      {
        appointmentId: result.appointmentId,
        chargeStatus: result.chargeStatus,
        noShowChargeRecordId: result.noShowChargeRecordId,
      },
      { status: responseStatus },
    );
  };
}

function isAuthorizedAdminRequest(req: Request, adminSecret: string): boolean {
  const authorization = req.headers.get("authorization");

  if (authorization === null) {
    return false;
  }

  const prefix = "Bearer ";

  if (!authorization.startsWith(prefix)) {
    return false;
  }

  return timingSafeStringEqual(adminSecret, authorization.slice(prefix.length));
}

function timingSafeStringEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function parseAdminNoShowRequestBody(
  body: unknown,
): AdminNoShowRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  if (
    typeof body.amountCents !== "number" ||
    !Number.isSafeInteger(body.amountCents) ||
    body.amountCents <= 0
  ) {
    return null;
  }

  if (body.confirmPolicyCharge !== true) {
    return null;
  }

  if (
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.trim().length === 0
  ) {
    return null;
  }

  const operatorId =
    typeof body.operatorId === "string" ? body.operatorId.trim() : "";
  if (!OPERATOR_ID_PATTERN.test(operatorId)) {
    return null;
  }

  if (
    typeof body.reason !== "string" ||
    CONTROL_CHARACTER_PATTERN.test(body.reason) ||
    body.reason.trim().length === 0 ||
    body.reason.trim().length > NO_SHOW_REASON_MAX_LENGTH
  ) {
    return null;
  }

  return {
    amountCents: body.amountCents,
    confirmPolicyCharge: true,
    idempotencyKey: body.idempotencyKey.trim(),
    operatorId,
    reason: body.reason.trim(),
  };
}

function extractAppointmentIdFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(
      /^\/api\/admin\/appointments\/([^/]+)\/no-show$/,
    );

    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function invalidNoShowRequestResponse(): Response {
  return Response.json(
    { error: "Invalid no-show charge request" },
    { status: 400 },
  );
}

function getConfiguredBookingAdminPaymentActionSecret(): string | null {
  try {
    return getBookingAdminPaymentActionSecret();
  } catch {
    return null;
  }
}

async function defaultFindBookedAppointmentWithNoShowRecord(
  appointmentId: string,
): Promise<BookedAppointmentWithNoShowRecord | null> {
  try {
    const db = getPrivateDb();
    const [row] = await db
      .select({
        id: appointmentHolds.id,
        status: appointmentHolds.status,
        savedPaymentMethodId: appointmentHolds.savedPaymentMethodId,
        noShowChargeRecordId: appointmentHolds.noShowChargeRecordId,
        selectedEnd: appointmentHolds.selectedEnd,
      })
      .from(appointmentHolds)
      .where(eq(appointmentHolds.id, appointmentId))
      .limit(1);

    if (row === undefined) {
      return null;
    }

    if (row.status !== "booked") {
      return null;
    }

    const noShowChargeRecordId = row.noShowChargeRecordId ?? "";
    const hasSavedCard = row.savedPaymentMethodId !== null;

    let chargeStatus: NoShowChargeStatus = "ready";
    let maxChargeCents = 0;
    let providerStatus: string | undefined;
    let updatedAt: Date | undefined;

    if (noShowChargeRecordId.length > 0) {
      const [noShowRecord] = await db
        .select({
          status: bookingNoShowChargeRecords.status,
          maxChargeCents: bookingNoShowChargeRecords.maxChargeCents,
          providerStatus: bookingNoShowChargeRecords.providerStatus,
          updatedAt: bookingNoShowChargeRecords.updatedAt,
        })
        .from(bookingNoShowChargeRecords)
        .where(eq(bookingNoShowChargeRecords.id, noShowChargeRecordId))
        .limit(1);

      chargeStatus = noShowRecord?.status ?? "ready";
      maxChargeCents = noShowRecord?.maxChargeCents ?? 0;
      providerStatus = noShowRecord?.providerStatus ?? undefined;
      updatedAt = noShowRecord?.updatedAt ?? undefined;
    }

    return {
      appointmentId: row.id,
      chargeStatus,
      hasSavedCard,
      holdId: row.id,
      maxChargeCents,
      noShowChargeRecordId,
      providerStatus,
      selectedEnd: row.selectedEnd,
      updatedAt,
    };
  } catch (error) {
    console.error("[admin:no-show] Failed to load booked appointment", {
      appointmentId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

export async function defaultChargeNoShowCommand(
  input: ChargeNoShowInvoiceInput,
  dependencies: ChargeNoShowCommandDependencies = {},
): Promise<ChargeNoShowInvoiceResult> {
  const getSquareEnv =
    dependencies.getSquareServiceBookingEnv ?? getSquareServiceBookingEnv;
  const createRepository =
    dependencies.createRepository ??
    (async () => {
      const [{ createCardOnFileDrizzleRepository }] = await Promise.all([
        import("@/lib/private-db/card-on-file-repository"),
      ]);
      return createCardOnFileDrizzleRepository();
    });
  const createSquareClient =
    dependencies.createSquareInvoicesClient ?? createSquareInvoicesClient;
  const createAlerts =
    dependencies.createAlerts ?? createServicePaymentAlertLogger;
  const getNow = dependencies.getNow ?? (() => new Date());
  const logError = dependencies.logError ?? console.error;

  try {
    const squareEnv = getSquareEnv();
    const repository = await createRepository();
    const now = getNow();

    // Validate and normalize before any audit persistence or provider action.
    if (input.operatorId === undefined || input.reason === undefined) {
      throw new Error("No-show admin operator and reason are required");
    }

    const { operatorId, reason } = validateNoShowAdminAction({
      operatorId: input.operatorId,
      reason: input.reason,
    });

    if (squareEnv === null) {
      // Provider is disabled; still persist the admin audit locally so the
      // manual follow-up is attributed. Load the record first so replays and
      // concurrent requests do not overwrite an existing audit.
      const existingRecord = await repository.getNoShowChargeRecordById(
        input.noShowChargeRecordId,
      );

      if (existingRecord === null) {
        throw new Error("No-show charge record not found");
      }

      const alreadyAudited =
        existingRecord.adminActionAt !== undefined ||
        existingRecord.adminOperatorId !== undefined ||
        existingRecord.adminReason !== undefined ||
        existingRecord.adminEligibilityCheckedAt !== undefined;

      if (alreadyAudited) {
        return {
          appointmentId: input.appointmentId,
          chargeStatus: "manual_followup",
          noShowChargeRecordId: input.noShowChargeRecordId,
        };
      }

      // If audit persistence fails (missing record or race condition), the
      // catch block returns charge_failed instead of reporting manual_followup.
      await repository.recordNoShowAdminAction({
        noShowChargeRecordId: input.noShowChargeRecordId,
        operatorId,
        reason,
        now,
      });

      return {
        appointmentId: input.appointmentId,
        chargeStatus: "manual_followup",
        noShowChargeRecordId: input.noShowChargeRecordId,
      };
    }

    const squareInvoices = createSquareClient({
      environment: squareEnv.environment,
      accessToken: squareEnv.accessToken,
    });
    const alerts = createAlerts({});

    const commandResult = await chargeNoShowInvoice(
      {
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
        noShowChargeRecordId: input.noShowChargeRecordId,
        operatorId,
        reason,
      },
      {
        repository,
        squareInvoices,
        alerts,
      },
    );

    return {
      appointmentId: input.appointmentId,
      chargeStatus: commandResult.chargeStatus,
      noShowChargeRecordId: commandResult.noShowChargeRecordId,
    };
  } catch (error) {
    logError("[admin:no-show] Default charge command failed", {
      appointmentId: input.appointmentId,
      noShowChargeRecordId: input.noShowChargeRecordId,
      error: error instanceof Error ? error.message : "unknown",
    });

    return {
      appointmentId: input.appointmentId,
      chargeStatus: "charge_failed",
      noShowChargeRecordId: input.noShowChargeRecordId,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
