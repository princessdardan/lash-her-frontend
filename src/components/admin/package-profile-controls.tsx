"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface PackageProfileView {
  id: string;
  slug: string;
  name: string;
  rank: number;
  packageType: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  tareWeightGrams: number;
  maxWeightGrams: number;
  acceptsRigid: boolean;
  enabled: boolean;
  updatedAt: string;
  reviewedAt: string | null;
  reviewEvidenceVersion: string | null;
  evidenceReference: string | null;
}

const PACKAGE_TYPES = ["parcel", "thick_envelope", "envelope"] as const;

interface MutationResult {
  error?: string;
  stepUp?: { action: string; target: string; targetLabel?: string };
}

export function PackageProfileControls({
  profiles,
}: {
  profiles: PackageProfileView[];
}) {
  const enabled = profiles.filter((profile) => profile.enabled);
  const drafts = profiles.filter((profile) => !profile.enabled);

  return (
    <div className="space-y-8">
      <CreateProfileForm />

      <section className="space-y-3">
        <h2 className="font-semibold">Enabled boxes ({enabled.length})</h2>
        {enabled.length === 0 ? (
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
            No enabled boxes. Checkout cannot quote shipping until at least one
            box is approved.
          </p>
        ) : (
          <ul className="space-y-3">
            {enabled.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Drafts ({drafts.length})</h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-lh-muted">No draft boxes.</p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProfileCard({ profile }: { profile: PackageProfileView }) {
  const [mode, setMode] = useState<"view" | "edit" | "approve">("view");

  return (
    <li className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          {profile.name}{" "}
          <span className="font-mono text-xs text-lh-muted">
            ({profile.slug})
          </span>
        </h3>
        <span
          className={
            profile.enabled
              ? "text-xs font-semibold uppercase tracking-[0.12em] text-green-700"
              : "text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted"
          }
        >
          {profile.enabled ? "Enabled" : "Draft"}
        </span>
      </div>
      <dl className="mt-3 grid gap-2 text-xs text-lh-muted sm:grid-cols-3">
        <Detail label="Dimensions">
          {profile.lengthCm} × {profile.widthCm} × {profile.heightCm} cm
        </Detail>
        <Detail label="Weight">
          tare {profile.tareWeightGrams} g · max {profile.maxWeightGrams} g
        </Detail>
        <Detail label="Type / rank">
          {profile.packageType} · rank {profile.rank}
        </Detail>
        <Detail label="Rigid-capable">
          {profile.acceptsRigid ? "Yes" : "No"}
        </Detail>
        <Detail label="Updated">
          {new Date(profile.updatedAt).toLocaleString("en-CA")}
        </Detail>
        {profile.evidenceReference ? (
          <Detail label="Evidence">{profile.evidenceReference}</Detail>
        ) : null}
      </dl>

      <div className="mt-4 flex flex-wrap gap-3">
        {profile.enabled ? (
          <DisableButton profile={profile} />
        ) : (
          <>
            <button
              className="min-h-11 rounded-full border border-lh-line px-4 text-sm font-semibold text-lh-primary"
              onClick={() => setMode(mode === "edit" ? "view" : "edit")}
              type="button"
            >
              {mode === "edit" ? "Close edit" : "Edit draft"}
            </button>
            <button
              className="min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white"
              onClick={() => setMode(mode === "approve" ? "view" : "approve")}
              type="button"
            >
              {mode === "approve" ? "Close approval" : "Approve & enable"}
            </button>
          </>
        )}
      </div>

      {mode === "edit" ? <EditProfileForm profile={profile} /> : null}
      {mode === "approve" ? <ApproveProfileForm profile={profile} /> : null}
    </li>
  );
}

function CreateProfileForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const outcome = await sendProfileRequest(
      "/api/admin/shipping/package-profiles",
      fieldsBody(form),
    );
    setPending(false);
    if (outcome.ok) {
      setMessage("Draft box created.");
      (event.target as HTMLFormElement).reset();
      router.refresh();
      return;
    }
    setMessage(outcome.message);
  }

  return (
    <section className="rounded-2xl border border-lh-line bg-lh-neutral-2 p-5">
      <h2 className="font-semibold">Add a box</h2>
      <p className="mt-1 text-sm text-lh-muted">
        Creates a draft. Approve it afterwards to make it available to checkout.
      </p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <ProfileFields />
        <button
          className="min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
          disabled={pending}
          type="submit"
        >
          {pending ? "Creating…" : "Create draft box"}
        </button>
        <StatusMessage message={message} />
      </form>
    </section>
  );
}

function EditProfileForm({ profile }: { profile: PackageProfileView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const outcome = await sendProfileRequest(
      `/api/admin/shipping/package-profiles/${encodeURIComponent(profile.id)}`,
      {
        action: "edit",
        expectedUpdatedAt: profile.updatedAt,
        ...fieldsBody(form),
      },
    );
    setPending(false);
    if (outcome.ok) {
      setMessage("Draft updated.");
      router.refresh();
      return;
    }
    setMessage(outcome.message);
  }

  return (
    <form
      className="mt-4 space-y-3 rounded-xl bg-lh-neutral-2 p-4"
      onSubmit={submit}
    >
      <ProfileFields profile={profile} />
      <button
        className="min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Saving…" : "Save draft"}
      </button>
      <StatusMessage message={message} />
    </form>
  );
}

function ApproveProfileForm({ profile }: { profile: PackageProfileView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<MutationResult["stepUp"] | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setStepUp(null);
    const form = new FormData(event.currentTarget);
    const outcome = await sendProfileRequest(
      `/api/admin/shipping/package-profiles/${encodeURIComponent(profile.id)}`,
      {
        action: "approve",
        expectedUpdatedAt: profile.updatedAt,
        evidenceReference: form.get("evidenceReference"),
        ...profileFieldsFromView(profile),
      },
    );
    setPending(false);
    if (outcome.ok) {
      setMessage("Box approved and enabled.");
      router.refresh();
      return;
    }
    setMessage(outcome.message);
    setStepUp(
      outcome.status === 409 && /step-up|authentication/i.test(outcome.message)
        ? (outcome.stepUp ?? null)
        : null,
    );
  }

  return (
    <form
      className="mt-4 space-y-3 rounded-xl bg-lh-neutral-2 p-4"
      onSubmit={submit}
    >
      <p className="text-sm text-lh-muted">
        Approving enables this box for checkout. It requires fresh Google
        step-up authentication and is bound to the exact dimensions, weights,
        and evidence reference below — changing any value needs a new proof.
      </p>
      <label className="block text-sm font-semibold">
        Evidence reference
        <input
          className={fieldClass}
          minLength={6}
          name="evidenceReference"
          placeholder="e.g. Measured physical box, 2026-08-23"
          required
        />
      </label>
      <button
        className="min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Submitting…" : "Approve & enable box"}
      </button>
      <StatusMessage message={message} />
      {stepUp ? (
        <Link
          className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline underline-offset-4"
          href={`/admin/step-up?returnTo=${encodeURIComponent("/admin/shipping-packages")}&action=${encodeURIComponent(stepUp.action)}&target=${encodeURIComponent(stepUp.target)}&targetLabel=${encodeURIComponent(stepUp.targetLabel ?? `package profile ${profile.slug}`)}`}
        >
          Reauthenticate for this action
        </Link>
      ) : null}
    </form>
  );
}

