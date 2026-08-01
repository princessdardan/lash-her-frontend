import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookingFlow } from "@/components/booking/booking-flow";
import type { PublicBookingOffering } from "@/lib/booking/operations/offering";
import { loadPublicOperationalOfferings } from "@/lib/booking/operations/public-offerings";
import { loadOperationalBookingUiSettings } from "@/lib/private-db/booking-business-settings-repository";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ServiceBookingRouteProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ provider?: string | string[] }>;
}

export async function generateMetadata({
  params,
  searchParams,
}: ServiceBookingRouteProps): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const offerings =
    (await loadPublicOperationalOfferings({
      mode: "operational",
      servicePublicSlug: slug,
    })) ?? [];
  const selectedOffering = selectOffering(
    offerings,
    getRequestedProviderSlug(query.provider),
  );

  if (offerings.length === 0) {
    return { title: "Book Service" };
  }

  const title =
    selectedOffering?.publicTitle?.trim() ||
    selectedOffering?.serviceTitle ||
    offerings[0].serviceTitle;

  return {
    title: `Book ${title}`,
    description:
      selectedOffering?.publicSummary?.trim() ||
      (selectedOffering
        ? `Book ${title} with ${selectedOffering.provider.displayName}.`
        : `Choose a provider and book ${title}.`),
  };
}

export default async function ServiceBookingPage({
  params,
  searchParams,
}: ServiceBookingRouteProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const [settings, loadedOfferings] = await Promise.all([
    loadOperationalBookingUiSettings(),
    loadPublicOperationalOfferings({
      mode: "operational",
      servicePublicSlug: slug,
    }),
  ]);
  const offerings = loadedOfferings ?? [];

  if (offerings.length === 0) {
    notFound();
  }

  const requestedProviderSlug = getRequestedProviderSlug(query.provider);
  const selectedOffering = selectOffering(offerings, requestedProviderSlug);

  const title =
    selectedOffering?.publicTitle?.trim() ||
    selectedOffering?.serviceTitle ||
    offerings[0].serviceTitle;
  const summary = selectedOffering?.publicSummary?.trim();
  const selectedProviderSlug = selectedOffering?.provider.publicSlug;
  const providerQuery = selectedProviderSlug
    ? `?${new URLSearchParams({ provider: selectedProviderSlug }).toString()}`
    : "";
  const hasEditorialDetail = offerings.some(
    (offering) => offering.hasEditorialDetail === true,
  );
  const backHref = hasEditorialDetail
    ? `/services/${encodeURIComponent(slug)}${providerQuery}`
    : `/services${providerQuery}`;

  return (
    <section
      aria-label="Service booking"
      className="min-h-screen bg-lh-neutral-2 py-12 lg:py-24"
    >
      <div className="content-container mx-auto max-w-5xl">
        <div className="mb-8">
          <Link
            className="flex items-center gap-2 font-medium text-lh-primary hover:underline"
            href={backHref}
          >
            <span aria-hidden="true">←</span>
            {hasEditorialDetail
              ? "Back to Service Details"
              : "Back to Services"}
          </Link>
        </div>

        <header className="mb-8 text-center">
          <span className="eyebrow-label mb-2 block">Book Appointment</span>
          <h1 className="section-heading mb-4">{title}</h1>
          {summary ? (
            <p className="mx-auto max-w-2xl text-lg font-light text-black">
              {summary}
            </p>
          ) : null}
          <p className="mt-4 font-body text-sm font-bold uppercase tracking-[0.12em] text-lh-muted">
            Select your appointment time, then choose add-ons and enter your
            service details before payment.
          </p>
        </header>

        <BookingFlow
          initialProviderSlug={requestedProviderSlug}
          initialServiceSlug={slug}
          offerings={offerings}
          settings={settings}
        />
      </div>
    </section>
  );
}

function getRequestedProviderSlug(
  provider: string | string[] | undefined,
): string | undefined {
  return typeof provider === "string" && provider.trim()
    ? provider.trim()
    : undefined;
}

function selectOffering(
  offerings: readonly PublicBookingOffering[],
  providerSlug: string | undefined,
): PublicBookingOffering | undefined {
  const providerOffering = providerSlug
    ? offerings.find(
        (offering) => offering.provider.publicSlug === providerSlug,
      )
    : undefined;

  return (
    providerOffering ?? (offerings.length === 1 ? offerings[0] : undefined)
  );
}
