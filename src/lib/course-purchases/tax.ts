import "server-only";

import { createHash } from "node:crypto";
import * as v from "valibot";
import { PurchaseDependencyError } from "./course-api";
import type { CourseBilling } from "./schema";

const boundedText = (limit: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(limit),
    v.regex(/^[^\u0000-\u001f\u007f]+$/u),
  );
const country = v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u));
const region = v.pipe(v.string(), v.regex(/^[A-Z0-9-]{1,12}$/u));
const taxCode = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
);
const zeroReason = v.picklist(["product_exempt", "zero_rated", "reduced_rated"]);
const cents = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2_147_483_647),
);
const partsPerMillion = 1_000_000;
const componentFields = {
  taxCode,
  label: boundedText(80),
  ratePartsPerMillion: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(partsPerMillion),
  ),
  registrationNumber: v.optional(boundedText(80)),
};
const componentSnapshot = v.object({ ...componentFields, amount: cents });
const componentRule = v.pipe(
  v.strictObject({ ...componentFields, zeroReason: v.optional(zeroReason) }),
  v.check((rule) =>
    rule.ratePartsPerMillion === 0
      ? rule.zeroReason !== undefined
      : rule.zeroReason === undefined && rule.registrationNumber !== undefined,
  ),
);
const uniqueTaxCodes = (components: { taxCode: string }[]) =>
  new Set(components.map(({ taxCode }) => taxCode)).size === components.length;

export function readCourseTaxComponents(taxBreakdown: unknown[]) {
  const result = v.safeParse(
    v.pipe(
      v.array(componentSnapshot),
      v.check((components) => uniqueTaxCodes(components)),
    ),
    taxBreakdown,
  );
  return result.success ? result.output : [];
}

const rateRule = v.pipe(
  v.strictObject({
    taxCode,
    rateBasisPoints: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10000)),
    zeroReason: v.optional(zeroReason),
  }),
  v.check((rule) => (rule.rateBasisPoints === 0) === (rule.zeroReason !== undefined)),
);
export const courseBillingSchema = v.strictObject({
  name: boundedText(160),
  line1: boundedText(200),
  city: boundedText(100),
  region,
  postalCode: boundedText(20),
  country,
});
const legacyPolicySchema = v.strictObject({
  version: boundedText(100),
  markets: v.pipe(
    v.array(
      v.strictObject({
        country,
        region,
        disclosure: boundedText(2000),
        behavior: v.picklist(["inclusive", "exclusive"]),
        classifications: v.pipe(
          v.record(
            v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u)),
            v.union([
              rateRule,
              v.strictObject({
                taxCode: v.pipe(v.string(), v.regex(/^txcd_[0-9]{8}$/u)),
                zeroReasons: v.optional(v.array(zeroReason)),
              }),
            ]),
          ),
          v.check((entries) => Object.keys(entries).length > 0),
        ),
      }),
    ),
    v.minLength(1),
  ),
});

