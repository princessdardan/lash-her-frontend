import { timingSafeEqual } from "node:crypto";

import { getResendMarketingSyncCronSecrets } from "@/lib/env/private-checkout";
import {
  runMarketingContactSyncWorker,
  type MarketingContactSyncRunSummary,
} from "@/lib/marketing-contact/marketing-contact-sync-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MarketingContactSyncRouteDependencies {
  getCronSecrets: () => string[];
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  runWorker: (input?: {
    batchSize?: number;
    lockTtlSeconds?: number;
    now?: Date;
  }) => Promise<MarketingContactSyncRunSummary>;
}

const defaultDependencies: MarketingContactSyncRouteDependencies = {
  getCronSecrets: getConfiguredResendMarketingSyncCronSecrets,
  getNow: () => new Date(),
  logError: console.error,
  logWarn: console.warn,
  runWorker: runMarketingContactSyncWorker,
};

export const GET = createMarketingContactSyncGetHandler(defaultDependencies);

export function createMarketingContactSyncGetHandler(
  dependencies: MarketingContactSyncRouteDependencies,
): (req: Request) => Promise<Response> {
  return async function marketingContactSyncGetHandler(
    req: Request,
  ): Promise<Response> {
    const cronSecrets = dependencies.getCronSecrets();

    if (cronSecrets.length === 0) {
      dependencies.logWarn(
        "[marketing-contact-sync] Cron secret is not configured",
      );
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedCronRequest(req, cronSecrets)) {
      dependencies.logWarn(
        "[marketing-contact-sync] Unauthorized sync request",
      );
      return new Response(null, { status: 401 });
    }

    let summary: MarketingContactSyncRunSummary;

    try {
      summary = await dependencies.runWorker({ now: dependencies.getNow() });
    } catch (error) {
      dependencies.logError("[marketing-contact-sync] Worker failed", {
        error:
          error instanceof Error
            ? error.message
            : "Unknown marketing sync error",
      });

      return Response.json(
        { error: "Marketing contact sync failed" },
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

function getConfiguredResendMarketingSyncCronSecrets(): string[] {
  try {
    return getResendMarketingSyncCronSecrets();
  } catch {
    return [];
  }
}
