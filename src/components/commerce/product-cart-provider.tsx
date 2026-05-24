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

export const PRODUCT_CART_STORAGE_KEY = "lash-her:product-cart:v1";

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProductCartState {
  items: CartInputItem[];
  isOpen: boolean;
}

export type ProductCartInputItem = Omit<CartInputItem, "quantity"> & {
  quantity?: number;
};

export type ProductCartAction =
  | { type: "hydrate"; items: CartInputItem[] }
  | { type: "addItem"; item: ProductCartInputItem }
  | { type: "removeItem"; productId: string; variantId?: string }
  | { type: "updateQuantity"; productId: string; variantId?: string; quantity: number }
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
};

const ProductCartContext = createContext<ProductCartContextValue | null>(null);

export function ProductCartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(productCartReducer, initialState);

  const hasHydratedRef = useRef(false);

  useEffect(() => {
    if (!hasHydratedRef.current) return;
    persistProductCartItems(state.items, getBrowserStorage());
  }, [state.items]);

  useEffect(() => {
    dispatch({ type: "hydrate", items: loadProductCartItems(getBrowserStorage()) });
    hasHydratedRef.current = true;
  }, []);

  const value = useMemo<ProductCartContextValue>(
    () => ({
      ...state,
      addItem: (item) => dispatch({ type: "addItem", item }),
      removeItem: (productId, variantId) => dispatch({ type: "removeItem", productId, variantId }),
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

  return <ProductCartContext.Provider value={value}>{children}</ProductCartContext.Provider>;
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
      return { ...state, items: normalizeCartItems(action.items) };
    case "addItem":
      return { ...state, items: addCartItem(state.items, action.item) };
    case "removeItem":
      return {
        ...state,
        items: state.items.filter(
          (item) => !isMatchingLineItem(item, action.productId, action.variantId),
        ),
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
      return { ...state, items: [] };
    case "openCart":
      return { ...state, isOpen: true };
    case "closeCart":
      return { ...state, isOpen: false };
    default:
      return state;
  }
}

export function createBuyNowPayload(item: ProductCartInputItem): CartInputItem[] {
  return [normalizeCartInputItem(item)];
}

export function loadProductCartItems(storage: StorageLike | null = getBrowserStorage()): CartInputItem[] {
  if (!storage) return [];

  try {
    const rawItems = storage.getItem(PRODUCT_CART_STORAGE_KEY);
    if (!rawItems) return [];

    const parsedItems: unknown = JSON.parse(rawItems);
    if (!Array.isArray(parsedItems)) {
      resetStoredCart(storage);
      return [];
    }

    return normalizeCartItems(parsedItems);
  } catch {
    resetStoredCart(storage);
    return [];
  }
}

export function persistProductCartItems(
  items: CartInputItem[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;

  try {
    storage.setItem(PRODUCT_CART_STORAGE_KEY, JSON.stringify(normalizeCartItems(items)));
  } catch {
    // Storage write failures (e.g., quota exceeded, private mode) are silently ignored.
    // The cart remains functional in memory for the current session.
  }
}

function addCartItem(items: CartInputItem[], item: ProductCartInputItem): CartInputItem[] {
  const normalizedItem = normalizeCartInputItem(item);
  const existingItem = items.find((candidate) =>
    isMatchingLineItem(candidate, normalizedItem.productId, normalizedItem.variantId),
  );

  if (!existingItem) {
    return [...items, normalizedItem];
  }

  return items.map((candidate) =>
    isMatchingLineItem(candidate, normalizedItem.productId, normalizedItem.variantId)
      ? { ...candidate, quantity: clampQuantity(candidate.quantity + normalizedItem.quantity) }
      : candidate,
  );
}

function normalizeCartItems(items: unknown[]): CartInputItem[] {
  return items.reduce<CartInputItem[]>((normalizedItems, item) => {
    if (!isCartInputLike(item)) return normalizedItems;
    return addCartItem(normalizedItems, item);
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
    (candidate.variantId === undefined || typeof candidate.variantId === "string") &&
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

function resetStoredCart(storage: StorageLike): void {
  try {
    storage.setItem(PRODUCT_CART_STORAGE_KEY, JSON.stringify([]));
  } catch {
    // If reset fails, try removing the key entirely.
    try {
      storage.removeItem(PRODUCT_CART_STORAGE_KEY);
    } catch {
      // If removing the key also fails, the cart still resets in memory for this session.
    }
  }
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
