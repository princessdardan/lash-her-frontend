import "server-only";

import type { CreateTemplateOptions } from "resend";

import {
  BOOKING_CONFIRMATION_EMAIL_SUBJECT,
  buildBookingConfirmationFallbackHtml,
  getBookingConfirmationSeedTemplateVariables,
  type SendBookingConfirmationInput,
} from "@/lib/booking/email";
import {
  PRODUCT_ORDER_CONFIRMATION_EMAIL_SUBJECT,
  buildProductOrderConfirmationHtml,
  getProductOrderTemplateVariables,
  type SendProductOrderConfirmationEmailInput,
} from "@/lib/commerce/product-order-email";
import {
  TRAINING_PAYMENT_CUSTOMER_EMAIL_SUBJECT,
  getAdminTrainingPaymentHtml,
  getCustomerTrainingPaymentHtml,
  getTrainingPaymentTemplateVariables,
  type SendTrainingPaymentNotificationEmailsInput,
} from "@/lib/commerce/training-payment-email";
import {
  buildFormEmailFallbackHtml,
  getFormEmailSubject,
  getFormEmailTemplateVariables,
  type ContactPopupData,
  type FormEmailAudience,
  type FormType,
  type GeneralInquiryData,
  type TrainingContactData,
} from "@/lib/email";
import { createResendTemplate, publishResendTemplate, type ResendEmailTemplateKey } from "@/lib/resend-platform";
import {
  EMAIL_PROFILE_IMAGE_HTML_VARIABLE,
  escapeHtml,
  getEmailProfileImageHtml,
  getEmailProfileImageTemplateVariables,
} from "@/lib/transactional-email";

export type ResendSeedTemplateVariable = NonNullable<CreateTemplateOptions["variables"]>[number];

export type ResendSeedTemplatePayload = CreateTemplateOptions & {
  html: string;
  name: string;
  subject: string;
  variables: ResendSeedTemplateVariable[];
};

export interface ResendSeedTemplateDefinition {
  envVar: string;
  key: ResendEmailTemplateKey;
  payload: ResendSeedTemplatePayload;
}

export interface ResendSeedTemplateResult {
  envVar: string;
  id: string;
  key: ResendEmailTemplateKey;
  name: string;
}

export interface ResendTemplateSeedDependencies {
  createTemplate(input: ResendSeedTemplatePayload): Promise<{ id: string }>;
  publishTemplate(id: string): Promise<{ id: string }>;
}

export interface SeedResendTemplatesOptions {
  apply?: boolean;
  dependencies?: ResendTemplateSeedDependencies;
  log?: (message: string) => void;
}

const TEMPLATE_ENV_BY_KEY: Record<ResendEmailTemplateKey, string> = {
  booking_confirmation: "RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID",
  contact_popup_admin: "RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID",
  contact_popup_customer: "RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID",
  general_inquiry_admin: "RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID",
  general_inquiry_customer: "RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID",
  product_confirmation: "RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID",
  training_contact_admin: "RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID",
  training_contact_customer: "RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID",
  training_payment_admin: "RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID",
  training_payment_customer: "RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID",
};

const TEMPLATE_NAME_BY_KEY: Record<ResendEmailTemplateKey, string> = {
  booking_confirmation: "Lash Her booking confirmation",
  contact_popup_admin: "Lash Her contact popup admin notification",
  contact_popup_customer: "Lash Her contact popup customer reply",
  general_inquiry_admin: "Lash Her general inquiry admin notification",
  general_inquiry_customer: "Lash Her general inquiry customer reply",
  product_confirmation: "Lash Her product order confirmation",
  training_contact_admin: "Lash Her training contact admin notification",
  training_contact_customer: "Lash Her training contact customer reply",
  training_payment_admin: "Lash Her training payment admin notification",
  training_payment_customer: "Lash Her training payment customer confirmation",
};

const RESEND_TEMPLATE_SEED_REQUEST_INTERVAL_MS = 350;
const RESEND_TEMPLATE_SEED_RATE_LIMIT_RETRY_MS = 1_500;
const RESEND_TEMPLATE_SEED_RATE_LIMIT_RETRIES = 3;
const RESEND_TEMPLATE_PROFILE_IMAGE_PLACEHOLDER_URL = "https://assets.lashher.test/email-profile-placeholder.jpg";

const SAMPLE_GENERAL_INQUIRY: GeneralInquiryData = {
  consentText: "I agree to receive Lash Her updates.",
  email: "client.general@example.com",
  instagram: "clientgeneral",
  marketingConsent: true,
  message: "I would love to book a full set and learn more about availability next month.",
  name: "Avery General",
  phone: "+1 555 010 1000",
  sourcePath: "/contact",
};

