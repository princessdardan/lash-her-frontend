import { AdminCard } from "@/components/admin/admin-card";
import { StatusPill } from "@/components/admin/status-pill";
import { requirePermission } from "@/lib/admin/auth";
import { getVisibleAdminSections } from "@/lib/admin/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminOverviewPage() {
  const actor = await requirePermission("admin:view");
  const visibleSections = getVisibleAdminSections({
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });

  return (
    <div className="space-y-8">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Operations access
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Admin overview
        </h1>
        <p className="mt-3 max-w-2xl text-lh-muted">
          Access is derived from the active PostgreSQL staff profile shown below. Google provides identity only.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <AdminCard label="Account status" value={<StatusPill tone="success">Active</StatusPill>}>
          Disabled profiles are rejected on the next request.
        </AdminCard>
        <AdminCard label="Role" value={actor.user.role}>
          Roles and permissions are managed in the private operational database.
        </AdminCard>
        <AdminCard label="Assigned resources" value={actor.bookingResourceIds.length}>
          Employee booking and schedule access is limited to these resources.
        </AdminCard>
      </div>
      <section className="rounded-2xl border border-lh-line bg-white p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Effective access
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {visibleSections.map((section) => (
            <StatusPill key={section}>{section}</StatusPill>
          ))}
        </div>
      </section>
    </div>
  );
}
