import { nanoid } from "nanoid";
import { NextResponse, type NextRequest } from "next/server";
import type { CartInputItem } from "@/lib/commerce/cart";
import { MAX_CART_LINE_ITEMS } from "@/lib/commerce/cart";
import { isValidCheckoutEmail } from "@/lib/commerce/checkout-validation";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import {
  getChitChatsConfig,
  isChitChatsCheckoutEnabled,
} from "@/lib/shipping/config";
import {
  prepareShippingQuote,
  ShippingEligibilityError,
} from "@/lib/shipping/prepare-quote";
import {
  bindShippingFingerprintToContext,
  parseShippingQuoteContextSnapshot,
  type CertifiedUsImportDisclosure,
} from "@/lib/shipping/quote-token";
import {
  createQuoteOperation,
  getQuoteOperationByToken,
  listEnabledPackageProfiles,
  type ProductShipmentRow,
} from "@/lib/shipping/shipment-store";
import type { ShippingRecipient } from "@/lib/shipping/types";
import {
  calculateProductTax,
  normalizeCanadianProvinceCode,
} from "@/lib/commerce/product-tax-policy";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import { checkShippingQuoteRateLimit } from "@/lib/security/shipping-abuse-control";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import {
  assertCheckoutReadiness,
  assertShippingQuoteContextCurrent,
  assertUsShippingContractCurrent,
  CheckoutNotReadyError,
} from "@/lib/shipping/readiness";

export const runtime = "nodejs";
const SHIPPING_QUOTE_BODY_MAX_BYTES = 32_000;

