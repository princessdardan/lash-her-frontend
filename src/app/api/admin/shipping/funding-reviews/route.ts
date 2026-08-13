import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { recordShippingFundingControl } from "@/lib/shipping/funding";

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
  if (
    !body ||
    !["balance_check", "reload", "emergency_top_up"].includes(String(body.kind))
  )
    return NextResponse.json(
      { error: "Funding control is invalid" },
      { status: 400 },
    );
  try {
    const record = await recordShippingFundingControl({
      actorAdminUserId: actor.user.id,
      kind: body.kind as "balance_check" | "reload" | "emergency_top_up",
      balanceCents: integer(body.balanceCents),
      reloadThresholdCents: integer(body.reloadThresholdCents),
      reloadAmountCents: integer(body.reloadAmountCents),
      topUpAmountCents: integer(body.topUpAmountCents),
      dedicatedBusinessCardConfirmed:
        body.dedicatedBusinessCardConfirmed === true,
      issuerAlertsConfirmed: body.issuerAlertsConfirmed === true,
      successful: body.successful !== false,
    });
    await recordAdminAuditBestEffort({
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
}

function integer(value: unknown): number | undefined {
  return Number.isInteger(value) ? Number(value) : undefined;
}
