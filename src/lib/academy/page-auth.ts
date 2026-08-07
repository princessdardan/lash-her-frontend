import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { isActiveCustomerUser } from "@/lib/customer-identity/status";
import { getAcademyPrincipal, type AcademyPrincipal } from "./auth";
import { academySignInUrl } from "./urls";

export async function requireAcademyPagePrincipal(
  returnTo?: string,
): Promise<AcademyPrincipal> {
  const principal = getAcademyPrincipal(await auth());
  if (!principal) redirect(academySignInUrl(returnTo));
  if (!(await isActiveCustomerUser(principal.userId))) {
    redirect(academySignInUrl(returnTo));
  }
  return principal;
}
