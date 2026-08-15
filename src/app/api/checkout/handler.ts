import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { log } from "@/lib/logging/logger";
import {
  buildValidatedCart,
  type CartInputItem,
  type ValidatedCart,
} from "@/lib/commerce/cart";
import { toCheckoutCatalogProduct } from "@/lib/commerce/product-catalog";
import type { UsImportTerms } from "@/lib/commerce/product-checkout-disclosures";
import { loadManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";
import {
  CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
  isValidCheckoutEmail,
  parseCheckoutText,
  parseOptionalCheckoutText,
} from "@/lib/commerce/checkout-validation";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import { ShippingQuoteConflictError } from "@/lib/shipping/errors";
import { getTrustedClientIp } from "@/lib/security/trusted-client-ip";
import { readBoundedJsonBody } from "@/lib/security/bounded-json-body";
import type { TProduct, TPromotionCode } from "@/types";

const checkoutPaymentMockStore = createPaymentMockStore();
const CHECKOUT_BODY_MAX_BYTES = 64 * 1024;

interface CheckoutCustomerInput {
  name: string;
  email: string;
  phone?: string;
}

interface CheckoutShippingAddressInput {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  countryCode?: "CA" | "US";
  phone?: string;
}

interface CheckoutRequestBody {
  customer: CheckoutCustomerInput;
  items: CartInputItem[];
  shippingAddress?: CheckoutShippingAddressInput;
  fulfillmentMode: "automated_shipping" | "manual_pickup" | "manual_shipping";
  disclosures: {
    cancellationPolicyAccepted?: boolean;
    cancellationPolicyVersion?: string;
    cancellationPolicyTextHash?: string;
    usImportTerms?: UsImportTerms;
    usImportDisclosureVersion?: string;
    usImportDisclosureText?: string;
  };
  promotionCode?: string;
  shippingQuote?: {
    token: string;
    fingerprint: string;
    rateId: string;
  };
}

type CheckoutResponseBody =
  | { checkoutToken: string }
  | { operationId: string; status: "queued" };

interface CheckoutErrorBody {
  error: string;
}

interface CheckoutErrorLog {
  cause?: CheckoutErrorLogCause;
  error: string;
  errorName?: string;
}

interface CheckoutErrorLogCause {
  code?: string;
  column?: string;
  constraint?: string;
  dataType?: string;
  schema?: string;
  severity?: string;
  table?: string;
}

interface CheckoutPostHandlerDependencies {
  getProductsByIds: (ids: string[]) => Promise<TProduct[]>;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  shippingEnabled?: boolean;
  validateShippingSelection?: (input: {
    request: CheckoutRequestBody;
    products: TProduct[];
    promotionCode: TPromotionCode | null;
  }) => Promise<string | ValidatedShippingSelection>;
  createInitializingOrder?: (input: {
    customerName: string;
    customerEmail: string;
    cart: ValidatedCart;
    shippingAddress: CheckoutShippingAddressInput;
    shippingQuoteToken: string;
    shippingQuoteFingerprint: string;
    shippingRateId: string;
    refundOriginIp: string;
    usImportDisclosure?: {
      terms: UsImportTerms;
      version: string;
      text: string;
      presentedAt: Date;
    };
  }) => Promise<{
    orderId: string;
    primaryObligationId: string;
    shippingAmountCents: number;
    totalAmountCents: number;
    shippingRateTitle: string;
  }>;
  createInitializingManualOrder?: (input: {
    customerName: string;
    customerEmail: string;
    customerPhone?: string;
    cart: ValidatedCart;
    fulfillmentMode: "manual_pickup";
    cancellationPolicy: {
      accepted: true;
      version: string;
      textHash: string;
      presentedAt: Date;
      requestEvidence: string;
    };
    refundOriginIp: string;
  }) => Promise<{
    orderId: string;
    primaryObligationId: string;
    shippingAmountCents: number;
    totalAmountCents: number;
    shippingRateTitle: string;
  }>;
  finalizeInitializingOrder?: (input: {
    orderId: string;
    checkoutToken: string;
    secretToken: string;
    helcimInvoiceId: number;
    helcimInvoiceNumber: string;
  }) => Promise<void>;
  markInitializationFailed?: (orderId: string, error: string) => Promise<void>;
  loadManualCheckoutPolicy?: typeof loadManualProductCheckoutPolicy;
}

type CheckoutInitializationStage =
  | "prepare_checkout"
  | "load_checkout_inputs"
  | "reserve_order";

interface ValidatedShippingSelection {
  fingerprint: string;
  usImportTerms?: UsImportTerms;
  usImportDisclosureVersion?: string;
  usImportDisclosureText?: string;
}

export function createCheckoutPostHandler({
  getProductsByIds,
  getPromotionCode,
  shippingEnabled,
  validateShippingSelection,
  createInitializingOrder,
  createInitializingManualOrder,
  finalizeInitializingOrder,
  markInitializationFailed,
  loadManualCheckoutPolicy = loadManualProductCheckoutPolicy,
}: CheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function checkoutPostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let stage: CheckoutInitializationStage = "prepare_checkout";
    let initializingOrderId: string | null = null;

    const parsedBody = await readBoundedJsonBody(req, CHECKOUT_BODY_MAX_BYTES);
    if (!parsedBody.ok) {
      return parsedBody.reason === "too_large"
        ? NextResponse.json(
            { error: "Checkout request body is too large" },
            { status: 413 },
          )
        : invalidCheckoutRequest();
    }
    const body = parsedBody.value;

    const checkoutRequest = parseCheckoutRequest(body);

    if (checkoutRequest === null) {
      return invalidCheckoutRequest();
    }

    try {
      const productIds = Array.from(
        new Set(checkoutRequest.items.map((item) => item.productId)),
      );
      stage = "load_checkout_inputs";
      const [products, promotionCode] = await Promise.all([
        getProductsByIds(productIds),
        checkoutRequest.promotionCode
          ? getPromotionCode(checkoutRequest.promotionCode)
          : Promise.resolve(null),
      ]);
      stage = "prepare_checkout";
      const catalogProducts = products.map(toCheckoutCatalogProduct);
      const cart = buildValidatedCart(checkoutRequest.items, catalogProducts, {
        promotionCode,
      });

      if (
        checkoutRequest.promotionCode &&
        cart.promotionCode !== checkoutRequest.promotionCode
      ) {
        return invalidPromotionCode();
      }

      const shippingWorkflowConfigured = dependenciesProvideShippingWorkflow({
        validateShippingSelection,
        createInitializingOrder,
        finalizeInitializingOrder,
      });
      const isManualCheckout = cart.checkoutMode === "manual";
      if (
        isManualCheckout &&
        checkoutRequest.fulfillmentMode === "automated_shipping"
      ) {
        return invalidFulfillmentMode();
      }
      if (
        isManualCheckout &&
        checkoutRequest.fulfillmentMode !== "manual_pickup"
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          {
            error:
              "Manual products start with free studio pickup; optional shipping is arranged after payment",
          },
          { status: 409 },
        );
      }
      if (
        !isManualCheckout &&
        checkoutRequest.fulfillmentMode !== "automated_shipping"
      ) {
        return invalidFulfillmentMode();
      }

      const manualPolicy = isManualCheckout
        ? await loadManualCheckoutPolicy()
        : null;
      if (isManualCheckout) {
        if (
          !manualPolicy?.enabled ||
          !manualPolicy.cancellationPolicyVersion ||
          !manualPolicy.cancellationPolicyTextHash ||
          checkoutRequest.disclosures.cancellationPolicyAccepted !== true ||
          checkoutRequest.disclosures.cancellationPolicyVersion !==
            manualPolicy.cancellationPolicyVersion ||
          checkoutRequest.disclosures.cancellationPolicyTextHash !==
            manualPolicy.cancellationPolicyTextHash ||
          !createInitializingManualOrder
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Manual product checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        if (checkoutRequest.shippingQuote) return invalidFulfillmentMode();
      }

      if (!isManualCheckout && shippingWorkflowConfigured && !shippingEnabled) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Product checkout is temporarily unavailable" },
          { status: 503 },
        );
      }
      if (
        !isManualCheckout &&
        shippingWorkflowConfigured &&
        (!checkoutRequest.shippingQuote || !checkoutRequest.shippingAddress)
      ) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Select a current shipping rate" },
          { status: 409 },
        );
      }
      if (!isManualCheckout && checkoutRequest.shippingAddress) {
        const isUs =
          getShippingCountryCode(checkoutRequest.shippingAddress) === "US";
        const disclosure = checkoutRequest.disclosures;
        const hasCompleteUsDisclosure = Boolean(
          disclosure.usImportTerms === "DDU" &&
          disclosure.usImportDisclosureVersion?.trim() &&
          disclosure.usImportDisclosureText?.trim(),
        );
        if (
          (isUs && !hasCompleteUsDisclosure) ||
          (!isUs &&
            (disclosure.usImportTerms ||
              disclosure.usImportDisclosureVersion ||
              disclosure.usImportDisclosureText))
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Required import-cost disclosure is missing" },
            { status: 409 },
          );
        }
      }

      let initializingOrder: Awaited<
        ReturnType<NonNullable<typeof createInitializingOrder>>
      > | null = null;
      if (isManualCheckout && createInitializingManualOrder) {
        stage = "reserve_order";
        const refundOriginIp = getTrustedClientIp(req.headers);
        if (!refundOriginIp && process.env.VERCEL_ENV === "production") {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        const manualOrder = await createInitializingManualOrder({
          customerName: checkoutRequest.customer.name,
          customerEmail: checkoutRequest.customer.email,
          ...(checkoutRequest.customer.phone
            ? { customerPhone: checkoutRequest.customer.phone }
            : {}),
          cart,
          fulfillmentMode: "manual_pickup",
          cancellationPolicy: {
            accepted: true,
            version: manualPolicy!.cancellationPolicyVersion!,
            textHash: manualPolicy!.cancellationPolicyTextHash!,
            presentedAt: new Date(),
            requestEvidence: `checkout_post:${randomUUID()}`,
          },
          refundOriginIp: refundOriginIp ?? "127.0.0.1",
        });
        initializingOrder = manualOrder;
        initializingOrderId = manualOrder.orderId;
      } else if (
        shippingEnabled &&
        validateShippingSelection &&
        createInitializingOrder &&
        finalizeInitializingOrder &&
        checkoutRequest.shippingQuote
      ) {
        const validatedSelection = normalizeValidatedShippingSelection(
          await validateShippingSelection({
            request: checkoutRequest,
            products,
            promotionCode,
          }),
        );
        const currentFingerprint = validatedSelection.fingerprint;
        if (currentFingerprint !== checkoutRequest.shippingQuote.fingerprint) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Shipping quote changed" },
            { status: 409 },
          );
        }
        if (
          getShippingCountryCode(checkoutRequest.shippingAddress!) === "US" &&
          !shippingDisclosureMatchesRequest(
            validatedSelection,
            checkoutRequest.disclosures,
          )
        ) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Required import-cost disclosure changed" },
            { status: 409 },
          );
        }
        stage = "reserve_order";
        const refundOriginIp = getTrustedClientIp(req.headers);
        if (!refundOriginIp && process.env.VERCEL_ENV === "production") {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Checkout is temporarily unavailable" },
            { status: 503 },
          );
        }
        initializingOrder = await createInitializingOrder({
          customerName: checkoutRequest.customer.name,
          customerEmail: checkoutRequest.customer.email,
          cart,
          shippingAddress: normalizeShippingAddress(
            checkoutRequest.shippingAddress!,
            checkoutRequest.customer.phone,
          ),
          shippingQuoteToken: checkoutRequest.shippingQuote.token,
          shippingQuoteFingerprint: currentFingerprint,
          shippingRateId: checkoutRequest.shippingQuote.rateId,
          refundOriginIp: refundOriginIp ?? "127.0.0.1",
          ...(validatedSelection.usImportTerms &&
          validatedSelection.usImportDisclosureVersion &&
          validatedSelection.usImportDisclosureText
            ? {
                usImportDisclosure: {
                  terms: validatedSelection.usImportTerms,
                  version: validatedSelection.usImportDisclosureVersion,
                  text: validatedSelection.usImportDisclosureText,
                  presentedAt: new Date(),
                },
              }
            : {}),
        });
        initializingOrderId = initializingOrder.orderId;
      }

      if (initializingOrder) {
        if (!("primaryObligationId" in initializingOrder)) {
          throw new Error("Durable payment operation was not reserved");
        }
        return NextResponse.json<CheckoutResponseBody>(
          {
            operationId: initializingOrder.primaryObligationId,
            status: "queued",
          },
          { status: 202 },
        );
      }

      return NextResponse.json<CheckoutErrorBody>(
        { error: "Durable product payment initialization is unavailable" },
        { status: 503 },
      );
    } catch (error) {
      if (initializingOrderId && markInitializationFailed) {
        await markInitializationFailed(
          initializingOrderId,
          error instanceof Error
            ? error.message
            : "Unknown initialization error",
        ).catch(() => undefined);
      }
      log("error", "[checkout] Unable to initialize checkout", {
        stage,
        ...summarizeCheckoutError(error),
      });

      return NextResponse.json<CheckoutErrorBody>(
        {
          error:
            error instanceof ShippingQuoteConflictError
              ? error.message
              : "Unable to start checkout",
        },
        {
          status:
            error instanceof ShippingQuoteConflictError
              ? 409
              : getCheckoutFailureStatus(stage),
        },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const [{ loaders }, orderStore, shippingConfig] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/order-store"),
    import("@/lib/shipping/config"),
  ]);

  return createCheckoutPostHandler({
    getProductsByIds: loaders.getProductsByIds,
    getPromotionCode: loaders.getPromotionCode,
    shippingEnabled: shippingConfig.isChitChatsCheckoutEnabled(),
    validateShippingSelection: async ({ request, products, promotionCode }) => {
      const [
        { listEnabledPackageProfiles },
        { prepareShippingQuote },
        { getChitChatsConfig },
        { assertCheckoutReadiness },
        { bindShippingFingerprintToContext },
      ] = await Promise.all([
        import("@/lib/shipping/shipment-store"),
        import("@/lib/shipping/prepare-quote"),
        import("@/lib/shipping/config"),
        import("@/lib/shipping/readiness"),
        import("@/lib/shipping/quote-token"),
      ]);
      if (!request.customer.phone)
        throw new Error("Customer phone is required for shipping");
      if (!request.shippingAddress) {
        throw new ShippingQuoteConflictError("Shipping address is required");
      }
      const countryCode = getShippingCountryCode(request.shippingAddress);
      const readiness = await assertCheckoutReadiness({
        destinationCountryCode: countryCode,
      }).catch(() => {
        throw new ShippingQuoteConflictError(
          "Shipping checkout is not operationally ready",
        );
      });
      if (!readiness.quoteContext) {
        throw new ShippingQuoteConflictError(
          "Shipping quote context is unavailable",
        );
      }
      const contract = readiness.quoteContext.usShippingContract;
      if (countryCode === "US" && contract?.importTerms !== "DDU") {
        throw new ShippingQuoteConflictError(
          "Certified U.S. DDU shipping terms are unavailable",
        );
      }
      const usImportDisclosure =
        countryCode === "US" && contract
          ? {
              usImportTerms: "DDU" as const,
              usImportDisclosureVersion: contract.disclosure.version,
              usImportDisclosureText: contract.disclosure.text,
            }
          : undefined;
      const preparedAt = new Date();
      const prepared = prepareShippingQuote({
        items: request.items,
        products,
        promotionCode,
        profiles: await listEnabledPackageProfiles(),
        usShippingEnabled: getChitChatsConfig().usShippingEnabled,
        now: preparedAt,
        ...(contract ? { usShippingContract: contract } : {}),
        recipient: {
          ...request.shippingAddress,
          province: normalizeProvinceCode(request.shippingAddress.province),
          postalCode: request.shippingAddress.postalCode.toUpperCase(),
          countryCode,
          name: request.customer.name,
          email: request.customer.email,
          phone: request.customer.phone,
        },
        ...(usImportDisclosure ? { usImportDisclosure } : {}),
      });
      return {
        fingerprint: bindShippingFingerprintToContext(
          prepared.fingerprint,
          readiness.quoteContext,
        ),
        ...(usImportDisclosure ?? {}),
      };
    },
    createInitializingOrder: orderStore.createInitializingProductOrder,
    createInitializingManualOrder:
      orderStore.createInitializingManualProductOrder,
    finalizeInitializingOrder: orderStore.finalizeInitializingProductOrder,
    markInitializationFailed: orderStore.markProductOrderInitializationFailed,
  })(req);
}

