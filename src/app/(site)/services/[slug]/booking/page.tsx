import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import Link from "next/link";
import type { Metadata } from "next";

export const revalidate = 1800;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const offering = await loaders.getBookingOfferingBySlug(slug);

  if (!offering) {
    return { title: "Book Service" };
  }

  return {
    title: `Book ${offering.title}`,
    description: `Book an appointment for ${offering.title}`,
  };
}

export default async function ServiceBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const settings = await loaders.getBookingSettings();
  const offering = await loaders.getBookingOfferingBySlug(slug);

  if (!settings || !offering) {
    notFound();
  }

  const offeringPayment = {
    depositAmount: offering.depositAmount,
    fullPrice: offering.fullPrice,
    currency: offering.currency as "CAD",
  };

  const activeOfferings = await loaders.getActiveBookingOfferings();

  return (
    <main className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container max-w-5xl mx-auto">
        <div className="mb-8">
          <Link href={`/services/${slug}`} className="text-lh-primary hover:underline font-medium flex items-center gap-2">
            <span>←</span> Back to Service Details
          </Link>
        </div>
        
        <div className="mb-8 text-center">
          <span className="text-sm font-bold text-lh-primary uppercase tracking-wider mb-2 block">
            Book Appointment
          </span>
          <h1 className="card-heading-red text-3xl md:text-4xl mb-4">
            {offering.title}
          </h1>
          {offering.description && (
            <p className="text-black font-light text-lg max-w-2xl mx-auto">
              {offering.description}
            </p>
          )}
        </div>

        <BookingFlow
          settings={settings}
          initialBookingType={offering.bookingType}
          initialOfferingSlug={slug}
          offeringPayment={offeringPayment}
          offerings={activeOfferings}
        />
      </div>
    </main>
  );
}
