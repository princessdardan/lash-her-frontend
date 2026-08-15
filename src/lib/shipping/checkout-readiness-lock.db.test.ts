import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run checkout readiness lock tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { Client } from "pg";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { lockShippingCheckoutReadinessConfiguration } from "./src/lib/shipping/readiness.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  await writer.connect();
  try {
    await getPrivateDb().transaction(async (tx) => {
      await lockShippingCheckoutReadinessConfiguration(tx);
      await writer.query("begin");
      await writer.query("set local lock_timeout = '100ms'");
      await assert.rejects(
        writer.query(
          "update fulfillment_provider_certifications set version = version where false",
        ),
        (error) => error && error.code === "55P03",
      );
      await writer.query("rollback");
    });
  } finally {
    await writer.end();
    await closePrivateDbPool();
  }
`;

test(
  "checkout commit readiness lock blocks a concurrent provider-certification mutation",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { env: process.env, stdio: "inherit" },
    );
  },
);
