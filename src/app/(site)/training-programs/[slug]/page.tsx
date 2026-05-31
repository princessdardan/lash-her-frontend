import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { loaders } from "@/data/loaders";
import { BlockRenderer } from "@/components/custom/layouts/block-renderer";
import { TrainingEditorialHero } from "@/components/custom/training-editorial-hero";
import { TrainingEditorialDetails } from "@/components/custom/training-editorial-details";
import { TrainingEnrollmentToggle } from "@/components/custom/training-enrollment-toggle";
import { getTrainingCta, isTrainingPurchasable } from "@/lib/training-checkout";
import { TrainingPurchaseCard, TrainingMobileTray } from "@/components/commerce/training-purchase-card";
import { JsonLd, buildTrainingProgramJsonLd } from "@/lib/structured-data";
import type { TLayoutBlock } from "@/types";

export const revalidate = 1800;

function isSafeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    if (url.startsWith('#')) return true;
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

function isLegacyContentBlock(block: TLayoutBlock): boolean {
  return !isContactFormBlock(block);
}

export default async function TrainingProgramPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loaders.getTrainingProgramBySlug(slug);

  if (!data) notFound();

  const hasStructuredDetails = Boolean(
    data.heroSubtitle ||
      data.heroImage ||
      (data.heroBadges && data.heroBadges.length > 0) ||
      data.detailHeading ||
      data.detailEyebrow ||
      data.detailDescription ||
      (data.detailItems && data.detailItems.length > 0) ||
      (data.factList && data.factList.length > 0) ||
      data.enrollmentTitle ||
      data.enrollmentDescription ||
      data.enrollmentBackgroundImage ||
      data.price !== undefined ||
      data.availabilityLabel ||
      data.isAvailable !== undefined,
  );
  const cta = getTrainingCta(data);
  const isCtaSafe = isSafeUrl(cta?.href);
  const isPurchasable = isTrainingPurchasable(data);
  const showPurchaseUi = isPurchasable && isCtaSafe;
  const legacyBlocks = (data.blocks ?? []).filter(isLegacyContentBlock);

  return (
    <section className="relative flex flex-col min-h-screen">
      <JsonLd id="lash-her-training-program-json-ld" data={buildTrainingProgramJsonLd(data)} />
      {showPurchaseUi && (
        <div className="hidden lg:block absolute top-0 bottom-0 right-[max(2rem,calc((100vw-1380px)/2+2rem))] w-[22rem] pointer-events-none z-40 lg:pt-40">
          <div className="sticky top-40 pointer-events-auto">
            <TrainingPurchaseCard program={data} cta={cta} />
          </div>
        </div>
      )}
      {hasStructuredDetails && (
        <section className="bg-lh-neutral-2" data-structured-details="true">
          <TrainingEditorialHero data={data} hasPurchaseUi={showPurchaseUi} />

          <div className="mx-auto w-full max-w-[1380px] px-4 py-10 sm:px-5 md:py-14 lg:px-4 lg:py-16 xl:px-6">
            <div className={showPurchaseUi ? "grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:gap-10" : ""}>
              <div className="min-w-0">
                <TrainingEditorialDetails data={data} />
                <TrainingEnrollmentToggle
                  data={data}
                  contactData={data.trainingContact}
                  programSlug={data.slug}
                  programTitle={data.title}
                  hasPurchaseUi={showPurchaseUi}
                />

                {legacyBlocks.length > 0 && (
                  <div className="mt-8" data-training-legacy-blocks="true">
                    <BlockRenderer blocks={legacyBlocks} />
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

      {!hasStructuredDetails && legacyBlocks.length > 0 && (
        <section className="section-shell py-12 md:py-16" data-training-legacy-blocks="true">
          <div className="mx-auto w-full max-w-[1380px] px-4 sm:px-5 lg:px-4 xl:px-6">
            <BlockRenderer blocks={legacyBlocks} />
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

      {showPurchaseUi && (
        <TrainingMobileTray program={data} cta={cta} />
      )}
    </section>
  );
}
