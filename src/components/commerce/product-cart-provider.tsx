"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { CartInputItem } from "@/lib/commerce/cart";
import { MAX_CART_LINE_ITEMS } from "@/lib/commerce/cart";
import {
  loadProductCartItems,
  persistProductCartItems,
} from "@/lib/commerce/cart-storage";

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;

export interface ProductCartState {
  items: CartInputItem[];
  isOpen: boolean;
  limitMessage: string | null;
}

export type ProductCartInputItem = Omit<CartInputItem, "quantity"> & {
  quantity?: number;
};

export type ProductCartAction =
  | { type: "hydrate"; items: CartInputItem[] }
  | { type: "addItem"; item: ProductCartInputItem }
  | { type: "removeItem"; productId: string; variantId?: string }
  | {
      type: "updateQuantity";
      productId: string;
      variantId?: string;
      quantity: number;
    }
  | { type: "clearCart" }
  | { type: "openCart" }
  | { type: "closeCart" };

export interface ProductCartContextValue extends ProductCartState {
  addItem(item: ProductCartInputItem): void;
  removeItem(productId: string, variantId?: string): void;
  updateQuantity(productId: string, quantity: number, variantId?: string): void;
  clearCart(): void;
  openCart(): void;
  closeCart(): void;
  createBuyNowPayload(item: ProductCartInputItem): CartInputItem[];
}

const initialState: ProductCartState = {
  items: [],
  isOpen: false,
  limitMessage: null,
};

const ProductCartContext = createContext<ProductCartContextValue | null>(null);

export function ProductCartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(productCartReducer, initialState);
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    persistProductCartItems(state.items);
  }, [state.items]);

  useEffect(() => {
    const storedItems = normalizeCartItems(loadProductCartItems());
    dispatch({ type: "hydrate", items: storedItems });
    queueMicrotask(() => {
      hasHydratedRef.current = true;
      persistProductCartItems(storedItems);
    });
  }, []);

  const value = useMemo<ProductCartContextValue>(
    () => ({
      ...state,
      addItem: (item) => dispatch({ type: "addItem", item }),
      removeItem: (productId, variantId) =>
        dispatch({ type: "removeItem", productId, variantId }),
      updateQuantity: (productId, quantity, variantId) => {
        dispatch({ type: "updateQuantity", productId, variantId, quantity });
      },
      clearCart: () => dispatch({ type: "clearCart" }),
      openCart: () => dispatch({ type: "openCart" }),
      closeCart: () => dispatch({ type: "closeCart" }),
      createBuyNowPayload,
    }),
    [state],
  );

  return (
    <ProductCartContext.Provider value={value}>
      {children}
    </ProductCartContext.Provider>
  );
}

export function useProductCart(): ProductCartContextValue {
  const context = useContext(ProductCartContext);

  if (!context) {
    throw new Error("useProductCart must be used within ProductCartProvider");
  }

  return context;
}

export function productCartReducer(
  state: ProductCartState,
  action: ProductCartAction,
): ProductCartState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        items: normalizeCartItems(action.items),
        limitMessage:
          action.items.length > MAX_CART_LINE_ITEMS
            ? `This saved cart has more than ${MAX_CART_LINE_ITEMS} distinct items. Remove items before checkout.`
            : null,
      };
    case "addItem":
      return addCartItemState(state, action.item);
    case "removeItem":
      const remainingItems = state.items.filter(
        (item) => !isMatchingLineItem(item, action.productId, action.variantId),
      );
      return {
        ...state,
        items: remainingItems,
        limitMessage:
          remainingItems.length > MAX_CART_LINE_ITEMS
            ? state.limitMessage
            : null,
      };
    case "updateQuantity":
      return {
        ...state,
        items: state.items.map((item) =>
          isMatchingLineItem(item, action.productId, action.variantId)
            ? { ...item, quantity: clampQuantity(action.quantity) }
            : item,
        ),
      };
    case "clearCart":
      return { ...state, items: [], limitMessage: null };
    case "openCart":
      return { ...state, isOpen: true };
    case "closeCart":
      return { ...state, isOpen: false };
    default:
      return state;
  }
}

export function createBuyNowPayload(
  item: ProductCartInputItem,
): CartInputItem[] {
  return [normalizeCartInputItem(item)];
}

function addCartItem(
  items: CartInputItem[],
  item: ProductCartInputItem,
): CartInputItem[] {
  const normalizedItem = normalizeCartInputItem(item);
  const existingItem = items.find((candidate) =>
    isMatchingLineItem(
      candidate,
      normalizedItem.productId,
      normalizedItem.variantId,
    ),
  );

  if (!existingItem) {
    return items.length >= MAX_CART_LINE_ITEMS
      ? items
      : [...items, normalizedItem];
  }

  return items.map((candidate) =>
    isMatchingLineItem(
      candidate,
      normalizedItem.productId,
      normalizedItem.variantId,
    )
      ? {
          ...candidate,
          quantity: clampQuantity(candidate.quantity + normalizedItem.quantity),
        }
      : candidate,
  );
}

function addCartItemState(
  state: ProductCartState,
  item: ProductCartInputItem,
): ProductCartState {
  const normalizedItem = normalizeCartInputItem(item);
  const existingItem = state.items.some((candidate) =>
    isMatchingLineItem(
      candidate,
      normalizedItem.productId,
      normalizedItem.variantId,
    ),
  );
  if (!existingItem && state.items.length >= MAX_CART_LINE_ITEMS) {
    return {
      ...state,
      isOpen: true,
      limitMessage: `A cart can contain at most ${MAX_CART_LINE_ITEMS} distinct items. Existing quantities can still be changed.`,
    };
  }
  return {
    ...state,
    items: addCartItem(state.items, item),
    limitMessage: null,
  };
}

function normalizeCartItems(items: unknown[]): CartInputItem[] {
  return items.reduce<CartInputItem[]>((normalizedItems, item) => {
    if (!isCartInputLike(item)) return normalizedItems;
    const normalized = normalizeCartInputItem(item);
    const existingIndex = normalizedItems.findIndex((candidate) =>
      isMatchingLineItem(candidate, normalized.productId, normalized.variantId),
    );
    if (existingIndex < 0) return [...normalizedItems, normalized];
    return normalizedItems.map((candidate, index) =>
      index === existingIndex
        ? {
            ...candidate,
            quantity: clampQuantity(candidate.quantity + normalized.quantity),
          }
        : candidate,
    );
  }, []);
}

function normalizeCartInputItem(item: ProductCartInputItem): CartInputItem {
  return {
    productId: item.productId,
    ...(item.variantId ? { variantId: item.variantId } : {}),
    quantity: clampQuantity(item.quantity ?? MIN_QUANTITY),
  };
}

function isCartInputLike(item: unknown): item is ProductCartInputItem {
  if (!item || typeof item !== "object") return false;

  const candidate = item as Partial<CartInputItem>;
  return (
    typeof candidate.productId === "string" &&
    candidate.productId.length > 0 &&
    (candidate.variantId === undefined ||
      typeof candidate.variantId === "string") &&
    typeof candidate.quantity === "number" &&
    Number.isFinite(candidate.quantity)
  );
}

function isMatchingLineItem(
  item: CartInputItem,
  productId: string,
  variantId: string | undefined,
): boolean {
  return item.productId === productId && item.variantId === variantId;
}

function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return MIN_QUANTITY;
  return Math.max(MIN_QUANTITY, Math.min(MAX_QUANTITY, Math.trunc(quantity)));
}
