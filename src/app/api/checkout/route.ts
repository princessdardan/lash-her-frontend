import { NextResponse, type NextRequest } from "next/server";

import {
  buildValidatedCart,
  type CartInputItem,
  type CatalogProduct,
  type ValidatedCart,
} from "@/lib/commerce/cart";
import type { TProduct, TSellableProduct } from "@/types";

interface CheckoutCustomerInput {
  name: string;
  email: string;
}

interface CheckoutRequestBody {
  customer: CheckoutCustomerInput;
  items: CartInputItem[];
}

interface CheckoutResponseBody {
  checkoutToken: string;
}

interface CheckoutErrorBody {
  error: string;
}

interface CheckoutPostHandlerDependencies {
  getProductsByIds: (ids: string[]) => Promise<TProduct[]>;
  getSellableProductsByIds: (ids: string[]) => Promise<TSellableProduct[]>;
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
}

export function createCheckoutPostHandler({
  getProductsByIds,
  getSellableProductsByIds,
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
      const [products, sellableProducts] = await Promise.all([
        getProductsByIds(productIds),
        getSellableProductsByIds(productIds),
      ]);
      const catalogProducts = mergeCatalogProducts(
        products.map(toCatalogProduct),
        sellableProducts.map(toCatalogProduct),
      );
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
  const [{ loaders }, { createHelcimInvoice, initializeHelcimPay }, { createPendingOrder }] =
    await Promise.all([
      import("@/data/loaders"),
      import("@/lib/commerce/helcim-client"),
      import("@/lib/commerce/order-store"),
    ]);

  return createCheckoutPostHandler({
    getProductsByIds: loaders.getProductsByIds,
    getSellableProductsByIds: loaders.getSellableProductsByIds,
    createHelcimInvoice,
    initializeHelcimPay,
    createPendingOrder,
  })(req);
}

function parseCheckoutRequest(body: unknown): CheckoutRequestBody | null {
  if (!isRecord(body) || !isRecord(body.customer) || !Array.isArray(body.items)) {
    return null;
  }

  const name = parseRequiredString(body.customer.name);
  const email = parseRequiredString(body.customer.email);

  if (name === null || email === null) {
    return null;
  }

  return {
    customer: { name, email },
    items: body.items.map(toCartInputItem),
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

function mergeCatalogProducts(
  products: CatalogProduct[],
  fallbackProducts: CatalogProduct[],
): CatalogProduct[] {
  const productsById = new Map<string, CatalogProduct>();

  for (const product of fallbackProducts) {
    productsById.set(product.id, product);
  }

  for (const product of products) {
    productsById.set(product.id, product);
  }

  return Array.from(productsById.values());
}

function toCatalogProduct(product: TProduct | TSellableProduct): CatalogProduct {
  return {
    id: product._id,
    sku: "sku" in product ? product.sku : undefined,
    title: product.title,
    price: product.price,
    currency: product.currency,
    isAvailable: product.isAvailable,
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: "sku" in variant ? variant.sku : undefined,
      title: variant.title,
      price: variant.price,
      isAvailable: variant.isAvailable,
    })),
  };
}

function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : null;
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