const SAMPLE_TRAINING_CONTACT: TrainingContactData = {
  consentText: "I agree to receive Lash Her training updates.",
  email: "student.training@example.com",
  instagram: "studenttraining",
  location: "Toronto, ON",
  marketingConsent: true,
  name: "Morgan Student",
  phone: "+1 555 010 2000",
  privacyPolicyConsent: true,
  programSlug: "classic-lash-training",
  programTitle: "Classic Lash Training",
  sourcePath: "/training-programs/classic-lash-training",
};

const SAMPLE_CONTACT_POPUP: ContactPopupData = {
  consentText: "I agree to receive occasional Lash Her updates.",
  email: "subscriber.popup@example.com",
  instagram: "subscriberpopup",
  name: "Riley Popup",
  sourcePath: "/contact-popup",
  variant: "fullContact",
};

const SAMPLE_SUBMITTED_AT = new Date("2026-06-15T14:30:00.000Z");

const SAMPLE_BOOKING_CONFIRMATION: SendBookingConfirmationInput = {
  bookingTypeLabel: "Volume Lash Fill",
  email: "booking.client@example.com",
  holdId: "hold_sample_123",
  name: "Jordan Booking",
  orderId: "LH-BOOKING-1001",
  paymentProvider: "square",
  start: new Date("2026-06-15T15:30:00.000Z"),
  timezone: "America/Toronto",
};

const SAMPLE_PRODUCT_CONFIRMATION: SendProductOrderConfirmationEmailInput = {
  currency: "cad",
  customerEmail: "product.client@example.com",
  customerName: "Taylor Product",
  lineItems: [
    {
      description: "Lash Aftercare Kit",
      productId: "product-aftercare-kit",
      quantity: 1,
      sku: "SAFE-AFTERCARE-KIT",
      totalCents: 6400,
      unitPriceCents: 6400,
    },
  ],
  orderId: "LH-PRODUCT-1001",
  shippingAddress: {
    city: "Toronto",
    country: "CA",
    line1: "100 Sample Street",
    line2: "Suite 5",
    postalCode: "M5V 1A1",
    province: "ON",
  },
  totalAmount: 64,
};

const SAMPLE_TRAINING_PAYMENT: SendTrainingPaymentNotificationEmailsInput = {
  customerEmail: "paid.student@example.com",
  customerName: "Casey Training",
  orderId: "LH-TRAINING-1001",
  paymentProvider: "helcim",
  programTitle: "Classic Lash Training",
  schedulingUrl: "https://lashher.com/training/schedule/sample-token",
};

export function buildResendTemplateDefinitions(): ResendSeedTemplateDefinition[] {
  return [
    buildBookingDefinition(),
    buildFormDefinition("contact_popup_admin", "admin", "contact-popup", SAMPLE_CONTACT_POPUP),
    buildFormDefinition("contact_popup_customer", "customer", "contact-popup", SAMPLE_CONTACT_POPUP),
    buildFormDefinition("general_inquiry_admin", "admin", "general-inquiry", SAMPLE_GENERAL_INQUIRY),
    buildFormDefinition("general_inquiry_customer", "customer", "general-inquiry", SAMPLE_GENERAL_INQUIRY),
    buildProductDefinition(),
    buildFormDefinition("training_contact_admin", "admin", "training-contact", SAMPLE_TRAINING_CONTACT),
    buildFormDefinition("training_contact_customer", "customer", "training-contact", SAMPLE_TRAINING_CONTACT),
    buildTrainingPaymentAdminDefinition(),
    buildTrainingPaymentCustomerDefinition(),
  ];
}

export async function seedResendTemplates({
  apply = false,
  dependencies,
  log = console.log,
}: SeedResendTemplatesOptions = {}): Promise<ResendSeedTemplateResult[]> {
  const definitions = buildResendTemplateDefinitions();

  printTemplateSummary(definitions, log);

  if (!apply) {
    log("Dry run only. Re-run with --apply to create and publish these templates in Resend.");
    return [];
  }

  if (dependencies === undefined && !process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when running with --apply");
  }

  const resend = dependencies ?? getDefaultResendTemplateSeedDependencies();
  const requestIntervalMs = dependencies === undefined ? RESEND_TEMPLATE_SEED_REQUEST_INTERVAL_MS : 0;
  const results: ResendSeedTemplateResult[] = [];

  log("Creating and publishing Resend templates. Copy each UUID line as it appears:");

  for (const definition of definitions) {
    log(`Creating ${definition.payload.name}...`);
    const created = await runResendTemplateSeedRequest(() => resend.createTemplate(definition.payload));
    await waitForResendTemplateSeedRateLimit(requestIntervalMs);
    await runResendTemplateSeedRequest(() => resend.publishTemplate(created.id));
    const result = {
      envVar: definition.envVar,
      id: created.id,
      key: definition.key,
      name: definition.payload.name,
    };

    results.push(result);
    log(`${result.envVar}=${result.id}`);
    await waitForResendTemplateSeedRateLimit(requestIntervalMs);
  }

  log("Created and published Resend templates.");

  return results;
}

