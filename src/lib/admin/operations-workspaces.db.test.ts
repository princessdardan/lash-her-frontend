import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run operations workspace saturation tests";

const scenario =
  String.raw`
  import assert from "node:assert/strict";
  import { sql } from "drizzle-orm";
  import {
    ADMIN_FULFILLMENT_QUEUE_LIMIT,
    boundedFulfillmentQueueSelectionSql,
  } from "./src/lib/admin/fulfillment-queue-pagination.ts";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();

  try {
    const queueItemsSql = sql.raw([
      "with queue_items as (",
      "select",
      "(case when item <= 501 then 'risk' else 'refunds' end)::text as queue,",
      "item::text as id,",
      "'saturation-fixture'::text as kind,",
      "('Fixture ' || item::text)::text as title,",
      "'Queue saturation fixture'::text as detail,",
      "null::text as order_reference,",
      "(case",
      "when item <= 501 then '2026-01-01T00:00:00.000Z'::timestamptz + item * interval '1 second'",
      "else '2026-08-01T00:00:00.000Z'::timestamptz",
      "end) as deadline_at,",
      "1::int as state_version,",
      "(item::text || ':1')::text as conflict_token,",
      "array[]::text[] as evidence",
      "from generate_series(1, 502) item",
      ")",
    ].join("\n"));
    const result = await db.execute(sql.join([
      queueItemsSql,
      ` +
  "boundedFulfillmentQueueSelectionSql()" +
  String.raw`
    ], sql.raw("\n")));

    const riskRows = result.rows.filter((row) => row.queue === "risk");
    const refundRows = result.rows.filter((row) => row.queue === "refunds");

    assert.equal(riskRows.length, ADMIN_FULFILLMENT_QUEUE_LIMIT);
    assert.equal(Number(riskRows[0].queue_total), 501);
    assert.equal(Number(riskRows.at(-1).queue_position), ADMIN_FULFILLMENT_QUEUE_LIMIT);
    assert.equal(refundRows.length, 1);
    assert.equal(refundRows[0].id, "502");
    assert.equal(Number(refundRows[0].queue_total), 1);
    assert.equal(Number(refundRows[0].queue_position), 1);
  } finally {
    await closePrivateDbPool();
  }
`;

test(
  "a saturated queue cannot starve an actionable row from another queue",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--input-type=module",
        "--import",
        "tsx",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
