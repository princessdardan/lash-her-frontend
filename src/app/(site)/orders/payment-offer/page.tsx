import type { Metadata } from "next";
import { cookies } from "next/headers";

import {
  getSupplementalPaymentOffer,
  SUPPLEMENTAL_PAYMENT_OFFER_COOKIE,
} from "@/lib/commerce/supplemental-payment-offers";

import PaymentOfferClient from "./payment-offer-client";

export const metadata: Metadata = {
  title: "Supplemental payment | Lash Her",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PaymentOfferPage() {
  const sessionToken =
    (await cookies()).get(SUPPLEMENTAL_PAYMENT_OFFER_COOKIE)?.value ?? "";
  const offer = sessionToken
    ? await getSupplementalPaymentOffer(sessionToken)
    : null;
  if (!offer) {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="font-serif text-3xl">
          This payment offer is unavailable
        </h1>
        <p className="mt-4 text-sm text-stone-700">
          It may be invalid, expired, superseded, paid, or already closed.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-serif text-3xl">Review your payment offer</h1>
      <dl className="mt-8 grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm">
        <dt>Order</dt>
        <dd>{offer.orderReference}</dd>
        <dt>Purpose</dt>
        <dd>
          {offer.purpose === "manual_shipping"
            ? "Agreed manual shipping"
            : "Address-change shipping increase"}
        </dd>
        <dt>Amount</dt>
        <dd>
          {new Intl.NumberFormat("en-CA", {
            style: "currency",
            currency: offer.currency,
          }).format(offer.amountCents / 100)}
        </dd>
        <dt>Expires</dt>
        <dd>
          {offer.expiresAt.toLocaleString("en-CA", {
            timeZone: "America/Toronto",
          })}
        </dd>
        <dt>Offer scope</dt>
        <dd className="break-all font-mono text-xs">{offer.scopeKey}</dd>
        <dt>Conditions hash</dt>
        <dd className="break-all font-mono text-xs">{offer.conditionsHash}</dd>
        <dt>Disclosure hash</dt>
        <dd className="break-all font-mono text-xs">{offer.disclosureHash}</dd>
      </dl>
      <section className="mt-8" aria-labelledby="offer-disclosure">
        <h2 id="offer-disclosure" className="font-serif text-xl">
          Offer disclosure
        </h2>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap border border-stone-200 p-4 text-xs">
          {JSON.stringify(offer.disclosureSnapshot ?? {}, null, 2)}
        </pre>
      </section>
      <PaymentOfferClient operationId={offer.operationId} />
    </main>
  );
}
