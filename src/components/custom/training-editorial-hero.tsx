import Link from "next/link";
import { SanityImage } from "@/components/ui/sanity-image";
import type { TTrainingProgram } from "@/types";

interface TrainingEditorialHeroProps {
  data: TTrainingProgram;
}

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

export function TrainingEditorialHero({ data }: TrainingEditorialHeroProps) {
  const {
    title,
    description,
    heroSubtitle,
    heroImage,
    heroBadges,
    primaryCta,
    secondaryCta,
  } = data;

  const isPrimarySafe = isSafeUrl(primaryCta?.href);
  const isSecondarySafe = isSafeUrl(secondaryCta?.href);

  return (
    <section className="relative min-h-[80vh] md:min-h-[921px] flex items-end pb-16 md:pb-32 pt-32">
      <div className="absolute inset-0 z-0 bg-lh-shadow">
        {heroImage ? (
          <SanityImage
            image={heroImage}
            alt={heroImage.alt || title}
            fill
            priority
            className="object-cover opacity-60 mix-blend-overlay"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow via-lh-accent to-lh-primary opacity-60 mix-blend-overlay" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/80 to-transparent" />
      </div>

      <div className="relative z-10 w-full max-w-[1180px] mx-auto px-6 md:px-8">
        <div className="max-w-3xl">
          {heroSubtitle && (
            <p className="font-sans text-xs md:text-sm font-semibold text-lh-light mb-6 tracking-[0.2em] uppercase flex items-center gap-4">
              <span className="w-12 h-[1px] bg-lh-light"></span> {heroSubtitle}
            </p>
          )}
          
          <h1 className="font-serif text-6xl md:text-8xl lg:text-[120px] text-lh-neutral-2 mb-6 text-balance leading-[0.9]">
            {title}
          </h1>
          
          {description && (
            <p className="font-sans text-lg md:text-xl text-lh-neutral-2/90 max-w-2xl mb-8 leading-relaxed">
              {description}
            </p>
          )}

          {heroBadges && heroBadges.length > 0 && (
            <div className="flex flex-wrap gap-4 mb-12">
              {heroBadges.map((badge, index) => (
                <span 
                  key={index}
                  className="px-4 py-2 rounded-full bg-lh-neutral-2/10 backdrop-blur-md border border-lh-neutral-2/20 text-lh-neutral-2 font-sans text-xs font-semibold uppercase tracking-wider"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            {primaryCta && primaryCta.label && isPrimarySafe && (
              <Link
                href={primaryCta.href!}
                className="px-8 py-4 bg-lh-primary text-lh-white rounded-full font-sans text-sm font-semibold uppercase tracking-[0.1em] hover:bg-lh-primary/90 transition-colors"
              >
                {primaryCta.label}
              </Link>
            )}
            {secondaryCta && secondaryCta.label && isSecondarySafe && (
              <Link
                href={secondaryCta.href!}
                className="px-8 py-4 border border-lh-light text-lh-light rounded-full font-sans text-sm font-semibold uppercase tracking-[0.1em] hover:bg-lh-light hover:text-lh-shadow transition-colors"
              >
                {secondaryCta.label}
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
