import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { TrainingDetailItems } from "@/components/custom/training-detail-items";
import { TrainingEditorialHero } from "@/components/custom/training-editorial-hero";
import { getTrainingCta, isTrainingPurchasable } from "@/lib/training-checkout";
import { TrainingPurchaseCard, TrainingMobileTray } from "@/components/commerce/training-purchase-card";
import type { TLayoutBlock } from "@/types";

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

function isContactFormBlock(block: TLayoutBlock): block is Extract<TLayoutBlock, { _type: "contactFormLabels" }> {
  return block._type === "contactFormLabels";
}

export default async function TrainingProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  if (!data) notFound();

  const hasStructuredDetails = data.detailHeading || data.detailDescription || data.detailHeroImage || (data.detailItems && data.detailItems.length > 0) || (data.factList && data.factList.length > 0);
  const cta = getTrainingCta(data);
  const isCtaSafe = isSafeUrl(cta?.href);
  const isPurchasable = isTrainingPurchasable(data);
  const showPurchaseUi = isPurchasable && isCtaSafe;
  const contactBlocks = (data.blocks ?? []).filter(isContactFormBlock);

  return (
    <div className="relative flex flex-col min-h-screen">
      {showPurchaseUi && (
        <div className="hidden lg:block absolute top-0 bottom-0 right-[max(2rem,calc((100vw-1380px)/2+2rem))] w-[22rem] pointer-events-none z-40 lg:pt-24">
          <div className="sticky top-24 pointer-events-auto">
            <TrainingPurchaseCard program={data} cta={cta} />
          </div>
        </div>
      )}
      {hasStructuredDetails && (
        <section className="section-shell py-10 md:py-14 lg:py-16" data-structured-details="true">
          <div className="mx-auto w-full max-w-[1380px] px-4 sm:px-5 lg:px-4 xl:px-6">
            <div className={showPurchaseUi ? "grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-10" : ""}>
              <div className="min-w-0">
                <TrainingEditorialHero data={data} hasPurchaseUi={showPurchaseUi} />

                {data.detailItems && data.detailItems.length > 0 && (
                  <TrainingDetailItems items={data.detailItems} />
                )}

                {data.factList && data.factList.length > 0 && (
                  <div className="soft-panel mt-10 rounded-[28px] bg-lh-neutral/20 p-6 md:p-8 lg:p-10">
                    <ul className="fact-list grid grid-cols-1 gap-5 md:grid-cols-2 lg:gap-6">
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
                <div className="hidden lg:block w-full lg:w-[22rem] shrink-0"></div>
              )}
            </div>
          </div>
        </section>
      )}

      {!hasStructuredDetails && !showPurchaseUi && cta && cta.label && isCtaSafe && (
        <section className="section-shell py-12" data-training-commerce-cta="true">
          <div className="mx-auto w-full max-w-[1380px] px-4 sm:px-5 lg:px-4 xl:px-6">
            <div className="text-center">
              {renderTrainingCta(cta, "")}
            </div>
          </div>
        </section>
      )}

      {contactBlocks.length > 0 && (
        <section className="section-shell py-12 md:py-16" data-training-contact-blocks="true">
          <div className={`mx-auto w-full max-w-[1380px] px-4 sm:px-5 lg:px-4 xl:px-6 ${showPurchaseUi ? "lg:pr-[24rem] xl:pr-[26rem]" : ""}`}>
            <BlockRenderer blocks={contactBlocks} />
          </div>
        </section>
      )}

      {showPurchaseUi && (
        <TrainingMobileTray program={data} cta={cta} />
      )}
    </div>
  );
}
