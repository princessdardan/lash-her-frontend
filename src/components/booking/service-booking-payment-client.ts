import { BookingHoldExpiredError } from "./square-card-on-file-form";

export interface PaidServiceCheckoutResult {
  checkoutUrl: string;
  holdReference: string;
  orderId: string;
  paymentProvider: "square";
  reused: boolean;
  squareOrderId?: string;
  squarePaymentLinkId?: string;
}

export async function startLegacySquareCheckout(
  paymentSessionReference: string,
  fetcher?: typeof fetch,
): Promise<PaidServiceCheckoutResult> {
  const f = fetcher ?? fetch;
  const checkoutRes = await f("/api/booking/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentSessionReference }),
  });

  if (!checkoutRes.ok) {
    const data = await checkoutRes.json().catch(() => ({}));

    if (checkoutRes.status === 409) {
      throw new BookingHoldExpiredError();
    }

    throw new Error(readResponseError(data, "Failed to start checkout"));
  }

  const checkoutData = (await checkoutRes.json()) as Record<string, unknown>;

  if (
    checkoutData.paymentProvider !== "square" ||
    typeof checkoutData.checkoutUrl !== "string" ||
    checkoutData.checkoutUrl.length === 0 ||
    typeof checkoutData.holdReference !== "string" ||
    checkoutData.holdReference.length === 0 ||
    typeof checkoutData.orderId !== "string" ||
    checkoutData.orderId.length === 0 ||
    typeof checkoutData.reused !== "boolean"
  ) {
    throw new Error("Failed to start checkout");
  }

  return {
    checkoutUrl: checkoutData.checkoutUrl,
    holdReference: checkoutData.holdReference,
    orderId: checkoutData.orderId,
    paymentProvider: "square",
    reused: checkoutData.reused,
    ...(typeof checkoutData.squareOrderId === "string"
      ? { squareOrderId: checkoutData.squareOrderId }
      : {}),
    ...(typeof checkoutData.squarePaymentLinkId === "string"
      ? { squarePaymentLinkId: checkoutData.squarePaymentLinkId }
      : {}),
  };
}

function readResponseError(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  }

  return fallback;
}
