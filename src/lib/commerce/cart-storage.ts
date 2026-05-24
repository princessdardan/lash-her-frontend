import type { CartInputItem } from "./cart";

export const PRODUCT_CART_STORAGE_KEY = "lash-her:product-cart:v1";
export const PRODUCT_CART_EXPIRY_KEY = "lash-her:product-cart:expires-at";

// 30 days in milliseconds
const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStorageLike(value: unknown): value is StorageLike {
  if (!value || typeof value !== "object") return false;
  const storage = value as Partial<StorageLike>;
  return (
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function loadProductCartItems(
  storage: StorageLike | null = getBrowserStorage(),
): CartInputItem[] {
  if (!storage) return [];

  try {
    // Check expiration first
    const expiryRaw = storage.getItem(PRODUCT_CART_EXPIRY_KEY);
    if (expiryRaw) {
      const expiryTime = Number(expiryRaw);
      if (Number.isFinite(expiryTime) && Date.now() > expiryTime) {
        clearProductCartStorage(storage);
        return [];
      }
    }

    const rawItems = storage.getItem(PRODUCT_CART_STORAGE_KEY);
    if (!rawItems) return [];

    const parsedItems: unknown = JSON.parse(rawItems);
    if (!Array.isArray(parsedItems)) {
      clearProductCartStorage(storage);
      return [];
    }

    return parsedItems as CartInputItem[];
  } catch {
    clearProductCartStorage(storage);
    return [];
  }
}

export function persistProductCartItems(
  items: CartInputItem[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;

  try {
    storage.setItem(PRODUCT_CART_STORAGE_KEY, JSON.stringify(items));
    storage.setItem(PRODUCT_CART_EXPIRY_KEY, String(Date.now() + CART_TTL_MS));
  } catch {
    // Storage write failures (e.g., quota exceeded, private mode) are silently ignored.
    // The cart remains functional in memory for the current session.
  }
}

export function clearProductCartStorage(
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;

  try {
    storage.removeItem(PRODUCT_CART_STORAGE_KEY);
    storage.removeItem(PRODUCT_CART_EXPIRY_KEY);
  } catch {
    // If removal fails, the cart still resets in memory for this session.
  }
}

export function resetStoredCart(
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;

  try {
    storage.setItem(PRODUCT_CART_STORAGE_KEY, JSON.stringify([]));
    storage.setItem(PRODUCT_CART_EXPIRY_KEY, String(Date.now() + CART_TTL_MS));
  } catch {
    try {
      storage.removeItem(PRODUCT_CART_STORAGE_KEY);
      storage.removeItem(PRODUCT_CART_EXPIRY_KEY);
    } catch {
      // If removing the key also fails, the cart still resets in memory for this session.
    }
  }
}
