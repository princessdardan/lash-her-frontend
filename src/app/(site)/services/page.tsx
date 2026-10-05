import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { loaders } from "@/data/loaders";
import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Services",
  description:
    "Explore Lash Her services. View current prices, availability, and book on Fresha.",
};

export default async function ServicesPage() {
  const settings = await loaders.getServicesPageData();

  if (settings?.redirectToFresha === true) {
    redirect(FRESHA_BOOKING_URL);
  }

  const services = await loaders.getServiceListings();

  return (
    <section className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <div className="content-container mx-auto max-w-5xl">
        <header className="text-container mb-12 text-center">
          <h1 className="section-heading mb-6 text-4xl md:text-5xl lg:text-6xl">
            Services
          </h1>
          <p className="section-description text-lg">
            Explore our services below. Visit Fresha for current prices,
            treatment options, and appointment availability.
          </p>
          <a
            href={FRESHA_BOOKING_URL}
            className="mt-6 inline-flex rounded-full bg-lh-primary px-7 py-3 font-body text-sm font-bold text-lh-white transition-colors hover:bg-lh-accent"
          >
            View services &amp; book on Fresha
          </a>
        </header>

        {services.length === 0 ? (
          <p className="mx-auto max-w-lg py-12 text-center text-lh-muted">
            Our full service menu is available on Fresha. Explore the menu and
            book your appointment using the link above.
          </p>
        ) : (
          <ul className="mx-auto max-w-4xl divide-y divide-lh-line border-y border-lh-line">
            {services.map((service) => {
              const description =
                service.shortDescription?.trim() || service.description?.trim();
              const hasDetails = Boolean(
                service.description?.trim() ||
                  service.image ||
                  service.gallery?.length ||
                  service.detailSections?.length,
              );

              return (
                <li key={service._id} className="py-8 md:py-10">
                  <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-10">
                    <div className="max-w-2xl">
                      <h2 className="section-subheading mb-3">
                        {service.title}
                      </h2>
                      {description && (
                        <p className="font-body leading-7 text-lh-muted">
                          {description}
                        </p>
                      )}
                      {hasDetails && (
                        <Link
                          href={`/services/${service.slug}`}
                          aria-label={`Learn more about ${service.title}`}
                          className="mt-4 inline-flex text-sm text-lh-primary underline underline-offset-4"
                        >
                          Learn more
                        </Link>
                      )}
                    </div>
                    <a
                      href={FRESHA_BOOKING_URL}
                      aria-label={`Book ${service.title} on Fresha`}
                      className="shrink-0 font-body text-sm font-bold text-lh-primary underline underline-offset-4"
                    >
                      Book on Fresha
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
