import { NextResponse, type NextRequest } from "next/server";

import { log } from "@/lib/logging/logger";
import {
  buildValidatedCart,
  type CartInputItem,
  type CatalogProduct,
  type ValidatedCart,
} from "@/lib/commerce/cart";
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
import type { TProduct, TPromotionCode } from "@/types";

const checkoutPaymentMockStore = createPaymentMockStore();

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
  shippingAddress: CheckoutShippingAddressInput;
  promotionCode?: string;
  shippingQuote?: {
    token: string;
    fingerprint: string;
    rateId: string;
  };
}

interface CheckoutResponseBody {
  checkoutToken: string;
}

interface CheckoutErrorBody {
  error: string;
}

interface CheckoutErrorLog {
  cause?: CheckoutErrorLogCause;
  error: string;
  errorName?: string;
  missingFields?: string;
  provider?: "helcim";
  providerEndpoint?: CheckoutProviderEndpoint;
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
  createHelcimInvoice: (
    input: CheckoutInvoiceInput,
  ) => Promise<CheckoutInvoice>;
  initializeHelcimPay: (
    input: CheckoutPaySessionInput,
  ) => Promise<CheckoutPaySession>;
  createPendingOrder: (input: CheckoutPendingOrderInput) => Promise<unknown>;
  shippingEnabled?: boolean;
  validateShippingSelection?: (input: {
    request: CheckoutRequestBody;
    products: TProduct[];
    promotionCode: TPromotionCode | null;
  }) => Promise<string>;
  createInitializingOrder?: (input: {
    customerName: string;
    customerEmail: string;
    cart: ValidatedCart;
    shippingAddress: CheckoutShippingAddressInput;
    shippingQuoteToken: string;
    shippingQuoteFingerprint: string;
    shippingRateId: string;
    refundOriginIp: string;
  }) => Promise<{
    orderId: string;
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
}

type CheckoutInitializationStage =
  | "prepare_checkout"
  | "load_checkout_inputs"
  | "reserve_order"
  | "create_helcim_invoice"
  | "initialize_helcim_pay"
  | "persist_order";
type CheckoutProviderEndpoint = "invoice" | "helcim_pay";

interface CheckoutInvoiceInput {
  currency: "CAD";
  type: "INVOICE";
  status: "DUE";
  notes: string;
  lineItems: Array<{
    sku: string;
    description: string;
    quantity: number;
    price: number;
    discountCode?: string;
  }>;
}

interface CheckoutInvoice {
  invoiceId: number;
  invoiceNumber: string;
}

interface CheckoutPaySessionInput {
  paymentType: "purchase";
  amount: number;
  currency: "CAD";
  invoiceNumber: string;
}

interface CheckoutPaySession {
  checkoutToken: string;
  secretToken: string;
}

interface CheckoutPendingOrderInput {
  customerName: string;
  customerEmail: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  cart: ValidatedCart;
  shippingAddress: CheckoutShippingAddressInput;
}

export function createCheckoutPostHandler({
  getProductsByIds,
  getPromotionCode,
  createHelcimInvoice,
  initializeHelcimPay,
  createPendingOrder,
  shippingEnabled,
  validateShippingSelection,
  createInitializingOrder,
  finalizeInitializingOrder,
  markInitializationFailed,
}: CheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function checkoutPostHandler(
    req: NextRequest,
  ): Promise<Response> {
    let body: unknown;
    let stage: CheckoutInitializationStage = "prepare_checkout";
    let initializingOrderId: string | null = null;

    try {
      body = await req.json();
    } catch {
      return invalidCheckoutRequest();
    }

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
      const catalogProducts = products.map(toCatalogProduct);
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
      if (shippingWorkflowConfigured && !shippingEnabled) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Product checkout is temporarily unavailable" },
          { status: 503 },
        );
      }
      if (shippingWorkflowConfigured && !checkoutRequest.shippingQuote) {
        return NextResponse.json<CheckoutErrorBody>(
          { error: "Select a current shipping rate" },
          { status: 409 },
        );
      }

      const invoiceLineItems = cart.lineItems.map(
        ({ sku, description, quantity, price }) => ({
          sku,
          description,
          quantity,
          price,
        }),
      );

      if (cart.promotionCode && cart.promotionDiscountAmount) {
        invoiceLineItems.push({
          sku: cart.promotionCode,
          description: `Promotion code ${cart.promotionCode}`,
          quantity: 1,
          price: -cart.promotionDiscountAmount,
        });
      }

