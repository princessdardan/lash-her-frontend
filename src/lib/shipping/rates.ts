import type { ProductShipmentRateSnapshot } from "@/lib/private-db/schema";
import type { ChitChatsRate } from "./types";
import {
  parseDeliveryMaxBusinessDays,
  signatureIsAvailable,
} from "./policy-rules";
import { type ShippingServicePolicy } from "./policy";

export function selectCustomerRates(
  rates: readonly ChitChatsRate[],
  trackedPostageTypes: ReadonlySet<string>,
  options: {
    atRiskValueCents: number;
    destinationCountryCode: string;
    estimatedDeliveryAt?: string | null;
    servicePolicies: ReadonlyMap<string, ShippingServicePolicy>;
    signatureThresholdCents: number;
  },
): ProductShipmentRateSnapshot[] {
  const signatureRequired =
    options.atRiskValueCents >= options.signatureThresholdCents;
  return rates
    .flatMap((rate) => {
      const paymentAmountCents = moneyToCents(rate.payment_amount);
      const insuranceFeeCents = moneyToCents(rate.insurance_fee ?? 0);
      const tracked =
        trackedPostageTypes.has(rate.postage_type) &&
        /tracking/i.test(rate.tracking_type_description ?? "");
      const policy = options.servicePolicies.get(
        `${rate.postage_type}:${options.destinationCountryCode.toUpperCase()}`,
      );
      const signatureAvailable =
        policy?.signatureCapable === true &&
        signatureIsAvailable(rate.signature_confirmation_description);
      if (
        !tracked ||
        rate.is_insured !== true ||
        paymentAmountCents <= 0 ||
        !policy ||
        options.atRiskValueCents > policy.insuranceLimitCents ||
        (signatureRequired && !signatureAvailable)
      )
        return [];

      const estimatedDeliveryAt = validFutureInstant(
        options.estimatedDeliveryAt,
      );
      const deliveryMaxBusinessDays = parseDeliveryMaxBusinessDays(
        rate.delivery_time_description,
      );

      return [
        {
          id: rate.postage_type,
          postageType: rate.postage_type,
          title: rate.postage_description?.trim() || rate.postage_type,
          ...(rate.postage_carrier_type
            ? { carrier: rate.postage_carrier_type }
            : {}),
          ...(rate.delivery_time_description
            ? { deliveryEstimate: rate.delivery_time_description }
            : {}),
          ...(deliveryMaxBusinessDays ? { deliveryMaxBusinessDays } : {}),
          ...(estimatedDeliveryAt ? { estimatedDeliveryAt } : {}),
          signatureAvailable,
          signatureRequired,
          paymentAmountCents,
          insuranceFeeCents,
          insured: true,
          tracked: true,
          raw: stripUnknownUrls(rate),
        },
      ];
    })
    .sort((left, right) => left.paymentAmountCents - right.paymentAmountCents);
}

function validFutureInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function moneyToCents(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function stripUnknownUrls(rate: ChitChatsRate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(rate).filter(([key]) => !key.toLowerCase().includes("url")),
  );
}