export async function resolveCheckoutHelcimGatewayForRequest(
  req: Request,
): Promise<HelcimGateway> {
  const runtimeControls = await import("@/lib/payment-mocks/runtime-controls");
  const runtimeEnvironment = getPaymentMockRuntimeEnvironment();

  runtimeControls.assertPaymentMockAllowed({
    env: runtimeEnvironment,
    request: req,
  });

  if (
    runtimeControls.resolvePaymentGatewayMode(runtimeEnvironment) !== "mock"
  ) {
    const liveGateway = await import("@/lib/commerce/helcim-gateway");
    return liveGateway.createLiveHelcimGateway();
  }

  const mockGateway = await import("@/lib/commerce/helcim-mock-gateway");

  return mockGateway.createMockHelcimGateway({
    scenario: runtimeControls.resolvePaymentMockScenario({
      env: runtimeEnvironment,
      now: new Date(),
      request: req,
    }),
    store: checkoutPaymentMockStore,
  });
}

function getPaymentMockRuntimeEnvironment() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_GATEWAY_MODE: process.env.PAYMENT_GATEWAY_MODE,
    PAYMENT_MOCK_DEFAULT_SCENARIO: process.env.PAYMENT_MOCK_DEFAULT_SCENARIO,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
}

function parseCheckoutRequest(body: unknown): CheckoutRequestBody | null {
  if (
    !isRecord(body) ||
    !isRecord(body.customer) ||
    !Array.isArray(body.items)
  ) {
    return null;
  }

  const name = parseCheckoutText(
    body.customer.name,
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  );
  const email =
    typeof body.customer.email === "string"
      ? body.customer.email.trim().toLowerCase()
      : null;
  const shippingAddress =
    body.shippingAddress === undefined
      ? undefined
      : isRecord(body.shippingAddress)
        ? parseShippingAddress(body.shippingAddress)
        : null;
  const promotionCode = parsePromotionCodeInput(body.promotionCode);
  const phone = parseOptionalCheckoutText(body.customer.phone, 30);
  const shippingQuote = parseShippingQuote(body.shippingQuote);
  const fulfillmentMode = parseFulfillmentMode(body.fulfillmentMode);
  const disclosures = parseDisclosures(body.disclosures);

  if (
    name === null ||
    email === null ||
    !isValidCheckoutEmail(email) ||
    shippingAddress === null ||
    promotionCode === null ||
    phone === null ||
    shippingQuote === null ||
    fulfillmentMode === null ||
    disclosures === null
  ) {
    return null;
  }

  return {
    customer: { name, email, ...(phone ? { phone } : {}) },
    items: body.items.map(toCartInputItem),
    ...(shippingAddress ? { shippingAddress } : {}),
    fulfillmentMode,
    disclosures,
    ...(promotionCode ? { promotionCode } : {}),
    ...(shippingQuote ? { shippingQuote } : {}),
  };
}

