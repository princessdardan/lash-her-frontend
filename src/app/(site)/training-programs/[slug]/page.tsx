import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { TrainingDetailItems } from "@/components/custom/training-detail-items";
import { getTrainingCta, isTrainingPurchasable } from "@/lib/training-checkout";
import { TrainingPurchaseCard } from "@/components/commerce/training-purchase-card";

export const revalidate = 1800;

function isSafeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    if (url.startsWith('https://')) {
      new URL(url);
      return true;
    }
    if (url.startsWith('/') && !url.startsWith('//')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  const title = data?.seo?.title || data?.title || "Training";
  const description = data?.seo?.description || data?.description || "Professional lash training programs";

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export async function generateStaticParams() {
  const programs = await loaders.getAllTrainingProgramSlugs();
  return programs.map(p => ({ slug: p.slug }));
}

function renderTrainingCta(cta: { label: string; href: string }, className = "mt-16 text-center") {
  return (
    <div className={className}>
      <Link
        href={cta.href}
        className="primary-cta inline-block bg-lh-shadow text-lh-neutral-2 px-8 py-4 rounded-full font-medium hover:bg-lh-shadow/90 transition-colors"
      >
        {cta.label}
      </Link>
    </div>
  );
}

export default async function TrainingProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  if (!data) notFound();

  const hasStructuredDetails = data.detailHeading || data.detailDescription || (data.detailItems && data.detailItems.length > 0) || (data.factList && data.factList.length > 0);
  const cta = getTrainingCta(data);
  const isCtaSafe = isSafeUrl(cta?.href);
  const isPurchasable = isTrainingPurchasable(data);
  const showPurchaseUi = isPurchasable && isCtaSafe;

  return (
    <div className={`flex flex-col min-h-screen ${showPurchaseUi ? "pb-24 lg:pb-0" : ""}`}>
      {data.blocks && data.blocks.length > 0 && (
        <BlockRenderer blocks={data.blocks} />
      )}

      {hasStructuredDetails && (
        <section className="section-shell py-16 md:py-24" data-structured-details="true">
          <div className="content-container">
            <div className={showPurchaseUi ? "flex flex-col lg:flex-row gap-12 relative items-start" : ""}>
              <div className={showPurchaseUi ? "flex-1 w-full" : ""}>
                <div className={`max-w-3xl mb-12 ${!showPurchaseUi ? "mx-auto text-center" : ""}`}>
                  {data.detailHeading && (
                    <h2 className="section-heading mb-6">{data.detailHeading}</h2>
                  )}
                  {data.detailDescription && (
                    <p className="body-lead">{data.detailDescription}</p>
                  )}
                </div>

                {data.detailItems && data.detailItems.length > 0 && (
                  <TrainingDetailItems items={data.detailItems} />
                )}

                {data.factList && data.factList.length > 0 && (
                  <div className="soft-panel mt-12 p-8 md:p-12 rounded-2xl bg-lh-neutral/20">
                    <ul className="fact-list grid grid-cols-1 md:grid-cols-2 gap-6">
                      {data.factList.map((fact, index) => (
                        <li key={index} className="flex items-start gap-3">
                          <span className="text-lh-shadow mt-1">•</span>
                          <span className="text-lg">{fact}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!showPurchaseUi && cta && cta.label && isCtaSafe && renderTrainingCta(cta)}
              </div>

              {showPurchaseUi && (
                <div className="w-full lg:w-96 shrink-0">
                  <TrainingPurchaseCard program={data} cta={cta} />
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {!hasStructuredDetails && cta && cta.label && isCtaSafe && (
        <section className="section-shell py-12" data-training-commerce-cta="true">
          <div className="content-container">
            {!showPurchaseUi ? (
              <div className="text-center">
                {renderTrainingCta(cta, "")}
              </div>
            ) : (
              <div className="flex justify-center">
                <div className="w-full max-w-md">
                  <TrainingPurchaseCard program={data} cta={cta} />
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
