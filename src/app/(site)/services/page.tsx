import type { ReactElement } from "react";
import { loaders } from "@/data/loaders";
import Link from "next/link";
import { formatCad } from "@/lib/commerce/money";
import { Button } from "@/components/ui/button";
import { JsonLd, buildServiceCollectionJsonLd } from "@/lib/structured-data";

export const revalidate = 300;

export default async function ServicesPage(): Promise<ReactElement> {
  const [bookableServices, services] = await Promise.all([
    loaders.getBookableServices(),
    loaders.getServices(),
  ]);

  const detailServices = services.filter((s) => s.showDetailPage);
  const serviceCollectionJsonLd = buildServiceCollectionJsonLd(services);

  return (
    <>
      {serviceCollectionJsonLd && (
        <JsonLd
          id="lash-her-service-list-json-ld"
          data={serviceCollectionJsonLd}
        />
      )}
      <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
        <div className="content-container max-w-5xl mx-auto">
          <header className="text-container mb-12">
            <h1 className="section-heading text-4xl md:text-5xl lg:text-6xl mb-6 text-center">
              Services
            </h1>
            <p className="section-description text-center text-lg">
              Select a service to book your appointment.
            </p>
          </header>

          {bookableServices.length === 0 ? (
            <section className="text-center py-16 bg-lh-white rounded-2xl border border-lh-line">
              <p className="text-lh-muted max-w-md mx-auto">
                We are currently updating our services. Please check back later.
              </p>
            </section>
          ) : (
            <section className="max-w-3xl mx-auto">
              <div className="space-y-4">
                {bookableServices.map((service) => (
                  <article
                    key={service._id}
                    className="editorial-card p-6 flex justify-between items-center"
                  >
                    <div>
                      <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">
                        {service.title}
                      </h3>
                      <p className="text-sm text-lh-muted mb-2">
                        {service.durationMinutes} min
                      </p>
                      <p className="text-sm text-black font-light max-w-md">
                        {service.description}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-3">
                      <span className="font-medium text-black">
                        {formatCad(service.fullPrice)}
                      </span>
                      <Button asChild className="px-6 py-2 text-sm">
                        <Link href={`/services/${service.slug}/booking`}>
                          Book
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="outline"
                        className="px-6 py-2 text-sm"
                      >
                        <Link href={`/services/${service.slug}`}>
                          View details
                        </Link>
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>
    </>
  );
}
