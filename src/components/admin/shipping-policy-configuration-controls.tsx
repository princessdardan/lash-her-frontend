"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

interface ConfigurationState {
  calendarExceptions: Array<{
    exceptionDate: string;
    id: string;
    kind: string;
    label: string;
    updatedAt: string;
  }>;
  calendarVersions: Array<{
    coverageEndsOn: string;
    coverageStartsOn: string;
    evidenceReference: string | null;
    id: string;
    status: string;
    version: string;
  }>;
  fulfillmentPolicies: Array<{
    evidenceReference: string | null;
    id: string;
    policySnapshot: Record<string, unknown>;
    snapshotHash: string;
    status: string;
    version: string;
  }>;
  fundingReviews: Array<{
    balanceCents: number | null;
    calculatedFiveBusinessDaySpendCents: number | null;
    calculatedTwoBusinessDaySpendCents: number | null;
    id: string;
    kind: string;
    status: string;
    validUntil: string | null;
  }>;
  helcimContract:
    | ({
        effectiveUntil: string;
        evidenceReference: string;
        version: string;
      } & object)
    | null;
  policyAssignments: Array<{
    active: boolean;
    adminUserId: string;
    duty: string;
    id: string;
  }>;
  policySettings: {
    forwarderPatterns: string[];
    pilotStartedAt: string | null;
    policyVersion: string;
    updatedAt: string;
  } | null;
  providerCertifications: Array<{
    certifiedAt: string;
    environment: string;
    evidenceReference: string;
    id: string;
    provider: string;
    revokedAt: string | null;
    scope: string;
    validUntil: string;
    version: string;
  }>;
  servicePolicies: Array<{
    claimDeadlineDays: number;
    claimWaitingDays: number;
    destinationCountryCode: string;
    enabled: boolean;
    evidenceReference: string | null;
    id: string;
    insuranceLimitCents: number;
    postageType: string;
    signatureCapable: boolean;
    trackingRequired: boolean;
    updatedAt: string;
  }>;
}

interface StepUpScope {
  action: string;
  target: string;
}

const REQUIRED_DUTIES = [
  "business_owner",
  "operations_lead",
  "finance_owner",
  "payment_fraud_owner",
  "privacy_owner",
  "security_owner",
] as const;

