import { log } from "@/lib/logging/logger";
import {
  readBackupValidationConfig,
  validateBackupValidationConfig,
  type BackupValidationConfig,
  type BackupValidationConfigResult,
} from "@/lib/backup-validation/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BackupValidationDependencies {
  getCronSecret: () => string | null;
  log: typeof log;
  readConfig: () => BackupValidationConfig;
  validateConfig: (
    config: BackupValidationConfig,
  ) => BackupValidationConfigResult;
}

const defaultDependencies: BackupValidationDependencies = {
  getCronSecret: getConfiguredCronSecret,
  log,
  readConfig: () => readBackupValidationConfig(process.env),
  validateConfig: (config) =>
    validateBackupValidationConfig(config, {
      DATABASE_URL: process.env.DATABASE_URL,
      STAGING_DATABASE_URL: process.env.STAGING_DATABASE_URL,
    }),
};

export const GET = createBackupValidationGetHandler(defaultDependencies);

export function createBackupValidationGetHandler(
  dependencies: BackupValidationDependencies,
): (req: Request) => Promise<Response> {
  return async function backupValidationGetHandler(
    req: Request,
  ): Promise<Response> {
    const cronSecret = dependencies.getCronSecret();

    if (cronSecret === null) {
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedCronRequest(req, cronSecret)) {
      return new Response(null, { status: 401 });
    }

    const config = dependencies.readConfig();

    dependencies.log("info", "Backup validation cron started", {
      validationPerformed: config.enabled,
    });

    if (!config.enabled) {
      return Response.json({
        validationPerformed: false,
        manualActionRequired: true,
        checkoutOrders: "future_health_check_table",
      });
    }

    const validation = dependencies.validateConfig(config);

    if (!validation.valid) {
      const codes = validation.errors.map((e) => e.code);

      dependencies.log("error", "Backup validation config invalid", {
        codes,
      });

      return Response.json(
        {
          error: "Backup validation configuration is invalid",
          codes,
          manualActionRequired: true,
        },
        { status: 503 },
      );
    }

    dependencies.log("info", "Backup validation config safe; scaffold only", {
      scaffoldStatus: "external_restore_runner_required",
    });

    return Response.json({
      validationPerformed: false,
      manualActionRequired: true,
      checkoutOrders: "future_health_check_table",
      scaffoldStatus: "external_restore_runner_required",
    });
  };
}

function isAuthorizedCronRequest(req: Request, cronSecret: string): boolean {
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

function getConfiguredCronSecret(): string | null {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret === undefined || secret.trim().length === 0) {
      return null;
    }
    return secret;
  } catch {
    return null;
  }
}
