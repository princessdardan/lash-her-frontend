import { NextResponse, type NextRequest } from "next/server";

import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import {
  recordInitialShippingFundingForecast,
  recordShippingFundingControl,
} from "@/lib/shipping/funding";
import { assertShippingPolicyConfigurationMutationAllowed } from "@/lib/shipping/policy";

export interface FundingReviewRouteDependencies {
  assertMutationAllowed: typeof assertShippingPolicyConfigurationMutationAllowed;
  createStepUpTarget: typeof createAdminStepUpTarget;
  recordAudit: typeof recordAdminAuditBestEffort;
  recordControl: typeof recordShippingFundingControl;
  recordInitialForecast: typeof recordInitialShippingFundingForecast;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requirePermission: typeof requirePermission;
  requireStepUp: typeof requireRecentAdminAuthentication;
}

const defaultDependencies: FundingReviewRouteDependencies = {
  assertMutationAllowed: assertShippingPolicyConfigurationMutationAllowed,
  createStepUpTarget: createAdminStepUpTarget,
  recordAudit: recordAdminAuditBestEffort,
  recordControl: recordShippingFundingControl,
  recordInitialForecast: recordInitialShippingFundingForecast,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  requirePermission,
  requireStepUp: requireRecentAdminAuthentication,
};

const FUNDING_KIND_FIELDS: Record<string, readonly string[]> = {
  initial_forecast: [
    "calculatedFiveBusinessDaySpendCents",
    "calculatedTwoBusinessDaySpendCents",
    "externalEvidenceReference",
    "reloadAmountCents",
    "reloadThresholdCents",
  ],
  balance_check: [
    "balanceCents",
    "externalEvidenceReference",
    "forecastReviewId",
    "observedAt",
    "validUntil",
  ],
  reload: ["reloadAmountCents", "reloadThresholdCents", "successful"],
  emergency_top_up: ["topUpAmountCents"],
};

