import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import type { ReactElement } from "react";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Order Confirmation",
  description: "Your order confirmation.",
  robots: { index: false, follow: false },
};

interface ConfirmationPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function ConfirmationPage({
  searchParams,
}: ConfirmationPageProps): Promise<ReactElement> {
  noStore();

  const params = await searchParams;
  const orderId = params.order;

  return (
    <div className="container mx-auto max-w-2xl px-4 py-16 text-center">
      <div className="rounded-[28px] border border-lh-line bg-lh-white p-8 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.08)] md:p-12">
        <h1 className="section-heading mb-6">
          Payment Received
        </h1>

        <div className="space-y-6 font-body text-lg font-bold leading-8 text-lh-shadow/80">
          <p>
            Thank you for your purchase! Your payment has been successfully processed.
          </p>

          {orderId ? (
            <div className="rounded-[20px] border border-lh-primary/20 bg-lh-primary-soft p-4">
              <p className="mb-1 text-sm text-lh-muted">Order Reference</p>
              <p className="font-mono font-bold text-lh-primary">{orderId}</p>
            </div>
          ) : null}

          <p>
            We will send a confirmation email with your order details shortly.
          </p>
        </div>

        <div className="mt-10">
          <Link
            href="/products"
            className="inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent"
          >
            Continue Shopping
          </Link>
        </div>
      </div>
    </div>
  );
}
