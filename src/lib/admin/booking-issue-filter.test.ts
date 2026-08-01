import assert from "node:assert/strict";
import test from "node:test";

import { PgDialect } from "drizzle-orm/pg-core";

import {
  getBookingIssueFilter,
  getCapturedBookingPaymentExistsExpression,
} from "./booking-issue-filter";

test("booking issue filter includes captured and refunded attempt evidence", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(getCapturedBookingPaymentExistsExpression());

  assert.match(query.sql, /from "booking_payment_attempts"/);
  assert.match(
    query.sql,
    /"booking_payment_attempts"\."status" in \('captured', 'refunded'\)/,
  );
});

test("booking issue filter retains finalization states and stale capture review", () => {
  const dialect = new PgDialect();
  const now = new Date("2035-01-15T15:30:00.000Z");
  const query = dialect.sqlToQuery(getBookingIssueFilter(now));
  const normalizedParams = query.params.map((param) =>
    param instanceof Date ? param.toISOString() : param,
  );

  assert.equal(
    normalizedParams.includes("paid_unbookable_rebooking_pending"),
    true,
  );
  assert.equal(normalizedParams.includes("refund_required"), true);
  assert.equal(normalizedParams.includes("manual_review"), true);
  assert.equal(normalizedParams.includes("paid_calendar_pending"), true);
  assert.equal(normalizedParams.includes("failed"), true);
  assert.equal(normalizedParams.includes("captured"), false);
  assert.equal(normalizedParams.includes("2035-01-15T15:15:00.000Z"), true);
  assert.match(query.sql, /"booking_payment_attempts"\."status" in/);
  assert.match(query.sql, /"appointments"\."id" is null/);
  assert.match(
    query.sql,
    /"appointment_holds"\."booking_confirmation_email_sent_at" is null/,
  );
  assert.match(
    query.sql,
    /"appointment_holds"\."booking_confirmation_email_last_error" is not null/,
  );
});
