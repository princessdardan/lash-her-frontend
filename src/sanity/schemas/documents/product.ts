import { defineArrayMember, defineField, defineType } from "sanity";

export const product = defineType({
  name: "product",
  title: "Product",
  type: "document",
  groups: [
    { name: "overview", title: "Overview" },
    { name: "pricing", title: "Pricing" },
    { name: "catalog", title: "Catalog" },
    { name: "media", title: "Media" },
    { name: "variants", title: "Variants" },
    { name: "details", title: "Details" },
    { name: "shipping", title: "Shipping" },
    { name: "legacy", title: "Legacy Fields" },
    { name: "seo", title: "SEO" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "overview",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      group: "overview",
      options: { source: "title" },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "overview",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "shortDescription",
      title: "Short Description",
      type: "text",
      group: "overview",
    }),
    defineField({
      name: "cardSubtitle",
      title: "Card Subtitle",
      type: "string",
      group: "overview",
      description:
        "Short catalog card label, such as retention or finish details.",
    }),
    defineField({
      name: "badgeLabel",
      title: "Badge Label",
      type: "string",
      group: "catalog",
      description: "Optional merchandising label, such as Best Seller or New.",
    }),
    defineField({
      name: "price",
      title: "Price",
      type: "number",
      group: "pricing",
      validation: (Rule) => Rule.required().min(0),
    }),
    defineField({
      name: "discountPrice",
      title: "Manual Discount Price",
      type: "number",
      group: "pricing",
      description:
        "Optional sale price configured directly in Sanity. Must be lower than the regular price.",
      validation: (Rule) =>
        Rule.min(0).custom((value, context) => {
          if (value === undefined) return true;
          return typeof context.document?.price === "number" &&
            value < context.document.price
            ? true
            : "Manual discount price must be lower than the regular price.";
        }),
    }),
    defineField({
      name: "sku",
      title: "Merchant SKU",
      type: "string",
      group: "pricing",
      description:
        "Optional merchant-facing SKU for reconciliation. Generated fallback codes are internal and not shown to customers.",
    }),
    defineField({
      name: "currency",
      title: "Currency",
      type: "string",
      group: "pricing",
      initialValue: "CAD",
      readOnly: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "collections",
      title: "Collections",
      type: "array",
      group: "catalog",
      of: [
        defineArrayMember({
          type: "reference",
          to: [{ type: "productCollection" }],
        }),
      ],
    }),
    defineField({
      name: "filterAttributes",
      title: "Filter Attributes (Deprecated)",
      type: "array",
      group: "legacy",
      description:
        "Deprecated catalog filter metadata. The public product catalog no longer supports filters.",
      deprecated: {
        reason: "Catalog filters were removed from the public product route.",
      },
      readOnly: true,
      hidden: ({ value }) => value === undefined,
      initialValue: undefined,
      of: [
        defineArrayMember({
          type: "object",
          title: "Filter Attribute",
          fields: [
            defineField({ name: "label", title: "Label", type: "string" }),
            defineField({ name: "value", title: "Value", type: "string" }),
          ],
          preview: {
            select: { title: "label", subtitle: "value" },
          },
        }),
      ],
    }),
    defineField({
      name: "variantModel",
      title: "Variant Authoring Model",
      type: "string",
      group: "variants",
      description:
        "Concrete variants are complete purchasable combinations. Grouped choices define one row per option group and are expanded into combinations by the storefront.",
      initialValue: "concrete",
      options: {
        layout: "radio",
        list: [
          { title: "Concrete purchasable variants", value: "concrete" },
          { title: "Grouped choices", value: "grouped" },
        ],
      },
      validation: (Rule) =>
        Rule.custom((value, context) => {
          const variants = Array.isArray(context.document?.variants)
            ? context.document.variants
            : [];
          const optionGroups = Array.isArray(context.document?.optionGroups)
            ? context.document.optionGroups
            : [];

          return (variants.length === 0 && optionGroups.length === 0) ||
            value === "concrete" ||
            value === "grouped"
            ? true
            : "Choose how variants are authored before publishing.";
        }),
    }),
    defineField({
      name: "optionGroups",
      title: "Option Groups",
      type: "array",
      group: "variants",
      description:
        "Optional display order for grouped choices such as Curl or Length. When Variants are authored as choice groups, their nested Options are the source of truth for values.",
      validation: (Rule) =>
        Rule.custom((groups) => validateOptionGroupNames(groups)),
      of: [
        defineArrayMember({
          type: "object",
          title: "Option Group",
          fields: [
            defineField({
              name: "name",
              title: "Name",
              type: "string",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "values",
              title: "Values",
              type: "array",
              description:
                "Optional display values for concrete variants. Grouped choices use the nested Options on each grouped Variant row.",
              hidden: ({ document }) => document?.variantModel === "grouped",
              of: [
                defineArrayMember({
                  type: "string",
                  validation: (Rule) => Rule.required(),
                }),
              ],
            }),
          ],
          preview: {
            select: { title: "name", values: "values" },
            prepare({ title, values }) {
              const optionCount = Array.isArray(values) ? values.length : 0;
              return {
                title,
                subtitle: `${optionCount} value${optionCount === 1 ? "" : "s"}`,
              };
            },
          },
        }),
      ],
    }),
    defineField({
      name: "isAvailable",
      title: "Available for checkout",
      type: "boolean",
      group: "catalog",
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "availabilityLabel",
      title: "Availability Label",
      type: "string",
      group: "catalog",
      description: "e.g., 'In Stock', 'Out of Stock', or 'Pre-order'.",
    }),
    defineField({
      name: "fulfillmentNote",
      title: "Fulfillment Note",
      type: "text",
      group: "catalog",
      description:
        "e.g., pickup, delivery, digital delivery, or care instructions.",
    }),
    defineField({
      name: "shipping",
      title: "Shipping and customs",
      type: "object",
      group: "shipping",
      description:
        "Operational metadata used to quote and buy Chit Chats postage.",
      fields: shippingMetadataFields(),
    }),
    defineField({
      name: "displayOrder",
      title: "Display Order",
      type: "number",
      group: "catalog",
      initialValue: 0,
      validation: (Rule) => Rule.integer(),
    }),
    defineField({
      name: "image",
      title: "Image",
      type: "image",
      group: "media",
      options: { hotspot: true },
      fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
    }),
    defineField({
      name: "gallery",
      title: "Gallery Images",
      type: "array",
      group: "media",
      of: [
        defineArrayMember({
          type: "image",
          options: { hotspot: true },
          fields: [
            defineField({ name: "alt", title: "Alt text", type: "string" }),
          ],
        }),
      ],
    }),
    defineField({
      name: "variants",
      title: "Variants",
      type: "array",
      group: "variants",
      description:
        "Create concrete purchasable variants, or create one row per choice group (for example Curl and Length) and list its customer-facing choices under Options. Grouped rows must share the same price and must not define variant SKUs or shipping overrides.",
      validation: (Rule) =>
        Rule.custom((variants, context) =>
          validateProductVariantConfiguration(variants, context.document),
        ),
      of: [
        defineArrayMember({
          type: "object",
          title: "Variant",
          fields: [
            defineField({
              name: "title",
              title: "Variant Title",
              type: "string",
              description:
                "For grouped choices, use the group label, such as Curl or Length. For a concrete variant, use the complete purchasable label.",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "price",
              title: "Variant Price",
              type: "number",
              validation: (Rule) => Rule.required().min(0),
            }),
            defineField({
              name: "discountPrice",
              title: "Manual Discount Price",
              type: "number",
              description:
                "Optional variant sale price. Must be lower than this variant's regular price.",
              validation: (Rule) =>
                Rule.min(0).custom((value, context) => {
                  const parent = context.parent as
                    | { price?: number }
                    | undefined;
                  if (value === undefined) return true;
                  return typeof parent?.price === "number" &&
                    value < parent.price
                    ? true
                    : "Manual discount price must be lower than the variant price.";
                }),
            }),
            defineField({
              name: "sku",
              title: "Variant Merchant SKU",
              type: "string",
              description: "Optional merchant-facing SKU for reconciliation.",
              hidden: ({ document }) => document?.variantModel === "grouped",
            }),
            defineField({
              name: "isAvailable",
              title: "Available for checkout",
              type: "boolean",
              initialValue: true,
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "availabilityLabel",
              title: "Availability Label",
              type: "string",
            }),
            defineField({
              name: "options",
              title: "Options",
              type: "array",
              description:
                "Grouped choice row: put each customer-facing choice in Group / Choice and leave Selected Value blank. Concrete variant row: map each option group name to its selected value.",
              of: [
                defineArrayMember({
                  type: "object",
                  title: "Option",
                  fields: [
                    defineField({
                      name: "name",
                      title: "Group / Choice",
                      type: "string",
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "value",
                      title: "Selected Value (Concrete Variants Only)",
                      type: "string",
                      hidden: ({ document }) =>
                        document?.variantModel === "grouped",
                      validation: (Rule) =>
                        Rule.custom((value) =>
                          value === undefined ||
                          value === null ||
                          value.trim().length > 0
                            ? true
                            : "Selected value cannot be blank. Remove it for a grouped choice.",
                        ),
                    }),
                  ],
                  preview: {
                    select: { title: "name", subtitle: "value" },
                  },
                }),
              ],
            }),
            defineField({
              name: "shipping",
              title: "Shipping override",
              type: "object",
              description:
                "Optional complete override for this variant. Leave empty to use product shipping metadata.",
              hidden: ({ document }) => document?.variantModel === "grouped",
              fields: shippingMetadataFields(),
            }),
          ],
          preview: {
            select: {
              title: "title",
              price: "price",
              isAvailable: "isAvailable",
            },
            prepare({ title, price, isAvailable }) {
              const amount =
                typeof price === "number" ? `$${price.toFixed(2)}` : "No price";
              return {
                title,
                subtitle: `${amount}${isAvailable === false ? " · Unavailable" : ""}`,
              };
            },
          },
        }),
      ],
    }),
    defineField({
      name: "detailSections",
      title: "Detail Sections",
      type: "array",
      group: "details",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({ name: "heading", title: "Heading", type: "string" }),
            defineField({ name: "content", title: "Content", type: "text" }),
            defineField({
              name: "body",
              title: "Rich Content",
              type: "array",
              description:
                "Optional rich replacement for Content. Existing plain text content is preserved.",
              of: [
                defineArrayMember({
                  type: "block",
                  lists: [
                    { title: "Bullet", value: "bullet" },
                    { title: "Numbered", value: "number" },
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    defineField({
      name: "seo",
      title: "SEO",
      type: "object",
      group: "seo",
      fields: [
        defineField({ name: "title", title: "SEO Title", type: "string" }),
        defineField({
          name: "description",
          title: "SEO Description",
          type: "text",
        }),
        defineField({
          name: "image",
          title: "SEO Image",
          type: "image",
          options: { hotspot: true },
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
      subtitle: "availabilityLabel",
      media: "image",
    },
  },
});

const MAX_GROUPED_VARIANT_COMBINATIONS = 100;

interface ProductVariantOptionInput {
  name?: unknown;
  value?: unknown;
}

interface ProductVariantInput {
  title?: unknown;
  price?: unknown;
  discountPrice?: unknown;
  sku?: unknown;
  isAvailable?: unknown;
  options?: unknown;
  shipping?: unknown;
}

interface ProductVariantDocumentInput {
  variantModel?: unknown;
  discountPrice?: unknown;
  optionGroups?: unknown;
}

export function validateOptionGroupNames(groups: unknown): true | string {
  if (groups === undefined || groups === null) return true;
  if (!Array.isArray(groups)) return "Option groups must be an array.";

  const seenNames = new Set<string>();

  for (const group of groups) {
    if (!isRecord(group)) return "Every option group must be an object.";

    const name = normalizeSchemaIdentity(group.name);
    if (!name) return "Every option group needs a non-blank name.";
    if (seenNames.has(name)) return "Option group names must be unique.";
    seenNames.add(name);

    if (group.values === undefined || group.values === null) continue;
    if (!Array.isArray(group.values)) {
      return `Values for ${cleanSchemaString(group.name) ?? "an option group"} must be an array.`;
    }

    const seenValues = new Set<string>();
    for (const value of group.values) {
      const normalizedValue = normalizeSchemaIdentity(value);
      if (!normalizedValue) return "Option group values cannot be blank.";
      if (seenValues.has(normalizedValue)) {
        return `Values for ${cleanSchemaString(group.name) ?? "an option group"} must be unique.`;
      }
      seenValues.add(normalizedValue);
    }
  }

  return true;
}

export function validateProductVariantConfiguration(
  variantsInput: unknown,
  documentInput: unknown,
): true | string {
  const document = isRecord(documentInput)
    ? (documentInput as ProductVariantDocumentInput)
    : {};
  const model = document.variantModel;
  const declaredGroupNames = getDeclaredOptionGroupNames(document.optionGroups);

  if (variantsInput === undefined || variantsInput === null) {
    return validateEmptyVariantConfiguration(model, declaredGroupNames);
  }
  if (!Array.isArray(variantsInput)) return "Variants must be an array.";
  if (variantsInput.length === 0) {
    return validateEmptyVariantConfiguration(model, declaredGroupNames);
  }
  if (model !== "concrete" && model !== "grouped") return true;

  const variants = variantsInput.filter(isRecord) as ProductVariantInput[];
  if (variants.length !== variantsInput.length) {
    return "Every variant must be an object.";
  }

  return model === "grouped"
    ? validateGroupedVariants(variants, document)
    : validateConcreteVariants(variants, document);
}

function validateEmptyVariantConfiguration(
  model: unknown,
  declaredGroupNames: string[],
): true | string {
  if (model === "grouped") {
    return "Grouped choice authoring requires at least one grouped Variant row.";
  }
  if (declaredGroupNames.length > 0) {
    return "Option Groups require concrete Variants with complete nested options.";
  }
  return true;
}

function validateGroupedVariants(
  variants: ProductVariantInput[],
  document: ProductVariantDocumentInput,
): true | string {
  const groupNames = new Set<string>();
  let combinationCount = 1;

  for (const variant of variants) {
    const title = normalizeSchemaIdentity(variant.title);
    if (!title) return "Every grouped row needs a non-blank group title.";
    if (groupNames.has(title)) return "Grouped row titles must be unique.";
    groupNames.add(title);

    if (!Array.isArray(variant.options) || variant.options.length === 0) {
      return "Every grouped row needs at least one nested choice.";
    }

    const choices = variant.options.filter(
      isRecord,
    ) as ProductVariantOptionInput[];
    if (choices.length !== variant.options.length) {
      return "Every grouped choice must be an object.";
    }

    const seenChoices = new Set<string>();
    const valueForms = new Set<"blank" | "self">();
    for (const choice of choices) {
      const name = normalizeSchemaIdentity(choice.name);
      if (!name)
        return "Every grouped choice needs a non-blank Group / Choice value.";
      if (seenChoices.has(name)) {
        return `Choices under ${cleanSchemaString(variant.title) ?? "a group"} must be unique.`;
      }
      seenChoices.add(name);

      const value = normalizeSchemaIdentity(choice.value);
      if (value && value !== name) {
        return "Grouped choices must leave Selected Value blank; legacy name/value duplicates are also accepted.";
      }
      valueForms.add(value ? "self" : "blank");
    }

    if (valueForms.size > 1) {
      return "Choices within one grouped row must use a consistent value format.";
    }

    combinationCount *= choices.length;
    if (combinationCount > MAX_GROUPED_VARIANT_COMBINATIONS) {
      return `Grouped choices cannot create more than ${MAX_GROUPED_VARIANT_COMBINATIONS} purchasable combinations.`;
    }
  }

  const declaredGroupNames = getDeclaredOptionGroupNames(document.optionGroups);
  if (
    declaredGroupNames.length > 0 &&
    !setsEqual(groupNames, new Set(declaredGroupNames))
  ) {
    return "Option Group names must exactly match grouped Variant titles.";
  }

  if (variants.some((variant) => cleanSchemaString(variant.sku))) {
    return "Grouped rows cannot define merchant SKUs.";
  }
  if (variants.some((variant) => hasShippingOverride(variant.shipping))) {
    return "Grouped rows cannot define shipping overrides.";
  }

  const prices = variants.map((variant) => toSchemaCents(variant.price));
  if (prices.some((price) => price === null)) {
    return "Grouped row prices must be valid amounts with no more than two decimal places.";
  }
  if (new Set(prices).size !== 1) {
    return "Grouped rows must all use the same price.";
  }

  const discounts = variants.map((variant) =>
    toOptionalSchemaCents(variant.discountPrice ?? document.discountPrice),
  );
  if (discounts.some((discount) => discount === undefined)) {
    return "Grouped row discounts must be valid amounts with no more than two decimal places.";
  }
  if (new Set(discounts).size !== 1) {
    return "Grouped rows must all use the same effective discount price.";
  }

  const price = prices[0];
  const discount = discounts[0];
  if (
    typeof price === "number" &&
    typeof discount === "number" &&
    discount >= price
  ) {
    return "The grouped discount price must be lower than the grouped price.";
  }

  if (new Set(variants.map((variant) => variant.isAvailable)).size !== 1) {
    return "Grouped rows must use the same checkout availability.";
  }

  return true;
}

function validateConcreteVariants(
  variants: ProductVariantInput[],
  document: ProductVariantDocumentInput,
): true | string {
  const optionLists = variants.map((variant) =>
    Array.isArray(variant.options)
      ? (variant.options.filter(isRecord) as ProductVariantOptionInput[])
      : [],
  );
  const usesOptions = optionLists.some((options) => options.length > 0);

  if (!usesOptions) {
    return getDeclaredOptionGroupNames(document.optionGroups).length === 0
      ? true
      : "Concrete variants with Option Groups must define complete nested name/value options.";
  }

  if (optionLists.some((options) => options.length === 0)) {
    return "Concrete variants cannot mix rows with and without nested options.";
  }

  const expectedNames = new Set<string>();
  const seenTuples = new Set<string>();

  for (const [variantIndex, options] of optionLists.entries()) {
    const names = new Set<string>();
    const tuple: Array<[string, string]> = [];

    for (const option of options) {
      const name = normalizeSchemaIdentity(option.name);
      const value = normalizeSchemaIdentity(option.value);
      if (!name || !value) {
        return "Concrete variant options need both a non-blank group name and selected value.";
      }
      if (names.has(name)) {
        return "A concrete variant cannot repeat the same option group.";
      }
      names.add(name);
      tuple.push([name, value]);
    }

    if (variantIndex === 0) {
      for (const name of names) expectedNames.add(name);
    } else if (!setsEqual(names, expectedNames)) {
      return "Every concrete variant must define the same option groups.";
    }

    const tupleKey = JSON.stringify(tuple.sort(compareSchemaTuples));
    if (seenTuples.has(tupleKey)) {
      return "Concrete variants must use unique option combinations.";
    }
    seenTuples.add(tupleKey);
  }

  const declaredNames = getDeclaredOptionGroupNames(document.optionGroups);
  if (
    declaredNames.length > 0 &&
    !setsEqual(expectedNames, new Set(declaredNames))
  ) {
    return "Option Group names must exactly match concrete variant option names.";
  }

  return true;
}

function getDeclaredOptionGroupNames(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!isRecord(group)) return [];
    const name = normalizeSchemaIdentity(group.name);
    return name ? [name] : [];
  });
}

function hasShippingOverride(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      !key.startsWith("_") &&
      entry !== undefined &&
      entry !== null &&
      entry !== "",
  );
}

function toSchemaCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const cents = Math.round(value * 100);
  return Math.abs(value - cents / 100) < 1e-9 ? cents : null;
}

function toOptionalSchemaCents(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return toSchemaCents(value) ?? undefined;
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function compareSchemaTuples(
  [leftName, leftValue]: [string, string],
  [rightName, rightValue]: [string, string],
): number {
  return (
    compareCodePoints(leftName, rightName) ||
    compareCodePoints(leftValue, rightValue)
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanSchemaString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFKC").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeSchemaIdentity(value: unknown): string | null {
  return cleanSchemaString(value)?.toLowerCase() ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shippingMetadataFields() {
  return [
    defineField({
      name: "fulfillmentMode",
      title: "Fulfillment mode",
      type: "string",
      initialValue: "physical",
      options: {
        list: [
          { title: "Physical shipping", value: "physical" },
          { title: "Manual fulfillment", value: "manual" },
        ],
        layout: "radio",
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "weightGrams",
      title: "Item weight (grams)",
      type: "number",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "packingUnits",
      title: "Packing units",
      type: "number",
      initialValue: 1,
      description: "Relative space consumed in package profiles.",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "minimumPackageTier",
      title: "Minimum package profile slug",
      type: "string",
    }),
    defineField({
      name: "customsDescription",
      title: "Customs description",
      type: "string",
    }),
    defineField({
      name: "countryOfOrigin",
      title: "Country of origin",
      type: "string",
      description: "ISO 3166-1 alpha-2 code, for example CA or KR.",
      validation: (Rule) =>
        Rule.regex(/^[A-Z]{2}$/, { name: "ISO country code" }),
    }),
    defineField({
      name: "usShippingApproved",
      title: "Approved for U.S. shipping",
      type: "boolean",
      initialValue: false,
      description:
        "Fail-closed allowlist. U.S. quoting also requires the global feature flag.",
    }),
    defineField({
      name: "hsTariffCode",
      title: "10-digit HTS code",
      type: "string",
      validation: (Rule) =>
        Rule.regex(/^\d{10}$/, { name: "10-digit HTS code" }),
    }),
    defineField({
      name: "manufacturerName",
      title: "Manufacturer name",
      type: "string",
    }),
    defineField({
      name: "manufacturerAddress",
      title: "Manufacturer address",
      type: "text",
    }),
    defineField({
      name: "manufacturerCity",
      title: "Manufacturer city",
      type: "string",
    }),
    defineField({
      name: "manufacturerProvinceCode",
      title: "Manufacturer province/state code",
      type: "string",
    }),
    defineField({
      name: "manufacturerPostalCode",
      title: "Manufacturer postal code",
      type: "string",
    }),
    defineField({
      name: "manufacturerCountryCode",
      title: "Manufacturer country code",
      type: "string",
      validation: (Rule) =>
        Rule.regex(/^[A-Z]{2}$/, { name: "ISO country code" }),
    }),
    defineField({
      name: "hazardousMaterial",
      title: "Hazardous material",
      type: "boolean",
      initialValue: false,
      description: "Hazardous items are rejected by automated quoting.",
    }),
  ];
}
