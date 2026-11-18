import "server-only";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { decryptCustomerEmailOutboxValue } from "@/lib/commerce/customer-email-outbox-cipher";
import type { ContactPopupOfferEmailPayload } from "@/lib/commerce/customer-email-outbox";
import { sanitizeAttribution } from "./attribution";
import { highlevel, type CrmRequest } from "./client";
import {
  crmMarketingEnabled,
  fieldIds,
  locationId,
  workflowId,
} from "./config";
import {
  HighLevelError,
  normalizeEmail,
  normalizePhone,
  validIdentity,
  type Journey,
} from "./contract";
import {
  assertMappedIdentity,
  providerBlocked,
  selectContact,
  type ProviderContact,
} from "./identity";
import {
  enqueueCrmEvent,
  channelConsent,
  getContact,
  hasConversionSince,
  loadSource,
  loadRetainedSource,
  type CrmContact,
  type CrmJob,
  type CrmSource,
} from "./store";

const pathId = (id: string) => encodeURIComponent(id);

export async function syncJob(
  job: CrmJob,
  api: CrmRequest = highlevel,
): Promise<"succeeded" | "skipped"> {
  const source = await loadSource(job);
  if (!source || !validIdentity(source.email))
    return reconcileRemovedSource(job, api);
  return syncSource(job, source, api);
}

