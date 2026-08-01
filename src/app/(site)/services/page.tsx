import type { ReactElement } from "react";

import { ProviderServiceTabs } from "@/components/services/provider-service-tabs";
import { loadPublicOperationalOfferings } from "@/lib/booking/operations/public-offerings";
import { buildPublicProviderServiceCatalog } from "@/lib/booking/operations/public-service-catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ServicesPage(): Promise<ReactElement> {
  const offerings = await loadPublicOperationalOfferings({
    mode: "operational",
  });
  const catalog = buildPublicProviderServiceCatalog(offerings ?? []);
  const initialProviderSlug = catalog.defaultProviderSlug;

  return (
    <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container mx-auto max-w-5xl">
        <header className="text-container mb-12">
          <h1 className="section-heading mb-6 text-center text-4xl md:text-5xl lg:text-6xl">
            Services
          </h1>
          <p className="section-description text-center text-lg">
            Select a provider, then choose a service to book your appointment.
          </p>
        </header>

        {initialProviderSlug === null ? (
          <section className="rounded-2xl border border-lh-line bg-lh-white py-16 text-center">
            <p className="mx-auto max-w-md text-lh-muted">
              We are currently updating our services. Please check back later.
            </p>
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
