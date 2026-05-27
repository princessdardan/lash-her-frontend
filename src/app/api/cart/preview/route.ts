import { NextResponse, type NextRequest } from "next/server";

import { loaders } from "@/data/loaders";
import {
  buildValidatedCart,
  type CartInputItem,
  type CatalogProduct,
  type ValidatedCart,
} from "@/lib/commerce/cart";
import type { TProduct } from "@/types";

interface CartPreviewResponse {
  cart: ValidatedCart;
}

interface CartPreviewErrorResponse {
  error: string;
}

const MAX_CART_PREVIEW_ITEMS = 20;
const MAX_CART_PREVIEW_ID_LENGTH = 128;

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return invalidCartPreviewRequest();
  }

  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_CART_PREVIEW_ITEMS) {
    return invalidCartPreviewRequest();
  }

  let items: CartInputItem[];

  try {
    items = body.items.map(toCartInputItem);
  } catch {
    return invalidCartPreviewRequest();
  }

  try {
    const productIds = Array.from(new Set(items.map((item) => item.productId)));
    const products = await loaders.getProductsByIds(productIds);
    const cart = buildValidatedCart(items, products.map(toCatalogProduct));

    return NextResponse.json<CartPreviewResponse>({ cart });
  } catch {
    return NextResponse.json<CartPreviewErrorResponse>(
      { error: "We could not load your cart. Please update it and try again." },
      { status: 400 },
    );
  }
}

function toCartInputItem(item: unknown): CartInputItem {
  if (!isRecord(item) || !isValidCartIdentifier(item.productId)) {
    throw new Error("Invalid cart preview request");
  }

  if (item.variantId !== undefined && !isValidCartIdentifier(item.variantId)) {
    throw new Error("Invalid cart preview request");
  }

  if (typeof item.quantity !== "number") {
    throw new Error("Invalid cart preview request");
  }

  return {
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidCartIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CART_PREVIEW_ID_LENGTH;
}

function invalidCartPreviewRequest(): NextResponse<CartPreviewErrorResponse> {
  return NextResponse.json<CartPreviewErrorResponse>(
    { error: "Invalid cart preview request" },
    { status: 400 },
  );
}