function parseFulfillmentMode(
  value: unknown,
): CheckoutRequestBody["fulfillmentMode"] | null {
  return value === "automated_shipping" ||
    value === "manual_pickup" ||
    value === "manual_shipping"
    ? value
    : null;
}

function parseDisclosures(
  value: unknown,
): CheckoutRequestBody["disclosures"] | null {
  if (!isRecord(value)) return null;
  const cancellationPolicyVersion = parseOptionalCheckoutText(
    value.cancellationPolicyVersion,
    100,
  );
  if (cancellationPolicyVersion === null) return null;
  const cancellationPolicyAccepted =
    value.cancellationPolicyAccepted === true
      ? true
      : value.cancellationPolicyAccepted === undefined
        ? undefined
        : null;
  const cancellationPolicyTextHash = parseOptionalCheckoutText(
    value.cancellationPolicyTextHash,
    64,
  );
  if (
    cancellationPolicyAccepted === null ||
    cancellationPolicyTextHash === null ||
    (cancellationPolicyTextHash !== undefined &&
      !/^[0-9a-f]{64}$/.test(cancellationPolicyTextHash))
  ) {
    return null;
  }
  const usImportTerms =
    value.usImportTerms === "DDU"
      ? value.usImportTerms
      : value.usImportTerms === undefined
        ? undefined
        : null;
  const usImportDisclosureVersion = parseOptionalCheckoutText(
    value.usImportDisclosureVersion,
    100,
  );
  const usImportDisclosureText = parseOptionalCheckoutText(
    value.usImportDisclosureText,
    2_000,
  );
  if (
    usImportTerms === null ||
    usImportDisclosureVersion === null ||
    usImportDisclosureText === null
  )
    return null;
  return {
    ...(cancellationPolicyAccepted
      ? { cancellationPolicyAccepted: true as const }
      : {}),
    ...(cancellationPolicyVersion ? { cancellationPolicyVersion } : {}),
    ...(cancellationPolicyTextHash ? { cancellationPolicyTextHash } : {}),
    ...(usImportTerms ? { usImportTerms } : {}),
    ...(usImportDisclosureVersion ? { usImportDisclosureVersion } : {}),
    ...(usImportDisclosureText ? { usImportDisclosureText } : {}),
  };
}

