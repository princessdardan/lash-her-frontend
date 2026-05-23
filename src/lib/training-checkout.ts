import type { TTrainingProgram } from "@/types";

export const TRAINING_CHECKOUT_TAX_RATE = 0.13;
export const TRAINING_SCHEDULING_LINK_TTL_DAYS = 14;
export const TRAINING_PAID_BOOKING_TYPE = "training-call";

export type TrainingCheckoutRequest = {
  programSlug?: string;
  programId?: string;
  customerName: string;
  customerEmail: string;
  acknowledged?: boolean;
  clientPrice?: number;
};

export type TrainingCheckoutErrorCode =
  | "missing_program"
  | "program_mismatch"
  | "checkout_unavailable"
  | "product_unavailable"
  | "invalid_currency"
  | "invalid_price"
  | "stale_client_price"
  | "cart_input_not_supported"
  | "discounts_not_supported"
  | "invalid_customer_name"
  | "invalid_customer_email";

export type TrainingCheckoutQuote = {
  programId: string;
  programSlug: string;
  programTitle: string;
  productId: string;
  productTitle: string;
  productSku: string;
  currency: "CAD";
  subtotal: number;
  tax: number;
  total: number;
  customerName: string;
  customerEmail: string;
  schedulingTtlDays: typeof TRAINING_SCHEDULING_LINK_TTL_DAYS;
  paidBookingType: typeof TRAINING_PAID_BOOKING_TYPE;
};

export type TrainingCheckoutValidationResult =
  | { ok: true; quote: TrainingCheckoutQuote }
  | { ok: false; code: TrainingCheckoutErrorCode };

export type TrainingCheckoutProduct = {
  id: string;
  title: string;
  sku: string;
  price: number;
  currency: string | undefined;
  isAvailable: boolean | undefined;
  availabilityLabel?: string;
  fulfillmentNote?: string;
};

export interface TrainingConfirmationUrlInput {
  orderId: string;
  programSlug: string;
}

export interface TrainingScheduleUrlInput {
  programSlug: string;
  schedulingToken: string;
}

export interface ServiceBookingUrlInput {
  serviceSlug: string;
}

export interface ServiceBookingConfirmationUrlInput {
  serviceSlug: string;
  orderId: string;
}

export interface ServiceBookingConfirmationResolverUrlInput {
  orderId: string;
}

export type PurchasableTrainingProgram = TTrainingProgram & {
  checkoutEnabled: true;
};

export function isTrainingPurchasable(program: TTrainingProgram | null | undefined): program is PurchasableTrainingProgram {
  if (!program) return false;
  if (!program.checkoutEnabled) return false;
  const product = getTrainingCheckoutProduct(program);
  if (!product) return false;
  if (!product.isAvailable) return false;
  if (product.currency !== "CAD") return false;
  if (!isValidTrainingPrice(product.price)) return false;
  return true;
}

export function getTrainingCheckoutProduct(
  program: TTrainingProgram | null | undefined,
): TrainingCheckoutProduct | null {
  if (!program?.checkoutEnabled) return null;

  if (!hasCompleteNativeTrainingCommerceFields(program)) return null;
  return {
    id: program._id,
    title: program.title,
    sku: program._id,
    price: typeof program.price === "number" ? program.price : Number.NaN,
    currency: program.currency,
    isAvailable: program.isAvailable,
    ...(program.availabilityLabel ? { availabilityLabel: program.availabilityLabel } : {}),
    ...(program.fulfillmentNote ? { fulfillmentNote: program.fulfillmentNote } : {}),
  };
}

