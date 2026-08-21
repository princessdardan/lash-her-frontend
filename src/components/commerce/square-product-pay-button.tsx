"use client";

import { useCallback, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { CartInputItem } from "@/lib/commerce/cart";
import type { ProductCheckoutDisclosureInput } from "@/lib/commerce/product-checkout-disclosures";
import {
  SquareCommerceCardForm,
  type SquareCommerceCardFormHandle,
  type SquareCommerceTokenResult,
} from "@/components/commerce/square-commerce-card-form";

export interface ProductShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

interface SquareProductPayButtonProps {
  disabled?: boolean;
  /** Best-known order total in cents, used for the card issuer's SCA challenge. */
  amountCents: number;
  items: CartInputItem[];
  promotionCode?: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
  };
  shippingAddress?: ProductShippingAddress;
  fulfillmentMode: "automated_shipping" | "manual_pickup" | "manual_shipping";
  disclosures: ProductCheckoutDisclosureInput;
  shippingQuote?: {
    token: string;
    fingerprint: string;
    rateId: string;
  };
  onPaid: () => void;
}

const GENERIC_ERROR =
  "Unable to complete checkout. Please review your cart and try again.";
const PAYMENT_DECLINED_ERROR =
  "Payment could not be completed. Please try again or use another card.";

export function SquareProductPayButton({
  disabled = false,
  amountCents,
  items,
  promotionCode,
  customer,
  shippingAddress,
  fulfillmentMode,
  disclosures,
  shippingQuote,
  onPaid,
}: SquareProductPayButtonProps): ReactElement {
  const router = useRouter();
  const formRef = useRef<SquareCommerceCardFormHandle>(null);
  // Stable per-attempt idempotency token: kept across retries of the same
  // attempt (so a re-click after a lost response reuses the same order and
  // Square dedupes the charge), reset only after a fully successful payment so a
  // genuine later purchase reserves a fresh order. Only the manual-pickup server
  // path consumes it; the automated-shipping path is idempotent via its quote.
  const reservationKeyRef = useRef<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfigUnavailable = useCallback(() => setIsUnavailable(true), []);

  const handleTokenized = useCallback(
    async ({ sourceId, verificationToken }: SquareCommerceTokenResult) => {
      if (!reservationKeyRef.current) {
        reservationKeyRef.current = crypto.randomUUID();
      }
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          items,
          fulfillmentMode,
          disclosures,
          reservationKey: reservationKeyRef.current,
          ...(shippingAddress ? { shippingAddress } : {}),
          ...(shippingQuote ? { shippingQuote } : {}),
          ...(promotionCode ? { promotionCode } : {}),
          payment: {
            sourceId,
            ...(verificationToken ? { verificationToken } : {}),
          },
        }),
      });

      if (!res.ok) {
        throw new Error(
          res.status === 402 ? PAYMENT_DECLINED_ERROR : GENERIC_ERROR,
        );
      }

      const data = (await res.json()) as {
        orderId?: string;
        status?: string;
      };

      if (data.status !== "paid" || !data.orderId) {
        throw new Error(
          "Payment could not be verified. Please contact Lash Her before retrying.",
        );
      }

      // Payment fully succeeded — drop the token so any genuine later purchase
      // mints a fresh one and reserves a new order.
      reservationKeyRef.current = undefined;

      onPaid();
      router.push(
        `/products/confirmation?order=${encodeURIComponent(data.orderId)}`,
      );
    },
    [
      customer,
      items,
      fulfillmentMode,
      disclosures,
      shippingAddress,
      shippingQuote,
      promotionCode,
      onPaid,
      router,
    ],
  );

  const handlePay = async () => {
    setError(null);
    setIsLoading(true);
    try {
      await formRef.current?.tokenize();
      // On success the tokenized handler navigates away; keep the busy state.
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error ? submitError.message : GENERIC_ERROR,
      );
      setIsLoading(false);
    }
  };

  if (isUnavailable) {
    return (
      <div
        className="rounded-[18px] border border-lh-line bg-lh-neutral-2/70 p-3 text-sm font-bold leading-6 text-lh-muted"
        role="alert"
      >
        Card checkout is temporarily unavailable. Please refresh or{" "}
        <a href="/contact" className="underline">
          contact us
        </a>
        .
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div
          className="rounded-[18px] border border-lh-accent/20 bg-lh-accent-soft p-3 text-sm font-bold leading-6 text-lh-accent"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <SquareCommerceCardForm
        ref={formRef}
        buyer={{
          amountCents,
          email: customer.email,
          fullName: customer.name,
          ...(customer.phone ? { phone: customer.phone } : {}),
        }}
        disabled={disabled || isLoading}
        onError={setError}
        onReadyChange={setIsCardReady}
        onConfigUnavailable={handleConfigUnavailable}
        onTokenized={handleTokenized}
      />

      <Button
        type="button"
        onClick={handlePay}
        disabled={disabled || !isCardReady || isLoading}
        aria-busy={isLoading}
        className="h-12 w-full rounded-full bg-lh-primary px-6 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white hover:bg-lh-accent"
      >
        {isLoading ? "Processing..." : "Pay securely"}
      </Button>
    </div>
  );
}
