"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { buttonClass, secondaryClass } from "./course-fields";

type Receipt = { state: "confirmed" | "accepted-needs-review" | "not-observed" | "outcome-unknown"; idempotencyKey: string;
  command?: { commandId: string; userId: string; courseId: string; effects: { grantId: string }[] } | null; communityDeliveryVerified?: false };
function subscribeReference(listener: () => void) {
  window.addEventListener("owner-grant-reference", listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener("owner-grant-reference", listener); window.removeEventListener("storage", listener); };
}
export function ManualGrantForm({ courseId, revision, eligible, reviewedIdempotencyKey }: {
  courseId: string; revision: number; eligible: boolean; reviewedIdempotencyKey?: string;
}) {
  const [userId, setUserId] = useState(""), [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null), [message, setMessage] = useState("");
  const storageKey = `owner-course-grant:${courseId}`;
  const stored = useSyncExternalStore(subscribeReference, () => {
    try { return sessionStorage.getItem(storageKey) ?? ""; } catch { return "\0"; }
  }, () => null);
  const ready = stored !== null && stored !== "\0", attempt = ready ? stored : "";
  async function request(method: "GET" | "POST", id: string) {
    setPending(true); setMessage("");
    try {
      const path = `/api/admin/courses/${courseId}/manual-grants`;
      const response = await fetch(method === "GET" ? `${path}?idempotencyKey=${encodeURIComponent(id)}` : path, {
        method, cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(30_000),
        ...(method === "POST" ? { headers: { "content-type": "application/json", "x-lash-csrf": "1" },
          body: JSON.stringify({ userId, reason, expectedCourseRevision: revision, idempotencyKey: id }) } : {}),
      });
      if (!response.ok) throw new Error("No grant outcome was confirmed. Check the recorded outcome before any further action.");
      const value = await response.json() as Receipt;
      if (!["confirmed", "accepted-needs-review", "not-observed", "outcome-unknown"].includes(value.state) || value.idempotencyKey !== id) throw new Error("Invalid grant receipt.");
      setReceipt(value);
      setMessage(value.state === "confirmed" ? "Manual grant and audit confirmed. Community access has not been verified yet."
        : value.state === "not-observed" ? "No command was observed. This does not prove a pending request was cancelled. No grant was retried."
          : value.state === "outcome-unknown" ? "The grant outcome is unknown. Check the recorded outcome; no grant was retried."
            : "A grant was accepted and requires review. Keep this request reference; no grant was retried.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The outcome is unknown. Check the recorded outcome; do not resubmit."); }
    finally { setPending(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eligible || !ready || pending || attempt) return;
    const id = reviewedIdempotencyKey ?? crypto.randomUUID();
    try { if (sessionStorage.getItem(storageKey)) return; sessionStorage.setItem(storageKey, id); } catch { setMessage("The request reference could not be retained. No grant was submitted."); return; }
    window.dispatchEvent(new Event("owner-grant-reference"));
    await request("POST", id);
  }
  function next() {
    if (receipt?.state !== "confirmed" || pending) return;
    try { sessionStorage.removeItem(storageKey); } catch { return; }
    window.dispatchEvent(new Event("owner-grant-reference")); setReceipt(null); setUserId(""); setReason(""); setMessage("");
  }
  return <section className="space-y-4" aria-label="Manual course access">
    <p>Grant access to an existing active customer without creating an order or payment. This action records your owner identity and reason.</p>
    <p>Selected published paid course revision: {revision}.</p>
    <form onSubmit={submit} className="space-y-4">
      <label className="block">Customer UUID<input className="mt-1 block w-full border p-2" required value={userId} onChange={event => setUserId(event.target.value)} pattern="[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}" disabled={pending || !!attempt} /></label>
      <label className="block">Grant reason<textarea className="mt-1 block w-full border p-2" required maxLength={1800} value={reason} onChange={event => setReason(event.target.value)} disabled={pending || !!attempt} /></label>
      <button className={buttonClass} disabled={!eligible || !ready || pending || !!attempt} type="submit">Grant manual access</button>
    </form>
    {attempt && <div className="space-y-3"><p>Request reference: <code>{attempt}</code></p><p>Keep this reference. Refreshing the page never retries the grant.</p>
      <button className={secondaryClass} type="button" disabled={pending} onClick={() => void request("GET", attempt)}>Check recorded outcome</button></div>}
    {stored === "\0" && <p role="alert">This browser cannot retain request references. No grant can be submitted.</p>}
    {message && <p role="status">{message}</p>}
    {receipt?.command && <dl className="space-y-2"><dt>Command receipt</dt><dd><code>{receipt.command.commandId}</code></dd><dt>Customer</dt><dd><code>{receipt.command.userId}</code></dd>
      <dt>Grant effects</dt><dd>{receipt.command.effects.map(effect => <code className="block" key={effect.grantId}>{effect.grantId}</code>)}</dd></dl>}
    {receipt?.state === "confirmed" && <button className={secondaryClass} type="button" disabled={pending} onClick={next}>Prepare another grant</button>}
  </section>;
}
