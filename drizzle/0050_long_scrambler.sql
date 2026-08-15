ALTER TABLE "manual_fulfillment_policy_versions" DROP CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";--> statement-breakpoint
UPDATE "product_shipments"
SET "pii_redaction_due_at" = least(
  coalesce("pii_redaction_due_at", "created_at" + interval '365 days'),
  "created_at" + interval '365 days'
);--> statement-breakpoint
ALTER TABLE "product_shipments" ALTER COLUMN "pii_redaction_due_at" SET DEFAULT now() + interval '365 days';--> statement-breakpoint
ALTER TABLE "product_shipments" ALTER COLUMN "pii_redaction_due_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_data_quarantine" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_owner_actions" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_lease_owner" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_outcome" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_last_error" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_transactions" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_manual_fulfillment_events" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_adjustments" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_events" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_events" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "provider_ship_date_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN "pii_redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
UPDATE "checkout_orders" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "fulfillment_data_quarantine" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "fulfillment_owner_actions" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "order_payment_obligations" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "order_payment_transactions" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_manual_fulfillment_events" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_order_address_change_requests" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_order_adjustments" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_order_customer_decisions" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_order_refunds" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_order_risk_reviews" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_payment_risk_incidents" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_shipment_events" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_shipment_jobs" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "product_shipping_cases" SET "pii_redaction_due_at" = "created_at" + interval '365 days';--> statement-breakpoint
UPDATE "fulfillment_data_quarantine"
SET "evidence" = jsonb_build_object(
	'checkout_order_id', coalesce("evidence" -> 'checkout_order_id', "evidence" -> 'id'),
	'order_id', "evidence" -> 'order_id',
	'payment_provider', "evidence" -> 'payment_provider',
	'provider_transaction_id', coalesce("evidence" -> 'provider_transaction_id', "evidence" -> 'helcim_transaction_id'),
	'provider_invoice_id', coalesce("evidence" -> 'provider_invoice_id', "evidence" -> 'helcim_invoice_id'),
	'provider_invoice_number', coalesce("evidence" -> 'provider_invoice_number', "evidence" -> 'helcim_invoice_number'),
	'provider_checkout_id', "evidence" -> 'provider_checkout_id',
	'status', "evidence" -> 'status',
	'purpose', "evidence" -> 'purpose',
	'initialization_status', "evidence" -> 'initialization_status',
	'amount_cents', "evidence" -> 'amount_cents',
	'merchandise_amount_cents', "evidence" -> 'merchandise_amount_cents',
	'shipping_amount_cents', "evidence" -> 'shipping_amount_cents',
	'tax_amount_cents', "evidence" -> 'tax_amount_cents',
	'currency', "evidence" -> 'currency',
	'tax_policy_version', "evidence" -> 'tax_policy_version',
	'policy_version', coalesce("evidence" -> 'policy_version', "evidence" -> 'shipping_policy_version'),
	'created_at', "evidence" -> 'created_at',
	'paid_at', "evidence" -> 'paid_at',
	'redacted_at', "evidence" -> 'redacted_at',
	'legacy_evidence_redacted', true
)
WHERE "entity_type" = 'checkout_order'
	AND "reason_code" IN ('duplicate_helcim_transaction_id', 'primary_obligation_backfill_ambiguous');--> statement-breakpoint
UPDATE "fulfillment_data_quarantine"
SET "evidence" = jsonb_build_object(
	'case_id', coalesce("evidence" -> 'case_id', "evidence" -> 'id'),
	'order_id', "evidence" -> 'order_id',
	'shipment_id', "evidence" -> 'shipment_id',
	'source_shipment_id', "evidence" -> 'source_shipment_id',
	'remedy_shipment_id', "evidence" -> 'remedy_shipment_id',
	'type', "evidence" -> 'type',
	'status', "evidence" -> 'status',
	'provider_claim_reference', "evidence" -> 'provider_claim_reference',
	'eligible_at', "evidence" -> 'eligible_at',
	'carrier_deadline_at', "evidence" -> 'carrier_deadline_at',
	'customer_update_due_at', "evidence" -> 'customer_update_due_at',
	'remedy_deadline_at', "evidence" -> 'remedy_deadline_at',
	'acknowledged_at', "evidence" -> 'acknowledged_at',
	'resolved_at', "evidence" -> 'resolved_at',
	'created_at', "evidence" -> 'created_at',
	'updated_at', "evidence" -> 'updated_at',
	'redacted_at', "evidence" -> 'redacted_at',
	'legacy_evidence_redacted', true
)
WHERE "entity_type" = 'product_shipping_case'
	AND "reason_code" = 'duplicate_active_case_scope';--> statement-breakpoint
