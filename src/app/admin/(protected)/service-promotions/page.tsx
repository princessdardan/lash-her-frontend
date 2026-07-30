import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { listAdminServicePromotions } from "@/lib/admin/service-promotions";

import {
  createServicePromotionAction,
  setServicePromotionStatusAction,
  updateServicePromotionAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminServicePromotionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  await requireAdminPagePermission("service-promotions:view");
  const data = await listAdminServicePromotions();

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Provider-specific discounts
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
          Service promotions
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Promotion eligibility is assigned to exact provider offerings. Codes
          never carry across providers unless each offering is explicitly
          selected.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <form action={createServicePromotionAction} className={panelClass}>
        <h2 className={headingClass}>Create promotion code</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Internal title">
            <input className={inputClass} name="internalTitle" required />
          </Field>
          <Field label="Customer code">
            <input
              autoCapitalize="characters"
              className={inputClass}
              maxLength={32}
              name="code"
              pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}"
              placeholder="LASH10"
              required
            />
          </Field>
          <Field label="Discount type">
            <select className={inputClass} name="discountType">
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed CAD amount</option>
            </select>
          </Field>
          <Field label="Discount amount">
            <input
              className={inputClass}
              inputMode="decimal"
              name="discountAmount"
              pattern="\d+(?:\.\d{1,2})?"
              placeholder="10"
              required
            />
          </Field>
          <Field label="Starts at (UTC, optional)">
            <input
              className={inputClass}
              name="effectiveFrom"
              type="datetime-local"
            />
          </Field>
          <Field label="Ends at (UTC, optional)">
            <input
              className={inputClass}
              name="effectiveUntil"
              type="datetime-local"
            />
          </Field>
        </div>
        <OfferingChecklist offerings={data.offerings} />
        <button className={primaryButtonClass} type="submit">
          Create as draft
        </button>
      </form>

      <section className="space-y-5">
        <h2 className={sectionHeadingClass}>Configured codes</h2>
        {data.promotions.length === 0 ? (
          <div className={panelClass}>
            <p className="text-sm text-lh-muted">
              No service promotion codes have been configured.
            </p>
          </div>
        ) : (
          data.promotions.map((promotion) => {
            const archived = promotion.status === "archived";
            return (
              <article className={panelClass} key={promotion.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="font-heading text-3xl uppercase tracking-[0.08em]">
                      {promotion.code}
                    </h3>
                    <p className="mt-1 text-sm text-lh-muted">
                      {promotion.internalTitle}
                    </p>
                  </div>
                  <StatusPill tone={statusTone(promotion.status)}>
                    {promotion.status}
                  </StatusPill>
                </div>

                <form action={updateServicePromotionAction} className="mt-5">
                  <input
                    name="promotionId"
                    type="hidden"
                    value={promotion.id}
                  />
                  <fieldset disabled={archived}>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <Field label="Internal title">
                        <input
                          className={inputClass}
                          defaultValue={promotion.internalTitle}
                          name="internalTitle"
                          required
                        />
                      </Field>
                      <Field label="Customer code">
                        <input
                          autoCapitalize="characters"
                          className={inputClass}
                          defaultValue={promotion.code}
                          maxLength={32}
                          name="code"
                          pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,31}"
                          required
                        />
                      </Field>
                      <Field label="Discount type">
                        <select
                          className={inputClass}
                          defaultValue={promotion.discountType}
                          name="discountType"
                        >
                          <option value="percentage">Percentage</option>
                          <option value="fixed">Fixed CAD amount</option>
                        </select>
                      </Field>
                      <Field label="Discount amount">
                        <input
                          className={inputClass}
                          defaultValue={formatDiscountValue(
                            promotion.discountValue,
                          )}
                          inputMode="decimal"
                          name="discountAmount"
                          pattern="\d+(?:\.\d{1,2})?"
                          required
                        />
                      </Field>
                      <Field label="Starts at (UTC, optional)">
                        <input
                          className={inputClass}
                          defaultValue={formatUtcInput(promotion.effectiveFrom)}
                          name="effectiveFrom"
                          type="datetime-local"
                        />
                      </Field>
                      <Field label="Ends at (UTC, optional)">
                        <input
                          className={inputClass}
                          defaultValue={formatUtcInput(
                            promotion.effectiveUntil,
                          )}
                          name="effectiveUntil"
                          type="datetime-local"
                        />
                      </Field>
                    </div>
                    <OfferingChecklist
                      offerings={data.offerings}
                      selectedOfferingIds={promotion.offeringIds}
                    />
                    {!archived ? (
                      <button className={secondaryButtonClass} type="submit">
                        Save changes
                      </button>
                    ) : null}
                  </fieldset>
                </form>

                {!archived ? (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-lh-line pt-4">
                    {(["draft", "active", "disabled"] as const).map(
                      (status) => (
                        <form
                          action={setServicePromotionStatusAction}
                          key={status}
                        >
                          <input
                            name="promotionId"
                            type="hidden"
                            value={promotion.id}
                          />
                          <input name="status" type="hidden" value={status} />
                          <button
                            className={statusButtonClass}
                            disabled={promotion.status === status}
                            type="submit"
                          >
                            Set {status}
                          </button>
                        </form>
                      ),
                    )}
                    <form action={setServicePromotionStatusAction}>
                      <input
                        name="promotionId"
                        type="hidden"
                        value={promotion.id}
                      />
                      <input name="status" type="hidden" value="archived" />
                      <ConfirmSubmitButton
                        className={dangerButtonClass}
                        confirmation={`Archive promotion code ${promotion.code}? It cannot be restored.`}
                      >
                        Archive
                      </ConfirmSubmitButton>
                    </form>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}

function OfferingChecklist({
  offerings,
  selectedOfferingIds = [],
}: {
  offerings: Awaited<
    ReturnType<typeof listAdminServicePromotions>
  >["offerings"];
  selectedOfferingIds?: string[];
}) {
  const selected = new Set(selectedOfferingIds);

  return (
    <fieldset className="mt-5">
      <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
        Eligible provider offerings
      </legend>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {offerings.map((offering) => (
          <label
            className="flex items-start gap-3 rounded-xl border border-lh-line bg-white p-3 text-sm"
            key={offering.id}
          >
            <input
              className="mt-1"
              defaultChecked={selected.has(offering.id)}
              name="offeringId"
              type="checkbox"
              value={offering.id}
            />
            <span>
              <span className="block font-semibold">
                {offering.publicTitle ?? offering.serviceTitle}
              </span>
              <span className="block text-xs text-lh-muted">
                {offering.providerName} · {offering.offeringKey} ·{" "}
                {offering.status}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="block text-sm font-medium">
      <span className="mb-2 block text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatUtcInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 16) : "";
}

function formatDiscountValue(value: number): string {
  return (value / 100).toFixed(2).replace(/\.?0+$/, "");
}

function statusTone(status: string): "attention" | "neutral" | "success" {
  if (status === "active") return "success";
  if (status === "disabled") return "attention";
  return "neutral";
}

const panelClass = "rounded-3xl border border-lh-line bg-white p-6 shadow-sm";
const headingClass = "font-heading text-3xl uppercase tracking-[0.08em]";
const sectionHeadingClass = "font-heading text-4xl uppercase tracking-[0.08em]";
const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2.5 text-sm";
const primaryButtonClass =
  "mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold text-white";
const secondaryButtonClass =
  "mt-5 rounded-full border border-lh-primary px-5 py-2.5 text-sm font-semibold text-lh-primary";
const statusButtonClass =
  "rounded-full border border-lh-line px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] disabled:cursor-not-allowed disabled:opacity-40";
const dangerButtonClass =
  "rounded-full border border-red-300 px-4 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-red-800";
