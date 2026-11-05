import { withWriterAdmission } from "@/lib/writer-admission/route";
import { nanoid } from "nanoid";

import { assertEmployeeOwnsCalendarConnection } from "@/lib/admin/employee-calendar";
import { getCalendarConnectionOAuthConsentUrl } from "@/lib/booking/google-calendar";
import { saveBookingCalendarOAuthState } from "@/lib/booking/operational-store";

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const resourceId = new URL(request.url).searchParams
    .get("resourceId")
    ?.trim();
  if (!resourceId) {
    return Response.json(
      { error: "Booking resource is required" },
      { status: 400 },
    );
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

  return Response.redirect(getCalendarConnectionOAuthConsentUrl(state), 307);
}

export const GET = withWriterAdmission("new-work", handleGet);
