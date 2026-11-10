"use client";
import { useRef, useState } from "react";

export function AdminAccountControls() {
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("suspend");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [exportCommand, setExportCommand] = useState<{ userId: string; commandId: string } | null>(null);
  const request = useRef<{ identity: string; key: string } | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const identity = `${userId}:${action}`;
      if (request.current?.identity !== identity) request.current = { identity, key: crypto.randomUUID() };
      const response = await fetch(`/api/admin/customer-accounts/${encodeURIComponent(userId)}/commands`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, idempotencyKey: request.current.key }) });
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object" || !("commandId" in result) || typeof result.commandId !== "string") throw new Error("Request unavailable. Confirm your owner session has a Google sign-in within the last five minutes, then retry.");
      setMessage(`Command ${result.commandId} recorded. Receiver delivery remains pending. Restoration opens frontend access only after both receivers acknowledge.`);
      if (action === "export") setExportCommand({ userId, commandId: result.commandId });
      request.current = null;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request unavailable."); }
    finally { setBusy(false); }
  }
  return <form className="max-w-xl space-y-5" onSubmit={event => void submit(event)}>
    <label className="block">Customer UUID<input required value={userId} onChange={event => setUserId(event.target.value.trim())} autoComplete="off" pattern="[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" className="mt-2 block w-full rounded border px-3 py-2" /></label>
    <label className="block">Action<select value={action} onChange={event => setAction(event.target.value)} className="mt-2 block w-full rounded border px-3 py-2"><option value="suspend">Suspend and revoke sessions</option><option value="restore">Restore after both receivers acknowledge</option><option value="export">Request private export</option><option value="delete">Permanently delete account</option></select></label>
    {action === "delete" && <label className="block">Type DELETE to confirm irreversible deletion<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" className="mt-2 block w-full rounded border px-3 py-2" /></label>}
    <button type="submit" className="rounded border px-4 py-2 disabled:opacity-40" disabled={busy || action === "delete" && confirmation !== "DELETE"}>Record account command</button>
    <p role="status" aria-live="polite">{message}</p>
    {exportCommand && <a className="block underline" href={`/api/admin/customer-accounts/${exportCommand.userId}/exports/${exportCommand.commandId}`}>Download private export when ready</a>}
  </form>;
}