async function syncSource(
  job: CrmJob,
  source: CrmSource,
  api: CrmRequest,
  retainedStateOnly = false,
): Promise<"succeeded"> {
  const email = normalizeEmail(source.email);
  const location = locationId();
  // Serialize all effects for an identity. No consent writer takes this lock:
  // withdrawals can commit while a network call is in progress.
  return getPrivateDb()
    .transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`highlevel:${location}:${email}`}, 0))`,
      );
      const local = await getContact(email, location, tx);
      if (local.deleted_at)
        throw new HighLevelError("contact_deleted_review_required");
      const phone = normalizePhone(source.phone) ?? local.phone;
      let remote: ProviderContact;
      const lookup = async (field: "email" | "phone", value: string) => {
        const result = await api<{
          contacts: ProviderContact[];
          nextCursor?: string;
        }>(
          `/contacts/lookup?${new URLSearchParams({ locationId: location, [field]: value, limit: "2" })}`,
        );
        if (!Array.isArray(result.contacts) || result.nextCursor)
          throw new HighLevelError("identity_conflict");
        return result.contacts;
      };
      if (local.provider_id) {
        remote = (
          await api<{ contact: ProviderContact }>(
            `/contacts/${pathId(local.provider_id)}`,
          )
        ).contact;
      } else {
        const emailMatches = await lookup("email", email);
        const phoneMatches = phone ? await lookup("phone", phone) : [];
        const existing = selectContact(email, emailMatches, phoneMatches);
        remote =
          existing ??
          (
            await api<{ contact: ProviderContact }>("/contacts/upsert", {
              method: "POST",
              body: {
                locationId: location,
                email,
                name: source.name,
                source: "Lash Her website",
                customFields: [
                  {
                    id: fieldIds().historical,
                    fieldValue: job.historical ? "yes" : "no",
                  },
                  { id: fieldIds().email_eligible, fieldValue: "no" },
                  { id: fieldIds().sms_eligible, fieldValue: "no" },
                ],
                createNewIfDuplicateAllowed: false,
              },
            })
          ).contact;
        // Some create responses are abbreviated; retrieve the complete, tenant-bound record.
        if (!remote?.id) throw new HighLevelError("invalid_contact_response");
        remote = (
          await api<{ contact: ProviderContact }>(
            `/contacts/${pathId(remote.id)}`,
          )
        ).contact;
        assertMappedIdentity(remote, location, email, phone);
        // Commit the stable provider identity outside the network-effect transaction.
        // The row itself is currently locked, so it is saved by this transaction;
        // a crash is recovered through exact lookup before another create.
        await tx.execute(
          sql`update highlevel_contacts set provider_id = ${remote.id}, phone = ${phone}, updated_at = now() where id = ${local.id}::uuid`,
        );
        local.provider_id = remote.id;
      }
      try {
        assertMappedIdentity(remote, location, email, phone);
        // Consent can create an email-only mapping before its submission arrives.
        // Recheck ownership before adding a phone to that already mapped contact.
        if (phone && !remote.phone)
          selectContact(email, [remote], await lookup("phone", phone));
      } catch (error) {
        // A phone conflict still requires review, but cannot strand an email
        // withdrawal for the unchanged, tenant-bound mapped destination.
        if (
          error instanceof HighLevelError &&
          ["phone_changed_in_crm", "identity_conflict"].includes(error.code) &&
          remote.id === local.provider_id &&
          remote.email &&
          normalizeEmail(remote.email) === email &&
          (await channelConsent(email, "email", email, tx)) === "unsubscribed"
        ) {
          await api(`/contacts/${pathId(remote.id)}`, {
            method: "PUT",
            body: {
              customFields: [
                { id: fieldIds().email_eligible, fieldValue: "no" },
              ],
              ...(!providerBlocked(remote, "email")
                ? {
                    dndSettings: {
                      email: {
                        status: "active",
                        message: "lh:website-withdrawal",
                      },
                    },
                  }
                : {}),
            },
          });
        }
        throw error;
      }
      if (phone && phone !== local.phone) {
        await tx.execute(
          sql`update highlevel_contacts set phone = ${phone} where id = ${local.id}::uuid`,
        );
        local.phone = phone;
      }
      const id = remote.id;
      await tx.execute(
        sql`insert into highlevel_effects (key, contact_id, kind, state) values (${`entity:${job.entity_type}:${job.entity_id}`}, ${local.id}::uuid, 'entity', 'recorded') on conflict do nothing`,
      );

      // Recompute current eligibility, never send the consent snapshot of an old job.
      const [emailConsent, smsConsent] = await Promise.all([
        channelConsent(email, "email", email, tx),
        channelConsent(email, "sms", phone, tx),
      ]);
      const emailEligible =
        emailConsent === "opted_in" &&
        !providerBlocked(remote, "email") &&
        !local.provider_email_blocked;
      const smsEligible =
        smsConsent === "opted_in" &&
        !providerBlocked(remote, "sms") &&
        !local.provider_sms_blocked;
      const latest = await tx.execute<{
        source: string;
        source_path: string;
        attribution: unknown;
        interest: string;
        submitted_at: Date;
      }>(
        sql`select source, source_path, payload->'attribution' as attribution, coalesce(payload->>'programSlug', payload->>'programTitle', payload->>'courseTitle','') as interest, submitted_at from marketing_contact_submissions where email_normalized = ${email} and email <> '[redacted]' order by submitted_at desc limit 1`,
      );
      const recent = latest.rows[0];
      const orders = await tx.execute<{
        purpose: string;
        status: string;
        refunded: boolean;
        amount_cents: number;
        currency: string;
        updated_at: Date;
      }>(
        sql`select purpose, status, amount_cents, currency, updated_at, exists(select 1 from product_order_refunds r where r.order_id = checkout_orders.id and r.status = 'succeeded') as refunded from checkout_orders where lower(trim(customer_email)) = ${email} order by updated_at desc limit 10`,
      );
      const fields = fieldIds();
      const original = (
        await tx.execute<{ source: string; source_path: string }>(
          sql`select source, source_path from marketing_contact_submissions where email_normalized = ${email} and email <> '[redacted]' order by submitted_at limit 1`,
        )
      ).rows[0];
      const latestActivity = Math.max(
        ["submission", "order", "enrollment", "delivery"].includes(
          job.entity_type,
        )
          ? new Date(source.activityAt).getTime()
          : 0,
        recent ? new Date(recent.submitted_at).getTime() : 0,
        ...orders.rows.map((o) => new Date(o.updated_at).getTime()),
      );
      const values: Record<string, string> = {
        website_id: local.id,
        email_eligible: emailEligible ? "yes" : "no",
        sms_eligible: smsEligible ? "yes" : "no",
        source: recent?.source ?? source.source,
        original_source: String(
          (!retainedStateOnly &&
            remote.customFields?.find((f) => f.id === fields.original_source)
              ?.value) ||
            original?.source ||
            source.source,
        ),
        original_path: String(
          (!retainedStateOnly &&
            remote.customFields?.find((f) => f.id === fields.original_path)
              ?.value) ||
            original?.source_path ||
            source.sourcePath ||
            "",
        ),
        attribution: JSON.stringify(sanitizeAttribution(recent?.attribution)),
        source_path: recent?.source_path ?? source.sourcePath ?? "",
        email_destination: email,
        sms_destination: phone ?? "",
        historical:
          job.historical &&
          remote.customFields?.find((f) => f.id === fields.historical)
            ?.value !== "no"
            ? "yes"
            : "no",
        interest: recent?.interest ?? source.interest ?? "",
        lifecycle: orders.rows
          .map(
            (o) =>
              `${o.purpose}:${o.status}${o.refunded ? ":refund" : ""}:${o.amount_cents} ${o.currency}`,
          )
          .join("; "),
        last_activity:
          latestActivity > 0 ? new Date(latestActivity).toISOString() : "",
      };
      const dndSettings: Record<string, { status: string; message?: string }> =
        {};
      if (emailConsent === "unsubscribed" && !providerBlocked(remote, "email"))
        dndSettings.email = {
          status: "active",
          message: "lh:website-withdrawal",
        };
      if (smsConsent === "unsubscribed" && !providerBlocked(remote, "sms"))
        dndSettings.sms = {
          status: "active",
          message: "lh:website-withdrawal",
        };
      await api(`/contacts/${pathId(id)}`, {
        method: "PUT",
        body: {
          customFields: Object.entries(values).map(([key, fieldValue]) => ({
            id: fields[key],
            fieldValue,
          })),
          ...(!remote.email ? { email } : {}),
          ...(source.name &&
          !remote.name &&
          !remote.firstName &&
          !remote.lastName
            ? { name: source.name }
            : {}),
          ...(phone && !remote.phone ? { phone } : {}),
          ...(Object.keys(dndSettings).length ? { dndSettings } : {}),
        },
      });
      await api(`/contacts/${pathId(id)}/tags`, {
        method: "POST",
        body: {
          tags: [
            "lh:website",
            `lh:source:${source.source.replace(/[^a-z0-9_-]/gi, "").slice(0, 50)}`,
          ],
        },
      });

      // Non-idempotent effects use a durable ledger on a separate connection. It must
      // survive rollback if the provider accepted a request but its reply was lost.
      // Save the contact mapping first; later effect processing runs after commit.
      await tx.execute(
        sql`update highlevel_contacts set last_synced_at = now(), updated_at = now() where id = ${local.id}::uuid`,
      );
      return "succeeded" as const;
    })
    .then(async (result) => {
      // Retention refreshes the current projection without replaying notes,
      // opportunities, conversions, or marketing admissions.
      if (retainedStateOnly) return result;
      const contact = (
        await getPrivateDb().execute<CrmContact>(
          sql`select * from highlevel_contacts where location_id = ${location} and email_normalized = ${email}`,
        )
      ).rows[0];
      if (contact?.provider_id)
        await getPrivateDb().transaction(async (lock) => {
          await lock.execute(sql`set local lock_timeout = '5s'`);
          await lock.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`highlevel-effects:${contact.id}`}, 0))`,
          );
          await syncEffects(job, source, contact, api);
        });
      return result;
    });
}

