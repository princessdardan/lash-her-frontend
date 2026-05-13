import { addCad, multiplyCad, parseCad } from "./money";

export type CommerceCurrency = "CAD";

export interface CatalogProduct {
  id: string;
  sku: string;
  title: string;
  price: number | string;
  currency: CommerceCurrency;
  isAvailable: boolean;
  variants?: CatalogProductVariant[];
}

export interface CatalogProductVariant {
  id: string;
  sku: string;
  title: string;
  price: number | string;
  isAvailable: boolean;
}

export interface CartInputItem {
  productId: string;
  variantId?: string;
  quantity: number;
}

export interface ValidatedCartLineItem {
  productId: string;
  variantId?: string;
  sku: string;
  description: string;
  quantity: number;
  price: number;
  total: number;
}

export interface ValidatedCart {
  currency: CommerceCurrency;
  amount: number;
  lineItems: ValidatedCartLineItem[];
}

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;
const CART_EMPTY_ERROR = "Cart must contain at least one item";
const QUANTITY_ERROR = "Quantity must be between 1 and 10";
const UNAVAILABLE_PRODUCT_ERROR = "Product is no longer available";
const VARIANT_REQUIRED_ERROR = "Please choose an available product option";

export function buildValidatedCart(
  items: CartInputItem[],
  products: CatalogProduct[],
): ValidatedCart {
  if (items.length === 0) {
    throw new Error(CART_EMPTY_ERROR);
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const lineItems = items.map((item) => {
    assertValidQuantity(item.quantity);

    const product = productsById.get(item.productId);

    if (!product?.isAvailable) {
      throw new Error(UNAVAILABLE_PRODUCT_ERROR);
    }

    const variant = resolveVariant(product, item.variantId);
    const price = parseCad(variant?.price ?? product.price);
    const description = variant ? `${product.title} — ${variant.title}` : product.title;

    return {
      productId: product.id,
      ...(variant ? { variantId: variant.id } : {}),
      sku: variant?.sku ?? product.sku,
      description,
      quantity: item.quantity,
      price,
      total: multiplyCad(price, item.quantity),
    };
  });

  return {
    currency: "CAD",
    amount: addCad(lineItems.map((lineItem) => lineItem.total)),
    lineItems,
  };
}

function resolveVariant(
  product: CatalogProduct,
  variantId: string | undefined,
): CatalogProductVariant | null {
  const variants = product.variants?.filter((variant) => variant.title && variant.sku) ?? [];

  if (variants.length === 0) {
    return null;
  }

  const variant = variants.find((candidate) => candidate.id === variantId);

  if (!variant?.isAvailable) {
    throw new Error(VARIANT_REQUIRED_ERROR);
  }

  return variant;
}

function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    throw new Error(QUANTITY_ERROR);
  }
}
