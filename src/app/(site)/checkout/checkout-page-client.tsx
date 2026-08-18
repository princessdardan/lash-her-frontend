"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCad } from "@/lib/commerce/money";
import {
  buildValidatedCart,
  type ValidatedCart,
  type CartInputItem,
} from "@/lib/commerce/cart";
import { toCheckoutCatalogProduct } from "@/lib/commerce/product-catalog";
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
import type { UsImportTerms } from "@/lib/commerce/product-checkout-disclosures";
import type { ManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";

interface CheckoutTaxContext {
  rate: number;
  name: string;
  collected: boolean;
}

interface CheckoutPageClientProps {
  products: TProduct[];
  shippingEnabled: boolean;
  manualCheckoutPolicy: ManualProductCheckoutPolicy;
  /** Fixed tax for in-studio pickup (studio place of supply, Ontario). */
  pickupTax: { rate: number; name: string };
}

interface ShippingRate {
  id: string;
  title: string;
  carrier?: string;
  deliveryEstimate?: string;
  amountCents: number;
  currency: "CAD";
  insured: boolean;
  tracked: boolean;
  deliveryMaxBusinessDays?: number;
  signatureAvailable: boolean;
  signatureRequired: boolean;
}

interface ShippingQuote {
  operationId: string;
  status: string;
  quoteToken: string;
  fingerprint: string;
  expiresAt: string;
  rates: ShippingRate[];
  tax?: {
    rate: number;
    name: string;
    collected: boolean;
    jurisdiction: string;
  };
  usImportTerms?: UsImportTerms;
  usImportDisclosureVersion?: string;
  usImportDisclosureText?: string;
}

function CheckoutContent({
  products,
  shippingEnabled,
  manualCheckoutPolicy,
  pickupTax,
}: CheckoutPageClientProps) {
  const searchParams = useSearchParams();
  const { items: cartItems, clearCart } = useProductCart();

  const isBuyNow = searchParams.get("buyNow") === "1";
  const buyNowProductId = searchParams.get("productId");
  const buyNowVariantId = searchParams.get("variantId");
  const buyNowQuantity = searchParams.get("quantity");
  const initialPromotionCode =
    searchParams.get("promotionCode")?.toUpperCase() ?? "";

  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [shippingLine1, setShippingLine1] = useState("");
  const [shippingLine2, setShippingLine2] = useState("");
  const [shippingCity, setShippingCity] = useState("");
  const [shippingProvince, setShippingProvince] = useState("");
  const [shippingPostalCode, setShippingPostalCode] = useState("");
  const [shippingCountry, setShippingCountry] = useState("CA");
  const [shippingQuote, setShippingQuote] = useState<ShippingQuote | null>(
    null,
  );
  const [shippingQuoteRequestKey, setShippingQuoteRequestKey] = useState<
    string | null
  >(null);
  const [selectedShippingRateId, setSelectedShippingRateId] = useState<
    string | null
  >(null);
  const [shippingQuoteError, setShippingQuoteError] = useState<string | null>(
    null,
  );
  const [isLoadingShippingRates, setIsLoadingShippingRates] = useState(false);
  const [promotionCodeInput, setPromotionCodeInput] =
    useState(initialPromotionCode);
  const [redeemedPromotionCode, setRedeemedPromotionCode] = useState<
    string | undefined
  >();
  const [promotionPreviewCart, setPromotionPreviewCart] =
    useState<ValidatedCart | null>(null);
  const [promotionPreviewCartKey, setPromotionPreviewCartKey] = useState<
    string | undefined
  >();
  const [promotionCodeError, setPromotionCodeError] = useState<string | null>(
    null,
  );
  const [isApplyingPromotionCode, setIsApplyingPromotionCode] = useState(false);
  const manualFulfillmentMode = "manual_pickup" as const;
  const [acceptedCancellationPolicy, setAcceptedCancellationPolicy] =
    useState(false);

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

  const checkoutItemsKey = useMemo(
    () => JSON.stringify(checkoutItems),
    [checkoutItems],
  );

  const cart = useMemo<{
    cart: ValidatedCart | null;
    error: string | null;
  }>(() => {
    if (checkoutItems.length === 0) {
      return { cart: null, error: null };
    }

    try {
      const catalogProducts = products.map(toCheckoutCatalogProduct);
      return {
        cart: buildValidatedCart(checkoutItems, catalogProducts),
        error: null,
      };
    } catch (err) {
      return {
        cart: null,
        error: err instanceof Error ? err.message : "Invalid cart",
      };
    }
  }, [checkoutItems, products]);

  const totalItems = checkoutItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const hasPromotionPreview =
    promotionPreviewCartKey === checkoutItemsKey &&
    promotionPreviewCart !== null;
  const activeRedeemedPromotionCode = hasPromotionPreview
    ? redeemedPromotionCode
    : undefined;
  const displayedCart = hasPromotionPreview ? promotionPreviewCart : cart.cart;
  const isManualCheckout = displayedCart?.checkoutMode === "manual";
  const fulfillmentMode = isManualCheckout
    ? manualFulfillmentMode
    : "automated_shipping";
  const requiresShippingAddress = fulfillmentMode !== "manual_pickup";
  const requiresLiveShippingQuote = fulfillmentMode === "automated_shipping";
  const normalizedCustomerName = normalizeCheckoutText(customerName);
  const normalizedCustomerEmail = customerEmail.trim().toLowerCase();
  const normalizedShippingLine2 = normalizeCheckoutText(shippingLine2);
  const shippingAddress = useMemo(
    () => ({
      line1: normalizeCheckoutText(shippingLine1),
      ...(normalizedShippingLine2 ? { line2: normalizedShippingLine2 } : {}),
      city: normalizeCheckoutText(shippingCity),
      province: normalizeCheckoutText(shippingProvince),
      postalCode: normalizeCheckoutText(shippingPostalCode),
      country: shippingCountry === "US" ? "United States" : "Canada",
      countryCode: shippingCountry,
    }),
    [
      normalizedShippingLine2,
      shippingCity,
      shippingCountry,
      shippingLine1,
      shippingPostalCode,
      shippingProvince,
    ],
  );
  const hasValidShippingAddress = Boolean(
    isValidCheckoutText(shippingLine1, CHECKOUT_SHIPPING_LINE_MAX_LENGTH) &&
    (!normalizedShippingLine2 ||
      isValidCheckoutText(shippingLine2, CHECKOUT_SHIPPING_LINE_MAX_LENGTH)) &&
    isValidCheckoutText(shippingCity, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH) &&
    isValidCheckoutText(
      shippingProvince,
      CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH,
    ) &&
    isValidCheckoutText(
      shippingPostalCode,
      CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH,
    ) &&
    isValidCheckoutText(shippingCountry, CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH),
  );
  const requiresUsImportDisclosure =
    requiresLiveShippingQuote && shippingCountry === "US";
  const hasValidCustomerDetails = Boolean(
    isValidCheckoutText(customerName, CHECKOUT_CUSTOMER_NAME_MAX_LENGTH) &&
    isValidCheckoutEmail(normalizedCustomerEmail),
  );
  const cartAmount = displayedCart?.amount ?? 0;
  const quoteRequestKey = useMemo(
    () =>
      JSON.stringify({
        items: checkoutItems,
        promotionCode: activeRedeemedPromotionCode ?? null,
        customer: {
          name: normalizedCustomerName,
          email: normalizedCustomerEmail,
          phone: normalizeCheckoutText(customerPhone),
        },
        shippingAddress,
      }),
    [
      activeRedeemedPromotionCode,
      checkoutItems,
      customerPhone,
      normalizedCustomerEmail,
      normalizedCustomerName,
      shippingAddress,
    ],
  );
  const activeShippingQuote =
    shippingQuoteRequestKey === quoteRequestKey ? shippingQuote : null;
  const selectedShippingRate =
    activeShippingQuote?.rates.find(
      (rate) => rate.id === selectedShippingRateId,
    ) ?? null;
  const hasValidShippingDisclosure =
    !requiresUsImportDisclosure ||
    (requiresLiveShippingQuote &&
      activeShippingQuote?.usImportTerms === "DDU" &&
      Boolean(activeShippingQuote.usImportDisclosureVersion?.trim()) &&
      Boolean(activeShippingQuote.usImportDisclosureText?.trim()));
  const shippingAmount = selectedShippingRate
    ? selectedShippingRate.amountCents / 100
    : 0;
  // Destination tax context: from the live quote for shipped orders, or the
  // fixed studio (Ontario) rate for pickup. The server owns the rate; we apply
  // it to the same cents base the server uses so the displayed total matches
  // the amount charged at order creation.
  const taxContext: CheckoutTaxContext | null = isManualCheckout
    ? {
        rate: pickupTax.rate,
        name: pickupTax.name,
        collected: pickupTax.rate > 0,
      }
    : (activeShippingQuote?.tax ?? null);
  const taxableBaseCents =
    Math.round(cartAmount * 100) + (selectedShippingRate?.amountCents ?? 0);
  const taxAmountCents =
    taxContext?.collected && taxableBaseCents > 0
      ? Math.round(taxableBaseCents * taxContext.rate)
      : 0;
  const taxAmount = taxAmountCents / 100;
  const checkoutTotal =
    (Math.round((cartAmount + shippingAmount) * 100) + taxAmountCents) / 100;
  const cartAmountBeforePromotion = displayedCart
    ? Math.round(
        (displayedCart.amount + (displayedCart.promotionDiscountAmount ?? 0)) *
          100,
      ) / 100
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

      const data = (await response.json()) as {
        promotionCode?: string;
        cart?: ValidatedCart;
      };
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

  const handleLoadShippingRates = async () => {
    if (
      !requiresLiveShippingQuote ||
      !displayedCart ||
      !hasValidCustomerDetails ||
      !hasValidShippingAddress ||
      !normalizeCheckoutText(customerPhone)
    )
      return;
    setIsLoadingShippingRates(true);
    setShippingQuoteError(null);
    setShippingQuoteRequestKey(null);
    setSelectedShippingRateId(null);
    try {
      const response = await fetch("/api/shipping/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: checkoutItems,
          promotionCode: activeRedeemedPromotionCode,
          customer: {
            name: normalizedCustomerName,
            email: normalizedCustomerEmail,
            phone: normalizeCheckoutText(customerPhone),
          },
          shippingAddress,
        }),
      });
      let data = (await response.json()) as Partial<ShippingQuote> & {
        error?: string;
      };
      if (
        response.status === 202 &&
        data.operationId &&
        data.quoteToken &&
        data.expiresAt
      ) {
        data = await waitForShippingQuote({
          operationId: data.operationId,
          quoteToken: data.quoteToken,
          expiresAt: data.expiresAt,
        });
      }
      if (
        !response.ok ||
        !data.quoteToken ||
        !data.fingerprint ||
        !data.expiresAt ||
        !Array.isArray(data.rates)
      ) {
        setShippingQuoteError(
          data.error ?? "Shipping rates are unavailable. Please try again.",
        );
        return;
      }
      const nextQuote = data as ShippingQuote;
      setShippingQuote(nextQuote);
      setShippingQuoteRequestKey(quoteRequestKey);
      setSelectedShippingRateId(nextQuote.rates[0]?.id ?? null);
    } catch {
      setShippingQuoteError(
        "Shipping rates are unavailable. Please try again.",
      );
    } finally {
      setIsLoadingShippingRates(false);
    }
  };

  useEffect(() => {
    if (
      !initialPromotionCode ||
      !cart.cart ||
      activeRedeemedPromotionCode ||
      hasPromotionPreview ||
      promotionCodeError
    ) {
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

        const data = (await response.json()) as {
          promotionCode?: string;
          cart?: ValidatedCart;
        };
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
        setPromotionCodeError(
          "We could not apply this code. Please try again.",
        );
        setRedeemedPromotionCode(undefined);
        setPromotionPreviewCart(null);
      } finally {
        if (!isCancelled) setIsApplyingPromotionCode(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [
    activeRedeemedPromotionCode,
    cart.cart,
    checkoutItems,
    checkoutItemsKey,
    hasPromotionPreview,
    initialPromotionCode,
    promotionCodeError,
  ]);

  if (checkoutItems.length === 0) {
    return (
      <section className="min-h-screen bg-lh-neutral-2">
        <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
          <div className="content-container max-w-2xl">
            <article className="soft-panel bg-lh-white p-8 md:p-12 text-center">
              <h1 className="font-heading text-3xl font-normal text-lh-shadow mb-4">
                Your cart is empty
              </h1>
              <p className="font-body text-sm font-bold text-lh-muted mb-8">
                Add products to your cart before checking out.
              </p>
              <Button asChild variant="primary" className="rounded-full px-8">
                <Link href="/products">Browse Products</Link>
              </Button>
            </article>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="min-h-screen bg-lh-neutral-2">
      <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
        <div className="content-container max-w-2xl">
          <header className="mb-8">
            <p className="eyebrow-label mb-3">
              {isBuyNow ? "Buy Now" : "Checkout"}
            </p>
            <h1 className="display-heading text-4xl md:text-5xl">
              {isBuyNow ? "Complete Your Purchase" : "Review Your Order"}
            </h1>
          </header>

          <section className="soft-panel bg-lh-white p-6 md:p-8">
            {cart.error ? (
              <div className="rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 mb-6">
                <p className="font-body text-sm font-bold text-lh-accent">
                  {cart.error}
                </p>
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
                        <p className="font-body font-bold text-lh-shadow">
                          {lineItem.description}
                        </p>
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
                        <p className="font-body font-bold text-lh-shadow">
                          {formatCad(lineItem.total)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/60 p-4">
                  <label
                    htmlFor="checkout-promotion-code"
                    className="block text-sm font-bold text-lh-primary mb-2"
                  >
                    Promotion code
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="checkout-promotion-code"
                      value={promotionCodeInput}
                      onChange={(event) =>
                        setPromotionCodeInput(event.target.value.toUpperCase())
                      }
                      placeholder="Enter code"
                      disabled={isApplyingPromotionCode}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={
                        activeRedeemedPromotionCode
                          ? handleRemovePromotionCode
                          : handleApplyPromotionCode
                      }
                      disabled={
                        isApplyingPromotionCode ||
                        (!activeRedeemedPromotionCode &&
                          !promotionCodeInput.trim())
                      }
                      className="rounded-full border-lh-primary/30 px-5 font-body text-sm uppercase tracking-[0.12em] hover:bg-lh-primary-soft hover:text-lh-primary"
                    >
                      {isApplyingPromotionCode
                        ? "Applying"
                        : activeRedeemedPromotionCode
                          ? "Remove"
                          : "Apply"}
                    </Button>
                  </div>
                  {activeRedeemedPromotionCode ? (
                    <p className="mt-2 font-body text-xs font-bold uppercase tracking-[0.12em] text-lh-primary">
                      Code {activeRedeemedPromotionCode} applied.
                    </p>
                  ) : null}
                  {promotionCodeError ? (
                    <p
                      className="mt-2 font-body text-xs font-bold text-lh-accent"
                      role="alert"
                    >
                      {promotionCodeError}
                    </p>
                  ) : null}
                </div>

                <div className="border-t border-lh-line pt-4">
                  {displayedCart.manualDiscountAmount ? (
                    <div className="mb-2 flex justify-between font-body text-sm font-bold text-lh-muted">
                      <span>Manual discounts</span>
                      <span>
                        -{formatCad(displayedCart.manualDiscountAmount)}
                      </span>
                    </div>
                  ) : null}
                  {activeRedeemedPromotionCode &&
                  displayedCart.promotionDiscountAmount ? (
                    <div className="mb-2 flex justify-between font-body text-sm font-bold text-lh-primary">
                      <span>Code {activeRedeemedPromotionCode}</span>
                      <span>
                        -{formatCad(displayedCart.promotionDiscountAmount)}
                      </span>
                    </div>
                  ) : null}
                  {taxAmountCents > 0 && taxContext ? (
                    <div className="mb-2 flex justify-between font-body text-sm font-bold text-lh-muted">
                      <span>Tax ({taxContext.name})</span>
                      <span>{formatCad(taxAmount)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between items-center gap-4">
                    <span className="font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">
                      Total
                    </span>
                    <span className="flex flex-wrap items-baseline justify-end gap-2 font-body text-2xl font-bold text-lh-shadow">
                      {activeRedeemedPromotionCode &&
                      displayedCart.promotionDiscountAmount ? (
                        <span className="text-sm text-lh-muted line-through">
                          {formatCad(cartAmountBeforePromotion)}
                        </span>
                      ) : null}
                      <span>{formatCad(checkoutTotal)}</span>
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="checkout-name"
                      className="block text-sm font-bold text-lh-primary mb-1"
                    >
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
                    <label
                      htmlFor="checkout-phone"
                      className="block text-sm font-bold text-lh-primary mb-1"
                    >
                      Phone
                    </label>
                    <Input
                      id="checkout-phone"
                      type="tel"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      maxLength={30}
                      autoComplete="tel"
                      placeholder="Phone number for delivery"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="checkout-email"
                      className="block text-sm font-bold text-lh-primary mb-1"
                    >
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
                    <p className="eyebrow-label mb-2">
                      {isManualCheckout ? "Fulfillment" : "Shipping"}
                    </p>
                    <h2 className="font-heading text-2xl font-normal text-lh-shadow">
                      {fulfillmentMode === "manual_pickup"
                        ? "Arrange pickup"
                        : "Where should we send it?"}
                    </h2>
                    <p className="mt-2 font-body text-sm font-bold leading-6 text-lh-muted">
                      {fulfillmentMode === "manual_pickup"
                        ? "Pickup details are confirmed after payment. No delivery address or shipping charge is collected now."
                        : "Physical products require a delivery address before secure payment opens."}
                    </p>
                  </div>

                  {isManualCheckout ? (
                    <div className="mb-5 rounded-[18px] border border-lh-line bg-white p-4 text-sm text-lh-shadow">
                      Free studio pickup is the initial fulfillment method.
                      Optional shipping can be agreed and paid separately after
                      the order is confirmed; pickup remains available until
                      that supplemental payment succeeds.
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="checkout-shipping-line1"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
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
                        disabled={!requiresShippingAddress}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label
                        htmlFor="checkout-shipping-line2"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
                        Apartment, suite, etc.{" "}
                        <span className="text-lh-muted">(optional)</span>
                      </label>
                      <Input
                        id="checkout-shipping-line2"
                        type="text"
                        value={shippingLine2}
                        onChange={(e) => setShippingLine2(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LINE_MAX_LENGTH}
                        autoComplete="shipping address-line2"
                        placeholder="Unit or buzzer"
                        disabled={!requiresShippingAddress}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="checkout-shipping-city"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
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
                        disabled={!requiresShippingAddress}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="checkout-shipping-province"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
                        Province / State
                      </label>
                      <Input
                        id="checkout-shipping-province"
                        type="text"
                        value={shippingProvince}
                        onChange={(e) => setShippingProvince(e.target.value)}
                        maxLength={CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH}
                        autoComplete="shipping address-level1"
                        placeholder="ON"
                        disabled={!requiresShippingAddress}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="checkout-shipping-postal-code"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
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
                        disabled={!requiresShippingAddress}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="checkout-shipping-country"
                        className="block text-sm font-bold text-lh-primary mb-1"
                      >
                        Country
                      </label>
                      <select
                        id="checkout-shipping-country"
                        value={shippingCountry}
                        onChange={(e) => setShippingCountry(e.target.value)}
                        autoComplete="shipping country-name"
                        className="h-11 w-full rounded-md border border-lh-line bg-white px-3 text-sm text-lh-shadow"
                        disabled={!requiresShippingAddress}
                      >
                        <option value="CA">Canada</option>
                        <option value="US">United States</option>
                      </select>
                    </div>
                  </div>

                  {requiresUsImportDisclosure &&
                  activeShippingQuote?.usImportDisclosureVersion &&
                  activeShippingQuote.usImportDisclosureText &&
                  activeShippingQuote.usImportTerms ? (
                    <div
                      className="mt-5 rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 text-sm font-bold leading-6 text-lh-shadow"
                      data-disclosure-version={
                        activeShippingQuote.usImportDisclosureVersion
                      }
                      data-import-terms={activeShippingQuote.usImportTerms}
                    >
                      {activeShippingQuote.usImportDisclosureText}
                    </div>
                  ) : null}

                  {requiresLiveShippingQuote && shippingEnabled ? (
                    <div className="sm:col-span-2 border-t border-lh-line pt-5">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleLoadShippingRates}
                        disabled={
                          isLoadingShippingRates ||
                          !displayedCart ||
                          !hasValidCustomerDetails ||
                          !hasValidShippingAddress ||
                          !normalizeCheckoutText(customerPhone)
                        }
                      >
                        {isLoadingShippingRates
                          ? "Loading rates..."
                          : activeShippingQuote
                            ? "Refresh shipping rates"
                            : "Get shipping rates"}
                      </Button>
                      {shippingQuoteError ? (
                        <p
                          className="mt-3 text-sm font-bold text-lh-accent"
                          role="alert"
                        >
                          {shippingQuoteError}
                        </p>
                      ) : null}
                      {activeShippingQuote ? (
                        <fieldset className="mt-4 space-y-3">
                          <legend className="text-sm font-bold text-lh-primary">
                            Choose an insured tracked service
                          </legend>
                          {activeShippingQuote.rates.map((rate) => (
                            <label
                              key={rate.id}
                              className="flex cursor-pointer items-start justify-between gap-4 rounded-[18px] border border-lh-line bg-white p-4"
                            >
                              <span className="flex gap-3">
                                <input
                                  type="radio"
                                  name="shipping-rate"
                                  value={rate.id}
                                  checked={selectedShippingRateId === rate.id}
                                  onChange={() =>
                                    setSelectedShippingRateId(rate.id)
                                  }
                                />
                                <span>
                                  <span className="block text-sm font-bold text-lh-shadow">
                                    {rate.title}
                                  </span>
                                  {rate.deliveryEstimate ? (
                                    <span className="block text-xs text-lh-muted">
                                      {rate.deliveryEstimate}
                                    </span>
                                  ) : null}
                                  <span className="block text-xs text-lh-muted">
                                    Insurance and tracking included
                                  </span>
                                  {rate.signatureRequired ? (
                                    <span className="block text-xs font-bold text-lh-shadow">
                                      Signature is required at delivery
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                              <span className="whitespace-nowrap text-sm font-bold text-lh-shadow">
                                {formatCad(rate.amountCents / 100)}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {isManualCheckout ? (
                  manualCheckoutPolicy.enabled &&
                  manualCheckoutPolicy.cancellationPolicyText &&
                  manualCheckoutPolicy.cancellationPolicyVersion ? (
                    <label className="flex items-start gap-3 rounded-[18px] border border-lh-line bg-lh-white p-4 text-sm font-bold leading-6 text-lh-shadow">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={acceptedCancellationPolicy}
                        onChange={(event) =>
                          setAcceptedCancellationPolicy(event.target.checked)
                        }
                      />
                      <span>{manualCheckoutPolicy.cancellationPolicyText}</span>
                    </label>
                  ) : (
                    <p
                      className="rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 text-sm font-bold leading-6 text-lh-accent"
                      role="alert"
                    >
                      Manual checkout is unavailable until the current pickup
                      and cancellation policy is approved.
                    </p>
                  )
                ) : null}

                <div className="mt-2">
                  <HelcimPayButton
                    disabled={
                      !displayedCart ||
                      !hasValidCustomerDetails ||
                      (requiresShippingAddress && !hasValidShippingAddress) ||
                      (requiresLiveShippingQuote &&
                        (!shippingEnabled ||
                          !activeShippingQuote ||
                          !selectedShippingRateId)) ||
                      !hasValidShippingDisclosure ||
                      (isManualCheckout &&
                        (!manualCheckoutPolicy.enabled ||
                          !acceptedCancellationPolicy))
                    }
                    items={checkoutItems}
                    customer={{
                      name: normalizedCustomerName,
                      email: normalizedCustomerEmail,
                      phone: normalizeCheckoutText(customerPhone),
                    }}
                    shippingAddress={
                      requiresShippingAddress ? shippingAddress : undefined
                    }
                    fulfillmentMode={fulfillmentMode}
                    disclosures={{
                      ...(isManualCheckout &&
                      manualCheckoutPolicy.cancellationPolicyVersion &&
                      manualCheckoutPolicy.cancellationPolicyTextHash &&
                      acceptedCancellationPolicy
                        ? {
                            cancellationPolicyAccepted: true,
                            cancellationPolicyVersion:
                              manualCheckoutPolicy.cancellationPolicyVersion,
                            cancellationPolicyTextHash:
                              manualCheckoutPolicy.cancellationPolicyTextHash,
                          }
                        : {}),
                      ...(requiresUsImportDisclosure &&
                      activeShippingQuote?.usImportTerms &&
                      activeShippingQuote.usImportDisclosureVersion &&
                      activeShippingQuote.usImportDisclosureText
                        ? {
                            usImportTerms: activeShippingQuote.usImportTerms,
                            usImportDisclosureVersion:
                              activeShippingQuote.usImportDisclosureVersion,
                            usImportDisclosureText:
                              activeShippingQuote.usImportDisclosureText,
                          }
                        : {}),
                    }}
                    shippingQuote={
                      requiresLiveShippingQuote &&
                      shippingEnabled &&
                      activeShippingQuote &&
                      selectedShippingRateId
                        ? {
                            token: activeShippingQuote.quoteToken,
                            fingerprint: activeShippingQuote.fingerprint,
                            rateId: selectedShippingRateId,
                          }
                        : undefined
                    }
                    promotionCode={activeRedeemedPromotionCode}
                    onPaid={isBuyNow ? () => undefined : clearCart}
                  />
                </div>

                {isBuyNow ? (
                  <p className="font-body text-xs font-bold text-lh-muted">
                    This is a single-item checkout. Your existing cart has not
                    been modified.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </section>
  );
}

async function waitForShippingQuote(input: {
  operationId: string;
  quoteToken: string;
  expiresAt: string;
}): Promise<Partial<ShippingQuote> & { error?: string }> {
  const expiresAt = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(expiresAt))
    return { error: "Shipping quote is invalid" };
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    const params = new URLSearchParams({
      operationId: input.operationId,
      quoteToken: input.quoteToken,
    });
    const response = await fetch(`/api/shipping/quotes?${params.toString()}`, {
      cache: "no-store",
    });
    const data = (await response.json()) as Partial<ShippingQuote> & {
      error?: string;
    };
    if (response.status === 202) continue;
    if (!response.ok)
      return {
        error:
          data.error ?? "Shipping rates are unavailable. Please try again.",
      };
    return data;
  }
  return { error: "Shipping quote expired before rates were ready" };
}

export default function CheckoutPageClient({
  products,
  shippingEnabled,
  manualCheckoutPolicy,
  pickupTax,
}: CheckoutPageClientProps) {
  return (
    <Suspense
      fallback={
        <section className="min-h-screen bg-lh-neutral-2">
          <div className="content-container py-12">
            <p className="font-body text-lh-muted">Loading checkout...</p>
          </div>
        </section>
      }
    >
      <CheckoutContent
        products={products}
        shippingEnabled={shippingEnabled}
        manualCheckoutPolicy={manualCheckoutPolicy}
        pickupTax={pickupTax}
      />
    </Suspense>
  );
}