export async function durableEffect(
  key: string,
  contact: CrmContact,
  kind: string,
  run: () => Promise<string | void>,
  data: Record<string, string> = {},
): Promise<void> {
  const db = getPrivateDb();
  const claim = await db.execute(
    sql`insert into highlevel_effects (key, contact_id, kind, state, data) values (${key}, ${contact.id}::uuid, ${kind}, 'pending', ${JSON.stringify(data)}::jsonb) on conflict do nothing returning key`,
  );
  if (!claim.rows.length) {
    const prior = (
      await db.execute<{ state: string }>(
        sql`select state from highlevel_effects where key = ${key}`,
      )
    ).rows[0];
    if (prior?.state === "succeeded" || prior?.state === "cancelled") return;
    throw new HighLevelError("ambiguous_effect_requires_review");
  }
  try {
    const id = await run();
    await db.execute(
      sql`update highlevel_effects set state = 'succeeded', provider_id = ${id ?? null}, updated_at = now() where key = ${key}`,
    );
  } catch (error) {
    if (error instanceof HighLevelError && !error.ambiguous) {
      await db.execute(
        sql`delete from highlevel_effects where key = ${key} and state = 'pending'`,
      );
    }
    throw error;
  }
}

export async function syncEffects(
  job: CrmJob,
  source: CrmSource,
  contact: CrmContact,
  api: CrmRequest,
): Promise<void> {
  const id = pathId(contact.provider_id!);
  if (
    job.entity_type === "submission" &&
    ["general_inquiry", "training_contact", "course_signup"].includes(
      source.source,
    )
  ) {
    await durableEffect(`note:${job.entity_id}`, contact, "note", async () => {
      const result = await api<{ note: { id: string } }>(
        `/contacts/${id}/notes`,
        {
          method: "POST",
          nonIdempotent: true,
          body: {
            body: `[LH submission ${job.entity_id}]\n${source.source}\n${source.interest ?? ""}\n${source.sourcePath ?? ""}\n${source.message ?? ""}${source.source === "course_signup" && source.instagram ? `\nInstagram: ${source.instagram}` : ""}`,
          },
        },
      );
      if (!result.note?.id)
        throw new HighLevelError("ambiguous_note_response", false, 60, true);
      return result.note.id;
    });
    if (!job.historical && source.source !== "course_signup")
      await syncOpportunity(job, source, contact, api);
  }
  const email = contact.email_normalized;
  const [emailConsent, smsConsent] = await Promise.all([
    channelConsent(email, "email", email),
    channelConsent(email, "sms", contact.phone),
  ]);
  // Historical commerce describes past activity; only current consent can stop
  // a newer journey while importing it. Live conversions retain their effects.
  const converted = /:paid:/.test(source.lifecycle ?? "");
  if (!job.historical && converted) {
    await stopJourneys(contact, api, true);
    await closeMatchingOpportunity(source, contact, api);
  }
  if (
    (emailConsent !== "opted_in" && smsConsent !== "opted_in") ||
    (!job.historical &&
      (source.refunded ||
        /:(refunded|cancelled|verification_failed):/.test(
          source.lifecycle ?? "",
        )))
  ) {
    await stopJourneys(contact, api);
    return;
  }
  if (
    !job.historical &&
    job.entity_type === "submission" &&
    source.source === "contact_popup" &&
    source.marketingProvider === "highlevel" &&
    !source.offer &&
    job.event_type !== "welcome_requested"
  ) {
    await enqueueCrmEvent(getPrivateDb(), {
      entityType: "submission",
      entityId: job.entity_id,
      eventKey: `welcome:${job.entity_id}`,
      eventType: "welcome_requested",
    });
    return;
  }
  if (
    (job.entity_type === "delivery" ||
      job.event_type === "welcome_requested") &&
    !crmMarketingEnabled()
  )
    throw new HighLevelError("marketing_paused", true, 3600);
  if (
    job.historical ||
    !crmMarketingEnabled() ||
    job.entity_type === "consent" ||
    job.entity_type === "contact"
  )
    return;
  // No marketing admission for submissions collected under Resend ownership.
  if (
    job.entity_type === "submission" &&
    source.marketingProvider !== "highlevel"
  )
    return;
  if (job.entity_type === "submission" && source.source === "contact_popup") {
    if (source.offer) return; // Includes a repeated promotion originally owned by Resend.
    const offered = await getPrivateDb().execute(
      sql`select id from customer_email_outbox where submission_id = ${job.entity_id}::uuid`,
    );
    if (offered.rows.length) return; // The immutable provider-owned offer job owns welcome delivery.
  }
  const journey: Journey | null =
    source.source === "training_contact"
      ? "training"
      : source.source === "general_inquiry"
        ? "inquiry"
        : source.source === "course_signup"
          ? "course"
          : source.source === "contact_popup"
            ? "welcome"
            : source.fulfilled === true
              ? "purchase"
              : null;
  if (!journey) return;
  // A retry can outlive a later purchase. Preserve staff follow-up, but never
  // restart the earlier sales journey after conversion. New inquiries still qualify.
  if (
    journey !== "purchase" &&
    (await hasConversionSince(email, source.activityAt))
  )
    return;
  const workflow = workflowId(journey);
  if (!workflow) throw new HighLevelError(`missing_workflow_${journey}`);
  const key =
    journey === "welcome" && job.entity_type !== "delivery"
      ? `journey:welcome:${contact.id}:generic`
      : `journey:${journey}:${source.orderId ?? `${job.entity_type}:${job.entity_id}`}`;
  // Admission to one journey at a time; all drafts finish within fourteen days.
  // The native shared gate additionally enforces the aggregate message budget.
  const active = await getPrivateDb().execute<{ key: string }>(
    sql`select key from highlevel_effects where contact_id = ${contact.id}::uuid and kind = 'workflow' and state in ('pending','succeeded') and key <> ${key} and created_at > now() - interval '14 days' limit 1`,
  );
  if (active.rows.length) {
    if (
      job.entity_type === "delivery" ||
      job.event_type === "welcome_requested"
    )
      throw new HighLevelError("marketing_journey_busy", true, 86400);
    return;
  }
  if (job.entity_type === "delivery") {
    const offered = (
      await getPrivateDb().execute<{ template_data_ciphertext: string }>(
        sql`select template_data_ciphertext from customer_email_outbox where id = ${job.entity_id}::uuid and redacted_at is null and status <> 'dead_letter'`,
      )
    ).rows[0];
    if (!offered) return;
    if (emailConsent !== "opted_in" || contact.provider_email_blocked) return;
    const offer = decryptCustomerEmailOutboxValue(
      offered.template_data_ciphertext,
      "payload",
    ) as ContactPopupOfferEmailPayload;
    if (
      !offer ||
      typeof offer.promotionCode !== "string" ||
      typeof offer.ctaUrl !== "string" ||
      !offer.ctaUrl.startsWith("https://")
    )
      throw new HighLevelError("invalid_offer_snapshot");
    await api(`/contacts/${id}`, {
      method: "PUT",
      body: {
        customFields: Object.entries({
          offer: offer.promotionId,
          offer_code: offer.promotionCode,
          offer_label: offer.offerLabel,
          offer_terms: offer.offerTerms,
          offer_url: offer.ctaUrl,
        }).map(([key, fieldValue]) => ({ id: fieldIds()[key], fieldValue })),
      },
    });
  }
  await stopJourneys(contact, api, false, key);
  // The HighLevel dispatcher owns cadence, channel eligibility and mutually
  // exclusive journeys. Admission does not itself authorize a message.
  await durableEffect(
    key,
    contact,
    "workflow",
    async () => {
      await api(`/contacts/${id}`, {
        method: "PUT",
        body: {
          customFields: [
            { id: fieldIds().journey_key, fieldValue: key },
            ...(journey === "welcome" && job.entity_type !== "delivery"
              ? [
                  "offer",
                  "offer_code",
                  "offer_label",
                  "offer_terms",
                  "offer_url",
                ].map((field) => ({ id: fieldIds()[field], fieldValue: "" }))
              : []),
          ],
        },
      });
      const result = await api<{ succeeded?: boolean; succeded?: boolean }>(
        `/contacts/${id}/workflow/${pathId(workflow)}`,
        {
          method: "POST",
          nonIdempotent: true,
          body: { eventStartTime: new Date().toISOString() },
        },
      );
      if (result.succeeded !== true && result.succeded !== true)
        throw new HighLevelError(
          "ambiguous_workflow_response",
          false,
          60,
          true,
        );
      return workflow;
    },
    { journey, workflow },
  );
  if (job.entity_type === "delivery")
    await getPrivateDb().execute(
      sql`update customer_email_outbox set status = 'sent', provider_message_id = ${`workflow:${workflow}`}, sent_at = now(), updated_at = now() where id = ${job.entity_id}::uuid and delivery_provider = 'highlevel' and redacted_at is null`,
    );
}

