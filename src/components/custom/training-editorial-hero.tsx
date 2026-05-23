import Link from "next/link";
import { SanityImage } from "@/components/ui/sanity-image";
import { cn } from "@/lib/utils";
import type { TTrainingProgram } from "@/types";

interface TrainingEditorialHeroProps {
  readonly data: TTrainingProgram;
  readonly hasPurchaseUi?: boolean;
}

function getHeroImage(data: TTrainingProgram) {
  return data.heroImage ?? data.seo?.image;
}

function isSafeUrl(url: string | undefined | null): boolean {
  if (!url) return false;

  try {
    if (url.startsWith("https://")) {
      new URL(url);
      return true;
    }

    return url.startsWith("/") && !url.startsWith("//");
  } catch {
    return false;
  }
}

function getSafeCta(cta: TTrainingProgram["primaryCta"] | TTrainingProgram["secondaryCta"]) {
  if (!cta?.label || !isSafeUrl(cta.href)) return null;

  return cta;
}

export function TrainingEditorialHero({ data, hasPurchaseUi = false }: TrainingEditorialHeroProps) {
  const heroImage = getHeroImage(data);
  const primaryCta = getSafeCta(data.primaryCta);
  const secondaryCta = getSafeCta(data.secondaryCta);
  const hasCtas = Boolean(primaryCta || secondaryCta);
  const badges = data.heroBadges?.filter(Boolean) ?? [];

  return (
    <section
      className={cn(
        "relative isolate overflow-hidden bg-lh-shadow text-lh-neutral-2",
        hasPurchaseUi ? "min-h-[620px] lg:min-h-[720px]" : "min-h-[620px] lg:min-h-[760px]",
      )}
      data-training-detail-hero="true"
    >
      <div className="absolute inset-0 z-0">
        {heroImage ? (
          <SanityImage
            image={heroImage}
            alt={heroImage.alt || data.title}
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_22%,var(--lh-light-soft),transparent_32%),linear-gradient(135deg,var(--lh-shadow),var(--lh-accent)_52%,var(--lh-primary))]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow/55 via-lh-accent/55 to-lh-primary/45 mix-blend-multiply" />
        <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/78 to-lh-shadow/10" />
        <div className="absolute -right-32 bottom-[-9rem] h-[28rem] w-[28rem] rounded-full border border-lh-light/35" aria-hidden="true" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[inherit] w-full max-w-[1380px] items-end px-6 py-14 sm:px-8 md:py-18 lg:px-10 lg:py-20 xl:px-12">
        <div className={cn("max-w-5xl", hasPurchaseUi && "lg:max-w-[calc(100%-25rem)]")}>
          <p className="eyebrow-label mb-4 text-lh-light">Training Program</p>
          {data.heroSubtitle && (
            <p className="mb-5 max-w-2xl font-body text-sm font-bold uppercase tracking-[0.16em] text-lh-neutral-2/78">
              {data.heroSubtitle}
            </p>
          )}
          <h1 className="display-heading text-lh-neutral-2 text-balance">
            {data.title}
          </h1>

          {data.description && (
            <p className="mt-6 max-w-3xl font-body text-base font-bold leading-8 text-lh-neutral-2/85 md:text-lg lg:text-xl">
              {data.description}
            </p>
          )}

          {badges.length > 0 && (
            <ul className="mt-9 flex flex-wrap gap-3" aria-label="Training highlights">
              {badges.map((badge) => (
                <li
                  key={badge}
                  className="rounded-full border border-lh-light/40 px-4 py-2 font-body text-xs font-bold uppercase tracking-[0.14em] text-lh-light"
                >
                  {badge}
                </li>
              ))}
            </ul>
          )}

          {hasCtas && (
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {primaryCta && (
                <Link
                  href={primaryCta.href}
                  className="primary-cta inline-flex items-center justify-center rounded-full bg-lh-light px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-shadow transition-colors hover:bg-lh-light/90"
                  target={primaryCta.href.startsWith("https://") ? "_blank" : undefined}
                  rel={primaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                >
                  {primaryCta.label}
                </Link>
              )}
              {secondaryCta && (
                <Link
                  href={secondaryCta.href}
                  className="inline-flex items-center justify-center rounded-full border border-lh-neutral-2/40 px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-neutral-2 transition-colors hover:bg-lh-neutral-2/10"
                  target={secondaryCta.href.startsWith("https://") ? "_blank" : undefined}
                  rel={secondaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                >
                  {secondaryCta.label}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
