"use client";

import { useMemo, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [promotionCodeInput, setPromotionCodeInput] = useState("");
  const [redeemedPromotionCode, setRedeemedPromotionCode] = useState<string | undefined>();
  const [promotionPreviewCart, setPromotionPreviewCart] = useState<ValidatedCart | null>(null);
  const [promotionPreviewCartKey, setPromotionPreviewCartKey] = useState<string | undefined>();
  const [promotionCodeError, setPromotionCodeError] = useState<string | null>(null);
  const [isApplyingPromotionCode, setIsApplyingPromotionCode] = useState(false);
  const itemsKey = useMemo(() => JSON.stringify(items), [items]);
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
        discountPrice: p.discountPrice,
        currency: p.currency,
        isAvailable: p.isAvailable,
        variants: p.variants?.map((variant) => ({
          id: variant._key,
          sku: variant.sku,
          title: variant.title,
          price: variant.price,
          discountPrice: variant.discountPrice,
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

  const hasPromotionPreview = promotionPreviewCartKey === itemsKey && promotionPreviewCart !== null;
  const activeRedeemedPromotionCode = hasPromotionPreview ? redeemedPromotionCode : undefined;
  const displayedCart = hasPromotionPreview ? promotionPreviewCart : validatedCart;

  const handleCheckout = () => {
    closeCart();
    router.push(activeRedeemedPromotionCode ? `/checkout?promotionCode=${encodeURIComponent(activeRedeemedPromotionCode)}` : "/checkout");
  };

  const handleApplyPromotionCode = async () => {
    if (!validatedCart || !promotionCodeInput.trim()) return;

    setPromotionCodeError(null);
    setIsApplyingPromotionCode(true);

    try {
      const response = await fetch("/api/promotion-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "product",
          promotionCode: promotionCodeInput,
          items,
        }),
      });

      if (!response.ok) {
        setPromotionCodeError("This code is not valid for your cart.");
        setRedeemedPromotionCode(undefined);
        return;
      }

      const data = await response.json() as { promotionCode?: string; cart?: ValidatedCart };
      if (!data.promotionCode || !data.cart) {
        setPromotionCodeError("This code is not valid for your cart.");
        setRedeemedPromotionCode(undefined);
        setPromotionPreviewCart(null);
        return;
      }

      setRedeemedPromotionCode(data.promotionCode);
      setPromotionPreviewCart(data.cart);
      setPromotionPreviewCartKey(itemsKey);
      setPromotionCodeInput(data.promotionCode);
    } catch {
      setPromotionCodeError("We could not apply this code. Please try again.");
      setRedeemedPromotionCode(undefined);
      setPromotionPreviewCart(null);
    } finally {
      setIsApplyingPromotionCode(false);
    }
  };

  const handleRemovePromotionCode = () => {
    setRedeemedPromotionCode(undefined);
    setPromotionPreviewCart(null);
    setPromotionPreviewCartKey(undefined);
    setPromotionCodeError(null);
  };

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const cartAmountBeforePromotion = displayedCart
    ? Math.round((displayedCart.amount + (displayedCart.promotionDiscountAmount ?? 0)) * 100) / 100
    : 0;

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
          ) : displayedCart ? (
            <div className="flex flex-col gap-4">
              <ul className="divide-y divide-lh-line">
                {displayedCart.lineItems.map((lineItem) => (
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
                          {lineItem.originalPrice ? (
                            <span className="ml-2 line-through">{formatCad(lineItem.originalPrice)}</span>
                          ) : null}
                        </span>
                      </div>
                    </div>
                    <div className="text-right ml-4">
                      {lineItem.originalTotal ? (
                        <p className="text-xs font-bold text-lh-muted line-through">{formatCad(lineItem.originalTotal)}</p>
                      ) : null}
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
                <div className="rounded-[22px] border border-lh-line bg-lh-neutral-2/60 p-4 mb-4">
                  <label htmlFor="cart-promotion-code" className="block text-sm font-bold text-lh-primary mb-2">
                    Promotion code
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="cart-promotion-code"
                      value={promotionCodeInput}
                      onChange={(event) => setPromotionCodeInput(event.target.value.toUpperCase())}
                      placeholder="Enter code"
                      disabled={isApplyingPromotionCode}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={activeRedeemedPromotionCode ? handleRemovePromotionCode : handleApplyPromotionCode}
                      disabled={isApplyingPromotionCode || (!activeRedeemedPromotionCode && !promotionCodeInput.trim())}
                      className="rounded-full border-lh-primary/30 px-4 font-body text-xs uppercase tracking-[0.12em]"
                    >
                      {isApplyingPromotionCode ? "Applying" : activeRedeemedPromotionCode ? "Remove" : "Apply"}
                    </Button>
                  </div>
                  {activeRedeemedPromotionCode ? (
                    <p className="mt-2 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-primary">
                      Code {activeRedeemedPromotionCode} applied.
                    </p>
                  ) : null}
                  {promotionCodeError ? (
                    <p className="mt-2 font-body text-xs font-bold text-lh-accent" role="alert">
                      {promotionCodeError}
                    </p>
                  ) : null}
                </div>
                {displayedCart.manualDiscountAmount ? (
                  <div className="mb-2 flex justify-between font-body text-sm font-bold text-lh-muted">
                    <span>Manual discounts</span>
                    <span>-{formatCad(displayedCart.manualDiscountAmount)}</span>
                  </div>
                ) : null}
                {activeRedeemedPromotionCode && displayedCart.promotionDiscountAmount ? (
                  <div className="mb-2 flex justify-between font-body text-sm font-bold text-lh-primary">
                    <span>Code {activeRedeemedPromotionCode}</span>
                    <span>-{formatCad(displayedCart.promotionDiscountAmount)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between items-center mb-6 gap-4">
                  <span className="font-bold text-xl text-lh-shadow">Total</span>
                  <span className="flex flex-wrap items-baseline justify-end gap-2 font-bold text-xl text-lh-primary">
                    {activeRedeemedPromotionCode && displayedCart.promotionDiscountAmount ? (
                      <span className="text-sm text-lh-muted line-through">{formatCad(cartAmountBeforePromotion)}</span>
                    ) : null}
                    <span>{formatCad(displayedCart.amount)}</span>
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {items.length > 0 && displayedCart && !cartError && (
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
