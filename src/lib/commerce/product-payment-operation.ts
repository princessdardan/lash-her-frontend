export interface ProductPaymentOperationResult {
  paymentUrl?: string;
  operationId: string;
  status: string;
  error?: string;
}

interface ProductPaymentOperationResponse {
  paymentUrl?: string;
  operationId?: string;
  status?: string;
  error?: string;
}

export async function waitForProductPaymentOperation(input: {
  operationId: string;
  fetchOperation?: typeof fetch;
  maxAttempts?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<ProductPaymentOperationResult> {
  const operationId = input.operationId.trim();
  if (!operationId) throw new Error("Payment operation ID is required");
  const fetchOperation = input.fetchOperation ?? fetch;
  const maxAttempts = input.maxAttempts ?? 150;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const wait = input.wait ?? waitForDelay;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await wait(pollIntervalMs);
    const response = await fetchOperation(
      `/api/checkout/payment-operations/${encodeURIComponent(operationId)}`,
      { cache: "no-store" },
    );
    const result = (await response.json()) as ProductPaymentOperationResponse;

    if (response.status === 202) {
      if (result.status === "queued" || result.status === "processing")
        continue;
      return {
        operationId,
        status: "failed",
        error: "Payment setup returned an invalid pending status.",
      };
    }

    return {
      operationId,
      status: result.status ?? (response.ok ? "ready" : "failed"),
      ...(result.paymentUrl ? { paymentUrl: result.paymentUrl } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }

  return {
    operationId,
    status: "failed",
    error:
      "Secure payment setup is taking longer than expected. Contact Lash Her before retrying.",
  };
}

function waitForDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
