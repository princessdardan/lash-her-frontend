import "server-only";

import { createHash } from "node:crypto";

import {
  getConfiguredHelcimProductPaymentsContract,
  getHelcimContractIdentitySnapshot,
  helcimContractIsEffective,
  parseHelcimProductPaymentsContract,
} from "@/lib/commerce/helcim-certified-contract";
import { PRODUCT_TAX_POLICY_VERSION } from "@/lib/commerce/product-tax-policy";
import { getPrivateDb } from "@/lib/private-db/client";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  HelcimProductPaymentsCertificationContractSnapshot,
  ProductTaxPolicyApprovalSnapshot,
} from "@/lib/private-db/schema";
export type { ProductTaxPolicyApprovalSnapshot } from "@/lib/private-db/schema";

import { getChitChatsConfig, isChitChatsCheckoutEnabled } from "./config";
import { getShippingPolicyEnforcementMode } from "./policy";
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
  // Enforce mode remains the go-live coupling between checkout and the
  // fulfillment worker/cron (which still gate on it), so checkout cannot be
  // ready while the worker is dormant. (Full mode collapse is a follow-up.)
  if (getShippingPolicyEnforcementMode() !== "enforce") {
    blockers.push("policy_not_enforced");
  }
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

  const contract = getConfiguredHelcimProductPaymentsContract();
  if (!contract || !helcimContractIsEffective(contract, now)) {
    blockers.push("helcim_contract_not_configured_or_expired");
  }

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
    blockers.length === 0 && config && contract
      ? buildConfiguredQuoteContext({
          destinationCountryCode: input.destinationCountryCode,
          region: config.region,
          helcimProductPaymentsContract: contract,
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
  intakeLocationAttestationId: string | null;
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
  snapshot: FulfillmentProviderCertificationContractSnapshot | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const snapshot = input.snapshot;
  const configured = PRODUCT_SHIPPING_US_DDU_CONTRACT;
  if (
    !configured ||
    snapshot?.importTerms !== "DDU" ||
    new Date(snapshot.effectiveFrom) > now ||
    new Date(snapshot.effectiveUntil) <= now ||
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
  if (
    !readiness.ready ||
    !readiness.quoteContext ||
    !quoteContextVersionsCurrent(input.expectedContext) ||
    readiness.quoteContext.policyVersion !==
      input.expectedContext.policyVersion ||
    readiness.quoteContext.taxPolicyVersion !==
      input.expectedContext.taxPolicyVersion
  ) {
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

export async function assertHelcimProductPaymentsCertificationInTransaction(
  _tx: PrivateDbTransaction,
  now = new Date(),
): Promise<NonNullable<ReturnType<typeof getHelcimContractIdentitySnapshot>>> {
  const contract = getConfiguredHelcimProductPaymentsContract();
  const identity = getHelcimContractIdentitySnapshot(now);
  if (!contract || !identity || !helcimContractIsEffective(contract, now)) {
    throw new CheckoutNotReadyError(["helcim_not_certified"]);
  }
  return identity;
}

export async function assertProductTaxPolicyApprovalInTransaction(
  _tx: PrivateDbTransaction,
  expected: ProductTaxPolicyApprovalSnapshot,
  _now = new Date(),
): Promise<ProductTaxPolicyApprovalSnapshot> {
  if (
    expected.version !== PRODUCT_TAX_POLICY_VERSION ||
    !taxCoverageComplete(expected.coverage)
  ) {
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
  if (getShippingPolicyEnforcementMode() !== "enforce") {
    blockers.push("policy_not_enforced");
  }
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
  const helcimContract =
    await assertHelcimProductPaymentsCertificationInTransaction(tx, now);
  return { helcimContract, taxPolicyApproval };
}

export async function evaluateManualCheckoutReadiness(
  input: {
    catalogMetadataReady?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<ManualCheckoutReadinessResult> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  if (env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    blockers.push("manual_checkout_flag_disabled");
  }
  if (getShippingPolicyEnforcementMode() !== "enforce") {
    blockers.push("policy_not_enforced");
  }
  if (!canonicalHttpsOrigin(env.NEXT_PUBLIC_SITE_URL)) {
    blockers.push("site_origin_invalid");
  }
  addFinancialRuntimeBlockers(blockers, env);
  const contract = parseConfiguredHelcimContract(env);
  if (!contract || !helcimContractIsEffective(contract, now)) {
    blockers.push("helcim_contract_not_configured_or_expired");
  }
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
  for (const name of [
    "HELCIM_GENERAL_API_TOKEN",
    "HELCIM_TRANSACTION_API_TOKEN",
  ] as const) {
    if (!isProviderToken(env[name])) {
      blockers.push(`provider_token_invalid:${name}`);
    }
  }
}

function parseConfiguredHelcimContract(
  env: NodeJS.ProcessEnv,
): HelcimProductPaymentsCertificationContractSnapshot | null {
  const raw = env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON?.trim();
  if (!raw) return null;
  try {
    return parseHelcimProductPaymentsContract(JSON.parse(raw));
  } catch {
    return null;
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

function isProviderToken(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && !/\s/.test(normalized);
}
