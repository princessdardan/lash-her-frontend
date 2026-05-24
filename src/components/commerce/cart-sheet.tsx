"use client";

import { useMemo, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type ValidatedCart } from "@/lib/commerce/cart";
import type { TProduct } from "@/types";
import { useProductCart } from "./product-cart-provider";

interface CartSheetProps {
  products: TProduct[];
}

export function CartSheet({ products }: CartSheetProps): ReactElement {
  const router = useRouter();
  const { items, isOpen, removeItem, updateQuantity, clearCart, closeCart } = useProductCart();
  const { cartError, validatedCart } = useMemo<{ cartError: string | null; validatedCart: ValidatedCart | null }>(() => {
    if (!isOpen || items.length === 0) {
      return { cartError: null, validatedCart: null };
    }

    try {
      const catalogProducts = products.map((p) => ({
        id: p._id,
        sku: p.sku,
        title: p.title,
        price: p.price,
        currency: p.currency,
        isAvailable: p.isAvailable,
        variants: p.variants?.map((variant) => ({
          id: variant._key,
          sku: variant.sku,
          title: variant.title,
          price: variant.price,
          isAvailable: variant.isAvailable,
        })),
      }));

      const cart = buildValidatedCart(items, catalogProducts);
      return { cartError: null, validatedCart: cart };
    } catch (err) {
      return { cartError: err instanceof Error ? err.message : "Invalid cart", validatedCart: null };
    }
  }, [isOpen, items, products]);

  const handleClose = () => {
    closeCart();
  };

  const handleCheckout = () => {
    closeCart();
    router.push("/checkout");
  };

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent side="right" className="w-full px-5 pb-5 pt-5 sm:max-w-md sm:px-6 sm:pb-6 sm:pt-6 flex flex-col gap-0">
        <SheetHeader className="space-y-2 p-0 pr-8">
          <SheetTitle className="font-heading text-2xl font-normal text-lh-shadow">
            Your Cart
          </SheetTitle>
          <SheetDescription className="text-lh-muted text-sm font-body">
            {totalItems === 0
              ? "Your cart is empty"
              : `${totalItems} item${totalItems !== 1 ? "s" : ""} in your cart`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-6" aria-live="polite">
          {items.length === 0 ? (
            <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
              <h3 className="font-heading text-2xl font-normal text-lh-shadow">Your cart is empty</h3>
              <p className="mt-2 font-body text-sm font-bold leading-6 text-lh-muted">
                Add a product from the catalog to begin checkout.
              </p>
            </div>
          ) : cartError ? (
            <p className="text-lh-accent text-sm font-body font-bold">{cartError}</p>
          ) : validatedCart ? (
            <div className="flex flex-col gap-4">
              <ul className="divide-y divide-lh-line">
                {validatedCart.lineItems.map((lineItem) => (
                  <li
                    key={`${lineItem.productId}:${lineItem.variantId || "default"}`}
                    className="py-3 flex justify-between items-start"
                  >
                    <div className="flex-1">
                      <p className="font-body font-bold text-lh-shadow">{lineItem.description}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="font-body text-sm font-bold text-lh-muted">Qty</span>
                        <button
                          type="button"
                          onClick={() =>
                            updateQuantity(lineItem.productId, lineItem.quantity - 1, lineItem.variantId)
                          }
                          disabled={lineItem.quantity <= 1}
                          aria-label={`Decrease quantity for ${lineItem.description}`}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-lh-line bg-lh-neutral-2/70 font-body text-sm font-bold text-lh-shadow transition-colors hover:border-lh-primary hover:bg-lh-primary-soft hover:text-lh-primary focus-visible:outline-lh-primary disabled:cursor-not-allowed disabled:bg-lh-neutral disabled:text-lh-muted disabled:opacity-70"
                        >
                          -
                        </button>
                        <span className="min-w-6 text-center font-body text-sm font-bold text-lh-shadow">
                          {lineItem.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            updateQuantity(lineItem.productId, lineItem.quantity + 1, lineItem.variantId)
                          }
                          disabled={lineItem.quantity >= 10}
                          aria-label={`Increase quantity for ${lineItem.description}`}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-lh-line bg-lh-neutral-2/70 font-body text-sm font-bold text-lh-shadow transition-colors hover:border-lh-primary hover:bg-lh-primary-soft hover:text-lh-primary focus-visible:outline-lh-primary disabled:cursor-not-allowed disabled:bg-lh-neutral disabled:text-lh-muted disabled:opacity-70"
                        >
                          +
                        </button>
                        <span className="font-body text-sm font-bold text-lh-muted">
                          × {formatCad(lineItem.price)}
                        </span>
                      </div>
                    </div>
                    <div className="text-right ml-4">
                      <p className="font-bold text-lh-shadow">{formatCad(lineItem.total)}</p>
                      <button
                        aria-label={`Remove ${lineItem.description} from cart`}
                        onClick={() => removeItem(lineItem.productId, lineItem.variantId)}
                        className="text-xs text-lh-accent hover:underline mt-1 font-body"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="border-t border-lh-line pt-4 mt-2">
                <div className="flex justify-between items-center mb-6">
                  <span className="font-bold text-xl text-lh-shadow">Total</span>
                  <span className="font-bold text-xl text-lh-primary">{formatCad(validatedCart.amount)}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {items.length > 0 && validatedCart && !cartError && (
          <div className="border-t border-lh-line pt-5 space-y-4">
            <p className="font-body text-sm font-bold leading-6 text-lh-muted">
              Review your shipping details and complete secure payment on the checkout page.
            </p>

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                onClick={handleCheckout}
                className="btn-primary-red w-full"
              >
                Checkout
              </Button>
              <Button
                variant="ghost"
                onClick={clearCart}
                className="text-lh-muted hover:text-lh-accent"
              >
                Clear Cart
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
