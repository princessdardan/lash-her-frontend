import { redirect } from "next/navigation";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ShippingIntakeLocationControls } from "@/components/admin/shipping-intake-location-controls";
import { ShippingReadinessControls } from "@/components/admin/shipping-readiness-controls";
import { ShippingPolicyConfigurationControls } from "@/components/admin/shipping-policy-configuration-controls";
import { StatusPill } from "@/components/admin/status-pill";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  CHITCHATS_REGION_LABELS,
  getChitChatsOperationalIdentity,
  type ChitChatsOperationalIdentity,
} from "@/lib/shipping/config";
import { assertConfiguredOwnerIdentity } from "@/lib/shipping/configured-owner";
import {
  CHITCHATS_INTAKE_ATTESTATION_STATEMENT,
  CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
  CHITCHATS_INTAKE_ATTESTATION_VALIDITY_DAYS,
  getChitChatsIntakeLocationReadinessRecord,
  type ChitChatsIntakeLocationReadinessRecord,
  type ChitChatsIntakeLocationType,
} from "@/lib/shipping/intake-location";
import { loadReadinessAdminState } from "@/lib/shipping/readiness-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ShippingReadinessPageProps {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}

export default async function AdminShippingReadinessPage({
  searchParams,
}: ShippingReadinessPageProps) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("fulfillment:view");
  if (actor.user.role !== "owner") {
    redirect("/admin/not-authorized");
  }
  try {
    await assertConfiguredOwnerIdentity(actor.user.id);
  } catch {
    redirect("/admin/not-authorized");
  }
  const readinessAdminState = serializeReadinessAdminState(
    await loadReadinessAdminState(),
  );

  let identity: ChitChatsOperationalIdentity;
  try {
    identity = getChitChatsOperationalIdentity();
  } catch (error) {
    return (
      <PageFrame>
        <AdminActionFeedback error={feedback.error} notice={feedback.notice} />
        <AdminActionFeedback error={configurationError(error)} />
        <section className={panelClass}>
          <h2 className={sectionHeadingClass}>Configuration required</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-lh-muted">
            Configure a valid Chit Chats environment, client ID, and allowlisted
            region before recording the physical intake location. No readiness
            attestation can be created from browser-supplied provider identity.
          </p>
        </section>
        <ShippingReadinessControls state={readinessAdminState} />
        <ShippingPolicyConfigurationControls
          actorAdminUserId={actor.user.id}
          state={readinessAdminState}
        />
      </PageFrame>
    );
  }

  const current = await getChitChatsIntakeLocationReadinessRecord(identity);
  const locationStatus = getLocationStatus(current, identity, new Date());
  return (
    <PageFrame>
      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <section className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className={sectionHeadingClass}>Provider configuration</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-lh-muted">
              These values are read from the server environment. They are not
              accepted from this form and are snapshotted by the attestation
              service.
            </p>
          </div>
          <StatusPill tone={locationStatus.tone}>
            {locationStatus.label}
          </StatusPill>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <ReadOnlyField
            label="Chit Chats environment"
            value={formatEnvironment(identity.environment)}
          />
          <ReadOnlyField
            label="Chit Chats client ID"
            value={identity.clientId}
          />
          <ReadOnlyField
            label="Chit Chats region"
            value={`${CHITCHATS_REGION_LABELS[identity.region]} (${identity.region})`}
          />
        </div>
        <p className="mt-4 rounded-xl bg-lh-neutral-2 p-4 text-xs leading-5 text-lh-muted">
          No Chit Chats branch identifier is collected or sent. A provider
          branch-ID field must not be restored unless Chit Chats support
          supplies documentation identifying the ID and the API operation that
          consumes it.
        </p>
      </section>

      <CurrentAttestation
        identity={identity}
        record={current}
        status={locationStatus}
      />

      <ShippingIntakeLocationControls
        current={
          current
            ? {
                evidenceReference: current.evidenceReference,
                id: current.id,
                locationAddress: current.locationAddress,
                locationName: current.locationName,
                locationType: current.locationType,
                policyVersion: current.policyVersion,
              }
            : null
        }
        statement={CHITCHATS_INTAKE_ATTESTATION_STATEMENT}
        statementVersion={CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION}
      />
      <ShippingReadinessControls state={readinessAdminState} />
      <ShippingPolicyConfigurationControls
        actorAdminUserId={actor.user.id}
        state={readinessAdminState}
      />
    </PageFrame>
  );
}

