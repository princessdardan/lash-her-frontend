import "server-only";

import { createHash } from "node:crypto";

import { PRODUCT_TAX_POLICY_VERSION } from "@/lib/commerce/product-tax-policy";
import { getPrivateDb } from "@/lib/private-db/client";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  ProductTaxPolicyApprovalSnapshot,
} from "@/lib/private-db/schema";
export type { ProductTaxPolicyApprovalSnapshot } from "@/lib/private-db/schema";

import { getChitChatsConfig, isChitChatsCheckoutEnabled } from "./config";
import {
  buildConfiguredQuoteContext,
  configuredTaxPolicyApproval,
} from "./configured-quote-context";
import {
  PRODUCT_MANUAL_CANCELLATION_POLICY,
  PRODUCT_SHIPPING_POLICY_VERSION,
  PRODUCT_SHIPPING_US_DDU_CONTRACT,
} from "./product-shipping-config";
import type { ShippingQuoteContext } from "./quote-token";

export { calendarCoverageComplete } from "./calendar-validation";
export { REQUIRED_PRIVATE_SCHEMA_MIGRATION_AT } from "./readiness-schema";

/**
 * Config-driven checkout readiness (Phase 2).
 *
 * Readiness is now "the feature is enabled, the runtime is securely configured,
 * and the source-controlled shipping/tax config is present" — not a set of
 * owner-attested, step-up-certified, versioned DB records. Change-detection
 * between quote and checkout-commit is version-based (`policyVersion` /
 * `taxPolicyVersion`): config changes bump those versions, which is the correct
 * signal for source-controlled policy and avoids brittle deep-equality on
 * `now`-dependent fields.
 */

type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export interface CheckoutReadinessResult {
  ready: boolean;
  blockers: string[];
  policyVersion: string | null;
  taxPolicyApproval: ProductTaxPolicyApprovalSnapshot | null;
  taxPolicyVersion: string | null;
  calendarVersionId: string | null;
  quoteContext: ShippingQuoteContext | null;
}

