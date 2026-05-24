"use client";

import { useMemo, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildValidatedCart, type ValidatedCart } from "@/lib/commerce/cart";
import { formatCad } from "@/lib/commerce/money";
import { cn } from "@/lib/utils";
import type { CartInputItem } from "@/lib/commerce/cart";
import type { TProduct, TProductVariant } from "@/types";
import { HelcimPayButton } from "./helcim-pay-button";
import { ProductVariantSelector } from "./product-variant-selector";
import { useProductCart } from "./product-cart-provider";

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;

interface ProductDetailPurchaseControlsProps {
  readonly product: TProduct;
  readonly products: TProduct[];
}

type CheckoutMode = "cart" | "buyNow";

function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return MIN_QUANTITY;
  return Math.max(MIN_QUANTITY, Math.min(MAX_QUANTITY, Math.trunc(value)));
}

function getRequiredOptionNames(product: TProduct, variants: TProductVariant[]): string[] {
  const names = [
    ...(product.optionGroups?.map((group) => group.name) ?? []),
    ...variants.flatMap((variant) => variant.options?.map((option) => option.name) ?? []),
  ];

  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
}

function variantMatchesSelectedOptions(variant: TProductVariant, selectedOptions: Readonly<Record<string, string>>): boolean {
  return Object.entries(selectedOptions).every(([name, value]) => {
    if (!value) return true;
    return variant.options?.some((option) => option.name === name && option.value === value);
  });
}

function toCatalogProducts(products: TProduct[]) {
  return products.map((catalogProduct) => ({
    id: catalogProduct._id,
    sku: catalogProduct.sku,
    title: catalogProduct.title,
    price: catalogProduct.price,
    currency: catalogProduct.currency,
    isAvailable: catalogProduct.isAvailable,
    variants: catalogProduct.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      isAvailable: variant.isAvailable,
    })),
  }));
}

