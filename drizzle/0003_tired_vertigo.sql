CREATE TYPE "public"."appointment_hold_status" AS ENUM('held', 'payment_pending', 'paid_pending_booking', 'booked', 'expired', 'payment_failed', 'booking_failed', 'manual_followup', 'released');--> statement-breakpoint
CREATE TYPE "public"."checkout_order_purpose" AS ENUM('product', 'training', 'appointment_deposit', 'appointment_full');--> statement-breakpoint
CREATE TABLE "appointment_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_reference" text NOT NULL,
	"checkout_order_id" uuid,
	"checkout_order_public_id" text,
	"offering_id" text NOT NULL,
	"offering_snapshot" jsonb NOT NULL,
	"booking_type" text NOT NULL,
	"customer_snapshot" jsonb NOT NULL,
	"selected_start" timestamp with time zone NOT NULL,
	"selected_end" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"status" "appointment_hold_status" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"helcim_invoice_id" integer,
	"helcim_invoice_number" text,
	"helcim_transaction_id" text,
	"google_event_id" text,
	"failure_reason" text,
	"failure_metadata" jsonb,
	"reconciliation_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"payment_failed_at" timestamp with time zone,
	"booking_failed_at" timestamp with time zone,
	"manual_followup_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "purpose" "checkout_order_purpose" DEFAULT 'product' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_public_reference_idx" ON "appointment_holds" USING btree ("public_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_checkout_order_id_idx" ON "appointment_holds" USING btree ("checkout_order_id");--> statement-breakpoint
CREATE INDEX "appointment_holds_slot_conflict_idx" ON "appointment_holds" USING btree ("offering_id","selected_start","selected_end","status","expires_at");