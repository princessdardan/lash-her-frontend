CREATE TYPE "public"."course_order_item_financial_status" AS ENUM('pending', 'paid', 'partially_refunded', 'refunded', 'disputed', 'chargeback', 'payment_reversed');--> statement-breakpoint
CREATE TYPE "public"."course_order_item_ownership_status" AS ENUM('guest_unclaimed', 'claimed');--> statement-breakpoint
CREATE TYPE "public"."course_refund_allocation_status" AS ENUM('pending', 'completed', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."customer_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."entitlement_outbox_command_type" AS ENUM('grant', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."entitlement_outbox_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."checkout_order_purpose" ADD VALUE 'course' BEFORE 'appointment_deposit';--> statement-breakpoint
CREATE TABLE "course_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checkout_order_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"customer_user_id" uuid,
	"course_slug" text NOT NULL,
	"course_title" text NOT NULL,
	"ownership_status" "course_order_item_ownership_status" DEFAULT 'guest_unclaimed' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"financial_status" "course_order_item_financial_status" DEFAULT 'pending' NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_order_items_ownership_check" CHECK (("course_order_items"."ownership_status" = 'guest_unclaimed' AND "course_order_items"."customer_user_id" IS NULL) OR ("course_order_items"."ownership_status" = 'claimed' AND "course_order_items"."customer_user_id" IS NOT NULL)),
	CONSTRAINT "course_order_items_amount_check" CHECK ("course_order_items"."price_cents" >= 0 AND "course_order_items"."refunded_cents" >= 0 AND "course_order_items"."refunded_cents" <= "course_order_items"."price_cents"),
	CONSTRAINT "course_order_items_currency_check" CHECK ("course_order_items"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "course_refund_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_order_item_id" uuid NOT NULL,
	"payment_provider" "payment_provider" NOT NULL,
	"provider_refund_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"checkout_payment_event_id" uuid NOT NULL,
	"status" "course_refund_allocation_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_refund_allocations_provider_check" CHECK ("course_refund_allocations"."payment_provider" = 'helcim'),
	CONSTRAINT "course_refund_allocations_amount_check" CHECK ("course_refund_allocations"."amount_cents" > 0),
	CONSTRAINT "course_refund_allocations_currency_check" CHECK ("course_refund_allocations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "customer_provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text,
	"email_normalized" text,
	"email_verified_at" timestamp with time zone,
	"last_signed_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "customer_user_status" DEFAULT 'active' NOT NULL,
	"display_name" text,
	"last_signed_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_verified_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"verification_provider" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_order_item_id" uuid NOT NULL,
	"command_type" "entitlement_outbox_command_type" NOT NULL,
	"sequence" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "entitlement_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"last_error" text,
	"last_error_context" jsonb,
	"returned_grant_id" uuid,
	"completed_at" timestamp with time zone,
	"cancelled_by_admin_user_id" uuid,
	"cancellation_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_outbox_sequence_check" CHECK ("entitlement_outbox"."sequence" > 0),
	CONSTRAINT "entitlement_outbox_attempts_check" CHECK ("entitlement_outbox"."attempts" >= 0 AND "entitlement_outbox"."max_attempts" > 0 AND "entitlement_outbox"."attempts" <= "entitlement_outbox"."max_attempts"),
	CONSTRAINT "entitlement_outbox_lease_check" CHECK (("entitlement_outbox"."lease_owner" IS NULL AND "entitlement_outbox"."lease_expires_at" IS NULL) OR ("entitlement_outbox"."lease_owner" IS NOT NULL AND "entitlement_outbox"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "entitlement_outbox_completion_check" CHECK (("entitlement_outbox"."status" = 'completed' AND "entitlement_outbox"."completed_at" IS NOT NULL) OR ("entitlement_outbox"."status" <> 'completed' AND "entitlement_outbox"."completed_at" IS NULL)),
	CONSTRAINT "entitlement_outbox_cancellation_check" CHECK (("entitlement_outbox"."status" = 'cancelled' AND "entitlement_outbox"."cancelled_by_admin_user_id" IS NOT NULL AND "entitlement_outbox"."cancellation_reason" IS NOT NULL AND "entitlement_outbox"."cancelled_at" IS NOT NULL) OR ("entitlement_outbox"."status" <> 'cancelled' AND "entitlement_outbox"."cancelled_by_admin_user_id" IS NULL AND "entitlement_outbox"."cancellation_reason" IS NULL AND "entitlement_outbox"."cancelled_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "guest_order_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checkout_order_id" uuid NOT NULL,
	"customer_user_id" uuid NOT NULL,
	"verified_email_id" uuid NOT NULL,
	"claim_method" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "customer_user_id" uuid;--> statement-breakpoint
ALTER TABLE "course_order_items" ADD CONSTRAINT "course_order_items_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_order_items" ADD CONSTRAINT "course_order_items_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_refund_allocations" ADD CONSTRAINT "course_refund_allocations_course_order_item_id_course_order_items_id_fk" FOREIGN KEY ("course_order_item_id") REFERENCES "public"."course_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_refund_allocations" ADD CONSTRAINT "course_refund_allocations_checkout_payment_event_id_checkout_payment_events_id_fk" FOREIGN KEY ("checkout_payment_event_id") REFERENCES "public"."checkout_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_provider_accounts" ADD CONSTRAINT "customer_provider_accounts_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_verified_emails" ADD CONSTRAINT "customer_verified_emails_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_outbox" ADD CONSTRAINT "entitlement_outbox_course_order_item_id_course_order_items_id_fk" FOREIGN KEY ("course_order_item_id") REFERENCES "public"."course_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_outbox" ADD CONSTRAINT "entitlement_outbox_cancelled_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("cancelled_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_order_claims" ADD CONSTRAINT "guest_order_claims_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_order_claims" ADD CONSTRAINT "guest_order_claims_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_verified_emails_id_customer_idx" ON "customer_verified_emails" USING btree ("id","customer_user_id");--> statement-breakpoint
ALTER TABLE "guest_order_claims" ADD CONSTRAINT "guest_order_claims_verified_email_customer_fk" FOREIGN KEY ("verified_email_id","customer_user_id") REFERENCES "public"."customer_verified_emails"("id","customer_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_order_items_checkout_course_idx" ON "course_order_items" USING btree ("checkout_order_id","course_id");--> statement-breakpoint
CREATE INDEX "course_order_items_customer_financial_idx" ON "course_order_items" USING btree ("customer_user_id","financial_status");--> statement-breakpoint
CREATE INDEX "course_order_items_course_financial_idx" ON "course_order_items" USING btree ("course_id","financial_status");--> statement-breakpoint
CREATE UNIQUE INDEX "course_refund_allocations_provider_refund_item_idx" ON "course_refund_allocations" USING btree ("payment_provider","provider_refund_id","course_order_item_id");--> statement-breakpoint
CREATE INDEX "course_refund_allocations_item_occurred_idx" ON "course_refund_allocations" USING btree ("course_order_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "course_refund_allocations_provider_event_idx" ON "course_refund_allocations" USING btree ("payment_provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "course_refund_allocations_status_created_idx" ON "course_refund_allocations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_accounts_provider_account_idx" ON "customer_provider_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "customer_provider_accounts_customer_idx" ON "customer_provider_accounts" USING btree ("customer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_verified_emails_email_normalized_idx" ON "customer_verified_emails" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "customer_verified_emails_customer_idx" ON "customer_verified_emails" USING btree ("customer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_outbox_idempotency_key_idx" ON "entitlement_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_outbox_item_sequence_idx" ON "entitlement_outbox" USING btree ("course_order_item_id","sequence");--> statement-breakpoint
CREATE INDEX "entitlement_outbox_due_idx" ON "entitlement_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "entitlement_outbox_lease_idx" ON "entitlement_outbox" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "entitlement_outbox_history_idx" ON "entitlement_outbox" USING btree ("course_order_item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_order_claims_checkout_order_idx" ON "guest_order_claims" USING btree ("checkout_order_id");--> statement-breakpoint
CREATE INDEX "guest_order_claims_customer_claimed_idx" ON "guest_order_claims" USING btree ("customer_user_id","claimed_at");--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_customer_user_id_customer_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."customer_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_orders_customer_created_idx" ON "checkout_orders" USING btree ("customer_user_id","created_at");
