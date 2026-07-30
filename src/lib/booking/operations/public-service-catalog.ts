import type { PublicBookingOffering } from "./offering";

export interface PublicProviderServiceCatalogItem {
  bookingHref: string;
  depositAmountCents: number;
  detailHref?: string;
  displayOrder: number;
  durationMinutes: number;
  fullPriceCents: number;
  offeringId: string;
  serviceSlug: string;
  summary: string;
  title: string;
}

export interface PublicProviderServiceCatalogGroup {
  displayName: string;
  providerKey: string;
  providerSlug: string;
  services: PublicProviderServiceCatalogItem[];
}

export interface PublicProviderServiceCatalog {
  defaultProviderSlug: string | null;
  providers: PublicProviderServiceCatalogGroup[];
}

type CatalogOffering = PublicBookingOffering & {
  displayOrder?: number;
  hasEditorialDetail?: boolean;
  provider: PublicBookingOffering["provider"] & {
    providerKey?: string;
  };
  publicSummary?: string;
  publicTitle?: string;
};

const providerCollator = new Intl.Collator("en-CA", {
  sensitivity: "base",
  usage: "sort",
});
const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function buildPublicProviderServiceCatalog(
  offerings: readonly CatalogOffering[],
): PublicProviderServiceCatalog {
  const groups = new Map<string, PublicProviderServiceCatalogGroup>();

  for (const offering of offerings) {
    const providerSlug = offering.provider.publicSlug?.trim();
    const serviceSlug = offering.serviceSlug.trim();
    const displayName = offering.provider.displayName.trim();

    if (
      !providerSlug ||
      !PUBLIC_SLUG_PATTERN.test(providerSlug) ||
      !PUBLIC_SLUG_PATTERN.test(serviceSlug) ||
      !displayName
    ) {
      continue;
    }

    const providerKey = offering.provider.providerKey?.trim() || providerSlug;
    const group = groups.get(providerSlug) ?? {
      displayName,
      providerKey,
      providerSlug,
      services: [],
    };
    const providerQuery = new URLSearchParams({ provider: providerSlug });

    group.services.push({
      bookingHref: `/services/${encodeURIComponent(serviceSlug)}/booking?${providerQuery.toString()}`,
      depositAmountCents: offering.depositAmountCents,
      ...(offering.hasEditorialDetail
        ? {
            detailHref: `/services/${encodeURIComponent(serviceSlug)}?${providerQuery.toString()}`,
          }
        : {}),
      displayOrder:
        typeof offering.displayOrder === "number"
          ? offering.displayOrder
          : Number.MAX_SAFE_INTEGER,
      durationMinutes: offering.durationMinutes,
      fullPriceCents: offering.fullPriceCents,
      offeringId: offering.id,
      serviceSlug,
      summary: offering.publicSummary?.trim() ?? "",
      title: offering.publicTitle?.trim() || offering.serviceTitle,
    });
    groups.set(providerSlug, group);
  }

  const providers = Array.from(groups.values()).sort(compareProviders);

  for (const provider of providers) {
    provider.services.sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        providerCollator.compare(left.title, right.title) ||
        left.offeringId.localeCompare(right.offeringId),
    );
  }

  const nataliea = providers.find(
    (provider) =>
      normalizeProviderIdentity(provider.providerKey) === "nataliea" ||
      normalizeProviderIdentity(provider.providerSlug) === "nataliea" ||
      normalizeProviderIdentity(provider.displayName) === "nataliea",
  );

  return {
    defaultProviderSlug:
      nataliea?.providerSlug ?? providers[0]?.providerSlug ?? null,
    providers,
  };
}

export function resolvePublicProviderSlug(
  catalog: PublicProviderServiceCatalog,
  requestedProviderSlug: string | undefined,
): string | null {
  const requested = requestedProviderSlug?.trim();

  if (
    requested &&
    catalog.providers.some((provider) => provider.providerSlug === requested)
  ) {
    return requested;
  }

  return catalog.defaultProviderSlug;
}

function compareProviders(
  left: PublicProviderServiceCatalogGroup,
  right: PublicProviderServiceCatalogGroup,
): number {
  return (
    providerCollator.compare(left.displayName, right.displayName) ||
    left.providerSlug.localeCompare(right.providerSlug)
  );
}

function normalizeProviderIdentity(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-CA");
}
