import { auth } from "@/auth";
import {
  authorizeAdminDeveloperAccessAction,
  setAdminDeveloperSessionAction,
  signInWithGoogleAction,
} from "@/app/admin/auth-actions";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import {
  hasAdminDeveloperAccess,
  listAdminDeveloperUserOptions,
} from "@/lib/admin/developer-mode";
import { isAdminDeveloperModeEnabled } from "@/lib/admin/developer-mode-config";
import { getAdminRoleLabel } from "@/lib/admin/presentation";
import { getSafeAdminReturnTo } from "@/lib/admin/redirects";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface AdminSignInPageProps {
  searchParams: Promise<{
    developerError?: string | string[];
    error?: string | string[];
    returnTo?: string | string[];
  }>;
}

export default async function AdminSignInPage({
  searchParams,
}: AdminSignInPageProps) {
  const developerModeEnabled = isAdminDeveloperModeEnabled();
  const [session, params] = await Promise.all([auth(), searchParams]);
  const developerAccessAuthorized =
    developerModeEnabled && (await hasAdminDeveloperAccess());
  const developerUsers = developerAccessAuthorized
    ? await listAdminDeveloperUserOptions()
    : [];
  const returnTo = getSafeAdminReturnTo(
    Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo,
  );

  if (session?.user && !developerModeEnabled) {
    redirect(returnTo);
  }

  const hasError =
    typeof params.error === "string" || Array.isArray(params.error);
  const hasDeveloperError =
    firstString(params.developerError) === "invalid_access_key";

  return (
    <main className="flex min-h-screen items-center justify-center bg-lh-neutral-2 px-6 py-12">
      <section className="w-full max-w-lg rounded-3xl border border-lh-line bg-white p-8 shadow-sm">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Staff access
        </p>
        <h1 className="mt-3 font-heading text-4xl uppercase leading-none tracking-[0.08em] text-lh-shadow sm:text-5xl">
          Staff sign in
        </h1>
        <p className="mt-4 text-lh-muted">
          Continue with your Lash Her Google account.
        </p>
        {hasError ? (
          <p
            className="mt-5 rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-4 text-sm text-lh-accent"
            role="alert"
          >
            We could not sign you in. Try again with your Lash Her Google
            account. If you still cannot access the admin, contact the business
            owner.
          </p>
        ) : null}
        <form action={signInWithGoogleAction} className="mt-7">
          <input type="hidden" name="returnTo" value={returnTo} />
          <AdminSubmitButton
            className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-lh-shadow disabled:cursor-wait disabled:opacity-60"
            pendingLabel="Signing in…"
          >
            Continue with your Lash Her Google account
          </AdminSubmitButton>
        </form>
        {developerModeEnabled ? (
          <details
            className="group mt-4 overflow-hidden rounded-2xl border border-lh-line bg-lh-neutral-2"
            open={hasDeveloperError || developerAccessAuthorized}
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 text-sm font-semibold text-lh-shadow transition hover:bg-lh-light-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-lh-primary [&::-webkit-details-marker]:hidden">
              Developer access
              <svg
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform group-open:rotate-180"
                fill="none"
                viewBox="0 0 16 16"
              >
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                />
              </svg>
            </summary>
            <div className="border-t border-lh-line bg-amber-50 p-5">
              {!developerAccessAuthorized ? (
                <form
                  action={authorizeAdminDeveloperAccessAction}
                  className="space-y-4"
                >
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {hasDeveloperError ? (
                    <p
                      className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
                      role="alert"
                    >
                      Developer access could not be authorized.
                    </p>
                  ) : null}
                  <label className="block text-sm font-semibold text-lh-shadow">
                    Developer access key
                    <input
                      autoComplete="current-password"
                      className="mt-2 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 font-normal"
                      maxLength={512}
                      name="accessKey"
                      required
                      type="password"
                    />
                  </label>
                  <AdminSubmitButton
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-amber-950 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-amber-900 disabled:cursor-wait disabled:opacity-60"
                    pendingLabel="Authorizing…"
                  >
                    Authorize developer access
                  </AdminSubmitButton>
                </form>
              ) : developerUsers.length > 0 ? (
                <form
                  action={setAdminDeveloperSessionAction}
                  className="space-y-4"
                >
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label className="block text-sm font-semibold text-lh-shadow">
                    Represented account
                    <select
                      className="mt-2 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 font-normal"
                      name="actingAdminUserId"
                      required
                    >
                      {developerUsers.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName ?? user.email} —{" "}
                          {getAdminRoleLabel(user.role)}
                          {user.status === "disabled" ? " (disabled)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold text-lh-shadow">
                    Simulated permissions
                    <select
                      className="mt-2 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 font-normal"
                      defaultValue="owner"
                      name="permissionRole"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Administrator</option>
                      <option value="employee">Contractor</option>
                    </select>
                  </label>
                  <AdminSubmitButton
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-amber-950 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-amber-900 disabled:cursor-wait disabled:opacity-60"
                    pendingLabel="Starting developer session…"
                  >
                    Enter developer mode
                  </AdminSubmitButton>
                </form>
              ) : (
                <p className="text-sm font-semibold text-amber-950">
                  No admin users exist in the configured database. Seed or
                  migrate the database before starting a developer session.
                </p>
              )}
            </div>
          </details>
        ) : null}
      </section>
    </main>
  );
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
