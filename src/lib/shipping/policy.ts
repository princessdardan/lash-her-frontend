import "server-only";

import {
  PRODUCT_SHIPPING_POLICY_VERSION,
  PRODUCT_SHIPPING_SETTINGS,
  getProductShippingClosureDates,
  getProductShippingServicePolicyMap,
  type ProductShippingSettings,
} from "./product-shipping-config";

export {
  isEquivalentSubstitution,
  parseDeliveryMaxBusinessDays,
  signatureIsAvailable,
} from "./policy-rules";

export type ShippingPolicyEnforcementMode = "off" | "observe" | "enforce";

export interface ShippingServicePolicy {
  postageType: string;
  destinationCountryCode: string;
  trackingRequired: boolean;
  insuranceLimitCents: number;
  signatureCapable: boolean;
  claimWaitingDays: number;
  claimDeadlineDays: number;
  reviewedAt: Date;
}

export interface ShippingPolicyContext {
  mode: ShippingPolicyEnforcementMode;
  settings: ProductShippingSettings;
  closedDates: Set<string>;
  servicePolicies: Map<string, ShippingServicePolicy>;
  calendarCoverageEndsAt: string;
  calendarCoverageSufficient: boolean;
  calendarVersionId: string | null;
  calendarVersion: string | null;
  deadlinePolicySnapshot: Record<string, unknown>;
}

export function getShippingPolicyEnforcementMode(): ShippingPolicyEnforcementMode {
  const value = process.env.SHIPPING_POLICY_ENFORCEMENT_MODE ?? "off";
  if (value === "off" || value === "observe" || value === "enforce")
    return value;
  throw new Error(
    "SHIPPING_POLICY_ENFORCEMENT_MODE must be off, observe, or enforce",
  );
}

export function assertShippingPolicyMutationAllowed(): void {
  const mode = getShippingPolicyEnforcementMode();
  if (mode !== "enforce") {
    throw new ShippingPolicyMutationBlockedError(mode);
  }
}

export function assertShippingPolicyConfigurationMutationAllowed(): void {
  const mode = getShippingPolicyEnforcementMode();
  if (mode === "observe") {
    throw new ShippingPolicyMutationBlockedError(mode);
  }
}

export class ShippingPolicyMutationBlockedError extends Error {
  constructor(readonly mode: ShippingPolicyEnforcementMode) {
    super(`Shipping policy mutations are disabled in ${mode} mode`);
    this.name = "ShippingPolicyMutationBlockedError";
  }
}

// Kept async for call-site compatibility (all callers `await` it).
export async function loadShippingPolicyContext(
  now = new Date(),
): Promise<ShippingPolicyContext> {
  const settings = PRODUCT_SHIPPING_SETTINGS;
  const closureDates = getProductShippingClosureDates(now);
  const coverageEnd = closureDates.at(-1)?.date ?? "";
  return {
    mode: getShippingPolicyEnforcementMode(),
    settings,
    closedDates: new Set(closureDates.map((entry) => entry.date)),
    servicePolicies: getProductShippingServicePolicyMap(now),
    calendarCoverageEndsAt: coverageEnd,
    calendarCoverageSufficient: true,
    calendarVersionId: PRODUCT_SHIPPING_POLICY_VERSION,
    calendarVersion: PRODUCT_SHIPPING_POLICY_VERSION,
    deadlinePolicySnapshot: {
      calendarVersion: PRODUCT_SHIPPING_POLICY_VERSION,
      timezone: settings.timezone,
      coverageStartsOn: now.toISOString().slice(0, 10),
      coverageEndsOn: coverageEnd || null,
      closureDates,
      beforeCutoffHandoffBusinessDays: settings.beforeCutoffHandoffBusinessDays,
      afterCutoffHandoffBusinessDays: settings.afterCutoffHandoffBusinessDays,
      autoRefundBusinessDays: settings.autoRefundBusinessDays,
      policyVersion: PRODUCT_SHIPPING_POLICY_VERSION,
    },
  };
}

export function getServicePolicy(
  context: ShippingPolicyContext,
  postageType: string,
  destinationCountryCode: string,
): ShippingServicePolicy | null {
  return (
    context.servicePolicies.get(
      serviceKey(postageType, destinationCountryCode),
    ) ?? null
  );
}

function serviceKey(postageType: string, country: string): string {
  return `${postageType}:${country.toUpperCase()}`;
}
