"use server";

import { notFound } from "next/navigation";

import { signIn } from "@/auth";
import { getAcademyConfig } from "@/lib/academy/config";
import { getSafeAcademyReturnTo } from "@/lib/academy/urls";

export async function signInToAcademyAction(formData: FormData): Promise<void> {
  if (!getAcademyConfig().enabled) notFound();
  await signIn("google", {
    redirectTo: getSafeAcademyReturnTo(formData.get("returnTo")),
  });
}
