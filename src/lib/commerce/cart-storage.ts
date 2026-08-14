import type { CartInputItem } from "./cart";

export const LEGACY_PRODUCT_CART_STORAGE_KEY = "lash-her:product-cart:v1";
export const PRODUCT_CART_STORAGE_KEY = "lash-her:product-cart:v2";
export const PRODUCT_CART_EXPIRY_KEY = "lash-her:product-cart:expires-at";

// 30 days in milliseconds
const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ProductCartStorageEnvelopeV2 {
  version: 2;
  items: CartInputItem[];
  expiresAt: number;
  updatedAt: number;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
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

    const rawItems =
      storage.getItem(PRODUCT_CART_STORAGE_KEY) ??
      storage.getItem(LEGACY_PRODUCT_CART_STORAGE_KEY);
    if (!rawItems) return [];

    const parsed: unknown = JSON.parse(rawItems);
    const parsedItems = Array.isArray(parsed)
      ? parsed
      : isV2Envelope(parsed)
        ? parsed.items
        : null;
    if (!parsedItems) {
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
    const now = Date.now();
    const expiresAt = now + CART_TTL_MS;
    const envelope: ProductCartStorageEnvelopeV2 = {
      version: 2,
      items,
      expiresAt,
      updatedAt: now,
    };
    storage.setItem(PRODUCT_CART_STORAGE_KEY, JSON.stringify(envelope));
    storage.removeItem(LEGACY_PRODUCT_CART_STORAGE_KEY);
    storage.setItem(PRODUCT_CART_EXPIRY_KEY, String(expiresAt));
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
    storage.removeItem(LEGACY_PRODUCT_CART_STORAGE_KEY);
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
    persistProductCartItems([], storage);
  } catch {
    try {
      storage.removeItem(PRODUCT_CART_STORAGE_KEY);
      storage.removeItem(LEGACY_PRODUCT_CART_STORAGE_KEY);
      storage.removeItem(PRODUCT_CART_EXPIRY_KEY);
    } catch {
      // If removing the key also fails, the cart still resets in memory for this session.
    }
  }
}

function isV2Envelope(value: unknown): value is ProductCartStorageEnvelopeV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProductCartStorageEnvelopeV2>;
  return (
    candidate.version === 2 &&
    Array.isArray(candidate.items) &&
    typeof candidate.expiresAt === "number" &&
    Number.isFinite(candidate.expiresAt) &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt)
  );
}
