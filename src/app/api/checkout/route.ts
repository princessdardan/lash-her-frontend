import { NextResponse, type NextRequest } from "next/server";

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
import type { TProduct, TPromotionCode } from "@/types";

const checkoutPaymentMockStore = createPaymentMockStore();

interface CheckoutCustomerInput {
  name: string;
  email: string;
}

interface CheckoutShippingAddressInput {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

interface CheckoutRequestBody {
  customer: CheckoutCustomerInput;
  items: CartInputItem[];
  shippingAddress: CheckoutShippingAddressInput;
  promotionCode?: string;
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
  createHelcimInvoice: (input: CheckoutInvoiceInput) => Promise<CheckoutInvoice>;
  initializeHelcimPay: (input: CheckoutPaySessionInput) => Promise<CheckoutPaySession>;
  createPendingOrder: (input: CheckoutPendingOrderInput) => Promise<unknown>;
}

type CheckoutInitializationStage = "prepare_checkout" | "load_checkout_inputs" | "create_helcim_invoice" | "initialize_helcim_pay" | "persist_order";
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
}: CheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function checkoutPostHandler(req: NextRequest): Promise<Response> {
    let body: unknown;
    let stage: CheckoutInitializationStage = "prepare_checkout";

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
      const productIds = Array.from(new Set(checkoutRequest.items.map((item) => item.productId)));
      stage = "load_checkout_inputs";
      const [products, promotionCode] = await Promise.all([
        getProductsByIds(productIds),
        checkoutRequest.promotionCode ? getPromotionCode(checkoutRequest.promotionCode) : Promise.resolve(null),
      ]);
      stage = "prepare_checkout";
      const catalogProducts = products.map(toCatalogProduct);
      const cart = buildValidatedCart(checkoutRequest.items, catalogProducts, { promotionCode });

      if (checkoutRequest.promotionCode && cart.promotionCode !== checkoutRequest.promotionCode) {
        return invalidPromotionCode();
      }

      const invoiceLineItems = cart.lineItems.map(({ sku, description, quantity, price }) => ({
        sku,
        description,
        quantity,
        price,
      }));

      if (cart.promotionCode && cart.promotionDiscountAmount) {
        invoiceLineItems.push({
          sku: cart.promotionCode,
          description: `Promotion code ${cart.promotionCode}`,
          quantity: 1,
          price: -cart.promotionDiscountAmount,
        });
      }

      stage = "create_helcim_invoice";
      const invoice = validateCheckoutInvoice(await createHelcimInvoice({
        currency: "CAD",
        type: "INVOICE",
        status: "DUE",
        notes: "Lash Her website checkout",
        lineItems: invoiceLineItems,
      }));

      stage = "initialize_helcim_pay";
      const helcimPaySession = validateCheckoutPaySession(await initializeHelcimPay({
        paymentType: "purchase",
        amount: cart.amount,
        currency: "CAD",
        invoiceNumber: invoice.invoiceNumber,
      }));

      stage = "persist_order";
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

      return NextResponse.json<CheckoutResponseBody>({
        checkoutToken: helcimPaySession.checkoutToken,
      });
    } catch (error) {
      console.error("[checkout] Unable to initialize checkout", {
        stage,
        ...summarizeCheckoutError(error),
      });

      return NextResponse.json<CheckoutErrorBody>(
        { error: "Unable to start checkout" },
        { status: getCheckoutFailureStatus(stage) },
      );
    }
  };
}

class CheckoutProviderResponseError extends Error {
  readonly missingFields: string;
  readonly provider = "helcim";
  readonly providerEndpoint: CheckoutProviderEndpoint;

