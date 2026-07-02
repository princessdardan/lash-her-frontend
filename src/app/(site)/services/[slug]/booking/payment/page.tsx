import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { resolveServiceBookingPaymentSession } from "@/lib/booking/payment-session";
import { ServiceBookingPaymentShell } from "@/components/booking/service-booking-payment-shell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Booking Payment",
  robots: { index: false, follow: false },
};

interface ServiceBookingPaymentPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}

export default async function ServiceBookingPaymentPage({
  params,
  searchParams,
}: ServiceBookingPaymentPageProps) {
  const [{ slug }, { session: rawSession }] = await Promise.all([
    params,
    searchParams,
  ]);

  if (Array.isArray(rawSession)) {
    notFound();
  }

  const session = rawSession?.trim() ?? "";

  if (session.length === 0) {
    notFound();
  }

  const result = await resolveServiceBookingPaymentSession({
    paymentSessionReference: session,
    serviceSlug: slug,
    now: new Date(),
  });

  if (result.status === "not_found") {
    notFound();
  }

  if (result.status === "confirmed") {
    redirect(`/booking/confirmation?payment=${result.paymentStatus}`);
  }

  if (result.status === "expired") {
    return (
      <section
        className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
        aria-label="Service booking payment expired"
      >
        <div className="content-container max-w-2xl mx-auto text-center">
          <h1 className="section-heading mb-6">Payment Session Expired</h1>
          <p className="text-lh-shadow/80 text-lg mb-8">
            Your reservation time has been released. Please start your booking
            again to select a new available time.
          </p>
          <Link
            href={`/services/${result.serviceSlug}/booking`}
            className="inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent"
          >
            Return to Booking
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section
      className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
      aria-label="Service booking payment"
    >
      <div className="content-container max-w-5xl mx-auto">
        <ServiceBookingPaymentShell session={result.session} />
      </div>
    </section>
  );
}
