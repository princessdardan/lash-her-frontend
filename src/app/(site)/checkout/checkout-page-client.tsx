"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Check, ChevronDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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
import { SquareProductPayButton } from "@/components/commerce/square-product-pay-button";
import { useProductCart } from "@/components/commerce/product-cart-provider";
import type {
  ProductCheckoutDisclosureInput,
  UsImportTerms,
} from "@/lib/commerce/product-checkout-disclosures";
import type { ManualProductCheckoutPolicy } from "@/lib/commerce/product-manual-checkout-config";

interface CheckoutTaxContext {
  rate: number;
  name: string;
  collected: boolean;
}

interface CheckoutTermsRequirement {
  version: string;
  text: string;
  textHash: string;
}

interface CheckoutPageClientProps {
  products: TProduct[];
  shippingEnabled: boolean;
  manualCheckoutPolicy: ManualProductCheckoutPolicy;
  /** Terms-of-sale assent the customer must accept at checkout (Reg. 17/05). */
  termsRequirement: CheckoutTermsRequirement;
  /** Versioned refund/cancellation policy for shipped (automated) orders. */
  shippedRefundPolicy: CheckoutTermsRequirement;
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

const FIELD_LABEL_CLASS =
  "mb-1.5 block font-body text-sm font-medium text-lh-primary";
const HELPER_TEXT_CLASS = "font-body text-sm leading-6 text-lh-muted";

function CheckoutContent({
  products,
  shippingEnabled,
  manualCheckoutPolicy,
  termsRequirement,
  shippedRefundPolicy,
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
  const [acceptedRefundPolicy, setAcceptedRefundPolicy] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Two-step flow: collect contact + delivery address first, then reveal the
  // payment step (rate selection, policy assents, and the card form) once the
  // shipping quote is in hand so the charged amount is final and accurate.
  const [step, setStep] = useState<"details" | "payment">("details");
  // Mobile-only order-summary disclosure. Always expanded on lg+ via CSS.
  const [summaryExpanded, setSummaryExpanded] = useState(false);

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
  const normalizedCustomerPhone = normalizeCheckoutText(customerPhone);
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
          phone: normalizedCustomerPhone,
        },
        shippingAddress,
      }),
    [
      activeRedeemedPromotionCode,
      checkoutItems,
      normalizedCustomerPhone,
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

  // Whether the customer has provided everything the details step needs before
  // the payment step can open. Pickup needs no address; shipping needs a full
  // address plus a phone number for the carrier.
  const detailsComplete = isManualCheckout
    ? hasValidCustomerDetails
    : hasValidCustomerDetails &&
      hasValidShippingAddress &&
      Boolean(normalizedCustomerPhone);
  // Automated-shipping carts can't proceed at all when online shipping is off.
  const shippingUnavailableForCart = requiresLiveShippingQuote && !shippingEnabled;

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

  // Fetch (or refresh) live shipping rates for the entered address. Returns
  // true only when a usable quote was stored, so the caller can advance the
  // step machine on success.
  const loadShippingRates = async (): Promise<boolean> => {
    if (
      !requiresLiveShippingQuote ||
      !displayedCart ||
      !hasValidCustomerDetails ||
      !hasValidShippingAddress ||
      !normalizedCustomerPhone
    )
      return false;
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
            phone: normalizedCustomerPhone,
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
        return false;
      }
      const nextQuote = data as ShippingQuote;
      setShippingQuote(nextQuote);
      setShippingQuoteRequestKey(quoteRequestKey);
      setSelectedShippingRateId(nextQuote.rates[0]?.id ?? null);
      return true;
    } catch {
      setShippingQuoteError(
        "Shipping rates are unavailable. Please try again.",
      );
      return false;
    } finally {
      setIsLoadingShippingRates(false);
    }
  };

  // Advance from the details step to the payment step. For shipped orders this
  // fetches rates first (reusing a still-valid quote to avoid a needless call)
  // and only opens payment once a quote is in hand.
  const handleContinueToPayment = async () => {
    if (!detailsComplete || shippingUnavailableForCart) return;
    if (!requiresLiveShippingQuote) {
      setStep("payment");
      return;
    }
    if (activeShippingQuote && selectedShippingRateId) {
      setStep("payment");
      return;
    }
    const ok = await loadShippingRates();
    if (ok) setStep("payment");
  };

  const handleEditDetails = () => setStep("details");

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

  // Shared props for the Square checkout pay button.
  const payButtonDisabled =
    !displayedCart ||
    !hasValidCustomerDetails ||
    !acceptedTerms ||
    (requiresShippingAddress && !hasValidShippingAddress) ||
    (requiresLiveShippingQuote &&
      (!shippingEnabled || !activeShippingQuote || !selectedShippingRateId)) ||
    !hasValidShippingDisclosure ||
    (isManualCheckout &&
      (!manualCheckoutPolicy.enabled || !acceptedCancellationPolicy)) ||
    (!isManualCheckout && !acceptedRefundPolicy);
  const payButtonCustomer = {
    name: normalizedCustomerName,
    email: normalizedCustomerEmail,
    phone: normalizedCustomerPhone,
  };
  const payButtonShippingAddress = requiresShippingAddress
    ? shippingAddress
    : undefined;
  const payButtonDisclosures: ProductCheckoutDisclosureInput = {
    ...(acceptedTerms
      ? {
          termsAccepted: true,
          termsVersion: termsRequirement.version,
          termsTextHash: termsRequirement.textHash,
        }
      : {}),
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
    ...(!isManualCheckout && acceptedRefundPolicy
      ? {
          cancellationPolicyAccepted: true,
          cancellationPolicyVersion: shippedRefundPolicy.version,
          cancellationPolicyTextHash: shippedRefundPolicy.textHash,
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
          usImportDisclosureText: activeShippingQuote.usImportDisclosureText,
        }
      : {}),
  };
  const payButtonShippingQuote =
    requiresLiveShippingQuote &&
    shippingEnabled &&
    activeShippingQuote &&
    selectedShippingRateId
      ? {
          token: activeShippingQuote.quoteToken,
          fingerprint: activeShippingQuote.fingerprint,
          rateId: selectedShippingRateId,
        }
      : undefined;
  const payButtonOnPaid = isBuyNow ? () => undefined : clearCart;
  const checkoutTotalCents = Math.round(checkoutTotal * 100);

  if (checkoutItems.length === 0) {
    return (
      <section className="min-h-screen bg-lh-neutral-2">
        <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
          <div className="content-container max-w-2xl">
            <article className="soft-panel bg-lh-white p-8 md:p-12 text-center">
              <h1 className="font-heading text-3xl font-normal text-lh-shadow mb-4">
                Your cart is empty
              </h1>
              <p className={cn(HELPER_TEXT_CLASS, "mb-8")}>
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

  const orderSummary = displayedCart ? (
    <aside className="lg:order-2">
      <div className="soft-panel bg-lh-white p-6 lg:sticky lg:top-24">
        <button
          type="button"
          onClick={() => setSummaryExpanded((value) => !value)}
          aria-expanded={summaryExpanded}
          className="flex w-full items-center justify-between gap-3 text-left lg:cursor-default lg:pointer-events-none"
        >
          <span className="flex items-center gap-2">
            <span className="eyebrow-label">Order summary</span>
            <ChevronDown
              className={cn(
                "size-4 text-lh-muted transition-transform lg:hidden",
                summaryExpanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </span>
          <span className="font-heading text-xl font-normal text-lh-shadow lg:hidden">
            {formatCad(checkoutTotal)}
          </span>
        </button>

        <div
          className={cn(
            "mt-5 flex-col gap-5",
            summaryExpanded ? "flex" : "hidden",
            "lg:flex",
          )}
        >
          <div className="flex items-center justify-between">
            <span className={HELPER_TEXT_CLASS}>
              {totalItems} item{totalItems !== 1 ? "s" : ""}
            </span>
            {!isBuyNow ? (
              <Link
                href="/products"
                className="font-body text-sm font-medium text-lh-primary transition-colors hover:text-lh-accent"
              >
                Continue shopping
              </Link>
            ) : null}
          </div>

          <ul className="divide-y divide-lh-line">
            {displayedCart.lineItems.map((lineItem) => (
              <li
                key={`${lineItem.productId}:${lineItem.variantId || "default"}`}
                className="flex items-start justify-between gap-4 py-3"
              >
                <div>
                  <p className="font-body text-sm font-medium text-lh-shadow">
                    {lineItem.description}
                  </p>
                  <p className={cn(HELPER_TEXT_CLASS, "text-xs")}>
                    Qty {lineItem.quantity} × {formatCad(lineItem.price)}
                    {lineItem.originalPrice ? (
                      <span className="ml-2 text-lh-muted line-through">
                        {formatCad(lineItem.originalPrice)}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="text-right">
                  {lineItem.originalTotal ? (
                    <p className={cn(HELPER_TEXT_CLASS, "text-xs line-through")}>
                      {formatCad(lineItem.originalTotal)}
                    </p>
                  ) : null}
                  <p className="font-body text-sm font-medium text-lh-shadow">
                    {formatCad(lineItem.total)}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <div className="rounded-[18px] border border-lh-line bg-lh-neutral-2/60 p-4">
            <label
              htmlFor="checkout-promotion-code"
              className={FIELD_LABEL_CLASS}
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
                  (!activeRedeemedPromotionCode && !promotionCodeInput.trim())
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
              <p className="mt-2 font-body text-xs font-medium uppercase tracking-[0.12em] text-lh-primary">
                Code {activeRedeemedPromotionCode} applied.
              </p>
            ) : null}
            {promotionCodeError ? (
              <p
                className="mt-2 font-body text-xs font-medium text-lh-accent"
                role="alert"
              >
                {promotionCodeError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-lh-line pt-4">
            <div className="flex justify-between font-body text-sm text-lh-muted">
              <span>Subtotal</span>
              <span>{formatCad(cartAmount)}</span>
            </div>
            {displayedCart.manualDiscountAmount ? (
              <div className="flex justify-between font-body text-sm text-lh-muted">
                <span>Manual discounts</span>
                <span>-{formatCad(displayedCart.manualDiscountAmount)}</span>
              </div>
            ) : null}
            {activeRedeemedPromotionCode &&
            displayedCart.promotionDiscountAmount ? (
              <div className="flex justify-between font-body text-sm font-medium text-lh-primary">
                <span>Code {activeRedeemedPromotionCode}</span>
                <span>-{formatCad(displayedCart.promotionDiscountAmount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between font-body text-sm text-lh-muted">
              <span>Shipping</span>
              <span>
                {isManualCheckout
                  ? "Free studio pickup"
                  : selectedShippingRate
                    ? formatCad(shippingAmount)
                    : "Calculated at next step"}
              </span>
            </div>
            {taxAmountCents > 0 && taxContext ? (
              <div className="flex justify-between font-body text-sm text-lh-muted">
                <span>Tax ({taxContext.name})</span>
                <span>{formatCad(taxAmount)}</span>
              </div>
            ) : null}
            <div className="mt-1 flex items-center justify-between gap-4 border-t border-lh-line pt-3">
              <span className="font-body text-sm font-medium uppercase tracking-[0.12em] text-lh-muted">
                Total
              </span>
              <span className="flex flex-wrap items-baseline justify-end gap-2 font-heading text-2xl font-normal text-lh-shadow">
                {activeRedeemedPromotionCode &&
                displayedCart.promotionDiscountAmount ? (
                  <span className="font-body text-sm text-lh-muted line-through">
                    {formatCad(cartAmountBeforePromotion)}
                  </span>
                ) : null}
                <span>{formatCad(checkoutTotal)}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  ) : null;

  return (
    <section className="min-h-screen bg-lh-neutral-2">
      <section className="section-shell-soft pt-12 md:pt-16 lg:pt-20">
        <div className="content-container max-w-5xl">
          <header className="mb-8">
            <p className="eyebrow-label mb-3">
              {isBuyNow ? "Buy Now" : "Checkout"}
            </p>
            <h1 className="display-heading text-4xl md:text-5xl">
              {isBuyNow ? "Complete Your Purchase" : "Review Your Order"}
            </h1>
          </header>

          {cart.error ? (
            <div className="mb-6 rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4">
              <p className="font-body text-sm font-medium text-lh-accent">
                {cart.error}
              </p>
            </div>
          ) : null}

          {displayedCart ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-10">
              {orderSummary}

              <div className="flex flex-col gap-6 lg:order-1">
                {/* Step 1 — Contact & delivery details */}
                {step === "details" ? (
                  <section className="soft-panel bg-lh-white p-6 md:p-8">
                    <StepHeading
                      index={1}
                      title="Contact details"
                      state="active"
                    />

                    <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="checkout-name" className={FIELD_LABEL_CLASS}>
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
                          className={FIELD_LABEL_CLASS}
                        >
                          Phone{" "}
                          {!requiresShippingAddress ? (
                            <span className="font-normal text-lh-muted">
                              (optional)
                            </span>
                          ) : null}
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
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="checkout-email"
                          className={FIELD_LABEL_CLASS}
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

                    <div className="mt-8">
                      <StepHeading
                        index={2}
                        title={
                          fulfillmentMode === "manual_pickup"
                            ? "Fulfillment"
                            : "Shipping address"
                        }
                        state="active"
                      />
                      <p className={cn(HELPER_TEXT_CLASS, "mt-2")}>
                        {fulfillmentMode === "manual_pickup"
                          ? "Free studio pickup is arranged after payment — no delivery address or shipping charge is collected now."
                          : "We'll calculate live, insured and tracked shipping rates for this address on the next step."}
                      </p>

                      {isManualCheckout ? (
                        <div className="mt-4 rounded-[18px] border border-lh-line bg-lh-neutral-2/60 p-4 font-body text-sm leading-6 text-lh-shadow">
                          Optional shipping can be agreed and paid separately
                          after the order is confirmed; pickup remains available
                          until that supplemental payment succeeds.
                        </div>
                      ) : (
                        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div className="sm:col-span-2">
                            <label
                              htmlFor="checkout-shipping-line1"
                              className={FIELD_LABEL_CLASS}
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
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label
                              htmlFor="checkout-shipping-line2"
                              className={FIELD_LABEL_CLASS}
                            >
                              Apartment, suite, etc.{" "}
                              <span className="font-normal text-lh-muted">
                                (optional)
                              </span>
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
                            <label
                              htmlFor="checkout-shipping-city"
                              className={FIELD_LABEL_CLASS}
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
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="checkout-shipping-province"
                              className={FIELD_LABEL_CLASS}
                            >
                              Province / State
                            </label>
                            <Input
                              id="checkout-shipping-province"
                              type="text"
                              value={shippingProvince}
                              onChange={(e) =>
                                setShippingProvince(e.target.value)
                              }
                              maxLength={CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH}
                              autoComplete="shipping address-level1"
                              placeholder="ON"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="checkout-shipping-postal-code"
                              className={FIELD_LABEL_CLASS}
                            >
                              Postal code
                            </label>
                            <Input
                              id="checkout-shipping-postal-code"
                              type="text"
                              value={shippingPostalCode}
                              onChange={(e) =>
                                setShippingPostalCode(e.target.value)
                              }
                              maxLength={CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH}
                              autoComplete="shipping postal-code"
                              placeholder="M6E 2Y4"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor="checkout-shipping-country"
                              className={FIELD_LABEL_CLASS}
                            >
                              Country
                            </label>
                            <select
                              id="checkout-shipping-country"
                              value={shippingCountry}
                              onChange={(e) =>
                                setShippingCountry(e.target.value)
                              }
                              autoComplete="shipping country-name"
                              className="h-11 w-full rounded-[18px] border border-lh-line bg-lh-white px-3 font-body text-sm text-lh-shadow shadow-sm"
                            >
                              <option value="CA">Canada</option>
                              <option value="US">United States</option>
                            </select>
                          </div>
                        </div>
                      )}
                    </div>

                    {shippingUnavailableForCart ? (
                      <p
                        className="mt-6 rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 font-body text-sm leading-6 text-lh-accent"
                        role="alert"
                      >
                        Online shipping checkout is temporarily unavailable.
                        Please try again later or{" "}
                        <a href="/contact" className="underline">
                          contact us
                        </a>{" "}
                        to place your order.
                      </p>
                    ) : (
                      <div className="mt-6">
                        <Button
                          type="button"
                          variant="primary"
                          onClick={handleContinueToPayment}
                          disabled={
                            !detailsComplete || isLoadingShippingRates
                          }
                          aria-busy={isLoadingShippingRates}
                          className="h-12 w-full rounded-full px-6 font-body text-sm uppercase tracking-[0.12em]"
                        >
                          {isLoadingShippingRates
                            ? "Getting shipping rates…"
                            : "Continue to payment"}
                        </Button>
                        {!detailsComplete ? (
                          <p className={cn(HELPER_TEXT_CLASS, "mt-3 text-center")}>
                            {requiresShippingAddress
                              ? "Enter your contact and shipping details to continue."
                              : "Enter your contact details to continue."}
                          </p>
                        ) : null}
                        {shippingQuoteError ? (
                          <p
                            className="mt-3 text-center font-body text-sm font-medium text-lh-accent"
                            role="alert"
                          >
                            {shippingQuoteError}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </section>
                ) : (
                  <CompletedDetailsCard
                    name={normalizedCustomerName}
                    email={normalizedCustomerEmail}
                    phone={normalizedCustomerPhone}
                    isManualCheckout={isManualCheckout}
                    shippingAddress={shippingAddress}
                    onEdit={handleEditDetails}
                  />
                )}

                {/* Step 3 — Delivery method, disclosures & payment */}
                {step === "payment" ? (
                  <section className="soft-panel bg-lh-white p-6 md:p-8">
                    {requiresLiveShippingQuote ? (
                      <div className="mb-8">
                        <div className="flex items-center justify-between gap-3">
                          <StepHeading
                            index={3}
                            title="Delivery method"
                            state="active"
                          />
                          <button
                            type="button"
                            onClick={loadShippingRates}
                            disabled={isLoadingShippingRates}
                            className="font-body text-sm font-medium text-lh-primary transition-colors hover:text-lh-accent disabled:opacity-50"
                          >
                            {isLoadingShippingRates
                              ? "Recalculating…"
                              : "Recalculate"}
                          </button>
                        </div>

                        {shippingQuoteError ? (
                          <p
                            className="mt-3 font-body text-sm font-medium text-lh-accent"
                            role="alert"
                          >
                            {shippingQuoteError}
                          </p>
                        ) : null}

                        {activeShippingQuote ? (
                          <fieldset className="mt-4 space-y-3">
                            <legend className="sr-only">
                              Choose an insured tracked service
                            </legend>
                            {activeShippingQuote.rates.map((rate) => {
                              const selected = selectedShippingRateId === rate.id;
                              return (
                                <label
                                  key={rate.id}
                                  className={cn(
                                    "flex cursor-pointer items-start justify-between gap-4 rounded-[18px] border bg-lh-white p-4 transition-colors",
                                    selected
                                      ? "border-lh-primary ring-1 ring-lh-primary/40"
                                      : "border-lh-line hover:border-lh-primary/40",
                                  )}
                                >
                                  <span className="flex gap-3">
                                    <input
                                      type="radio"
                                      name="shipping-rate"
                                      value={rate.id}
                                      checked={selected}
                                      onChange={() =>
                                        setSelectedShippingRateId(rate.id)
                                      }
                                      className="mt-1"
                                    />
                                    <span>
                                      <span className="block font-body text-sm font-medium text-lh-shadow">
                                        {rate.title}
                                      </span>
                                      {rate.deliveryEstimate ? (
                                        <span className="block font-body text-xs text-lh-muted">
                                          {rate.deliveryEstimate}
                                        </span>
                                      ) : null}
                                      <span className="block font-body text-xs text-lh-muted">
                                        Insurance and tracking included
                                      </span>
                                      {rate.signatureRequired ? (
                                        <span className="block font-body text-xs font-medium text-lh-shadow">
                                          Signature is required at delivery
                                        </span>
                                      ) : null}
                                    </span>
                                  </span>
                                  <span className="whitespace-nowrap font-body text-sm font-medium text-lh-shadow">
                                    {formatCad(rate.amountCents / 100)}
                                  </span>
                                </label>
                              );
                            })}
                          </fieldset>
                        ) : null}

                        {requiresUsImportDisclosure &&
                        activeShippingQuote?.usImportDisclosureVersion &&
                        activeShippingQuote.usImportDisclosureText &&
                        activeShippingQuote.usImportTerms ? (
                          <div
                            className="mt-4 rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 font-body text-sm leading-6 text-lh-shadow"
                            data-disclosure-version={
                              activeShippingQuote.usImportDisclosureVersion
                            }
                            data-import-terms={activeShippingQuote.usImportTerms}
                          >
                            {activeShippingQuote.usImportDisclosureText}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mb-8 rounded-[18px] border border-lh-line bg-lh-neutral-2/60 p-4 font-body text-sm leading-6 text-lh-shadow">
                        Free studio pickup is the initial fulfillment method.
                        Pickup details are confirmed after payment.
                      </div>
                    )}

                    <StepHeading index={4} title="Payment" state="active" />
                    <p className={cn(HELPER_TEXT_CLASS, "mt-2 mb-5")}>
                      All transactions are secure and encrypted.
                    </p>

                    <div className="flex flex-col gap-4">
                      {isManualCheckout ? (
                        manualCheckoutPolicy.enabled &&
                        manualCheckoutPolicy.cancellationPolicyText &&
                        manualCheckoutPolicy.cancellationPolicyVersion ? (
                          <PolicyAssent
                            checked={acceptedCancellationPolicy}
                            onChange={setAcceptedCancellationPolicy}
                            summary="I accept the pickup cancellation policy."
                            fullText={
                              manualCheckoutPolicy.cancellationPolicyText
                            }
                            expandLabel="Read the pickup & cancellation policy"
                          />
                        ) : (
                          <p
                            className="rounded-[18px] border border-lh-accent/30 bg-lh-accent-soft p-4 font-body text-sm leading-6 text-lh-accent"
                            role="alert"
                          >
                            Manual checkout is unavailable until the current
                            pickup and cancellation policy is approved.
                          </p>
                        )
                      ) : (
                        <PolicyAssent
                          checked={acceptedRefundPolicy}
                          onChange={setAcceptedRefundPolicy}
                          summary="I accept the shipping, cancellation & refund policy."
                          fullText={shippedRefundPolicy.text}
                          expandLabel="Read the full shipping & refund policy"
                          policyHref="/policies/shipping-and-returns"
                        />
                      )}

                      <PolicyAssent
                        checked={acceptedTerms}
                        onChange={setAcceptedTerms}
                        summary={termsRequirement.text}
                        policyHref="/policies/terms-and-conditions"
                        policyLinkLabel="Read the Terms and Conditions"
                      />
                    </div>

                    <div className="mt-6">
                      <SquareProductPayButton
                        disabled={payButtonDisabled}
                        amountCents={checkoutTotalCents}
                        items={checkoutItems}
                        customer={payButtonCustomer}
                        shippingAddress={payButtonShippingAddress}
                        fulfillmentMode={fulfillmentMode}
                        disclosures={payButtonDisclosures}
                        shippingQuote={payButtonShippingQuote}
                        promotionCode={activeRedeemedPromotionCode}
                        onPaid={payButtonOnPaid}
                      />
                    </div>

                    <p
                      className={cn(
                        HELPER_TEXT_CLASS,
                        "mt-4 flex items-center justify-center gap-2 text-xs",
                      )}
                    >
                      <Lock className="size-3.5" aria-hidden="true" />
                      Secure checkout — your card details are encrypted.
                    </p>

                    {isBuyNow ? (
                      <p className={cn(HELPER_TEXT_CLASS, "mt-3 text-xs")}>
                        This is a single-item checkout. Your existing cart has
                        not been modified.
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}

function StepHeading({
  index,
  title,
  state,
}: {
  index: number;
  title: string;
  state: "active" | "complete";
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full font-body text-xs font-medium",
          state === "complete"
            ? "bg-lh-primary text-lh-white"
            : "bg-lh-primary-soft text-lh-primary",
        )}
        aria-hidden="true"
      >
        {state === "complete" ? <Check className="size-4" /> : index}
      </span>
      <h2 className="font-heading text-xl font-normal text-lh-shadow md:text-2xl">
        {title}
      </h2>
    </div>
  );
}

function CompletedDetailsCard({
  name,
  email,
  phone,
  isManualCheckout,
  shippingAddress,
  onEdit,
}: {
  name: string;
  email: string;
  phone: string;
  isManualCheckout: boolean;
  shippingAddress: {
    line1: string;
    line2?: string;
    city: string;
    province: string;
    postalCode: string;
    country: string;
  };
  onEdit: () => void;
}) {
  return (
    <section className="soft-panel bg-lh-white p-6 md:p-8">
      <div className="flex items-start justify-between gap-4">
        <StepHeading index={1} title="Contact & delivery" state="complete" />
        <button
          type="button"
          onClick={onEdit}
          className="font-body text-sm font-medium text-lh-primary transition-colors hover:text-lh-accent"
        >
          Edit
        </button>
      </div>
      <dl className="mt-4 space-y-2 font-body text-sm leading-6 text-lh-muted">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-lh-shadow">{name}</dt>
          <dd>· {email}</dd>
          {phone ? <dd>· {phone}</dd> : null}
        </div>
        <div>
          <dt className="sr-only">Fulfillment</dt>
          <dd>
            {isManualCheckout
              ? "Free studio pickup"
              : [
                  shippingAddress.line1,
                  shippingAddress.line2,
                  shippingAddress.city,
                  shippingAddress.province,
                  shippingAddress.postalCode,
                  shippingAddress.country,
                ]
                  .filter(Boolean)
                  .join(", ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PolicyAssent({
  checked,
  onChange,
  summary,
  fullText,
  expandLabel,
  policyHref,
  policyLinkLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  summary: string;
  fullText?: string;
  expandLabel?: string;
  policyHref?: string;
  policyLinkLabel?: string;
}) {
  return (
    <div className="rounded-[18px] border border-lh-line bg-lh-white p-4">
      <label className="flex items-start gap-3 font-body text-sm leading-6 text-lh-shadow">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {summary}
          {policyHref && !fullText ? (
            <>
              {" "}
              <a
                href={policyHref}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-lh-primary underline"
              >
                {policyLinkLabel ?? "Read the full policy"}
              </a>
              .
            </>
          ) : null}
        </span>
      </label>
      {fullText ? (
        <details className="mt-3 pl-7">
          <summary className="cursor-pointer font-body text-xs font-medium uppercase tracking-[0.12em] text-lh-primary">
            {expandLabel ?? "Read the full policy"}
          </summary>
          <p className="mt-2 font-body text-xs leading-6 text-lh-muted">
            {fullText}
          </p>
          {policyHref ? (
            <a
              href={policyHref}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-body text-xs font-medium text-lh-primary underline"
            >
              Open the full policy page
            </a>
          ) : null}
        </details>
      ) : null}
    </div>
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
  termsRequirement,
  shippedRefundPolicy,
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
        termsRequirement={termsRequirement}
        shippedRefundPolicy={shippedRefundPolicy}
        pickupTax={pickupTax}
      />
    </Suspense>
  );
}
