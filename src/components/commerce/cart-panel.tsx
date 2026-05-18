"use client";

import { useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type CartInputItem, type ValidatedCart } from "@/lib/commerce/cart";
import type { TSellableProduct, TSellableProductVariant } from "@/types";
import { ProductCard } from "./product-card";
import { HelcimPayButton } from "./helcim-pay-button";

interface CartPanelProps {
  products: TSellableProduct[];
}

export function CartPanel({ products }: CartPanelProps): ReactElement {
  const [items, setItems] = useState<CartInputItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const handleAdd = (product: TSellableProduct, variant?: TSellableProductVariant) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.productId === product._id && item.variantId === variant?._key);
      if (existing) {
        if (existing.quantity >= 10) return prev;
        return prev.map((item) =>
          item.productId === product._id && item.variantId === variant?._key
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { productId: product._id, variantId: variant?._key, quantity: 1 }];
    });
  };

  const handleRemove = (productId: string, variantId?: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId || item.variantId !== variantId));
  };

  const handleClear = () => {
    setItems([]);
  };

  let cart: ValidatedCart | null = null;
  let cartError: string | null = null;
  try {
    if (items.length > 0) {
      const catalogProducts = products.map(p => ({
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
      cart = buildValidatedCart(items, catalogProducts);
    }
  } catch (err) {
    cartError = err instanceof Error ? err.message : "Invalid cart";
  }

  const hasItems = items.length > 0;
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className={`grid grid-cols-1 gap-8 ${hasItems ? "lg:grid-cols-3" : ""}`}>
      <div className={hasItems ? "lg:col-span-2" : ""}>
        <div className={`grid grid-cols-1 gap-6 ${hasItems ? "md:grid-cols-2" : "md:grid-cols-3 lg:grid-cols-4"}`}>
          {products.map((product) => (
            <ProductCard key={product._id} product={product} onAdd={handleAdd} />
          ))}
        </div>
      </div>

      {hasItems && (
        <aside aria-label="Shopping cart" className="lg:col-span-1">
          <div className="card-white sticky top-24">
            <h2 className="card-heading-red text-2xl mb-4">Your Cart</h2>

            <div aria-live="polite" className="sr-only">
              {totalItems} items in cart
            </div>

            <div className="flex flex-col gap-4">
              {cartError ? (
                <p className="text-brand-red text-sm">{cartError}</p>
              ) : cart ? (
                <>
                  <ul className="divide-y divide-brand-pink">
                    {cart.lineItems.map((lineItem) => (
                      <li key={`${lineItem.productId}:${lineItem.variantId || "default"}`} className="py-3 flex justify-between items-start">
                        <div>
                          <p className="font-bold text-black">{lineItem.description}</p>
                          <p className="text-sm text-brand-dark-grey">
                            Qty: {lineItem.quantity} × {formatCad(lineItem.price)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-black">{formatCad(lineItem.total)}</p>
                          <button
                            onClick={() => handleRemove(lineItem.productId, lineItem.variantId)}
                            className="text-xs text-brand-red hover:underline mt-1"
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>

                  <div className="border-t border-brand-red pt-4 mt-2">
                    <div className="flex justify-between items-center mb-6">
                      <span className="font-bold text-xl text-black">Total</span>
                      <span className="font-bold text-xl text-brand-red">{formatCad(cart.amount)}</span>
                    </div>

                    <div className="space-y-4 mb-6">
                      <div>
                        <label htmlFor="customerName" className="block text-sm font-bold text-brand-red mb-1">
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
                        <label htmlFor="customerEmail" className="block text-sm font-bold text-brand-red mb-1">
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
                        onPaid={handleClear}
                      />
                      <Button
                        variant="ghost"
                        onClick={handleClear}
                        className="text-brand-dark-grey hover:text-brand-red"
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
