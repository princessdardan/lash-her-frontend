import { NextResponse, type NextRequest } from "next/server";

import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import { paymentObligationInitializationReconciliationScope } from "@/lib/commerce/product-payment-obligation-initialization-plan";
import {
  preparePaymentObligationInitializationReconciliation,
  reconcilePaymentObligationInitialization,
  type PaymentObligationInitializationReconciliationAction,
} from "@/lib/commerce/product-payment-obligation-reconciliation";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

export const runtime = "nodejs";

const ACTIONS = new Set<PaymentObligationInitializationReconciliationAction>([
  "adopt_invoice",
  "confirm_no_payable_state_and_reissue",
  "record_manual_handoff",
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ orderId: string; obligationId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  let stepUp:
    | { action: string; target: string; targetLabel: string }
    | undefined;
  try {
    await assertConfiguredFulfillmentOwner(actor.user.id);
  } catch {
    return NextResponse.json(
      {
        error: "Only the configured fulfillment owner may perform this action",
      },
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
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
  const { orderId, obligationId } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const action =
    typeof body?.action === "string" &&
    ACTIONS.has(
      body.action as PaymentObligationInitializationReconciliationAction,
    )
      ? (body.action as PaymentObligationInitializationReconciliationAction)
      : null;
  if (!action) {
    return NextResponse.json(
      { error: "Payment initialization reconciliation action is invalid" },
      { status: 400 },
    );
  }
  const expectedStateVersion = Number(body?.expectedStateVersion);
  const evidenceReference =
    typeof body?.evidenceReference === "string"
      ? body.evidenceReference.trim()
      : "";
  const rationale =
    typeof body?.rationale === "string" ? body.rationale.trim() : "";
  const providerInvoiceId =
    body?.providerInvoiceId === undefined
      ? undefined
      : Number(body.providerInvoiceId);
  const providerInvoiceNumber =
    typeof body?.providerInvoiceNumber === "string"
      ? body.providerInvoiceNumber.trim()
      : undefined;
  if (
    !Number.isInteger(expectedStateVersion) ||
    expectedStateVersion < 1 ||
    evidenceReference.length < 6 ||
    rationale.length < 10
  ) {
    return NextResponse.json(
      { error: "Version, provider evidence, and rationale are required" },
      { status: 400 },
    );
  }
  try {
    const prepared = await preparePaymentObligationInitializationReconciliation(
      {
        action,
        expectedStateVersion,
        obligationId,
        orderReference: orderId,
        providerInvoiceId,
        providerInvoiceNumber,
      },
    );
    stepUp = {
      action: `payment-obligation-initialization:${action}`,
      target: createAdminStepUpTarget(
        paymentObligationInitializationReconciliationScope({
          action,
          evidenceReference,
          expectedStateVersion,
          obligationId,
          orderId,
          providerEvidenceHash: prepared.providerEvidence.evidenceHash,
          providerEvidenceKind: prepared.providerEvidence.kind,
          rationale,
        }),
      ),
      targetLabel: `payment obligation ${obligationId}`,
    };
    const stepUpAuthenticatedAt =
      await requireRecentAdminAuthentication(stepUp);
    const result = await reconcilePaymentObligationInitialization({
      action,
      actorAdminUserId: actor.user.id,
      evidenceReference,
      expectedStateVersion,
      obligationId,
      orderReference: orderId,
      providerInvoiceId,
      providerInvoiceNumber,
      providerEvidence: prepared.providerEvidence,
      rationale,
      stepUpAuthenticatedAt,
    });
    return NextResponse.json(result, {
      status: action === "record_manual_handoff" ? 200 : 202,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Reconciliation failed";
    return NextResponse.json(
      {
        error: message,
        ...(/step-up|authentication/i.test(message) && stepUp
          ? { stepUp }
          : {}),
      },
      { status: 409 },
    );
  }
}
