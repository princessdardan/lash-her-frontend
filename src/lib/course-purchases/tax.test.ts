import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCourseTax,
  courseTaxReady,
  getCourseSalesPolicy,
  readCourseTaxComponents,
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
  assert.equal(courseTaxReady(), false);
  process.env.SQUARE_ENVIRONMENT = "sandbox";
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

test("a bound and effective Canadian policy quotes GST and QST independently", async (t) => {
  const values = {
    SQUARE_ENVIRONMENT: "production",
    SQUARE_APPLICATION_ID: "fixture-app",
    SQUARE_LOCATION_ID: "fixture-location",
    COURSE_SALES_POLICY: "",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected tax API call"));
  assert.equal(courseTaxReady(), false);
  setTable(standard);
  assert.equal(courseTaxReady(), false);

  const components = [
    { taxCode: "gst", label: "GST", ratePartsPerMillion: 50_000, registrationNumber: "fixture-gst" },
    { taxCode: "qst", label: "QST", ratePartsPerMillion: 99_750, registrationNumber: "fixture-qst" },
  ];
  const market = {
    country: "CA",
    region: "QC",
    behavior: "exclusive",
    disclosure: "Synthetic policy, for tests only.",
    classifications: { [classification]: { taxCode: "qc-course", components } },
  };
  const fixture = {
    formatVersion: 2,
    version: "synthetic-v2",
    effectiveAt: "2026-01-01T00:00:00Z",
    square: { environment: "sandbox", applicationId: "fixture-app", locationId: "fixture-location" },
    seller: { name: "Fixture Seller", address: "100 Test Street", email: "seller@example.test" },
    markets: [market],
  };
  const configure = (value: unknown) => {
    process.env.COURSE_SALES_POLICY = JSON.stringify(value);
  };
  process.env.SQUARE_ENVIRONMENT = "sandbox";
  configure(fixture);
  assert.equal(courseTaxReady(), true);
  const quebecBilling = { ...billing, region: "QC", city: "Montréal", postalCode: "H2Y 1C6" };
  const policy = getCourseSalesPolicy(quebecBilling, classification);
  assert.deepEqual(policy.receiptSeller, fixture.seller);
  const quote = await calculateCourseTax("qc-order", 10_000, quebecBilling, policy);
  assert.equal(quote.taxCents, 1_498);
  assert.equal(quote.totalCents, 11_498);
  assert.deepEqual(readCourseTaxComponents(quote.taxBreakdown), [
    { ...components[0], amount: 500 },
    { ...components[1], amount: 998 },
  ]);
  const small = await calculateCourseTax("qc-small", 5, quebecBilling, policy);
  assert.equal(small.taxCents, 0);
  assert.equal(small.totalCents, 5);

  assert.throws(() => getCourseSalesPolicy(billing, classification), { status: 422 });
  assert.throws(
    () => getCourseSalesPolicy({ ...quebecBilling, postalCode: billing.postalCode }, classification),
    { status: 422, message: /postal code matches/ },
  );
  assert.throws(() => getCourseSalesPolicy({ ...billing, country: "US", region: "NY" }, classification), { status: 422 });
  configure({ ...fixture, version: "synthetic-v3" });
  assert.notEqual(getCourseSalesPolicy(quebecBilling, classification).hash, policy.hash);
  const withComponents = (entries: object[]) => ({
    ...market,
    classifications: { [classification]: { taxCode: "qc-course", components: entries } },
  });
  const zeroComponent = { taxCode: "gst", label: "GST", ratePartsPerMillion: 0 };
  configure({ ...fixture, markets: [withComponents([{ ...zeroComponent, zeroReason: "zero_rated" }])] });
  const zero = await calculateCourseTax(
    "zero-order",
    10_000,
    quebecBilling,
    getCourseSalesPolicy(quebecBilling, classification),
  );
  assert.equal(zero.taxBreakdown[0].taxability_reason, "zero_rated");
  assert.equal(zero.totalCents, 10_000);
  configure({ ...fixture, markets: [withComponents([
    components[0],
    { ...components[1], ratePartsPerMillion: 99_751 },
  ])] });
  assert.notEqual(getCourseSalesPolicy(quebecBilling, classification).hash, policy.hash);
  for (const candidate of [
    { ...fixture, effectiveAt: "2999-01-01T00:00:00Z" },
    { ...fixture, square: { ...fixture.square, locationId: "other-location" } },
    { ...fixture, square: { ...fixture.square, applicationId: "other-app" } },
    { ...fixture, square: { ...fixture.square, environment: "production" } },
    { ...fixture, markets: [market, market] },
    { ...fixture, markets: [{ ...market, country: "US" }] },
    { ...fixture, markets: [{ ...market, behavior: "inclusive" }] },
    { ...fixture, markets: [withComponents([components[0], components[0]])] },
    { ...fixture, markets: [withComponents([{ ...components[0], registrationNumber: undefined }])] },
    { ...fixture, markets: [withComponents([zeroComponent])] },
  ]) {
    configure(candidate);
    assert.equal(courseTaxReady(), false);
    assert.throws(() => getCourseSalesPolicy(quebecBilling, classification), { status: 503 });
  }

  process.env.SQUARE_ENVIRONMENT = "production";
  const terms = { version: "fixture-terms-v1", text: "Synthetic terms.\nRecorded course.", };
  const hst = { taxCode: "hst", label: "HST", ratePartsPerMillion: 130_000, registrationNumber: "fixture-hst" };
  const ontario = {
    ...market,
    region: "ON",
    terms,
    classifications: { [classification]: { taxCode: "on-course", components: [hst] } },
  };
  const production = {
    ...fixture,
    square: { ...fixture.square, environment: "production" },
    seller: { ...fixture.seller, phone: "(416)-555-0100" },
    markets: [ontario],
  };
  configure(production);
  assert.equal(courseTaxReady(), true);
  const quotedPolicy = getCourseSalesPolicy(billing, classification);
  assert.deepEqual(quotedPolicy.purchaseTerms, terms);
  assert.equal(quotedPolicy.receiptSeller?.phone, production.seller.phone);
  const ontarioQuote = await calculateCourseTax("on-order", 10_000, billing, quotedPolicy);
  assert.equal(ontarioQuote.totalCents, 11_300);
  assert.deepEqual(readCourseTaxComponents(ontarioQuote.taxBreakdown), [{ ...hst, amount: 1_300 }]);
  for (const phone of ["Upon Request", "(416)-55"]) {
    configure({ ...production, seller: { ...production.seller, phone } });
    assert.equal(courseTaxReady(), false);
  }
  configure(production);
  assert.throws(() => getCourseSalesPolicy(quebecBilling, classification), { status: 422 });
  configure({ ...production, markets: [{ ...ontario, terms: { ...terms, text: "Changed terms." } }] });
  assert.notEqual(getCourseSalesPolicy(billing, classification).hash, quotedPolicy.hash);
  configure({ ...production, markets: [{ ...ontario, terms: undefined }] });
  assert.equal(courseTaxReady(), false);
  configure({ ...production, markets: [ontario, { ...market, terms }] });
  assert.equal(courseTaxReady(), false);
});
