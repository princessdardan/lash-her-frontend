import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payment received | Lash Her",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// Square redirects here after a successful supplemental payment-link payment.
// Finalization is driven asynchronously by the Square webhook (and the
// reconciliation backstop), which may lag this redirect by a few seconds, so
// this page intentionally reads no order-specific state — it is a static
// reassurance that the payment landed and the order updates on its own.
export default function SupplementalPaymentReceivedPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-serif text-3xl">Payment received</h1>
      <p className="mt-4 text-sm text-stone-700">
        Thank you — your payment has been received. We&rsquo;re confirming it
        now and your order will update automatically once it&rsquo;s processed;
        this usually takes just a moment. You can close this tab. If you have
        any questions, reply to your order email and we&rsquo;ll be glad to
        help.
      </p>
    </main>
  );
}
