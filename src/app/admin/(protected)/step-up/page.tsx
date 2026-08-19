import { stepUpWithGoogleAction } from "@/app/admin/auth-actions";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";

export const dynamic = "force-dynamic";

interface AdminStepUpPageProps {
  searchParams: Promise<{
    action?: string | string[];
    returnTo?: string | string[];
    target?: string | string[];
    targetLabel?: string | string[];
  }>;
}

export default async function AdminStepUpPage({
  searchParams,
}: AdminStepUpPageProps) {
  await requireAdminPagePermission("admin:view");
  const params = await searchParams;
  const returnTo = getSafeAdminReturnTo(firstString(params.returnTo));
  const action = requiredValue(firstString(params.action), "sensitive action");
  const target = requiredValue(firstString(params.target), "selected record");
  const targetLabel = firstString(params.targetLabel)?.trim() || target;

  return (
    <section className="mx-auto max-w-xl rounded-3xl border border-lh-line bg-white p-8 shadow-sm">
      <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
        Security check
      </p>
      <h1 className="mt-3 font-heading text-4xl uppercase leading-none tracking-[0.08em] text-lh-shadow">
        Reauthenticate
      </h1>
      <p className="mt-4 text-lh-muted">
        Google must verify your account again before the action can be retried.
        This page does not execute the action.
      </p>
      <dl className="mt-6 grid gap-3 rounded-2xl bg-lh-neutral-2 p-4 text-sm">
        <div>
          <dt className="font-semibold">Action</dt>
          <dd className="mt-1 break-all text-lh-muted">{action}</dd>
        </div>
        <div>
          <dt className="font-semibold">Target</dt>
          <dd className="mt-1 break-all font-mono text-xs text-lh-muted">
            {targetLabel}
          </dd>
        </div>
      </dl>
      <form action={stepUpWithGoogleAction} className="mt-7">
        <input name="action" type="hidden" value={action} />
        <input name="returnTo" type="hidden" value={returnTo} />
        <input name="target" type="hidden" value={target} />
        <AdminSubmitButton
          className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
          pendingLabel="Opening Google verification…"
        >
          Verify with Google
        </AdminSubmitButton>
      </form>
      <p className="mt-4 text-xs text-lh-muted">
        After Google returns you to the admin page, review the refreshed version
        and evidence before submitting again.
      </p>
    </section>
  );
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}
