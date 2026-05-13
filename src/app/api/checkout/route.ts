import { NextResponse, type NextRequest } from "next/server";

import { loaders } from "@/data/loaders";
import {
  buildValidatedCart,
  type CartInputItem,
  type CatalogProduct,
} from "@/lib/commerce/cart";
import { createHelcimInvoice, initializeHelcimPay } from "@/lib/commerce/helcim-client";
import { createPendingOrder } from "@/lib/commerce/order-store";
import type { TSellableProduct } from "@/types";

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

export async function POST(req: NextRequest): Promise<Response> {
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
    const products = await loaders.getSellableProductsByIds(productIds);
    const cart = buildValidatedCart(checkoutRequest.items, products.map(toCatalogProduct));

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

function toCatalogProduct(product: TSellableProduct): CatalogProduct {
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