async function runResendTemplateSeedRequest<T>(request: () => Promise<T>): Promise<T> {
  let attempts = 0;

  while (true) {
    try {
      return await request();
    } catch (error) {
      if (attempts >= RESEND_TEMPLATE_SEED_RATE_LIMIT_RETRIES || !isRateLimitError(error)) {
        throw error;
      }

      attempts += 1;
      await waitForResendTemplateSeedRateLimit(RESEND_TEMPLATE_SEED_RATE_LIMIT_RETRY_MS);
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /429|rate limit|too many requests/i.test(error.message);
}

function waitForResendTemplateSeedRateLimit(delayMs: number): Promise<void> {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function buildBookingDefinition(): ResendSeedTemplateDefinition {
  return buildDefinition({
    html: buildTemplateHtmlWithProfileImageVariable(() => buildBookingConfirmationFallbackHtml(SAMPLE_BOOKING_CONFIRMATION)),
    key: "booking_confirmation",
    subject: BOOKING_CONFIRMATION_EMAIL_SUBJECT,
    variables: getBookingConfirmationSeedTemplateVariables(SAMPLE_BOOKING_CONFIRMATION),
  });
}

function buildProductDefinition(): ResendSeedTemplateDefinition {
  return buildDefinition({
    html: buildTemplateHtmlWithProfileImageVariable(() => buildProductOrderConfirmationHtml(SAMPLE_PRODUCT_CONFIRMATION)),
    key: "product_confirmation",
    subject: PRODUCT_ORDER_CONFIRMATION_EMAIL_SUBJECT,
    variables: getProductOrderTemplateVariables(SAMPLE_PRODUCT_CONFIRMATION),
  });
}

function buildTrainingPaymentAdminDefinition(): ResendSeedTemplateDefinition {
  return buildDefinition({
    html: buildTemplateHtmlWithProfileImageVariable(() => getAdminTrainingPaymentHtml(SAMPLE_TRAINING_PAYMENT)),
    key: "training_payment_admin",
    subject: `Training paid — scheduling pending — ${SAMPLE_TRAINING_PAYMENT.orderId}`,
    variables: getTrainingPaymentTemplateVariables(SAMPLE_TRAINING_PAYMENT),
  });
}

function buildTrainingPaymentCustomerDefinition(): ResendSeedTemplateDefinition {
  return buildDefinition({
    html: buildTemplateHtmlWithProfileImageVariable(() => getCustomerTrainingPaymentHtml(SAMPLE_TRAINING_PAYMENT)),
    key: "training_payment_customer",
    subject: TRAINING_PAYMENT_CUSTOMER_EMAIL_SUBJECT,
    variables: getTrainingPaymentTemplateVariables(SAMPLE_TRAINING_PAYMENT),
  });
}

function buildFormDefinition(
  key: ResendEmailTemplateKey,
  audience: FormEmailAudience,
  formType: FormType,
  sample: GeneralInquiryData | TrainingContactData | ContactPopupData,
): ResendSeedTemplateDefinition {
  return buildDefinition({
    html: buildTemplateHtmlWithProfileImageVariable(() => buildFormEmailFallbackHtml(audience, formType, sample)),
    key,
    subject: getFormEmailSubject(audience, formType, sample),
    variables: getFormEmailTemplateVariables(formType, sample, SAMPLE_SUBMITTED_AT),
  });
}

function buildTemplateHtmlWithProfileImageVariable(buildHtml: () => string): string {
  const previousProfileImageUrl = process.env.EMAIL_PROFILE_IMAGE_URL;

  process.env.EMAIL_PROFILE_IMAGE_URL = RESEND_TEMPLATE_PROFILE_IMAGE_PLACEHOLDER_URL;

  try {
    const profileImageHtml = getEmailProfileImageHtml();

    return buildHtml().split(profileImageHtml).join(`{{{${EMAIL_PROFILE_IMAGE_HTML_VARIABLE}}}}`);
  } finally {
    if (previousProfileImageUrl === undefined) {
      delete process.env.EMAIL_PROFILE_IMAGE_URL;
    } else {
      process.env.EMAIL_PROFILE_IMAGE_URL = previousProfileImageUrl;
    }
  }
}

function buildDefinition(input: {
  html: string;
  key: ResendEmailTemplateKey;
  subject: string;
  variables: Record<string, unknown>;
}): ResendSeedTemplateDefinition {
  const templateVariables = {
    ...input.variables,
    ...getEmailProfileImageTemplateVariables(),
  };
  const html = replaceSampleValuesWithTemplateVariables(input.html, templateVariables);
  const subject = replaceSampleValuesWithTemplateVariables(input.subject, templateVariables);
  const variables = getVariablesUsedByHtml(`${html}\n${subject}`, templateVariables);

  return {
    envVar: TEMPLATE_ENV_BY_KEY[input.key],
    key: input.key,
    payload: {
      html,
      name: TEMPLATE_NAME_BY_KEY[input.key],
      subject,
      variables,
    },
  };
}

function replaceSampleValuesWithTemplateVariables(html: string, variables: Record<string, unknown>): string {
  let output = html.replace(/Received on [^<]+/g, "Received on {{{SUBMITTED_AT}}}");
  const replacements = getSampleReplacementCandidates(variables)
    .filter((replacement) => replacement.value.length > 0)
    .sort((left, right) => right.value.length - left.value.length);

  for (const replacement of replacements) {
    output = output.split(replacement.value).join(`{{{${replacement.key}}}}`);
  }

  return output;
}

function getSampleReplacementCandidates(variables: Record<string, unknown>): { key: string; value: string }[] {
  const candidates: { key: string; value: string }[] = [];

  for (const [key, value] of Object.entries(variables)) {
    const normalized = toVariableFallbackValue(value);

    if (normalized === undefined) {
      continue;
    }

    for (const candidate of getValueReplacementCandidates(key, normalized)) {
      candidates.push({ key, value: candidate });
    }
  }

  return candidates;
}

function getValueReplacementCandidates(key: string, value: number | string): string[] {
  if (typeof value === "number") {
    return [];
  }

  const candidates = new Set<string>([
    value,
    escapeHtml(value),
    encodeURIComponent(value),
  ]);

  if (key.includes("PHONE")) {
    const telValue = value.trim().replace(/[^+\d]/g, "");

    candidates.add(telValue);
    candidates.add(encodeURIComponent(telValue));
  }

  return Array.from(candidates);
}

function getVariablesUsedByHtml(html: string, variables: Record<string, unknown>): ResendSeedTemplateVariable[] {
  return Object.entries(variables)
    .filter(([key]) => html.includes(`{{{${key}}}}`))
    .map(([key, value]) => toTemplateVariableDefinition(key, value))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function toTemplateVariableDefinition(key: string, value: unknown): ResendSeedTemplateVariable {
  const fallbackValue = toRequiredVariableFallbackValue(key, value);

  if (typeof fallbackValue === "number") {
    return {
      fallbackValue,
      key,
      type: "number",
    };
  }

  return {
    fallbackValue,
    key,
    type: "string",
  };
}

function toRequiredVariableFallbackValue(key: string, value: unknown): number | string {
  const fallbackValue = toVariableFallbackValue(value);

  if (fallbackValue === undefined) {
    throw new Error(`Missing fallback value for Resend template variable ${key}`);
  }

  return fallbackValue;
}

function toVariableFallbackValue(value: unknown): number | string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value instanceof Date) {
    return value.toLocaleString("en-US", {
      dateStyle: "full",
      timeStyle: "short",
    });
  }

  return JSON.stringify(value);
}

function printTemplateSummary(definitions: ResendSeedTemplateDefinition[], log: (message: string) => void): void {
  log(`Prepared ${definitions.length} Resend template payloads.`);

  for (const definition of definitions) {
    log(`${definition.payload.name}`);
    log(`  key: ${definition.key}`);
    log(`  subject: ${definition.payload.subject}`);
    log(`  variables: ${definition.payload.variables.map((variable) => variable.key).join(", ")}`);
    log(`  env: ${definition.envVar}`);
  }
}

function getDefaultResendTemplateSeedDependencies(): ResendTemplateSeedDependencies {
  return {
    createTemplate: (input) => createResendTemplate(toCreateTemplateOptions(input)),
    publishTemplate: publishResendTemplate,
  };
}

function toCreateTemplateOptions(input: ResendSeedTemplatePayload): CreateTemplateOptions {
  return {
    html: input.html,
    name: input.name,
    subject: input.subject,
    variables: input.variables.map(toCreateTemplateVariable),
  };
}

function toCreateTemplateVariable(
  variable: ResendSeedTemplateVariable,
): NonNullable<CreateTemplateOptions["variables"]>[number] {
  if (variable.type === "number") {
    return {
      fallbackValue: variable.fallbackValue,
      key: variable.key,
      type: "number",
    };
  }

  return {
    fallbackValue: variable.fallbackValue,
    key: variable.key,
    type: "string",
  };
}
