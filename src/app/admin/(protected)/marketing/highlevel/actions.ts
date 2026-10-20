"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAudit } from "@/lib/admin/audit-log";
import { getPrivateDb } from "@/lib/private-db/client";
import { deleteReviewedCrmCopy } from "@/lib/highlevel/retention";
import { createInstallation } from "@/lib/highlevel/oauth";

export async function installHighLevel(): Promise<void> {
  const actor = await requirePermission("settings:manage");
  const installation = await createInstallation(actor.user.id);
  await recordAdminAudit({
    actor,
    action: "highlevel.install_started",
    domain: "marketing",
    outcome: "success",
  });
  redirect(installation.url);
}

export async function replayHighLevelJob(form: FormData): Promise<void> {
  const actor = await requirePermission("marketing:manage");
  const id = String(form.get("id") ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid job");
  // The effect ledger is deliberately preserved. Replaying never authorizes an
  // uncertain task, note, opportunity, or enrollment to run a second time.
  await getPrivateDb().execute(
    sql`update highlevel_outbox set status = 'queued', attempts = 0, next_run_at = now(), last_error = null where id = ${id}::uuid and status in ('review','dead_letter','retry')`,
  );
  await recordAdminAudit({
    actor,
    action: "highlevel.job_replayed",
    domain: "marketing",
    outcome: "success",
    targetId: id,
    targetType: "crm_job",
  });
  revalidatePath("/admin/marketing/highlevel");
}

export async function resolveHighLevelEffect(form: FormData): Promise<void> {
  const actor = await requirePermission("marketing:manage");
  const key = String(form.get("key") ?? "");
  const outcome = String(form.get("outcome") ?? "");
  const reference = String(form.get("reference") ?? "").trim();
  const providerId = String(form.get("providerId") ?? "").trim();
  if (
    !key ||
    key.length > 500 ||
    reference.length < 8 ||
    reference.length > 200 ||
    !["confirmed", "absent"].includes(outcome) ||
    form.get("reviewed") !== "on"
  )
    throw new Error(
      "Reconcile the provider execution log before resolving this effect.",
    );
  if (outcome === "confirmed" && !/^[a-zA-Z0-9_-]{1,100}$/.test(providerId))
    throw new Error("A verified provider record or workflow ID is required.");
  const db = getPrivateDb();
  if (outcome === "confirmed")
    await db.execute(
      sql`update highlevel_effects set state = 'succeeded', provider_id = ${providerId}, updated_at = now() where key = ${key} and state = 'pending'`,
    );
  else
    await db.execute(
      sql`delete from highlevel_effects where key = ${key} and state = 'pending'`,
    );
  await recordAdminAudit({
    actor,
    action: "highlevel.effect_reconciled",
    domain: "marketing",
    outcome: "success",
    targetId: key,
    targetType: "crm_effect",
    metadata: { resolution: outcome, evidenceReference: reference },
  });
  revalidatePath("/admin/marketing/highlevel");
}

export async function deleteHighLevelCopy(form: FormData): Promise<void> {
  const actor = await requirePermission("settings:manage");
  const id = String(form.get("id") ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id) || form.get("reviewed") !== "on")
    throw new Error(
      "Review related website and staff records before deleting this contact.",
    );
  await deleteReviewedCrmCopy(id);
  await recordAdminAudit({
    actor,
    action: "highlevel.privacy_deleted",
    domain: "marketing",
    outcome: "success",
    targetId: id,
    targetType: "crm_contact",
  });
  revalidatePath("/admin/marketing/highlevel");
}
