"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { learningErrorText, learningRequest } from "@/lib/learning/browser-request";
import { learningAction } from "./shared";

export function FreeEnrollment({ courseId, reviewedIdempotencyKey }: { courseId: string; reviewedIdempotencyKey?: string }) {
  const router = useRouter();
  const key = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function enroll() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    key.current ??= reviewedIdempotencyKey ?? crypto.randomUUID();
    try {
      const receipt = await learningRequest<{ status: "active" | "revoked" | "expired" }>(`/api/academy/courses/${courseId}/enrollments`, { method: "POST", body: { idempotencyKey: key.current } });
      if (receipt.status !== "active") { setError("This enrollment is no longer active. Open your academy to check access or contact support."); return; }
      router.push(`/academy/courses/${courseId}`);
      if (!reviewedIdempotencyKey) router.refresh();
    } catch (failure) { setError(learningErrorText(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div><button type="button" className={learningAction} disabled={busy} onClick={() => { void enroll(); }}>{busy ? "Enrolling…" : "Enroll for free"}</button>
    {error ? <p role="alert" className="mt-4 max-w-md text-sm leading-relaxed">{error} Your enrollment request can be retried safely.</p> : null}
    <p className="mt-4 max-w-md text-sm leading-relaxed text-lh-muted">Your lessons and progress stay with your account. Enrollment does not subscribe you to marketing emails.</p>
  </div>;
}
