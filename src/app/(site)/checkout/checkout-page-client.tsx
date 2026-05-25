"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCad } from "@/lib/commerce/money";
import { buildValidatedCart, type ValidatedCart, type CartInputItem } from "@/lib/commerce/cart";
import {
  CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  CHECKOUT_EMAIL_MAX_LENGTH,
  CHECKOUT_SHIPPING_LINE_MAX_LENGTH,
  CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
  CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
  isValidCheckoutEmail,
  isValidCheckoutText,
  normalizeCheckoutText,
} from "@/lib/commerce/checkout-validation";
import type { TProduct } from "@/types";
import { HelcimPayButton } from "@/components/commerce/helcim-pay-button";
import { useProductCart } from "@/components/commerce/product-cart-provider";

interface CheckoutPageClientProps {
  products: TProduct[];
}

function CheckoutContent({ products }: CheckoutPageClientProps) {
  const searchParams = useSearchParams();
  const { items: cartItems, clearCart } = useProductCart();

  const isBuyNow = searchParams.get("buyNow") === "1";
  const buyNowProductId = searchParams.get("productId");
  const buyNowVariantId = searchParams.get("variantId");
  const buyNowQuantity = searchParams.get("quantity");
  const initialPromotionCode = searchParams.get("promotionCode")?.toUpperCase() ?? "";

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [shippingLine1, setShippingLine1] = useState("");
  const [shippingLine2, setShippingLine2] = useState("");
  const [shippingCity, setShippingCity] = useState("");
  const [shippingProvince, setShippingProvince] = useState("");
  const [shippingPostalCode, setShippingPostalCode] = useState("");
  const [shippingCountry, setShippingCountry] = useState("Canada");
  const [promotionCodeInput, setPromotionCodeInput] = useState(initialPromotionCode);
  const [redeemedPromotionCode, setRedeemedPromotionCode] = useState<string | undefined>();
  const [promotionPreviewCart, setPromotionPreviewCart] = useState<ValidatedCart | null>(null);
  const [promotionPreviewCartKey, setPromotionPreviewCartKey] = useState<string | undefined>();
  const [promotionCodeError, setPromotionCodeError] = useState<string | null>(null);
  const [isApplyingPromotionCode, setIsApplyingPromotionCode] = useState(false);

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

  const checkoutItemsKey = useMemo(() => JSON.stringify(checkoutItems), [checkoutItems]);

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
      return { cart: buildValidatedCart(checkoutItems, catalogProducts), error: null };
    } catch (err) {
      return { cart: null, error: err instanceof Error ? err.message : "Invalid cart" };
    }
  }, [checkoutItems, products]);

  const totalItems = checkoutItems.reduce((sum, item) => sum + item.quantity, 0);
  const hasPromotionPreview = promotionPreviewCartKey === checkoutItemsKey && promotionPreviewCart !== null;
  const activeRedeemedPromotionCode = hasPromotionPreview ? redeemedPromotionCode : undefined;
  const displayedCart = hasPromotionPreview ? promotionPreviewCart : cart.cart;
  const normalizedCustomerName = normalizeCheckoutText(customerName);
  const normalizedCustomerEmail = customerEmail.trim().toLowerCase();
  const normalizedShippingLine2 = normalizeCheckoutText(shippingLine2);
  const shippingAddress = {
    line1: normalizeCheckoutText(shippingLine1),
    ...(normalizedShippingLine2 ? { line2: normalizedShippingLine2 } : {}),
    city: normalizeCheckoutText(shippingCity),
    province: normalizeCheckoutText(shippingProvince),
    postalCode: normalizeCheckoutText(shippingPostalCode),
    country: normalizeCheckoutText(shippingCountry),
  };
  const hasValidShippingAddress = Boolean(
    isValidCheckoutText(shippingLine1, CHECKOUT_SHIPPING_LINE_MAX_LENGTH) &&
    (!normalizedShippingLine2 || isValidCheckoutText(shippingLine2, CHECKOUT_SHIPPING_LINE_MAX_LENGTH)) &&
    isValidCheckoutText(shippingCity, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH) &&
    isValidCheckoutText(shippingProvince, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH) &&
    isValidCheckoutText(shippingPostalCode, CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH) &&
    isValidCheckoutText(shippingCountry, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH),
  );
  const hasValidCustomerDetails = Boolean(
    isValidCheckoutText(customerName, CHECKOUT_CUSTOMER_NAME_MAX_LENGTH) &&
    isValidCheckoutEmail(normalizedCustomerEmail),
  );
  const cartAmount = displayedCart?.amount ?? 0;
  const cartAmountBeforePromotion = displayedCart
    ? Math.round((displayedCart.amount + (displayedCart.promotionDiscountAmount ?? 0)) * 100) / 100
    : 0;

  const handleApplyPromotionCode = async () => {
    if (!cart.cart || !promotionCodeInput.trim()) return;

    setPromotionCodeError(null);
    setIsApplyingPromotionCode(true);

    try {
      const response = await fetch("/api/promotion-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "product",
          promotionCode: promotionCodeInput,
          items: checkoutItems,
        }),
      });

      if (!response.ok) {
        setPromotionCodeError("This code is not valid for your order.");
        setRedeemedPromotionCode(undefined);
        setPromotionPreviewCart(null);
        return;
      }

      const data = await response.json() as { promotionCode?: string; cart?: ValidatedCart };
      if (!data.promotionCode || !data.cart) {
        setPromotionCodeError("This code is not valid for your order.");
        setRedeemedPromotionCode(undefined);
        setPromotionPreviewCart(null);
        return;
      }

      setRedeemedPromotionCode(data.promotionCode);
      setPromotionPreviewCart(data.cart);
      setPromotionPreviewCartKey(checkoutItemsKey);
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

  useEffect(() => {
    if (!initialPromotionCode || !cart.cart || activeRedeemedPromotionCode || hasPromotionPreview || promotionCodeError || isApplyingPromotionCode) {
      return;
    }

    let isCancelled = false;

    void (async () => {
      setIsApplyingPromotionCode(true);
      setPromotionCodeInput(initialPromotionCode);

      try {
        const response = await fetch("/api/promotion-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "product",
            promotionCode: initialPromotionCode,
            items: checkoutItems,
          }),
        });

        if (isCancelled) return;

        if (!response.ok) {
          setPromotionCodeError("This code is not valid for your order.");
          setRedeemedPromotionCode(undefined);
          setPromotionPreviewCart(null);
          return;
        }

        const data = await response.json() as { promotionCode?: string; cart?: ValidatedCart };
        if (!data.promotionCode || !data.cart) {
          setPromotionCodeError("This code is not valid for your order.");
          setRedeemedPromotionCode(undefined);
          setPromotionPreviewCart(null);
          return;
        }

        setRedeemedPromotionCode(data.promotionCode);
        setPromotionPreviewCart(data.cart);
        setPromotionPreviewCartKey(checkoutItemsKey);
        setPromotionCodeInput(data.promotionCode);
      } catch {
        if (isCancelled) return;
        setPromotionCodeError("We could not apply this code. Please try again.");
        setRedeemedPromotionCode(undefined);
        setPromotionPreviewCart(null);
      } finally {
        if (!isCancelled) setIsApplyingPromotionCode(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [activeRedeemedPromotionCode, cart.cart, checkoutItems, checkoutItemsKey, hasPromotionPreview, initialPromotionCode, isApplyingPromotionCode, promotionCodeError]);

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
                <Link href="/products">Browse Products</Link>
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

            {displayedCart ? (
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <span className="font-body text-sm font-bold text-lh-muted">
                    {totalItems} item{totalItems !== 1 ? "s" : ""}
                  </span>
                  {!isBuyNow ? (
                    <Link
                      href="/products"
                      className="font-body text-sm font-bold text-lh-primary hover:text-lh-accent transition-colors"
                    >
                      Continue Shopping
                    </Link>
                  ) : null}
                </div>

                <ul className="divide-y divide-lh-line">
                  {displayedCart.lineItems.map((lineItem) => (
                    <li
                      key={`${lineItem.productId}:${lineItem.variantId || "default"}`}
                      className="py-4 flex justify-between items-start"
                    >
                      <div>
                        <p className="font-body font-bold text-lh-shadow">{lineItem.description}</p>
                        <p className="font-body text-sm font-bold text-lh-muted">
                          Qty: {lineItem.quantity} × {formatCad(lineItem.price)}
                          {lineItem.originalPrice ? (
                            <span className="ml-2 text-lh-muted line-through">
                              {formatCad(lineItem.originalPrice)}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="text-right">
                        {lineItem.originalTotal ? (
                          <p className="font-body text-xs font-bold text-lh-muted line-through">
                            {formatCad(lineItem.originalTotal)}
                          </p>
                        ) : null}
                        <p className="font-body font-bold text-lh-shadow">{formatCad(lineItem.total)}</p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/60 p-4">
                  <label htmlFor="checkout-promotion-code" className="block text-sm font-bold text-lh-primary mb-2">
                    Promotion code
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="checkout-promotion-code"
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
                      className="rounded-full border-lh-primary/30 px-5 font-body text-sm uppercase tracking-[0.12em] hover:bg-lh-primary-soft hover:text-lh-primary"
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

                <div className="border-t border-lh-line pt-4">
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
                  <div className="flex justify-between items-center gap-4">
                    <span className="font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">Total</span>
                    <span className="flex flex-wrap items-baseline justify-end gap-2 font-body text-2xl font-bold text-lh-shadow">
                      {activeRedeemedPromotionCode && displayedCart.promotionDiscountAmount ? (
                        <span className="text-sm text-lh-muted line-through">{formatCad(cartAmountBeforePromotion)}</span>
                      ) : null}
                      <span>{formatCad(cartAmount)}</span>
                    </span>
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
                      maxLength={CHECKOUT_CUSTOMER_NAME_MAX_LENGTH}
                      autoComplete="name"
                      placeholder="Your full name"
                    />
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
                      maxLength={CHECKOUT_EMAIL_MAX_LENGTH}
                      autoComplete="email"
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/60 p-5 md:p-6">
                  <div className="mb-5">
                    <p className="eyebrow-label mb-2">Shipping</p>
                    <h2 className="font-heading text-2xl font-normal text-lh-shadow">Where should we send it?</h2>
                    <p className="mt-2 font-body text-sm font-bold leading-6 text-lh-muted">
                      Physical products require a delivery address before secure payment opens.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label htmlFor="checkout-shipping-line1" className="block text-sm font-bold text-lh-primary mb-1">
                        Address
                      </label>
                      <Input
                        id="checkout-shipping-line1"
                        type="text"
                        value={shippingLine1}
                        onChange={(e) => setShippingLine1(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LINE_MAX_LENGTH}
                        autoComplete="shipping address-line1"
                        placeholder="Street address"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="checkout-shipping-line2" className="block text-sm font-bold text-lh-primary mb-1">
                        Apartment, suite, etc. <span className="text-lh-muted">(optional)</span>
                      </label>
                      <Input
                        id="checkout-shipping-line2"
                        type="text"
                        value={shippingLine2}
                        onChange={(e) => setShippingLine2(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LINE_MAX_LENGTH}
                        autoComplete="shipping address-line2"
                        placeholder="Unit or buzzer"
                      />
                    </div>
                    <div>
                      <label htmlFor="checkout-shipping-city" className="block text-sm font-bold text-lh-primary mb-1">
                        City
                      </label>
                      <Input
                        id="checkout-shipping-city"
                        type="text"
                        value={shippingCity}
                        onChange={(e) => setShippingCity(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH}
                        autoComplete="shipping address-level2"
                        placeholder="Toronto"
                      />
                    </div>
                    <div>
                      <label htmlFor="checkout-shipping-province" className="block text-sm font-bold text-lh-primary mb-1">
                        Province / State
                      </label>
                      <Input
                        id="checkout-shipping-province"
                        type="text"
                        value={shippingProvince}
                        onChange={(e) => setShippingProvince(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH}
                        autoComplete="shipping address-level1"
                        placeholder="Ontario"
                      />
                    </div>
                    <div>
                      <label htmlFor="checkout-shipping-postal-code" className="block text-sm font-bold text-lh-primary mb-1">
                        Postal code
                      </label>
                      <Input
                        id="checkout-shipping-postal-code"
                        type="text"
                        value={shippingPostalCode}
                        onChange={(e) => setShippingPostalCode(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH}
                        autoComplete="shipping postal-code"
                        placeholder="M6E 2Y4"
                      />
                    </div>
                    <div>
                      <label htmlFor="checkout-shipping-country" className="block text-sm font-bold text-lh-primary mb-1">
                        Country
                      </label>
                      <Input
                        id="checkout-shipping-country"
                        type="text"
                        value={shippingCountry}
                        onChange={(e) => setShippingCountry(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH}
                        autoComplete="shipping country-name"
                        placeholder="Canada"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-2">
                  <HelcimPayButton
                    disabled={!displayedCart || !hasValidCustomerDetails || !hasValidShippingAddress}
                    items={checkoutItems}
                    customer={{ name: normalizedCustomerName, email: normalizedCustomerEmail }}
                    shippingAddress={shippingAddress}
                    promotionCode={activeRedeemedPromotionCode}
                    onPaid={isBuyNow ? () => undefined : clearCart}
                  />
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

export default function CheckoutPageClient({ products }: CheckoutPageClientProps) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-lh-neutral-2">
          <div className="content-container py-12">
            <p className="font-body text-lh-muted">Loading checkout...</p>
          </div>
        </div>
      }
    >
      <CheckoutContent products={products} />
    </Suspense>
  );
}