export function validateTrainingCheckoutRequest(
  program: TTrainingProgram | null | undefined,
  input: unknown,
): TrainingCheckoutValidationResult {
  if (!program) return { ok: false, code: "missing_program" };

  if (!isRecord(input)) return { ok: false, code: "invalid_customer_name" };

  const programId = getOptionalString(input, "programId");
  const programSlug = getOptionalString(input, "programSlug");
  if (programId && programId !== program._id) return { ok: false, code: "program_mismatch" };
  if (programSlug && programSlug !== program.slug) return { ok: false, code: "program_mismatch" };

  if (hasCartLikeInput(input)) return { ok: false, code: "cart_input_not_supported" };
  if (hasDiscountInput(input)) return { ok: false, code: "discounts_not_supported" };

  const customerNameInput = getRequiredString(input, "customerName");
  if (customerNameInput === null) return { ok: false, code: "invalid_customer_name" };

  const customerName = normalizeCustomerName(customerNameInput);
  if (!customerName) return { ok: false, code: "invalid_customer_name" };

  const customerEmailInput = getRequiredString(input, "customerEmail");
  if (customerEmailInput === null) return { ok: false, code: "invalid_customer_email" };

  const customerEmail = normalizeCustomerEmail(customerEmailInput);
  if (!isValidCustomerEmail(customerEmail)) return { ok: false, code: "invalid_customer_email" };

  if (!program.checkoutEnabled) return { ok: false, code: "checkout_unavailable" };

  const product = getTrainingCheckoutProduct(program);
  if (!product) return { ok: false, code: "checkout_unavailable" };
  if (!product.isAvailable) return { ok: false, code: "product_unavailable" };
  if (product.currency !== "CAD") return { ok: false, code: "invalid_currency" };
  if (!isValidTrainingPrice(product.price)) return { ok: false, code: "invalid_price" };

  const clientPrice = input.clientPrice;
  if (clientPrice !== undefined && (typeof clientPrice !== "number" || !Number.isFinite(clientPrice) || moneyToCents(clientPrice) !== moneyToCents(product.price))) {
    return { ok: false, code: "stale_client_price" };
  }

  const subtotalCents = moneyToCents(product.price);
  const taxCents = Math.round(subtotalCents * TRAINING_CHECKOUT_TAX_RATE);
  const totalCents = subtotalCents + taxCents;

  return {
    ok: true,
    quote: {
      programId: program._id,
      programSlug: program.slug,
      programTitle: program.title,
      productId: product.id,
      productTitle: product.title,
      productSku: product.sku,
      currency: "CAD",
      subtotal: centsToMoney(subtotalCents),
      tax: centsToMoney(taxCents),
      total: centsToMoney(totalCents),
      customerName,
      customerEmail,
      schedulingTtlDays: TRAINING_SCHEDULING_LINK_TTL_DAYS,
      paidBookingType: TRAINING_PAID_BOOKING_TYPE,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function getRequiredString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function hasCartLikeInput(input: Record<string, unknown>): boolean {
  return input.quantity !== undefined || input.items !== undefined;
}

function hasDiscountInput(input: Record<string, unknown>): boolean {
  return input.discountCode !== undefined || input.promoCode !== undefined;
}

function isValidTrainingPrice(price: number): boolean {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
}

function hasCompleteNativeTrainingCommerceFields(program: TTrainingProgram): boolean {
  return typeof program.price === "number" && program.currency !== undefined && program.isAvailable !== undefined;
}

function moneyToCents(value: number): number {
  return Math.round(value * 100);
}

function centsToMoney(cents: number): number {
  return cents / 100;
}

function normalizeCustomerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidCustomerEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isSafeUrl(url: string): boolean {
  try {
    if (url.startsWith("#")) return true;
    if (url.startsWith("https://")) {
      new URL(url);
      return true;
    }
    return url.startsWith("/") && !url.startsWith("//");
  } catch {
    return false;
  }
}

export function getTrainingCta(program: TTrainingProgram | null | undefined): { label: string; href: string } {
  if (isTrainingPurchasable(program)) {
    return {
      label: program.checkoutCtaLabel || "Enroll Now",
      href: `/training-programs/${program.slug}/checkout`,
    };
  }

  if (
    program?.checkoutDisabledBookingCta?.label &&
    program.checkoutDisabledBookingCta.href &&
    isSafeUrl(program.checkoutDisabledBookingCta.href)
  ) {
    return {
      label: program.checkoutDisabledBookingCta.label,
      href: program.checkoutDisabledBookingCta.href,
    };
  }

  return {
    label: "Book a Call",
    href: "#contact",
  };
}

export function buildTrainingConfirmationUrl({
  orderId,
  programSlug,
}: TrainingConfirmationUrlInput): string {
  const params = new URLSearchParams({ order: orderId });

  return `/training-programs/${encodeURIComponent(programSlug)}/confirmation?${params.toString()}`;
}

export function buildTrainingScheduleUrl({
  programSlug,
  schedulingToken,
}: TrainingScheduleUrlInput): string {
  const params = new URLSearchParams({ token: schedulingToken });

  return `/training-programs/${encodeURIComponent(programSlug)}/schedule?${params.toString()}`;
}

export function buildServiceBookingUrl({ serviceSlug }: ServiceBookingUrlInput): string {
  return `/services/${encodeURIComponent(serviceSlug)}/booking`;
}

export function buildServiceBookingConfirmationUrl({
  serviceSlug,
  orderId,
}: ServiceBookingConfirmationUrlInput): string {
  const params = new URLSearchParams({ order: orderId });

  return `/services/${encodeURIComponent(serviceSlug)}/booking/confirmation?${params.toString()}`;
}

export function buildServiceBookingConfirmationResolverUrl({
  orderId,
}: ServiceBookingConfirmationResolverUrlInput): string {
  const params = new URLSearchParams({ order: orderId });

  return `/services/booking/confirmation?${params.toString()}`;
}
