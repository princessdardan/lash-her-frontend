import assert from "node:assert/strict";
import test from "node:test";

import { createPrivateDbPoolConfig } from "./pool-config";

test("private DB pool config preserves strict SSL when DATABASE_URL has no sslmode", () => {
  const config = createPrivateDbPoolConfig("postgres://user:pass@example.com:5432/db");

  assert.deepEqual(config, {
    connectionString: "postgres://user:pass@example.com:5432/db",
    ssl: { rejectUnauthorized: true },
  });
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
    connectionString: "postgres://user:pass@example.com:5432/db?sslmode=verify-full",
  });
});
