import Link from "next/link";
import { SanityImage } from "@/components/ui/sanity-image";
import { formatCad } from "@/lib/commerce/money";
import type { TTrainingProgram } from "@/types";

interface TrainingEnrollmentSectionProps {
  readonly data: TTrainingProgram;
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

function getFinitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function TrainingEnrollmentSection({ data }: TrainingEnrollmentSectionProps) {
  const {
    title,
    enrollmentTitle,
    enrollmentDescription,
    enrollmentBackgroundImage,
    factList,
    primaryCta,
    secondaryCta,
  } = data;

  const inclusions = factList?.filter(Boolean) ?? [];
  const price = getFinitePrice(data.price);
  const availabilityLabel = data.availabilityLabel;
  const isAvailable = data.isAvailable;
  const safePrimaryCta = primaryCta?.label && isSafeUrl(primaryCta.href) ? primaryCta : null;
  const safeSecondaryCta = secondaryCta?.label && isSafeUrl(secondaryCta.href) ? secondaryCta : null;
  const hasEnrollmentData = enrollmentTitle || enrollmentDescription || enrollmentBackgroundImage || inclusions.length > 0 || price !== null || availabilityLabel || isAvailable !== undefined || safePrimaryCta || safeSecondaryCta;

  if (!hasEnrollmentData) return null;

  return (
    <section className="py-8 md:py-12 lg:py-16" id="enrollment" data-training-enrollment-section="true">
      <div className="grid grid-cols-1 overflow-hidden rounded-[28px] border border-lh-line bg-lh-white shadow-[0_24px_70px_rgba(28,19,24,0.08)] lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="relative min-h-[360px] overflow-hidden bg-lh-shadow p-8 text-lh-neutral-2 md:p-10 lg:min-h-[520px] lg:p-12">
          <div className="absolute inset-0 z-0">
            {enrollmentBackgroundImage ? (
              <SanityImage
                image={enrollmentBackgroundImage}
                alt={enrollmentBackgroundImage.alt || enrollmentTitle || title}
                fill
                sizes="(min-width: 1024px) 42vw, 100vw"
                className="object-cover"
              />
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_16%,var(--lh-light-soft),transparent_30%),linear-gradient(145deg,var(--lh-shadow),var(--lh-accent)_54%,var(--lh-primary))]" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-lh-shadow via-lh-shadow/72 to-lh-shadow/20" />
          </div>

          <div className="relative z-10 flex h-full min-h-[inherit] flex-col justify-between">
            <div>
              <p className="eyebrow-label mb-4 text-lh-light">Enrollment</p>
              <h2 className="section-heading text-lh-neutral-2 text-balance">
                {enrollmentTitle || "Reserve Your Training Place"}
              </h2>
            </div>

            <div className="mt-10 border-t border-lh-neutral-2/20 pt-6">
              <p className="font-body text-sm font-bold uppercase tracking-[0.16em] text-lh-neutral-2/70">Program</p>
              <p className="mt-2 font-heading text-3xl font-normal leading-none text-lh-neutral-2 md:text-4xl">{title}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-center p-8 md:p-10 lg:p-12">
          {enrollmentDescription && (
            <p className="body-lead text-lh-shadow">
              {enrollmentDescription}
            </p>
          )}

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {price !== null && (
              <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
                <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">Investment</p>
                <p className="mt-2 font-body text-2xl font-bold text-lh-primary">{formatCad(price)}</p>
              </div>
            )}

            {(availabilityLabel || isAvailable !== undefined) && (
              <div className="rounded-[24px] border border-lh-line bg-lh-neutral-2/70 p-5">
                <p className="font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-muted">Availability</p>
                <p className="mt-2 font-body text-lg font-bold text-lh-shadow">
                  {availabilityLabel || (isAvailable ? "Enrollment available" : "Enrollment paused")}
                </p>
              </div>
            )}
          </div>

          {inclusions.length > 0 && (
            <div className="mt-8">
              <p className="mb-4 font-heading text-xs font-normal uppercase tracking-[0.28em] text-lh-primary">Included</p>
              <ul className="grid grid-cols-1 gap-3 text-lh-shadow/82 md:grid-cols-2">
                {inclusions.map((item) => (
                  <li key={item} className="flex items-start gap-3 font-body text-sm font-bold leading-7 md:text-base">
                    <span className="mt-3 h-px w-7 shrink-0 bg-lh-light" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(safePrimaryCta || safeSecondaryCta) && (
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {safePrimaryCta && (
                <Link
                  href={safePrimaryCta.href}
                  className="primary-cta inline-flex items-center justify-center rounded-full bg-lh-primary px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-white transition-colors hover:bg-lh-primary/90"
                  target={safePrimaryCta.href.startsWith("https://") ? "_blank" : undefined}
                  rel={safePrimaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                >
                  {safePrimaryCta.label}
                </Link>
              )}
              {safeSecondaryCta && (
                <Link
                  href={safeSecondaryCta.href}
                  className="inline-flex items-center justify-center rounded-full border border-lh-line px-7 py-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-shadow transition-colors hover:bg-lh-neutral"
                  target={safeSecondaryCta.href.startsWith("https://") ? "_blank" : undefined}
                  rel={safeSecondaryCta.href.startsWith("https://") ? "noopener noreferrer" : undefined}
                >
                  {safeSecondaryCta.label}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
