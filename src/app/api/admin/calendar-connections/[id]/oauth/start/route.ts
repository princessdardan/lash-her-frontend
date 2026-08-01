import { nanoid } from "nanoid";
import { redirect } from "next/navigation";

import { getCalendarConnectionOAuthConsentUrl } from "@/lib/booking/google-calendar";
import { saveBookingCalendarOAuthState } from "@/lib/booking/operational-store";
import { requirePermission } from "@/lib/admin/auth";
import { createDrizzleCalendarConnectionRepository } from "@/lib/private-db/calendar-connection-repository";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const actor = await requirePermission("calendar-connections:manage");
  const { id } = await params;
  const repository = createDrizzleCalendarConnectionRepository();
  const connections = await repository.listConnections();

  if (!connections.some((connection) => connection.id === id)) {
    return Response.json({ error: "Calendar connection not found" }, { status: 404 });
  }

  void request;
  const returnTo = "/admin/calendar-connections";
  const state = `calendar_${nanoid(32)}`;
  const stored = await saveBookingCalendarOAuthState({
    payload: {
      actorAdminUserId: actor.user.id,
      connectionId: id,
      flowType: "admin",
      resourceId: null,
      returnTo,
    },
    state,
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
  });

  if (!stored) {
    return Response.json(
      { error: "Could not start calendar authorization" },
      { status: 503 },
    );
  }

  redirect(getCalendarConnectionOAuthConsentUrl(state));
}
