import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loaders } from "@/data/loaders";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import { JsonLd, buildServiceJsonLd } from "@/lib/structured-data";
import Link from "next/link";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getServiceBySlug(slug);

  const title = data?.seo?.title || data?.title || "Service";
  const description = data?.seo?.description || data?.shortDescription || data?.description || "Premium lash service";

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export async function generateStaticParams() {
  const services = await loaders.getAllServiceSlugs();
  return services.map(s => ({ slug: s.slug }));
}

export default async function ServiceDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const service = await loaders.getServiceBySlug(slug);

  if (!service || !service.showDetailPage) notFound();

  return (
    <div className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24">
      <JsonLd id="lash-her-service-json-ld" data={buildServiceJsonLd(service)} />
      <div className="content-container">
        <div className="mb-8 pt-8">
          <Link href="/services" className="text-lh-primary hover:underline font-medium flex items-center gap-2">
            <span>←</span> Back to Services
          </Link>
        </div>

        <div className="mx-auto flex max-w-5xl flex-col gap-8 rounded-[28px] border border-lh-line bg-lh-white p-8 text-lh-shadow shadow-[0_24px_70px_rgba(28,19,24,0.08)] md:flex-row md:gap-12 md:p-12">
          <div className="w-full md:w-1/2 flex flex-col gap-4">
            {service.image ? (
              <div className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/10">
                <SanityImage
                  image={service.image}
                  alt={service.title}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/20 flex items-center justify-center">
                <span className="text-lh-muted font-medium">No image available</span>
              </div>
            )}

            {service.gallery && service.gallery.length > 0 && (
              <div className="grid grid-cols-4 gap-4 mt-4">
                {service.gallery.map((img, idx) => (
                  <div key={idx} className="aspect-square relative rounded-md overflow-hidden bg-lh-primary-soft/10">
                    <SanityImage
                      image={img}
                      alt={img.alt || `${service.title} gallery image ${idx + 1}`}
                      fill
                      className="object-cover"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="w-full md:w-1/2 flex flex-col">
            <span className="eyebrow-label mb-2 block">
              Service
            </span>
            <h1 className="section-heading mb-4">
              {service.title}
            </h1>
            
            <div className="text-2xl font-medium text-lh-muted mb-6">
              {formatCad(service.fullPrice)}
            </div>
            
            {service.description && (
              <div className="mb-8 space-y-4 font-body text-lg font-bold leading-8 text-lh-shadow/80">
                <p>{service.description}</p>
              </div>
            )}

            {service.detailSections && service.detailSections.length > 0 && (
              <div className="mb-8 space-y-6">
                {service.detailSections.map((section, idx) => (
                  <div key={section._key || idx}>
                    <h3 className="section-subheading mb-2">{section.heading}</h3>
                    <p className="font-body font-bold leading-7 text-lh-shadow/80">{section.content}</p>
                  </div>
                ))}
              </div>
            )}
            
            <div className="mt-auto pt-6 border-t border-lh-line/30">
              {!service.isAvailable ? (
                <div className="text-lh-primary font-medium py-3 text-center border border-lh-primary rounded-md">
                  Currently Unavailable
                </div>
              ) : (
                <Link href={`/services/${service.slug}/booking`} className="inline-flex w-full items-center justify-center rounded-full bg-lh-primary px-7 py-4 text-center font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-accent">
                  Book Now
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