export async function evaluateCheckoutReadiness(input: {
  admission?: boolean;
  destinationCountryCode: "CA" | "US";
  now?: Date;
}): Promise<CheckoutReadinessResult> {
  const now = input.now ?? new Date();
  const env = process.env;
  const blockers: string[] = [];

  if (input.admission !== false && !isChitChatsCheckoutEnabled()) {
    blockers.push("checkout_flag_disabled");
  }
  // Checkout readiness is intentionally NOT coupled to the shipping-policy
  // worker's enforcement mode. Post-sale policy adherence (deadlines, refunds,
  // loss/claim handling) runs independently in the background worker/cron and
  // must never be able to halt a customer sale — e.g. a failed durable policy
  // job going to manual review, or the worker being paused, previously stopped
  // all checkout via a `policy_not_enforced` blocker. The worker/cron still gate
  // their own enforcement on the mode; they no longer hold checkout hostage.
  if (!canonicalHttpsOrigin(env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  for (const name of [
    "AUTH_SECRET",
    "CHITCHATS_QUOTE_SIGNING_SECRET",
    "CHITCHATS_WORKER_CRON_SECRET",
    "SHIPPING_DECISION_TOKEN_SECRET",
    "ADDRESS_CHANGE_TOKEN_SECRET",
  ]) {
    if (!isStrongSecret(env[name])) blockers.push(`secret_invalid:${name}`);
  }
  addFinancialRuntimeBlockers(blockers, env);

  let config: ReturnType<typeof getChitChatsConfig> | null = null;
  try {
    config = getChitChatsConfig();
  } catch {
    blockers.push("chitchats_configuration_invalid");
  }
  if (input.destinationCountryCode === "US") {
    if (!config?.usShippingEnabled) blockers.push("us_checkout_disabled");
    if (!PRODUCT_SHIPPING_US_DDU_CONTRACT) {
      blockers.push("us_shipping_contract_unavailable");
    }
  }

  const quoteContext =
    blockers.length === 0 && config
      ? buildConfiguredQuoteContext({
          destinationCountryCode: input.destinationCountryCode,
          region: config.region,
          usShippingContract:
            input.destinationCountryCode === "US"
              ? PRODUCT_SHIPPING_US_DDU_CONTRACT
              : null,
          now,
        })
      : null;

  return {
    ready: blockers.length === 0,
    blockers,
    policyVersion: quoteContext ? PRODUCT_SHIPPING_POLICY_VERSION : null,
    taxPolicyApproval: quoteContext ? quoteContext.taxPolicyApproval : null,
    taxPolicyVersion: quoteContext ? PRODUCT_TAX_POLICY_VERSION : null,
    calendarVersionId: quoteContext ? PRODUCT_SHIPPING_POLICY_VERSION : null,
    quoteContext,
  };
}

export async function assertCheckoutReadiness(input: {
  destinationCountryCode: "CA" | "US";
}): Promise<CheckoutReadinessResult> {
  const result = await evaluateCheckoutReadiness(input);
  if (!result.ready) throw new CheckoutNotReadyError(result.blockers);
  return result;
}

export async function assertShippingQuoteContextCurrent(input: {
  destinationCountryCode?: "CA" | "US";
  expectedContext?: ShippingQuoteContext | null;
  now?: Date;
}): Promise<ShippingQuoteContext | null> {
  const now = input.now ?? new Date();
  if (input.expectedContext && input.destinationCountryCode) {
    if (!quoteContextVersionsCurrent(input.expectedContext)) {
      throw new CheckoutNotReadyError(["shipping_quote_context_changed"]);
    }
    const readiness = await evaluateCheckoutReadiness({
      admission: false,
      destinationCountryCode: input.destinationCountryCode,
      now,
    });
    if (!readiness.quoteContext) {
      throw new CheckoutNotReadyError(
        readiness.blockers.length
          ? readiness.blockers
          : ["shipping_quote_context_changed"],
      );
    }
    return readiness.quoteContext;
  }
  return null;
}

export async function assertUsShippingContractCurrent(input: {
  // `now` is accepted for caller compatibility but no longer used: the U.S. DDU
  // contract's effective window (effectiveFrom/effectiveUntil) is managed
  // outside this storefront and is not enforced at checkout. The contract must
  // still match the source-controlled config exactly (integrity), and its import
  // terms must be DDU.
  snapshot: FulfillmentProviderCertificationContractSnapshot | null;
  now?: Date;
}): Promise<void> {
  const snapshot = input.snapshot;
  const configured = PRODUCT_SHIPPING_US_DDU_CONTRACT;
  if (
    !configured ||
    snapshot?.importTerms !== "DDU" ||
    stableReadinessJson(snapshot) !== stableReadinessJson(configured)
  ) {
    throw new CheckoutNotReadyError(["us_shipping_contract_changed"]);
  }
}

export async function assertShippingQuoteContextAtCheckoutCommit(
  tx: PrivateDbTransaction,
  input: {
    destinationCountryCode: "CA" | "US";
    expectedContext: ShippingQuoteContext;
    now?: Date;
  },
): Promise<CheckoutReadinessResult> {
  await lockShippingCheckoutReadinessConfiguration(tx);
  const readiness = await evaluateCheckoutReadiness({
    destinationCountryCode: input.destinationCountryCode,
    now: input.now,
  });
  // Policy/tax version drift between quote and commit no longer blocks the sale
  // (owner directive): a mid-flight config-version bump must not reject an
  // in-flight checkout. Runtime config/payment/secret readiness is still
  // enforced so we never commit an order the payment configuration can't
  // support. The order is stamped with the CURRENT config versions from
  // `readiness` so post-sale fulfillment keys off a coherent context.
  if (!readiness.ready || !readiness.quoteContext) {
    throw new CheckoutNotReadyError(
      readiness.blockers.length
        ? readiness.blockers
        : ["shipping_quote_context_changed"],
    );
  }
  return readiness;
}

// Config is source-controlled and cannot change within a transaction, so no
// table locks are required. Retained for call-site compatibility.
export async function lockShippingCheckoutReadinessConfiguration(
  _tx: PrivateDbTransaction,
): Promise<void> {}

export async function assertProductTaxPolicyApprovalInTransaction(
  _tx: PrivateDbTransaction,
  expected: ProductTaxPolicyApprovalSnapshot,
  _now = new Date(),
): Promise<ProductTaxPolicyApprovalSnapshot> {
  // Tax-policy VERSION drift between quote and commit no longer blocks the sale
  // (owner directive, mirroring the PR #32 shipping-policy decoupling): a
  // mid-flight PRODUCT_TAX_POLICY_VERSION bump must not reject an in-flight
  // checkout, manual fulfillment, or address change. Tax is recomputed at the
  // CURRENT rate when the order commits (calculateProductTax), so the charge is
  // always correct regardless of the snapshot's version. The substantive
  // integrity gate — that a COMPLETE, approved tax policy was in force when the
  // snapshot was issued — is preserved via the coverage check.
  if (!taxCoverageComplete(expected.coverage)) {
    throw new CheckoutNotReadyError(["product_tax_policy_not_approved"]);
  }
  return configuredTaxPolicyApproval();
}

export interface ManualCheckoutPolicyApproval {
  version: string;
  text: string;
  textHash: string;
  evidenceReference: string;
  approvedByAdminUserId: string;
  approvedAt: Date;
  effectiveAt: Date;
}

export interface ManualCheckoutReadinessResult {
  ready: boolean;
  blockers: string[];
  policy: ManualCheckoutPolicyApproval | null;
  fulfillmentPolicyVersion: string | null;
  policyVersion: string | null;
  taxPolicyVersion: string | null;
  taxPolicyApproval: ProductTaxPolicyApprovalSnapshot | null;
}

export async function assertManualCheckoutReadinessInTransaction(
  tx: PrivateDbTransaction,
  expected: {
    fulfillmentPolicyVersion: string;
    manualPolicy: ManualCheckoutPolicyApproval;
    taxPolicyApproval: ProductTaxPolicyApprovalSnapshot;
  },
  now = new Date(),
) {
  const blockers: string[] = [];
  if (process.env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    blockers.push("manual_checkout_flag_disabled");
  }
  // Not coupled to the shipping-policy worker's enforcement mode — see
  // evaluateCheckoutReadiness. Post-sale adherence must not halt a sale.
  if (!canonicalHttpsOrigin(process.env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  addFinancialRuntimeBlockers(blockers, process.env);
  if (blockers.length) throw new CheckoutNotReadyError(blockers);

  const currentManualPolicy = configuredManualPolicy();
  if (
    !currentManualPolicy ||
    expected.fulfillmentPolicyVersion !== PRODUCT_SHIPPING_POLICY_VERSION ||
    currentManualPolicy.version !== expected.manualPolicy.version ||
    currentManualPolicy.textHash !== expected.manualPolicy.textHash
  ) {
    throw new CheckoutNotReadyError(["manual_policy_not_approved"]);
  }
  const taxPolicyApproval = await assertProductTaxPolicyApprovalInTransaction(
    tx,
    expected.taxPolicyApproval,
    now,
  );
  return { taxPolicyApproval };
}

export async function evaluateManualCheckoutReadiness(
  input: {
    catalogMetadataReady?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<ManualCheckoutReadinessResult> {
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  if (env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    blockers.push("manual_checkout_flag_disabled");
  }
  // Not coupled to the shipping-policy worker's enforcement mode — see
  // evaluateCheckoutReadiness. Post-sale adherence must not halt a sale.
  if (!canonicalHttpsOrigin(env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  addFinancialRuntimeBlockers(blockers, env);
  if (input.catalogMetadataReady === false) {
    blockers.push("catalog_metadata_incomplete");
  }
  const policy = configuredManualPolicy();
  if (!policy) blockers.push("manual_policy_not_configured");

  return {
    ready: blockers.length === 0,
    blockers,
    policy,
    policyVersion: policy?.version ?? null,
    fulfillmentPolicyVersion: policy ? PRODUCT_SHIPPING_POLICY_VERSION : null,
    taxPolicyVersion: PRODUCT_TAX_POLICY_VERSION,
    taxPolicyApproval: configuredTaxPolicyApproval(),
  };
}

export class CheckoutNotReadyError extends Error {
  constructor(readonly blockers: string[]) {
    super("Product checkout is not operationally ready");
    this.name = "CheckoutNotReadyError";
  }
}

// --- helpers ---------------------------------------------------------------

function quoteContextVersionsCurrent(context: ShippingQuoteContext): boolean {
  return (
    context.policyVersion === PRODUCT_SHIPPING_POLICY_VERSION &&
    context.taxPolicyVersion === PRODUCT_TAX_POLICY_VERSION
  );
}

function configuredManualPolicy(): ManualCheckoutPolicyApproval | null {
  const policy = PRODUCT_MANUAL_CANCELLATION_POLICY;
  const text = policy?.text.trim();
  const version = policy?.version.trim();
  if (!text || !version) return null;
  return {
    version,
    text,
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
    evidenceReference: "source-controlled-config",
    approvedByAdminUserId: "source-controlled-config",
    approvedAt: new Date("2026-01-01T00:00:00.000Z"),
    effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function taxCoverageComplete(value: Record<string, boolean>): boolean {
  return [
    "merchandise",
    "shipping",
    "supplements",
    "usOrders",
    "componentRefunds",
  ].every((key) => value[key] === true);
}

function canonicalHttpsOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isStrongSecret(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return Buffer.byteLength(normalized) >= 32 && new Set(normalized).size >= 12;
}

function addFinancialRuntimeBlockers(
  blockers: string[],
  env: NodeJS.ProcessEnv,
): void {
  if (!isStrongSecret(env.CRON_SECRET)) {
    blockers.push("secret_invalid:CRON_SECRET");
  }
  for (const name of [
    "CHECKOUT_SECRET_ENCRYPTION_KEY",
    "CHECKOUT_PII_ENCRYPTION_KEY",
  ] as const) {
    if (!isBase64EncryptionKey(env[name])) {
      blockers.push(`secret_invalid:${name}`);
    }
  }
  // When Square commerce checkout is enabled, its credentials must be present or
  // checkout would report "ready" and only fail later at authorize time. Gated
  // on the enable flag so environments with commerce off are unaffected.
  if (env.SQUARE_COMMERCE_ENABLED === "true") {
    if (
      env.SQUARE_ENVIRONMENT !== "sandbox" &&
      env.SQUARE_ENVIRONMENT !== "production"
    ) {
      blockers.push("payment_config_invalid:SQUARE_ENVIRONMENT");
    }
    for (const name of [
      "SQUARE_ACCESS_TOKEN",
      "SQUARE_LOCATION_ID",
      "SQUARE_APPLICATION_ID",
      "SQUARE_WEBHOOK_SIGNATURE_KEY",
    ] as const) {
      if (!env[name]?.trim()) {
        blockers.push(`payment_config_missing:${name}`);
      }
    }
  }
}

function stableReadinessJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableReadinessJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableReadinessJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isBase64EncryptionKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}