      let checkoutAmount = cart.amount;
      let initializingOrder: Awaited<
        ReturnType<NonNullable<typeof createInitializingOrder>>
      > | null = null;
      if (
        shippingEnabled &&
        validateShippingSelection &&
        createInitializingOrder &&
        finalizeInitializingOrder &&
        checkoutRequest.shippingQuote
      ) {
        const currentFingerprint = await validateShippingSelection({
          request: checkoutRequest,
          products,
          promotionCode,
        });
        if (currentFingerprint !== checkoutRequest.shippingQuote.fingerprint) {
          return NextResponse.json<CheckoutErrorBody>(
            { error: "Shipping quote changed" },
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
          shippingAddress: {
            ...checkoutRequest.shippingAddress,
            province: normalizeProvinceCode(
              checkoutRequest.shippingAddress.province,
            ),
            postalCode:
              checkoutRequest.shippingAddress.postalCode.toUpperCase(),
            countryCode:
              checkoutRequest.shippingAddress.country.toUpperCase() ===
                "UNITED STATES" ||
              checkoutRequest.shippingAddress.country.toUpperCase() === "US"
                ? "US"
                : "CA",
            ...(checkoutRequest.customer.phone
              ? { phone: checkoutRequest.customer.phone }
              : {}),
          },
          shippingQuoteToken: checkoutRequest.shippingQuote.token,
          shippingQuoteFingerprint: currentFingerprint,
          shippingRateId: checkoutRequest.shippingQuote.rateId,
          refundOriginIp: refundOriginIp ?? "127.0.0.1",
        });
        initializingOrderId = initializingOrder.orderId;
        checkoutAmount = initializingOrder.totalAmountCents / 100;
        invoiceLineItems.push({
          sku: "SHIPPING",
          description: initializingOrder.shippingRateTitle,
          quantity: 1,
          price: initializingOrder.shippingAmountCents / 100,
        });
      }

      stage = "create_helcim_invoice";
      const invoice = validateCheckoutInvoice(
        await createHelcimInvoice({
          currency: "CAD",
          type: "INVOICE",
          status: "DUE",
          notes: initializingOrder
            ? `Lash Her website checkout ${initializingOrder.orderId}`
            : "Lash Her website checkout",
          lineItems: invoiceLineItems,
        }),
      );

      stage = "initialize_helcim_pay";
      const helcimPaySession = validateCheckoutPaySession(
        await initializeHelcimPay({
          paymentType: "purchase",
          amount: checkoutAmount,
          currency: "CAD",
          invoiceNumber: invoice.invoiceNumber,
        }),
      );

      stage = "persist_order";
      if (initializingOrder && finalizeInitializingOrder) {
        await finalizeInitializingOrder({
          orderId: initializingOrder.orderId,
          checkoutToken: helcimPaySession.checkoutToken,
          secretToken: helcimPaySession.secretToken,
          helcimInvoiceId: invoice.invoiceId,
          helcimInvoiceNumber: invoice.invoiceNumber,
        });
      } else {
        await createPendingOrder({
          customerName: checkoutRequest.customer.name,
          customerEmail: checkoutRequest.customer.email,
          checkoutToken: helcimPaySession.checkoutToken,
          secretToken: helcimPaySession.secretToken,
          helcimInvoiceId: invoice.invoiceId,
          helcimInvoiceNumber: invoice.invoiceNumber,
          cart,
          shippingAddress: checkoutRequest.shippingAddress,
        });
      }

      return NextResponse.json<CheckoutResponseBody>({
        checkoutToken: helcimPaySession.checkoutToken,
      });
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

class CheckoutProviderResponseError extends Error {
  readonly missingFields: string;
  readonly provider = "helcim";
  readonly providerEndpoint: CheckoutProviderEndpoint;

