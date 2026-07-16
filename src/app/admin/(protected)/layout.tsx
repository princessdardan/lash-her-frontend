import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getAdminEnvironmentLabel } from "@/lib/env/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ProtectedAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const actor = await requireAdminPagePermission("admin:view");

  return (
    <AdminShell actor={actor} environmentLabel={getAdminEnvironmentLabel()}>
      {children}
    </AdminShell>
  );
}
