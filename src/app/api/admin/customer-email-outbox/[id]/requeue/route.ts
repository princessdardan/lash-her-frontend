import { NextResponse, type NextRequest } from "next/server";

import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { requirePermission } from "@/lib/admin/auth";
import { requeueDeadLetterCustomerEmail } from "@/lib/commerce/customer-email-outbox";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  if (actor.user.role !== "owner") {
    return NextResponse.json(
      { error: "Only the business owner may requeue customer notifications" },
      { status: 403 },
    );
  }
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  }
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Notification ID is invalid" },
      { status: 400 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const conflictToken =
    typeof body?.expectedConflictToken === "string"
      ? body.expectedConflictToken.trim()
      : "";
  const prefix = `${id}:`;
  const timestampSeparator = conflictToken.lastIndexOf(":");
  if (
    !conflictToken.startsWith(prefix) ||
    timestampSeparator <= prefix.length
  ) {
    return NextResponse.json(
      { error: "Notification version is invalid; refresh the queue" },
      { status: 409 },
    );
  }
  const expectedUpdatedAtMs = Number(
    conflictToken.slice(timestampSeparator + 1),
  );
  if (!Number.isSafeInteger(expectedUpdatedAtMs) || expectedUpdatedAtMs <= 0) {
    return NextResponse.json(
      { error: "Notification version is invalid; refresh the queue" },
      { status: 409 },
    );
  }
  const requeued = await requeueDeadLetterCustomerEmail({
    expectedUpdatedAt: new Date(expectedUpdatedAtMs),
    id,
  });
  if (!requeued) {
    return NextResponse.json(
      { error: "Notification changed or is no longer dead-lettered" },
      { status: 409 },
    );
  }
  await recordAdminAuditBestEffort({
    action: "fulfillment.customer_email_requeued",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: id,
    targetType: "customer_email_outbox",
  });
  return NextResponse.json({ id, status: "queued" }, { status: 202 });
}
