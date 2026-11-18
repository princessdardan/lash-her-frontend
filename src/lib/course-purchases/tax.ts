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
export const courseBillingSchema = v.strictObject({
  name: boundedText(160),
  line1: boundedText(200),
  city: boundedText(100),
  region,
  postalCode: boundedText(20),
  country,
});
const policySchema = v.strictObject({
  version: boundedText(100),
  markets: v.pipe(
    v.array(
      v.strictObject({
        country,
        region,
        disclosure: boundedText(2000),
        behavior: v.picklist(["inclusive", "exclusive"]),
        classifications: v.record(
          v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u)),
          v.strictObject({
            taxCode: v.pipe(v.string(), v.regex(/^txcd_[0-9]{8}$/u)),
            zeroReasons: v.optional(
              v.array(
                v.picklist(["product_exempt", "zero_rated", "reduced_rated"]),
              ),
            ),
          }),
        ),
      }),
    ),
    v.minLength(1),
  ),
});

export function getCourseSalesPolicy(
  billing: CourseBilling,
  classification: string,
) {
  const value = process.env.COURSE_SALES_POLICY;
  if (!value) throw new PurchaseDependencyError(503);
  let policy: v.InferOutput<typeof policySchema>;
  try {
    policy = v.parse(policySchema, JSON.parse(value));
  } catch {
    throw new PurchaseDependencyError(503);
  }
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
  return {
    version: policy.version,
    hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    disclosure: market.disclosure,
    behavior: market.behavior,
    ...market.classifications[classification],
  };
}

export function courseTaxReady() {
  return Boolean(
    process.env.COURSE_SALES_POLICY && process.env.COURSE_STRIPE_TAX_SECRET_KEY,
  );
}

const cents = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2_147_483_647),
);
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