function normalizeValidatedShippingSelection(
  value: string | ValidatedShippingSelection,
): ValidatedShippingSelection {
  return typeof value === "string" ? { fingerprint: value } : value;
}

function shippingDisclosureMatchesRequest(
  validated: ValidatedShippingSelection,
  requested: CheckoutRequestBody["disclosures"],
): boolean {
  return (
    validated.usImportTerms === "DDU" &&
    validated.usImportTerms === requested.usImportTerms &&
    Boolean(validated.usImportDisclosureVersion?.trim()) &&
    validated.usImportDisclosureVersion ===
      requested.usImportDisclosureVersion &&
    Boolean(validated.usImportDisclosureText?.trim()) &&
    validated.usImportDisclosureText === requested.usImportDisclosureText
  );
}

function parseShippingQuote(
  value: unknown,
): CheckoutRequestBody["shippingQuote"] | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const fingerprint =
    typeof value.fingerprint === "string" ? value.fingerprint.trim() : "";
  const rateId = typeof value.rateId === "string" ? value.rateId.trim() : "";
  if (!token || !/^[a-f0-9]{64}$/.test(fingerprint) || !rateId) return null;
  return { token, fingerprint, rateId };
}

function dependenciesProvideShippingWorkflow(input: {
  validateShippingSelection?: unknown;
  createInitializingOrder?: unknown;
  finalizeInitializingOrder?: unknown;
}): boolean {
  return Boolean(
    input.validateShippingSelection &&
    input.createInitializingOrder &&
    input.finalizeInitializingOrder,
  );
}

