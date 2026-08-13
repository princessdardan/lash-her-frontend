import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { createChitChatsClient } from "@/lib/shipping/chitchats-client";
import { getChitChatsConfig } from "@/lib/shipping/config";
import { selectCustomerRates } from "@/lib/shipping/rates";
import {
  claimShipmentPurchase,
  releaseShipmentPurchaseClaim,
  updateShipmentFromProvider,
} from "@/lib/shipping/shipment-store";
import {
  normalizeChitChatsStatus,
  stripSignedLabelUrls,
} from "@/lib/shipping/status";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  if (!isSameOrigin(req))
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const { orderId } = await params;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const measuredWeightGrams =
    body && Number.isInteger(body.measuredWeightGrams)
      ? Number(body.measuredWeightGrams)
      : 0;
  const shipDate =
    body &&
    typeof body.shipDate === "string" &&
    /^(today|\d{4}-\d{2}-\d{2})$/.test(body.shipDate)
      ? body.shipDate
      : null;
  const alternatePostageType =
    body && typeof body.alternatePostageType === "string"
      ? body.alternatePostageType.trim()
      : "";
  const alternateReason =
    body && typeof body.alternateReason === "string"
      ? body.alternateReason.trim().slice(0, 500)
      : "";
  if (measuredWeightGrams <= 0 || measuredWeightGrams > 50_000 || !shipDate) {
    return NextResponse.json(
      { error: "Measured weight and ship date are required" },
      { status: 400 },
    );
  }

  const shipment = await claimShipmentPurchase(orderId);
  if (
    !shipment ||
    !shipment.providerShipmentId ||
    !shipment.selectedPostageType
  ) {
    return NextResponse.json(
      { error: "Shipment is not ready to purchase" },
      { status: 409 },
    );
  }
  const config = getChitChatsConfig();
  const client = createChitChatsClient(config);
  let buyWasRequested = false;
  try {
    const refreshed = await client.refreshShipment(
      shipment.providerShipmentId,
      {
        packageType: shipment.packageSnapshot.packageType,
        weightGrams: measuredWeightGrams,
        lengthCm: shipment.packageSnapshot.lengthCm,
        widthCm: shipment.packageSnapshot.widthCm,
        heightCm: shipment.packageSnapshot.heightCm,
        shipDate,
      },
    );
    const rates = selectCustomerRates(
      refreshed.rates ?? [],
      config.trackedPostageTypes,
    );
    const originalRate = rates.find(
      (rate) => rate.postageType === shipment.selectedPostageType,
    );
    const selectedRate =
      originalRate ??
      rates.find((rate) => rate.postageType === alternatePostageType);
    if (!selectedRate) {
      await releaseShipmentPurchaseClaim(
        shipment.id,
        "ready_for_staff",
        stripSignedLabelUrls(refreshed),
      );
      return NextResponse.json(
        {
          error:
            "The customer-selected service is no longer available. Choose an explicit insured tracked alternative.",
          rates: rates.map((rate) => ({
            id: rate.id,
            title: rate.title,
            amountCents: rate.paymentAmountCents,
          })),
        },
        { status: 409 },
      );
    }
    if (!originalRate && !alternateReason) {
      await releaseShipmentPurchaseClaim(
        shipment.id,
        "ready_for_staff",
        stripSignedLabelUrls(refreshed),
      );
      return NextResponse.json(
        { error: "A reason is required when changing the shipping service" },
        { status: 400 },
      );
    }

    buyWasRequested = true;
    let purchased = await client.buyShipment(shipment.providerShipmentId, {
      postageType: selectedRate.postageType,
    });
    const deadline = Date.now() + 5_000;
    while (purchased.status === "postage_requested" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      purchased = await client.getShipment(shipment.providerShipmentId);
    }
    const normalized = normalizeChitChatsStatus(purchased);
    if (purchased.status === "postage_purchase_failed") {
      await releaseShipmentPurchaseClaim(
        shipment.id,
        "ready_for_staff",
        stripSignedLabelUrls(purchased),
      );
      return NextResponse.json(
        { error: "Postage purchase failed" },
        { status: 409 },
      );
    }
    await updateShipmentFromProvider({
      id: shipment.id,
      status: normalized,
      providerStatus: purchased.status,
      rawShipment: stripSignedLabelUrls(purchased),
      trackingNumber: purchased.carrier_tracking_code,
      trackingUrl: purchased.tracking_url,
      actualPostageCents: moneyToCents(purchased.postage_fee),
      actualInsuranceCents: moneyToCents(purchased.insurance_fee),
    });
    await recordAdminAuditBestEffort({
      action: "fulfillment.postage_purchase",
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: shipment.id,
      targetType: "product_shipment",
      metadata: {
        orderId,
        postageType: selectedRate.postageType,
        measuredWeightGrams,
        quotedShippingCents: shipment.quotedShippingCents,
        actualShippingCents: selectedRate.paymentAmountCents,
        ...(alternateReason ? { alternateReason } : {}),
      },
    });
    return NextResponse.json({
      status: normalized,
      trackingNumber: purchased.carrier_tracking_code ?? null,
    });
  } catch (error) {
    await releaseShipmentPurchaseClaim(
      shipment.id,
      buyWasRequested ? "manual_review" : "ready_for_staff",
    );
    await recordAdminAuditBestEffort({
      action: "fulfillment.postage_purchase",
      actor,
      domain: "fulfillment",
      outcome: "failure",
      reason: error instanceof Error ? error.message : "Unknown provider error",
      targetId: shipment.id,
      targetType: "product_shipment",
      metadata: { orderId, buyOutcomeUnknown: buyWasRequested },
    });
    return NextResponse.json(
      {
        error: buyWasRequested
          ? "Purchase outcome is unknown and requires review"
          : "Shipping rates could not be refreshed",
      },
      { status: 503 },
    );
  }
}

function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  return origin !== null && origin === req.nextUrl.origin;
}

function moneyToCents(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}
