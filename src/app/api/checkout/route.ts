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
import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import type { TProduct } from "@/types";

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
}

interface CheckoutResponseBody {
  checkoutToken: string;
}

interface CheckoutErrorBody {
  error: string;
}

interface CheckoutPostHandlerDependencies {
  getProductsByIds: (ids: string[]) => Promise<TProduct[]>;
  createHelcimInvoice: (input: CheckoutInvoiceInput) => Promise<CheckoutInvoice>;
  initializeHelcimPay: (input: CheckoutPaySessionInput) => Promise<CheckoutPaySession>;
  createPendingOrder: (input: CheckoutPendingOrderInput) => Promise<unknown>;
}

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
  createHelcimInvoice,
  initializeHelcimPay,
  createPendingOrder,
}: CheckoutPostHandlerDependencies): (req: NextRequest) => Promise<Response> {
  return async function checkoutPostHandler(req: NextRequest): Promise<Response> {
    let body: unknown;

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
      const products = await getProductsByIds(productIds);
      const catalogProducts = products.map(toCatalogProduct);
      const cart = buildValidatedCart(checkoutRequest.items, catalogProducts);

      const invoice = await createHelcimInvoice({
        currency: "CAD",
        type: "INVOICE",
        status: "DUE",
        notes: "Lash Her website checkout",
        lineItems: cart.lineItems.map(({ sku, description, quantity, price }) => ({
          sku,
          description,
          quantity,
          price,
        })),
      });

      const helcimPaySession = await initializeHelcimPay({
        paymentType: "purchase",
        amount: cart.amount,
        currency: "CAD",
        invoiceNumber: invoice.invoiceNumber,
      });

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
        error: error instanceof Error ? error.message : "Unknown checkout error",
      });

      return NextResponse.json<CheckoutErrorBody>(
        { error: "Unable to start checkout" },
        { status: 400 },
      );
    }
  };
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

  if (name === null || email === null || !isValidCheckoutEmail(email) || shippingAddress === null) {
    return null;
  }

  return {
    customer: { name, email },
    items: body.items.map(toCartInputItem),
    shippingAddress,
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
    currency: product.currency,
    isAvailable: product.isAvailable,
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      isAvailable: variant.isAvailable,
    })),
  };
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
