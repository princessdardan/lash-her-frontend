import { NextResponse, type NextRequest } from "next/server";

import {
  requireAdminActor,
  requireFreshAdminGoogleAuthentication,
} from "@/lib/admin/auth";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";
import {
  ADMIN_STEP_UP_PENDING_COOKIE,
  ADMIN_STEP_UP_PROOF_COOKIE,
  assertStepUpReauthenticationCompleted,
  issueAdminStepUpProof,
  verifyPendingStepUpChallenge,
} from "@/lib/admin/step-up-proof";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const actor = await requireAdminActor();
  const authenticatedAt = await requireFreshAdminGoogleAuthentication(60_000);
  const pendingToken = request.cookies.get(ADMIN_STEP_UP_PENDING_COOKIE)?.value;
  if (!pendingToken) {
    return NextResponse.json(
      { error: "Step-up challenge is missing" },
      { status: 409 },
    );
  }
  const challenge = verifyPendingStepUpChallenge({
    actorAdminUserId: actor.user.id,
    token: pendingToken,
  });
  assertStepUpReauthenticationCompleted({
    authenticatedAt,
    challengeIssuedAt: challenge.issuedAt,
  });
  const proof = await issueAdminStepUpProof({
    action: challenge.action,
    actorAdminUserId: actor.user.id,
    authenticatedAt,
    target: challenge.target,
  });
  const returnTo = getSafeAdminReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
  );
  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(ADMIN_STEP_UP_PENDING_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/admin/step-up",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.set(ADMIN_STEP_UP_PROOF_COOKIE, proof.token, {
    expires: proof.expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