export function createFundingReviewHandlers(
  dependencies: FundingReviewRouteDependencies = defaultDependencies,
) {
  return {
    POST: async (req: NextRequest): Promise<Response> => {
      const actor = await dependencies.requirePermission("settings:manage");
      try {
        await dependencies.requireConfiguredOwner(actor.user.id);
      } catch {
        return NextResponse.json(
          { error: "Only the configured fulfillment owner may manage funding" },
          { status: 403 },
        );
      }
      if (req.headers.get("origin") !== req.nextUrl.origin) {
        return NextResponse.json(
          { error: "Invalid request origin" },
          { status: 403 },
        );
      }
      try {
        dependencies.assertMutationAllowed();
      } catch {
        return NextResponse.json(
          { error: "Funding configuration is read-only in observe mode" },
          { status: 409 },
        );
      }
      const body = (await req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!body || !Object.hasOwn(FUNDING_KIND_FIELDS, String(body.kind))) {
        return NextResponse.json(
          { error: "Funding control is invalid" },
          { status: 400 },
        );
      }
      const kind = String(body.kind);
      const allowedFields = new Set([
        "kind",
        "dedicatedBusinessCardConfirmed",
        "issuerAlertsConfirmed",
        ...FUNDING_KIND_FIELDS[kind]!,
      ]);
      const unexpectedFundingField = Object.keys(body).find(
        (field) => !allowedFields.has(field),
      );
      if (unexpectedFundingField) {
        return NextResponse.json(
          {
            error: `Funding field ${unexpectedFundingField} is invalid for ${kind}`,
          },
          { status: 400 },
        );
      }

      const stepUp = fundingRecordStepUpScope(
        body,
        dependencies.createStepUpTarget,
      );
      try {
        await dependencies.requireStepUp(stepUp);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Step-up authentication is required",
            stepUp,
          },
          { status: 409 },
        );
      }

      try {
        if (kind === "initial_forecast") {
          const record = await dependencies.recordInitialForecast({
            actorAdminUserId: actor.user.id,
            dedicatedBusinessCardConfirmed:
              body.dedicatedBusinessCardConfirmed === true,
            calculatedFiveBusinessDaySpendCents: requiredInteger(
              body.calculatedFiveBusinessDaySpendCents,
            ),
            calculatedTwoBusinessDaySpendCents: requiredInteger(
              body.calculatedTwoBusinessDaySpendCents,
            ),
            evidenceReference: String(body.externalEvidenceReference ?? ""),
            issuerAlertsConfirmed: body.issuerAlertsConfirmed === true,
            reloadAmountCents: requiredInteger(body.reloadAmountCents),
            reloadThresholdCents: requiredInteger(body.reloadThresholdCents),
          });
          await dependencies.recordAudit({
            action: "fulfillment.funding_initial_forecast",
            actor,
            domain: "fulfillment",
            outcome: "success",
            targetId: record.id,
            targetType: "shipping_funding_review",
          });
          return NextResponse.json(
            { id: record.id, status: record.status },
            { status: 201 },
          );
        }

        const record = await dependencies.recordControl({
          actorAdminUserId: actor.user.id,
          kind: kind as "balance_check" | "reload" | "emergency_top_up",
          balanceCents: integer(body.balanceCents),
          reloadThresholdCents: integer(body.reloadThresholdCents),
          reloadAmountCents: integer(body.reloadAmountCents),
          topUpAmountCents: integer(body.topUpAmountCents),
          dedicatedBusinessCardConfirmed:
            body.dedicatedBusinessCardConfirmed === true,
          issuerAlertsConfirmed: body.issuerAlertsConfirmed === true,
          successful: body.successful !== false,
          externalEvidenceReference:
            typeof body.externalEvidenceReference === "string"
              ? body.externalEvidenceReference
              : undefined,
          observedAt: date(body.observedAt),
          validUntil: date(body.validUntil),
          forecastReviewId:
            typeof body.forecastReviewId === "string"
              ? body.forecastReviewId
              : undefined,
        });
        await dependencies.recordAudit({
          action: `fulfillment.funding_${record.kind}`,
          actor,
          domain: "fulfillment",
          outcome: "success",
          targetId: record.id,
          targetType: "shipping_funding_review",
          metadata: {
            amountCents: record.topUpAmountCents ?? record.reloadAmountCents,
          },
        });
        return NextResponse.json(
          { id: record.id, status: record.status },
          { status: 201 },
        );
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error ? error.message : "Funding control failed",
          },
          { status: 409 },
        );
      }
    },
  };
}

export function fundingRecordStepUpScope(
  body: Record<string, unknown>,
  createTarget: typeof createAdminStepUpTarget = createAdminStepUpTarget,
) {
  return {
    action: "shipping_funding:record",
    target: createTarget({
      balanceCents: integer(body.balanceCents) ?? null,
      calculatedFiveBusinessDaySpendCents:
        integer(body.calculatedFiveBusinessDaySpendCents) ?? null,
      calculatedTwoBusinessDaySpendCents:
        integer(body.calculatedTwoBusinessDaySpendCents) ?? null,
      dedicatedBusinessCardConfirmed:
        body.dedicatedBusinessCardConfirmed === true,
      externalEvidenceReference:
        typeof body.externalEvidenceReference === "string"
          ? body.externalEvidenceReference.trim()
          : null,
      forecastReviewId:
        typeof body.forecastReviewId === "string"
          ? body.forecastReviewId
          : null,
      issuerAlertsConfirmed: body.issuerAlertsConfirmed === true,
      kind: String(body.kind),
      observedAt: normalizedDate(body.observedAt),
      reloadAmountCents: integer(body.reloadAmountCents) ?? null,
      reloadThresholdCents: integer(body.reloadThresholdCents) ?? null,
      successful: body.successful !== false,
      topUpAmountCents: integer(body.topUpAmountCents) ?? null,
      validUntil: normalizedDate(body.validUntil),
    }),
  };
}

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? Number(value) : undefined;
}

function date(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizedDate(value: unknown): string | null {
  return date(value)?.toISOString() ?? null;
}

function requiredInteger(value: unknown): number {
  return integer(value) ?? Number.NaN;
}
