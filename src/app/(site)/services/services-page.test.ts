import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";
import type { TServiceEditorial } from "@/types";

process.env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
process.env.NEXT_PUBLIC_SANITY_DATASET = "test";

test("listing renders editorial services without any provider or price data", async (t) => {
  const { loaders } = await import("@/data/loaders");
  const { default: ServicesPage } = await import("./page");
  t.mock.method(loaders, "getServicesPageData", async () => null);
  const services: TServiceEditorial[] = [
    {
      _id: "classic",
      title: "Classic Lashes",
      slug: "classic-lashes",
      shortDescription: "A natural finish.",
      description: "Longer detail copy.",
    },
    {
      _id: "brows",
      title: "Brow Shaping",
      slug: "brow-shaping",
      shortDescription: "  ",
      description: "Defined brows.",
    },
    { _id: "lift", title: "Lash Lift", slug: "lash-lift" },
  ];
  t.mock.method(loaders, "getServiceListings", async () => services);

  const html = renderToStaticMarkup(await ServicesPage());
  assert.match(html, /Classic Lashes/);
  assert.match(html, /A natural finish\./);
  assert.doesNotMatch(html, /Longer detail copy/);
  assert.match(html, /Defined brows\./);
  assert.match(html, /Lash Lift/);
  assert.match(html, /href="\/services\/classic-lashes"/);
  assert.doesNotMatch(html, /href="\/services\/lash-lift"/);
  assert.equal(html.split(`href="${FRESHA_BOOKING_URL}"`).length - 1, 4);
  assert.doesNotMatch(html, /role="tab|\?provider=|CAD|\$\d|\d+ min/);
});

test("empty catalog still provides a useful Fresha destination", async (t) => {
  const { loaders } = await import("@/data/loaders");
  const { default: ServicesPage } = await import("./page");
  t.mock.method(loaders, "getServicesPageData", async () => ({}));
  t.mock.method(loaders, "getServiceListings", async () => []);

  const html = renderToStaticMarkup(await ServicesPage());
  assert.match(html, /Our full service menu is available on Fresha/);
  assert.ok(html.includes(`href="${FRESHA_BOOKING_URL}"`));
});

test("redirect mode uses the fixed Fresha URL without loading service records", async (t) => {
  const { loaders } = await import("@/data/loaders");
  const { default: ServicesPage } = await import("./page");
  const settings = { redirectToFresha: true };
  t.mock.method(loaders, "getServicesPageData", async () => settings);
  const catalog = t.mock.method(loaders, "getServiceListings", async () => []);

  await assert.rejects(ServicesPage, (error: unknown) => {
    assert.equal(
      (error as { digest: string }).digest,
      `NEXT_REDIRECT;replace;${FRESHA_BOOKING_URL};307;`,
    );
    return true;
  });
  assert.equal(catalog.mock.callCount(), 0);

  settings.redirectToFresha = false;
  assert.match(renderToStaticMarkup(await ServicesPage()), /<h1/);
  assert.equal(catalog.mock.callCount(), 1);
});
