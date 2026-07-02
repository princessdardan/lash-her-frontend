export interface SquareReturnOrderIdClassification {
  localOrderId?: string;
  providerOrderId?: string;
}

const LOCAL_SERVICE_BOOKING_ORDER_ID_PATTERN = /^lh-sq-[A-Za-z0-9_-]+$/;

export function isLocalServiceBookingOrderId(
  value: string | undefined,
): boolean {
  return (
    typeof value === "string" &&
    LOCAL_SERVICE_BOOKING_ORDER_ID_PATTERN.test(value)
  );
}

export function classifySquareReturnOrderId(
  value: string | undefined,
): SquareReturnOrderIdClassification {
  if (value === undefined || value.trim().length === 0) {
    return { localOrderId: undefined, providerOrderId: undefined };
  }

  const trimmed = value.trim();

  if (isLocalServiceBookingOrderId(trimmed)) {
    return { localOrderId: trimmed, providerOrderId: undefined };
  }

  return { localOrderId: undefined, providerOrderId: trimmed };
}
