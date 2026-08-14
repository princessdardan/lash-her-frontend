import "server-only";

import { and, eq } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productPaymentRiskIncidents,
  shippingPolicySettings,
} from "@/lib/private-db/schema";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";
import { assessCertifiedCardEvidence } from "@/lib/commerce/helcim-contract";

export async function classifyProductOrderPaymentRisk(
  orderReference: string,
  data: Record<string, HelcimPayloadValue>,
): Promise<string[]> {
  const assessment = assessCertifiedCardEvidence({
    avsCode: text(data.avsResponse ?? data.avsResult ?? data.avs),
    cvvCode: text(data.cvvResponse ?? data.cvvResult ?? data.cvv),
  });
  const now = new Date();
  await getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .update(checkoutOrders)
      .set({
        paymentRiskStatus: assessment.status,
        paymentRiskAssessedAt: now,
        paymentRiskSource: "client_callback",
        fraudClassification: assessment.status === "cleared" ? "low" : "high",
        fraudRiskReasons: assessment.reasonCodes,
        fraudClearedAt: assessment.status === "cleared" ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.orderId, orderReference),
          eq(checkoutOrders.purpose, "product"),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (!order || assessment.status === "cleared") return;
    const [settings] = await tx
      .select({ version: shippingPolicySettings.policyVersion })
      .from(shippingPolicySettings)
      .where(eq(shippingPolicySettings.singletonKey, "default"))
      .limit(1);
    await tx
      .insert(productPaymentRiskIncidents)
      .values({
        orderId: order.id,
        incidentKey: `legacy-callback/${order.id}/${[...assessment.reasonCodes].sort().join(",")}`,
        status: "review_required",
        reasonCodes: assessment.reasonCodes,
        providerEvidence: {
          avsCode: assessment.avsCode,
          cvvCode: assessment.cvvCode,
        },
        policyVersion: settings?.version ?? "unconfigured",
        alertedAt: now,
      })
      .onConflictDoNothing({ target: productPaymentRiskIncidents.incidentKey });
  });
  return assessment.reasonCodes;
}

function text(value: HelcimPayloadValue | undefined): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}
