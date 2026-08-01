import { getPrivateDataRetentionCronSecret } from "@/lib/env/private-checkout";
import {
  PRIVATE_DATA_RETENTION_TABLE_WINDOWS,
  runPrivateDataRetentionCleanup,
  type PrivateDataRetentionCleanupSummary,
} from "@/lib/private-db/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PrivateDataRetentionDependencies {
  getCronSecret: () => string | null;
  getNow: () => Date;
  logError: typeof console.error;
  logWarn: typeof console.warn;
  runCleanup: typeof runPrivateDataRetentionCleanup;
}

const defaultDependencies: PrivateDataRetentionDependencies = {
  getCronSecret: getConfiguredPrivateDataRetentionCronSecret,
  getNow: () => new Date(),
  logError: console.error,
  logWarn: console.warn,
  runCleanup: runPrivateDataRetentionCleanup,
};

export const GET = createPrivateDataRetentionGetHandler(defaultDependencies);

export function createPrivateDataRetentionGetHandler(
  dependencies: PrivateDataRetentionDependencies,
): (req: Request) => Promise<Response> {
  return async function privateDataRetentionGetHandler(req: Request): Promise<Response> {
    const cronSecret = dependencies.getCronSecret();

    if (cronSecret === null) {
      dependencies.logWarn("[private-data-retention] Cron secret is not configured");
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedCronRequest(req, cronSecret)) {
      dependencies.logWarn("[private-data-retention] Unauthorized cleanup request");
      return new Response(null, { status: 401 });
    }

    let summary: PrivateDataRetentionCleanupSummary;

    try {
      summary = await dependencies.runCleanup({ now: dependencies.getNow() });
    } catch (error) {
      dependencies.logError("[private-data-retention] Cleanup failed", {
        error: error instanceof Error ? error.message : "Unknown retention cleanup error",
      });

      return Response.json(
        { error: "Private data retention cleanup failed" },
        { status: 503 },
      );
    }

    return Response.json({
      ok: true,
      retentionWindows: PRIVATE_DATA_RETENTION_TABLE_WINDOWS,
      ...summary,
    });
  };
}

function isAuthorizedCronRequest(req: Request, cronSecret: string): boolean {
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

function getConfiguredPrivateDataRetentionCronSecret(): string | null {
  try {
    return getPrivateDataRetentionCronSecret();
  } catch {
    return null;
  }
}
