import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  attestReplacementInventory,
  adoptReplacementShipment,
  createShipmentGeneration,
  queueInventoryUnavailableRefund,
  updateProductShippingCase,
} from "@/lib/shipping/cases";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const { caseId } = await params;
  try {
    let result: {
      id: string;
      stateVersion?: number;
      refundOperationIds?: string[];
    };
    if (body?.action === "attest_inventory") {
      const expiresAt = new Date(String(body.expiresAt ?? ""));
      result = await attestReplacementInventory({
        caseId,
        productId: String(body.productId ?? ""),
        variantId:
          typeof body.variantId === "string" ? body.variantId : undefined,
        sku: String(body.sku ?? ""),
        quantity: Number(body.quantity),
        actorAdminUserId: actor.user.id,
        expiresAt,
      });
    } else if (body?.action === "adopt_replacement") {
      const sourceVersion = Number(body.expectedSourceStateVersion);
      const remedyVersion = Number(body.expectedRemedyStateVersion);
      if (
        !Number.isInteger(sourceVersion) ||
        sourceVersion < 1 ||
        !Number.isInteger(remedyVersion) ||
        remedyVersion < 1
      )
        throw new Error(
          "Source and replacement generation versions are required",
        );
      result = await adoptReplacementShipment({
        caseId,
        actorAdminUserId: actor.user.id,
        expectedSourceStateVersion: sourceVersion,
        expectedRemedyStateVersion: remedyVersion,
      });
    } else if (
      body?.action === "replacement" ||
      body?.action === "reshipment"
    ) {
      if (body.action === "replacement" && body.inventoryConfirmed !== true) {
        result = await queueInventoryUnavailableRefund({
          caseId,
          requestedByAdminUserId: actor.user.id,
        });
      } else {
        result = await createShipmentGeneration({
          caseId,
          actorAdminUserId: actor.user.id,
          purpose: body.action,
          inventoryAttestationId: String(body.inventoryAttestationId ?? ""),
        });
      }
    } else if (
      ["acknowledge", "claim", "inspect", "resolve"].includes(
        String(body?.action),
      )
    ) {
      const expectedStateVersion = Number(body?.expectedStateVersion);
      if (!Number.isInteger(expectedStateVersion) || expectedStateVersion < 1)
        throw new Error("Shipping case version is required");
      result = await updateProductShippingCase({
        caseId,
        actorAdminUserId: actor.user.id,
        expectedStateVersion,
        action: body!.action as "acknowledge" | "claim" | "inspect" | "resolve",
        cause: typeof body?.cause === "string" ? body.cause : undefined,
        providerClaimReference:
          typeof body?.providerClaimReference === "string"
            ? body.providerClaimReference
            : undefined,
        evidenceChecklist:
          body?.evidenceChecklist && typeof body.evidenceChecklist === "object"
            ? (body.evidenceChecklist as Record<string, boolean>)
            : undefined,
        remedyChoice:
          typeof body?.remedyChoice === "string"
            ? body.remedyChoice
            : undefined,
      });
    } else {
      return NextResponse.json(
        { error: "Case action is invalid" },
        { status: 400 },
      );
    }
    await recordAdminAuditBestEffort({
      action: `fulfillment.shipping_case_${String(body?.action)}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: caseId,
      targetType: "product_shipping_case",
      metadata: { resultId: result.id },
    });
    return NextResponse.json(
      {
        id: result.id,
        stateVersion: result.stateVersion,
        refundOperationIds: result.refundOperationIds,
      },
      { status: result.refundOperationIds?.length ? 202 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Case action failed" },
      { status: 409 },
    );
  }
}