async function syncOpportunity(
  job: CrmJob,
  source: CrmSource,
  contact: CrmContact,
  api: CrmRequest,
): Promise<void> {
  const training = source.source === "training_contact";
  const pipeline =
    process.env[
      training
        ? "HIGHLEVEL_TRAINING_PIPELINE_ID"
        : "HIGHLEVEL_MARKETING_PIPELINE_ID"
    ];
  const stage =
    process.env[
      training ? "HIGHLEVEL_TRAINING_STAGE_ID" : "HIGHLEVEL_MARKETING_STAGE_ID"
    ];
  if (!pipeline || !stage) throw new HighLevelError("missing_pipeline_mapping");
  const key = `opportunity:${contact.id}:${pipeline}:${job.entity_id}`;
  const found = await api<{ opportunities: { id: string; name: string }[] }>(
    `/opportunities/search?${new URLSearchParams({ locationId: locationId(), contactId: contact.provider_id!, pipelineId: pipeline, status: "open", limit: "100" })}`,
  );
  if (found.opportunities?.length >= 100)
    throw new HighLevelError("opportunity_search_requires_review");
  if (!Array.isArray(found.opportunities))
    throw new HighLevelError("invalid_opportunity_response");
  const name = `Website ${training ? "training" : "inquiry"}${source.interest ? ` — ${source.interest}` : ""}`;
  const matching = found.opportunities.filter((o) => o.name === name);
  if (matching.length > 1) throw new HighLevelError("opportunity_conflict");
  if (!matching.length)
    await durableEffect(
      key,
      contact,
      "opportunity",
      async () => {
        const created = await api<{ opportunity: { id: string } }>(
          "/opportunities/",
          {
            method: "POST",
            nonIdempotent: true,
            body: {
              pipelineId: pipeline,
              pipelineStageId: stage,
              locationId: locationId(),
              contactId: contact.provider_id,
              name,
              status: "open",
              source: "Lash Her website",
            },
          },
        );
        if (!created.opportunity?.id)
          throw new HighLevelError(
            "ambiguous_opportunity_response",
            false,
            60,
            true,
          );
        return created.opportunity.id;
      },
      { interest: source.interest ?? "", pipeline },
    );
  const opportunityId =
    matching[0]?.id ??
    (
      await getPrivateDb().execute<{ provider_id: string }>(
        sql`select provider_id from highlevel_effects where key = ${key} and state = 'succeeded'`,
      )
    ).rows[0]?.provider_id;
  if (!opportunityId) throw new HighLevelError("opportunity_mapping_missing");
  await durableEffect(
    `task:${contact.id}:${opportunityId}`,
    contact,
    "task",
    async () => {
      const task = await api<{ task: { id: string } }>(
        `/contacts/${pathId(contact.provider_id!)}/tasks`,
        {
          method: "POST",
          nonIdempotent: true,
          body: {
            title: `Follow up: ${name}`,
            body: "Review the website inquiry in contact notes.",
            dueDate: new Date(Date.now() + 86_400_000).toISOString(),
            completed: false,
            ...(process.env.HIGHLEVEL_ASSIGNED_USER_ID
              ? { assignedTo: process.env.HIGHLEVEL_ASSIGNED_USER_ID }
              : {}),
          },
        },
      );
      if (!task.task?.id)
        throw new HighLevelError("ambiguous_task_response", false, 60, true);
      return task.task.id;
    },
  );
}

