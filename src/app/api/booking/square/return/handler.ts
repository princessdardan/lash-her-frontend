import { redirect } from "next/navigation";

import { finalizeSquarePayment } from "@/lib/booking/square-payment-finalizer";

export const runtime = "nodejs";

interface SquareReturnDependencies {
  finalizeSquarePayment: typeof finalizeSquarePayment;
  redirectTo: (url: string) => never;
}

const defaultDependencies: SquareReturnDependencies = {
  finalizeSquarePayment,
  redirectTo: redirect,
};

export const GET = createSquareReturnGetHandler(defaultDependencies);

export function createSquareReturnGetHandler(
  dependencies: SquareReturnDependencies,
): (req: Request) => Promise<Response> {
  return async function getSquareReturn(req) {
    const url = new URL(req.url);
    const orderId = getFirstQueryValue(url, ["orderId", "order_id", "reference_id"]);
    const paymentId = getFirstQueryValue(url, ["paymentId", "payment_id", "transactionId", "transaction_id"]);

    let paymentStatus: string;

    try {
      const result = await dependencies.finalizeSquarePayment({
        orderId,
        paymentId,
        source: "return",
      });

      paymentStatus = result.status;
    } catch (error) {
      console.error("[square-return] Square payment reconciliation failed", {
        error: error instanceof Error ? error.message : "Unknown finalization error",
      });
      paymentStatus = "manual_review";
    }

    dependencies.redirectTo(buildConfirmationUrl(url, paymentStatus));
  };
}

function getFirstQueryValue(url: URL, names: string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);

    if (value !== null && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function buildConfirmationUrl(url: URL, status: string): string {
  const confirmationUrl = new URL("/booking/confirmation", url.origin);
  confirmationUrl.searchParams.set("payment", status);
  return confirmationUrl.toString();
}
