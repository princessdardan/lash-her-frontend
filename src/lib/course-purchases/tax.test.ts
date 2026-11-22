import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCourseTax,
  courseTaxReady,
  getCourseSalesPolicy,
  rateTableRefundTax,
} from "./tax";

const billing = {
  name: "Fixture buyer",
  line1: "123 Test Street",
  city: "Toronto",
  country: "CA",
  region: "ON",
  postalCode: "M5V 1A1",
};
const classification = "fixture-course";
const standard = { taxCode: "ca-on-hst", rateBasisPoints: 1300 };

function setTable(rule: object, behavior = "exclusive") {
  process.env.COURSE_SALES_POLICY = JSON.stringify({
    version: "synthetic-rate-table-v1",
    markets: [
      {
        country: "CA",
        region: "ON",
        behavior,
        disclosure: "Synthetic test.",
        classifications: { [classification]: rule },
      },
    ],
  });
}

test("the rate table quotes and snapshots inclusive or exclusive CAD tax without a provider", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected tax API call"));
  const salesPolicy = process.env.COURSE_SALES_POLICY;
  const stripeKey = process.env.COURSE_STRIPE_TAX_SECRET_KEY;
  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  t.after(() => {
    if (salesPolicy === undefined) delete process.env.COURSE_SALES_POLICY;
    else process.env.COURSE_SALES_POLICY = salesPolicy;
    if (stripeKey === undefined) delete process.env.COURSE_STRIPE_TAX_SECRET_KEY;
    else process.env.COURSE_STRIPE_TAX_SECRET_KEY = stripeKey;
    if (squareEnvironment === undefined) delete process.env.SQUARE_ENVIRONMENT;
    else process.env.SQUARE_ENVIRONMENT = squareEnvironment;
  });
  delete process.env.COURSE_STRIPE_TAX_SECRET_KEY;
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  setTable(standard);
  assert.equal(courseTaxReady(), true);
  const exclusive = getCourseSalesPolicy(billing, classification);
  const quote = await calculateCourseTax("order-1", 10000, billing, exclusive);
  assert.equal(quote.totalCents, 11300);
  assert.equal(quote.taxCents, 1300);
  assert.equal(quote.taxCalculation, "rate-table:order-1");
  assert.deepEqual(quote.taxBreakdown, [
    {
      amount: 1300,
      taxability_reason: "standard_rated",
      jurisdiction: { country: "CA", state: "ON" },
      rate_basis_points: 1300,
    },
  ]);

  assert.throws(
    () => getCourseSalesPolicy({ ...billing, region: "QC" }, classification),
    { status: 422 },
  );
  assert.throws(() => getCourseSalesPolicy(billing, "another-course"), {
    status: 422,
  });
  await assert.rejects(
    calculateCourseTax("order-too-large", 2_147_483_647, billing, exclusive),
    { status: 422 },
  );
  setTable(standard, "inclusive");
  const inclusive = getCourseSalesPolicy(billing, classification);
  assert.notEqual(inclusive.hash, exclusive.hash);
  const included = await calculateCourseTax("order-2", 11300, billing, inclusive);
  assert.equal(included.taxCents, 1300);
  assert.equal(included.totalCents, 11300);

  setTable({ ...standard, rateBasisPoints: 0 });
  assert.equal(courseTaxReady(), false);
  setTable({ ...standard, rateBasisPoints: 1300.5 });
  assert.equal(courseTaxReady(), false);
  setTable({ ...standard, rateBasisPoints: 0, zeroReason: "zero_rated" });
  assert.equal(courseTaxReady(), true);
  const zero = await calculateCourseTax(
    "order-3",
    10000,
    billing,
    getCourseSalesPolicy(billing, classification),
  );
  assert.equal(zero.taxCents, 0);
  assert.equal(zero.taxBreakdown[0].taxability_reason, "zero_rated");

  setTable(standard);
  delete process.env.SQUARE_ENVIRONMENT;
  assert.equal(courseTaxReady(), false);
  process.env.SQUARE_ENVIRONMENT = "production";
  process.env.COURSE_STRIPE_TAX_SECRET_KEY = "fixture-stripe-key";
  assert.equal(courseTaxReady(), false);
  assert.throws(() => getCourseSalesPolicy(billing, classification), {
    status: 503,
  });

  setTable({ taxCode: "txcd_30011000" });
  assert.equal(courseTaxReady(), true);
  assert.equal(getCourseSalesPolicy(billing, classification).taxCode, "txcd_30011000");
});

test("partial refunds reverse exactly the original tax at the final refund", () => {
  assert.equal(rateTableRefundTax(1300, 11300, 0, 300), 35);
  assert.equal(rateTableRefundTax(1300, 11300, 300, 11000), 1265);
  const pennies = [0, 1, 2].map((refunded) =>
    rateTableRefundTax(1, 3, refunded, 1),
  );
  assert.deepEqual(pennies, [0, 1, 0]);
  assert.equal(rateTableRefundTax(0, 10000, 0, 10000), 0);
  assert.throws(() => rateTableRefundTax(1300, 11300, 300, 11001), {
    status: 502,
  });
});
