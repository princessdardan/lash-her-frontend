import { redirect } from "next/navigation";

import { AdminWorkspaceHeader } from "@/components/admin/admin-workspace-list";
import {
  PackageProfileControls,
  type PackageProfileView,
} from "@/components/admin/package-profile-controls";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { listAllPackageProfiles } from "@/lib/shipping/package-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminShippingPackagesPage() {
  // `fulfillment:manage` is granted to the `admin` role too, so gate the page on
  // the configured fulfillment owner as well — matching the mutation routes, so a
  // non-owner admin cannot read the box list by navigating to the URL directly.
  const actor = await requireAdminPagePermission("fulfillment:manage");
  try {
    await assertConfiguredFulfillmentOwner(actor.user.id);
  } catch {
    redirect("/admin/not-authorized");
  }
  const profiles = (await listAllPackageProfiles()).map(
    (row): PackageProfileView => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      rank: row.rank,
      packageType: row.packageType,
      lengthCm: row.lengthCm,
      widthCm: row.widthCm,
      heightCm: row.heightCm,
      tareWeightGrams: row.tareWeightGrams,
      maxWeightGrams: row.maxWeightGrams,
      acceptsRigid: row.acceptsRigid,
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewEvidenceVersion: row.reviewEvidenceVersion,
      evidenceReference: row.evidenceReference,
    }),
  );

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <p>
            Physical shipping boxes the checkout packer selects from. Create a
            box as a draft, then approve it — approval requires a fresh Google
            step-up and records the owner evidence the database requires before
            a box may go live. Only enabled boxes are offered to checkout, so at
            least one enabled box is required for shipping rates to return.
          </p>
        }
        eyebrow="Settings"
        title="Shipping packages"
      />
      <PackageProfileControls profiles={profiles} />
    </div>
  );
}
