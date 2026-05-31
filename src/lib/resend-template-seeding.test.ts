import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getBookingConfirmationSeedTemplateVariables } from "./src/lib/booking/email.ts";
  import { getProductOrderTemplateVariables } from "./src/lib/commerce/product-order-email.ts";
  import { getTrainingPaymentTemplateVariables } from "./src/lib/commerce/training-payment-email.ts";
  import {
    buildResendTemplateDefinitions,
    seedResendTemplates,
  } from "./src/lib/resend-template-seeding.ts";
  import { getFormEmailTemplateVariables } from "./src/lib/email.ts";
  import { toResendTemplateVariables } from "./src/lib/resend-platform.ts";

  function findDefinition(definitions, key) {
    const found = definitions.find((definition) => definition.key === key);

    assert.ok(found, "Expected definition for " + key);

    return found;
  }

  function findVariable(definition, key) {
    const found = definition.payload.variables.find((variable) => variable.key === key);

    assert.ok(found, "Expected variable " + key + " in " + definition.key);

    return found;
  }
`;

test("Resend seed payloads include template metadata, placeholders, and variable definitions", () => {
  runResendTemplateSeedScenario(`
    const definitions = buildResendTemplateDefinitions();

    assert.equal(definitions.length, 10);
    assert.deepEqual(definitions.map((definition) => definition.key), [
      "booking_confirmation",
      "contact_popup_admin",
      "contact_popup_customer",
      "general_inquiry_admin",
      "general_inquiry_customer",
      "product_confirmation",
      "training_contact_admin",
      "training_contact_customer",
      "training_payment_admin",
      "training_payment_customer",
    ]);

    const booking = findDefinition(definitions, "booking_confirmation");
    assert.equal(booking.envVar, "RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID");
    assert.equal(booking.payload.name, "Lash Her booking confirmation");
    assert.equal(booking.payload.subject, "Your Lash Her booking is confirmed");
    assert.equal(booking.payload.html.includes("{{{CUSTOMER_NAME}}}"), true);
    assert.equal(booking.payload.html.includes("{{{BOOKING_TYPE_LABEL}}}"), true);
    assert.equal(booking.payload.html.includes("Jordan Booking"), false);
    assert.deepEqual(findVariable(booking, "CUSTOMER_NAME"), {
      fallbackValue: "Jordan Booking",
      key: "CUSTOMER_NAME",
      type: "string",
    });

    const generalInquiryAdmin = findDefinition(definitions, "general_inquiry_admin");
    assert.equal(generalInquiryAdmin.envVar, "RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID");
    assert.equal(generalInquiryAdmin.payload.subject, "🔔 New General Inquiry from {{{CUSTOMER_NAME}}}");
    assert.equal(generalInquiryAdmin.payload.html.includes("{{{MESSAGE}}}"), true);
    assert.equal(generalInquiryAdmin.payload.html.includes("{{{SUBMITTED_AT}}}"), true);
    assert.equal(generalInquiryAdmin.payload.html.includes("tel:{{{CUSTOMER_PHONE}}}"), false);
    assert.equal(generalInquiryAdmin.payload.html.includes("{{{CUSTOMER_PHONE_TEL_HREF}}}"), true);
    assert.deepEqual(findVariable(generalInquiryAdmin, "SUBMITTED_AT"), {
      fallbackValue: "Monday, June 15, 2026 at 10:30 AM",
      key: "SUBMITTED_AT",
      type: "string",
    });

    const contactPopupAdmin = findDefinition(definitions, "contact_popup_admin");
    assert.equal(contactPopupAdmin.envVar, "RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID");
    assert.equal(contactPopupAdmin.payload.html.includes("{{{SOURCE_PATH}}}"), true);
    assert.equal(contactPopupAdmin.payload.html.includes("/contact-popup"), false);

    const product = findDefinition(definitions, "product_confirmation");
    assert.equal(product.envVar, "RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID");
    assert.equal(product.payload.subject, "Your Lash Her order is confirmed");
    assert.equal(product.payload.html.includes("{{{LINE_ITEMS_HTML}}}"), true);
    assert.equal(product.payload.html.includes("{{{SHIPPING_ADDRESS_HTML}}}"), true);
    assert.equal(product.payload.html.includes("{{{ITEM_COUNT}}}"), false);
    assert.equal(product.payload.html.includes("Lash Aftercare Kit"), false);
    assert.equal(findVariable(product, "LINE_ITEMS_HTML").type, "string");

    const trainingAdmin = findDefinition(definitions, "training_payment_admin");
    assert.equal(trainingAdmin.envVar, "RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID");
    assert.equal(trainingAdmin.payload.subject, "Training paid — scheduling pending — {{{ORDER_ID}}}");
    assert.equal(trainingAdmin.payload.html.includes("paid — scheduling pending"), true);
    assert.equal(trainingAdmin.payload.html.includes("{{{CUSTOMER_EMAIL}}}"), true);

    const trainingCustomer = findDefinition(definitions, "training_payment_customer");
    assert.equal(trainingCustomer.envVar, "RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID");
    assert.equal(trainingCustomer.payload.html.includes("{{{SCHEDULING_URL}}}"), true);
  `);
});

test("Resend template dry-run prints summaries without calling Resend", () => {
  runResendTemplateSeedScenario(`
    const calls = [];
    const logs = [];
    const results = await seedResendTemplates({
      dependencies: {
        createTemplate: async () => {
          calls.push("create");
          return { id: "should-not-create" };
        },
        publishTemplate: async () => {
          calls.push("publish");
          return { id: "should-not-publish" };
        },
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(results, []);
    assert.deepEqual(calls, []);
    assert.equal(logs.some((message) => message.includes("Prepared 10 Resend template payloads.")), true);
    assert.equal(logs.some((message) => message.includes("RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID")), true);
    assert.equal(logs.some((message) => message.includes("Dry run only")), true);
  `);
});

test("runtime form template variables avoid seeded sample fallbacks", () => {
  runResendTemplateSeedScenario(`
    const submittedAt = new Date("2026-06-15T14:30:00.000Z");
    const contactPopupVariables = toResendTemplateVariables(getFormEmailTemplateVariables("contact-popup", {
      email: "visitor@example.com",
      variant: "emailOnly",
    }, submittedAt));

    assert.equal(contactPopupVariables.CUSTOMER_EMAIL, "visitor@example.com");
    assert.equal(contactPopupVariables.CUSTOMER_FIRST_NAME, "there");
    assert.equal(contactPopupVariables.CUSTOMER_INSTAGRAM, "");
    assert.equal(contactPopupVariables.CUSTOMER_NAME, "a visitor");
    assert.equal(contactPopupVariables.SOURCE_PATH, "");
    assert.equal(contactPopupVariables.SUBMITTED_AT, "Monday, June 15, 2026 at 10:30 AM");
    assert.equal(Object.values(contactPopupVariables).includes("Riley Popup"), false);
    assert.equal(Object.values(contactPopupVariables).includes("subscriberpopup"), false);

    const generalInquiryVariables = toResendTemplateVariables(getFormEmailTemplateVariables("general-inquiry", {
      email: "client@example.com",
      message: "Please send availability.",
      name: "Avery Client",
    }, submittedAt));

    assert.equal(generalInquiryVariables.CUSTOMER_INSTAGRAM, "");
    assert.equal(generalInquiryVariables.CUSTOMER_PHONE, "");
    assert.equal(generalInquiryVariables.CUSTOMER_PHONE_TEL_HREF, "");
    assert.equal(generalInquiryVariables.SOURCE_PATH, "");
    assert.equal(generalInquiryVariables.SUBMITTED_AT, "Monday, June 15, 2026 at 10:30 AM");
    assert.equal(Object.values(generalInquiryVariables).includes("clientgeneral"), false);
    assert.equal(Object.values(generalInquiryVariables).includes("+1 555 010 1000"), false);

    const trainingVariables = toResendTemplateVariables(getFormEmailTemplateVariables("training-contact", {
      email: "student@example.com",
      name: "Morgan Student",
      phone: "+1 555 999 0000",
      programSlug: "classic-lash-training",
      programTitle: "Classic Lash Training",
    }, submittedAt));

    assert.equal(trainingVariables.CUSTOMER_INSTAGRAM, "Not provided");
    assert.equal(trainingVariables.LOCATION, "Not provided");
    assert.equal(trainingVariables.SOURCE_PATH, "/training-programs/classic-lash-training");
    assert.equal(trainingVariables.SUBMITTED_AT, "Monday, June 15, 2026 at 10:30 AM");
    assert.equal(Object.values(trainingVariables).includes("studenttraining"), false);
    assert.equal(Object.values(trainingVariables).includes("Toronto, ON"), false);
  `);
});

test("runtime template variables escape user-submitted dashboard values", () => {
  runResendTemplateSeedScenario(`
    const submittedAt = new Date("2026-06-15T14:30:00.000Z");
    const formVariables = toResendTemplateVariables(getFormEmailTemplateVariables("general-inquiry", {
      email: "client+<tag>@example.com",
      instagram: "@client<script>",
      message: "I need <strong>help</strong> & pricing.",
      name: "Avery <Client>",
      phone: "+1 <555> 010",
      sourcePath: "/contact?ref=<ad>&utm=1",
    }, submittedAt));

    assert.equal(formVariables.CUSTOMER_EMAIL, "client+&lt;tag&gt;@example.com");
    assert.equal(formVariables.CUSTOMER_FIRST_NAME, "Avery");
    assert.equal(formVariables.CUSTOMER_INSTAGRAM, "@client&lt;script&gt;");
    assert.equal(formVariables.CUSTOMER_NAME, "Avery &lt;Client&gt;");
    assert.equal(formVariables.CUSTOMER_PHONE, "+1 &lt;555&gt; 010");
    assert.equal(formVariables.CUSTOMER_PHONE_TEL_HREF, "tel:%2B1555010");
    assert.equal(formVariables.MESSAGE, "I need &lt;strong&gt;help&lt;/strong&gt; &amp; pricing.");
    assert.equal(formVariables.SOURCE_PATH, "/contact?ref=&lt;ad&gt;&amp;utm=1");

    const bookingVariables = toResendTemplateVariables(getBookingConfirmationSeedTemplateVariables({
      bookingTypeLabel: "Volume <Fill>",
      email: "booking+<tag>@example.com",
      holdId: "hold_<123>",
      name: "Jordan <Booking>",
      orderId: "LH-<BOOKING>",
      paymentProvider: "square",
      start: new Date("2026-06-15T15:30:00.000Z"),
      timezone: "America/Toronto",
    }));

    assert.equal(bookingVariables.BOOKING_TYPE_LABEL, "Volume &lt;Fill&gt;");
    assert.equal(bookingVariables.CUSTOMER_EMAIL, "booking+&lt;tag&gt;@example.com");
    assert.equal(bookingVariables.CUSTOMER_NAME, "Jordan &lt;Booking&gt;");
    assert.equal(bookingVariables.ORDER_ID, "LH-&lt;BOOKING&gt;");

    const productVariables = toResendTemplateVariables(getProductOrderTemplateVariables({
      currency: "cad",
      customerEmail: "product+<tag>@example.com",
      customerName: "Taylor <Product>",
      lineItems: [{
        description: "Aftercare <Kit>",
        productId: "product-1",
        quantity: 1,
        sku: "SKU-1",
        totalCents: 6400,
        unitPriceCents: 6400,
      }],
      orderId: "LH-<PRODUCT>",
      shippingAddress: {
        city: "Toronto",
        country: "CA",
        line1: "100 <Sample> Street",
        line2: "Suite & 5",
        postalCode: "M5V 1A1",
        province: "ON",
      },
      totalAmount: 64,
    }));

    assert.equal(productVariables.CUSTOMER_EMAIL, "product+&lt;tag&gt;@example.com");
    assert.equal(productVariables.CUSTOMER_NAME, "Taylor &lt;Product&gt;");
    assert.equal(productVariables.ORDER_ID, "LH-&lt;PRODUCT&gt;");
    assert.equal(productVariables.LINE_ITEMS_HTML.includes("Aftercare &lt;Kit&gt;"), true);
    assert.equal(productVariables.SHIPPING_ADDRESS_HTML.includes("100 &lt;Sample&gt; Street"), true);
    assert.equal(productVariables.SHIPPING_ADDRESS_HTML.includes("Suite &amp; 5"), true);

    const trainingVariables = toResendTemplateVariables(getTrainingPaymentTemplateVariables({
      customerEmail: "student+<tag>@example.com",
      customerName: "Casey <Training>",
      orderId: "LH-<TRAINING>",
      paymentProvider: "helcim",
      programTitle: "Classic <Lash> Training",
      schedulingUrl: "https://lashher.com/schedule?token=<secret>&step=1",
    }));

    assert.equal(trainingVariables.CUSTOMER_EMAIL, "student+&lt;tag&gt;@example.com");
    assert.equal(trainingVariables.CUSTOMER_NAME, "Casey &lt;Training&gt;");
    assert.equal(trainingVariables.ORDER_ID, "LH-&lt;TRAINING&gt;");
    assert.equal(trainingVariables.PROGRAM_TITLE, "Classic &lt;Lash&gt; Training");
    assert.equal(trainingVariables.SCHEDULING_URL, "https://lashher.com/schedule?token=&lt;secret&gt;&amp;step=1");
  `);
});

test("Resend template apply mode creates then publishes and prints env mappings", () => {
  runResendTemplateSeedScenario(`
    const calls = [];
    const logs = [];
    const ids = [];
    const results = await seedResendTemplates({
      apply: true,
      dependencies: {
        createTemplate: async (input) => {
          const id = "00000000-0000-4000-8000-" + String(ids.length + 1).padStart(12, "0");

          ids.push(id);
          calls.push({ name: input.name, type: "create", variables: input.variables.length });

          return { id };
        },
        publishTemplate: async (id) => {
          calls.push({ id, type: "publish" });
          return { id };
        },
      },
      log: (message) => logs.push(message),
    });

    assert.equal(results.length, 10);
    assert.equal(calls.length, 20);
    assert.deepEqual(calls.slice(0, 4).map((call) => call.type), ["create", "publish", "create", "publish"]);
    assert.equal(calls[1].id, results[0].id);
    assert.equal(calls[0].name, "Lash Her booking confirmation");
    assert.equal(calls[0].variables > 0, true);
    assert.equal(logs.some((message) => message === "RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID=" + results[0].id), true);
    assert.equal(logs.some((message) => message === "RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID=" + results[9].id), true);
  `);
});

function runResendTemplateSeedScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.TZ = "America/Toronto";
  delete env.EMAIL_PROFILE_IMAGE_URL;
  delete env.RESEND_API_KEY;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
