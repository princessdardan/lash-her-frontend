export interface BackupValidationConfig {
  enabled: boolean;
  gcsBucketUri?: string;
  restoreDatabaseUrl?: string;
  expectedRestoreDbName?: string;
}

export interface BackupValidationConfigResult {
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
}

export function readBackupValidationConfig(
  env: Record<string, string | undefined>,
): BackupValidationConfig {
  return {
    enabled: env.BACKUP_VALIDATION_ENABLED === "true",
    gcsBucketUri: env.BACKUP_GCS_BUCKET_URI,
    restoreDatabaseUrl: env.BACKUP_RESTORE_DATABASE_URL,
    expectedRestoreDbName: env.BACKUP_RESTORE_EXPECTED_DB_NAME,
  };
}

export function validateBackupValidationConfig(
  config: BackupValidationConfig,
  env: { DATABASE_URL?: string; STAGING_DATABASE_URL?: string } = {},
): BackupValidationConfigResult {
  const errors: Array<{ code: string; message: string }> = [];

  if (!config.enabled) {
    return { valid: true, errors };
  }

  if (!config.gcsBucketUri) {
    errors.push({
      code: "MISSING_BUCKET_URI",
      message: "GCS bucket URI is required when backup validation is enabled",
    });
  } else if (!config.gcsBucketUri.startsWith("gs://")) {
    errors.push({
      code: "INVALID_BUCKET_URI",
      message: "GCS bucket URI must start with gs://",
    });
  }

  if (!config.restoreDatabaseUrl) {
    errors.push({
      code: "MISSING_RESTORE_DATABASE_URL",
      message:
        "Restore database URL is required when backup validation is enabled",
    });
  } else {
    if (config.restoreDatabaseUrl === env.DATABASE_URL) {
      errors.push({
        code: "RESTORE_URL_MATCHES_PRODUCTION",
        message: "Restore database URL must not match DATABASE_URL",
      });
    }
    if (config.restoreDatabaseUrl === env.STAGING_DATABASE_URL) {
      errors.push({
        code: "RESTORE_URL_MATCHES_STAGING",
        message: "Restore database URL must not match STAGING_DATABASE_URL",
      });
    }
  }

  if (!config.expectedRestoreDbName) {
    errors.push({
      code: "MISSING_EXPECTED_DB_NAME",
      message:
        "Expected restore database name is required when backup validation is enabled",
    });
  } else {
    const parsedDbName = parseDatabaseNameFromUrl(config.restoreDatabaseUrl);
    if (
      parsedDbName !== null &&
      config.expectedRestoreDbName !== parsedDbName
    ) {
      errors.push({
        code: "DB_NAME_MISMATCH",
        message:
          "Expected restore database name does not match the database name in the restore URL",
      });
    }

    const safeName = config.expectedRestoreDbName.toLowerCase();
    if (
      !safeName.includes("restore") &&
      !safeName.includes("backup_validation")
    ) {
      errors.push({
        code: "UNSAFE_DB_NAME",
        message:
          "Expected restore database name must include 'restore' or 'backup_validation'",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function parseDatabaseNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    // PostgreSQL URLs: postgres://user:pass@host/dbname
    // pathname will be "/dbname"
    const dbName = parsed.pathname.replace(/^\//, "");
    return dbName || null;
  } catch {
    return null;
  }
}