export function ProductDetailPurchaseControls({ product, products }: ProductDetailPurchaseControlsProps): ReactElement {
  const { items, isOpen, addItem, openCart, closeCart, clearCart, createBuyNowPayload } = useProductCart();
  const variants = useMemo(() => product.variants?.filter((variant) => variant.title) ?? [], [product.variants]);
  const requiredOptionNames = useMemo(() => getRequiredOptionNames(product, variants), [product, variants]);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(MIN_QUANTITY);
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("cart");
  const [buyNowItems, setBuyNowItems] = useState<CartInputItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const selectedVariant = variants.find((variant) => variant._key === selectedVariantId);
  const hasVariants = variants.length > 0;
  const hasCompleteOptions = requiredOptionNames.every((name) => Boolean(selectedOptions[name]));
  const selectedVariantMatchesOptions = selectedVariant ? variantMatchesSelectedOptions(selectedVariant, selectedOptions) : false;
  const hasRequiredVariantSelection = !hasVariants || Boolean(
    selectedVariant?.isAvailable &&
    selectedVariantMatchesOptions &&
    (requiredOptionNames.length === 0 || hasCompleteOptions),
  );
  const canPurchase = product.isAvailable && hasRequiredVariantSelection;
  const selectionMessageId = `${product._id}-purchase-selection-message`;
  const quantityLabelId = `${product._id}-quantity-label`;
  const checkoutItems = checkoutMode === "buyNow" ? buyNowItems : items;
  const totalItems = checkoutItems.reduce((sum, item) => sum + item.quantity, 0);
  const checkoutCart = useMemo<{ cart: ValidatedCart | null; error: string | null }>(() => {
    if (checkoutItems.length === 0) return { cart: null, error: null };

    try {
      return { cart: buildValidatedCart(checkoutItems, toCatalogProducts(products)), error: null };
    } catch (error) {
      return { cart: null, error: error instanceof Error ? error.message : "Invalid cart" };
    }
  }, [checkoutItems, products]);
  const itemPayload = {
    productId: product._id,
    ...(selectedVariant ? { variantId: selectedVariant._key } : {}),
    quantity,
  };

  const handleVariantSelect = (variant: TProductVariant) => {
    setSelectedVariantId(variant._key);
    setSelectedOptions((currentOptions) => ({
      ...currentOptions,
      ...(variant.options?.reduce<Record<string, string>>((options, option) => {
        options[option.name] = option.value;
        return options;
      }, {}) ?? {}),
    }));
  };

  const handleOptionsChange = (nextOptions: Record<string, string>) => {
    setSelectedOptions(nextOptions);
    setSelectedVariantId("");
  };

  const handleAddToCart = () => {
    if (!canPurchase) return;

    addItem(itemPayload);
    setCheckoutMode("cart");
    setBuyNowItems([]);
    openCart();
  };

  const handleBuyNow = () => {
    if (!canPurchase) return;

    setBuyNowItems(createBuyNowPayload(itemPayload));
    setCheckoutMode("buyNow");
    openCart();
  };

  const handleQuantityChange = (value: string) => {
    setQuantity(clampQuantity(Number(value)));
  };

  const handleCloseCart = () => {
    setCheckoutMode("cart");
    setBuyNowItems([]);
    closeCart();
  };

  return (
    <div className="mt-8 border-t border-lh-line pt-6">
      <ProductVariantSelector
        product={product}
        selectedOptions={selectedOptions}
        selectedVariantId={selectedVariantId}
        onOptionsChange={handleOptionsChange}
        onVariantSelect={handleVariantSelect}
      />

      <div className="mt-8 rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5 md:p-6">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <label className="block md:w-32" htmlFor={`${product._id}-quantity`}>
            <span id={quantityLabelId} className="eyebrow-label mb-2 block">Quantity</span>
            <Input
              id={`${product._id}-quantity`}
              type="number"
              min={MIN_QUANTITY}
              max={MAX_QUANTITY}
              inputMode="numeric"
              value={quantity}
              onChange={(event) => handleQuantityChange(event.target.value)}
              aria-labelledby={quantityLabelId}
              disabled={!product.isAvailable}
            />
          </label>

          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              type="button"
              onClick={handleAddToCart}
              disabled={!canPurchase}
              aria-describedby={selectionMessageId}
              className={cn(
                "h-12 rounded-full px-6 font-body text-sm uppercase tracking-[0.12em]",
                canPurchase ? "bg-lh-primary text-lh-white hover:bg-lh-accent" : "bg-lh-neutral text-lh-muted",
              )}
            >
              Add to Cart
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={handleBuyNow}
              disabled={!canPurchase}
              aria-describedby={selectionMessageId}
              className="h-12 rounded-full border-lh-primary/30 px-6 font-body text-sm uppercase tracking-[0.12em] hover:bg-lh-primary-soft hover:text-lh-primary"
            >
              Buy Now
            </Button>
          </div>
        </div>

        <p
          id={selectionMessageId}
          role="status"
          aria-live="polite"
          className={cn(
            "mt-4 font-body text-xs font-bold leading-6",
            canPurchase ? "text-lh-muted" : "text-lh-accent",
          )}
        >
          {canPurchase
            ? "Ready for secure checkout. Add this selection to the cart or start a single-item checkout."
            : hasVariants
              ? "Choose an available product option before adding this item to cart or buying now."
              : product.availabilityLabel || "This product is currently unavailable."}
        </p>
      </div>

      {isOpen ? (
        <aside aria-label="Shopping cart" className="mt-6 rounded-[24px] border border-lh-line bg-lh-white p-5 shadow-[0_18px_50px_rgba(28,19,24,0.05)] md:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow-label mb-1">{checkoutMode === "buyNow" ? "Buy Now" : "Your Cart"}</p>
              <h2 className="section-subheading text-3xl">Review Selection</h2>
            </div>
            <Button type="button" variant="ghost" onClick={handleCloseCart} className="px-4 py-2 text-xs uppercase tracking-[0.12em]">
              Close
            </Button>
          </div>

          <div aria-live="polite" className="sr-only">
            {totalItems} items ready for checkout
          </div>

          {checkoutItems.length === 0 ? (
            <p className="rounded-[18px] border border-lh-line bg-lh-neutral-2/70 p-4 font-body text-sm font-bold leading-6 text-lh-muted">
              Add a product selection to begin checkout.
            </p>
          ) : checkoutCart.error ? (
            <p role="alert" className="rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 font-body text-sm font-bold leading-6 text-lh-accent">
              {checkoutCart.error}
            </p>
          ) : checkoutCart.cart ? (
            <>
              <ul className="divide-y divide-lh-line">
                {checkoutCart.cart.lineItems.map((lineItem) => (
                  <li key={`${lineItem.productId}:${lineItem.variantId || "default"}`} className="flex items-start justify-between gap-4 py-3">
                    <div>
                      <p className="font-body font-bold text-lh-shadow">{lineItem.description}</p>
                      <p className="font-body text-sm font-bold text-lh-muted">
                        Qty: {lineItem.quantity} × {formatCad(lineItem.price)}
                      </p>
                    </div>
                    <p className="font-body text-sm font-bold text-lh-primary">
                      {formatCad(lineItem.total)}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex items-center justify-between border-t border-lh-line pt-4">
                <span className="font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">Total</span>
                <span className="font-body text-xl font-bold text-lh-shadow">{formatCad(checkoutCart.cart.amount)}</span>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block" htmlFor={`${product._id}-checkout-name`}>
                  <span className="mb-1 block font-body text-sm font-bold text-lh-primary">Name</span>
                  <Input
                    id={`${product._id}-checkout-name`}
                    type="text"
                    value={customerName}
                    onChange={(event) => setCustomerName(event.target.value)}
                    placeholder="Your full name"
                  />
                </label>
                <label className="block" htmlFor={`${product._id}-checkout-email`}>
                  <span className="mb-1 block font-body text-sm font-bold text-lh-primary">Email</span>
                  <Input
                    id={`${product._id}-checkout-email`}
                    type="email"
                    value={customerEmail}
                    onChange={(event) => setCustomerEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
              </div>

              <div className="mt-5">
                <HelcimPayButton
                  disabled={!customerName.trim() || !customerEmail.trim()}
                  items={checkoutItems}
                  customer={{ name: customerName.trim(), email: customerEmail.trim() }}
                  onPaid={checkoutMode === "cart" ? clearCart : () => undefined}
                />
              </div>

              {checkoutMode === "buyNow" ? (
                <p className="mt-3 font-body text-xs font-bold leading-6 text-lh-muted">
                  Buy Now uses this single-item checkout only and does not alter your saved cart.
                </p>
              ) : null}
            </>
          ) : (
            null
          )}
        </aside>
      ) : null}
    </div>
  );
}
