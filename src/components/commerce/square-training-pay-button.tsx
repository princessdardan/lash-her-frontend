"use client";

import { useCallback, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  SquareCommerceCardForm,
  type SquareCommerceCardFormHandle,
  type SquareCommerceTokenResult,
} from "@/components/commerce/square-commerce-card-form";

interface SquareTrainingPayButtonProps {
  disabled?: boolean;
  programSlug: string;
  clientPrice: number;
  promotionCode?: string;
  /** Best-known total in cents, used for the card issuer's SCA challenge. */
  amountCents: number;
  customer: {
    name: string;
    email: string;
  };
  onPaid: () => void;
}

const GENERIC_ERROR =
  "Unable to complete checkout. Please review your details and try again.";
const PAYMENT_DECLINED_ERROR =
  "Payment could not be completed. Please try again or use another card.";

export function SquareTrainingPayButton({
  disabled = false,
  programSlug,
  clientPrice,
  promotionCode,
  amountCents,
  customer,
  onPaid,
}: SquareTrainingPayButtonProps): ReactElement {
  const router = useRouter();
  const formRef = useRef<SquareCommerceCardFormHandle>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCardReady, setIsCardReady] = useState(false);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfigUnavailable = useCallback(() => setIsUnavailable(true), []);

  const handleTokenized = useCallback(
    async ({ sourceId, verificationToken }: SquareCommerceTokenResult) => {
      const res = await fetch("/api/training-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug,
          customerName: customer.name,
          customerEmail: customer.email,
          clientPrice,
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

      onPaid();
      router.push(
        `/training-programs/${encodeURIComponent(programSlug)}/confirmation?order=${encodeURIComponent(data.orderId)}`,
      );
    },
    [
      programSlug,
      customer.name,
      customer.email,
      clientPrice,
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
