import assert from "node:assert/strict";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/private-db/schema";

import { buildAdminRefundQueries } from "./admin-refund-query";

const range = {
  endExclusive: new Date("2026-08-02T04:00:00.000Z"),
  start: new Date("2026-07-03T04:00:00.000Z"),
};

test("admin refund rows keep every joined customer and hold column qualified", () => {
  const db = drizzle.mock({ schema });
  const { rows } = buildAdminRefundQueries(db, { ...range, search: "" });
  const query = rows.limit(20).toSQL().sql;
  const projection = query.split(" from (select distinct on")[0] ?? "";

  assert.match(query, /left join lateral/);
  assert.match(
    projection,
    /coalesce\("admin_refund_order"\."customer_email", "admin_refund_hold"\."customer_snapshot"->>'email'\)/,
  );
  assert.match(
    projection,
    /coalesce\("admin_refund_order"\."customer_name", "admin_refund_hold"\."customer_snapshot"->>'name'\)/,
  );
  assert.match(
    query,
    /on "appointment_holds"\."id" = "booking_payment_attempts"\."hold_id"/,
  );
  assert.match(query, /"checkout_orders"\."paid_at" desc nulls last/);
  assert.doesNotMatch(query, /on "id" = "hold_id"/);
});

test("admin refund summary uses the same safe lateral lookups when searching", () => {
  const db = drizzle.mock({ schema });
  const { summary } = buildAdminRefundQueries(db, {
    ...range,
    search: "customer@example.com",
  });
  const query = summary.toSQL().sql;

  assert.equal(query.match(/left join lateral/g)?.length, 2);
  assert.match(query, /"admin_refund_hold"\."customer_snapshot"->>'email'/);
  assert.match(
    query,
    /"booking_payment_attempts"\."provider_payment_id" = "admin_completed_square_refunds"\."square_payment_id"/,
  );
});
