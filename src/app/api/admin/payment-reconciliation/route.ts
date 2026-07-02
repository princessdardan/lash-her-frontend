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
      dependencies.logError("[payment-reconciliation] Monitor failed", {
        error:
          error instanceof Error
            ? error.message
            : "Unknown reconciliation error",
      });

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

function getConfiguredPaymentReconciliationCronSecrets(): string[] {
  try {
    return getPaymentReconciliationCronSecrets();
  } catch {
    return [];
  }
}
