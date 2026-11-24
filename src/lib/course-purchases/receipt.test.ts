import assert from "node:assert/strict";
import { test } from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { renderCourseReceipt, renderCourseRefundReceipt } from "./receipt";
import { resolveCourseReceiptDestination } from "./receipt-destination";

const capturedOrder = {
  id: "order-1",
  courseTitle: "Lash & Brow <Basics>",
  billing: { name: "Test Buyer", line1: "10 Fixture Street", city: "Toronto", region: "ON", postalCode: "M5V 1A1", country: "CA" },
  chargedAt: new Date("2026-11-23T02:15:00Z"),
  purchaseTerms: null,
  termsAcceptedAt: null,
  receiptSeller: {
    name: "Seller & Co.",
    address: "123 <Test> Street",
    email: "seller@example.com",
  },
  taxBreakdown: [
    {
      taxCode: "gst",
      label: "GST",
      amount: 500,
      ratePartsPerMillion: 50_000,
      registrationNumber: "12345 & 6789",
    },
    {
      taxCode: "qst",
      label: "QST <test>",
      amount: 998,
      ratePartsPerMillion: 99_750,
      registrationNumber: "1234567890TQ0001",
    },
  ],
  taxCents: 1498,
  totalCents: 11498,
  disclosure: "Digital access & payment terms.",
};

test("the written agreement uses the accepted order snapshot", () => {
  const html = renderCourseReceipt({
    ...capturedOrder,
    receiptSeller: { ...capturedOrder.receiptSeller, phone: "(416)-555-0100" },
    purchaseTerms: { version: "fixture-v1", text: "Recorded course only.\nAccess & support." },
    termsAcceptedAt: new Date("2026-11-23T02:10:00Z"),
  });
  assert.match(html, /Course Purchase Terms/);
  assert.match(html, /Test Buyer<br>10 Fixture Street/);
  assert.match(html, /Version fixture-v1<br>Accepted November 22, 2026/);
  assert.match(html, /Recorded course only\.<br>Access &amp; support\./);
  assert.match(html, /\(416\)-555-0100/);
  assert.throws(() => renderCourseReceipt({
    ...capturedOrder,
    purchaseTerms: { version: "fixture-v1", text: "Recorded course only." },
  }), /acceptance time/);
});

test("the course receipt displays the captured Toronto date and tax snapshot", () => {
  const html = renderCourseReceipt(capturedOrder);
  assert.match(html, /Lash &amp; Brow &lt;Basics&gt;/);
  assert.match(html, /Order order-1/);
  assert.match(html, /Payment date: November 22, 2026/);
  assert.match(html, /Subtotal: CAD\s100\.00/);
  assert.match(html, /GST: CAD\s5\.00 \(registration number 12345 &amp; 6789\)/);
  assert.match(html, /QST &lt;test&gt;: CAD\s9\.98 \(registration number 1234567890TQ0001\)/);
  assert.match(html, /Total paid: CAD\s114\.98/);
  assert.match(html, /Seller &amp; Co\.<br>123 &lt;Test&gt; Street<br>seller@example\.com/);
  assert.match(html, /Digital access &amp; payment terms\./);
});

test("zero-rated receipt lines omit a registration number when none applies", () => {
  const html = renderCourseReceipt({
    ...capturedOrder,
    taxCents: 0,
    totalCents: 10_000,
    taxBreakdown: [
      { taxCode: "gst", label: "GST", amount: 0, ratePartsPerMillion: 0 },
    ],
  });
  assert.match(html, /GST: CAD\s0\.00<\/p>/);
  assert.doesNotMatch(html, /registration number/);
});

test("one confirmed refund document contains the required credit note and original tax amounts", () => {
  const refund = { id: "refund-1", amountCents: 11498, confirmedAt: new Date("2026-11-23T03:15:00Z") };
  const allocation = {
    version: 1,
    taxTransactionId: "rate-table:order-1",
    refundId: refund.id,
    taxCents: 1498,
    fullyRefunded: true,
    components: [{ taxCode: "gst", taxCents: 500 }, { taxCode: "qst", taxCents: 998 }],
  };
  const issuedAt = new Date("2026-11-23T13:00:00Z");
  const html = renderCourseRefundReceipt(capturedOrder, refund, JSON.stringify(allocation), issuedAt);
  assert.match(html, /Course refund confirmation.*Credit note/);
  assert.match(html, /Original order order-1.*November 22, 2026/);
  assert.match(html, /Issue date: November 23, 2026/);
  assert.match(html, /GST refunded: CAD\s5\.00/);
  assert.match(html, /QST &lt;test&gt; refunded: CAD\s9\.98 \(1234567890TQ0001\)/);
  assert.match(html, /Total refunded in this transaction: CAD\s114\.98/);
  assert.match(html, /A full refund ends the access/);
  const partial = renderCourseRefundReceipt(capturedOrder, { ...refund, amountCents: 1 }, JSON.stringify({
    ...allocation,
    taxCents: 0,
    fullyRefunded: false,
    components: allocation.components.map((component) => ({ ...component, taxCents: 0 })),
  }), issuedAt);
  assert.doesNotMatch(partial, /Credit note|A full refund ends the access/);
  assert.throws(() => renderCourseRefundReceipt(capturedOrder, refund, JSON.stringify({
    ...allocation, refundId: "other-refund",
  }), issuedAt), /consistent tax allocation/);
});

