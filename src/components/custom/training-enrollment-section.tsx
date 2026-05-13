import Link from "next/link";
import type { TTrainingProgram } from "@/types";

interface TrainingEnrollmentSectionProps {
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

export function TrainingEnrollmentSection({ data }: TrainingEnrollmentSectionProps) {
  const {
    title,
    description,
    primaryCta,
  } = data;

  const hasEnrollmentData = primaryCta?.label && primaryCta.href;

  if (!hasEnrollmentData) return null;

  const isPrimarySafe = isSafeUrl(primaryCta?.href);
  
  let ctaHref = "/booking?type=training-call";
  let ctaLabel = "Book a Training Call";
  
  if (primaryCta && primaryCta.label && isPrimarySafe) {
    ctaHref = primaryCta.href!;
    ctaLabel = primaryCta.label;
  }

  return (
    <section className="py-24 md:py-32 bg-lh-white text-lh-shadow" id="enrollment">
      <div className="max-w-[1180px] mx-auto px-6 md:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 md:gap-16 items-start">
          
          <div className="flex flex-col gap-8 relative overflow-hidden rounded-[24px] p-8 md:p-12 min-h-[500px] justify-between">
            <div className="absolute inset-0 z-0 bg-lh-shadow">
              <div className="absolute inset-0 bg-gradient-to-br from-lh-shadow via-lh-accent to-lh-primary opacity-40 mix-blend-overlay" />
              <div className="absolute inset-0 bg-lh-shadow/60" />
            </div>
            
            <div className="relative z-10">
              <p className="font-sans text-xs font-semibold text-lh-light mb-2 tracking-[0.2em] uppercase">
                Secure Your Spot
              </p>
              <h2 className="font-serif text-4xl md:text-5xl uppercase text-lh-neutral-2">
                Complete Your Enrollment
              </h2>
            </div>
            
            <div className="relative z-10 space-y-6 mt-8">
              <p className="font-serif text-3xl text-lh-neutral-2">{title}</p>
            </div>
          </div>
          
          <div className="bg-lh-neutral-2/50 p-8 md:p-12 rounded-[24px] shadow-sm border border-lh-line/10 flex flex-col justify-center h-full min-h-[400px]">
            <div className="max-w-md mx-auto w-full text-center">
              <h3 className="font-serif text-4xl text-lh-shadow mb-6">Ready to begin?</h3>
              
              {description && (
                <p className="font-sans text-base text-lh-shadow/80 mb-8 leading-relaxed">
                  {description}
                </p>
              )}
              
              <Link
                href={ctaHref}
                className="block w-full py-5 bg-lh-primary text-lh-white rounded-full font-sans text-sm font-semibold uppercase tracking-[0.1em] hover:bg-lh-primary/90 transition-colors shadow-lg"
              >
                {ctaLabel}
              </Link>
              
              <p className="text-center text-xs text-lh-shadow/60 font-sans mt-6 uppercase tracking-wider">
                Secure your spot today. Spaces are limited.
              </p>
            </div>
          </div>
          
        </div>
      </div>
    </section>
  );
}