function serializeReadinessAdminState(
  state: Awaited<ReturnType<typeof loadReadinessAdminState>>,
) {
  return {
    calendarExceptions: state.calendarExceptions.map((exception) => ({
      ...exception,
      updatedAt: exception.updatedAt.toISOString(),
    })),
    calendarVersions: state.calendarVersions.map((version) => ({
      ...version,
      createdAt: version.createdAt.toISOString(),
      effectiveAt: version.effectiveAt?.toISOString() ?? null,
    })),
    fulfillmentPolicies: state.fulfillmentPolicies.map((policy) => ({
      ...policy,
      createdAt: policy.createdAt.toISOString(),
      effectiveAt: policy.effectiveAt?.toISOString() ?? null,
    })),
    fundingReviews: state.fundingReviews.map((review) => ({
      ...review,
      createdAt: review.createdAt.toISOString(),
      observedAt: review.observedAt?.toISOString() ?? null,
      validUntil: review.validUntil?.toISOString() ?? null,
    })),
    helcimContract: state.helcimContract,
    packageProfiles: state.packageProfiles.map((profile) => ({
      ...profile,
      reviewedAt: profile.reviewedAt?.toISOString() ?? null,
      updatedAt: profile.updatedAt.toISOString(),
    })),
    taxPolicies: state.taxPolicies.map((policy) => ({
      ...policy,
      approvedAt: policy.approvedAt?.toISOString() ?? null,
      createdAt: policy.createdAt.toISOString(),
      effectiveAt: policy.effectiveAt?.toISOString() ?? null,
    })),
    manualPolicies: state.manualPolicies.map((policy) => ({
      ...policy,
      approvedAt: policy.approvedAt?.toISOString() ?? null,
      createdAt: policy.createdAt.toISOString(),
      effectiveAt: policy.effectiveAt?.toISOString() ?? null,
    })),
    policyAssignments: state.policyAssignments,
    policySettings: state.policySettings
      ? {
          ...state.policySettings,
          pilotStartedAt:
            state.policySettings.pilotStartedAt?.toISOString() ?? null,
          updatedAt: state.policySettings.updatedAt.toISOString(),
        }
      : null,
    providerCertifications: state.providerCertifications.map(
      (certification) => ({
        ...certification,
        certifiedAt: certification.certifiedAt.toISOString(),
        revokedAt: certification.revokedAt?.toISOString() ?? null,
        validUntil: certification.validUntil.toISOString(),
      }),
    ),
    servicePolicies: state.servicePolicies.map((policy) => ({
      ...policy,
      reviewedAt: policy.reviewedAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    })),
  };
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Settings
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Shipping readiness
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Bind Chit Chats operations to an owner-verified physical intake
          location before product checkout can be admitted.
        </p>
      </header>
      {children}
    </div>
  );
}

