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
    updateAndPublishContactPopupCustomerTemplate,
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

    assert.equal(definitions.length, 11);
    assert.deepEqual(definitions.map((definition) => definition.key), [
      "booking_confirmation",
      "provider_booking_confirmation",
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
    assert.equal(booking.payload.html.includes("{{{ADD_ON_PAYMENT_COPY}}}"), true);
    assert.equal(booking.payload.html.includes("{{{EMAIL_PROFILE_IMAGE_HTML}}}"), true);
    assert.equal(booking.payload.html.includes("email-profile-placeholder"), false);
    assert.equal(booking.payload.html.includes("Jordan Booking"), false);
    assert.deepEqual(findVariable(booking, "CUSTOMER_NAME"), {
      fallbackValue: "Jordan Booking",
      key: "CUSTOMER_NAME",
      type: "string",
    });
    assert.deepEqual(findVariable(booking, "ADD_ON_PAYMENT_COPY"), {
      fallbackValue: '<p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Lash Bath add-on balance is due later ($25.00).</p>',
      key: "ADD_ON_PAYMENT_COPY",
      type: "string",
    });
    assert.deepEqual(findVariable(booking, "EMAIL_PROFILE_IMAGE_HTML"), {
      fallbackValue: "",
      key: "EMAIL_PROFILE_IMAGE_HTML",
      type: "string",
    });

    const providerBooking = findDefinition(definitions, "provider_booking_confirmation");
    assert.equal(providerBooking.envVar, "RESEND_TEMPLATE_PROVIDER_BOOKING_CONFIRMATION_ID");
    assert.equal(providerBooking.payload.name, "Lash Her provider booking confirmation");
    assert.equal(providerBooking.payload.subject, "New booking confirmed: {{{SERVICE_NAME}}}");
    assert.equal(providerBooking.payload.html.includes("{{{TOTAL_PAID}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{BOOKED_SUBTOTAL}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{BOOKED_TOTAL_AFTER_TAX}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{REMAINING_BALANCE}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{REMAINING_BALANCE_AFTER_TAX}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{TIP_AMOUNT}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{PAYMENT_KIND}}}"), true);
    assert.equal(providerBooking.payload.html.includes("{{{FORMATTED_START}}}"), true);

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

    const contactPopupCustomer = findDefinition(definitions, "contact_popup_customer");
    assert.equal(contactPopupCustomer.payload.html.includes("{{{SIGNUP_OFFER_HTML}}}"), true);
    assert.deepEqual(findVariable(contactPopupCustomer, "SIGNUP_OFFER_HTML"), {
      fallbackValue: "",
      key: "SIGNUP_OFFER_HTML",
      type: "string",
    });
    assert.equal(contactPopupCustomer.payload.html.includes("WELCOME20"), false);

    const product = findDefinition(definitions, "product_confirmation");
    assert.equal(product.envVar, "RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID");
    assert.equal(product.payload.subject, "{{{EMAIL_SUBJECT}}}");
    assert.deepEqual(findVariable(product, "EMAIL_SUBJECT"), {
      fallbackValue: "Your Lash Her order is confirmed",
      key: "EMAIL_SUBJECT",
      type: "string",
    });
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
    assert.equal(trainingCustomer.payload.html.includes("{{{EMAIL_PROFILE_IMAGE_HTML}}}"), true);
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
    assert.equal(logs.some((message) => message.includes("Prepared 11 Resend template payloads.")), true);
    assert.equal(logs.some((message) => message.includes("RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID")), true);
    assert.equal(logs.some((message) => message.includes("Dry run only")), true);
  `);
});

test("booking template renders no blank add-on paragraph when no add-on copy is provided", () => {
  runResendTemplateSeedScenario(`
    const booking = findDefinition(buildResendTemplateDefinitions(), "booking_confirmation");
    const variables = toResendTemplateVariables(getBookingConfirmationSeedTemplateVariables({
      bookingTypeLabel: "Volume Fill",
      email: "booking@example.com",
      holdId: "hold_123",
      name: "Jordan Booking",
      orderId: "LH-BOOKING",
      paymentProvider: "square",
      start: new Date("2026-06-15T15:30:00.000Z"),
      timezone: "America/Toronto",
    }));
    const renderedHtml = renderTemplateHtml(booking.payload.html, variables);

    assert.equal(variables.ADD_ON_PAYMENT_COPY, "");
    assert.equal(renderedHtml.includes('style="margin:0 0 22px 0;font-size:15px;line-height:1.7;"></p>'), false);
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
    assert.equal(contactPopupVariables.SIGNUP_OFFER_HTML, "");
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

    assert.equal(results.length, 11);
    assert.equal(calls.length, 22);
    assert.deepEqual(calls.slice(0, 4).map((call) => call.type), ["create", "publish", "create", "publish"]);
    assert.equal(calls[1].id, results[0].id);
    assert.equal(calls[0].name, "Lash Her booking confirmation");
    assert.equal(calls[0].variables > 0, true);
    assert.equal(logs.some((message) => message === "RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID=" + results[0].id), true);
    assert.equal(logs.some((message) => message === "RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID=" + results[10].id), true);
  `);
});

test("contact popup customer template update completes before publish", () => {
  runResendTemplateSeedScenario(`
    const calls = [];
    let published = false;
    let updatedInput;

    await updateAndPublishContactPopupCustomerTemplate({
      dependencies: {
        getTemplate: async (id) => {
          calls.push({ id, type: "get" });

          if (published) {
            return {
              id,
              name: updatedInput.name,
              status: "published",
              html: updatedInput.html,
              text: updatedInput.text,
              subject: updatedInput.subject,
              has_unpublished_versions: false,
              variables: updatedInput.variables.map(({ fallbackValue, key, type }) => ({
                fallback_value: fallbackValue,
                key,
                type,
              })),
            };
          }

          return {
            id,
            name: "Lash Her contact popup customer reply",
            status: "published",
            html: "<p>Existing popup template</p>",
            text: "Existing generic-only text",
            subject: "Welcome to Lash Her",
            has_unpublished_versions: false,
            variables: [],
          };
        },
        publishTemplate: async (id) => {
          calls.push({ id, type: "publish" });
          published = true;
          return { id };
        },
        updateTemplate: async (id, input) => {
          calls.push({ id, input, type: "update" });
          updatedInput = input;
          return { id };
        },
      },
      templateId: "  template-contact-popup-customer  ",
    });

    assert.deepEqual(calls.map(({ type }) => type), ["get", "update", "publish", "get"]);
    assert.equal(calls[1].id, "template-contact-popup-customer");
    assert.equal(calls[2].id, "template-contact-popup-customer");
    assert.equal(calls[1].input.html.includes("{{{SIGNUP_OFFER_HTML}}}"), true);
    assert.equal(calls[1].input.text, null);
    assert.equal(
      calls[1].input.variables.some(({ key, fallbackValue }) =>
        key === "SIGNUP_OFFER_HTML" && fallbackValue === ""),
      true,
    );
  `);
});

test("contact popup customer template update requires a configured template id", () => {
  runResendTemplateSeedScenario(`
    delete process.env.RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID;
    const calls = [];

    await assert.rejects(
      updateAndPublishContactPopupCustomerTemplate({
        dependencies: {
          getTemplate: async () => {
            calls.push("get");
            throw new Error("unexpected");
          },
          publishTemplate: async () => {
            calls.push("publish");
            return { id: "unexpected" };
          },
          updateTemplate: async () => {
            calls.push("update");
            return { id: "unexpected" };
          },
        },
      }),
      /RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID is required/,
    );
    assert.deepEqual(calls, []);
  `);
});

test("contact popup customer template update refuses a mismatched configured template", () => {
  runResendTemplateSeedScenario(`
    const calls = [];

    await assert.rejects(
      updateAndPublishContactPopupCustomerTemplate({
        dependencies: {
          getTemplate: async (id) => ({
            id,
            name: "Lash Her product order confirmation",
            status: "published",
            html: "<p>Product order</p>",
            text: null,
            subject: "Product order",
            has_unpublished_versions: false,
            variables: [],
          }),
          publishTemplate: async () => {
            calls.push("publish");
            return { id: "unexpected" };
          },
          updateTemplate: async () => {
            calls.push("update");
            return { id: "unexpected" };
          },
        },
        templateId: "template-wrong-purpose",
      }),
      /is not the Lash Her contact popup customer template/,
    );
    assert.deepEqual(calls, []);
  `);
});

test("contact popup customer template update refuses unsafe preflight state", () => {
  for (const state of [
    { hasUnpublishedVersions: false, status: "draft" },
    { hasUnpublishedVersions: true, status: "published" },
  ]) {
    runResendTemplateSeedScenario(`
      const calls = [];

      await assert.rejects(
        updateAndPublishContactPopupCustomerTemplate({
          dependencies: {
            getTemplate: async (id) => ({
              id,
              name: "Lash Her contact popup customer reply",
              status: ${JSON.stringify(state.status)},
              html: "<p>Existing popup template</p>",
              text: "Existing generic-only text",
              subject: "Welcome to Lash Her",
              has_unpublished_versions: ${state.hasUnpublishedVersions},
              variables: [],
            }),
            publishTemplate: async () => {
              calls.push("publish");
              return { id: "unexpected" };
            },
            updateTemplate: async () => {
              calls.push("update");
              return { id: "unexpected" };
            },
          },
          templateId: "template-contact-popup-customer",
        }),
        /is not safe to update/,
      );
      assert.deepEqual(calls, []);
    `);
  }
});

test("contact popup customer template update verifies published HTML, text, and variables", () => {
  for (const mismatch of ["html", "text", "variables"]) {
    runResendTemplateSeedScenario(`
      let getCount = 0;
      let updatedInput;

      await assert.rejects(
        updateAndPublishContactPopupCustomerTemplate({
          dependencies: {
            getTemplate: async (id) => {
              getCount += 1;

              if (getCount === 1) {
                return {
                  id,
                  name: "Lash Her contact popup customer reply",
                  status: "published",
                  html: "<p>Existing popup template</p>",
                  text: "Existing generic-only text",
                  subject: "Welcome to Lash Her",
                  has_unpublished_versions: false,
                  variables: [],
                };
              }

              const variables = updatedInput.variables.map(({ fallbackValue, key, type }) => ({
                fallback_value: fallbackValue,
                key,
                type,
              }));
              if (${JSON.stringify(mismatch)} === "variables") {
                const offerVariable = variables.find(({ key }) => key === "SIGNUP_OFFER_HTML");
                offerVariable.fallback_value = "stale offer";
              }

              return {
                id,
                name: updatedInput.name,
                status: "published",
                html: ${JSON.stringify(mismatch)} === "html" ? "<p>stale HTML</p>" : updatedInput.html,
                text: ${JSON.stringify(mismatch)} === "text" ? "stale generic text" : updatedInput.text,
                subject: updatedInput.subject,
                has_unpublished_versions: false,
                variables,
              };
            },
            publishTemplate: async (id) => ({ id }),
            updateTemplate: async (id, input) => {
              updatedInput = input;
              return { id };
            },
          },
          templateId: "template-contact-popup-customer",
        }),
        /failed verification/,
      );
    `);
  }
});

function runResendTemplateSeedScenario(assertions: string): void {
  const scenario = `${helperScript}
function renderTemplateHtml(html, variables) {
  let rendered = html;

  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.split("{{{" + key + "}}}").join(String(value));
  }

  return rendered;
}

void (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  env.TZ = "America/Toronto";
  delete env.EMAIL_PROFILE_IMAGE_URL;
  delete env.RESEND_API_KEY;

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
