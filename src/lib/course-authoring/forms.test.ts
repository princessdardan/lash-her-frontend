import assert from "node:assert/strict";
import test from "node:test";
import { courseFormInput, courseUpdateInput } from "./forms";
function form(values: Record<string, string | undefined>) {
  const value = new FormData();
  for (const [key, text] of Object.entries(values))
    if (text !== undefined) value.set(key, text);
  return value;
}
const base = {
  title: "Lash foundations",
  slug: "lash-foundations",
  accessMode: "free",
  price: "0.00",
};
test("course drafts use exact CAD cents, optional marketing and an explicit expected revision", () => {
  assert.deepEqual(courseFormInput(form(base)), {
    title: base.title,
    slug: base.slug,
    description: null,
    introduction: null,
    currency: "CAD",
    accessMode: "free",
    priceCents: 0,
    cover: null,
    seo: { noIndex: false },
    taxClassification: null,
  });
  assert.equal(
    courseFormInput(form({ ...base, accessMode: "paid", price: "49.95" }))
      .priceCents,
    4995,
  );
  assert.equal(
    courseFormInput(form({ ...base, accessMode: "paid", price: "0.01" }))
      .priceCents,
    1,
  );
  assert.equal(courseUpdateInput(form(base), 9).expectedRevision, 9);
});
test("course forms refuse contradictory pricing, unsafe covers, unsupported classification and invalid slugs", () => {
  for (const changes of [
    { price: "1" },
    { accessMode: "paid" },
    { accessMode: "other" },
    { accessMode: "paid", price: "1e3" },
    { accessMode: "paid", price: "0.001" },
    { accessMode: "paid", price: "99999999.99" },
    { slug: "UPPERCASE" },
    { slug: "../../courses" },
    { title: " " },
    { coverUrl: "javascript:alert(1)", coverAlt: "Image" },
    {
      coverUrl: "https://user:password@example.com/image.jpg",
      coverAlt: "Image",
    },
    { coverUrl: "https://example.com/image.jpg" },
    { taxClassification: "guess a legal tax rate" },
  ])
    assert.throws(() => courseFormInput(form({ ...base, ...changes })));
  const valid = courseFormInput(
    form({
      ...base,
      coverUrl: "https://cdn.example.com/cover.jpg",
      coverAlt: "Lash practice",
      taxClassification: "approved-code",
      seoTitle: "Lash course",
      noIndex: "on",
    }),
  );
  assert.deepEqual(valid.cover, {
    url: "https://cdn.example.com/cover.jpg",
    alt: "Lash practice",
  });
  assert.deepEqual(valid.seo, { title: "Lash course", noIndex: true });
});