export async function GET(req: NextRequest): Promise<Response> {
  if (!isChitChatsCheckoutEnabled())
    return NextResponse.json(
      { error: "Shipping quotes are unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  const operationId = req.nextUrl.searchParams.get("operationId")?.trim();
  const quoteToken = req.nextUrl.searchParams.get("quoteToken")?.trim();
  if (!operationId || !quoteToken)
    return NextResponse.json(
      { error: "Quote operation is invalid" },
      { status: 400 },
    );
  const row = await getQuoteOperationByToken({ operationId, quoteToken });
  if (!row)
    return NextResponse.json(
      { error: "Quote operation was not found" },
      { status: 404 },
    );
  const disclosure = certifiedUsDisclosure(row.shipment);
  if (row.shipment.destination.countryCode === "US" && !disclosure)
    return NextResponse.json(
      { error: "Certified U.S. DDU terms are no longer available" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const expectedContext = parseShippingQuoteContextSnapshot(
      row.shipment.deadlinePolicySnapshot,
    );
    if (!expectedContext) {
      throw new Error("Shipping quote context snapshot is missing");
    }
    await assertShippingQuoteContextCurrent({
      destinationCountryCode: row.shipment.destination.countryCode,
      expectedContext,
      intakeLocationAttestationId: row.shipment.intakeLocationAttestationId,
    });
    if (row.shipment.destination.countryCode === "US") {
      await assertUsShippingContractCurrent({
        snapshot: row.shipment.usShippingContractSnapshot,
      });
    }
  } catch {
    return NextResponse.json(
      { error: "Shipping quote is no longer current" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (row.operation.status === "dead_letter")
    return NextResponse.json(
      {
        error: "Shipping quote could not be completed",
        status: row.operation.status,
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  if (row.operation.status !== "succeeded")
    return NextResponse.json(
      {
        operationId,
        shipmentId: row.shipment.id,
        status: row.operation.status,
        expiresAt: row.shipment.quoteExpiresAt.toISOString(),
        ...(disclosure ?? {}),
      },
      {
        status: 202,
        headers: { "Cache-Control": "no-store", "Retry-After": "2" },
      },
    );
  const quoteTax = buildQuoteTaxContext(row.shipment.destination);
  return NextResponse.json(
    {
      operationId,
      shipmentId: row.shipment.id,
      status: row.operation.status,
      quoteToken,
      fingerprint: row.shipment.quoteFingerprint,
      expiresAt: row.shipment.quoteExpiresAt.toISOString(),
      rates: row.shipment.rates.map(publicRate),
      ...(quoteTax ? { tax: quoteTax } : {}),
      ...(disclosure ?? {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Destination tax context for the checkout summary. The server owns the rate;
 * the client multiplies it by (merchandise + shipping) so the displayed total
 * matches the amount charged at order creation. Returns null when the province
 * cannot be resolved so the GET never 500s on a malformed address.
 */
function buildQuoteTaxContext(destination: {
  countryCode?: "CA" | "US";
  province: string;
}): {
  rate: number;
  name: string;
  collected: boolean;
  jurisdiction: string;
} | null {
  try {
    const quote = calculateProductTax({
      destinationCountry: destination.countryCode ?? "CA",
      destinationRegionCode: destination.province,
      taxableAmountCents: 0,
    });
    return {
      rate: quote.taxRate,
      name: quote.taxName,
      collected: quote.collected,
      jurisdiction: quote.jurisdiction,
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isChitChatsCheckoutEnabled())
    return NextResponse.json(
      { error: "Shipping quotes are unavailable" },
      { status: 503 },
    );
  const parsedJson = await readBoundedJsonBody(
    req,
    SHIPPING_QUOTE_BODY_MAX_BYTES,
  );
  if (!parsedJson.ok) {
    return NextResponse.json(
      {
        error:
          parsedJson.reason === "too_large"
            ? "Shipping quote request is too large"
            : "Invalid shipping quote request",
      },
      { status: parsedJson.reason === "too_large" ? 413 : 400 },
    );
  }
  const body = parseBody(parsedJson.value);
  if (!body)
    return NextResponse.json(
      { error: "Invalid shipping quote request" },
      { status: 400 },
    );
  try {
    const readiness = await assertCheckoutReadiness({
      destinationCountryCode: body.recipient.countryCode,
    });
    if (!readiness.quoteContext) {
      throw new CheckoutNotReadyError(["shipping_quote_context_missing"]);
    }
    return await createQuote(req, body, readiness.quoteContext);
  } catch (error) {
    if (error instanceof CheckoutNotReadyError) {
      return NextResponse.json(
        { error: "Shipping checkout is not ready" },
        { status: 503 },
      );
    }
    throw error;
  }
}

async function createQuote(
  req: NextRequest,
  body: NonNullable<ReturnType<typeof parseBody>>,
  quoteContext: import("@/lib/shipping/quote-token").ShippingQuoteContext,
): Promise<Response> {
  const limiterKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "shipping-quotes",
    subject: "all",
  });
  if (!limiterKey)
    return NextResponse.json(
      { error: "Shipping quotes are unavailable" },
      { status: 503 },
    );
  try {
    const decision = await checkShippingQuoteRateLimit({
      key: limiterKey,
      now: new Date(),
    });
    if (!decision.allowed)
      return NextResponse.json(
        { error: "Too many quote requests" },
        {
          status: 429,
          headers: { "Retry-After": String(decision.retryAfterSeconds) },
        },
      );
  } catch {
    return NextResponse.json(
      { error: "Shipping quotes are unavailable" },
      { status: 503 },
    );
  }
  const config = getChitChatsConfig();
  const productIds = [...new Set(body.items.map((item) => item.productId))];
  const [{ loaders }, profiles] = await Promise.all([
    import("@/data/loaders"),
    listEnabledPackageProfiles(),
  ]);
  const [products, promotionCode] = await Promise.all([
    loaders.getProductsByIds(productIds),
    body.promotionCode
      ? loaders.getPromotionCode(body.promotionCode)
      : Promise.resolve(null),
  ]);
  if (body.promotionCode && !promotionCode)
    return NextResponse.json(
      { error: "Invalid promotion code" },
      { status: 422 },
    );

  const preparedAt = new Date();
  let prepared;
  try {
    const usImportDisclosure = certifiedUsDisclosureFromContext(
      body.recipient.countryCode,
      quoteContext,
    );
    prepared = prepareShippingQuote({
      ...body,
      products,
      promotionCode,
      profiles,
      usShippingEnabled: config.usShippingEnabled,
      now: preparedAt,
      ...(quoteContext.usShippingContract
        ? { usShippingContract: quoteContext.usShippingContract }
        : {}),
      ...(usImportDisclosure ? { usImportDisclosure } : {}),
    });
  } catch (error) {
    if (error instanceof ShippingEligibilityError || error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }

  const quoteFingerprint = bindShippingFingerprintToContext(
    prepared.fingerprint,
    quoteContext,
  );
  const publicReference = `lhq-${nanoid(14)}`;
  const expiresAt = new Date(preparedAt.getTime() + 15 * 60_000);
  const { shipment, operation, quoteToken } = await createQuoteOperation({
    publicReference,
    quoteFingerprint,
    // Config-driven policy has no attestation rows; the uuid FK column stays
    // null. The quote is keyed by token hash + fingerprint.
    intakeLocationAttestationId: null,
    destination: body.recipient,
    packageSnapshot: prepared.packageSnapshot,
    customsLines: prepared.customsLines,
    expiresAt,
    merchandiseValueCents: prepared.merchandiseValueCents,
    quoteContextSnapshot: quoteContext,
    signatureRequested:
      prepared.merchandiseValueCents >=
      quoteContext.shippingPolicySnapshot.signatureThresholdCents,
    usShippingContractSnapshot: quoteContext.usShippingContract,
    now: preparedAt,
  });
  return NextResponse.json(
    {
      operationId: operation.id,
      shipmentId: shipment.id,
      status: operation.status,
      quoteToken,
      fingerprint: quoteFingerprint,
      expiresAt: shipment.quoteExpiresAt.toISOString(),
      ...(prepared.usImportDisclosure ?? {}),
    },
    {
      status: 202,
      headers: { "Cache-Control": "no-store", "Retry-After": "2" },
    },
  );
}

function certifiedUsDisclosureFromContext(
  countryCode: "CA" | "US",
  context: import("@/lib/shipping/quote-token").ShippingQuoteContext,
): CertifiedUsImportDisclosure | null {
  if (countryCode !== "US") return null;
  const contract = context.usShippingContract;
  if (
    contract?.importTerms !== "DDU" ||
    !contract.disclosure.version.trim() ||
    !contract.disclosure.text.trim()
  ) {
    throw new ShippingEligibilityError(
      "Certified U.S. DDU shipping terms are unavailable",
    );
  }
  return {
    usImportTerms: "DDU",
    usImportDisclosureVersion: contract.disclosure.version,
    usImportDisclosureText: contract.disclosure.text,
  };
}

function certifiedUsDisclosure(
  shipment: ProductShipmentRow,
): CertifiedUsImportDisclosure | null {
  if (shipment.destination.countryCode !== "US") return null;
  const contract = shipment.usShippingContractSnapshot;
  if (
    contract?.importTerms !== "DDU" ||
    !contract.disclosure.version.trim() ||
    !contract.disclosure.text.trim()
  )
    return null;
  return {
    usImportTerms: "DDU",
    usImportDisclosureVersion: contract.disclosure.version,
    usImportDisclosureText: contract.disclosure.text,
  };
}

function publicRate(rate: {
  id: string;
  title: string;
  carrier?: string;
  deliveryEstimate?: string;
  paymentAmountCents: number;
  insured: boolean;
  tracked: boolean;
  deliveryMaxBusinessDays?: number;
  signatureAvailable: boolean;
  signatureRequired: boolean;
}) {
  return {
    id: rate.id,
    title: rate.title,
    carrier: rate.carrier,
    deliveryEstimate: rate.deliveryEstimate,
    amountCents: rate.paymentAmountCents,
    insured: rate.insured,
    tracked: rate.tracked,
    deliveryMaxBusinessDays: rate.deliveryMaxBusinessDays,
    signatureAvailable: rate.signatureAvailable,
    signatureRequired: rate.signatureRequired,
    currency: "CAD",
  };
}

function parseBody(value: unknown): {
  items: CartInputItem[];
  promotionCode?: string;
  recipient: ShippingRecipient;
} | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.items) ||
    body.items.length > MAX_CART_LINE_ITEMS ||
    !body.customer ||
    typeof body.customer !== "object" ||
    !body.shippingAddress ||
    typeof body.shippingAddress !== "object"
  )
    return null;
  const customer = body.customer as Record<string, unknown>;
  const address = body.shippingAddress as Record<string, unknown>;
  const countryCode = normalizeCountry(address.countryCode ?? address.country);
  const items = body.items.flatMap((entry): CartInputItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (
      typeof item.productId !== "string" ||
      !Number.isInteger(item.quantity) ||
      (item.quantity as number) < 1 ||
      (item.quantity as number) > 10
    )
      return [];
    return [
      {
        productId: item.productId,
        quantity: item.quantity as number,
        ...(typeof item.variantId === "string"
          ? { variantId: item.variantId }
          : {}),
      },
    ];
  });
  const required = [
    customer.name,
    customer.email,
    customer.phone,
    address.line1,
    address.city,
    address.province,
    address.postalCode,
  ];
  if (
    !countryCode ||
    items.length !== body.items.length ||
    items.length === 0 ||
    !required.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ) ||
    typeof customer.email !== "string" ||
    !isValidCheckoutEmail(customer.email)
  )
    return null;
  const recipient: ShippingRecipient = {
    name: (customer.name as string).trim().slice(0, 120),
    email: (customer.email as string).trim().toLowerCase().slice(0, 254),
    phone: (customer.phone as string).trim().slice(0, 30),
    line1: (address.line1 as string).trim().slice(0, 120),
    ...(typeof address.line2 === "string" && address.line2.trim()
      ? { line2: address.line2.trim().slice(0, 120) }
      : {}),
    city: (address.city as string).trim().slice(0, 80),
    province: normalizeProvince(address.province as string),
    postalCode: (address.postalCode as string)
      .trim()
      .toUpperCase()
      .slice(0, 20),
    country: countryCode === "CA" ? "Canada" : "United States",
    countryCode,
  };
  if (!/^[A-Z]{2}$/.test(recipient.province)) return null;
  // Reject unknown Canadian provinces at quote time so tax is resolvable and the
  // customer gets a clean rejection rather than a hard error at payment.
  if (
    recipient.countryCode === "CA" &&
    !normalizeCanadianProvinceCode(recipient.province)
  )
    return null;
  const promotionCode = parsePromotionCodeInput(body.promotionCode);
  if (promotionCode === null) return null;
  return { items, recipient, ...(promotionCode ? { promotionCode } : {}) };
}

function normalizeCountry(value: unknown): "CA" | "US" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (["CA", "CANADA"].includes(normalized)) return "CA";
  if (
    ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(
      normalized,
    )
  )
    return "US";
  return null;
}

function normalizeProvince(value: string): string {
  const normalized = value.trim().toUpperCase();
  const names: Record<string, string> = {
    ONTARIO: "ON",
    QUEBEC: "QC",
    ALBERTA: "AB",
    "BRITISH COLUMBIA": "BC",
    MANITOBA: "MB",
    SASKATCHEWAN: "SK",
    "NOVA SCOTIA": "NS",
    "NEW BRUNSWICK": "NB",
    NEWFOUNDLAND: "NL",
    "NEWFOUNDLAND AND LABRADOR": "NL",
    "PRINCE EDWARD ISLAND": "PE",
  };
  return names[normalized] ?? normalized;
}
