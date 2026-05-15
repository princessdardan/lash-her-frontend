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
  | "invalid_product_kind"
  | "product_unavailable"
  | "invalid_currency"
  | "invalid_price"
  | "variants_not_supported"
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

export interface TrainingConfirmationUrlInput {
  orderId: string;
  programSlug: string;
  schedulingToken: string;
}

export type PurchasableTrainingProgram = TTrainingProgram & {
  checkoutEnabled: true;
  checkoutProduct: NonNullable<TTrainingProgram["checkoutProduct"]>;
};

export function isTrainingPurchasable(program: TTrainingProgram | null | undefined): program is PurchasableTrainingProgram {
  if (!program) return false;
  if (!program.checkoutEnabled) return false;
  if (!program.checkoutProduct) return false;
  if (program.checkoutProduct.kind !== "training") return false;
  if (!program.checkoutProduct.isAvailable) return false;
  if (program.checkoutProduct.currency !== "CAD") return false;
  if (!isValidTrainingPrice(program.checkoutProduct.price)) return false;
  if (program.checkoutProduct.variants && program.checkoutProduct.variants.length > 0) return false;
  return true;
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

  if (!program.checkoutEnabled || !program.checkoutProduct) return { ok: false, code: "checkout_unavailable" };

  const product = program.checkoutProduct;
  if (product.kind !== "training") return { ok: false, code: "invalid_product_kind" };
  if (!product.isAvailable) return { ok: false, code: "product_unavailable" };
  if (product.currency !== "CAD") return { ok: false, code: "invalid_currency" };
  if (!isValidTrainingPrice(product.price)) return { ok: false, code: "invalid_price" };
  if (hasConfiguredChoices(product)) return { ok: false, code: "variants_not_supported" };

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
      productId: product._id,
      productTitle: product.title,
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

function hasConfiguredChoices(product: NonNullable<TTrainingProgram["checkoutProduct"]>): boolean {
  const productWithOptions = product as NonNullable<TTrainingProgram["checkoutProduct"]> & { options?: unknown };
  return Boolean(
    (product.variants && product.variants.length > 0) ||
      (Array.isArray(productWithOptions.options) && productWithOptions.options.length > 0),
  );
}

function isValidTrainingPrice(price: number): boolean {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
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
    href: "/booking?type=training-call",
  };
}

export function buildTrainingConfirmationUrl({
  orderId,
  programSlug,
  schedulingToken,
}: TrainingConfirmationUrlInput): string {
  const params = new URLSearchParams({
    order: orderId,
    token: schedulingToken,
  });

  return `/training-programs/${encodeURIComponent(programSlug)}/confirmation?${params.toString()}`;
}
