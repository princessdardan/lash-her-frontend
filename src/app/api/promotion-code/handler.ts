import { NextResponse, type NextRequest } from "next/server";

import { buildValidatedCart, type CartInputItem, type CatalogProduct } from "@/lib/commerce/cart";
import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import { validateTrainingCheckoutRequest } from "@/lib/training-checkout";
import type { TProduct, TPromotionCode, TTrainingProgram } from "@/types";

interface PromotionCodePreviewResponse {
  promotionCode: string;
  discountAmount: number;
  cart?: ReturnType<typeof buildValidatedCart>;
  trainingQuote?: {
    originalSubtotal?: number;
    subtotal: number;
    promotionDiscount: number;
    tax: number;
    total: number;
  };
}

interface PromotionCodeErrorResponse {
  error: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const { loaders } = await import("@/data/loaders");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalidPromotionCodeRequest();
  }

  return createPromotionCodePostHandler({
    getProductsByIds: loaders.getProductsByIds,
    getPromotionCode: loaders.getPromotionCode,
    getTrainingProgramBySlug: (slug) => loaders.getTrainingProgramBySlug(slug, { mode: "published", stega: false }),
  })(body);
}

export function createPromotionCodePostHandler(dependencies: {
  getProductsByIds: (ids: string[]) => Promise<TProduct[]>;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  getTrainingProgramBySlug: (slug: string) => Promise<TTrainingProgram | null>;
}): (body: unknown) => Promise<Response> {
  return async function promotionCodePostHandler(body: unknown): Promise<Response> {
    if (!isRecord(body) || typeof body.targetType !== "string") {
      return invalidPromotionCodeRequest();
    }

    const promotionCodeInput = parsePromotionCodeInput(body.promotionCode ?? body.discountCode);
    if (!promotionCodeInput) {
      return invalidPromotionCodeRequest();
    }

    const promotionCode = await dependencies.getPromotionCode(promotionCodeInput);

    if (body.targetType === "product") {
      if (!Array.isArray(body.items)) return invalidPromotionCodeRequest();

      try {
        const items = body.items.map(toCartInputItem);
        const productIds = Array.from(new Set(items.map((item) => item.productId)));
        const products = await dependencies.getProductsByIds(productIds);
        const cart = buildValidatedCart(items, products.map(toCatalogProduct), { promotionCode });

        if (cart.promotionCode !== promotionCodeInput || !cart.promotionDiscountAmount) {
          return invalidPromotionCode();
        }

        return NextResponse.json<PromotionCodePreviewResponse>({
          promotionCode: cart.promotionCode,
          discountAmount: cart.promotionDiscountAmount,
          cart,
        });
      } catch {
        return invalidPromotionCode();
      }
    }

    if (body.targetType === "trainingProgram") {
      if (typeof body.programSlug !== "string" || body.programSlug.trim().length === 0) {
        return invalidPromotionCodeRequest();
      }

      const program = await dependencies.getTrainingProgramBySlug(body.programSlug.trim());
      const validation = validateTrainingCheckoutRequest(
        program,
        {
          programSlug: body.programSlug.trim(),
          customerName: "Promotion Preview",
          customerEmail: "promotion-preview@lashher.com",
          promotionCode: promotionCodeInput,
        },
        promotionCode,
      );

      if (!validation.ok || validation.quote.promotionCode !== promotionCodeInput) {
        return invalidPromotionCode();
      }

      const { quote } = validation;
      return NextResponse.json<PromotionCodePreviewResponse>({
        promotionCode: promotionCodeInput,
        discountAmount: quote.promotionDiscount,
        trainingQuote: {
          ...(quote.originalSubtotal !== undefined ? { originalSubtotal: quote.originalSubtotal } : {}),
          subtotal: quote.subtotal,
          promotionDiscount: quote.promotionDiscount,
          tax: quote.tax,
          total: quote.total,
        },
      });
    }

    return invalidPromotionCodeRequest();
  };
}

function toCartInputItem(item: unknown): CartInputItem {
  if (!isRecord(item)) return { productId: "", quantity: Number.NaN };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPromotionCodeRequest(): NextResponse<PromotionCodeErrorResponse> {
  return NextResponse.json<PromotionCodeErrorResponse>(
    { error: "Invalid promotion code request" },
    { status: 400 },
  );
}

function invalidPromotionCode(): NextResponse<PromotionCodeErrorResponse> {
  return NextResponse.json<PromotionCodeErrorResponse>(
    { error: "Invalid promotion code" },
    { status: 400 },
  );
}
