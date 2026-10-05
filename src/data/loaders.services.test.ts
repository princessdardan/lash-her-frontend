import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluate, parse } from "groq-js";

const source = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");
const projection = source.match(/const SERVICE_PROJECTION = groq`([^`]+)`/)![1];

function queryFor(name: string) {
  return source
    .slice(source.indexOf(`async function ${name}(`))
    .match(/groq`([^`]+)`/)![1]
    .replace("${SERVICE_PROJECTION}", projection);
}

test("listing query supports legacy documents, hiding, and deterministic editorial ordering", async () => {
  const documents = [
    { _id: "z", title: "Z service", displayOrder: 0 },
    { _id: "b", title: "B service" },
    {
      _id: "a",
      title: "A service",
      hideFromListing: false,
      isAvailable: false,
    },
    { _id: "hidden", title: "Hidden", hideFromListing: true },
    { _id: "missing-slug", title: "Missing slug", slug: null },
  ].map((service) => ({
    _type: "service",
    slug: { current: service._id },
    fullPrice: 200,
    durationMinutes: 90,
    ...service,
  }));

  const value = await evaluate(parse(queryFor("getServiceListings")), {
    dataset: documents,
  });
  const services = await value.get();
  assert.deepEqual(
    services.map((service: { _id: string }) => service._id),
    ["z", "a", "b"],
  );
  for (const service of services) {
    assert.equal(service.fullPrice, undefined);
    assert.equal(service.durationMinutes, undefined);
    assert.equal(service.provider, undefined);
  }
});

test("services page query selects only the canonical singleton and preserves missing defaults", async () => {
  const query = parse(queryFor("getServicesPageData"));
  const unrelated = {
    _type: "servicesPage",
    _id: "other",
    redirectToFresha: true,
  };
  assert.equal(
    await (await evaluate(query, { dataset: [unrelated] })).get(),
    null,
  );
  for (const redirectToFresha of [false, true]) {
    const value = await evaluate(query, {
      dataset: [
        unrelated,
        { _type: "servicesPage", _id: "servicesPage", redirectToFresha },
      ],
    });
    assert.deepEqual(await value.get(), { redirectToFresha });
  }
});
