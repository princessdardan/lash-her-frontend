import assert from "node:assert/strict";
import test from "node:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { getHelcimPaymentTransactionLockQuery } from "./transaction-lock";

test("Helcim finalization serializes globally by provider transaction ID", () => {
  const query = new PgDialect().sqlToQuery(
    getHelcimPaymentTransactionLockQuery("transaction-1"),
  );

  assert.match(query.sql, /pg_advisory_xact_lock/u);
  assert.match(query.sql, /hashtextextended/u);
  assert.deepEqual(query.params, ["course-payment:helcim:transaction-1"]);
});
