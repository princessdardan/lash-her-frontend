import "server-only";

import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  shippingCalendarExceptions,
  shippingCalendarVersions,
  shippingPolicySettings,
  shippingServicePolicies,
} from "@/lib/private-db/schema";
import { calendarCoverageComplete } from "./calendar-validation";

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

export async function loadShippingPolicyContext(
  now = new Date(),
): Promise<ShippingPolicyContext> {
  const db = getPrivateDb();
  const staleBefore = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
  const [settings, exceptions, services, calendarVersion] = await Promise.all([
    db.query.shippingPolicySettings.findFirst({
      where: eq(shippingPolicySettings.singletonKey, "default"),
    }),
    db.select().from(shippingCalendarExceptions),
    db
      .select()
      .from(shippingServicePolicies)
      .where(
        and(
          eq(shippingServicePolicies.enabled, true),
          gte(shippingServicePolicies.reviewedAt, staleBefore),
        ),
      ),
    db.query.shippingCalendarVersions.findFirst({
      where: and(
        eq(shippingCalendarVersions.status, "effective"),
        lte(shippingCalendarVersions.effectiveAt, now),
        isNull(shippingCalendarVersions.supersededAt),
      ),
      orderBy: [desc(shippingCalendarVersions.effectiveAt)],
    }),
  ]);
  if (!settings) throw new Error("Shipping policy settings are not configured");
  const legacyCoverageEnd = exceptions.reduce(
    (latest, entry) =>
      entry.exceptionDate > latest ? entry.exceptionDate : latest,
    "",
  );
  const coverageEnd = calendarVersion?.coverageEndsOn ?? legacyCoverageEnd;
  const closureDates =
    calendarVersion?.closureDates ??
    exceptions.map((entry) => ({
      date: entry.exceptionDate,
      kind: entry.kind,
      label: entry.label,
    }));
  const calendarIsComplete = Boolean(
    calendarVersion &&
    calendarCoverageComplete(
      {
        coverageStartsOn: calendarVersion.coverageStartsOn,
        coverageEndsOn: calendarVersion.coverageEndsOn,
        closureDates: calendarVersion.closureDates,
      },
      now,
    ),
  );
  return {
    mode: getShippingPolicyEnforcementMode(),
    settings,
    closedDates: new Set(closureDates.map((entry) => entry.date)),
    servicePolicies: new Map(
      services.map((service) => [
        serviceKey(service.postageType, service.destinationCountryCode),
        service,
      ]),
    ),
    calendarCoverageEndsAt: coverageEnd,
    calendarCoverageSufficient: calendarIsComplete,
    calendarVersionId: calendarVersion?.id ?? null,
    calendarVersion: calendarVersion?.version ?? null,
    deadlinePolicySnapshot: {
      calendarVersion: calendarVersion?.version ?? "legacy",
      timezone: calendarVersion?.timezone ?? "America/Toronto",
      coverageStartsOn: calendarVersion?.coverageStartsOn ?? null,
      coverageEndsOn: coverageEnd || null,
      closureDates,
      beforeCutoffHandoffBusinessDays: settings.beforeCutoffHandoffBusinessDays,
      afterCutoffHandoffBusinessDays: settings.afterCutoffHandoffBusinessDays,
      autoRefundBusinessDays: settings.autoRefundBusinessDays,
      policyVersion: settings.policyVersion,
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
