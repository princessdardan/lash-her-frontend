import { notFound, redirect } from "next/navigation";
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

  const paidTrainingOrderId = params.order?.trim();
  const offeringSlug = params.offeringSlug?.trim() || params.offering?.trim();

  if (params.type === "in-person-appointment" && !offeringSlug && !paidTrainingOrderId) {
    redirect("/booking");
  }

  const normalizeType = (type?: string): BookingType | undefined => {
    if (type === "training-call" || type === "in-person-appointment") {
      return type as BookingType;
    }
    return undefined;
  };

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
    currency: offering.currency as "CAD",
  } : undefined;

  const activeOfferings = await loaders.getActiveBookingOfferings();

  return (
    <main className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container max-w-5xl mx-auto">
        <BookingFlow
          settings={settings}
          initialBookingType={initialBookingType}
          paidTrainingOrderId={paidTrainingOrderId}
          initialOfferingSlug={offeringSlug}
          offeringPayment={offeringPayment}
          offerings={activeOfferings}
        />
      </div>
    </main>
  );
}