UPDATE "fulfillment_data_quarantine"
SET "evidence" = jsonb_build_object(
	'refund_id', coalesce("evidence" -> 'refund_id', "evidence" -> 'id'),
	'order_id', "evidence" -> 'order_id',
	'case_id', "evidence" -> 'case_id',
	'idempotency_key', "evidence" -> 'idempotency_key',
	'kind', "evidence" -> 'kind',
	'amount_cents', "evidence" -> 'amount_cents',
	'original_transaction_id', "evidence" -> 'original_transaction_id',
	'status', "evidence" -> 'status',
	'provider_refund_id', "evidence" -> 'provider_refund_id',
	'payment_transaction_id', "evidence" -> 'payment_transaction_id',
	'adjustment_id', "evidence" -> 'adjustment_id',
	'attempt_count', "evidence" -> 'attempt_count',
	'first_attempted_at', "evidence" -> 'first_attempted_at',
	'last_attempted_at', "evidence" -> 'last_attempted_at',
	'unknown_outcome_at', "evidence" -> 'unknown_outcome_at',
	'automated', "evidence" -> 'automated',
	'succeeded_at', "evidence" -> 'succeeded_at',
	'created_at', "evidence" -> 'created_at',
	'updated_at', "evidence" -> 'updated_at',
	'legacy_evidence_redacted', true
)
WHERE "entity_type" = 'product_order_refund'
	AND "reason_code" = 'duplicate_provider_refund_id';--> statement-breakpoint
UPDATE "fulfillment_data_quarantine"
SET "evidence" = jsonb_build_object(
	'obligation_id', coalesce("evidence" -> 'obligation_id', "evidence" -> 'id'),
	'order_id', "evidence" -> 'order_id',
	'purpose', "evidence" -> 'purpose',
	'status', "evidence" -> 'status',
	'merchandise_amount_cents', "evidence" -> 'merchandise_amount_cents',
	'shipping_amount_cents', "evidence" -> 'shipping_amount_cents',
	'tax_amount_cents', "evidence" -> 'tax_amount_cents',
	'total_amount_cents', "evidence" -> 'total_amount_cents',
	'currency', "evidence" -> 'currency',
	'source_workflow', "evidence" -> 'source_workflow',
	'source_reference_id', "evidence" -> 'source_reference_id',
	'tax_policy_version', "evidence" -> 'tax_policy_version',
	'policy_version', "evidence" -> 'policy_version',
	'quote_version', "evidence" -> 'quote_version',
	'expires_at', "evidence" -> 'expires_at',
	'idempotency_key', "evidence" -> 'idempotency_key',
	'payment_provider', "evidence" -> 'payment_provider',
	'provider_invoice_id', "evidence" -> 'provider_invoice_id',
	'provider_invoice_number', "evidence" -> 'provider_invoice_number',
	'provider_checkout_id', "evidence" -> 'provider_checkout_id',
	'initialization_status', "evidence" -> 'initialization_status',
	'paid_at', "evidence" -> 'paid_at',
	'created_at', "evidence" -> 'created_at',
	'updated_at', "evidence" -> 'updated_at',
	'legacy_evidence_redacted', true
)
WHERE "entity_type" = 'order_payment_obligation'
	AND "reason_code" = 'duplicate_primary_obligation';--> statement-breakpoint
UPDATE "customer_email_outbox"
SET "redaction_due_at" = least("redaction_due_at", "created_at" + interval '365 days');--> statement-breakpoint
UPDATE "fulfillment_risk_alert_outbox"
SET "redaction_due_at" = least("redaction_due_at", "created_at" + interval '365 days');--> statement-breakpoint
UPDATE "product_shipment_return_observations"
SET "redaction_due_at" = least("redaction_due_at", "created_at" + interval '365 days');--> statement-breakpoint
CREATE FUNCTION "prevent_pii_redaction_deadline_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pii_redaction_due_at IS DISTINCT FROM OLD.pii_redaction_due_at THEN
    RAISE EXCEPTION 'pii_redaction_due_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "prevent_redaction_deadline_change"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.redaction_due_at IS DISTINCT FROM OLD.redaction_due_at THEN
    RAISE EXCEPTION 'redaction_due_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'checkout_orders',
    'fulfillment_data_quarantine',
    'fulfillment_owner_actions',
    'order_payment_obligations',
    'order_payment_transactions',
    'product_manual_fulfillment_events',
    'product_order_address_change_requests',
    'product_order_adjustments',
    'product_order_customer_decisions',
    'product_order_refunds',
    'product_order_risk_reviews',
    'product_payment_risk_incidents',
    'product_shipment_events',
    'product_shipment_jobs',
    'product_shipments',
    'product_shipping_cases'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (pii_redaction_due_at <= created_at + interval ''365 days'')',
      table_name,
      table_name || '_pii_deadline_cap_check'
    );
  END LOOP;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_email_outbox',
    'fulfillment_risk_alert_outbox',
    'product_shipment_return_observations'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (redaction_due_at <= created_at + interval ''365 days'')',
      table_name,
      table_name || '_redaction_deadline_cap_check'
    );
  END LOOP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "checkout_orders_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "checkout_orders" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "fulfillment_data_quarantine_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "fulfillment_data_quarantine" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "fulfillment_owner_actions_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "fulfillment_owner_actions" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "order_payment_obligations_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "order_payment_obligations" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "order_payment_transactions_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "order_payment_transactions" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_manual_fulfillment_events_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_manual_fulfillment_events" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_order_address_change_requests_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_order_address_change_requests" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_order_adjustments_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_order_adjustments" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_order_customer_decisions_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_order_customer_decisions" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_order_refunds_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_order_refunds" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_order_risk_reviews_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_order_risk_reviews" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_payment_risk_incidents_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_payment_risk_incidents" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_shipment_events_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_shipment_events" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_shipment_jobs_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_shipment_jobs" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_shipments_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_shipments" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_shipping_cases_pii_deadline_immutable" BEFORE UPDATE OF "pii_redaction_due_at" ON "product_shipping_cases" FOR EACH ROW EXECUTE FUNCTION "prevent_pii_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "customer_email_outbox_deadline_immutable" BEFORE UPDATE OF "redaction_due_at" ON "customer_email_outbox" FOR EACH ROW EXECUTE FUNCTION "prevent_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "fulfillment_risk_alert_outbox_deadline_immutable" BEFORE UPDATE OF "redaction_due_at" ON "fulfillment_risk_alert_outbox" FOR EACH ROW EXECUTE FUNCTION "prevent_redaction_deadline_change"();--> statement-breakpoint