// Canada Post's Forward Sortation Areas. The two territories that share X
// use distinct three-character prefixes.
const canadianPostalRegions: Record<string, RegExp | undefined> = {
  AB: /^T/u,
  BC: /^V/u,
  MB: /^R/u,
  NB: /^E/u,
  NL: /^A/u,
  NS: /^B/u,
  NT: /^(?:X0[EG]|X1A)/u,
  NU: /^X0[ABC]/u,
  ON: /^[KLMNP]/u,
  PE: /^C/u,
  QC: /^[GHJ]/u,
  SK: /^S/u,
  YT: /^Y/u,
};
const purchaseTermsSchema = v.strictObject({
  version: boundedText(100),
  text: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(12_000),
    v.regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]+$/u),
  ),
});
const componentPolicySchema = v.strictObject({
  formatVersion: v.literal(2),
  version: boundedText(100),
  effectiveAt: v.pipe(
    v.string(),
    v.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
    v.check((value) => {
      const instant = new Date(value);
      return (
        Number.isFinite(instant.getTime()) &&
        instant.toISOString() === value.replace("Z", ".000Z")
      );
    }),
  ),
  square: v.strictObject({
    environment: v.picklist(["sandbox", "production"]),
    applicationId: boundedText(100),
    locationId: boundedText(100),
  }),
  seller: v.strictObject({
    name: boundedText(160),
    address: boundedText(300),
    email: v.pipe(boundedText(254), v.email()),
    phone: v.optional(v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(33),
      v.regex(/^(?:\+?\d|\(\d{3}\))[() .\d-]*$/u),
      v.check((value) => value.replace(/\D/gu, "").length >= 7),
    )),
  }),
  markets: v.pipe(
    v.array(v.strictObject({
      country: v.literal("CA"),
      region: v.picklist(Object.keys(canadianPostalRegions)),
      behavior: v.literal("exclusive"),
      disclosure: boundedText(2000),
      terms: v.optional(purchaseTermsSchema),
      classifications: v.pipe(
        v.record(taxCode, v.strictObject({
          taxCode,
          components: v.pipe(
            v.array(componentRule),
            v.minLength(1),
            v.maxLength(10),
            v.check((components) => uniqueTaxCodes(components)),
          ),
        })),
        v.check((entries) => Object.keys(entries).length > 0),
      ),
    })),
    v.minLength(1),
    v.check((markets) =>
      new Set(markets.map(({ region }) => region)).size === markets.length,
    ),
  ),
});

function readCourseSalesPolicy() {
  const value = process.env.COURSE_SALES_POLICY;
  if (!value) throw new PurchaseDependencyError(503);
  try {
    const policy = v.parse(
      v.union([componentPolicySchema, legacyPolicySchema]),
      JSON.parse(value),
    );
    if ("formatVersion" in policy) {
      if (
        Date.parse(policy.effectiveAt) > Date.now() ||
        policy.square.environment !== process.env.SQUARE_ENVIRONMENT ||
        policy.square.applicationId !== process.env.SQUARE_APPLICATION_ID ||
        policy.square.locationId !== process.env.SQUARE_LOCATION_ID
      )
        throw new PurchaseDependencyError(503);
      // D1 includes conditional Québec. Keep it closed on this candidate until
      // the approved Québec evidence and agreement presentation are implemented.
      if (policy.square.environment === "production" &&
        policy.markets.some((market) => market.region !== "ON" || !market.terms))
        throw new PurchaseDependencyError(503);
    } else if (
      process.env.SQUARE_ENVIRONMENT === "production" ||
      (process.env.SQUARE_ENVIRONMENT !== "sandbox" &&
        policy.markets.some((market) =>
          Object.values(market.classifications).some((rule) => "rateBasisPoints" in rule),
        ))
    ) {
      throw new PurchaseDependencyError(503);
    }
    return policy;
  } catch {
    throw new PurchaseDependencyError(503);
  }
}

export function getCourseSalesPolicy(
  billing: CourseBilling,
  classification: string,
) {
  const policy = readCourseSalesPolicy();
  const matches = policy.markets.filter(
    (item) =>
      item.country === billing.country && item.region === billing.region,
  );
  const market = matches[0];
  if (
    matches.length !== 1 ||
    !market ||
    !Object.hasOwn(market.classifications, classification)
  )
    throw new PurchaseDependencyError(
      422,
      "This billing destination or course is unavailable for checkout.",
    );
  const postal = billing.postalCode.toUpperCase().replaceAll(" ", "");
  if (
    (billing.country === "CA" &&
      !/^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/u.test(postal)) ||
    (billing.country === "US" && !/^[0-9]{5}(?:-[0-9]{4})?$/u.test(postal))
  )
    throw new PurchaseDependencyError(
      422,
      "Enter a valid billing postal code.",
    );
  if (
    "formatVersion" in policy &&
    !canadianPostalRegions[market.region]?.test(postal)
  )
    throw new PurchaseDependencyError(
      422,
      "Check that the billing postal code matches your province or territory.",
    );
  return {
    version: policy.version,
    hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    disclosure: market.disclosure,
    behavior: market.behavior,
    receiptSeller: "seller" in policy ? policy.seller : undefined,
    purchaseTerms: "terms" in market ? market.terms : undefined,
    ...market.classifications[classification],
  };
}

