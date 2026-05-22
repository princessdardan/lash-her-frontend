import { unstable_noStore as noStore } from "next/cache";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import { findPendingTrainingEnrollmentByToken, getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId, issueTrainingSchedulingTokenForPaidOrderIfMissing } from "@/lib/commerce/training-enrollment-store";
import { resolveBookingShim } from "./booking-shim";

export const revalidate = 1800;

export default async function BookingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolution = await resolveBookingShim(await searchParams, {
    findPendingTrainingEnrollmentByToken,
    getBookingOfferingBySlug: async (slug) => loaders.getBookingOfferingBySlug(slug),
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId,
    issueTrainingSchedulingTokenForPaidOrderIfMissing,
  });

  if (resolution.kind === "notFound") {
    notFound();
  }

  if (resolution.kind === "redirect") {
    if (resolution.redirectMode === "permanent") {
      permanentRedirect(resolution.href);
    } else {
      noStore();
      redirect(resolution.href);
    }
  }

  const settings = await loaders.getBookingSettings();

  if (!settings) {
    notFound();
  }

  const activeOfferings = await loaders.getActiveBookingOfferings();

  return (
    <main className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container max-w-5xl mx-auto">
        <BookingFlow
          settings={settings}
          initialBookingType={resolution.initialBookingType}
          offerings={activeOfferings}
        />
      </div>
    </main>
  );
}
