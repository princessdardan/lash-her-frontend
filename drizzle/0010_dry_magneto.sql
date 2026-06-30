CREATE TYPE "public"."no_show_charge_status" AS ENUM('draft', 'ready', 'provider_draft_created', 'admin_review', 'charge_pending', 'charged', 'charge_failed', 'voided', 'expired', 'manual_followup');--> statement-breakpoint
CREATE TYPE "public"."saved_payment_method_status" AS ENUM('active', 'replaced', 'disabled', 'deleted', 'charge_failed');--> statement-breakpoint
CREATE TABLE "booking_no_show_charge_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no_show_charge_record_id" uuid NOT NULL,
	"idempotency_key" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"status" text,
	"square_payment_id" text,
	"square_invoice_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "booking_no_show_charge_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "booking_no_show_charge_attempts_square_payment_id_unique" UNIQUE("square_payment_id")
);
--> statement-breakpoint
CREATE TABLE "booking_no_show_charge_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"saved_payment_method_id" uuid,
	"policy_acceptance_id" uuid,
	"square_customer_id" text,
	"square_card_id" text,
	"max_charge_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"square_invoice_id" text,
	"square_order_id" text,
	"square_payment_id" text,
	"status" "no_show_charge_status" DEFAULT 'draft' NOT NULL,
	"provider_status" text,
	"provider_failure_reason" text,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"charged_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"admin_action_at" timestamp with time zone,
	CONSTRAINT "booking_no_show_charge_records_square_invoice_id_unique" UNIQUE("square_invoice_id"),
	CONSTRAINT "booking_no_show_charge_records_square_order_id_unique" UNIQUE("square_order_id"),
	CONSTRAINT "booking_no_show_charge_records_square_payment_id_unique" UNIQUE("square_payment_id")
);
--> statement-breakpoint
CREATE TABLE "booking_policy_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL,
	"policy_type" text NOT NULL,
	"policy_version" text,
	"policy_text_hash" text,
	"policy_document_id" text,
	"accepted_at" timestamp with time zone NOT NULL,
	"max_charge_cents" integer,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"ip_hash" text,
	"user_agent_hash" text,
	"customer_email" text,
	"customer_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_saved_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"square_card_id" text NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"billing_postal_code" text,
	"status" "saved_payment_method_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "booking_saved_payment_methods_square_card_id_unique" UNIQUE("square_card_id")
);
--> statement-breakpoint
CREATE TABLE "booking_square_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_normalized" text NOT NULL,
	"customer_name" text NOT NULL,
	"phone_normalized" text,
	"square_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "booking_square_customers_email_normalized_unique" UNIQUE("email_normalized"),
	CONSTRAINT "booking_square_customers_square_customer_id_unique" UNIQUE("square_customer_id")
);
--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "saved_payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "policy_acceptance_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "no_show_charge_record_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_customer_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_card_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "card_on_file_status" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "no_show_invoice_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "no_show_invoice_order_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "no_show_invoice_status" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "no_show_charge_record_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_attempts" ADD CONSTRAINT "booking_no_show_charge_attempts_no_show_charge_record_id_booking_no_show_charge_records_id_fk" FOREIGN KEY ("no_show_charge_record_id") REFERENCES "public"."booking_no_show_charge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD CONSTRAINT "booking_no_show_charge_records_hold_id_appointment_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."appointment_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD CONSTRAINT "booking_no_show_charge_records_saved_payment_method_id_booking_saved_payment_methods_id_fk" FOREIGN KEY ("saved_payment_method_id") REFERENCES "public"."booking_saved_payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD CONSTRAINT "booking_no_show_charge_records_policy_acceptance_id_booking_policy_acceptances_id_fk" FOREIGN KEY ("policy_acceptance_id") REFERENCES "public"."booking_policy_acceptances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_policy_acceptances" ADD CONSTRAINT "booking_policy_acceptances_hold_id_appointment_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."appointment_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_saved_payment_methods" ADD CONSTRAINT "booking_saved_payment_methods_customer_id_booking_square_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."booking_square_customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_attempts_idempotency_key_idx" ON "booking_no_show_charge_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_attempts_square_payment_id_idx" ON "booking_no_show_charge_attempts" USING btree ("square_payment_id");--> statement-breakpoint
CREATE INDEX "booking_no_show_charge_attempts_record_id_idx" ON "booking_no_show_charge_attempts" USING btree ("no_show_charge_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_records_hold_id_idx" ON "booking_no_show_charge_records" USING btree ("hold_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_records_square_invoice_id_idx" ON "booking_no_show_charge_records" USING btree ("square_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_records_square_payment_id_idx" ON "booking_no_show_charge_records" USING btree ("square_payment_id");--> statement-breakpoint
CREATE INDEX "booking_no_show_charge_records_status_idx" ON "booking_no_show_charge_records" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_policy_acceptances_hold_id_idx" ON "booking_policy_acceptances" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "booking_policy_acceptances_accepted_at_idx" ON "booking_policy_acceptances" USING btree ("accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_saved_payment_methods_square_card_id_idx" ON "booking_saved_payment_methods" USING btree ("square_card_id");--> statement-breakpoint
CREATE INDEX "booking_saved_payment_methods_customer_id_idx" ON "booking_saved_payment_methods" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_square_customers_square_customer_id_idx" ON "booking_square_customers" USING btree ("square_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_square_customers_email_normalized_idx" ON "booking_square_customers" USING btree ("email_normalized");--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_saved_payment_method_id_booking_saved_payment_methods_id_fk" FOREIGN KEY ("saved_payment_method_id") REFERENCES "public"."booking_saved_payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD CONSTRAINT "checkout_payment_events_no_show_charge_record_id_booking_no_show_charge_records_id_fk" FOREIGN KEY ("no_show_charge_record_id") REFERENCES "public"."booking_no_show_charge_records"("id") ON DELETE set null ON UPDATE no action;