export function courseTaxReady() {
  try {
    const policy = readCourseSalesPolicy();
    return (
      "formatVersion" in policy ||
      policy.markets.every((market) =>
        Object.values(market.classifications).every(
          (rule) => "rateBasisPoints" in rule,
        ),
      ) || Boolean(process.env.COURSE_STRIPE_TAX_SECRET_KEY)
    );
  } catch {
    return false;
  }
}

export const rateTableTaxReference = (orderId: string) => `rate-table:${orderId}`;

function roundRatio(amount: number, numerator: number, denominator: number) {
  const divisor = BigInt(denominator);
  const twice = BigInt(2);
  return Number(
    (BigInt(amount) * BigInt(numerator) * twice + divisor) / (divisor * twice),
  );
}

export function rateTableRefundTax(
  taxCents: number,
  totalCents: number,
  previousRefunds: number,
  currentRefund: number,
) {
  const refunded = previousRefunds + currentRefund;
  if (
    totalCents <= 0 ||
    taxCents < 0 ||
    taxCents > totalCents ||
    previousRefunds < 0 ||
    currentRefund <= 0 ||
    refunded > totalCents
  )
    throw new PurchaseDependencyError(502);
  return roundRatio(refunded, taxCents, totalCents) -
    roundRatio(previousRefunds, taxCents, totalCents);
}

const calculationSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^taxcalc_[A-Za-z0-9_-]+$/u)),
  currency: v.literal("cad"),
  amount_total: cents,
  tax_amount_exclusive: cents,
  tax_amount_inclusive: cents,
  expires_at: v.pipe(v.number(), v.integer(), v.minValue(1)),
  tax_breakdown: v.array(
    v.object({
      amount: cents,
      taxability_reason: v.string(),
      jurisdiction: v.optional(
        v.nullable(
          v.object({
            country: v.optional(v.string()),
            state: v.optional(v.nullable(v.string())),
          }),
        ),
      ),
    }),
  ),
});
const transactionSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^tax_[A-Za-z0-9_-]+$/u)),
  currency: v.literal("cad"),
  reference: v.string(),
});

