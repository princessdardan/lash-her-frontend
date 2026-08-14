import { nanoid } from "nanoid";
import { NextResponse, type NextRequest } from "next/server";
import type { CartInputItem } from "@/lib/commerce/cart";
import { MAX_CART_LINE_ITEMS } from "@/lib/commerce/cart";
import { isValidCheckoutEmail } from "@/lib/commerce/checkout-validation";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import {
  createChitChatsClient,
  ChitChatsApiError,
} from "@/lib/shipping/chitchats-client";
import {
  getChitChatsConfig,
  isChitChatsCheckoutEnabled,
} from "@/lib/shipping/config";
import {
  prepareShippingQuote,
  ShippingEligibilityError,
} from "@/lib/shipping/prepare-quote";
import { issueShippingQuoteToken } from "@/lib/shipping/quote-token";
import { selectCustomerRates } from "@/lib/shipping/rates";
import { loadShippingPolicyContext } from "@/lib/shipping/policy";
import {
  completeQuote,
  createQuoteDraft,
  listEnabledPackageProfiles,
  markQuoteUnknown,
} from "@/lib/shipping/shipment-store";
import { stripSignedLabelUrls } from "@/lib/shipping/status";
import type { ShippingRecipient } from "@/lib/shipping/types";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import { checkShippingQuoteRateLimit } from "@/lib/security/shipping-abuse-control";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import {
  assertCheckoutReadiness,
  CheckoutNotReadyError,
} from "@/lib/shipping/readiness";

export const runtime = "nodejs";
const SHIPPING_QUOTE_BODY_MAX_BYTES = 32_000;

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
    await assertCheckoutReadiness({
      destinationCountryCode: body.recipient.countryCode,
    });
  } catch (error) {
    if (error instanceof CheckoutNotReadyError) {
      return NextResponse.json(
        { error: "Shipping checkout is not ready" },
        { status: 503 },
      );
    }
    throw error;
  }
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
  const [{ loaders }, profiles, policy] = await Promise.all([
    import("@/data/loaders"),
    listEnabledPackageProfiles(),
    loadShippingPolicyContext(),
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

  let prepared;
  try {
    prepared = prepareShippingQuote({
      ...body,
      products,
      promotionCode,
      profiles,
      usShippingEnabled: config.usShippingEnabled,
    });
  } catch (error) {
    if (error instanceof ShippingEligibilityError || error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }

  const quoteToken = issueShippingQuoteToken();
  const publicReference = `lhq-${nanoid(14)}`;
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const draft = await createQuoteDraft({
    publicReference,
    quoteToken,
    quoteFingerprint: prepared.fingerprint,
    destination: body.recipient,
    packageSnapshot: prepared.packageSnapshot,
    customsLines: prepared.customsLines,
    expiresAt,
  });
  const client = createChitChatsClient(config);
  try {
    const shipment = await client.createShipment({
      recipient: body.recipient,
      packageSnapshot: prepared.packageSnapshot,
      customsLines: prepared.customsLines,
      merchandiseValueCents: prepared.merchandiseValueCents,
      orderReference: publicReference,
      signatureRequested:
        prepared.merchandiseValueCents >=
        policy.settings.signatureThresholdCents,
    });
    const rates = selectCustomerRates(
      shipment.rates ?? [],
      config.trackedPostageTypes,
      {
        atRiskValueCents: prepared.merchandiseValueCents,
        destinationCountryCode: body.recipient.countryCode,
        estimatedDeliveryAt: shipment.estimated_delivery_at,
        servicePolicies: policy.servicePolicies,
        signatureThresholdCents: policy.settings.signatureThresholdCents,
      },
    );
    if (rates.length === 0) {
      await markQuoteUnknown(draft.id, stripSignedLabelUrls(shipment));
      return NextResponse.json(
        { error: "No insured tracked service is available" },
        { status: 422 },
      );
    }
    await completeQuote({
      id: draft.id,
      providerShipmentId: shipment.id,
      providerStatus: shipment.status,
      rates,
      rawShipment: stripSignedLabelUrls(shipment),
    });
    return NextResponse.json(
      {
        quoteToken,
        fingerprint: prepared.fingerprint,
        expiresAt: expiresAt.toISOString(),
        rates: rates.map(publicRate),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const recovered = await recoverAmbiguousCreate(client, publicReference);
    if (recovered) {
      const rates = selectCustomerRates(
        recovered.rates ?? [],
        config.trackedPostageTypes,
        {
          atRiskValueCents: prepared.merchandiseValueCents,
          destinationCountryCode: body.recipient.countryCode,
          estimatedDeliveryAt: recovered.estimated_delivery_at,
          servicePolicies: policy.servicePolicies,
          signatureThresholdCents: policy.settings.signatureThresholdCents,
        },
      );
      if (rates.length > 0) {
        await completeQuote({
          id: draft.id,
          providerShipmentId: recovered.id,
          providerStatus: recovered.status,
          rates,
          rawShipment: stripSignedLabelUrls(recovered),
        });
        return NextResponse.json({
          quoteToken,
          fingerprint: prepared.fingerprint,
          expiresAt: expiresAt.toISOString(),
          rates: rates.map(publicRate),
        });
      }
    }
    await markQuoteUnknown(draft.id);
    const retryAfter =
      error instanceof ChitChatsApiError ? error.retryAfterSeconds : null;
    return NextResponse.json(
      { error: "Shipping provider is temporarily unavailable" },
      {
        status: 503,
        ...(retryAfter
          ? { headers: { "Retry-After": String(retryAfter) } }
          : {}),
      },
    );
  }
}

async function recoverAmbiguousCreate(
  client: ReturnType<typeof createChitChatsClient>,
  reference: string,
) {
  try {
    const matches = (await client.findShipments(reference)).filter(
      (shipment) => shipment.order_id === reference,
    );
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
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
