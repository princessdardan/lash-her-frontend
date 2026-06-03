import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { getAuditLogService } from "@/lib/admin/audit-log";
import { getAdminAuth } from "@/lib/admin/auth";
import { AdminAuthError, type AdminActor } from "@/lib/admin/types";
import { getAdminEnvironmentLabel } from "@/lib/env/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let actor: AdminActor;

  try {
    actor = await getAdminAuth().requireAdmin();
  } catch (error) {
    if (error instanceof AdminAuthError) {
      redirect("/admin/not-authorized");
    }

    throw error;
  }

  await getAuditLogService().record({
    action: "admin_access",
    actor,
    domain: "admin",
  });

  return (
    <AdminShell actor={actor} environmentLabel={getAdminEnvironmentLabel()}>
      {children}
    </AdminShell>
  );
}
