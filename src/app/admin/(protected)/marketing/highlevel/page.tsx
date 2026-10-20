import Link from "next/link";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  crmMarketingEnabled,
  crmSyncEnabled,
  crmUrl,
  highLevelOwnsMarketing,
} from "@/lib/highlevel/config";
import { getCrmDiagnostics } from "@/lib/highlevel/store";
import {
  installHighLevel,
  replayHighLevelJob,
  resolveHighLevelEffect,
  deleteHighLevelCopy,
} from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function HighLevelPage() {
  await requireAdminPagePermission("marketing:manage");
  const data = await getCrmDiagnostics();
  return (
    <div className="space-y-6">
      <Link href="/admin/marketing" className="underline">
        Marketing
      </Link>
      <h1 className="font-heading text-3xl">HighLevel synchronization</h1>
      <p>
        CRM sync: {crmSyncEnabled() ? "enabled" : "paused"}. Marketing:{" "}
        {crmMarketingEnabled() ? "enabled" : "paused"}. Marketing owner:{" "}
        {highLevelOwnsMarketing() ? "HighLevel" : "Resend"}.
      </p>
      <p>
        <a
          href={crmUrl()}
          className="underline"
          target="_blank"
          rel="noreferrer"
        >
          Open HighLevel
        </a>
      </p>
      <form action={installHighLevel}>
        <button className="rounded border px-4 py-2">
          Connect or reconnect authorized location
        </button>
      </form>
      {data.connections.length === 0 ? (
        <p>
          No OAuth installation. Configure the location and application
          credentials before connecting.
        </p>
      ) : (
        data.connections.map((c) => (
          <p key={c.location_id}>
            Location {c.location_id}: {c.refresh_state}. Last successful sync:{" "}
            {c.last_sync ? new Date(c.last_sync).toISOString() : "none"}.
          </p>
        ))
      )}
      <table className="w-full text-left text-sm">
        <caption className="text-left font-medium">
          Queue and oldest event
        </caption>
        <thead>
          <tr>
            <th>Status</th>
            <th>Count</th>
            <th>Oldest event (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {data.queue.map((q) => (
            <tr key={q.status}>
              <td>{q.status}</td>
              <td>{q.count}</td>
              <td>{new Date(q.oldest).toISOString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Identity conflicts and uncertain provider actions require reconciliation
        in HighLevel. Replay preserves duplicate prevention records. Resolve the
        underlying issue before replaying.
      </p>
      <table className="w-full text-left text-sm">
        <caption className="text-left font-medium">
          Recent failures and review items
        </caption>
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Attempts</th>
            <th>Recovery</th>
          </tr>
        </thead>
        <tbody>
          {data.issues.map((i) => (
            <tr key={i.id}>
              <td>
                {i.entity_type} / {i.id}
              </td>
              <td>{i.status}</td>
              <td>{i.last_error}</td>
              <td>{i.attempts}</td>
              <td>
                <form action={replayHighLevelJob}>
                  <input type="hidden" name="id" value={i.id} />
                  <button className="underline">Replay</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.effects.map((effect) => (
        <form
          action={resolveHighLevelEffect}
          key={effect.key}
          className="space-y-2 rounded border p-4"
        >
          <p>
            Uncertain {effect.kind}: {effect.key}
          </p>
          <input type="hidden" name="key" value={effect.key} />
          <label className="block">
            Resolution{" "}
            <select name="outcome">
              <option value="confirmed">Provider confirms it happened</option>
              <option value="absent">
                Provider confirms it did not happen
              </option>
            </select>
          </label>
          <label className="block">
            Provider record / workflow ID{" "}
            <input name="providerId" maxLength={100} className="border" />
          </label>
          <label className="block">
            Execution-log reference{" "}
            <input
              name="reference"
              required
              minLength={8}
              maxLength={200}
              className="border"
            />
          </label>
          <label className="block">
            <input name="reviewed" type="checkbox" required /> I verified the
            provider outcome and no request remains in flight.
          </label>
          <button className="underline">Record resolution</button>
        </form>
      ))}
      {data.retention.map((contact) => (
        <form
          action={deleteHighLevelCopy}
          key={contact.id}
          className="space-y-2 rounded border p-4"
        >
          <p>
            CRM privacy review: {contact.email_normalized} /{" "}
            {contact.provider_id}
          </p>
          <input type="hidden" name="id" value={contact.id} />
          <label className="block">
            <input name="reviewed" type="checkbox" required /> I reviewed
            staff-owned records and authorize deleting this entire HighLevel
            contact. Website source deletion is handled separately.
          </label>
          <button className="underline">Delete reviewed CRM copy</button>
        </form>
      ))}
    </div>
  );
}
