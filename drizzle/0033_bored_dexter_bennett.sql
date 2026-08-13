CREATE TYPE "public"."product_order_address_change_status" AS ENUM('pending_customer', 'submitted', 'risk_review', 'approved', 'applied', 'rejected', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."product_order_customer_decision_status" AS ENUM('pending', 'selected', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."product_order_refund_status" AS ENUM('queued', 'processing', 'succeeded', 'failed', 'outcome_unknown', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."product_shipment_purpose" AS ENUM('original', 'replacement', 'reshipment');--> statement-breakpoint
CREATE TYPE "public"."product_shipping_case_status" AS ENUM('open', 'waiting_customer', 'waiting_provider', 'remedy_pending', 'resolved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."product_shipping_case_type" AS ENUM('postage_failure', 'delay', 'loss', 'damage', 'refused', 'unclaimed', 'return_to_sender', 'claim');--> statement-breakpoint
CREATE TYPE "public"."shipping_calendar_exception_kind" AS ENUM('ontario_holiday', 'branch_closure');--> statement-breakpoint
CREATE TYPE "public"."shipping_funding_review_status" AS ENUM('recorded', 'recommended', 'approved', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."shipping_policy_duty" AS ENUM('operations_lead', 'finance_owner', 'payment_fraud_owner', 'privacy_owner');--> statement-breakpoint
CREATE TABLE "product_order_address_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shipment_id" uuid,
	"status" "product_order_address_change_status" DEFAULT 'pending_customer' NOT NULL,
	"original_address" jsonb NOT NULL,
	"proposed_address" jsonb,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"first_approved_by_admin_user_id" uuid,
	"first_approved_at" timestamp with time zone,
	"second_approved_by_admin_user_id" uuid,
	"second_approved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"postage_difference_cents" integer,
	"provider_reconciliation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "product_order_address_change_requests_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "product_order_address_changes_distinct_approvers_check" CHECK ("product_order_address_change_requests"."second_approved_by_admin_user_id" IS NULL OR "product_order_address_change_requests"."first_approved_by_admin_user_id" IS NULL OR "product_order_address_change_requests"."second_approved_by_admin_user_id" <> "product_order_address_change_requests"."first_approved_by_admin_user_id")
);
--> statement-breakpoint
CREATE TABLE "product_order_customer_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"case_id" uuid,
	"kind" text NOT NULL,
	"allowed_outcomes" jsonb NOT NULL,
	"selected_outcome" text,
	"token_hash" text NOT NULL,
	"status" "product_order_customer_decision_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"selected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "product_order_customer_decisions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "product_order_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"case_id" uuid,
	"idempotency_key" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"original_transaction_id" text NOT NULL,
	"status" "product_order_refund_status" DEFAULT 'queued' NOT NULL,
	"provider_refund_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_attempted_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"unknown_outcome_at" timestamp with time zone,
	"last_error_code" text,
	"requested_by_admin_user_id" uuid,
	"automated" boolean DEFAULT false NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "product_order_refunds_amount_check" CHECK ("product_order_refunds"."amount_cents" > 0),
	CONSTRAINT "product_order_refunds_kind_check" CHECK ("product_order_refunds"."kind" IN ('full', 'partial'))
);
--> statement-breakpoint
CREATE TABLE "product_order_risk_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"reviewer_admin_user_id" uuid NOT NULL,
	"reviewer_was_business_owner" boolean DEFAULT false NOT NULL,
	"decision" text NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_order_risk_reviews_decision_check" CHECK ("product_order_risk_reviews"."decision" IN ('clear_false_positive', 'escalate')),
	CONSTRAINT "product_order_risk_reviews_rationale_check" CHECK (length(trim("product_order_risk_reviews"."rationale")) >= 10)
);
--> statement-breakpoint
CREATE TABLE "product_shipping_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shipment_id" uuid,
	"type" "product_shipping_case_type" NOT NULL,
	"status" "product_shipping_case_status" DEFAULT 'open' NOT NULL,
	"cause" text,
	"provider_claim_reference" text,
	"evidence_checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eligible_at" timestamp with time zone,
	"carrier_deadline_at" timestamp with time zone,
	"customer_update_due_at" timestamp with time zone,
	"remedy_deadline_at" timestamp with time zone,
	"remedy_choice" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shipping_calendar_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exception_date" date NOT NULL,
	"kind" "shipping_calendar_exception_kind" NOT NULL,
	"label" text NOT NULL,
	"created_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_funding_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" "shipping_funding_review_status" DEFAULT 'recorded' NOT NULL,
	"balance_cents" integer,
	"reload_threshold_cents" integer,
	"reload_amount_cents" integer,
	"top_up_amount_cents" integer,
	"calculated_two_business_day_spend_cents" integer,
	"calculated_five_business_day_spend_cents" integer,
	"notes" text,
	"recorded_by_admin_user_id" uuid,
	"finance_approved_by_admin_user_id" uuid,
	"business_owner_approved_by_admin_user_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_funding_reviews_kind_check" CHECK ("shipping_funding_reviews"."kind" IN ('balance_check', 'reload', 'emergency_top_up', 'thirty_day_review'))
);
--> statement-breakpoint
CREATE TABLE "shipping_policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"duty" "shipping_policy_duty" NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"assigned_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_policy_settings" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"order_cutoff" time DEFAULT '14:00:00' NOT NULL,
	"coverage_starts_at" time DEFAULT '09:00:00' NOT NULL,
	"coverage_ends_at" time DEFAULT '17:00:00' NOT NULL,
	"before_cutoff_handoff_business_days" integer DEFAULT 1 NOT NULL,
	"after_cutoff_handoff_business_days" integer DEFAULT 2 NOT NULL,
	"auto_refund_business_days" integer DEFAULT 2 NOT NULL,
	"manual_review_alert_coverage_hours" integer DEFAULT 2 NOT NULL,
	"manual_review_escalation_coverage_hours" integer DEFAULT 4 NOT NULL,
	"signature_threshold_cents" integer DEFAULT 50000 NOT NULL,
	"address_review_threshold_cents" integer DEFAULT 15000 NOT NULL,
	"funding_reload_threshold_cents" integer DEFAULT 2500 NOT NULL,
	"funding_reload_amount_cents" integer DEFAULT 10000 NOT NULL,
	"funding_maximum_balance_cents" integer DEFAULT 50000 NOT NULL,
	"funding_rolling_day_limit_cents" integer DEFAULT 75000 NOT NULL,
	"funding_monthly_limit_cents" integer DEFAULT 150000 NOT NULL,
	"funding_emergency_top_up_cents" integer DEFAULT 25000 NOT NULL,
	"pilot_started_at" timestamp with time zone,
	"policy_version" text DEFAULT '2026-08-13' NOT NULL,
	"forwarder_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_policy_settings_singleton_check" CHECK ("shipping_policy_settings"."singleton_key" = 'default'),
	CONSTRAINT "shipping_policy_settings_coverage_check" CHECK ("shipping_policy_settings"."coverage_ends_at" > "shipping_policy_settings"."coverage_starts_at"),
	CONSTRAINT "shipping_policy_settings_limits_check" CHECK ("shipping_policy_settings"."signature_threshold_cents" > 0 AND "shipping_policy_settings"."address_review_threshold_cents" > 0 AND "shipping_policy_settings"."funding_reload_threshold_cents" > 0 AND "shipping_policy_settings"."funding_reload_amount_cents" > 0 AND "shipping_policy_settings"."funding_maximum_balance_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipping_service_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"postage_type" text NOT NULL,
	"destination_country_code" text NOT NULL,
	"tracking_required" boolean DEFAULT true NOT NULL,
	"insurance_limit_cents" integer NOT NULL,
	"signature_capable" boolean DEFAULT false NOT NULL,
	"claim_waiting_days" integer NOT NULL,
	"claim_deadline_days" integer NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_service_policies_country_check" CHECK ("shipping_service_policies"."destination_country_code" IN ('CA', 'US')),
	CONSTRAINT "shipping_service_policies_values_check" CHECK ("shipping_service_policies"."insurance_limit_cents" > 0 AND "shipping_service_policies"."claim_waiting_days" >= 0 AND "shipping_service_policies"."claim_deadline_days" > "shipping_service_policies"."claim_waiting_days")
);
--> statement-breakpoint
DROP INDEX "product_shipments_order_id_idx";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "refund_origin_ip_ciphertext" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "at_risk_value_cents" integer;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "fraud_classification" text DEFAULT 'low' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "fraud_risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "fulfillment_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "fraud_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "shipping_policy_version" text;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "purpose" "product_shipment_purpose" DEFAULT 'original' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "supersedes_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "original_handoff_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "auto_refund_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "customer_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "latest_estimated_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "delivery_max_business_days" integer;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "last_carrier_movement_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "signature_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "signature_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "privacy_terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_first_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("first_approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_address_change_requests" ADD CONSTRAINT "product_order_address_change_requests_second_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("second_approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_case_id_product_shipping_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."product_shipping_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_case_id_product_shipping_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."product_shipping_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_requested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD CONSTRAINT "product_order_risk_reviews_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_risk_reviews" ADD CONSTRAINT "product_order_risk_reviews_reviewer_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewer_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD CONSTRAINT "product_shipping_cases_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_calendar_exceptions" ADD CONSTRAINT "shipping_calendar_exceptions_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD CONSTRAINT "shipping_funding_reviews_recorded_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("recorded_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD CONSTRAINT "shipping_funding_reviews_finance_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("finance_approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_funding_reviews" ADD CONSTRAINT "shipping_funding_reviews_business_owner_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("business_owner_approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_policy_assignments" ADD CONSTRAINT "shipping_policy_assignments_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_policy_assignments" ADD CONSTRAINT "shipping_policy_assignments_assigned_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("assigned_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_order_address_changes_order_idx" ON "product_order_address_change_requests" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "product_order_address_changes_deadline_idx" ON "product_order_address_change_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "product_order_customer_decisions_deadline_idx" ON "product_order_customer_decisions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "product_order_customer_decisions_order_idx" ON "product_order_customer_decisions" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "product_order_refunds_queue_idx" ON "product_order_refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "product_order_refunds_order_idx" ON "product_order_refunds" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_risk_reviews_order_reviewer_idx" ON "product_order_risk_reviews" USING btree ("order_id","reviewer_admin_user_id");--> statement-breakpoint
CREATE INDEX "product_shipping_cases_queue_idx" ON "product_shipping_cases" USING btree ("status","customer_update_due_at","carrier_deadline_at");--> statement-breakpoint
CREATE INDEX "product_shipping_cases_order_idx" ON "product_shipping_cases" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_calendar_exceptions_date_kind_idx" ON "shipping_calendar_exceptions" USING btree ("exception_date","kind");--> statement-breakpoint
CREATE INDEX "shipping_funding_reviews_kind_created_idx" ON "shipping_funding_reviews" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_policy_assignments_active_duty_idx" ON "shipping_policy_assignments" USING btree ("duty") WHERE "shipping_policy_assignments"."active" = true;--> statement-breakpoint
CREATE INDEX "shipping_policy_assignments_user_idx" ON "shipping_policy_assignments" USING btree ("admin_user_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_service_policies_type_destination_idx" ON "shipping_service_policies" USING btree ("postage_type","destination_country_code");--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_supersedes_shipment_id_product_shipments_id_fk" FOREIGN KEY ("supersedes_shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipments_order_sequence_idx" ON "product_shipments" USING btree ("order_id","sequence");--> statement-breakpoint
INSERT INTO "shipping_policy_settings" ("singleton_key") VALUES ('default') ON CONFLICT ("singleton_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "shipping_calendar_exceptions" ("exception_date", "kind", "label") VALUES
('2026-09-07', 'ontario_holiday', 'Labour Day'),
('2026-10-12', 'ontario_holiday', 'Thanksgiving Day'),
('2026-12-25', 'ontario_holiday', 'Christmas Day'),
('2026-12-26', 'ontario_holiday', 'Boxing Day'),
('2027-01-01', 'ontario_holiday', 'New Year''s Day'),
('2027-02-15', 'ontario_holiday', 'Family Day'),
('2027-03-26', 'ontario_holiday', 'Good Friday'),
('2027-05-24', 'ontario_holiday', 'Victoria Day'),
('2027-07-01', 'ontario_holiday', 'Canada Day'),
('2027-09-06', 'ontario_holiday', 'Labour Day'),
('2027-10-11', 'ontario_holiday', 'Thanksgiving Day'),
('2027-12-25', 'ontario_holiday', 'Christmas Day'),
('2027-12-26', 'ontario_holiday', 'Boxing Day'),
('2028-01-01', 'ontario_holiday', 'New Year''s Day'),
('2028-02-21', 'ontario_holiday', 'Family Day'),
('2028-04-14', 'ontario_holiday', 'Good Friday'),
('2028-05-22', 'ontario_holiday', 'Victoria Day'),
('2028-07-01', 'ontario_holiday', 'Canada Day'),
('2028-09-04', 'ontario_holiday', 'Labour Day'),
('2028-10-09', 'ontario_holiday', 'Thanksgiving Day'),
('2028-12-25', 'ontario_holiday', 'Christmas Day'),
('2028-12-26', 'ontario_holiday', 'Boxing Day')
ON CONFLICT ("exception_date", "kind") DO NOTHING;
