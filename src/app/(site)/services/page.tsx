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
            <section className="mx-auto max-w-4xl">
              <div className="space-y-3">
                {bookableServices.map((service) => (
                  <article
                    key={service._id}
                    className="editorial-card items-start gap-4 p-5 text-left md:p-6"
                  >
                    <div className="w-full">
                      <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">
                        {service.title}
                      </h3>
                      <p className="text-sm text-lh-muted mb-2">
                        {service.durationMinutes} min
                      </p>
                      <p className="max-w-3xl text-sm font-light leading-relaxed text-black">
                        {service.description}
                      </p>
                    </div>
                    <div className="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="font-medium text-black sm:shrink-0">
                        {formatCad(service.fullPrice)}
                      </span>
                      <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                        <Button
                          asChild
                          size="lg"
                          className="w-full rounded-full px-5 text-sm sm:min-w-28 sm:px-7"
                        >
                          <Link href={`/services/${service.slug}/booking`}>
                            Book
                          </Link>
                        </Button>
                        <Button
                          asChild
                          size="lg"
                          variant="outline"
                          className="w-full rounded-full px-5 text-sm sm:min-w-36 sm:px-7"
                        >
                          <Link href={`/services/${service.slug}`}>
                            View details
                          </Link>
                        </Button>
                      </div>
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
