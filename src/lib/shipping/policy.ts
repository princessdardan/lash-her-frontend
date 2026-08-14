import "server-only";

import { and, eq, gte } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  shippingCalendarExceptions,
  shippingPolicySettings,
  shippingServicePolicies,
} from "@/lib/private-db/schema";

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
  settings: typeof shippingPolicySettings.$inferSelect;
  closedDates: Set<string>;
  servicePolicies: Map<string, ShippingServicePolicy>;
  calendarCoverageEndsAt: string;
}

export function getShippingPolicyEnforcementMode(): ShippingPolicyEnforcementMode {
  const value = process.env.SHIPPING_POLICY_ENFORCEMENT_MODE ?? "off";
  if (value === "off" || value === "observe" || value === "enforce")
    return value;
  throw new Error(
    "SHIPPING_POLICY_ENFORCEMENT_MODE must be off, observe, or enforce",
  );
}

export async function loadShippingPolicyContext(
  now = new Date(),
): Promise<ShippingPolicyContext> {
  const db = getPrivateDb();
  const staleBefore = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
  const [settings, exceptions, services] = await Promise.all([
    db.query.shippingPolicySettings.findFirst({
      where: eq(shippingPolicySettings.singletonKey, "default"),
    }),
    db
      .select()
      .from(shippingCalendarExceptions)
      .where(gte(shippingCalendarExceptions.exceptionDate, dayKey(now))),
    db
      .select()
      .from(shippingServicePolicies)
      .where(
        and(
          eq(shippingServicePolicies.enabled, true),
          gte(shippingServicePolicies.reviewedAt, staleBefore),
        ),
      ),
  ]);
  if (!settings) throw new Error("Shipping policy settings are not configured");
  const coverageEnd = exceptions.reduce(
    (latest, entry) =>
      entry.exceptionDate > latest ? entry.exceptionDate : latest,
    "",
  );
  const requiredCoverage = dayKey(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 21, 1)),
  );
  if (!coverageEnd || coverageEnd < requiredCoverage)
    throw new Error("Shipping calendar has less than 21 months of coverage");
  return {
    mode: getShippingPolicyEnforcementMode(),
    settings,
    closedDates: new Set(exceptions.map((entry) => entry.exceptionDate)),
    servicePolicies: new Map(
      services.map((service) => [
        serviceKey(service.postageType, service.destinationCountryCode),
        service,
      ]),
    ),
    calendarCoverageEndsAt: coverageEnd,
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

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
