"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { signIn, signOut } from "@/auth";
import {
  authorizeAdminDeveloperAccess,
  clearAdminDeveloperSession,
  hasAdminDeveloperSession,
  setAdminDeveloperSession,
} from "@/lib/admin/developer-mode";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";
import { requireAdminActor } from "@/lib/admin/auth";
import {
  ADMIN_STEP_UP_CHALLENGE_TTL_MS,
  ADMIN_STEP_UP_PENDING_COOKIE,
  createPendingStepUpChallenge,
} from "@/lib/admin/step-up-proof";
import type { AdminRole } from "@/lib/admin/types";

export async function signInWithGoogleAction(
  formData: FormData,
): Promise<void> {
  const returnTo = getSafeAdminReturnTo(formData.get("returnTo"));

  await signIn("google", { redirectTo: returnTo });
}

export async function stepUpWithGoogleAction(
  formData: FormData,
): Promise<void> {
  const returnTo = getSafeAdminReturnTo(formData.get("returnTo"));
  const action = getRequiredFormValue(formData, "action");
  const target = getRequiredFormValue(formData, "target");
  const actor = await requireAdminActor();
  const pendingChallenge = createPendingStepUpChallenge({
    action,
    actorAdminUserId: actor.user.id,
    target,
  });
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_STEP_UP_PENDING_COOKIE, pendingChallenge, {
    httpOnly: true,
    maxAge: Math.floor(ADMIN_STEP_UP_CHALLENGE_TTL_MS / 1_000),
    path: "/admin/step-up",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  const completionQuery = new URLSearchParams({ returnTo });

  await signIn(
    "google",
    { redirectTo: `/admin/step-up/complete?${completionQuery.toString()}` },
    { max_age: "0", prompt: "login" },
  );
}

export async function signOutAdminAction(): Promise<void> {
  const hadDeveloperSession = await hasAdminDeveloperSession();
  await clearAdminDeveloperSession();
  if (hadDeveloperSession) {
    redirect("/admin/sign-in");
  }

  await signOut({ redirectTo: "/admin/sign-in" });
}

export async function authorizeAdminDeveloperAccessAction(
  formData: FormData,
): Promise<void> {
  const returnTo = getSafeAdminReturnTo(formData.get("returnTo"));
  const candidateAccessKey = getRequiredFormValue(formData, "accessKey");
  const authorized =
    candidateAccessKey.length <= 512 &&
    (await authorizeAdminDeveloperAccess(candidateAccessKey));

  const query = new URLSearchParams({ returnTo });
  if (!authorized) {
    query.set("developerError", "invalid_access_key");
  }
  redirect(`/admin/sign-in?${query.toString()}`);
}

export async function setAdminDeveloperSessionAction(
  formData: FormData,
): Promise<void> {
  const actingAdminUserId = getRequiredFormValue(formData, "actingAdminUserId");
  const permissionRole = getRequiredFormValue(formData, "permissionRole");
  if (!isAdminRole(permissionRole)) {
    throw new Error("Invalid developer permission level");
  }

  await setAdminDeveloperSession({ actingAdminUserId, permissionRole });
  redirect(getSafeAdminReturnTo(formData.get("returnTo")));
}

function getRequiredFormValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${name}`);
  }
  return value.trim();
}

function isAdminRole(value: string): value is AdminRole {
  return value === "owner" || value === "admin" || value === "employee";
}
