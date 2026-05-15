CREATE TYPE "public"."training_enrollment_purchase_kind" AS ENUM('full');--> statement-breakpoint
CREATE TYPE "public"."training_enrollment_scheduling_status" AS ENUM('pending', 'scheduled', 'expired', 'manual_followup');--> statement-breakpoint
CREATE TABLE "training_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checkout_order_id" uuid NOT NULL,
	"program_snapshot" jsonb NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"checkout_email" text NOT NULL,
	"purchase_kind" "training_enrollment_purchase_kind" DEFAULT 'full' NOT NULL,
	"scheduling_status" "training_enrollment_scheduling_status" DEFAULT 'pending' NOT NULL,
	"scheduling_token_hash" text,
	"token_expires_at" timestamp with time zone,
	"token_used_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"staff_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_enrollments_checkout_order_id_unique" UNIQUE("checkout_order_id"),
	CONSTRAINT "training_enrollments_scheduling_token_hash_unique" UNIQUE("scheduling_token_hash")
);
--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "training_enrollments_checkout_order_id_idx" ON "training_enrollments" USING btree ("checkout_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_enrollments_scheduling_token_hash_idx" ON "training_enrollments" USING btree ("scheduling_token_hash");
