"use server";

import { processLandingPageSignup } from "@/lib/landing-pages/signup";
import type {
  LandingPageSignupInput,
  LandingPageSignupResult,
} from "@/lib/landing-pages/contract";

export async function submitLandingPageSignup(
  input: LandingPageSignupInput,
): Promise<LandingPageSignupResult> {
  return processLandingPageSignup(input);
}
