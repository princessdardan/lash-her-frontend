import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { PublicBookingOffering } from "@/lib/booking/operations/offering";
import {
  buildPublicProviderServiceCatalog,
  resolvePublicProviderSlug,
} from "@/lib/booking/operations/public-service-catalog";

const tabsSource = readFileSync(
  new URL("./provider-service-tabs.tsx", import.meta.url),
  "utf8",
);
const servicesPageSource = readFileSync(
  new URL("../../app/(site)/services/page.tsx", import.meta.url),
  "utf8",
);

describe("provider service tabs", () => {
  it("keeps provider-specific copy, prices, and booking links isolated", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        fullPriceCents: 12_000,
        offeringId: "alex-classic",
        providerKey: "alex",
        providerName: "Alex",
        providerSlug: "alex",
        publicTitle: "Classic Set with Alex",
      }),
      createOffering({
        fullPriceCents: 15_000,
        offeringId: "nataliea-classic",
        providerKey: "nataliea",
        providerName: "Nataliea",
        providerSlug: "nataliea",
        publicTitle: "Nataliea Signature Classic",
      }),
    ]);

    const alex = catalog.providers.find(
      (provider) => provider.providerSlug === "alex",
    );
    const nataliea = catalog.providers.find(
      (provider) => provider.providerSlug === "nataliea",
    );

    assert.deepEqual(alex?.services, [
      {
        bookingHref: "/services/classic-set/booking?provider=alex",
        depositAmountCents: 5_000,
        detailHref: "/services/classic-set?provider=alex",
        displayOrder: 0,
        durationMinutes: 90,
        fullPriceCents: 12_000,
        offeringId: "alex-classic",
        serviceSlug: "classic-set",
        summary: "Classic Set with Alex summary",
        title: "Classic Set with Alex",
      },
    ]);
    assert.equal(
      nataliea?.services[0]?.bookingHref,
      "/services/classic-set/booking?provider=nataliea",
    );
    assert.equal(nataliea?.services[0]?.fullPriceCents, 15_000);
    assert.equal(nataliea?.services[0]?.title, "Nataliea Signature Classic");
  });

  it("uses stable fallbacks and deterministic tie-breakers for incomplete copy", () => {
    const first = createOffering({
      fullPriceCents: 12_000,
      offeringId: "offering-z",
      providerKey: "shared-provider",
      providerName: "Shared Provider",
      providerSlug: "shared-provider",
      publicTitle: "Classic Set",
    });
    const second = createOffering({
      fullPriceCents: 12_000,
      offeringId: "offering-a",
      providerKey: "shared-provider",
      providerName: "Shared Provider",
      providerSlug: "shared-provider",
      publicTitle: "Classic Set",
    });
    const incomplete: PublicBookingOffering = {
      ...createOffering({
        fullPriceCents: 12_000,
        offeringId: "offering-incomplete",
        providerKey: "shared-provider",
        providerName: "Shared Provider",
        providerSlug: "shared-provider",
        publicTitle: "unused",
      }),
      displayOrder: undefined,
      hasEditorialDetail: false,
      provider: {
        displayName: "Shared Provider",
        publicSlug: "shared-provider",
      },
      publicSummary: undefined,
      publicTitle: " ",
      serviceTitle: "Fallback Service Title",
    };

    const catalog = buildPublicProviderServiceCatalog([
      first,
      incomplete,
      second,
    ]);
    const services = catalog.providers[0]?.services ?? [];

    assert.deepEqual(
      services.map((service) => service.offeringId),
      ["offering-a", "offering-z", "offering-incomplete"],
    );
    assert.equal(services[2]?.displayOrder, Number.MAX_SAFE_INTEGER);
    assert.equal(services[2]?.title, "Fallback Service Title");
    assert.equal(services[2]?.summary, "");
    assert.equal(services[2]?.detailHref, undefined);
    assert.equal(catalog.providers[0]?.providerKey, "shared-provider");
    assert.equal(resolvePublicProviderSlug(catalog, "  "), "shared-provider");
    assert.equal(
      resolvePublicProviderSlug(catalog, "missing-provider"),
      "shared-provider",
    );
  });

  it("uses the provider slug as the Nataliea default when its key differs", () => {
    const catalog = buildPublicProviderServiceCatalog([
      createOffering({
        fullPriceCents: 12_000,
        offeringId: "first-alpha",
        providerKey: "first-alpha",
        providerName: "A Provider",
        providerSlug: "a-provider",
        publicTitle: "Alpha Service",
      }),
      createOffering({
        fullPriceCents: 15_000,
        offeringId: "nataliea-service",
        providerKey: "provider-1",
        providerName: "Z Provider",
        providerSlug: "nataliea",
        publicTitle: "Nataliea Service",
      }),
    ]);

    assert.equal(catalog.defaultProviderSlug, "nataliea");
    assert.equal(resolvePublicProviderSlug(catalog, "nataliea"), "nataliea");
    assert.equal(
      resolvePublicProviderSlug(
        { defaultProviderSlug: null, providers: [] },
        undefined,
      ),
      null,
    );
  });

  it("implements an associated, roving-tabindex keyboard tab pattern", () => {
    assert.match(tabsSource, /role="tablist"/);
    assert.match(tabsSource, /role="tab"/);
    assert.match(tabsSource, /role="tabpanel"/);
    assert.match(tabsSource, /aria-controls=\{getPanelId\(provider\)\}/);
    assert.match(tabsSource, /aria-labelledby=\{getTabId\(provider\)\}/);
    assert.match(tabsSource, /hidden=\{!isSelected\}/);
    assert.match(tabsSource, /tabIndex=\{isSelected \? 0 : -1\}/);
    assert.match(tabsSource, /event\.key === "ArrowRight"/);
    assert.match(tabsSource, /event\.key === "ArrowLeft"/);
    assert.match(tabsSource, /event\.key === "Home"/);
    assert.match(tabsSource, /event\.key === "End"/);
    assert.match(tabsSource, /event\.preventDefault\(\)/);
    assert.match(tabsSource, /tabRefs\.current\[index\]\?\.focus\(\)/);
  });

  it("renders only the selected provider services and preserves URL state", () => {
    assert.match(
      tabsSource,
      /catalog\.providers\.find\([\s\S]*provider\.providerSlug === selectedProviderSlug/,
    );
    assert.match(tabsSource, /catalog\.providers\.map/);
    assert.match(tabsSource, /hidden=\{!isSelected\}/);
    assert.match(tabsSource, /provider\.services\.map/);
    assert.doesNotMatch(tabsSource, /catalog\.providers\.flatMap/);
    assert.match(tabsSource, /new URLSearchParams\(window\.location\.search\)/);
    assert.match(tabsSource, /params\.set\("provider", providerSlug\)/);
    assert.match(
      tabsSource,
      /router\.replace\(`\$\{pathname\}\?\$\{params\.toString\(\)\}`,\s*\{\s*scroll: false\s*\}\)/,
    );
  });

  it("loads the operational catalog and safely resolves the provider query", () => {
    assert.match(
      servicesPageSource,
      /loadPublicOperationalOfferings\(\{ mode: "operational" \}\)/,
    );
    assert.match(
      servicesPageSource,
      /typeof params\.provider === "string" \? params\.provider : undefined/,
    );
    assert.match(
      servicesPageSource,
      /resolvePublicProviderSlug\(\s*catalog,\s*requestedProvider,\s*\)/,
    );
    assert.match(
      servicesPageSource,
      /initialProviderSlug=\{initialProviderSlug\}/,
    );
    assert.doesNotMatch(servicesPageSource, /key=\{initialProviderSlug\}/);
    assert.match(
      tabsSource,
      /selection\.initialProviderSlug === initialProviderSlug[\s\S]*selection\.selectedProviderSlug[\s\S]*initialProviderSlug/,
    );
    assert.doesNotMatch(tabsSource, /useEffect/);
    assert.doesNotMatch(servicesPageSource, /getServices|getBookableServices/);
  });
});

function createOffering(input: {
  fullPriceCents: number;
  offeringId: string;
  providerKey: string;
  providerName: string;
  providerSlug: string;
  publicTitle: string;
}): PublicBookingOffering {
  return {
    addOns: [],
    depositAmountCents: 5_000,
    displayOrder: 0,
    durationMinutes: 90,
    fullPriceCents: input.fullPriceCents,
    hasEditorialDetail: true,
    id: input.offeringId,
    offeringKey: input.offeringId,
    provider: {
      displayName: input.providerName,
      providerKey: input.providerKey,
      publicSlug: input.providerSlug,
    },
    publicSummary: `${input.publicTitle} summary`,
    publicTitle: input.publicTitle,
    serviceSlug: "classic-set",
    serviceTitle: "Classic Set",
  };
}
