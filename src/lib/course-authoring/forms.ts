import type { CourseCreateInput, CourseUpdateInput } from "./types";

export function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
export function courseFormInput(form: FormData): CourseCreateInput {
  const title = textField(form, "title"),
    slug = textField(form, "slug"),
    accessMode = textField(form, "accessMode");
  if (
    !title ||
    title.length > 300 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) ||
    slug.length > 120
  )
    throw new Error(
      "Enter a title and a lowercase URL name using letters, numbers and hyphens.",
    );
  if (accessMode !== "free" && accessMode !== "paid")
    throw new Error("Choose free or paid access.");
  const price = textField(form, "price") || "0";
  if (!/^\d{1,8}(?:\.\d{1,2})?$/u.test(price))
    throw new Error("Enter a CAD price with up to two decimal places.");
  const [dollars = "0", fraction = ""] = price.split(".");
  const priceCents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (
    !Number.isSafeInteger(priceCents) ||
    priceCents > 2_147_483_647 ||
    (accessMode === "free" ? priceCents !== 0 : priceCents === 0)
  )
    throw new Error(
      "Free courses require a zero price. Paid courses require a positive CAD price.",
    );
  const coverUrl = textField(form, "coverUrl"),
    coverAlt = textField(form, "coverAlt");
  if (coverUrl || coverAlt) {
    let url: URL;
    try {
      url = new URL(coverUrl);
    } catch {
      throw new Error(
        "Enter a valid HTTPS cover address and alternative text.",
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !coverAlt ||
      /[\u0000-\u0020\\]/u.test(coverUrl)
    )
      throw new Error(
        "Enter a valid HTTPS cover address and alternative text.",
      );
  }
  const taxClassification = textField(form, "taxClassification");
  if (
    taxClassification &&
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(taxClassification)
  )
    throw new Error("Use the approved tax classification code.");
  return {
    title,
    slug,
    description: textField(form, "description") || null,
    introduction: textField(form, "introduction") || null,
    currency: "CAD",
    accessMode,
    priceCents,
    cover: coverUrl ? { url: coverUrl, alt: coverAlt } : null,
    seo: {
      ...(textField(form, "seoTitle")
        ? { title: textField(form, "seoTitle") }
        : {}),
      ...(textField(form, "seoDescription")
        ? { description: textField(form, "seoDescription") }
        : {}),
      noIndex: form.get("noIndex") === "on",
    },
    taxClassification: taxClassification || null,
  };
}
export function courseUpdateInput(
  form: FormData,
  expectedRevision: number,
): CourseUpdateInput {
  return { ...courseFormInput(form), expectedRevision };
}
