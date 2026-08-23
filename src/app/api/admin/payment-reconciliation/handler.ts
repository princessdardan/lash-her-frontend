import { timingSafeEqual } from "node:crypto";

import { getPaymentReconciliationCronSecrets } from "@/lib/env/private-checkout";
import runServiceReconciliationMonitor, {
  type ServiceReconciliationSummary,
} from "@/lib/booking/payments/service-reconciliation-monitor";
import { retryOperationalBookingOutcomeEmails } from "@/lib/booking/email";
import { runSquareCommerceCaptureReconciliation } from "@/lib/commerce/square-commerce-capture-reconciliation";
import { runSquareSupplementalObligationCaptureReconciliation } from "@/lib/commerce/square-supplemental-capture-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PaymentReconciliationDependencies {
  getCronSecrets: () => string[];
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  retryBookingOutcomeEmails?: typeof retryOperationalBookingOutcomeEmails;
  runMonitor: typeof runServiceReconciliationMonitor;
  runCommerceCaptureReconciliation?: typeof runSquareCommerceCaptureReconciliation;
  runSupplementalObligationCaptureReconciliation?: typeof runSquareSupplementalObligationCaptureReconciliation;
}

const defaultDependencies: PaymentReconciliationDependencies = {
  getCronSecrets: getConfiguredPaymentReconciliationCronSecrets,
  getNow: () => new Date(),
  logError: console.error,
  logWarn: console.warn,
  retryBookingOutcomeEmails: retryOperationalBookingOutcomeEmails,
  runMonitor: runServiceReconciliationMonitor,
  runCommerceCaptureReconciliation: runSquareCommerceCaptureReconciliation,
  runSupplementalObligationCaptureReconciliation:
    runSquareSupplementalObligationCaptureReconciliation,
};

export const GET = createPaymentReconciliationGetHandler(defaultDependencies);

export function createPaymentReconciliationGetHandler(
  dependencies: PaymentReconciliationDependencies,
): (req: Request) => Promise<Response> {
  return async function paymentReconciliationGetHandler(
    req: Request,
  ): Promise<Response> {
    const cronSecrets = dependencies.getCronSecrets();

    if (cronSecrets.length === 0) {
      dependencies.logWarn(
        "[payment-reconciliation] Cron secret is not configured",
      );
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedCronRequest(req, cronSecrets)) {
      dependencies.logWarn(
        "[payment-reconciliation] Unauthorized reconciliation request",
      );
      return new Response(null, { status: 401 });
    }

    let summary: ServiceReconciliationSummary | null = null;
    let monitorFailed = false;
    const now = dependencies.getNow();

    try {
      summary = await dependencies.runMonitor({ now });
    } catch (error) {
      monitorFailed = true;
      dependencies.logError(
        "[payment-reconciliation] Monitor failed",
        buildReconciliationErrorContext(error),
      );
    }

    await retryBookingOutcomeEmailsSafely(dependencies, now);
    await reconcileCommerceCapturesSafely(dependencies, now);
    await reconcileSupplementalObligationCapturesSafely(dependencies, now);

    if (monitorFailed || summary === null) {
      return Response.json(
        { error: "Payment reconciliation failed" },
        { status: 503 },
      );
    }

    return Response.json(summary);
  };
}

async function reconcileCommerceCapturesSafely(
  dependencies: PaymentReconciliationDependencies,
  now: Date,
): Promise<void> {
  if (dependencies.runCommerceCaptureReconciliation === undefined) {
    return;
  }

  try {
    const summary = await dependencies.runCommerceCaptureReconciliation({
      now,
    });
    if (summary !== null && summary.uncollected > 0) {
      dependencies.logWarn(
        "[payment-reconciliation] Square commerce orders have uncollected funds",
        summary,
      );
    }
  } catch (error) {
    dependencies.logError(
      "[payment-reconciliation] Square commerce capture reconciliation failed",
      buildReconciliationErrorContext(error),
    );
  }
}

async function reconcileSupplementalObligationCapturesSafely(
  dependencies: PaymentReconciliationDependencies,
  now: Date,
): Promise<void> {
  if (
    dependencies.runSupplementalObligationCaptureReconciliation === undefined
  ) {
    return;
  }

  try {
    const summary =
      await dependencies.runSupplementalObligationCaptureReconciliation({
        now,
      });
    if (
      summary !== null &&
      (summary.conflict > 0 || summary.lateRefunded > 0)
    ) {
      dependencies.logWarn(
        "[payment-reconciliation] Square supplemental obligations needed manual-review outcomes",
        summary,
      );
    }
  } catch (error) {
    dependencies.logError(
      "[payment-reconciliation] Square supplemental obligation reconciliation failed",
      buildReconciliationErrorContext(error),
    );
  }
}

async function retryBookingOutcomeEmailsSafely(
  dependencies: PaymentReconciliationDependencies,
  now: Date,
): Promise<void> {
  if (dependencies.retryBookingOutcomeEmails === undefined) {
    return;
  }

  try {
    const emailRetry = await dependencies.retryBookingOutcomeEmails({ now });
    if (emailRetry.failed > 0) {
      dependencies.logWarn(
        "[payment-reconciliation] Some booking outcome emails remain retryable",
        emailRetry,
      );
    }
  } catch (error) {
    dependencies.logError(
      "[payment-reconciliation] Booking outcome email retry failed",
      buildReconciliationErrorContext(error),
    );
  }
}

function isAuthorizedCronRequest(req: Request, cronSecrets: string[]): boolean {
  const authorization = req.headers.get("authorization");

  if (authorization === null) {
    return false;
  }

  const prefix = "Bearer ";

  if (!authorization.startsWith(prefix)) {
    return false;
  }

  const token = authorization.slice(prefix.length);
  return cronSecrets.some((secret) => timingSafeStringEqual(secret, token));
}

function timingSafeStringEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function buildReconciliationErrorContext(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  const maxCauseDepth = 3;

  if (error instanceof Error) {
    context.message = sanitizeReconciliationLogValue(error.message);
    context.name = error.name;

    if ("code" in error && typeof error.code === "string") {
      context.code = error.code;
    }

    if (error.cause !== undefined) {
      context.cause =
        depth >= maxCauseDepth
          ? { message: "Nested error cause omitted" }
          : buildReconciliationErrorContext(error.cause, depth + 1);
    }
  } else {
    context.error = sanitizeReconciliationLogValue(String(error));
  }

  return context;
}

function sanitizeReconciliationLogValue(value: string): string {
  const maxLength = 2_000;
  const sanitized = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[redacted]$2")
    .replace(
      /((?:password|secret|token|authorization|api[_-]?key)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1[redacted]");

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  return `${sanitized.slice(0, maxLength)}…`;
}

function getConfiguredPaymentReconciliationCronSecrets(): string[] {
  try {
    return getPaymentReconciliationCronSecrets();
  } catch {
    return [];
  }
}
