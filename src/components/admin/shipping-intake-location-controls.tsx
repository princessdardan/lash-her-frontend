"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

interface CurrentIntakeLocation {
  evidenceReference: string;
  id: string;
  locationAddress: string;
  locationName: string;
  locationType: "branch" | "drop_spot" | "mail_in_hub";
  policyVersion: string;
}

interface StepUpScope {
  action: string;
  target: string;
  targetLabel: string;
}

export function ShippingIntakeLocationControls({
  current,
  statement,
  statementVersion,
}: {
  current: CurrentIntakeLocation | null;
  statement: string;
  statementVersion: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [stepUp, setStepUp] = useState<StepUpScope | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = intakeLocationPayload(new FormData(event.currentTarget));
    if (
      payload.action === "revoke" &&
      !window.confirm(
        "Revoke this active Chit Chats intake-location attestation? Checkout readiness will fail until the owner records a valid replacement.",
      )
    ) {
      return;
    }
    setMessage(null);
    setPending(true);
    setStepUp(null);
    try {
      const response = await fetch("/api/admin/shipping/intake-location", {
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
          result?.error ??
            `The intake-location action failed (${response.status})`,
        );
        setStepUp(result?.stepUp ?? null);
        return;
      }
      setMessage(
        payload.action === "attest"
          ? "Chit Chats intake location attested."
          : "Chit Chats intake-location attestation revoked.",
      );
      router.refresh();
    } catch {
      setMessage(
        "The intake-location action could not be submitted. No success was assumed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <section className={panelClass}>
        <h2 className={sectionHeadingClass}>
          {current ? "Replace or renew attestation" : "Record intake location"}
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-lh-muted">
          Record the physical location where parcels first enter the Chit Chats
          network. Saving a replacement preserves and revokes the prior record.
        </p>
        <MutationFeedback message={message} stepUp={stepUp} />

        <form className="mt-6 space-y-5" onSubmit={submit}>
          <input name="action" type="hidden" value="attest" />
          <input
            name="expectedCurrentAttestationId"
            type="hidden"
            value={current?.id ?? ""}
          />
          <input
            name="statementVersion"
            type="hidden"
            value={statementVersion}
          />

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Location type">
              <select
                className={inputClass}
                defaultValue={current?.locationType ?? "branch"}
                name="locationType"
                required
              >
                <option value="branch">Chit Chats branch</option>
                <option value="drop_spot">Chit Chats drop spot</option>
                <option value="mail_in_hub">Mail-in hub</option>
              </select>
            </Field>
            <Field label="Location name">
              <input
                className={inputClass}
                defaultValue={current?.locationName ?? ""}
                maxLength={160}
                name="locationName"
                required
              />
            </Field>
          </div>

          <Field label="Physical location address">
            <textarea
              className={inputClass}
              defaultValue={current?.locationAddress ?? ""}
              maxLength={500}
              name="locationAddress"
              required
              rows={3}
            />
          </Field>

          <Field label="Evidence reference">
            <input
              className={inputClass}
              defaultValue={current?.evidenceReference ?? ""}
              maxLength={500}
              name="evidenceReference"
              placeholder="Support case, official location URL, or controlled evidence reference"
              required
            />
          </Field>

          <Field label="Owner rationale">
            <textarea
              className={inputClass}
              maxLength={1_000}
              minLength={10}
              name="rationale"
              required
              rows={4}
            />
          </Field>

          <div className="rounded-2xl border border-lh-line bg-lh-neutral-2 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
              Statement {statementVersion}
            </p>
            <p
              className="mt-3 text-sm leading-6"
              id="intake-attestation-statement"
            >
              {statement}
            </p>
            <label className="mt-4 flex items-start gap-3 text-sm font-semibold">
              <input
                aria-describedby="intake-attestation-statement"
                className="mt-1"
                name="statementConfirmed"
                required
                type="checkbox"
                value="confirmed"
              />
              <span>I confirm this exact versioned statement.</span>
            </label>
          </div>

          <button
            className={primaryButtonClass}
            disabled={pending}
            type="submit"
          >
            {pending ? "Recording attestation…" : "Record owner attestation"}
          </button>
          <p className="text-xs leading-5 text-lh-muted">
            The first submission binds every displayed value to a step-up
            challenge. After Google reauthentication, resubmit this unchanged
            form within five minutes.
          </p>
        </form>
      </section>

      {current ? (
        <section className="rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
          <h2 className={sectionHeadingClass}>Revoke active attestation</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-lh-muted">
            Revocation immediately removes this intake-location readiness
            evidence. Existing history remains immutable.
          </p>
          <form className="mt-5 space-y-4" onSubmit={submit}>
            <input name="action" type="hidden" value="revoke" />
            <input
              name="expectedCurrentAttestationId"
              type="hidden"
              value={current.id}
            />
            <input
              name="expectedCurrentPolicyVersion"
              type="hidden"
              value={current.policyVersion}
            />
            <Field label="Revocation reason">
              <textarea
                className={inputClass}
                maxLength={1_000}
                minLength={10}
                name="reason"
                required
                rows={3}
              />
            </Field>
            <button
              className={dangerButtonClass}
              disabled={pending}
              type="submit"
            >
              {pending ? "Revoking attestation…" : "Revoke attestation"}
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}

function MutationFeedback({
  message,
  stepUp,
}: {
  message: string | null;
  stepUp: StepUpScope | null;
}) {
  if (!message && !stepUp) return null;
  return (
    <div className="mt-5 space-y-3">
      {message ? (
        <p
          aria-live="polite"
          className="rounded-xl bg-lh-neutral-2 p-4 text-sm"
          role="status"
        >
          {message}
        </p>
      ) : null}
      {stepUp ? (
        <p className="text-sm">
          <Link
            className="font-semibold text-lh-primary underline underline-offset-4"
            href={stepUpHref(stepUp)}
            rel="noopener noreferrer"
            target="_blank"
          >
            Reauthenticate for this exact payload
          </Link>{" "}
          and then resubmit the unchanged form in this tab.
        </p>
      ) : null}
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block text-sm font-medium">
      <span className={fieldLabelClass}>{label}</span>
      {children}
    </label>
  );
}

export function intakeLocationPayload(form: FormData): Record<string, unknown> {
  const action = String(form.get("action") ?? "");
  if (action === "revoke") {
    return {
      action,
      expectedCurrentAttestationId: form.get("expectedCurrentAttestationId"),
      expectedCurrentPolicyVersion: form.get("expectedCurrentPolicyVersion"),
      reason: form.get("reason"),
    };
  }
  return {
    action,
    evidenceReference: form.get("evidenceReference"),
    expectedCurrentAttestationId: form.get("expectedCurrentAttestationId"),
    locationAddress: form.get("locationAddress"),
    locationName: form.get("locationName"),
    locationType: form.get("locationType"),
    rationale: form.get("rationale"),
    statementConfirmed: form.get("statementConfirmed") === "confirmed",
    statementVersion: form.get("statementVersion"),
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

const panelClass = "rounded-3xl border border-lh-line bg-white p-6 shadow-sm";
const sectionHeadingClass =
  "font-heading text-3xl uppercase tracking-[0.08em] sm:text-4xl";
const fieldLabelClass =
  "mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted";
const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2.5 text-sm";
const primaryButtonClass =
  "min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60";
const dangerButtonClass =
  "min-h-11 rounded-full border border-red-300 px-5 text-sm font-semibold text-red-800 disabled:cursor-wait disabled:opacity-60";