function parseShippingAddress(
  value: Record<string, unknown>,
): CheckoutShippingAddressInput | null {
  const line1 = parseCheckoutText(
    value.line1,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  );
  const city = parseCheckoutText(
    value.city,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );
  const province = parseCheckoutText(
    value.province,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );
  const postalCode = parseCheckoutText(
    value.postalCode,
    CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
  );
  const country = parseCheckoutText(
    value.country,
    CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  );

  if (
    line1 === null ||
    city === null ||
    province === null ||
    postalCode === null ||
    country === null
  ) {
    return null;
  }
  const normalizedCountry = country.trim().toUpperCase();
  if (
    normalizedCountry !== "CA" &&
    normalizedCountry !== "CANADA" &&
    normalizedCountry !== "US" &&
    normalizedCountry !== "UNITED STATES"
  ) {
    return null;
  }

  const line2 = parseOptionalCheckoutText(
    value.line2,
    CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  );

  if (line2 === null) {
    return null;
  }

  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    province,
    postalCode: postalCode.toUpperCase(),
    country,
  };
}

function normalizeShippingAddress(
  address: CheckoutShippingAddressInput,
  phone?: string,
): CheckoutShippingAddressInput {
  const countryCode = getShippingCountryCode(address);
  return {
    ...address,
    province: normalizeProvinceCode(address.province),
    postalCode: address.postalCode.toUpperCase(),
    country: countryCode === "US" ? "United States" : "Canada",
    countryCode,
    ...(phone ? { phone } : {}),
  };
}

