import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { listAdminDeveloperUserOptions } from "@/lib/admin/developer-mode";
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
  const developerUsers = actor.developerMode
    ? await listAdminDeveloperUserOptions()
    : [];

  return (
    <AdminShell
      actor={actor}
      developerUsers={developerUsers}
      environmentLabel={getAdminEnvironmentLabel()}
    >
      {children}
    </AdminShell>
  );
}
