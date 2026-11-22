"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { communityFetch, CommunityRequestError } from "@/lib/community/client";

export function ReviewDiscussionForm({ postId, returnToNewest }: { postId?: string; returnToNewest?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const replyAttempt = useRef<{ body: string; id: string } | null>(null);
  const base = "/staging-review/community/posts";
  const label = postId ? "Your reply" : "New discussion";
  const action = postId ? "Post reply" : "Post discussion";

  async function submit() {
    const body = text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      if (postId && replyAttempt.current?.body !== body)
        replyAttempt.current = { body, id: crypto.randomUUID() };
      const result = await communityFetch<{ id: string }>(
        postId ? `${base}/${postId}/replies` : base,
        { method: "POST", body: postId ? { body, replyId: replyAttempt.current?.id } : { body } },
      );
      replyAttempt.current = null;
      setText("");
      if (postId) {
        setMessage("Reply posted.");
        if (returnToNewest) router.push(`/staging-review/discussions/${postId}#discussion-replies`);
        else router.refresh();
      } else {
        router.push(`/staging-review/discussions/${result.id}`);
      }
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof CommunityRequestError && error.status < 500
        ? error.message
        : postId ? "The reply could not be confirmed. You can retry." : "The post could not be confirmed. Check the discussion list before retrying.");
      if (!postId) router.refresh();
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  return (
    <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="grid gap-1">
        {label}
        <textarea className="min-h-24 rounded border p-2" required maxLength={4000}
          value={text} disabled={saving} onChange={(event) => setText(event.target.value)} />
      </label>
      <button type="submit" className="min-h-11 justify-self-start rounded border px-4 py-2 disabled:opacity-50"
        disabled={!text.trim() || saving}>{saving ? "Posting…" : action}</button>
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
    </form>
  );
}
