import test from "node:test";
import assert from "node:assert/strict";

import {
  readBackupValidationConfig,
  validateBackupValidationConfig,
} from "./config";

const baseEnv = {
  DATABASE_URL: "postgres://user:pass@host/lash_her_production",
  STAGING_DATABASE_URL: "postgres://user:pass@host/lash_her_staging",
};

test("readBackupValidationConfig returns defaults when env is empty", () => {
  const config = readBackupValidationConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.gcsBucketUri, undefined);
  assert.equal(config.restoreDatabaseUrl, undefined);
  assert.equal(config.expectedRestoreDbName, undefined);
});

test("readBackupValidationConfig reads all values from env", () => {
  const config = readBackupValidationConfig({
    BACKUP_VALIDATION_ENABLED: "true",
    BACKUP_GCS_BUCKET_URI: "gs://my-bucket/backups",
    BACKUP_RESTORE_DATABASE_URL: "postgres://user:pass@host/lash_her_restore",
    BACKUP_RESTORE_EXPECTED_DB_NAME: "lash_her_restore",
  });

  assert.equal(config.enabled, true);
  assert.equal(config.gcsBucketUri, "gs://my-bucket/backups");
  assert.equal(
    config.restoreDatabaseUrl,
    "postgres://user:pass@host/lash_her_restore",
  );
  assert.equal(config.expectedRestoreDbName, "lash_her_restore");
});

test("readBackupValidationConfig handles non-true enabled values as false", () => {
  const config = readBackupValidationConfig({
    BACKUP_VALIDATION_ENABLED: "yes",
  });

  assert.equal(config.enabled, false);
});

test("validateBackupValidationConfig passes when disabled regardless of other values", () => {
  const result = validateBackupValidationConfig({ enabled: false }, baseEnv);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateBackupValidationConfig requires gs:// prefix for bucket URI when enabled", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "s3://my-bucket",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
      expectedRestoreDbName: "lash_her_restore",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "INVALID_BUCKET_URI",
    ),
  );
});

test("validateBackupValidationConfig requires bucket URI when enabled", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
      expectedRestoreDbName: "lash_her_restore",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "MISSING_BUCKET_URI",
    ),
  );
});

test("validateBackupValidationConfig requires restore database URL when enabled", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      expectedRestoreDbName: "lash_her_restore",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "MISSING_RESTORE_DATABASE_URL",
    ),
  );
});

test("validateBackupValidationConfig requires expected restore DB name when enabled", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "MISSING_EXPECTED_DB_NAME",
    ),
  );
});

test("validateBackupValidationConfig rejects restore URL matching DATABASE_URL", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: baseEnv.DATABASE_URL,
      expectedRestoreDbName: "lash_her_production",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "RESTORE_URL_MATCHES_PRODUCTION",
    ),
  );
});

test("validateBackupValidationConfig rejects restore URL matching STAGING_DATABASE_URL", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: baseEnv.STAGING_DATABASE_URL,
      expectedRestoreDbName: "lash_her_staging",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e: { code: string }) => e.code === "RESTORE_URL_MATCHES_STAGING",
    ),
  );
});

test("validateBackupValidationConfig requires expected DB name to match parsed DB name from restore URL", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
      expectedRestoreDbName: "wrong_name",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e: { code: string }) => e.code === "DB_NAME_MISMATCH"),
  );
});

test("validateBackupValidationConfig requires expected DB name to include restore or backup_validation", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_test",
      expectedRestoreDbName: "lash_her_test",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e: { code: string }) => e.code === "UNSAFE_DB_NAME"),
  );
});

test("validateBackupValidationConfig accepts backup_validation in DB name", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl:
        "postgres://user:pass@host/lash_her_backup_validation",
      expectedRestoreDbName: "lash_her_backup_validation",
    },
    baseEnv,
  );

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateBackupValidationConfig accepts restore in DB name", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
      expectedRestoreDbName: "lash_her_restore",
    },
    baseEnv,
  );

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateBackupValidationConfig returns all applicable errors", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "s3://bad",
      restoreDatabaseUrl: baseEnv.DATABASE_URL,
      expectedRestoreDbName: "production",
    },
    baseEnv,
  );

  assert.equal(result.valid, false);
  const codes = result.errors.map((e: { code: string }) => e.code);
  assert.ok(codes.includes("INVALID_BUCKET_URI"));
  assert.ok(codes.includes("RESTORE_URL_MATCHES_PRODUCTION"));
  assert.ok(codes.includes("DB_NAME_MISMATCH"));
  assert.ok(codes.includes("UNSAFE_DB_NAME"));
});

test("validateBackupValidationConfig handles missing DATABASE_URL and STAGING_DATABASE_URL", () => {
  const result = validateBackupValidationConfig(
    {
      enabled: true,
      gcsBucketUri: "gs://my-bucket/backups",
      restoreDatabaseUrl: "postgres://user:pass@host/lash_her_restore",
      expectedRestoreDbName: "lash_her_restore",
    },
    {},
  );

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});
