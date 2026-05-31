import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { buildServiceBookingConfirmationResolverUrl } from "@/lib/training-checkout";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Booking Confirmation",
    description: "Your appointment booking confirmation.",
    robots: { index: false, follow: false },
  };
}

interface ConfirmationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type SquarePaymentReturnStatus =
  | "booked"
  | "paid_calendar_pending"
  | "finalization_pending"
  | "paid_unbookable_rebooking_pending"
  | "manual_review"
  | "manual_followup"
  | "booking_failed"
  | "duplicate"
  | "returned"
  | "verifying"
  | "unpaid"
  | "ignored";

const SQUARE_PAYMENT_RETURN_COPY: Record<SquarePaymentReturnStatus, { eyebrow: string; title: string; message: string; nextStep: string }> = {
  booked: {
    eyebrow: "Square checkout complete",
    title: "Booking confirmed",
    message: "Your payment was verified and your appointment is confirmed.",
    nextStep: "A confirmation email with appointment details will arrive shortly.",
  },
  paid_calendar_pending: {
    eyebrow: "Square checkout returned",
    title: "Payment verification pending",
    message: "Your payment was received. We are completing the final booking checks before sending appointment details.",
    nextStep: "Please keep an eye on your email; if anything needs attention, Lash Her will follow up directly.",
  },
  finalization_pending: {
    eyebrow: "Square checkout returned",
    title: "Payment verification pending",
    message: "Your payment was received and the appointment is finishing its final calendar check.",
    nextStep: "You do not need to pay again. We will send the confirmed appointment details shortly.",
  },
  paid_unbookable_rebooking_pending: {
    eyebrow: "Manual review",
    title: "Rebooking pending",
    message: "Your payment was received, but the selected time needs a manual rebooking review.",
    nextStep: "Lash Her will contact you with the nearest available replacement time.",
  },
  manual_review: {
    eyebrow: "Manual review",
    title: "Payment under review",
    message: "Square checkout returned and our team is manually verifying the payment and appointment status.",
    nextStep: "Please do not submit another payment; we will follow up as soon as the review is complete.",
  },
  manual_followup: {
    eyebrow: "Manual review",
    title: "Payment under review",
    message: "Your booking needs a manual follow-up before it can be confirmed.",
    nextStep: "Lash Her will reach out directly with next steps.",
  },
  booking_failed: {
    eyebrow: "Manual review",
    title: "Payment under review",
    message: "We could not automatically confirm the appointment after Square checkout returned.",
    nextStep: "Our team will review the payment and booking details before advising next steps.",
  },
  duplicate: {
    eyebrow: "Square checkout returned",
    title: "Payment verification pending",
    message: "Square has already sent this checkout back to us, and the booking is being verified.",
    nextStep: "Please watch your email for the final appointment update.",
  },
  returned: {
    eyebrow: "Square checkout returned",
    title: "Payment verification pending",
    message: "You have returned from Square checkout and we are verifying the payment server-side.",
    nextStep: "Please wait for email confirmation before booking another time.",
  },
  verifying: {
    eyebrow: "Square checkout returned",
    title: "Payment verification pending",
    message: "We are verifying Square payment status before confirming the appointment.",
    nextStep: "No private payment identifiers are shown here; watch your email for the result.",
  },
  unpaid: {
    eyebrow: "Square checkout incomplete",
    title: "Payment not verified",
    message: "We could not verify a completed payment from Square for this booking return.",
    nextStep: "Please return to services and choose a new appointment time if you still wish to book.",
  },
  ignored: {
    eyebrow: "Square checkout incomplete",
    title: "Payment not verified",
    message: "This Square return did not match a payment that can confirm an appointment.",
    nextStep: "Please contact Lash Her if you believe a payment was completed.",
  },
};

export default async function BookingConfirmationPage({
  searchParams,
}: ConfirmationPageProps) {
  const resolvedSearchParams = await searchParams;
  const keys = Object.keys(resolvedSearchParams);

  if (keys.length === 1 && keys[0] === "order") {
    const order = typeof resolvedSearchParams.order === "string" ? resolvedSearchParams.order.trim() : "";

    if (order.length === 0) {
      notFound();
    }

    noStore();
    return redirect(buildServiceBookingConfirmationResolverUrl({ orderId: order }));
  }

  if (keys.length === 1 && keys[0] === "payment") {
    const paymentStatus = typeof resolvedSearchParams.payment === "string" ? resolvedSearchParams.payment.trim() : "";

    if (isSquarePaymentReturnStatus(paymentStatus)) {
      noStore();
      const copy = SQUARE_PAYMENT_RETURN_COPY[paymentStatus];

      return (
        <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24" aria-label="Booking confirmation">
          <div className="content-container mx-auto max-w-2xl">
            <article role="status" aria-live="polite" className="soft-panel rounded-[18px] border border-lh-line bg-lh-white p-8 text-center shadow-sm md:p-12">
              <p className="eyebrow-label mb-3">{copy.eyebrow}</p>
              <h1 className="section-heading mb-6">{copy.title}</h1>
              <div className="space-y-4 font-body text-base font-bold leading-8 text-lh-muted md:text-lg">
                <p>{copy.message}</p>
                <p>{copy.nextStep}</p>
              </div>
              <div className="mt-8 border-t border-lh-line pt-6">
                <Link href="/services" className="primary-cta inline-flex rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent">
                  Return to services
                </Link>
              </div>
            </article>
          </div>
        </section>
      );
    }
  }

  notFound();
}

function isSquarePaymentReturnStatus(status: string): status is SquarePaymentReturnStatus {
  return status in SQUARE_PAYMENT_RETURN_COPY;
}
