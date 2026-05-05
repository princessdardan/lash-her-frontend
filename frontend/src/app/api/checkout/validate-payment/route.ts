import { NextResponse, type NextRequest } from "next/server";
import {
  getPendingOrderByCheckoutToken,
  markOrderPaid,
  markOrderVerificationFailed,
} from "@/lib/commerce/order-store";
import { validateHelcimResponseHash } from "@/lib/commerce/helcim-hash";
import type { HelcimPayloadValue } from "@/lib/commerce/helcim-types";

interface ValidatePaymentBody {
  checkoutToken: string;
  data: Record<string, HelcimPayloadValue>;
  hash: string;
}

function isValidBody(body: unknown): body is ValidatePaymentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.checkoutToken !== "string") return false;
  if (typeof b.hash !== "string") return false;
  if (!b.data || typeof b.data !== "object") return false;

  for (const value of Object.values(b.data)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body: unknown = await req.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { checkoutToken, data, hash } = body;

    const order = await getPendingOrderByCheckoutToken(checkoutToken);

    if (!order) {
      return NextResponse.json(
        { error: "Checkout session not found" },
        { status: 404 }
      );
    }

    const isValid = validateHelcimResponseHash(data, order.secretToken, hash);

    if (!isValid) {
      await markOrderVerificationFailed(order.orderId);
      return NextResponse.json(
        { error: "Payment could not be verified" },
        { status: 400 }
      );
    }

    const transactionId = data.transactionId ?? data.id;

    if (typeof transactionId !== "string" && typeof transactionId !== "number") {
      await markOrderVerificationFailed(order.orderId);
      return NextResponse.json(
        { error: "Payment response missing transaction ID" },
        { status: 400 }
      );
    }

    await markOrderPaid(order.orderId, String(transactionId));

    return NextResponse.json({ orderId: order.orderId });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
