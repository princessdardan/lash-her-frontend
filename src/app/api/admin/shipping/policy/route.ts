import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  assignShippingPolicyDuty,
  updateShippingPolicySettings,
  upsertShippingCalendarException,
  upsertShippingServicePolicy,
} from "@/lib/shipping/policy-admin";

export async function POST(req: NextRequest): Promise<Response> {
  const actor = await requirePermission("settings:manage");
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  try {
    let targetId = "default";
    if (body?.action === "assign_duty") {
      const duty = String(body.duty) as Parameters<
        typeof assignShippingPolicyDuty
      >[0]["duty"];
      const userId = String(body.adminUserId ?? "");
      const assignment = await assignShippingPolicyDuty({
        actorAdminUserId: actor.user.id,
        adminUserId: userId,
        duty,
      });
      targetId = assignment.id;
    } else if (body?.action === "calendar_exception") {
      await upsertShippingCalendarException({
        actorAdminUserId: actor.user.id,
        exceptionDate: String(body.exceptionDate ?? ""),
        kind:
          body.kind === "branch_closure" ? "branch_closure" : "ontario_holiday",
        label: String(body.label ?? ""),
      });
    } else if (body?.action === "service_policy") {
      const service = await upsertShippingServicePolicy({
        postageType: String(body.postageType ?? ""),
        destinationCountryCode:
          body.destinationCountryCode === "US" ? "US" : "CA",
        trackingRequired: body.trackingRequired !== false,
        insuranceLimitCents: Number(body.insuranceLimitCents),
        signatureCapable: body.signatureCapable === true,
        claimWaitingDays: Number(body.claimWaitingDays),
        claimDeadlineDays: Number(body.claimDeadlineDays),
        enabled: body.enabled === true,
      });
      targetId = service.id;
    } else if (body?.action === "settings") {
      await updateShippingPolicySettings({
        forwarderPatterns: Array.isArray(body.forwarderPatterns)
          ? body.forwarderPatterns.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
        pilotStartedAt:
          typeof body.pilotStartedAt === "string"
            ? new Date(body.pilotStartedAt)
            : undefined,
      });
    } else {
      return NextResponse.json(
        { error: "Policy action is invalid" },
        { status: 400 },
      );
    }
    await recordAdminAuditBestEffort({
      action: `fulfillment.policy_${String(body.action)}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId,
      targetType: "shipping_policy",
    });
    return NextResponse.json({ ok: true, id: targetId });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Policy update failed",
      },
      { status: 409 },
    );
  }
}
