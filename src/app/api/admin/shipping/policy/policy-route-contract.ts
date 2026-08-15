import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import type { HelcimProductPaymentsCertificationContractSnapshot } from "@/lib/private-db/schema";

export function requireTorontoPolicyTimezone(
  value: unknown,
): "America/Toronto" {
  const timezone = typeof value === "string" ? value.trim() : "America/Toronto";
  if (timezone !== "America/Toronto") {
    throw new Error("Shipping calendar timezone must be America/Toronto");
  }
  return timezone;
}

export function normalizeProviderCertificationSubmission(
  body: Record<string, unknown>,
  configuredHelcim: HelcimProductPaymentsCertificationContractSnapshot | null,
): {
  contractSnapshot: Record<string, unknown> | undefined;
  evidenceReference: string;
  validUntil: unknown;
  version: string;
} {
  const provider = body.provider;
  if (provider === "helcim" && !configuredHelcim) {
    throw new Error("The certified Helcim contract is not configured");
  }
  const submittedSnapshot =
    body.contractSnapshot &&
    typeof body.contractSnapshot === "object" &&
    !Array.isArray(body.contractSnapshot)
      ? (body.contractSnapshot as Record<string, unknown>)
      : undefined;
  if (
    configuredHelcim &&
    (String(body.scope ?? "") !== "product_payments" ||
      String(body.version ?? "") !== configuredHelcim.version ||
      String(body.evidenceReference ?? "") !==
        configuredHelcim.evidenceReference ||
      new Date(String(body.validUntil ?? "")).getTime() !==
        new Date(configuredHelcim.effectiveUntil).getTime() ||
      createAdminStepUpTarget(submittedSnapshot) !==
        createAdminStepUpTarget(configuredHelcim))
  ) {
    throw new Error(
      "Submitted Helcim certification must exactly match the configured contract",
    );
  }
  return {
    contractSnapshot: (configuredHelcim ?? submittedSnapshot) as
      | Record<string, unknown>
      | undefined,
    evidenceReference:
      configuredHelcim?.evidenceReference ??
      String(body.evidenceReference ?? ""),
    validUntil: configuredHelcim?.effectiveUntil ?? body.validUntil,
    version: configuredHelcim?.version ?? String(body.version ?? ""),
  };
}

export function policyRouteStepUpScope(
  action: string,
  payload: Record<string, unknown>,
) {
  return {
    action: `shipping_policy:${action}`,
    target: createAdminStepUpTarget({ action, payload }),
    targetLabel: `Shipping policy: ${action.replaceAll("_", " ")}`,
  };
}
