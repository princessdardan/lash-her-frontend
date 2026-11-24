"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { validLearningId } from "@/lib/learning/presentation";
import {
  communityFetch,
  type CommunityReports,
  type ModerationAction,
} from "@/lib/community/client";
import { useCommunityResource } from "./use-community-resource";

const api = "/api/admin/community";
const fieldClass =
  "block w-full rounded-md border border-input bg-background px-3 py-2";

function Report({
  report,
  onModerate,
}: {
  report: CommunityReports["reports"][number];
  onModerate?: (
    action: ModerationAction,
    reason: string,
    actionId: string,
  ) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{
    action: ModerationAction;
    reason: string;
    id: string;
  }>();
  const options: [ModerationAction, string][] = [
    [
      report.locked ? "unlock" : "lock",
      report.locked ? "Unlock discussion" : "Lock discussion",
    ],
    [
      report.pinned ? "unpin" : "pin",
      report.pinned ? "Unpin discussion" : "Pin discussion",
    ],
    [
      report.suspended ? "unsuspend" : "suspend",
      report.suspended ? "Restore participation" : "Suspend participation",
    ],
  ];
  if (report.contentStatus !== "deleted") {
    options.unshift(
      report.contentStatus === "hidden"
        ? ["restore", "Restore content"]
        : ["hide", "Hide content"],
    );
  }
  if (report.status === "open") options.push(["resolve", "Resolve report"]);

  async function act(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onModerate) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const action = options.find(
      ([value]) => value === fields.get("action"),
    )?.[0];
    const reason = String(fields.get("reason") ?? "").trim();
    if (!action || !reason) return;
    const id =
      attempt?.action === action && attempt.reason === reason
        ? attempt.id
        : crypto.randomUUID();
    setAttempt({ action, reason, id });
    setBusy(true);
    try {
      if (await onModerate(action, reason, id)) {
        form.reset();
        setAttempt(undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="space-y-4 rounded-2xl border border-lh-line bg-white p-5">
      <h2 className="text-lg font-semibold">{report.space.title}</h2>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3">
        {report.body}
      </blockquote>
      <p>
        <strong>Report reason</strong> {report.reason}
      </p>
      <p className="text-sm capitalize">
        {report.contentStatus} · {report.status}
      </p>
      {onModerate && (
        <form className="max-w-lg space-y-3" onSubmit={act}>
          <label className="block">
            Action
            <select className={fieldClass} name="action">
              {options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Moderation reason
            <textarea
              className={fieldClass}
              name="reason"
              maxLength={500}
              required
            />
          </label>
          <Button disabled={busy} type="submit">
            Apply action
          </Button>
        </form>
      )}
    </article>
  );
}

export function CommunityModeration({ writes }: { writes: boolean }) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [after, setAfter] = useState<string>();
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const [saving, setSaving] = useState(false);
  const { data, error, refresh } = useCommunityResource<CommunityReports>(
    `${api}/reports?status=${status}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
  );

  async function submit(path: string, method: "POST" | "PUT", body: object) {
    setNotice(undefined);
    try {
      await communityFetch(api + path, { method, body });
      setNotice({
        message:
          method === "POST"
            ? "Moderation action recorded."
            : "Course space saved.",
      });
      refresh();
      return true;
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "Changes could not be saved.",
        error: true,
      });
      refresh();
      return false;
    }
  }

  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const courseId = String(fields.get("courseId") ?? "").trim();
    const title = String(fields.get("title") ?? "").trim();
    if (!validLearningId(courseId) || !title) {
      setNotice({
        message: "Enter a valid Course ID and space title.",
        error: true,
      });
      return;
    }
    setSaving(true);
    try {
      await submit(`/spaces/${courseId}`, "PUT", {
        title,
        enabled: fields.get("enabled") === "on",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-5xl uppercase tracking-wide">Community moderation</h1>
      {writes && (
        <details className="max-w-lg space-y-4 rounded-2xl border border-lh-line bg-white p-5">
          <summary className="cursor-pointer">Configure course space</summary>
          <form className="space-y-3" onSubmit={configure}>
            <label className="block">
              Course ID
              <input
                className={fieldClass}
                name="courseId"
                required
                maxLength={36}
              />
            </label>
            <label className="block">
              Space title
              <input
                className={fieldClass}
                name="title"
                required
                maxLength={160}
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="enabled" defaultChecked /> Enable
              discussions
            </label>
            <Button disabled={saving} type="submit">
              Save space
            </Button>
          </form>
        </details>
      )}
      {notice && (
        <p role={notice.error ? "alert" : "status"}>{notice.message}</p>
      )}
      <label className="block max-w-xs">
        Report status
        <select
          className={fieldClass}
          value={status}
          onChange={(event) => {
            setStatus(
              event.currentTarget.value === "resolved" ? "resolved" : "open",
            );
            setAfter(undefined);
          }}
        >
          <option value="open">Open reports</option>
          <option value="resolved">Resolved reports</option>
        </select>
      </label>
      {error ? (
        <div className="space-y-2" role="alert">
          <p>{error.message}</p>
          <Button variant="outline" type="button" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : data ? (
        <>
          {data.reports.length === 0 && <p>No {status} reports.</p>}
          {data.reports.map((report) => (
            <Report
              key={report.id}
              report={report}
              onModerate={
                writes
                  ? (action, reason, actionId) =>
                      submit("/actions", "POST", {
                        action,
                        reason,
                        actionId,
                        reportId: report.id,
                      })
                  : undefined
              }
            />
          ))}
          <div className="flex gap-2">
            {after && (
              <Button
                variant="outline"
                type="button"
                onClick={() => setAfter(undefined)}
              >
                First page
              </Button>
            )}
            {data.next && (
              <Button
                variant="outline"
                type="button"
                onClick={() => setAfter(data.next ?? undefined)}
              >
                Next page
              </Button>
            )}
          </div>
        </>
      ) : (
        <p role="status">Loading reports…</p>
      )}
    </div>
  );
}
