import type { ProductShipmentRateSnapshot } from "@/lib/private-db/schema";
import type { ChitChatsRate } from "./types";

export function selectCustomerRates(
  rates: readonly ChitChatsRate[],
  trackedPostageTypes: ReadonlySet<string>,
): ProductShipmentRateSnapshot[] {
  return rates
    .flatMap((rate) => {
      const paymentAmountCents = moneyToCents(rate.payment_amount);
      const insuranceFeeCents = moneyToCents(rate.insurance_fee ?? 0);
      const tracked =
        trackedPostageTypes.has(rate.postage_type) &&
        /tracking/i.test(rate.tracking_type_description ?? "");
      if (!tracked || rate.is_insured !== true || paymentAmountCents <= 0)
        return [];

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
