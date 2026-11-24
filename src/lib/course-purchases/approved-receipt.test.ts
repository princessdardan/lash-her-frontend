import assert from "node:assert/strict";
import { test } from "node:test";
import { COURSE_RECEIPT_AND_TERMS_SUBJECT, renderCourseAgreement, renderCourseReceipt } from "./receipt";

test("the sale confirmation uses the approved wording and a protected Academy link", (t) => {
  const previousOrigin = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://staging.lashher.com";
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousOrigin;
  });

  const date = new Date("2026-11-23T14:00:00Z");
  const order = {
    id: "order-1",
    courseTitle: "Lash & Brow <Basics>",
    billing: {
      name: "A&B Buyer",
      line1: "10 Fixture Street",
      city: "Toronto",
      region: "ON",
      postalCode: "M5V 1A1",
      country: "CA",
    },
    chargedAt: date,
    termsAcceptedAt: date,
    purchaseTerms: {
      version: "course-terms-ca-on-v1",
      text: "You are buying access to Lash & Brow <Basics>.",
    },
    receiptSeller: {
      name: "Lash Her by Nataliea Inc.",
      address: "646 Oakwood Avenue, Toronto, ON",
      email: "lashher@lashher.com",
    },
    taxBreakdown: [{ taxCode: "hst", label: "HST", amount: 1300, ratePartsPerMillion: 130000 }],
    taxCents: 1300,
    totalCents: 11300,
    disclosure: "Prices are in Canadian dollars before tax.",
  };
  const html = renderCourseReceipt(order);

  assert.equal(COURSE_RECEIPT_AND_TERMS_SUBJECT, "Your Lash Her course receipt and purchase terms");
  assert.match(html, /^<p>Hi A&amp;B,<\/p>/);
  assert.ok(html.includes("We received your payment for <strong>Lash &amp; Brow &lt;Basics&gt;</strong>."));
  assert.ok(html.includes('href="https://staging.lashher.com/sign-in?callbackUrl=%2Facademy"'));
  assert.ok(html.includes("Once your enrolment is active, you’ll see the course in your account."));
  assert.ok(html.includes("You are buying access to Lash &amp; Brow &lt;Basics&gt;."));
  assert.ok(html.includes("For help with access or this purchase, email lashher@lashher.com and include your order number."));

  const agreement = renderCourseAgreement(order, "https://squareup.com/receipt/preview/example?a=1&b=2");
  assert.match(agreement, /<h2>Your order<\/h2>/);
  assert.match(agreement, /<p>HST: CAD\s13\.00<\/p>/);
  assert.match(agreement, /<h2>Course Purchase Terms<\/h2>/);
  assert.match(agreement, /href="https:\/\/squareup\.com\/receipt\/preview\/example\?a=1&amp;b=2">View your Square receipt/);
  assert.doesNotMatch(agreement, /<h1>Your receipt<\/h1>/);
  assert.doesNotMatch(renderCourseAgreement(order, null), /View your Square receipt/);
});
