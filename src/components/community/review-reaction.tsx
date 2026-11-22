"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { communityFetch } from "@/lib/community/client";

export function ReviewReaction({ postId, reacted, count, locked }: {
  postId: string; reacted: boolean; count: number; locked: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState("");

  async function toggle() {
    setSaving(true);
    setError("");
    try {
      await communityFetch(`/staging-review/community/posts/${postId}/reaction`,
        { method: "PUT", body: { active: !reacted } });
      startTransition(() => router.refresh());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The reaction could not be confirmed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" className="min-h-11 rounded border px-4 py-2 disabled:opacity-50"
        disabled={saving || refreshing || (locked && !reacted)} aria-pressed={reacted} onClick={() => void toggle()}>
        {reacted ? "Remove reaction" : "Add reaction"}
      </button>
      <span aria-live="polite">{count} {count === 1 ? "reaction" : "reactions"}</span>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
