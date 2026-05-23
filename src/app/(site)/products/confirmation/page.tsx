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
    <div className="container mx-auto px-4 py-16 max-w-2xl text-center">
      <div className="card-white p-8 md:p-12">
        <h1 className="section-heading mb-6">
          Payment Received
        </h1>

        <div className="space-y-6 text-black font-light text-lg">
          <p>
            Thank you for your purchase! Your payment has been successfully processed.
          </p>

          {orderId ? (
            <div className="bg-brand-pink/20 p-4 rounded-md border border-brand-pink">
              <p className="text-sm text-brand-dark-grey mb-1">Order Reference</p>
              <p className="font-bold text-brand-red font-mono">{orderId}</p>
            </div>
          ) : null}

          <p>
            We will send a confirmation email with your order details shortly.
          </p>
        </div>

        <div className="mt-10">
          <Link
            href="/products"
            className="btn-primary-red inline-block"
          >
            Continue Shopping
          </Link>
        </div>
      </div>
    </div>
  );
}
