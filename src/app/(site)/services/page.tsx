import type { ReactElement } from "react";

import { ProviderServiceTabs } from "@/components/services/provider-service-tabs";
import { loadPublicServiceCatalogOfferings } from "@/lib/private-db/public-service-catalog-repository";
import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";
import { buildPublicProviderServiceCatalog } from "@/lib/booking/operations/public-service-catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ServicesPage(): Promise<ReactElement> {
  const offerings = await loadPublicServiceCatalogOfferings();
  const catalog = buildPublicProviderServiceCatalog(offerings);
  const initialProviderSlug = catalog.defaultProviderSlug;

  return (
    <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container mx-auto max-w-5xl">
        <header className="text-container mb-12">
          <h1 className="section-heading mb-6 text-center text-4xl md:text-5xl lg:text-6xl">
            Services
          </h1>
          <p className="section-description text-center text-lg">
            Explore our providers and services. Appointment availability and
            final booking details are confirmed on Fresha. Existing bookings
            remain valid.
          </p>
        </header>

        {initialProviderSlug === null ? (
          <section className="rounded-2xl border border-lh-line bg-lh-white py-16 text-center">
            <p className="mx-auto max-w-md text-lh-muted">
              We are currently updating our services. Please check back later.
            </p>
            <a
              href={FRESHA_BOOKING_URL}
              className="mt-6 inline-flex text-lh-primary underline"
            >
              Book on Fresha
            </a>
          </section>
        ) : (
          <section className="mx-auto max-w-4xl">
            <ProviderServiceTabs
              catalog={catalog}
              initialProviderSlug={initialProviderSlug}
            />
          </section>
        )}
      </div>
    </section>
  );
}
