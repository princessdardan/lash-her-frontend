import type { ReactElement } from "react";
import { loaders } from "@/data/loaders";
import Link from "next/link";
import { formatCad } from "@/lib/commerce/money";
import { Button } from "@/components/ui/button";

export const revalidate = 300;

export default async function ServicesPage(): Promise<ReactElement> {
  const [bookableServices, services] = await Promise.all([
    loaders.getBookableServices(),
    loaders.getServices(),
  ]);

  const detailServices = services.filter(s => s.showDetailPage);

  return (
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container max-w-5xl mx-auto">
        <div className="text-container mb-12">
          <h1 className="section-heading text-4xl md:text-5xl lg:text-6xl mb-6 text-center">
            Services
          </h1>
          <p className="section-description text-center text-lg">
            Select a service to book your appointment.
          </p>
        </div>

        {bookableServices.length === 0 ? (
          <div className="text-center py-16 bg-lh-white rounded-2xl border border-lh-line">
            <p className="text-lh-muted max-w-md mx-auto">
              We are currently updating our services. Please check back later.
            </p>
          </div>
        ) : (
          <div className="flex flex-col lg:flex-row gap-8">
            <div className="flex-1">
              <div className="flex gap-2 mb-6 overflow-x-auto pb-2" role="group" aria-label="Service filters">
                <span className="px-4 py-2 bg-lh-primary text-white rounded-full text-sm font-medium whitespace-nowrap">
                  All Services
                </span>
                <span className="px-4 py-2 bg-white border border-lh-line text-lh-muted rounded-full text-sm font-medium whitespace-nowrap">
                  Nataliea
                </span>
              </div>
              
              <div className="space-y-4">
                {bookableServices.map((service) => (
                  <div key={service._id} className="editorial-card p-6 flex justify-between items-center">
                    <div>
                      <h3 className="section-subheading mb-1 text-lg md:text-lg lg:text-lg">{service.title}</h3>
                      <p className="text-sm text-lh-muted mb-2">{service.durationMinutes} min</p>
                      <p className="text-sm text-black font-light max-w-md">{service.description}</p>
                    </div>
                    <div className="flex flex-col items-end gap-3">
                      <span className="font-medium text-black">{formatCad(service.fullPrice)}</span>
                      <Button asChild className="px-6 py-2 text-sm">
                        <Link href={`/services/${service.slug}/booking`}>
                          Book
                        </Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

            </div>
            
            <div className="w-full lg:w-80 shrink-0">
              <div className="soft-panel p-6 sticky top-24">
                <h2 className="section-subheading mb-2 text-xl md:text-xl lg:text-xl">Lash Her by Nataliea</h2>
                <div className="flex items-center gap-1 mb-4 text-sm text-black">
                  <span className="text-yellow-500" aria-hidden="true">★</span>
                  <span className="font-medium">5.0</span>
                  <span className="text-lh-muted">(100+ reviews)</span>
                </div>
                <Button asChild className="w-full mb-6">
                  <Link href={`/services/${bookableServices[0].slug}/booking`}>Book now</Link>
                </Button>
                <div className="pt-4 border-t border-lh-line">
                  <p className="font-medium text-black mb-1">Location</p>
                  <p className="text-sm text-lh-muted">Toronto, ON</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {detailServices.length > 0 && (
          <div className="mt-16">
            <h2 className="section-subheading mb-6">Learn More About Our Services</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {detailServices.map((service) => (
                <div key={service._id} className="soft-panel p-6 flex flex-col h-full">
                  <h3 className="section-subheading mb-2 text-lg md:text-lg lg:text-lg">{service.title}</h3>
                  <p className="text-sm text-black font-light mb-6 flex-1">
                    {service.shortDescription || service.description}
                  </p>
                  <Button asChild variant="outline" className="w-full">
                    <Link href={`/services/${service.slug}`}>
                      View details
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
