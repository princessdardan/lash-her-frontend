"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type CartInputItem } from "@/lib/commerce/cart";
import type { TSellableProduct } from "@/types";
import { ProductCard } from "./product-card";

interface CartPanelProps {
  products: TSellableProduct[];
}

export function CartPanel({ products }: CartPanelProps) {
  const [items, setItems] = React.useState<CartInputItem[]>([]);
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");

  const handleAdd = (product: TSellableProduct) => {
    setItems((prev) => {
      const existing = prev.find((item) => item.productId === product._id);
      if (existing) {
        if (existing.quantity >= 10) return prev;
        return prev.map((item) =>
          item.productId === product._id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { productId: product._id, quantity: 1 }];
    });
  };

  const handleRemove = (productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId));
  };

  const handleClear = () => {
    setItems([]);
  };

  let cart;
  let cartError = null;
  try {
    if (items.length > 0) {
      const catalogProducts = products.map(p => ({
        id: p._id,
        sku: p.sku,
        title: p.title,
        price: p.price,
        currency: p.currency,
        isAvailable: p.isAvailable
      }));
      cart = buildValidatedCart(items, catalogProducts);
    }
  } catch (err) {
    cartError = err instanceof Error ? err.message : "Invalid cart";
  }

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {products.map((product) => (
            <ProductCard key={product._id} product={product} onAdd={handleAdd} />
          ))}
        </div>
      </div>

      <div className="lg:col-span-1">
        <div className="card-white sticky top-24">
          <h2 className="card-heading-red text-2xl mb-4">Your Cart</h2>
          
          <div aria-live="polite" className="sr-only">
            {totalItems} items in cart
          </div>

          {items.length === 0 ? (
            <p className="text-black font-light">Your cart is empty.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {cartError ? (
                <p className="text-brand-red text-sm">{cartError}</p>
              ) : cart ? (
                <>
                  <ul className="divide-y divide-brand-pink">
                    {cart.lineItems.map((lineItem) => (
                      <li key={lineItem.sku} className="py-3 flex justify-between items-start">
                        <div>
                          <p className="font-bold text-black">{lineItem.description}</p>
                          <p className="text-sm text-brand-dark-grey">
                            Qty: {lineItem.quantity} × {formatCad(lineItem.price)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-black">{formatCad(lineItem.total)}</p>
                          <button
                            onClick={() => {
                              const product = products.find(p => p.sku === lineItem.sku);
                              if (product) handleRemove(product._id);
                            }}
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
                      <Button 
                        disabled={true} 
                        className="btn-primary-red"
                      >
                        Checkout (Coming Soon)
                      </Button>
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
          )}
        </div>
      </div>
    </div>
  );
}
