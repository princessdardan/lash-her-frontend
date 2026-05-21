import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import type { BookingType } from "@/lib/booking/types";

export const revalidate = 1800;

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; token?: string; type?: string; offering?: string; offeringSlug?: string }>;
}) {
  const params = await searchParams;
  const settings = await loaders.getBookingSettings();

  if (!settings || params.token !== undefined) {
    notFound();
  }

  const normalizeType = (type?: string): BookingType | undefined => {
    if (type === "training-call" || type === "in-person-appointment") {
      return type as BookingType;
    }
    return undefined;
  };

  const paidTrainingOrderId = params.order?.trim();
  const offeringSlug = params.offeringSlug?.trim() || params.offering?.trim();
  const offering = offeringSlug ? await loaders.getBookingOfferingBySlug(offeringSlug) : null;

  if (offeringSlug && !offering) {
    notFound();
  }

  const initialBookingType = paidTrainingOrderId
    ? "training-call"
    : offering?.bookingType ?? normalizeType(params.type);

  const offeringPayment = offering ? {
    depositAmount: offering.depositAmount,
    fullPrice: offering.fullPrice,
    currency: offering.currency,
  } : undefined;

  return (
    <main className="min-h-screen bg-background py-20 px-4 md:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-serif text-primary mb-4">Book an Appointment</h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Select a service and time below to schedule your session.
          </p>
        </div>

        <div className="bg-card border border-border/50 rounded-xl p-6 md:p-10 shadow-sm">
          <BookingFlow
            settings={settings}
            initialBookingType={initialBookingType}
            paidTrainingOrderId={paidTrainingOrderId}
            initialOfferingSlug={offeringSlug}
            offeringPayment={offeringPayment}
          />
        </div>
      </div>
    </main>
  );
}
