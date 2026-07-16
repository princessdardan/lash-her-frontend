import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import { loadPublicOperationalOfferings } from "@/lib/booking/operations/public-offerings";
import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const service = await loaders.getBookableServiceBySlug(slug);

  if (!service) {
    return { title: "Book Service" };
  }

  return {
    title: `Book ${service.title}`,
    description: `Book an appointment for ${service.title}`,
  };
}

export default async function ServiceBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const service = await loaders.getBookableServiceBySlug(slug);

  if (!service) {
    notFound();
  }

  const [settings, services, offerings] = await Promise.all([
    loaders.getBookingSettings(),
    loaders.getBookableServices(),
    loadPublicOperationalOfferings({
      sanityServiceId: service._id,
      servicePublicSlug: service.slug,
    }),
  ]);

  if (!settings) {
    notFound();
  }

  return (
    <section
      className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
      aria-label="Service booking"
    >
      <div className="content-container max-w-5xl mx-auto">
        <div className="mb-8">
          <Link
            href={`/services/${slug}`}
            className="text-lh-primary hover:underline font-medium flex items-center gap-2"
          >
            <span>←</span> Back to Service Details
          </Link>
        </div>

        <header className="mb-8 text-center">
          <span className="eyebrow-label mb-2 block">Book Appointment</span>
          <h1 className="section-heading mb-4">{service.title}</h1>
          {service.description && (
            <p className="text-black font-light text-lg max-w-2xl mx-auto">
              {service.description}
            </p>
          )}
          <p className="mt-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">
            Select your appointment time, add-ons, and service details before
            payment.
          </p>
        </header>

        <BookingFlow
          offerings={offerings}
          settings={settings}
          initialServiceSlug={service.slug}
          services={services}
        />
      </div>
    </section>
  );
}
