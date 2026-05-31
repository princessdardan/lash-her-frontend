import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { isTrainingAfterpaySquareInvoiceEnabled } from "@/lib/env/private-checkout";
import { getTrainingCheckoutProduct, isTrainingPurchasable, TRAINING_CHECKOUT_TAX_RATE } from "@/lib/training-checkout";
import { CheckoutForm } from "./checkout-form";

export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  const title = `Checkout: ${data?.title || "Training"}`;
  const description = `Enroll in ${data?.title || "our training program"}`;

  return {
    title,
    description,
    robots: { index: false, follow: false },
  };
}

export default async function TrainingCheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  if (!data || !isTrainingPurchasable(data)) {
    notFound();
  }

  const product = getTrainingCheckoutProduct(data);
  if (!product) notFound();

  const subtotal = product.price;
  const tax = subtotal * TRAINING_CHECKOUT_TAX_RATE;
  const total = subtotal + tax;
  const manualDiscount = product.originalPrice === undefined ? 0 : product.originalPrice - product.price;

  return (
    <section className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-2xl mx-auto">
          <article className="soft-panel p-8 md:p-12 rounded-2xl bg-white shadow-sm">
            <h1 className="section-heading mb-2 text-center">Enrollment Checkout</h1>
            <h2 className="section-subheading mb-8 text-center">{data.title}</h2>

            <CheckoutForm
              programSlug={slug}
              clientPrice={subtotal}
              originalSubtotal={product.originalPrice}
              manualDiscount={manualDiscount}
              subtotal={subtotal}
              tax={tax}
              total={total}
              currency={product.currency || "CAD"}
              afterpaySquareInvoiceEnabled={isTrainingAfterpaySquareInvoiceEnabled()}
            />
          </article>
        </div>
      </section>
    </section>
  );
}
