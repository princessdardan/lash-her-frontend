import { defineArrayMember, defineField, defineType } from "sanity";
import { getProductCheckoutEligibility } from "@/lib/commerce/product-checkout-eligibility";
import type { TProductShippingMetadata } from "@/types";

export const product = defineType({
  name: "product",
  title: "Product",
  type: "document",
  validation: (Rule) =>
    Rule.custom((value) => validateProductCheckoutConfiguration(value)),
  groups: [
    { name: "overview", title: "Overview" },
    { name: "pricing", title: "Pricing" },
    { name: "catalog", title: "Catalog" },
    { name: "media", title: "Media" },
    { name: "variants", title: "Options" },
    { name: "details", title: "Details" },
    { name: "shipping", title: "Shipping & Customs" },
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
      description:
        "A sentence or two used as the catalog card blurb and the fallback SEO/social summary. Falls back to the full Description when empty. For a few-word label, use Card Subtitle instead.",
    }),
    defineField({
      name: "cardSubtitle",
      title: "Card Subtitle",
      type: "string",
      group: "overview",
      description:
        "A short uppercase label shown beneath the title on the card and product page, such as retention or finish details. Keep it to a few words, not a sentence — for a blurb, use Short Description.",
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
      description:
        "The default price for every option combination. Use a Variant Override only when a specific combination costs a different amount.",
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
      // Every price is CAD and the value is locked; hide the dead editor slot
      // while still stamping "CAD" on new documents for JSON-LD and orders.
      hidden: true,
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
      name: "options",
      title: "Options",
      type: "array",
      group: "variants",
      description:
        "Leave empty for a product with no choices. Add one option (for example Size) for simple variants, or two options (for example Curl and Length) for a two-level product. Purchasable combinations are generated automatically from the values.",
      validation: (Rule) =>
        Rule.max(2).custom((options) => validateOptionAxes(options)),
      of: [
        defineArrayMember({
          type: "object",
          title: "Option",
          fields: [
            defineField({
              name: "name",
              title: "Name",
              type: "string",
              description: "The axis label, such as Curl or Length.",
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: "values",
              title: "Values",
              type: "array",
              description: "The choices customers pick from, such as C and CC.",
              of: [
                defineArrayMember({
                  type: "string",
                  validation: (Rule) => Rule.required(),
                }),
              ],
              validation: (Rule) => Rule.required().min(1),
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
      name: "variantOverrides",
      title: "Variant Overrides",
      type: "array",
      group: "variants",
      description:
        "Optional. Add an entry only for a combination that needs its own price, availability, SKU, or shipping. Every combination you do not list inherits the product-level values, so most products leave this empty.",
      hidden: ({ document }) =>
        !Array.isArray(document?.options) || document.options.length === 0,
      validation: (Rule) =>
        Rule.custom((overrides, context) =>
          validateVariantOverrides(overrides, context.document),
        ),
      of: [
        defineArrayMember({
          type: "object",
          title: "Override",
          fields: [
            defineField({
              name: "select",
              title: "Combination",
              type: "array",
              description:
                "Pin the exact combination this override applies to — one row per option, each naming an option and one of its values.",
              validation: (Rule) => Rule.required().min(1),
              of: [
                defineArrayMember({
                  type: "object",
                  title: "Selection",
                  fields: [
                    defineField({
                      name: "name",
                      title: "Option",
                      type: "string",
                      validation: (Rule) => Rule.required(),
                    }),
                    defineField({
                      name: "value",
                      title: "Value",
                      type: "string",
                      validation: (Rule) => Rule.required(),
                    }),
                  ],
                  preview: { select: { title: "name", subtitle: "value" } },
                }),
              ],
            }),
            defineField({
              name: "image",
              title: "Variant Image",
              type: "image",
              options: { hotspot: true },
              description:
                "Optional. Shown instead of the product image while this combination is selected. Leave blank to keep the product image.",
              fields: [
                defineField({ name: "alt", title: "Alt text", type: "string" }),
              ],
            }),
            defineField({
              name: "price",
              title: "Price Override",
              type: "number",
              description:
                "Leave blank to keep the product price for this combination.",
              validation: (Rule) => Rule.min(0),
            }),
            defineField({
              name: "discountPrice",
              title: "Manual Discount Price",
              type: "number",
              description:
                "Optional sale price for this combination. Must be lower than its effective price.",
              validation: (Rule) => Rule.min(0),
            }),
            defineField({
              name: "sku",
              title: "Merchant SKU",
              type: "string",
              description: "Optional merchant-facing SKU for reconciliation.",
            }),
            defineField({
              name: "isAvailable",
              title: "Available for checkout",
              type: "boolean",
              description:
                "Leave blank to follow the product. Set to false to mark just this combination sold out.",
            }),
            defineField({
              name: "availabilityLabel",
              title: "Availability Label",
              type: "string",
            }),
            defineField({
              name: "stockQuantity",
              title: "Stock on hand",
              type: "number",
              description:
                "Units on hand for this exact combination. Changing this number resets the live count; leave blank to sell this combination without tracking stock. This is a restock input — the live remaining count is on the admin Inventory screen.",
              validation: (Rule) => Rule.integer().min(0),
            }),
            defineField({
              name: "shipping",
              title: "Shipping, Packing & Customs Override",
              type: "object",
              description:
                "Optional complete metadata set for this combination. Leave empty to use the product-level values. If you enter any override values, complete every required field because this object replaces the product-level set rather than merging with it.",
              fields: shippingMetadataFields(),
            }),
          ],
          preview: {
            select: {
              select: "select",
              price: "price",
              isAvailable: "isAvailable",
              media: "image",
            },
            prepare({ select, price, isAvailable, media }) {
              const parts = Array.isArray(select)
                ? select
                    .map((entry) =>
                      isRecord(entry) ? cleanSchemaString(entry.value) : null,
                    )
                    .filter((value): value is string => value !== null)
                : [];
              const title =
                parts.length > 0 ? parts.join(" / ") : "Combination";
              const amount =
                typeof price === "number"
                  ? `$${price.toFixed(2)}`
                  : "Product price";
              return {
                title,
                subtitle: `${amount}${isAvailable === false ? " · Unavailable" : ""}`,
                media,
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
      name: "stockQuantity",
      title: "Stock on hand",
      type: "number",
      group: "catalog",
      description:
        "Enter the number of units on hand when you receive or restock this product. Changing this number resets the live count; leave blank to sell without tracking stock. For a product with Options, set stock per combination on its Variant Override instead. This is a restock input — the live remaining count is shown on the admin Inventory screen, not here.",
      validation: (Rule) => Rule.integer().min(0),
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
      title: "Shipping, Packing & Customs",
      type: "object",
      group: "shipping",
      description:
        "Controls automated Chit Chats eligibility, package selection, and the customs information sent for cross-border orders. Complete these product-level defaults for every physical product; a variant override can replace the entire set for a single combination.",
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
      name: "detailSections",
      title: "Detail Sections",
      type: "array",
      group: "details",
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({ name: "heading", title: "Heading", type: "string" }),
            defineField({
              name: "body",
              title: "Content",
              type: "array",
              description:
                "Rich text with optional bullet or numbered lists. This is the field to author new content in.",
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
            defineField({
              name: "content",
              title: "Content (legacy plain text)",
              type: "text",
              deprecated: {
                reason:
                  "Use the rich Content field above. Legacy text still renders only when the rich field is empty.",
              },
              // Only surfaces where legacy text already exists, so editors can
              // view or clear it but never author new plain-text content.
              hidden: ({ value }) => !value,
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

const MAX_OPTION_COMBINATIONS = 100;

interface ProductVariantOverrideInput {
  select?: unknown;
  price?: unknown;
  discountPrice?: unknown;
  isAvailable?: unknown;
  shipping?: unknown;
}

interface ProductOverrideDocumentInput {
  options?: unknown;
  price?: unknown;
}

interface ParsedAxes {
  readonly order: string[];
  readonly valuesByAxis: Map<string, Set<string>>;
}

export function validateOptionAxes(options: unknown): true | string {
  if (options === undefined || options === null) return true;
  if (!Array.isArray(options)) return "Options must be an array.";
  if (options.length > 2) return "A product can have at most two options.";

  const seenNames = new Set<string>();

  for (const option of options) {
    if (!isRecord(option)) return "Every option must be an object.";

    const name = normalizeSchemaIdentity(option.name);
    if (!name) return "Every option needs a non-blank name.";
    if (seenNames.has(name)) return "Option names must be unique.";
    seenNames.add(name);

    if (!Array.isArray(option.values) || option.values.length === 0) {
      return `${cleanSchemaString(option.name) ?? "Each option"} needs at least one value.`;
    }

    const seenValues = new Set<string>();
    for (const value of option.values) {
      const normalizedValue = normalizeSchemaIdentity(value);
      if (!normalizedValue) return "Option values cannot be blank.";
      if (seenValues.has(normalizedValue)) {
        return `Values for ${cleanSchemaString(option.name) ?? "an option"} must be unique.`;
      }
      seenValues.add(normalizedValue);
    }
  }

  return true;
}

export function validateVariantOverrides(
  overridesInput: unknown,
  documentInput: unknown,
): true | string {
  if (overridesInput === undefined || overridesInput === null) return true;
  if (!Array.isArray(overridesInput))
    return "Variant overrides must be an array.";
  if (overridesInput.length === 0) return true;

  const document = isRecord(documentInput)
    ? (documentInput as ProductOverrideDocumentInput)
    : {};

  // If the options themselves are invalid, that field surfaces the error; don't
  // pile a second, confusing message onto the overrides field.
  if (validateOptionAxes(document.options) !== true) return true;

  const axes = parseAxes(document.options);
  if (axes.order.length === 0) {
    return "Add product Options before defining variant overrides.";
  }

  const seenTargets = new Set<string>();

  for (const overrideInput of overridesInput) {
    if (!isRecord(overrideInput)) return "Every override must be an object.";
    const override = overrideInput as ProductVariantOverrideInput;

    if (!Array.isArray(override.select)) {
      return "Every override must pin a combination.";
    }

    const selection = new Map<string, string>();
    for (const entry of override.select) {
      if (!isRecord(entry)) return "Every combination row must be an object.";
      const name = normalizeSchemaIdentity(entry.name);
      const value = normalizeSchemaIdentity(entry.value);
      if (!name || !value) {
        return "Combination rows need both an option and a value.";
      }
      const axisValues = axes.valuesByAxis.get(name);
      if (!axisValues) {
        return `${cleanSchemaString(entry.name) ?? "An override"} does not match any product option.`;
      }
      if (!axisValues.has(value)) {
        return `${cleanSchemaString(entry.value) ?? "A value"} is not a valid value for ${cleanSchemaString(entry.name) ?? "that option"}.`;
      }
      if (selection.has(name)) {
        return "An override combination cannot repeat the same option.";
      }
      selection.set(name, value);
    }

    if (selection.size !== axes.order.length) {
      return "Each override must pin exactly one full combination (one value per option).";
    }

    const target = JSON.stringify(
      [...selection.entries()].sort(([left], [right]) =>
        compareCodePoints(left, right),
      ),
    );
    if (seenTargets.has(target)) {
      return "Two overrides target the same combination.";
    }
    seenTargets.add(target);

    // An override without its own price inherits the product price, so compare
    // the discount against whichever price the combination will actually use.
    const effectivePrice =
      toSchemaCents(override.price) ?? toSchemaCents(document.price);
    const discount = toSchemaCents(override.discountPrice);
    if (
      typeof effectivePrice === "number" &&
      typeof discount === "number" &&
      discount >= effectivePrice
    ) {
      return "An override discount price must be lower than its effective price.";
    }
  }

  const combinationCount = axes.order.reduce(
    (count, axis) => count * (axes.valuesByAxis.get(axis)?.size ?? 0),
    1,
  );
  if (combinationCount > MAX_OPTION_COMBINATIONS) {
    return `Options cannot create more than ${MAX_OPTION_COMBINATIONS} purchasable combinations.`;
  }

  return true;
}

function parseAxes(options: unknown): ParsedAxes {
  const order: string[] = [];
  const valuesByAxis = new Map<string, Set<string>>();
  if (!Array.isArray(options)) return { order, valuesByAxis };

  for (const option of options) {
    if (!isRecord(option)) continue;
    const name = normalizeSchemaIdentity(option.name);
    if (!name || valuesByAxis.has(name)) continue;

    const values = new Set<string>();
    if (Array.isArray(option.values)) {
      for (const value of option.values) {
        const normalizedValue = normalizeSchemaIdentity(value);
        if (normalizedValue) values.add(normalizedValue);
      }
    }
    order.push(name);
    valuesByAxis.set(name, values);
  }

  return { order, valuesByAxis };
}

function toSchemaCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const cents = Math.round(value * 100);
  return Math.abs(value - cents / 100) < 1e-9 ? cents : null;
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

export function validateProductCheckoutConfiguration(
  documentInput: unknown,
): true | string {
  if (!isRecord(documentInput) || documentInput.isAvailable !== true)
    return true;

  const productShipping = isRecord(documentInput.shipping)
    ? (documentInput.shipping as unknown as TProductShippingMetadata)
    : undefined;

  const overrides = Array.isArray(documentInput.variantOverrides)
    ? documentInput.variantOverrides.filter(isRecord)
    : [];

  // The product-level shipping covers every combination that has no shipping
  // override, so it must be valid whenever the product is purchasable.
  const entries: Array<{ label: string; metadata?: TProductShippingMetadata }> =
    [{ label: "Product", metadata: productShipping }];

  for (const override of overrides) {
    if (override.isAvailable === false) continue;
    if (!hasShippingOverride(override.shipping)) continue;
    entries.push({
      label: overrideLabel(override.select),
      metadata: override.shipping as unknown as TProductShippingMetadata,
    });
  }

  for (const entry of entries) {
    const eligibility = getProductCheckoutEligibility(entry.metadata);
    if (eligibility.status === "invalid") {
      return `${entry.label} cannot be available for checkout until its fulfillment metadata is complete (${eligibility.reason}).`;
    }
    if (
      entry.metadata?.usShippingApproved &&
      getProductCheckoutEligibility(entry.metadata, "US").status === "invalid"
    ) {
      const usEligibility = getProductCheckoutEligibility(entry.metadata, "US");
      return `${entry.label} cannot be approved for U.S. checkout until all U.S. customs and manufacturer metadata is complete${
        usEligibility.status === "invalid" ? ` (${usEligibility.reason})` : ""
      }.`;
    }
  }

  return true;
}

function overrideLabel(select: unknown): string {
  if (!Array.isArray(select)) return "An override";
  const parts = select
    .map((entry) => (isRecord(entry) ? cleanSchemaString(entry.value) : null))
    .filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join(" / ") : "An override";
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

function shippingMetadataFields() {
  return [
    defineField({
      name: "fulfillmentMode",
      title: "Fulfillment Method",
      type: "string",
      initialValue: "physical",
      description:
        "Choose “Ship with Chit Chats” only when this item can use automated checkout and all required packing and customs details below are complete. Choose “Manual fulfillment only” for pickup, digital items, regulated goods, or anything staff must quote and arrange outside the automated shipping flow.",
      options: {
        list: [
          { title: "Ship with Chit Chats", value: "physical" },
          { title: "Manual fulfillment only", value: "manual" },
        ],
        layout: "radio",
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "weightGrams",
      title: "Per-Item Product Weight (g)",
      type: "number",
      description:
        "Enter the weight of one sellable unit before adding the mailer or box. Checkout multiplies this value by the cart quantity, then adds the selected package profile’s empty-package weight. Example: enter 35 when one lash tray weighs 35 g.",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "lengthCm",
      title: "Item Length (cm)",
      type: "number",
      description:
        "Longest side of one sellable unit in centimetres, measured as it will be packed. Checkout uses the item’s length, width, and height to pick the smallest box that fits. Round up to the next whole centimetre. Example: enter 12 for a 12 cm lash tray.",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "widthCm",
      title: "Item Width (cm)",
      type: "number",
      description:
        "Second side of one sellable unit in centimetres. See “Item Length” for how the three dimensions are used together.",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "heightCm",
      title: "Item Height / Thickness (cm)",
      type: "number",
      description:
        "Shortest side (thickness) of one sellable unit in centimetres. When several units ship together they are stacked on this axis to check box fit.",
      validation: (Rule) => Rule.integer().min(1),
    }),
    defineField({
      name: "isRigid",
      title: "Rigid / Non-Bendable Item?",
      type: "boolean",
      initialValue: true,
      description:
        "Leave on for hard items that cannot bend (lash trays, tweezers, boxed products) so checkout only chooses a rigid-capable package. Turn off only for soft, flexible items that could safely ship in a bendable mailer.",
    }),
    defineField({
      name: "customsDescription",
      title: "Plain-Language Customs Item Description",
      type: "string",
      description:
        "Describe what one unit physically is for the customs declaration. Be specific, factual, and generic rather than using only a brand or product collection name. Example: “Synthetic eyelash extensions” is clearer than “Lash Her product” or “beauty item.”",
    }),
    defineField({
      name: "countryOfOrigin",
      title: "Country Where the Item Was Made",
      type: "string",
      description:
        "Enter the uppercase two-letter country code for where the product was manufactured—not where it is stored or shipped from. Examples: CA for Canada or KR for South Korea.",
      validation: (Rule) =>
        Rule.regex(/^[A-Z]{2}$/, { name: "ISO country code" }),
    }),
    defineField({
      name: "usShippingApproved",
      title: "Allow This Item in U.S. Checkout",
      type: "boolean",
      initialValue: false,
      description:
        "Enable only after the U.S. tariff classification and all manufacturer fields below have been reviewed for this item. When disabled, checkout will not quote U.S. delivery for carts containing it. U.S. quoting must also be enabled globally, so this setting never enables the destination by itself.",
    }),
    defineField({
      name: "hsTariffCode",
      title: "U.S. HTS Tariff Code (10 Digits)",
      type: "string",
      description:
        "Enter the item’s verified 10-digit U.S. Harmonized Tariff Schedule classification with no dots or spaces. For example, a code written as 1234.56.7890 would be entered as 1234567890; this number demonstrates formatting only and is not a classification to copy. Confirm the actual code with the manufacturer or a qualified trade source.",
      validation: (Rule) =>
        Rule.regex(/^\d{10}$/, { name: "10-digit HTS code" }),
    }),
    defineField({
      name: "manufacturerName",
      title: "Manufacturer’s Legal Name",
      type: "string",
      description:
        "Enter the legal name of the company that made the item, not the retailer or distributor unless it is also the manufacturer. Example: “ABC Lashes Co., Ltd.”",
    }),
    defineField({
      name: "manufacturerAddress",
      title: "Manufacturer’s Street Address",
      type: "text",
      description:
        "Enter the manufacturing facility’s street address only; city, province or state, postal code, and country have separate fields below. Example: “123 Export Road, Building 4.”",
    }),
    defineField({
      name: "manufacturerCity",
      title: "Manufacturer’s City",
      type: "string",
      description:
        "Enter the city or municipality in the manufacturer’s address. Example: “Seoul” or “Toronto.”",
    }),
    defineField({
      name: "manufacturerProvinceCode",
      title: "Manufacturer’s Province or State Code",
      type: "string",
      description:
        "Enter the recognized province, state, or regional abbreviation for the manufacturer’s address. Examples: ON for Ontario or CA for California. Use the format supplied by the manufacturer for countries with different regional-code systems.",
    }),
    defineField({
      name: "manufacturerPostalCode",
      title: "Manufacturer’s Postal or ZIP Code",
      type: "string",
      description:
        "Enter the postal or ZIP code exactly as used in the manufacturer’s address. Examples: M5V 2T6 for Canada or 90001 for the United States.",
    }),
    defineField({
      name: "manufacturerCountryCode",
      title: "Manufacturer’s Country (2-Letter Code)",
      type: "string",
      description:
        "Enter the uppercase two-letter country code for the manufacturer’s address. This is usually the same as Country Where the Item Was Made, but it must describe the manufacturer contact address. Examples: CA for Canada or KR for South Korea.",
      validation: (Rule) =>
        Rule.regex(/^[A-Z]{2}$/, { name: "ISO country code" }),
    }),
    defineField({
      name: "usRegulatoryCertification",
      title: "U.S. SKU Regulatory Certification",
      type: "object",
      description:
        "Record the evidence-backed regulatory review for this exact SKU or variant. Checkout verifies this record against the active certified U.S. shipping contract and blocks expired or mismatched reviews; never estimate tariff composition values.",
      fields: [
        defineField({
          name: "version",
          title: "Certification Version",
          type: "string",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "usShippingContractVersion",
          title: "Certified U.S. Shipping Contract Version",
          type: "string",
          description:
            "Enter the exact active U.S. shipping contract version against which this SKU was reviewed.",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "tariffMetadataSchemaVersion",
          title: "Tariff Metadata Schema Version",
          type: "string",
          description:
            "Enter the exact tariff metadata schema version recorded in the certified U.S. shipping contract.",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "fdaRequirementsVersion",
          title: "FDA Requirements Version",
          type: "string",
          description:
            "Enter the exact FDA requirements version recorded in the certified U.S. shipping contract.",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "evidenceReference",
          title: "Evidence Reference",
          type: "string",
          description:
            "Reference the controlled manufacturer, broker, or provider evidence used for this SKU review. Do not paste secrets or customer data.",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "reviewedAt",
          title: "Reviewed At",
          type: "datetime",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "validUntil",
          title: "Valid Until",
          type: "datetime",
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "additionalTariffApplicability",
          title: "Additional Metal Tariff Applicability",
          type: "string",
          options: {
            layout: "radio",
            list: [
              {
                title: "Not applicable under reviewed HTS",
                value: "not_applicable",
              },
              { title: "Explicit composition required", value: "required" },
            ],
          },
          validation: (Rule) => Rule.required(),
        }),
        defineField({
          name: "additionalTariffDetails",
          title: "Certified Metal Composition Percentages",
          type: "object",
          description:
            "Enter only evidence-backed percentages required by the active provider contract. Explicit zero is valid; blank values are never interpreted as zero.",
          hidden: ({ parent }) =>
            parent?.additionalTariffApplicability !== "required",
          fields: ["steel", "copper", "aluminum"].map((name) =>
            defineField({
              name,
              title: `${name[0]?.toUpperCase()}${name.slice(1)} (%)`,
              type: "number",
              validation: (Rule) => Rule.required().integer().min(0).max(100),
            }),
          ),
        }),
        defineField({
          name: "fdaApplicability",
          title: "FDA Prior Notice Applicability",
          type: "string",
          description:
            "Record whether FDA prior-notice assessment is inapplicable or is performed by the certified provider. This does not invent or send an unsupported FDA request field.",
          options: {
            layout: "radio",
            list: [
              { title: "Not applicable", value: "not_applicable" },
              { title: "Provider assessed", value: "provider_assessed" },
            ],
          },
          validation: (Rule) => Rule.required(),
        }),
      ],
    }),
    defineField({
      name: "hazardousMaterial",
      title: "Contains Regulated or Hazardous Material",
      type: "boolean",
      initialValue: false,
      description:
        "Enable for items that may be regulated in transport, such as flammable adhesives or liquids, aerosols, lithium batteries, or pressurized containers. Any item marked Yes is blocked from automated Chit Chats quoting and requires manual fulfillment. Leave No only after confirming the product is not regulated for transport.",
    }),
  ];
}
