"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";

import {
  SquareCardOnFileForm,
  BookingHoldExpiredError,
} from "./square-card-on-file-form";
import type { CardOnFileConfirmationResult } from "./square-card-on-file-form";
import { startLegacySquareCheckout } from "./service-booking-payment-client";

export function ServiceBookingPaymentShell({
  session,
}: {
  session: ServiceBookingPaymentSessionDisplay;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const [isExpired, setIsExpired] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const isStartingFallbackRef = useRef(false);
  const isMountedRef = useRef(true);

  const handleSuccess = useCallback((result: CardOnFileConfirmationResult) => {
    const status =
      result.bookingStatus === "booked" ? "booked" : "manual_followup";
    window.location.assign(`/booking/confirmation?payment=${status}`);
  }, []);

  const handleError = useCallback((message: string) => {
    if (!isMountedRef.current) return;
    setErrorMessage(message);
  }, []);

  const handleExpired = useCallback(() => {
    if (!isMountedRef.current) return;
    setIsExpired(true);
    setErrorMessage("Hold expired, choose another time.");
  }, []);

  const handleConfigUnavailable = useCallback(() => {
    if (isStartingFallbackRef.current) return;
    isStartingFallbackRef.current = true;

    startLegacySquareCheckout(session.paymentSessionReference)
      .then((checkout) => {
        if (!isMountedRef.current) return;
        setFallbackUrl(checkout.checkoutUrl);
        window.location.assign(checkout.checkoutUrl);
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current) return;
        isStartingFallbackRef.current = false;

        if (error instanceof BookingHoldExpiredError) {
          handleExpired();
          return;
        }
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to start checkout. Please try again.",
        );
      });
  }, [handleExpired, session.paymentSessionReference]);

  // Avoid state updates if the promise resolves/rejects after navigation/unmount.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return (
    <section className="flex flex-col gap-8 lg:flex-row">
      <section className="min-w-0 flex-1 rounded-xl border border-lh-line bg-white p-6">
        <Link
          href={`/services/${session.serviceSlug}/booking`}
          className="mb-6 inline-flex text-lh-muted hover:text-black"
        >
          ← Back to details
        </Link>
        <p className="eyebrow-label mb-2">Secure payment</p>
        <h1 className="section-heading mb-4">Save your card to confirm</h1>
        <p className="mb-6 text-sm font-bold leading-6 text-lh-muted">
          Your card is stored for no-show protection. No payment is taken today.
        </p>
        {isExpired ? (
          <div className="rounded-[18px] border border-lh-line bg-lh-neutral-2 p-5 text-center">
            <p className="mb-4 font-heading text-lg uppercase tracking-[0.12em] text-lh-accent">
              Hold expired, choose another time
            </p>
            <Button asChild variant="outline">
              <Link href={`/services/${session.serviceSlug}/booking`}>
                Choose another time
              </Link>
            </Button>
          </div>
        ) : (
          <SquareCardOnFileForm
            cardholderName={session.customerName}
            maxChargeCents={session.totalCents}
            paymentSessionReference={session.paymentSessionReference}
            onSuccess={handleSuccess}
            onError={handleError}
            onHoldExpired={handleExpired}
            onConfigUnavailable={handleConfigUnavailable}
          />
        )}
        {errorMessage && (
          <p
            role="alert"
            className="mt-4 text-center text-sm font-medium text-red-600"
          >
            {errorMessage}
          </p>
        )}
        {fallbackUrl && (
          <Button asChild type="button" variant="dark" className="mt-4 w-full">
            <a href={fallbackUrl}>Continue to secure Square checkout</a>
          </Button>
        )}
      </section>
      <aside className="w-full shrink-0 lg:w-80">
        <section className="sticky top-24 rounded-xl border border-lh-line bg-white p-6">
          <h2 className="section-subheading mb-4 text-xl md:text-xl lg:text-xl">
            Summary
          </h2>
          <div className="space-y-4">
            <div className="flex justify-between text-sm">
              <span className="font-medium text-black">
                {session.serviceTitle}
              </span>
              <span className="text-black">
                {formatCad(session.totalCents / 100)}
              </span>
            </div>
            <div className="border-t border-lh-line pt-4">
              <p className="mb-1 text-sm font-medium text-black">
                Selected Time
              </p>
              <p className="text-sm text-lh-muted">
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: session.timezone,
                }).format(new Date(session.selectedStart))}
              </p>
            </div>
            <div className="border-t border-lh-line pt-4">
              <div className="flex justify-between font-medium text-black">
                <span>Total</span>
                <span>{formatCad(session.totalCents / 100)}</span>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </section>
  );
}
