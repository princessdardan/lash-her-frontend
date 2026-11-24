import "server-only";

import { notFound, redirect } from "next/navigation";
import {
  communityAccountEnabled,
  communityReadsEnabled,
} from "@/lib/api-integration/community-discussions";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { customerSignInHref } from "@/lib/learning/presentation";

export function communityPagesEnabled(): boolean {
  return communityReadsEnabled() && communityAccountEnabled();
}

export async function requireCommunitySession(path: string) {
  if (!communityPagesEnabled()) notFound();
  if (!(await getCustomerActor())) redirect(customerSignInHref(path));
}