  constructor(providerEndpoint: CheckoutProviderEndpoint, missingFields: string[]) {
    super("Checkout provider response missing required fields");
    this.name = "CheckoutProviderResponseError";
    this.providerEndpoint = providerEndpoint;
    this.missingFields = missingFields.join(",");
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const [{ loaders }, gateway, { createPendingOrder }] =
    await Promise.all([
      import("@/data/loaders"),
      resolveCheckoutHelcimGatewayForRequest(req),
      import("@/lib/commerce/order-store"),
    ]);

  return createCheckoutPostHandler({
    getProductsByIds: loaders.getProductsByIds,
    getPromotionCode: loaders.getPromotionCode,
    createHelcimInvoice: gateway.createInvoice,
    initializeHelcimPay: gateway.initializePay,
    createPendingOrder,
  })(req);
}

export async function resolveCheckoutHelcimGatewayForRequest(req: Request): Promise<HelcimGateway> {
  const runtimeControls = await import("@/lib/payment-mocks/runtime-controls");
  const runtimeEnvironment = getPaymentMockRuntimeEnvironment();

  runtimeControls.assertPaymentMockAllowed({ env: runtimeEnvironment, request: req });

  if (runtimeControls.resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
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
  if (!isRecord(body) || !isRecord(body.customer) || !Array.isArray(body.items) || !isRecord(body.shippingAddress)) {
    return null;
  }

  const name = parseCheckoutText(body.customer.name, CHECKOUT_CUSTOMER_NAME_MAX_LENGTH);
  const email = typeof body.customer.email === "string" ? body.customer.email.trim().toLowerCase() : null;
  const shippingAddress = parseShippingAddress(body.shippingAddress);
  const promotionCode = parsePromotionCodeInput(body.promotionCode);

  if (name === null || email === null || !isValidCheckoutEmail(email) || shippingAddress === null || promotionCode === null) {
    return null;
  }

  return {
    customer: { name, email },
    items: body.items.map(toCartInputItem),
    shippingAddress,
    ...(promotionCode ? { promotionCode } : {}),
  };
}

function parseShippingAddress(value: Record<string, unknown>): CheckoutShippingAddressInput | null {
  const line1 = parseCheckoutText(value.line1, CHECKOUT_SHIPPING_LINE_MAX_LENGTH);
  const city = parseCheckoutText(value.city, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH);
  const province = parseCheckoutText(value.province, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH);
  const postalCode = parseCheckoutText(value.postalCode, CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH);
  const country = parseCheckoutText(value.country, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH);

  if (line1 === null || city === null || province === null || postalCode === null || country === null) {
    return null;
  }

  const line2 = parseOptionalCheckoutText(value.line2, CHECKOUT_SHIPPING_LINE_MAX_LENGTH);

  if (line2 === null) {
    return null;
  }

  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    province,
    postalCode,
    country,
  };
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
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      discountPrice: variant.discountPrice,
      isAvailable: variant.isAvailable,
    })),
  };
}

function validateCheckoutInvoice(invoice: unknown): CheckoutInvoice {
  const invoiceRecord = isRecord(invoice) ? invoice : null;
  const invoiceId = typeof invoiceRecord?.invoiceId === "number" && Number.isSafeInteger(invoiceRecord.invoiceId)
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

  const cause = isRecord(error) ? summarizeCheckoutErrorCause(error.cause) : undefined;
  const errorName = summarizeCheckoutErrorName(error.name);

  return {
    error: summarizeCheckoutErrorMessage(error),
    ...(errorName ? { errorName } : {}),
    ...(cause ? { cause } : {}),
    ...summarizeCheckoutProviderResponseError(error),
  };
}

function summarizeCheckoutProviderResponseError(error: Error): Pick<CheckoutErrorLog, "missingFields" | "provider" | "providerEndpoint"> {
  if (!(error instanceof CheckoutProviderResponseError)) {
    return {};
  }

  return {
    missingFields: error.missingFields,
    provider: error.provider,
    providerEndpoint: error.providerEndpoint,
  };
}

function summarizeCheckoutErrorCause(cause: unknown): CheckoutErrorLogCause | undefined {
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
  if (summary.column || cause.code !== "42703" || typeof cause.message !== "string") {
    return;
  }

  const missingColumn = cause.message.match(/^column "([A-Za-z0-9_.]+)"(?: of relation "[A-Za-z0-9_]+")? does not exist$/);

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
  if (stage === "load_checkout_inputs" || stage === "persist_order") {
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

  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
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
