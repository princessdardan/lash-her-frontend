import { timingSafeEqual } from "node:crypto";

import { getPaymentReconciliationCronSecrets } from "@/lib/env/private-checkout";
import runServiceReconciliationMonitor, {
  type ServiceReconciliationSummary,
} from "@/lib/booking/payments/service-reconciliation-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PaymentReconciliationDependencies {
  getCronSecrets: () => string[];
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  runMonitor: typeof runServiceReconciliationMonitor;
}

const defaultDependencies: PaymentReconciliationDependencies = {
  getCronSecrets: getConfiguredPaymentReconciliationCronSecrets,
  getNow: () => new Date(),
  logError: console.error,
  logWarn: console.warn,
  runMonitor: runServiceReconciliationMonitor,
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

    let summary: ServiceReconciliationSummary;

    try {
      summary = await dependencies.runMonitor({ now: dependencies.getNow() });
    } catch (error) {
      dependencies.logError(
        "[payment-reconciliation] Monitor failed",
        buildReconciliationErrorContext(error),
      );

      return Response.json(
        { error: "Payment reconciliation failed" },
        { status: 503 },
      );
    }

    return Response.json(summary);
  };
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
