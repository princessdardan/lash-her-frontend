import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { BookingFlow } from "@/components/booking/booking-flow";
import Link from "next/link";
import type { Metadata } from "next";

export const revalidate = 1800;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
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
  const [settings, service, services] = await Promise.all([
    loaders.getBookingSettings(),
    loaders.getBookableServiceBySlug(slug),
    loaders.getBookableServices(),
  ]);

  if (!settings || !service) {
    notFound();
  }

  const servicePayment = {
    depositAmount: service.depositAmount,
    fullPrice: service.fullPrice,
    currency: service.currency as "CAD",
  };

  return (
    <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24" aria-label="Service booking">
      <div className="content-container max-w-5xl mx-auto">
        <div className="mb-8">
          <Link href={`/services/${slug}`} className="text-lh-primary hover:underline font-medium flex items-center gap-2">
            <span>←</span> Back to Service Details
          </Link>
        </div>
        
        <div className="mb-8 text-center">
          <span className="eyebrow-label mb-2 block">
            Book Appointment
          </span>
          <h1 className="section-heading mb-4">
            {service.title}
          </h1>
          {service.description && (
            <p className="text-black font-light text-lg max-w-2xl mx-auto">
              {service.description}
            </p>
          )}
          <p className="mt-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">
            Select a time, confirm your details, then continue through secure Square checkout.
          </p>
        </div>

        <BookingFlow
          settings={settings}
          initialServiceSlug={service.slug}
          servicePayment={servicePayment}
          services={services}
        />
      </div>
    </section>
  );
}
