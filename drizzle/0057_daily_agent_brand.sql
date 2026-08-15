CREATE TABLE "product_order_termination_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notice_at" timestamp with time zone NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"hard_cap_at" timestamp with time zone NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"refund_reserved_at" timestamp with time zone,
	"customer_notice_queued_at" timestamp with time zone,
	"owner_notice_queued_at" timestamp with time zone,
	"operationally_terminated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"outcome_unknown_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_termination_workflows_status_check" CHECK ("product_order_termination_workflows"."status" IN ('scheduled', 'processing', 'refund_pending', 'outcome_unknown', 'manual_review', 'completed', 'cancelled')),
	CONSTRAINT "product_order_termination_workflows_deadline_check" CHECK ("product_order_termination_workflows"."notice_at" < "product_order_termination_workflows"."execute_at" AND "product_order_termination_workflows"."execute_at" < "product_order_termination_workflows"."hard_cap_at"),
	CONSTRAINT "product_order_termination_workflows_attempt_check" CHECK ("product_order_termination_workflows"."attempt_count" >= 0 AND "product_order_termination_workflows"."state_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" DROP CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";--> statement-breakpoint
ALTER TABLE "customer_email_outbox" DROP CONSTRAINT "customer_email_outbox_order_id_checkout_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD COLUMN "approval_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD COLUMN "approval_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD COLUMN "approval_evidence_version" text;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD COLUMN "approval_action" text;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "order_id" = orders."id",
    "updated_at" = now()
FROM "checkout_orders" orders
WHERE outbox."order_id" IS NULL
  AND outbox."provider_idempotency_key" = 'product-confirmation:' || orders."order_id";--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "order_id" = shipments."order_id",
    "updated_at" = now()
FROM "product_shipments" shipments
WHERE outbox."order_id" IS NULL
  AND shipments."order_id" IS NOT NULL
  AND outbox."provider_idempotency_key" IN (
    'product-shipment-accepted:' || shipments."id"::text,
    'product-shipment-exception:' || shipments."id"::text,
    'product-shipment-delivered:' || shipments."id"::text
  );--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "order_id" = decisions."order_id",
    "updated_at" = now()
FROM "product_order_customer_decisions" decisions
WHERE outbox."order_id" IS NULL
  AND outbox."provider_idempotency_key" IN (
    'shipping-decision/' || decisions."id"::text,
    'supplemental-payment-offer/' || decisions."id"::text
  );--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "order_id" = requests."order_id",
    "updated_at" = now()
FROM "product_order_address_change_requests" requests
WHERE outbox."order_id" IS NULL
  AND outbox."provider_idempotency_key" = 'address-change/' || requests."id"::text;--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "order_id" = cases."order_id",
    "updated_at" = now()
FROM "product_shipping_cases" cases
WHERE outbox."order_id" IS NULL
  AND (
    outbox."provider_idempotency_key" LIKE 'shipping-delay-update/' || cases."id"::text || '/%'
    OR outbox."provider_idempotency_key" LIKE 'shipping-blocked-update/' || cases."id"::text || '/%'
  );--> statement-breakpoint
UPDATE "customer_email_outbox" outbox
SET "redaction_due_at" = least(outbox."redaction_due_at", orders."pii_redaction_due_at"),
    "updated_at" = now()
FROM "checkout_orders" orders
WHERE outbox."order_id" = orders."id"
  AND outbox."redaction_due_at" > orders."pii_redaction_due_at";--> statement-breakpoint
UPDATE "customer_email_outbox"
SET "recipient_ciphertext" = '[redacted]',
    "template_data_ciphertext" = '[redacted]',
    "last_error" = NULL,
    "redacted_at" = coalesce("redacted_at", now()),
    "redaction_due_at" = least("redaction_due_at", now()),
    "status" = 'dead_letter',
    "lease_owner" = NULL,
    "lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "order_id" IS NULL
  AND "kind" <> 'shipping_policy_alert';--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" (
  "entity_type",
  "entity_id",
  "reason_code",
  "evidence"
)
SELECT
  'manual_fulfillment_policy_version',
  policy."id"::text,
  'effective_manual_policy_owner_evidence_unverifiable',
  jsonb_build_object(
    'version', policy."version",
    'status', policy."status",
    'approved_at', policy."approved_at",
    'effective_at', policy."effective_at",
    'approved_by_admin_user_id', policy."approved_by_admin_user_id",
    'step_up_present', policy."approval_step_up_authenticated_at" IS NOT NULL,
    'evidence_hash_valid', coalesce(policy."approval_evidence_hash" ~ '^[0-9a-f]{64}$', false),
    'evidence_version_present', coalesce(length(trim(policy."approval_evidence_version")) > 0, false),
    'action_valid', policy."approval_action" = 'approve_manual_fulfillment_policy'
  )
FROM "manual_fulfillment_policy_versions" policy
WHERE policy."status" = 'effective'
  AND NOT (
    policy."approval_step_up_authenticated_at" IS NOT NULL
    AND policy."approved_at" IS NOT NULL
    AND policy."approval_step_up_authenticated_at" <= policy."approved_at"
    AND policy."approval_step_up_authenticated_at" >= policy."approved_at" - interval '5 minutes'
    AND coalesce(policy."approval_evidence_hash" ~ '^[0-9a-f]{64}$', false)
    AND coalesce(length(trim(policy."approval_evidence_version")) > 0, false)
    AND policy."approval_action" = 'approve_manual_fulfillment_policy'
  )
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "manual_fulfillment_policy_versions" policy
SET "status" = 'draft',
    "effective_at" = NULL,
    "superseded_at" = NULL
