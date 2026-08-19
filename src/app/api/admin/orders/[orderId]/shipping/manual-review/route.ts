import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  void context;
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
  return NextResponse.json(
    {
      error:
        "Use the operations workspace to acknowledge the exact shipment version with evidence and step-up authentication",
    },
    { status: 409 },
  );
}