export function ShippingPolicyConfigurationControls({
  actorAdminUserId,
  state,
}: {
  actorAdminUserId: string;
  state: ConfigurationState;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<StepUpScope | null>(null);

  async function submit(
    event: FormEvent<HTMLFormElement>,
    endpoint:
      | "/api/admin/shipping/funding-reviews"
      | "/api/admin/shipping/policy",
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let payload: Record<string, unknown>;
    try {
      payload =
        endpoint === "/api/admin/shipping/policy"
          ? policyPayload(form)
          : fundingPayload(form);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Configuration values are invalid",
      );
      return;
    }
    if (
      !window.confirm(
        `Record the reviewed ${String(payload.action ?? payload.kind ?? "readiness")} action?`,
      )
    ) {
      return;
    }
    setPending(true);
    setMessage(null);
    setStepUp(null);
    try {
      const response = await fetch(endpoint, {
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
          result?.error ?? `Configuration action failed (${response.status})`,
        );
        setStepUp(result?.stepUp ?? null);
        return;
      }
      setMessage(
        "Configuration evidence recorded. Current state has been refreshed.",
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Configuration action could not be submitted",
      );
    } finally {
      setPending(false);
    }
  }

  async function approveFundingReview(reviewId: string) {
    if (!window.confirm(`Approve the reviewed funding forecast ${reviewId}?`)) {
      return;
    }
    setPending(true);
    setMessage(null);
    setStepUp(null);
    try {
      const response = await fetch(
        `/api/admin/shipping/funding-reviews/${encodeURIComponent(reviewId)}/approve`,
        {
          body: JSON.stringify({ markApplied: false }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        stepUp?: StepUpScope;
      } | null;
      if (!response.ok) {
        setMessage(
          result?.error ?? `Funding approval failed (${response.status})`,
        );
        setStepUp(result?.stepUp ?? null);
        return;
      }
      setMessage(
        "Funding forecast approved. Current state has been refreshed.",
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Funding approval could not be submitted",
      );
    } finally {
      setPending(false);
    }
  }

  const effectivePolicy = state.fulfillmentPolicies.find(
    (policy) => policy.status === "effective",
  );
  const approvedForecasts = state.fundingReviews.filter(
    (review) =>
      review.kind === "thirty_day_review" &&
      (review.status === "approved" || review.status === "applied"),
  );

  return (
    <section className="rounded-3xl border border-lh-line bg-white p-6 shadow-sm">
      <h2 className="font-heading text-3xl uppercase tracking-[0.08em] sm:text-4xl">
        Policy and funding configuration
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-lh-muted">
        These controls are the supported owner workflow for every remaining
        launch-readiness record. Step-up proofs bind the exact submitted values;
        a changed form requires a new proof.
      </p>
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
            rel="noopener noreferrer"
            target="_blank"
          >
            Reauthenticate for this exact action
          </Link>{" "}
          and resubmit the unchanged form.
        </p>
      ) : null}

      <div className="mt-8 space-y-8">
        <Panel title="Owner duty assignments">
          <p className={helpClass}>
            All six duties must be actively assigned to the sole configured
            owner.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {REQUIRED_DUTIES.map((duty) => {
              const assignment = state.policyAssignments.find(
                (item) => item.active && item.duty === duty,
              );
              const current = assignment?.adminUserId === actorAdminUserId;
              return (
                <form
                  className={cardClass}
                  key={duty}
                  onSubmit={(event) =>
                    submit(event, "/api/admin/shipping/policy")
                  }
                >
                  <input name="action" type="hidden" value="assign_duty" />
                  <input
                    name="adminUserId"
                    type="hidden"
                    value={actorAdminUserId}
                  />
                  <input name="duty" type="hidden" value={duty} />
                  <p className="font-mono text-xs">{duty}</p>
                  <p className="mt-2 text-xs text-lh-muted">
                    {current
                      ? `Assigned (${assignment.id})`
                      : "Owner assignment required"}
                  </p>
                  <ActionButton disabled={pending || current}>
                    Assign to owner
                  </ActionButton>
                </form>
              );
            })}
          </div>
        </Panel>

        <Panel title="Effective fulfillment policy">
          <p className={helpClass}>
            Current: {effectivePolicy?.version ?? "none"}. Activation records
            the owner’s privacy/legal, security, and operations
            self-attestations and aligns policy settings atomically.
          </p>
          {state.fulfillmentPolicies
            .filter((policy) => policy.status === "draft")
            .map((policy) => (
              <form
                className={`${cardClass} mt-4 grid gap-3 md:grid-cols-2`}
                key={policy.id}
                onSubmit={(event) =>
                  submit(event, "/api/admin/shipping/policy")
                }
              >
                <input
                  name="action"
                  type="hidden"
                  value="activate_fulfillment_policy"
                />
                <input name="version" type="hidden" value={policy.version} />
                <input
                  name="expectedCurrentEffectiveId"
                  type="hidden"
                  value={effectivePolicy?.id ?? ""}
                />
                <input
                  name="expectedPolicySnapshotHash"
                  type="hidden"
                  value={policy.snapshotHash}
                />
                <p className="self-center text-sm font-semibold">
                  Draft {policy.version}
                  <span className="mt-1 block break-all font-mono text-xs font-normal text-lh-muted">
                    {policy.id}
                  </span>
                </p>
                <TextField
                  label="Controlled evidence reference"
                  name="evidenceReference"
                  required
                />
                <label className="text-sm font-semibold md:col-span-2">
                  Exact draft snapshot ({policy.snapshotHash})
                  <textarea
                    className={inputClass}
                    readOnly
                    rows={12}
                    value={JSON.stringify(policy.policySnapshot, null, 2)}
                  />
                </label>
                <ActionButton disabled={pending}>
                  Activate draft policy
                </ActionButton>
              </form>
            ))}
        </Panel>

        <Panel title="Provider certifications">
          <p className={helpClass}>
            Helcim certification is matched to the configured typed contract.
            U.S. Chit Chats certification requires the exact reviewed DDU
            contract JSON.
          </p>
          <form
            className="mt-4 grid gap-4 md:grid-cols-2"
            onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
          >
            <input name="action" type="hidden" value="certify_provider" />
            <input name="provider" type="hidden" value="chitchats" />
            <p className="self-center text-sm font-semibold">Chit Chats</p>
            <SelectField
              label="Environment"
              name="environment"
              options={[
                ["staging", "Staging"],
                ["production", "Production"],
              ]}
            />
            <TextField
              label="Scope (canada or us_shipping_contract)"
              name="scope"
              required
            />
            <TextField label="Contract version" name="version" required />
            <TextField
              label="Controlled evidence reference"
              name="evidenceReference"
              required
            />
            <TextField
              label="Valid until"
              name="validUntil"
              required
              type="datetime-local"
            />
            <label className="text-sm font-semibold md:col-span-2">
              Reviewed contract snapshot JSON (required for U.S. DDU)
              <textarea
                className={inputClass}
                name="contractSnapshot"
                rows={7}
              />
            </label>
            <ActionButton disabled={pending}>
              Record Chit Chats certification
            </ActionButton>
          </form>
          {state.helcimContract ? (
            <form
              className={`${cardClass} mt-5 grid gap-4 md:grid-cols-2`}
              onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
            >
              <input name="action" type="hidden" value="certify_provider" />
              <input name="provider" type="hidden" value="helcim" />
              <input name="scope" type="hidden" value="product_payments" />
              <input
                name="version"
                type="hidden"
                value={state.helcimContract.version}
              />
              <input
                name="evidenceReference"
                type="hidden"
                value={state.helcimContract.evidenceReference}
              />
              <input
                name="validUntil"
                type="hidden"
                value={state.helcimContract.effectiveUntil}
              />
              <input
                name="contractSnapshot"
                type="hidden"
                value={JSON.stringify(state.helcimContract)}
              />
              <p className="text-sm font-semibold">
                Helcim contract {state.helcimContract.version}
                <span className="mt-1 block text-xs font-normal text-lh-muted">
                  {state.helcimContract.evidenceReference}; valid until{" "}
                  {formatDate(state.helcimContract.effectiveUntil)}
                </span>
              </p>
              <SelectField
                label="Environment"
                name="environment"
                options={[
                  ["staging", "Staging"],
                  ["production", "Production"],
                ]}
              />
              <label className="text-sm font-semibold md:col-span-2">
                Exact configured contract snapshot
                <textarea
                  className={inputClass}
                  readOnly
                  rows={10}
                  value={JSON.stringify(state.helcimContract, null, 2)}
                />
              </label>
              <ActionButton disabled={pending}>
                Certify exact Helcim contract
              </ActionButton>
            </form>
          ) : (
            <p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">
              A valid HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON must be configured
              before Helcim can be certified.
            </p>
          )}
          <div className="mt-4 space-y-3">
            {state.providerCertifications.map((item) => (
              <div className={cardClass} key={item.id}>
                <p className="break-all text-xs text-lh-muted">
                  {item.provider}/{item.environment}/{item.scope}/{item.version}{" "}
                  —{" "}
                  {item.revokedAt
                    ? "revoked"
                    : `valid until ${formatDate(item.validUntil)}`}{" "}
                  — {item.id}
                </p>
                {!item.revokedAt ? (
                  <form
                    className="mt-3 grid gap-3 md:grid-cols-2"
                    onSubmit={(event) =>
                      submit(event, "/api/admin/shipping/policy")
                    }
                  >
                    <input
                      name="action"
                      type="hidden"
                      value="revoke_provider_certification"
                    />
                    <input
                      name="certificationId"
                      type="hidden"
                      value={item.id}
                    />
                    <input
                      name="expectedValidUntil"
                      type="hidden"
                      value={item.validUntil}
                    />
                    <TextField
                      label="Revocation rationale"
                      name="reason"
                      required
                    />
                    <ActionButton disabled={pending}>
                      Revoke certification
                    </ActionButton>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Tracked and insured service policies">
          <p className={helpClass}>
            Review every enabled service at least every 90 days. U.S. rows must
            match the current certified DDU contract.
          </p>
          <div className="mt-4 space-y-4">
            {state.servicePolicies.map((policy) => (
              <ServicePolicyForm
                key={policy.id}
                pending={pending}
                policy={policy}
                submit={submit}
              />
            ))}
            <ServicePolicyForm
              pending={pending}
              policy={null}
              submit={submit}
            />
          </div>
        </Panel>

        <Panel title="Calendar coverage and activation">
          <form
            className="mt-4 grid gap-4 md:grid-cols-2"
            onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
          >
            <input name="action" type="hidden" value="calendar_exception" />
            <TextField
              label="Closure date"
              name="exceptionDate"
              required
              type="date"
            />
            <SelectField
              label="Kind"
              name="kind"
              options={[
                ["ontario_holiday", "Ontario statutory/observed"],
                ["branch_closure", "Branch closure"],
              ]}
            />
            <TextField label="Reviewed label" name="label" required />
            <ActionButton disabled={pending}>
              Save reviewed closure
            </ActionButton>
          </form>
          <div className="mt-4 space-y-3">
            {state.calendarExceptions.map((item) => (
              <div className={cardClass} key={item.id}>
                <form
                  className="grid gap-3 md:grid-cols-3"
                  onSubmit={(event) =>
                    submit(event, "/api/admin/shipping/policy")
                  }
                >
                  <input
                    name="action"
                    type="hidden"
                    value="calendar_exception"
                  />
                  <input name="id" type="hidden" value={item.id} />
                  <input
                    name="expectedUpdatedAt"
                    type="hidden"
                    value={item.updatedAt}
                  />
                  <TextField
                    defaultValue={item.exceptionDate}
                    label="Closure date"
                    name="exceptionDate"
                    readOnly
                    required
                    type="date"
                  />
                  <input name="kind" type="hidden" value={item.kind} />
                  <TextField
                    defaultValue={item.kind}
                    label="Kind"
                    name="kindDisplay"
                    readOnly
                  />
                  <TextField
                    defaultValue={item.label}
                    label="Reviewed label"
                    name="label"
                    required
                  />
                  <ActionButton disabled={pending}>
                    Update closure label
                  </ActionButton>
                </form>
                <form
                  className="mt-3 grid gap-3 md:grid-cols-2"
                  onSubmit={(event) =>
                    submit(event, "/api/admin/shipping/policy")
                  }
                >
                  <input
                    name="action"
                    type="hidden"
                    value="remove_calendar_exception"
                  />
                  <input name="id" type="hidden" value={item.id} />
                  <input
                    name="expectedUpdatedAt"
                    type="hidden"
                    value={item.updatedAt}
                  />
                  <TextField label="Removal rationale" name="reason" required />
                  <ActionButton disabled={pending}>Remove closure</ActionButton>
                </form>
              </div>
            ))}
          </div>
          <form
            className="mt-6 grid gap-4 md:grid-cols-2"
            onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
          >
            <input name="action" type="hidden" value="activate_calendar" />
            <input
              name="expectedCurrentEffectiveId"
              type="hidden"
              value={
                state.calendarVersions.find(
                  (version) => version.status === "effective",
                )?.id ?? ""
              }
            />
            <TextField label="New calendar version" name="version" required />
            <TextField
              defaultValue="America/Toronto"
              label="Timezone"
              name="timezone"
              readOnly
              required
            />
            <TextField
              label="Coverage starts"
              name="coverageStartsOn"
              required
              type="date"
            />
            <TextField
              label="Coverage ends"
              name="coverageEndsOn"
              required
              type="date"
            />
            <TextField
              label="Controlled evidence reference"
              name="evidenceReference"
              required
            />
            <ActionButton disabled={pending}>
              Activate complete calendar
            </ActionButton>
          </form>
          <RecordList
            items={state.calendarVersions.map(
              (item) =>
                `${item.version} — ${item.status}; ${item.coverageStartsOn} to ${item.coverageEndsOn} — ${item.id}`,
            )}
          />
        </Panel>

        <Panel title="Policy settings">
          <p className={helpClass}>
            Current policy version{" "}
            {state.policySettings?.policyVersion ?? "missing"}; conflict token{" "}
            {state.policySettings?.updatedAt ?? "missing"}.
          </p>
          <form
            className="mt-4 grid gap-4 md:grid-cols-2"
            onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
          >
            <input name="action" type="hidden" value="settings" />
            <input
              name="expectedUpdatedAt"
              type="hidden"
              value={state.policySettings?.updatedAt ?? ""}
            />
            <label className="text-sm font-semibold md:col-span-2">
              Reviewed freight-forwarder patterns, one per line
              <textarea
                className={inputClass}
                defaultValue={state.policySettings?.forwarderPatterns.join(
                  "\n",
                )}
                name="forwarderPatterns"
                rows={5}
              />
            </label>
            <TextField
              defaultValue={toLocalDateTime(
                state.policySettings?.pilotStartedAt,
              )}
              label="Pilot start"
              name="pilotStartedAt"
              type="datetime-local"
            />
            <ActionButton disabled={pending}>
              Save owner-reviewed settings
            </ActionButton>
          </form>
        </Panel>

        <Panel title="Funding attestations">
          <p className={helpClass}>
            Record the observed Chit Chats balance against an approved forecast.
            During the first 30 production days this evidence expires within 24
            hours.
          </p>
          <form
            className="mt-4 grid gap-4 md:grid-cols-2"
            onSubmit={(event) =>
              submit(event, "/api/admin/shipping/funding-reviews")
            }
          >
            <SelectField
              label="Record kind"
              name="kind"
              options={[
                ["initial_forecast", "Prelaunch owner forecast"],
                ["balance_check", "Balance attestation"],
                ["reload", "Reload result"],
                ["emergency_top_up", "Emergency top-up"],
              ]}
            />
            <NumberField
              label="Observed balance (cents)"
              min={0}
              name="balanceCents"
            />
            <NumberField
              label="Two-business-day forecast (cents)"
              min={1}
              name="calculatedTwoBusinessDaySpendCents"
            />
            <NumberField
              label="Five-business-day forecast (cents)"
              min={1}
              name="calculatedFiveBusinessDaySpendCents"
            />
            <NumberField
              defaultValue={2500}
              label="Reload threshold (cents)"
              min={1}
              name="reloadThresholdCents"
            />
            <NumberField
              defaultValue={10000}
              label="Reload amount (cents)"
              min={1}
              name="reloadAmountCents"
            />
            <NumberField
              label="Emergency top-up (cents)"
              min={1}
              name="topUpAmountCents"
            />
            <label className="text-sm font-semibold">
              Approved forecast
              <select className={inputClass} name="forecastReviewId">
                <option value="">Select when recording balance</option>
                {approvedForecasts.map((review) => (
                  <option key={review.id} value={review.id}>
                    {review.id} — 2-day{" "}
                    {review.calculatedTwoBusinessDaySpendCents ?? "?"} cents
                  </option>
                ))}
              </select>
            </label>
            <TextField
              label="Dashboard evidence reference"
              name="externalEvidenceReference"
            />
            <TextField
              label="Observed at"
              name="observedAt"
              type="datetime-local"
            />
            <TextField
              label="Valid until"
              name="validUntil"
              type="datetime-local"
            />
            <Checkbox
              label="Dedicated business card confirmed"
              name="dedicatedBusinessCardConfirmed"
            />
            <Checkbox
              label="Issuer alerts confirmed"
              name="issuerAlertsConfirmed"
            />
            <Checkbox
              defaultChecked
              label="Provider operation succeeded"
              name="successful"
            />
            <ActionButton disabled={pending}>
              Record funding evidence
            </ActionButton>
          </form>
          <RecordList
            items={state.fundingReviews
              .slice(0, 20)
              .map(
                (item) =>
                  `${item.kind}/${item.status} — balance ${item.balanceCents ?? "n/a"}; valid ${formatDate(item.validUntil)} — ${item.id}`,
              )}
          />
          <div className="mt-4 space-y-3">
            {state.fundingReviews
              .filter(
                (item) =>
                  item.kind === "thirty_day_review" &&
                  item.status === "recommended",
              )
              .map((item) => (
                <div className={cardClass} key={item.id}>
                  <p className="break-all text-xs text-lh-muted">
                    Forecast awaiting owner/finance approval: {item.id}
                  </p>
                  <button
                    className="mt-3 min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:opacity-60"
                    disabled={pending}
                    onClick={() => approveFundingReview(item.id)}
                    type="button"
                  >
                    Approve forecast
                  </button>
                </div>
              ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function ServicePolicyForm({
  pending,
  policy,
  submit,
}: {
  pending: boolean;
  policy: ConfigurationState["servicePolicies"][number] | null;
  submit: (
    event: FormEvent<HTMLFormElement>,
    endpoint:
      | "/api/admin/shipping/funding-reviews"
      | "/api/admin/shipping/policy",
  ) => Promise<void>;
}) {
  return (
    <form
      className={`${cardClass} grid gap-3 md:grid-cols-3`}
      onSubmit={(event) => submit(event, "/api/admin/shipping/policy")}
    >
      <input name="action" type="hidden" value="service_policy" />
      {policy ? <input name="id" type="hidden" value={policy.id} /> : null}
      {policy ? (
        <input
          name="expectedUpdatedAt"
          type="hidden"
          value={policy.updatedAt}
        />
      ) : null}
      <TextField
        defaultValue={policy?.postageType}
        label="Exact postage type"
        name="postageType"
        readOnly={Boolean(policy)}
        required
      />
      {policy ? (
        <>
          <input
            name="destinationCountryCode"
            type="hidden"
            value={policy.destinationCountryCode}
          />
          <TextField
            defaultValue={policy.destinationCountryCode}
            label="Destination"
            name="destinationDisplay"
            readOnly
          />
        </>
      ) : (
        <SelectField
          label="Destination"
          name="destinationCountryCode"
          options={[
            ["CA", "Canada"],
            ["US", "United States DDU"],
          ]}
        />
      )}
      <NumberField
        defaultValue={policy?.insuranceLimitCents}
        label="Insurance limit (cents)"
        min={1}
        name="insuranceLimitCents"
      />
      <NumberField
        defaultValue={policy?.claimWaitingDays}
        label="Claim wait (days)"
        min={0}
        name="claimWaitingDays"
      />
      <NumberField
        defaultValue={policy?.claimDeadlineDays}
        label="Claim deadline (days)"
        min={1}
        name="claimDeadlineDays"
      />
      <TextField
        defaultValue={policy?.evidenceReference ?? undefined}
        label="Controlled evidence reference"
        name="evidenceReference"
        required
      />
      <Checkbox
        defaultChecked={policy?.trackingRequired ?? true}
        label="Tracking required"
        name="trackingRequired"
      />
      <Checkbox
        defaultChecked={policy?.signatureCapable ?? false}
        label="Signature capable"
        name="signatureCapable"
      />
      <Checkbox
        defaultChecked={policy?.enabled ?? false}
        label="Enabled"
        name="enabled"
      />
      <ActionButton disabled={pending}>
        {policy ? "Review and save service" : "Create reviewed service"}
      </ActionButton>
      {policy ? (
        <p className="break-all font-mono text-xs text-lh-muted md:col-span-3">
          Stable ID {policy.id}
        </p>
      ) : null}
    </form>
  );
}

function policyPayload(form: FormData): Record<string, unknown> {
  const action = String(form.get("action") ?? "");
  if (action === "assign_duty") {
    return {
      action,
      adminUserId: form.get("adminUserId"),
      duty: form.get("duty"),
    };
  }
  if (action === "activate_fulfillment_policy") {
    return {
      action,
      evidenceReference: form.get("evidenceReference"),
      expectedCurrentEffectiveId: form.get("expectedCurrentEffectiveId"),
      expectedPolicySnapshotHash: form.get("expectedPolicySnapshotHash"),
      version: form.get("version"),
    };
  }
  if (action === "certify_provider") {
    const snapshotText = String(form.get("contractSnapshot") ?? "").trim();
    let contractSnapshot: Record<string, unknown> | undefined;
    if (snapshotText) {
      const parsed = JSON.parse(snapshotText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Contract snapshot must be a JSON object");
      }
      contractSnapshot = parsed as Record<string, unknown>;
    }
    return {
      action,
      contractSnapshot,
      environment: form.get("environment"),
      evidenceReference: form.get("evidenceReference"),
      provider: form.get("provider"),
      scope: form.get("scope"),
      validUntil: localDateToIso(form.get("validUntil")),
      version: form.get("version"),
    };
  }
  if (action === "revoke_provider_certification") {
    return {
      action,
      certificationId: form.get("certificationId"),
      expectedValidUntil: form.get("expectedValidUntil"),
      reason: form.get("reason"),
    };
  }
  if (action === "service_policy") {
    return {
      action,
      claimDeadlineDays: number(form, "claimDeadlineDays"),
      claimWaitingDays: number(form, "claimWaitingDays"),
      destinationCountryCode: form.get("destinationCountryCode"),
      enabled: checked(form, "enabled"),
      evidenceReference: form.get("evidenceReference"),
      expectedUpdatedAt: form.get("expectedUpdatedAt"),
      id: emptyToUndefined(form.get("id")),
      insuranceLimitCents: number(form, "insuranceLimitCents"),
      postageType: form.get("postageType"),
      signatureCapable: checked(form, "signatureCapable"),
      trackingRequired: checked(form, "trackingRequired"),
    };
  }
  if (action === "calendar_exception") {
    return {
      action,
      exceptionDate: form.get("exceptionDate"),
      expectedUpdatedAt: emptyToUndefined(form.get("expectedUpdatedAt")),
      id: emptyToUndefined(form.get("id")),
      kind: form.get("kind"),
      label: form.get("label"),
    };
  }
  if (action === "remove_calendar_exception") {
    return {
      action,
      expectedUpdatedAt: form.get("expectedUpdatedAt"),
      id: form.get("id"),
      reason: form.get("reason"),
    };
  }
  if (action === "activate_calendar") {
    return {
      action,
      coverageEndsOn: form.get("coverageEndsOn"),
      coverageStartsOn: form.get("coverageStartsOn"),
      evidenceReference: form.get("evidenceReference"),
      expectedCurrentEffectiveId: form.get("expectedCurrentEffectiveId"),
      timezone: form.get("timezone"),
      version: form.get("version"),
    };
  }
  if (action === "settings") {
    return {
      action,
      expectedUpdatedAt: form.get("expectedUpdatedAt"),
      forwarderPatterns: String(form.get("forwarderPatterns") ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      pilotStartedAt: localDateToIso(form.get("pilotStartedAt")),
    };
  }
  throw new Error("Policy action is invalid");
}

function fundingPayload(form: FormData): Record<string, unknown> {
  const kind = String(form.get("kind") ?? "");
  const common = {
    dedicatedBusinessCardConfirmed: checked(
      form,
      "dedicatedBusinessCardConfirmed",
    ),
    issuerAlertsConfirmed: checked(form, "issuerAlertsConfirmed"),
    kind,
  };
  if (kind === "initial_forecast")
    return {
      ...common,
      calculatedFiveBusinessDaySpendCents: optionalNumber(
        form,
        "calculatedFiveBusinessDaySpendCents",
      ),
      calculatedTwoBusinessDaySpendCents: optionalNumber(
        form,
        "calculatedTwoBusinessDaySpendCents",
      ),
      externalEvidenceReference: emptyToUndefined(
        form.get("externalEvidenceReference"),
      ),
      reloadAmountCents: optionalNumber(form, "reloadAmountCents"),
      reloadThresholdCents: optionalNumber(form, "reloadThresholdCents"),
    };
  if (kind === "balance_check")
    return {
      ...common,
      balanceCents: optionalNumber(form, "balanceCents"),
      externalEvidenceReference: emptyToUndefined(
        form.get("externalEvidenceReference"),
      ),
      forecastReviewId: emptyToUndefined(form.get("forecastReviewId")),
      observedAt: localDateToIso(form.get("observedAt")),
      validUntil: localDateToIso(form.get("validUntil")),
    };
  if (kind === "reload")
    return {
      ...common,
      reloadAmountCents: optionalNumber(form, "reloadAmountCents"),
      reloadThresholdCents: optionalNumber(form, "reloadThresholdCents"),
      successful: checked(form, "successful"),
    };
  if (kind === "emergency_top_up")
    return {
      ...common,
      topUpAmountCents: optionalNumber(form, "topUpAmountCents"),
    };
  throw new Error("Funding control kind is invalid");
}

function Panel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="border-t border-lh-line pt-8">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function TextField({
  defaultValue,
  label,
  name,
  readOnly,
  required,
  type = "text",
}: {
  defaultValue?: string;
  label: string;
  name: string;
  readOnly?: boolean;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="text-sm font-semibold">
      {label}
      <input
        className={inputClass}
        defaultValue={defaultValue}
        name={name}
        readOnly={readOnly}
        required={required}
        type={type}
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
        step={1}
        type="number"
      />
    </label>
  );
}

function SelectField({
  defaultValue,
  label,
  name,
  options,
}: {
  defaultValue?: string;
  label: string;
  name: string;
  options: Array<[string, string]>;
}) {
  return (
    <label className="text-sm font-semibold">
      {label}
      <select className={inputClass} defaultValue={defaultValue} name={name}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Checkbox({
  defaultChecked = false,
  label,
  name,
}: {
  defaultChecked?: boolean;
  label: string;
  name: string;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
      <input defaultChecked={defaultChecked} name={name} type="checkbox" />
      {label}
    </label>
  );
}

function ActionButton({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled: boolean;
}) {
  return (
    <button
      className="mt-3 min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:opacity-60"
      disabled={disabled}
      type="submit"
    >
      {children}
    </button>
  );
}

function RecordList({ items }: { items: string[] }) {
  if (!items.length)
    return <p className="mt-4 text-sm text-lh-muted">No records.</p>;
  return (
    <ul className="mt-4 space-y-2 text-xs text-lh-muted">
      {items.map((item) => (
        <li className="break-all rounded-xl bg-lh-neutral-2 p-3" key={item}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function stepUpHref(scope: StepUpScope): string {
  const query = new URLSearchParams({
    action: scope.action,
    returnTo: "/admin/shipping-readiness",
    target: scope.target,
    targetLabel: "shipping readiness configuration",
  });
  return `/admin/step-up?${query.toString()}`;
}

function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

function number(form: FormData, name: string): number {
  return Number(form.get(name));
}

function optionalNumber(form: FormData, name: string): number | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value ? Number(value) : undefined;
}

function emptyToUndefined(
  value: FormDataEntryValue | null,
): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function localDateToIso(value: FormDataEntryValue | null): string | undefined {
  const text = emptyToUndefined(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("A submitted date is invalid");
  return parsed.toISOString();
}

function toLocalDateTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDate(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-CA")
    : "invalid";
}

const inputClass =
  "mt-2 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2.5 text-sm read-only:bg-lh-neutral-2";
const helpClass = "mt-1 text-sm leading-6 text-lh-muted";
const cardClass = "rounded-xl border border-lh-line p-4";
