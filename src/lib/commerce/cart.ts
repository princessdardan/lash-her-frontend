import { addCad, multiplyCad, parseCad } from "./money";
import {
  applyPromotionCode,
  getManualDiscountAmount,
  subtractCad,
  type PromotionCode,
} from "./discounts";
import {
  resolveCheckoutModeFromLineItems,
  type ProductCheckoutMode,
} from "./product-checkout-eligibility";

export type CommerceCurrency = "CAD";

export interface CatalogProduct {
  id: string;
  sku?: string;
  title: string;
  price: number | string;
  discountPrice?: number | string | null;
  currency: CommerceCurrency;
  isAvailable: boolean;
  variants?: CatalogProductVariant[];
  checkoutMode?: ProductCheckoutMode;
}

export interface CatalogProductVariant {
  id: string;
  sku?: string;
  title: string;
  price: number | string;
  discountPrice?: number | string | null;
  isAvailable: boolean;
  options?: Array<{ label: string; value: string }>;
  checkoutMode?: ProductCheckoutMode;
}

export interface CartInputItem {
  productId: string;
  variantId?: string;
  quantity: number;
  checkoutMode?: ProductCheckoutMode;
}

export interface ValidatedCartLineItem {
  productId: string;
  variantId?: string;
  sku: string;
  description: string;
  productTitle?: string;
  variantTitle?: string;
  selectedOptions?: Array<{ label: string; value: string }>;
  checkoutMode?: ProductCheckoutMode;
  quantity: number;
  price: number;
  originalPrice?: number;
  manualDiscount?: number;
  total: number;
  originalTotal?: number;
}

export interface ValidatedCart {
  currency: CommerceCurrency;
  /** Product checkout only. Booking and training carts omit this. */
  checkoutMode?: ProductCheckoutMode;
  amount: number;
  amountBeforePromotion?: number;
  originalAmount?: number;
  manualDiscountAmount?: number;
  promotionCode?: string;
  promotionDiscountAmount?: number;
  lineItems: ValidatedCartLineItem[];
}

export interface BuildValidatedCartOptions {
  promotionCode?: PromotionCode | null;
}

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;
export const MAX_CART_LINE_ITEMS = 20;
const CART_EMPTY_ERROR = "Cart must contain at least one item";
const QUANTITY_ERROR = "Quantity must be between 1 and 10";
const UNAVAILABLE_PRODUCT_ERROR = "Product is no longer available";
const VARIANT_REQUIRED_ERROR = "Please choose an available product option";

