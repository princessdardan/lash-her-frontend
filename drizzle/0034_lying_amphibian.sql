CREATE TYPE "public"."checkout_fulfillment_mode" AS ENUM('automated_shipping', 'manual_pickup', 'manual_shipping');--> statement-breakpoint
CREATE TYPE "public"."order_payment_obligation_purpose" AS ENUM('primary', 'manual_shipping', 'address_increase');--> statement-breakpoint
CREATE TYPE "public"."order_payment_obligation_status" AS ENUM('pending', 'paid', 'expired', 'superseded', 'cancelled', 'refunded', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."payment_risk_status" AS ENUM('not_required', 'pending', 'cleared', 'review_required');--> statement-breakpoint
CREATE TYPE "public"."product_order_adjustment_component" AS ENUM('merchandise', 'tax', 'outbound_shipping');--> statement-breakpoint
CREATE TYPE "public"."product_order_adjustment_direction" AS ENUM('charge', 'refund');--> statement-breakpoint
CREATE TYPE "public"."product_order_adjustment_status" AS ENUM('pending', 'reserved', 'processing', 'succeeded', 'failed', 'outcome_unknown', 'manual_review', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."payment_event_processing_status" ADD VALUE 'review_required';--> statement-breakpoint
ALTER TYPE "public"."payment_event_processing_status" ADD VALUE 'retryable_failed';--> statement-breakpoint
ALTER TYPE "public"."product_shipment_job_type" ADD VALUE 'quote_refresh' BEFORE 'purchase';--> statement-breakpoint
ALTER TYPE "public"."product_shipment_job_type" ADD VALUE 'replacement_prepare' BEFORE 'notification';--> statement-breakpoint
ALTER TYPE "public"."product_shipment_job_type" ADD VALUE 'address_replace' BEFORE 'notification';--> statement-breakpoint
CREATE TABLE "customer_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"kind" text NOT NULL,
	"recipient_ciphertext" text NOT NULL,
	"template_data_ciphertext" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"redaction_due_at" timestamp with time zone NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_email_outbox_provider_idempotency_key_unique" UNIQUE("provider_idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"owner_name" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"privacy_legal_attested_at" timestamp with time zone,
	"security_attested_at" timestamp with time zone,
	"operations_attested_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_policy_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_provider_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"scope" text NOT NULL,
	"version" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"certified_by_owner_name" text NOT NULL,
	"certified_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_payment_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"purpose" "order_payment_obligation_purpose" NOT NULL,
	"status" "order_payment_obligation_status" DEFAULT 'pending' NOT NULL,
	"merchandise_amount_cents" integer DEFAULT 0 NOT NULL,
	"shipping_amount_cents" integer DEFAULT 0 NOT NULL,
	"tax_amount_cents" integer DEFAULT 0 NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"source_workflow" text NOT NULL,
	"source_reference_id" uuid,
	"disclosure_snapshot" jsonb,
	"tax_policy_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"quote_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payment_obligations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "order_payment_obligations_components_check" CHECK ("order_payment_obligations"."merchandise_amount_cents" >= 0 AND "order_payment_obligations"."shipping_amount_cents" >= 0 AND "order_payment_obligations"."tax_amount_cents" >= 0 AND "order_payment_obligations"."total_amount_cents" = "order_payment_obligations"."merchandise_amount_cents" + "order_payment_obligations"."shipping_amount_cents" + "order_payment_obligations"."tax_amount_cents")
);
--> statement-breakpoint
CREATE TABLE "order_payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"obligation_id" uuid NOT NULL,
	"provider" "payment_provider" DEFAULT 'helcim' NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"originating_ip_ciphertext" text,
	"provider_type" text NOT NULL,
	"provider_status" text NOT NULL,
	"avs_code" text,
	"cvv_code" text,
	"risk_status" "payment_risk_status" DEFAULT 'pending' NOT NULL,
	"risk_reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payment_transactions_amount_check" CHECK ("order_payment_transactions"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_order_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"direction" "product_order_adjustment_direction" NOT NULL,
	"component" "product_order_adjustment_component" NOT NULL,
	"reason" text NOT NULL,
	"source_shipment_id" uuid,
	"source_case_id" uuid,
	"source_address_request_id" uuid,
	"amount_cents" integer NOT NULL,
	"status" "product_order_adjustment_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_adjustments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "product_order_adjustments_amount_check" CHECK ("product_order_adjustments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_payment_risk_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_transaction_id" uuid,
	"status" "payment_risk_status" DEFAULT 'review_required' NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_evidence" jsonb,
	"policy_version" text NOT NULL,
	"owner_admin_user_id" uuid,
	"step_up_authenticated_at" timestamp with time zone,
	"cooling_off_until" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"rationale" text,
	"outcome" text,
	"alerted_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_replacement_inventory_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"attested_by_admin_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_replacement_inventory_quantity_check" CHECK ("product_replacement_inventory_attestations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_shipment_return_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_return_id" text NOT NULL,
	"shipment_id" uuid,
	"case_id" uuid,
	"provider_status" text,
	"return_reason" text,
	"resolution" text,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_shipment_return_observations_provider_return_id_unique" UNIQUE("provider_return_id")
);
--> statement-breakpoint
CREATE TABLE "product_tax_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"coverage" jsonb NOT NULL,
	"owner_name" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"approved_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_tax_policy_versions_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" DROP CONSTRAINT "product_order_address_changes_distinct_approvers_check";--> statement-breakpoint
DROP INDEX "product_order_risk_reviews_order_reviewer_idx";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "payment_risk_status" "payment_risk_status" DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "payment_risk_assessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "payment_risk_source" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "tax_policy_version" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "ddu_notice_version" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "fulfillment_mode" "checkout_fulfillment_mode";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "manual_fulfillment_status" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "active_fulfillment_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "reconciliation_state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "attempt_identity" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "prepared_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "old_postage_outcome" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "supplemental_obligation_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "cleanup_outcome" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "customer_caused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "offer_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "phone_callback_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "cooling_off_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "owner_rationale" text;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "scope_key" text;--> statement-breakpoint
UPDATE "product_order_customer_decisions" SET "scope_key" = 'legacy/' || "id"::text WHERE "scope_key" IS NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ALTER COLUMN "scope_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "proposed_conditions" jsonb;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "payment_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "adjustment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "incident_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "cooling_off_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "provider_evidence_available" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "operation_payload_hash" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "outcome_code" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "provider_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_purchase_total_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_delivery_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_tariff_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_fda_prior_notification_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_federal_tax_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "actual_provincial_tax_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "pii_redaction_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN "source_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN "remedy_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD COLUMN "external_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD CONSTRAINT "customer_email_outbox_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD CONSTRAINT "order_payment_obligations_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment_transactions" ADD CONSTRAINT "order_payment_transactions_obligation_id_order_payment_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."order_payment_obligations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_adjustments" ADD CONSTRAINT "product_order_adjustments_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_adjustments" ADD CONSTRAINT "product_order_adjustments_source_shipment_id_product_shipments_id_fk" FOREIGN KEY ("source_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_adjustments" ADD CONSTRAINT "product_order_adjustments_source_case_id_product_shipping_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."product_shipping_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD CONSTRAINT "product_payment_risk_incidents_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD CONSTRAINT "product_payment_risk_incidents_payment_transaction_id_order_payment_transactions_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."order_payment_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD CONSTRAINT "product_payment_risk_incidents_owner_admin_user_id_admin_users_id_fk" FOREIGN KEY ("owner_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_replacement_inventory_attestations" ADD CONSTRAINT "product_replacement_inventory_attestations_case_id_product_shipping_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."product_shipping_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_replacement_inventory_attestations" ADD CONSTRAINT "product_replacement_inventory_attestations_attested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("attested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_return_observations_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_return_observations_case_id_product_shipping_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."product_shipping_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_email_outbox_claim_idx" ON "customer_email_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_policy_versions_one_effective_idx" ON "fulfillment_policy_versions" USING btree ("status") WHERE "fulfillment_policy_versions"."status" = 'effective';--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_provider_certifications_identity_idx" ON "fulfillment_provider_certifications" USING btree ("provider","environment","scope","version");--> statement-breakpoint
CREATE INDEX "order_payment_obligations_order_idx" ON "order_payment_obligations" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_transactions_provider_id_idx" ON "order_payment_transactions" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "order_payment_transactions_obligation_idx" ON "order_payment_transactions" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "product_order_adjustments_order_idx" ON "product_order_adjustments" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "product_payment_risk_incidents_queue_idx" ON "product_payment_risk_incidents" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_replacement_inventory_case_idx" ON "product_replacement_inventory_attestations" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "product_shipment_returns_shipment_idx" ON "product_shipment_return_observations" USING btree ("shipment_id","observed_at");--> statement-breakpoint
CREATE INDEX "product_tax_policy_versions_status_idx" ON "product_tax_policy_versions" USING btree ("status","effective_at");--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_active_fulfillment_shipment_id_product_shipments_id_fk" FOREIGN KEY ("active_fulfillment_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_prepared_shipment_id_product_shipments_id_fk" FOREIGN KEY ("prepared_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_supplemental_obligation_id_order_payment_obligations_id_fk" FOREIGN KEY ("supplemental_obligation_id") REFERENCES "public"."order_payment_obligations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_payment_transaction_id_order_payment_transactions_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."order_payment_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_adjustment_id_product_order_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."product_order_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD CONSTRAINT "product_order_risk_reviews_incident_id_product_payment_risk_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."product_payment_risk_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_source_shipment_id_product_shipments_id_fk" FOREIGN KEY ("source_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_remedy_shipment_id_product_shipments_id_fk" FOREIGN KEY ("remedy_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_customer_decisions_scope_idx" ON "product_order_customer_decisions" USING btree ("order_id","scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_refunds_provider_refund_id_idx" ON "product_order_refunds" USING btree ("provider_refund_id") WHERE "product_order_refunds"."provider_refund_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_risk_reviews_incident_action_idx" ON "product_order_risk_reviews" USING btree ("incident_id","decision");--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipping_cases_one_active_idx" ON "product_shipping_cases" USING btree ("order_id","shipment_id","type") WHERE "product_shipping_cases"."status" IN ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending');--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_actual_costs_nonnegative_check" CHECK (coalesce("product_shipments"."actual_purchase_total_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_postage_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_insurance_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_delivery_fee_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_tariff_fee_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_fda_prior_notification_fee_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_federal_tax_cents", 0) >= 0
        AND coalesce("product_shipments"."actual_provincial_tax_cents", 0) >= 0);--> statement-breakpoint
UPDATE "checkout_orders"
SET "payment_risk_status" = CASE
  WHEN "purpose" <> 'product' OR "status" IN ('cancelled', 'refunded') THEN 'not_required'::"payment_risk_status"
  WHEN "status" IN ('pending', 'verification_failed') THEN 'pending'::"payment_risk_status"
  ELSE 'review_required'::"payment_risk_status"
END,
"payment_risk_source" = CASE
  WHEN "purpose" = 'product' AND "status" = 'paid' THEN 'legacy_backfill'
  ELSE NULL
END;--> statement-breakpoint
INSERT INTO "fulfillment_policy_versions" (
  "version",
  "status",
  "owner_name",
  "policy_snapshot",
  "privacy_legal_attested_at",
  "security_attested_at",
  "operations_attested_at",
  "effective_at"
) VALUES (
  'P-01-P-11-owner-only-2026-08-14',
  'effective',
  'Nataliea Lavoie',
  '{"basePolicies":["P-01","P-02","P-03","P-04","P-05","P-06","P-07","P-08","P-09","P-10","P-11"],"reviewModel":"enhanced_owner_only","stepUpAuthenticationRequired":true,"coolingOffMinutes":15,"highRiskAddressPhoneCallbackRequired":true,"unknownAvsCvvBlocksFulfillment":true,"riskAlertBusinessHours":2,"multipleWaitExtensionsAllowed":true,"customerAddressSupplementExemptFromP02":true,"p10WarningDays":[335,350],"p10HardCapDays":365,"usImportTerms":"DDU","dduAcknowledgement":"informational_notice","productTaxPolicyRequired":true}'::jsonb,
  now(),
  now(),
  now(),
  now()
) ON CONFLICT ("version") DO NOTHING;
