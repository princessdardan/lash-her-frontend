import type { TrainingSplitResult } from "@/lib/commerce/square-training-split";

interface Dependencies {
  findOrder(reservationKey: string): Promise<{
    orderId: string;
    customerEmail: string;
    isSplit: boolean;
  } | null>;
  recover(orderReference: string): Promise<TrainingSplitResult>;
}

export function createSplitStatusHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    if (!body || typeof body !== "object")
      return Response.json({ error: "Invalid request" }, { status: 400 });
    const { reservationKey, customerEmail } = body as Record<string, unknown>;
    if (
      typeof reservationKey !== "string" ||
      !/^[a-zA-Z0-9_-]{16,64}$/.test(reservationKey) ||
      typeof customerEmail !== "string" ||
      customerEmail.length > 320
    )
      return Response.json({ error: "Invalid request" }, { status: 400 });
    try {
      const order = await deps.findOrder(reservationKey);
      if (
        !order?.isSplit ||
        order.customerEmail.trim().toLowerCase() !==
          customerEmail.trim().toLowerCase()
      )
        return Response.json(
          {
            error:
              "Payment could not be found. Please contact Lash Her before starting another payment.",
          },
          { status: 404 },
        );
      const result = await deps.recover(order.orderId);
      if (result.ok)
        return Response.json({ orderId: order.orderId, status: "paid" });
      return Response.json(
        {
          error: result.retryWithNewReservation
            ? "Neither payment was completed. Please try again or choose another payment method."
            : result.reason === "split_payment_requires_review"
              ? "Your payment needs review. Please contact Lash Her before making another payment."
              : "Your payment is still being confirmed. Check again before starting another payment.",
          retryWithNewReservation: result.retryWithNewReservation,
        },
        { status: result.retryWithNewReservation ? 402 : 503 },
      );
    } catch {
      return Response.json(
        { error: "Your payment is still being confirmed. Please check again." },
        { status: 503 },
      );
    }
  };
}

export async function POST(req: Request): Promise<Response> {
  const [
    { findCheckoutOrderByOrderId, deriveDeterministicOrderId },
    { chargeLiveTrainingSplit },
  ] = await Promise.all([
    import("@/lib/commerce/order-store"),
    import("@/lib/commerce/square-training-split-live"),
  ]);
  return createSplitStatusHandler({
    findOrder: async (key) => {
      const order = await findCheckoutOrderByOrderId(
        deriveDeterministicOrderId(key),
      );
      return order
        ? {
            orderId: order.orderId,
            customerEmail: order.customerEmail,
            isSplit:
              order.purpose === "training" &&
              order.paymentProvider === "square" &&
              order.providerMetadata?.flow === "training_square_split",
          }
        : null;
    },
    recover: (orderReference) =>
      chargeLiveTrainingSplit({
        orderReference,
        origin: new URL(req.url).origin,
      }),
  })(req);
}
