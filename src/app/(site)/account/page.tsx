import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AccountControls } from "@/components/customer-auth/account-controls";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { isAccountLifecycleEnabled } from "@/lib/customer-lifecycle/handler";
import { createAccountLifecycleStore } from "@/lib/customer-lifecycle/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your account | LASH HER", robots: { index: false, follow: false } };
export default async function AccountPage() {
  if (!isAccountLifecycleEnabled()) notFound();
  const customer = await getCustomerActor();
  if (!customer) redirect("/sign-in?callbackUrl=%2Faccount");
  const overview = await createAccountLifecycleStore().overview(customer.id);
  return <main className="mx-auto max-w-3xl space-y-12 px-6 py-20">
    <header><h1 className="mb-4 font-serif text-4xl">Your account</h1><p>{customer.email}</p><a href="/account/sign-in-methods" className="mt-4 inline-block underline">Manage sign-in methods</a></header>
    <AccountControls learningUpdates={overview.preferences.learningUpdates} />
    <section aria-labelledby="account-requests"><h2 id="account-requests" className="mb-4 font-serif text-2xl">Recent requests</h2>
      {!overview.commands.length && <p>No account requests yet.</p>}
      <ul className="divide-y divide-current/20">{overview.commands.map(command => <li key={command.commandId} className="py-4">
        <p className="capitalize">{command.action} · {command.issuedAt.toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}</p>
        {command.action === "export" && (command.exportStatus === "ready" && command.expiresAt && command.expiresAt > new Date() ? <a className="underline" href={`/api/account/exports/${command.commandId}`}>Download private export</a> : <p className="text-sm">{command.exportStatus === "ready" ? "Expired" : command.exportStatus ?? "Pending"}</p>)}
      </li>)}</ul>
      <a href="/account" className="mt-4 inline-block underline">Refresh request status</a>
    </section>
  </main>;
}