export async function stopJourneys(
  contact: CrmContact,
  api: CrmRequest = highlevel,
  salesOnly = false,
  excludeKey: string | null = null,
  onlyKeys?: string[],
): Promise<void> {
  const db = getPrivateDb();
  const effects = await db.execute<{
    key: string;
    data: { workflow?: string };
  }>(
    sql`select key, data from highlevel_effects where contact_id = ${contact.id}::uuid and kind = 'workflow' and state <> 'cancelled' and (${!salesOnly} or data->>'journey' <> 'purchase') and (${excludeKey}::text is null or key <> ${excludeKey})`,
  );
  for (const effect of effects.rows) {
    if (onlyKeys && !onlyKeys.includes(effect.key)) continue;
    if (!effect.data.workflow || !contact.provider_id) continue;
    try {
      const result = await api<{ succeeded?: boolean; succeded?: boolean }>(
        `/contacts/${pathId(contact.provider_id)}/workflow/${pathId(effect.data.workflow)}`,
        { method: "DELETE" },
      );
      if (result.succeeded !== true && result.succeded !== true)
        throw new HighLevelError("workflow_removal_unconfirmed", true);
    } catch (error) {
      if (
        !(
          error instanceof HighLevelError && error.code === "highlevel_http_404"
        )
      )
        throw error;
    }
    await db.execute(
      sql`update highlevel_effects set state = 'cancelled', updated_at = now() where key = ${effect.key}`,
    );
  }
}

