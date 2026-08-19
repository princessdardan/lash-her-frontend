CREATE TYPE "public"."chitchats_intake_location_type" AS ENUM('branch', 'drop_spot', 'mail_in_hub');--> statement-breakpoint
CREATE TYPE "public"."chitchats_region" AS ENUM('british_columbia', 'alberta_saskatchewan', 'ontario_manitoba', 'quebec', 'atlantic');--> statement-breakpoint
ALTER TYPE "public"."product_shipment_job_type" ADD VALUE 'delete' BEFORE 'tracking';--> statement-breakpoint
CREATE TABLE "chitchats_intake_location_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_environment" text NOT NULL,
	"provider_client_id" text NOT NULL,
	"region" "chitchats_region" NOT NULL,
	"location_name" text NOT NULL,
	"location_address" text NOT NULL,
	"location_type" "chitchats_intake_location_type" NOT NULL,
	"evidence_reference" text NOT NULL,
	"rationale" text NOT NULL,
	"statement_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"attested_by_admin_user_id" uuid NOT NULL,
	"attested_by_owner_name" text NOT NULL,
	"step_up_authenticated_at" timestamp with time zone NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_admin_user_id" uuid,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chitchats_intake_locations_environment_check" CHECK ("chitchats_intake_location_attestations"."provider_environment" IN ('staging', 'production')),
	CONSTRAINT "chitchats_intake_locations_required_text_check" CHECK (length(trim("chitchats_intake_location_attestations"."provider_client_id")) > 0
        AND length(trim("chitchats_intake_location_attestations"."location_name")) > 0
        AND length(trim("chitchats_intake_location_attestations"."location_address")) > 0
        AND length(trim("chitchats_intake_location_attestations"."evidence_reference")) > 0
        AND length(trim("chitchats_intake_location_attestations"."statement_version")) > 0
        AND length(trim("chitchats_intake_location_attestations"."attested_by_owner_name")) > 0),
	CONSTRAINT "chitchats_intake_locations_rationale_check" CHECK (length(trim("chitchats_intake_location_attestations"."rationale")) >= 10),
	CONSTRAINT "chitchats_intake_locations_step_up_check" CHECK ("chitchats_intake_location_attestations"."step_up_authenticated_at" <= "chitchats_intake_location_attestations"."attested_at"
        AND "chitchats_intake_location_attestations"."step_up_authenticated_at" >= "chitchats_intake_location_attestations"."attested_at" - interval '5 minutes'),
	CONSTRAINT "chitchats_intake_locations_validity_check" CHECK ("chitchats_intake_location_attestations"."valid_until" > "chitchats_intake_location_attestations"."attested_at"
        AND "chitchats_intake_location_attestations"."valid_until" <= "chitchats_intake_location_attestations"."attested_at" + interval '90 days'),
	CONSTRAINT "chitchats_intake_locations_revocation_check" CHECK ((
          "chitchats_intake_location_attestations"."revoked_at" IS NULL
          AND "chitchats_intake_location_attestations"."revoked_by_admin_user_id" IS NULL
          AND "chitchats_intake_location_attestations"."revocation_reason" IS NULL
        ) OR (
          "chitchats_intake_location_attestations"."revoked_at" >= "chitchats_intake_location_attestations"."attested_at"
          AND "chitchats_intake_location_attestations"."revoked_by_admin_user_id" IS NOT NULL
          AND length(trim("chitchats_intake_location_attestations"."revocation_reason")) >= 10
        ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fulfillment_data_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_data_quarantine_status_check" CHECK ("fulfillment_data_quarantine"."status" IN ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "product_manual_fulfillment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text NOT NULL,
	"actor_admin_user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_manual_fulfillment_events_status_check" CHECK ("product_manual_fulfillment_events"."status" IN ('payment_pending', 'paid_pending_dispatch', 'dispatched', 'cancelled')),
	CONSTRAINT "product_manual_fulfillment_events_method_check" CHECK ("product_manual_fulfillment_events"."method" IN ('manual_shipping', 'pickup_handoff')),
	CONSTRAINT "product_manual_fulfillment_events_rationale_check" CHECK (length(trim("product_manual_fulfillment_events"."rationale")) >= 10)
);
--> statement-breakpoint
CREATE TABLE "shipping_calendar_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"coverage_starts_on" date NOT NULL,
	"coverage_ends_on" date NOT NULL,
	"closure_dates" jsonb NOT NULL,
	"evidence_reference" text,
	"attested_by_admin_user_id" uuid,
	"attested_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_calendar_versions_version_unique" UNIQUE("version"),
	CONSTRAINT "shipping_calendar_versions_status_check" CHECK ("shipping_calendar_versions"."status" IN ('draft', 'effective', 'superseded')),
	CONSTRAINT "shipping_calendar_versions_coverage_check" CHECK ("shipping_calendar_versions"."coverage_ends_on" >= "shipping_calendar_versions"."coverage_starts_on"),
	CONSTRAINT "shipping_calendar_versions_effective_evidence_check" CHECK ("shipping_calendar_versions"."status" <> 'effective' OR ("shipping_calendar_versions"."effective_at" IS NOT NULL AND "shipping_calendar_versions"."attested_at" IS NOT NULL AND "shipping_calendar_versions"."attested_by_admin_user_id" IS NOT NULL AND length(trim("shipping_calendar_versions"."evidence_reference")) > 0 AND "shipping_calendar_versions"."superseded_at" IS NULL))
);
--> statement-breakpoint
DROP INDEX "product_replacement_inventory_case_idx";--> statement-breakpoint
DROP INDEX "product_order_customer_decisions_scope_idx";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "cancellation_policy_version" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "cancellation_policy_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "cancellation_policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "ddu_notice_presented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "ddu_notice_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillment_policy_versions" ADD COLUMN "attestation_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "fulfillment_policy_versions" ADD COLUMN "attested_by_admin_user_id" uuid;--> statement-breakpoint
UPDATE "fulfillment_policy_versions"
SET
	"status" = 'draft',
	"privacy_legal_attested_at" = NULL,
	"security_attested_at" = NULL,
	"operations_attested_at" = NULL,
	"effective_at" = NULL,
	"superseded_at" = NULL
