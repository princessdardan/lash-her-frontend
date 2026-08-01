"use server";

import { redirect } from "next/navigation";

import { signIn, signOut } from "@/auth";
import {
  authorizeAdminDeveloperAccess,
  clearAdminDeveloperSession,
  hasAdminDeveloperSession,
  setAdminDeveloperSession,
} from "@/lib/admin/developer-mode";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";
import type { AdminRole } from "@/lib/admin/types";

export async function signInWithGoogleAction(
  formData: FormData,
): Promise<void> {
  const returnTo = getSafeAdminReturnTo(formData.get("returnTo"));

  await signIn("google", { redirectTo: returnTo });
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