export function buildValidatedCart(
  items: CartInputItem[],
  products: CatalogProduct[],
  options: BuildValidatedCartOptions = {},
): ValidatedCart {
  if (items.length === 0) {
    throw new Error(CART_EMPTY_ERROR);
  }
  if (items.length > MAX_CART_LINE_ITEMS) {
    throw new Error(
      `Cart cannot contain more than ${MAX_CART_LINE_ITEMS} line items`,
    );
  }

  const productsById = new Map(
    products.map((product) => [product.id, product]),
  );
  const lineItems = items.map((item) => {
    assertValidQuantity(item.quantity);

    const product = productsById.get(item.productId);

    if (!product?.isAvailable) {
      throw new Error(UNAVAILABLE_PRODUCT_ERROR);
    }

    const variant = resolveVariant(product, item.variantId);
    const originalPrice = parseCad(variant?.price ?? product.price);
    const pricing = resolveEffectivePrice(
      variant?.price ?? product.price,
      variant?.discountPrice ?? product.discountPrice,
    );
    const price = pricing.price;
    const manualDiscount = getManualDiscountAmount({ price, originalPrice });
    const description = variant
      ? `${product.title} — ${variant.title}`
      : product.title;
    const total = multiplyCad(price, item.quantity);
    const originalTotal =
      manualDiscount > 0
        ? multiplyCad(originalPrice, item.quantity)
        : undefined;

    return {
      productId: product.id,
      ...(variant ? { variantId: variant.id } : {}),
      sku: resolveLineItemSku(product, variant),
      description,
      productTitle: product.title,
      ...(variant ? { variantTitle: variant.title } : {}),
      ...(variant?.options?.length ? { selectedOptions: variant.options } : {}),
      ...((variant?.checkoutMode ?? product.checkoutMode)
        ? { checkoutMode: variant?.checkoutMode ?? product.checkoutMode }
        : {}),
      quantity: item.quantity,
      price,
      ...(originalTotal !== undefined ? { originalPrice, originalTotal } : {}),
      ...(manualDiscount > 0 ? { manualDiscount } : {}),
      total,
    };
  });

  const amount = addCad(lineItems.map((lineItem) => lineItem.total));
  const hasExplicitCheckoutMode = lineItems.some(
    (lineItem) => lineItem.checkoutMode !== undefined,
  );
  const checkoutMode = hasExplicitCheckoutMode
    ? resolveCheckoutModeFromLineItems(lineItems)
    : undefined;
  const originalAmount = addCad(
    lineItems.map((lineItem) => lineItem.originalTotal ?? lineItem.total),
  );
  const manualDiscountAmount = subtractCad(originalAmount, amount);
  const promotionBaseAmount = getPromotionBaseAmount(
    lineItems,
    options.promotionCode,
    amount,
  );
  const promotionDiscount = applyPromotionCode({
    promotionCode: options.promotionCode,
    targetType: "product",
    targetIds: lineItems.map((lineItem) => lineItem.productId),
    amount: promotionBaseAmount,
  });
  const promotionDiscountAmount = promotionDiscount?.amount ?? 0;
  const finalAmount = subtractCad(amount, promotionDiscountAmount);

  return {
    currency: "CAD",
    ...(checkoutMode ? { checkoutMode } : {}),
    amount: finalAmount,
    ...(promotionDiscountAmount > 0 ? { amountBeforePromotion: amount } : {}),
    ...(manualDiscountAmount > 0 || promotionDiscountAmount > 0
      ? { originalAmount }
      : {}),
    ...(manualDiscountAmount > 0 ? { manualDiscountAmount } : {}),
    ...(promotionDiscount ? { promotionCode: promotionDiscount.code } : {}),
    ...(promotionDiscountAmount > 0 ? { promotionDiscountAmount } : {}),
    lineItems,
  };
}

function getPromotionBaseAmount(
  lineItems: ValidatedCartLineItem[],
  promotionCode: PromotionCode | null | undefined,
  cartAmount: number,
): number {
  if (promotionCode?.appliesTo !== "specificItems") return cartAmount;

  const eligibleProductIds = new Set(
    promotionCode.products?.map((product) => product._id) ?? [],
  );
  if (eligibleProductIds.size === 0) return 0;

  return addCad(
    lineItems
      .filter((lineItem) => eligibleProductIds.has(lineItem.productId))
      .map((lineItem) => lineItem.total),
  );
}

export function resolveEffectivePrice(
  priceInput: number | string,
  discountPriceInput?: number | string | null,
): { price: number; originalPrice?: number; manualDiscount: number } {
  const originalPrice = parseCad(priceInput);
  if (discountPriceInput == null) {
    return { price: originalPrice, manualDiscount: 0 };
  }

  const discountPrice = parseCad(discountPriceInput);
  const price = discountPrice < originalPrice ? discountPrice : originalPrice;
  const manualDiscount = getManualDiscountAmount({ price, originalPrice });
  return {
    price,
    ...(manualDiscount > 0 ? { originalPrice } : {}),
    manualDiscount,
  };
}

function resolveVariant(
  product: CatalogProduct,
  variantId: string | undefined,
): CatalogProductVariant | null {
  const variants = product.variants?.filter((variant) => variant.title) ?? [];

  if (variants.length === 0) {
    return null;
  }

  const variant = variants.find((candidate) => candidate.id === variantId);

  if (!variant?.isAvailable) {
    throw new Error(VARIANT_REQUIRED_ERROR);
  }

  return variant;
}

function resolveLineItemSku(
  product: CatalogProduct,
  variant: CatalogProductVariant | null,
): string {
  if (variant) {
    return variant.sku || `${product.id}:${variant.id}`;
  }

  return product.sku || product.id;
}

function assertValidQuantity(quantity: number): void {
  if (
    !Number.isInteger(quantity) ||
    quantity < MIN_QUANTITY ||
    quantity > MAX_QUANTITY
  ) {
    throw new Error(QUANTITY_ERROR);
  }
}