async function reconcileRemovedSource(
  job: CrmJob,
  api: CrmRequest,
): Promise<"skipped"> {
  const db = getPrivateDb();
  const effect = (
    await db.execute<{ contact_id: string }>(
      sql`select contact_id from highlevel_effects where key = ${`entity:${job.entity_type}:${job.entity_id}`}`,
    )
  ).rows[0];
  if (!effect) return "skipped";
  const contact = (
    await db.execute<CrmContact>(
      sql`select * from highlevel_contacts where id = ${effect.contact_id}::uuid`,
    )
  ).rows[0];
  if (!contact?.provider_id) return "skipped";
  // Remove source notes as soon as their authoritative submission is redacted.
  const note = (
    await db.execute<{ provider_id: string }>(
      sql`select provider_id from highlevel_effects where ${job.entity_type === "submission"} and key = ${`note:${job.entity_id}`} and state = 'succeeded'`,
    )
  ).rows[0];
  if (note?.provider_id) {
    try {
      await api(
        `/contacts/${pathId(contact.provider_id)}/notes/${pathId(note.provider_id)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (
        !(
          error instanceof HighLevelError && error.code === "highlevel_http_404"
        )
      )
        throw error;
    }
    await db.execute(
      sql`update highlevel_effects set state = 'cancelled', provider_id = null where key = ${`note:${job.entity_id}`}`,
    );
  }
  const retained = await loadRetainedSource(contact);
  if (retained) {
    // Entity-specific admissions can stop without cancelling another retained
    // source's journey. Generic welcomes are shared across the contact.
    await stopJourneys(contact, api, false, null, [
      `journey:inquiry:${job.entity_type}:${job.entity_id}`,
      `journey:training:${job.entity_type}:${job.entity_id}`,
      `journey:course:${job.entity_type}:${job.entity_id}`,
      `journey:welcome:${job.entity_type}:${job.entity_id}`,
      ...(job.entity_type === "order"
        ? [`journey:purchase:${job.entity_id}`]
        : []),
    ]);
    await syncSource(job, retained, api, true);
    return "skipped";
  }
  await stopJourneys(contact, api);
  const fields = fieldIds();
  await api(`/contacts/${pathId(contact.provider_id)}`, {
    method: "PUT",
    body: {
      customFields: Object.entries(fields)
        .filter(([key]) => key !== "website_id")
        .map(([key, id]) => ({
          id,
          fieldValue: key.endsWith("_eligible") ? "no" : "",
        })),
    },
  });
  // Contact-wide deletion needs review: it may contain staff-owned records or
  // another retained purpose. Never erase unrelated CRM work automatically.
  throw new HighLevelError("crm_retention_review_required");
}

async function closeMatchingOpportunity(
  source: CrmSource,
  contact: CrmContact,
  api: CrmRequest,
): Promise<void> {
  // Products cannot be reliably attributed to a general inquiry. Only a paid
  // training purchase with the same program may close a website-created deal.
  if (source.source !== "training" || !source.interest) return;
  const effects = await getPrivateDb().execute<{ provider_id: string }>(
    sql`select provider_id from highlevel_effects where contact_id = ${contact.id}::uuid and kind = 'opportunity' and state = 'succeeded' and data->>'interest' = ${source.interest}`,
  );
  for (const effect of effects.rows) {
    const { opportunity } = await api<{
      opportunity: {
        status: string;
        contactId: string;
        pipelineId: string;
        pipelineStageId: string;
      };
    }>(`/opportunities/${pathId(effect.provider_id)}`);
    if (
      opportunity.status === "open" &&
      opportunity.contactId === contact.provider_id &&
      opportunity.pipelineId === process.env.HIGHLEVEL_TRAINING_PIPELINE_ID &&
      opportunity.pipelineStageId === process.env.HIGHLEVEL_TRAINING_STAGE_ID
    ) {
      await api(`/opportunities/${pathId(effect.provider_id)}`, {
        method: "PUT",
        body: { status: "won" },
      });
    }
  }
}
