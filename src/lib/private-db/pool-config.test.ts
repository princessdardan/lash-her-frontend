import assert from "node:assert/strict";
import test from "node:test";

import { createPrivateDbPoolConfig } from "./pool-config";

const directPoolTuning = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
};

test("private DB pool config preserves strict SSL when DATABASE_URL has no sslmode", () => {
  const config = createPrivateDbPoolConfig(
    "postgres://user:pass@example.com:5432/db",
  );

  assert.deepEqual(config, {
    connectionString: "postgres://user:pass@example.com:5432/db",
    ssl: { rejectUnauthorized: true },
    ...directPoolTuning,
  });
});

test("private DB pool config bounds the pool to serverless-safe limits", () => {
  const config = createPrivateDbPoolConfig(
    "postgres://user:pass@example.com:5432/db",
  );

  assert.equal(config.max, 10);
  assert.equal(config.idleTimeoutMillis, 30_000);
  assert.equal(config.connectionTimeoutMillis, 5_000);
  assert.equal(config.allowExitOnIdle, true);
});

test("private DB pool config uses a small pool behind a transaction pooler", () => {
  const config = createPrivateDbPoolConfig(
    "postgres://user:pass@ep-cool-name-pooler.us-east-2.aws.neon.tech:5432/db?sslmode=require",
  );

  assert.equal(config.max, 3);
  assert.equal(config.connectionTimeoutMillis, 5_000);
});

test("private DB pool config honors Neon sslmode=require connection strings", () => {
  const config = createPrivateDbPoolConfig(
    "postgres://user:pass@example.com:5432/db?sslmode=require",
  );

  assert.equal(
    config.connectionString,
    "postgres://user:pass@example.com:5432/db?sslmode=require&uselibpqcompat=true",
  );
  assert.equal(config.ssl, undefined);
});

test("private DB pool config leaves explicit verify-full connection strings intact", () => {
  const config = createPrivateDbPoolConfig(
    "postgres://user:pass@example.com:5432/db?sslmode=verify-full",
  );

  assert.deepEqual(config, {
    connectionString:
      "postgres://user:pass@example.com:5432/db?sslmode=verify-full",
    ...directPoolTuning,
  });
});