function getShippingCountryCode(
  address: CheckoutShippingAddressInput,
): "CA" | "US" {
  const country = address.country.trim().toUpperCase();
  return address.countryCode === "US" ||
    country === "US" ||
    country === "UNITED STATES"
    ? "US"
    : "CA";
}

function normalizeProvinceCode(value: string): string {
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

function toCartInputItem(item: unknown): CartInputItem {
  if (!isRecord(item)) {
    return { productId: "", quantity: Number.NaN };
  }

  return {
    productId: typeof item.productId === "string" ? item.productId : "",
    ...(typeof item.variantId === "string"
      ? { variantId: item.variantId }
      : {}),
    quantity: typeof item.quantity === "number" ? item.quantity : Number.NaN,
  };
}

function summarizeCheckoutError(error: unknown): CheckoutErrorLog {
  if (!(error instanceof Error)) {
    return { error: "Unknown checkout error" };
  }

  const cause = isRecord(error)
    ? summarizeCheckoutErrorCause(error.cause)
    : undefined;
  const errorName = summarizeCheckoutErrorName(error.name);

  return {
    error: summarizeCheckoutErrorMessage(error),
    ...(errorName ? { errorName } : {}),
    ...(cause ? { cause } : {}),
  };
}

function summarizeCheckoutErrorCause(
  cause: unknown,
): CheckoutErrorLogCause | undefined {
  if (!isRecord(cause)) {
    return undefined;
  }

  const summary: CheckoutErrorLogCause = {};
  setSafeLogField(summary, "code", cause.code);
  setSafeLogField(summary, "severity", cause.severity);
  setSafeLogField(summary, "schema", cause.schema);
  setSafeLogField(summary, "table", cause.table);
  setSafeLogField(summary, "column", cause.column);
  setSafeLogField(summary, "constraint", cause.constraint);
  setSafeLogField(summary, "dataType", cause.dataType);
  setUndefinedColumnField(summary, cause);

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function setUndefinedColumnField(
  summary: CheckoutErrorLogCause,
  cause: Record<string, unknown>,
): void {
  if (
    summary.column ||
    cause.code !== "42703" ||
    typeof cause.message !== "string"
  ) {
    return;
  }

  const missingColumn = cause.message.match(
    /^column "([A-Za-z0-9_.]+)"(?: of relation "[A-Za-z0-9_]+")? does not exist$/,
  );

  if (!missingColumn) {
    return;
  }

  summary.column = missingColumn[1];
}

function setSafeLogField(
  summary: CheckoutErrorLogCause,
  key: keyof CheckoutErrorLogCause,
  value: unknown,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }

  summary[key] = sanitizeCheckoutLogText(value);
}

function summarizeCheckoutErrorMessage(error: Error): string {
  if (error.message.includes("Failed query:")) {
    return "Database query failed";
  }

  return "Checkout initialization failed";
}

function getCheckoutFailureStatus(stage: CheckoutInitializationStage): number {
  if (stage === "load_checkout_inputs" || stage === "reserve_order") {
    return 500;
  }
  return 400;
}

function summarizeCheckoutErrorName(name: string): string | undefined {
  const normalizedName = sanitizeCheckoutLogText(name);

  return /^[A-Za-z0-9_.:-]+$/.test(normalizedName) ? normalizedName : undefined;
}

function sanitizeCheckoutLogText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > 240
    ? `${normalized.slice(0, 237)}...`
    : normalized;
}

function invalidPromotionCode(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Invalid promotion code" },
    { status: 400 },
  );
}

function invalidFulfillmentMode(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Cart items require a different fulfillment method" },
    { status: 409 },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidCheckoutRequest(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Invalid checkout request" },
    { status: 400 },
  );
}
