import type { ReactNode } from "react";
import { notFound } from "next/navigation";

import { getAcademyConfig } from "@/lib/academy/config";
import { requireAcademyPagePrincipal } from "@/lib/academy/page-auth";
import { academyDashboardUrl } from "@/lib/academy/urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ProtectedAcademyLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (!getAcademyConfig().enabled) notFound();
  await requireAcademyPagePrincipal(academyDashboardUrl());
  return children;
}
