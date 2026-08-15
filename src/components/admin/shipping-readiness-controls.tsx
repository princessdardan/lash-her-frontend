"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface PackageProfileRow {
  capacityUnits: number;
  enabled: boolean;
  evidenceReference: string | null;
  heightCm: number;
  id: string;
  lengthCm: number;
  maxWeightGrams: number;
  name: string;
  packageType: string;
  rank: number;
  reviewedAt: string | null;
  slug: string;
  tareWeightGrams: number;
  updatedAt: string;
  widthCm: number;
}

interface PolicyRow {
  approvedAt: string | null;
  createdAt: string;
  effectiveAt: string | null;
  evidenceReference: string | null;
  id: string;
  status: string;
  version: string;
}

interface ReadinessState {
  manualPolicies: Array<PolicyRow & { policyText: string }>;
  packageProfiles: PackageProfileRow[];
  taxPolicies: Array<PolicyRow & { coverage: Record<string, boolean> }>;
}

interface StepUpScope {
  action: string;
  target: string;
  targetLabel: string;
}

export function ShippingReadinessControls({
  state,
}: {
  state: ReadinessState;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<StepUpScope | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setStepUp(null);
    const payload = readinessPayload(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/admin/shipping/readiness-controls", {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        stepUp?: StepUpScope;
      } | null;
      if (!response.ok) {
        setMessage(
          result?.error ?? `Readiness action failed (${response.status})`,
        );
        setStepUp(result?.stepUp ?? null);
        return;
      }
      setMessage(
        "Readiness evidence recorded. Current state has been refreshed.",
      );
      router.refresh();
    } catch {
      setMessage(
        "The readiness action could not be submitted. No success was assumed.",
      );
    } finally {
      setPending(false);
    }
  }

  const effectiveTax = state.taxPolicies.find(
    (policy) => policy.status === "effective",
  );
  const effectiveManual = state.manualPolicies.find(
    (policy) => policy.status === "effective",
  );

  return (
    <section className="rounded-3xl border border-lh-line bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-3xl uppercase tracking-[0.08em] sm:text-4xl">
            Owner readiness controls
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-lh-muted">
            Approve package dimensions, the complete product-tax decision, and
            the published manual-order policy without direct database access.
            Every mutation is owner-only, step-up bound, versioned, and evidence
            hashed.
          </p>
        </div>
        <span className="rounded-full border border-lh-line px-3 py-1 text-xs font-semibold">
          Current
        </span>
      </div>

      {message ? (
        <p
          aria-live="polite"
          className="mt-5 rounded-xl bg-lh-neutral-2 p-4 text-sm"
          role="status"
        >
          {message}
        </p>
      ) : null}
      {stepUp ? (
        <p className="mt-4 text-sm">
          <Link
            className="font-semibold text-lh-primary underline underline-offset-4"
            href={stepUpHref(stepUp)}
            target="_blank"
          >
            Reauthenticate in a new tab
          </Link>{" "}
          and then resubmit the unchanged form in this tab.
        </p>
      ) : null}

      <div className="mt-8 space-y-8">
        <section aria-labelledby="package-profiles-heading">
          <h3 className="text-lg font-semibold" id="package-profiles-heading">
            Package profiles
          </h3>
          <p className="mt-1 text-sm text-lh-muted">
            Values must come from verified physical measurements. Disabling a
            profile prevents new quote selection but preserves history.
          </p>
          <div className="mt-4 space-y-4">
            {state.packageProfiles.map((profile) => (
              <PackageProfileForm
                key={`${profile.id}/${profile.updatedAt}`}
                pending={pending}
                profile={profile}
                submit={submit}
              />
            ))}
            <PackageProfileForm
              pending={pending}
              profile={null}
              submit={submit}
            />
          </div>
        </section>

        <section
          aria-labelledby="tax-policy-heading"
          className="border-t border-lh-line pt-8"
        >
          <h3 className="text-lg font-semibold" id="tax-policy-heading">
            Product-tax policy
          </h3>
          <p className="mt-1 text-sm text-lh-muted">
            Current: {effectiveTax ? effectiveTax.version : "none"}. A new
            approval supersedes the current version without rewriting it.
          </p>
          <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={submit}>
            <input name="action" type="hidden" value="tax_policy" />
            <input
              name="expectedCurrentEffectiveId"
              type="hidden"
              value={effectiveTax?.id ?? ""}
            />
            <TextField label="New version" name="version" required />
            <TextField
              label="Controlled evidence reference"
              name="evidenceReference"
              required
            />
            <fieldset className="md:col-span-2 rounded-xl border border-lh-line p-4">
              <legend className="px-2 text-sm font-semibold">
                Required coverage
              </legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["merchandise", "Merchandise"],
                  ["shipping", "Shipping"],
                  ["supplements", "Supplemental payments"],
                  ["usOrders", "U.S. orders"],
                  ["componentRefunds", "Component-level refunds"],
                ].map(([name, label]) => (
                  <label
                    className="flex min-h-11 items-center gap-2 text-sm"
                    key={name}
                  >
                    <input
                      defaultChecked
                      name={name}
                      required
                      type="checkbox"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <SubmitButton pending={pending}>
              Approve new tax-policy version
            </SubmitButton>
          </form>
          <PolicyHistory policies={state.taxPolicies} />
        </section>

        <section
          aria-labelledby="manual-policy-heading"
          className="border-t border-lh-line pt-8"
        >
          <h3 className="text-lg font-semibold" id="manual-policy-heading">
            Manual-order and refund policy
          </h3>
          <p className="mt-1 text-sm text-lh-muted">
            Current: {effectiveManual ? effectiveManual.version : "none"}. The
            exact published text and SHA-256 hash are snapshotted at checkout.
          </p>
          <form className="mt-4 grid gap-4 md:grid-cols-2" onSubmit={submit}>
            <input name="action" type="hidden" value="manual_policy" />
            <input
              name="expectedCurrentEffectiveId"
              type="hidden"
              value={effectiveManual?.id ?? ""}
            />
            <TextField label="New version" name="version" required />
            <TextField
              label="Controlled evidence reference"
              name="evidenceReference"
              required
            />
            <label className="md:col-span-2 text-sm font-semibold">
              Published cancellation and refund policy
              <textarea
                className={inputClass}
                maxLength={8_000}
                minLength={80}
                name="cancellationPolicyText"
                required
                rows={8}
              />
            </label>
            <SubmitButton pending={pending}>
              Approve new manual-policy version
            </SubmitButton>
          </form>
          <PolicyHistory policies={state.manualPolicies} />
        </section>
      </div>
    </section>
  );
}

