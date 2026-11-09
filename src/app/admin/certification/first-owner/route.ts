import { auth } from "@/auth";
import { getAdminAuth } from "@/lib/admin/auth";
import { assertFirstOwnerGoogleAuthentication } from "@/lib/admin/authentication-freshness";
import { runAdminAuthorizationOperation } from "@/lib/admin/authorization-operation";
import { AdminAuthError, AdminAuthenticationFreshnessError } from "@/lib/admin/types";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { currentWriterFirstOwner } from "@/lib/writer-admission/context";
import { readInteractiveBrowserRequest } from "@/lib/writer-admission/interactive-proof";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const privateHeaders = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  const selection = (await readInteractiveBrowserRequest())?.firstOwner;
  if (!selection || new URL(request.url).search) return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const session = await auth();
    assertFirstOwnerGoogleAuthentication(selection, session?.user?.authenticatedAt, session?.user?.firstOwnerWindowSha256, Date.now());
    const actor = await runAdminAuthorizationOperation(() => {
      const scoped = currentWriterFirstOwner();
      if (scoped?.nonce !== selection.nonce || scoped.identityDigest !== selection.identityDigest || scoped.epoch !== selection.epoch ||
        scoped.startedAt !== selection.startedAt) throw new AdminAuthError("forbidden");
      return getAdminAuth().requireActor();
    });
    return Response.json({ actorKind: "admin", actorId: actor.user.id, sessionVerified: true }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof AdminAuthError || error instanceof AdminAuthenticationFreshnessError) {
      return new Response(null, { status: 403, headers: privateHeaders });
    }
    if (error instanceof WriterAdmissionError) return new Response(null, { status: 503, headers: privateHeaders });
    throw error;
  }
}
