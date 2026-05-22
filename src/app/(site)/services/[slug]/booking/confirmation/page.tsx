import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getVerifiedServiceBookingConfirmation } from "@/lib/booking-confirmation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Booking Confirmation",
    description: "Your appointment booking confirmation.",
    robots: { index: false, follow: false },
  };
}

interface ServiceBookingConfirmationPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ order?: string }>;
}

export default async function ServiceBookingConfirmationPage({
  params,
  searchParams,
}: ServiceBookingConfirmationPageProps) {
  noStore();

  const [{ slug }, { order }] = await Promise.all([params, searchParams]);
  const confirmation = await getVerifiedServiceBookingConfirmation({
    orderId: order,
    serviceSlug: slug,
  });

  if (!confirmation) {
    notFound();
  }

  const { orderId, status } = confirmation;
  const isPending = status === "paid_pending_booking";
  const needsFollowUp = status === "manual_followup" || status === "booking_failed";

  const title = isPending || needsFollowUp ? "Payment Received" : "Booking Confirmed";
  const message = needsFollowUp
    ? "Thank you! Your payment has been successfully processed, and we will manually confirm your appointment time."
    : isPending
      ? "Thank you! Your payment has been successfully processed. We are currently finalizing your appointment details."
      : "Thank you! Your appointment has been successfully booked and payment is processed.";
  const nextSteps = needsFollowUp
    ? "Our team will reach out shortly to finalize your booking details."
    : isPending
      ? "You will receive a confirmation email shortly once your booking is fully confirmed."
      : "We have sent a confirmation email with your appointment details. We look forward to seeing you.";

  return (
    <div className="flex flex-col min-h-screen bg-lh-neutral-2">
      <section className="section-shell py-16 md:py-24">
        <div className="content-container max-w-2xl mx-auto">
          <div className="soft-panel p-8 md:p-12 rounded-2xl bg-white shadow-sm text-center">
            <h1 className="section-heading mb-6">{title}</h1>

            <div className="space-y-6 text-lh-shadow/80 text-lg mb-8">
              <p>{message}</p>

              <div className="bg-lh-neutral/20 p-4 rounded-xl border border-lh-neutral/30 inline-block mx-auto">
                <p className="text-sm text-lh-shadow/70 mb-1">Order Reference</p>
                <p className="font-medium text-lh-shadow font-mono">{orderId}</p>
              </div>
            </div>

            <div className="border-t border-lh-neutral/20 pt-8">
              <h3 className="font-medium text-xl mb-4">Next Steps</h3>

              <div className="space-y-6">
                <p className="text-lh-shadow/80">{nextSteps}</p>
                <Link href="/services" className="btn-primary-red inline-block">
                  Explore Services
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