function CurrentAttestation({
  identity,
  record,
  status,
}: {
  identity: ChitChatsOperationalIdentity;
  record: ChitChatsIntakeLocationReadinessRecord | null;
  status: LocationStatus;
}) {
  if (!record) {
    return (
      <section className={panelClass}>
        <h2 className={sectionHeadingClass}>Current attestation</h2>
        <p className="mt-3 text-sm text-lh-muted">
          No active intake-location attestation exists for the configured Chit
          Chats environment.
        </p>
      </section>
    );
  }

  const mismatchReasons = getMismatchReasons(record, identity, new Date());
  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className={sectionHeadingClass}>Current attestation</h2>
          <p className="mt-2 text-xs text-lh-muted">
            <span className="font-semibold">Attestation ID:</span>{" "}
            <code className="font-mono">{record.id}</code>
          </p>
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      <dl className="mt-5 grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-3">
        <Definition
          label="Location type"
          value={locationTypeLabel(record.locationType)}
        />
        <Definition label="Location name" value={record.locationName} />
        <Definition label="Physical address" value={record.locationAddress} />
        <Definition
          label="Evidence reference"
          value={record.evidenceReference}
        />
        <Definition
          label="Attested by"
          value={`${record.attestedByOwnerName} on ${formatDateTime(record.attestedAt)}`}
        />
        <Definition
          label="Valid until"
          value={formatDateTime(record.validUntil)}
        />
        <Definition label="Policy version" value={record.policyVersion} />
        <Definition label="Statement version" value={record.statementVersion} />
      </dl>
      {mismatchReasons.length > 0 ? (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-semibold">
            A replacement attestation is required:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {mismatchReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-5 text-xs leading-5 text-lh-muted">
          This status covers the intake-location record only. The checkout
          readiness service independently verifies the owner assignment,
          effective policy, provider certification, tax policy, and other launch
          controls.
        </p>
      )}
    </section>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="block text-sm font-medium">
      <span className={fieldLabelClass}>{label}</span>
      <input className={readOnlyInputClass} readOnly value={value} />
    </label>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-lh-neutral-2 p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </dt>
      <dd className="mt-2 break-words leading-6">{value}</dd>
    </div>
  );
}

interface LocationStatus {
  label: string;
  tone: "attention" | "neutral" | "success";
}

function getLocationStatus(
  record: ChitChatsIntakeLocationReadinessRecord | null,
  identity: ChitChatsOperationalIdentity,
  now: Date,
): LocationStatus {
  if (!record) return { label: "Not attested", tone: "neutral" };
  return getMismatchReasons(record, identity, now).length === 0
    ? { label: "Location current", tone: "success" }
    : { label: "Replacement required", tone: "attention" };
}

function getMismatchReasons(
  record: ChitChatsIntakeLocationReadinessRecord,
  identity: ChitChatsOperationalIdentity,
  now: Date,
): string[] {
  const reasons: string[] = [];
  if (record.validUntil <= now) {
    reasons.push(
      `The ${CHITCHATS_INTAKE_ATTESTATION_VALIDITY_DAYS}-day validity period expired.`,
    );
  }
  if (record.providerEnvironment !== identity.environment) {
    reasons.push("The provider environment changed.");
  }
  if (record.providerClientId !== identity.clientId) {
    reasons.push("The configured Chit Chats client changed.");
  }
  if (record.region !== identity.region) {
    reasons.push("The configured Chit Chats region changed.");
  }
  if (
    record.statementVersion !== CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION
  ) {
    reasons.push("The required attestation statement changed.");
  }
  return reasons;
}

function locationTypeLabel(value: ChitChatsIntakeLocationType): string {
  if (value === "drop_spot") return "Chit Chats drop spot";
  if (value === "mail_in_hub") return "Mail-in hub";
  return "Chit Chats branch";
}

function formatEnvironment(value: ChitChatsOperationalIdentity["environment"]) {
  return value === "production" ? "Production" : "Staging";
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(value);
}

function configurationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 280);
  }
  return "The server-side Chit Chats identity is not configured.";
}

const panelClass = "rounded-3xl border border-lh-line bg-white p-6 shadow-sm";
const sectionHeadingClass =
  "font-heading text-3xl uppercase tracking-[0.08em] sm:text-4xl";
const fieldLabelClass =
  "mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted";
const readOnlyInputClass =
  "w-full rounded-xl border border-lh-line bg-lh-neutral-2 px-3 py-2.5 text-sm text-lh-muted";
