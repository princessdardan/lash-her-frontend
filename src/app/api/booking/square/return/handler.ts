import { redirect } from "next/navigation";

import { finalizeSquarePayment } from "@/lib/booking/square-payment-finalizer";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

export const runtime = "nodejs";

interface SquareReturnDependencies {
  finalizeSquarePayment: typeof finalizeSquarePayment;
  redirectTo: (url: string) => never;
}

export const defaultDependencies: SquareReturnDependencies = {
  finalizeSquarePayment,
  redirectTo: redirect,
};

export const GET = createSquareReturnGetHandler(defaultDependencies);

export function createSquareReturnGetHandler(
  dependencies: SquareReturnDependencies,
  runRecovery: (task: () => Promise<string>) => Promise<string> = task => task(),
): (req: Request) => Promise<Response> {
  return async function getSquareReturn(req) {
    const url = new URL(req.url);
    const orderId = getFirstQueryValue(url, ["orderId", "order_id", "reference_id"]);
    const paymentId = getFirstQueryValue(url, ["paymentId", "payment_id", "transactionId", "transaction_id"]);

    let paymentStatus: string;

    try {
      paymentStatus = await runRecovery(async () => {
        try {
          const result = await dependencies.finalizeSquarePayment({
            orderId,
            paymentId,
            source: "return",
          });
          return result.status;
        } catch (error) {
          markWriterOperationUncertain();
          console.error("[square-return] Square payment reconciliation failed", {
            error: error instanceof Error ? error.message : "Unknown finalization error",
          });
          return "manual_review";
        }
      });
    } catch (error) {
      if (!(error instanceof WriterAdmissionError)) throw error;
      return Response.json({ error: "This operation is temporarily unavailable. Please retry shortly." }, {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "30" },
      });
    }

    // Next's redirect throws. Settle the operation first so its control-flow
    // exception cannot turn successful recovery into an uncertain operation.
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