async function stripeTax(
  path: string,
  fields: Record<string, string>,
  key: string,
) {
  const secret = process.env.COURSE_STRIPE_TAX_SECRET_KEY;
  if (!secret) throw new PurchaseDependencyError(503);
  const response = await fetch(`https://api.stripe.com/v1/tax/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "idempotency-key": key,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new PurchaseDependencyError(response.status);
  return (await response.json()) as unknown;
}

export async function calculateCourseTax(
  orderId: string,
  priceCents: number,
  billing: CourseBilling,
  policy: ReturnType<typeof getCourseSalesPolicy>,
) {
  if ("components" in policy) {
    const taxBreakdown = policy.components.map(
      ({ zeroReason, ...component }) => ({
        ...component,
        amount: roundRatio(priceCents, component.ratePartsPerMillion, partsPerMillion),
        taxability_reason: zeroReason ?? "standard_rated",
        jurisdiction: { country: billing.country, state: billing.region },
      }),
    );
    const taxCents = taxBreakdown.reduce((sum, { amount }) => sum + amount, 0);
    const totalCents = priceCents + taxCents;
    if (totalCents > 2_147_483_647)
      throw new PurchaseDependencyError(
        422,
        "Tax could not be confirmed for this order.",
      );
    return {
      totalCents,
      taxCents,
      taxBreakdown,
      taxCalculation: rateTableTaxReference(orderId),
      quoteExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  if ("rateBasisPoints" in policy) {
    const taxCents = roundRatio(
      priceCents,
      policy.rateBasisPoints,
      policy.behavior === "inclusive" ? 10000 + policy.rateBasisPoints : 10000,
    );
    const totalCents =
      policy.behavior === "exclusive" ? priceCents + taxCents : priceCents;
    if (totalCents > 2_147_483_647)
      throw new PurchaseDependencyError(
        422,
        "Tax could not be confirmed for this order.",
      );
    return {
      totalCents,
      taxCents,
      taxBreakdown: [
        {
          amount: taxCents,
          taxability_reason: policy.zeroReason ?? "standard_rated",
          jurisdiction: { country: billing.country, state: billing.region },
          rate_basis_points: policy.rateBasisPoints,
        },
      ],
      taxCalculation: rateTableTaxReference(orderId),
      quoteExpiresAt: new Date(Date.now() + 10 * 60_000),
    };
  }

  const calculation = v.parse(
    calculationSchema,
    await stripeTax(
      "calculations",
      {
        currency: "cad",
        "line_items[0][amount]": String(priceCents),
        "line_items[0][reference]": orderId,
        "line_items[0][tax_code]": policy.taxCode,
        "line_items[0][tax_behavior]": policy.behavior,
        "customer_details[address_source]": "billing",
        "customer_details[address][line1]": billing.line1,
        "customer_details[address][city]": billing.city,
        "customer_details[address][state]": billing.region,
        "customer_details[address][postal_code]": billing.postalCode,
        "customer_details[address][country]": billing.country,
      },
      `course-quote-${orderId}`,
    ),
  );
  const taxCents =
    calculation.tax_amount_exclusive + calculation.tax_amount_inclusive;
  const total =
    policy.behavior === "exclusive" ? priceCents + taxCents : priceCents;
  if (
    total !== calculation.amount_total ||
    calculation.tax_breakdown.some(({ jurisdiction }) =>
      Boolean(
        jurisdiction?.country &&
        jurisdiction.country.toUpperCase() !== billing.country,
      ),
    ) ||
    (policy.behavior === "exclusive"
      ? calculation.tax_amount_inclusive !== 0
      : calculation.tax_amount_exclusive !== 0) ||
    taxCents > total ||
    calculation.expires_at * 1000 <= Date.now() ||
    (taxCents === 0 &&
      (!calculation.tax_breakdown.length ||
        calculation.tax_breakdown.some(
          ({ taxability_reason }) =>
            !policy.zeroReasons?.some((reason) => reason === taxability_reason),
        )))
  )
    throw new PurchaseDependencyError(
      422,
      "Tax could not be confirmed for this order.",
    );
  return {
    totalCents: total,
    taxCents,
    taxBreakdown: calculation.tax_breakdown,
    taxCalculation: calculation.id,
    quoteExpiresAt: new Date(
      Math.min(calculation.expires_at * 1000, Date.now() + 10 * 60_000),
    ),
  };
}

export async function recordCourseTax(calculation: string, key: string) {
  const result = v.parse(
    transactionSchema,
    await stripeTax(
      "transactions/create_from_calculation",
      {
        calculation,
        reference: key,
      },
      key,
    ),
  );
  if (result.reference !== key) throw new PurchaseDependencyError(502);
  return result.id;
}

export async function reverseCourseTax(
  transaction: string,
  amount: number,
  key: string,
) {
  const result = v.parse(
    transactionSchema,
    await stripeTax(
      "transactions/create_reversal",
      {
        mode: "partial",
        original_transaction: transaction,
        flat_amount: String(-amount),
        reference: key,
      },
      key,
    ),
  );
  if (result.reference !== key) throw new PurchaseDependencyError(502);
  return result.id;
}