function PackageProfileForm({
  pending,
  profile,
  submit,
}: {
  pending: boolean;
  profile: PackageProfileRow | null;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form
      className="grid gap-3 rounded-xl border border-lh-line p-4 md:grid-cols-3"
      onSubmit={submit}
    >
      <input name="action" type="hidden" value="package_profile" />
      <input name="id" type="hidden" value={profile?.id ?? ""} />
      <input
        name="expectedUpdatedAt"
        type="hidden"
        value={profile?.updatedAt ?? ""}
      />
      <TextField
        defaultValue={profile?.slug}
        label="Slug"
        name="slug"
        readOnly={Boolean(profile)}
        required
      />
      <TextField
        defaultValue={profile?.name}
        label="Name"
        name="name"
        required
      />
      <NumberField
        defaultValue={profile?.rank}
        label="Rank"
        min={1}
        name="rank"
      />
      <TextField
        defaultValue={profile?.packageType}
        label="Provider package type"
        name="packageType"
        required
      />
      <NumberField
        defaultValue={profile?.lengthCm}
        label="Length (cm)"
        min={1}
        name="lengthCm"
      />
      <NumberField
        defaultValue={profile?.widthCm}
        label="Width (cm)"
        min={1}
        name="widthCm"
      />
      <NumberField
        defaultValue={profile?.heightCm}
        label="Height (cm)"
        min={1}
        name="heightCm"
      />
      <NumberField
        defaultValue={profile?.tareWeightGrams}
        label="Tare weight (g)"
        min={0}
        name="tareWeightGrams"
      />
      <NumberField
        defaultValue={profile?.maxWeightGrams}
        label="Maximum weight (g)"
        min={1}
        name="maxWeightGrams"
      />
      <NumberField
        defaultValue={profile?.capacityUnits}
        label="Capacity units"
        min={1}
        name="capacityUnits"
      />
      <TextField
        defaultValue={profile?.evidenceReference ?? undefined}
        label="Controlled evidence reference"
        name="evidenceReference"
        required
      />
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
        <input
          defaultChecked={profile?.enabled ?? false}
          name="enabled"
          type="checkbox"
        />
        Enabled for new quotes
      </label>
      <div className="flex items-end">
        <SubmitButton pending={pending}>
          {profile ? "Review and save profile" : "Create reviewed profile"}
        </SubmitButton>
      </div>
      {profile ? (
        <p className="text-xs text-lh-muted md:col-span-3">
          Stable ID {profile.id}; last reviewed {formatDate(profile.reviewedAt)}
          ; conflict token {profile.updatedAt}.
        </p>
      ) : null}
    </form>
  );
}