  constructor(
    providerEndpoint: CheckoutProviderEndpoint,
    missingFields: string[],
  ) {
    super("Checkout provider response missing required fields");
    this.name = "CheckoutProviderResponseError";
    this.providerEndpoint = providerEndpoint;
    this.missingFields = missingFields.join(",");
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const [{ loaders }, gateway, orderStore, shippingConfig] = await Promise.all([
    import("@/data/loaders"),
    resolveCheckoutHelcimGatewayForRequest(req),
    import("@/lib/commerce/order-store"),
    import("@/lib/shipping/config"),
  ]);

  return createCheckoutPostHandler({
    getProductsByIds: loaders.getProductsByIds,
    getPromotionCode: loaders.getPromotionCode,
    createHelcimInvoice: gateway.createInvoice,
    initializeHelcimPay: gateway.initializePay,
    createPendingOrder: orderStore.createPendingOrder,
    shippingEnabled: shippingConfig.isChitChatsCheckoutEnabled(),
    validateShippingSelection: async ({ request, products, promotionCode }) => {
      const [
        { listEnabledPackageProfiles },
        { prepareShippingQuote },
        { getChitChatsConfig },
      ] = await Promise.all([
        import("@/lib/shipping/shipment-store"),
        import("@/lib/shipping/prepare-quote"),
        import("@/lib/shipping/config"),
      ]);
      if (!request.customer.phone)
        throw new Error("Customer phone is required for shipping");
      const countryCode =
        request.shippingAddress.country.toUpperCase() === "UNITED STATES" ||
        request.shippingAddress.country.toUpperCase() === "US"
          ? "US"
          : "CA";
      const prepared = prepareShippingQuote({
        items: request.items,
        products,
        promotionCode,
        profiles: await listEnabledPackageProfiles(),
        usShippingEnabled: getChitChatsConfig().usShippingEnabled,
        recipient: {
          ...request.shippingAddress,
          province: normalizeProvinceCode(request.shippingAddress.province),
          postalCode: request.shippingAddress.postalCode.toUpperCase(),
          countryCode,
          name: request.customer.name,
          email: request.customer.email,
          phone: request.customer.phone,
        },
      });
      return prepared.fingerprint;
    },
    createInitializingOrder: orderStore.createInitializingProductOrder,
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
    !Array.isArray(body.items) ||
    !isRecord(body.shippingAddress)
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
  const shippingAddress = parseShippingAddress(body.shippingAddress);
  const promotionCode = parsePromotionCodeInput(body.promotionCode);
  const phone = parseOptionalCheckoutText(body.customer.phone, 30);
  const shippingQuote = parseShippingQuote(body.shippingQuote);

  if (
    name === null ||
    email === null ||
    !isValidCheckoutEmail(email) ||
    shippingAddress === null ||
    promotionCode === null ||
    phone === null ||
    shippingQuote === null
  ) {
    return null;
  }

  return {
    customer: { name, email, ...(phone ? { phone } : {}) },
    items: body.items.map(toCartInputItem),
    shippingAddress,
    ...(promotionCode ? { promotionCode } : {}),
    ...(shippingQuote ? { shippingQuote } : {}),
  };
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
    variantId: typeof item.variantId === "string" ? item.variantId : undefined,
    quantity: typeof item.quantity === "number" ? item.quantity : Number.NaN,
  };
}

function toCatalogProduct(product: TProduct): CatalogProduct {
  return {
    id: product._id,
    sku: product.sku,
    title: product.title,
    price: product.price,
    discountPrice: product.discountPrice,
    currency: product.currency,
    isAvailable: product.isAvailable,
    checkoutMode:
      product.shipping?.fulfillmentMode === "manual" ||
      product.shipping?.hazardousMaterial
        ? "manual"
        : "automated",
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      discountPrice: variant.discountPrice,
      isAvailable: variant.isAvailable,
      options: variant.options?.flatMap((option) =>
        option.name && option.value
          ? [{ label: option.name, value: option.value }]
          : [],
      ),
      checkoutMode:
        (variant.shipping ?? product.shipping)?.fulfillmentMode === "manual" ||
        (variant.shipping ?? product.shipping)?.hazardousMaterial
          ? "manual"
          : "automated",
    })),
  };
}

function validateCheckoutInvoice(invoice: unknown): CheckoutInvoice {
  const invoiceRecord = isRecord(invoice) ? invoice : null;
  const invoiceId =
    typeof invoiceRecord?.invoiceId === "number" &&
    Number.isSafeInteger(invoiceRecord.invoiceId)
      ? invoiceRecord.invoiceId
      : null;
  const invoiceNumber = isNonEmptyString(invoiceRecord?.invoiceNumber)
    ? invoiceRecord.invoiceNumber
    : null;

  if (invoiceId === null || invoiceNumber === null) {
    const missingFields: string[] = [];
    if (invoiceId === null) missingFields.push("invoiceId");
    if (invoiceNumber === null) missingFields.push("invoiceNumber");
    throw new CheckoutProviderResponseError("invoice", missingFields);
  }

  return {
    invoiceId,
    invoiceNumber,
  };
}

function validateCheckoutPaySession(session: unknown): CheckoutPaySession {
  const sessionRecord = isRecord(session) ? session : null;
  const checkoutToken = isNonEmptyString(sessionRecord?.checkoutToken)
    ? sessionRecord.checkoutToken
    : null;
  const secretToken = isNonEmptyString(sessionRecord?.secretToken)
    ? sessionRecord.secretToken
    : null;

  if (checkoutToken === null || secretToken === null) {
    const missingFields: string[] = [];
    if (checkoutToken === null) missingFields.push("checkoutToken");
    if (secretToken === null) missingFields.push("secretToken");
    throw new CheckoutProviderResponseError("helcim_pay", missingFields);
  }

  return {
    checkoutToken,
    secretToken,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    ...summarizeCheckoutProviderResponseError(error),
  };
}

function summarizeCheckoutProviderResponseError(
  error: Error,
): Pick<CheckoutErrorLog, "missingFields" | "provider" | "providerEndpoint"> {
  if (!(error instanceof CheckoutProviderResponseError)) {
    return {};
  }

  return {
    missingFields: error.missingFields,
    provider: error.provider,
    providerEndpoint: error.providerEndpoint,
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
  if (error instanceof CheckoutProviderResponseError) {
    return "Checkout provider response invalid";
  }

  if (error.message.includes("Failed query:")) {
    return "Database query failed";
  }

  return "Checkout initialization failed";
}

function getCheckoutFailureStatus(stage: CheckoutInitializationStage): number {
  if (
    stage === "load_checkout_inputs" ||
    stage === "reserve_order" ||
    stage === "persist_order"
  ) {
    return 500;
  }

  if (stage === "create_helcim_invoice" || stage === "initialize_helcim_pay") {
    return 502;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidCheckoutRequest(): NextResponse<CheckoutErrorBody> {
  return NextResponse.json<CheckoutErrorBody>(
    { error: "Invalid checkout request" },
    { status: 400 },
  );
}