WHERE policy."status" = 'effective'
  AND NOT (
    policy."approval_step_up_authenticated_at" IS NOT NULL
    AND policy."approved_at" IS NOT NULL
    AND policy."approval_step_up_authenticated_at" <= policy."approved_at"
    AND policy."approval_step_up_authenticated_at" >= policy."approved_at" - interval '5 minutes'
    AND coalesce(policy."approval_evidence_hash" ~ '^[0-9a-f]{64}$', false)
    AND coalesce(length(trim(policy."approval_evidence_version")) > 0, false)
    AND policy."approval_action" = 'approve_manual_fulfillment_policy'
  );--> statement-breakpoint
INSERT INTO "fulfillment_policy_versions" (
  "version",
  "status",
  "owner_name",
  "policy_snapshot"
)
SELECT
  'P-01-P-11-owner-only-p10-precap-2026-08-15',
  'draft',
  base."owner_name",
  base."policy_snapshot" || jsonb_build_object(
    'p10TerminationNoticeDays', 350,
    'p10DefaultExecutionDays', 360,
    'p10HardCapDays', 365,
    'p10ExecutionRationale', 'five-day provider execution and reconciliation buffer before unconditional PII redaction'
  )
FROM "fulfillment_policy_versions" base
WHERE base."version" = 'P-01-P-11-owner-only-2026-08-14'
ON CONFLICT ("version") DO NOTHING;--> statement-breakpoint
ALTER TABLE "product_order_termination_workflows" ADD CONSTRAINT "product_order_termination_workflows_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_termination_workflows_order_idx" ON "product_order_termination_workflows" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "product_order_termination_workflows_due_idx" ON "product_order_termination_workflows" USING btree ("status","execute_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "product_order_termination_workflows_hard_cap_idx" ON "product_order_termination_workflows" USING btree ("hard_cap_at","status");--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD CONSTRAINT "customer_email_outbox_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_customer_email_outbox_order_retention"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_redaction_due_at timestamptz;
  order_purpose text;
  order_redacted_at timestamptz;
BEGIN
  IF NEW."kind" <> 'shipping_policy_alert'
     AND NEW."redacted_at" IS NULL
     AND NEW."order_id" IS NULL THEN
    RAISE EXCEPTION 'active customer email requires an order link';
  END IF;
  IF NEW."order_id" IS NOT NULL THEN
    SELECT orders."pii_redaction_due_at", orders."purpose", orders."redacted_at"
      INTO order_redaction_due_at, order_purpose, order_redacted_at
      FROM "checkout_orders" orders
     WHERE orders."id" = NEW."order_id";
    IF order_redaction_due_at IS NULL THEN
      RAISE EXCEPTION 'customer email order link is invalid';
    END IF;
    IF NEW."redaction_due_at" > order_redaction_due_at THEN
      RAISE EXCEPTION 'customer email retention exceeds order retention';
    END IF;
    IF NEW."kind" <> 'shipping_policy_alert'
       AND NEW."redacted_at" IS NULL
       AND (order_purpose <> 'product' OR order_redacted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'active customer email requires a non-redacted product order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "customer_email_outbox_order_retention_trigger"
BEFORE INSERT OR UPDATE OF "kind", "order_id", "redaction_due_at", "redacted_at"
ON "customer_email_outbox"
FOR EACH ROW
EXECUTE FUNCTION "enforce_customer_email_outbox_order_retention"();--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD CONSTRAINT "customer_email_outbox_active_customer_order_link_check" CHECK ("customer_email_outbox"."kind" = 'shipping_policy_alert' OR "customer_email_outbox"."order_id" IS NOT NULL OR "customer_email_outbox"."redacted_at" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_email_outbox" VALIDATE CONSTRAINT "customer_email_outbox_active_customer_order_link_check";--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check" CHECK ("manual_fulfillment_policy_versions"."status" <> 'effective' OR ("manual_fulfillment_policy_versions"."effective_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approved_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."effective_at" >= "manual_fulfillment_policy_versions"."approved_at" AND "manual_fulfillment_policy_versions"."approved_by_admin_user_id" IS NOT NULL AND "manual_fulfillment_policy_versions"."approval_step_up_authenticated_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approval_step_up_authenticated_at" <= "manual_fulfillment_policy_versions"."approved_at" AND "manual_fulfillment_policy_versions"."approval_step_up_authenticated_at" >= "manual_fulfillment_policy_versions"."approved_at" - interval '5 minutes' AND "manual_fulfillment_policy_versions"."approval_evidence_hash" ~ '^[0-9a-f]{64}$' AND length(trim("manual_fulfillment_policy_versions"."approval_evidence_version")) > 0 AND "manual_fulfillment_policy_versions"."approval_action" = 'approve_manual_fulfillment_policy' AND "manual_fulfillment_policy_versions"."policy_text_hash" ~ '^[0-9a-f]{64}$' AND length(trim("manual_fulfillment_policy_versions"."evidence_reference")) > 0 AND jsonb_typeof("manual_fulfillment_policy_versions"."policy_snapshot" -> 'cancellationPolicyText') = 'string' AND length(trim("manual_fulfillment_policy_versions"."policy_snapshot" ->> 'cancellationPolicyText')) > 0 AND "manual_fulfillment_policy_versions"."superseded_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" VALIDATE CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_state_version_check" CHECK ("product_shipping_cases"."state_version" >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" VALIDATE CONSTRAINT "product_shipping_cases_state_version_check";