WHERE "status" = 'effective'
	AND (
		"attested_by_admin_user_id" IS NULL
		OR coalesce(length(trim("attestation_evidence_reference")), 0) = 0
	);--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "payment_provider" "payment_provider" DEFAULT 'helcim' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "provider_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "provider_invoice_number" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "provider_checkout_id" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "checkout_token_hash" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "secret_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_status" "checkout_initialization_status" DEFAULT 'initializing' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "risk_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "lease_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "expected_source_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "expected_source_shipment_state_version" integer;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "prepared_shipment_state_version" integer;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "adoption_outcome" text;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD COLUMN "callback_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "scope_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "supersedes_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "wait_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "lease_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "provider_shipment_id" text;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "match_status" text DEFAULT 'unmatched' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "raw_payload" jsonb;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "purchase_variance_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "provider_cost_currency" text DEFAULT 'CAD' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "calendar_version_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "deadline_policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD COLUMN "forecast_review_id" uuid;--> statement-breakpoint
ALTER TABLE "chitchats_intake_location_attestations" ADD CONSTRAINT "chitchats_intake_location_attestations_policy_version_fulfillment_policy_versions_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."fulfillment_policy_versions"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chitchats_intake_location_attestations" ADD CONSTRAINT "chitchats_intake_location_attestations_attested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("attested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chitchats_intake_location_attestations" ADD CONSTRAINT "chitchats_intake_location_attestations_revoked_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("revoked_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_manual_fulfillment_events" ADD CONSTRAINT "product_manual_fulfillment_events_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_manual_fulfillment_events" ADD CONSTRAINT "product_manual_fulfillment_events_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_calendar_versions" ADD CONSTRAINT "shipping_calendar_versions_attested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("attested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chitchats_intake_locations_one_active_environment_idx" ON "chitchats_intake_location_attestations" USING btree ("provider_environment") WHERE "chitchats_intake_location_attestations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "chitchats_intake_locations_readiness_idx" ON "chitchats_intake_location_attestations" USING btree ("provider_environment","provider_client_id","region","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_data_quarantine_identity_idx" ON "fulfillment_data_quarantine" USING btree ("entity_type","entity_id","reason_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillment_data_quarantine_queue_idx" ON "fulfillment_data_quarantine" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "product_manual_fulfillment_events_order_idx" ON "product_manual_fulfillment_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_calendar_versions_one_effective_idx" ON "shipping_calendar_versions" USING btree ("status") WHERE "shipping_calendar_versions"."status" = 'effective';--> statement-breakpoint
ALTER TABLE "fulfillment_policy_versions" ADD CONSTRAINT "fulfillment_policy_versions_attested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("attested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_risk_incident_id_product_payment_risk_incidents_id_fk" FOREIGN KEY ("risk_incident_id") REFERENCES "public"."product_payment_risk_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_expected_source_shipment_id_product_shipments_id_fk" FOREIGN KEY ("expected_source_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_supersedes_decision_id_product_order_customer_decisions_id_fk" FOREIGN KEY ("supersedes_decision_id") REFERENCES "public"."product_order_customer_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_calendar_version_id_shipping_calendar_versions_id_fk" FOREIGN KEY ("calendar_version_id") REFERENCES "public"."shipping_calendar_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD CONSTRAINT "shipping_funding_reviews_forecast_review_id_shipping_funding_reviews_id_fk" FOREIGN KEY ("forecast_review_id") REFERENCES "public"."shipping_funding_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "order_payment_obligations" obligation
SET
	"payment_provider" = orders."payment_provider",
	"provider_invoice_id" = orders."helcim_invoice_id",
	"provider_invoice_number" = orders."helcim_invoice_number",
	"provider_checkout_id" = orders."provider_checkout_id",
	"checkout_token_hash" = orders."checkout_token_hash",
	"secret_token_ciphertext" = orders."secret_token_ciphertext",
	"initialization_status" = orders."initialization_status",
	"updated_at" = now()
FROM "checkout_orders" orders
WHERE obligation."order_id" = orders."id"
	AND obligation."purpose" = 'primary';--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'order_payment_obligation',
	obligation."id"::text,
	'duplicate_primary_obligation',
	jsonb_build_object(
		'obligation_id', obligation."id",
		'order_id', obligation."order_id",
		'purpose', obligation."purpose",
		'status', obligation."status",
		'merchandise_amount_cents', obligation."merchandise_amount_cents",
		'shipping_amount_cents', obligation."shipping_amount_cents",
		'tax_amount_cents', obligation."tax_amount_cents",
		'total_amount_cents', obligation."total_amount_cents",
		'currency', obligation."currency",
		'source_workflow', obligation."source_workflow",
		'source_reference_id', obligation."source_reference_id",
		'tax_policy_version', obligation."tax_policy_version",
		'policy_version', obligation."policy_version",
		'quote_version', obligation."quote_version",
		'expires_at', obligation."expires_at",
		'idempotency_key', obligation."idempotency_key",
		'payment_provider', obligation."payment_provider",
		'provider_invoice_id', obligation."provider_invoice_id",
		'provider_invoice_number', obligation."provider_invoice_number",
		'provider_checkout_id', obligation."provider_checkout_id",
		'initialization_status', obligation."initialization_status",
		'paid_at', obligation."paid_at",
		'created_at', obligation."created_at",
		'updated_at', obligation."updated_at"
	)
FROM "order_payment_obligations" obligation
WHERE obligation."purpose" = 'primary'
	AND EXISTS (
		SELECT 1
		FROM "order_payment_obligations" duplicate
		WHERE duplicate."order_id" = obligation."order_id"
			AND duplicate."purpose" = 'primary'
			AND duplicate."id" <> obligation."id"
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "order_payment_obligations" obligation
SET
	"quarantined_at" = now(),
	"quarantine_reason" = 'duplicate_primary_obligation'
WHERE obligation."purpose" = 'primary'
	AND EXISTS (
		SELECT 1
		FROM "fulfillment_data_quarantine" quarantine
		WHERE quarantine."entity_type" = 'order_payment_obligation'
			AND quarantine."entity_id" = obligation."id"::text
			AND quarantine."reason_code" = 'duplicate_primary_obligation'
	);--> statement-breakpoint
INSERT INTO "order_payment_obligations" (
	"order_id",
	"purpose",
	"status",
	"merchandise_amount_cents",
	"shipping_amount_cents",
	"tax_amount_cents",
	"total_amount_cents",
	"currency",
	"payment_provider",
	"provider_invoice_id",
	"provider_invoice_number",
	"provider_checkout_id",
	"checkout_token_hash",
	"secret_token_ciphertext",
	"initialization_status",
	"source_workflow",
	"tax_policy_version",
	"policy_version",
	"idempotency_key",
	"paid_at"
)
SELECT
	orders."id",
	'primary',
	CASE WHEN orders."status" = 'paid' THEN 'paid'::"order_payment_obligation_status" ELSE 'pending'::"order_payment_obligation_status" END,
	orders."merchandise_amount_cents",
	orders."shipping_amount_cents",
	orders."tax_amount_cents",
	orders."amount_cents",
	orders."currency",
	orders."payment_provider",
	orders."helcim_invoice_id",
	orders."helcim_invoice_number",
	orders."provider_checkout_id",
	orders."checkout_token_hash",
	orders."secret_token_ciphertext",
	orders."initialization_status",
	'legacy_authoritative_backfill',
	orders."tax_policy_version",
	orders."shipping_policy_version",
	'legacy-primary/' || orders."id"::text,
	CASE WHEN orders."status" = 'paid' THEN orders."paid_at" ELSE NULL END
FROM "checkout_orders" orders
WHERE orders."purpose" = 'product'
	AND orders."merchandise_amount_cents" IS NOT NULL
	AND orders."tax_policy_version" IS NOT NULL
	AND orders."shipping_policy_version" IS NOT NULL
	AND orders."amount_cents" = orders."merchandise_amount_cents" + orders."shipping_amount_cents" + orders."tax_amount_cents"
	AND NOT EXISTS (
		SELECT 1
		FROM "order_payment_obligations" existing
		WHERE existing."order_id" = orders."id"
			AND existing."purpose" = 'primary'
			AND existing."quarantined_at" IS NULL
	)
ON CONFLICT ("idempotency_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'checkout_order',
	orders."id"::text,
	'primary_obligation_backfill_ambiguous',
	jsonb_build_object(
		'checkout_order_id', orders."id",
		'order_id', orders."order_id",
		'payment_provider', orders."payment_provider",
		'provider_transaction_id', orders."helcim_transaction_id",
		'provider_invoice_id', orders."helcim_invoice_id",
		'provider_invoice_number', orders."helcim_invoice_number",
		'provider_checkout_id', orders."provider_checkout_id",
		'status', orders."status",
		'purpose', orders."purpose",
		'initialization_status', orders."initialization_status",
		'amount_cents', orders."amount_cents",
		'merchandise_amount_cents', orders."merchandise_amount_cents",
		'shipping_amount_cents', orders."shipping_amount_cents",
		'tax_amount_cents', orders."tax_amount_cents",
		'currency', orders."currency",
		'tax_policy_version', orders."tax_policy_version",
		'policy_version', orders."shipping_policy_version",
		'created_at', orders."created_at",
		'paid_at', orders."paid_at",
		'redacted_at', orders."redacted_at"
	)
FROM "checkout_orders" orders
WHERE orders."purpose" = 'product'
	AND NOT EXISTS (
		SELECT 1
		FROM "order_payment_obligations" existing
		WHERE existing."order_id" = orders."id"
			AND existing."purpose" = 'primary'
			AND existing."quarantined_at" IS NULL
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_one_primary_idx" ON "order_payment_obligations" USING btree ("order_id") WHERE "order_payment_obligations"."purpose" = 'primary' AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_provider_invoice_idx" ON "order_payment_obligations" USING btree ("payment_provider","provider_invoice_id") WHERE "order_payment_obligations"."provider_invoice_id" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_provider_checkout_idx" ON "order_payment_obligations" USING btree ("payment_provider","provider_checkout_id") WHERE "order_payment_obligations"."provider_checkout_id" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_checkout_token_idx" ON "order_payment_obligations" USING btree ("checkout_token_hash") WHERE "order_payment_obligations"."checkout_token_hash" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_replacement_inventory_line_idx" ON "product_replacement_inventory_attestations" USING btree ("case_id","product_id",coalesce("variant_id", ''),"sku");--> statement-breakpoint
CREATE INDEX "product_shipment_returns_unmatched_idx" ON "product_shipment_return_observations" USING btree ("match_status","observed_at") WHERE "product_shipment_return_observations"."shipment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_customer_decisions_scope_idx" ON "product_order_customer_decisions" USING btree ("order_id","scope_key","scope_version");--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_manual_fulfillment_status_check" CHECK ("checkout_orders"."manual_fulfillment_status" IS NULL OR "checkout_orders"."manual_fulfillment_status" IN ('payment_pending', 'paid_pending_dispatch', 'dispatched', 'cancelled'));--> statement-breakpoint
ALTER TABLE "fulfillment_policy_versions" ADD CONSTRAINT "fulfillment_policy_versions_status_check" CHECK ("fulfillment_policy_versions"."status" IN ('draft', 'effective', 'superseded'));--> statement-breakpoint
ALTER TABLE "fulfillment_policy_versions" ADD CONSTRAINT "fulfillment_policy_versions_effective_evidence_check" CHECK ("fulfillment_policy_versions"."status" <> 'effective' OR ("fulfillment_policy_versions"."effective_at" IS NOT NULL AND "fulfillment_policy_versions"."privacy_legal_attested_at" IS NOT NULL AND "fulfillment_policy_versions"."security_attested_at" IS NOT NULL AND "fulfillment_policy_versions"."operations_attested_at" IS NOT NULL AND "fulfillment_policy_versions"."attested_by_admin_user_id" IS NOT NULL AND length(trim("fulfillment_policy_versions"."attestation_evidence_reference")) > 0 AND "fulfillment_policy_versions"."superseded_at" IS NULL));--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD CONSTRAINT "order_payment_obligations_quarantine_check" CHECK (("order_payment_obligations"."quarantined_at" IS NULL AND "order_payment_obligations"."quarantine_reason" IS NULL) OR ("order_payment_obligations"."quarantined_at" IS NOT NULL AND length(trim("order_payment_obligations"."quarantine_reason")) > 0));--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_returns_match_status_check" CHECK ("product_shipment_return_observations"."match_status" IN ('unmatched', 'matched', 'manual_review'));
