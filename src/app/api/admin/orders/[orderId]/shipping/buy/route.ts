import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { createChitChatsClient } from "@/lib/shipping/chitchats-client";
import { getChitChatsConfig } from "@/lib/shipping/config";
import { selectCustomerRates } from "@/lib/shipping/rates";
import {
  isEquivalentSubstitution,
  loadShippingPolicyContext,
} from "@/lib/shipping/policy";
import { hasSignedCustomerDecision } from "@/lib/shipping/customer-decisions";
import {
  sendShippingCustomerUpdate,
  sendShippingPolicyAlert,
} from "@/lib/shipping/policy-alerts";
import {
  claimShipmentPurchase,
  releaseShipmentPurchaseClaim,
  updateShipmentFromProvider,
} from "@/lib/shipping/shipment-store";
import {
  normalizeChitChatsStatus,
  stripSignedLabelUrls,
} from "@/lib/shipping/status";
import { parseProviderMoneyCents } from "@/lib/shipping/provider-money";

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
  const alternateConditionsUnchanged =
    body?.alternateConditionsUnchanged === true;
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
  const policy = await loadShippingPolicyContext();
  const signatureRequired =
    shipment.orderAtRiskValueCents >= policy.settings.signatureThresholdCents ||
    shipment.orderFraudClassification === "high";
  if (
    shipment.orderFraudClassification === "high" &&
    !shipment.orderFraudClearedAt
  ) {
    await releaseShipmentPurchaseClaim(shipment.id, "ready_for_staff");
    return NextResponse.json(
      { error: "High-risk order requires two-person clearance" },
      { status: 409 },
    );
  }
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
        signatureRequested: signatureRequired,
      },
    );
    const rates = selectCustomerRates(
      refreshed.rates ?? [],
      config.trackedPostageTypes,
      {
        atRiskValueCents: shipment.orderAtRiskValueCents,
        destinationCountryCode:
          shipment.destination.countryCode ??
          (shipment.destination.country === "Canada" ? "CA" : "US"),
        estimatedDeliveryAt: refreshed.estimated_delivery_at,
        servicePolicies: policy.servicePolicies,
        signatureThresholdCents: signatureRequired
          ? 0
          : Number.MAX_SAFE_INTEGER,
      },
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
    const quotedRate = shipment.rates.find(
      (rate) => rate.postageType === shipment.selectedPostageType,
    );
    if (
      !originalRate &&
      quotedRate &&
      !isEquivalentSubstitution({
        original: quotedRate,
        substitute: selectedRate,
        introducesPickupDutyOrBrokerage: !alternateConditionsUnchanged,
      })
    ) {
      const substitutionConsented = shipment.orderId
        ? await hasSignedCustomerDecision({
            orderId: shipment.orderId,
            outcomes: ["accept_substitute"],
          })
        : false;
      const signatureConsented =
        !selectedRate.signatureRequired || quotedRate.signatureRequired
          ? true
          : shipment.orderId
            ? await hasSignedCustomerDecision({
                orderId: shipment.orderId,
                outcomes: ["accept_signature"],
              })
            : false;
      if (substitutionConsented && signatureConsented) {
        // The signed choice authorizes the otherwise non-equivalent service.
      } else {
        await releaseShipmentPurchaseClaim(
          shipment.id,
          "ready_for_staff",
          stripSignedLabelUrls(refreshed),
        );
        return NextResponse.json(
          {
            error: signatureConsented
              ? "This service change requires a signed customer decision"
              : "This service adds signature delivery and requires signed customer consent",
          },
          { status: 409 },
        );
      }
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
      actualPurchaseTotalCents: parseProviderMoneyCents(
        purchased.purchase_amount,
      ),
      actualPostageCents: parseProviderMoneyCents(purchased.postage_fee),
      actualInsuranceCents: parseProviderMoneyCents(purchased.insurance_fee),
      actualDeliveryFeeCents: parseProviderMoneyCents(purchased.delivery_fee),
      actualTariffFeeCents: parseProviderMoneyCents(purchased.tariff_fee),
      actualFdaPriorNotificationFeeCents: parseProviderMoneyCents(
        purchased.fda_prior_notification_fee,
      ),
      actualFederalTaxCents: parseProviderMoneyCents(purchased.federal_tax),
      actualProvincialTaxCents: parseProviderMoneyCents(
        purchased.provincial_tax,
      ),
      estimatedDeliveryAt: purchased.estimated_delivery_at,
    });
    if (!originalRate) {
      await sendShippingCustomerUpdate({
        to: shipment.orderCustomerEmail,
        orderReference: orderId,
        subject: "Your shipping service was updated",
        message: `We selected ${selectedRate.title}, an insured and tracked shipping service that meets the approved delivery and signature conditions for your order. There is no added charge.`,
        idempotencyKey: `shipping-substitution/${shipment.id}/${selectedRate.postageType}`,
      }).catch(() => undefined);
    }
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
        settledPurchaseCents: parseProviderMoneyCents(
          purchased.purchase_amount,
        ),
        ...(alternateReason ? { alternateReason } : {}),
        ...(alternatePostageType ? { alternateConditionsUnchanged } : {}),
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
    if (buyWasRequested)
      await sendShippingPolicyAlert({
        duties: ["operations_lead"],
        critical: true,
        subject: `Unknown postage purchase outcome: ${orderId}`,
        message:
          "A postage buy request may have succeeded. Stop retries and reconcile the stored provider shipment before any further purchase.",
        idempotencyKey: `shipping-buy-unknown/${shipment.id}`,
      }).catch(() => undefined);
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
