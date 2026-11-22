"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { communityFetch } from "@/lib/community/client";

export function ReviewContent({
  body, postId, replyId, after, canEdit, canDelete,
}: {
  body: string; postId: string; replyId?: string; after?: string; canEdit: boolean; canDelete: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = replyId ? "reply" : "discussion";
  const postPath = `/staging-review/community/posts/${postId}`;
  const path = replyId
    ? `${postPath}/replies/${replyId}${after ? `?after=${encodeURIComponent(after)}` : ""}`
    : postPath;
  const buttonStyle = "min-h-11 rounded border px-4 py-2 disabled:opacity-50";

  async function save(verb: "PATCH" | "DELETE") {
    setBusy(true);
    setError("");
    try {
      await communityFetch(path, { method: verb, body: verb === "PATCH" ? { body: text.trim() } : {} });
      setMode("read");
      if (verb === "DELETE" && !replyId) router.replace("/staging-review#community");
      else router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {mode === "edit" ? (
        <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save("PATCH"); }}>
          <label className="grid gap-1">
            Edit {label}
            <textarea className="min-h-24 rounded border p-2" maxLength={4000} required
              value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
          </label>
          <div className="flex gap-2">
            <button className={buttonStyle} disabled={busy || !text.trim()}>Save {label}</button>
            <button type="button" className={buttonStyle} disabled={busy} onClick={() => setMode("read")}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap">{body}</p>
          {mode === "delete" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p>Delete this {label}?</p>
              <button type="button" className={buttonStyle} disabled={busy} onClick={() => void save("DELETE")}>Confirm delete {label}</button>
              <button type="button" className={buttonStyle} disabled={busy} onClick={() => setMode("read")}>Cancel</button>
            </div>
          ) : canEdit || canDelete ? (
            <div className="mt-2 flex gap-2">
              {canEdit && <button type="button" className={buttonStyle} onClick={() => { setText(body); setError(""); setMode("edit"); }}>Edit {label}</button>}
              {canDelete && <button type="button" className={buttonStyle} onClick={() => { setError(""); setMode("delete"); }}>Delete {label}</button>}
            </div>
          ) : null}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
