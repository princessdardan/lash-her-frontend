"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const errors: Record<number, string> = {
  400: "Enter a reason for replay.",
  401: "Sign in again to replay this job.",
  403: "You do not have permission to replay this job.",
  404: "Recovery is unavailable in this environment.",
  409: "This job is no longer eligible for replay. Check the current order status.",
};

export function CourseJobReplayForm({
  orderReference,
  jobId,
}: {
  orderReference: string;
  jobId: string;
}) {
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");

  async function replay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || queued) return;
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    ).trim();
    if (!reason) {
      setError(errors[400]);
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/admin/course-purchases/replay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lash-csrf": "1" },
        body: JSON.stringify({ jobId, orderReference, reason }),
      });
      if (response.ok) setQueued(true);
      else
        setError(
          errors[response.status] ??
            "Recovery could not queue this job. Check the current order status before retrying.",
        );
    } catch {
      setError(
        "The replay result could not be confirmed. Check the current order status before retrying.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <details className="pt-2">
      <summary className="w-fit cursor-pointer font-medium text-lh-primary">
        Replay failed job
      </summary>
      <form
        className="mt-2 flex max-w-xl flex-wrap items-end gap-2"
        onSubmit={replay}
      >
        <label className="min-w-0 flex-1 text-sm">
          Reason for replay
          <Input
            className="mt-1"
            name="reason"
            required
            maxLength={300}
            disabled={pending || queued}
          />
        </label>
        <Button type="submit" disabled={pending || queued}>
          {pending ? "Queueing…" : "Queue replay"}
        </Button>
      </form>
      {queued && (
        <p role="status" className="mt-2">
          Replay queued. Refresh the order to check progress.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2">
          {error}
        </p>
      )}
    </details>
  );
}
