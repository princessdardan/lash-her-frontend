"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { communityFetch } from "@/lib/community/client";

export function ReviewProfileForm({ currentName }: { currentName: string }) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState("");

  async function save() {
    const displayName = name.trim();
    if (!displayName || displayName === currentName) return;
    setSaving(true);
    setError("");
    try {
      await communityFetch("/staging-review/community/profile", { method: "PUT", body: { displayName } });
      startTransition(() => router.refresh());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The display name could not be confirmed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-2 rounded border p-4" aria-labelledby="review-profile-heading">
      <h4 id="review-profile-heading" className="font-semibold">Your Community profile</h4>
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="grid gap-1">
          Display name
          <input className="min-h-11 rounded border p-2" required maxLength={60} value={name}
            disabled={saving || refreshing} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="min-h-11 justify-self-start rounded border px-4 py-2 disabled:opacity-50"
          disabled={saving || refreshing || !name.trim() || name.trim() === currentName}>Save display name</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
