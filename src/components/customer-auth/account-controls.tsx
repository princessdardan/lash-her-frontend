"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function AccountControls({ learningUpdates }: { learningUpdates: boolean }) {
  const router = useRouter();
  const [preference, setPreference] = useState(learningUpdates);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const keys = useRef<Partial<Record<"export" | "delete", string>>>({});
  const button = "border border-current px-5 py-3 text-sm disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4";
  async function submit(action: "preferences" | "export" | "delete") {
    setBusy(true); setMessage("");
    try {
      if (action !== "preferences") keys.current[action] ??= crypto.randomUUID();
      const response = await fetch(action === "preferences" ? "/api/account/preferences" : "/api/account/commands", {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "preferences" ? { learningUpdates: preference } : { action, idempotencyKey: keys.current[action] }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const code = data && typeof data === "object" && "error" in data ? data.error : "";
        throw new Error(code === "fresh_sign_in_required" ? "Sign out and sign in again, then retry within 15 minutes." : "This request could not be completed. Retry with the same request or return later.");
      }
      if (action === "delete") { router.replace("/sign-in?account-deleted=1"); router.refresh(); return; }
      if (action === "export") keys.current.export = undefined;
      setMessage(action === "preferences" ? "Preference saved." : "Export requested. Refresh the account page to check when it is ready.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "This request could not be completed."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-12">
    <section aria-labelledby="account-preferences"><h2 id="account-preferences" className="mb-4 font-serif text-2xl">Preferences</h2>
      <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={preference} onChange={event => setPreference(event.target.checked)} disabled={busy} />Save my preference to receive learning updates when available.</label>
      <p className="my-4 text-sm">Marketing subscriptions and suppression history are managed separately. This preference does not subscribe you to marketing emails.</p>
      <button className={button} disabled={busy} onClick={() => void submit("preferences")}>Save preference</button>
    </section>
    <section aria-labelledby="account-export"><h2 id="account-export" className="mb-4 font-serif text-2xl">Your account data</h2>
      <p className="mb-4">Request a private copy of your account and learning records. Downloads require sign-in and expire within 24 hours of being ready. Guest booking and purchase records use their separate access process.</p>
      <p className="mb-4 text-sm">Exports and deletion require a sign-in completed within the last 15 minutes. Use <a href="/account/sign-in-methods" className="underline">sign-in methods</a> to sign out, then sign in again.</p>
      <button className={button} disabled={busy} onClick={() => void submit("export")}>Request account export</button>
    </section>
    <section aria-labelledby="account-delete"><h2 id="account-delete" className="mb-4 font-serif text-2xl">Delete account</h2>
      <p className="mb-4">Deletion is permanent. It ends your sessions, removes your profile and progress, and deidentifies retained assessment attempts. Required minimal access, audit and financial records retain their existing retention rules. Existing video access can remain usable until its current playback token expires, up to 10 minutes.</p>
      <label htmlFor="account-delete-confirm" className="mb-2 block text-sm">Type DELETE to confirm</label>
      <input id="account-delete-confirm" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mb-4 block w-full max-w-xs border border-current/30 bg-transparent px-4 py-3" disabled={busy} />
      <button className={button} disabled={busy || confirmation !== "DELETE"} onClick={() => void submit("delete")}>Delete my account</button>
    </section>
    <p aria-live="polite" role="status">{message}</p>
  </div>;
}
