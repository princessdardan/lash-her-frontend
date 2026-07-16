"use server";

import { signIn, signOut } from "@/auth";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";

export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const returnTo = getSafeAdminReturnTo(formData.get("returnTo"));

  await signIn("google", { redirectTo: returnTo });
}

export async function signOutAdminAction(): Promise<void> {
  await signOut({ redirectTo: "/admin/sign-in" });
}
