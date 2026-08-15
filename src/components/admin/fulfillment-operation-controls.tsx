"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { AdminFulfillmentOperationRow } from "@/lib/admin/operations-workspaces";

type ActionKind =
  | "risk"
  | "address"
  | "case"
  | "funding"
  | "manual"
  | "notification"
  | "payment-initialization-reconciliation"
  | "provider-job-review"
  | "shipment-review"
  | "decision-review"
  | "refund-review"
  | "return-review";

export function FulfillmentOperationControls({
  item,
}: {
  item: AdminFulfillmentOperationRow;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stepUpScope, setStepUpScope] = useState<{
    action: string;
    target: string;
    targetLabel?: string;
  } | null>(null);
  const actionKind = getFulfillmentOperationActionKind(item);

  if (!actionKind) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setStepUpScope(null);
    const form = new FormData(event.currentTarget);
    const request = buildFulfillmentOperationRequest(actionKind!, item, form);

    try {
      const response = await fetch(request.url, {
        body: JSON.stringify(request.body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        stepUp?: { action: string; target: string; targetLabel?: string };
      } | null;
      if (!response.ok) {
        const error = result?.error ?? `Action failed (${response.status})`;
        setMessage(
          response.status === 409
            ? `${error}. Refresh the queue before retrying if the item changed.`
            : error,
        );
        setStepUpScope(
          response.status === 409 && /step-up|authentication/i.test(error)
            ? (result?.stepUp ?? request.stepUpScope ?? null)
            : null,
        );
        return;
      }

      setMessage("Action recorded. Refreshing the queue state.");
      router.refresh();
    } catch {
      setMessage("The action could not be submitted. No success was assumed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full">
      <button
        className="min-h-11 rounded-full border border-lh-line px-4 text-sm font-semibold text-lh-primary disabled:opacity-60"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? "Close action" : actionLabel(actionKind)}
      </button>
      {open ? (
        <form
          className="mt-3 space-y-3 rounded-xl bg-lh-neutral-2 p-4"
          onSubmit={submit}
        >
          <input
            name="conflictToken"
            type="hidden"
            value={item.conflictToken}
          />
          <input name="stateVersion" type="hidden" value={item.stateVersion} />
          {actionKind === "risk" ? <RiskFields /> : null}
          {actionKind === "address" ? <AddressFields /> : null}
          {actionKind === "case" ? <CaseFields /> : null}
          {actionKind === "funding" ? <FundingFields /> : null}
          {actionKind === "manual" ? <ManualFields mode={item.kind} /> : null}
          {actionKind === "notification" ? (
            <p className="text-xs text-lh-muted">
              Requeue is available only for dead-letter messages after the
              delivery cause has been reviewed. The attempt history is kept.
            </p>
          ) : null}
          {actionKind === "payment-initialization-reconciliation" ? (
            <PaymentInitializationReconciliationFields />
          ) : null}
          {isOperationReview(actionKind) ? (
            <OperationReviewFields kind={actionKind} />
          ) : null}
          <p className="text-xs text-lh-muted">
            Submitting against version {item.stateVersion}. A conflict response
            requires a queue refresh and a new review of the evidence.
          </p>
          <button
            className="min-h-11 rounded-full bg-lh-primary px-5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
            disabled={pending}
            type="submit"
          >
            {pending ? "Submitting…" : "Submit reviewed action"}
          </button>
          {message ? (
            <p
              aria-live="polite"
              className="text-sm text-lh-muted"
              role="status"
            >
              {message}
            </p>
          ) : null}
          {stepUpScope ? (
            <Link
              className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline underline-offset-4"
              href={`/admin/step-up?returnTo=${encodeURIComponent("/admin/operations")}&action=${encodeURIComponent(stepUpScope.action)}&target=${encodeURIComponent(stepUpScope.target)}&targetLabel=${encodeURIComponent(stepUpScope.targetLabel ?? item.title)}`}
            >
              Reauthenticate for this action
            </Link>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function RiskFields() {
  return (
    <>
      <label className="block text-sm font-semibold">
        Decision
        <select className={fieldClass} defaultValue="escalate" name="decision">
          <option value="escalate">Escalate</option>
          <option value="clear_false_positive">Clear false positive</option>
        </select>
      </label>
      <RationaleField />
      <p className="text-xs text-lh-muted">
        Clearing requires fresh step-up authentication and server-retrieved
        Helcim evidence. The browser cannot attest provider evidence.
      </p>
    </>
  );
}

function AddressFields() {
  return (
    <>
      <label className="block text-sm font-semibold">
        Approval duty
        <select
          className={fieldClass}
          defaultValue="address_approval"
          name="action"
        >
          <option value="address_approval">Address approval</option>
          <option value="fraud_clearance">Fraud clearance</option>
          <option value="record_phone_callback">
            Record original-order phone callback
          </option>
          <option value="apply">Apply or reconcile approved change</option>
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Cost responsibility
        <select
          className={fieldClass}
          defaultValue="customer"
          name="responsibility"
        >
          <option value="customer">Customer</option>
          <option value="lash_her">Lash Her</option>
        </select>
      </label>
      <RationaleField />
      <label className="block text-sm font-semibold">
        Original-order phone callback evidence reference
        <input
          className={fieldClass}
          minLength={6}
          name="callbackEvidenceReference"
        />
      </label>
    </>
  );
}

function CaseFields() {
  return (
    <>
      <label className="block text-sm font-semibold">
        Case action
        <select className={fieldClass} defaultValue="acknowledge" name="action">
          <option value="acknowledge">Acknowledge</option>
          <option value="inspect">Record inspection</option>
          <option value="claim">Submit claim reference</option>
          <option value="resolve">Resolve</option>
        </select>
      </label>
      <p className="text-muted-foreground text-xs">
        Loss and damage cases can resolve only after replacement carrier handoff
        or complete typed refunds. Evidenced manual-review allocations make the
        order terminal for operations without claiming provider settlement.
      </p>
      <label className="block text-sm font-semibold">
        Provider claim reference
        <input className={fieldClass} name="providerClaimReference" />
      </label>
      <label className="block text-sm font-semibold">
        Cause or remedy
        <textarea className={fieldClass} name="cause" rows={2} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Claim evidence</legend>
        {[
          ["purchaseReceipt", "Purchase receipt"],
          ["postageLabel", "Postage label"],
          ["trackingHistory", "Tracking history"],
          ["itemValue", "Item value evidence"],
        ].map(([name, label]) => (
          <label
            className="flex min-h-11 items-center gap-2 text-sm"
            key={name}
          >
            <input name={name} type="checkbox" />
            {label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function FundingFields() {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
      <input name="markApplied" type="checkbox" />
      Mark the approved funding change applied
    </label>
  );
}

function ManualFields({ mode }: { mode: string }) {
  return (
    <>
      <label className="block text-sm font-semibold">
        Reviewed action
        <select
          className={fieldClass}
          defaultValue="approve_cancellation"
          name="action"
        >
          <option value="approve_cancellation">
            Approve/default cancellation
          </option>
          <option value="deny_cancellation">
            Deny cancellation for irreversible work
          </option>
          {mode === "manual_pickup" ? (
            <>
              <option value="manual_shipping_agreement">
                Record shipping agreement
              </option>
              <option value="pickup_complete">Complete pickup handoff</option>
            </>
          ) : (
            <>
              <option value="manual_shipping_agreement">
                Record shipping agreement
              </option>
              <option value="manual_shipping_dispatch">
                Record carrier dispatch
              </option>
            </>
          )}
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Cancellation basis
        <select
          className={fieldClass}
          defaultValue="customer_approved"
          name="cancellationBasis"
        >
          <option value="customer_approved">Customer approved</option>
          <option value="policy_default">Policy default</option>
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Irreversible work type (when denying cancellation)
        <select
          className={fieldClass}
          defaultValue=""
          name="irreversibleWorkType"
        >
          <option value="">Select documented work</option>
          <option value="customization">Customization</option>
          <option value="product_preparation">Product preparation</option>
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Irreversible work start time (when denying cancellation)
        <input
          className={fieldClass}
          name="irreversibleWorkStartedAt"
          type="datetime-local"
        />
      </label>
      <label className="block text-sm font-semibold">
        Affected amount in cents (when denying cancellation)
        <input
          className={fieldClass}
          min={1}
          name="affectedAmountCents"
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Evidence reference
        <input
          className={fieldClass}
          minLength={3}
          name="evidenceReference"
          required
        />
      </label>
      <label className="block text-sm font-semibold">
        Agreed shipping amount in cents
        <input
          className={fieldClass}
          min={1}
          name="shippingAmountCents"
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Carrier (manual dispatch)
        <input className={fieldClass} name="carrier" />
      </label>
      <label className="block text-sm font-semibold">
        Tracking number (manual dispatch)
        <input className={fieldClass} name="trackingNumber" />
      </label>
      <RationaleField />
      <p className="text-xs text-lh-muted">
        Completion, dispatch, and cancellation require fresh step-up. A paid
        cancellation is locked before refund allocations are queued; queue
        failures remain visible for manual follow-up.
      </p>
    </>
  );
}

function RationaleField() {
  return (
    <label className="block text-sm font-semibold">
      Rationale
      <textarea
        className={fieldClass}
        minLength={10}
        name="rationale"
        required
        rows={3}
      />
    </label>
  );
}

function OperationReviewFields({ kind }: { kind: ActionKind }) {
  return (
    <>
      {kind === "return-review" ? (
        <label className="block text-sm font-semibold">
          Return resolution
          <select
            className={fieldClass}
            defaultValue="record_inspection"
            name="action"
          >
            <option value="record_inspection">Record local inspection</option>
            <option value="escalate_unmatched_return">
              Escalate unmatched return
            </option>
            <option value="confirm_linked_case">
              Confirm linked case follow-up
            </option>
          </select>
        </label>
      ) : null}
      <label className="block text-sm font-semibold">
        Evidence reference
        <input
          className={fieldClass}
          minLength={6}
          name="evidenceReference"
          required
        />
      </label>
      <RationaleField />
      <p className="text-xs text-lh-muted">
        Reauthentication is bound to this exact action, version, evidence
        reference, and rationale. Changing any value requires a new proof.
      </p>
    </>
  );
}

function PaymentInitializationReconciliationFields() {
  return (
    <>
      <label className="block text-sm font-semibold">
        Reconciliation action
        <select
          className={fieldClass}
          defaultValue="adopt_invoice"
          name="action"
        >
          <option value="adopt_invoice">Adopt authoritative invoice</option>
          <option value="confirm_no_payable_state_and_reissue">
            Confirm authoritative absence and reissue
          </option>
          <option value="record_manual_handoff">Record manual handoff</option>
        </select>
      </label>
      <label className="block text-sm font-semibold">
        Provider invoice ID
        <input
          className={fieldClass}
          min={1}
          name="providerInvoiceId"
          step={1}
          type="number"
        />
      </label>
      <label className="block text-sm font-semibold">
        Provider invoice number (optional cross-check)
        <input className={fieldClass} name="providerInvoiceNumber" />
      </label>
      <label className="block text-sm font-semibold">
        Provider evidence reference
        <input
          className={fieldClass}
          minLength={6}
          name="evidenceReference"
          required
        />
      </label>
      <RationaleField />
      <p className="text-xs text-lh-muted">
        Adoption performs a live Helcim invoice lookup and verifies the exact
        amount, CAD currency, status, merchant reference, and line items.
        Reissue is permitted only when an exact deterministic invoice-number
        search returns no invoice. An ambiguous HelcimPay session requires
        manual handoff. The server binds the provider evidence hash and current
        state version to a one-use step-up proof.
      </p>
    </>
  );
}

export function getFulfillmentOperationActionKind(
  item: AdminFulfillmentOperationRow,
): ActionKind | null {
  if (item.kind.startsWith("quarantine-")) return null;
  if (item.kind === "return-observation") return "return-review";
  if (item.kind === "provider-job-dead-letter") return "provider-job-review";
  if (item.kind === "shipment-manual-review") return "shipment-review";
  if (item.kind === "customer-decision-follow-up") return "decision-review";
  if (item.kind === "refund-manual-review") return "refund-review";
  if (
    item.kind === "helcim-initialization-outcome_unknown" ||
    item.kind === "helcim-initialization-manual_review"
  )
    return "payment-initialization-reconciliation";
  if (item.queue === "risk" && item.orderReference) return "risk";
  if (item.queue === "addresses-and-supplements") return "address";
  if (item.queue === "cases-claims-replacements-returns") return "case";
  if (item.queue === "funding") return "funding";
  if (item.queue === "manual-fulfillment" && item.orderReference)
    return "manual";
  if (item.queue === "notifications" && item.kind === "dead_letter")
    return "notification";
  return null;
}

function actionLabel(kind: ActionKind): string {
  if (kind === "risk") return "Review risk";
  if (kind === "address") return "Review address";
  if (kind === "case") return "Update case";
  if (kind === "manual") return "Record manual action";
  if (kind === "notification") return "Requeue notification";
  if (kind === "provider-job-review") return "Request reconciliation";
  if (kind === "shipment-review") return "Acknowledge review";
  if (kind === "decision-review") return "Record legal follow-up";
  if (kind === "refund-review") return "Record manual handoff";
  if (kind === "return-review") return "Resolve return observation";
  if (kind === "payment-initialization-reconciliation")
    return "Reconcile payment initialization";
  return "Approve funding";
}

export function buildFulfillmentOperationRequest(
  kind: ActionKind,
  item: AdminFulfillmentOperationRow,
  form: FormData,
): {
  body: Record<string, unknown>;
  stepUpScope?: { action: string; target: string };
  url: string;
} {
  if (kind === "risk") {
    const decision = form.get("decision");
    return {
      body: {
        decision,
        incidentId: item.id,
        rationale: form.get("rationale"),
        stateVersion: item.stateVersion,
      },
      stepUpScope:
        decision === "clear_false_positive"
          ? { action: "risk:clear_false_positive", target: item.id }
          : undefined,
      url: `/api/admin/orders/${encodeURIComponent(item.orderReference!)}/risk-review`,
    };
  }
  if (kind === "address") {
    const action = String(form.get("action") ?? "");
    if (action === "apply") {
      const target = JSON.stringify({
        requestId: item.id,
        expectedStateVersion: item.stateVersion,
      });
      return {
        body: { expectedStateVersion: item.stateVersion },
        stepUpScope: {
          action: "fulfillment.address_change_apply",
          target,
        },
        url: `/api/admin/address-changes/${encodeURIComponent(item.id)}/apply`,
      };
    }
    return {
      body: {
        action,
        callbackEvidenceReference: form.get("callbackEvidenceReference"),
        expectedStateVersion: item.stateVersion,
        rationale: form.get("rationale"),
        responsibility: form.get("responsibility"),
      },
      url: `/api/admin/address-changes/${encodeURIComponent(item.id)}/approve`,
    };
  }
  if (kind === "case") {
    return {
      body: {
        action: form.get("action"),
        cause: form.get("cause"),
        evidenceChecklist: {
          item_value: form.get("itemValue") === "on",
          postage_label: form.get("postageLabel") === "on",
          purchase_receipt: form.get("purchaseReceipt") === "on",
          tracking_history: form.get("trackingHistory") === "on",
        },
        expectedStateVersion: item.stateVersion,
        providerClaimReference: form.get("providerClaimReference"),
      },
      url: `/api/admin/shipping-cases/${encodeURIComponent(item.id)}/action`,
    };
  }
  if (kind === "manual") {
    const action = String(form.get("action") ?? "");
    const irreversibleWorkStartedAt = String(
      form.get("irreversibleWorkStartedAt") ?? "",
    );
    const irreversibleWorkStartedAtDate = new Date(irreversibleWorkStartedAt);
    return {
      body: {
        action,
        affectedAmountCents: Number(form.get("affectedAmountCents")),
        cancellationBasis: form.get("cancellationBasis"),
        carrier: form.get("carrier"),
        evidence: {
          evidenceReference: form.get("evidenceReference"),
        },
        expectedConflictToken: item.conflictToken,
        irreversibleWorkStartedAt: Number.isNaN(
          irreversibleWorkStartedAtDate.getTime(),
        )
          ? irreversibleWorkStartedAt
          : irreversibleWorkStartedAtDate.toISOString(),
        irreversibleWorkType: form.get("irreversibleWorkType"),
        rationale: form.get("rationale"),
        shippingAmountCents: Number(form.get("shippingAmountCents")),
        trackingNumber: form.get("trackingNumber"),
      },
      stepUpScope: { action: `manual:${action}`, target: item.id },
      url: `/api/admin/orders/${encodeURIComponent(item.orderReference!)}/manual-fulfillment`,
    };
  }
  if (kind === "notification") {
    return {
      body: { expectedConflictToken: item.conflictToken },
      url: `/api/admin/customer-email-outbox/${encodeURIComponent(item.id)}/requeue`,
    };
  }
  if (kind === "payment-initialization-reconciliation") {
    const action = String(form.get("action") ?? "");
    const invoiceIdValue = String(form.get("providerInvoiceId") ?? "").trim();
    const providerInvoiceId = invoiceIdValue
      ? Number(invoiceIdValue)
      : undefined;
    const providerInvoiceNumber = String(
      form.get("providerInvoiceNumber") ?? "",
    ).trim();
    return {
      body: {
        action,
        evidenceReference: form.get("evidenceReference"),
        expectedStateVersion: item.stateVersion,
        rationale: form.get("rationale"),
        ...(providerInvoiceId !== undefined ? { providerInvoiceId } : {}),
        ...(providerInvoiceNumber ? { providerInvoiceNumber } : {}),
      },
      url: `/api/admin/orders/${encodeURIComponent(item.orderReference!)}/payment-obligations/${encodeURIComponent(item.id)}/reconcile`,
    };
  }
  if (isOperationReview(kind)) {
    const operation = operationReviewRequest(kind, item, form);
    return {
      body: {
        action: operation.action,
        evidenceReference: form.get("evidenceReference"),
        expectedStateVersion: item.stateVersion,
        rationale: form.get("rationale"),
      },
      url: operation.url,
    };
  }
  return {
    body: { markApplied: form.get("markApplied") === "on" },
    url: `/api/admin/shipping/funding-reviews/${encodeURIComponent(item.id)}/approve`,
  };
}

function isOperationReview(kind: ActionKind): boolean {
  return kind.endsWith("-review");
}

function operationReviewRequest(
  kind: ActionKind,
  item: AdminFulfillmentOperationRow,
  form: FormData,
): { action: string; url: string } {
  if (kind === "return-review") {
    return {
      action: String(form.get("action") ?? ""),
      url: `/api/admin/shipping/return-observations/${encodeURIComponent(item.id)}/resolve`,
    };
  }
  const mapping = {
    "provider-job-review": ["provider_job", "request_reconciliation"],
    "shipment-review": ["shipment_generation", "acknowledge_manual_review"],
    "decision-review": ["customer_decision", "record_legal_follow_up"],
    "refund-review": ["refund", "record_external_manual_handoff"],
  } as const;
  const selected = mapping[kind as keyof typeof mapping];
  if (!selected) throw new Error("Operation review action is invalid");
  return {
    action: selected[1],
    url: `/api/admin/shipping/operation-reviews/${selected[0]}/${encodeURIComponent(item.id)}`,
  };
}

const fieldClass =
  "mt-1 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 font-normal";