test("orders without a seller snapshot preserve the original receipt body", () => {
  const dollars = (amount: number) =>
    Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      currencyDisplay: "code",
    }).format(amount / 100);
  const html = renderCourseReceipt({ ...capturedOrder, receiptSeller: null });
  assert.equal(
    html,
    `<h1>Course payment receipt</h1><p>Lash &amp; Brow &lt;Basics&gt;</p><p>Order order-1</p><p>Paid ${dollars(11498)} including tax of ${dollars(1498)}.</p><p>Digital access &amp; payment terms.</p>`,
  );
});

const qualificationTime = Date.parse("2026-11-23T19:00:00.000Z");
const qualificationScope = {
  orderId: "6911c2a4-9f70-4b54-afe1-093556e816dc",
  customerId: "03dddf83-63a0-4747-a392-059ed93cfdb0",
  courseId: "d167029b-56ce-48b1-811c-ccf470440607",
  sourceCommit: "a".repeat(40),
  expiresAt: new Date(qualificationTime + 60_000).toISOString(),
};
const qualificationOrder = {
  id: qualificationScope.orderId,
  customerId: qualificationScope.customerId,
  courseId: qualificationScope.courseId,
  email: `p408-sandbox-${qualificationScope.customerId}@example.invalid`,
};
const qualificationEnv = {
  P408_COURSE_RECEIPT_TEST: "enabled",
  P407_CHECKOUT_SCOPE_JSON: JSON.stringify(qualificationScope),
  P407_POSTGRES_RELAY_URL: "wss://api-p407.lashher.com/internal/p4-07/postgres",
  P407_POSTGRES_RELAY_DEPLOYMENT_PROOF: "1".repeat(64),
  FRONTEND_WRITER_ADMISSION_MODE: "enforce",
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
  APP_ENV: "staging",
  VERCEL_URL: "lash-her-frontend-staging-58cqxrmzm-dardan-demiris-projects.vercel.app",
  VERCEL_GIT_COMMIT_SHA: qualificationScope.sourceCommit,
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_LOCATION_ID: "LCW972G6NQNSE",
  RESEND_API_KEY: "owned-fixture",
  FROM_EMAIL: "Lash Her Staging <staging@mail.staging.lashher.com>",
  ADMIN_EMAIL: "delivered@resend.dev",
  STAGING_EMAIL_RECIPIENT_ALLOWLIST: "delivered@resend.dev",
};

test("the protected qualification routes only the selected document to the Resend simulator", () => {
  const destination = (
    kind: "receipt" | "refund_receipt",
    env: Record<string, string | undefined> = qualificationEnv,
  ) =>
    resolveCourseReceiptDestination(qualificationOrder, kind, env, qualificationTime);
  assert.equal(destination("receipt"), "delivered@resend.dev");
  assert.equal(destination("refund_receipt"), null);
  const refundScope = { ...qualificationEnv, P408_COURSE_RECEIPT_TEST: "refund" };
  assert.equal(destination("receipt", refundScope), null);
  assert.equal(destination("refund_receipt", refundScope), "delivered@resend.dev");
  const previousScope = { ...qualificationEnv, P408_COURSE_RECEIPT_TEST: undefined };
  for (const kind of ["receipt", "refund_receipt"] as const) {
    assert.equal(destination(kind, previousScope), null);
    assert.equal(resolveCourseReceiptDestination(qualificationOrder, kind, {}, qualificationTime), qualificationOrder.email);
  }
});

test("receipt qualification rejects invalid scope, sender, recipient, and fixture identity", () => {
  for (const override of [
    { P408_COURSE_RECEIPT_TEST: "false" },
    { P407_CHECKOUT_SCOPE_JSON: undefined },
    { VERCEL_URL: "lash-her-frontend-staging.vercel.app" },
    { APP_ENV: "production" },
    { SQUARE_ENVIRONMENT: "production" },
    { STAGING_EMAIL_RECIPIENT_ALLOWLIST: "delivered@resend.dev,other@example.invalid" },
    { STAGING_EMAIL_RECIPIENT_ALLOWLIST: undefined },
    { FROM_EMAIL: "another@example.invalid" },
    { ADMIN_EMAIL: "another@example.invalid" },
    { RESEND_API_KEY: undefined },
  ]) {
    assert.throws(() => resolveCourseReceiptDestination(
      qualificationOrder, "receipt", { ...qualificationEnv, ...override }, qualificationTime,
    ));
    assert.throws(() => resolveCourseReceiptDestination(
      qualificationOrder, "refund_receipt", { ...qualificationEnv, P408_COURSE_RECEIPT_TEST: "refund", ...override }, qualificationTime,
    ));
  }
  assert.throws(() => resolveCourseReceiptDestination(
    qualificationOrder, "receipt", { P408_COURSE_RECEIPT_TEST: "enabled" }, qualificationTime,
  ));
  assert.throws(() => resolveCourseReceiptDestination(
    qualificationOrder, "receipt", qualificationEnv, qualificationTime + 60_000,
  ));
  for (const override of [
    { id: qualificationScope.courseId },
    { courseId: qualificationScope.orderId },
    { customerId: qualificationScope.courseId },
    { email: "other@example.invalid" },
  ]) {
    assert.throws(() => resolveCourseReceiptDestination(
      { ...qualificationOrder, ...override }, "receipt", qualificationEnv, qualificationTime,
    ));
    assert.throws(() => resolveCourseReceiptDestination(
      { ...qualificationOrder, ...override }, "refund_receipt", { ...qualificationEnv, P408_COURSE_RECEIPT_TEST: "refund" }, qualificationTime,
    ));
  }
});
