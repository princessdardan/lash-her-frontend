import { nanoid } from "nanoid";
import { redirect } from "next/navigation";

import { assertEmployeeOwnsCalendarConnection } from "@/lib/admin/employee-calendar";
import { getCalendarConnectionOAuthConsentUrl } from "@/lib/booking/google-calendar";
import { saveBookingCalendarOAuthState } from "@/lib/booking/operational-store";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const resourceId = new URL(request.url).searchParams.get("resourceId")?.trim();
  if (!resourceId) {
    return Response.json({ error: "Booking resource is required" }, { status: 400 });
  }

  const actor = await assertEmployeeOwnsCalendarConnection({
    connectionId: id,
    resourceId,
  });
  const state = `calendar_${nanoid(32)}`;
  const stored = await saveBookingCalendarOAuthState({
    payload: {
      actorAdminUserId: actor.user.id,
      connectionId: id,
      flowType: "employee",
      resourceId,
      returnTo: "/admin/my-calendar",
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
