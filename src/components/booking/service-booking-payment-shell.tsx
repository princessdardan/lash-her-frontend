"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";
import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";

import { ServiceBookingPaymentForm } from "./service-booking-payment-form";
import type { ServiceBookingPaymentConfirmation } from "./service-booking-payment-form";

// Node and WebKit ICU disagree on two details that would otherwise make the
// server-rendered date/time strings mismatch on hydration in Safari:
//   1. the separator before AM/PM \u2014 Node uses the narrow no-break space U+202F
//      while some WebKit builds use a regular space, and
//   2. the connector between the date and the time in a combined date+time
//      pattern \u2014 Node joins the long form with " at " and the short form with
//      ", " while some WebKit builds join both with " at ".
// Formatting the date and the time separately and joining them with an explicit
// literal connector removes the connector ambiguity, and collapsing the no-break
// spaces removes the separator ambiguity, so the server and the client produce
// identical strings across browsers. The literal connectors are chosen to match
// Node's current output, so the user-facing text is unchanged.
function normalizeSpaces(formatted: string): string {
  return formatted.replace(/[\u202f\u00a0]/g, " ");
}

function formatDateTime(
  value: string,
  timeZone: string,
  weekday: "long" | "short",
  month: "long" | "short",
  connector: string,
): string {
  const date = new Date(value);
  const datePart = new Intl.DateTimeFormat("en-US", {
    weekday,
    month,
    day: "numeric",
    timeZone,
  }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);

  return normalizeSpaces(`${datePart}${connector}${timePart}`);
}

export function ServiceBookingPaymentShell({
  marketingOptInLabel,
  session: initialSession,
}: {
  marketingOptInLabel: string;
  session: ServiceBookingPaymentSessionDisplay;
}) {
  const [session, setSession] = useState(initialSession);
  const [errorMessage, setErrorMessage] = useState("");
  const [isExpired, setIsExpired] = useState(false);
  const isMountedRef = useRef(true);

  const handleSuccess = useCallback(
    (result: ServiceBookingPaymentConfirmation) => {
      const status =
        result.bookingStatus === "booked" ? "booked" : "manual_followup";
      window.location.assign(`/booking/confirmation?payment=${status}`);
    },
    [],
  );

  const handleExpired = useCallback(() => {
    if (!isMountedRef.current) return;
    setIsExpired(true);
    setErrorMessage("Hold expired, choose another time.");
  }, []);

  const handleSessionUpdate = useCallback(
    (updatedSession: ServiceBookingPaymentSessionDisplay) => {
      if (!isMountedRef.current) return;
      setSession(updatedSession);
    },
    [],
  );

  // Avoid state updates if the promise resolves/rejects after navigation/unmount.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const formattedTime = formatDateTime(
    session.selectedStart,
    session.timezone,
    "long",
    "long",
    " at ",
  );

  const formattedExpiration = formatDateTime(
    session.expiresAt,
    session.timezone,
    "short",
    "short",
    ", ",
  );

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
        <h1 className="section-heading mb-4">Pay and confirm your booking</h1>
        <p className="mb-6 text-sm font-bold leading-6 text-lh-muted">
          Today’s payment secures your appointment. Your card will also be
          stored for no-show and late-cancellation protection according to the
          booking policy.
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
          <ServiceBookingPaymentForm
            marketingOptInLabel={marketingOptInLabel}
            session={session}
            onSessionUpdate={handleSessionUpdate}
            onSuccess={handleSuccess}
            onExpired={handleExpired}
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
            </div>
            {session.selectedAddOn && (
              <div className="flex justify-between text-sm text-lh-muted">
                <span>{session.selectedAddOn.name} add-on</span>
                <span>{formatCad(session.selectedAddOn.priceCents / 100)}</span>
              </div>
            )}
            {session.pricing.promotionDiscountCents ? (
              <div className="flex justify-between text-sm text-lh-muted">
                <span>
                  Discount{" "}
                  {session.pricing.promotionCode
                    ? `(${session.pricing.promotionCode})`
                    : ""}
                </span>
                <span>
                  -{formatCad(session.pricing.promotionDiscountCents / 100)}
                </span>
              </div>
            ) : null}
            <div className="border-t border-lh-line pt-4">
              <p className="mb-1 text-sm font-medium text-black">
                Selected Time
              </p>
              <p className="text-sm text-lh-muted">{formattedTime}</p>
            </div>
            <div className="border-t border-lh-line pt-4">
              <p className="mb-2 text-sm font-medium text-black">
                Payment amount options
              </p>
              <div className="flex justify-between text-sm text-lh-muted">
                <span>Deposit (before HST)</span>
                <span>
                  {formatCad(
                    Math.min(
                      session.pricing.depositAmountCents,
                      session.pricing.discountedBasePriceCents ??
                        session.pricing.fullPriceCents,
                    ) / 100,
                  )}
                </span>
              </div>
              <div className="flex justify-between text-sm text-lh-muted">
                <span>Full price (before HST)</span>
                <span>
                  {formatCad(
                    (session.pricing.discountedBasePriceCents ??
                      session.pricing.fullPriceCents) / 100,
                  )}
                </span>
              </div>
              <p className="mt-2 text-xs leading-snug text-lh-muted">
                Ontario HST (13%) is added to the selected payment amount at
                checkout.
              </p>
            </div>
            <div className="border-t border-lh-line pt-4">
              <div className="flex justify-between text-sm text-lh-muted">
                <span>Hold expires</span>
                <span>{formattedExpiration}</span>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </section>
  );
}
