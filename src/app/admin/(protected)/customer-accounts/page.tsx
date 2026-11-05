import { notFound } from "next/navigation";
import { requireAdminActor } from "@/lib/admin/auth";
import { AdminAccountControls } from "@/components/customer-auth/admin-account-controls";
import { isAccountLifecycleEnabled } from "@/lib/customer-lifecycle/handler";
export const dynamic = "force-dynamic";
export default async function CustomerAccountsPage() {
  if (!isAccountLifecycleEnabled()) notFound();
  const actor = await requireAdminActor();
  if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) notFound();
  return <main className="space-y-6 p-6"><h1 className="text-2xl font-semibold">Customer account lifecycle</h1><p>Account actions require a recent owner Google sign-in. Suspension and deletion revoke frontend sessions immediately. Deletion is terminal; financial and separate marketing retention remain in effect.</p><AdminAccountControls /></main>;
}
