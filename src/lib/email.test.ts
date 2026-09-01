import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import {
    buildContactPopupOfferEmailFallbackHtml,
    deliverContactPopupOfferEmail,
    getContactPopupOfferEmailTemplateVariables,
    getFormEmailTemplateVariables,
    sendUserConfirmation,
  } from "./src/lib/email.ts";

  const offerPayload = {
    appliesTo: "all",
    ctaLabel: "Shop <now>",
    ctaUrl: "https://lashher.com/shop?offer=<welcome>&source=popup",
    customerName: "Riley <Subscriber>",
    discountAmount: 20,
    discountType: "percentage",
    offerLabel: "Take <20%> off & enjoy",
    offerTerms: "One use per customer & exclusions apply.",
    promotionCode: "WELCOME<20>",
    promotionId: "promotion-1",
    promotionRevision: "revision-1",
    recipientEmail: "subscriber@example.com",
    resolvedAt: "2026-08-31T18:00:00.000Z",
    submissionId: "00000000-0000-4000-8000-000000000001",
    variant: "fullContact",
  };
`;

test("contact popup offer variables and fallback HTML escape editor-controlled values", () => {
  runEmailScenario(`
    const unsubscribeUrl = "https://lashher.com/api/marketing/unsubscribe?token=opaque&source=<email>";
    const variables = getContactPopupOfferEmailTemplateVariables(
      offerPayload,
      unsubscribeUrl,
    );
    const html = buildContactPopupOfferEmailFallbackHtml(
      offerPayload,
      unsubscribeUrl,
    );

    assert.equal(variables.CUSTOMER_FIRST_NAME, "Riley");
    assert.equal(variables.DISCOUNT_CODE, "WELCOME&lt;20&gt;");
    assert.equal(variables.DISCOUNT_CTA_LABEL, "Shop &lt;now&gt;");
    assert.equal(
      variables.DISCOUNT_CTA_URL,
      "https://lashher.com/shop?offer=%3Cwelcome%3E&amp;source=popup",
    );
    assert.equal(variables.DISCOUNT_LABEL, "Take &lt;20%&gt; off &amp; enjoy");
    assert.equal(
      variables.DISCOUNT_TERMS,
      "One use per customer &amp; exclusions apply.",
    );
    assert.equal(variables.SIGNUP_OFFER_HTML.includes("WELCOME&lt;20&gt;"), true);
    assert.equal(variables.SIGNUP_OFFER_HTML.includes("Unsubscribe"), true);
    assert.equal(
      variables.SIGNUP_OFFER_HTML.includes("source=&lt;email&gt;"),
      true,
    );
    assert.equal(html.includes("Take &lt;20%&gt; off &amp; enjoy"), true);
    assert.equal(html.includes("WELCOME<20>"), false);
    assert.equal(html.includes('href="https://lashher.com/shop?offer=%3Cwelcome%3E&amp;source=popup"'), true);

    const genericVariables = getFormEmailTemplateVariables("contact-popup", {
      email: "generic@example.com",
      variant: "emailOnly",
    });
    assert.equal(genericVariables.SIGNUP_OFFER_HTML, "");
    assert.equal("DISCOUNT_CODE" in genericVariables, false);
  `);
});

test("contact popup offer rejects non-HTTPS CTA URLs", () => {
  runEmailScenario(`
    assert.throws(
      () => buildContactPopupOfferEmailFallbackHtml({
        ...offerPayload,
        ctaUrl: "http://lashher.com/shop",
      }),
      /must use HTTPS/,
    );
    assert.throws(
      () => getContactPopupOfferEmailTemplateVariables({
        ...offerPayload,
        ctaUrl: "not a URL",
      }),
      /valid HTTPS URL/,
    );
  `);
});

test("contact popup offer delivery uses the active template and deterministic idempotency key", () => {
  runEmailScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({
        body: JSON.parse(init.body),
        headers: Object.fromEntries(new Headers(init.headers)),
        url: String(url),
      });

      return new Response(JSON.stringify({ id: "email_offer_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    process.env.ADMIN_EMAIL = "admin@lashher.test";
    process.env.FROM_EMAIL = "Lash Her <hello@lashher.test>";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID = "template-popup-customer";

    const result = await deliverContactPopupOfferEmail({
      ...offerPayload,
      idempotencyKey: "contact-popup-offer:00000000-0000-4000-8000-000000000001",
      to: "subscriber@example.com",
    });

    assert.deepEqual(result, { id: "email_offer_123" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.html, undefined);
    assert.deepEqual(requests[0].body.template.id, "template-popup-customer");
    assert.equal(
      requests[0].body.template.variables.SIGNUP_OFFER_HTML.includes("WELCOME&lt;20&gt;"),
      true,
    );
    assert.equal(
      requests[0].body.template.variables.SIGNUP_OFFER_HTML.includes("Unsubscribe"),
      true,
    );
    assert.equal(
      requests[0].body.headers["List-Unsubscribe"].startsWith(
        "<https://lashher.test/api/marketing/unsubscribe?token=",
      ),
      true,
    );
    assert.equal(requests[0].body.headers["List-Unsubscribe"].endsWith(">"), true);
    assert.equal(
      requests[0].body.headers["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click",
    );
    assert.equal(
      requests[0].headers["idempotency-key"],
      "contact-popup-offer:00000000-0000-4000-8000-000000000001",
    );
  `);
});

test("oversized rendered offer blocks use checked-in HTML instead of exceeding Resend template-variable limits", () => {
  runEmailScenario(`
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "email_offer_fallback_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    process.env.ADMIN_EMAIL = "admin@lashher.test";
    process.env.FROM_EMAIL = "Lash Her <hello@lashher.test>";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID = "template-popup-customer";

    await deliverContactPopupOfferEmail({
      ...offerPayload,
      offerTerms: "T".repeat(2000),
      idempotencyKey: "contact-popup-offer:fallback",
      to: "subscriber@example.com",
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].template, undefined);
    assert.equal(requests[0].html.includes("T".repeat(2000)), true);
    assert.equal(requests[0].html.includes("Unsubscribe"), true);
    assert.equal(
      requests[0].headers["List-Unsubscribe"].startsWith(
        "<https://lashher.test/api/marketing/unsubscribe?token=",
      ),
      true,
    );
    assert.equal(requests[0].headers["List-Unsubscribe"].endsWith(">"), true);
    assert.equal(
      requests[0].headers["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click",
    );
  `);
});

test("generic popup delivery sends an empty offer block through the active template", () => {
  runEmailScenario(`
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "email_generic_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    process.env.ADMIN_EMAIL = "admin@lashher.test";
    process.env.FROM_EMAIL = "Lash Her <hello@lashher.test>";
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID = "template-popup-customer";

    await sendUserConfirmation("contact-popup", {
      email: "generic@example.com",
      variant: "emailOnly",
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].template.variables.SIGNUP_OFFER_HTML, "");
    assert.equal("DISCOUNT_CODE" in requests[0].template.variables, false);
    assert.equal(requests[0].headers, undefined);
  `);
});

function runEmailScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.NEXT_PUBLIC_SITE_URL = "https://lashher.test";
  env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  env.VERCEL_ENV = "preview";
  delete env.EMAIL_PROFILE_IMAGE_URL;
  delete env.RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID;

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
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
