import type { ReactElement } from "react";
import { loaders } from "@/data/loaders";
import Link from "next/link";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";

export const revalidate = 300;

export default async function ServicesPage(): Promise<ReactElement> {
  const services = await loaders.getServices();

  return (
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container">
        <div className="text-container max-w-3xl mx-auto mb-16">
          <h1 className="section-heading-red-center text-4xl md:text-5xl lg:text-6xl mb-6">
            Services
          </h1>
          <p className="section-description text-center text-lg">
            Discover our premium lash services.
          </p>
        </div>

        {services.length === 0 ? (
          <div className="text-center py-16 bg-lh-white rounded-2xl border border-lh-line">
            <p className="text-lh-muted max-w-md mx-auto">
              We are currently updating our services. Please check back later.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {services.map((service) => {
              const href = service.showDetailPage 
                ? `/services/${service.slug}` 
                : `/booking?offering=${service.slug}`;
              
              return (
                <article key={service._id} className="card-white flex flex-col h-full">
                  {service.image && (
                    <Link
                      href={href}
                      className="relative w-full aspect-square mb-4 overflow-hidden rounded-md bg-lh-neutral-2 block"
                    >
                      <SanityImage
                        image={service.image}
                        alt={service.title}
                        fill
                        className="object-cover"
                      />
                    </Link>
                  )}
                  <div className="flex-1 flex flex-col">
                    <div className="text-xs font-bold uppercase tracking-wider text-lh-primary mb-1">
                      Service
                    </div>
                    <h3 className="card-heading-red text-xl mb-2">
                      <Link href={href} className="hover:underline">
                        {service.title}
                      </Link>
                    </h3>
                    <p className="text-sm text-black font-light mb-4 flex-1">
                      {service.shortDescription || service.description}
                    </p>
                    
                    {service.availabilityLabel && service.isAvailable && (
                      <p className="text-xs font-bold text-lh-primary mb-2">
                        {service.availabilityLabel}
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-4 border-t border-lh-line">
                      <span className="font-bold text-lg text-black">
                        {service.fullPrice ? formatCad(service.fullPrice) : "View Details"}
                      </span>
                      <Link
                        href={href}
                        className="btn-primary-red w-auto px-6 text-center"
                      >
                        {service.showDetailPage ? "View Details" : "Book Now"}
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