function PolicyHistory({ policies }: { policies: PolicyRow[] }) {
  if (!policies.length) return null;
  return (
    <details className="mt-4">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-lh-primary">
        Version history ({policies.length})
      </summary>
      <ul className="space-y-2 text-sm text-lh-muted">
        {policies.map((policy) => (
          <li className="rounded-xl bg-lh-neutral-2 p-3" key={policy.id}>
            <span className="font-semibold text-lh-shadow">
              {policy.version}
            </span>{" "}
            — {policy.status}; approved {formatDate(policy.approvedAt)};
            evidence {policy.evidenceReference ?? "missing"}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TextField({
  defaultValue,
  label,
  name,
  readOnly,
  required,
}: {
  defaultValue?: string;
  label: string;
  name: string;
  readOnly?: boolean;
  required?: boolean;
}) {
  return (
    <label className="text-sm font-semibold">
      {label}
      <input
        className={inputClass}
        defaultValue={defaultValue}
        maxLength={500}
        name={name}
        readOnly={readOnly}
        required={required}
      />
    </label>
  );
}

function NumberField({
  defaultValue,
  label,
  min,
  name,
}: {
  defaultValue?: number;
  label: string;
  min: number;
  name: string;
}) {
  return (
    <label className="text-sm font-semibold">
      {label}
      <input
        className={inputClass}
        defaultValue={defaultValue}
        min={min}
        name={name}
        required
        step={1}
        type="number"
      />
    </label>
  );
}

function SubmitButton({
  children,
  pending,
}: {
  children: React.ReactNode;
  pending: boolean;
}) {
  return (
    <button
      className="min-h-11 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? "Recording…" : children}
    </button>
  );
}

function readinessPayload(form: FormData): Record<string, unknown> {
  const action = String(form.get("action") ?? "");
  if (action === "package_profile") {
    return {
      action,
      id: form.get("id"),
      expectedUpdatedAt: form.get("expectedUpdatedAt"),
      slug: form.get("slug"),
      name: form.get("name"),
      rank: Number(form.get("rank")),
      packageType: form.get("packageType"),
      lengthCm: Number(form.get("lengthCm")),
      widthCm: Number(form.get("widthCm")),
      heightCm: Number(form.get("heightCm")),
      tareWeightGrams: Number(form.get("tareWeightGrams")),
      maxWeightGrams: Number(form.get("maxWeightGrams")),
      capacityUnits: Number(form.get("capacityUnits")),
      evidenceReference: form.get("evidenceReference"),
      enabled: form.get("enabled") === "on",
    };
  }
  if (action === "tax_policy") {
    return {
      action,
      version: form.get("version"),
      evidenceReference: form.get("evidenceReference"),
      expectedCurrentEffectiveId: form.get("expectedCurrentEffectiveId"),
      coverage: {
        merchandise: form.get("merchandise") === "on",
        shipping: form.get("shipping") === "on",
        supplements: form.get("supplements") === "on",
        usOrders: form.get("usOrders") === "on",
        componentRefunds: form.get("componentRefunds") === "on",
      },
    };
  }
  return {
    action,
    version: form.get("version"),
    evidenceReference: form.get("evidenceReference"),
    expectedCurrentEffectiveId: form.get("expectedCurrentEffectiveId"),
    cancellationPolicyText: form.get("cancellationPolicyText"),
  };
}

function stepUpHref(scope: StepUpScope): string {
  const query = new URLSearchParams({
    action: scope.action,
    returnTo: "/admin/shipping-readiness",
    target: scope.target,
    targetLabel: scope.targetLabel,
  });
  return `/admin/step-up?${query.toString()}`;
}

function formatDate(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-CA", { timeZone: "America/Toronto" })
    : "invalid date";
}

const inputClass =
  "mt-2 w-full rounded-xl border border-lh-line bg-white px-3 py-2.5 text-sm read-only:bg-lh-neutral-2";
