import { withWriterAdmission } from "@/lib/writer-admission/route";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAudit } from "@/lib/admin/audit-log";
import { completeInstallation } from "@/lib/highlevel/oauth";
import { callbackUrl } from "@/lib/highlevel/config";
import { HighLevelError } from "@/lib/highlevel/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGet(request: Request): Promise<Response> {
  const actor = await requirePermission("settings:manage");
  const url = new URL(request.url);
  try {
    await completeInstallation(
      actor.user.id,
      url.searchParams.get("state") ?? "",
      url.searchParams.get("code") ?? "",
    );
    await recordAdminAudit({
      actor,
      action: "highlevel.install_completed",
      domain: "marketing",
      outcome: "success",
    });
  } catch (error) {
    markWriterOperationUncertain();
    return Response.json(
      {
        error:
          error instanceof HighLevelError
            ? error.code
            : "oauth_installation_failed",
      },
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
  return NextResponse.redirect(
    new URL("/admin/marketing/highlevel", callbackUrl()),
    {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export const GET = withWriterAdmission("recovery", handleGet);
