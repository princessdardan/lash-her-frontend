"use client";

import { useState, useMemo, useEffect, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type ValidatedCart, type CartInputItem } from "@/lib/commerce/cart";
import type { TProduct } from "@/types";
import { HelcimPayButton } from "@/components/commerce/helcim-pay-button";
import { useProductCart } from "@/components/commerce/product-cart-provider";

interface CheckoutPageClientProps {
  products: TProduct[];
}

export function CheckoutPageClient({ products }: CheckoutPageClientProps): ReactElement {
  const searchParams = useSearchParams();
  const { items: cartItems, clearCart } = useProductCart();

  const isBuyNow = searchParams.get("buyNow") === "1";
  const buyNowProductId = searchParams.get("productId");
  const buyNowVariantId = searchParams.get("variantId");
  const buyNowQuantity = searchParams.get("quantity");

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  // Build checkout items: either buy-now single item or full cart
  const checkoutItems = useMemo<CartInputItem[]>(() => {
    if (isBuyNow && buyNowProductId) {
      const item: CartInputItem = {
        productId: buyNowProductId,
        quantity: Math.max(1, Math.min(10, Number(buyNowQuantity) || 1)),
      };
      if (buyNowVariantId) {
        item.variantId = buyNowVariantId;
      }
      return [item];
    }
    return cartItems;
  }, [isBuyNow, buyNowProductId, buyNowVariantId, buyNowQuantity, cartItems]);

  const cart = useMemo<{ cart: ValidatedCart | null; error: string | null }>(() => {
    if (checkoutItems.length === 0) {
      return { cart: null, error: null };
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
      return { cart: buildValidatedCart(checkoutItems, catalogProducts), error: null };
    } catch (err) {
      return { cart: null, error: err instanceof Error ? err.message : "Invalid cart" };
    }
  }, [checkoutItems, products]);

  const totalItems = checkoutItems.reduce((sum, item) => sum + item.quantity, 0);

  if (checkoutItems.length === 0) {
    return (
      <div className="min-h-screen bg-lh-neutral-2">
        <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
          <div className="content-container max-w-2xl">
            <div className="soft-panel bg-lh-white p-8 md:p-12 text-center">
              <h1 className="font-heading text-3xl font-normal text-lh-shadow mb-4">Your cart is empty</h1>
              <p className="font-body text-sm font-bold text-lh-muted mb-8">
                Add products to your cart before checking out.
              </p>
              <Button asChild variant="primary" className="rounded-full px-8">
                <a href="/products">Browse Products</a>
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-lh-neutral-2">
      <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
        <div className="content-container max-w-2xl">
          <div className="mb-8">
            <p className="eyebrow-label mb-3">{isBuyNow ? "Buy Now" : "Checkout"}</p>
            <h1 className="display-heading text-4xl md:text-5xl">
              {isBuyNow ? "Complete Your Purchase" : "Review Your Order"}
            </h1>
          </div>

          <div className="soft-panel bg-lh-white p-6 md:p-8">
            {cart.error ? (
              <div className="rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 mb-6">
                <p className="font-body text-sm font-bold text-lh-accent">{cart.error}</p>
              </div>
            ) : null}

            {cart.cart ? (
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <span className="font-body text-sm font-bold text-lh-muted">
                    {totalItems} item{totalItems !== 1 ? "s" : ""}
                  </span>
                  {!isBuyNow ? (
                    <a
                      href="/products"
                      className="font-body text-sm font-bold text-lh-primary hover:text-lh-accent transition-colors"
                    >
                      Continue Shopping
                    </a>
                  ) : null}
                </div>

                <ul className="divide-y divide-lh-line">
                  {cart.cart.lineItems.map((lineItem) => (
                    <li
                      key={`${lineItem.productId}:${lineItem.variantId || "default"}`}
                      className="py-4 flex justify-between items-start"
                    >
                      <div>
                        <p className="font-body font-bold text-lh-shadow">{lineItem.description}</p>
                        <p className="font-body text-sm font-bold text-lh-muted">
                          Qty: {lineItem.quantity} × {formatCad(lineItem.price)}
                        </p>
                      </div>
                      <p className="font-body font-bold text-lh-shadow">{formatCad(lineItem.total)}</p>
                    </li>
                  ))}
                </ul>

                <div className="border-t border-lh-line pt-4">
                  <div className="flex justify-between items-center">
                    <span className="font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">Total</span>
                    <span className="font-body text-2xl font-bold text-lh-shadow">{formatCad(cart.cart.amount)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="checkout-name" className="block text-sm font-bold text-lh-primary mb-1">
                      Name
                    </label>
                    <Input
                      id="checkout-name"
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Your full name"
                    >
                    </Input>
                  </div>
                  <div>
                    <label htmlFor="checkout-email" className="block text-sm font-bold text-lh-primary mb-1">
                      Email
                    </label>
                    <Input
                      id="checkout-email"
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder="you@example.com"
                    >
                    </Input>
                  </div>
                </div>

                <div className="mt-2">
                  <HelcimPayButton
                    disabled={!cart.cart || !customerName.trim() || !customerEmail.trim()}
                    items={checkoutItems}
                    customer={{ name: customerName.trim(), email: customerEmail.trim() }}
                    onPaid={isBuyNow ? () => undefined : clearCart}
                  >
                  </HelcimPayButton>
                </div>

                {isBuyNow ? (
                  <p className="font-body text-xs font-bold text-lh-muted">
                    This is a single-item checkout. Your existing cart has not been modified.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
