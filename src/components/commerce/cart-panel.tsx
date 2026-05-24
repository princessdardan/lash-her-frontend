"use client";

import { useEffect, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type ValidatedCart } from "@/lib/commerce/cart";
import type { TProduct, TProductVariant } from "@/types";
import { ProductCard } from "./product-card";
import { HelcimPayButton } from "./helcim-pay-button";
import { useProductCart } from "./product-cart-provider";

interface CartPanelProps {
  products: TProduct[];
}

export function CartPanel({ products }: CartPanelProps): ReactElement {
  const { items, isOpen, addItem, removeItem, updateQuantity, clearCart, openCart, closeCart } = useProductCart();
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCart();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeCart, isOpen]);

  const handleAdd = (product: TProduct, variant?: TProductVariant) => {
    addItem({
      productId: product._id,
      variantId: variant?._key,
      quantity: 1,
    });
    openCart();
  };

  let cart: ValidatedCart | null = null;
  let cartError: string | null = null;
  try {
    if (items.length > 0) {
      const catalogProducts = products.map(p => ({
        id: p._id,
        sku: p._id,
        title: p.title,
        price: p.price,
        currency: p.currency,
        isAvailable: p.isAvailable,
        variants: p.variants?.map((variant) => ({
          id: variant._key,
          sku: variant._key,
          title: variant.title,
          price: variant.price,
          isAvailable: variant.isAvailable,
        })),
      }));
      cart = buildValidatedCart(items, catalogProducts);
    }
  } catch (err) {
    cartError = err instanceof Error ? err.message : "Invalid cart";
  }

  const hasItems = items.length > 0;
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className={`grid grid-cols-1 gap-8 ${isOpen ? "lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]" : ""}`}>
      <div>
        <div className={`grid grid-cols-1 gap-6 ${isOpen ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
          {products.map((product) => (
            <ProductCard key={product._id} product={product} onAdd={handleAdd} />
          ))}
        </div>
      </div>

      {isOpen && (
        <aside aria-label="Shopping cart">
          <div className="soft-panel sticky top-24 bg-lh-white">
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 className="section-subheading">Your Cart</h2>
              <Button
                type="button"
                variant="ghost"
                onClick={closeCart}
                aria-label="Close shopping cart"
                className="px-4 py-2 text-xs uppercase tracking-[0.12em]"
              >
                Close
              </Button>
            </div>

            <div aria-live="polite" className="sr-only">
              {totalItems} items in cart
            </div>

            <div className="flex flex-col gap-4">
              {!hasItems ? (
                <div role="status" className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
                  <h3 className="font-heading text-2xl font-normal text-lh-shadow">Your cart is empty</h3>
                  <p className="mt-2 font-body text-sm font-bold leading-6 text-lh-muted">
                    Add a product from the catalog to begin checkout.
                  </p>
                </div>
              ) : cartError ? (
                <p className="text-lh-accent text-sm">{cartError}</p>
              ) : cart ? (
                <>
                  <ul className="divide-y divide-lh-line">
                    {cart.lineItems.map((lineItem) => (
                      <li key={`${lineItem.productId}:${lineItem.variantId || "default"}`} className="py-3 flex justify-between items-start">
                        <div>
                          <p className="font-body font-bold text-lh-shadow">{lineItem.description}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <span className="font-body text-sm font-bold text-lh-muted">
                              Qty
                            </span>
                            <button
                              type="button"
                              onClick={() => updateQuantity(lineItem.productId, lineItem.quantity - 1, lineItem.variantId)}
                              disabled={lineItem.quantity <= 1}
                              aria-label={`Decrease quantity for ${lineItem.description}`}
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-lh-line bg-lh-neutral-2/70 font-body text-sm font-bold text-lh-shadow transition-colors hover:border-lh-primary hover:bg-lh-primary-soft hover:text-lh-primary focus-visible:outline-lh-primary disabled:cursor-not-allowed disabled:bg-lh-neutral disabled:text-lh-muted disabled:opacity-70"
                            >
                              -
                            </button>
                            <span className="min-w-6 text-center font-body text-sm font-bold text-lh-shadow" aria-live="polite">
                              {lineItem.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateQuantity(lineItem.productId, lineItem.quantity + 1, lineItem.variantId)}
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
                        <div className="text-right">
                          <p className="font-bold text-lh-shadow">{formatCad(lineItem.total)}</p>
                          <button
                            aria-label={`Remove ${lineItem.description} from cart`}
                            onClick={() => removeItem(lineItem.productId, lineItem.variantId)}
                            className="text-xs text-lh-accent hover:underline mt-1"
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
                      <span className="font-bold text-xl text-lh-primary">{formatCad(cart.amount)}</span>
                    </div>

                    <div className="space-y-4 mb-6">
                      <div>
                        <label htmlFor="customerName" className="block text-sm font-bold text-lh-primary mb-1">
                          Name
                        </label>
                        <input
                          id="customerName"
                          type="text"
                          value={customerName}
                          onChange={(e) => setCustomerName(e.target.value)}
                          className="form-input"
                          placeholder="Your full name"
                        />
                      </div>
                      <div>
                        <label htmlFor="customerEmail" className="block text-sm font-bold text-lh-primary mb-1">
                          Email
                        </label>
                        <input
                          id="customerEmail"
                          type="email"
                          value={customerEmail}
                          onChange={(e) => setCustomerEmail(e.target.value)}
                          className="form-input"
                          placeholder="your@email.com"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <HelcimPayButton
                        disabled={!cart || !customerName || !customerEmail}
                        items={items}
                        customer={{ name: customerName, email: customerEmail }}
                        onPaid={clearCart}
                      />
                      <Button
                        variant="ghost"
                        onClick={clearCart}
                        className="text-lh-muted hover:text-lh-accent"
                      >
                        Clear Cart
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
