import { addCad, multiplyCad, parseCad } from "./money";

export interface CommerceProduct {
  available: boolean;
  description: string;
  id: string;
  price: number | string;
  sku: string;
}

export interface CartSelection {
  productId: string;
  quantity: number;
}

export interface ValidatedCartItem {
  description: string;
  price: number;
  quantity: number;
  sku: string;
  total: number;
}

export interface ValidatedCart {
  amount: number;
  currency: "CAD";
  items: ValidatedCartItem[];
}

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;
const UNAVAILABLE_PRODUCT_ERROR = "Product is no longer available";
const QUANTITY_ERROR = "Quantity must be between 1 and 10";

export function buildValidatedCart(
  selections: ReadonlyArray<CartSelection>,
  products: ReadonlyArray<CommerceProduct>,
): ValidatedCart {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const items = selections.map((selection) => {
    assertValidQuantity(selection.quantity);

    const product = productsById.get(selection.productId);

    if (!product?.available) {
      throw new Error(UNAVAILABLE_PRODUCT_ERROR);
    }

    const price = parseCad(product.price);

    return {
      description: product.description,
      price,
      quantity: selection.quantity,
      sku: product.sku,
      total: multiplyCad(price, selection.quantity),
    };
  });

  return {
    amount: addCad(items.map((item) => item.total)),
    currency: "CAD",
    items,
  };
}

function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    throw new Error(QUANTITY_ERROR);
  }
}
