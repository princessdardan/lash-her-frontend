import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { PublicBookingOffering } from "./offering";
import {
  buildPublicProviderServiceCatalog,
  resolvePublicProviderSlug,
} from "./public-service-catalog";

type CatalogOffering = PublicBookingOffering & {
  displayOrder: number;
  hasEditorialDetail: boolean;
  provider: PublicBookingOffering["provider"] & { providerKey: string };
  publicSummary: string;
  publicTitle: string;
};

describe("public provider service catalog", () => {
  it("sorts provider tabs alphabetically but defaults to Nataliea", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        displayName: "Zoë",
        offeringId: "offering-zoe",
        providerKey: "zoe",
        providerSlug: "zoe",
        serviceSlug: "volume-set",
      }),
      createOffering({
        displayName: "Nataliea",
        offeringId: "offering-nataliea",
        providerKey: "nataliea",
        providerSlug: "nataliea",
        serviceSlug: "classic-set",
      }),
      createOffering({
        displayName: "Amara",
        offeringId: "offering-amara",
        providerKey: "amara",
        providerSlug: "amara",
        serviceSlug: "hybrid-set",
      }),
    ]);

    assert.deepEqual(
      catalog.providers.map((provider) => provider.providerSlug),
      ["amara", "nataliea", "zoe"],
    );
    assert.equal(catalog.defaultProviderSlug, "nataliea");
  });

  it("falls back to the alphabetical provider and honors a valid request", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        displayName: "Zoë",
        offeringId: "offering-zoe",
        providerKey: "zoe",
        providerSlug: "zoe",
        serviceSlug: "volume-set",
      }),
      createOffering({
        displayName: "Amara",
        offeringId: "offering-amara",
        providerKey: "amara",
        providerSlug: "amara",
        serviceSlug: "classic-set",
      }),
    ]);

    assert.equal(catalog.defaultProviderSlug, "amara");
    assert.equal(resolvePublicProviderSlug(catalog, "zoe"), "zoe");
    assert.equal(resolvePublicProviderSlug(catalog, "unknown"), "amara");
  });

  it("defaults to a normalized Nataliea display name when identifiers differ", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        displayName: "Amara",
        offeringId: "offering-amara",
        providerKey: "amara",
        providerSlug: "amara",
        serviceSlug: "classic-set",
      }),
      createOffering({
        displayName: "  NATALIEA  ",
        offeringId: "offering-nataliea",
        providerKey: "provider-001",
        providerSlug: "nataliea-demiri",
        serviceSlug: "volume-set",
      }),
    ]);

    assert.equal(catalog.defaultProviderSlug, "nataliea-demiri");
  });

  it("returns provider-specific copy, ordering, pricing, and links", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        displayName: "Nataliea",
        displayOrder: 2,
        offeringId: "offering-fill",
        providerKey: "nataliea",
        providerSlug: "nataliea",
        serviceSlug: "lash-fill",
        title: "Lash Fill",
      }),
      createOffering({
        displayName: "Nataliea",
        displayOrder: 1,
        hasEditorialDetail: false,
        offeringId: "offering-set",
        providerKey: "nataliea",
        providerSlug: "nataliea",
        serviceSlug: "classic-set",
        title: "Classic Set",
      }),
    ]);

    const services = catalog.providers[0]?.services ?? [];
    assert.deepEqual(
      services.map((service) => service.offeringId),
      ["offering-set", "offering-fill"],
    );
    assert.equal(
      services[0]?.bookingHref,
      "/services/classic-set/booking?provider=nataliea",
    );
    assert.equal(services[0]?.detailHref, undefined);
    assert.equal(
      services[1]?.detailHref,
      "/services/lash-fill?provider=nataliea",
    );
    assert.equal(services[1]?.fullPriceCents, 15_000);
  });

  it("omits providers without a stable public slug", () => {
    const offering = createOffering({
      displayName: "Private Provider",
      offeringId: "offering-private",
      providerKey: "private-provider",
      providerSlug: "private-provider",
      serviceSlug: "private-service",
    });
    offering.provider.publicSlug = undefined;

    assert.deepEqual(buildPublicProviderServiceCatalog([offering]), {
      defaultProviderSlug: null,
      providers: [],
    });
  });

  it("omits route-unsafe provider and service slugs", () => {
    const unsafeProvider = createOffering({
      displayName: "Unsafe Provider",
      offeringId: "unsafe-provider",
      providerKey: "unsafe-provider",
      providerSlug: "..",
      serviceSlug: "classic-set",
    });
    const unsafeService = createOffering({
      displayName: "Safe Provider",
      offeringId: "unsafe-service",
      providerKey: "safe-provider",
      providerSlug: "safe-provider",
      serviceSlug: "../classic-set",
    });

    assert.deepEqual(
      buildPublicProviderServiceCatalog([unsafeProvider, unsafeService]),
      {
        defaultProviderSlug: null,
        providers: [],
      },
    );
  });

  it("keeps the public catalog operational and exposes an accessible tab UI", () => {
    const servicesPageSource = readFileSync(
      new URL("../../../app/(site)/services/page.tsx", import.meta.url),
      "utf8",
    );
    const tabsSource = readFileSync(
      new URL(
        "../../../components/services/provider-service-tabs.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    assert.match(
      servicesPageSource,
      /loadPublicOperationalOfferings\(\{ mode: "operational" \}\)/,
    );
    assert.doesNotMatch(servicesPageSource, /loaders\.|sanity/i);
    assert.match(tabsSource, /role="tablist"/);
    assert.match(tabsSource, /role="tab"/);
    assert.match(tabsSource, /role="tabpanel"/);
    assert.match(tabsSource, /aria-selected=/);
    assert.match(tabsSource, /ArrowRight|ArrowLeft/);
    assert.match(tabsSource, /router\.replace/);
  });
});

function createOffering(input: {
  displayName: string;
  displayOrder?: number;
  hasEditorialDetail?: boolean;
  offeringId: string;
  providerKey: string;
  providerSlug: string;
  serviceSlug: string;
  title?: string;
}): CatalogOffering {
  return {
    addOns: [],
    depositAmountCents: 5_000,
    displayOrder: input.displayOrder ?? 0,
    durationMinutes: 90,
    fullPriceCents: 15_000,
    hasEditorialDetail: input.hasEditorialDetail ?? true,
    id: input.offeringId,
    offeringKey: input.offeringId,
    provider: {
      displayName: input.displayName,
      providerKey: input.providerKey,
      publicSlug: input.providerSlug,
    },
    publicSummary: `${input.title ?? input.serviceSlug} summary`,
    publicTitle: input.title ?? input.serviceSlug,
    serviceSlug: input.serviceSlug,
    serviceTitle: input.title ?? input.serviceSlug,
  };
}