CREATE TRIGGER "product_shipment_return_observations_deadline_immutable" BEFORE UPDATE OF "redaction_due_at" ON "product_shipment_return_observations" FOR EACH ROW EXECUTE FUNCTION "prevent_redaction_deadline_change"();--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'manual_fulfillment_policy_version',
	policy."id"::text,
	'effective_policy_evidence_unverifiable',
	jsonb_build_object(
		'policy_id', policy."id",
		'version', policy."version",
		'status', policy."status",
		'policy_text_hash_valid', coalesce(policy."policy_text_hash" ~ '^[0-9a-f]{64}$', false),
		'approved_at', policy."approved_at",
		'approver_present', policy."approved_by_admin_user_id" IS NOT NULL,
		'evidence_reference_present', coalesce(length(trim(policy."evidence_reference")), 0) > 0,
		'cancellation_policy_text_present', coalesce(jsonb_typeof(policy."policy_snapshot" -> 'cancellationPolicyText') = 'string' AND length(trim(policy."policy_snapshot" ->> 'cancellationPolicyText')) > 0, false),
		'effective_at', policy."effective_at",
		'superseded_at', policy."superseded_at",
		'created_at', policy."created_at"
	)
FROM "manual_fulfillment_policy_versions" policy
WHERE policy."status" = 'effective'
	AND (
		policy."policy_text_hash" IS NULL
		OR policy."policy_text_hash" !~ '^[0-9a-f]{64}$'
		OR policy."approved_at" IS NULL
		OR policy."effective_at" IS NULL
		OR policy."effective_at" < policy."approved_at"
		OR policy."approved_by_admin_user_id" IS NULL
		OR coalesce(length(trim(policy."evidence_reference")), 0) = 0
		OR jsonb_typeof(policy."policy_snapshot" -> 'cancellationPolicyText') IS DISTINCT FROM 'string'
		OR coalesce(length(trim(policy."policy_snapshot" ->> 'cancellationPolicyText')), 0) = 0
		OR policy."superseded_at" IS NOT NULL
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "manual_fulfillment_policy_versions" policy
SET
	"status" = 'draft',
	"effective_at" = NULL,
	"superseded_at" = NULL
WHERE policy."status" = 'effective'
	AND EXISTS (
		SELECT 1
		FROM "fulfillment_data_quarantine" quarantine
		WHERE quarantine."entity_type" = 'manual_fulfillment_policy_version'
			AND quarantine."entity_id" = policy."id"::text
			AND quarantine."reason_code" = 'effective_policy_evidence_unverifiable'
	);--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check" CHECK ("manual_fulfillment_policy_versions"."status" <> 'effective' OR ("manual_fulfillment_policy_versions"."effective_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approved_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."effective_at" >= "manual_fulfillment_policy_versions"."approved_at" AND "manual_fulfillment_policy_versions"."approved_by_admin_user_id" IS NOT NULL AND "manual_fulfillment_policy_versions"."policy_text_hash" ~ '^[0-9a-f]{64}$' AND length(trim("manual_fulfillment_policy_versions"."evidence_reference")) > 0 AND jsonb_typeof("manual_fulfillment_policy_versions"."policy_snapshot" -> 'cancellationPolicyText') = 'string' AND length(trim("manual_fulfillment_policy_versions"."policy_snapshot" ->> 'cancellationPolicyText')) > 0 AND "manual_fulfillment_policy_versions"."superseded_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" VALIDATE CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";