function DisableButton({ profile }: { profile: PackageProfileView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function disable() {
    setPending(true);
    setMessage(null);
    const outcome = await sendProfileRequest(
      `/api/admin/shipping/package-profiles/${encodeURIComponent(profile.id)}`,
      { action: "disable", expectedUpdatedAt: profile.updatedAt },
    );
    setPending(false);
    if (outcome.ok) {
      router.refresh();
      return;
    }
    setMessage(outcome.message);
  }

  return (
    <div className="space-y-2">
      <button
        className="min-h-11 rounded-full border border-lh-line px-4 text-sm font-semibold text-red-700 disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        onClick={disable}
        type="button"
      >
        {pending ? "Disabling…" : "Disable box"}
      </button>
      <StatusMessage message={message} />
    </div>
  );
}

function ProfileFields({ profile }: { profile?: PackageProfileView }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm font-semibold">
        Slug
        <input
          className={fieldClass}
          defaultValue={profile?.slug}
          name="slug"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          placeholder="mailer-box-30x22x5"
          required
        />
      </label>
      <label className="block text-sm font-semibold">
        Name
        <input
          className={fieldClass}
          defaultValue={profile?.name}
          maxLength={120}
          name="name"
          placeholder="Mailer box 30 × 22 × 5 cm"
          required
        />
      </label>
      <label className="block text-sm font-semibold">
        Package type
        <select
          className={fieldClass}
          defaultValue={profile?.packageType ?? "parcel"}
          name="packageType"
        >
          {PACKAGE_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Rank
        <input
          className={fieldClass}
          defaultValue={profile?.rank ?? 10}
          min={0}
          name="rank"
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Length (cm)
        <input
          className={fieldClass}
          defaultValue={profile?.lengthCm}
          min={1}
          name="lengthCm"
          required
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Width (cm)
        <input
          className={fieldClass}
          defaultValue={profile?.widthCm}
          min={1}
          name="widthCm"
          required
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Height (cm)
        <input
          className={fieldClass}
          defaultValue={profile?.heightCm}
          min={1}
          name="heightCm"
          required
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Max weight (g)
        <input
          className={fieldClass}
          defaultValue={profile?.maxWeightGrams}
          min={1}
          name="maxWeightGrams"
          required
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Tare weight (g)
        <input
          className={fieldClass}
          defaultValue={profile?.tareWeightGrams}
          min={0}
          name="tareWeightGrams"
          required
          step={1}
          type="number"
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          defaultChecked={profile ? profile.acceptsRigid : true}
          name="acceptsRigid"
          type="checkbox"
        />
        Rigid-capable
      </label>
    </div>
  );
}

function Detail({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div>
      <dt className="font-semibold uppercase tracking-[0.1em]">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function StatusMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p aria-live="polite" className="text-sm text-lh-muted" role="status">
      {message}
    </p>
  );
}

function fieldsBody(form: FormData): Record<string, unknown> {
  return {
    slug: form.get("slug"),
    name: form.get("name"),
    packageType: form.get("packageType"),
    rank: Number(form.get("rank")),
    lengthCm: Number(form.get("lengthCm")),
    widthCm: Number(form.get("widthCm")),
    heightCm: Number(form.get("heightCm")),
    maxWeightGrams: Number(form.get("maxWeightGrams")),
    tareWeightGrams: Number(form.get("tareWeightGrams")),
    acceptsRigid: form.get("acceptsRigid") === "on",
  };
}

function profileFieldsFromView(
  profile: PackageProfileView,
): Record<string, unknown> {
  return {
    slug: profile.slug,
    name: profile.name,
    packageType: profile.packageType,
    rank: profile.rank,
    lengthCm: profile.lengthCm,
    widthCm: profile.widthCm,
    heightCm: profile.heightCm,
    maxWeightGrams: profile.maxWeightGrams,
    tareWeightGrams: profile.tareWeightGrams,
    acceptsRigid: profile.acceptsRigid,
  };
}

async function sendProfileRequest(
  url: string,
  body: Record<string, unknown>,
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      stepUp?: MutationResult["stepUp"];
    }
> {
  try {
    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response.ok) return { ok: true };
    const result = (await response
      .json()
      .catch(() => null)) as MutationResult | null;
    const error = result?.error ?? `Action failed (${response.status})`;
    return {
      ok: false,
      status: response.status,
      message:
        response.status === 409
          ? `${error}. Refresh before retrying if the box changed.`
          : error,
      stepUp: result?.stepUp,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message: "The action could not be submitted. No change was made.",
    };
  }
}

const fieldClass =
  "mt-1 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 font-normal";
